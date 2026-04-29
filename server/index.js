import cors from 'cors';
import express from 'express';

const app = express();
const PORT = Number(process.env.PORT) || 8787;

app.use(cors());
app.use(express.json({ limit: '20mb' }));

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const CLIENT_BEARER = process.env.CLIENT_BEARER_TOKEN;

function auth(req) {
  if (!CLIENT_BEARER) return true;
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  return token === CLIENT_BEARER;
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
      model: 'openai/gpt-4o-mini',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: userPrompt },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
      max_tokens: 1200,
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
          maxOutputTokens: 1200,
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
  if (!OPENROUTER_KEY && !GEMINI_KEY) {
    res.status(500).json({ error: 'Server missing OPENROUTER_API_KEY and GEMINI_API_KEY' });
    return;
  }
  if (!auth(req)) {
    res.status(401).json({ error: 'Invalid or missing bearer token' });
    return;
  }

  const { imageBase64, mimeType, prompt } = req.body || {};
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    res.status(400).json({ error: 'imageBase64 is required' });
    return;
  }
  const mime = typeof mimeType === 'string' && mimeType.startsWith('image/') ? mimeType : 'image/jpeg';
  const userPrompt = typeof prompt === 'string' && prompt.trim() ? prompt.trim() : DEFAULT_PROMPT;
  const dataUrl = `data:${mime};base64,${imageBase64}`;
  try {
    let content = '';
    let openRouterError = '';

    if (OPENROUTER_KEY) {
      try {
        content = await analyzeWithOpenRouter({ key: OPENROUTER_KEY, userPrompt, dataUrl });
      } catch (e) {
        openRouterError = e instanceof Error ? e.message : String(e);
      }
    }

    if (!content && GEMINI_KEY) {
      content = await analyzeWithGemini({
        key: GEMINI_KEY,
        userPrompt,
        mime,
        imageBase64,
      });
    }

    if (!content && openRouterError) {
      res.status(502).json({ error: `OpenRouter failed and no Gemini fallback succeeded: ${openRouterError}` });
      return;
    }

    res.json({ text: content.trim() });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: message });
  }
});

app.listen(PORT, () => {
  console.log(`PictureToSMS API listening on port ${PORT}`);
});
