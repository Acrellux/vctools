// ── single-instance lock ─────────────────────────────────────
const fs = require("fs");
const path = require("path");

const LOCK_PATH = path.join(__dirname, "vc_tools_index.lock");
const PID_PATH = path.join(__dirname, "vc_tools_index.pid");

try {
  if (fs.existsSync(LOCK_PATH)) {
    const oldPid = Number(fs.readFileSync(LOCK_PATH, "utf8"));
    if (!Number.isNaN(oldPid)) {
      try {
        // Probe if old process exists
        process.kill(oldPid, 0);
        console.error(`[LOCK] Another VC Tools instance is running (pid ${oldPid}). Exiting.`);
        process.exit(0);
      } catch {
        // Stale lock; continue
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
  process.on("uncaughtException", (err) => {
    console.error("[LOCK] Uncaught exception:", err?.stack || err);
    cleanup();
    process.exit(1);
  });
} catch (e) {
  console.error("[LOCK] Failed to set lock:", e?.message || e);
}

const { Client, GatewayIntentBits, Events } = require("discord.js");
// Disable DiscordJS UDP IP discovery (fixes 'socket closed' errors)
process.env.DISCORDJS_DISABLE_UDP = "true";
const dotenv = require("dotenv");
const commands = require("./commands/commands.cjs");
const { ChannelType, AuditLogEvent, PermissionFlagsBits, PermissionsBitField, SnowflakeUtil,
} = require("discord.js");
const {
  joinChannel,
  audioListeningFunctions
} = require("./events/voiceChannelManager.cjs");
const voiceChannelManager = require("./events/voiceChannelManager.cjs");
const { interactionContexts } = require("./database/contextStore.cjs");
const { handleReaction } = require("./commands/report/reportHandler.cjs");
const { joinVoiceChannel, getVoiceConnection, VoiceConnectionStatus } = require("@discordjs/voice");
const { VC_STATE_PATH, saveVCState } = require("./util/vc_state.cjs");
const {
  getSettingsForGuild,
  updateSettingsForGuild,
  hasUserConsented, // ← CONSENT
} = require("./commands/settings.cjs");

// CONSENT: add prompt sender
const { sendConsentPrompt } = require("./commands/logic/consent_logic.cjs");

// Import notify logic functions, including the new one for target queries.
const {
  handleNotifyMessageCommand,
  handleNotifySlashCommand,
  handleNotifyFlow,
  showNotifyHubUI,
  listNotifications,
  listNotificationsForTarget,
  listUsersBlockedBy,
} = require("./commands/logic/notify_logic.cjs");

dotenv.config();

// Auto-pull repo on start
const { execSync } = require("child_process");

try {
  console.log("[GIT] Pulling latest changes from origin...");
  execSync('git pull', { stdio: 'inherit' });
  console.log("[GIT] Repo up-to-date.");
} catch (error) {
  console.error("[GIT] Failed to pull repo:", error.message);
}

// Clean up the .pcm containing folder
const audioDir = path.resolve(__dirname, "../../temp_audio");

fs.readdir(audioDir, (err, files) => {
  if (err) return;
  for (const file of files) {
    if (file.endsWith(".pcm")) {
      fs.unlink(path.join(audioDir, file), () => { });
    }
  }
});

// Initialize Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
  ],
});

// Initialize Supabase client with service role key
const { createClient } = require("@supabase/supabase-js");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("[ERROR] Missing Supabase environment variables!");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Load additional event handlers dynamically
const loadEventHandlers = async () => {
  const eventsPath = path.join(__dirname, "events");
  const eventFiles = fs
    .readdirSync(eventsPath)
    .filter((file) => file.endsWith(".cjs"));

  for (const file of eventFiles) {
    try {
      const { execute } = require(`./events/${file}`);
      if (typeof execute === "function") {
        const eventName = file.replace(".cjs", "");
        client.on(eventName, (...args) => execute(...args, client));
        console.log(`[INFO] Event handler loaded: ${eventName}`);
      } else {
        console.error(
          `The file ${file} does not export a function named 'execute'.`
        );
      }
    } catch (error) {
      console.error(`Failed to load event handler ${file}:`, error);
    }
  }
};

loadEventHandlers();

// Import report cleanup process
const { cleanupOldReports } = require("./commands/report/cleanupReports.cjs");

// Fetch default soundboard sounds
async function fetchDefaultSoundboardSounds(client) {
  try {
    const defaultSounds = await client.rest.get("/soundboard-default-sounds", {
      headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` },
    });

    if (Array.isArray(defaultSounds)) {
      return defaultSounds.reduce((acc, sound) => {
        acc[sound.sound_id] = `${sound.name} ${sound.emoji_name || ""}`;
        return acc;
      }, {});
    }
  } catch (error) {
    console.error("[ERROR] Failed to fetch default soundboard sounds:", error);
  }
  return {};
}

async function getUserStatus(userId, guildId) {
  const { data, error } = await supabase
    .from("statuses")
    .select("status")
    .eq("user_id", userId)
    .eq("server_id", guildId)
    .maybeSingle();

  if (error) {
    console.error(`[ERROR] Could not get status for ${userId}:`, error);
    return "open"; // Default to open if unknown
  }

  return data?.status || "open";
}

let DEFAULT_SOUNDS = {};
client.once("ready", async () => {
  DEFAULT_SOUNDS = await fetchDefaultSoundboardSounds(client);
  console.log(
    `[INFO] Loaded ${Object.keys(DEFAULT_SOUNDS).length
    } default soundboard sounds.`
  );
});

// Ensure transcription channel function
const ensureTranscriptionChannel = async (guild) => {
  const settings = await getSettingsForGuild(guild.id);
  if (!settings.transcriptionEnabled || !settings.channelId) return null;
  return await guild.channels.fetch(settings.channelId).catch(() => null);
};

// Process VOICE_CHANNEL_EFFECT_SEND event
client.ws.on("VOICE_CHANNEL_EFFECT_SEND", async (data) => {
  try {
    const { user_id, guild_id, sound_id } = data;
    const guild = client.guilds.cache.get(guild_id);
    if (!guild) return;
    const settings = await getSettingsForGuild(guild.id);
    if (!settings.soundboardLogging) return;
    const guildId = settings.guildId || guild.id;
    const transcriptionChannel = await ensureTranscriptionChannel(guild);
    if (!transcriptionChannel) return;
    const user = await client.users.fetch(user_id);
    const member = await guild.members.fetch(user_id).catch(() => null);
    if (!member) {
      console.warn(`[WARN] Could not fetch member for user ${user_id}.`);
    }
    if (!guild.roles) await guild.fetch();

    let soundName = `Unknown Sound (ID: ${sound_id})`;
    if (DEFAULT_SOUNDS[sound_id]) {
      soundName = DEFAULT_SOUNDS[sound_id];
    } else {
      try {
        const guildSounds = await client.rest.get(
          `/guilds/${guildId}/soundboard-sounds`,
          { headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` } }
        );
        if (Array.isArray(guildSounds.items)) {
          const foundSound = guildSounds.items.find(
            (s) => s.sound_id === sound_id
          );
          if (foundSound) {
            soundName = `${foundSound.name} ${foundSound.emoji_name || ""}`;
          }
        }
      } catch (fetchError) {
        console.warn(
          "[WARNING] Could not fetch guild soundboard details:",
          fetchError.message
        );
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

    const topRole = member?.roles.highest?.name || "No Role";
    let roleColor = ansi.white;
    if (guild.ownerId === user.id) {
      roleColor = ansi.red;
    } else if (member?.permissions.has("Administrator")) {
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

    // Emoji formatting (use if it's a unicode emoji — animated ones have an ID)
    const emoji = data.emoji?.id === null ? data.emoji?.name || "" : "";

    const logMsg =
      `[${roleColor}${topRole}${ansi.darkGray}] ` +
      `[${ansi.white}${user.id}${ansi.darkGray}] ` +
      `${roleColor}${user.username}${ansi.darkGray} triggered a soundboard: ` +
      `${ansi.white}${emoji} ${soundName}${ansi.reset}`;

    const soundboardMessage = `\`\`\`ansi\n${ansi.darkGray}[${ansi.white}${timestamp}${ansi.darkGray}] ${logMsg}\n\`\`\``;

    await transcriptionChannel.send(soundboardMessage);

    console.log(
      `[INFO] Logged soundboard usage for ${user.username} in ${transcriptionChannel.name}`
    );

    if (settings.kickOnSoundboardSpam) {
      // 1) Use a single ISO timestamp for insert & query
      const now = new Date();
      const isoNow = now.toISOString();

      // 2) Insert soundboard usage
      const { error: insertError } = await supabase
        .from("soundboard_spam_log")
        .insert({
          userid: user_id,
          guildid: guild_id,
          timestamp: isoNow,
        });
      if (insertError) {
        console.error("[ERROR] Inserting soundboard usage:", insertError);
      }
      console.log(`[DEBUG] Inserted soundboard log at: ${isoNow}`);

      // 3) Give Supabase a moment to register the write
      await new Promise(resolve => setTimeout(resolve, 100));

      // 4) Query the last 2 seconds
      const twoSecondsAgo = new Date(now.getTime() - 2000).toISOString();
      console.log(`[DEBUG] Querying log entries since: ${twoSecondsAgo}`);
      const { data: usageData, error: queryError } = await supabase
        .from("soundboard_spam_log")
        .select("*")
        .eq("userid", user_id)
        .gte("timestamp", twoSecondsAgo);
      if (queryError) {
        console.error("[ERROR] Querying soundboard usage:", queryError);
      }
      console.log(`[DEBUG] Retrieved ${usageData?.length || 0} entries`);
      usageData?.forEach(entry =>
        console.log(`[DEBUG] Entry timestamp: ${entry.timestamp}`)
      );

      // 5) If they hit the spam threshold, kick them
      if ((usageData?.length || 0) >= 5) {
        if (member && member.voice?.channel) {
          await member.voice.disconnect("Soundboard spam detected");
          // clear all their entries so they only ever get kicked once per spam burst
          await supabase
            .from("soundboard_spam_log")
            .delete()
            .eq("userid", user_id);

          // Log to activity-logs if vcLoggingEnabled is true
          if (settings.vcLoggingEnabled && settings.vcLoggingChannelId) {
            const activityChannel = guild.channels.cache.get(
              settings.vcLoggingChannelId
            );
            if (activityChannel) {
              const now = new Date();
              const timestamp = now.toLocaleTimeString("en-US", {
                minute: "2-digit",
                second: "2-digit",
              });

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

              const logMsg = `[${roleColor}${topRole}${ansi.darkGray}] [${ansi.white}${userId}${ansi.darkGray}] ${roleColor}${username}${ansi.darkGray} was kicked by ${ansi.white}VC Tools${ansi.darkGray} for soundboard spamming.`;

              const buildLog = (msg) =>
                `\`\`\`ansi\n${ansi.darkGray}[${ansi.white}${timestamp}${ansi.darkGray}] ${msg}${ansi.reset}\n\`\`\``;

              await activityChannel.send(buildLog(logMsg)).catch(console.error);
            }
          }

          try {
            await user.send(
              "> <💥> Soundboard spam detected! You have been kicked from the voice channel."
            );
          } catch (dmError) {
            console.error(
              `[ERROR] Could not DM user ${user_id}:`,
              dmError.message
            );
          }

          // Ensure all their entries are cleared again after kick to avoid repeated triggers
          await supabase
            .from("soundboard_spam_log")
            .delete()
            .eq("userid", user_id);

          // Log the kick action
          console.log(
            `[INFO] Kicked user ${user_id} from VC for soundboard spam.`
          );
        }
      }

      // 6) Cleanup old records older than 5s
      const fiveSecondsAgo = new Date(Date.now() - 5000).toISOString();
      const { error: cleanupError } = await supabase
        .from("soundboard_spam_log")
        .delete()
        .lt("timestamp", fiveSecondsAgo);
      if (cleanupError) {
        console.error("[ERROR] Cleaning up soundboard spam log:", cleanupError);
      } else {
        console.log("[INFO] Old soundboard spam logs cleared.");
      }
    }
  } catch (error) {
    console.error("[ERROR] Failed to log soundboard use:", error);
  }
});

// Handle voiceStateUpdate and add Notification DM event
client.on("voiceStateUpdate", async (oldState, newState) => {
  // Existing voice channel manager logic
  voiceChannelManager.execute(oldState, newState, client);

  // When a user joins a voice channel, notify subscribers
  if (!oldState.channelId && newState.channelId) {
    const joinedUserId = newState.member.user.id;
    const guildId = newState.guild.id;

    console.log(`[DEBUG] User ${joinedUserId} joined VC in guild ${guildId}.`);

    try {
      // 1) Subscriptions
      const subscriptions = await listNotificationsForTarget(
        joinedUserId,
        guildId
      );
      console.log(
        `[DEBUG] Subscriptions for target ${joinedUserId}:`,
        subscriptions
      );

      // 2) Status Check
      const status = await getUserStatus(joinedUserId, guildId);
      console.log(`[DEBUG] Joined user's status: ${status}`);
      if (status === "invisible") {
        console.log(
          `[DEBUG] ${joinedUserId} is invisible — skip notifications.`
        );
      }
      if (status === "closed") {
        console.log(
          `[DEBUG] ${joinedUserId} is invisible — skip notifications.`
        );
      }

      // 3) If we have subs + not invisible, let's DM
      if (
        subscriptions?.length &&
        status !== "invisible" &&
        status !== "closed"
      ) {
        for (const sub of subscriptions) {
          try {
            console.log(`-- Checking subscriber: ${sub.user_id}`);

            // a) fetch subscriber
            const subscriberUser = await client.users.fetch(sub.user_id);
            if (!subscriberUser) {
              console.log(`[WARN] Could not fetch user ${sub.user_id}.`);
              continue;
            }

            // b) fetch the blocks the subscriber has set
            const blocks = await listUsersBlockedBy(joinedUserId, guildId);

            const isBlocked = blocks.some(
              (block) => block.blocked_id === sub.user_id
            );

            if (isBlocked) {
              console.log(
                `[INFO] Skipping DM to ${sub.user_id} — ${joinedUserId} has blocked them`
              );
              continue;
            }

            // c) fetch channel and guild
            const guild = client.guilds.cache.get(guildId);
            const channel =
              guild.channels.cache.get(newState.channelId) ||
              (await guild.channels
                .fetch(newState.channelId)
                .catch(() => null));

            // d) skip if the subscriber can't connect
            const guildMember = await guild.members
              .fetch(sub.user_id)
              .catch(() => null);
            if (
              !guildMember ||
              !channel?.permissionsFor(guildMember)?.has("Connect")
            ) {
              console.log(
                `[INFO] Skipping ${sub.user_id} — no access to connect to ${channel?.name}`
              );
              continue;
            }

            // e) skip if user is already in the same VC
            if (guildMember.voice.channelId === channel.id) {
              console.log(
                `[INFO] Skipping ${sub.user_id} — already in ${channel.name}`
              );
              continue;
            }

            // f) DM
            const channelMention = channel
              ? `<#${channel.id}>`
              : "a voice channel";
            const guildName = guild?.name || "(Unknown server)";

            await subscriberUser.send({
              content: `[❕] <@${joinedUserId}> just joined ${channelMention} inside **${guildName}**!`,
            });
            console.log(
              `[INFO] DM sent: Notified ${sub.user_id} about ${joinedUserId}`
            );
          } catch (err) {
            console.warn(
              `[WARN] Could not DM user ${sub.user_id} or fetch block info:`,
              err
            );
          }
        }
      } else {
        console.log(`[DEBUG] No subscriptions or user is invisible.`);
      }
    } catch (err) {
      console.error(`[ERROR] Sub error for ${joinedUserId}:`, err);
    }
  }
});

// Handle guild create event
client.on(Events.GuildCreate, async (guild) => {
  try {
    console.log(`[INFO] Joined a new guild: ${guild.name} (${guild.id})`);

    const botMember = await guild.members.fetchMe();
    await guild.channels.fetch();

    // Try to fetch the inviter (who added the bot)
    let inviter = null;
    let inviterMember = null;
    try {
      const auditLogs = await guild.fetchAuditLogs({
        type: AuditLogEvent.BotAdd,
        limit: 1,
      });
      inviter = auditLogs.entries.first()?.executor ?? null;
      if (inviter) {
        try { inviterMember = await guild.members.fetch(inviter.id); } catch { }
      }
    } catch (e) {
      console.warn("[WARN] Could not fetch audit logs:", e.message);
    }

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

    async function channelHasPublicMessages(channel) {
      try {
        if (!channel.isTextBased?.()) return false;
        const msgs = await channel.messages.fetch({ limit: 1 });
        return msgs?.size > 0;
      } catch {
        return false;
      }
    }

    // Find **most recent** channel where inviter spoke (best effort, rate-limit friendly)
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
        return tb - ta; // newest first
      });

      for (let i = 0; i < Math.min(sorted.length, channelScanLimit); i++) {
        const ch = sorted[i];
        try {
          const msgs = await ch.messages.fetch({ limit: perChannelMessages });
          if (msgs.find((m) => m.author?.id === member.id)) return ch;
        } catch { /* continue */ }
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

    // ─── 0) Try to DM inviter first ───
    let sentDM = false;
    if (inviter) {
      try {
        await inviter.send(`${welcomeMsg}\n\n${hierarchyMsg}`);
        console.log("[INFO] Sent welcome/setup message via DM to inviter.");
        sentDM = true;
      } catch (e) {
        console.warn("[WARN] Could not DM inviter, will try channels instead:", e.message);
      }
    }

    // If DM succeeded, skip public posting entirely.
    if (sentDM) {
      return;
    }

    // ─── Choose ONE target for both messages (fallback to channels) ───
    let target = null;

    // 1) Last place inviter spoke (if known)
    if (inviterMember) {
      target = await findMostRecentUserMessageChannel(guild, inviterMember, {
        channelScanLimit: 15,
        perChannelMessages: 25,
      });
    }

    // 2) First visible text channel with public messages
    if (!target) {
      target = await findFirstVisibleTextChannelWithHistory(guild, inviterMember || null);
    }

    // 3) System channel
    if (!target && guild.systemChannel && canBotSend(guild.systemChannel, inviterMember || null)) {
      target = guild.systemChannel;
    }

    if (!target) {
      console.warn("[WARN] No server location available to send messages.");
      return;
    }

    // Send both messages to the SAME place
    const isLowInHierarchy = botMember.roles.highest.position < guild.roles.highest.position;

    if (isLowInHierarchy) {
      try {
        await target.send(hierarchyMsg);
        console.log("[INFO] Sent hierarchy warning.");
      } catch (e) {
        console.warn("[WARN] Could not send hierarchy warning:", e.message);
      }
    }

    try {
      await target.send(welcomeMsg);
      console.log("[INFO] Sent welcome/setup message.");
    } catch (e) {
      console.warn("[WARN] Could not send welcome message:", e.message);
    }

  } catch (error) {
    console.error(`[ERROR] Guild join handling failed: ${error.stack}`);
  }
});

client.once("ready", async () => {
  console.log(`[INFO] Successfully logged in as ${client.user.tag}`);
  client.user.setPresence({ status: "idle" });
  console.log("Presence set to idle.");

  const { joinVoiceChannel, getVoiceConnection, VoiceConnectionStatus } = require("@discordjs/voice");
  const { audioListeningFunctions } = require("./events/voiceChannelManager.cjs");
  const { VC_STATE_PATH, saveVCState } = require("./util/vc_state.cjs");

  let lastKnownVCs = {};
  if (fs.existsSync(VC_STATE_PATH)) {
    try {
      lastKnownVCs = JSON.parse(fs.readFileSync(VC_STATE_PATH, "utf8"));
      console.log("[INFO] Loaded last VC state:", lastKnownVCs);
    } catch (err) {
      console.warn("[WARN] Failed to parse VC state file:", err.message);
    }
  }

  for (const guild of client.guilds.cache.values()) {
    const savedChannelId = lastKnownVCs[guild.id];
    if (!savedChannelId) continue;

    const settings = await getSettingsForGuild(guild.id);
    if (!settings.transcriptionEnabled) continue;

    const channel = guild.channels.cache.get(savedChannelId);
    if (!channel || channel.type !== ChannelType.GuildVoice) continue;

    const existingConnection = getVoiceConnection(guild.id);
    if (existingConnection) {
      try {
        existingConnection.destroy();
        await new Promise(r => setTimeout(r, 1000)); // short delay to ensure cleanup
        console.log(`[INFO] Destroyed stale VC connection in ${guild.name}`);
      } catch (e) {
        console.warn(`[WARN] Failed to destroy VC connection: ${e.message}`);
      }
    }

    try {
      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false,
      });

      connection.on(VoiceConnectionStatus.Ready, () => {
        console.log(`[INFO] Rejoined VC ${channel.name} in ${guild.name}`);
        saveVCState(guild.id, channel.id);
      });

      audioListeningFunctions(connection, guild);
    } catch (err) {
      console.error(`[JOIN ERROR] Failed to rejoin ${channel.name} in ${guild.name}:`, err);
    }
  }

  const now = new Date();
  const timestamp = now.toLocaleTimeString("en-US", {
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  try {
    const channel = await client.channels.fetch("1356838107818885151");
    if (channel && channel.send) {
      const ansi = {
        darkGray: '\u001b[2;30m',
        lightGray: '\u001b[2;37m',
        blue: '\u001b[2;34m',
        reset: '\u001b[0m',
      };

      await channel.send(
        "```ansi\n" +
        `${ansi.darkGray}[${ansi.blue}${timestamp}${ansi.darkGray}] ` +
        `${ansi.lightGray}VC Tools ${ansi.darkGray}is now ${ansi.blue}online${ansi.darkGray}.${ansi.reset}` +
        "```"
      );
      console.log("[INFO] Startup message sent to boot channel.");
    }
  } catch (err) {
    console.warn("[WARN] Failed to send startup message:", err.message);
  }

  // Cleanup old reports + reset presence if needed
  setInterval(async () => {
    try {
      await cleanupOldReports(client);
    } catch (error) {
      console.error("[ERROR] Failed during interval tasks:", error.message);
    }
  }, 10 * 60 * 1000); // every 10 minutes

  // Voice channel connection count
  setInterval(async () => {
    try {
      await cleanupOldReports(client);

      // 🎧 Update status text with VC count
      let vcCount = 0;
      let userCount = 0;

      client.guilds.cache.forEach(guild => {
        const vc = guild.members.me?.voice.channel;
        if (vc) {
          vcCount++;
          userCount += vc.members.filter(m => !m.user.bot).size;
        }
      });

      // Set presence accordingly
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

    } catch (error) {
      console.error("[ERROR] Failed during interval tasks:", error.message);
    }
  }, 30 * 1000); // every 30 seconds

});

// Global error handling
async function logGlobalError(client, error, context = "Unknown") {
  const errorMessage = error?.stack || error?.message || String(error);
  console.error(`[GLOBAL ERROR] ${context}:\n${errorMessage}`);

  const DEV_guildId = "1278554231346958398";
  const DEV_ERROR_channelId = "1334114350205636648";

  try {
    const devGuild = await client.guilds.fetch(DEV_guildId).catch(() => null);
    if (!devGuild) return console.error("[GLOBAL ERROR] Dev guild not found.");

    const devErrorChannel = await devGuild.channels.fetch(DEV_ERROR_channelId).catch(() => null);
    if (!devErrorChannel || !devErrorChannel.isTextBased())
      return console.error("[GLOBAL ERROR] Dev error channel not found or not text-based.");

    await devErrorChannel.send(
      `> **[GLOBAL ERROR] ${context}**\n\`\`\`\n${errorMessage.slice(0, 1900)}\n\`\`\``
    );
  } catch (err) {
    console.error("[GLOBAL ERROR] Failed to report error:", err);
  }
}

process.on("unhandledRejection", async (reason, promise) => {
  const errorText =
    reason instanceof Error
      ? reason.stack || reason.message
      : typeof reason === "object"
        ? JSON.stringify(reason, null, 2)
        : String(reason);

  console.error("[UNHANDLED REJECTION]", errorText);

  await logGlobalError(
    client,
    `Unhandled Rejection:\n${errorText}`,
    "process.on('unhandledRejection')"
  );
});

process.on("uncaughtException", async (error) => {
  console.error("[UNCAUGHT EXCEPTION]", error.stack || error.message);

  await logGlobalError(
    client,
    `Uncaught Exception:\n${error.stack || error.message}`,
    "process.on('uncaughtException')"
  );
});

// at bot bootstrap
client.rest.on('rateLimited', (info) => {
  console.warn(
    `[RATE LIMIT] route=${info.route} timeout=${info.timeToReset}ms global=${info.global}`
  );
});

// Optional: see when you’re approaching Discord’s invalid-request thresholds
client.rest.on('invalidRequestWarningData', (data) => {
  console.warn(
    `[INVALID WARN] count=${data.count} remaining=${data.remaining} resetAfter=${data.resetAfter}ms`
  );
});

// Handle prefix commands (refactored to use commands.onMessageCreate)
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  await commands.onMessageCreate(message);
});

// Handle slash commands, buttons, and dropdowns (refactored)
client.on("interactionCreate", async (interaction) => {
  try {
    await commands.onInteractionCreate(interaction);
  } catch (error) {
    console.error(`[ERROR] Interaction handling failed: ${error.message}`);
    if (!interaction.replied && interaction.isRepliable?.()) {
      await interaction.reply({
        content:
          "> <❌> An error occurred while processing your interaction. (INT_ERR_006)",
        ephemeral: true,
      });
    }
  }
});

// Handle message reactions
client.on("messageReactionAdd", async (reaction, user) => {
  try {
    await handleReaction(reaction, user);
  } catch (error) {
    console.error("[ERROR] Failed to process reaction:", error);
  }
});

// Login the bot
client.login(process.env.DISCORD_TOKEN);

// Export the client for external usage
module.exports = { client };
