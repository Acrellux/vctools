const {
  PermissionsBitField,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const { logErrorToChannel } = require("./helpers.cjs");
const { getSettingsForGuild } = require("./settings.cjs");

const ansi = {
  darkGray: "\u001b[2;30m",
  white: "\u001b[2;37m",
  red: "\u001b[2;31m",
  yellow: "\u001b[2;33m",
  cyan: "\u001b[2;36m",
  reset: "\u001b[0m",
};

function buildVCActionLog({ timestamp, actor, actorRole, action, targetName, targetId, channelName }) {
  let roleColor = ansi.white;
  if (actorRole === "Owner") roleColor = ansi.red;
  else if (actorRole === "Admin") roleColor = ansi.cyan;
  else if (["Moderator", "Manager"].includes(actorRole)) roleColor = ansi.yellow;

  return `\`\`\`ansi\n${ansi.darkGray}[${ansi.white}${timestamp}${ansi.darkGray}] [` +
    `${roleColor}${actorRole}${ansi.darkGray}] [` +
    `${ansi.white}${targetId}${ansi.darkGray}] ${roleColor}${targetName}` +
    `${ansi.darkGray} ${action} from ${ansi.white}${channelName}` +
    `${ansi.darkGray} by ${ansi.white}${actor}${ansi.darkGray}.${ansi.reset}\n\`\`\``;
}

async function handleVCSlashCommand(interaction) {
  try {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageMembers)) {
      return interaction.reply({ content: "> <❌> You do not have permission to manage members.", ephemeral: true });
    }

    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild;
    const issuer = await guild.members.fetch(interaction.user.id);
    const settings = await getSettingsForGuild(guild.id);

    // ──────── Drain ─────────
    if (sub === "drain") {
      if (!issuer.voice.channel) {
        return interaction.reply({ content: "> <❌> You must be in a voice channel to drain it.", ephemeral: true });
      }
      for (const [, m] of issuer.voice.channel.members) {
        try { await m.voice.disconnect(`Drained by ${interaction.user.tag}`); }
        catch { }
      }
      return interaction.reply({ content: `> <🕳️> Drained all users from ${issuer.voice.channel.name}.`, ephemeral: true });
    }

    // ──────── Parse targets ─────────
    const usersInput = interaction.options.getString("users") || "";
    const ids = [];
    const mentionRx = /<@!?(\\d{17,19})>/g;
    let m;
    while ((m = mentionRx.exec(usersInput))) ids.push(m[1]);
    for (const part of usersInput.split(/[\s,]+/)) {
      if (/^\d{17,19}$/.test(part) && !ids.includes(part)) ids.push(part);
    }
    const single = interaction.options.getUser("user");
    if (!ids.length && single) ids.push(single.id);
    if (!ids.length) {
      return interaction.reply({ content: "> <❌> No valid users provided.", ephemeral: true });
    }

    const results = [];
    for (const id of ids) {
      const member = await guild.members.fetch(id).catch(() => null);
      if (!member) { results.push(`❌ ${id}`); continue; }
      if (!member.voice.channel) { results.push(`⚠️ ${member.displayName}`); continue; }

      try {
        let actionVerb;
        if (sub === "mute") {
          await member.voice.setMute(true, `Muted by ${interaction.user.tag}`);
          actionVerb = "muted";
        } else if (sub === "unmute") {
          await member.voice.setMute(false, `Unmuted by ${interaction.user.tag}`);
          actionVerb = "unmuted";
        } else if (sub === "kick") {
          await member.voice.disconnect(`Kicked by ${interaction.user.tag}`);
          actionVerb = "kicked";
        } else {
          return interaction.reply({ content: "> <❌> Unknown subcommand.", ephemeral: true });
        }

        // ——— Log it —
        if (settings.vcLoggingEnabled && settings.vcLoggingChannelId) {
          const ch = guild.channels.cache.get(settings.vcLoggingChannelId);
          if (ch) {
            const timestamp = new Date().toLocaleTimeString("en-US", { minute: "2-digit", second: "2-digit" });
            const actorRole = issuer.id === guild.ownerId
              ? "Owner"
              : issuer.permissions.has(PermissionsBitField.Flags.Administrator)
                ? "Admin"
                : issuer.permissions.has(PermissionsBitField.Flags.ManageGuild)
                  ? "Moderator"
                  : "Member";
            const logMsg = buildVCActionLog({
              timestamp,
              actor: interaction.user.tag,
              actorRole,
              action: actionVerb,
              targetName: member.displayName,
              targetId: member.id,
              channelName: member.voice.channel.name
            });
            await ch.send(logMsg).catch(console.error);
          }
        }

        results.push(member.displayName);
      } catch (err) {
        console.error(`[VC] ${sub} failed for ${id}: ${err.message}`);
        results.push(`❌ ${member.displayName}`);
      }
    }

    const emoji = sub === "unmute" ? "🔊" : sub === "mute" ? "🔇" : "🚫";
    return interaction.reply({ content: `> <${emoji}> ${sub.charAt(0).toUpperCase() + sub.slice(1)}d: ${results.join(", ")}`, ephemeral: true });
  } catch (error) {
    console.error(`[ERROR] handleVCSlashCommand: ${error.stack}`);
    await logErrorToChannel(interaction.guild.id, error.stack, interaction.client, "VC_ERR_001");
    return interaction.reply({ content: "> <❌> An error occurred while processing the VC command. (VC_ERR_001)", ephemeral: true });
  }
}

async function handleVCMessageCommand(message, args = []) {
  try {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageMembers)) {
      return message.reply("> <❌> You do not have permission to manage members.");
    }
    if (!args.length) {
      return message.reply("> <❌> Please provide a subcommand: `mute`, `unmute`, `kick`, or `drain`");
    }

    const sub = args[0].toLowerCase();
    const guild = message.guild;
    const issuer = await guild.members.fetch(message.author.id);
    const settings = await getSettingsForGuild(guild.id);

    // ──────── Drain ─────────
    if (sub === "drain") {
      const channel = issuer.voice.channel || message.mentions.channels.first();
      if (!channel || channel.type !== ChannelType.GuildVoice) {
        return message.reply("> <❌> You must be in or mention a valid voice channel to drain.");
      }
      for (const [, m] of channel.members) {
        try { await m.voice.disconnect(`Drained by ${message.author.tag}`); } catch { }
      }
      return message.reply(`> <🕳️> Drained all users from ${channel.name}.`);
    }

    // ──────── Targets ─────────
    const ids = [];
    if (message.mentions.members.size) ids.push(...message.mentions.members.keys());
    else if (args[1]) for (const id of args[1].split(/[\s,]+/)) if (/^\d{17,19}$/.test(id)) ids.push(id);
    if (!ids.length) {
      return message.reply(`> <❌> Please mention or list at least one user to ${sub}.`);
    }

    const results = [];
    for (const id of ids) {
      const member = await guild.members.fetch(id).catch(() => null);
      if (!member) { results.push(`❌ ${id}`); continue; }
      if (!member.voice.channel) { results.push(`⚠️ ${member.displayName}`); continue; }

      try {
        let actionVerb;
        if (sub === "mute") {
          await member.voice.setMute(true, `Muted by ${message.author.tag}`);
          actionVerb = "muted";
        } else if (sub === "unmute") {
          await member.voice.setMute(false, `Unmuted by ${message.author.tag}`);
          actionVerb = "unmuted";
        } else if (sub === "kick") {
          await member.voice.disconnect(`Kicked by ${message.author.tag}`);
          actionVerb = "kicked";
        } else {
          return message.reply("> <❌> Unknown subcommand.");
        }

        // ——— Log it —
        if (settings.vcLoggingEnabled && settings.vcLoggingChannelId) {
          const ch = guild.channels.cache.get(settings.vcLoggingChannelId);
          if (ch) {
            const timestamp = new Date().toLocaleTimeString("en-US", { minute: "2-digit", second: "2-digit" });
            const actorRole = issuer.id === guild.ownerId
              ? "Owner"
              : issuer.permissions.has(PermissionsBitField.Flags.Administrator)
                ? "Admin"
                : issuer.permissions.has(PermissionsBitField.Flags.ManageGuild)
                  ? "Moderator"
                  : "Member";
            const logMsg = buildVCActionLog({
              timestamp,
              actor: message.author.tag,
              actorRole,
              action: actionVerb,
              targetName: member.displayName,
              targetId: member.id,
              channelName: member.voice.channel.name
            });
            await ch.send(logMsg).catch(console.error);
          }
        }

        results.push(member.displayName);
      } catch {
        results.push(`❌ ${member.displayName}`);
      }
    }

    const actionPast = { mute: "Muted", unmute: "Unmuted", kick: "Kicked" }[sub] || sub;
    const emoji = { mute: "🔇", unmute: "🔊", kick: "🕳️" }[sub] || "";
    return message.reply(`> <${emoji}> ${actionPast}: ${results.join(", ")}`);
  } catch (error) {
    console.error(`[ERROR] handleVCMessageCommand: ${error.stack}`);
    await logErrorToChannel(message.guild.id, error.stack, message.client, "VC_ERR_001");
    return message.reply("> <❌> An error occurred while processing the VC command. (VC_ERR_001)");
  }
}

module.exports = {
  handleVCSlashCommand,
  handleVCMessageCommand,
};
