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

EventEmitter.defaultMaxListeners = 50;

/************************************************************************************************
 * GLOBALS & CONSTANTS
 ************************************************************************************************/
const GRACE_PERIOD_MS = 3000;
const silenceDurations = new Map();
const MAX_SILENCE_RECORDS = 10;
const DEFAULT_SILENCE_TIMEOUT = 3000;
const finalizationTimers = {};

// Audio-processing queue (if needed)
let isProcessing = false;
const processingQueue = [];

// Track file streams and subscriptions by user
const outputStreams = {};
const userSubscriptions = {};
const userAudioIds = {}; // userId -> unique

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
  audioStream,
  guild,
  updateTimestamp
) => {
  const settings = await getSettingsForGuild(guild.id);

  // Skip loudness detection for safe users
  if (settings.safeUsers && settings.safeUsers.includes(userId)) {
    console.log(
      `[INFO] User ${userId} is a safe user. Skipping loudness detection.`
    );
    return;
  }

  const options = {
    cooldownMs: 15000,
    instantThreshold: 17500,
    fastThreshold: 14000,
    fastDuration: 500,
    prolongedThreshold: 10000,
    prolongedDuration: 6000,
  };

  // Callback for when loud audio is detected.
  const warnIfTooLoud = async (uid, rms) => {
    const now = Date.now();
    const lastWarning = userWarningTimestamps.get(uid) || 0;
    const cooldownMs = 15000; // 15 seconds cooldown per user

    if (now - lastWarning < cooldownMs) {
      return; // Don't warn again if cooldown hasn't expired
    }

    userWarningTimestamps.set(uid, now); // ✅ Update last warning time

    console.log(`*** WARNING: User ${uid} is too loud (RMS: ${rms}) ***`);

    const settings = await getSettingsForGuild(guild.id);
    let voiceCallPingRoleId = null;
    if (settings.notifyLoudUser) {
      voiceCallPingRoleId = settings.voiceCallPingRoleId;
    }

    transcription
      .ensureTranscriptionChannel(guild)
      .then((channel) => {
        if (!channel) {
          console.error(
            `[ERROR] No transcription channel available for guild ${guild.id}`
          );
          return;
        }

        let warningMessage = `## ⚠️ User <@${uid}> is being loud (RMS: **${rms}**)\n-# Confused by what RMS means? Check \`help rms\` for a quick explanation.`;
        if (voiceCallPingRoleId) {
          warningMessage = `## ⚠️ <@&${voiceCallPingRoleId}> User <@${uid}> is being loud (RMS: **${rms}**)\n-# Confused by what RMS means? Check \`help rms\` for a quick explanation.`;
        }

        channel
          .send(warningMessage)
          .catch((err) =>
            console.error(
              `[ERROR] Failed to send loudness warning: ${err.message}`
            )
          );
      })
      .catch((err) =>
        console.error(
          `[ERROR] Failed to retrieve transcription channel: ${err.message}`
        )
      );
  };

  // Create the detector from transcription.cjs using our warning callback.
  const loudnessDetector = transcription.createLoudnessDetector(
    guild,
    userId,
    warnIfTooLoud,
    options
  );

  // Decode the Opus data to PCM before passing to the detector.
  const opusDecoderForLoudness = new prism.opus.Decoder({
    frameSize: 960,
    channels: 1,
    rate: 48000,
  });

  let lastActiveTime = Date.now();
  const QUIET_THRESHOLD_RMS = 500;        // Customize as needed
  const QUIET_TIMEOUT_MS = 4000;          // Time of low RMS before finalizing

  loudnessDetector.on("data", (rms) => {
    if (rms >= QUIET_THRESHOLD_RMS) {
      lastActiveTime = Date.now(); // User is talking above quiet threshold
      if (typeof updateTimestamp === "function") updateTimestamp();
    } else {
      const silentDuration = Date.now() - lastActiveTime;
      if (silentDuration >= QUIET_TIMEOUT_MS) {
        console.warn(`[QUIET FINALIZE] ${userId} silent (low RMS) for ${silentDuration}ms`);
        loudnessDetector.destroy(); // Stop processing further
      }
    }
  });

  audioStream
    .pipe(opusDecoderForLoudness)
    .pipe(loudnessDetector);
};

/**
 * Detects:
 *  - Server mute/unmute
 *  - Server deafen/undeafen
 *  - Self mute/unmute
 *  - Self deafen/undeafen
 *  - Forced disconnect (VC kick)
 * Logs each in the same code-block format as your existing voice logs.
 *
 * @param {VoiceState} oldState - The previous voice state.
 * @param {VoiceState} newState - The updated voice state.
 */
async function detectUserActivityChanges(oldState, newState) {
  const guild = newState.guild;
  const member = newState.member;
  if (!guild || !member) return;

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
        auditEntry &&
        auditEntry.target.id === userId &&
        Date.now() - auditEntry.createdTimestamp < 5000
      ) {
        forciblyDisconnected = true;
        executor = auditEntry.executor.tag;
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
    const action = newState.serverMute
      ? "was server muted"
      : "was server unmuted";
    let executor = "Unknown";
    try {
      const fetchedLogs = await guild.fetchAuditLogs({
        limit: 1,
        type: AuditLogEvent.MemberUpdate,
      });
      const auditEntry = fetchedLogs.entries.find(
        (entry) =>
          entry.target.id === userId &&
          entry.changes.some((change) => change.key === "mute")
      );
      if (auditEntry) {
        executor = auditEntry.executor.tag;
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
    const action = newState.serverDeaf
      ? "was server deafened"
      : "was server undeafened";
    let executor = "Unknown";
    try {
      const fetchedLogs = await guild.fetchAuditLogs({
        limit: 1,
        type: AuditLogEvent.MemberUpdate,
      });
      const auditEntry = fetchedLogs.entries.find(
        (entry) =>
          entry.target.id === userId &&
          entry.changes.some((change) => change.key === "deaf")
      );
      if (auditEntry) {
        executor = auditEntry.executor.tag;
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
    const action = newState.streaming
      ? "started screen sharing"
      : "stopped screen sharing";
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
  if (newState.member?.user.bot) return;

  // Detect mute and deafen changes
  await detectUserActivityChanges(oldState, newState);

  if (!newState.guild) {
    console.error("[ERROR] Guild object is missing!");
    return;
  }

  const guild = newState.guild;
  const userId = newState.member?.id;
  if (!userId) {
    console.error("[ERROR] Failed to retrieve user ID from newState.");
    return;
  }
  console.log(`[DEBUG] Checking voice state update for user: ${userId}`);

  const settings = await getSettingsForGuild(guild.id);

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
  const username = member?.user.username || "Unknown";
  let roleColor = ansi.white;
  if (guild.ownerId === userId) {
    roleColor = ansi.red;
  } else if (member && member.permissions.has("Administrator")) {
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
  const buildLog = (timestamp, msg) => {
    return `\`\`\`ansi\n${ansi.darkGray}[${ansi.white}${timestamp}${ansi.darkGray}] ${msg}${ansi.reset}\n\`\`\``;
  };

  // Case 1: User moved channels
  if (
    oldState.channelId &&
    newState.channelId &&
    oldState.channelId !== newState.channelId
  ) {
    console.log(
      `[DEBUG] User ${userId} moved from ${oldState.channelId} to ${newState.channelId}`
    );
    if (settings.vcLoggingEnabled && settings.vcLoggingChannelId) {
      const activityChannel = guild.channels.cache.get(
        settings.vcLoggingChannelId
      );
      if (activityChannel) {
        const oldChannel = guild.channels.cache.get(oldState.channelId);
        const newChannel = guild.channels.cache.get(newState.channelId);
        const oldChannelName = oldChannel?.name || "Unknown Channel";
        const newChannelName = newChannel?.name || "Unknown Channel";
        const memberCount = newChannel.members.filter((m) => !m.user.bot).size;
        const now = new Date();
        const timestamp = now.toLocaleTimeString("en-US", {
          minute: "2-digit",
          second: "2-digit",
        });
        const logMsg = `[${roleColor}${topRole}${ansi.darkGray}] [${ansi.white}${userId}${ansi.darkGray}] ${roleColor}${username}${ansi.darkGray} moved from ${ansi.white}${oldChannelName}${ansi.darkGray} to ${ansi.white}${newChannelName}${ansi.darkGray}. Member count: ${memberCount}`;
        await activityChannel.send(buildLog(timestamp, logMsg)).catch(console.error);
      } else {
        console.error(
          `[ERROR] Activity logging channel ${settings.vcLoggingChannelId} not found.`
        );
      }
    }

    let connection = getVoiceConnection(guild.id);
    if (connection) {
      await disconnectAndReset(connection);
    }
    await manageVoiceChannels(guild, client);

    return;
  }

  // Case 2: User joined a channel
  if (!oldState.channelId && newState.channelId) {
    console.log(`[DEBUG] User ${userId} joined channel: ${newState.channelId}`);
    if (settings.vcLoggingEnabled && settings.vcLoggingChannelId) {
      const activityChannel = guild.channels.cache.get(
        settings.vcLoggingChannelId
      );
      if (activityChannel) {
        const joinedChannel = guild.channels.cache.get(newState.channelId);
        const joinedChannelName = joinedChannel?.name || "Unknown Channel";
        const memberCount = joinedChannel.members.filter((m) => !m.user.bot).size;
        const now = new Date();
        const timestamp = now.toLocaleTimeString("en-US", {
          minute: "2-digit",
          second: "2-digit",
        });
        const logMsg = `[${roleColor}${topRole}${ansi.darkGray}] [${ansi.white}${userId}${ansi.darkGray}] ${roleColor}${username}${ansi.darkGray} joined voice channel ${ansi.white}${joinedChannelName}${ansi.darkGray}. Member count: ${memberCount}`;
        await activityChannel.send(buildLog(timestamp, logMsg)).catch(console.error);
      } else {
        console.error(
          `[ERROR] Activity logging channel ${settings.vcLoggingChannelId} not found.`
        );
      }
    }

    let connection = getVoiceConnection(guild.id);
    if (!connection) {
      console.log("[INFO] Bot is not in a voice channel. Joining now...");
      connection = await joinChannel(client, newState.channelId, guild);
      if (connection) {
        console.log("[INFO] Voice connection established.");
        audioListeningFunctions(connection, guild);
      } else {
        console.error("[ERROR] Failed to join voice channel.");
        return;
      }
    }

    if (await hasUserConsented(userId)) {
      console.log(
        `[INFO] User ${userId} has already consented. Allowing audio capture.`
      );
      try {
        if (newState.serverDeaf) {
          await newState.setMute(false, "User has consented to transcription.");
          console.log(`[INFO] User ${userId} unmuted.`);
        }
      } catch (error) {
        console.error(
          `[ERROR] Failed to unmute user ${userId}: ${error.message}`
        );
      }
    } else {
      console.log(
        `[DEBUG] User ${userId} has NOT consented. Sending consent request...`
      );
      const consentButtons = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`consent:grant:${userId}`)
          .setLabel("Consent")
          .setStyle(ButtonStyle.Success)
      );
      interactionContexts.set(userId, { guildId: guild.id, mode: "consent" });
      try {
        const dmChannel = await newState.member.user.createDM();
        await dmChannel.send({
          content: `# Consent Required
Inside this voice call, your voice will be transcribed into text. Please click the button below to consent.

> All audio files of your voice are temporary and will not be permanently saved.
-# > You can also take a look at our [privacy policy](<https://www.vctools.app/privacy>) for more information.`,
          components: [consentButtons],
        });
        console.log(`[INFO] Consent request sent to ${userId} via DM`);
        await newState.setMute(true, "Awaiting transcription consent.");
        console.log(`[INFO] User ${userId} muted until consent is given.`);
      } catch (error) {
        console.error(
          `[ERROR] Could not DM user ${userId} for consent: ${error.message}`
        );
      }
    }
  }

  // Case 3: User left a channel
  if (oldState.channelId && !newState.channelId) {
    console.log(`[DEBUG] User ${userId} left channel: ${oldState.channelId}`);
    if (settings.vcLoggingEnabled && settings.vcLoggingChannelId) {
      const activityChannel = guild.channels.cache.get(
        settings.vcLoggingChannelId
      );
      if (activityChannel) {
        const leftChannel = guild.channels.cache.get(oldState.channelId);
        const leftChannelName = leftChannel?.name || "Unknown Channel";
        const memberCount = leftChannel.members.filter((m) => !m.user.bot).size;
        const now = new Date();
        const timestamp = now.toLocaleTimeString("en-US", {
          minute: "2-digit",
          second: "2-digit",
        });
        const logMsg = `[${roleColor}${topRole}${ansi.darkGray}] [${ansi.white}${userId}${ansi.darkGray}] ${roleColor}${username}${ansi.darkGray} left voice channel ${ansi.white}${leftChannelName}${ansi.darkGray}. Member count: ${memberCount}`;
        await activityChannel.send(buildLog(timestamp, logMsg)).catch(console.error);
      } else {
        console.error(
          `[ERROR] Activity logging channel ${settings.vcLoggingChannelId} not found.`
        );
      }
    }
    let connection = getVoiceConnection(guild.id);
    if (connection) {
      await manageVoiceChannels(guild, client);
    }
  }
}

/************************************************************************************************
 * MANAGE VOICE CHANNELS & MOVES
 ************************************************************************************************/
async function manageVoiceChannels(guild, client) {
  const ansi = {
    darkGray: "\u001b[2;30m",
    white: "\u001b[2;37m",
    reset: "\u001b[0m",
  };

  const voiceChannels = guild.channels.cache.filter((c) => c.type === 2);
  let targetChannel = null;
  let maxMembers = 0;
  voiceChannels.forEach((channel) => {
    const nonBotMembers = channel.members.filter((m) => !m.user.bot).size;
    if (nonBotMembers > maxMembers) {
      maxMembers = nonBotMembers;
      targetChannel = channel;
    }
  });
  const voiceConnection = getVoiceConnection(guild.id);
  const currentChannel = voiceConnection
    ? guild.channels.cache.get(voiceConnection.joinConfig.channelId)
    : null;
  if (currentChannel) {
    const members = currentChannel.members;
    const nonBotMembers = members.filter((m) => !m.user.bot);
    const botIsOnlyOne =
      nonBotMembers.size === 0 &&
      members.size === 1 &&
      members.first().user.bot;
    if (botIsOnlyOne && !isDisconnecting) {
      const now = new Date().toLocaleTimeString("en-US", {
        minute: "2-digit",
        second: "2-digit",
      });
      console.log(
        `${ansi.darkGray}[${ansi.white}${now}${ansi.darkGray}] Bot is alone, disconnecting...${ansi.reset}`
      );
      await disconnectAndReset(voiceConnection);
    } else if (targetChannel && targetChannel.id !== currentChannel.id) {
      const now = new Date().toLocaleTimeString("en-US", {
        minute: "2-digit",
        second: "2-digit",
      });
      console.log(
        `${ansi.darkGray}[${ansi.white}${now}${ansi.darkGray}] Moving to: ${ansi.white}${targetChannel.name}${ansi.reset}`
      );
      await moveToChannel(targetChannel, voiceConnection, guild, client);
    }
  }
}

async function moveToChannel(targetChannel, connection, guild, client) {
  if (connection) {
    console.log(`[INFO] Leaving and joining: ${targetChannel.name}`);
    await disconnectAndReset(connection);
    const newConnection = await joinChannel(client, targetChannel.id, guild);
    if (newConnection) {
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
      console.log(
        `[INFO] Disconnecting from ${connection.joinConfig.channelId}`
      );
      connection.destroy();
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

    // Loudness detector
    const loudPass = new PassThrough();
    audioStream.pipe(loudPass);
    initiateLoudnessWarning(userId, loudPass, guild, () => {
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
          finalizeUserAudio(userId, guild, unique);
        }
      }
    }, 1000);
  });

  receiver.speaking.on("stop", (userId) => {
    console.log(`[DEBUG] STOP triggered for ${userId}`);
    if (!currentlySpeaking.has(userId)) return;
    currentlySpeaking.delete(userId);

    const unique = userAudioIds[userId];
    if (!unique) return;                               // never recorded

    /* schedule finalisation after GRACE_PERIOD_MS of silence */
    const wait = GRACE_PERIOD_MS - (Date.now() - (userLastSpokeTime[userId] || 0));
    perUserSilenceTimer[userId] = setTimeout(() => {
      if (!currentlySpeaking.has(userId)) finalizeUserAudio(userId, guild, unique);
      clearTimeout(perUserSilenceTimer[userId]);
      delete perUserSilenceTimer[userId];
    }, wait > 0 ? wait : 0);
  });

  connection.once(VoiceConnectionStatus.Disconnected, () => {
    receiver.speaking.removeAllListeners();
    receiver.isListening = false;
    Object.values(perUserSilenceTimer).forEach(clearInterval);
  });

  /* ───────────────────────── FINALISE & TRANSCRIBE ───────────────────────── */

  async function finalizeUserAudio(userId, guild, unique) {
    const base = path.join(__dirname, "../../temp_audio", `${userId}-${unique}`);
    const pcm = `${base}.pcm`;
    const wav = `${base}.wav`;

    try {
      /* skip if no file or trivial length */
      if (!fs.existsSync(pcm) || fs.statSync(pcm).size < 2048) {
        await safeDeleteFile(pcm);
        cleanup(userId);
        return;
      }

      /* convert + transcribe */
      await convertOpusToWav(pcm, wav);
      const text = await transcribeAudio(wav);
      if (text) {
        await postTranscription(guild, userId, text);
      }
    } catch (err) {
      console.error(`[FINALIZE] user=${userId} → ${err.message}`);
    } finally {
      await safeDeleteFile(pcm);
      await safeDeleteFile(wav);
      cleanup(userId);
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

module.exports = { execute };