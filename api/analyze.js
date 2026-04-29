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

function toQcmSmsFormat(rawText) {
  const text = String(rawText || '').toUpperCase();
  const pairs = [...text.matchAll(/(\d+)\s*[:.)-]?\s*([ABCD])/g)];
  if (pairs.length > 0) {
    return pairs.map((m) => m[2]).join('-');
  }
  const letters = text.match(/[ABCD]/g) || [];
  return letters.join('-');
}

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

  const openRouterKey = process.env.OPENROUTER_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!openRouterKey && !geminiKey) {
    res.status(500).json({ error: 'Server missing OPENROUTER_API_KEY and GEMINI_API_KEY' });
    return;
  }
  if (!isAuthorized(req)) {
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
  const userPrompt =
    typeof prompt === 'string' && prompt.trim() ? prompt.trim() : DEFAULT_PROMPT;
  const dataUrl = `data:${mime};base64,${imageBase64}`;

  try {
    let content = '';
    let openRouterError = '';

    if (openRouterKey) {
      try {
        content = await analyzeWithOpenRouter({ key: openRouterKey, userPrompt, dataUrl });
      } catch (e) {
        openRouterError = e instanceof Error ? e.message : String(e);
      }
    }

    if (!content && geminiKey) {
      content = await analyzeWithGemini({
        key: geminiKey,
        userPrompt,
        mime,
        imageBase64,
      });
    }

    if (!content && openRouterError) {
      res.status(502).json({ error: `OpenRouter failed and no Gemini fallback succeeded: ${openRouterError}` });
      return;
    }

    const smsBody = qcmMode ? toQcmSmsFormat(content) : content;
    if (!smsBody) {
      res.status(502).json({ error: 'Could not parse QCM answers from model response' });
      return;
    }
    res.status(200).json({ text: content, smsBody });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: message });
  }
}
