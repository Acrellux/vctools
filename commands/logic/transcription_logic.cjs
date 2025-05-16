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
const fs = require("fs");
const path = require("path");

const { interactionContexts } = require("../../database/contextStore.cjs");
const {
  getSettingsForGuild,
  updateSettingsForGuild,
} = require("../settings.cjs");
const {
  createchannelIdropdown,
  createRoleDropdown,
  logErrorToChannel,
} = require("./helpers.cjs");

const requiredManagerPermissions = ["ManageGuild"];

/**
 * Displays the Transcription Settings UI.
 * Only managers can access this command.
 */
async function showTranscriptionSettingsUI(
  interactionOrMessage,
  isEphemeral = false
) {
  try {
    const guild = interactionOrMessage.guild;
    if (!guild) return;
    const member = interactionOrMessage.member;
    if (!member.permissions.has(requiredManagerPermissions)) {
      const noPermMsg =
        "> <❌> You do not have the required permissions to use this command. (CMD_ERR_008)";
      if (interactionOrMessage instanceof Message) {
        await interactionOrMessage.channel.send({
          content: noPermMsg,
        });
      } else if (interactionOrMessage.isMessageComponent()) {
        await interactionOrMessage.update({
          content: noPermMsg,
          components: [],
        });
      } else {
        await interactionOrMessage.editReply({
          content: noPermMsg,
          components: [],
        });
      }
      return;
    }
    const settings = await getSettingsForGuild(guild.id);
    const userId =
      interactionOrMessage instanceof Message
        ? interactionOrMessage.author.id
        : interactionOrMessage.user.id;
    const contentMessage = `## ◈ **Transcription Settings**
  > **Transcription:** ${settings.transcriptionEnabled ? "Enabled" : "Disabled"}
  > **Transcription Logs Channel:** ${settings.channelId ? `<#${settings.channelId}>` : "Not set"
      }
  > **Transcription Logs Role:** ${settings.allowedRoleId
        ? guild.roles.cache.get(settings.allowedRoleId)?.name || "Unknown Role"
        : "Not set"
      }`;

    const transcriptionButtons = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`settings:enable-transcription:${userId}`)
        .setLabel("Enable Transcription")
        .setStyle(ButtonStyle.Success)
        .setDisabled(settings.transcriptionEnabled),
      new ButtonBuilder()
        .setCustomId(`settings:disable-transcription:${userId}`)
        .setLabel("Disable Transcription")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(!settings.transcriptionEnabled)
    );

    const transcriptionchannelIdropdown = createchannelIdropdown(
      "settings:select-transcription-channel",
      guild,
      userId,
      settings.channelId
    );
    const transcriptionRoleDropdown = createRoleDropdown(
      "settings:select-transcription-role",
      guild,
      userId,
      settings.allowedRoleId
    );
    const components = [
      transcriptionButtons,
      transcriptionchannelIdropdown,
      transcriptionRoleDropdown,
    ];

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
    console.error(
      `[ERROR] showTranscriptionSettingsUI failed: ${error.message}`
    );
    await logErrorToChannel(
      interactionOrMessage.guild?.id,
      error.stack,
      interactionOrMessage.client,
      "showTranscriptionSettingsUI"
    );
    if (interactionOrMessage.isRepliable?.()) {
      if (interactionOrMessage.replied || interactionOrMessage.deferred) {
        await interactionOrMessage.editReply({
          content:
            "> <❌> An error occurred displaying transcription settings. (INT_ERR_006)",
        });
      } else {
        await interactionOrMessage.reply({
          content:
            "> <❌> An error occurred displaying transcription settings. (INT_ERR_006)",
          ephemeral: true,
        });
      }
    } else {
      await interactionOrMessage.channel.send(
        "> <❌> An error occurred displaying transcription settings. (INT_ERR_006)"
      );
    }
  }
}

/**
 * Scans all voice channels in the guild and updates the mute status for members.
 * - If transcription is enabled, non-consented users are muted.
 * - If transcription is disabled, they are unmuted.
 *
 * @param {Guild} guild - The Discord guild object.
 * @param {Client} client - The Discord client.
 * @param {boolean} transcriptionEnabled - The transcription setting.
 */
async function updateVoicemuteStatusForGuild(
  guild,
  client,
  transcriptionEnabled
) {
  const consentFilePath = path.join(__dirname, "../../database/consent.json");
  let consentData = {};
  if (fs.existsSync(consentFilePath)) {
    try {
      consentData = JSON.parse(fs.readFileSync(consentFilePath, "utf8"));
    } catch (error) {
      await logErrorToChannel(
        guild.id,
        error.stack,
        client,
        "updateVoicemuteStatusForGuild"
      );
      return;
    }
  }

  // Filter to only voice channels
  const voiceChannels = guild.channels.cache.filter(
    (channel) => channel.type === ChannelType.GuildVoice
  );

  for (const channel of voiceChannels.values()) {
    for (const member of channel.members.values()) {
      // Only update members who have NOT given consent
      if (!consentData[member.id]) {
        try {
          if (transcriptionEnabled) {
            // Deaf the member if not already muted
            if (!member.voice.deaf) {
              await member.voice.setMute(true);
              console.log(
                `[INFO] muted ${member.user.tag} because transcription is enabled.`
              );
            }
          } else {
            // Unmute the member if they are muted
            if (member.voice.deaf) {
              await member.voice.setMute(false);
              console.log(
                `[INFO] unmuted ${member.user.tag} because transcription is disabled.`
              );
            }
          }
        } catch (error) {
          await logErrorToChannel(
            guild.id,
            error.stack,
            client,
            "updateVoicemuteStatusForGuild"
          );
          console.error(
            `[ERROR] Could not update mute status for ${member.user.tag}: ${error}`
          );
        }
      }
    }
  }
}

/**
 * Handles changes to the transcription setting.
 * Updates the guild settings and adjusts voice channel mute status accordingly.
 *
 * @param {Interaction|Message} interactionOrMessage - The interaction or message that triggered the change.
 * @param {boolean} enableTranscription - Whether to enable transcription.
 */
async function handleTranscriptionSettingChange(
  interactionOrMessage,
  enableTranscription
) {
  try {
    const guild = interactionOrMessage.guild;
    const client = interactionOrMessage.client;

    // Only update voice mute status, as settings have already been updated.
    await updateVoicemuteStatusForGuild(guild, client, enableTranscription);
  } catch (error) {
    await logErrorToChannel(
      interactionOrMessage.guild.id,
      error.stack,
      interactionOrMessage.client,
      "handleTranscriptionSettingChange"
    );
    console.error(
      `[ERROR] handleTranscriptionSettingChange failed: ${error.message}`
    );
    if (interactionOrMessage instanceof Message) {
      await interactionOrMessage.channel.send(
        "> <❌> An error occurred updating transcription settings."
      );
    } else {
      await interactionOrMessage.reply({
        content: "> <❌> An error occurred updating transcription settings.",
        ephemeral: true,
      });
    }
  }
}

module.exports = {
  showTranscriptionSettingsUI,
  updateVoicemuteStatusForGuild,
  handleTranscriptionSettingChange,
};
