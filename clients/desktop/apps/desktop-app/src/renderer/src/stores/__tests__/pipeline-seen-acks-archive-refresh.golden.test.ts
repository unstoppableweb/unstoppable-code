/** @jest-environment jsdom */
import '../../cloud-chats/__tests__/jsdom-globals';
import type { SingleRepoSidebarItem } from '@canopy/desktop-shared/types';
import { usePipelineRunsStore } from '../pipelineRunsStore';
import { useProjectsStore } from '../projectsStore';

const KEY = 'storefront/csv-export';

const ACKNOWLEDGED_FAILURE = {
  id: 'exec-acked-failure',
  pipeline_id: 'deploy-check',
  pipeline_name: 'Deploy Check',
  status: 'failure',
  started_at: '2026-11-26T00:00:00.000Z',
  completed_at: '2026-11-26T00:05:00.000Z',
  cwd: '/repos/storefront/csv-export',
  project_id: 'storefront',
  worktree_id: 'csv-export',
};

function storefront(seen: string[]): SingleRepoSidebarItem {
  return {
    type: 'single-repo',
    id: 'storefront',
    name: 'storefront',
    repoPath: '/repos/storefront',
    color: '#3B82F6',
    collapsed: false,
    order: 0,
    worktrees: [
      {
        id: 'csv-export',
        branchName: 'csv-export',
        createdAt: '2026-11-26T00:00:00.000Z',
        seenPipelineExecutionIds: seen,
      },
    ],
  };
}

function seenIds(): string[] | undefined {
  const project = useProjectsStore.getState().projects[0];
  if (project?.type === 'cowork') return undefined;
  return project?.worktrees[0]?.seenPipelineExecutionIds;
}

describe('saved pipeline acknowledgments across archive-triggered status refreshes (CAN-7945)', () => {
  const previousPipelines = window.pipelines;
  let history: Array<typeof ACKNOWLEDGED_FAILURE>;
  const saveProjects = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    history = [];
    saveProjects.mockClear();
    Object.defineProperty(window, 'pipelines', {
      configurable: true,
      writable: true,
      value: {
        ...(previousPipelines ?? {}),
        listExecutions: jest.fn(() =>
          Promise.resolve({ success: true, data: history }),
        ),
        listAdvisorSnapshots: jest
          .fn()
          .mockResolvedValue({ success: true, data: {} }),
      },
    });
    useProjectsStore.setState({
      projects: [storefront([ACKNOWLEDGED_FAILURE.id])],
      saveProjects,
    });
    usePipelineRunsStore.setState({
      pipelineSummariesByWorktree: {},
      pausedExecutionsByWorktree: {},
      runningExecutionsByWorktree: {},
      unseenPipelineWorktreeKeys: new Set<string>(),
      unseenFailedPipelineWorktreeKeys: new Set<string>(),
      isHydratingGlobalPipelineStatuses: false,
      hasHydratedGlobalPipelineStatuses: false,
    });
  });

  afterAll(() => {
    Object.defineProperty(window, 'pipelines', {
      configurable: true,
      writable: true,
      value: previousPipelines,
    });
  });

  it('keeps an acknowledged failure seen when its file was unreadable during the refresh', async () => {
    // The history read skips the unreadable execution file and still succeeds.
    await usePipelineRunsStore
      .getState()
      .refreshGlobalPipelineStatusesKeepingSeen();
    expect(seenIds()).toEqual([ACKNOWLEDGED_FAILURE.id]);
    expect(saveProjects).not.toHaveBeenCalled();

    history = [ACKNOWLEDGED_FAILURE];
    await usePipelineRunsStore
      .getState()
      .refreshGlobalPipelineStatusesKeepingSeen();
    const state = usePipelineRunsStore.getState();
    expect(state.unseenFailedPipelineWorktreeKeys.has(KEY)).toBe(false);
    expect(state.unseenPipelineWorktreeKeys.has(KEY)).toBe(false);
  });

  it('a full status load still prunes acknowledgments whose executions are gone', async () => {
    await usePipelineRunsStore.getState().loadGlobalPipelineStatuses();
    expect(seenIds()).toBeUndefined();
    expect(saveProjects).toHaveBeenCalledTimes(1);
  });

  it('a full load queued behind an in-flight refresh still prunes', async () => {
    const refresh = usePipelineRunsStore
      .getState()
      .refreshGlobalPipelineStatusesKeepingSeen();
    const load = usePipelineRunsStore.getState().loadGlobalPipelineStatuses();
    await Promise.all([refresh, load]);
    expect(seenIds()).toBeUndefined();
  });
});
