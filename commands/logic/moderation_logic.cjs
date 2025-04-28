// mod_logic.cjs

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const ms = require("ms");
const {
  PermissionsBitField,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const { logErrorToChannel } = require("../logic/helpers.cjs");

// Discord’s max timeout is 28 days in milliseconds
const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;
// how many records to fetch and page size
const HISTORY_FETCH_LIMIT = 10;
const HISTORY_PAGE_SIZE = 5;

/**
 * Record a moderation action in Supabase
 */
async function recordModerationAction({
  guildId,
  userId,
  moderatorId,
  actionType,
  reason = null,
  duration = null, // seconds
}) {
  const { error } = await supabase.from("mod_actions").insert([{
    guildId,
    userId,
    moderatorId,
    actionType,
    reason,
    duration,
  }]);
  if (error) console.error("[MOD_ACTION ERROR]", error);
}

/**
 * Build a paginated history embed for a given page
 */
function buildHistoryEmbed(records, page, targetTag) {
  const start = page * HISTORY_PAGE_SIZE;
  const slice = records.slice(start, start + HISTORY_PAGE_SIZE);
  const description = slice.map(r => {
    return `target: ${r.userId} | striker: ${r.moderatorId} | action: ${r.actionType}` +
      ` | duration: ${r.duration ?? "n/a"} | reason: ${r.reason ?? "n/a"}`;
  }).join("\n") || "No entries on this page.";

  return new EmbedBuilder()
    .setTitle(`Mod History for ${targetTag}`)
    .setDescription(description)
    .setFooter({ text: `Page ${page + 1}/${Math.ceil(records.length / HISTORY_PAGE_SIZE)}` })
    .setColor("Blue");
}

/**
 * Send the paginated history with ◀️/▶️ buttons and a 60s collector
 */
async function sendPaginatedHistory(context, channel, targetTag, records, authorId) {
  let page = 0;
  const row = () => new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("history_prev")
      .setEmoji("◀️")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId("history_next")
      .setEmoji("▶️")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page >= Math.ceil(records.length / HISTORY_PAGE_SIZE) - 1)
  );

  const message = await channel.send({
    embeds: [buildHistoryEmbed(records, page, targetTag)],
    components: [row()]
  });

  const collector = message.createMessageComponentCollector({
    filter: i => i.user.id === authorId,
    time: 60_000
  });

  collector.on("collect", async i => {
    if (i.customId === "history_prev") page--;
    else if (i.customId === "history_next") page++;
    await i.update({
      embeds: [buildHistoryEmbed(records, page, targetTag)],
      components: [row()]
    });
  });

  collector.on("end", () => {
    message.edit({ components: [] }).catch(() => { });
  });
}

/**
 * Message-based handler: >mod <subcommand> <user> [duration] [reason]
 */
async function handleModMessageCommand(message, args) {
  try {
    if (!message.member.permissions.has(PermissionsBitField.Flags.KickMembers)) {
      return message.channel.send("> <❇️> You do not have permission to use mod commands.");
    }

    const usage = {
      mute: "> <❌> Usage: `>mod mute <user> <duration> <reason>`",
      unmute: "> <❌> Usage: `>mod unmute <user> <reason>`",
      kick: "> <❌> Usage: `>mod kick <user> <reason>`",
      ban: "> <❌> Usage: `>mod ban <user> <reason>`",
      warn: "> <❌> Usage: `>mod warn <user> <reason>`",
      history: "> <❌> Usage: `>mod history <user>`",
    };

    const sub = args[0]?.toLowerCase();
    if (!sub || !usage[sub]) {
      return message.channel.send(
        `> <❌> Unknown subcommand. Use one of: ${Object.keys(usage).map(s => "`" + s + "`").join(", ")}`
      );
    }

    const targetArg = args[1];
    if (!targetArg) {
      return message.channel.send(usage[sub]);
    }

    const target =
      message.mentions.members.first() ||
      await message.guild.members.fetch(targetArg).catch(() => null);
    if (!target) {
      return message.channel.send("> <❇️> Could not find that user in this server.");
    }

    switch (sub) {
      case "warn": {
        const reason = args.slice(2).join(" ") || null;
        await message.channel.send(
          `> <🔨> Warned ${target.user.tag}${reason ? ` (Reason: ${reason})` : ""}.`
        );
        await recordModerationAction({
          guildId: message.guild.id,
          userId: target.id,
          moderatorId: message.member.id,
          actionType: "warn",
          reason,
        });
        break;
      }

      case "history": {
        const { data: records, error } = await supabase
          .from("mod_actions")
          .select("*")
          .eq("guildId", message.guild.id)
          .eq("userId", target.id)
          .order("timestamp", { ascending: false })
          .limit(HISTORY_FETCH_LIMIT);
        if (error) {
          return message.channel.send("> <❌> Error fetching mod history.");
        }
        if (!records.length) {
          return message.channel.send(`> <❇️> No mod history for ${target.user.tag}.`);
        }
        await sendPaginatedHistory(
          message,
          message.channel,
          target.user.tag,
          records,
          message.author.id
        );
        break;
      }

      case "mute": {
        let durationMs, durationSec, reason;
        if (args[2] && ms(args[2])) {
          durationMs = ms(args[2]);
          if (durationMs > MAX_TIMEOUT_MS) {
            return message.channel.send("> <❌> Duration too long. Max timeout is 28 days.");
          }
          durationSec = durationMs / 1000;
          reason = args.slice(3).join(" ") || null;
        } else {
          durationMs = 60 * 60 * 1000;
          durationSec = 60 * 60;
          reason = args.slice(2).join(" ") || null;
        }
        await target.timeout(durationMs, reason || "No reason provided");
        await message.channel.send(
          `> <🔨> Muted ${target.user.tag} for ${durationSec}s${reason ? ` (Reason: ${reason})` : ""}.`
        );
        await recordModerationAction({
          guildId: message.guild.id,
          userId: target.id,
          moderatorId: message.member.id,
          actionType: "mute",
          reason,
          duration: durationSec,
        });
        break;
      }

      case "unmute": {
        const reason = args.slice(2).join(" ") || null;
        await target.timeout(null, reason || "No reason provided");
        await message.channel.send(
          `> <🔧> Unmuted ${target.user.tag}${reason ? ` (Reason: ${reason})` : ""}.`
        );
        await recordModerationAction({
          guildId: message.guild.id,
          userId: target.id,
          moderatorId: message.member.id,
          actionType: "unmute",
          reason,
        });
        break;
      }

      case "kick": {
        const reason = args.slice(2).join(" ") || "No reason provided";
        await target.kick(reason);
        await message.channel.send(
          `> <🔨> Kicked ${target.user.tag} from the server (Reason: ${reason}).`
        );
        await recordModerationAction({
          guildId: message.guild.id,
          userId: target.id,
          moderatorId: message.member.id,
          actionType: "kick",
          reason,
        });
        break;
      }

      case "ban": {
        const reason = args.slice(2).join(" ") || "No reason provided";
        await target.ban({ reason });
        await message.channel.send(
          `> <🔨> Banned ${target.user.tag} from the server (Reason: ${reason}).`
        );
        await recordModerationAction({
          guildId: message.guild.id,
          userId: target.id,
          moderatorId: message.member.id,
          actionType: "ban",
          reason,
        });
        break;
      }
    }
  } catch (error) {
    console.error(`[ERROR] handleModMessageCommand: ${error.stack}`);
    await logErrorToChannel(
      message.guild?.id,
      error.stack,
      message.client,
      "handleModMessageCommand"
    );
    message.channel.send("> <❌> An error occurred using mod commands.");
  }
}

/**
 * Slash-based /mod <subcommand> user:<user> [duration:<string>] [reason:<string>]
 */
async function handleModSlashCommand(interaction) {
  try {
    if (!interaction.memberPermissions.has(PermissionsBitField.Flags.KickMembers)) {
      return interaction.reply({
        content: "> <❇️> You do not have permission to use mod commands.",
        ephemeral: true,
      });
    }

    const sub = interaction.options.getSubcommand();
    const targetUser = interaction.options.getUser("user");
    const target = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    if (!target) {
      return interaction.reply({
        content: "> <❇️> Could not find that user in this server.",
        ephemeral: true,
      });
    }

    switch (sub) {
      case "warn": {
        const reason = interaction.options.getString("reason") || null;
        await interaction.reply({
          content: `> <🔨> Warned ${targetUser.tag}${reason ? ` (Reason: ${reason})` : ""}.`,
        });
        await recordModerationAction({
          guildId: interaction.guild.id,
          userId: target.id,
          moderatorId: interaction.user.id,
          actionType: "warn",
          reason,
        });
        break;
      }

      case "history": {
        const { data: records, error } = await supabase
          .from("mod_actions")
          .select("*")
          .eq("guildId", interaction.guild.id)
          .eq("userId", target.id)
          .order("timestamp", { ascending: false })
          .limit(HISTORY_FETCH_LIMIT);
        if (error) {
          return interaction.reply({
            content: "> <❌> Error fetching mod history.",
            ephemeral: true,
          });
        }
        if (!records.length) {
          return interaction.reply({
            content: `> <❇️> No mod history for ${targetUser.tag}.`,
            ephemeral: true,
          });
        }
        const reply = await interaction.reply({ content: "Loading history...", fetchReply: true });
        await sendPaginatedHistory(
          interaction,
          reply.channel,
          targetUser.tag,
          records,
          interaction.user.id
        );
        break;
      }

      case "mute": {
        let durationMs, durationSec;
        const durationStr = interaction.options.getString("duration");
        const reason = interaction.options.getString("reason") || null;
        if (durationStr && ms(durationStr)) {
          durationMs = ms(durationStr);
          if (durationMs > MAX_TIMEOUT_MS) {
            return interaction.reply({
              content: "> <❌> Duration too long. Max timeout is 28 days.",
              ephemeral: true,
            });
          }
          durationSec = durationMs / 1000;
        } else {
          durationMs = 60 * 60 * 1000;
          durationSec = 60 * 60;
        }
        await target.timeout(durationMs, reason || "No reason provided");
        await interaction.reply({
          content: `> <🔨> Muted ${targetUser.tag} for ${durationSec}s${reason ? ` (Reason: ${reason})` : ""}.`,
        });
        await recordModerationAction({
          guildId: interaction.guild.id,
          userId: target.id,
          moderatorId: interaction.user.id,
          actionType: "mute",
          reason,
          duration: durationSec,
        });
        break;
      }

      case "unmute": {
        const reason = interaction.options.getString("reason") || null;
        await target.timeout(null, reason || "No reason provided");
        await interaction.reply({
          content: `> <🔧> Unmuted ${targetUser.tag}${reason ? ` (Reason: ${reason})` : ""}.`,
        });
        await recordModerationAction({
          guildId: interaction.guild.id,
          userId: target.id,
          moderatorId: interaction.user.id,
          actionType: "unmute",
          reason,
        });
        break;
      }

      case "kick": {
        const reason = interaction.options.getString("reason") || "No reason provided";
        await target.kick(reason);
        await interaction.reply({
          content: `> <🔨> Kicked ${targetUser.tag} from the server (Reason: ${reason}).`,
        });
        await recordModerationAction({
          guildId: interaction.guild.id,
          userId: target.id,
          moderatorId: interaction.user.id,
          actionType: "kick",
          reason,
        });
        break;
      }

      case "ban": {
        const reason = interaction.options.getString("reason") || "No reason provided";
        await target.ban({ reason });
        await interaction.reply({
          content: `> <🔨> Banned ${targetUser.tag} from the server (Reason: ${reason}).`,
        });
        await recordModerationAction({
          guildId: interaction.guild.id,
          userId: target.id,
          moderatorId: interaction.user.id,
          actionType: "ban",
          reason,
        });
        break;
      }
    }
  } catch (error) {
    console.error(`[ERROR] handleModSlashCommand: ${error.stack}`);
    await logErrorToChannel(
      interaction.guild?.id,
      error.stack,
      interaction.client,
      "handleModSlashCommand"
    );
    if (!interaction.replied) {
      interaction.reply({
        content: "> <❌> An error occurred using mod slash commands.",
        ephemeral: true,
      });
    }
  }
}

module.exports = {
  handleModMessageCommand,
  handleModSlashCommand,
};
