const { exec } = require("child_process");

const ALLOWED_CHANNEL_ID = "1356838107818885151";
const REQUIRED_ROLE_ID = "1339506674909577226";

async function handleRebootCommand(message) {
  if (message.channel.id !== ALLOWED_CHANNEL_ID) {
    return message.reply("> <❌> You can't use this command here.");
  }

  if (!message.member.roles.cache.has(REQUIRED_ROLE_ID)) {
    return message.reply("> <❌> You don't have permission to use this.");
  }

  await message.reply("> <🔄> Rebooting VC Tools...");

  // Optional: Log to console
  console.log(`[REBOOT] Triggered by ${message.author.tag}`);

  // Trigger the bot restart using a batch script
  exec('shutdown /r /t 1', (err) => {
    if (err) {
      console.error("[REBOOT ERROR]", err);
    }
  });
}

module.exports = { handleRebootCommand };