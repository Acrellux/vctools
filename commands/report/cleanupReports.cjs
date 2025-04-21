// commands/report/cleanupReports.cjs

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const settingsModule = require("../settings.cjs");

// Create a Supabase client
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Constants
const ISSUE_REPORT_CHANNEL_ID = "1339506633373384726"; // Dedicated issue report channel
const DAYS_THRESHOLD = 30;

/**
 * cleanupOldReports:
 * Deletes all reports older than DAYS_THRESHOLD days,
 * notifies both the report channel and the reporting user,
 * and replies to the original report message when possible.
 *
 * @param {import('discord.js').Client} client - The Discord bot client
 */
async function cleanupOldReports(client) {
    const cutoff = new Date(Date.now() - DAYS_THRESHOLD * 24 * 60 * 60 * 1000).toISOString();

    // Fetch all old reports
    const { data: oldReports, error: fetchError } = await supabase
        .from("reports")
        .select("*")
        .lt("timestamp", cutoff);

    if (fetchError) {
        console.error("[CLEANUP ERROR] fetching old reports:", fetchError);
        return;
    }

    if (!Array.isArray(oldReports) || oldReports.length === 0) {
        console.log(`[CLEANUP] No reports older than ${DAYS_THRESHOLD} days.`);
        return;
    }

    console.log(`[CLEANUP] Found ${oldReports.length} old reports. Processing...`);

    for (const report of oldReports) {
        const { report_id, type, guild_id, message_id, user_id } = report;

        // Determine destination channel
        let channelId;
        if (type === "activity") {
            const settings = await settingsModule.getSettingsForGuild(guild_id);
            channelId = settings.channelId;
        } else {
            channelId = ISSUE_REPORT_CHANNEL_ID;
        }

        // Notify in channel
        try {
            const channel = await client.channels.fetch(channelId).catch(() => null);
            if (channel) {
                // Try replying to the original report message
                let replyTarget;
                try {
                    const original = await channel.messages.fetch(message_id).catch(() => null);
                    replyTarget = original || channel;
                } catch { }

                const notifyText = `<🕳️> Report \`${report_id}\` automatically closed due to being over ${DAYS_THRESHOLD} days old.`;
                await replyTarget.reply(notifyText).catch(() => channel.send(notifyText));
            }
        } catch (err) {
            console.error(`[CLEANUP] Error notifying channel for report ${report_id}:`, err);
        }

        // Notify the user via DM
        try {
            const user = await client.users.fetch(user_id).catch(() => null);
            if (user) {
                const dmText = `<🕳️> Your report \`${report_id}\` was automatically closed because it was over ${DAYS_THRESHOLD} days old. If you still need assistance, please feel free to submit a new report or reach out to the moderators directly.`;
                await user.send(dmText);
            }
        } catch (err) {
            console.error(`[CLEANUP] Error sending DM for report ${report_id}:`, err);
        }

        // Finally, delete from Supabase
        try {
            await supabase.from("reports").delete().eq("report_id", report_id);
        } catch (delErr) {
            console.error(`[CLEANUP] Error deleting report ${report_id}:`, delErr);
        }
    }

    console.log(`[CLEANUP] Completed processing ${oldReports.length} reports.`);
}

module.exports = { cleanupOldReports };
