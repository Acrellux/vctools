// Fix for UDP discovery issue in Discord.js
process.env.DISCORDJS_DISABLE_UDP = "true";
console.log("[BOOT] UDP discovery disabled.");

const path = require("path");
const fs = require("fs");
const {
  VoiceConnectionStatus,
  joinVoiceChannel,
  getVoiceConnection,
} = require("@discordjs/voice");
const { EventEmitter } = require("events");
const { Readable, PassThrough } = require("stream");
const { finished } = require("stream/promises");
const prism = require("prism-media");
const transcription = require("./transcription.cjs"); // Import transcription module
const { interactionContexts } = require("../database/contextStore.cjs"); // Import context store
const {
  hasUserConsented,
  grantUserConsent,
  revokeUserConsent,
  getSettingsForGuild,
} = require("../commands/settings.cjs");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionsBitField,
  AuditLogEvent,
} = require("discord.js");
const {
  sendConsentPrompt,
  resolveConsentDestination,
} = require("../commands/logic/consent_logic.cjs");

// VC State importing
const { saveVCState, clearVCState } = require("../util/vc_state.cjs");

// Supabase initialization
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// We'll track when each user joined
const userJoinTimes = new Map();

EventEmitter.defaultMaxListeners = 50;

/************************************************************************************************
 * GLOBALS & CONSTANTS
 ************************************************************************************************/
const GRACE_PERIOD_MS = 3000;
const silenceDurations = new Map();
const MAX_SILENCE_RECORDS = 10;
const DEFAULT_SILENCE_TIMEOUT = 3000;
const finalizationTimers = {};

// NEW: idle linger so bot doesn't leave immediately when users go to SAFE channels
const IDLE_LINGER_MS = 60_000; // 60s; adjust if you want longer/shorter
const idleDisconnectTimers = new Map(); // guildId -> Timeout

// NEW: mod auto-route constants
const AUTO_ROUTE_MIN_OTHER_HUMANS = 2;

// Audio-processing queue (if needed)
let isProcessing = false;
const processingQueue = [];

// Track file streams and subscriptions by user
const outputStreams = {};
const userSubscriptions = {};
const userAudioIds = {}; // userId -> unique
const pipelines = new Map(); // userId -> { audioStream, decoder, pcmWriter, loudnessRes }
const finalizingKeys = new Set();

/************************************************************************************************
 * REUSABLE TRANSCRIPTION FUNCTIONS
 ************************************************************************************************/
const {
  transcribeAudio,
  postTranscription,
  convertOpusToWav,
  safeDeleteFile,
} = transcription;

/************************************************************************************************
 * SILENCE DETECTION HELPERS
 ************************************************************************************************/
function updateSilenceDuration(userId, duration) {
  const durations = silenceDurations.get(userId) || [];
  durations.push(duration);
  if (durations.length > MAX_SILENCE_RECORDS) {
    durations.shift();
  }
  silenceDurations.set(userId, durations);
}

function getAverageSilenceDuration(userId) {
  const durations = silenceDurations.get(userId) || [];
  if (!durations.length) return DEFAULT_SILENCE_TIMEOUT;
  const total = durations.reduce((sum, val) => sum + val, 0);
  return total / durations.length;
}

/************************************************************************************************
 * LOUDNESS DETECTION
 ************************************************************************************************/

const userWarningTimestamps = new Map(); // Tracks last warning time per user

const initiateLoudnessWarning = async (
  userId,
  audioStream,   // Opus stream
  guild,
  updateTimestamp
) => {
  const settings = await getSettingsForGuild(guild.id);
  if (settings.safeUsers && settings.safeUsers.includes(userId)) {
    console.log(`[INFO] User ${userId} is a safe user. Skipping loudness detection.`);
    return null;
  }

  const options = {
    cooldownMs: 15000,
    instantThreshold: 17500,
    fastThreshold: 14000,
    fastDuration: 500,
    prolongedThreshold: 10000,
    prolongedDuration: 6000,
  };

  const warnIfTooLoud = async (uid, rms) => {
    const now = Date.now();
    const lastWarning = userWarningTimestamps.get(uid) || 0;
    const cooldownMs = 15000;
    if (now - lastWarning < cooldownMs) return;
    userWarningTimestamps.set(uid, now);

    console.log(`*** WARNING: User ${uid} is too loud (RMS: ${rms}) ***`);

    const s = await getSettingsForGuild(guild.id);
    const roleId = s.notifyLoudUser ? s.voiceCallPingRoleId : null;

    try {
      const channel = await transcription.ensureTranscriptionChannel(guild);
      if (!channel) {
        console.error(`[ERROR] No transcription channel available for guild ${guild.id}`);
        return;
      }
      const base = `## ⚠️ User <@${uid}> is being loud (RMS: **${rms}**)\n-# Confused by what RMS means? Check \`help rms\`.`;
      const msg = roleId
        ? `## ⚠️ <@&${roleId}> User <@${uid}> is being loud (RMS: **${rms}**)\n-# Confused by what RMS means? Check \`help rms\`.`
        : base;
      await channel.send(msg);
    } catch (err) {
      console.error(`[ERROR] Failed to send loudness warning: ${err.message}`);
    }
  };

  const loudnessDetector = transcription.createLoudnessDetector(
    guild, userId, warnIfTooLoud, options
  );
  const opusDecoderForLoudness = new prism.opus.Decoder({
    frameSize: 960, channels: 1, rate: 48000,
  });

  // Track *activity* using source data (fixes RMS-event bug)
  let lastActiveTime = Date.now();
  const onData = () => {
    lastActiveTime = Date.now();
    if (typeof updateTimestamp === "function") updateTimestamp();
  };
  audioStream.on("data", onData);

  const QUIET_TIMEOUT_MS = 4000;
  const quietTimer = setInterval(() => {
    const silentDuration = Date.now() - lastActiveTime;
    if (silentDuration >= QUIET_TIMEOUT_MS) {
      console.warn(`[QUIET FINALIZE] ${userId} silent (low activity) for ${silentDuration}ms`);
      teardown();
    }
  }, 1000);

  // Wire the branch
  audioStream.pipe(opusDecoderForLoudness).pipe(loudnessDetector);

  const teardown = () => {
    clearInterval(quietTimer);
    audioStream.off("data", onData);
    try { opusDecoderForLoudness.unpipe(loudnessDetector); } catch { }
    try { audioStream.unpipe(opusDecoderForLoudness); } catch { }
    try { loudnessDetector.destroy(); } catch { }
    try { opusDecoderForLoudness.destroy(); } catch { }
  };

  return { loudnessDetector, opusDecoderForLoudness, quietTimer, teardown };
};

/************************************************************************************************
 * MOD HELPERS (RANK CHECKS & TARGET SELECTION)
 ************************************************************************************************/
function isModerator(member, settings) {
  if (!member) return false;
  // Admin perms always count
  if (member.permissions?.has?.(PermissionsBitField.Flags.Administrator)) return true;

  // Role-based flags
  const modRoles = [
    settings.vcModeratorRoleId,
    settings.moderatorRoleId,
    settings.adminRoleId,
  ].filter(Boolean);

  return member.roles?.cache?.some?.((r) => modRoles.includes(r.id)) || false;
}

function channelCounts(channel, settings) {
  let humans = 0;
  let mods = 0;
  channel.members?.forEach((m) => {
    if (m.user.bot) return;
    humans += 1;
    if (isModerator(m, settings)) mods += 1;
  });
  return { humans, mods };
}

function findBestAlternateChannelForAutoRoute(guild, settings, excludeChannelId) {
  const safe = new Set(settings.safeChannels || []);
  let best = null;
  let bestCount = -1;

  guild.channels.cache
    .filter((c) => c.type === ChannelType.GuildVoice)
    .forEach((ch) => {
      if (safe.has(ch.id)) return;                   // never go to SAFE
      if (ch.id === excludeChannelId) return;        // not the current channel
      const { humans, mods } = channelCounts(ch, settings);
      const nonModHumans = humans - mods;

      // Destination must have no mods, and at least 2 non-mod humans
      if (mods === 0 && nonModHumans >= AUTO_ROUTE_MIN_OTHER_HUMANS) {
        if (nonModHumans > bestCount) {
          best = ch;
          bestCount = nonModHumans;
        }
      }
    });

  return best; // may be null
}

async function maybeAutoRouteOnModJoin(guild, client, joiningMember) {
  const settings = (await getSettingsForGuild(guild.id).catch(() => null)) || {};
  if (!settings.mod_auto_route_enabled) return false;

  const connection = getVoiceConnection(guild.id);
  if (!connection || connection.state?.status !== VoiceConnectionStatus.Ready) return false;

  const currentChannelId = connection.joinConfig.channelId;
  const currentChannel = guild.channels.cache.get(currentChannelId);
  if (!currentChannel) return false;

  // Don't do anything if the bot is (somehow) in a SAFE channel
  if (Array.isArray(settings.safeChannels) && settings.safeChannels.includes(currentChannelId)) {
    return false;
  }

  // Only trigger if the mod joined the SAME channel the bot is in
  const memberChannelId = joiningMember?.voice?.channelId;
  if (!memberChannelId || memberChannelId !== currentChannelId) return false;

  // Confirm the joining member is a moderator
  if (!isModerator(joiningMember, settings)) return false;

  // Find a valid destination. Must be non-safe, contain >=2 non-mod humans, and contain NO moderators.
  const dest = findBestAlternateChannelForAutoRoute(guild, settings, currentChannelId);
  if (!dest) {
    console.log("[MOD-AUTO-ROUTE] No suitable destination (needs ≥2 non-mod humans & no mods). Staying put.");
    return false;
  }

  console.log(`[MOD-AUTO-ROUTE] Moderator joined current VC. Moving to: ${dest.name}`);
  await moveToChannel(dest, connection, guild, client);
  return true;
}

/************************************************************************************************
 * Detect user activity changes (logs)
 ************************************************************************************************/
async function detectUserActivityChanges(oldState, newState) {
  const guild = newState.guild;
  const member = newState.member;
  if (!guild || !member || !member.user) {
    console.warn("[VOICE] Skipping activity change: missing member or user object");
    return;
  }

  // Fetch settings for logging channel
  const settings = await getSettingsForGuild(guild.id);
  if (!settings.vcLoggingEnabled || !settings.vcLoggingChannelId) return;

  const activityChannel = guild.channels.cache.get(settings.vcLoggingChannelId);
  if (!activityChannel) {
    console.error(
      `[ERROR] Activity logging channel ${settings.vcLoggingChannelId} not found.`
    );
    return;
  }

  // Prepare member info
  const topRole = member.roles.highest?.name || "No Role";
  const username = member.user.username;
  const userId = member.user.id;

  // ANSI color codes
  const ansi = {
    darkGray: "\u001b[2;30m",
    white: "\u001b[2;37m",
    red: "\u001b[2;31m",
    yellow: "\u001b[2;33m",
    cyan: "\u001b[2;36m",
    reset: "\u001b[0m",
  };

  // Determine role color
  let roleColor = ansi.white;
  if (guild.ownerId === userId) {
    roleColor = ansi.red;
  } else if (member.permissions.has("Administrator")) {
    roleColor = ansi.cyan;
  } else if (
    member.permissions.has("ManageGuild") ||
    member.permissions.has("KickMembers") ||
    member.permissions.has("MuteMembers") ||
    member.permissions.has("BanMembers") ||
    member.permissions.has("ManageMessages")
  ) {
    roleColor = ansi.yellow;
  }

  // Timestamp in MM:SS format
  const now = new Date();
  const minute = now.getMinutes().toString().padStart(2, "0");
  const second = now.getSeconds().toString().padStart(2, "0");
  const timestamp = `${minute}:${second}`;

  // Helper to build an ANSI-formatted code block log
  const buildLog = (msg) => {
    return `\`\`\`ansi\n${ansi.darkGray}[${ansi.white}${timestamp}${ansi.darkGray}] ${msg}${ansi.reset}\n\`\`\``;
  };

  // 1) Forced disconnect (VC kick)
  if (oldState.channelId && !newState.channelId) {
    let forciblyDisconnected = false;
    let executor = "Unknown";
    try {
      const fetchedLogs = await guild.fetchAuditLogs({
        limit: 1,
        type: AuditLogEvent.GuildMemberDisconnect,
      });
      const auditEntry = fetchedLogs.entries.first();
      if (
        auditEntry?.target?.id === userId &&
        Date.now() - auditEntry.createdTimestamp < 5000
      ) {
        forciblyDisconnected = true;
        executor = auditEntry.executor?.tag ?? "Unknown";
      }
    } catch (error) {
      console.error("[AUDIT LOG ERROR]", error);
    }
    if (forciblyDisconnected) {
      const logMsg = `[${roleColor}${topRole}${ansi.darkGray}] [${ansi.white}${userId}${ansi.darkGray}] ${roleColor}${username}${ansi.darkGray} was disconnected by ${ansi.white}${executor}${ansi.darkGray}.`;
      await activityChannel.send(buildLog(logMsg)).catch(console.error);
    }
  }

  // 2) Server mute/unmute
  if (oldState.serverMute !== newState.serverMute) {
    const action = newState.serverMute ? "was server muted" : "was server unmuted";
    let executor = "Unknown";
    try {
      const fetchedLogs = await guild.fetchAuditLogs({
        limit: 1,
        type: AuditLogEvent.MemberUpdate,
      });
      const auditEntry = fetchedLogs.entries.find(
        (entry) =>
          entry.target?.id === userId &&
          entry.changes?.some((change) => change.key === "mute")
      );
      if (auditEntry) {
        executor = auditEntry.executor?.tag ?? "Unknown";
      }
    } catch (error) {
      console.error("[AUDIT LOG ERROR]", error);
    }
    if (!newState.serverMute && executor === "Unknown") return;
    const logMsg = `[${roleColor}${topRole}${ansi.darkGray}] [${ansi.white}${userId}${ansi.darkGray}] ${roleColor}${username}${ansi.darkGray} ${action} by ${ansi.white}${executor}${ansi.darkGray}.`;
    await activityChannel.send(buildLog(logMsg)).catch(console.error);
  }

  // 3) Server deafen/undeafen
  if (oldState.serverDeaf !== newState.serverDeaf) {
    const action = newState.serverDeaf ? "was server deafened" : "was server undeafened";
    let executor = "Unknown";
    try {
      const fetchedLogs = await guild.fetchAuditLogs({
        limit: 1,
        type: AuditLogEvent.MemberUpdate,
      });
      const auditEntry = fetchedLogs.entries.find(
        (entry) =>
          entry.target?.id === userId &&
          entry.changes?.some((change) => change.key === "deaf")
      );
      if (auditEntry) {
        executor = auditEntry.executor?.tag ?? "Unknown";
      }
    } catch (error) {
      console.error("[AUDIT LOG ERROR]", error);
    }
    if (!newState.serverDeaf && executor === "Unknown") return;
    const logMsg = `[${roleColor}${topRole}${ansi.darkGray}] [${ansi.white}${userId}${ansi.darkGray}] ${roleColor}${username}${ansi.darkGray} ${action} by ${ansi.white}${executor}${ansi.darkGray}.`;
    await activityChannel.send(buildLog(logMsg)).catch(console.error);
  }

  // 4) Self mute/unmute
  if (oldState.selfMute !== newState.selfMute) {
    const action = newState.selfMute ? "self-muted" : "self-unmuted";
    const logMsg = `[${roleColor}${topRole}${ansi.darkGray}] [${ansi.white}${userId}${ansi.darkGray}] ${roleColor}${username}${ansi.darkGray} ${action}.`;
    await activityChannel.send(buildLog(logMsg)).catch(console.error);
  }

  // 5) Self deafen/undeafen
  if (oldState.selfDeaf !== newState.selfDeaf) {
    const action = newState.selfDeaf ? "self-deafened" : "self-undeafened";
    const logMsg = `[${roleColor}${topRole}${ansi.darkGray}] [${ansi.white}${userId}${ansi.darkGray}] ${roleColor}${username}${ansi.darkGray} ${action}.`;
    await activityChannel.send(buildLog(logMsg)).catch(console.error);
  }

  // 6) Screen share start/stop
  if (oldState.streaming !== newState.streaming) {
    const action = newState.streaming ? "started screen sharing" : "stopped screen sharing";
    const logMsg = `[${roleColor}${topRole}${ansi.darkGray}] [${ansi.white}${userId}${ansi.darkGray}] ${roleColor}${username}${ansi.darkGray} ${action}.`;
    await activityChannel.send(buildLog(logMsg)).catch(console.error);
  }
}

/************************************************************************************************
 * DISCONNECTING FLAG
 ************************************************************************************************/
let isDisconnecting = false;

/************************************************************************************************
 * IDLE LINGER HELPERS
 ************************************************************************************************/
function clearIdleTimer(guildId) {
  const t = idleDisconnectTimers.get(guildId);
  if (t) {
    clearTimeout(t);
    idleDisconnectTimers.delete(guildId);
  }
}

async function scheduleIdleDisconnect(guild, connection, note = "idle") {
  if (idleDisconnectTimers.has(guild.id)) return; // already scheduled
  console.log(`[AUTO-VC] Scheduling idle disconnect in ${IDLE_LINGER_MS}ms (${note}).`);

  const timeout = setTimeout(async () => {
    idleDisconnectTimers.delete(guild.id);

    try {
      const settings = (await getSettingsForGuild(guild.id).catch(() => null)) || {};
      const safe = new Set(settings.safeChannels || []);
      const currentChannelId = connection.joinConfig.channelId;
      const currentChannel = guild.channels.cache.get(currentChannelId);
      const currentHumans = currentChannel?.members?.filter((m) => !m.user.bot).size ?? 0;

      // Look for any better non-safe target
      const voiceChannels = guild.channels.cache.filter((c) => c.type === ChannelType.GuildVoice);
      let targetChannel = null;
      let maxHumans = 0;
      voiceChannels.forEach((ch) => {
        if (safe.has(ch.id)) return;
        const nonBot = ch.members.filter((m) => !m.user.bot).size;
        if (nonBot > maxHumans) {
          maxHumans = nonBot;
          targetChannel = ch;
        }
      });

      if (currentHumans > 0) {
        console.log("[AUTO-VC] Idle timer fired but channel is no longer empty; keeping connection.");
        return;
      }

      if (targetChannel && maxHumans > 0 && targetChannel.id !== currentChannelId) {
        console.log(`[AUTO-VC] Idle timer move → ${targetChannel.name} (humans: ${maxHumans})`);
        await moveToChannel(targetChannel, connection, guild);
      } else if (!isDisconnecting) {
        console.log("[AUTO-VC] Idle timer disconnect (still alone, no viable non-safe targets).");
        await disconnectAndReset(connection);
      }
    } catch (e) {
      console.warn(`[AUTO-VC] Idle timer errored: ${e?.message || e}`);
    }
  }, IDLE_LINGER_MS);

  idleDisconnectTimers.set(guild.id, timeout);
}

/************************************************************************************************
 * DISCORD VOICE CHANNEL HANDLERS
 ************************************************************************************************/
async function execute(oldState, newState, client) {
  if (newState?.member?.user?.bot) return;

  // Detect mute/deafen changes safely (never crash the handler)
  try {
    await detectUserActivityChanges(oldState, newState);
  } catch (e) {
    console.warn("[VOICE] detectUserActivityChanges failed:", e?.message || e);
  }

  if (!newState?.guild) {
    console.error("[ERROR] Guild object is missing.");
    return;
  }

  const guild = newState.guild;
  const userId = newState?.member?.id;
  if (!userId) {
    console.error("[ERROR] Failed to retrieve user ID from newState.");
    return;
  }
  console.log(`[DEBUG] Checking voice state update for user: ${userId}`);

  // Treat missing/failed settings fetch as {}
  const settings = (await getSettingsForGuild(guild.id).catch(() => null)) || {};

  // ANSI codes for logs
  const ansi = {
    darkGray: "\u001b[2;30m",
    white: "\u001b[2;37m",
    red: "\u001b[2;31m",
    yellow: "\u001b[2;33m",
    cyan: "\u001b[2;36m",
    reset: "\u001b[0m",
  };

  // Get member details for logs
  let member = newState.member || guild.members.cache.get(userId);
  const topRole = member?.roles.highest?.name || "No Role";
  const username = member?.user?.username || "Unknown";
  let roleColor = ansi.white;
  if (guild.ownerId === userId) {
    roleColor = ansi.red;
  } else if (member && member.permissions?.has("Administrator")) {
    roleColor = ansi.cyan;
  } else if (
    member &&
    (member.permissions.has("ManageGuild") ||
      member.permissions.has("KickMembers") ||
      member.permissions.has("MuteMembers") ||
      member.permissions.has("BanMembers") ||
      member.permissions.has("ManageMessages"))
  ) {
    roleColor = ansi.yellow;
  }

  // Helper: Build an ANSI-formatted log message
  const buildLog = (timestamp, msg) =>
    `\`\`\`ansi\n${ansi.darkGray}[${ansi.white}${timestamp}${ansi.darkGray}] ${msg}${ansi.reset}\n\`\`\``;

  // ───────────────────────────────────────────────────────────────────────────
  // Case 1: User moved channels
  // ───────────────────────────────────────────────────────────────────────────
  if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
    console.log(`[DEBUG] User ${userId} moved from ${oldState.channelId} to ${newState.channelId}`);

    if (settings.vcLoggingEnabled && settings.vcLoggingChannelId) {
      const activityChannel = guild.channels.cache.get(settings.vcLoggingChannelId);
      if (activityChannel) {
        const oldChannel = guild.channels.cache.get(oldState.channelId);
        const newChannel = guild.channels.cache.get(newState.channelId);
        const oldChannelName = oldChannel?.name || "Unknown Channel";
        const newChannelName = newChannel?.name || "Unknown Channel";
        const memberCount = newChannel?.members?.filter((m) => !m.user.bot).size ?? 0;
        const timestamp = new Date().toLocaleTimeString("en-US", { minute: "2-digit", second: "2-digit" });
        const logMsg =
          `[${roleColor}${topRole}${ansi.darkGray}] [${ansi.white}${userId}${ansi.darkGray}] ` +
          `${roleColor}${username}${ansi.darkGray} moved from ${ansi.white}${oldChannelName}${ansi.darkGray} ` +
          `to ${ansi.white}${newChannelName}${ansi.darkGray}. Member count: ${memberCount}`;
        await activityChannel.send(buildLog(timestamp, logMsg)).catch(console.error);
      } else {
        console.error(`[ERROR] Activity logging channel ${settings.vcLoggingChannelId} not found.`);
      }
    }

    // If destination is SAFE, do nothing at all (no disconnect, no re-manage).
    const isDestSafe =
      Array.isArray(settings.safeChannels) && settings.safeChannels.includes(newState.channelId);
    if (isDestSafe) {
      console.log("[VC] Move into SAFE channel detected; skipping VC management.");
      return;
    }

    // ▶️ Mod auto-route: if a moderator moved INTO the bot's current VC, try to route away
    try {
      const moved = await maybeAutoRouteOnModJoin(guild, client, newState.member);
      if (moved) return; // already handled
    } catch (e) {
      console.warn(`[MOD-AUTO-ROUTE] move handler errored: ${e?.message || e}`);
    }

    // Otherwise let the manager decide (may move/join/leave appropriately)
    await manageVoiceChannels(guild, client);
    return;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Case 2: User joined a channel
  // ───────────────────────────────────────────────────────────────────────────
  if (!oldState.channelId && newState.channelId) {
    console.log(`[DEBUG] User ${userId} joined channel: ${newState.channelId}`);
    userJoinTimes.set(userId, Date.now());

    // ▶️ Mod auto-route: if a moderator joined the bot's current VC, try to route away *before* general management
    try {
      const moved = await maybeAutoRouteOnModJoin(guild, client, newState.member);
      if (moved) return; // handled, don't run generic manager
    } catch (e) {
      console.warn(`[MOD-AUTO-ROUTE] join handler errored: ${e?.message || e}`);
    }

    // If the join was into a SAFE channel, don't re-manage right now.
    const settings2 = (await getSettingsForGuild(guild.id).catch(() => null)) || {};
    if (Array.isArray(settings2.safeChannels) && settings2.safeChannels.includes(newState.channelId)) {
      console.log("[VC] User joined SAFE channel; not re-managing voice connections.");
    } else {
      // Let the manager pick the best place (may join a non-safe with humans)
      await manageVoiceChannels(guild, client);
    }

    // If we ended up connected, wire listeners; otherwise bail quietly.
    let connection = getVoiceConnection(guild.id);
    if (connection) {
      audioListeningFunctions(connection, guild);
    }

    // ─────────────────────────────────────────────
    // Consent enforcement (existing flow, kept intact)
    // ─────────────────────────────────────────────
    function describeConsentDest(dest, user) {
      if (!dest || (!dest.channel && !dest.preferDM)) return "no available destination";
      if (dest.preferDM) {
        if (dest.channel) return `DM first → fallback <#${dest.channel.id}>`;
        return "DM first (no public fallback available)";
      }
      if (dest.channel) return `<#${dest.channel.id}>`;
      return "no available destination";
    }

    const hasConsent = await hasUserConsented(userId);
    if (hasConsent) {
      console.log(`[INFO] User ${userId} has already consented. Allowing audio capture.`);
      try {
        if (newState.serverMute) {
          await newState.setMute(false, "User has consented to transcription.");
          console.log(`[INFO] User ${userId} unmuted.`);
        }
      } catch (err) {
        console.error(`[ERROR] Failed to unmute user ${userId}: ${err.message}`);
      }
    } else {
      console.log(`[DEBUG] User ${userId} has NOT consented. Sending consent request...`);

      const consentButtons = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`consent:grant:${userId}`)
          .setLabel("Consent")
          .setStyle(ButtonStyle.Success)
      );

      interactionContexts.set(userId, { guildId: guild.id, mode: "consent" });

      try {
        const previewDest = await resolveConsentDestination(guild, newState.member.user);
        console.log(
          `[CONSENT ROUTER] Target for ${userId}: ${describeConsentDest(previewDest, newState.member.user)}`
        );
      } catch (e) {
        console.warn(`[CONSENT ROUTER] Preview failed for ${userId}: ${e.message}`);
      }

      const freshSettings = await getSettingsForGuild(guild.id);
      const member = newState.member;
      const dest = await resolveConsentDestination(guild, member, freshSettings);

      await sendConsentPrompt({
        guild,
        user: member.user,
        member,
        client,
        settings: freshSettings,
        destination: dest,
        content:
          `# Consent Required\nInside this voice call, your voice will be transcribed into text.\n` +
          `Please click the button below to consent.\n\n` +
          `> All audio files of your voice are temporary and will not be permanently saved.\n` +
          `-# > You can also take a look at our [privacy policy](<https://www.vctools.app/privacy>) for more information.`,
        components: [consentButtons],
        mentionUserInChannel: true,
      });

      try {
        await newState.setMute(true, "Awaiting transcription consent.");
        console.log(`[INFO] User ${userId} muted until consent is given.`);
      } catch (err) {
        console.error(`[ERROR] Failed to mute user ${userId}: ${err.message}`);
      }
    }
    return;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Case 3: User left a channel
  // ───────────────────────────────────────────────────────────────────────────
  if (oldState.channelId && !newState.channelId) {
    console.log(`[DEBUG] User ${userId} left channel: ${oldState.channelId}`);

    const startMs = userJoinTimes.get(userId) || Date.now();
    const durationSec = Math.floor((Date.now() - startMs) / 1000);
    userJoinTimes.delete(userId);

    const { data, error } = await supabase
      .from("voice_activity")
      .insert([{ guild_id: guild.id, user_id: userId, duration: durationSec }], {
        returning: "minimal",
      });

    if (error) {
      console.error("[Heatmap] Supabase insert failed:", error.message, error.details);
    } else {
      console.log("[Heatmap] Insert succeeded:", data);
    }

    if (settings.vcLoggingEnabled && settings.vcLoggingChannelId) {
      const activityChannel = guild.channels.cache.get(settings.vcLoggingChannelId);
      if (activityChannel) {
        const leftChannel = guild.channels.cache.get(oldState.channelId);
        const leftChannelName = leftChannel?.name || "Unknown Channel";
        const memberCount = leftChannel.members.filter((m) => !m.user.bot).size;
        const timestamp = new Date().toLocaleTimeString("en-US", {
          minute: "2-digit",
          second: "2-digit",
        });
        const logMsg =
          `[${roleColor}${topRole}${ansi.darkGray}] [${ansi.white}${userId}${ansi.darkGray}] ` +
          `${roleColor}${username}${ansi.darkGray} left voice channel ${ansi.white}${leftChannelName}${ansi.darkGray}. ` +
          `Member count: ${memberCount}`;
        await activityChannel.send(buildLog(timestamp, logMsg)).catch(console.error);
      } else {
        console.error(
          `[ERROR] Activity logging channel ${settings.vcLoggingChannelId} not found.`
        );
      }
    }

    // Re-evaluate where the bot should be (no unconditional disconnect; linger applies)
    await manageVoiceChannels(guild, client);
    return;
  }
}

/************************************************************************************************
 * MANAGE VOICE CHANNELS & MOVES
 ************************************************************************************************/
async function manageVoiceChannels(guild, client) {
  const ansi = { darkGray: "\u001b[2;30m", white: "\u001b[2;37m", reset: "\u001b[0m" };

  // Load settings and compute safe set
  const settings = (await getSettingsForGuild(guild.id).catch(() => null)) || {};
  const safe = new Set(settings.safeChannels || []);

  // Pick the busiest NON-SAFE channel with humans
  const voiceChannels = guild.channels.cache.filter((c) => c.type === ChannelType.GuildVoice);
  let targetChannel = null;
  let maxHumans = 0;
  voiceChannels.forEach((channel) => {
    if (safe.has(channel.id)) return;
    const nonBotMembers = channel.members.filter((m) => !m.user.bot).size;
    if (nonBotMembers > maxHumans) {
      maxHumans = nonBotMembers;
      targetChannel = channel;
    }
  });

  const connection = getVoiceConnection(guild.id);
  const currentChannel = connection
    ? guild.channels.cache.get(connection.joinConfig.channelId)
    : null;

  // If NOT connected: join the best non-safe active channel (if any)
  if (!currentChannel) {
    clearIdleTimer(guild.id);
    if (targetChannel && maxHumans > 0) {
      console.log(`[AUTO-VC] Joining ${targetChannel.name} (humans: ${maxHumans})`);
      const newConn = await joinChannel(client, targetChannel.id, guild);
      if (newConn) audioListeningFunctions(newConn, guild);
    }
    return;
  }

  const currentIsSafe = safe.has(currentChannel.id);
  const currentHumans = currentChannel.members.filter((m) => !m.user.bot).size;

  // If we somehow ended up in a SAFE channel: move to a non-safe active one, else disconnect
  if (currentIsSafe) {
    clearIdleTimer(guild.id);
    if (targetChannel && maxHumans > 0) {
      const now = new Date().toLocaleTimeString("en-US", { minute: "2-digit", second: "2-digit" });
      console.log(`${ansi.darkGray}[${ansi.white}${now}${ansi.darkGray}] Moving out of SAFE → ${ansi.white}${targetChannel.name}${ansi.reset}`);
      await moveToChannel(targetChannel, connection, guild, client);
    } else if (!isDisconnecting) {
      await disconnectAndReset(connection);
    }
    return;
  }

  // If bot is alone in a non-safe channel...
  if (currentHumans === 0) {
    // Prefer moving to a busier non-safe channel if it exists
    if (targetChannel && maxHumans > 0 && targetChannel.id !== currentChannel.id) {
      clearIdleTimer(guild.id);
      const now = new Date().toLocaleTimeString("en-US", { minute: "2-digit", second: "2-digit" });
      console.log(`${ansi.darkGray}[${ansi.white}${now}${ansi.darkGray}] Alone; moving to: ${ansi.white}${targetChannel.name}${ansi.reset}`);
      await moveToChannel(targetChannel, connection, guild, client);
    } else {
      // No better place: LINGER instead of instant disconnect
      scheduleIdleDisconnect(guild, connection, "no-humans-non-safe");
    }
    return;
  }

  // We have humans in current channel; cancel any pending idle disconnect.
  clearIdleTimer(guild.id);

  // If there's a busier non-safe channel, move
  if (targetChannel && targetChannel.id !== currentChannel.id && maxHumans > currentHumans) {
    const now = new Date().toLocaleTimeString("en-US", { minute: "2-digit", second: "2-digit" });
    console.log(`${ansi.darkGray}[${ansi.white}${now}${ansi.darkGray}] Moving to busier VC: ${ansi.white}${targetChannel.name}${ansi.reset}`);
    await moveToChannel(targetChannel, connection, guild, client);
  }
}

async function moveToChannel(targetChannel, connection, guild, client) {
  if (connection) {
    console.log(`[INFO] Leaving and joining: ${targetChannel.name}`);
    await disconnectAndReset(connection);
    const newConnection = await joinChannel(client, targetChannel.id, guild);
    if (newConnection) {
      saveVCState(guild.id, targetChannel.id)
      audioListeningFunctions(newConnection, guild);
    }
  }
}

async function joinChannel(client, channelId, guild) {
  const settings = await getSettingsForGuild(guild.id);

  // Prevent joining if the channel is marked as safe
  if (settings.safeChannels && settings.safeChannels.includes(channelId)) {
    console.log(`[INFO] Channel ${channelId} is in safeChannels. Not joining.`);
    return null;
  }

  const channel = client.channels.cache.get(channelId);
  if (!channel) {
    console.error(`[ERROR] Channel not found: ${channelId}`);
    return null;
  }

  try {
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false, // Ensure this is intentional
    });

    connection.on(VoiceConnectionStatus.Ready, () => {
      console.log(`[INFO] Connected to ${channel.name}`);
      saveVCState(guild.id, channel.id);
      clearIdleTimer(guild.id); // if we had a pending idle timer, cancel it now that we're active
    });

    return connection;
  } catch (error) {
    console.error(`[ERROR] Can't connect to ${channel.name}: ${error.message}`);
    return null;
  }
}

async function disconnectAndReset(connection) {
  if (!isDisconnecting) {
    isDisconnecting = true;
    try {
      const guildId = connection.joinConfig.guildId;
      clearIdleTimer(guildId); // ✅ cancel any pending idle disconnect
      clearVCState(guildId);   // ✅ Wipe state
      connection.destroy();
      console.log(`[INFO] Disconnected from VC in guild ${guildId}`);
    } catch (error) {
      console.error(`[ERROR] During disconnect: ${error.message}`);
    } finally {
      isDisconnecting = false;
    }
  }
}

/************************************************************************************************
 * AUDIO LISTENING FUNCTIONS
 ************************************************************************************************/
function audioListeningFunctions(connection, guild) {
  const receiver = connection.receiver;
  if (receiver.isListening) return;
  receiver.isListening = true;

  const currentlySpeaking = new Set();        // users currently talking
  const userLastSpokeTime = {};               // epoch ms of last packet
  const perUserSilenceTimer = {};             // timeout IDs keyed by user

  function stopUserPipeline(userId) {
    const p = pipelines.get(userId);
    if (p) {
      const { audioStream, decoder, pcmWriter, loudnessRes } = p;

      // disconnect the pipeline first
      try { audioStream?.unpipe?.(decoder); } catch (_) { }
      try { decoder?.unpipe?.(pcmWriter); } catch (_) { }

      // tear down loudness branch if present
      try { loudnessRes?.teardown?.(); } catch (_) { }

      // kill upstream so nothing else writes
      try { audioStream?.destroy?.(); } catch (_) { }
      try { decoder?.destroy?.(); } catch (_) { }

      // end the writer exactly once
      if (pcmWriter && !pcmWriter.closed) {
        try { pcmWriter.end(); } catch (_) { }
      }

      pipelines.delete(userId);
    }

    // clean your old registries too
    if (userSubscriptions[userId]) {
      try { userSubscriptions[userId].destroy?.(); } catch (_) { }
      delete userSubscriptions[userId];
    }

    if (outputStreams[userId] && !outputStreams[userId].closed) {
      // usually already closed above, but guard anyway
      try { outputStreams[userId].end(); } catch (_) { }
    }
    delete outputStreams[userId];
  }

  /* ───────────────────────── START / STOP HANDLERS ───────────────────────── */

  receiver.speaking.setMaxListeners(100);
  receiver.speaking.on("start", async (userId) => {
    if (currentlySpeaking.has(userId)) return;

    const settings = await getSettingsForGuild(guild.id);
    if (!settings.transcriptionEnabled) return;
    if (settings.safeUsers?.includes(userId)) return;
    const member = guild.members.cache.get(userId);
    const chanId = member?.voice?.channel?.id;
    if (settings.safeChannels?.includes(chanId)) return;
    if (!(await hasUserConsented(userId))) return;

    const unique = `${Date.now()}-${Math.floor(Math.random() * 1e3)}`;
    userAudioIds[userId] = unique;
    currentlySpeaking.add(userId);
    userLastSpokeTime[userId] = Date.now();

    if (perUserSilenceTimer[userId]) {
      clearTimeout(perUserSilenceTimer[userId]);
      delete perUserSilenceTimer[userId];
    }

    console.log(`[DEBUG] START for ${userId}`);
    const audioStream = receiver.subscribe(userId, { end: { behavior: "manual" } });
    userSubscriptions[userId] = audioStream;

    // Loudness detector (returns teardown handles)
    const loudnessRes = await initiateLoudnessWarning(userId, audioStream, guild, () => {
      userLastSpokeTime[userId] = Date.now();
    });

    // Write decoded PCM to file
    const pcmPath = path.join(__dirname, "../../temp_audio", `${userId}-${unique}.pcm`);
    fs.mkdirSync(path.dirname(pcmPath), { recursive: true });
    const pcmWriter = fs.createWriteStream(pcmPath, { flags: "w" });
    const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 1, rate: 48000 });
    try {
      audioStream.pipe(decoder).pipe(pcmWriter);
    } catch (err) {
      console.warn(`[PIPE ERROR] ${err.message}`);
    }
    pipelines.set(userId, { audioStream, decoder, pcmWriter, loudnessRes });
    outputStreams[userId] = pcmWriter;

    // Silence-based fallback if stop never fires
    perUserSilenceTimer[userId] = setInterval(() => {
      const silenceDuration = Date.now() - (userLastSpokeTime[userId] || 0);
      const threshold = getAverageSilenceDuration(userId) || DEFAULT_SILENCE_TIMEOUT;

      if (silenceDuration >= threshold) {
        console.warn(`[SILENCE FINALIZE] ${userId} silent for ${silenceDuration}ms (threshold: ${threshold})`);
        clearInterval(perUserSilenceTimer[userId]);
        delete perUserSilenceTimer[userId];

        if (currentlySpeaking.has(userId)) {
          currentlySpeaking.delete(userId);
          stopUserPipeline(userId);
          finalizeUserAudio(userId, guild, unique, chanId);
        }
      }
    }, 1000);
  });

  receiver.speaking.on("stop", (userId) => {
    console.log(`[DEBUG] STOP triggered for ${userId}`);
    if (!currentlySpeaking.has(userId)) return;
    currentlySpeaking.delete(userId);

    stopUserPipeline(userId);

    const member = guild.members.cache.get(userId);
    const chanId = member?.voice?.channel?.id || null;
    const unique = userAudioIds[userId];
    if (!unique) return;                             // never recorded

    /* schedule finalisation after GRACE_PERIOD_MS of silence */
    const wait = GRACE_PERIOD_MS - (Date.now() - (userLastSpokeTime[userId] || 0));
    perUserSilenceTimer[userId] = setTimeout(() => {
      if (!currentlySpeaking.has(userId)) {
        finalizeUserAudio(userId, guild, unique, chanId);
      }
      clearTimeout(perUserSilenceTimer[userId]);
      delete perUserSilenceTimer[userId];
    }, wait > 0 ? wait : 0);
  });

  connection.once(VoiceConnectionStatus.Disconnected, () => {
    receiver.speaking.removeAllListeners();
    receiver.isListening = false;
    Object.values(perUserSilenceTimer).forEach((t) => { try { clearInterval(t); } catch { } });
  });

  /* ───────────────────────── FINALISE & TRANSCRIBE ───────────────────────── */

  async function finalizeUserAudio(userId, guild, unique, channelId) {
    const key = `${userId}-${unique}`;
    if (finalizingKeys.has(key)) return;
    finalizingKeys.add(key);

    const base = path.join(__dirname, "../../temp_audio", `${userId}-${unique}`);
    const pcm = `${base}.pcm`;
    const wav = `${base}.wav`;

    // 1. Make sure the writer is fully closed
    const writer = outputStreams[userId];
    if (writer && !writer.closed) {
      await new Promise((resolve) => {
        writer.once("close", resolve);
        writer.end();          // triggers 'finish' ➜ 'close'
      }).catch(() => { /* ignore */ });
    }

    // Also await the decoder flush if it still exists
    const pipeObj = pipelines.get(userId);
    if (pipeObj?.decoder) {
      try { await finished(pipeObj.decoder); } catch (_) { /* ignore */ }
    }

    try {
      // 2. Skip tiny/incomplete files
      if (!fs.existsSync(pcm) || fs.statSync(pcm).size < 2048) {
        await transcription.safeDeleteFile(pcm);
        cleanup(userId);
        return;
      }

      // 3. Convert ➜ Transcribe ➜ Post
      await convertOpusToWav(pcm, wav);
      const text = await transcribeAudio(wav);
      if (text) await postTranscription(guild, userId, text, channelId);
    } catch (err) {
      console.error(`[FINALIZE] user=${userId} ➜ ${err.message}`);
    } finally {
      // 4. Remove temp files
      await transcription.safeDeleteFile(pcm);
      await transcription.safeDeleteFile(wav);
      cleanup(userId);
      finalizingKeys.delete(key);
    }
  }

  /* ───────────────────────── HELPER: CLEANUP ───────────────────────── */
  function cleanup(userId) {
    // Clean up the output file stream safely
    if (outputStreams[userId]) {
      const writer = outputStreams[userId];

      // Unpipe anything still connected to the stream if possible
      try {
        if (!writer.destroyed) {
          writer.end(); // allow graceful finish of any buffered writes
        }
      } catch (e) {
        console.warn(`[CLEANUP] Error ending stream for ${userId}: ${e.message}`);
      }

      // Always attach error handler to suppress future uncaughts
      writer.on("error", (err) => {
        console.warn(`[PCM WRITER ERROR] ${err.message}`);
      });

      // Finally destroy and clean
      try {
        writer.destroy();
      } catch (e) {
        console.warn(`[CLEANUP] Error destroying stream for ${userId}: ${e.message}`);
      }

      delete outputStreams[userId];
    }

    // Clean up userSubscriptions if they exist
    if (userSubscriptions[userId]) {
      try {
        userSubscriptions[userId].destroy?.(); // in case it's a stream
      } catch (e) {
        console.warn(`[CLEANUP] Error cleaning subscription for ${userId}: ${e.message}`);
      }
      delete userSubscriptions[userId];
    }

    // Clean up tracking ID
    delete userAudioIds[userId];
  }

}

// ─────────────────────────────────────────────────────────────────────────────
// Periodic VC auto-rejoin (every 15s)
// ─────────────────────────────────────────────────────────────────────────────
let vcAutoCheckInterval = null;
const vcProbeRunning = new Set();

/**
 * Starts a periodic check that ensures the bot is in *some* active VC:
 * - If connected: calls manageVoiceChannels() to move to the busiest room.
 * - If NOT connected: finds a non-safe channel with non-bot members and joins it.
 *
 * @param {import('discord.js').Client} client
 * @param {number} intervalMs default 15000
 */
function startPeriodicVCCheck(client, intervalMs = 15000) {
  if (vcAutoCheckInterval) clearInterval(vcAutoCheckInterval);

  vcAutoCheckInterval = setInterval(() => {
    client.guilds.cache.forEach(async (guild) => {
      if (vcProbeRunning.has(guild.id)) return;
      vcProbeRunning.add(guild.id);

      try {
        const connection = getVoiceConnection(guild.id);

        // If we have a connection, let the existing logic optimize/move/disconnect if alone.
        if (connection && connection.state?.status === VoiceConnectionStatus.Ready) {
          await manageVoiceChannels(guild, client);
          return;
        }

        // No connection or not ready: try to find a viable channel with people.
        const settings = (await getSettingsForGuild(guild.id).catch(() => null)) || {};
        const safe = new Set(settings.safeChannels || []);

        const voiceChannels = guild.channels.cache.filter(c => c.type === ChannelType.GuildVoice);
        let target = null;
        let maxNonBot = 0;

        voiceChannels.forEach((ch) => {
          if (safe.has(ch.id)) return; // respect safeChannels
          const nonBotCount = ch.members.filter(m => !m.user.bot).size;
          if (nonBotCount > maxNonBot) {
            maxNonBot = nonBotCount;
            target = ch;
          }
        });

        // Only (re)join if there's at least one human in the target channel.
        if (target && maxNonBot > 0) {
          console.log(`[AUTO-VC] Attempting (re)join → ${target.name} (humans: ${maxNonBot})`);
          const newConn = await joinChannel(client, target.id, guild);
          if (newConn) {
            audioListeningFunctions(newConn, guild);
          }
        }
      } catch (e) {
        console.warn(`[AUTO-VC] Guild ${guild.id} probe failed: ${e?.message || e}`);
      } finally {
        vcProbeRunning.delete(guild.id);
      }
    });
  }, intervalMs);

  console.log(`[AUTO-VC] Periodic check started (every ${intervalMs}ms).`);
}

module.exports = {
  execute,
  joinChannel,
  audioListeningFunctions,
  startPeriodicVCCheck,
};