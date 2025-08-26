// logic/consent_logic.cjs
const {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Message,
  PermissionFlagsBits,
} = require("discord.js");

const {
  getSettingsForGuild,
  updateSettingsForGuild,
} = require("../settings.cjs");

const {
  requiredManagerPermissions,
  logErrorToChannel,
} = require("./helpers.cjs");

/** Normalize settings keys (snake or camel) + defaults */
function getConsentState(settings = {}) {
  const mode =
    settings.consent_delivery_mode ??
    settings.consent_delivery_mode ??
    "server_default";
  const channelId =
    settings.consent_channel_id ?? settings.consent_channel_id ?? null;
  return { mode, channelId };
}

/** Build the two dropdown rows */
function buildConsentComponents(guild, userId, state) {
  const { mode, channelId } = state;

  // Delivery mode dropdown
  const modeMenu = new StringSelectMenuBuilder()
    .setCustomId(`consent:select-mode:${userId}`)
    .setPlaceholder("Choose consent delivery method")
    .addOptions(
      {
        label: "Direct Message (DM user)",
        value: "dm",
        description: "Send consent prompts in the user’s DMs.",
        default: mode === "dm",
      },
      {
        label: "Server default channel",
        value: "server_default",
        description: "Use your server’s default/system channel.",
        default: mode === "server_default",
      },
      {
        label: "Specific channel…",
        value: "specific_channel",
        description: "Always send to a channel you choose below.",
        default: mode === "specific_channel",
      }
    );

  const modeRow = new ActionRowBuilder().addComponents(modeMenu);

  // Channel dropdown (text channels only)
  const channelOptions = guild.channels.cache
    .filter((ch) => ch.type === ChannelType.GuildText)
    .map((ch) => ({
      label: `#${String(ch.name).slice(0, 100)}`,
      value: String(ch.id),
      default: String(ch.id) === String(channelId),
    }));

  const channelMenu = new StringSelectMenuBuilder()
    .setCustomId(`consent:select-channel:${userId}`)
    .setPlaceholder(
      mode === "specific_channel"
        ? "Select the consent channel…"
        : "Select the consent channel (enable ‘Specific channel’ first)"
    )
    .setMinValues(1)
    .setMaxValues(1)
    .setOptions(channelOptions)
    .setDisabled(mode !== "specific_channel");

  const channelRow = new ActionRowBuilder().addComponents(channelMenu);

  return [modeRow, channelRow];
}

/** Compose the message content */
function buildConsentContent(guild, state) {
  const { mode, channelId } = state;
  const channelName =
    channelId && guild.channels.cache.get(channelId)
      ? `#${guild.channels.cache.get(channelId).name}`
      : "Not set";

  return [
    "## ◈ Consent Settings",
    `> **Delivery Method:** \`${mode}\``,
    `> **Assigned Channel:** ${mode === "specific_channel" ? channelName : "`—`"}`,
    "",
    "-# VC Tools will fallback to the next best option if your delivery method fails.",
  ].join("\n");
}

/**
 * Public: Show the Consent Settings UI
 */
async function showConsentSettingsUI(interactionOrMessage, isEphemeral = false) {
  try {
    const guild = interactionOrMessage.guild;
    if (!guild) return;

    if (!(await requiredManagerPermissions(interactionOrMessage))) {
      const msg =
        "> <❇️> You do not have the required permissions to do this. (CMD_ERR_008)";
      if (interactionOrMessage instanceof Message) {
        return interactionOrMessage.channel.send(msg);
      } else {
        return interactionOrMessage.reply({ content: msg, ephemeral: true });
      }
    }

    const settings = (await getSettingsForGuild(guild.id)) || {};
    const state = getConsentState(settings);

    const userId =
      interactionOrMessage.user?.id || interactionOrMessage.author?.id;

    const components = buildConsentComponents(guild, userId, state);
    const content = buildConsentContent(guild, state);

    if (interactionOrMessage.isRepliable?.()) {
      if (interactionOrMessage.replied || interactionOrMessage.deferred) {
        await interactionOrMessage.editReply({ content, components });
      } else {
        await interactionOrMessage.reply({ content, components, ephemeral: isEphemeral });
      }
    } else {
      await interactionOrMessage.channel.send({ content, components });
    }
  } catch (error) {
    console.error("[ERROR] showConsentSettingsUI:", error);
    await logErrorToChannel(
      interactionOrMessage.guild?.id,
      error.stack,
      interactionOrMessage.client,
      "showConsentSettingsUI"
    );
    if (interactionOrMessage.isRepliable?.()) {
      if (!interactionOrMessage.replied) {
        await interactionOrMessage.reply({
          content: "> <❌> Failed to display Consent settings. (INT_ERR_006)",
          ephemeral: true,
        });
      }
    }
  }
}

/**
 * Public: Handle select/button interactions for Consent Settings
 */
async function handleConsentSettingChange(interaction) {
  try {
    const guild = interaction.guild;
    if (!guild) return;

    // Owner guard: only the user who opened the UI may interact
    const parts = interaction.customId.split(":"); // e.g. consent:select-mode:<userId>
    const ownerId = parts[2];
    if (ownerId && ownerId !== interaction.user.id) {
      return interaction.reply({
        content: "> <❌> You can’t interact with this component. (INT_ERR_004)",
        ephemeral: true,
      });
    }

    // Watchdog to avoid toast
    const watchdog = setTimeout(async () => {
      try {
        if (!interaction.deferred && !interaction.replied) {
          await interaction.deferUpdate().catch(() => { });
        }
      } catch { }
    }, 2000);

    const settings = (await getSettingsForGuild(guild.id)) || {};
    const state = getConsentState(settings);

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId.startsWith("consent:select-mode:")) {
        const newMode = interaction.values?.[0];
        await updateSettingsForGuild(guild.id, {
          consent_delivery_mode: newMode,
        });
        // If switching away from specific_channel, keep channelId but it won’t be used.
        await interaction.update({
          content: buildConsentContent(guild, { mode: newMode, channelId: state.channelId }),
          components: buildConsentComponents(guild, ownerId, {
            mode: newMode,
            channelId: state.channelId,
          }),
        });
      } else if (interaction.customId.startsWith("consent:select-channel:")) {
        const newChannelId = interaction.values?.[0] ?? null;
        // Set channel ID and ensure mode is specific_channel (user intent)
        const newState = {
          mode: "specific_channel",
          channelId: newChannelId,
        };
        await updateSettingsForGuild(guild.id, {
          consent_delivery_mode: "specific_channel",
          consent_channel_id: newChannelId,
        });
        await interaction.update({
          content: buildConsentContent(guild, newState),
          components: buildConsentComponents(guild, ownerId, newState),
        });
      }
    } else if (interaction.isButton()) {
      if (interaction.customId.startsWith("consent:help:")) {
        return interaction.reply({
          ephemeral: true,
          content: [
            "**Consent delivery options**",
            "- **DM**: Sends consent prompts to the user’s Direct Messages.",
            "- **Server default**: Uses your server’s default/system channel.",
            "- **Specific channel**: Sends to one channel you choose (select below).",
          ].join("\n"),
        });
      }
    }

    clearTimeout(watchdog);
  } catch (error) {
    console.error("[ERROR] handleConsentSettingChange:", error);
    await logErrorToChannel(guild?.id, error.stack, interaction.client, "handleConsentSettingChange");
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "> <❌> Failed to update Consent settings.",
        ephemeral: true,
      });
    }
  }
}

function canBotSend(channel) {
  if (!channel?.guild?.members?.me) return false;
  const mePerms = channel.permissionsFor(channel.guild.members.me);
  if (!mePerms) return false;
  const canView = mePerms.has(PermissionFlagsBits.ViewChannel);
  const canSend = channel.isTextBased?.() && mePerms.has(PermissionFlagsBits.SendMessages);
  return Boolean(canView && canSend);
}

// --- resolver: pick DM vs channel (with robust fallbacks) ---
async function resolveConsentDestination(guild, user) {
  const { getSettingsForGuild } = require("../settings.cjs"); // local import to avoid cycles
  const settings = (await getSettingsForGuild(guild.id)) || {};
  const { mode, channelId } = getConsentState(settings);

  // 1) DM
  if (mode === "dm") {
    return { type: "dm", user };
  }

  // 2) Specific channel
  if (mode === "specific_channel" && channelId) {
    const ch =
      guild.channels.cache.get(channelId) ||
      (await guild.channels.fetch(channelId).catch(() => null));
    if (ch && canBotSend(ch)) return { type: "channel", channel: ch };
  }

  // 3) Server default/system channel
  if (guild.systemChannel && canBotSend(guild.systemChannel)) {
    return { type: "channel", channel: guild.systemChannel };
  }

  // 4) First text channel the bot can speak in
  const fallback = guild.channels.cache
    .filter((c) => c.type === ChannelType.GuildText && canBotSend(c))
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .first();
  if (fallback) return { type: "channel", channel: fallback };

  // 5) Ultimate fallback: DM
  return { type: "dm", user };
}

// --- sender: use resolver, send, and auto-fallback ---
async function sendConsentPrompt({
  guild,
  user,
  client,
  content,
  embeds,
  components,
  files,
  mentionUserInChannel = true,
}) {
  const dest = await resolveConsentDestination(guild, user);

  // If posting in a channel, optionally mention the user so they see it.
  const maybeMention =
    dest.type === "channel" && mentionUserInChannel ? `<@${user.id}>\n ` : "";

  try {
    if (dest.type === "dm") {
      return await user.send({ content, embeds, components, files });
    } else {
      return await dest.channel.send({
        content: maybeMention + (content || ""),
        embeds,
        components,
        files,
      });
    }
  } catch (err) {
    // If channel send failed, try DM as a last resort.
    try {
      if (dest.type !== "dm") {
        return await user.send({ content, embeds, components, files });
      }
    } catch (_) {
      // Log and give up quietly
      try {
        const { logErrorToChannel } = require("./helpers.cjs");
        await logErrorToChannel(guild.id, err?.stack || String(err), client, "sendConsentPrompt");
      } catch { }
      return null;
    }
  }
  return null;
}

module.exports = {
  showConsentSettingsUI,
  handleConsentSettingChange,
  resolveConsentDestination,
  sendConsentPrompt,
};