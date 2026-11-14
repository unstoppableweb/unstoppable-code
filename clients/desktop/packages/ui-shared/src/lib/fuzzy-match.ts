/**
 * Fuzzy subsequence matching for search fields: every query character must
 * appear in order. Consecutive runs, segment starts (after `/`, `.`, `-` and
 * `_`), prefixes and exact matches score higher; longer targets score lower.
 * Shared by the desktop file search and both hosts' search palette.
 */

export interface FuzzyMatch {
  score: number;
  indices: number[];
}

function isSegmentStart(target: string, index: number): boolean {
  if (index === 0) return true;
  const prev = target[index - 1];
  return prev === '/' || prev === '.' || prev === '-' || prev === '_';
}

/**
 * The positions of `query` where it appears whole in `target`, preferring an
 * occurrence that starts a segment, or null when it never appears whole.
 */
function contiguousIndices(
  query: string,
  normalizedTarget: string,
  target: string,
): number[] | null {
  let start = normalizedTarget.indexOf(query);
  if (start === -1) return null;
  for (
    let next = start;
    next !== -1 && !isSegmentStart(target, start);
    next = normalizedTarget.indexOf(query, next + 1)
  ) {
    if (isSegmentStart(target, next)) start = next;
  }
  const indices: number[] = [];
  let offset = start;
  for (const char of query) {
    indices.push(offset);
    offset += char.length;
  }
  return indices;
}

export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  const normalizedQuery = query.trim().toLowerCase();
  const normalizedTarget = target.toLowerCase();

  if (!normalizedQuery) {
    return { score: 0, indices: [] };
  }

  // A contiguous run beats the leftmost scattered letters: "dodo" in
  // "dev-dodo" is the word, not the "d" of "dev" plus "odo" (CAN-6405).
  const indices =
    contiguousIndices(normalizedQuery, normalizedTarget, target) ?? [];
  if (indices.length === 0) {
    let searchFrom = 0;
    for (const char of normalizedQuery) {
      const index = normalizedTarget.indexOf(char, searchFrom);
      if (index === -1) return null;
      indices.push(index);
      searchFrom = index + 1;
    }
  }

  let score = 0;
  let consecutiveRun = 0;
  let bestRun = 0;

  for (let i = 0; i < indices.length; i += 1) {
    const index = indices[i];
    const prev = indices[i - 1];
    const consecutive = i > 0 && index === prev + 1;
    consecutiveRun = consecutive ? consecutiveRun + 1 : 1;
    bestRun = Math.max(bestRun, consecutiveRun);

    score += 10;
    if (consecutive) score += 18;
    if (isSegmentStart(target, index)) score += 14;
  }

  if (normalizedTarget === normalizedQuery) {
    score += 1000;
  } else if (normalizedTarget.startsWith(normalizedQuery)) {
    score += 400;
  } else {
    const segmentIndex = normalizedTarget.search(
      new RegExp(
        `(^|[./_-])${normalizedQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
      ),
    );
    if (segmentIndex >= 0) score += 180;
  }

  score += bestRun * 20;
  score -= target.length;

  return { score, indices };
}
