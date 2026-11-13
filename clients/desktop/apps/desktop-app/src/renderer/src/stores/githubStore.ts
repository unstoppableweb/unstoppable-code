import type { BranchSyncAction } from '@/lib/githubBranchActions';
import { probeGitHubConnected } from '@/lib/githubConnection';
import { isWorktreeKeyVisible } from '@/lib/osNotifications';
import type {
  CanopyApi,
  PreferencesData,
  RepoBranchInfo,
  SidebarItem,
} from '@canopy/desktop-shared/types';
import {
  APP_ADVISOR_PROJECT_ID,
  SINGLE_REPO_USAGE_REPO_ID,
} from '@canopy/desktop-shared/types';
import type {
  CancelGitActionResponse,
  CommitAndPushResponse,
  CommitAndPushSkippedRepo,
  CommitPushPhase,
  CommitPushProgressEvent,
  CreatePrRequest,
  CreatePrResponse,
  DependentBaseBranchesUpdatedEvent,
  GenerateCommitMessagesFailedRepo,
  GenerateCommitMessagesResponse,
  GitHubRateLimitEvent,
  MergeLocalBranchesResponse,
  MergeLocalBranchSkippedRepo,
  MergePrPhase,
  MergePrProgressEvent,
  MergePrResponse,
  PrCreationPhase,
  PrCreationProgressEvent,
  PrDiffSnapshot,
  PrStatusEvent,
  PullFailedRepo,
  PullResponse,
  PullSkippedRepo,
  PushOnlyResponse,
  PushOnlySkippedRepo,
  RepoFailureResult,
  SplitPlan,
  SplitPrDiscardResponse,
  SplitPrExecutionErrorCode,
  SplitPrMap,
  SplitPrPhase,
  SplitPrPlanRefusalCode,
  SplitPrPlanResponse,
  SplitPrPlanResult,
  SplitPrProgressEvent,
  SplitWorkflowStartMode,
  WorktreePrStatus,
} from '@canopy/desktop-shared/types/github';
import type { SplitPlanIssue } from '@canopy/desktop-shared/types/pr-split-plan';
import {
  hasMergedPr,
  shouldShowWorktreeMergedState,
} from '@/lib/worktreeMergedState';
import { toAppError } from '@canopy/protocol/app-errors';
import {
  reportClientAppError,
  resolveClientAppError,
} from '@canopy/desktop-instrumentation/client';
import { inlineFailure, type InlineFailure } from '@/lib/inline-app-error';
import { create, type StoreApi } from 'zustand';
import { requestLoadedChangedFilesRefresh } from './changedFilesRefreshRuntime';
import {
  hasPendingGitHubConnectOffer,
  useGitHubConnectOfferStore,
  type GitHubActionContinuation,
} from './githubConnectOfferStore';
import { useProjectsStore } from './projectsStore';
import {
  addToast,
  resetToastStack,
  type Toast,
  type ToastMeta,
} from './toastStore';

type AgentResolutionMessageRepo = {
  repoName: string;
  kind: 'rebase_conflict' | 'stash_pop_conflict';
};

/** Who started a commit, PR or merge. Analytics only; main defaults to manual. */
export type GitShippingSource = NonNullable<CreatePrRequest['source']>;

/** A failed git or pull request action, scoped to its originating worktree. */
export interface GitActionFailure extends InlineFailure {
  seq: number;
  /**
   * Runs the failed action again with the same inputs, for actions where that
   * can fix the failure. The banner offers it as `Try again` or `Start over`,
   * whichever the error's recovery names.
   */
  retry?: () => void;
}

export interface PrMergeWarningState {
  projectId: string;
  worktreeId: string;
  repoIds: string[] | undefined;
  prUrl: string;
  unresolvedReviewThreadCount?: number;
  /** Repo backing the warned PR, for the triage chat marker. */
  repoId?: string;
  repoName?: string;
}

export interface PrCreationStep {
  phase: PrCreationPhase;
  repoName?: string;
  error?: string;
  timestamp: number;
}

export interface PrCreationProgress {
  steps: PrCreationStep[];
  currentPhase: PrCreationPhase;
}

export interface CommitPushStep {
  phase: CommitPushPhase;
  repoName?: string;
  error?: string;
  timestamp: number;
}

export interface CommitPushProgress {
  steps: CommitPushStep[];
  currentPhase: CommitPushPhase;
}

export interface MergePrStep {
  phase: MergePrPhase;
  repoId?: string;
  repoName?: string;
  queuePosition?: number;
  queueLength?: number;
  retryDelayMs?: number;
  error?: string;
  timestamp: number;
}

export interface MergePrProgress {
  steps: MergePrStep[];
  currentPhase: MergePrPhase;
}

type CommitReviewMessage = {
  repoId?: string;
  repoName: string;
  message: string;
};

type CommitReviewResolver = (result: {
  approved: boolean;
  messages?: CommitReviewMessage[];
}) => void;

export type CommitReviewActionLabel = 'Commit' | 'Commit & push';
export type CreatePrCommitReviewActionLabel = 'Commit, push & create PR';

interface CommitReviewPendingEntry {
  repos: CommitReviewMessage[];
  resolve: CommitReviewResolver;
  actionLabel: CommitReviewActionLabel | CreatePrCommitReviewActionLabel;
}

export type GitActionCancellationResult =
  | CancelGitActionResponse
  | { accepted: false; reason: 'request_failed' };

interface GitHubState {
  prStatuses: Record<string, WorktreePrStatus | null>;
  /**
   * Worktree keys whose `prStatuses[key]` value came from a genuine live
   * signal (a `PrStatusEvent`, or an explicit branch-change clear that
   * immediately requests a fresh poll) rather than
   * `hydratePersistedPrStatuses`'s wholesale copy of the renderer's own
   * (possibly stale) `worktree.lastKnownPrStatus`. A `null` value is only a
   * confirmed "no PR" for a key in this set — see `deriveDesktopRowPr`'s
   * caller, which falls back to the snapshot rather than clearing the badge
   * for a hydration-only `null` (CAN-3053 finding 8).
   */
  livePrStatusWorktreeKeys: ReadonlySet<string>;
  creatingPr: Set<string>;
  creationProgress: Record<string, PrCreationProgress>;
  committingAndPushing: Set<string>;
  mergingLocalBranches: Set<string>;
  mergingPr: Set<string>;
  mergePrProgress: Record<string, MergePrProgress>;
  /**
   * Worktree keys whose just-completed git action is now running its local
   * post-action stats refresh. Button-tooltip state only (relabels the button
   * "Refreshing..."); never surfaced in the PR activity-panel card.
   */
  gitStatsRefreshing: Set<string>;
  /** Correlation id for the visible multi-phase Git action per worktree. */
  gitActionOperationIds: Record<string, string | undefined>;
  /** Worktrees with a cancellable Git/GitHub IPC request currently in flight. */
  gitActionIpcPending: Set<string>;
  /** Worktrees whose current Git action is settling at a safe cancel boundary. */
  gitActionCancellationRequested: Set<string>;
  activeBranchSyncAction: Record<string, BranchSyncAction | undefined>;
  commitPushProgress: Record<string, CommitPushProgress>;
  commitReviewPending: Record<string, CommitReviewPendingEntry>;
  /** Unresolved-comment confirmations currently open, keyed by worktree. */
  prMergeWarnings: Record<string, PrMergeWarningState | undefined>;

  /** Worktree keys with an in-flight `planSplitPr` request. */
  planningSplitPr: Set<string>;
  /** Worktree keys with an in-flight `executeSplitPr` run. */
  splittingPr: Set<string>;
  /** Most recent planned (not-yet-executed) split plan per worktree key. */
  splitPrPlans: Record<string, SplitPrPlanResponse>;
  /** Ordered `executeSplitPr` progress events per worktree key. */
  splitPrProgress: Record<string, SplitPrProgressEvent[]>;
  /** Most recent persisted split map (including cancelled runs) per worktree key. */
  splitPrResults: Record<string, SplitPrMap>;
  /** Most recent `planSplitPr` refusal (if any) per worktree key. */
  splitPrRefusals: Record<
    string,
    {
      code: SplitPrPlanRefusalCode;
      message: string;
      issues?: SplitPlanIssue[];
    }
  >;
  /**
   * Most recent `executeSplitPr` `status: 'failed'` envelope (if any) per
   * worktree key. Distinct from `splitPrRefusals` (which is planning-only):
   * this captures classified execution failures — most notably
   * `plan_mismatch`, which has no persisted map to key a Discard affordance
   * off of, so it must be rendered from this structured failure directly
   * rather than only via a toast.
   */
  splitPrExecuteFailures: Record<
    string,
    {
      code?: SplitPrExecutionErrorCode;
      message: string;
      childIndex?: number;
      verifyTail?: string;
    }
  >;
  /** Leftover artifacts returned by the most recent successful split discard. */
  splitPrDiscardedArtifacts: Record<string, SplitPrDiscardResponse>;
  /**
   * The latest failed git or pull request action per worktree key, shown
   * under that worktree's top bar until dismissed or a new attempt starts.
   */
  gitActionFailures: Record<string, GitActionFailure>;
  /**
   * Worktree keys (`${projectId}/${worktreeId}`) currently under Split PR
   * lockdown. Mirrored from the main process via `onSplitLockChange` so
   * lock-aware affordances can render live.
   */
  splitLockedWorktrees: Set<string>;
  /**
   * Renderer-side presentation sessions for the full-panel Split PR workflow.
   * A session is opened when the workflow is (re)entered from ANY
   * `startSplitWorkflow` mode and OUTLIVES the main-process lock: on a
   * COMPLETED settle the lock releases but the session persists so the
   * SplitWorkflowView stays mounted to render the Finalize finished page.
   *
   * The session ends only on:
   *  - explicit user exit (Cancel paths / the Finalize "Done" button →
   *    `closeSplitWorkflowSession`),
   *  - a `status: 'failed'` execute settle (the failure modal over normal UX is
   *    the designed surface; the session must END before that modal gate
   *    evaluates so the two never double-stack), or
   *  - a cancellation settle (returns to normal UX as before).
   *
   * The session is presentation-only. The lock itself is unchanged and still
   * releases on every settle; guarded main-process operations become available
   * again once unlocked even while the finished page is showing, which is
   * intended.
   */
  splitWorkflowSessions: Set<string>;

  createPr: (
    projectId: string,
    worktreeId: string,
    repoIds?: string[],
    options?: { source?: GitShippingSource },
  ) => Promise<void>;
  planSplitPr: (
    projectId: string,
    worktreeId: string,
  ) => Promise<SplitPrPlanResult | null>;
  /**
   * Lockdown-aware launch entry point. Terminates the worktree's resources +
   * acquires the lock in the main process, then branches on `options.mode`:
   *
   *  - `'plan'` (default): plans and stores the result exactly like
   *    `planSplitPr`. Clears ALL stale per-key state (including
   *    `splitPrExecuteFailures`) so every fresh-launch surface shares one reset
   *    path.
   *  - `'resume'`: SKIPS planning and executes the stored `plan`+`snapshot`
   *    (passed in `options`) under the lock, handling the returned
   *    `SplitPrExecuteResponse` exactly like `approveSplitWorkflow` — the failed
   *    envelope repopulates `splitPrExecuteFailures[key]`, so the view swaps
   *    back out and the failure surfaces re-render.
   *  - `'review'`: SKIPS planning and just re-enters the lock; the store keeps
   *    its stored `splitPrPlans[key]` so the Review step shows the STORED plan
   *    (the per-key clearing is mode-aware and does NOT clear plans here).
   *
   * Returns `true` when the workflow was (re)entered under lockdown, `false`
   * on an error/refusal that released the lock, so callers (the failure modal)
   * know whether the view swapped in.
   */
  startSplitWorkflow: (
    projectId: string,
    worktreeId: string,
    options?: {
      mode?: SplitWorkflowStartMode;
      plan?: SplitPlan;
      snapshot?: PrDiffSnapshot;
    },
  ) => Promise<boolean>;
  /**
   * Approve + execute an approved plan under lockdown. Handles the
   * `SplitPrExecuteResponse` envelope; the main process releases the lock on
   * settle.
   */
  approveSplitWorkflow: (
    projectId: string,
    worktreeId: string,
    plan: SplitPlan,
    snapshot: PrDiffSnapshot,
  ) => Promise<void>;
  /**
   * Open the renderer-side presentation session for a worktree's Split PR
   * workflow. Idempotent. Called at the top of every `startSplitWorkflow`
   * dispatch so the SplitWorkflowView keys on `session OR locked` and survives
   * the COMPLETED-settle lock release.
   */
  openSplitWorkflowSession: (projectId: string, worktreeId: string) => void;
  /**
   * Close the renderer-side presentation session for a worktree's Split PR
   * workflow. Used by the Finalize "Done" button and internally on failure /
   * cancellation settle so the SplitWorkflowView unmounts and normal worktree
   * UX (plus any failure modal) takes over.
   */
  closeSplitWorkflowSession: (projectId: string, worktreeId: string) => void;
  /**
   * Exit the workflow (user cancel/close during plan/review). Releases the
   * main-process lock and cancels any in-flight execute.
   */
  exitSplitWorkflow: (projectId: string, worktreeId: string) => Promise<void>;
  cancelSplitPr: (projectId: string, worktreeId: string) => Promise<void>;
  /**
   * Discard the persisted split map for a worktree (no destructive git/GitHub
   * cleanup — the response lists leftover artifacts). On success, clears all
   * per-worktree split state so the UI returns to the pre-split affordance.
   * Returns the leftover artifacts (or null on failure).
   */
  discardSplitPr: (
    projectId: string,
    worktreeId: string,
  ) => Promise<SplitPrDiscardResponse | null>;
  clearSplitPrDiscardedArtifacts: (
    projectId: string,
    worktreeId: string,
  ) => void;
  clearSplitPlan: (projectId: string, worktreeId: string) => void;
  /**
   * Clears a previously stored `executeSplitPr` `status: 'failed'` structured
   * failure for a worktree (dismiss affordance / cleared automatically at the
   * start of the next `executeSplitPr` attempt).
   */
  clearSplitExecuteFailure: (projectId: string, worktreeId: string) => void;
  /**
   * Replaces the stored planner response's `plan` with the user-approved
   * (possibly edited) plan, so the store — not component-local state — is
   * the single source of truth for Retry and "Edit plan" after an approval.
   * No-op when there is no existing plan entry for the key.
   */
  commitApprovedSplitPlan: (
    projectId: string,
    worktreeId: string,
    edited: SplitPlan,
  ) => void;
  loadSplitPrMap: (projectId: string, worktreeId: string) => Promise<void>;
  commitAndPush: (
    projectId: string,
    worktreeId: string,
    options?: { pullFirst?: boolean; source?: GitShippingSource },
  ) => Promise<void>;
  commitOnly: (
    projectId: string,
    worktreeId: string,
    repoIds?: string[],
    options?: { source?: GitShippingSource },
  ) => Promise<void>;
  mergeLocalBranches: (
    projectId: string,
    worktreeId: string,
    repoIds?: string[],
  ) => Promise<void>;
  mergePr: (
    projectId: string,
    worktreeId: string,
    options?: {
      repoIds?: string[];
      confirmUnresolvedComments?: boolean;
      dryRun?: boolean;
      source?: GitShippingSource;
    },
  ) => Promise<MergePrResponse | null>;
  openPrMergeWarning: (warning: PrMergeWarningState) => void;
  clearPrMergeWarning: (projectId: string, worktreeId: string) => void;
  pushOnly: (projectId: string, worktreeId: string) => Promise<void>;
  /**
   * Run the one automatic continuation of a push or pull request that failed
   * on GitHub authentication, after the user connected GitHub. Its own
   * authentication failure shows the ordinary error, never a second offer.
   */
  continueAfterGitHubConnect: (
    continuation: GitHubActionContinuation,
  ) => Promise<void>;
  pull: (projectId: string, worktreeId: string) => Promise<void>;
  cancelGitAction: (
    projectId: string,
    worktreeId: string,
  ) => Promise<GitActionCancellationResult>;
  resolveCommitReview: (
    projectId: string,
    worktreeId: string,
    approved: boolean,
    messages?: CommitReviewMessage[],
  ) => void;
  requestRefresh: (projectId: string, worktreeId: string) => Promise<void>;
  requestFastRefresh: (
    projectId: string,
    worktreeId: string,
    skipIfFresh?: boolean,
  ) => Promise<void>;
  requestKnownPrFastRefresh: (
    projectId: string,
    worktreeId: string,
  ) => Promise<boolean>;
  clearWorktreePrStatus: (projectId: string, worktreeId: string) => void;
  /**
   * Shows a git or pull request failure under the worktree it started in,
   * never whichever worktree is selected when it settles.
   */
  raiseGitActionFailure: (
    projectId: string,
    worktreeId: string,
    failure: InlineFailure,
    attemptId?: string,
  ) => void;
  /** Dismisses one failure; a newer failure (another `seq`) stays. */
  dismissGitActionFailure: (
    projectId: string,
    worktreeId: string,
    seq: number,
  ) => void;
  hydratePersistedPrStatuses: (items: SidebarItem[]) => void;
  subscribeToEvents: () => () => void;
  /** Forwards to the neutral toast owner, so existing callers keep working. */
  addToast: typeof addToast;
}

type GitHubSetState = StoreApi<GitHubState>['setState'];

function markPrCreationProgressError(
  set: GitHubSetState,
  key: string,
  message: string,
): void {
  set((state) => {
    const progress = state.creationProgress[key];
    const errorStep: PrCreationStep = {
      phase: 'error',
      error: message,
      timestamp: Date.now(),
    };
    const updatedProgress: PrCreationProgress = {
      steps: [...(progress?.steps ?? []), errorStep],
      currentPhase: 'error',
    };
    return {
      creationProgress: {
        ...state.creationProgress,
        [key]: updatedProgress,
      },
    };
  });
}

function clearPrCreationProgress(set: GitHubSetState, key: string): void {
  set((state) => {
    const next = { ...state.creationProgress };
    delete next[key];
    return { creationProgress: next };
  });
}

export function worktreeKey(projectId: string, worktreeId: string): string {
  return `${projectId}/${worktreeId}`;
}

let gitActionFailureSeq = 0;
const gitFailureAttempts = new Map<string, string>();
/** How to run each worktree's current attempt again, keyed like the attempts. */
const gitFailureRetries = new Map<string, () => void>();

/**
 * A new attempt supersedes the worktree's previous failure. `retry` runs this
 * attempt again with the same inputs; a failure the attempt raises offers it.
 * Merges and split workflows pass none: a partly finished merge is not safe
 * to repeat blindly, and splits have their own Retry and Resume.
 */
function clearGitActionFailure(
  set: GitHubStoreSet,
  key: string,
  retry?: () => void,
): string {
  const attemptId = createGitActionOperationId();
  gitFailureAttempts.set(key, attemptId);
  if (retry) gitFailureRetries.set(key, retry);
  else gitFailureRetries.delete(key);
  set((state) => {
    if (!(key in state.gitActionFailures)) return {};
    const next = { ...state.gitActionFailures };
    delete next[key];
    return { gitActionFailures: next };
  });
  return attemptId;
}

/**
 * Once an attempt has done something that is not safe to replay (created
 * PRs), its failures stop offering a retry, including one already showing.
 */
function dropGitActionRetry(
  set: GitHubStoreSet,
  key: string,
  attemptId: string,
): void {
  if (gitFailureAttempts.get(key) !== attemptId) return;
  gitFailureRetries.delete(key);
  set((state) => {
    const failure = state.gitActionFailures[key];
    if (!failure?.retry) return {};
    const next = { ...failure };
    delete next.retry;
    return { gitActionFailures: { ...state.gitActionFailures, [key]: next } };
  });
}

/**
 * The worktree's latest git action attempt. A failure raised outside an
 * attempt (loading branches) compares it with the value it saw when it
 * started, and drops itself when a newer attempt began in between.
 */
export function currentGitActionAttempt(
  projectId: string,
  worktreeId: string,
): string | undefined {
  return gitFailureAttempts.get(worktreeKey(projectId, worktreeId));
}

/**
 * For a failure raised outside a git action attempt (opening a link, loading
 * branches, starting a fix chat): call it when the work starts. The returned
 * raise drops the failure when a newer attempt began in between, so a late
 * rejection never replaces that attempt's failure or its Try again.
 */
export function gitActionFailureRaiser(
  projectId: string,
  worktreeId: string,
): (failure: InlineFailure) => void {
  const attemptAtStart = currentGitActionAttempt(projectId, worktreeId);
  return (failure): void => {
    if (currentGitActionAttempt(projectId, worktreeId) !== attemptAtStart)
      return;
    useGitHubStore
      .getState()
      .raiseGitActionFailure(projectId, worktreeId, failure);
  };
}

function createGitActionOperationId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `git-action-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

function isGitActionCancellationRequested(
  get: GitHubStoreGet,
  key: string,
  operationId: string,
): boolean {
  const state = get();
  return (
    state.gitActionOperationIds[key] === operationId &&
    state.gitActionCancellationRequested.has(key)
  );
}

/**
 * Pure eligibility check for offering the Split PR flow. Strict gating: the
 * toggle, single-repo, and open-PR requirements are all mandatory, and the
 * line-count threshold is inclusive (a PR exactly at the threshold is
 * eligible) since this only gates whether Split PR is *offered*, not a hard
 * ceiling.
 *
 * Line count prefers the live PR's own additions/deletions when BOTH are
 * defined; otherwise it falls back to the locally cached diff stats. A PR
 * with only one of additions/deletions defined is treated the same as
 * neither being defined, since a partial PR count cannot be trusted over the
 * cache.
 */
export function isSplitPrEligible(args: {
  prState: string | undefined;
  prAdditions: number | undefined;
  prDeletions: number | undefined;
  diffStats: { insertions: number; deletions: number } | undefined;
  splitPrEnabled: boolean;
  thresholdLines: number;
  isSingleRepo: boolean;
}): boolean {
  const {
    prState,
    prAdditions,
    prDeletions,
    diffStats,
    splitPrEnabled,
    thresholdLines,
    isSingleRepo,
  } = args;

  if (!splitPrEnabled || !isSingleRepo || prState !== 'open') {
    return false;
  }

  let lineCount: number | undefined;
  if (prAdditions !== undefined && prDeletions !== undefined) {
    lineCount = prAdditions + prDeletions;
  } else if (diffStats !== undefined) {
    lineCount = diffStats.insertions + diffStats.deletions;
  }

  if (lineCount === undefined) {
    return false;
  }

  return lineCount >= thresholdLines;
}

/**
 * Canonical forward order of commit/push phases. Used to keep the displayed
 * phase monotonic.
 */
const COMMIT_PUSH_PHASE_ORDER: readonly CommitPushPhase[] = [
  'pulling',
  'generating_message',
  'staging',
  'committing',
  'pushing',
  'done',
];

/**
 * Pick the further-along of two commit/push phases so the UI never moves
 * backward. A late or out-of-order earlier-phase event — e.g. the backend
 * re-reporting `generating_message` after the flow optimistically advanced to
 * `staging`, or interleaved per-repo events in a multi-repo worktree — must not
 * regress the displayed phase. `error` always wins; once `error`, stay `error`.
 */
export function furthestCommitPushPhase(
  previous: CommitPushPhase | undefined,
  next: CommitPushPhase,
): CommitPushPhase {
  if (next === 'error' || previous === 'error') return 'error';
  if (previous === undefined) return next;
  const previousRank = COMMIT_PUSH_PHASE_ORDER.indexOf(previous);
  const nextRank = COMMIT_PUSH_PHASE_ORDER.indexOf(next);
  return nextRank >= previousRank ? next : previous;
}

function lookupWorkspaceName(projectId: string): string | undefined {
  return useProjectsStore.getState().projects.find((p) => p.id === projectId)
    ?.name;
}

/**
 * Fire an in-app toast + OS notification (via {@link GitHubState.addToast})
 * when a Split PR workflow enters an idle state — a proposed plan awaiting the
 * user's review, or a completed split awaiting acknowledgement — while its
 * worktree is NOT the one the user is currently viewing. Mirrors the chat
 * unread toast: a workflow already in the foreground gets no toast, because the
 * user is looking straight at the Review/Done step it would announce.
 */
function maybeFireSplitIdleToast(
  get: GitHubStoreGet,
  projectId: string,
  worktreeId: string,
  kind: 'review' | 'done',
): void {
  if (isWorktreeKeyVisible(worktreeKey(projectId, worktreeId))) {
    return;
  }
  const message =
    kind === 'review'
      ? 'Split PR plan is ready for your review.'
      : 'Split PR complete.';
  get().addToast(message, 'info', undefined, {
    category: 'Split PR',
    workspaceName: lookupWorkspaceName(projectId),
    projectId,
    worktreeId,
  });
}

async function refreshGitHubWorktreeState(
  projectId: string,
  worktreeId: string,
  _api: CanopyApi,
  requestFastRefresh: GitHubState['requestFastRefresh'],
): Promise<void> {
  // The scoped stats refresh also refreshes an already-loaded Changed Files
  // projection before it settles, so every post-action git surface advances
  // through one ordered worktree refresh.
  await useProjectsStore
    .getState()
    .refreshWorktreeDiffStats(projectId, worktreeId)
    .catch((error: unknown) => {
      // Best effort: the fast refresh below still runs.
      reportClientAppError(error);
    });

  // The main process only enqueues the fast refresh and returns immediately, so
  // this does not extend the refresh window.
  await requestFastRefresh(projectId, worktreeId);
}

type SkippedRepoReason =
  | CommitAndPushSkippedRepo['reason']
  | PushOnlySkippedRepo['reason']
  | PullSkippedRepo['reason']
  | MergeLocalBranchSkippedRepo['reason'];

function collectNewlyMergedRepoIds(
  previous: WorktreePrStatus | null | undefined,
  next: WorktreePrStatus | null | undefined,
): Set<string> {
  const previousByRepoId = new Map(
    (previous?.repos ?? []).map((repo) => [repo.repoId, repo.status?.state]),
  );
  const mergedRepoIds = new Set<string>();

  for (const repo of next?.repos ?? []) {
    if (repo.status?.state !== 'merged') {
      continue;
    }
    if (previousByRepoId.get(repo.repoId) === 'merged') {
      continue;
    }
    mergedRepoIds.add(repo.repoId);
  }

  return mergedRepoIds;
}

function normalizeBranchName(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function findWorktreePrStatus(
  projects: SidebarItem[],
  projectId: string,
  worktreeId: string,
): WorktreePrStatus | null | undefined {
  const project = projects.find((candidate) => candidate.id === projectId);
  if (!project || project.type === 'cowork') {
    return undefined;
  }
  return project.worktrees.find((worktree) => worktree.id === worktreeId)
    ?.lastKnownPrStatus;
}

function getRepoBaseBranch(args: {
  repoBranches: Record<string, RepoBranchInfo[]>;
  baseBranches: Record<string, string | null>;
  projects: SidebarItem[];
  projectId: string;
  worktreeId: string;
  repoId: string;
}): string | null {
  const key = worktreeKey(args.projectId, args.worktreeId);
  const repoBranch = args.repoBranches[key]?.find(
    (branch) => branch.repoId === args.repoId,
  );
  const repoBaseBranch = normalizeBranchName(repoBranch?.baseBranch);
  if (repoBaseBranch) {
    return repoBaseBranch;
  }

  const aggregateBaseBranch = normalizeBranchName(args.baseBranches[key]);
  if (aggregateBaseBranch) {
    return aggregateBaseBranch;
  }

  const project = args.projects.find(
    (candidate) => candidate.id === args.projectId,
  );
  const worktree =
    project && project.type !== 'cowork'
      ? project.worktrees.find((candidate) => candidate.id === args.worktreeId)
      : undefined;

  return normalizeBranchName(
    worktree?.trackedRepoBaseBranches?.[args.repoId] ??
      worktree?.trackedBaseBranch,
  );
}

function parentWorktreeUsesBranch(args: {
  repoBranches: Record<string, RepoBranchInfo[]>;
  projectId: string;
  worktreeId: string;
  worktreeBranchName: string;
  repoId: string;
  baseBranch: string;
}): boolean {
  const key = worktreeKey(args.projectId, args.worktreeId);
  const repoBranches = args.repoBranches[key];
  if (repoBranches) {
    return repoBranches.some(
      (branch) =>
        branch.repoId === args.repoId && branch.branch === args.baseBranch,
    );
  }

  return args.worktreeBranchName === args.baseBranch;
}

function collectParentBranchRefreshTargets(args: {
  projects: SidebarItem[];
  repoBranches: Record<string, RepoBranchInfo[]>;
  baseBranches: Record<string, string | null>;
  projectId: string;
  worktreeId: string;
  mergedRepoIds: Set<string>;
}): Array<{ projectId: string; worktreeId: string }> {
  if (args.mergedRepoIds.size === 0) {
    return [];
  }

  const targets = new Map<string, { projectId: string; worktreeId: string }>();
  const project = args.projects.find(
    (candidate) => candidate.id === args.projectId,
  );
  if (!project || project.type === 'cowork') {
    return [];
  }

  for (const repoId of Array.from(args.mergedRepoIds)) {
    const baseBranch = getRepoBaseBranch({
      repoBranches: args.repoBranches,
      baseBranches: args.baseBranches,
      projects: args.projects,
      projectId: args.projectId,
      worktreeId: args.worktreeId,
      repoId,
    });
    if (!baseBranch) {
      continue;
    }

    for (const worktree of project.worktrees) {
      if (worktree.id === args.worktreeId) {
        continue;
      }
      if (
        !parentWorktreeUsesBranch({
          repoBranches: args.repoBranches,
          projectId: project.id,
          worktreeId: worktree.id,
          worktreeBranchName: worktree.branchName,
          repoId,
          baseBranch,
        })
      ) {
        continue;
      }

      const key = worktreeKey(project.id, worktree.id);
      targets.set(key, { projectId: project.id, worktreeId: worktree.id });
    }
  }

  return Array.from(targets.values());
}

function hasOpenPr(status: WorktreePrStatus | null | undefined): boolean {
  if (!status) return false;
  return status.repos.some(
    (repo) => repo.status?.state === 'open' || repo.status?.state === 'draft',
  );
}

function hasPrForEveryRepo(
  status: WorktreePrStatus | null | undefined,
): boolean {
  if (!status || status.repos.length === 0) return false;
  return status.repos.every((repo) => repo.status !== null);
}

function shouldClearStalePrCreationProgress(
  status: WorktreePrStatus | null | undefined,
  progress: PrCreationProgress | undefined,
  isCreatingPr: boolean,
): boolean {
  return (
    !isCreatingPr &&
    progress?.currentPhase === 'error' &&
    hasPrForEveryRepo(status)
  );
}

export { shouldShowWorktreeMergedState };

function formatRepoEntries<T>(
  entries: T[],
  formatter: (entry: T) => string,
): string {
  const rendered = entries.slice(0, 3).map(formatter);
  if (entries.length > 3) {
    rendered.push(`+${entries.length - 3} more`);
  }
  return rendered.join(', ');
}

function describeCommitAndPushSkipReason(reason: SkippedRepoReason): string {
  switch (reason) {
    case 'no_remote_tracking':
      return 'no remote tracking branch';
    case 'no_uncommitted_changes':
      return 'no uncommitted changes';
    case 'commits_not_pushed':
      return 'commits not pushed';
    default:
      return reason;
  }
}

function describePushOnlySkipReason(reason: SkippedRepoReason): string {
  switch (reason) {
    case 'no_remote_tracking':
      return 'no remote tracking branch';
    case 'no_commits_ahead':
      return 'no commits to push';
    case 'no_remote_origin':
      return 'no origin remote';
    default:
      return reason;
  }
}

function describePullSkipReason(reason: SkippedRepoReason): string {
  switch (reason) {
    case 'no_remote_tracking':
      return 'no remote tracking branch';
    case 'not_behind':
      return 'branch is up to date';
    case 'no_remote_origin':
      return 'no origin remote';
    default:
      return reason;
  }
}

function describeMergeSkipReason(
  reason: MergeLocalBranchSkippedRepo['reason'],
): string {
  switch (reason) {
    case 'missing_base_branch':
      return 'missing base branch';
    case 'same_branch':
      return 'already on the base branch';
    case 'uncommitted_changes':
      return 'uncommitted changes';
    case 'no_commits_ahead':
      return 'no commits to merge';
    case 'has_remote_origin':
      return 'has remote origin';
    default:
      return reason;
  }
}

function buildFailedReposMessage<
  T extends
    | RepoFailureResult
    | PullFailedRepo
    | GenerateCommitMessagesFailedRepo,
>(actionLabel: string, failedRepos: T[]): string {
  return `${actionLabel} failed for ${failedRepos.length} ${failedRepos.length === 1 ? 'repo' : 'repos'}: ${formatRepoEntries(failedRepos, (repo) => `${repo.repoName} (${repo.error})`)}`;
}

/** Preserve the complete partial-success reason without rendering command output. */
function buildFailedReposFailure<
  T extends
    | RepoFailureResult
    | PullFailedRepo
    | GenerateCommitMessagesFailedRepo,
>(actionLabel: string, failedRepos: T[]): InlineFailure {
  return {
    error: `${actionLabel} failed for ${failedRepos.length} ${failedRepos.length === 1 ? 'repo' : 'repos'}.`,
    details: buildFailedReposMessage(actionLabel, failedRepos),
  };
}

function describeAgentResolutionKind(
  kind: AgentResolutionMessageRepo['kind'],
): string {
  return kind === 'rebase_conflict'
    ? 'rebase conflicts'
    : 'stash-pop conflicts';
}

/**
 * The toast that announces a resolution chat is a shortcut back to it: the
 * chat comes forward when it starts, but the user may have moved on, or the
 * pull may have opened one chat per repo (the first is linked; the others
 * are named in the message and sit in the tab bar). The chat id stays out
 * of the toast metadata on purpose: with one present, the OS notification
 * gate keys on that exact chat instead of the worktree, so a focused window
 * could get a native banner on top of the toast. The dynamic import breaks
 * the module cycle: the chat notification helpers import this store for
 * their own toasts.
 */
function openAgentResolutionChat(target: {
  projectId: string;
  worktreeId: string;
  chatId: string;
}): () => void {
  return (): void => {
    void import('./chat/notifications').then(({ navigateToWorktreeChat }) =>
      navigateToWorktreeChat(target),
    );
  };
}

function buildAgentResolutionMessage(
  repos: AgentResolutionMessageRepo[],
  actionLabel = 'commit & push',
): string {
  if (repos.length === 1) {
    const repo = repos[0];
    return `${repo.repoName}: ${describeAgentResolutionKind(repo.kind)} detected during pull. An agent chat has been started to resolve and finish the ${actionLabel}.`;
  }
  const rendered = repos
    .slice(0, 3)
    .map(
      (repo) => `${repo.repoName} (${describeAgentResolutionKind(repo.kind)})`,
    );
  if (repos.length > 3) rendered.push(`+${repos.length - 3} more`);
  return `Pull conflicts detected in ${repos.length} repos: ${rendered.join(', ')}. Agent chats have been started to resolve each one and finish the ${actionLabel}.`;
}

function buildSkippedReposMessage<
  T extends CommitAndPushSkippedRepo | PushOnlySkippedRepo | PullSkippedRepo,
>(
  actionLabel: string,
  skippedRepos: T[],
  describeReason: (reason: SkippedRepoReason) => string,
): string {
  return `${actionLabel} skipped ${skippedRepos.length} ${skippedRepos.length === 1 ? 'repo' : 'repos'}: ${formatRepoEntries(skippedRepos, (repo) => `${repo.repoName} (${describeReason(repo.reason)})`)}`;
}

interface RunCommitFlowParams {
  projectId: string;
  worktreeId: string;
  /**
   * `commit-and-push` runs the existing remote-backed flow.
   * `commit` is the local-only flow: skips push (`commitOnly: true`) and skips
   * the `pullFirst` plumbing entirely.
   */
  mode: 'commit-and-push' | 'commit';
  /** Restrict the operation to a specific subset of repos (commit-only flow). */
  repoIds?: string[];
  /** Rebase-pull before committing. Only meaningful for `commit-and-push`. */
  pullFirst?: boolean;
  source?: GitShippingSource;
  continuation?: GitHubActionContinuation;
  /**
   * Set by a Try again: called when a selected repository is already clean.
   * Main then leaves that repository's pending commits for the bar's Push.
   */
  onNothingToCommit?: () => void;
}

type GitHubStoreSet = (
  partial:
    | Partial<GitHubState>
    | ((state: GitHubState) => Partial<GitHubState>),
) => void;
type GitHubStoreGet = () => GitHubState;

function handleCommitAndPushResponse(
  get: GitHubStoreGet,
  projectId: string,
  worktreeId: string,
  response: CommitAndPushResponse,
  failureLabel: string,
  commitMeta: ToastMeta,
  failureAttemptId: string,
): void {
  if (response.failedRepos.length > 0) {
    get().raiseGitActionFailure(
      projectId,
      worktreeId,
      {
        ...buildFailedReposFailure(failureLabel, response.failedRepos),
      },
      failureAttemptId,
    );
  }
  if (response.skippedRepos.length > 0) {
    get().addToast(
      buildSkippedReposMessage(
        failureLabel,
        response.skippedRepos,
        describeCommitAndPushSkipReason,
      ),
      'info',
      undefined,
      commitMeta,
    );
  }
  if (response.agentResolutionRepos.length > 0) {
    const [first] = response.agentResolutionRepos;
    const target =
      first && commitMeta.projectId && commitMeta.worktreeId
        ? {
            projectId: commitMeta.projectId,
            worktreeId: commitMeta.worktreeId,
            chatId: first.chatId,
          }
        : null;
    get().addToast(
      buildAgentResolutionMessage(response.agentResolutionRepos),
      'warning',
      target ? openAgentResolutionChat(target) : undefined,
      commitMeta,
    );
  }
}

function hasReviewBlockingSkippedRepos(
  skippedRepos: ReadonlyArray<{
    reason: CommitAndPushSkippedRepo['reason'];
  }>,
): boolean {
  return skippedRepos.some((repo) => repo.reason !== 'no_uncommitted_changes');
}

/** Mark a worktree as running its post-action local Git stats refresh. */
function markGitStatsRefreshing(set: GitHubStoreSet, key: string): void {
  set((state) => ({
    gitStatsRefreshing: new Set([...Array.from(state.gitStatsRefreshing), key]),
  }));
}

async function refreshGitActionState(
  set: GitHubStoreSet,
  get: GitHubStoreGet,
  key: string,
  projectId: string,
  worktreeId: string,
  api: CanopyApi,
): Promise<void> {
  markGitStatsRefreshing(set, key);
  await refreshGitHubWorktreeState(
    projectId,
    worktreeId,
    api,
    get().requestFastRefresh,
  );
}

async function runGitActionIpc<T>(
  set: GitHubStoreSet,
  key: string,
  operationId: string,
  run: () => Promise<T>,
): Promise<T> {
  set((state) => ({
    gitActionIpcPending: new Set([
      ...Array.from(state.gitActionIpcPending),
      key,
    ]),
  }));
  try {
    return await run();
  } finally {
    set((state) => {
      if (state.gitActionOperationIds[key] !== operationId) return {};
      const next = new Set(state.gitActionIpcPending);
      next.delete(key);
      return { gitActionIpcPending: next };
    });
  }
}

function isGitHubAuthFailure(repo: RepoFailureResult): boolean {
  return repo.failureCode === 'github_not_authenticated';
}

/** Multi-repo rows and single-repo aggregate state describe the same target. */
function gitHubRepositorySnapshot(
  projectId: string,
  worktreeId: string,
): RepoBranchInfo[] | undefined {
  const state = useProjectsStore.getState();
  const key = worktreeKey(projectId, worktreeId);
  const rows = state.repoBranches[key];
  if (rows?.length) return rows.map((repo) => ({ ...repo }));
  const project = state.projects.find(
    (candidate) => candidate.id === projectId,
  );
  if (project?.type !== 'single-repo') return undefined;
  const worktree = project.worktrees.find(
    (candidate) => candidate.id === worktreeId,
  );
  if (!worktree?.branchName?.trim()) return undefined;
  return [
    {
      repoId: SINGLE_REPO_USAGE_REPO_ID,
      repoName: project.name,
      branch: worktree.branchName,
      baseBranch: state.baseBranches[key],
    },
  ];
}

/** The one branch every repository targets, or null when it is not known. */
function gitHubContinuationBranch(
  projectId: string,
  worktreeId: string,
  repoIds: readonly string[],
  branches = gitHubRepositorySnapshot(projectId, worktreeId),
): string | null {
  const names = new Set(
    repoIds.map(
      (repoId) =>
        branches?.find((branch) => branch.repoId === repoId)?.branch.trim() ??
        '',
    ),
  );
  const [name] = Array.from(names);
  return names.size === 1 && name ? name : null;
}

/**
 * Offer to connect GitHub for repositories that failed on GitHub
 * authentication. Returns true when the offer represents those failures, so
 * the caller leaves them out of its error toast. A continuation, or another
 * operation's pending offer, keeps the ordinary error.
 */
function offerGitHubConnect(args: {
  kind: GitHubActionContinuation['kind'];
  source?: GitShippingSource;
  telemetryRepoCount?: number;
  projectId: string;
  worktreeId: string;
  failed: readonly RepoFailureResult[];
  /** Omit to continue the original selection (see the continuation type). */
  repoIds?: string[];
  establishUpstream?: boolean;
  pullFirst?: boolean;
  continuation?: GitHubActionContinuation;
  branches?: readonly RepoBranchInfo[];
  operationId?: string;
  skipCommit?: boolean;
  pushCompletedRepoIds?: string[];
}): boolean {
  if (args.continuation || args.failed.length === 0) return false;
  const failedRepoIds = args.failed.flatMap((repo) =>
    repo.repoId ? [repo.repoId] : [],
  );
  const repoIds =
    'repoIds' in args
      ? args.repoIds
      : failedRepoIds.length === args.failed.length
        ? failedRepoIds
        : [];
  const expectedHeadBranch =
    failedRepoIds.length === args.failed.length && repoIds?.length !== 0
      ? gitHubContinuationBranch(
          args.projectId,
          args.worktreeId,
          repoIds ?? failedRepoIds,
          args.branches ? [...args.branches] : undefined,
        )
      : null;
  const branchRows =
    args.branches ?? gitHubRepositorySnapshot(args.projectId, args.worktreeId);
  const headEntries = (repoIds ?? []).flatMap(
    (repoId): Array<[string, string]> => {
      const branch = branchRows
        ?.find((row) => row.repoId === repoId)
        ?.branch.trim();
      return branch ? [[repoId, branch]] : [];
    },
  );
  const result = useGitHubConnectOfferStore.getState().requestOffer({
    operationId: args.operationId ?? createGitActionOperationId(),
    kind: args.kind,
    ...(args.source ? { source: args.source } : {}),
    ...(args.telemetryRepoCount
      ? { telemetryRepoCount: args.telemetryRepoCount }
      : {}),
    projectId: args.projectId,
    worktreeId: args.worktreeId,
    ...(repoIds ? { repoIds } : {}),
    expectedHeadBranch,
    ...(repoIds?.length && headEntries.length === repoIds.length
      ? {
          expectedHeadBranches: Object.fromEntries(headEntries),
        }
      : {}),
    skipCommit: args.skipCommit ?? true,
    ...(args.pullFirst ? { pullFirst: true } : {}),
    pushCompletedRepoIds:
      args.pushCompletedRepoIds ??
      args.failed.flatMap((repo) =>
        repo.pushCompleted && repo.repoId ? [repo.repoId] : [],
      ),
    ...(args.failed.some((repo) => repo.commitPrepared !== undefined)
      ? {
          repoCommitPrepared: Object.fromEntries(
            args.failed.flatMap((repo) =>
              repo.repoId ? [[repo.repoId, repo.commitPrepared ?? true]] : [],
            ),
          ),
        }
      : {}),
    ...(args.establishUpstream ? { establishUpstream: true } : {}),
  });
  return result !== 'busy';
}

/** Splits failures into those a connect offer now represents and the rest. */
function takeGitHubAuthFailures<T extends RepoFailureResult>(
  failedRepos: T[],
  offer: Omit<Parameters<typeof offerGitHubConnect>[0], 'failed'>,
): T[] {
  const authFailures = failedRepos.filter(isGitHubAuthFailure);
  if (!offerGitHubConnect({ ...offer, failed: authFailures })) {
    return failedRepos;
  }
  return failedRepos.filter((repo) => !isGitHubAuthFailure(repo));
}

/** A new manual action waits for a pending connect offer on its worktree. */
function rejectWhileGitHubConnectPending(
  get: GitHubStoreGet,
  projectId: string,
  worktreeId: string,
): boolean {
  if (!useGitHubConnectOfferStore.getState().offer) return false;
  get().addToast(
    'Finish connecting GitHub, then try again.',
    'info',
    undefined,
    {
      category: 'GitHub',
      workspaceName: lookupWorkspaceName(projectId),
      projectId,
      worktreeId,
    },
  );
  return true;
}

/** Whether a continuation's project, worktree, repositories or branch changed. */
function gitHubContinuationTargetChanged(
  continuation: GitHubActionContinuation,
): boolean {
  const { projects } = useProjectsStore.getState();
  const project = projects.find(
    (candidate) => candidate.id === continuation.projectId,
  );
  if (
    !project ||
    project.type === 'cowork' ||
    !project.worktrees.some(
      (worktree) => worktree.id === continuation.worktreeId,
    )
  ) {
    return true;
  }
  const branches = gitHubRepositorySnapshot(
    continuation.projectId,
    continuation.worktreeId,
  );
  if (!branches) return true;
  return (continuation.repoIds ?? []).some((repoId) => {
    const branch = branches.find((candidate) => candidate.repoId === repoId);
    return (
      !branch ||
      branch.branch !==
        (continuation.expectedHeadBranches?.[repoId] ??
          continuation.expectedHeadBranch)
    );
  });
}

// Reserve a worktree while its read-only PR preflight runs, before progress
// starts. The ordinary activity sets take ownership once mutation begins.
const startingGitHubActions = new Set<string>();

function gitHubActionBusy(get: GitHubStoreGet, key: string): boolean {
  const state = get();
  return (
    startingGitHubActions.has(key) ||
    state.creatingPr.has(key) ||
    state.committingAndPushing.has(key) ||
    state.mergingPr.has(key) ||
    state.mergingLocalBranches.has(key)
  );
}

async function selectedRepositoriesNeedGitHub(
  projectId: string,
  worktreeId: string,
  repoIds: readonly string[],
): Promise<boolean> {
  if (repoIds.length === 0) return false;
  const results = await Promise.all(
    repoIds.map(async (repoId): Promise<boolean> => {
      try {
        const repoPath = await window.api.getWorktreePath({
          projectId,
          worktreeId,
          ...(repoId === SINGLE_REPO_USAGE_REPO_ID ? {} : { repoId }),
        });
        const slug = await window.api.getRepoSlug({ repoPath });
        return Boolean(slug?.owner && slug.repo);
      } catch (error: unknown) {
        // Unknown metadata leaves main's structured errors as the safety net.
        reportClientAppError(error);
        return false;
      }
    }),
  );
  return results.some(Boolean);
}

async function runCommitFlow(
  set: GitHubStoreSet,
  get: GitHubStoreGet,
  params: RunCommitFlowParams,
): Promise<boolean> {
  const { projectId, worktreeId, mode, continuation } = params;
  const source = params.source ?? continuation?.source;
  const sourceField = {
    ...(source ? { source } : {}),
    ...(continuation?.telemetryRepoCount
      ? { telemetryRepoCount: continuation.telemetryRepoCount }
      : {}),
  };
  const isCommitOnly = mode === 'commit';
  const pullFirst = !isCommitOnly && params.pullFirst === true;
  const repoIds = isCommitOnly || continuation ? params.repoIds : undefined;
  const actionLabel: CommitReviewActionLabel = isCommitOnly
    ? 'Commit'
    : 'Commit & push';
  const failureLabel = isCommitOnly ? 'Commit' : 'Commit & push';
  const branchSyncAction: BranchSyncAction = isCommitOnly
    ? 'commit'
    : pullFirst
      ? 'pull-commit-and-push'
      : 'commit-and-push';

  const key = worktreeKey(projectId, worktreeId);
  const state = get();
  if (
    startingGitHubActions.has(key) ||
    state.committingAndPushing.has(key) ||
    state.creatingPr.has(key) ||
    state.mergingLocalBranches.has(key) ||
    state.mergingPr.has(key)
  ) {
    return false;
  }
  if (
    !continuation &&
    rejectWhileGitHubConnectPending(get, projectId, worktreeId)
  ) {
    return false;
  }
  const operationId = createGitActionOperationId();
  // A commit that landed before its push failed leaves nothing to commit.
  // Running the flow again would then push those commits on its own (main
  // pushes a clean repository's pending commits) or stop silently. Guessing
  // which repositories to push is not safe here, so say what is left: the
  // bar's Push sends the commits with its own checks.
  const settleNothingToCommit = (): void => {
    const settledAttemptId = clearGitActionFailure(set, key);
    if (isCommitOnly) return;
    get().raiseGitActionFailure(
      projectId,
      worktreeId,
      { error: 'Your changes are already committed. Push to send them.' },
      settledAttemptId,
    );
  };
  const retryCommitFlow = async (): Promise<void> => {
    const verified = await useProjectsStore
      .getState()
      .refreshWorktreeDiffStatsVerified(projectId, worktreeId);
    // A newer attempt owns the worktree now.
    if (gitFailureAttempts.get(key) !== failureAttemptId) return;
    if (gitHubActionBusy(get, key)) return;
    if (!verified) {
      get().raiseGitActionFailure(
        projectId,
        worktreeId,
        { error: "Couldn't check this worktree for changes. Try again." },
        failureAttemptId,
      );
      return;
    }
    if (useProjectsStore.getState().uncommittedChanges[key] !== true) {
      settleNothingToCommit();
      return;
    }
    // The changes can still be gone by the time the flow reaches main: the
    // review finds nothing to generate, or main leaves a clean repository's
    // commits unpushed (`skipCleanPush`).
    let nothingToCommit = false;
    await runCommitFlow(set, get, {
      ...params,
      onNothingToCommit: (): void => {
        nothingToCommit = true;
      },
    });
    // A failure the run raised for another repository stays, with its retry.
    if (nothingToCommit && !get().gitActionFailures[key])
      settleNothingToCommit();
  };
  const failureAttemptId = clearGitActionFailure(set, key, () => {
    void retryCommitFlow();
  });
  const branches = gitHubRepositorySnapshot(projectId, worktreeId);
  const telemetryRepoCount =
    continuation?.telemetryRepoCount ??
    Math.max(
      1,
      new Set(
        branches
          ?.filter((repo) => !repoIds?.length || repoIds.includes(repo.repoId))
          .map((repo) => repo.repoId),
      ).size,
    );
  set((state) => {
    const nextCancellationRequested = new Set(
      state.gitActionCancellationRequested,
    );
    nextCancellationRequested.delete(key);
    return {
      committingAndPushing: new Set([
        ...Array.from(state.committingAndPushing),
        key,
      ]),
      activeBranchSyncAction: {
        ...state.activeBranchSyncAction,
        [key]: branchSyncAction,
      },
      commitPushProgress: {
        ...state.commitPushProgress,
        [key]: {
          steps: [],
          currentPhase: pullFirst ? 'pulling' : 'generating_message',
        },
      },
      gitActionOperationIds: {
        ...state.gitActionOperationIds,
        [key]: operationId,
      },
      gitActionCancellationRequested: nextCancellationRequested,
    };
  });

  // A commit that landed but whose push failed on GitHub authentication
  // continues by pushing those commits, never by committing again.
  const withGitHubConnectOffer = (
    response: CommitAndPushResponse,
  ): CommitAndPushResponse =>
    isCommitOnly
      ? response
      : {
          ...response,
          failedRepos: takeGitHubAuthFailures(response.failedRepos, {
            kind: 'push',
            source,
            telemetryRepoCount,
            projectId,
            worktreeId,
            establishUpstream: true,
            pullFirst,
            continuation,
            branches,
            operationId,
          }),
        };

  const skipCleanPushField =
    params.onNothingToCommit && !isCommitOnly ? { skipCleanPush: true } : {};
  // A clean repository main left unpushed for this Try again is not a skip
  // to report: the retry says the commits still need a push instead.
  const settleCleanSkips = (
    response: CommitAndPushResponse,
  ): CommitAndPushResponse => {
    const reported = response.skippedRepos.filter(
      (repo) => repo.reason !== 'commits_not_pushed',
    );
    if (reported.length === response.skippedRepos.length) return response;
    params.onNothingToCommit?.();
    return { ...response, skippedRepos: reported };
  };

  try {
    const api: CanopyApi = window.api;
    const prefs: PreferencesData = await api.loadPreferences();
    if (isGitActionCancellationRequested(get, key, operationId)) return false;
    const commitMeta: ToastMeta = {
      category: 'Git Commit',
      workspaceName: lookupWorkspaceName(projectId),
      projectId,
      worktreeId,
    };

    if (prefs.reviewCommitMessage || continuation) {
      const generated: GenerateCommitMessagesResponse = await runGitActionIpc(
        set,
        key,
        operationId,
        () =>
          api.github.generateCommitMessages({
            projectId,
            worktreeId,
            repoIds,
            operationId,
            ...(isCommitOnly ? { commitOnly: true } : {}),
          }),
      );

      if (
        generated.cancelled ||
        isGitActionCancellationRequested(get, key, operationId)
      ) {
        return false;
      }

      if (generated.skippedRepos.length > 0) {
        get().addToast(
          buildSkippedReposMessage(
            failureLabel,
            generated.skippedRepos,
            describeCommitAndPushSkipReason,
          ),
          'info',
          undefined,
          commitMeta,
        );
      }

      if (generated.failedRepos.length > 0) {
        get().raiseGitActionFailure(
          projectId,
          worktreeId,
          {
            ...buildFailedReposFailure(
              'Commit message generation',
              generated.failedRepos,
            ),
          },
          failureAttemptId,
        );
      }

      if (generated.repos.length === 0) {
        // Clean, not failed: a failed generation is not "nothing to commit".
        if (generated.failedRepos.length === 0) params.onNothingToCommit?.();
        return false;
      }

      const reviewResult = await new Promise<{
        approved: boolean;
        messages?: CommitReviewMessage[];
      }>((resolve) => {
        set((state) => ({
          commitReviewPending: {
            ...state.commitReviewPending,
            [key]: { repos: generated.repos, resolve, actionLabel },
          },
        }));
      });

      // Clean up review state
      set((state) => {
        const next = { ...state.commitReviewPending };
        delete next[key];
        return { commitReviewPending: next };
      });

      if (!reviewResult.approved) {
        return false;
      }
      if (isGitActionCancellationRequested(get, key, operationId)) return false;

      if (continuation && gitHubContinuationTargetChanged(continuation)) {
        get().addToast(
          'The branch changed. Start a new push.',
          'info',
          undefined,
          commitMeta,
        );
        return false;
      }

      // The reviewed messages are passed to the backend, which skips
      // generating_message, so the commit starts at staging (or pulling when
      // pullFirst).
      set((state) => ({
        commitPushProgress: {
          ...state.commitPushProgress,
          [key]: {
            steps: [],
            currentPhase: pullFirst ? 'pulling' : 'staging',
          },
        },
      }));

      const response: CommitAndPushResponse = settleCleanSkips(
        await runGitActionIpc(set, key, operationId, () =>
          api.github.commitAndPush({
            projectId,
            worktreeId,
            messages: reviewResult.messages,
            requireReviewedMessages: true,
            operationId,
            ...sourceField,
            ...(isCommitOnly ? { commitOnly: true, repoIds } : { pullFirst }),
            ...skipCleanPushField,
            ...(continuation
              ? {
                  repoIds,
                  expectedHeadBranch:
                    continuation.expectedHeadBranch ?? undefined,
                }
              : {}),
          }),
        ),
      );
      if (
        !response.cancelled &&
        !isGitActionCancellationRequested(get, key, operationId)
      ) {
        handleCommitAndPushResponse(
          get,
          projectId,
          worktreeId,
          withGitHubConnectOffer(response),
          failureLabel,
          commitMeta,
          failureAttemptId,
        );
      }
      if (
        response.cancelled ||
        isGitActionCancellationRequested(get, key, operationId)
      ) {
        await refreshGitActionState(set, get, key, projectId, worktreeId, api);
        return false;
      }
    } else {
      const response: CommitAndPushResponse = settleCleanSkips(
        await runGitActionIpc(set, key, operationId, () =>
          api.github.commitAndPush({
            projectId,
            worktreeId,
            operationId,
            ...sourceField,
            ...(isCommitOnly ? { commitOnly: true, repoIds } : { pullFirst }),
            ...skipCleanPushField,
          }),
        ),
      );
      if (
        !response.cancelled &&
        !isGitActionCancellationRequested(get, key, operationId)
      ) {
        handleCommitAndPushResponse(
          get,
          projectId,
          worktreeId,
          withGitHubConnectOffer(response),
          failureLabel,
          commitMeta,
          failureAttemptId,
        );
      }
      if (
        response.cancelled ||
        isGitActionCancellationRequested(get, key, operationId)
      ) {
        await refreshGitActionState(set, get, key, projectId, worktreeId, api);
        return false;
      }
    }

    markGitStatsRefreshing(set, key);
    await refreshGitHubWorktreeState(
      projectId,
      worktreeId,
      api,
      get().requestFastRefresh,
    );
    return !isGitActionCancellationRequested(get, key, operationId);
  } catch (error: unknown) {
    const appError = toAppError(resolveClientAppError(error));
    if (appError) {
      get().raiseGitActionFailure(
        projectId,
        worktreeId,
        inlineFailure(
          appError,
          isCommitOnly
            ? "Couldn't commit your changes."
            : "Couldn't commit and push your changes.",
        ),
        failureAttemptId,
      );
    }
    return false;
  } finally {
    set((state) => {
      const next = new Set(state.committingAndPushing);
      next.delete(key);
      const nextActiveAction = { ...state.activeBranchSyncAction };
      delete nextActiveAction[key];
      // Clean up any lingering review state
      const nextReview = { ...state.commitReviewPending };
      delete nextReview[key];
      const nextRefreshing = new Set(state.gitStatsRefreshing);
      nextRefreshing.delete(key);
      const nextOperationIds = { ...state.gitActionOperationIds };
      const nextCancellationRequested = new Set(
        state.gitActionCancellationRequested,
      );
      if (nextOperationIds[key] === operationId) {
        delete nextOperationIds[key];
        nextCancellationRequested.delete(key);
      }
      return {
        committingAndPushing: next,
        activeBranchSyncAction: nextActiveAction,
        commitReviewPending: nextReview,
        gitStatsRefreshing: nextRefreshing,
        gitActionOperationIds: nextOperationIds,
        gitActionCancellationRequested: nextCancellationRequested,
      };
    });
  }
}

async function runCreatePr(
  set: GitHubStoreSet,
  get: GitHubStoreGet,
  params: {
    projectId: string;
    worktreeId: string;
    repoIds?: string[];
    source?: GitShippingSource;
    continuation?: GitHubActionContinuation;
  },
): Promise<boolean> {
  const { projectId, worktreeId, repoIds, continuation } = params;
  const source = params.source ?? continuation?.source;
  const sourceField = {
    ...(source ? { source } : {}),
    ...(continuation?.telemetryRepoCount
      ? { telemetryRepoCount: continuation.telemetryRepoCount }
      : {}),
  };
  const key = worktreeKey(projectId, worktreeId);
  if (gitHubActionBusy(get, key)) return false;
  if (
    !continuation &&
    rejectWhileGitHubConnectPending(get, projectId, worktreeId)
  ) {
    return false;
  }
  const operationId = createGitActionOperationId();
  const failureAttemptId = clearGitActionFailure(set, key, () => {
    void runCreatePr(set, get, params);
  });
  const branches = gitHubRepositorySnapshot(projectId, worktreeId);
  const telemetryRepoCount =
    continuation?.telemetryRepoCount ??
    Math.max(
      1,
      new Set(
        branches
          ?.filter((repo) => !repoIds?.length || repoIds.includes(repo.repoId))
          .map((repo) => repo.repoId),
      ).size,
    );
  if (!continuation) {
    startingGitHubActions.add(key);
    try {
      const selected =
        branches?.filter(
          (repo) => !repoIds?.length || repoIds.includes(repo.repoId),
        ) ?? [];
      if (
        (await selectedRepositoriesNeedGitHub(
          projectId,
          worktreeId,
          selected.map((repo) => repo.repoId),
        )) &&
        (await probeGitHubConnected()) === 'disconnected'
      ) {
        const offered = offerGitHubConnect({
          kind: 'pr',
          source,
          telemetryRepoCount,
          projectId,
          worktreeId,
          operationId,
          branches,
          failed: selected.map((repo) => ({
            ...repo,
            error: '',
            status: 'failed',
          })),
          skipCommit: false,
        });
        if (!offered)
          rejectWhileGitHubConnectPending(get, projectId, worktreeId);
        return false;
      }
    } finally {
      startingGitHubActions.delete(key);
    }
  }
  set((state) => {
    const nextCancellationRequested = new Set(
      state.gitActionCancellationRequested,
    );
    nextCancellationRequested.delete(key);
    return {
      creatingPr: new Set([...Array.from(state.creatingPr), key]),
      creationProgress: {
        ...state.creationProgress,
        [key]: { steps: [], currentPhase: 'gathering_changes' },
      },
      gitActionOperationIds: {
        ...state.gitActionOperationIds,
        [key]: operationId,
      },
      gitActionCancellationRequested: nextCancellationRequested,
    };
  });
  let reviewedCommitCompleted = false;
  let reviewedPushCompletedRepoIds: string[] = [];
  try {
    const api: CanopyApi = window.api;
    const prefs: PreferencesData = await api.loadPreferences();
    if (isGitActionCancellationRequested(get, key, operationId)) return false;
    const workspaceName = lookupWorkspaceName(projectId);
    const commitMeta: ToastMeta = {
      category: 'Git Commit',
      workspaceName,
      projectId,
      worktreeId,
    };

    // Preflight has not prepared commits yet; preserve the review preference.
    if (
      prefs.reviewCommitMessage &&
      (!continuation || continuation.skipCommit === false)
    ) {
      const generated: GenerateCommitMessagesResponse = await runGitActionIpc(
        set,
        key,
        operationId,
        () =>
          api.github.generateCommitMessages({
            projectId,
            worktreeId,
            repoIds,
            operationId,
          }),
      );

      if (
        generated.cancelled ||
        isGitActionCancellationRequested(get, key, operationId)
      ) {
        return false;
      }

      if (generated.skippedRepos.length > 0) {
        get().addToast(
          buildSkippedReposMessage(
            'Commit & push',
            generated.skippedRepos,
            describeCommitAndPushSkipReason,
          ),
          'info',
          undefined,
          commitMeta,
        );
      }

      if (generated.failedRepos.length > 0) {
        get().raiseGitActionFailure(
          projectId,
          worktreeId,
          {
            ...buildFailedReposFailure(
              'Commit message generation',
              generated.failedRepos,
            ),
          },
          failureAttemptId,
        );
      }

      if (generated.failedRepos.length > 0 && generated.repos.length === 0) {
        markPrCreationProgressError(
          set,
          key,
          'Commit message generation failed; PR creation was aborted.',
        );
        return false;
      }

      if (
        generated.repos.length === 0 &&
        hasReviewBlockingSkippedRepos(generated.skippedRepos)
      ) {
        const message =
          'Commit message review is required before PR creation, but no repositories were eligible for review.';
        markPrCreationProgressError(set, key, message);
        get().raiseGitActionFailure(
          projectId,
          worktreeId,
          {
            error: message,
          },
          failureAttemptId,
        );
        return false;
      }

      if (generated.repos.length > 0) {
        const reviewResult = await new Promise<{
          approved: boolean;
          messages?: CommitReviewMessage[];
        }>((resolve) => {
          set((state) => ({
            commitReviewPending: {
              ...state.commitReviewPending,
              [key]: {
                repos: generated.repos,
                resolve,
                actionLabel: 'Commit, push & create PR',
              },
            },
          }));
        });

        set((state) => {
          const next = { ...state.commitReviewPending };
          delete next[key];
          return { commitReviewPending: next };
        });

        if (!reviewResult.approved) {
          clearPrCreationProgress(set, key);
          return false;
        }
        if (isGitActionCancellationRequested(get, key, operationId))
          return false;
        if (continuation && gitHubContinuationTargetChanged(continuation)) {
          get().addToast(
            'The branch changed. Start a new pull request.',
            'info',
            undefined,
            commitMeta,
          );
          clearPrCreationProgress(set, key);
          return false;
        }

        set((state) => ({
          commitPushProgress: {
            ...state.commitPushProgress,
            [key]: { steps: [], currentPhase: 'staging' },
          },
        }));

        const commitResponse: CommitAndPushResponse = await runGitActionIpc(
          set,
          key,
          operationId,
          () =>
            api.github.commitAndPush({
              projectId,
              worktreeId,
              messages: reviewResult.messages,
              requireReviewedMessages: true,
              repoIds,
              operationId,
              ...sourceField,
              telemetryFlow: 'pull_request',
              ...(continuation
                ? {
                    expectedHeadBranch:
                      continuation.expectedHeadBranch ?? undefined,
                  }
                : {}),
            }),
        );
        if (
          commitResponse.cancelled ||
          isGitActionCancellationRequested(get, key, operationId)
        ) {
          await refreshGitActionState(
            set,
            get,
            key,
            projectId,
            worktreeId,
            api,
          );
          return false;
        }
        // Continue eligible authentication failures while preserving other
        // repository outcomes and already-completed push stages.
        const commitAuthFailures =
          commitResponse.failedRepos.filter(isGitHubAuthFailure);
        const pushedRepoIds = commitResponse.repos.flatMap((repo) =>
          repo.repoId && repo.operation !== 'commit' ? [repo.repoId] : [],
        );
        const offeredCommitAuth =
          !commitResponse.cancelled &&
          commitAuthFailures.length > 0 &&
          offerGitHubConnect({
            kind: 'pr',
            source,
            telemetryRepoCount,
            projectId,
            worktreeId,
            failed: commitAuthFailures,
            repoIds: Array.from(
              new Set([
                ...commitAuthFailures.flatMap((repo) =>
                  repo.repoId ? [repo.repoId] : [],
                ),
                ...pushedRepoIds,
              ]),
            ),
            pushCompletedRepoIds: pushedRepoIds,
            continuation,
            branches,
            operationId,
          });
        if (!commitResponse.cancelled) {
          handleCommitAndPushResponse(
            get,
            projectId,
            worktreeId,
            offeredCommitAuth
              ? {
                  ...commitResponse,
                  failedRepos: commitResponse.failedRepos.filter(
                    (repo) => !isGitHubAuthFailure(repo),
                  ),
                }
              : commitResponse,
            'Commit & push',
            commitMeta,
            failureAttemptId,
          );
        }
        if (
          commitResponse.cancelled ||
          isGitActionCancellationRequested(get, key, operationId)
        ) {
          await refreshGitActionState(
            set,
            get,
            key,
            projectId,
            worktreeId,
            api,
          );
          return false;
        }
        const refreshAfterPartialReviewedCommit = async (): Promise<void> => {
          if (commitResponse.repos.length === 0) return;
          markGitStatsRefreshing(set, key);
          await refreshGitHubWorktreeState(
            projectId,
            worktreeId,
            api,
            get().requestFastRefresh,
          );
        };

        if (offeredCommitAuth) {
          clearPrCreationProgress(set, key);
          await refreshAfterPartialReviewedCommit();
          return false;
        }

        if (
          commitResponse.failedRepos.length > 0 ||
          commitResponse.agentResolutionRepos.length > 0
        ) {
          markPrCreationProgressError(
            set,
            key,
            commitResponse.failedRepos.length > 0
              ? 'Commit & push failed; PR creation was aborted.'
              : 'Commit & push requires agent resolution; PR creation was aborted.',
          );
          await refreshAfterPartialReviewedCommit();
          return false;
        }

        if (hasReviewBlockingSkippedRepos(commitResponse.skippedRepos)) {
          markPrCreationProgressError(
            set,
            key,
            'Commit & push skipped repositories that require reviewed PR creation; PR creation was aborted.',
          );
          await refreshAfterPartialReviewedCommit();
          return false;
        }
        reviewedCommitCompleted = true;
        reviewedPushCompletedRepoIds = pushedRepoIds;
      }
    }

    const response: CreatePrResponse = await runGitActionIpc(
      set,
      key,
      operationId,
      () =>
        api.github.createPr({
          projectId,
          worktreeId,
          repoIds,
          operationId,
          ...sourceField,
          ...(continuation
            ? {
                skipCommit:
                  reviewedCommitCompleted || (continuation.skipCommit ?? true),
                ...(reviewedCommitCompleted ||
                continuation.pushCompletedRepoIds?.includes(repoIds?.[0] ?? '')
                  ? { skipPush: true }
                  : {}),
                expectedHeadBranch:
                  continuation.expectedHeadBranch ?? undefined,
              }
            : {}),
        }),
    );
    if (
      response.cancelled ||
      isGitActionCancellationRequested(get, key, operationId)
    ) {
      await refreshGitActionState(set, get, key, projectId, worktreeId, api);
      return false;
    }

    const prAuthFailures = (response.failedRepos ?? []).filter(
      isGitHubAuthFailure,
    );
    // Main reports stages from its PR attempt; retain work completed by the
    // earlier reviewed commit/push for these specific repositories.
    const authFailuresWithCompletedStages = prAuthFailures.map(
      (repo): RepoFailureResult =>
        repo.repoId && reviewedPushCompletedRepoIds.includes(repo.repoId)
          ? { ...repo, commitPrepared: true, pushCompleted: true }
          : repo,
    );
    const authFailuresOffered = offerGitHubConnect({
      kind: 'pr',
      source,
      telemetryRepoCount,
      projectId,
      worktreeId,
      failed: authFailuresWithCompletedStages,
      continuation,
      branches,
      operationId,
    });
    if (authFailuresOffered) {
      if (response.repos.length === 0) clearPrCreationProgress(set, key);
    }

    // Some PRs were created: running the whole request again would replay
    // them and fail on the PRs that now exist, so no failure of this attempt
    // offers a retry, including an earlier partial one (a commit message that
    // couldn't be generated). The bar's Create PR covers the rest.
    if (response.repos.length > 0)
      dropGitActionRetry(set, key, failureAttemptId);

    const remainingFailures = (response.failedRepos ?? []).filter(
      (repo) => !authFailuresOffered || !isGitHubAuthFailure(repo),
    );
    if (remainingFailures.length) {
      const message = buildFailedReposMessage('PR creation', remainingFailures);
      if (response.repos.length === 0)
        markPrCreationProgressError(set, key, message);
      get().raiseGitActionFailure(
        projectId,
        worktreeId,
        {
          ...buildFailedReposFailure('PR creation', remainingFailures),
        },
        failureAttemptId,
      );
    }

    // Info toast for local-only repos that were committed (no remote push).
    if (response.localOnlyCommittedRepos.length > 0) {
      const repoNames = response.localOnlyCommittedRepos
        .map((repo) => repo.repoName)
        .join(', ');
      get().addToast(
        `Committed local-only changes in ${repoNames}.`,
        'info',
        undefined,
        {
          category: 'Git Commit',
          workspaceName,
          projectId,
          worktreeId,
        },
      );
    }

    // Info toast for local-only repos skipped due to missing origin remote.
    const noOriginSkipped = response.skippedRepos.filter(
      (entry) => entry.reason === 'no_remote_origin',
    );
    if (noOriginSkipped.length > 0) {
      const repoNames = noOriginSkipped.map((repo) => repo.repoName).join(', ');
      get().addToast(
        `Skipped PR creation for local-only repos: ${repoNames} (no origin remote).`,
        'info',
        undefined,
        {
          category: 'PR Create',
          workspaceName,
          projectId,
          worktreeId,
        },
      );
    }

    markGitStatsRefreshing(set, key);
    await refreshGitHubWorktreeState(
      projectId,
      worktreeId,
      api,
      get().requestFastRefresh,
    );
    return !isGitActionCancellationRequested(get, key, operationId);
  } catch (error: unknown) {
    const appError = toAppError(resolveClientAppError(error));
    const current = gitFailureAttempts.get(key) === failureAttemptId;
    // A cancellation ends the progress as the other cancelled paths do.
    if (!appError) {
      if (current) clearPrCreationProgress(set, key);
      return false;
    }
    const message =
      error instanceof Error ? error.message : 'Failed to create PR';
    if (current) markPrCreationProgressError(set, key, message);
    get().raiseGitActionFailure(
      projectId,
      worktreeId,
      inlineFailure(appError, "Couldn't create the pull request."),
      failureAttemptId,
    );
    return false;
  } finally {
    set((state) => {
      const next = new Set(state.creatingPr);
      next.delete(key);
      const nextRefreshing = new Set(state.gitStatsRefreshing);
      nextRefreshing.delete(key);
      const nextOperationIds = { ...state.gitActionOperationIds };
      const nextCancellationRequested = new Set(
        state.gitActionCancellationRequested,
      );
      const wasCancelled = nextCancellationRequested.has(key);
      const nextCreationProgress = { ...state.creationProgress };
      if (wasCancelled) {
        delete nextCreationProgress[key];
      }
      if (nextOperationIds[key] === operationId) {
        delete nextOperationIds[key];
        nextCancellationRequested.delete(key);
      }
      return {
        creatingPr: next,
        gitStatsRefreshing: nextRefreshing,
        creationProgress: nextCreationProgress,
        gitActionOperationIds: nextOperationIds,
        gitActionCancellationRequested: nextCancellationRequested,
      };
    });
  }
}

async function runPushOnly(
  set: GitHubStoreSet,
  get: GitHubStoreGet,
  params: {
    projectId: string;
    worktreeId: string;
    continuation?: GitHubActionContinuation;
  },
): Promise<boolean> {
  const { projectId, worktreeId, continuation } = params;
  const key = worktreeKey(projectId, worktreeId);
  if (gitHubActionBusy(get, key)) return false;
  if (
    !continuation &&
    rejectWhileGitHubConnectPending(get, projectId, worktreeId)
  ) {
    return false;
  }
  const operationId = createGitActionOperationId();
  const failureAttemptId = clearGitActionFailure(set, key, () => {
    void runPushOnly(set, get, params);
  });
  const branches = gitHubRepositorySnapshot(projectId, worktreeId);
  set((state) => {
    const nextCancellationRequested = new Set(
      state.gitActionCancellationRequested,
    );
    nextCancellationRequested.delete(key);
    return {
      committingAndPushing: new Set([
        ...Array.from(state.committingAndPushing),
        key,
      ]),
      activeBranchSyncAction: {
        ...state.activeBranchSyncAction,
        [key]: 'push',
      },
      commitPushProgress: {
        ...state.commitPushProgress,
        [key]: { steps: [], currentPhase: 'pushing' },
      },
      gitActionOperationIds: {
        ...state.gitActionOperationIds,
        [key]: operationId,
      },
      gitActionCancellationRequested: nextCancellationRequested,
    };
  });

  try {
    const api: CanopyApi = window.api;
    const response: PushOnlyResponse = await runGitActionIpc(
      set,
      key,
      operationId,
      () =>
        api.github.pushOnly({
          projectId,
          worktreeId,
          operationId,
          ...(continuation
            ? {
                repoIds: continuation.repoIds,
                expectedHeadBranch:
                  continuation.expectedHeadBranch ?? undefined,
                ...(continuation.establishUpstream
                  ? { establishUpstream: true }
                  : {}),
                ...(continuation.pullFirst ? { pullFirst: true } : {}),
              }
            : {}),
        }),
    );
    if (
      response.cancelled ||
      isGitActionCancellationRequested(get, key, operationId)
    ) {
      await refreshGitActionState(set, get, key, projectId, worktreeId, api);
      return false;
    }

    const pushMeta: ToastMeta = {
      category: 'Git Push',
      workspaceName: lookupWorkspaceName(projectId),
      projectId,
      worktreeId,
    };
    const failedRepos = takeGitHubAuthFailures(response.failedRepos, {
      kind: 'push',
      projectId,
      worktreeId,
      continuation,
      branches,
      operationId,
    });
    if (failedRepos.length > 0) {
      get().raiseGitActionFailure(
        projectId,
        worktreeId,
        {
          ...buildFailedReposFailure('Push', failedRepos),
        },
        failureAttemptId,
      );
    }
    if (response.skippedRepos.length > 0) {
      get().addToast(
        buildSkippedReposMessage(
          'Push',
          response.skippedRepos,
          describePushOnlySkipReason,
        ),
        'info',
        undefined,
        pushMeta,
      );
    }

    markGitStatsRefreshing(set, key);
    await refreshGitHubWorktreeState(
      projectId,
      worktreeId,
      api,
      get().requestFastRefresh,
    );
    return !isGitActionCancellationRequested(get, key, operationId);
  } catch (error: unknown) {
    const appError = toAppError(resolveClientAppError(error));
    if (appError) {
      get().raiseGitActionFailure(
        projectId,
        worktreeId,
        inlineFailure(appError, "Couldn't push this branch."),
        failureAttemptId,
      );
    }
    return false;
  } finally {
    set((state) => {
      const next = new Set(state.committingAndPushing);
      next.delete(key);
      const nextActiveAction = { ...state.activeBranchSyncAction };
      delete nextActiveAction[key];
      const nextRefreshing = new Set(state.gitStatsRefreshing);
      nextRefreshing.delete(key);
      const nextOperationIds = { ...state.gitActionOperationIds };
      const nextCancellationRequested = new Set(
        state.gitActionCancellationRequested,
      );
      if (nextOperationIds[key] === operationId) {
        delete nextOperationIds[key];
        nextCancellationRequested.delete(key);
      }
      return {
        committingAndPushing: next,
        activeBranchSyncAction: nextActiveAction,
        gitStatsRefreshing: nextRefreshing,
        gitActionOperationIds: nextOperationIds,
        gitActionCancellationRequested: nextCancellationRequested,
      };
    });
  }
}

export const useGitHubStore = create<GitHubState>((set, get) => ({
  prStatuses: {},
  livePrStatusWorktreeKeys: new Set<string>(),
  creatingPr: new Set<string>(),
  creationProgress: {},
  committingAndPushing: new Set<string>(),
  mergingLocalBranches: new Set<string>(),
  mergingPr: new Set<string>(),
  mergePrProgress: {},
  gitStatsRefreshing: new Set<string>(),
  gitActionOperationIds: {},
  gitActionIpcPending: new Set<string>(),
  gitActionCancellationRequested: new Set<string>(),
  activeBranchSyncAction: {},
  commitPushProgress: {},
  commitReviewPending: {},
  prMergeWarnings: {},
  planningSplitPr: new Set<string>(),
  splittingPr: new Set<string>(),
  splitPrPlans: {},
  splitPrProgress: {},
  splitPrResults: {},
  splitPrRefusals: {},
  splitPrExecuteFailures: {},
  splitPrDiscardedArtifacts: {},
  gitActionFailures: {},
  splitLockedWorktrees: new Set<string>(),
  splitWorkflowSessions: new Set<string>(),

  openPrMergeWarning: (warning: PrMergeWarningState): void => {
    const key = worktreeKey(warning.projectId, warning.worktreeId);
    set((state) => ({
      prMergeWarnings: {
        ...state.prMergeWarnings,
        [key]: warning,
      },
    }));
  },

  clearPrMergeWarning: (projectId: string, worktreeId: string): void => {
    const key = worktreeKey(projectId, worktreeId);
    set((state) => {
      if (state.prMergeWarnings[key] === undefined) return {};
      const next = { ...state.prMergeWarnings };
      delete next[key];
      return { prMergeWarnings: next };
    });
  },

  openSplitWorkflowSession: (projectId: string, worktreeId: string): void => {
    const key = worktreeKey(projectId, worktreeId);
    set((state) => {
      if (state.splitWorkflowSessions.has(key)) return {};
      return {
        splitWorkflowSessions: new Set([
          ...Array.from(state.splitWorkflowSessions),
          key,
        ]),
      };
    });
  },

  closeSplitWorkflowSession: (projectId: string, worktreeId: string): void => {
    const key = worktreeKey(projectId, worktreeId);
    set((state) => {
      if (!state.splitWorkflowSessions.has(key)) return {};
      const next = new Set(state.splitWorkflowSessions);
      next.delete(key);
      return { splitWorkflowSessions: next };
    });
  },

  createPr: async (
    projectId: string,
    worktreeId: string,
    repoIds?: string[],
    options?: { source?: GitShippingSource },
  ): Promise<void> => {
    await runCreatePr(set, get, {
      projectId,
      worktreeId,
      repoIds,
      source: options?.source,
    });
  },

  planSplitPr: async (
    projectId: string,
    worktreeId: string,
  ): Promise<SplitPrPlanResult | null> => {
    const key = worktreeKey(projectId, worktreeId);
    const failureAttemptId = clearGitActionFailure(set, key);
    set((state) => {
      const nextRefusals = { ...state.splitPrRefusals };
      delete nextRefusals[key];
      const nextResults = { ...state.splitPrResults };
      delete nextResults[key];
      const nextProgress = { ...state.splitPrProgress };
      delete nextProgress[key];
      return {
        planningSplitPr: new Set([...Array.from(state.planningSplitPr), key]),
        splitPrRefusals: nextRefusals,
        splitPrResults: nextResults,
        splitPrProgress: nextProgress,
      };
    });
    try {
      const api: CanopyApi = window.api;
      const result: SplitPrPlanResult = await api.github.planSplitPr({
        projectId,
        worktreeId,
      });
      if (result.status === 'ok') {
        if (
          get().splitLockedWorktrees.has(key) &&
          get().splitWorkflowSessions.has(key)
        ) {
          set((state) => ({
            splitPrPlans: {
              ...state.splitPrPlans,
              [key]: result.response,
            },
          }));
        }
      } else {
        set((state) => ({
          splitPrRefusals: {
            ...state.splitPrRefusals,
            [key]: {
              code: result.code,
              message: result.message,
              ...(result.issues !== undefined ? { issues: result.issues } : {}),
            },
          },
        }));
      }
      return result;
    } catch (error: unknown) {
      const appError = toAppError(resolveClientAppError(error));
      if (appError) {
        get().raiseGitActionFailure(
          projectId,
          worktreeId,
          inlineFailure(appError, "Couldn't plan the split."),
          failureAttemptId,
        );
      }
      return null;
    } finally {
      set((state) => {
        const next = new Set(state.planningSplitPr);
        next.delete(key);
        return { planningSplitPr: next };
      });
    }
  },

  startSplitWorkflow: async (
    projectId: string,
    worktreeId: string,
    options?: {
      mode?: SplitWorkflowStartMode;
      plan?: SplitPlan;
      snapshot?: PrDiffSnapshot;
    },
  ): Promise<boolean> => {
    const key = worktreeKey(projectId, worktreeId);
    const mode: SplitWorkflowStartMode = options?.mode ?? 'plan';

    // Double-dispatch guard: a resume (or any start) while an execute is
    // already in flight for this key is a no-op. Both retry surfaces (the
    // progress-overlay Retry and the result-view Resume) call this, and a
    // rapid double-click could otherwise fire two resumes — the second would
    // re-run the per-key clearing and race the main-side abort registry.
    // Bail early (typed no-op) so only the first dispatch proceeds; the
    // main-side acquire-race guard remains the authoritative backstop.
    if (get().splittingPr.has(key)) {
      return false;
    }
    const failureAttemptId = clearGitActionFailure(set, key);

    // Open the renderer-side presentation session immediately (before the async
    // main-process call). It outlives the lock so the SplitWorkflowView stays
    // mounted across a COMPLETED settle to render the Finalize finished page.
    // Failure/cancel/exit settles close it explicitly (see below).
    get().openSplitWorkflowSession(projectId, worktreeId);

    // Mode-aware per-key clearing:
    //  - `'plan'`: clear ALL stale per-key state (refusals, results, progress,
    //    plans, execute-failures) so every fresh-launch surface — menu item,
    //    status-bar button, panel button, post-failure button — gets a clean
    //    slate. Sets `planningSplitPr` so the view shows the Plan step.
    //  - `'review'`: KEEP `splitPrPlans[key]` (it IS the plan the Review step
    //    renders) — only clear the failure/refusal/progress noise so the view
    //    lands cleanly on Review. Does NOT set `planningSplitPr` (there is no
    //    LLM re-plan).
    //  - `'resume'`: clear the execute-failure + progress so the Execute step
    //    starts fresh; KEEP the plan (the run resumes from it). Does NOT set
    //    `planningSplitPr`.
    //
    // `splitPrResults[key]` is ONLY cleared for `'plan'`. For `'review'` and
    // `'resume'` it is KEPT: a failed/executing map cannot satisfy the
    // `status === 'completed'` finalize gate, so keeping it does not mis-render
    // the workflow view, while dropping it would strand the user with no
    // result view / Resume / Discard if they Cancel back out (review) — and
    // resume's own settle overwrites it truthfully anyway.
    set((state) => {
      const nextRefusals = { ...state.splitPrRefusals };
      delete nextRefusals[key];
      const nextResults = { ...state.splitPrResults };
      if (mode === 'plan') {
        delete nextResults[key];
      }
      const nextProgress = { ...state.splitPrProgress };
      delete nextProgress[key];
      const nextFailures = { ...state.splitPrExecuteFailures };
      delete nextFailures[key];
      const nextPlans = { ...state.splitPrPlans };
      if (mode === 'plan') {
        delete nextPlans[key];
      }
      const nextPlanning = new Set(state.planningSplitPr);
      if (mode === 'plan') {
        nextPlanning.add(key);
      }
      const nextSplitting = new Set(state.splittingPr);
      if (mode === 'resume') {
        nextSplitting.add(key);
      }
      return {
        planningSplitPr: nextPlanning,
        splittingPr: nextSplitting,
        splitPrRefusals: nextRefusals,
        splitPrResults: nextResults,
        splitPrProgress:
          mode === 'plan' ? nextProgress : { ...nextProgress, [key]: [] },
        splitPrPlans: nextPlans,
        splitPrExecuteFailures: nextFailures,
      };
    });
    try {
      const api: CanopyApi = window.api;
      const startResult = await api.github.startSplitWorkflow({
        projectId,
        worktreeId,
        mode,
        ...(options?.plan !== undefined ? { plan: options.plan } : {}),
        ...(options?.snapshot !== undefined
          ? { snapshot: options.snapshot }
          : {}),
      });
      if (startResult.mode === 'resume') {
        const response = startResult.result;
        if (response.status === 'failed') {
          // End the presentation session BEFORE recording the failure so the
          // SplitWorkflowView unmounts (swap-back to normal UX) and the failure
          // modal — which is gated on the worktree NOT being locked/in-session —
          // becomes the single surface. Closing after would race the modal gate
          // and could momentarily double-stack the modal under the workflow.
          get().closeSplitWorkflowSession(projectId, worktreeId);
          set((state) => ({
            splitPrExecuteFailures: {
              ...state.splitPrExecuteFailures,
              [key]: {
                message: response.message,
                ...(response.code !== undefined ? { code: response.code } : {}),
                ...(response.childIndex !== undefined
                  ? { childIndex: response.childIndex }
                  : {}),
                ...(response.verifyTail !== undefined
                  ? { verifyTail: response.verifyTail }
                  : {}),
              },
            },
          }));
          if (response.code !== 'plan_mismatch') {
            void get().loadSplitPrMap(projectId, worktreeId);
          }
          get().raiseGitActionFailure(
            projectId,
            worktreeId,
            {
              error: response.message,
            },
            failureAttemptId,
          );
          return true;
        }
        set((state) => {
          const nextPlans = { ...state.splitPrPlans };
          if (response.map.status === 'completed') {
            delete nextPlans[key];
          }
          return {
            splitPrResults: {
              ...state.splitPrResults,
              [key]: response.map,
            },
            splitPrPlans: nextPlans,
          };
        });
        if (response.map.status === 'completed') {
          maybeFireSplitIdleToast(get, projectId, worktreeId, 'done');
        }
        return true;
      }
      if (startResult.mode === 'review') {
        // The lock is held and the renderer keeps its stored plan; the view
        // lands on Review. Nothing else to store.
        return true;
      }
      const result: SplitPrPlanResult = startResult.result;
      if (result.status === 'ok') {
        // Only store the plan if the lock is still held for this worktree.
        // A plan-mode `exitSplitWorkflow` (Cancel) releases the lock
        // immediately, before `planPrSplit` necessarily settles. If the user
        // cancelled and the plan resolved ok afterward, storing it here would
        // populate `splitPrPlans[key]` on an unlocked worktree, which hides
        // the PR panel's Split PR button (`showSplitButton` requires no
        // stored plan) while leaving the rest of the UI acting as if nothing
        // is in progress. Drop the late-arriving plan instead.
        if (get().splitLockedWorktrees.has(key)) {
          set((state) => ({
            splitPrPlans: {
              ...state.splitPrPlans,
              [key]: result.response,
            },
          }));
          maybeFireSplitIdleToast(get, projectId, worktreeId, 'review');
        }
        return true;
      }
      set((state) => ({
        splitPrRefusals: {
          ...state.splitPrRefusals,
          [key]: {
            code: result.code,
            message: result.message,
            ...(result.issues !== undefined ? { issues: result.issues } : {}),
          },
        },
      }));
      return false;
    } catch (error: unknown) {
      // A start error released the main-side lock; close the presentation
      // session too so the view swaps back rather than stranding the user on a
      // dead workflow panel.
      get().closeSplitWorkflowSession(projectId, worktreeId);
      const appError = toAppError(resolveClientAppError(error));
      if (appError) {
        get().raiseGitActionFailure(
          projectId,
          worktreeId,
          inlineFailure(appError, "Couldn't start the split."),
          failureAttemptId,
        );
      }
      return false;
    } finally {
      set((state) => {
        const nextPlanning = new Set(state.planningSplitPr);
        nextPlanning.delete(key);
        const nextSplitting = new Set(state.splittingPr);
        if (mode === 'resume') {
          nextSplitting.delete(key);
        }
        return { planningSplitPr: nextPlanning, splittingPr: nextSplitting };
      });
    }
  },

  approveSplitWorkflow: async (
    projectId: string,
    worktreeId: string,
    plan: SplitPlan,
    snapshot: PrDiffSnapshot,
  ): Promise<void> => {
    const key = worktreeKey(projectId, worktreeId);
    const failureAttemptId = clearGitActionFailure(set, key);
    set((state) => {
      const nextFailures = { ...state.splitPrExecuteFailures };
      delete nextFailures[key];
      return {
        splittingPr: new Set([...Array.from(state.splittingPr), key]),
        splitPrProgress: {
          ...state.splitPrProgress,
          [key]: [],
        },
        splitPrExecuteFailures: nextFailures,
      };
    });
    try {
      const api: CanopyApi = window.api;
      const response = await api.github.approveSplitWorkflow({
        projectId,
        worktreeId,
        plan,
        snapshot,
      });
      if (response.status === 'failed') {
        // End the presentation session BEFORE recording the failure so the
        // SplitWorkflowView unmounts and the failure modal (gated on the
        // worktree NOT being locked/in-session) is the single surface — never
        // stacked under a still-open workflow view.
        get().closeSplitWorkflowSession(projectId, worktreeId);
        set((state) => ({
          splitPrExecuteFailures: {
            ...state.splitPrExecuteFailures,
            [key]: {
              message: response.message,
              ...(response.code !== undefined ? { code: response.code } : {}),
              ...(response.childIndex !== undefined
                ? { childIndex: response.childIndex }
                : {}),
              ...(response.verifyTail !== undefined
                ? { verifyTail: response.verifyTail }
                : {}),
            },
          },
        }));
        if (response.code !== 'plan_mismatch') {
          void get().loadSplitPrMap(projectId, worktreeId);
        }
        get().raiseGitActionFailure(
          projectId,
          worktreeId,
          {
            error: response.message,
          },
          failureAttemptId,
        );
        return;
      }
      // Completed settle: KEEP the presentation session open so the
      // SplitWorkflowView stays mounted (even as the lock releases) to render
      // the Finalize finished page. The Finalize "Done" button closes it.
      set((state) => {
        const nextPlans = { ...state.splitPrPlans };
        if (response.map.status === 'completed') {
          delete nextPlans[key];
        }
        return {
          splitPrResults: {
            ...state.splitPrResults,
            [key]: response.map,
          },
          splitPrPlans: nextPlans,
        };
      });
      if (response.map.status === 'completed') {
        maybeFireSplitIdleToast(get, projectId, worktreeId, 'done');
      }
    } catch (error: unknown) {
      // A thrown approve error released the lock; close the session so the view
      // swaps back to normal UX rather than stranding a dead workflow panel.
      get().closeSplitWorkflowSession(projectId, worktreeId);
      const appError = toAppError(resolveClientAppError(error));
      if (appError) {
        get().raiseGitActionFailure(
          projectId,
          worktreeId,
          inlineFailure(appError, "Couldn't split the pull request."),
          failureAttemptId,
        );
      }
    } finally {
      set((state) => {
        const next = new Set(state.splittingPr);
        next.delete(key);
        return { splittingPr: next };
      });
    }
  },

  exitSplitWorkflow: async (
    projectId: string,
    worktreeId: string,
  ): Promise<void> => {
    // Explicit user exit (Cancel paths / plan-refusal auto-exit): end the
    // presentation session up front so the view swaps back immediately, even if
    // the main-side lock release is slow or the lock was never held.
    get().closeSplitWorkflowSession(projectId, worktreeId);
    try {
      const api: CanopyApi = window.api;
      await api.github.exitSplitWorkflow({ projectId, worktreeId });
    } catch (error: unknown) {
      const appError = toAppError(resolveClientAppError(error));
      if (appError) {
        get().raiseGitActionFailure(
          projectId,
          worktreeId,
          inlineFailure(appError, "Couldn't leave the split."),
        );
      }
    }
    // Belt-and-suspenders map refresh. The main-side exit releases the lock,
    // whose RELEASE event already triggers a `loadSplitPrMap` in the store's
    // lock subscription. But if the lock was NOT actually held (exit is a
    // main-side no-op → no release event), that path never fires — so refresh
    // here too. This restores the persisted result view (Resume/Discard) after
    // a review-mode Cancel over a still-present failed map.
    void get().loadSplitPrMap(projectId, worktreeId);
  },

  cancelSplitPr: async (
    projectId: string,
    worktreeId: string,
  ): Promise<void> => {
    // Note: this does not synchronously clear `splittingPr` for the key —
    // the terminal `splitPrProgress` event (or `executeSplitPr`'s own
    // resolution) is what clears it once the backend actually stops.
    try {
      const api: CanopyApi = window.api;
      await api.github.cancelSplitPr({ projectId, worktreeId });
    } catch (error: unknown) {
      const appError = toAppError(resolveClientAppError(error));
      if (appError) {
        get().raiseGitActionFailure(
          projectId,
          worktreeId,
          inlineFailure(appError, "Couldn't cancel the split."),
        );
      }
    }
  },

  discardSplitPr: async (
    projectId: string,
    worktreeId: string,
  ): Promise<SplitPrDiscardResponse | null> => {
    const key = worktreeKey(projectId, worktreeId);
    try {
      const api: CanopyApi = window.api;
      const response = await api.github.discardSplitPr({
        projectId,
        worktreeId,
      });
      set((state) => {
        const nextResults = { ...state.splitPrResults };
        delete nextResults[key];
        const nextProgress = { ...state.splitPrProgress };
        delete nextProgress[key];
        const nextPlans = { ...state.splitPrPlans };
        delete nextPlans[key];
        const nextRefusals = { ...state.splitPrRefusals };
        delete nextRefusals[key];
        const nextFailures = { ...state.splitPrExecuteFailures };
        delete nextFailures[key];
        return {
          splitPrResults: nextResults,
          splitPrProgress: nextProgress,
          splitPrPlans: nextPlans,
          splitPrRefusals: nextRefusals,
          splitPrExecuteFailures: nextFailures,
          splitPrDiscardedArtifacts: {
            ...state.splitPrDiscardedArtifacts,
            [key]: response,
          },
        };
      });
      return response;
    } catch (error: unknown) {
      const appError = toAppError(resolveClientAppError(error));
      if (appError) {
        get().raiseGitActionFailure(
          projectId,
          worktreeId,
          inlineFailure(appError, "Couldn't discard the split."),
        );
      }
      return null;
    }
  },

  clearSplitPrDiscardedArtifacts: (
    projectId: string,
    worktreeId: string,
  ): void => {
    const key = worktreeKey(projectId, worktreeId);
    set((state) => {
      const next = { ...state.splitPrDiscardedArtifacts };
      delete next[key];
      return { splitPrDiscardedArtifacts: next };
    });
  },

  clearSplitPlan: (projectId: string, worktreeId: string): void => {
    const key = worktreeKey(projectId, worktreeId);
    set((state) => {
      const nextPlans = { ...state.splitPrPlans };
      delete nextPlans[key];
      const nextRefusals = { ...state.splitPrRefusals };
      delete nextRefusals[key];
      return { splitPrPlans: nextPlans, splitPrRefusals: nextRefusals };
    });
  },

  clearSplitExecuteFailure: (projectId: string, worktreeId: string): void => {
    const key = worktreeKey(projectId, worktreeId);
    set((state) => {
      const nextFailures = { ...state.splitPrExecuteFailures };
      delete nextFailures[key];
      return { splitPrExecuteFailures: nextFailures };
    });
  },

  commitApprovedSplitPlan: (
    projectId: string,
    worktreeId: string,
    edited: SplitPlan,
  ): void => {
    const key = worktreeKey(projectId, worktreeId);
    set((state) => {
      const existing = state.splitPrPlans[key];
      if (!existing) {
        return {};
      }
      return {
        splitPrPlans: {
          ...state.splitPrPlans,
          [key]: { ...existing, plan: edited },
        },
      };
    });
  },

  loadSplitPrMap: async (
    projectId: string,
    worktreeId: string,
  ): Promise<void> => {
    const key = worktreeKey(projectId, worktreeId);
    try {
      const api: CanopyApi = window.api;
      const map = await api.github.getSplitPrMap({ projectId, worktreeId });
      set((state) => {
        if (map === null) {
          const next = { ...state.splitPrResults };
          delete next[key];
          return { splitPrResults: next };
        }
        return {
          splitPrResults: {
            ...state.splitPrResults,
            [key]: map,
          },
        };
      });
    } catch (error: unknown) {
      // The UI falls back to "no split in progress"; record why.
      reportClientAppError(error);
    }
  },

  commitAndPush: async (
    projectId: string,
    worktreeId: string,
    options?: { pullFirst?: boolean; source?: GitShippingSource },
  ): Promise<void> => {
    const pullFirst = options?.pullFirst === true;
    await runCommitFlow(set, get, {
      projectId,
      worktreeId,
      mode: 'commit-and-push',
      pullFirst,
      source: options?.source,
    });
  },

  commitOnly: async (
    projectId: string,
    worktreeId: string,
    repoIds?: string[],
    options?: { source?: GitShippingSource },
  ): Promise<void> => {
    await runCommitFlow(set, get, {
      projectId,
      worktreeId,
      mode: 'commit',
      repoIds,
      source: options?.source,
    });
  },

  mergeLocalBranches: async (
    projectId: string,
    worktreeId: string,
    repoIds?: string[],
  ): Promise<void> => {
    const key = worktreeKey(projectId, worktreeId);
    const operationId = createGitActionOperationId();
    // No retry: a partly finished merge is not safe to run again blindly.
    const failureAttemptId = clearGitActionFailure(set, key);
    set((state) => {
      const nextCancellationRequested = new Set(
        state.gitActionCancellationRequested,
      );
      nextCancellationRequested.delete(key);
      return {
        mergingLocalBranches: new Set([
          ...Array.from(state.mergingLocalBranches),
          key,
        ]),
        gitActionOperationIds: {
          ...state.gitActionOperationIds,
          [key]: operationId,
        },
        gitActionCancellationRequested: nextCancellationRequested,
      };
    });
    const mergeMeta: ToastMeta = {
      category: 'Git Merge',
      workspaceName: lookupWorkspaceName(projectId),
      projectId,
      worktreeId,
    };
    try {
      const api: CanopyApi = window.api;
      const response: MergeLocalBranchesResponse = await runGitActionIpc(
        set,
        key,
        operationId,
        () =>
          api.github.mergeLocalBranches({
            projectId,
            worktreeId,
            repoIds,
            operationId,
          }),
      );

      if (response.cancelled) {
        await refreshGitActionState(set, get, key, projectId, worktreeId, api);
        return;
      }

      if (response.repos.length > 0) {
        get().addToast(
          `Merged ${response.repos.length} local-only ${response.repos.length === 1 ? 'repo' : 'repos'} into the default branch.`,
          'success',
          undefined,
          mergeMeta,
        );
      }

      if (response.failedRepos.length > 0) {
        get().raiseGitActionFailure(
          projectId,
          worktreeId,
          {
            error: "Couldn't merge all repositories.",
            details: response.failedRepos
              .map(
                (failed) =>
                  `Merge failed for ${failed.repoName}: ${failed.error}`,
              )
              .join(' '),
          },
          failureAttemptId,
        );
      }

      const actionableSkipped = response.skippedRepos.filter(
        (entry) => entry.reason !== 'has_remote_origin',
      );
      if (actionableSkipped.length > 0) {
        get().addToast(
          `Merge skipped ${actionableSkipped.length} ${actionableSkipped.length === 1 ? 'repo' : 'repos'}: ${formatRepoEntries(
            actionableSkipped,
            (repo) =>
              `${repo.repoName} (${describeMergeSkipReason(repo.reason)})`,
          )}`,
          'info',
          undefined,
          mergeMeta,
        );
      }

      if (response.repos.length > 0 || response.skippedRepos.length > 0) {
        markGitStatsRefreshing(set, key);
        await refreshGitHubWorktreeState(
          projectId,
          worktreeId,
          api,
          get().requestFastRefresh,
        );
      }
    } catch (error: unknown) {
      const appError = toAppError(resolveClientAppError(error));
      if (appError) {
        get().raiseGitActionFailure(
          projectId,
          worktreeId,
          inlineFailure(appError, "Couldn't merge the local branches."),
          failureAttemptId,
        );
      }
    } finally {
      set((state) => {
        const next = new Set(state.mergingLocalBranches);
        next.delete(key);
        const nextRefreshing = new Set(state.gitStatsRefreshing);
        nextRefreshing.delete(key);
        const nextOperationIds = { ...state.gitActionOperationIds };
        const nextCancellationRequested = new Set(
          state.gitActionCancellationRequested,
        );
        if (nextOperationIds[key] === operationId) {
          delete nextOperationIds[key];
          nextCancellationRequested.delete(key);
        }
        return {
          mergingLocalBranches: next,
          gitStatsRefreshing: nextRefreshing,
          gitActionOperationIds: nextOperationIds,
          gitActionCancellationRequested: nextCancellationRequested,
        };
      });
    }
  },

  mergePr: async (
    projectId: string,
    worktreeId: string,
    options?: {
      repoIds?: string[];
      confirmUnresolvedComments?: boolean;
      dryRun?: boolean;
      source?: GitShippingSource;
    },
  ): Promise<MergePrResponse | null> => {
    const key = worktreeKey(projectId, worktreeId);
    const dryRun = options?.dryRun === true;
    const operationId = createGitActionOperationId();
    const failureAttemptId = dryRun
      ? undefined
      : clearGitActionFailure(set, key);
    const mergeMeta: ToastMeta = {
      category: 'Git Merge',
      workspaceName: lookupWorkspaceName(projectId),
      projectId,
      worktreeId,
    };

    // Dry runs only re-verify GitHub state to drive the merge UI; they do not
    // flip the merge busy state, but still expose an operation id so checking
    // can be cancelled from the action button.
    set((state) => {
      const nextCancellationRequested = new Set(
        state.gitActionCancellationRequested,
      );
      nextCancellationRequested.delete(key);
      return {
        ...(!dryRun
          ? {
              mergingPr: new Set([...Array.from(state.mergingPr), key]),
              mergePrProgress: {
                ...state.mergePrProgress,
                [key]: {
                  steps: [
                    {
                      phase: 'queued',
                      timestamp: Date.now(),
                    },
                  ],
                  currentPhase: 'queued',
                },
              },
            }
          : {}),
        gitActionOperationIds: {
          ...state.gitActionOperationIds,
          [key]: operationId,
        },
        gitActionCancellationRequested: nextCancellationRequested,
      };
    });

    try {
      const api: CanopyApi = window.api;
      const response: MergePrResponse = await runGitActionIpc(
        set,
        key,
        operationId,
        () =>
          api.github.mergePr({
            projectId,
            worktreeId,
            repoIds: options?.repoIds,
            confirmUnresolvedComments: options?.confirmUnresolvedComments,
            dryRun,
            operationId,
            ...(options?.source ? { source: options.source } : {}),
          }),
      );

      if (response.cancelled) {
        if (!dryRun) {
          await refreshGitActionState(
            set,
            get,
            key,
            projectId,
            worktreeId,
            api,
          );
        }
        return response;
      }

      if (dryRun) {
        return response;
      }

      // `mergedRepos` holds both outcomes: merged now, or added to the base
      // branch's merge queue (GitHub merges those once the queue's checks pass).
      const mergedCount = response.mergedRepos.filter(
        (repo) => repo.status === 'merged',
      ).length;
      const enqueuedCount = response.mergedRepos.filter(
        (repo) => repo.status === 'enqueued',
      ).length;
      if (mergedCount > 0) {
        get().addToast(
          `Merged ${mergedCount} pull ${
            mergedCount === 1 ? 'request' : 'requests'
          }.`,
          'success',
          undefined,
          mergeMeta,
        );
      }
      if (enqueuedCount > 0) {
        get().addToast(
          `Added ${enqueuedCount} pull ${
            enqueuedCount === 1 ? 'request' : 'requests'
          } to the merge queue.`,
          'success',
          undefined,
          mergeMeta,
        );
      }

      if (response.failedRepos.length > 0) {
        get().raiseGitActionFailure(
          projectId,
          worktreeId,
          {
            error: "Couldn't merge all repositories.",
            details: response.failedRepos
              .map(
                (failed) =>
                  `Merge failed for ${failed.repoName}: ${failed.error}`,
              )
              .join(' '),
          },
          failureAttemptId,
        );
      }

      // A merge queue chat is a handoff, not a merge: the chat the main process
      // focuses is the feedback, so it gets no success toast and no refresh.
      const mergeQueueChatCount = (response.mergeQueueChats ?? []).length;

      // Surface a not-mergeable result only when nothing merged or was handed
      // to a merge queue chat, and we are not waiting on the unresolved-comment
      // confirmation modal — otherwise the modal is the user-facing signal.
      if (
        response.mergedRepos.length === 0 &&
        mergeQueueChatCount === 0 &&
        response.failedRepos.length === 0 &&
        response.requiresUnresolvedConfirmation.length === 0
      ) {
        const blocked = response.verifiedRepos.filter(
          (repo) => repo.blockedReason !== undefined,
        );
        if (blocked.length > 0) {
          get().addToast(
            `Cannot merge ${formatRepoEntries(
              blocked,
              (repo) =>
                `${repo.repoName} (${
                  repo.blockedReason === 'has_conflicts'
                    ? 'has conflicts'
                    : repo.blockedReason === 'base_changed'
                      ? 'base branch changed'
                      : repo.blockedReason === 'in_merge_queue'
                        ? 'already in the merge queue'
                        : 'not mergeable'
                })`,
            )}.`,
            'warning',
            undefined,
            mergeMeta,
          );
        }
      }

      if (response.mergedRepos.length > 0) {
        markGitStatsRefreshing(set, key);
        await refreshGitHubWorktreeState(
          projectId,
          worktreeId,
          api,
          get().requestFastRefresh,
        );
      }

      return response;
    } catch (error: unknown) {
      if (!dryRun) {
        const appError = toAppError(resolveClientAppError(error));
        if (appError) {
          get().raiseGitActionFailure(
            projectId,
            worktreeId,
            inlineFailure(appError, "Couldn't merge the pull request."),
            failureAttemptId,
          );
        }
      }
      return null;
    } finally {
      set((state) => {
        const next = new Set(state.mergingPr);
        next.delete(key);
        const nextRefreshing = new Set(state.gitStatsRefreshing);
        nextRefreshing.delete(key);
        const nextMergePrProgress = { ...state.mergePrProgress };
        delete nextMergePrProgress[key];
        const nextOperationIds = { ...state.gitActionOperationIds };
        const nextCancellationRequested = new Set(
          state.gitActionCancellationRequested,
        );
        if (nextOperationIds[key] === operationId) {
          delete nextOperationIds[key];
          nextCancellationRequested.delete(key);
        }
        return {
          ...(!dryRun
            ? {
                mergingPr: next,
                gitStatsRefreshing: nextRefreshing,
                mergePrProgress: nextMergePrProgress,
              }
            : {}),
          gitActionOperationIds: nextOperationIds,
          gitActionCancellationRequested: nextCancellationRequested,
        };
      });
    }
  },

  pull: async (projectId: string, worktreeId: string): Promise<void> => {
    const key = worktreeKey(projectId, worktreeId);
    const operationId = createGitActionOperationId();
    const failureAttemptId = clearGitActionFailure(set, key, () => {
      void get().pull(projectId, worktreeId);
    });
    set((state) => {
      const nextCancellationRequested = new Set(
        state.gitActionCancellationRequested,
      );
      nextCancellationRequested.delete(key);
      return {
        committingAndPushing: new Set([
          ...Array.from(state.committingAndPushing),
          key,
        ]),
        activeBranchSyncAction: {
          ...state.activeBranchSyncAction,
          [key]: 'pull',
        },
        commitPushProgress: {
          ...state.commitPushProgress,
          [key]: { steps: [], currentPhase: 'pulling' },
        },
        gitActionOperationIds: {
          ...state.gitActionOperationIds,
          [key]: operationId,
        },
        gitActionCancellationRequested: nextCancellationRequested,
      };
    });

    const api: CanopyApi = window.api;
    try {
      const response: PullResponse = await runGitActionIpc(
        set,
        key,
        operationId,
        () =>
          api.github.pull({
            projectId,
            worktreeId,
            operationId,
          }),
      );
      if (response.cancelled) {
        await refreshGitActionState(set, get, key, projectId, worktreeId, api);
        return;
      }

      const pullMeta: ToastMeta = {
        category: 'Git Pull',
        workspaceName: lookupWorkspaceName(projectId),
        projectId,
        worktreeId,
      };
      if (response.failedRepos.length > 0) {
        get().raiseGitActionFailure(
          projectId,
          worktreeId,
          {
            ...buildFailedReposFailure('Pull', response.failedRepos),
          },
          failureAttemptId,
        );
      }
      if (response.skippedRepos.length > 0) {
        get().addToast(
          buildSkippedReposMessage(
            'Pull',
            response.skippedRepos,
            describePullSkipReason,
          ),
          'info',
          undefined,
          pullMeta,
        );
      }
      if (response.agentResolutionRepos.length > 0) {
        const [first] = response.agentResolutionRepos;
        const target = first
          ? { projectId, worktreeId, chatId: first.chatId }
          : null;
        get().addToast(
          buildAgentResolutionMessage(response.agentResolutionRepos, 'pull'),
          'warning',
          target ? openAgentResolutionChat(target) : undefined,
          pullMeta,
        );
      }

      markGitStatsRefreshing(set, key);
      await refreshGitHubWorktreeState(
        projectId,
        worktreeId,
        api,
        get().requestFastRefresh,
      );
    } catch (error: unknown) {
      const appError = toAppError(resolveClientAppError(error));
      if (appError) {
        get().raiseGitActionFailure(
          projectId,
          worktreeId,
          inlineFailure(appError, "Couldn't pull this branch."),
          failureAttemptId,
        );
      }
      // Pull preflight and failure handling prune deleted origin/* refs. Refresh
      // local branch stats even when the IPC rejects so a branch removed from
      // the remote immediately loses its stale Pull action.
      markGitStatsRefreshing(set, key);
      await refreshGitHubWorktreeState(
        projectId,
        worktreeId,
        api,
        get().requestFastRefresh,
      );
    } finally {
      set((state) => {
        const next = new Set(state.committingAndPushing);
        next.delete(key);
        const nextActiveAction = { ...state.activeBranchSyncAction };
        delete nextActiveAction[key];
        const nextRefreshing = new Set(state.gitStatsRefreshing);
        nextRefreshing.delete(key);
        const nextOperationIds = { ...state.gitActionOperationIds };
        const nextCancellationRequested = new Set(
          state.gitActionCancellationRequested,
        );
        if (nextOperationIds[key] === operationId) {
          delete nextOperationIds[key];
          nextCancellationRequested.delete(key);
        }
        return {
          committingAndPushing: next,
          activeBranchSyncAction: nextActiveAction,
          gitStatsRefreshing: nextRefreshing,
          gitActionOperationIds: nextOperationIds,
          gitActionCancellationRequested: nextCancellationRequested,
        };
      });
    }
  },

  pushOnly: async (projectId: string, worktreeId: string): Promise<void> => {
    await runPushOnly(set, get, { projectId, worktreeId });
  },

  continueAfterGitHubConnect: async (
    continuation: GitHubActionContinuation,
  ): Promise<void> => {
    const { projectId, worktreeId } = continuation;
    // Every target needs an original head, whether shared or per repository.
    const stopMessage =
      continuation.expectedHeadBranch === null &&
      !continuation.expectedHeadBranches
        ? 'GitHub is connected. Try again.'
        : gitHubContinuationTargetChanged(continuation)
          ? continuation.kind === 'pr'
            ? 'The branch changed. Start a new pull request.'
            : 'The branch changed. Start a new push.'
          : null;
    if (stopMessage) {
      get().addToast(stopMessage, 'info', undefined, {
        category: continuation.kind === 'pr' ? 'PR Create' : 'Git Push',
        workspaceName: lookupWorkspaceName(projectId),
        projectId,
        worktreeId,
      });
      return;
    }
    // Each child reports a stopped operation before its cleanup clears the
    // cancellation state. Never start a later repository after that outcome.
    const separateRepositories =
      continuation.expectedHeadBranch === null ||
      continuation.repoCommitPrepared !== undefined ||
      Boolean(continuation.pushCompletedRepoIds?.length);
    const continuations =
      separateRepositories && continuation.repoIds?.length
        ? continuation.repoIds.map(
            (repoId): GitHubActionContinuation => ({
              ...continuation,
              repoIds: [repoId],
              expectedHeadBranch:
                continuation.expectedHeadBranches?.[repoId] ??
                continuation.expectedHeadBranch,
              skipCommit:
                continuation.repoCommitPrepared?.[repoId] ??
                continuation.skipCommit,
            }),
          )
        : [continuation];
    for (const pending of continuations) {
      if (gitHubContinuationTargetChanged(pending)) {
        get().addToast(
          pending.kind === 'pr'
            ? 'The branch changed. Start a new pull request.'
            : 'The branch changed. Start a new push.',
          'info',
          undefined,
          { category: 'GitHub', projectId, worktreeId },
        );
        return;
      }
      const completed =
        pending.kind === 'pr'
          ? await runCreatePr(set, get, {
              projectId,
              worktreeId,
              repoIds: pending.repoIds,
              continuation: pending,
              source: pending.source,
            })
          : pending.repoCommitPrepared?.[pending.repoIds?.[0] ?? ''] === false
            ? await runCommitFlow(set, get, {
                projectId,
                worktreeId,
                mode: 'commit-and-push',
                repoIds: pending.repoIds,
                pullFirst: pending.pullFirst,
                source: pending.source,
                continuation: pending,
              })
            : await runPushOnly(set, get, {
                projectId,
                worktreeId,
                continuation: pending,
              });
      if (!completed) return;
    }
  },

  cancelGitAction: async (
    projectId: string,
    worktreeId: string,
  ): Promise<GitActionCancellationResult> => {
    const key = worktreeKey(projectId, worktreeId);
    if (hasPendingGitHubConnectOffer(projectId, worktreeId)) {
      const offer = useGitHubConnectOfferStore.getState().offer;
      if (offer)
        useGitHubConnectOfferStore
          .getState()
          .clearOffer(offer.continuation.operationId);
      return { accepted: true, reason: 'cancel_requested' };
    }
    const state = get();
    const operationId = state.gitActionOperationIds[key];
    const hadIpcRequestInFlight = state.gitActionIpcPending.has(key);
    if (!operationId) return { accepted: false, reason: 'not_active' };
    if (
      state.gitStatsRefreshing.has(key) ||
      state.mergePrProgress[key]?.currentPhase === 'refreshing_pr_status'
    ) {
      return { accepted: false, reason: 'refreshing' };
    }

    // A review modal is a renderer-owned pause between agent and Git stages.
    // Resolve it as declined immediately so no subsequent mutation can start.
    state.commitReviewPending[key]?.resolve({ approved: false });
    set((current) => ({
      gitActionCancellationRequested: new Set([
        ...Array.from(current.gitActionCancellationRequested),
        key,
      ]),
    }));

    try {
      const response = await window.api.github.cancelGitAction({
        projectId,
        worktreeId,
        operationId,
      });
      if (!response.accepted && hadIpcRequestInFlight) {
        set((current) => {
          if (current.gitActionOperationIds[key] !== operationId) return {};
          const next = new Set(current.gitActionCancellationRequested);
          next.delete(key);
          return { gitActionCancellationRequested: next };
        });
      }
      if (response.reason === 'not_active' && !hadIpcRequestInFlight) {
        return { accepted: true, reason: 'cancel_requested' };
      }
      return response;
    } catch (error: unknown) {
      // The renderer-side flag remains authoritative between chained IPC
      // stages and still prevents the visible action from advancing.
      reportClientAppError(error);
      return { accepted: false, reason: 'request_failed' };
    }
  },

  resolveCommitReview: (
    projectId: string,
    worktreeId: string,
    approved: boolean,
    messages?: CommitReviewMessage[],
  ): void => {
    const key = worktreeKey(projectId, worktreeId);
    const entry = get().commitReviewPending[key];
    if (entry) {
      entry.resolve({ approved, messages });
    }
  },

  requestRefresh: async (
    projectId: string,
    worktreeId: string,
  ): Promise<void> => {
    try {
      const api: CanopyApi = window.api;
      await api.github.requestPrStatusRefresh({
        projectId,
        worktreeId,
      });
    } catch (error: unknown) {
      // Background refresh: record it, but show nothing; the next poll retries.
      reportClientAppError(error);
    }
  },

  requestFastRefresh: async (
    projectId: string,
    worktreeId: string,
    skipIfFresh?: boolean,
  ): Promise<void> => {
    try {
      const api: CanopyApi = window.api;
      await api.github.requestFastRefresh({
        projectId,
        worktreeId,
        skipIfFresh,
      });
    } catch (error: unknown) {
      // Background refresh: record it, but show nothing; the next poll retries.
      reportClientAppError(error);
    }
  },

  requestKnownPrFastRefresh: async (
    projectId: string,
    worktreeId: string,
  ): Promise<boolean> => {
    try {
      const api: CanopyApi = window.api;
      return await api.github.requestKnownPrFastRefresh({
        projectId,
        worktreeId,
      });
    } catch (error: unknown) {
      // Background refresh: record it, but show nothing; the next poll retries.
      reportClientAppError(error);
      return false;
    }
  },

  clearWorktreePrStatus: (projectId, worktreeId): void => {
    const key = worktreeKey(projectId, worktreeId);
    // A branch change drops the old branch's failure, but never the attempt
    // still running: its failure (say, the branch changed) must still show.
    if (!gitHubActionBusy(get, key)) clearGitActionFailure(set, key);
    set((state) => {
      const livePrStatusWorktreeKeys = new Set(state.livePrStatusWorktreeKeys);
      // An explicit clear (branch change) immediately requests a fresh poll,
      // so its `null` is a deliberate "unknown for now" signal — trustworthy
      // enough to badge as no-PR while the refresh is in flight, unlike a
      // stale hydration copy.
      livePrStatusWorktreeKeys.add(key);
      return {
        prStatuses: { ...state.prStatuses, [key]: null },
        livePrStatusWorktreeKeys,
      };
    });
  },

  raiseGitActionFailure: (projectId, worktreeId, failure, attemptId): void => {
    const key = worktreeKey(projectId, worktreeId);
    if (attemptId !== undefined && gitFailureAttempts.get(key) !== attemptId)
      return;
    gitActionFailureSeq += 1;
    const seq = gitActionFailureSeq;
    // Only the attempt that registered the retry may offer it, and it never
    // starts while another git action (or this attempt's own cleanup) is
    // still running on the worktree.
    const registered =
      attemptId === undefined ? undefined : gitFailureRetries.get(key);
    const retry = registered
      ? (): void => {
          if (gitHubActionBusy(get, key)) return;
          registered();
        }
      : undefined;
    set((state) => ({
      gitActionFailures: {
        ...state.gitActionFailures,
        [key]: { ...failure, seq, ...(retry ? { retry } : {}) },
      },
    }));
  },

  dismissGitActionFailure: (projectId, worktreeId, seq): void => {
    const key = worktreeKey(projectId, worktreeId);
    set((state) => {
      if (state.gitActionFailures[key]?.seq !== seq) return {};
      // Only the visible failure goes. The attempt keeps its id, so a later
      // failure from the same run (a push after a partial commit message
      // failure) still shows and still marks its progress as failed.
      const next = { ...state.gitActionFailures };
      delete next[key];
      return { gitActionFailures: next };
    });
  },

  hydratePersistedPrStatuses: (items): void => {
    const prStatuses: Record<string, WorktreePrStatus | null> = {};
    // Cowork and App Advisor list no work entries here, so their failures
    // are kept per project: a chat's git failure shows on its own page.
    const coworkPrefixes: string[] = [`${APP_ADVISOR_PROJECT_ID}/`];
    for (const item of items) {
      if (item.type === 'cowork') {
        coworkPrefixes.push(`${item.id}/`);
        continue;
      }

      for (const worktree of item.worktrees) {
        prStatuses[worktreeKey(item.id, worktree.id)] =
          worktree.lastKnownPrStatus ?? null;
      }
    }

    // Wholesale replacement from the renderer's own (possibly stale)
    // `worktree.lastKnownPrStatus` copy, not a live signal — reset the
    // confirmed set so a `null` written here is not mistaken for a
    // live-confirmed "no PR" until a fresh event actually arrives (CAN-3053
    // finding 8).
    const live = (key: string): boolean =>
      key in prStatuses ||
      coworkPrefixes.some((prefix) => key.startsWith(prefix));
    for (const key of gitFailureAttempts.keys()) {
      if (!live(key)) {
        gitFailureAttempts.delete(key);
        gitFailureRetries.delete(key);
      }
    }
    // A removed worktree's failure has nowhere to show; drop it.
    set((state) => ({
      prStatuses,
      livePrStatusWorktreeKeys: new Set(),
      gitActionFailures: Object.fromEntries(
        Object.entries(state.gitActionFailures).filter(([key]) => live(key)),
      ),
    }));
  },

  subscribeToEvents: (): (() => void) => {
    const api: CanopyApi = window.api;
    const unsubStatus = api.github.onPrStatusUpdate((event: PrStatusEvent) => {
      const key = worktreeKey(event.projectId, event.worktreeId);
      const projectsStore = useProjectsStore.getState();
      const project = projectsStore.projects.find(
        (item) => item.id === event.projectId,
      );
      if (
        !project ||
        project.type === 'cowork' ||
        !project.worktrees.some((row) => row.id === event.worktreeId) ||
        projectsStore.archivingWorktrees.has(key)
      )
        return;
      const currentPrStatuses = get().prStatuses;
      const previousStatus = Object.prototype.hasOwnProperty.call(
        currentPrStatuses,
        key,
      )
        ? currentPrStatuses[key]
        : findWorktreePrStatus(
            projectsStore.projects,
            event.projectId,
            event.worktreeId,
          );
      const newlyMergedRepoIds = collectNewlyMergedRepoIds(
        previousStatus,
        event.status,
      );
      const parentRefreshTargets = collectParentBranchRefreshTargets({
        projects: projectsStore.projects,
        repoBranches: projectsStore.repoBranches,
        baseBranches: projectsStore.baseBranches,
        projectId: event.projectId,
        worktreeId: event.worktreeId,
        mergedRepoIds: newlyMergedRepoIds,
      });
      set((state) => {
        const livePrStatusWorktreeKeys = new Set(
          state.livePrStatusWorktreeKeys,
        );
        livePrStatusWorktreeKeys.add(key);
        const nextState: Partial<GitHubState> = {
          prStatuses: { ...state.prStatuses, [key]: event.status },
          livePrStatusWorktreeKeys,
        };

        const progress = state.creationProgress[key];
        if (
          shouldClearStalePrCreationProgress(
            event.status,
            progress,
            state.creatingPr.has(key),
          )
        ) {
          const nextCreationProgress = { ...state.creationProgress };
          delete nextCreationProgress[key];
          nextState.creationProgress = nextCreationProgress;
        }

        return nextState;
      });
      projectsStore.setWorktreeLastKnownPrStatus(
        event.projectId,
        event.worktreeId,
        event.status,
      );

      if (hasMergedPr(event.status)) {
        projectsStore.setWorktreeStatus(
          event.projectId,
          event.worktreeId,
          'done',
        );
      } else if (hasOpenPr(event.status)) {
        projectsStore.setWorktreeStatus(event.projectId, event.worktreeId);
      }

      if (parentRefreshTargets.length > 0) {
        void projectsStore
          .refreshWorktreesDiffStatsFromRemote(parentRefreshTargets)
          .catch((error: unknown) => {
            reportClientAppError(error);
          });
      }

      for (const target of parentRefreshTargets) {
        void get().requestFastRefresh(target.projectId, target.worktreeId);
      }
    });

    const unsubBaseBranches =
      api.github.onDependentBaseBranchesUpdated?.(
        (event: DependentBaseBranchesUpdatedEvent) => {
          const projectsStore = useProjectsStore.getState();
          projectsStore.applyDependentBaseBranchUpdates(event.updates);

          const refreshTargets = Array.from(
            new Map(
              event.updates.map((update) => {
                const target = {
                  projectId: update.projectId,
                  worktreeId: update.worktreeId,
                };
                return [
                  worktreeKey(target.projectId, target.worktreeId),
                  target,
                ] as const;
              }),
            ).values(),
          );
          if (refreshTargets.length === 0) {
            return;
          }

          void projectsStore
            .refreshWorktreesDiffStatsFromRemote(refreshTargets)
            .catch((error: unknown) => {
              reportClientAppError(error);
            });

          for (const target of refreshTargets) {
            void requestLoadedChangedFilesRefresh(
              target.projectId,
              target.worktreeId,
            ).catch((error: unknown) => {
              reportClientAppError(error);
            });
          }
        },
      ) ?? ((): void => undefined);

    // Generic GitHub rate-limit event (supersedes the retired PR-specific
    // rate-limit IPC path). The backend deduplicates emitted events per
    // pause window; we deduplicate defensively here too, keyed on the pause
    // window's resume time (`retryAt`) so one throttle/pause window never
    // surfaces more than a single `GitHub`-category toast even if the event is
    // redelivered. A fresh subscription session starts with an empty key.
    let lastRateLimitPauseKey: string | null = null;
    const unsubRateLimit =
      api.github.onGitHubRateLimitError?.((event: GitHubRateLimitEvent) => {
        const pauseKey = `${event.kind}:${event.retryAt}`;
        if (pauseKey === lastRateLimitPauseKey) {
          return;
        }
        lastRateLimitPauseKey = pauseKey;
        get().addToast(event.message, 'info', undefined, {
          category: 'GitHub',
        });
      }) ?? ((): void => undefined);

    const unsubProgress = api.github.onPrCreationProgress(
      (event: PrCreationProgressEvent) => {
        const key = worktreeKey(event.projectId, event.worktreeId);
        set((state) => {
          if (event.refreshing === true) {
            return {
              gitStatsRefreshing: new Set([
                ...Array.from(state.gitStatsRefreshing),
                key,
              ]),
            };
          }
          const existing = state.creationProgress[key];
          const step: PrCreationStep = {
            phase: event.phase,
            repoName: event.repoName,
            error: event.error,
            timestamp: Date.now(),
          };
          // Per-repo terminal events (done/error with repoName) and skipped
          // events should not override the overall currentPhase.
          const isPerRepoTerminal =
            (event.phase === 'done' || event.phase === 'error') &&
            !!event.repoName;
          const isSkipped = event.phase === 'skipped';
          // When the global 'done' arrives, check if any repo had errors.
          // If so, keep currentPhase as 'error' so the UI persists the error state.
          const allSteps = [...(existing?.steps ?? []), step];
          const hasPerRepoError = allSteps.some(
            (s) => s.phase === 'error' && s.repoName != null,
          );
          const isGlobalDone =
            event.phase === 'done' && !event.repoName && hasPerRepoError;
          const nextPhase =
            isPerRepoTerminal || isSkipped
              ? (existing?.currentPhase ?? event.phase)
              : isGlobalDone
                ? 'error'
                : event.phase;
          const updated: PrCreationProgress = {
            steps: [...(existing?.steps ?? []), step],
            currentPhase: nextPhase,
          };
          return {
            creationProgress: {
              ...state.creationProgress,
              [key]: updated,
            },
          };
        });
      },
    );

    const unsubCommitPushProgress = api.github.onCommitPushProgress(
      (event: CommitPushProgressEvent) => {
        const key = worktreeKey(event.projectId, event.worktreeId);
        set((state) => {
          const existing = state.commitPushProgress[key];
          const step: CommitPushStep = {
            phase: event.phase,
            repoName: event.repoName,
            error: event.error,
            timestamp: Date.now(),
          };
          // Per-repo terminal events (done/error with repoName) should not
          // override the overall currentPhase.
          const isPerRepoTerminal =
            (event.phase === 'done' || event.phase === 'error') &&
            !!event.repoName;
          // When the global 'done' arrives, check if any repo had errors.
          // If so, keep currentPhase as 'error'.
          const allSteps = [...(existing?.steps ?? []), step];
          const hasPerRepoError = allSteps.some(
            (s) => s.phase === 'error' && s.repoName != null,
          );
          const isGlobalDone =
            event.phase === 'done' && !event.repoName && hasPerRepoError;
          const candidatePhase: CommitPushPhase = isPerRepoTerminal
            ? (existing?.currentPhase ?? event.phase)
            : isGlobalDone
              ? 'error'
              : event.phase;
          // Keep the displayed phase monotonic so an out-of-order earlier-phase
          // event cannot move the UI backward (e.g. "Staging" → "Generating").
          const nextPhase = furthestCommitPushPhase(
            existing?.currentPhase,
            candidatePhase,
          );
          const updated: CommitPushProgress = {
            steps: allSteps,
            currentPhase: nextPhase,
          };
          return {
            commitPushProgress: {
              ...state.commitPushProgress,
              [key]: updated,
            },
          };
        });
      },
    );

    const unsubMergePrProgress =
      api.github.onMergePrProgress?.((event: MergePrProgressEvent) => {
        const key = worktreeKey(event.projectId, event.worktreeId);
        set((state) => {
          const existing = state.mergePrProgress[key];
          const step: MergePrStep = {
            phase: event.phase,
            repoId: event.repoId,
            repoName: event.repoName,
            queuePosition: event.queuePosition,
            queueLength: event.queueLength,
            retryDelayMs: event.retryDelayMs,
            error: event.error,
            timestamp: Date.now(),
          };
          const updated: MergePrProgress = {
            steps: [...(existing?.steps ?? []), step],
            currentPhase: event.phase,
          };
          return {
            mergePrProgress: {
              ...state.mergePrProgress,
              [key]: updated,
            },
          };
        });
      }) ?? ((): void => undefined);

    const unsubSplitPrProgress = api.github.onSplitPrProgress(
      (event: SplitPrProgressEvent) => {
        const key = worktreeKey(event.projectId, event.worktreeId);
        const terminalPhases: readonly SplitPrPhase[] = [
          'done',
          'error',
          'cancelled',
        ];
        set((state) => {
          const nextProgress = {
            ...state.splitPrProgress,
            [key]: [...(state.splitPrProgress[key] ?? []), event],
          };
          if (!terminalPhases.includes(event.phase)) {
            return { splitPrProgress: nextProgress };
          }
          const nextSplitting = new Set(state.splittingPr);
          nextSplitting.delete(key);
          return {
            splitPrProgress: nextProgress,
            splittingPr: nextSplitting,
          };
        });
      },
    );

    const unsubSplitLock = api.github.onSplitLockChange((event) => {
      const key = worktreeKey(event.workspaceId, event.worktreeId);
      set((state) => {
        const next = new Set(state.splitLockedWorktrees);
        if (event.locked) {
          next.add(key);
          return { splitLockedWorktrees: next };
        }
        next.delete(key);
        // A release means the run settled main-side. Clear any lingering
        // in-flight flag (including one seeded from a reload-during-execute
        // hydration, which has no live approve/resume promise to clear it in
        // its own `finally`) so the settled state renders correctly.
        const nextSplitting = new Set(state.splittingPr);
        nextSplitting.delete(key);
        return { splitLockedWorktrees: next, splittingPr: nextSplitting };
      });
      // On a lock RELEASE, the split has settled main-side (success, failure,
      // cancel, or exit). The renderer's in-memory `splitPrResults[key]` can be
      // stale — e.g. a mid-execute reload seeded only the lock, so the map is
      // still whatever was last read (often `executing`), and the settle that
      // followed the reload happened without a live store handler to refresh
      // it. Re-read the persisted map so the result view / interrupted-modal
      // detection reflects the true terminal state rather than a stale entry.
      //
      // Presentation-session policy on release: KEEP the session iff the
      // settled map is `completed` (so the SplitWorkflowView Finalize finished
      // page stays up until the user hits Done); otherwise END it so a
      // cancelled/failed/exited settle swaps back to normal UX (where the
      // failure/interrupted modals and PR-panel result view live). Live
      // approve/resume handlers already close the session synchronously on
      // failure before their map re-read; this covers cancellation and
      // reload-settle paths that have no live handler.
      if (!event.locked) {
        void get()
          .loadSplitPrMap(event.workspaceId, event.worktreeId)
          .then(() => {
            const key = worktreeKey(event.workspaceId, event.worktreeId);
            const map = get().splitPrResults[key];
            if (map === undefined || map.status !== 'completed') {
              get().closeSplitWorkflowSession(
                event.workspaceId,
                event.worktreeId,
              );
            }
          });
      }
    });

    // Seed the mirrored lock set once from the main-side snapshot. The events
    // above are edge-triggered, so after a reload/crash the renderer would
    // otherwise start with an empty set even when a lock is genuinely still
    // held (e.g. a split execute in flight). Merge the snapshot into the set so
    // any lock-change events that arrive before this resolves are preserved.
    void api.github.getSplitLockState().then((snapshot) => {
      set((state) => {
        const next = new Set(state.splitLockedWorktrees);
        // Executing entries must ALSO seed `splittingPr`: after a reload during
        // execute only the lock survives, so without this the workflow view
        // would derive the Plan step (empty `splittingPr`) instead of Execute.
        const nextSplitting = new Set(state.splittingPr);
        for (const entry of snapshot.locked) {
          const key = worktreeKey(entry.workspaceId, entry.worktreeId);
          next.add(key);
          if (entry.executing) {
            nextSplitting.add(key);
          }
        }
        return { splitLockedWorktrees: next, splittingPr: nextSplitting };
      });
    });

    return (): void => {
      unsubStatus();
      unsubBaseBranches();
      unsubRateLimit();
      unsubProgress();
      unsubCommitPushProgress();
      unsubMergePrProgress();
      unsubSplitPrProgress();
      unsubSplitLock();
    };
  },

  addToast,
}));

interface E2eToastTestApi {
  /** Raises a toast exactly as a feature would, with a no-op click target. */
  addToast: (input: {
    message: string;
    type: Toast['type'];
    clickable?: boolean;
    meta?: Pick<
      ToastMeta,
      | 'category'
      | 'title'
      | 'persistent'
      | 'link'
      | 'workspaceName'
      | 'projectId'
      | 'worktreeId'
    >;
    /** Adds a labelled no-op action button. */
    actionLabel?: string;
  }) => void;
  /** Removes every visible toast, so the next state starts empty. */
  clear: () => void;
}

declare global {
  interface Window {
    __canopyToastTestApi?: E2eToastTestApi;
  }
}

// E2E-only probe (same pattern as `__canopyProjectsTestApi`): toasts come from
// many unrelated flows, so the notification stack spec raises them directly.
if (__CANOPY_E2E__) {
  window.__canopyToastTestApi = {
    addToast: ({ message, type, clickable, meta, actionLabel }): void => {
      useGitHubStore
        .getState()
        .addToast(
          message,
          type,
          clickable === true ? (): void => undefined : undefined,
          {
            ...meta,
            ...(actionLabel === undefined
              ? {}
              : {
                  action: {
                    label: actionLabel,
                    onClick: (): void => undefined,
                  },
                }),
          },
        );
    },
    clear: (): void => {
      resetToastStack();
    },
  };
}
