import { Count } from '@canopy/ui-shared/primitives/Badge';
import { useCallback, useEffect, useState, type JSX } from 'react';
import { WORKTREE_UNIT_LABEL_PLURAL } from '@canopy/protocol';
import type { SidebarItem, WorktreeData } from '@canopy/desktop-shared/types';
import {
  WORKTREE_STATUS_META,
  WORKTREE_UI_STATUSES,
  type WorktreeUiStatus,
} from '@/lib/worktree-status';
import {
  WorktreeItemAdapter,
  type WorktreeItemAdapterBaseProps,
  type WorktreeItemCollectionProps,
} from './WorktreeItemAdapter';
import { getWorktreeRecordKey } from './worktree-record-key';
import { WorktreeStatusIndicator } from './WorktreeStatusIndicator';
import { useTerminalActivityStore } from '@/stores/terminalActivityStore';
import { useDragToScroll } from '@/hooks/useDragToScroll';
import { EyeOffIcon } from '@canopy/ui-shared/icons';
import { Stack, Disclosure, Surface } from '@canopy/ui-shared/components';
import { getWorkspaceDisplayName } from '@/lib/workspaceDisplayName';
import { ProjectIcon } from '../shared/ProjectIcon';
import {
  shouldShowWorktreeMergedState,
  useGitHubStore,
} from '@/stores/githubStore';
import { POSTHOG_REPLAY_MASK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';

interface WorktreeKanbanBoardProps extends WorktreeItemCollectionProps {
  visibleProjects: SidebarItem[];
  onWorktreeDoubleClick?: (projectId: string, worktreeId: string) => void;
}

interface KanbanCard {
  project: SidebarItem;
  worktree: WorktreeData;
}

interface ProjectLabelProps {
  project: SidebarItem;
}

function ProjectLabel({ project }: ProjectLabelProps): JSX.Element {
  const isMultiRepo = project.type === 'multi-repo';
  const displayName = getWorkspaceDisplayName(project);
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 truncate text-3xs font-medium fg-secondary">
      <ProjectIcon
        kind={isMultiRepo ? 'multi-repo' : 'single-repo'}
        temporary={isMultiRepo && project.temporary === true}
        color={project.color}
        repoPath={project.type === 'single-repo' ? project.repoPath : undefined}
        size="sm"
      />
      <span className={`${POSTHOG_REPLAY_MASK_CLASS} truncate`}>
        {displayName}
      </span>
    </span>
  );
}

interface KanbanStatusIndicatorProps {
  uiStatus: WorktreeUiStatus;
  projectId: string;
  worktree: WorktreeData;
  isRunningSetup: boolean;
  isTearingDown: boolean;
  isPendingGitSetup: boolean;
  isStreaming: boolean;
  backgroundTasks: number;
}

function KanbanStatusIndicator({
  uiStatus,
  projectId,
  worktree,
  isRunningSetup,
  isTearingDown,
  isPendingGitSetup,
  isStreaming,
  backgroundTasks,
}: KanbanStatusIndicatorProps): JSX.Element {
  const prStatus = useGitHubStore(
    (state) => state.prStatuses[getWorktreeRecordKey(projectId, worktree.id)],
  );
  const effectivePrStatus =
    prStatus === undefined ? worktree.lastKnownPrStatus : prStatus;
  const merged = shouldShowWorktreeMergedState(
    worktree.status,
    effectivePrStatus,
  );

  return (
    <WorktreeStatusIndicator
      uiStatus={uiStatus}
      isRunningSetup={isRunningSetup}
      isTearingDown={isTearingDown}
      isPendingGitSetup={isPendingGitSetup}
      isStreaming={isStreaming}
      backgroundTasks={backgroundTasks}
      doneLabel={merged ? 'PR merged' : 'Done'}
      merged={merged}
    />
  );
}

export function WorktreeKanbanBoard({
  visibleProjects,
  onWorktreeDoubleClick,
  ...worktreeItemProps
}: WorktreeKanbanBoardProps): JSX.Element {
  const scrollSelectedIntoView = useCallback(
    (node: HTMLDivElement | null): void => {
      if (node) {
        node.scrollIntoView({
          block: 'nearest',
          inline: 'nearest',
          behavior: 'smooth',
        });
      }
    },
    [],
  );

  const { ref: dragScrollRef } = useDragToScroll<HTMLDivElement>();

  const terminalRunningWorktreeKeys = useTerminalActivityStore(
    (state) => state.runningWorktreeKeys,
  );
  const terminalUnseenWorktreeKeys = useTerminalActivityStore(
    (state) => state.unseenWorktreeKeys,
  );
  const terminalUnseenFailureWorktreeKeys = useTerminalActivityStore(
    (state) => state.unseenFailureWorktreeKeys,
  );
  const adapterProps: WorktreeItemAdapterBaseProps = {
    ...worktreeItemProps,
    terminalRunningWorktreeKeys,
    terminalUnseenWorktreeKeys,
    terminalUnseenFailureWorktreeKeys,
  };

  const [hiddenExpandedByStatus, setHiddenExpandedByStatus] = useState<
    Record<WorktreeUiStatus, boolean>
  >({
    idle: false,
    planning: false,
    working: false,
    unread: false,
    done: false,
  });

  const allCards: KanbanCard[] = visibleProjects.flatMap((project) =>
    project.type === 'cowork'
      ? []
      : project.worktrees.map((worktree) => ({ project, worktree })),
  );

  const buckets: Record<WorktreeUiStatus, KanbanCard[]> = {
    idle: [],
    planning: [],
    working: [],
    unread: [],
    done: [],
  };

  for (const card of allCards) {
    const key = getWorktreeRecordKey(card.project.id, card.worktree.id);
    const status = adapterProps.worktreeStatusMap.get(key) ?? 'idle';
    buckets[status].push(card);
  }

  for (const status of WORKTREE_UI_STATUSES) {
    buckets[status].sort((a, b) => {
      if (a.worktree.createdAt === b.worktree.createdAt) {
        return 0;
      }
      return a.worktree.createdAt < b.worktree.createdAt ? 1 : -1;
    });
  }

  const visibleBuckets: Record<WorktreeUiStatus, KanbanCard[]> = {
    idle: [],
    planning: [],
    working: [],
    unread: [],
    done: [],
  };
  const hiddenBuckets: Record<WorktreeUiStatus, KanbanCard[]> = {
    idle: [],
    planning: [],
    working: [],
    unread: [],
    done: [],
  };
  for (const status of WORKTREE_UI_STATUSES) {
    for (const card of buckets[status]) {
      if (card.worktree.hidden) {
        hiddenBuckets[status].push(card);
      } else {
        visibleBuckets[status].push(card);
      }
    }
  }

  let hiddenSelectedStatus: WorktreeUiStatus | null = null;
  if (adapterProps.selectedWorktreeKey) {
    for (const status of WORKTREE_UI_STATUSES) {
      const matched = hiddenBuckets[status].some(
        (card) =>
          getWorktreeRecordKey(card.project.id, card.worktree.id) ===
          adapterProps.selectedWorktreeKey,
      );
      if (matched) {
        hiddenSelectedStatus = status;
        break;
      }
    }
  }
  useEffect(() => {
    if (!hiddenSelectedStatus) {
      return;
    }
    setHiddenExpandedByStatus((prev) =>
      prev[hiddenSelectedStatus]
        ? prev
        : { ...prev, [hiddenSelectedStatus]: true },
    );
  }, [hiddenSelectedStatus]);

  const renderCard = (
    status: WorktreeUiStatus,
    { project, worktree }: KanbanCard,
  ): JSX.Element => {
    const wtKey = getWorktreeRecordKey(project.id, worktree.id);
    const isSelected = adapterProps.selectedWorktreeKey === wtKey;
    const isRunningSetup = adapterProps.setupRunningWorktrees.has(wtKey);
    const isTearingDown = adapterProps.tearingDownWorktrees.has(wtKey);
    const isPendingGitSetup = worktree.setupPhase === 'git-pending';
    const isStreaming = adapterProps.streamingWorktreeKeys.has(wtKey);
    const backgroundTasks = adapterProps.backgroundTaskCounts?.get(wtKey) ?? 0;

    return (
      <Surface variant="group" size="small" key={wtKey}>
        <div
          className="flex flex-col gap-1 cursor-pointer p-1.5"
          ref={isSelected ? scrollSelectedIntoView : null}
          data-testid={`worktree-kanban-card-${wtKey}`}
          onClick={(): void =>
            adapterProps.onSelectWorktree(project.id, worktree.id)
          }
          onDoubleClick={(): void =>
            onWorktreeDoubleClick?.(project.id, worktree.id)
          }
        >
          <div className="flex items-center justify-between gap-2 px-1">
            <ProjectLabel project={project} />
            <KanbanStatusIndicator
              uiStatus={status}
              projectId={project.id}
              worktree={worktree}
              isRunningSetup={isRunningSetup}
              isTearingDown={isTearingDown}
              isPendingGitSetup={isPendingGitSetup}
              isStreaming={isStreaming}
              backgroundTasks={backgroundTasks}
            />
          </div>
          <div
            onClick={(event): void => {
              event.stopPropagation();
            }}
          >
            <WorktreeItemAdapter
              {...adapterProps}
              worktreeKey={wtKey}
              project={project}
              worktree={worktree}
              displayMode="kanban"
            />
          </div>
        </div>
      </Surface>
    );
  };

  return (
    <div
      ref={dragScrollRef}
      className="flex h-full min-h-0 gap-3 overflow-x-auto pb-2"
      data-testid="worktree-kanban-board"
    >
      {WORKTREE_UI_STATUSES.map((status) => {
        const meta = WORKTREE_STATUS_META[status];
        const visibleCards = visibleBuckets[status];
        const hiddenCards = hiddenBuckets[status];
        const hiddenExpanded = hiddenExpandedByStatus[status];
        return (
          <Surface
            key={status}
            as="section"
            variant="group"
            size="small"
            className="flex flex-col min-w-65 flex-1 shrink-0"
            data-testid={`worktree-kanban-column-${status}`}
            aria-label={`${meta.label} column`}
          >
            <Surface
              as="header"
              variant="section"
              boundary="bottom"
              gap="inline"
              direction="row"
              padding="board-header"
              className="items-center justify-between"
            >
              <div className="flex items-center gap-1.5">
                <svg
                  viewBox="0 0 24 6"
                  className={`h-1.5 w-6 ${meta.columnAccent}`}
                  aria-hidden="true"
                >
                  <rect width="24" height="6" rx="3" fill="currentColor" />
                </svg>
                <span className={`text-2xs font-semibold ${meta.columnAccent}`}>
                  {meta.label}
                </span>
              </div>
              <Count value={visibleCards.length} />
            </Surface>
            <div
              className={`flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-1.5 pb-1.5 [&>*]:shrink-0 ${visibleCards.length === 0 && hiddenCards.length > 0 ? 'pt-2.5' : 'pt-1.5'}`}
            >
              {visibleCards.length === 0 && hiddenCards.length === 0 ? (
                <p className="px-1.5 py-3 text-center text-2xs fg-secondary/70">
                  No worktrees
                </p>
              ) : (
                visibleCards.length > 0 && (
                  <Stack gap="tight">
                    {visibleCards.map((card) => renderCard(status, card))}
                  </Stack>
                )
              )}
              {hiddenCards.length > 0 && (
                <Disclosure
                  label={`Hidden ${WORKTREE_UNIT_LABEL_PLURAL}`}
                  leadingIcon={<EyeOffIcon size="sm" />}
                  meta={hiddenCards.length}
                  open={hiddenExpanded}
                  onOpenChange={(next): void =>
                    setHiddenExpandedByStatus((prev) => ({
                      ...prev,
                      [status]: next,
                    }))
                  }
                  dataTestId="hidden-worktrees-section"
                  className=""
                >
                  <Stack gap="tight">
                    {hiddenCards.map((card) => renderCard(status, card))}
                  </Stack>
                </Disclosure>
              )}
            </div>
          </Surface>
        );
      })}
    </div>
  );
}
