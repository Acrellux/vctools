// drain_logic.cjs

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

        const channelId = args[0].replace(/[<#>]/g, ""); // remove <#id> if mentioned
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
    if (members.size === 0) {
        return await (context.reply || context.channel.send).call(context, {
            content: `> <⚠️> There are no users to drain in **${channel.name}**.`,
            ephemeral: context.isCommand?.() ? true : undefined,
        });
    }

    let failures = [];

    for (const [id, member] of members) {
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
        content: `> <✅> Drained **${members.size}** users from **${channel.name}**.`,
        ephemeral: context.isCommand?.() ? false : undefined,
    });
}

module.exports = { handleDrainSlashCommand, handleDrainMessageCommand };
