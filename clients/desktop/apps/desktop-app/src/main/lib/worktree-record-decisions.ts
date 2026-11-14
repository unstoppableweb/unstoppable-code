import type {
  WorktreeRecordTarget,
  WorktreeIncarnation,
  WorkspaceAdditionDecision,
  WorkspaceCreationDecision,
  WorktreeCreationReservationDecision,
  WorktreeCreationReservationPreconditions,
  WorktreeCreationReservationOutcome,
  ReservedWorktreeTarget,
  WorktreeCreationPromoteDecision,
  WorktreeCreationSetupDecision,
  WorktreeCreationReservationRemovalDecision,
} from '@canopy/desktop-shared/node/worktree-record-decisions';

import type {
  AdhocMultiRepoTransitionSource,
  CanopyJsonRepoEntry,
  ChatTabPluginSelections,
  CoworkSidebarItem,
  CoworkWorkspaceSettings,
  DependentBaseBranchUpdate,
  SidebarItem,
  SidebarItemsFile,
  WorkspaceConfigFile,
  WorkspaceIndexEntry,
  WorkspaceOwnerBinding,
  WorkspaceDetachedOwner,
  WorkspaceOwnershipTransfer,
  WorkspaceRepoData,
  WorktreeChatBadgesSummary,
  WorktreeCompatibilitySymlink,
  WorktreeData,
  WorktreeDiscovery,
  WorktreeHealthIssue,
  WorktreePrStatus,
} from '@canopy/desktop-shared/types';
import type { CloudProjectBinding } from '@canopy/protocol/memory-sync';

export type {
  WorktreeRecordTarget,
  WorktreeIncarnation,
  WorkspaceAdditionDecision,
  WorkspaceCreationPublishDecision,
  WorkspaceImportPublishDecision,
  WorkspaceCreationDecision,
  WorkspaceSidebarWrite,
  WorktreeCreationReservationDecision,
  WorktreeCreationReservationPreconditions,
  WorktreeCreationReservationOutcome,
  ReservedWorktreeTarget,
  WorktreeCreationPromoteDecision,
  WorktreeCreationSetupDecision,
  WorktreeCreationReservationRemovalDecision,
} from '@canopy/desktop-shared/node/worktree-record-decisions';

/**
 * The decisions the W5 record functions (CAN-3820, CAN-3821, CAN-3822) apply
 * under the worktree list lock, the decisions the composition records
 * (CAN-3823) apply under the list, manifest and index locks (W6d1), the
 * ownership, seed, Cowork and seen records' decisions (W5c2), and the port
 * that applies them (W6-0).
 *
 * A decision is plain data: it survives JSON serialization and carries no
 * closure. It is host-local, not a portable DTO: `health`, both
 * `recovery.expose-*` kinds and the composition kinds naming repositories or
 * `sourceRepoPath` carry host paths. Each record function admits its request
 * on the host before building one; the decision itself is applied without
 * further validation. They are D9 internal decisions: no key, client
 * revision or idempotency guarantee. A composition decision commits in its
 * caller's W5 boundary step when there is one; otherwise its writer commits
 * it on its own, as before.
 */

/**
 * The caller of a badge record, which decides the merge: a chat commit
 * replaces the summary with the one derived from the committed chats; the
 * launch backfill only fills a missing summary or adds `chatName` to an older
 * one, so it never replaces badges a live commit wrote after its read.
 */
export type WorktreeChatBadgesSource = 'chat_commit' | 'launch_backfill';

/**
 * `health-check` is the user's explicit retry (`worktree:health-check`): a
 * broken result always refreshes the stored issue and its `checkedAt`.
 * `diff-stats` is the background check of `worktree:diff-stats-batch`: an
 * issue equal to the stored one keeps the stored `checkedAt` and writes
 * nothing.
 */
export type WorktreeHealthRecordSource = 'health-check' | 'diff-stats';

export interface WorktreeActivityWatermarkDecision {
  kind: 'activity.watermark';
  /** A normalized ISO timestamp. */
  touchedAt: string;
}

export interface WorktreeChatBadgesDecision {
  kind: 'chatBadges';
  source: WorktreeChatBadgesSource;
  summary: WorktreeChatBadgesSummary;
}

export type WorktreeGitRowDecision =
  | {
      kind: 'git.branch';
      /** Trimmed. */
      branchName: string;
      /** A root or single-repository change also moves the sidebar branch. */
      updatesSidebarBranch: boolean;
    }
  | { kind: 'git.pr-status'; status: WorktreePrStatus | null }
  | { kind: 'git.split-child-grouping' }
  | {
      kind: 'git.split-original-retarget';
      /** Trimmed. */
      branchName: string;
      /** Trimmed. */
      trackedBaseBranch: string;
    };

export interface WorktreeHealthDecision {
  kind: 'health';
  source: WorktreeHealthRecordSource;
  /** Null when the worktree validated healthy. Carries host paths. */
  issue: WorktreeHealthIssue | null;
}

export type WorktreeDiscoveryDecision =
  | { kind: 'discovery.environment'; discovery: WorktreeDiscovery }
  | { kind: 'discovery.branch-prompt'; sent: boolean };

/**
 * A display label the summary helper generated and validated. It applies only
 * while the row has no label or a provisional generated one, so a manual
 * label is never replaced.
 */
export interface WorktreeGeneratedLabelDecision {
  kind: 'label.generated';
  /** Normalized by `normalizeGeneratedWorktreeLabel`. */
  label: string;
  provisional: boolean;
}

/**
 * Each names the row incarnation launch observed by its `createdAt`; a
 * different incarnation is `not-found`.
 */
export type WorktreeRecoveryDecision =
  | { kind: 'recovery.promote-pending'; createdAt: string; branchName: string }
  | {
      kind: 'recovery.complete-source-root-repair';
      createdAt: string;
      operationId: string;
    }
  | {
      kind: 'recovery.expose-create-reservation';
      createdAt: string;
      operationId: string;
      /** A host path. */
      worktreePath: string;
    }
  | {
      kind: 'recovery.expose-split-reservation';
      createdAt: string;
      /** A host path. */
      worktreePath: string;
    };

/** The row decisions whose outcome is a `WorktreeRecordOutcome`. */
export type WorktreeRecordRowDecision =
  | WorktreeGitRowDecision
  | WorktreeHealthDecision
  | WorktreeDiscoveryDecision
  | WorktreeGeneratedLabelDecision
  | WorktreeRecoveryDecision;

/** A decision that changes at most one row. */
export type WorktreeRowDecision =
  | WorktreeActivityWatermarkDecision
  | WorktreeChatBadgesDecision
  | WorktreeRecordRowDecision;

export interface WorktreeAutoDeleteBaselineDecision {
  kind: 'activity.auto-delete-baseline';
  /** A normalized ISO timestamp. */
  touchedAt: string;
}

export interface WorktreeMergedBaseRetargetDecision {
  kind: 'git.merged-base-retarget';
  /** `null` for a single-repository workspace's scalar base. */
  repoIds: Array<string | null>;
  /** Trimmed. */
  mergedBranchName: string;
  /** Trimmed. */
  mergedIntoBranchName: string;
  mergedWorktreeId?: string;
}

/** A decision over the whole worktree list of one workspace. */
export type WorktreeListDecision =
  | WorktreeAutoDeleteBaselineDecision
  | WorktreeMergedBaseRetargetDecision;

export interface WorktreeDecisionContext {
  /** The clock, read once per pass of the locked updater. */
  now: Date;
}

/**
 * `recorded` wrote the row; `unchanged` found the row already in that state
 * and wrote nothing; `not-found` found no such row (or a different
 * incarnation of it) and wrote nothing.
 */
export type WorktreeRecordStatus = 'recorded' | 'unchanged' | 'not-found';

export interface WorktreeRecordOutcome {
  status: WorktreeRecordStatus;
  /** The persisted row after the record, or null when it was not found. */
  worktree: WorktreeData | null;
}

export interface WorktreeActivityRecordOutcome {
  /**
   * The rows the record matched, as committed. A row whose watermark was
   * already as recent is included unchanged; an unknown worktree matches none.
   */
  worktrees: WorktreeData[];
  /** Whether a watermark advanced, so the list was written. */
  changed: boolean;
}

export interface WorktreeChatBadgesRecordOutcome {
  /** `unchanged`: the stored summary already matched, so nothing was written. */
  status: 'recorded' | 'unchanged' | 'not-found';
}

export interface WorktreeBaseRetargetOutcome {
  /** `unchanged` when no base tracked the merged branch; nothing was written. */
  status: 'recorded' | 'unchanged';
  /** Each base moved, in list order, for the renderer's event. */
  updates: DependentBaseBranchUpdate[];
}

export type WorktreeRowDecisionOutcome =
  | WorktreeActivityRecordOutcome
  | WorktreeChatBadgesRecordOutcome
  | WorktreeRecordOutcome;

export type WorktreeListDecisionOutcome =
  | WorktreeActivityRecordOutcome
  | WorktreeBaseRetargetOutcome;

/**
 * Applies record decisions to the worktree list, each under the list lock,
 * and returns the record operation's existing outcome. The in-process
 * implementation is `worktree-record-decision-port.ts`, with the list update
 * and removal, manifest and index members in
 * `workspace-record-decision-port.ts` and the ownership and Cowork members in
 * `workspace-ownership-decision-port.ts` and `cowork-record-decision-port.ts`,
 * the workspace-service staging members in
 * `workspace-creation-decision-port.ts`, the branch rename member in
 * `worktree-branch-rename-decision-port.ts`, the archive restore members in
 * `archived-container-restore-decision-port.ts`, the worktree creation
 * members in `worktree-creation-decision-port.ts`, and the archive journal
 * and cleanup members in `worktree-archive-record-decision-port.ts`.
 */
export interface W5RecordDecisionPort {
  applyWorktreeRowDecision(
    target: WorktreeRecordTarget,
    decision: WorktreeActivityWatermarkDecision,
  ): Promise<WorktreeActivityRecordOutcome>;
  applyWorktreeRowDecision(
    target: WorktreeRecordTarget,
    decision: WorktreeChatBadgesDecision,
  ): Promise<WorktreeChatBadgesRecordOutcome>;
  applyWorktreeRowDecision(
    target: WorktreeRecordTarget,
    decision: WorktreeRecordRowDecision,
  ): Promise<WorktreeRecordOutcome>;
  applyWorktreeRowDecision(
    target: WorktreeRecordTarget,
    decision: WorktreeRowDecision,
  ): Promise<WorktreeRowDecisionOutcome>;
  applyWorktreeListDecision(
    workspaceId: string,
    decision: WorktreeAutoDeleteBaselineDecision,
  ): Promise<WorktreeActivityRecordOutcome>;
  applyWorktreeListDecision(
    workspaceId: string,
    decision: WorktreeMergedBaseRetargetDecision,
  ): Promise<WorktreeBaseRetargetOutcome>;
  applyWorktreeListDecision(
    workspaceId: string,
    decision: WorktreeListDecision,
  ): Promise<WorktreeListDecisionOutcome>;
  applyWorktreeListUpdate(
    workspaceId: string,
    decision: CompositionJoinRecordDecision,
    preconditions: WorktreeListPreconditions,
  ): Promise<CompositionJoinRecordOutcome>;
  applyWorktreeListUpdate(
    workspaceId: string,
    decision: CompositionSourceRecordDecision,
    preconditions: WorktreeListPreconditions,
  ): Promise<CompositionSourceRecordOutcome>;
  applyWorktreeListUpdate(
    workspaceId: string,
    decision: PipelineResultsSeenDecision,
    preconditions: WorktreeListPreconditions,
  ): Promise<PipelineResultsSeenOutcome>;
  applyWorktreeListUpdate(
    workspaceId: string,
    decision: WorktreeListUpdateDecision,
    preconditions: WorktreeListPreconditions,
  ): Promise<WorktreeListUpdateOutcome>;
  applyWorktreeListRemoval(
    workspaceId: string,
    decision: WorktreeListRemovalDecision,
    preconditions: WorktreeListRemovalPreconditions,
  ): Promise<WorktreeListRemovalOutcome>;
  applyWorkspaceManifestDecision(
    workspaceId: string,
    decision: WorkspaceManifestDecision,
  ): Promise<void>;
  applyWorkspaceIndexDecision(decision: WorkspaceIndexDecision): Promise<void>;
  applyWorkspaceIndexRemoval(
    workspaceId: string,
    decision: WorkspaceIndexRemovalDecision,
  ): Promise<boolean>;
  applyWorkspaceOwnerDecision(
    workspaceId: string,
    compare: WorkspaceOwnerCompare,
  ): Promise<WorkspaceOwnershipRecordStatus>;
  applyWorkspaceOwnerDecision(
    workspaceId: string,
    decision: OrganizationOwnerRefreshDecision,
  ): Promise<OrganizationOwnerRefreshOutcome>;
  applyWorkspaceOwnerDecision(
    workspaceId: string,
    decision: WorkspaceOwnerCompare | OrganizationOwnerRefreshDecision,
  ): Promise<WorkspaceOwnershipRecordStatus | OrganizationOwnerRefreshOutcome>;
  applyPersonalCatalogIdDecision(
    workspaceId: string,
    decision: PersonalCatalogIdDecision,
    allowed: () => Promise<boolean>,
  ): Promise<string | undefined>;
  applyWorkspaceCloudBindingDecision(
    workspaceId: string,
    compare: WorkspaceCloudBindingCompare,
  ): Promise<WorkspaceOwnershipRecordStatus>;
  applyWorkspaceOwnershipDecision(
    workspaceId: string,
    decision: OrganizationHookBindingsDecision,
  ): Promise<OrganizationHookBindingsOutcome>;
  applyWorkspaceOwnershipDecision(
    workspaceId: string,
    decision: HookExecutionContextsRebindDecision,
  ): Promise<string[]>;
  applyWorkspaceOwnershipDecision(
    workspaceId: string,
    decision: OrganizationPrivateMemoryDecision,
  ): Promise<OrganizationPrivateMemoryStatus>;
  applyWorkspaceOwnershipDecision(
    workspaceId: string,
    decision: WorkspaceOwnershipDecision,
  ): Promise<WorkspaceOwnershipDecisionOutcome>;
  applyAdoptedWorkspaceRelease(
    workspaceId: string,
    decision: AdoptedWorkspaceReleaseDecision,
  ): Promise<boolean>;
  applyCoworkProvisionDecision(
    decision: CoworkProvisionDecision,
  ): Promise<CoworkProvisionOutcome>;
  applyCoworkIndexDecision(
    decision: CoworkMigrationDecision,
  ): Promise<CoworkMigrationOutcome>;
  applyCoworkIndexDecision(
    decision: CoworkDefaultNameDecision,
  ): Promise<CoworkDefaultNameOutcome>;
  applyCoworkIndexDecision(
    decision: CoworkIndexDecision,
  ): Promise<CoworkIndexDecisionOutcome>;
  applyCoworkManifestDecision(
    workspaceId: string,
    decision: CoworkManifestDecision,
  ): Promise<void>;
  // W6a2 (CAN-4814), in `cowork-record-decision-port.ts`.
  applyCoworkCreationAllocation(
    decision: CoworkCreationAllocationDecision,
    admit: (workspaceId: string) => void,
  ): Promise<CoworkSidebarItem>;
  applyCoworkCreationDecision(
    decision: CoworkCreationDecision,
    beforeScaffold: () => void,
  ): Promise<void>;
  applyCoworkCreationManifestDecision(
    workspaceId: string,
    decision: CoworkCreationManifestDecision,
  ): Promise<void>;
  applyCoworkStageDecision(decision: CoworkStageDecision): Promise<boolean>;
  applyCoworkPublishDecision(
    decision: CoworkPublishDecision,
    precheck?: () => Promise<void>,
  ): Promise<CoworkPublishOutcome>;
  applyCoworkMetadataDecision(decision: CoworkMetadataDecision): Promise<void>;
  applyCoworkDiscardDecision(
    decision: CoworkDiscardDecision,
  ): Promise<CoworkDiscardStatus>;
  // W6a1 (CAN-4815), in `workspace-creation-decision-port.ts`.
  applyWorkspaceAdditionDecision(
    decision: WorkspaceAdditionDecision,
  ): Promise<SidebarItemsFile>;
  applyWorkspaceCreationDecision(
    decision: WorkspaceCreationDecision,
    beforeEffects: () => void,
  ): Promise<void>;
  // W6f1 (CAN-4836), in `worktree-branch-rename-decision-port.ts`.
  applyWorktreeBranchRenameDecision(
    target: WorktreeRecordTarget,
    decision: WorktreeBranchRenameDecision,
  ): Promise<WorktreeRecordOutcome>;
  // W6e1 (CAN-4917), in `archived-container-restore-decision-port.ts`.
  applyArchiveRestoreRecordDecision(
    workspaceId: string,
    decision: ArchiveRestoreRecordDecision,
  ): Promise<ArchiveRestoreRecordOutcome>;
  applyArchiveRestoreRemovalDecision(
    workspaceId: string,
    decision: ArchiveRestoreRemovalDecision,
  ): Promise<ArchiveRestoreRemovalOutcome>;
  // W6b (CAN-4947), in `worktree-creation-decision-port.ts`.
  applyWorktreeCreationReservation(
    workspaceId: string,
    decision: WorktreeCreationReservationDecision,
    preconditions: WorktreeCreationReservationPreconditions,
  ): Promise<WorktreeCreationReservationOutcome>;
  /** Whether the reserved incarnation was found. */
  applyReservedWorktreeRecord(
    target: ReservedWorktreeTarget,
    decision: WorktreeCreationSetupDecision,
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
  // W6c1 (CAN-4952), in `worktree-archive-record-decision-port.ts`.
  /** Whether a row with the id was found. */
  applyArchiveJournalRecord(
    target: WorktreeRecordTarget,
    decision: ArchiveJournalDecision,
  ): Promise<boolean>;
  /** Whether a row with the id was removed. */
  applyArchivedWorktreeRowRemoval(
    target: WorktreeRecordTarget,
    decision: ArchivedWorktreeRowRemovalDecision,
  ): Promise<boolean>;
  applyArchiveCleanupTombstone(
    target: WorktreeRecordTarget,
    decision: ArchiveCleanupTombstoneDecision,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// W6d1 (CAN-4410): the workspace composition records (CAN-3823)
//
// The committed composition records and their rollbacks. A rollback is
// applied as an internal decision under the caller's ambient scope, as
// before: it opens no boundary step, so outside one its writer commits it.
// ---------------------------------------------------------------------------

/** What a read of a list, manifest or index proved. */
export type W5RecordReadAuthority = 'ok' | 'absent' | 'partial' | 'unreadable';

/**
 * X1: what a list update requires of the list read under its lock. A list
 * that fails them is refused with `WorktreeRegistryUnreadableError` before
 * the decision applies.
 */
export interface WorktreeListPreconditions {
  /** Refuse an unreadable or partial list. */
  requireAuthoritativeRead?: boolean;
  /** Refuse an absent list. */
  requireExistingList?: boolean;
  /**
   * Removed incarnations the update may add back despite their tombstones.
   * A committed write clears the tombstone of each one it persists, and no
   * other.
   */
  restoreWorktrees?: readonly WorktreeIncarnation[];
}

/** X2: what a list removal requires, and when it tombstones removed rows. */
export interface WorktreeListRemovalPreconditions {
  requireAuthoritativeRead?: boolean;
  requireExistingList?: boolean;
  /** Tombstone only after the write, so a failed removal stays retryable. */
  markRemovedAfterWrite?: boolean;
}

/** The source row fields a composition join records and its undo restores. */
export type CompositionSourceFields = Pick<
  WorktreeData,
  'trackedRepoBaseBranches' | 'compatibilitySymlinks' | 'adhocTransitionSource'
>;

/** Records the joined destination row once; a retry keeps it. */
export interface CompositionJoinRecordDecision {
  kind: 'composition.join.record';
  worktreeId: string;
  sourceWorktree: WorktreeData;
  consumedWorktrees?: readonly WorktreeData[];
  repoIdRewrites: Record<string, string>;
  compatibilitySymlinks: WorktreeCompatibilitySymlink[];
  transition: AdhocMultiRepoTransitionSource;
  joinedTrackedBranches?: WorktreeData['trackedRepoBaseBranches'];
}

/** Undoes the fields a join wrote into an existing row, where still current. */
export interface CompositionJoinUndoDecision {
  kind: 'composition.join.undo';
  worktree: WorktreeIncarnation;
  before: WorktreeData;
  written: WorktreeData;
}

/** Marks the source row's absorption of the joined worktree. */
export interface CompositionSourceRecordDecision {
  kind: 'composition.source.record';
  worktree: WorktreeIncarnation;
  trackedBranches?: WorktreeData['trackedRepoBaseBranches'];
  compatibilitySymlinks: WorktreeCompatibilitySymlink[];
  transition: AdhocMultiRepoTransitionSource;
}

/** Undoes the source fields a join wrote, where still current. */
export interface CompositionSourceUndoDecision {
  kind: 'composition.source.undo';
  worktree: WorktreeIncarnation;
  before: CompositionSourceFields;
  written: CompositionSourceFields;
}

/**
 * Adds back only the removed rows that are missing, each before the next row
 * of `order` still present; current rows, fields and order are kept.
 */
export interface CompositionRowsRestoreDecision {
  kind: 'composition.rows.restore';
  rows: readonly WorktreeData[];
  /** Identity-only anchors read under the removal lock. */
  order?: readonly string[];
}

/** Seeds a temporary project's empty list, and its manifest under that lock. */
export interface TemporaryCompositionCreateDecision {
  kind: 'composition.temporary.create';
  /** Applied inside the list update, once the list read proved it absent. */
  manifest: TemporaryCompositionManifestDecision;
}

export type WorktreeListUpdateDecision =
  | CompositionJoinRecordDecision
  | CompositionJoinUndoDecision
  | CompositionSourceRecordDecision
  | CompositionSourceUndoDecision
  | CompositionRowsRestoreDecision
  | TemporaryCompositionCreateDecision
  | SplitDestinationDecision
  | SourceChangeTargetRecordDecision;

/** Removes only the named incarnation; another one at its id is refused. */
export interface CompositionRowRemoveDecision {
  kind: 'composition.row.remove';
  worktree: WorktreeIncarnation;
}

export type WorktreeListRemovalDecision =
  | CompositionRowRemoveDecision
  | SplitDestinationRemovalDecision
  | SourceChangeTargetRemovalDecision;

/** Removes the repositories this composition added, by id and path. */
export interface CompositionRepositoriesUndoDecision {
  kind: 'composition.repositories.undo';
  repositories: readonly WorkspaceRepoData[];
}

/** Creates an absent temporary project manifest. */
export interface TemporaryCompositionManifestDecision {
  kind: 'composition.temporary.manifest';
  repos: WorkspaceRepoData[];
  temporarySourceWorkspaceIds?: string[];
  temporaryRepoIdentityKeys?: string[];
}

/** Promotes a temporary project, renaming its index entry under the lock. */
export interface CompositionPromotionDecision {
  kind: 'composition.promote';
  sourceRepoPath: string;
  /** Applied inside the manifest update, between its checks and its change. */
  index: CompositionPromotionIndexDecision;
}

export type WorkspaceManifestDecision =
  | CompositionRepositoriesUndoDecision
  | TemporaryCompositionManifestDecision
  | CompositionPromotionDecision
  | SharedContainerForkStartPageDecision
  | SourceInitializationDecision
  | WorkspaceConversionManifestDecision
  | SourceChangeBindingsDecision;

/** Appends a temporary project's entry; an index that leaves entries out is refused. */
export interface TemporaryCompositionIndexDecision {
  kind: 'composition.temporary.index';
  entry: Omit<WorkspaceIndexEntry, 'order'>;
}

/** Renames a multi-repo project's entry. */
export interface CompositionPromotionIndexDecision {
  kind: 'composition.promote.index';
  workspaceId: string;
  /** Trimmed. */
  name: string;
}

export type WorkspaceIndexDecision =
  | TemporaryCompositionIndexDecision
  | CompositionPromotionIndexDecision
  | WorkspaceConversionIndexDecision;

/**
 * A failed composition's targeted index removal (F8). It removes only this
 * project's entry; the remaining entries are renumbered and the post-commit
 * registry, remembered sidebar ids and Portal notification follow, as for
 * every index entry removal.
 */
export interface CompositionDestinationCleanupDecision {
  kind: 'composition.destination.cleanup';
}

export type WorkspaceIndexRemovalDecision =
  | CompositionDestinationCleanupDecision
  | SharedContainerForkHideDecision
  | SplitCreatedWorkspaceCleanupDecision
  | WorkspaceDeletionIndexRemovalDecision;

export interface WorktreeListUpdateOutcome {
  /** The list as committed, or as read when nothing was written. */
  worktrees: WorktreeData[];
}

/** What the last pass that wrote the joined row read and wrote. */
export interface CompositionJoinRecorded {
  /** Absent when the pass appended a new row. */
  before?: WorktreeData;
  written: WorktreeData;
}

export interface CompositionJoinRecordOutcome extends WorktreeListUpdateOutcome {
  /** Absent when no pass wrote: a retry found the row recorded. */
  recorded?: CompositionJoinRecorded;
}

export interface CompositionSourceRecorded {
  before: CompositionSourceFields;
  written: CompositionSourceFields;
}

export interface CompositionSourceRecordOutcome extends WorktreeListUpdateOutcome {
  recorded?: CompositionSourceRecorded;
}

export interface WorktreeListRemovalOutcome {
  /** Exactly the rows removed under the lock. */
  rows: WorktreeData[];
  /** The ids of every row the removal read under the lock, in list order. */
  order: string[];
}

// ---------------------------------------------------------------------------
// W5c2 (CAN-4807): the ownership records (CAN-3819), the organization private
// memory record (CAN-3817), the index seed, the default Cowork provision,
// the legacy Cowork migration and default-name migration (CAN-3818), and the
// sidebar seen record (CAN-3821)
//
// D9 internal decisions: no key, client revision or receipt. None runs in a
// boundary step, so each write commits on its own, as before. Where the
// writer already holds the guard (the ownership writer, the personal catalog
// enrollment, the hook binding and the default-name rename) the port applies
// the decision through that writer unchanged. The materialization's ownership
// compare and the catalog sync's `allowed` are host steps the writer runs on
// its read in the manifest queue; they are port arguments, not decision data.
// The seed decision carries a host path.
// ---------------------------------------------------------------------------

/** What a manifest read in its queue showed; `absent` passes the default config. */
export interface W5ManifestRead {
  authority: 'ok' | 'absent';
  ownerMalformed: boolean;
  memoryMalformed: boolean;
}

/** `updateWorkspaceOwnership`'s outcome. */
export type WorkspaceOwnershipRecordStatus =
  | 'written'
  | 'declined'
  | 'absent'
  | 'unreadable';

/** The authoritative ownership read in the manifest queue. */
export interface WorkspaceOwnershipSnapshot {
  detachedOwner?: WorkspaceDetachedOwner;
  authority: 'ok';
  type: WorkspaceConfigFile['type'];
  owner?: WorkspaceOwnerBinding;
  ownershipTransfer?: WorkspaceOwnershipTransfer;
}

/** Replaces the owner binding and ownership transfer; every other field is kept. */
export interface WorkspaceOwnerDecision {
  kind: 'ownership.owner';
  detachedOwner?: WorkspaceDetachedOwner;
  owner?: WorkspaceOwnerBinding;
  ownershipTransfer?: WorkspaceOwnershipTransfer;
}

/** A host compare on the queued read: the replacement, or `null` to decline. */
export type WorkspaceOwnerCompare = (
  current: WorkspaceOwnershipSnapshot,
) => WorkspaceOwnerDecision | null;

export type OrganizationOwnerBinding = Extract<
  WorkspaceOwnerBinding,
  { type: 'organization' }
>;

/** Moves the fence forward on a re-claim of the same instance. */
export interface OrganizationOwnerRefreshDecision {
  kind: 'ownership.organization.refresh';
  owner: OrganizationOwnerBinding;
}

export interface OrganizationOwnerRefreshOutcome {
  status: WorkspaceOwnershipRecordStatus;
  /** The binding the workspace holds after the decision; absent when it is bound to anything else. */
  held?: OrganizationOwnerBinding;
}

/** Enrolls a Personal workspace, allocating its id when it has none. */
export interface PersonalCatalogIdDecision {
  kind: 'ownership.personal-catalog-id';
}

/** The manifest a cloud project binding (CAN-5190) decides from. */
export interface WorkspaceCloudBindingSnapshot {
  type: WorkspaceConfigFile['type'];
  owner: WorkspaceOwnerBinding | undefined;
  personalCatalogId: string | undefined;
  temporary: boolean;
  cloudBinding: CloudProjectBinding | undefined;
  /** The repositories this device does not clone (`suppressedRepoIds`). */
  suppressedRepoIds: readonly string[];
}

/**
 * Decides a workspace's cloud project binding from the one read in the
 * manifest queue: the replacement (`undefined` removes it), or `null` to
 * leave the workspace as it is. `suppressedRepoIds`, when given, replaces the
 * workspace's declined repositories in the same write (CAN-5192).
 */
export type WorkspaceCloudBindingCompare = (
  current: WorkspaceCloudBindingSnapshot,
) => {
  cloudBinding: CloudProjectBinding | undefined;
  suppressedRepoIds?: readonly string[];
} | null;

/** Binds inherited organization hooks in the local hooks. */
export interface OrganizationHookBindingsDecision {
  kind: 'ownership.hook-bindings';
  /** The workspace root when omitted. */
  repoId?: string;
  sourceHooks: WorkspaceConfigFile['hooks'];
  localHooks: WorkspaceConfigFile['hooks'];
  owner: WorkspaceOwnerBinding | undefined;
}

export interface OrganizationHookBindingsOutcome {
  hooks: WorkspaceConfigFile['hooks'];
  owner: WorkspaceOwnerBinding | undefined;
}

/** Rebinds machine-local hook actions after an owner change; writes only when one moved. */
export interface HookExecutionContextsRebindDecision {
  kind: 'ownership.hook-contexts.rebind';
  previousContext: string;
  nextContext: string;
}

/**
 * Checks the binding on the manifest read in its queue, writing no manifest,
 * then applies its targeted index removal there.
 */
export interface AdoptedWorkspaceReleaseDecision {
  kind: 'ownership.adoption.release';
  /** The claim instance the adoption bound the workspace to. */
  instanceId: string;
  index: AdoptedWorkspaceIndexReleaseDecision;
}

/** Removes only this workspace's index entry; the others keep their order. */
export interface AdoptedWorkspaceIndexReleaseDecision {
  kind: 'ownership.adoption.release.index';
  workspaceId: string;
}

/** The release check on the queued manifest read. */
export type AdoptedWorkspaceReleaseCheck =
  | 'absent'
  | 'owner-unreadable'
  | 'bound-elsewhere'
  | 'bound';

/** Records an organization project's inherited policy and its marker. */
export interface OrganizationPrivateMemoryDecision {
  kind: 'ownership.private-memory';
  organizationId: string;
  projectId: string;
  privateMemory: boolean;
}

/**
 * `refused`: the manifest is missing, its owner or policy is unreadable, or it
 * is bound elsewhere; nothing was written.
 */
export type OrganizationPrivateMemoryStatus =
  | 'recorded'
  | 'unchanged'
  | 'refused';

/** The ownership decisions that read and write only the manifest. */
export type WorkspaceOwnershipDecision =
  | OrganizationHookBindingsDecision
  | HookExecutionContextsRebindDecision
  | OrganizationPrivateMemoryDecision;

export type WorkspaceOwnershipDecisionOutcome =
  | OrganizationHookBindingsOutcome
  | string[]
  | OrganizationPrivateMemoryStatus;

/**
 * Provisions the default Cowork workspace from the index and manifest read
 * under their queues: its manifest is decided inside the index update, and
 * its home is scaffolded there before the index is published.
 */
export interface CoworkProvisionDecision {
  kind: 'cowork.provision';
  workspaceId: string;
  owner?: WorkspaceOwnerBinding;
  publishToIndex: boolean;
  /** The default name and creation time. */
  name: string;
  createdAt: string;
}

/** Each pass of the provisioning manifest update. */
export interface CoworkProvisionManifestPass {
  item: CoworkSidebarItem;
  changed: boolean;
  scaffold: boolean;
  deferManifest?: boolean;
}

export interface CoworkProvisionOutcome {
  item: CoworkSidebarItem;
  notify: boolean;
  /** An unbound default's manifest, created after the index entry. */
  deferredManifest?: CoworkSidebarItem;
}

/** Allocates or reuses a migrated legacy Cowork identity under the index queue. */
export interface CoworkMigrationDecision {
  kind: 'cowork.migration';
  candidateId: string;
  name: string;
  color?: string;
  cowork?: CoworkWorkspaceSettings;
}

export interface CoworkMigrationOutcome {
  id: string;
  created: boolean;
}

/** Renames the entry only while it still has one of `onlyWhenNamed`. */
export interface CoworkDefaultNameDecision {
  kind: 'cowork.default-name';
  workspaceId: string;
  name: string;
  onlyWhenNamed: readonly string[];
}

export interface CoworkDefaultNameOutcome {
  authority: W5RecordReadAuthority;
  renamed: boolean;
}

/** The Cowork decisions that write only the index. */
export type CoworkIndexDecision =
  | CoworkMigrationDecision
  | CoworkDefaultNameDecision;

export type CoworkIndexDecisionOutcome =
  | CoworkMigrationOutcome
  | CoworkDefaultNameOutcome;

/** Creates an unbound default's absent manifest after its index entry. */
export interface CoworkProvisionManifestDecision {
  kind: 'cowork.provision.manifest';
  item: CoworkSidebarItem;
}

/** Writes a migrated workspace's Cowork type and settings, keeping unknown ones. */
export interface CoworkMigrationManifestDecision {
  kind: 'cowork.migration.manifest';
  cowork?: CoworkWorkspaceSettings;
}

export type CoworkManifestDecision =
  | CoworkProvisionManifestDecision
  | CoworkMigrationManifestDecision;

/** Applies a seen delta to the named incarnation only. */
export interface PipelineResultsSeenDecision {
  kind: 'pipelineResults.markSeen';
  worktree: WorktreeIncarnation;
  seen: readonly string[];
  unseen: readonly string[];
}

export interface PipelineResultsSeenOutcome extends WorktreeListUpdateOutcome {
  /** Executions the last matching pass newly marked seen. */
  newlySeen: string[];
}

// ---------------------------------------------------------------------------
// W6a2 (CAN-4814): the remaining Cowork records (CAN-3818): create, stage,
// publish, the import, install and blueprint metadata changes, and discard
//
// D9 internal decisions: no key, client revision or receipt. A create commits
// in its reserved creation boundary step (W6a1's helpers, unchanged); every
// other record commits each write on its own, as before. The creation
// identity probe, the pre-scaffold effects marker and the publish precheck
// are host steps passed to the port, not decision data. A create's external
// folder is a host path; discard never removes it.
// ---------------------------------------------------------------------------

/**
 * Selects a new Cowork identity under the index queue, past every indexed,
 * pending and occupied one, and builds its item. Writes nothing.
 */
export interface CoworkCreationAllocationDecision {
  kind: 'cowork.create.allocate';
  /** Trimmed and non-empty. */
  name: string;
  createdAt: string;
  /** A host path: the attached folder of an external workspace. */
  externalPath?: string;
  installedFromTemplateExternalId?: string;
  owner?: WorkspaceOwnerBinding;
  /** Identities reserved by creations still pending; never reused. */
  pendingIds: readonly string[];
}

/**
 * Publishes an allocated identity: a bound manifest inside the index update,
 * a managed home scaffolded before the index, then the index entry. An
 * unbound manifest follows as a `cowork.create.manifest` decision.
 */
export interface CoworkCreationDecision {
  kind: 'cowork.create';
  item: CoworkSidebarItem;
}

/** Creates the absent manifest of a new Cowork identity. */
export interface CoworkCreationManifestDecision {
  kind: 'cowork.create.manifest';
  item: CoworkSidebarItem;
}

/**
 * Stores a staged organization workspace's initial manifest, or refreshes
 * only the owner of one this project already holds. Writes no index.
 */
export interface CoworkStageDecision {
  kind: 'cowork.stage';
  item: CoworkSidebarItem;
  owner: WorkspaceOwnerBinding;
}

/**
 * Publishes a staged manifest under its index entry, keeping other entries
 * and manifest fields; the same name and binding write nothing.
 */
export interface CoworkPublishDecision {
  kind: 'cowork.publish';
  workspaceId: string;
  /** Trimmed. */
  name: string;
  owner: WorkspaceOwnerBinding;
}

export interface CoworkPublishOutcome {
  item: CoworkSidebarItem;
  changed: boolean;
}

/**
 * The non-settings Cowork metadata changes: each applies only its own fields
 * to the manifest read in its queue, keeping hidden Cowork fields.
 */
export type CoworkMetadataDecision =
  | {
      kind: 'cowork.metadata.import';
      workspaceId: string;
      /** The bundle's name, when its caller passes one; renames the entry. */
      name?: string;
      color?: string;
      cowork?: CoworkWorkspaceSettings;
      defaultPluginSelections?: ChatTabPluginSelections;
    }
  | {
      kind: 'cowork.metadata.install';
      workspaceId: string;
      externalId: string;
      contentHash: string;
    }
  | {
      kind: 'cowork.metadata.blueprint';
      workspaceId: string;
      externalId: string;
    };

/**
 * Removes the metadata directory of an unpublished staged workspace this
 * organization project still owns, matched by project, not claim instance.
 * Commits nothing.
 */
export interface CoworkDiscardDecision {
  kind: 'cowork.discard';
  workspaceId: string;
  projectId: string;
}

/**
 * `removed` removed the metadata directory. Every other status removed
 * nothing: the index cannot show every entry, the workspace is published, or
 * the manifest is absent, unreadable, has an unreadable owner or is not this
 * project's unpublished Cowork staging.
 */
export type CoworkDiscardStatus =
  | 'removed'
  | 'index-unavailable'
  | 'published'
  | 'kept';

/** What a manifest read in the manifest queue showed, for a discard. */
export interface CoworkDiscardManifestRead {
  authority: W5RecordReadAuthority;
  ownerMalformed: boolean;
  type: WorkspaceConfigFile['type'];
  owner?: WorkspaceOwnerBinding;
}

// ---------------------------------------------------------------------------
// W6f1 (CAN-4836): the branch rename record (CAN-3820)
//
// The record step of `core.worktree.branch.rename`, after its Git rename. Not
// a D9 decision: it commits in the rename's boundary step under the list lock
// and the expected worktree revision, so a keyed attempt saves its receipt
// after it, and a failure after Git leaves the attempt recovery-required.
// Admission, the name checks and the Git rename stay host steps.
// ---------------------------------------------------------------------------

/**
 * Records a checkout's renamed branch on its row: a root or single-repository
 * rename moves the sidebar branch, and any rename clears the PR status, which
 * belonged to the old name.
 */
export interface WorktreeBranchRenameDecision {
  kind: 'worktree.branch.rename';
  /** The name Git renamed the branch to, stored as given: not trimmed. */
  branchName: string;
  updatesSidebarBranch: boolean;
}

// ---------------------------------------------------------------------------
// W6e1 (CAN-4917): the archive restore records (CAN-3824)
//
// The destination row of a files-only (version-3) restore of
// `core.archive.container.restore`, after its staged files are copied, and
// its removal when the restore rolls back. Not D9 decisions: the record
// commits in the restore's boundary step under the list lock and the expected
// worktree collection revision, so a keyed attempt saves its receipt after
// it, and a failure after the files leaves the attempt recovery-required. The
// removal keeps its original path, outside any boundary step. Admission, the
// file, chat, Git and archive effects and the committed-list recheck stay
// host steps.
// ---------------------------------------------------------------------------

/**
 * Adds a restore's staged destination row after the rows the list holds, once:
 * a row of the same incarnation is the same destination, and a row of another
 * incarnation at its id is refused.
 */
export interface ArchiveRestoreRecordDecision {
  kind: 'archive.container.restore.record';
  /** The staged row, naming its archive in `restoredFromFilesOnlyArchiveId`. */
  worktree: WorktreeData;
}

/** Removes a restore's destination row only while that incarnation holds its id. */
export interface ArchiveRestoreRemovalDecision {
  kind: 'archive.container.restore.remove';
  worktree: WorktreeIncarnation;
}

/**
 * What the locked pass decided: `recorded` added the row, `already-recorded`
 * found its incarnation, and `identity-changed` found another incarnation at
 * its id and wrote nothing. `worktree` is the row added or found.
 */
export interface ArchiveRestoreRecordDecided {
  status: 'recorded' | 'already-recorded' | 'identity-changed';
  worktree: WorktreeData;
}

export interface ArchiveRestoreRecordOutcome {
  /** Absent when no pass ran. */
  decided?: ArchiveRestoreRecordDecided;
  /** The list as committed, or as read when nothing was written. */
  worktrees: WorktreeData[];
}

/** `not-found`: no row of that incarnation (removed, never recorded or replaced). */
export interface ArchiveRestoreRemovalOutcome {
  status: 'removed' | 'not-found';
}

// ---------------------------------------------------------------------------
// W6e2 (CAN-4927): the shared-container fork metadata records (CAN-3824)
//
// Start-page publication stays in the fork's manifest boundary step (X3).
// Fallback hide stays outside any boundary step (X4): it removes only the
// index entry, never the workspace files. Admission and rollback triggers
// stay on the host; neither decision adds a receipt or an effects marker.
// ---------------------------------------------------------------------------

export interface SharedContainerForkStartPageDecision {
  kind: 'sharedContainer.fork.start-page';
  startPage: NonNullable<WorkspaceConfigFile['startPage']>;
}

export interface SharedContainerForkHideDecision {
  kind: 'sharedContainer.fork.hide';
}

// W6d2 (CAN-4930): split destination records and created-project cleanup.
export type SplitDestinationRow = Pick<
  WorktreeData,
  | 'id'
  | 'createdAt'
  | 'branchName'
  | 'label'
  | 'status'
  | 'trackedBaseBranch'
  | 'setupPhase'
  | 'splitRecoveryRequired'
  | 'hidden'
>;

export type SplitDestinationDecision =
  | { kind: 'split.destination.reserve'; worktree: SplitDestinationRow }
  | {
      kind: 'split.destination.recovery';
      worktree: WorktreeIncarnation;
      fallbackWorktree: SplitDestinationRow;
      healthIssue: WorktreeHealthIssue;
    }
  | {
      kind: 'split.destination.promote';
      worktree: WorktreeIncarnation;
      branchName: string;
    }
  | { kind: 'split.destination.archive'; worktree: SplitDestinationRow };

/** Unlike composition removal, a replacement incarnation is kept, not refused. */
export interface SplitDestinationRemovalDecision {
  kind: 'split.destination.remove';
  worktree: WorktreeIncarnation;
}

/** The host proved the locked list empty and found no rollback data. */
export interface SplitCreatedWorkspaceCleanupDecision {
  kind: 'split.created-workspace.cleanup';
}

// W6f2 (CAN-4942): source initialization and type-conversion records.
// Host-local decisions after repository effects; the host keeps admission,
// boundary steps, repair, journals and the final receipt-only decision.

export interface SourceInitializationDecision {
  kind: 'workspace.source.initialize';
  repositories: WorkspaceConfigFile['repos'];
  sourceRepoPath: string;
}

export interface WorkspaceConversionIndexDecision {
  kind: 'workspace.conversion.index';
  workspaceId: string;
  type: SidebarItem['type'];
}

export interface WorkspaceConversionManifestDecision {
  kind: 'workspace.conversion.manifest';
  config: WorkspaceConfigFile;
  /** Mapped fields explicitly cleared; survives JSON's omission of undefined. */
  clear: string[];
}

// W6f3 (CAN-4943): source-change records (CAN-3819).
// The target row commits in the foreground boundary step; its rollback
// removal and the background repository bindings keep their existing
// triggers outside it. The host keeps admission, checkout, `canopy.json`,
// `onApplied`, the foreground receipt and all background repository work.

/** Appends a created target's row once; any row at its id is refused. */
export interface SourceChangeTargetRecordDecision {
  kind: 'workspace.sourceChanges.target.record';
  worktree: WorktreeData;
}

/** Rolls back a created target's row by id, as the legacy rollback did. */
export interface SourceChangeTargetRemovalDecision {
  kind: 'workspace.sourceChanges.target.remove';
  worktreeId: string;
}

/** Binds local repositories to the applied `canopy.json` over the queued read. */
export interface SourceChangeBindingsDecision {
  kind: 'workspace.sourceChanges.bindings';
  manifestRepositories: Pick<CanopyJsonRepoEntry, 'id' | 'name' | 'url'>[];
  repositoryAdds: { repoId: string; repoPath?: string }[];
  repositoryRemovals: string[];
}

// W6c1 (CAN-4952): archive journal, row removal and cleanup finalization
// records (CAN-3811). A journal record commits as
// `internal.worktree.archive.journal` under the archive's carried-forward
// expected revisions when it has them, otherwise on its own, before Git
// removal. The row removal and the tombstone belong to the archive's
// canonical row removal step; a reserved incarnation is still removed through
// W6b's `worktree.create.reservation.remove`. The host keeps admission, the
// destructive lifecycle, the committed-cleanup retry (#5894) and its
// refusals, revision carry-forward, Git and every receipt.

/** Records or clears a row's compare-before-delete branch deletion guard. */
export type ArchiveJournalDecision =
  | {
      kind: 'worktree.archive.journal.record';
      workspaceKind: 'single-repo';
      /** Carries a host repository path. */
      pendingBranchDeletion: NonNullable<
        WorktreeData['pendingArchiveBranchDeletion']
      >;
    }
  | {
      kind: 'worktree.archive.journal.record';
      workspaceKind: 'multi-repo';
      /** Carries host repository paths. */
      pendingBranchDeletions: NonNullable<
        WorktreeData['pendingArchiveBranchDeletions']
      >;
    }
  | {
      kind: 'worktree.archive.journal.clear';
      workspaceKind: 'single-repo' | 'multi-repo';
    };

/** Removes the row at the id, whatever its incarnation, applying the order. */
export interface ArchivedWorktreeRowRemovalDecision {
  kind: 'worktree.archive.row.remove';
  remainingWorktreeOrder?: readonly string[];
  /** Applies the order only when the remaining rows still read in this order. */
  expectedRemainingWorktreeOrder?: readonly string[];
}

/** Tombstones an archived incarnation the reserved row removal did not find. */
export interface ArchiveCleanupTombstoneDecision {
  kind: 'worktree.archive.cleanup.tombstone';
  createdAt: string;
}

// ---------------------------------------------------------------------------
// W6c2 (CAN-4961): the workspace deletion index removal (CAN-3809)
//
// Code and Cowork deletions remove the project's index entry through the
// settled X4 removal member. Admission, the destructive lifecycle and its
// journal, the commit with its index lock and revision, teardown, directory
// removal and every receipt stay on the host.
// ---------------------------------------------------------------------------

/** Removes a deleted project's index entry; its files go in later host steps. */
export interface WorkspaceDeletionIndexRemovalDecision {
  kind: 'workspace.delete.index';
}
