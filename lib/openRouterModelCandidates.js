/**
 * Default OpenRouter chain when `OPENROUTER_MODEL` / `OPENROUTER_MODELS` are unset:
 * 1) Gemini 3 Flash Preview on OpenRouter (`google/gemini-3-flash-preview`) — first priority.
 * 2) Other Gemini / `google/*` vision models — fallbacks for quota, routing, or 404.
 * 3) Non-Google vision-capable models — last resort when every `google/*` attempt fails.
 *
 * `analyzeWithOpenRouter` advances on `isOpenRouterSwitchModelError` (429/403/503/404, quota text, …).
 */
const DEFAULT_OPENROUTER_MODELS = [
  // Gemini on OpenRouter (preferred; try each until one accepts the request)
  'google/gemini-3-flash-preview',
  'google/gemini-2.5-flash',
  'google/gemini-2.5-pro',
  'google/gemini-2.0-flash-001',
  'google/gemini-2.0-flash-exp:free',
  'google/gemini-flash-1.5',
  'google/gemini-flash-1.5-8b',
  'google/gemini-pro-1.5',
  'google/gemini-1.5-flash',
  // Non-Google vision fallbacks when every `google/*` route fails (quota, routing, etc.)
  'openai/gpt-4o-mini',
  'meta-llama/llama-3.2-11b-vision-instruct',
  'anthropic/claude-3-haiku',
  'openai/gpt-4o',
];

function unwrapEnvString(raw) {
  let s = String(raw ?? '').replace(/^\uFEFF/, '').trim();
  if (s.length >= 2) {
    const a = s[0];
    const b = s[s.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) {
      s = s.slice(1, -1).trim();
    }
  }
  return s;
}

/**
 * Split `OPENROUTER_MODELS` (commas, semicolons, full-width comma, newlines).
 * Handles a pasted list that was wrapped in quotes or a single segment that still
 * contains commas (so we never send the whole string as one `model` id).
 * @param {string} raw
 * @returns {string[]}
 */
export function splitOpenRouterModelsEnvLine(raw) {
  const s = unwrapEnvString(raw);
  if (!s) return [];
  const out = [];
  const seen = new Set();
  const pushUnique = (id) => {
    const t = unwrapEnvString(id);
    if (!t || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };
  const wave1 = s.split(/[,，;\n\r]+/).map(unwrapEnvString).filter(Boolean);
  for (const seg of wave1) {
    if (/[,，]/.test(seg)) {
      for (const inner of seg.split(/[,，]+/).map(unwrapEnvString).filter(Boolean)) {
        pushUnique(inner);
      }
    } else {
      pushUnique(seg);
    }
  }
  return out;
}

/** Assistant text from OpenRouter (OpenAI-style) chat completion JSON. */
export function openRouterMessageContent(json) {
  const choice = json?.choices?.[0];
  const msgContent = choice?.message?.content;
  if (typeof msgContent === 'string') {
    const t = msgContent.trim();
    if (t) return t;
  }
  if (Array.isArray(msgContent)) {
    const joined = msgContent
      .map((part) => {
        if (part == null) return '';
        if (typeof part === 'string') return part;
        if (typeof part?.text === 'string') return part.text;
        if (part?.type === 'text' && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('');
    if (joined.trim()) return joined.trim();
  }
  if (typeof choice?.text === 'string' && choice.text.trim()) return choice.text.trim();
  return '';
}

/**
 * OpenRouter expects attribution headers on server-side calls; without them some
 * accounts/routes return errors or empty completions. Override with OPENROUTER_HTTP_REFERER
 * (full URL) and OPENROUTER_APP_TITLE if needed.
 * @returns {Record<string, string>}
 */
export function openRouterOutboundHeaders() {
  let explicit = unwrapEnvString(process.env.OPENROUTER_HTTP_REFERER ?? '');
  if (explicit && !/^https?:\/\//i.test(explicit)) {
    explicit = `https://${explicit.replace(/^\/+/, '')}`;
  }
  const vercelHost = unwrapEnvString(process.env.VERCEL_URL ?? '').replace(/^https?:\/\//, '');
  const referer =
    explicit ||
    (vercelHost ? `https://${vercelHost}` : '') ||
    'https://pictogpt.vercel.app';
  const title = unwrapEnvString(process.env.OPENROUTER_APP_TITLE ?? '') || 'PictureToSMS';
  return {
    'HTTP-Referer': referer,
    'X-OpenRouter-Title': title,
    'X-Title': title,
  };
}

/**
 * OpenRouter `model` field(s), tried in order.
 * `OPENROUTER_MODELS` (comma-separated) wins over `OPENROUTER_MODEL` when both are set.
 * Example — Gemini 3 Flash first, then your own tail: `OPENROUTER_MODELS=google/gemini-3-flash-preview,google/gemini-2.5-flash,openai/gpt-4o-mini`
 * @returns {string[]}
 */
export function openRouterModelCandidates() {
  const multi = unwrapEnvString(process.env.OPENROUTER_MODELS ?? '');
  if (multi) {
    const list = splitOpenRouterModelsEnvLine(multi);
    if (list.length) return list;
  }
  const one = unwrapEnvString(process.env.OPENROUTER_MODEL ?? '');
  if (one) return [one];
  return [...DEFAULT_OPENROUTER_MODELS];
}

/** Read body once; keep error text if JSON.parse fails (HTML/proxy or non-JSON errors). */
export async function readOpenRouterApiResponseBody(res) {
  const rawBody = await res.text();
  let json = {};
  try {
    json = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    json = {
      error: {
        message: (rawBody || '').slice(0, 800) || `HTTP ${res.status}`,
      },
    };
  }
  return { json, rawBody };
}

/**
 * Prefer next model in the chain (quota, overload, missing model, etc.).
 * Not for a bad API key (401) — same failure would repeat across models.
 */
export function isOpenRouterSwitchModelError(message, httpStatus) {
  const st = Number(httpStatus);
  const m = String(message || '').toLowerCase();
  if (st === 429 || st === 503 || st === 404 || st === 408 || st === 529) return true;
  if (st === 403) {
    return /rate limit|quota|exceeded your|current_quota|billing|permission denied|resource_exhausted|capacity|generativelanguage|consumer_suspended|tokens per minute|requests per minute|free tier/i.test(
      m
    );
  }
  return /rate limit|quota|too many requests|overloaded|unavailable|provider returned|temporarily|timeout|try again|not found|no endpoints found|invalid model|exceeded your|current_quota|billing details|resource_exhausted|capacity|context length|deadline exceeded|aborted|upstream error|generativelanguage\.googleapis|consumer_suspended|permission denied|free tier|tokens per minute|requests per minute/i.test(
    m
  );
}
