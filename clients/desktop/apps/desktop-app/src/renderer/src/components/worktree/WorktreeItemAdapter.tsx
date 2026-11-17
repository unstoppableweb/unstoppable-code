import { useCallback, useMemo, type JSX } from 'react';
import type {
  DiffStats,
  RepoBranchInfo,
  SidebarItem,
  WorkspaceDriftSummary,
  WorkspaceRepoData,
  WorktreeData,
  WorktreeDiffStatsStyle,
} from '@canopy/desktop-shared/types';
import type { WorktreeUiStatus } from '@/lib/worktree-status';
import type { WorktreeRowDepthBadge } from '@canopy/ui-shared/components';
import {
  WorktreeItem,
  type BranchGroupingMenuDescriptor,
  type WorktreeTerminalStatus,
} from './WorktreeItem';
import { useScriptsStore } from '@/stores/scriptsStore';
import {
  isWorktreeLaunchActive,
  resolveWorktreeLaunchEntry,
  launchWorktreeFresh,
} from './worktree-launch';
import { useProjectsStore } from '@/stores/projectsStore';
import { resolvePipelineStatus } from './resolvePipelineStatus';

type WorktreeItemDisplayMode = 'list' | 'kanban';

type WorktreeRepoMutation = (
  workspaceId: string,
  worktreeId: string,
  repoId: string,
) => void | Promise<void>;

export interface WorktreeItemCollectionProps {
  worktreeDiffStatsStyle?: WorktreeDiffStatsStyle;
  diffStats: Record<string, DiffStats>;
  uncommittedChanges: Record<string, boolean>;
  commitsAhead: Record<string, boolean>;
  hasUnpushedCommits: Record<string, boolean>;
  baseBranches: Record<string, string | null>;
  hasRemoteTracking: Record<string, boolean>;
  hasBranchBeenPushed: Record<string, boolean>;
  repoBranches: Record<string, RepoBranchInfo[]>;
  workspaceDrift: Record<string, WorkspaceDriftSummary>;
  discoveryLoading: Set<string>;
  selectedWorktreeKey: string | null;
  streamingWorktreeKeys: Set<string>;
  /** Live background tasks by row, for the background spinner (D15). */
  backgroundTaskCounts?: ReadonlyMap<string, number>;
  activeSessionWorktreeKeys: Set<string>;
  awaitingApprovalKeys: Set<string>;
  /** Worktrees with an unanswered interactive agent question (ask-user). */
  pendingQuestionWorktreeKeys: Set<string>;
  toolApprovalWorktreeKeys: Set<string>;
  unreadWorktreeKeys: Set<string>;
  setupRunningWorktrees: Set<string>;
  runRunningWorktrees: Set<string>;
  tearingDownWorktrees: Set<string>;
  archivingWorktrees?: Set<string>;
  pipelineRunningWorktreeKeys: Set<string>;
  pipelineUnseenWorktreeKeys: Set<string>;
  pipelineUnseenFailedWorktreeKeys: Set<string>;
  pipelinePausedWorktreeKeys: Set<string>;
  worktreeStatusMap: Map<string, WorktreeUiStatus>;
  onSelectWorktree: (projectId: string, worktreeId: string) => void;
  onArchiveWorktree: (
    projectId: string,
    worktreeId: string,
    options?: {
      deleteBranch?: boolean;
      expectedBranchName?: string;
      lockAfterArchive?: boolean;
      deleteWithoutRetentionIfMissing?: boolean;
    },
  ) => void;
  onOpenDriftDetails?: (projectId: string, worktreeId: string) => void;
  onAddRepoToWorktree?: WorktreeRepoMutation;
  onRemoveRepoFromWorktree?: WorktreeRepoMutation;
  onCreateBranchWorktree?: (projectId: string, worktreeId: string) => void;
  onDispatchPipeline?: (projectId: string, worktreeId: string) => void;
  /**
   * Open the Add Repo modal for an adhoc multi-repo combine flow. The host
   * (`WorktreeManager`) provides this; the adapter forwards the project id
   * automatically so `WorktreeItem` only sees the worktree id.
   */
  onAddRepoToWorktreeAdhoc?: (projectId: string, worktreeId: string) => void;
  /**
   * Open the Split Workspace modal for a temporary multi-repo workspace
   * worktree. The adapter forwards this to `WorktreeItem` only when the
   * owning workspace is a temporary multi-repo workspace, so hosts can wire
   * it unconditionally.
   */
  onSplitTemporaryWorkspace?: (projectId: string, worktreeId: string) => void;
  onToggleHiddenWorktree?: (
    projectId: string,
    worktreeId: string,
    nextHidden: boolean,
  ) => void;
  /**
   * Persists a per-worktree override for the sidebar branch-grouping behavior.
   * `null` clears the override so the worktree follows the global preference.
   */
  onSetBranchGroupingOverride?: (
    projectId: string,
    worktreeId: string,
    override: 'group' | 'ungroup' | null,
  ) => Promise<void>;
  baseBranchExistsLocally?: Record<string, boolean>;
  baseBranchExistsInRemote?: Record<string, boolean>;
}

interface WorktreeItemTerminalActivityProps {
  terminalRunningWorktreeKeys: Set<string>;
  terminalUnseenWorktreeKeys: Set<string>;
  terminalUnseenFailureWorktreeKeys: Set<string>;
}

export type WorktreeItemAdapterBaseProps = WorktreeItemCollectionProps &
  WorktreeItemTerminalActivityProps;

interface WorktreeItemAdapterProps extends WorktreeItemAdapterBaseProps {
  project: SidebarItem;
  worktree: WorktreeData;
  worktreeKey: string;
  displayMode?: WorktreeItemDisplayMode;
  /**
   * Branch-grouping context-menu item for this worktree, fully described by the
   * host. Present only when grouping is meaningful for the worktree.
   */
  branchGroupingMenu?: BranchGroupingMenuDescriptor;
  /** Depth badge for this worktree, computed by the host from ancestry. */
  depthBadge?: WorktreeRowDepthBadge;
  /** Indent row content while preserving the full-width row surface. */
  nested?: boolean;
  /** Branch-ancestry depth when rendered as a nested child. */
  nestedChildDepth?: number;
  /** Remove drag bindings for copies rendered outside the worktree DndContext. */
  disableSortable?: boolean;
  /** Render as a pinned selected-item copy (see WorktreeItem.pinnedCopy). */
  pinnedCopy?: boolean;
  /** Pin surface used to suffix descendant automation ids. */
  pinnedSurface?: 'pin-top' | 'pin-bottom';
}

function getConfigRepos(project: SidebarItem): WorkspaceRepoData[] | undefined {
  if (project.type === 'multi-repo') {
    return project.repos;
  }
  return undefined;
}

function resolveTerminalStatus({
  worktreeKey,
  terminalRunningWorktreeKeys,
  terminalUnseenWorktreeKeys,
  terminalUnseenFailureWorktreeKeys,
}: Pick<
  WorktreeItemTerminalActivityProps,
  | 'terminalRunningWorktreeKeys'
  | 'terminalUnseenWorktreeKeys'
  | 'terminalUnseenFailureWorktreeKeys'
> & {
  worktreeKey: string;
}): WorktreeTerminalStatus | undefined {
  if (terminalRunningWorktreeKeys.has(worktreeKey)) {
    return 'running';
  }
  if (terminalUnseenFailureWorktreeKeys.has(worktreeKey)) {
    return 'unseen-failure';
  }
  if (terminalUnseenWorktreeKeys.has(worktreeKey)) {
    return 'unseen';
  }
  return undefined;
}

export function WorktreeItemAdapter({
  project,
  worktree,
  worktreeKey,
  displayMode = 'list',
  worktreeDiffStatsStyle = 'short',
  diffStats,
  uncommittedChanges,
  commitsAhead,
  hasUnpushedCommits,
  baseBranches,
  hasRemoteTracking,
  hasBranchBeenPushed,
  repoBranches,
  workspaceDrift,
  discoveryLoading,
  selectedWorktreeKey,
  streamingWorktreeKeys,
  backgroundTaskCounts,
  activeSessionWorktreeKeys,
  awaitingApprovalKeys,
  pendingQuestionWorktreeKeys,
  toolApprovalWorktreeKeys,
  unreadWorktreeKeys,
  setupRunningWorktrees,
  runRunningWorktrees,
  tearingDownWorktrees,
  archivingWorktrees,
  pipelineRunningWorktreeKeys,
  pipelineUnseenWorktreeKeys,
  pipelineUnseenFailedWorktreeKeys,
  pipelinePausedWorktreeKeys,
  terminalRunningWorktreeKeys,
  terminalUnseenWorktreeKeys,
  terminalUnseenFailureWorktreeKeys,
  worktreeStatusMap,
  onSelectWorktree,
  onArchiveWorktree,
  onOpenDriftDetails,
  onAddRepoToWorktree,
  onRemoveRepoFromWorktree,
  onCreateBranchWorktree,
  onDispatchPipeline,
  onAddRepoToWorktreeAdhoc,
  onSplitTemporaryWorkspace,
  onToggleHiddenWorktree,
  baseBranchExistsLocally,
  baseBranchExistsInRemote,
  branchGroupingMenu,
  depthBadge,
  nested,
  nestedChildDepth,
  disableSortable,
  pinnedCopy,
  pinnedSurface,
}: WorktreeItemAdapterProps): JSX.Element {
  const isMultiRepo = project.type === 'multi-repo';
  const appliedProjectWorktreeScripts = useProjectsStore(
    (state) => state.appliedProjectWorktreeScripts,
  );
  const worktreeScriptRuns = useScriptsStore(
    (state) => state.runs[worktreeKey],
  );
  const launchEntry = useMemo(
    () =>
      resolveWorktreeLaunchEntry(
        project,
        worktree.id,
        appliedProjectWorktreeScripts,
      ),
    [appliedProjectWorktreeScripts, project, worktree.id],
  );
  const hasActiveLaunchRun = useMemo(
    (): boolean => isWorktreeLaunchActive(launchEntry, worktreeScriptRuns),
    [launchEntry, worktreeScriptRuns],
  );
  // CAN-6933: a local load carries no per-worktree scripts; opening the menu
  // reads this worktree's, so a branch-only launch command shows up.
  const handleActionsMenuOpen = useCallback((): void => {
    void useProjectsStore
      .getState()
      .ensureWorktreeEffective(project.id, [worktree.id]);
  }, [project.id, worktree.id]);
  const handleLaunchWorktree = useCallback((): void => {
    if (!launchEntry || hasActiveLaunchRun) {
      return;
    }
    void launchWorktreeFresh(project.id, worktree.id);
  }, [hasActiveLaunchRun, launchEntry, project.id, worktree.id]);
  const pipelineStatus = resolvePipelineStatus({
    worktreeKey,
    pipelineRunningWorktreeKeys,
    pipelineUnseenWorktreeKeys,
    pipelineUnseenFailedWorktreeKeys,
    pipelinePausedWorktreeKeys,
  });
  const terminalStatus = resolveTerminalStatus({
    worktreeKey,
    terminalRunningWorktreeKeys,
    terminalUnseenWorktreeKeys,
    terminalUnseenFailureWorktreeKeys,
  });

  return (
    <WorktreeItem
      worktree={worktree}
      projectId={project.id}
      uiStatus={worktreeStatusMap.get(worktreeKey) ?? 'idle'}
      displayMode={displayMode}
      worktreeDiffStatsStyle={worktreeDiffStatsStyle}
      depthBadge={depthBadge}
      nested={nested}
      nestedChildDepth={nestedChildDepth}
      disableSortable={disableSortable}
      pinnedCopy={pinnedCopy}
      pinnedSurface={pinnedSurface}
      stats={diffStats[worktreeKey]}
      hasUncommittedChanges={uncommittedChanges[worktreeKey]}
      hasCommitsAhead={commitsAhead[worktreeKey]}
      hasUnpushedCommits={hasUnpushedCommits[worktreeKey]}
      isSelected={selectedWorktreeKey === worktreeKey}
      isStreaming={streamingWorktreeKeys.has(worktreeKey)}
      backgroundTasks={backgroundTaskCounts?.get(worktreeKey) ?? 0}
      hasActiveSession={activeSessionWorktreeKeys.has(worktreeKey)}
      awaitingApproval={awaitingApprovalKeys.has(worktreeKey)}
      hasPendingQuestion={pendingQuestionWorktreeKeys.has(worktreeKey)}
      hasPendingToolApproval={toolApprovalWorktreeKeys.has(worktreeKey)}
      hasUnread={unreadWorktreeKeys.has(worktreeKey)}
      isDiscovering={discoveryLoading.has(worktreeKey)}
      isRunningSetup={setupRunningWorktrees.has(worktreeKey)}
      isRunningRun={runRunningWorktrees.has(worktreeKey)}
      isTearingDown={tearingDownWorktrees.has(worktreeKey)}
      isArchiveInProgress={archivingWorktrees?.has(worktreeKey) ?? false}
      pipelineStatus={pipelineStatus}
      terminalStatus={terminalStatus}
      isMultiRepo={isMultiRepo}
      driftSummary={workspaceDrift[worktreeKey]}
      hasRemoteTracking={hasRemoteTracking[worktreeKey]}
      hasBranchBeenPushed={hasBranchBeenPushed[worktreeKey]}
      repoBranches={repoBranches[worktreeKey]}
      configRepos={getConfigRepos(project)}
      onSelect={onSelectWorktree}
      onArchive={(worktreeId, options): void =>
        onArchiveWorktree(project.id, worktreeId, options)
      }
      onOpenDriftDetails={onOpenDriftDetails}
      onAddRepoToWorktree={
        onAddRepoToWorktree
          ? (worktreeId, repoId): void | Promise<void> =>
              onAddRepoToWorktree(project.id, worktreeId, repoId)
          : undefined
      }
      onRemoveRepoFromWorktree={
        onRemoveRepoFromWorktree
          ? (worktreeId, repoId): void | Promise<void> =>
              onRemoveRepoFromWorktree(project.id, worktreeId, repoId)
          : undefined
      }
      onCreateBranchWorktree={
        onCreateBranchWorktree
          ? (worktreeId): void => onCreateBranchWorktree(project.id, worktreeId)
          : undefined
      }
      onDispatchPipeline={
        onDispatchPipeline
          ? (worktreeId): void => onDispatchPipeline(project.id, worktreeId)
          : undefined
      }
      onLaunch={launchEntry ? handleLaunchWorktree : undefined}
      onActionsMenuOpen={handleActionsMenuOpen}
      isLaunchActive={hasActiveLaunchRun}
      onAddRepoToWorktreeAdhoc={
        onAddRepoToWorktreeAdhoc
          ? (worktreeId): void =>
              onAddRepoToWorktreeAdhoc(project.id, worktreeId)
          : undefined
      }
      onSplitWorkspace={
        onSplitTemporaryWorkspace &&
        project.type === 'multi-repo' &&
        project.temporary === true
          ? (worktreeId): void =>
              onSplitTemporaryWorkspace(project.id, worktreeId)
          : undefined
      }
      onToggleHidden={
        onToggleHiddenWorktree
          ? (worktreeId, nextHidden): void =>
              onToggleHiddenWorktree(project.id, worktreeId, nextHidden)
          : undefined
      }
      branchGroupingMenu={branchGroupingMenu}
      baseBranch={isMultiRepo ? undefined : baseBranches[worktreeKey]}
      baseBranchExistsLocally={
        isMultiRepo ? undefined : baseBranchExistsLocally?.[worktreeKey]
      }
      baseBranchExistsInRemote={
        isMultiRepo ? undefined : baseBranchExistsInRemote?.[worktreeKey]
      }
    />
  );
}
