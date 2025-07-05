// logic/safechannel_logic.cjs

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const { getSettingsForGuild, updateSettingsForGuild } = require("../settings.cjs");

const requiredManagerPermissions = ["ManageGuild"];

/** PAGINATION HELPERS **/
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

  return [
    new ActionRowBuilder().addComponents(
      make("first", "⇤", page === 0),
      make("prev", "◄", page === 0),
      make("next", "►", page === totalPages - 1),
      make("last", "⇥", page === totalPages - 1),
    )
  ];
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

/**
 * SHOW SAFE CHANNEL LIST
 */
async function showSafeChannelList(ctx) {
  const isInteraction = !!ctx.options || ctx.isButton;
  const userId = isInteraction ? ctx.user.id : ctx.author.id;
  const guild = ctx.guild;
  const settings = (await getSettingsForGuild(guild.id)) || {};
  const safeChannels = settings.safeChannels || [];

  const lines = await Promise.all(
    safeChannels.map(async id => {
      const ch = guild.channels.cache.get(id)
        || await guild.channels.fetch(id).catch(() => null);
      return ch
        ? `- <#${ch.id}>`
        : `- \`[deleted]\` (\`${id}\`)`;
    })
  );

  const pages = paginateList(lines);
  let page = 0;

  const embed = new EmbedBuilder()
    .setTitle("Safe Channels")
    .setDescription(pages[0]?.join("\n") || "*No safe channels set.*")
    .setFooter({ text: `Page 1 of ${pages.length}` });

  const initialComponents = pages.length > 1
    ? buildNavButtons(0, pages.length, userId)
    : [];

  const sendReply = async (payload) => {
    if (isInteraction) {
      const method = ctx.replied || ctx.deferred ? ctx.followUp : ctx.reply;
      return await method.call(ctx, { ...payload, fetchReply: true });
    } else {
      return await ctx.channel.send({ ...payload, fetchReply: true });
    }
  };

  const msg = await sendReply({
    embeds: [embed],
    components: initialComponents,
  });

  if (pages.length <= 1) return;

  const coll = msg.createMessageComponentCollector({
    filter: i => {
      if (!i.customId.startsWith("safeChannelList:")) return false;
      if (i.user.id !== userId) {
        i.reply({
          content: "> <❇️> You cannot interact with this list.",
          ephemeral: true,
        }).catch(() => { });
        return false;
      }
      return true;
    },
    time: 3 * 60 * 1000,
  });

  coll.on("collect", async i => {
    try {
      const [, action] = i.customId.split(":");
      if (action === "prev") page = Math.max(page - 1, 0);
      else if (action === "next") page = Math.min(page + 1, pages.length - 1);
      else if (action === "first") page = 0;
      else if (action === "last") page = pages.length - 1;

      const updated = EmbedBuilder.from(embed)
        .setDescription(pages[page].join("\n"))
        .setFooter({ text: `Page ${page + 1} of ${pages.length}` });

      await i.update({
        embeds: [updated],
        components: buildNavButtons(page, pages.length, userId),
      });
    } catch (err) {
      console.error("[safeChannelList] update failed:", err);
      if (!i.replied) {
        await i.reply({
          content: "> <❌> Could not update the list. Try again.",
          ephemeral: true,
        }).catch(() => { });
      }
    }
  });

  coll.on("end", async () => {
    try {
      if (msg.editable) {
        await msg.edit({ components: disableAllButtons(msg.components) });
      }
    } catch (err) {
      if (err.code !== 10008) {
        console.error("[safeChannelList] Failed to disable buttons:", err);
      }
    }
  });
}

/** MESSAGE-BASED safechannel **/
async function handleSafeChannelMessageCommand(message, args) {
  const settings = (await getSettingsForGuild(message.guild.id)) || {};
  if (!message.member.permissions.has(requiredManagerPermissions)) {
    return message.channel.send("> <❌> You do not have permission to manage safe channels.");
  }

  const sub = args[0]?.toLowerCase();
  const guildId = message.guild.id;

  if (sub === "list") {
    return showSafeChannelList(message);
  }

  if (sub === "add") {
    // resolve channel mention or ID
    let channel = message.mentions.channels.first();
    if (!channel && args[1]) {
      channel = message.guild.channels.cache.get(args[1])
        || await message.guild.channels.fetch(args[1]).catch(() => null);
    }
    if (!channel) {
      return message.channel.send("> <❌> Invalid channel mention or ID.");
    }
    const arr = settings.safeChannels || [];
    if (arr.includes(channel.id)) {
      return message.channel.send("> <❇️> That channel is already marked safe.");
    }
    arr.push(channel.id);
    await updateSettingsForGuild(guildId, { safeChannels: arr }, message.guild);
    return message.channel.send(`> <✅> Marked <#${channel.id}> as safe.`);

  } else if (sub === "remove") {
    let channel = message.mentions.channels.first();
    if (!channel && args[1]) {
      channel = message.guild.channels.cache.get(args[1])
        || await message.guild.channels.fetch(args[1]).catch(() => null);
    }
    if (!channel) {
      return message.channel.send("> <❌> Invalid channel mention or ID.");
    }
    const arr = settings.safeChannels || [];
    const newArr = arr.filter(c => c !== channel.id);
    if (newArr.length === arr.length) {
      return message.channel.send("> <❌> That channel was not marked safe.");
    }
    await updateSettingsForGuild(guildId, { safeChannels: newArr }, message.guild);
    return message.channel.send(`> <✅> Removed <#${channel.id}> from safe channels.`);
  }

  return message.channel.send("> <❌> Unknown subcommand. Use `>safechannel list|add|remove`.");
}

/** SLASH-BASED safechannel **/
async function handlesafeChannelslashCommand(interaction) {
  if (!interaction.memberPermissions.has(requiredManagerPermissions)) {
    return interaction.reply({ content: "> <❌> You lack permission.", ephemeral: true });
  }

  const sub = interaction.options.getSubcommand(true);
  const guildId = interaction.guild.id;
  const settings = (await getSettingsForGuild(guildId)) || {};

  if (sub === "list") {
    return showSafeChannelList(interaction);
  }

  if (sub === "add") {
    const channel = interaction.options.getChannel("channel", true);
    const arr = settings.safeChannels || [];
    if (arr.includes(channel.id)) {
      return interaction.reply({ content: "> <❇️> Already marked safe.", ephemeral: true });
    }
    arr.push(channel.id);
    await updateSettingsForGuild(guildId, { safeChannels: arr }, interaction.guild);
    return interaction.reply({ content: `> <✅> Marked <#${channel.id}> as safe.`, ephemeral: false });
  }

  if (sub === "remove") {
    const channel = interaction.options.getChannel("channel", true);
    const arr = settings.safeChannels || [];
    const newArr = arr.filter(c => c !== channel.id);
    if (newArr.length === arr.length) {
      return interaction.reply({ content: "> <❇️> Not marked safe.", ephemeral: true });
    }
    await updateSettingsForGuild(guildId, { safeChannels: newArr }, interaction.guild);
    return interaction.reply({ content: `> <✅> Removed <#${channel.id}> from safe channels.`, ephemeral: false });
  }

  return interaction.reply({ content: "> <❌> Unknown subcommand.", ephemeral: true });
}

module.exports = {
  showSafeChannelList,
  handleSafeChannelMessageCommand,
  handlesafeChannelslashCommand,
};