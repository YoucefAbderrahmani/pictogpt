/**
 * Default OpenRouter chain when `OPENROUTER_MODEL` / `OPENROUTER_MODELS` are unset:
 * 1) Gemini on OpenRouter (`google/gemini-*`) — preferred.
 * 2) Other Google models on OpenRouter (`google/*`) — different endpoints / limits than 2.5 Flash.
 * 3) Non-Google vision-capable models — last resort when every `google/*` attempt fails (quota, 404, etc.).
 *
 * `analyzeWithOpenRouter` advances on `isOpenRouterSwitchModelError` (429/403/503/404, quota text, …).
 */
const DEFAULT_OPENROUTER_MODELS = [
  // Gemini on OpenRouter (preferred; try each until one accepts the request)
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
 * OpenRouter `model` field(s), tried in order.
 * `OPENROUTER_MODELS` (comma-separated) wins over `OPENROUTER_MODEL` when both are set.
 * Example — Gemini first, then your own tail: `OPENROUTER_MODELS=google/gemini-2.5-flash,google/gemini-2.5-pro,openai/gpt-4o-mini`
 * @returns {string[]}
 */
export function openRouterModelCandidates() {
  const multi = unwrapEnvString(process.env.OPENROUTER_MODELS ?? '');
  if (multi) {
    const list = multi
      .split(',')
      .map((s) => unwrapEnvString(s))
      .filter(Boolean);
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
  if (st === 429 || st === 503 || st === 404 || st === 403 || st === 408 || st === 529) return true;
  const m = String(message || '').toLowerCase();
  return /rate limit|quota|too many requests|overloaded|unavailable|provider returned|temporarily|timeout|try again|not found|no endpoints found|invalid model|exceeded your|current_quota|billing details|resource_exhausted|capacity|context length|deadline exceeded|aborted|upstream error|generativelanguage\.googleapis|consumer_suspended|permission denied|free tier|tokens per minute|requests per minute/i.test(
    m
  );
}
