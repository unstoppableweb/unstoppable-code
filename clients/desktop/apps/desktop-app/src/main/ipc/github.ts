import {
  recordGitCommitTelemetry,
  recordPullRequestOpenedTelemetry,
  recordPullRequestMergedTelemetry,
  type GitShippingTelemetryInput,
} from '../lib/desktop-telemetry';
import { pushBranchWithAuthFailure } from '../lib/github-push';
import {
  classifyGitHubAuthFailure,
  GitHubAuthFailureError,
  githubAuthFailureCode,
} from '../lib/github-push-auth-failure';
import { registerWorktreePrActions } from '../services/pr-worktree-actions';
import type {
  PortalPrCreateBlockedReason,
  PortalPrMergeBlockedReason,
  PortalPullRequestRepoStatus,
} from '@canopy/protocol/portal';
import {
  beginPrMergeProgress,
  recordPrMergeProgress,
  finishPrMergeProgress,
} from '../services/pr-merge-progress';
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { basename, join } from 'node:path';
import {
  requireProviderForModel,
  IPC_CHANNELS,
  SINGLE_REPO_USAGE_REPO_ID,
  WORKSPACE_ROOT_REPO_ID,
  type GitHubRepoSummary,
  type PreferencesData,
  type ChatTabPluginSelections,
  type ThinkingLevel,
  type PrInstructionMode,
  type ResolvePullRequestRequest,
  type ResolvePullRequestResponse,
  type ListPullRequestsRequest,
  type ListPullRequestsResponse,
  type SearchPullRequestsResponse,
  type GetRepoSlugRequest,
  type GetRepoSlugResponse,
  type PortalPullRequestState,
} from '@canopy/desktop-shared/types';
import { NoDispatchableModelError } from '../lib/default-model-lane-resolver';
import type {
  CreatePrRequest,
  CreatePrLocalCommitResult,
  CreatePrResponse,
  CreatePrRepoResult,
  RepoFailureResult,
  PrCreationPhase,
  PrCreationProgressEvent,
  SkippedRepo,
  CommitAndPushRequest,
  CommitAndPushResponse,
  CommitAndPushRepoResult,
  CommitAndPushSkippedRepo,
  CommitAndPushFailedRepo,
  CommitPushPhase,
  CommitPushProgressEvent,
  GenerateCommitMessagesRequest,
  GenerateCommitMessagesResponse,
  GenerateCommitMessagesRepoResult,
  GenerateCommitMessagesSkippedRepo,
  GenerateCommitMessagesFailedRepo,
  PushOnlyRequest,
  PushOnlyResponse,
  PushOnlyRepoResult,
  PushOnlySkippedRepo,
  WorktreePullRequest,
  PullResponse,
  PullRepoResult,
  PullSkippedRepo,
  PullAgentResolutionRepo,
  CommitAndPushAgentResolutionRepo,
  MergeLocalBranchesRequest,
  MergeLocalBranchesResponse,
  MergeLocalBranchRepoResult,
  MergeLocalBranchSkippedRepo,
  MergeLocalBranchFailedRepo,
  MergePrRequest,
  MergePrResponse,
  MergePrQueueChatResult,
  PrStatusData,
  MergePrVerifiedRepo,
  MergePrRepoResult,
  MergePrUnresolvedRepo,
  MergePrFailedRepo,
  MergePrProgressEvent,
  StartMergeConflictResolutionRequest,
  StartMergeConflictResolutionResponse,
  StartPrCommentTriageRequest,
  StartPrCommentTriageResponse,
  StartCiCheckFixRequest,
  StartCiCheckFixResponse,
  UpdatePrBaseBranchRequest,
  UpdatePrBaseBranchResponse,
  SplitPrPlanRequest,
  SplitPrPlanResult,
  SplitPrExecuteResponse,
  SplitPrCancelRequest,
  SplitPrDiscardRequest,
  SplitPrDiscardResponse,
  SplitPrMap,
  SplitPrProgressEvent,
  SplitWorkflowStartRequest,
  SplitWorkflowStartResult,
  SplitWorkflowApproveRequest,
  SplitWorkflowExitRequest,
  SplitLockChangeEventPayload,
  SplitLockStateResponse,
  CancelGitActionRequest,
  CancelGitActionResponse,
  GitActionOperationRequest,
  GitHubMergeQueueRequest,
  GitHubMergeQueueResponse,
} from '@canopy/desktop-shared/types/github';
import {
  DEFAULT_MERGE_QUEUE_AGENT_HANDLING,
  isMergeQueueAgentHandling,
  isPrInMergeQueue,
  isPrReadyToMerge,
  prMergeStartsAgentChat,
  type MergeQueueAgentHandling,
} from '@canopy/desktop-shared/types/github';
import {
  beginPrCreationProgress,
  cancelPrCreationProgress,
  recordPrCreationProgress,
} from '../services/pr-creation-progress';
import {
  projectPortalPrStatus,
  refreshPullRequestState,
  registerPortalPrStatusProjection,
} from '../services/pr-service';
import {
  launchMergeConflictResolutionChat,
  launchPrCommentTriageChat,
  launchCiCheckFixChat,
  launchMergeQueueChat,
} from '../lib/builtin-gh-chat';
import { validateId } from '../lib/validation';
import { assertWritableScope } from '../lib/read-only-scope';
import { handleSearchPullRequestsRequest } from './github-pr-search';
import {
  getRepoSlugForIpc,
  listPullRequestsForIpc,
  listUserReposForIpc,
  getMergeQueueForIpc,
  resolvePullRequestForIpc,
  type GitHubPullRequestIpcDispatcher,
} from '../canopy-runtime/github-pull-request-dispatch';
import {
  createPullRequestDirectly,
  dispatchedPullRequestCreate,
  dispatchedPullRequestMerge,
  mergePullRequestDirectly,
  type PullRequestMergeStep,
  updatePullRequestBaseForIpc,
  type PullRequestCreateStep,
} from '../canopy-runtime/github-pull-request-write-dispatch';
import type { DesktopIpcCallerResolver } from './file-tree';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { listWorkspaceWorktreeRepoEntries } from '../lib/worktree-repo-entries';
import { readWorkspaceConfig } from '../lib/workspace-persistence';
import { isMultiRepoWorkspace } from '../lib/workspace-registry';
import {
  getCurrentBranch,
  getAheadBehindCounts,
  getDiffStats,
  getFullDiff,
  getCommitLog,
  fetchOrigin,
  getRemoteUrl,
  hasAutostashEntry,
  hasUnmergedPaths,
  hasUncommittedChanges,
  hasCommitsAhead,
  readBranchPublication,
  hasRemoteTrackingBranch,
  hasUnpulledCommits,
  hasUnpushedCommits,
  isRebaseInProgress,
  stageAllChanges,
  commitWithMessage,
  getUncommittedDiff,
} from '../lib/git';
import { getSharedContainerPublishScheduler } from '../shared-containers/publish/scheduler';
import {
  resolveEffectiveBaseBranchForRepo,
  resolveRepoDefaultBranch,
} from '../lib/worktree-base-branches';
import type { RebaseResolutionKind } from '../lib/rebase-resolution-chat';
import {
  fetchRepoPrTrackingData,
  parseGitHubRemote,
  PR_MERGE_RETRY_DELAYS_MS,
} from '../lib/github-pr';
import { isPrBaseBranchCreationError } from '../lib/github-pr-rejections';
import { generatePrContent } from '../lib/github-pr-generator';
import { generateCommitMessage } from '../lib/commit-message-generator';
import {
  resolveCommitGenerationModelCandidates,
  type CommitGenerationModelPlan,
} from '../lib/commit-generation-model-candidates';
import { logMainProcessWarn } from '../lib/main-process-logging';
import {
  requestRefresh,
  enqueueFastRefresh,
  enqueueKnownPrFastRefresh,
  isPrHookActiveForRepo,
  refreshNow,
  setForegroundWorktree,
  startPolling,
  suspendTrackingForE2e,
} from '../lib/github-poller';
import { getGitHubBroker } from '../lib/github-broker';
import { sendToWindow } from '../lib/window-send';
import { readPreferencesFile } from './preferences';
import { registerIpcHandler } from './register';
import {
  isGitActionActive,
  finishGitActionCancellationScope,
  GitActionCancelledError,
  isGitActionCancelledError,
  requestGitActionCancellation,
  type GitActionCancellationScope,
} from './git-action-cancellation';
import { triggerWorktreePrecommitFailureHook } from '../lib/worktree-precommit-failure-hook';
import { getExecutionObservabilityIngest } from '../observability/ingest';
import { planPrSplit, PrSplitPlanningError } from '../lib/pr-split-planner';
import {
  executePrSplit,
  SplitPrExecutionError,
} from '../lib/github-pr-splitter';
import {
  deleteSplitPrMapForWorktree,
  readSplitPrMap,
} from '../lib/split-pr-persistence';
import {
  acquireSplitLock,
  releaseSplitLock,
  isSplitLocked,
  onSplitLockChange,
  releaseIdleSplitLocks,
  getSplitLockedWorktrees,
  SplitLockError,
  SplitStartBlockedError,
} from '../services/split-lock-service';
import { beginExclusiveGitAction } from '../services/git-action-exclusion';
import { isSplitTemporaryWorkspaceInFlight } from '../lib/split-temporary-workspace';
import { workerTerminal } from '../terminal/worker-terminal';
import { getBrowserService } from '../browser/browser-service-registry';
import { stopWorktreeScripts } from '../services/scripts-service';
import { stopHooksForWorktree } from '../lib/hook-runner';
import {
  clearSplitPrRuntimeProjection,
  projectSplitPrProgress,
  setSplitPrRuntimeProjection,
} from '../services/split-pr-runtime-projection';
import { hasActiveChatWorkForWorktree } from '../agents/session-manager';
import { listExecutionSummaries } from '@canopy/execution-engine/node/pipelines/executor/execution-state';
import { getDataDir } from '../lib/paths';
import {
  mergeWorktreeRepository,
  fetchWorktreeRepository,
  pullWorktreeRepository,
} from '../canopy-runtime/worker-git-sync-dispatch';
import type { WorkerGitMergeDispatcher } from '../canopy-runtime/worker-git-merge-adapter';
import type { WorkerGitSyncDispatcher } from '../canopy-runtime/worker-git-sync-adapter';
import type {
  WorkerGitCommitPushDispatcher,
  GitCommitPhases,
} from '../canopy-runtime/worker-git-commit-push-adapter';
import {
  commitWorktreeRepository,
  pushWorktreeRepository,
} from '../canopy-runtime/worker-git-commit-push-dispatch';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function scheduleSharedContainerPublicationAfterPush(
  projectId: string,
  worktreeId: string,
): Promise<void> {
  try {
    await getSharedContainerPublishScheduler().scheduleKnown(
      projectId,
      worktreeId,
    );
  } catch (error) {
    logMainProcessWarn(
      '[shared-containers] publication scheduling after push failed',
      {
        projectId,
        worktreeId,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

async function getGithubRepoMergeQueueKey(repoPath: string): Promise<string> {
  const remoteUrl = await getRemoteUrl(repoPath);
  if (!remoteUrl) {
    throw new Error(`No remote URL found for repository at ${repoPath}`);
  }
  const remote = parseGitHubRemote(remoteUrl);
  if (!remote) {
    throw new Error(
      `Could not parse GitHub remote URL: "${remoteUrl}" (repoPath: ${repoPath})`,
    );
  }
  return `${remote.owner.toLowerCase()}/${remote.repo.toLowerCase()}`;
}

interface QueuedPrMergeJob {
  run: () => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
  onQueuePosition: (position: number, length: number) => void;
  unsubscribeCancellation: () => void;
}

interface PrMergeQueue {
  active?: QueuedPrMergeJob;
  pending: QueuedPrMergeJob[];
}

const prMergeQueues = new Map<string, PrMergeQueue>();

function notifyPrMergeQueue(queue: PrMergeQueue): void {
  const queueLength = queue.pending.length + (queue.active ? 1 : 0);
  queue.pending.forEach((job, index) => {
    job.onQueuePosition(index + (queue.active ? 2 : 1), queueLength);
  });
}

function drainPrMergeQueue(queueKey: string): void {
  const queue = prMergeQueues.get(queueKey);
  if (!queue || queue.active) return;

  const next = queue.pending.shift();
  if (!next) {
    prMergeQueues.delete(queueKey);
    return;
  }

  queue.active = next;
  next.unsubscribeCancellation();
  notifyPrMergeQueue(queue);
  void next
    .run()
    .then(next.resolve, next.reject)
    .finally(() => {
      const latestQueue = prMergeQueues.get(queueKey);
      if (!latestQueue) return;
      latestQueue.active = undefined;
      notifyPrMergeQueue(latestQueue);
      drainPrMergeQueue(queueKey);
    });
}

function enqueuePrMergeForGithubRepo(
  queueKey: string,
  run: () => Promise<void>,
  onQueuePosition: (position: number, length: number) => void,
  cancellation: GitActionCancellationScope,
): Promise<void> {
  let queue = prMergeQueues.get(queueKey);
  if (!queue) {
    queue = { pending: [] };
    prMergeQueues.set(queueKey, queue);
  }

  return new Promise<void>((resolve, reject) => {
    const job: QueuedPrMergeJob = {
      run,
      resolve,
      reject,
      onQueuePosition,
      unsubscribeCancellation: (): void => undefined,
    };
    queue.pending.push(job);
    job.unsubscribeCancellation = cancellation.onCancel(() => {
      if (queue.active === job) return;
      const jobIndex = queue.pending.indexOf(job);
      if (jobIndex < 0) return;

      queue.pending.splice(jobIndex, 1);
      job.reject(new GitActionCancelledError());
      notifyPrMergeQueue(queue);
      drainPrMergeQueue(queueKey);
    });
    notifyPrMergeQueue(queue);
    drainPrMergeQueue(queueKey);
  });
}

type AgentRebaseResolutionRepo = {
  repoId?: string;
  repoName: string;
  chatId: string;
  kind: RebaseResolutionKind;
};

interface RepoEntry {
  repoPath: string;
  repoId?: string;
  repoName: string;
}

interface ResolvedPrBaseBranch {
  baseBranch: string;
  fallbackBaseBranch: string | null;
}

interface WorktreeRepoOperationRequest {
  projectId: string;
  worktreeId: string;
  repoIds?: string[];
  operationId?: string;
}

type CancellableGitActionRequest = GitActionOperationRequest & {
  projectId: string;
  worktreeId: string;
};

interface GitActionLifecycle {
  onStart?: () => void;
  onFinish?: () => void;
}

async function runCancellableGitAction<T extends object>(
  request: CancellableGitActionRequest,
  cancelledResult: () => NoInfer<T>,
  run: (scope: GitActionCancellationScope) => Promise<T>,
  lifecycle?: GitActionLifecycle,
): Promise<T> {
  if (request.operationId !== undefined) {
    validateId(request.operationId, 'operationId');
  }
  const scope = beginExclusiveGitAction(request);
  try {
    lifecycle?.onStart?.();
    const result = await run(scope);
    scope.checkpoint();
    return result;
  } catch (error) {
    if (isGitActionCancelledError(error)) {
      return cancelledResult();
    }
    throw error;
  } finally {
    try {
      lifecycle?.onFinish?.();
    } finally {
      finishGitActionCancellationScope(request, scope);
    }
  }
}

interface RepoSkipResult<TReason extends string> {
  repoId?: string;
  repoName: string;
  reason: TReason;
}

interface CreatePrPrecheck {
  repo: RepoEntry;
  hasOriginRemote: boolean;
  hasUncommitted: boolean;
}

interface HelperAuditContext {
  projectId: string;
  worktreeId: string;
  repoId?: string;
  repoLabel?: string;
}

function buildHelperAuditContext(
  projectId: string,
  worktreeId: string,
  repoName: string,
  repoId?: string,
): HelperAuditContext {
  const context: HelperAuditContext = {
    projectId,
    worktreeId,
    repoLabel: repoName,
  };
  if (repoId) {
    context.repoId = repoId;
  }
  return context;
}

function validatePrNumber(value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('Invalid prNumber: must be a positive integer');
  }
}

function validateBaseBranchName(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error('Invalid newBaseBranch: must not be empty');
  }
  if (normalized === 'HEAD') {
    throw new Error('Invalid newBaseBranch: "HEAD" is not allowed');
  }
  return normalized;
}

async function classifyPullRebaseFailure(
  repoPath: string,
): Promise<RebaseResolutionKind | null> {
  if (await isRebaseInProgress(repoPath)) {
    return 'rebase_conflict';
  }
  const [autostashPresent, unmerged] = await Promise.all([
    hasAutostashEntry(repoPath),
    hasUnmergedPaths(repoPath),
  ]);
  if (autostashPresent && unmerged) {
    return 'stash_pop_conflict';
  }
  return null;
}

function extractGitStderr(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('stderr' in error)) {
    return undefined;
  }
  const maybeStderr: unknown = error.stderr;
  return typeof maybeStderr === 'string' ? maybeStderr : undefined;
}

async function resolvePrBaseBranchForRepo(params: {
  projectId: string;
  worktreeId: string;
  repoId?: string;
  repoPath: string;
  originAlreadyFetched?: boolean;
}): Promise<ResolvedPrBaseBranch> {
  if (!params.originAlreadyFetched) {
    try {
      await fetchOrigin(params.repoPath);
    } catch {
      // Base resolution can still fall back to the remote default branch.
    }
  }
  const effectiveBaseBranch = await resolveEffectiveBaseBranchForRepo(
    params,
  ).catch(() => null);
  const preferredBaseBranch =
    effectiveBaseBranch?.existsInRemote === true
      ? effectiveBaseBranch.branch?.trim() || null
      : null;
  const fallbackBaseBranch = await resolveRepoDefaultBranch(
    params.repoPath,
  ).catch(() => null);
  const baseBranch = preferredBaseBranch ?? fallbackBaseBranch;
  if (!baseBranch) {
    throw new Error(
      `Unable to resolve the default branch for repository "${basename(params.repoPath)}".`,
    );
  }

  return {
    baseBranch,
    fallbackBaseBranch,
  };
}

interface RemoteBranchDivergence {
  remoteBranchExists: boolean;
  ahead: number;
  behind: number;
}

async function readRemoteBranchDivergence(
  repoPath: string,
  branchName: string,
): Promise<RemoteBranchDivergence | null> {
  if (branchName === 'HEAD') return null;
  const remoteBranchExists = await readBranchPublication(repoPath);
  if (remoteBranchExists === null) return null;
  if (!remoteBranchExists) {
    return { remoteBranchExists: false, ahead: 0, behind: 0 };
  }
  try {
    const { ahead, behind } = await getAheadBehindCounts(
      repoPath,
      'HEAD',
      `origin/${branchName}`,
    );
    return { remoteBranchExists: true, ahead, behind };
  } catch {
    return null;
  }
}

function buildManualResolutionErrorMessage(args: {
  kind: RebaseResolutionKind;
  repoName: string;
  branchName: string;
  pullErrorMessage: string;
}): string {
  const { kind, repoName, branchName, pullErrorMessage } = args;
  const header =
    kind === 'rebase_conflict'
      ? `Rebase conflict while pulling "${branchName}" in "${repoName}". The repo is mid-rebase and needs manual resolution.`
      : `Stash-pop conflict while pulling "${branchName}" in "${repoName}". The rebase succeeded but the autostash could not be re-applied — the stash entry is retained.`;
  const steps =
    kind === 'rebase_conflict'
      ? 'Next steps: resolve conflicts in the listed files, `git add` them, then run `git rebase --continue`. To abort, run `git rebase --abort` (uncommitted changes will be restored from the autostash).'
      : 'Next steps: resolve the unmerged files listed by `git status`, `git add` them to finish the stash application, then drop the retained autostash with `git stash drop stash@{0}`. To discard the unapplied autostash, inspect `git stash show stash@{0}` first.';
  const parts = [header, steps];
  if (pullErrorMessage) {
    parts.push('', pullErrorMessage);
  }
  return parts.join('\n');
}

async function resolveRepoEntries(
  projectId: string,
  cwd: string,
): Promise<RepoEntry[]> {
  if (isMultiRepoWorkspace(projectId)) {
    const repoEntries = await listWorkspaceWorktreeRepoEntries(projectId, cwd);
    if (repoEntries.length === 0) {
      throw new Error(
        'Could not read project repos. Ensure the project has been set up correctly.',
      );
    }
    return repoEntries.map((entry) => ({
      repoPath: entry.repoPath,
      repoId: entry.repoId,
      repoName: entry.repoName,
    }));
  }

  const config = await readWorkspaceConfig(projectId).catch(() => null);
  const sourceRepoPath = config?.type === 'single-repo' ? config.repoPath : '';
  const repoName = sourceRepoPath ? basename(sourceRepoPath) : basename(cwd);

  return [
    {
      repoPath: cwd,
      repoId: SINGLE_REPO_USAGE_REPO_ID,
      repoName,
    },
  ];
}

function validateRepoIdOrWorkspaceRoot(repoId: string): void {
  if (
    repoId === WORKSPACE_ROOT_REPO_ID ||
    repoId === SINGLE_REPO_USAGE_REPO_ID
  ) {
    return;
  }
  validateId(repoId, 'repoId');
}

function validateOptionalRepoIds(repoIds: string[] | undefined): void {
  for (const repoId of repoIds ?? []) {
    validateRepoIdOrWorkspaceRoot(repoId);
  }
}

function filterRepoEntriesByIds(
  repoEntries: RepoEntry[],
  repoIds?: string[],
): RepoEntry[] {
  if (!repoIds || repoIds.length === 0) {
    return repoEntries;
  }

  const requestedRepoIds = new Set(repoIds);
  return repoEntries.filter(
    (entry) => entry.repoId !== undefined && requestedRepoIds.has(entry.repoId),
  );
}

async function resolveRequestedRepoEntries(
  request: WorktreeRepoOperationRequest,
): Promise<{ cwd: string; repoEntries: RepoEntry[] }> {
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
  validateOptionalRepoIds(request.repoIds);

  const cwd = resolveWorktreeCwd(request.projectId, request.worktreeId);
  const repoEntries = filterRepoEntriesByIds(
    await resolveRepoEntries(request.projectId, cwd),
    request.repoIds,
  );

  if (
    request.repoIds?.some(
      (repoId) => !repoEntries.some((entry) => entry.repoId === repoId),
    )
  ) {
    throw new Error('The repository changed. Start a new action.');
  }

  return { cwd, repoEntries };
}

async function resolveAllRepoEntries(request: {
  projectId: string;
  worktreeId: string;
}): Promise<{ cwd: string; repoEntries: RepoEntry[] }> {
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');

  const cwd = resolveWorktreeCwd(request.projectId, request.worktreeId);
  const repoEntries = await resolveRepoEntries(request.projectId, cwd);

  return { cwd, repoEntries };
}

function findRequestedCommitMessage(
  request: CommitAndPushRequest,
  repoId: string | undefined,
  repoName: string,
): string | undefined {
  if (!request.messages) {
    return undefined;
  }

  if (repoId !== undefined) {
    const matchingRepoId = request.messages.find(
      (messageEntry) => messageEntry.repoId === repoId,
    );
    if (matchingRepoId) {
      return matchingRepoId.message;
    }
  }

  return request.messages.find(
    (messageEntry) => messageEntry.repoName === repoName,
  )?.message;
}

/**
 * Resolve the ordered commit-message model chain: the configured
 * `commitGenerationModel` first, then the fallback candidates (CAN-3866).
 * Never throws on a dead-end lane — see `commitRepoChanges`.
 */
async function resolveCommitGenerationModels(
  prefs: PreferencesData,
  workspaceId: string,
): Promise<CommitGenerationModelPlan> {
  return resolveCommitGenerationModelCandidates({
    preferences: prefs,
    primaryModel: prefs.commitGenerationModel,
    workspaceId,
  });
}

async function commitRepoChanges(args: {
  repoPath: string;
  repoId?: string;
  repoName: string;
  projectId: string;
  worktreeId: string;
  message?: string;
  requireReviewedMessages?: boolean;
  prefs: PreferencesData;
  getWindow?: () => BrowserWindow | null;
  sendProgress: (phase: CommitPushPhase, repoName?: string) => void;
  cancellation: GitActionCancellationScope;
  onCommitted: () => void;
  mutate?: (message: string, phases: GitCommitPhases) => Promise<string>;
}): Promise<string> {
  const {
    repoPath,
    repoId,
    repoName,
    projectId,
    worktreeId,
    prefs,
    requireReviewedMessages,
    sendProgress,
  } = args;
  let message = args.message;

  if (!message) {
    if (requireReviewedMessages) {
      throw new Error(
        `Missing reviewed commit message for "${repoName}". Regenerate the preview before committing.`,
      );
    }

    sendProgress('generating_message', repoName);
    // NON-throwing: `generateCommitMessage` rejects only on cancellation. It
    // walks the ordered model candidates, finalizes one audit entry per failed
    // candidate, and returns `formatBranchAsTitle(branchName)` once every
    // candidate has failed, so the commit still lands (CAN-3866). Throwing
    // ahead of it left a user with no dispatchable lane unable to commit
    // through Canopy at all, and opened no audit entry to explain why.
    const commitModels = await resolveCommitGenerationModels(prefs, projectId);
    const branchName = await getCurrentBranch(repoPath);
    const diff = await getUncommittedDiff(repoPath);
    message = await args.cancellation.runAgentStep((abortController) =>
      generateCommitMessage({
        repoPath,
        branchName,
        diff,
        model: commitModels.model,
        fallbackModels: commitModels.fallbackModels,
        aiCreditsRoutingMode: commitModels.aiCreditsRoutingMode,
        thinkingLevel: prefs.commitGenerationThinkingLevel,
        instructions: prefs.commitInstructions,
        instructionMode: prefs.commitInstructionMode,
        pluginSelections: prefs.commitGenerationPluginSelections,
        abortController,
        auditContext: buildHelperAuditContext(
          projectId,
          worktreeId,
          repoName,
          repoId,
        ),
      }),
    );
  }

  const phases: GitCommitPhases = {
    stage: async (run) => {
      sendProgress('staging', repoName);
      await args.cancellation.runGitStep(run);
    },
    commit: async (run) => {
      sendProgress('committing', repoName);
      try {
        return await args.cancellation.runGitStep(async () => {
          const hash = await run();
          args.onCommitted();
          return hash;
        });
      } catch (error) {
        if (isGitActionCancelledError(error)) throw error;
        await triggerWorktreePrecommitFailureHook({
          projectId,
          worktreeId,
          repo: { repoPath, repoId, repoName },
          error,
          commitMessage: message,
          getWindow: args.getWindow,
        }).catch(() => {});
        throw error;
      }
    },
  };
  if (args.mutate) return args.mutate(message, phases);
  await phases.stage(() => stageAllChanges(repoPath));
  return phases.commit(() => commitWithMessage(repoPath, message));
}

// In-flight Split PR executions keyed by "projectId:worktreeId" so a second
// execute call for the same worktree is rejected instead of racing the first.
const splitPrAbortControllers = new Map<string, AbortController>();

function splitPrRunKey(projectId: string, worktreeId: string): string {
  return `${projectId}:${worktreeId}`;
}

/**
 * Whether a main-side split execute is currently in flight for a worktree. The
 * `splitPrAbortControllers` registry is populated for the duration of an
 * `executePrSplit` run (the `approveSplitWorkflow` handler uses it), so its
 * presence is the authoritative in-flight signal.
 */
function hasInFlightSplitExecute(
  workspaceId: string,
  worktreeId: string,
): boolean {
  return splitPrAbortControllers.has(splitPrRunKey(workspaceId, worktreeId));
}

/**
 * Renderer-lifecycle recovery: release every held split lock that has no split
 * execute in flight, then return the count released. Called from the main
 * window's `render-process-gone` and reload seams so a crash/reload during the
 * plan-review phase does not strand the lock (which would leave the worktree
 * frozen with an empty renderer mirror and no UI to clear it). Locks WITH an
 * execute in flight are kept because that main-side run survives the reload and
 * `approveSplitWorkflow`'s settle path releases them.
 */
export function releaseIdleSplitLocksForRendererLifecycle(): number {
  return releaseIdleSplitLocks(
    (workspaceId, worktreeId) =>
      hasInFlightSplitExecute(workspaceId, worktreeId) ||
      isSplitTemporaryWorkspaceInFlight(workspaceId, worktreeId),
  );
}

/**
 * Single source of truth for remote create-PR eligibility: the returned reason
 * being `undefined` IS `canCreate`, so a hidden button always has an
 * explanation attached to it.
 */
function resolvePrCreateBlockedReason(input: {
  status: PortalPullRequestRepoStatus | null;
  prLookupAvailable: boolean;
  branch: string;
  baseBranch: string | null;
  hasOrigin: boolean;
  hasChanges: boolean;
  behindRemote: boolean;
}): PortalPrCreateBlockedReason | undefined {
  if (input.status?.state === 'open' || input.status?.state === 'draft') {
    return 'pr_open';
  }
  if (!input.hasOrigin) return 'no_remote';
  if (!input.prLookupAvailable) return 'pr_status_unavailable';
  if (input.branch === 'HEAD') return 'detached_head';
  if (input.branch === input.baseBranch) return 'base_branch';
  if (!input.hasChanges) return 'no_changes';
  if (input.behindRemote) return 'needs_pull';
  return undefined;
}

/** Merge twin of {@link resolvePrCreateBlockedReason}. */
function resolvePrMergeBlockedReason(input: {
  status: PortalPullRequestRepoStatus | null;
  dirty: boolean;
  unpushed: boolean;
}): PortalPrMergeBlockedReason | undefined {
  const status = input.status;
  if (status?.state !== 'open' && status?.state !== 'draft') return 'no_pr';
  if (status.state === 'draft') return 'draft';
  if (status.hasConflicts === true) return 'conflicts';
  if (status.mergeReady !== true) {
    // GitHub's mergeable state already folds in required checks and reviews,
    // so name the signal the user can see rather than inventing a cause.
    if (status.checkStatus === 'failing') return 'checks_failing';
    if (status.checkStatus === 'pending') return 'checks_pending';
    if (
      status.reviewStatus === 'pending' ||
      status.reviewStatus === 'changes-requested'
    ) {
      return 'review_pending';
    }
    return 'not_ready';
  }
  if (input.dirty || input.unpushed) return 'local_changes';
  return undefined;
}

/** Request metadata describes an original action, never broadens its git scope. */
function gitShippingRepoCount(
  targetCount: number,
  originalCount: unknown,
): number {
  return typeof originalCount === 'number' &&
    Number.isSafeInteger(originalCount) &&
    originalCount >= targetCount
    ? originalCount
    : targetCount;
}

export function registerGitHubHandlers(
  getWindow: () => BrowserWindow | null,
  runtime: {
    dispatcher: GitHubPullRequestIpcDispatcher &
      WorkerGitSyncDispatcher &
      WorkerGitCommitPushDispatcher &
      WorkerGitMergeDispatcher;
    resolveCaller: DesktopIpcCallerResolver;
  },
): void {
  // Start the PR status poller
  startPolling(getWindow);
  if (__CANOPY_E2E__) {
    const channel = 'github:e2e-suspend-pr-status-tracking';
    ipcMain.removeAllListeners(channel);
    ipcMain.on(
      channel,
      (_event, request: { projectId: string; worktreeId: string }): void => {
        validateId(request.projectId, 'projectId');
        validateId(request.worktreeId, 'worktreeId');
        suspendTrackingForE2e(request.projectId, request.worktreeId);
      },
    );
  }
  getGitHubBroker().subscribeRateLimits((state) => {
    const message =
      state.kind === 'primary'
        ? `GitHub API rate limit reached. Requests will resume after ${new Date(state.retryAt).toLocaleTimeString()}.`
        : `GitHub is temporarily throttling API requests. Retrying in ${state.retryAfterSeconds}s.`;
    sendToWindow(getWindow(), IPC_CHANNELS.githubRateLimitEvent, {
      kind: state.kind,
      message,
      retryAt: state.retryAt,
      retryAfterSeconds: state.retryAfterSeconds,
      ...(state.resource ? { resource: state.resource } : {}),
    });
  });

  function sendProgress(
    projectId: string,
    worktreeId: string,
    phase: PrCreationPhase,
    repoName?: string,
    error?: string,
  ): void {
    const event: PrCreationProgressEvent = {
      projectId,
      worktreeId,
      phase,
      repoName,
      error,
    };
    // Mirror the feed into the main-side aggregator so the portal projection
    // carries `creationProgress` and streams live pr_status deltas
    // (CAN-1528 L2).
    recordPrCreationProgress(event);
    sendToWindow(getWindow(), IPC_CHANNELS.githubPrCreationProgress, event);
  }

  function sendPrRefreshing(request: {
    projectId: string;
    worktreeId: string;
  }): void {
    sendToWindow(getWindow(), IPC_CHANNELS.githubPrCreationProgress, {
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      phase: 'done',
      refreshing: true,
    } satisfies PrCreationProgressEvent);
  }

  function sendSplitPrProgress(
    event: SplitPrProgressEvent,
    controller: AbortController,
  ): void {
    const key = splitPrRunKey(event.projectId, event.worktreeId);
    if (splitPrAbortControllers.get(key) === controller) {
      if (event.phase === 'cancelled' || controller.signal.aborted) {
        clearSplitPrRuntimeProjection(event.projectId, event.worktreeId);
      } else {
        const projection = projectSplitPrProgress(event);
        setSplitPrRuntimeProjection(
          event.projectId,
          event.worktreeId,
          projection.status,
          projection.message,
        );
      }
    }
    sendToWindow(getWindow(), IPC_CHANNELS.githubSplitPrProgress, event);
  }

  // Broadcast every split lock transition to the renderer so its mirrored
  // `splitLockedWorktrees` set stays live without polling.
  onSplitLockChange((event: SplitLockChangeEventPayload) => {
    sendToWindow(getWindow(), IPC_CHANNELS.githubSplitLockEvent, event);
  });

  /**
   * Terminate a worktree's running resources before a split acquires the lock:
   * kill its terminals, destroy its browser sessions, and stop its running
   * hooks and scripts. Terminal kills are synchronous; browser/hook/script
   * teardown is awaited. Any failure propagates so the start handler can
   * release a lock it may have taken and surface the error.
   */
  async function terminateWorktreeResources(
    projectId: string,
    worktreeId: string,
  ): Promise<void> {
    workerTerminal.killWorktree({ projectId, worktreeId });
    await getBrowserService()?.destroyWorktree(projectId, worktreeId, {
      clearStorage: false,
    });
    await stopHooksForWorktree({ projectId, worktreeId });
    await stopWorktreeScripts({ projectId, worktreeId });
  }

  /**
   * Main-side re-validation of the renderer's own start pre-gate: the renderer
   * blocks a Split PR launch while the worktree has an active chat turn or an
   * active pipeline execution, but that check is not authoritative. Main also
   * protects live non-ambient provider background work — a race
   * (a chat/pipeline that starts between the renderer gate and the IPC arriving)
   * or a direct IPC/App-Advisor dispatch can reach the start handler with work
   * still in flight. Locking mid-mutation is exactly what the lockdown is
   * supposed to prevent, so re-check here and throw {@link SplitStartBlockedError}
   * BEFORE the lock is acquired. Terminals/browsers/scripts are intentionally
   * NOT checked here: those are terminated on start, not refused.
   */
  async function assertNoInFlightSplitBlockers(
    projectId: string,
    worktreeId: string,
  ): Promise<void> {
    if (hasActiveChatWorkForWorktree(projectId, worktreeId)) {
      throw new SplitStartBlockedError(
        'Cannot start a Split PR while a chat is still working in this worktree. Wait for it to finish first.',
        { workspaceId: projectId, worktreeId, blocker: 'active-chat' },
      );
    }

    let hasActivePipelineExecution = false;
    try {
      const summaries = await listExecutionSummaries(
        join(getDataDir(), 'pipeline-executions'),
      );
      hasActivePipelineExecution = summaries.some(
        (summary) =>
          summary.project_id === projectId &&
          summary.worktree_id === worktreeId &&
          (summary.status === 'running' || summary.status === 'paused'),
      );
    } catch {
      // A failure to enumerate executions must not silently allow a start that
      // could race a real run; but it also must not hard-block every start on
      // a transient FS error. Treat an unreadable executions dir as "no known
      // active pipeline execution" — the renderer pre-gate plus the guarded pipeline
      // chokepoints remain in place.
      hasActivePipelineExecution = false;
    }
    if (hasActivePipelineExecution) {
      throw new SplitStartBlockedError(
        'Cannot start a Split PR while a workflow is running or paused in this worktree. Wait for it to finish or cancel it first.',
        { workspaceId: projectId, worktreeId, blocker: 'running-pipeline' },
      );
    }
  }

  function sendCommitProgress(
    projectId: string,
    worktreeId: string,
    phase: CommitPushPhase,
    repoName?: string,
    error?: string,
  ): void {
    const event: CommitPushProgressEvent = {
      projectId,
      worktreeId,
      phase,
      repoName,
      error,
    };
    sendToWindow(getWindow(), IPC_CHANNELS.githubCommitPushProgress, event);
  }

  function sendMergePrProgress(event: MergePrProgressEvent): void {
    recordPrMergeProgress(event);
    sendToWindow(getWindow(), IPC_CHANNELS.githubMergePrProgress, event);
  }

  function sendRepoCommitProgress(
    request: { projectId: string; worktreeId: string },
    phase: CommitPushPhase,
    repoName?: string,
    error?: string,
  ): void {
    sendCommitProgress(
      request.projectId,
      request.worktreeId,
      phase,
      repoName,
      error,
    );
  }

  function sendRepoPrProgress(
    request: { projectId: string; worktreeId: string },
    phase: PrCreationPhase,
    repoName?: string,
    error?: string,
  ): void {
    sendProgress(request.projectId, request.worktreeId, phase, repoName, error);
  }

  function pushSkippedRepo<TReason extends string>(
    skippedRepos: Array<RepoSkipResult<TReason>>,
    repo: RepoEntry,
    reason: TReason,
  ): void {
    skippedRepos.push({
      repoId: repo.repoId,
      repoName: repo.repoName,
      reason,
    });
  }

  function pushFailedRepoAndEmitProgress(
    failedRepos: RepoFailureResult[],
    request: { projectId: string; worktreeId: string },
    repo: RepoEntry,
    error: unknown,
    commitPrepared?: boolean,
  ): void {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    sendCommitProgress(
      request.projectId,
      request.worktreeId,
      'error',
      repo.repoName,
      errorMessage,
    );
    failedRepos.push({
      repoId: repo.repoId,
      repoName: repo.repoName,
      error: errorMessage,
      status: 'failed',
      ...(githubAuthFailureCode(error)
        ? {
            failureCode: githubAuthFailureCode(error),
            ...(commitPrepared !== undefined ? { commitPrepared } : {}),
          }
        : {}),
    });
  }

  function emitFinalRepoOperationProgress(
    request: { projectId: string; worktreeId: string },
    successCount: number,
    failedCount: number,
  ): void {
    sendCommitProgress(
      request.projectId,
      request.worktreeId,
      failedCount > 0 && successCount === 0 ? 'error' : 'done',
    );
  }

  function refreshAfterSuccessfulRepoOperation(
    request: { projectId: string; worktreeId: string },
    successCount: number,
  ): void {
    if (successCount > 0) {
      requestRefresh(request.projectId, request.worktreeId, true);
      enqueueFastRefresh(request.projectId, request.worktreeId, false);
    }
  }

  async function commitRepoAndEmitProgress({
    entry,
    request,
    prefs,
    requestedMessage,
    requireReviewedMessages,
    cancellation,
    telemetry,
    caller,
  }: {
    entry: RepoEntry;
    request: WorktreeRepoOperationRequest;
    prefs: PreferencesData;
    requestedMessage?: string;
    requireReviewedMessages?: boolean;
    cancellation: GitActionCancellationScope;
    telemetry: GitShippingTelemetryInput;
    caller?: CanopyCallerDescriptor;
  }): Promise<string> {
    return commitRepoChanges({
      ...(caller && {
        mutate: (message: string, phases: GitCommitPhases) =>
          commitWorktreeRepository(
            runtime.dispatcher,
            caller,
            request,
            entry,
            message,
            phases,
          ),
      }),
      onCommitted: () => {
        try {
          recordGitCommitTelemetry(telemetry);
        } catch {
          /* Telemetry cannot change git results. */
        }
      },
      repoPath: entry.repoPath,
      repoId: entry.repoId,
      repoName: entry.repoName,
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      message: requestedMessage,
      requireReviewedMessages,
      prefs,
      cancellation,
      getWindow,
      sendProgress: (phase, repoName) =>
        sendRepoCommitProgress(request, phase, repoName),
    });
  }

  async function resolvePullRebaseFailure(args: {
    entry: RepoEntry;
    request: WorktreeRepoOperationRequest;
    prefs: PreferencesData;
    branchName: string;
    error: unknown;
    commitMessage?: string;
  }): Promise<AgentRebaseResolutionRepo> {
    const { entry, request, prefs, branchName, error, commitMessage } = args;
    const kind = await classifyPullRebaseFailure(entry.repoPath);
    const rawMessage = error instanceof Error ? error.message : String(error);
    const stderr = extractGitStderr(error);
    const pullErrorMessage =
      stderr && stderr.trim() ? stderr.trim() : rawMessage;

    if (kind && prefs.agentRebaseResolutionEnabled) {
      const { launchRebaseResolutionChat } =
        await import('../lib/rebase-resolution-chat');
      try {
        const { chatId } = await launchRebaseResolutionChat({
          projectId: request.projectId,
          worktreeId: request.worktreeId,
          prefs,
          context: {
            kind,
            repoName: entry.repoName,
            branchName,
            repoPath: entry.repoPath,
            commitMessage,
            errorMessage: pullErrorMessage,
          },
          getWindow,
        });
        return {
          repoId: entry.repoId,
          repoName: entry.repoName,
          chatId,
          kind,
        };
      } catch (launchError) {
        // A billing dead end must NOT replace the rebase guidance. Since
        // CAN-1929 the launcher resolves lane-aware and can throw
        // `NoDispatchableModelError`, which would surface to the per-repo catch
        // as `No dispatchable model is available (billing-lane).` — losing which
        // repo, which branch, and how to resolve it by hand. The agent path is
        // an ENHANCEMENT over manual resolution, so when it cannot start we
        // fall through to the manual message the user actually needs.
        //
        // Deliberately narrow: only the billing dead end falls through. Any
        // other launch failure still propagates, so real bugs stay visible.
        if (!(launchError instanceof NoDispatchableModelError)) {
          throw launchError;
        }
      }
    }

    if (kind) {
      throw new Error(
        buildManualResolutionErrorMessage({
          kind,
          repoName: entry.repoName,
          branchName,
          pullErrorMessage,
        }),
      );
    }

    throw error;
  }

  interface RemoteRepoOperationConfig<TSuccess, TSkipReason extends string> {
    emptyErrorMessage: string;
    operationPhase: CommitPushPhase;
    preflight: (
      entry: RepoEntry,
    ) => Promise<{ skipReason?: TSkipReason; isAhead?: boolean }>;
    run: (entry: RepoEntry, context: { isAhead?: boolean }) => Promise<void>;
    buildSuccess: (entry: RepoEntry) => TSuccess;
  }

  async function runRemoteRepoOperation<TSuccess, TSkipReason extends string>(
    request: WorktreeRepoOperationRequest,
    repoEntries: RepoEntry[],
    cancellation: GitActionCancellationScope,
    config: RemoteRepoOperationConfig<TSuccess, TSkipReason>,
  ): Promise<{
    repos: TSuccess[];
    skippedRepos: Array<RepoSkipResult<TSkipReason>>;
    failedRepos: RepoFailureResult[];
  }> {
    const successRepos: TSuccess[] = [];
    const skippedRepos: Array<RepoSkipResult<TSkipReason>> = [];
    const failedRepos: RepoFailureResult[] = [];

    for (const entry of repoEntries) {
      cancellation.checkpoint();
      try {
        const preflight = await config.preflight(entry);
        cancellation.checkpoint();
        if (preflight.skipReason !== undefined) {
          pushSkippedRepo(skippedRepos, entry, preflight.skipReason);
          continue;
        }
        sendRepoCommitProgress(request, config.operationPhase, entry.repoName);
        await cancellation.runGitStep(() =>
          config.run(entry, { isAhead: preflight.isAhead }),
        );
        sendRepoCommitProgress(request, 'done', entry.repoName);
        successRepos.push(config.buildSuccess(entry));
      } catch (err) {
        if (isGitActionCancelledError(err)) throw err;
        pushFailedRepoAndEmitProgress(failedRepos, request, entry, err);
      }
    }

    if (successRepos.length === 0 && failedRepos.length === 0) {
      throw new Error(config.emptyErrorMessage);
    }

    emitFinalRepoOperationProgress(
      request,
      successRepos.length,
      failedRepos.length,
    );
    if (successRepos.length > 0) {
      cancellation.enterRefreshing();
      refreshAfterSuccessfulRepoOperation(request, successRepos.length);
    }

    return {
      repos: successRepos,
      skippedRepos,
      failedRepos,
    };
  }

  interface ProcessPrReposArgs {
    reposToProcess: RepoEntry[];
    request: CreatePrRequest;
    prefs: PreferencesData;
    cwd: string;
    repoEntries: RepoEntry[];
    cancellation: GitActionCancellationScope;
    failedRepos: RepoFailureResult[];
    createPullRequest: PullRequestCreateStep;
  }

  async function processPrRepos({
    reposToProcess,
    request,
    prefs,
    cwd,
    repoEntries,
    cancellation,
    failedRepos,
    createPullRequest,
  }: ProcessPrReposArgs): Promise<CreatePrRepoResult[]> {
    const repoCount = gitShippingRepoCount(
      new Set(repoEntries.map((entry) => entry.repoPath)).size,
      request.telemetryRepoCount,
    );
    const results: CreatePrRepoResult[] = [];
    const commitPrepared = new Set<string>();
    const pushCompleted = new Set<string>();
    const prGenerationModel = prefs.prGenerationModel;
    const commitGenerationModels = await resolveCommitGenerationModels(
      prefs,
      request.projectId,
    );

    if (isMultiRepoWorkspace(request.projectId)) {
      const BATCH_SIZE = 5;
      for (let i = 0; i < reposToProcess.length; i += BATCH_SIZE) {
        cancellation.checkpoint();
        const batch = reposToProcess.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.allSettled(
          batch.map(
            async (repo): Promise<CreatePrRepoResult> =>
              processRepoForPr(
                repo.repoPath,
                repo.repoId,
                repo.repoName,
                request.projectId,
                request.worktreeId,
                request.expectedBaseBranch,
                request.expectedHeadBranch,
                prGenerationModel,
                prefs.prGenerationThinkingLevel,
                prefs.prInstructions,
                prefs.prInstructionMode,
                commitGenerationModels,
                prefs.commitGenerationThinkingLevel,
                prefs.commitInstructions,
                prefs.commitInstructionMode,
                prefs.commitGenerationPluginSelections,
                prefs.prGenerationPluginSelections,
                {
                  projectId: request.projectId,
                  source: request.source === 'chat' ? 'chat' : 'manual',
                  flow: 'pull_request',
                  repoCount,
                },
                cancellation,
                createPullRequest,
                getWindow,
                (phase) => sendRepoPrProgress(request, phase, repo.repoName),
                request.skipCommit,
                () => {
                  commitPrepared.add(repo.repoPath);
                },
                request.skipPush,
                () => {
                  pushCompleted.add(repo.repoPath);
                },
              ),
          ),
        );
        for (let j = 0; j < batchResults.length; j++) {
          const result = batchResults[j];
          const repo = batch[j];
          if (!repo) {
            continue;
          }

          if (result.status === 'fulfilled') {
            results.push(result.value);
            sendRepoPrProgress(request, 'done', repo.repoName);
          } else {
            const errorMsg =
              result.reason instanceof Error
                ? result.reason.message
                : 'Unknown error';
            sendRepoPrProgress(request, 'error', repo.repoName, errorMsg);
            const failureCode = githubAuthFailureCode(result.reason);
            if (isGitActionCancelledError(result.reason)) throw result.reason;
            if (request.repoIds?.length === 1 && !failureCode)
              throw result.reason;
            failedRepos.push({
              repoId: repo.repoId,
              repoName: repo.repoName,
              status: 'failed',
              error: errorMsg,
              ...(failureCode
                ? {
                    failureCode,
                    commitPrepared: commitPrepared.has(repo.repoPath),
                    pushCompleted: pushCompleted.has(repo.repoPath),
                  }
                : {}),
            });
          }
        }
        cancellation.checkpoint();
      }

      return results;
    }

    if (reposToProcess.length === 0) {
      return results;
    }

    const repoName = repoEntries[0]?.repoName ?? basename(cwd);
    const repoId = repoEntries[0]?.repoId;
    try {
      results.push(
        await processRepoForPr(
          cwd,
          repoId,
          repoName,
          request.projectId,
          request.worktreeId,
          request.expectedBaseBranch,
          request.expectedHeadBranch,
          prGenerationModel,
          prefs.prGenerationThinkingLevel,
          prefs.prInstructions,
          prefs.prInstructionMode,
          commitGenerationModels,
          prefs.commitGenerationThinkingLevel,
          prefs.commitInstructions,
          prefs.commitInstructionMode,
          prefs.commitGenerationPluginSelections,
          prefs.prGenerationPluginSelections,
          {
            projectId: request.projectId,
            source: request.source === 'chat' ? 'chat' : 'manual',
            flow: 'pull_request',
            repoCount,
          },
          cancellation,
          createPullRequest,
          getWindow,
          (phase) => sendRepoPrProgress(request, phase),
          request.skipCommit,
          () => {
            commitPrepared.add(cwd);
          },
          request.skipPush,
          () => {
            pushCompleted.add(cwd);
          },
        ),
      );
    } catch (error) {
      const failureCode = githubAuthFailureCode(error);
      if (!failureCode) throw error;
      const message = error instanceof Error ? error.message : 'Unknown error';
      sendRepoPrProgress(request, 'error', repoName, message);
      failedRepos.push({
        repoId,
        repoName,
        status: 'failed',
        error: message,
        failureCode,
        commitPrepared: commitPrepared.has(cwd),
        pushCompleted: pushCompleted.has(cwd),
      });
    }

    return results;
  }

  const createWorktreePr = {
    run: async (
      request: CreatePrRequest,
      createPullRequest: PullRequestCreateStep,
    ): Promise<CreatePrResponse> => {
      if (
        request.skipPush &&
        (!request.skipCommit || !request.expectedHeadBranch?.trim())
      ) {
        throw new Error('The branch changed. Start a new pull request.');
      }
      if (request.skipCommit && !request.expectedHeadBranch?.trim())
        throw new Error('The branch changed. Start a new pull request.');
      return runCancellableGitAction(
        request,
        () => ({
          repos: [],
          skippedRepos: [],
          localOnlyCommittedRepos: [],
          cancelled: true,
        }),
        async (scope): Promise<CreatePrResponse> => {
          // Reset the portal-facing creation feed exactly where the renderer
          // store resets its own copy (CAN-1528 L2).
          beginPrCreationProgress(request.projectId, request.worktreeId);
          try {
            const { cwd, repoEntries } =
              await resolveRequestedRepoEntries(request);
            const repoCount = gitShippingRepoCount(
              new Set(repoEntries.map((entry) => entry.repoPath)).size,
              request.telemetryRepoCount,
            );
            const prefs = await readPreferencesFile();
            const results: CreatePrRepoResult[] = [];
            const failedRepos: RepoFailureResult[] = [];
            const skippedRepos: SkippedRepo[] = [];
            const localOnlyCommittedRepos: CreatePrLocalCommitResult[] = [];
            const reposToProcess: RepoEntry[] = [];
            const prechecks: CreatePrPrecheck[] = await Promise.all(
              repoEntries.map(async (repo): Promise<CreatePrPrecheck> => {
                const hasOriginRemote = Boolean(
                  await getRemoteUrl(repo.repoPath),
                );
                let hasUncommitted = true;
                try {
                  hasUncommitted = await hasUncommittedChanges(repo.repoPath);
                } catch {
                  hasUncommitted = true;
                }

                return {
                  repo,
                  hasOriginRemote,
                  hasUncommitted,
                };
              }),
            );
            const remoteChangedByPath = new Map<string, boolean>();
            await Promise.all(
              prechecks
                .filter((precheck) => precheck.hasOriginRemote)
                .map(async (precheck): Promise<void> => {
                  const changed = await repoHasChanges(
                    precheck.repo.repoPath,
                    request.projectId,
                    request.worktreeId,
                    precheck.repo.repoId,
                    precheck.hasUncommitted,
                  );
                  remoteChangedByPath.set(precheck.repo.repoPath, changed);
                }),
            );

            for (const precheck of prechecks) {
              const { repo, hasOriginRemote, hasUncommitted } = precheck;

              if (!hasOriginRemote) {
                if (request.skipCommit)
                  throw new Error(
                    'The repository no longer has an origin remote. Start a new pull request.',
                  );
                if (hasUncommitted) {
                  const commitHash = await commitRepoAndEmitProgress({
                    entry: repo,
                    request,
                    prefs,
                    cancellation: scope,
                    telemetry: {
                      projectId: request.projectId,
                      source: request.source === 'chat' ? 'chat' : 'manual',
                      flow: 'pull_request',
                      repoCount,
                    },
                  });
                  localOnlyCommittedRepos.push({
                    repoId: repo.repoId ?? repo.repoName,
                    repoName: repo.repoName,
                    commitHash,
                  });
                  sendRepoPrProgress(request, 'skipped', repo.repoName);
                  continue;
                }

                const effectiveBaseBranch =
                  await resolveEffectiveBaseBranchForRepo({
                    projectId: request.projectId,
                    worktreeId: request.worktreeId,
                    repoId: repo.repoId,
                    repoPath: repo.repoPath,
                  });
                const hasCommittedChanges =
                  effectiveBaseBranch.branch !== null &&
                  (await hasCommitsAhead(
                    repo.repoPath,
                    effectiveBaseBranch.branch,
                  ).catch(() => false));

                skippedRepos.push({
                  repoId: repo.repoId ?? repo.repoName,
                  repoName: repo.repoName,
                  reason: hasCommittedChanges
                    ? 'no_remote_origin'
                    : 'no_changes',
                });
                sendRepoPrProgress(request, 'skipped', repo.repoName);
                continue;
              }

              const changed = remoteChangedByPath.get(repo.repoPath) ?? true;
              if (!changed) {
                skippedRepos.push({
                  repoId: repo.repoId ?? repo.repoName,
                  repoName: repo.repoName,
                  reason: 'no_changes',
                });
                sendRepoPrProgress(request, 'skipped', repo.repoName);
                continue;
              }

              reposToProcess.push(repo);
            }

            if (
              !isMultiRepoWorkspace(request.projectId) &&
              reposToProcess.length === 0
            ) {
              if (
                localOnlyCommittedRepos.length === 0 &&
                skippedRepos.every((repo) => repo.reason === 'no_changes')
              ) {
                throw new Error(
                  'No repos have changes. Make some changes before creating a PR.',
                );
              }

              sendRepoPrProgress(request, 'done');
              return {
                repos: results,
                skippedRepos,
                localOnlyCommittedRepos,
              };
            }

            results.push(
              ...(await processPrRepos({
                reposToProcess,
                request,
                prefs,
                cwd,
                repoEntries,
                cancellation: scope,
                failedRepos,
                createPullRequest,
              })),
            );

            if (
              results.length === 0 &&
              localOnlyCommittedRepos.length === 0 &&
              skippedRepos.length > 0 &&
              skippedRepos.every((repo) => repo.reason === 'no_changes')
            ) {
              throw new Error(
                'No repos have changes. Make some changes before creating a PR.',
              );
            }

            sendRepoPrProgress(
              request,
              failedRepos.length && !results.length ? 'error' : 'done',
            );
            return {
              repos: results,
              ...(failedRepos.length ? { failedRepos } : {}),
              skippedRepos,
              localOnlyCommittedRepos,
            };
          } catch (error) {
            if (isGitActionCancelledError(error)) {
              cancelPrCreationProgress(request.projectId, request.worktreeId);
              throw error;
            }
            // Terminal error step for the portal-facing feed: the renderer marks
            // its own copy from the rejected invoke, but the main-side registry
            // would otherwise stay stuck at a non-terminal phase forever
            // (CAN-1528 L2 review).
            recordPrCreationProgress({
              projectId: request.projectId,
              worktreeId: request.worktreeId,
              phase: 'error',
              error:
                error instanceof Error ? error.message : 'PR creation failed',
            });
            throw error;
          } finally {
            if (!scope.cancelled) {
              scope.enterRefreshing();
              sendPrRefreshing(request);
              // Re-project the fresh pr_status to a connected portal once creation
              // settles: the live 'done'/'error' feed deltas carry the
              // last-remembered payload, which predates a just-created PR
              // (CAN-1528 L2 review). Fire-and-forget; never throws.
              void projectPortalPrStatus(request.projectId, request.worktreeId);
              if (isMultiRepoWorkspace(request.projectId)) {
                // refreshNow fetches per-repo PR status sequentially; awaiting it
                // here keeps the "Creating pull request…" state stuck on the card
                // long after PR work has settled. Enqueue a fast refresh and let
                // PrStatusEvent updates flow in asynchronously instead.
                requestRefresh(request.projectId, request.worktreeId, true);
                enqueueFastRefresh(
                  request.projectId,
                  request.worktreeId,
                  false,
                );
              } else {
                await refreshNow(request.projectId, request.worktreeId).catch(
                  () => {
                    requestRefresh(request.projectId, request.worktreeId, true);
                  },
                );
              }
            }
          }
        },
      );
    },
  };

  // core.pullRequest.create for the flow's GitHub create steps (CAN-4109).
  registerIpcHandler(
    IPC_CHANNELS.githubCreatePr,
    (event: IpcMainInvokeEvent, request: CreatePrRequest) => {
      assertWritableScope(request.projectId);
      // Before the flow commits or pushes: an untracked sender changes nothing.
      const caller = runtime.resolveCaller(event);
      return createWorktreePr.run(
        request,
        dispatchedPullRequestCreate(runtime.dispatcher, () => caller),
      );
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.githubRequestRefresh,
    (
      _event: IpcMainInvokeEvent,
      request: { projectId: string; worktreeId: string },
    ): void => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      requestRefresh(request.projectId, request.worktreeId);
    },
  );

  // A worktree's pull request status, read live as Portal's `pr` state
  // refresh reads it, for hosted controllers (CAN-5985). Read-only.
  registerIpcHandler(
    IPC_CHANNELS.githubGetPrState,
    (
      _event: IpcMainInvokeEvent,
      request: { projectId: string; worktreeId: string },
    ): Promise<PortalPullRequestState> => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      return refreshPullRequestState({
        workspaceLocalId: request.projectId,
        worktreeLocalId: request.worktreeId,
      });
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.githubRequestFastRefresh,
    (
      _event: IpcMainInvokeEvent,
      request: { projectId: string; worktreeId: string; skipIfFresh?: boolean },
    ): void => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      enqueueFastRefresh(
        request.projectId,
        request.worktreeId,
        request.skipIfFresh ?? false,
      );
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.githubRequestKnownPrFastRefresh,
    async (
      _event: IpcMainInvokeEvent,
      request: { projectId: string; worktreeId: string },
    ): Promise<boolean> => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      return enqueueKnownPrFastRefresh(request.projectId, request.worktreeId);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.githubSetForegroundWorktree,
    (
      _event: IpcMainInvokeEvent,
      request: { projectId: string | null; worktreeId: string | null },
    ): void => {
      if (request.projectId === null || request.worktreeId === null) {
        setForegroundWorktree(null, null);
        return;
      }

      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      setForegroundWorktree(request.projectId, request.worktreeId);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.githubCancelGitAction,
    (
      _event: IpcMainInvokeEvent,
      request: CancelGitActionRequest,
    ): CancelGitActionResponse => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      validateId(request.operationId, 'operationId');
      return requestGitActionCancellation(request);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.githubGenerateCommitMessages,
    async (
      _event: IpcMainInvokeEvent,
      request: GenerateCommitMessagesRequest,
    ): Promise<GenerateCommitMessagesResponse> => {
      assertWritableScope(request.projectId);
      return runCancellableGitAction(
        request,
        () => ({
          repos: [],
          skippedRepos: [],
          failedRepos: [],
          cancelled: true,
        }),
        async (scope): Promise<GenerateCommitMessagesResponse> => {
          const { cwd, repoEntries } =
            await resolveRequestedRepoEntries(request);
          const prefs = await readPreferencesFile();
          // NON-throwing, and deliberately so: this sits OUTSIDE the per-repo
          // try/catch below, so a throw here rejects the whole
          // `githubGenerateCommitMessages` invoke instead of returning the
          // structured `{ repos, skippedRepos, failedRepos }` the UI renders.
          const commitModels = await resolveCommitGenerationModels(
            prefs,
            request.projectId,
          );
          const repos: GenerateCommitMessagesRepoResult[] = [];
          const skippedRepos: GenerateCommitMessagesSkippedRepo[] = [];
          const failedRepos: GenerateCommitMessagesFailedRepo[] = [];

          if (isMultiRepoWorkspace(request.projectId)) {
            for (const entry of repoEntries) {
              const repoPath = entry.repoPath;
              const [hasOriginRemote, hasTracking, hasChanges] =
                await Promise.all([
                  getRemoteUrl(repoPath).then(
                    (remoteUrl) => remoteUrl !== null,
                  ),
                  hasRemoteTrackingBranch(repoPath),
                  hasUncommittedChanges(repoPath),
                ]);

              if (
                request.commitOnly !== true &&
                hasOriginRemote &&
                !hasTracking
              ) {
                skippedRepos.push({
                  repoId: entry.repoId,
                  repoName: entry.repoName,
                  reason: 'no_remote_tracking',
                });
                continue;
              }

              if (!hasChanges) {
                skippedRepos.push({
                  repoId: entry.repoId,
                  repoName: entry.repoName,
                  reason: 'no_uncommitted_changes',
                });
                continue;
              }

              try {
                const branchName = await getCurrentBranch(repoPath);
                const diff = await getUncommittedDiff(repoPath);
                const message = await scope.runAgentStep((abortController) =>
                  generateCommitMessage({
                    repoPath,
                    branchName,
                    diff,
                    model: commitModels.model,
                    fallbackModels: commitModels.fallbackModels,
                    aiCreditsRoutingMode: commitModels.aiCreditsRoutingMode,
                    thinkingLevel: prefs.commitGenerationThinkingLevel,
                    instructions: prefs.commitInstructions,
                    instructionMode: prefs.commitInstructionMode,
                    pluginSelections: prefs.commitGenerationPluginSelections,
                    abortController,
                    auditContext: buildHelperAuditContext(
                      request.projectId,
                      request.worktreeId,
                      entry.repoName,
                      entry.repoId,
                    ),
                  }),
                );
                repos.push({
                  repoId: entry.repoId,
                  repoName: entry.repoName,
                  message,
                });
              } catch (err) {
                if (isGitActionCancelledError(err)) throw err;
                failedRepos.push({
                  repoId: entry.repoId,
                  repoName: entry.repoName,
                  error: err instanceof Error ? err.message : 'Unknown error',
                });
              }
            }
          } else {
            const entry = repoEntries[0] ?? {
              repoPath: cwd,
              repoId: SINGLE_REPO_USAGE_REPO_ID,
              repoName: basename(cwd),
            };
            const { repoId, repoName } = entry;
            const [hasOriginRemote, hasTracking, hasChanges] =
              await Promise.all([
                getRemoteUrl(cwd).then((remoteUrl) => remoteUrl !== null),
                hasRemoteTrackingBranch(cwd),
                hasUncommittedChanges(cwd),
              ]);

            if (
              request.commitOnly !== true &&
              hasOriginRemote &&
              !hasTracking
            ) {
              skippedRepos.push({ repoName, reason: 'no_remote_tracking' });
            } else if (!hasChanges) {
              skippedRepos.push({ repoName, reason: 'no_uncommitted_changes' });
            } else {
              try {
                const branchName = await getCurrentBranch(cwd);
                const diff = await getUncommittedDiff(cwd);
                const message = await scope.runAgentStep((abortController) =>
                  generateCommitMessage({
                    repoPath: cwd,
                    branchName,
                    diff,
                    model: commitModels.model,
                    fallbackModels: commitModels.fallbackModels,
                    aiCreditsRoutingMode: commitModels.aiCreditsRoutingMode,
                    thinkingLevel: prefs.commitGenerationThinkingLevel,
                    instructions: prefs.commitInstructions,
                    instructionMode: prefs.commitInstructionMode,
                    pluginSelections: prefs.commitGenerationPluginSelections,
                    abortController,
                    auditContext: buildHelperAuditContext(
                      request.projectId,
                      request.worktreeId,
                      repoName,
                      repoId,
                    ),
                  }),
                );
                repos.push({ repoId, repoName, message });
              } catch (err) {
                if (isGitActionCancelledError(err)) throw err;
                failedRepos.push({
                  repoId,
                  repoName,
                  error: err instanceof Error ? err.message : 'Unknown error',
                });
              }
            }
          }

          return { repos, skippedRepos, failedRepos };
        },
      );
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.githubCommitAndPush,
    async (
      event: IpcMainInvokeEvent,
      request: CommitAndPushRequest,
    ): Promise<CommitAndPushResponse> => {
      assertWritableScope(request.projectId);
      return runCancellableGitAction(
        request,
        () => ({
          repos: [],
          skippedRepos: [],
          failedRepos: [],
          agentResolutionRepos: [],
          cancelled: true,
        }),
        async (scope): Promise<CommitAndPushResponse> => {
          const successRepos: CommitAndPushRepoResult[] = [];
          const skippedRepos: CommitAndPushSkippedRepo[] = [];
          const failedRepos: CommitAndPushFailedRepo[] = [];
          const agentResolutionRepos: CommitAndPushAgentResolutionRepo[] = [];
          const { repoEntries } = await resolveRequestedRepoEntries(request);
          const repoCount = gitShippingRepoCount(
            new Set(repoEntries.map((entry) => entry.repoPath)).size,
            request.telemetryRepoCount,
          );
          const prefs = await readPreferencesFile();

          for (const entry of repoEntries) {
            const { repoPath, repoId, repoName } = entry;
            const originUrl = await getRemoteUrl(repoPath);
            const hasOriginRemote = Boolean(originUrl);
            const commitOnly = request.commitOnly === true || !hasOriginRemote;
            let commitPrepared = false;
            // As push-only does: HEAD can move during the fetch, pull or
            // commit, and the push sends whatever HEAD is at that moment.
            const assertHeadUnchanged = async (): Promise<void> => {
              if (
                request.expectedHeadBranch &&
                (await getCurrentBranch(repoPath)) !==
                  request.expectedHeadBranch
              )
                throw new Error('The branch changed. Start a new push.');
            };

            try {
              if (
                request.expectedHeadBranch &&
                (await getCurrentBranch(repoPath)) !==
                  request.expectedHeadBranch
              ) {
                throw new Error(
                  'The branch changed. Start a new commit and push.',
                );
              }
              if (commitOnly) {
                const hasChanges = await hasUncommittedChanges(repoPath);
                if (!hasChanges) {
                  pushSkippedRepo(
                    skippedRepos,
                    entry,
                    'no_uncommitted_changes',
                  );
                  continue;
                }

                const commitHash = await commitRepoAndEmitProgress({
                  caller: runtime.resolveCaller(event),
                  entry,
                  request,
                  prefs,
                  requestedMessage: findRequestedCommitMessage(
                    request,
                    repoId,
                    repoName,
                  ),
                  requireReviewedMessages: request.requireReviewedMessages,
                  cancellation: scope,
                  telemetry: {
                    projectId: request.projectId,
                    source: request.source === 'chat' ? 'chat' : 'manual',
                    flow:
                      request.telemetryFlow === 'pull_request'
                        ? 'pull_request'
                        : 'commit',
                    repoCount,
                  },
                });

                sendRepoCommitProgress(request, 'done', repoName);
                successRepos.push({
                  repoId,
                  repoName,
                  commitHash,
                  status: 'success',
                  operation: 'commit',
                });
                continue;
              }

              try {
                await scope.runGitStep(() =>
                  fetchWorktreeRepository(
                    runtime.dispatcher,
                    runtime.resolveCaller(event),
                    request,
                    entry,
                    { prune: false },
                  ),
                );
              } catch (error) {
                if (classifyGitHubAuthFailure(originUrl, error)) {
                  commitPrepared = !(await hasUncommittedChanges(repoPath));
                  throw new GitHubAuthFailureError(error);
                }
                throw error;
              }
              await assertHeadUnchanged();
              const [hasTracking, hasChanges, hasPendingPush] =
                await Promise.all([
                  hasRemoteTrackingBranch(repoPath),
                  hasUncommittedChanges(repoPath),
                  hasUnpushedCommits(repoPath),
                ]);

              if (!hasTracking) {
                pushSkippedRepo(skippedRepos, entry, 'no_remote_tracking');
                continue;
              }

              if (!hasChanges) {
                commitPrepared = true;
                if (!hasPendingPush) {
                  pushSkippedRepo(
                    skippedRepos,
                    entry,
                    'no_uncommitted_changes',
                  );
                  continue;
                }
                // A Try again never pushes commits on its own: they wait for
                // the bar's Push.
                if (request.skipCleanPush === true) {
                  pushSkippedRepo(skippedRepos, entry, 'commits_not_pushed');
                  continue;
                }

                if (request.pullFirst && (await hasUnpulledCommits(repoPath))) {
                  sendRepoCommitProgress(request, 'pulling', repoName);
                  const branchName = await getCurrentBranch(repoPath);
                  try {
                    await scope.runGitStep(() =>
                      pullWorktreeRepository(
                        runtime.dispatcher,
                        runtime.resolveCaller(event),
                        request,
                        entry,
                        { branch: branchName, strategy: 'rebase' },
                      ),
                    );
                  } catch (pullErr) {
                    if (isGitActionCancelledError(pullErr)) throw pullErr;
                    scope.checkpoint();
                    agentResolutionRepos.push(
                      await resolvePullRebaseFailure({
                        entry,
                        request,
                        prefs,
                        branchName,
                        error: pullErr,
                      }),
                    );
                    sendRepoCommitProgress(request, 'done', repoName);
                    continue;
                  }
                }

                await assertHeadUnchanged();
                sendRepoCommitProgress(request, 'pushing', repoName);
                await scope.runGitStep(() =>
                  pushWorktreeRepository(
                    runtime.dispatcher,
                    runtime.resolveCaller(event),
                    request,
                    entry,
                  ),
                );
                await scheduleSharedContainerPublicationAfterPush(
                  request.projectId,
                  request.worktreeId,
                );

                sendRepoCommitProgress(request, 'done', repoName);
                successRepos.push({
                  repoId,
                  repoName,
                  status: 'success',
                  operation: 'push',
                });
                continue;
              }

              if (request.pullFirst && (await hasUnpulledCommits(repoPath))) {
                sendRepoCommitProgress(request, 'pulling', repoName);
                const branchName = await getCurrentBranch(repoPath);
                try {
                  await scope.runGitStep(() =>
                    pullWorktreeRepository(
                      runtime.dispatcher,
                      runtime.resolveCaller(event),
                      request,
                      entry,
                      { branch: branchName, strategy: 'rebase' },
                    ),
                  );
                } catch (pullErr) {
                  if (isGitActionCancelledError(pullErr)) throw pullErr;
                  scope.checkpoint();
                  agentResolutionRepos.push(
                    await resolvePullRebaseFailure({
                      entry,
                      request,
                      prefs,
                      branchName,
                      error: pullErr,
                      commitMessage: findRequestedCommitMessage(
                        request,
                        repoId,
                        repoName,
                      ),
                    }),
                  );
                  sendRepoCommitProgress(request, 'done', repoName);
                  continue;
                }
              }

              await assertHeadUnchanged();
              const commitHash = await commitRepoAndEmitProgress({
                caller: runtime.resolveCaller(event),
                entry,
                request,
                prefs,
                requestedMessage: findRequestedCommitMessage(
                  request,
                  repoId,
                  repoName,
                ),
                requireReviewedMessages: request.requireReviewedMessages,
                cancellation: scope,
                telemetry: {
                  projectId: request.projectId,
                  source: request.source === 'chat' ? 'chat' : 'manual',
                  flow:
                    request.telemetryFlow === 'pull_request'
                      ? 'pull_request'
                      : 'commit_and_push',
                  repoCount,
                },
              });
              commitPrepared = true;

              await assertHeadUnchanged();
              sendRepoCommitProgress(request, 'pushing', repoName);
              await scope.runGitStep(() =>
                pushWorktreeRepository(
                  runtime.dispatcher,
                  runtime.resolveCaller(event),
                  request,
                  entry,
                ),
              );
              await scheduleSharedContainerPublicationAfterPush(
                request.projectId,
                request.worktreeId,
              );

              sendRepoCommitProgress(request, 'done', repoName);
              successRepos.push({
                repoId,
                repoName,
                commitHash,
                status: 'success',
                operation: 'commit_and_push',
              });
            } catch (err) {
              if (isGitActionCancelledError(err)) throw err;
              pushFailedRepoAndEmitProgress(
                failedRepos,
                request,
                entry,
                err,
                commitPrepared,
              );
            }
          }

          if (
            successRepos.length === 0 &&
            failedRepos.length === 0 &&
            agentResolutionRepos.length === 0 &&
            !skippedRepos.some((repo) => repo.reason === 'commits_not_pushed')
          ) {
            throw new Error('No repos had uncommitted changes to commit.');
          }

          emitFinalRepoOperationProgress(
            request,
            successRepos.length,
            failedRepos.length,
          );
          if (successRepos.length > 0) {
            scope.enterRefreshing();
            refreshAfterSuccessfulRepoOperation(request, successRepos.length);
          }

          return {
            repos: successRepos,
            skippedRepos,
            failedRepos,
            agentResolutionRepos,
          };
        },
      );
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.githubPushOnly,
    async (
      event: IpcMainInvokeEvent,
      request: PushOnlyRequest,
    ): Promise<PushOnlyResponse> => {
      assertWritableScope(request.projectId);
      if (
        (request.establishUpstream || request.pullFirst) &&
        (!request.expectedHeadBranch?.trim() || !request.repoIds?.length)
      )
        throw new Error('Select a repository and branch to continue pushing.');
      return runCancellableGitAction(
        request,
        () => ({
          repos: [],
          skippedRepos: [],
          failedRepos: [],
          cancelled: true,
        }),
        async (scope): Promise<PushOnlyResponse> => {
          const { repoEntries } = await resolveRequestedRepoEntries(request);
          const result = await runRemoteRepoOperation<
            PushOnlyRepoResult,
            PushOnlySkippedRepo['reason']
          >(request, repoEntries, scope, {
            emptyErrorMessage: 'No repos had commits to push.',
            operationPhase: 'pushing',
            preflight: async (
              entry,
            ): Promise<{
              skipReason?: PushOnlySkippedRepo['reason'];
            }> => {
              if (
                request.expectedHeadBranch !== undefined &&
                (await getCurrentBranch(entry.repoPath)) !==
                  request.expectedHeadBranch
              ) {
                throw new Error('The branch changed. Start a new push.');
              }
              const hasOriginRemote = Boolean(
                await getRemoteUrl(entry.repoPath),
              );
              if (!hasOriginRemote) {
                return { skipReason: 'no_remote_origin' };
              }

              if (request.establishUpstream === true) return {};

              const [hasTracking, hasPendingPush] = await Promise.all([
                hasRemoteTrackingBranch(entry.repoPath),
                hasUnpushedCommits(entry.repoPath),
              ]);

              if (!hasTracking) {
                return { skipReason: 'no_remote_tracking' };
              }

              if (!hasPendingPush) {
                return { skipReason: 'no_commits_ahead' };
              }

              return {};
            },
            run: async (entry): Promise<void> => {
              if (
                request.expectedHeadBranch !== undefined &&
                (await getCurrentBranch(entry.repoPath)) !==
                  request.expectedHeadBranch
              )
                throw new Error('The branch changed. Start a new push.');
              if (request.pullFirst) {
                const originUrl = await getRemoteUrl(entry.repoPath);
                try {
                  await scope.runGitStep(() =>
                    fetchWorktreeRepository(
                      runtime.dispatcher,
                      runtime.resolveCaller(event),
                      request,
                      entry,
                      { prune: false },
                    ),
                  );
                } catch (error) {
                  if (classifyGitHubAuthFailure(originUrl, error))
                    throw new GitHubAuthFailureError(error);
                  throw error;
                }
                const branch = await getCurrentBranch(entry.repoPath);
                if (branch !== request.expectedHeadBranch)
                  throw new Error('The branch changed. Start a new push.');
                if (await hasUnpulledCommits(entry.repoPath)) {
                  sendRepoCommitProgress(request, 'pulling', entry.repoName);
                  await scope.runGitStep(() =>
                    pullWorktreeRepository(
                      runtime.dispatcher,
                      runtime.resolveCaller(event),
                      request,
                      entry,
                      { branch, strategy: 'rebase' },
                    ),
                  );
                }
                if (
                  (await getCurrentBranch(entry.repoPath)) !==
                  request.expectedHeadBranch
                )
                  throw new Error('The branch changed. Start a new push.');
              }
              await pushWorktreeRepository(
                runtime.dispatcher,
                runtime.resolveCaller(event),
                request,
                entry,
              );
              await scheduleSharedContainerPublicationAfterPush(
                request.projectId,
                request.worktreeId,
              );
            },
            buildSuccess: (entry): PushOnlyRepoResult => ({
              repoId: entry.repoId,
              repoName: entry.repoName,
              status: 'success',
            }),
          });

          return {
            repos: result.repos,
            skippedRepos: result.skippedRepos,
            failedRepos: result.failedRepos,
          };
        },
      );
    },
  );

  // ---- Pull (worker.git.fetch, worker.git.pull) ----
  registerIpcHandler(
    IPC_CHANNELS.githubPull,
    async (
      event: IpcMainInvokeEvent,
      request: WorktreePullRequest,
    ): Promise<PullResponse> => {
      assertWritableScope(request.projectId);
      return runCancellableGitAction(
        request,
        () => ({
          repos: [],
          skippedRepos: [],
          failedRepos: [],
          agentResolutionRepos: [],
          cancelled: true,
        }),
        async (scope): Promise<PullResponse> => {
          const { repoEntries } = await resolveAllRepoEntries(request);
          const prefs = await readPreferencesFile();
          // Resolved before any repository's Git: an untracked sender is
          // refused here, not reported per repository.
          const caller = runtime.resolveCaller(event);
          const successRepos: PullRepoResult[] = [];
          const skippedRepos: PullSkippedRepo[] = [];
          const failedRepos: PullResponse['failedRepos'] = [];
          const agentResolutionRepos: PullAgentResolutionRepo[] = [];

          for (const entry of repoEntries) {
            scope.checkpoint();
            const originUrl = await getRemoteUrl(entry.repoPath);
            if (!originUrl) {
              pushSkippedRepo(skippedRepos, entry, 'no_remote_origin');
              continue;
            }

            // Pull visibility is derived from local origin/* refs. Prune before
            // checking them so a branch deleted on the remote is no longer
            // presented as pullable. A failed fetch fails the repository:
            // stale refs would report nothing to pull.
            try {
              await scope.runGitStep(() =>
                fetchWorktreeRepository(
                  runtime.dispatcher,
                  caller,
                  request,
                  entry,
                  { prune: true },
                ),
              );
            } catch (error) {
              if (isGitActionCancelledError(error)) throw error;
              pushFailedRepoAndEmitProgress(
                failedRepos,
                request,
                entry,
                classifyGitHubAuthFailure(originUrl, error)
                  ? new GitHubAuthFailureError(error)
                  : error,
              );
              continue;
            }
            const [hasTracking, isBehind, isAhead] = await Promise.all([
              hasRemoteTrackingBranch(entry.repoPath),
              hasUnpulledCommits(entry.repoPath),
              hasUnpushedCommits(entry.repoPath),
            ]);

            if (!hasTracking) {
              pushSkippedRepo(skippedRepos, entry, 'no_remote_tracking');
              continue;
            }

            if (!isBehind) {
              pushSkippedRepo(skippedRepos, entry, 'not_behind');
              continue;
            }

            try {
              sendRepoCommitProgress(request, 'pulling', entry.repoName);
              const branchName = await getCurrentBranch(entry.repoPath);
              if (isAhead) {
                try {
                  await scope.runGitStep(() =>
                    pullWorktreeRepository(
                      runtime.dispatcher,
                      caller,
                      request,
                      entry,
                      { branch: branchName, strategy: 'rebase' },
                    ),
                  );
                  successRepos.push({
                    repoId: entry.repoId,
                    repoName: entry.repoName,
                    status: 'success',
                  });
                } catch (pullErr) {
                  if (isGitActionCancelledError(pullErr)) throw pullErr;
                  scope.checkpoint();
                  agentResolutionRepos.push(
                    await resolvePullRebaseFailure({
                      entry,
                      request,
                      prefs,
                      branchName,
                      error: pullErr,
                    }),
                  );
                }
                sendRepoCommitProgress(request, 'done', entry.repoName);
                continue;
              }

              await scope.runGitStep(() =>
                pullWorktreeRepository(
                  runtime.dispatcher,
                  caller,
                  request,
                  entry,
                  { branch: branchName, strategy: 'fast-forward' },
                ),
              );
              sendRepoCommitProgress(request, 'done', entry.repoName);
              successRepos.push({
                repoId: entry.repoId,
                repoName: entry.repoName,
                status: 'success',
              });
            } catch (err) {
              if (isGitActionCancelledError(err)) throw err;
              // The branch can be deleted after the preflight fetch but before the
              // pull reaches the remote. Reconcile origin/* again so the renderer's
              // post-error local stats refresh hides the stale Pull action. Best
              // effort through fetchOrigin's swallowing path: recorded debt
              // (CAN-5517), not worker.git.fetch, which reports failures.
              await scope.runGitStep(() =>
                fetchOrigin(entry.repoPath, { prune: true }),
              );
              pushFailedRepoAndEmitProgress(failedRepos, request, entry, err);
            }
          }

          if (
            successRepos.length === 0 &&
            failedRepos.length === 0 &&
            agentResolutionRepos.length === 0
          ) {
            throw new Error('No repos needed to pull.');
          }

          emitFinalRepoOperationProgress(
            request,
            successRepos.length,
            failedRepos.length,
          );
          if (successRepos.length > 0) {
            scope.enterRefreshing();
            refreshAfterSuccessfulRepoOperation(request, successRepos.length);
          }

          return {
            repos: successRepos,
            skippedRepos,
            failedRepos,
            agentResolutionRepos,
          };
        },
      );
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.githubMergeLocalBranches,
    async (
      event: IpcMainInvokeEvent,
      request: MergeLocalBranchesRequest,
    ): Promise<MergeLocalBranchesResponse> => {
      assertWritableScope(request.projectId);
      return runCancellableGitAction(
        request,
        () => ({
          repos: [],
          skippedRepos: [],
          failedRepos: [],
          cancelled: true,
        }),
        async (scope): Promise<MergeLocalBranchesResponse> => {
          // Match github:pull: reject untracked senders once, before repository Git.
          const caller = runtime.resolveCaller(event);
          const { repoEntries } = await resolveRequestedRepoEntries(request);
          const repos: MergeLocalBranchRepoResult[] = [];
          const skippedRepos: MergeLocalBranchSkippedRepo[] = [];
          const failedRepos: MergeLocalBranchFailedRepo[] = [];

          for (const entry of repoEntries) {
            scope.checkpoint();
            const { repoPath, repoId, repoName } = entry;
            let branchName: string | undefined;
            let baseBranch: string | undefined;

            try {
              const hasOriginRemote = Boolean(await getRemoteUrl(repoPath));
              if (hasOriginRemote) {
                skippedRepos.push({
                  repoId,
                  repoName,
                  reason: 'has_remote_origin',
                });
                continue;
              }

              if (await hasUncommittedChanges(repoPath)) {
                skippedRepos.push({
                  repoId,
                  repoName,
                  reason: 'uncommitted_changes',
                });
                continue;
              }

              branchName = await getCurrentBranch(repoPath);
              if (branchName === 'HEAD') {
                failedRepos.push({
                  repoId,
                  repoName,
                  branchName,
                  error:
                    'Cannot merge from detached HEAD. Check out a named branch first.',
                  status: 'failed',
                });
                continue;
              }

              const effectiveBaseBranch =
                await resolveEffectiveBaseBranchForRepo({
                  projectId: request.projectId,
                  worktreeId: request.worktreeId,
                  repoId,
                  repoPath,
                });
              baseBranch = effectiveBaseBranch.branch ?? undefined;

              if (!baseBranch || !effectiveBaseBranch.existsLocally) {
                skippedRepos.push({
                  repoId,
                  repoName,
                  reason: 'missing_base_branch',
                });
                continue;
              }

              if (branchName === baseBranch) {
                skippedRepos.push({
                  repoId,
                  repoName,
                  reason: 'same_branch',
                });
                continue;
              }

              const hasCommittedChanges = await hasCommitsAhead(
                repoPath,
                baseBranch,
              );
              if (!hasCommittedChanges) {
                skippedRepos.push({
                  repoId,
                  repoName,
                  reason: 'no_commits_ahead',
                });
                continue;
              }

              const resolvedBranchName = branchName;
              const resolvedBaseBranch = baseBranch;
              const mergeCommitHash = await scope.runGitStep(() =>
                mergeWorktreeRepository(
                  runtime.dispatcher,
                  caller,
                  request,
                  entry,
                  {
                    sourceBranch: resolvedBranchName,
                    baseBranch: resolvedBaseBranch,
                  },
                ),
              );
              repos.push({
                repoId,
                repoName,
                branchName: resolvedBranchName,
                baseBranch: resolvedBaseBranch,
                mergeCommitHash,
                status: 'success',
              });
            } catch (error) {
              if (isGitActionCancelledError(error)) throw error;
              failedRepos.push({
                repoId,
                repoName,
                branchName,
                baseBranch,
                error: error instanceof Error ? error.message : 'Unknown error',
                status: 'failed',
              });
            }
          }

          if (
            repos.length === 0 &&
            failedRepos.length === 0 &&
            skippedRepos.length > 0 &&
            skippedRepos.every((repo) => repo.reason === 'has_remote_origin')
          ) {
            throw new Error(
              'No local-only repos had committed changes to merge.',
            );
          }

          if (repos.length > 0) {
            scope.enterRefreshing();
            requestRefresh(request.projectId, request.worktreeId, true);
            enqueueFastRefresh(request.projectId, request.worktreeId, false);
          }

          return { repos, skippedRepos, failedRepos };
        },
      );
    },
  );

  // A Merge click waits on its PR reads, so they go ahead of background
  // polling in the GitHub request queue.
  const MERGE_CLICK_READ = { priority: 'high' } as const;

  const mergeWorktreePr = {
    run: async (
      request: MergePrRequest,
      mergePullRequest: PullRequestMergeStep,
    ): Promise<MergePrResponse> => {
      const dryRun = request.dryRun === true;
      const verifiedRepos: MergePrVerifiedRepo[] = [];
      const mergedRepos: MergePrRepoResult[] = [];
      const mergeQueueChats: MergePrQueueChatResult[] = [];
      const requiresUnresolvedConfirmation: MergePrUnresolvedRepo[] = [];
      const failedRepos: MergePrFailedRepo[] = [];
      const deferredQueueRepos: Array<{
        entry: RepoEntry;
        branchName: string;
        prNumber: number;
        prUrl: string;
      }> = [];
      // The Settings > Git merge queue choice, read once per request.
      let mergeQueueHandling: Promise<MergeQueueAgentHandling> | undefined;
      const readMergeQueueHandling = (): Promise<MergeQueueAgentHandling> => {
        mergeQueueHandling ??= readPreferencesFile().then(
          (prefs) =>
            isMergeQueueAgentHandling(prefs.mergeQueueAgentHandling)
              ? prefs.mergeQueueAgentHandling
              : DEFAULT_MERGE_QUEUE_AGENT_HANDLING,
          () => DEFAULT_MERGE_QUEUE_AGENT_HANDLING,
        );
        return mergeQueueHandling;
      };
      // Whether this repository's merge goes to a merge-pr chat instead of
      // the GitHub API. A failed hook lookup counts as no hook, so the chat
      // still oversees the merge.
      const mergeStartsAgentChat = async (
        entry: RepoEntry,
        status: PrStatusData,
      ): Promise<boolean> => {
        if (status.mergeQueue?.required !== true) return false;
        const handling = await readMergeQueueHandling();
        const queueRemovedHookActive =
          handling === 'when_hook_absent' &&
          (await isPrHookActiveForRepo({
            projectId: request.projectId,
            worktreeId: request.worktreeId,
            repoId: entry.repoId,
            triggerName: 'pr:queue:removed',
          }).catch((error: unknown) => {
            logMainProcessWarn(
              '[github-merge-pr] merge queue hook lookup failed:',
              error,
            );
            return false;
          }));
        return prMergeStartsAgentChat({
          status,
          handling,
          queueRemovedHookActive,
        });
      };
      // A queued PR still gets a chat to inspect/watch its existing entry.
      const readyForMergeAction = (
        status: PrStatusData,
        startsAgentChat: boolean,
      ): boolean =>
        isPrReadyToMerge(status) ||
        (startsAgentChat && isPrInMergeQueue(status) && !status.hasConflicts);
      return runCancellableGitAction(
        request,
        () => ({
          dryRun,
          verifiedRepos,
          mergedRepos,
          mergeQueueChats,
          requiresUnresolvedConfirmation,
          failedRepos,
          cancelled: true,
        }),
        async (scope): Promise<MergePrResponse> => {
          const { repoEntries } = await resolveRequestedRepoEntries(request);
          const repoCount = new Set(repoEntries.map((entry) => entry.repoPath))
            .size;

          const processRepoEntry = async (entry: RepoEntry): Promise<void> => {
            scope.checkpoint();
            const { repoPath, repoId, repoName } = entry;
            let prNumber: number | undefined;

            try {
              const runMergeForRepo = async (): Promise<void> => {
                scope.checkpoint();
                if (!dryRun) {
                  sendMergePrProgress({
                    projectId: request.projectId,
                    worktreeId: request.worktreeId,
                    repoId,
                    repoName,
                    phase: 'checking_mergeability',
                  });
                }

                const branchName = await getCurrentBranch(repoPath);
                if (branchName === 'HEAD') {
                  // Detached HEAD has no branch to resolve a PR against.
                  return;
                }

                // Always re-verify against GitHub so the warning modal can surface
                // even when the cached status was not a warning. For real merge
                // attempts, keep retrying GitHub's transient not-mergeable states
                // before warning the user.
                let tracking = await fetchRepoPrTrackingData(
                  repoPath,
                  branchName,
                  MERGE_CLICK_READ,
                );
                scope.checkpoint();
                let status = tracking.status;
                if (!status || status.state !== 'open') {
                  // No open PR for this repo; not a merge candidate.
                  return;
                }
                const initialBaseRefName = status.baseRefName;
                let baseChangedDuringRetry = false;

                for (const delayMs of PR_MERGE_RETRY_DELAYS_MS) {
                  if (
                    isPrReadyToMerge(status) ||
                    status.hasConflicts ||
                    // An existing queue entry can be inspected by the skill.
                    isPrInMergeQueue(status) ||
                    baseChangedDuringRetry ||
                    dryRun
                  ) {
                    break;
                  }
                  sendMergePrProgress({
                    projectId: request.projectId,
                    worktreeId: request.worktreeId,
                    repoId,
                    repoName,
                    phase: 'waiting_mergeability',
                    retryDelayMs: delayMs,
                  });
                  await delay(delayMs);
                  scope.checkpoint();
                  sendMergePrProgress({
                    projectId: request.projectId,
                    worktreeId: request.worktreeId,
                    repoId,
                    repoName,
                    phase: 'checking_mergeability',
                  });
                  tracking = await fetchRepoPrTrackingData(
                    repoPath,
                    branchName,
                    MERGE_CLICK_READ,
                  );
                  scope.checkpoint();
                  if (!tracking.status || tracking.status.state !== 'open') {
                    status = tracking.status;
                    break;
                  }
                  status = tracking.status;
                  if (
                    initialBaseRefName &&
                    status.baseRefName &&
                    status.baseRefName !== initialBaseRefName
                  ) {
                    baseChangedDuringRetry = true;
                    break;
                  }
                }

                if (!status || status.state !== 'open') {
                  return;
                }

                let verifiedBranchName = branchName;
                if (
                  !dryRun &&
                  (request.expectedBaseBranch !== undefined ||
                    request.expectedHeadBranch !== undefined ||
                    request.expectedPrNumber !== undefined)
                ) {
                  verifiedBranchName = await getCurrentBranch(repoPath);
                  tracking = await fetchRepoPrTrackingData(
                    repoPath,
                    verifiedBranchName,
                    MERGE_CLICK_READ,
                  );
                  scope.checkpoint();
                  status = tracking.status;
                  if (!status || status.state !== 'open') {
                    throw new Error('PR state changed. Refresh and try again.');
                  }
                }

                prNumber = status.prNumber;
                const expectedIdentityMatches =
                  (request.expectedBaseBranch === undefined ||
                    status.baseRefName === request.expectedBaseBranch) &&
                  (request.expectedHeadBranch === undefined ||
                    verifiedBranchName === request.expectedHeadBranch) &&
                  (request.expectedPrNumber === undefined ||
                    status.prNumber === request.expectedPrNumber);
                if (!expectedIdentityMatches) {
                  throw new Error('PR state changed. Refresh and try again.');
                }
                const unresolvedReviewThreadCount =
                  status.unresolvedReviewThreadCount;
                const startsAgentChat = await mergeStartsAgentChat(
                  entry,
                  status,
                );
                scope.checkpoint();

                if (
                  !readyForMergeAction(status, startsAgentChat) ||
                  baseChangedDuringRetry
                ) {
                  verifiedRepos.push({
                    repoId,
                    repoName,
                    prNumber: status.prNumber,
                    prUrl: status.prUrl,
                    mergeable: false,
                    usesMergeQueue: status.mergeQueue?.required === true,
                    startsAgentChat,
                    unresolvedReviewThreadCount,
                    blockedReason: baseChangedDuringRetry
                      ? 'base_changed'
                      : status.hasConflicts
                        ? 'has_conflicts'
                        : isPrInMergeQueue(status)
                          ? 'in_merge_queue'
                          : 'not_mergeable',
                  });
                  return;
                }

                verifiedRepos.push({
                  repoId,
                  repoName,
                  prNumber: status.prNumber,
                  prUrl: status.prUrl,
                  mergeable: true,
                  usesMergeQueue: status.mergeQueue?.required === true,
                  startsAgentChat,
                  unresolvedReviewThreadCount,
                });

                if (
                  unresolvedReviewThreadCount !== 0 &&
                  request.confirmUnresolvedComments !== true
                ) {
                  requiresUnresolvedConfirmation.push({
                    repoId,
                    repoName,
                    prNumber: status.prNumber,
                    prUrl: status.prUrl,
                    unresolvedReviewThreadCount,
                  });
                  return;
                }

                if (dryRun) {
                  return;
                }

                if (startsAgentChat) {
                  deferredQueueRepos.push({
                    entry,
                    branchName: verifiedBranchName,
                    prNumber: status.prNumber,
                    prUrl: status.prUrl,
                  });
                  return;
                }

                if (!status.headSha) {
                  throw new Error(
                    'Cannot merge the pull request because GitHub did not return a verified head commit SHA.',
                  );
                }

                sendMergePrProgress({
                  projectId: request.projectId,
                  worktreeId: request.worktreeId,
                  repoId,
                  repoName,
                  phase: 'merging',
                });
                const verifiedHeadSha = status.headSha;
                const mergePrNumber = status.prNumber;
                const result = await scope.runGitStep(async () => {
                  const merged = await mergePullRequest({
                    projectId: request.projectId,
                    repoId: entry.repoId,
                    repoPath,
                    prNumber: mergePrNumber,
                    expectedHeadSha: verifiedHeadSha,
                  });
                  if (
                    merged.outcome === 'merged' &&
                    merged.newlyMerged === true
                  ) {
                    try {
                      recordPullRequestMergedTelemetry({
                        projectId: request.projectId,
                        source: request.source === 'chat' ? 'chat' : 'manual',
                        flow: 'merge',
                        repoCount,
                      });
                    } catch {
                      /* Best effort. */
                    }
                  }
                  return merged;
                });
                mergedRepos.push({
                  repoId,
                  repoName,
                  prNumber: status.prNumber,
                  prUrl: status.prUrl,
                  mergeMethod: result.mergeMethod,
                  mergeCommitSha: result.mergeCommitSha,
                  status: result.outcome,
                  ...(result.outcome === 'enqueued'
                    ? { queuePosition: result.queuePosition ?? null }
                    : {}),
                });
                sendMergePrProgress({
                  projectId: request.projectId,
                  worktreeId: request.worktreeId,
                  repoId,
                  repoName,
                  phase: 'done',
                });
              };

              const hasOpenPrMergeCandidate = async (): Promise<boolean> => {
                const branchName = await getCurrentBranch(repoPath);
                if (branchName === 'HEAD') {
                  return false;
                }
                const tracking = await fetchRepoPrTrackingData(
                  repoPath,
                  branchName,
                  MERGE_CLICK_READ,
                );
                return Boolean(
                  tracking.status && tracking.status.state === 'open',
                );
              };

              if (dryRun) {
                await runMergeForRepo();
              } else if (await hasOpenPrMergeCandidate()) {
                scope.checkpoint();
                const queueKey = await getGithubRepoMergeQueueKey(repoPath);
                await enqueuePrMergeForGithubRepo(
                  queueKey,
                  runMergeForRepo,
                  (queuePosition, queueLength) => {
                    sendMergePrProgress({
                      projectId: request.projectId,
                      worktreeId: request.worktreeId,
                      repoId,
                      repoName,
                      phase: 'queued',
                      queuePosition,
                      queueLength,
                    });
                  },
                  scope,
                );
              }
            } catch (error) {
              if (isGitActionCancelledError(error)) throw error;
              if (!dryRun) {
                sendMergePrProgress({
                  projectId: request.projectId,
                  worktreeId: request.worktreeId,
                  repoId,
                  repoName,
                  phase: 'error',
                  error:
                    error instanceof Error ? error.message : 'Unknown error',
                });
              }
              failedRepos.push({
                repoId,
                repoName,
                prNumber,
                error: error instanceof Error ? error.message : 'Unknown error',
                status: 'failed',
              });
            }
          };

          if (dryRun) {
            // The picker only reads GitHub state, so repositories can be checked in
            // parallel. Keep the response in workspace order even when requests
            // finish out of order.
            await Promise.all(repoEntries.map(processRepoEntry));
            const repoOrder = new Map(
              repoEntries.map((entry, index) => [
                entry.repoId ?? entry.repoName,
                index,
              ]),
            );
            const compareRepoOrder = (
              left: { repoId?: string; repoName: string },
              right: { repoId?: string; repoName: string },
            ): number =>
              (repoOrder.get(left.repoId ?? left.repoName) ?? 0) -
              (repoOrder.get(right.repoId ?? right.repoName) ?? 0);
            verifiedRepos.sort(compareRepoOrder);
            requiresUnresolvedConfirmation.sort(compareRepoOrder);
            failedRepos.sort(compareRepoOrder);
          } else {
            // Actual merges remain ordered; the per-GitHub-repository queue below
            // protects concurrent merge requests for the same repository.
            for (const entry of repoEntries) {
              scope.checkpoint();
              await processRepoEntry(entry);
            }
          }

          // Standard attempts finish first. Chat dispatch happens outside the
          // local repository FIFO, which never owns the chat's lifecycle.
          for (const deferred of deferredQueueRepos) {
            scope.checkpoint();
            const { repoId, repoName } = deferred.entry;
            try {
              const prefs = await readPreferencesFile();
              scope.checkpoint();
              const result = await launchMergeQueueChat({
                projectId: request.projectId,
                worktreeId: request.worktreeId,
                ...(isMultiRepoWorkspace(request.projectId)
                  ? { selectedRepoId: repoId }
                  : {}),
                prefs,
                context: {
                  repoName,
                  branchName: deferred.branchName,
                  prNumber: deferred.prNumber,
                  prUrl: deferred.prUrl,
                },
                getWindow,
              });
              mergeQueueChats.push({
                repoId,
                repoName,
                prNumber: deferred.prNumber,
                prUrl: deferred.prUrl,
                chatId: result.chatId,
              });
              sendMergePrProgress({
                projectId: request.projectId,
                worktreeId: request.worktreeId,
                repoId,
                repoName,
                phase: 'done',
              });
            } catch (error) {
              if (isGitActionCancelledError(error)) throw error;
              const message =
                error instanceof Error ? error.message : 'Unknown error';
              failedRepos.push({
                repoId,
                repoName,
                prNumber: deferred.prNumber,
                error: message,
                status: 'failed',
              });
              sendMergePrProgress({
                projectId: request.projectId,
                worktreeId: request.worktreeId,
                repoId,
                repoName,
                phase: 'error',
                error: message,
              });
            }
          }

          // After a verified merge or enqueue, force-refresh PR tracking so the
          // worktree reflects the merged or queued state immediately (the
          // renderer marks it "done" when the merged status event arrives).
          if (mergedRepos.length > 0) {
            scope.enterRefreshing();
            sendMergePrProgress({
              projectId: request.projectId,
              worktreeId: request.worktreeId,
              phase: 'refreshing_pr_status',
            });
            await refreshNow(request.projectId, request.worktreeId).catch(
              (error) => {
                logMainProcessWarn(
                  '[github-merge-pr] post-merge refresh failed:',
                  error,
                );
              },
            );
            try {
              enqueueFastRefresh(request.projectId, request.worktreeId, false);
            } catch (error) {
              logMainProcessWarn(
                '[github-merge-pr] post-merge fast refresh enqueue failed:',
                error,
              );
            }
            sendMergePrProgress({
              projectId: request.projectId,
              worktreeId: request.worktreeId,
              phase: 'done',
            });
          }

          return {
            dryRun,
            verifiedRepos,
            mergedRepos,
            mergeQueueChats,
            requiresUnresolvedConfirmation,
            failedRepos,
          };
        },
        request.dryRun === true
          ? undefined
          : {
              onStart: () =>
                beginPrMergeProgress(request.projectId, request.worktreeId),
              onFinish: () =>
                finishPrMergeProgress(request.projectId, request.worktreeId),
            },
      );
    },
  };

  registerIpcHandler(
    IPC_CHANNELS.githubMergePr,
    (event, request: MergePrRequest) => {
      assertWritableScope(request.projectId);
      return mergeWorktreePr.run(
        request,
        dispatchedPullRequestMerge(runtime.dispatcher, () =>
          runtime.resolveCaller(event),
        ),
      );
    },
  );

  registerPortalPrStatusProjection();
  registerWorktreePrActions({
    create: (request) => {
      assertWritableScope(request.projectId);
      return createWorktreePr.run(request, createPullRequestDirectly);
    },
    merge: (request) => {
      assertWritableScope(request.projectId);
      return mergeWorktreePr.run(request, mergePullRequestDirectly);
    },
    state: async (target) => {
      const { repoEntries } = await resolveAllRepoEntries(target);
      const state = await refreshPullRequestState({
        workspaceLocalId: target.projectId,
        worktreeLocalId: target.worktreeId,
      });
      const repos = await Promise.all(
        repoEntries.map(async (entry) => {
          const repoId = entry.repoId ?? SINGLE_REPO_USAGE_REPO_ID;
          const projectedRepo =
            state.repos?.find((repo) => repo.repoId === repoId) ??
            (repoEntries.length === 1 ? state.repos?.[0] : undefined);
          const status = projectedRepo?.status ?? null;
          const [origin, dirty, branch] = await Promise.all([
            getRemoteUrl(entry.repoPath),
            hasUncommittedChanges(entry.repoPath),
            getCurrentBranch(entry.repoPath),
          ]);
          const resolvedBase = await resolvePrBaseBranchForRepo({
            ...target,
            repoId: entry.repoId,
            repoPath: entry.repoPath,
          }).catch(() => null);
          const divergence = origin
            ? await readRemoteBranchDivergence(entry.repoPath, branch)
            : null;
          const changes = await repoHasChanges(
            entry.repoPath,
            target.projectId,
            target.worktreeId,
            entry.repoId,
            dirty,
            resolvedBase,
          );
          const actionBaseBranch =
            (status?.state === 'open' || status?.state === 'draft') &&
            status.baseRefName
              ? status.baseRefName
              : resolvedBase?.baseBranch;
          const unpushed =
            divergence?.remoteBranchExists === true
              ? divergence.ahead > 0
              : status?.state === 'open' ||
                status?.state === 'draft' ||
                changes;
          return {
            repoId,
            repoName: entry.repoName,
            status,
            published: origin ? divergence?.remoteBranchExists : false,
            baseBranch: actionBaseBranch,
            headBranch: branch,
            createBlockedReason: resolvePrCreateBlockedReason({
              status,
              prLookupAvailable: projectedRepo?.prLookupAvailable === true,
              branch,
              baseBranch: actionBaseBranch ?? null,
              hasOrigin: Boolean(origin),
              hasChanges: changes,
              behindRemote: (divergence?.behind ?? 0) > 0,
            }),
            mergeBlockedReason: resolvePrMergeBlockedReason({
              status,
              dirty,
              unpushed,
            }),
            cleanForMerge: !dirty && !unpushed,
            mergeWarning:
              status?.unresolvedReviewThreadCount === undefined ||
              status.unresolvedReviewThreadCount > 0,
          };
        }),
      );
      // One dirty sibling blocks every merge, so a clean repo still has to say
      // why its button is gone.
      const allClean = repos.every((repo) => repo.cleanForMerge);
      return {
        busy:
          isGitActionActive(target) ||
          isSplitLocked(target.projectId, target.worktreeId),
        repos: repos.map((repo) => {
          const mergeBlockedReason =
            repo.mergeBlockedReason ??
            (allClean ? undefined : 'other_repo_changes');
          return {
            repoId: repo.repoId,
            repoName: repo.repoName,
            status: repo.status,
            published: repo.published,
            baseBranch: repo.baseBranch,
            headBranch: repo.headBranch,
            mergeWarning: repo.mergeWarning,
            createBlockedReason: repo.createBlockedReason,
            mergeBlockedReason,
            canCreate: repo.createBlockedReason === undefined,
            canMerge: mergeBlockedReason === undefined,
          };
        }),
      };
    },
  });

  registerIpcHandler(
    IPC_CHANNELS.githubStartMergeConflictResolution,
    async (
      _event: IpcMainInvokeEvent,
      request: StartMergeConflictResolutionRequest,
    ): Promise<StartMergeConflictResolutionResponse> => {
      validateId(request.projectId, 'projectId');
      assertWritableScope(request.projectId);
      validateId(request.worktreeId, 'worktreeId');
      if (request.repoId !== undefined) {
        validateRepoIdOrWorkspaceRoot(request.repoId);
      }
      const prefs = await readPreferencesFile();
      return launchMergeConflictResolutionChat({
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        selectedRepoId: request.repoId,
        prefs,
        context: {
          repoName: request.repoName,
          branchName: request.branchName,
        },
        getWindow,
      });
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.githubStartPrCommentTriage,
    async (
      _event: IpcMainInvokeEvent,
      request: StartPrCommentTriageRequest,
    ): Promise<StartPrCommentTriageResponse> => {
      validateId(request.projectId, 'projectId');
      assertWritableScope(request.projectId);
      validateId(request.worktreeId, 'worktreeId');
      if (request.repoId !== undefined) {
        validateRepoIdOrWorkspaceRoot(request.repoId);
      }
      const prefs = await readPreferencesFile();
      return launchPrCommentTriageChat({
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        selectedRepoId: request.repoId,
        prefs,
        context: {
          repoName: request.repoName,
          branchName: request.branchName,
        },
        getWindow,
      });
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.githubStartCiCheckFix,
    async (
      _event: IpcMainInvokeEvent,
      request: StartCiCheckFixRequest,
    ): Promise<StartCiCheckFixResponse> => {
      validateId(request.projectId, 'projectId');
      assertWritableScope(request.projectId);
      validateId(request.worktreeId, 'worktreeId');
      if (request.repoId !== undefined) {
        validateRepoIdOrWorkspaceRoot(request.repoId);
      }
      const prefs = await readPreferencesFile();
      return launchCiCheckFixChat({
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        selectedRepoId: request.repoId,
        prefs,
        context: {
          repoName: request.repoName,
          branchName: request.branchName,
        },
        getWindow,
      });
    },
  );

  // core.integration.resource.list (CAN-4109).
  registerIpcHandler(
    IPC_CHANNELS.githubListUserRepos,
    async (event: IpcMainInvokeEvent): Promise<GitHubRepoSummary[]> =>
      listUserReposForIpc(runtime.dispatcher, () =>
        runtime.resolveCaller(event),
      ),
  );

  // core.pullRequest.get (CAN-4109).
  registerIpcHandler(
    IPC_CHANNELS.githubResolvePullRequest,
    async (
      event: IpcMainInvokeEvent,
      request: ResolvePullRequestRequest,
    ): Promise<ResolvePullRequestResponse> =>
      resolvePullRequestForIpc(
        runtime.dispatcher,
        () => runtime.resolveCaller(event),
        request,
      ),
  );

  // core.pullRequest.list (CAN-4109).
  registerIpcHandler(
    IPC_CHANNELS.githubListPullRequests,
    async (
      event: IpcMainInvokeEvent,
      request: ListPullRequestsRequest,
    ): Promise<ListPullRequestsResponse> =>
      listPullRequestsForIpc(
        runtime.dispatcher,
        () => runtime.resolveCaller(event),
        request,
      ),
  );

  registerIpcHandler(
    IPC_CHANNELS.githubSearchPullRequests,
    async (
      event: IpcMainInvokeEvent,
      request: unknown,
    ): Promise<SearchPullRequestsResponse> =>
      handleSearchPullRequestsRequest(request, runtime.dispatcher, () =>
        runtime.resolveCaller(event),
      ),
  );

  registerIpcHandler(
    IPC_CHANNELS.githubGetMergeQueue,
    async (
      event: IpcMainInvokeEvent,
      request: GitHubMergeQueueRequest,
    ): Promise<GitHubMergeQueueResponse> =>
      getMergeQueueForIpc(
        runtime.dispatcher,
        () => runtime.resolveCaller(event),
        request,
      ),
  );

  // worker.git.remote.get for a recorded path (CAN-4109 D5).
  registerIpcHandler(
    IPC_CHANNELS.githubGetRepoSlug,
    async (
      event: IpcMainInvokeEvent,
      request: GetRepoSlugRequest,
    ): Promise<GetRepoSlugResponse> =>
      getRepoSlugForIpc(
        runtime.dispatcher,
        () => runtime.resolveCaller(event),
        request,
      ),
  );

  // core.pullRequest.update (CAN-4109).
  registerIpcHandler(
    IPC_CHANNELS.githubUpdatePrBaseBranch,
    async (
      event: IpcMainInvokeEvent,
      request: UpdatePrBaseBranchRequest,
    ): Promise<UpdatePrBaseBranchResponse> => {
      validateId(request.projectId, 'projectId');
      assertWritableScope(request.projectId);
      validateId(request.worktreeId, 'worktreeId');
      if (request.repoId) {
        validateRepoIdOrWorkspaceRoot(request.repoId);
      }
      validatePrNumber(request.prNumber);
      const newBaseBranch = validateBaseBranchName(request.newBaseBranch);

      const cwd = resolveWorktreeCwd(request.projectId, request.worktreeId);
      let repoPath = cwd;

      if (request.repoId && isMultiRepoWorkspace(request.projectId)) {
        const entries = await listWorkspaceWorktreeRepoEntries(
          request.projectId,
          cwd,
        );
        const entry = entries.find((e) => e.repoId === request.repoId);
        if (!entry) {
          throw new Error(`Repo ${request.repoId} not found in project.`);
        }
        repoPath = entry.repoPath;
      }

      const { prUrl } = await updatePullRequestBaseForIpc(
        runtime.dispatcher,
        () => runtime.resolveCaller(event),
        {
          projectId: request.projectId,
          repoId: request.repoId,
          repoPath,
          prNumber: request.prNumber,
          newBaseBranch,
        },
      );

      enqueueFastRefresh(request.projectId, request.worktreeId, false);

      return { success: true, prUrl };
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.githubSplitPrPlan,
    async (
      _event: IpcMainInvokeEvent,
      request: SplitPrPlanRequest,
    ): Promise<SplitPrPlanResult> => {
      validateId(request.projectId, 'projectId');
      assertWritableScope(request.projectId);
      validateId(request.worktreeId, 'worktreeId');
      try {
        const response = await planPrSplit({
          projectId: request.projectId,
          worktreeId: request.worktreeId,
        });
        return { status: 'ok', response };
      } catch (error) {
        if (error instanceof PrSplitPlanningError) {
          return {
            status: 'refused',
            code: error.code,
            message: error.message,
            ...(error.issues.length > 0 ? { issues: error.issues } : {}),
          };
        }
        throw error;
      }
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.githubSplitPrCancel,
    (_event: IpcMainInvokeEvent, request: SplitPrCancelRequest): void => {
      validateId(request.projectId, 'projectId');
      assertWritableScope(request.projectId);
      validateId(request.worktreeId, 'worktreeId');

      const key = splitPrRunKey(request.projectId, request.worktreeId);
      splitPrAbortControllers.get(key)?.abort();
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.githubSplitPrDiscard,
    async (
      _event: IpcMainInvokeEvent,
      request: SplitPrDiscardRequest,
    ): Promise<SplitPrDiscardResponse> => {
      validateId(request.projectId, 'projectId');
      assertWritableScope(request.projectId);
      validateId(request.worktreeId, 'worktreeId');

      // Refuse while a run is in flight: discarding the persisted map out from
      // under an executing split would race the executor's own checkpoints.
      const key = splitPrRunKey(request.projectId, request.worktreeId);
      if (splitPrAbortControllers.has(key)) {
        throw new Error(
          'A split PR run is in progress for this worktree; cancel it before discarding.',
        );
      }

      // Read the map before deletion so its leftover artifacts can be reported
      // for manual cleanup. v1 performs NO destructive git/GitHub cleanup.
      const map = await readSplitPrMap(request.projectId, request.worktreeId);
      const branches: string[] = [];
      const prNumbers: number[] = [];
      if (map) {
        branches.push(map.integrationBranch);
        if (map.integrationPrNumber !== undefined) {
          prNumbers.push(map.integrationPrNumber);
        }
        for (const child of map.children) {
          branches.push(child.branchName);
          if (child.prNumber !== undefined) {
            prNumbers.push(child.prNumber);
          }
        }
      }

      await deleteSplitPrMapForWorktree(request.projectId, request.worktreeId);
      clearSplitPrRuntimeProjection(request.projectId, request.worktreeId);
      return { branches, prNumbers };
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.githubSplitPrGetMap,
    async (
      _event: IpcMainInvokeEvent,
      request: { projectId: string; worktreeId: string },
    ): Promise<SplitPrMap | null> => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      return readSplitPrMap(request.projectId, request.worktreeId);
    },
  );

  /**
   * Execute an approved plan under an ALREADY-HELD lock, shared by both the
   * `approveSplitWorkflow` handler and `startSplitWorkflow`'s `'resume'` mode.
   * Requires the worktree to be locked (throws the typed lock error otherwise),
   * guards against a concurrent run, maps a classified `SplitPrExecutionError`
   * to a `status: 'failed'` envelope, and ALWAYS releases the lock on settle
   * (success, failed/cancelled envelopes, and rejects). Cancellation still
   * resolves `status: 'ok'` with the cancelled map.
   */
  async function executeApprovedSplitUnderLock(request: {
    projectId: string;
    worktreeId: string;
    plan: SplitWorkflowApproveRequest['plan'];
    snapshot: SplitWorkflowApproveRequest['snapshot'];
    operation: string;
  }): Promise<SplitPrExecuteResponse> {
    if (!isSplitLocked(request.projectId, request.worktreeId)) {
      throw new SplitLockError(
        'Cannot execute a Split PR that is not locked; start the workflow first.',
        {
          workspaceId: request.projectId,
          worktreeId: request.worktreeId,
          operation: request.operation,
        },
      );
    }

    const key = splitPrRunKey(request.projectId, request.worktreeId);
    if (splitPrAbortControllers.has(key)) {
      throw new Error(
        `A split PR run is already in progress for this worktree.`,
      );
    }

    const controller = new AbortController();
    splitPrAbortControllers.set(key, controller);
    setSplitPrRuntimeProjection(
      request.projectId,
      request.worktreeId,
      'running',
      'Preparing the split',
    );
    try {
      const map = await executePrSplit({
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        plan: request.plan,
        snapshot: request.snapshot,
        signal: controller.signal,
        onProgress: (event): void => {
          sendSplitPrProgress(event, controller);
        },
        getWindow,
      });
      if (
        splitPrAbortControllers.get(key) === controller &&
        controller.signal.aborted
      ) {
        clearSplitPrRuntimeProjection(request.projectId, request.worktreeId);
      }
      return { status: 'ok', map };
    } catch (error) {
      if (error instanceof SplitPrExecutionError) {
        if (splitPrAbortControllers.get(key) === controller) {
          if (controller.signal.aborted) {
            clearSplitPrRuntimeProjection(
              request.projectId,
              request.worktreeId,
            );
          } else {
            setSplitPrRuntimeProjection(
              request.projectId,
              request.worktreeId,
              'failed',
              error.message,
            );
          }
        }
        return {
          status: 'failed',
          message: error.message,
          ...(error.code !== undefined ? { code: error.code } : {}),
          ...(error.childIndex !== undefined
            ? { childIndex: error.childIndex }
            : {}),
          ...(error.verifyTail !== undefined
            ? { verifyTail: error.verifyTail }
            : {}),
        };
      }
      if (splitPrAbortControllers.get(key) === controller) {
        if (controller.signal.aborted) {
          clearSplitPrRuntimeProjection(request.projectId, request.worktreeId);
        } else {
          setSplitPrRuntimeProjection(
            request.projectId,
            request.worktreeId,
            'failed',
            error instanceof Error ? error.message : 'Failed to split PR',
          );
        }
      }
      throw error;
    } finally {
      // ALWAYS releases the lock on settle: success, failed/cancelled
      // envelopes, and rejects all flow through here.
      splitPrAbortControllers.delete(key);
      releaseSplitLock(request.projectId, request.worktreeId);
    }
  }

  registerIpcHandler(
    IPC_CHANNELS.githubSplitWorkflowStart,
    async (
      _event: IpcMainInvokeEvent,
      request: SplitWorkflowStartRequest,
    ): Promise<SplitWorkflowStartResult> => {
      validateId(request.projectId, 'projectId');
      assertWritableScope(request.projectId);
      validateId(request.worktreeId, 'worktreeId');

      const mode = request.mode ?? 'plan';

      // In-flight blocker re-check BEFORE acquiring: refuse (typed
      // SplitStartBlockedError) if an active chat turn or a running pipeline
      // execution targets this worktree, so a race or a direct IPC cannot lock
      // a worktree mid-mutation. This throws before any lock/terminate side
      // effect, so nothing to release on refusal.
      await assertNoInFlightSplitBlockers(
        request.projectId,
        request.worktreeId,
      );

      // Keep this synchronous with acquireSplitLock. runCancellableGitAction
      // performs the inverse split-lock check synchronously with registering a
      // Git action, so a remote or desktop PR mutation cannot cross this seam.
      if (isGitActionActive(request)) {
        throw new SplitStartBlockedError(
          'Cannot start a Split PR while a Git action is running in this worktree. Wait for it to finish first.',
          {
            workspaceId: request.projectId,
            worktreeId: request.worktreeId,
            blocker: 'active-git-action',
          },
        );
      }

      // Acquire the lock FIRST, then terminate resources. Acquiring before
      // teardown closes the guarded spawn seams (chat/pipeline/terminal/
      // browser/script chokepoints all `assertNotSplitLocked`) up front, so a
      // new resource cannot slip in through its own seam during the teardown
      // window. A second concurrent start throws SplitLockError here; it must
      // NOT release the lock the first start holds, so this acquire is
      // intentionally outside the release-on-failure block below.
      acquireSplitLock(request.projectId, request.worktreeId);
      setSplitPrRuntimeProjection(
        request.projectId,
        request.worktreeId,
        mode === 'review' ? 'ready' : 'preparing',
        mode === 'review'
          ? 'Waiting for your plan approval'
          : 'Analyzing the PR diff',
      );

      // Termination-on-start: kill terminals -> destroy browsers -> stop
      // scripts, under the just-acquired lock. A teardown failure must release
      // the lock we took rather than stranding the worktree frozen.
      try {
        await terminateWorktreeResources(request.projectId, request.worktreeId);
      } catch (error) {
        releaseSplitLock(request.projectId, request.worktreeId);
        clearSplitPrRuntimeProjection(request.projectId, request.worktreeId);
        throw error;
      }

      // `'resume'` SKIPS planning and executes the caller-supplied stored plan
      // under the lock, sharing the approve handler's internals (which release
      // the lock on settle). The engine's fingerprint gate + persisted map
      // handle resume-vs-mismatch.
      if (mode === 'resume') {
        if (request.plan === undefined || request.snapshot === undefined) {
          // A resume with no stored plan is a programming error at the call
          // site — there is nothing to execute, so release the lock we just
          // took rather than stranding the worktree.
          releaseSplitLock(request.projectId, request.worktreeId);
          clearSplitPrRuntimeProjection(request.projectId, request.worktreeId);
          throw new Error(
            'Cannot resume a Split PR without a stored plan and snapshot.',
          );
        }
        const result = await executeApprovedSplitUnderLock({
          projectId: request.projectId,
          worktreeId: request.worktreeId,
          plan: request.plan,
          snapshot: request.snapshot,
          operation: 'resuming a split',
        });
        return { mode: 'resume', result };
      }

      // `'review'` SKIPS planning and just KEEPS the lock; the renderer shows
      // its own stored plan at the Review step. No LLM, no re-plan.
      if (mode === 'review') {
        return { mode: 'review', result: { status: 'locked' } };
      }

      try {
        const response = await planPrSplit({
          projectId: request.projectId,
          worktreeId: request.worktreeId,
        });
        setSplitPrRuntimeProjection(
          request.projectId,
          request.worktreeId,
          'ready',
          'Waiting for your plan approval',
        );
        // A successful plan result KEEPS the lock: review happens under
        // lockdown, and approve/exit are responsible for releasing it.
        return { mode: 'plan', result: { status: 'ok', response } };
      } catch (error) {
        // A refusal means no split will run for this worktree, so release the
        // lock before returning the refused envelope. An unexpected throw
        // likewise releases before rethrowing.
        releaseSplitLock(request.projectId, request.worktreeId);
        clearSplitPrRuntimeProjection(request.projectId, request.worktreeId);
        if (error instanceof PrSplitPlanningError) {
          return {
            mode: 'plan',
            result: {
              status: 'refused',
              code: error.code,
              message: error.message,
              ...(error.issues.length > 0 ? { issues: error.issues } : {}),
            },
          };
        }
        throw error;
      }
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.githubSplitWorkflowApprove,
    async (
      _event: IpcMainInvokeEvent,
      request: SplitWorkflowApproveRequest,
    ): Promise<SplitPrExecuteResponse> => {
      validateId(request.projectId, 'projectId');
      assertWritableScope(request.projectId);
      validateId(request.worktreeId, 'worktreeId');

      return executeApprovedSplitUnderLock({
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        plan: request.plan,
        snapshot: request.snapshot,
        operation: 'approving a split',
      });
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.githubSplitWorkflowExit,
    (_event: IpcMainInvokeEvent, request: SplitWorkflowExitRequest): void => {
      validateId(request.projectId, 'projectId');
      assertWritableScope(request.projectId);
      validateId(request.worktreeId, 'worktreeId');

      // Cancel any in-flight execute via the shared abort registry. If an
      // execute is running, its own `finally` releases the lock on settle; we
      // still release here to cover the plan/review phase where no execute is
      // in flight. `planPrSplit` exposes no abort signal, so a start still
      // mid-plan will complete and then release the lock via its own path — a
      // redundant release here is a safe no-op.
      splitPrAbortControllers
        .get(splitPrRunKey(request.projectId, request.worktreeId))
        ?.abort();
      releaseSplitLock(request.projectId, request.worktreeId);
      clearSplitPrRuntimeProjection(request.projectId, request.worktreeId);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.githubSplitLockState,
    (): SplitLockStateResponse => {
      // Lightweight hydration: the renderer seeds its mirrored
      // `splitLockedWorktrees` set from this snapshot once when wiring the
      // change subscription, so a reload/crash does not leave the set empty
      // while a lock is genuinely held (e.g. an execute in flight). Each entry
      // also reports whether a main-side execute is in flight so the renderer
      // can seed `splittingPr` (and land the workflow view on Execute) after a
      // reload-during-execute.
      return {
        locked: getSplitLockedWorktrees().map((entry) => ({
          ...entry,
          executing: hasInFlightSplitExecute(
            entry.workspaceId,
            entry.worktreeId,
          ),
        })),
      };
    },
  );
}

async function repoHasChanges(
  repoPath: string,
  projectId: string,
  worktreeId: string,
  repoId: string | undefined,
  hasUncommittedOverride?: boolean,
  resolvedBase?: ResolvedPrBaseBranch | null,
): Promise<boolean> {
  try {
    const baseBranch =
      resolvedBase === undefined
        ? (
            await resolvePrBaseBranchForRepo({
              projectId,
              worktreeId,
              repoId,
              repoPath,
            })
          ).baseBranch
        : resolvedBase?.baseBranch;
    if (!baseBranch) return true;

    // Quick check: uncommitted changes (reliable, doesn't depend on remote)
    const uncommitted =
      hasUncommittedOverride ??
      (await hasUncommittedChanges(repoPath).catch(() => true));
    if (uncommitted) {
      return true;
    }

    // Check commits ahead of remote base branch
    let ahead = false;
    try {
      ahead = await hasCommitsAhead(repoPath, baseBranch);
    } catch {
      ahead = false;
    }
    if (ahead) {
      return true;
    }

    // Fallback: getDiffStats uses merge-base with a HEAD fallback, which is
    // more robust when origin refs are stale or unavailable.
    const stats = await getDiffStats(repoPath, baseBranch).catch(() => ({
      insertions: 0,
      deletions: 0,
    }));
    const hasDiff = stats.insertions > 0 || stats.deletions > 0;
    return hasDiff;
  } catch {
    // If anything fails, assume there might be changes and let processRepoForPr decide
    return true;
  }
}

async function processRepoForPr(
  repoPath: string,
  repoId: string | undefined,
  repoName: string,
  projectId: string,
  worktreeId: string,
  expectedBaseBranch: string | undefined,
  expectedHeadBranch: string | undefined,
  prModel: string,
  prThinkingLevel: ThinkingLevel | undefined,
  prInstructions: string,
  prInstructionMode: string,
  commitModels: CommitGenerationModelPlan,
  commitThinkingLevel: ThinkingLevel | undefined,
  commitInstructions: string,
  commitInstructionMode: PrInstructionMode,
  commitPluginSelections: ChatTabPluginSelections,
  prPluginSelections: ChatTabPluginSelections,
  telemetry: GitShippingTelemetryInput,
  cancellation: GitActionCancellationScope,
  createPullRequest: PullRequestCreateStep,
  getWindow?: () => BrowserWindow | null,
  onProgress?: (phase: PrCreationPhase) => void,
  skipCommit?: boolean,
  onCommitPrepared?: () => void,
  skipPush?: boolean,
  onPushCompleted?: () => void,
): Promise<CreatePrRepoResult> {
  cancellation.checkpoint();
  onProgress?.('gathering_changes');
  const remoteUrl = await getRemoteUrl(repoPath);
  if (remoteUrl === null) {
    throw new Error(
      `Repo "${repoName}" has no origin remote and cannot create a pull request.`,
    );
  }

  const branchName = await getCurrentBranch(repoPath);
  try {
    await fetchOrigin(repoPath, { signal: new AbortController().signal });
  } catch (error) {
    if (classifyGitHubAuthFailure(remoteUrl, error)) {
      throw new GitHubAuthFailureError(error);
    }
    throw new Error(
      `Unable to verify whether "${branchName}" is current with origin before creating a pull request. Refresh and try again.`,
    );
  }
  const resolvedBaseBranch = await resolvePrBaseBranchForRepo({
    projectId,
    worktreeId,
    repoId,
    repoPath,
    originAlreadyFetched: true,
  });
  const assertExpectedIdentity = async (
    selectedBaseBranch = resolvedBaseBranch.baseBranch,
  ): Promise<void> => {
    if (expectedBaseBranch === undefined && expectedHeadBranch === undefined) {
      return;
    }
    const currentHeadBranch = await getCurrentBranch(repoPath);
    const currentBaseBranch = (
      await resolvePrBaseBranchForRepo({
        projectId,
        worktreeId,
        repoId,
        repoPath,
        originAlreadyFetched: true,
      })
    ).baseBranch;
    if (
      (expectedHeadBranch !== undefined &&
        currentHeadBranch !== expectedHeadBranch) ||
      (expectedBaseBranch !== undefined &&
        (currentBaseBranch !== expectedBaseBranch ||
          selectedBaseBranch !== expectedBaseBranch))
    ) {
      throw new Error('PR state changed. Refresh and try again.');
    }
  };
  await assertExpectedIdentity();
  const divergence = await readRemoteBranchDivergence(repoPath, branchName);
  if (divergence === null) {
    throw new Error(
      `Unable to verify whether "${branchName}" is current with origin before creating a pull request. Refresh and try again.`,
    );
  }
  if (divergence.behind > 0) {
    throw new Error(
      `Branch "${branchName}" is behind origin/${branchName}. Pull the latest commits before creating a pull request.`,
    );
  }

  const assertNoOpenPullRequest = async (): Promise<void> => {
    const trackingData = await fetchRepoPrTrackingData(repoPath, branchName, {
      priority: 'high',
    }).catch((error: unknown) => {
      if (githubAuthFailureCode(error)) throw error;
      return null;
    });
    if (trackingData === null || trackingData.remote === null) {
      throw new Error(
        `Unable to verify whether "${branchName}" already has a pull request. Refresh and try again.`,
      );
    }
    if (
      trackingData.status?.state === 'open' ||
      trackingData.status?.state === 'draft'
    ) {
      throw new Error(
        `Pull request #${trackingData.status.prNumber} already exists for "${branchName}". Refresh and try again.`,
      );
    }
  };
  await assertNoOpenPullRequest();

  const hasWorkingTreeChanges = await hasUncommittedChanges(repoPath);
  if (hasWorkingTreeChanges && !skipCommit) {
    const diff = await getUncommittedDiff(repoPath);
    const message = await cancellation.runAgentStep((abortController) =>
      generateCommitMessage({
        repoPath,
        branchName,
        diff,
        model: commitModels.model,
        fallbackModels: commitModels.fallbackModels,
        aiCreditsRoutingMode: commitModels.aiCreditsRoutingMode,
        thinkingLevel: commitThinkingLevel,
        instructions: commitInstructions,
        instructionMode: commitInstructionMode,
        pluginSelections: commitPluginSelections,
        abortController,
        auditContext: buildHelperAuditContext(
          projectId,
          worktreeId,
          repoName,
          repoId,
        ),
      }),
    );
    await assertExpectedIdentity();
    await assertNoOpenPullRequest();
    await cancellation.runGitStep(() => stageAllChanges(repoPath));
    try {
      await cancellation.runGitStep(async () => {
        await commitWithMessage(repoPath, message);
        try {
          recordGitCommitTelemetry(telemetry);
        } catch {
          /* Best effort. */
        }
      });
    } catch (error) {
      if (isGitActionCancelledError(error)) throw error;
      await triggerWorktreePrecommitFailureHook({
        projectId,
        worktreeId,
        repo: { repoPath, repoId, repoName },
        error,
        commitMessage: message,
        getWindow,
      }).catch(() => {});
      throw error;
    }
  }

  onCommitPrepared?.();

  async function buildPrContentForBase(baseBranch: string): Promise<{
    title: string;
    body: string;
  }> {
    const diff = await getFullDiff(repoPath, baseBranch);
    const commitLog = await getCommitLog(repoPath, baseBranch);

    if (!diff.trim() && !commitLog.trim()) {
      throw new Error(
        `No commits between ${baseBranch} and ${branchName}. Push some commits before creating a PR.`,
      );
    }

    onProgress?.('summarizing');
    return cancellation.runAgentStep((abortController) =>
      generatePrContent({
        repoPath,
        branchName,
        baseBranch,
        diff,
        commitLog,
        model: prModel,
        thinkingLevel: prThinkingLevel,
        instructions: prInstructions,
        instructionMode: prInstructionMode,
        pluginSelections: prPluginSelections,
        abortController,
        auditContext: buildHelperAuditContext(
          projectId,
          worktreeId,
          repoName,
          repoId,
        ),
      }),
    );
  }

  let baseBranch = resolvedBaseBranch.baseBranch;
  let { title, body } = await buildPrContentForBase(baseBranch);

  await assertExpectedIdentity(baseBranch);
  // Unconditional, not gated on the dirty path having already checked: PR
  // content generation is an agent step, so minutes can pass between the
  // pre-commit check and this push. Prove no PR opened in that window before
  // mutating the remote branch.
  await assertNoOpenPullRequest();
  if (!skipPush) {
    onProgress?.('pushing');
    await cancellation.runGitStep(() => pushBranchWithAuthFailure(repoPath));
    await scheduleSharedContainerPublicationAfterPush(projectId, worktreeId);
  }
  onPushCompleted?.();

  await assertExpectedIdentity(baseBranch);
  onProgress?.('creating_pr');
  let prNumber: number;
  let prUrl: string;
  const recordCreatedPullRequest = (created: {
    prNumber: number;
    prUrl: string;
    created: boolean;
  }): void => {
    if (created.created !== true) {
      return;
    }

    try {
      recordPullRequestOpenedTelemetry(telemetry);
    } catch {
      /* Best effort. */
    }
    getExecutionObservabilityIngest().recordCreatedPullRequest({
      projectId,
      worktreeId,
      repoId,
      repoLabel: repoName,
      provider: requireProviderForModel(prModel),
      prNumber: created.prNumber,
      prUrl: created.prUrl,
    });
  };

  try {
    const created = await cancellation.runGitStep(async () => {
      const result = await createPullRequest({
        projectId,
        worktreeId,
        repoId,
        repoPath,
        headBranch: branchName,
        title,
        body,
        baseBranch,
      });
      recordCreatedPullRequest(result);
      return result;
    });
    prNumber = created.prNumber;
    prUrl = created.prUrl;
  } catch (error) {
    if (isGitActionCancelledError(error)) throw error;
    const fallbackBaseBranch = resolvedBaseBranch.fallbackBaseBranch;
    if (
      !fallbackBaseBranch ||
      baseBranch === fallbackBaseBranch ||
      !isPrBaseBranchCreationError(error)
    ) {
      throw error;
    }

    baseBranch = fallbackBaseBranch;
    ({ title, body } = await buildPrContentForBase(baseBranch));
    await assertExpectedIdentity(baseBranch);
    onProgress?.('creating_pr');
    const created = await cancellation.runGitStep(async () => {
      const result = await createPullRequest({
        projectId,
        worktreeId,
        repoId,
        repoPath,
        headBranch: branchName,
        title,
        body,
        baseBranch,
      });
      recordCreatedPullRequest(result);
      return result;
    });
    prNumber = created.prNumber;
    prUrl = created.prUrl;
  }

  return { repoId: repoId ?? repoName, repoName, prNumber, prUrl };
}
