import type { OperationOwner } from '@canopy/protocol/canopy-core';
import { parseWorkspaceContext } from '@canopy/protocol/workspace-context';

/** The local desktop user, who owns and starts personal pipeline work. */
export const LOCAL_PIPELINE_PRINCIPAL = 'local-desktop-user';

/** The owner of an execution's core records, from its stored context. */
export function pipelineExecutionOwnerOf(
  owner: string | undefined,
): OperationOwner {
  const context = owner === undefined ? null : parseWorkspaceContext(owner);
  return context?.kind === 'organization'
    ? { kind: 'organization', id: context.organizationId }
    : { kind: 'principal', id: LOCAL_PIPELINE_PRINCIPAL };
}
