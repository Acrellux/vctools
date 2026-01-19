// commands.cjs

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Message,
  Interaction,
  ComponentType,
  PermissionFlagsBits,
  PermissionsBitField,
} = require("discord.js");

// Import your Supabase-based settings helpers
const {
  getSettingsForGuild,
  updateSettingsForGuild,
  updateChannelPermissionsForGuild,
  grantUserConsent,
  revokeUserConsent,
} = require("./settings.cjs");

// Import your interaction context store and logging helper
const { interactionContexts } = require("../database/contextStore.cjs");
const { logErrorToChannel } = require("./logic/helpers.cjs");

// Import all your command logic modules
const {
  handleSettingsFlow,
  handleSettingsMessageCommand,
  handleSettingsSlashCommand,
} = require("./logic/settings_logic.cjs");
const {
  showTranscriptionSettingsUI,
  handleTranscriptionSettingChange,
} = require("./logic/transcription_logic.cjs");
const { handleTranscriptionFlow } = require("./initialization/transcription.cjs");
const { handleInitializeStaffRoles, handleStaffRolesFlow } = require("./initialization/staffRoles.cjs");
const {
  showErrorLogsSettingsUI,
  handleErrorLogsFlow,
} = require("./logic/errorlogs_logic.cjs");
const {
  handleDrainSlashCommand,
  handleDrainMessageCommand,
} = require("./logic/drain_logic.cjs");
const {
  showVCSettingsUI,
  handleVCSettingsFlow,
} = require("./logic/vc_logic.cjs");
const { handlePrefixSettingsFlow } = require("./logic/prefix_logic.cjs");
const {
  handleVCSlashCommand,
  handleVCMessageCommand,
} = require("./logic/vc_mod_logic.cjs");
const { showBotSettingsUI } = require("./logic/bot_logic.cjs");
const {
  handleInitializeFTT,
  handleInitializeErrorLogs,
  handleInitializeTranscription,
  handleInitializeFlow,
  handleInitializeMessageCommand,
  handleInitializeSlashCommand,
} = require("./logic/init_logic.cjs");
const {
  handleHelpMessageCommand,
  handleHelpSlashCommand,
} = require("./logic/help_logic.cjs");
const {
  handleModMessageCommand,
  handleModSlashCommand,
} = require("./logic/moderation_logic.cjs");
const {
  handleSafeUserMessageCommand,
  handlesafeUserslashCommand,
  showSafeUserList,
} = require("./logic/safeuser_logic.cjs");
const {
  handleSafeChannelMessageCommand,
  handlesafeChannelslashCommand,
  showSafeChannelList,
} = require("./logic/safechannel_logic.cjs");
const {
  handleReportMessageCommand,
  handleReportSlashCommand,
  handleReportInteractions,
  handleReportSubmission,
} = require("./logic/report_logic.cjs");
const {
  handleDisallowMessageCommand,
  handleDisallowSlashCommand,
} = require("./logic/disallow_logic.cjs");
const {
  handleAllInteractions,
} = require("./logic/interaction_logic.cjs");
const {
  handleNotifyMessageCommand,
  handleNotifySlashCommand,
  handleNotifyFlow,
  showNotifyHubUI,
  showNotifyList,
} = require("./logic/notify_logic.cjs");
const { handleRebootCommand } = require("./logic/reboot_logic.cjs");
const {
  handleFilterMessageCommand,
  handleFilterSlashCommand,
  showFilterSettingsUI,
} = require("./logic/filter_logic.cjs");
// Consent UI + delivery helpers
const {
  showConsentSettingsUI,
  handleConsentSettingChange,
  resolveConsentDestination,
  sendConsentPrompt,
} = require("./logic/consent_logic.cjs");

/* =============================
    GLOBALS & HELPERS
============================= */

const inflightConsent = new Set();

/* =============================
   SETTINGS CACHE (for interactions only)
   - The bug was: awaiting getSettingsForGuild BEFORE ack -> 10062
   - Solution: do NOT await it on the hot path. Use cache + background refresh.
============================= */

const SETTINGS_CACHE_TTL_MS = 60_000; // 1 minute
const _settingsCache = new Map(); // guildId -> { settings, expiresAt, inflightPromise }

function getCachedSettingsSync(guildId) {
  const entry = _settingsCache.get(guildId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) return null;
  return entry.settings || null;
}

function refreshSettingsCache(guildId) {
  const existing = _settingsCache.get(guildId);
  if (existing?.inflightPromise) return existing.inflightPromise;

  const p = (async () => {
    try {
      const settings = (await getSettingsForGuild(guildId)) || {};
      _settingsCache.set(guildId, {
        settings,
        expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS,
        inflightPromise: null,
      });
      return settings;
    } catch (err) {
      // Keep whatever was cached; don't throw into interaction handler
      if (existing) {
        _settingsCache.set(guildId, {
          settings: existing.settings,
          expiresAt: existing.expiresAt,
          inflightPromise: null,
        });
      }
      return existing?.settings || null;
    }
  })();

  _settingsCache.set(guildId, {
    settings: existing?.settings || null,
    expiresAt: existing?.expiresAt || 0,
    inflightPromise: p,
  });

  return p;
}

/* =============================
    ERROR FLOOD GUARD
============================= */

const ERROR_GUARD = {
  COOL_DOWN_MS: 3 * 60 * 1000,
  GLOBAL_WINDOW_MS: 30 * 1000,
  GLOBAL_TRIP_THRESHOLD: 15,
  GLOBAL_MUTE_MS: 15 * 60 * 1000,

  perChannelNextAllowed: new Map(),
  globalWindow: { start: Date.now(), count: 0 },
  globalMuteUntil: 0,
  trippedOnceThisMute: false,

  _now() { return Date.now(); },

  _refillGlobalWindow() {
    const now = this._now();
    if (now - this.globalWindow.start > this.GLOBAL_WINDOW_MS) {
      this.globalWindow.start = now;
      this.globalWindow.count = 0;
      this.trippedOnceThisMute = false;
    }
  },

  _maybeTrip(messageOrInteraction, client, guildId, contextLabel, errStackForLog) {
    this._refillGlobalWindow();
    this.globalWindow.count += 1;

    if (this.globalWindow.count >= this.GLOBAL_TRIP_THRESHOLD && this._now() > this.globalMuteUntil) {
      this.globalMuteUntil = this._now() + this.GLOBAL_MUTE_MS;
      this.trippedOnceThisMute = false;

      try {
        const details = [
          `Circuit breaker TRIPPED in ${contextLabel}`,
          `Errors in last ${Math.round(this.GLOBAL_WINDOW_MS / 1000)}s: ${this.globalWindow.count}`,
          `Muting public error notices for ${Math.round(this.GLOBAL_MUTE_MS / 60000)} minutes.`,
          errStackForLog ? `Last error:\n${String(errStackForLog).slice(0, 1200)}` : null,
        ].filter(Boolean).join("\n");
        logErrorToChannel(guildId, details, client, "ERROR_FLOOD_GUARD");
      } catch (_) { }
    }
  },

  canNotifyPublic(channelId) {
    const now = this._now();
    if (now < this.globalMuteUntil) return false;

    const nextAllowed = this.perChannelNextAllowed.get(channelId) || 0;
    if (now < nextAllowed) return false;

    this.perChannelNextAllowed.set(channelId, now + this.COOL_DOWN_MS);
    return true;
  },

  recordError({ messageOrInteraction, client, contextLabel, err }) {
    const guildId = messageOrInteraction.guild?.id ?? null;
    this._maybeTrip(messageOrInteraction, client, guildId, contextLabel, err?.stack || String(err));

    if (this._now() < this.globalMuteUntil && !this.trippedOnceThisMute) {
      this.trippedOnceThisMute = true;
      try {
        const details = [
          `Public error notices are currently MUTED by circuit breaker (${contextLabel}).`,
          `They will resume around <t:${Math.floor(this.globalMuteUntil / 1000)}:t>.`,
        ].join("\n");
        logErrorToChannel(guildId, details, client, "ERROR_FLOOD_GUARD");
      } catch (_) { }
    }
  }
};

/** Replace only the consent:grant button in the given message's components */
function replaceConsentButton(msgLike, transformFn) {
  const rows = msgLike.components ?? [];
  return rows.map(row => {
    const newRow = new ActionRowBuilder();
    newRow.addComponents(
      ...row.components.map(c => {
        if (c.type !== ComponentType.Button) return c;
        const btn = ButtonBuilder.from(c);
        const isTarget = btn.data?.custom_id?.startsWith?.("consent:grant:");
        return isTarget ? transformFn(btn) : btn;
      })
    );
    return newRow;
  });
}

/** Safely acknowledge a component interaction only once */
async function safeDeferUpdate(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate();
    }
  } catch (_) { }
}

/** Best-effort user feedback without crashing on perms */
async function safeChannelNotify(interaction, content) {
  try {
    await interaction.channel?.send({ content });
  } catch (_) { }
}

/** Send with graceful fallback when missing perms */
async function safeSend(channel, payload) {
  const isString = typeof payload === "string";
  const { interaction, ...messageOptions } =
    isString ? { content: payload } : (payload || {});

  try {
    return await channel.send(messageOptions);
  } catch (err) {
    if (err?.code === 50013) {
      try {
        if (interaction) {
          if (!interaction.deferred && !interaction.replied) {
            await interaction.reply({
              content: "> <❌> Missing permissions. Extra permissions are required.",
              ephemeral: true,
            });
          } else {
            await interaction.followUp({
              content: "> <❌> Missing permissions. Extra permissions are required.",
              ephemeral: true,
            });
          }
        }
      } catch (_) { }
      return null;
    }
    throw err;
  }
}

/** Public error notice that is fully guarded against spam */
async function guardedPublicErrorNotice(message, content) {
  try {
    if (!message?.channel) return;
    if (!ERROR_GUARD.canNotifyPublic(message.channel.id)) return;
    await safeSend(message.channel, content);
  } catch (_) { }
}

/* =============================
   INTERACTION WATCHDOG + PATCH
   - If a slash command handler takes too long, we defer PUBLICLY (not ephemeral)
     to prevent 10062.
   - If we deferred, command code that calls interaction.reply() is redirected
     to editReply() / followUp() as needed.
============================= */

function sanitizeForEditReply(payload) {
  if (payload == null) return payload;
  if (typeof payload === "string") return { content: payload };
  if (typeof payload !== "object") return payload;

  const out = { ...payload };
  // editReply does not support ephemeral
  delete out.ephemeral;
  // fetchReply is not used for editReply
  delete out.fetchReply;
  return out;
}

function patchInteractionReplyAfterWatchdog(interaction) {
  if (interaction.__vct_reply_patched) return;
  interaction.__vct_reply_patched = true;

  const origReply = interaction.reply?.bind(interaction);
  const origEditReply = interaction.editReply?.bind(interaction);
  const origFollowUp = interaction.followUp?.bind(interaction);

  if (!origReply || !origEditReply || !origFollowUp) return;

  interaction.reply = async (payload) => {
    // If not acknowledged yet, normal reply
    if (!interaction.deferred && !interaction.replied) {
      return origReply(payload);
    }

    // Already acknowledged (likely via watchdog defer)
    // If caller explicitly asked ephemeral, use followUp ephemeral.
    if (payload && typeof payload === "object" && payload.ephemeral === true) {
      try {
        // If we only deferred for safety, delete the public placeholder
        // so the interaction feels truly ephemeral.
        await interaction.deleteReply().catch(() => { });
      } catch (_) { }
      return origFollowUp(payload);
    }

    // Otherwise, edit the original deferred reply publicly.
    return origEditReply(sanitizeForEditReply(payload));
  };
}

async function startInteractionAckWatchdog(interaction) {
  // Only for repliable interactions where Discord expects an ack in ~3 seconds
  if (!interaction?.isRepliable?.()) return null;

  // If the handler replies quickly, watchdog never fires.
  // If not, we deferReply PUBLICLY so it does NOT force everything ephemeral.
  const t = setTimeout(async () => {
    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral: false }).catch(() => { });
      }
    } catch (_) { }
  }, 1900);

  return () => clearTimeout(t);
}

const TC_HINT_COMMANDS = new Set([
  "ban",
  "unban",
  "kick",
  "mute",
  "unmute",
  "warn",
  "clean",
  "history",
  "view",
]);

/* =============================
   MESSAGE-BASED COMMAND ROUTING
============================= */
async function onMessageCreate(message) {
  try {
    if (message.author.bot) return;

    // 🚧 DM guard (messages)
    if (!message.inGuild()) {
      return;
    }

    const settings = (await getSettingsForGuild(message.guild.id)) || {};
    const prefixes = settings.prefixes ?? { slash: true, greater: true, exclamation: true };

    let used = null;
    if (message.content.startsWith(">") && prefixes.greater) used = "greater";
    else if (message.content.startsWith("!") && prefixes.exclamation) used = "exclamation";
    if (!used) return;

    const args = message.content.slice(1).trim().split(/\s+/);
    const command = args.shift().toLowerCase();

    switch (command) {
      case "settings":
        await handleSettingsMessageCommand(message, args);
        break;
      case "initialize":
        await handleInitializeMessageCommand(message, args);
        break;
      case "help":
        await handleHelpMessageCommand(message, args);
        break;
      case "vc":
        await handleVCMessageCommand(message, args);
        break;
      case "tc":
        await handleModMessageCommand(message, args);
        break;
      case "safechannel":
        await handleSafeChannelMessageCommand(message, args);
        break;
      case "safeuser":
        await handleSafeUserMessageCommand(message, args);
        break;
      case "report":
        await handleReportMessageCommand(message, args);
        break;
      case "disallow":
        await handleDisallowMessageCommand(message, args);
        break;
      case "filter":
        await handleFilterMessageCommand(message, args);
        break;
      case "notify":
        await handleNotifyMessageCommand(message, args);
        break;
      case "reboot":
        await handleRebootCommand(message);
        break;
      case "drain":
        await handleDrainMessageCommand(message, args);
        break;
      case "consent":
        await showConsentSettingsUI(message, false);
        break;
      default: {
        // Gentle hint for tc-prefixed moderation commands
        if (TC_HINT_COMMANDS.has(command)) {
          await message.channel.send(
            [
              "-# That command is under `>tc`.",
              `-# Try \`>tc ${command}\`.`,
            ].join("\n")
          );
        }
        break;
      }
    }
  } catch (error) {
    console.error(`[ERROR] onMessageCreate failed: ${error.message}`);
    await logErrorToChannel(
      message.guild?.id,
      error.stack,
      message.client,
      "onMessageCreate"
    );

    ERROR_GUARD.recordError({
      messageOrInteraction: message,
      client: message.client,
      contextLabel: "onMessageCreate",
      err: error
    });

    await guardedPublicErrorNotice(
      message,
      "> <❌> An unexpected error occurred. The team has been notified."
    );
  }
}

/* =============================
   INTERACTION-BASED COMMAND ROUTING
============================= */
async function onInteractionCreate(interaction) {
  let stopWatchdog = null;

  try {
    // Start watchdog ASAP for any repliable interaction types.
    stopWatchdog = await startInteractionAckWatchdog(interaction);

    if (interaction.isChatInputCommand()) {
      // 🚧 DM guard MUST come before interaction.guild access
      if (!interaction.inGuild()) return;

      // Patch reply() so command modules can keep calling reply() even if watchdog deferred.
      patchInteractionReplyAfterWatchdog(interaction);

      // ✅ IMPORTANT: Do NOT await Supabase settings before ack.
      // Use cache sync-check and refresh in background.
      const guildId = interaction.guild.id;
      const cached = getCachedSettingsSync(guildId);
      refreshSettingsCache(guildId).catch(() => { });

      // Enforce slash disabled using cached settings (fast)
      if (cached?.prefixes && cached.prefixes.slash === false) {
        const enabled = cached.prefixes;
        const alternatives = [];
        if (enabled.greater) alternatives.push("the `> prefix`");
        if (enabled.exclamation) alternatives.push("the `! prefix`");
        const fallback = alternatives.length
          ? `You can still use ${alternatives.join(" or ")} instead.`
          : "No command prefixes are currently enabled.";

        await interaction.reply({
          content: ["> <❌> Slash commands are disabled on this server.", fallback].join("\n"),
          ephemeral: false,
        }).catch(() => { });

        return;
      }

      switch (interaction.commandName) {
        case "settings":
          await handleSettingsSlashCommand(interaction);
          break;
        case "initialize":
          await handleInitializeSlashCommand(interaction);
          break;
        case "help":
          await handleHelpSlashCommand(interaction);
          break;
        case "vc":
          await handleVCSlashCommand(interaction);
          break;
        case "tc":
          await handleModSlashCommand(interaction);
          break;
        case "safeuser":
          await handlesafeUserslashCommand(interaction);
          break;
        case "safechannel":
          await handlesafeChannelslashCommand(interaction);
          break;
        case "report":
          await handleReportSlashCommand(interaction);
          break;
        case "disallow":
          await handleDisallowSlashCommand(interaction);
          break;
        case "filter":
          await handleFilterSlashCommand(interaction);
          break;
        case "notify":
          await handleNotifySlashCommand(interaction);
          break;
        case "drain":
          await handleDrainSlashCommand(interaction);
          break;
        case "consent":
          await showConsentSettingsUI(interaction, true);
          break;
        default:
          console.log(`[DEBUG] Unhandled slash command: ${interaction.commandName}`);
          await interaction.reply({ content: "> <❇️> Unknown command.", ephemeral: true }).catch(() => { });
      }

    } else if (interaction.isModalSubmit()) {
      // Modal submits also need quick ack; watchdog handles it.
      patchInteractionReplyAfterWatchdog(interaction);
      await handleReportSubmission(interaction);

    } else if (interaction.isButton() || interaction.isStringSelectMenu()) {
      // VC settings UI (buttons + role select)
      if (interaction.customId.startsWith("vcsettings:")) {
        const parts = interaction.customId.split(":");
        const action = parts[1];
        return handleVCSettingsFlow(interaction, action);
      }

      if (interaction.customId.startsWith("help:")) return;

      // report + activity buttons → open the modal
      if (
        interaction.isButton() &&
        (interaction.customId.startsWith("report:") ||
          interaction.customId.startsWith("activity:"))
      ) {
        return handleReportInteractions(interaction);
      }

      if (interaction.customId.startsWith("notify:")) return handleNotifyFlow(interaction);
      if (interaction.isButton() && interaction.customId.startsWith("prefix:")) return handlePrefixSettingsFlow(interaction);

      // ✅ Safer consent grant handler
      if (interaction.isButton() && interaction.customId.startsWith("consent:grant:")) {
        const [, , targetUserId] = interaction.customId.split(":");

        if (interaction.user.id !== targetUserId) {
          if (!interaction.deferred && !interaction.replied) {
            await interaction.reply({
              ephemeral: true,
              content: "> <❇️> You cannot interact with this button. (INT_ERR_004)",
            }).catch(() => { });
          }
          return;
        }

        if (inflightConsent.has(targetUserId)) {
          if (!interaction.deferred && !interaction.replied) {
            await interaction.reply({
              ephemeral: true,
              content: "> <❇️> Your consent is already being processed.",
            }).catch(() => { });
          }
          return;
        }

        inflightConsent.add(targetUserId);

        const watchdog = setTimeout(() => safeDeferUpdate(interaction), 1500);

        try {
          await safeDeferUpdate(interaction);

          const processingRows = replaceConsentButton(
            interaction.message,
            btn => btn.setLabel("Processing…").setStyle(ButtonStyle.Secondary).setDisabled(true)
          );

          await interaction.editReply({ components: processingRows }).catch(async (err) => {
            if (interaction.message?.editable) {
              await interaction.message.edit({ components: processingRows }).catch(() => { });
            } else {
              throw err;
            }
          });

          await grantUserConsent(targetUserId, interaction.guild);
          interactionContexts.delete(targetUserId);

          const successRows = replaceConsentButton(
            interaction.message,
            btn => btn.setLabel("Consent recorded").setStyle(ButtonStyle.Success).setDisabled(true)
          );

          await interaction.editReply({ components: successRows }).catch(async () => {
            if (interaction.message?.editable) {
              await interaction.message.edit({ components: successRows }).catch(() => { });
            }
          });

          try {
            await interaction.followUp({ ephemeral: true, content: "> <✅> Consent recorded." });
          } catch (_) { }
          return;

        } catch (err) {
          const msg = String(err?.message || err);
          if (msg.includes("Unknown interaction") || msg.includes("already been acknowledged")) {
            await safeChannelNotify(interaction, "> That button expired or was already used. Try again.");
          } else {
            console.error("[ERROR] consent:grant handler:", err);
            await logErrorToChannel(
              interaction.guild?.id,
              err?.stack || String(err),
              interaction.client,
              "consent:grant"
            );
            try {
              if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                  ephemeral: true,
                  content: "> <❌> Failed to record your consent. Please try again.",
                });
              } else {
                await interaction.followUp({
                  ephemeral: true,
                  content: "> <❌> Failed to record your consent. Please try again.",
                });
              }
            } catch (_) { }
          }
          return;

        } finally {
          clearTimeout(watchdog);
          inflightConsent.delete(targetUserId);
        }
      }

      if (interaction.customId.startsWith("consent:")) {
        return handleConsentSettingChange(interaction);
      }

      if (interaction.customId.startsWith("safeUserList:")) return showSafeUserList(interaction);
      if (interaction.customId.startsWith("safeChannelList:")) return showSafeChannelList(interaction);
      if (interaction.customId.startsWith("notifyList:")) return showNotifyList(interaction);

      if (interaction.customId.startsWith("init:")) {
        const parts = interaction.customId.split(":");
        const action = parts[1];

        // IMPORTANT:
        // customId sometimes ends up with "undefined" or "null" as a STRING.
        // Treat those as "no lock".
        const rawOwner = parts[2];
        const ownerId =
          rawOwner && rawOwner !== "undefined" && rawOwner !== "null" ? rawOwner : null;

        // Allow the locked user OR the guild owner to use the components.
        const isGuildOwner =
          interaction.guild?.ownerId && interaction.user.id === interaction.guild.ownerId;

        if (ownerId && ownerId !== interaction.user.id && !isGuildOwner) {
          if (!interaction.deferred && !interaction.replied) {
            await interaction
              .reply({
                content: "> <❌> You cannot interact with this component. (INT_ERR_004)",
                ephemeral: true,
              })
              .catch(() => { });
          }
          return;
        }

        let context = interactionContexts.get(interaction.user.id);
        if (!context) {
          context = { guildId: interaction.guild.id, mode: "init", initMethod: "ftt" };
          interactionContexts.set(interaction.user.id, context);
        }

        try {
          switch (context.initMethod) {
            case "transcription":
              await handleTranscriptionFlow(interaction, context.mode, action);
              break;
            case "staffroles":
              await handleStaffRolesFlow(interaction, context.mode, action);
              break;
            default:
              await handleInitializeFlow(interaction, context.mode, action);
              break;
          }
        } catch (err) {
          console.error("[ERROR] init flow router:", err);

          // Since we already deferredUpdate, reply() will often fail.
          // Follow up instead (best-effort).
          await interaction
            .followUp({
              content: "> <❌> Something went wrong handling that step. (INIT_ROUTER_ERR)",
              ephemeral: true,
            })
            .catch(() => { });
        }

        return;
      }

      if (!interaction.replied && !interaction.deferred) {
        await handleAllInteractions(interaction);
      }
    }

  } catch (error) {
    console.error(`[ERROR] onInteractionCreate failed: ${error.message}`);
    await logErrorToChannel(
      interaction.guild?.id,
      error.stack,
      interaction.client,
      "onInteractionCreate"
    );

    ERROR_GUARD.recordError({
      messageOrInteraction: interaction,
      client: interaction.client,
      contextLabel: "onInteractionCreate",
      err: error
    });

    try {
      if (interaction?.isRepliable?.()) {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({
            content: "> <❌> An unexpected error occurred processing your interaction. (INT_ERR_006)",
          }).catch(async () => {
            await interaction.followUp({
              content: "> <❌> An unexpected error occurred processing your interaction. (INT_ERR_006)",
              ephemeral: true,
            }).catch(() => { });
          });
        } else {
          await interaction.reply({
            content: "> <❌> An unexpected error occurred processing your interaction. (INT_ERR_006)",
            ephemeral: true,
          }).catch(() => { });
        }
      }
    } catch (_) { }
  } finally {
    try { stopWatchdog?.(); } catch (_) { }
  }
}

module.exports = { onMessageCreate, onInteractionCreate };