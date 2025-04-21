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
    // Permission check:
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

    const subcommand = interaction.options.getSubcommand();
    const guild = interaction.guild;
    const issuer = await guild.members.fetch(interaction.user.id);
    let target, member;

    switch (subcommand) {
      case "mute": {
        target = interaction.options.getUser("user");
        if (!target) {
          return interaction.reply({
            content: "> <❌> Please specify a user to mute.",
            ephemeral: true,
          });
        }
        member = await guild.members.fetch(target.id);
        if (!member || !member.voice.channel) {
          return interaction.reply({
            content: "> <⚠️> That user is not in a voice channel.",
            ephemeral: true,
          });
        }
        await member.voice.setMute(true, `Muted by ${interaction.user.tag}`);
        return interaction.reply({
          content: `> <🔇> Muted ${member.displayName} in voice channel.`,
          ephemeral: true,
        });
      }
      case "unmute": {
        target = interaction.options.getUser("user");
        if (!target) {
          return interaction.reply({
            content: "> <❌> Please specify a user to unmute.",
            ephemeral: true,
          });
        }
        member = await guild.members.fetch(target.id);
        if (!member || !member.voice.channel) {
          return interaction.reply({
            content: "> <⚠️> That user is not in a voice channel.",
            ephemeral: true,
          });
        }
        await member.voice.setMute(false, `Unmuted by ${interaction.user.tag}`);
        return interaction.reply({
          content: `> <🔊> Unmuted ${member.displayName} in voice channel.`,
          ephemeral: true,
        });
      }
      case "kick": {
        target = interaction.options.getUser("user");
        if (!target) {
          return interaction.reply({
            content: "> <❌> Please specify a user to kick from voice.",
            ephemeral: true,
          });
        }
        member = await guild.members.fetch(target.id);
        if (!member || !member.voice.channel) {
          return interaction.reply({
            content: "> <⚠️> That user is not in a voice channel.",
            ephemeral: true,
          });
        }
        await member.voice.disconnect(`Kicked by ${interaction.user.tag}`);
        return interaction.reply({
          content: `> <🚫> Kicked ${member.displayName} from voice channel.`,
          ephemeral: true,
        });
      }
      case "drain": {
        // For slash commands, we assume the issuer must be in a VC.
        if (!issuer.voice.channel) {
          return interaction.reply({
            content: "> <❌> You must be in a voice channel to drain it.",
            ephemeral: true,
          });
        }
        const channel = issuer.voice.channel;
        const disconnectPromises = channel.members.map(async (m) => {
          try {
            await m.voice.disconnect(`Drained by ${interaction.user.tag}`);
          } catch (err) {
            console.error(`Failed to disconnect ${m.user.tag}: ${err.message}`);
          }
        });
        await Promise.all(disconnectPromises);
        return interaction.reply({
          content: `> <💥> Drained all users from ${channel.name}.`,
          ephemeral: true,
        });
      }
      default:
        return interaction.reply({
          content:
            "> <❌> Unknown subcommand. Options: mute, unmute, kick, drain.",
          ephemeral: true,
        });
    }
  } catch (error) {
    console.error(`[ERROR] handleVCSlashCommand: ${error.message}`);
    logErrorToChannel(
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
    if (
      !message.member.permissions.has(PermissionsBitField.Flags.ManageMembers)
    ) {
      return message.reply(
        "> <❌> You do not have permission to manage members."
      );
    }
    if (!args.length) {
      return message.reply(
        "> <❌> Please provide a subcommand: `mute`, `unmute`, `kick`, or `drain`"
      );
    }

    const subcommand = args[0].toLowerCase();
    const guild = message.guild;
    const issuer = await guild.members.fetch(message.author.id);
    let target, member;

    switch (subcommand) {
      case "mute": {
        target = message.mentions.users.first() || { id: args[1] };
        if (!target.id) {
          return message.reply(
            "> <❌> Please mention a user or provide a user ID for mute."
          );
        }
        member = await guild.members.fetch(target.id).catch(() => null);
        if (!member || !member.voice.channel) {
          return message.reply("> <❇️> That user is not in a voice channel.");
        }
        await member.voice.setMute(true, `Muted by ${message.author.tag}`);
        return message.reply(
          `> <🔇> Muted ${member.displayName} in voice channel.`
        );
      }
      case "unmute": {
        target = message.mentions.users.first() || { id: args[1] };
        if (!target.id) {
          return message.reply(
            "> <❌> Please mention a user or provide a user ID for unmute."
          );
        }
        member = await guild.members.fetch(target.id).catch(() => null);
        if (!member || !member.voice.channel) {
          return message.reply("> <❇️> That user is not in a voice channel.");
        }
        await member.voice.setMute(false, `Unmuted by ${message.author.tag}`);
        return message.reply(
          `> <🔊> Unmuted ${member.displayName} in voice channel.`
        );
      }
      case "kick": {
        target = message.mentions.users.first() || { id: args[1] };
        if (!target.id) {
          return message.reply(
            "> <❌> Please mention a user or provide a user ID to kick from voice."
          );
        }
        member = await guild.members.fetch(target.id).catch(() => null);
        if (!member || !member.voice.channel) {
          return message.reply("> <❇️> That user is not in a voice channel.");
        }
        await member.voice.disconnect(`Kicked by ${message.author.tag}`);
        return message.reply(
          `> <🚫> Kicked ${member.displayName} from voice channel.`
        );
      }
      case "drain": {
        // For drain, if the issuer isn't in a voice channel, allow them to mention one.
        let channel;
        if (issuer.voice.channel) {
          channel = issuer.voice.channel;
        } else {
          channel = message.mentions.channels.first();
        }
        if (!channel || channel.type !== ChannelType.GuildVoice) {
          return message.reply(
            "> <❌> You must be in a voice channel or mention a valid voice channel to drain."
          );
        }
        for (const [id, m] of channel.members) {
          try {
            await m.voice.disconnect(`Drained by ${message.author.tag}`);
          } catch (err) {
            console.error(`Failed to disconnect ${m.user.tag}: ${err.message}`);
          }
        }
        return message.reply(`> <🕳️> Drained all users from ${channel.name}.`);
      }
      default:
        return message.reply(
          "> <❌> Unknown subcommand. Options: `mute`, `unmute`, `kick`, `drain`"
        );
    }
  } catch (error) {
    console.error(`[ERROR] handleVCMessageCommand: ${error.message}`);
    logErrorToChannel(
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
