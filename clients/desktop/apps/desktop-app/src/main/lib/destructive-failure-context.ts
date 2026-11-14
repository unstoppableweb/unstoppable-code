import type { DesktopInstrumentationContext } from '@canopy/desktop-instrumentation';
import type { DestructiveRecoveryRecord } from '@canopy/desktop-shared/node/w5-destructive-journal';
import { W5CommitRefusedError } from '@canopy/desktop-shared/node/w5-commit-log/errors';

const safeCodes = new Set([
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

export function sanitizedDestructiveCode(value: unknown): string {
  return typeof value === 'string' && safeCodes.has(value) ? value : 'unknown';
}

export function destructiveFailureCode(error: unknown): string {
  try {
    if (error instanceof W5CommitRefusedError)
      return sanitizedDestructiveCode(error.reason);
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const code = sanitizedDestructiveCode(error.code);
      if (code !== 'unknown') return code;
    }
    if (!(error instanceof Error)) return 'unknown';
    const errorClass = sanitizedDestructiveCode(error.name);
    return errorClass === 'unknown' ? 'Error' : errorClass;
  } catch {
    // Error properties can be accessors; classification must not replace the failure.
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
