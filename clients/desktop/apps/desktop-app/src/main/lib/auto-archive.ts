import { lstat } from 'node:fs/promises';
import { getWorkspaceWorktreeDir } from './paths';
import { isErrnoException } from './type-guards';
import type { AutoDeleteAttention } from '@canopy/protocol/portal/auto-delete-attention';
import { AutoDeleteInspectionError } from './auto-delete-inspection-error';
import { W5CommitRefusedError } from '@canopy/desktop-shared/node/w5-commit-log/errors';
import { logMainProcessWarn } from './main-process-logging';
import type { WorktreeRecoveryDescription } from '@canopy/protocol/portal/worktree-recovery';
import {
  describeWorktreeDiscard,
  withTypedArchiveRefusal,
} from './worktree-discard';
import { recoveryFromRefusal } from './worktree-recovery-description';
import { destructiveFailureRecord } from './destructive-failure-context';
import {
  canAdmitInterruptedArchive,
  destructiveArchiveOutcomeSchema,
  findCompletedDestructiveArchive,
  filterBlockingDestructiveRecoveries,
  readDestructiveRecovery,
  readWorkspaceDestructiveRecoveries,
} from './w5-destructive-recovery';
import {
  captureAutoDeleteAttention,
  type AutoDeleteAttentionGeneration,
  listAutoDeleteRecoveryCandidates,
  recordAutoDeleteAttention,
  resolveAutoDeleteAttention,
  resolveAutoDeleteJournalAttention,
  retireReplacedAutoDeleteAttention,
} from './auto-delete-attention';
import { withArchivedWorkspaceOperationLock } from './archived-containers';
import { readWorkspaceWorktreesDetailed } from './workspace-persistence';
import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  type AppAdvisorWatcherSummary,
  type AutoArchiveNotification,
  type AutomationAction,
  type ScheduledActivity,
  type SidebarItem,
  type WorktreeData,
} from '@canopy/desktop-shared/types';
import { resolveAutoArchiveDays } from '@canopy/desktop-shared/lib/archive-retention';
import {
  pipelineAutomationTaskId,
  pipelineAutomationWorkspaceId,
} from '@canopy/desktop-shared/lib/automation-pipeline-target';
import {
  listBackgroundWorkTargets,
  subscribeBackgroundWork,
  worktreeBlocksClose,
} from '../agents/background-work';
import {
  LiveDelegationsError,
  listDelegationActivity,
  parseDelegationSessionKey,
  subscribeDelegationActivity,
  worktreeHasLiveDelegations,
} from '../agents/delegation/activity';
import {
  getAllActiveSessionInfos,
  subscribeChatSessionActivity,
} from '../agents/session-manager';
import { getAppAdvisorWatcherService } from '../app-advisor/watchers';
import { projectOwnedChatAutomation } from '../automations/owned-chat-projection';
import { getAutomationsService } from '../automations/service';
import {
  getActivePipelineExecutionHandles,
  subscribeToActiveCountChange,
} from '../pipelines/pipeline-execution-registry';
import { getWorktreeRuntimeStatuses } from '../services/worktree-runtime-status-service';
import {
  assertNotSplitDestinationWorktreeClaimed,
  assertNotSplitLocked,
  isSplitDestinationWorktreeClaimed,
  isSplitLocked,
} from '../services/split-lock-service';
import type { WorkerTerminalEventType } from '@canopy/core-runtime/node/terminal';
import { workerTerminal } from '../terminal/worker-terminal';
import { readAppAdvisorWorkspaceSettings } from './app-advisor-workspace';
import { listWorkEntryChatSummaries } from './cowork-work-entries';
import { readWorkEntriesFile } from './cowork-work-entries-file';
import { archiveWorkEntry } from './work-entry-archive';
import {
  cleanupLiveWorktreeState,
  purgeLiveWorktreeObservabilityData,
} from './worktree-live-cleanup';
import {
  archiveMultiRepoWorktree,
  archiveSingleRepoWorktree,
  findWorktreeArchiveSourceRefusal,
} from './worktree-service';
import { workflowScheduleDestination } from '@canopy/desktop-shared/lib/workflow-schedule-destination';
import { readAllSidebarItems } from './sidebar-items';
import { resolveCoworkWorkspaceId } from './cowork-migration-map';
import {
  listActiveHookRunTargets,
  subscribeActiveHookRunsChanged,
} from './hook-runner';
import {
  listTrackedShellScripts,
  subscribeTrackedScriptsChanged,
} from './script-runner';
import { touchWorkspaceTarget } from './workspace-activity';
import {
  WorkspaceTargetAutoArchiveExcludedError,
  withWorkspaceTargetAutoArchiveLease,
  withWorkspaceTargetAutoArchiveTeardown,
  isWorkspaceTargetAutoArchiveTeardown,
} from './workspace-target-exclusion';

const DAY_MS = 24 * 60 * 60 * 1_000;
const AUTO_ARCHIVE_SWEEP_INTERVAL_MS = 12 * 60 * 60 * 1_000;

type AutoArchiveSurface =
  | 'single-repo'
  | 'multi-repo'
  | 'cowork'
  | 'app-advisor';

export interface AutoArchiveCandidate {
  surface: AutoArchiveSurface;
  workspaceId: string;
  workspaceName: string;
  targetId: string;
  targetName: string;
  createdAt: string;
  lastTouchedAt?: string;
  inactivityDays: number;
  deleteBranch?: boolean;
  worktree?: WorktreeData;
  /** A failed cleanup can outlive canonical row removal; finish admission is mandatory. */
  recoveryOnly?: true;
}

export interface AutoArchiveResult {
  candidate: AutoArchiveCandidate;
  status: 'success' | 'failure' | 'attention';
  recovery?: WorktreeRecoveryDescription;
  error?: string;
  warnings?: string[];
}

interface CurrentAutoArchivePolicy {
  deleteBranch?: boolean;
}

let autoArchiveResultListener:
  | ((notification: AutoArchiveNotification) => void)
  | null = null;

export function setAutoArchiveResultListener(
  listener: ((notification: AutoArchiveNotification) => void) | null,
): void {
  autoArchiveResultListener = listener;
}

export interface AutoArchiveDependencies {
  listSidebarItems: () => Promise<SidebarItem[]>;
  reconcileAttention?: (workspaceIds: readonly string[]) => Promise<void>;
  readAttention?: (
    workspaceIds: readonly string[],
  ) => Promise<AutoDeleteAttention[]>;
  readWorkEntries: (
    workspaceId: string,
  ) => ReturnType<typeof readWorkEntriesFile>;
  listWorkEntryChatSummaries: (
    workspaceId: string,
  ) => ReturnType<typeof listWorkEntryChatSummaries>;
  readAppAdvisorSettings: () => ReturnType<
    typeof readAppAdvisorWorkspaceSettings
  >;
  listWatchers: () => Promise<AppAdvisorWatcherSummary[]>;
  listAutomations: () => ReturnType<
    ReturnType<typeof getAutomationsService>['list']
  >;
  archive: (
    candidate: AutoArchiveCandidate,
  ) => Promise<void | WorkspaceTargetRemovalOutcome>;
  isRuntimeBusy: (candidate: AutoArchiveCandidate) => Promise<boolean>;
  touch: (workspaceId: string, targetId: string, now: number) => Promise<void>;
  onResult: (result: AutoArchiveResult) => void;
}

function targetKey(workspaceId: string, targetId: string): string {
  return `${workspaceId}\0${targetId}`;
}

function isValidTimestamp(value: string | undefined): boolean {
  return value !== undefined && Number.isFinite(Date.parse(value));
}

function workEntryDisplayName(entry: {
  id: string;
  title?: string;
  summary?: { title: string };
}): string {
  return entry.title?.trim() || entry.summary?.title || entry.id;
}

export async function collectAutoArchiveCandidates(
  deps: Pick<
    AutoArchiveDependencies,
    | 'listSidebarItems'
    | 'readWorkEntries'
    | 'readAppAdvisorSettings'
    | 'readAttention'
  >,
): Promise<AutoArchiveCandidate[]> {
  const candidates: AutoArchiveCandidate[] = [];
  const items = await deps.listSidebarItems();
  for (const item of items) {
    if (item.type === 'cowork') {
      const inactivityDays = resolveAutoArchiveDays(
        'cowork',
        item.archiveRetentionDays,
        item.autoArchiveDays,
      );
      if (inactivityDays === null) continue;
      const entries = await deps.readWorkEntries(item.id);
      for (const entry of entries.entries) {
        candidates.push({
          surface: 'cowork',
          workspaceId: item.id,
          workspaceName: item.name,
          targetId: entry.id,
          targetName: workEntryDisplayName(entry),
          createdAt: entry.createdAt,
          ...(entry.lastTouchedAt
            ? { lastTouchedAt: entry.lastTouchedAt }
            : {}),
          inactivityDays,
        });
      }
      continue;
    }

    const inactivityDays = resolveAutoArchiveDays(
      item.type,
      item.archiveRetentionDays,
      item.autoArchiveDays,
    );
    if (inactivityDays === null) continue;
    for (const worktree of item.worktrees) {
      candidates.push({
        surface: item.type,
        workspaceId: item.id,
        workspaceName: item.name,
        targetId: worktree.id,
        targetName: worktree.label?.trim() || worktree.branchName,
        createdAt: worktree.createdAt,
        ...(worktree.lastTouchedAt
          ? { lastTouchedAt: worktree.lastTouchedAt }
          : {}),
        inactivityDays,
        deleteBranch: item.autoArchiveDeleteBranch === true,
        worktree,
      });
    }
  }

  const appAdvisorSettings = await deps.readAppAdvisorSettings();
  const appAdvisorDays = resolveAutoArchiveDays(
    'app-advisor',
    appAdvisorSettings.archiveRetentionDays,
    appAdvisorSettings.autoArchiveDays,
  );
  if (appAdvisorDays !== null) {
    const entries = await deps.readWorkEntries(APP_ADVISOR_PROJECT_ID);
    for (const entry of entries.entries) {
      if (entry.id === APP_ADVISOR_WORKTREE_ID) continue;
      candidates.push({
        surface: 'app-advisor',
        workspaceId: APP_ADVISOR_PROJECT_ID,
        workspaceName: ORCHESTRATOR_LABEL,
        targetId: entry.id,
        targetName: workEntryDisplayName(entry),
        createdAt: entry.createdAt,
        ...(entry.lastTouchedAt ? { lastTouchedAt: entry.lastTouchedAt } : {}),
        inactivityDays: appAdvisorDays,
      });
    }
  }
  // A committed cleanup can fail after its row has already left the list.
  // The incident names the incarnation, but only current finish admission can run it.
  for (const attention of (await deps.readAttention?.(
    items.map((item) => item.id),
  )) ?? []) {
    if (attention.kind !== 'worktree' || attention.reason.intent !== 'delete')
      continue;
    const item = items.find((item) => item.id === attention.workspaceId);
    if (
      !item ||
      item.type === 'cowork' ||
      item.worktrees.some((row) => row.id === attention.worktreeId)
    )
      continue;
    const inactivityDays = resolveAutoArchiveDays(
      item.type,
      item.archiveRetentionDays,
      item.autoArchiveDays,
    );
    if (inactivityDays === null) continue;
    candidates.push({
      surface: item.type,
      workspaceId: item.id,
      workspaceName: item.name,
      targetId: attention.worktreeId,
      targetName: attention.worktreeName,
      createdAt: attention.createdAt,
      inactivityDays,
      recoveryOnly: true,
    });
  }
  return candidates;
}

export async function resolveCurrentAutoArchivePolicy(
  candidate: AutoArchiveCandidate,
  evaluatedAt: number,
  deps: Pick<
    AutoArchiveDependencies,
    'listSidebarItems' | 'readAppAdvisorSettings'
  >,
): Promise<CurrentAutoArchivePolicy> {
  let inactivityDays: number | null = null;
  let deleteBranch: boolean | undefined;
  if (candidate.surface === 'app-advisor') {
    const settings = await deps.readAppAdvisorSettings();
    inactivityDays = resolveAutoArchiveDays(
      'app-advisor',
      settings.archiveRetentionDays,
      settings.autoArchiveDays,
    );
  } else {
    const item = (await deps.listSidebarItems()).find(
      (entry) =>
        entry.id === candidate.workspaceId && entry.type === candidate.surface,
    );
    if (item) {
      inactivityDays = resolveAutoArchiveDays(
        item.type,
        item.archiveRetentionDays,
        item.autoArchiveDays,
      );
      if (item.type === 'single-repo' || item.type === 'multi-repo') {
        deleteBranch = item.autoArchiveDeleteBranch === true;
      }
    }
  }
  const activityAt = candidate.lastTouchedAt ?? candidate.createdAt;
  if (
    inactivityDays === null ||
    !isValidTimestamp(activityAt) ||
    Date.parse(activityAt) > evaluatedAt - inactivityDays * DAY_MS
  ) {
    throw new WorkspaceTargetAutoArchiveExcludedError(
      'Auto Delete policy changed before deletion',
    );
  }
  return deleteBranch === undefined ? {} : { deleteBranch };
}

function addAutomationTarget(
  keys: Set<string>,
  action: AutomationAction,
): void {
  if (action.type === 'worktree_session_prompt') {
    keys.add(targetKey(action.workspaceId, action.worktreeId));
  } else if (action.type === 'worktree_prompt' && action.existingWorktreeId) {
    keys.add(targetKey(action.workspaceId, action.existingWorktreeId));
  } else if (action.type === 'worktree_prompt' && action.baseWorktreeId) {
    keys.add(targetKey(action.workspaceId, action.baseWorktreeId));
  } else if (action.type === 'worktree_pipeline') {
    const workspaceId = pipelineAutomationWorkspaceId(action);
    const worktreeId =
      pipelineAutomationTaskId(action) ?? action.baseWorktreeId;
    if (workspaceId && worktreeId) keys.add(targetKey(workspaceId, worktreeId));
  } else if (action.type === 'standalone_prompt' && action.workEntryId) {
    keys.add(
      targetKey(
        resolveCoworkWorkspaceId(action.chatProjectId),
        action.workEntryId,
      ),
    );
  } else if (action.type === 'app_advisor_prompt' && action.workEntryId) {
    keys.add(targetKey(APP_ADVISOR_PROJECT_ID, action.workEntryId));
  } else if (
    action.type === 'pipeline_execution_resume' &&
    action.projectId &&
    action.worktreeId
  ) {
    keys.add(targetKey(action.projectId, action.worktreeId));
  }
}

export function collectScheduledAutomationTargetKeys(
  activities: ScheduledActivity[],
  runningActivityIds: ReadonlySet<string>,
): Set<string> {
  const keys = new Set<string>();
  for (const activity of activities) {
    if (!activity.enabled && !runningActivityIds.has(activity.id)) continue;
    // A converted chat automation stores a global pipeline whose inputs name
    // its destination; read it as the chat action it stands for (CAN-5479).
    const projected = projectOwnedChatAutomation(activity, activities);
    // CAN-5782: every workflow schedule, owner or not, keeps the task its
    // run values name.
    const destination = workflowScheduleDestination(projected);
    if (destination?.kind === 'chat_action')
      addAutomationTarget(keys, destination.action);
    else if (destination?.kind === 'inputs') {
      // An Orchestrator schedule's task is a Work Entry of the Orchestrator.
      const projectId =
        destination.projectId ??
        (destination.orchestrator ? APP_ADVISOR_PROJECT_ID : undefined);
      if (projectId && destination.taskId)
        keys.add(targetKey(projectId, destination.taskId));
      // And what its action reserves itself, such as a new worktree's base.
      addAutomationTarget(
        keys,
        projected.ownedPipeline?.storedAction ?? projected.action,
      );
    } else addAutomationTarget(keys, projected.action);
  }
  return keys;
}

export function collectWatcherTargetKeys(
  watchers: AppAdvisorWatcherSummary[],
  chatOwners: ReadonlyMap<string, string>,
): Set<string> {
  const keys = new Set<string>();
  for (const watcher of watchers) {
    if (watcher.status !== 'active' && watcher.status !== 'firing') continue;
    const destinationOwner = chatOwners.get(
      `${watcher.destination.projectId}\0${watcher.destination.chatId}`,
    );
    keys.add(
      targetKey(
        watcher.destination.projectId,
        destinationOwner ?? watcher.destination.worktreeId,
      ),
    );
    const target = watcher.target;
    if (
      target.kind === 'worktree_chat' ||
      target.kind === 'worktree_chat_scope' ||
      target.kind === 'worktree_pipeline' ||
      target.kind === 'worktree_hook'
    ) {
      keys.add(targetKey(target.projectId, target.worktreeId));
    } else if (target.kind === 'standalone_chat') {
      const owner = chatOwners.get(`${target.projectId}\0${target.chatId}`);
      if (owner) keys.add(targetKey(target.projectId, owner));
    }
  }
  return keys;
}

/** Live runtime work that keeps a due target from Auto Delete. */
async function runtimeBusyReasons(
  candidate: AutoArchiveCandidate,
): Promise<WorkspaceTargetBusyReason[]> {
  if (worktreeHasLiveDelegations(candidate.workspaceId, candidate.targetId))
    return ['agent'];
  if (worktreeBlocksClose(candidate.workspaceId, candidate.targetId))
    return ['background work'];
  const activeSessions = getAllActiveSessionInfos().filter(
    (session) =>
      session.projectId === candidate.workspaceId &&
      session.worktreeId === candidate.targetId &&
      (session.turnActive ||
        session.pendingMessageCount > 0 ||
        (session.activeBackgroundTaskCount ?? 0) > 0),
  );
  if (activeSessions.length) return activeSessions.map(() => 'agent');
  const worktree =
    candidate.worktree ??
    ({
      id: candidate.targetId,
      branchName: candidate.targetName,
      createdAt: candidate.createdAt,
    } satisfies WorktreeData);
  const statuses = await getWorktreeRuntimeStatuses([
    { workspaceId: candidate.workspaceId, worktree },
  ]);
  const status = statuses.get(
    targetKey(candidate.workspaceId, candidate.targetId),
  );
  const reasons: WorkspaceTargetBusyReason[] = [];
  if (status?.isStreaming) reasons.push('agent');
  if (status?.pipelineStatus) reasons.push('workflow');
  if (status?.terminalStatus) reasons.push('terminal');
  if (status?.scriptStatus) reasons.push('script');
  if (status?.hookStatus) reasons.push('hook');
  if (status?.isRunningRun) reasons.push('background work');
  return reasons;
}

export async function isAutoArchiveRuntimeBusy(
  candidate: AutoArchiveCandidate,
): Promise<boolean> {
  return (await runtimeBusyReasons(candidate)).length > 0;
}

export interface WorkspaceTargetRemovalPolicy {
  mode: 'delete' | 'archive';
  teardown: 'error' | 'force';
  branch: { kind: 'preference' } | { kind: 'force' } | { kind: 'keep' };
}

export type WorkspaceTargetRemovalOutcome =
  | { status: 'success'; warnings?: string[] }
  | { status: 'obsolete' }
  | {
      status: 'attention';
      recovery: WorktreeRecoveryDescription;
      fresh: boolean;
    };

interface AutoDeleteTransition {
  obsolete: boolean;
  recovery: WorktreeRecoveryDescription | null;
  generations: readonly AutoDeleteAttentionGeneration[];
  completedBefore?: readonly string[];
}

interface AutoDeleteTeardownFailure {
  error: unknown;
  completedBefore?: readonly string[];
}

async function captureAttention(
  workspaceId: string,
): Promise<AutoDeleteAttentionGeneration[]> {
  return captureAutoDeleteAttention(workspaceId).catch((error: unknown) => {
    logMainProcessWarn('Could not read Auto Delete attention', error);
    return [];
  });
}

async function checkoutPresence(
  candidate: AutoArchiveCandidate,
): Promise<'live' | 'absent' | 'unknown'> {
  try {
    const stat = await lstat(
      getWorkspaceWorktreeDir(candidate.workspaceId, candidate.targetId),
    );
    return stat.isDirectory() && !stat.isSymbolicLink() ? 'live' : 'unknown';
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return 'absent';
    throw error;
  }
}

/** Called under the executor's archive owner; never calls the deletion lifecycle. */
async function inspectAutoDeleteTransition(
  candidate: AutoArchiveCandidate,
  intent: 'archive' | 'delete',
  teardownFailure?: AutoDeleteTeardownFailure,
): Promise<AutoDeleteTransition> {
  const request = {
    workspaceId: candidate.workspaceId,
    worktreeId: candidate.targetId,
    intent,
    expectedCreatedAt: candidate.createdAt,
  };
  const generations = await captureAttention(candidate.workspaceId);
  let completedBefore: string[] | undefined;
  const result = (
    recovery: WorktreeRecoveryDescription | null,
    obsolete = false,
  ): AutoDeleteTransition => ({
    recovery,
    obsolete,
    generations,
    completedBefore,
  });
  try {
    const inventory = await readWorkspaceWorktreesDetailed(
      candidate.workspaceId,
      {
        persistRemovalCleanup: false,
        includeRecentlyRemoved: true,
      },
    );
    if (inventory.authority !== 'ok')
      throw (
        inventory.unserved ?? new Error('Worktree identity could not be read.')
      );
    const current = inventory.worktrees.find(
      (row) => row.id === candidate.targetId,
    );
    if (current) {
      if (
        generations.some(
          ({ attention }) =>
            attention.kind === 'worktree' &&
            attention.worktreeId === candidate.targetId &&
            attention.createdAt !== current.createdAt,
        )
      )
        await retireReplacedAutoDeleteAttention([
          {
            workspaceId: candidate.workspaceId,
            worktreeId: candidate.targetId,
            createdAt: current.createdAt,
          },
        ]).catch((error: unknown) =>
          logMainProcessWarn('Could not retire Auto Delete attention', error),
        );
      if (current.createdAt !== candidate.createdAt) return result(null, true);
    }
    // The journal directory is global. Retire only the generation observed before
    // scanning it: another workspace's unreadable entry can produce newer review.
    const records = await readWorkspaceDestructiveRecoveries(
      candidate.workspaceId,
    );
    completedBefore = records
      .filter((record) => {
        const outcome = destructiveArchiveOutcomeSchema.safeParse(
          record.outcome,
        );
        return (
          record.worktreeId === candidate.targetId &&
          record.createdAt === candidate.createdAt &&
          record.state === 'completed' &&
          !record.cleanupRequired &&
          record.steps.every((step) => step.state === 'done') &&
          outcome.success &&
          outcome.data.success
        );
      })
      .map((record) => record.operationId);
    await resolveAutoDeleteJournalAttention(
      candidate.workspaceId,
      generations,
    ).catch((error: unknown) =>
      logMainProcessWarn(
        'Could not resolve Auto Delete journal attention',
        error,
      ),
    );
    const blocking = await filterBlockingDestructiveRecoveries(
      records,
      candidate.targetId,
      true,
    );
    let standing = generations.filter(
      ({ attention }) =>
        attention.kind === 'worktree' &&
        attention.worktreeId === candidate.targetId &&
        attention.createdAt === candidate.createdAt,
    );
    if (
      !current &&
      blocking.length === 0 &&
      (await checkoutPresence(candidate)) === 'absent'
    ) {
      const completed = await findCompletedDestructiveArchive(
        candidate.workspaceId,
        candidate.targetId,
        candidate.createdAt,
      );
      const outcome = destructiveArchiveOutcomeSchema.safeParse(
        completed?.outcome,
      );
      const failedOperation = destructiveFailureRecord(
        teardownFailure?.error,
      )?.operationId;
      // Recovery can commit under a new operation ID while a failed call unwinds.
      if (
        completed &&
        (!failedOperation ||
          failedOperation === completed.operationId ||
          (teardownFailure?.completedBefore !== undefined &&
            !teardownFailure.completedBefore.includes(
              completed.operationId,
            ))) &&
        !completed.cleanupRequired &&
        outcome.success &&
        outcome.data.success &&
        (completed.operation === 'worktree-archive' ||
          completed.operation === 'worktree-delete') &&
        completed.steps.every((step) => step.state === 'done') &&
        standing.every(
          (row) => !row.completedBefore?.includes(completed.operationId),
        )
      ) {
        await resolveAutoDeleteAttention(
          candidate.workspaceId,
          candidate.targetId,
          candidate.createdAt,
          false,
          generations,
        ).catch((error: unknown) =>
          logMainProcessWarn('Could not resolve Auto Delete attention', error),
        );
        return result(null, true);
      }
    }
    if (
      blocking.length === 1 &&
      !candidate.recoveryOnly &&
      (candidate.surface === 'single-repo' ||
        candidate.surface === 'multi-repo')
    ) {
      const journal = await readDestructiveRecovery(
        candidate.workspaceId,
        candidate.targetId,
      );
      if (
        journal !== null &&
        journal.operationId === blocking[0].operationId &&
        (await canAdmitInterruptedArchive(journal, {
          operation: 'worktree-archive',
          worktreeId: candidate.targetId,
          createdAt: candidate.createdAt,
        })) &&
        (await findWorktreeArchiveSourceRefusal(
          candidate.workspaceId,
          [candidate.targetId],
          candidate.surface,
        )) === undefined
      )
        return result(null);
    }
    // Fresh executor evidence supersedes the standing explanation even when its
    // journal was withdrawn; otherwise its completion baseline stays stale.
    if (blocking.length === 0 && teardownFailure)
      return result(recoveryFromRefusal(request, teardownFailure.error));
    if (current && blocking.length === 0) {
      // Older inspections could persist transient read failures as incidents.
      // Never retire a withdrawn lifecycle's operation or stopping point here.
      const unsupported = standing.filter(
        (row) =>
          row.operationIds.length === 0 &&
          row.attention.reason.code === 'external.worktree_recovery_required' &&
          row.attention.reason.stoppingPoint.phase === 'unknown' &&
          row.attention.reason.stoppingPoint.state === 'unknown',
      );
      if (
        unsupported.length > 0 &&
        (await checkoutPresence(candidate)) === 'live'
      ) {
        await resolveAutoDeleteAttention(
          candidate.workspaceId,
          candidate.targetId,
          candidate.createdAt,
          false,
          unsupported,
        ).catch((error: unknown) =>
          logMainProcessWarn('Could not resolve Auto Delete attention', error),
        );
        standing = standing.filter((row) => !unsupported.includes(row));
      }
    }
    if (blocking.length === 0 && standing.length === 0) {
      return result(null, candidate.recoveryOnly === true);
    }
    const description = await describeWorktreeDiscard(
      candidate.workspaceId,
      candidate.targetId,
      { recovery: request },
    );
    const recovery = description.recovery ?? recoveryFromRefusal(request);
    // Completed history is not the evidence of a newer withdrawn failure.
    const withdrawn =
      blocking.length === 0 ? standing[0]?.attention : undefined;
    return result(
      withdrawn
        ? {
            ...recovery,
            ...withdrawn.reason,
            evidence: { kind: 'unknown' },
          }
        : recovery,
    );
  } catch (error) {
    if (
      (error instanceof W5CommitRefusedError &&
        error.reason === 'recovery-required') ||
      destructiveFailureRecord(error)
    )
      return result(recoveryFromRefusal(request, error));
    throw new AutoDeleteInspectionError(error);
  }
}

/** Admission comes from current evidence; attention never grants a retry. */
export async function inspectAutoDeleteRecovery(
  candidate: AutoArchiveCandidate,
  intent: 'archive' | 'delete',
): Promise<WorktreeRecoveryDescription | null> {
  return withArchivedWorkspaceOperationLock(
    candidate.workspaceId,
    async () => (await inspectAutoDeleteTransition(candidate, intent)).recovery,
  );
}

/** Re-observe under the executor owner, not from a captured refusal or sidebar. */
export async function recordCurrentAutoDeleteAttention(
  candidate: AutoArchiveCandidate,
  intent: 'archive' | 'delete',
  teardownFailure?: AutoDeleteTeardownFailure,
): Promise<WorkspaceTargetRemovalOutcome> {
  return withArchivedWorkspaceOperationLock(candidate.workspaceId, async () => {
    const transition = await inspectAutoDeleteTransition(
      candidate,
      intent,
      teardownFailure,
    );
    if (transition.obsolete || !transition.recovery)
      return { status: 'obsolete' };
    const recovery = transition.recovery;
    const fresh = await recordAutoDeleteAttention(
      {
        workspaceId: candidate.workspaceId,
        worktreeId: candidate.targetId,
        createdAt: candidate.createdAt,
        worktreeName: candidate.targetName,
      },
      recovery,
      transition.completedBefore,
    ).catch((error: unknown) => {
      logMainProcessWarn('Could not persist Auto Delete attention', error);
      return false;
    });
    return { status: 'attention', recovery, fresh };
  });
}

/** Sweep lifecycle phase, independent of Auto Delete policy and UI projections. */
async function reconcileAutoDeleteIncidents(
  workspaceIds: readonly string[],
): Promise<void> {
  for (const workspaceId of workspaceIds) {
    const generations = await captureAttention(workspaceId);
    for (const { attention } of generations) {
      if (attention.kind !== 'worktree') continue;
      await withArchivedWorkspaceOperationLock(workspaceId, () =>
        inspectAutoDeleteTransition(
          {
            surface: 'single-repo',
            workspaceId,
            workspaceName: '',
            targetId: attention.worktreeId,
            targetName: attention.worktreeName,
            createdAt: attention.createdAt,
            inactivityDays: 0,
            recoveryOnly: true,
          },
          attention.reason.intent,
        ),
      ).catch((error: unknown) =>
        logMainProcessWarn('Could not reconcile Auto Delete attention', error),
      );
    }
    if (
      generations.some(({ attention }) => attention.kind === 'journal-review')
    ) {
      await withArchivedWorkspaceOperationLock(workspaceId, async () => {
        try {
          await readWorkspaceDestructiveRecoveries(workspaceId);
          await resolveAutoDeleteJournalAttention(workspaceId, generations);
        } catch (error) {
          logMainProcessWarn(
            'Could not reconcile Auto Delete journal attention',
            error,
          );
        }
      });
    }
  }
}

export async function removeWorkspaceTarget(
  candidate: AutoArchiveCandidate,
  policy: WorkspaceTargetRemovalPolicy,
  archiveTrigger: 'auto-delete' | 'agent',
  revalidateAutoArchivePolicy?: () => Promise<CurrentAutoArchivePolicy>,
): Promise<WorkspaceTargetRemovalOutcome> {
  // Only an inactivity removal depends on the last-touched watermark. Deletion
  // start drains pending activity touches, so pinning it on an agent-armed
  // removal aborts the first attempt after nearly every turn.
  const touchedPin = revalidateAutoArchivePolicy
    ? { expectedLastTouchedAt: candidate.lastTouchedAt }
    : {};
  if (candidate.surface === 'cowork' || candidate.surface === 'app-advisor') {
    const result = await archiveWorkEntry({
      workspaceId: candidate.workspaceId,
      entryId: candidate.targetId,
      requireArchivedContainer: true,
      expectedCreatedAt: candidate.createdAt,
      lockAfterArchive: policy.mode === 'archive',
      ...touchedPin,
      revalidateAutoArchivePolicy,
    });
    return { status: 'success', warnings: result.warnings };
  }
  assertNotSplitLocked(
    candidate.workspaceId,
    candidate.targetId,
    'automatically deleting the worktree',
  );
  assertNotSplitDestinationWorktreeClaimed(
    candidate.workspaceId,
    candidate.targetId,
    'automatically deleting the worktree',
  );
  const archive =
    candidate.surface === 'single-repo'
      ? archiveSingleRepoWorktree
      : archiveMultiRepoWorktree;
  const recoveryRequest = {
    workspaceId: candidate.workspaceId,
    worktreeId: candidate.targetId,
    intent: policy.mode,
    expectedCreatedAt: candidate.createdAt,
  };
  // Never acquire the deletion/chat lifecycle while holding the archive owner.
  // Execution re-enters its own admission after this short observation phase.
  const transition = await withArchivedWorkspaceOperationLock(
    candidate.workspaceId,
    () => inspectAutoDeleteTransition(candidate, policy.mode),
  );
  if (transition.obsolete) return { status: 'obsolete' };
  const prior = transition.recovery;
  if (
    (candidate.recoveryOnly && !prior?.actions.finishArchive.eligible) ||
    (prior &&
      !prior.actions.retry.eligible &&
      !prior.actions.finishArchive.eligible)
  )
    return recordCurrentAutoDeleteAttention(candidate, policy.mode);
  const warnings: string[] = [];
  let result: Awaited<ReturnType<typeof archive>>;
  try {
    result = await withTypedArchiveRefusal(
      { ...recoveryRequest, typedRefusal: true, archiveTrigger },
      () =>
        archive({
          archiveTrigger,
          sourceAdmission: 'required',
          workspaceId: candidate.workspaceId,
          worktreeId: candidate.targetId,
          expectedCreatedAt: candidate.createdAt,
          ...touchedPin,
          ...(candidate.worktree?.branchName
            ? { expectedBranchName: candidate.worktree.branchName }
            : {}),
          deleteBranch:
            policy.branch.kind === 'force'
              ? true
              : policy.branch.kind === 'keep'
                ? false
                : candidate.deleteBranch,
          revalidateAutoArchivePolicy,
          runAutoArchiveTeardown: () =>
            withWorkspaceTargetAutoArchiveTeardown(
              candidate.workspaceId,
              candidate.targetId,
              async () => {
                const { runAutoArchiveTeardown } =
                  await import('./auto-archive-teardown');
                try {
                  await runAutoArchiveTeardown(
                    candidate.workspaceId,
                    candidate.targetId,
                    candidate.surface === 'multi-repo',
                  );
                } catch (error) {
                  const { AutoArchiveTeardownFailedError } =
                    await import('./auto-archive-teardown');
                  if (
                    policy.teardown !== 'force' ||
                    !(error instanceof AutoArchiveTeardownFailedError)
                  )
                    throw error;
                  // Continue the admitted removal without repeating a failed script.
                  warnings.push(error.message.slice(-4000));
                }
              },
            ),
          requireArchivedContainer: true,
          lockAfterArchive: policy.mode === 'archive',
          observabilityMode: 'live-service',
          liveServices: {
            cleanupLiveState: cleanupLiveWorktreeState,
            purgeObservabilityData: purgeLiveWorktreeObservabilityData,
          },
        }),
    );
  } catch (error) {
    const record = destructiveFailureRecord(error);
    if (
      record?.workspaceId !== candidate.workspaceId ||
      record.worktreeId !== candidate.targetId ||
      record.createdAt !== candidate.createdAt ||
      (record.operation !== 'worktree-archive' &&
        record.operation !== 'worktree-delete') ||
      !record.steps.some(
        (step) => step.phase === 'teardown-script' && step.state !== 'done',
      )
    )
      throw error;
    const { AutoArchiveTeardownFailedError } =
      await import('./auto-archive-teardown');
    if (!(error instanceof AutoArchiveTeardownFailedError)) throw error;
    // The script may have withdrawn its journal. Its attached failure record
    // still explains the stopping point and belongs to the same incident.
    return recordCurrentAutoDeleteAttention(candidate, policy.mode, {
      error,
      completedBefore: transition.completedBefore,
    });
  }
  if (result.refusal) {
    if (result.refusal.recovery)
      return recordCurrentAutoDeleteAttention(candidate, policy.mode);
    throw new Error(result.refusal.message);
  }
  if (!result.success) throw new Error('Worktree removal did not complete.');
  await resolveAutoDeleteAttention(
    candidate.workspaceId,
    candidate.targetId,
    candidate.createdAt,
    false,
    transition.generations,
  ).catch((error: unknown) =>
    logMainProcessWarn('Could not resolve Auto Delete attention', error),
  );
  return {
    status: 'success',
    warnings: [...warnings, ...(result.warnings ?? [])],
  };
}

export function emitAutoArchiveNotification(
  notification: AutoArchiveNotification,
): void {
  autoArchiveResultListener?.(notification);
}

const defaultDependencies: AutoArchiveDependencies = {
  listSidebarItems: async () => {
    const { items } = await readAllSidebarItems();
    return items;
  },
  reconcileAttention: reconcileAutoDeleteIncidents,
  readAttention: (workspaceIds) =>
    listAutoDeleteRecoveryCandidates(workspaceIds).catch((error: unknown) => {
      logMainProcessWarn('Could not read Auto Delete attention', error);
      return [];
    }),
  readWorkEntries: readWorkEntriesFile,
  listWorkEntryChatSummaries,
  readAppAdvisorSettings: readAppAdvisorWorkspaceSettings,
  listWatchers: () => getAppAdvisorWatcherService().list(),
  listAutomations: () => getAutomationsService().list(),
  archive: (candidate) =>
    removeWorkspaceTarget(
      candidate,
      {
        mode: 'delete',
        teardown: 'error',
        branch: { kind: 'preference' },
      },
      'auto-delete',
      () =>
        resolveCurrentAutoArchivePolicy(
          candidate,
          Date.now(),
          defaultDependencies,
        ),
    ),
  isRuntimeBusy: isAutoArchiveRuntimeBusy,
  touch: (workspaceId, targetId, now) =>
    touchWorkspaceTarget(workspaceId, targetId, now),
  onResult: (result) => {
    // Attention is replayable state, not a renderer-session event or raw toast.
    if (result.status === 'attention') return;
    autoArchiveResultListener?.({
      trigger: 'inactivity',
      workspaceId: result.candidate.workspaceId,
      workspaceName: result.candidate.workspaceName,
      targetId: result.candidate.targetId,
      targetName: result.candidate.targetName,
      surface: result.candidate.surface,
      inactivityDays: result.candidate.inactivityDays,
      status: result.status,
      ...(result.error ? { error: result.error } : {}),
      ...(result.warnings?.length ? { warnings: result.warnings } : {}),
    });
    if (result.status === 'failure') {
      // eslint-disable-next-line no-console
      console.warn('Auto Delete failed.', {
        workspaceId: result.candidate.workspaceId,
        targetId: result.candidate.targetId,
        error: result.error,
      });
    }
  },
};

export type WorkspaceTargetBusyReason =
  | 'watcher'
  | 'scheduled automation'
  | 'split operation'
  | 'background work'
  | 'agent'
  | 'workflow'
  | 'terminal'
  | 'script'
  | 'hook';

export async function workspaceTargetBusyReasons(
  candidate: AutoArchiveCandidate,
  deps: Pick<
    AutoArchiveDependencies,
    | 'listWatchers'
    | 'listAutomations'
    | 'isRuntimeBusy'
    | 'listWorkEntryChatSummaries'
  > = defaultDependencies,
  knownChatOwners?: ReadonlyMap<string, string>,
): Promise<WorkspaceTargetBusyReason[]> {
  const chatOwners = new Map(knownChatOwners);
  if (
    !knownChatOwners &&
    (candidate.surface === 'cowork' || candidate.surface === 'app-advisor')
  ) {
    for (const summary of await deps.listWorkEntryChatSummaries(
      candidate.workspaceId,
    )) {
      for (const chat of summary.chats)
        chatOwners.set(`${candidate.workspaceId}\0${chat.id}`, summary.entryId);
    }
  }
  const [watchers, automations] = await Promise.all([
    deps.listWatchers(),
    deps.listAutomations(),
  ]);
  const key = targetKey(candidate.workspaceId, candidate.targetId);
  const running = new Set(
    automations.recentRuns
      .filter((run) => run.status === 'running')
      .map((run) => run.activityId),
  );
  const reasons: WorkspaceTargetBusyReason[] = [];
  if (collectWatcherTargetKeys(watchers, chatOwners).has(key))
    reasons.push('watcher');
  if (
    collectScheduledAutomationTargetKeys(automations.activities, running).has(
      key,
    )
  )
    reasons.push('scheduled automation');
  if (
    isSplitLocked(candidate.workspaceId, candidate.targetId) ||
    isSplitDestinationWorktreeClaimed(candidate.workspaceId, candidate.targetId)
  )
    reasons.push('split operation');
  // Preserve the inactivity gate's short circuit (including its error behavior).
  if (!reasons.length) {
    if (deps.isRuntimeBusy === isAutoArchiveRuntimeBusy)
      reasons.push(...(await runtimeBusyReasons(candidate)));
    else if (await deps.isRuntimeBusy(candidate))
      reasons.push('background work');
  }
  return reasons;
}

export async function applyAutoArchive(
  now = Date.now(),
  deps: AutoArchiveDependencies = defaultDependencies,
): Promise<AutoArchiveResult[]> {
  const items = await deps.listSidebarItems();
  await deps.reconcileAttention?.(items.map((item) => item.id));
  const candidates = await collectAutoArchiveCandidates({
    ...deps,
    listSidebarItems: () => Promise.resolve(items),
  });
  const due = candidates.filter((candidate) => {
    const activityAt = candidate.lastTouchedAt ?? candidate.createdAt;
    return (
      isValidTimestamp(activityAt) &&
      Date.parse(activityAt) <= now - candidate.inactivityDays * DAY_MS
    );
  });
  if (due.length === 0) return [];

  // Work Entry summaries map chat ids to their owning entry. Candidate
  // collection intentionally stays small; hydrate this map from registry rows.
  const chatOwners = new Map<string, string>();
  const ownerErrors = new Map<string, unknown>();
  for (const workspaceId of Array.from(
    new Set(
      due
        .filter(
          (candidate) =>
            candidate.surface === 'cowork' ||
            candidate.surface === 'app-advisor',
        )
        .map((candidate) => candidate.workspaceId),
    ),
  )) {
    try {
      const summaries = await deps.listWorkEntryChatSummaries(workspaceId);
      for (const summary of summaries) {
        for (const chat of summary.chats) {
          chatOwners.set(`${workspaceId}\0${chat.id}`, summary.entryId);
        }
      }
    } catch (error) {
      ownerErrors.set(workspaceId, error);
    }
  }
  const results: AutoArchiveResult[] = [];
  for (const candidate of due) {
    const refreshBusyTarget = async (): Promise<void> => {
      try {
        await deps.touch(candidate.workspaceId, candidate.targetId, now);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn('Failed to refresh busy Auto Delete target.', {
          workspaceId: candidate.workspaceId,
          targetId: candidate.targetId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    try {
      if (
        (candidate.surface === 'cowork' ||
          candidate.surface === 'app-advisor') &&
        ownerErrors.has(candidate.workspaceId)
      ) {
        throw ownerErrors.get(candidate.workspaceId);
      }
      let busy = false;
      const outcome = await withWorkspaceTargetAutoArchiveLease(
        candidate.workspaceId,
        candidate.targetId,
        async () => {
          busy =
            (await workspaceTargetBusyReasons(candidate, deps, chatOwners))
              .length > 0;
          if (!busy) return deps.archive(candidate);
        },
      );
      if (busy) {
        await refreshBusyTarget();
        continue;
      }
      if (outcome?.status === 'obsolete') continue;
      const result: AutoArchiveResult = {
        candidate,
        status: outcome?.status ?? 'success',
        ...(outcome?.status === 'attention'
          ? { recovery: outcome.recovery }
          : {}),
        ...(outcome?.status === 'success' && outcome.warnings?.length
          ? { warnings: outcome.warnings }
          : {}),
      };
      results.push(result);
      deps.onResult(result);
    } catch (error) {
      if (
        error instanceof WorkspaceTargetAutoArchiveExcludedError ||
        error instanceof LiveDelegationsError
      ) {
        await refreshBusyTarget();
        continue;
      }
      const result: AutoArchiveResult = {
        candidate,
        status: 'failure',
        error: error instanceof Error ? error.message : String(error),
      };
      results.push(result);
      deps.onResult(result);
    }
  }
  return results;
}

export function shouldTouchAutoArchiveTargetsForTerminalEvent(
  type: WorkerTerminalEventType,
): boolean {
  return type !== 'output';
}

export function createActiveTargetActivityTracker(deps: {
  collectActiveTargetKeys: () => Set<string>;
  touch: (
    workspaceId: string,
    targetId: string,
    touchedAt: number,
  ) => Promise<void>;
  now: () => number;
}): () => void {
  let previousActiveTargetKeys = new Set<string>();
  return (): void => {
    const currentActiveTargetKeys = deps.collectActiveTargetKeys();
    const targetsToTouch = new Set(
      Array.from(previousActiveTargetKeys).concat(
        Array.from(currentActiveTargetKeys),
      ),
    );
    previousActiveTargetKeys = currentActiveTargetKeys;
    const touchedAt = deps.now();
    for (const key of Array.from(targetsToTouch)) {
      const separator = key.indexOf('\0');
      void deps
        .touch(key.slice(0, separator), key.slice(separator + 1), touchedAt)
        .catch(() => undefined);
    }
  };
}

export function collectActiveAutoArchiveTargetKeys(): Set<string> {
  const targets = new Set<string>();
  for (const session of getAllActiveSessionInfos()) {
    if (
      session.turnActive ||
      session.pendingMessageCount > 0 ||
      (session.activeBackgroundTaskCount ?? 0) > 0
    ) {
      targets.add(targetKey(session.projectId, session.worktreeId));
    }
  }
  for (const handle of getActivePipelineExecutionHandles()) {
    const state = handle.getState();
    if (state.project_id && state.worktree_id) {
      targets.add(targetKey(state.project_id, state.worktree_id));
    }
  }
  for (const target of workerTerminal.runningWorktrees()) {
    targets.add(targetKey(target.projectId, target.worktreeId));
  }
  for (const target of listTrackedShellScripts()) {
    targets.add(targetKey(target.projectId, target.worktreeId));
  }
  for (const target of listActiveHookRunTargets()) {
    targets.add(targetKey(target.projectId, target.worktreeId));
  }
  for (const entry of listDelegationActivity()) {
    const chat = parseDelegationSessionKey(entry.sessionKey);
    if (chat) targets.add(targetKey(chat.projectId, chat.worktreeId));
  }
  for (const target of listBackgroundWorkTargets()) {
    if (target.blocksClose) {
      targets.add(targetKey(target.projectId, target.worktreeId));
    }
  }
  return new Set(
    Array.from(targets).filter(
      (target) => !isWorkspaceTargetAutoArchiveTeardown(target),
    ),
  );
}

export async function touchActiveAutoArchiveTargets(
  now = Date.now(),
): Promise<void> {
  const touches: Promise<void>[] = [];
  for (const activeTargetKey of Array.from(
    collectActiveAutoArchiveTargetKeys(),
  )) {
    const separator = activeTargetKey.indexOf('\0');
    touches.push(
      touchWorkspaceTarget(
        activeTargetKey.slice(0, separator),
        activeTargetKey.slice(separator + 1),
        now,
      ).catch(() => undefined),
    );
  }
  await Promise.all(touches);
}

export function startDrainableAutoArchiveSweeps(params: {
  sweep: () => Promise<unknown>;
  intervalMs: number;
  onError: (error: unknown) => void;
}): () => Promise<void> {
  let stopped = false;
  let activeSweep: Promise<void> | null = null;
  const runSweep = (): void => {
    if (stopped || activeSweep) return;
    try {
      activeSweep = params
        .sweep()
        .then(() => undefined)
        .catch(params.onError)
        .finally(() => {
          activeSweep = null;
        });
    } catch (error) {
      params.onError(error);
    }
  };
  runSweep();
  const timer = setInterval(runSweep, params.intervalMs);
  timer.unref?.();
  return async (): Promise<void> => {
    stopped = true;
    clearInterval(timer);
    await activeSweep;
  };
}

export interface AutoArchiveSchedulerController {
  stopScheduling: () => Promise<void>;
  disposeActivitySubscriptions: () => void;
}

export function startAutoArchiveScheduler(): AutoArchiveSchedulerController {
  const touchActiveTargets = createActiveTargetActivityTracker({
    collectActiveTargetKeys: collectActiveAutoArchiveTargetKeys,
    touch: touchWorkspaceTarget,
    now: Date.now,
  });
  const unsubscribers = [
    subscribeChatSessionActivity(touchActiveTargets),
    subscribeToActiveCountChange(touchActiveTargets),
    workerTerminal.addEventListener((event) => {
      if (shouldTouchAutoArchiveTargetsForTerminalEvent(event.type)) {
        touchActiveTargets();
      }
    }),
    subscribeTrackedScriptsChanged(touchActiveTargets),
    subscribeActiveHookRunsChanged(touchActiveTargets),
    subscribeDelegationActivity(touchActiveTargets),
    subscribeBackgroundWork(touchActiveTargets),
  ];
  touchActiveTargets();
  const stopSweeps = startDrainableAutoArchiveSweeps({
    sweep: applyAutoArchive,
    intervalMs: AUTO_ARCHIVE_SWEEP_INTERVAL_MS,
    onError: (error: unknown): void => {
      // eslint-disable-next-line no-console
      console.warn('Failed to apply Auto Delete.', error);
    },
  });
  return {
    stopScheduling: stopSweeps,
    disposeActivitySubscriptions: (): void => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    },
  };
}
