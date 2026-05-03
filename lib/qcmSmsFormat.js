/** First line: first N characters of the lowest-q question stem, then space + `...` (no quotes). */
export const QCM_STEM_SNIPPET_LEN = 11;

/** Minimum distinct questions required to treat QCM as sendable (1 = accept a single parsed question). */
export const MIN_QCM_PAIRS_ACCEPT = 1;

export function qcmAnswersFromParsed(parsed) {
  const raw =
    parsed?.answers ??
    parsed?.ANSWERS ??
    (Array.isArray(parsed) ? parsed : null);
  return Array.isArray(raw) ? raw : [];
}

/** Line 1 + newline + compact line; e.g. `1)The stem he …\n1A-2B` (legacy `q)___…` still matches). */
export function hasQcmStemHeaderFormat(s) {
  const t = String(s ?? '').trim();
  return /^\d{1,6}\)[^\r\n]+\r?\n(?:\d{1,6}[ABCDES])(?:-\d{1,6}[ABCDES])*$/i.test(t);
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
  return slice.length ? `${slice} ...` : '— ...';
}

/** Compact-only prefix: second line of stem format, or strip legacy quoted tail. */
export function qcmLeadingCompact(body) {
  const t = String(body ?? '').trim();
  const stemFmt = /^(\d{1,6}\)[^\r\n]*)\r?\n(((?:\d{1,6}[ABCDES])(?:-\d{1,6}[ABCDES])*))$/i.exec(t);
  if (stemFmt) return stemFmt[2].replace(/\s+/g, '');
  let idx = t.search(/\r?\n\s*"/);
  if (idx < 0) idx = t.search(/\s{3,}"/);
  const head = idx >= 0 ? t.slice(0, idx) : t;
  return head.replace(/\s+/g, '');
}

/** Map model output to compact letter: A–E/S, or digits 1–5 → A–E (numbered-option sheets). */
function normalizeAnswerChoiceToLetter(raw) {
  const s = String(raw ?? '').trim().toUpperCase();
  if (/^[ABCDES]$/.test(s)) return s;
  if (/^[1-5]$/.test(s)) return 'ABCDE'[Number(s) - 1];
  return '';
}

function dedupeSortedPairs(pairs) {
  const byQ = new Map();
  for (const [q, a] of pairs) {
    if (!Number.isFinite(q) || q < 1 || q > 999999) continue;
    const letter = normalizeAnswerChoiceToLetter(a);
    if (!letter) continue;
    byQ.set(q, letter);
  }
  return [...byQ.entries()].sort((a, b) => a[0] - b[0]);
}

/** When JSON is broken but fragments contain `"q":` / `"a":` pairs nearby. */
function extractAnswerLetterFromJsonSlice(slice) {
  let am = /"(?:a|A)"\s*:\s*"([ABCDES])"/i.exec(slice);
  if (am) return normalizeAnswerChoiceToLetter(am[1]);
  am = /"(?:a|A)"\s*:\s*"([1-5])"/i.exec(slice);
  if (am) return normalizeAnswerChoiceToLetter(am[1]);
  am = /"(?:a|A)"\s*:\s*([1-5])\s*[,}\]]/.exec(slice);
  if (am) return normalizeAnswerChoiceToLetter(am[1]);
  return '';
}

function looseJsonPairsFromText(raw) {
  const out = [];
  const qre = /"(?:q|Q)"\s*:\s*(\d+)/g;
  let m;
  while ((m = qre.exec(raw)) !== null) {
    const q = Number(m[1]);
    const from = m.index + m[0].length;
    const slice = raw.slice(from, from + 2800);
    const letter = extractAnswerLetterFromJsonSlice(slice);
    if (letter && Number.isFinite(q) && q >= 1 && q <= 999999) {
      out.push([q, letter]);
    }
  }
  return dedupeSortedPairs(out);
}

function pairsFromStrictJson(jsonStr) {
  try {
    const parsed = JSON.parse(jsonStr);
    const answers = qcmAnswersFromParsed(parsed);
    const normalized = answers
      .map((entry) => ({
        q: Number(entry?.q ?? entry?.Q),
        a: normalizeAnswerChoiceToLetter(entry?.a ?? entry?.A ?? ''),
      }))
      .filter((x) => Number.isFinite(x.q) && x.q >= 1 && x.q <= 999999 && /^[ABCDES]$/.test(x.a));
    const deduped = dedupeSortedPairs(normalized.map(({ q, a }) => [q, a]));
    return { deduped, parsed };
  } catch {
    return { deduped: [], parsed: null };
  }
}

function pairsFromRegexScan(raw) {
  const text = String(raw || '').toUpperCase();
  const pairs = [...text.matchAll(/(?:^|[^0-9])(\d{1,6})\s*[:.)-]?\s*([ABCDES])(?:[^A-Z]|$)/g)];
  const acc = [];
  for (const m of pairs) {
    const q = Number(m[1]);
    if (!Number.isFinite(q)) continue;
    acc.push([q, m[2]]);
  }
  return dedupeSortedPairs(acc);
}

/** e.g. `1→3`, `2: 5`, `Q3 -> 1` (numbered chosen option 1–5 → A–E). */
function pairsFromArrowOrColonNumericAnswers(raw) {
  const text = String(raw || '');
  const acc = [];
  const re =
    /(?:^|[\s;,])(?:Q|QUESTION)\s*(\d{1,4})\s*(?:[:.)-]|→|->)\s*([1-5])\b|(?:^|[\s;,])(\d{1,4})\s*(?:→|->)\s*([1-5])\b|(?:^|[\s;,])(\d{1,4})\s*:\s*([1-5])\b/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    let q;
    let digit;
    if (m[1] != null && m[2] != null) {
      q = Number(m[1]);
      digit = m[2];
    } else if (m[3] != null && m[4] != null) {
      q = Number(m[3]);
      digit = m[4];
    } else if (m[5] != null && m[6] != null) {
      q = Number(m[5]);
      digit = m[6];
    } else continue;
    if (!Number.isFinite(q) || q < 1) continue;
    const letter = normalizeAnswerChoiceToLetter(digit);
    if (letter) acc.push([q, letter]);
  }
  return dedupeSortedPairs(acc);
}

function stripCommonJsonWrappers(s) {
  let t = String(s || '').trim();
  t = t.replace(/^\uFEFF/, '');
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  return t.trim();
}

function formatStemAndCompact(deduped, parsedForStem) {
  if (deduped.length < MIN_QCM_PAIRS_ACCEPT) return '';
  const compact = deduped.map(([q, a]) => `${q}${a}`).join('-');
  const firstQ = deduped[0][0];
  const snippet =
    parsedForStem != null ? firstQuestionStemSnippet(parsedForStem, firstQ) : '— ...';
  const head = `${firstQ})${snippet}`;
  return `${head}\n${compact}`;
}

/**
 * Build QCM SMS body (without photo `slot)__` prefix): line1 = `q)` + first 11 stem chars + ` ...`, line2 = compact key.
 * Requires at least MIN_QCM_PAIRS_ACCEPT distinct question(s) (partial sheet OK).
 * Tries strict JSON, loose JSON fragments, then regex on full text; picks the longest valid parse ≥ minimum.
 */
export function toQcmSmsFormat(rawText) {
  const raw = String(rawText || '');
  const jsonMatch = raw.match(/\{[\s\S]*\}/);

  const candidates = [];

  if (jsonMatch) {
    const inner = stripCommonJsonWrappers(jsonMatch[0]);
    const strict = pairsFromStrictJson(inner);
    if (strict.deduped.length > 0) {
      candidates.push({
        n: strict.deduped.length,
        deduped: strict.deduped,
        parsed: strict.parsed,
      });
    }
    const loose = looseJsonPairsFromText(jsonMatch[0]);
    if (loose.length > 0) {
      candidates.push({ n: loose.length, deduped: loose, parsed: null });
    }
  }

  const regexPairs = pairsFromRegexScan(raw);
  if (regexPairs.length > 0) {
    candidates.push({ n: regexPairs.length, deduped: regexPairs, parsed: null });
  }

  const arrowPairs = pairsFromArrowOrColonNumericAnswers(raw);
  if (arrowPairs.length > 0) {
    candidates.push({ n: arrowPairs.length, deduped: arrowPairs, parsed: null });
  }

  const viable = candidates.filter((c) => c.n >= MIN_QCM_PAIRS_ACCEPT);
  if (!viable.length) return '';

  viable.sort((a, b) => {
    if (b.n !== a.n) return b.n - a.n;
    const bp = b.parsed != null ? 1 : 0;
    const ap = a.parsed != null ? 1 : 0;
    return bp - ap;
  });
  const best = viable[0];
  return formatStemAndCompact(best.deduped, best.parsed);
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
