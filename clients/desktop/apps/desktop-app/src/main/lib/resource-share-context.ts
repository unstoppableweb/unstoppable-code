import type { WorkspaceContext } from '@canopy/protocol/workspace-context';

export async function assertResourceShareDestination(request: {
  shareScope?: 'private' | 'team' | 'organization';
  teamId?: string;
  organizationId?: string;
}): Promise<WorkspaceContext> {
  const { assertResourceContext, resourceContextEnabled } =
    await import('./resource-context');
  if (!resourceContextEnabled()) return { kind: 'personal' };
  let organizationId =
    request.shareScope === 'organization' ? request.organizationId : undefined;
  if (request.shareScope === 'team') {
    const { listSharedTeams } =
      await import('../pipelines/canopy-server-client');
    const team = (await listSharedTeams({})).data.find(
      (row) => row.id === request.teamId,
    );
    organizationId = team?.organization.id;
  }
  if (
    request.shareScope &&
    request.shareScope !== 'private' &&
    !organizationId
  ) {
    await assertResourceContext({ owner: undefined });
    throw new Error('Resource unavailable (unknown-provenance)');
  }
  await assertResourceContext({
    owner: organizationId
      ? { type: 'organization', id: organizationId, name: null }
      : { type: 'user', id: 'local', name: null },
  });
  return organizationId
    ? { kind: 'organization', organizationId }
    : { kind: 'personal' };
}

/** Prevent an organization-owned share from being moved outside its owner. */
export async function assertResourceShareTransition(
  sourceOwner: unknown,
  destination: WorkspaceContext,
): Promise<void> {
  const { assertResourceContext } = await import('./resource-context');
  await assertResourceContext(
    { owner: sourceOwner },
    { workspaceOwner: destination },
  );
}
