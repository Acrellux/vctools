// Fix for UDP discovery issue in Discord.js
process.env.DISCORDJS_DISABLE_UDP = "true";
console.log("[BOOT] UDP discovery disabled.");

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
        const jsonData = JSON.parse(fs.readFileSync("./moderation/profanityFilterModerate.json", "utf8"));
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
 * Updates the custom filter list in the settings.
 * @param {string} guildId - The guild ID.
 * @param {string} action - "add" or "remove".
 * @param {string} word - The word to add or remove.
 * @returns {Promise<string>} - A confirmation message.
 */
async function updateFilterList(guildId, action, word) {
  const settings = await getSettingsForGuild(guildId);
  let currentCustom = settings?.filterCustom || [];

  if (action === "add") {
    if (!currentCustom.includes(word)) {
      currentCustom.push(word);
      await updateSettingsForGuild(guildId, { filterCustom: currentCustom });
      leoProfanity.add(word);
      return `✅ Added **${word}** to the filter.`;
    }
    return `⚠️ The word **${word}** is already in the filter.`;
  } else if (action === "remove") {
    if (currentCustom.includes(word)) {
      currentCustom = currentCustom.filter((w) => w !== word);
      await updateSettingsForGuild(guildId, { filterCustom: currentCustom });
      leoProfanity.remove(word);
      return `✅ Removed **${word}** from the filter.`;
    }
    return `⚠️ The word **${word}** was not found in the filter.`;
  }
  return "❌ Invalid action.";
}

/**
 * Sets the filter level for the guild.
 * @param {string} guildId - The guild ID.
 * @param {string} level - The filter level ("moderate" or "strict").
 * @returns {Promise<string>} - A confirmation message.
 */
async function setfilterLevel(guildId, level) {
  if (!["moderate", "strict"].includes(level)) {
    return "❌ Invalid filter level. Use `moderate` or `strict`.";
  }
  await updateSettingsForGuild(guildId, { filterLevel: level });
  return `✅ Filter level set to **${level}**.`;
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
    const unique = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const wavFilePath = path.join(audioDir, `${userId}-${unique}.wav`);
    console.log(
      `[DEBUG] Pushing to queue: userId=${userId}, wavFilePath=${wavFilePath}`
    );
    processingQueue.push({ userId, guild, wavFilePath, unique, resolve, reject });

    processQueue();
  });
}

/**
 * Processes the audio queue.
 */
async function processQueue() {
  if (isProcessing || processingQueue.length === 0) return;
  const { userId, guild, wavFilePath, resolve, reject } =
    processingQueue.shift();
  isProcessing = true;
  console.log(
    `[DEBUG] Processing queue: userId=${userId}, wavFilePath=${wavFilePath}`
  );
  try {
    if (!fs.existsSync(wavFilePath)) {
      console.error(
        `[ERROR] WAV file missing for user ${userId}: ${wavFilePath}`
      );
      throw new Error(`WAV file missing for user ${userId}: ${wavFilePath}`);
    }
    console.log(`[DEBUG] Calling transcribeAudio with: ${wavFilePath}`);
    const transcriptionText = await transcribeAudio(wavFilePath);
    console.log(
      `[QUEUE] Transcription for user ${userId}: ${transcriptionText}`
    );
    resolve(transcriptionText);
    setTimeout(() => safeDeleteFile(wavFilePath).catch(console.error), 500);
  } catch (err) {
    console.error(
      `[QUEUE] Error processing audio for user ${userId}: ${err.message}`
    );
    reject(err);
  } finally {
    isProcessing = false;
    processQueue();
  }
}

/**
 * Runs the Whisper transcription script on a WAV file.
 * @param {string} wavFilePath - The path to the WAV file.
 * @returns {Promise<string>} - The transcription text.
 */
async function transcribeAudio(wavFilePath) {
  if (!fs.existsSync(wavFilePath)) {
    console.error(
      `[ERROR] transcribeAudio: WAV file not found: ${wavFilePath}`
    );
    return Promise.reject(new Error("WAV file missing."));
  }
  const pythonScript = path.resolve(
    __dirname,
    "../models/whisper/transcribe.py"
  );
  console.log(`[DEBUG] Running Whisper on file: ${wavFilePath}`);
  console.log(
    `[DEBUG] Full Command: python "${pythonScript}" "${wavFilePath}"`
  );
  const command = `python "${pythonScript}" "${wavFilePath}"`;
  return new Promise((resolve, reject) => {
    exec(command, { shell: true }, (error, stdout, stderr) => {
      console.log(`[DEBUG] Whisper Raw Output:\n${stdout.trim()}`);
      if (error) {
        console.error(`[ERROR] Whisper transcription failed: ${error.message}`);
        console.error(`[DEBUG] stderr: ${stderr}`);
        return reject(error);
      }
      try {
        const jsonMatches = stdout.match(/\{.*?\}/gs);
        if (!jsonMatches || jsonMatches.length === 0) {
          throw new Error("No valid JSON found in Whisper output.");
        }
        let transcriptionText = "";
        for (const jsonStr of jsonMatches) {
          try {
            const parsedJson = JSON.parse(jsonStr);
            if (parsedJson.text) {
              transcriptionText = parsedJson.text;
              break;
            }
          } catch (e) {
            console.warn(`[WARNING] Ignored invalid JSON segment: ${jsonStr}`);
          }
        }
        if (!transcriptionText) {
          throw new Error("No transcription text found in JSON output.");
        }
        resolve(transcriptionText);
      } catch (parseError) {
        console.error(
          `[ERROR] Failed to parse Whisper output: ${parseError.message}`
        );
        reject(parseError);
      }
    });
  });
}

/**
 * Posts the transcription to the transcription channel and checks for profanity.
 * @param {Object} guild - The guild object.
 * @param {string} userId - The user ID.
 * @param {string} transcription - The transcription text.
 */
async function postTranscription(guild, userId, transcription, channelId) {
  try {
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

    let roleColor = "\u001b[2;37m"; // Default: light gray
    let nameColor = "\u001b[2;37m"; // Match role for now

    if (guild.ownerId === userId) {
      roleColor = "\u001b[31m"; // 🔴 Red
      nameColor = "\u001b[31m";
    } else if (member.permissions.has("Administrator")) {
      roleColor = "\u001b[34m"; // 🔵 Blue
      nameColor = "\u001b[34m";
    } else if (
      member.permissions.has("ManageGuild") ||
      member.permissions.has("KickMembers") ||
      member.permissions.has("MuteMembers") ||
      member.permissions.has("BanMembers") ||
      member.permissions.has("ManageMessages")
    ) {
      roleColor = "\u001b[33m"; // 🟡 Yellow/Gold
      nameColor = "\u001b[33m";
    }

    const bracket = "\u001b[2;30m"; // Dark gray
    const reset = "\u001b[0m";
    const timeColor = "\u001b[37m"; // White
    const channelColor = "\u001b[37m"; // White
    const messageColor = "\u001b[2;37m"; // Light gray

    const now = new Date();
    const timestamp = `${bracket}[${timeColor}${now.toLocaleTimeString(
      "en-US",
      {
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }
    )}${bracket}]${reset}`;

    let voiceChannelName = "Unknown Channel";
    if (channelId && guild.channels.cache.has(channelId)) {
      voiceChannelName = guild.channels.cache.get(channelId)?.name || "Unknown Channel";
    }

    const formattedMessage = `
${timestamp} ${bracket}[${roleColor}${formattedRole}${bracket}] [${nameColor}${userId}${bracket}] [🔊${channelColor}${voiceChannelName}${bracket}] ${nameColor}${member?.displayName || `User ${userId}`
      }${bracket}:${messageColor} ${transcription}${reset}`;

    try {
      const maxLength = 1900; // Buffer space for code block endings
      const rawLines = formattedMessage.split("\n");
      let currentBlock = "```ansi\n";

      for (const line of rawLines) {
        // Check if adding this line would exceed the max length (including the closing ``` line)
        if ((currentBlock + line + "\n```").length > maxLength) {
          currentBlock += "```"; // Close current block
          await channel.send(currentBlock).catch(console.error);
          currentBlock = "```ansi\n"; // Start new block
        }
        currentBlock += line + "\n";
      }

      // Send any remaining content in the buffer
      if (currentBlock !== "```ansi\n") {
        currentBlock += "```";
        await channel.send(currentBlock).catch(console.error);
      }

      console.log(`[✅] Sent transcription to ${channel.name}`);
    } catch (err) {
      console.error(`[❌] Failed to send transcription: ${err.message}`);
    }

    // Profanity integration: update filter, clean text, and flag if needed
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
 * Converts a raw **16‑bit PCM** file (decoded from Opus) to a WAV file.
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

  return new Promise((resolve, reject) => {
    ffmpeg(pcmPath)
      .inputFormat("s16le")      // raw 16‑bit little‑endian PCM
      .inputOptions(['-ar 48000', '-ac 1'])   // tell FFmpeg what it *really* receives
      .audioFrequency(16000)                 // then resample
      .audioChannels(1)
      .audioCodec("pcm_s16le")
      .toFormat("wav")
      .save(wavFilePath)
      .on("end", () => {
        console.log(`[INFO] PCM → WAV conversion complete: ${wavFilePath}`);
        resolve();
      })
      .on("error", (error) => {
        console.error(`[ERROR] FFmpeg failed: ${error.message}`);
        reject(error);
      });
  });
}

/**
 * Safely deletes a file if it exists.
 * @param {string} filePath - The path to the file.
 */
async function safeDeleteFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
    }
  } catch (error) {
    console.error(`[ERROR] Failed to delete ${filePath}: ${error.message}`);
  }
}

/**
 * Deletes an array of files.
 * @param {Array<string>} filePaths - The file paths to delete.
 */
async function cleanupFiles(filePaths = []) {
  for (const filePath of filePaths) {
    try {
      await fs.promises.unlink(filePath);
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

// =========================================
// EXPORTS
// =========================================
module.exports = {
  // Transcription & Audio Processing
  ensureTranscriptionChannel,
  processAudio,
  convertOpusToWav,
  transcribeAudio,
  postTranscription,
  safeDeleteFile,
  cleanupFiles,
  ensureDirectoryExistence,
  createLoudnessDetector,
  // Profanity & Flagging Functions
  updateProfanityFilter,
  containsProfanity,
  updateFilterList,
  setfilterLevel,
  clean,
  checkForFlaggedContent,
};
