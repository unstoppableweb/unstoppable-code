import type { RepoFileIndex } from '@canopy/desktop-shared/types';
import { fuzzyMatch } from '@canopy/ui-shared/lib/fuzzy-match';

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
