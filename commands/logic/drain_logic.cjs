// drain_logic.cjs

const { getSettingsForGuild } = require("../settings.cjs"); // Your settings helper

// Correct faint ANSI colors (not bold!)
const ansi = {
    reset: "\u001b[0m",
    white: "\u001b[2;37m",
    darkGray: "\u001b[2;30m",
    yellow: "\u001b[2;33m",
};

async function handleDrainSlashCommand(interaction) {
    try {
        if (!interaction.member.permissions.has("MoveMembers")) {
            return await interaction.reply({
                content: "> <❇️> You don't have permission to drain voice channels.",
                ephemeral: true,
            });
        }

        const channel = interaction.options.getChannel('channel');
        if (!channel || channel.type !== 2) {
            return await interaction.reply({
                content: "> <⚠️> You must select a valid voice channel.",
                ephemeral: true,
            });
        }

        await drainChannel(interaction, channel);
    } catch (error) {
        console.error(`[ERROR] handleDrainSlashCommand failed: ${error.message}`);
        if (!interaction.replied) {
            await interaction.reply({
                content: "> <❌> An error occurred draining the voice channel.",
                ephemeral: true,
            });
        }
    }
}

async function handleDrainMessageCommand(message, args) {
    try {
        if (!message.member.permissions.has("MoveMembers")) {
            return await message.reply("> <❇️> You don't have permission to drain voice channels.");
        }

        if (args.length === 0) {
            return await message.reply("> <⚠️> Please mention a voice channel or provide a channel ID.");
        }

        const channelId = args[0].replace(/[<#>]/g, "");
        const channel = await message.guild.channels.fetch(channelId).catch(() => null);

        if (!channel || channel.type !== 2) {
            return await message.reply("> <⚠️> That is not a valid voice channel.");
        }

        await drainChannel(message, channel);
    } catch (error) {
        console.error(`[ERROR] handleDrainMessageCommand failed: ${error.message}`);
        await message.reply("> <❌> An error occurred draining the voice channel.");
    }
}

async function drainChannel(context, channel) {
    const members = channel.members;
    const vcToolsId = context.client.user.id;

    const membersToDrain = [...members.values()].filter(member => member.id !== vcToolsId);

    if (membersToDrain.length === 0) {
        return await (context.reply || context.channel.send).call(context, {
            content: `> <❇️> <#${channel.id}> is already empty.`,
            ephemeral: context.isCommand?.() ? true : undefined,
        });
    }

    let failures = [];

    for (const member of membersToDrain) {
        try {
            await member.voice.disconnect("Voice channel drained by command.");
        } catch (error) {
            failures.push(member.user.tag);
        }
    }

    if (failures.length > 0) {
        return await (context.reply || context.channel.send).call(context, {
            content: `> <⚠️> Some users could not be disconnected: ${failures.join(", ")}`,
            ephemeral: context.isCommand?.() ? true : undefined,
        });
    }

    await (context.reply || context.channel.send).call(context, {
        content: `> <✅> Drained **${membersToDrain.length}** users from <#${channel.id}>.`,
        ephemeral: context.isCommand?.() ? false : undefined,
    });

    // ─── VC Logging Notification ─────────────────────────────────────
    try {
        const settings = await getSettingsForGuild(channel.guild.id);
        const logChannelId = settings?.vcLoggingChannelId;
        if (logChannelId) {
            const logChannel = await channel.guild.channels.fetch(logChannelId).catch(() => null);
            if (logChannel) {
                const now = new Date();
                const minute = now.getMinutes().toString().padStart(2, "0");
                const second = now.getSeconds().toString().padStart(2, "0");
                const timestamp = `${minute}:${second}`;

                const buildLog = (msg) => {
                    return `\`\`\`ansi\n${ansi.darkGray}[${ansi.white}${timestamp}${ansi.darkGray}] ${msg}${ansi.reset}\n\`\`\``;
                };

                const modTag = context.member?.user.tag || "Unknown Moderator";
                const modId = context.member?.user.id || "UnknownID";
                const channelName = channel.name || "Unknown Channel";

                const logMsg = `${ansi.yellow}[MOD${ansi.darkGray}] [${ansi.white}${modId}${ansi.darkGray}] ${ansi.yellow}${modTag}${ansi.darkGray} drained ${ansi.white}${channelName}${ansi.darkGray}.`;

                await logChannel.send(buildLog(logMsg)).catch(console.error);
            }
        }
    } catch (error) {
        console.error("[VC LOGGING ERROR]", error);
    }
}

module.exports = { handleDrainSlashCommand, handleDrainMessageCommand };
