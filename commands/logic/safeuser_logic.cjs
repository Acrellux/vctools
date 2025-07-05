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
      if (!i.customId.startsWith("safeUserList:")) return false;
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
      console.error("[safeUserList] update failed:", err);
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
        await msg.edit({
          components: disableAllButtons(msg.components),
        });
      }
    } catch (err) {
      if (err.code !== 10008) {
        console.error("[safeUserList] Failed to disable buttons:", err);
      }
    }
  });
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
