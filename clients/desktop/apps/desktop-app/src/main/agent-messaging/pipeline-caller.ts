import type { PipelineTrustedCaller } from '@canopy/agent-actions';
import type { PipelineHostActionCaller } from '@canopy/execution-engine/node/pipelines/executor/types';
import { PipelineHostRefusal } from '@canopy/execution-engine/pipelines/host-actions';
import type { ProjectOwnerContext } from '@canopy/desktop-shared/types';
import { parseWorkspaceContext } from '@canopy/protocol/workspace-context';

// The shared caller, which the web host binds for cloud projects too.
export type { PipelineTrustedCaller } from '@canopy/agent-actions';

/** Throws `PipelineHostRefusal('owner_context_unavailable')` for an unparseable owner. */
export function pipelineTrustedCaller(
  caller: PipelineHostActionCaller,
): PipelineTrustedCaller {
  // Same default as the host owner check (`callerOwner` in pipeline-owner-policy).
  const parsed = parseWorkspaceContext(caller.executionContext ?? 'personal');
  if (parsed === null)
    throw new PipelineHostRefusal(
      'owner_context_unavailable',
      "This pipeline's owner can't be checked right now. Try again.",
    );
  const owner: ProjectOwnerContext =
    parsed.kind === 'organization'
      ? { kind: 'organization', organizationId: parsed.organizationId }
      : { kind: 'personal' };
  return {
    executionId: caller.executionId,
    ...(caller.pipelineId !== undefined
      ? { pipelineId: caller.pipelineId }
      : {}),
    stepId: caller.stepId,
    owner,
    ...(caller.agentOrigin !== undefined
      ? { agentOrigin: caller.agentOrigin }
      : {}),
  };
}
