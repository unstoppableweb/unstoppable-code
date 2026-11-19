import { resolveClientAppError } from '@canopy/desktop-instrumentation/client';
import { extractIpcErrorMessage } from '@/lib/errors';
import { toAppError } from '@canopy/protocol/app-errors';
import { inlineFailure } from '@/lib/inline-app-error';
import type { ComposerWorkDrawerSections } from '@canopy/ui-app';
import {
  useCallback,
  useEffect,
  useMemo,
  type JSX,
  type ReactNode,
} from 'react';
import { useShallow } from 'zustand/shallow';
import {
  BackgroundTray,
  backgroundTrayCounts,
  githubBackgroundTrayRun,
  githubPullRequestBackgroundTrayRun,
  pipelineBackgroundTrayRun,
  pipelineTrayRunStatus,
  type BackgroundTrayAgent,
  type BackgroundTrayCounts,
  type BackgroundTrayRun,
  type BackgroundTrayRunStatus,
  type BackgroundTrayWatcher,
} from '@canopy/ui-app';
import type {
  AppAdvisorWatcherSummary,
  BackgroundProcess,
  GitHubPullRequestWatchProgress,
  GitHubWorkflowRunArtifactReceiptV1,
  PipelineRunArtifactReceiptV1,
} from '@canopy/desktop-shared/types';
import type { ExecutionState } from '@canopy/execution-engine/types/pipeline';
import type { PipelineRunRowState } from '@/lib/pipelineRunRowState';
import { useActivityStore } from '@/stores/activityStore';
import {
  retainAppAdvisorWatchersBridge,
  useAppAdvisorWatchersStore,
} from '@/stores/appAdvisorWatchersStore';
import {
  chatDelegationKey,
  useDelegationActivityStore,
} from '@/stores/delegationActivityStore';
import {
  chatBackgroundRunKey,
  chatBackgroundWorkKey,
  dismissChatBackgroundRun,
  markChatBackgroundRunsSeenLive,
  publishChatBackgroundPullRequests,
  publishChatBackgroundRuns,
  useChatBackgroundWorkStore,
  type ChatBackgroundPullRequest,
  type ChatBackgroundRunReceipt,
} from '@/stores/chatBackgroundWorkStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { usePipelineExecutionSummaryInterest } from '@/stores/pipelineDetailCoordinator';
import { gitActionFailureRaiser, useGitHubStore } from '@/stores/githubStore';
import { openPipelineExecutionFromUi } from '@/lib/panels/open-pipeline-execution';
import { detectChatStoreSurface } from '@/stores/chat/surface';
import { backgroundProcessToTask } from '@/lib/background-tasks';
import { WatcherManagementButton } from '@/components/watchers/WatcherManagementButton';
import {
  watchersForPipelineExecution,
  watchersForSubscriberDestination,
} from '@/components/watchers/watcherFilters';
import {
  triggerTitle,
  watcherTargetDisplay,
  watcherOwnerDelegateDisplay,
  localWatcherProgressLabel,
} from '@/components/watchers/watcherDisplay';
import { useBackgroundTaskActions } from '../activity/useBackgroundTaskActions';
import { reportBackgroundProcessSelection } from '@/lib/current-ui-state/backgroundProcessesUiState';
import { useSubagentEntryActionsValue } from '@/components/subagents/subagent-entry-actions';
import { useScopeCapabilities } from '@/hooks/useScopeCapabilities';
import {
  isFollowingWatcher,
  refreshGitHubWorkflowRunReceipt,
} from './agent-artifact-projection';
import { openAgentArtifactNavigation } from './agent-artifact-navigation';
import {
  requestManagedDelegationStop,
  requestManagedDelegationStopAll,
} from './managed-delegation-stop';

const EMPTY_PROCESSES: readonly BackgroundProcess[] = [];
const EMPTY_AGENTS: readonly BackgroundTrayAgent[] = [];
const EMPTY_RUNS: Readonly<Record<string, ChatBackgroundRunReceipt>> = {};
const EMPTY_PULL_REQUESTS: Readonly<Record<string, ChatBackgroundPullRequest>> =
  {};
/** Run rows the tray asked for, so a re-render doesn't ask again. */
const requestedExecutionRows = new Set<string>();

export interface ChatBackgroundTrayProps {
  readonly target: {
    readonly projectId: string;
    readonly worktreeId: string;
    readonly chatId: string;
  };
  /**
   * Draws the tray as the Background tab of the composer work drawer
   * (Compact queue Labs): the host receives the list and its counts, and
   * places them in `ComposerWorkDrawer`.
   */
  readonly children?: (
    tray: ReactNode,
    counts: BackgroundTrayCounts,
    sections: ComposerWorkDrawerSections,
  ) => ReactNode;
}

/**
 * A run's tray state from its live execution state, or `null` before that
 * state loads: a receipt says only how the run started, and trusting it
 * would list a run that finished long ago as live.
 */
export function trayRunStatus(
  state: Pick<ExecutionState, 'status' | 'pending_pauses'> | undefined,
): BackgroundTrayRunStatus | null {
  return state === undefined
    ? null
    : pipelineTrayRunStatus(state.status, state.pending_pauses);
}

function showPipelineError(message: string): void {
  useGitHubStore
    .getState()
    .addToast(message, 'error', undefined, { category: 'Pipeline' });
}

function openOnGitHub(
  url: string,
  target: ChatBackgroundTrayProps['target'],
): void {
  // A git action that starts while the link opens owns the banner.
  const raiseFailure = gitActionFailureRaiser(
    target.projectId,
    target.worktreeId,
  );
  void window.api.browser.openLink({ url }).catch((error: unknown): void => {
    const appError = toAppError(resolveClientAppError(error));
    if (appError)
      raiseFailure(inlineFailure(appError, "Couldn't open GitHub."));
  });
}

/** A watched pull request: its last snapshot and the watcher following it. */
interface WatchedPullRequest {
  readonly watcherId: string;
  /** Whether an active watcher still follows it. */
  readonly active: boolean;
  readonly pr: GitHubPullRequestWatchProgress;
}

/**
 * The pull requests the chat's watchers follow, by row key, the newest
 * observation kept. A pull request has no receipt: its row comes straight
 * from its watchers (desktop only, D1b), and a fired watcher keeps its final
 * state in the fire history.
 */
function watchedPullRequests(
  summaries: readonly AppAdvisorWatcherSummary[],
  target: ChatBackgroundTrayProps['target'],
): ReadonlyMap<string, WatchedPullRequest> {
  const rows = new Map<string, WatchedPullRequest>();
  for (const watcher of summaries) {
    // Fired watchers count too: the visible-watcher filters drop them.
    if (
      watcher.trigger !== 'github_pull_requests_changed' ||
      watcher.destination.projectId !== target.projectId ||
      watcher.destination.worktreeId !== target.worktreeId ||
      watcher.destination.chatId !== target.chatId
    )
      continue;
    const active = isFollowingWatcher(watcher);
    for (const pr of watcher.githubPullRequestProgress?.pullRequests ?? []) {
      const key = `github-pr:${pr.repository}#${pr.number}`;
      const held = rows.get(key);
      const newer =
        held === undefined ||
        held.pr.observedAt.localeCompare(pr.observedAt) < 0;
      rows.set(key, {
        ...(newer ? { watcherId: watcher.id, pr } : held),
        active: active || (held?.active ?? false),
      });
    }
  }
  return rows;
}

function isLiveStatus(status: BackgroundTrayRunStatus): boolean {
  return (
    status === 'running' || status === 'needs-input' || status === 'paused'
  );
}

/**
 * The desktop's composer background drawer (turn-state phases 39a and 39b,
 * background drawer Phases 04 and 05): the chat's background processes from
 * the activity store, as portable tasks with the Agent activity cards'
 * actions (Stop, output, detail, workflow progress); its live subagents as
 * its transcript publishes them; and the live runs it follows, pipeline and
 * GitHub, as its transcript places them, with their state from the run
 * store and the watcher summaries.
 */
export function ChatBackgroundTray({
  target,
  children,
}: ChatBackgroundTrayProps): JSX.Element | null {
  const { projectId, worktreeId, chatId } = target;
  const chatKey = chatBackgroundWorkKey(projectId, worktreeId, chatId);
  const processes = useActivityStore(
    useShallow((state): readonly BackgroundProcess[] => {
      const all = state.bgProcesses[`${projectId}/${worktreeId}`];
      return all === undefined
        ? EMPTY_PROCESSES
        : all.filter((process) => process.chatId === chatId);
    }),
  );
  // Published by the chat's transcript (`ChatMessageList`), with each
  // logged delegate's steps and live status from its own transcript.
  const publishedAgents = useChatBackgroundWorkStore(
    (state) => state.agentsByChat[chatKey] ?? EMPTY_AGENTS,
  );
  const agentLive = useChatBackgroundWorkStore((state) => state.agentLive);
  const agents = useMemo(
    () =>
      publishedAgents.map((agent): BackgroundTrayAgent => {
        const live = agentLive[`${chatKey}\0${agent.id}`];
        if (live === undefined) return agent;
        return {
          ...agent,
          status: live.status,
          ...(live.steps.length === 0 ? {} : { steps: live.steps }),
        };
      }),
    [agentLive, chatKey, publishedAgents],
  );
  // Main counts every queued or running delegation in the chat's tree; the
  // drawer counts the ones its transcript has not listed (a turn outside the
  // loaded page, a nested delegate).
  const liveDelegations = useDelegationActivityStore((state) => {
    const entry =
      state.byChat[chatDelegationKey(projectId, worktreeId, chatId)];
    return entry === undefined ? 0 : entry.live + entry.queued;
  });
  const unlistedDelegations = Math.max(
    0,
    liveDelegations -
      agents.filter((agent) => agent.kind === 'delegate').length,
  );
  const receipts = useChatBackgroundWorkStore(
    (state) => state.byChat[chatKey] ?? EMPTY_RUNS,
  );
  const { pipelineReceipts, githubReceipts } = useMemo(() => {
    const all = Object.values(receipts);
    return {
      pipelineReceipts: all.filter(
        (receipt): receipt is PipelineRunArtifactReceiptV1 =>
          receipt.kind === 'pipeline_run',
      ),
      githubReceipts: all.filter(
        (receipt): receipt is GitHubWorkflowRunArtifactReceiptV1 =>
          receipt.kind === 'github_workflow_run',
      ),
    };
  }, [receipts]);
  const executionIds = useMemo(
    () => pipelineReceipts.map((receipt) => receipt.executionId),
    [pipelineReceipts],
  );
  // Keeps these runs' row state cached and live under execution events.
  usePipelineExecutionSummaryInterest(executionIds);
  // An open run's full state, else its row state: the store keeps full
  // states only for open runs, and a row has the jobs the dots need.
  const states = usePipelineRunsStore(
    useShallow((state) =>
      executionIds.map(
        (id): ExecutionState | PipelineRunRowState | undefined =>
          state.statesById[id] ?? state.rowStatesById[id],
      ),
    ),
  );
  const summaryStatuses = usePipelineRunsStore(
    useShallow((state) =>
      executionIds.map(
        (id) => state.summaries.find((summary) => summary.id === id)?.status,
      ),
    ),
  );
  // The tray loads a run's row itself: the transcript card that otherwise
  // loads it may sit in an unmounted turn.
  const unloadedKey = executionIds
    .filter((_, index) => states[index] === undefined)
    .join('\0');
  useEffect(() => {
    if (unloadedKey === '') return;
    for (const executionId of unloadedKey.split('\0')) {
      if (requestedExecutionRows.has(executionId)) continue;
      requestedExecutionRows.add(executionId);
      void usePipelineRunsStore
        .getState()
        .loadExecutionRowState(executionId)
        .finally(() => requestedExecutionRows.delete(executionId));
    }
  }, [unloadedKey]);
  // GitHub state comes from the watcher summaries main already broadcasts,
  // as the run card reads it; never a request of its own.
  useEffect(() => retainAppAdvisorWatchersBridge(), []);
  const { watchers, completedWatchers } = useAppAdvisorWatchersStore(
    useShallow((state) => ({
      watchers: state.watchers,
      completedWatchers: state.completedWatchers,
    })),
  );
  const chatWatchers = useMemo(
    (): BackgroundTrayWatcher[] =>
      watchersForSubscriberDestination(watchers, target).flatMap((watcher) => {
        if (watcher.status !== 'active' && watcher.status !== 'delivery_failed')
          return [];
        const display = watcherTargetDisplay(watcher.target);
        const progress = localWatcherProgressLabel(watcher);
        return [
          {
            id: watcher.id,
            name: watcher.label || display.title,
            watching: display.title,
            trigger: triggerTitle(watcher.trigger),
            status: watcher.status,
            details: [
              ...(display.subtitle
                ? [{ label: 'Context', value: display.subtitle }]
                : []),
              ...display.details,
              ...(watcher.ownerDelegate
                ? [
                    {
                      label: 'Delegate',
                      value: watcherOwnerDelegateDisplay(watcher.ownerDelegate)
                        .name,
                    },
                  ]
                : []),
              ...(progress
                ? [
                    {
                      label: 'Progress',
                      value: progress,
                    },
                  ]
                : []),
            ],
            followUpInstruction: watcher.followUpInstruction,
            deliveryError: watcher.deliveryError,
          },
        ];
      }),
    [watchers, target],
  );
  const deleteWatcher = useCallback(
    (watcherId: string, notifySubscriber: boolean) =>
      useAppAdvisorWatchersStore
        .getState()
        .deleteWatcher(watcherId, { notifySubscriber }),
    [],
  );
  const liveGitHubReceipts = useMemo(
    () =>
      githubReceipts.map((receipt) =>
        refreshGitHubWorkflowRunReceipt(receipt, [
          ...watchers,
          ...completedWatchers,
        ]),
      ),
    [completedWatchers, githubReceipts, watchers],
  );
  // What a watcher last observed is kept, so a run's final state outlives
  // the watcher's summaries.
  useEffect(() => {
    publishChatBackgroundRuns(chatKey, liveGitHubReceipts);
  }, [chatKey, liveGitHubReceipts]);
  const watchedNow = useMemo(
    () =>
      watchedPullRequests([...watchers, ...completedWatchers], {
        projectId,
        worktreeId,
        chatId,
      }),
    [chatId, completedWatchers, projectId, watchers, worktreeId],
  );
  // What a watcher last observed is kept, so a finished pull request
  // outlives its watcher's summaries.
  useEffect(() => {
    publishChatBackgroundPullRequests(chatKey, watchedNow);
  }, [chatKey, watchedNow]);
  const heldPullRequests = useChatBackgroundWorkStore(
    (state) => state.pullRequestsByChat[chatKey] ?? EMPTY_PULL_REQUESTS,
  );
  const pullRequests = useMemo(() => {
    const merged = new Map<string, WatchedPullRequest>(
      Object.entries(heldPullRequests).map(([key, held]) => [
        key,
        { ...held, active: false },
      ]),
    );
    for (const [key, now] of Array.from(watchedNow)) {
      const held = merged.get(key);
      merged.set(
        key,
        held === undefined || held.pr.observedAt <= now.pr.observedAt
          ? now
          : { ...held, active: now.active },
      );
    }
    return merged;
  }, [heldPullRequests, watchedNow]);
  const { seenLive, dismissed } = useChatBackgroundWorkStore(
    useShallow((state) => ({
      seenLive: state.seenLive,
      dismissed: state.dismissed,
    })),
  );
  // A pipeline run's status reads as the transcript's placement reads it
  // (`useLiveAgentRunKeys`): its state or row, else its summary, else its
  // receipt, so a run no turn lists is listed here. Only a state, row or
  // summary counts as seeing it live: a receipt says only how the run
  // started.
  const seenStatusKeys = new Set<string>();
  const candidates = [
    ...pipelineReceipts.map((receipt, index): BackgroundTrayRun => {
      const state = states[index];
      const known = state?.status ?? summaryStatuses[index];
      if (known !== undefined) seenStatusKeys.add(receipt.dedupeKey);
      return pipelineBackgroundTrayRun(
        receipt.dedupeKey,
        receipt,
        known ?? receipt.initialStatus,
        state,
      );
    }),
    // A GitHub run is live only while a watcher follows it: once no watcher
    // does, its snapshot no longer changes.
    ...liveGitHubReceipts.flatMap((receipt): BackgroundTrayRun[] => {
      const run = githubBackgroundTrayRun(receipt.dedupeKey, receipt);
      seenStatusKeys.add(receipt.dedupeKey);
      const watched = [...watchers, ...completedWatchers].some(
        (watcher) =>
          watcher.id === receipt.watcherId && isFollowingWatcher(watcher),
      );
      return run.status === 'running' && !watched ? [] : [run];
    }),
    // So is an open pull request.
    ...Array.from(pullRequests).flatMap(
      ([key, { active, pr }]): BackgroundTrayRun[] => {
        const run = githubPullRequestBackgroundTrayRun(key, pr);
        seenStatusKeys.add(key);
        return run.status === 'running' && !active ? [] : [run];
      },
    ),
  ];
  const liveRunKey = candidates
    .filter((run) => isLiveStatus(run.status) && seenStatusKeys.has(run.id))
    .map((run) => run.id)
    .join('\0');
  useEffect(() => {
    if (liveRunKey !== '') {
      markChatBackgroundRunsSeenLive(chatKey, liveRunKey.split('\0'));
    }
  }, [chatKey, liveRunKey]);
  // A finished run shows only if the tray saw it running, until dismissed,
  // so an old chat's history never fills the tray.
  const runs = candidates.filter((run) => {
    if (isLiveStatus(run.status)) return true;
    const key = chatBackgroundRunKey(chatKey, run.id);
    return seenLive[key] === true && dismissed[key] !== true;
  });

  const tasks = useMemo(
    () => processes.map(backgroundProcessToTask),
    [processes],
  );
  // App Advisor reads which process's detail modal is open.
  const reportSelectedProcess = useCallback(
    (selectedTaskId: string | null): void =>
      reportBackgroundProcessSelection({
        projectId,
        worktreeId,
        processes,
        selectedTaskId,
      }),
    [processes, projectId, worktreeId],
  );
  const taskActions = useBackgroundTaskActions({
    projectId,
    worktreeId,
    processes,
    onSelectedTaskIdChange: reportSelectedProcess,
  });
  // A scope that doesn't stop its delegates itself (a cloud chat's) offers
  // neither Stop nor Stop all, as the web leaves both out.
  const { delegationStop } = useScopeCapabilities({ projectId });
  const stopAll = useCallback(
    (): Promise<boolean> =>
      requestManagedDelegationStopAll({ projectId, worktreeId, chatId }),
    [chatId, projectId, worktreeId],
  );
  // Delegates stop as their Agent activity card stops them; a Claude agent
  // stops through its own task, in the drawer.
  const stopAgent = useCallback(
    (agent: BackgroundTrayAgent): Promise<boolean> =>
      agent.kind === 'delegate' && agent.target !== null
        ? requestManagedDelegationStop(
            { projectId, worktreeId, chatId },
            agent.target.id,
          )
        : Promise.resolve(false),
    [chatId, projectId, worktreeId],
  );
  const subagentActions = useSubagentEntryActionsValue(
    { projectId, worktreeId },
    chatId,
    true,
  );
  const pipelineReceipt = useCallback(
    (runKey: string): PipelineRunArtifactReceiptV1 | null => {
      const receipt = receipts[runKey];
      return receipt?.kind === 'pipeline_run' ? receipt : null;
    },
    [receipts],
  );
  const stopRun = useCallback(
    (runKey: string): void => {
      const receipt = pipelineReceipt(runKey);
      if (receipt === null) return;
      window.pipelines.cancelExecution(receipt.executionId).then(
        (result) => {
          if (!result.success) {
            showPipelineError(result.error ?? 'Failed to cancel execution');
          }
        },
        (error: unknown) => showPipelineError(extractIpcErrorMessage(error)),
      );
    },
    [pipelineReceipt],
  );
  // The run's own owner, as its transcript card opens it: an App Advisor
  // chat's run belongs to the worktree it ran in. A GitHub run opens on
  // GitHub.
  const openRun = useCallback(
    (runKey: string): void => {
      const pullRequest = pullRequests.get(runKey);
      if (pullRequest !== undefined) {
        openOnGitHub(pullRequest.pr.url, target);
        return;
      }
      const receipt = receipts[runKey];
      if (receipt === undefined) return;
      if (receipt.kind === 'github_workflow_run') {
        void openAgentArtifactNavigation(receipt.navigationTarget);
        return;
      }
      const owner = {
        projectId: receipt.projectId,
        worktreeId: receipt.worktreeId,
      };
      if (detectChatStoreSurface() === 'main') {
        void openPipelineExecutionFromUi({
          executionId: receipt.executionId,
          owner,
          origin: {
            chatTabId: chatId,
            ownerKey: `${projectId}/${worktreeId}`,
          },
        });
        return;
      }
      void openAgentArtifactNavigation({
        kind: 'pipeline_execution',
        executionId: receipt.executionId,
        ...owner,
      });
    },
    [chatId, projectId, pullRequests, receipts, worktreeId, target],
  );
  const openRunJob = useCallback(
    (runKey: string, jobId: string): void => {
      const receipt = liveGitHubReceipts.find(
        (item) => item.dedupeKey === runKey,
      );
      if (receipt === undefined) {
        openRun(runKey);
        return;
      }
      const job = receipt.jobs?.find((item) => item.jobId === jobId);
      if (job === undefined) return;
      openOnGitHub(job.htmlUrl, target);
    },
    [liveGitHubReceipts, openRun, target],
  );
  const renderRunWatcher = useCallback(
    (run: BackgroundTrayRun): JSX.Element | null => {
      const pullRequest = pullRequests.get(run.id);
      if (pullRequest !== undefined) {
        // Every watcher of this chat still following it, not only the one
        // that supplied the newest snapshot.
        const { repository, number } = pullRequest.pr;
        const following = watchers.filter(
          (watcher) =>
            watcher.status === 'active' &&
            watcher.target.kind === 'github_pull_requests' &&
            watcher.destination.projectId === projectId &&
            watcher.destination.worktreeId === worktreeId &&
            watcher.destination.chatId === chatId &&
            watcher.target.items.some(
              (item) =>
                item.repository === repository && item.number === number,
            ),
        );
        return following.length === 0 ? null : (
          <WatcherManagementButton
            appearance="drawer"
            watchers={following}
            modalTitle="Pull request watchers"
            modalEmptyMessage="No active watchers for this pull request."
            ariaLabel="Manage pull request watchers"
            dataTestId={`background-tray-run-watchers-pr-${pullRequest.pr.number}`}
          />
        );
      }
      const receipt = receipts[run.id];
      if (receipt === undefined) return null;
      const matching =
        receipt.kind === 'pipeline_run'
          ? watchersForPipelineExecution(watchers, {
              projectId: receipt.projectId,
              worktreeId: receipt.worktreeId,
              executionId: receipt.executionId,
              pipelineId: receipt.pipelineId,
            })
          : watchers.filter((watcher) => watcher.id === receipt.watcherId);
      if (matching.length === 0) return null;
      return receipt.kind === 'pipeline_run' ? (
        <WatcherManagementButton
          appearance="drawer"
          watchers={matching}
          modalTitle="Pipeline watchers"
          modalEmptyMessage="No active watchers for this pipeline."
          ariaLabel="Manage pipeline watchers"
          dataTestId={`background-tray-run-watchers-${receipt.executionId}`}
        />
      ) : (
        <WatcherManagementButton
          appearance="drawer"
          watchers={matching}
          modalTitle="GitHub workflow watchers"
          modalEmptyMessage="No active watchers for this workflow run."
          ariaLabel="Manage GitHub workflow watchers"
          dataTestId={`background-tray-run-watchers-${receipt.runId}`}
        />
      );
    },
    [chatId, projectId, pullRequests, receipts, watchers, worktreeId],
  );
  const resumeRun = useCallback(
    (runKey: string): void => {
      const receipt = pipelineReceipt(runKey);
      if (receipt === null) return;
      usePipelineRunsStore
        .getState()
        .resumeExecution(receipt.executionId)
        .then(
          (result) => {
            if (!result.success) {
              showPipelineError(result.error ?? 'Failed to resume execution');
            }
          },
          (error: unknown) => showPipelineError(extractIpcErrorMessage(error)),
        );
    },
    [pipelineReceipt],
  );
  const dismissRun = useCallback(
    (runKey: string): void => dismissChatBackgroundRun(chatKey, runKey),
    [chatKey],
  );

  return (
    <BackgroundTray
      renderWithDetails={
        children
          ? (panel, details, sections): ReactNode => (
              <>
                {children(
                  panel,
                  backgroundTrayCounts({
                    tasks,
                    agents,
                    runs,
                    watchers: chatWatchers,
                    unlistedDelegations,
                  }),
                  sections,
                )}
                {details}
              </>
            )
          : undefined
      }
      presentation={children ? 'tab' : 'drawer'}
      chatId={chatId}
      tasks={tasks}
      taskActions={taskActions}
      agents={agents}
      unlistedDelegations={unlistedDelegations}
      runs={runs}
      watchers={chatWatchers}
      onDeleteWatcher={deleteWatcher}
      onOpenAgent={subagentActions?.openSubagentChat}
      {...(delegationStop === true
        ? { onStopAgent: stopAgent, onStopAllDelegations: stopAll }
        : {})}
      onViewTree={subagentActions?.viewTree}
      onStopRun={stopRun}
      onRespondRun={openRun}
      onResumeRun={resumeRun}
      onDismissRun={dismissRun}
      onOpenRun={openRun}
      onRunJobClick={openRunJob}
      renderRunWatcher={renderRunWatcher}
    />
  );
}
