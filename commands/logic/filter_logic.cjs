// logic/filter_logic.cjs

const { Message, Interaction } = require("discord.js");
const {
  getSettingsForGuild,
  updateSettingsForGuild,
} = require("../settings.cjs");
const { requiredManagerPermissions } = require("./helpers.cjs");

// ── Permission helpers ─────────────────────────────────────────────
const DENY_COMPONENT = "> <❌> You cannot interact with this component. (CMD_ERR_008)";
const DENY_MESSAGE   = "> <❌> You don’t have permission to use this.";

async function ensureManagerAuth(ctx) {
  try {
    const ok = await requiredManagerPermissions(ctx);
    if (ok) return true;

    // Interactions (slash/buttons/selects) → ephemeral denial
    if (ctx?.isRepliable?.()) {
      if (ctx.replied || ctx.deferred) {
        await ctx.followUp({ content: DENY_COMPONENT, ephemeral: true }).catch(() => {});
      } else {
        await ctx.reply({ content: DENY_COMPONENT, ephemeral: true }).catch(() => {});
      }
      return false;
    }

    // Fallback (message command) → public, short denial
    if (ctx?.channel?.send) {
      await ctx.channel.send(DENY_MESSAGE).catch(() => {});
    }
  } catch {
    // If something goes sideways, fail closed (don’t show UI)
  }
  return false;
}

// ── UI ─────────────────────────────────────────────────────────────
/**
 * Show >settings filter or /settings filter UI.
 */
async function showFilterSettingsUI(interactionOrMessage, isEphemeral = false) {
  const guild = interactionOrMessage.guild;
  if (!guild) return;

  // Gate: only managers/mods/admins may view this UI
  const allowed = await ensureManagerAuth(interactionOrMessage);
  if (!allowed) return;

  const settings = await getSettingsForGuild(guild.id);
  const filterLevel = settings.filterLevel || "moderate";

  const contentMessage = `## **Filter Settings**
> **Filter Level:** \`${filterLevel}\`

Use the buttons or slash subcommands to manage your filter:
• \`/filter add <word>\`  
• \`/filter remove <word>\`  
• \`/filter list\`  
• \`/filter level <moderate|strict|build>\``;

  // If this was a button interaction, update in place
  if (interactionOrMessage.isButton?.()) {
    return interactionOrMessage.update({
      content: contentMessage,
      components: [], // no interactive components here
      ephemeral: isEphemeral,
    });
  }

  // Otherwise reply or send
  if (interactionOrMessage.isRepliable?.()) {
    if (interactionOrMessage.replied || interactionOrMessage.deferred) {
      return interactionOrMessage.editReply({
        content: contentMessage,
        ephemeral: isEphemeral,
      });
    } else {
      return interactionOrMessage.reply({
        content: contentMessage,
        ephemeral: isEphemeral,
      });
    }
  }

  return interactionOrMessage.channel.send({
    content: contentMessage,
  });
}

// ── Message Command ────────────────────────────────────────────────
/**
 * Handle top‐level “>filter” message command.
 */
async function handleFilterMessageCommand(message, args) {
  const guild = message.guild;
  if (!guild) return;

  // Gate
  const allowed = await ensureManagerAuth(message);
  if (!allowed) return;

  // If no subcommand, show the UI
  const sub = args[0]?.toLowerCase();
  if (!sub || !["add", "remove", "list", "level"].includes(sub)) {
    return showFilterSettingsUI(message, false);
  }

  const settings = await getSettingsForGuild(guild.id);
  const currentCustom = settings.filterCustom || [];

  if (sub === "add") {
    const word = args[1]?.toLowerCase();
    if (!word) {
      return message.channel.send("> <❌> Usage: `>filter add <word>`");
    }
    if (currentCustom.includes(word)) {
      return message.channel.send("> <❇️> That word is already filtered.");
    }
    currentCustom.push(word);
    await updateSettingsForGuild(guild.id, { filterCustom: currentCustom }, guild);
    return message.channel.send(`> <✅> Added \`${word}\` to filter.`);
  }

  if (sub === "remove") {
    const word = args[1]?.toLowerCase();
    if (!word) {
      return message.channel.send("> <❌> Usage: `>filter remove <word>`");
    }
    const newList = currentCustom.filter((w) => w !== word);
    if (newList.length === currentCustom.length) {
      return message.channel.send("> <❇️> That word wasn’t in the filter.");
    }
    await updateSettingsForGuild(guild.id, { filterCustom: newList }, guild);
    return message.channel.send(`> <✅> Removed \`${word}\`.`);
  }

  if (sub === "list") {
    const listText = currentCustom.length
      ? currentCustom.join(", ")
      : "_No words filtered yet._";
    return message.channel.send(`**Filtered Words:**\n${listText}`);
  }

  if (sub === "level") {
    const lvl = args[1]?.toLowerCase();
    if (!["moderate", "strict", "build"].includes(lvl)) {
      return message.channel.send("> <❌> Level must be `moderate`, `strict`, or `build`.");
    }
    await updateSettingsForGuild(guild.id, { filterLevel: lvl }, guild);
    return message.channel.send(`> <✅> Filter level set to \`${lvl}\`.`);
  }
}

// ── Slash Command ─────────────────────────────────────────────────
/**
 * Handle “/filter” slash command.
 */
async function handleFilterSlashCommand(interaction) {
  const guild = interaction.guild;
  if (!guild) return;

  // Gate
  const allowed = await ensureManagerAuth(interaction);
  if (!allowed) return;

  const sub = interaction.options.getSubcommand();
  const settings = await getSettingsForGuild(guild.id);
  const currentCustom = settings.filterCustom || [];

  if (sub === "add") {
    const word = interaction.options.getString("word").toLowerCase();
    if (currentCustom.includes(word)) {
      return interaction.reply({ content: "<❇️> Already filtered.", ephemeral: true });
    }
    currentCustom.push(word);
    await updateSettingsForGuild(guild.id, { filterCustom: currentCustom }, guild);
    return interaction.reply({ content: `<✅> Added \`${word}\`.`, ephemeral: false });
  }

  if (sub === "remove") {
    const word = interaction.options.getString("word").toLowerCase();
    const newList = currentCustom.filter((w) => w !== word);
    if (newList.length === currentCustom.length) {
      return interaction.reply({ content: "<❇️> Word not found.", ephemeral: true });
    }
    await updateSettingsForGuild(guild.id, { filterCustom: newList }, guild);
    return interaction.reply({ content: `<✅> Removed \`${word}\`.`, ephemeral: false });
  }

  if (sub === "list") {
    const listText = currentCustom.length ? currentCustom.join(", ") : "_None yet._";
    return interaction.reply({ content: `**Filtered Words:**\n${listText}`, ephemeral: false });
  }

  if (sub === "level") {
    const lvl = interaction.options.getString("level").toLowerCase();
    if (!["moderate", "strict", "build"].includes(lvl)) {
      return interaction.reply({ content: "<❌> Invalid level.", ephemeral: true });
    }
    await updateSettingsForGuild(guild.id, { filterLevel: lvl }, guild);
    return interaction.reply({ content: `<✅> Level set to \`${lvl}\`.`, ephemeral: false });
  }
}

module.exports = {
  showFilterSettingsUI,
  handleFilterMessageCommand,
  handleFilterSlashCommand,
};