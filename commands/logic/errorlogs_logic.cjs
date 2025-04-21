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
  createErrorLogchannelIdropdown,
  createErrorLogRoleDropdown,
  requiredManagerPermissions,
  logErrorToChannel,
} = require("./helpers.cjs");

async function showErrorLogsSettingsUI(
  interactionOrMessage,
  isEphemeral = false
) {
  try {
    const guild = interactionOrMessage.guild;
    if (!guild) return;
    const member = interactionOrMessage.member;

    // Permission check
    if (!member.permissions.has(requiredManagerPermissions)) {
      const noPermissionMessage =
        "> <❌> You do not have the required permissions to use this command. (CMD_ERR_008)";
      if (interactionOrMessage instanceof Message) {
        await interactionOrMessage.channel.send(noPermissionMessage);
      } else {
        await interactionOrMessage.reply({
          content: noPermissionMessage,
          ephemeral: true,
        });
      }
      return;
    }

    const settings = await getSettingsForGuild(guild.id);
    const userId =
      interactionOrMessage instanceof Message
        ? interactionOrMessage.author.id
        : interactionOrMessage.user.id;

    const contentMessage = `## ◈ **Error Logs Settings**
    > **Error Logging:** ${settings.errorLogsEnabled ? "Enabled" : "Disabled"}
    > **Error Logs Channel:** ${settings.errorLogsChannelId
        ? `<#${settings.errorLogsChannelId}>`
        : "Not set"
      }
    > **Error Logs Role:** ${settings.errorLogsRoleId
        ? guild.roles.cache.get(settings.errorLogsRoleId)?.name ||
        "Unknown Role"
        : "Not set"
      }`;

    // 🛠 Reset components to avoid duplication
    const components = [];

    // Add buttons
    const errorLogsButtons = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`settings:enable-error-logging:${userId}`)
        .setLabel("Enable Error Logging")
        .setStyle(ButtonStyle.Success)
        .setDisabled(settings.errorLogsEnabled),
      new ButtonBuilder()
        .setCustomId(`settings:disable-error-logging:${userId}`)
        .setLabel("Disable Error Logging")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(!settings.errorLogsEnabled)
    );

    // Add dropdowns
    const errorLogchannelIdropdown = createErrorLogchannelIdropdown(
      "settings",
      guild,
      userId,
      settings.errorLogsChannelId
    );
    const errorLogRoleDropdown = createErrorLogRoleDropdown(
      "settings",
      guild,
      userId,
      settings.errorLogsRoleId
    );

    // Push components ensuring they're added only once
    components.push(
      errorLogsButtons,
      errorLogchannelIdropdown,
      errorLogRoleDropdown
    );

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
    console.error(`[ERROR] showErrorLogsSettingsUI failed: ${error.message}`);
    await logErrorToChannel(
      interactionOrMessage.guild?.id,
      error.stack,
      interactionOrMessage.client,
      "showErrorLogsSettingsUI"
    );

    const errorMessage =
      "> <❌> An error occurred displaying error logs settings. (INT_ERR_006)";
    if (interactionOrMessage.isButton?.()) {
      await interactionOrMessage.update({
        content: contentMessage,
        components,
      });
    } else if (interactionOrMessage.isRepliable?.()) {
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
      await interactionOrMessage.channel.send(errorMessage);
    }
  }
}

const { handleErrorLogsFlow } = require("../initialization/errorlogs.cjs");

module.exports = {
  showErrorLogsSettingsUI,
  handleErrorLogsFlow,
};
