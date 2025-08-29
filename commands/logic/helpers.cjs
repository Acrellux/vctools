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
  const guild = interactionOrMessage.guild;
  const member = interactionOrMessage.member;
  if (!guild || !member) return false;

  const settings = (await getSettingsForGuild(guild.id)) || {};
  const adminRoleId = settings.adminRoleId;

  return (
    guild.ownerId === member.id ||
    member.permissions?.has?.(PermissionsBitField.Flags.Administrator) ||
    (adminRoleId ? member.roles.cache.has(adminRoleId) : false)
  );
}

/**
 * Logs an error message to the configured error logs channel.
 * @param {string} guildId - The guild ID.
 * @param {string} errorMessage - The error message or stack trace.
 * @param {import("discord.js").Client} client - The Discord client.
 * @param {string} [context="General"] - Optional context.
 */
function logErrorToChannel(guildId, errorMessage, client, context = "General") {
  if (!guildId || !client) {
    console.error("[ERROR] Missing guildId or client.");
    return;
  }

  getSettingsForGuild(guildId)
    .then(async (settings) => {
      if (!settings || !settings.errorLogsChannelId) {
        console.error(`[ERROR] ${context}: ${errorMessage}`);
        return;
      }

      const guild = client.guilds.cache.get(guildId);
      if (!guild) {
        console.error("[ERROR] Guild not found.");
        return;
      }

      const channel = guild.channels.cache.get(settings.errorLogsChannelId);
      if (!channel) {
        console.error("[ERROR] Error logs channel not found in guild.");
        return;
      }

      // SAFELY replace only the path root
      const censoredErrorMessage = String(errorMessage).replaceAll(
        /C:\\Users\\[^\\]+\\/g,
        "C:\\Users\\Server\\"
      );

      const formattedError = `> **Error in ${context}:**\n\`\`\`\n${censoredErrorMessage}\n\`\`\``;

      // If error is too big (Discord limit 2000 characters), shorten it
      if (formattedError.length > 1900) {
        const shortError = censoredErrorMessage.split("\n").slice(0, 10).join("\n");
        await channel
          .send(`> **Error in ${context} (truncated):**\n\`\`\`\n${shortError}\n...\n\`\`\``)
          .catch(console.error);
      } else {
        await channel.send(formattedError).catch(console.error);
      }
    })
    .catch((err) => {
      console.error(`[ERROR] Failed to retrieve settings for logging:`, err);
    });
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
 * Role dropdown used by multiple init steps.
 * Emits:
 *  - "init:select_log_viewers:<userId>" for admin/mod/log-viewers steps
 *  - "init:select_vcmoderator_role:<userId>" for VC moderator step
 */
function createRoleDropdown(mode, guild, userId, currentRoleId) {
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

  const isVCMod =
    mode === "init_vcmoderator_role" ||
    mode === "init:select_vcmoderator_role";

  const action = isVCMod ? "select_vcmoderator_role" : "select_log_viewers";

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`init:${action}:${String(userId)}`)
      .setPlaceholder(isVCMod ? "Select a Voice Channel Moderator role…" : "Select a role…")
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
