/// node ./util/clear_dms.js <userid>

const { Client, GatewayIntentBits } = require("discord.js");
require("dotenv").config();

const client = new Client({
  intents: [
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const userId = process.argv[2]; // Get user ID from command line argument

if (!userId) {
  console.error("❌ Please provide a user ID.");
  process.exit(1);
}

client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  
  try {
    const user = await client.users.fetch(userId);
    const dmChannel = await user.createDM();

    let messages = await dmChannel.messages.fetch({ limit: 100 });

    while (messages.size > 0) {
      const botMessages = messages.filter((msg) => msg.author.id === client.user.id);
      
      for (const msg of botMessages.values()) {
        await msg.delete().catch((err) => console.error(`❌ Failed to delete message: ${err.message}`));
      }
      
      console.log(`✅ Deleted ${botMessages.size} messages. Fetching more...`);
      messages = await dmChannel.messages.fetch({ limit: 100 });
    }

    console.log("✅ All bot messages deleted from the DM!");
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
  } finally {
    client.destroy();
  }
});

client.login(process.env.DISCORD_TOKEN);
