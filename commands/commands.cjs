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

/**
 * Settings cache
 * - Fixes slash-command Unknown interaction by allowing us to ACK first
 * - Reduces Supabase load for BOTH text + slash commands
 */
const SETTINGS_CACHE = {
  TTL_MS: 60 * 1000, // 60s is a good balance; adjust if you want
  map: new Map(),    // guildId -> { settings, ts }

  getFresh(guildId) {
    if (!guildId) return null;
    const entry = this.map.get(guildId);
    if (!entry) return null;
    if (Date.now() - entry.ts > this.TTL_MS) return null;
    return entry.settings || null;
  },

  set(guildId, settings) {
    if (!guildId) return;
    this.map.set(guildId, { settings: settings || {}, ts: Date.now() });
  },

  async fetch(guildId) {
    // Always returns an object (never null)
    const cached = this.getFresh(guildId);
    if (cached) return cached;

    const settings = (await getSettingsForGuild(guildId)) || {};
    this.set(guildId, settings);
    return settings;
  }
};

/**
 * Wrap an Interaction so old code that calls interaction.reply()
 * keeps working even after we defer early.
 *
 * - If deferred/replied: reply() becomes editReply()
 * - If editReply fails: fall back to followUp()
 * - deferReply() is idempotent
 */
function makeSafeInteraction(interaction) {
  const safeReply = async (payload) => {
    try {
      if (interaction.deferred || interaction.replied) {
        // After deferReply or an initial reply, the "safe" equivalent is editReply.
        try {
          return await interaction.editReply(payload);
        } catch (_) {
          // If editReply isn't possible (edge cases), try followUp.
          return await interaction.followUp(payload);
        }
      }
      return await interaction.reply(payload);
    } catch (err) {
      // If token expired anyway, don't hard-crash the router.
      // Still rethrow non-timing errors if you want; for now, swallow silently.
      const msg = String(err?.message || err);
      if (msg.includes("Unknown interaction") || msg.includes("Interaction has already been acknowledged")) {
        return null;
      }
      throw err;
    }
  };

  const safeDeferReply = async (opts = {}) => {
    try {
      if (!interaction.deferred && !interaction.replied) {
        return await interaction.deferReply(opts);
      }
      return null;
    } catch (err) {
      const msg = String(err?.message || err);
      if (msg.includes("Unknown interaction") || msg.includes("Interaction has already been acknowledged")) {
        return null;
      }
      throw err;
    }
  };

  const safeEditReply = async (payload) => {
    try {
      return await interaction.editReply(payload);
    } catch (err) {
      const msg = String(err?.message || err);
      if (msg.includes("Unknown interaction")) return null;
      throw err;
    }
  };

  const safeFollowUp = async (payload) => {
    try {
      return await interaction.followUp(payload);
    } catch (err) {
      const msg = String(err?.message || err);
      if (msg.includes("Unknown interaction")) return null;
      throw err;
    }
  };

  return new Proxy(interaction, {
    get(target, prop) {
      if (prop === "reply") return safeReply;
      if (prop === "deferReply") return safeDeferReply;
      if (prop === "editReply") return safeEditReply;
      if (prop === "followUp") return safeFollowUp;

      const value = target[prop];
      if (typeof value === "function") return value.bind(target);
      return value;
    }
  });
}

/* =============================
    ERROR FLOOD GUARD
   - Per-channel cooldown: at most 1 public error notice every COOL_DOWN_MS
   - Global circuit breaker: if too many errors quickly, mute ALL public notices
     and only log to the error-logs channel with a summary.
============================= */

const ERROR_GUARD = {
  // Tunables (adjust as needed)
  COOL_DOWN_MS: 3 * 60 * 1000,     // one public notice per channel every 3 minutes
  GLOBAL_WINDOW_MS: 30 * 1000,     // consider errors over a 30s window
  GLOBAL_TRIP_THRESHOLD: 15,       // >=15 errors in window → trip breaker
  GLOBAL_MUTE_MS: 15 * 60 * 1000,  // mute public notices for 15 minutes

  perChannelNextAllowed: new Map(), // channelId -> timestamp (ms)
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
      // Trip the breaker
      this.globalMuteUntil = this._now() + this.GLOBAL_MUTE_MS;
      this.trippedOnceThisMute = false; // allow one summary log

      // Best-effort summary to error logs channel
      try {
        const details = [
          `Circuit breaker TRIPPED in ${contextLabel}`,
          `Errors in last ${Math.round(this.GLOBAL_WINDOW_MS / 1000)}s: ${this.globalWindow.count}`,
          `Muting public error notices for ${Math.round(this.GLOBAL_MUTE_MS / 60000)} minutes.`,
          errStackForLog ? `Last error:\n${String(errStackForLog).slice(0, 1200)}` : null,
        ].filter(Boolean).join("\n");
        logErrorToChannel(guildId, details, client, "ERROR_FLOOD_GUARD");
      } catch (_) { /* noop */ }
    }
  },

  canNotifyPublic(channelId) {
    const now = this._now();
    if (now < this.globalMuteUntil) return false; // globally muted

    const nextAllowed = this.perChannelNextAllowed.get(channelId) || 0;
    if (now < nextAllowed) return false;

    this.perChannelNextAllowed.set(channelId, now + this.COOL_DOWN_MS);
    return true;
  },

  recordError({ messageOrInteraction, client, contextLabel, err }) {
    const guildId = messageOrInteraction.guild?.id ?? null;
    this._maybeTrip(messageOrInteraction, client, guildId, contextLabel, err?.stack || String(err));

    // If globally muted and we haven't emitted a summary during this mute, emit once.
    if (this._now() < this.globalMuteUntil && !this.trippedOnceThisMute) {
      this.trippedOnceThisMute = true;
      try {
        const details = [
          `Public error notices are currently MUTED by circuit breaker (${contextLabel}).`,
          `They will resume around <t:${Math.floor(this.globalMuteUntil / 1000)}:t>.`,
        ].join("\n");
        logErrorToChannel(guildId, details, client, "ERROR_FLOOD_GUARD");
      } catch (_) { /* noop */ }
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
  } catch (_) {
    // If we can't defer because it's already acknowledged, ignore.
  }
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
    if (err?.code === 50013) { // Missing Permissions
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
      } catch (_) { /* noop */ }
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

    // Optionally auto-delete shortly after:
    // const sent = await safeSend(message.channel, content);
    // setTimeout(() => sent?.delete().catch(()=>{}), 10_000);
    await safeSend(message.channel, content);
  } catch (_) { /* never throw from guard */ }
}

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

    // Use cached settings for BOTH text and slash commands
    const settings = await SETTINGS_CACHE.fetch(message.guild.id);
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
      default:
        break;
    }
  } catch (error) {
    console.error(`[ERROR] onMessageCreate failed: ${error.message}`);
    await logErrorToChannel(
      message.guild?.id,
      error.stack,
      message.client,
      "onMessageCreate"
    );

    // Count toward guard and rate-limit any public notice
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
  try {
    // ✅ DM guard FIRST (prevents interaction.guild null crashes)
    if (!interaction.inGuild()) return;

    if (interaction.isChatInputCommand()) {
      // 🔒 ACKNOWLEDGE IMMEDIATELY — BEFORE ANY await (fixes 10062 for every command)
      // NOTE: This makes slash commands ephemeral by default. If you want public slash outputs,
      // change ephemeral: true -> false here.
      const safe = makeSafeInteraction(interaction);
      await safe.deferReply({ ephemeral: true });

      // Now it's safe to await Supabase/settings without interaction expiry.
      const settings = await SETTINGS_CACHE.fetch(interaction.guild.id);

      if (settings.prefixes && settings.prefixes.slash === false) {
        const enabled = settings.prefixes;
        const alternatives = [];
        if (enabled.greater) alternatives.push("the `> prefix`");
        if (enabled.exclamation) alternatives.push("the `! prefix`");
        const fallback = alternatives.length
          ? `You can still use ${alternatives.join(" or ")} instead.`
          : "No command prefixes are currently enabled.";

        await safe.editReply({
          content: ["> <❌> Slash commands are disabled on this server.", fallback].join("\n"),
        });
        return;
      }

      switch (interaction.commandName) {
        case "settings":
          await handleSettingsSlashCommand(safe);
          break;
        case "initialize":
          await handleInitializeSlashCommand(safe);
          break;
        case "help":
          await handleHelpSlashCommand(safe);
          break;
        case "vc":
          await handleVCSlashCommand(safe);
          break;
        case "tc":
          await handleModSlashCommand(safe);
          break;
        case "safeuser":
          await handlesafeUserslashCommand(safe);
          break;
        case "safechannel":
          await handlesafeChannelslashCommand(safe);
          break;
        case "report":
          await handleReportSlashCommand(safe);
          break;
        case "disallow":
          await handleDisallowSlashCommand(safe);
          break;
        case "filter":
          await handleFilterSlashCommand(safe);
          break;
        case "notify":
          await handleNotifySlashCommand(safe);
          break;
        case "drain":
          await handleDrainSlashCommand(safe);
          break;
        case "consent":
          await showConsentSettingsUI(safe, true);
          break;
        default:
          console.log(`[DEBUG] Unhandled slash command: ${interaction.commandName}`);
          await safe.editReply({ content: "> <❌> Unknown command." });
          break;
      }

    } else if (interaction.isModalSubmit()) {
      // Modal submits also have the 3s ACK rule.
      const safe = makeSafeInteraction(interaction);
      await safe.deferReply({ ephemeral: true });
      await handleReportSubmission(safe);

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

      // ✅ Safer consent grant handler: defer first, then editReply (no .update())
      if (interaction.isButton() && interaction.customId.startsWith("consent:grant:")) {
        const [, , targetUserId] = interaction.customId.split(":");

        // Only the targeted user can grant their consent
        if (interaction.user.id !== targetUserId) {
          if (!interaction.deferred && !interaction.replied) {
            await interaction.reply({
              ephemeral: true,
              content: "> <❇️> You cannot interact with this button. (INT_ERR_004)",
            }).catch(() => { });
          }
          return;
        }

        // If another handler run is already in-flight for this user, noop
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

        // Watchdog: ensure we ACK quickly to avoid token expiry
        const watchdog = setTimeout(() => safeDeferUpdate(interaction), 1500);

        try {
          // ACK immediately (safe, idempotent)
          await safeDeferUpdate(interaction);

          // 1) Show "Processing…" on the original message (editReply after defer)
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

          // 2) Persist consent (UPSERT/idempotent)
          await grantUserConsent(targetUserId, interaction.guild);

          // 3) Clear any pending context for this user
          interactionContexts.delete(targetUserId);

          // 4) Final UI: "Consent recorded"
          const successRows = replaceConsentButton(
            interaction.message,
            btn => btn.setLabel("Consent recorded").setStyle(ButtonStyle.Success).setDisabled(true)
          );

          await interaction.editReply({ components: successRows }).catch(async () => {
            if (interaction.message?.editable) {
              await interaction.message.edit({ components: successRows }).catch(() => { });
            }
          });

          // Optional ephemeral confirm
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

      // 🛠️ Admin/settings UI for consent (select menus etc.)
      if (interaction.customId.startsWith("consent:")) {
        return handleConsentSettingChange(interaction);
      }

      // — unified list buttons —
      if (interaction.customId.startsWith("safeUserList:")) {
        return showSafeUserList(interaction);
      }
      if (interaction.customId.startsWith("safeChannelList:")) {
        return showSafeChannelList(interaction);
      }
      if (interaction.customId.startsWith("notifyList:")) {
        return showNotifyList(interaction);
      }

      // init flows
      if (interaction.customId.startsWith("init:")) {
        const parts = interaction.customId.split(":"); // e.g. ["init","setup_transcription_yes","1234567890"]
        const action = parts[1];
        const ownerId = parts[2] ?? null;

        // 🔒 Only the user who started the init flow can interact
        if (ownerId && ownerId !== interaction.user.id) {
          if (!interaction.deferred && !interaction.replied) {
            await interaction.reply({
              content: "> <❌> You cannot interact with this component. (INT_ERR_004)",
              ephemeral: true,
            }).catch(() => { });
          }
          return;
        }

        // 🧭 Get or seed context; don't require mode === "init"
        let context = interactionContexts.get(interaction.user.id);
        if (!context) {
          context = { guildId: interaction.guild.id, mode: "init", initMethod: "ftt" };
          interactionContexts.set(interaction.user.id, context);
        }

        // ⏱️ Watchdog: if no ack within ~2s, defer update to prevent toast
        const watchdog = setTimeout(async () => {
          try {
            if (!interaction.deferred && !interaction.replied) {
              await interaction.deferUpdate().catch(() => { });
            }
          } catch (_) { }
        }, 2000);

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
          if (!interaction.deferred && !interaction.replied) {
            await interaction.reply({
              content: "> <❌> Something went wrong handling that step. (INIT_ROUTER_ERR)",
              ephemeral: true,
            }).catch(() => { });
          }
        } finally {
          clearTimeout(watchdog);
        }
        return;
      }

      // fallback to any other interactions
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

    // Count toward breaker; interactions never post public errors
    ERROR_GUARD.recordError({
      messageOrInteraction: interaction,
      client: interaction.client,
      contextLabel: "onInteractionCreate",
      err: error
    });

    // Use a safe interaction wrapper for best-effort feedback
    try {
      const safe = makeSafeInteraction(interaction);
      if (!interaction.replied && !interaction.deferred && interaction.inGuild()) {
        await safe.reply({
          content: "> <❌> An unexpected error occurred processing your interaction. (INT_ERR_006)",
          ephemeral: true,
        });
      } else if (interaction.deferred || interaction.replied) {
        await safe.followUp({
          content: "> <❌> An unexpected error occurred processing your interaction. (INT_ERR_006)",
          ephemeral: true,
        }).catch(() => { });
      }
    } catch (_) { /* noop */ }
  }
}

module.exports = { onMessageCreate, onInteractionCreate };