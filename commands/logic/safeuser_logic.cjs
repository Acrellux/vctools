// logic/safeuser_logic.cjs

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

function buildNavButtons(page, totalPages, userId, prefix = "safeUserList") {
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
      make("last", "⇥", page === totalPages - 1)
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

/** UNIVERSAL SHOW LIST **/
async function showSafeUserList(ctx) {
  const isInteraction = !!ctx.options || ctx.isButton;
  const userId = isInteraction ? ctx.user.id : ctx.author.id;
  const guild = ctx.guild;
  const settings = (await getSettingsForGuild(guild.id)) || {};
  const safeUsers = settings.safeUsers || [];

  // format with tag + mention
  const lines = await Promise.all(
    safeUsers.map(async id => {
      const member = guild.members.cache.get(id)
        || await guild.members.fetch(id).catch(() => null);
      return member
        ? `- ${member.user.tag} (<@${id}>)`
        : `- \`[unknown user]\` (<@${id}>)`;
    })
  );

  const pages = paginateList(lines);
  let page = 0;
  const embed = new EmbedBuilder()
    .setTitle("Safe Users")
    .setDescription(pages[0]?.join("\n") || "*No safe users set.*")
    .setFooter({ text: `Page 1 of ${pages.length}` });
  const initialComponents = pages.length > 1 ? buildNavButtons(0, pages.length, userId) : [];

  let msg;
  if (isInteraction) {
    if (ctx.replied || ctx.deferred) {
      msg = await ctx.editReply({ embeds: [embed], components: initialComponents, fetchReply: true });
    } else {
      msg = await ctx.reply({ embeds: [embed], components: initialComponents, fetchReply: true, ephemeral: false });
    }
  } else {
    msg = await ctx.channel.send({ embeds: [embed], components: initialComponents });
  }
  if (pages.length <= 1) return;

  const coll = msg.createMessageComponentCollector({
    filter: i => i.customId.startsWith("safeUserList:") && i.user.id === userId,
    time: 3 * 60 * 1000,
  });
  coll.on("collect", async i => {
    const [, action] = i.customId.split(":");
    if (action === "prev") page = Math.max(page - 1, 0);
    if (action === "next") page = Math.min(page + 1, pages.length - 1);
    if (action === "first") page = 0;
    if (action === "last") page = pages.length - 1;

    const updated = EmbedBuilder.from(embed)
      .setDescription(pages[page].join("\n"))
      .setFooter({ text: `Page ${page + 1} of ${pages.length}` });

    await i.update({ embeds: [updated], components: buildNavButtons(page, pages.length, userId) });
  });
  coll.on("end", () => msg.edit({ components: disableAllButtons(msg.components) }));
}

/** MESSAGE-BASED safeuser **/
async function handleSafeUserMessageCommand(message, args) {
  const settings = (await getSettingsForGuild(message.guild.id)) || {};
  const isMod = message.member.roles.cache.has(settings.moderatorRoleId);
  const isAdmin = message.guild.ownerId === message.member.id
    || message.member.roles.cache.has(settings.adminRoleId);
  if (!isMod && !isAdmin) {
    return message.channel.send("> <❌> You lack permission. (CMD_ERR_008)");
  }

  const sub = args[0]?.toLowerCase();
  const guildId = message.guild.id;

  if (sub === "list") {
    return showSafeUserList(message);
  }

  if (sub === "add") {
    // resolve mention or ID
    let user = message.mentions.users.first();
    if (!user) {
      try { user = await message.client.users.fetch(args[1]); }
      catch { return message.channel.send("> <❌> Invalid user mention or ID."); }
    }
    const arr = settings.safeUsers || [];
    if (arr.includes(user.id)) {
      return message.channel.send("> <❇️> Already marked safe.");
    }
    arr.push(user.id);
    await updateSettingsForGuild(guildId, { safeUsers: arr }, message.guild);
    return message.channel.send(`> <✅> Marked ${user.tag} as safe.`);
  }

  if (sub === "remove") {
    let user = message.mentions.users.first();
    if (!user) {
      try { user = await message.client.users.fetch(args[1]); }
      catch { return message.channel.send("> <❌> Invalid user mention or ID."); }
    }
    const arr = settings.safeUsers || [];
    const newArr = arr.filter(id => id !== user.id);
    if (newArr.length === arr.length) {
      return message.channel.send("> <❌> That user was not marked safe.");
    }
    await updateSettingsForGuild(guildId, { safeUsers: newArr }, message.guild);
    return message.channel.send(`> <✅> Removed ${user.tag} from safe users.`);
  }

  return message.channel.send("> <❌> Unknown subcommand. Use `>safeuser list|add|remove`.");
}

/** SLASH-BASED safeuser **/
async function handlesafeUserslashCommand(interaction) {
  if (!interaction.memberPermissions.has(requiredManagerPermissions)) {
    return interaction.reply({ content: "> <❌> You lack permission.", ephemeral: true });
  }

  const sub = interaction.options.getSubcommand(true);
  const guildId = interaction.guild.id;
  const settings = (await getSettingsForGuild(guildId)) || {};

  if (sub === "list") {
    return showSafeUserList(interaction);
  }

  if (sub === "add") {
    const user = interaction.options.getUser("user", true);
    const arr = settings.safeUsers || [];
    if (arr.includes(user.id)) {
      return interaction.reply({ content: "> <❇️> Already marked safe.", ephemeral: true });
    }
    arr.push(user.id);
    await updateSettingsForGuild(guildId, { safeUsers: arr }, interaction.guild);
    return interaction.reply({ content: `> <✅> Marked ${user.tag} as safe.`, ephemeral: false });
  }

  if (sub === "remove") {
    const user = interaction.options.getUser("user", true);
    const arr = settings.safeUsers || [];
    const newArr = arr.filter(id => id !== user.id);
    if (newArr.length === arr.length) {
      return interaction.reply({ content: "> <❇️> That user was not marked safe.", ephemeral: true });
    }
    await updateSettingsForGuild(guildId, { safeUsers: newArr }, interaction.guild);
    return interaction.reply({ content: `> <✅> Removed ${user.tag} from safe users.`, ephemeral: false });
  }

  return interaction.reply({ content: "> <❌> Unknown subcommand.", ephemeral: true });
}

module.exports = {
  showSafeUserList,
  handleSafeUserMessageCommand,
  handlesafeUserslashCommand,
};
