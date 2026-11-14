import type { AppErrorCode } from '../app-errors/catalog';

export type WorktreeRecoveryCode = Extract<
  AppErrorCode,
  | 'external.worktree_recovery_required'
  | 'external.worktree_recovery_retryable'
  | 'external.worktree_recovery_cleanup'
  | 'external.worktree_recovery_unreadable'
>;

export interface WorktreeRecoveryRequest {
  intent: 'archive' | 'delete';
  /** Null explicitly means the requesting client cannot attribute an incarnation. */
  expectedCreatedAt: string | null;
  /** Exact operation, including UUID history; never a client-supplied path. */
  operationId?: string;
}

/** The retained-removal choice: unlocked removals are Delete, even with retention. */
export function worktreeRemovalIntent(
  lockAfterArchive: boolean | undefined,
): WorktreeRecoveryRequest['intent'] {
  return lockAfterArchive === true ? 'archive' : 'delete';
}

export interface WorktreeRecoveryAsset {
  presence: 'unknown' | 'absent' | 'present' | 'partial';
  verification: 'unknown' | 'unverified' | 'verified';
  /** Per-repository facts never imply that every repository was saved. */
  repositories?: {
    repoId: string;
    presence: 'unknown' | 'absent' | 'present';
    verification: 'unknown' | 'unverified' | 'verified';
  }[];
}

export type WorktreeRecoveryAction =
  | { eligible: true }
  | {
      eligible: false;
      reason:
        | 'unavailable'
        | 'not-admitted'
        | 'other-incarnation'
        | 'future-capability';
    };

/** Diagnosis is not execution admission. Keep/Release await retention and receipts. */
export interface StrandedArchiveDiagnosis {
  operationId: string;
  revision: string;
  copies: number;
  slot: 'same-operation' | 'other-operation' | 'absent';
  rawState: 'active' | 'recovery-required' | 'completed';
  verdict:
    | 'keep-worktree'
    | 'release'
    | 'finish-tail'
    | 'finish-journal'
    | 'retry'
    | 'cleanup-debt'
    | 'refused';
  check: string;
}

export interface WorktreeRecoveryDescription {
  version: 1;
  diagnosis?: StrandedArchiveDiagnosis;
  code: WorktreeRecoveryCode;
  intent: WorktreeRecoveryRequest['intent'];
  subject: {
    workspaceId: string;
    worktreeId: string;
    createdAt: string | null;
  };
  evidence:
    | { kind: 'unknown' }
    | {
        kind: 'journal';
        operation: 'workspace-delete' | 'worktree-archive' | 'worktree-delete';
        operationId: string;
        attribution: 'subject' | 'other' | 'unknown';
      };
  stoppingPoint: {
    phase: string;
    state: 'pending' | 'failed' | 'between' | 'unknown';
  };
  /** Structured admission check, never the persisted step.error or parsed prose. */
  check: string;
  retained: {
    checkout: WorktreeRecoveryAsset;
    stagedCopy: WorktreeRecoveryAsset;
    gitSnapshot: WorktreeRecoveryAsset;
    committedArchive: WorktreeRecoveryAsset;
    chats: WorktreeRecoveryAsset;
  };
  /** Explanatory only. Execution re-admits under the existing locks. */
  actions: {
    retry: WorktreeRecoveryAction;
    finishArchive: WorktreeRecoveryAction;
    discard: WorktreeRecoveryAction;
    keepWorktree: WorktreeRecoveryAction;
  };
  destination:
    | { kind: 'recovery' }
    | {
        kind: 'journal-review';
        reason: 'unreadable-entry' | 'directory-unreadable';
      };
}

const recoverySteps: Readonly<Record<string, string>> = {
  'teardown-script': 'the cleanup script',
  'live-state-teardown': 'stopping work in the worktree',
  'retained-payload-capture': 'saving a copy of the working files',
  'git-capture': 'saving Git snapshots',
  'provider-capture': 'saving session data',
  'checkout-quarantine': 'moving the working files',
  'file-quarantine': 'moving the working files',
  'git-worktree-removal': 'removing the working files',
  'quarantine-directory-removal': 'removing the temporary working files',
  'branch-deletion': 'removing the branch',
  'retained-git-cleanup': 'cleaning up saved Git data',
  'pipeline-cleanup': 'cleaning up workflows',
  'turn-diff-cleanup': 'cleaning up saved changes',
  'retained-manifest-commit': 'saving the archive',
  'git-capture-completion': 'saving Git snapshots',
  'sidecar-cleanup': 'cleaning up worktree data',
  'canonical-row-removal': 'removing the worktree from the list',
  'checkout-removal': 'removing the working files',
  'checkout-directory-removal': 'removing the working files',
  'checkout-native-removal': 'removing the working files',
  'git-worktree-unregister': 'removing the Git registration',
  'browser-retirement': 'closing the worktree browser',
  'deferred-browser-retirement': 'closing the worktree browser',
  'watcher-commit': 'stopping worktree notifications',
  'temporary-workspace-cleanup': 'cleaning up the temporary project',
  'compatibility-symlinks': 'cleaning up worktree links',
};

export function worktreeRecoveryStoppingPoint(
  steps: readonly { phase: string; state: 'pending' | 'done' | 'failed' }[],
): WorktreeRecoveryDescription['stoppingPoint'] {
  const stopping = steps.find(
    (step) => step.state === 'pending' || step.state === 'failed',
  );
  const last = stopping ?? steps[steps.length - 1];
  const phase = last?.phase.startsWith('sidecar:')
    ? 'sidecar-cleanup'
    : last?.phase;
  return {
    phase:
      phase && Object.prototype.hasOwnProperty.call(recoverySteps, phase)
        ? phase
        : 'unknown',
    state:
      stopping?.state === 'pending' || stopping?.state === 'failed'
        ? stopping.state
        : last
          ? 'between'
          : 'unknown',
  };
}

/** Shared plain stopping-point explanation, including for the narrower CLI. */
export function formatWorktreeRecoveryReason(
  description: Pick<
    WorktreeRecoveryDescription,
    'code' | 'stoppingPoint' | 'intent'
  >,
): string {
  if (description.code === 'external.worktree_recovery_unreadable')
    return "Couldn't check the previous removal.";
  if (description.code === 'external.worktree_recovery_cleanup')
    return "The archive was saved, but cleanup didn't finish.";
  if (description.stoppingPoint.state !== 'between') {
    if (description.stoppingPoint.phase === 'teardown-script')
      return "The cleanup script didn't finish.";
    if (description.stoppingPoint.phase === 'retained-payload-capture')
      return "Saving a copy of the working files didn't finish.";
  }
  return formatAdditionalRecoveryReason(description);
}

function formatAdditionalRecoveryReason(
  description: Pick<WorktreeRecoveryDescription, 'stoppingPoint' | 'intent'>,
): string {
  const step = Object.prototype.hasOwnProperty.call(
    recoverySteps,
    description.stoppingPoint.phase,
  )
    ? recoverySteps[description.stoppingPoint.phase]
    : undefined;
  if (description.stoppingPoint.state === 'between' && step)
    return `The previous removal stopped after ${step}.`;
  switch (description.stoppingPoint.phase) {
    case 'git-capture':
      return "Saving Git snapshots didn't finish.";
    case 'provider-capture':
      return "Saving the worktree's session data didn't finish.";
    case 'checkout-quarantine':
    case 'file-quarantine':
      return "Moving the working files didn't finish.";
    case 'checkout-removal':
    case 'git-worktree-removal':
    case 'git-worktree-unregister':
    case 'checkout-directory-removal':
    case 'checkout-native-removal':
    case 'quarantine-directory-removal':
      return "Removing the working files didn't finish.";
    case 'live-state-teardown':
      return "Stopping work in the worktree didn't finish.";
    default:
      return step
        ? `The previous removal stopped while ${step}.`
        : description.intent === 'archive'
          ? 'The previous removal needs review before this worktree can be archived.'
          : 'The previous removal needs review before this worktree can be deleted.';
  }
}

/** Safe even when all secondary inspection fails. Unknown never means absent. */
export function unavailableWorktreeRecovery(
  subject: WorktreeRecoveryDescription['subject'],
  request: WorktreeRecoveryRequest,
  check = 'unknown',
): WorktreeRecoveryDescription {
  const unknown: WorktreeRecoveryAsset = {
    presence: 'unknown',
    verification: 'unknown',
  };
  return {
    version: 1,
    code: 'external.worktree_recovery_required',
    intent: request.intent,
    subject,
    evidence: { kind: 'unknown' },
    stoppingPoint: { phase: 'unknown', state: 'unknown' },
    check,
    retained: {
      checkout: { ...unknown },
      stagedCopy: { ...unknown },
      gitSnapshot: { ...unknown },
      committedArchive: { ...unknown },
      chats: { ...unknown },
    },
    actions: {
      retry: { eligible: false, reason: 'unavailable' },
      finishArchive: { eligible: false, reason: 'unavailable' },
      discard: { eligible: false, reason: 'unavailable' },
      keepWorktree: { eligible: false, reason: 'future-capability' },
    },
    destination: { kind: 'recovery' },
  };
}
