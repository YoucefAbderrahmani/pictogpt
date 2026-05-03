/** After `)` on line 1: three underscores before the stem snippet. */
export const QCM_HEAD_SEPARATOR = '___';

/** First line: first N characters of the lowest-q question stem, then a colon (no quotes). */
export const QCM_STEM_SNIPPET_LEN = 14;

export function qcmAnswersFromParsed(parsed) {
  const raw =
    parsed?.answers ??
    parsed?.ANSWERS ??
    (Array.isArray(parsed) ? parsed : null);
  return Array.isArray(raw) ? raw : [];
}

/** Line 1 + newline + compact line; e.g. `37)___The examination…:\n37A-38B`. */
export function hasQcmStemHeaderFormat(s) {
  const t = String(s ?? '').trim();
  return /^\d{1,6}\)___[^\r\n]*\r?\n(?:\d{1,6}[ABCDES])(?:-\d{1,6}[ABCDES])*$/i.test(t);
}

/** Legacy: spaces or newline before a quoted tail after compact. */
export function hasQuotedAnswerTail(s) {
  const t = String(s ?? '').trim();
  return /\r?\n\s*"[^"]*"\s*$/i.test(t) || /\s{3,}"[^"]*"\s*$/i.test(t);
}

function firstQuestionStemSnippet(parsed, firstQ) {
  const entry = qcmAnswersFromParsed(parsed).find((e) => Number(e?.q ?? e?.Q) === firstQ);
  const stem =
    (entry && typeof entry.question === 'string' && entry.question) ||
    (entry && typeof entry.QUESTION === 'string' && entry.QUESTION) ||
    (entry && typeof entry.stem === 'string' && entry.stem) ||
    '';
  const flat = String(stem).replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  const slice = flat.slice(0, QCM_STEM_SNIPPET_LEN);
  return slice.length ? `${slice}:` : '—:';
}

/** Compact-only prefix: second line of stem format, or strip legacy quoted tail. */
export function qcmLeadingCompact(body) {
  const t = String(body ?? '').trim();
  const stemFmt = /^(\d{1,6}\)___[^\r\n]*)\r?\n(((?:\d{1,6}[ABCDES])(?:-\d{1,6}[ABCDES])*))$/i.exec(t);
  if (stemFmt) return stemFmt[2].replace(/\s+/g, '');
  let idx = t.search(/\r?\n\s*"/);
  if (idx < 0) idx = t.search(/\s{3,}"/);
  const head = idx >= 0 ? t.slice(0, idx) : t;
  return head.replace(/\s+/g, '');
}

/**
 * Build QCM SMS body (without photo `slot)__` prefix): line1 = `q)___` + first 14 stem chars + `:`, line2 = compact key.
 * No ASCII double quotes. Used by Vercel analyze and client merge fallback.
 */
export function toQcmSmsFormat(rawText) {
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
        .filter(
          (x) => Number.isFinite(x.q) && x.q >= 1 && x.q <= 999999 && /^[ABCDES]$/.test(x.a)
        );
      const byQ = new Map();
      for (const x of normalized) {
        byQ.set(x.q, x.a);
      }
      const deduped = [...byQ.entries()].sort((a, b) => a[0] - b[0]);
      if (deduped.length > 0) {
        const compact = deduped.map(([q, a]) => `${q}${a}`).join('-');
        const firstQ = deduped[0][0];
        const snippet = firstQuestionStemSnippet(parsed, firstQ);
        const head = `${firstQ})${QCM_HEAD_SEPARATOR}${snippet}`;
        return `${head}\n${compact}`;
      }
    } catch {
      // fall back to regex parsing
    }
  }
  const text = raw.toUpperCase();
  const pairs = [...text.matchAll(/(?:^|[^0-9])(\d{1,6})\s*[:.)-]?\s*([ABCDES])(?:[^A-Z]|$)/g)];
  if (pairs.length === 0) {
    return '';
  }
  const byQuestion = new Map();
  for (const m of pairs) {
    const q = Number(m[1]);
    if (!Number.isFinite(q)) continue;
    byQuestion.set(q, m[2]);
  }
  const ordered = [...byQuestion.entries()].sort((a, b) => a[0] - b[0]);
  return ordered.map(([q, ans]) => `${q}${ans}`).join('-');
}

/**
 * When `smsBody` is missing the stem header block, rebuild from JSON in `modelText` (app fallback).
 */
export function mergeQcmSmsBodyWithTailFromModel(smsBody, modelText) {
  const s = String(smsBody ?? '').trim();
  if (hasQcmStemHeaderFormat(s) || hasQuotedAnswerTail(s)) return s;
  const fromModel = toQcmSmsFormat(String(modelText ?? ''));
  if (fromModel && hasQcmStemHeaderFormat(fromModel)) {
    if (!s) return fromModel;
    if (qcmLeadingCompact(s) === qcmLeadingCompact(fromModel)) return fromModel;
  }
  const fromSms = toQcmSmsFormat(s);
  if (fromSms && hasQcmStemHeaderFormat(fromSms)) return fromSms;
  return fromModel || fromSms || s;
}
