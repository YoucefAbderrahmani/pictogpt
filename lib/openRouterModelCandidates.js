/**
 * When `OPENROUTER_MODEL` / `OPENROUTER_MODELS` are unset: Gemini 2.5 Flash on OpenRouter, then a small OpenAI fallback.
 */
const DEFAULT_OPENROUTER_MODELS = ['google/gemini-2.5-flash', 'openai/gpt-4o-mini'];

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
