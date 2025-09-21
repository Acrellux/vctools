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
    await message.channel.send(
      "> <❌> An unexpected error occurred processing your message."
    );
  }
}

/* =============================
   INTERACTION-BASED COMMAND ROUTING
============================= */
async function onInteractionCreate(interaction) {
  try {
    if (interaction.isChatInputCommand()) {
      const settings = (await getSettingsForGuild(interaction.guild.id)) || {};
      if (settings.prefixes && settings.prefixes.slash === false) {
        const enabled = settings.prefixes;
        const alternatives = [];
        if (enabled.greater) alternatives.push("the `> prefix`");
        if (enabled.exclamation) alternatives.push("the `! prefix`");
        const fallback = alternatives.length
          ? `You can still use ${alternatives.join(" or ")} instead.`
          : "No command prefixes are currently enabled.";
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: ["> <❌> Slash commands are disabled on this server.", fallback].join("\n"),
            ephemeral: false,
          });
        }
        return;
      }

      // 🚧 DM guard (interactions)
      if (!interaction.inGuild()) {
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
      }

    } else if (interaction.isModalSubmit()) {
      await handleReportSubmission(interaction);

    } else if (interaction.isButton() || interaction.isStringSelectMenu()) {
      // VC settings UI (buttons + role select)
      if (interaction.customId.startsWith("vcsettings:")) {
        const parts = interaction.customId.split(":");
        // e.g. "vcsettings:toggle-mod-auto-route:<userId>"
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

          // For component interactions, editReply() edits the original message
          await interaction.editReply({ components: processingRows }).catch(async (err) => {
            // Fallback to message.edit if token is in a weird state
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
          // If the token was somehow invalid/late, fall back to a channel notice
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

      // init flows (routes any init mode; protects by owner; seeds context if missing)
      // watchdog auto-acks slow handlers to avoid the "This interaction failed" toast
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
    if (!interaction.replied) {
      await interaction.reply({
        content: "> <❌> An unexpected error occurred processing your interaction. (INT_ERR_006)",
        ephemeral: true,
      }).catch(() => { });
    }
  }
}

module.exports = { onMessageCreate, onInteractionCreate };