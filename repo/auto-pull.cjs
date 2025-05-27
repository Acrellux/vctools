// =============================
// VC Tools auto-pull.cjs (with ANSI Update Log)
// =============================

const fs = require("fs");
const path = require("path");
const { exec, spawn } = require("child_process");
const { Client, GatewayIntentBits } = require("discord.js");
require("dotenv").config();

const repoPath = path.resolve(__dirname);
const botPath = `${repoPath}/index.cjs`;
const lockFile = `${repoPath}/vc_tools.lock`;
let botProcess = null;

process.title = "VC_TOOLS_AUTO_PULL";

// =============================
// Send Styled Update Log
// =============================
async function sendUpdateLog(version) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  try {
    await client.login(process.env.DISCORD_TOKEN);
    const channel = await client.channels.fetch("1356838107818885151");
    if (!channel || !channel.send) return;

    const ansi = {
      darkGray: '\u001b[2;30m',
      lightGray: '\u001b[2;37m',
      blue: '\u001b[2;34m',
      cyan: '\u001b[36m',
      reset: '\u001b[0m',
    };

    const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });
    const unix = `<t:${Math.floor(Date.now() / 1000)}:F>`;

    await channel.send(
      "```ansi\n" +
      `${ansi.darkGray}[${ansi.blue}${timestamp}${ansi.darkGray}] ` +
      `${ansi.lightGray}The VC Tools repository has just been updated.\n` +
      `${ansi.lightGray}Version ID${ansi.darkGray}: ${ansi.cyan}${version}\n` +
      `${ansi.darkGray}VC Tools will now restart.${ansi.reset}\n` +
      "```"
    );

    console.log(`[INFO] Update log for version ${version} sent.`);
  } catch (err) {
    console.error("[BOT LOGGER] Failed to send update log:", err.message);
  } finally {
    await client.destroy();
  }
}

// =============================
// Lock Protection
// =============================
if (fs.existsSync(lockFile)) {
  console.log("[AUTO-PULL] Already running. Exiting.");
  process.exit(1);
}
fs.writeFileSync(lockFile, String(Date.now()));

function clearLock() {
  if (fs.existsSync(lockFile)) {
    try {
      fs.unlinkSync(lockFile);
      console.log("[AUTO-PULL] Lock file cleared.");
    } catch (e) {
      console.error("[AUTO-PULL] Failed to clear lock file:", e.message);
    }
  }
}

process.on("exit", clearLock);
process.on("SIGINT", () => {
  clearLock();
  process.exit();
});
process.on("SIGTERM", () => {
  clearLock();
  process.exit();
});
process.on("uncaughtException", (err) => {
  console.error("[AUTO-PULL] Uncaught Exception:", err);
  clearLock();
  process.exit(1);
});

// =============================
// Kill old VC Tools bot on startup
// =============================
exec('tasklist | findstr node', (err, stdout) => {
  if (stdout.includes("index.cjs")) {
    console.log("[BOOT] Killing leftover index.cjs process...");
    exec('wmic process where "CommandLine like \'%index.cjs%\'" call terminate', (err2) => {
      if (err2) {
        console.error("[BOOT] Failed to kill old VC Tools instance:", err2.message);
      } else {
        console.log("[BOOT] Old VC Tools instance terminated.");
      }
    });
  }
});

// =============================
// Crash Recovery Config
// =============================
let crashCount = 0;
let lastCrashTime = 0;
const MAX_CRASHES = 5;
const CRASH_WINDOW_MS = 2 * 60 * 1000;
const MAX_TIMEOUT_MS = 30000;

// =============================
// Start the Bot
// =============================
function startBot() {
  if (botProcess) return;
  console.log("[BOT] Starting VC Tools...");

  const now = Date.now();
  if (now - lastCrashTime > CRASH_WINDOW_MS) {
    crashCount = 0;
  }

  botProcess = spawn("node", [botPath], {
    cwd: repoPath,
    stdio: "inherit",
  });

  botProcess.on("exit", (code) => {
    botProcess = null;
    lastCrashTime = Date.now();
    crashCount++;

    if (crashCount > MAX_CRASHES) {
      console.error("[BOT] Too many crashes in a short time. Not restarting.");
      return;
    }

    const timeout = Math.min(3000 * crashCount, MAX_TIMEOUT_MS);
    console.log(`[BOT] VC Tools exited (code ${code}). Restarting in ${timeout / 1000}s...`);
    setTimeout(startBot, timeout);
  });
}

// =============================
// Git Auto-Pull Every 2.5 Minutes
// =============================
function stopBot() {
  if (botProcess) {
    botProcess.kill();
    botProcess = null;
    console.log("[BOT] Process killed.");
  }
}

function pullRepo() {
  console.log("[GIT] Pulling...");
  exec(`git -C "${repoPath}" pull`, (err, stdout) => {
    if (err) return console.error("[GIT ERROR]", err.message);

    if (stdout.includes("Updating") || stdout.includes("Fast-forward")) {
      const match = stdout.match(/Updating (\w+)\.\.(\w+)/);
      const newVersion = match ? match[2] : "unknown";

      console.log("[GIT] Changes found. Restarting bot...");
      sendUpdateLog(newVersion);

      stopBot();
      setTimeout(startBot, 1500);
    } else {
      console.log("[GIT] No changes.");
    }
  });
}

setTimeout(startBot, 2000);
setInterval(pullRepo, 2.5 * 60 * 1000);