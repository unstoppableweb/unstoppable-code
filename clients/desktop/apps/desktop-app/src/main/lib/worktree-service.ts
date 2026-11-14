import {
  withArchiveFailureTelemetry,
  setArchiveFailurePhase,
  type ArchiveTrigger,
  type ArchiveFailureTelemetryOptions,
} from './archive-failure-telemetry';
import {
  isWorktreeReadAvailable,
  isWorktreeObservationTarget,
  withWorktreeGitRead,
} from './worktree-read-availability';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { worktreeSourceFailure } from '@canopy/core-runtime/node/git';
import { isNativeError } from 'node:util/types';
import {
  decodeWorktreeBaseBranch,
  isExplicitWorktreeBaseBranch,
} from '@canopy/protocol/portal';
import {
  consumeW5Metadata,
  prepareW5Metadata,
  readPreparedW5Worktrees,
  type PreparedW5Metadata,
} from './w5-metadata-preparation';
import { WorktreeArchiveRefusedError } from './worktree-archive-refusal';
import { W5CommitRefusedError } from '@canopy/desktop-shared/node/w5-commit-log/errors';
import {
  withDestructiveLifecycle,
  readDestructiveRecovery,
  refuseInterruptedArchiveJournal,
  destructiveStep,
  destructiveCall,
  destructiveCleanup,
  assertNoDestructiveRecovery,
  assertNoLegacyArchiveRecovery,
  hasDestructiveLifecycle,
  markDestructiveCleanupRequired,
  settleDestructiveCleanupDebt,
  destructiveTurnDiffCleanupRepair,
  readDirectoryStatIdentity,
  type ExactArchiveJournal,
  acknowledgeArchiveCaptureRefusal,
  protectDestructivePath,
  destructiveArchiveOutcomeSchema,
  canResumeFailedChildArchive,
  canResumeInterruptedArchive,
  listUnfinishedDestructiveWorktreeIds,
  type DestructivePhase,
} from './w5-destructive-recovery';
import { currentW5CommitScope } from './w5-commit-scope';
import { WorktreeRegistryUnreadableError } from './worktree-list-repository';
import {
  w5NamedUnreadable,
  W5RecordOverloadedError,
  W5AuthorityUnreachableError,
} from './w5-file-store';
import {
  commitW5BoundaryStep,
  w5CompositionLocks,
} from './w5-composition-operation';
import { w5ResourceKey } from './w5-commit-log-file-store';
import { withW5Commit, type W5CommitOptions } from './w5-commit-log-file-store';
import { w5RecordReadPaths } from './paths';
import type { W5KeyedAttempt } from './w5-keyed-operation';
import {
  isWorktreeArchiveSourceUnavailable,
  prepareArchivedContainerRecovery,
  readArchivedContainerRecovery,
  readArchivedContainerRecoveryJournal,
  finishArchivedContainerRecovery,
} from './archived-container-recovery';
import { isFilesOnlyRestoreGitless } from './files-only-restore-git';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { listUnmanagedWorktreeRepositories } from './unmanaged-worktree-repository';
import { lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { BrowserWindow } from 'electron';
import {
  isDefaultWorktreeBranchName,
  makeDefaultWorktreeBranchName,
} from '@canopy/desktop-shared/lib/default-worktree-branch';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  SINGLE_REPO_USAGE_REPO_ID,
  WORKSPACE_ROOT_REPO_ID,
  WORKSPACE_ROOT_REPO_NAME,
  type ArchiveWorktreeResponse,
  type ArchivedContainerManifest,
  type ArchivedContainerManifestV2,
  type ArchivedContainerRecoveryManifest,
  type CreateWorkspaceWorktreeResponse,
  type CreateWorktreeResponse,
  type DiffStats,
  type DiffStatsBatchResponseItem,
  type MultiRepoSidebarItem,
  type RepoBranchInfo,
  type SingleRepoSidebarItem,
  type WorktreeGitFailedEvent,
  type WorktreeSetupStorageFailure,
  type WorktreeGitReadyEvent,
  type WorktreeStatsRequestSource,
  type WorktreeNeedsRepairEvent,
  type WorktreeCliRecord,
  type WorktreeData,
  type WorktreeEffectiveOverrides,
  type UsageRepoScope,
  type WorkspaceConfigFile,
  type WorkspaceRepoData,
  type WorkspaceWorktreeRepairIssue,
  type WorktreeDeletedUsageEvent,
  type WorktreeHealthIssue,
} from '@canopy/desktop-shared/types';
import { normalizeWorkspaceDefaultLayoutMode } from '@canopy/desktop-shared/node/lib/panel-layout-mode';
import {
  runWithGitRequestContext,
  type GitRequestContext,
} from '@canopy/desktop-shared/node/git-request-context';
import { generateUniqueAnimalName } from './animals';
import {
  beginWorktreeGitSetup,
  endWorktreeGitSetup,
} from './worktree-git-setup';
import { runWithWorkspaceTargetActivityDeletion } from './workspace-activity';
import {
  bestEffortPruneWorktrees,
  cleanupPersistedTurnDiffTreeRefs,
  createWorktree,
  createWorktreeForExistingBranch,
  createWorktreeFromStartPoint,
  deleteBranch,
  deleteBranchIfMatches,
  doesLocalBranchExist,
  doesRemoteBranchExist,
  fetchOrigin,
  forceDeleteBranch,
  getCanopyJsonHash,
  getCurrentBranch,
  getCurrentBranchDisplayName,
  getDiffStats,
  getGitCommonDir,
  getRemoteUrl,
  hasBranchBeenPushedToRemote,
  hasCommitsAhead,
  hasLocalCommit,
  hasRemoteTrackingBranch,
  hasUncommittedChanges,
  hasUnpushedCommits,
  hasUnpulledCommits,
  isBranchNameAvailable,
  isAncestor,
  isRegisteredWorktreePath,
  listCheckedOutBranches,
  pruneWorktrees,
  removeWindowsWorktreeReparsePoints,
  resolveExactRefSha,
  resolveExactRefStartPoint,
  resolveRefSha,
  resolveSharedAvailableBranchName,
  validateBranchName,
  WORKTREE_GIT_TIMEOUT_MS,
  withWorktreeRemovalLock,
} from './git';
import {
  getWorktreeDataDir,
  getWorktreeDataRootDir,
  getWorktreeDir,
  getWorkspaceWorktreeDir,
  getWorkspaceWorktreeRepoDir,
  getWorkspaceWorktreeRootRepoDir,
  getWorkspaceWorktreesRootDir,
  getArchivedContainersRootDir,
  getArchivedContainerExecutionsDir,
} from './paths';
import { validateAbsolutePath, validateId } from './validation';
import {
  refuseWorktreeCreation,
  WorktreeCreationRefusedError,
  requestedBranchNames,
  resolveWorktreeCreationSelection,
  type WorktreeCreationRefusal,
  type WorktreeSelectionFields,
} from './worktree-creation-selection';
import { WORKTREE_LIST_STORAGE, withStorageAdmission } from './w5-storage';
import {
  WorkspaceTargetAutoArchiveExcludedError,
  markWorkspaceTargetRemovalPending,
  whenWorkspaceTargetRemovalSettled,
  withWorkspaceTargetArchiveDrain,
} from './workspace-target-exclusion';
import { schedulePortalStructuralSync } from '../portal/portal-structural-sync';
import {
  BrowserRetirementTimeoutError,
  runWithBrowserRetirementDeadlineScope,
  hasBrowserRetirementDeadlineExpired,
  withBrowserRetirementDeadline,
} from './browser-retirement-deadline';
import {
  readWorkspaceConfig,
  readWorkspaceWorktrees,
  readWorkspaceWorktreesDetailed,
  removeWorkspaceWorktrees,
} from './workspace-persistence';
import {
  applyReservedWorktreeRecord,
  applyReservedWorktreeRemoval,
  applyWorktreeCreationReservation,
  applyWorktreeSetupRecord,
} from './worktree-creation-decision-port';
import {
  applyArchiveCleanupTombstone,
  applyArchiveJournalRecord,
  applyArchivedWorktreeRowRemoval,
} from './worktree-archive-record-decision-port';
import type {
  ArchiveJournalDecision,
  WorktreeCreationPromoteDecision,
  WorktreeCreationReservationDecision,
} from './worktree-record-decisions';
import { readAllSidebarItems, readWorkspaceIndexEntry } from './sidebar-items';
import { readEffectiveWorkspaceConfig } from './workspace-source';
import { resolveProjectReferenceRepoPath } from './project-reference-repo';
import { resolveWorkspaceReferenceRepoPath } from './workspace-reference-repo';
import {
  resolveProjectScripts,
  resolveWorkspaceRepoScripts,
  resolveWorkspaceRootScripts,
  toScriptOverrides,
} from './script-resolver';
import {
  resolveProjectHooks,
  resolveWorkspaceRepoHooks,
  resolveWorkspaceRootHooks,
  toHookOverrides,
} from './hook-resolver';
import {
  resolveEffectiveBaseBranchForRepo,
  resolveEffectiveBaseBranchForStats,
  resolveEffectiveBaseBranchesForStats,
  resolveRepoDefaultBranch,
} from './worktree-base-branches';
import { listWorkspaceWorktreeRepoEntries } from './worktree-repo-entries';
import {
  repairWorkspaceRootWorktree,
  validateWorkspaceRootWorktree,
} from './workspace-source-control';
import { cleanupPersistedWorktreeData } from './worktree-data-cleanup';
import { cleanupWorktreePipelines } from '../pipelines/worktree-cleanup';
import { createElectronExecutionRuntime } from '../pipelines/execution-runtime';
import { listExecutionSummaries } from '@canopy/execution-engine/node/pipelines/executor/execution-state';
import type {
  ExecutionRuntime,
  ExecutionSummary,
} from '@canopy/execution-engine/node/pipelines/executor/types';
import { createCliExecutionRuntime } from '@canopy/desktop-shared/node/pipelines/cli-runtime';
import { readPreferencesFile } from './preferences-store';
import { panelLayoutModePersistenceStore } from '../panels/layout-mode-persistence';
import { logMainProcessWarn } from './main-process-logging';
import { mapWithConcurrency } from './concurrency';
import { validateWorktreeHealthForStats } from './worktree-health';
import { recordWorktreeHealth } from './worktree-repair';
import {
  consumeWorktreeSetupCancellation,
  isWorktreeSetupCancellationRequested,
  markWorktreeSetupCancellation,
  type WorktreeSetupCancellationRef,
} from './worktree-setup-cancellation';
import {
  cleanupCompatibilitySymlinks,
  listCompatibilitySymlinkReservedWorktreeIds,
} from './adhoc-multi-repo-workspaces';
import { getExecutionObservabilityIngest } from '../observability/ingest';
import { getChatQueueService } from '../services/chat-queue-service';
import { getChatStateService } from '../services/chat-state-service';
import { notifyLedgerContainerArchived } from '../ledger/lifecycle';
import {
  elapsedMilliseconds,
  recordWorktreeStatsTiming,
} from '../portal/portal-performance-diagnostics';
import {
  queueOrphanedMacosWorktreeDirectory,
  removeExactMacosWorktreeDirectory,
  removeStagedMacosWorktreeDirectory,
  restoreStagedMacosWorktreeDirectory,
  stageExactMacosWorktreeDirectoryForRemoval,
} from './macos-worktree-directory-cleanup';
import { eagerSeedNewWorktreeCodeGraph } from './code-graph-eager-seed';
import {
  beginArchivedContainerCapture,
  broadcastArchivedContainersChanged,
  commitArchivedContainer,
  assertArchivedContainerSourceGeneration,
  countArchivedContainerExecutions,
  readArchivedContainerManifestIncludingExpired,
  withArchivedWorkspaceOperationLock,
} from './archived-containers';
import {
  createArchivedContainerTiming,
  resolveContainerRetentionDays,
} from './archived-container-retention';
import { scheduleArchivedContainerDiskUsage } from './archived-container-disk-usage';
import { captureArchivedContainerProviderState } from './archived-container-provider-state';
import { countCapturedChats } from './archived-container-capture';
import { runArchiveIoRequest } from '../archive/archive-io-runner';
import type { ArchiveIoOperationRequest } from '../archive/archive-io-protocol';
import { getResolvedGitExecutableForSpawn } from './git-executable';
import { deferCodeGraphRefreshUntilPostCreateSetup } from './code-graph-scheduler';
import { isErrnoException } from './type-guards';
import { removeTreeWithoutAsar } from './remove-tree-without-asar';
import {
  withLinuxWorktreeRemovalVerification,
  withLinuxWorktreeWriterTracking,
  WorktreeProcessCleanupError,
} from './worktree-process-cleanup';
import { BrowserProfileError } from '@canopy/desktop-shared/browser-profile-error';
import {
  captureArchivedContainerGitState,
  completeArchivedContainerGitCapture,
  discardIncompleteArchivedGitCapture,
  isArchivedGitCaptureRecoveryRequiredError,
  prepareArchivedContainerTeardown,
  readArchivedGitStagedDescriptor,
  type ArchivedContainerBranchDeletionMode,
} from './archived-container-git';
import {
  detachedWorkCallback,
  settleAll,
  settleEach,
  trackDetachedWork,
} from '@canopy/desktop-shared/node/lib/detached-work';
import { publishWorktreeGitReady } from './worktree-git-ready-hooks';
import { publishWorktreeLifecycleChange } from './worktree-lifecycle-signals';
import { runAsLocalFenceHolder } from '../app-advisor/local-fence-holder';

/**
 * The worktree create service request. Its branch and base fields resolve to
 * one typed selection ({@link resolveWorktreeCreationSelection}) before
 * anything is read or reserved.
 */
export interface CreateWorktreeServiceOptions extends WorktreeSelectionFields {
  /** The workspace worktrees collection revision read before creating. */
  expectedRevision?: number;
  /** A containing composition/restore decision carries only its own revision advances. */
  w5BoundaryCommit?: W5CommitOptions;
  /** Parent attempt signal without changing this service's existing rollback policy. */
  w5BoundaryAttempt?: W5KeyedAttempt;
  /** Trusted keyed boundary; the initial row never completes this reservation. */
  w5KeyedCreation?: {
    attempt: W5KeyedAttempt;
    operationId?: string;
    commitRepairOutcome: (
      response: CreateWorkspaceWorktreeResponse,
      record: () => Promise<boolean>,
    ) => Promise<boolean>;
  };
  sidebarItemGroupId?: string;
  workspaceId: string;
  existingWorktreeIds?: string[];
  /**
   * How a default branch (no requested branch) is named. `worktree-id` names
   * it after the generated worktree id, as pipeline-created worktrees always
   * have. Omitted keeps the timestamped `<worktree id>-<epoch ms>` default.
   */
  defaultBranchNaming?: 'worktree-id';
  /** Defaults to true; archive restore validates local refs and disables fetch. */
  allowBaseBranchNetwork?: boolean;
  /** Portal picker intent: only the selected local/origin branch may supply the base. */
  baseBranchResolution?: 'exact-branch';
  /** The Portal New Task catalogue selected a full ref in the base field. */
  baseBranchIsQualified?: true;
  /** Restrict multi-repo creation to these child repository ids. */
  includedRepoIds?: readonly string[];
  repairWorkspaceRoot?: boolean;
  restoreClaudeMd?: boolean;
  startPostCreateSetup?: boolean;
  /** Defaults to true. Archive restore disables creation-time mode seeding. */
  seedPanelLayoutMode?: boolean;
  /**
   * Surface a needs-repair workspace root via the
   * `CreateWorkspaceWorktreeResponse.needsRepair` response shape even when
   * `startPostCreateSetup` is not set. Without either flag the non-deferred
   * multi-repo path throws a CLI-worded `--repair` error, which desktop
   * callers (e.g. session import) must never show to users.
   */
  surfaceNeedsRepairInResponse?: boolean;
  startProjectPostCreateSetup?: ProjectWorktreePostCreateSetup;
  startWorkspacePostCreateSetup?: WorkspaceWorktreePostCreateSetup;
  getWindow?: () => BrowserWindow | null;
  deferGitSetup?: boolean;
  /**
   * Complete caller-owned initialization while the reservation is still
   * `git-pending`, before readiness is persisted or published.
   */
  beforeGitReady?: (event: WorktreeGitReadyEvent) => void | Promise<void>;
  /**
   * Runs exactly once when deferred Git setup reaches a terminal outcome,
   * including cancellation paths that intentionally publish no ready/failure event.
   * A needs-repair detour reported through `onNeedsRepair` is not terminal:
   * the repair or the worktree's teardown settles that setup instead.
   */
  onGitSetupSettled?: (event: {
    projectId: string;
    worktreeId: string;
    outcome: 'ready' | 'cancelled' | 'failed';
  }) => void;
  onGitReady?: (event: WorktreeGitReadyEvent) => void;
  onGitFailed?: (event: WorktreeGitFailedEvent) => void;
  /**
   * Emitted only on the deferred (`deferGitSetup: true`) source-backed
   * multi-repo path when Phase B adds the workspace-root checkout and finds
   * blocking repair issues without `repairWorkspaceRoot` pre-authorization.
   * Phase B retains the reservation and checkout for explicit recovery;
   * the renderer opens the repair modal. The
   * non-deferred path surfaces this synchronously via
   * `CreateWorkspaceWorktreeResponse.needsRepair` instead.
   */
  onNeedsRepair?: (event: WorktreeNeedsRepairEvent) => void;
}

/** The default branch name of a generated worktree id for this request. */
function defaultWorktreeBranchName(
  options: Pick<CreateWorktreeServiceOptions, 'defaultBranchNaming'>,
  worktreeId: string,
  timestamp: number,
): string {
  return options.defaultBranchNaming === 'worktree-id'
    ? worktreeId
    : makeDefaultWorktreeBranchName(worktreeId, timestamp);
}

async function seedCreatedWorktreePanelLayoutMode(
  options: CreateWorktreeServiceOptions,
  worktreeId: string,
): Promise<void> {
  if (
    options.seedPanelLayoutMode === false ||
    (options.workspaceId === APP_ADVISOR_PROJECT_ID &&
      worktreeId === APP_ADVISOR_WORKTREE_ID)
  ) {
    return;
  }
  try {
    const preferences = await readPreferencesFile();
    await panelLayoutModePersistenceStore.initialize(
      options.workspaceId,
      worktreeId,
      normalizeWorkspaceDefaultLayoutMode(
        preferences.workspaceDefaultLayoutMode,
      ),
    );
  } catch (error) {
    logMainProcessWarn('Failed to seed worktree panel layout mode', {
      workspaceId: options.workspaceId,
      worktreeId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

interface ReservedWorktree {
  id: string;
  metadataDir: string;
}

interface PersistedReservation {
  id: string;
  metadataDir: string;
  worktree: WorktreeData;
}

export interface WorktreeArchiveLiveServices {
  cleanupLiveState?: (
    projectId: string,
    worktreeId: string,
    onSessionsDestroyed?: () => void,
  ) => Promise<void>;
  purgeObservabilityData?: (
    projectId: string,
    worktreeId: string,
  ) => Promise<void>;
}

type ArchivePhase =
  | 'admission'
  | 'teardown-script'
  | 'resource-drain'
  | 'git-capture'
  | 'file-recovery'
  | 'teardown'
  | 'commit-cleanup';
interface ArchiveDiagnosticContext {
  operationId: string;
  phase: ArchivePhase;
  /**
   * Browser profile retirement is subordinate to the archive: when it cannot
   * be prepared or committed, the archive continues and the profile is retired
   * as an owner-removed task once the worktree record is gone.
   */
  browserRetirementDeferred?: boolean;
}
const archiveDiagnosticContext =
  new AsyncLocalStorage<ArchiveDiagnosticContext>();
function setArchivePhase(phase: ArchivePhase): void {
  setArchiveFailurePhase(phase);
  const context = archiveDiagnosticContext.getStore();
  if (context) context.phase = phase;
}

function deferArchiveBrowserRetirement(
  error: unknown,
  step: 'prepare' | 'commit' | 'settle',
): void {
  const context = archiveDiagnosticContext.getStore();
  if (context) context.browserRetirementDeferred = true;
  // Log only the error code: errors from Git or storage can contain local paths.
  logMainProcessWarn('Worktree archive deferred browser profile retirement', {
    operation: 'worktree_archive',
    operationId: context?.operationId,
    phase: context?.phase,
    step,
    code: archiveBrowserRetirementErrorCode(error),
  });
}

function archiveBrowserRetirementErrorCode(error: unknown): string {
  if (error instanceof BrowserRetirementTimeoutError) return error.code;
  if (error instanceof BrowserProfileError) return error.code;
  return isErrnoException(error) && typeof error.code === 'string'
    ? error.code
    : 'other';
}

/**
 * Commits the archive's browser profile retirement without letting profile
 * metadata block an archive that has crossed its commit point.
 */
async function commitArchiveBrowserRetirement(
  workspaceId: string,
  worktreeId: string,
  kind?: 'git_quarantine',
): Promise<string[]> {
  if (archiveDiagnosticContext.getStore()?.browserRetirementDeferred) return [];
  try {
    // Defer browser lifecycle/session loading until the archive commit point;
    // ordinary archive preparation must not initialize it.
    const { commitTaskBrowserRetirement } =
      await import('../browser/browser-profile-lifecycle');
    // An abandoned commit still retires the profile once it runs: the archive
    // is past its commit point, so nothing has to be settled for it.
    return (await withBrowserRetirementDeadline(() =>
      commitTaskBrowserRetirement(workspaceId, worktreeId, kind),
    ))
      ? ['Browser profile retired; physical storage cleanup is pending.']
      : [];
  } catch (error) {
    deferArchiveBrowserRetirement(error, 'commit');
    return [];
  }
}

/**
 * Settles a retirement whose prepare outlasted the archive's deadline. The
 * prepare can still finish while that archive, or a retry of it, is running,
 * and until every archive of the worktree has ended the fence is theirs:
 * settling sooner would abort a fence the worktree is about to be removed
 * under, or one a retry was handed. Afterwards settling commits the
 * retirement if the worktree is gone, aborts the fence if it is still there,
 * and finds nothing if an archive already did either.
 */
async function settleLatePreparedBrowserRetirement(
  workspaceId: string,
  worktreeId: string,
  operationId: string | null,
): Promise<void> {
  if (!operationId) return;
  await whenWorkspaceTargetRemovalSettled(workspaceId, worktreeId);
  const { settleFailedTaskBrowserRetirement } =
    await import('../browser/browser-profile-lifecycle');
  await settleFailedTaskBrowserRetirement(operationId);
}

const DEFERRED_BROWSER_RETIREMENT_WARNING =
  'Browser data for this worktree will be cleared the next time the app starts.';

/** Retires a deferred browser profile once its worktree record is removed. */
async function retireDeferredArchiveBrowserProfile(
  workspaceId: string,
  worktreeId: string,
): Promise<string[]> {
  if (!archiveDiagnosticContext.getStore()?.browserRetirementDeferred)
    return [];
  try {
    // Deferred like commitArchiveBrowserRetirement: only a deferred retirement
    // reaches this point, so ordinary archives never initialize the browser
    // lifecycle/session module.
    const { retireRemovedBrowserTask } =
      await import('../browser/browser-profile-lifecycle');
    // Skipped, not awaited, once an earlier profile call of this archive has
    // expired: the retirement is idempotent, so completing late is harmless.
    await withBrowserRetirementDeadline(() =>
      retireRemovedBrowserTask(workspaceId, worktreeId),
    );
    return [];
  } catch (error) {
    // The deferred retirement is the archive's last chance to retire the
    // profile; until it does, the archive keeps its cleanup marker.
    markDestructiveCleanupRequired();
    logMainProcessWarn('Worktree archive could not retire browser profile', {
      operation: 'worktree_archive',
      operationId: archiveDiagnosticContext.getStore()?.operationId,
      code:
        error instanceof BrowserRetirementTimeoutError ||
        error instanceof BrowserProfileError
          ? error.code
          : 'other',
    });
    // A timeout is not a failure, so it is logged without a warning. An
    // abandoned retirement still completes once metadata answers; a skipped
    // one sits behind an earlier abandoned call, whose late prepare is settled
    // and whose late commit retires the profile. Startup reconciliation
    // retires profiles whose owner no longer exists, whatever is left.
    if (error instanceof BrowserRetirementTimeoutError) return [];
    return [DEFERRED_BROWSER_RETIREMENT_WARNING];
  }
}

interface MultiRepoDiffResult {
  stats: DiffStats;
  baseBranch: string | null;
  baseBranchExistsLocally: boolean;
  baseBranchExistsInRemote: boolean;
  hasOriginRemote: boolean;
  hasCommitsAhead: boolean;
  hasUncommittedChanges: boolean;
  hasRemoteTrackingBranch: boolean;
  hasUnpushedCommits: boolean;
  hasUnpulledCommits: boolean;
  hasBranchBeenPushed: boolean;
  repoBranches: RepoBranchInfo[];
}

interface BaseBranchResolution {
  trackedBranch: string;
  startPoint: string;
  trackingRef?: string;
}

interface PreparedWorktreeArchiveContainer {
  manifest: ArchivedContainerManifest;
  warnings: string[];
  teardownCompleted?: boolean;
}

/**
 * Outcome of `performRootWorktreeSetup` (Task I1): the workspace-root checkout
 * plus its branch reconciliation and repair validation. `needs-repair` means
 * the root was created but has blocking issues and repair was not authorized —
 * the caller decides whether to surface it via the create response (CLI) or the
 * `onNeedsRepair` event (deferred desktop).
 */
type RootWorktreeSetupResult =
  | { status: 'ready'; branchName: string; rootBranchName: string | null }
  | {
      status: 'needs-repair';
      branchName: string;
      rootBranchName: string | null;
      repairIssues: WorkspaceWorktreeRepairIssue[];
    };

export type ProjectWorktreePostCreateSetup = (params: {
  projectId: string;
  worktreeId: string;
  project: Pick<SingleRepoSidebarItem, 'repoPath' | 'scripts'>;
  getWindow: () => BrowserWindow | null;
}) => Promise<void>;

export type WorkspaceWorktreePostCreateSetup = (params: {
  workspaceId: string;
  worktreeId: string;
  workspaceRootPath: string;
  repos: WorkspaceRepoData[];
  getWindow: () => BrowserWindow | null;
}) => Promise<void>;

const MAX_RESERVATION_ATTEMPTS = 8;
const REPO_DIFF_STATS_CONCURRENCY = 4;
const WORKTREE_EFFECTIVE_REPO_CONCURRENCY = 4;
// child_process.spawn performs synchronous setup in Electron's main process.
// Serializing this per-worktree fan-out keeps that setup below the IPC
// responsiveness budget even while chats and pipelines launch children too.
const WORKTREE_STATS_GIT_CONCURRENCY = 1;
const worktreeStatsInFlight = new Map<
  string,
  Promise<DiffStatsBatchResponseItem>
>();
export type WorktreeStatsFreshnessMode =
  | 'cache-only'
  | 'stale-ok'
  | 'fresh-local'
  | 'fresh-remote';

/**
 * Reads one repository's diff stats against its selected base branch. The
 * diff-stats IPC projections pass one that dispatches `worker.git.diff.get`
 * for their caller (CAN-4103); every other consumer reads directly.
 */
export type WorktreeRepoDiffStatsReader = (
  repository: { readonly repoId: string; readonly repoPath: string },
  baseBranch: string | undefined,
) => Promise<DiffStats>;

// Compatibility debt (CAN-4103): callers without an IPC caller (the CLI, the
// Portal and background cache refreshes) hold no `worker.git.read`.
const readDiffStatsDirectly: WorktreeRepoDiffStatsReader = (
  { repoPath },
  baseBranch,
) => getDiffStats(repoPath, baseBranch);

interface WorktreeStatsOptions {
  /** @deprecated Prefer an explicit `freshness` mode. */
  skipFetch?: boolean;
  freshness?: WorktreeStatsFreshnessMode;
  source?: WorktreeStatsRequestSource;
  requestId?: string;
  /**
   * Reads the diff stats of a computation this call starts. A computation
   * already in flight or cached serves the call with the stats it read.
   */
  readDiffStats?: WorktreeRepoDiffStatsReader;
}

interface WorktreeStatsCacheEntry {
  result: DiffStatsBatchResponseItem;
  completedAt: number;
  generation: number;
  inputIdentity: string;
  revision: number;
}

const WORKTREE_STATS_FRESH_RESULT_TTL_MS = 5_000;
const WORKTREE_STATS_MAX_STALE_RESULT_MS = 60_000;
const WORKTREE_STATS_MAX_COMPLETED_RESULTS = 2_000;
const worktreeStatsCompleted = new Map<string, WorktreeStatsCacheEntry>();
const worktreeStatsGenerations = new Map<string, number>();
const worktreeStatsInputIdentities = new Map<string, string>();
let worktreeStatsComputationRevision = 0;
const WINDOWS_WORKTREE_DIRECTORY_REMOVE_MAX_RETRIES = 50;
const DEFAULT_WORKTREE_DIRECTORY_REMOVE_MAX_RETRIES = 2;
const WORKTREE_DIRECTORY_REMOVE_RETRY_DELAY_MS = 200;
const projectGitSetupQueues = new Map<string, Promise<void>>();
const BACKGROUND_WORKTREE_GIT_OPTIONS = Object.freeze({
  backgroundPriority: true,
});

function createWorktreeWithPriority(
  repoPath: string,
  worktreePath: string,
  branchName: string,
  options?: { backgroundPriority?: boolean },
): Promise<string> {
  return options
    ? createWorktree(repoPath, worktreePath, branchName, options)
    : createWorktree(repoPath, worktreePath, branchName);
}

function createWorktreeFromStartPointWithPriority(
  repoPath: string,
  worktreePath: string,
  branchName: string,
  startPoint: string,
  options?: { backgroundPriority?: boolean },
  trackingRef?: string,
): Promise<string> {
  if (trackingRef)
    return createWorktreeFromStartPoint(
      repoPath,
      worktreePath,
      branchName,
      startPoint,
      {
        ...options,
        trackingRef,
      },
    );
  return options
    ? createWorktreeFromStartPoint(
        repoPath,
        worktreePath,
        branchName,
        startPoint,
        options,
      )
    : createWorktreeFromStartPoint(
        repoPath,
        worktreePath,
        branchName,
        startPoint,
      );
}

function createWorktreeForExistingBranchWithPriority(
  repoPath: string,
  worktreePath: string,
  branchName: string,
  options?: { backgroundPriority?: boolean },
): Promise<string> {
  return options
    ? createWorktreeForExistingBranch(
        repoPath,
        worktreePath,
        branchName,
        options,
      )
    : createWorktreeForExistingBranch(repoPath, worktreePath, branchName);
}

function shouldSkipAutomaticFetch(options?: { skipFetch?: boolean }): boolean {
  return options?.skipFetch === true || process.platform === 'win32';
}

function worktreeStatsIdentityKey(
  workspaceId: string,
  worktreeId: string,
): string {
  return `${workspaceId}\0${worktreeId}`;
}

function getWorktreeStatsGeneration(identityKey: string): number {
  return worktreeStatsGenerations.get(identityKey) ?? 0;
}

function worktreeStatsInFlightKey(
  identityKey: string,
  generation: number,
  mode: 'fresh-local' | 'fresh-remote',
  inputIdentity: string,
): string {
  return `${identityKey}\0${generation}\0${mode}\0${inputIdentity}`;
}

function sortedBranchEntries(
  branches: Record<string, string> | undefined,
): Array<[string, string]> {
  return Object.entries(branches ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  );
}

async function resolveWorktreeStatsInputIdentity(
  workspaceId: string,
  worktreeId: string,
): Promise<string> {
  const workspace = await getStatsWorkspaceById(workspaceId);
  const worktree = workspace.worktrees.find((entry) => entry.id === worktreeId);
  return JSON.stringify({
    workspaceType: workspace.type,
    workspaceRepoPath:
      workspace.type === 'single-repo' ? workspace.repoPath : undefined,
    workspaceRepos:
      workspace.type === 'multi-repo'
        ? workspace.repos
            .map((repo) => [repo.id, repo.repoPath] as const)
            .sort(([left], [right]) => left.localeCompare(right))
        : [],
    worktreeId: worktree?.id,
    createdAt: worktree?.createdAt,
    setupPhase: worktree?.setupPhase,
    trackedBaseBranch: worktree?.trackedBaseBranch,
    trackedRepoBaseBranches: sortedBranchEntries(
      worktree?.trackedRepoBaseBranches,
    ),
  });
}

function resolveWorktreeStatsFreshnessMode(
  options?: WorktreeStatsOptions,
): WorktreeStatsFreshnessMode {
  if (options?.freshness) return options.freshness;
  return options?.skipFetch === true ? 'fresh-local' : 'fresh-remote';
}

function pruneWorktreeStatsCompletedResults(): void {
  if (worktreeStatsCompleted.size <= WORKTREE_STATS_MAX_COMPLETED_RESULTS) {
    return;
  }
  const oldest = Array.from(worktreeStatsCompleted.entries())
    .sort((left, right) => left[1].completedAt - right[1].completedAt)
    .slice(
      0,
      worktreeStatsCompleted.size - WORKTREE_STATS_MAX_COMPLETED_RESULTS,
    );
  oldest.forEach(([key]) => worktreeStatsCompleted.delete(key));
}

/**
 * Invalidates completed and in-flight stats for one logical worktree. Older
 * computations may finish for their original callers, but their generation
 * can no longer populate the completed-result cache.
 */
export function invalidateWorktreeStats(
  workspaceId: string,
  worktreeId: string,
): void {
  const identityKey = worktreeStatsIdentityKey(workspaceId, worktreeId);
  worktreeStatsGenerations.set(
    identityKey,
    getWorktreeStatsGeneration(identityKey) + 1,
  );
  worktreeStatsCompleted.delete(identityKey);
  worktreeStatsInputIdentities.delete(identityKey);
}

/**
 * Bounded staleness for the periodic diff-stats fetch. Worktrees of the same
 * repo share one git common dir, so `fetchOrigin`'s TTL keying by common dir
 * collapses a fleet of worktrees into at most one remote fetch per repo per
 * TTL window instead of one per worktree per poll cycle.
 */
const AUTOMATIC_FETCH_TTL_MS = 5 * 60_000;

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    Reflect.get(error, 'code') === code
  );
}

function normalizeError(error: unknown): Error {
  return error instanceof Error || isNativeError(error)
    ? error
    : new Error(String(error));
}

function getErrorMessage(error: unknown): string {
  return normalizeError(error).message;
}

function getErrorLogDetails(error: unknown): Record<string, unknown> {
  const details: Record<string, unknown> = {
    message: getErrorMessage(error),
  };
  if (typeof error !== 'object' || error === null) {
    return details;
  }
  for (const key of [
    'code',
    'errno',
    'syscall',
    'path',
    'signal',
    'cmd',
  ] as const) {
    const value: unknown = Reflect.get(error, key);
    if (typeof value === 'string' || typeof value === 'number') {
      details[key] =
        typeof value === 'string' && value.length > 4_000
          ? `${value.slice(0, 4_000)}…`
          : value;
    }
  }
  const killed: unknown = Reflect.get(error, 'killed');
  if (typeof killed === 'boolean') {
    details.killed = killed;
  }
  for (const key of ['stdout', 'stderr'] as const) {
    const value: unknown = Reflect.get(error, key);
    if (typeof value === 'string' && value.trim().length > 0) {
      details[key] = value.length > 4_000 ? `${value.slice(0, 4_000)}…` : value;
    }
  }
  return details;
}

function isWorktreeRemovalTimeoutError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  return (
    Reflect.get(error, 'killed') === true ||
    Reflect.get(error, 'code') === 'ETIMEDOUT'
  );
}

function createSetupFailureHealthIssue(
  worktreePath: string,
  error: Error,
  sourceRepoId?: string,
): WorktreeHealthIssue {
  const failure = worktreeSourceFailure(error);
  return {
    status: 'broken',
    code: 'git-error',
    message: failure
      ? 'The source branch has no commits yet.'
      : 'Worktree setup failed.',
    checkedAt: new Date().toISOString(),
    worktreePath,
    gitError: getErrorMessage(error),
    ...(failure ? { failureReason: failure.failureReason, sourceRepoId } : {}),
  };
}

/**
 * Deferred multi-repo Phase B result when the root checkout needs a repair
 * the user must confirm. Unlike a cancellation (`null`), the Git setup stays
 * pending until the repair completes or the worktree is torn down.
 */
const PHASE_B_NEEDS_REPAIR = Symbol('phase-b-needs-repair');

/**
 * Deferred Phase B outlives its create's admission, so it is admitted again
 * before its first git mutation. A refusal never reaches Phase B's own
 * failure reporting, so it reports the failure here. The refused list keeps
 * the git-pending reservation; the health issue shows it as broken.
 */
async function admitDeferredPhaseB<T>(
  options: CreateWorktreeServiceOptions,
  worktreeId: string,
  worktreePath: string,
  runPhaseB: () => Promise<T>,
): Promise<T> {
  let started = false;
  try {
    return await withStorageAdmission([WORKTREE_LIST_STORAGE], () => {
      started = true;
      return runPhaseB();
    });
  } catch (error) {
    if (!started) {
      options.onGitFailed?.({
        projectId: options.workspaceId,
        worktreeId,
        error: getErrorMessage(error),
        healthIssue: createSetupFailureHealthIssue(
          worktreePath,
          error instanceof Error ? error : new Error(String(error)),
        ),
      });
    }
    throw error;
  }
}

function enqueueProjectGitSetup(
  projectId: string,
  runPhaseB: () => Promise<void>,
): void {
  const previous = projectGitSetupQueues.get(projectId) ?? Promise.resolve();
  // Register the continuation outside creation's authority, not just its observer.
  // Phase B takes its own routed admission after the queue releases it.
  detachedWorkCallback(() => {
    const current = previous.catch(() => undefined).then(runPhaseB);
    const settled = current.catch(() => undefined);
    projectGitSetupQueues.set(projectId, settled);
    return settled.finally(() => {
      if (projectGitSetupQueues.get(projectId) === settled) {
        projectGitSetupQueues.delete(projectId);
      }
    });
  })();
}

function startProjectPostCreateSetupSafely(
  startSetup: ProjectWorktreePostCreateSetup | undefined,
  params: Parameters<ProjectWorktreePostCreateSetup>[0],
  onFailure: () => void,
): boolean {
  if (!startSetup) {
    return false;
  }

  try {
    // Setup admits at its sinks instead of holding the create's admission.
    detachedWorkCallback(() => startSetup(params).catch(onFailure))();
    return true;
  } catch {
    // Post-create setup failure must never roll back git-ready completion.
    return false;
  }
}

function startWorkspacePostCreateSetupSafely(
  startSetup: WorkspaceWorktreePostCreateSetup | undefined,
  params: Parameters<WorkspaceWorktreePostCreateSetup>[0],
  onFailure: () => void,
): boolean {
  if (!startSetup) {
    return false;
  }

  try {
    // Setup admits at its sinks instead of holding the create's admission.
    detachedWorkCallback(() => startSetup(params).catch(onFailure))();
    return true;
  } catch {
    // Post-create setup failure must never roll back git-ready completion.
    return false;
  }
}

function runtimeForMode(
  mode: 'persisted-only' | 'live-service',
): ExecutionRuntime {
  return mode === 'live-service'
    ? createElectronExecutionRuntime()
    : createCliExecutionRuntime({ cwd: process.cwd() });
}

async function safeRemoveWorktree(
  repoPath: string,
  worktreePath: string,
  recoveryTarget?: {
    workspaceId: string;
    worktreeId: string;
    repoId?: string;
  },
): Promise<string[]> {
  return withWorktreeRemovalLock(repoPath, (removeLockedWorktree) =>
    safeRemoveWorktreeLocked(
      repoPath,
      worktreePath,
      removeLockedWorktree,
      recoveryTarget,
    ),
  );
}

function archiveWorkerEnvironment(executable: string): {
  executable: string;
  env: Record<string, string>;
} {
  return {
    executable,
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    ),
  };
}

async function removeArchivedWorktreeWithWorker(args: {
  projectId: string;
  containerId: string;
  expectedCreatedAt: string;
  repoId: string;
  referenceRepoPath: string;
  worktreePath: string;
  preMoveWorktreePath: string;
}): Promise<string[]> {
  const expectedRepositoryIdentity = await getGitCommonDir(
    args.referenceRepoPath,
  );
  const executable = await getResolvedGitExecutableForSpawn(process.env);
  return withWorktreeRemovalLock(args.referenceRepoPath, async () => {
    // Archive teardown already owns a guarded quarantine journal. Keep Git
    // removal in the archive worker and let an interruption re-enter that
    // journal on the next archive request.
    await runArchiveIoRequest({
      version: 1,
      type: 'remove-worktree',
      requestId: randomUUID(),
      operationId: `archive:${args.projectId}:${args.containerId}:remove-worktree:${args.repoId}`,
      projectId: args.projectId,
      containerId: args.containerId,
      expectedCreatedAt: args.expectedCreatedAt,
      input: {
        git: archiveWorkerEnvironment(executable),
        referenceRepoPath: args.referenceRepoPath,
        expectedRepositoryIdentity,
        worktreePath: args.worktreePath,
        preMoveWorktreePath: args.preMoveWorktreePath,
      },
    });
    return [];
  });
}

async function removeArchivedDirectoryWithWorker(args: {
  projectId: string;
  containerId: string;
  expectedCreatedAt: string;
  path: string;
}): Promise<void> {
  await runArchiveIoRequest({
    version: 1,
    type: 'remove-directory',
    requestId: randomUUID(),
    operationId: `archive:${args.projectId}:${args.containerId}:remove-directory`,
    projectId: args.projectId,
    containerId: args.containerId,
    expectedCreatedAt: args.expectedCreatedAt,
    input: { path: args.path, allowedRoot: dirname(args.path) },
  });
}

async function copyArchivedPipelinePayloadWithWorker(args: {
  projectId: string;
  containerId: string;
  expectedCreatedAt: string;
  executionId: string;
  input: Extract<ArchiveIoOperationRequest, { type: 'copy-payload' }>['input'];
}): Promise<void> {
  await runArchiveIoRequest({
    version: 1,
    type: 'copy-payload',
    requestId: randomUUID(),
    operationId: `archive:${args.projectId}:${args.containerId}:copy-pipeline:${args.executionId}`,
    projectId: args.projectId,
    containerId: args.containerId,
    expectedCreatedAt: args.expectedCreatedAt,
    input: args.input,
  });
}

async function deleteArchivedBranchesWithWorker(args: {
  projectId: string;
  containerId: string;
  expectedCreatedAt: string;
  branches: readonly {
    referenceRepoPath: string;
    repositoryIdentity: string;
    branchName: string;
    expectedTip: string;
  }[];
  mode: ArchivedContainerBranchDeletionMode;
}): Promise<void> {
  if (args.branches.length === 0) return;
  const executable = await getResolvedGitExecutableForSpawn(process.env);
  await runArchiveIoRequest({
    version: 1,
    type: 'delete-branches',
    requestId: randomUUID(),
    operationId: `archive:${args.projectId}:${args.containerId}:delete-branches`,
    projectId: args.projectId,
    containerId: args.containerId,
    expectedCreatedAt: args.expectedCreatedAt,
    input: {
      git: archiveWorkerEnvironment(executable),
      branches: args.branches.map((branch) => ({
        referenceRepoPath: branch.referenceRepoPath,
        expectedRepositoryIdentity: branch.repositoryIdentity,
        branchName: branch.branchName,
        expectedTip: branch.expectedTip,
        mode: args.mode,
      })),
    },
  });
}

async function safeRemoveWorktreeLocked(
  repoPath: string,
  worktreePath: string,
  removeLockedWorktree: (worktreePath: string) => Promise<void>,
  recoveryTarget?: {
    workspaceId: string;
    worktreeId: string;
    repoId?: string;
  },
): Promise<string[]> {
  let gitRemovalError: unknown;
  const initiallyRegistered = await isRegisteredWorktreePath(
    repoPath,
    worktreePath,
  ).catch(() => true);
  if (initiallyRegistered) {
    const removalStartedAt = Date.now();
    try {
      await destructiveStep('git-worktree-unregister', () =>
        removeLockedWorktree(worktreePath),
      );
      return [];
    } catch (error) {
      if (hasDestructiveLifecycle()) throw error;
      gitRemovalError = error;
      // eslint-disable-next-line no-console
      console.warn(
        'Git worktree removal failed; checking safe recovery options.',
        {
          repoPath,
          worktreePath,
          elapsedMs: Date.now() - removalStartedAt,
          error: getErrorLogDetails(error),
        },
      );
      let stillRegistered = await isRegisteredWorktreePath(
        repoPath,
        worktreePath,
      ).catch(() => true);

      if (stillRegistered && isWorktreeRemovalTimeoutError(error)) {
        const retryStartedAt = Date.now();
        // eslint-disable-next-line no-console
        console.info('Retrying timed-out Git worktree removal.', {
          repoPath,
          worktreePath,
        });
        try {
          await destructiveStep('git-worktree-unregister', () =>
            removeLockedWorktree(worktreePath),
          );
          return [];
        } catch (retryError) {
          gitRemovalError = retryError;
          // eslint-disable-next-line no-console
          console.warn('Git worktree removal retry failed.', {
            repoPath,
            worktreePath,
            elapsedMs: Date.now() - retryStartedAt,
            error: getErrorLogDetails(retryError),
          });
          stillRegistered = await isRegisteredWorktreePath(
            repoPath,
            worktreePath,
          ).catch(() => true);
        }
      }

      if (stillRegistered) {
        await pruneWorktrees(repoPath).catch((pruneError) => {
          // eslint-disable-next-line no-console
          console.warn('Git worktree prune failed during removal recovery.', {
            repoPath,
            worktreePath,
            error: getErrorLogDetails(pruneError),
          });
        });
        stillRegistered = await isRegisteredWorktreePath(
          repoPath,
          worktreePath,
        ).catch(() => true);
      }

      if (stillRegistered) {
        if (
          process.platform === 'darwin' &&
          recoveryTarget &&
          isWorktreeRemovalTimeoutError(gitRemovalError)
        ) {
          return recoverTimedOutMacosWorktreeRemoval({
            repoPath,
            worktreePath,
            workspaceId: recoveryTarget.workspaceId,
            worktreeId: recoveryTarget.worktreeId,
            repoId: recoveryTarget.repoId,
            gitRemovalError,
          });
        }
        throw normalizeError(gitRemovalError);
      }
    }
  } else {
    gitRemovalError = new Error('Git no longer registers this worktree path.');
    // eslint-disable-next-line no-console
    console.info('Skipping Git worktree removal for an unregistered path.', {
      repoPath,
      worktreePath,
    });
  }

  // Git may already have removed and unregistered the checkout before the
  // post-removal writer check fails. Preserve that result instead of running
  // a new pre-removal check which would falsely describe the path as retained.
  if (gitRemovalError instanceof WorktreeProcessCleanupError) {
    return [formatUnregisteredWorktreeWarning(worktreePath, gitRemovalError)];
  }

  try {
    let physicalRemovalError = await tolerateRemovalWork(
      'checkout-directory-removal',
      () => removePhysicalWorktreeDirectory(worktreePath),
    );
    bestEffortPruneWorktrees(repoPath, 'worktree-service safeRemoveWorktree');

    if (physicalRemovalError === undefined) {
      return [];
    }

    const stillRegistered = await isRegisteredWorktreePath(
      repoPath,
      worktreePath,
    ).catch(() => true);
    if (stillRegistered) {
      throw normalizeError(physicalRemovalError);
    }

    if (process.platform === 'darwin' && recoveryTarget) {
      // The native fallback is intentionally reachable only after Git confirms
      // this exact validated worktree path is no longer registered.
      // Run as a lifecycle step so a refused or failed lifecycle never reaches
      // the recursive native removal.
      const nativeRemovalError = await tolerateRemovalWork(
        'checkout-native-removal',
        () =>
          recoveryTarget.repoId === undefined
            ? removeExactMacosWorktreeDirectory(
                recoveryTarget.workspaceId,
                recoveryTarget.worktreeId,
                worktreePath,
              )
            : removeExactMacosWorktreeDirectory(
                recoveryTarget.workspaceId,
                recoveryTarget.worktreeId,
                worktreePath,
                recoveryTarget.repoId,
              ),
      );
      if (nativeRemovalError === undefined) {
        // eslint-disable-next-line no-console
        console.info(
          'Removed unregistered worktree directory with the macOS native fallback.',
          {
            workspaceId: recoveryTarget.workspaceId,
            worktreeId: recoveryTarget.worktreeId,
            worktreePath,
          },
        );
        return [];
      }
      physicalRemovalError = combineRemovalErrors(
        physicalRemovalError,
        nativeRemovalError,
      );
    }

    if (!tolerantResidueWarningPlatform()) {
      throw normalizeError(physicalRemovalError);
    }

    if (process.platform === 'darwin' && recoveryTarget) {
      await queueOrphanedMacosWorktreeDirectory({
        workspaceId: recoveryTarget.workspaceId,
        worktreeId: recoveryTarget.worktreeId,
        repoId: recoveryTarget.repoId,
        worktreePath,
        error: physicalRemovalError,
      });
    }

    const warning = formatUnregisteredWorktreeWarning(
      worktreePath,
      physicalRemovalError,
    );
    // Preserve enough detail in main.log to diagnose why both removal paths
    // failed while allowing metadata and auxiliary cleanup to continue.
    // eslint-disable-next-line no-console
    console.warn(warning, {
      gitRemovalError: getErrorMessage(gitRemovalError),
      physicalRemovalError: getErrorLogDetails(physicalRemovalError),
    });
    return [warning];
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Worktree removal failed.', {
      repoPath,
      worktreePath,
      gitRemovalError: getErrorLogDetails(gitRemovalError),
      physicalRemovalError: getErrorLogDetails(error),
    });
    throw error;
  }
}

async function recoverTimedOutMacosWorktreeRemoval(options: {
  repoPath: string;
  worktreePath: string;
  workspaceId: string;
  worktreeId: string;
  repoId?: string;
  gitRemovalError: unknown;
}): Promise<string[]> {
  const cleanupPath =
    options.repoId === undefined
      ? await stageExactMacosWorktreeDirectoryForRemoval(
          options.workspaceId,
          options.worktreeId,
          options.worktreePath,
        )
      : await stageExactMacosWorktreeDirectoryForRemoval(
          options.workspaceId,
          options.worktreeId,
          options.worktreePath,
          options.repoId,
        );
  // eslint-disable-next-line no-console
  console.warn(
    'Staged a timed-out worktree directory for guarded removal recovery.',
    {
      repoPath: options.repoPath,
      worktreePath: options.worktreePath,
      cleanupPath,
      gitRemovalError: getErrorLogDetails(options.gitRemovalError),
    },
  );

  try {
    await pruneWorktrees(options.repoPath);
    const stillRegistered = await isRegisteredWorktreePath(
      options.repoPath,
      options.worktreePath,
    );
    if (stillRegistered) {
      throw new Error(
        'Git still registers the worktree after its exact directory was staged and pruned.',
      );
    }
  } catch (error) {
    try {
      if (options.repoId === undefined) {
        await restoreStagedMacosWorktreeDirectory(
          options.workspaceId,
          options.worktreeId,
          options.worktreePath,
          cleanupPath,
        );
      } else {
        await restoreStagedMacosWorktreeDirectory(
          options.workspaceId,
          options.worktreeId,
          options.worktreePath,
          cleanupPath,
          options.repoId,
        );
      }
    } catch (restoreError) {
      throw combineRemovalErrors(error, restoreError);
    }
    throw normalizeError(error);
  }

  try {
    if (options.repoId === undefined) {
      await removeStagedMacosWorktreeDirectory(
        options.workspaceId,
        options.worktreeId,
        options.worktreePath,
        cleanupPath,
      );
    } else {
      await removeStagedMacosWorktreeDirectory(
        options.workspaceId,
        options.worktreeId,
        options.worktreePath,
        cleanupPath,
        options.repoId,
      );
    }
    return [];
  } catch (error) {
    await queueOrphanedMacosWorktreeDirectory({
      workspaceId: options.workspaceId,
      worktreeId: options.worktreeId,
      repoId: options.repoId,
      worktreePath: options.worktreePath,
      cleanupPath,
      error,
    });
    const warning = `Git unregistered this worktree, but macOS left files queued for background cleanup at ${cleanupPath}: ${getErrorMessage(
      error,
    )}`;
    // eslint-disable-next-line no-console
    console.warn(warning, {
      repoPath: options.repoPath,
      worktreePath: options.worktreePath,
      cleanupPath,
      gitRemovalError: getErrorLogDetails(options.gitRemovalError),
      physicalRemovalError: getErrorLogDetails(error),
    });
    return [warning];
  }
}

/** Platforms that report leftover files as a warning once Git has let go. */
function tolerantResidueWarningPlatform(): boolean {
  const operatingSystem = hostOperatingSystem();
  return (
    operatingSystem === 'win32' ||
    operatingSystem === 'darwin' ||
    operatingSystem === 'linux'
  );
}

/**
 * Linux residue wording. A writer-verification failure already says whether
 * the directory was retained (checked before removal) or removed (checked
 * after), so its message is reported as is and never rewritten to claim the
 * opposite.
 */
function formatLinuxResidueWarning(
  worktreePath: string,
  error: unknown,
  gitUnregistered: boolean,
): string {
  if (error instanceof WorktreeProcessCleanupError) {
    return gitUnregistered
      ? `Git unregistered this worktree. ${error.message}`
      : error.message;
  }
  const residue = `Linux left files behind at ${worktreePath}: ${getErrorMessage(
    error,
  )}`;
  return gitUnregistered
    ? `Git unregistered this worktree, but ${residue}`
    : residue;
}

function formatUnregisteredWorktreeWarning(
  worktreePath: string,
  error: unknown,
): string {
  if (hostOperatingSystem() === 'linux') {
    return formatLinuxResidueWarning(worktreePath, error, true);
  }
  const residueDescription =
    process.platform === 'darwin'
      ? 'macOS left files behind'
      : 'Windows left locked files behind';
  return `Git unregistered this worktree, but ${residueDescription} at ${worktreePath}: ${getErrorMessage(
    error,
  )}`;
}

function formatWindowsLockedFilesWarning(
  worktreePath: string,
  error: unknown,
): string {
  return `Windows left locked files behind at ${worktreePath}: ${getErrorMessage(
    error,
  )}`;
}

async function removePhysicalWorktreeDirectory(
  worktreePath: string,
): Promise<void> {
  const removeDirectory = async (): Promise<void> => {
    await removeWindowsWorktreeReparsePoints(worktreePath);
    await removeTreeWithoutAsar(worktreePath, {
      recursive: true,
      force: true,
      maxRetries:
        hostOperatingSystem() === 'win32'
          ? WINDOWS_WORKTREE_DIRECTORY_REMOVE_MAX_RETRIES
          : DEFAULT_WORKTREE_DIRECTORY_REMOVE_MAX_RETRIES,
      retryDelay: WORKTREE_DIRECTORY_REMOVE_RETRY_DELAY_MS,
    });
  };
  if (hostOperatingSystem() !== 'linux') {
    await removeDirectory();
    return;
  }
  // An unlink on Linux succeeds while an old writable descriptor survives, so
  // check Canopy-owned writers before removal and again after it.
  await withLinuxWorktreeRemovalVerification(worktreePath, removeDirectory);
}

async function removeTopLevelWorktreeDirectory(
  workspaceId: string,
  worktreeId: string,
  worktreePath: string,
): Promise<void> {
  try {
    await removePhysicalWorktreeDirectory(worktreePath);
    return;
  } catch (nodeRemovalError) {
    if (process.platform !== 'darwin') {
      throw nodeRemovalError;
    }

    // eslint-disable-next-line no-console
    console.warn(
      'Node worktree directory removal failed; trying the macOS native fallback.',
      {
        workspaceId,
        worktreeId,
        worktreePath,
        error: getErrorLogDetails(nodeRemovalError),
      },
    );
    try {
      await removeExactMacosWorktreeDirectory(
        workspaceId,
        worktreeId,
        worktreePath,
      );
      // eslint-disable-next-line no-console
      console.info(
        'Removed worktree directory with the macOS native fallback.',
        {
          workspaceId,
          worktreeId,
          worktreePath,
        },
      );
    } catch (nativeRemovalError) {
      throw combineRemovalErrors(nodeRemovalError, nativeRemovalError);
    }
  }
}

function combineRemovalErrors(
  nodeRemovalError: unknown,
  nativeRemovalError: unknown,
): Error {
  const error = new Error(
    `Node removal failed (${getErrorMessage(
      nodeRemovalError,
    )}); macOS native removal also failed (${getErrorMessage(
      nativeRemovalError,
    )})`,
  );
  Object.assign(error, { cause: nativeRemovalError });
  const nativeDetails = getErrorLogDetails(nativeRemovalError);
  delete nativeDetails.message;
  Object.assign(error, nativeDetails);
  return error;
}

async function removeTopLevelWorktreeDirectoryWithWarning(
  workspaceId: string,
  worktreeId: string,
  worktreePath: string,
): Promise<string[]> {
  try {
    await removeTopLevelWorktreeDirectory(
      workspaceId,
      worktreeId,
      worktreePath,
    );
    return [];
  } catch (error) {
    if (process.platform === 'win32') {
      return [formatWindowsLockedFilesWarning(worktreePath, error)];
    }
    if (hostOperatingSystem() === 'linux') {
      return [formatLinuxResidueWarning(worktreePath, error, false)];
    }
    if (process.platform !== 'darwin') {
      throw normalizeError(error);
    }

    try {
      await queueOrphanedMacosWorktreeDirectory({
        workspaceId,
        worktreeId,
        worktreePath,
        error,
      });
    } catch (queueError) {
      // eslint-disable-next-line no-console
      console.error('Failed to queue orphaned macOS worktree directory.', {
        workspaceId,
        worktreeId,
        worktreePath,
        error: getErrorLogDetails(queueError),
      });
      throw queueError;
    }
    return [
      `macOS left files behind at ${worktreePath}: ${getErrorMessage(error)}`,
    ];
  }
}

async function findPersistedWorktree(
  workspaceId: string,
  worktreeId: string,
): Promise<WorktreeData | null> {
  const worktrees = await readWorkspaceWorktrees(workspaceId, {
    persistRemovalCleanup: false,
  });
  return worktrees.find((worktree) => worktree.id === worktreeId) ?? null;
}

class ReservedWorktreeStorageError extends Error {
  public constructor(
    message: string,
    readonly storageFailure: WorktreeSetupStorageFailure,
  ) {
    super(message);
  }
}

function setupStorageFailure(
  error: unknown,
): WorktreeSetupStorageFailure | undefined {
  if (error instanceof ReservedWorktreeStorageError)
    return error.storageFailure;
  const cause =
    error instanceof WorktreeRegistryUnreadableError ? error.cause : error;
  const named = w5NamedUnreadable(cause);
  if (named instanceof W5RecordOverloadedError) return 'overloaded';
  if (named instanceof W5AuthorityUnreachableError)
    return 'authority-unreachable';
  return named || error instanceof WorktreeRegistryUnreadableError
    ? 'unreadable'
    : undefined;
}

function isSetupStorageUnavailable(error: unknown): boolean {
  return (
    error instanceof ReservedWorktreeStorageError ||
    error instanceof WorktreeRegistryUnreadableError ||
    w5NamedUnreadable(error) !== undefined
  );
}

async function readReservedWorktree(
  ref: WorktreeSetupCancellationRef,
): Promise<WorktreeData | null> {
  const list = await readWorkspaceWorktreesDetailed(ref.workspaceId, {
    persistRemovalCleanup: false,
  });
  if (list.authority !== 'ok') {
    throw new ReservedWorktreeStorageError(
      `Worktree setup failed: worktree storage is ${list.authority}.${
        list.unserved ? ` ${list.unserved.message}` : ''
      }`,
      setupStorageFailure(list.unserved) ?? 'unreadable',
    );
  }
  return (
    list.worktrees.find((worktree) => worktree.id === ref.worktreeId) ?? null
  );
}

async function isReservedWorktreeCurrent(
  ref: WorktreeSetupCancellationRef,
): Promise<boolean> {
  const worktree = await readReservedWorktree(ref);
  return worktree?.createdAt === ref.createdAt;
}

async function shouldContinueReservedSetup(
  ref: WorktreeSetupCancellationRef,
): Promise<boolean> {
  if (isWorktreeSetupCancellationRequested(ref)) {
    return false;
  }

  return isReservedWorktreeCurrent(ref);
}

async function recordCreationPhase(
  ref: WorktreeSetupCancellationRef,
  phase: NonNullable<WorktreeData['creation']>['phase'] | undefined,
  recoveryRequired = false,
  healthIssue?: WorktreeHealthIssue,
): Promise<boolean> {
  return applyReservedWorktreeRecord(ref, {
    kind: 'worktree.create.phase',
    phase,
    recoveryRequired,
    healthIssue,
  });
}

async function removeReservedWorktreeRecordIfCurrent(
  ref: WorktreeSetupCancellationRef,
  remainingWorktreeOrder?: readonly string[],
  expectedRemainingWorktreeOrder?: readonly string[],
): Promise<boolean> {
  return applyReservedWorktreeRemoval(ref, {
    kind: 'worktree.create.reservation.remove',
    remainingWorktreeOrder,
    expectedRemainingWorktreeOrder,
  });
}

async function reserveWorktreeMetadataDir(
  workspaceId: string,
  candidateIds: Set<string>,
): Promise<ReservedWorktree> {
  for (let attempt = 0; attempt < MAX_RESERVATION_ATTEMPTS; attempt += 1) {
    const id = generateUniqueAnimalName(candidateIds);
    const metadataDir = getWorktreeDataDir(workspaceId, id);
    await mkdir(dirname(metadataDir), { recursive: true });
    try {
      await mkdir(metadataDir, { recursive: false });
      return { id, metadataDir };
    } catch (error) {
      if (isNodeErrorCode(error, 'EEXIST')) {
        candidateIds.add(id);
        continue;
      }
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  throw new Error('Failed to reserve a unique worktree id after 8 attempts');
}

/** Whether the reserved id was already listed, so nothing was written. */
async function stageWorktreeCreationReservation(
  workspaceId: string,
  decision: WorktreeCreationReservationDecision,
  expectedRevision: number | undefined,
): Promise<boolean> {
  const reserved = await applyWorktreeCreationReservation(
    workspaceId,
    decision,
    { expectedRevision },
  );
  return reserved.status === 'collision';
}

async function reserveAndPersistWorktree(
  workspaceId: string,
  existingWorktreeIds: string[] | undefined,
  buildWorktree: (id: string) => WorktreeData,
  isCandidateUsable?: (id: string) => Promise<boolean>,
  sidebarItemGroupId?: string,
  expectedRevision?: number,
  keyed?: CreateWorktreeServiceOptions['w5KeyedCreation'],
  boundaryCommit?: W5CommitOptions,
  boundaryAttempt?: W5KeyedAttempt,
): Promise<PersistedReservation> {
  const persistedWorktrees = existingWorktreeIds
    ? []
    : await readWorkspaceWorktrees(
        workspaceId,
        boundaryCommit?.expectedRevisions || boundaryCommit?.beforeDecision
          ? { persistRemovalCleanup: false }
          : undefined,
      );
  const candidateIds = new Set(
    existingWorktreeIds ?? persistedWorktrees.map((worktree) => worktree.id),
  );
  for (const id of Array.from(await collectReservedWorktreeIds(workspaceId))) {
    candidateIds.add(id);
  }

  for (let attempt = 0; attempt < MAX_RESERVATION_ATTEMPTS; attempt += 1) {
    keyed?.attempt.beforeEffects();
    boundaryAttempt?.beforeEffects();
    const reservation = await reserveWorktreeMetadataDir(
      workspaceId,
      candidateIds,
    );
    if (isCandidateUsable) {
      let usable = false;
      try {
        usable = await isCandidateUsable(reservation.id);
      } catch (error) {
        await rm(reservation.metadataDir, { recursive: true, force: true });
        throw error;
      }
      if (!usable) {
        await rm(reservation.metadataDir, { recursive: true, force: true });
        candidateIds.add(reservation.id);
        continue;
      }
    }

    const worktree = buildWorktree(reservation.id);
    if (worktree.creation) {
      for (const checkout of worktree.creation.checkouts) {
        // A metadata reservation proves nothing about an existing checkout.
        const exists = await lstat(checkout.checkoutPath).then(
          () => true,
          (error: unknown) => {
            if (isNodeErrorCode(error, 'ENOENT')) return false;
            throw error;
          },
        );
        if (
          exists ||
          (await isRegisteredWorktreePath(
            checkout.repositoryPath,
            checkout.checkoutPath,
          ))
        ) {
          await rm(reservation.metadataDir, { recursive: true, force: true });
          refuseWorktreeCreation(
            'checkout-reserved',
            `Checkout path "${checkout.checkoutPath}" is already in use`,
          );
        }
      }
    }
    let collision = false;

    try {
      await commitW5BoundaryStep(
        boundaryCommit,
        boundaryCommit ? w5CompositionLocks({ lists: [workspaceId] }) : [],
        async () => {
          collision = await stageWorktreeCreationReservation(
            workspaceId,
            { kind: 'worktree.create.reserve', worktree, sidebarItemGroupId },
            expectedRevision,
          );
        },
      );
    } catch (error) {
      if (keyed) throw error;
      // Reconciliation can fail after the row is durable. Only remove the
      // reservation when an authoritative read confirms it is unregistered.
      let unregistered = false;
      try {
        const current = await readWorkspaceWorktreesDetailed(workspaceId);
        // A partial read leaves out rows it cannot read, which could be
        // this reservation's.
        unregistered =
          (current.authority === 'ok' || current.authority === 'absent') &&
          !current.worktrees.some((entry) => entry.id === reservation.id);
      } catch {
        // Unknown registry state must retain potentially registered metadata.
      }
      if (unregistered)
        await rm(reservation.metadataDir, { recursive: true, force: true });
      throw error;
    }

    if (!collision) {
      return {
        id: reservation.id,
        metadataDir: reservation.metadataDir,
        worktree,
      };
    }

    await rm(reservation.metadataDir, { recursive: true, force: true });
    candidateIds.add(reservation.id);
  }

  throw new Error('Failed to reserve a unique worktree id after 8 attempts');
}

async function collectReservedWorktreeIds(
  workspaceId: string,
): Promise<Set<string>> {
  const ids = await listCompatibilitySymlinkReservedWorktreeIds(workspaceId);
  for (const root of [
    getWorkspaceWorktreesRootDir(workspaceId),
    getWorktreeDataRootDir(workspaceId),
    getArchivedContainersRootDir(workspaceId),
  ]) {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        ids.add(entry.name);
        // CAN-5334 Q7: a checkout quarantine, or a target an interrupted
        // discard moved aside, still belongs to its worktree.
        const owned =
          /^\.(.+)\.(?:archive-quarantine|discard-aside-[a-z-]+)$/.exec(
            entry.name,
          );
        if (owned) ids.add(owned[1]);
      }
    } catch {
      // Directory may not exist yet.
    }
  }
  // CAN-5334 Q7: an unfinished journal would block a new worktree with its id
  // and could then never resume.
  for (const id of Array.from(
    await listUnfinishedDestructiveWorktreeIds(workspaceId),
  ))
    ids.add(id);
  return ids;
}

async function readArchivePreferences(): Promise<
  Awaited<ReturnType<typeof readPreferencesFile>>
> {
  return readPreferencesFile();
}

function resolveArchiveBranchDeleter(
  deleteBranchChoice: boolean | undefined,
  deleteFullyMergedByDefault: boolean,
): typeof deleteBranch | null {
  if (deleteBranchChoice === true) return forceDeleteBranch;
  if (deleteBranchChoice === false || !deleteFullyMergedByDefault) return null;
  return deleteBranch;
}

function resolveArchiveBranchDeletionMode(
  deleteBranchChoice: boolean | undefined,
  deleteFullyMergedByDefault: boolean,
): ArchivedContainerBranchDeletionMode | undefined {
  if (deleteBranchChoice === true) return 'force';
  if (deleteBranchChoice === false || !deleteFullyMergedByDefault) {
    return undefined;
  }
  return 'merged-only';
}

// Only warnings that identify unfinished destructive work keep a completed
// archive in cleanup-required state. Branch preservation, tolerated residue,
// archive indexing and other informational diagnostics are retry-safe.
/**
 * Runs removal work whose own failure the caller handles. Returns that
 * failure; a lifecycle refusal or journal failure propagates instead, so it
 * can never fall through to a fallback removal.
 */
async function tolerateRemovalWork(
  phase: DestructivePhase,
  work: () => Promise<void>,
): Promise<unknown> {
  let workError: unknown;
  let workFailed = false;
  try {
    await destructiveStep(
      phase,
      async () => {
        try {
          await work();
        } catch (error) {
          workFailed = true;
          workError = error;
          throw error;
        }
      },
      { bestEffort: true },
    );
  } catch (error) {
    if (!workFailed) throw error;
  }
  return workFailed ? workError : undefined;
}

export function warningRequiresDestructiveCleanup(warning: string): boolean {
  return (
    warning ===
    'Failed to remove persisted turn diff tree refs for this worktree.'
  );
}

async function deleteArchivedBranch(
  branchDeleter: typeof deleteBranch,
  repoPath: string,
  branchName: string,
  propagateFailure: boolean,
): Promise<void> {
  if (!(await doesLocalBranchExist(repoPath, branchName))) {
    return;
  }
  try {
    await destructiveStep(
      'branch-delete-ref',
      () => branchDeleter(repoPath, branchName),
      { bestEffort: !propagateFailure },
    );
  } catch (error) {
    if (propagateFailure) throw error;
  }
}

async function deletePendingArchivedBranches(
  pendingBranchDeletions: readonly {
    referenceRepoPath: string;
    repositoryIdentity: string;
    branchName: string;
    expectedTip: string;
  }[],
  branchDeletionMode: ArchivedContainerBranchDeletionMode = 'force',
): Promise<void> {
  for (const deletion of pendingBranchDeletions) {
    const repositoryIdentity = await getGitCommonDir(
      deletion.referenceRepoPath,
    );
    if (repositoryIdentity !== deletion.repositoryIdentity) {
      throw new Error(
        `Cannot safely delete local branch "${deletion.branchName}" because its repository no longer matches the pending deletion repository.`,
      );
    }
    if (
      !(await doesLocalBranchExist(
        deletion.referenceRepoPath,
        deletion.branchName,
      ))
    ) {
      continue;
    }
    if (
      branchDeletionMode === 'merged-only' &&
      !(await isAncestor(
        deletion.referenceRepoPath,
        deletion.expectedTip,
        'HEAD',
      ))
    ) {
      continue;
    }
    await destructiveCall(
      'branch-delete-ref',
      deleteBranchIfMatches,
      deletion.referenceRepoPath,
      deletion.branchName,
      deletion.expectedTip,
    );
  }
}

async function removeMetadataDirIfReservationIsStale(
  ref: WorktreeSetupCancellationRef,
  metadataDir: string,
): Promise<void> {
  if (await isReservedWorktreeCurrent(ref)) {
    return;
  }

  await rm(metadataDir, { recursive: true, force: true }).catch(() => {});
}

async function isSupersededByReusedWorktreeId(
  ref: WorktreeSetupCancellationRef,
): Promise<boolean> {
  const worktree = await readReservedWorktree(ref);
  return worktree !== null && worktree.createdAt !== ref.createdAt;
}

async function cleanupCancelledSingleRepoSetup(options: {
  setupRef: WorktreeSetupCancellationRef;
  referenceRepoPath: string;
  worktreePath: string;
  metadataDir: string;
  createdBranchName: string | null;
}): Promise<void> {
  if (await isSupersededByReusedWorktreeId(options.setupRef)) {
    return;
  }

  await safeRemoveWorktree(options.referenceRepoPath, options.worktreePath, {
    workspaceId: options.setupRef.workspaceId,
    worktreeId: options.setupRef.worktreeId,
  }).catch(() => {});

  if (options.createdBranchName) {
    const prefs = await readArchivePreferences().catch(() => null);
    if (prefs?.deleteBranchOnArchive === true) {
      await deleteBranch(
        options.referenceRepoPath,
        options.createdBranchName,
      ).catch(() => {});
    }
  }

  await removeMetadataDirIfReservationIsStale(
    options.setupRef,
    options.metadataDir,
  );
}

async function cleanupCancelledMultiRepoSetup(options: {
  setupRef: WorktreeSetupCancellationRef;
  workspaceId: string;
  worktreeId: string;
  referenceRepoPath: string | undefined;
  rootWorktreePath: string;
  metadataDir: string;
  repos: WorkspaceRepoData[];
  createdRepoBranches: Map<string, string>;
  rootBranchName: string | null;
}): Promise<void> {
  if (await isSupersededByReusedWorktreeId(options.setupRef)) {
    return;
  }

  await settleEach(
    options.repos.map(async (repo) => {
      const repoWorktreePath = getWorkspaceWorktreeRepoDir(
        options.workspaceId,
        options.worktreeId,
        repo.id,
      );
      await safeRemoveWorktree(repo.repoPath, repoWorktreePath, {
        workspaceId: options.workspaceId,
        worktreeId: options.worktreeId,
        repoId: repo.id,
      });
    }),
  );

  if (options.referenceRepoPath) {
    await safeRemoveWorktree(
      options.referenceRepoPath,
      options.rootWorktreePath,
      {
        workspaceId: options.workspaceId,
        worktreeId: options.worktreeId,
      },
    ).catch(() => {});
  }

  await removePhysicalWorktreeDirectory(
    getWorkspaceWorktreeDir(options.workspaceId, options.worktreeId),
  ).catch(() => {});

  const prefs = await readArchivePreferences().catch(() => null);
  if (prefs?.deleteBranchOnArchive === true) {
    await settleEach(
      options.repos.map(async (repo) => {
        const branchName = options.createdRepoBranches.get(repo.id);
        if (branchName) {
          await deleteBranch(repo.repoPath, branchName);
        }
      }),
    );
    if (options.referenceRepoPath && options.rootBranchName) {
      await deleteBranch(
        options.referenceRepoPath,
        options.rootBranchName,
      ).catch(() => {});
    }
  }

  await removeMetadataDirIfReservationIsStale(
    options.setupRef,
    options.metadataDir,
  );
}

export async function rollbackPersistedReservation(
  workspaceId: string,
  worktreeId: string,
  metadataDir: string,
  commitRemoval?: (remove: () => Promise<boolean>) => Promise<boolean>,
): Promise<void> {
  const remove = (): Promise<boolean> =>
    removeWorktreeRecord(workspaceId, worktreeId);
  const [removed] = await settleEach([
    commitRemoval ? commitRemoval(remove) : remove(),
    rm(metadataDir, { recursive: true, force: true }),
  ]);
  // The old rollback settles both effects. A keyed outcome must also know its
  // receipt decision succeeded; otherwise retain the uncertain reservation.
  if (commitRemoval && removed.status === 'rejected') throw removed.reason;
}

function normalizeRequestedBranch(
  branchName: string | undefined,
): string | null {
  if (branchName === undefined) {
    return null;
  }
  if (!branchName || branchName.startsWith('-')) {
    throw new Error('Branch name must be a non-empty value');
  }
  return branchName;
}

const GIT_OBJECT_ID_RE = /^[0-9a-f]{40,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function normalizePendingArchiveBranchDeletion(
  value: unknown,
): Promise<
  NonNullable<WorktreeData['pendingArchiveBranchDeletion']> | undefined
> {
  if (!isRecord(value)) return undefined;
  const referenceRepoPath =
    typeof value.referenceRepoPath === 'string'
      ? value.referenceRepoPath.trim()
      : '';
  const repositoryIdentity =
    typeof value.repositoryIdentity === 'string'
      ? value.repositoryIdentity.trim()
      : '';
  const branchName =
    typeof value.branchName === 'string' ? value.branchName : '';
  const expectedTip =
    typeof value.expectedTip === 'string'
      ? value.expectedTip.trim().toLowerCase()
      : '';
  if (
    !isAbsolute(referenceRepoPath) ||
    !isAbsolute(repositoryIdentity) ||
    !branchName ||
    branchName === 'HEAD' ||
    !GIT_OBJECT_ID_RE.test(expectedTip) ||
    !(await validateBranchName(referenceRepoPath, branchName))
  ) {
    return undefined;
  }
  return {
    referenceRepoPath,
    repositoryIdentity,
    branchName,
    expectedTip,
  };
}

async function normalizePendingArchiveBranchDeletions(
  value: unknown,
): Promise<NonNullable<WorktreeData['pendingArchiveBranchDeletions']>> {
  if (!Array.isArray(value)) return [];
  const normalized: NonNullable<WorktreeData['pendingArchiveBranchDeletions']> =
    [];
  for (const candidate of value) {
    if (!isRecord(candidate)) continue;
    const repoId =
      typeof candidate.repoId === 'string' ? candidate.repoId.trim() : '';
    const referenceRepoPath =
      typeof candidate.referenceRepoPath === 'string'
        ? candidate.referenceRepoPath.trim()
        : '';
    if (!repoId || !isAbsolute(referenceRepoPath)) continue;
    try {
      if (repoId !== WORKSPACE_ROOT_REPO_ID) {
        validateId(repoId, 'repository ID');
      }
    } catch {
      continue;
    }
    const deletion = await normalizePendingArchiveBranchDeletion(candidate);
    if (!deletion) continue;
    normalized.push({ repoId, ...deletion });
  }
  return normalized;
}

/**
 * A typed base-selection refusal. Only errors deliberately constructed by these
 * read-only validators are releasable.
 */
function worktreeValidationError(
  reason: WorktreeCreationRefusal,
  message: string,
  attempt?: W5KeyedAttempt,
): Error {
  const error = new WorktreeCreationRefusedError(reason, message);
  return attempt?.validationError(error) ?? error;
}

async function ensureBranchCanBeCreated(
  repoPaths: readonly string[],
  branchName: string,
  attempt?: W5KeyedAttempt,
): Promise<void> {
  try {
    for (const repoPath of repoPaths) {
      const valid = await validateBranchName(repoPath, branchName);
      if (!valid) {
        throw new WorktreeCreationRefusedError(
          'invalid-branch-name',
          `Invalid branch name: "${branchName}"`,
        );
      }
      const available = await isBranchNameAvailable(repoPath, branchName);
      if (!available) {
        throw new WorktreeCreationRefusedError(
          'branch-reserved',
          `Branch name "${branchName}" is already in use`,
        );
      }
    }
  } catch (error) {
    // These Git probes are read-only. Preserve their actionable failure while
    // allowing the owning keyed attempt to release its pre-effect reservation.
    throw attempt?.validationError(normalizeError(error)) ?? error;
  }
}

async function ensureExistingBranchIsUsable(
  repoPath: string,
  branchName: string,
  attempt?: W5KeyedAttempt,
): Promise<void> {
  attempt?.beforeEffects();
  // The caller is still waiting to leave its composer, so a credential prompt
  // or stalled remote must not hold creation open. The signal also bounds an
  // in-flight fetch this call joins. A failed fetch falls back to the local
  // and remote-tracking refs already present.
  let originRefreshed = true;
  try {
    await fetchOrigin(repoPath, {
      nonInteractive: true,
      timeoutMs: WORKTREE_GIT_TIMEOUT_MS,
      signal: AbortSignal.timeout(WORKTREE_GIT_TIMEOUT_MS),
    });
  } catch {
    originRefreshed = false;
  }
  const [localExists, remoteExists] = await settleAll([
    doesLocalBranchExist(repoPath, branchName),
    doesRemoteBranchExist(repoPath, branchName),
  ]);
  if (!localExists && !remoteExists) {
    throw new WorktreeCreationRefusedError(
      'branch-not-found',
      originRefreshed
        ? `Branch "${branchName}" was not found`
        : `Branch "${branchName}" was not found, and origin could not be refreshed`,
    );
  }
  const checkedOut = await listCheckedOutBranches(repoPath);
  const usedAt = checkedOut.get(branchName);
  if (usedAt) {
    throw new WorktreeCreationRefusedError(
      'branch-checked-out',
      `Branch "${branchName}" is already checked out at ${usedAt}`,
      { checkoutPath: usedAt },
    );
  }
}

async function resolveSuggestedBranchExists(
  repoPath: string,
  branchName: string,
  options?: { backgroundPriority?: boolean },
): Promise<boolean> {
  if (options) {
    await fetchOrigin(repoPath, options);
  } else {
    await fetchOrigin(repoPath);
  }
  const [localExists, remoteExists] = await settleAll([
    doesLocalBranchExist(repoPath, branchName),
    doesRemoteBranchExist(repoPath, branchName),
  ]);
  if (!localExists && !remoteExists) {
    return false;
  }
  const checkedOut = await listCheckedOutBranches(repoPath);
  const usedAt = checkedOut.get(branchName);
  if (usedAt) {
    throw new Error(
      `Branch "${branchName}" is already checked out at ${usedAt}`,
    );
  }
  return true;
}

async function isBranchNameAvailableInAllRepos(
  repoPaths: readonly string[],
  branchName: string,
): Promise<boolean> {
  const results = await settleAll(
    repoPaths.map((repoPath) => isBranchNameAvailable(repoPath, branchName)),
  );
  return results.every(Boolean);
}

function usesExactBaseBranch(options: CreateWorktreeServiceOptions): boolean {
  return (
    options.baseBranchResolution === 'exact-branch' ||
    (options.baseBranch !== undefined &&
      isExplicitWorktreeBaseBranch(options.baseBranch))
  );
}

async function resolveExactBaseBranch(
  repoPath: string,
  baseBranch: string,
  allowNetwork: boolean,
  attempt?: W5KeyedAttempt,
): Promise<BaseBranchResolution> {
  const target = decodeWorktreeBaseBranch(baseBranch);
  if (target) {
    if (target.isRemote && allowNetwork) {
      attempt?.beforeEffects();
      await fetchOrigin(repoPath);
    }
    const trackedBranch = target.branchName;
    const ref = target.isRemote
      ? `refs/remotes/origin/${trackedBranch}`
      : `refs/heads/${trackedBranch}`;
    const commit = await resolveExactRefSha(repoPath, ref).catch(
      () => undefined,
    );
    if (commit && GIT_OBJECT_ID_RE.test(commit)) {
      // The suffix makes Git parse a commit instead of preferring a branch
      // whose name happens to be the same hexadecimal object ID.
      return {
        trackedBranch,
        startPoint: `${commit}^{commit}`,
        trackingRef: ref,
      };
    }
  }
  throw worktreeValidationError(
    'base-not-found',
    `Base branch "${baseBranch}" was not found`,
    attempt,
  );
}

async function resolveBaseBranch(
  repoPath: string,
  baseBranch: string,
  allowNetwork = true,
  attempt?: W5KeyedAttempt,
): Promise<BaseBranchResolution> {
  if (!baseBranch) {
    throw worktreeValidationError(
      'base-not-found',
      'Base branch must be a non-empty value',
      attempt,
    );
  }

  // Internal restore and shared-container callers can name an exact published
  // commit instead of a movable branch. Prefer the local object already copied
  // with a replica; existing workspaces get one ordinary origin fetch before
  // falling back to branch resolution for valid 40-hex branch names.
  let fetchedOrigin = false;
  if (/^[a-fA-F0-9]{40}$/.test(baseBranch)) {
    let available = await hasLocalCommit(repoPath, baseBranch);
    if (!available && allowNetwork) {
      attempt?.beforeEffects();
      await fetchOrigin(repoPath);
      fetchedOrigin = true;
      available = await hasLocalCommit(repoPath, baseBranch);
    }
    if (available) {
      return { trackedBranch: baseBranch, startPoint: baseBranch };
    }
  }

  if (baseBranch.startsWith('origin/')) {
    const trackedBranch = baseBranch.slice('origin/'.length);
    if (allowNetwork && !fetchedOrigin) {
      attempt?.beforeEffects();
      await fetchOrigin(repoPath);
    }
    if (!(await doesRemoteBranchExist(repoPath, trackedBranch))) {
      throw worktreeValidationError(
        'base-not-found',
        `Base branch "${baseBranch}" was not found`,
        attempt,
      );
    }
    return {
      trackedBranch,
      startPoint: `refs/remotes/origin/${trackedBranch}`,
    };
  }

  if (baseBranch.startsWith('refs/')) {
    // Legacy callers can name a local branch whose name itself starts with
    // refs/. Resolve the actual local ref before treating the input as a revision.
    const startPoint = await resolveExactRefStartPoint(
      repoPath,
      `refs/heads/${baseBranch}`,
    ).catch(() => undefined);
    if (startPoint) {
      return { trackedBranch: baseBranch, startPoint };
    }
  } else if (await doesLocalBranchExist(repoPath, baseBranch)) {
    return {
      trackedBranch: baseBranch,
      startPoint: `refs/heads/${baseBranch}`,
    };
  }
  if (allowNetwork && !fetchedOrigin) {
    attempt?.beforeEffects();
    await fetchOrigin(repoPath);
  }
  if (await doesRemoteBranchExist(repoPath, baseBranch)) {
    return {
      trackedBranch: baseBranch,
      startPoint: `refs/remotes/origin/${baseBranch}`,
    };
  }
  // A tag or abbreviated commit, which `git worktree add` accepts as a start
  // point. Peeled to its commit so the start point can't move; a leading `-`
  // would be read as an option.
  if (!baseBranch.startsWith('-')) {
    const commit = await resolveRefSha(
      repoPath,
      `${baseBranch}^{commit}`,
    ).catch(() => undefined);
    if (commit && GIT_OBJECT_ID_RE.test(commit)) {
      return { trackedBranch: baseBranch, startPoint: commit };
    }
  }
  throw worktreeValidationError(
    'base-not-found',
    `Base branch "${baseBranch}" was not found`,
    attempt,
  );
}

async function resolveQualifiedBaseBranch(
  repoPath: string,
  ref: string,
  allowNetwork: boolean,
  attempt?: W5KeyedAttempt,
): Promise<BaseBranchResolution> {
  const localPrefix = 'refs/heads/';
  const remotePrefix = 'refs/remotes/origin/';
  const prefix = ref.startsWith(localPrefix)
    ? localPrefix
    : ref.startsWith(remotePrefix)
      ? remotePrefix
      : undefined;
  if (prefix) {
    if (prefix === remotePrefix && allowNetwork) {
      attempt?.beforeEffects();
      await fetchOrigin(repoPath);
    }
    const startPoint = await resolveExactRefStartPoint(repoPath, ref).catch(
      () => undefined,
    );
    if (startPoint) {
      return { trackedBranch: ref.slice(prefix.length), startPoint };
    }
  }
  throw worktreeValidationError(
    'base-not-found',
    `Base branch "${ref}" was not found`,
    attempt,
  );
}

function requireUsableBranchName(
  branchName: string,
  context: string,
  attempt?: W5KeyedAttempt,
): string {
  if (!branchName || branchName === 'HEAD') {
    throw worktreeValidationError(
      'base-task-detached',
      `Cannot determine a branch name for ${context}`,
      attempt,
    );
  }

  return branchName;
}

async function resolveCreateWorktreeScripts(
  project: Parameters<typeof resolveProjectScripts>[0],
  worktreePath: string,
): Promise<Awaited<ReturnType<typeof resolveProjectScripts>>> {
  try {
    return await resolveProjectScripts(project, worktreePath);
  } catch {
    return {};
  }
}

async function resolveCreateWorktreeHooks(
  project: Parameters<typeof resolveProjectHooks>[0],
  worktreePath: string,
): Promise<Awaited<ReturnType<typeof resolveProjectHooks>>> {
  try {
    return await resolveProjectHooks(project, worktreePath);
  } catch {
    return {};
  }
}

async function resolveSingleRepoWorktreeEffective(
  project: Parameters<typeof resolveProjectScripts>[0] &
    Parameters<typeof resolveProjectHooks>[0],
  worktreePath: string,
): Promise<WorktreeEffectiveOverrides> {
  const [resolvedScripts, resolvedHooks] = await settleAll([
    resolveCreateWorktreeScripts(project, worktreePath),
    resolveCreateWorktreeHooks(project, worktreePath),
  ]);

  return {
    effectiveScripts: toScriptOverrides(resolvedScripts),
    effectiveHooks: toHookOverrides(resolvedHooks),
  };
}

async function resolveWorkspaceWorktreeEffective(
  workspaceId: string,
  worktreeId: string,
  workspaceRootPath: string,
  repos: WorkspaceRepoData[],
): Promise<WorktreeEffectiveOverrides> {
  const [resolvedScripts, resolvedHooks] = await settleAll([
    resolveWorkspaceRootScripts(workspaceId, { workspaceRootPath }).catch(
      () => ({}),
    ),
    resolveWorkspaceRootHooks(workspaceId, { workspaceRootPath }).catch(
      () => ({}),
    ),
  ]);

  const repoEntries = await mapWithConcurrency(
    repos,
    WORKTREE_EFFECTIVE_REPO_CONCURRENCY,
    async (repo) => {
      const repoPath = getWorkspaceWorktreeRepoDir(
        workspaceId,
        worktreeId,
        repo.id,
      );
      const paths = { workspaceRootPath, repoPath };
      const [repoScripts, repoHooks] = await settleAll([
        resolveWorkspaceRepoScripts(workspaceId, repo.id, paths).catch(
          () => ({}),
        ),
        resolveWorkspaceRepoHooks(workspaceId, repo.id, paths).catch(
          () => ({}),
        ),
      ]);

      return {
        repoId: repo.id,
        effectiveScripts: toScriptOverrides(repoScripts),
        effectiveHooks: toHookOverrides(repoHooks),
      };
    },
  );

  const repoEffective: NonNullable<WorktreeEffectiveOverrides['repos']> = {};
  for (const entry of repoEntries) {
    repoEffective[entry.repoId] = {
      effectiveScripts: entry.effectiveScripts,
      effectiveHooks: entry.effectiveHooks,
    };
  }

  return {
    effectiveScripts: toScriptOverrides(resolvedScripts),
    effectiveHooks: toHookOverrides(resolvedHooks),
    repos: repoEffective,
  };
}

/**
 * Cheap, shadow-free workspace lookup for worktree-service flows.
 *
 * This must NOT route through `listWorkspaceItems`/`readAllSidebarItems`: the
 * full sidebar read resolves baseline scripts/hooks/manifests, which for
 * source-backed workspaces goes through `ensureRepoShadow` — a per-repo lock
 * that can be network-bound (stale shadow refresh) or backed up behind other
 * baseline readers. Callers here sit on latency-sensitive paths (worktree
 * creation phase A, the diff-stats batch, archive/repair), and blocking them
 * on the shadow lock froze the Home composer's new-worktree send for ~10s+ on
 * real workspaces. The assembled item carries the identity, repo list, and
 * persisted worktree rows those callers use — none of the resolved
 * script/hook enrichment (`effectiveScripts`, `worktreeEffective`, ...) the
 * full sidebar read adds. See docs/repo-shadow.md ("Latency invariant").
 */
async function getWorkspaceById(
  workspaceId: string,
  readOnly = false,
  metadata?: PreparedW5Metadata,
): Promise<SingleRepoSidebarItem | MultiRepoSidebarItem> {
  validateId(workspaceId, 'workspaceId');
  const indexEntry = metadata
    ? (await consumeW5Metadata(metadata.index)).entries.find(
        (entry) => entry.id === workspaceId,
      )
    : await readWorkspaceIndexEntry(workspaceId);
  if (!indexEntry) {
    throw new Error(`Project ${workspaceId} not found`);
  }
  if (indexEntry.type === 'cowork') {
    throw new Error(
      `Project ${workspaceId} is a cowork project and has no git worktrees`,
    );
  }
  const [effectiveConfig, worktrees] = await settleAll([
    metadata
      ? consumeW5Metadata(metadata.manifest(workspaceId)).then(({ config }) =>
          readEffectiveWorkspaceConfig(workspaceId, config),
        )
      : readEffectiveWorkspaceConfig(workspaceId),
    metadata
      ? readPreparedW5Worktrees(metadata, workspaceId).then(
          ({ worktrees }) => worktrees,
        )
      : readOnly
        ? readWorkspaceWorktrees(workspaceId, { persistRemovalCleanup: false })
        : readWorkspaceWorktrees(workspaceId),
  ]);

  if (indexEntry.type === 'single-repo') {
    const repoPath = effectiveConfig.localConfig.repoPath;
    if (!repoPath) {
      throw new Error(
        `Project ${workspaceId} is a single-repo project without a repoPath`,
      );
    }
    return {
      type: 'single-repo',
      id: indexEntry.id,
      name: indexEntry.name,
      color: indexEntry.color,
      collapsed: indexEntry.collapsed,
      order: indexEntry.order,
      repoPath,
      worktrees,
      ...(effectiveConfig.alwaysShow !== undefined
        ? { alwaysShow: effectiveConfig.alwaysShow }
        : {}),
    };
  }

  return {
    type: 'multi-repo',
    id: indexEntry.id,
    name: indexEntry.name,
    color: indexEntry.color,
    collapsed: indexEntry.collapsed,
    order: indexEntry.order,
    repos: effectiveConfig.repos,
    worktrees,
    ...(effectiveConfig.sourceRepoPath !== undefined
      ? { sourceRepoPath: effectiveConfig.sourceRepoPath }
      : {}),
    ...(effectiveConfig.suppressedRepoIds !== undefined
      ? { suppressedRepoIds: effectiveConfig.suppressedRepoIds }
      : {}),
    ...(effectiveConfig.alwaysShow !== undefined
      ? { alwaysShow: effectiveConfig.alwaysShow }
      : {}),
    ...(effectiveConfig.temporary !== undefined
      ? { temporary: effectiveConfig.temporary }
      : {}),
    ...(effectiveConfig.temporarySourceWorkspaceIds !== undefined
      ? {
          temporarySourceWorkspaceIds:
            effectiveConfig.temporarySourceWorkspaceIds,
        }
      : {}),
    ...(effectiveConfig.temporaryRepoIdentityKeys !== undefined
      ? {
          temporaryRepoIdentityKeys: effectiveConfig.temporaryRepoIdentityKeys,
        }
      : {}),
  };
}

async function getStatsWorkspaceById(
  workspaceId: string,
): Promise<SingleRepoSidebarItem | MultiRepoSidebarItem> {
  validateId(workspaceId, 'workspaceId');
  const metadata = await prepareW5Metadata({ kind: 'targeted', workspaceId });
  if (metadata.status === 'fallback') return getWorkspaceById(workspaceId);
  try {
    return await getWorkspaceById(workspaceId, false, metadata);
  } finally {
    await metadata.join();
    metadata.close();
  }
}

function repoLabelFromPath(repoPath: string | undefined): string {
  return repoPath ? basename(repoPath) : 'Repository';
}

export async function buildUsageRepoScopes(
  workspaceId: string,
  worktreeId: string,
  config: WorkspaceConfigFile,
): Promise<UsageRepoScope[]> {
  const workspace = await getWorkspaceById(workspaceId).catch(() => null);
  const workspaceLabel = workspace?.name ?? workspaceId;
  if (config.type === 'single-repo') {
    return [
      {
        workspaceId,
        workspaceLabel,
        worktreeId,
        repoId: SINGLE_REPO_USAGE_REPO_ID,
        repoLabel: repoLabelFromPath(config.repoPath),
        repoPath: getWorktreeDir(workspaceId, worktreeId),
      },
    ];
  }

  const repos: UsageRepoScope[] = [];
  if (config.sourceRepoPath) {
    repos.push({
      workspaceId,
      workspaceLabel,
      worktreeId,
      repoId: WORKSPACE_ROOT_REPO_ID,
      repoLabel: WORKSPACE_ROOT_REPO_NAME,
      repoPath: getWorkspaceWorktreeRootRepoDir(workspaceId, worktreeId),
    });
  }
  for (const repo of config.repos) {
    repos.push({
      workspaceId,
      workspaceLabel,
      worktreeId,
      repoId: repo.id,
      repoLabel: repo.name,
      repoPath: getWorkspaceWorktreeRepoDir(workspaceId, worktreeId, repo.id),
    });
  }
  return repos;
}

async function captureRepoDeletionUsageSnapshot(
  scope: UsageRepoScope,
): Promise<WorktreeDeletedUsageEvent['repos'][number]> {
  const repoPath = scope.repoPath;
  if (!repoPath) {
    return {
      ...scope,
      hadChanges: false,
      insertions: 0,
      deletions: 0,
      hasUncommittedChanges: false,
      hasCommitsAhead: false,
    };
  }
  const effectiveBaseBranch = await resolveEffectiveBaseBranchForRepo({
    projectId: scope.workspaceId,
    worktreeId: scope.worktreeId ?? '',
    repoId: scope.repoId,
    repoPath,
  }).catch(() => ({ branch: null }));
  const [stats, uncommitted, commitsAhead] = await settleAll([
    getDiffStats(repoPath, effectiveBaseBranch.branch ?? undefined).catch(
      () => ({ insertions: 0, deletions: 0 }),
    ),
    hasUncommittedChanges(repoPath).catch(() => false),
    hasCommitsAhead(repoPath, effectiveBaseBranch.branch ?? undefined).catch(
      () => false,
    ),
  ]);
  const hadChanges =
    uncommitted || commitsAhead || stats.insertions > 0 || stats.deletions > 0;
  return {
    ...scope,
    hadChanges,
    insertions: stats.insertions,
    deletions: stats.deletions,
    hasUncommittedChanges: uncommitted,
    hasCommitsAhead: commitsAhead,
  };
}

export async function captureWorktreeDeletionUsageSnapshot(
  workspaceId: string,
  worktreeId: string,
  config: WorkspaceConfigFile,
): Promise<WorktreeDeletedUsageEvent['repos']> {
  const scopes = await buildUsageRepoScopes(workspaceId, worktreeId, config);
  return settleAll(
    scopes.map((scope) => captureRepoDeletionUsageSnapshot(scope)),
  );
}

async function recordWorktreeCreatedUsageEvent(
  workspaceId: string,
  worktreeId: string,
  createdAt: string,
  config: WorkspaceConfigFile,
): Promise<void> {
  const timestamp = new Date().toISOString();
  const repos = await buildUsageRepoScopes(workspaceId, worktreeId, config);
  getExecutionObservabilityIngest().recordUsageMetricEvent({
    version: 1,
    id: `worktree-created:${workspaceId}/${worktreeId}:${timestamp}`,
    type: 'worktree_created',
    timestamp,
    workspaceId,
    workspaceLabel: repos[0]?.workspaceLabel,
    worktreeId,
    worktreeCreatedAt: createdAt,
    repos,
  });
}

function recordWorktreeDeletedUsageEvent(
  workspaceId: string,
  worktreeId: string,
  createdAt: string | undefined,
  repos: WorktreeDeletedUsageEvent['repos'],
): void {
  const timestamp = new Date().toISOString();
  const createdAtTime = createdAt ? Date.parse(createdAt) : Number.NaN;
  getExecutionObservabilityIngest().recordUsageMetricEvent({
    version: 1,
    id: `worktree-deleted:${workspaceId}/${worktreeId}:${timestamp}`,
    type: 'worktree_deleted',
    timestamp,
    workspaceId,
    workspaceLabel: repos[0]?.workspaceLabel,
    worktreeId,
    deletedWithChanges: repos.some((repo) => repo.hadChanges),
    ...(Number.isFinite(createdAtTime)
      ? { worktreeAgeMs: Math.max(0, Date.parse(timestamp) - createdAtTime) }
      : {}),
    repos,
  });
}

function recordCompletedWorktreeDeletionUsage(options: {
  workspaceId: string;
  worktreeId: string;
  createdAt: string | undefined;
  repos: WorktreeDeletedUsageEvent['repos'];
}): void {
  try {
    recordWorktreeDeletedUsageEvent(
      options.workspaceId,
      options.worktreeId,
      options.createdAt,
      options.repos,
    );
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('Failed to record completed worktree deletion usage.', {
      workspaceId: options.workspaceId,
      worktreeId: options.worktreeId,
      error: getErrorLogDetails(error),
    });
  }
}

/** The boot-recovery creation rollback's removal; archives decide theirs. */
async function removeWorktreeRecord(
  workspaceId: string,
  worktreeId: string,
): Promise<boolean> {
  const removedWorktrees = await removeWorkspaceWorktrees(
    workspaceId,
    (worktree) => worktree.id === worktreeId,
  );
  return removedWorktrees.length > 0;
}

export function createSingleRepoWorktree(
  ...args: Parameters<typeof createAdmittedSingleRepoWorktree>
): Promise<CreateWorktreeResponse> {
  // Admitted before git checks, the metadata reservation and its list row.
  return withStorageAdmission([WORKTREE_LIST_STORAGE], () =>
    createAdmittedSingleRepoWorktree(...args),
  );
}

async function createAdmittedSingleRepoWorktree(
  options: CreateWorktreeServiceOptions,
): Promise<CreateWorktreeResponse> {
  const attempt = options.w5KeyedCreation?.attempt ?? options.w5BoundaryAttempt;
  validateId(options.workspaceId, 'workspaceId');
  const selection = resolveWorktreeCreationSelection(options, 'single-repo');
  if (options.baseWorktreeId) {
    validateId(options.baseWorktreeId, 'baseWorktreeId');
  }

  const config = await readWorkspaceConfig(options.workspaceId);
  if (config.type !== 'single-repo' || !config.repoPath) {
    refuseWorktreeCreation(
      'unsupported-workspace',
      `Project ${options.workspaceId} is not a single-repo project`,
    );
  }
  if (attempt)
    attempt.validate(() =>
      validateAbsolutePath(config.repoPath ?? '', 'repoPath'),
    );
  else validateAbsolutePath(config.repoPath, 'repoPath');
  const projectRepoPath = config.repoPath;

  const referenceRepoPath =
    await resolveProjectReferenceRepoPath(projectRepoPath);
  const { explicitBranch, existingBranch, suggestedBranch } =
    requestedBranchNames(selection.branch);
  if (explicitBranch) {
    await ensureBranchCanBeCreated(
      [referenceRepoPath],
      explicitBranch,
      attempt,
    );
  }
  const defaultBranchTimestamp = Date.now();

  let baseResolution: BaseBranchResolution | null = null;
  if (existingBranch) {
    await ensureExistingBranchIsUsable(
      referenceRepoPath,
      existingBranch,
      attempt,
    );
  }
  if (options.baseBranch) {
    const resolveBranch = usesExactBaseBranch(options)
      ? resolveExactBaseBranch
      : options.baseBranchIsQualified
        ? resolveQualifiedBaseBranch
        : resolveBaseBranch;
    baseResolution = await resolveBranch(
      referenceRepoPath,
      options.baseBranch,
      options.allowBaseBranchNetwork !== false,
      attempt,
    );
  } else if (options.baseWorktreeId) {
    const baseWorktreePath = getWorktreeDir(
      options.workspaceId,
      options.baseWorktreeId,
    );
    const trackedBranch = requireUsableBranchName(
      await getCurrentBranch(baseWorktreePath),
      `worktree "${options.baseWorktreeId}"`,
      attempt,
    );
    baseResolution = {
      trackedBranch,
      startPoint: `refs/heads/${trackedBranch}`,
    };
  }

  const requestedBranch = existingBranch ?? suggestedBranch ?? explicitBranch;
  const reservation = await reserveAndPersistWorktree(
    options.workspaceId,
    options.existingWorktreeIds,
    (id) => {
      const createdAt = new Date().toISOString();
      const worktree: WorktreeData = {
        id,
        branchName:
          requestedBranch ??
          defaultWorktreeBranchName(options, id, defaultBranchTimestamp),
        createdAt,
        setupPhase: 'git-pending',
        creation: {
          operationId: options.w5KeyedCreation?.operationId ?? randomUUID(),
          state: 'pending',
          phase: 'reserved',
          checkouts: [
            {
              repositoryPath: referenceRepoPath,
              checkoutPath: getWorktreeDir(options.workspaceId, id),
            },
          ],
        },
      };
      if (baseResolution) {
        worktree.trackedBaseBranch = baseResolution.trackedBranch;
      }
      return worktree;
    },
    requestedBranch
      ? undefined
      : (id): Promise<boolean> =>
          isBranchNameAvailableInAllRepos(
            [referenceRepoPath],
            defaultWorktreeBranchName(options, id, defaultBranchTimestamp),
          ),
    options.sidebarItemGroupId,
    options.expectedRevision,
    options.w5KeyedCreation,
    options.w5BoundaryCommit,
    options.w5BoundaryAttempt,
  );

  // Deferred desktop creation exposes the git-pending reservation to the
  // renderer immediately. Seed its mode before that response can be observed
  // so the first layout hydration cannot cache a missing file as Advanced.
  await seedCreatedWorktreePanelLayoutMode(options, reservation.id);

  const worktreePath = getWorktreeDir(options.workspaceId, reservation.id);
  const shouldDeferGitSetup = options.deferGitSetup === true;
  const worktreeGitOptions = shouldDeferGitSetup
    ? BACKGROUND_WORKTREE_GIT_OPTIONS
    : undefined;
  const getWindow = options.getWindow ?? ((): BrowserWindow | null => null);
  const buildCreateResponse = async (
    branchName: string,
    repoPathForResolution: string,
    setupPhase?: 'git-pending' | 'git-ready',
  ): Promise<CreateWorktreeResponse> => {
    if (options.startPostCreateSetup !== true) {
      return {
        id: reservation.id,
        branchName,
        createdAt: reservation.worktree.createdAt,
        trackedBaseBranch: baseResolution?.trackedBranch,
        ...(setupPhase ? { setupPhase } : {}),
      };
    }

    const [resolvedScripts, resolvedHooks] = await settleAll([
      resolveCreateWorktreeScripts(
        {
          repoPath: projectRepoPath,
          scripts: config.scripts,
        },
        repoPathForResolution,
      ),
      resolveCreateWorktreeHooks(
        {
          id: options.workspaceId,
          owner: config.owner,
          repoPath: projectRepoPath,
          hooks: config.hooks,
        },
        repoPathForResolution,
      ),
    ]);

    return {
      id: reservation.id,
      branchName,
      createdAt: reservation.worktree.createdAt,
      trackedBaseBranch: baseResolution?.trackedBranch,
      effectiveScripts: toScriptOverrides(resolvedScripts),
      effectiveHooks: toHookOverrides(resolvedHooks),
      ...(setupPhase ? { setupPhase } : {}),
    };
  };

  try {
    await mkdir(dirname(worktreePath), { recursive: true });
  } catch (error) {
    await recordCreationPhase(
      {
        workspaceId: options.workspaceId,
        worktreeId: reservation.id,
        createdAt: reservation.worktree.createdAt,
      },
      'reserved',
      true,
    );
    throw normalizeError(error);
  }

  const setupRef: WorktreeSetupCancellationRef = {
    workspaceId: options.workspaceId,
    worktreeId: reservation.id,
    createdAt: reservation.worktree.createdAt,
  };
  const shouldEnforceSetupRef = shouldDeferGitSetup;
  const shouldContinuePhaseB = async (): Promise<boolean> =>
    shouldEnforceSetupRef
      ? shouldContinueReservedSetup(setupRef)
      : !isWorktreeSetupCancellationRequested(setupRef);

  const runPhaseB = async (): Promise<string | null> => {
    let createdBranchName: string | null = null;
    let releasePostCreateRefreshDeferral: (() => void) | undefined;
    let postCreateSetupStarted = false;
    try {
      if (!(await shouldContinuePhaseB())) {
        await cleanupCancelledSingleRepoSetup({
          setupRef,
          referenceRepoPath,
          worktreePath,
          metadataDir: reservation.metadataDir,
          createdBranchName,
        });
        consumeWorktreeSetupCancellation(setupRef);
        return null;
      }

      await recordCreationPhase(setupRef, 'git-setup');
      let shouldUseExistingBranch = existingBranch !== null;
      if (suggestedBranch) {
        shouldUseExistingBranch = await resolveSuggestedBranchExists(
          referenceRepoPath,
          suggestedBranch,
          worktreeGitOptions,
        );
        if (!shouldUseExistingBranch) {
          await ensureBranchCanBeCreated([referenceRepoPath], suggestedBranch);
        }
      }
      const branchToReuse = existingBranch ?? suggestedBranch;

      // The picker ref may disappear while the reservation waits for Git setup.
      // Resolve again here. Git uses the full ref for tracking and setup verifies
      // the resulting checkout against the observed commit.
      if (options.baseBranch && usesExactBaseBranch(options)) {
        baseResolution = await resolveExactBaseBranch(
          referenceRepoPath,
          options.baseBranch,
          false,
          attempt,
        );
      }

      createdBranchName =
        shouldUseExistingBranch && branchToReuse
          ? await createWorktreeForExistingBranchWithPriority(
              referenceRepoPath,
              worktreePath,
              branchToReuse,
              worktreeGitOptions,
            )
          : baseResolution
            ? await createWorktreeFromStartPointWithPriority(
                referenceRepoPath,
                worktreePath,
                reservation.worktree.branchName,
                baseResolution.startPoint,
                worktreeGitOptions,
                baseResolution.trackingRef,
              )
            : await createWorktreeWithPriority(
                referenceRepoPath,
                worktreePath,
                reservation.worktree.branchName,
                worktreeGitOptions,
              );

      if (!(await shouldContinuePhaseB())) {
        await cleanupCancelledSingleRepoSetup({
          setupRef,
          referenceRepoPath,
          worktreePath,
          metadataDir: reservation.metadataDir,
          createdBranchName,
        });
        consumeWorktreeSetupCancellation(setupRef);
        return null;
      }

      if (requestedBranch && createdBranchName !== requestedBranch) {
        throw new WorktreeCreationRefusedError(
          'branch-reserved',
          `Branch name "${requestedBranch}" is already in use or invalid`,
        );
      }
      const promotedBranchName = createdBranchName;

      // Desktop creation has a post-create lifecycle that schedules the first
      // full graph refresh after the setup script settles. Do not put eager
      // graph cloning on the Git-ready critical path: large published graphs
      // can take tens of seconds to clone, rebind, checkpoint, and fsync even
      // in the utility process, leaving the row stuck at "Setting up…" after
      // the checkout itself is usable. Callers without that lifecycle (for
      // example the synchronous CLI path) still receive the eager snapshot.
      if (options.startPostCreateSetup !== true) {
        await eagerSeedNewWorktreeCodeGraph({
          workspaceId: options.workspaceId,
          worktreeId: reservation.id,
          ...(options.baseWorktreeId
            ? { baseWorktreeId: options.baseWorktreeId }
            : {}),
        });
      }
      if (!(await shouldContinuePhaseB())) {
        await cleanupCancelledSingleRepoSetup({
          setupRef,
          referenceRepoPath,
          worktreePath,
          metadataDir: reservation.metadataDir,
          createdBranchName,
        });
        consumeWorktreeSetupCancellation(setupRef);
        return null;
      }
      if (options.startPostCreateSetup === true) {
        releasePostCreateRefreshDeferral =
          deferCodeGraphRefreshUntilPostCreateSetup(
            options.workspaceId,
            reservation.id,
          );
      }

      await options.beforeGitReady?.({
        projectId: options.workspaceId,
        worktreeId: reservation.id,
        branchName: createdBranchName,
      });
      if (!(await shouldContinuePhaseB())) {
        await cleanupCancelledSingleRepoSetup({
          setupRef,
          referenceRepoPath,
          worktreePath,
          metadataDir: reservation.metadataDir,
          createdBranchName,
        });
        consumeWorktreeSetupCancellation(setupRef);
        return null;
      }

      const promotion: WorktreeCreationPromoteDecision = {
        kind: 'worktree.create.promote',
        workspaceKind: 'single-repo',
        branchName: promotedBranchName,
        trackedBaseBranch: baseResolution?.trackedBranch,
      };
      const promoted = shouldEnforceSetupRef
        ? await applyReservedWorktreeRecord(setupRef, promotion)
        : await applyWorktreeSetupRecord(setupRef, promotion).then(() => true);
      if (!promoted || !(await shouldContinuePhaseB())) {
        await cleanupCancelledSingleRepoSetup({
          setupRef,
          referenceRepoPath,
          worktreePath,
          metadataDir: reservation.metadataDir,
          createdBranchName,
        });
        consumeWorktreeSetupCancellation(setupRef);
        return null;
      }

      const worktreeEffective =
        options.startPostCreateSetup === true
          ? await resolveSingleRepoWorktreeEffective(
              {
                id: options.workspaceId,
                owner: config.owner,
                repoPath: projectRepoPath,
                scripts: config.scripts,
                hooks: config.hooks,
              },
              worktreePath,
            )
          : undefined;

      if (!(await shouldContinuePhaseB())) {
        await cleanupCancelledSingleRepoSetup({
          setupRef,
          referenceRepoPath,
          worktreePath,
          metadataDir: reservation.metadataDir,
          createdBranchName,
        });
        consumeWorktreeSetupCancellation(setupRef);
        return null;
      }

      const gitReadyEvent = {
        projectId: options.workspaceId,
        worktreeId: reservation.id,
        branchName: createdBranchName,
        worktreeEffective,
      };
      options.onGitReady?.(gitReadyEvent);
      trackDetachedWork(() =>
        publishWorktreeGitReady({
          ...gitReadyEvent,
          workspaceKind: 'single-repo',
        }),
      );

      if (!(await shouldContinuePhaseB())) {
        await cleanupCancelledSingleRepoSetup({
          setupRef,
          referenceRepoPath,
          worktreePath,
          metadataDir: reservation.metadataDir,
          createdBranchName,
        });
        consumeWorktreeSetupCancellation(setupRef);
        return null;
      }

      await recordWorktreeCreatedUsageEvent(
        options.workspaceId,
        reservation.id,
        reservation.worktree.createdAt,
        config,
      ).catch(() => {});

      if (options.startPostCreateSetup === true) {
        postCreateSetupStarted = startProjectPostCreateSetupSafely(
          options.startProjectPostCreateSetup,
          {
            projectId: options.workspaceId,
            worktreeId: reservation.id,
            project: {
              repoPath: projectRepoPath,
              scripts: config.scripts,
            },
            getWindow,
          },
          releasePostCreateRefreshDeferral ?? ((): void => {}),
        );
      }

      return createdBranchName;
    } catch (error) {
      const initialStorageFailure = setupStorageFailure(error);
      if (!isSetupStorageUnavailable(error)) {
        try {
          if (!(await shouldContinuePhaseB())) {
            await cleanupCancelledSingleRepoSetup({
              setupRef,
              referenceRepoPath,
              worktreePath,
              metadataDir: reservation.metadataDir,
              createdBranchName,
            });
            consumeWorktreeSetupCancellation(setupRef);
            return null;
          }
        } catch (cleanupError) {
          error = cleanupError;
        }
      }

      const normalizedError = normalizeError(error);
      const healthIssue = createSetupFailureHealthIssue(
        worktreePath,
        normalizedError,
      );
      let storageUnavailable = isSetupStorageUnavailable(error);
      let storageFailure = initialStorageFailure;
      // A thrown write cannot prove staleness; false confirms the reservation is gone.
      const marked = await recordCreationPhase(
        setupRef,
        undefined,
        true,
        healthIssue,
      ).catch((phaseError) => {
        storageUnavailable ||= isSetupStorageUnavailable(phaseError);
        // A failed recovery write cannot promote an unrelated Git defect to
        // an external overload, or hide unreadable records behind one.
        if (storageFailure !== undefined) {
          const secondary = setupStorageFailure(phaseError);
          if (secondary === undefined || secondary === 'unreadable')
            storageFailure = 'unreadable';
          else if (storageFailure === 'overloaded') storageFailure = secondary;
        }
        return undefined;
      });
      if (marked === false && shouldEnforceSetupRef) return null;
      options.onGitFailed?.({
        projectId: options.workspaceId,
        worktreeId: reservation.id,
        error: getErrorMessage(normalizedError),
        failureReason: storageUnavailable
          ? 'storage-unavailable'
          : worktreeSourceFailure(normalizedError)?.failureReason,
        ...(storageFailure === undefined ? {} : { storageFailure }),
        healthIssue,
      });
      throw normalizedError;
    } finally {
      if (!postCreateSetupStarted) {
        releasePostCreateRefreshDeferral?.();
      }
    }
  };

  if (shouldDeferGitSetup) {
    const pendingResponse = await buildCreateResponse(
      reservation.worktree.branchName,
      referenceRepoPath,
      'git-pending',
    );
    const settleGitSetup = beginWorktreeGitSetup(
      options.workspaceId,
      reservation.id,
    );
    enqueueProjectGitSetup(options.workspaceId, async (): Promise<void> => {
      try {
        const branchName = await admitDeferredPhaseB(
          options,
          reservation.id,
          worktreePath,
          runPhaseB,
        );
        settleGitSetup(branchName === null ? 'cancelled' : 'ready');
        options.onGitSetupSettled?.({
          projectId: options.workspaceId,
          worktreeId: reservation.id,
          outcome: branchName === null ? 'cancelled' : 'ready',
        });
      } catch (error) {
        settleGitSetup('failed');
        options.onGitSetupSettled?.({
          projectId: options.workspaceId,
          worktreeId: reservation.id,
          outcome: 'failed',
        });
        throw error;
      }
    });
    return pendingResponse;
  }

  const createdBranchName = cancelPhaseBIfRequested(await runPhaseB());
  return buildCreateResponse(createdBranchName, worktreePath);
}

async function readBaseWorktreeBranchMap(
  workspaceId: string,
  worktreeId: string,
  attempt?: W5KeyedAttempt,
): Promise<Record<string, string>> {
  const worktreePath = getWorkspaceWorktreeDir(workspaceId, worktreeId);
  const repoEntries = await listWorkspaceWorktreeRepoEntries(
    workspaceId,
    worktreePath,
  );

  const repoBranches = await settleAll(
    repoEntries.map(async (entry) => ({
      repoId: entry.repoId,
      branchName: requireUsableBranchName(
        await getCurrentBranch(entry.repoPath),
        `project repo "${entry.repoName}" in worktree "${worktreeId}"`,
        attempt,
      ),
    })),
  );

  const branchMap: Record<string, string> = {};
  for (const repoBranch of repoBranches) {
    branchMap[repoBranch.repoId] = repoBranch.branchName;
  }

  return branchMap;
}

async function resolveMultiRepoBaseBranches(
  repoPaths: Array<{ repoId: string; repoPath: string }>,
  baseBranch: string,
  allowNetwork = true,
  attempt?: W5KeyedAttempt,
): Promise<Record<string, BaseBranchResolution>> {
  const entries = await settleAll(
    repoPaths.map(
      async (entry) =>
        [
          entry.repoId,
          await resolveBaseBranch(
            entry.repoPath,
            baseBranch,
            allowNetwork,
            attempt,
          ),
        ] as const,
    ),
  );
  return Object.fromEntries(entries);
}

async function resolveMappedMultiRepoBaseBranches(
  repoPaths: Array<{ repoId: string; repoPath: string }>,
  baseBranchesByRepo: Record<string, string>,
  allowNetwork = true,
  attempt?: W5KeyedAttempt,
): Promise<Record<string, BaseBranchResolution>> {
  const pathsById = new Map(
    repoPaths.map((entry) => [entry.repoId, entry.repoPath]),
  );
  const entries = await settleAll(
    Object.entries(baseBranchesByRepo).map(async ([repoId, baseBranch]) => {
      const repoPath = pathsById.get(repoId);
      if (!repoPath) {
        refuseWorktreeCreation(
          'invalid-repository-selection',
          `Base branch was provided for unknown repo "${repoId}"`,
        );
      }
      return [
        repoId,
        await resolveBaseBranch(repoPath, baseBranch, allowNetwork, attempt),
      ] as const;
    }),
  );
  return Object.fromEntries(entries);
}

export async function rollbackWorkspaceWorktree(
  workspaceId: string,
  worktreeId: string,
  worktreeDir: string,
  repos: WorkspaceConfigFile['repos'],
  repoIds: string[],
  sourceRepoPath?: string,
): Promise<void> {
  try {
    for (const repoId of repoIds) {
      const repo = repos.find((item) => item.id === repoId);
      if (!repo) {
        continue;
      }

      const repoWorktreePath = getWorkspaceWorktreeRepoDir(
        workspaceId,
        worktreeId,
        repoId,
      );

      await safeRemoveWorktree(repo.repoPath, repoWorktreePath, {
        workspaceId,
        worktreeId,
        repoId,
      }).catch(() => {});
    }

    if (sourceRepoPath) {
      await safeRemoveWorktree(sourceRepoPath, worktreeDir, {
        workspaceId,
        worktreeId,
      }).catch(() => {});
    }
  } finally {
    await removePhysicalWorktreeDirectory(worktreeDir);
  }
}

export function createMultiRepoWorktree(
  ...args: Parameters<typeof createAdmittedMultiRepoWorktree>
): Promise<CreateWorkspaceWorktreeResponse> {
  // Admitted before git checks, the metadata reservation and its list row.
  return withStorageAdmission([WORKTREE_LIST_STORAGE], () =>
    createAdmittedMultiRepoWorktree(...args),
  );
}

async function createAdmittedMultiRepoWorktree(
  options: CreateWorktreeServiceOptions,
): Promise<CreateWorkspaceWorktreeResponse> {
  const attempt = options.w5KeyedCreation?.attempt ?? options.w5BoundaryAttempt;
  validateId(options.workspaceId, 'workspaceId');
  const selection = resolveWorktreeCreationSelection(options, 'multi-repo');
  if (options.baseWorktreeId) {
    validateId(options.baseWorktreeId, 'baseWorktreeId');
  }

  // Phase A must stay fast and shadow-free so the reservation response is
  // bounded by plain filesystem reads — `getWorkspaceById` guarantees that
  // (see its doc comment and docs/repo-shadow.md "Latency invariant").
  const workspace = await getWorkspaceById(
    options.workspaceId,
    !!options.w5BoundaryCommit?.expectedRevisions ||
      !!options.w5BoundaryCommit?.beforeDecision,
  );
  if (workspace.type !== 'multi-repo') {
    refuseWorktreeCreation(
      'unsupported-workspace',
      `Project ${options.workspaceId} is not a multi-repo project`,
    );
  }
  if (workspace.repos.length === 0 && options.includedRepoIds === undefined) {
    refuseWorktreeCreation(
      'unsupported-workspace',
      'Cannot create worktree: project has no repos.',
    );
  }
  const includedRepoIds = options.includedRepoIds;
  const requestedRepoIds =
    includedRepoIds === undefined ? undefined : new Set(includedRepoIds);
  if (requestedRepoIds && requestedRepoIds.size !== includedRepoIds?.length) {
    refuseWorktreeCreation(
      'invalid-repository-selection',
      'Cannot create worktree: duplicate included repo ids.',
    );
  }
  for (const repoId of includedRepoIds ?? []) {
    validateId(repoId, 'includedRepoId');
    if (!workspace.repos.some((repo) => repo.id === repoId)) {
      refuseWorktreeCreation(
        'invalid-repository-selection',
        `Cannot create worktree: included repo ${repoId} is not in the project.`,
      );
    }
  }
  const includedRepos = requestedRepoIds
    ? workspace.repos.filter((repo) => requestedRepoIds.has(repo.id))
    : workspace.repos;

  const referenceRepoPath = workspace.sourceRepoPath
    ? await resolveWorkspaceReferenceRepoPath(workspace.sourceRepoPath)
    : undefined;
  const repoPaths = [
    ...(referenceRepoPath
      ? [{ repoId: WORKSPACE_ROOT_REPO_ID, repoPath: referenceRepoPath }]
      : []),
    ...includedRepos.map((repo) => ({
      repoId: repo.id,
      repoPath: repo.repoPath,
    })),
  ];
  const { explicitBranch, existingBranch, suggestedBranch } =
    requestedBranchNames(selection.branch);
  const existingBranchRepoPaths =
    selection.branch.kind === 'existing' && selection.branch.restoreRepoPaths
      ? new Set(selection.branch.restoreRepoPaths)
      : null;
  const mappedBaseBranches =
    selection.base.kind === 'per-repository'
      ? selection.base.baseBranches
      : null;
  if (suggestedBranch && !referenceRepoPath) {
    refuseWorktreeCreation(
      'invalid-selection',
      `Project ${options.workspaceId} has no source repository; suggestedBranch requires a source-backed multi-repo project`,
    );
  }
  if (explicitBranch) {
    await ensureBranchCanBeCreated(
      repoPaths.map((entry) => entry.repoPath),
      explicitBranch,
      attempt,
    );
  }
  const defaultBranchTimestamp = Date.now();

  let baseResolutions: Record<string, BaseBranchResolution> | null = null;
  if (
    existingBranch &&
    referenceRepoPath &&
    (!existingBranchRepoPaths || existingBranchRepoPaths.has(referenceRepoPath))
  ) {
    await ensureExistingBranchIsUsable(
      referenceRepoPath,
      existingBranch,
      attempt,
    );
  }
  if (options.baseBranch) {
    baseResolutions = await resolveMultiRepoBaseBranches(
      repoPaths,
      options.baseBranch,
      options.allowBaseBranchNetwork !== false,
      attempt,
    );
  } else if (mappedBaseBranches) {
    baseResolutions = await resolveMappedMultiRepoBaseBranches(
      repoPaths,
      mappedBaseBranches,
      options.allowBaseBranchNetwork !== false,
      attempt,
    );
  }
  const trackedRepoBaseBranches = options.baseWorktreeId
    ? await readBaseWorktreeBranchMap(
        options.workspaceId,
        options.baseWorktreeId,
        attempt,
      )
    : baseResolutions
      ? Object.fromEntries(
          Object.entries(baseResolutions).map(([repoId, resolution]) => [
            repoId,
            resolution.trackedBranch,
          ]),
        )
      : undefined;

  const requestedBranch = existingBranch ?? suggestedBranch ?? explicitBranch;
  const reservation = await reserveAndPersistWorktree(
    options.workspaceId,
    options.existingWorktreeIds,
    (id) => {
      const createdAt = new Date().toISOString();
      const worktree: WorktreeData = {
        id,
        branchName:
          requestedBranch ??
          defaultWorktreeBranchName(options, id, defaultBranchTimestamp),
        createdAt,
        setupPhase: 'git-pending',
        creation: {
          operationId: options.w5KeyedCreation?.operationId ?? randomUUID(),
          state: 'pending',
          phase: 'reserved',
          checkouts: [
            ...(referenceRepoPath
              ? [
                  {
                    repositoryPath: referenceRepoPath,
                    checkoutPath: getWorkspaceWorktreeRootRepoDir(
                      options.workspaceId,
                      id,
                    ),
                  },
                ]
              : []),
            ...includedRepos.map((repo) => ({
              repositoryPath: repo.repoPath,
              checkoutPath: getWorkspaceWorktreeRepoDir(
                options.workspaceId,
                id,
                repo.id,
              ),
            })),
          ],
        },
        ...(includedRepoIds === undefined
          ? {}
          : { includedRepoIds: [...includedRepoIds] }),
      };
      if (trackedRepoBaseBranches) {
        worktree.trackedRepoBaseBranches = trackedRepoBaseBranches;
      }
      return worktree;
    },
    requestedBranch
      ? undefined
      : (id): Promise<boolean> =>
          isBranchNameAvailableInAllRepos(
            repoPaths.map((entry) => entry.repoPath),
            defaultWorktreeBranchName(options, id, defaultBranchTimestamp),
          ),
    options.sidebarItemGroupId,
    options.expectedRevision,
    options.w5KeyedCreation,
    options.w5BoundaryCommit,
    options.w5BoundaryAttempt,
  );

  // Keep creation-time layout policy ahead of the deferred reservation
  // response for the same reason as the single-repository path above.
  await seedCreatedWorktreePanelLayoutMode(options, reservation.id);

  const worktreeDir = getWorkspaceWorktreeDir(
    options.workspaceId,
    reservation.id,
  );
  const rootWorktreePath = getWorkspaceWorktreeRootRepoDir(
    options.workspaceId,
    reservation.id,
  );
  const shouldDeferGitSetup = options.deferGitSetup === true;
  const worktreeGitOptions = shouldDeferGitSetup
    ? BACKGROUND_WORKTREE_GIT_OPTIONS
    : undefined;
  const getWindow = options.getWindow ?? ((): BrowserWindow | null => null);
  let branchName = reservation.worktree.branchName;
  let rootBranchName: string | null = null;
  let shouldReuseSuggestedBranch = false;
  const setupRef: WorktreeSetupCancellationRef = {
    workspaceId: options.workspaceId,
    worktreeId: reservation.id,
    createdAt: reservation.worktree.createdAt,
  };
  const shouldEnforceSetupRef = shouldDeferGitSetup;
  const shouldContinuePhaseB = async (): Promise<boolean> =>
    shouldEnforceSetupRef
      ? shouldContinueReservedSetup(setupRef)
      : !isWorktreeSetupCancellationRequested(setupRef);

  // Creates the workspace-ROOT worktree checkout, reconciles the branch name,
  // validates it, and (when `repairWorkspaceRoot` is set) repairs it. Returns a
  // discriminated result rather than mutating outer state so it can run either
  // synchronously in Phase A (non-deferred/CLI) or inside the deferred Phase B.
  //
  // Task I1: for the deferred (`deferGitSetup: true`) path this whole block —
  // the `git worktree add` (which does a full root checkout and, for existing
  // branches, a network `fetchOrigin`) plus `validateWorkspaceRootWorktree` —
  // now runs in Phase B instead of gating the reservation response, so the
  // renderer gets a `git-pending` worktree id back in the low-hundreds-of-ms
  // range (no root checkout, no network) and can queue the user's message.
  const performRootWorktreeSetup =
    async (): Promise<RootWorktreeSetupResult> => {
      await recordCreationPhase(setupRef, 'git-setup');
      await mkdir(dirname(rootWorktreePath), { recursive: true });
      let nextBranchName = reservation.worktree.branchName;
      let nextRootBranchName: string | null = null;
      if (referenceRepoPath) {
        if (suggestedBranch) {
          shouldReuseSuggestedBranch = await resolveSuggestedBranchExists(
            referenceRepoPath,
            suggestedBranch,
            worktreeGitOptions,
          );
          if (!shouldReuseSuggestedBranch) {
            await ensureBranchCanBeCreated(
              [referenceRepoPath],
              suggestedBranch,
            );
          }
        }
        let branchToReuse =
          existingBranch ??
          (shouldReuseSuggestedBranch ? suggestedBranch : null);
        if (
          existingBranch &&
          existingBranchRepoPaths &&
          !existingBranchRepoPaths.has(referenceRepoPath)
        ) {
          if (worktreeGitOptions) {
            await fetchOrigin(referenceRepoPath, worktreeGitOptions);
          } else {
            await fetchOrigin(referenceRepoPath);
          }
          const [localExists, remoteExists] = await settleAll([
            doesLocalBranchExist(referenceRepoPath, existingBranch),
            doesRemoteBranchExist(referenceRepoPath, existingBranch),
          ]);
          if (localExists || remoteExists) {
            throw new Error(
              `Cannot safely restore branch "${existingBranch}" because it appeared in repository "${referenceRepoPath}" after restore validation.`,
            );
          }
          branchToReuse = null;
        }
        if (branchToReuse) {
          nextBranchName = await createWorktreeForExistingBranchWithPriority(
            referenceRepoPath,
            rootWorktreePath,
            branchToReuse,
            worktreeGitOptions,
          );
        } else {
          const rootStartPoint =
            baseResolutions?.[WORKSPACE_ROOT_REPO_ID]?.startPoint ??
            (options.baseWorktreeId
              ? trackedRepoBaseBranches?.[WORKSPACE_ROOT_REPO_ID]
              : undefined);
          if (options.baseWorktreeId && !rootStartPoint) {
            throw new Error(
              `Base worktree "${options.baseWorktreeId}" is missing the project root repository`,
            );
          }
          if (rootStartPoint) {
            const sharedBranchName = explicitBranch
              ? explicitBranch
              : await resolveSharedAvailableBranchName(
                  repoPaths.map((entry) => entry.repoPath),
                  nextBranchName,
                );
            if (!sharedBranchName) {
              throw new Error(
                `Unable to create a shared branch name for project "${workspace.name}"`,
              );
            }
            nextBranchName = await createWorktreeFromStartPointWithPriority(
              referenceRepoPath,
              rootWorktreePath,
              sharedBranchName,
              rootStartPoint,
              worktreeGitOptions,
              baseResolutions?.[WORKSPACE_ROOT_REPO_ID]?.trackingRef,
            );
          } else {
            nextBranchName = await createWorktreeWithPriority(
              referenceRepoPath,
              rootWorktreePath,
              nextBranchName,
              worktreeGitOptions,
            );
          }
        }
        nextRootBranchName = nextBranchName;

        if (requestedBranch && nextBranchName !== requestedBranch) {
          throw new Error(
            `Branch name "${requestedBranch}" is already in use or invalid`,
          );
        }

        if (nextBranchName !== reservation.worktree.branchName) {
          await applyReservedWorktreeRecord(setupRef, {
            kind: 'worktree.create.branch',
            branchName: nextBranchName,
          });
        }

        const repairIssues = await validateWorkspaceRootWorktree(
          options.workspaceId,
          reservation.id,
        );
        if (repairIssues.some((issue) => issue.blocking)) {
          if (options.repairWorkspaceRoot === true) {
            await recordCreationPhase(setupRef, 'source-root-repair');
            const repairedIssues = await repairWorkspaceRootWorktree(
              options.workspaceId,
              reservation.id,
              options.restoreClaudeMd ?? true,
            );
            const blockingIssues = repairedIssues.filter(
              (issue) => issue.blocking,
            );
            if (blockingIssues.length > 0) {
              throw new Error(
                blockingIssues.map((issue) => issue.message).join('; '),
              );
            }
          } else {
            return {
              status: 'needs-repair',
              branchName: nextBranchName,
              rootBranchName: nextRootBranchName,
              repairIssues,
            };
          }
        }
      } else {
        if (trackedRepoBaseBranches && !existingBranch) {
          const sharedBranchName = explicitBranch
            ? explicitBranch
            : await resolveSharedAvailableBranchName(
                repoPaths.map((entry) => entry.repoPath),
                nextBranchName,
              );
          if (!sharedBranchName) {
            throw new Error(
              `Unable to create a shared branch name for project "${workspace.name}"`,
            );
          }
          nextBranchName = sharedBranchName;
        }
        await mkdir(rootWorktreePath, { recursive: true });
        if (nextBranchName !== reservation.worktree.branchName) {
          await applyReservedWorktreeRecord(setupRef, {
            kind: 'worktree.create.branch',
            branchName: nextBranchName,
          });
        }
      }
      return {
        status: 'ready',
        branchName: nextBranchName,
        rootBranchName: nextRootBranchName,
      };
    };

  const runPhaseB = async (phaseBOptions: {
    includeRootSetup: boolean;
  }): Promise<string | null | typeof PHASE_B_NEEDS_REPAIR> => {
    const createdRepoBranches = new Map<string, string>();
    let releasePostCreateRefreshDeferral: (() => void) | undefined;
    let postCreateSetupStarted = false;
    const cleanupCancelledSetup = async (): Promise<void> => {
      await cleanupCancelledMultiRepoSetup({
        setupRef,
        workspaceId: options.workspaceId,
        worktreeId: reservation.id,
        referenceRepoPath,
        rootWorktreePath,
        metadataDir: reservation.metadataDir,
        repos: includedRepos,
        createdRepoBranches,
        rootBranchName,
      });
      consumeWorktreeSetupCancellation(setupRef);
    };
    const cleanupIfCancelled = async (): Promise<boolean> => {
      if (await shouldContinuePhaseB()) {
        return false;
      }

      await cleanupCancelledSetup();
      return true;
    };

    try {
      if (await cleanupIfCancelled()) {
        return null;
      }

      if (phaseBOptions.includeRootSetup) {
        const rootSetup = await performRootWorktreeSetup();
        if (await cleanupIfCancelled()) {
          return null;
        }
        if (rootSetup.status === 'needs-repair') {
          const repairExistingBranch =
            existingBranch ??
            (shouldReuseSuggestedBranch ? suggestedBranch : null);
          // Deferred repair contract (Task I1): the root checkout exists but has
          // blocking issues and repair was not pre-authorized. Retain the row,
          // metadata and checkout identity for explicit recovery; surface the
          // existing repair event without proceeding to child creation.
          await recordCreationPhase(setupRef, 'source-root-repair', true);
          const repairEvent: WorktreeNeedsRepairEvent = {
            projectId: options.workspaceId,
            worktreeId: reservation.id,
            branchName: rootSetup.branchName,
            repairIssues: rootSetup.repairIssues,
            ...(repairExistingBranch
              ? { existingBranch: repairExistingBranch }
              : {}),
            ...(trackedRepoBaseBranches ? { trackedRepoBaseBranches } : {}),
          };
          if (options.onNeedsRepair) {
            options.onNeedsRepair(repairEvent);
            return PHASE_B_NEEDS_REPAIR;
          }
          options.onGitFailed?.({
            projectId: options.workspaceId,
            worktreeId: reservation.id,
            error: 'Created worktree requires repair.',
          });
          return null;
        }
        branchName = rootSetup.branchName;
        rootBranchName = rootSetup.rootBranchName;
      }

      await recordCreationPhase(setupRef, 'git-setup');
      const results = await settleEach(
        includedRepos.map(async (repo) => {
          const repoWorktreePath = getWorkspaceWorktreeRepoDir(
            options.workspaceId,
            reservation.id,
            repo.id,
          );
          await mkdir(dirname(repoWorktreePath), { recursive: true });
          const childSuggestedBranchExists = suggestedBranch
            ? await resolveSuggestedBranchExists(
                repo.repoPath,
                suggestedBranch,
                worktreeGitOptions,
              )
            : false;
          let branchToReuse = childSuggestedBranchExists
            ? suggestedBranch
            : null;
          if (existingBranch) {
            if (worktreeGitOptions) {
              await fetchOrigin(repo.repoPath, worktreeGitOptions);
            } else {
              await fetchOrigin(repo.repoPath);
            }
            const [localExists, remoteExists] = await settleAll([
              doesLocalBranchExist(repo.repoPath, existingBranch),
              doesRemoteBranchExist(repo.repoPath, existingBranch),
            ]);
            if (existingBranchRepoPaths) {
              const expectedToExist = existingBranchRepoPaths.has(
                repo.repoPath,
              );
              if (expectedToExist !== (localExists || remoteExists)) {
                throw new Error(
                  `Cannot safely restore branch "${existingBranch}" because its availability changed in repository "${repo.repoPath}" after restore validation.`,
                );
              }
            }
            branchToReuse = localExists || remoteExists ? existingBranch : null;
          }
          if (branchToReuse) {
            const createdBranchName =
              await createWorktreeForExistingBranchWithPriority(
                repo.repoPath,
                repoWorktreePath,
                branchToReuse,
                worktreeGitOptions,
              );
            createdRepoBranches.set(repo.id, createdBranchName);
          } else {
            const startPoint =
              baseResolutions?.[repo.id]?.startPoint ??
              (options.baseWorktreeId
                ? trackedRepoBaseBranches?.[repo.id]
                : undefined);
            if (options.baseWorktreeId && !startPoint) {
              throw new Error(
                `Base worktree "${options.baseWorktreeId}" is missing repo "${repo.name}"`,
              );
            }
            const createdBranchName = startPoint
              ? await createWorktreeFromStartPointWithPriority(
                  repo.repoPath,
                  repoWorktreePath,
                  branchName,
                  startPoint,
                  worktreeGitOptions,
                  baseResolutions?.[repo.id]?.trackingRef,
                )
              : await createWorktreeWithPriority(
                  repo.repoPath,
                  repoWorktreePath,
                  branchName,
                  worktreeGitOptions,
                );
            createdRepoBranches.set(repo.id, createdBranchName);
            if (createdBranchName !== branchName) {
              throw new Error(
                `Repo "${repo.name}" created branch "${createdBranchName}" instead of "${branchName}"`,
              );
            }
          }
          return repo.id;
        }),
      );

      if (await cleanupIfCancelled()) {
        return null;
      }

      const failed = results.filter(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      );
      if (failed.length > 0) {
        if (failed.length === 1) {
          throw failed[0].reason;
        }
        const reasons = failed
          .map(
            (failure, index) =>
              `  ${index + 1}. ${
                failure.reason instanceof Error
                  ? failure.reason.message
                  : String(failure.reason)
              }`,
          )
          .join('\n');
        const combined = new Error(
          `${failed.length} repos failed worktree creation:\n${reasons}`,
        );
        const classifications = failed.map((failure) =>
          worktreeSourceFailure(failure.reason),
        );
        if (classifications.every((failure) => failure !== undefined)) {
          Object.assign(combined, classifications[0]);
        }
        throw combined;
      }

      // See the single-repo path above. Automatic desktop setup owns the
      // post-setup refresh, so a potentially large eager graph seed must not
      // extend the Git-pending gate.
      if (options.startPostCreateSetup !== true) {
        await eagerSeedNewWorktreeCodeGraph({
          workspaceId: options.workspaceId,
          worktreeId: reservation.id,
          ...(options.baseWorktreeId
            ? { baseWorktreeId: options.baseWorktreeId }
            : {}),
        });
      }
      if (await cleanupIfCancelled()) {
        return null;
      }
      if (options.startPostCreateSetup === true) {
        releasePostCreateRefreshDeferral =
          deferCodeGraphRefreshUntilPostCreateSetup(
            options.workspaceId,
            reservation.id,
          );
      }

      await options.beforeGitReady?.({
        projectId: options.workspaceId,
        worktreeId: reservation.id,
        branchName,
      });
      if (await cleanupIfCancelled()) {
        return null;
      }

      const promotion: WorktreeCreationPromoteDecision = {
        kind: 'worktree.create.promote',
        workspaceKind: 'multi-repo',
        branchName,
        trackedRepoBaseBranches,
      };
      const promoted = shouldEnforceSetupRef
        ? await applyReservedWorktreeRecord(setupRef, promotion)
        : await applyWorktreeSetupRecord(setupRef, promotion).then(() => true);
      if (!promoted) {
        await cleanupCancelledSetup();
        return null;
      }
      if (await cleanupIfCancelled()) {
        return null;
      }

      const worktreeEffective =
        options.startPostCreateSetup === true
          ? await resolveWorkspaceWorktreeEffective(
              options.workspaceId,
              reservation.id,
              worktreeDir,
              includedRepos,
            )
          : undefined;

      if (await cleanupIfCancelled()) {
        return null;
      }

      options.onGitReady?.({
        projectId: options.workspaceId,
        worktreeId: reservation.id,
        branchName,
        worktreeEffective,
      });
      trackDetachedWork(() =>
        publishWorktreeGitReady({
          projectId: options.workspaceId,
          worktreeId: reservation.id,
          branchName,
          worktreeEffective,
          workspaceKind: 'multi-repo',
        }),
      );

      if (await cleanupIfCancelled()) {
        return null;
      }

      await recordWorktreeCreatedUsageEvent(
        options.workspaceId,
        reservation.id,
        reservation.worktree.createdAt,
        {
          version: 1,
          type: 'multi-repo',
          repos: includedRepos,
          sourceRepoPath: workspace.sourceRepoPath,
        },
      ).catch(() => {});

      if (options.startPostCreateSetup === true) {
        postCreateSetupStarted = startWorkspacePostCreateSetupSafely(
          options.startWorkspacePostCreateSetup,
          {
            workspaceId: options.workspaceId,
            worktreeId: reservation.id,
            workspaceRootPath: worktreeDir,
            repos: includedRepos,
            getWindow,
          },
          releasePostCreateRefreshDeferral ?? ((): void => {}),
        );
      }

      return branchName;
    } catch (error) {
      const initialStorageFailure = setupStorageFailure(error);
      if (!isSetupStorageUnavailable(error)) {
        try {
          if (!(await shouldContinuePhaseB())) {
            await cleanupCancelledSetup();
            return null;
          }
        } catch (cleanupError) {
          error = cleanupError;
        }
      }

      const normalizedError = normalizeError(error);
      const healthIssue = createSetupFailureHealthIssue(
        worktreeDir,
        normalizedError,
        includedRepos.find(
          (repo) =>
            repo.repoPath ===
            worktreeSourceFailure(normalizedError)?.sourceRepoPath,
        )?.id,
      );
      let storageUnavailable = isSetupStorageUnavailable(error);
      let storageFailure = initialStorageFailure;
      // A thrown write cannot prove staleness; false confirms the reservation is gone.
      const marked = await recordCreationPhase(
        setupRef,
        undefined,
        true,
        healthIssue,
      ).catch((phaseError) => {
        storageUnavailable ||= isSetupStorageUnavailable(phaseError);
        // A failed recovery write cannot promote an unrelated Git defect to
        // an external overload, or hide unreadable records behind one.
        if (storageFailure !== undefined) {
          const secondary = setupStorageFailure(phaseError);
          if (secondary === undefined || secondary === 'unreadable')
            storageFailure = 'unreadable';
          else if (storageFailure === 'overloaded') storageFailure = secondary;
        }
        return undefined;
      });
      if (marked === false && shouldEnforceSetupRef) return null;
      options.onGitFailed?.({
        projectId: options.workspaceId,
        worktreeId: reservation.id,
        error: getErrorMessage(normalizedError),
        failureReason: storageUnavailable
          ? 'storage-unavailable'
          : worktreeSourceFailure(normalizedError)?.failureReason,
        ...(storageFailure === undefined ? {} : { storageFailure }),
        ...(storageUnavailable || !healthIssue.sourceRepoId
          ? {}
          : { sourceRepoId: healthIssue.sourceRepoId }),
        healthIssue,
      });
      throw normalizedError;
    } finally {
      if (!postCreateSetupStarted) {
        releasePostCreateRefreshDeferral?.();
      }
    }
  };

  if (shouldDeferGitSetup) {
    // Reservation-only response: root add + validation + repair decision now run
    // inside Phase B (see `runPhaseB({ includeRootSetup: true })`). The row is a
    // `git-pending` worktree, and main holds a send into it until the setup
    // registered below settles; a required repair is surfaced later via
    // `onNeedsRepair`.
    const settleGitSetup = beginWorktreeGitSetup(
      options.workspaceId,
      reservation.id,
    );
    enqueueProjectGitSetup(options.workspaceId, async (): Promise<void> => {
      try {
        const branchName = await admitDeferredPhaseB(
          options,
          reservation.id,
          worktreeDir,
          () => runPhaseB({ includeRootSetup: true }),
        );
        // A needs-repair detour keeps the setup pending: completing the
        // repair settles it ready, and dismissing it tears the worktree
        // down, which settles it cancelled. Sends held for the setup wait
        // through the repair.
        if (branchName === PHASE_B_NEEDS_REPAIR) return;
        settleGitSetup(branchName === null ? 'cancelled' : 'ready');
        options.onGitSetupSettled?.({
          projectId: options.workspaceId,
          worktreeId: reservation.id,
          outcome: branchName === null ? 'cancelled' : 'ready',
        });
      } catch (error) {
        settleGitSetup('failed');
        options.onGitSetupSettled?.({
          projectId: options.workspaceId,
          worktreeId: reservation.id,
          outcome: 'failed',
        });
        throw error;
      }
    });
    return {
      id: reservation.id,
      branchName,
      createdAt: reservation.worktree.createdAt,
      trackedRepoBaseBranches,
      setupPhase: 'git-pending',
    };
  }

  // Synchronous callers retain the existing throw / needsRepair response.
  // The identity now survives an uncertain failure or a repair requirement.
  let rootSetup: RootWorktreeSetupResult;
  try {
    rootSetup = await performRootWorktreeSetup();
  } catch (error) {
    const normalizedError = normalizeError(error);
    await recordCreationPhase(
      setupRef,
      undefined,
      true,
      createSetupFailureHealthIssue(worktreeDir, normalizedError),
    );
    throw normalizedError;
  }
  if (rootSetup.status === 'needs-repair') {
    if (
      options.startPostCreateSetup === true ||
      options.surfaceNeedsRepairInResponse === true
    ) {
      const repairExistingBranch =
        existingBranch ?? (shouldReuseSuggestedBranch ? suggestedBranch : null);
      const response: CreateWorkspaceWorktreeResponse = {
        id: reservation.id,
        branchName: rootSetup.branchName,
        createdAt: reservation.worktree.createdAt,
        ...(repairExistingBranch
          ? { existingBranch: repairExistingBranch }
          : {}),
        trackedRepoBaseBranches,
        needsRepair: true,
        repairIssues: rootSetup.repairIssues,
      };
      const keyed = options.w5KeyedCreation;
      const retain = (): Promise<boolean> =>
        recordCreationPhase(setupRef, 'source-root-repair', true);
      if (keyed) await keyed.commitRepairOutcome(response, retain);
      else await retain();
      return response;
    }
    await recordCreationPhase(setupRef, 'source-root-repair', true);
    throw new Error(
      'Created project root worktree requires repair and cannot be finalized from the CLI. ' +
        'Re-run this command with --repair to repair project root files during creation. ' +
        'Add --no-restore-claude-md if repair should not copy CLAUDE.md from the project source repo.',
    );
  }
  branchName = rootSetup.branchName;
  rootBranchName = rootSetup.rootBranchName;

  const createdBranchName = cancelPhaseBIfRequested(
    await runPhaseB({ includeRootSetup: false }),
  );
  return {
    id: reservation.id,
    branchName: createdBranchName,
    createdAt: reservation.worktree.createdAt,
    trackedRepoBaseBranches,
  };
}

/**
 * Archive retention removes the checkout in a utility worker whose process
 * tree excludes main's providers, so main verifies its own writers around
 * that teardown: after live cleanup drained them, before and after removal.
 * Without a retained container the in-process removal verifies on its own.
 */
function retainedArchiveWriterVerification(
  worktreePath: string,
  archiveContainer: PreparedWorktreeArchiveContainer | undefined,
): <T>(run: () => Promise<T>) => Promise<T> {
  return (run) =>
    archiveContainer
      ? withLinuxWorktreeRemovalVerification(worktreePath, run, {
          // Include the sibling before teardown starts: an interrupted archive
          // may already have moved the checkout there before this retry.
          additionalPaths: [
            join(
              dirname(worktreePath),
              `.${basename(worktreePath)}.archive-quarantine`,
            ),
          ],
        })
      : run();
}

async function cleanupLiveStateIfNeeded(
  projectId: string,
  worktreeId: string,
  mode: 'persisted-only' | 'live-service',
  liveServices: WorktreeArchiveLiveServices | undefined,
  onSessionsDestroyed?: () => void,
): Promise<void> {
  if (mode !== 'live-service') {
    return;
  }

  await liveServices?.cleanupLiveState?.(
    projectId,
    worktreeId,
    onSessionsDestroyed,
  );
}

async function prepareWorktreeArchiveContainer(options: {
  workspaceId: string;
  worktreeId: string;
  workspaceType: 'single-repo' | 'multi-repo';
  worktreePath: string;
  persistedWorktree: WorktreeData | null;
  retainAsArchivedContainer: boolean;
  requireArchivedContainer?: boolean;
  captureWorkspaceRootFiles?: boolean;
  managedRepoIds?: readonly string[];
  restoreScope?: 'workspace-root-only';
  lockAfterArchive?: boolean;
}): Promise<PreparedWorktreeArchiveContainer | undefined> {
  if (!options.retainAsArchivedContainer) {
    const discarded = await discardIncompleteArchivedGitCapture(
      options.workspaceId,
      options.worktreeId,
      { allowMissingWorktree: true },
    );
    if (!discarded) {
      throw new Error('An incomplete archived Git capture requires recovery.');
    }
    return undefined;
  }
  if (!options.persistedWorktree) {
    return undefined;
  }
  const retentionDays = await resolveContainerRetentionDays(
    options.workspaceId,
  );

  // Retention may lapse before a failed archive's redo (CAN-5011).
  const committedManifest = await readArchivedContainerManifestIncludingExpired(
    options.workspaceId,
    options.worktreeId,
  ).catch((error: unknown) => {
    if (isErrnoException(error) && error.code === 'ENOENT') return null;
    throw error;
  });
  if (committedManifest) {
    if (
      committedManifest.kind !== 'worktree' ||
      committedManifest.originalWorktree?.createdAt !==
        options.persistedWorktree.createdAt
    ) {
      throw new Error(
        'An archived container with this worktree id already exists.',
      );
    }
    return {
      manifest:
        options.lockAfterArchive === true &&
        committedManifest.lockedAt === undefined
          ? { ...committedManifest, lockedAt: committedManifest.archivedAt }
          : committedManifest,
      warnings: [],
      teardownCompleted: true,
    };
  }

  const capture = options.captureWorkspaceRootFiles
    ? await destructiveCall(
        'retained-payload-capture',
        beginArchivedContainerCapture,
        options.workspaceId,
        options.worktreeId,
        {
          captureWorkspaceRootFiles: true,
          managedRepoIds: options.managedRepoIds,
          expectedCreatedAt: options.persistedWorktree.createdAt,
        },
      )
    : await destructiveCall(
        'retained-payload-capture',
        beginArchivedContainerCapture,
        options.workspaceId,
        options.worktreeId,
        {
          expectedCreatedAt: options.persistedWorktree.createdAt,
        },
      );
  try {
    setArchivePhase('git-capture');
    const persisted = options.persistedWorktree;
    // A files-only restore deliberately stores its old linked .git pointer as
    // evidence outside the checkout. If it is still Git-less, preserve the
    // restored files through the same recovery path on a later archive. An
    // installed pointer always goes through normal Git identity validation.
    // A checkout already absent at admission has no Git effect to attempt.
    // Preserve launch's established sidecar-only reconciliation without turning
    // its expected read-only Git refusal into an uncertain captured effect.
    const staged = hasDestructiveLifecycle()
      ? await readArchivedGitStagedDescriptor(
          options.workspaceId,
          options.worktreeId,
        )
      : null;
    let restoredWithoutGit =
      hasDestructiveLifecycle() &&
      staged?.status !== 'ready' &&
      !staged?.teardown &&
      (await lstat(options.worktreePath).then(
        () => false,
        (error: unknown) => {
          if (isErrnoException(error) && error.code === 'ENOENT') return true;
          throw error;
        },
      ));
    if (
      persisted.restoredFromFilesOnlyArchiveId !== undefined &&
      (await readArchivedGitStagedDescriptor(
        options.workspaceId,
        options.worktreeId,
      )) === null &&
      (await isFilesOnlyRestoreGitless(
        options.worktreePath,
        options.workspaceType,
      ))
    ) {
      restoredWithoutGit = true;
    }
    let gitCapture:
      | ({ version: 2 } & Awaited<
          ReturnType<typeof captureArchivedContainerGitState>
        >)
      | {
          version: 3;
          recovery: Awaited<
            ReturnType<typeof prepareArchivedContainerRecovery>
          >;
        }
      | undefined;
    let gitCaptureError: unknown;
    if (!restoredWithoutGit) {
      try {
        gitCapture = {
          version: 2,
          ...(await destructiveCall(
            'git-capture',
            captureArchivedContainerGitState,
            {
              workspaceId: options.workspaceId,
              containerId: options.worktreeId,
              workspaceType: options.workspaceType,
              worktreePath: options.worktreePath,
              persistedWorktree: options.persistedWorktree,
              allowEmptyRepositories:
                options.restoreScope === 'workspace-root-only',
            },
          )),
        };
      } catch (error) {
        if (!isArchivedGitCaptureRecoveryRequiredError(error)) throw error;
        acknowledgeArchiveCaptureRefusal();
        gitCaptureError = error;
      }
    }
    if (!gitCapture) {
      try {
        setArchivePhase('file-recovery');
        const recovery =
          (await readArchivedContainerRecovery(
            options.workspaceId,
            options.worktreeId,
            options.persistedWorktree,
          )) ??
          (await destructiveCall(
            'file-quarantine',
            prepareArchivedContainerRecovery,
            {
              projectId: options.workspaceId,
              worktreeId: options.worktreeId,
              worktree: persisted,
            },
          ));
        gitCapture = { version: 3, recovery };
      } catch (recoveryError) {
        if (recoveryError instanceof Error) {
          if (gitCaptureError && !('cause' in recoveryError)) {
            Object.assign(recoveryError, { cause: gitCaptureError });
          }
          throw recoveryError;
        }
        throw Object.assign(new Error(String(recoveryError)), {
          ...(gitCaptureError ? { cause: gitCaptureError } : {}),
        });
      }
    }
    // Per-chat archived chats keep their session ids and must resume after a
    // later per-chat restore — capture their provider state alongside the live
    // tabs'.
    const warnings = await destructiveCall(
      'provider-capture',
      captureArchivedContainerProviderState,
      {
        projectId: options.workspaceId,
        containerId: options.worktreeId,
        tabs: [
          ...capture.chats.tabs,
          ...capture.chatArchives.archived.map((entry) => entry.tab),
        ],
        includeClaude: true,
        expectedCreatedAt: options.persistedWorktree.createdAt,
      },
    );
    const timing = createArchivedContainerTiming(retentionDays);
    const branchName = isDefaultWorktreeBranchName(
      persisted.branchName,
      persisted.id,
    )
      ? undefined
      : persisted.branchName;
    const manifestBase = {
      id: options.worktreeId,
      kind: 'worktree' as const,
      projectId: options.workspaceId,
      name: persisted.label ?? persisted.branchName ?? persisted.id,
      ...(persisted.label?.trim() ? { label: persisted.label.trim() } : {}),
      createdAt: persisted.createdAt,
      ...timing,
      ...(options.lockAfterArchive === true
        ? { lockedAt: timing.archivedAt }
        : {}),
      retentionDays,
      ...countCapturedChats(capture),
      executionCount: 0,
      ...(branchName ? { branchName } : {}),
      workspaceType: options.workspaceType,
      ...(options.restoreScope ? { restoreScope: options.restoreScope } : {}),
      originalWorktree: persisted,
    };
    if (!gitCapture) {
      return {
        warnings,
        teardownCompleted: true,
        manifest: {
          version: 1,
          ...manifestBase,
        },
      };
    }
    return {
      warnings,
      manifest: {
        ...gitCapture,
        ...manifestBase,
      },
    };
  } catch (error) {
    // Defer the scheduler-backed service to archive rollback; loading the
    // worktree service must not initialize watcher process lifecycle state.
    const { getAppAdvisorWatcherService } =
      await import('../app-advisor/watchers');
    await getAppAdvisorWatcherService().releaseLocalScopeFence(
      options.workspaceId,
      options.worktreeId,
    );
    throw error;
  }
}

async function resolveArchiveRetentionDecision(options: {
  workspaceId: string;
  worktreeId: string;
  worktreePath: string;
  retainAsArchivedContainer?: boolean;
  deleteWithoutRetentionIfMissing?: boolean;
}): Promise<{
  retainAsArchivedContainer: boolean;
  worktreeMissing: boolean;
}> {
  if (options.retainAsArchivedContainer === false) {
    return { retainAsArchivedContainer: false, worktreeMissing: false };
  }
  if (options.deleteWithoutRetentionIfMissing !== true) {
    return { retainAsArchivedContainer: true, worktreeMissing: false };
  }
  try {
    await lstat(options.worktreePath);
    return { retainAsArchivedContainer: true, worktreeMissing: false };
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      const staged = await readArchivedGitStagedDescriptor(
        options.workspaceId,
        options.worktreeId,
      );
      if (staged?.status === 'ready' && staged.teardown) {
        // A verified or pending archive quarantine owns the missing checkout.
        // Resume its journal instead of treating this as an empty hard delete.
        return { retainAsArchivedContainer: true, worktreeMissing: false };
      }
      return { retainAsArchivedContainer: false, worktreeMissing: true };
    }
    throw error;
  }
}

function createSetupCancellationRef(
  workspaceId: string,
  worktreeId: string,
  persistedWorktree: WorktreeData | null,
  expectedCreatedAt?: string,
): WorktreeSetupCancellationRef | null {
  if (
    expectedCreatedAt &&
    persistedWorktree &&
    persistedWorktree.createdAt !== expectedCreatedAt
  ) {
    throw new Error(
      `Worktree ${worktreeId} changed after archive was requested`,
    );
  }

  const createdAt = persistedWorktree?.createdAt ?? expectedCreatedAt;
  if (!createdAt) {
    return null;
  }

  return {
    workspaceId,
    worktreeId,
    createdAt,
  };
}

function assertAutoArchiveEligibilityUnchanged(
  persistedWorktree: WorktreeData | null,
  options: {
    expectedLastTouchedAt?: string;
    revalidateAutoArchivePolicy?: () => Promise<{ deleteBranch?: boolean }>;
  },
): void {
  if (
    options.expectedLastTouchedAt === undefined &&
    !options.revalidateAutoArchivePolicy
  )
    return;
  if (persistedWorktree?.lastTouchedAt !== options.expectedLastTouchedAt) {
    throw new WorkspaceTargetAutoArchiveExcludedError(
      'Auto Delete eligibility changed before deletion',
    );
  }
}

function cancelPhaseBIfRequested(
  branchName: string | null | typeof PHASE_B_NEEDS_REPAIR,
): string {
  if (branchName === null) {
    throw new Error('Worktree setup was cancelled');
  }
  if (branchName === PHASE_B_NEEDS_REPAIR) {
    throw new Error('Created worktree requires repair.');
  }

  return branchName;
}

function consumeSetupCancellationOnError(
  setupRef: WorktreeSetupCancellationRef | null,
  error: unknown,
): never {
  if (setupRef) {
    consumeWorktreeSetupCancellation(setupRef);
  }
  throw normalizeError(error);
}

function throwRejectedTeardown(
  setupRef: WorktreeSetupCancellationRef | null,
  teardownResult: PromiseSettledResult<unknown>,
): void {
  if (teardownResult.status !== 'rejected') {
    return;
  }

  if (setupRef) {
    consumeWorktreeSetupCancellation(setupRef);
  }
  throw teardownResult.reason instanceof Error
    ? teardownResult.reason
    : new Error(String(teardownResult.reason));
}

/**
 * Tells the Ledger that a worktree was archived with retention or permanently
 * deleted, so its scope becomes read-only or retires. Call only after the
 * container's own commit: the archive manifest for a retained archive, the
 * worktree record's removal for a deletion. `record` identifies the
 * incarnation by its creation time: the manifest, which carries the verified
 * original one, or the deletion's setup reference. The participant returns at
 * once, so no archive lock is held while it waits on Ledger storage.
 */
function notifyLedgerOfWorktreeArchive(
  workspaceId: string,
  worktreeId: string,
  record: { readonly createdAt: string } | null,
  retained: boolean,
): void {
  // Without a persisted record no incarnation is known; startup
  // reconciliation settles any scope left behind.
  if (!record?.createdAt) return;
  try {
    notifyLedgerContainerArchived(
      {
        container: { kind: 'code_worktree', workspaceId, worktreeId },
        containerCreatedAt: record.createdAt,
      },
      { retained },
    );
  } catch {
    // The participant never throws. A defect in it must not fail an archive
    // past its commit point; startup reconciliation settles the scope.
  }
}

/**
 * Journal decisions remain internal and precede Git removal. Carry forward only
 * revisions this attempt itself advanced, so final removal still refuses a
 * concurrent edit without conflicting with its own durable safety journal.
 */
async function updateArchiveJournalRow(
  commit: W5CommitOptions | undefined,
  workspaceId: string,
  worktreeId: string,
  decision: ArchiveJournalDecision,
): Promise<boolean> {
  const stageArchiveJournalRow = (): Promise<boolean> =>
    applyArchiveJournalRecord({ workspaceId, worktreeId }, decision);
  const expected = commit?.expectedRevisions;
  if (!commit || !expected?.length) return stageArchiveJournalRow();
  const advanced = new Set<string>();
  const result = await withW5Commit(
    {
      operation: 'internal.worktree.archive.journal',
      locks: [{ kind: 'list', path: w5RecordReadPaths.worktrees(workspaceId) }],
      expectedRevisions: expected,
    },
    async () => {
      const found = await stageArchiveJournalRow();
      const scope = currentW5CommitScope();
      if (!scope)
        throw new Error('A W5 archive journal requires a commit scope');
      scope.advance.forEach((_resource, key) => {
        advanced.add(key);
      });
      return found;
    },
  );
  commit.expectedRevisions = expected.map((precondition) => ({
    ...precondition,
    revision:
      precondition.revision +
      (advanced.has(w5ResourceKey(precondition.resource)) ? 1 : 0),
  }));
  return result;
}

async function finalizeArchiveCleanup(options: {
  /** Canonical row-removal decision only; never holds locks across teardown. */
  w5Commit?: W5CommitOptions;
  workspaceId: string;
  worktreeId: string;
  mode: 'persisted-only' | 'live-service';
  liveServices?: WorktreeArchiveLiveServices;
  setupRef: WorktreeSetupCancellationRef | null;
  persistedWorktree: WorktreeData | null;
  remainingWorktreeOrder?: readonly string[];
  expectedRemainingWorktreeOrder?: readonly string[];
  cleanupResult: PromiseSettledResult<
    Awaited<ReturnType<typeof cleanupWorktreePipelines>>
  >;
  turnDiffCleanupResult: PromiseSettledResult<void>;
  teardownResult: PromiseSettledResult<string[]>;
  archiveContainer?: PreparedWorktreeArchiveContainer;
  archiveAlreadyCommitted?: boolean;
  onArchiveDeletionCommitted?: () => void;
}): Promise<{
  warnings: string[];
  removedTemporaryWorkspaceId?: string;
  removedTemporaryWorkspaceName?: string;
}> {
  let worktreeRecordRemoved = false;
  setArchivePhase('commit-cleanup');
  try {
    const warnings =
      options.cleanupResult.status === 'fulfilled'
        ? [...options.cleanupResult.value.warnings]
        : [];
    warnings.push(...(options.archiveContainer?.warnings ?? []));

    if (
      options.archiveContainer &&
      options.cleanupResult.status === 'rejected'
    ) {
      throw options.cleanupResult.reason instanceof Error
        ? options.cleanupResult.reason
        : new Error(String(options.cleanupResult.reason));
    }

    if (
      options.archiveContainer &&
      options.cleanupResult.status === 'fulfilled' &&
      options.cleanupResult.value.failedRelocationIds.length > 0
    ) {
      throw new Error(
        `Failed to archive workflow execution artifacts: ${options.cleanupResult.value.failedRelocationIds.join(
          ', ',
        )}`,
      );
    }

    // Git teardown has already crossed its verified quarantine commit point.
    // Publish the manifest before destroying auxiliary live metadata; a commit
    // failure preserves the staged descriptor and refs for an idempotent retry.
    if (options.archiveContainer) {
      if (!options.archiveAlreadyCommitted) {
        const executionCount = await countArchivedContainerExecutions(
          options.workspaceId,
          options.worktreeId,
        );
        await assertArchivedContainerSourceGeneration(
          options.workspaceId,
          options.worktreeId,
          options.archiveContainer.manifest.createdAt,
        );
        await destructiveCall(
          'retained-manifest-commit',
          commitArchivedContainer,
          {
            ...options.archiveContainer.manifest,
            executionCount,
          },
        );
      }
      // The archive has committed, so its scope becomes read-only now and a
      // restore can rebind it even if the cleanup below fails.
      notifyLedgerOfWorktreeArchive(
        options.workspaceId,
        options.worktreeId,
        options.archiveContainer.manifest,
        true,
      );
      // Git quarantine has crossed its commit point; browser profile metadata
      // can no longer fail the archive.
      warnings.push(
        ...(await destructiveCall(
          'browser-retirement',
          commitArchiveBrowserRetirement,
          options.workspaceId,
          options.worktreeId,
          'git_quarantine',
        )),
      );
      if (
        !options.archiveAlreadyCommitted &&
        options.archiveContainer.manifest.version === 2
      ) {
        await destructiveCall(
          'git-capture-completion',
          completeArchivedContainerGitCapture,
          options.workspaceId,
          options.worktreeId,
        );
      }
    }

    warnings.push(
      ...(await destructiveCall(
        'sidecar-cleanup',
        cleanupPersistedWorktreeData,
        options.workspaceId,
        options.worktreeId,
        {
          observabilityMode: options.mode,
          purgeObservabilityData: options.liveServices?.purgeObservabilityData,
          chatSearchDisposition: options.archiveContainer
            ? 'container-archived'
            : 'delete',
          deferLocalWatcherCancellationCommit: true,
        },
      )),
    );
    if (options.turnDiffCleanupResult.status === 'rejected') {
      warnings.push(
        'Failed to remove persisted turn diff tree refs for this worktree.',
      );
    }
    if (options.teardownResult.status === 'fulfilled') {
      warnings.push(...options.teardownResult.value);
    }
    if (options.persistedWorktree) {
      warnings.push(
        ...(await destructiveCall(
          'compatibility-symlinks',
          cleanupCompatibilitySymlinks,
          options.persistedWorktree,
        )),
      );
    }

    if (options.archiveContainer) {
      // Break the worktree-service ↔ chat-search initialization cycle; archive
      // indexing is needed only after the container commit point.
      const { getChatSearchService } = await import('../chat-search/service');
      try {
        await getChatSearchService().worktreeContainerArchived(
          options.workspaceId,
          options.worktreeId,
        );
      } catch (error) {
        const warning =
          'Failed to update the chat search index for this archive.';
        warnings.push(warning);
        logMainProcessWarn(warning, {
          workspaceId: options.workspaceId,
          worktreeId: options.worktreeId,
          error,
        });
      }
      broadcastArchivedContainersChanged(options.workspaceId);
      // Every payload (chats, executions, attachments, workspace-root files)
      // and the Git snapshot are in place; measure the footprint off the
      // removal path so the caller never waits on a directory walk.
      scheduleArchivedContainerDiskUsage(
        options.workspaceId,
        options.worktreeId,
      );
    }

    let setupRecordRemoved = true;
    const removeCanonicalRow = async (): Promise<void> => {
      if (options.archiveAlreadyCommitted) {
        // This read shares the row-removal list lock, so an unreadable sibling
        // cannot be lost between recovery validation and the canonical write.
        const list = await readWorkspaceWorktreesDetailed(options.workspaceId, {
          persistRemovalCleanup: false,
        });
        if (list.authority !== 'ok')
          await refuseInterruptedArchiveJournal(
            options.workspaceId,
            options.worktreeId,
            'row-list-not-authoritative',
          );
      }
      if (options.setupRef) {
        setupRecordRemoved = await removeReservedWorktreeRecordIfCurrent(
          options.setupRef,
          options.remainingWorktreeOrder,
          options.expectedRemainingWorktreeOrder,
        );
      } else {
        await applyArchivedWorktreeRowRemoval(
          { workspaceId: options.workspaceId, worktreeId: options.worktreeId },
          {
            kind: 'worktree.archive.row.remove',
            remainingWorktreeOrder: options.remainingWorktreeOrder,
            expectedRemainingWorktreeOrder:
              options.expectedRemainingWorktreeOrder,
          },
        );
      }
    };
    const commit = options.w5Commit;
    if (commit) {
      await destructiveStep(
        'canonical-row-removal',
        () =>
          withW5Commit(
            {
              ...commit,
              locks: [
                {
                  kind: 'list',
                  path: w5RecordReadPaths.worktrees(options.workspaceId),
                },
              ],
            },
            removeCanonicalRow,
          ),
        true,
      );
    } else
      await destructiveStep('canonical-row-removal', removeCanonicalRow, true);
    if (options.setupRef) {
      if (!setupRecordRemoved) {
        await applyArchiveCleanupTombstone(
          { workspaceId: options.workspaceId, worktreeId: options.worktreeId },
          {
            kind: 'worktree.archive.cleanup.tombstone',
            createdAt: options.setupRef.createdAt,
          },
        );
      }
      consumeWorktreeSetupCancellation(options.setupRef);
    }
    worktreeRecordRemoved = true;
    endWorktreeGitSetup(options.workspaceId, options.worktreeId);
    if (!options.archiveContainer) {
      // The deletion has committed: the worktree record is gone.
      notifyLedgerOfWorktreeArchive(
        options.workspaceId,
        options.worktreeId,
        options.setupRef,
        false,
      );
      // Commit only after the worktree record is irreversibly removed; earlier
      // deletion phases must remain side-effect free.
      warnings.push(
        ...(await destructiveCall(
          'browser-retirement',
          commitArchiveBrowserRetirement,
          options.workspaceId,
          options.worktreeId,
        )),
      );
    }
    warnings.push(
      ...(await destructiveCall(
        'deferred-browser-retirement',
        retireDeferredArchiveBrowserProfile,
        options.workspaceId,
        options.worktreeId,
      )),
    );

    // Persisted chat state and the worktree record are now irreversibly gone.
    // Discard frozen prompts before optional temporary-workspace bookkeeping so
    // a later failure cannot restart work against the deleted scope.
    // Defer the scheduler-backed service until the deletion commit point.
    const { getAppAdvisorWatcherService } =
      await import('../app-advisor/watchers');
    await destructiveStep('watcher-commit', () =>
      getAppAdvisorWatcherService().commitLocalScopeCancellation(
        options.workspaceId,
        options.worktreeId,
      ),
    );
    options.onArchiveDeletionCommitted?.();

    const removedTemporaryWorkspace = await destructiveCall(
      'temporary-workspace-cleanup',
      retryDeferredTemporaryWorkspaceDeletion,
      options.workspaceId,
    );

    if (warnings.some(warningRequiresDestructiveCleanup)) {
      markDestructiveCleanupRequired();
    }
    return {
      warnings,
      ...(removedTemporaryWorkspace
        ? {
            removedTemporaryWorkspaceId: removedTemporaryWorkspace.id,
            removedTemporaryWorkspaceName: removedTemporaryWorkspace.name,
          }
        : {}),
    };
  } catch (error) {
    if (!worktreeRecordRemoved) {
      // Defer the scheduler-backed service until rollback is necessary.
      const { getAppAdvisorWatcherService } =
        await import('../app-advisor/watchers');
      await getAppAdvisorWatcherService().releaseLocalScopeFence(
        options.workspaceId,
        options.worktreeId,
      );
    }
    throw error;
  }
}

export async function retryDeferredTemporaryWorkspaceDeletion(
  workspaceId: string,
): Promise<{ id: string; name: string } | null> {
  const config = await readWorkspaceConfig(workspaceId).catch(() => null);
  if (config?.temporary !== true) {
    return null;
  }
  const worktrees = await readWorkspaceWorktrees(workspaceId);
  if (worktrees.length > 0) {
    return null;
  }
  // Break the worktree-service ↔ archived-containers initialization cycle;
  // this count is needed only for deferred temporary-workspace cleanup.
  const { countArchivedContainers } = await import('./archived-containers');
  if ((await countArchivedContainers(workspaceId)) > 0) {
    return null;
  }
  const { items } = await readAllSidebarItems();
  const workspace = items.find((item) => item.id === workspaceId);
  return {
    id: workspaceId,
    name: workspace?.name ?? workspaceId,
  };
}

async function archiveSingleRepoWorktreeWithoutOperationLock(options: {
  /** Canonical row-removal decision only; never holds locks across teardown. */
  w5Commit?: W5CommitOptions;
  persistedWorktree?: WorktreeData | null;
  workspaceId: string;
  worktreeId: string;
  expectedCreatedAt?: string;
  allowMissingRow?: boolean;
  expectedLastTouchedAt?: string;
  runAutoArchiveTeardown?: () => Promise<void>;
  revalidateAutoArchivePolicy?: () => Promise<{
    deleteBranch?: boolean;
  }>;
  expectedBranchName?: string;
  deleteBranch?: boolean;
  remainingWorktreeOrder?: readonly string[];
  expectedRemainingWorktreeOrder?: readonly string[];
  repoPath?: string;
  observabilityMode?: 'persisted-only' | 'live-service';
  liveServices?: WorktreeArchiveLiveServices;
  retainAsArchivedContainer?: boolean;
  deleteWithoutRetentionIfMissing?: boolean;
  /** Fail before teardown when retention was requested but cannot be prepared. */
  requireArchivedContainer?: boolean;
  lockAfterArchive?: boolean;
  onLiveSessionsDestroyed?: () => void;
  onArchiveDeletionCommitted?: () => void;
}): Promise<ArchiveWorktreeResponse> {
  validateId(options.workspaceId, 'workspaceId');
  validateId(options.worktreeId, 'worktreeId');
  const mode = options.observabilityMode ?? 'persisted-only';
  const persistedWorktree =
    options.persistedWorktree !== undefined
      ? options.persistedWorktree
      : await findPersistedWorktree(options.workspaceId, options.worktreeId);
  assertAutoArchiveEligibilityUnchanged(persistedWorktree, options);
  const currentAutoArchivePolicy =
    await options.revalidateAutoArchivePolicy?.();
  if (currentAutoArchivePolicy) {
    options = {
      ...options,
      deleteBranch: currentAutoArchivePolicy.deleteBranch === true,
    };
  }
  const setupRef = createSetupCancellationRef(
    options.workspaceId,
    options.worktreeId,
    persistedWorktree,
    options.expectedCreatedAt,
  );
  if (setupRef) {
    markWorktreeSetupCancellation(setupRef);
  }

  try {
    if (options.runAutoArchiveTeardown) {
      setArchivePhase('teardown-script');
      await destructiveStep('teardown-script', options.runAutoArchiveTeardown, {
        stepFreeAsFirstChildStep: true,
      });
    }
    setArchivePhase('resource-drain');
    await destructiveCall(
      'live-state-teardown',
      cleanupLiveStateIfNeeded,
      options.workspaceId,
      options.worktreeId,
      mode,
      options.liveServices,
      options.onLiveSessionsDestroyed,
    );
  } catch (error) {
    consumeSetupCancellationOnError(setupRef, error);
  }

  let config: WorkspaceConfigFile;
  let repoPath: string;
  let runtime: ExecutionRuntime;
  let worktreePath: string;
  let archiveContainer: PreparedWorktreeArchiveContainer | undefined;
  let effectiveDeleteBranch = options.deleteBranch;
  let branchPreservationWarning: string | undefined;
  try {
    config = await readWorkspaceConfig(options.workspaceId);
    repoPath = config.repoPath ?? '';
    if (!repoPath) {
      throw new Error(`Project ${options.workspaceId} is missing a repo path`);
    }
    if (options.repoPath && options.repoPath !== repoPath) {
      throw new Error(
        'Cannot archive the worktree because the requested repository does not match the project repository.',
      );
    }
    runtime = runtimeForMode(mode);
    worktreePath = getWorktreeDir(options.workspaceId, options.worktreeId);
    const retentionDecision = await resolveArchiveRetentionDecision({
      workspaceId: options.workspaceId,
      worktreeId: options.worktreeId,
      worktreePath,
      retainAsArchivedContainer: options.retainAsArchivedContainer,
      deleteWithoutRetentionIfMissing: options.deleteWithoutRetentionIfMissing,
    });
    if (retentionDecision.worktreeMissing && options.deleteBranch === true) {
      effectiveDeleteBranch = false;
      branchPreservationWarning =
        'The local branch was preserved because its deletion could not be safely verified.';
    }
    archiveContainer = await prepareWorktreeArchiveContainer({
      workspaceId: options.workspaceId,
      worktreeId: options.worktreeId,
      workspaceType: 'single-repo',
      worktreePath,
      persistedWorktree,
      retainAsArchivedContainer: retentionDecision.retainAsArchivedContainer,
      requireArchivedContainer: options.requireArchivedContainer,
      lockAfterArchive: options.lockAfterArchive,
    });
    if (options.requireArchivedContainer && !archiveContainer) {
      throw new Error(
        'Cannot archive this worktree because it is not registered in the project.',
      );
    }
  } catch (error) {
    consumeSetupCancellationOnError(setupRef, error);
  }

  if (!archiveContainer || archiveContainer.teardownCompleted) {
    // Defer scheduler initialization until deletion admission is fenced.
    const { getAppAdvisorWatcherService } =
      await import('../app-advisor/watchers');
    await getAppAdvisorWatcherService().cancelLocalScope(
      options.workspaceId,
      options.worktreeId,
    );
  }

  const deletionUsageRepos = await captureWorktreeDeletionUsageSnapshot(
    options.workspaceId,
    options.worktreeId,
    config,
  ).catch((error) => {
    // eslint-disable-next-line no-console
    console.warn('Failed to capture worktree deletion usage snapshot.', {
      workspaceId: options.workspaceId,
      worktreeId: options.worktreeId,
      error: getErrorLogDetails(error),
    });
    return null;
  });

  const verifyWriters = retainedArchiveWriterVerification(
    worktreePath,
    archiveContainer,
  );
  const [teardownResult] = await settleEach([
    verifyWriters(async (): Promise<string[]> => {
      setArchivePhase('teardown');
      if (archiveContainer?.teardownCompleted) return [];
      if (archiveContainer?.manifest.version === 3) {
        return destructiveCall(
          'retained-git-cleanup',
          finishArchivedContainerRecovery,
          archiveContainer.manifest,
        );
      }
      if (archiveContainer?.manifest.version === 2) {
        const archivePrefs = await readArchivePreferences();
        const requestedBranchDeletionMode = resolveArchiveBranchDeletionMode(
          effectiveDeleteBranch,
          archivePrefs.deleteBranchOnArchive,
        );
        const expectedBranchName = normalizeRequestedBranch(
          options.expectedBranchName,
        );
        if (
          expectedBranchName &&
          archiveContainer.manifest.gitState.repositories.some(
            (repository) => repository.branchName !== expectedBranchName,
          )
        ) {
          throw new Error(
            `Cannot safely archive the worktree because its branch changed after deletion was confirmed for "${expectedBranchName}".`,
          );
        }
        const teardown = await destructiveCall(
          'checkout-quarantine',
          prepareArchivedContainerTeardown,
          {
            workspaceId: options.workspaceId,
            containerId: options.worktreeId,
            workspaceType: 'single-repo',
            gitState: archiveContainer.manifest.gitState,
            expectedCreatedAt: archiveContainer.manifest.createdAt,
            deleteBranches:
              effectiveDeleteBranch === false
                ? false
                : requestedBranchDeletionMode
                  ? true
                  : undefined,
            branchDeletionMode: requestedBranchDeletionMode,
          },
        );
        const pendingBranchDeletions = teardown.pendingBranchDeletions ?? [];
        let warnings: string[] = [];
        if (!teardown.alreadyRemoved) {
          const target = teardown.targets.find(
            (candidate) => candidate.repoId === SINGLE_REPO_USAGE_REPO_ID,
          );
          if (!target) {
            throw new Error(
              'Archived single-repository teardown target is missing.',
            );
          }
          warnings = await destructiveCall(
            'git-worktree-removal',
            removeArchivedWorktreeWithWorker,
            {
              projectId: options.workspaceId,
              containerId: options.worktreeId,
              expectedCreatedAt: archiveContainer.manifest.createdAt,
              repoId: target.repoId,
              referenceRepoPath: target.referenceRepoPath,
              worktreePath: target.quarantineRepoPath,
              preMoveWorktreePath: target.preMoveRepoPath,
            },
          );
          // A tolerated Git-removal residue is not a completed archive teardown.
          // Keep the verified journal and refs until the quarantine is truly gone.
          await destructiveCall(
            'quarantine-directory-removal',
            removeArchivedDirectoryWithWorker,
            {
              projectId: options.workspaceId,
              containerId: options.worktreeId,
              expectedCreatedAt: archiveContainer.manifest.createdAt,
              path: teardown.quarantinePath,
            },
          );
          if (target.branchName && pendingBranchDeletions.length === 0) {
            const branchDeleter = resolveArchiveBranchDeleter(
              effectiveDeleteBranch,
              archivePrefs.deleteBranchOnArchive,
            );
            if (branchDeleter) {
              await destructiveCall(
                'branch-deletion',
                deleteArchivedBranch,
                branchDeleter,
                target.referenceRepoPath,
                target.branchName,
                effectiveDeleteBranch === true,
              );
            }
          }
        }
        await destructiveCall(
          'branch-deletion',
          deleteArchivedBranchesWithWorker,
          {
            projectId: options.workspaceId,
            containerId: options.worktreeId,
            expectedCreatedAt: archiveContainer.manifest.createdAt,
            branches: pendingBranchDeletions,
            mode: teardown.branchDeletionMode ?? 'force',
          },
        );
        return warnings;
      }
      const warnings = branchPreservationWarning
        ? [branchPreservationWarning]
        : [];
      const hasPersistedPendingBranchDeletion =
        persistedWorktree?.pendingArchiveBranchDeletion !== undefined;
      const shouldDeleteBranch =
        effectiveDeleteBranch === true ||
        (effectiveDeleteBranch === undefined &&
          hasPersistedPendingBranchDeletion);
      let pendingBranchDeletion = shouldDeleteBranch
        ? await normalizePendingArchiveBranchDeletion(
            persistedWorktree?.pendingArchiveBranchDeletion,
          )
        : undefined;
      if (
        shouldDeleteBranch &&
        hasPersistedPendingBranchDeletion &&
        !pendingBranchDeletion
      ) {
        throw new Error(
          `Cannot safely delete local branch "${persistedWorktree.branchName}" because its pending deletion journal is invalid or its repository is unavailable.`,
        );
      }
      if (
        pendingBranchDeletion &&
        pendingBranchDeletion.referenceRepoPath !== repoPath
      ) {
        throw new Error(
          `Cannot safely delete local branch "${pendingBranchDeletion.branchName}" because its pending deletion repository no longer matches the project repository.`,
        );
      }
      if (
        effectiveDeleteBranch === false &&
        persistedWorktree?.pendingArchiveBranchDeletion !== undefined
      ) {
        const cleared = await updateArchiveJournalRow(
          options.w5Commit,
          options.workspaceId,
          options.worktreeId,
          {
            kind: 'worktree.archive.journal.clear',
            workspaceKind: 'single-repo',
          },
        );
        if (!cleared) {
          throw new Error(
            'Cannot safely preserve the local branch because its pending deletion journal could not be cleared.',
          );
        }
      }
      let branchToDelete = pendingBranchDeletion?.branchName ?? null;
      let currentBranch: string | null = null;
      let currentBranchIsDetached = false;
      const expectedBranchName = normalizeRequestedBranch(
        options.expectedBranchName,
      );
      try {
        const branch = await getCurrentBranch(worktreePath);
        if (branch === 'HEAD') {
          currentBranchIsDetached = true;
        } else if (branch) {
          currentBranch = branch;
        }
      } catch {
        // Worktree may already be gone.
      }

      if (expectedBranchName && currentBranchIsDetached) {
        throw new Error(
          `Cannot safely archive the worktree because its branch changed after deletion was confirmed for "${expectedBranchName}".`,
        );
      }

      if (currentBranch) {
        if (expectedBranchName && currentBranch !== expectedBranchName) {
          throw new Error(
            `Cannot safely archive the worktree because its branch changed after deletion was confirmed for "${expectedBranchName}".`,
          );
        }
        branchToDelete = currentBranch;
        if (shouldDeleteBranch) {
          if (
            pendingBranchDeletion &&
            pendingBranchDeletion.branchName !== currentBranch
          ) {
            throw new Error(
              `Cannot safely delete local branch "${pendingBranchDeletion.branchName}" because the worktree branch changed after deletion was confirmed.`,
            );
          }
          const currentBranchTip = await resolveRefSha(
            pendingBranchDeletion?.referenceRepoPath ?? repoPath,
            `refs/heads/${currentBranch}`,
          );
          if (
            pendingBranchDeletion &&
            pendingBranchDeletion.expectedTip !== currentBranchTip
          ) {
            throw new Error(
              `Cannot safely delete local branch "${currentBranch}" because it changed after deletion was confirmed.`,
            );
          }
          if (!pendingBranchDeletion) {
            const capturedDeletion = {
              referenceRepoPath: repoPath,
              repositoryIdentity: await getGitCommonDir(repoPath),
              branchName: currentBranch,
              expectedTip: currentBranchTip,
            };
            const persisted = await updateArchiveJournalRow(
              options.w5Commit,
              options.workspaceId,
              options.worktreeId,
              {
                kind: 'worktree.archive.journal.record',
                workspaceKind: 'single-repo',
                pendingBranchDeletion: capturedDeletion,
              },
            );
            if (!persisted) {
              throw new Error(
                `Cannot safely delete local branch "${currentBranch}" because its archived tip could not be persisted.`,
              );
            }
            pendingBranchDeletion = capturedDeletion;
          }
        }
      }

      if (
        expectedBranchName &&
        pendingBranchDeletion &&
        pendingBranchDeletion.branchName !== expectedBranchName
      ) {
        throw new Error(
          `Cannot safely archive the worktree because its pending deletion branch does not match the confirmed branch "${expectedBranchName}".`,
        );
      }

      if (
        shouldDeleteBranch &&
        persistedWorktree?.branchName &&
        !pendingBranchDeletion
      ) {
        throw new Error(
          `Cannot safely delete local branch "${persistedWorktree.branchName}" because its archived tip was not recorded.`,
        );
      }

      warnings.push(
        ...(await destructiveCall(
          'checkout-removal',
          safeRemoveWorktree,
          repoPath,
          worktreePath,
          {
            workspaceId: options.workspaceId,
            worktreeId: options.worktreeId,
          },
        )),
      );

      if (branchToDelete) {
        if (shouldDeleteBranch && pendingBranchDeletion) {
          if (
            await doesLocalBranchExist(
              pendingBranchDeletion.referenceRepoPath,
              pendingBranchDeletion.branchName,
            )
          ) {
            await destructiveCall(
              'branch-deletion',
              deleteBranchIfMatches,
              pendingBranchDeletion.referenceRepoPath,
              pendingBranchDeletion.branchName,
              pendingBranchDeletion.expectedTip,
            );
          }
        } else {
          const prefs = await readArchivePreferences();
          const branchDeleter = resolveArchiveBranchDeleter(
            effectiveDeleteBranch,
            prefs.deleteBranchOnArchive,
          );
          if (branchDeleter) {
            await destructiveCall(
              'branch-deletion',
              deleteArchivedBranch,
              branchDeleter,
              repoPath,
              branchToDelete,
              false,
            );
          }
        }
      }
      return warnings;
    }),
  ]);

  if (teardownResult.status === 'rejected') {
    // Defer scheduler initialization until a failed teardown needs rollback.
    const { getAppAdvisorWatcherService } =
      await import('../app-advisor/watchers');
    await getAppAdvisorWatcherService().releaseLocalScopeFence(
      options.workspaceId,
      options.worktreeId,
    );
  }
  throwRejectedTeardown(setupRef, teardownResult);
  // Do not delete pipeline artifacts or persisted diff refs until the checkout
  // teardown has succeeded (or completed with a tolerated residue warning).
  const [cleanupResult, turnDiffCleanupResult] = await settleEach([
    destructiveCall(
      'pipeline-cleanup',
      cleanupWorktreePipelines,
      options.workspaceId,
      options.worktreeId,
      runtime,
      {
        ...(archiveContainer
          ? {
              relocateArtifactsTo: getArchivedContainerExecutionsDir(
                options.workspaceId,
                options.worktreeId,
              ),
              archiveCaptureExecutor: (executionId, input): Promise<void> =>
                copyArchivedPipelinePayloadWithWorker({
                  projectId: options.workspaceId,
                  containerId: options.worktreeId,
                  expectedCreatedAt: archiveContainer.manifest.createdAt,
                  executionId,
                  input,
                }),
            }
          : {}),
      },
    ),
    destructiveCleanup('turn-diff-cleanup', () =>
      cleanupPersistedTurnDiffTreeRefs(
        repoPath,
        options.workspaceId,
        options.worktreeId,
      ),
    ),
  ]);
  const cleanup = await finalizeArchiveCleanup({
    w5Commit: options.w5Commit,
    workspaceId: options.workspaceId,
    worktreeId: options.worktreeId,
    mode,
    liveServices: options.liveServices,
    setupRef,
    persistedWorktree,
    remainingWorktreeOrder: options.remainingWorktreeOrder,
    expectedRemainingWorktreeOrder: options.expectedRemainingWorktreeOrder,
    cleanupResult,
    turnDiffCleanupResult,
    teardownResult,
    archiveContainer,
    onArchiveDeletionCommitted: options.onArchiveDeletionCommitted,
  });

  if (deletionUsageRepos) {
    recordCompletedWorktreeDeletionUsage({
      workspaceId: options.workspaceId,
      worktreeId: options.worktreeId,
      createdAt: persistedWorktree?.createdAt ?? options.expectedCreatedAt,
      repos: deletionUsageRepos,
    });
  }

  return { success: true, ...cleanup };
}

function archiveTurnDiffRefusal(
  check:
    | 'turn-diff-identity-unverified'
    | 'turn-diff-evidence-unavailable'
    | 'turn-diff-repository-replaced'
    | 'turn-diff-repositories-unknown',
): W5CommitRefusedError {
  return new W5CommitRefusedError(
    'recovery-required',
    'Archived turn diff repository evidence needs recovery.',
    { phase: 'archive-journal', check },
  );
}

/** Never target mutable project configuration when repairing historical Git debt. */
async function repairArchiveTurnDiffRefs(
  workspaceId: string,
  worktreeId: string,
  manifest: ArchivedContainerManifestV2 | ArchivedContainerRecoveryManifest,
): Promise<void> {
  const repositories: string[] = [];
  if (manifest.version === 2) {
    const { inspectArchivedContainerSnapshotRef } =
      await import('./archived-container-git');
    for (const repository of manifest.gitState.repositories) {
      const witness = await inspectArchivedContainerSnapshotRef({
        repoPath: repository.referenceRepoPath,
        refName: repository.snapshotRef,
        expectedCommit: repository.worktreeSnapshotCommit,
      }).catch(() => {
        throw archiveTurnDiffRefusal('turn-diff-identity-unverified');
      });
      if (witness.ref !== 'expected' || !witness.commitPresent)
        throw archiveTurnDiffRefusal('turn-diff-identity-unverified');
      repositories.push(repository.referenceRepoPath);
    }
  } else {
    const journal = await readArchivedContainerRecoveryJournal(
      workspaceId,
      worktreeId,
    ).catch(() => {
      throw archiveTurnDiffRefusal('turn-diff-evidence-unavailable');
    });
    if (
      !journal ||
      journal.createdAt !== manifest.createdAt ||
      journal.phase !== 'removed' ||
      journal.recovery.payloadId !== manifest.recovery.payloadId ||
      journal.recovery.digest !== manifest.recovery.digest ||
      journal.recovery.source !== manifest.recovery.source
    )
      throw archiveTurnDiffRefusal('turn-diff-evidence-unavailable');
    for (const repository of journal.repositories) {
      const identity = repository.repositoryIdentity;
      if (!identity)
        throw archiveTurnDiffRefusal('turn-diff-identity-unverified');
      const { getGitCommonDir } = await import('./git');
      const commonDir = await getGitCommonDir(
        repository.referenceRepoPath,
      ).catch(() => null);
      if (!commonDir)
        throw archiveTurnDiffRefusal('turn-diff-identity-unverified');
      if (commonDir !== identity)
        throw archiveTurnDiffRefusal('turn-diff-repository-replaced');
      if (
        !repository.repositoryStatIdentity ||
        (await readDirectoryStatIdentity(identity)) !==
          repository.repositoryStatIdentity
      )
        throw archiveTurnDiffRefusal('turn-diff-repository-replaced');
      repositories.push(repository.referenceRepoPath);
    }
  }
  if (repositories.length === 0)
    throw archiveTurnDiffRefusal('turn-diff-repositories-unknown');
  for (const repository of new Set(repositories))
    await cleanupPersistedTurnDiffTreeRefs(repository, workspaceId, worktreeId);
}

async function repairArchiveBrowserRetirement(
  workspaceId: string,
  worktreeId: string,
): Promise<void> {
  await destructiveStep('deferred-browser-retirement', async () => {
    try {
      const { retireRemovedBrowserTask } =
        await import('../browser/browser-profile-lifecycle');
      await withBrowserRetirementDeadline(() =>
        retireRemovedBrowserTask(workspaceId, worktreeId),
      );
    } catch (error) {
      markDestructiveCleanupRequired();
      throw error;
    }
  });
}

/** Called only under the existing worktree deletion and archive locks. */
export async function finishInterruptedArchiveCleanup(
  options: {
    workspaceId: string;
    worktreeId: string;
    expectedCreatedAt?: string;
    exactJournal?: ExactArchiveJournal;
    w5Commit?: W5CommitOptions;
    observabilityMode?: 'persisted-only' | 'live-service';
    liveServices?: WorktreeArchiveLiveServices;
    remainingWorktreeOrder?: readonly string[];
    expectedRemainingWorktreeOrder?: readonly string[];
  },
  onLiveSessionsDestroyed: () => void,
  onArchiveDeletionCommitted: () => void,
): Promise<ArchiveWorktreeResponse | null> {
  const record =
    options.exactJournal?.record ??
    (await readDestructiveRecovery(options.workspaceId, options.worktreeId));
  if (
    !record ||
    (!options.exactJournal &&
      (record.state === 'completed' ||
        record.cleanupRepair !== undefined ||
        canResumeFailedChildArchive(record) ||
        canResumeInterruptedArchive(record)))
  )
    return null;
  let manifestCheck = 'manifest-absent';
  const manifest = await readArchivedContainerManifestIncludingExpired(
    options.workspaceId,
    options.worktreeId,
  ).catch((error: unknown) => {
    manifestCheck =
      isErrnoException(error) && error.code === 'ENOENT'
        ? 'manifest-absent'
        : 'manifest-unreadable';
    return null;
  });
  const archiveManifestVersion =
    manifest?.version === 2 || manifest?.version === 3
      ? manifest.version
      : undefined;
  const readTarget = async (): Promise<WorktreeData | null> => {
    const list = await readWorkspaceWorktreesDetailed(options.workspaceId, {
      persistRemovalCleanup: false,
    });
    if (list.authority !== 'ok') {
      await refuseInterruptedArchiveJournal(
        options.workspaceId,
        options.worktreeId,
        'row-list-not-authoritative',
      );
      return null;
    }
    return list.worktrees.find((row) => row.id === options.worktreeId) ?? null;
  };
  const target = await readTarget();
  const failedCheck = (
    [
      [manifestCheck, !manifest],
      [
        'manifest-kind',
        archiveManifestVersion === undefined || manifest?.kind !== 'worktree',
      ],
      [
        'manifest-created-at-mismatch',
        manifest?.createdAt !== record.createdAt ||
          manifest?.originalWorktree?.createdAt !== record.createdAt,
      ],
      [
        'expected-created-at-mismatch',
        options.expectedCreatedAt !== undefined &&
          options.expectedCreatedAt !== record.createdAt,
      ],
      [
        'row-created-at-mismatch',
        target !== null && target.createdAt !== record.createdAt,
      ],
      [
        'row-removal-not-journaled',
        !target &&
          !options.exactJournal &&
          !record.steps.some((step) => step.phase === 'canonical-row-removal'),
      ],
    ] as const
  ).find(([, failed]) => failed)?.[0];
  if (
    !manifest ||
    manifest.version === 1 ||
    archiveManifestVersion === undefined ||
    failedCheck
  ) {
    await refuseInterruptedArchiveJournal(
      options.workspaceId,
      options.worktreeId,
      failedCheck ?? 'manifest-unreadable',
    );
    return null;
  }
  const wasCompleted =
    record.state === 'completed' ||
    record.cleanupRepair?.kind === 'completed-cleanup';
  if (wasCompleted && target)
    await refuseInterruptedArchiveJournal(
      options.workspaceId,
      options.worktreeId,
      'completed-repair-row-listed',
    );
  return withDestructiveLifecycle(
    {
      operation: 'worktree-archive',
      workspaceId: options.workspaceId,
      worktreeId: options.worktreeId,
      createdAt: manifest.createdAt,
      allowMissingRow: !target,
      resumeArchiveCleanup: true,
      exactJournal: options.exactJournal,
      archiveManifestVersion,
      readCreatedAt: async () => (await readTarget())?.createdAt ?? null,
      beforeEffects: options.w5Commit?.beforeDecision,
    },
    async () => {
      setArchivePhase('commit-cleanup');
      const mode = options.observabilityMode ?? 'persisted-only';
      if (wasCompleted && options.exactJournal)
        record.cleanupRepair = { kind: 'completed-cleanup' };
      const hadCleanupMarker = record.cleanupRequired === true;
      const identifiedDebt = record.steps.some(
        (step) =>
          (step.phase === 'turn-diff-cleanup' && step.state !== 'done') ||
          step.phase === 'deferred-browser-retirement',
      );
      if (
        record.steps.some(
          (step) => step.phase === 'turn-diff-cleanup' && step.state !== 'done',
        )
      ) {
        await destructiveTurnDiffCleanupRepair(() =>
          repairArchiveTurnDiffRefs(
            options.workspaceId,
            options.worktreeId,
            manifest,
          ),
        );
      }

      if (wasCompleted && options.exactJournal) {
        await repairArchiveBrowserRetirement(
          options.workspaceId,
          options.worktreeId,
        );
        if (identifiedDebt) await settleDestructiveCleanupDebt();
        const previousOutcome = destructiveArchiveOutcomeSchema.safeParse(
          record.outcome,
        );
        return {
          success: true,
          warnings: previousOutcome.success
            ? previousOutcome.data.warnings.filter(
                (warning) =>
                  !warningRequiresDestructiveCleanup(warning) &&
                  warning !== DEFERRED_BROWSER_RETIREMENT_WARNING,
              )
            : [],
        };
      }
      await destructiveCall(
        'live-state-teardown',
        cleanupLiveStateIfNeeded,
        options.workspaceId,
        options.worktreeId,
        mode,
        options.liveServices,
        onLiveSessionsDestroyed,
      );
      const response = await finalizeArchiveCleanup({
        ...options,
        w5Commit: options.w5Commit ?? { operation: 'core.worktree.archive' },
        mode,
        setupRef: {
          workspaceId: options.workspaceId,
          worktreeId: options.worktreeId,
          createdAt: manifest.createdAt,
        },
        persistedWorktree: target,
        archiveContainer: { manifest, warnings: [] },
        archiveAlreadyCommitted: true,
        cleanupResult: {
          status: 'fulfilled',
          value: { warnings: [], relocatedCount: 0, failedRelocationIds: [] },
        },
        turnDiffCleanupResult: { status: 'fulfilled', value: undefined },
        teardownResult: { status: 'fulfilled', value: [] },
        onArchiveDeletionCommitted,
      });
      if (options.exactJournal) {
        // The transient deferred wrapper is not evidence of owner-level settlement.
        await repairArchiveBrowserRetirement(
          options.workspaceId,
          options.worktreeId,
        );
        if (!hadCleanupMarker || identifiedDebt)
          await settleDestructiveCleanupDebt();
      }
      return { success: true, ...response };
    },
  );
}

export const WORKTREE_ARCHIVE_SOURCE_UNAVAILABLE_MESSAGE =
  "Couldn't verify the worktree's source repositories. Check repository access and retry.";

/**
 * Read-only source admission for ordinary removal: the first of
 * `worktreeIds` whose archive would be refused as `source-unavailable`, or
 * `undefined`. It has no effects and reserves nothing; the archive admits again.
 */
export async function findWorktreeArchiveSourceRefusal(
  workspaceId: string,
  worktreeIds: readonly string[],
  kind: 'single-repo' | 'multi-repo',
): Promise<string | undefined> {
  if (worktreeIds.length === 0) return undefined;
  const list = await readWorkspaceWorktreesDetailed(workspaceId, {
    persistRemovalCleanup: false,
  });
  const available = new Set<string>();
  for (const worktreeId of worktreeIds) {
    const target = list.worktrees.find((row) => row.id === worktreeId);
    if (!target) {
      // An unreadable or partial list cannot prove the row absent.
      if (list.authority === 'unreadable' || list.authority === 'partial')
        return worktreeId;
      // The lifecycle still validates absent rows and committed cleanup retries.
      continue;
    }
    if (
      await isWorktreeArchiveSourceUnavailable(
        workspaceId,
        target,
        kind,
        available,
      )
    )
      return worktreeId;
  }
  return undefined;
}

/**
 * CAN-5334: a confirmed discard's effects, inside its discard lifecycle,
 * the deletion envelope and the archive lock. Live state goes first, then
 * `removeTargets` (the discard's own steps), then the existing no-retention
 * tail through its owners: best-effort pipeline and turn diff cleanup, the
 * sidecar cleanup with chat search `delete`, compatibility symlinks and the
 * canonical row removal with its cleanup tombstone. A resumed discard whose
 * row is gone passes a null `persistedWorktree`.
 */
export async function runWorktreeDiscardTail(options: {
  workspaceId: string;
  worktreeId: string;
  createdAt: string;
  persistedWorktree: WorktreeData | null;
  turnDiffRepoPaths: readonly string[];
  liveServices: WorktreeArchiveLiveServices;
  onLiveSessionsDestroyed: () => void;
  onArchiveDeletionCommitted: () => void;
  removeTargets: () => Promise<string[]>;
}): Promise<ArchiveWorktreeResponse> {
  const { workspaceId, worktreeId } = options;
  const setupRef: WorktreeSetupCancellationRef = {
    workspaceId,
    worktreeId,
    createdAt: options.createdAt,
  };
  markWorktreeSetupCancellation(setupRef);
  try {
    setArchivePhase('resource-drain');
    await destructiveCall(
      'live-state-teardown',
      cleanupLiveStateIfNeeded,
      workspaceId,
      worktreeId,
      'live-service',
      options.liveServices,
      options.onLiveSessionsDestroyed,
    );
  } catch (error) {
    consumeSetupCancellationOnError(setupRef, error);
  }
  // Defer scheduler initialization until deletion admission is fenced.
  const { getAppAdvisorWatcherService } =
    await import('../app-advisor/watchers');
  let warnings: string[];
  try {
    // The fence is held before its fallible store and scheduler steps.
    await getAppAdvisorWatcherService().cancelLocalScope(
      workspaceId,
      worktreeId,
    );
    setArchivePhase('teardown');
    warnings = await withLinuxWorktreeRemovalVerification(
      getWorktreeDir(workspaceId, worktreeId),
      options.removeTargets,
    );
  } catch (error) {
    await getAppAdvisorWatcherService().releaseLocalScopeFence(
      workspaceId,
      worktreeId,
    );
    consumeSetupCancellationOnError(setupRef, error);
  }
  const runtime = runtimeForMode('live-service');
  const [cleanupResult, turnDiffCleanupResult] = await settleEach([
    destructiveStep(
      'pipeline-cleanup',
      () => cleanupWorktreePipelines(workspaceId, worktreeId, runtime, {}),
      { bestEffort: true },
    ),
    settleAll(
      options.turnDiffRepoPaths.map((repoPath) =>
        destructiveStep(
          'turn-diff-cleanup',
          () =>
            cleanupPersistedTurnDiffTreeRefs(repoPath, workspaceId, worktreeId),
          { bestEffort: true },
        ),
      ),
    ).then(() => undefined),
  ]);
  const cleanup = await finalizeArchiveCleanup({
    w5Commit: { operation: 'core.worktree.discard' },
    workspaceId,
    worktreeId,
    mode: 'live-service',
    liveServices: options.liveServices,
    setupRef,
    persistedWorktree: options.persistedWorktree,
    cleanupResult,
    turnDiffCleanupResult,
    teardownResult: { status: 'fulfilled', value: warnings },
    onArchiveDeletionCommitted: options.onArchiveDeletionCommitted,
  });
  return { success: true, ...cleanup };
}

/** Ordinary removal checks before chat, browser, activity or archive lifecycles. */
async function admitWorktreeArchiveSource(
  options: {
    workspaceId: string;
    worktreeId: string;
  },
  kind: 'single-repo' | 'multi-repo',
): Promise<void> {
  if (
    (await findWorktreeArchiveSourceRefusal(
      options.workspaceId,
      [options.worktreeId],
      kind,
    )) !== undefined
  ) {
    throw new WorktreeArchiveRefusedError(
      'source-unavailable',
      WORKTREE_ARCHIVE_SOURCE_UNAVAILABLE_MESSAGE,
    );
  }
}

export async function archiveSingleRepoWorktree(
  options: {
    /** Canonical row-removal decision only; never holds locks across teardown. */
    w5Commit?: W5CommitOptions;
    /** Required by ordinary removal; internal recovery callers retain compatibility behavior. */
    sourceAdmission?: 'required';
    archiveTrigger?: ArchiveTrigger;
    workspaceId: string;
    worktreeId: string;
    expectedCreatedAt?: string;
    /** Internal needs-repair rollback only; never set from a request. */
    allowMissingRow?: boolean;
    expectedLastTouchedAt?: string;
    runAutoArchiveTeardown?: () => Promise<void>;
    revalidateAutoArchivePolicy?: () => Promise<{
      deleteBranch?: boolean;
    }>;
    expectedBranchName?: string;
    deleteBranch?: boolean;
    remainingWorktreeOrder?: readonly string[];
    expectedRemainingWorktreeOrder?: readonly string[];
    repoPath?: string;
    observabilityMode?: 'persisted-only' | 'live-service';
    liveServices?: WorktreeArchiveLiveServices;
    retainAsArchivedContainer?: boolean;
    deleteWithoutRetentionIfMissing?: boolean;
    /** Fail before teardown when retention was requested but cannot be prepared. */
    requireArchivedContainer?: boolean;
    lockAfterArchive?: boolean;
  },
  telemetry?: ArchiveFailureTelemetryOptions,
): Promise<ArchiveWorktreeResponse> {
  return withArchiveFailureTelemetry(
    options,
    () => archiveSingleRepoWorktreeAdmitted(options),
    telemetry,
  );
}

async function archiveSingleRepoWorktreeAdmitted(
  options: Parameters<typeof archiveSingleRepoWorktree>[0],
): Promise<ArchiveWorktreeResponse> {
  // Internal recovery must still enter the removal-pending lifecycle synchronously.
  if (options.sourceAdmission === 'required')
    await admitWorktreeArchiveSource(options, 'single-repo');
  return runWithWorktreeArchiveDeletionLifecycle(
    options.workspaceId,
    options.worktreeId,
    (onLiveSessionsDestroyed, onArchiveDeletionCommitted) =>
      withArchivedWorkspaceOperationLock(options.workspaceId, async () => {
        const recovered = await finishInterruptedArchiveCleanup(
          options,
          onLiveSessionsDestroyed,
          onArchiveDeletionCommitted,
        );
        if (recovered) return recovered;
        await assertNoDestructiveRecovery(
          options.workspaceId,
          options.worktreeId,
        );
        const target = await findPersistedWorktree(
          options.workspaceId,
          options.worktreeId,
        );
        await assertNoLegacyArchiveRecovery(
          options.workspaceId,
          options.worktreeId,
          { admitMissingCheckoutCapture: true },
        );
        return withDestructiveLifecycle(
          {
            operation:
              options.retainAsArchivedContainer === false
                ? 'worktree-delete'
                : 'worktree-archive',
            trigger: options.archiveTrigger ?? 'manual',
            workspaceId: options.workspaceId,
            worktreeId: options.worktreeId,
            createdAt: target?.createdAt ?? options.expectedCreatedAt,
            allowMissingRow: options.allowMissingRow,
            readCreatedAt: async () =>
              (
                await findPersistedWorktree(
                  options.workspaceId,
                  options.worktreeId,
                )
              )?.createdAt ?? null,
            beforeEffects: options.w5Commit?.beforeDecision,
            replay: (outcome) => destructiveArchiveOutcomeSchema.parse(outcome),
          },
          async () => {
            await protectDestructivePath(
              getWorkspaceWorktreeDir(options.workspaceId, options.worktreeId),
            );
            await protectDestructivePath(
              getWorktreeDataDir(options.workspaceId, options.worktreeId),
              true,
            );
            return archiveSingleRepoWorktreeWithoutOperationLock({
              ...options,
              persistedWorktree: target,
              expectedCreatedAt: options.expectedCreatedAt ?? target?.createdAt,
              onLiveSessionsDestroyed,
              onArchiveDeletionCommitted,
            });
          },
        );
      }),
    { telemetryParent: 'inherit' },
  );
}

/**
 * The worktree deletion envelope (removal-pending row, chat/activity/queue and
 * browser fences, archive drain) that archive, delete and the CAN-5334
 * discard share. Never for a read: it hides the row at once.
 */
export function runWithWorktreeArchiveDeletionLifecycle<T>(
  workspaceId: string,
  worktreeId: string,
  archiveOperation: (
    onLiveSessionsDestroyed: () => void,
    onArchiveDeletionCommitted: () => void,
  ) => Promise<T>,
  telemetry?: ArchiveFailureTelemetryOptions,
): Promise<T> {
  // Admitted before teardown: archive ends by publishing the worktree list.
  // Admission starts the lifecycle synchronously unless ownership is changing.
  return withArchiveFailureTelemetry(
    { workspaceId, worktreeId },
    () =>
      withStorageAdmission([WORKTREE_LIST_STORAGE], () =>
        runAsLocalFenceHolder(() =>
          runAdmittedArchiveDeletionLifecycle(
            workspaceId,
            worktreeId,
            archiveOperation,
          ),
        ),
      ),
    telemetry,
  );
}

async function runAdmittedArchiveDeletionLifecycle<T>(
  workspaceId: string,
  worktreeId: string,
  archiveOperation: (
    onLiveSessionsDestroyed: () => void,
    onArchiveDeletionCommitted: () => void,
  ) => Promise<T>,
): Promise<T> {
  // Before any await, so the row leaves every projection before the archive
  // waits on anything, admission included: an Auto Delete that is then refused
  // hides the row until the release below. Persistence only syncs once the row
  // is written out.
  const releaseRemovalPending = markWorkspaceTargetRemovalPending(
    workspaceId,
    worktreeId,
  );
  try {
    schedulePortalStructuralSync();
    return await withLinuxWorktreeWriterTracking(
      () =>
        runMarkedWorktreeArchiveDeletionLifecycle(
          workspaceId,
          worktreeId,
          archiveOperation,
        ),
      JSON.stringify([workspaceId, worktreeId]),
    );
  } finally {
    // Release before the sync: a failed or rejected archive shows the row
    // again, and a finished one already removed it from the persisted list.
    releaseRemovalPending();
    schedulePortalStructuralSync();
    publishWorktreeLifecycleChange('worktree-removal-settled');
    trackDetachedWork(async () => {
      const { queueTrackedGitHubWorktreeSync } =
        await import('./post-archive-sync');
      queueTrackedGitHubWorktreeSync();
    });
  }
}

async function runMarkedWorktreeArchiveDeletionLifecycle<T>(
  workspaceId: string,
  worktreeId: string,
  archiveOperation: (
    onLiveSessionsDestroyed: () => void,
    onArchiveDeletionCommitted: () => void,
  ) => Promise<T>,
): Promise<T> {
  const diagnostic: ArchiveDiagnosticContext = {
    operationId: randomUUID(),
    phase: 'admission',
  };
  return archiveDiagnosticContext.run(diagnostic, async () => {
    return runWithBrowserRetirementDeadlineScope(() =>
      getChatStateService().runWithScopeDeletionLifecycle(
        { projectId: workspaceId, worktreeId },
        () =>
          runWithWorkspaceTargetActivityDeletion(
            workspaceId,
            worktreeId,
            async () => {
              const queueDeletion = getChatQueueService().beginWorktreeDeletion(
                workspaceId,
                worktreeId,
              );
              let queueDeletionCommitted = false;
              let sessionsDestroyed = false;
              const commitQueueDeletion = (): void => {
                if (queueDeletionCommitted) return;
                queueDeletion.commit();
                queueDeletionCommitted = true;
              };
              // Defer browser lifecycle/session loading until the fenced deletion
              // transaction starts; ordinary worktree-service startup must not initialize it.
              const {
                prepareTaskBrowserRetirement,
                settleFailedTaskBrowserRetirement,
              } = await import('../browser/browser-profile-lifecycle');
              let browserRetirement: string | null = null;
              try {
                try {
                  browserRetirement = await withBrowserRetirementDeadline(
                    () => prepareTaskBrowserRetirement(workspaceId, worktreeId),
                    // This archive stopped waiting, so it will not commit or
                    // abort a fence prepared after the deadline.
                    (operationId) =>
                      settleLatePreparedBrowserRetirement(
                        workspaceId,
                        worktreeId,
                        operationId,
                      ),
                  );
                } catch (error) {
                  // Profile metadata must never hold a worktree archive, by
                  // failing or by not answering. Without a fence the profile
                  // stays usable until the archive removes its owner, then it
                  // is retired as an owner-removed task.
                  deferArchiveBrowserRetirement(error, 'prepare');
                }
                const result = await withWorkspaceTargetArchiveDrain(
                  workspaceId,
                  worktreeId,
                  () =>
                    archiveOperation(() => {
                      sessionsDestroyed = true;
                    }, commitQueueDeletion),
                );
                commitQueueDeletion();
                return result;
              } catch (error) {
                // Report the archive failure, not a secondary settle failure;
                // an unsettled fence stays for this owner's next archive.
                if (hasBrowserRetirementDeadlineExpired()) {
                  // This archive skips its remaining profile calls, but a
                  // fence prepared in time still sits on a worktree that is
                  // staying. Settle it once the archive has ended, as for a
                  // late prepare: its own lock is often what expired.
                  deferArchiveBrowserRetirement(
                    new BrowserRetirementTimeoutError(),
                    'settle',
                  );
                  // Settles after the archive, outside its admission.
                  detachedWorkCallback(() =>
                    settleLatePreparedBrowserRetirement(
                      workspaceId,
                      worktreeId,
                      browserRetirement,
                    ).catch((settleError: unknown) => {
                      deferArchiveBrowserRetirement(settleError, 'settle');
                    }),
                  )();
                } else {
                  await withBrowserRetirementDeadline(() =>
                    settleFailedTaskBrowserRetirement(browserRetirement),
                  ).catch((settleError: unknown) => {
                    deferArchiveBrowserRetirement(settleError, 'settle');
                  });
                }
                throw error;
              } finally {
                if (!queueDeletionCommitted) {
                  queueDeletion.rollback({ sessionsDestroyed });
                }
              }
            },
          ),
      ),
    );
  });
}

async function listWorkspaceTurnDiffRepoPaths(
  workspaceId: string,
  worktreeId: string,
  config: WorkspaceConfigFile,
): Promise<string[]> {
  const repoPaths = new Set<string>(config.repos.map((repo) => repo.repoPath));
  if (config.sourceRepoPath) {
    repoPaths.add(
      await resolveWorkspaceReferenceRepoPath(config.sourceRepoPath),
    );
  }

  try {
    const entries = await listUnmanagedWorktreeRepositories(
      getWorkspaceWorktreeDir(workspaceId, worktreeId),
      config.repos.map((repo) => repo.id),
    );
    for (const entry of entries) {
      if (entry.repository.kind === 'linked-worktree') {
        repoPaths.add(entry.repository.referenceRepoPath);
      }
    }
  } catch {
    // Teardown validates the same inventory before removing any checkout.
  }

  return Array.from(repoPaths);
}

async function archiveMultiRepoWorktreeWithoutOperationLock(options: {
  /** Canonical row-removal decision only; never holds locks across teardown. */
  w5Commit?: W5CommitOptions;
  persistedWorktree?: WorktreeData | null;
  workspaceId: string;
  worktreeId: string;
  expectedCreatedAt?: string;
  allowMissingRow?: boolean;
  expectedLastTouchedAt?: string;
  runAutoArchiveTeardown?: () => Promise<void>;
  revalidateAutoArchivePolicy?: () => Promise<{
    deleteBranch?: boolean;
  }>;
  expectedBranchName?: string;
  deleteBranch?: boolean;
  remainingWorktreeOrder?: readonly string[];
  expectedRemainingWorktreeOrder?: readonly string[];
  observabilityMode?: 'persisted-only' | 'live-service';
  liveServices?: WorktreeArchiveLiveServices;
  retainAsArchivedContainer?: boolean;
  deleteWithoutRetentionIfMissing?: boolean;
  /** Fail before teardown when retention was requested but cannot be prepared. */
  requireArchivedContainer?: boolean;
  lockAfterArchive?: boolean;
  /** Preserve physical root files outside the managed child checkouts. */
  captureWorkspaceRootFiles?: boolean;
  /** Limit a retained container to restoring the workspace root only. */
  restoreScope?: 'workspace-root-only';
  onLiveSessionsDestroyed?: () => void;
  onArchiveDeletionCommitted?: () => void;
}): Promise<ArchiveWorktreeResponse> {
  validateId(options.workspaceId, 'workspaceId');
  validateId(options.worktreeId, 'worktreeId');
  const mode = options.observabilityMode ?? 'persisted-only';
  const persistedWorktree =
    options.persistedWorktree !== undefined
      ? options.persistedWorktree
      : await findPersistedWorktree(options.workspaceId, options.worktreeId);
  assertAutoArchiveEligibilityUnchanged(persistedWorktree, options);
  const currentAutoArchivePolicy =
    await options.revalidateAutoArchivePolicy?.();
  if (currentAutoArchivePolicy) {
    options = {
      ...options,
      deleteBranch: currentAutoArchivePolicy.deleteBranch === true,
    };
  }
  const setupRef = createSetupCancellationRef(
    options.workspaceId,
    options.worktreeId,
    persistedWorktree,
    options.expectedCreatedAt,
  );
  if (setupRef) {
    markWorktreeSetupCancellation(setupRef);
  }
  let localWatcherFenceHeld = false;

  try {
    if (options.runAutoArchiveTeardown) {
      setArchivePhase('teardown-script');
      await destructiveStep('teardown-script', options.runAutoArchiveTeardown, {
        stepFreeAsFirstChildStep: true,
      });
    }
    setArchivePhase('resource-drain');
    await destructiveCall(
      'live-state-teardown',
      cleanupLiveStateIfNeeded,
      options.workspaceId,
      options.worktreeId,
      mode,
      options.liveServices,
      options.onLiveSessionsDestroyed,
    );
  } catch (error) {
    consumeSetupCancellationOnError(setupRef, error);
  }

  const {
    runtime,
    turnDiffRepoPaths,
    deletionUsageRepos,
    teardownResult,
    archiveContainer,
  } = await (async (): Promise<{
    runtime: ExecutionRuntime;
    turnDiffRepoPaths: string[];
    deletionUsageRepos: WorktreeDeletedUsageEvent['repos'] | null;
    teardownResult: PromiseSettledResult<string[]>;
    archiveContainer?: PreparedWorktreeArchiveContainer;
  }> => {
    try {
      const config = await readWorkspaceConfig(options.workspaceId);
      const referenceRepoPath = config.sourceRepoPath
        ? await resolveWorkspaceReferenceRepoPath(config.sourceRepoPath)
        : undefined;
      const runtime = runtimeForMode(mode);
      const worktreePath = getWorkspaceWorktreeDir(
        options.workspaceId,
        options.worktreeId,
      );
      const retentionDecision = await resolveArchiveRetentionDecision({
        workspaceId: options.workspaceId,
        worktreeId: options.worktreeId,
        worktreePath,
        retainAsArchivedContainer: options.retainAsArchivedContainer,
        deleteWithoutRetentionIfMissing:
          options.deleteWithoutRetentionIfMissing,
      });
      const effectiveDeleteBranch =
        retentionDecision.worktreeMissing && options.deleteBranch === true
          ? false
          : options.deleteBranch;
      const branchPreservationWarning =
        retentionDecision.worktreeMissing && options.deleteBranch === true
          ? 'Local branches were preserved because their deletion could not be safely verified.'
          : undefined;
      const archivePrefs = await readArchivePreferences();
      const branchDeleter = resolveArchiveBranchDeleter(
        effectiveDeleteBranch,
        archivePrefs.deleteBranchOnArchive,
      );
      const requestedBranchDeletionMode = resolveArchiveBranchDeletionMode(
        effectiveDeleteBranch,
        archivePrefs.deleteBranchOnArchive,
      );
      const archiveContainer = await prepareWorktreeArchiveContainer({
        workspaceId: options.workspaceId,
        worktreeId: options.worktreeId,
        workspaceType: 'multi-repo',
        worktreePath,
        persistedWorktree,
        retainAsArchivedContainer: retentionDecision.retainAsArchivedContainer,
        requireArchivedContainer: options.requireArchivedContainer,
        lockAfterArchive: options.lockAfterArchive,
        captureWorkspaceRootFiles: options.captureWorkspaceRootFiles,
        managedRepoIds: config.repos.map((repo) => repo.id),
        restoreScope: options.restoreScope,
      });
      if (options.requireArchivedContainer && !archiveContainer) {
        throw new Error(
          'Cannot archive this worktree because it is not registered in the project.',
        );
      }
      if (!archiveContainer || archiveContainer.teardownCompleted) {
        // Defer scheduler initialization until deletion admission is fenced.
        const { getAppAdvisorWatcherService } =
          await import('../app-advisor/watchers');
        await getAppAdvisorWatcherService().cancelLocalScope(
          options.workspaceId,
          options.worktreeId,
        );
      }
      localWatcherFenceHeld = true;
      const turnDiffRepoPaths = await listWorkspaceTurnDiffRepoPaths(
        options.workspaceId,
        options.worktreeId,
        config,
      );
      const deletionUsageRepos = await captureWorktreeDeletionUsageSnapshot(
        options.workspaceId,
        options.worktreeId,
        config,
      ).catch((error) => {
        // eslint-disable-next-line no-console
        console.warn('Failed to capture worktree deletion usage snapshot.', {
          workspaceId: options.workspaceId,
          worktreeId: options.worktreeId,
          error: getErrorLogDetails(error),
        });
        return null;
      });

      const verifyWriters = retainedArchiveWriterVerification(
        worktreePath,
        archiveContainer,
      );
      const [teardownResult] = await settleEach([
        verifyWriters(async (): Promise<string[]> => {
          setArchivePhase('teardown');
          const warnings: string[] = branchPreservationWarning
            ? [branchPreservationWarning]
            : [];
          if (archiveContainer?.teardownCompleted) return warnings;
          if (archiveContainer?.manifest.version === 3) {
            return [
              ...warnings,
              ...(await destructiveCall(
                'retained-git-cleanup',
                finishArchivedContainerRecovery,
                archiveContainer.manifest,
              )),
            ];
          }
          if (archiveContainer?.manifest.version === 2) {
            const expectedBranchName = normalizeRequestedBranch(
              options.expectedBranchName,
            );
            const confirmedRepository =
              archiveContainer.manifest.gitState.repositories.find(
                (repository) => repository.repoId === WORKSPACE_ROOT_REPO_ID,
              );
            if (
              expectedBranchName &&
              confirmedRepository &&
              confirmedRepository.branchName !== expectedBranchName
            ) {
              throw new Error(
                `Cannot safely archive the worktree because its workspace-root branch changed after archive was confirmed for "${expectedBranchName}".`,
              );
            }
            const teardown = await destructiveCall(
              'checkout-quarantine',
              prepareArchivedContainerTeardown,
              {
                workspaceId: options.workspaceId,
                containerId: options.worktreeId,
                workspaceType: 'multi-repo',
                gitState: archiveContainer.manifest.gitState,
                expectedCreatedAt: archiveContainer.manifest.createdAt,
                deleteBranches:
                  effectiveDeleteBranch === false
                    ? false
                    : requestedBranchDeletionMode
                      ? true
                      : undefined,
                branchDeletionMode: requestedBranchDeletionMode,
                ...((options.captureWorkspaceRootFiles ||
                  archiveContainer.manifest.restoreScope ===
                    'workspace-root-only') && {
                  workspaceRootCapture: {
                    managedRepoIds: config.repos.map((repo) => repo.id),
                  },
                }),
              },
            );
            const pendingBranchDeletions =
              teardown.pendingBranchDeletions ?? [];
            const capturedRepoIds = new Set(
              archiveContainer.manifest.gitState.repositories.map(
                (repository) => repository.repoId,
              ),
            );
            if (teardown.alreadyRemoved) {
              await destructiveCall(
                'branch-deletion',
                deleteArchivedBranchesWithWorker,
                {
                  projectId: options.workspaceId,
                  containerId: options.worktreeId,
                  expectedCreatedAt: archiveContainer.manifest.createdAt,
                  branches: pendingBranchDeletions,
                  mode: teardown.branchDeletionMode ?? 'force',
                },
              );
              return warnings;
            }
            const childTargets = teardown.targets.filter(
              (target) => target.repoId !== WORKSPACE_ROOT_REPO_ID,
            );
            const rootTarget = teardown.targets.find(
              (target) => target.repoId === WORKSPACE_ROOT_REPO_ID,
            );
            for (const target of childTargets) {
              warnings.push(
                ...(await destructiveCall(
                  'git-worktree-removal',
                  removeArchivedWorktreeWithWorker,
                  {
                    projectId: options.workspaceId,
                    containerId: options.worktreeId,
                    expectedCreatedAt: archiveContainer.manifest.createdAt,
                    repoId: target.repoId,
                    referenceRepoPath: target.referenceRepoPath,
                    worktreePath: target.quarantineRepoPath,
                    preMoveWorktreePath: target.preMoveRepoPath,
                  },
                )),
              );
              if (
                target.branchName &&
                branchDeleter &&
                pendingBranchDeletions.length === 0 &&
                capturedRepoIds.has(target.repoId)
              ) {
                await destructiveCall(
                  'branch-deletion',
                  deleteArchivedBranch,
                  branchDeleter,
                  target.referenceRepoPath,
                  target.branchName,
                  effectiveDeleteBranch === true,
                );
              }
            }
            if (rootTarget) {
              warnings.push(
                ...(await destructiveCall(
                  'git-worktree-removal',
                  removeArchivedWorktreeWithWorker,
                  {
                    projectId: options.workspaceId,
                    containerId: options.worktreeId,
                    expectedCreatedAt: archiveContainer.manifest.createdAt,
                    repoId: rootTarget.repoId,
                    referenceRepoPath: rootTarget.referenceRepoPath,
                    worktreePath: rootTarget.quarantineRepoPath,
                    preMoveWorktreePath: rootTarget.preMoveRepoPath,
                  },
                )),
              );
              if (
                rootTarget.branchName &&
                branchDeleter &&
                pendingBranchDeletions.length === 0 &&
                capturedRepoIds.has(rootTarget.repoId)
              ) {
                await destructiveCall(
                  'branch-deletion',
                  deleteArchivedBranch,
                  branchDeleter,
                  rootTarget.referenceRepoPath,
                  rootTarget.branchName,
                  effectiveDeleteBranch === true,
                );
              }
            }
            await destructiveCall(
              'quarantine-directory-removal',
              removeArchivedDirectoryWithWorker,
              {
                projectId: options.workspaceId,
                containerId: options.worktreeId,
                expectedCreatedAt: archiveContainer.manifest.createdAt,
                path: teardown.quarantinePath,
              },
            );
            await destructiveCall(
              'branch-deletion',
              deleteArchivedBranchesWithWorker,
              {
                projectId: options.workspaceId,
                containerId: options.worktreeId,
                expectedCreatedAt: archiveContainer.manifest.createdAt,
                branches: pendingBranchDeletions,
                mode: teardown.branchDeletionMode ?? 'force',
              },
            );
            return warnings;
          }
          const workspaceRootPath = getWorkspaceWorktreeRootRepoDir(
            options.workspaceId,
            options.worktreeId,
          );
          const hasPersistedPendingBranchDeletions =
            persistedWorktree?.pendingArchiveBranchDeletions !== undefined;
          const shouldDeleteBranches =
            effectiveDeleteBranch === true ||
            (effectiveDeleteBranch === undefined &&
              hasPersistedPendingBranchDeletions);
          const pendingBranchDeletions = shouldDeleteBranches
            ? await normalizePendingArchiveBranchDeletions(
                persistedWorktree?.pendingArchiveBranchDeletions,
              )
            : [];
          const expectedBranchName = normalizeRequestedBranch(
            options.expectedBranchName,
          );
          const configuredRepoPaths = new Map(
            config.repos.map((repo) => [repo.id, repo.repoPath]),
          );
          if (referenceRepoPath) {
            configuredRepoPaths.set(WORKSPACE_ROOT_REPO_ID, referenceRepoPath);
          }
          for (const deletion of pendingBranchDeletions) {
            const configuredRepoPath = configuredRepoPaths.get(deletion.repoId);
            if (configuredRepoPath === undefined) {
              throw new Error(
                `Cannot safely delete local branch "${deletion.branchName}" because repository "${deletion.repoId}" is not part of the project configuration.`,
              );
            }
            if (configuredRepoPath !== deletion.referenceRepoPath) {
              throw new Error(
                `Cannot safely delete local branch "${deletion.branchName}" because repository "${deletion.repoId}" no longer matches its pending deletion repository.`,
              );
            }
            if (
              (await getGitCommonDir(configuredRepoPath)) !==
              deletion.repositoryIdentity
            ) {
              throw new Error(
                `Cannot safely delete local branch "${deletion.branchName}" because repository "${deletion.repoId}" no longer matches its pending deletion repository.`,
              );
            }
            if (
              expectedBranchName &&
              deletion.repoId === WORKSPACE_ROOT_REPO_ID &&
              deletion.branchName !== expectedBranchName
            ) {
              throw new Error(
                `Cannot safely archive the worktree because repository "${deletion.repoId}" no longer matches the confirmed branch "${expectedBranchName}".`,
              );
            }
          }
          if (
            effectiveDeleteBranch === false &&
            persistedWorktree?.pendingArchiveBranchDeletions !== undefined
          ) {
            const cleared = await updateArchiveJournalRow(
              options.w5Commit,
              options.workspaceId,
              options.worktreeId,
              {
                kind: 'worktree.archive.journal.clear',
                workspaceKind: 'multi-repo',
              },
            );
            if (!cleared) {
              throw new Error(
                'Cannot safely preserve local branches because their pending deletion journal could not be cleared.',
              );
            }
          }

          const recordPendingBranchDeletion = async (
            repoId: string,
            referenceRepoPath: string,
            branchName: string,
          ): Promise<void> => {
            if (!shouldDeleteBranches) return;
            const alreadyRecorded = pendingBranchDeletions.find(
              (deletion) => deletion.repoId === repoId,
            );
            if (alreadyRecorded) {
              if (alreadyRecorded.referenceRepoPath !== referenceRepoPath) {
                throw new Error(
                  `Cannot safely delete local branch "${alreadyRecorded.branchName}" because repository "${repoId}" no longer matches its pending deletion repository.`,
                );
              }
              if (
                (await getGitCommonDir(referenceRepoPath)) !==
                alreadyRecorded.repositoryIdentity
              ) {
                throw new Error(
                  `Cannot safely delete local branch "${alreadyRecorded.branchName}" because repository "${repoId}" no longer matches its pending deletion repository.`,
                );
              }
              if (alreadyRecorded.branchName !== branchName) {
                throw new Error(
                  `Cannot safely delete local branch "${alreadyRecorded.branchName}" because repository "${repoId}" changed branches after deletion was confirmed.`,
                );
              }
              return;
            }
            if (
              expectedBranchName &&
              repoId === WORKSPACE_ROOT_REPO_ID &&
              branchName !== expectedBranchName
            ) {
              throw new Error(
                `Cannot safely archive the worktree because repository "${repoId}" changed branches after deletion was confirmed for "${expectedBranchName}".`,
              );
            }
            pendingBranchDeletions.push({
              repoId,
              referenceRepoPath,
              repositoryIdentity: await getGitCommonDir(referenceRepoPath),
              branchName,
              expectedTip: await resolveRefSha(
                referenceRepoPath,
                `refs/heads/${branchName}`,
              ),
            });
          };

          const repoBranches = new Map<string, string>();
          for (const repo of config.repos) {
            const repoWorktreePath = getWorkspaceWorktreeRepoDir(
              options.workspaceId,
              options.worktreeId,
              repo.id,
            );
            let branchName: string | null = null;
            try {
              const branch = await getCurrentBranch(repoWorktreePath);
              if (branch && branch !== 'HEAD') {
                branchName = branch;
              }
            } catch {
              // Worktree may already be gone.
            }
            if (branchName) {
              repoBranches.set(repo.id, branchName);
              await recordPendingBranchDeletion(
                repo.id,
                repo.repoPath,
                branchName,
              );
            }
          }

          let rootBranch: string | null = null;
          let rootBranchIsDetached = false;
          if (config.sourceRepoPath && referenceRepoPath) {
            try {
              const branch = await getCurrentBranch(workspaceRootPath);
              if (branch === 'HEAD') {
                rootBranchIsDetached = true;
              } else if (branch) {
                rootBranch = branch;
              }
            } catch {
              // Root worktree may already be gone.
            }
            if (expectedBranchName && rootBranchIsDetached) {
              throw new Error(
                `Cannot safely archive the worktree because repository "${WORKSPACE_ROOT_REPO_ID}" changed branches after archive was confirmed for "${expectedBranchName}".`,
              );
            }
            if (rootBranch) {
              if (expectedBranchName && rootBranch !== expectedBranchName) {
                throw new Error(
                  `Cannot safely archive the worktree because repository "${WORKSPACE_ROOT_REPO_ID}" changed branches after archive was confirmed for "${expectedBranchName}".`,
                );
              }
              await recordPendingBranchDeletion(
                WORKSPACE_ROOT_REPO_ID,
                referenceRepoPath,
                rootBranch,
              );
            }
          }

          const wtDir = getWorkspaceWorktreeDir(
            options.workspaceId,
            options.worktreeId,
          );
          const staleTargets = await listUnmanagedWorktreeRepositories(
            wtDir,
            config.repos.map((repo) => repo.id),
          );

          if (shouldDeleteBranches) {
            if (
              pendingBranchDeletions.length === 0 &&
              persistedWorktree?.branchName
            ) {
              throw new Error(
                `Cannot safely delete local branches for "${persistedWorktree.branchName}" because their archived tips were not recorded.`,
              );
            }
            const persisted = await updateArchiveJournalRow(
              options.w5Commit,
              options.workspaceId,
              options.worktreeId,
              {
                kind: 'worktree.archive.journal.record',
                workspaceKind: 'multi-repo',
                pendingBranchDeletions,
              },
            );
            if (!persisted) {
              throw new Error(
                'Cannot safely delete local branches because their archived tips could not be persisted.',
              );
            }
          }

          for (const repo of config.repos) {
            const repoWorktreePath = getWorkspaceWorktreeRepoDir(
              options.workspaceId,
              options.worktreeId,
              repo.id,
            );
            // Explicitly excluded, absent children grant no source cleanup.
            // Retention's worktreeMissing flag does not cover explicit deletes.
            if (
              persistedWorktree?.includedRepoIds &&
              !persistedWorktree.includedRepoIds.includes(repo.id)
            ) {
              const childAbsent = await lstat(repoWorktreePath).then(
                () => false,
                (error: unknown) => {
                  if (isNodeErrorCode(error, 'ENOENT')) return true;
                  throw error;
                },
              );
              if (childAbsent) continue;
            }
            warnings.push(
              ...(await destructiveCall(
                'checkout-removal',
                safeRemoveWorktree,
                repo.repoPath,
                repoWorktreePath,
                {
                  workspaceId: options.workspaceId,
                  worktreeId: options.worktreeId,
                  repoId: repo.id,
                },
              )),
            );
            const branchToDelete = repoBranches.get(repo.id);
            if (branchToDelete && branchDeleter && !shouldDeleteBranches) {
              await destructiveCall(
                'branch-deletion',
                deleteArchivedBranch,
                branchDeleter,
                repo.repoPath,
                branchToDelete,
                false,
              );
            }
          }

          for (const staleTarget of staleTargets) {
            if (staleTarget.repository.kind === 'linked-worktree') {
              warnings.push(
                ...(await destructiveCall(
                  'checkout-removal',
                  safeRemoveWorktree,
                  staleTarget.repository.referenceRepoPath,
                  staleTarget.path,
                )),
              );
            } else {
              await destructiveCall(
                'directory-removal',
                removePhysicalWorktreeDirectory,
                staleTarget.path,
              );
            }
          }

          if (referenceRepoPath) {
            warnings.push(
              ...(await destructiveCall(
                'checkout-removal',
                safeRemoveWorktree,
                referenceRepoPath,
                workspaceRootPath,
                {
                  workspaceId: options.workspaceId,
                  worktreeId: options.worktreeId,
                },
              )),
            );
            if (rootBranch && branchDeleter && !shouldDeleteBranches) {
              await destructiveCall(
                'branch-deletion',
                deleteArchivedBranch,
                branchDeleter,
                referenceRepoPath,
                rootBranch,
                false,
              );
            }
          } else {
            if (process.platform === 'win32' && warnings.length === 0) {
              await destructiveCall(
                'directory-removal',
                removeTopLevelWorktreeDirectory,
                options.workspaceId,
                options.worktreeId,
                wtDir,
              );
            } else {
              warnings.push(
                ...(await destructiveCall(
                  'directory-removal',
                  removeTopLevelWorktreeDirectoryWithWarning,
                  options.workspaceId,
                  options.worktreeId,
                  wtDir,
                )),
              );
            }
          }
          if (shouldDeleteBranches) {
            await destructiveCall(
              'branch-deletion',
              deletePendingArchivedBranches,
              pendingBranchDeletions,
            );
          }
          return warnings;
        }),
      ]);

      return {
        runtime,
        turnDiffRepoPaths,
        deletionUsageRepos,
        teardownResult,
        archiveContainer,
      };
    } catch (error) {
      if (localWatcherFenceHeld) {
        // Defer scheduler initialization until preparation rollback is needed.
        const { getAppAdvisorWatcherService } =
          await import('../app-advisor/watchers');
        await getAppAdvisorWatcherService().releaseLocalScopeFence(
          options.workspaceId,
          options.worktreeId,
        );
      }
      consumeSetupCancellationOnError(setupRef, error);
    }
  })();

  if (teardownResult.status === 'rejected') {
    // Defer scheduler initialization until a failed teardown needs rollback.
    const { getAppAdvisorWatcherService } =
      await import('../app-advisor/watchers');
    await getAppAdvisorWatcherService().releaseLocalScopeFence(
      options.workspaceId,
      options.worktreeId,
    );
  }
  throwRejectedTeardown(setupRef, teardownResult);
  // Keep auxiliary cleanup behind the same teardown commit point as the
  // single-repo flow so a failed delete remains safely retryable.
  const [cleanupResult, turnDiffCleanupResult] = await settleEach([
    destructiveCall(
      'pipeline-cleanup',
      cleanupWorktreePipelines,
      options.workspaceId,
      options.worktreeId,
      runtime,
      {
        ...(archiveContainer
          ? {
              relocateArtifactsTo: getArchivedContainerExecutionsDir(
                options.workspaceId,
                options.worktreeId,
              ),
              archiveCaptureExecutor: (executionId, input): Promise<void> =>
                copyArchivedPipelinePayloadWithWorker({
                  projectId: options.workspaceId,
                  containerId: options.worktreeId,
                  expectedCreatedAt: archiveContainer.manifest.createdAt,
                  executionId,
                  input,
                }),
            }
          : {}),
      },
    ),
    settleAll(
      turnDiffRepoPaths.map((repoPath) =>
        destructiveCleanup('turn-diff-cleanup', () =>
          cleanupPersistedTurnDiffTreeRefs(
            repoPath,
            options.workspaceId,
            options.worktreeId,
          ),
        ),
      ),
    ).then(() => undefined),
  ]);
  const cleanup = await finalizeArchiveCleanup({
    w5Commit: options.w5Commit,
    workspaceId: options.workspaceId,
    worktreeId: options.worktreeId,
    mode,
    liveServices: options.liveServices,
    setupRef,
    persistedWorktree,
    remainingWorktreeOrder: options.remainingWorktreeOrder,
    expectedRemainingWorktreeOrder: options.expectedRemainingWorktreeOrder,
    cleanupResult,
    turnDiffCleanupResult,
    teardownResult,
    archiveContainer,
    onArchiveDeletionCommitted: options.onArchiveDeletionCommitted,
  });

  if (deletionUsageRepos) {
    recordCompletedWorktreeDeletionUsage({
      workspaceId: options.workspaceId,
      worktreeId: options.worktreeId,
      createdAt: persistedWorktree?.createdAt ?? options.expectedCreatedAt,
      repos: deletionUsageRepos,
    });
  }

  return { success: true, ...cleanup };
}

export async function archiveMultiRepoWorktree(
  options: {
    /** Canonical row-removal decision only; never holds locks across teardown. */
    w5Commit?: W5CommitOptions;
    /** Required by ordinary removal; internal recovery callers retain compatibility behavior. */
    sourceAdmission?: 'required';
    archiveTrigger?: ArchiveTrigger;
    workspaceId: string;
    worktreeId: string;
    expectedCreatedAt?: string;
    /** Internal needs-repair rollback only; never set from a request. */
    allowMissingRow?: boolean;
    expectedLastTouchedAt?: string;
    runAutoArchiveTeardown?: () => Promise<void>;
    revalidateAutoArchivePolicy?: () => Promise<{
      deleteBranch?: boolean;
    }>;
    expectedBranchName?: string;
    deleteBranch?: boolean;
    remainingWorktreeOrder?: readonly string[];
    expectedRemainingWorktreeOrder?: readonly string[];
    observabilityMode?: 'persisted-only' | 'live-service';
    liveServices?: WorktreeArchiveLiveServices;
    retainAsArchivedContainer?: boolean;
    deleteWithoutRetentionIfMissing?: boolean;
    /** Fail before teardown when retention was requested but cannot be prepared. */
    requireArchivedContainer?: boolean;
    lockAfterArchive?: boolean;
    /** Preserve physical root files outside the managed child checkouts. */
    captureWorkspaceRootFiles?: boolean;
    /** Limit a retained container to restoring the workspace root only. */
    restoreScope?: 'workspace-root-only';
  },
  telemetry?: ArchiveFailureTelemetryOptions,
): Promise<ArchiveWorktreeResponse> {
  return withArchiveFailureTelemetry(
    options,
    () => archiveMultiRepoWorktreeAdmitted(options),
    telemetry,
  );
}

async function archiveMultiRepoWorktreeAdmitted(
  options: Parameters<typeof archiveMultiRepoWorktree>[0],
): Promise<ArchiveWorktreeResponse> {
  if (options.sourceAdmission === 'required')
    await admitWorktreeArchiveSource(options, 'multi-repo');
  return runWithWorktreeArchiveDeletionLifecycle(
    options.workspaceId,
    options.worktreeId,
    (onLiveSessionsDestroyed, onArchiveDeletionCommitted) =>
      withArchivedWorkspaceOperationLock(options.workspaceId, async () => {
        const recovered = await finishInterruptedArchiveCleanup(
          options,
          onLiveSessionsDestroyed,
          onArchiveDeletionCommitted,
        );
        if (recovered) return recovered;
        await assertNoDestructiveRecovery(
          options.workspaceId,
          options.worktreeId,
        );
        const target = await findPersistedWorktree(
          options.workspaceId,
          options.worktreeId,
        );
        await assertNoLegacyArchiveRecovery(
          options.workspaceId,
          options.worktreeId,
          { admitMissingCheckoutCapture: true },
        );
        return withDestructiveLifecycle(
          {
            operation:
              options.retainAsArchivedContainer === false
                ? 'worktree-delete'
                : 'worktree-archive',
            trigger: options.archiveTrigger ?? 'manual',
            workspaceId: options.workspaceId,
            worktreeId: options.worktreeId,
            createdAt: target?.createdAt ?? options.expectedCreatedAt,
            allowMissingRow: options.allowMissingRow,
            readCreatedAt: async () =>
              (
                await findPersistedWorktree(
                  options.workspaceId,
                  options.worktreeId,
                )
              )?.createdAt ?? null,
            beforeEffects: options.w5Commit?.beforeDecision,
            replay: (outcome) => destructiveArchiveOutcomeSchema.parse(outcome),
          },
          async () => {
            await protectDestructivePath(
              getWorkspaceWorktreeDir(options.workspaceId, options.worktreeId),
            );
            await protectDestructivePath(
              getWorktreeDataDir(options.workspaceId, options.worktreeId),
              true,
            );
            return archiveMultiRepoWorktreeWithoutOperationLock({
              ...options,
              persistedWorktree: target,
              expectedCreatedAt: options.expectedCreatedAt ?? target?.createdAt,
              onLiveSessionsDestroyed,
              onArchiveDeletionCommitted,
            });
          },
        );
      }),
    { telemetryParent: 'inherit' },
  );
}

export async function aggregateMultiRepoDiffStats(
  projectId: string,
  worktreeId: string,
  worktreePath: string,
  options?: {
    skipFetch?: boolean;
    readDiffStats?: WorktreeRepoDiffStatsReader;
  },
): Promise<MultiRepoDiffResult> {
  const readDiffStats = options?.readDiffStats ?? readDiffStatsDirectly;
  const repoEntries = await listWorkspaceWorktreeRepoEntries(
    projectId,
    worktreePath,
  );
  if (repoEntries.length === 0) {
    return {
      stats: { insertions: 0, deletions: 0 },
      baseBranch: null,
      baseBranchExistsLocally: false,
      baseBranchExistsInRemote: false,
      hasOriginRemote: false,
      hasCommitsAhead: false,
      hasUncommittedChanges: false,
      hasRemoteTrackingBranch: false,
      hasUnpushedCommits: false,
      hasUnpulledCommits: false,
      hasBranchBeenPushed: false,
      repoBranches: [],
    };
  }
  const repoEntriesWithOrigin = await settleAll(
    repoEntries.map(async (entry) => ({
      ...entry,
      hasOriginRemote: Boolean(await getRemoteUrl(entry.repoPath)),
    })),
  );
  if (!shouldSkipAutomaticFetch(options)) {
    await settleAll(
      repoEntriesWithOrigin
        .filter((entry) => entry.hasOriginRemote)
        .map((entry) =>
          fetchOrigin(entry.repoPath, {
            prune: true,
            ttlMs: AUTOMATIC_FETCH_TTL_MS,
          }),
        ),
    );
  }
  const effectiveBaseBranches = await resolveEffectiveBaseBranchesForStats({
    projectId,
    worktreeId,
    cwd: worktreePath,
    allowRemoteLookup: !shouldSkipAutomaticFetch(options),
  });

  const results = await mapWithConcurrency(
    repoEntriesWithOrigin,
    REPO_DIFF_STATS_CONCURRENCY,
    async (entry) => {
      const effectiveBaseBranch = effectiveBaseBranches[entry.repoId] ?? {
        branch: null,
        existsLocally: false,
        existsInRemote: false,
      };
      const [
        stats,
        branch,
        commitsAhead,
        uncommitted,
        remoteTracking,
        unpushed,
        unpulled,
        pushed,
      ] = await settleAll([
        readDiffStats(entry, effectiveBaseBranch.branch ?? undefined).catch(
          () => ({ insertions: 0, deletions: 0 }),
        ),
        getCurrentBranchDisplayName(entry.repoPath).catch(() => 'unknown'),
        hasCommitsAhead(
          entry.repoPath,
          effectiveBaseBranch.branch ?? undefined,
        ).catch(() => false),
        hasUncommittedChanges(entry.repoPath).catch(() => false),
        hasRemoteTrackingBranch(entry.repoPath).catch(() => false),
        hasUnpushedCommits(entry.repoPath).catch(() => false),
        hasUnpulledCommits(entry.repoPath).catch(() => false),
        hasBranchBeenPushedToRemote(entry.repoPath).catch(() => false),
      ]);
      return {
        repoId: entry.repoId,
        repoName: entry.repoName,
        hasOriginRemote: entry.hasOriginRemote,
        baseBranch: effectiveBaseBranch.branch,
        baseBranchExistsLocally: effectiveBaseBranch.existsLocally,
        baseBranchExistsInRemote: effectiveBaseBranch.existsInRemote,
        stats,
        branch,
        commitsAhead,
        uncommitted,
        remoteTracking,
        unpushed,
        unpulled,
        pushed,
      };
    },
  );

  let insertions = 0;
  let deletions = 0;
  let anyOriginRemote = false;
  let ahead = false;
  let anyUncommitted = false;
  let anyRemoteTracking = false;
  let anyUnpushed = false;
  let anyUnpulled = false;
  let anyPushed = false;
  const repoBranches: RepoBranchInfo[] = [];
  for (const result of results) {
    insertions += result.stats.insertions;
    deletions += result.stats.deletions;
    anyOriginRemote = anyOriginRemote || result.hasOriginRemote;
    ahead = ahead || result.commitsAhead;
    anyUncommitted = anyUncommitted || result.uncommitted;
    anyRemoteTracking = anyRemoteTracking || result.remoteTracking;
    anyUnpushed = anyUnpushed || result.unpushed;
    anyUnpulled = anyUnpulled || result.unpulled;
    anyPushed = anyPushed || result.pushed;
    repoBranches.push({
      repoId: result.repoId,
      repoName: result.repoName,
      branch: result.branch,
      baseBranch: result.baseBranch,
      hasOriginRemote: result.hasOriginRemote,
      insertions: result.stats.insertions,
      deletions: result.stats.deletions,
      commitsAhead: result.commitsAhead,
      hasUncommittedChanges: result.uncommitted,
      hasRemoteTrackingBranch: result.remoteTracking,
      hasUnpushedCommits: result.unpushed,
      hasUnpulledCommits: result.unpulled,
      hasBranchBeenPushed: result.pushed,
      baseBranchExistsLocally: result.baseBranchExistsLocally,
      baseBranchExistsInRemote: result.baseBranchExistsInRemote,
    });
  }

  const firstBaseBranch = results[0]?.baseBranch ?? null;
  const hasSharedBaseBranch =
    firstBaseBranch !== null &&
    results.every((result) => result.baseBranch === firstBaseBranch);
  const sharedBaseBranch = hasSharedBaseBranch ? firstBaseBranch : null;
  const sharedBaseBranchExistsLocally =
    sharedBaseBranch !== null &&
    results.every(
      (result) =>
        result.baseBranch === sharedBaseBranch &&
        result.baseBranchExistsLocally,
    );
  const sharedBaseBranchExistsInRemote =
    sharedBaseBranch !== null &&
    results.every(
      (result) =>
        result.baseBranch === sharedBaseBranch &&
        result.baseBranchExistsInRemote,
    );

  return {
    stats: { insertions, deletions },
    baseBranch: sharedBaseBranch,
    baseBranchExistsLocally: sharedBaseBranchExistsLocally,
    hasOriginRemote: anyOriginRemote,
    hasCommitsAhead: ahead,
    hasUncommittedChanges: anyUncommitted,
    hasRemoteTrackingBranch: anyRemoteTracking,
    hasUnpushedCommits: anyUnpushed,
    hasUnpulledCommits: anyUnpulled,
    hasBranchBeenPushed: anyPushed,
    baseBranchExistsInRemote: sharedBaseBranchExistsInRemote,
    repoBranches,
  };
}

async function computeWorktreeStats(
  workspaceId: string,
  worktreeId: string,
  options?: {
    skipFetch?: boolean;
    readDiffStats?: WorktreeRepoDiffStatsReader;
  },
  diagnostics?: { diffStatsElapsedMs?: number },
): Promise<DiffStatsBatchResponseItem> {
  const workspace = await getStatsWorkspaceById(workspaceId);
  const worktree = workspace.worktrees.find((entry) => entry.id === worktreeId);

  if (!(await isWorktreeObservationTarget(workspaceId, worktreeId)))
    return {
      projectId: workspaceId,
      worktreeId,
      insertions: 0,
      deletions: 0,
    };

  // A deferred creation reservation is persisted and selectable before its
  // checkout exists. Treat that state as pending rather than allowing any
  // caller to persist the expected missing path as a broken health result.
  if (worktree?.setupPhase === 'git-pending') {
    return {
      projectId: workspaceId,
      worktreeId,
      insertions: 0,
      deletions: 0,
    };
  }

  const healthIssue = await validateWorktreeHealthForStats(
    workspaceId,
    worktreeId,
  );

  if (healthIssue || worktree?.healthIssue) {
    await recordWorktreeHealth({
      source: 'diff-stats',
      workspaceId,
      worktreeId,
      issue: healthIssue,
    });
  }

  // Single-repo worktrees cannot surface partial data, so any health issue
  // short-circuits. Multi-repo worktrees keep aggregating healthy repos so
  // the branch info modal can still show usable data; only a missing
  // worktree root blocks all aggregation.
  const shouldShortCircuit =
    healthIssue !== null &&
    (workspace.type !== 'multi-repo' ||
      healthIssue.code === 'missing-worktree-path');
  if (shouldShortCircuit) {
    return {
      projectId: workspaceId,
      worktreeId,
      insertions: 0,
      deletions: 0,
      healthIssue,
    };
  }

  // Health reporting must still run when the checkout is missing. Admit the
  // observation's Git work only after that result has been recorded.
  return withWorktreeGitRead<DiffStatsBatchResponseItem>(
    workspaceId,
    worktreeId,
    { projectId: workspaceId, worktreeId, insertions: 0, deletions: 0 },
    async () => {
      const worktreePath =
        workspace.type === 'multi-repo'
          ? getWorkspaceWorktreeDir(workspaceId, worktreeId)
          : getWorktreeDir(workspaceId, worktreeId);

      if (workspace.type === 'multi-repo') {
        const result = await aggregateMultiRepoDiffStats(
          workspaceId,
          worktreeId,
          worktreePath,
          options,
        );
        const canopyHash = await getCanopyJsonHash(worktreePath).catch(
          () => null,
        );
        return {
          projectId: workspaceId,
          worktreeId,
          insertions: result.stats.insertions,
          deletions: result.stats.deletions,
          baseBranch: result.baseBranch,
          baseBranchExistsLocally: result.baseBranchExistsLocally,
          baseBranchExistsInRemote: result.baseBranchExistsInRemote,
          hasOriginRemote: result.hasOriginRemote,
          hasCommitsAhead: result.hasCommitsAhead,
          hasUncommittedChanges: result.hasUncommittedChanges,
          hasRemoteTrackingBranch: result.hasRemoteTrackingBranch,
          hasUnpushedCommits: result.hasUnpushedCommits,
          hasUnpulledCommits: result.hasUnpulledCommits,
          hasBranchBeenPushed: result.hasBranchBeenPushed,
          repoBranches: result.repoBranches,
          canopyJsonHash: canopyHash ?? undefined,
          healthIssue: healthIssue ?? undefined,
        };
      }

      const hasOriginRemote = Boolean(await getRemoteUrl(worktreePath));
      if (hasOriginRemote && !shouldSkipAutomaticFetch(options)) {
        await fetchOrigin(worktreePath, {
          prune: true,
          ttlMs: AUTOMATIC_FETCH_TTL_MS,
        });
      }
      const effectiveBaseBranch = await resolveEffectiveBaseBranchForStats({
        projectId: workspaceId,
        worktreeId,
        repoPath: worktreePath,
        allowRemoteLookup: !shouldSkipAutomaticFetch(options),
      });
      const resolved: {
        stats: DiffStats;
        branchName: string | undefined;
        commitsAhead: boolean;
        uncommitted: boolean;
        remoteTracking: boolean;
        unpushed: boolean;
        unpulled: boolean;
        pushed: boolean;
        canopyHash: string | null;
        defaultBranch: string | null;
      } = {
        stats: { insertions: 0, deletions: 0 },
        branchName: undefined,
        commitsAhead: false,
        uncommitted: false,
        remoteTracking: false,
        unpushed: false,
        unpulled: false,
        pushed: false,
        canopyHash: null,
        defaultBranch: null,
      };
      const gitStatTasks: Array<() => Promise<void>> = [
        async (): Promise<void> => {
          const diffStatsStartedAt = performance.now();
          resolved.stats = await (
            options?.readDiffStats ?? readDiffStatsDirectly
          )(
            { repoId: WORKSPACE_ROOT_REPO_ID, repoPath: worktreePath },
            effectiveBaseBranch.branch ?? undefined,
          );
          if (diagnostics) {
            diagnostics.diffStatsElapsedMs =
              elapsedMilliseconds(diffStatsStartedAt);
          }
        },
        async (): Promise<void> => {
          resolved.branchName = await getCurrentBranchDisplayName(
            worktreePath,
          ).catch(() => undefined);
        },
        async (): Promise<void> => {
          resolved.commitsAhead = await hasCommitsAhead(
            worktreePath,
            effectiveBaseBranch.branch ?? undefined,
          ).catch(() => false);
        },
        async (): Promise<void> => {
          resolved.uncommitted = await hasUncommittedChanges(
            worktreePath,
          ).catch(() => false);
        },
        async (): Promise<void> => {
          resolved.remoteTracking = await hasRemoteTrackingBranch(
            worktreePath,
          ).catch(() => false);
        },
        async (): Promise<void> => {
          resolved.unpushed = await hasUnpushedCommits(worktreePath).catch(
            () => false,
          );
        },
        async (): Promise<void> => {
          resolved.unpulled = await hasUnpulledCommits(worktreePath).catch(
            () => false,
          );
        },
        async (): Promise<void> => {
          resolved.pushed = await hasBranchBeenPushedToRemote(
            worktreePath,
          ).catch(() => false);
        },
        async (): Promise<void> => {
          resolved.canopyHash = await getCanopyJsonHash(worktreePath).catch(
            () => null,
          );
        },
        async (): Promise<void> => {
          resolved.defaultBranch = worktree?.trackedBaseBranch
            ? await resolveRepoDefaultBranch(worktreePath, {
                allowRemoteLookup: !shouldSkipAutomaticFetch(options),
              })
            : effectiveBaseBranch.branch;
        },
      ];
      await mapWithConcurrency(
        gitStatTasks,
        WORKTREE_STATS_GIT_CONCURRENCY,
        (task) => task(),
      );
      return {
        projectId: workspaceId,
        worktreeId,
        insertions: resolved.stats.insertions,
        deletions: resolved.stats.deletions,
        hasOriginRemote,
        hasCommitsAhead: resolved.commitsAhead,
        hasUncommittedChanges: resolved.uncommitted,
        hasRemoteTrackingBranch: resolved.remoteTracking,
        hasUnpushedCommits: resolved.unpushed,
        hasUnpulledCommits: resolved.unpulled,
        hasBranchBeenPushed: resolved.pushed,
        branchName: resolved.branchName,
        baseBranch: effectiveBaseBranch.branch,
        baseBranchExistsLocally: effectiveBaseBranch.existsLocally,
        baseBranchExistsInRemote: effectiveBaseBranch.existsInRemote,
        defaultBranch: resolved.defaultBranch,
        canopyJsonHash: resolved.canopyHash ?? undefined,
      };
    },
  );
}

async function computeAndCacheWorktreeStats(
  workspaceId: string,
  worktreeId: string,
  mode: 'fresh-local' | 'fresh-remote',
  context: GitRequestContext,
  inputIdentity: string,
  readDiffStats: WorktreeRepoDiffStatsReader | undefined,
): Promise<DiffStatsBatchResponseItem> {
  const identityKey = worktreeStatsIdentityKey(workspaceId, worktreeId);
  const generation = getWorktreeStatsGeneration(identityKey);
  const inFlightKey = worktreeStatsInFlightKey(
    identityKey,
    generation,
    mode,
    inputIdentity,
  );
  const existing = worktreeStatsInFlight.get(inFlightKey);
  if (existing) {
    return existing;
  }
  worktreeStatsComputationRevision += 1;
  const revision = worktreeStatsComputationRevision;

  const computation = runWithGitRequestContext(context, async () => {
    const startedAt = performance.now();
    const diagnostics: { diffStatsElapsedMs?: number } = {};
    const result = await computeWorktreeStats(
      workspaceId,
      worktreeId,
      { skipFetch: mode === 'fresh-local', readDiffStats },
      diagnostics,
    );
    const elapsedMs = elapsedMilliseconds(startedAt);
    if (elapsedMs > 250) {
      recordWorktreeStatsTiming({
        workspaceId,
        worktreeId,
        elapsedMs,
        diffStatsElapsedMs: diagnostics.diffStatsElapsedMs,
        skipFetch: mode === 'fresh-local',
        mode: 'full',
      });
    }
    return result;
  }).then((result) => {
    const cached = worktreeStatsCompleted.get(identityKey);
    if (
      getWorktreeStatsGeneration(identityKey) === generation &&
      worktreeStatsInputIdentities.get(identityKey) === inputIdentity &&
      (cached === undefined || revision >= cached.revision)
    ) {
      worktreeStatsCompleted.set(identityKey, {
        result,
        completedAt: Date.now(),
        generation,
        inputIdentity,
        revision,
      });
      pruneWorktreeStatsCompletedResults();
    }
    return result;
  });
  worktreeStatsInFlight.set(inFlightKey, computation);
  try {
    return await computation;
  } finally {
    if (worktreeStatsInFlight.get(inFlightKey) === computation) {
      worktreeStatsInFlight.delete(inFlightKey);
    }
  }
}

/**
 * Reads main-owned worktree stats with explicit freshness semantics. Fresh
 * calls retain exact local/remote isolation and single-flight behavior.
 * `stale-ok` serves a recent completed result across renderer, portal, and
 * session consumers; after the fresh window it returns bounded stale data and
 * starts one local revalidation. `cache-only` retains identity assembly and
 * conditional cleanup, but starts no stats computation, health check or fetch.
 */
export function getWorktreeStats(
  workspaceId: string,
  worktreeId: string,
  options: WorktreeStatsOptions & { freshness: 'cache-only' },
): Promise<DiffStatsBatchResponseItem | null>;
export function getWorktreeStats(
  workspaceId: string,
  worktreeId: string,
  options?: WorktreeStatsOptions & {
    freshness?: Exclude<WorktreeStatsFreshnessMode, 'cache-only'>;
  },
): Promise<DiffStatsBatchResponseItem>;
export async function getWorktreeStats(
  workspaceId: string,
  worktreeId: string,
  options?: WorktreeStatsOptions,
): Promise<DiffStatsBatchResponseItem | null> {
  const mode = resolveWorktreeStatsFreshnessMode(options);
  const context: GitRequestContext = {
    source: options?.source ?? 'user-explicit',
    requestId: options?.requestId ?? randomUUID(),
  };
  const identityKey = worktreeStatsIdentityKey(workspaceId, worktreeId);
  let generation = getWorktreeStatsGeneration(identityKey);
  let inputIdentity = await resolveWorktreeStatsInputIdentity(
    workspaceId,
    worktreeId,
  );
  while (generation !== getWorktreeStatsGeneration(identityKey)) {
    generation = getWorktreeStatsGeneration(identityKey);
    inputIdentity = await resolveWorktreeStatsInputIdentity(
      workspaceId,
      worktreeId,
    );
  }
  worktreeStatsInputIdentities.set(identityKey, inputIdentity);
  const cached = worktreeStatsCompleted.get(identityKey);
  const age = cached
    ? Date.now() - cached.completedAt
    : Number.POSITIVE_INFINITY;
  const validCached =
    cached &&
    cached.generation === generation &&
    cached.inputIdentity === inputIdentity &&
    age >= 0
      ? cached
      : undefined;

  if (cached && !validCached) {
    worktreeStatsCompleted.delete(identityKey);
  }

  if (mode === 'cache-only') {
    if (!validCached || age > WORKTREE_STATS_MAX_STALE_RESULT_MS) {
      if (cached) worktreeStatsCompleted.delete(identityKey);
      return null;
    }
    return validCached.result;
  }

  const compatibleInFlight =
    mode === 'stale-ok'
      ? (worktreeStatsInFlight.get(
          worktreeStatsInFlightKey(
            identityKey,
            generation,
            'fresh-remote',
            inputIdentity,
          ),
        ) ??
        worktreeStatsInFlight.get(
          worktreeStatsInFlightKey(
            identityKey,
            generation,
            'fresh-local',
            inputIdentity,
          ),
        ))
      : undefined;

  if (mode === 'stale-ok' && validCached) {
    if (age < WORKTREE_STATS_FRESH_RESULT_TTL_MS) {
      return validCached.result;
    }
    if (age <= WORKTREE_STATS_MAX_STALE_RESULT_MS) {
      if (!compatibleInFlight) {
        trackDetachedWork(() =>
          computeAndCacheWorktreeStats(
            workspaceId,
            worktreeId,
            'fresh-local',
            context,
            inputIdentity,
            options?.readDiffStats,
          ).catch(() => undefined),
        );
      }
      return validCached.result;
    }
    worktreeStatsCompleted.delete(identityKey);
  }

  if (mode === 'stale-ok') {
    // A structural projection can consume either freshness class while it is
    // already being computed. Prefer an active remote-capable refresh, but do
    // not let a completed local-only result satisfy a later fresh-remote call.
    if (compatibleInFlight) {
      return compatibleInFlight;
    }
  }

  return computeAndCacheWorktreeStats(
    workspaceId,
    worktreeId,
    mode === 'fresh-remote' ? 'fresh-remote' : 'fresh-local',
    context,
    inputIdentity,
    options?.readDiffStats,
  );
}

/**
 * Read only the two diff-stat integers needed by overview badges. This path
 * deliberately uses persisted paths and tracked bases and performs no health,
 * branch, remote, fetch, or workspace mutation work.
 */
export async function getWorktreeDiffStatsOnly(
  workspaceId: string,
  worktreeId: string,
  readDiffStats: WorktreeRepoDiffStatsReader = readDiffStatsDirectly,
): Promise<DiffStats> {
  // Verification callers rely on rejection to distinguish unavailable from
  // a successful clean source. Never turn failed admission into zero stats.
  return getAvailableWorktreeDiffStatsOnly(
    workspaceId,
    worktreeId,
    readDiffStats,
  );
}

async function getAvailableWorktreeDiffStatsOnly(
  workspaceId: string,
  worktreeId: string,
  readDiffStats: WorktreeRepoDiffStatsReader = readDiffStatsDirectly,
): Promise<DiffStats> {
  const startedAt = performance.now();
  let outcome: 'success' | 'failure' = 'failure';
  try {
    const workspace = await getWorkspaceById(workspaceId);
    const worktree = workspace.worktrees.find(
      (entry) => entry.id === worktreeId,
    );
    if (
      !worktree ||
      !(await isWorktreeReadAvailable(workspaceId, worktreeId))
    ) {
      throw new Error(`Worktree ${worktreeId} is not ready`);
    }

    const resolveLocalBase = async (
      repoPath: string,
      repoId?: string,
    ): Promise<string | undefined> => {
      const effective = await resolveEffectiveBaseBranchForRepo({
        projectId: workspaceId,
        worktreeId,
        repoId,
        repoPath,
        allowRemoteLookup: false,
      });
      // Remote discovery is deliberately forbidden on the overview path. If
      // persisted config and local Git metadata cannot resolve a base, retain
      // the diff stats' HEAD-only fallback.
      return effective.branch ?? undefined;
    };

    let stats: DiffStats;
    if (workspace.type === 'single-repo') {
      const repoPath = getWorktreeDir(workspaceId, worktreeId);
      const baseBranch =
        worktree.trackedBaseBranch ?? (await resolveLocalBase(repoPath));
      stats = await readDiffStats(
        { repoId: WORKSPACE_ROOT_REPO_ID, repoPath },
        baseBranch,
      );
    } else {
      const repositories = await listWorkspaceWorktreeRepoEntries(
        workspaceId,
        getWorkspaceWorktreeRootRepoDir(workspaceId, worktreeId),
      );
      if (repositories.length === 0) {
        throw new Error(`Worktree ${worktreeId} has no ready repositories`);
      }
      const results = await mapWithConcurrency(
        repositories,
        REPO_DIFF_STATS_CONCURRENCY,
        async (repository): Promise<DiffStats | null> => {
          const baseBranch =
            worktree.trackedRepoBaseBranches?.[repository.repoId] ??
            (await resolveLocalBase(repository.repoPath, repository.repoId));
          return readDiffStats(repository, baseBranch).catch(() => null);
        },
      );
      const successful = results.filter(
        (result): result is DiffStats => result !== null,
      );
      if (successful.length === 0) {
        throw new Error(`Worktree ${worktreeId} repositories are unavailable`);
      }
      stats = successful.reduce(
        (total, result): DiffStats => ({
          insertions: total.insertions + result.insertions,
          deletions: total.deletions + result.deletions,
        }),
        { insertions: 0, deletions: 0 },
      );
    }

    outcome = 'success';
    return stats;
  } finally {
    const elapsedMs = elapsedMilliseconds(startedAt);
    recordWorktreeStatsTiming({
      workspaceId,
      worktreeId,
      elapsedMs,
      diffStatsElapsedMs: elapsedMs,
      mode: 'diff_only',
      outcome,
    });
  }
}

export async function getWorktreeCliRecord(
  workspaceId: string,
  worktreeId: string,
): Promise<WorktreeCliRecord> {
  const workspace = await getWorkspaceById(workspaceId);
  const worktree = workspace.worktrees.find((entry) => entry.id === worktreeId);
  if (!worktree) {
    throw new Error(`Worktree ${worktreeId} not found`);
  }

  const path =
    workspace.type === 'multi-repo'
      ? getWorkspaceWorktreeDir(workspaceId, worktreeId)
      : getWorktreeDir(workspaceId, worktreeId);

  return {
    workspaceId,
    workspaceName: workspace.name,
    workspaceType: workspace.type,
    id: worktree.id,
    branchName: worktree.branchName,
    createdAt: worktree.createdAt,
    path,
    status: worktree.status,
    branchPromptSent: worktree.branchPromptSent,
    trackedBaseBranch: worktree.trackedBaseBranch,
    trackedRepoBaseBranches: worktree.trackedRepoBaseBranches,
    seenPipelineExecutionIds: worktree.seenPipelineExecutionIds,
    lastKnownPrStatus: worktree.lastKnownPrStatus,
    pausedHookKeys: worktree.pausedHookKeys,
    stats: await getWorktreeStats(workspaceId, worktreeId, { source: 'cli' }),
  };
}

export async function listWorktreeCliRows(
  workspaceId: string,
): Promise<WorktreeCliRecord[]> {
  const workspace = await getWorkspaceById(workspaceId);
  return settleAll(
    workspace.worktrees.map((worktree) =>
      getWorktreeCliRecord(workspaceId, worktree.id),
    ),
  );
}

export async function listWorktreePipelineExecutions(options: {
  workspaceId: string;
  worktreeId: string;
  limit?: number;
  offset?: number;
}): Promise<Array<{ id: string; pipelineName: string; status: string }>> {
  validateId(options.workspaceId, 'workspaceId');
  validateId(options.worktreeId, 'worktreeId');
  const workspace = await getWorkspaceById(options.workspaceId);
  if (!workspace.worktrees.some((entry) => entry.id === options.worktreeId)) {
    throw new Error(`Worktree ${options.worktreeId} not found`);
  }
  const runtime = createCliExecutionRuntime({ cwd: process.cwd() });
  const summaries: ExecutionSummary[] = await listExecutionSummaries(
    runtime.executionsDir,
  );
  return summaries
    .filter(
      (summary) =>
        summary.project_id === options.workspaceId &&
        summary.worktree_id === options.worktreeId,
    )
    .slice(
      options.offset ?? 0,
      options.limit ? (options.offset ?? 0) + options.limit : undefined,
    )
    .map((summary) => ({
      id: summary.id,
      pipelineName: summary.pipeline_name,
      status: summary.status,
    }));
}
