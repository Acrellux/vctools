// interaction_logic.cjs (hardened)

const { interactionContexts } = require("../../database/contextStore.cjs");
const { logErrorToChannel } = require("./helpers.cjs");
const { handleSettingsFlow } = require("./settings_logic.cjs");
const { handleTranscriptionFlow } = require("../initialization/transcription.cjs");
const { handleErrorLogsFlow } = require("./errorlogs_logic.cjs");
const { handleInitializeFlow } = require("./init_logic.cjs");
const { grantUserConsent } = require("../settings.cjs");
const {
  handleInitializeStaffRoles,
  handleStaffRolesFlow,
} = require("../initialization/staffRoles.cjs");
const { getSettingsForGuild } = require("../settings.cjs");
const { PermissionsBitField } = require("discord.js");

/* =============================
   SAFETY & UTILITIES
============================= */

const requiredManagerPermissions = ["ManageGuild"];

// Prevent duplicate handling of the same interaction (idempotency)
const inflightInteractions = new Set();
// Clean inflight entries after a while to avoid memory creep
const INFLIGHT_TTL_MS = 5 * 60 * 1000;
const inflightExpirations = new Map();

function _markInflight(id) {
  inflightInteractions.add(id);
  const old = inflightExpirations.get(id);
  if (old) clearTimeout(old);
  const t = setTimeout(() => {
    inflightInteractions.delete(id);
    inflightExpirations.delete(id);
  }, INFLIGHT_TTL_MS);
  inflightExpirations.set(id, t);
}

async function safeDeferUpdate(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate();
    }
  } catch (_) { /* noop */ }
}

async function safeReplyEphemeral(interaction, content) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.reply({ content, ephemeral: true });
    } else {
      await interaction.followUp({ content, ephemeral: true });
    }
  } catch (_) { /* noop */ }
}

/** Validate and parse a customId shaped like: "<mode>:<action>:...:<userId>" */
function parseCustomId(customId) {
  if (typeof customId !== "string" || customId.length > 200) return null;
  const parts = customId.split(":");
  if (parts.length < 3) return null;

  const mode = parts[0];
  const action = parts[1];
  const userId = parts[parts.length - 1];

  // Conservative allowlist (letters, digits, underscores, hyphens)
  const ok = /^[a-z0-9_\-]+$/i;
  if (!ok.test(mode) || !ok.test(action) || !/^\d{5,}$/.test(userId)) {
    return null;
  }
  return { mode, action, userId, parts };
}

/** Safe admin check with fallbacks */
function isAdminLike(interaction, settings) {
  try {
    if (!interaction?.guild || !interaction?.member) return false;
    if (interaction.guild.ownerId === interaction.user.id) return true;
    const hasAdminPerm =
      interaction.member.permissions?.has?.(PermissionsBitField.Flags.Administrator);
    if (hasAdminPerm) return true;

    const adminRoleId = settings?.adminRoleId;
    if (adminRoleId && interaction.member.roles?.cache?.has?.(adminRoleId)) return true;
  } catch (_) { /* noop */ }
  return false;
}

/* =============================
   MAIN ROUTER
============================= */

async function handleAllInteractions(interaction) {
  // Guard on basic expectations: these paths only handle component interactions
  if (!interaction || !(interaction.isButton?.() || interaction.isStringSelectMenu?.())) {
    return;
  }

  // Watchdog: ack within 2s to prevent client toast if downstream is slow
  const watchdog = setTimeout(() => safeDeferUpdate(interaction), 2000);

  try {
    // Idempotency: ignore if we are already processing this interaction id
    if (inflightInteractions.has(interaction.id)) return;
    _markInflight(interaction.id);

    const parsed = parseCustomId(interaction.customId);
    if (!parsed) {
      console.warn(`[WARNING] Invalid customId format: ${interaction.customId}`);
      await safeReplyEphemeral(
        interaction,
        "> <❌> That control isn't valid anymore. Please reopen the menu. (INT_ID_FORMAT)"
      );
      return;
    }

    const { mode, action, userId, parts } = parsed;
    console.log(`[DEBUG] Processing interaction: mode=${mode}, action=${action}, user=${userId}`);

    // Ensure the interaction comes from the correct user.
    if (interaction.user.id !== userId) {
      await safeReplyEphemeral(
        interaction,
        "> <❌> You cannot interact with this component. (INT_ERR_004)"
      );
      return;
    }

    // Fetch stored context (may be undefined; we handle that downstream)
    const context = interactionContexts.get(userId);
    // console.debug could be noisy at scale:
    // console.debug(`[DEBUG] Retrieved context for ${userId}:`, context ? JSON.stringify(context) : "none");

    // Handle consent "mode:grant:<userId>" routed through generic flow if present
    if (mode === "consent" && action === "grant") {
      await handleConsentGrant(interaction, userId);
      return;
    }

    // Direct role-selection init screens
    if (mode === "init_admin_role" || mode === "init_moderator_role") {
      await handleInitializeFlow(interaction, mode, action);
      return;
    }

    // Initialization super-mode
    if (mode === "init") {
      const initMethod = context?.initMethod || "ftt";
      try {
        switch (initMethod) {
          case "transcription":
            await handleTranscriptionFlow(interaction, "init", action);
            break;
          case "errorlogs":
            await handleErrorLogsFlow(interaction, "init", action);
            break;
          case "staffroles":
            await handleStaffRolesFlow(interaction, "init", action);
            break;
          case "ftt":
          default:
            await handleInitializeFlow(interaction, "init", action);
            break;
        }
      } catch (err) {
        console.error("[ERROR] init flow router:", err);
        await safeReplyEphemeral(
          interaction,
          "> <❌> Something went wrong handling that step. (INIT_ROUTER_ERR)"
        );
      }
      return;
    }

    // Non-init handlers
    const handlers = {
      settings: handleSettingsFlow,
      bot: handleSettingsFlow,
      vc: handleSettingsFlow,
      transcription: handleTranscriptionFlow,
      errorlogs: handleErrorLogsFlow,
      staffroles: handleStaffRolesFlow,
    };

    if (handlers[mode]) {
      // Extra guard for bot settings: require admin-ish
      if (mode === "bot") {
        const settings = (await getSettingsForGuild(interaction.guild?.id)) || {};
        if (!isAdminLike(interaction, settings)) {
          await safeReplyEphemeral(
            interaction,
            "> <❇️> You do not have permission to interact with Bot Settings. (INT_ERR_004)"
          );
          return;
        }
      }

      // Route to handler; all such handlers should tolerate (interaction, mode, action)
      await handlers[mode](interaction, mode, action);
      return;
    }

    // Fallback: if context says we’re in a role selection step, route accordingly
    if (["init_admin_role", "init_moderator_role"].includes(context?.mode)) {
      await handleInitializeFlow(interaction, context.mode, action);
      return;
    }

    // Unknown mode
    console.log(`[DEBUG] Unexpected mode: ${mode}`);
    await safeReplyEphemeral(interaction, "> <❌> Unexpected mode. (INT_ERR_005)");
  } catch (error) {
    console.error(`[ERROR] handleAllInteractions failed: ${error.message}`);
    try {
      await logErrorToChannel(
        interaction.guild?.id,
        error.stack || String(error),
        interaction.client,
        "handleAllInteractions"
      );
    } catch (_) { /* noop */ }
    await safeReplyEphemeral(
      interaction,
      "> <❌> An error occurred processing your interaction. (INT_ERR_006)"
    );
  } finally {
    clearTimeout(watchdog);
  }
}

/* =============================
   CONSENT HANDLER (hardened)
============================= */

async function handleConsentGrant(interaction, userId) {
  // Acknowledge quickly to avoid UI toast
  const watchdog = setTimeout(() => safeDeferUpdate(interaction), 1500);

  try {
    let guild = interaction.guild;
    const context = interactionContexts.get(userId);

    // Try to recover guild if missing
    if (!guild) {
      const storedId = context?.guildId;
      if (!storedId) {
        console.error(`[ERROR] No stored guild ID for user ${userId}`);
        await safeReplyEphemeral(
          interaction,
          "> <❌> Cannot determine server. Please try the action again from the server."
        );
        return;
      }
      guild = interaction.client.guilds.cache.get(storedId);
      if (!guild) {
        console.error(`[ERROR] Guild ${storedId} not found for user ${userId}`);
        await safeReplyEphemeral(interaction, "> <❌> Error retrieving server info.");
        return;
      }
    }

    // Idempotency: if the button was double-clicked, grantUserConsent should be idempotent on your side.
    try {
      await grantUserConsent(userId, guild);
    } catch (err) {
      console.error("[ERROR] grantUserConsent:", err);
      // We still continue to avoid trapping the user if consent was already granted server-side.
    }

    // Attempt to unmute if user is in a VC; errors are swallowed
    try {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (member?.voice?.channel) {
        await member.voice.setMute(false, "User consented to transcription.").catch(() => { });
      }
    } catch (err) {
      console.error(`[ERROR] Failed to fetch user or unmute: ${err?.message || err}`);
    }

    // Prefer editing the original message if this came from a component; otherwise send a reply/follow-up.
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content:
            `> <✅> You have successfully consented to transcription and can now interact freely inside voice channels.\n` +
            `You can run the \`disallow\` command to revoke consent at any time.`,
          ephemeral: true, // make this ephemeral to avoid public noise
        });
      } else {
        await interaction.followUp({
          content:
            `> <✅> Consent recorded. You can use voice features now.\n` +
            `Run \`disallow\` anytime to revoke.`,
          ephemeral: true,
        });
      }
    } catch (_) { /* noop */ }

    // Cleanup context after consent is granted
    interactionContexts.delete(userId);
  } catch (error) {
    console.error(`[ERROR] handleConsentGrant failed: ${error.message}`);
    try {
      await logErrorToChannel(
        interaction.guild?.id,
        error.stack || String(error),
        interaction.client,
        "handleConsentGrant"
      );
    } catch (_) { /* noop */ }
    await safeReplyEphemeral(
      interaction,
      "> <❌> Failed to record your consent. Please try again."
    );
  } finally {
    clearTimeout(watchdog);
  }
}

module.exports = { handleAllInteractions };