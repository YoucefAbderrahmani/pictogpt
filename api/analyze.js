import {
  isOpenRouterSwitchModelError,
  openRouterMessageContent,
  openRouterModelCandidates,
  openRouterOutboundHeaders,
  readOpenRouterApiResponseBody,
} from '../lib/openRouterModelCandidates.js';
import { MIN_QCM_PAIRS_ACCEPT, toQcmSmsFormat } from '../lib/qcmSmsFormat.js';

const DEFAULT_PROMPT =
  'Describe what you see in this image clearly and concisely. The reply will be sent by SMS, so be direct and avoid markdown.';

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

/** Primary env + optional `NAME_2`, `NAME_3`, `NAME_4`. Tried in order. */
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

function envIntInRange(name, defaultVal, min, max) {
  const raw = process.env[name];
  if (raw == null || raw === '') return defaultVal;
  const n = Number(raw);
  if (!Number.isFinite(n)) return defaultVal;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function isVercelServerless() {
  return Boolean(process.env.VERCEL);
}

/** On Vercel default off — avoids a second full sharp pass after cap + Document AI (OOM risk). */
function ocrEnhanceEnabled() {
  const onVercel = isVercelServerless();
  const def = onVercel ? 'false' : 'true';
  const raw = (process.env.OCR_IMAGE_ENHANCE ?? def).toLowerCase().trim();
  return !['0', 'false', 'off', 'no'].includes(raw);
}

/**
 * Vercel: re-encode almost every camera upload to <=1024px JPEG so Document AI + OpenRouter JSON
 * stay within ~1GB serverless heap. Non-Vercel: only downscale very large payloads.
 */
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
  /** Dynamic import so Vercel/serverless does not load `sharp` native bindings at cold-start module init. */
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

function isOpenRouterTokenBudgetError(message) {
  const m = String(message || '').toLowerCase();
  return /afford|more credits|max_tokens|too many tokens requested/i.test(m);
}

/** @returns {{ content: string; answerModel: string }} */
async function analyzeWithOpenRouter({ key, userPrompt, dataUrl }) {
  const cap = envIntInRange('OPENROUTER_MAX_TOKENS', 1024, 256, 4096);
  const failures = [];
  const models = openRouterModelCandidates();
  if (process.env.NODE_ENV !== 'test') {
    console.log('[api/analyze] OpenRouter model chain:', models.join(' → '));
  }

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

  const openRouterKeys = collectApiKeyChain('OPENROUTER_API_KEY')
    .map(normalizeOpenRouterApiKey)
    .filter(Boolean);
  if (openRouterKeys.length === 0) {
    res.status(500).json({
      error:
        'Server missing OPENROUTER_API_KEY: set it on Vercel (optional OPENROUTER_API_KEY_2 … _4). Models default to Gemini on OpenRouter (`google/gemini-*`) first, then other fallbacks — override with OPENROUTER_MODELS / OPENROUTER_MODEL.',
    });
    return;
  }
  if (!isAuthorized(req)) {
    res.status(401).json({
      error:
        'Invalid or missing bearer token. In the app, set App secret to the same value as CLIENT_BEARER_TOKEN on the server, or remove/clear CLIENT_BEARER_TOKEN on the server to disable auth.',
    });
    return;
  }

  const { toPhoneNumber, imageBase64, mimeType, prompt, qcmMode, photoSlot, clientTag } = body;
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    res.status(400).json({ error: 'imageBase64 is required' });
    return;
  }

  try {
    const { getSuspended } = await import('../lib/sharedStore.js');
    if (await getSuspended()) {
      res.status(503).json({
        error: 'API is temporarily suspended by the administrator. Try again later.',
        suspended: true,
      });
      return;
    }
  } catch (e) {
    console.error('[api/analyze] suspend check', e);
  }

  const mime = typeof mimeType === 'string' && mimeType.startsWith('image/') ? mimeType : 'image/jpeg';
  const userPrompt =
    typeof prompt === 'string' && prompt.trim() ? prompt.trim() : DEFAULT_PROMPT;

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
    // Google Cloud Document AI is disabled on Vercel — it was implicated in FUNCTION_INVOCATION_FAILED
    // (JWT + large payloads + memory). Run the API on Railway/Docker with VERCEL unset to use Document AI.
    if (!isVercelServerless()) {
      const { tryDocumentAiPreprocess } = await import('../server/documentAi.js');
      const deskewed = await tryDocumentAiPreprocess(processedBase64, processedMime);
      if (deskewed?.imageBase64) {
        processedBase64 = deskewed.imageBase64;
        processedMime = deskewed.mimeType;
        imagePreparation = 'google_document_ai';
      }
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
      const { appendSharedLog } = await import('../lib/sharedStore.js');
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
      console.error('[api/analyze] appendSharedLog', e);
    }
    res.status(200).json({
      text: textOut.trim(),
      smsBody,
      imagePreparation,
      answerModel: answerModel || undefined,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[api/analyze]', message);
    if (!res.headersSent) {
      res.status(500).json({ error: message || 'Internal server error' });
    }
  }
  } catch (fatal) {
    const message = fatal instanceof Error ? fatal.message : String(fatal);
    console.error('[api/analyze] fatal', message);
    if (!res.headersSent) {
      res.status(500).json({ error: message || 'Image pipeline failed' });
    }
  }
}
