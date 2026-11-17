'use client';

import { type JSX, type ReactNode } from 'react';
import { useActivityStore, useCapabilities } from '@canopy/app-state';
import { Surface, Button } from '@canopy/ui-shared/components';
import { WorkspacesSidebarSections } from './WorkspacesSidebarSections';
import { SidebarChrome } from './sidebar';
import { partitionWorkspaces } from './workspace-sections-model';
import type {
  WorktreeCreateOptions,
  WorktreeCreateResult,
} from '@canopy/app-core';

/**
 * The write-once worktree sidebar for the Code tab — unifies the desktop
 * `WorktreeManager` sidebar and the web `PortalWorkspaceRail` over the neutral
 * shell snapshot (`useActivityStore().snapshot`). Renders workspace sections
 * (shared `WorkspaceSectionHeader`) each containing their worktrees (shared
 * `WorktreeRow`), with selection + collapse.
 *
 * Worktree sections and mutations are delegated to
 * {@link WorkspacesSidebarSections}; this wrapper owns only shell chrome and
 * top-level actions.
 */
export interface WorktreeSidebarProps {
  readonly selectedWorktreeLocalId?: string;
  readonly onSelectWorktree: (
    workspaceLocalId: string,
    worktreeLocalId: string,
  ) => void;
  /**
   * Host-owned worktree creation dispatch. `options.worktreeId` is the
   * surface's claimed id, sent only for a workspace that publishes
   * `worktreeIdClaimPrefix`; the host's own id stays authoritative.
   */
  readonly onAddWorktree?: (
    workspaceLocalId: string,
    options?: WorktreeCreateOptions,
  ) => Promise<WorktreeCreateResult> | void;
  /** Host-owned navigation rows rendered after the worktree sections. */
  readonly navigationExtension?: ReactNode;
  /** Workspace-level entry points owned by the host. */
  readonly workspaceActions?: ReactNode;
  readonly onAddWorkspace?: () => void;
  readonly onCreateTask?: () => void;
  /** Enlarges interactive targets without prescribing a responsive layout. */
  readonly touchTargets?: boolean;
}

export function WorktreeSidebar({
  selectedWorktreeLocalId,
  onSelectWorktree,
  onAddWorktree,
  navigationExtension,
  workspaceActions,
  onAddWorkspace,
  onCreateTask,
  touchTargets = false,
}: WorktreeSidebarProps): JSX.Element {
  const snapshot = useActivityStore((state) => state.snapshot);
  const capabilities = useCapabilities();
  const workspacePartitions = partitionWorkspaces(
    snapshot?.workspaces ?? [],
    snapshot?.worktrees ?? [],
  );
  const hasGitWorkspaces =
    workspacePartitions.visible.length > 0 ||
    workspacePartitions.hidden.length > 0;

  if (
    !hasGitWorkspaces &&
    !navigationExtension &&
    !workspaceActions &&
    !onAddWorkspace &&
    !onCreateTask
  ) {
    return (
      <div
        className="px-4 py-6 text-center text-xs fg-secondary"
        data-testid="worktree-sidebar-empty"
      >
        No projects.
      </div>
    );
  }

  // A selected worktree that has not reached the snapshot yet (first-load
  // race) resolves to the canonical no-selection sentinel rather than a
  // fabricated empty workspace id.
  const selectedWorkspaceLocalId = selectedWorktreeLocalId
    ? snapshot?.worktrees.find(
        (worktree) => worktree.localId === selectedWorktreeLocalId,
      )?.workspaceLocalId
    : undefined;
  const selectedTarget =
    selectedWorktreeLocalId && selectedWorkspaceLocalId
      ? {
          kind: 'worktree' as const,
          workspaceLocalId: selectedWorkspaceLocalId,
          worktreeLocalId: selectedWorktreeLocalId,
        }
      : null;

  return (
    <SidebarChrome
      width="full"
      density={touchTargets ? 'touch' : 'default'}
      data-testid="worktree-sidebar"
    >
      {(workspaceActions || onAddWorkspace || onCreateTask) && (
        <Surface variant="section" boundary="bottom">
          <div
            className="flex flex-wrap gap-2 p-2"
            data-testid="worktree-sidebar-actions"
          >
            {workspaceActions}
            {onAddWorkspace && (
              <Button size="compact" onClick={onAddWorkspace}>
                Add project
              </Button>
            )}
            {onCreateTask && (
              <Button size="compact" onClick={onCreateTask}>
                Create task
              </Button>
            )}
          </div>
        </Surface>
      )}
      {!hasGitWorkspaces && (
        <div
          className="px-4 py-6 text-center text-xs fg-secondary"
          data-testid="worktree-sidebar-empty"
        >
          No projects.
        </div>
      )}
      {snapshot && (
        <WorkspacesSidebarSections
          state={snapshot}
          capabilities={capabilities}
          selected={selectedTarget}
          onSelectWorktree={onSelectWorktree}
          creationEnabled={onAddWorktree !== undefined}
          onCreateWorktree={async (
            workspaceLocalId,
            _groupId,
            options,
          ): Promise<WorktreeCreateResult> =>
            // A host that names the created id passes it through, so the
            // pending row follows the host's id, not snapshot-diff adoption.
            (await onAddWorktree?.(workspaceLocalId, options)) ?? {
              status: 'pending',
            }
          }
          touchTargets={touchTargets}
          testIds={{ workspace: 'worktree-sidebar-workspace' }}
        />
      )}
      {navigationExtension}
    </SidebarChrome>
  );
}
