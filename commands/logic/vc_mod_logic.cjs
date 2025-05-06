const {
  PermissionsBitField,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const { logErrorToChannel } = require("./helpers.cjs");

/**
 * Handles slash commands for VC moderation.
 * Requires Manage Members permission.
 */
async function handleVCSlashCommand(interaction) {
  try {
    // Permission check
    if (
      !interaction.member.permissions.has(
        PermissionsBitField.Flags.ManageMembers
      )
    ) {
      return interaction.reply({
        content: "> <❌> You do not have permission to manage members.",
        ephemeral: true,
      });
    }

    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild;
    const issuer = await guild.members.fetch(interaction.user.id);

    // ──────── Drain ─────────
    if (sub === "drain") {
      if (!issuer.voice.channel) {
        return interaction.reply({
          content: "> <❌> You must be in a voice channel to drain it.",
          ephemeral: true,
        });
      }
      const channel = issuer.voice.channel;
      for (const [, member] of channel.members) {
        try {
          await member.voice.disconnect(`Drained by ${interaction.user.tag}`);
        } catch (err) {
          console.error(`Failed to drain ${member.user.tag}: ${err.message}`);
        }
      }
      return interaction.reply({
        content: `> <💥> Drained all users from ${channel.name}.`,
        ephemeral: true,
      });
    }

    // ──────── Parse targets ─────────
    const usersInput = interaction.options.getString("users") || "";
    const ids = [];

    // mentions
    const mentionRx = /<@!?(\\d{17,19})>/g;
    let m;
    while ((m = mentionRx.exec(usersInput))) ids.push(m[1]);

    // plain IDs
    for (const part of usersInput.split(/[\s,]+/)) {
      if (/^\\d{17,19}$/.test(part) && !ids.includes(part)) {
        ids.push(part);
      }
    }

    // fallback single-user option
    const single = interaction.options.getUser("user");
    if (!ids.length && single) ids.push(single.id);

    if (!ids.length) {
      return interaction.reply({
        content: "> <❌> No valid users provided.",
        ephemeral: true,
      });
    }

    // ──────── Apply action ─────────
    const results = [];
    for (const id of ids) {
      const member = await guild.members
        .fetch(id)
        .catch(() => null);
      if (!member) {
        results.push(`❌ ${id}`);
        continue;
      }
      if (!member.voice.channel) {
        results.push(`⚠️ ${member.displayName}`);
        continue;
      }

      try {
        if (sub === "mute") {
          await member.voice.setMute(true, `Muted by ${interaction.user.tag}`);
          results.push(member.displayName);
        } else if (sub === "unmute") {
          await member.voice.setMute(false, `Unmuted by ${interaction.user.tag}`);
          results.push(member.displayName);
        } else if (sub === "kick") {
          await member.voice.disconnect(`Kicked by ${interaction.user.tag}`);
          results.push(member.displayName);
        } else {
          return interaction.reply({
            content: "> <❌> Unknown subcommand.",
            ephemeral: true,
          });
        }
      } catch (err) {
        console.error(`[VC] ${sub} failed for ${id}: ${err.message}`);
        results.push(`❌ ${member.displayName}`);
      }
    }

    // ──────── Reply ─────────
    const emoji =
      sub === "unmute" ? "🔊" : sub === "mute" ? "🔇" : "🚫";
    return interaction.reply({
      content: `> <${emoji}> ${sub.charAt(0).toUpperCase() + sub.slice(1)}d: ${results.join(
        ", "
      )}`,
      ephemeral: true,
    });
  } catch (error) {
    console.error(`[ERROR] handleVCSlashCommand: ${error.stack}`);
    await logErrorToChannel(
      interaction.guild.id,
      error.stack,
      interaction.client,
      "VC_ERR_001"
    );
    return interaction.reply({
      content:
        "> <❌> An error occurred while processing the VC command. (VC_ERR_001)",
      ephemeral: true,
    });
  }
}

/**
 * Handles message commands for VC moderation.
 * Allows using the command even if you're not in a VC by optionally mentioning a channel for the "drain" subcommand.
 * Requires Manage Members permission.
 * Example usage:
 *   !vc mute @user
 *   !vc unmute @user
 *   !vc kick @user
 *   !vc drain [#voice-channel]
 */
async function handleVCMessageCommand(message, args = []) {
  try {
    // permission
    if (
      !message.member.permissions.has(
        PermissionsBitField.Flags.ManageMembers
      )
    ) {
      return message.reply("> <❌> You do not have permission to manage members.");
    }

    if (!args.length) {
      return message.reply(
        "> <❌> Please provide a subcommand: `mute`, `unmute`, `kick`, or `drain`"
      );
    }

    const sub = args[0].toLowerCase();
    const guild = message.guild;
    const issuer = await guild.members.fetch(message.author.id);

    // drain
    if (sub === "drain") {
      let channel = issuer.voice.channel || message.mentions.channels.first();
      if (!channel || channel.type !== ChannelType.GuildVoice) {
        return message.reply(
          "> <❌> You must be in or mention a valid voice channel to drain."
        );
      }
      for (const [, m] of channel.members) {
        try {
          await m.voice.disconnect(`Drained by ${message.author.tag}`);
        } catch { }
      }
      return message.reply(`> <🕳️> Drained all users from ${channel.name}.`);
    }

    // collect targets
    const ids = [];
    const mentions = message.mentions.members;
    if (mentions.size) {
      ids.push(...mentions.keys());
    } else if (args[1]) {
      for (const id of args[1].split(/[\s,]+/)) {
        if (/^\d{17,19}$/.test(id)) ids.push(id);
      }
    }

    if (!ids.length) {
      return message.reply(`> <❌> Please mention or list at least one user to ${sub}.`);
    }

    // apply action
    const results = [];
    const actionPast = { mute: "Muted", unmute: "Unmuted", kick: "Kicked" }[sub] || sub;
    const emoji = { mute: "🔇", unmute: "🔊", kick: "🚫" }[sub] || "";

    for (const id of ids) {
      const member = await guild.members.fetch(id).catch(() => null);
      if (!member) {
        results.push(`❌ ${id}`);
        continue;
      }
      if (!member.voice.channel) {
        results.push(`⚠️ ${member.displayName}`);
        continue;
      }
      try {
        if (sub === "mute") {
          await member.voice.setMute(true, `Muted by ${message.author.tag}`);
        } else if (sub === "unmute") {
          await member.voice.setMute(false, `Unmuted by ${message.author.tag}`);
        } else if (sub === "kick") {
          await member.voice.disconnect(`Kicked by ${message.author.tag}`);
        } else {
          return message.reply("> <❌> Unknown subcommand.");
        }
        results.push(member.displayName);
      } catch {
        results.push(`❌ ${member.displayName}`);
      }
    }

    return message.reply(
      `> <${emoji}> ${actionPast}: ${results.join(", ")}`
    );
  } catch (error) {
    console.error(`[ERROR] handleVCMessageCommand: ${error.stack}`);
    await logErrorToChannel(
      message.guild.id,
      error.stack,
      message.client,
      "VC_ERR_001"
    );
    return message.reply(
      "> <❌> An error occurred while processing the VC command. (VC_ERR_001)"
    );
  }
}

module.exports = {
  handleVCSlashCommand,
  handleVCMessageCommand,
};
