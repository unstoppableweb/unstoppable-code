import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type {
  AppAdvisorWatcherSummary,
  ScheduledActivity,
  ScheduledActivityRun,
} from '@canopy/desktop-shared/types';
import type { ExecutionSummary } from '@canopy/execution-engine/types/pipeline';
import type { WorkerPipelineExecutionView } from '@canopy/protocol/canopy-core';
import {
  isSameWorkspaceContext,
  parseWorkspaceContext,
  type WorkspaceContext,
} from '@canopy/protocol/workspace-context';
import {
  countActiveWorkflowRuns,
  type WorkflowRunAction,
  type WorkflowRunRow,
} from '@canopy/ui-app/workflows';
import type { AutomationScope } from '@/hooks/useAutomationScope';
import {
  canRerunExecution,
  canResumeExecution,
  canRetryExecution,
  isTerminalExecutionStatus,
} from '@/lib/execution-actions';
import { getChatTabLabel } from '@/lib/chatTabLabel';
import { useCloudPipelineRuns } from '@/lib/workflows/cloud-runs';
import { getWorkspaceDisplayName } from '@/lib/workspaceDisplayName';
import {
  retainExecutionFeed,
  useExecutionFeedStore,
} from '@/lib/workflows/execution-feed';
import {
  activitiesWithRunHistory,
  buildWorkflowRunRows,
  loadOlderAutomationRuns,
  mergeAutomationRuns,
  type RunFeedInput,
} from '@/lib/workflows/run-feed';
import { useAppAdvisorWatchersStore } from '@/stores/appAdvisorWatchersStore';
import { useChatStore } from '@/stores/chatStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { usePipelineCloudRuns } from '../../activity/pipelineRunOn';
import { resolveAutomationRunDestination } from '../../automations/resolveAutomationRunDestination';
import { watcherDestinationDisplay } from '../../watchers/watcherDisplay';

export interface WorkflowRunFeed {
  /** Every row of the current context, active first, then newest. */
  readonly rows: readonly WorkflowRunRow[];
  /** Running, waiting or watching: the Runs tab's count. */
  readonly activeCount: number;
  readonly executionsById: ReadonlyMap<string, ExecutionSummary>;
  readonly runsById: ReadonlyMap<string, ScheduledActivityRun>;
  readonly watchersById: ReadonlyMap<string, AppAdvisorWatcherSummary>;
  /** Cloud runs by execution id, while the feed lists them (CAN-6326). */
  readonly cloudRunsById: ReadonlyMap<string, WorkerPipelineExecutionView>;
  /** The executions could not be listed. */
  readonly error: string | null;
  /** The cloud runs could not be listed; the ones listed before are kept. */
  readonly cloudError: string | null;
  /** The first load of the executions or the automations has not finished. */
  readonly loading: boolean;
  /** Older automation runs may follow. */
  readonly hasMore: boolean;
  /** Older cloud runs may follow. */
  readonly cloudHasMore: boolean;
  readonly loadingMore: boolean;
  /** The last Load more could not read some automation's older runs. */
  readonly loadMoreFailed: boolean;
  readonly loadMore: () => void;
}

interface RunFeedSources {
  readonly activities: readonly ScheduledActivity[];
  readonly recentRuns: readonly ScheduledActivityRun[];
  readonly scope: AutomationScope;
  /** The automations' first load has not finished. */
  readonly automationsLoading: boolean;
  /**
   * Load more reads only this automation's history, for a runs list narrowed
   * to it. Every automation's otherwise.
   */
  readonly historyActivityId?: string;
  /**
   * Scope rules that replace the context's, for a feed narrowed to one
   * workspace (the workspace Workflows panel). The context still scopes
   * Load more.
   */
  readonly predicates?: Pick<
    RunFeedInput,
    | 'activityInScope'
    | 'orphanRunInScope'
    | 'executionInScope'
    | 'watcherInScope'
  >;
}

/**
 * Every chat tab's label, keyed `project/worktree/chat`. The object keeps its
 * identity until a label changes, so the rows that read it are not rebuilt
 * for each message a chat streams.
 */
export function useChatTabTitles(): Readonly<Record<string, string>> {
  return useChatStore(
    useShallow((state) => {
      const titles: Record<string, string> = {};
      for (const [key, chat] of Object.entries(state.worktreeChats)) {
        for (const tab of chat.tabs) {
          titles[`${key}/${tab.id}`] = getChatTabLabel(tab);
        }
      }
      return titles;
    }),
  );
}

/**
 * Whether a run with no live project belongs to the selected context. Its
 * recorded owner decides; a run that recorded none stays in Personal, and one
 * whose recorded owner cannot be read belongs to no context.
 */
export function unprojectedExecutionInContext(
  executionContext: string | undefined,
  context: WorkspaceContext | undefined,
  parse: (value: string) => WorkspaceContext | null = parseWorkspaceContext,
): boolean {
  if (context === undefined) return true;
  if (executionContext === undefined) return context.kind === 'personal';
  const owner = parse(executionContext);
  return owner !== null && isSameWorkspaceContext(owner, context);
}

/** Actions the existing execution handlers allow for one run. */
export function executionRunActions(
  execution: ExecutionSummary,
): readonly WorkflowRunAction[] {
  const actions: WorkflowRunAction[] = [];
  if (canResumeExecution(execution)) actions.push('respond');
  const finished = isTerminalExecutionStatus(execution.status);
  if (!finished) actions.push('cancel');
  if (canRetryExecution(execution)) actions.push('retry');
  if (canRerunExecution(execution)) actions.push('rerun');
  // A run still in progress stays listed, as on the old run rows.
  if (finished) actions.push('hide');
  return actions;
}

/**
 * The desktop Runs feed (CAN-3981): the global execution projection, the
 * automation runs the store keeps hot plus any older pages loaded here, and
 * the watchers, scoped to the sidebar's Personal/organization context.
 */
export function useWorkflowRunFeed({
  activities,
  recentRuns,
  scope,
  automationsLoading,
  historyActivityId,
  predicates,
}: RunFeedSources): WorkflowRunFeed {
  useEffect(() => retainExecutionFeed(), []);
  const executions = useExecutionFeedStore((state) => state.executions);
  const error = useExecutionFeedStore((state) => state.error);
  const executionsLoaded = useExecutionFeedStore((state) => state.loaded);
  const executionsLoading = useExecutionFeedStore((state) => state.loading);
  const { activeWatchers, completedWatchers } = useAppAdvisorWatchersStore(
    useShallow((state) => ({
      activeWatchers: state.watchers,
      completedWatchers: state.completedWatchers,
    })),
  );
  const projects = useProjectsStore((state) => state.projects);
  const chatTitles = useChatTabTitles();
  // Cloud runs join the feed only while the web core manifest says they are
  // available (CAN-6085); otherwise nothing about the feed changes. A feed
  // narrowed to one workspace lists none: cloud runs belong to no project yet.
  const { pipelineCloudRuns } = usePipelineCloudRuns();
  const listsCloud = pipelineCloudRuns === true && predicates === undefined;
  const cloud = useCloudPipelineRuns(listsCloud);
  const cloudRuns = listsCloud ? cloud.state.runs : undefined;

  // Older automation runs, loaded on demand and merged behind the hot window.
  const [olderRuns, setOlderRuns] = useState<readonly ScheduledActivityRun[]>(
    [],
  );
  const cursorsRef = useRef<Map<string, string | null>>(new Map());
  const [exhausted, setExhausted] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);

  const runs = useMemo(
    () => mergeAutomationRuns(recentRuns, olderRuns),
    [olderRuns, recentRuns],
  );
  const watchers = useMemo(() => {
    const seen = new Set<string>();
    return [...activeWatchers, ...completedWatchers].filter((watcher) => {
      if (seen.has(watcher.id)) return false;
      seen.add(watcher.id);
      return true;
    });
  }, [activeWatchers, completedWatchers]);

  const rows = useMemo(() => {
    const projectsById = new Map(
      projects.map((project) => [project.id, project]),
    );
    const projectIdsInContext = new Set(
      scope.projectsInContext.map((project) => project.id),
    );
    // Whatever belongs to no project stays in Personal.
    const unownedInScope =
      scope.context === undefined || scope.context.kind === 'personal';
    // Each recorded owner string is parsed once per build of the rows.
    const parsedOwners = new Map<string, WorkspaceContext | null>();
    const parseOwner = (value: string): WorkspaceContext | null => {
      const cached = parsedOwners.get(value);
      if (cached !== undefined) return cached;
      const parsed = parseWorkspaceContext(value);
      parsedOwners.set(value, parsed);
      return parsed;
    };
    const chatTitle = (
      projectId: string,
      worktreeId: string,
      chatId: string,
    ): string | undefined => chatTitles[`${projectId}/${worktreeId}/${chatId}`];
    return buildWorkflowRunRows({
      executions,
      // A listing in flight may hold runs that started since the last one.
      executionsKnown: executionsLoaded && !executionsLoading && error === null,
      runs,
      activities,
      watchers,
      activityInScope: scope.inContext,
      orphanRunInScope: () => unownedInScope,
      // A run with no live project is filed by the owner it recorded; one
      // that recorded none stays in Personal.
      executionInScope: (execution) =>
        execution.project_id === undefined ||
        !projectsById.has(execution.project_id)
          ? unprojectedExecutionInContext(
              execution.execution_context,
              scope.context,
              parseOwner,
            )
          : scope.context === undefined ||
            projectIdsInContext.has(execution.project_id),
      watcherInScope: scope.watcherInContext,
      cloudRuns,
      // A cloud run belongs to no project yet, so its recorded owner files it.
      cloudRunInScope: (view) =>
        unprojectedExecutionInContext(
          view.execution.owner ?? undefined,
          scope.context,
          parseOwner,
        ),
      ...predicates,
      executionActions: executionRunActions,
      automationRunResult: (run) => {
        const destination = resolveAutomationRunDestination(run);
        return destination.kind === 'none'
          ? { available: false, reason: destination.reason }
          : { available: true };
      },
      automationRunOpensChat: (run) => {
        const { kind } = resolveAutomationRunDestination(run);
        return (
          kind === 'app-advisor-chat' ||
          kind === 'cowork-chat' ||
          kind === 'worktree-chat'
        );
      },
      names: {
        project: (projectId) => {
          const project = projectsById.get(projectId);
          return project ? getWorkspaceDisplayName(project) : undefined;
        },
        worktree: (projectId, worktreeId) => {
          const project = projectsById.get(projectId);
          if (!project || project.type === 'cowork') return undefined;
          return project.worktrees.find(
            (worktree) => worktree.id === worktreeId,
          )?.branchName;
        },
        chat: chatTitle,
        watcherDestination: (watcher) =>
          watcherDestinationDisplay(
            watcher.destination,
            chatTitle(
              watcher.destination.projectId,
              watcher.destination.worktreeId,
              watcher.destination.chatId,
            ),
          ),
      },
    });
  }, [
    activities,
    chatTitles,
    cloudRuns,
    error,
    executions,
    executionsLoaded,
    executionsLoading,
    predicates,
    projects,
    runs,
    scope,
    watchers,
  ]);

  /** The automations Load more reads older runs from. */
  const candidates = useMemo(
    () =>
      activitiesWithRunHistory(
        runs,
        historyActivityId === undefined
          ? activities
          : activities.filter((activity) => activity.id === historyActivityId),
        scope.inContext,
      ),
    [activities, historyActivityId, runs, scope.inContext],
  );
  // A load that is still running finishes against the list as it is then.
  const candidatesRef = useRef(candidates);
  candidatesRef.current = candidates;

  const cloudStore = cloud.store;
  const cloudHasMore =
    cloudRuns !== undefined && cloud.state.nextCursor !== null;
  const loadMore = useCallback((): void => {
    if (cloudHasMore) void cloudStore?.loadMore();
    if (loadingMoreRef.current) return;
    const api = window.api?.automations;
    if (!api?.listRuns) {
      setExhausted(true);
      return;
    }
    // Fan out to every in-scope automation that has run, and skip the ones
    // whose history is fully loaded.
    const cursors = cursorsRef.current;
    const unfinished = (): ScheduledActivity[] =>
      candidatesRef.current.filter(
        (activity) => cursors.get(activity.id) !== null,
      );
    if (unfinished().length === 0) {
      setExhausted(true);
      return;
    }
    loadingMoreRef.current = true;
    setLoadingMore(true);
    void (async (): Promise<void> => {
      // This load reads the automations listed when it began; one that
      // appears meanwhile is read by the next Load more.
      const { loaded, failed } = await loadOlderAutomationRuns({
        activities: candidates,
        cursors,
        listedRunIds: new Set(runs.map((run) => run.id)),
        listRuns: (request) => api.listRuns(request),
      });
      // The context changed while this load ran: its cursors and flags belong
      // to a feed that is no longer shown.
      if (cursorsRef.current !== cursors) return;
      setOlderRuns((current) => mergeAutomationRuns(current, loaded));
      setLoadMoreFailed(failed);
      setExhausted(unfinished().length === 0);
      loadingMoreRef.current = false;
      setLoadingMore(false);
    })();
  }, [candidates, cloudHasMore, cloudStore, runs]);

  // Another context lists other automations, so their cursors start over.
  const contextKey =
    scope.context === undefined
      ? 'unscoped'
      : scope.context.kind === 'personal'
        ? 'personal'
        : scope.context.organizationId;
  // An automation that ran for the first time since the last Load more has
  // history to read again. One that left the list does not.
  const knownHistoryRef = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const known = knownHistoryRef.current;
    if (candidates.some((activity) => !known.has(activity.id))) {
      setExhausted(false);
    }
    knownHistoryRef.current = new Set(
      candidates.map((activity) => activity.id),
    );
  }, [candidates]);

  useEffect(() => {
    cursorsRef.current = new Map();
    setOlderRuns([]);
    setExhausted(false);
    setLoadMoreFailed(false);
    // A load still running for the previous context no longer blocks this one.
    loadingMoreRef.current = false;
    setLoadingMore(false);
  }, [contextKey]);

  return useMemo(
    () => ({
      rows,
      activeCount: countActiveWorkflowRuns(rows),
      executionsById: new Map(executions.map((entry) => [entry.id, entry])),
      runsById: new Map(runs.map((run) => [run.id, run])),
      watchersById: new Map(watchers.map((watcher) => [watcher.id, watcher])),
      cloudRunsById: new Map(
        (cloudRuns ?? []).map((view) => [view.execution.executionId, view]),
      ),
      error,
      cloudError:
        cloudRuns === undefined ? null : (cloud.state.error?.message ?? null),
      loading: !executionsLoaded || automationsLoading,
      hasMore: !exhausted && candidates.length > 0,
      cloudHasMore,
      loadingMore: loadingMore || cloud.state.loadingMore,
      loadMoreFailed,
      loadMore,
    }),
    [
      automationsLoading,
      candidates,
      cloud.state.error,
      cloud.state.loadingMore,
      cloudHasMore,
      cloudRuns,
      error,
      executions,
      executionsLoaded,
      exhausted,
      loadMore,
      loadMoreFailed,
      loadingMore,
      rows,
      runs,
      watchers,
    ],
  );
}
