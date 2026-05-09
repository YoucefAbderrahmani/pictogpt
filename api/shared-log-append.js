import { appendSharedLog } from '../lib/sharedStore.js';

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
        'Invalid or missing bearer token. In the app, set App secret to the same value as CLIENT_BEARER_TOKEN on the server, or remove/clear CLIENT_BEARER_TOKEN on the server to disable auth.',
    });
    return;
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const text = typeof body.body === 'string' ? body.body.trim() : '';
  if (!text) {
    res.status(400).json({ error: 'body is required' });
    return;
  }
  try {
    const digits = String(body.toPhoneNumber || '').replace(/\D/g, '');
    const tagRaw = typeof body.clientTag === 'string' ? body.clientTag.trim().slice(0, 80) : '';
    const safeTag = /^[a-zA-Z0-9_.-]+$/.test(tagRaw) ? tagRaw : null;
    await appendSharedLog({
      body: text,
      slot: typeof body.slot === 'number' && Number.isFinite(body.slot) ? body.slot : null,
      qcmMode: Boolean(body.qcmMode),
      phoneTail: digits.length >= 4 ? digits.slice(-4) : null,
      clientTag: safeTag,
      answerModel: typeof body.answerModel === 'string' && body.answerModel.trim() ? body.answerModel.trim() : null,
    });
    res.status(200).json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: message || 'Internal server error' });
  }
}
