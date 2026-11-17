import { lstat } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { readArchiveRecoveryHolds } from './archive-recovery-refs';
import { cleanupPersistedTurnDiffTreeRefs, getGitCommonDir } from './git';
import {
  getArchivedContainerDir,
  getWorkspaceWorktreeDir,
  getWorktreeDataDir,
} from './paths';
import {
  readArchiveJournalOperations,
  type ArchiveJournalOperation,
} from './stranded-archive-journals';
import {
  exactArchiveJournal,
  isDestructiveRecoveryOwnerless,
  isRecoveryProjectUnreplaced,
  type DestructiveRecoveryRecord,
} from './w5-destructive-recovery';
import {
  readWorkspaceConfigDetailed,
  readWorkspaceWorktreesDetailed,
} from './workspace-persistence';
import { readEffectiveWorkspaceConfig } from './workspace-source';
import {
  assertNotSplitLocked,
  assertNotSplitDestinationWorktreeClaimed,
  hasWorkspaceDeletionLease,
} from '../services/split-lock-service';
import { assertWorktreeCanBeRemoved } from '../agents/background-work';
import { isWritableScope } from './read-only-scope';

const TURN_DIFF_WARNING =
  'Failed to remove persisted turn diff tree refs for this worktree.';

/** Classification only; execution also requires absent occupants and current repositories. */
export function isCompletedTurnDiffCleanup(
  record: DestructiveRecoveryRecord,
): boolean {
  return (
    record.operation === 'worktree-archive' &&
    record.state === 'completed' &&
    record.cleanupRequired === true &&
    record.steps.some(
      (step) => step.phase === 'turn-diff-cleanup' && step.state !== 'done',
    ) &&
    record.steps.every(
      (step) => step.state === 'done' || step.phase === 'turn-diff-cleanup',
    )
  );
}

async function absent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return true;
    throw error;
  }
}

type Repository = { path: string; commonDir: string; identity: string };
type CleanupInspection =
  | { eligible: true; repositories: Repository[] }
  | { eligible: false; check: string };

/** No historical Git authority: this repairs only the app-owned worktree-id namespace. */
export async function inspectCompletedTurnDiffCleanup(
  operation: ArchiveJournalOperation,
): Promise<CleanupInspection> {
  const { record } = operation;
  const { workspaceId, worktreeId } = record;
  const refuse = (check: string): CleanupInspection => ({
    eligible: false,
    check,
  });
  if (
    !isCompletedTurnDiffCleanup(record) ||
    !worktreeId ||
    !operation.consistent ||
    operation.copies !== 1
  )
    return refuse('cleanup-journal-unqualified');
  try {
    if (
      !isWritableScope(workspaceId) ||
      !isDestructiveRecoveryOwnerless(record) ||
      hasWorkspaceDeletionLease(workspaceId) ||
      !(await isRecoveryProjectUnreplaced(record))
    )
      return refuse('cleanup-project-unavailable');
    assertNotSplitLocked(workspaceId, worktreeId, 'finishing archive cleanup');
    assertNotSplitDestinationWorktreeClaimed(
      workspaceId,
      worktreeId,
      'finishing archive cleanup',
    );
    assertWorktreeCanBeRemoved(workspaceId, worktreeId);
    const scan = await readArchiveJournalOperations(workspaceId);
    const current = scan.operations.find(
      (entry) => entry.record.operationId === record.operationId,
    );
    if (
      !scan.readable ||
      current?.revision !== operation.revision ||
      current.copies !== 1 ||
      !current.consistent ||
      scan.operations.some(
        (entry) =>
          entry.record.operationId !== record.operationId &&
          entry.records.some(
            (other) =>
              other.worktreeId === worktreeId ||
              (other.operation === 'workspace-delete' &&
                (other.state !== 'completed' || other.cleanupRequired)),
          ),
      )
    )
      return refuse('cleanup-journal-changed');
    const rows = await readWorkspaceWorktreesDetailed(workspaceId, {
      persistRemovalCleanup: false,
    });
    if (
      rows.authority !== 'ok' ||
      rows.worktrees.some((row) => row.id === worktreeId)
    )
      return refuse('cleanup-worktree-listed');
    if (
      (await readArchiveRecoveryHolds(workspaceId)).some(
        (hold) => hold.worktreeId === worktreeId,
      )
    )
      return refuse('cleanup-recovery-held');
    for (const path of new Set([
      ...record.ownedPaths.map((entry) => entry.path),
      getWorkspaceWorktreeDir(workspaceId, worktreeId),
      getWorktreeDataDir(workspaceId, worktreeId),
      getArchivedContainerDir(workspaceId, worktreeId),
    ])) {
      if (!(await absent(path))) return refuse('cleanup-path-present');
    }
    const config = await readWorkspaceConfigDetailed(workspaceId);
    if (config.authority !== 'ok' || config.config.type === 'cowork')
      return refuse('cleanup-repositories-unavailable');
    let paths: string[];
    if (config.config.type === 'single-repo')
      paths = config.config.repoPath ? [config.config.repoPath] : [];
    else {
      const effective = await readEffectiveWorkspaceConfig(
        workspaceId,
        config.config,
      );
      if (effective.unresolvedManifestRepoIds.length)
        return refuse('cleanup-repositories-unavailable');
      paths = [
        ...(effective.sourceRepoPath ? [effective.sourceRepoPath] : []),
        ...effective.repos.map((repo) => repo.repoPath),
      ];
    }
    if (!paths.length) return refuse('cleanup-repositories-unavailable');
    const repositories: Repository[] = [];
    for (const path of new Set(paths)) {
      const commonDir = await getGitCommonDir(path);
      const stat = await lstat(commonDir);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        return refuse('cleanup-repositories-unavailable');
      repositories.push({
        path,
        commonDir,
        identity: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`,
      });
    }
    return { eligible: true, repositories };
  } catch {
    return refuse('cleanup-evidence-unavailable');
  }
}

/** Caller holds the workspace mutation queue and archive lock. Missing refs are success. */
export async function finishCompletedTurnDiffCleanup(
  operation: ArchiveJournalOperation,
): Promise<void> {
  const inspection = await inspectCompletedTurnDiffCleanup(operation);
  if (!inspection.eligible) throw new Error(inspection.check);
  const { record } = operation;
  const worktreeId = record.worktreeId;
  if (!worktreeId) throw new Error('cleanup-worktree-missing');
  const journal = exactArchiveJournal(record, operation.names);
  const recheck = async (): Promise<void> => {
    const current = await inspectCompletedTurnDiffCleanup(operation);
    if (
      !current.eligible ||
      !isDeepStrictEqual(current.repositories, inspection.repositories)
    )
      throw new Error(
        current.eligible ? 'cleanup-repositories-changed' : current.check,
      );
  };
  for (const repository of inspection.repositories) {
    await recheck();
    await cleanupPersistedTurnDiffTreeRefs(
      repository.path,
      record.workspaceId,
      worktreeId,
    );
  }
  await recheck();
  record.steps = record.steps.map((step) =>
    step.phase === 'turn-diff-cleanup'
      ? { phase: step.phase, state: 'done' }
      : step,
  );
  record.cleanupRequired = false;
  if (
    typeof record.outcome === 'object' &&
    record.outcome !== null &&
    'warnings' in record.outcome &&
    Array.isArray(record.outcome.warnings)
  ) {
    record.outcome = {
      ...record.outcome,
      warnings: record.outcome.warnings.filter(
        (warning: unknown) => warning !== TURN_DIFF_WARNING,
      ),
    };
  }
  await journal.persist(record);
}
