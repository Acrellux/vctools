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
      ban: "> <❌> Usage: `>mod ban <user> <reason>`",
      unban: "> <❌> Usage: `>mod unban <user> <reason>`",
      warn: "> <❌> Usage: `>mod warn <user> <reason>`",
      history: "> <❌> Usage: `>mod history <user>`",
      delete: "> <❌> Usage: `>mod delete <id>`",
    };

    const sub = args[0]?.toLowerCase();
    if (!sub || !usage[sub]) {
      return message.channel.send(
        `> <❌> Unknown subcommand. Use: ${Object.keys(usage).map(s => `\`${s}\``).join(", ")}`
      );
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

    // For most commands we need mentions
    const targets = message.mentions.members;
    if (!targets || !targets.size) {
      // allow >mod unban <userID> with no mention
      if (sub === "unban" && args[1]) {
        // we'll handle below
      } else {
        return message.channel.send(usage[sub]);
      }
    }

    const dmLines = (memberOrUser, lines) => {
      try { memberOrUser.send(lines.join("\n")); } catch { }
    };

    switch (sub) {
      case "warn": {
        const reason = args.slice(2).join(" ") || "No reason";
        const results = [];
        for (const member of targets.values()) {
          const id = await recordModerationAction({
            guildId: message.guild.id,
            userId: member.id,
            moderatorId: message.member.id,
            actionType: "warn",
            reason,
          });
          dmLines(member.user, [
            `> <⚠️> You have been \`warned\` in **${message.guild.name}**.`,
            `> \`Reason: ${reason}\``,
            `> \`Action ID: ${id}\``
          ]);
          results.push(member.user.tag);
        }
        return message.channel.send(`> <🔨> Warned: ${results.join(", ")}`);
      }

      case "history": {
        const userId = targets.first().id;
        const { data: records, error } = await supabase
          .from("mod_actions")
          .select("*")
          .or(`\`userId.eq.\${userId},moderatorId.eq.\${userId}\``)
          .order("timestamp", { ascending: false })
          .limit(HISTORY_FETCH_LIMIT);

        if (error) {
          return message.channel.send("> <❌> Error fetching mod history.");
        }
        if (!records.length) {
          return message.channel.send(`> <❇️> No history for ${targets.first().user.tag}.`);
        }
        return sendPaginatedHistory(
          message,
          message.channel,
          targets.first().user.tag,
          records,
          message.author.id
        );
      }

      case "mute": {
        // parse duration+reason once
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
        const human = ms(durationMs, { long: true });
        const results = [];

        for (const member of targets.values()) {
          try {
            await member.timeout(durationMs, reason);
            const id = await recordModerationAction({
              guildId: message.guild.id,
              userId: member.id,
              moderatorId: message.member.id,
              actionType: "mute",
              reason,
              duration: durationSec,
            });
            dmLines(member.user, [
              `> <⚠️> You have been \`muted\` for \`${human}\` in **${message.guild.name}**.`,
              `> \`Reason: ${reason}\``,
              `> \`Action ID: ${id}\``
            ]);
            results.push(member.user.tag);
          } catch {
            results.push(`❌ ${member.user.tag}`);
          }
        }

        return message.channel.send(`> <🔨> Muted: ${results.join(", ")}`);
      }

      case "unmute": {
        const reason = args.slice(2).join(" ") || "No reason";
        const results = [];
        for (const member of targets.values()) {
          try {
            await member.timeout(null, reason);
            dmLines(member.user, [
              `> <🔓> You have been \`unmuted\` in **${message.guild.name}**.`,
              `> \`Reason: ${reason}\``
            ]);
            results.push(member.user.tag);
          } catch {
            results.push(`❌ ${member.user.tag}`);
          }
        }
        return message.channel.send(`> <🔓> Unmuted: ${results.join(", ")}`);
      }

      case "kick": {
        const reason = args.slice(2).join(" ") || "No reason";
        const results = [];
        for (const member of targets.values()) {
          try {
            await member.kick(reason);
            const id = await recordModerationAction({
              guildId: message.guild.id,
              userId: member.id,
              moderatorId: message.member.id,
              actionType: "kick",
              reason,
            });
            dmLines(member.user, [
              `> <⚠️> You have been \`kicked\` from **${message.guild.name}**.`,
              `> \`Reason: ${reason}\``,
              `> \`Action ID: ${id}\``
            ]);
            results.push(member.user.tag);
          } catch {
            results.push(`❌ ${member.user.tag}`);
          }
        }
        return message.channel.send(`> <🔨> Kicked: ${results.join(", ")}`);
      }

      case "ban": {
        const reason = args.slice(2).join(" ") || "No reason";
        const results = [];
        for (const member of targets.values()) {
          try {
            await member.ban({ reason });
            const id = await recordModerationAction({
              guildId: message.guild.id,
              userId: member.id,
              moderatorId: message.member.id,
              actionType: "ban",
              reason,
            });
            dmLines(member.user, [
              `> <⚠️> You have been \`banned\` from **${message.guild.name}**.`,
              `> \`Reason: ${reason}\``,
              `> \`Action ID: ${id}\``
            ]);
            results.push(member.user.tag);
          } catch {
            results.push(`❌ ${member.user.tag}`);
          }
        }
        return message.channel.send(`> <🔨> Banned: ${results.join(", ")}`);
      }

      case "unban": {
        const reason = args.slice(2).join(" ") || "No reason";
        const results = [];
        const bans = await message.guild.bans.fetch();

        // allow passing IDs if no mentions
        const ids = targets.size
          ? [...targets.values()].map(m => m.id)
          : [args[1]];

        for (const id of ids) {
          if (!bans.has(id)) {
            results.push(`❇️ ${id}`);
            continue;
          }
          try {
            await message.guild.members.unban(id, reason);
            const idRecord = await recordModerationAction({
              guildId: message.guild.id,
              userId: id,
              moderatorId: message.member.id,
              actionType: "unban",
              reason,
            });
            const user = await message.client.users.fetch(id);
            dmLines(user, [
              `> <🔓> You have been \`unbanned\` in **${message.guild.name}**.`,
              `> \`Reason: ${reason}\``,
              `> \`Action ID: ${idRecord}\``
            ]);
            results.push(user.tag);
          } catch {
            results.push(`❌ ${id}`);
          }
        }
        return message.channel.send(`> <🔓> Unbanned: ${results.join(", ")}`);
      }
    }
  } catch (err) {
    console.error(`[ERROR] handleModMessageCommand: ${err.stack}`);
    await logErrorToChannel(
      message.guild?.id,
      err.stack,
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
      return interaction.reply({ content: "> <❇️> You do not have permission.", ephemeral: true });
    }

    const sub = interaction.options.getSubcommand();
    const usersInput = interaction.options.getString("users") || "";
    // extract mentioned IDs
    const idRegex = /<@!?(\\d{17,19})>/g;
    const ids = [];
    let m;
    while ((m = idRegex.exec(usersInput)) !== null) {
      ids.push(m[1]);
    }
    // also accept plain IDs
    for (const part of usersInput.split(/[\s,]+/)) {
      if (/^\d{17,19}$/.test(part) && !ids.includes(part)) {
        ids.push(part);
      }
    }
    if (!ids.length && sub !== "delete" && sub !== "history") {
      return interaction.reply({ content: "> <❌> No valid users provided.", ephemeral: true });
    }

    const dmLines = async (userOrMember, lines) => {
      try { await userOrMember.send(lines.join("\n")); } catch { }
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

    // HISTORY (single target only)
    if (sub === "history") {
      const targetUser = interaction.options.getUser("user");
      const { data: records, error } = await supabase
        .from("mod_actions")
        .select("*")
        .or(`userId.eq.${targetUser.id},moderatorId.eq.${targetUser.id}`)
        .order("timestamp", { ascending: false })
        .limit(HISTORY_FETCH_LIMIT);
      if (error) {
        return interaction.reply({ content: "> <❌> Error fetching history.", ephemeral: true });
      }
      if (!records.length) {
        return interaction.reply({ content: `> <❇️> No history for ${targetUser.tag}.`, ephemeral: true });
      }
      const replyMsg = await interaction.reply({ content: "Loading history...", fetchReply: true });
      return sendPaginatedHistory(
        interaction,
        replyMsg.channel,
        targetUser.tag,
        records,
        interaction.user.id
      );
    }

    const reason = interaction.options.getString("reason") || "No reason";
    let durationMs, durationSec, human;
    if (sub === "mute") {
      const durationStr = interaction.options.getString("duration");
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
      human = ms(durationMs, { long: true });
    }

    const results = [];
    for (const id of ids) {
      try {
        if (sub === "mute") {
          const member = await interaction.guild.members.fetch(id);
          await member.timeout(durationMs, reason);
          const recId = await recordModerationAction({
            guildId: interaction.guild.id,
            userId: id,
            moderatorId: interaction.user.id,
            actionType: "mute",
            reason,
            duration: durationSec,
          });
          await dmLines(member.user, [
            `> <⚠️> You have been \`muted\` for \`${human}\` in **${interaction.guild.name}**.`,
            `> \`Reason: ${reason}\``,
            `> \`Action ID: ${recId}\``
          ]);
          results.push(member.user.tag);
        } else if (sub === "unmute") {
          const member = await interaction.guild.members.fetch(id);
          await member.timeout(null, reason);
          await dmLines(member.user, [
            `> <🔓> You have been \`unmuted\` in **${interaction.guild.name}**.`,
            `> \`Reason: ${reason}\``
          ]);
          results.push(member.user.tag);
        } else if (sub === "kick") {
          const member = await interaction.guild.members.fetch(id);
          await member.kick(reason);
          const recId = await recordModerationAction({
            guildId: interaction.guild.id,
            userId: id,
            moderatorId: interaction.user.id,
            actionType: "kick",
            reason,
          });
          await dmLines(member.user, [
            `> <⚠️> You have been \`kicked\` from **${interaction.guild.name}**.`,
            `> \`Reason: ${reason}\``,
            `> \`Action ID: ${recId}\``
          ]);
          results.push(member.user.tag);
        } else if (sub === "ban") {
          const member = await interaction.guild.members.fetch(id);
          await member.ban({ reason });
          const recId = await recordModerationAction({
            guildId: interaction.guild.id,
            userId: id,
            moderatorId: interaction.user.id,
            actionType: "ban",
            reason,
          });
          await dmLines(member.user, [
            `> <⚠️> You have been \`banned\` from **${interaction.guild.name}**.`,
            `> \`Reason: ${reason}\``,
            `> \`Action ID: ${recId}\``
          ]);
          results.push(member.user.tag);
        } else if (sub === "unban") {
          const bans = await interaction.guild.bans.fetch();
          if (!bans.has(id)) {
            results.push(`❇️ ${id}`);
          } else {
            await interaction.guild.members.unban(id, reason);
            const recId = await recordModerationAction({
              guildId: interaction.guild.id,
              userId: id,
              moderatorId: interaction.user.id,
              actionType: "unban",
              reason,
            });
            const user = await interaction.client.users.fetch(id);
            await dmLines(user, [
              `> <🔓> You have been \`unbanned\` in **${interaction.guild.name}**.`,
              `> \`Reason: ${reason}\``,
              `> \`Action ID: ${recId}\``
            ]);
            results.push(user.tag);
          }
        }
      } catch {
        results.push(`❌ ${id}`);
      }
    }

    const emoji = sub === "unmute" || sub === "unban" ? "🔓" : "🔨";
    return interaction.reply({
      content: `> <${emoji}> ${sub.charAt(0).toUpperCase() + sub.slice(1)}d: ${results.join(", ")}`,
    });
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
