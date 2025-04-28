require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const ms = require("ms");
const {
  PermissionsBitField,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const { logErrorToChannel } = require("../logic/helpers.cjs");

// Constants
const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;
const HISTORY_FETCH_LIMIT = 10;
const HISTORY_PAGE_SIZE = 5;
const STARTING_ACTION_ID = 100000;
const MAX_REASON_WORDS = 50;

/**
 * Get next sequential action ID
 */
async function getNextActionId() {
  const { data, error } = await supabase
    .from("mod_actions")
    .select("id")
    .order("id", { ascending: false })
    .limit(1);
  if (error) {
    console.error("[MOD_ACTION ERROR] fetching max id:", error);
    return STARTING_ACTION_ID;
  }
  return data.length ? Number(data[0].id) + 1 : STARTING_ACTION_ID;
}

/**
 * Record a moderation action in Supabase with sequential integer ID
 */
async function recordModerationAction({
  guildId,
  userId,
  moderatorId,
  actionType,
  reason = null,
  duration = null,
}) {
  const newId = await getNextActionId();
  let trimmedReason = reason;
  if (trimmedReason) {
    const words = trimmedReason.split(/\s+/);
    if (words.length > MAX_REASON_WORDS) {
      trimmedReason = words.slice(0, MAX_REASON_WORDS).join(" ") + "...";
    }
  }
  const { error } = await supabase
    .from("mod_actions")
    .insert([{
      id: newId,
      guildId,
      userId,
      moderatorId,
      actionType,
      reason: trimmedReason,
      duration,
    }]);
  if (error) console.error("[MOD_ACTION ERROR] inserting action:", error);
  return newId;
}

/**
 * Build a monospace table page wrapped in backticks
 */
function buildHistoryPage(records, page) {
  const start = page * HISTORY_PAGE_SIZE;
  const slice = records.slice(start, start + HISTORY_PAGE_SIZE);
  const idWidth = Math.max(...records.map(r => String(r.id).length), 2);
  const userWidth = 20;
  const modWidth = 20;
  const tsWidth = 19;
  const typeWidth = 7;
  const reasonWidth = 30;

  const hdr =
    `${"ID".padEnd(idWidth)} | ` +
    `User`.padEnd(userWidth) + ` | ` +
    `Moderator`.padEnd(modWidth) + ` | ` +
    `Timestamp`.padEnd(tsWidth) + ` | ` +
    `Type`.padEnd(typeWidth) + ` | ` +
    `Reason`.padEnd(reasonWidth);
  const divider = hdr.replace(/[^|]/g, "-");

  const rows = slice.map(r => {
    const id = String(r.id).padEnd(idWidth);
    const user = r.userId.padEnd(userWidth);
    const mod = r.moderatorId.padEnd(modWidth);
    const ts = new Date(r.timestamp)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19)
      .padEnd(tsWidth);
    const typ = r.actionType.padEnd(typeWidth);
    const rea = (r.reason || "").substring(0, reasonWidth).padEnd(reasonWidth);
    return `${id} | ${user} | ${mod} | ${ts} | ${typ} | ${rea}`;
  }).join("\n") || "No entries on this page.";

  return ["```", hdr, divider, rows, "```"].join("\n");
}

/**
 * Paginated backtick‐table with ⇤ ◄ ► ⇥ buttons and page numbers
 */
async function sendPaginatedHistory(context, channel, targetTag, records, authorId) {
  let page = 0;
  const last = Math.ceil(records.length / HISTORY_PAGE_SIZE) - 1;
  const controls = () => new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("history_first")
      .setLabel("⇤")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId("history_prev")
      .setLabel("◄")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId("history_next")
      .setLabel("►")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page === last),
    new ButtonBuilder()
      .setCustomId("history_last")
      .setLabel("⇥")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page === last)
  );

  const content = () =>
    `**History for ${targetTag} — Page ${page + 1}/${last + 1}**\n` +
    buildHistoryPage(records, page);

  const msg = await channel.send({
    content: content(),
    components: [controls()],
  });

  const coll = msg.createMessageComponentCollector({
    filter: (i) => i.user.id === authorId,
    time: 60_000,
  });

  coll.on("collect", async (i) => {
    switch (i.customId) {
      case "history_first":
        page = 0;
        break;
      case "history_prev":
        page = Math.max(page - 1, 0);
        break;
      case "history_next":
        page = Math.min(page + 1, last);
        break;
      case "history_last":
        page = last;
        break;
    }
    await i.update({
      content: content(),
      components: [controls()],
    });
  });

  coll.on("end", () => {
    msg.edit({ components: [] }).catch(() => { });
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
        `> <❌> Unknown subcommand. Use: ${Object.keys(usage)
          .map((s) => "`" + s + "`")
          .join(", ")}`
      );
    }

    const targetArg = args[1];
    if (!targetArg) {
      return message.channel.send(usage[sub]);
    }

    const target =
      message.mentions.members.first() ||
      (await message.guild.members.fetch(targetArg).catch(() => null));
    if (!target) {
      return message.channel.send("> <❇️> Could not find that user in this server.");
    }

    switch (sub) {
      case "warn": {
        const reason = args.slice(2).join(" ") || null;
        const id = await recordModerationAction({
          guildId: message.guild.id,
          userId: target.id,
          moderatorId: message.member.id,
          actionType: "warn",
          reason,
        });
        return message.channel.send(
          `> <🔨> Warned ${target.user.tag}${reason ? ` (Reason: ${reason})` : ""}. [ID: ${id}]`
        );
      }

      case "history": {
        const { data: records, error } = await supabase
          .from("mod_actions")
          .select("*")
          .or(`userId.eq.${target.id},moderatorId.eq.${target.id}`)
          .order("timestamp", { ascending: false })
          .limit(HISTORY_FETCH_LIMIT);

        if (error) {
          return message.channel.send("> <❌> Error fetching mod history.");
        }
        if (!records.length) {
          return message.channel.send(`> <❇️> No history for ${target.user.tag}.`);
        }

        return sendPaginatedHistory(
          message,
          message.channel,
          target.user.tag,
          records,
          message.author.id
        );
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
          durationMs = 3600000;
          durationSec = 3600;
          reason = args.slice(2).join(" ") || null;
        }

        await target.timeout(durationMs, reason || "No reason provided");
        const muteId = await recordModerationAction({
          guildId: message.guild.id,
          userId: target.id,
          moderatorId: message.member.id,
          actionType: "mute",
          reason,
          duration: durationSec,
        });
        return message.channel.send(
          `> <🔨> Muted ${target.user.tag} for ${durationSec}s${reason ? ` (Reason: ${reason})` : ""
          }. [ID: ${muteId}]`
        );
      }

      case "unmute": {
        const reason = args.slice(2).join(" ") || null;
        await target.timeout(null, reason || "No reason provided");
        const unmuteId = await recordModerationAction({
          guildId: message.guild.id,
          userId: target.id,
          moderatorId: message.member.id,
          actionType: "unmute",
          reason,
        });
        return message.channel.send(
          `> <🔧> Unmuted ${target.user.tag}${reason ? ` (Reason: ${reason})` : ""
          }. [ID: ${unmuteId}]`
        );
      }

      case "kick": {
        const reason = args.slice(2).join(" ") || "No reason provided";
        await target.kick(reason);
        const kickId = await recordModerationAction({
          guildId: message.guild.id,
          userId: target.id,
          moderatorId: message.member.id,
          actionType: "kick",
          reason,
        });
        return message.channel.send(
          `> <🔨> Kicked ${target.user.tag} (Reason: ${reason}). [ID: ${kickId}]`
        );
      }

      case "ban": {
        const reason = args.slice(2).join(" ") || "No reason provided";
        await target.ban({ reason });
        const banId = await recordModerationAction({
          guildId: message.guild.id,
          userId: target.id,
          moderatorId: message.member.id,
          actionType: "ban",
          reason,
        });
        return message.channel.send(
          `> <🔨> Banned ${target.user.tag} (Reason: ${reason}). [ID: ${banId}]`
        );
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
 * Slash-based /mod <subcommand> <user> [duration] [reason]
 */
async function handleModSlashCommand(interaction) {
  try {
    if (!interaction.memberPermissions.has(PermissionsBitField.Flags.KickMembers)) {
      return interaction.reply({ content: "> <❇️> You do not have permission.", ephemeral: true });
    }

    const sub = interaction.options.getSubcommand();
    const targetUser = interaction.options.getUser("user");
    const target = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    if (!target) {
      return interaction.reply({ content: "> <❇️> Could not find that user.", ephemeral: true });
    }

    switch (sub) {
      case "warn": {
        const reason = interaction.options.getString("reason") || null;
        const id = await recordModerationAction({
          guildId: interaction.guild.id,
          userId: target.id,
          moderatorId: interaction.user.id,
          actionType: "warn",
          reason,
        });
        return interaction.reply({
          content: `> <🔨> Warned ${targetUser.tag}${reason ? ` (Reason: ${reason})` : ""
            }. [ID: ${id}]`,
        });
      }

      case "history": {
        const { data: records, error } = await supabase
          .from("mod_actions")
          .select("*")
          .or(`userId.eq.${target.id},moderatorId.eq.${target.id}`)
          .order("timestamp", { ascending: false })
          .limit(HISTORY_FETCH_LIMIT);
        if (error) {
          return interaction.reply({ content: "> <❌> Error fetching history.", ephemeral: true });
        }
        if (!records.length) {
          return interaction.reply({ content: `> <❇️> No history for ${targetUser.tag}.`, ephemeral: true });
        }
        const reply = await interaction.reply({ content: "Loading history...", fetchReply: true });
        return sendPaginatedHistory(interaction, reply.channel, targetUser.tag, records, interaction.user.id);
      }

      case "mute": {
        const durationStr = interaction.options.getString("duration");
        let durationMs, durationSec;
        const reason = interaction.options.getString("reason") || null;
        if (durationStr && ms(durationStr)) {
          durationMs = ms(durationStr);
          if (durationMs > MAX_TIMEOUT_MS) {
            return interaction.reply({ content: "> <❌> Duration too long.", ephemeral: true });
          }
          durationSec = durationMs / 1000;
        } else {
          durationMs = 3600000;
          durationSec = 3600;
        }
        await target.timeout(durationMs, reason || "No reason provided");
        const id = await recordModerationAction({
          guildId: interaction.guild.id,
          userId: target.id,
          moderatorId: interaction.user.id,
          actionType: "mute",
          reason,
          duration: durationSec,
        });
        return interaction.reply({
          content: `> <🔨> Muted ${targetUser.tag} for ${durationSec}s${reason ? ` (Reason: ${reason})` : ""
            }. [ID: ${id}]`,
        });
      }

      case "unmute": {
        const reason = interaction.options.getString("reason") || null;
        await target.timeout(null, reason || "No reason provided");
        const id = await recordModerationAction({
          guildId: interaction.guild.id,
          userId: target.id,
          moderatorId: interaction.user.id,
          actionType: "unmute",
          reason,
        });
        return interaction.reply({
          content: `> <🔧> Unmuted ${targetUser.tag}${reason ? ` (Reason: ${reason})` : ""
            }. [ID: ${id}]`,
        });
      }

      case "kick": {
        const reason = interaction.options.getString("reason") || "No reason provided";
        await target.kick(reason);
        const id = await recordModerationAction({
          guildId: interaction.guild.id,
          userId: target.id,
          moderatorId: interaction.user.id,
          actionType: "kick",
          reason,
        });
        return interaction.reply({
          content: `> <🔨> Kicked ${targetUser.tag} (Reason: ${reason}). [ID: ${id}]`,
        });
      }

      case "ban": {
        const reason = interaction.options.getString("reason") || "No reason provided";
        await target.ban({ reason });
        const id = await recordModerationAction({
          guildId: interaction.guild.id,
          userId: target.id,
          moderatorId: interaction.user.id,
          actionType: "ban",
          reason,
        });
        return interaction.reply({
          content: `> <🔨> Banned ${targetUser.tag} (Reason: ${reason}). [ID: ${id}]`,
        });
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
    if (!interaction.replied) interaction.reply({ content: "> <❌> An error occurred.", ephemeral: true });
  }
}

module.exports = {
  handleModMessageCommand,
  handleModSlashCommand,
};
