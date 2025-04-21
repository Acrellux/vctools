const { REST, Routes } = require('discord.js');
const dotenv = require('dotenv');
dotenv.config();

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
    try {
        console.log('[INFO] Deleting all application (/) commands.');

        // Delete global commands
        const globalCommands = await rest.get(Routes.applicationCommands(process.env.CLIENT_ID));
        if (globalCommands.length > 0) {
            console.log(`[INFO] Found ${globalCommands.length} global commands. Deleting...`);
            for (const command of globalCommands) {
                await rest.delete(`${Routes.applicationCommands(process.env.CLIENT_ID)}/${command.id}`);
                console.log(`[INFO] Deleted global command: ${command.name}`);
            }
        } else {
            console.log('[INFO] No global commands to delete.');
        }

        // Delete commands from all guilds
        console.log('[INFO] Fetching guild-specific commands...');
        const guildIds = (await rest.get(Routes.userGuilds())).map((guild) => guild.id);
        for (const guildId of guildIds) {
            const guildCommands = await rest.get(Routes.applicationGuildCommands(process.env.CLIENT_ID, guildId));
            if (guildCommands.length > 0) {
                console.log(`[INFO] Found ${guildCommands.length} commands in guild ${guildId}. Deleting...`);
                for (const command of guildCommands) {
                    await rest.delete(`${Routes.applicationGuildCommands(process.env.CLIENT_ID, guildId)}/${command.id}`);
                    console.log(`[INFO] Deleted guild command: ${command.name}`);
                }
            } else {
                console.log(`[INFO] No commands to delete in guild ${guildId}.`);
            }
        }

        console.log('[INFO] Successfully deleted all application (/) commands.');
    } catch (error) {
        console.error('[ERROR] Failed to delete commands:', error);
    }
})();
