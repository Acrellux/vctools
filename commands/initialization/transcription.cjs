const {
  Message,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
} = require("discord.js");
const {
  getSettingsForGuild,
  updateSettingsForGuild,
  updateChannelPermissionsForGuild,
} = require("../settings.cjs");
const {
  logErrorToChannel,
  createchannelIdropdown,
  createRoleDropdown,
} = require("../logic/helpers.cjs");
const { interactionContexts } = require("../../database/contextStore.cjs");

/**
 * Initiates the transcription initialization flow.
 * @param {Message | Interaction} messageOrInteraction - The Discord message or interaction object.
 */
async function handleInitializeTranscription(messageOrInteraction) {
  try {
    const isMessage = messageOrInteraction instanceof Message;
    const guild = messageOrInteraction.guild;
    if (!guild) {
      const response = "> <🔒> This command can only be used within a server.";
      if (isMessage) {
        await messageOrInteraction.channel.send(response);
      } else {
        await messageOrInteraction.reply(response);
      }
      return;
    }
    const userId = isMessage
      ? messageOrInteraction.author.id
      : messageOrInteraction.user.id;

    // Set the initMethod to "transcription" to track this process separately.
    interactionContexts.set(userId, {
      guildId: guild.id,
      mode: "init",
      initMethod: "transcription",
    });

    const prompt = `## **Transcription Setup**
> Would you like to set up transcription for this server?`;

    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`init:setup_transcription_yes:${userId}`)
        .setLabel("Yes")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`init:setup_transcription_no:${userId}`)
        .setLabel("No")
        .setStyle(ButtonStyle.Danger)
    );

    if (isMessage) {
      await messageOrInteraction.channel.send({
        content: prompt,
        components: [buttons],
      });
    } else {
      await messageOrInteraction.reply({
        content: prompt,
        components: [buttons],
      });
    }
  } catch (error) {
    console.error(
      `[ERROR] handleInitializeTranscription failed: ${error.message}`
    );
    await logErrorToChannel(
      messageOrInteraction.guild?.id,
      error.stack,
      messageOrInteraction.client,
      "handleInitializeTranscription"
    );
    if (!messageOrInteraction.replied) {
      await messageOrInteraction.reply({
        content:
          "> <❌> An error occurred during transcription initialization.",
        ephemeral: true,
      });
    }
  }
}

/**
 * Handles the transcription flow based on user interactions.
 * This is **now self-contained** and does NOT cascade into other setup flows.
 * @param {Interaction} interaction - The Discord interaction object.
 * @param {string} mode - Expected to be "transcription" (provided by caller).
 * @param {string} action - The specific action from the customId.
 */
async function handleTranscriptionFlow(interaction, mode, action) {
  try {
    const userId = interaction.user.id;
    const guild = interaction.guild;

    if (!guild) {
      await interaction.reply({
        content: "> <❌> Guild not found. (INT_ERR_003)",
        ephemeral: true,
      });
      return;
    }

    switch (action) {
      case "setup_transcription_yes":
        await interaction.update({
          content: `## **<1.2> Choose a Transcription Logs Channel**
> Which channel should transcription logs be saved in?`,
          components: [createchannelIdropdown("init", guild, userId, null)],
        });
        break;

      case "setup_transcription_no":
        await updateSettingsForGuild(
          guild.id,
          { transcriptionEnabled: false },
          guild
        );
        await interaction.update({
          content: `> <✅> **Transcription setup has been skipped.**
Transcription initialization complete.`,
          components: [],
        });
        interactionContexts.delete(userId);
        break;

      case "select_logging_channel":
        {
          const selectedchannelId = interaction.values[0];

          if (selectedchannelId === "new_channel") {
            const newChannel = await guild.channels.create({
              name: "transcription-logs",
              type: ChannelType.GuildText,
            });
            await updateSettingsForGuild(
              guild.id,
              { channelId: newChannel.id },
              guild
            );
            await interaction.update({
              content: `> <✅> **New channel created: <#${newChannel.id}> for transcription logs.**
                
## **<1.3> Choose Who Can View Transcription Logs**
> Select the role that can view transcription logs:`,
              components: [createRoleDropdown("init", guild, userId, null)],
            });
          } else {
            await updateSettingsForGuild(
              guild.id,
              { channelId: selectedchannelId },
              guild
            );
            await interaction.update({
              content: `> <✅> **Transcription logs channel set to <#${selectedchannelId}>.**
                
## **<1.3> Choose Who Can View Transcription Logs**
> Select the role that can view transcription logs:`,
              components: [createRoleDropdown("init", guild, userId, null)],
            });
          }
        }
        break;

      case "select_log_viewers":
        {
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
            { allowedRoleId: selectedRoleId },
            guild
          );
          await updateChannelPermissionsForGuild(
            guild.id,
            getSettingsForGuild(guild.id).channelId,
            selectedRoleId,
            guild
          );

          await interaction.update({
            content: `> <✅> **Allowed role for transcription logs set to: ${role.name}.**
                
## **<1.4> Enable Transcription Now?**
> If enabled, transcription will become active.`,
            components: [
              new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                  .setCustomId(`init:enable_transcription_yes:${userId}`)
                  .setLabel("Enable Transcription")
                  .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                  .setCustomId(`init:enable_transcription_no:${userId}`)
                  .setLabel("Disable Transcription")
                  .setStyle(ButtonStyle.Danger)
              ),
            ],
          });
        }
        break;

      case "enable_transcription_yes":
        await updateSettingsForGuild(
          guild.id,
          { transcriptionEnabled: true },
          guild
        );
        await interaction.update({
          content: `> <✅> **Success! Transcription has been enabled.**
Transcription initialization complete.`,
          components: [],
        });
        interactionContexts.delete(userId);
        break;

      case "enable_transcription_no":
        await updateSettingsForGuild(
          guild.id,
          { transcriptionEnabled: false },
          guild
        );
        await interaction.update({
          content: `> <✅> **Transcription is currently disabled.**
Transcription initialization complete.`,
          components: [],
        });
        interactionContexts.delete(userId);
        break;

      default:
        console.warn(`[WARNING] Unrecognized transcription action: ${action}`);
        await interaction.reply({
          content: "> <❌> Unrecognized transcription action.",
          ephemeral: true,
        });
        break;
    }
  } catch (error) {
    console.error(`[ERROR] handleTranscriptionFlow failed: ${error.message}`);
    await logErrorToChannel(
      interaction.guild?.id,
      error.stack,
      interaction.client,
      "handleTranscriptionFlow"
    );
    if (!interaction.replied) {
      await interaction.reply({
        content:
          "> <❌> An error occurred while processing your transcription interaction. (INIT_ERR_002)",
        ephemeral: true,
      });
    }
  }
}

module.exports = {
  handleInitializeTranscription,
  handleTranscriptionFlow,
};
