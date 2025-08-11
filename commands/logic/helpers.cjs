// helpers.cjs

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
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

/**
 * Utility: build safe min/max (1..25) for select menus.
 * Ensures we never send NaN/0 to Discord.
 */
function safeMax(len) {
  return Math.min(25, Math.max(1, Number(len) || 1));
}

/**
 * Creates a dropdown for selecting a text channel (logging).
 * @param {string} mode - Combined action scope, e.g. "init:select_logging_channel"
 * @param {import("discord.js").Guild} guild
 * @param {string} userId
 * @param {string|null} currentchannelId
 * @returns {ActionRowBuilder}
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

  // Allow a "create new" sentinel during init (first, but only if there are any real choices or not)
  const withNew = mode.startsWith("init:")
    ? [{ label: "Make a new channel", value: "new_channel" }, ...options]
    : options;

  const safe = withNew.length
    ? withNew
    : [
        {
          label: "No text channels found",
          value: "placeholder-no-channels",
          default: true,
        },
      ];

  const max = safeMax(safe.length);

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`${mode}:${String(userId)}`) // e.g. "init:select_logging_channel:<userId>"
      .setPlaceholder("Choose a logging channel...")
      .setMinValues(1)
      .setMaxValues(max)
      .addOptions(safe)
  );
}

/**
 * Creates a dropdown for selecting an error logs channel.
 * @param {string} mode - e.g. "init:select_error_logs_channel"
 * @param {import("discord.js").Guild} guild
 * @param {string} userId
 * @param {string|null} currentchannelId
 * @returns {ActionRowBuilder}
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

  const withNew = mode.startsWith("init:")
    ? [{ label: "Create a new error logs channel", value: "new_channel" }, ...options]
    : options;

  const safe = withNew.length
    ? withNew
    : [
        {
          label: "No text channels found",
          value: "placeholder-no-channels",
          default: true,
        },
      ];

  const max = safeMax(safe.length);

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`${mode}:${String(userId)}`) // e.g. "init:select_error_logs_channel:<userId>"
      .setPlaceholder("Choose an error logs channel...")
      .setMinValues(1)
      .setMaxValues(max)
      .addOptions(safe)
  );
}

/**
 * Creates a dropdown for selecting a role for log access.
 * Filters @everyone + managed roles.
 * @param {string} mode - e.g. "init:select_admin_role"
 * @param {import("discord.js").Guild} guild
 * @param {string} userId
 * @param {string|null} currentRoleId
 * @returns {ActionRowBuilder}
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
    : [
        {
          label: "No eligible roles found",
          value: "placeholder-no-roles",
          default: true,
        },
      ];

  const max = safeMax(safe.length);

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`${mode}:${String(userId)}`) // e.g. "init:select_admin_role:<userId>"
      .setPlaceholder("Select a role...")
      .setMinValues(1)
      .setMaxValues(max)
      .addOptions(safe)
  );
}

/**
 * Creates a dropdown for selecting a role for error logs access.
 * Includes @everyone (if you want to let the server choose broad visibility).
 * @param {string} mode - e.g. "init:select_error_logs_role"
 * @param {import("discord.js").Guild} guild
 * @param {string} userId
 * @param {string|null} currentRoleId
 * @returns {ActionRowBuilder}
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
    : [
        {
          label: "No roles found",
          value: "placeholder-no-roles",
          default: true,
        },
      ];

  const max = safeMax(safe.length);

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`${mode}:${String(userId)}`) // e.g. "init:select_error_logs_role:<userId>"
      .setPlaceholder("Select a role...")
      .setMinValues(1)
      .setMaxValues(max)
      .addOptions(safe)
  );
}

/*
 * Checks if the target user is valid for operations.
 * @param {import("discord.js").User} user
 * @return {string|null} - Returns an error message if invalid, otherwise null.
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