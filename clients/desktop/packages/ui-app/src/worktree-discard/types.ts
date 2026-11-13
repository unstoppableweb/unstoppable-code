/** A finished discard, for the host's own list and panel cleanup. */
export interface WorktreeDiscarded {
  readonly workspaceId: string;
  readonly worktreeId: string;
  readonly warnings: readonly string[];
  /**
   * CAN-5338: a retained archive was discarded. The host refreshes its
   * archived items instead of dropping a worktree row.
   */
  readonly retainedArchive?: true;
  /** The temporary project the discard left empty; the host drops it as archive does. */
  readonly removedTemporaryWorkspaceId?: string;
}
