/**
 * Default order: Flash family first (cheap), then older Flash, then Pro as last same-key fallback
 * when 2.5 Flash hits quota on Vercel. Override with GEMINI_MODEL or GEMINI_MODELS (comma-separated).
 */
const DEFAULT_GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-flash-latest',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
  'gemini-2.5-pro',
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
 * Model ids for `generativelanguage.googleapis.com/.../models/{id}:generateContent`.
 * `GEMINI_MODELS` wins over `GEMINI_MODEL` when both are set.
 * @returns {string[]}
 */
export function geminiModelCandidates() {
  const multi = unwrapEnvString(process.env.GEMINI_MODELS ?? '');
  if (multi) {
    const list = multi
      .split(',')
      .map((s) => unwrapEnvString(s))
      .filter(Boolean);
    if (list.length) return list;
  }
  const one = unwrapEnvString(process.env.GEMINI_MODEL ?? '');
  if (one) return [one];
  return [...DEFAULT_GEMINI_MODELS];
}

/**
 * HTTP or API errors where retrying the **next** model id (or next API key upstream) is appropriate.
 * Not for logic errors that the same model would repeat.
 */
export function isGeminiSwitchModelError(message, httpStatus, apiError) {
  const st = Number(httpStatus);
  if (st === 429 || st === 503 || st === 403) return true;
  const m = String(message || '').toLowerCase();
  const apiStatus = String(apiError?.status ?? apiError?.code ?? '').toUpperCase();
  if (/RESOURCE_EXHAUSTED|UNAVAILABLE|DEADLINE_EXCEEDED|ABORTED|OVERLOADED/.test(apiStatus)) {
    return true;
  }
  if (/PERMISSION_DENIED|INVALID_ARGUMENT/.test(apiStatus)) {
    if (/quota|rate|exhausted|billing|limit|exceeded|unavailable|overload|deadline/i.test(m)) return true;
  }
  if (st === 400 && /quota|resource_exhausted|billing|exceeded|rate|limit/i.test(m)) return true;
  if (st === 404 && /not found|does not exist|unknown model|unsupported/i.test(m)) return true;
  return (
    /quota|rate limit|exceeded your|current_quota|billing details|too many requests|requests per minute|tokens per minute|tpm|rpm|resource_exhausted|billing has not been enabled|billing|free tier|limit: \d|consumer_suspended|try again later|temporarily|generativelanguage\.googleapis\.com/i.test(
      m
    )
  );
}

/** Read body once; keep error text if JSON.parse fails (common on proxy/HTML errors). */
export async function readGeminiApiResponseBody(res) {
  const rawBody = await res.text();
  let json = {};
  try {
    json = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    json = {
      error: {
        message: (rawBody || '').slice(0, 600) || `HTTP ${res.status}`,
        status: 'INVALID_JSON',
      },
    };
  }
  return { json, rawBody };
}
