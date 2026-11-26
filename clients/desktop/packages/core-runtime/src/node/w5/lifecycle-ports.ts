import type { DestructiveRecoveryRecord } from '@canopy/protocol/remote-control/shell/lifecycle-journal';
import type { DestructiveJournalInspection } from './destructive-journal';

/*
 * The W5 lifecycle vocabulary and ports (CAN-4096 P0): the W6a1 workspace
 * creation and W6b worktree reservation decisions, the port that applies
 * them, and the destructive lifecycle journal port. The decisions are generic
 * over the host's item and row types, which core carries but never reads.
 */

/** The host types a lifecycle decision carries. */
export interface W5LifecycleTypes {
  readonly item: unknown;
  readonly singleRepoItem: unknown;
  readonly multiRepoItem: unknown;
  /** What a whole-sidebar write returns. */
  readonly itemsFile: unknown;
  readonly worktree: unknown;
  /** A create's recorded setup phase. */
  readonly creationPhase: unknown;
  readonly healthIssue: unknown;
}

export interface WorktreeRecordTarget {
  workspaceId: string;
  worktreeId: string;
}

/**
 * A worktree incarnation: a different `createdAt` is another worktree. `Key`
 * is the row's identity field.
 */
export type CoreWorktreeIncarnation<
  Worktree extends { createdAt: unknown },
  Key extends keyof Worktree,
> = Pick<Worktree, Key | 'createdAt'>;

// ---------------------------------------------------------------------------
// W6a1 (CAN-4815): workspace-service staging (CAN-3806, CAN-3812, CAN-3813):
// a find-or-create addition, and a create's or an import's publication
//
// D9 internal decisions: no key, client revision or receipt. Each applies
// through the whole-sidebar writer the records used, unchanged: its index
// merge, unreadable-project preservation and post-commit registries stay that
// writer's, shared with Cowork deletion. A create or import commits in its
// reserved creation boundary step, a scoped addition in its caller's step; an
// unscoped addition commits each write on its own, as before. Admission, id
// allocation and the effects marker stay host steps. Items carry host paths.
// ---------------------------------------------------------------------------

/**
 * Adds a find-or-create destination. A `workspace` scope writes only this
 * workspace's files and keeps every other entry, as its caller's step locks
 * only them; a `sidebar` scope rewrites the sidebar read in the workspace
 * mutation queue, keeping `preserveWorkspaceIds` as persisted.
 */
export interface CoreWorkspaceAdditionDecision<T extends W5LifecycleTypes> {
  kind: 'workspace.add';
  item: T['item'];
  scope:
    | { kind: 'workspace' }
    | {
        kind: 'sidebar';
        previousItems: T['item'][];
        preserveWorkspaceIds: string[];
      };
}

/**
 * Publishes a created or imported repository project: only the addition,
 * binding its owner and keeping every other entry.
 */
export interface CoreWorkspaceCreationPublishDecision<
  T extends W5LifecycleTypes,
> {
  kind: 'workspace.create.publish';
  item: T['item'];
}

/**
 * Publishes an imported multi-repo project and its new member projects
 * together, keeping every other entry and every owner binding on disk.
 */
export interface CoreWorkspaceImportPublishDecision<
  T extends W5LifecycleTypes,
> {
  kind: 'workspace.import.publish';
  workspace: T['multiRepoItem'];
  childWorkspaces: T['singleRepoItem'][];
}

export type CoreWorkspaceCreationDecision<T extends W5LifecycleTypes> =
  | CoreWorkspaceCreationPublishDecision<T>
  | CoreWorkspaceImportPublishDecision<T>;

/** The whole-sidebar write a W6a1 decision makes. */
export interface CoreWorkspaceSidebarWrite<T extends W5LifecycleTypes> {
  items: T['item'][];
  options: {
    preserveEmptyTemporary?: false;
    preserveUnmentionedWorkspaceIds?: true;
    preserveWorkspaceIds?: string[];
    replaceOwnershipWorkspaceIds?: string[];
  };
}

// W6b (CAN-4947): worktree creation records (CAN-3810).
// The reservation commits in `core.worktree.create`'s reservation step, under
// its optional expected worktrees collection revision. The setup records
// commit on their own, except a keyed needs-repair retention, which commits
// with its receipt; a created outcome still ends with the receipt-only
// decision. The host keeps admission, the metadata reservation, the effects
// markers, Git, cancellation, rollback triggers and every receipt.

/**
 * Leads the list with a reserved row. An id already listed is a collision and
 * writes nothing; a listed branch or checkout path is refused.
 */
export interface CoreWorktreeCreationReservationDecision<
  T extends W5LifecycleTypes,
> {
  kind: 'worktree.create.reserve';
  /** The `git-pending` row; its checkouts carry host paths. */
  worktree: T['worktree'];
  sidebarItemGroupId?: string;
}

export interface WorktreeCreationReservationPreconditions {
  /** The worktrees collection revision the reservation expects. */
  expectedRevision?: number;
}

export interface WorktreeCreationReservationOutcome {
  status: 'reserved' | 'collision';
}

/** A reserved row's incarnation: the setup reference of its create. */
export interface ReservedWorktreeTarget extends WorktreeRecordTarget {
  createdAt: string;
}

/** Records a promoted checkout's branch and base, completing its creation. */
export type WorktreeCreationPromoteDecision =
  | {
      kind: 'worktree.create.promote';
      workspaceKind: 'single-repo';
      branchName: string;
      /** Absent clears the row's base. */
      trackedBaseBranch?: string;
    }
  | {
      kind: 'worktree.create.promote';
      workspaceKind: 'multi-repo';
      branchName: string;
      /** Absent clears the row's bases. */
      trackedRepoBaseBranches?: Record<string, string>;
    };

/**
 * The records a create's setup makes on its reserved row. There, each refuses
 * a changed branch another row holds.
 */
export type CoreWorktreeCreationSetupDecision<T extends W5LifecycleTypes> =
  | {
      kind: 'worktree.create.phase';
      /** Absent keeps the recorded phase. */
      phase?: T['creationPhase'];
      recoveryRequired: boolean;
      healthIssue?: T['healthIssue'];
    }
  | { kind: 'worktree.create.branch'; branchName: string }
  | WorktreeCreationPromoteDecision;

/** Removes a reserved row's incarnation, applying the requested order. */
export interface WorktreeCreationReservationRemovalDecision {
  kind: 'worktree.create.reservation.remove';
  remainingWorktreeOrder?: readonly string[];
  /** Applies the order only when the remaining rows still read in this order. */
  expectedRemainingWorktreeOrder?: readonly string[];
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/**
 * Applies the W6a1 and W6b decisions. The W6a2 Cowork creation decisions are
 * not members: they stay with the host's record decision port.
 */
export interface W5LifecycleDecisionPort<T extends W5LifecycleTypes> {
  // W6a1 (CAN-4815).
  applyWorkspaceAdditionDecision(
    decision: CoreWorkspaceAdditionDecision<T>,
  ): Promise<T['itemsFile']>;
  /** `beforeEffects` marks the write as its step's first potential effect. */
  applyWorkspaceCreationDecision(
    decision: CoreWorkspaceCreationDecision<T>,
    beforeEffects: () => void,
  ): Promise<void>;
  // W6b (CAN-4947).
  applyWorktreeCreationReservation(
    workspaceId: string,
    decision: CoreWorktreeCreationReservationDecision<T>,
    preconditions: WorktreeCreationReservationPreconditions,
  ): Promise<WorktreeCreationReservationOutcome>;
  /** Whether the reserved incarnation was found. */
  applyReservedWorktreeRecord(
    target: ReservedWorktreeTarget,
    decision: CoreWorktreeCreationSetupDecision<T>,
  ): Promise<boolean>;
  /** Whether a row with the id was found; any incarnation is promoted. */
  applyWorktreeSetupRecord(
    target: WorktreeRecordTarget,
    decision: WorktreeCreationPromoteDecision,
  ): Promise<boolean>;
  /** Whether the reserved incarnation was removed. */
  applyReservedWorktreeRemoval(
    target: ReservedWorktreeTarget,
    decision: WorktreeCreationReservationRemovalDecision,
  ): Promise<boolean>;
}

/**
 * The destructive lifecycle journals (W6c1): one validated `lifecycle-journal`
 * record per project or worktree slot (`lifecycleJournalSlotName`), beside
 * copies named by operation id. The host binds the data root.
 */
export interface W5LifecycleJournalPort {
  /** The slot's journal, or null when the slot is empty; unreadable evidence throws. */
  readSlot(
    workspaceId: string,
    worktreeId?: string,
  ): Promise<DestructiveRecoveryRecord | null>;
  /** Durably replaces the journal in the record's slot. */
  save(record: DestructiveRecoveryRecord): Promise<void>;
  /** Reads every journal without following aliases or changing evidence. */
  inspect(): Promise<DestructiveJournalInspection>;
}
