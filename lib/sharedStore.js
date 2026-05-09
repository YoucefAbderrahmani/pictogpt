/**
 * Global suspend toggle + shared answer log (Redis REST).
 * Accepts legacy Vercel KV names or Upstash names (Vercel Redis integration sets UPSTASH_REDIS_REST_*).
 * Fallback: SUSPEND_ALL_REQUESTS=true env (redeploy to change) when Redis is not linked.
 */

const SUSPEND_KEY = 'pictoxam:suspend';
const LOGS_KEY = 'pictoxam:shared_logs';
const NETWORK_KEY = 'pictoxam:network_settings';
const LOBBY_RESET_NONCE_KEY = 'pictoxam:lobby_reset_nonce';
const PUSH_SUBS_KEY = 'pictoxam:push_subscriptions';
const MAX_LOG_ENTRIES = 400;

function redisRestUrl() {
  return (
    (process.env.KV_REST_API_URL || '').trim() ||
    (process.env.UPSTASH_REDIS_REST_URL || '').trim() ||
    ''
  );
}

function redisRestToken() {
  return (
    (process.env.KV_REST_API_TOKEN || '').trim() ||
    (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim() ||
    ''
  );
}

export function kvIsConfigured() {
  return Boolean(redisRestUrl() && redisRestToken());
}

/** @type {unknown} */
let kvSingleton = null;

async function getKv() {
  if (!kvIsConfigured()) return null;
  if (kvSingleton) return kvSingleton;
  const { createClient } = await import('@vercel/kv');
  kvSingleton = createClient({
    url: redisRestUrl(),
    token: redisRestToken(),
  });
  return kvSingleton;
}

function normalizeExpoPushToken(raw) {
  const t = String(raw || '').trim();
  if (!/^ExponentPushToken\[[^\]]+\]$/.test(t)) return '';
  return t;
}

function toPushNotificationBody(entry) {
  const body = String(entry?.body || '')
    .trim()
    .replace(/^\d{1,6}\)__\s*/i, '')
    .trim();
  if (!body) return '';
  if (body.length <= 2000) return body;
  return `${body.slice(0, 1997)}...`;
}

async function sendExpoPushForSharedEntry(entry) {
  const kv = await getKv();
  if (!kv) return;
  const tokens = await kv.hkeys(PUSH_SUBS_KEY);
  if (!Array.isArray(tokens) || tokens.length === 0) return;

  const senderTag =
    typeof entry?.clientTag === 'string' && entry.clientTag.trim() ? entry.clientTag.trim() : null;
  const body = toPushNotificationBody(entry);
  if (!body) return;

  const candidates = [];
  for (const rawToken of tokens) {
    const token = normalizeExpoPushToken(rawToken);
    if (!token) continue;
    const rawMeta = await kv.hget(PUSH_SUBS_KEY, token);
    let meta = null;
    if (typeof rawMeta === 'string') {
      try {
        meta = JSON.parse(rawMeta);
      } catch {
        meta = null;
      }
    }
    const tokenTag = typeof meta?.clientTag === 'string' ? meta.clientTag.trim() : '';
    if (senderTag && tokenTag && tokenTag === senderTag) continue;
    candidates.push(token);
  }
  if (candidates.length === 0) return;

  const messages = candidates.map((to) => ({
    to,
    sound: 'default',
    title: 'Pictoxam answer',
    body,
    priority: 'high',
    channelId: 'pictoxam-answers',
    data: {
      slot: typeof entry?.slot === 'number' && Number.isFinite(entry.slot) ? entry.slot : null,
      at: String(entry?.at || new Date().toISOString()),
    },
  }));
  try {
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messages),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const data = Array.isArray(json?.data) ? json.data : [];
    if (data.length > 0) {
      for (let i = 0; i < data.length; i += 1) {
        const row = data[i];
        if (row?.status === 'error') {
          const tok = candidates[i];
          const detailsError = String(row?.details?.error || '').toLowerCase();
          if (detailsError.includes('notregistered') || detailsError.includes('device')) {
            await kv.hdel(PUSH_SUBS_KEY, tok);
          }
        }
      }
    }
  } catch (e) {
    console.error('[sharedStore] sendExpoPushForSharedEntry', e);
  }
}

export async function getSuspended() {
  try {
    const kv = await getKv();
    if (kv) {
      const v = await kv.get(SUSPEND_KEY);
      return v === true || v === 'true' || v === '1' || v === 1;
    }
  } catch (e) {
    console.error('[sharedStore] getSuspended', e);
  }
  return String(process.env.SUSPEND_ALL_REQUESTS || '')
    .trim()
    .toLowerCase()
    .split(',')
    .includes('true');
}

export async function setSuspended(value) {
  const kv = await getKv();
  if (!kv) return false;
  try {
    await kv.set(SUSPEND_KEY, value ? '1' : '0');
    return true;
  } catch (e) {
    console.error('[sharedStore] setSuspended', e);
    return false;
  }
}

/**
 * @param {{ body: string; slot?: number | null; qcmMode?: boolean; phoneTail?: string | null; clientTag?: string | null; answerModel?: string | null }} entry
 */
export async function appendSharedLog(entry) {
  const kv = await getKv();
  if (!kv) return;
  try {
    const tag =
      typeof entry.clientTag === 'string' && entry.clientTag.trim()
        ? entry.clientTag.trim().slice(0, 80)
        : null;
    const am =
      typeof entry.answerModel === 'string' && entry.answerModel.trim()
        ? entry.answerModel.trim().slice(0, 120).toLowerCase()
        : null;
    const row = {
      at: new Date().toISOString(),
      body: String(entry.body || '').slice(0, 8000),
      slot: entry.slot ?? null,
      qcmMode: Boolean(entry.qcmMode),
      phoneTail: entry.phoneTail ?? null,
      clientTag: tag,
      answerModel: am,
    };
    await kv.lpush(LOGS_KEY, JSON.stringify(row));
    await kv.ltrim(LOGS_KEY, 0, MAX_LOG_ENTRIES - 1);
    await sendExpoPushForSharedEntry(row);
  } catch (e) {
    console.error('[sharedStore] appendSharedLog', e);
  }
}

/**
 * @param {{ token: string; clientTag?: string | null; platform?: string | null }} sub
 */
export async function setPushSubscription(sub) {
  const kv = await getKv();
  if (!kv) return false;
  const token = normalizeExpoPushToken(sub?.token);
  if (!token) return false;
  try {
    const tagRaw = typeof sub?.clientTag === 'string' ? sub.clientTag.trim() : '';
    const clientTag = /^[a-zA-Z0-9_.-]+$/.test(tagRaw) ? tagRaw.slice(0, 80) : null;
    const platformRaw = typeof sub?.platform === 'string' ? sub.platform.trim().toLowerCase() : '';
    const platform = platformRaw === 'ios' || platformRaw === 'android' ? platformRaw : null;
    await kv.hset(PUSH_SUBS_KEY, {
      [token]: JSON.stringify({
        clientTag,
        platform,
        at: new Date().toISOString(),
      }),
    });
    return true;
  } catch (e) {
    console.error('[sharedStore] setPushSubscription', e);
    return false;
  }
}

export async function listSharedLogs(limit = 200) {
  const kv = await getKv();
  if (!kv) return [];
  try {
    const cap = Math.min(Math.max(1, limit), 500);
    const raw = await kv.lrange(LOGS_KEY, 0, cap - 1);
    return raw
      .map((s) => {
        try {
          if (s != null && typeof s === 'object' && !Array.isArray(s) && 'body' in s) {
            return s;
          }
          if (typeof s === 'string') {
            return JSON.parse(s);
          }
        } catch {
          return null;
        }
        return null;
      })
      .filter(Boolean);
  } catch (e) {
    console.error('[sharedStore] listSharedLogs', e);
    return [];
  }
}

export async function clearSharedLogs() {
  const kv = await getKv();
  if (!kv) return false;
  try {
    await kv.del(LOGS_KEY);
    return true;
  } catch (e) {
    console.error('[sharedStore] clearSharedLogs', e);
    return false;
  }
}

export async function getLobbyResetNonce() {
  const kv = await getKv();
  if (!kv) return 0;
  try {
    const raw = await kv.get(LOBBY_RESET_NONCE_KEY);
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  } catch (e) {
    console.error('[sharedStore] getLobbyResetNonce', e);
    return 0;
  }
}

export async function bumpLobbyResetNonce() {
  const kv = await getKv();
  if (!kv) return null;
  try {
    const n = await kv.incr(LOBBY_RESET_NONCE_KEY);
    const v = Number(n);
    return Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
  } catch (e) {
    console.error('[sharedStore] bumpLobbyResetNonce', e);
    return null;
  }
}

/**
 * @returns {null | { backendUrl: string; bearerToken: string; phones: string[]; updatedAt?: string }}
 */
export async function getNetworkSettings() {
  const kv = await getKv();
  if (!kv) return null;
  try {
    const raw = await kv.get(NETWORK_KEY);
    if (raw == null || raw === '') return null;
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      return normalizeNetworkDoc(raw);
    }
    if (typeof raw === 'string') {
      const parsed = JSON.parse(raw);
      return typeof parsed === 'object' && parsed != null ? normalizeNetworkDoc(parsed) : null;
    }
  } catch (e) {
    console.error('[sharedStore] getNetworkSettings', e);
  }
  return null;
}

function normalizeNetworkDoc(raw) {
  const phonesIn = Array.isArray(raw.phones) ? raw.phones : [];
  const phones = ['', '', '', ''].map((_, i) =>
    typeof phonesIn[i] === 'string' ? phonesIn[i].trim().slice(0, 32) : ''
  );
  const smsSendingEnabled =
    raw.smsSendingEnabled === false || raw.smsSendingEnabled === '0' || raw.smsSendingEnabled === 0 ? false : true;
  return {
    backendUrl: typeof raw.backendUrl === 'string' ? raw.backendUrl.trim().slice(0, 512) : '',
    bearerToken: typeof raw.bearerToken === 'string' ? raw.bearerToken.trim().slice(0, 512) : '',
    phones,
    smsSendingEnabled,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : undefined,
  };
}

/**
 * @param {{ backendUrl?: string; bearerToken?: string; phones?: unknown[]; smsSendingEnabled?: boolean }} payload
 */
export async function setNetworkSettings(payload) {
  const kv = await getKv();
  if (!kv) return false;
  try {
    const prev = (await getNetworkSettings()) || {};
    const doc = normalizeNetworkDoc({
      backendUrl: typeof payload.backendUrl === 'string' ? payload.backendUrl : prev.backendUrl || '',
      bearerToken: typeof payload.bearerToken === 'string' ? payload.bearerToken : prev.bearerToken || '',
      phones: Array.isArray(payload.phones) ? payload.phones : prev.phones,
      smsSendingEnabled:
        typeof payload.smsSendingEnabled === 'boolean'
          ? payload.smsSendingEnabled
          : prev.smsSendingEnabled !== false,
      updatedAt: new Date().toISOString(),
    });
    await kv.set(NETWORK_KEY, JSON.stringify(doc));
    return true;
  } catch (e) {
    console.error('[sharedStore] setNetworkSettings', e);
    return false;
  }
}
