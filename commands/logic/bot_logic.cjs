const {
  Client,
  GatewayIntentBits,
  Partials,
  Collection,
  Events,
  Message,
  Interaction,
  PermissionsBitField,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  SlashCommandBuilder,
} = require("discord.js");

const { interactionContexts } = require("../../database/contextStore.cjs");
const {
  getSettingsForGuild,
  updateSettingsForGuild,
} = require("../settings.cjs");
const {
  createRoleDropdown,
  requiredManagerPermissions,
  logErrorToChannel,
} = require("./helpers.cjs");

async function showBotSettingsUI(interactionOrMessage, isEphemeral = false) {
  try {
    const guild = interactionOrMessage.guild;
    if (!guild) {
      console.error("[ERROR] Guild is undefined in showBotSettingsUI");
      return;
    }

    // Check permissions
    const member = interactionOrMessage.member;
    if (!member || !member.permissions.has(requiredManagerPermissions)) {
      const response =
        "> <❌> You do not have the required permissions to use this command. (CMD_ERR_008)";
      if (interactionOrMessage.author) {
        await interactionOrMessage.channel.send(response);
      } else {
        await interactionOrMessage.reply({
          content: response,
          ephemeral: true,
        });
      }
      return;
    }

    // Retrieve settings; ensure we always have an object.
    let settings = (await getSettingsForGuild(guild.id)) || {};
    console.log(`[DEBUG] Loaded settings for guild ${guild.id}:`, settings);

    // For debugging: Check for both camelCase and snake_case
    const adminRoleId = settings.adminRoleId || settings.admin_role_id || null;
    const modRoleId =
      settings.moderatorRoleId || settings.moderator_role_id || null;
    console.log(`[DEBUG] adminRoleId: ${adminRoleId}, modRoleId: ${modRoleId}`);

    // Retrieve roles from cache (if they exist)
    const adminRole = adminRoleId ? guild.roles.cache.get(adminRoleId) : null;
    const modRole = modRoleId ? guild.roles.cache.get(modRoleId) : null;
    console.log(
      `[DEBUG] Retrieved roles: Admin: ${
        adminRole ? adminRole.name : "Not set"
      }, Moderator: ${modRole ? modRole.name : "Not set"}`
    );

    // Retrieve the VC Logging Channel from cache (if set)
    const vcLoggingChannelId =
      settings.vcLoggingChannelId || settings.vc_logging_channel_id || null;
    const vcLoggingChannel = vcLoggingChannelId
      ? guild.channels.cache.get(vcLoggingChannelId)
      : null;

    // Updated settings message including VC Logging status and channel.
    const contentMessage = `## ◈ **Bot Settings**
> **Admin Role:** ${adminRole ? adminRole.name : "Not set"}
> **Moderator Role:** ${modRole ? modRole.name : "Not set"}
> **Notify for Activity Reports:** ${
      settings.notifyActivityReports ? "Enabled" : "Disabled"
    }
> **VC Event Logging Channel:** ${
      vcLoggingChannel ? vcLoggingChannel.name : "Not set"
    }
> **VC Event Logging:** ${settings.vcLoggingEnabled ? "Enabled" : "Disabled"}`;

    const userId =
      interactionOrMessage.user?.id || interactionOrMessage.author?.id;

    // Create dropdowns with the current role IDs for pre-selection.
    const adminRoleDropdown = createRoleDropdown(
      `bot:select-admin-role:${userId}`,
      guild,
      userId,
      adminRoleId
    );
    const moderatorRoleDropdown = createRoleDropdown(
      `bot:select-moderator-role:${userId}`,
      guild,
      userId,
      modRoleId
    );

    // Create the toggle button for Activity Reports.
    const toggleActivityNotificationsButton = new ButtonBuilder()
      .setCustomId(`bot:toggle-notify-activity-reports:${userId}`)
      .setLabel(
        settings.notifyActivityReports
          ? "Disable Notify for Activity Reports"
          : "Enable Notify for Activity Reports"
      )
      .setStyle(
        settings.notifyActivityReports
          ? ButtonStyle.Danger
          : ButtonStyle.Success
      );
    const toggleRow = new ActionRowBuilder().addComponents(
      toggleActivityNotificationsButton
    );

    // Create the toggle button for VC Logging.
    const toggleVcLoggingButton = new ButtonBuilder()
      .setCustomId(`bot:toggle-vc-logging:${userId}`)
      .setLabel(
        settings.vcLoggingEnabled
          ? "Disable VC Event Logging"
          : "Enable VC Event Logging"
      )
      .setStyle(
        settings.vcLoggingEnabled ? ButtonStyle.Danger : ButtonStyle.Success
      );
    const toggleVcLoggingRow = new ActionRowBuilder().addComponents(
      toggleVcLoggingButton
    );

    // Create a dropdown for VC Logging Channel selection.
    const vcLoggingChannelOptions = guild.channels.cache
      .filter((ch) => ch.type === ChannelType.GuildText)
      .map((ch) => ({
        label: `#${ch.name}`,
        value: ch.id,
        default: ch.id === vcLoggingChannelId,
      }));

    const vcLoggingChannelDropdown = new StringSelectMenuBuilder()
      .setCustomId(`bot:select-vc-logging-channel:${userId}`)
      .setPlaceholder("Select a channel for VC Logging")
      .addOptions(vcLoggingChannelOptions);
    const vcLoggingChannelRow = new ActionRowBuilder().addComponents(
      vcLoggingChannelDropdown
    );

    // Aggregate all components
    const components = [
      adminRoleDropdown,
      moderatorRoleDropdown,
      toggleRow,
      vcLoggingChannelRow,
      toggleVcLoggingRow,
    ];

    // Send or update the message based on whether interactionOrMessage is repliable
    if (interactionOrMessage.isRepliable?.()) {
      if (interactionOrMessage.replied || interactionOrMessage.deferred) {
        await interactionOrMessage.editReply({
          content: contentMessage,
          components,
        });
      } else {
        await interactionOrMessage.reply({
          content: contentMessage,
          components,
          ephemeral: isEphemeral,
        });
      }
    } else {
      await interactionOrMessage.channel.send({
        content: contentMessage,
        components,
      });
    }
  } catch (error) {
    console.error(`[ERROR] showBotSettingsUI failed: ${error.message}`);
    console.error(error.stack);
    logErrorToChannel(
      interactionOrMessage.guild?.id,
      error.stack,
      interactionOrMessage.client,
      "showBotSettingsUI"
    );
    if (interactionOrMessage.isRepliable?.()) {
      if (interactionOrMessage.replied || interactionOrMessage.deferred) {
        await interactionOrMessage.editReply({
          content:
            "> <❌> An error occurred displaying Bot settings. (INT_ERR_006)",
        });
      } else {
        await interactionOrMessage.reply({
          content:
            "> <❌> An error occurred displaying Bot settings. (INT_ERR_006)",
          ephemeral: true,
        });
      }
    } else {
      await interactionOrMessage.channel.send(
        "> <❌> An error occurred displaying Bot settings. (INT_ERR_006)"
      );
    }
  }
}

module.exports = {
  showBotSettingsUI,
};
