import { randomUUID } from 'node:crypto';
import {
  getGitRequestContext,
  runWithGitRequestContext,
} from '@canopy/desktop-shared/node/git-request-context';
import type {
  ChangedFileInfo,
  TurnDiffData,
  TurnDiffTreeRef,
} from '@canopy/desktop-shared/types';
import { resolveWorktreeCwd } from './resolve-worktree';
import { isMultiRepoWorkspace } from './workspace-registry';
import { listWorkspaceWorktreeRepoEntries } from './worktree-repo-entries';
import {
  captureHeadCommitSha,
  captureWorkingTreeSha,
  diffTreeObjects,
  setGitTreeSnapshotRuntime,
} from './git-tree-snapshot';
import { persistTurnRefThroughWorker } from '../canopy-runtime/worker-git-local-mutations-dispatch';
import { getResolvedGitExecutableForSpawn } from './git-executable';
import { mapWithConcurrency } from './concurrency';

/**
 * Repos captured at once per turn start or end. Local to this module: a
 * process-wide Git limit belongs in the daemon once CAN-6803 lands.
 */
const REPO_CAPTURE_CONCURRENCY = 4;

/**
 * Maps repos in input order with the capture limit. After a repo fails, no
 * other repo starts, and the failure surfaces only once in-flight repos
 * settle, so a failed capture's Git never overlaps the session's next one.
 */
async function mapReposBounded<T, R>(
  repos: readonly T[],
  mapper: (repo: T) => Promise<R>,
): Promise<R[]> {
  const state: { failure?: { reason: unknown } } = {};
  const outcomes = await mapWithConcurrency(
    repos,
    REPO_CAPTURE_CONCURRENCY,
    async (repo): Promise<{ value: R } | undefined> => {
      if (state.failure) {
        return undefined;
      }
      try {
        return { value: await mapper(repo) };
      } catch (reason: unknown) {
        state.failure ??= { reason };
        return undefined;
      }
    },
  );
  if (state.failure) {
    throw state.failure.reason;
  }
  return outcomes.map((outcome): R => {
    if (!outcome) {
      throw new Error('repo capture skipped without a failure');
    }
    return outcome.value;
  });
}

setGitTreeSnapshotRuntime({
  resolveExecutable: () => getResolvedGitExecutableForSpawn(process.env),
  environment: () => process.env,
});

/** Tags a capture's Git launches for diagnostic attribution (CAN-4397). */
function withTurnDiffGitRequest<T>(callback: () => Promise<T>): Promise<T> {
  return runWithGitRequestContext(
    {
      source: 'turn-diff-capture',
      requestId: getGitRequestContext()?.requestId ?? randomUUID(),
    },
    callback,
  );
}

interface RepoTreeSnapshot {
  repoPath: string;
  treeSha: string;
  repoId?: string;
  repoName?: string;
  headCommitSha?: string;
}

interface TurnStartSnapshot {
  projectId: string;
  worktreeId: string;
  repos: RepoTreeSnapshot[];
}

const turnStartSnapshots = new Map<string, TurnStartSnapshot>();

function summarizeTurnDiff(
  files: ChangedFileInfo[],
  treeRefs: TurnDiffTreeRef[],
): TurnDiffData {
  let totalInsertions = 0;
  let totalDeletions = 0;

  for (const file of files) {
    totalInsertions += file.insertions;
    totalDeletions += file.deletions;
  }

  return {
    files,
    totalInsertions,
    totalDeletions,
    capturedAt: Date.now(),
    treeRefs,
  };
}

function sortChangedFiles(files: ChangedFileInfo[]): ChangedFileInfo[] {
  return [...files].sort((left, right) => {
    const repoComparison = (left.repoName ?? '').localeCompare(
      right.repoName ?? '',
    );
    if (repoComparison !== 0) {
      return repoComparison;
    }
    return left.path.localeCompare(right.path);
  });
}

async function captureRepoTree(
  repoPath: string,
  projectId: string,
  worktreeId: string,
): Promise<string> {
  const treeSha = await captureWorkingTreeSha(repoPath);
  await persistTurnRefThroughWorker(repoPath, projectId, worktreeId, treeSha);
  return treeSha;
}

async function captureRepoSnapshot(
  repoPath: string,
  projectId: string,
  worktreeId: string,
): Promise<{ treeSha: string; headCommitSha?: string }> {
  const [treeSha, headCommitSha] = await Promise.all([
    captureRepoTree(repoPath, projectId, worktreeId),
    captureHeadCommitSha(repoPath),
  ]);
  return {
    treeSha,
    ...(headCommitSha ? { headCommitSha } : {}),
  };
}

export function captureTurnStart(
  sessionKey: string,
  projectId: string,
  worktreeId: string,
): Promise<void> {
  return withTurnDiffGitRequest(() =>
    captureTurnStartInContext(sessionKey, projectId, worktreeId),
  );
}

async function captureTurnStartInContext(
  sessionKey: string,
  projectId: string,
  worktreeId: string,
): Promise<void> {
  turnStartSnapshots.delete(sessionKey);

  try {
    const worktreePath = resolveWorktreeCwd(projectId, worktreeId);
    if (!isMultiRepoWorkspace(projectId)) {
      const snapshot = await captureRepoSnapshot(
        worktreePath,
        projectId,
        worktreeId,
      );
      turnStartSnapshots.set(sessionKey, {
        projectId,
        worktreeId,
        repos: [{ repoPath: worktreePath, ...snapshot }],
      });
      return;
    }

    const repoEntries = await listWorkspaceWorktreeRepoEntries(
      projectId,
      worktreePath,
    );
    const repos = await mapReposBounded(
      repoEntries,
      async (entry): Promise<RepoTreeSnapshot> => {
        const snapshot = await captureRepoSnapshot(
          entry.repoPath,
          projectId,
          worktreeId,
        );
        return {
          repoPath: entry.repoPath,
          repoId: entry.repoId,
          repoName: entry.repoName,
          ...snapshot,
        };
      },
    );

    turnStartSnapshots.set(sessionKey, {
      projectId,
      worktreeId,
      repos,
    });
  } catch (error: unknown) {
    turnStartSnapshots.delete(sessionKey);
    // eslint-disable-next-line no-console
    console.error(
      '[turn-diff-capture] failed to capture turn start snapshot:',
      error,
    );
  }
}

/** Drop the baseline of a dispatch that parked: its turn never started. */
export function discardTurnStart(sessionKey: string): void {
  turnStartSnapshots.delete(sessionKey);
}

const endCaptureTails = new Map<string, Promise<TurnEndDiffs | null>>();
/** Each repo's tree at the last end capture since that turn start. */
const lastEndTrees = new WeakMap<TurnStartSnapshot, Map<string, string>>();

/** The turn an end capture belongs to, as its caller attributes the diff. */
export interface EndedTurn {
  userMessageId: string;
  /** A wake's own turn, whose diff files under it (turn-state phase 40f). */
  wakeTurnId?: string;
}

interface TurnEndDiffs {
  /** From the turn's start: the prompt's diff, including its wakes. */
  turn: TurnDiffData;
  /** From the previous end: a wake's own edits (turn-state phase 40f). */
  sinceLastEnd?: TurnDiffData;
}

/**
 * The start snapshot outlives the turn's end: a wake's own end diffs from its
 * prompt's start, so the prompt's diff and "Reset to this point" cover the
 * wake's edits. A later end also diffs from the previous end, which is the
 * wake's own diff. The next turn's start replaces both, but an end capture
 * keeps the baseline of the turn that ended even if it runs after that. A
 * session's end captures run one at a time, so a later, larger diff is never
 * overwritten by an earlier one that finishes after it.
 */
export function captureTurnEndAndDiffs(
  sessionKey: string,
  endedTurn?: EndedTurn,
): Promise<TurnEndDiffs | null> {
  const startSnapshot = turnStartSnapshots.get(sessionKey);
  const previous = endCaptureTails.get(sessionKey) ?? Promise.resolve(null);
  const capture = previous.then(() =>
    startSnapshot
      ? withTurnDiffGitRequest(() =>
          diffAgainstTurnStart(startSnapshot, endedTurn),
        )
      : null,
  );
  endCaptureTails.set(sessionKey, capture);
  void capture.then(() => {
    if (endCaptureTails.get(sessionKey) === capture)
      endCaptureTails.delete(sessionKey);
  });
  return capture;
}

export async function captureTurnEndAndDiff(
  sessionKey: string,
  endedTurn?: EndedTurn,
): Promise<TurnDiffData | null> {
  return (await captureTurnEndAndDiffs(sessionKey, endedTurn))?.turn ?? null;
}

async function diffAgainstTurnStart(
  startSnapshot: TurnStartSnapshot,
  endedTurn: EndedTurn | undefined,
): Promise<TurnEndDiffs | null> {
  const previousEnds = lastEndTrees.get(startSnapshot);
  try {
    const results = await mapReposBounded(
      startSnapshot.repos,
      async (
        repo,
      ): Promise<{
        files: ChangedFileInfo[];
        treeRef: TurnDiffTreeRef;
        since?: { files: ChangedFileInfo[]; treeRef: TurnDiffTreeRef };
      }> => {
        const endTree = await captureRepoTree(
          repo.repoPath,
          startSnapshot.projectId,
          startSnapshot.worktreeId,
        );
        const label = (file: ChangedFileInfo): ChangedFileInfo => ({
          ...file,
          ...(repo.repoId ? { repoId: repo.repoId } : {}),
          ...(repo.repoName ? { repoName: repo.repoName } : {}),
        });
        const treeRef: TurnDiffTreeRef = {
          startTree: repo.treeSha,
          endTree,
          ...(repo.repoId ? { repoId: repo.repoId } : {}),
          ...(repo.headCommitSha
            ? { startHeadCommitSha: repo.headCommitSha }
            : {}),
        };
        const files = await diffTreeObjects(
          repo.repoPath,
          repo.treeSha,
          endTree,
        );
        const previousEnd = previousEnds?.get(repo.repoPath);
        const since =
          previousEnd === undefined
            ? undefined
            : {
                files: (
                  await diffTreeObjects(repo.repoPath, previousEnd, endTree)
                ).map(label),
                treeRef: {
                  startTree: previousEnd,
                  endTree,
                  ...(repo.repoId ? { repoId: repo.repoId } : {}),
                },
              };
        return {
          files: files.map(label),
          treeRef,
          ...(since === undefined ? {} : { since }),
        };
      },
    );

    lastEndTrees.set(
      startSnapshot,
      new Map(
        startSnapshot.repos.map((repo, index): [string, string] => [
          repo.repoPath,
          results[index]?.treeRef.endTree ?? repo.treeSha,
        ]),
      ),
    );
    const treeRefs = results.map((r) => r.treeRef);
    const files = sortChangedFiles(results.flatMap((r) => r.files));
    const since = results.flatMap((r) => (r.since ? [r.since] : []));
    return {
      turn: summarizeTurnDiff(files, treeRefs),
      ...(since.length === 0
        ? {}
        : {
            sinceLastEnd: summarizeTurnDiff(
              sortChangedFiles(since.flatMap((r) => r.files)),
              since.map((r) => r.treeRef),
            ),
          }),
    };
  } catch (error: unknown) {
    // eslint-disable-next-line no-console
    console.error(
      '[turn-diff-capture] failed to capture turn end diff:',
      endedTurn ?? 'unattributed turn',
      error,
    );
    return null;
  }
}
