require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const settingsModule = require("../settings.cjs");

// Create a Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Constants
const REPORT_CHANNEL_ID = "1339506633373384726";

/**
 * Utility: Generate a 6-character report ID
 */
function generateReportID() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

/**
 * reportActivity:
 * Retrieves all reports for the given user from Supabase
 * and returns a summary message.
 */
async function reportActivity(userId) {
  try {
    const { data: userReports, error } = await supabase
      .from("reports")
      .select("*")
      .eq("user_id", userId);

    if (error) {
      console.error("[ERROR] reportActivity:", error);
      return { error: "<❌> Unable to retrieve reports at this time." };
    }

    if (!userReports || userReports.length === 0) {
      return { error: "<❌> No reports found for you." };
    }

    let response = "**Your Report Activity:**\n";
    userReports.forEach((r) => {
      response += `**Report ${r.report_id}** - Status: ${r.status}, Submitted: ${r.timestamp}\nDescription: ${r.description}\n\n`;
    });
    return { message: response };
  } catch (err) {
    console.error("[ERROR] reportActivity exception:", err);
    return { error: "<❌> Something went wrong while retrieving your reports." };
  }
}

/**
 * handleReportActivity:
 * Posts user report summary to the activity logs channel if enabled.
 */
async function handleReportActivity(userId, client, guildId) {
  const settings = await settingsModule.getSettingsForGuild(guildId);
  if (!settings.vcLoggingChannelId) {
    return { error: "<❇️> Activity reporting has not been enabled in this server yet." };
  }

  const activityResult = await reportActivity(userId);
  if (activityResult.error) return { error: activityResult.error };

  const channel = await client.channels.fetch(settings.vcLoggingChannelId).catch(() => null);
  if (!channel) {
    return { error: "<❌> Activity logs channel not found." };
  }

  await channel.send(activityResult.message);
  return { message: "<✅> Your report activity has been forwarded to the server's staff members." };
}

/**
 * sendReportButton:
 * Sends a button for an issue report submission.
 */
async function sendReportButton(target) {
  const reportId = generateReportID();
  const userId = target.user?.id || target.author?.id || "unknown";
  const customId = `report:open:${userId}:${reportId}`;

  const embed = new EmbedBuilder()
    .setTitle("Open an Issue Report")
    .setDescription("Click below to submit an issue report.")
    .setColor("Blue")
    .setFooter({ text: `Report ID: ${reportId}` });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(customId)
      .setLabel("Open Issue Report Form")
      .setStyle(ButtonStyle.Primary)
  );

  if (typeof target.reply === "function") {
    await target.reply({ embeds: [embed], components: [row], ephemeral: true });
  } else if (target.channel?.send) {
    await target.channel.send({ embeds: [embed], components: [row] });
  }
}

/**
 * sendActivityReportButton:
 * Sends a button for an activity report submission.
 */
async function sendActivityReportButton(target) {
  const reportId = generateReportID();
  const userId = target.user?.id || target.author?.id || "unknown";
  const customId = `activity:open:${userId}:${reportId}`;

  const embed = new EmbedBuilder()
    .setTitle("Open an Activity Report")
    .setDescription("Click below to submit an activity report.")
    .setColor("Blue")
    .setFooter({ text: `Report ID: ${reportId}` });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(customId)
      .setLabel("Open Activity Report Form")
      .setStyle(ButtonStyle.Primary)
  );

  if (typeof target.reply === "function") {
    await target.reply({ embeds: [embed], components: [row], ephemeral: true });
  } else if (target.channel?.send) {
    await target.channel.send({ embeds: [embed], components: [row] });
  }
}

/**
 * showReportModal:
 * Opens a modal to collect report details.
 */
async function showReportModal(interaction, reportId, modalPrefix = "report_modal") {
  try {
    if (!reportId) {
      console.warn("[WARNING] showReportModal called without reportId");
      try {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: "<❌> No report ID found.", ephemeral: true });
        }
      } catch (err) {
        console.error("[ERROR] fallback reply failed:", err);
      }
      return;
    }

    const isActivity = modalPrefix === "activity_modal";
    const modal = new ModalBuilder()
      .setCustomId(`${modalPrefix}:${reportId}`)
      .setTitle(isActivity ? "Submit an Activity Report" : "Submit an Issue Report");

    const descriptionInput = new TextInputBuilder()
      .setCustomId("issue_description")
      .setLabel(isActivity ? "Describe what occurred (Required)" : "Issue Description (Required)")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true);

    const additionalInput = new TextInputBuilder()
      .setCustomId("details")
      .setLabel(isActivity ? "Additional Context (Optional)" : "Additional Details (Optional)")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false);

    if (isActivity) {
      modal.addComponents(
        new ActionRowBuilder().addComponents(descriptionInput),
        new ActionRowBuilder().addComponents(additionalInput)
      );
    } else {
      const errorLogInput = new TextInputBuilder()
        .setCustomId("error_logs")
        .setLabel("Error Log (Optional)")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false);
      modal.addComponents(
        new ActionRowBuilder().addComponents(descriptionInput),
        new ActionRowBuilder().addComponents(errorLogInput),
        new ActionRowBuilder().addComponents(additionalInput)
      );
    }

    await interaction.showModal(modal);
  } catch (err) {
    console.error("[ERROR] showReportModal error:", err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "<❌> Couldn’t open report form.", ephemeral: true });
    }
  }
}

/**
 * handleReportSubmission:
 * Processes a submitted report modal and logs it.
 */
async function handleReportSubmission(interaction) {
  if (!interaction.isModalSubmit()) return;

  const customId = interaction.customId;
  const isActivity = customId.startsWith("activity_modal:");
  const reportId = customId.split(":")[1];

  const issueDescription = interaction.fields.getTextInputValue("issue_description");
  const additionalDetails = interaction.fields.getTextInputValue("details") || "N/A";
  const errorLog = !isActivity ? interaction.fields.getTextInputValue("error_logs") || "N/A" : null;
  const settings = await settingsModule.getSettingsForGuild(interaction.guild.id);
  const truncate = (text, max = 1024) => text.length > max ? text.slice(0, max - 3) + "..." : text;

  const embed = new EmbedBuilder()
    .setTitle(`${isActivity ? "New Activity Report" : "New Report"} - ${reportId}`)
    .addFields(
      { name: "Reporter", value: `<@${interaction.user.id}>`, inline: true },
      { name: "Description", value: truncate(issueDescription) },
      { name: "Additional Details", value: truncate(additionalDetails) }
    )
    .setColor(isActivity ? "White" : "Red")
    .setTimestamp();
  if (!isActivity && errorLog) embed.addFields({ name: "Error Log", value: truncate(errorLog) });

  let reportChannel;
  if (isActivity) {
    if (!settings.vcLoggingChannelId) {
      return interaction.reply({ content: "<❇️> Activity reporting has not been enabled in this server yet.", ephemeral: true });
    }
    reportChannel = await interaction.client.channels.fetch(settings.vcLoggingChannelId).catch(() => null);
    if (!reportChannel) {
      return interaction.reply({ content: "<❌> Activity logs channel is missing.", ephemeral: true });
    }
  } else {
    reportChannel = await interaction.client.channels.fetch(REPORT_CHANNEL_ID).catch(() => null);
    if (!reportChannel) {
      return interaction.reply({ content: "<❌> Unable to forward report.", ephemeral: true });
    }
  }

  const reportMessage = await reportChannel.send({ embeds: [embed] });
  if (isActivity && settings.notifyActivityReports && settings.moderatorRoleId) {
    await reportChannel.send({ content: `> <@&${settings.moderatorRoleId}> There is a new activity report.` });
    await reportChannel.send({
      content: `-# **React** to the report above with one of the following emojis to manage it:
-#  > <✅> \`Resolve\` report  
-#  > <🔁> Report was a \`duplicate\`  
-#  > <🔧> Report is being \`investigated\`  
-#  > <❌> Report \`cannot be resolved\``
    });
  }

  // Insert into Supabase
  try {
    const { error } = await supabase.from("reports").insert({
      report_id: reportId,
      user_id: interaction.user.id,
      guild_id: interaction.guild.id,
      message_id: reportMessage.id,
      status: "open",
      description: issueDescription,
      details: additionalDetails,
      error_log: errorLog,
      timestamp: new Date().toISOString(),
      type: isActivity ? "activity" : "issue",
    });
    if (error) console.error("[ERROR] Supabase insert:", error);
  } catch (err) {
    console.error("[ERROR] handleReportSubmission exception:", err);
  }

  // DM user
  try {
    const reporter = await interaction.client.users.fetch(interaction.user.id);
    const dmEmbed = new EmbedBuilder()
      .setTitle(`${isActivity ? "Your Activity Report" : "Your Report"} - ${reportId}`)
      .addFields(
        { name: "Description", value: truncate(issueDescription) },
        { name: "Additional Details", value: truncate(additionalDetails) }
      )
      .setColor(isActivity ? "White" : "Red")
      .setTimestamp();
    if (!isActivity && errorLog) dmEmbed.addFields({ name: "Error Log", value: truncate(errorLog) });
    await reporter.send({ content: `> <✅> Your report (ID: ${reportId}) has been submitted!`, embeds: [dmEmbed] });
  } catch (err) {
    console.error("[WARN] DM failure:", err);
  }

  await interaction.reply({ content: `<✅> Report submitted! ID: \`${reportId}\`.`, ephemeral: false });
}

/**
 * handleReportInteractions:
 * Opens the correct modal based on button interaction.
 */
async function handleReportInteractions(interaction) {
  if (!interaction.isButton()) return;
  const parts = interaction.customId.split(":");
  if (parts.length < 4) return;
  const [mode, action, , reportId] = parts;
  if (action !== "open") return;
  await showReportModal(interaction, reportId, mode === "activity" ? "activity_modal" : "report_modal");
}

/**
 * viewReport:
 * Retrieves a single report, ensures ownership, and sends it as an embed.
 */
async function viewReport(userId, reportId, target = null) {
  try {
    const { data: report, error } = await supabase
      .from("reports")
      .select("*")
      .eq("report_id", reportId)
      .single();

    if (error || !report) return { error: "<❇️> Report not found." };
    if (report.user_id !== userId) return { error: "<❇️> You can only view your own reports." };

    const truncate = (text, max = 1024) =>
      text && text.length > max ? text.slice(0, max - 3) + "..." : text || "N/A";

    const embed = new EmbedBuilder()
      .setTitle(`${report.type === "activity" ? "Activity Report" : "Issue Report"} - ${report.report_id}`)
      .addFields(
        { name: "Status", value: report.status || "Unknown", inline: true },
        { name: "Description", value: truncate(report.description) },
        { name: "Additional Details", value: truncate(report.details), inline: true }
      )
      .setColor(report.type === "activity" ? "White" : "Red")
      .setTimestamp(new Date(report.timestamp));

    if (report.error_log && report.type === "issue") {
      embed.addFields({ name: "Error Log", value: truncate(report.error_log) });
    }

    // Send the embed if a context is provided
    if (target) {
      if (typeof target.reply === "function") {
        await target.reply({ embeds: [embed], ephemeral: true });
      } else if (target.channel && typeof target.channel.send === "function") {
        await target.channel.send({ embeds: [embed] });
      }
    }

    return { embed };
  } catch (err) {
    console.error("[ERROR] viewReport exception:", err);
    return { error: "<❌> Unable to retrieve the report at this time." };
  }
}

/**
 * closeReport:
 * Deletes a report if user is owner.
 */
async function closeReport(userId, reportId) {
  try {
    const { data: existingReport, error } = await supabase.from("reports").select("user_id").eq("report_id", reportId).single();
    if (error || !existingReport) return { error: "<❇️> Report not found." };
    if (existingReport.user_id !== userId) return { error: "<❇️> You can only close your own reports." };
    const { error: deleteError } = await supabase.from("reports").delete().eq("report_id", reportId);
    if (deleteError) return { error: "<❌> Could not close report. Please try again." };
    return { message: `<✅> Report ${reportId} has been closed.` };
  } catch (err) {
    console.error("[ERROR] closeReport exception:", err);
    return { error: "<❌> Something went wrong while closing the report." };
  }
}

/**
 * editReport:
 * Updates a report and refreshes its log embed using guild_id.
 */
async function editReport(userId, reportId, updates, client) {
  try {
    const { data: report, error } = await supabase.from("reports").select("*").eq("report_id", reportId).single();
    if (error || !report) return { error: "Report not found." };
    if (report.user_id !== userId) return { error: "You can only edit your own reports." };
    const { error: updateError } = await supabase.from("reports").update(updates).eq("report_id", reportId);
    if (updateError) return { error: "Unable to update the report. Please try again." };
    const updatedReport = { ...report, ...updates };
    const embedTitle = updatedReport.type === "activity"
      ? `Updated Activity Report - ${reportId}`
      : `Updated Report - ${reportId}`;
    const updatedEmbed = new EmbedBuilder()
      .setTitle(embedTitle)
      .addFields(
        { name: "Reporter", value: `<@${updatedReport.user_id}>`, inline: true },
        { name: "Description", value: updatedReport.description || "N/A" },
        { name: "Additional Details", value: updatedReport.details || "N/A", inline: true }
      )
      .setColor(updatedReport.type === "activity" ? "White" : "Red")
      .setTimestamp();
    if (updatedReport.error_log) updatedEmbed.addFields({ name: "Error Log", value: updatedReport.error_log });
    let channel;
    if (updatedReport.type === "activity") {
      const settings = await settingsModule.getSettingsForGuild(updatedReport.guild_id);
      channel = await client.channels.fetch(settings.vcLoggingChannelId).catch(() => null);
    } else {
      channel = await client.channels.fetch(REPORT_CHANNEL_ID).catch(() => null);
    }
    if (channel) {
      const msg = await channel.messages.fetch(updatedReport.message_id).catch(() => null);
      if (msg && msg.editable) await msg.edit({ embeds: [updatedEmbed] });
    }
    return { message: `Report ${reportId} has been updated.` };
  } catch (err) {
    console.error("[ERROR] editReport exception:", err);
    return { error: "Something went wrong while editing the report." };
  }
}

module.exports = {
  generateReportID,
  reportActivity,
  handleReportActivity,
  sendReportButton,
  sendActivityReportButton,
  showReportModal,
  handleReportSubmission,
  handleReportInteractions,
  viewReport,
  closeReport,
  editReport,
};
