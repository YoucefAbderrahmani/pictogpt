const DEFAULT_PROMPT =
  'Describe what you see in this image clearly and concisely. The reply will be sent by SMS, so be direct and avoid markdown.';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}

function isAuthorized(req) {
  const expected = process.env.CLIENT_BEARER_TOKEN;
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

  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    res.status(500).json({ error: 'Server missing GEMINI_API_KEY' });
    return;
  }
  if (!isAuthorized(req)) {
    res.status(401).json({ error: 'Invalid or missing bearer token' });
    return;
  }

  const { imageBase64, mimeType, prompt } = req.body || {};
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    res.status(400).json({ error: 'imageBase64 is required' });
    return;
  }

  const mime =
    typeof mimeType === 'string' && mimeType.startsWith('image/')
      ? mimeType
      : 'image/jpeg';
  const userPrompt =
    typeof prompt === 'string' && prompt.trim() ? prompt.trim() : DEFAULT_PROMPT;

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(
        geminiKey
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

    if (!content) {
      res.status(502).json({ error: 'No text in model response' });
      return;
    }

    res.status(200).json({ text: content });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: message });
  }
}
