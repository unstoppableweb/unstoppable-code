import type { RepoFileIndex } from '@canopy/desktop-shared/types';

export interface FuzzyMatch {
  score: number;
  indices: number[];
}

export interface FileSearchResult {
  relativePath: string;
  filename: string;
  absolutePath: string;
  repoId: string;
  repoName: string;
  rootKind: RepoFileIndex['rootKind'];
  /**
   * Whether the entry is git-ignored. Carried through so the renderer can
   * dim ignored matches; callers must not filter on this field.
   */
  isIgnored: boolean;
  score: number;
  matchedIndices: number[];
}

function isSegmentStart(target: string, index: number): boolean {
  if (index === 0) return true;
  const prev = target[index - 1];
  return prev === '/' || prev === '.' || prev === '-' || prev === '_';
}

export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  const normalizedQuery = query.trim().toLowerCase();
  const normalizedTarget = target.toLowerCase();

  if (!normalizedQuery) {
    return { score: 0, indices: [] };
  }

  const indices: number[] = [];
  let searchFrom = 0;

  for (const char of normalizedQuery) {
    const index = normalizedTarget.indexOf(char, searchFrom);
    if (index === -1) return null;
    indices.push(index);
    searchFrom = index + 1;
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

export function searchFiles(
  query: string,
  repos: RepoFileIndex[],
  limit = 50,
  ranking: 'fuzzy' | 'path-coverage' = 'fuzzy',
): FileSearchResult[] {
  const trimmed = query.trim();
  const normalizedQuery = trimmed.toLowerCase();
  if (!trimmed) {
    return repos
      .flatMap((repo) =>
        repo.files.map((file) => ({
          relativePath: file.relativePath,
          filename: file.filename,
          absolutePath: file.absolutePath,
          repoId: repo.repoId,
          repoName: repo.repoName,
          rootKind: repo.rootKind,
          isIgnored: file.isIgnored,
          score: -file.relativePath.length,
          matchedIndices: [],
        })),
      )
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
      .slice(0, limit);
  }

  const results: FileSearchResult[] = [];

  for (const repo of repos) {
    for (const file of repo.files) {
      const filenameMatch = fuzzyMatch(trimmed, file.filename);
      const pathMatch = fuzzyMatch(trimmed, file.relativePath);

      if (!filenameMatch && !pathMatch) continue;

      const filenameOffset = Math.max(
        0,
        file.relativePath.length - file.filename.length,
      );
      const best =
        (filenameMatch?.score ?? Number.NEGATIVE_INFINITY) + 250 >=
        (pathMatch?.score ?? Number.NEGATIVE_INFINITY)
          ? {
              score: (filenameMatch?.score ?? 0) + 250,
              indices:
                filenameMatch?.indices.map((index) => index + filenameOffset) ??
                [],
            }
          : {
              score: pathMatch?.score ?? 0,
              indices: pathMatch?.indices ?? [],
            };
      const hasDirectPathMatch = file.relativePath
        .toLowerCase()
        .includes(normalizedQuery);

      results.push({
        relativePath: file.relativePath,
        filename: file.filename,
        absolutePath: file.absolutePath,
        repoId: repo.repoId,
        repoName: repo.repoName,
        rootKind: repo.rootKind,
        isIgnored: file.isIgnored,
        // Quick-open prioritizes direct path matches, then their relative-path
        // coverage. Non-substring queries retain fuzzy match quality so
        // acronym searches do not collapse to shortest-path ordering. Other
        // search surfaces retain their existing fuzzy ranking.
        score:
          ranking === 'path-coverage'
            ? hasDirectPathMatch
              ? 1_000_000 + trimmed.length / file.relativePath.length
              : best.score
            : best.score,
        matchedIndices: best.indices,
      });
    }
  }

  return results
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.filename !== b.filename)
        return a.filename.localeCompare(b.filename);
      return a.relativePath.localeCompare(b.relativePath);
    })
    .slice(0, limit);
}
