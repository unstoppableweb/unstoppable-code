import type {
  DesktopOrgProjectCatalogSnapshot,
  WorkspaceContext,
} from '@canopy/desktop-shared/types';
import { serializeWorkspaceContext } from '@canopy/protocol/workspace-context';
import {
  deriveOrgProjectPlaceholderState,
  isOrgProjectCatalogSetupSupported,
  orgProjectPlaceholderLocalId,
} from '@canopy/protocol/org-projects';
import type { RemoteControlSessionShellState } from '@canopy/protocol/remote-control/shell';

/** Pure projection: catalog rows never pass through workspace discovery or persistence. */
export function appendOrgProjectPlaceholderRows(
  rows: RemoteControlSessionShellState['workspaces'],
  snapshot: DesktopOrgProjectCatalogSnapshot,
  context: WorkspaceContext,
): RemoteControlSessionShellState['workspaces'] {
  if (
    context.kind !== 'organization' ||
    snapshot.error === 'unavailable' ||
    snapshot.context !== serializeWorkspaceContext(context)
  )
    return rows;
  const bound = new Set(
    rows.flatMap((row) =>
      row.owner?.type === 'organization' ? [row.owner.projectId] : [],
    ),
  );
  const placeholders: RemoteControlSessionShellState['workspaces'] = [];
  for (const project of snapshot.projects) {
    if (
      project.organizationId !== context.organizationId ||
      !project.listed ||
      project.state !== 'ACTIVE' ||
      project.instance?.state === 'READY' ||
      // A converted multi-repo project (CAN-3532) shows only where it is bound.
      !isOrgProjectCatalogSetupSupported(project) ||
      bound.has(project.id)
    )
      continue;
    bound.add(project.id);
    placeholders.push({
      localId: orgProjectPlaceholderLocalId(project.id),
      name: project.name,
      type: 'single-repo',
      backend: 'desktop',
      owner: {
        type: 'organization',
        organizationId: context.organizationId,
        projectId: project.id,
      },
      placeholder: {
        projectId: project.id,
        state: deriveOrgProjectPlaceholderState({
          snapshotError: snapshot.error,
          project,
        }),
      },
    });
  }
  return [...rows, ...placeholders];
}
