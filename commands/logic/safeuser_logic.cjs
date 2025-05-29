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

const {
  getSettingsForGuild,
  updateSettingsForGuild,
} = require("../settings.cjs");
const { logErrorToChannel } = require("./helpers.cjs");

const requiredManagerPermissions = ["ManageGuild"];

/**
 * =========================================
 * SAFEUSER Command Handlers
 * =========================================
 * 1) safeuser list
 * 2) safeuser add <user>
 * 3) safeuser remove <user>
 *
 * We store them in the guild's settings:
 * settings.safeUsers = [<userId1>, <userId2>, ...]
 */

// (C) Message-based safeuser commands
async function handleSafeUserMessageCommand(message, args) {
  // e.g. >safeuser list
  //      >safeuser add @User
  //      >safeuser remove @User
  try {
    // Check if the user has the required permissions. SPECIFICALLY check for the moderator role, not the administator role.
    const settings = (await getSettingsForGuild(message.guild.id)) || {};
    const isMod = message.member.roles.cache.has(settings.moderatorRoleId);
    const isAdmin = message.guild.ownerId === message.member.id || message.member.roles.cache.has(settings.adminRoleId);

    if (!isMod && !isAdmin) {
      return message.channel.send(
        "> <❌> You do not have the required permissions to manage safe users. (CMD_ERR_008)"
      );
    }

    const subCmd = args[0]?.toLowerCase();
    const guildId = message.guild.id;

    switch (subCmd) {
      case "list": {
        const safeUsers = settings.safeUsers || [];
        if (safeUsers.length === 0) {
          return message.channel.send("> **No safe users set.**");
        }
        // Convert user IDs to tags or placeholders
        const userList = [];
        for (const id of safeUsers) {
          const member = await message.guild.members
            .fetch(id)
            .catch(() => null);
          userList.push(member ? `@${member.user.tag}` : `Unknown(${id})`);
        }
        message.channel.send(`> **Safe Users:** ${userList.join(", ")}`);
        break;
      }
      case "add": {
        // Changed from "set" to "add"
        if (!args[1]) {
          return message.channel.send(
            "> <❌> Usage: `>safeuser add @UserOrID`"
          );
        }
        // Parse user mention/ID
        let userId = args[1].replace(/[<@!>]/g, "");
        const safeUsers = settings.safeUsers || [];
        if (safeUsers.includes(userId)) {
          return message.channel.send(
            "> <❇️> **That user is already marked safe.**"
          );
        }
        safeUsers.push(userId);
        await updateSettingsForGuild(guildId, { safeUsers }, message.guild);
        message.channel.send(`> <✅> Marked user <@${userId}> as safe. This user will no longer be transcribed or filtered.`);
        break;
      }
      case "remove": {
        if (!args[1]) {
          return message.channel.send(
            "> <❌> Usage: `>safeuser remove @UserOrID`"
          );
        }
        let userId = args[1].replace(/[<@!>]/g, "");
        const safeUsers = settings.safeUsers || [];
        const newArray = safeUsers.filter((id) => id !== userId);
        if (newArray.length === safeUsers.length) {
          return message.channel.send("> <❌> That user was not marked safe.");
        }
        await updateSettingsForGuild(
          guildId,
          { safeUsers: newArray },
          message.guild
        );
        message.channel.send(`> <✅> Removed <@${userId}> from safe users.`);
        break;
      }
      default:
        message.channel.send(
          "> <❌> Unknown subcommand. Use `>safeuser list|add|remove`."
        );
        break;
    }
  } catch (error) {
    console.error(`[ERROR] handleSafeUserMessageCommand: ${error.message}`);
    message.channel.send(
      "> <❌> An error occurred managing safe users. Check logs."
    );
  }
}

// (D) Slash-based safeuser commands
async function handlesafeUserslashCommand(interaction) {
  try {
    if (!interaction.memberPermissions.has(requiredManagerPermissions)) {
      return interaction.reply({
        content: "> <❌> You lack permission to manage safe users.",
        ephemeral: true,
      });
    }

    const subCmd = interaction.options.getSubcommand(true); // list|add|remove
    const guildId = interaction.guild.id;
    const settings = await getSettingsForGuild(guildId);

    switch (subCmd) {
      case "list": {
        const safeUsers = settings.safeUsers || [];
        if (safeUsers.length === 0) {
          return interaction.reply({
            content: "> **No safe users set.**",
            ephemeral: false,
          });
        }
        const userList = await Promise.all(
          safeUsers.map(async (id) => {
            const member = await interaction.guild.members
              .fetch(id)
              .catch(() => null);
            return member ? `@${member.user.tag}` : `Unknown(${id})`;
          })
        );
        return interaction.reply({
          content: `> **Safe Users:** ${userList.join(", ")}`,
          ephemeral: false,
        });
      }

      case "add": {
        // Changed from "set" to "add"
        const user = interaction.options.getUser("user", true);
        if (!user) {
          return interaction.reply({
            content: "> <❌> Invalid user provided.",
            ephemeral: true,
          });
        }
        const safeUsers = settings.safeUsers || [];
        if (safeUsers.includes(user.id)) {
          return interaction.reply({
            content: "> <❇️> That user is already marked safe.",
            ephemeral: true,
          });
        }
        safeUsers.push(user.id);
        await updateSettingsForGuild(guildId, { safeUsers }, interaction.guild);
        return interaction.reply({
          content: `> <✅> Marked user <@${user.id}> as safe. This user will no longer be transcribed or filtered.`,
          ephemeral: false,
        });
      }

      case "remove": {
        const user = interaction.options.getUser("user", true);
        if (!user) {
          return interaction.reply({
            content: "> <❌> Invalid user provided.",
            ephemeral: true,
          });
        }
        const safeUsers = settings.safeUsers || [];
        const newArray = safeUsers.filter((id) => id !== user.id);
        if (newArray.length === safeUsers.length) {
          return interaction.reply({
            content: "> <❇️> That user was not marked safe.",
            ephemeral: true,
          });
        }
        await updateSettingsForGuild(
          guildId,
          { safeUsers: newArray },
          interaction.guild
        );
        return interaction.reply({
          content: `> <✅> Removed <@${user.id}> from safe users.`,
          ephemeral: false,
        });
      }

      default:
        return interaction.reply({
          content: "> <❌> Unknown subcommand. Use list|add|remove.",
          ephemeral: true,
        });
    }
  } catch (error) {
    console.error(`[ERROR] handlesafeUserslashCommand: ${error.message}`);
    if (!interaction.replied) {
      interaction.reply({
        content: "> <❌> An error occurred with safeuser slash command.",
        ephemeral: true,
      });
    }
  }
}

module.exports = {
  handleSafeUserMessageCommand,
  handlesafeUserslashCommand,
};
