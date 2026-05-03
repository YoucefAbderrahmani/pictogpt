import { getLobbyResetNonce, getNetworkSettings, kvIsConfigured } from '../lib/sharedStore.js';

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

  if (!isAuthorized(req)) {
    res.status(401).json({
      error:
        'Invalid or missing bearer token. Match App secret to CLIENT_BEARER_TOKEN on the server, or remove CLIENT_BEARER_TOKEN to disable auth.',
    });
    return;
  }

  try {
    const raw = await getNetworkSettings();
    const lobbyResetNonce = await getLobbyResetNonce();
    const settings =
      raw && typeof raw === 'object'
        ? {
            backendUrl: raw.backendUrl || '',
            bearerToken: raw.bearerToken || '',
            phones: Array.isArray(raw.phones) ? raw.phones : ['', '', '', ''],
            updatedAt: raw.updatedAt,
          }
        : null;
    res.status(200).json({ ok: true, settings, kvConfigured: kvIsConfigured(), lobbyResetNonce });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[api/network-config]', message);
    if (!res.headersSent) {
      res.status(500).json({ error: message || 'Internal server error' });
    }
  }
}
