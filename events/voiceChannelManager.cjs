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

/************************************************************************************************
 * REUSABLE TRANSCRIPTION FUNCTIONS
 ************************************************************************************************/
const {
  processAudio,
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

  audioStream
    .pipe(opusDecoderForLoudness)
    .pipe(loudnessDetector)
    .on("data", () => {
      if (typeof updateTimestamp === "function") {
        updateTimestamp();
      }
    });
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
async function detectMuteDeafenDisconnectChanges(oldState, newState) {
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
  await detectMuteDeafenDisconnectChanges(oldState, newState);

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
        const oldChannelName = oldChannel ? oldChannel.name : "Unknown Channel";
        const newChannelName = newChannel ? newChannel.name : "Unknown Channel";
        const now = new Date();
        const timestamp = now.toLocaleTimeString("en-US", {
          minute: "2-digit",
          second: "2-digit",
        });
        const logMsg = `[${roleColor}${topRole}${ansi.darkGray}] [${ansi.white}${userId}${ansi.darkGray}] ${roleColor}${username}${ansi.darkGray} moved from ${ansi.white}${oldChannelName}${ansi.darkGray} to ${ansi.white}${newChannelName}${ansi.darkGray}.`;
        await activityChannel
          .send(buildLog(timestamp, logMsg))
          .catch(console.error);
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
    connection = await joinChannel(client, newState.channelId, guild);
    if (connection) {
      console.log(`[INFO] Rejoined new channel ${newState.channelId}`);
      audioListeningFunctions(connection, guild);
    } else {
      console.error("[ERROR] Failed to join new voice channel after move.");
    }
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
        const joinedChannelName = joinedChannel
          ? joinedChannel.name
          : "Unknown Channel";
        const now = new Date();
        const timestamp = now.toLocaleTimeString("en-US", {
          minute: "2-digit",
          second: "2-digit",
        });
        const logMsg = `[${roleColor}${topRole}${ansi.darkGray}] [${ansi.white}${userId}${ansi.darkGray}] ${roleColor}${username}${ansi.darkGray} joined voice channel ${ansi.white}${joinedChannelName}${ansi.darkGray}.`;
        await activityChannel
          .send(buildLog(timestamp, logMsg))
          .catch(console.error);
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
        const leftChannelName = leftChannel
          ? leftChannel.name
          : "Unknown Channel";
        const now = new Date();
        const timestamp = now.toLocaleTimeString("en-US", {
          minute: "2-digit",
          second: "2-digit",
        });
        const logMsg = `[${roleColor}${topRole}${ansi.darkGray}] [${ansi.white}${userId}${ansi.darkGray}] ${roleColor}${username}${ansi.darkGray} left voice channel ${ansi.white}${leftChannelName}${ansi.darkGray}.`;
        await activityChannel
          .send(buildLog(timestamp, logMsg))
          .catch(console.error);
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

  const currentlySpeaking = new Set();
  const userLastSpokeTime = {};

  // Single interval for checking silence for all users.
  const silenceInterval = setInterval(() => {
    const now = Date.now();
    for (const uid of currentlySpeaking) {
      const lastActive = userLastSpokeTime[uid] || 0;
      const silenceDuration = now - lastActive;
      const threshold = getAverageSilenceDuration(uid) || DEFAULT_SILENCE_TIMEOUT;
      if (silenceDuration >= threshold) {
        console.log(`[INFO] Silence threshold exceeded for user ${uid}`);
        updateSilenceDuration(uid, silenceDuration);
        onSpeakingStop(uid);
      }
    }
  }, 1000);

  receiver.speaking.on("start", (userId) => {
    onSpeakingStart(userId).catch(console.error);
  });
  receiver.speaking.on("stop", onSpeakingStop);

  connection.once(VoiceConnectionStatus.Disconnected, () => {
    console.log("[INFO] Voice disconnected. Removing listeners.");
    receiver.speaking.removeAllListeners("start");
    receiver.speaking.removeAllListeners("stop");
    receiver.isListening = false;
    clearInterval(silenceInterval);
  });

  async function onSpeakingStart(userId) {
    const settings = await getSettingsForGuild(guild.id);
    if (!settings.transcriptionEnabled) return;
    if (currentlySpeaking.has(userId)) return;
    console.log(`[AUDIO] speaking.start user=${userId}`);
    currentlySpeaking.add(userId);
    userLastSpokeTime[userId] = Date.now();

    if (finalizationTimers[userId]) {
      clearTimeout(finalizationTimers[userId]);
      delete finalizationTimers[userId];
    }

    const audioStream = receiver.subscribe(userId, {
      end: { behavior: "manual" },
    });
    userSubscriptions[userId] = audioStream;

    const loudnessPassThrough = new PassThrough();
    audioStream.pipe(loudnessPassThrough);
    initiateLoudnessWarning(userId, loudnessPassThrough, guild, () => {
      userLastSpokeTime[userId] = Date.now();
    });

    if (settings.safeUsers && settings.safeUsers.includes(userId)) {
      console.log(`[INFO] User ${userId} is marked as safe. Skipping transcription pipeline.`);
      return;
    }
    const member = guild.members.cache.get(userId);
    if (member && member.voice && member.voice.channel) {
      const voicechannelId = member.voice.channel.id;
      if (settings.safeChannels && settings.safeChannels.includes(voicechannelId)) {
        console.log(`[INFO] Channel ${voicechannelId} is marked as safe. Skipping transcription pipeline.`);
        return;
      }
    }

    const consent = await hasUserConsented(userId);
    if (!consent) {
      console.log(`[INFO] User ${userId} has not consented. Skipping transcription pipeline.`);
      return;
    }

    const pcmFilePath = path.resolve(__dirname, "../../temp_audio", `${userId}.pcm`);
    fs.mkdirSync(path.dirname(pcmFilePath), { recursive: true });
    transcription.ensureDirectoryExistence(pcmFilePath);

    if (outputStreams[userId]) {
      console.warn(`[AUDIO] Warning: user=${userId} already has a stream open. Replacing it.`);
      try {
        outputStreams[userId].destroy();
      } catch (e) {
        console.error(`[AUDIO] Failed to destroy previous stream for ${userId}: ${e.message}`);
      }
      delete outputStreams[userId];
    }

    const pcmPassThrough = new PassThrough();
    audioStream.pipe(pcmPassThrough);

    const opusDecoderPCM = new prism.opus.Decoder({
      frameSize: 960,
      channels: 1,
      rate: 48000,
    });
    const fileWriteStream = fs.createWriteStream(pcmFilePath, { flags: "w" });

    pcmPassThrough.pipe(opusDecoderPCM).pipe(fileWriteStream);
    outputStreams[userId] = fileWriteStream;

    opusDecoderPCM.on("data", () => {
      userLastSpokeTime[userId] = Date.now();
    });
    opusDecoderPCM.on("error", (err) => {
      console.error(`[AUDIO] PCM Decoder error: user=${userId} ${err.message}`);
      onSpeakingStop(userId);
    });
    audioStream.on("error", (err) => {
      console.error(`[AUDIO] Audio stream error: user=${userId} ${err.message}`);
      onSpeakingStop(userId);
    });
  }

  function onSpeakingStop(userId) {
    if (!currentlySpeaking.has(userId)) {
      console.log(`[AUDIO] onSpeakingStop called but user=${userId} isn't speaking.`);
      return;
    }
    const now = Date.now();
    const lastSpoke = userLastSpokeTime[userId] || 0;
    if (now - lastSpoke < GRACE_PERIOD_MS) {
      console.log(`[AUDIO] onSpeakingStop ignored for user=${userId}, still within grace.`);
      return;
    }
    console.log(`[AUDIO] speaking.stop user=${userId}`);
    currentlySpeaking.delete(userId);
    if (finalizationTimers[userId]) {
      clearTimeout(finalizationTimers[userId]);
    }
    finalizationTimers[userId] = setTimeout(() => {
      if (!currentlySpeaking.has(userId)) {
        finalizeUserAudio(userId, guild);
      } else {
        console.log(`[AUDIO] User ${userId} started speaking again; skip finalize.`);
      }
      delete finalizationTimers[userId];
    }, GRACE_PERIOD_MS);
  }

  async function finalizeUserAudio(userId, guild) {
    if (currentlySpeaking.has(userId)) return;
    if (finalizationTimers[userId]) {
      clearTimeout(finalizationTimers[userId]);
      delete finalizationTimers[userId];
    }

    const tempAudioDir = path.resolve(__dirname, "../../temp_audio");
    fs.mkdirSync(tempAudioDir, { recursive: true });

    const pcmFilePath = path.join(tempAudioDir, `${userId}.pcm`);
    const wavFilePath = path.join(tempAudioDir, `${userId}.wav`);

    if (Date.now() - (userLastSpokeTime[userId] || 0) < 3000) {
      console.log(`[INFO] Aborting finalization: user ${userId} resumed speaking recently.`);
      return;
    }

    try {
      fs.accessSync(pcmFilePath, fs.constants.W_OK);
      console.log(`[DEBUG] File is writable: ${pcmFilePath}`);
    } catch (err) {
      console.error(`[LOCKED] Cannot write to PCM file: ${pcmFilePath}`, err.message);
    }

    try {
      if (!fs.existsSync(pcmFilePath)) {
        console.warn(`[AUDIO] finalizeUserAudio: No PCM file for user=${userId}`);
        return;
      }

      const stats = fs.statSync(pcmFilePath);
      console.log(`[AUDIO] finalizeUserAudio: user=${userId}, size=${stats.size} bytes.`);
      if (stats.size < 2000) {
        console.warn(`[AUDIO] Very short file for user=${userId}, skipping transcription.`);
        await safeDeleteFile(pcmFilePath);
        return;
      }

      console.log(`[DEBUG] Converting PCM to WAV for user=${userId}...`);
      const buffer = await fs.promises.readFile(pcmFilePath);
      await transcription.convertOpusToWav(buffer, wavFilePath, userId);

      if (!fs.existsSync(wavFilePath)) {
        console.error(`[ERROR] WAV file was NOT created for user ${userId}`);
        return;
      }

      console.log(`[INFO] Successfully created WAV file: ${wavFilePath}`);
      const transcriptionText = await transcription.processAudio(userId, guild);
      if (!transcriptionText) {
        console.warn(`[WARNING] No transcription generated for user ${userId}.`);
        return;
      }

      console.log(`[TRANSCRIPTION] User ${userId}: ${transcriptionText}`);
      await postTranscription(guild, userId, transcriptionText);
    } catch (error) {
      console.error(`[AUDIO] finalizeUserAudio error: user=${userId} ${error.message}`);
    } finally {
      setTimeout(async () => {
        if (Date.now() - (userLastSpokeTime[userId] || 0) < 3000) {
          console.log(`[INFO] Aborting deletion: user ${userId} resumed speaking recently.`);
          return;
        }
        if (outputStreams[userId]) {
          outputStreams[userId].destroy();
          delete outputStreams[userId];
        }
        await safeDeleteFile(pcmFilePath);
        await safeDeleteFile(wavFilePath);
        console.log(`[AUDIO] Deleted audio files for user ${userId}`);
        delete userSubscriptions[userId];
      }, 5000);
    }
  }
}

module.exports = {
  execute,
};
