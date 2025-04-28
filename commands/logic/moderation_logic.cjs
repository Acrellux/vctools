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
  // auto-trim reason to MAX_REASON_WORDS
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
 * Build a monospace table page wrapped in backticks,
 * splitting reason into lines every 5 words and indenting
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

  const indent = " ".repeat(
    idWidth + 3 + userWidth + 3 + modWidth + 3 + tsWidth + 3 + typeWidth + 3
  );

  const rows = slice.map(r => {
    const words = (r.reason || "").split(/\s+/);
    const chunks = [];
    for (let i = 0; i < words.length; i += 5) {
      chunks.push(words.slice(i, i + 5).join(" "));
    }
    if (!chunks.length) chunks.push("");
    const idStr = String(r.id).padEnd(idWidth);
    const user = r.userId.padEnd(userWidth);
    const mod = r.moderatorId.padEnd(modWidth);
    const ts = new Date(r.timestamp)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
    const type = r.actionType.padEnd(typeWidth);
    const first = chunks[0].substring(0, reasonWidth).padEnd(reasonWidth);

    let line = `${idStr} | ${user} | ${mod} | ${ts} | ${type} | ${first}`;
    for (let j = 1; j < chunks.length; j++) {
      line += `\n${indent}${chunks[j].substring(0, reasonWidth).padEnd(reasonWidth)}`;
    }
    return line;
  }).join("\n") || "No entries on this page.";

  return "```" + "\n" + hdr + "\n" + divider + "\n" + rows + "\n```";
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

  const sendContent = () =>
    `**History for ${targetTag} — Page ${page + 1}/${last + 1}**\n` +
    buildHistoryPage(records, page);

  const msg = await channel.send({
    content: sendContent(),
    components: [controls()],
  });

  const coll = msg.createMessageComponentCollector({
    filter: (i) => i.user.id === authorId,
    time: 60_000,
  });

  coll.on("collect", async (i) => {
    switch (i.customId) {
      case "history_first": page = 0; break;
      case "history_prev": page = Math.max(page - 1, 0); break;
      case "history_next": page = Math.min(page + 1, last); break;
      case "history_last": page = last; break;
    }
    await i.update({
      content: sendContent(),
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
      return message.channel.send(
        "> <❇️> You do not have permission to use mod commands."
      );
    }

    const usage = {
      mute: "> <❌> Usage: `>mod mute <user> <duration> <reason>`",
      unmute: "> <❌> Usage: `>mod unmute <user> <reason>`",
      kick: "> <❌> Usage: `>mod kick <user> <reason>`",
      ban: "> <❌> Usage: `>mod ban <user> <reason>`",
      warn: "> <❌> Usage: `>mod warn <user> <reason>`",
      history: "> <❌> Usage: `>mod history <user>` or `>mod history delete <action_id>`",
    };

    const sub = args[0]?.toLowerCase();
    if (!sub || !usage[sub]) {
      return message.channel.send(
        `> <❌> Unknown subcommand. Use: ${Object.keys(usage)
          .map((s) => "`" + s + "`")
          .join(", ")}`
      );
    }

    // HISTORY DELETE
    if (sub === "history" && args[1]?.toLowerCase() === "delete") {
      const id = args[2];
      if (!id) {
        return message.channel.send("> <❌> Usage: `>mod history delete <action_id>`");
      }
      // check existence
      const { data: exists, error: errExist } = await supabase
        .from("mod_actions")
        .select("id")
        .eq("id", id)
        .maybeSingle();
      if (errExist) {
        console.error("[MOD_ACTION ERROR] checking ID:", errExist);
        return message.channel.send("> <❌> Error checking action ID.");
      }
      if (!exists) {
        return message.channel.send("> <❌> Invalid action ID.");
      }

      // ask confirmation
      const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`confirm_delete_${deleteId}`)
          .setLabel("Yes")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`cancel_delete_${deleteId}`)
          .setLabel("No")
          .setStyle(ButtonStyle.Secondary)
      );
      const confirmMsg = await message.channel.send({
        content: `> <⚠️> Delete entry \`${id}\`?`,
        components: [confirmRow],
      });
      const coll = confirmMsg.createMessageComponentCollector({
        filter: (i) => i.user.id === message.author.id,
        time: 30_000,
      });
      coll.on("collect", async (i) => {
        if (i.customId === `confirm_delete_${id}`) {
          const { data, error } = await supabase
            .from("mod_actions")
            .delete()
            .eq("id", id);
          if (error) {
            return i.update({ content: "> <❌> Error deleting entry.", components: [] });
          }
          return i.update({ content: `> <✅> Deleted entry \`${id}\`.`, components: [] });
        } else {
          return i.update({ content: `> <❌> Deletion cancelled.`, components: [] });
        }
      });
      return;
    }

    // other subs require a target user
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
        const actionId = await recordModerationAction({
          guildId: message.guild.id,
          userId: target.id,
          moderatorId: message.member.id,
          actionType: "warn",
          reason,
        });
        return message.channel.send(
          `> <🔨> Warned ${target.user.tag}${reason ? ` (Reason: ${reason})` : ""
          }. [ID: ${actionId}]`
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
          durationMs = 60 * 60 * 1000;
          durationSec = 60 * 60;
          reason = args.slice(2).join(" ") || null;
        }
        await target.timeout(durationMs, reason || "No reason provided");
        const actionIdMute = await recordModerationAction({
          guildId: message.guild.id,
          userId: target.id,
          moderatorId: message.member.id,
          actionType: "mute",
          reason,
          duration: durationSec,
        });
        return message.channel.send(
          `> <🔨> Muted ${target.user.tag} for ${durationSec}s${reason ? ` (Reason: ${reason})` : ""
          }. [ID: ${actionIdMute}]`
        );
      }

      case "unmute": {
        const reasonUn = args.slice(2).join(" ") || null;
        await target.timeout(null, reasonUn || "No reason provided");
        const actionIdUn = await recordModerationAction({
          guildId: message.guild.id,
          userId: target.id,
          moderatorId: message.member.id,
          actionType: "unmute",
          reason: reasonUn,
        });
        return message.channel.send(
          `> <🔧> Unmuted ${target.user.tag}${reasonUn ? ` (Reason: ${reasonUn})` : ""
          }. [ID: ${actionIdUn}]`
        );
      }

      case "kick": {
        const reasonK = args.slice(2).join(" ") || "No reason provided";
        await target.kick(reasonK);
        const actionIdKick = await recordModerationAction({
          guildId: message.guild.id,
          userId: target.id,
          moderatorId: message.member.id,
          actionType: "kick",
          reason: reasonK,
        });
        return message.channel.send(
          `> <🔨> Kicked ${target.user.tag} (Reason: ${reasonK}). [ID: ${actionIdKick}]`
        );
      }

      case "ban": {
        const reasonB = args.slice(2).join(" ") || "No reason provided";
        await target.ban({ reason: reasonB });
        const actionIdBan = await recordModerationAction({
          guildId: message.guild.id,
          userId: target.id,
          moderatorId: message.member.id,
          actionType: "ban",
          reason: reasonB,
        });
        return message.channel.send(
          `> <🔨> Banned ${target.user.tag} (Reason: ${reasonB}). [ID: ${actionIdBan}]`
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
 * Slash-based /mod <subcommand> ...
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
    const deleteId = interaction.options.getString("delete_id");
    let target = null;
    if (sub !== "history" || !deleteId) {
      target = await interaction.guild.members.fetch(targetUser?.id).catch(() => null);
      if (!target) {
        return interaction.reply({
          content: "> <❇️> Could not find that user in this server.",
          ephemeral: true,
        });
      }
    }

    // slash: history delete confirmation
    if (sub === "history" && deleteId) {
      // check existence
      const { data: exists, error: errExist } = await supabase
        .from("mod_actions")
        .select("id")
        .eq("id", deleteId)
        .maybeSingle();
      if (errExist) {
        console.error("[MOD_ACTION ERROR] checking ID:", errExist);
        return interaction.reply({ content: "> <❌> Error checking action ID.", ephemeral: true });
      }
      if (!exists) {
        return interaction.reply({ content: "> <❌> Invalid action ID.", ephemeral: true });
      }
      const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`confirm_delete_${deleteId}`)
          .setLabel("Yes")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`cancel_delete_${deleteId}`)
          .setLabel("No")
          .setStyle(ButtonStyle.Secondary)
      );
      const confirmMsg = await interaction.reply({
        content: `> <⚠️> Delete entry \`${deleteId}\`?`,
        components: [confirmRow],
        ephemeral: true,
        fetchReply: true,
      });
      const coll = confirmMsg.createMessageComponentCollector({
        filter: (i) => i.user.id === interaction.user.id,
        time: 30_000,
      });
      coll.on("collect", async (i) => {
        if (i.customId === `confirm_delete_${deleteId}`) {
          const { data, error } = await supabase
            .from("mod_actions")
            .delete()
            .eq("id", deleteId);
          if (error) {
            return i.update({ content: "> <❌> Error deleting entry.", components: [] });
          }
          return i.update({ content: `> <✅> Deleted entry \`${deleteId}\`.`, components: [] });
        } else {
          return i.update({ content: `> <❌> Deletion cancelled.`, components: [] });
        }
      });
      return;
    }

    switch (sub) {
      case "warn": {
        const reason = interaction.options.getString("reason") || null;
        const actionId = await recordModerationAction({
          guildId: interaction.guild.id,
          userId: target.id,
          moderatorId: interaction.user.id,
          actionType: "warn",
          reason,
        });
        return interaction.reply({
          content: `> <🔨> Warned ${targetUser.tag}${reason ? ` (Reason: ${reason})` : ""
            }. [ID: ${actionId}]`,
        });
      }

      case "history": {
        const { data: records, error } = await supabase
          .from("mod_actions")
          .select("*")
          .or(`userId.eq.${targetUser.id},moderatorId.eq.${targetUser.id}`)
          .order("timestamp", { ascending: false })
          .limit(HISTORY_FETCH_LIMIT);
        if (error) {
          return interaction.reply({ content: "> <❌> Error fetching mod history.", ephemeral: true });
        }
        if (!records.length) {
          return interaction.reply({ content: `> <❇️> No history for ${targetUser.tag}.`, ephemeral: true });
        }
        const reply = await interaction.reply({ content: "Loading history...", fetchReply: true });
        return sendPaginatedHistory(
          interaction,
          reply.channel,
          targetUser.tag,
          records,
          interaction.user.id
        );
      }

      case "mute": {
        let durationMs, durationSec;
        const durationStr = interaction.options.getString("duration");
        const reason = interaction.options.getString("reason") || null;
        if (durationStr && ms(durationStr)) {
          durationMs = ms(durationStr);
          if (durationMs > MAX_TIMEOUT_MS) {
            return interaction.reply({
              content: "> <❌> Duration too long. Max is 28 days.",
              ephemeral: true,
            });
          }
          durationSec = durationMs / 1000;
        } else {
          durationMs = 60 * 60 * 1000;
          durationSec = 60 * 60;
        }
        await target.timeout(durationMs, reason || "No reason provided");
        const actionIdMute = await recordModerationAction({
          guildId: interaction.guild.id,
          userId: target.id,
          moderatorId: interaction.user.id,
          actionType: "mute",
          reason,
          duration: durationSec,
        });
        return interaction.reply({
          content: `> <🔨> Muted ${targetUser.tag} for ${durationSec}s${reason ? ` (Reason: ${reason})` : ""
            }. [ID: ${actionIdMute}]`,
        });
      }

      case "unmute": {
        const reasonUn = interaction.options.getString("reason") || null;
        await target.timeout(null, reasonUn || "No reason provided");
        const actionIdUn = await recordModerationAction({
          guildId: interaction.guild.id,
          userId: target.id,
          moderatorId: interaction.user.id,
          actionType: "unmute",
          reason: reasonUn,
        });
        return interaction.reply({
          content: `> <🔧> Unmuted ${targetUser.tag}${reasonUn ? ` (Reason: ${reasonUn})` : ""
            }. [ID: ${actionIdUn}]`,
        });
      }

      case "kick": {
        const reasonK = interaction.options.getString("reason") || "No reason provided";
        await target.kick(reasonK);
        const actionIdKick = await recordModerationAction({
          guildId: interaction.guild.id,
          userId: target.id,
          moderatorId: interaction.user.id,
          actionType: "kick",
          reason: reasonK,
        });
        return interaction.reply({
          content: `> <🔨> Kicked ${targetUser.tag} (Reason: ${reasonK}). [ID: ${actionIdKick}]`,
        });
      }

      case "ban": {
        const reasonB = interaction.options.getString("reason") || "No reason provided";
        await target.ban({ reason: reasonB });
        const actionIdBan = await recordModerationAction({
          guildId: interaction.guild.id,
          userId: target.id,
          moderatorId: interaction.user.id,
          actionType: "ban",
          reason: reasonB,
        });
        return interaction.reply({
          content: `> <🔨> Banned ${targetUser.tag} (Reason: ${reasonB}). [ID: ${actionIdBan}]`,
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
