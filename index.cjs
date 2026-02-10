process.env.DISCORDJS_DISABLE_UDP = "true";

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

const {
  Client,
  GatewayIntentBits,
  Events,
  ChannelType,
  AuditLogEvent,
  PermissionFlagsBits,
  PermissionsBitField,
  SnowflakeUtil,
} = require("discord.js");

const { joinVoiceChannel, getVoiceConnection, VoiceConnectionStatus } = require("@discordjs/voice");
const { createClient: createSupabaseClient } = require("@supabase/supabase-js");

// ── imports (keep your wiring) ────────────────────────────────────────────────
const commands = require("./commands/commands.cjs");

const voiceChannelManager = require("./events/voiceChannelManager.cjs");
const { joinChannel, audioListeningFunctions } = require("./events/voiceChannelManager.cjs");

const { interactionContexts } = require("./database/contextStore.cjs");
const { handleReaction } = require("./commands/report/reportHandler.cjs");

const { VC_STATE_PATH, saveVCState } = require("./util/vc_state.cjs");
const transcription = require("./events/transcription.cjs");

const {
  getSettingsForGuild,
  updateSettingsForGuild,
  hasUserConsented,
} = require("./commands/settings.cjs");

const { sendConsentPrompt } = require("./commands/logic/consent_logic.cjs");

const {
  handleNotifyMessageCommand,
  handleNotifySlashCommand,
  handleNotifyFlow,
  showNotifyHubUI,
  listNotifications,
  listNotificationsForTarget,
  listUsersBlockedBy,
} = require("./commands/logic/notify_logic.cjs");

const { cleanupOldReports } = require("./commands/report/cleanupReports.cjs");

// ── env ───────────────────────────────────────────────────────────────────────
dotenv.config();

// ── minimal safe logging ──────────────────────────────────────────────────────
function safeLog(...args) {
  try { console.log(...args); } catch { }
}
function safeErr(...args) {
  try { console.error(...args); } catch { }
}

// ── error classifiers ─────────────────────────────────────────────────────────
function errMsg(err) {
  return (err && (err.stack || err.message)) || String(err || "");
}

function isOpusCorruption(err) {
  const msg = errMsg(err);
  return /compressed data.*corrupted|opus.*corrupt/i.test(msg);
}

function isTransientNetwork(err) {
  const msg = errMsg(err);
  return /ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|fetch failed|discord\.media|Unexpected server response:\s*522/i.test(msg);
}

function looksLikeBillingOrQuota(err) {
  const msg = errMsg(err);
  // Supabase 402 / payment required / quota / project paused types of failures
  return /402|payment required|quota|exceeded|over.*limit|project.*paused|subscription|billing/i.test(msg);
}

// ── circuit breaker (prevents spam storms) ────────────────────────────────────
const CB = {
  windowMs: 30_000,
  maxErrors: 25,
  errors: [],
  trippedUntil: 0,
};

function recordErrorForCircuit() {
  const now = Date.now();
  CB.errors.push(now);
  CB.errors = CB.errors.filter((t) => now - t < CB.windowMs);
  if (CB.errors.length >= CB.maxErrors) {
    CB.trippedUntil = now + 15_000;
    CB.errors = [];
    safeErr("[CIRCUIT] Too many errors; cooling down for 15s.");
  }
}

function circuitIsTripped() {
  return Date.now() < CB.trippedUntil;
}

// ── FAIL-OPEN policy bypass (critical for “no stuck mutes”) ───────────────────
const FAIL_OPEN = {
  enabled: false,
  lastTrip: 0,
  reason: "",
};

function enableFailOpen(reason) {
  if (!FAIL_OPEN.enabled) {
    safeErr("[FAIL-OPEN] ENABLED:", reason);
  }
  FAIL_OPEN.enabled = true;
  FAIL_OPEN.lastTrip = Date.now();
  FAIL_OPEN.reason = reason || "unknown";
}

function disableFailOpen() {
  if (FAIL_OPEN.enabled) {
    safeLog("[FAIL-OPEN] DISABLED (policy restored)");
  }
  FAIL_OPEN.enabled = false;
  FAIL_OPEN.reason = "";
}

if (process.env.FORCE_FAIL_OPEN === "1") {
  enableFailOpen("FORCE_FAIL_OPEN=1");
}

// ── universal rescue wrapper ──────────────────────────────────────────────────
async function withRescue(fn, context = "unknown", fallbackValue = undefined) {
  try {
    if (circuitIsTripped()) return fallbackValue;
    return await fn();
  } catch (err) {
    // policy safety: if DB/billing is bad, fail-open immediately
    if (looksLikeBillingOrQuota(err)) enableFailOpen(`${context} billing/quota`);
    if (isTransientNetwork(err)) {
      safeLog(`[WARN][RESCUE:${context}] transient suppressed:`, err?.message || err);
      return fallbackValue;
    }
    recordErrorForCircuit();
    safeErr(`[ERROR][RESCUE:${context}]`, errMsg(err));
    return fallbackValue;
  }
}

// ── single-instance lock (stops duplicate bots) ───────────────────────────────
const LOCK_PATH = path.join(__dirname, "vc_tools_index.lock");
const PID_PATH = path.join(__dirname, "vc_tools_index.pid");

function writeLockOrExit() {
  try {
    if (fs.existsSync(LOCK_PATH)) {
      const oldPid = Number(fs.readFileSync(LOCK_PATH, "utf8"));
      if (!Number.isNaN(oldPid)) {
        try {
          process.kill(oldPid, 0);
          safeErr(`[LOCK] Another VC Tools instance is running (pid ${oldPid}). Exiting.`);
          process.exit(0);
        } catch {
          // stale lock, continue
        }
      }
    }

    fs.writeFileSync(LOCK_PATH, String(process.pid));
    fs.writeFileSync(PID_PATH, String(process.pid));

    const cleanup = () => {
      try { fs.unlinkSync(LOCK_PATH); } catch { }
      try { fs.unlinkSync(PID_PATH); } catch { }
    };

    process.on("exit", cleanup);
    process.on("SIGINT", () => { cleanup(); process.exit(); });
    process.on("SIGTERM", () => { cleanup(); process.exit(); });

  } catch (e) {
    safeErr("[LOCK] Failed to set lock:", e?.message || e);
  }
}

writeLockOrExit();

// ── create client early (avoids “client before init”) ─────────────────────────
let client = null;

// ── global process guards (never crash the process) ───────────────────────────
process.on("uncaughtException", (err) => {
  try {
    const msg = errMsg(err);

    if (isOpusCorruption(err)) {
      safeLog("[GLOBAL] Swallowed Opus corruption:", msg);
      return;
    }
    if (isTransientNetwork(err)) {
      safeLog("[GLOBAL] Swallowed transient uncaughtException:", msg);
      return;
    }

    if (looksLikeBillingOrQuota(err)) enableFailOpen("uncaughtException billing/quota");

    recordErrorForCircuit();
    safeErr("[GLOBAL] Uncaught exception (suppressed):", msg);

    // fire-and-forget dev logging (if client exists)
    if (client) {
      Promise.resolve(
        logGlobalError(client, `Uncaught Exception:\n${msg}`, "process.on('uncaughtException')")
      ).catch(() => { });
    }

  } catch (fatal) {
    safeErr("[UNCAUGHT-EXCEPTION-FAILSAFE]", fatal);
  }
});

process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error
    ? reason
    : new Error(typeof reason === "object" ? JSON.stringify(reason) : String(reason));

  const msg = errMsg(err);

  if (isOpusCorruption(err)) {
    safeLog("[GLOBAL] Swallowed Opus corruption rejection:", msg);
    return;
  }
  if (isTransientNetwork(err)) {
    safeLog("[GLOBAL] Swallowed transient unhandledRejection:", msg);
    return;
  }

  if (looksLikeBillingOrQuota(err)) enableFailOpen("unhandledRejection billing/quota");

  recordErrorForCircuit();
  safeErr("[GLOBAL] Unhandled rejection (suppressed):", msg);
});

// ── cleanup temp audio ────────────────────────────────────────────────────────
const audioDir = path.resolve(__dirname, "../../temp_audio");

function safeUnlinkWithRetry(filePath, retries = 6) {
  return new Promise((resolve) => {
    const attempt = (n) => {
      fs.unlink(filePath, (err) => {
        if (!err) return resolve(true);
        if ((err.code === "EPERM" || err.code === "EBUSY") && n > 0) {
          return setTimeout(() => attempt(n - 1), 200);
        }
        console.warn(`[SAFE-DEL] Failed to delete ${filePath} (${err.code}): ${err.message}`);
        resolve(false);
      });
    };
    attempt(retries);
  });
}

fs.readdir(audioDir, async (err, files) => {
  if (err) return;
  for (const file of files) {
    if (file.endsWith(".pcm") || file.endsWith(".wav")) {
      await safeUnlinkWithRetry(path.join(audioDir, file));
    }
  }
});

// ── discord client ────────────────────────────────────────────────────────────
client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
  ],
});

// ── supabase ──────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  safeErr("[ERROR] Missing Supabase environment variables!");
  process.exit(1);
}

const supabase = createSupabaseClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// policy-safe wrappers (these are your “bypassers”)
async function safeGetSettingsForGuild(guildId) {
  return await withRescue(async () => {
    const settings = await getSettingsForGuild(guildId);
    // if we can read settings again, policy might be restored
    if (!process.env.FORCE_FAIL_OPEN) disableFailOpen();
    return settings;
  }, "getSettingsForGuild", null);
}

async function safeHasUserConsented(userId, guildId) {
  if (FAIL_OPEN.enabled) return true;
  return await withRescue(async () => {
    return await hasUserConsented(userId, guildId);
  }, "hasUserConsented", true);
}

async function safeSendConsentPrompt(guild, userId, settings) {
  if (FAIL_OPEN.enabled) return false; // absolutely no consent spam in fail-open
  return await withRescue(async () => {
    await sendConsentPrompt(guild, userId, settings);
    return true;
  }, "sendConsentPrompt", false);
}

// ── guild stats update ────────────────────────────────────────────────────────
async function updateGuildStats(guildId, stats) {
  return await withRescue(async () => {
    const { error } = await supabase
      .from("guild_settings")
      .update(stats)
      .eq("guildId", guildId);

    if (error) {
      if (looksLikeBillingOrQuota(error)) enableFailOpen("updateGuildStats billing/quota");
      safeErr("[GUILD_STATS] update failed:", error);
      return false;
    }
    return true;
  }, "updateGuildStats", false);
}

// ── dynamic event handlers loader ─────────────────────────────────────────────
async function loadEventHandlers() {
  const eventsPath = path.join(__dirname, "events");
  const eventFiles = fs
    .readdirSync(eventsPath)
    .filter((file) => file.endsWith(".cjs") && file !== "transcription.cjs");

  for (const file of eventFiles) {
    await withRescue(async () => {
      const mod = require(`./events/${file}`);
      const execute = mod?.execute;
      if (typeof execute !== "function") {
        safeErr(`The file ${file} does not export a function named 'execute'.`);
        return;
      }

      const eventName = file.replace(".cjs", "");
      client.on(eventName, (...args) => {
        withRescue(() => execute(...args, client), `event:${eventName}`).catch(() => { });
      });

      safeLog(`[INFO] Event handler loaded: ${eventName}`);
    }, `loadEvent:${file}`);
  }
}

loadEventHandlers().catch((e) => safeErr("[EVENT_LOADER] failed:", e?.message || e));

// ── soundboard defaults cache ────────────────────────────────────────────────
let DEFAULT_SOUNDS = {};

async function fetchDefaultSoundboardSounds() {
  return await withRescue(async () => {
    const defaultSounds = await client.rest.get("/soundboard-default-sounds", {
      headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` },
    });

    if (!Array.isArray(defaultSounds)) return {};
    return defaultSounds.reduce((acc, sound) => {
      acc[sound.sound_id] = `${sound.name} ${sound.emoji_name || ""}`;
      return acc;
    }, {});
  }, "fetchDefaultSoundboardSounds", {});
}

client.once("clientReady", async () => {
  DEFAULT_SOUNDS = await fetchDefaultSoundboardSounds();
  safeLog(`[INFO] Loaded ${Object.keys(DEFAULT_SOUNDS).length} default soundboard sounds.`);
});

// ── helper: transcription channel ─────────────────────────────────────────────
async function ensureTranscriptionChannel(guild) {
  const settings = await safeGetSettingsForGuild(guild.id);
  if (!settings) return null;
  if (!settings.transcriptionEnabled || !settings.channelId) return null;
  return await guild.channels.fetch(settings.channelId).catch(() => null);
}

// ── helper: user status ───────────────────────────────────────────────────────
async function getUserStatus(userId, guildId) {
  return await withRescue(async () => {
    const { data, error } = await supabase
      .from("statuses")
      .select("status")
      .eq("user_id", userId)
      .eq("server_id", guildId)
      .maybeSingle();

    if (error) {
      if (looksLikeBillingOrQuota(error)) enableFailOpen("getUserStatus billing/quota");
      safeErr(`[ERROR] Could not get status for ${userId}:`, error);
      return "open";
    }

    return data?.status || "open";
  }, "getUserStatus", "open");
}

// ── FAIL-OPEN safety: actively unmute if policy is bypassed ───────────────────
async function failOpenSafetyUnmute(member) {
  if (!FAIL_OPEN.enabled) return;
  if (!member?.voice) return;
  if (!member.voice.serverMute) return;

  await withRescue(async () => {
    await member.voice.setMute(false, "Fail-open safety unmute");
  }, "failOpenSafetyUnmute");
}

// ── soundboard event: VOICE_CHANNEL_EFFECT_SEND ───────────────────────────────
client.ws.on("VOICE_CHANNEL_EFFECT_SEND", async (data) => {
  await withRescue(async () => {
    const { user_id, guild_id, sound_id } = data;

    const guild = client.guilds.cache.get(guild_id);
    if (!guild) return;

    const settings = await safeGetSettingsForGuild(guild.id);
    if (!settings) return;
    if (!settings.soundboardLogging) return;

    const guildId = settings.guildId || guild.id;
    const transcriptionChannel = await ensureTranscriptionChannel(guild);
    if (!transcriptionChannel) return;

    const user = await client.users.fetch(user_id);
    const member = await guild.members.fetch(user_id).catch(() => null);

    let soundName = `Unknown Sound (ID: ${sound_id})`;
    if (DEFAULT_SOUNDS[sound_id]) {
      soundName = DEFAULT_SOUNDS[sound_id];
    } else {
      // best-effort fetch guild sounds
      const guildSounds = await withRescue(async () => {
        return await client.rest.get(`/guilds/${guildId}/soundboard-sounds`, {
          headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` },
        });
      }, "fetchGuildSoundboardSounds", null);

      if (guildSounds && Array.isArray(guildSounds.items)) {
        const found = guildSounds.items.find((s) => s.sound_id === sound_id);
        if (found) soundName = `${found.name} ${found.emoji_name || ""}`;
      }
    }

    const now = new Date();
    const ansi = {
      darkGray: "\u001b[2;30m",
      white: "\u001b[2;37m",
      red: "\u001b[2;31m",
      yellow: "\u001b[2;33m",
      cyan: "\u001b[2;36m",
      reset: "\u001b[0m",
    };

    const timestamp = `${now.toLocaleTimeString("en-US", {
      hour12: false,
      minute: "2-digit",
      second: "2-digit",
    })}`;

    const topRole = member?.roles?.highest?.name || "No Role";
    let roleColor = ansi.white;
    if (guild.ownerId === user.id) roleColor = ansi.red;
    else if (member?.permissions?.has("Administrator")) roleColor = ansi.cyan;
    else if (member?.permissions && (
      member.permissions.has("ManageGuild") ||
      member.permissions.has("KickMembers") ||
      member.permissions.has("MuteMembers") ||
      member.permissions.has("BanMembers") ||
      member.permissions.has("ManageMessages")
    )) roleColor = ansi.yellow;

    // spacing safety for ansi blocks
    const SPACE = "\u200A";
    const c = (color) => `${color}${SPACE}`;
    const br = (inner) => `[${SPACE}${inner}${SPACE}]${SPACE}`;
    const safe = (s) => String(s).replace(/</g, `<${SPACE}`);

    const emoji = data.emoji?.id === null ? (data.emoji?.name || "") : "";

    const logMsg =
      `${br(`${roleColor}${safe(topRole)}${c(ansi.darkGray)}`)}` +
      `${br(`${c(ansi.white)}${safe(user.id)}${c(ansi.darkGray)}`)}` +
      ` ${roleColor}${safe(user.username)}${c(ansi.darkGray)} triggered a soundboard: ` +
      `${c(ansi.white)}${emoji ? `${emoji}${SPACE}` : ""}${safe(soundName)}${c(ansi.reset)}`;

    const soundboardMessage =
      `\`\`\`ansi\n${c(ansi.darkGray)}${br(`${c(ansi.white)}${timestamp}${c(ansi.darkGray)}`)}${SPACE}${logMsg}\n\`\`\``;

    await transcriptionChannel.send(soundboardMessage);

    safeLog(`[INFO] Logged soundboard usage for ${user.username} in ${transcriptionChannel.name}`);

    // FAIL-OPEN rule: never enforce punitive actions when policy bypass is active
    if (FAIL_OPEN.enabled) return;

    // spam kicker
    if (settings.kickOnSoundboardSpam) {
      const isoNow = new Date().toISOString();

      const insertOk = await withRescue(async () => {
        const { error } = await supabase.from("soundboard_spam_log").insert({
          userid: user_id,
          guildid: guild_id,
          timestamp: isoNow,
        });
        if (error) throw error;
        return true;
      }, "soundboardSpamInsert", false);

      if (!insertOk) return;

      await new Promise((r) => setTimeout(r, 100));

      const twoSecondsAgo = new Date(Date.now() - 2000).toISOString();

      const usageData = await withRescue(async () => {
        const { data, error } = await supabase
          .from("soundboard_spam_log")
          .select("*")
          .eq("userid", user_id)
          .gte("timestamp", twoSecondsAgo);

        if (error) throw error;
        return data || [];
      }, "soundboardSpamQuery", []);

      if ((usageData.length || 0) >= 5) {
        if (member && member.voice?.channel) {
          await withRescue(async () => {
            await member.voice.disconnect("Soundboard spam detected");
          }, "soundboardSpamDisconnect");

          await withRescue(async () => {
            await supabase.from("soundboard_spam_log").delete().eq("userid", user_id);
          }, "soundboardSpamClear");

          // log to activity channel if enabled
          if (settings.vcLoggingEnabled && settings.vcLoggingChannelId) {
            const activityChannel = guild.channels.cache.get(settings.vcLoggingChannelId);
            if (activityChannel) {
              const ts2 = new Date().toLocaleTimeString("en-US", { minute: "2-digit", second: "2-digit" });

              const ansi2 = {
                darkGray: "\u001b[2;30m",
                white: "\u001b[2;37m",
                red: "\u001b[2;31m",
                yellow: "\u001b[2;33m",
                cyan: "\u001b[2;36m",
                reset: "\u001b[0m",
              };

              const topRole2 = member.roles.highest?.name || "No Role";
              const username2 = member.user.username;
              const userId2 = member.user.id;

              let roleColor2 = ansi2.white;
              if (guild.ownerId === userId2) roleColor2 = ansi2.red;
              else if (member.permissions.has("Administrator")) roleColor2 = ansi2.cyan;
              else if (
                member.permissions.has("ManageGuild") ||
                member.permissions.has("KickMembers") ||
                member.permissions.has("MuteMembers") ||
                member.permissions.has("BanMembers") ||
                member.permissions.has("ManageMessages")
              ) roleColor2 = ansi2.yellow;

              const line =
                `[${roleColor2}${topRole2}${ansi2.darkGray}] ` +
                `[${ansi2.white}${userId2}${ansi2.darkGray}] ` +
                `${roleColor2}${username2}${ansi2.darkGray} was kicked by ${ansi2.white}VC Tools${ansi2.darkGray} for soundboard spamming.`;

              const block = (msg) =>
                `\`\`\`ansi\n${ansi2.darkGray}[${ansi2.white}${ts2}${ansi2.darkGray}] ${msg}${ansi2.reset}\n\`\`\``;

              await activityChannel.send(block(line)).catch(() => { });
            }
          }

          await withRescue(async () => {
            await user.send("> <💥> Soundboard spam detected! You have been kicked from the voice channel.");
          }, "soundboardSpamDM");

          await withRescue(async () => {
            await supabase.from("soundboard_spam_log").delete().eq("userid", user_id);
          }, "soundboardSpamClear2");

          safeLog(`[INFO] Kicked user ${user_id} from VC for soundboard spam.`);
        }
      }

      // cleanup old records
      const fiveSecondsAgo = new Date(Date.now() - 5000).toISOString();
      await withRescue(async () => {
        const { error } = await supabase
          .from("soundboard_spam_log")
          .delete()
          .lt("timestamp", fiveSecondsAgo);
        if (error) throw error;
      }, "soundboardSpamCleanup");
    }
  }, "VOICE_CHANNEL_EFFECT_SEND");
});

// ── voiceStateUpdate + notify DMs ─────────────────────────────────────────────
client.on("voiceStateUpdate", async (oldState, newState) => {
  // FAIL-OPEN safety: if your bot ever muted someone earlier, undo it immediately.
  if (newState?.member) {
    await failOpenSafetyUnmute(newState.member);
  }

  // Existing VC manager logic (should keep running regardless)
  await withRescue(async () => {
    voiceChannelManager.execute(oldState, newState, client);
  }, "voiceChannelManager.execute");

  // When a user joins a voice channel, notify subscribers
  if (!oldState.channelId && newState.channelId) {
    const joinedUserId = newState.member.user.id;
    const guildId = newState.guild.id;

    safeLog(`[DEBUG] User ${joinedUserId} joined VC in guild ${guildId}.`);

    await withRescue(async () => {
      // FAIL-OPEN does NOT need to disable notifications. Only disable enforcement.
      const subscriptions = await listNotificationsForTarget(joinedUserId, guildId);
      safeLog(`[DEBUG] Subscriptions for target ${joinedUserId}:`, subscriptions);

      const status = await getUserStatus(joinedUserId, guildId);
      safeLog(`[DEBUG] Joined user's status: ${status}`);

      if (!subscriptions?.length) return;
      if (status === "invisible" || status === "closed") return;

      for (const sub of subscriptions) {
        await withRescue(async () => {
          const subscriberUser = await client.users.fetch(sub.user_id).catch(() => null);
          if (!subscriberUser) return;

          // blocks
          const blocks = await listUsersBlockedBy(joinedUserId, guildId);
          const isBlocked = blocks.some((b) => b.blocked_id === sub.user_id);
          if (isBlocked) {
            safeLog(`[INFO] Skipping DM to ${sub.user_id} — ${joinedUserId} has blocked them`);
            return;
          }

          const guild = client.guilds.cache.get(guildId);
          if (!guild) return;

          const channel =
            guild.channels.cache.get(newState.channelId) ||
            (await guild.channels.fetch(newState.channelId).catch(() => null));

          const guildMember = await guild.members.fetch(sub.user_id).catch(() => null);
          if (!guildMember || !channel?.permissionsFor(guildMember)?.has("Connect")) {
            safeLog(`[INFO] Skipping ${sub.user_id} — no access to connect to ${channel?.name}`);
            return;
          }

          if (guildMember.voice.channelId === channel.id) {
            safeLog(`[INFO] Skipping ${sub.user_id} — already in ${channel.name}`);
            return;
          }

          const channelMention = channel ? `<#${channel.id}>` : "a voice channel";
          const guildName = guild?.name || "(Unknown server)";

          await subscriberUser.send({
            content: `[❕] <@${joinedUserId}> just joined ${channelMention} inside **${guildName}**!`,
          });

          safeLog(`[INFO] DM sent: Notified ${sub.user_id} about ${joinedUserId}`);
        }, `notifyDM:${sub.user_id}`);
      }
    }, "voiceStateUpdate.notifyFlow");
  }
});

// ── GuildCreate welcome logic ────────────────────────────────────────────────
client.on(Events.GuildCreate, async (guild) => {
  await withRescue(async () => {
    safeLog(`[INFO] Joined a new guild: ${guild.name} (${guild.id})`);

    const botMember = await guild.members.fetchMe();
    await guild.channels.fetch();

    let inviter = null;
    let inviterMember = null;

    await withRescue(async () => {
      const auditLogs = await guild.fetchAuditLogs({
        type: AuditLogEvent.BotAdd,
        limit: 1,
      });
      inviter = auditLogs.entries.first()?.executor ?? null;
      if (inviter) {
        inviterMember = await guild.members.fetch(inviter.id).catch(() => null);
      }
    }, "GuildCreate.fetchAuditLogs");

    const welcomeMsg = inviter
      ? `<@${inviter.id}>, **thank you** for adding me to **${guild.name}**!\nType \`>initialize ftt\` to begin setup.`
      : `Thanks for adding me to **${guild.name}**! Type \`>initialize ftt\` to begin setup.`;

    const hierarchyMsg = "Please **move my role up the hierarchy** so I can operate properly.";

    function canBotSend(channel, memberToViewCheck = null) {
      if (!channel || typeof channel.permissionsFor !== "function") return false;

      const mePerms =
        channel.permissionsFor(channel.guild.members.me) ||
        channel.permissionsFor(botMember);
      if (!mePerms) return false;

      const canView =
        mePerms.has(PermissionFlagsBits.ViewChannel) ||
        mePerms.has(PermissionsBitField.Flags.ViewChannel);

      const canSend =
        channel.isTextBased?.() &&
        (mePerms.has(PermissionFlagsBits.SendMessages) ||
          mePerms.has(PermissionsBitField.Flags.SendMessages));

      if (!canView || !canSend) return false;

      if (memberToViewCheck) {
        const memPerms = channel.permissionsFor(memberToViewCheck);
        if (!memPerms || !memPerms.has(PermissionFlagsBits.ViewChannel)) return false;
      }
      return true;
    }

    await updateGuildStats(guild.id, {
      still_within: 1,
      member_count: guild.memberCount,
    });

    async function channelHasPublicMessages(channel) {
      return await withRescue(async () => {
        if (!channel.isTextBased?.()) return false;
        const msgs = await channel.messages.fetch({ limit: 1 });
        return msgs?.size > 0;
      }, "channelHasPublicMessages", false);
    }

    async function findMostRecentUserMessageChannel(guild, member, opts = {}) {
      const { channelScanLimit = 15, perChannelMessages = 25 } = opts;

      const candidates = guild.channels.cache.filter((c) => {
        const isText = c.type === ChannelType.GuildText;
        const isVoiceText = (c.type === ChannelType.GuildVoice) && c.isTextBased?.();
        if (!(isText || isVoiceText)) return false;
        return canBotSend(c, member);
      });

      const sorted = [...candidates.values()].sort((a, b) => {
        const ta = a.lastMessageId ? SnowflakeUtil.timestampFrom(a.lastMessageId) : 0;
        const tb = b.lastMessageId ? SnowflakeUtil.timestampFrom(b.lastMessageId) : 0;
        return tb - ta;
      });

      for (let i = 0; i < Math.min(sorted.length, channelScanLimit); i++) {
        const ch = sorted[i];
        const ok = await withRescue(async () => {
          const msgs = await ch.messages.fetch({ limit: perChannelMessages });
          return !!msgs.find((m) => m.author?.id === member.id);
        }, "findMostRecentUserMessageChannel.fetch", false);

        if (ok) return ch;
      }
      return null;
    }

    async function findFirstVisibleTextChannelWithHistory(guild, memberCheck = null) {
      const channels = guild.channels.cache
        .filter((c) => c.isTextBased?.() && c.type === ChannelType.GuildText)
        .sort((a, b) => {
          if (a.parentId === b.parentId) return a.rawPosition - b.rawPosition;
          const aP = a.parent ?? { rawPosition: -1 };
          const bP = b.parent ?? { rawPosition: -1 };
          return aP.rawPosition - bP.rawPosition;
        });

      for (const [, ch] of channels) {
        if (!canBotSend(ch, memberCheck || null)) continue;
        if (await channelHasPublicMessages(ch)) return ch;
      }
      return null;
    }

    // 0) DM inviter first
    let sentDM = false;
    if (inviter) {
      const ok = await withRescue(async () => {
        await inviter.send(`${welcomeMsg}\n\n${hierarchyMsg}`);
        return true;
      }, "GuildCreate.dmInviter", false);

      if (ok) {
        safeLog("[INFO] Sent welcome/setup message via DM to inviter.");
        sentDM = true;
      }
    }

    if (sentDM) return;

    // Choose ONE target for both messages
    let target = null;

    if (inviterMember) {
      target = await findMostRecentUserMessageChannel(guild, inviterMember, {
        channelScanLimit: 15,
        perChannelMessages: 25,
      });
    }

    if (!target) target = await findFirstVisibleTextChannelWithHistory(guild, inviterMember || null);

    if (!target && guild.systemChannel && canBotSend(guild.systemChannel, inviterMember || null)) {
      target = guild.systemChannel;
    }

    if (!target) {
      safeLog("[WARN] No server location available to send messages.");
      return;
    }

    const isLowInHierarchy = botMember.roles.highest.position < guild.roles.highest.position;

    if (isLowInHierarchy) {
      await withRescue(async () => {
        await target.send(hierarchyMsg);
      }, "GuildCreate.sendHierarchyMsg");
    }

    await withRescue(async () => {
      await target.send(welcomeMsg);
    }, "GuildCreate.sendWelcomeMsg");

  }, "GuildCreate");
});

// ── member count updates ──────────────────────────────────────────────────────
client.on(Events.GuildMemberAdd, async (member) => {
  await updateGuildStats(member.guild.id, { member_count: member.guild.memberCount });
});

client.on(Events.GuildMemberRemove, async (member) => {
  await updateGuildStats(member.guild.id, { member_count: member.guild.memberCount });
});

client.on(Events.GuildDelete, async (guild) => {
  await updateGuildStats(guild.id, { still_within: 0 });
});

// ── startup / intervals ───────────────────────────────────────────────────────
client.once("clientReady", async () => {
  safeLog(`[INFO] Successfully logged in as ${client.user.tag}`);
  await withRescue(async () => client.user.setPresence({ status: "idle" }), "setPresence(idle)");

  // refresh guild stats
  await withRescue(async () => {
    for (const g of client.guilds.cache.values()) {
      await updateGuildStats(g.id, { still_within: 1, member_count: g.memberCount });
    }
  }, "startup.updateGuildStatsAll");

  // boot channel ping
  const now = new Date();
  const timestamp = now.toLocaleTimeString("en-US", {
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  await withRescue(async () => {
    const channel = await client.channels.fetch("1356838107818885151");
    if (!channel || !channel.send) return;

    const ansi = {
      darkGray: "\u001b[2;30m",
      lightGray: "\u001b[2;37m",
      blue: "\u001b[2;34m",
      reset: "\u001b[0m",
    };

    await channel.send(
      "```ansi\n" +
      `${ansi.darkGray}[${ansi.blue}${timestamp}${ansi.darkGray}] ` +
      `${ansi.lightGray}VC Tools ${ansi.darkGray}is now ${ansi.blue}online${ansi.darkGray}.${ansi.reset}` +
      "```"
    );
  }, "startup.bootChannelPing");

  // periodic VC checks
  await withRescue(async () => {
    if (typeof voiceChannelManager.startPeriodicVCCheck === "function") {
      voiceChannelManager.startPeriodicVCCheck(client, 15000);
    } else {
      safeLog("[AUTO-VC] startPeriodicVCCheck not available on voiceChannelManager.");
    }
  }, "startup.startPeriodicVCCheck");

  // Cleanup old reports every 10 min
  setInterval(() => {
    withRescue(() => cleanupOldReports(client), "interval.cleanupOldReports").catch(() => { });
  }, 10 * 60 * 1000);

  // Presence update every 30s
  setInterval(() => {
    withRescue(async () => {
      let vcCount = 0;
      let userCount = 0;

      client.guilds.cache.forEach((g) => {
        const vc = g.members.me?.voice.channel;
        if (vc) {
          vcCount++;
          userCount += vc.members.filter((m) => !m.user.bot).size;
        }
      });

      if (userCount > 0) {
        const activityText = `🔊 ${vcCount} • 🎙️ ${userCount} `;
        await client.user.setPresence({
          status: "idle",
          activities: [{ name: activityText, type: 4 }],
        });
      } else {
        await client.user.setPresence({
          status: "idle",
          activities: [],
        });
      }
    }, "interval.presenceUpdate").catch(() => { });
  }, 30 * 1000);

  // Optional: try to recover from FAIL-OPEN automatically (lightweight “health probe”)
  setInterval(() => {
    withRescue(async () => {
      if (!FAIL_OPEN.enabled) return;

      // extremely cheap probe: a single select with limit 1
      const { error } = await supabase.from("guild_settings").select("guildId").limit(1);
      if (!error && process.env.FORCE_FAIL_OPEN !== "1") {
        disableFailOpen();
      }
    }, "interval.failOpenProbe").catch(() => { });
  }, 60 * 1000);
});

// ── global error logging to dev channel ───────────────────────────────────────
async function logGlobalError(clientObj, error, context = "Unknown") {
  const errorMessage = error?.stack || error?.message || String(error);
  safeErr(`[GLOBAL ERROR] ${context}:\n${errorMessage}`);

  const DEV_guildId = "1278554231346958398";
  const DEV_ERROR_channelId = "1334114350205636648";

  await withRescue(async () => {
    const devGuild = await clientObj.guilds.fetch(DEV_guildId).catch(() => null);
    if (!devGuild) return;

    const devErrorChannel = await devGuild.channels.fetch(DEV_ERROR_channelId).catch(() => null);
    if (!devErrorChannel || !devErrorChannel.isTextBased()) return;

    await devErrorChannel.send(
      `> **[GLOBAL ERROR] ${context}**\n\`\`\`\n${errorMessage.slice(0, 1900)}\n\`\`\``
    );
  }, "logGlobalError");
}

// ── REST rate limit listeners ────────────────────────────────────────────────
client.rest.on("rateLimited", (info) => {
  safeLog(`[RATE LIMIT] route=${info.route} timeout=${info.timeToReset}ms global=${info.global}`);
});

client.rest.on("invalidRequestWarningData", (data) => {
  safeLog(`[INVALID WARN] count=${data.count} remaining=${data.remaining} resetAfter=${data.resetAfter}ms`);
});

// ── commands wiring ──────────────────────────────────────────────────────────
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  await withRescue(async () => {
    await commands.onMessageCreate(message);
  }, "commands.onMessageCreate");
});

client.on("interactionCreate", async (interaction) => {
  await withRescue(async () => {
    await commands.onInteractionCreate(interaction);
  }, "commands.onInteractionCreate");

  // if commands.onInteractionCreate throws, we still want your friendly ephem error
}).catch(async (error) => {
  safeErr(`[ERROR] Interaction handling failed: ${error?.message || error}`);

  const isRepliable = typeof interaction.isRepliable === "function" ? interaction.isRepliable() : false;
  if (!isRepliable) return;

  const payload = {
    content: "> <❌> An error occurred while processing your interaction. (INT_ERR_006)",
    ephemeral: true,
  };

  try {
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
    else await interaction.reply(payload);
  } catch (e) {
    const code = e?.code ?? e?.rawError?.code;
    if (code === 10062) return; // Unknown interaction
    safeErr(`[ERROR] Failed to send interaction error response: ${e?.message || e}`);
  }
});

client.on("messageReactionAdd", async (reaction, user) => {
  await withRescue(async () => {
    await handleReaction(reaction, user);
  }, "handleReaction");
});

// ── login ────────────────────────────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN);

// Export the client for external usage
module.exports = { client };