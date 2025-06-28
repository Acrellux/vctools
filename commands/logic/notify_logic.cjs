const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Message,
  Interaction,
  EmbedBuilder,
} = require("discord.js");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Helper function for status emoji
function getStatusEmoji(status) {
  if (status === "open") return "<🔓> open";
  if (status === "closed") return "<🔒> closed";
  if (status === "invisible") return "<🌫️> invisible";
  return status;
}

/* =====================================================
       Notification Database Functions
    ===================================================== */

// Add a notification subscription
async function addNotification(subscriber_id, target_id, server_id) {
  // 1) Check if target has consented
  const { data: consentData, error: consentError } = await supabase
    .from("user_consent")
    .select("userId")
    .eq("userId", target_id)
    .single();

  if (consentError || !consentData) {
    throw new Error("Target user has not consented to VC Tools.");
  }

  // 2) Check if the target's status is set to "closed"
  const { data: statusData, error: statusError } = await supabase
    .from("statuses")
    .select("status")
    .eq("user_id", target_id)
    .eq("server_id", server_id)
    .single();

  let targetStatus = "open";
  if (!statusError && statusData) {
    targetStatus = statusData.status;
  }

  if (targetStatus === "closed") {
    throw new Error("Target user has closed notifications.");
  }

  // 3) Insert notification
  const { data, error } = await supabase
    .from("notifications")
    .insert([{ user_id: subscriber_id, target_id, server_id }]);

  if (error) {
    if (error.code === "23505") {
      throw new Error("Command executed previously.");
    }
    throw error;
  }

  return data;
}

// Remove a specific subscription
async function removeNotification(subscriber_id, target_id, server_id) {
  const { data, error } = await supabase
    .from("notifications")
    .delete()
    .eq("user_id", subscriber_id)
    .eq("target_id", target_id)
    .eq("server_id", server_id);
  if (error) throw error;
  return data;
}

// Clear all subscriptions for a user in a server
async function clearNotifications(subscriber_id, server_id) {
  const { data, error } = await supabase
    .from("notifications")
    .delete()
    .eq("user_id", subscriber_id)
    .eq("server_id", server_id);
  if (error) throw error;
  return data;
}

// List all subscriptions for a user in a server
async function listNotifications(subscriber_id, server_id) {
  const { data, error } = await supabase
    .from("notifications")
    .select("*")
    .eq("user_id", subscriber_id)
    .eq("server_id", server_id);
  if (error) throw error;
  return data;
}

// List all users subscribed to a specific target in a server
async function listNotificationsForTarget(target_id, server_id) {
  const { data, error } = await supabase
    .from("notifications")
    .select("*")
    .eq("target_id", target_id)
    .eq("server_id", server_id);
  if (error) throw error;
  return data;
}

/* =====================================================
       Status and Block Functions
    ===================================================== */

// Update or insert status in the "statuses" table; statuses are either "open", "invisible", or "closed"
async function updateStatus(user_id, server_id, status) {
  // Try to fetch an existing record first.
  let { data, error } = await supabase
    .from("statuses")
    .select("*")
    .eq("user_id", user_id)
    .eq("server_id", server_id)
    .single();

  if (error && error.code === "PGRST116") {
    // No record found; insert one.
    const { data: insertData, error: insertError } = await supabase
      .from("statuses")
      .insert([{ user_id, server_id, status }]);
    if (insertError) throw insertError;
    return insertData;
  } else if (error) {
    throw error;
  } else {
    // Record exists; update it.
    const { data: updateData, error: updateError } = await supabase
      .from("statuses")
      .update({ status })
      .eq("user_id", user_id)
      .eq("server_id", server_id);
    if (updateError) throw updateError;
    return updateData;
  }
}

// Add a block entry
async function addBlock(user_id, blocked_id, server_id) {
  const { data, error } = await supabase
    .from("user_blocks")
    .insert([{ user_id, blocked_id, server_id }]);
  if (error) {
    if (error.code === "23505") {
      // PostgreSQL unique_violation
      throw new Error("You’ve already done this!");
    }
    console.error("[NOTIFY ERROR]", error);
    return;
  }
  return data;
}

// Remove a block entry
async function removeBlock(user_id, blocked_id, server_id) {
  const { data, error } = await supabase
    .from("user_blocks")
    .delete()
    .eq("user_id", user_id)
    .eq("blocked_id", blocked_id)
    .eq("server_id", server_id);
  if (error) throw error;
  return data;
}

// List blocked users for a given user in a server
async function listBlocks(user_id, server_id) {
  const { data, error } = await supabase
    .from("user_blocks")
    .select("*")
    .eq("user_id", user_id)
    .eq("server_id", server_id);
  if (error) throw error;
  return data;
}

// List users that a specific user has blocked in a server
async function listUsersBlockedBy(userId, serverId) {
  const { data, error } = await supabase
    .from("user_blocks")
    .select("*")
    .eq("user_id", userId)
    .eq("server_id", serverId);
  if (error) throw error;
  return data;
}

/* =====================================================
       Notification Hub UI and Interaction Flow
    ===================================================== */

// Displays the hub UI for notifications
async function showNotifyHubUI(interaction) {
  try {
    const subscriber_id = interaction.user.id;
    const server_id = interaction.guild.id;
    const subscriptions = await listNotifications(subscriber_id, server_id);
    const statusRes = await supabase
      .from("statuses")
      .select("status")
      .eq("user_id", subscriber_id)
      .eq("server_id", server_id)
      .single();
    const currentStatus = statusRes.data ? statusRes.data.status : "open";
    const displayStatus = getStatusEmoji(currentStatus);

    let contentMessage = `**Notification Hub**\nYour status: **${displayStatus}**\n`;
    if (subscriptions.length === 0) {
      contentMessage += "You have no active notification subscriptions.";
    } else {
      contentMessage += "Notifying for:\n";
      subscriptions.forEach((sub) => {
        contentMessage += `- <@${sub.target_id}>\n`;
      });
    }

    // Build buttons for hub actions
    const statusButton = new ButtonBuilder()
      .setCustomId(`notify:status:${subscriber_id}`)
      .setLabel("Set Status")
      .setStyle(ButtonStyle.Primary);
    // Additional buttons can be added here as needed.
    const buttonsRow = new ActionRowBuilder().addComponents(statusButton);

    if (interaction.isMessageComponent()) {
      await interaction.update({
        content: contentMessage,
        components: [buttonsRow],
      });
    } else if (interaction.replied || interaction.deferred) {
      await interaction.editReply({
        content: contentMessage,
        components: [buttonsRow],
      });
    } else {
      await interaction.reply({
        content: contentMessage,
        components: [buttonsRow],
        ephemeral: true,
      });
    }
  } catch (error) {
    console.error(`[ERROR] showNotifyHubUI failed: ${error.message}`);
    await interaction.reply({
      content: "<❌> An error occurred displaying the notification hub.",
      ephemeral: true,
    });
  }
}

// Handle button interactions from the notification hub
async function handleNotifyFlow(interaction) {
  try {
    // Expected format: notify:action:user_id
    const customId = interaction.customId;
    const parts = customId.split(":");
    const action = parts[1];
    const subscriber_id = parts[2];
    const server_id = interaction.guild.id;

    if (interaction.user.id !== subscriber_id) {
      await interaction.reply({
        content: "<❎> You are not authorized to perform this action.",
        ephemeral: true,
      });
      return;
    }

    switch (action) {
      case "add": {
        const target = message.mentions.users.first();
        if (!target) {
          await message.channel.send("<❎> Please mention a user to add.");
          return;
        }
        try {
          await addNotification(subscriber_id, target.id, server_id);
          await message.channel.send(
            `<✅> Added notification for <@${target.id}>.`
          );
        } catch (err) {
          await message.channel.send(`> <⚠️> ${err.message}`);
        }
        break;
      }

      case "remove": {
        await interaction.reply({
          content:
            "<❇️> To remove a notification, please use the `/notify remove @User` command.",
          ephemeral: true,
        });
        break;
      }
      case "clear": {
        await clearNotifications(subscriber_id, server_id);
        await interaction.reply({
          content:
            "<✅> All your notification subscriptions have been cleared.",
          ephemeral: true,
        });
        break;
      }
      case "status": {
        await interaction.reply({
          content:
            "<❇️> To update your status, please use `/notify status <open|invisible|closed>`.",
          ephemeral: true,
        });
        break;
      }
      case "blocks": {
        const blocks = await listBlocks(subscriber_id, server_id);
        let blockMsg = "**Blocked Users:**\n";
        if (blocks.length === 0) {
          blockMsg += "You have not blocked anyone.";
        } else {
          blocks.forEach((b) => {
            blockMsg += `- <@${b.blocked_id}>\n`;
          });
        }
        await interaction.reply({
          content: blockMsg,
          ephemeral: true,
        });
        break;
      }
      default: {
        await interaction.reply({
          content: "<❌> Unrecognized notification action.",
          ephemeral: true,
        });
      }
    }
  } catch (error) {
    console.error(`[ERROR] handleNotifyFlow failed: ${error.message}`);
    await interaction.reply({
      content: "<❌> An error occurred processing the notification action.",
      ephemeral: true,
    });
  }
}

/* =====================================================
       Message-based Command Handler
    ===================================================== */

// For message commands like: notify add @User
async function handleNotifyMessageCommand(message, args) {
  const subscriber_id = message.author.id;
  const server_id = message.guild.id;

  if (!args[0]) {
    await message.channel.send(
      "<❇️> Usage: `notify <add|remove|clear|list|status|block|unblock|blocks>` (include a user mention when needed)"
    );
    return;
  }

  const action = args[0].toLowerCase();

  try {
    switch (action) {
      case "add": {
        const target = message.mentions.users.first();
        if (!target) {
          await message.channel.send("<❎> Please mention a user to add.");
          return;
        }
        await addNotification(subscriber_id, target.id, server_id);
        await message.channel.send(
          `<✅> Added notification for <@${target.id}>.`
        );
        break;
      }
      case "remove": {
        const target = message.mentions.users.first();
        if (!target) {
          await message.channel.send("<❎> Please mention a user to remove.");
          return;
        }
        await removeNotification(subscriber_id, target.id, server_id);
        await message.channel.send(
          `<✅> Removed notification for <@${target.id}>.`
        );
        break;
      }
      case "clear": {
        await clearNotifications(subscriber_id, server_id);
        await message.channel.send(
          "<✅> Cleared all your notification subscriptions."
        );
        break;
      }
      case "list": {
        const subscriptions = await listNotifications(subscriber_id, server_id);
        if (subscriptions.length === 0) {
          await message.channel.send("<❇️> You have no notifications.");
        } else {
          const embed = new EmbedBuilder()
            .setTitle("Your Notifications")
            .setDescription(
              subscriptions.map((sub) => `- <@${sub.target_id}>`).join("\n")
            );
          await message.channel.send({
            embeds: [embed],
            allowedMentions: { parse: [] },
          });
        }
        break;
      }
      case "status": {
        if (!args[1]) {
          await message.channel.send(
            "<❇️> Usage: `notify status <open|invisible|closed>`"
          );
          return;
        }
        const newStatus = args[1].toLowerCase();
        if (
          newStatus !== "open" &&
          newStatus !== "invisible" &&
          newStatus !== "closed"
        ) {
          await message.channel.send(
            "<❎> Status must be either `open`, `invisible`, or `closed`."
          );
          return;
        }
        await updateStatus(subscriber_id, server_id, newStatus);
        await message.channel.send(
          `<✅> Your status is now **${getStatusEmoji(newStatus)}**.`
        );
        break;
      }
      case "block": {
        const target = message.mentions.users.first();
        if (!target) {
          await message.channel.send("<❎> Please mention a user to block.");
          return;
        }
        if (target.id === subscriber_id) {
          await message.channel.send("<❎> You can't block yourself.");
          return;
        }
        try {
          await addBlock(subscriber_id, target.id, server_id);
          await message.channel.send(
            `<🔒> Blocked ${target.username} from viewing your activity.`
          );
        } catch (error) {
          if (error.code === "23505" || error.message?.includes("duplicate")) {
            await message.channel.send(
              "<❎> You've already blocked that user."
            );
          } else {
            throw error;
          }
        }
        break;
      }
      case "unblock": {
        const target = message.mentions.users.first();
        if (!target) {
          await message.channel.send("<❎> Please mention a user to unblock.");
          return;
        }
        await removeBlock(subscriber_id, target.id, server_id);
        await message.channel.send(`<🔓> Unblocked ${target.username}.`);
        break;
      }
      case "blocks": {
        const blocks = await listBlocks(subscriber_id, server_id);
        if (blocks.length === 0) {
          await message.channel.send("<❇️> You haven't blocked any users.");
        } else {
          let blockMsg = "**Your Blocked Users:**\n";
          for (const b of blocks) {
            const user = await message.guild.members.fetch(b.blocked_id);
            blockMsg += `- ${user.user.username}\n`;
          }
          await message.channel.send(blockMsg);
        }
        break;
      }
      default: {
        await message.channel.send(
          "<❌> Unrecognized subcommand. Available: `add, remove, clear, list, status, block, unblock, blocks`"
        );
      }
    }
  } catch (error) {
    console.error(
      `[ERROR] handleNotifyMessageCommand failed: ${error.message}`
    );
    if (error.message === "Target user has closed notifications.") {
      await message.channel.send(
        `<🔒> This user has their notifications closed.`
      );
    } else {
      await message.channel.send(`<❌> An error occurred: ${error.message}`);
    }
  }
}

/* =====================================================
       Slash Command Handler
    ===================================================== */

// For slash commands, e.g. /notify add target:@User
async function handleNotifySlashCommand(interaction) {
  const subcommand = interaction.options.getSubcommand();
  const subscriber_id = interaction.user.id;
  const server_id = interaction.guild.id;

  try {
    switch (subcommand) {
      case "add": {
        const target = interaction.options.getUser("user");
        if (!target) {
          await interaction.reply({
            content: "<❎> You must provide a user to add.",
            ephemeral: true,
          });
          return;
        }
        await addNotification(subscriber_id, target.id, server_id);
        await interaction.reply({
          content: `<✅> Added notification for <@${target.id}>.`,
          ephemeral: true,
        });
        break;
      }
      case "remove": {
        const target = interaction.options.getUser("user");
        if (!target) {
          await interaction.reply({
            content: "<❎> You must provide a user to remove.",
            ephemeral: true,
          });
          return;
        }
        await removeNotification(subscriber_id, target.id, server_id);
        await interaction.reply({
          content: `<✅> Removed notification for <@${target.id}>.`,
          ephemeral: true,
        });
        break;
      }
      case "clear": {
        await clearNotifications(subscriber_id, server_id);
        await interaction.reply({
          content: "<✅> Cleared all your notifications.",
          ephemeral: true,
        });
        break;
      }
      case "list": {
        const subscriptions = await listNotifications(subscriber_id, server_id);
        if (subscriptions.length === 0) {
          await interaction.reply({
            content: "<❇️> You have no notifications.",
            ephemeral: true,
          });
        } else {
          const embed = new EmbedBuilder()
            .setTitle("Your Notifications")
            .setDescription(
              subscriptions.map((sub) => `- <@${sub.target_id}>`).join("\n")
            );
          await interaction.reply({
            embeds: [embed],
            ephemeral: true,
            allowedMentions: { parse: [] },
          });
        }
        break;
      }
      case "status": {
        const newStatus = interaction.options.getString("status").toLowerCase();
        if (
          newStatus !== "open" &&
          newStatus !== "invisible" &&
          newStatus !== "closed"
        ) {
          await interaction.reply({
            content:
              "<❎> Status must be either `open`, `invisible`, or `closed`.",
            ephemeral: true,
          });
          return;
        }
        await updateStatus(subscriber_id, server_id, newStatus);
        await interaction.reply({
          content: `<✅> Your status is now **${getStatusEmoji(newStatus)}**.`,
          ephemeral: true,
        });
        break;
      }
      case "block": {
        const target = interaction.options.getUser("user");
        if (!target) {
          await interaction.reply({
            content: "<❎> You must provide a user to block.",
            ephemeral: true,
          });
          return;
        }
        await addBlock(subscriber_id, target.id, server_id);
        await interaction.reply({
          content: `<🔒> Blocked ${target.username} from viewing your activity.`,
          ephemeral: true,
        });
        break;
      }
      case "unblock": {
        const target = interaction.options.getUser("user");
        if (!target) {
          await interaction.reply({
            content: "<❎> You must provide a user to unblock.",
            ephemeral: true,
          });
          return;
        }
        await removeBlock(subscriber_id, target.id, server_id);
        await interaction.reply({
          content: `<🔓> Unblocked <@${target.id}>.`,
          ephemeral: true,
        });
        break;
      }
      case "blocks": {
        const blocks = await listBlocks(subscriber_id, server_id);
        if (blocks.length === 0) {
          await interaction.reply({
            content: "<❇️> You haven't blocked any users.",
            ephemeral: true,
          });
        } else {
          let blockMsg = "**Your Blocked Users:**\n";
          blocks.forEach((b) => {
            blockMsg += `- <@${b.blocked_id}>\n`;
          });
          await interaction.reply({
            content: blockMsg,
            ephemeral: true,
          });
        }
        break;
      }
      default: {
        await interaction.reply({
          content: "<❌> Unrecognized subcommand.",
          ephemeral: true,
        });
      }
    }
  } catch (error) {
    console.error(`[ERROR] handleNotifySlashCommand failed: ${error.message}`);
    if (error.message === "Target user has closed notifications.") {
      await interaction.reply({
        content: `<🔒> This user has their notifications closed.`,
        ephemeral: true,
      });
    } else {
      await interaction.reply({
        content: `<❌> An error occurred: ${error.message}`,
        ephemeral: true,
      });
    }
  }
}

module.exports = {
  addNotification,
  removeNotification,
  clearNotifications,
  listNotifications,
  listNotificationsForTarget,
  updateStatus,
  addBlock,
  removeBlock,
  listBlocks,
  listUsersBlockedBy,
  showNotifyHubUI,
  handleNotifyFlow,
  handleNotifyMessageCommand,
  handleNotifySlashCommand,
};
