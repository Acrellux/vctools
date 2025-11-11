// drain_logic.cjs

const { getSettingsForGuild } = require("../settings.cjs"); // Your settings helper

async function handleDrainSlashCommand(interaction) {
    try {
        if (!interaction.member.permissions.has("MoveMembers")) {
            return await interaction.reply({
                content: "> <❇️> You don't have permission to drain voice channels.",
                ephemeral: false,
            });
        }

        const channel = interaction.options.getChannel('channel');
        if (!channel || channel.type !== 2) {
            return await interaction.reply({
                content: "> <⚠️> You must select a valid voice channel.",
                ephemeral: false,
            });
        }

        await drainChannel(interaction, channel);
    } catch (error) {
        console.error(`[ERROR] handleDrainSlashCommand failed: ${error.message}`);
        if (!interaction.replied) {
            await interaction.reply({
                content: "> <❌> An error occurred draining the voice channel.",
                ephemeral: false,
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
        const guild = channel.guild;
        const settings = await getSettingsForGuild(guild.id);
        const logChannelId = settings?.vcLoggingChannelId;
        if (logChannelId) {
            const logChannel = await guild.channels.fetch(logChannelId).catch(() => null);
            if (logChannel) {
                const now = new Date();
                const timestamp = now.toLocaleTimeString("en-US", {
                    minute: "2-digit",
                    second: "2-digit",
                    hour12: false,
                });

                const bracket = "\u001b[2;30m"; // Dark gray
                const white = "\u001b[2;37m";
                const red = "\u001b[2;31m";
                const blue = "\u001b[2;34m";
                const yellow = "\u001b[2;33m";
                const messageGray = "\u001b[2;37m";
                const reset = "\u001b[0m";

                // Fetch mod info safely
                const modMember = await guild.members.fetch(context.user?.id || context.member?.user?.id).catch(() => null);
                const modTag = modMember?.user?.tag || "Unknown Moderator";
                const modId = modMember?.id || "UnknownID";
                const modName = modMember?.displayName || modTag.split("#")[0];

                // Decide role + color
                let roleName = "Member";
                let roleColor = white;
                if (guild.ownerId === modId) {
                    roleName = "Creator";
                    roleColor = red;
                } else if (modMember?.permissions.has("Administrator")) {
                    roleName = "Admin";
                    roleColor = blue;
                } else if (
                    modMember?.permissions.has("ManageGuild") ||
                    modMember?.permissions.has("KickMembers") ||
                    modMember?.permissions.has("MuteMembers") ||
                    modMember?.permissions.has("BanMembers") ||
                    modMember?.permissions.has("ManageMessages")
                ) {
                    roleName = "Mod";
                    roleColor = yellow;
                }

                const vcName = channel.name || "Unknown VC";
                // --- Invisible spacer + helpers ---
                const SPACE = "\u200A";                      // switch to "\u200B" if you want true zero-width
                const c = (color) => `${color}${SPACE}`; // append SPACE after each color escape
                const br = (inner) => `[${SPACE}${inner}${SPACE}]${SPACE}`;
                const safe = (s) => String(s).replace(/</g, `<${SPACE}`);

                // logMessage (timestamp, role, mod id, mod name, channel)
                const logMessage = `\`\`\`ansi
${c(ansi.darkGray)}${br(`${c(white)}${timestamp}${c(ansi.darkGray)}`)}${br(`${c(roleColor)}${safe(roleName)}${c(ansi.darkGray)}`)}${br(`${c(white)}${safe(modId)}${c(ansi.darkGray)}`)} ${c(roleColor)}${safe(modName)}${c(ansi.darkGray)} drained ${br(`🔊${c(white)}${safe(vcName)}${c(ansi.darkGray)}`)}${c(reset)}
\`\`\``;

                await logChannel.send(logMessage).catch(console.error);
            }
        }
    } catch (error) {
        console.error("[VC LOGGING ERROR]", error);
    }
}

module.exports = { handleDrainSlashCommand, handleDrainMessageCommand };
