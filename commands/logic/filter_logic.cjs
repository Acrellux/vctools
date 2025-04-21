const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const {
  getSettingsForGuild,
  updateSettingsForGuild,
} = require("../settings.cjs");

/**
 * Display the filter settings UI.
 *
 * @param {Interaction} interaction - The interaction instance.
 */
async function showFilterSettingsUI(interaction) {
  const guild = interaction.guild;
  if (!guild) return;

  const settings = await getSettingsForGuild(guild.id);
  const filterLevel = settings.filterLevel || "moderate";

  // Simple text output instead of an embed
  const contentMessage = `## **Filter Settings**
  > **Filter Level:** \`${filterLevel}\`
  
  - \`settings filter add <word>\` – Add a word.
  - \`settings filter remove <word>\` – Remove a word.
  - \`settings filter list\` – List custom words.
  - \`settings filter level <moderate|strict>\` – Set filter level.
  `;

  await interaction.channel.send({
    content: contentMessage,
    ephemeral: false,
  });
}

/**
 * Handle slash commands for the filter subcommands (add, remove, list).
 *
 * @param {Interaction} interaction - The slash command interaction.
 */
async function handleFilterCommand(interaction) {
  const guild = interaction.guild;
  if (!guild) return;

  const subcommand = interaction.options.getSubcommand();
  const settings = await getSettingsForGuild(guild.id);
  const currentCustom = settings.filterCustom || [];

  if (subcommand === "add") {
    const word = interaction.options.getString("word").toLowerCase();
    if (currentCustom.includes(word)) {
      return interaction.reply({
        content: "<❇️> That word is already in the filter.",
        ephemeral: true,
      });
    }
    currentCustom.push(word);
    await updateSettingsForGuild(
      guild.id,
      { filterCustom: currentCustom },
      guild
    );
    await interaction.reply({
      content: `<✅> **Added \`${word}\` to the filter.**`,
      ephemeral: false,
    });
  } else if (subcommand === "remove") {
    const word = interaction.options.getString("word").toLowerCase();
    const newCustom = currentCustom.filter((w) => w !== word);
    if (newCustom.length === currentCustom.length) {
      return interaction.reply({
        content: "<❇️> That word was not in the filter.",
        ephemeral: true,
      });
    }
    await updateSettingsForGuild(guild.id, { filterCustom: newCustom }, guild);
    await interaction.reply({
      content: `<✅> **Removed \`${word}\` from the filter.**`,
      ephemeral: false,
    });
  } else if (subcommand === "list") {
    const listText =
      currentCustom.length > 0
        ? currentCustom.join(", ")
        : "_No words added yet._";
    await interaction.reply({
      content: `**Filtered Words:**\n${listText}`,
      ephemeral: false,
    });
  } else if (subcommand === "level") {
    const level = interaction.options.getString("level").toLowerCase();
    if (!["moderate", "strict"].includes(level)) {
      return interaction.reply({
        content: "<❌> Invalid level. Choose `moderate` or `strict`.",
        ephemeral: true,
      });
    }

    await updateSettingsForGuild(guild.id, { filterLevel: level }, guild);
    await interaction.reply({
      content: `<✅> **Filter level set to \`${level}\`.**`,
      ephemeral: false,
    });
  }
}

module.exports = {
  showFilterSettingsUI,
  handleFilterCommand,
};
