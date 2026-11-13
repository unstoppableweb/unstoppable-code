/**
 * Wire contract for the user-only worktree discard (CAN-5334): a permanent
 * removal of one listed worktree whose ordinary removal cannot finish. The
 * desktop computes the description; clients render it and send back its
 * `confirmation` token. They never parse refusal prose.
 *
 * Paths are a display-only host projection, so the user can see what is
 * removed. They are never accepted back: a discard request carries only the
 * ids and the token, and the desktop re-derives every path and binds to the
 * stat identities the token covers. A recorded exception to the portable-DTO
 * host-path rule (CAN-5334 inventory) until `core.worktree.discard` moves to
 * the dispatcher.
 */

/** Why this worktree's ordinary removal cannot finish. */
export type WorktreeDiscardCause =
  /** An unfinished removal journal of this incarnation that no retry resumes. */
  | 'stranded-removal-journal'
  /** A checkout moved to its Git quarantine that was never verified. */
  | 'pending-checkout-quarantine'
  /** Git works, the configuration reads cleanly, and a source is missing or not a repository. */
  | 'source-gone'
  /** An earlier discard of this worktree was interrupted. */
  | 'interrupted-discard'
  /**
   * CAN-5338: a retained archive's saved copy fails verification while the
   * checkout it would remove is unchanged. Edits made after the archive may
   * be lost.
   */
  | 'archive-recovery-unverified';

export type WorktreeDiscardRefusal =
  | 'not-found'
  | 'read-only-scope'
  | 'forbidden'
  | 'list-unreadable'
  | 'configuration-unreadable'
  | 'unsupported-workspace'
  | 'project-deletion-pending'
  | 'other-incarnation'
  | 'no-broken-removal'
  | 'retry-available'
  | 'source-unverified'
  | 'evidence-mismatch'
  | 'evidence-unreadable'
  | 'unverifiable-target'
  | 'retained-archive'
  | 'busy';

/** The existing non-lossy retry that finishes the removal instead. */
export type WorktreeDiscardRetry =
  | 'remove-worktree'
  | 'delete-project'
  | 'finish-archive-cleanup';

export type WorktreeDiscardSourceState =
  | 'gone-absent'
  | 'gone-not-a-repository'
  | 'available'
  | 'unverified';

export interface WorktreeDiscardSource {
  repoId: string;
  /**
   * Display-only: the configured source repository path. Never an input.
   * Host-path exception to AGENTS.md's "portable DTOs free of host paths",
   * since CAN-5334 shows host-derived paths before confirming. Recorded in
   * the CAN-5334 behavior inventory; reopens when archive/delete move onto
   * the desktop dispatcher.
   */
  path: string;
  state: WorktreeDiscardSourceState;
}

export type WorktreeDiscardTargetKind =
  | 'live-checkout'
  | 'git-quarantine'
  | 'files-only-recovery'
  | 'recreated-checkout-path'
  /**
   * CAN-5338: a retained (archived or deleted) worktree's own directory, with
   * its chats, plans and saved copy. Described only with `retainedArchives`.
   */
  | 'retained-archive';

export interface WorktreeDiscardTargetRepository {
  repoId: string;
  /** Relative to the target, `.` for its root. */
  relativePath: string;
  /** Best effort, for an available source's checkout only. */
  uncommittedChanges?: boolean | 'unknown';
}

export interface WorktreeDiscardTarget {
  kind: WorktreeDiscardTargetKind;
  /**
   * Display-only host-derived path, never one a journal supplied. Never an
   * input. Host-path exception to AGENTS.md's "portable DTOs free of host
   * paths", since CAN-5334 requires each target's host-derived path in the
   * description. Recorded in the CAN-5334 behavior inventory; reopens when
   * archive/delete move onto the desktop dispatcher.
   */
  path: string;
  /** Opaque physical identity the discard binds to. */
  identity: string;
  /** Required only for `recreated-checkout-path`. */
  identityVerified: boolean;
  /** The cause this target blocks the ordinary removal under; one of `causes`. */
  reason: WorktreeDiscardCause;
  /** Repositories checked out inside a checkout or quarantine. */
  repositories?: WorktreeDiscardTargetRepository[];
}

export type WorktreeDiscardDeletedData =
  | 'chats'
  | 'plans'
  | 'attachments'
  | 'cost-history'
  | 'retained-payload-copy';

export interface WorktreeDiscardDescription {
  version: 1;
  workspaceId: string;
  worktreeId: string;
  /** The incarnation; empty when no row is listed. */
  createdAt: string;
  status: 'discardable' | 'refused';
  causes: WorktreeDiscardCause[];
  refusal?: { reason: WorktreeDiscardRefusal; retry?: WorktreeDiscardRetry };
  sources: WorktreeDiscardSource[];
  targets: WorktreeDiscardTarget[];
  alsoDeleted: WorktreeDiscardDeletedData[];
  preserved: ('source-working-files' | 'branches')[];
  mayRemain: { kind: 'git-registration' | 'git-ref'; repoId: string }[];
  /** The discard first checks the quarantine against its snapshots. */
  verifyAtDiscard?: 'quarantine-against-snapshots';
  /** Binds a discard to this exact description. */
  confirmation: string;
}

export interface WorktreeDiscardGitCleanup {
  repoId: string;
  status: 'cleaned' | 'skipped' | 'failed';
}

export type WorktreeDiscardResult =
  | {
      status: 'discarded';
      removed: WorktreeDiscardTargetKind[];
      gitCleanup: WorktreeDiscardGitCleanup[];
      warnings: string[];
      /** The temporary project this discard left empty and removed, as an ordinary archive reports it. */
      removedTemporaryWorkspaceId?: string;
    }
  | {
      status: 'refused';
      /** `changed`: the confirmed description no longer matches. */
      reason: WorktreeDiscardRefusal | 'changed';
      description: WorktreeDiscardDescription;
    };

/**
 * Returned instead of a thrown refusal when an archive or delete request sets
 * `typedRefusal` (CAN-5334 Q1 B).
 */
export interface WorktreeArchiveTypedRefusal {
  /** The archive refusal reason, or `recovery-required`. */
  reason: string;
  message: string;
  discard: WorktreeDiscardDescription;
}

/** Payload for `portal.worktree.discard.describe`; read-only. */
export interface PortalWorktreeDiscardDescribePayload {
  workspaceId: string;
  worktreeId: string;
  /**
   * CAN-5338: also describe a retained archive of this id whose permanent
   * deletion can't finish. Only a client that renders `retained-archive`
   * targets and the `archive-recovery-unverified` cause sends it; a host
   * without it ignores the field and refuses as before.
   */
  retainedArchives?: boolean;
}

/**
 * Payload for `portal.worktree.discard`; user-only and permanent. No path:
 * the desktop ignores any extra field a client sends.
 */
export interface PortalWorktreeDiscardPayload {
  workspaceId: string;
  worktreeId: string;
  confirmation: string;
  /** CAN-5338: set when the confirmed description lists a `retained-archive` target. */
  retainedArchives?: boolean;
}
