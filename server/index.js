import cors from 'cors';
import express from 'express';
import { tryDocumentAiPreprocess } from './documentAi.js';
import {
  appendSharedLog,
  bumpLobbyResetNonce,
  clearSharedLogs,
  getLobbyResetNonce,
  getNetworkSettings,
  getSuspended,
  kvIsConfigured,
  listSharedLogs,
  setNetworkSettings,
  setSuspended,
} from '../lib/sharedStore.js';
import {
  isOpenRouterSwitchModelError,
  openRouterMessageContent,
  openRouterModelCandidates,
  openRouterOutboundHeaders,
  readOpenRouterApiResponseBody,
} from '../lib/openRouterModelCandidates.js';
import { MIN_QCM_PAIRS_ACCEPT, toQcmSmsFormat } from '../lib/qcmSmsFormat.js';

const app = express();
const PORT = Number(process.env.PORT) || 8787;

app.use(cors());
app.use(express.json({ limit: '20mb' }));

/** Primary env + optional `NAME_2`, `NAME_3`, `NAME_4` (e.g. OPENROUTER_API_KEY_2). Tried in order. */
function collectApiKeyChain(envBaseName) {
  const keys = [];
  const main = process.env[envBaseName];
  if (typeof main === 'string' && main.trim()) keys.push(main.trim());
  for (let i = 2; i <= 4; i += 1) {
    const v = process.env[`${envBaseName}_${i}`];
    if (typeof v === 'string' && v.trim()) keys.push(v.trim());
  }
  return keys;
}

/** Common paste typo: `k-or-v1-...` → `sk-or-v1-...` */
function normalizeOpenRouterApiKey(key) {
  let t = String(key || '').trim();
  if (!t) return '';
  if (/^bearer\s+/i.test(t)) t = t.replace(/^bearer\s+/i, '').trim();
  const low = t.toLowerCase();
  if (low.startsWith('k-or-v1-') && !low.startsWith('sk-or-v1-')) {
    return `sk-or-v1-${t.slice(8)}`;
  }
  return t;
}

function auth(req) {
  const expected = (process.env.CLIENT_BEARER_TOKEN || '').trim();
  if (!expected) return true;
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  return token === expected;
}

const DEFAULT_PROMPT =
  'Describe what you see in this image clearly and concisely. The reply will be sent by SMS, so be direct and avoid markdown.';

function isVercelServerless() {
  return Boolean(process.env.VERCEL);
}

function ocrEnhanceEnabled() {
  const onVercel = isVercelServerless();
  const def = onVercel ? 'false' : 'true';
  const raw = (process.env.OCR_IMAGE_ENHANCE ?? def).toLowerCase().trim();
  return !['0', 'false', 'off', 'no'].includes(raw);
}

async function ensureUploadWithinLimits(imageBase64, mimeType) {
  if (typeof imageBase64 !== 'string') {
    return { imageBase64, mimeType };
  }
  if (!isVercelServerless()) {
    if (imageBase64.length <= 2_800_000) return { imageBase64, mimeType };
  } else if (imageBase64.length <= 95_000) {
    return { imageBase64, mimeType };
  }
  try {
    const { default: sharp } = await import('sharp');
    const buf = Buffer.from(imageBase64, 'base64');
    const maxEdge = isVercelServerless() ? 1024 : 1800;
    const out = await sharp(buf, { sequentialRead: true, limitInputPixels: 18_000_000 })
      .rotate()
      .resize(maxEdge, maxEdge, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: isVercelServerless() ? 66 : 78 })
      .toBuffer();
    return { imageBase64: out.toString('base64'), mimeType: 'image/jpeg' };
  } catch {
    return { imageBase64, mimeType };
  }
}

async function enhanceImageForOcr(imageBase64) {
  const { default: sharp } = await import('sharp');
  const input = Buffer.from(imageBase64, 'base64');
  const maxEdge = isVercelServerless() ? 1024 : 1800;
  let pipeline = sharp(input, { sequentialRead: true, limitInputPixels: 18_000_000 })
    .rotate()
    .resize(maxEdge, maxEdge, { fit: 'inside', withoutEnlargement: true })
    .grayscale();
  if (isVercelServerless()) {
    pipeline = pipeline.jpeg({ quality: 72 });
  } else {
    pipeline = pipeline.normalize().sharpen({ sigma: 1 }).jpeg({ quality: 80 });
  }
  const output = await pipeline.toBuffer();
  return {
    mime: 'image/jpeg',
    imageBase64: output.toString('base64'),
  };
}

/** Low default avoids OpenRouter “cannot afford max_tokens” on small balances; raise via env if you have credits. */
function envIntInRange(name, defaultVal, min, max) {
  const raw = process.env[name];
  if (raw == null || raw === '') return defaultVal;
  const n = Number(raw);
  if (!Number.isFinite(n)) return defaultVal;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function isOpenRouterTokenBudgetError(message) {
  const m = String(message || '').toLowerCase();
  return /afford|more credits|max_tokens|too many tokens requested/i.test(m);
}

async function analyzeWithOpenRouter({ key, userPrompt, dataUrl }) {
  const cap = envIntInRange('OPENROUTER_MAX_TOKENS', 1024, 256, 4096);
  const failures = [];
  const models = openRouterModelCandidates();
  console.log('[server] OpenRouter model chain:', models.join(' → '));

  for (const model of models) {
    let maxTokens = cap;
    while (maxTokens >= 256) {
      const openRouterRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          ...openRouterOutboundHeaders(),
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: userPrompt },
                { type: 'image_url', image_url: { url: dataUrl } },
              ],
            },
          ],
          max_tokens: maxTokens,
        }),
      });

      const { json, rawBody } = await readOpenRouterApiResponseBody(openRouterRes);
      if (openRouterRes.ok) {
        const content = openRouterMessageContent(json);
        if (content) {
          return { content, answerModel: `openrouter/${model}`.toLowerCase() };
        }
        failures.push(`${model}@${maxTokens}: empty model response`);
        break;
      }

      const msg = json?.error?.message || `OpenRouter error (${openRouterRes.status})`;
      if (openRouterRes.status === 401) {
        throw new Error(
          `OpenRouter HTTP 401 — OPENROUTER_API_KEY on this server is invalid or does not match the OpenRouter account that has credits. Regenerate the key at https://openrouter.ai/keys and paste it into Vercel env. Raw: ${String(msg).slice(0, 300)}`
        );
      }
      if (openRouterRes.status === 402) {
        throw new Error(
          `OpenRouter HTTP 402 — payment required for this route or key. Credits on a different account do not apply. Raw: ${String(msg).slice(0, 400)}`
        );
      }
      const switchHint = `${msg} ${(rawBody || '').slice(0, 1200)}`;
      if (isOpenRouterSwitchModelError(switchHint, openRouterRes.status)) {
        failures.push(`${model}@${maxTokens}: ${String(msg).slice(0, 280)}`);
        break;
      }
      if (isOpenRouterTokenBudgetError(msg) && maxTokens > 256) {
        maxTokens = Math.max(256, Math.floor(maxTokens / 2));
        continue;
      }
      failures.push(`${model}@${maxTokens}: ${msg}`);
      break;
    }
  }

  throw new Error(failures.join(' | '));
}

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/v1/analyze', async (req, res) => {
  const openRouterKeys = collectApiKeyChain('OPENROUTER_API_KEY')
    .map(normalizeOpenRouterApiKey)
    .filter(Boolean);
  if (openRouterKeys.length === 0) {
    res.status(500).json({
      error:
        'Server missing OPENROUTER_API_KEY: set it in env (optional OPENROUTER_API_KEY_2 … _4). Models default to Gemini on OpenRouter (`google/gemini-*`) first — override with OPENROUTER_MODELS / OPENROUTER_MODEL.',
    });
    return;
  }
  if (!auth(req)) {
    res.status(401).json({
      error:
        'Invalid or missing bearer token. In the app, set App secret to the same value as CLIENT_BEARER_TOKEN on the server, or remove/clear CLIENT_BEARER_TOKEN on the server to disable auth.',
    });
    return;
  }

  const { toPhoneNumber, imageBase64, mimeType, prompt, qcmMode, photoSlot, clientTag } = req.body || {};
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    res.status(400).json({ error: 'imageBase64 is required' });
    return;
  }
  const mime = typeof mimeType === 'string' && mimeType.startsWith('image/') ? mimeType : 'image/jpeg';
  const userPrompt = typeof prompt === 'string' && prompt.trim() ? prompt.trim() : DEFAULT_PROMPT;

  try {
    if (await getSuspended()) {
      res.status(503).json({
        error: 'API is temporarily suspended by the administrator. Try again later.',
        suspended: true,
      });
      return;
    }
  } catch (e) {
    console.error('[POST /v1/analyze] suspend check', e);
  }

  try {
  let processedMime = mime;
  let processedBase64 = imageBase64;
  try {
    const capped = await ensureUploadWithinLimits(processedBase64, processedMime);
    processedBase64 = capped.imageBase64;
    processedMime = capped.mimeType;
  } catch {
    // keep original
  }
  /** @type {'google_document_ai'|'server_enhanced'|'original'} */
  let imagePreparation = 'original';
  try {
    const deskewed = await tryDocumentAiPreprocess(processedBase64, processedMime);
    if (deskewed?.imageBase64) {
      processedBase64 = deskewed.imageBase64;
      processedMime = deskewed.mimeType;
      imagePreparation = 'google_document_ai';
    }
  } catch {
    // keep original if Document AI throws
  }
  if (isVercelServerless() && typeof processedBase64 === 'string' && processedBase64.length > 320_000) {
    try {
      const again = await ensureUploadWithinLimits(processedBase64, processedMime);
      processedBase64 = again.imageBase64;
      processedMime = again.mimeType;
    } catch {
      // keep
    }
  }
  if (ocrEnhanceEnabled() && imagePreparation !== 'google_document_ai') {
    try {
      const enhanced = await enhanceImageForOcr(processedBase64);
      processedMime = enhanced.mime;
      processedBase64 = enhanced.imageBase64;
      imagePreparation = 'server_enhanced';
    } catch {
      // keep current image if enhancement fails
    }
  }
  const dataUrl = `data:${processedMime};base64,${processedBase64}`;
  try {
    const needsValidQcm = Boolean(qcmMode);
    let textOut = '';
    let smsBody = '';
    let answerModel = '';
    const attemptErrors = [];

    /** @param {{ content: string; answerModel: string }} r */
    function acceptModelResult(r) {
      if (!r || r.content == null) return false;
      const raw = typeof r.content === 'string' ? r.content : String(r.content ?? '');
      if (!raw.trim()) return false;
      const body = needsValidQcm ? toQcmSmsFormat(raw) || '' : raw.trim();
      if (!body) return false;
      textOut = raw;
      smsBody = body;
      answerModel = r.answerModel || '';
      return true;
    }

    const qcmHint = needsValidQcm ? 'empty or unparseable QCM' : 'empty response';

    for (let i = 0; i < openRouterKeys.length; i += 1) {
      try {
        const r = await analyzeWithOpenRouter({ key: openRouterKeys[i], userPrompt, dataUrl });
        if (acceptModelResult(r)) break;
        attemptErrors.push(`OpenRouter key #${i + 1}: ${qcmHint}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        attemptErrors.push(`OpenRouter key #${i + 1}: ${msg}`);
      }
    }

    if (!smsBody) {
      const errOut =
        `All OpenRouter keys failed (${attemptErrors.length} attempt(s)): ${attemptErrors.join(' | ')}` +
        ` — Check OPENROUTER_API_KEY and credits at openrouter.ai. Default model chain tries \`google/gemini-*\` first, then other providers; set OPENROUTER_MODELS to customize. QCM mode needs at least ${MIN_QCM_PAIRS_ACCEPT} parsed question(s) (JSON or 1A-2B-style).`;
      res.status(502).json({ error: errOut });
      return;
    }
    try {
      const digits = String(toPhoneNumber || '').replace(/\D/g, '');
      const tagRaw = typeof clientTag === 'string' ? clientTag.trim().slice(0, 80) : '';
      const safeTag = /^[a-zA-Z0-9_.-]+$/.test(tagRaw) ? tagRaw : null;
      await appendSharedLog({
        body: smsBody,
        slot: typeof photoSlot === 'number' && Number.isFinite(photoSlot) ? photoSlot : null,
        qcmMode: Boolean(qcmMode),
        phoneTail: digits.length >= 4 ? digits.slice(-4) : null,
        clientTag: safeTag,
        answerModel: answerModel || null,
      });
    } catch (e) {
      console.error('[POST /v1/analyze] appendSharedLog', e);
    }
    res.json({
      text: textOut.trim(),
      smsBody,
      imagePreparation,
      answerModel: answerModel || undefined,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[POST /v1/analyze]', message);
    if (!res.headersSent) {
      res.status(500).json({ error: message || 'Internal server error' });
    }
  }
  } catch (fatal) {
    const message = fatal instanceof Error ? fatal.message : String(fatal);
    console.error('[POST /v1/analyze] fatal', message);
    if (!res.headersSent) {
      res.status(500).json({ error: message || 'Image pipeline failed' });
    }
  }
});

app.post('/v1/shared-logs', async (req, res) => {
  if (!auth(req)) {
    res.status(401).json({
      error:
        'Invalid or missing bearer token. In the app, set App secret to the same value as CLIENT_BEARER_TOKEN on the server, or remove/clear CLIENT_BEARER_TOKEN on the server to disable auth.',
    });
    return;
  }
  try {
    const limit = Number(req.body?.limit);
    const logs = await listSharedLogs(Number.isFinite(limit) ? limit : 200);
    res.json({ logs, kvConfigured: kvIsConfigured() });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[POST /v1/shared-logs]', message);
    res.status(500).json({ error: message || 'Internal server error' });
  }
});

app.post('/v1/network-config', async (req, res) => {
  if (!auth(req)) {
    res.status(401).json({
      error:
        'Invalid or missing bearer token. In the app, set App secret to the same value as CLIENT_BEARER_TOKEN on the server, or remove/clear CLIENT_BEARER_TOKEN on the server to disable auth.',
    });
    return;
  }
  try {
    const raw = await getNetworkSettings();
    const settings =
      raw && typeof raw === 'object'
        ? {
            backendUrl: raw.backendUrl || '',
            bearerToken: raw.bearerToken || '',
            phones: Array.isArray(raw.phones) ? raw.phones : ['', '', '', ''],
            updatedAt: raw.updatedAt,
          }
        : null;
    const lobbyResetNonce = await getLobbyResetNonce();
    res.json({ ok: true, settings, kvConfigured: kvIsConfigured(), lobbyResetNonce });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[POST /v1/network-config]', message);
    res.status(500).json({ error: message || 'Internal server error' });
  }
});

app.post('/v1/admin', async (req, res) => {
  if (!auth(req)) {
    res.status(401).json({
      error:
        'Invalid or missing bearer token. In the app, set App secret to the same value as CLIENT_BEARER_TOKEN on the server, or remove/clear CLIENT_BEARER_TOKEN on the server to disable auth.',
    });
    return;
  }
  const body = req.body || {};
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
      res.json({
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
            'Cannot toggle suspend from the app without Redis/KV. Set KV_REST_API_URL and KV_REST_API_TOKEN, or set SUSPEND_ALL_REQUESTS=true on the server and redeploy.',
        });
        return;
      }
      const ok = await setSuspended(true);
      if (!ok) {
        res.status(500).json({ error: 'Could not write suspend flag to KV.' });
        return;
      }
      res.json({ ok: true, suspended: true });
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
      res.json({ ok: true, suspended: false });
      return;
    }
    if (action === 'shared_logs' || action === 'list_shared_logs') {
      const limit = Number(body.limit);
      const logs = await listSharedLogs(Number.isFinite(limit) ? limit : 200);
      res.json({ logs, kvConfigured: kvIsConfigured() });
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
      res.json({ ok: true });
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
      res.json({ ok: true, lobbyResetNonce });
      return;
    }
    if (action === 'get_network_settings') {
      if (!kvIsConfigured()) {
        res.json({ ok: true, settings: null, kvConfigured: false });
        return;
      }
      const settings = await getNetworkSettings();
      res.json({ ok: true, settings, kvConfigured: true });
      return;
    }
    if (action === 'save_network_settings') {
      if (!kvIsConfigured()) {
        res.status(409).json({
          error:
            'Cannot save network settings without Redis/KV. Set KV_REST_API_URL and KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_*).',
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
      res.json({ ok: true });
      return;
    }
    res.status(400).json({
      error:
        'Unknown action. Use: status, suspend, resume, shared_logs, clear_shared_logs, reset_lobby, get_network_settings, save_network_settings.',
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[POST /v1/admin]', message);
    if (!res.headersSent) {
      res.status(500).json({ error: message || 'Internal server error' });
    }
  }
});

app.listen(PORT, () => {
  console.log(`PictureToSMS API listening on port ${PORT}`);
});
