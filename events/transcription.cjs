// =========================================
// VC TOOLS — TRANSCRIPTION + SAFE CLEANUP
// =========================================

const INLINE_CONFIG = {
  STALE_MS: 5 * 60 * 1000,        // 5 minutes
  SWEEP_INTERVAL_MS: 2 * 60 * 1000, // 2 minutes
  TEMP_DIRS: [
    // Whitelisted temp folders (SAFE: will not delete outside these)
    require("path").resolve(__dirname, "../../temp_audio"),
  ],
  SWEEP_EXTS: [".wav", ".pcm", ".tmp", ".json", ".log", ".ogg"], // files eligible for sweeping
};
// ─────────────────────────────────────────────────────────────────────────

// =========================================
// DEPENDENCIES & CONFIGURATION
// =========================================
const { config } = require("dotenv");
config();

const leoProfanity = require("leo-profanity");
leoProfanity.loadDictionary(); // Load the default English dictionary

const path = require("path");
const fs = require("fs");
const {
  ChannelType,
  PermissionsBitField,
  EmbedBuilder,
} = require("discord.js");
const prism = require("prism-media");
const ffmpeg = require("fluent-ffmpeg");
ffmpeg.setFfmpegPath(path.resolve(__dirname, "../ffmpeg/ffmpeg.exe"));
const { exec } = require("child_process");
const { Readable, Transform } = require("stream");
const {
  VoiceConnectionStatus,
  getVoiceConnection,
} = require("@discordjs/voice");

// These functions come from your settings module.
const {
  getSettingsForGuild,
  updateSettingsForGuild,
} = require("../commands/settings.cjs");

const finalizingUsers = new Set();
const FINALIZE_COOLDOWN_MS = 1500;
const lastFinalizeAt = new Map();

// =========================================
// TEMP FILE SAFETY CONFIG (env → inline defaults)
// =========================================
const DEFAULT_STALE_MS = Number(process.env.VC_TOOLS_STALE_MS ?? INLINE_CONFIG.STALE_MS);
const SWEEP_INTERVAL_MS = Number(process.env.VC_TOOLS_SWEEP_INTERVAL_MS ?? INLINE_CONFIG.SWEEP_INTERVAL_MS);
const TEMP_DIRS = (INLINE_CONFIG.TEMP_DIRS || []).map((d) => path.resolve(d));
const SWEEP_EXTS = new Set(INLINE_CONFIG.SWEEP_EXTS || []);

const inUsePaths = new Set(); // files currently in use; do not delete

// =========================================
// PROFANITY FILTER FUNCTIONS (USING LEO-PROFANITY)
// =========================================

/**
 * Updates the profanity filter for the given guild.
 * This function reloads the default dictionary, adds custom words, and—if in strict mode—removes common curse words.
 * @param {string} guildId - The guild's ID.
 */
async function updateProfanityFilter(guildId) {
  const settings = await getSettingsForGuild(guildId);
  const customWords = settings?.filterCustom || [];
  const filterLevel = settings?.filterLevel || "moderate"; // strict, moderate, build

  if (filterLevel === "build") {
    console.log(`[PROFANITY] Guild ${guildId} is using the 'build' filter. Skipping leo-profanity entirely.`);
  } else {
    // Full leo-profanity reset
    leoProfanity.loadDictionary();

    // Add user-defined custom banned words
    customWords.forEach((word) => {
      leoProfanity.add(word);
    });

    if (filterLevel === "moderate") {
      console.log(`[PROFANITY] Guild ${guildId} is using the moderate filter. Removing allowed common words...`);
      try {
        const jsonPath = path.resolve(__dirname, "../moderation/profanityFilterModerate.json");
        console.log("[FILTER] Loading filter from:", jsonPath);
        const jsonData = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
        const allowedCommon = jsonData.moderate || [];
        allowedCommon.forEach((word) => {
          leoProfanity.remove(word);
        });
      } catch (err) {
        console.error("Error loading moderate filter exceptions:", err);
      }
    }

    // If strict: just keep the full leo dictionary (plus custom words), no removals
  }
}

/**
 * Cleans (censors) the given text based on guild-specific settings.
 * @param {Object} guild - The guild object.
 * @param {string} text - The text to clean.
 * @returns {Promise<string>} - The cleaned text.
 */
async function clean(guild, text) {
  await updateProfanityFilter(guild.id);
  // leoProfanity.clean returns the text with profane words replaced.
  return leoProfanity.clean(text);
}

/**
 * Checks if the text contains profanity.
 * @param {Object} guild - The guild object.
 * @param {string} text - The text to check.
 * @returns {Promise<boolean>} - True if profanity is detected.
 */
async function containsProfanity(guild, text) {
  const censored = await clean(guild, text);
  return censored !== text;
}

/**
 * Checks a transcription for profanity and sends a warning to the logging channel if found.
 * @param {string} userId - The user ID who spoke.
 * @param {string} transcription - The transcription text.
 * @param {Object} guild - The Discord guild object.
 */
async function checkForFlaggedContent(userId, transcription, guild) {
  if (!transcription || !guild) return;
  const settings = await getSettingsForGuild(guild.id);
  const loggingchannelId = settings.channelId;
  const voiceCallPingRoleId = settings.voiceCallPingRoleId;
  const notifyBadWord = settings.notifyBadWord;

  if (!loggingchannelId) {
    console.warn(`[WARNING] No logging channel set for guild ${guild.id}.`);
    return;
  }

  const loggingChannel = guild.channels.cache.get(loggingchannelId);
  if (!loggingChannel) {
    console.warn(
      `[WARNING] Could not find logging channel in guild ${guild.id}.`
    );
    return;
  }

  const censored = await clean(guild, transcription);
  if (censored === transcription) return;

  let warningMessage = `## ⚠️ **Inappropriate Content Detected**\n> VC Tools detected flagged content from <@${userId}>\n**Transcription:** ${transcription}\n-# Did the filter catch an incorrect word? If so, then use \`settings filter\` to manage it.`;
  if (notifyBadWord && voiceCallPingRoleId) {
    warningMessage = `## ⚠️ <@&${voiceCallPingRoleId}> **Inappropriate Content Detected**\n> VC Tools detected flagged content from <@${userId}>\n**Transcription:** ${transcription}\n-# Did the filter catch an incorrect word? If so, then use \`settings filter\` to manage it.`;
  }
  await loggingChannel.send({ content: warningMessage });
  console.log(`[MODERATION] Logged flagged content from user ${userId}.`);
}

// =========================================
// TRANSCRIPTION & AUDIO PROCESSING
// =========================================

const silenceDurations = new Map();
const MAX_SILENCE_RECORDS = 10;
const DEFAULT_SILENCE_TIMEOUT = 1000;
const GRACE_PERIOD_MS = 3000;
const finalizationTimers = {};

let isProcessing = false;
const processingQueue = [];
const outputStreams = {};
const userSubscriptions = {};

/**
 * Creates a loudness detector stream.
 * @param {Object} guild - The guild object.
 * @param {string} userId - The user ID.
 * @param {function} onWarning - Callback to be called when a warning is triggered.
 * @param {Object} options - Optional thresholds and durations.
 * @returns {Transform} - A transform stream.
 */
function createLoudnessDetector(guild, userId, onWarning, options = {}) {
  const {
    cooldownMs = 15000,
    instantThreshold = 10000,
    fastThreshold = 6000,
    fastDuration = 250,
    prolongedThreshold = 4000,
    prolongedDuration = 5000,
  } = options;
  let fastStart = null;
  let prolongedStart = null;
  let lastWarningTime = 0;

  return new Transform({
    transform(chunk, encoding, callback) {
      try {
        if (chunk.length % 2 !== 0) {
          chunk = chunk.slice(0, chunk.length - 1);
        }
        let sum = 0;
        const sampleCount = Math.floor(chunk.length / 2);
        for (let i = 0; i < sampleCount * 2; i += 2) {
          const sample = chunk.readInt16LE(i);
          sum += sample * sample;
        }
        const rms = Math.round(Math.sqrt(sum / sampleCount));
        const now = Date.now();

        if (now - lastWarningTime < cooldownMs) {
          return callback(null, chunk);
        }
        if (rms > instantThreshold) {
          console.info(
            `[WARNING] Instant warning for ${userId} (RMS: ${rms}).`
          );
          onWarning(userId, rms);
          lastWarningTime = now;
        }
        if (rms > fastThreshold) {
          if (!fastStart) fastStart = now;
          if (now - fastStart > fastDuration) {
            console.info(`[WARNING] Fast warning for ${userId} (RMS: ${rms}).`);
            onWarning(userId, rms);
            lastWarningTime = now;
            fastStart = null;
          }
        } else {
          fastStart = null;
        }
        if (rms > prolongedThreshold) {
          if (!prolongedStart) prolongedStart = now;
          if (now - prolongedStart > prolongedDuration) {
            console.info(
              `[WARNING] Prolonged warning for ${userId} (RMS: ${rms}).`
            );
            onWarning(userId, rms);
            lastWarningTime = now;
            prolongedStart = null;
          }
        } else {
          prolongedStart = null;
        }
        callback(null, chunk);
      } catch (error) {
        console.error(
          `[ERROR] Loudness detector error for user ${userId}: ${error.message}`
        );
        callback(error, chunk);
      }
    },
  });
}

/**
 * Ensures a transcription channel exists in the guild; creates one if needed.
 * @param {Object} guild - The guild object.
 * @returns {Promise<Object|null>} - The text channel or null if creation fails.
 */
async function ensureTranscriptionChannel(guild) {
  const guildSettings = await getSettingsForGuild(guild.id);
  if (!guildSettings.transcriptionEnabled) {
    console.warn(
      `[WARNING] Transcription is disabled for guild '${guild.name}'.`
    );
    return null;
  }
  let channelId = guildSettings.channelId;
  if (channelId) {
    const existingChannel = guild.channels.cache.get(channelId);
    if (existingChannel && existingChannel.type === ChannelType.GuildText) {
      console.log(
        `[INFO] Using existing transcription channel: ${existingChannel.name}`
      );
      return existingChannel;
    }
  }
  try {
    const everyoneRole = guild.roles.cache.get(guild.id);
    let moderatorRole =
      guild.roles.cache.get(guildSettings.allowedRoleId) ||
      guild.roles.cache.find((role) => role.name.toLowerCase() === "moderator");
    if (!moderatorRole) {
      console.warn(
        `[WARNING] Moderator role not found in '${guild.name}', defaulting to @everyone.`
      );
      moderatorRole = everyoneRole;
    }
    const newChannel = await guild.channels.create({
      name: "transcription",
      type: ChannelType.GuildText,
      reason: "The channel for transcriptions was not found.",
      permissionOverwrites: [
        {
          id: everyoneRole.id,
          deny: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ManageMessages,
            PermissionsBitField.Flags.ManageChannels,
          ],
        },
        {
          id: moderatorRole.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
          ],
        },
      ],
    });
    console.log(`[INFO] Created new transcription channel: ${newChannel.name}`);
    await updateSettingsForGuild(guild.id, { channelId: newChannel.id }, guild);
    return newChannel;
  } catch (error) {
    console.error(
      `[ERROR] Failed to create transcription channel: ${error.message}`
    );
    return null;
  }
}

/**
 * Queues audio for processing.
 * @param {string} userId - The user ID.
 * @param {Object} guild - The guild object.
 * @returns {Promise<string>} - The transcription text.
 */
async function processAudio(userId, guild) {
  return new Promise((resolve, reject) => {
    const audioDir = path.resolve(__dirname, "../../temp_audio");
    ensureDirectoryExistence(path.join(audioDir, "._ensure")); // ensure directory exists
    const unique = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const wavFilePath = path.join(audioDir, `${userId}-${unique}.wav`);
    console.log(
      `[DEBUG] Pushing to queue: userId=${userId}, wavFilePath=${wavFilePath}`
    );
    // Mark as in-use to protect from sweeper until we're done
    inUsePaths.add(path.resolve(wavFilePath));
    processingQueue.push({ userId, guild, wavFilePath, unique, resolve, reject });

    processQueue();
  });
}

/**
 * Processes the audio queue.
 */
async function processQueue() {
  if (global.__vcToolsTranscribeProcessing) return;
  global.__vcToolsTranscribeProcessing = true;

  try {
    while (processingQueue.length > 0) {
      const job = processingQueue.shift();
      if (!job) continue;

      const { userId, guild, wavFilePath, channelId, resolve, reject } = job;

      try {
        const { text: transcriptionText, confidence } = await transcribeAudio(wavFilePath);
        console.log(`[QUEUE] Transcription for user ${userId}: ${transcriptionText}`);

        // Preserve prior resolve behavior for upstream callers
        if (typeof resolve === "function") {
          resolve(transcriptionText);
        }

        // Post to your log/output with the confidence badge
        await postTranscription(guild, userId, transcriptionText, channelId, confidence);
      } catch (err) {
        console.error(`[QUEUE] Transcription failed for user ${userId}: ${err.message}`);
        if (typeof reject === "function") {
          reject(err);
        }
      } finally {
        // Any cleanup for wavFilePath stays as-is elsewhere in your code
      }
    }
  } finally {
    global.__vcToolsTranscribeProcessing = false;
  }
}

/**
 * Runs the Whisper transcription script on a WAV file.
 * @param {string} wavFilePath - The path to the WAV file.
 * @returns {Promise<string>} - The transcription text.
 */
// Spawns transcribe.py, parses JSON lines, returns { text, confidence }
async function transcribeAudio(wavFilePath) {
  const { spawn } = require("child_process");
  const path = require("path");

  return new Promise((resolve, reject) => {
    try {
      const pyPath = path.resolve("../models/whisper/transcribe.py");
      const proc = spawn("py", ["-3", pyPath, wavFilePath], { cwd: __dirname, windowsHide: true });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (d) => (stdout += d.toString("utf8")));
      proc.stderr.on("data", (d) => (stderr += d.toString("utf8")));

      proc.on("error", (err) => reject(err));

      proc.on("close", (code) => {
        if (code !== 0 && !stdout) {
          return reject(
            new Error(`transcribe.py exited with code ${code}: ${stderr || "no stderr"}`)
          );
        }

        try {
          // Collect all JSON objects printed by Python
          const jsonMatches = stdout.match(/\{[\s\S]*?\}/g) || [];
          let transcriptionText = "";
          let confidence = undefined;

          for (const j of jsonMatches) {
            try {
              const parsed = JSON.parse(j);
              if (parsed && typeof parsed.text === "string" && parsed.text.length) {
                transcriptionText = parsed.text;
                if (typeof parsed.confidence === "number") {
                  confidence = parsed.confidence;
                } else if (typeof parsed.confidence_percent === "number") {
                  confidence = Math.max(0, Math.min(1, parsed.confidence_percent / 100));
                }
                break;
              }
            } catch (_) {
              // ignore malformed json lines
            }
          }

          if (!transcriptionText) {
            // If Python only returned an error JSON, surface it
            for (const j of jsonMatches) {
              try {
                const errObj = JSON.parse(j);
                if (errObj && errObj.error) {
                  return reject(new Error(errObj.error));
                }
              } catch (_) { }
            }
            return reject(new Error("No transcription text found in Python output."));
          }

          resolve({ text: transcriptionText, confidence });
        } catch (parseErr) {
          reject(parseErr);
        }
      });
    } catch (outerErr) {
      reject(outerErr);
    }
  });
}

/**
 * Posts the transcription to the transcription channel and checks for profanity.
 * @param {Object} guild - The guild object.
 * @param {string} userId - The user ID.
 * @param {string|Object} transcription - The transcription text OR an object { text, confidence }.
 * @param {string} channelId - Voice/text channel id (for label).
 * @param {number} [confidence] - Optional confidence in [0..1].
 */
async function postTranscription(guild, userId, transcription, channelId, confidence) {
  try {
    // --- HOTFIX: unwrap accidental { text, confidence } objects ---
    if (transcription && typeof transcription === "object") {
      const t = transcription;
      if (typeof t.text === "string") {
        transcription = t.text;
        if (confidence == null && typeof t.confidence === "number") {
          confidence = t.confidence;
        }
      } else {
        transcription = String(t); // hard fallback, avoids [object Object]
      }
    }

    const channel = await ensureTranscriptionChannel(guild);
    if (!channel) {
      console.error(
        `[ERROR] Could not find or create a transcription channel in guild '${guild.name}'.`
      );
      return;
    }
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) {
      console.warn(
        `[WARN] Could not fetch member for user ${userId}. Defaulting to plain text.`
      );
    }
    if (!guild.roles) {
      guild = await guild.fetch();
    }

    const highestRole = member?.roles?.highest || null;
    const roleName = highestRole?.name || "Member";
    const formattedRole = roleName === "@everyone" ? "Member" : roleName;

    // ===== colors (your style) =====
    let roleColor = "\u001b[2;37m"; // light gray
    let nameColor = "\u001b[2;37m";

    if (guild.ownerId === userId) {
      roleColor = "\u001b[31m"; // red
      nameColor = "\u001b[31m";
    } else if (member?.permissions?.has?.("Administrator")) {
      roleColor = "\u001b[34m"; // blue
      nameColor = "\u001b[34m";
    } else if (
      member?.permissions?.has?.("ManageGuild") ||
      member?.permissions?.has?.("KickMembers") ||
      member?.permissions?.has?.("MuteMembers") ||
      member?.permissions?.has?.("BanMembers") ||
      member?.permissions?.has?.("ManageMessages")
    ) {
      roleColor = "\u001b[33m"; // yellow/gold
      nameColor = "\u001b[33m";
    }

    const bracket = "\u001b[2;30m"; // dark gray
    const reset = "\u001b[0m";
    const idColor = "\u001b[37m"; // white
    const timeColor = "\u001b[37m"; // white
    const channelColor = "\u001b[37m"; // white
    const messageColor = "\u001b[2;37m"; // light gray

    // confidence colors (dim)
    const CONF_GREEN = "\u001b[2;32m";
    const CONF_YELLOW = "\u001b[2;33m";
    const CONF_RED = "\u001b[2;31m";

    const SPACE = "\u200B";

    const now = new Date();
    const timestamp = `${bracket}[${timeColor}${now.toLocaleTimeString("en-US", {
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })}${bracket}]${reset}`;

    let voiceChannelName = "Unknown Channel";
    if (channelId && guild.channels.cache.has(channelId)) {
      voiceChannelName = guild.channels.cache.get(channelId)?.name || "Unknown Channel";
    }

    // confidence badge
    let confidenceBadge = "";
    if (typeof confidence === "number" && !Number.isNaN(confidence)) {
      const pct = Math.max(0, Math.min(100, Math.round(confidence * 100)));
      let confColor = CONF_YELLOW;
      if (confidence >= 0.75) confColor = CONF_GREEN;
      else if (confidence < 0.55) confColor = CONF_RED;
      confidenceBadge = ` ${bracket}[${confColor}${pct}%${bracket}]${reset}`;
    }

    const displayName = member?.displayName || `User ${userId}`;

    const formattedMessage = `
${timestamp}${confidenceBadge} ${bracket}${SPACE}[${SPACE}${roleColor}${SPACE}${formattedRole}${SPACE}${bracket}${SPACE}]${SPACE} [${SPACE}${idColor}${SPACE}${userId}${SPACE}${bracket}${SPACE}]${SPACE} [🔊${SPACE}${channelColor}${SPACE}${voiceChannelName}${SPACE}${bracket}${ZSPACEWSP}]${SPACE} ${nameColor}${SPACE}${displayName}${SPACE}${bracket}${SPACE}:${SPACE}${messageColor}${SPACE} ${transcription}${reset}`;
    try {
      const maxLength = 1900;
      const content = formattedMessage.trim();
      let start = 0;

      while (start < content.length) {
        const chunk = content.slice(start, start + maxLength);
        await channel.send("```ansi\n" + chunk + "\n```").catch(console.error);
        start += maxLength;
      }

      console.log(`[✅] Sent transcription to ${channel.name}`);
    } catch (err) {
      console.error(`[❌] Failed to send transcription: ${err.message}`);
    }

    // Profanity checks
    await updateProfanityFilter(guild.id);
    const censoredText = await clean(guild, transcription);
    if (transcription !== censoredText) {
      await checkForFlaggedContent(userId, transcription, guild);
    }
  } catch (error) {
    console.error(`[ERROR] Failed to post transcription: ${error.message}`);
  }
}

/**
 * Converts a raw **16-bit PCM** file (decoded from Opus) to a WAV file.
 * @param {string} pcmPath      Absolute path of the source `.pcm` file.
 * @param {string} wavFilePath  Destination path for the `.wav` file.
 * @returns {Promise<void>}
 */
async function convertOpusToWav(pcmPath, wavFilePath) {
  const ffmpegPath = path.resolve(__dirname, "../ffmpeg/ffmpeg.exe");
  ffmpeg.setFfmpegPath(ffmpegPath);

  // Ensure the target directory exists.
  ensureDirectoryExistence(wavFilePath);

  console.log(
    `[DEBUG] Converting PCM → WAV:\n  src: ${pcmPath}\n  dst: ${wavFilePath}`
  );

  // Mark both files as in-use
  inUsePaths.add(path.resolve(pcmPath));
  inUsePaths.add(path.resolve(wavFilePath));

  return new Promise((resolve, reject) => {
    ffmpeg(pcmPath)
      .inputFormat("s16le")      // raw 16-bit little-endian PCM
      .inputOptions(['-ar 48000', '-ac 1'])   // tell FFmpeg what it *really* receives
      .audioFrequency(16000)                 // then resample
      .audioChannels(1)
      .audioCodec("pcm_s16le")
      .toFormat("wav")
      .save(wavFilePath)
      .on("end", () => {
        console.log(`[INFO] PCM → WAV conversion complete: ${wavFilePath}`);
        // Try to delete the PCM right away (with retries)
        setTimeout(() => {
          safeDeleteFile(pcmPath).catch(() => { });
          inUsePaths.delete(path.resolve(pcmPath));
          // Release WAV lock here; processQueue re-adds it when used via that flow
          inUsePaths.delete(path.resolve(wavFilePath));
        }, 5000);
        resolve();
      })
      .on("error", (error) => {
        console.error(`[ERROR] FFmpeg failed: ${error.message}`);
        // Even on error, try to delete PCM (best-effort)
        setTimeout(() => {
          safeDeleteFile(pcmPath).catch(() => { });
          inUsePaths.delete(path.resolve(pcmPath));
          inUsePaths.delete(path.resolve(wavFilePath));
        }, 5000);
        reject(error);
      });
  });
}

/**
 * Safely deletes a file if it exists.
 * - Only deletes inside whitelisted TEMP_DIRS
 * - Skips files marked in-use
 * - Retries on Windows locks (EPERM/EACCES/EBUSY) with exponential backoff
 * - Optionally requires the file to be older than N ms (based on timestamp
 *   embedded in filename if present, else mtime)
 * @param {string} filePath
 * @param {object} [opts]
 * @param {number} [opts.retries=7]
 * @param {number} [opts.delayMs=200]
 * @param {number} [opts.olderThanMs=0]
 */
async function safeDeleteFile(filePath, opts = {}) {
  const { retries = 7, delayMs = 200, olderThanMs = 0 } = opts;
  if (!filePath) return false;

  const full = path.resolve(filePath);

  if (!isInTempDirs(full)) {
    console.warn(`[SAFE-DEL] Refused to delete outside temp dirs: ${full}`);
    return false;
  }
  if (inUsePaths.has(full)) {
    // Skip deletion while in use
    return false;
  }

  if (olderThanMs > 0) {
    try {
      const stat = await fs.promises.stat(full);
      const base = path.basename(full);
      const tsFromName = parseTimestampFromName(base);
      const referenceTime = tsFromName ?? stat.mtimeMs;
      if (Date.now() - referenceTime < olderThanMs) {
        return false;
      }
    } catch (e) {
      if (e.code === "ENOENT") return true; // already gone
    }
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await fs.promises.unlink(full);
      tryRemoveEmptyParents(full).catch(() => { });
      return true;
    } catch (err) {
      if (err.code === "ENOENT") return true;
      const retriable = ["EBUSY", "EPERM", "EACCES"].includes(err.code);
      if (retriable && attempt < retries) {
        await wait(delayMs * Math.pow(2, attempt));
        continue;
      } else {
        console.error(`[SAFE-DEL] Failed to delete ${full} (${err.code}): ${err.message}`);
        if (attempt >= retries) return false;
      }
    }
  }
  return false;
}

/**
 * Deletes an array of files.
 * @param {Array<string>} filePaths - The file paths to delete.
 */
async function cleanupFiles(filePaths = []) {
  for (const filePath of filePaths) {
    try {
      await safeDeleteFile(filePath);
    } catch (err) {
      console.error(`[ERROR] Failed to delete ${filePath}: ${err.message}`);
    }
  }
}

/**
 * Ensures the directory for a file exists.
 * @param {string} filePath - The file path.
 */
function ensureDirectoryExistence(filePath) {
  const dirname = path.dirname(filePath);
  if (!fs.existsSync(dirname)) {
    fs.mkdirSync(dirname, { recursive: true });
  }
}

// ── Helper: sweeping & path safety ─────────────────────────────────────────

function isPathInside(child, parent) {
  const rel = path.relative(parent, child);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

function isInTempDirs(fullPath) {
  const resolved = path.resolve(fullPath);
  return TEMP_DIRS.some((dir) => isPathInside(resolved, dir) || resolved === dir);
}

function parseTimestampFromName(basename) {
  // Looks for a 13+ digit number (Date.now()) in the name
  const m = basename.match(/(\d{13,})/);
  if (m) {
    const n = Number(m[1]);
    if (!Number.isNaN(n)) return n;
  }
  return null;
}

async function tryRemoveEmptyParents(fullPath) {
  let dir = path.dirname(fullPath);
  for (const root of TEMP_DIRS) {
    while (isPathInside(dir, root) || dir === root) {
      try {
        const entries = await fs.promises.readdir(dir);
        if (entries.length === 0) {
          await fs.promises.rmdir(dir).catch(() => { });
          dir = path.dirname(dir);
        } else {
          break;
        }
      } catch {
        break;
      }
    }
  }
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Sweep function: delete OLD files in TEMP_DIRS (age ≥ DEFAULT_STALE_MS).
 * Uses file name timestamp if present; otherwise mtime.
 */
async function sweepTempDirs(olderThanMs = DEFAULT_STALE_MS) {
  for (const dir of TEMP_DIRS) {
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      const entries = await fs.promises.readdir(dir);
      for (const name of entries) {
        const full = path.join(dir, name);
        try {
          const stat = await fs.promises.stat(full);
          if (!stat.isFile()) continue;
          const ext = path.extname(full).toLowerCase();
          if (!SWEEP_EXTS.has(ext)) continue;
          if (inUsePaths.has(full)) continue;

          const tsFromName = parseTimestampFromName(name);
          const referenceTime = tsFromName ?? stat.mtimeMs;
          const age = Date.now() - referenceTime;
          if (age >= olderThanMs) {
            await safeDeleteFile(full, { retries: 7, delayMs: 200, olderThanMs: 0 });
          }
        } catch {
          // ignore per-file errors
        }
      }
    } catch (err) {
      console.error(`[SWEEP] Failed to sweep ${dir}: ${err.message}`);
    }
  }
}

/** Public trigger to run a sweep immediately */
async function forceCleanNow(ms = DEFAULT_STALE_MS) {
  await sweepTempDirs(ms);
}

// Start sweeper automatically and run once now
sweepTempDirs().catch(() => { });
const _sweepTimer = setInterval(() => {
  sweepTempDirs().catch(() => { });
}, SWEEP_INTERVAL_MS);
_sweepTimer.unref?.();

// Also try on shutdown
const _finalCleanup = async () => {
  try {
    await sweepTempDirs(0); // delete anything not marked in-use
  } catch { }
};
process.on("beforeExit", _finalCleanup);
process.on("SIGINT", async () => { await _finalCleanup(); process.exit(0); });
process.on("SIGTERM", async () => { await _finalCleanup(); process.exit(0); });

// ─────────────────────────────────────────────────────────────────────────
// HARD DELETE (bypass inUse guard; close & nuke stubborn Windows locks)
// ─────────────────────────────────────────────────────────────────────────
const { spawn } = require("child_process");

function _toLongPath(p) {
  const win = path.resolve(p).replace(/\//g, "\\");
  return win.startsWith("\\\\?\\") ? win : "\\\\?\\" + win;
}
function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function _run(cmd, args) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { windowsHide: true, stdio: "ignore" });
    c.on("exit", (code) => resolve(code === 0));
    c.on("error", () => resolve(false));
  });
}

/**
 * Forcefully unmark and delete a file even if our process *thinks* it is in use.
 * Steps:
 *  1) Best-effort: drop from inUsePaths (if present).
 *  2) try fs.unlink; if locked, rename -> tombstone in same dir.
 *  3) hammer with: attrib -r -s -h, del /f /q, PowerShell Remove-Item -Force.
 *  4) retries with backoff; returns boolean.
 */
async function hardDeleteFile(filePath, {
  retries = 12,
  baseDelayMs = 120,
} = {}) {
  if (!filePath) return false;
  const full = path.resolve(filePath);

  // 1) Unmark "in use" if stale
  try { inUsePaths.delete(full); } catch { }

  // 2) Try fast unlink
  try {
    await fs.promises.unlink(full);
    await tryRemoveEmptyParents(full).catch(() => { });
    return true;
  } catch (e) {
    if (e.code === "ENOENT") return true;
  }

  // 3) Try rename to tombstone (often succeeds even if current name is "busy")
  let tomb = full;
  try {
    const base = path.basename(full);
    tomb = path.join(path.dirname(full), `.__tomb.${process.pid}.${Date.now()}.${base}`);
    await fs.promises.rename(full, tomb);
  } catch {
    tomb = full;
  }

  // 4) Repeated hammer with shell fallbacks
  for (let i = 0; i <= retries; i++) {
    // normalize attributes
    await _run("cmd.exe", ["/d", "/s", "/c", `attrib -r -s -h "${tomb}"`]);

    // local unlink
    try {
      await fs.promises.unlink(tomb);
      await tryRemoveEmptyParents(tomb).catch(() => { });
      return true;
    } catch (e) {
      if (e.code === "ENOENT") return true;
    }

    // CMD del
    const delOk = await _run("cmd.exe", ["/d", "/s", "/c", `del /f /q "${_toLongPath(tomb)}"`]);
    if (delOk) {
      try { await fs.promises.access(tomb); } catch { return true; }
    }

    // PowerShell remove
    const psOk = await _run("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Remove-Item -LiteralPath '${_toLongPath(tomb).replace(/'/g, "''")}' -Force -ErrorAction SilentlyContinue`,
    ]);
    if (psOk) {
      try { await fs.promises.access(tomb); } catch { return true; }
    }

    await _sleep(Math.min(baseDelayMs * Math.pow(1.6, i), 1500));
  }

  // still here → give up
  return false;
}

/**
 * Convenience: final-phase hard delete for multiple paths.
 */
async function hardFinalizeDelete(paths = []) {
  let allOk = true;
  for (const p of paths) {
    try {
      const ok = await hardDeleteFile(p, { retries: 14, baseDelayMs: 140 });
      if (!ok) allOk = false;
    } catch {
      allOk = false;
    }
  }
  return allOk;
}

// =========================================
/** EXPORTS */
// =========================================
module.exports = {
  // Transcription & Audio Processing
  ensureTranscriptionChannel,
  processAudio,
  convertOpusToWav,
  transcribeAudio,
  postTranscription,
  // File utilities
  safeDeleteFile,
  cleanupFiles,
  ensureDirectoryExistence,
  createLoudnessDetector,
  forceCleanNow,
  hardDeleteFile,
  hardFinalizeDelete,
  // Profanity & Flagging Functions
  updateProfanityFilter,
  containsProfanity,
  clean,
  checkForFlaggedContent,
};