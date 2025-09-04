const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ChannelType,
  Message,
} = require("discord.js");
const {
  getSettingsForGuild,
  updateSettingsForGuild,
  updateChannelPermissionsForGuild,
} = require("../settings.cjs");
const { createRoleDropdown } = require("./helpers.cjs");
const { logErrorToChannel } = require("./helpers.cjs");
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const { requiredManagerPermissions } = require("./helpers.cjs");

/* ────────────────────────────────────────────────────────────────────────────
   Anti double-fire guard (applies only to opening the panel via command/message)
   ──────────────────────────────────────────────────────────────────────────── */
const IN_FLIGHT_WINDOW_MS = 4000;
const inflight = new Map(); // key: guildId:userId → ts

function makeKeyFromTarget(target) {
  const guildId = target?.guild?.id ?? "noguild";
  const userId =
    target instanceof Message ? target.author?.id : target?.user?.id ?? "nouser";
  return `${guildId}:${userId}:vcsettings_open`;
}

function shouldGuardOpen(target) {
  // Guard only for open actions (slash/chat input or message) — not for component updates
  const isOpenAction =
    target?.isChatInputCommand?.() ||
    target?.isCommand?.() ||
    target instanceof Message;
  if (!isOpenAction) return false;

  const key = makeKeyFromTarget(target);
  const now = Date.now();
  const last = inflight.get(key);
  if (last && now - last < IN_FLIGHT_WINDOW_MS) return true;

  inflight.set(key, now);
  setTimeout(() => {
    if (inflight.get(key) === now) inflight.delete(key);
  }, IN_FLIGHT_WINDOW_MS);
  return false;
}

async function showVCSettingsUI(interactionOrMessage, isEphemeral = false) {
  try {
    const guild = interactionOrMessage.guild;
    if (!guild) return;

    // Permission check (keep your helper signature)
    if (!(await requiredManagerPermissions(interactionOrMessage))) {
      const noPermissionMessage =
        "> <❇️> You do not have the required permissions to do this. (CMD_ERR_008)";
      if (interactionOrMessage instanceof Message) {
        await interactionOrMessage.channel.send(noPermissionMessage);
      } else {
        await interactionOrMessage.reply({
          content: noPermissionMessage,
          ephemeral: true,
        });
      }
      return;
    }

    // Prevent rapid duplicate opens (but allow component-driven re-renders)
    if (shouldGuardOpen(interactionOrMessage)) {
      // Quietly acknowledge to avoid "interaction failed", if applicable
      try {
        if (
          interactionOrMessage.isRepliable?.() &&
          !interactionOrMessage.deferred &&
          !interactionOrMessage.replied
        ) {
          await interactionOrMessage.deferReply({ ephemeral: true });
        }
      } catch { }
      return;
    }

    // Load settings BEFORE building UI so first render has all buttons/labels
    const settings = await getSettingsForGuild(guild.id);
    const userId =
      interactionOrMessage instanceof Message
        ? interactionOrMessage.author.id
        : interactionOrMessage.user.id;

    // Display the current Voice Call Ping role
    const roleName = settings.voiceCallPingRoleId
      ? guild.roles.cache.get(settings.voiceCallPingRoleId)?.name || "Unknown Role"
      : "Not set";

    const contentMessage = `## ◈ **VC Settings**
> **Voice Call Ping Role:** ${roleName}
> **Notify on Bad Words:** ${settings.notifyBadWord ? "Enabled" : "Disabled"}
> **Notify for Loud Users:** ${settings.notifyLoudUser ? "Enabled" : "Disabled"}
> **Soundboard Logging:** ${settings.soundboardLogging ? "Enabled" : "Disabled"}
> **Kick on Soundboard Spam:** ${settings.kickOnSoundboardSpam ? "Enabled" : "Disabled"}
> **Move to Other Voice Calls when Moderators Join (Mod Auto-Route):** ${settings.mod_auto_route_enabled ? "Enabled" : "Disabled"}
> **VC Logging:** ${settings.vcLoggingEnabled ? "Enabled" : "Disabled"}

-# *Unable to find a specific channel/role? Log into the [Dashboard](<https://vctools.app/dashboard>) to avoid the 25 dropdown option limit.*`;

    // Dropdown for VC Ping role selection (keeping your customId pattern)
    const vcRoleDropdown = createRoleDropdown(
      `vcsettings:select-log-viewers:${userId}`,
      guild,
      userId,
      settings.voiceCallPingRoleId
    );

    // Buttons (first row — max 5)
    const togglenotifyBadWordButton = new ButtonBuilder()
      .setCustomId(`vcsettings:toggle-badword:${userId}`)
      .setLabel(
        settings.notifyBadWord
          ? "Disable Notify on Bad Words"
          : "Enable Notify on Bad Words"
      )
      .setStyle(settings.notifyBadWord ? ButtonStyle.Danger : ButtonStyle.Success);

    const togglenotifyLoudUserButton = new ButtonBuilder()
      .setCustomId(`vcsettings:toggle-loud-user:${userId}`)
      .setLabel(
        settings.notifyLoudUser
          ? "Disable Notify for Loud Users"
          : "Enable Notify for Loud Users"
      )
      .setStyle(settings.notifyLoudUser ? ButtonStyle.Danger : ButtonStyle.Success);

    const togglesoundboardLoggingButton = new ButtonBuilder()
      .setCustomId(`vcsettings:toggle-soundboard-logging:${userId}`)
      .setLabel(
        settings.soundboardLogging
          ? "Disable Soundboard Logging"
          : "Enable Soundboard Logging"
      )
      .setStyle(settings.soundboardLogging ? ButtonStyle.Danger : ButtonStyle.Success);

    const toggleKickSoundboardButton = new ButtonBuilder()
      .setCustomId(`vcsettings:toggle-kick-soundboard-spam:${userId}`)
      .setLabel(
        settings.kickOnSoundboardSpam
          ? "Disable Kick on Soundboard Spam"
          : "Enable Kick on Soundboard Spam"
      )
      .setStyle(settings.kickOnSoundboardSpam ? ButtonStyle.Danger : ButtonStyle.Success);

    // Exact label requirement: DisableAutoModRoute / EnableAutoModRoute
    const toggleModAutoRouteButton = new ButtonBuilder()
      .setCustomId(`vcsettings:toggle-mod-auto-route:${userId}`)
      .setLabel(
        settings.mod_auto_route_enabled
          ? "DisableAutoModRoute"
          : "EnableAutoModRoute"
      )
      .setStyle(settings.mod_auto_route_enabled ? ButtonStyle.Danger : ButtonStyle.Success);

    // 1st Action Row: 5 buttons
    const buttonsRow1 = new ActionRowBuilder().addComponents(
      togglenotifyBadWordButton,
      togglenotifyLoudUserButton,
      togglesoundboardLoggingButton,
      toggleKickSoundboardButton,
      toggleModAutoRouteButton
    );

    // 2nd Action Row: 6th button
    const toggleVCLoggingButton = new ButtonBuilder()
      .setCustomId(`vcsettings:toggle-vc-logging:${userId}`)
      .setLabel(
        settings.vcLoggingEnabled ? "Disable VC Logging" : "Enable VC Logging"
      )
      .setStyle(settings.vcLoggingEnabled ? ButtonStyle.Danger : ButtonStyle.Success);

    const buttonsRow2 = new ActionRowBuilder().addComponents(
      toggleVCLoggingButton
    );

    const components = [vcRoleDropdown, buttonsRow1, buttonsRow2];

    // Component interaction → update the same message
    if (interactionOrMessage.isMessageComponent?.()) {
      return interactionOrMessage.update({
        content: contentMessage,
        components,
      });
    }

    // Slash command → reply or editReply
    if (interactionOrMessage.isChatInputCommand?.() || interactionOrMessage.isCommand?.()) {
      if (interactionOrMessage.replied || interactionOrMessage.deferred) {
        return interactionOrMessage.editReply({
          content: contentMessage,
          components,
        });
      }
      return interactionOrMessage.reply({
        content: contentMessage,
        components,
        ephemeral: isEphemeral,
      });
    }

    // Message-based command → ALWAYS send a NEW panel
    if (interactionOrMessage instanceof Message) {
      return interactionOrMessage.channel.send({
        content: contentMessage,
        components,
      });
    }

    // Fallback for other repliable interactions
    if (interactionOrMessage.isRepliable?.()) {
      return interactionOrMessage.reply({
        content: contentMessage,
        components,
        ephemeral: isEphemeral,
      });
    }
  } catch (error) {
    console.error(`[ERROR] showVCSettingsUI failed: ${error.message}`);
    await logErrorToChannel(
      interactionOrMessage.guild?.id,
      error.stack,
      interactionOrMessage.client,
      "showVCSettingsUI"
    );
    if (interactionOrMessage instanceof Message) {
      await interactionOrMessage.channel.send(
        "> <❌> An error occurred displaying VC settings. (INT_ERR_006)"
      );
    } else if (!interactionOrMessage.replied) {
      await interactionOrMessage.reply({
        content:
          "> <❌> An error occurred displaying VC settings. (INT_ERR_006)",
        ephemeral: true,
      });
    }
  }
}

async function handleVCSettingsFlow(interaction, action) {
  try {
    const guild = interaction.guild;
    if (!guild) return;
    const settings = await getSettingsForGuild(guild.id);

    switch (action) {
      case "toggle-badword": {
        const newValue = !settings.notifyBadWord;
        await updateSettingsForGuild(guild.id, { notifyBadWord: newValue }, guild);
        break;
      }
      case "toggle-loud-user": {
        const newValue = !settings.notifyLoudUser;
        await updateSettingsForGuild(guild.id, { notifyLoudUser: newValue }, guild);
        break;
      }
      case "select-log-viewers": {
        const selectedRoleId = interaction.values[0];
        const role = guild.roles.cache.get(selectedRoleId);
        if (!role) {
          await interaction.reply({
            content: "> <❌> Invalid role selected. Please try again.",
            ephemeral: true,
          });
          return;
        }
        await updateSettingsForGuild(guild.id, { voiceCallPingRoleId: selectedRoleId }, guild);
        break;
      }
      case "toggle-soundboard-logging": {
        const newStatus = !settings.soundboardLogging;
        await updateSettingsForGuild(guild.id, { soundboardLogging: newStatus }, guild);
        break;
      }
      case "toggle-kick-soundboard-spam": {
        const newStatus = !settings.kickOnSoundboardSpam;
        await updateSettingsForGuild(guild.id, { kickOnSoundboardSpam: newStatus }, guild);
        break;
      }
      case "toggle-mod-auto-route": {
        const newStatus = !settings.mod_auto_route_enabled;
        await updateSettingsForGuild(guild.id, { mod_auto_route_enabled: newStatus }, guild);
        break;
      }
      case "toggle-vc-logging": {
        const newStatus = !settings.vcLoggingEnabled;
        await updateSettingsForGuild(guild.id, { vcLoggingEnabled: newStatus }, guild);
        break;
      }
      default:
        await interaction.reply({
          content: "> <❌> Unrecognized VC settings action.",
          ephemeral: true,
        });
        return;
    }

    // Re-render with fresh settings (updates the SAME message for component interactions)
    await showVCSettingsUI(interaction, true);
  } catch (error) {
    console.error(`[ERROR] handleVCSettingsFlow failed: ${error.message}`);
    await logErrorToChannel(
      interaction.guild?.id,
      error.stack,
      interaction.client,
      "handleVCSettingsFlow"
    );
    if (!interaction.replied) {
      await interaction.reply({
        content:
          "> <❌> An error occurred processing VC settings. (INT_ERR_006)",
        ephemeral: true,
      });
    }
  }
}

module.exports = {
  showVCSettingsUI,
  handleVCSettingsFlow,
};