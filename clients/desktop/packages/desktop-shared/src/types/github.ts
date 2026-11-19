import {
  isRemoteControlPrMergeQueuePhase,
  type RemoteControlPrMergeQueuePhase,
  type RemoteControlPullRequestCheckExecutionState,
} from '@canopy/protocol/remote-control/shell';
import type { AppError } from '@canopy/protocol/app-errors';
import type { SplitPlanIssue } from './pr-split-plan';

// ---------------------------------------------------------------------------
// GitHub PR integration types
// ---------------------------------------------------------------------------

export type PrState = 'open' | 'merged' | 'closed' | 'draft';
export type CheckStatus =
  | 'passing'
  | 'failing'
  | 'pending'
  | 'neutral'
  | 'none';
/** Detailed GitHub check state; shared with the Portal wire vocabulary. */
export type CheckExecutionState = RemoteControlPullRequestCheckExecutionState;
export type ReviewStatus =
  | 'approved'
  | 'changes_requested'
  | 'pending'
  | 'none';

export interface CheckDetail {
  name: string;
  status: CheckStatus;
  /**
   * The GitHub check state behind {@link status}. Optional: rows persisted by
   * older builds, and GitHub states not in the mapping, have none.
   */
  executionState?: CheckExecutionState;
  detailsUrl: string | null;
}

export interface ReviewerInfo {
  login: string;
  state: 'approved' | 'changes_requested' | 'pending';
}

/**
 * Minimal label shape surfaced on the lightweight runtime PR status (and its
 * persisted `lastKnownPrStatus`). Only the fields the activity panel renders
 * are kept so the persisted payload stays small; the full label snapshot lives
 * on {@link GitHubLabelSnapshot}.
 */
export interface PrLabel {
  name: string;
  /**
   * GitHub label color, normally a 6-digit hex string without the leading `#`.
   * Empty when GitHub did not return a usable color; renderers should fall back
   * to a neutral treatment.
   */
  color: string;
  /** Optional label description surfaced as a tooltip. */
  description: string | null;
}

/**
 * GitHub's `MergeQueueEntryState`, normalized; the Portal wire contract owns
 * the values. `unknown` is a value this build does not recognize; the PR is
 * still queued.
 */
export type PrMergeQueuePhase = RemoteControlPrMergeQueuePhase;

const PR_MERGE_QUEUE_PHASE_BY_GITHUB_STATE: Readonly<
  Record<string, PrMergeQueuePhase>
> = {
  QUEUED: 'queued',
  AWAITING_CHECKS: 'awaiting_checks',
  MERGEABLE: 'mergeable',
  LOCKED: 'locked',
  UNMERGEABLE: 'unmergeable',
};

export function isPrMergeQueuePhase(
  value: unknown,
): value is PrMergeQueuePhase {
  return typeof value === 'string' && isRemoteControlPrMergeQueuePhase(value);
}

/** Maps a GitHub `MergeQueueEntryState` value; anything else is `unknown`. */
export function toPrMergeQueuePhase(state: unknown): PrMergeQueuePhase {
  if (typeof state !== 'string') return 'unknown';
  return PR_MERGE_QUEUE_PHASE_BY_GITHUB_STATE[state.toUpperCase()] ?? 'unknown';
}

/** A phase a watcher can filter on; `unknown` never matches a filter. */
export type PrMergeQueueKnownPhase = Exclude<PrMergeQueuePhase, 'unknown'>;

/** Merge queue membership read from one pull request sample. */
export interface PrMergeQueueMembership {
  inQueue: boolean;
  /** GitHub `MergeQueueEntry.id`; a new entry is created on every enqueue. */
  entryId: string | null;
  /** Absent when the PR is not queued. */
  phase?: PrMergeQueuePhase;
  enqueuedAt: string | null;
  position: number | null;
}

/** One `AddedToMergeQueueEvent` / `RemovedFromMergeQueueEvent` timeline item. */
export interface PrMergeQueueTimelineEvent {
  type: 'added' | 'removed';
  id: string;
  createdAt: string;
  /** GitHub's removal reason (for example `merged`, `failed_checks`). */
  reason?: string | null;
}

/**
 * The PR's merge queue timeline as read in one sample. `events` holds the
 * filtered timeline indices `[firstIndex, filteredCount)` in order.
 * `unavailable` means the timeline could not be read reliably this sample.
 */
export type PrMergeQueueHistory =
  | {
      status: 'complete';
      filteredCount: number;
      firstIndex: number;
      events: PrMergeQueueTimelineEvent[];
    }
  | { status: 'unavailable' };

/** Durable position in a PR's merge queue timeline. */
export interface PrMergeQueueCursor {
  /** Filtered timeline count already interpreted. */
  count: number;
  /** Id of the newest interpreted timeline event, used to verify continuity. */
  lastEventId: string | null;
}

/**
 * A queue exit not yet reported: a `merged` removal is held because GitHub
 * records it about a second before the merge, and a membership-only exit
 * waits for one confirming sample.
 */
export interface PrMergeQueuePendingExit {
  heldFor: 'merged_reason' | 'confirm';
  /** Entry that was left. */
  entryId: string | null;
  /** Sample that first saw the exit. */
  observedAt: string;
  /** Open samples seen since; a held `merged` removal is released after 2. */
  samples: number;
  /** Removal details to report if the hold is released. */
  removedAt: string | null;
  reason: string | null;
  /** Timeline removals folded into a held `merged` removal; absent means 1. */
  removals?: number;
}

/** The entry last reported by a `pr:queue:entered` hook trigger. */
export interface PrMergeQueueEnteredRecord {
  entryId: string | null;
  enqueuedAt: string | null;
  phase: PrMergeQueuePhase;
  position: number | null;
  reentry: boolean;
  /** Snapshot `capturedAt` of the sample that reported it. */
  observedAt: string;
}

/** The exit last reported by a `pr:queue:removed` hook trigger. */
export interface PrMergeQueueRemovedRecord {
  /** Entry that was left. */
  entryId: string | null;
  removedAt: string | null;
  reason: string | null;
  evidence: 'timeline' | 'entry_changed' | 'membership';
  requeued: boolean;
  removals?: number;
  observedAt: string;
}

/**
 * Merge queue evidence on a PR tracking snapshot; absent means unknown. The
 * fetch sets `required`, `membership`, and `history`; tracking replaces
 * `history` with `cursor` and records holds and reported transitions.
 */
export interface PrMergeQueueSnapshot {
  required: boolean;
  membership: PrMergeQueueMembership;
  /** The fetched timeline; never persisted. */
  history?: PrMergeQueueHistory;
  cursor?: PrMergeQueueCursor;
  pendingExit?: PrMergeQueuePendingExit;
  lastEntered?: PrMergeQueueEnteredRecord;
  lastRemoved?: PrMergeQueueRemovedRecord;
}

/** GitHub merge queue state for an open PR. */
export interface PrMergeQueueStatus {
  /** The base branch requires a merge queue; absent when GitHub did not report it. */
  required?: boolean;
  /** The PR has a queue entry; absent when membership is unknown. */
  inQueue?: boolean;
  /** 1-based queue position when the PR is queued and GitHub reports one. */
  position?: number | null;
  /**
   * Entry phase when the PR is queued and GitHub reported its entry. Older
   * snapshots omit it; membership alone still means queued.
   */
  phase?: PrMergeQueuePhase;
  /**
   * GitHub's `estimatedTimeToMerge` in seconds while queued; absent when
   * GitHub has no estimate. Display only: queue transitions ignore it.
   */
  estimatedSecondsToMerge?: number;
  /**
   * When this queued standing was read, estimate or not. A display orders it
   * against other queue reads and counts the estimate down from it. Display
   * only: queue transitions ignore it. Absent out of the queue, so an unqueued
   * PR's status stays identical between polls.
   */
  observedAt?: string;
}

/** Reads one branch's merge queue for display. */
export interface GitHubMergeQueueRequest {
  /** `owner/name` of the repository. */
  repository: string;
  baseBranch: string;
}

/** One pull request waiting in a merge queue. */
export interface GitHubMergeQueueEntry {
  /** 1-based position in the queue. */
  position: number;
  phase: PrMergeQueuePhase;
  estimatedSecondsToMerge: number | null;
  enqueuedAt: string | null;
  pullRequest: {
    number: number;
    title: string;
    url: string;
    /** Author login; null when GitHub withheld it (a deleted account). */
    author: string | null;
  };
}

/** A branch's merge queue, as read from GitHub. */
export interface GitHubMergeQueueView {
  /** The queue's page on GitHub. */
  url: string | null;
  baseBranch: string;
  /** Pull requests in the queue; `entries` holds at most the first page. */
  totalCount: number;
  /** How many entries GitHub tests together; null when not reported. */
  maximumEntriesToBuild: number | null;
  entries: GitHubMergeQueueEntry[];
  fetchedAt: string;
}

export interface GitHubMergeQueueResponse {
  /** Null when the branch has no merge queue. */
  queue: GitHubMergeQueueView | null;
}

export interface PrStatusData {
  prNumber: number;
  prUrl: string;
  /** Exact PR head commit SHA returned by GitHub when this status was verified. */
  headSha?: string;
  state: PrState;
  title: string;
  /**
   * PR description/body, truncated to bound the persisted payload. Surfaced in
   * the worktree-row PR tooltip. Undefined when unavailable.
   */
  body?: string;
  checkStatus: CheckStatus;
  checkDetails: CheckDetail[];
  reviewStatus: ReviewStatus;
  reviewers: ReviewerInfo[];
  /**
   * Labels applied to the PR. Omitted when the PR has no labels so the section
   * can be hidden entirely and the persisted payload stays minimal.
   */
  labels?: PrLabel[];
  hasConflicts: boolean;
  /** GitHub's computed test-merge result from the pull request API. */
  mergeable?: boolean | null;
  /** GitHub's computed merge state, e.g. `clean`, `blocked`, or `dirty`. */
  mergeableState?: string | null;
  commentCount: number;
  /**
   * Count of open (unresolved) review threads on the PR, fetched via GraphQL.
   * Unlike `commentCount` (which counts every issue/review comment), this
   * reflects GitHub's resolvable review-thread state and drives the merge
   * button's warning treatment. Undefined when the thread state could not be
   * fetched (e.g. token lacks scope, GraphQL error, or no open PR).
   */
  unresolvedReviewThreadCount?: number;
  /**
   * Merge queue state for the PR's base branch, fetched with the review
   * threads. Undefined when the GraphQL call failed or the PR is not open, so
   * callers treat it as unknown.
   */
  mergeQueue?: PrMergeQueueStatus;
  updatedAt: string;
  /** PR open instant from Octokit `created_at`. (CAN-373 F1.) */
  openedAt?: string;
  /** PR merge instant from Octokit `merged_at`. (CAN-373 F1.) */
  mergedAt?: string;
  /** Base branch name returned by GitHub for the PR. */
  baseRefName?: string;
  /** Lines added across the PR diff. (CAN-373 F1.) */
  additions?: number;
  /** Lines deleted across the PR diff. (CAN-373 F1.) */
  deletions?: number;
  /** Files changed in the PR diff. (CAN-373 F1.) */
  changedFiles?: number;
}

export interface RepoPrStatus {
  repoId: string;
  repoName: string;
  status: PrStatusData | null;
  /** True only when the provider successfully verified PR state for the branch. */
  prLookupAvailable?: boolean;
}

export interface WorktreePrStatus {
  repos: RepoPrStatus[];
  lastCheckedAt: string;
}

/** Correlates every IPC stage belonging to one visible multi-phase Git action. */
export interface GitActionOperationRequest {
  operationId?: string;
}

/** Present and true when an operation stopped at a safe cancellation boundary. */
export interface GitActionOperationResponse {
  cancelled?: boolean;
}

export interface CancelGitActionRequest {
  projectId: string;
  worktreeId: string;
  operationId: string;
}

export interface CancelGitActionResponse {
  accepted: boolean;
  reason: 'cancel_requested' | 'refreshing' | 'not_active';
}

export interface CreatePrRequest extends GitActionOperationRequest {
  /** Original distinct target count retained across scoped retries; analytics only. */
  telemetryRepoCount?: number;
  /** Analytics attribution only; never grants permission. Main defaults to manual. */
  source?: 'manual' | 'chat';
  /** Continue after an auth failure using existing commits; leave new edits uncommitted. */
  skipCommit?: boolean;
  /** Continue PR creation after its push succeeded; requires skipCommit and a head guard. */
  skipPush?: boolean;
  projectId: string;
  worktreeId: string;
  repoIds?: string[];
  /** Optional displayed identity that must still match before mutation. */
  expectedBaseBranch?: string;
  expectedHeadBranch?: string;
}

export type GitHubAuthFailureCode = 'github_not_authenticated';

export interface RepoFailureResult {
  repoId?: string;
  repoName: string;
  error: string;
  status: 'failed';
  /** The error main already recorded for this failure, so the banner does not record it again. */
  appError?: AppError;
  failureCode?: GitHubAuthFailureCode;
  /** PR preparation reached the commit stage before authentication failed. */
  commitPrepared?: boolean;
  /** PR preparation already pushed this repository before authentication failed. */
  pushCompleted?: boolean;
}

export interface CreatePrRepoResult {
  repoId: string;
  repoName: string;
  prNumber: number;
  prUrl: string;
}

export interface SkippedRepo {
  repoId: string;
  repoName: string;
  reason: 'no_changes' | 'no_remote_origin';
}

export interface CreatePrLocalCommitResult {
  repoId: string;
  repoName: string;
  commitHash: string;
}

export interface CreatePrResponse extends GitActionOperationResponse {
  repos: CreatePrRepoResult[];
  /** Failed repositories are separate so successful PRs retain their original shape. */
  failedRepos?: RepoFailureResult[];
  skippedRepos: SkippedRepo[];
  localOnlyCommittedRepos: CreatePrLocalCommitResult[];
}

export interface PrStatusEvent {
  projectId: string;
  worktreeId: string;
  status: WorktreePrStatus | null;
}

/**
 * Generic GitHub rate-limit event delivered over
 * `IPC_CHANNELS.githubRateLimitEvent`.
 *
 * - `kind: "primary"` — the account's primary REST rate limit is exhausted;
 *   requests resume at `retryAt`.
 * - `kind: "secondary"` — GitHub is applying secondary/abuse throttling;
 *   retry after `retryAfterSeconds`.
 *
 * `retryAt` is an ISO-8601 timestamp; `retryAfterSeconds` is the whole-second
 * delay. `resource` optionally names the REST resource bucket (e.g. `core`,
 * `search`) the limit applies to.
 */
export interface GitHubRateLimitEvent {
  kind: 'primary' | 'secondary';
  message: string;
  retryAt: string;
  retryAfterSeconds: number;
  resource?: string;
}

export interface DependentBaseBranchUpdate {
  projectId: string;
  worktreeId: string;
  repoId?: string;
  previousBaseBranch: string;
  nextBaseBranch: string;
  /** Visual parent to retain after the operational base branch is retargeted. */
  branchGroupingParentWorktreeId?: string;
}

export interface DependentBaseBranchesUpdatedEvent {
  updates: DependentBaseBranchUpdate[];
}

export type PrCreationPhase =
  | 'gathering_changes'
  | 'summarizing'
  | 'pushing'
  | 'creating_pr'
  | 'skipped'
  | 'done'
  | 'error';

export interface PrCreationProgressEvent {
  projectId: string;
  worktreeId: string;
  phase: PrCreationPhase;
  repoName?: string;
  error?: string;
  /** Renderer-only transition into the non-cancellable post-action refresh. */
  refreshing?: boolean;
}

export interface GenerateCommitMessagesRequest extends GitActionOperationRequest {
  projectId: string;
  worktreeId: string;
  repoIds?: string[];
  /** Generate messages for a local commit without requiring a push target. */
  commitOnly?: boolean;
}

export interface GenerateCommitMessagesRepoResult {
  repoId?: string;
  repoName: string;
  message: string;
}

export interface GenerateCommitMessagesSkippedRepo {
  repoId?: string;
  repoName: string;
  reason: 'no_uncommitted_changes' | 'no_remote_tracking';
}

export interface GenerateCommitMessagesFailedRepo {
  repoId?: string;
  repoName: string;
  error: string;
  appError?: AppError;
}

export interface GenerateCommitMessagesResponse extends GitActionOperationResponse {
  repos: GenerateCommitMessagesRepoResult[];
  skippedRepos: GenerateCommitMessagesSkippedRepo[];
  failedRepos: GenerateCommitMessagesFailedRepo[];
}

export interface CommitAndPushRequest extends GitActionOperationRequest {
  /** Reviewed commits made as preparation for a PR retain their parent flow. */
  telemetryFlow?: 'pull_request';
  /** Original distinct target count retained across scoped retries; analytics only. */
  telemetryRepoCount?: number;
  /** Analytics attribution only; never grants permission. Main defaults to manual. */
  source?: 'manual' | 'chat';
  projectId: string;
  worktreeId: string;
  messages?: Array<{ repoId?: string; repoName: string; message: string }>;
  requireReviewedMessages?: boolean;
  /** Rebase-pull the branch before committing/pushing. */
  pullFirst?: boolean;
  /** Restrict the operation to a specific subset of repos. */
  repoIds?: string[];
  /**
   * Force commit-only behavior even when a remote tracking branch exists.
   * Used for local-only repos and the local-only merge flow.
   */
  commitOnly?: boolean;
  /** Validate the original head before resuming unprepared commits after login. */
  expectedHeadBranch?: string;
  /**
   * Skip a clean repository's pending commits (`commits_not_pushed`) instead
   * of pushing them. A Try again must not push commits on its own.
   */
  skipCleanPush?: boolean;
}

export interface CommitAndPushCommitRepoResult {
  repoId?: string;
  repoName: string;
  commitHash: string;
  status: 'success';
  operation: 'commit' | 'commit_and_push';
}

export interface CommitAndPushPushRepoResult {
  repoId?: string;
  repoName: string;
  status: 'success';
  /**
   * Discriminator describing a successful push of existing commits without
   * creating a new local commit.
   */
  operation: 'push';
}

export type CommitAndPushRepoResult =
  | CommitAndPushCommitRepoResult
  | CommitAndPushPushRepoResult;

export interface CommitAndPushSkippedRepo {
  repoId?: string;
  repoName: string;
  reason:
    | 'no_uncommitted_changes'
    | 'no_remote_tracking'
    | 'commits_not_pushed';
}

export type CommitAndPushFailedRepo = RepoFailureResult;

export interface CommitAndPushAgentResolutionRepo {
  repoId?: string;
  repoName: string;
  chatId: string;
  kind: 'rebase_conflict' | 'stash_pop_conflict';
}

export interface CommitAndPushResponse extends GitActionOperationResponse {
  repos: CommitAndPushRepoResult[];
  skippedRepos: CommitAndPushSkippedRepo[];
  failedRepos: CommitAndPushFailedRepo[];
  agentResolutionRepos: CommitAndPushAgentResolutionRepo[];
}

export interface PushOnlyRequest extends GitActionOperationRequest {
  projectId: string;
  worktreeId: string;
  repoIds?: string[];
  /** Guard a continuation against a changed branch. */
  expectedHeadBranch?: string;
  /** Continue an originally requested rebase-pull before pushing existing commits. */
  pullFirst?: boolean;
  /** Push existing commits with upstream tracking; never stage or commit files. */
  establishUpstream?: boolean;
}

export interface PushOnlyRepoResult {
  repoId?: string;
  repoName: string;
  status: 'success';
}

export interface PushOnlySkippedRepo {
  repoId?: string;
  repoName: string;
  reason: 'no_remote_tracking' | 'no_commits_ahead' | 'no_remote_origin';
}

export type PushOnlyFailedRepo = RepoFailureResult;

export interface PushOnlyResponse extends GitActionOperationResponse {
  repos: PushOnlyRepoResult[];
  skippedRepos: PushOnlySkippedRepo[];
  failedRepos: PushOnlyFailedRepo[];
}

export interface WorktreePullRequest extends GitActionOperationRequest {
  projectId: string;
  worktreeId: string;
}

export interface PullRepoResult {
  repoId?: string;
  repoName: string;
  status: 'success';
}

export interface PullSkippedRepo {
  repoId?: string;
  repoName: string;
  reason: 'no_remote_tracking' | 'not_behind' | 'no_remote_origin';
}

export interface PullFailedRepo {
  repoId?: string;
  repoName: string;
  error: string;
  status: 'failed';
  appError?: AppError;
}

export interface PullAgentResolutionRepo {
  repoId?: string;
  repoName: string;
  chatId: string;
  kind: 'rebase_conflict' | 'stash_pop_conflict';
}

export interface PullResponse extends GitActionOperationResponse {
  repos: PullRepoResult[];
  skippedRepos: PullSkippedRepo[];
  failedRepos: PullFailedRepo[];
  agentResolutionRepos: PullAgentResolutionRepo[];
}

export type CommitPushPhase =
  | 'pulling'
  | 'generating_message'
  | 'staging'
  | 'committing'
  | 'pushing'
  | 'done'
  | 'error';

export interface CommitPushProgressEvent {
  projectId: string;
  worktreeId: string;
  phase: CommitPushPhase;
  repoName?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Split PR: diff model
// ---------------------------------------------------------------------------

export type FileChangeKind = 'added' | 'modified' | 'deleted' | 'renamed';

export interface DiffHunk {
  /** post-image path (old path for deletes) */
  file: string;
  /** 0-based within the file's enumeration */
  hunkIndex: number;
  /** "@@ -a,b +c,d @@ ctx" */
  header: string;
  /** sha256 of ordered +/- core lines only (context excluded) */
  contentHash: string;
  /**
   * Ordered `+`/`-` core lines with prefix characters (context lines and `@@`
   * headers excluded; attached `\ No newline at end of file` markers included
   * so zero-context run bodies survive serialization). This is the matcher's
   * source of truth and MUST survive IPC/JSON round-trips: the snapshot is
   * returned to the renderer in `SplitPrPlanResponse` and received back in
   * `SplitWorkflowApproveRequest.snapshot` before carve-time run matching. Hashing
   * ignores the markers, so `computeHunkIdentity(coreLines) === contentHash`.
   */
  coreLines: string[];
  /** disambiguates identical-content hunks within one file */
  occurrenceIndex: number;
  additions: number;
  deletions: number;
  /** truncated body for planner/UI display */
  preview: string;
}

export interface DiffFileEntry {
  path: string;
  /** renames */
  oldPath?: string;
  kind: FileChangeKind;
  isBinary: boolean;
  /** 0 for binary */
  additions: number;
  /** 0 for binary */
  deletions: number;
  /** empty for binary */
  hunks: DiffHunk[];
}

export interface PrDiffSnapshot {
  /** resolved sha of origin/<base> */
  baseRef: string;
  /** originalHeadSha */
  headRef: string;
  files: DiffFileEntry[];
  totalAdditions: number;
  totalDeletions: number;
}

// ---------------------------------------------------------------------------
// Split PR: planner output
// ---------------------------------------------------------------------------

export interface ChildChange {
  file: string;
  hunks: 'all' | number[];
}

export interface SplitPlanChild {
  /** 1-based */
  index: number;
  /** includes refactor:/feat: prefix */
  title: string;
  type: 'refactor' | 'feature';
  /** lower indices only */
  dependsOn: number[];
  changes: ChildChange[];
  renames: { from: string; to: string }[];
  testProof: string;
  risk: 'low' | 'med' | 'high';
  rationale: string;
}

export interface SplitPlan {
  finalGoal: string;
  concerns: { concern: string; kind: 'refactor' | 'behavior' }[];
  children: SplitPlanChild[];
  parallelizable: string;
  landOrder: string;
  /** '' = none detected */
  buildTestCommand: string;
  /** must be [] */
  unassignedHunks: { file: string; hunkIndex: number }[];
}

// ---------------------------------------------------------------------------
// Split PR: persisted map (spec 02 §2 shapes + carveCommitSha)
// ---------------------------------------------------------------------------

export interface SplitPrChild {
  index: number;
  title: string;
  type: 'refactor' | 'feature';
  branchName: string;
  baseBranch: string;
  dependsOn: number[];
  changes: ChildChange[];
  renames?: { from: string; to: string }[];
  worktreeId?: string;
  prNumber?: number;
  prUrl?: string;
  carveCommitSha?: string;
  verifyStatus?: 'pending' | 'green' | 'red' | 'skipped';
  /**
   * Body produced by the standard PR-generation flow (same rules as the normal
   * "Create PR" action) for this child, WITHOUT the appended stack block.
   * Persisted so the post-creation body-update pass can rebuild
   * `prBodyBase + '\n\n---\n\n' + freshStackBlock` without losing the generated
   * content on resume. New-optional: absent for legacy maps and for children
   * whose generation was unavailable/failed (those fall back to the
   * stack-block-only body). See {@link prTitleGenerated}.
   */
  prBodyBase?: string;
  /**
   * Title produced by the standard PR-generation flow (WITHOUT the `[X/Y]`
   * prefix) for this child. Persisted alongside {@link prBodyBase} so a resume
   * that re-derives the child title uses the same generated text. New-optional:
   * absent for legacy maps and generation-unavailable children.
   */
  prTitleGenerated?: string;
}

export interface SplitPrMap {
  version: 1;
  originalPrNumber: number;
  originalPrUrl: string;
  /** DETECTED, never assumed 'main' */
  originalBaseBranch: string;
  originalHeadBranch: string;
  originalHeadSha: string;
  /**
   * Title of the ORIGINAL pull request being split, captured from pre-flight PR
   * tracking data at map init. The integration PR title is
   * `` `${originalPrTitle} (split)` ``. New-optional: legacy maps predate this
   * field, and resume falls back to the branch-derived title
   * (`` `${originalHeadBranch} (split)` ``) when it is absent.
   */
  originalPrTitle?: string;
  integrationBranch: string;
  integrationPrNumber?: number;
  integrationPrUrl?: string;
  originalWorktreeId: string;
  children: SplitPrChild[];
  buildTestCommand?: string;
  /**
   * Deterministic sha256 fingerprint of the executable plan surface (each
   * child's `{ index, type, dependsOn, changes, renames }` plus the derived
   * INTEGRATION branch name). Only the integration branch name is hashed — it
   * comes from the PR head branch and is title-independent. The per-child
   * derived branch names are intentionally NOT hashed: they are a deterministic
   * function of the child title, so hashing them would make a purely cosmetic
   * title edit look like a carve change. Title/testProof/risk/rationale are
   * likewise excluded because they do not affect the carve. New-optional: old
   * maps predate the field and lack it. On resume with a matching PR+headSha, a
   * mismatch (or a missing fingerprint on an old map) means the approved plan
   * differs from the split already in progress and execution is refused rather
   * than silently running the persisted composition.
   */
  planFingerprint?: string;
  status: 'planning' | 'executing' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;
  updatedAt: string;
  /**
   * Open PRs that were based on the original head branch and were retargeted
   * onto the integration branch during finalize (nested/mid-stack splits).
   */
  retargetedDependentPrs?: {
    prNumber: number;
    prUrl: string;
    headBranch: string;
  }[];
}

export interface SplitPrMapFile {
  version: 1;
  map: SplitPrMap;
}

// ---------------------------------------------------------------------------
// Split PR: IPC request/response types
// ---------------------------------------------------------------------------

export interface SplitPrPlanRequest {
  projectId: string;
  worktreeId: string;
}

export interface SplitPrPlanResponse {
  plan: SplitPlan;
  /** carried so the modal renders hunks without re-gathering */
  snapshot: PrDiffSnapshot;
  originalPr: {
    prNumber: number;
    prUrl: string;
    baseBranch: string;
    headBranch: string;
    headSha: string;
  };
}

/**
 * Machine-readable refusal codes the planner can raise. Shared here (rather
 * than defined only on the main-process `PrSplitPlanningError`) so the IPC
 * boundary and renderer can both depend on the same source of truth instead
 * of a duplicated union that can drift.
 */
export type SplitPrPlanRefusalCode =
  | 'multi_repo_unsupported'
  | 'no_open_pr'
  | 'fork_pr_unsupported'
  | 'head_out_of_sync'
  | 'base_not_ancestor'
  | 'invalid_plan';

/**
 * Discriminated IPC result for `planSplitPr`. Refusals resolve (rather than
 * reject) so the renderer can render a targeted message per `code` (e.g.
 * "push your branch" vs "rebase first") instead of parsing a thrown error
 * string. Unexpected failures still reject the invoke promise.
 */
export type SplitPrPlanResult =
  | { status: 'ok'; response: SplitPrPlanResponse }
  | {
      status: 'refused';
      code: SplitPrPlanRefusalCode;
      message: string;
      /**
       * Deterministic-validation issues for `code: 'invalid_plan'` refusals,
       * forwarded from `PrSplitPlanningError.issues`. Undefined for every
       * other refusal code (those have no per-issue detail to show).
       */
      issues?: SplitPlanIssue[];
    };

/**
 * Machine-readable execute-failure codes. Shared here (rather than defined
 * only on the main-process `SplitPrExecutionError`) so the IPC boundary and
 * renderer can both depend on the same source of truth instead of a
 * duplicated union that can drift. `plan_mismatch` marks the specific
 * refusal raised when a resume's approved plan no longer matches the plan
 * the in-progress split was started from (fingerprint drift); the renderer
 * surfaces the "Discard split state" affordance on this code. Undefined for
 * generic execution failures.
 */
export type SplitPrExecutionErrorCode =
  | 'plan_mismatch'
  | 'checkpoint_write_failed';

/**
 * Discriminated IPC result for a split execute (returned by
 * `approveSplitWorkflow` and `startSplitWorkflow`'s `'resume'` mode), mirroring
 * the `claudeTerminalLaunch` precedent (`ClaudeTerminalLaunchResponse` /
 * `ClaudeTerminalLaunchRejectedResponse` in this same file's neighbors): a
 * classified `SplitPrExecutionError` resolves a `status: 'failed'` envelope
 * instead of rejecting the invoke promise, so the renderer can branch on
 * `code` (e.g. show the Discard affordance for `plan_mismatch`) without
 * parsing a thrown error string. Unexpected/unclassified errors still reject.
 * Cancellation still resolves `status: 'ok'` with the cancelled map, since
 * that is a normal (non-error) terminal outcome.
 */
export type SplitPrExecuteResponse =
  | { status: 'ok'; map: SplitPrMap }
  | {
      status: 'failed';
      code?: SplitPrExecutionErrorCode;
      message: string;
      childIndex?: number;
      verifyTail?: string;
    };

// ---------------------------------------------------------------------------
// Split PR: lockdown workflow IPC (A5)
// ---------------------------------------------------------------------------

/**
 * How `startSplitWorkflow` should behave once it has terminated the worktree's
 * resources and acquired the lock:
 *
 *  - `'plan'` (default): analyze the PR diff and return a fresh plan for review.
 *  - `'resume'`: SKIP planning and execute the caller-supplied stored plan +
 *    snapshot immediately, under the lock, exactly like `approveSplitWorkflow`.
 *    Used by the failure modal's Retry so a failed run re-enters the locked
 *    workflow and resumes from the checkpointed engine map (the engine's
 *    fingerprint gate handles resume-vs-mismatch). Requires `plan`/`snapshot`.
 *  - `'review'`: SKIP planning, just lock, and let the renderer show its stored
 *    plan at the Review step (no LLM re-plan). Used by the failure modal's
 *    "Edit plan" so the user reopens the STORED approved plan for editing.
 */
export type SplitWorkflowStartMode = 'plan' | 'resume' | 'review';

export interface SplitWorkflowStartRequest {
  projectId: string;
  worktreeId: string;
  /** Defaults to `'plan'` (fresh analyze-and-review) when omitted. */
  mode?: SplitWorkflowStartMode;
  /**
   * Stored approved plan for `mode: 'resume'` (the same shape `approve` takes).
   * Ignored for `'plan'`/`'review'`. Absent for those modes.
   */
  plan?: SplitPlan;
  /** Stored snapshot for `mode: 'resume'`. See {@link plan}. */
  snapshot?: PrDiffSnapshot;
}

/**
 * Discriminated result of `startSplitWorkflow`, tagged by the `mode` the start
 * ran in so the renderer can branch without guessing:
 *
 *  - `'plan'` resolves a `SplitPrPlanResult` (fresh plan for review, or a
 *    planning refusal).
 *  - `'review'` resolves `{ status: 'locked' }` on success (the handler just
 *    locks and returns — the plan the renderer shows at Review is its own
 *    stored `splitPrPlans[key]`, not re-sent over IPC) or a `SplitLockError`
 *    reject if the lock could not be acquired.
 *  - `'resume'` resolves a `SplitPrExecuteResponse` — the execute envelope
 *    shape `approveSplitWorkflow` returns.
 */
export type SplitWorkflowStartResult =
  | { mode: 'plan'; result: SplitPrPlanResult }
  | { mode: 'review'; result: { status: 'locked' } }
  | { mode: 'resume'; result: SplitPrExecuteResponse };

export interface SplitWorkflowApproveRequest {
  projectId: string;
  worktreeId: string;
  plan: SplitPlan;
  snapshot: PrDiffSnapshot;
}

export interface SplitWorkflowExitRequest {
  projectId: string;
  worktreeId: string;
}

/**
 * Broadcast on every split lock transition for a worktree. The renderer mirror
 * (`onSplitLockChange`) uses this to maintain its `splitLockedWorktrees` set so
 * lock-aware affordances update live without polling.
 */
export interface SplitLockChangeEventPayload {
  workspaceId: string;
  worktreeId: string;
  locked: boolean;
}

/**
 * Snapshot of currently held split locks. The renderer queries this once when
 * wiring the `onSplitLockChange` subscription so its mirrored
 * `splitLockedWorktrees` set is seeded truthfully after a reload/crash, rather
 * than starting empty and relying only on future change events.
 *
 * `executing` reports whether a main-side split EXECUTE is currently in flight
 * for that lock (from the abort-controller registry). After a reload during
 * execute, only the lock survives — `splittingPr` is empty, so the workflow
 * view would wrongly derive the Plan step. The renderer seeds `splittingPr`
 * for executing entries on hydration so the view lands on Execute.
 */
export interface SplitLockStateResponse {
  locked: Array<{
    workspaceId: string;
    worktreeId: string;
    executing: boolean;
  }>;
}

export interface SplitPrCancelRequest {
  projectId: string;
  worktreeId: string;
}

export interface SplitPrDiscardRequest {
  projectId: string;
  worktreeId: string;
}

/**
 * Result of discarding a persisted split map. v1 does NOT perform any
 * destructive git/GitHub cleanup — the discarded map's already-created branches
 * and PR numbers are returned so the user can clean them up manually if they
 * wish. Empty arrays when there was no map to discard.
 */
export interface SplitPrDiscardResponse {
  branches: string[];
  prNumbers: number[];
}

export type SplitPrPhase =
  | 'gathering_diff'
  | 'planning'
  | 'creating_integration_branch'
  | 'running_setup'
  | 'carving_child'
  | 'verifying_child'
  | 'opening_child_pr'
  | 'reconstructing_tip'
  | 'opening_integration_pr'
  | 'updating_pr_bodies'
  | 'retargeting_original'
  | 'retargeting_dependents'
  | 'closing_original'
  | 'done'
  | 'error'
  | 'cancelled';

export interface SplitPrProgressEvent {
  projectId: string;
  worktreeId: string;
  phase: SplitPrPhase;
  childIndex?: number;
  childTotal?: number;
  message?: string;
  error?: string;
}

/**
 * Reasons the split-PR workflow cannot safely start for an otherwise
 * eligible worktree. Declaration order is also the stable display order used
 * by the renderer's `deriveSplitPrReadiness` (`@/lib/splitPrEligibilityInputs`,
 * which re-exports this type) and the `worktree.pullRequest` App Advisor
 * UI-state slice (`AppAdvisorUiStateSnapshot.pullRequest.splitPrBlockers`).
 * Shared here (rather than renderer-local) so both the renderer hook and the
 * cross-environment snapshot type can reference the same closed set.
 */
export type SplitPrBlocker =
  | 'uncommitted_changes'
  | 'unpushed_commits'
  | 'merge_conflicts'
  | 'active_pipelines'
  | 'active_chats';

/**
 * Plain-language, brand-safe copy for each blocker. Rendered as tooltip/menu
 * text by the split-PR status bar button and preflight surfaces (Task A3).
 */
export const SPLIT_PR_BLOCKER_COPY: Record<SplitPrBlocker, string> = {
  uncommitted_changes: 'Commit or discard local changes first',
  unpushed_commits: 'Push local commits first',
  merge_conflicts: 'Resolve the merge conflicts reported by GitHub first',
  active_pipelines: 'Wait for active workflows to finish',
  active_chats: 'Wait for active agent chats to finish',
};

// ---------------------------------------------------------------------------
// GitHub PR Snapshot types (versioned, persisted)
// ---------------------------------------------------------------------------

export interface GitHubActorSnapshot {
  login: string;
  id: number | null;
  nodeId: string | null;
  htmlUrl: string | null;
  apiUrl: string | null;
}

export interface GitHubLabelSnapshot {
  id: number;
  nodeId: string | null;
  name: string;
  color: string;
  description: string | null;
}

export interface GitHubIssueCommentSnapshot {
  id: number;
  nodeId: string | null;
  htmlUrl: string | null;
  apiUrl: string | null;
  author: GitHubActorSnapshot | null;
  authorAssociation: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface GitHubReviewSnapshot {
  id: number;
  nodeId: string | null;
  htmlUrl: string | null;
  apiUrl: string | null;
  author: GitHubActorSnapshot | null;
  state: string;
  body: string;
  commitId: string | null;
  submittedAt: string | null;
}

export interface GitHubReviewCommentSnapshot {
  id: number;
  nodeId: string | null;
  htmlUrl: string | null;
  apiUrl: string | null;
  pullRequestReviewId: number | null;
  inReplyToId: number | null;
  author: GitHubActorSnapshot | null;
  authorAssociation: string | null;
  body: string;
  path: string;
  commitId: string | null;
  originalCommitId: string | null;
  diffHunk: string | null;
  line: number | null;
  originalLine: number | null;
  startLine: number | null;
  originalStartLine: number | null;
  side: string | null;
  startSide: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GitHubCheckSnapshot {
  id: number;
  name: string;
  appSlug: string | null;
  appName: string | null;
  status: CheckStatus;
  rawStatus: string;
  conclusion: string | null;
  detailsUrl: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface GitHubMergeConflictSnapshot {
  hasConflicts: boolean;
  mergeable: boolean | null;
  mergeableState: string | null;
}

export interface PersistedPrSnapshotFileV1 {
  version: 1;
  provider: 'github';
  capturedAt: string;
  /** Opaque account and credential that fetched this snapshot; absent on legacy files. */
  credentialScope?: string;
  includesComments: boolean;
  includesReviews: boolean;
  includesReviewComments: boolean;
  repository: {
    owner: string;
    name: string;
    fullName: string;
  };
  branch: {
    currentName: string;
    headRefName: string;
    baseRefName: string;
    headSha: string;
    baseSha: string | null;
  };
  pr: {
    id: number;
    number: number;
    nodeId: string | null;
    htmlUrl: string;
    apiUrl: string | null;
    state: 'open' | 'closed' | 'merged' | 'draft';
    isDraft: boolean;
    title: string;
    body: string;
    author: GitHubActorSnapshot | null;
    createdAt: string;
    updatedAt: string;
    mergedAt: string | null;
    closedAt: string | null;
    mergeCommitSha: string | null;
    mergedBy: GitHubActorSnapshot | null;
    isCrossRepository: boolean;
    labels: GitHubLabelSnapshot[];
    assignees: GitHubActorSnapshot[];
    requestedReviewers: GitHubActorSnapshot[];
  };
  issueComments: GitHubIssueCommentSnapshot[];
  reviews: GitHubReviewSnapshot[];
  reviewComments: GitHubReviewCommentSnapshot[];
  checks?: {
    headSha: string;
    items: GitHubCheckSnapshot[];
  };
  mergeConflicts?: GitHubMergeConflictSnapshot;
  /** Read for open and draft PRs, so a draft conversion can report a dequeue; older snapshots omit it. */
  mergeQueue?: PrMergeQueueSnapshot;
}

// ---------------------------------------------------------------------------
// PR tracking state
// ---------------------------------------------------------------------------

export interface PrTrackingStateFile {
  version: 1;
  branchName: string;
  syncedAt: string;
  currentPrId: number | null;
  snapshotCompleteness: {
    includesComments: boolean;
    includesReviews: boolean;
    includesReviewComments: boolean;
  };
}

// ---------------------------------------------------------------------------
// Richer repo fetch result
// ---------------------------------------------------------------------------

export interface RepoPrTrackingData {
  status: PrStatusData | null;
  snapshot: PersistedPrSnapshotFileV1 | null;
  branchName: string;
  remote: { owner: string; repo: string } | null;
}

// ---------------------------------------------------------------------------
// Local-only merge flow
// ---------------------------------------------------------------------------

export interface MergeLocalBranchesRequest extends GitActionOperationRequest {
  projectId: string;
  worktreeId: string;
  repoIds?: string[];
}

export interface MergeLocalBranchRepoResult {
  repoId?: string;
  repoName: string;
  branchName: string;
  baseBranch: string;
  mergeCommitHash: string;
  status: 'success';
}

export interface MergeLocalBranchSkippedRepo {
  repoId?: string;
  repoName: string;
  reason:
    | 'has_remote_origin'
    | 'missing_base_branch'
    | 'same_branch'
    | 'uncommitted_changes'
    | 'no_commits_ahead';
}

export interface MergeLocalBranchFailedRepo {
  repoId?: string;
  repoName: string;
  branchName?: string;
  baseBranch?: string;
  error: string;
  status: 'failed';
  appError?: AppError;
}

export interface MergeLocalBranchesResponse extends GitActionOperationResponse {
  repos: MergeLocalBranchRepoResult[];
  skippedRepos: MergeLocalBranchSkippedRepo[];
  failedRepos: MergeLocalBranchFailedRepo[];
}

// ---------------------------------------------------------------------------
// Update PR base branch
// ---------------------------------------------------------------------------

export interface UpdatePrBaseBranchRequest {
  projectId: string;
  worktreeId: string;
  repoId?: string;
  prNumber: number;
  newBaseBranch: string;
}

export interface UpdatePrBaseBranchResponse {
  success: boolean;
  prUrl: string;
}

// ---------------------------------------------------------------------------
// PR merge (GitHub API) flow
// ---------------------------------------------------------------------------

export type PrMergeMethod = 'merge' | 'squash' | 'rebase';

export interface MergePrRequest extends GitActionOperationRequest {
  /** Analytics attribution only; never grants permission. Main defaults to manual. */
  source?: 'manual' | 'chat';
  projectId: string;
  worktreeId: string;
  /**
   * Restrict the merge to a specific subset of repos. When omitted, every repo
   * in the worktree with an open, ready-to-merge PR is considered.
   */
  repoIds?: string[];
  /** Optional displayed identity that must still match before mutation. */
  expectedBaseBranch?: string;
  expectedHeadBranch?: string;
  expectedPrNumber?: number;
  /**
   * When false, repos whose PR has unresolved review threads are reported in
   * `requiresUnresolvedConfirmation` instead of being merged. The renderer sets
   * this true after the user confirms via the warning modal.
   */
  confirmUnresolvedComments?: boolean;
  /**
   * When true, only the fresh GitHub verification is performed (no merge). Used
   * to populate the multi-repo merge modal with up-to-date per-repo state.
   */
  dryRun?: boolean;
}

/** Per-repo fresh verification state used to render merge UI. */
export interface MergePrVerifiedRepo {
  /** Fresh detection that the PR base requires a merge queue. */
  usesMergeQueue?: boolean;
  /**
   * Merge hands this PR to an agent chat, per the merge queue setting and
   * hooks. False when a merge queue PR is added to the queue directly.
   */
  startsAgentChat?: boolean;
  repoId?: string;
  repoName: string;
  prNumber: number;
  prUrl: string;
  /** Eligible for this merge action: direct merging or a queue chat handoff. */
  mergeable: boolean;
  unresolvedReviewThreadCount: number | undefined;
  /** Present when the repo's PR is not currently mergeable. */
  blockedReason?: MergePrBlockedReason;
}

/**
 * Why a verified PR was not merged. `in_merge_queue` means the PR is already
 * in its base branch's merge queue, so there is nothing to merge or enqueue.
 */
export type MergePrBlockedReason =
  | 'not_mergeable'
  | 'has_conflicts'
  | 'base_changed'
  | 'in_merge_queue';

/**
 * Outcome of a successful merge request for one repo. `merged` means GitHub
 * merged the PR; `enqueued` means the base branch requires a merge queue and
 * the PR was added to it (GitHub merges it once the queue's checks pass).
 */
export type MergePrRepoOutcome = 'merged' | 'enqueued';

export interface MergePrRepoResult {
  repoId?: string;
  repoName: string;
  prNumber: number;
  prUrl: string;
  /**
   * The repo's preferred method. Informational only for `enqueued` results:
   * the merge queue's own configuration decides how the PR lands.
   */
  mergeMethod: PrMergeMethod;
  /** Null for `enqueued` results, which have not merged yet. */
  mergeCommitSha: string | null;
  status: MergePrRepoOutcome;
  /** 1-based merge queue position for `enqueued` results, when known. */
  queuePosition?: number | null;
}

/** Repo whose PR was not merged solely because it has unresolved review threads. */
export interface MergePrUnresolvedRepo {
  repoId?: string;
  repoName: string;
  prNumber: number;
  prUrl: string;
  unresolvedReviewThreadCount: number | undefined;
}

export interface MergePrFailedRepo {
  repoId?: string;
  repoName: string;
  prNumber?: number;
  error: string;
  status: 'failed';
  appError?: AppError;
}

/** A successful chat handoff; it does not mean the PR was enqueued or merged. */
export interface MergePrQueueChatResult {
  repoId?: string;
  repoName: string;
  prNumber: number;
  prUrl: string;
  chatId: string;
}

export interface MergePrResponse extends GitActionOperationResponse {
  dryRun: boolean;
  /** Every repo in scope that currently has an open PR, with fresh state. */
  verifiedRepos: MergePrVerifiedRepo[];
  /**
   * Repos merged or added to a merge queue during this call (empty on dry
   * runs). Check each entry's `status` to tell the two outcomes apart.
   */
  mergedRepos: MergePrRepoResult[];
  /** Opened merge queue chats (empty on dry runs); optional for older callers. */
  mergeQueueChats?: MergePrQueueChatResult[];
  /** Repos held back pending unresolved-comment confirmation. */
  requiresUnresolvedConfirmation: MergePrUnresolvedRepo[];
  /** Repos whose merge attempt or queue chat launch failed. */
  failedRepos: MergePrFailedRepo[];
}

export type MergePrPhase =
  | 'queued'
  | 'checking_mergeability'
  | 'waiting_mergeability'
  | 'merging'
  | 'refreshing_pr_status'
  | 'done'
  | 'error';

export interface MergePrProgressEvent {
  projectId: string;
  worktreeId: string;
  repoId?: string;
  repoName?: string;
  phase: MergePrPhase;
  queuePosition?: number;
  queueLength?: number;
  retryDelayMs?: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Merge conflict resolution chat
// ---------------------------------------------------------------------------

export interface StartMergeConflictResolutionRequest {
  projectId: string;
  worktreeId: string;
  /** Repo id whose worktree cwd should be selected for the resolution chat. */
  repoId?: string;
  /** Best-effort repo name for the chat marker banner. */
  repoName?: string;
  /** Best-effort branch name for the chat marker banner. */
  branchName?: string;
}

export interface StartMergeConflictResolutionResponse {
  chatId: string;
}

// ---------------------------------------------------------------------------
// PR review comment triage chat
// ---------------------------------------------------------------------------

export interface StartPrCommentTriageRequest {
  projectId: string;
  worktreeId: string;
  /** Repo id whose worktree cwd should be selected for the triage chat. */
  repoId?: string;
  /** Best-effort repo name for the chat marker banner. */
  repoName?: string;
  /** Best-effort branch name for the chat marker banner. */
  branchName?: string;
}

export interface StartPrCommentTriageResponse {
  chatId: string;
}

// ---------------------------------------------------------------------------
// CI check fix chat
// ---------------------------------------------------------------------------

export interface StartCiCheckFixRequest {
  projectId: string;
  worktreeId: string;
  /** Repo id whose worktree cwd should be selected for the CI fix chat. */
  repoId?: string;
  /** Best-effort repo name for the chat marker banner. */
  repoName?: string;
  /** Best-effort branch name for the chat marker banner. */
  branchName?: string;
}

export interface StartCiCheckFixResponse {
  chatId: string;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Check aggregation and merge readiness live in `@canopy/protocol` so the
 * cloud server shares them (REG-3025). `PrStatusData` satisfies their input.
 */
export {
  aggregateCheckStatus,
  isPrInMergeQueue,
  isPrReadyToMerge,
} from '@canopy/protocol/pull-requests';

/**
 * Whether Merge hands a pull request on a merge queue to an agent chat that
 * runs the `merge-pr` skill (Settings > Git > Merge queue):
 * - `always`: every merge-queue merge starts the chat.
 * - `when_hook_absent`: the chat starts unless the worktree would run a
 *   configured, unpaused `pr:queue:removed` hook for the PR's repository.
 * - `never`: Merge adds the pull request to the merge queue directly.
 */
export type MergeQueueAgentHandling = 'always' | 'when_hook_absent' | 'never';

export const MERGE_QUEUE_AGENT_HANDLING_VALUES: readonly MergeQueueAgentHandling[] =
  ['always', 'when_hook_absent', 'never'];

export const DEFAULT_MERGE_QUEUE_AGENT_HANDLING: MergeQueueAgentHandling =
  'when_hook_absent';

export function isMergeQueueAgentHandling(
  value: unknown,
): value is MergeQueueAgentHandling {
  return MERGE_QUEUE_AGENT_HANDLING_VALUES.some((mode) => mode === value);
}

/**
 * Pure merge-route decision shared by the renderer's Merge button and the
 * main-process merge handler. Only a PR whose base branch is known to require
 * a merge queue can start a chat; unknown detection keeps the direct path.
 */
export function prMergeStartsAgentChat(args: {
  status: Pick<PrStatusData, 'mergeQueue'>;
  handling: MergeQueueAgentHandling;
  /** A configured, unpaused `pr:queue:removed` hook covers this repository. */
  queueRemovedHookActive: boolean;
}): boolean {
  if (args.status.mergeQueue?.required !== true) return false;
  switch (args.handling) {
    case 'always':
      return true;
    case 'never':
      return false;
    case 'when_hook_absent':
      return !args.queueRemovedHookActive;
  }
}

/** True when the PR is open and has at least one unresolved review thread. */
export function hasUnresolvedReviewThreads(
  status: Pick<PrStatusData, 'state' | 'unresolvedReviewThreadCount'>,
): boolean {
  return (
    status.state === 'open' && (status.unresolvedReviewThreadCount ?? 0) > 0
  );
}

export interface GitHubApi {
  createPr(req: CreatePrRequest): Promise<CreatePrResponse>;
  requestPrStatusRefresh(req: {
    projectId: string;
    worktreeId: string;
  }): Promise<void>;
  requestFastRefresh(req: {
    projectId: string;
    worktreeId: string;
    skipIfFresh?: boolean;
  }): Promise<void>;
  requestKnownPrFastRefresh(req: {
    projectId: string;
    worktreeId: string;
  }): Promise<boolean>;
  setForegroundWorktree(req: {
    projectId: string | null;
    worktreeId: string | null;
  }): Promise<void>;
  onPrStatusUpdate(cb: (event: PrStatusEvent) => void): () => void;
  onDependentBaseBranchesUpdated(
    cb: (event: DependentBaseBranchesUpdatedEvent) => void,
  ): () => void;
  /** Subscribe to generic GitHub primary/secondary throttling events. */
  onGitHubRateLimitError(cb: (event: GitHubRateLimitEvent) => void): () => void;
  onPrCreationProgress(
    cb: (event: PrCreationProgressEvent) => void,
  ): () => void;
  generateCommitMessages(
    req: GenerateCommitMessagesRequest,
  ): Promise<GenerateCommitMessagesResponse>;
  cancelGitAction(
    req: CancelGitActionRequest,
  ): Promise<CancelGitActionResponse>;
  commitAndPush(req: CommitAndPushRequest): Promise<CommitAndPushResponse>;
  pushOnly(req: PushOnlyRequest): Promise<PushOnlyResponse>;
  pull(req: WorktreePullRequest): Promise<PullResponse>;
  onCommitPushProgress(
    cb: (event: CommitPushProgressEvent) => void,
  ): () => void;
  onMergePrProgress(cb: (event: MergePrProgressEvent) => void): () => void;
  updatePrBaseBranch(
    req: UpdatePrBaseBranchRequest,
  ): Promise<UpdatePrBaseBranchResponse>;
  mergeLocalBranches(
    req: MergeLocalBranchesRequest,
  ): Promise<MergeLocalBranchesResponse>;
  mergePr(req: MergePrRequest): Promise<MergePrResponse>;
  startMergeConflictResolution(
    req: StartMergeConflictResolutionRequest,
  ): Promise<StartMergeConflictResolutionResponse>;
  startPrCommentTriage(
    req: StartPrCommentTriageRequest,
  ): Promise<StartPrCommentTriageResponse>;
  startCiCheckFix(
    req: StartCiCheckFixRequest,
  ): Promise<StartCiCheckFixResponse>;
  planSplitPr(request: SplitPrPlanRequest): Promise<SplitPrPlanResult>;
  /**
   * Lockdown-aware entry point for a split. Terminates the worktree's running
   * resources (terminals, browsers, scripts) and acquires the split lock, then
   * branches on `request.mode`:
   *
   *  - `'plan'` (default): plans; a refusal/failure releases the lock before
   *    returning/rejecting, a successful plan KEEPS the lock for review.
   *  - `'resume'`: executes the caller-supplied stored plan+snapshot under the
   *    lock exactly like `approveSplitWorkflow` (releases the lock on settle).
   *  - `'review'`: just locks and returns `{ status: 'locked' }` (the renderer
   *    keeps its stored plan for the Review step; a `SplitLockError` reject
   *    releases nothing it did not take).
   *
   * The result is tagged by mode (`SplitWorkflowStartResult`) so the renderer
   * can dispatch without inspecting which payload shape came back.
   */
  startSplitWorkflow(
    request: SplitWorkflowStartRequest,
  ): Promise<SplitWorkflowStartResult>;
  /**
   * Execute an approved plan. Requires the worktree to be locked (rejects with
   * the typed lock error otherwise) and ALWAYS releases the lock on settle
   * (success/failed/cancelled envelopes and rejects).
   */
  approveSplitWorkflow(
    request: SplitWorkflowApproveRequest,
  ): Promise<SplitPrExecuteResponse>;
  /**
   * User-initiated cancel/close during plan/review. Cancels any in-flight
   * execute, releases the lock, and broadcasts.
   */
  exitSplitWorkflow(request: SplitWorkflowExitRequest): Promise<void>;
  onSplitLockChange(
    callback: (event: SplitLockChangeEventPayload) => void,
  ): () => void;
  /**
   * Snapshot of the currently held split locks. Queried once when wiring the
   * change subscription so the renderer seeds its mirrored set truthfully after
   * a reload/crash instead of starting empty.
   */
  getSplitLockState(): Promise<SplitLockStateResponse>;
  cancelSplitPr(request: SplitPrCancelRequest): Promise<void>;
  discardSplitPr(
    request: SplitPrDiscardRequest,
  ): Promise<SplitPrDiscardResponse>;
  onSplitPrProgress(
    callback: (event: SplitPrProgressEvent) => void,
  ): () => void;
  getSplitPrMap(request: {
    projectId: string;
    worktreeId: string;
  }): Promise<SplitPrMap | null>;
  /** Read a branch's merge queue; served from a short shared cache. */
  getMergeQueue(
    request: GitHubMergeQueueRequest,
  ): Promise<GitHubMergeQueueResponse>;
}
