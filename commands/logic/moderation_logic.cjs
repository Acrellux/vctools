const {
  Client,
  GatewayIntentBits,
  Partials,
  Collection,
  Events,
  Message,
  Interaction,
  PermissionsBitField,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  SlashCommandBuilder,
} = require("discord.js");

const { interactionContexts } = require("../../database/contextStore.cjs");

const { getSettingsForGuild } = require("../settings.cjs");

const requiredManagerPermissions = ["ManageGuild"];

const { logErrorToChannel } = require("../logic/helpers.cjs");

/**
 * =====================
 *  MOD COMMAND HANDLERS
 * =====================
 * 1) mute -> server timeout
 * 2) unmute -> remove server timeout
 * 3) kick -> remove from server
 * 4) ban -> ban from server
 */

//----- (A) Message-based mod commands -----
async function handleModMessageCommand(message, args) {
  // Usage examples:
  // >mod mute <userId/mention>
  // >mod unmute <userId/mention>
  // >mod kick <userId/mention>
  // >mod ban <userId/mention>
  try {
    if (
      !message.member.permissions.has(PermissionsBitField.Flags.KickMembers)
    ) {
      return message.channel.send(
        "> <❌> You do not have permission to use mod commands."
      );
    }
    if (!args[0] || !args[1]) {
      return message.channel.send(
        "> <❌> Usage: `>mod <mute|unmute|kick|ban> <user>`"
      );
    }
    const subCommand = args[0].toLowerCase();
    const userArg = args[1];
    const targetMember =
      message.mentions.members.first() ||
      (await message.guild.members.fetch(userArg).catch(() => null));

    if (!targetMember) {
      return message.channel.send(
        "> <❌> Could not find that user in this server."
      );
    }

    switch (subCommand) {
      case "mute": {
        // Timeout user for 60 minutes as an example (adjust as needed)
        await targetMember.timeout(60 * 60 * 1000, "Server mute command");
        message.channel.send(
          `> <✅> Muted ${targetMember.user.username} on the server (timeout).`
        );
        break;
      }
      case "unmute": {
        // Remove their timeout
        await targetMember.timeout(null, "Server unmute command");
        message.channel.send(
          `> <✅> Unmuted ${targetMember.user.username} (timeout removed).`
        );
        break;
      }
      case "kick": {
        await targetMember.kick("Server Kick command");
        message.channel.send(
          `> <✅> Kicked ${targetMember.user.username} from the server.`
        );
        break;
      }
      case "ban": {
        await targetMember.ban({ reason: "Server Ban command" });
        message.channel.send(
          `> <✅> Banned ${targetMember.user.username} from the server.`
        );
        break;
      }
      default:
        message.channel.send(
          "> <❌> Unknown subcommand. Use `>mod mute|unmute|kick|ban <user>`."
        );
    }
  } catch (error) {
    console.error(`[ERROR] handleModMessageCommand: ${error.message}`);
    message.channel.send("> <❌> An error occurred using mod commands.");
  }
}

//----- (B) Slash-based mod commands -----
async function handleModSlashCommand(interaction) {
  // e.g. /mod mute user:@someone
  try {
    if (
      !interaction.memberPermissions.has(PermissionsBitField.Flags.KickMembers)
    ) {
      return interaction.reply({
        content: "> <❌> You do not have permission to use mod commands.",
        ephemeral: true,
      });
    }
    const subCommand = interaction.options.getSubcommand(true);
    const targetUser = interaction.options.getUser("user", true);
    const targetMember = await interaction.guild.members
      .fetch(targetUser.id)
      .catch(() => null);

    if (!targetMember) {
      return interaction.reply({
        content: "> <❌> Could not find that user in this server.",
        ephemeral: true,
      });
    }

    switch (subCommand) {
      case "mute": {
        await targetMember.timeout(60 * 60 * 1000, "Slash-based server mute");
        await interaction.reply({
          content: `> <✅> Muted ${targetMember.user.username} on the server.`,
          ephemeral: false,
        });
        break;
      }
      case "unmute": {
        await targetMember.timeout(null, "Slash-based server unmute");
        await interaction.reply({
          content: `> <✅> Unmuted ${targetMember.user.username}.`,
          ephemeral: false,
        });
        break;
      }
      case "kick": {
        await targetMember.kick("Slash-based server kick");
        await interaction.reply({
          content: `> <✅> Kicked ${targetMember.user.username} from the server.`,
          ephemeral: false,
        });
        break;
      }
      case "ban": {
        await targetMember.ban({ reason: "Slash-based server ban" });
        await interaction.reply({
          content: `> <✅> Banned ${targetMember.user.username} from the server.`,
          ephemeral: false,
        });
        break;
      }
      default:
        return interaction.reply({
          content: "> <❌> Unknown mod subcommand (mute|unmute|kick|ban).",
          ephemeral: true,
        });
    }
  } catch (error) {
    console.error(`[ERROR] handleModSlashCommand: ${error.message}`);
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
