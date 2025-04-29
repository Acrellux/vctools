// moderation_logic.cjs

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

/** Get next sequential action ID */
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

/** Record a moderation action in Supabase */
async function recordModerationAction({
  guildId,
  userId,
  moderatorId,
  actionType,
  reason = null,
  duration = null,
}) {
  const newId = await getNextActionId();
  let trimmed = reason;
  if (trimmed) {
    const words = trimmed.split(/\s+/);
    if (words.length > MAX_REASON_WORDS) {
      trimmed = words.slice(0, MAX_REASON_WORDS).join(" ") + "...";
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
      reason: trimmed,
      duration,
    }]);
  if (error) console.error("[MOD_ACTION ERROR] inserting action:", error);
  return newId;
}

/** Delete a moderation action by ID */
async function deleteModerationAction(id) {
  const { error, count } = await supabase
    .from("mod_actions")
    .delete({ count: "exact" })
    .eq("id", id);
  if (error) console.error("[MOD_ACTION ERROR] deleting action:", error);
  return count > 0;
}

/** Build one page of history table */
function buildHistoryPage(records, page, usersMap) {
  const start = page * HISTORY_PAGE_SIZE;
  const slice = records.slice(start, start + HISTORY_PAGE_SIZE);
  const idW = Math.max(...records.map(r => String(r.id).length), 2);
  const userW = 20, modW = 20, tsW = 19, typeW = 7, reasonW = 30;

  const hdr =
    `${"ID".padEnd(idW)} | ` +
    `User`.padEnd(userW) + ` | ` +
    `Moderator`.padEnd(modW) + ` | ` +
    `Timestamp`.padEnd(tsW) + ` | ` +
    `Type`.padEnd(typeW) + ` | ` +
    `Reason`.padEnd(reasonW);
  const divider = hdr.replace(/[^|]/g, "-");

  const rows = slice.map(r => {
    const id = String(r.id).padEnd(idW);
    const user = (usersMap.get(r.userId) || r.userId).padEnd(userW);
    const mod = (usersMap.get(r.moderatorId) || r.moderatorId).padEnd(modW);
    const ts = new Date(r.timestamp)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19)
      .padEnd(tsW);
    const typ = r.actionType.padEnd(typeW);
    const rea = (r.reason || "").substring(0, reasonW).padEnd(reasonW);
    return `${id} | ${user} | ${mod} | ${ts} | ${typ} | ${rea}`;
  }).join("\n") || "No entries on this page.";

  return ["```", hdr, divider, rows, "```"].join("\n");
}

/** Send paginated history with buttons */
async function sendPaginatedHistory(context, channel, targetTag, records, authorId) {
  let page = 0;
  const last = Math.ceil(records.length / HISTORY_PAGE_SIZE) - 1;

  // resolve user tags
  const usersMap = new Map();
  for (const r of records) {
    if (!usersMap.has(r.userId)) {
      const u = await context.client.users.fetch(r.userId).catch(() => null);
      usersMap.set(r.userId, u ? u.tag : r.userId);
    }
    if (!usersMap.has(r.moderatorId)) {
      const m = await context.client.users.fetch(r.moderatorId).catch(() => null);
      usersMap.set(r.moderatorId, m ? m.tag : r.moderatorId);
    }
  }

  const controls = () => new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("history_first").setLabel("⇤").setStyle(ButtonStyle.Primary).setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId("history_prev").setLabel("◄").setStyle(ButtonStyle.Primary).setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId("history_next").setLabel("►").setStyle(ButtonStyle.Primary).setDisabled(page === last),
    new ButtonBuilder()
      .setCustomId("history_last").setLabel("⇥").setStyle(ButtonStyle.Primary).setDisabled(page === last)
  );

  const makeContent = () =>
    `**History for ${targetTag} — Page ${page + 1}/${last + 1}**\n` +
    buildHistoryPage(records, page, usersMap);

  const msg = await channel.send({ content: makeContent(), components: [controls()] });
  const coll = msg.createMessageComponentCollector({
    filter: i => i.user.id === authorId,
    time: 60_000
  });

  coll.on("collect", async i => {
    if (i.customId === "history_first") page = 0;
    if (i.customId === "history_prev") page = Math.max(page - 1, 0);
    if (i.customId === "history_next") page = Math.min(page + 1, last);
    if (i.customId === "history_last") page = last;
    await i.update({ content: makeContent(), components: [controls()] });
  });

  coll.on("end", () => msg.edit({ components: [] }).catch(() => { }));
}

/**
 * Message-based handler: >mod <subcommand> ...
 */
async function handleModMessageCommand(message, args) {
  try {
    if (!message.member.permissions.has(PermissionsBitField.Flags.KickMembers)) {
      return message.channel.send("> <❇️> You do not have permission.");
    }

    const usage = {
      mute: "> <❌> Usage: `>mod mute <user> <duration> <reason>`",
      unmute: "> <❌> Usage: `>mod unmute <user> <reason>`",
      kick: "> <❌> Usage: `>mod kick <user> <reason>`",
      ban: "> <❌> Usage: `>mod ban <user> <reason>`",
      warn: "> <❌> Usage: `>mod warn <user> <reason>`",
      history: "> <❌> Usage: `>mod history <user>`",
      delete: "> <❌> Usage: `>mod delete <id>`",
    };

    const sub = args[0]?.toLowerCase();
    if (!sub || !usage[sub]) {
      return message.channel.send(`> <❌> Unknown subcommand. Use: ${Object.keys(usage).map(s => `\`${s}\``).join(", ")}`);
    }

    // DELETE
    if (sub === "delete") {
      const id = Number(args[1]);
      if (!id) return message.channel.send(usage.delete);
      const ok = await deleteModerationAction(id);
      return message.channel.send(
        ok
          ? `> <🗑️> Deleted mod action **${id}**.`
          : `> <❇️> No entry with ID **${id}** found.`
      );
    }

    // all others need a user
    const targetArg = args[1];
    if (!targetArg) return message.channel.send(usage[sub]);

    const target = message.mentions.members.first()
      || await message.guild.members.fetch(targetArg).catch(() => null);
    if (!target) {
      return message.channel.send("> <❇️> Could not find that user.");
    }

    // helper: DM the target
    const dmTarget = async lines => {
      try { await target.send(lines.join("\n")); } catch { }
    };

    switch (sub) {
      case "warn": {
        const reason = args.slice(2).join(" ") || "No reason";
        const id = await recordModerationAction({
          guildId: message.guild.id,
          userId: target.id,
          moderatorId: message.member.id,
          actionType: "warn",
          reason,
        });
        await dmTarget([
          `> <⚠️> You have been \`warned\` in **${message.guild.name}**.`,
          `> \`Reason: ${reason}\``,
          `> \`Action ID: ${id}\``
        ]);
        return message.channel.send(`> <🔨> Warned ${target.user.tag}. [ID: ${id}]`);
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
            return message.channel.send("> <❌> Duration too long. Max 28 days.");
          }
          durationSec = durationMs / 1000;
          reason = args.slice(3).join(" ") || "No reason";
        } else {
          durationMs = 3600000;
          durationSec = 3600;
          reason = args.slice(2).join(" ") || "No reason";
        }

        await target.timeout(durationMs, reason);
        const id = await recordModerationAction({
          guildId: message.guild.id,
          userId: target.id,
          moderatorId: message.member.id,
          actionType: "mute",
          reason,
          duration: durationSec,
        });
        const human = ms(durationMs, { long: true });

        await dmTarget([
          `> <⚠️> You have been \`muted\` for \`${human}\` in **${message.guild.name}**.`,
          `> \`Reason: ${reason}\``,
          `> \`Action ID: ${id}\``
        ]);
        return message.channel.send(`> <🔨> Muted ${target.user.tag}. [ID: ${id}]`);
      }

      case "unmute": {
        const reason = args.slice(2).join(" ") || "No reason";
        await target.timeout(null, reason);
        const id = await recordModerationAction({
          guildId: message.guild.id,
          userId: target.id,
          moderatorId: message.member.id,
          actionType: "unmute",
          reason,
        });
        await dmTarget([
          `> <⚠️> You have been \`unmuted\` in **${message.guild.name}**.`,
          `> \`Reason: ${reason}\``,
          `> \`Action ID: ${id}\``
        ]);
        return message.channel.send(`> <🔓> Unmuted ${target.user.tag}. [ID: ${id}]`);
      }

      case "kick": {
        const reason = args.slice(2).join(" ") || "No reason";
        await target.kick(reason);
        const id = await recordModerationAction({
          guildId: message.guild.id,
          userId: target.id,
          moderatorId: message.member.id,
          actionType: "kick",
          reason,
        });
        await dmTarget([
          `> <⚠️> You have been \`kicked\` from **${message.guild.name}**.`,
          `> \`Reason: ${reason}\``,
          `> \`Action ID: ${id}\``
        ]);
        return message.channel.send(`> <🔨> Kicked ${target.user.tag}. [ID: ${id}]`);
      }

      case "ban": {
        const reason = args.slice(2).join(" ") || "No reason";
        await target.ban({ reason });
        const id = await recordModerationAction({
          guildId: message.guild.id,
          userId: target.id,
          moderatorId: message.member.id,
          actionType: "ban",
          reason,
        });
        await dmTarget([
          `> <⚠️> You have been \`banned\` from **${message.guild.name}**.`,
          `> \`Reason: ${reason}\``,
          `> \`Action ID: ${id}\``
        ]);
        return message.channel.send(`> <🔨> Banned ${target.user.tag}. [ID: ${id}]`);
      }
    }
  } catch (err) {
    console.error(`[ERROR] handleModMessageCommand: ${err.stack}`);
    await logErrorToChannel(message.guild?.id, err.stack, message.client, "handleModMessageCommand");
    message.channel.send("> <❌> An error occurred using mod commands.");
  }
}

/**
 * Slash-based /mod <subcommand> ...
 */
async function handleModSlashCommand(interaction) {
  try {
    if (!interaction.memberPermissions.has(PermissionsBitField.Flags.KickMembers)) {
      return interaction.reply({ content: "> <❇️> You do not have permission.", ephemeral: true });
    }

    const sub = interaction.options.getSubcommand();
    const dmTarget = async (member, lines) => {
      try { await member.send(lines.join("\n")); } catch { }
    };

    // DELETE
    if (sub === "delete") {
      const id = interaction.options.getInteger("id");
      const ok = await deleteModerationAction(id);
      return interaction.reply({
        content: ok
          ? `> <🗑️> Deleted mod action **${id}**.`
          : `> <❇️> No entry with ID **${id}** found.`,
        ephemeral: true,
      });
    }

    const targetUser = interaction.options.getUser("user");
    const target = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    if (!target) {
      return interaction.reply({ content: "> <❇️> Could not find that user.", ephemeral: true });
    }

    switch (sub) {
      case "warn": {
        const reason = interaction.options.getString("reason") || "No reason";
        const id = await recordModerationAction({
          guildId: interaction.guild.id,
          userId: target.id,
          moderatorId: interaction.user.id,
          actionType: "warn",
          reason,
        });
        await dmTarget(target, [
          `> <⚠️> You have been \`warned\` in **${interaction.guild.name}**.`,
          `> \`Reason: ${reason}\``,
          `> \`Action ID: ${id}\``
        ]);
        return interaction.reply({ content: `> <🔨> Warned ${targetUser.tag}. [ID: ${id}]` });
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
        const replyMsg = await interaction.reply({ content: "Loading history...", fetchReply: true });
        return sendPaginatedHistory(interaction, replyMsg.channel, targetUser.tag, records, interaction.user.id);
      }

      case "mute": {
        const durationStr = interaction.options.getString("duration");
        let durationMs, durationSec;
        const reason = interaction.options.getString("reason") || "No reason";
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
        await target.timeout(durationMs, reason);
        const id = await recordModerationAction({
          guildId: interaction.guild.id,
          userId: target.id,
          moderatorId: interaction.user.id,
          actionType: "mute",
          reason,
          duration: durationSec,
        });
        const human = ms(durationMs, { long: true });
        await dmTarget(target, [
          `> <⚠️> You have been \`muted\` for \`${human}\` in **${interaction.guild.name}**.`,
          `> \`Reason: ${reason}\``,
          `> \`Action ID: ${id}\``
        ]);
        return interaction.reply({ content: `> <🔨> Muted ${targetUser.tag}. [ID: ${id}]` });
      }

      case "unmute": {
        const reason = interaction.options.getString("reason") || "No reason";
        await target.timeout(null, reason);
        const id = await recordModerationAction({
          guildId: interaction.guild.id,
          userId: target.id,
          moderatorId: interaction.user.id,
          actionType: "unmute",
          reason,
        });
        await dmTarget(target, [
          `> <⚠️> You have been \`unmuted\` in **${interaction.guild.name}**.`,
          `> \`Reason: ${reason}\``,
          `> \`Action ID: ${id}\``
        ]);
        return interaction.reply({ content: `> <🔓> Unmuted ${targetUser.tag}. [ID: ${id}]` });
      }

      case "kick": {
        const reason = interaction.options.getString("reason") || "No reason";
        await target.kick(reason);
        const id = await recordModerationAction({
          guildId: interaction.guild.id,
          userId: target.id,
          moderatorId: interaction.user.id,
          actionType: "kick",
          reason,
        });
        await dmTarget(target, [
          `> <⚠️> You have been \`kicked\` from **${interaction.guild.name}**.`,
          `> \`Reason: ${reason}\``,
          `> \`Action ID: ${id}\``
        ]);
        return interaction.reply({ content: `> <🔨> Kicked ${targetUser.tag}. [ID: ${id}]` });
      }

      case "ban": {
        const reason = interaction.options.getString("reason") || "No reason";
        await target.ban({ reason });
        const id = await recordModerationAction({
          guildId: interaction.guild.id,
          userId: target.id,
          moderatorId: interaction.user.id,
          actionType: "ban",
          reason,
        });
        await dmTarget(target, [
          `> <⚠️> You have been \`banned\` from **${interaction.guild.name}**.`,
          `> \`Reason: ${reason}\``,
          `> \`Action ID: ${id}\``
        ]);
        return interaction.reply({ content: `> <🔨> Banned ${targetUser.tag}. [ID: ${id}]` });
      }
    }
  } catch (err) {
    console.error(`[ERROR] handleModSlashCommand: ${err.stack}`);
    await logErrorToChannel(
      interaction.guild?.id,
      err.stack,
      interaction.client,
      "handleModSlashCommand"
    );
    if (!interaction.replied) {
      interaction.reply({ content: "> <❌> An error occurred.", ephemeral: true });
    }
  }
}

module.exports = {
  handleModMessageCommand,
  handleModSlashCommand,
};
