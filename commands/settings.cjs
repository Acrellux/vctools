/*******************************************************
 * settings.cjs (UPDATED)
 *******************************************************/
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");

// ****************************************
// 1. SUPABASE SETUP
// ****************************************
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("[ERROR] Missing Supabase environment variables!");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ****************************************
// 2. FAIL-OPEN (BYPASSERS)
// ****************************************
function errMsg(err) {
  return (err && (err.stack || err.message)) || String(err || "");
}

function looksLikeBillingOrQuota(err) {
  const msg = errMsg(err);
  return /402|payment required|quota|exceeded|over.*limit|project.*paused|subscription|billing/i.test(
    msg
  );
}

const FAIL_OPEN = {
  enabled: false,
  reason: "",
  since: 0,
};

function enableFailOpen(reason) {
  if (!FAIL_OPEN.enabled) {
    console.warn("[FAIL-OPEN] ENABLED:", reason);
  }
  FAIL_OPEN.enabled = true;
  FAIL_OPEN.reason = reason || "unknown";
  FAIL_OPEN.since = Date.now();
}

function disableFailOpen() {
  if (FAIL_OPEN.enabled) {
    console.log("[FAIL-OPEN] DISABLED");
  }
  FAIL_OPEN.enabled = false;
  FAIL_OPEN.reason = "";
  FAIL_OPEN.since = 0;
}

if (process.env.FORCE_FAIL_OPEN === "1") {
  enableFailOpen("FORCE_FAIL_OPEN=1");
}

// Safe wrapper (never throws; can trip fail-open)
async function withRescue(fn, context, fallback) {
  try {
    return await fn();
  } catch (err) {
    if (looksLikeBillingOrQuota(err)) {
      enableFailOpen(`${context} billing/quota`);
      return fallback;
    }
    console.error(`[ERROR][${context}]`, errMsg(err));
    return fallback;
  }
}

// ****************************************
// 3. DEFAULT SETTINGS (single source of truth)
// ****************************************
const DEFAULT_SETTINGS = Object.freeze({
  channelId: null,
  transcriptionEnabled: false,
  allowedRoleId: null,
  setupComplete: false,

  errorLogsChannelId: null,
  errorLogsRoleId: null,
  errorLogsEnabled: false,

  voiceCallPingRoleId: null,

  notifyBadWord: false,
  notifyLoudUser: false,
  notifyActivityReports: false,

  moderatorRoleId: null,
  adminRoleId: null,

  safeChannels: [],
  safeUsers: [],

  soundboardLogging: false,
  kickOnSoundboardSpam: false,

  filterCustom: [],
  filterLevel: "moderate",

  vcLoggingEnabled: false,
  vcLoggingChannelId: null,
  vcModeratorRoleId: null,

  prefixes: { slash: true, exclamation: true, greater: true },

  consent_delivery_mode: "dm",
  consent_channel_id: null,

  mod_auto_route_enabled: false,
});

// Make sure arrays/objects don’t get shared by reference
function buildDefaultSettingsRow(guildId) {
  return {
    guildId,
    ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
  };
}

// ****************************************
// 4. GUILD SETTINGS FUNCTIONS
// ****************************************

/**
 * Retrieves the settings for a specific guild.
 * If none exist, inserts a row of default settings.
 *
 * FAIL-OPEN: returns defaults (no DB writes).
 */
async function getSettingsForGuild(guildId) {
  if (!guildId) return null;

  if (FAIL_OPEN.enabled) {
    return buildDefaultSettingsRow(guildId);
  }

  return await withRescue(
    async () => {
      const { data, error } = await supabase
        .from("guild_settings")
        .select("*")
        .eq("guildId", guildId)
        .maybeSingle();

      // Row missing → initialize defaults
      if (!data && !error) {
        console.warn(
          `[WARNING] No settings found for ${guildId}. Initializing default settings.`
        );

        const defaults = buildDefaultSettingsRow(guildId);

        const { error: insertError } = await supabase
          .from("guild_settings")
          .insert([defaults]);

        if (insertError) {
          if (looksLikeBillingOrQuota(insertError)) {
            enableFailOpen("getSettingsForGuild insert billing/quota");
            return defaults;
          }
          console.error(
            `[ERROR] Failed to initialize settings for ${guildId}:`,
            insertError
          );
          return null;
        }

        return defaults;
      }

      if (error) {
        if (looksLikeBillingOrQuota(error)) {
          enableFailOpen("getSettingsForGuild select billing/quota");
          return buildDefaultSettingsRow(guildId);
        }
        console.error(`[ERROR] Could not fetch settings for ${guildId}:`, error);
        return null;
      }

      // Merge in any newly-added defaults without overwriting existing values
      const merged = { ...buildDefaultSettingsRow(guildId), ...data };
      return merged;
    },
    "getSettingsForGuild",
    buildDefaultSettingsRow(guildId)
  );
}

/**
 * Updates or inserts settings for a specific guild.
 * Merges updates with existing settings so that fields not being updated remain intact.
 *
 * FAIL-OPEN: does nothing (returns merged object only).
 */
async function updateSettingsForGuild(guildId, updates, guild) {
  if (!guildId) return;

  // Always compute merged result, even if we can’t write.
  const existing = (await getSettingsForGuild(guildId)) || buildDefaultSettingsRow(guildId);
  const newSettings = { ...existing, ...updates, guildId };

  if (FAIL_OPEN.enabled) {
    console.warn("[FAIL-OPEN] updateSettingsForGuild skipped DB write.");
    // Still try to apply permissions if guild is passed (safe local action)
    if (guild) {
      await applyPermissionSideEffects(newSettings, guild).catch(() => { });
    }
    return newSettings;
  }

  return await withRescue(
    async () => {
      // upsert w/ explicit conflict on guildId
      const { error: upsertError } = await supabase
        .from("guild_settings")
        .upsert(newSettings, { onConflict: "guildId" });

      if (upsertError) {
        if (looksLikeBillingOrQuota(upsertError)) {
          enableFailOpen("updateSettingsForGuild upsert billing/quota");
          return newSettings;
        }
        console.error(`[ERROR] Failed to update settings for ${guildId}:`, upsertError);
        return null;
      }

      if (guild) {
        await applyPermissionSideEffects(newSettings, guild);
      }

      return newSettings;
    },
    "updateSettingsForGuild",
    null
  );
}

async function applyPermissionSideEffects(settings, guild) {
  if (!guild) return;

  const { channelId, errorLogsChannelId, allowedRoleId, errorLogsRoleId } = settings;

  if (channelId) {
    await updateChannelPermissionsForGuild(guild.id, channelId, allowedRoleId, guild);
  }

  if (errorLogsChannelId) {
    await updateChannelPermissionsForGuild(
      guild.id,
      errorLogsChannelId,
      errorLogsRoleId,
      guild
    );
  }
}

/**
 * Updates the permissions for a specific channel in a guild.
 */
async function updateChannelPermissionsForGuild(guildId, channelId, role_id, guild) {
  try {
    if (!guild || !channelId || !role_id) return;

    const channel = guild.channels.cache.get(channelId);
    if (!channel) return;

    const role = guild.roles.cache.get(role_id);
    if (!role) return;

    await channel.permissionOverwrites.edit(role, {
      ViewChannel: true,
      ReadMessageHistory: true,
    });

    console.log(`[INFO] Updated permissions for #${channel.name} in ${guildId}.`);
  } catch (error) {
    console.error(`[ERROR] Failed to update channel permissions: ${error.message}`);
  }
}

// ****************************************
// 5. ERROR LOGGING FUNCTIONS
// ****************************************
async function enableErrorLogging(guildId, guild) {
  try {
    const settings = (await getSettingsForGuild(guildId)) || {};
    await updateSettingsForGuild(guildId, { errorLogsEnabled: true }, guild);

    if (settings.errorLogsChannelId && guild) {
      await updateChannelPermissionsForGuild(
        guildId,
        settings.errorLogsChannelId,
        settings.errorLogsRoleId,
        guild
      );
    }
    console.log(`[INFO] Error logging enabled for guild: ${guildId}`);
  } catch (error) {
    console.error(`[ERROR] Failed to enable error logging for guild ${guildId}: ${error.message}`);
  }
}

async function disableErrorLogging(guildId, guild) {
  try {
    await updateSettingsForGuild(guildId, { errorLogsEnabled: false }, guild);
    console.log(`[INFO] Error logging disabled for guild: ${guildId}`);
  } catch (error) {
    console.error(`[ERROR] Failed to disable error logging for guild ${guildId}: ${error.message}`);
  }
}

// ****************************************
// 6. CONSENT MANAGEMENT (Supabase + JSON fallback)
// ****************************************
const CONSENT_FILE = path.join(__dirname, "../database/consent.json");

async function readConsentData() {
  try {
    if (!fs.existsSync(CONSENT_FILE)) return {};
    delete require.cache[require.resolve(CONSENT_FILE)];
    const data = await fs.promises.readFile(CONSENT_FILE, "utf8");
    if (!data.trim()) return {};
    return JSON.parse(data);
  } catch (error) {
    console.error(`[ERROR] Failed to read consent file: ${error.message}`);
    return {};
  }
}

async function writeConsentData(data) {
  try {
    await fs.promises.writeFile(CONSENT_FILE, JSON.stringify(data, null, 4), "utf8");
  } catch (error) {
    console.error(`[ERROR] Failed to write consent file: ${error.message}`);
  }
}

/**
 * Checks if a user has given consent (guild-scoped).
 *
 * Backwards compatible:
 * - hasUserConsented(userId)    -> checks latest consent for user (any guild if table has no guildId)
 * - hasUserConsented(userId, guildId) -> preferred, guild-scoped
 *
 * FAIL-OPEN: returns true (so you never mute/deny by accident).
 */
async function hasUserConsented(userId, guildId = null) {
  if (!userId) return false;
  if (FAIL_OPEN.enabled) return true;

  return await withRescue(
    async () => {
      // Try guild-scoped first (if your table has guildId)
      if (guildId) {
        const { data, error } = await supabase
          .from("user_consent")
          .select("consented, consentDate")
          .eq("userId", userId)
          .eq("guildId", guildId)
          .order("consentDate", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (error) {
          // If guildId column doesn't exist, fall back below
          if (looksLikeBillingOrQuota(error)) throw error;
        } else {
          return !!data?.consented;
        }
      }

      // Fallback: user-only (legacy schema)
      const { data, error } = await supabase
        .from("user_consent")
        .select("consented, consentDate")
        .eq("userId", userId)
        .order("consentDate", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        if (looksLikeBillingOrQuota(error)) throw error;
        console.error(`[ERROR] Could not check consent for ${userId}:`, error);
        return false;
      }

      return !!data?.consented;
    },
    "hasUserConsented",
    true
  );
}

/**
 * Grants consent to a user and unmutes them if they are in a voice channel.
 *
 * FAIL-OPEN: still tries to unmute (safety), but skips DB writes.
 */
async function grantUserConsent(userId, guild) {
  if (!userId) return;

  // Always do the safety-unmute if possible.
  await withRescue(
    async () => {
      if (guild) {
        const member = await guild.members.fetch(userId).catch(() => null);
        if (member?.voice?.channel && member.voice.serverMute) {
          await member.voice.setMute(false, "User consented to transcription.");
        }
      }
    },
    "grantUserConsent.unmute",
    null
  );

  if (FAIL_OPEN.enabled) {
    console.warn("[FAIL-OPEN] grantUserConsent skipped DB write.");
    return;
  }

  await withRescue(
    async () => {
      const payload = {
        userId,
        consented: true,
        consentDate: new Date().toISOString(),
      };

      if (guild?.id) payload.guildId = guild.id;

      const { error } = await supabase.from("user_consent").upsert(payload);
      if (error) throw error;

      console.log(`[INFO] User ${userId} consent granted.`);
    },
    "grantUserConsent.db",
    null
  );
}

/**
 * Revokes a user's consent and mutes them if they are in a voice channel.
 *
 * FAIL-OPEN: NEVER mutes (policy bypass), and skips DB write.
 */
async function revokeUserConsent(userId, guild) {
  if (!userId) return;

  if (FAIL_OPEN.enabled) {
    console.warn("[FAIL-OPEN] revokeUserConsent skipped (no mute, no DB).");
    return;
  }

  await withRescue(
    async () => {
      // Delete consent row (guild-scoped if possible)
      if (guild?.id) {
        const { error } = await supabase
          .from("user_consent")
          .delete()
          .eq("userId", userId)
          .eq("guildId", guild.id);

        if (error) throw error;
      } else {
        const { error } = await supabase.from("user_consent").delete().eq("userId", userId);
        if (error) throw error;
      }
    },
    "revokeUserConsent.db",
    null
  );

  await withRescue(
    async () => {
      if (!guild) return;
      const member = await guild.members.fetch(userId).catch(() => null);
      if (member?.voice?.channel) {
        await member.voice.setMute(true, "User revoked consent for transcription.");
        console.log(`[INFO] User ${userId} muted after revoking consent.`);
      }
    },
    "revokeUserConsent.mute",
    null
  );
}

// ****************************************
// 7. SAFE CHANNELS & USERS MANAGEMENT
// ****************************************
async function addSafeChannel(guildId, channelId) {
  const settings = await getSettingsForGuild(guildId);
  if (!settings) return;
  if (!settings.safeChannels.includes(channelId)) {
    const newsafeChannels = [...settings.safeChannels, channelId];
    await updateSettingsForGuild(guildId, { safeChannels: newsafeChannels });
    console.log(`[INFO] Added channel ${channelId} to safe list for guild ${guildId}.`);
  }
}

async function removeSafeChannel(guildId, channelId) {
  const settings = await getSettingsForGuild(guildId);
  if (!settings) return;
  const newsafeChannels = settings.safeChannels.filter((id) => id !== channelId);
  await updateSettingsForGuild(guildId, { safeChannels: newsafeChannels });
  console.log(`[INFO] Removed channel ${channelId} from safe list for guild ${guildId}.`);
}

async function listsafeChannels(guildId) {
  const settings = await getSettingsForGuild(guildId);
  return settings ? settings.safeChannels : [];
}

async function addSafeUser(guildId, user_id) {
  const settings = await getSettingsForGuild(guildId);
  if (!settings) return;
  if (!settings.safeUsers.includes(user_id)) {
    const newsafeUsers = [...settings.safeUsers, user_id];
    await updateSettingsForGuild(guildId, { safeUsers: newsafeUsers });
    console.log(`[INFO] Added user ${user_id} to safe list for guild ${guildId}.`);
  }
}

async function removeSafeUser(guildId, user_id) {
  const settings = await getSettingsForGuild(guildId);
  if (!settings) return;
  const newsafeUsers = settings.safeUsers.filter((id) => id !== user_id);
  await updateSettingsForGuild(guildId, { safeUsers: newsafeUsers });
  console.log(`[INFO] Removed user ${user_id} from safe list for guild ${guildId}.`);
}

async function listsafeUsers(guildId) {
  const settings = await getSettingsForGuild(guildId);
  return settings ? settings.safeUsers : [];
}

// ****************************************
// 8. EXPORTS
// ****************************************
module.exports = {
  // Supabase-based settings
  getSettingsForGuild,
  updateSettingsForGuild,
  updateChannelPermissionsForGuild,

  // Error logging
  enableErrorLogging,
  disableErrorLogging,

  // Consent (guild-scoped + backwards compatible)
  hasUserConsented,
  grantUserConsent,
  revokeUserConsent,

  // Safe channels & users
  addSafeChannel,
  removeSafeChannel,
  listsafeChannels,
  addSafeUser,
  removeSafeUser,
  listsafeUsers,

  // Optional JSON-based consent fallback
  readConsentData,
  writeConsentData,

  // Fail-open state (useful for debugging)
  FAIL_OPEN,
};