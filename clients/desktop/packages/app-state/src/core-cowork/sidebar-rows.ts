import type { PortalSessionShellState } from '@canopy/protocol/portal';
import type {
  CoreCoworkProject,
  CoreCoworkTask,
} from './create-core-cowork-store';

type ShellWorkspace = PortalSessionShellState['workspaces'][number];
type ShellWorktree = PortalSessionShellState['worktrees'][number];

/** The branch a repoless cloud task row carries, as the web projects it. */
export const CORE_COWORK_TASK_BRANCH = 'cloud';

export interface CoreCoworkSidebarRows {
  readonly workspaces: readonly ShellWorkspace[];
  readonly worktrees: readonly ShellWorktree[];
}

export interface CoreCoworkSidebarRowsOptions {
  /**
   * The host's row id for a cloud id. Cloud ids carry their authority
   * (CAN-4185 D6), so a host never mistakes a cloud row for a local one.
   */
  readonly scopeId: (id: string) => string;
  /** Collapsed projects, by scoped project id. */
  readonly collapsed?: Readonly<Record<string, true>>;
  /** The first `order` the cloud projects take, after the host's own rows. */
  readonly orderFrom?: number;
}

/**
 * Cloud projects and their tasks as sidebar snapshot rows, the shape the web
 * projects cloud workspaces in: tree layout, cloud backend, each live task a
 * worktree row (REG-2819). Archived tasks are left out. A repository project
 * is listed with no rows; its tasks are not task-listed (CAN-6100).
 */
export function coreCoworkSidebarRows(
  projects: readonly CoreCoworkProject[],
  tasksByProject: Readonly<Record<string, readonly CoreCoworkTask[]>>,
  { scopeId, collapsed = {}, orderFrom = 0 }: CoreCoworkSidebarRowsOptions,
): CoreCoworkSidebarRows {
  const workspaces: ShellWorkspace[] = [];
  const worktrees: ShellWorktree[] = [];
  projects.forEach((project, index) => {
    const workspaceLocalId = scopeId(project.workspaceId);
    workspaces.push({
      localId: workspaceLocalId,
      name: project.name,
      type: project.kind === 'git' ? 'single-repo' : 'cowork',
      layout: 'tree',
      backend: 'cloud',
      ...(project.color === undefined ? {} : { color: project.color }),
      ...(project.ownerOrganizationId === null
        ? {}
        : {
            owner: {
              type: 'cloud-organization',
              organizationId: project.ownerOrganizationId.toLowerCase(),
            },
          }),
      order: orderFrom + index,
      collapsed: collapsed[workspaceLocalId] === true,
      itemSortMode: 'last-updated',
    });
    if (project.kind !== 'cowork') return;
    (tasksByProject[project.key] ?? [])
      .filter((task) => task.state !== 'archived')
      .forEach((task, taskIndex) => {
        worktrees.push({
          localId: scopeId(task.worktreeId),
          workspaceLocalId,
          branch: CORE_COWORK_TASK_BRANCH,
          backend: 'cloud',
          label: task.title,
          order: taskIndex,
          lastActivityAt: task.updatedAt,
          ...(task.state === 'running' || task.state === 'queued'
            ? { isStreaming: true }
            : {}),
          ...(task.state === 'awaiting_user' ? { awaitingApproval: true } : {}),
        });
      });
  });
  return { workspaces, worktrees };
}
