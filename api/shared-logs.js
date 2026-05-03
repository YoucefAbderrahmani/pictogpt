import { listSharedLogs, kvIsConfigured } from '../lib/sharedStore.js';

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

  try {
    const limit = Number(body.limit);
    const logs = await listSharedLogs(Number.isFinite(limit) ? limit : 200);
    res.status(200).json({ logs, kvConfigured: kvIsConfigured() });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[api/shared-logs]', message);
    if (!res.headersSent) {
      res.status(500).json({ error: message || 'Internal server error' });
    }
  }
}
