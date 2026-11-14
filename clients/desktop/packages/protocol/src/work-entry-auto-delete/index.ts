import type { AutoDeleteAttention } from '../portal/auto-delete-attention';

/**
 * Portable contract for agent-armed work entry auto-delete: an agent arms its
 * own worktree, Cowork work entry or Orchestrator work entry, and the item is
 * removed (Delete or Archive) once it is fully idle. Ids, modes and
 * timestamps only; no host paths. See
 * docs/planning/2026-11-06-work-entry-auto-delete/README.md.
 */

export type WorkEntryAutoDeleteMode = 'delete' | 'archive';
export type WorkEntryAutoDeleteTargetKind = 'worktree' | 'work-entry';
export type WorkEntryAutoDeleteTeardown = 'error' | 'force';
export type WorkEntryAutoDeleteUnmergedBranch = 'ask' | 'error' | 'force';
export type WorkEntryAutoDeleteState = 'armed' | 'awaiting-branch-confirmation';
export type WorkEntryAutoDeleteBranchAnswer =
  | 'delete-branch'
  | 'keep-branch'
  | 'disarm';

export const DEFAULT_WORK_ENTRY_AUTO_DELETE_TEARDOWN: WorkEntryAutoDeleteTeardown =
  'error';
export const DEFAULT_WORK_ENTRY_AUTO_DELETE_UNMERGED_BRANCH: WorkEntryAutoDeleteUnmergedBranch =
  'ask';
/** The item must stay idle this long before removal starts. */
export const WORK_ENTRY_AUTO_DELETE_SETTLE_MS = 15_000;

/** One persisted arm (main-owned `work-entry-auto-delete.json`). */
export interface WorkEntryAutoDeleteArm {
  readonly targetId: string;
  readonly targetKind: WorkEntryAutoDeleteTargetKind;
  readonly mode: WorkEntryAutoDeleteMode;
  readonly teardown: WorkEntryAutoDeleteTeardown;
  readonly unmergedLocalBranchDelete: WorkEntryAutoDeleteUnmergedBranch;
  readonly state: WorkEntryAutoDeleteState;
  readonly armedAt: string;
  /** The initiating root chat, which receives failure reports. */
  readonly armedBy: { readonly chatId: string };
  /** Guards against removing a recreated target that reuses the id. */
  readonly identity: {
    readonly createdAt: string;
    readonly branchName?: string;
  };
  /** Branches reported unmerged while `state` is awaiting confirmation. */
  readonly unmergedBranches?: readonly string[];
  /** Explicit user branch answer; persisted so a restart does not ask again. */
  readonly branchAnswer?: 'delete-branch' | 'keep-branch';
}

/** What a sidebar row needs to render the armed badge. */
export interface WorkEntryAutoDeleteRowState {
  readonly mode: WorkEntryAutoDeleteMode;
  readonly state: WorkEntryAutoDeleteState;
  /** Title of the arming chat at projection time; absent if it is gone. */
  readonly armedByChatTitle?: string;
  /** Human-readable busy reasons, e.g. "1 agent, 1 workflow". */
  readonly waitingFor?: string;
  readonly unmergedBranches?: readonly string[];
  /**
   * Removal has started and the item is about to leave the sidebar; a host
   * showing it navigates away now rather than at completion. Never persisted.
   */
  readonly removing?: true;
}

/** Arm row states for one workspace, keyed by target id. */
export interface WorkEntryAutoDeleteWorkspaceSnapshot {
  readonly workspaceId: string;
  readonly targets: Readonly<Record<string, WorkEntryAutoDeleteRowState>>;
  /** Unresolved background removal incidents, including unarmed worktrees. */
  readonly attention?: readonly AutoDeleteAttention[];
}

export interface WorkEntryAutoDeleteDisarmRequest {
  readonly workspaceId: string;
  readonly targetId: string;
}

export interface WorkEntryAutoDeleteResolveBranchRequest {
  readonly workspaceId: string;
  readonly targetId: string;
  readonly answer: WorkEntryAutoDeleteBranchAnswer;
}

/** Sentence-case label for a busy-reason count list ("1 agent, 2 workflows"). */
export function formatWorkEntryAutoDeleteWaitingFor(
  counts: Readonly<Record<string, number>>,
): string | undefined {
  const parts = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([noun, count]) => `${count} ${count === 1 ? noun : `${noun}s`}`);
  return parts.length > 0 ? parts.join(', ') : undefined;
}
