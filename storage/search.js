const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().trim();

// Local text matching only. No synonyms, model calls, SQL wildcard syntax or regex input.
function searchScore(text, query, mode = 'exact') {
  const haystack = normalize(text), needle = normalize(query);
  if (!needle) return 1;
  if (haystack.includes(needle)) return 100;
  if (mode !== 'fuzzy') return 0;
  const compact = value => value.replace(/[\p{P}\p{Z}\s]/gu, '');
  const compactNeedle = compact(needle);
  if (compactNeedle && compact(haystack).includes(compactNeedle)) return 90;
  const terms = [...new Set([...segmenter.segment(needle)].filter(part => part.isWordLike).map(part => part.segment))];
  return terms.length && terms.every(term => haystack.includes(term)) ? 75 : 0;
}

module.exports = { normalize, searchScore };
