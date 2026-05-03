import {
  bumpLobbyResetNonce,
  clearSharedLogs,
  getNetworkSettings,
  getLobbyResetNonce,
  getSuspended,
  kvIsConfigured,
  listSharedLogs,
  setNetworkSettings,
  setSuspended,
} from '../lib/sharedStore.js';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}

function isAuthorized(req) {
  const expected = (process.env.CLIENT_BEARER_TOKEN || '').trim();
  if (!expected) return true;
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  return token === expected;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  let body;
  try {
    body = req.body;
  } catch {
    res.status(400).json({ error: 'Invalid JSON body' });
    return;
  }
  if (body == null || typeof body !== 'object') {
    res.status(400).json({ error: 'JSON object body required' });
    return;
  }

  if (!isAuthorized(req)) {
    res.status(401).json({
      error:
        'Invalid or missing bearer token. Match App secret to CLIENT_BEARER_TOKEN on the server.',
    });
    return;
  }

  const adminPass = (process.env.ADMIN_PANEL_PASSWORD || '').trim();
  if (!adminPass) {
    res.status(501).json({
      error:
        'Admin is not configured: set ADMIN_PANEL_PASSWORD on the server (same value you enter in the app).',
    });
    return;
  }
  const sent = typeof body.adminPassword === 'string' ? body.adminPassword : '';
  if (sent !== adminPass) {
    res.status(403).json({ error: 'Invalid admin password.' });
    return;
  }

  const action = typeof body.action === 'string' ? body.action.trim().toLowerCase() : '';

  try {
    if (action === 'status') {
      const suspended = await getSuspended();
      const lobbyResetNonce = await getLobbyResetNonce();
      res.status(200).json({
        suspended,
        kvConfigured: kvIsConfigured(),
        lobbyResetNonce,
        suspendEnvFallback: String(process.env.SUSPEND_ALL_REQUESTS || '')
          .trim()
          .toLowerCase()
          .split(',')
          .includes('true'),
      });
      return;
    }

    if (action === 'suspend') {
      if (!kvIsConfigured()) {
        res.status(409).json({
          error:
            'Cannot toggle suspend from the app without Vercel KV (or compatible Redis). Link KV / set KV_REST_API_URL and KV_REST_API_TOKEN, or set SUSPEND_ALL_REQUESTS=true on the server and redeploy.',
        });
        return;
      }
      const ok = await setSuspended(true);
      if (!ok) {
        res.status(500).json({ error: 'Could not write suspend flag to KV.' });
        return;
      }
      res.status(200).json({ ok: true, suspended: true });
      return;
    }

    if (action === 'resume') {
      if (!kvIsConfigured()) {
        res.status(409).json({
          error:
            'Cannot toggle suspend without KV. Set KV_REST_API_URL and KV_REST_API_TOKEN, or unset SUSPEND_ALL_REQUESTS and redeploy.',
        });
        return;
      }
      const ok = await setSuspended(false);
      if (!ok) {
        res.status(500).json({ error: 'Could not clear suspend flag in KV.' });
        return;
      }
      res.status(200).json({ ok: true, suspended: false });
      return;
    }

    if (action === 'shared_logs' || action === 'list_shared_logs') {
      const limit = Number(body.limit);
      const logs = await listSharedLogs(Number.isFinite(limit) ? limit : 200);
      res.status(200).json({ logs, kvConfigured: kvIsConfigured() });
      return;
    }

    if (action === 'clear_shared_logs') {
      const ok = await clearSharedLogs();
      if (!ok) {
        res.status(409).json({
          error: 'Cannot clear shared logs without KV (KV_REST_API_URL / KV_REST_API_TOKEN).',
        });
        return;
      }
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'reset_lobby') {
      if (!kvIsConfigured()) {
        res.status(409).json({
          error: 'Cannot reset lobby without KV (KV_REST_API_URL / KV_REST_API_TOKEN).',
        });
        return;
      }
      const cleared = await clearSharedLogs();
      if (!cleared) {
        res.status(500).json({ error: 'Could not clear shared logs.' });
        return;
      }
      const lobbyResetNonce = await bumpLobbyResetNonce();
      if (lobbyResetNonce == null) {
        res.status(500).json({ error: 'Could not update lobby reset marker.' });
        return;
      }
      res.status(200).json({ ok: true, lobbyResetNonce });
      return;
    }

    if (action === 'get_network_settings') {
      if (!kvIsConfigured()) {
        res.status(200).json({ ok: true, settings: null, kvConfigured: false });
        return;
      }
      const settings = await getNetworkSettings();
      res.status(200).json({ ok: true, settings, kvConfigured: true });
      return;
    }

    if (action === 'save_network_settings') {
      if (!kvIsConfigured()) {
        res.status(409).json({
          error:
            'Cannot save network settings without Redis/KV. Set KV_REST_API_URL + KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_*).',
        });
        return;
      }
      const net = body.network;
      if (net == null || typeof net !== 'object') {
        res.status(400).json({ error: 'Body must include network: { backendUrl, bearerToken, phones }.' });
        return;
      }
      const ok = await setNetworkSettings({
        backendUrl: net.backendUrl,
        bearerToken: net.bearerToken,
        phones: net.phones,
      });
      if (!ok) {
        res.status(500).json({ error: 'Could not write network settings to KV.' });
        return;
      }
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({
      error:
        'Unknown action. Use: status, suspend, resume, shared_logs, clear_shared_logs, reset_lobby, get_network_settings, save_network_settings.',
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[api/admin]', message);
    if (!res.headersSent) {
      res.status(500).json({ error: message || 'Internal server error' });
    }
  }
}
