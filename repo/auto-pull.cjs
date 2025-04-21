// =============================
// VC Tools auto-pull.cjs (Final Version with Console Output)
// =============================

const fs = require("fs");
const { exec, spawn } = require("child_process");

const repoPath = "C:/Users/AcidR/Desktop/VC_Tools";
const botPath = `${repoPath}/index.cjs`;
const lockFile = `${repoPath}/vc_tools.lock`;
let botProcess = null;

process.title = "VC_TOOLS_AUTO_PULL";

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
const CRASH_WINDOW_MS = 2 * 60 * 1000; // 2 minutes
const MAX_TIMEOUT_MS = 30000;

// =============================
// Start the Bot (using spawn for visible logs)
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
      console.log("[GIT] Changes found. Restarting bot...");
      stopBot();
      setTimeout(startBot, 1500);
    } else {
      console.log("[GIT] No changes.");
    }
  });
}

// Delay slightly to ensure old processes are killed
setTimeout(startBot, 2000);
setInterval(pullRepo, 2.5 * 60 * 1000);