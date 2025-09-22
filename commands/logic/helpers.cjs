// helpers.cjs

const {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ChannelType,
  PermissionsBitField,
} = require("discord.js");
const { getSettingsForGuild } = require("../settings.cjs");

/**
 * Dynamically checks if the user is an admin based on adminRoleId or ownership.
 * Use anywhere that used `requiredManagerPermissions`.
 */
async function requiredManagerPermissions(interactionOrMessage) {
  const guild = interactionOrMessage?.guild;
  const member = interactionOrMessage?.member;
  if (!guild || !member) return false;

  const settings = (await getSettingsForGuild(guild.id)) || {};
  const adminRoleId = settings.adminRoleId;

  return (
    guild.ownerId === member.id ||
    member.permissions?.has?.(PermissionsBitField.Flags.Administrator) ||
    (adminRoleId ? member.roles?.cache?.has?.(adminRoleId) : false)
  );
}

/**
 * Robust error logger that will never crash your app.
 * - Pre-checks perms on the log channel
 * - Falls back to the invoking context (message/interaction) ephemerally
 * - Censors local Windows paths for safety
 *
 * @param {string} guildId
 * @param {string|Error} errorMessage
 * @param {import('discord.js').Client} client
 * @param {string} [context="General"]
 * @param {import('discord.js').Message|import('discord.js').Interaction} [ctx]
 */
async function logErrorToChannel(guildId, errorMessage, client, context = "General", ctx) {
  try {
    if (!guildId || !client) {
      console.error("[ERROR] Missing guildId or client.");
      return;
    }

    const settings = (await getSettingsForGuild(guildId)) || {};
    const channelId = settings.errorLogsChannelId;
    if (!channelId) {
      console.error(`[ERROR] ${context}: ${String(errorMessage)}`);
      return;
    }

    const guild =
      client.guilds.cache.get(guildId) || (await client.guilds.fetch(guildId).catch(() => null));
    if (!guild) {
      console.error("[ERROR] Guild not found.");
      return;
    }

    const channel =
      guild.channels.cache.get(channelId) || (await guild.channels.fetch(channelId).catch(() => null));
    if (!channel) {
      console.error("[ERROR] Error logs channel not found in guild.");
      return;
    }

    // Pre-check permissions to avoid 50013 spam
    const mePerms = channel.permissionsFor?.(guild.members.me);
    const canSend =
      !!mePerms &&
      mePerms.has(PermissionsBitField.Flags.ViewChannel) &&
      mePerms.has(PermissionsBitField.Flags.SendMessages);

    // SAFELY replace only the path root(s)
    const raw = String(errorMessage?.stack || errorMessage || "");
    const censoredErrorMessage = raw.replaceAll(/C:\\Users\\[^\\]+\\/g, "C:\\Users\\Server\\");
    let content = `> **Error in ${context}:**\n\`\`\`\n${censoredErrorMessage}\n\`\`\``;

    if (content.length > 1900) {
      const shortError = censoredErrorMessage.split("\n").slice(0, 40).join("\n");
      content = `> **Error in ${context} (truncated):**\n\`\`\`\n${shortError}\n...\n\`\`\``;
    }

    if (canSend && channel.type === ChannelType.GuildText) {
      await channel.send({ content }).catch(() => { });
      return;
    }

    // Fallback: inform the invoker ephemerally if we can
    if (ctx) {
      try {
        // Message context
        if ("reply" in ctx && ctx.reply) {
          await ctx.reply({
            content:
              "> <❌> I can’t write to the configured error-log channel. Ask an admin to grant me **View Channel** and **Send Messages**.",
            allowedMentions: { parse: [] },
          }).catch(() => { });
        } else {
          // Interaction context
          if (!ctx.replied && !ctx.deferred) {
            await ctx.reply({
              content:
                "> <❌> I can’t write to the configured error-log channel. Ask an admin to grant me **View Channel** and **Send Messages**.",
              ephemeral: true,
            }).catch(() => { });
          } else {
            await ctx.followUp({
              content:
                "> <❌> I can’t write to the configured error-log channel. Ask an admin to grant me **View Channel** and **Send Messages**.",
              ephemeral: true,
            }).catch(() => { });
          }
        }
      } catch { }
    }

    // Always leave a breadcrumb in console
    console.warn(`[LOG ERROR] Missing perms to post in ${channelId} (${context})`);
  } catch (e) {
    console.warn(`[LOG ERROR] ${e.message}`);
  }
}

/** Utility: clamp 1..25 for select menus */
function safeMax(len) {
  return Math.min(25, Math.max(1, Number(len) || 1));
}

/**
 * Channel dropdown for transcription logs.
 * Always emits: customId = "init:select_logging_channel:<userId>"
 */
function createchannelIdropdown(mode, guild, userId, currentchannelId) {
  const options = guild.channels.cache
    .filter((ch) => ch.type === ChannelType.GuildText && ch.viewable)
    .map((ch) => ({
      label: `#${String(ch.name).slice(0, 100)}`,
      value: String(ch.id),
      default: String(ch.id) === String(currentchannelId),
    }))
    .slice(0, 25);

  const withNew = mode?.startsWith?.("init:")
    ? [{ label: "➕ Create new #transcription-logs", value: "new_channel" }, ...options]
    : options;

  const safe = withNew.length
    ? withNew
    : [{ label: "No text channels found", value: "placeholder-no-channels", default: true }];

  const max = safeMax(safe.length);

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`init:select_logging_channel:${String(userId)}`)
      .setPlaceholder("Choose a logging channel…")
      .setMinValues(1)
      .setMaxValues(max)
      .addOptions(safe)
  );
}

/**
 * Channel dropdown for error logs.
 * Always emits: customId = "init:select_error_logs_channel:<userId>"
 */
function createErrorLogchannelIdropdown(mode, guild, userId, currentchannelId) {
  const options = guild.channels.cache
    .filter((ch) => ch.type === ChannelType.GuildText && ch.viewable)
    .map((ch) => ({
      label: `#${String(ch.name).slice(0, 100)}`,
      value: String(ch.id),
      default: String(ch.id) === String(currentchannelId),
    }))
    .slice(0, 25);

  const withNew = mode?.startsWith?.("init:")
    ? [{ label: "➕ Create new #error-logs", value: "new_channel" }, ...options]
    : options;

  const safe = withNew.length
    ? withNew
    : [{ label: "No text channels found", value: "placeholder-no-channels", default: true }];

  const max = safeMax(safe.length);

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`init:select_error_logs_channel:${String(userId)}`)
      .setPlaceholder("Choose an error logs channel…")
      .setMinValues(1)
      .setMaxValues(max)
      .addOptions(safe)
  );
}

/**
 * Role dropdown used by multiple flows.
 * @param {string} customId - MUST be unique within the message (e.g., "bot:select-admin-role:<userId>")
 */
function createRoleDropdown(customId, guild, userId, currentRoleId) {
  const options = guild.roles.cache
    .filter((r) => r.name !== "@everyone" && !r.managed)
    .map((r) => ({
      label: `@${String(r.name).slice(0, 100)}`,
      value: String(r.id),
      default: String(r.id) === String(currentRoleId),
    }))
    .slice(0, 25);

  const safe = options.length
    ? options
    : [{ label: "No eligible roles found", value: "placeholder-no-roles", default: true }];

  const max = safeMax(safe.length);

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(String(customId))
      .setPlaceholder("Select a role…")
      .setMinValues(1)
      .setMaxValues(max)
      .addOptions(safe)
  );
}

/**
 * Role dropdown for error logs visibility.
 * Always emits: customId = "init:select_error_logs_role:<userId>"
 */
function createErrorLogRoleDropdown(mode, guild, userId, currentRoleId) {
  const options = guild.roles.cache
    .map((role) => ({
      label: role.name === "@everyone" ? "@everyone" : `@${String(role.name).slice(0, 100)}`,
      value: String(role.id),
      default: String(role.id) === String(currentRoleId),
    }))
    .slice(0, 25);

  const safe = options.length
    ? options
    : [{ label: "No roles found", value: "placeholder-no-roles", default: true }];

  const max = safeMax(safe.length);

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`init:select_error_logs_role:${String(userId)}`)
      .setPlaceholder("Select a role to view error logs…")
      .setMinValues(1)
      .setMaxValues(max)
      .addOptions(safe)
  );
}

/*
 * Checks if the target user is valid for operations.
 */
const VC_TOOLS_BOT_ID = "1278547607798415401";
function isInvalidTarget(user) {
  if (!user) return "User not found.";
  if (user.id === VC_TOOLS_BOT_ID) return "You can't target VC Tools.";
  return null;
}

module.exports = {
  logErrorToChannel,
  createchannelIdropdown,
  createErrorLogchannelIdropdown,
  createRoleDropdown,
  createErrorLogRoleDropdown,
  requiredManagerPermissions,
  isInvalidTarget,
};