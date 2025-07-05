const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const { interactionContexts } = require("../../database/contextStore.cjs");
const {
  getSettingsForGuild,
  updateSettingsForGuild,
} = require("../settings.cjs");
const { logErrorToChannel } = require("./helpers.cjs");

const requiredManagerPermissions = ["ManageGuild"];

/** PAGINATION HELPERS */
function paginateList(items, maxPerPage = 10) {
  const pages = [];
  for (let i = 0; i < items.length; i += maxPerPage) {
    pages.push(items.slice(i, i + maxPerPage));
  }
  return pages;
}

function buildNavButtons(page, totalPages, userId, prefix = "safeChannelList") {
  const make = (action, label, disabled) =>
    new ButtonBuilder()
      .setCustomId(`${prefix}:${action}:${page}:${userId}`)
      .setLabel(label)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled);

  return [new ActionRowBuilder().addComponents(
    make("first", "⇤", page === 0),
    make("prev", "◄", page === 0),
    make("next", "►", page === totalPages - 1),
    make("last", "⇥", page === totalPages - 1)
  )];
}

function disableAllButtons(rows) {
  return rows.map(row =>
    new ActionRowBuilder().addComponents(
      row.components.map(btn =>
        ButtonBuilder.from(btn).setDisabled(true)
      )
    )
  );
}

/** SHOW HANDLER */
async function showSafeChannelList(ctx) {
  const isInteraction = !!ctx.options || !!ctx.isButton;
  const userId = isInteraction ? ctx.user.id : ctx.author.id;
  const guild = ctx.guild;

  const settings = (await getSettingsForGuild(guild.id)) || {};
  const safeChannels = settings.safeChannels || [];
  const lines = safeChannels.map(id => `- <#${id}>`);
  const pages = paginateList(lines);
  let page = 0;

  const embed = new EmbedBuilder()
    .setTitle("Safe Channels")
    .setDescription(pages[0]?.join("\n") || "*No safe channels set.*")
    .setFooter({ text: `Page 1 of ${pages.length}` });

  const components = buildNavButtons(0, pages.length, userId);

  async function send() {
    if (ctx.replied || ctx.deferred) {
      return await ctx.editReply({ embeds: [embed], components, fetchReply: true });
    } else if (isInteraction) {
      return await ctx.reply({ embeds: [embed], components, fetchReply: true, ephemeral: true });
    } else {
      return await ctx.channel.send({ embeds: [embed], components });
    }
  }

  const msg = await send();
  if (pages.length <= 1) return;

  const coll = msg.createMessageComponentCollector({
    filter: i => i.customId.startsWith("safeChannelList:") && i.user.id === userId,
    time: 3 * 60 * 1000,
  });

  coll.on("collect", async i => {
    const [, action] = i.customId.split(":");
    if (action === "prev") page = Math.max(page - 1, 0);
    else if (action === "next") page = Math.min(page + 1, pages.length - 1);
    else if (action === "first") page = 0;
    else if (action === "last") page = pages.length - 1;

    const updated = EmbedBuilder.from(embed)
      .setDescription(pages[page].join("\n") || "*No safe channels set.*")
      .setFooter({ text: `Page ${page + 1} of ${pages.length}` });

    await i.update({
      embeds: [updated],
      components: buildNavButtons(page, pages.length, userId),
    });
  });

  coll.on("end", () =>
    msg.edit({ components: disableAllButtons(msg.components) })
  );
}

/** MESSAGE-BASED safechannel */
async function handleSafeChannelMessageCommand(message, args) {
  try {
    if (!message.member.permissions.has(requiredManagerPermissions)) {
      return message.channel.send(
        "> <❌> You do not have permission to manage safe channels."
      );
    }

    const subCmd = args[0]?.toLowerCase();
    const guildId = message.guild.id;
    const settings = (await getSettingsForGuild(guildId)) || {};

    switch (subCmd) {
      case "list":
        return showSafeChannelList(message);

      case "add": {
        if (!args[1]) {
          return message.channel.send(
            "> <❌> Usage: `>safechannel add #Channel`"
          );
        }
        const channelId = args[1].replace(/[<#>]/g, "");
        const safeChannels = settings.safeChannels || [];
        if (safeChannels.includes(channelId)) {
          return message.channel.send(
            "> <❇️> **That channel is already marked safe.**"
          );
        }
        safeChannels.push(channelId);
        await updateSettingsForGuild(guildId, { safeChannels }, message.guild);
        return message.channel.send(
          `> <✅> Marked <#${channelId}> as safe.`
        );
      }

      case "remove": {
        if (!args[1]) {
          return message.channel.send(
            "> <❌> Usage: `>safechannel remove #Channel`"
          );
        }
        const channelId = args[1].replace(/[<#>]/g, "");
        const safeChannels = settings.safeChannels || [];
        const newArray = safeChannels.filter(id => id !== channelId);
        if (newArray.length === safeChannels.length) {
          return message.channel.send(
            "> <❌> That channel was not marked safe."
          );
        }
        await updateSettingsForGuild(guildId, { safeChannels: newArray }, message.guild);
        return message.channel.send(
          `> <✅> Removed <#${channelId}> from safe channels.`
        );
      }

      default:
        return message.channel.send(
          "> <❌> Unknown subcommand. Use `>safechannel list|add|remove`."
        );
    }
  } catch (error) {
    console.error(`[ERROR] handleSafeChannelMessageCommand: ${error.message}`);
    return message.channel.send(
      "> <❌> An error occurred managing safe channels. Check logs."
    );
  }
}

/** SLASH-BASED safechannel */
async function handlesafeChannelslashCommand(interaction) {
  try {
    if (!interaction.memberPermissions.has(requiredManagerPermissions)) {
      return interaction.reply({
        content: "> <❌> You lack permission to manage safe channels.",
        ephemeral: true,
      });
    }

    const subCmd = interaction.options.getSubcommand(true);
    const guildId = interaction.guild.id;
    const settings = (await getSettingsForGuild(guildId)) || {};

    switch (subCmd) {
      case "list":
        return showSafeChannelList(interaction);

      case "add": {
        const channel = interaction.options.getChannel("channel", true);
        const safeChannels = settings.safeChannels || [];
        if (safeChannels.includes(channel.id)) {
          return interaction.reply({
            content: "> <❇️> That channel is already marked safe.",
            ephemeral: true,
          });
        }
        safeChannels.push(channel.id);
        await updateSettingsForGuild(guildId, { safeChannels }, interaction.guild);
        return interaction.reply({
          content: `> <✅> Marked <#${channel.id}> as safe.`,
          ephemeral: false,
        });
      }

      case "remove": {
        const channel = interaction.options.getChannel("channel", true);
        const safeChannels = settings.safeChannels || [];
        const newArray = safeChannels.filter(id => id !== channel.id);
        if (newArray.length === safeChannels.length) {
          return interaction.reply({
            content: "> <❇️> That channel was not marked safe.",
            ephemeral: true,
          });
        }
        await updateSettingsForGuild(guildId, { safeChannels: newArray }, interaction.guild);
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
  showSafeChannelList,
};