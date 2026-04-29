import cors from 'cors';
import express from 'express';

const app = express();
const PORT = Number(process.env.PORT) || 8787;

app.use(cors());
app.use(express.json({ limit: '20mb' }));

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

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/v1/analyze', async (req, res) => {
  if (!GEMINI_KEY) {
    res.status(500).json({ error: 'Server missing GEMINI_API_KEY' });
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
  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(
        GEMINI_KEY
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
      res.status(502).json({ error: msg });
      return;
    }
    const parts = json?.candidates?.[0]?.content?.parts;
    const content = Array.isArray(parts)
      ? parts
          .map((p) => (typeof p?.text === 'string' ? p.text : ''))
          .join('')
          .trim()
      : '';
    if (!content || typeof content !== 'string') {
      res.status(502).json({ error: 'No text in model response' });
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
