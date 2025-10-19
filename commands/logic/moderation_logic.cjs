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

/* ─────── CONSTANTS ─────── */
const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000; // 28 days
const HISTORY_FETCH_LIMIT = 10;
const HISTORY_PAGE_SIZE = 5;
const STARTING_ACTION_ID = 100_000;
const MAX_REASON_WORDS = 50;

/* ─────── DB HELPERS ─────── */
async function getNextActionId() {
  const { data, error } = await supabase
    .from("mod_actions")
    .select("id")
    .order("id", { ascending: false })
    .limit(1);
  if (error) {
    console.error("[MOD_ACTION] fetch max id:", error);
    return STARTING_ACTION_ID;
  }
  return data.length ? Number(data[0].id) + 1 : STARTING_ACTION_ID;
}

async function recordModerationAction(payload) {
  const id = await getNextActionId();
  let { reason } = payload;
  if (reason) {
    const words = reason.split(/\s+/);
    if (words.length > MAX_REASON_WORDS)
      reason = words.slice(0, MAX_REASON_WORDS).join(" ") + "...";
  }
  const { error } = await supabase
    .from("mod_actions")
    .insert([{ ...payload, id, reason }]);
  if (error) console.error("[MOD_ACTION] insert failed:", error);
  return id;
}

// Harden deletion: require guildId in the where clause
async function deleteModerationAction(id, guildId) {
  const { error, count } = await supabase
    .from("mod_actions")
    .delete({ count: "exact" })
    .eq("id", id)
    .eq("guildId", guildId);
  if (error) console.error("[MOD_ACTION] delete failed:", error);
  return count > 0;
}

/* ─────── UTILS ─────── */
const cantModerate = (mod, tgt) => {
  const guild = tgt.guild;
  const botMember = guild.members.me;

  return (
    tgt.id === guild.ownerId ||
    mod.roles.highest.comparePositionTo(tgt.roles.highest) <= 0 ||
    botMember.roles.highest.comparePositionTo(tgt.roles.highest) <= 0
  );
};

async function safeDM(user, lines) {
  try {
    await user.send(lines.join("\n"));
  } catch (e) {
    if (e.code !== 50007) console.error("[DM ERROR]", e);
  }
}

const fmtId = (id) => `\`${id}\``;
const wrap = (txt) => `\`${txt}\``;

const display = {
  mute: { emoji: "🔨", label: "Muted", verb: "muted" },
  unmute: { emoji: "🔓", label: "Unmuted", verb: "unmuted" },
  warn: { emoji: "🔨", label: "Warned", verb: "warned" },
  kick: { emoji: "🔨", label: "Kicked", verb: "kicked" },
  ban: { emoji: "🔨", label: "Banned", verb: "banned" },
  unban: { emoji: "🔓", label: "Unbanned", verb: "unbanned" },
};

/* ─────── HISTORY RENDERING ─────── */
function buildHistoryPage(records, page, map) {
  const start = page * HISTORY_PAGE_SIZE;
  const slice = records.slice(start, start + HISTORY_PAGE_SIZE);

  const idW = Math.max(...records.map((r) => String(r.id).length), 2);
  const userW = 20,
    modW = 20,
    tsW = 19,
    typeW = 8,
    reasonW = 30;

  const header =
    `${"ID".padEnd(idW)} | ` +
    `User`.padEnd(userW) +
    ` | ` +
    `Moderator`.padEnd(modW) +
    ` | ` +
    `Timestamp`.padEnd(tsW) +
    ` | ` +
    `Type`.padEnd(typeW) +
    ` | ` +
    `Reason`.padEnd(reasonW);

  const rows =
    slice
      .map((r) => {
        const id = String(r.id).padEnd(idW);
        const user = (map.get(r.userId) || r.userId).padEnd(userW);
        const mod = (map.get(r.moderatorId) || r.moderatorId).padEnd(modW);
        const ts = new Date(r.timestamp)
          .toISOString()
          .replace("T", " ")
          .slice(0, 19)
          .padEnd(tsW);
        const typ = r.actionType.padEnd(typeW);
        const rea = (r.reason || "").slice(0, reasonW).padEnd(reasonW);
        return `${id} | ${user} | ${mod} | ${ts} | ${typ} | ${rea}`;
      })
      .join("\n") || "No entries on this page.";

  return ["```", header, header.replace(/[^|]/g, "-"), rows, "```"].join("\n");
}

async function sendPaginatedHistory(ctx, chan, tag, recs, authId) {
  let page = 0;
  const last = Math.ceil(recs.length / HISTORY_PAGE_SIZE) - 1;

  const map = new Map();
  await Promise.all(
    recs.flatMap((r) => [r.userId, r.moderatorId]).map(async (id) => {
      if (!map.has(id)) {
        const u = await ctx.client.users.fetch(id).catch(() => null);
        map.set(id, u ? u.tag : id);
      }
    })
  );

  const controls = () =>
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`modhist:first:${authId}`)
        .setLabel("⇤")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId(`modhist:prev:${authId}`)
        .setLabel("◄")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId(`modhist:next:${authId}`)
        .setLabel("►")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(page === last),
      new ButtonBuilder()
        .setCustomId(`modhist:last:${authId}`)
        .setLabel("⇥")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(page === last)
    );

  const makeContent = () =>
    `**History for ${tag} — Page ${page + 1}/${last + 1}**\n${buildHistoryPage(
      recs,
      page,
      map
    )}`;

  const msg = await chan.send({ content: makeContent(), components: [controls()] });
  const coll = msg.createMessageComponentCollector({
    filter: (i) => i.user.id === authId && i.customId.startsWith("modhist:"),
    time: 60000,
  });

  coll.on("collect", async (i) => {
    const [, which] = i.customId.split(":"); // modhist:<which>:<authId>
    page =
      which === "first" ? 0 :
      which === "prev" ? Math.max(page - 1, 0) :
      which === "next" ? Math.min(page + 1, last) :
      last;
    await i.update({ content: makeContent(), components: [controls()] });
  });
  coll.on("end", () => msg.edit({ components: [] }).catch(() => {}));
}

/* ─────── SINGLE ACTION VIEW RENDER ─────── */
function buildSingleActionView(rec, userTag, modTag) {
  const idW = Math.max(String(rec.id).length, 2);
  const userW = 20, modW = 20, tsW = 19, typeW = 8;

  const header =
    `${"ID".padEnd(idW)} | ` +
    `User`.padEnd(userW) +
    ` | ` +
    `Moderator`.padEnd(modW) +
    ` | ` +
    `Timestamp`.padEnd(tsW) +
    ` | ` +
    `Type`.padEnd(typeW);

  const row = [
    String(rec.id).padEnd(idW),
    (userTag || rec.userId).padEnd(userW),
    (modTag || rec.moderatorId).padEnd(modW),
    new Date(rec.timestamp).toISOString().replace("T", " ").slice(0, 19).padEnd(tsW),
    (rec.actionType || "").padEnd(typeW),
  ].join(" | ");

  const reason = rec.reason || "";
  const lines = [
    "```",
    header,
    header.replace(/[^|]/g, "-"),
    row,
    "",
    `Reason | ${reason}`,
    "```",
  ];
  return lines.join("\n");
}

/* ─────── SHARED ACTION EXECUTOR (ALL BUT UNMUTE) ─────── */
async function performAndLog({
  member,
  moderator,
  guild,
  type,
  reason,
  durationMs,
  durationSec,
}) {
  const id = await recordModerationAction({
    guildId: guild.id,
    userId: member.id,
    moderatorId: moderator.id,
    actionType: type,
    reason,
    duration: durationSec,
  });

  const dmLines = [
    `> <⚠️> You have been \`${display[type].verb}\`${type === "mute" ? ` for \`${ms(durationMs, { long: true })}\`` : ""} in **${guild.name}**.`,
    `> Reason: ${wrap(reason)}`,
    `> Action ID: ${fmtId(id)}`,
  ];

  // DM first for kick/ban so they actually see it
  if (type === "kick" || type === "ban") {
    await safeDM(member.user, dmLines);
    if (type === "kick") await member.kick(reason);
    else await member.ban({ reason });
  } else {
    if (type === "mute") await member.timeout(durationMs, reason);
    await safeDM(member.user, dmLines);
  }

  return id;
}

/* ─────── MESSAGE COMMAND (>tc …) ─────── */
async function handleModMessageCommand(msg, args) {
  try {
    if (!msg.member.permissions.has(PermissionsBitField.Flags.KickMembers))
      return msg.channel.send("> <❌> You do not have permission.");

    const sub = (args[0] || "").toLowerCase();
    const valid = [
      "mute",
      "unmute",
      "warn",
      "kick",
      "ban",
      "unban",
      "history",
      "delete",
      "view",
    ];
    if (!valid.includes(sub))
      return msg.channel.send(
        `> <❌> Unknown subcommand. Use: ${valid.map((s) => `\`${s}\``).join(", ")}`
      );

    /* delete */
    if (sub === "delete") {
      const id = Number(args[1]);
      if (!id) return msg.channel.send("> <❌> Usage: `>tc delete <id>`");

      // Verify record belongs to this guild, then delete with guild guard
      const { data: found, error: fErr } = await supabase
        .from("mod_actions")
        .select("id,guildId")
        .eq("id", id)
        .eq("guildId", msg.guild.id)
        .single();

      if (fErr || !found)
        return msg.channel.send("> <❇️> No entry with that ID in **this server**.");

      const ok = await deleteModerationAction(id, msg.guild.id);
      return msg.channel.send(
        ok
          ? `> <🗑️> Deleted mod action **${id}**.`
          : `> <❇️> No entry with ID **${id}** found.`
      );
    }

    /* view */
    if (sub === "view") {
      const id = Number(args[1]);
      if (!id) return msg.channel.send("> <❌> Usage: `>tc view <id>`");
      const { data, error } = await supabase
        .from("mod_actions")
        .select("*")
        .eq("id", id)
        .eq("guildId", msg.guild.id) // SCOPE TO GUILD
        .single();

      if (error || !data) {
        return msg.channel.send(`> <❇️> No entry with that ID in **this server**.`);
      }

      // Resolve tags for user & moderator
      let userTag = null, modTag = null;
      try {
        const u = await msg.client.users.fetch(data.userId).catch(() => null);
        if (u) userTag = u.tag;
      } catch (_) {}
      try {
        const m = await msg.client.users.fetch(data.moderatorId).catch(() => null);
        if (m) modTag = m.tag;
      } catch (_) {}

      const content = buildSingleActionView(data, userTag, modTag);
      return msg.channel.send(content);
    }

    /* resolve targets */
    let targets = msg.mentions.members;
    if ((!targets || !targets.size) && sub !== "unban" && args[1]) {
      const name = args[1].toLowerCase();
      const found = msg.guild.members.cache.find(
        (m) =>
          m.user.username.toLowerCase() === name ||
          m.displayName.toLowerCase() === name
      );
      if (found) targets = new Map([[found.id, found]]);
      else return msg.channel.send(`> <❌> Could not find user: ${args[1]}`);
    }
    if (sub === "unban") {
      const raw = args[1];
      if (!raw || !/^\d{17,19}$/.test(raw))
        return msg.channel.send("> <❌> Usage: `>tc unban <id>`");
      targets = new Map([[raw, { id: raw }]]);
    }

    /* history */
    if (sub === "history") {
      const member = targets.first();
      const { data, error } = await supabase
        .from("mod_actions")
        .select("*")
        .eq("guildId", msg.guild.id) // SCOPE TO GUILD
        .or(`userId.eq.${member.id},moderatorId.eq.${member.id}`)
        .order("timestamp", { ascending: false })
        .limit(HISTORY_FETCH_LIMIT);
      if (error) return msg.channel.send("> <❌> Error fetching history.");
      if (!data.length)
        return msg.channel.send(`> <❇️> No history for ${member.user.tag} in this server.`);
      return sendPaginatedHistory(
        msg,
        msg.channel,
        member.user.tag,
        data,
        msg.author.id
      );
    }

    /* reason & duration */
    const reasonIdx =
      sub === "mute" && ms(args[2]) ? 3 : sub === "unban" ? 2 : 2;
    const reason = args.slice(reasonIdx).join(" ") || "No reason";

    const confirms = [];

    for (const target of targets.values()) {
      /* ─── UNBAN ─── */
      if (sub === "unban") {
        try {
          const bans = await msg.guild.bans.fetch();
          if (!bans.has(target.id)) {
            confirms.push(`> <❇️>  \`${target.id}\` is not currently banned.`);
            continue;
          }
          await msg.guild.members.unban(target.id, reason);
          const id = await recordModerationAction({
            guildId: msg.guild.id,
            userId: target.id,
            moderatorId: msg.member.id,
            actionType: "unban",
            reason,
          });
          const usr = await msg.client.users.fetch(target.id).catch(() => null);
          if (usr)
            await safeDM(usr, [
              `> <🔓> You have been \`unbanned\` in **${msg.guild.name}**.`,
              `> Reason: ${wrap(reason)}`,
              `> Action ID: ${fmtId(id)}`,
            ]);
          confirms.push(
            [
              `> <${display.unban.emoji}> ${display.unban.label}: ${wrap(
                usr ? usr.tag : target.id
              )}`,
              `> Reason: ${wrap(reason)}`,
              `> Action ID: ${fmtId(id)}`,
            ].join("\n")
          );
        } catch {
          confirms.push(`> <❌> Failed to unban \`${target.id}\``);
        }
        continue;
      }

      const member = target;
      if (cantModerate(msg.member, member)) {
        confirms.push(
          `> <❌> You cannot act on ${wrap(member.user.tag)}.`
        );
        continue;
      }

      try {
        /* ─── UNMUTE (no DB) ─── */
        if (sub === "unmute") {
          await member.timeout(null, reason);
          await safeDM(member.user, [
            `> <🔓> You have been \`unmuted\` in **${msg.guild.name}**.`,
            `> Reason: ${wrap(reason)}`,
          ]);
          confirms.push(
            [
              `> <${display.unmute.emoji}> ${display.unmute.label}: ${wrap(
                member.user.tag
              )}`,
              `> Reason: ${wrap(reason)}`,
            ].join("\n")
          );
          continue;
        }

        let durMs, durSec;
        if (sub === "mute") {
          durMs = ms(args[2]) || 3_600_000;
          if (durMs > MAX_TIMEOUT_MS)
            return msg.channel.send("> <❌> Duration too long.");
          durSec = durMs / 1000;
        }

        const id = await performAndLog({
          member,
          moderator: msg.member,
          guild: msg.guild,
          type: sub,
          reason,
          durationMs: durMs,
          durationSec: durSec,
        });

        confirms.push(
          [
            `> <${display[sub].emoji}> ${display[sub].label}: ${wrap(
              member.user.tag
            )}`,
            `> Reason: ${wrap(reason)}`,
            `> Action ID: ${fmtId(id)}`,
          ].join("\n")
        );
      } catch {
        confirms.push(`> <❌> Failed on ${wrap(member.user.tag)}`);
      }
    }

    const result = confirms.join("\n\n") || {
      mute: "> <❌> Usage: `>tc mute <user> [duration] [reason]`",
      warn: "> <❌> Usage: `>tc warn <user> [reason]`",
      kick: "> <❌> Usage: `>tc kick <user> [reason]`",
      ban: "> <❌> Usage: `>tc ban <user> [reason]`",
      unban: "> <❌> Usage: `>tc unban <user ID> [reason]`",
      unmute: "> <❌> Usage: `>tc unmute <user> [reason]`",
      view: "> <❌> Usage: `>tc view <id>`",
    }[sub] || "> <❌> Something went wrong.";

    return msg.channel.send(result);
  } catch (err) {
    console.error("[handleModMessageCommand] " + err.stack);
    await logErrorToChannel(
      msg.guild?.id,
      err.stack,
      msg.client,
      "handleModMessageCommand"
    );
    return msg.channel.send("> <❌> An internal error occurred.");
  }
}

/* ─────── SLASH COMMAND (/tc …) ─────── */
async function handleModSlashCommand(inter) {
  try {
    if (
      !inter.memberPermissions.has(PermissionsBitField.Flags.KickMembers)
    )
      return inter.reply({
        content: "> <❌> You do not have permission.",
        ephemeral: true,
      });

    const sub = inter.options.getSubcommand();
    const reason = inter.options.getString("reason") || "No reason";

    /* delete */
    if (sub === "delete") {
      const id = inter.options.getInteger("id");

      // Verify ownership then delete with guild guard
      const { data: found, error: fErr } = await supabase
        .from("mod_actions")
        .select("id,guildId")
        .eq("id", id)
        .eq("guildId", inter.guild.id)
        .single();

      if (fErr || !found) {
        return inter.reply({
          content: "> <❇️> No entry with that ID in **this server**.",
        });
      }

      const ok = await deleteModerationAction(id, inter.guild.id);
      return inter.reply({
        content: ok
          ? `> <🗑️> Deleted mod action **${id}**.`
          : `> <❇️> No entry with ID **${id}** found.`,
      });
    }

    /* (optional) view via slash if you register it */
    if (sub === "view") {
      const id = inter.options.getInteger("id");
      if (!id) {
        return inter.reply({ content: "> <❌> Provide an `id`.", ephemeral: true });
      }
      const { data, error } = await supabase
        .from("mod_actions")
        .select("*")
        .eq("id", id)
        .eq("guildId", inter.guild.id) // SCOPE TO GUILD
        .single();

      if (error || !data) {
        return inter.reply({ content: `> <❇️> No entry with that ID in **this server**.` });
      }

      // Resolve tags
      let userTag = null, modTag = null;
      try {
        const u = await inter.client.users.fetch(data.userId).catch(() => null);
        if (u) userTag = u.tag;
      } catch (_) {}
      try {
        const m = await inter.client.users.fetch(data.moderatorId).catch(() => null);
        if (m) modTag = m.tag;
      } catch (_) {}

      const content = buildSingleActionView(data, userTag, modTag);
      return inter.reply({ content });
    }

    /* history */
    if (sub === "history") {
      const tgt = inter.options.getUser("user");
      const { data, error } = await supabase
        .from("mod_actions")
        .select("*")
        .eq("guildId", inter.guild.id) // SCOPE TO GUILD
        .or(`userId.eq.${tgt.id},moderatorId.eq.${tgt.id}`)
        .order("timestamp", { ascending: false })
        .limit(HISTORY_FETCH_LIMIT);
      if (error)
        return inter.reply({
          content: "> <❌> Error fetching history.",
        });
      if (!data.length)
        return inter.reply({
          content: `> <❇️> No history for ${tgt.tag} in this server.`,
        });
      const reply = await inter.reply({ content: "Loading…", fetchReply: true });
      return sendPaginatedHistory(
        inter,
        reply.channel,
        tgt.tag,
        data,
        inter.user.id
      );
    }

    /* collect IDs */
    const ids = [];
    const raw = inter.options.getString("users") || "";
    const re = /<@!?(\d{17,19})>/g;
    let m;
    while ((m = re.exec(raw))) ids.push(m[1]);
    for (const part of raw.split(/[\s,]+/))
      /^\d{17,19}$/.test(part) && ids.push(part);
    const single = inter.options.getUser("user");
    if (!ids.length && single) ids.push(single.id);
    if (!ids.length)
      return inter.reply({
        content: "> <❌> No valid users provided.",
      });

    /* ───── duration parsing ───── */
    let durMs, durSec;
    if (sub === "mute") {
      const durStr = inter.options.getString("duration"); // may be null
      if (!durStr) {
        durMs = 3_600_000; // default 1h
      } else {
        durMs = ms(durStr);
        if (!durMs) {
          return inter.reply({
            content: "> <❌> Invalid duration. Examples: `30m`, `2h`, `1d`",
            ephemeral: true,
          });
        }
      }
      if (durMs > MAX_TIMEOUT_MS)
        return inter.reply({
          content: "> <❌> Duration too long (max 28 days).",
          ephemeral: true,
        });
      durSec = durMs / 1000;
    }

    const confirms = await Promise.all(
      ids.map(async (id) => {
        try {
          /* UNBAN */
          if (sub === "unban") {
            const bans = await inter.guild.bans.fetch();
            if (!bans.has(id)) return `> <❇️>  \`${id}\` is not currently banned.`;
            await inter.guild.members.unban(id, reason);
            const recId = await recordModerationAction({
              guildId: inter.guild.id,
              userId: id,
              moderatorId: inter.user.id,
              actionType: "unban",
              reason,
            });
            const usr = await inter.client.users.fetch(id).catch(() => null);
            if (usr)
              await safeDM(usr, [
                `> <🔓> You have been \`unbanned\` in **${inter.guild.name}**.`,
                `> Reason: ${wrap(reason)}`,
                `> Action ID: ${fmtId(recId)}`,
              ]);
            return [
              `> <${display.unban.emoji}> ${display.unban.label}: ${wrap(
                usr ? usr.tag : id
              )}`,
              `> Reason: ${wrap(reason)}`,
              `> Action ID: ${fmtId(recId)}`,
            ].join("\n");
          }

          const member = await inter.guild.members.fetch(id);
          if (cantModerate(inter.member, member))
            return `> <❌> Cannot act on ${wrap(member.user.tag)}`;

          /* UNMUTE */
          if (sub === "unmute") {
            await member.timeout(null, reason);
            await safeDM(member.user, [
              `> <🔓> You have been \`unmuted\` in **${inter.guild.name}**.`,
              `> Reason: ${wrap(reason)}`,
            ]);
            return [
              `> <${display.unmute.emoji}> ${display.unmute.label}: ${wrap(
                member.user.tag
              )}`,
              `> Reason: ${wrap(reason)}`,
            ].join("\n");
          }

          /* MUTE / WARN / KICK / BAN */
          const recId = await performAndLog({
            member,
            moderator: inter.member,
            guild: inter.guild,
            type: sub,
            reason,
            durationMs: durMs,
            durationSec: durSec,
          });
          return [
            `> <${display[sub].emoji}> ${display[sub].label}: ${wrap(
              member.user.tag
            )}`,
            `> Reason: ${wrap(reason)}`,
            `> Action ID: ${fmtId(recId)}`,
          ].join("\n");
        } catch {
          return `> <❌> Failed on \`${id}\``;
        }
      })
    );

    const result = confirms.join("\n\n") || {
      mute: "> <❌> Usage: `/tc mute user:<@user> duration:<e.g. 1h> reason:<text>`",
      warn: "> <❌> Usage: `/tc warn user:<@user> reason:<text>`",
      kick: "> <❌> Usage: `/tc kick user:<@user> reason:<text>`",
      ban: "> <❌> Usage: `/tc ban user:<@user> reason:<text>`",
      unban: "> <❌> Usage: `/tc unban user:<user ID> reason:<text>`",
      unmute: "> <❌> Usage: `/tc unmute user:<@user> reason:<text>`",
      view: "> <❌> Usage: `/tc view id:<number>`",
    }[sub] || "> <❌> Something went wrong.";

    return inter.reply({ content: result, ephemeral: false });
  } catch (err) {
    console.error("[handleModSlashCommand] " + err.stack);
    await logErrorToChannel(
      inter.guild?.id,
      err.stack,
      inter.client,
      "handleModSlashCommand"
    );
    if (!inter.replied)
      inter.reply({
        content: "> <❌> An internal error occurred.",
      });
  }
}

module.exports = {
  handleModMessageCommand,
  handleModSlashCommand,
};