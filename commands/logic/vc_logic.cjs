const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ChannelType,
  Message,
} = require("discord.js");
const {
  getSettingsForGuild,
  updateSettingsForGuild,
  updateChannelPermissionsForGuild,
} = require("../settings.cjs");
const { createRoleDropdown } = require("./helpers.cjs");
const { logErrorToChannel } = require("./helpers.cjs");
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const { requiredManagerPermissions } = require("./helpers.cjs");

async function showVCSettingsUI(interactionOrMessage, isEphemeral = false) {
  try {
    const guild = interactionOrMessage.guild;
    if (!guild) return;

    // Permission check
    if (!(await requiredManagerPermissions(interactionOrMessage))) {
      const noPermissionMessage =
        "> <❇️> You do not have the required permissions to do this. (CMD_ERR_008)";
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

    // Display the current Voice Call Ping role.
    const roleName = settings.voiceCallPingRoleId
      ? guild.roles.cache.get(settings.voiceCallPingRoleId)?.name ||
      "Unknown Role"
      : "Not set";

    const contentMessage = `## ◈ **VC Settings**
> **Voice Call Ping Role:** ${roleName}
> **Notify on Bad Words:** ${settings.notifyBadWord ? "Enabled" : "Disabled"}
> **Notify for Loud Users:** ${settings.notifyLoudUser ? "Enabled" : "Disabled"}
> **Soundboard Logging:** ${settings.soundboardLogging ? "Enabled" : "Disabled"}
> **Kick on Soundboard Spam:** ${settings.kickOnSoundboardSpam ? "Enabled" : "Disabled"
      }`;

    // Create dropdown for VC Ping role selection.
    const vcRoleDropdown = createRoleDropdown(
      `vcsettings:select-log-viewers:${userId}`,
      guild,
      userId,
      settings.voiceCallPingRoleId
    );

    // Create toggle buttons for notifications.
    const togglenotifyBadWordButton = new ButtonBuilder()
      .setCustomId(`vcsettings:toggle-badword:${userId}`)
      .setLabel(
        settings.notifyBadWord
          ? "Disable Notify on Bad Words"
          : "Enable Notify on Bad Words"
      )
      .setStyle(
        settings.notifyBadWord ? ButtonStyle.Danger : ButtonStyle.Success
      );

    const togglenotifyLoudUserButton = new ButtonBuilder()
      .setCustomId(`vcsettings:toggle-loud-user:${userId}`)
      .setLabel(
        settings.notifyLoudUser
          ? "Disable Notify for Loud Users"
          : "Enable Notify for Loud Users"
      )
      .setStyle(
        settings.notifyLoudUser ? ButtonStyle.Danger : ButtonStyle.Success
      );

    const togglesoundboardLoggingButton = new ButtonBuilder()
      .setCustomId(`vcsettings:toggle-soundboard-logging:${userId}`)
      .setLabel(
        settings.soundboardLogging
          ? "Disable Soundboard Logging"
          : "Enable Soundboard Logging"
      )
      .setStyle(
        settings.soundboardLogging ? ButtonStyle.Danger : ButtonStyle.Success
      );

    // NEW: Button for Kick on Soundboard Spam toggle.
    const toggleKickSoundboardButton = new ButtonBuilder()
      .setCustomId(`vcsettings:toggle-kick-soundboard-spam:${userId}`)
      .setLabel(
        settings.kickOnSoundboardSpam
          ? "Disable Kick on Soundboard Spam"
          : "Enable Kick on Soundboard Spam"
      )
      .setStyle(
        settings.kickOnSoundboardSpam ? ButtonStyle.Danger : ButtonStyle.Success
      );

    // Assemble all buttons into one ActionRow.
    const buttonsRow = new ActionRowBuilder().addComponents(
      togglenotifyBadWordButton,
      togglenotifyLoudUserButton,
      togglesoundboardLoggingButton,
      toggleKickSoundboardButton
    );

    const components = [vcRoleDropdown, buttonsRow];

    if (interactionOrMessage.isMessageComponent?.()) {
      // Button/select menu interaction — update the original message
      await interactionOrMessage.update({
        content: contentMessage,
        components,
      });
    } else if (interactionOrMessage.isCommand?.()) {
      // Slash command
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
    } else if (interactionOrMessage instanceof Message) {
      // Legacy message command or dev test
      await interactionOrMessage.channel.send({
        content: contentMessage,
        components,
      });
    } else if (interactionOrMessage.isRepliable?.()) {
      // Fallback for unexpected cases
      await interactionOrMessage.reply({
        content: contentMessage,
        components,
        ephemeral: isEphemeral,
      });
    }
  } catch (error) {
    console.error(`[ERROR] showVCSettingsUI failed: ${error.message}`);
    await logErrorToChannel(
      interactionOrMessage.guild?.id,
      error.stack,
      interactionOrMessage.client,
      "showVCSettingsUI"
    );
    if (interactionOrMessage instanceof Message) {
      await interactionOrMessage.channel.send(
        "> <❌> An error occurred displaying VC settings. (INT_ERR_006)"
      );
    } else if (!interactionOrMessage.replied) {
      await interactionOrMessage.reply({
        content:
          "> <❌> An error occurred displaying VC settings. (INT_ERR_006)",
        ephemeral: true,
      });
    }
  }
}

async function handleVCSettingsFlow(interaction, action) {
  try {
    const userId = interaction.user.id;
    const guild = interaction.guild;
    if (!guild) return;
    let settings = await getSettingsForGuild(guild.id);
    switch (action) {
      case "toggle-badword": {
        const newValue = !settings.notifyBadWord;
        await updateSettingsForGuild(
          guild.id,
          { notifyBadWord: newValue },
          guild
        );
        break;
      }
      case "toggle-loud-user": {
        const newValue = !settings.notifyLoudUser;
        await updateSettingsForGuild(
          guild.id,
          { notifyLoudUser: newValue },
          guild
        );
        break;
      }
      case "select-log-viewers": {
        const selectedRoleId = interaction.values[0];
        const role = guild.roles.cache.get(selectedRoleId);
        if (!role) {
          await interaction.reply({
            content: "> <❌> Invalid role selected. Please try again.",
            ephemeral: true,
          });
          return;
        }
        await updateSettingsForGuild(
          guild.id,
          { voiceCallPingRoleId: selectedRoleId },
          guild
        );
        break;
      }
      case "toggle-soundboard-logging": {
        const newStatus = !settings.soundboardLogging;
        await updateSettingsForGuild(
          guild.id,
          { soundboardLogging: newStatus },
          guild
        );
        break;
      }
      case "toggle-kick-soundboard-spam": {
        const newStatus = !settings.kickOnSoundboardSpam;
        await updateSettingsForGuild(
          guild.id,
          { kickOnSoundboardSpam: newStatus },
          guild
        );
        break;
      }
      default:
        await interaction.reply({
          content: "> <❌> Unrecognized VC settings action.",
          ephemeral: true,
        });
        return;
    }
    await showVCSettingsUI(interaction, true);
  } catch (error) {
    console.error(`[ERROR] handleVCSettingsFlow failed: ${error.message}`);
    await logErrorToChannel(
      interaction.guild?.id,
      error.stack,
      interaction.client,
      "handleVCSettingsFlow"
    );
    if (!interaction.replied) {
      await interaction.reply({
        content:
          "> <❌> An error occurred processing VC settings. (INT_ERR_006)",
        ephemeral: true,
      });
    }
  }
}

module.exports = {
  showVCSettingsUI,
  handleVCSettingsFlow,
};
