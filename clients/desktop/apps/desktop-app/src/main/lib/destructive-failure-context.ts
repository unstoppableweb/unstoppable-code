import type { DesktopInstrumentationContext } from '@canopy/desktop-instrumentation';
import type { DestructiveRecoveryRecord } from '@canopy/desktop-shared/node/w5-destructive-journal';
import { W5CommitRefusedError } from '@canopy/desktop-shared/node/w5-commit-log/errors';

import { readErrorClassification } from '@canopy/protocol/app-errors/classification';

const safeCodes = new Set([
  'ENAMETOOLONG',
  'EAGAIN',
  'EDQUOT',
  'STORAGE_UNAVAILABLE',
  'WRITER_UNAVAILABLE',
  'UNSUPPORTED_SCHEMA',
  'unavailable',
  'outcome-unknown',
  'malformed',
  'ARCHIVE_IO_FAILED',
  'ARCHIVE_IO_CANCELLED',
  'ARCHIVE_IO_CHILD_STILL_RUNNING',
  'ARCHIVE_IO_GIT_TIMEOUT',
  'ARCHIVE_IO_GIT_RECOVERY_REQUIRED',
  'GIT_CAPTURE_CONFLICTS',
  'GIT_CAPTURE_INTENT_TO_ADD',
  'GIT_CAPTURE_DIRTY_SUBMODULE',
  'GIT_CAPTURE_NESTED_REPOSITORY',
  'GIT_CAPTURE_TRANSFORMING_ATTRIBUTE',
  'GIT_CAPTURE_EXTERNAL_TRANSFORMING_ATTRIBUTE',
  'TEARDOWN_TIMEOUT',
  'TEARDOWN_FAILED',
  'external.disk_full',
  'external.removal_not_permitted',
  'external.offline',
  'ARCHIVE_TURN_DIFF_CLEANUP_FAILED',
  'EBUSY',
  'EPERM',
  'EACCES',
  'ENOENT',
  'ENOSPC',
  'ETIMEDOUT',
  'EIO',
  'EINVAL',
  'ELOOP',
  'ENOTDIR',
  'EISDIR',
  'ENOTEMPTY',
  'EEXIST',
  'EROFS',
  'EMFILE',
  'ENFILE',
  'EXDEV',
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'URIError',
  'EvalError',
  'AggregateError',
  'AbortError',
  'AutoArchiveTeardownFailedError',
  'WorktreeArchiveRefusedError',
  'WorkspaceDeletionRefusedError',
  'W5RevisionConflictError',
  'W5CommitLogHostError',
  'W5RecordOverloadedError',
  'W5FileWriteRefusedError',
  'W5CommitLogError',
  'W5ProcessFileLockTimeoutError',
  'WorktreeRegistryUnreadableError',
  // Live-state teardown (CAN-6899): which owner failed, or why the Linux
  // writer check could not clear the worktree.
  'WORKTREE_WRITERS_ACTIVE',
  'WORKTREE_WRITER_INSPECTION_INCOMPLETE',
  'WORKTREE_PROCESSES_ALIVE',
  'live-state:writer-check',
  'live-state:pipelines',
  'live-state:shell-scripts',
  'live-state:sessions',
  'live-state:claude-terminal',
  'live-state:worker-terminal',
  'identity-conflict',
  'revision-conflict',
  'key-reused',
  'outcome-expired',
  'in-progress',
  'recovery-required',
  'unapplied-change',
  'unknown-reservation',
  'invalid-state',
]);

const safeErrorClasses = new Set(
  [...safeCodes].filter((code) => code.endsWith('Error')),
);

export function sanitizedDestructiveCode(value: unknown): string {
  return typeof value === 'string' && safeCodes.has(value) ? value : 'unknown';
}

/** Read one named property without letting hostile error objects replace a failure. */
export function destructiveErrorProperty(error: unknown, key: string): unknown {
  try {
    return (typeof error === 'object' && error !== null) ||
      typeof error === 'function'
      ? Reflect.get(error, key)
      : undefined;
  } catch {
    return undefined;
  }
}

function explicitFailureCode(error: unknown): string {
  try {
    const reason = destructiveErrorProperty(error, 'reason');
    if (
      error instanceof W5CommitRefusedError &&
      typeof reason === 'string' &&
      [
        'identity-conflict',
        'revision-conflict',
        'key-reused',
        'outcome-expired',
        'in-progress',
        'recovery-required',
        'unapplied-change',
        'unknown-reservation',
        'invalid-state',
      ].includes(reason)
    )
      return reason;
    // Match the host error by name: importing its class would load the W5
    // commit-log host into the archive I/O worker bundle. Every reason
    // returned here is already allowlisted, so a spoofed name exposes nothing.
    if (
      error instanceof Error &&
      destructiveErrorProperty(error, 'name') === 'W5CommitLogHostError' &&
      (reason === 'unavailable' ||
        reason === 'outcome-unknown' ||
        reason === 'malformed')
    )
      return reason;
  } catch {
    // A proxy may refuse prototype inspection; other paths remain readable.
  }
  return sanitizedDestructiveCode(destructiveErrorProperty(error, 'code'));
}

export function destructiveFailureCode(error: unknown): string {
  const pending = [{ error, depth: 0 }];
  const visited = new Map<unknown, number>();
  for (let index = 0; index < pending.length; index++) {
    const candidate = pending[index];
    if (!candidate) continue;
    const previous = visited.get(candidate.error);
    if (previous !== undefined && previous <= candidate.depth) continue;
    visited.set(candidate.error, candidate.depth);
    const code = explicitFailureCode(candidate.error);
    if (code !== 'unknown') return code;
    if (candidate.depth < 4) {
      for (const key of ['cause', 'underlying']) {
        const nested = destructiveErrorProperty(candidate.error, key);
        if (nested !== undefined)
          pending.push({ error: nested, depth: candidate.depth + 1 });
      }
    }
  }
  try {
    const code = sanitizedDestructiveCode(readErrorClassification(error)?.code);
    if (code !== 'unknown') return code;
  } catch {
    // Classification is diagnostic only.
  }
  try {
    if (!(error instanceof Error)) return 'unknown';
    const name = destructiveErrorProperty(error, 'name');
    return typeof name === 'string' && safeErrorClasses.has(name)
      ? name
      : 'Error';
  } catch {
    return 'unknown';
  }
}

const failureRecords = new WeakMap<object, DestructiveRecoveryRecord>();

/** Keep attribution when an unwind withdraws a journal or a parent also fails. */
export function rememberDestructiveFailure(
  error: unknown,
  record: DestructiveRecoveryRecord,
): void {
  if (typeof error === 'object' && error !== null) {
    const previous = failureRecords.get(error);
    if (
      !previous ||
      (previous.operationId === record.operationId &&
        // Withdrawal clears the live steps, not the original failure evidence.
        (record.steps.length > 0 || previous.steps.length === 0))
    )
      failureRecords.set(error, {
        version: record.version,
        operationId: record.operationId,
        operation: record.operation,
        trigger: record.trigger,
        workspaceId: record.workspaceId,
        worktreeId: record.worktreeId,
        createdAt: record.createdAt,
        directoryIdentity: null,
        state: record.state,
        steps: record.steps.map(({ phase, state, code }) => ({
          phase,
          state,
          code,
        })),
        ownedPaths: [],
      });
  }
}

export function destructiveFailureRecord(
  error: unknown,
): DestructiveRecoveryRecord | undefined {
  return typeof error === 'object' && error !== null
    ? failureRecords.get(error)
    : undefined;
}

const safePhases = new Set([
  'archive-recovery-holds',
  'teardown-script',
  'live-state-teardown',
  'retained-payload-capture',
  'git-capture',
  'provider-capture',
  'checkout-quarantine',
  'git-worktree-removal',
  'quarantine-directory-removal',
  'branch-deletion',
  'branch-delete-ref',
  'file-quarantine',
  'retained-git-cleanup',
  'pipeline-cleanup',
  'turn-diff-cleanup',
  'retained-manifest-commit',
  'git-capture-completion',
  'sidecar-cleanup',
  'compatibility-symlinks',
  'canonical-row-removal',
  'browser-retirement',
  'deferred-browser-retirement',
  'watcher-commit',
  'temporary-workspace-cleanup',
  'checkout-removal',
  'directory-removal',
  'git-worktree-unregister',
  'checkout-directory-removal',
  'checkout-native-removal',
  'session-teardown',
  'cowork-deletion',
  'cowork-summaries-removal',
  'workspace-directory-removal',
  'workspace-non-w5-children-removal',
  'managed-repository-removal',
  'canonical-index-removal',
  'archived-git-refs',
  'chat-search-rows',
  'chat-search-repair',
]);

export function sanitizedDestructivePhase(phase: string): string {
  if (safePhases.has(phase)) return phase;
  // These phase families can contain local names, paths or child identifiers.
  if (phase.startsWith('sidecar:')) return 'sidecar';
  if (phase.startsWith('discard:')) return 'discard';
  if (phase.startsWith('child:')) return 'child';
  return 'unknown';
}

export function destructiveJournalDiagnostic(
  record: DestructiveRecoveryRecord | undefined,
): DesktopInstrumentationContext {
  const steps =
    record?.steps.map((step) => ({
      phase: sanitizedDestructivePhase(step.phase),
      state: step.state,
    })) ?? [];
  const index = record?.steps.findIndex((step) => step.state !== 'done') ?? -1;
  const stopping = index >= 0 ? steps[index] : undefined;
  return {
    operation: record?.operation ?? 'unknown',
    operationId: record?.operationId ?? 'unknown',
    journal_stopping_phase:
      stopping?.phase ?? `between:${steps[steps.length - 1]?.phase ?? 'start'}`,
    journal_stopping_state: stopping?.state ?? 'between',
    journal_steps: JSON.stringify(steps),
    journal_step_code: sanitizedDestructiveCode(
      record?.steps[index >= 0 ? index : steps.length - 1]?.code,
    ),
  };
}
