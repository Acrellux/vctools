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
    settings.consentDeliveryMode ??
    settings.consent_delivery_mode ??
    "server_default";

  const channelId =
    settings.consentChannelId ??
    settings.consent_channel_id ??
    null;

  return { mode, channelId };
}

/** Build the two dropdown rows (channel selector is ALWAYS enabled) */
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
    .setPlaceholder("Select the consent channel…")
    .setMinValues(1)
    .setMaxValues(1)
    .setOptions(channelOptions)
    // 🔓 Always enabled (you can set a channel regardless of mode)
    .setDisabled(false);

  const channelRow = new ActionRowBuilder().addComponents(channelMenu);

  return [modeRow, channelRow];
}

/** Compose the message content */
function buildConsentContent(guild, state) {
  const { mode, channelId } = state;

  // Always show a clickable mention if a channel is set, regardless of mode.
  const channelDisplay = channelId ? `<#${channelId}>` : "`—`";

  return [
    "## ◈ Consent Settings",
    `> **Delivery Method:** \`${mode}\``,
    `> **Assigned Channel:** ${channelDisplay}`,
    "",
    "-# VC Tools will fall back to the next best option if delivery fails.",
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
          consent_delivery_mode: newMode, // snake_case for DB
        });
        await interaction.update({
          content: buildConsentContent(guild, { mode: newMode, channelId: state.channelId }),
          components: buildConsentComponents(guild, ownerId, {
            mode: newMode,
            channelId: state.channelId,
          }),
        });
      } else if (interaction.customId.startsWith("consent:select-channel:")) {
        const newChannelId = interaction.values?.[0] ?? null;
        const newState = {
          mode: state.mode,
          channelId: newChannelId,
        };
        await updateSettingsForGuild(guild.id, {
          // store snake_case columns in DB
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
            "- **Specific channel**: Sends to one channel you choose (always selectable).",
          ].join("\n"),
        });
      }
    }

    clearTimeout(watchdog);
  } catch (error) {
    console.error("[ERROR] handleConsentSettingChange:", error);
    await logErrorToChannel(interaction.guild?.id, error.stack, interaction.client, "handleConsentSettingChange");
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "> <❌> Failed to update Consent settings.",
        ephemeral: true,
      });
    }
  }
}

/* ----------------------- helpers for delivery ----------------------- */

function canBotSend(channel) {
  if (!channel?.guild?.members?.me) return false;
  if (
    channel.type !== ChannelType.GuildText && // exclude news/forums/stage/threads
    channel.type !== ChannelType.GuildAnnouncement
  ) return false;
  if (channel.type === ChannelType.GuildAnnouncement) return false;

  const mePerms = channel.permissionsFor(channel.guild.members.me);
  if (!mePerms) return false;
  const canView = mePerms.has(PermissionFlagsBits.ViewChannel);
  const canSend = channel.isTextBased?.() && mePerms.has(PermissionFlagsBits.SendMessages);
  return Boolean(canView && canSend);
}

/** Find the most recent PUBLIC text channel where the member has a message */
async function findMostRecentPublicMessageChannel(guild, userId, {
  channelScanLimit = 25,
  perChannelMessages = 50,
} = {}) {
  const { SnowflakeUtil } = require("discord.js");

  const candidates = guild.channels.cache.filter((c) => {
    const isPublicText =
      c.type === ChannelType.GuildText &&
      canBotSend(c);
    return isPublicText;
  });

  const sorted = [...candidates.values()].sort((a, b) => {
    const ta = a.lastMessageId ? SnowflakeUtil.timestampFrom(a.lastMessageId) : 0;
    const tb = b.lastMessageId ? SnowflakeUtil.timestampFrom(b.lastMessageId) : 0;
    return tb - ta;
  });

  for (let i = 0; i < Math.min(sorted.length, channelScanLimit); i++) {
    const ch = sorted[i];
    try {
      const msgs = await ch.messages.fetch({ limit: perChannelMessages });
      const hit = msgs.find((m) => m.author?.id === userId);
      if (hit) return ch;
    } catch {
      // ignore fetch errors and continue
    }
  }
  return null;
}

/* ------------------------ destination resolver ------------------------ */
/**
 * New fallback order (independent of selected mode):
 * 1) DM
 * 2) Specified channel (if set & speakable)
 * 3) Last public channel the member messaged
 * 4) First public speakable text channel
 * 5) Nothing (caller should log)
 */
async function resolveConsentDestination(guild, user) {
  const settings = (await getSettingsForGuild(guild.id)) || {};
  const { channelId } = getConsentState(settings);

  // 1) DM first
  // We don't "return" here immediately because we need to actually attempt sending to know if it fails.
  // The actual sending + fallback is handled in sendConsentPrompt where we can try/catch.
  // Here, we just compute non-DM fallbacks.

  // 2) Specified channel (even if mode isn’t specific_channel)
  if (channelId) {
    const ch =
      guild.channels.cache.get(channelId) ||
      (await guild.channels.fetch(channelId).catch(() => null));
    if (ch && canBotSend(ch)) {
      return { preferDM: true, channel: ch };
    }
  }

  // 3) Last public channel member messaged in
  const lastPublic = await findMostRecentPublicMessageChannel(guild, user.id).catch(() => null);
  if (lastPublic) {
    return { preferDM: true, channel: lastPublic };
  }

  // 4) First public speakable text channel
  const firstSpeakable = guild.channels.cache
    .filter((c) => c.type === ChannelType.GuildText && canBotSend(c))
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .first();
  if (firstSpeakable) {
    return { preferDM: true, channel: firstSpeakable };
  }

  // 5) No public option available
  return { preferDM: true, channel: null };
}

/* --------------------------- sender w/ fallbacks --------------------------- */
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
  // Compute non-DM fallbacks first
  const dest = await resolveConsentDestination(guild, user);

  // 1) Try DM
  try {
    return await user.send({ content, embeds, components, files });
  } catch (_) {
    // 2) Specified/derived channel path
    try {
      if (dest.channel && canBotSend(dest.channel)) {
        const maybeMention = mentionUserInChannel ? `-# <@${user.id}>\n` : "";
        return await dest.channel.send({
          content: maybeMention + (content || ""),
          embeds,
          components,
          files,
        });
      }
    } catch (err) {
      // fall through to log
      try {
        await logErrorToChannel(guild.id, err?.stack || String(err), client, "sendConsentPrompt");
      } catch { }
      return null;
    }

    // 3) Nothing else to try — log and bail
    try {
      await logErrorToChannel(
        guild.id,
        "Consent prompt could not be delivered: no public destination available.",
        client,
        "sendConsentPrompt"
      );
    } catch { }
    return null;
  }
}

module.exports = {
  showConsentSettingsUI,
  handleConsentSettingChange,
  resolveConsentDestination,
  sendConsentPrompt,
};