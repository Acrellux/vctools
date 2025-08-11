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
  return (
    guild.ownerId === member.id ||
    member.permissions.has("Administrator") ||
    member.roles.cache.has(settings.adminRoleId)
  );
}

/**
 * Logs an error message to the configured error logs channel.
 * @param {string} guildId - The guild ID.
 * @param {string} errorMessage - The error message or stack trace.
 * @param {Client} client - The Discord client.
 * @param {string} [context="General"] - Optional context.
 */
function logErrorToChannel(guildId, errorMessage, client, context = "General") {
  if (!guildId || !client)
    return console.error("[ERROR] Missing guildId or client.");

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
      const censoredErrorMessage = errorMessage.replaceAll(
        /C:\\Users\\[^\\]+\\/g,
        "C:\\Users\\Server\\"
      );

      const formattedError = `> **Error in ${context}:**\n\`\`\`\n${censoredErrorMessage}\n\`\`\``;

      // If error is too big (Discord limit 2000 characters), shorten it
      if (formattedError.length > 1900) {
        const shortError = censoredErrorMessage.split("\n").slice(0, 10).join("\n");
        await channel.send(`> **Error in ${context} (truncated):**\n\`\`\`\n${shortError}\n...\n\`\`\``).catch(console.error);
      } else {
        await channel.send(formattedError).catch(console.error);
      }
    })
    .catch((err) => {
      console.error(`[ERROR] Failed to retrieve settings for logging:`, err);
    });
}

/**
 * Creates a dropdown for selecting a text channel.
 * @param {string} mode - Operation mode (e.g., "init", "settings").
 * @param {Guild} guild - The Discord guild.
 * @param {string} userId - The user ID.
 * @param {string|null} currentchannelId - Currently selected channel ID.
 * @returns {ActionRowBuilder} - The action row with the channel dropdown.
 */
function createchannelIdropdown(mode, guild, userId, currentchannelId) {
  const channelOptions = guild.channels.cache
    .filter((channel) => channel.type === ChannelType.GuildText)
    .map((channel) => ({
      label: `#${String(channel.name).slice(0, 100)}`,
      value: String(channel.id),
      default: String(channel.id) === String(currentchannelId),
    }));

  if (mode === "init") {
    channelOptions.unshift({
      label: "Make a new channel",
      value: "new_channel",
    });
  }

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`${mode}:select_logging_channel:${userId}`)
      .setPlaceholder("Choose a logging channel...")
      .setOptions(channelOptions)
      .setMinValues(1)
      .setMaxValues(1)
  );
}

/**
 * Creates a dropdown for selecting an error logs channel.
 * @param {string} mode - Operation mode.
 * @param {Guild} guild - The Discord guild.
 * @param {string} userId - The user ID.
 * @param {string|null} currentchannelId - Currently selected channel ID.
 * @returns {ActionRowBuilder} - The action row with the error logs channel dropdown.
 */
function createErrorLogchannelIdropdown(mode, guild, userId, currentchannelId) {
  const channelOptions = guild.channels.cache
    .filter((channel) => channel.type === ChannelType.GuildText)
    .map((channel) => ({
      label: `#${String(channel.name).slice(0, 100)}`,
      value: String(channel.id),
      default: String(channel.id) === String(currentchannelId),
    }));

  if (mode === "init") {
    channelOptions.unshift({
      label: "Create a new error logs channel",
      value: "new_channel",
    });
  }

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`${mode}:select_error_logs_channel:${String(userId)}`)
      .setPlaceholder("Choose an error logs channel...")
      .setOptions(channelOptions)
      .setMinValues(1)
      .setMaxValues(1)
  );
}

/**
 * Creates a dropdown for selecting a role for log access.
 * @param {string} mode - Operation mode.
 * @param {Guild} guild - The Discord guild.
 * @param {string} userId - The user ID.
 * @param {string|null} currentRoleId - Currently selected role ID.
 * @returns {ActionRowBuilder} - The action row with the role dropdown.
 */
function createRoleDropdown(mode, guild, userId, currentRoleId) {
  const roleOptions = guild.roles.cache
    .filter((r) => r.name !== "@everyone")
    .map((r) => ({
      label: `@${String(r.name).slice(0, 100)}`,
      value: String(r.id),
      default: String(r.id) === String(currentRoleId),
    }));

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`${mode}:select_log_viewers:${userId}`)
    .setPlaceholder("Select a role...")
    .setOptions(roleOptions)
    .setMinValues(1)
    .setMaxValues(1);

  return new ActionRowBuilder().addComponents(selectMenu);
}

/**
 * Creates a dropdown for selecting a role for error logs access.
 * @param {string} mode - Operation mode.
 * @param {Guild} guild - The Discord guild.
 * @param {string} userId - The user ID.
 * @param {string|null} currentRoleId - Currently selected role ID.
 * @returns {ActionRowBuilder} - The action row with the error logs role dropdown.
 */
function createErrorLogRoleDropdown(mode, guild, userId, currentRoleId) {
  const roleOptions = guild.roles.cache.map((role) => ({
    label: role.name === "@everyone" ? "@everyone" : `@${String(role.name).slice(0, 100)}`,
    value: String(role.id),
    default: String(role.id) === String(currentRoleId),
  }));

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`${mode}:select_error_logs_role:${userId}`)
      .setPlaceholder("Select a role...")
      .setOptions(roleOptions)
      .setMinValues(1)
      .setMaxValues(1)
  );
}

/*
  * Checks if the target user is valid for operations.
  * @param {User} user - The user to check.
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