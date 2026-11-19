import type { WorktreeDiscardDescription } from './worktree-discard';

/**
 * Wire contract for discarding what keeps a project's deletion from finishing
 * (CAN-5337, CAN-4995 E). The desktop lists every worktree whose ordinary
 * removal can't finish, each with its own worktree discard description
 * (CAN-5334), and the interrupted deletion a confirmed deletion supersedes.
 * Clients discard each item through `worktree.discard` with its own token,
 * then run the ordinary deletion again. Nothing here discards anything.
 */

export interface ProjectDeletionDiscardItem {
  /**
   * The row's name, or a retained archive's (CAN-5338); absent for an
   * interrupted discard whose row is gone.
   */
  worktreeName?: string;
  description: WorktreeDiscardDescription;
}

/** An interrupted deletion of this project whose index removal never ran. */
export interface ProjectDeletionInterruptedDeletion {
  /** Sent back as the deletion's `supersedeInterruptedDeletion`. */
  operationId: string;
}

export interface ProjectDeletionPendingRecovery {
  operationId: string;
  confirmation: string;
}

export interface ProjectDeletionDiscardDescription {
  /**
   * A separately confirmed resolution fence. Deletion rechecks the entire
   * project after adoption and may expose another refusal without discarding
   * retained material before canonical removal.
   */
  pendingRecovery?: ProjectDeletionPendingRecovery[];
  version: 1;
  workspaceId: string;
  /**
   * `discardable` only when these items are all that keep the deletion from
   * finishing. `refused` lists nothing: the deletion's own refusal stands.
   */
  status: 'discardable' | 'refused';
  /** Each a `discardable` worktree description, in list order. */
  items: ProjectDeletionDiscardItem[];
  interruptedDeletion?: ProjectDeletionInterruptedDeletion;
}

/** Payload for `portal.workspace.delete.discard.describe`; read-only. */
export interface RemoteControlProjectDeletionDiscardDescribePayload {
  workspaceId: string;
  /**
   * CAN-5338: also list retained archives whose recovery keeps the deletion
   * from finishing, each discarded with `retainedArchives`. A host without it
   * ignores the field and refuses as before.
   */
  retainedArchives?: boolean;
}
