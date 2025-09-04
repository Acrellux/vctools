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
const { finished } = require("stream/promises");
const prism = require("prism-media");
const transcription = require("./transcription.cjs");
const { interactionContexts } = require("../database/contextStore.cjs");
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
const { createClient } = require("@supabase/supabase-js");
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

const AUTO_ROUTE_MIN_OTHER_HUMANS = 2;

// Move cooldown per guild to prevent thrash
const guildMoveCooldownMs = 1500;
const guildLastMoveAt = new Map(); // guildId -> timestamp

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
  audioStream, // Opus stream
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
    if (now - lastWarning < options.cooldownMs) return;
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
    guild,
    userId,
    warnIfTooLoud,
    options
  );
  const opusDecoderForLoudness = new prism.opus.Decoder({
    frameSize: 960,
    channels: 1,
    rate: 48000,
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
      console.warn(
        `[QUIET FINALIZE] ${userId} silent (low activity) for ${silentDuration}ms`
      );
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
 * MOD HELPERS (PERMISSIONS-ONLY)
 ************************************************************************************************/
const MOD_FLAGS = [
  PermissionsBitField.Flags.Administrator,
  PermissionsBitField.Flags.ManageGuild,
  PermissionsBitField.Flags.ManageMessages,
  PermissionsBitField.Flags.KickMembers,
  PermissionsBitField.Flags.BanMembers,
  PermissionsBitField.Flags.ModerateMembers,
  PermissionsBitField.Flags.MuteMembers,
  PermissionsBitField.Flags.DeafenMembers,
  PermissionsBitField.Flags.MoveMembers,
];

function isModerator(member) {
  if (!member) return false;
  const perms = member.permissions;
  if (!perms?.has) return false;
  for (const f of MOD_FLAGS) {
    if (perms.has(f)) return true;
  }
  return false;
}

function channelCounts(channel) {
  let humans = 0;
  let mods = 0;
  channel?.members?.forEach((m) => {
    if (m.user.bot) return;
    humans += 1;
    if (isModerator(m)) mods += 1;
  });
  return { humans, mods };
}

function channelHasMod(channel) {
  if (!channel) return false;
  const { mods } = channelCounts(channel);
  return mods > 0;
}

/************************************************************************************************
 * Targeting helpers
 ************************************************************************************************/
function findBestUnsupervised2(guild, safe, excludeChannelId = null) {
  let best = null;
  let bestCount = -1;
  guild.channels.cache
    .filter((c) => c.type === ChannelType.GuildVoice)
    .forEach((ch) => {
      if (safe.has(ch.id)) return;
      if (excludeChannelId && ch.id === excludeChannelId) return;
      const { humans, mods } = channelCounts(ch);
      if (mods === 0 && humans >= AUTO_ROUTE_MIN_OTHER_HUMANS) {
        if (humans > bestCount) {
          best = ch; bestCount = humans;
        }
      }
    });
  return best; // may be null
}

function findBusiest(guild, safe) {
  let busiest = null;
  let busiestHumans = 0;
  guild.channels.cache
    .filter((c) => c.type === ChannelType.GuildVoice)
    .forEach((ch) => {
      if (safe.has(ch.id)) return;
      const nonBot = ch.members.filter((m) => !m.user.bot).size;
      if (nonBot > busiestHumans) {
        busiestHumans = nonBot;
        busiest = ch;
      }
    });
  return { busiest, busiestHumans };
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

  const settings = await getSettingsForGuild(guild.id);
  if (!settings.vcLoggingEnabled || !settings.vcLoggingChannelId) return;

  const activityChannel = guild.channels.cache.get(settings.vcLoggingChannelId);
  if (!activityChannel) {
    console.error(
      `[ERROR] Activity logging channel ${settings.vcLoggingChannelId} not found.`
    );
    return;
  }

  const topRole = member.roles.highest?.name || "No Role";
  const username = member.user.username;
  const userId = member.user.id;

  const ansi = {
    darkGray: "\u001b[2;30m",
    white: "\u001b[2;37m",
    red: "\u001b[2;31m",
    yellow: "\u001b[2;33m",
    cyan: "\u001b[2;36m",
    reset: "\u001b[0m",
  };

  let roleColor = ansi.white;
  if (guild.ownerId === userId) roleColor = ansi.red;
  else if (member.permissions.has(PermissionsBitField.Flags.Administrator)) roleColor = ansi.cyan;
  else if (
    member.permissions.has(PermissionsBitField.Flags.ManageGuild) ||
    member.permissions.has(PermissionsBitField.Flags.KickMembers) ||
    member.permissions.has(PermissionsBitField.Flags.MuteMembers) ||
    member.permissions.has(PermissionsBitField.Flags.BanMembers) ||
    member.permissions.has(PermissionsBitField.Flags.ManageMessages)
  ) roleColor = ansi.yellow;

  const now = new Date();
  const minute = now.getMinutes().toString().padStart(2, "0");
  const second = now.getSeconds().toString().padStart(2, "0");
  const timestamp = `${minute}:${second}`;
  const buildLog = (msg) =>
    `\`\`\`ansi\n${ansi.darkGray}[${ansi.white}${timestamp}${ansi.darkGray}] ${msg}${ansi.reset}\n\`\`\``;

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
      if (auditEntry) executor = auditEntry.executor?.tag ?? "Unknown";
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
      if (auditEntry) executor = auditEntry.executor?.tag ?? "Unknown";
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
 * DISCORD VOICE CHANNEL HANDLERS
 ************************************************************************************************/
async function execute(oldState, newState, client) {
  if (newState?.member?.user?.bot) return;

  // Activity logs (safe)
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
  const userId = newState?.member?.id || oldState?.member?.id;
  if (!userId) {
    console.error("[ERROR] Failed to retrieve user ID from voice state.");
    return;
  }

  const settings = (await getSettingsForGuild(guild.id).catch(() => null)) || {};
  const safe = new Set(settings.safeChannels || []);

  // Build move context for trading/mod logic
  const actorMember = newState.member || guild.members.cache.get(userId);
  const actorIsMod = isModerator(actorMember);
  const moveContext = {
    actorId: userId,
    actorIsMod,
    originId: oldState?.channelId || null,
    destId: newState?.channelId || null,
  };

  // Always recompute on every relevant event

  // 1) User moved channels
  if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
    console.log(`[DEBUG] User ${userId} moved from ${oldState.channelId} to ${newState.channelId}`);
    if (!safe.has(newState.channelId)) {
      await manageVoiceChannels(guild, client, moveContext);
    }
    return;
  }

  // 2) User joined a channel
  if (!oldState.channelId && newState.channelId) {
    console.log(`[DEBUG] User ${userId} joined channel: ${newState.channelId}`);
    userJoinTimes.set(userId, Date.now());

    if (!safe.has(newState.channelId)) {
      await manageVoiceChannels(guild, client, moveContext);
    }

    let connection = getVoiceConnection(guild.id);
    if (connection) {
      audioListeningFunctions(connection, guild);
    }

    // Consent flow
    const hasConsent = await hasUserConsented(userId);
    if (hasConsent) {
      try {
        if (newState.serverMute) {
          await newState.setMute(false, "User has consented to transcription.");
        }
      } catch (err) {
        console.error(`[ERROR] Failed to unmute user ${userId}: ${err.message}`);
      }
    } else {
      const consentButtons = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`consent:grant:${userId}`)
          .setLabel("Consent")
          .setStyle(ButtonStyle.Success)
      );

      interactionContexts.set(userId, { guildId: guild.id, mode: "consent" });

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
      } catch (err) {
        console.error(`[ERROR] Failed to mute user ${userId}: ${err.message}`);
      }
    }
    return;
  }

  // 3) User left a channel
  if (oldState.channelId && !newState.channelId) {
    console.log(`[DEBUG] User ${userId} left channel: ${oldState.channelId}`);

    const startMs = userJoinTimes.get(userId) || Date.now();
    const durationSec = Math.floor((Date.now() - startMs) / 1000);
    userJoinTimes.delete(userId);

    const { error } = await supabase
      .from("voice_activity")
      .insert([{ guild_id: guild.id, user_id: userId, duration: durationSec }], {
        returning: "minimal",
      });

    if (error) {
      console.error("[Heatmap] Supabase insert failed:", error.message, error.details);
    }

    await manageVoiceChannels(guild, client, moveContext);
    return;
  }
}

/************************************************************************************************
 * MANAGE VOICE CHANNELS & MOVES (core decision engine)
 ************************************************************************************************/
async function manageVoiceChannels(guild, client, moveContext = null) {
  const settings = (await getSettingsForGuild(guild.id).catch(() => null)) || {};
  const featureOn = !!settings.mod_auto_route_enabled;
  const safe = new Set(settings.safeChannels || []);

  const connection = getVoiceConnection(guild.id);
  const currentChannel = connection
    ? guild.channels.cache.get(connection.joinConfig.channelId)
    : null;

  const { busiest, busiestHumans } = findBusiest(guild, safe);
  const bestUnsupervised = findBestUnsupervised2(guild, safe, currentChannel?.id || null);

  // Helper to respect cooldown
  const now = Date.now();
  const last = guildLastMoveAt.get(guild.id) || 0;
  const canMove = now - last >= guildMoveCooldownMs;

  // Helper: viable coverage = no mod & >=2 humans
  const isViableCoverage = (ch) => {
    if (!ch) return false;
    if (safe.has(ch.id)) return false;
    const { humans, mods } = channelCounts(ch);
    return mods === 0 && humans >= AUTO_ROUTE_MIN_OTHER_HUMANS;
  };

  // If feature is OFF, simple behavior
  if (!featureOn) {
    if (!currentChannel) {
      if (busiest && busiestHumans > 0) {
        const newConn = await joinChannel(client, busiest.id, guild);
        if (newConn) audioListeningFunctions(newConn, guild);
      }
      return;
    }

    const currentHumans = currentChannel.members.filter((m) => !m.user.bot).size;
    if (currentHumans === 0) {
      if (busiest && busiestHumans > 0 && busiest.id !== currentChannel.id && canMove) {
        guildLastMoveAt.set(guild.id, now);
        await moveToChannel(busiest, connection, guild, client);
      } else if (!isDisconnecting) {
        await disconnectAndReset(connection, guild, client);
      }
      return;
    }

    if (busiest && busiest.id !== currentChannel.id && busiestHumans > currentHumans && canMove) {
      guildLastMoveAt.set(guild.id, now);
      await moveToChannel(busiest, connection, guild, client);
    }
    return;
  }

  // FEATURE ON: full logic
  // 0) Never sit in SAFE
  if (currentChannel && safe.has(currentChannel.id)) {
    if (bestUnsupervised && canMove) {
      guildLastMoveAt.set(guild.id, now);
      await moveToChannel(bestUnsupervised, connection, guild, client);
      return;
    }
    if (busiest && busiestHumans > 0 && canMove) {
      guildLastMoveAt.set(guild.id, now);
      await moveToChannel(busiest, connection, guild, client);
      return;
    }
    if (!isDisconnecting) {
      await disconnectAndReset(connection, guild, client);
    }
    return;
  }

  // 1) Trade-places on MOD moves (explicit)
  if (currentChannel && moveContext?.actorIsMod && canMove) {
    const origin = moveContext.originId
      ? guild.channels.cache.get(moveContext.originId)
      : null;
    const dest = moveContext.destId
      ? guild.channels.cache.get(moveContext.destId)
      : null;

    // Mod moved INTO our channel → swap to origin if it's valid (no SAFE, no mod, ≥2)
    if (dest && dest.id === currentChannel.id && origin && !safe.has(origin.id)) {
      if (isViableCoverage(origin)) {
        console.log("[ROUTE] Mod entered our room → trading places to origin:", origin.name);
        guildLastMoveAt.set(guild.id, now);
        await moveToChannel(origin, connection, guild, client);
        return;
      }
      // fallthrough to general reroute
    }
    // Mod moved OUT OF our channel → allow general reroute to evaluate
  }

  // 2) General reroute
  if (!currentChannel) {
    // Not connected: join best unsupervised≥2, else biggest (even if mod)
    const bestWhenDisconnected = findBestUnsupervised2(guild, safe, null);
    if (bestWhenDisconnected) {
      const newConn = await joinChannel(client, bestWhenDisconnected.id, guild);
      if (newConn) audioListeningFunctions(newConn, guild);
      return;
    }
    if (busiest && busiestHumans > 0) {
      const newConn = await joinChannel(client, busiest.id, guild);
      if (newConn) audioListeningFunctions(newConn, guild);
    }
    return;
  }

  // Connected:
  const hereHumans = currentChannel.members.filter((m) => !m.user.bot).size;
  const hereHasMod = channelHasMod(currentChannel);
  const hereViable = isViableCoverage(currentChannel);

  // NEW: Treat "< 2 humans" OR "has mod" as NON-VIABLE and reroute immediately
  if (!hereViable) {
    if (bestUnsupervised && bestUnsupervised.id !== currentChannel.id && canMove) {
      guildLastMoveAt.set(guild.id, now);
      console.log("[ROUTE] Non-viable room → moving to unsupervised≥2:", bestUnsupervised.name);
      await moveToChannel(bestUnsupervised, connection, guild, client);
      return;
    }
    if (busiest && busiestHumans > 0 && busiest.id !== currentChannel.id && canMove) {
      guildLastMoveAt.set(guild.id, now);
      console.log("[ROUTE] Non-viable room → moving to biggest:", busiest.name);
      await moveToChannel(busiest, connection, guild, client);
      return;
    }
    // If nothing better, disconnect (then we immediately recalc on disconnect handler)
    if (!isDisconnecting) {
      console.log("[ROUTE] Non-viable and no targets → disconnect & recalc.");
      await disconnectAndReset(connection, guild, client);
    }
    return;
  }

  // If viable (no mod & >=2), consider upgrading to a bigger NO-MOD room only
  if (busiest && busiest.id !== currentChannel.id && !channelHasMod(busiest)) {
    const there = channelCounts(busiest);
    if (there.humans > hereHumans && canMove) {
      guildLastMoveAt.set(guild.id, now);
      console.log("[ROUTE] Upgrading to bigger no-mod VC:", busiest.name);
      await moveToChannel(busiest, connection, guild, client);
    }
  }
}

async function moveToChannel(targetChannel, connection, guild, client) {
  if (connection) {
    console.log(`[INFO] Leaving and joining: ${targetChannel.name}`);
    await disconnectAndReset(connection, guild, client, /*skipRecalc*/ true); // we'll join immediately below
    const newConnection = await joinChannel(client, targetChannel.id, guild);
    if (newConnection) {
      saveVCState(guild.id, targetChannel.id);
      audioListeningFunctions(newConnection, guild);
    }
  }
}

async function joinChannel(client, channelId, guild) {
  const settings = await getSettingsForGuild(guild.id);
  if ((settings.safeChannels || []).includes(channelId)) {
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
      selfDeaf: false,
    });

    // ALWAYS recompute on rejoin/ready
    connection.on(VoiceConnectionStatus.Ready, async () => {
      console.log(`[INFO] Connected to ${channel.name}`);
      saveVCState(guild.id, channel.id);
      try { await manageVoiceChannels(guild, guild.client, null); } catch { }
    });

    // ALSO recompute on disconnects
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try { await manageVoiceChannels(guild, guild.client, null); } catch { }
    });

    return connection;
  } catch (error) {
    console.error(`[ERROR] Can't connect to ${channel.name}: ${error.message}`);
    return null;
  }
}

// Enhanced: after disconnect we immediately recompute (so the bot doesn't "die")
async function disconnectAndReset(connection, guild, client, skipRecalc = false) {
  if (!isDisconnecting) {
    isDisconnecting = true;
    try {
      const guildId = connection.joinConfig.guildId;
      clearVCState(guildId);
      connection.destroy();
      console.log(`[INFO] Disconnected from VC in guild ${guildId}`);
    } catch (error) {
      console.error(`[ERROR] During disconnect: ${error.message}`);
    } finally {
      isDisconnecting = false;
      if (!skipRecalc && guild && client) {
        try { await manageVoiceChannels(guild, client, null); } catch { }
      }
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

  const currentlySpeaking = new Set();
  const userLastSpokeTime = {};
  const perUserSilenceTimer = {};

  function stopUserPipeline(userId) {
    const p = pipelines.get(userId);
    if (p) {
      const { audioStream, decoder, pcmWriter, loudnessRes } = p;

      try { audioStream?.unpipe?.(decoder); } catch { }
      try { decoder?.unpipe?.(pcmWriter); } catch { }

      try { loudnessRes?.teardown?.(); } catch { }

      try { audioStream?.destroy?.(); } catch { }
      try { decoder?.destroy?.(); } catch { }

      if (pcmWriter && !pcmWriter.closed) {
        try { pcmWriter.end(); } catch { }
      }

      pipelines.delete(userId);
    }

    if (userSubscriptions[userId]) {
      try { userSubscriptions[userId].destroy?.(); } catch { }
      delete userSubscriptions[userId];
    }

    if (outputStreams[userId] && !outputStreams[userId].closed) {
      try { outputStreams[userId].end(); } catch { }
    }
    delete outputStreams[userId];
  }

  receiver.speaking.setMaxListeners(100);
  receiver.speaking.on("start", async (userId) => {
    if (currentlySpeaking.has(userId)) return;

    const settings = await getSettingsForGuild(guild.id);
    if (!settings.transcriptionEnabled) return;
    if (settings.safeUsers?.includes(userId)) return;
    const member = guild.members.cache.get(userId);
    const chanId = member?.voice?.channel?.id;
    if ((settings.safeChannels || []).includes(chanId)) return;
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

    const loudnessRes = await initiateLoudnessWarning(userId, audioStream, guild, () => {
      userLastSpokeTime[userId] = Date.now();
    });

    const pcmPath = path.join(__dirname, "../../temp_audio", `${userId}-${unique}.pcm`);
    fs.mkdirSync(path.dirname(pcmPath), { recursive: true });
    const pcmWriter = fs.createWriteStream(pcmPath, { flags: "w" });
    const decoder = new prism.opus.Decoder({
      frameSize: 960,
      channels: 1,
      rate: 48000,
    });
    try {
      audioStream.pipe(decoder).pipe(pcmWriter);
    } catch (err) {
      console.warn(`[PIPE ERROR] ${err.message}`);
    }
    pipelines.set(userId, { audioStream, decoder, pcmWriter, loudnessRes });
    outputStreams[userId] = pcmWriter;

    perUserSilenceTimer[userId] = setInterval(() => {
      const silenceDuration = Date.now() - (userLastSpokeTime[userId] || 0);
      const threshold = getAverageSilenceDuration(userId) || DEFAULT_SILENCE_TIMEOUT;

      if (silenceDuration >= threshold) {
        console.warn(
          `[SILENCE FINALIZE] ${userId} silent for ${silenceDuration}ms (threshold: ${threshold})`
        );
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
    if (!unique) return;

    const wait = GRACE_PERIOD_MS - (Date.now() - (userLastSpokeTime[userId] || 0));
    perUserSilenceTimer[userId] = setTimeout(() => {
      if (!currentlySpeaking.has(userId)) {
        finalizeUserAudio(userId, guild, unique, chanId);
      }
      clearTimeout(perUserSilenceTimer[userId]);
      delete perUserSilenceTimer[userId];
    }, wait > 0 ? wait : 0);
  });

  // ALWAYS recompute on disconnect
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    receiver.speaking.removeAllListeners();
    receiver.isListening = false;
    Object.values(perUserSilenceTimer).forEach((t) => {
      try { clearInterval(t); } catch { }
    });
    try { await manageVoiceChannels(guild, guild.client, null); } catch { }
  });

  async function finalizeUserAudio(userId, guild, unique, channelId) {
    const key = `${userId}-${unique}`;
    if (finalizingKeys.has(key)) return;
    finalizingKeys.add(key);

    const base = path.join(__dirname, "../../temp_audio", `${userId}-${unique}`);
    const pcm = `${base}.pcm`;
    const wav = `${base}.wav`;

    const writer = outputStreams[userId];
    if (writer && !writer.closed) {
      await new Promise((resolve) => {
        writer.once("close", resolve);
        writer.end();
      }).catch(() => { });
    }

    const pipeObj = pipelines.get(userId);
    if (pipeObj?.decoder) {
      try { await finished(pipeObj.decoder); } catch { }
    }

    try {
      if (!fs.existsSync(pcm) || fs.statSync(pcm).size < 2048) {
        await transcription.safeDeleteFile(pcm);
        cleanup(userId);
        return;
      }

      await convertOpusToWav(pcm, wav);
      const text = await transcribeAudio(wav);
      if (text) await postTranscription(guild, userId, text, channelId);
    } catch (err) {
      console.error(`[FINALIZE] user=${userId} ➜ ${err.message}`);
    } finally {
      await transcription.safeDeleteFile(pcm);
      await transcription.safeDeleteFile(wav);
      cleanup(userId);
      finalizingKeys.delete(key);
    }
  }

  function cleanup(userId) {
    if (outputStreams[userId]) {
      const writer = outputStreams[userId];
      try { if (!writer.destroyed) writer.end(); } catch (e) { console.warn(`[CLEANUP] end err: ${e.message}`); }
      writer.on("error", (err) => console.warn(`[PCM WRITER ERROR] ${err.message}`));
      try { writer.destroy(); } catch (e) { console.warn(`[CLEANUP] destroy err: ${e.message}`); }
      delete outputStreams[userId];
    }

    if (userSubscriptions[userId]) {
      try { userSubscriptions[userId].destroy?.(); } catch (e) { console.warn(`[CLEANUP] sub err: ${e.message}`); }
      delete userSubscriptions[userId];
    }

    delete userAudioIds[userId];
  }
}

/************************************************************************************************
 * Periodic VC auto-(re)join probe (every 15s)
 * - Honors mod_auto_route_enabled gating for target selection
 ************************************************************************************************/
let vcAutoCheckInterval = null;
const vcProbeRunning = new Set();

function startPeriodicVCCheck(client, intervalMs = 15000) {
  if (vcAutoCheckInterval) clearInterval(vcAutoCheckInterval);

  vcAutoCheckInterval = setInterval(() => {
    client.guilds.cache.forEach(async (guild) => {
      if (vcProbeRunning.has(guild.id)) return;
      vcProbeRunning.add(guild.id);

      try {
        const connection = getVoiceConnection(guild.id);
        if (connection && connection.state?.status === VoiceConnectionStatus.Ready) {
          await manageVoiceChannels(guild, client, null);
          return;
        }

        // If disconnected, recompute targets and (maybe) join
        await manageVoiceChannels(guild, client, null);
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