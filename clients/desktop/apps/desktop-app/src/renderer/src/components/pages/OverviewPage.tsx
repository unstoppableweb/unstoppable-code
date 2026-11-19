import { OverviewWorkflowPlaceholder } from '@canopy/ui-shared/components';
import { Stack } from '@canopy/ui-shared/components';
import {
  type JSX,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useOverviewStore } from '@canopy/app-state';
import { SettingsSelect } from '@canopy/ui-shared/components';
import type { RemoteControlPipelineRunProjection } from '@canopy/protocol/remote-control/shell';
import { Overview } from '@canopy/ui-app';
import { useShallow } from 'zustand/react/shallow';
import { PageTitlebar } from '../shared/PageTitlebar';
import { NotificationsPanel } from '@/components/overview/NotificationsPanel';
import { OverviewEmptyState } from '@/components/overview/OverviewEmptyState';
import { WorkspaceReadinessOverview } from '@/components/overview/WorkspaceReadinessOverview';
import { MobileAppPromoCard } from '@/components/overview/MobileAppPromoCard';
import { openOverviewPipelineExecution } from '@/components/overview/openOverviewPipelineExecution';
import { DagProgressBar } from '@/components/activity/DagProgressBar';
import { LoadingSpinner } from '@/components/shared/loading/spinners/LoadingSpinner';
import {
  hasNoCodeWorkspaces,
  shouldRenderWorkspaceReadiness,
} from '@/components/home/homeGating';
import { requestChatPanelReveal } from '@/lib/chatPanelReveal';
import {
  overviewChatRouteAction,
  projectDesktopOverview,
} from '@/lib/desktopOverviewProjector';
import { selectOverviewExecutionIdsMissingRowState } from '@/lib/overviewSelectors';
import { openTrackedPlan } from '@/lib/plans/open-tracked-plan';
import { findPlanExploreTarget, useChatStore } from '@/stores/chatStore';
import { dismissPageLikeViewers } from '@/lib/dismissPageLikeViewers';
import { useNavigationStore } from '@/stores/navigationStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { usePipelineExecutionSummaryInterest } from '@/stores/pipelineDetailCoordinator';
import { useProjectsStore } from '@/stores/projectsStore';
import { useContextScopedWorkspaces } from '@/hooks/useContextScopedWorkspaces';
import { openInWorkspaceContext } from '@/lib/contextScope';

const HYDRATE_PARALLELISM = 4;

async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  parallelism: number,
): Promise<void> {
  const queue = [...tasks];
  const workers: Promise<void>[] = [];
  const workerCount = Math.max(1, Math.min(parallelism, queue.length));
  for (let index = 0; index < workerCount; index += 1) {
    workers.push(
      (async (): Promise<void> => {
        while (queue.length > 0) {
          const task = queue.shift();
          if (!task) return;
          try {
            await task();
          } catch {
            // Individual detail failures are non-fatal; the card retains its
            // lightweight loading/skeleton treatment.
          }
        }
      })(),
    );
  }
  await Promise.all(workers);
}

export function OverviewPage(): JSX.Element {
  // First-run detection stays desktop-owned: the shared Overview is an
  // attention dashboard, while the desktop host owns onboarding and modal
  // composition.
  const hasHydratedProjects = useProjectsStore((s) => s.hasHydratedProjects);
  const allProjects = useProjectsStore((s) => s.projects);
  const { context, workspaces: contextProjects } = useContextScopedWorkspaces();
  const [contextFilter, setContextFilter] = useState<'context' | 'all'>(
    'context',
  );
  const projects = contextFilter === 'all' ? allProjects : contextProjects;
  const isFirstRun = hasHydratedProjects && hasNoCodeWorkspaces(projects);
  const showWorkspaceReadiness = shouldRenderWorkspaceReadiness(
    projects,
    hasHydratedProjects,
  );

  const {
    worktreeChats,
    unreadWorktreeKeys,
    selectWorktree,
    switchTab,
    dismissOverviewChatCard,
  } = useChatStore(
    useShallow((s) => ({
      worktreeChats: s.worktreeChats,
      unreadWorktreeKeys: s.unreadWorktreeKeys,
      selectWorktree: s.selectWorktree,
      switchTab: s.switchTab,
      dismissOverviewChatCard: s.dismissOverviewChatCard,
    })),
  );
  const {
    runningExecutionsByWorktree,
    unseenPipelineWorktreeKeys,
    pipelineSummariesByWorktree,
    rowStatesById,
    loadExecutionRowState,
    markWorktreePipelineSeen,
  } = usePipelineRunsStore(
    useShallow((s) => ({
      runningExecutionsByWorktree: s.runningExecutionsByWorktree,
      unseenPipelineWorktreeKeys: s.unseenPipelineWorktreeKeys,
      pipelineSummariesByWorktree: s.pipelineSummariesByWorktree,
      rowStatesById: s.rowStatesById,
      loadExecutionRowState: s.loadExecutionRowState,
      markWorktreePipelineSeen: s.markWorktreePipelineSeen,
    })),
  );
  const inFlightPipelineRowIdsRef = useRef<Set<string>>(new Set());

  const projection = useMemo(
    () =>
      projectDesktopOverview({
        projects,
        worktreeChats,
        unreadWorktreeKeys,
        runningExecutionsByWorktree,
        unseenPipelineWorktreeKeys,
        pipelineSummariesByWorktree,
        resolvePlanExplore: (planId) =>
          findPlanExploreTarget(planId) ?? undefined,
      }),
    [
      pipelineSummariesByWorktree,
      projects,
      runningExecutionsByWorktree,
      unseenPipelineWorktreeKeys,
      unreadWorktreeKeys,
      worktreeChats,
    ],
  );
  const displayedPipelineExecutionIds = useMemo(
    () =>
      projection.snapshot.pipelineRuns.flatMap((run) =>
        run.localId ? [run.localId] : [],
      ),
    [projection.snapshot.pipelineRuns],
  );
  usePipelineExecutionSummaryInterest(displayedPipelineExecutionIds);

  // Keep only row projections for every card shown here, including unread
  // paused and terminal runs. The in-flight set is temporary: if the store
  // later evicts a still-visible row, the missing-row selector will hydrate
  // it again rather than being blocked by a permanent request marker.
  useEffect(() => {
    const missing = selectOverviewExecutionIdsMissingRowState(
      displayedPipelineExecutionIds,
      rowStatesById,
    ).filter((id) => !inFlightPipelineRowIdsRef.current.has(id));
    if (missing.length === 0) return;

    for (const id of missing) {
      inFlightPipelineRowIdsRef.current.add(id);
    }
    void runWithConcurrency(
      missing.map(
        (id) => (): Promise<unknown> =>
          loadExecutionRowState(id).finally(() => {
            inFlightPipelineRowIdsRef.current.delete(id);
          }),
      ),
      HYDRATE_PARALLELISM,
    );
  }, [displayedPipelineExecutionIds, loadExecutionRowState, rowStatesById]);

  const hydrateOverview = useOverviewStore((s) => s.hydrate);
  useEffect(() => {
    hydrateOverview(projection.snapshot);
  }, [hydrateOverview, projection.snapshot]);

  const navigate = useNavigationStore((s) => s.navigate);
  const openAddWorkspaceModal = useNavigationStore(
    (s) => s.openAddWorkspaceModal,
  );

  const handleCreateWorkspace = useCallback((): void => {
    navigate('main');
    openAddWorkspaceModal();
  }, [navigate, openAddWorkspaceModal]);

  const handleStartChat = useCallback((): void => {
    navigate('chat');
  }, [navigate]);

  const handleSelectWorktree = useCallback(
    (workspaceLocalId: string, worktreeLocalId: string): void => {
      openInWorkspaceContext(workspaceLocalId, (): void => {
        const route = projection.chatRoutes[worktreeLocalId];
        const action = route ? overviewChatRouteAction(route) : undefined;
        if (action?.kind === 'none') return;
        if (action?.kind === 'plan') {
          // The opener brings the plan's worktree on screen itself.
          void openTrackedPlan(action.ref);
          return;
        }
        // Explicit navigation to a live worktree dismisses the page-like
        // archived viewer overlaying the main page.
        dismissPageLikeViewers();
        navigate('main');
        if (!action) {
          selectWorktree(workspaceLocalId, worktreeLocalId);
          return;
        }
        selectWorktree(action.projectId, action.worktreeId);
        switchTab(action.tabId);
        requestChatPanelReveal(
          action.projectId,
          action.worktreeId,
          action.tabId,
        );
      });
    },
    [navigate, projection.chatRoutes, selectWorktree, switchTab],
  );

  const handleDismissWorktree = useCallback(
    (_workspaceLocalId: string, worktreeLocalId: string): void => {
      const route = projection.chatRoutes[worktreeLocalId];
      if (!route) return;
      dismissOverviewChatCard(route.projectId, route.worktreeId, route.tabId);
    },
    [dismissOverviewChatCard, projection.chatRoutes],
  );

  const handleSelectPipelineRun = useCallback(
    (run: RemoteControlPipelineRunProjection, unread: boolean): void => {
      if (!run.workspaceLocalId || !run.worktreeLocalId || !run.localId) return;
      const projectId = run.workspaceLocalId;
      const worktreeId = run.worktreeLocalId;
      const executionId = run.localId;
      openInWorkspaceContext(projectId, (): void => {
        void openOverviewPipelineExecution({
          projectId,
          worktreeId,
          executionId,
          markSeen: unread,
        });
      });
    },
    [],
  );

  const handleDismissPipelineRun = useCallback(
    (run: RemoteControlPipelineRunProjection): void => {
      if (!run.workspaceLocalId || !run.worktreeLocalId) return;
      markWorktreePipelineSeen(
        `${run.workspaceLocalId}/${run.worktreeLocalId}`,
      );
    },
    [markWorktreePipelineSeen],
  );

  const renderPipelineRunDetails = useCallback(
    (run: RemoteControlPipelineRunProjection, unread: boolean): ReactNode => {
      if (!run.workspaceLocalId || !run.worktreeLocalId || !run.localId) {
        return null;
      }
      const projectId = run.workspaceLocalId;
      const worktreeId = run.worktreeLocalId;
      const executionId = run.localId;
      const state = rowStatesById[executionId];
      const hiddenCount = projection.pipelineHiddenCounts[executionId];
      return (
        <div className="pt-1 flex flex-col gap-1">
          {state ? (
            <DagProgressBar
              executionState={state}
              muted={unread}
              onJobClick={(jobId): void =>
                openInWorkspaceContext(projectId, (): void => {
                  void openOverviewPipelineExecution({
                    projectId,
                    worktreeId,
                    executionId,
                    jobId,
                    markSeen: unread,
                  });
                })
              }
            />
          ) : unread ? (
            <OverviewWorkflowPlaceholder />
          ) : (
            <div className="flex items-center gap-2 text-xs fg-secondary">
              <LoadingSpinner sizePx={12} />
              <span>Loading workflow details…</span>
            </div>
          )}
          {hiddenCount !== undefined && hiddenCount > 0 && (
            <span className="text-2xs fg-secondary">
              +{hiddenCount} more in this worktree
            </span>
          )}
        </div>
      );
    },
    [projection.pipelineHiddenCounts, rowStatesById],
  );

  if (isFirstRun) {
    return (
      <div
        className="page-scroll-gutter flex min-h-full flex-col overflow-y-auto"
        data-testid="overview-page"
      >
        <PageTitlebar />
        <OverviewEmptyState
          onCreateWorkspace={handleCreateWorkspace}
          onStartChat={handleStartChat}
        />
      </div>
    );
  }

  return (
    <div
      className="page-scroll-gutter flex min-h-full flex-col overflow-y-auto"
      data-testid="overview-page"
    >
      <PageTitlebar />
      {context !== undefined && (
        <div className="flex justify-end px-6 pt-4">
          <div className="flex items-center gap-2 text-xs fg-secondary">
            <span id="overview-context-filter-label">Scope</span>
            <SettingsSelect
              width="fit"
              aria-labelledby="overview-context-filter-label"
              data-testid="overview-context-filter"
              options={[
                { value: 'context', label: 'Selected context' },
                { value: 'all', label: 'All contexts' },
              ]}
              value={contextFilter}
              onValueChange={(next) =>
                setContextFilter(next === 'all' ? 'all' : 'context')
              }
            />
          </div>
        </div>
      )}
      <Overview
        className="flex-1"
        layout="page"
        onSelectWorktree={handleSelectWorktree}
        onDismissWorktree={handleDismissWorktree}
        onSelectPipelineRun={handleSelectPipelineRun}
        onDismissPipelineRun={handleDismissPipelineRun}
        renderPipelineRunDetails={renderPipelineRunDetails}
        notifications={
          <NotificationsPanel showAllContexts={contextFilter === 'all'} />
        }
        recommendations={
          // The `recommendations` slot is a single node, so compose: readiness
          // first (actionable), mobile-app promo second (a nudge).
          <Stack gap="group">
            {showWorkspaceReadiness && (
              <WorkspaceReadinessOverview
                projects={projects}
                hasHydratedProjects={hasHydratedProjects}
              />
            )}
            <MobileAppPromoCard />
          </Stack>
        }
      />
    </div>
  );
}
