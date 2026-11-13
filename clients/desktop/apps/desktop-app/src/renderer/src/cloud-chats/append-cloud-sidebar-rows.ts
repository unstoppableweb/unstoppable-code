import type { SessionViewModel } from '@canopy/app-core';
import type { CoreCoworkSidebarRows } from '@canopy/app-state/core-cowork';

/**
 * The sidebar snapshot with the cloud projects after the local ones. Cloud
 * order is its own (the web core's listing order), so the cloud rows keep it
 * as one block below every local project.
 */
type SidebarRows = Pick<SessionViewModel, 'workspaces' | 'worktrees'>;

export function appendCloudSidebarRows(
  snapshot: SidebarRows,
  cloud: CoreCoworkSidebarRows,
): SidebarRows {
  if (cloud.workspaces.length === 0)
    return { workspaces: snapshot.workspaces, worktrees: snapshot.worktrees };
  const orderFrom =
    snapshot.workspaces.reduce(
      (highest, workspace) => Math.max(highest, workspace.order ?? 0),
      -1,
    ) + 1;
  return {
    workspaces: [
      ...snapshot.workspaces,
      ...cloud.workspaces.map((workspace) => ({
        ...workspace,
        order: orderFrom + (workspace.order ?? 0),
      })),
    ],
    worktrees: [...snapshot.worktrees, ...cloud.worktrees],
  };
}
