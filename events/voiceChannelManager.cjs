// Fix for UDP discovery issue in Discord.js
process.env.DISCORDJS_DISABLE_UDP = "true";
console.log("[BOOT] UDP discovery disabled.");

const path = require("path");
const fs = require("fs");
const {
  VoiceConnectionStatus,
  joinVoiceChannel,
  getVoiceConnection,
  EndBehaviorType,
} = require("@discordjs/voice");
const { EventEmitter } = require("events");
const { finished } = require("stream");
const prism = require("prism-media");
const transcription = require("./transcription.cjs");

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionsBitField,
  AuditLogEvent,
} = require("discord.js");
const {
  sendConsentPrompt,
  resolveConsentDestination,
} = require("../commands/logic/consent_logic.cjs");

// VC State importing
const { saveVCState, clearVCState } = require("../util/vc_state.cjs");

// Supabase initialization
const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

/************************************************************************************************
 * CONFIG / GLOBAL STATE
 ************************************************************************************************/

// NOTE: This file uses several protections against VC thrash:
// - Cooldowns per guild to avoid rapid hopping
// - Route locks to ensure only one routing pass runs at a time
// - Expected-disconnect windows to prevent “rejoin” logic from fighting intentional moves
// - A periodic probe that can rejoin if kicked/disconnected

// Consent context
const interactionContexts = new Map(); // userId -> { guildId, mode: "consent" | ... }

// Voice pipeline guard
const finalizingKeys = new Set(); // `${userId}-${unique}`

// Speaking grace / silence logic
const GRACE_PERIOD_MS = 3000;
const silenceDurations = new Map();
const MAX_SILENCE_RECORDS = 10;
const DEFAULT_SILENCE_TIMEOUT = 3000;

const AUTO_ROUTE_MIN_OTHER_HUMANS = 2;

// Move cooldown per guild to prevent thrash
const guildMoveCooldownMs = 1500;
const guildLastMoveAt = new Map(); // guildId -> timestamp

// Route locks / disconnect intent (prevents join/leave thrash + enables rejoin if kicked)
const guildRouteLock = new Set();               // guildId currently routing
const expectedDisconnectUntil = new Map();      // guildId -> timestamp (expected disconnect window)
const reconnectLockUntil = new Map();           // guildId -> timestamp (temporary lock to prevent rejoin loops)
const lastGoodChannelId = new Map();            // guildId -> last channelId we successfully joined
const lastGoodChannelAt = new Map();            // guildId -> timestamp
const ROUTE_LOCK_MAX_MS = 12000;
const EXPECTED_DISC_MS = 25000;
const RECONNECT_LOCK_MS = 12000;

function markExpectedDisconnect(guildId, ms = EXPECTED_DISC_MS) {
  expectedDisconnectUntil.set(guildId, Date.now() + ms);
}

function isExpectedDisconnect(guildId) {
  const until = expectedDisconnectUntil.get(guildId) || 0;
  if (until <= Date.now()) {
    expectedDisconnectUntil.delete(guildId);
    return false;
  }
  return true;
}

function setReconnectLock(guildId, ms = RECONNECT_LOCK_MS) {
  reconnectLockUntil.set(guildId, Date.now() + ms);
}

function canAttemptReconnect(guildId) {
  const until = reconnectLockUntil.get(guildId) || 0;
  if (until <= Date.now()) {
    reconnectLockUntil.delete(guildId);
    return true;
  }
  return false;
}

async function withGuildRouteLock(guildId, fn) {
  if (guildRouteLock.has(guildId)) return;
  guildRouteLock.add(guildId);

  const releaseTimer = setTimeout(() => {
    guildRouteLock.delete(guildId);
  }, ROUTE_LOCK_MAX_MS);

  try {
    await fn();
  } finally {
    safeClearTimer(releaseTimer);
    guildRouteLock.delete(guildId);
  }
}

async function resolveGuildChannel(guild, channelId) {
  if (!guild || !channelId) return null;
  const cached = guild.channels?.cache?.get?.(channelId) || null;
  if (cached) return cached;
  try {
    const fetched = await guild.channels.fetch(channelId);
    return fetched || null;
  } catch {
    return null;
  }
}

async function handleVoiceDisconnect(guild, client) {
  if (!guild || !client) return;
  const guildId = guild.id;

  if (isExpectedDisconnect(guildId)) return;
  if (!canAttemptReconnect(guildId)) return;
  setReconnectLock(guildId);

  const settings = (await getSettingsForGuild(guildId).catch(() => null)) || {};
  const safe = new Set(settings.safeChannels || []);

  // Try the last known good VC first (rejoin-if-kicked behavior)
  const preferred = lastGoodChannelId.get(guildId) || null;
  if (preferred && !safe.has(preferred)) {
    const ch = await resolveGuildChannel(guild, preferred);
    if (ch && ch.type === ChannelType.GuildVoice) {
      const humans = ch.members.filter((m) => !m.user.bot).size;
      if (humans > 0) {
        await joinChannel(client, preferred, guild).catch(() => null);
        return;
      }
    }
  }

  // Fallback: let the router pick a target
  await manageVoiceChannels(guild, client, null);
}

// Track file streams and subscriptions by user
const outputStreams = {};
const userSubscriptions = {};
const userAudioIds = {}; // userId -> unique
const pipelines = new Map(); // userId -> { audioStream, decoder, pcmWriter, loudnessRes }

function safeClearTimer(t) {
  try { if (t) clearTimeout(t); } catch { }
}

function rememberSilenceDuration(guildId, ms) {
  const durations = silenceDurations.get(guildId) || [];
  durations.push(ms);
  while (durations.length > MAX_SILENCE_RECORDS) durations.shift();
  silenceDurations.set(guildId, durations);
}

function getDynamicSilenceTimeout(guildId) {
  const durations = silenceDurations.get(guildId) || [];
  if (!durations.length) return DEFAULT_SILENCE_TIMEOUT;
  const sorted = [...durations].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const scaled = Math.max(1400, Math.min(9000, Math.floor(median * 0.8)));
  return scaled;
}

/************************************************************************************************
 * SETTINGS + HELPERS
 ************************************************************************************************/

async function getSettingsForGuild(guildId) {
  const { data, error } = await supabase
    .from("guild_settings")
    .select("*")
    .eq("guild_id", guildId)
    .maybeSingle();

  if (error) throw error;
  return data || {};
}

function isModerator(member) {
  if (!member) return false;
  try {
    return (
      member.permissions.has(PermissionsBitField.Flags.ManageGuild) ||
      member.permissions.has(PermissionsBitField.Flags.ModerateMembers) ||
      member.permissions.has(PermissionsBitField.Flags.Administrator)
    );
  } catch {
    return false;
  }
}

function channelCounts(channel) {
  if (!channel?.members) return { humans: 0, mods: 0 };
  let humans = 0;
  let mods = 0;
  channel?.members?.forEach((m) => {
    if (m.user.bot) return;
    humans += 1;
    if (isModerator(m)) mods += 1;
  });
  return { humans, mods };
}

function channelHasMod(channel) {
  if (!channel) return false;
  const { mods } = channelCounts(channel);
  return mods > 0;
}

/************************************************************************************************
 * BUSIEST / TARGET SELECTION
 ************************************************************************************************/

function findBusiest(guild, safeSet) {
  let busiest = null;
  let busiestHumans = 0;

  guild.channels.cache.forEach((ch) => {
    if (!ch || ch.type !== ChannelType.GuildVoice) return;
    if (safeSet && safeSet.has(ch.id)) return;

    const { humans } = channelCounts(ch);
    if (humans > busiestHumans) {
      busiestHumans = humans;
      busiest = ch;
    }
  });

  return { busiest, busiestHumans };
}

function findBestUnsupervised2(guild, safeSet, currentChannelId) {
  let best = null;
  let bestHumans = 0;

  guild.channels.cache.forEach((ch) => {
    if (!ch || ch.type !== ChannelType.GuildVoice) return;
    if (safeSet && safeSet.has(ch.id)) return;
    if (currentChannelId && ch.id === currentChannelId) return;

    const { humans, mods } = channelCounts(ch);
    if (humans <= 0) return;
    if (mods > 0) return; // supervised
    if (humans >= bestHumans) {
      best = ch;
      bestHumans = humans;
    }
  });

  return best;
}

/************************************************************************************************
 * VOICE ACTIVITY LOGS (SAFE)
 ************************************************************************************************/

async function detectUserActivityChanges(oldState, newState) {
  // Existing behavior untouched (safe)
  // (kept as-is)
  try {
    const guildId = newState.guild.id;
    const userId = newState.id;

    const wasIn = !!oldState.channelId;
    const nowIn = !!newState.channelId;
    const moved = wasIn && nowIn && oldState.channelId !== newState.channelId;

    // Optional: sanitize string identifiers if they might appear inside <...> or similar (optional)
    const safe = (s) => String(s).replace(/</g, `<${String.fromCharCode(8203)}`);

    if (!wasIn && nowIn) {
      await supabase.from("voice_activity_logs").insert({
        guild_id: guildId,
        user_id: userId,
        event_type: "join",
        channel_id: safe(newState.channelId),
        created_at: new Date().toISOString(),
      });
    } else if (wasIn && !nowIn) {
      await supabase.from("voice_activity_logs").insert({
        guild_id: guildId,
        user_id: userId,
        event_type: "leave",
        channel_id: safe(oldState.channelId),
        created_at: new Date().toISOString(),
      });
    } else if (moved) {
      await supabase.from("voice_activity_logs").insert({
        guild_id: guildId,
        user_id: userId,
        event_type: "move",
        channel_id: safe(newState.channelId),
        from_channel_id: safe(oldState.channelId),
        created_at: new Date().toISOString(),
      });
    }
  } catch (e) {
    console.warn("[VOICE] activity log insert failed:", e?.message || e);
  }
}

/************************************************************************************************
 * CONSENT / MUTING HELPERS (SAFE)
 ************************************************************************************************/

async function tryMute(member) {
  try {
    if (!member?.voice) return false;
    if (member.voice.serverMute) return true;
    await member.voice.setMute(true, "Consent required");
    return true;
  } catch {
    return false;
  }
}

async function tryUnmute(member) {
  try {
    if (!member?.voice) return false;
    if (!member.voice.serverMute) return true;
    await member.voice.setMute(false, "Consent granted");
    return true;
  } catch {
    return false;
  }
}

/************************************************************************************************
 * DISCORD EVENT ENTRYPOINT
 ************************************************************************************************/
let isDisconnecting = false;

async function execute(oldState, newState, client) {
  if (newState?.member?.user?.bot) return;

  // Activity logs (safe)
  try {
    await detectUserActivityChanges(oldState, newState);
  } catch (e) {
    console.warn("[VOICE] detectUserActivityChanges failed:", e?.message || e);
  }

  if (!newState?.guild) {
    console.error("[ERROR] Guild object is missing.");
    return;
  }

  const guild = newState.guild;
  const userId = newState.id;

  // Settings (null-safe)
  const settings = (await getSettingsForGuild(guild.id).catch(() => null)) || {};
  const safe = new Set(settings.safeChannels || []);
  const consentChanId = settings?.consent_log_channel_id || null;

  const moveContext = {
    actorId: null,
    actorIsMod: false,
    originId: oldState?.channelId || null,
    destId: newState?.channelId || null,
    reason: null,
  };

  // Try to infer mod-moves via audit logs for explicit trade-places logic
  try {
    if (oldState?.channelId && newState?.channelId && oldState.channelId !== newState.channelId) {
      const logs = await guild.fetchAuditLogs({
        type: AuditLogEvent.MemberUpdate,
        limit: 5,
      });
      const entry = logs.entries.find((e) => {
        const changes = e?.changes || [];
        return changes.some((c) => c.key === "channel_id");
      });

      if (entry) {
        moveContext.actorId = entry.executor?.id || null;
        const actor = entry.executor ? await guild.members.fetch(entry.executor.id).catch(() => null) : null;
        moveContext.actorIsMod = !!actor && isModerator(actor);
        moveContext.reason = "audit_move";
      }
    }
  } catch { }

  // ───────────────────────────────────────────────────────────────────────────
  // Case 1: User left a channel
  // ───────────────────────────────────────────────────────────────────────────
  if (oldState.channelId && !newState.channelId) {
    console.log(`[DEBUG] User ${userId} left channel: ${oldState.channelId}`);

    const isLeaveSafe = safe.has(oldState.channelId);

    // If leaving a safe channel, do not reroute
    if (isLeaveSafe) return;

    await manageVoiceChannels(guild, client, moveContext);
    return;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Case 2: User joined a channel
  // ───────────────────────────────────────────────────────────────────────────
  if (!oldState.channelId && newState.channelId) {
    console.log(`[DEBUG] User ${userId} joined channel: ${newState.channelId}`);

    const isJoinSafe = safe.has(newState.channelId);
    if (!isJoinSafe) {
      await manageVoiceChannels(guild, client, moveContext);
    }

    let connection = getVoiceConnection(guild.id);
    if (connection) {
      audioListeningFunctions(connection, guild);
    }

    // ---- Fresh settings just before consent logic (null-safe) ----
    const freshSettings = (await getSettingsForGuild(guild.id).catch(() => null)) || {};

    // Normalize safeUsers to string IDs (defensive)
    const safeUsersArr = Array.isArray(freshSettings.safeUsers)
      ? freshSettings.safeUsers.map((x) => String(x))
      : [];
    const isSafeUser = safeUsersArr.includes(String(userId));

    // ✅ Safe user bypass (skip consent & muting)
    if (isSafeUser) {
      console.log(`[CONSENT] ${userId} is a safe user; skipping consent & muting.`);
      try {
        await tryUnmute(newState.member);
      } catch { }
      return;
    }

    // Consent gating (existing behavior)
    try {
      const member = newState.member;

      const dest = await resolveConsentDestination(guild, consentChanId, newState.channelId).catch(() => null);
      if (!dest) return;

      const ok = await sendConsentPrompt(dest, member.user).catch(() => false);
      if (!ok) return;

      interactionContexts.set(userId, { guildId: guild.id, mode: "consent" });

      const muted = await tryMute(member);
      if (!muted) {
        console.warn(`[CONSENT] Failed to mute ${userId} (maybe missing perms).`);
      }
    } catch (err) {
      console.error(`[ERROR] Consent prompt failed for ${userId}: ${err.message}`);
    }

    return;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Case 3: User moved channels
  // ───────────────────────────────────────────────────────────────────────────
  if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
    console.log(`[DEBUG] User ${userId} moved: ${oldState.channelId} -> ${newState.channelId}`);

    const isFromSafe = safe.has(oldState.channelId);
    const isToSafe = safe.has(newState.channelId);

    // Moving into safe: no reroute
    if (isToSafe) return;

    // Moving out of safe into normal: reroute
    if (isFromSafe && !isToSafe) {
      await manageVoiceChannels(guild, client, moveContext);
      return;
    }

    await manageVoiceChannels(guild, client, moveContext);
  }
}

/************************************************************************************************
 * MANAGE VOICE CHANNELS & MOVES (core decision engine)
 ************************************************************************************************/
async function manageVoiceChannels(guild, client, moveContext = null) {
  return withGuildRouteLock(guild.id, async () => {
    const settings = (await getSettingsForGuild(guild.id).catch(() => null)) || {};
    const featureOn = !!settings.mod_auto_route_enabled;
    const safe = new Set(settings.safeChannels || []);

    const connection = getVoiceConnection(guild.id);
    const currentChannel = connection
      ? await resolveGuildChannel(guild, connection.joinConfig.channelId)
      : null;

    const { busiest, busiestHumans } = findBusiest(guild, safe);
    const bestUnsupervised = findBestUnsupervised2(guild, safe, currentChannel?.id || null);

    // Helper to respect cooldown
    const now = Date.now();
    const last = guildLastMoveAt.get(guild.id) || 0;
    const canMove = now - last >= guildMoveCooldownMs;

    // If feature is OFF, simple behavior (also promote when <2 humans)
    if (!featureOn) {
      if (!currentChannel) {
        if (busiest && busiestHumans > 0) {
          const newConn = await joinChannel(client, busiest.id, guild);
          if (newConn) audioListeningFunctions(newConn, guild);
        }
        return;
      }

      const currentHumans = currentChannel.members.filter((m) => !m.user.bot).size;
      if (currentHumans < 2) {
        if (busiest && busiest.id !== currentChannel.id && busiestHumans > currentHumans && canMove) {
          guildLastMoveAt.set(guild.id, now);
          await moveToChannel(busiest, connection, guild, client);
          return;
        }
        if (currentHumans === 0 && (!busiest || busiestHumans === 0) && !isDisconnecting) {
          await disconnectAndReset(connection, guild, client, { clearState: true, expected: true });
        }
        return;
      }

      if (busiest && busiest.id !== currentChannel.id && busiestHumans > currentHumans && canMove) {
        guildLastMoveAt.set(guild.id, now);
        await moveToChannel(busiest, connection, guild, client);
      }
      return;
    }

    // FEATURE ON: full logic
    // 0) Never sit in SAFE
    if (currentChannel && safe.has(currentChannel.id)) {
      if (bestUnsupervised && canMove) {
        guildLastMoveAt.set(guild.id, now);
        await moveToChannel(bestUnsupervised, connection, guild, client);
        return;
      }
      // Fallback: join busiest even if a mod is there (covers "only 1 active VC")
      if (busiest && busiestHumans > 0 && canMove) {
        guildLastMoveAt.set(guild.id, now);
        await moveToChannel(busiest, connection, guild, client);
        return;
      }
      if (!isDisconnecting) {
        await disconnectAndReset(connection, guild, client, { clearState: true, expected: true });
      }
      return;
    }

    // 1) Trade-places on MOD moves (explicit)
    if (currentChannel && moveContext?.actorIsMod && canMove) {
      const origin = moveContext.originId
        ? guild.channels.cache.get(moveContext.originId)
        : null;
      const dest = moveContext.destId
        ? guild.channels.cache.get(moveContext.destId)
        : null;

      // Mod moved from origin to dest — we should go to origin if it’s valid and unsupervised-ish
      if (origin && origin.type === ChannelType.GuildVoice && !safe.has(origin.id)) {
        const { humans: originHumans } = channelCounts(origin);
        if (originHumans > 0) {
          guildLastMoveAt.set(guild.id, now);
          await moveToChannel(origin, connection, guild, client);
          return;
        }
      }

      // Otherwise, prefer bestUnsupervised
      if (bestUnsupervised) {
        guildLastMoveAt.set(guild.id, now);
        await moveToChannel(bestUnsupervised, connection, guild, client);
        return;
      }
    }

    // 2) If not in a VC, join busiest (or best unsupervised)
    if (!currentChannel) {
      const target = bestUnsupervised || busiest;
      if (target && channelCounts(target).humans > 0) {
        const newConn = await joinChannel(client, target.id, guild);
        if (newConn) audioListeningFunctions(newConn, guild);
      }
      return;
    }

    // 3) If current channel has a mod supervising, prefer unsupervised channel with humans
    const currentHasMod = channelHasMod(currentChannel);
    if (currentHasMod) {
      if (bestUnsupervised && canMove) {
        guildLastMoveAt.set(guild.id, now);
        await moveToChannel(bestUnsupervised, connection, guild, client);
        return;
      }
    }

    // 4) If channel is empty, grace then disconnect
    const currentHumans = currentChannel.members.filter((m) => !m.user.bot).size;

    // Track empty duration per guild
    if (!manageVoiceChannels._emptySince) manageVoiceChannels._emptySince = new Map();
    const emptySince = manageVoiceChannels._emptySince;

    if (currentHumans === 0) {
      if (!emptySince.has(guild.id)) emptySince.set(guild.id, now);
      const elapsed = now - emptySince.get(guild.id);

      // If any other humans exist elsewhere, move to busiest/unsupervised first
      const target = bestUnsupervised || busiest;
      if (target && channelCounts(target).humans > 0 && canMove) {
        guildLastMoveAt.set(guild.id, now);
        emptySince.delete(guild.id);
        await moveToChannel(target, connection, guild, client);
        return;
      }

      if (elapsed > GRACE_PERIOD_MS && !isDisconnecting) {
        console.log("[INFO] Empty grace period → disconnect.");
        emptySince.delete(guild.id);
        await disconnectAndReset(connection, guild, client, { clearState: true, expected: true });
        return;
      }
    } else {
      // reset if humans come back
      emptySince.delete(guild.id);
    }

    // 5) Otherwise, if there is a busier channel (and either current has <2 humans or current is supervised), move there
    if (busiest && busiest.id !== currentChannel.id && canMove) {
      const shouldPromote = busiestHumans > currentHumans;
      if (shouldPromote) {
        guildLastMoveAt.set(guild.id, now);
        await moveToChannel(busiest, connection, guild, client);
        return;
      }
    }
  });
}

async function moveToChannel(targetChannel, connection, guild, client) {
  if (connection) {
    console.log(`[INFO] Leaving and joining: ${targetChannel.name}`);
    await disconnectAndReset(connection, guild, client, { expected: true, clearState: false, skipRecalc: true });
    const newConnection = await joinChannel(client, targetChannel.id, guild);
    if (newConnection) {
      saveVCState(guild.id, targetChannel.id);
      lastGoodChannelId.set(guild.id, targetChannel.id);
      lastGoodChannelAt.set(guild.id, Date.now());
      audioListeningFunctions(newConnection, guild);
    }
  }
}

async function joinChannel(client, channelId, guild) {
  const settings = (await getSettingsForGuild(guild.id).catch(() => null)) || {};
  if ((settings.safeChannels || []).includes(channelId)) {
    console.log(`[INFO] Channel ${channelId} is in safeChannels. Not joining.`);
    return null;
  }

  const safe = new Set(settings.safeChannels || []);

  // 🚫 ABSOLUTE SAFE CHANNEL BLOCK
  if (safe.has(channelId)) {
    return null;
  }

  // If there's an existing connection, decide whether to reuse or rebuild.
  const existing = getVoiceConnection(guild.id);
  if (existing) {
    const existingChan = existing.joinConfig?.channelId || null;
    const status = existing.state?.status;

    if (existingChan === channelId && status === VoiceConnectionStatus.Ready) {
      return existing;
    }

    // Rebuild for any other case (moved, kicked, disconnected, etc.)
    try {
      markExpectedDisconnect(guild.id);
      existing.destroy();
    } catch { }
  }

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    console.error(`[ERROR] Channel not found: ${channelId}`);
    return null;
  }
  if (channel.type !== ChannelType.GuildVoice) {
    console.error(`[ERROR] Channel ${channelId} is not a voice channel.`);
    return null;
  }

  try {
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
    });

    connection.on(VoiceConnectionStatus.Ready, async () => {
      console.log(`[INFO] Connected to ${channel.name}`);
      saveVCState(guild.id, channel.id);
      lastGoodChannelId.set(guild.id, channel.id);
      lastGoodChannelAt.set(guild.id, Date.now());
      try { await manageVoiceChannels(guild, guild.client || client, null); } catch { }
      audioListeningFunctions(connection, guild);
    });

    // Rejoin if kicked / unexpected disconnect
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try { await handleVoiceDisconnect(guild, guild.client || client); } catch { }
    });

    return connection;
  } catch (error) {
    console.error(`[ERROR] Can't connect to ${channel.name}: ${error.message}`);
    return null;
  }
}

async function disconnectAndReset(connection, guild, client, opts = {}) {
  if (!connection) return;
  if (isDisconnecting) return;

  const {
    expected = true,
    clearState = false,
    skipRecalc = false,
  } = opts;

  isDisconnecting = true;
  try {
    const guildId = connection.joinConfig.guildId;
    if (expected) markExpectedDisconnect(guildId);
    if (clearState) clearVCState(guildId);
    connection.destroy();
    console.log(`[INFO] Disconnected from VC in guild ${guildId}`);
  } catch (error) {
    console.error(`[ERROR] During disconnect: ${error.message}`);
  } finally {
    isDisconnecting = false;
    if (!skipRecalc && guild && client) {
      try { await manageVoiceChannels(guild, client, null); } catch (e) { console.warn("[ROUTE] Post-disconnect manage failed:", e?.message || e); }
    }
  }
}

/************************************************************************************************
 * AUDIO LISTENING + RECORDING PIPELINES
 ************************************************************************************************/
function audioListeningFunctions(connection, guild) {
  const receiver = connection.receiver;
  if (receiver.isListening) return;
  receiver.isListening = true;

  const currentlySpeaking = new Set();
  const userLastSpokeTime = {};
  const perUserSilenceTimer = {};

  async function stopUserPipeline(userId) {
    const p = pipelines.get(userId);
    if (!p) return;

    const { audioStream, decoder, pcmWriter, loudnessRes } = p;
    pipelines.delete(userId);

    try {
      // loudness
      try { loudnessRes?.teardown?.(); } catch { }

      // stop flow of new data
      try { audioStream?.unpipe?.(decoder); } catch { }
      try { decoder?.unpipe?.(pcmWriter); } catch { }
      try { audioStream?.pause?.(); } catch { }

      // finish writer safely
      if (pcmWriter && !pcmWriter.closed) {
        pcmWriter.on("error", () => { }); // swallow writer errors
        try { pcmWriter.end(); } catch { }
      }

      // destroy streams
      try { audioStream?.destroy?.(); } catch { }
      try { decoder?.destroy?.(); } catch { }
      try { pcmWriter?.destroy?.(); } catch { }
    } catch (e) {
      console.warn(`[PIPELINE] stopUserPipeline(${userId}) failed: ${e?.message || e}`);
    }
  }

  receiver.speaking.on("start", async (userId) => {
    try {
      const chanId = connection.joinConfig.channelId;
      if (!chanId) return;

      if (currentlySpeaking.has(userId)) return;
      currentlySpeaking.add(userId);

      userLastSpokeTime[userId] = Date.now();
      safeClearTimer(perUserSilenceTimer[userId]);
      delete perUserSilenceTimer[userId];

      const unique = (userAudioIds[userId] = (userAudioIds[userId] || 0) + 1);

      const base = path.join(__dirname, "../../temp_audio", `${userId}-${unique}`);
      const pcm = `${base}.pcm`;
      const wav = `${base}.wav`;

      fs.mkdirSync(path.dirname(pcm), { recursive: true });

      // Subscribe to opus stream
      const audioStream = receiver.subscribe(userId, {
        end: {
          behavior: EndBehaviorType.Manual,
        },
      });

      // Decode opus -> PCM
      const decoder = new prism.opus.Decoder({
        rate: 48000,
        channels: 2,
        frameSize: 960,
      });

      const pcmWriter = fs.createWriteStream(pcm);

      // Loudness / meter hook (optional)
      let loudnessRes = null;
      try {
        loudnessRes = transcription?.initLoudness?.(guild.id, userId) || null;
      } catch { }

      // Pipe
      pipelines.set(userId, { audioStream, decoder, pcmWriter, loudnessRes });

      audioStream.pipe(decoder).pipe(pcmWriter);

      pcmWriter.on("error", (err) => console.warn(`[PCM WRITER ERROR] ${err.message}`));
    } catch (e) {
      console.warn(`[AUDIO] speaking start failed: ${e?.message || e}`);
    }
  });

  receiver.speaking.on("end", async (userId) => {
    try {
      if (!currentlySpeaking.has(userId)) return;
      currentlySpeaking.delete(userId);

      const last = userLastSpokeTime[userId] || Date.now();
      const elapsed = Date.now() - last;

      rememberSilenceDuration(guild.id, elapsed);

      const wait = getDynamicSilenceTimeout(guild.id);
      perUserSilenceTimer[userId] = setTimeout(() => {
        if (!currentlySpeaking.has(userId)) {
          const unique = userAudioIds[userId];
          const chanId = connection.joinConfig.channelId;
          finalizeUserAudio(userId, guild, unique, chanId);
        }
        safeClearTimer(perUserSilenceTimer[userId]);
        delete perUserSilenceTimer[userId];
      }, wait > 0 ? wait : 0);
    } catch (e) {
      console.warn(`[AUDIO] speaking end failed: ${e?.message || e}`);
    }
  });

  // ALWAYS handle unexpected disconnects (kicked / dropped)
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    receiver.speaking.removeAllListeners();
    receiver.isListening = false;
    Object.values(perUserSilenceTimer).forEach((t) => safeClearTimer(t));
    try { await handleVoiceDisconnect(guild, guild.client); } catch { }
  });

  async function finalizeUserAudio(userId, guild, unique, channelId) {
    const key = `${userId}-${unique}`;
    if (finalizingKeys.has(key)) return;
    finalizingKeys.add(key);

    const base = path.join(__dirname, "../../temp_audio", `${userId}-${unique}`);
    const pcm = `${base}.pcm`;
    const wav = `${base}.wav`;

    try {
      await stopUserPipeline(userId);

      // Convert PCM -> WAV
      await convertPcmToWav(pcm, wav);

      // Transcribe
      await transcription.transcribe(guild, userId, wav, channelId).catch(() => null);
    } catch (e) {
      console.warn(`[FINALIZE] failed for ${userId}: ${e?.message || e}`);
    } finally {
      finalizingKeys.delete(key);

      // Cleanup files
      try { fs.unlinkSync(pcm); } catch { }
      try { fs.unlinkSync(wav); } catch { }
    }
  }
}

async function convertPcmToWav(pcmPath, wavPath) {
  // Minimal WAV wrapper conversion (existing approach)
  // You can keep your previous pipeline; leaving as-is.
  // If your project already has an ffmpeg wrapper, keep it there.
  // Here we do a simple pass-through using prism-media and stream finishing.
  const ffmpeg = require("ffmpeg-static");
  const { spawn } = require("child_process");

  return new Promise((resolve, reject) => {
    const args = [
      "-f", "s16le",
      "-ar", "48000",
      "-ac", "2",
      "-i", pcmPath,
      "-y",
      wavPath,
    ];

    const proc = spawn(ffmpeg, args, { stdio: "ignore" });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with ${code}`));
    });
  });
}

/************************************************************************************************
 * Periodic VC auto-(re)join probe (every 5 minutes)
 * - Honors mod_auto_route_enabled gating for target selection
 ************************************************************************************************/
let vcAutoCheckInterval = null;
const vcProbeRunning = new Set();

function startPeriodicVCCheck(client, intervalMs = 300000) {
  if (vcAutoCheckInterval) clearInterval(vcAutoCheckInterval);

  vcAutoCheckInterval = setInterval(() => {
    client.guilds.cache.forEach(async (guild) => {
      if (vcProbeRunning.has(guild.id)) return;
      vcProbeRunning.add(guild.id);

      try {
        const connection = getVoiceConnection(guild.id);
        if (connection && connection.state?.status === VoiceConnectionStatus.Ready) {
          await manageVoiceChannels(guild, client, null);
          return;
        }

        // If we got kicked or otherwise dropped, try last known good channel first.
        const preferred = lastGoodChannelId.get(guild.id) || null;
        if (preferred) {
          const settings = (await getSettingsForGuild(guild.id).catch(() => null)) || {};
          const safe = new Set(settings.safeChannels || []);
          if (!safe.has(preferred)) {
            const ch = await resolveGuildChannel(guild, preferred);
            if (ch && ch.type === ChannelType.GuildVoice) {
              const humans = ch.members.filter((m) => !m.user.bot).size;
              if (humans > 0) {
                await joinChannel(client, preferred, guild).catch(() => null);
                return;
              }
            }
          }
        }

        // If disconnected, recompute targets and (maybe) join
        await manageVoiceChannels(guild, client, null);
      } catch (e) {
        console.warn(`[AUTO-VC] Guild ${guild.id} probe failed: ${e?.message || e}`);
      } finally {
        vcProbeRunning.delete(guild.id);
      }
    });
  }, intervalMs);

  console.log(`[AUTO-VC] Periodic check started (every ${intervalMs}ms).`);
}

module.exports = {
  execute,
  joinChannel,
  audioListeningFunctions,
  startPeriodicVCCheck,
};