/** Newline before the quoted chosen-option text (SMS body layout). Legacy: three spaces still parsed. */
export const QCM_TAIL_GAP = '\n';

export function qcmAnswersFromParsed(parsed) {
  const raw =
    parsed?.answers ??
    parsed?.ANSWERS ??
    (Array.isArray(parsed) ? parsed : null);
  return Array.isArray(raw) ? raw : [];
}

function normalizeChoiceLetter(raw) {
  const s = String(raw ?? '')
    .toUpperCase()
    .replace(/[^ABCDE]/g, '')
    .trim();
  return s.slice(0, 1);
}

function pickChoiceTextFromObject(ch) {
  if (!ch || typeof ch !== 'object') return '';
  const keys = ['text', 'body', 'value', 'content', 'optionText', 't', 'choice', 'wording', 'labelText'];
  for (const k of keys) {
    if (typeof ch[k] === 'string' && ch[k].trim()) {
      return ch[k].trim().replace(/\s+/g, ' ');
    }
  }
  return '';
}

function choiceTextForAnswerEntry(entry, letterUpper) {
  if (!entry || !letterUpper) return '';
  const choices = entry?.choices ?? entry?.CHOICES;
  if (Array.isArray(choices)) {
    for (const ch of choices) {
      const lab = normalizeChoiceLetter(ch?.label ?? ch?.Letter ?? ch?.letter ?? ch?.id ?? ch?.key);
      if (lab !== letterUpper) continue;
      const raw = pickChoiceTextFromObject(ch);
      if (raw) return raw.slice(0, 280);
    }
  }
  if (choices && typeof choices === 'object' && !Array.isArray(choices)) {
    const v =
      choices[letterUpper] ??
      choices[letterUpper.toLowerCase()] ??
      choices[String(letterUpper)];
    if (typeof v === 'string' && v.trim()) {
      return v.trim().replace(/\s+/g, ' ').slice(0, 280);
    }
  }
  return '';
}

function firstAnswerTailFromParsed(parsed, firstQ, firstLetter) {
  if (!parsed || typeof parsed !== 'object') return '';
  const explicit =
    (typeof parsed.first_answer_tail === 'string' && parsed.first_answer_tail.trim() && parsed.first_answer_tail) ||
    (typeof parsed.firstAnswerTail === 'string' && parsed.firstAnswerTail.trim() && parsed.firstAnswerTail) ||
    '';
  if (explicit) return explicit.trim().replace(/\s+/g, ' ').slice(0, 280);
  const answers = qcmAnswersFromParsed(parsed);
  const entry = answers.find((e) => Number(e?.q ?? e?.Q) === firstQ);
  if (!entry) return '';
  const letter = normalizeChoiceLetter(entry?.a ?? entry?.A) || normalizeChoiceLetter(firstLetter);
  if (!letter) return '';
  const fromChoices = choiceTextForAnswerEntry(entry, letter);
  if (fromChoices) return fromChoices;
  return `Answer ${letter}`;
}

/** First word of the tail, at most 5 characters (SMS size); `Answer B` → `B`. */
function shortenForQcmSmsTail(plainText) {
  const t = String(plainText || '').trim().replace(/\s+/g, ' ');
  if (!t) return '';
  const ans = /^answer\s+([ABCDES])$/i.exec(t);
  if (ans) return ans[1];
  const first = t.split(/\s+/).find(Boolean) || t;
  return first.slice(0, 5);
}

function smsChoiceTailQuoted(plainText) {
  const snippet = shortenForQcmSmsTail(plainText);
  if (!snippet) return '';
  const inner = snippet.replace(/"/g, "'");
  return `${QCM_TAIL_GAP}"${inner}"`;
}

/** Compact-only prefix (strip optional newline or legacy spaces before `"…"` tail). */
export function qcmLeadingCompact(body) {
  const t = String(body ?? '').trim();
  let idx = t.search(/\r?\n\s*"/);
  if (idx < 0) idx = t.search(/\s{3,}"/);
  const head = idx >= 0 ? t.slice(0, idx) : t;
  return head.replace(/\s+/g, '');
}

export function hasQuotedAnswerTail(s) {
  const t = String(s ?? '').trim();
  return /\r?\n\s*"[^"]*"\s*$/i.test(t) || /\s{3,}"[^"]*"\s*$/i.test(t);
}

/**
 * Build QCM SMS body from model output (JSON or regex fallback).
 * Used by Vercel analyze and by the app when merging a missing tail from `text`.
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
        let tailQ = deduped[0][0];
        let tailLetter = deduped[0][1];
        let foundNonSkip = false;
        for (const [q, a] of deduped) {
          if (String(a).toUpperCase() !== 'S') {
            tailQ = q;
            tailLetter = a;
            foundNonSkip = true;
            break;
          }
        }
        const choiceLine = foundNonSkip ? firstAnswerTailFromParsed(parsed, tailQ, tailLetter) : '';
        const line = (choiceLine || '').trim() || '—';
        return `${compact}${smsChoiceTailQuoted(line)}`;
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
 * When `smsBody` has no trailing newline + `"…"` (or legacy spaces + quote), rebuild from JSON inside `modelText` (app fallback).
 */
export function mergeQcmSmsBodyWithTailFromModel(smsBody, modelText) {
  const s = String(smsBody ?? '').trim();
  if (hasQuotedAnswerTail(s)) return s;
  const fromModel = toQcmSmsFormat(String(modelText ?? ''));
  if (fromModel && hasQuotedAnswerTail(fromModel)) {
    if (!s) return fromModel;
    if (qcmLeadingCompact(s) === qcmLeadingCompact(fromModel)) return fromModel;
  }
  const fromSms = toQcmSmsFormat(s);
  if (hasQuotedAnswerTail(fromSms)) return fromSms;
  return fromModel || fromSms || s;
}
