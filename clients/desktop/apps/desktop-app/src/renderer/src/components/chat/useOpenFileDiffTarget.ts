import { useEffect, useState } from 'react';
import type {
  ActivityChangedFilesResponse,
  ChangedFileInfo,
  FileDiffSource,
} from '@canopy/desktop-shared/types';
import { useActivityStore } from '@/stores/activityStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { requestChangedFilesRefresh } from '@/stores/changedFilesRefreshRuntime';

const CHANGED_FILES_RETRY_INITIAL_MS = 1_000;
const CHANGED_FILES_RETRY_MAX_MS = 30_000;

export interface OpenFileDiffTarget {
  file: ChangedFileInfo;
  source: FileDiffSource;
}
/** Normalize Windows separators while preserving literal POSIX backslashes. */
function normalizePath(value: string): string {
  const normalized = isWindowsAbsolutePath(value)
    ? value.replace(/\\/g, '/')
    : value;
  return normalized.replace(/\/+$/, '');
}

/** Windows drive-letter and UNC paths use case-insensitive matching. */
function isWindowsAbsolutePath(value: string): boolean {
  return (
    /^[a-z]:[\\/]/i.test(value) ||
    value.startsWith('\\\\') ||
    value.startsWith('//')
  );
}

function pathsEqual(left: string, right: string): boolean {
  const normalizedLeft = normalizePath(left);
  const normalizedRight = normalizePath(right);
  if (
    isWindowsAbsolutePath(normalizedLeft) &&
    isWindowsAbsolutePath(normalizedRight)
  ) {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }
  return normalizedLeft === normalizedRight;
}

/** Sources are scoped to the selected path and repository, not the whole worktree. */
export function getChangedFileSources(
  changedFiles: ActivityChangedFilesResponse,
  file: Pick<ChangedFileInfo, 'path' | 'repoId'>,
): Array<'uncommitted' | 'committed'> {
  return (['uncommitted', 'committed'] as const).filter((source) =>
    changedFiles[source].some(
      (candidate) =>
        (candidate.repoId ?? 'default') === (file.repoId ?? 'default') &&
        // Git supplies canonical repo-relative paths on every host. A
        // backslash here is a literal POSIX character, never a separator.
        candidate.path === file.path,
    ),
  );
}

/**
 * Finds the changed file (and its diff source) whose absolute path matches the
 * open file's absolute `filePath`. `roots` maps each `repoId` (or `undefined`
 * for single-repo / workspace-root) to that repo's absolute worktree root.
 * Uncommitted matches win over committed ones. Pure so it can be unit-tested
 * without the store or IPC.
 */
export function matchChangedFileForPath(
  changedFiles: ActivityChangedFilesResponse,
  roots: Map<string | undefined, string>,
  filePath: string,
): OpenFileDiffTarget | null {
  const findMatch = (files: ChangedFileInfo[]): ChangedFileInfo | undefined =>
    files.find((file) => {
      const root = roots.get(file.repoId);
      if (!root) {
        return false;
      }
      return pathsEqual(`${normalizePath(root)}/${file.path}`, filePath);
    });

  const uncommittedMatch = findMatch(changedFiles.uncommitted);
  if (uncommittedMatch) {
    return { file: uncommittedMatch, source: 'uncommitted' };
  }
  const committedMatch = findMatch(changedFiles.committed);
  return committedMatch ? { file: committedMatch, source: 'committed' } : null;
}

/**
 * Resolves whether the currently-open file (an absolute `filePath`) appears in
 * the worktree's git changed-files list, and if so returns the matching
 * `ChangedFileInfo` plus which diff source it came from. Returns `null` when the
 * file has no git changes.
 *
 * Changed-file paths are repo-relative (with an optional `repoId` in multi-repo
 * workspaces), so we resolve each present repo's worktree root and rebuild the
 * absolute path before comparing. Uncommitted matches take priority over
 * committed ones. The result drives the "View Diff" button in
 * `EditableFilePanel`.
 */
export function useOpenFileDiffTarget(
  projectId: string,
  worktreeId: string,
  filePath: string,
): OpenFileDiffTarget | null {
  const key = `${projectId}/${worktreeId}`;
  const changedFiles = useActivityStore((state) => state.changedFiles[key]);
  const diffStats = useProjectsStore((state) => state.diffStats[key]);
  const hasUncommittedChanges = useProjectsStore(
    (state) => state.uncommittedChanges[key],
  );
  const hasCommitsAhead = useProjectsStore((state) => state.commitsAhead[key]);

  // The activity/changed-files store is only populated for the currently
  // selected worktree by `WorktreeManager`. Revalidate on mount and whenever
  // the global worktree diff summary changes so popped-out panels do not keep
  // stale entries indefinitely. Keep cached data visible while refreshing,
  // coalesce concurrent panels, and retry transient failures with backoff.
  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = CHANGED_FILES_RETRY_INITIAL_MS;

    const refresh = (): void => {
      void requestChangedFilesRefresh(projectId, worktreeId)
        .then((files) => {
          if (cancelled) {
            return;
          }
          if (files === undefined) {
            retryTimer = setTimeout(refresh, retryDelay);
            retryDelay = Math.min(retryDelay * 2, CHANGED_FILES_RETRY_MAX_MS);
          }
        })
        .catch(() => {
          if (cancelled) {
            return;
          }
          retryTimer = setTimeout(refresh, retryDelay);
          retryDelay = Math.min(retryDelay * 2, CHANGED_FILES_RETRY_MAX_MS);
        });
    };

    refresh();
    return (): void => {
      cancelled = true;
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer);
      }
    };
  }, [
    diffStats?.deletions,
    diffStats?.insertions,
    hasCommitsAhead,
    hasUncommittedChanges,
    key,
    projectId,
    worktreeId,
  ]);

  const [target, setTarget] = useState<OpenFileDiffTarget | null>(null);

  useEffect(() => {
    if (!changedFiles) {
      setTarget(null);
      return;
    }

    let cancelled = false;
    void (async (): Promise<void> => {
      const repoIds = new Set<string | undefined>();
      for (const file of [
        ...changedFiles.uncommitted,
        ...changedFiles.committed,
      ]) {
        repoIds.add(file.repoId);
      }

      const roots = new Map<string | undefined, string>();
      await Promise.all(
        Array.from(repoIds).map(async (repoId) => {
          try {
            const root = await window.api.getWorktreePath({
              projectId,
              worktreeId,
              ...(repoId ? { repoId } : {}),
            });
            roots.set(repoId, root);
          } catch {
            // Skip repos whose root cannot be resolved.
          }
        }),
      );
      if (cancelled) {
        return;
      }

      setTarget(matchChangedFileForPath(changedFiles, roots, filePath));
    })();

    return (): void => {
      cancelled = true;
    };
  }, [changedFiles, filePath, projectId, worktreeId]);

  return target;
}
