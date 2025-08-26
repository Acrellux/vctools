/*******************************************************
 * settings.cjs
 *******************************************************/
const fs = require("fs");
const path = require("path");
require("dotenv").config();
const { PermissionsBitField } = require("discord.js");
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

// IMPORTANT: Use the SERVICE ROLE key for administrative operations
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ****************************************
// 2. GUILD SETTINGS FUNCTIONS
// ****************************************

/**
 * Retrieves the settings for a specific guild.
 * If none exist, it inserts a row of default settings.
 */
async function getSettingsForGuild(guildId) {
  const { data, error } = await supabase
    .from("guild_settings")
    .select("*")
    .eq("guildId", guildId)
    .single();

  // If the row doesn't exist, insert default settings
  if (error && error.code === "PGRST116") {
    console.warn(
      `[WARNING] No settings found for ${guildId}. Initializing default settings.`
    );

    // Default settings using camelCase keys – ensure your Supabase table columns match these
    const defaultSettings = {
      guildId: guildId,
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
      consent_delivery_mode: "server_default",
      consent_channel_id: null,
    };

    const { error: insertError } = await supabase
      .from("guild_settings")
      .insert([defaultSettings]);

    if (insertError) {
      console.error(
        `[ERROR] Failed to initialize settings for ${guildId}:`,
        insertError
      );
      return null;
    }
    return defaultSettings;
  }

  if (error) {
    console.error(`[ERROR] Could not fetch settings for ${guildId}:`, error);
    return null;
  }

  return data;
}

/**
 * Updates or inserts settings for a specific guild.
 * Merges updates with existing settings so that fields not being updated remain intact.
 */
async function updateSettingsForGuild(guildId, updates, guild) {
  console.log("[DEBUG] Starting updateSettingsForGuild...");
  console.log(`[DEBUG] Guild ID: ${guildId}`);
  console.log("[DEBUG] Updates provided:", updates);

  // Fetch existing settings or use defaults if none found
  const { data, error } = await supabase
    .from("guild_settings")
    .select("*")
    .eq("guildId", guildId)
    .single();

  if (error && error.code !== "PGRST116") {
    console.error(`[ERROR] Failed to fetch settings for ${guildId}:`, error);
    return;
  }

  // Use existing settings or default object if none exists
  const existingSettings = data || {
    guildId: guildId,
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
    consent_delivery_mode: "server_default",
    consent_channel_id: null,
  };

  // Merge updates with existing settings
  const newSettings = { ...existingSettings, ...updates };
  console.log("[DEBUG] Merged settings:", newSettings);

  // Upsert the new settings in Supabase with explicit conflict resolution on guildId
  const { error: updateError } = await supabase
    .from("guild_settings")
    .upsert(newSettings, { onConflict: ["guildId"] });
  if (updateError) {
    console.error(
      `[ERROR] Failed to update settings for ${guildId}:`,
      updateError
    );
    return;
  }
  console.log("[DEBUG] Settings updated in Supabase.");

  // If a Discord Guild object is provided, update channel permissions as needed
  if (guild) {
    const { channelId, errorLogsChannelId, allowedRoleId, errorLogsRoleId } =
      newSettings;

    if (channelId) {
      await updateChannelPermissionsForGuild(
        guildId,
        channelId,
        allowedRoleId,
        guild
      );
    }

    if (errorLogsChannelId) {
      await updateChannelPermissionsForGuild(
        guildId,
        errorLogsChannelId,
        errorLogsRoleId,
        guild
      );
    }
  }
  console.log("[DEBUG] Finished updateSettingsForGuild.");
}

/**
 * Updates the permissions for a specific channel in a guild.
 */
async function updateChannelPermissionsForGuild(
  guildId,
  channelId,
  role_id,
  guild
) {
  try {
    console.log(`[DEBUG] Starting updateChannelPermissionsForGuild...`);
    console.log(`[DEBUG] Parameters:`, { guildId, channelId, role_id });

    if (!channelId) {
      console.error(
        `[ERROR] Channel ID is missing or invalid for guild ${guildId}.`
      );
      return;
    }

    const channel = guild.channels.cache.get(channelId);
    if (!channel) {
      console.error(
        `[ERROR] Channel with ID ${channelId} not found in guild ${guildId}.`
      );
      return;
    }

    if (!role_id) {
      console.error(
        `[ERROR] Role ID is missing, cannot update permissions for #${channel.name}.`
      );
      return;
    }

    const role = guild.roles.cache.get(role_id);
    if (!role) {
      console.error(
        `[ERROR] Role with ID ${role_id} not found in guild ${guildId}.`
      );
      return;
    }

    console.log(
      `[DEBUG] Updating channel permissions for #${channel.name} with role: ${role.id}`
    );
    await channel.permissionOverwrites.edit(role, {
      ViewChannel: true,
      ReadMessageHistory: true,
    });
    console.log(
      `[INFO] Successfully updated permissions for #${channel.name}.`
    );
  } catch (error) {
    console.error(
      `[ERROR] Failed to update channel permissions: ${error.message}`
    );
    console.error(`[DEBUG] Full Error Stack:`, error.stack);
  }
}

// ****************************************
// 3. ERROR LOGGING FUNCTIONS
// ****************************************
async function enableErrorLogging(guildId, guild) {
  try {
    console.log(`[DEBUG] Enabling error logging for guild: ${guildId}`);
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
    console.error(
      `[ERROR] Failed to enable error logging for guild ${guildId}: ${error.message}`
    );
  }
}

async function disableErrorLogging(guildId, guild) {
  try {
    console.log(`[DEBUG] Disabling error logging for guild: ${guildId}`);
    await updateSettingsForGuild(guildId, { errorLogsEnabled: false }, guild);
    console.log(`[INFO] Error logging disabled for guild: ${guildId}`);
  } catch (error) {
    console.error(
      `[ERROR] Failed to disable error logging for guild ${guildId}: ${error.message}`
    );
  }
}

// ****************************************
// 4. CONSENT MANAGEMENT (JSON-based fallback)
// ****************************************
const CONSENT_FILE = path.join(__dirname, "../database/consent.json");

async function readConsentData() {
  try {
    if (!fs.existsSync(CONSENT_FILE)) return {};
    delete require.cache[require.resolve(CONSENT_FILE)];
    const data = await fs.promises.readFile(CONSENT_FILE, "utf8");
    if (!data.trim()) {
      console.warn(
        "[WARNING] consent.json is empty. Initializing default object."
      );
      return {};
    }
    return JSON.parse(data);
  } catch (error) {
    console.error(`[ERROR] Failed to read consent file: ${error.message}`);
    return {};
  }
}

async function writeConsentData(data) {
  try {
    await fs.promises.writeFile(
      CONSENT_FILE,
      JSON.stringify(data, null, 4),
      "utf8"
    );
  } catch (error) {
    console.error(`[ERROR] Failed to write consent file: ${error.message}`);
  }
}

/**
 * Checks if a user has given consent (Supabase-based).
 */
async function hasUserConsented(userId) {
  const { data, error } = await supabase
    .from("user_consent")
    .select("consented")
    .eq("userId", userId)
    .order("consentDate", { ascending: false }) // or "id" if you have it
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error(`[ERROR] Could not check consent for ${userId}:`, error);
    return false;
  }
  return data?.consented || false;
}

/**
 * Grants consent to a user and unmutes them if they are in a voice channel.
 */
async function grantUserConsent(userId, guild) {
  const { error } = await supabase
    .from("user_consent")
    .upsert({ userId: userId, consented: true });
  if (error) {
    console.error(`[ERROR] Could not grant consent for ${userId}:`, error);
    return;
  }
  try {
    const member = await guild.members.fetch(userId);
    if (member.voice.channel) {
      await member.voice.setMute(false, "User consented to transcription.");
      console.log(`[INFO] User ${userId} unmuted after granting consent.`);
    }
  } catch (err) {
    console.error(`[ERROR] Failed to unmute user ${userId}: ${err.message}`);
  }
}

/**
 * Revokes a user's consent and mutes them if they are in a voice channel.
 */
async function revokeUserConsent(userId, guild) {
  const { error } = await supabase
    .from("user_consent")
    .delete()
    .eq("userId", userId);
  if (error) {
    console.error(`[ERROR] Could not revoke consent for ${userId}:`, error);
    return;
  }
  try {
    const member = await guild.members.fetch(userId);
    if (member.voice.channel) {
      await member.voice.setMute(
        true,
        "User revoked consent for transcription."
      );
      console.log(`[INFO] User ${userId} muted after revoking consent.`);
    }
  } catch (err) {
    console.error(`[ERROR] Failed to mute user ${userId}: ${err.message}`);
  }
}

// ****************************************
// 5. SAFE CHANNELS & USERS MANAGEMENT
// ****************************************

async function addSafeChannel(guildId, channelId) {
  const settings = await getSettingsForGuild(guildId);
  if (!settings) return;
  if (!settings.safeChannels.includes(channelId)) {
    const newsafeChannels = [...settings.safeChannels, channelId];
    await updateSettingsForGuild(guildId, { safeChannels: newsafeChannels });
    console.log(
      `[INFO] Added channel ${channelId} to safe list for guild ${guildId}.`
    );
  }
}

async function removeSafeChannel(guildId, channelId) {
  const settings = await getSettingsForGuild(guildId);
  if (!settings) return;
  const newsafeChannels = settings.safeChannels.filter(
    (id) => id !== channelId
  );
  await updateSettingsForGuild(guildId, { safeChannels: newsafeChannels });
  console.log(
    `[INFO] Removed channel ${channelId} from safe list for guild ${guildId}.`
  );
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
    console.log(
      `[INFO] Added user ${user_id} to safe list for guild ${guildId}.`
    );
  }
}

async function removeSafeUser(guildId, user_id) {
  const settings = await getSettingsForGuild(guildId);
  if (!settings) return;
  const newsafeUsers = settings.safeUsers.filter((id) => id !== user_id);
  await updateSettingsForGuild(guildId, { safeUsers: newsafeUsers });
  console.log(
    `[INFO] Removed user ${user_id} from safe list for guild ${guildId}.`
  );
}

async function listsafeUsers(guildId) {
  const settings = await getSettingsForGuild(guildId);
  return settings ? settings.safeUsers : [];
}

// ****************************************
// 6. EXPORTS
// ****************************************
module.exports = {
  // Supabase-based settings
  getSettingsForGuild,
  updateSettingsForGuild,
  updateChannelPermissionsForGuild,

  // Error logging
  enableErrorLogging,
  disableErrorLogging,

  // Consent
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
};
