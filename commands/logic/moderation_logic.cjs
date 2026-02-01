// moderation_logic.cjs
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const ms = require("ms");
const crypto = require("crypto");
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
const MAX_REASON_WORDS = 500;

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

function canBan(mod, target, guild) {
  const bot = guild.members.me;

  if (!mod.permissions.has(PermissionsBitField.Flags.BanMembers)) {
    return { ok: false, msg: "> <❌> You need **Ban Members** permission." };
  }

  if (!bot.permissions.has(PermissionsBitField.Flags.BanMembers)) {
    return { ok: false, msg: "> <❌> I do not have **Ban Members** permission." };
  }

  if (target.id === guild.ownerId) {
    return { ok: false, msg: "> <❌> You cannot ban the server owner." };
  }

  if (mod.roles.highest.comparePositionTo(target.roles.highest) <= 0) {
    return { ok: false, msg: "> <❌> That user has equal or higher role than you." };
  }

  if (bot.roles.highest.comparePositionTo(target.roles.highest) <= 0) {
    return { ok: false, msg: "> <❌> That user has a higher role than me." };
  }

  return { ok: true };
}

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

/* ─────── PENDING CONFIRMATIONS (BAN BY ID) ─────── */
const EXTERNAL_BAN_CONFIRM_TTL_MS = 5 * 60 * 1000; // 5 minutes
const pendingExternalBans = new Map(); // token -> { guildId, moderatorId, targetIds, reason, createdAt }

function createPendingExternalBan({ guildId, moderatorId, targetIds, reason }) {
  const token = crypto.randomBytes(9).toString("base64url"); // short + URL-safe
  pendingExternalBans.set(token, {
    guildId,
    moderatorId,
    targetIds: Array.from(new Set(targetIds)),
    reason: reason || "No reason",
    createdAt: Date.now(),
  });
  return token;
}

function buildExternalBanConfirmRow(token) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`tcban:confirm:${token}`)
      .setLabel("Confirm Ban")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`tcban:cancel:${token}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary),
  );
}

async function sendExternalBanConfirmMessage({ channel, guild, moderatorId, targetIds, reason }) {
  const token = createPendingExternalBan({ guildId: guild.id, moderatorId, targetIds, reason });
  const row = buildExternalBanConfirmRow(token);

  const preview = targetIds.slice(0, 5).map((id) => `\`${id}\``).join(", ");
  const more = targetIds.length > 5 ? ` (+${targetIds.length - 5} more)` : "";

  const content = [
    `## <⚠️> Ban confirmation required.`,
    `> This user is not in the server. Please confirm to ban the following ID${targetIds.length === 1 ? "" : "s"}:`,
    `> Target ID${targetIds.length === 1 ? "" : "s"}: ${preview}${more}`,
    `> Reason: ${wrap(reason || "No reason")}`,
    `> Press **Confirm Ban** to proceed.`,
  ].join("\n");

  return channel.send({ content, components: [row] });
}

async function handleTcBanConfirmInteraction(interaction) {
  try {
    if (!interaction.inGuild?.() || !interaction.guild) {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "> <❇️> This can only be used in a server.", ephemeral: true }).catch(() => { });
      }
      return;
    }

    const parts = String(interaction.customId || "").split(":"); // tcban:<action>:<token>
    const action = parts[1];
    const token = parts[2];

    const pending = token ? pendingExternalBans.get(token) : null;
    if (!pending) {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "> <⌛> That confirmation expired. Please run the command again.", ephemeral: true }).catch(() => { });
      }
      return;
    }

    // Guild guard
    if (pending.guildId !== interaction.guild.id) {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "> <❇️> That confirmation is for a different server.", ephemeral: true }).catch(() => { });
      }
      return;
    }

    // Only the mod who requested it can press it
    if (pending.moderatorId !== interaction.user.id) {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "> <❇️> You cannot interact with this button.", ephemeral: true }).catch(() => { });
      }
      return;
    }

    // TTL
    if (Date.now() - pending.createdAt > EXTERNAL_BAN_CONFIRM_TTL_MS) {
      pendingExternalBans.delete(token);
      try {
        await interaction.update({ content: "> <⌛> That confirmation expired. Please run the command again.", components: [] });
      } catch {
        await interaction.reply({ content: "> <⌛> That confirmation expired. Please run the command again.", ephemeral: true }).catch(() => { });
      }
      return;
    }

    if (action === "cancel") {
      pendingExternalBans.delete(token);
      try {
        await interaction.update({ content: "> <❇️> Ban cancelled.", components: [] });
      } catch {
        await interaction.reply({ content: "> <❇️> Ban cancelled.", ephemeral: true }).catch(() => { });
      }
      return;
    }

    if (action !== "confirm") {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "> <❇️> Unknown action.", ephemeral: true }).catch(() => { });
      }
      return;
    }

    // Permission checks at time-of-click
    if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.BanMembers)) {
      await interaction.reply({ content: "> <❌> You need **Ban Members** permission.", ephemeral: true }).catch(() => { });
      return;
    }
    const bot = interaction.guild.members.me;
    if (!bot?.permissions?.has(PermissionsBitField.Flags.BanMembers)) {
      await interaction.reply({ content: "> <❌> I do not have **Ban Members** permission.", ephemeral: true }).catch(() => { });
      return;
    }

    // Acknowledge quickly + remove buttons
    await interaction.update({ content: "> <⏳> Processing ban…", components: [] }).catch(() => { });

    const results = [];
    for (const targetId of pending.targetIds) {
      try {
        await interaction.guild.members.ban(targetId, { reason: pending.reason });

        const recId = await recordModerationAction({
          guildId: interaction.guild.id,
          userId: targetId,
          moderatorId: interaction.user.id,
          actionType: "ban",
          reason: pending.reason,
        });

        const usr = await interaction.client.users.fetch(targetId).catch(() => null);
        if (usr) {
          await safeDM(usr, [
            `> <🔨> You have been \`banned\` in **${interaction.guild.name}**.`,
            `> Reason: ${wrap(pending.reason)}`,
            `> Action ID: ${fmtId(recId)}`,
          ]);
        }

        results.push(
          [
            `> <${display.ban.emoji}> ${display.ban.label}: ${wrap(usr ? usr.tag : targetId)}`,
            `> Reason: ${wrap(pending.reason)}`,
            `> Action ID: ${fmtId(recId)}`,
          ].join("\n")
        );
      } catch (e) {
        results.push(`> <❌> Failed to ban \`${targetId}\``);
      }
    }

    pendingExternalBans.delete(token);

    const finalContent = results.join("\n\n") || "> <❌> No bans were applied.";
    // Best-effort edit (update already removed buttons)
    try {
      await interaction.editReply({ content: finalContent, components: [] });
    } catch {
      await interaction.message?.edit?.({ content: finalContent, components: [] }).catch(() => { });
    }
  } catch (err) {
    console.error("[handleTcBanConfirmInteraction]", err);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "> <❌> An internal error occurred.", ephemeral: true });
      }
    } catch { }
  }
}

/* ─────── HISTORY RENDERING ─────── */
function buildHistoryPage(records, page, map) {
  const start = page * HISTORY_PAGE_SIZE;
  const slice = records.slice(start, start + HISTORY_PAGE_SIZE);

  const idW = Math.max(...records.map((r) => String(r.id).length), 2);
  const userW = 20, modW = 20, tsW = 19, typeW = 8, reasonW = 30;

  const header =
    `${"ID".padEnd(idW)} | ` +
    `User`.padEnd(userW) + ` | ` +
    `Moderator`.padEnd(modW) + ` | ` +
    `Timestamp`.padEnd(tsW) + ` | ` +
    `Type`.padEnd(typeW) + ` | ` +
    `Reason`.padEnd(reasonW);

  const rows =
    slice.map((r) => {
      const id = String(r.id).padEnd(idW);
      const user = (map.get(r.userId) || r.userId).padEnd(userW);
      const mod = (map.get(r.moderatorId) || r.moderatorId).padEnd(modW);
      const ts = new Date(r.timestamp).toISOString().replace("T", " ").slice(0, 19).padEnd(tsW);
      const typ = (r.actionType || "").padEnd(typeW);
      const rea = (r.reason || "").slice(0, reasonW).padEnd(reasonW);
      return `${id} | ${user} | ${mod} | ${ts} | ${typ} | ${rea}`;
    }).join("\n") || "No entries on this page.";

  return ["```", header, header.replace(/[^|]/g, "-"), rows, "```"].join("\n");
}

async function sendPaginatedHistory(ctx, chan, tag, recs, authId) {
  let page = 0;
  const last = Math.max(Math.ceil(recs.length / HISTORY_PAGE_SIZE) - 1, 0);

  // SAFE: only fetch tags for IDs that appear in records for THIS guild
  const map = new Map();
  await Promise.all(
    [...new Set(recs.flatMap((r) => [r.userId, r.moderatorId]))].map(async (id) => {
      if (!map.has(id)) {
        const u = await ctx.client.users.fetch(id).catch(() => null);
        map.set(id, u ? u.tag : id);
      }
    })
  );

  const controls = () =>
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`modhist:first:${authId}`).setLabel("⇤").setStyle(ButtonStyle.Primary).setDisabled(page === 0),
      new ButtonBuilder().setCustomId(`modhist:prev:${authId}`).setLabel("◄").setStyle(ButtonStyle.Primary).setDisabled(page === 0),
      new ButtonBuilder().setCustomId(`modhist:next:${authId}`).setLabel("►").setStyle(ButtonStyle.Primary).setDisabled(page === last),
      new ButtonBuilder().setCustomId(`modhist:last:${authId}`).setLabel("⇥").setStyle(ButtonStyle.Primary).setDisabled(page === last),
    );

  const makeContent = () =>
    `**History for ${tag} — Page ${page + 1}/${last + 1}**\n${buildHistoryPage(recs, page, map)}`;

  const msg = await chan.send({ content: makeContent(), components: [controls()] });
  const coll = msg.createMessageComponentCollector({
    filter: (i) => i.user.id === authId && i.customId.startsWith("modhist:"),
    time: 60_000,
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
  coll.on("end", () => msg.edit({ components: [] }).catch(() => { }));
}

/* ─────── SINGLE ACTION VIEW RENDER ─────── */
function buildSingleActionView(rec, userTag, modTag) {
  const idW = Math.max(String(rec.id).length, 2);
  const userW = 20, modW = 20, tsW = 19, typeW = 8;

  const header =
    `${"ID".padEnd(idW)} | ` +
    `User`.padEnd(userW) + ` | ` +
    `Moderator`.padEnd(modW) + ` | ` +
    `Timestamp`.padEnd(tsW) + ` | ` +
    `Type`.padEnd(typeW);

  const row = [
    String(rec.id).padEnd(idW),
    (userTag || rec.userId).padEnd(userW),
    (modTag || rec.moderatorId).padEnd(modW),
    new Date(rec.timestamp).toISOString().replace("T", " ").slice(0, 19).padEnd(tsW),
    (rec.actionType || "").padEnd(typeW),
  ].join(" | ");

  const reason = rec.reason || "";
  return [
    "```", header, header.replace(/[^|]/g, "-"), row,
    "✦",
    `Reason | ${reason}`,
    "```",
  ].join("\n");
}

/* ─────── SHARED ACTION EXECUTOR (ALL BUT UNMUTE) ─────── */
async function performAndLog({ member, moderator, guild, type, reason, durationMs, durationSec }) {
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
    const valid = ["mute", "unmute", "warn", "kick", "ban", "unban", "history", "delete", "view", "clean"];
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

      // Now safe to resolve tags for user & moderator (record exists in THIS guild)
      let userTag = null, modTag = null;
      try {
        const u = await msg.client.users.fetch(data.userId).catch(() => null);
        if (u) userTag = u.tag;
      } catch { }
      try {
        const m = await msg.client.users.fetch(data.moderatorId).catch(() => null);
        if (m) modTag = m.tag;
      } catch { }

      return msg.channel.send(buildSingleActionView(data, userTag, modTag));
    }

    /* ─── HISTORY: allow users not in guild, but restrict to THIS guild ─── */
    if (sub === "history") {
      const rawArg = args[1];
      if (!rawArg)
        return msg.channel.send("> <❌> Usage: `>tc history <@user | userID | name>`");

      // 1) Mention
      let targetId = msg.mentions.users.first()?.id || null;
      let displayTag = msg.mentions.users.first()?.tag || null;

      // 2) Raw ID or <@id>
      if (!targetId) {
        const m = rawArg.match(/^<@!?(\d{17,19})>$|^(\d{17,19})$/);
        if (m) targetId = m[1] || m[2];
      }

      // 3) Name (if still in guild) → only to discover ID
      if (!targetId) {
        const name = rawArg.toLowerCase();
        const memberByName = msg.guild.members.cache.find(
          (m) =>
            m.user.username.toLowerCase() === name ||
            m.displayName.toLowerCase() === name
        );
        if (memberByName) {
          targetId = memberByName.id;
          displayTag = memberByName.user.tag;
        }
      }

      if (!targetId)
        return msg.channel.send(`> <❌> Could not find user: ${rawArg}`);

      // IMPORTANT: query THIS guild first (no global fetch yet)
      const { data, error } = await supabase
        .from("mod_actions")
        .select("*")
        .eq("guildId", msg.guild.id) // ONLY THIS SERVER
        .or(`userId.eq.${targetId},moderatorId.eq.${targetId}`)
        .order("timestamp", { ascending: false })
        .limit(HISTORY_FETCH_LIMIT);

      if (error) return msg.channel.send("> <❌> Error fetching history.");
      if (!data.length) {
        // No history in this server: do not resolve a tag globally
        return msg.channel.send(`> <❇️> No history for \`${targetId}\` in this server.`);
      }

      // Safe to resolve a global tag *because* we confirmed records in THIS guild
      if (!displayTag) {
        const u = await msg.client.users.fetch(targetId).catch(() => null);
        if (u) displayTag = u.tag;
      }

      return sendPaginatedHistory(
        msg,
        msg.channel,
        displayTag || targetId,
        data,
        msg.author.id
      );
    }

    /* ───────────────── CLEAN ───────────────── */
    if (sub === "clean") {
      if (!msg.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
        return msg.channel.send("> <❌> You need **Manage Messages** permission.");
      }

      // ─── Usage guard ───
      if (args.length < 4) {
        return msg.channel.send(
          "> <❌> Usage:\n" +
          "> `>tc clean <@user | id | name> count <number>`\n" +
          "> `>tc clean <@user | id | name> time <1h|3d|1w>`"
        );
      }

      // ─── Resolve target ───
      let target = msg.mentions.members.first();

      if (!target) {
        const raw = args[1];

        if (/^\d{17,19}$/.test(raw)) {
          target = await msg.guild.members.fetch(raw).catch(() => null);
        }

        if (!target) {
          const mentionMatch = raw.match(/^<@!?(\d{17,19})>$/);
          if (mentionMatch) {
            target = await msg.guild.members.fetch(mentionMatch[1]).catch(() => null);
          }
        }

        if (!target) {
          const name = raw.toLowerCase();
          target = msg.guild.members.cache.find(
            m =>
              m.user.username.toLowerCase() === name ||
              m.displayName.toLowerCase() === name
          );
        }
      }

      if (!target) {
        return msg.channel.send("> <❌> Could not find that user.");
      }

      if (cantModerate(msg.member, target)) {
        return msg.channel.send(`> <❌> You cannot act on ${wrap(target.user.tag)}.`);
      }

      // ─── Parse mode ───
      const mode = args[2].toLowerCase();
      const value = args[3];

      if (!["count", "time"].includes(mode)) {
        return msg.channel.send(
          "> <❌> Invalid mode.\n" +
          "> Use `count` or `time`.\n" +
          "> Example: `>tc clean @user time 2h`"
        );
      }

      const MAX_DELETE = 100;
      let deletedCount = 0;
      let durationMs = null;

      // ─── Prepare channel list ───
      const channels = [
        ...msg.guild.channels.cache.filter(c =>
          c.isTextBased() &&
          !c.isThread() &&
          c.viewable &&
          c.permissionsFor(msg.guild.members.me)?.has([
            PermissionsBitField.Flags.ManageMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
          ])
        ).values()
      ];

      const totalChannels = channels.length;
      let processedChannels = 0;

      // ─── Status message ───
      const statusMsg = await msg.channel.send(
        "> <🧹> Cleaning messages…\n-# Scanning channels."
      );

      // ─── COUNT MODE ───
      if (mode === "count") {
        const limit = Number(value);

        if (!Number.isInteger(limit) || limit <= 0) {
          await statusMsg.edit("> <❌> Count must be a positive number.");
          return;
        }

        const cap = Math.min(limit, MAX_DELETE);

        for (const channel of channels) {
          if (deletedCount >= cap) break;

          processedChannels++;
          let lastId = null;

          while (deletedCount < cap) {
            const fetched = await channel.messages.fetch({
              limit: 100,
              before: lastId ?? undefined,
            });

            if (!fetched.size) break;

            const deletable = fetched
              .filter(m =>
                m.author.id === target.id &&
                !m.pinned &&
                Date.now() - m.createdTimestamp < 14 * 24 * 60 * 60 * 1000
              )
              .toJSON()
              .slice(0, cap - deletedCount);

            if (deletable.length) {
              await channel.bulkDelete(deletable);
              deletedCount += deletable.length;
            }

            lastId = fetched.last()?.id;
            if (!lastId) break;
          }

          if (processedChannels === 1 || processedChannels % 5 === 0) {
            await statusMsg.edit(
              `> <🧹> Cleaning messages…\n-# Scanned **${processedChannels}/${totalChannels}** channels`
            );
          }
        }
      }

      // ─── TIME MODE ───
      if (mode === "time") {
        durationMs = ms(value);

        if (!durationMs) {
          await statusMsg.edit("> <❌> Invalid time format. Example: `2h`, `3d`.");
          return;
        }

        durationMs = Math.min(durationMs, 14 * 24 * 60 * 60 * 1000);
        const cutoff = Date.now() - durationMs;

        for (const channel of channels) {
          if (deletedCount >= MAX_DELETE) break;

          processedChannels++;
          let lastId = null;

          while (deletedCount < MAX_DELETE) {
            const fetched = await channel.messages.fetch({
              limit: 100,
              before: lastId ?? undefined,
            });

            if (!fetched.size) break;

            const deletable = fetched
              .filter(m =>
                m.author.id === target.id &&
                !m.pinned &&
                m.createdTimestamp >= cutoff &&
                Date.now() - m.createdTimestamp < 14 * 24 * 60 * 60 * 1000
              )
              .toJSON()
              .slice(0, MAX_DELETE - deletedCount);

            if (deletable.length) {
              await channel.bulkDelete(deletable);
              deletedCount += deletable.length;
            }

            const oldest = fetched.last();
            if (!oldest || oldest.createdTimestamp < cutoff) break;

            lastId = oldest.id;
          }

          if (processedChannels === 1 || processedChannels % 5 === 0) {
            await statusMsg.edit(
              `> <🧹> Cleaning messages…\n-# Scanned **${processedChannels}/${totalChannels}** channels`
            );
          }
        }
      }

      if (!deletedCount) {
        await statusMsg.edit(
          "> <⚠️> No messages could be deleted.\n" +
          "-# Messages may be older than 14 days."
        );
        return;
      }

      const id = await recordModerationAction({
        guildId: msg.guild.id,
        userId: target.id,
        moderatorId: msg.member.id,
        actionType: "clean",
        reason:
          mode === "count"
            ? `Deleted ${deletedCount} messages`
            : `Deleted messages from last ${ms(durationMs, { long: true })}`,
      });

      await statusMsg.edit(
        [
          `> <✅> Deleted **${deletedCount}** messages from ${wrap(target.user.tag)}.`,
          `> Mode: ${mode}`,
          `> Action ID: ${fmtId(id)}`,
        ].join("\n")
      );

      return;
    }

    /* ─── resolve targets ─── */
    let targets = msg.mentions.members;

    // Try to resolve user by ID, mention, or name
    const rawArg2 = args[1];
    if ((!targets || !targets.size) && sub !== "unban" && rawArg2) {
      let member = null;

      // Case 1: pure numeric ID
      if (/^\d{17,19}$/.test(rawArg2)) {
        member = await msg.guild.members.fetch(rawArg2).catch(() => null);
      }

      // Case 2: <@id> mention (not detected by mentions.members due to message parsing quirks)
      if (!member) {
        const mentionMatch = rawArg2.match(/^<@!?(\d{17,19})>$/);
        if (mentionMatch) {
          member = await msg.guild.members.fetch(mentionMatch[1]).catch(() => null);
        }
      }

      // Case 3: by username or display name (fallback)
      if (!member) {
        const name = rawArg2.toLowerCase();
        member = msg.guild.members.cache.find(
          (m) =>
            m.user.username.toLowerCase() === name ||
            m.displayName.toLowerCase() === name
        );
      }

      if (member) {
        targets = new Map([[member.id, member]]);
      } else {
        // BAN by ID support (even if the user cannot be resolved as a current member)
        if (sub === "ban") {
          const raw = String(rawArg2 || "").trim();
          const mm = raw.match(/^<@!?(\d{17,19})>$/) || raw.match(/^(\d{17,19})$/);
          const targetId = mm ? (mm[1] || mm[2]) : null;

          if (targetId && /^\d{17,19}$/.test(targetId)) {
            const reasonForConfirm = args.slice(2).join(" ") || "No reason";
            await sendExternalBanConfirmMessage({
              channel: msg.channel,
              guild: msg.guild,
              moderatorId: msg.author.id,
              targetIds: [targetId],
              reason: reasonForConfirm,
            });
            return;
          }
        }

        return msg.channel.send(`> <❌> Could not find user: ${rawArg2}`);
      }
    }

    // Unban uses raw ID (no member object)
    if (sub === "unban") {
      const raw = args[1];
      if (!raw || !/^\d{17,19}$/.test(raw))
        return msg.channel.send("> <❌> Usage: `>tc unban <id>`");
      targets = new Map([[raw, { id: raw }]]);
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
      if (sub === "ban") {
        const check = canBan(msg.member, member, msg.guild);
        if (!check.ok) {
          confirms.push(check.msg);
          continue;
        }
      } else if (cantModerate(msg.member, member)) {
        confirms.push(`> <❌> You cannot act on ${wrap(member.user.tag)}.`);
        continue;
      }

      try {
        /* ─── UNMUTE (no DB) ───── */
        if (sub === "unmute") {
          await member.timeout(null, reason);
          await safeDM(member.user, [
            `> <🔓> You have been \`unmuted\` in **${msg.guild.name}**.`,
            `> Reason: ${wrap(reason)}`,
          ]);
          confirms.push(
            [
              `> <${display.unmute.emoji}> ${display.unmute.label}: ${wrap(member.user.tag)}`,
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
          durSec = Math.floor(durMs / 1000);
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
            `> <${display[sub].emoji}> ${display[sub].label}: ${wrap(member.user.tag)}`,
            `> Reason: ${wrap(reason)}`,
            `> Action ID: ${fmtId(id)}`,
          ].join("\n")
        );
      } catch (err) {
        console.error("[TC BAN ERROR]", err);
        confirms.push(`> <❌> Failed to ban ${wrap(member.user.tag)}.`);
      }
    }

    const result =
      confirms.join("\n\n") ||
      {
        mute: "> <❌> Usage: `>tc mute <user> [duration] [reason]`",
        warn: "> <❌> Usage: `>tc warn <user> [reason]`",
        kick: "> <❌> Usage: `>tc kick <user> [reason]`",
        ban: "> <❌> Usage: `>tc ban <user> [reason]`",
        unban: "> <❌> Usage: `>tc unban <user ID> [reason]`",
        unmute: "> <❌> Usage: `>tc unmute <user> [reason]`",
        view: "> <❌> Usage: `>tc view <id>`",
        clean:
          "> <❌> Usage:\n" +
          "> `>tc clean <@user> count <number>`\n" +
          "> `>tc clean <@user> time <1h|3d|1w>`",
      }[sub] ||
      "> <❌> Something went wrong.";

    return msg.channel.send(result);
  } catch (err) {
    console.error("[handleModMessageCommand] " + err.stack);
    await logErrorToChannel(msg.guild?.id, err.stack, msg.client, "handleModMessageCommand");
    return msg.channel.send("> <❌> An internal error occurred.");
  }
}

/* ─────── SLASH COMMAND (/tc …) ─────── */
async function handleModSlashCommand(inter) {
  try {
    const sub = inter.options.getSubcommand();
    const reason = inter.options.getString("reason") || "No reason";

    if (
      sub === "ban" &&
      !inter.memberPermissions.has(PermissionsBitField.Flags.BanMembers)
    ) {
      return inter.reply({
        content: "> <❌> You need **Ban Members** permission.",
        ephemeral: true,
      });
    }

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
        return inter.reply({ content: "> <❇️> No entry with that ID in **this server**." });
      }

      const ok = await deleteModerationAction(id, inter.guild.id);
      return inter.reply({
        content: ok
          ? `> <🗑️> Deleted mod action **${id}**.`
          : `> <❇️> No entry with ID **${id}** found.`,
      });
    }

    /* (optional) view via slash if you register it) */
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

      // Safe to resolve tags (record exists in THIS guild)
      let userTag = null, modTag = null;
      try {
        const u = await inter.client.users.fetch(data.userId).catch(() => null);
        if (u) userTag = u.tag;
      } catch { }
      try {
        const m = await inter.client.users.fetch(data.moderatorId).catch(() => null);
        if (m) modTag = m.tag;
      } catch { }

      return inter.reply({ content: buildSingleActionView(data, userTag, modTag) });
    }

    /* ─── HISTORY: allow users not in guild, but restrict to THIS guild ─── */
    if (sub === "history") {
      const tgt = inter.options.getUser("user");
      const idOpt = inter.options.getString("user_id"); // optional string (raw ID)

      let targetId = tgt?.id || null;
      let displayTag = null; // don't set from tgt.tag yet; we’ll only set tag AFTER confirming records in this guild

      if (!targetId && idOpt && /^\d{17,19}$/.test(idOpt)) targetId = idOpt;
      if (!targetId)
        return inter.reply({ content: "> <❌> Provide a `user` or `user_id`.", ephemeral: true });

      // Query THIS guild first; do not resolve a global tag yet
      const { data, error } = await supabase
        .from("mod_actions")
        .select("*")
        .eq("guildId", inter.guild.id)
        .or(`userId.eq.${targetId},moderatorId.eq.${targetId}`)
        .order("timestamp", { ascending: false })
        .limit(HISTORY_FETCH_LIMIT);

      if (error)
        return inter.reply({ content: "> <❌> Error fetching history." });

      if (!data.length) {
        // No history here: do not leak/display a global username
        return inter.reply({ content: `> <❇️> No history for \`${targetId}\` in this server.` });
      }

      // Safe to resolve a tag now (we have records in THIS guild)
      if (!displayTag) {
        const u = await inter.client.users.fetch(targetId).catch(() => null);
        if (u) displayTag = u.tag;
      }

      const reply = await inter.reply({ content: "Loading…", fetchReply: true });
      return sendPaginatedHistory(inter, reply.channel, displayTag || targetId, data, inter.user.id);
    }

    /* collect IDs */
    const ids = [];
    const raw = inter.options.getString("users") || "";
    const re = /<@!?(\d{17,19})>/g;
    let m;
    while ((m = re.exec(raw))) ids.push(m[1]);
    for (const part of raw.split(/[\s,]+/)) if (/^\d{17,19}$/.test(part)) ids.push(part);
    const single = inter.options.getUser("user");
    if (!ids.length && single) ids.push(single.id);
    if (!ids.length) return inter.reply({ content: "> <❌> No valid users provided." });

    /* ───── duration parsing ───── */
    let durMs, durSec;
    if (sub === "mute") {
      const durStr = inter.options.getString("duration"); // may be null
      durMs = durStr ? ms(durStr) : 3_600_000;
      if (!durMs)
        return inter.reply({ content: "> <❌> Invalid duration. Examples: `30m`, `2h`, `1d`", ephemeral: true });
      if (durMs > MAX_TIMEOUT_MS)
        return inter.reply({ content: "> <❌> Duration too long (max 28 days).", ephemeral: true });
      durSec = Math.floor(durMs / 1000);
    }


    // ─────────────────────────────
    // BAN BY ID (supports users not currently in the server via confirmation)
    // ─────────────────────────────
    if (sub === "ban") {
      const inGuild = [];
      const external = [];

      for (const id of ids) {
        const member = await inter.guild.members.fetch(id).catch(() => null);
        if (member) inGuild.push(member);
        else external.push(id);
      }

      const lines = [];

      // Ban members we can resolve normally
      for (const member of inGuild) {
        const check = canBan(inter.member, member, inter.guild);
        if (!check.ok) {
          lines.push(check.msg);
          continue;
        }

        try {
          const recId = await performAndLog({
            member,
            moderator: inter.member,
            guild: inter.guild,
            type: "ban",
            reason,
          });

          lines.push(
            [
              `> <${display.ban.emoji}> ${display.ban.label}: ${wrap(member.user.tag)}`,
              `> Reason: ${wrap(reason)}`,
              `> Action ID: ${fmtId(recId)}`,
            ].join("\n")
          );
        } catch {
          lines.push(`> <❌> Failed to ban ${wrap(member.user.tag)}.`);
        }
      }

      // If any IDs couldn't be resolved as members, require explicit confirmation
      if (external.length) {
        // Ensure bot still has Ban Members permission
        const bot = inter.guild.members.me;
        if (!bot?.permissions?.has(PermissionsBitField.Flags.BanMembers)) {
          lines.push("> <❌> I do not have **Ban Members** permission.");
          return inter.reply({ content: lines.join("\n\n") || "> <❌> Cannot proceed.", ephemeral: true });
        }

        const token = createPendingExternalBan({
          guildId: inter.guild.id,
          moderatorId: inter.user.id,
          targetIds: external,
          reason,
        });

        const row = buildExternalBanConfirmRow(token);

        const preview = external.slice(0, 5).map((x) => `\`${x}\``).join(", ");
        const more = external.length > 5 ? ` (+${external.length - 5} more)` : "";

        lines.push(
          [
            `> <⚠️> Ban confirmation required for ${external.length} ID${external.length === 1 ? "" : "s"}: ${preview}${more}`,
            `> Reason: ${wrap(reason)}`,
            `> Press **Confirm Ban** to proceed.`,
          ].join("\n")
        );

        return inter.reply({
          content: lines.join("\n\n") || "> <⚠️> Ban confirmation required.",
          components: [row],
          ephemeral: false,
        });
      }

      return inter.reply({
        content: lines.join("\n\n") || "> <❇️> No valid users provided.",
        ephemeral: false,
      });
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
            if (usr) await safeDM(usr, [
              `> <🔓> You have been \`unbanned\` in **${inter.guild.name}**.`,
              `> Reason: ${wrap(reason)}`,
              `> Action ID: ${fmtId(recId)}`,
            ]);
            return [
              `> <${display.unban.emoji}> ${display.unban.label}: ${wrap(usr ? usr.tag : id)}`,
              `> Reason: ${wrap(reason)}`,
              `> Action ID: ${fmtId(recId)}`,
            ].join("\n");
          }

          const member = await inter.guild.members.fetch(id);
          if (sub === "ban") {
            const check = canBan(inter.member, member, inter.guild);
            if (!check.ok) return check.msg;
          } else if (cantModerate(inter.member, member)) {
            return `> <❌> Cannot act on ${wrap(member.user.tag)}`;
          }

          /* UNMUTE */
          if (sub === "unmute") {
            await member.timeout(null, reason);
            await safeDM(member.user, [
              `> <🔓> You have been \`unmuted\` in **${inter.guild.name}**.`,
              `> Reason: ${wrap(reason)}`,
            ]);
            return [
              `> <${display.unmute.emoji}> ${display.unmute.label}: ${wrap(member.user.tag)}`,
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
            `> <${display[sub].emoji}> ${display[sub].label}: ${wrap(member.user.tag)}`,
            `> Reason: ${wrap(reason)}`,
            `> Action ID: ${fmtId(recId)}`,
          ].join("\n");
        } catch (err) {
          console.error("[TC SLASH BAN ERROR]", err);
          return `> <❌> Failed to ban \`${id}\``;
        }
      })
    );

    /* ─── CLEAN (COUNT or TIME) ─── */
    if (sub === "clean") {
      // ─── Permission check ───
      if (!inter.memberPermissions.has(PermissionsBitField.Flags.ManageMessages)) {
        return inter.reply({
          content: "> <❌> You need **Manage Messages** permission.",
          ephemeral: true,
        });
      }

      const target = inter.options.getUser("user");
      const mode = inter.options.getString("mode");
      const value = inter.options.getString("value");

      if (!target || !mode || !value) {
        return inter.reply({
          content:
            "> <❌> Usage:\n" +
            "> `/tc clean user:<user> mode:count value:<number>`\n" +
            "> `/tc clean user:<user> mode:time value:<1h|3d|1w>`",
          ephemeral: true,
        });
      }

      const member = await inter.guild.members.fetch(target.id).catch(() => null);
      if (member && cantModerate(inter.member, member)) {
        return inter.reply({
          content: `> <❌> You cannot act on ${wrap(target.tag)}.`,
          ephemeral: true,
        });
      }

      const MAX_DELETE = 100;
      const SAFE_DELETE_AGE_MS = 2 * 60 * 1000; // avoid Discord's "too-recent" delete flakiness
      const MAX_BULK_AGE_MS = 14 * 24 * 60 * 60 * 1000;

      async function safeDelete(channel, msgs) {
        if (!msgs.length) return 0;
        const ids = msgs.map((m) => m.id);
        try {
          const deleted = await channel.bulkDelete(ids, true);
          return deleted?.size ?? 0;
        } catch {
          let n = 0;
          for (const m of msgs) {
            try { await m.delete(); n++; } catch { }
          }
          return n;
        }
      }
      let deletedCount = 0;

      // ─── Gather channels ───
      const channels = [
        ...inter.guild.channels.cache
          .filter(
            (c) =>
              c.isTextBased() &&
              !c.isThread() &&
              c.viewable &&
              c.permissionsFor(inter.guild.members.me)?.has([
                PermissionsBitField.Flags.ManageMessages,
                PermissionsBitField.Flags.ReadMessageHistory,
              ])
          )
          .values(),
      ];

      const totalChannels = channels.length;
      let processedChannels = 0;

      // ─── Initial reply ───
      await inter.reply({
        content: "> <🧹> Cleaning messages…\n-# Scanning channels.",
      });

      const statusMsg = await inter.fetchReply();

      /* ─── COUNT MODE ─── */
      if (mode === "count") {
        const limit = Number(value);
        if (!Number.isInteger(limit) || limit <= 0) {
          return inter.editReply("> <❌> Count must be a positive number.");
        }

        const cap = Math.min(limit, MAX_DELETE);

        for (const channel of channels) {
          if (deletedCount >= cap) break;
          processedChannels++;

          let lastId = null;

          while (deletedCount < cap) {
            const fetched = await channel.messages.fetch({
              limit: 100,
              before: lastId ?? undefined,
            });

            if (!fetched.size) break;

            const deletable = fetched
              .filter(
                (m) =>
                  m.author.id === target.id &&
                  !m.pinned &&
                  (Date.now() - m.createdTimestamp) > SAFE_DELETE_AGE_MS && (Date.now() - m.createdTimestamp) < MAX_BULK_AGE_MS
              )
              .toJSON()
              .slice(0, cap - deletedCount);

            if (deletable.length) {
              deletedCount += await safeDelete(channel, deletable);
            }

            lastId = fetched.last()?.id;
            if (!lastId) break;
          }

          if (processedChannels === 1 || processedChannels % 5 === 0) {
            await statusMsg.edit(
              `> <🧹> Cleaning messages…\n-# Scanned **${processedChannels}/${totalChannels}** channels`
            );
          }
        }
      }

      /* ─── TIME MODE ─── */
      if (mode === "time") {
        let durationMs = ms(value);
        if (!durationMs) {
          return inter.editReply("> <❌> Invalid time format. Example: `2h`, `3d`.");
        }

        durationMs = Math.min(durationMs, 14 * 24 * 60 * 60 * 1000);
        const cutoff = Math.min(Date.now() - SAFE_DELETE_AGE_MS, Date.now() - durationMs);

        for (const channel of channels) {
          if (deletedCount >= MAX_DELETE) break;
          processedChannels++;

          let lastId = null;

          while (deletedCount < MAX_DELETE) {
            const fetched = await channel.messages.fetch({
              limit: 100,
              before: lastId ?? undefined,
            });

            if (!fetched.size) break;

            const deletable = fetched
              .filter(
                (m) =>
                  m.author.id === target.id &&
                  !m.pinned &&
                  m.createdTimestamp >= cutoff &&
                  (Date.now() - m.createdTimestamp) > SAFE_DELETE_AGE_MS && (Date.now() - m.createdTimestamp) < MAX_BULK_AGE_MS
              )
              .toJSON()
              .slice(0, MAX_DELETE - deletedCount);

            if (deletable.length) {
              deletedCount += await safeDelete(channel, deletable);
            }

            const oldest = fetched.last();
            if (!oldest || oldest.createdTimestamp < cutoff) break;
            lastId = oldest.id;
          }

          if (processedChannels === 1 || processedChannels % 5 === 0) {
            await statusMsg.edit(
              `> <🧹> Cleaning messages…\n-# Scanned **${processedChannels}/${totalChannels}** channels`
            );
          }
        }
      }

      return statusMsg.edit(
        `> <🧹> Cleanup complete.\n-# Deleted **${deletedCount}** message${deletedCount === 1 ? "" : "s"} from **${target.tag}**.`
      );
    }

    const result =
      confirms.join("\n\n") ||
      {
        mute: "> <❌> Usage: `/tc mute user:<@user> duration:<e.g. 1h> reason:<text>`",
        warn: "> <❌> Usage: `/tc warn user:<@user> reason:<text>`",
        kick: "> <❌> Usage: `/tc kick user:<@user> reason:<text>`",
        ban: "> <❌> Usage: `/tc ban user:<@user> reason:<text>`",
        unban: "> <❌> Usage: `/tc unban user:<user ID> reason:<text>`",
        unmute: "> <❌> Usage: `/tc unmute user:<@user> reason:<text>`",
        view: "> <❌> Usage: `/tc view id:<number>`",
        clean:
          "> <❌> Usage:\n" +
          "> `/tc clean user:<@user> mode:count value:<number>`\n" +
          "> `/tc clean user:<@user> mode:time value:<1h|3d|1w>`",
      }[sub] ||
      "> <❌> Something went wrong.";

    return inter.reply({ content: result, ephemeral: false });
  } catch (err) {
    console.error("[handleModSlashCommand] " + err.stack);
    await logErrorToChannel(inter.guild?.id, err.stack, inter.client, "handleModSlashCommand");
    if (!inter.replied)
      inter.reply({ content: "> <❌> An internal error occurred." });
  }
}

module.exports = {
  handleModMessageCommand,
  handleModSlashCommand,
  handleTcBanConfirmInteraction,
};