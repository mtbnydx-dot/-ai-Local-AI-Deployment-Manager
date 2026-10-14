// Fuzzy matching for the CommandPalette (07 §4.4): one query against the
// zh and en labels and the aliases of each command.
//
// A candidate matches when every query character appears in order. Scores
// favour a prefix match, then consecutive runs and word starts, then
// shorter candidates. Matching is case-insensitive; Han text matches by
// characters, so a two-character Chinese query finds its label directly.

const WORD_BREAK = /[\s\-_./:\u00b7]/;

function fold(text) {
  return String(text ?? "").normalize("NFKC").toLowerCase();
}

/** Score of `query` against `text`, or null when it does not match. Higher is better. */
export function fuzzyScore(query, text) {
  const q = fold(query).replace(/\s+/g, "");
  const t = fold(text);
  if (!q) return 0;
  if (!t) return null;
  if (t.startsWith(q)) return 1000 - t.length;
  const at = t.indexOf(q);
  if (at >= 0) return 800 - at - t.length;
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const char of q) {
    const index = t.indexOf(char, from);
    if (index < 0) return null;
    score += index === previous + 1 ? 15 : 1;
    if (index === 0 || WORD_BREAK.test(t[index - 1])) score += 10;
    score -= Math.min(index - from, 10);
    previous = index;
    from = index + 1;
  }
  return score - t.length / 10;
}

/**
 * The items that match, best first. `fields(item)` returns the strings to
 * try (labels in both locales, aliases); the best field counts.
 * @returns Array<{ item, score }>
 */
export function fuzzyFilter(items, query, { fields = (item) => [item], limit = 50 } = {}) {
  const out = [];
  (Array.isArray(items) ? items : []).forEach((item, order) => {
    let best = null;
    for (const field of fields(item) || []) {
      const score = fuzzyScore(query, field);
      if (score !== null && (best === null || score > best)) best = score;
    }
    if (best !== null) out.push({ item, score: best, order });
  });
  out.sort((a, b) => b.score - a.score || a.order - b.order);
  return out.slice(0, limit).map(({ item, score }) => ({ item, score }));
}
