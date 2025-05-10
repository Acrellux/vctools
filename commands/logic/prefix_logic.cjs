// commands/logic/prefix_logic.cjs
const { Message, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { getSettingsForGuild, updateSettingsForGuild } = require("../settings.cjs");
const { logErrorToChannel, requiredManagerPermissions } = require("./helpers.cjs");

/**
 * Renders the Prefix Settings UI.
 */
async function showPrefixSettingsUI(interactionOrMessage, isEphemeral = false) {
    try {
        const guild = interactionOrMessage.guild;
        if (!guild) return;

        // Permission check
        const member = interactionOrMessage.member;
        if (!member.permissions.has(requiredManagerPermissions)) {
            const reply = "> <❌> You need higher permissions to do that.";
            if (interactionOrMessage instanceof Message) {
                return interactionOrMessage.channel.send(reply);
            } else {
                return interactionOrMessage.reply({ content: reply, ephemeral: true });
            }
        }

        // Load and normalize current prefixes (default all enabled)
        const settings = (await getSettingsForGuild(guild.id)) || {};
        const raw = settings.prefixes || {};
        const prefixes = {
            slash: raw.slash ?? true,
            greater: raw.greater ?? raw[">"] ?? true,
            exclamation: raw.exclamation ?? raw["!"] ?? true,
        };

        const userId = interactionOrMessage.user?.id || interactionOrMessage.author?.id;

        // Build toggle buttons (just the symbol + on/off)
        const btnSlash = new ButtonBuilder()
            .setCustomId(`prefix:toggle:slash:${userId}`)
            .setLabel(`/ (${prefixes.slash ? "currently on" : "currently off"})`)
            .setStyle(prefixes.slash ? ButtonStyle.Success : ButtonStyle.Danger);

        const btnGreater = new ButtonBuilder()
            .setCustomId(`prefix:toggle:greater:${userId}`)
            .setLabel(`> (${prefixes.greater ? "currently on" : "currently off"})`)
            .setStyle(prefixes.greater ? ButtonStyle.Success : ButtonStyle.Danger);

        const btnExcl = new ButtonBuilder()
            .setCustomId(`prefix:toggle:exclamation:${userId}`)
            .setLabel(`! (${prefixes.exclamation ? "currently on" : "currently off"})`)
            .setStyle(prefixes.exclamation ? ButtonStyle.Success : ButtonStyle.Danger);

        const row = new ActionRowBuilder().addComponents(btnSlash, btnGreater, btnExcl);

        // Send or update reply
        const payload = {
            content: "## ◈ **Prefix Settings**",
            components: [row],
            ephemeral: isEphemeral,
        };

        if (interactionOrMessage.reply) {
            // Interaction
            if (interactionOrMessage.replied || interactionOrMessage.deferred) {
                await interactionOrMessage.editReply(payload);
            } else {
                await interactionOrMessage.reply(payload);
            }
        } else {
            // Message
            await interactionOrMessage.channel.send(payload);
        }

    } catch (err) {
        console.error("[ERROR] showPrefixSettingsUI:", err);
        await logErrorToChannel(
            interactionOrMessage.guild?.id,
            err.stack,
            interactionOrMessage.client,
            "showPrefixSettingsUI"
        );
    }
}

/**
 * Handles clicks on prefix-toggle buttons.
 */
async function handlePrefixSettingsFlow(interaction) {
    try {
        const [, , prefixType, userId] = interaction.customId.split(":");
        if (interaction.user.id !== userId) {
            return interaction.reply({ content: "> <❌> You cannot interact with this.", ephemeral: true });
        }

        // Load and normalize current prefixes
        const guildId = interaction.guild.id;
        const settings = (await getSettingsForGuild(guildId)) || {};
        const raw = settings.prefixes || {};
        const prefixes = {
            slash: raw.slash ?? true,
            greater: raw.greater ?? raw[">"] ?? true,
            exclamation: raw.exclamation ?? raw["!"] ?? true,
        };

        // flip the chosen one
        prefixes[prefixType] = !prefixes[prefixType];

        // write back into DB under normalized keys
        await updateSettingsForGuild(guildId, { prefixes }, interaction.guild);

        // re-render UI + confirmation
        await interaction.deferUpdate();
        await showPrefixSettingsUI(interaction, true);

        const symbol = { slash: "/", greater: ">", exclamation: "!" }[prefixType];
        await interaction.followUp({
            content: `> <⚙️> The **${symbol}** prefix is now **${prefixes[prefixType] ? "enabled" : "disabled"}**.`,
            ephemeral: false,
        });

    } catch (err) {
        console.error("[ERROR] handlePrefixSettingsFlow:", err);
        await logErrorToChannel(
            interaction.guild?.id,
            err.stack,
            interaction.client,
            "handlePrefixSettingsFlow"
        );
    }
}

module.exports = {
    showPrefixSettingsUI,
    handlePrefixSettingsFlow,
};
