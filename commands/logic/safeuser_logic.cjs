// logic/safeuser_logic.cjs

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const { getSettingsForGuild, updateSettingsForGuild } = require("../settings.cjs");

const requiredManagerPermissions = ["ManageGuild"];

/** PAGINATION HELPERS */
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
    ),
  ];
}

function disableAllButtons(rows) {
  return rows.map((row) =>
    new ActionRowBuilder().addComponents(
      row.components.map((btn) =>
        ButtonBuilder.from(btn).setDisabled(true)
      )
    )
  );
}

/** UNIVERSAL SHOW LIST */
async function showSafeUserList(ctx) {
  const isInteraction = !!ctx.options || ctx.isButton;
  const userId = isInteraction ? ctx.user.id : ctx.author.id;
  const guild = ctx.guild;
  const settings = (await getSettingsForGuild(guild.id)) || {};
  const safeUsers = settings.safeUsers || [];

  const lines = safeUsers.map((id) => `- <@${id}>`);
  const pages = paginateList(lines);
  let page = 0;

  const embed = new EmbedBuilder()
    .setTitle("Safe Users")
    .setDescription(pages[0]?.join("\n") || "*No safe users set.*")
    .setFooter({ text: `Page 1 of ${pages.length}` });

  const initialComponents =
    pages.length > 1 ? buildNavButtons(0, pages.length, userId) : [];

  let msg;
  if (isInteraction) {
    if (ctx.replied || ctx.deferred) {
      msg = await ctx.editReply({
        embeds: [embed],
        components: initialComponents,
        fetchReply: true,
      });
    } else {
      msg = await ctx.reply({
        embeds: [embed],
        components: initialComponents,
        fetchReply: true,
        ephemeral: false,
      });
    }
  } else {
    msg = await ctx.channel.send({
      embeds: [embed],
      components: initialComponents,
    });
  }

  if (pages.length <= 1) return;

  const coll = msg.createMessageComponentCollector({
    filter: (i) =>
      i.customId.startsWith("safeUserList:") && i.user.id === userId,
    time: 3 * 60 * 1000,
  });

  coll.on("collect", async (i) => {
    const [, action] = i.customId.split(":");
    if (action === "prev") page = Math.max(page - 1, 0);
    else if (action === "next") page = Math.min(page + 1, pages.length - 1);
    else if (action === "first") page = 0;
    else if (action === "last") page = pages.length - 1;

    const updated = EmbedBuilder.from(embed)
      .setDescription(pages[page].join("\n") || "*No safe users set.*")
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

/** MESSAGE-BASED safeuser */
async function handleSafeUserMessageCommand(message, args) {
  try {
    const settings = (await getSettingsForGuild(message.guild.id)) || {};
    const isMod = message.member.roles.cache.has(settings.moderatorRoleId);
    const isAdmin =
      message.guild.ownerId === message.member.id ||
      message.member.roles.cache.has(settings.adminRoleId);
    if (!isMod && !isAdmin) {
      return message.channel.send(
        "> <❌> You do not have permission to manage safe users. (CMD_ERR_008)"
      );
    }

    const subCmd = args[0]?.toLowerCase();
    const guildId = message.guild.id;
    switch (subCmd) {
      case "list":
        return showSafeUserList(message);
      case "add": {
        if (!args[1]) {
          return message.channel.send(
            "> <❌> Usage: `>safeuser add @UserOrID`"
          );
        }
        const userId = args[1].replace(/[<@!>]/g, "");
        const arr = settings.safeUsers || [];
        if (arr.includes(userId)) {
          return message.channel.send(
            "> <❇️> **That user is already marked safe.**"
          );
        }
        arr.push(userId);
        await updateSettingsForGuild(guildId, { safeUsers: arr }, message.guild);
        return message.channel.send(
          `> <✅> Marked <@${userId}> as safe. They will no longer be filtered or transcribed.`
        );
      }
      case "remove": {
        if (!args[1]) {
          return message.channel.send(
            "> <❌> Usage: `>safeuser remove @UserOrID`"
          );
        }
        const userId = args[1].replace(/[<@!>]/g, "");
        const arr = settings.safeUsers || [];
        const newArr = arr.filter((id) => id !== userId);
        if (newArr.length === arr.length) {
          return message.channel.send("> <❌> That user was not marked safe.");
        }
        await updateSettingsForGuild(
          guildId,
          { safeUsers: newArr },
          message.guild
        );
        return message.channel.send(
          `> <✅> Removed <@${userId}> from safe users.`
        );
      }
      default:
        return message.channel.send(
          "> <❌> Unknown subcommand. Use `>safeuser list|add|remove`."
        );
    }
  } catch (error) {
    console.error(`[ERROR] handleSafeUserMessageCommand: ${error.message}`);
    message.channel.send(
      "> <❌> An error occurred managing safe users. Check logs."
    );
  }
}

/** SLASH-BASED safeuser */
async function handlesafeUserslashCommand(interaction) {
  try {
    if (!interaction.memberPermissions.has(requiredManagerPermissions)) {
      return interaction.reply({
        content: "> <❌> You lack permission to manage safe users.",
        ephemeral: true,
      });
    }

    const subCmd = interaction.options.getSubcommand(true);
    const guildId = interaction.guild.id;
    switch (subCmd) {
      case "list":
        return showSafeUserList(interaction);
      case "add": {
        const user = interaction.options.getUser("user", true);
        const settings = await getSettingsForGuild(guildId);
        const arr = settings.safeUsers || [];
        if (arr.includes(user.id)) {
          return interaction.reply({
            content: "> <❇️> That user is already marked safe.",
            ephemeral: true,
          });
        }
        arr.push(user.id);
        await updateSettingsForGuild(guildId, { safeUsers: arr }, interaction.guild);
        return interaction.reply({
          content: `> <✅> Marked <@${user.id}> as safe.`,
          ephemeral: false,
        });
      }
      case "remove": {
        const user = interaction.options.getUser("user", true);
        const settings = await getSettingsForGuild(guildId);
        const arr = settings.safeUsers || [];
        const newArr = arr.filter((id) => id !== user.id);
        if (newArr.length === arr.length) {
          return interaction.reply({
            content: "> <❇️> That user was not marked safe.",
            ephemeral: true,
          });
        }
        await updateSettingsForGuild(
          guildId,
          { safeUsers: newArr },
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
  showSafeUserList,
  handleSafeUserMessageCommand,
  handlesafeUserslashCommand,
};