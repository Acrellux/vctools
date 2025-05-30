// handler file (e.g., reportHandler.cjs)
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
  sendReportButton,
  sendActivityReportButton,
  handleReportSubmission,
  handleReportInteractions,
  viewReport,
  closeReport,
  editReport,
  reportActivity,
  handleReportActivity,
  generateReportID,
} = require("../report/report.cjs");

const settingsModule = require("../settings.cjs");
const { getSettingsForGuild } = require("../settings.cjs");
const { logErrorToChannel } = require("./helpers.cjs");

const requiredManagerPermissions = ["ManageGuild"]; // Adjust if needed

async function handleReportSlashCommand(interaction) {
  try {
    const subcommand = interaction.options.getSubcommand();
    const guildSettings = await settingsModule.getSettingsForGuild(
      interaction.guild.id
    );

    if (subcommand === "issue") {
      return sendReportButton(interaction);
    } else if (subcommand === "activity") {
      if (!guildSettings.transcriptionEnabled || !guildSettings.channelId) {
        return interaction.reply({
          content: "<❌> Activity reports aren't set up for this server.",
          ephemeral: true,
        });
      }
      return sendActivityReportButton(interaction);
    } else if (subcommand === "view") {
      const reportId = interaction.options.getString("id");
      if (!reportId) {
        return interaction.reply({
          content: "<❌> Missing report ID.",
          ephemeral: true,
        });
      }

      const result = await viewReport(interaction.user.id, reportId, interaction);
      if (result.error) {
        return interaction.reply({ content: result.error, ephemeral: true });
      }
    } else if (subcommand === "close") {
      const reportId = interaction.options.getString("id");
      if (!reportId) {
        return interaction.reply({
          content: "<❌> Missing report ID.",
          ephemeral: true,
        });
      }
      const result = await closeReport(interaction.user.id, reportId);
      return interaction.reply({
        content: result.error || result.message,
        ephemeral: true,
      });
    } else if (subcommand === "edit") {
      const reportId = interaction.options.getString("id");
      if (!reportId) {
        return interaction.reply({
          content: "<❌> Missing report ID.",
          ephemeral: true,
        });
      }
      // Only allow editing one field: either description OR additional_details.
      const description = interaction.options.getString("description");
      const additional_details =
        interaction.options.getString("details");

      if (
        (description && additional_details) ||
        (!description && !additional_details)
      ) {
        return interaction.reply({
          content:
            "<❌> Please provide exactly one field to update: either `description` OR `details`.",
          ephemeral: true,
        });
      }
      const updates = {};
      if (description) updates.description = description;
      if (additional_details) updates.additional_details = additional_details;

      const result = await editReport(
        interaction.user.id,
        reportId,
        updates,
        interaction.client
      );
      return interaction.reply({
        content: result.error || result.message,
        ephemeral: true,
      });
    }
  } catch (error) {
    await logErrorToChannel(
      interaction.guild.id,
      error.stack,
      interaction.client,
      "REP_ERR_009"
    );
    console.error(`[ERROR] handleReportSlashCommand failed: ${error.message}`);
    await interaction.reply({
      content:
        "> <❌> An error occurred while processing your report command. (REP_ERR_009)",
      ephemeral: true,
    });
  }
}

async function handleReportMessageCommand(message, args = []) {
  try {
    const guildSettings = await settingsModule.getSettingsForGuild(message.guild.id);

    if (!args.length) {
      return sendReportButton(message);
    }
    const subcommand = args[0].toLowerCase();

    if (subcommand === "issue") {
      return sendReportButton(message);
    } else if (subcommand === "activity") {
      if (!guildSettings.channelId) {
        return message.reply(
          "<❌> Activity reports aren't set up for this server. (REP_ERR_011)"
        );
      }
      return sendActivityReportButton(message);
    } else if (subcommand === "view") {
      const reportId = args[1];
      if (!reportId) return message.reply("<❌> Please provide a report ID.");

      const result = await viewReport(message.author.id, reportId, message);
      if (result.error) return message.reply(result.error);
    } else if (subcommand === "close") {
      const reportId = args[1];
      if (!reportId) return message.reply("<❌> Please provide a report ID.");
      const result = await closeReport(message.author.id, reportId);
      return message.reply(result.error || result.message);
    } else if (subcommand === "edit") {
      if (args.length < 4)
        return message.reply(
          "<❌> Usage: `report edit <reportId> <description|details> <new value>`"
        );
      const reportId = args[1];
      const field = args[2].toLowerCase();
      if (field !== "description" && field !== "details") {
        return message.reply(
          "<❌> Only 'description' or 'details' can be updated."
        );
      }
      const newValue = args.slice(3).join(" ");
      if (!newValue) return message.reply("<❌> You must provide a new value.");
      const updates = {};
      updates[field] = newValue;
      const result = await editReport(
        message.author.id,
        reportId,
        updates,
        message.client
      );
      return message.reply(result.error || result.message);
    } else {
      return message.reply(
        "<❌> Unknown report subcommand. Options: issue, activity, view, close, edit."
      );
    }
  } catch (error) {
    await logErrorToChannel(
      message.guild.id,
      error.stack,
      message.client,
      "REP_ERR_009"
    );
    console.error(
      `[ERROR] handleReportMessageCommand failed: ${error.message}`
    );
    return message.reply(
      "> <❌> An error occurred while processing your report command. (REP_ERR_009)"
    );
  }
}

module.exports = {
  handleReportSlashCommand,
  handleReportMessageCommand,
  handleReportInteractions,
  handleReportSubmission,
};
