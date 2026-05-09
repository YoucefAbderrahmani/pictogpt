/** First line uses only first 10 chars of question text, then `...`. */
export const QCM_STEM_SNIPPET_LEN = 10;
export const QCM_GROUP_SIZE = 10;
export const QCM_CONFIDENCE_THRESHOLD_PCT = 30;
export const QCM_MAX_AUTOFILL_SPAN = 400;

/** Minimum distinct questions required to treat QCM as sendable (1 = accept a single parsed question). */
export const MIN_QCM_PAIRS_ACCEPT = 1;

export function qcmAnswersFromParsed(parsed) {
  const raw =
    parsed?.answers ??
    parsed?.ANSWERS ??
    (Array.isArray(parsed) ? parsed : null);
  return Array.isArray(raw) ? raw : [];
}

/** Line 1 + newline + compact line; e.g. `25) The stem...\n25A-26B` (one `q)` only; slot `N)__` is added by the app). */
export function hasQcmStemHeaderFormat(s) {
  const t = String(s ?? '').trim();
  const nl = t.search(/\r?\n/);
  if (nl < 0) return false;
  const line1 = t.slice(0, nl).trim();
  const line2 = t.slice(nl + 1).split(/\r?\n/)[0].trim();
  const okNew = /^\d{1,6}[)]\s+.{1,10}\.\.\.$/.test(line1);
  const okLegacyGroup = /^\d{1,6}[)]__\d{1,6}[)]\s+.{1,10}\.\.\.$/.test(line1);
  if (!okNew && !okLegacyGroup) return false;
  return isValidQcmCompactLine(line2);
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
  return slice.length ? `${slice}...` : '??????????...';
}

/** Compact-only prefix: second line of stem format, or strip legacy quoted tail. */
export function qcmLeadingCompact(body) {
  const t = String(body ?? '').trim();
  const stemSingle = /^(\d{1,6}[)]\s+[^\r\n]*)\r?\n([^\r\n]+)$/i.exec(t);
  if (stemSingle && isValidQcmCompactLine(stemSingle[2])) return stemSingle[2].replace(/\s+/g, '');
  const stemFmt = /^(\d{1,6}[)]__\d{1,6}[)][^\r\n]*)\r?\n([^\r\n]+)$/i.exec(t);
  if (stemFmt && isValidQcmCompactLine(stemFmt[2])) return stemFmt[2].replace(/\s+/g, '');
  let idx = t.search(/\r?\n\s*"/);
  if (idx < 0) idx = t.search(/\s{3,}"/);
  const head = idx >= 0 ? t.slice(0, idx) : t;
  return head.replace(/\s+/g, '');
}

/** Sorted unique option letters A–Z (S reserved for skip, never in a bundle). */
function sortUniqueOptionLetters(s) {
  const letters = String(s || '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .split('')
    .filter((c) => c >= 'A' && c <= 'E' && c !== 'S');
  return [...new Set(letters)].sort().join('');
}

/**
 * Normalize model `a` field: **S** = skip; else one or more **A–Z** option letters (sorted, unique);
 * digits **1–5** → single letter A–E (numbered lists).
 */
export function normalizeAnswerChoices(raw) {
  if (raw == null) return '';
  if (Array.isArray(raw)) {
    const bits = [];
    for (const x of raw) {
      if (typeof x === 'string') bits.push(x);
      else if (x != null && typeof x === 'object' && typeof x.label === 'string') bits.push(x.label);
    }
    return normalizeAnswerChoices(bits.join(','));
  }
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= 5) {
    return 'ABCDE'[raw - 1];
  }
  const s = String(raw).trim().toUpperCase();
  if (!s) return '';
  if (s === 'TRUE' || s === 'T' || s === 'VRAI') return 'A';
  if (s === 'FALSE' || s === 'F' || s === 'FAUX') return 'B';
  if (s === 'S' || s === 'SKIP' || s === 'SKIPPED') return 'S';
  if (/^[1-5]$/.test(s)) return 'ABCDE'[Number(s) - 1];
  const lettersOnly = (s.match(/[A-Z]/g) || []).join('');
  if (!lettersOnly) return '';
  if (lettersOnly === 'S') return 'S';
  if (lettersOnly.includes('T') && !/[A-E]/.test(lettersOnly)) return 'A';
  if (lettersOnly.includes('F') && !/[A-E]/.test(lettersOnly)) return 'B';
  const noS = lettersOnly.replace(/S/g, '');
  if (lettersOnly.includes('S') && noS.length === 0) return 'S';
  const sorted = sortUniqueOptionLetters(noS || lettersOnly);
  return sorted || '';
}

/** Compact line: `1A-2BC-12S` — each segment is `q` + `S` or one/more A–E letters. */
export function isValidQcmCompactLine(compact) {
  const t = String(compact ?? '')
    .trim()
    .replace(/\s+/g, '');
  if (!t) return false;
  const parts = t.split('-');
  for (const p of parts) {
    const m = /^(\d{1,6})([A-ES]{1,5})$/i.exec(p);
    if (!m) return false;
    const tail = m[2].toUpperCase();
    if (tail === 'S') continue;
    if (!/^[A-E]{1,5}$/.test(tail)) return false;
  }
  return true;
}

function confidenceFromEntry(entry) {
  const raw = entry?.confidence ?? entry?.CONFIDENCE ?? entry?.conf ?? entry?.probability ?? null;
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n >= 0 && n <= 1) return n * 100;
  return n;
}

function normalizedAnswerFromEntry(entry) {
  const q = Number(entry?.q ?? entry?.Q);
  const conf = confidenceFromEntry(entry);
  if (conf != null && conf < QCM_CONFIDENCE_THRESHOLD_PCT) return { q, a: 'S' };
  const tf = entry?.type ?? entry?.kind ?? entry?.question_type ?? entry?.QUESTION_TYPE ?? '';
  const tfFlag = /true\/?\s*false|vrai\/?\s*faux|boolean|bool/i.test(String(tf));
  let a = normalizeAnswerChoices(entry?.a ?? entry?.A ?? '');
  if (tfFlag) {
    if (a === 'B') return { q, a: 'B' };
    if (a === 'A') return { q, a: 'A' };
    if (String(entry?.a ?? entry?.A ?? '').toLowerCase().includes('false')) return { q, a: 'B' };
    return { q, a: 'A' };
  }
  if (a !== 'S') a = /^[A-E]{1,5}$/.test(a) ? a : '';
  return { q, a };
}

function dedupeSortedPairs(pairs) {
  const byQ = new Map();
  for (const [q, a] of pairs) {
    if (!Number.isFinite(q) || q < 1 || q > 999999) continue;
    const n = normalizeAnswerChoices(a);
    if (!n) continue;
    if (!byQ.has(q)) {
      byQ.set(q, n);
    } else {
      const prev = byQ.get(q);
      if (prev === 'S') byQ.set(q, n);
      else if (n === 'S') byQ.set(q, prev);
      else byQ.set(q, sortUniqueOptionLetters(prev + n));
    }
  }
  return [...byQ.entries()].sort((a, b) => a[0] - b[0]);
}

/** When JSON is broken but fragments contain `"q":` / `"a":` pairs nearby. */
function extractAnswerLetterFromJsonSlice(slice) {
  let am = /"(?:a|A)"\s*:\s*\[([\s\S]*?)\]\s*[,}\]]/.exec(slice);
  if (am) {
    const inner = am[1];
    const picked = [...inner.matchAll(/"([A-Za-z])"/g)].map((x) => x[1].toUpperCase()).join('');
    const n = normalizeAnswerChoices(picked);
    if (n) return n;
  }
  am = /"(?:a|A)"\s*:\s*"([^"]*)"/i.exec(slice);
  if (am) {
    const n = normalizeAnswerChoices(am[1]);
    if (n) return n;
  }
  am = /"(?:a|A)"\s*:\s*([1-5])\s*[,}\]]/.exec(slice);
  if (am) return normalizeAnswerChoices(am[1]);
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
    const ans = extractAnswerLetterFromJsonSlice(slice);
    if (ans && Number.isFinite(q) && q >= 1 && q <= 999999) {
      out.push([q, ans]);
    }
  }
  return dedupeSortedPairs(out);
}

/** Merge strict parse + loose fragment scan so truncated JSON still yields all `q`/`a` pairs. */
function mergeStrictAndLooseJson(inner) {
  const strict = pairsFromStrictJson(inner);
  const loose = looseJsonPairsFromText(inner);
  const byQ = new Map();
  function addPair(q, a) {
    const n = normalizeAnswerChoices(a);
    if (!n) return;
    if (!byQ.has(q)) {
      byQ.set(q, n);
      return;
    }
    const prev = byQ.get(q);
    if (prev === 'S') byQ.set(q, n);
    else if (n === 'S') byQ.set(q, prev);
    else byQ.set(q, sortUniqueOptionLetters(prev + n));
  }
  for (const [q, a] of strict.deduped) addPair(q, a);
  for (const [q, a] of loose) addPair(q, a);
  const deduped = [...byQ.entries()].sort((a, b) => a[0] - b[0]);
  if (deduped.length === 0) return null;
  return { deduped, parsed: strict.parsed };
}

function pairsFromStrictJson(jsonStr) {
  try {
    const parsed = JSON.parse(jsonStr);
    const answers = qcmAnswersFromParsed(parsed);
    const normalized = answers
      .map((entry) => normalizedAnswerFromEntry(entry))
      .filter(
        (x) =>
          Number.isFinite(x.q) &&
          x.q >= 1 &&
          x.q <= 999999 &&
          (x.a === 'S' || /^[A-E]{1,5}$/.test(x.a))
      );
    const deduped = dedupeSortedPairs(normalized.map(({ q, a }) => [q, a]));
    return { deduped, parsed };
  } catch {
    return { deduped: [], parsed: null };
  }
}

function pairsFromRegexScan(raw) {
  const text = String(raw || '').toUpperCase();
  const pairs = [...text.matchAll(/(?:^|[^0-9])(\d{1,6})\s*[:.)-]?\s*([A-ES]{1,5})(?:[^A-Z]|$)/g)];
  const acc = [];
  for (const m of pairs) {
    const q = Number(m[1]);
    if (!Number.isFinite(q)) continue;
    acc.push([q, normalizeAnswerChoices(m[2])]);
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
    const letter = normalizeAnswerChoices(digit);
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

function formatBatches(deduped, parsedForStem) {
  if (deduped.length < MIN_QCM_PAIRS_ACCEPT) return [];
  const out = [];
  for (let i = 0; i < deduped.length; i += QCM_GROUP_SIZE) {
    const group = deduped.slice(i, i + QCM_GROUP_SIZE);
    const firstQ = group[0][0];
    const snippet = parsedForStem != null ? firstQuestionStemSnippet(parsedForStem, firstQ) : '??????????...';
    const head = `${firstQ}) ${snippet}`;
    const compact = group.map(([q, a]) => `${q}${a}`).join('-');
    out.push(`${head}\n${compact}`);
  }
  return out;
}

function expandNumericGaps(deduped) {
  if (!Array.isArray(deduped) || deduped.length === 0) return [];
  const firstQ = deduped[0][0];
  const lastQ = deduped[deduped.length - 1][0];
  if (!Number.isFinite(firstQ) || !Number.isFinite(lastQ) || lastQ < firstQ) return deduped;
  const span = lastQ - firstQ + 1;
  if (span > QCM_MAX_AUTOFILL_SPAN) return deduped;
  const byQ = new Map(deduped.map(([q, a]) => [q, a]));
  const out = [];
  for (let q = firstQ; q <= lastQ; q += 1) {
    out.push([q, byQ.get(q) || 'S']);
  }
  return out;
}

/** When JSON declares total_questions, extend consecutively from the lowest **q** so batches are not short (e.g. 11–15). */
function expandByDeclaredTotal(deduped, parsed) {
  if (!Array.isArray(deduped) || deduped.length === 0) return deduped;
  const total = Number(parsed?.total_questions ?? parsed?.TOTAL_QUESTIONS);
  if (!Number.isFinite(total) || total < deduped.length) return deduped;
  if (total - deduped.length > 80) return deduped;
  const firstQ = deduped[0][0];
  const lastNeeded = firstQ + total - 1;
  if (lastNeeded - firstQ + 1 > QCM_MAX_AUTOFILL_SPAN) return deduped;
  const byQ = new Map(deduped);
  const out = [];
  for (let q = firstQ; q <= lastNeeded; q += 1) {
    out.push([q, byQ.get(q) || 'S']);
  }
  return out;
}

/**
 * Build QCM SMS body (without photo `slot)__` prefix): line1 = `q)` + first 11 stem chars + ` ...`, line2 = compact key.
 * Requires at least MIN_QCM_PAIRS_ACCEPT distinct question(s) (partial sheet OK).
 * Tries strict JSON, loose JSON fragments, then regex on full text; picks the longest valid parse ≥ minimum.
 */
function bestQcmCandidate(rawText) {
  const raw = String(rawText || '');
  const jsonMatch = raw.match(/\{[\s\S]*\}/);

  const candidates = [];

  if (jsonMatch) {
    const inner = stripCommonJsonWrappers(jsonMatch[0]);
    const merged = mergeStrictAndLooseJson(inner);
    if (merged) {
      candidates.push({
        n: merged.deduped.length,
        deduped: merged.deduped,
        parsed: merged.parsed,
      });
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
  if (!viable.length) return null;

  viable.sort((a, b) => {
    if (b.n !== a.n) return b.n - a.n;
    const bp = b.parsed != null ? 1 : 0;
    const ap = a.parsed != null ? 1 : 0;
    return bp - ap;
  });
  return viable[0];
}

function finalizeDedupedForSms(deduped, parsed) {
  let x = expandByDeclaredTotal(deduped, parsed);
  x = expandNumericGaps(x);
  return x;
}

export function toQcmSmsFormat(rawText) {
  const best = bestQcmCandidate(rawText);
  if (!best) return '';
  const expanded = finalizeDedupedForSms(best.deduped, best.parsed);
  const batches = formatBatches(expanded, best.parsed);
  return batches[0] || '';
}

export function toQcmSmsBatches(rawText) {
  const best = bestQcmCandidate(rawText);
  if (!best) return [];
  const expanded = finalizeDedupedForSms(best.deduped, best.parsed);
  return formatBatches(expanded, best.parsed);
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
