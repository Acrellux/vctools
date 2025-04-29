// commands.cjs

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Message,
  Interaction,
  PermissionsBitField,
} = require("discord.js");

// Import settings helpers from your original settings.cjs
const {
  getSettingsForGuild,
  updateSettingsForGuild,
  updateChannelPermissionsForGuild,
  grantUserConsent,
  revokeUserConsent,
} = require("./settings.cjs");

// Import interaction context storage
const { interactionContexts } = require("../database/contextStore.cjs");
const { logErrorToChannel } = require("./logic/helpers.cjs");

// Define required permissions
const requiredManagerPermissions = ["ManageGuild"];

// Import logic functions from the other files
const {
  handleSettingsFlow,
  handleSettingsMessageCommand,
  handleSettingsSlashCommand,
} = require("./logic/settings_logic.cjs");
const {
  showTranscriptionSettingsUI,
  handleTranscriptionSettingChange,
} = require("./logic/transcription_logic.cjs");
const {
  handleTranscriptionFlow,
} = require("./initialization/transcription.cjs");
const {
  showErrorLogsSettingsUI,
  handleErrorLogsFlow,
} = require("./logic/errorlogs_logic.cjs");
const { handleDrainSlashCommand,
  handleDrainMessageCommand,
} = require("./logic/drain_logic.cjs");
const {
  showVCSettingsUI,
  handleVCSettingsFlow,
} = require("./logic/vc_logic.cjs");
const {
  handleVCSlashCommand,
  handleVCMessageCommand,
} = require("./logic/vc_mod_logic.cjs");
const { showBotSettingsUI } = require("./logic/bot_logic.cjs");
const {
  handleInitializeFTT,
  handleInitializeErrorLogs,
  handleInitializeTranscription,
  handleInitializeFlow,
  handleInitializeMessageCommand,
  handleInitializeSlashCommand,
} = require("./logic/init_logic.cjs");
const {
  handleHelpMessageCommand,
  handleHelpSlashCommand,
  showHelpContent,
} = require("./logic/help_logic.cjs");
const {
  handleModMessageCommand,
  handleModSlashCommand,
} = require("./logic/moderation_logic.cjs");
const {
  handleSafeUserMessageCommand,
  handlesafeUserslashCommand,
} = require("./logic/safeuser_logic.cjs");
const {
  handleSafeChannelMessageCommand,
  handlesafeChannelslashCommand,
} = require("./logic/safechannel_logic.cjs");
const {
  handleReportMessageCommand,
  handleReportSlashCommand,
  handleReportInteractions,
  handleReportSubmission,
} = require("./logic/report_logic.cjs");
const {
  handleDisallowMessageCommand,
  handleDisallowSlashCommand,
} = require("./logic/disallow_logic.cjs");
const { handleAllInteractions } = require("./logic/interaction_logic.cjs");
const {
  handleNotifyMessageCommand,
  handleNotifySlashCommand,
  handleNotifyFlow,
  showNotifyHubUI,
} = require("./logic/notify_logic.cjs");
const { handleRebootCommand } = require("./logic/reboot_logic.cjs");
const {
  handleFilterMessageCommand,
  handleFilterSlashCommand,
  showFilterSettingsUI,
} = require("./logic/filter_logic.cjs");

/* =============================
   MESSAGE-BASED COMMAND ROUTING
============================ */
async function onMessageCreate(message) {
  try {

    if (message.author.bot) return;
    const prefixes = [">", "!"];
    if (!prefixes.some((p) => message.content.startsWith(p))) return;

    const args = message.content.slice(1).trim().split(/\s+/);
    const command = args.shift().toLowerCase();

    switch (command) {
      case "settings":
        await handleSettingsMessageCommand(message, args);
        break;
      case "initialize":
        await handleInitializeMessageCommand(message, args);
        break;
      case "help":
        await handleHelpMessageCommand(message, args);
        break;
      case "vc":
        await handleVCMessageCommand(message, args);
        break;
      case "mod":
        await handleModMessageCommand(message, args);
        break;
      case "safechannel":
        await handleSafeChannelMessageCommand(message, args);
        break;
      case "safeuser":
        await handleSafeUserMessageCommand(message, args);
        break;
      case "report":
        await handleReportMessageCommand(message, args);
        break;
      case "disallow":
        await handleDisallowMessageCommand(message, args);
        break;
      case "filter":
        await handleFilterMessageCommand(message, args);
        break;
      case "notify":
        await handleNotifyMessageCommand(message, args);
        break;
      case "reboot":
        await handleRebootCommand(message);
        break;
      case "drain":
        await handleDrainMessageCommand(message, args);
        break;
      default:
        break;
    }
  } catch (error) {
    console.error(`[ERROR] onMessageCreate failed: ${error.message}`);
    await logErrorToChannel(
      message.guild?.id,
      error.stack,
      message.client,
      "onMessageCreate"
    );
    await message.channel.send(
      "> <❌> An unexpected error occurred processing your message."
    );
  }
}

/* =============================
     INTERACTION-BASED COMMAND ROUTING
============================= */
async function onInteractionCreate(interaction) {
  try {
    if (interaction.isChatInputCommand()) {
      switch (interaction.commandName) {
        case "settings":
          await handleSettingsSlashCommand(interaction);
          break;
        case "initialize":
          await handleInitializeSlashCommand(interaction);
          break;
        case "help":
          await handleHelpSlashCommand(interaction);
          break;
        case "vc":
          await handleVCSlashCommand(interaction);
          break;
        case "mod":
          await handleModSlashCommand(interaction);
          break;
        case "safeuser":
          await handlesafeUserslashCommand(interaction);
          break;
        case "safechannel":
          await handlesafeChannelslashCommand(interaction);
          break;
        case "report":
          await handleReportSlashCommand(interaction);
          break;
        case "disallow":
          await handleDisallowSlashCommand(interaction);
          break;
        case "filter":
          await handleFilterSlashCommand(interaction);
          break;
        case "notify":
          await handleNotifySlashCommand(interaction);
          break;
        case "drain":
          await handleDrainSlashCommand(interaction);
          break;
        default:
          console.log(`[DEBUG] Unhandled command: ${interaction.commandName}`);
      }
    } else if (interaction.isModalSubmit()) {
      return await handleReportSubmission(interaction);
    } else if (interaction.isButton() || interaction.isStringSelectMenu()) {
      if (interaction.customId.startsWith("help:")) {
        return;
      } else if (interaction.customId.startsWith("notify:")) {
        return handleNotifyFlow(interaction);
      } else if (
        interaction.customId.startsWith("report:open:") ||
        interaction.customId.startsWith("activity:open:")
      ) {
        return handleReportInteractions(interaction);
      } else if (interaction.customId.startsWith("init:")) {
        const [_, action] = interaction.customId.split(":");

        const context = interactionContexts.get(interaction.user.id);
        if (context?.mode === "init") {
          if (context.initMethod === "transcription") {
            return await handleTranscriptionFlow(interaction, context.mode, action);
          } else {
            return await handleInitializeFlow(interaction, context.mode, action);
          }
        }
      }

      await handleAllInteractions(interaction);
    }
  } catch (error) {
    console.error(`[ERROR] onInteractionCreate failed: ${error.message}`);
    await logErrorToChannel(
      interaction.guild?.id,
      error.stack,
      interaction.client,
      "onInteractionCreate"
    );
    if (!interaction.replied) {
      await interaction.reply({
        content:
          "> <❌> An unexpected error occurred processing your interaction. (INT_ERR_006)",
        ephemeral: true,
      });
    }
  }
}

module.exports = { onMessageCreate, onInteractionCreate };