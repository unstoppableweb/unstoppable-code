import {
  isWorkspaceTargetRemovalPending,
  subscribeWorkspaceTargetRemoval,
} from './workspace-target-exclusion';
import {
  isWorktreeReadAvailable,
  withWorktreeGitRead,
} from './worktree-read-availability';
import { registerWorktreeGitReadyHook } from './worktree-git-ready-hooks';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import type { BrowserWindow } from 'electron';
import { IPC_CHANNELS, type SidebarItem } from '@canopy/desktop-shared/types';
import type {
  DependentBaseBranchUpdate,
  GitHubRateLimitEvent,
  PrStatusData,
  PrStatusEvent,
  RepoPrStatus,
  RepoPrTrackingData,
  WorktreePrStatus,
} from '@canopy/desktop-shared/types/github';
import type { WorktreeData } from '@canopy/desktop-shared/types';
import {
  compareTriggerNames,
  SUPPORTED_PR_HOOK_TRIGGERS,
  type HookTriggerName,
} from '@canopy/desktop-shared/hooks';
import { getCurrentBranch } from './git';
import { CanopyClientError, deliverCanopy } from '@canopy/core-client';
import type {
  HookFiringAdmission,
  InitiatedWorkAcceptance,
} from '@canopy/core-runtime/node/initiated-work';
import { OperationLedgerError } from '@canopy/core-runtime/node/operations';
import type { PersistedPrSnapshotFileV1 } from '@canopy/desktop-shared/types/github';
import {
  PR_ADVANCE_SOURCE,
  advancePrTrackingState,
  getProjectRepoStorageKey,
  getWorkspaceRepoStorageKey,
  getWorkspaceRootRepoStorageKey,
} from './github-pr-hook-state';
import {
  fetchRepoPrTrackingData,
  fetchTrackedPullRequestData,
  resolveGitHubRemoteForRepo,
  reusablePrGraphQlState,
} from './github-pr';
import { getGitHubClient, type GitHubClient } from './github-client';
import { getGitHubBroker } from './github-broker';
import {
  getCloudAccountIdentityGeneration,
  readGitHubTrackingCredential,
} from './github-preview-credential';
import {
  emitPullRequestSwept,
  fetchPullRequestSweep,
  isGitHubRateLimitError,
  planPullRequestRead,
  type BranchPullRequestLookup,
  type PullRequestFingerprint,
  type SweptPullRequest,
} from './github-pr-sweep';
import type { GitHubBrokerError } from './github-broker/errors';
import { updateDependentBaseBranchesForMergedWorktree } from './worktree-base-branch-updater';
import {
  createProjectHookDescriptor,
  createWorkspaceRepoHookDescriptor,
  createWorkspaceRootHookDescriptor,
  createHookCompleteEvent,
  createHookOutputEvent,
  createHookStartedEvent,
} from './hook-events';
import {
  getResolvedHookActions,
  resolveProjectHooks,
  resolveWorkspaceRepoHooks,
  resolveWorkspaceRootHooks,
} from './hook-resolver';
import { hookClientPresence } from './hook-client-presence';
import {
  announceHookSkippedPaused,
  runHook,
  type RunHookOptions,
} from './hook-runner';
import {
  getHookFiring,
  getHookInitiatedWork,
  hookIdentity,
  readPausedHookKeys,
} from './hook-initiated-work';
import { startHookRecovery } from './hook-recovery';
import { prHookOccurrenceKey } from './pr-hook-occurrence';
import { logMainProcessWarn } from './main-process-logging';
import { getOperationLedgerPath } from './paths';
import {
  buildHookWatcherVariables,
  fireHookTriggeredWatchers,
  hookKeyForScope,
} from './hook-watcher-events';
import { resolveWorktreeCwd } from './resolve-worktree';
import {
  readWorkspaceConfig,
  readWorkspaceWorktrees,
  readWorkspaceWorktreesUnlocked,
} from './workspace-persistence';
import {
  areEquivalentPrStatuses,
  observeWorktreeGit,
} from './worktree-git-observations';
import { sendToWindow } from './window-send';
import { emitWorktreePrStatusChange } from './pr-status-change-emitter';
import { listWorkspaceWorktreeRepoEntries } from './worktree-repo-entries';
import { isMultiRepoWorkspace } from './workspace-registry';
import { getAppAdvisorWatcherService } from '../app-advisor/watchers';
import {
  readGitHubRefreshLedgerEntry,
  removeGitHubRefreshLedgerEntry,
  recordGitHubRefreshAttempt,
  recordGitHubRefreshFailure,
  recordGitHubRefreshSuccess,
} from './github-refresh-ledger';
import {
  detachedWorkCallback,
  settleAll,
  trackDetachedWork,
} from '@canopy/desktop-shared/node/lib/detached-work';

const STALE_THRESHOLD = 30_000;
const IMMEDIATE_TICK_DELAY = 1_000;
const ACTIVE_CI_SWEEP_INTERVAL = 60_000;
const KNOWN_PR_SWEEP_INTERVAL = 120_000;
const SLOW_SWEEP_INTERVAL = 300_000;
const MIN_SWEEP_SPACING = 30_000;
/** Worktrees due this soon join a sweep, so one document covers them. */
const SWEEP_COALESCE_WINDOW = 30_000;
const RATE_LIMIT_FALLBACK_BACKOFF = 60_000;
const COMMENT_COLLECTION_HOOK_TRIGGERS = new Set<HookTriggerName>([
  'pr:update:comments',
  'pr:reviews:new',
  'pr:reviews:new:has-comments',
]);

interface TrackedWorktree {
  projectId: string;
  worktreeId: string;
  lastCheckedAt: number;
  steadyDueAt: number;
  steadyHydrationGeneration: number;
  steadyHydrationPending: boolean;
  lastStatus: WorktreePrStatus | null;
  lastPersistedStatus: WorktreePrStatus | null | undefined;
  createdAt?: string;
}

export interface TrackedWorkspaceReconciliationResult {
  addedWorktreeIds: string[];
  removedWorktreeIds: string[];
}

interface RepoRefreshTarget {
  target: 'project' | 'workspace-root' | 'workspace-repo';
  repoId?: string;
  repoName: string;
  repoPath: string;
  repoStorageKey: string;
}

interface SnapshotReadIdentity {
  authenticationToken: string | undefined;
  authenticationScope: string | undefined;
  credentialScope: string | undefined;
  brokerGeneration: number;
  cloudGeneration: number;
}

function unavailableSnapshotReadIdentity(): SnapshotReadIdentity {
  return {
    authenticationToken: undefined,
    authenticationScope: undefined,
    credentialScope: undefined,
    brokerGeneration: getGitHubBroker().getCredentialGeneration(),
    cloudGeneration: getCloudAccountIdentityGeneration(),
  };
}

async function snapshotReadIdentity(): Promise<SnapshotReadIdentity> {
  const credential = await readGitHubTrackingCredential().catch(() => null);
  return {
    authenticationToken: credential?.token,
    authenticationScope: credential?.authenticationScope,
    credentialScope: credential?.scope,
    brokerGeneration: getGitHubBroker().getCredentialGeneration(),
    cloudGeneration: getCloudAccountIdentityGeneration(),
  };
}

async function verifySnapshotReadIdentity(
  identity: SnapshotReadIdentity,
): Promise<string | undefined> {
  if (!identity.authenticationToken || !identity.authenticationScope) {
    throw new Error('GitHub credential unavailable.');
  }
  const current = await readGitHubTrackingCredential();
  if (!current) throw new Error('GitHub credential unavailable.');
  if (
    current.authenticationScope !== identity.authenticationScope ||
    (current.scope !== undefined &&
      identity.credentialScope !== undefined &&
      current.scope !== identity.credentialScope) ||
    getGitHubBroker().getCredentialGeneration() !== identity.brokerGeneration ||
    getCloudAccountIdentityGeneration() !== identity.cloudGeneration
  ) {
    throw new Error('GitHub acquisition identity changed.');
  }
  // Never promote an unscoped acquisition, or stamp while identity is unknown.
  return current.scope === identity.credentialScope
    ? identity.credentialScope
    : undefined;
}

interface PreparedRepoRefresh extends SnapshotReadIdentity {
  remote: { owner: string; repo: string } | null;
  target: RepoRefreshTarget;
  branchName: string;
  hookActionsByTrigger: Awaited<
    ReturnType<typeof resolveEffectiveHookActions>
  > | null;
  includeCommentCollections: boolean;
}

interface RepoRefreshRead extends PreparedRepoRefresh {
  trackingData: RepoPrTrackingData | null;
}

/** The last read of one repository of one worktree, for the next sweep. */
interface SweptTarget {
  authenticationScope: string | undefined;
  credentialScope: string | undefined;
  branchName: string;
  trackingData: RepoPrTrackingData;
  pullRequestNumber: number | null;
  fingerprint: PullRequestFingerprint | null;
  checksInFlight: boolean;
  lastFullReadAt: number;
  includesComments: boolean;
}

const tracked = new Map<string, TrackedWorktree>();

/** Read-only inventory for the PR tracking owner's lazy snapshot index. */
export function getTrackedPrSnapshotLocations(): readonly {
  projectId: string;
  worktreeId: string;
}[] {
  return Array.from(tracked.values(), ({ projectId, worktreeId }) => ({
    projectId,
    worktreeId,
  }));
}
const immediateQueue: string[] = [];
const sweptTargets = new Map<string, SweptTarget>();
let pollTimeout: ReturnType<typeof setTimeout> | null = null;
let getWindowFn: (() => BrowserWindow | null) | null = null;
let running = true;
let gitReadySubscription: (() => void) | undefined;
let ticking = false;
let lastPollAt = 0;
let lastSweepAt = 0;
let sweepPausedUntil = 0;
let foregroundKey: string | null = null;
let lastCommentFetchSkipNoticeAt = 0;
const e2eSuspendedKeys = new Set<string>();

function worktreeKey(projectId: string, worktreeId: string): string {
  return `${projectId}/${worktreeId}`;
}

function sendPrStatusEvent(event: PrStatusEvent): void {
  if (
    isWorkspaceTargetRemovalPending(event.projectId, event.worktreeId) ||
    !tracked.has(worktreeKey(event.projectId, event.worktreeId))
  )
    return;
  if (
    __CANOPY_E2E__ &&
    e2eSuspendedKeys.has(worktreeKey(event.projectId, event.worktreeId))
  ) {
    return;
  }
  sendToRenderer(IPC_CHANNELS.githubPrStatusEvent, event);
}

function removeFromQueue(queue: string[], key: string): void {
  let idx = queue.indexOf(key);
  while (idx !== -1) {
    queue.splice(idx, 1);
    idx = queue.indexOf(key);
  }
}

function moveToFront(queue: string[], key: string): void {
  removeFromQueue(queue, key);
  queue.unshift(key);
}

function hasKnownOpenPr(status: WorktreePrStatus | null): boolean {
  if (status === null) {
    return false;
  }

  return status.repos.some(
    (repo) =>
      repo.status !== null &&
      (repo.status.state === 'open' || repo.status.state === 'draft'),
  );
}

function hasKnownPr(status: WorktreePrStatus | null): boolean {
  if (status === null) {
    return false;
  }

  return status.repos.some((repo) => repo.status !== null);
}

function hasKnownOpenPrWithActiveCi(status: WorktreePrStatus | null): boolean {
  if (status === null) {
    return false;
  }

  return status.repos.some((repo) => {
    const pr = repo.status;
    if (pr === null || (pr.state !== 'open' && pr.state !== 'draft')) {
      return false;
    }

    // Inspect individual checks because a failing check takes precedence in
    // the aggregate status and can otherwise hide another check that is still
    // queued or running. The aggregate fallback preserves older snapshots
    // that may not carry complete check details.
    return (
      (Array.isArray(pr.checkDetails) &&
        pr.checkDetails.some((check) => check.status === 'pending')) ||
      pr.checkStatus === 'pending'
    );
  });
}

function getStatusCheckedAt(status: WorktreePrStatus | null): number {
  if (status === null) {
    return 0;
  }

  const parsed = Date.parse(status.lastCheckedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getSteadyRefreshInterval(status: WorktreePrStatus | null): number {
  if (hasKnownOpenPrWithActiveCi(status)) {
    return ACTIVE_CI_SWEEP_INTERVAL;
  }
  if (hasKnownOpenPr(status)) {
    return KNOWN_PR_SWEEP_INTERVAL;
  }
  return SLOW_SWEEP_INTERVAL;
}

function hasPendingChecks(status: PrStatusData | null): boolean {
  return (
    status !== null &&
    (status.checkStatus === 'pending' ||
      (Array.isArray(status.checkDetails) &&
        status.checkDetails.some((check) => check.status === 'pending')))
  );
}

function sweptTargetKey(key: string, repoStorageKey: string): string {
  return `${key}\0${repoStorageKey}`;
}

function ensureTracked(
  projectId: string,
  worktreeId: string,
  createdAt?: string,
): TrackedWorktree | undefined {
  if (isWorkspaceTargetRemovalPending(projectId, worktreeId)) return undefined;
  const key = worktreeKey(projectId, worktreeId);
  let entry = tracked.get(key);

  if (!entry) {
    if (!createdAt) return undefined;
    entry = {
      projectId,
      worktreeId,
      lastCheckedAt: 0,
      steadyDueAt: 0,
      steadyHydrationGeneration: 0,
      steadyHydrationPending: false,
      lastStatus: null,
      lastPersistedStatus: undefined,
      createdAt,
    };
    tracked.set(key, entry);
  }
  entry.createdAt = createdAt ?? entry.createdAt;

  return entry;
}

function isWindowFocused(): boolean {
  const win = getWindowFn?.();
  return Boolean(win && !win.isDestroyed() && win.isFocused());
}

function sendToRenderer(channel: string, data: unknown): void {
  sendToWindow(getWindowFn?.() ?? null, channel, data);
}

async function resolveRefreshTargets(
  projectId: string,
  worktreeId: string,
): Promise<RepoRefreshTarget[]> {
  if (!(await isWorktreeReadAvailable(projectId, worktreeId))) return [];
  const cwd = resolveWorktreeCwd(projectId, worktreeId);
  if (!isMultiRepoWorkspace(projectId)) {
    return [
      {
        target: 'project',
        repoName: basename(cwd),
        repoPath: cwd,
        repoStorageKey: getProjectRepoStorageKey(),
      },
    ];
  }

  const repoEntries = await listWorkspaceWorktreeRepoEntries(projectId, cwd);
  return repoEntries.map((entry) => ({
    target:
      entry.repoId === getWorkspaceRootRepoStorageKey()
        ? 'workspace-root'
        : 'workspace-repo',
    repoId: entry.repoId,
    repoName: entry.repoName,
    repoPath: entry.repoPath,
    repoStorageKey:
      entry.repoId === getWorkspaceRootRepoStorageKey()
        ? getWorkspaceRootRepoStorageKey()
        : getWorkspaceRepoStorageKey(entry.repoId),
  }));
}

async function resolveEffectiveHookActions(args: {
  projectId: string;
  worktreeId: string;
  target: RepoRefreshTarget;
}): Promise<Record<string, ReturnType<typeof getResolvedHookActions>>> {
  const buildHookActionsByTrigger = (
    resolvedHooks: Awaited<ReturnType<typeof resolveProjectHooks>>,
  ): Record<string, ReturnType<typeof getResolvedHookActions>> => {
    const hookActionsByTrigger: Record<
      string,
      ReturnType<typeof getResolvedHookActions>
    > = {};

    for (const triggerName of SUPPORTED_PR_HOOK_TRIGGERS) {
      hookActionsByTrigger[triggerName] = getResolvedHookActions(
        resolvedHooks,
        triggerName,
      );
    }

    return hookActionsByTrigger;
  };

  if (!isMultiRepoWorkspace(args.projectId)) {
    const config = await readWorkspaceConfig(args.projectId);
    const resolvedHooks = await resolveProjectHooks(
      {
        id: args.projectId,
        owner: config.owner,
        repoPath: config.repoPath ?? args.target.repoPath,
        hooks: config.hooks,
      },
      args.target.repoPath,
    );
    return buildHookActionsByTrigger(resolvedHooks);
  }

  if (args.target.target === 'workspace-root') {
    const resolvedHooks = await resolveWorkspaceRootHooks(args.projectId, {
      workspaceRootPath: args.target.repoPath,
    });
    return buildHookActionsByTrigger(resolvedHooks);
  }

  const resolvedHooks = await resolveWorkspaceRepoHooks(
    args.projectId,
    args.target.repoId ?? '',
    {
      workspaceRootPath: resolveWorktreeCwd(args.projectId, args.worktreeId),
      repoPath: args.target.repoPath,
    },
  );
  return buildHookActionsByTrigger(resolvedHooks);
}

function createHookDescriptorForTarget(args: {
  target: RepoRefreshTarget;
  triggerName: string;
  actions: NonNullable<ReturnType<typeof getResolvedHookActions>>;
}): ReturnType<
  | typeof createProjectHookDescriptor
  | typeof createWorkspaceRepoHookDescriptor
  | typeof createWorkspaceRootHookDescriptor
> {
  if (args.target.target === 'project') {
    return createProjectHookDescriptor(args.triggerName, args.actions);
  }
  if (args.target.target === 'workspace-root') {
    return createWorkspaceRootHookDescriptor(args.triggerName, args.actions);
  }

  return createWorkspaceRepoHookDescriptor(
    args.target.repoId ?? '',
    args.target.repoName,
    args.triggerName,
    args.actions,
  );
}

function hookScopeForTarget(
  target: RepoRefreshTarget,
): 'project' | 'workspace-root' | 'workspace-repo' {
  return target.target;
}

async function hasActiveCommentCollectionHookWatcher(args: {
  projectId: string;
  worktreeId: string;
  target: RepoRefreshTarget;
}): Promise<boolean> {
  const scope = hookScopeForTarget(args.target);
  const watchers = await getAppAdvisorWatcherService().list();
  return watchers.some((watcher) => {
    if (
      watcher.status !== 'active' ||
      watcher.trigger !== 'worktree_hook_triggered' ||
      watcher.target.kind !== 'worktree_hook' ||
      watcher.target.projectId !== args.projectId ||
      watcher.target.worktreeId !== args.worktreeId ||
      !COMMENT_COLLECTION_HOOK_TRIGGERS.has(watcher.target.triggerName)
    ) {
      return false;
    }
    if (watcher.target.scope && watcher.target.scope !== scope) {
      return false;
    }
    if (watcher.target.repoId && watcher.target.repoId !== args.target.repoId) {
      return false;
    }
    return true;
  });
}

/** Renderer events for automatic and recovered hook runs. */
function automaticHookRunEvents(
  projectId: string,
  worktreeId: string,
): Pick<RunHookOptions, 'onStarted' | 'onOutput' | 'onComplete'> {
  return {
    onStarted: (startedHook) => {
      sendToRenderer(
        IPC_CHANNELS.hookStarted,
        createHookStartedEvent(projectId, worktreeId, startedHook),
      );
    },
    onOutput: (outputHook, lines, _ref, activeActionIndex) => {
      sendToRenderer(
        IPC_CHANNELS.hookOutput,
        createHookOutputEvent(
          projectId,
          worktreeId,
          outputHook,
          lines,
          activeActionIndex,
        ),
      );
    },
    onComplete: (completedHook, result) => {
      sendToRenderer(
        IPC_CHANNELS.hookComplete,
        createHookCompleteEvent(projectId, worktreeId, completedHook, result),
      );
    },
  };
}

/** Ledger failures that leave nothing recorded, so the same write may run again. */
function retryableLedgerFailure(error: unknown): unknown {
  return error instanceof OperationLedgerError &&
    (error.code === 'STORAGE_UNAVAILABLE' ||
      error.code === 'WRITER_UNAVAILABLE')
    ? new CanopyClientError({
        kind: 'unavailable',
        message: 'The operation ledger is unavailable.',
        retry: { kind: 'same_idempotency_key' },
      })
    : error;
}

/**
 * Record a PR snapshot advance and every hook it fired in one ledger write
 * (CAN-4145, ADR 14): each configured trigger's run is accepted, or recorded
 * as skipped when the core hook source finds its hook paused. The write is
 * delivered under the shared delivery policy (CAN-4205): the same keyed
 * write, with backoff, within one deadline. A failure leaves the snapshot
 * unadvanced, so the next read fires the same triggers again.
 */
async function acceptPrHookFirings(args: {
  projectId: string;
  worktreeId: string;
  target: RepoRefreshTarget;
  subject: string;
  head: string;
  triggerNames: readonly string[];
  currentSnapshot: PersistedPrSnapshotFileV1 | null;
  hookActionsByTrigger: Record<
    string,
    ReturnType<typeof getResolvedHookActions>
  >;
}): Promise<Map<string, InitiatedWorkAcceptance>> {
  const fired: Array<{
    triggerName: string;
    firing: HookFiringAdmission;
  }> = [];
  const snapshot = args.currentSnapshot;
  if (snapshot)
    for (const triggerName of [...args.triggerNames].sort(
      compareTriggerNames,
    )) {
      const actions = args.hookActionsByTrigger[triggerName];
      if (!Array.isArray(actions) || actions.length === 0) continue;
      const hook = createHookDescriptorForTarget({
        target: args.target,
        triggerName,
        actions,
      });
      fired.push({
        triggerName,
        firing: {
          hook: hookIdentity(hook),
          occurrenceKey: prHookOccurrenceKey(snapshot, triggerName),
          pullRequest: {
            repository: snapshot.repository.fullName,
            number: snapshot.pr.number,
          },
        },
      });
    }
  const hookFiring = getHookFiring();
  const write = (): Promise<InitiatedWorkAcceptance[]> =>
    hookFiring.acceptOccurrence({
      workspaceId: args.projectId,
      worktreeId: args.worktreeId,
      head: {
        source: PR_ADVANCE_SOURCE,
        subject: args.subject,
        value: args.head,
      },
      firings: fired.map((entry) => entry.firing),
    });
  const attempt: { last: Promise<InitiatedWorkAcceptance[]> | null } = {
    last: null,
  };
  let acceptances: InitiatedWorkAcceptance[];
  try {
    acceptances = await deliverCanopy(
      async () => {
        const pending = write();
        attempt.last = pending;
        try {
          return await pending;
        } catch (error) {
          throw retryableLedgerFailure(error);
        }
      },
      { replay: 'same_idempotency_key' },
    );
  } catch (error) {
    // A deadline can pass while the last write is still committing in this
    // process. Its own outcome, not the deadline, decides the advance.
    if (!attempt.last) throw error;
    acceptances = await attempt.last;
  }
  return new Map(
    fired.map((entry, index) => [entry.triggerName, acceptances[index]]),
  );
}

function dispatchAutomaticHooks(args: {
  projectId: string;
  worktreeId: string;
  target: RepoRefreshTarget;
  triggerNames: string[];
  hookActionsByTrigger: Record<
    string,
    ReturnType<typeof getResolvedHookActions>
  >;
  /** What the watchers are told; the core hook source decides the pause. */
  pausedHookKeys: ReadonlySet<string>;
  currentSnapshot: NonNullable<
    Awaited<ReturnType<typeof advancePrTrackingState>>['currentSnapshot']
  >;
  currentSnapshotPath: string;
  previousSnapshotPath: string;
  timeoutSeconds: number;
  /** Each fired hook's acceptance, committed with the snapshot advance. */
  acceptances: ReadonlyMap<string, InitiatedWorkAcceptance>;
}): void {
  const orderedTriggerNames = [...args.triggerNames].sort(compareTriggerNames);

  for (const triggerName of orderedTriggerNames) {
    const actions = args.hookActionsByTrigger[triggerName];
    const configured = Array.isArray(actions) && actions.length > 0;
    const scope = hookScopeForTarget(args.target);
    const fallbackHookKey = hookKeyForScope({
      scope,
      triggerName,
      repoId: args.target.repoId,
    });
    const hook = configured
      ? createHookDescriptorForTarget({
          target: args.target,
          triggerName,
          actions,
        })
      : undefined;
    const hookKey = hook?.hookKey ?? fallbackHookKey;
    const paused = hookKey ? args.pausedHookKeys.has(hookKey) : false;
    const variables = buildHookWatcherVariables({
      projectId: args.projectId,
      worktreeId: args.worktreeId,
      scope,
      repoId: args.target.repoId,
      triggerName,
      currentSnapshot: args.currentSnapshot,
      currentSnapshotPath: args.currentSnapshotPath,
      previousSnapshotPath: args.previousSnapshotPath,
    });
    // A failing watcher must not keep an accepted hook from starting.
    try {
      fireHookTriggeredWatchers({
        projectId: args.projectId,
        worktreeId: args.worktreeId,
        triggerName,
        scope,
        repoId: args.target.repoId,
        repoName: args.target.repoName,
        hook,
        configured,
        paused,
        variables,
      });
    } catch (error) {
      logMainProcessWarn('[github-poller] hook watcher delivery failed', error);
    }

    if (!configured || !hook) {
      continue;
    }

    const occurrenceKey = prHookOccurrenceKey(
      args.currentSnapshot,
      triggerName,
    );
    const acceptance = args.acceptances.get(triggerName);
    if (acceptance && acceptance.status !== 'accepted') {
      // Recorded with the advance: a paused skip, or an occurrence the
      // ledger already holds, which its first firing or recovery runs.
      if (acceptance.status === 'stopped')
        announceHookSkippedPaused({
          projectId: args.projectId,
          worktreeId: args.worktreeId,
          hook,
          window: getWindowFn?.() ?? null,
        });
      continue;
    }
    trackDetachedWork(() =>
      runHook({
        projectId: args.projectId,
        worktreeId: args.worktreeId,
        hook,
        cwd: args.target.repoPath,
        invocation: 'automatic',
        pause: 'enforce',
        occurrenceKey,
        ...(acceptance ? { acceptedOperationId: acceptance.operationId } : {}),
        clientPresence: hookClientPresence(() => getWindowFn?.() ?? null),
        timeoutSeconds: args.timeoutSeconds,
        currentSnapshot: args.currentSnapshot,
        currentSnapshotPath: args.currentSnapshotPath,
        previousSnapshotPath: args.previousSnapshotPath,
        getWindow: () => getWindowFn?.() ?? null,
        ...automaticHookRunEvents(args.projectId, args.worktreeId),
      }).catch(() => {}),
    );
  }
}

/**
 * Whether a PR trigger would run a hook for one of the worktree's
 * repositories: a hook is configured for the repository's scope and is not
 * paused in this worktree. Resolves hooks the way automatic dispatch does.
 */
export async function isPrHookActiveForRepo(args: {
  projectId: string;
  worktreeId: string;
  /** Workspace repository id. Ignored in a single-repo project. */
  repoId?: string;
  triggerName: string;
}): Promise<boolean> {
  const targets = await resolveRefreshTargets(args.projectId, args.worktreeId);
  const target = isMultiRepoWorkspace(args.projectId)
    ? targets.find((candidate) => candidate.repoId === args.repoId)
    : targets[0];
  if (!target) return false;
  const hookActionsByTrigger = await resolveEffectiveHookActions({
    projectId: args.projectId,
    worktreeId: args.worktreeId,
    target,
  });
  const actions = hookActionsByTrigger[args.triggerName];
  if (!Array.isArray(actions) || actions.length === 0) return false;
  const hook = createHookDescriptorForTarget({
    target,
    triggerName: args.triggerName,
    actions,
  });
  return !(await readPausedHookKeys(args.projectId, args.worktreeId)).has(
    hook.hookKey,
  );
}

async function persistLastKnownPrStatus(
  projectId: string,
  worktreeId: string,
  previousPersistedStatus: WorktreePrStatus | null | undefined,
  status: WorktreePrStatus | null,
): Promise<boolean> {
  const prStatusChanged = !areEquivalentPrStatuses(
    previousPersistedStatus,
    status,
  );

  // `internal.worktree.git.observe` keeps the row's guard: an equivalent
  // status is not rewritten, and a worktree that disappeared is not written.
  const persisted = await observeWorktreeGit({
    kind: 'pr-status',
    workspaceId: projectId,
    worktreeId,
    status,
  }).then(
    (outcome) => outcome.status !== 'not-found',
    () => false,
  );

  // Subscribers decide whether a null status is relevant: the portal clears
  // its PR card, while telemetry only amends live PRs.
  if (persisted && prStatusChanged) {
    emitWorktreePrStatusChange(projectId, worktreeId, status);
  }

  return persisted;
}

function notifyCommentFetchSkipped(
  message: string,
  rateLimit?: Omit<GitHubRateLimitEvent, 'message'>,
): void {
  if (!rateLimit) return;
  const now = Date.now();
  if (now - lastCommentFetchSkipNoticeAt < 60_000) return;
  lastCommentFetchSkipNoticeAt = now;
  sendToRenderer(IPC_CHANNELS.githubRateLimitEvent, {
    message,
    ...rateLimit,
  });
}

async function prepareRepoRefreshes(
  projectId: string,
  worktreeId: string,
  targets: RepoRefreshTarget[],
): Promise<PreparedRepoRefresh[]> {
  return withWorktreeGitRead<PreparedRepoRefresh[]>(
    projectId,
    worktreeId,
    [],
    async () => {
      const prepared: PreparedRepoRefresh[] = [];
      for (const target of targets) {
        const branchName = await getCurrentBranch(target.repoPath).catch(
          () => '',
        );
        if (!branchName) {
          prepared.push({
            ...unavailableSnapshotReadIdentity(),
            remote: null,
            target,
            branchName,
            hookActionsByTrigger: null,
            includeCommentCollections: false,
          });
          continue;
        }

        const hookActionsByTrigger = await resolveEffectiveHookActions({
          projectId,
          worktreeId,
          target,
        }).catch(() => null);
        const includeCommentCollectionsForHooks =
          hookActionsByTrigger !== null &&
          Array.from(COMMENT_COLLECTION_HOOK_TRIGGERS).some((triggerName) =>
            Array.isArray(hookActionsByTrigger[triggerName]),
          );
        const includeCommentCollectionsForWatchers =
          await hasActiveCommentCollectionHookWatcher({
            projectId,
            worktreeId,
            target,
          }).catch(() => false);
        prepared.push({
          ...unavailableSnapshotReadIdentity(),
          remote: await resolveGitHubRemoteForRepo(target.repoPath),
          target,
          branchName,
          hookActionsByTrigger,
          includeCommentCollections:
            includeCommentCollectionsForHooks ||
            includeCommentCollectionsForWatchers,
        });
      }
      return prepared;
    },
  );
}

async function applyEmptyRefresh(
  projectId: string,
  worktreeId: string,
): Promise<null> {
  const emptyStatus = null;
  const entry = ensureTracked(projectId, worktreeId);
  if (!entry) return null;
  const previousPersistedStatus = entry.lastPersistedStatus;
  entry.lastStatus = emptyStatus;
  entry.lastCheckedAt = Date.now();
  const event: PrStatusEvent = {
    projectId,
    worktreeId,
    status: emptyStatus,
  };
  sendPrStatusEvent(event);
  if (
    await persistLastKnownPrStatus(
      projectId,
      worktreeId,
      previousPersistedStatus,
      emptyStatus,
    )
  ) {
    entry.lastPersistedStatus = emptyStatus;
  }
  return emptyStatus;
}

/**
 * Advance snapshots, dispatch hooks, and publish status for reads that all
 * completed. Callers finish every fallible repository read first, so a later
 * failure never strands hook transitions whose earlier snapshots advanced.
 */
async function applyRepoRefreshes(
  projectId: string,
  worktreeId: string,
  reads: RepoRefreshRead[],
  scriptTimeoutMinutes: number,
): Promise<WorktreePrStatus | null> {
  if (
    !ensureTracked(projectId, worktreeId) ||
    !(await isWorktreeReadAvailable(projectId, worktreeId))
  )
    return null;
  const repos: RepoPrStatus[] = [];
  const mergedBranchUpdates: Array<Promise<DependentBaseBranchUpdate[]>> = [];
  const pendingHookDispatches: Array<
    Parameters<typeof dispatchAutomaticHooks>[0]
  > = [];

  // Read once, when the first advance fires hooks: the pause the watchers
  // are told about.
  let watcherPause: Promise<ReadonlySet<string>> | null = null;
  const loadWatcherPause = (): Promise<ReadonlySet<string>> =>
    (watcherPause ??= readPausedHookKeys(projectId, worktreeId).catch(
      (): ReadonlySet<string> => new Set<string>(),
    ));
  const committedHead = (subject: string): Promise<string | null> =>
    getHookInitiatedWork().sourceHead(PR_ADVANCE_SOURCE, subject);

  const verifiedScopes = new Map<RepoRefreshRead, string | undefined>();
  for (const read of reads) {
    if (read.remote)
      verifiedScopes.set(read, await verifySnapshotReadIdentity(read));
  }
  let identityChanged = false;
  let advanceFailure: { error: unknown } | null = null;
  for (const read of reads) {
    const { target, branchName, hookActionsByTrigger, trackingData } = read;
    if (
      read.remote &&
      (getGitHubBroker().getCredentialGeneration() !== read.brokerGeneration ||
        getCloudAccountIdentityGeneration() !== read.cloudGeneration)
    ) {
      identityChanged = true;
      break;
    }

    repos.push({
      repoId: target.repoId ?? target.repoName,
      repoName: target.repoName,
      status: trackingData?.status ?? null,
      prLookupAvailable: trackingData != null && trackingData.remote !== null,
    });

    if (!trackingData) {
      continue;
    }

    let acceptances = new Map<string, InitiatedWorkAcceptance>();
    let advancedState: Awaited<ReturnType<typeof advancePrTrackingState>>;
    try {
      advancedState = await advancePrTrackingState({
        projectId,
        worktreeId,
        repoStorageKey: target.repoStorageKey,
        committedHead,
        ...(hookActionsByTrigger !== null
          ? {
              commit: {
                committedHead,
                accept: async (advance): Promise<void> => {
                  acceptances = await acceptPrHookFirings({
                    projectId,
                    worktreeId,
                    target,
                    subject: advance.subject,
                    head: advance.head,
                    triggerNames: advance.triggers,
                    currentSnapshot: advance.currentSnapshot,
                    hookActionsByTrigger,
                  });
                },
              },
            }
          : {}),
        branchName,
        credentialScope: verifiedScopes.get(read),
        currentSnapshot: trackingData.snapshot
          ? {
              ...trackingData.snapshot,
              credentialScope: verifiedScopes.get(read),
            }
          : null,
        // Side-effect-free read: ensureTracked would mutate the tracked entry
        // mid-refresh.
        worktreeCreatedAt: tracked.get(worktreeKey(projectId, worktreeId))
          ?.createdAt,
      });
    } catch (error) {
      // Hooks earlier repositories already accepted still start; this
      // repository's snapshot did not advance, so its triggers fire again.
      advanceFailure = { error };
      break;
    }
    if (
      advancedState.triggers.includes('pr:merged') &&
      advancedState.currentSnapshot
    ) {
      mergedBranchUpdates.push(
        updateDependentBaseBranchesForMergedWorktree({
          mergedWorkspaceId: projectId,
          mergedWorktreeId: worktreeId,
          mergedRepoFullName: advancedState.currentSnapshot.repository.fullName,
          mergedBranchName: branchName,
          mergedIntoBranchName:
            advancedState.currentSnapshot.branch.baseRefName,
        }).catch(() => []),
      );
    }
    if (
      hookActionsByTrigger === null ||
      advancedState.triggers.length === 0 ||
      !advancedState.currentSnapshot
    ) {
      continue;
    }

    pendingHookDispatches.push({
      projectId,
      worktreeId,
      target,
      triggerNames: advancedState.triggers,
      hookActionsByTrigger,
      pausedHookKeys: new Set<string>(),
      currentSnapshot: advancedState.currentSnapshot,
      currentSnapshotPath: advancedState.currentSnapshotPath,
      previousSnapshotPath: advancedState.previousSnapshotPath,
      timeoutSeconds: scriptTimeoutMinutes * 60,
      acceptances,
    });
  }

  if (pendingHookDispatches.length > 0) {
    const pausedHookKeys = await loadWatcherPause();
    for (const dispatch of pendingHookDispatches) {
      dispatch.pausedHookKeys = pausedHookKeys;
    }
  }

  if (mergedBranchUpdates.length > 0) {
    const updates = (await settleAll(mergedBranchUpdates)).flat();
    if (updates.length > 0) {
      sendToRenderer(IPC_CHANNELS.githubDependentBaseBranchesUpdated, {
        updates,
      });
    }
  }
  for (const hookDispatch of pendingHookDispatches) {
    dispatchAutomaticHooks(hookDispatch);
  }
  if (advanceFailure) throw advanceFailure.error;
  if (identityChanged) throw new Error('GitHub acquisition identity changed.');
  const status: WorktreePrStatus = {
    repos,
    lastCheckedAt: new Date().toISOString(),
  };
  const entry = ensureTracked(projectId, worktreeId);
  if (!entry) return null;
  const previousPersistedStatus = entry.lastPersistedStatus;
  entry.lastStatus = status;
  entry.lastCheckedAt = Date.now();
  sendPrStatusEvent({ projectId, worktreeId, status });
  if (
    await persistLastKnownPrStatus(
      projectId,
      worktreeId,
      previousPersistedStatus,
      status,
    )
  ) {
    entry.lastPersistedStatus = status;
  }
  return status;
}

async function readScriptTimeoutMinutes(): Promise<number> {
  const { readPreferencesFile } = await import('../lib/preferences-store');
  const prefs = await readPreferencesFile();
  return prefs.scriptTimeoutMinutes;
}

function hasCompleteCommentBaseline(data: RepoPrTrackingData): boolean {
  return (
    data.snapshot !== null &&
    data.snapshot.includesComments &&
    data.snapshot.includesReviews &&
    data.snapshot.includesReviewComments
  );
}

function rememberRead(
  key: string,
  read: PreparedRepoRefresh,
  trackingData: RepoPrTrackingData,
  sweep: {
    pullRequest: SweptPullRequest | null;
    fullRead: boolean;
    now: number;
  },
  staged: Map<string, SweptTarget>,
): void {
  const stateKey = sweptTargetKey(key, read.target.repoStorageKey);
  const previous = sweptTargets.get(stateKey);
  const pullRequestNumber =
    sweep.pullRequest?.number ?? trackingData.status?.prNumber ?? null;
  const samePullRequest =
    previous !== undefined &&
    previous.authenticationScope === read.authenticationScope &&
    previous.credentialScope === read.credentialScope &&
    previous.branchName === read.branchName &&
    previous.pullRequestNumber === pullRequestNumber;
  staged.set(stateKey, {
    authenticationScope: read.authenticationScope,
    credentialScope: read.credentialScope,
    branchName: read.branchName,
    trackingData: trackingData.snapshot
      ? {
          ...trackingData,
          snapshot: {
            ...trackingData.snapshot,
            credentialScope: read.credentialScope,
          },
        }
      : trackingData,
    pullRequestNumber,
    fingerprint: sweep.pullRequest?.fingerprint ?? null,
    checksInFlight: sweep.pullRequest?.checksInFlight ?? false,
    lastFullReadAt:
      sweep.fullRead || !samePullRequest ? sweep.now : previous.lastFullReadAt,
    includesComments:
      hasCompleteCommentBaseline(trackingData) ||
      (samePullRequest && previous.includesComments),
  });
}

/**
 * Sweep state is kept only once every repository of a worktree was read and
 * its snapshot advanced, so a partial failure re-reads all of them next time.
 */
function commitSweptTargets(staged: Map<string, SweptTarget>): void {
  for (const [stateKey, target] of Array.from(staged.entries())) {
    sweptTargets.set(stateKey, target);
  }
}

async function readInteractively(
  key: string,
  read: PreparedRepoRefresh,
  staged: Map<string, SweptTarget>,
): Promise<RepoPrTrackingData> {
  if (!read.remote) {
    return {
      status: null,
      snapshot: null,
      branchName: read.branchName,
      remote: null,
    };
  }
  if (!read.authenticationToken) {
    throw new Error('GitHub credential unavailable.');
  }
  const trackingData = await fetchRepoPrTrackingData(
    read.target.repoPath,
    read.branchName,
    {
      includeCommentCollections: read.includeCommentCollections,
      onCommentFetchSkipped: notifyCommentFetchSkipped,
      priority: 'high',
      caller: 'pr-poller',
      authenticationToken: read.authenticationToken,
    },
  );
  rememberRead(
    key,
    read,
    trackingData,
    { pullRequest: null, fullRead: true, now: Date.now() },
    staged,
  );
  return trackingData;
}

async function refreshNowCore(
  projectId: string,
  worktreeId: string,
): Promise<WorktreePrStatus | null> {
  const scriptTimeoutMinutes = await readScriptTimeoutMinutes();
  const targets = await resolveRefreshTargets(projectId, worktreeId);
  if (targets.length === 0) {
    return applyEmptyRefresh(projectId, worktreeId);
  }
  const key = worktreeKey(projectId, worktreeId);
  let prepared = await prepareRepoRefreshes(projectId, worktreeId, targets);
  if (prepared.some((read) => read.remote !== null)) {
    const identity = await snapshotReadIdentity();
    prepared = prepared.map((read) => ({ ...read, ...identity }));
  }
  const staged = new Map<string, SweptTarget>();
  const reads: RepoRefreshRead[] = [];
  for (const read of prepared) {
    reads.push({
      ...read,
      trackingData: read.branchName
        ? await readInteractively(key, read, staged)
        : null,
    });
  }
  const status = await applyRepoRefreshes(
    projectId,
    worktreeId,
    reads,
    scriptTimeoutMinutes,
  );
  commitSweptTargets(staged);
  return status;
}

async function recordedRefresh(
  projectId: string,
  worktreeId: string,
  refresh: () => Promise<WorktreePrStatus | null>,
): Promise<WorktreePrStatus | null> {
  const entry = ensureTracked(projectId, worktreeId);
  if (!entry) return null;
  if (!(await isWorktreeReadAvailable(projectId, worktreeId))) {
    // Missing folders, pending setup and unreadable lists skip this observation.
    // Keep membership so a later authoritative removal still runs cleanup.
    if (isWorkspaceTargetRemovalPending(projectId, worktreeId))
      stopTracking(projectId, worktreeId);
    return null;
  }
  const previousStatus = entry.lastStatus;
  const attemptedAt = Date.now();
  await recordGitHubRefreshAttempt({
    projectId,
    worktreeId,
    createdAt: entry.createdAt,
    attemptedAt,
  }).catch(() => undefined);

  try {
    const status = await refresh();
    if (
      tracked.get(worktreeKey(projectId, worktreeId)) !== entry ||
      isWorkspaceTargetRemovalPending(projectId, worktreeId)
    )
      return null;
    const succeededAt = Date.now();
    const nextDueAt = succeededAt + getSteadyRefreshInterval(status);
    await recordGitHubRefreshSuccess({
      projectId,
      worktreeId,
      createdAt: entry.createdAt,
      succeededAt,
      dataChanged: !areEquivalentPrStatuses(previousStatus, status),
      nextDueAt,
    }).catch(() => undefined);
    entry.steadyHydrationGeneration += 1;
    entry.steadyHydrationPending = false;
    entry.lastCheckedAt = succeededAt;
    entry.steadyDueAt = nextDueAt;
    return status;
  } catch (error) {
    if (
      tracked.get(worktreeKey(projectId, worktreeId)) !== entry ||
      isWorkspaceTargetRemovalPending(projectId, worktreeId)
    )
      return null;
    const failedAt = Date.now();
    const failureEntry = await recordGitHubRefreshFailure({
      projectId,
      worktreeId,
      createdAt: entry.createdAt,
      failedAt,
    }).catch(() => null);
    const retryAfterAt = Date.parse(failureEntry?.retryAfterAt ?? '');
    entry.steadyHydrationGeneration += 1;
    entry.steadyHydrationPending = false;
    entry.steadyDueAt =
      isGitHubRateLimitError(error) && error.retryAt !== undefined
        ? error.retryAt
        : Number.isFinite(retryAfterAt)
          ? retryAfterAt
          : failedAt + getSteadyRefreshInterval(entry.lastStatus);
    throw error;
  }
}

/** An interactive read of one worktree: focus, Merge, explicit refreshes. */
export async function refreshNow(
  projectId: string,
  worktreeId: string,
): Promise<WorktreePrStatus | null> {
  return recordedRefresh(projectId, worktreeId, () =>
    refreshNowCore(projectId, worktreeId),
  );
}

async function checkWorktree(entry: TrackedWorktree): Promise<void> {
  try {
    await refreshNow(entry.projectId, entry.worktreeId);
  } catch {
    // Silently ignore polling errors
  }
}

interface SweepRepoRead extends PreparedRepoRefresh {
  remote: { owner: string; repo: string } | null;
}

interface SweepWorktree {
  entry: TrackedWorktree;
  key: string;
  reads: SweepRepoRead[] | null;
}

function pauseSweep(error: GitHubBrokerError): void {
  sweepPausedUntil = Math.max(
    sweepPausedUntil,
    error.retryAt ?? Date.now() + RATE_LIMIT_FALLBACK_BACKOFF,
  );
}

function withCapturedAt(
  trackingData: RepoPrTrackingData,
  now: number,
): RepoPrTrackingData {
  return trackingData.snapshot
    ? {
        ...trackingData,
        snapshot: {
          ...trackingData.snapshot,
          capturedAt: new Date(now).toISOString(),
        },
      }
    : trackingData;
}

async function readSwept(
  key: string,
  read: SweepRepoRead,
  lookup: BranchPullRequestLookup,
  staged: Map<string, SweptTarget>,
): Promise<RepoPrTrackingData> {
  const now = Date.now();
  const { branchName, remote } = read;
  if (!remote) {
    return { status: null, snapshot: null, branchName, remote: null };
  }
  if (!read.authenticationToken) {
    throw new Error('GitHub credential unavailable.');
  }
  if (lookup.kind === 'none') {
    const trackingData: RepoPrTrackingData = {
      status: null,
      snapshot: null,
      branchName,
      remote,
    };
    rememberRead(
      key,
      read,
      trackingData,
      { pullRequest: null, fullRead: true, now },
      staged,
    );
    return trackingData;
  }
  const options = {
    includeCommentCollections: read.includeCommentCollections,
    onCommentFetchSkipped: notifyCommentFetchSkipped,
    priority: 'normal' as const,
    caller: 'pr-poller',
    authenticationToken: read.authenticationToken,
  };
  if (lookup.kind === 'unresolved') {
    const trackingData = await fetchRepoPrTrackingData(
      read.target.repoPath,
      branchName,
      options,
    );
    rememberRead(
      key,
      read,
      trackingData,
      { pullRequest: null, fullRead: true, now },
      staged,
    );
    return trackingData;
  }

  const { pullRequest } = lookup;
  const stored = sweptTargets.get(
    sweptTargetKey(key, read.target.repoStorageKey),
  );
  const previous =
    stored &&
    stored.authenticationScope === read.authenticationScope &&
    stored.credentialScope === read.credentialScope &&
    stored.branchName === branchName &&
    stored.pullRequestNumber === pullRequest.number
      ? stored
      : null;
  const plan = planPullRequestRead({
    previous: previous
      ? {
          number: pullRequest.number,
          fingerprint: previous.fingerprint,
          checksInFlight:
            previous.checksInFlight ||
            hasPendingChecks(previous.trackingData.status),
          lastFullReadAt: previous.lastFullReadAt,
          includesComments: previous.includesComments,
        }
      : null,
    current: pullRequest,
    needsComments: read.includeCommentCollections,
    now,
  });
  const result =
    previous && !plan.read
      ? {
          trackingData: withCapturedAt(previous.trackingData, now),
          complete: true,
        }
      : await fetchTrackedPullRequestData({
          remote,
          branchName,
          pullRequest,
          options: { ...options, includeCommentCollections: plan.comments },
          ...(previous && !plan.graphQl
            ? {
                reuseGraphQlState: reusablePrGraphQlState(
                  previous.trackingData,
                ),
              }
            : {}),
        });
  const { trackingData } = result;
  rememberRead(
    key,
    read,
    trackingData,
    {
      pullRequest: result.complete ? pullRequest : null,
      fullRead: plan.full,
      now,
    },
    staged,
  );
  await verifySnapshotReadIdentity(read);
  if (
    getGitHubBroker().getCredentialGeneration() !== read.brokerGeneration ||
    getCloudAccountIdentityGeneration() !== read.cloudGeneration
  ) {
    throw new Error('GitHub acquisition identity changed.');
  }
  emitPullRequestSwept({
    owner: remote.owner,
    repo: remote.repo,
    number: pullRequest.number,
    fingerprint: pullRequest.fingerprint,
    ...(trackingData.status ? { status: trackingData.status } : {}),
  });
  return trackingData;
}

async function prepareSweepWorktree(
  entry: TrackedWorktree,
): Promise<SweepWorktree> {
  const key = worktreeKey(entry.projectId, entry.worktreeId);
  try {
    const targets = await resolveRefreshTargets(
      entry.projectId,
      entry.worktreeId,
    );
    const prepared = await prepareRepoRefreshes(
      entry.projectId,
      entry.worktreeId,
      targets,
    );
    return { entry, key, reads: prepared };
  } catch {
    return { entry, key, reads: null };
  }
}

function remoteKey(remote: { owner: string; repo: string }): string {
  return `${remote.owner}/${remote.repo}`.toLowerCase();
}

async function refreshSweptWorktree(
  worktree: SweepWorktree,
  lookups: Map<string, Map<string, BranchPullRequestLookup>>,
  scriptTimeoutMinutes: number,
): Promise<WorktreePrStatus | null> {
  const { entry, key, reads } = worktree;
  if (reads === null) {
    throw new Error('Could not resolve the worktree repositories.');
  }
  if (reads.length === 0) {
    return applyEmptyRefresh(entry.projectId, entry.worktreeId);
  }
  const staged = new Map<string, SweptTarget>();
  const completed: RepoRefreshRead[] = [];
  for (const read of reads) {
    const lookup = read.remote
      ? lookups.get(remoteKey(read.remote))?.get(read.branchName)
      : undefined;
    completed.push({
      ...read,
      trackingData: read.branchName
        ? await readSwept(key, read, lookup ?? { kind: 'unresolved' }, staged)
        : null,
    });
  }
  const status = await applyRepoRefreshes(
    entry.projectId,
    entry.worktreeId,
    completed,
    scriptTimeoutMinutes,
  );
  commitSweptTargets(staged);
  return status;
}

/**
 * Read every due worktree with one fingerprint document per repository, then
 * read in detail only the pull requests whose fingerprint moved.
 */
async function sweep(entries: TrackedWorktree[]): Promise<void> {
  lastSweepAt = Date.now();
  const scriptTimeoutMinutes = await readScriptTimeoutMinutes();
  const worktrees: SweepWorktree[] = [];
  for (const entry of entries) {
    worktrees.push(await prepareSweepWorktree(entry));
  }
  const identity = worktrees.some((worktree) =>
    worktree.reads?.some((read) => read.remote !== null),
  )
    ? await snapshotReadIdentity()
    : unavailableSnapshotReadIdentity();
  for (const worktree of worktrees) {
    worktree.reads =
      worktree.reads?.map((read) => ({ ...read, ...identity })) ?? null;
  }

  const branchesByRemote = new Map<
    string,
    { remote: { owner: string; repo: string }; branches: string[] }
  >();
  for (const worktree of worktrees) {
    for (const read of worktree.reads ?? []) {
      if (!read.remote) continue;
      const group = branchesByRemote.get(remoteKey(read.remote)) ?? {
        remote: read.remote,
        branches: [],
      };
      group.branches.push(read.branchName);
      branchesByRemote.set(remoteKey(read.remote), group);
    }
  }

  const lookups = new Map<string, Map<string, BranchPullRequestLookup>>();
  const underlyingClient = getGitHubClient();
  const client: GitHubClient = {
    enqueue: (fn, priority, options) =>
      underlyingClient.enqueue(fn, priority, {
        ...options,
        authenticationToken: identity.authenticationToken,
      }),
  };
  for (const [groupKey, group] of Array.from(branchesByRemote.entries())) {
    if (!identity.authenticationToken) continue;
    try {
      lookups.set(
        groupKey,
        await fetchPullRequestSweep(client, group.remote, group.branches),
      );
    } catch (error) {
      if (isGitHubRateLimitError(error)) {
        pauseSweep(error);
        return;
      }
      lookups.set(groupKey, new Map());
    }
  }

  for (const worktree of worktrees) {
    const { entry } = worktree;
    if (tracked.get(worktree.key) !== entry) continue;
    try {
      await recordedRefresh(entry.projectId, entry.worktreeId, () =>
        refreshSweptWorktree(worktree, lookups, scriptTimeoutMinutes),
      );
    } catch (error) {
      if (isGitHubRateLimitError(error)) {
        pauseSweep(error);
        return;
      }
    }
  }
}

function getNextImmediateKey(): string | null {
  while (immediateQueue.length > 0) {
    const key = immediateQueue.shift();
    if (key && tracked.has(key)) {
      return key;
    }
  }
  return null;
}

function getImmediateDueAt(): number | null {
  return immediateQueue.some((key) => tracked.has(key))
    ? lastPollAt + IMMEDIATE_TICK_DELAY
    : null;
}

function getEntrySweepDueAt(
  key: string,
  entry: TrackedWorktree,
): number | null {
  if (entry.steadyHydrationPending) {
    return null;
  }
  if (key === foregroundKey && isWindowFocused()) {
    return Math.min(
      entry.steadyDueAt,
      entry.lastCheckedAt + ACTIVE_CI_SWEEP_INTERVAL,
    );
  }
  return entry.steadyDueAt;
}

function getSweepDueAt(): number | null {
  let earliest: number | null = null;
  for (const [key, entry] of Array.from(tracked.entries())) {
    const dueAt = getEntrySweepDueAt(key, entry);
    if (dueAt !== null && (earliest === null || dueAt < earliest)) {
      earliest = dueAt;
    }
  }
  if (earliest === null) {
    return null;
  }
  return Math.max(
    earliest,
    lastPollAt + IMMEDIATE_TICK_DELAY,
    lastSweepAt + MIN_SWEEP_SPACING,
    sweepPausedUntil,
  );
}

function getSweepEntries(now: number): TrackedWorktree[] {
  const due: Array<{ entry: TrackedWorktree; dueAt: number }> = [];
  for (const [key, entry] of Array.from(tracked.entries())) {
    const dueAt = getEntrySweepDueAt(key, entry);
    if (dueAt !== null && dueAt <= now + SWEEP_COALESCE_WINDOW) {
      due.push({ entry, dueAt });
    }
  }
  return due
    .sort((left, right) => left.dueAt - right.dueAt)
    .map(({ entry }) => entry);
}

function getNextDueAt(): number | null {
  const dueTimes = [getImmediateDueAt(), getSweepDueAt()].filter(
    (value): value is number => value !== null,
  );

  if (dueTimes.length === 0) {
    return null;
  }

  return Math.min(...dueTimes);
}

function scheduleNext(): void {
  if (!running || ticking) {
    return;
  }

  const nextDueAt = getNextDueAt();
  if (nextDueAt === null) {
    if (pollTimeout !== null) {
      clearTimeout(pollTimeout);
      pollTimeout = null;
    }
    return;
  }

  if (pollTimeout !== null) {
    clearTimeout(pollTimeout);
  }

  pollTimeout = setTimeout(
    detachedWorkCallback(() => {
      pollTimeout = null;
      return tick();
    }),
    Math.max(nextDueAt - Date.now(), 0),
  );
}

async function tick(): Promise<void> {
  if (!running || ticking) {
    return;
  }

  ticking = true;

  try {
    const now = Date.now();

    const immediateDueAt = getImmediateDueAt();
    if (immediateDueAt !== null && immediateDueAt <= now) {
      const key = getNextImmediateKey();
      const entry = key ? tracked.get(key) : undefined;
      if (entry) {
        lastPollAt = Date.now();
        await checkWorktree(entry);
        return;
      }
    }

    const sweepDueAt = getSweepDueAt();
    if (sweepDueAt !== null && sweepDueAt <= now) {
      const entries = getSweepEntries(now);
      if (entries.length > 0) {
        lastPollAt = Date.now();
        await sweep(entries).catch(() => undefined);
      }
    }
  } finally {
    ticking = false;
    scheduleNext();
  }
}

export function enqueueFastRefresh(
  projectId: string,
  worktreeId: string,
  skipIfFresh = false,
): void {
  const entry = ensureTracked(projectId, worktreeId);
  if (!entry) return;
  const key = worktreeKey(projectId, worktreeId);

  if (skipIfFresh) {
    if (
      entry.lastCheckedAt > 0 &&
      Date.now() - entry.lastCheckedAt <= STALE_THRESHOLD
    ) {
      return;
    }
    trackDetachedWork(() =>
      readGitHubRefreshLedgerEntry(projectId, worktreeId, entry.createdAt)
        .catch(() => null)
        .then((ledgerEntry) => {
          if (tracked.get(key) !== entry) {
            return;
          }
          const durableSuccessAt = Date.parse(ledgerEntry?.lastSuccessAt ?? '');
          const retryAfterAt = Date.parse(ledgerEntry?.retryAfterAt ?? '');
          const freshestSuccessAt = Math.max(
            entry.lastCheckedAt,
            Number.isFinite(durableSuccessAt) ? durableSuccessAt : 0,
          );
          if (
            Date.now() - freshestSuccessAt <= STALE_THRESHOLD ||
            (Number.isFinite(retryAfterAt) && retryAfterAt > Date.now())
          ) {
            return;
          }
          moveToFront(immediateQueue, key);
          scheduleNext();
        }),
    );
    return;
  }

  moveToFront(immediateQueue, key);
  scheduleNext();
}

export async function enqueueKnownPrFastRefresh(
  projectId: string,
  worktreeId: string,
): Promise<boolean> {
  const key = worktreeKey(projectId, worktreeId);
  const trackedEntry = tracked.get(key);
  let status = trackedEntry?.lastStatus ?? null;

  if (!hasKnownPr(status)) {
    status =
      (await readWorkspaceWorktrees(projectId)
        .then(
          (worktrees) =>
            worktrees.find((worktree) => worktree.id === worktreeId)
              ?.lastKnownPrStatus,
        )
        .catch(() => undefined)) ?? null;
  }

  if (!hasKnownPr(status)) {
    return false;
  }

  const entry = ensureTracked(projectId, worktreeId);
  if (!entry) return false;
  entry.lastStatus = status;
  entry.lastPersistedStatus = status;
  entry.lastCheckedAt = getStatusCheckedAt(status);
  enqueueFastRefresh(projectId, worktreeId);
  return true;
}

export function requestRefresh(
  projectId: string,
  worktreeId: string,
  force = false,
): void {
  if (!ensureTracked(projectId, worktreeId)) return;

  if (force) {
    enqueueFastRefresh(projectId, worktreeId);
    return;
  }

  scheduleNext();
}

/**
 * Current foreground worktree as a `${projectId}/${worktreeId}` key, or null
 * when no worktree is selected. Consumers outside the GitHub poller (e.g. the
 * diff-stats batch handler's code-graph nudge gate) use this to distinguish
 * the user-visible worktree from background fleet members.
 */
export function getForegroundWorktreeKey(): string | null {
  return foregroundKey;
}

export function setForegroundWorktree(
  projectId: string | null,
  worktreeId: string | null,
): void {
  foregroundKey = null;

  if (!projectId || !worktreeId) {
    scheduleNext();
    return;
  }

  if (!ensureTracked(projectId, worktreeId)) {
    scheduleNext();
    return;
  }
  foregroundKey = worktreeKey(projectId, worktreeId);
  scheduleNext();
}

export function syncTrackedWorktrees(
  items: SidebarItem[],
  preserveWorkspaceIds: ReadonlySet<string> = new Set(),
): void {
  const nextKeys = new Set<string>();

  for (const item of items) {
    if (item.type === 'cowork') {
      continue;
    }

    for (const worktree of item.worktrees) {
      const key = worktreeKey(item.id, worktree.id);
      const entry = ensureTracked(item.id, worktree.id, worktree.createdAt);
      if (!entry) continue;
      nextKeys.add(key);
      entry.steadyHydrationGeneration += 1;
      const hydrationGeneration = entry.steadyHydrationGeneration;
      entry.steadyHydrationPending = true;
      entry.lastStatus = worktree.lastKnownPrStatus ?? null;
      entry.lastPersistedStatus = worktree.lastKnownPrStatus ?? null;
      entry.lastCheckedAt = getStatusCheckedAt(entry.lastStatus);
      trackDetachedWork(() =>
        readGitHubRefreshLedgerEntry(item.id, worktree.id, worktree.createdAt)
          .catch(() => null)
          .then((ledgerEntry) => {
            const current = tracked.get(key);
            if (
              current !== entry ||
              current.steadyHydrationGeneration !== hydrationGeneration
            ) {
              return;
            }
            current.steadyHydrationPending = false;
            const durableSuccessAt = Date.parse(
              ledgerEntry?.lastSuccessAt ?? '',
            );
            if (Number.isFinite(durableSuccessAt)) {
              current.lastCheckedAt = Math.max(
                current.lastCheckedAt,
                durableSuccessAt,
              );
            }
            const durableNextDueAt = Date.parse(ledgerEntry?.nextDueAt ?? '');
            const retryAfterAt = Date.parse(ledgerEntry?.retryAfterAt ?? '');
            current.steadyDueAt = Math.max(
              current.steadyDueAt,
              Number.isFinite(durableNextDueAt) ? durableNextDueAt : 0,
              Number.isFinite(retryAfterAt) ? retryAfterAt : 0,
            );
            scheduleNext();
          }),
      );
    }
  }

  for (const [key, entry] of Array.from(tracked.entries())) {
    if (preserveWorkspaceIds.has(entry.projectId)) {
      nextKeys.add(key);
    }
  }

  for (const key of Array.from(tracked.keys())) {
    if (!nextKeys.has(key)) {
      removeTrackedKey(key);
    }
  }

  if (foregroundKey !== null && !nextKeys.has(foregroundKey)) {
    foregroundKey = null;
  }

  scheduleNext();
}

function removeTrackedKey(key: string): void {
  const previous = tracked.get(key);
  if (previous)
    trackDetachedWork(() =>
      removeGitHubRefreshLedgerEntry(previous.projectId, previous.worktreeId),
    );
  tracked.delete(key);
  removeFromQueue(immediateQueue, key);
  for (const stateKey of Array.from(sweptTargets.keys())) {
    if (stateKey.startsWith(sweptTargetKey(key, ''))) {
      sweptTargets.delete(stateKey);
    }
  }
  if (foregroundKey === key) {
    foregroundKey = null;
  }
}

export function reconcileTrackedWorkspaceWorktrees(
  workspaceId: string,
  worktrees: readonly WorktreeData[],
): TrackedWorkspaceReconciliationResult {
  const nextKeys = new Set(
    worktrees.map((worktree) => worktreeKey(workspaceId, worktree.id)),
  );
  const addedWorktreeIds: string[] = [];
  const removedWorktreeIds: string[] = [];

  for (const worktree of worktrees) {
    const key = worktreeKey(workspaceId, worktree.id);
    const isNew = !tracked.has(key);
    const entry = ensureTracked(workspaceId, worktree.id, worktree.createdAt);
    if (!entry) continue;
    // Reconciliation snapshots carry identity only (id/branch/createdAt), so
    // status may only be seeded for NEW entries — overwriting an existing
    // entry would null-clobber live PR status and demote its polling queue.
    if (isNew) {
      entry.lastStatus = worktree.lastKnownPrStatus ?? null;
      entry.lastPersistedStatus = worktree.lastKnownPrStatus ?? null;
      entry.lastCheckedAt = getStatusCheckedAt(entry.lastStatus);
      addedWorktreeIds.push(worktree.id);
      moveToFront(immediateQueue, key);
    }
  }

  for (const [key, entry] of Array.from(tracked.entries())) {
    if (entry.projectId === workspaceId && !nextKeys.has(key)) {
      removedWorktreeIds.push(entry.worktreeId);
      removeTrackedKey(key);
    }
  }
  scheduleNext();
  return { addedWorktreeIds, removedWorktreeIds };
}

export function startPolling(getWindow: () => BrowserWindow | null): void {
  getWindowFn = getWindow;
  // Enroll ready checkouts even before the next sidebar sync, but only install
  // this subscriber in hosts that actually initialize PR polling.
  gitReadySubscription ??= registerWorktreeGitReadyHook(
    async ({ projectId, worktreeId }) => {
      if (isWorkspaceTargetRemovalPending(projectId, worktreeId)) return;
      const list = await readWorkspaceWorktreesUnlocked(projectId);
      const row = list.worktrees.find((worktree) => worktree.id === worktreeId);
      if (!row || !ensureTracked(projectId, worktreeId, row.createdAt)) return;
      enqueueFastRefresh(projectId, worktreeId);
    },
  );
  startHookRecovery({
    getWindow,
    events: automaticHookRunEvents,
    ledgerExists: () => existsSync(getOperationLedgerPath()),
  });
  running = true;
  scheduleNext();
}

export function stopPolling(): void {
  running = false;
  if (pollTimeout) {
    clearTimeout(pollTimeout);
    pollTimeout = null;
  }
}

export function stopTracking(projectId: string, worktreeId: string): void {
  const key = worktreeKey(projectId, worktreeId);
  removeTrackedKey(key);
  scheduleNext();
}

export function suspendTrackingForE2e(
  projectId: string,
  worktreeId: string,
): boolean {
  if (!__CANOPY_E2E__) {
    return false;
  }
  e2eSuspendedKeys.add(worktreeKey(projectId, worktreeId));
  stopTracking(projectId, worktreeId);
  return true;
}

subscribeWorkspaceTargetRemoval((projectId, worktreeId) => {
  stopTracking(projectId, worktreeId);
  trackDetachedWork(() =>
    removeGitHubRefreshLedgerEntry(projectId, worktreeId),
  );
});
