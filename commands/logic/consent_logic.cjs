// logic/consent_logic.cjs
const {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Message,
  PermissionFlagsBits,
  SnowflakeUtil,
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

/** Helpers */
const MAX_SELECT_OPTIONS = 25;

function sortGuildTextChannels(guild) {
  // Stable sort: by category position, then channel position
  return guild.channels.cache
    .filter((c) => c.type === ChannelType.GuildText)
    .sort((a, b) => {
      if (a.parentId === b.parentId) return a.rawPosition - b.rawPosition;
      const aP = a.parent ?? { rawPosition: -1 };
      const bP = b.parent ?? { rawPosition: -1 };
      return aP.rawPosition - bP.rawPosition;
    });
}

function makeOptionForChannel(ch, selectedId) {
  return new StringSelectMenuOptionBuilder()
    .setLabel(`#${String(ch.name).slice(0, 100)}`)
    .setValue(String(ch.id))
    .setDefault(String(ch.id) === String(selectedId));
}

function dedupeOptionsKeepFirst(options) {
  const seen = new Set();
  const out = [];
  for (const opt of options) {
    const v = opt.data.value;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(opt);
  }
  return out;
}

/** Build the two dropdown rows (channel selector is ALWAYS enabled) */
function buildConsentComponents(guild, userId, state) {
  const { mode, channelId } = state;

  // ───────── Delivery mode dropdown ─────────
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

  // ───────── Channel dropdown (max 25 options) ─────────
  const sortedText = sortGuildTextChannels(guild);
  const total = sortedText.size;

  // Build base list from sorted channels
  let options = [];
  for (const [, ch] of sortedText) {
    options.push(makeOptionForChannel(ch, channelId));
    if (options.length >= MAX_SELECT_OPTIONS) break; // cap
  }

  // If we have a saved channel that's not in the first 25, force-insert it at the top
  if (channelId && !options.find((o) => o.data.value === String(channelId))) {
    const selectedChannel =
      guild.channels.cache.get(channelId) ||
      null;
    if (selectedChannel && selectedChannel.type === ChannelType.GuildText) {
      options.unshift(makeOptionForChannel(selectedChannel, channelId));
      options = dedupeOptionsKeepFirst(options).slice(0, MAX_SELECT_OPTIONS);
    }
  }

  // Placeholder reflects truncation
  const truncated = total > MAX_SELECT_OPTIONS;
  const placeholder = total === 0
    ? "No text channels found"
    : truncated
      ? `Select the consent channel… (showing ${MAX_SELECT_OPTIONS} of ${total})`
      : "Select the consent channel…";

  const channelMenu = new StringSelectMenuBuilder()
    .setCustomId(`consent:select-channel:${userId}`)
    .setPlaceholder(placeholder)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(options)
    .setDisabled(total === 0); // disable if no options

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
    "-# *Log into the [Dashboard](<https://vctools.app/dashboard>) to avoid the 25 dropdown option limit.*",
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
          consent_channel_id: newChannelId, // snake_case for DB
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

  // Only true public text channels (no announcements/forums/threads)
  if (channel.type !== ChannelType.GuildText) return false;

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
  const candidates = guild.channels.cache.filter(
    (c) => c.type === ChannelType.GuildText && canBotSend(c)
  );

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
      // ignore and continue
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
async function resolveConsentDestination(guild, member, settings) {
  const s = settings || (await getSettingsForGuild(guild.id)) || {};
  const { mode, channelId } = getConsentState(s);

  // Helper: first speakable public text channel
  const firstSpeakable = guild.channels.cache
    .filter((c) => c.type === ChannelType.GuildText && canBotSend(c))
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .first();

  // Prefer channel according to mode
  let preferredChannel = null;

  if (mode === "specific_channel" && channelId) {
    const ch =
      guild.channels.cache.get(channelId) ||
      (await guild.channels.fetch(channelId).catch(() => null));
    if (ch && canBotSend(ch)) preferredChannel = ch;
  } else if (mode === "server_default") {
    const sys = guild.systemChannel;
    if (sys && canBotSend(sys)) preferredChannel = sys;
  }

  // Fallbacks
  if (!preferredChannel) {
    const lastPublic = await findMostRecentPublicMessageChannel(
      guild,
      member?.id
    ).catch(() => null);
    preferredChannel = lastPublic || firstSpeakable || null;
  }

  return {
    // DM first only if the admin explicitly chose DM
    preferDM: mode === "dm",
    channel: preferredChannel,
  };
}

/* --------------------------- sender w/ fallbacks --------------------------- */
async function sendConsentPrompt({
  guild,
  user,
  member,
  client,
  settings,
  destination,
  content,
  components,
  embeds,
  files,
  mentionUserInChannel = true,
}) {
  const dest =
    destination ||
    (await resolveConsentDestination(
      guild,
      member || (await guild.members.fetch(user.id).catch(() => null)),
      settings
    ));

  if (!dest) return null;

  const tryDMFirst = !!dest.preferDM;

  const sendDM = async () =>
    user.send({ content, embeds, components, files });

  const sendChannel = async () => {
    if (!dest.channel || !canBotSend(dest.channel))
      throw new Error("No speakable channel");
    const maybeMention = mentionUserInChannel ? `-# <@${user.id}>\n` : "";
    return dest.channel.send({
      content: maybeMention + (content || ""),
      embeds,
      components,
      files,
    });
  };

  // Attempt in preferred order, then swap
  try {
    return tryDMFirst ? await sendDM() : await sendChannel();
  } catch (e1) {
    try {
      return tryDMFirst ? await sendChannel() : await sendDM();
    } catch (e2) {
      try {
        await logErrorToChannel(
          guild.id,
          e2?.stack || String(e2),
          client,
          "sendConsentPrompt"
        );
      } catch { }
      return null;
    }
  }
}

module.exports = {
  showConsentSettingsUI,
  handleConsentSettingChange,
  resolveConsentDestination,
  sendConsentPrompt,
};