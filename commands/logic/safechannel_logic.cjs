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
 * SAFECHANNEL Command Handlers
 * =========================================
 * 1) safechannel list
 * 2) safechannel add <channel>
 * 3) safechannel remove <channel>
 *
 * We store them in the guild's settings:
 * settings.safeChannels = [<channelId1>, <channelId2>, ...]
 */

async function handleSafeChannelMessageCommand(message, args) {
  try {
    if (!message.member.permissions.has(requiredManagerPermissions)) {
      return message.channel.send(
        "> <❌> You do not have the required permissions to manage safe channels."
      );
    }
    const subCmd = args[0]?.toLowerCase();
    const guildId = message.guild.id;
    const settings = getSettingsForGuild(guildId);

    switch (subCmd) {
      case "list": {
        const safeChannels = settings.safeChannels || [];
        if (safeChannels.length === 0) {
          return message.channel.send("> <❇️> **No safe channels set.**");
        }
        const channelList = safeChannels.map((id) => {
          const channel = message.guild.channels.cache.get(id) || null;
          return channel ? `<#${channel.id}>` : `Unknown(${id})`;
        });
        message.channel.send(`> <🔒> **Safe Channels:** ${channelList.join(", ")}`);
        break;
      }
      case "add": {
        // Changed from "set" to "add"
        if (!args[1]) {
          return message.channel.send(
            "> <❌> Usage: `>safechannel add #Channel`"
          );
        }
        let channelId = args[1].replace(/[<#>]/g, "");
        const safeChannels = settings.safeChannels || [];
        if (safeChannels.includes(channelId)) {
          return message.channel.send(
            "> <❇️> **That channel is already marked safe.**"
          );
        }
        safeChannels.push(channelId);
        await updateSettingsForGuild(guildId, { safeChannels }, message.guild);
        message.channel.send(`> <✅> Marked channel <#${channelId}> as safe. Transcription and filtering will not be applied to this channel.`);
        break;
      }
      case "remove": {
        if (!args[1]) {
          return message.channel.send(
            "> <❌> Usage: `>safechannel remove #Channel`"
          );
        }
        let channelId = args[1].replace(/[<#>]/g, "");
        const safeChannels = settings.safeChannels || [];
        const newArray = safeChannels.filter((id) => id !== channelId);
        if (newArray.length === safeChannels.length) {
          return message.channel.send(
            "> <❌> That channel was not marked safe."
          );
        }
        await updateSettingsForGuild(
          guildId,
          { safeChannels: newArray },
          message.guild
        );
        message.channel.send(
          `> <✅> Removed <#${channelId}> from safe channels.`
        );
        break;
      }
      default:
        message.channel.send(
          "> <❌> Unknown subcommand. Use `>safechannel list|add|remove`."
        );
        break;
    }
  } catch (error) {
    console.error(`[ERROR] handleSafeChannelMessageCommand: ${error.message}`);
    message.channel.send(
      "> <❌> An error occurred managing safe channels. Check logs."
    );
  }
}

async function handlesafeChannelslashCommand(interaction) {
  try {
    if (!interaction.memberPermissions.has(requiredManagerPermissions)) {
      return interaction.reply({
        content: "> <❌> You lack permission to manage safe channels.",
        ephemeral: true,
      });
    }

    const subCmd = interaction.options.getSubcommand(true); // "list", "add", or "remove"
    const guildId = interaction.guild.id;
    const settings = getSettingsForGuild(guildId);

    switch (subCmd) {
      case "list": {
        const safeChannels = settings.safeChannels || [];
        if (safeChannels.length === 0) {
          return interaction.reply({
            content: "> <❇️> **No safe channels set.**",
            ephemeral: false,
          });
        }
        const channelList = await Promise.all(
          safeChannels.map(async (id) => {
            const channel = await interaction.guild.channels
              .fetch(id)
              .catch(() => null);
            return channel ? `<#${channel.id}>` : `Unknown(${id})`;
          })
        );
        return interaction.reply({
          content: `> <🔒> **Safe Channels:** ${channelList.join(", ")}`,
          ephemeral: false,
        });
      }

      case "add": {
        // Changed from "set" to "add"
        const channel = interaction.options.getChannel("channel", true);
        if (!channel) {
          return interaction.reply({
            content: "> <❌> Invalid channel provided.",
            ephemeral: true,
          });
        }
        const safeChannels = settings.safeChannels || [];
        if (safeChannels.includes(channel.id)) {
          return interaction.reply({
            content: "> <❇️> That channel is already marked safe.",
            ephemeral: true,
          });
        }
        safeChannels.push(channel.id);
        await updateSettingsForGuild(
          guildId,
          { safeChannels },
          interaction.guild
        );
        return interaction.reply({
          content: `> <✅> Marked channel <#${channel.id}> as safe. Transcription and filtering will not be applied to this channel.`,
          ephemeral: false,
        });
      }

      case "remove": {
        const channel = interaction.options.getChannel("channel", true);
        if (!channel) {
          return interaction.reply({
            content: "> <❌> Invalid channel provided.",
            ephemeral: true,
          });
        }
        const safeChannels = settings.safeChannels || [];
        const newArray = safeChannels.filter((id) => id !== channel.id);
        if (newArray.length === safeChannels.length) {
          return interaction.reply({
            content: "> <❇️> That channel was not marked safe.",
            ephemeral: true,
          });
        }
        await updateSettingsForGuild(
          guildId,
          { safeChannels: newArray },
          interaction.guild
        );
        return interaction.reply({
          content: `> <✅> Removed <#${channel.id}> from safe channels.`,
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
    console.error(`[ERROR] handlesafeChannelslashCommand: ${error.message}`);
    if (!interaction.replied) {
      interaction.reply({
        content: "> <❌> An error occurred with safechannel slash command.",
        ephemeral: true,
      });
    }
  }
}

module.exports = {
  handleSafeChannelMessageCommand,
  handlesafeChannelslashCommand,
};
