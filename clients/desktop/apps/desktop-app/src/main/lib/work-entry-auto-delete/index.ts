import {
  DEFAULT_WORK_ENTRY_AUTO_DELETE_TEARDOWN,
  DEFAULT_WORK_ENTRY_AUTO_DELETE_UNMERGED_BRANCH,
  WORK_ENTRY_AUTO_DELETE_SETTLE_MS,
  formatWorkEntryAutoDeleteWaitingFor,
  type WorkEntryAutoDeleteArm,
  type WorkEntryAutoDeleteTeardown,
  type WorkEntryAutoDeleteUnmergedBranch,
  type WorkEntryAutoDeleteWorkspaceSnapshot,
  type WorkEntryAutoDeleteRowState,
  type WorkEntryAutoDeleteDisarmRequest,
  type WorkEntryAutoDeleteResolveBranchRequest,
} from '@canopy/protocol/work-entry-auto-delete';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  IPC_CHANNELS,
} from '@canopy/desktop-shared/types';
import { subscribeChatSessionActivity } from '../../agents/session-manager';
import {
  LiveDelegationsError,
  subscribeDelegationActivity,
} from '../../agents/delegation/activity';
import { subscribeBackgroundWork } from '../../agents/background-work';
import { subscribeToActiveCountChange } from '../../pipelines/pipeline-execution-registry';
import { workerTerminal } from '../../terminal/worker-terminal';
import { getAutomationsService } from '../../automations/service';
import {
  isSplitLocked,
  isSplitDestinationWorktreeClaimed,
} from '../../services/split-lock-service';
import { getChatStateService } from '../../services/chat-state-service';
import { getResumeQueue } from '../../services/resume-queue-host';
import { loadExecutionState } from '@canopy/execution-engine/node/pipelines/executor';
import { createElectronExecutionRuntime } from '../../pipelines/execution-runtime';
import { getAppAdvisorWatcherService } from '../../app-advisor/watchers';
import { readAllSidebarItems } from '../sidebar-items';
import { readWorkEntriesFile } from '../cowork-work-entries-file';
import { readWorkspaceConfig } from '../workspace-persistence';
import { readPreferencesFile } from '../preferences-store';
import { readLocalBranchMergeState, getCurrentBranch } from '../git';
import { resolveWorkspaceReferenceRepoPath } from '../workspace-reference-repo';
import {
  getWorkspaceWorktreeRepoDir,
  getWorkspaceWorktreeRootRepoDir,
} from '../paths';
import { validateId } from '../validation';
import { sendToAllWindows } from '../window-send';
import { subscribeTrackedScriptsChanged } from '../script-runner';
import { subscribeActiveHookRunsChanged } from '../hook-runner';
import { logMainProcessWarn } from '../main-process-logging';
import {
  collectActiveAutoArchiveTargetKeys,
  collectScheduledAutomationTargetKeys,
  workspaceTargetBusyReasons,
  removeWorkspaceTarget,
  emitAutoArchiveNotification,
  shouldTouchAutoArchiveTargetsForTerminalEvent,
  type AutoArchiveCandidate,
  type WorkspaceTargetRemovalPolicy,
} from '../auto-archive';
import {
  withWorkspaceTargetAutoArchiveLease,
  WorkspaceTargetAutoArchiveExcludedError,
  isWorkspaceTargetRemovalPending,
} from '../workspace-target-exclusion';
import { readArms, writeArms, withArmWriter } from './store';
import { subscribeAutoDeleteActivity } from './activity';
import { readDestructiveRecovery } from '../w5-destructive-recovery';

export interface ArmWorkEntryAutoDeleteInput {
  workspaceId: string;
  targetId: string;
  chatId: string;
  enabled: boolean;
  archive?: boolean;
  teardown?: WorkEntryAutoDeleteTeardown;
  unmergedLocalBranchDelete?: WorkEntryAutoDeleteUnmergedBranch;
}
export interface WorkEntryAutoDeleteToolResult {
  ok: boolean;
  message: string;
}

const idleSince = new Map<string, number>();
const armedKeys = new Set<string>();
/** Targets whose removal is in progress; projected, never persisted. */
const removingKeys = new Set<string>();
let requestEvaluation: (() => void) | undefined;
const keyOf = (workspaceId: string, targetId: string): string =>
  `${workspaceId}\0${targetId}`;
const describe = (candidate: AutoArchiveCandidate): string =>
  `${candidate.worktree ? 'worktree' : 'work entry'} “${candidate.targetName}”`;

function validateTarget(request: WorkEntryAutoDeleteDisarmRequest): void {
  validateId(request.workspaceId, 'workspaceId');
  validateId(request.targetId, 'targetId');
}

async function candidateFor(
  workspaceId: string,
  targetId: string,
): Promise<AutoArchiveCandidate | undefined> {
  const item = (await readAllSidebarItems()).items.find(
    (item) => item.id === workspaceId,
  );
  if (workspaceId === APP_ADVISOR_PROJECT_ID || item?.type === 'cowork') {
    const entry = (await readWorkEntriesFile(workspaceId)).entries.find(
      (entry) => entry.id === targetId,
    );
    if (!entry) return undefined;
    return {
      surface:
        workspaceId === APP_ADVISOR_PROJECT_ID ? 'app-advisor' : 'cowork',
      workspaceId,
      workspaceName: item?.name ?? 'Orchestrator',
      targetId,
      targetName: entry.title?.trim() || entry.summary?.title || entry.id,
      createdAt: entry.createdAt,
      lastTouchedAt: entry.lastTouchedAt,
      inactivityDays: 0,
    };
  }
  if (!item) return undefined;
  const worktree = item.worktrees.find((row) => row.id === targetId);
  if (!worktree) return undefined;
  return {
    surface: item.type,
    workspaceId,
    workspaceName: item.name,
    targetId,
    targetName: worktree.label?.trim() || worktree.branchName,
    createdAt: worktree.createdAt,
    lastTouchedAt: worktree.lastTouchedAt,
    inactivityDays: 0,
    worktree,
  };
}

async function unavailableReason(
  candidate: AutoArchiveCandidate,
): Promise<string | undefined> {
  const { workspaceId, targetId, worktree } = candidate;
  if (isWorkspaceTargetRemovalPending(workspaceId, targetId))
    return 'the worktree is being removed';
  if (worktree && (await readDestructiveRecovery(workspaceId, targetId)))
    return 'the worktree has an unfinished removal or recovery operation';
  if (
    worktree?.healthIssue ||
    worktree?.splitRecoveryRequired ||
    worktree?.setupPhase === 'git-pending'
  )
    return 'the worktree needs repair or is still being prepared';
  if (
    isSplitLocked(workspaceId, targetId) ||
    isSplitDestinationWorktreeClaimed(workspaceId, targetId)
  )
    return 'the worktree is locked or claimed by a split operation';
  return undefined;
}

async function recurringAutomation(
  candidate: AutoArchiveCandidate,
): Promise<string | undefined> {
  const { activities } = await getAutomationsService().list();
  const activity = activities.find(
    (activity) =>
      activity.enabled &&
      activity.schedule.kind === 'cron' &&
      collectScheduledAutomationTargetKeys([activity], new Set()).has(
        keyOf(candidate.workspaceId, candidate.targetId),
      ),
  );
  return activity
    ? `the scheduled automation “${activity.name}” runs repeatedly in this ${candidate.worktree ? 'worktree' : 'work entry'}, so it would never be idle. Remove or retarget the automation first`
    : undefined;
}

function sameIdentity(
  candidate: AutoArchiveCandidate,
  arm: WorkEntryAutoDeleteArm,
): boolean {
  return (
    candidate.createdAt === arm.identity.createdAt &&
    candidate.worktree?.branchName === arm.identity.branchName &&
    Boolean(candidate.worktree) === (arm.targetKind === 'worktree')
  );
}

async function waitingFor(
  candidate: AutoArchiveCandidate,
): Promise<string | undefined> {
  const counts: Record<string, number> = {};
  for (const reason of await workspaceTargetBusyReasons(candidate))
    counts[reason] = (counts[reason] ?? 0) + 1;
  const resumes = await pendingResumes(candidate);
  if (resumes) counts['interrupted turn'] = resumes;
  return formatWorkEntryAutoDeleteWaitingFor(counts);
}

/**
 * Interrupted chat turns and paused pipeline runs queued to resume keep their
 * target; removal would delete the state they resume from. Unreadable state
 * counts as busy.
 */
async function pendingResumes(
  candidate: AutoArchiveCandidate,
): Promise<number> {
  try {
    const queue = getResumeQueue();
    await queue.initialize();
    let count = 0;
    for (const entry of queue.snapshot().entries) {
      if (entry.status !== 'waiting' && entry.status !== 'resuming') continue;
      const target = entry.target;
      if (target.kind === 'chat') {
        if (
          target.projectId === candidate.workspaceId &&
          target.worktreeId === candidate.targetId
        )
          count += 1;
        continue;
      }
      const state = await loadExecutionState(
        target.executionId,
        createElectronExecutionRuntime().executionsDir,
      );
      // A missing state is reconciled as skipped by the queue; only a read
      // error (caught below) is unknown and keeps every target.
      if (
        state?.project_id === candidate.workspaceId &&
        state.worktree_id === candidate.targetId
      )
        count += 1;
    }
    return count;
  } catch {
    return 1;
  }
}

async function snapshot(
  workspaceId: string,
): Promise<WorkEntryAutoDeleteWorkspaceSnapshot> {
  const targets: Record<string, WorkEntryAutoDeleteRowState> = {};
  const arms = await readArms(workspaceId);
  const retained: WorkEntryAutoDeleteArm[] = [];
  for (const arm of arms) {
    const candidate = await candidateFor(workspaceId, arm.targetId);
    const key = keyOf(workspaceId, arm.targetId);
    if (!candidate || !sameIdentity(candidate, arm)) {
      armedKeys.delete(key);
      idleSince.delete(key);
      continue;
    }
    retained.push(arm);
    armedKeys.add(key);
    const state = await getChatStateService().getCompatibilityTabs(
      { projectId: workspaceId, worktreeId: arm.targetId },
      { chatIds: [] },
    );
    const title = state.tabs.find(
      (tab) => tab.id === arm.armedBy.chatId,
    )?.title;
    targets[arm.targetId] = {
      mode: arm.mode,
      state: arm.state,
      ...(title ? { armedByChatTitle: title } : {}),
      waitingFor: await waitingFor(candidate),
      ...(arm.unmergedBranches
        ? { unmergedBranches: arm.unmergedBranches }
        : {}),
      ...(removingKeys.has(key) ? { removing: true } : {}),
    };
  }
  if (retained.length !== arms.length) await writeArms(workspaceId, retained);
  return { workspaceId, targets };
}

async function broadcast(workspaceId: string): Promise<void> {
  sendToAllWindows(
    IPC_CHANNELS.workEntryAutoDeleteChanged,
    await snapshot(workspaceId),
  );
}

async function replaceArm(
  workspaceId: string,
  arm: WorkEntryAutoDeleteArm | undefined,
  targetId: string,
): Promise<void> {
  const arms = (await readArms(workspaceId)).filter(
    (row) => row.targetId !== targetId,
  );
  if (arm) arms.push(arm);
  await writeArms(workspaceId, arms);
  const key = keyOf(workspaceId, targetId);
  idleSince.delete(key);
  if (arm) armedKeys.add(key);
  else armedKeys.delete(key);
  await broadcast(workspaceId);
}

async function report(
  workspaceId: string,
  arm: WorkEntryAutoDeleteArm,
  text: string,
): Promise<void> {
  try {
    const state = await getChatStateService().getCompatibilityTabs(
      { projectId: workspaceId, worktreeId: arm.targetId },
      { chatIds: [] },
    );
    if (
      !state.tabs.some((tab) => tab.id === arm.armedBy.chatId && !tab.readOnly)
    )
      return;
    await getAppAdvisorWatcherService().deliverSystemMessage(
      {
        projectId: workspaceId,
        worktreeId: arm.targetId,
        chatId: arm.armedBy.chatId,
      },
      text,
    );
  } catch (error) {
    logMainProcessWarn('Auto-delete report could not be delivered', error);
  }
}

export async function setWorkEntryAutoDeleteFromAgent(
  input: ArmWorkEntryAutoDeleteInput,
): Promise<WorkEntryAutoDeleteToolResult> {
  return withArmWriter(async () => {
    validateTarget(input);
    validateId(input.chatId, 'chatId');
    const refuse = (reason: string): WorkEntryAutoDeleteToolResult => ({
      ok: false,
      message: `Auto-delete was not armed: ${reason}.`,
    });
    if (
      !input.enabled &&
      (input.archive !== undefined ||
        input.teardown !== undefined ||
        input.unmergedLocalBranchDelete !== undefined)
    )
      return refuse('enabled: false cannot be combined with other options');
    if (
      input.workspaceId === APP_ADVISOR_PROJECT_ID &&
      input.targetId === APP_ADVISOR_WORKTREE_ID
    )
      return refuse('the legacy Orchestrator global slot cannot be removed');
    if (isWorkspaceTargetRemovalPending(input.workspaceId, input.targetId))
      return refuse('the worktree is being removed');
    const candidate = await candidateFor(input.workspaceId, input.targetId);
    if (!candidate) return refuse('the work entry no longer exists');
    if (!input.enabled) {
      await replaceArm(input.workspaceId, undefined, input.targetId);
      return {
        ok: true,
        message: `Auto-delete is off for ${describe(candidate)}.`,
      };
    }
    if (
      !candidate.worktree &&
      (input.teardown !== undefined ||
        input.unmergedLocalBranchDelete !== undefined)
    )
      return refuse(
        'teardown and unmergedLocalBranchDelete are worktree-only options and cannot be used on a work entry',
      );
    const unavailable =
      (await unavailableReason(candidate)) ??
      (await recurringAutomation(candidate));
    if (unavailable) return refuse(unavailable);
    const previous = (await readArms(input.workspaceId)).find(
      (arm) => arm.targetId === input.targetId,
    );
    const arm: WorkEntryAutoDeleteArm = {
      targetId: input.targetId,
      targetKind: candidate.worktree ? 'worktree' : 'work-entry',
      mode: input.archive ? 'archive' : 'delete',
      teardown: input.teardown ?? DEFAULT_WORK_ENTRY_AUTO_DELETE_TEARDOWN,
      unmergedLocalBranchDelete:
        input.unmergedLocalBranchDelete ??
        DEFAULT_WORK_ENTRY_AUTO_DELETE_UNMERGED_BRANCH,
      state: 'armed',
      armedAt: new Date().toISOString(),
      armedBy: { chatId: input.chatId },
      identity: {
        createdAt: candidate.createdAt,
        ...(candidate.worktree
          ? { branchName: candidate.worktree.branchName }
          : {}),
      },
    };
    await replaceArm(input.workspaceId, arm, input.targetId);
    const waiting = await waitingFor(candidate);
    const state = previous
      ? await getChatStateService().getCompatibilityTabs(
          { projectId: input.workspaceId, worktreeId: input.targetId },
          { chatIds: [] },
        )
      : undefined;
    const previousTitle =
      state?.tabs.find((tab) => tab.id === previous?.armedBy.chatId)?.title ??
      previous?.armedBy.chatId;
    const noEffect =
      candidate.worktree &&
      input.unmergedLocalBranchDelete !== undefined &&
      !(await readPreferencesFile()).deleteBranchOnArchive;
    requestEvaluation?.();
    return {
      ok: true,
      message: `Auto-${arm.mode === 'archive' ? 'archive' : 'delete'} is armed for ${describe(candidate)}. It will ${arm.mode} when no agents, workflows, or background work are active for 15 seconds.${waiting ? ` Waiting for: ${waiting}.` : ''}${previous ? ` Replaced the ${previous.mode} arm from chat “${previousTitle}”.` : ''}${noEffect ? ' unmergedLocalBranchDelete has no effect because Delete fully merged branches on archive is off; local branches will be kept.' : ''}`,
    };
  });
}

export async function listWorkEntryAutoDeleteSnapshots(): Promise<
  WorkEntryAutoDeleteWorkspaceSnapshot[]
> {
  return withArmWriter(async () => {
    const ids = new Set(
      (await readAllSidebarItems()).items.map((item) => item.id),
    );
    ids.add(APP_ADVISOR_PROJECT_ID);
    return Promise.all([...ids].map(snapshot));
  });
}

/** False when no arm was left to remove, such as after a removal finished. */
export async function disarmWorkEntryAutoDeleteByUser(
  request: WorkEntryAutoDeleteDisarmRequest,
): Promise<boolean> {
  return withArmWriter(async () => {
    validateTarget(request);
    const arm = (await readArms(request.workspaceId)).find(
      (arm) => arm.targetId === request.targetId,
    );
    if (!arm) return false;
    const candidate = await candidateFor(request.workspaceId, request.targetId);
    await replaceArm(request.workspaceId, undefined, request.targetId);
    await report(
      request.workspaceId,
      arm,
      `The user turned off auto-delete for ${candidate ? describe(candidate) : `work entry “${request.targetId}”`}.`,
    );
    return true;
  });
}

export async function resolveWorkEntryAutoDeleteBranch(
  request: WorkEntryAutoDeleteResolveBranchRequest,
): Promise<void> {
  validateTarget(request);
  if (request.answer === 'disarm') {
    await disarmWorkEntryAutoDeleteByUser(request);
    return;
  }
  if (request.answer !== 'delete-branch' && request.answer !== 'keep-branch')
    throw new Error('Invalid branch answer');
  const answer = request.answer;
  await withArmWriter(async () => {
    const arm = (await readArms(request.workspaceId)).find(
      (arm) => arm.targetId === request.targetId,
    );
    if (!arm || arm.state !== 'awaiting-branch-confirmation') return;
    await replaceArm(
      request.workspaceId,
      {
        ...arm,
        state: 'armed',
        branchAnswer: answer,
        unmergedBranches: undefined,
      },
      request.targetId,
    );
    requestEvaluation?.();
  });
}

async function branchPolicy(
  candidate: AutoArchiveCandidate,
  arm: WorkEntryAutoDeleteArm,
): Promise<WorkspaceTargetRemovalPolicy['branch'] | string[]> {
  if (
    !candidate.worktree ||
    !(await readPreferencesFile()).deleteBranchOnArchive
  )
    return { kind: 'keep' };
  if (arm.branchAnswer === 'keep-branch') return { kind: 'keep' };
  const config = await readWorkspaceConfig(candidate.workspaceId);
  const repositories: Array<{ path: string; branch: string }> = [];
  if (candidate.surface === 'single-repo') {
    if (!config.repoPath)
      throw new Error('The main checkout is unavailable for branch preflight');
    repositories.push({
      path: await resolveWorkspaceReferenceRepoPath(config.repoPath),
      branch: candidate.worktree.branchName,
    });
  } else {
    for (const repo of config.repos) {
      if (
        candidate.worktree.includedRepoIds &&
        !candidate.worktree.includedRepoIds.includes(repo.id)
      )
        continue;
      const branch = await getCurrentBranch(
        getWorkspaceWorktreeRepoDir(
          candidate.workspaceId,
          candidate.targetId,
          repo.id,
        ),
      );
      if (branch)
        repositories.push({
          path: await resolveWorkspaceReferenceRepoPath(repo.repoPath),
          branch,
        });
    }
    if (config.sourceRepoPath) {
      const branch = await getCurrentBranch(
        getWorkspaceWorktreeRootRepoDir(
          candidate.workspaceId,
          candidate.targetId,
        ),
      );
      if (branch)
        repositories.push({
          path: await resolveWorkspaceReferenceRepoPath(config.sourceRepoPath),
          branch,
        });
    }
  }
  const unmerged: string[] = [];
  for (const repo of repositories) {
    const state = await readLocalBranchMergeState(repo.path, repo.branch);
    if (state.exists && !state.merged) unmerged.push(repo.branch);
  }
  if (!unmerged.length) return { kind: 'preference' };
  if (
    arm.branchAnswer === 'delete-branch' ||
    arm.unmergedLocalBranchDelete === 'force'
  )
    return { kind: 'force' };
  if (arm.unmergedLocalBranchDelete === 'error')
    throw new Error(
      `branch ${unmerged.map((name) => `“${name}”`).join(', ')} is not fully merged and unmergedLocalBranchDelete is error`,
    );
  return [...new Set(unmerged)];
}

async function evaluate(
  workspaceId: string,
  arm: WorkEntryAutoDeleteArm,
): Promise<void> {
  const key = keyOf(workspaceId, arm.targetId);
  let candidate: AutoArchiveCandidate | undefined;
  let removalStarted = false;
  try {
    candidate = await candidateFor(workspaceId, arm.targetId);
    if (!candidate || !sameIdentity(candidate, arm)) {
      await replaceArm(workspaceId, undefined, arm.targetId);
      return;
    }
    const recurring = await recurringAutomation(candidate);
    if (recurring) throw new Error(recurring);
    if (arm.state !== 'armed') return;
    if ((await unavailableReason(candidate)) || (await waitingFor(candidate))) {
      idleSince.delete(key);
      return;
    }
    const since = idleSince.get(key);
    if (since === undefined) {
      idleSince.set(key, Date.now());
      return;
    }
    if (Date.now() - since < WORK_ENTRY_AUTO_DELETE_SETTLE_MS) return;
    await withWorkspaceTargetAutoArchiveLease(
      workspaceId,
      arm.targetId,
      async () => {
        const current = await candidateFor(workspaceId, arm.targetId);
        if (!current || !sameIdentity(current, arm))
          throw new WorkspaceTargetAutoArchiveExcludedError(
            'The target identity changed',
          );
        const recurring = await recurringAutomation(current);
        if (recurring) throw new Error(recurring);
        if ((await unavailableReason(current)) || (await waitingFor(current))) {
          idleSince.delete(key);
          return;
        }
        const branch = await branchPolicy(current, arm);
        if (Array.isArray(branch)) {
          await replaceArm(
            workspaceId,
            {
              ...arm,
              state: 'awaiting-branch-confirmation',
              unmergedBranches: branch,
            },
            arm.targetId,
          );
          return;
        }
        // Git reads can await long enough for a new activity admission.
        if (idleSince.get(key) !== since || (await waitingFor(current))) {
          idleSince.delete(key);
          return;
        }
        removalStarted = true;
        // The row leaves the sidebar early in removal; let a host showing
        // the item navigate away now instead of at completion.
        removingKeys.add(key);
        let result: Awaited<ReturnType<typeof removeWorkspaceTarget>>;
        try {
          await broadcast(workspaceId);
          result = await removeWorkspaceTarget(
            current,
            {
              mode: arm.mode,
              teardown: arm.teardown,
              branch,
            },
            'agent',
          );
        } finally {
          removingKeys.delete(key);
        }
        await replaceArm(workspaceId, undefined, arm.targetId);
        emitAutoArchiveNotification({
          ...notificationCandidate(current),
          trigger: 'agent',
          mode: arm.mode,
          status: 'success',
          warnings: result.warnings,
        });
      },
    );
  } catch (error) {
    idleSince.delete(key);
    if (
      error instanceof WorkspaceTargetAutoArchiveExcludedError ||
      error instanceof LiveDelegationsError
    ) {
      // Transient: restart the settle window so the retry comes in seconds,
      // not at the next minute tick.
      idleSince.set(key, Date.now());
      return;
    }
    await replaceArm(workspaceId, undefined, arm.targetId);
    const detail = (
      error instanceof Error ? error.message : String(error)
    ).slice(-4000);
    const teardownFailed =
      error instanceof Error && error.name === 'AutoArchiveTeardownFailedError';
    const recovery =
      removalStarted && !teardownFailed
        ? 'Removal did not complete. Inspect the worktree and its recovery state before retrying.'
        : 'Nothing was changed.';
    const text = `Auto-delete for ${candidate ? describe(candidate) : `work entry “${arm.targetId}”`} did not run: ${detail}. ${recovery} Auto-delete is now off. Fix the problem and call SetWorkEntryAutoDelete again${teardownFailed && arm.teardown === 'error' ? ', or use teardown: "force" to continue without a failing teardown script' : ''}.`;
    await report(workspaceId, arm, text);
    if (candidate)
      emitAutoArchiveNotification({
        ...notificationCandidate(candidate),
        trigger: 'agent',
        mode: arm.mode,
        status: 'failure',
        error: text,
      });
  }
}

function notificationCandidate(
  candidate: AutoArchiveCandidate,
): Pick<
  AutoArchiveCandidate,
  | 'workspaceId'
  | 'workspaceName'
  | 'targetId'
  | 'targetName'
  | 'surface'
  | 'inactivityDays'
> {
  const {
    workspaceId,
    workspaceName,
    targetId,
    targetName,
    surface,
    inactivityDays,
  } = candidate;
  return {
    workspaceId,
    workspaceName,
    targetId,
    targetName,
    surface,
    inactivityDays,
  };
}

export function startWorkEntryAutoDeleteScheduler(): {
  stop: () => Promise<void>;
} {
  let stopped = false;
  let pending = false;
  let loaded = false;
  let running: Promise<void> | undefined;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let previousActive = new Set<string>();
  const run = (): void => {
    if (stopped) return;
    pending = true;
    if (running) return;
    running = withArmWriter(async () => {
      while (pending && !stopped) {
        pending = false;
        if (!loaded) {
          loaded = true;
          const ids = new Set(
            (await readAllSidebarItems()).items.map((item) => item.id),
          );
          ids.add(APP_ADVISOR_PROJECT_ID);
          for (const id of ids)
            for (const arm of await readArms(id))
              armedKeys.add(keyOf(id, arm.targetId));
        }
        for (const key of [...armedKeys]) {
          const [workspaceId, targetId] = key.split('\0');
          if (!workspaceId || !targetId) continue;
          const arm = (await readArms(workspaceId)).find(
            (arm) => arm.targetId === targetId,
          );
          if (arm) await evaluate(workspaceId, arm);
          else armedKeys.delete(key);
        }
        for (const workspaceId of new Set(
          [...armedKeys].map((key) => key.split('\0')[0]),
        )) {
          if (workspaceId) await broadcast(workspaceId);
        }
      }
    })
      .catch((error: unknown) =>
        logMainProcessWarn('Auto-delete evaluation failed', error),
      )
      .finally(() => {
        running = undefined;
        if (stopped) return;
        if (settleTimer) clearTimeout(settleTimer);
        const remaining = [...idleSince.values()].map((since) =>
          Math.max(1, WORK_ENTRY_AUTO_DELETE_SETTLE_MS - (Date.now() - since)),
        );
        if (remaining.length) {
          settleTimer = setTimeout(run, Math.min(...remaining));
          settleTimer.unref?.();
        }
      });
  };
  const activity = (): void => {
    // Session and terminal events are frequent; with nothing armed there is no
    // idle window to reset, so skip the active-target scan entirely.
    if (!armedKeys.size) {
      previousActive = new Set();
      return;
    }
    const active = collectActiveAutoArchiveTargetKeys();
    for (const key of new Set([...active, ...previousActive]))
      if (armedKeys.has(key)) idleSince.delete(key);
    previousActive = active;
    if (armedKeys.size) run();
  };
  const unsubscribers = [
    subscribeAutoDeleteActivity((keys) => {
      let affected = false;
      for (const key of keys)
        if (armedKeys.has(key)) {
          idleSince.delete(key);
          affected = true;
        }
      if (affected) run();
    }),
    subscribeChatSessionActivity(activity),
    subscribeToActiveCountChange(activity),
    workerTerminal.addEventListener((event) => {
      if (shouldTouchAutoArchiveTargetsForTerminalEvent(event.type)) activity();
    }),
    subscribeTrackedScriptsChanged(activity),
    subscribeActiveHookRunsChanged(activity),
    subscribeDelegationActivity(activity),
    subscribeBackgroundWork(activity),
  ];
  requestEvaluation = run;
  const tick = setInterval(run, 60_000);
  tick.unref?.();
  run();
  return {
    stop: async () => {
      stopped = true;
      if (requestEvaluation === run) requestEvaluation = undefined;
      clearInterval(tick);
      if (settleTimer) clearTimeout(settleTimer);
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      await running;
      idleSince.clear();
    },
  };
}
