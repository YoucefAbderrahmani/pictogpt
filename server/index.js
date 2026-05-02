import cors from 'cors';
import express from 'express';
import sharp from 'sharp';

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
  const t = String(key || '').trim();
  if (!t) return '';
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

function qcmAnswersFromParsed(parsed) {
  const raw =
    parsed?.answers ??
    parsed?.ANSWERS ??
    (Array.isArray(parsed) ? parsed : null);
  return Array.isArray(raw) ? raw : [];
}

function toQcmSmsFormat(rawText) {
  const raw = String(rawText || '');
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const answers = qcmAnswersFromParsed(parsed);
      const normalized = answers
        .map((entry) => ({
          q: Number(entry?.q ?? entry?.Q),
          a: String(entry?.a ?? entry?.A ?? '').toUpperCase(),
        }))
        .filter(
          (x) => Number.isFinite(x.q) && x.q >= 1 && x.q <= 999999 && /^[ABCDES]$/.test(x.a)
        );
      const byQ = new Map();
      for (const x of normalized) {
        byQ.set(x.q, x.a);
      }
      const deduped = [...byQ.entries()].sort((a, b) => a[0] - b[0]);
      if (deduped.length > 0) {
        return deduped.map(([q, a]) => `${q}${a}`).join('-');
      }
    } catch {
      // fall back to regex parsing
    }
  }
  const text = raw.toUpperCase();
  const pairs = [...text.matchAll(/(?:^|[^0-9])(\d{1,6})\s*[:.)-]?\s*([ABCDES])(?:[^A-Z]|$)/g)];
  if (pairs.length === 0) {
    return '';
  }
  const byQuestion = new Map();
  for (const m of pairs) {
    const q = Number(m[1]);
    if (!Number.isFinite(q)) continue;
    byQuestion.set(q, m[2]);
  }
  const ordered = [...byQuestion.entries()].sort((a, b) => a[0] - b[0]);
  return ordered.map(([q, ans]) => `${q}${ans}`).join('-');
}

const DEFAULT_PROMPT =
  'Describe what you see in this image clearly and concisely. The reply will be sent by SMS, so be direct and avoid markdown.';

function ocrEnhanceEnabled() {
  const raw = (process.env.OCR_IMAGE_ENHANCE || 'true').toLowerCase().trim();
  return !['0', 'false', 'off', 'no'].includes(raw);
}

async function enhanceImageForOcr(imageBase64) {
  const input = Buffer.from(imageBase64, 'base64');
  const output = await sharp(input)
    .grayscale()
    .normalize()
    .sharpen({ sigma: 1.2 })
    .png({ compressionLevel: 9 })
    .toBuffer();
  return {
    mime: 'image/png',
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

const OPENROUTER_MODEL_CANDIDATES = ['openai/gpt-4o', 'openai/gpt-4o-mini'];
const GEMINI_MODEL_CANDIDATES = [
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
];

function isOpenRouterTokenBudgetError(message) {
  const m = String(message || '').toLowerCase();
  return /afford|more credits|max_tokens|too many tokens requested/i.test(m);
}

function openRouterMessageContent(json) {
  const msgContent = json?.choices?.[0]?.message?.content;
  if (typeof msgContent === 'string') return msgContent.trim();
  if (Array.isArray(msgContent)) {
    return msgContent
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join('-')
      .trim();
  }
  return '';
}

async function analyzeWithOpenRouter({ key, userPrompt, dataUrl }) {
  const cap = envIntInRange('OPENROUTER_MAX_TOKENS', 1024, 256, 4096);
  const failures = [];

  for (const model of OPENROUTER_MODEL_CANDIDATES) {
    let maxTokens = cap;
    while (maxTokens >= 256) {
      const openRouterRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
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

      const json = await openRouterRes.json().catch(() => ({}));
      if (openRouterRes.ok) {
        const content = openRouterMessageContent(json);
        if (content) return content;
        failures.push(`${model}@${maxTokens}: empty model response`);
        break;
      }

      const msg = json?.error?.message || `OpenRouter error (${openRouterRes.status})`;
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

function isGeminiQuotaOrRateError(message) {
  const m = String(message || '').toLowerCase();
  return /quota|resource_exhausted|rate limit|429|too many requests/i.test(m);
}

async function analyzeWithGemini({ key, userPrompt, mime, imageBase64 }) {
  const cap = envIntInRange('GEMINI_MAX_OUTPUT_TOKENS', 1024, 256, 8192);
  const failures = [];

  for (const model of GEMINI_MODEL_CANDIDATES) {
    let maxOutputTokens = cap;
    while (maxOutputTokens >= 256) {
      const body = JSON.stringify({
        contents: [
          {
            parts: [
              { text: userPrompt },
              {
                inline_data: {
                  mime_type: mime,
                  data: imageBase64,
                },
              },
            ],
          },
        ],
        generationConfig: {
          maxOutputTokens,
        },
      });

      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(
          key
        )}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body,
        }
      );

      const json = await geminiRes.json().catch(() => ({}));
      if (!geminiRes.ok) {
        const msg = json?.error?.message || `HTTP ${geminiRes.status}`;
        if (isGeminiQuotaOrRateError(msg) && maxOutputTokens > 256) {
          maxOutputTokens = Math.max(256, Math.floor(maxOutputTokens / 2));
          continue;
        }
        failures.push(`${model}@${maxOutputTokens}: ${msg}`);
        break;
      }

      const parts = json?.candidates?.[0]?.content?.parts;
      const content = Array.isArray(parts)
        ? parts
            .map((p) => (typeof p?.text === 'string' ? p.text : ''))
            .join('-')
            .trim()
        : '';
      if (content) {
        return content;
      }
      failures.push(`${model}@${maxOutputTokens}: empty or blocked response`);
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
  const geminiKeys = collectApiKeyChain('GEMINI_API_KEY');
  if (openRouterKeys.length === 0 && geminiKeys.length === 0) {
    res.status(500).json({
      error:
        'Server missing API keys: set OPENROUTER_API_KEY and/or GEMINI_API_KEY (optional _2, _3, _4 for extra fallbacks per provider)',
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

  const { toPhoneNumber, imageBase64, mimeType, prompt, qcmMode } = req.body || {};
  if (!toPhoneNumber || typeof toPhoneNumber !== 'string') {
    res.status(400).json({ error: 'toPhoneNumber is required' });
    return;
  }
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    res.status(400).json({ error: 'imageBase64 is required' });
    return;
  }
  const mime = typeof mimeType === 'string' && mimeType.startsWith('image/') ? mimeType : 'image/jpeg';
  const userPrompt = typeof prompt === 'string' && prompt.trim() ? prompt.trim() : DEFAULT_PROMPT;
  let processedMime = mime;
  let processedBase64 = imageBase64;
  if (ocrEnhanceEnabled()) {
    try {
      const enhanced = await enhanceImageForOcr(imageBase64);
      processedMime = enhanced.mime;
      processedBase64 = enhanced.imageBase64;
    } catch {
      // keep original image if enhancement fails
    }
  }
  const dataUrl = `data:${processedMime};base64,${processedBase64}`;
  try {
    let content = '';
    const attemptErrors = [];

    for (let i = 0; i < openRouterKeys.length; i += 1) {
      try {
        content = await analyzeWithOpenRouter({ key: openRouterKeys[i], userPrompt, dataUrl });
        if (content) break;
        attemptErrors.push(`OpenRouter key #${i + 1}: empty response`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        attemptErrors.push(`OpenRouter key #${i + 1}: ${msg}`);
      }
    }

    if (!content) {
      for (let i = 0; i < geminiKeys.length; i += 1) {
        try {
          content = await analyzeWithGemini({
            key: geminiKeys[i],
            userPrompt,
            mime: processedMime,
            imageBase64: processedBase64,
          });
          if (content) break;
          attemptErrors.push(`Gemini key #${i + 1}: empty response`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          attemptErrors.push(`Gemini key #${i + 1}: ${msg}`);
        }
      }
    }

    if (!content) {
      res.status(502).json({
        error: `All API keys failed (${attemptErrors.length} attempt(s)): ${attemptErrors.join(' | ')}`,
      });
      return;
    }

    const smsBody = qcmMode ? toQcmSmsFormat(content) : content.trim();
    if (!smsBody) {
      res.status(502).json({ error: 'Could not parse QCM answers from model response' });
      return;
    }
    res.json({ text: content.trim(), smsBody });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: message });
  }
});

app.listen(PORT, () => {
  console.log(`PictureToSMS API listening on port ${PORT}`);
});
