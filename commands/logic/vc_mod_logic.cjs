const { PermissionsBitField, ChannelType } = require("discord.js");
const { logErrorToChannel } = require("./helpers.cjs");
const { getSettingsForGuild } = require("../settings.cjs");

const ansi = {
  darkGray: "\u001b[2;30m",
  white: "\u001b[2;37m",
  red: "\u001b[2;31m",
  yellow: "\u001b[2;33m",
  cyan: "\u001b[2;36m",
  reset: "\u001b[0m",
};

/**
 * Builds an ANSI-colored log message for VC moderation actions
 * @param {Object} params
 * @param {string} params.timestamp - HH:MM formatted string
 * @param {string} params.actor - User tag of the person taking action
 * @param {string} params.actorRole - Top role name (e.g. "Admin", "Moderator")
 * @param {string} params.roleColor - ANSI color code for the actor's role
 * @param {string} params.action - Action verb ("muted", "kicked", etc.)
 * @param {string} params.targetName - Display name of the target user
 * @param {string} params.targetId - User ID of the target
 * @param {string} params.channelName - Name of the voice channel
 */
function buildVCActionLog({
  timestamp,
  actor,
  actorRole,
  roleColor,
  action,
  targetName,
  targetId,
  channelName,
}) {
  return (
    "```ansi\n" +
    `${ansi.darkGray}[${ansi.white}${timestamp}${ansi.darkGray}] ` +
    `[${roleColor}${actorRole}${ansi.darkGray}] ` +
    `[${ansi.white}${targetId}${ansi.darkGray}] ` +
    `${roleColor}${actor}${ansi.darkGray} ${action} ` +
    `${roleColor}${targetName}${ansi.darkGray} from ` +
    `${ansi.white}${channelName}${ansi.darkGray}.${ansi.reset}\n` +
    "```"
  );
}

async function sendVCLog(guild, settings, issuer, member, actionVerb) {
  if (!settings.vcLoggingEnabled || !settings.vcLoggingChannelId) return;

  let ch = guild.channels.cache.get(settings.vcLoggingChannelId);
  if (!ch) {
    try {
      ch = await guild.channels.fetch(settings.vcLoggingChannelId);
    } catch {
      return;
    }
  }

  if (!ch.permissionsFor(guild.members.me)?.has("SendMessages")) return;

  const timestamp = new Date().toLocaleTimeString("en-US", {
    minute: "2-digit",
    second: "2-digit",
  });

  const actorRole = issuer.roles.highest?.name || "No Role";
  let roleColor = ansi.white;

  if (guild.ownerId === issuer.id) {
    roleColor = ansi.red;
  } else if (issuer.permissions.has("Administrator")) {
    roleColor = ansi.cyan;
  } else if (
    issuer.permissions.has("ManageGuild") ||
    issuer.permissions.has("KickMembers") ||
    issuer.permissions.has("MuteMembers") ||
    issuer.permissions.has("BanMembers") ||
    issuer.permissions.has("ManageMessages")
  ) {
    roleColor = ansi.yellow;
  }

  const logMsg = buildVCActionLog({
    timestamp,
    actor: issuer.user.tag,
    actorRole,
    roleColor,
    action: actionVerb,
    targetName: member.displayName,
    targetId: member.id,
    channelName: member.voice.channel?.name || "Unknown",
  });

  await ch.send(logMsg).catch(console.error);
}

async function handleVCSlashCommand(interaction) {
  try {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageMembers)) {
      return interaction.reply({ content: "> <❇️> Missing Manage Members perm.", ephemeral: true });
    }

    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild;
    const issuer = await guild.members.fetch(interaction.user.id);
    const settings = await getSettingsForGuild(guild.id);

    if (sub === "drain") {
      if (!issuer.voice.channel) {
        return interaction.reply({ content: "> <❇️> You must join a VC.", ephemeral: true });
      }
      issuer.voice.channel.members.forEach(m => m.voice.disconnect(`Drained by ${interaction.user.tag}`).catch(() => { }));
      return interaction.reply({ content: `> <🕳️> Drained ${issuer.voice.channel.name}.`, ephemeral: true });
    }

    // parse targets
    const usersInput = interaction.options.getString("users") || "";
    const ids = [];
    const mentionRx = /<@!?(\d{17,19})>/g;
    let m;
    while ((m = mentionRx.exec(usersInput))) ids.push(m[1]);
    usersInput.split(/[,\s]+/).forEach(part => {
      if (/^\d{17,19}$/.test(part) && !ids.includes(part)) ids.push(part);
    });
    const single = interaction.options.getUser("user");
    if (!ids.length && single) ids.push(single.id);
    if (!ids.length) {
      return interaction.reply({ content: "> <❌> No valid users.", ephemeral: true });
    }

    const results = [];
    for (const id of ids) {
      const member = await guild.members.fetch(id).catch(() => null);
      if (!member) { results.push(`❌ ${id}`); continue; }
      if (!member.voice.channel) { results.push(`⚠️ ${member.displayName}`); continue; }

      let verb;
      if (sub === "mute") {
        await member.voice.setMute(true, `Muted by ${interaction.user.tag}`);
        verb = "muted";
      } else if (sub === "unmute") {
        await member.voice.setMute(false, `Unmuted by ${interaction.user.tag}`);
        verb = "unmuted";
      } else if (sub === "kick") {
        await member.voice.disconnect(`Kicked by ${interaction.user.tag}`);
        verb = "kicked";
      } else {
        return interaction.reply({ content: "> <❇️> Unknown subcommand. Usage: `kick`, `mute`, `unmute`", ephemeral: true });
      }

      await sendVCLog(guild, settings, issuer, member, verb);
      results.push(member.displayName);
    }

    const label = sub.charAt(0).toUpperCase() + sub.slice(1) + "ed";
    const emoji = sub === "mute" ? "🔇" : sub === "unmute" ? "🔊" : "🕳️";
    return interaction.reply({ content: `> <${emoji}> ${label}: ${results.join(", ")}` });
  } catch (error) {
    console.error(error);
    await logErrorToChannel(interaction.guild.id, error.stack, interaction.client, "VC_ERR_001");
    if (!interaction.replied) {
      interaction.reply({ content: "> <❌> Internal VC error.", ephemeral: true });
    }
  }
}

async function handleVCMessageCommand(message, args = []) {
  try {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageMembers)) {
      return message.reply("> <❇️> No manage members perm.");
    }
    const sub = (args[0] || "").toLowerCase();
    const guild = message.guild;
    const issuer = await guild.members.fetch(message.author.id);
    const settings = await getSettingsForGuild(guild.id);

    if (sub === "drain") {
      const channel = issuer.voice.channel || message.mentions.channels.first();
      if (!channel || channel.type !== ChannelType.GuildVoice) {
        return message.reply("> <❌> You must mention or join a VC.");
      }
      channel.members.forEach(m => m.voice.disconnect(`Drained by ${message.author.tag}`).catch(() => { }));
      return message.reply(`> <🕳️> Drained ${channel.name}.`);
    }

    const ids = [];
    if (message.mentions.members.size) ids.push(...message.mentions.members.keys());
    else if (args[1]) ids.push(...args[1].split(/[,\s]+/).filter(id => /^\d{17,19}$/.test(id)));
    if (!ids.length) {
      return message.reply("> <❌> No valid users.");
    }

    const results = [];
    for (const id of ids) {
      const member = await guild.members.fetch(id).catch(() => null);
      if (!member) { results.push(`❌ ${id}`); continue; }
      if (!member.voice.channel) { results.push(`⚠️ ${member.displayName}`); continue; }

      let verb;
      if (sub === "mute") {
        await member.voice.setMute(true, `Muted by ${message.author.tag}`);
        verb = "muted";
      } else if (sub === "unmute") {
        await member.voice.setMute(false, `Unmuted by ${message.author.tag}`);
        verb = "unmuted";
      } else if (sub === "kick") {
        await member.voice.disconnect(`Kicked by ${message.author.tag}`);
        verb = "kicked";
      } else {
        return message.reply("> <❇️> Unknown subcommand. Usage: `kick`, `mute`, `unmute`");
      }

      await sendVCLog(guild, settings, issuer, member, verb);
      results.push(member.displayName);
    }

    const actionPast = { mute: "Muted", unmute: "Unmuted", kick: "Kicked" }[sub] || sub;
    const emoji = { mute: "🔇", unmute: "🔊", kick: "🕳️" }[sub] || "";
    return message.reply(`> <${emoji}> ${actionPast}: ${results.join(", ")}`);
  } catch (error) {
    console.error(error);
    await logErrorToChannel(message.guild.id, error.stack, message.client, "VC_ERR_001");
    return message.reply("> <❌> Internal VC error.");
  }
}

module.exports = { handleVCSlashCommand, handleVCMessageCommand };
