const { createClient } = require("@supabase/supabase-js");
const { getSettingsForGuild } = require("../settings.cjs");
const {
  logErrorToChannel,
  requiredManagerPermissions,
} = require("../logic/helpers.cjs");

// Initialize Supabase client with service role key
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * Removes a user's consent and related data from Supabase (RLS-safe).
 * Uses a count-based approach to confirm rows were deleted.
 *
 * @param {string} userId - The ID of the user to remove.
 * @param {string} guildId - The guild ID (used for logging errors).
 * @param {Client} client - The Discord client (used for logging errors and DMing users).
 * @returns {string} - "success" if at least one row was deleted,
 *                     "not_found" if no rows were deleted (or RLS blocked),
 *                     "failed" if there was an error.
 */
async function removeUserConsent(userId, guildId, client) {
  try {
    const userIdStr = String(userId).trim();
    let totalDeleted = 0;

    // 1. Remove from the user_consent table
    const { count: consentCount, error: consentError } = await supabase
      .from("user_consent")
      .delete({ returning: "minimal", count: "exact" })
      .eq("userId", userIdStr);

    if (consentError) {
      await logErrorToChannel(
        guildId,
        consentError.stack,
        client,
        "removeUserConsent:user_consent"
      );
      console.error(
        `[ERROR] Failed to remove user_consent for ${userIdStr}: ${consentError.message}`
      );
      return "failed";
    }
    if (!consentCount || consentCount === 0) {
      console.warn(
        `[WARNING] No user_consent row deleted for ${userIdStr} — user may not exist or RLS blocked access.`
      );
    } else {
      console.log(
        `[INFO] Removed ${consentCount} row(s) from user_consent for user ${userIdStr}`
      );
      totalDeleted += consentCount;
    }

    // 2. Notifications cleanup:
    // a) Find notifications where the disallowing user is the target.
    const { data: notifRows, error: notifFetchError } = await supabase
      .from("notifications")
      .select("user_id, target_id, server_id")
      .eq("target_id", userIdStr);

    if (notifFetchError) {
      await logErrorToChannel(
        guildId,
        notifFetchError.stack,
        client,
        "removeUserConsent:notifications_fetch"
      );
      console.error(
        `[ERROR] Failed to fetch notifications for target_id ${userIdStr}: ${notifFetchError.message}`
      );
    } else if (notifRows && notifRows.length > 0) {
      // DM each user in the notification list
      for (const row of notifRows) {
        try {
          const notifyUser = await client.users.fetch(row.user_id);
          const guild = await client.guilds.fetch(row.server_id);
          const guildName = guild?.name || "(Unknown Server)";

          if (notifyUser) {
            await notifyUser.send(
              `<🚫> One of the people in your notification list, <@${row.target_id}>, has requested to be removed from our database. This means that you will no longer be notified when they join a voice call inside the **${guildName}** server.`
            );
          }
        } catch (dmError) {
          console.error(
            `[ERROR] Failed to DM user ${row.user_id}: ${dmError.message}`
          );
        }
      }
      // Delete notifications where the disallowing user is the target.
      const { count: notifTargetCount, error: notifTargetError } =
        await supabase
          .from("notifications")
          .delete({ returning: "minimal", count: "exact" })
          .eq("target_id", userIdStr);
      if (notifTargetError) {
        await logErrorToChannel(
          guildId,
          notifTargetError.stack,
          client,
          "removeUserConsent:notifications_delete_target"
        );
        console.error(
          `[ERROR] Failed to delete notifications with target_id ${userIdStr}: ${notifTargetError.message}`
        );
      } else if (notifTargetCount > 0) {
        console.log(
          `[INFO] Deleted ${notifTargetCount} notification(s) where target_id = ${userIdStr}`
        );
        totalDeleted += notifTargetCount;
      }
    }

    // b) Remove notifications where the notifier is the disallowing user.
    const { count: notifUserCount, error: notifUserError } = await supabase
      .from("notifications")
      .delete({ returning: "minimal", count: "exact" })
      .eq("user_id", userIdStr);
    if (notifUserError) {
      await logErrorToChannel(
        guildId,
        notifUserError.stack,
        client,
        "removeUserConsent:notifications_delete_user"
      );
      console.error(
        `[ERROR] Failed to delete notifications with user_id ${userIdStr}: ${notifUserError.message}`
      );
    } else if (notifUserCount > 0) {
      console.log(
        `[INFO] Deleted ${notifUserCount} notification(s) where user_id = ${userIdStr}`
      );
      totalDeleted += notifUserCount;
    }

    // 3. Remove from statuses table where user_id matches the disallowing user.
    const { count: statusesCount, error: statusesError } = await supabase
      .from("statuses")
      .delete({ returning: "minimal", count: "exact" })
      .eq("user_id", userIdStr);
    if (statusesError) {
      await logErrorToChannel(
        guildId,
        statusesError.stack,
        client,
        "removeUserConsent:statuses"
      );
      console.error(
        `[ERROR] Failed to delete statuses for ${userIdStr}: ${statusesError.message}`
      );
    } else if (statusesCount > 0) {
      console.log(
        `[INFO] Deleted ${statusesCount} status row(s) for user ${userIdStr}`
      );
      totalDeleted += statusesCount;
    }

    // 4. Remove from user_blocks table where the disallowing user is involved.
    // This removes rows where either "user_id" or "target_id" equals the disallowing user's ID.
    const { count: userBlocksCount, error: userBlocksError } = await supabase
      .from("user_blocks")
      .delete({ returning: "minimal", count: "exact" })
      .or(`user_id.eq.${userIdStr},blocked_id.eq.${userIdStr}`);
    if (userBlocksError) {
      await logErrorToChannel(
        guildId,
        userBlocksError.stack,
        client,
        "removeUserConsent:user_blocks"
      );
      console.error(
        `[ERROR] Failed to delete user_blocks for ${userIdStr}: ${userBlocksError.message}`
      );
    } else if (userBlocksCount > 0) {
      console.log(
        `[INFO] Deleted ${userBlocksCount} user_blocks row(s) for user ${userIdStr}`
      );
      totalDeleted += userBlocksCount;
    }

    if (totalDeleted === 0) {
      return "not_found";
    }

    // 5. Remove from soundboard_spam_log table
    const { count: soundboardLogCount, error: soundboardLogError } =
      await supabase
        .from("soundboard_spam_log")
        .delete({ returning: "minimal", count: "exact" })
        .eq("userid", userIdStr);

    if (soundboardLogError) {
      await logErrorToChannel(
        guildId,
        soundboardLogError.stack,
        client,
        "removeUserConsent:soundboard_spam_log"
      );
      console.error(
        `[ERROR] Failed to delete soundboard_spam_log for ${userIdStr}: ${soundboardLogError.message}`
      );
    } else if (soundboardLogCount > 0) {
      console.log(
        `[INFO] Deleted ${soundboardLogCount} soundboard_spam_log row(s) for user ${userIdStr}`
      );
      totalDeleted += soundboardLogCount;
    }

    return "success";
  } catch (error) {
    await logErrorToChannel(guildId, error.stack, client, "removeUserConsent");
    console.error(`[ERROR] removeUserConsent exception: ${error.message}`);
    return "failed";
  }
}

/**
 * Mutes a user in a voice channel if transcription is enabled.
 * @param {GuildMember} member - The guild member to mute.
 * @param {string} guildId - The guild ID.
 * @param {Client} client - The Discord client.
 */
async function muteIfNeeded(member, guildId, client) {
  const settings = await getSettingsForGuild(guildId);
  if (settings && settings.transcriptionEnabled && member?.voice?.channel) {
    try {
      await member.voice.setMute(true);
      console.log(`[INFO] Muted ${member.user.tag} in VC due to /disallow.`);
    } catch (error) {
      await logErrorToChannel(guildId, error.stack, client, "muteIfNeeded");
      console.error(`[ERROR] Failed to mute ${member.user.tag}: ${error}`);
    }
  } else {
    console.warn(
      `[WARNING] Cannot mute ${
        member?.user?.tag || "Unknown user"
      } - Either settings not found, transcription is disabled, or user is not in a voice channel.`
    );
  }
}

/**
 * Handles the /disallow slash command.
 * @param {Interaction} interaction - The Discord interaction object.
 */
async function handleDisallowSlashCommand(interaction) {
  try {
    const userId = interaction.user.id;
    const guild = interaction.guild;
    const client = interaction.client;
    const member = guild.members.cache.get(userId);

    const result = await removeUserConsent(userId, guild.id, client);

    if (result === "success") {
      await interaction.reply({
        content: `> <✅> You have been successfully removed from our database.
-# You may now become muted when you join voice channels.
-# If you removed consent out of uneasiness or discomfort, you can ask for a staff member to add you to the \`safeuser\` list. This will allow you to join voice channels without monitoring from VC Tools.`,
        ephemeral: true,
      });
      if (member) {
        await muteIfNeeded(member, guild.id, client);
      }
    } else if (result === "not_found") {
      await interaction.reply({
        content:
          "> <⚠️> You were not in our database, so no changes were made.",
        ephemeral: true,
      });
    } else {
      await interaction.reply({
        content: "> <❌> An error occurred while processing your request.",
        ephemeral: true,
      });
    }
  } catch (error) {
    await logErrorToChannel(
      interaction.guild.id,
      error.stack,
      interaction.client,
      "handleDisallowSlashCommand"
    );
    console.error(
      `[ERROR] handleDisallowSlashCommand failed: ${error.message}`
    );
    await interaction.reply({
      content: "> <❌> An error occurred while processing your request.",
      ephemeral: true,
    });
  }
}

/**
 * Handles the !disallow message command.
 * @param {Message} message - The Discord message object.
 */
async function handleDisallowMessageCommand(message) {
  try {
    const userId = message.author.id;
    const guild = message.guild;
    const client = message.client;
    const member = guild.members.cache.get(userId);

    const result = await removeUserConsent(userId, guild.id, client);

    if (result === "success") {
      await message.reply(
        `> <✅> You have been successfully removed from our database.
-# You may now become muted when you join voice channels.
-# If you removed consent out of uneasiness or discomfort, you can ask for a staff member to add you to the \`safeuser\` list. This will allow you to join voice channels without any interference from VC Tools.`
      );
      if (member) {
        await muteIfNeeded(member, guild.id, client);
      }
    } else if (result === "not_found") {
      await message.reply(
        "> <⚠️> You were not in our database, so no changes were made."
      );
    } else {
      await message.reply(
        "> <❌> An error occurred while processing your request."
      );
    }
  } catch (error) {
    await logErrorToChannel(
      message.guild.id,
      error.stack,
      message.client,
      "handleDisallowMessageCommand"
    );
    console.error(
      `[ERROR] handleDisallowMessageCommand failed: ${error.message}`
    );
    await message.reply(
      "> <❌> An error occurred while processing your request."
    );
  }
}

module.exports = {
  handleDisallowSlashCommand,
  handleDisallowMessageCommand,
};
