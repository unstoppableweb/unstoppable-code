import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import type { CoreCoworkProject } from '@canopy/app-state/core-cowork';
import { webCoreScopeId } from '@/lib/chat-authority';

/**
 * The owner of the cloud workspace `projectId` names, as the web core lists
 * it: an organization id, null for a personal workspace, or undefined while
 * the listing doesn't show it.
 */
export function cloudWorkspaceOwner(
  projects: readonly CoreCoworkProject[],
  projectId: string,
): string | null | undefined {
  return projects.find(
    (project) => webCoreScopeId(project.workspaceId) === projectId,
  )?.ownerOrganizationId;
}

/**
 * Whether the navigation context is the cloud workspace's owner (CAN-6937).
 * A cloud chat's locked models are its owner's, and the desktop unlock bills
 * the navigation context, so it is offered only when the two are the same:
 * never before the context is read, and never for a workspace whose owner
 * the listing doesn't show.
 */
export function navigationOwnsCloudWorkspace(
  owner: string | null | undefined,
  context: WorkspaceContext | undefined,
): boolean {
  if (owner === undefined || context === undefined) return false;
  if (owner === null) return context.kind === 'personal';
  return (
    context.kind === 'organization' &&
    context.organizationId.toLowerCase() === owner.toLowerCase()
  );
}
