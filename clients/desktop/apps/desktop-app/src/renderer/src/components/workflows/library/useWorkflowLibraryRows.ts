import { useEffect, useMemo } from 'react';
import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import type {
  ExecutionSummary,
  PipelineInfo,
} from '@canopy/execution-engine/types/pipeline';
import type { SharedAutomationSummary } from '@canopy/protocol/automations';
import type { WorkflowLibraryRow } from '@canopy/ui-app/workflows';
import { useSharedAutomationList } from '@/hooks/useSharedAutomationList';
import { isCanopyCloudConnected } from '@/lib/canopy-cloud';
import { getWorkspaceDisplayName } from '@/lib/workspaceDisplayName';
import {
  pipelineLibraryKey,
  projectLibraryRows,
  sharedAutomationLibraryKey,
  type LibrarySharedAutomation,
  type LibrarySharer,
} from '@/lib/workflows/library-projection';
import { automationLibraryKey } from '@/lib/workflows/run-feed';
import { useProjectsStore } from '@/stores/projectsStore';
import type { AutomationsPageBodyApi } from '../../pages/AutomationsPage';
import type { PipelinesPageListApi } from '../../pages/PipelinesPage';
import { getAutomationNextRun } from '../../panels/automations/automations-panel-data';
import { useChatTabTitles } from '../runs/useWorkflowRunFeed';
import {
  useLibraryProjectPlace,
  type LibraryProjectPlace,
} from './libraryProjectPlace';

/** What a Library row stands for, so an action reaches the right handler. */
export type WorkflowLibraryTarget =
  | { readonly kind: 'automation'; readonly activity: ScheduledActivity }
  | { readonly kind: 'pipeline'; readonly pipeline: PipelineInfo }
  | {
      readonly kind: 'shared-automation';
      readonly share: SharedAutomationSummary;
    };

export interface WorkflowLibraryData {
  /** Every row of the current context, before search, filters and sort. */
  readonly rows: readonly WorkflowLibraryRow[];
  readonly targets: ReadonlyMap<string, WorkflowLibraryTarget>;
  /** A share list failed, so shared rows may be missing. */
  readonly sharedLoadFailed: boolean;
  /** The first load of the local lists has not finished. */
  readonly loading: boolean;
  /** Lists the shared automations again, such as after a failed load. */
  readonly refreshSharedAutomations: () => Promise<void>;
  /** Where project pipelines are read from (CAN-965). */
  readonly projectPlace: LibraryProjectPlace;
}

function sharerOf(
  owner: SharedAutomationSummary['owner'],
): LibrarySharer | undefined {
  if (owner.type === 'system' || !owner.name) return undefined;
  return { name: owner.name, isPerson: owner.type === 'user' };
}

/**
 * The desktop Library rows (CAN-3981): the automations and pipelines the page
 * already loads, the shares visible in the current context, and the execution
 * projection for a pipeline's Last run.
 */
export function useWorkflowLibraryRows(
  pipelines: PipelinesPageListApi,
  automations: AutomationsPageBodyApi,
  executions: readonly ExecutionSummary[],
  now: number,
): WorkflowLibraryData {
  const projects = useProjectsStore((state) => state.projects);
  const projectPlace = useLibraryProjectPlace();
  const projectCwd =
    projectPlace.kind === 'worktree' &&
    pipelines.projectContext?.worktree.worktreeId === projectPlace.worktreeId
      ? pipelines.projectContext.cwd
      : undefined;
  const currentWorktreeName =
    projectPlace.kind === 'worktree' ? projectPlace.worktreeName : undefined;
  const chatTitles = useChatTabTitles();
  const sharedAutomations = useSharedAutomationList();

  // The tab bar counts the Library's rows on every tab, so the share lists
  // load with the page, not with the Library tab.
  const automationSharesReady =
    isCanopyCloudConnected(sharedAutomations.cloudAccount) &&
    !sharedAutomations.loaded &&
    !sharedAutomations.loading;
  const refreshSharedAutomations = sharedAutomations.refreshShared;
  useEffect(() => {
    if (automationSharesReady) void refreshSharedAutomations();
  }, [automationSharesReady, refreshSharedAutomations]);
  const pipelineSharesReady =
    isCanopyCloudConnected(pipelines.shared.cloudAccount) &&
    !pipelines.shared.loaded &&
    !pipelines.shared.loading;
  const refreshSharedPipelines = pipelines.refreshSharedList;
  const pipelineCloudAccount = pipelines.shared.cloudAccount;
  const viewerId = isCanopyCloudConnected(pipelineCloudAccount)
    ? (pipelineCloudAccount?.account?.id ?? null)
    : null;
  useEffect(() => {
    if (pipelineSharesReady) void refreshSharedPipelines();
  }, [pipelineSharesReady, refreshSharedPipelines]);

  // The table counts and filters every share, so the later pages follow the
  // first. A page that fails stops here and shows as a failed share list.
  const moreAutomationShares =
    sharedAutomations.loaded &&
    !sharedAutomations.loading &&
    !sharedAutomations.loadingMore &&
    sharedAutomations.nextCursor !== null &&
    sharedAutomations.error === null;
  const loadMoreSharedAutomations = sharedAutomations.loadMoreShared;
  useEffect(() => {
    if (moreAutomationShares) void loadMoreSharedAutomations();
  }, [loadMoreSharedAutomations, moreAutomationShares]);
  const morePipelineShares =
    pipelines.shared.loaded &&
    !pipelines.shared.loading &&
    !pipelines.shared.loadingMore &&
    pipelines.shared.nextCursor !== null &&
    pipelines.shared.error === null;
  const loadMoreSharedPipelines = pipelines.loadMoreSharedList;
  useEffect(() => {
    if (morePipelineShares) void loadMoreSharedPipelines();
  }, [loadMoreSharedPipelines, morePipelineShares]);

  const { scope, scopedActivities, recentRuns } = automations;
  const allActivities = automations.activities;
  return useMemo(() => {
    const projectsById = new Map(
      projects.map((project) => [project.id, project]),
    );
    const listedPipelines = [
      // Curated starters stay in Marketplace.
      ...pipelines.pipelines.filter(
        (pipeline) => pipeline.source !== 'curated',
      ),
      ...pipelines.shared.rows,
    ];
    const shares = sharedAutomations.automations.filter(scope.shareInContext);
    const targets = new Map<string, WorkflowLibraryTarget>();
    for (const activity of scopedActivities) {
      targets.set(automationLibraryKey(activity.id), {
        kind: 'automation',
        activity,
      });
    }
    for (const pipeline of listedPipelines) {
      targets.set(pipelineLibraryKey(pipeline), { kind: 'pipeline', pipeline });
    }
    for (const share of shares) {
      targets.set(sharedAutomationLibraryKey(share.id), {
        kind: 'shared-automation',
        share,
      });
    }
    const sharersByRemoteId = new Map(
      sharedAutomations.automations.map((share) => [
        share.id,
        sharerOf(share.owner),
      ]),
    );
    const rows = projectLibraryRows({
      activities: scopedActivities,
      viewerId,
      installedRemoteIds: new Set(
        allActivities.flatMap((activity) =>
          activity.installedFrom ? [activity.installedFrom.remoteId] : [],
        ),
      ),
      recentRuns,
      pipelines: listedPipelines,
      // Every context's automations: an owned pipeline folds even when its
      // automation is listed elsewhere (CAN-4551).
      ownedPipelineIds: new Set(
        allActivities.flatMap((activity) =>
          activity.ownedPipeline ? [activity.ownedPipeline.pipelineId] : [],
        ),
      ),
      disabledPipelineIds: pipelines.disabledPipelineIds,
      executions,
      sharedAutomations: shares.map(
        (share): LibrarySharedAutomation => ({
          remoteId: share.id,
          name: share.name,
          triggerKind: share.triggerKind,
          actionType: share.actionType,
          sharer: sharerOf(share.owner),
          createdById: share.createdBy?.id,
          updatedAt: share.updatedAt,
        }),
      ),
      now,
      currentProjectId: pipelines.projectId,
      ...(currentWorktreeName && projectCwd
        ? { currentWorktree: { name: currentWorktreeName, cwd: projectCwd } }
        : {}),
      nextRun: getAutomationNextRun,
      projectName: (projectId) => {
        const project = projectsById.get(projectId);
        return project ? getWorkspaceDisplayName(project) : undefined;
      },
      chatTitle: (projectId, worktreeId, chatId) =>
        chatTitles[`${projectId}/${worktreeId}/${chatId}`],
      sharerForInstalled: (activity) =>
        activity.installedFrom
          ? sharersByRemoteId.get(activity.installedFrom.remoteId)
          : undefined,
    });
    return {
      rows,
      targets,
      sharedLoadFailed:
        sharedAutomations.error !== null || pipelines.shared.error !== null,
      loading: automations.loading || (pipelines.loading && rows.length === 0),
      refreshSharedAutomations,
      projectPlace,
    };
  }, [
    currentWorktreeName,
    projectCwd,
    projectPlace,
    viewerId,
    automations.loading,
    executions,
    now,
    pipelines.disabledPipelineIds,
    pipelines.loading,
    pipelines.pipelines,
    pipelines.projectId,
    pipelines.shared.error,
    pipelines.shared.rows,
    projects,
    recentRuns,
    refreshSharedAutomations,
    scope.shareInContext,
    scopedActivities,
    sharedAutomations.automations,
    sharedAutomations.error,
    chatTitles,
    allActivities,
  ]);
}
