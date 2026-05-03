/**
 * When `OPENROUTER_MODEL` / `OPENROUTER_MODELS` are unset: vision-capable OpenRouter models in order
 * (Flash first for cost; then other Gemini + GPT fallbacks when quota/rate/provider errors occur).
 */
const DEFAULT_OPENROUTER_MODELS = [
  'google/gemini-2.5-flash',
  'google/gemini-2.5-pro',
  'google/gemini-2.0-flash-001',
  'google/gemini-flash-1.5',
  'openai/gpt-4o-mini',
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
 * Example (flash only): `OPENROUTER_MODEL=google/gemini-2.5-flash`
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

/** Prefer next model in the chain (do not only shrink max_tokens). */
export function isOpenRouterSwitchModelError(message, httpStatus) {
  const st = Number(httpStatus);
  if (st === 429 || st === 503 || st === 404) return true;
  const m = String(message || '').toLowerCase();
  return /rate limit|quota|too many requests|overloaded|unavailable|provider returned|temporarily|timeout|try again|not found|no endpoints found|invalid model/i.test(
    m
  );
}
