// initialization/errorlogs.cjs

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
  createErrorLogchannelIdropdown,
  createErrorLogRoleDropdown,
} = require("../logic/helpers.cjs");
const { interactionContexts } = require("../../database/contextStore.cjs");

/**
 * Initiates the error logs initialization flow.
 * @param {Message | Interaction} messageOrInteraction - The Discord message or interaction object.
 */
async function handleInitializeErrorLogs(messageOrInteraction) {
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

    // Store the user's context with mode "init" and initMethod "errorlogs"
    const userId = isMessage
      ? messageOrInteraction.author.id
      : messageOrInteraction.user.id;
    interactionContexts.set(userId, {
      guildId: guild.id,
      mode: "init",
      initMethod: "errorlogs",
    });

    const prompt = `## **Error Logs Setup**
> Would you like to set up an error logs channel in this server?`;

    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`init:setup_error_logs_yes:${userId}`)
        .setLabel("Yes")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`init:setup_error_logs_no:${userId}`)
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
    console.error(`[ERROR] handleInitializeErrorLogs failed: ${error.message}`);
    await logErrorToChannel(
      messageOrInteraction.guild?.id,
      error.stack,
      messageOrInteraction.client,
      "handleInitializeErrorLogs"
    );
    if (!messageOrInteraction.replied) {
      await messageOrInteraction.reply({
        content:
          "> <❌> An error occurred during error logs setup. (INIT_ERR_002)",
        ephemeral: true,
      });
    }
  }
}

/**
 * Handles all error log–related interactions.
 * This flow now includes role selection and an enable/disable decision,
 * then ends the error logs initialization process.
 * @param {Interaction} interaction - The Discord interaction object.
 * @param {string} mode - Expected to be "init" (provided by caller).
 * @param {string} action - The specific action from the customId.
 */
async function handleErrorLogsFlow(interaction, mode, action) {
  try {
    const guild = interaction.guild;
    const userId = interaction.user.id;
    if (!guild) {
      await interaction.reply({
        content: "> <❌> Guild not found. (INT_ERR_003)",
        ephemeral: true,
      });
      return;
    }

    switch (action) {
      // Step 1: User confirms to set up error logs.
      case "setup_error_logs_yes":
        await interaction.update({
          content: `## **<2.2> Choose an error logs channel**
> Which channel should errors be logged in?

-# *Unable to find a specific channel? Log into the [Dashboard](<https://vctools.app/dashboard>) to avoid the 25 dropdown option limit.*`,
          components: [
            createErrorLogchannelIdropdown("init", guild, userId, null),
          ],
        });
        break;

      // Step 2: User opts to skip error logs setup.
      case "setup_error_logs_no":
        await updateSettingsForGuild(
          guild.id,
          { errorLogsEnabled: false },
          guild
        );
        await interaction.update({
          content: `> <❇️> **Error logs setup has been skipped.**
Error logs initialization complete! You can modify these settings later by typing \`settings errorlogs\`.`,
          components: [],
        });
        interactionContexts.delete(userId);
        break;

      // Step 3: User selects an error logs channel.
      case "select_error_logs_channel": {
        const selectedchannelId = interaction.values[0];
        if (selectedchannelId === "new_channel") {
          const newChannel = await guild.channels.create({
            name: "error-logs",
            type: ChannelType.GuildText,
          });
          await updateSettingsForGuild(
            guild.id,
            { errorLogsChannelId: newChannel.id },
            guild
          );
          await interaction.update({
            content: `> <✅> **New channel created: <#${newChannel.id}> for error logs.**
              
## **<2.3> Choose who can view error logs**
> Select the role that can view error logs:

-# *Unable to find a specific role? Log into the [Dashboard](<https://vctools.app/dashboard>) to avoid the 25 dropdown option limit.*`,
            components: [
              createErrorLogRoleDropdown("init", guild, userId, null),
            ],
          });
        } else {
          await updateSettingsForGuild(
            guild.id,
            { errorLogsChannelId: selectedchannelId },
            guild
          );
          await interaction.update({
            content: `> <✅> **Error logs channel set to <#${selectedchannelId}>.**
              
## **<2.3> Choose who can view error logs**
> Select the role that can view error logs:

-# *Unable to find a specific role? Log into the [Dashboard](<https://vctools.app/dashboard>) to avoid the 25 dropdown option limit.*`,
            components: [
              createErrorLogRoleDropdown("init", guild, userId, null),
            ],
          });
        }
        break;
      }

      // Step 4: User selects a role for viewing error logs.
      case "select_error_logs_role": {
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
          { errorLogsRoleId: selectedRoleId },
          guild
        );
        await updateChannelPermissionsForGuild(
          guild.id,
          getSettingsForGuild(guild.id).errorLogsChannelId,
          selectedRoleId,
          guild
        );
        // After role selection, prompt the user to enable or disable error logging.
        await interaction.update({
          content: `> <✅> **Allowed role for error logs set to: ${role.name}.**
              
## **<2.4> Enable error logging now?**
> If enabled, errors will be logged in the selected channel.`,
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`init:enable_error_logging_yes:${userId}`)
                .setLabel("Yes")
                .setStyle(ButtonStyle.Success),
              new ButtonBuilder()
                .setCustomId(`init:enable_error_logging_no:${userId}`)
                .setLabel("No")
                .setStyle(ButtonStyle.Danger)
            ),
          ],
        });
        break;
      }

      // Step 5: User chooses to enable error logging.
      case "enable_error_logging_yes":
        await updateSettingsForGuild(
          guild.id,
          { errorLogsEnabled: true, setupComplete: true },
          guild
        );
        await interaction.update({
          content: `> <✅> **Success! Error logging has been enabled.**
Error logs initialization complete! You can modify these settings later by typing \`settings errorlogs\`.`,
          components: [],
        });
        interactionContexts.delete(userId);
        break;

      // Step 6: User chooses to disable error logging.
      case "enable_error_logging_no":
        await updateSettingsForGuild(
          guild.id,
          { errorLogsEnabled: false, setupComplete: true },
          guild
        );
        await interaction.update({
          content: `> <❇️> **Error logging remains disabled.**
Error logs initialization complete! You can modify these settings later by typing \`settings errorlogs\`.`,
          components: [],
        });
        interactionContexts.delete(userId);
        break;

      default:
        console.warn(`[WARNING] Unrecognized error logs action: ${action}`);
        await interaction.reply({
          content: "> <❌> Unrecognized error logs action.",
          ephemeral: true,
        });
        break;
    }
  } catch (error) {
    console.error(`[ERROR] handleErrorLogsFlow failed: ${error.message}`);
    await logErrorToChannel(
      interaction.guild?.id,
      error.stack,
      interaction.client,
      "handleErrorLogsFlow"
    );
    if (!interaction.replied) {
      await interaction.reply({
        content:
          "> <❌> An error occurred while processing your error logs interaction. (INIT_ERR_002)",
        ephemeral: true,
      });
    }
  }
}

module.exports = {
  handleInitializeErrorLogs,
  handleErrorLogsFlow,
};
