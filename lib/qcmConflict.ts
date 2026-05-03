/** Parse `1A-2BC-3S` into question → letters or `S` (uppercase, sorted for multi). */
export function parseQcmCompactToMap(compact: string): Map<number, string> | null {
  const t = String(compact || '')
    .trim()
    .replace(/\s+/g, '')
    .toUpperCase();
  if (!t) return null;
  const parts = t.split('-').filter(Boolean);
  if (parts.length === 0) return null;
  const map = new Map<number, string>();
  for (const p of parts) {
    const m = /^(\d{1,6})([A-Z]+)$/i.exec(p);
    if (!m) return null;
    const q = Number(m[1]);
    const tail = m[2].toUpperCase();
    if (!Number.isFinite(q) || q < 1) return null;
    if (tail === 'S') map.set(q, 'S');
    else if (tail.includes('S')) return null;
    else map.set(q, [...new Set(tail.split(''))].sort().join(''));
  }
  return map;
}

function mapsDisagreeOnSharedQuestions(a: Map<number, string>, b: Map<number, string>): boolean {
  for (const [q, letterA] of a) {
    const letterB = b.get(q);
    if (letterB != null && letterB !== letterA) return true;
  }
  return false;
}

/**
 * If `candidate` shares any question number with a prior compact and the letter differs, return that prior (normalized compact).
 */
export function findQcmCompactConflict(
  candidate: string,
  priorCompacts: readonly string[]
): string | null {
  const norm = (s: string) => s.trim().replace(/\s+/g, '').toUpperCase();
  const cNorm = norm(candidate);
  if (!cNorm) return null;
  const mA = parseQcmCompactToMap(cNorm);
  if (!mA || mA.size === 0) return null;
  for (const raw of priorCompacts) {
    const pNorm = norm(raw);
    if (!pNorm || pNorm === cNorm) continue;
    const mB = parseQcmCompactToMap(pNorm);
    if (!mB || mB.size === 0) continue;
    if (mapsDisagreeOnSharedQuestions(mA, mB)) return pNorm;
  }
  return null;
}
