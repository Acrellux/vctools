const { createClient } = require("@supabase/supabase-js");
const { Events } = require("discord.js");

// Initialize Supabase client
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("[ERROR] Missing Supabase environment variables!");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Handles reactions on report messages using Supabase
async function handleReaction(reaction, user) {
  if (user.bot) return;
  console.log(`[DEBUG] handleReaction triggered for: ${reaction.emoji.name}`);

  // Fetch the report from the Supabase "reports" table by message_id
  const { data: reportData, error } = await supabase
    .from("reports")
    .select("*")
    .eq("message_id", reaction.message.id)
    .eq("guild_id", reaction.message.guild.id)
    .single();


  if (error || !reportData) {
    console.warn(
      `[WARNING] No report found for message ID ${reaction.message.id}`
    );
    return;
  }

  const statusMap = {
    "✅": "Your report has been successfully resolved! We appreciate your feedback and your patience. If you experience any more issues, then feel free to report them.",
    "🔁": "Your report has been marked as a duplicate, and has been closed. If you have any more issues, feel free to report them.",
    "❇️": "Your report may be caused by a server-side issue. Please ensure that your server permissions are correctly set up and that VC Tools has the required permissions to complete your request. If the issue persists, then please feel free to report it again.",
    "👤": "Your report may be caused by a client-side issue. Please ensure that you're properly using the function. If the issue persists, then please feel free to report it again.",
    "🔧": "Your report is currently being investigated. We appreciate your patience.",
    "❎": "Unfortunately, we were unable to replicate the issue you reported, and therefore cannot find the problem. If you have any more issues, feel free to report them.",
    "❌": "Unfortunately, we were unable to resolve the issue you reported. If you have any more issues, feel free to report them.",
  };

  if (!statusMap[reaction.emoji.name]) {
    console.warn(`[WARNING] Unrecognized emoji: ${reaction.emoji.name}`);
    return;
  }

  const closingEmojis = ["✅", "🔁", "❇️", "👤", "❎", "❌"];
  let reportClosedMessage = `-# <${reaction.emoji.name}> *Report ${reportData.report_id} closed.*`;

  if (closingEmojis.includes(reaction.emoji.name)) {
    // Delete the report from Supabase
    const { error: deleteError } = await supabase
      .from("reports")
      .delete()
      .eq("report_id", reportData.report_id);

    if (deleteError) {
      console.error("[ERROR] Failed to delete report:", deleteError);
      return;
    }

    console.log(
      `[DEBUG] Report ${reportData.report_id} has been closed and removed.`
    );

    // Reply to the original report message in the report logs channel
    try {
      await reaction.message.reply(reportClosedMessage);
      console.log(`[INFO] Report closed message sent in logs.`);
    } catch (replyError) {
      console.error(
        `[ERROR] Failed to send report closed message in logs: ${replyError.message}`
      );
    }
  } else {
    // Update the report's status field
    const { error: updateError } = await supabase
      .from("reports")
      .update({ status: statusMap[reaction.emoji.name] })
      .eq("report_id", reportData.report_id);

    if (updateError) {
      console.error("[ERROR] Failed to update report:", updateError);
      return;
    }
  }

  console.log(
    `[DEBUG] Report ${reportData.report_id} updated to ${statusMap[reaction.emoji.name]
    }`
  );

  // Notify the reporter via DM with the update
  try {
    const reporter = await reaction.message.client.users.fetch(
      reportData.user_id
    );
    let dmContent = `# <${reaction.emoji.name
      }> **Report Update** for \`report ${reportData.report_id}\`\n> ${statusMap[reaction.emoji.name]
      }`;

    // If the report is closed, append closure message
    if (closingEmojis.includes(reaction.emoji.name)) {
      dmContent += `\n\n${reportClosedMessage}`;
    }

    await reporter.send({ content: dmContent });
    console.log(`[INFO] DM Sent to Reporter ${reportData.user_id}`);
  } catch (error) {
    console.error(
      `[ERROR] Could not DM reporter ${reportData.user_id}: ${error.message}`
    );
  }
}

module.exports = { handleReaction };
