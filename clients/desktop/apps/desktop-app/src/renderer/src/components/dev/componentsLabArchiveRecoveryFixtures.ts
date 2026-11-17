import type { WorktreeRecoveryDescription } from '@canopy/protocol/portal/worktree-recovery';
import type {
  RecoveryProject,
  RecoveryHold,
} from '@canopy/ui-app/worktree-discard/presentation';

export const archiveOperationId = '00000000-0000-4000-8000-000000000001';
export const recoveryProjectName =
  'Project with a long name that wraps across several lines while reviewing unfinished archives and retained recovery material';
export const recoveryActions = ['keep-worktree', 'release', 'finish'] as const;
export type RecoveryAction = (typeof recoveryActions)[number];

export function archiveRecovery(
  action: RecoveryAction = 'keep-worktree',
  index = 1,
): WorktreeRecoveryDescription {
  const operationId = archiveOperationId.slice(0, -1) + index;
  const absent = { presence: 'absent', verification: 'unknown' } as const;
  const present = { presence: 'present', verification: 'verified' } as const;
  return {
    version: 1,
    intent: 'archive',
    code: 'external.worktree_recovery_required',
    subject: {
      workspaceId: 'lab-project',
      worktreeId: `lab-worktree-${index}`,
      createdAt: '2026-11-13T12:00:00.000Z',
    },
    diagnosis: {
      operationId,
      revision: 'a'.repeat(64),
      copies: 1,
      slot: action === 'keep-worktree' ? 'same-operation' : 'absent',
      rawState: 'recovery-required',
      verdict: action === 'finish' ? 'finish-tail' : action,
      check: 'lab-fixture',
    },
    evidence: {
      kind: 'journal',
      operation: 'worktree-archive',
      operationId,
      attribution: 'subject',
    },
    stoppingPoint: {
      phase:
        action === 'finish'
          ? 'canonical-row-removal'
          : 'retained-payload-capture',
      state: 'failed',
    },
    check: 'lab-fixture',
    retained: {
      checkout: action === 'keep-worktree' ? present : absent,
      stagedCopy: absent,
      gitSnapshot: present,
      committedArchive: action === 'finish' ? present : absent,
      chats: present,
    },
    actions: {
      retry: { eligible: false, reason: 'not-admitted' },
      finishArchive:
        action === 'finish'
          ? { eligible: true }
          : { eligible: false, reason: 'not-admitted' },
      discard: { eligible: false, reason: 'not-admitted' },
      keepWorktree:
        action === 'keep-worktree'
          ? { eligible: true }
          : { eligible: false, reason: 'not-admitted' },
    },
    destination: { kind: 'recovery' },
  };
}

export const archiveListCases = [
  'one',
  'several',
  'cleanup only',
  'cleanup unavailable',
  'long name',
  'empty',
  'checking',
  'error',
  'retained material',
  'interrupted resolution',
  'interrupted release resolution',
  'busy resolution',
  'delete confirmation',
  'delete confirmation busy',
] as const;
export type ArchiveListCase = (typeof archiveListCases)[number];

export function recoveryHold(
  interrupted = false,
  action: 'keep-worktree' | 'release' = 'keep-worktree',
): RecoveryHold {
  return {
    workspaceId: 'lab-project',
    operationId: archiveOperationId,
    worktreeId: 'lab-worktree-1',
    createdAt: '2026-11-13T12:00:00.000Z',
    action,
    revision: 'a'.repeat(64),
    stage: interrupted ? 'prepared' : 'completed',
    retainedSnapshots: 2,
    retainedPayload: true,
  };
}

export function recoveryProjects(state: ArchiveListCase): RecoveryProject[] {
  if (state === 'empty') return [];
  const hasHold =
    state.includes('resolution') ||
    state === 'retained material' ||
    state.startsWith('delete confirmation');
  return [
    {
      workspaceId: 'lab-project',
      name: state === 'long name' ? recoveryProjectName : 'Project',
      worktrees: [],
      check: state === 'error' ? 'journal-evidence-unreadable' : 'ok',
      entries: hasHold
        ? []
        : state === 'cleanup only' || state === 'cleanup unavailable'
          ? [cleanupRecovery(state === 'cleanup only')]
          : state === 'several'
            ? recoveryActions.map(archiveRecovery)
            : [archiveRecovery()],
      resolutions: hasHold
        ? [
            recoveryHold(
              state.includes('resolution'),
              state === 'interrupted release resolution'
                ? 'release'
                : 'keep-worktree',
            ),
          ]
        : [],
    },
  ];
}

export function cleanupRecovery(eligible = true): WorktreeRecoveryDescription {
  const recovery = archiveRecovery('finish');
  recovery.check = 'completed-turn-diff-cleanup';
  recovery.stoppingPoint = { phase: 'turn-diff-cleanup', state: 'failed' };
  recovery.actions.finishArchive = { eligible: false, reason: 'not-admitted' };
  if (recovery.diagnosis) {
    recovery.diagnosis.rawState = 'completed';
    recovery.diagnosis.verdict = eligible ? 'cleanup-debt' : 'refused';
    recovery.diagnosis.check = eligible
      ? 'completed-turn-diff-cleanup'
      : 'cleanup-repositories-unavailable';
  }
  for (const key of [
    'checkout',
    'stagedCopy',
    'gitSnapshot',
    'committedArchive',
    'chats',
  ] as const) {
    recovery.retained[key] = { presence: 'absent', verification: 'unknown' };
  }
  return recovery;
}
