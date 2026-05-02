import cors from 'cors';
import express from 'express';

const app = express();
const PORT = Number(process.env.PORT) || 8787;

app.use(cors());
app.use(express.json({ limit: '20mb' }));

const CLIENT_BEARER = process.env.CLIENT_BEARER_TOKEN;

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

function auth(req) {
  if (!CLIENT_BEARER) return true;
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  return token === CLIENT_BEARER;
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
        .filter((x) => Number.isFinite(x.q) && /^[ABCDE]$/.test(x.a))
        .sort((x, y) => x.q - y.q)
        .map((x) => ({ q: x.q, a: x.a }));
      if (normalized.length > 0) {
        const contiguous = normalized.every((x, idx) => x.q === idx + 1);
        if (!contiguous) {
          return '';
        }
        return normalized.map((x) => `${x.q}${x.a}`).join('');
      }
    } catch {
      // fall back to regex parsing
    }
  }
  const text = raw.toUpperCase();
  const pairs = [...text.matchAll(/(?:^|[^0-9])(\d{1,3})\s*[:.)-]?\s*([ABCDE])(?:[^A-Z]|$)/g)];
  if (pairs.length === 0) {
    return '';
  }
  const byQuestion = new Map();
  for (const m of pairs) {
    const q = Number(m[1]);
    if (!Number.isFinite(q)) continue;
    byQuestion.set(q, m[2]);
  }
  const ordered = [...byQuestion.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([q, ans]) => ({ q, ans }));
  const contiguous = ordered.every((item, idx) => item.q === idx + 1);
  if (!contiguous) {
    return '';
  }
  return ordered.map((item) => `${item.q}${item.ans}`).join('');
}

const DEFAULT_PROMPT =
  'Describe what you see in this image clearly and concisely. The reply will be sent by SMS, so be direct and avoid markdown.';

async function analyzeWithOpenRouter({ key, userPrompt, dataUrl }) {
  const openRouterRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'openai/gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: userPrompt },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
      max_tokens: 4096,
    }),
  });

  const json = await openRouterRes.json().catch(() => ({}));
  if (!openRouterRes.ok) {
    const msg = json?.error?.message || `OpenRouter error (${openRouterRes.status})`;
    throw new Error(msg);
  }

  const msgContent = json?.choices?.[0]?.message?.content;
  const content =
    typeof msgContent === 'string'
      ? msgContent.trim()
      : Array.isArray(msgContent)
        ? msgContent
            .map((part) => (typeof part?.text === 'string' ? part.text : ''))
            .join('')
            .trim()
        : '';
  if (!content) {
    throw new Error('No text in model response');
  }
  return content;
}

async function analyzeWithGemini({ key, userPrompt, mime, imageBase64 }) {
  const geminiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(
      key
    )}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
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
          maxOutputTokens: 4096,
        },
      }),
    }
  );

  const json = await geminiRes.json().catch(() => ({}));
  if (!geminiRes.ok) {
    const msg = json?.error?.message || `Gemini error (${geminiRes.status})`;
    throw new Error(msg);
  }

  const parts = json?.candidates?.[0]?.content?.parts;
  const content = Array.isArray(parts)
    ? parts
        .map((p) => (typeof p?.text === 'string' ? p.text : ''))
        .join('')
        .trim()
    : '';
  if (!content) {
    throw new Error('No text in model response');
  }
  return content;
}

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/v1/analyze', async (req, res) => {
  const openRouterKeys = collectApiKeyChain('OPENROUTER_API_KEY');
  const geminiKeys = collectApiKeyChain('GEMINI_API_KEY');
  if (openRouterKeys.length === 0 && geminiKeys.length === 0) {
    res.status(500).json({
      error:
        'Server missing API keys: set OPENROUTER_API_KEY and/or GEMINI_API_KEY (optional _2, _3, _4 for extra fallbacks per provider)',
    });
    return;
  }
  if (!auth(req)) {
    res.status(401).json({ error: 'Invalid or missing bearer token' });
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
  const dataUrl = `data:${mime};base64,${imageBase64}`;
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
            mime,
            imageBase64,
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
