const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ChannelType,
  Message,
  ComponentType,
  PermissionsBitField,
} = require("discord.js");

const {
  getSettingsForGuild,
  updateSettingsForGuild,
  updateChannelPermissionsForGuild,
} = require("../settings.cjs");

const { createRoleDropdown, logErrorToChannel, requiredManagerPermissions } = require("./helpers.cjs");

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ───────────────────────────────────────────────────────────────────────────────
// Anti-double-fire guard: block rapid duplicate invocations per (guild:user)
// ───────────────────────────────────────────────────────────────────────────────
const IN_FLIGHT_WINDOW_MS = 4000;
const inflight = new Map(); // key -> timestamp

function makeKey(guildId, userId) {
  return `${guildId || "noguild"}:${userId || "nouser"}:vcsettings`;
}

function isDuplicateCall(guildId, userId) {
  const key = makeKey(guildId, userId);
  const now = Date.now();
  const last = inflight.get(key);
  if (last && now - last < IN_FLIGHT_WINDOW_MS) return true;
  inflight.set(key, now);
  // Clean up later
  setTimeout(() => {
    if (inflight.get(key) === now) inflight.delete(key);
  }, IN_FLIGHT_WINDOW_MS);
  return false;
}

// ───────────────────────────────────────────────────────────────────────────────
// Safe reply helpers for Interaction or Message
// ───────────────────────────────────────────────────────────────────────────────
async function safeReply(target, payload, { ephemeral = true } = {}) {
  // If it's an Interaction
  if (typeof target?.isRepliable === "function" && target.isRepliable()) {
    const opts = { ...payload, ephemeral, fetchReply: true };
    if (target.deferred || target.replied) {
      return await target.editReply(opts);
    } else {
      return await target.reply(opts);
    }
  }

  // If it's a Message
  if (target instanceof Message) {
    return await target.reply(payload);
  }

  // Fallback
  return await target?.channel?.send?.(payload);
}

function ensureManagerPerms(member) {
  // If you use a custom requiredManagerPermissions bitfield from helpers
  return member?.permissions?.has?.(requiredManagerPermissions ?? PermissionsBitField.Flags.ManageGuild);
}

// ───────────────────────────────────────────────────────────────────────────────
// UI builders
// ───────────────────────────────────────────────────────────────────────────────
function buildButtons(settings) {
  const autoModDisabled = !!(settings?.autoModRouteDisabled ?? false);

  const disableAutoModButton = new ButtonBuilder()
    .setCustomId("vcsettings:disable_automod_route")
    // Label exactly as requested:
    .setLabel("DisableAutoModRoute")
    .setStyle(autoModDisabled ? ButtonStyle.Secondary : ButtonStyle.Danger);

  const saveButton = new ButtonBuilder()
    .setCustomId("vcsettings:save")
    .setLabel("Save")
    .setStyle(ButtonStyle.Primary);

  const refreshPermsButton = new ButtonBuilder()
    .setCustomId("vcsettings:sync_permissions")
    .setLabel("Sync Channel Permissions")
    .setStyle(ButtonStyle.Secondary);

  const closeButton = new ButtonBuilder()
    .setCustomId("vcsettings:close")
    .setLabel("Close")
    .setStyle(ButtonStyle.Secondary);

  return [
    new ActionRowBuilder().addComponents(disableAutoModButton, saveButton, refreshPermsButton, closeButton),
  ];
}

function buildRoleRow(guild, settings) {
  // Expect createRoleDropdown(guild, selectedRoleIds?) to return a StringSelectMenuBuilder
  const selectedRoleIds = settings?.managerRoleIds ?? []; // adjust to your schema
  const roleSelect = createRoleDropdown(guild, selectedRoleIds)
    .setCustomId("vcsettings:roles")
    .setMinValues(0)
    .setMaxValues(25); // let them pick many if needed

  return new ActionRowBuilder().addComponents(roleSelect);
}

function renderContent(settings) {
  const autoModDisabled = !!(settings?.autoModRouteDisabled ?? false);
  const lines = [
    "### VC Tools — Settings",
    "",
    `• AutoMod Route: **${autoModDisabled ? "Disabled" : "Enabled"}**`,
    "• Select manager roles and press **Save**.",
  ];
  return lines.join("\n");
}

// ───────────────────────────────────────────────────────────────────────────────
// Public Entry: showVCSettingsUI
// ───────────────────────────────────────────────────────────────────────────────
async function showVCSettingsUI(interactionOrMessage, isEphemeral = true) {
  try {
    const guild = interactionOrMessage.guild ?? interactionOrMessage?.member?.guild;
    const userId = interactionOrMessage.user?.id ?? interactionOrMessage.author?.id;
    const guildId = guild?.id;

    if (!guild) {
      await safeReply(interactionOrMessage, { content: "This must be used in a server.", components: [] }, { ephemeral: true });
      return;
    }

    // Hard-stop rapid duplicate invocations
    if (isDuplicateCall(guildId, userId)) {
      // If this duplicate is an interaction, quietly acknowledge to avoid "This interaction failed"
      if (typeof interactionOrMessage?.isRepliable === "function" && interactionOrMessage.isRepliable() && !interactionOrMessage.replied && !interactionOrMessage.deferred) {
        try { await interactionOrMessage.deferReply({ ephemeral: true }); } catch { }
      }
      return;
    }

    // Permissions check first, no partial UI sends before we know perms
    const member = interactionOrMessage.member ?? (await guild.members.fetch(userId).catch(() => null));
    if (!ensureManagerPerms(member)) {
      await safeReply(interactionOrMessage, { content: "You need server manager permissions to open VC Tools settings.", components: [] }, { ephemeral: true });
      return;
    }

    // Fetch settings BEFORE first render — prevents "first fire missing button"
    const settings = await getSettingsForGuild(guildId);

    // Build full UI now
    const components = [
      buildRoleRow(guild, settings),
      ...buildButtons(settings),
    ];

    const content = renderContent(settings);

    // Single reply path
    const msg = await safeReply(
      interactionOrMessage,
      {
        content,
        components,
      },
      { ephemeral: !!isEphemeral }
    );

    // Start a scoped collector on THIS message only
    const collector = msg.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 5 * 60 * 1000,
      filter: (i) => i.user.id === userId && i.customId.startsWith("vcsettings:"),
    });

    // Also collect select changes for roles
    const roleCollector = msg.createMessageComponentCollector({
      componentType: ComponentType.StringSelect,
      time: 5 * 60 * 1000,
      filter: (i) => i.user.id === userId && i.customId === "vcsettings:roles",
    });

    // Keep an in-memory draft we save on "Save"
    const draft = {
      managerRoleIds: Array.isArray(settings?.managerRoleIds) ? [...settings.managerRoleIds] : [],
      autoModRouteDisabled: !!(settings?.autoModRouteDisabled ?? false),
    };

    roleCollector.on("collect", async (i) => {
      try {
        draft.managerRoleIds = i.values;
        await i.deferUpdate(); // update silently, keep UI
      } catch (e) {
        await logErrorToChannel(guild, e);
      }
    });

    collector.on("collect", async (i) => {
      try {
        const id = i.customId;

        if (id === "vcsettings:disable_automod_route") {
          draft.autoModRouteDisabled = !draft.autoModRouteDisabled;
          await i.deferUpdate();

          // Update UI immediately to reflect the toggle
          const preview = { ...settings, autoModRouteDisabled: draft.autoModRouteDisabled, managerRoleIds: draft.managerRoleIds };
          await msg.edit({ content: renderContent(preview), components: [buildRoleRow(guild, preview), ...buildButtons(preview)] });
          return;
        }

        if (id === "vcsettings:save") {
          // Persist to DB
          await updateSettingsForGuild(guildId, {
            managerRoleIds: draft.managerRoleIds,
            autoModRouteDisabled: draft.autoModRouteDisabled,
          });

          await i.reply({ content: "Saved ✅", ephemeral: true });

          // Reflect new saved state in UI
          settings.managerRoleIds = draft.managerRoleIds;
          settings.autoModRouteDisabled = draft.autoModRouteDisabled;

          await msg.edit({ content: renderContent(settings), components: [buildRoleRow(guild, settings), ...buildButtons(settings)] });
          return;
        }

        if (id === "vcsettings:sync_permissions") {
          await i.deferReply({ ephemeral: true });
          await updateChannelPermissionsForGuild(guildId);
          await i.editReply("Channel permissions synced ✅");
          return;
        }

        if (id === "vcsettings:close") {
          await i.deferUpdate();
          // Disable components
          const disabledRows = msg.components.map((row) => {
            const newRow = ActionRowBuilder.from(row);
            newRow.components = newRow.components.map((c) => ButtonBuilder.from(c).setDisabled(true));
            return newRow;
          });
          try {
            await msg.edit({ components: disabledRows });
          } catch { }
          collector.stop("closed");
          roleCollector.stop("closed");
          return;
        }
      } catch (e) {
        await logErrorToChannel(guild, e);
        try {
          if (!i.replied && !i.deferred) await i.reply({ content: "Something went wrong. Try again.", ephemeral: true });
        } catch { }
      }
    });

    const endBoth = async () => {
      // On timeout/end, just disable components to avoid stale clicks
      try {
        const disabled = msg.components.map((row) => {
          const newRow = ActionRowBuilder.from(row);
          newRow.components = newRow.components.map((c) => {
            const base = c.data?.type === ComponentType.StringSelect ? StringSelectMenuBuilder.from(c) : ButtonBuilder.from(c);
            return base.setDisabled(true);
          });
          return newRow;
        });
        await msg.edit({ components: disabled });
      } catch { }
    };

    collector.on("end", endBoth);
    roleCollector.on("end", endBoth);
  } catch (err) {
    try {
      const g = interactionOrMessage.guild ?? interactionOrMessage?.member?.guild;
      await logErrorToChannel(g, err);
    } catch { }
    // Best-effort user feedback if possible
    try {
      await safeReply(interactionOrMessage, { content: "Error opening settings. Check logs.", components: [] }, { ephemeral: true });
    } catch { }
  }
}

module.exports = {
  showVCSettingsUI,
};
