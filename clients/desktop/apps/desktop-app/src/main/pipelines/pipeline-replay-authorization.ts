import type { ChildPipelineAuthorization } from '@canopy/execution-engine/node/pipelines/executor/child-pipeline-resolver';
import type {
  ExecutionState,
  ExecutionOptions,
} from '@canopy/execution-engine/node/pipelines/executor';
import { parseSharedPipelineLocalId } from '@canopy/desktop-shared/pipelines/shared-pipeline-id';
import { assertOrganizationPipelineAllowed } from '../organization-capabilities/pipeline-gate';
import { getStoredPipelineBySource } from './pipeline-service';
import {
  backgroundExecutionDeniedMessage,
  backgroundExecutionRetryMessage,
} from '@canopy/desktop-shared/node/background-execution-context';
import {
  authorizeBackgroundExecution,
  backgroundExecutionContextEnabled,
  persistedPipelineContextResources,
  resolveBackgroundWorkspaceContext,
} from '../services/background-execution-context';

export async function authorizePipelineReplay(
  state: ExecutionState,
): Promise<
  | Pick<ExecutionOptions, 'executionContext' | 'childPipelineAuthorizations'>
  | undefined
> {
  // A shared organization pipeline the run's project switched off is not
  // started over or resumed there, as a fresh start is not (CAN-6237).
  const shared = parseSharedPipelineLocalId(state.pipeline_id);
  if (shared)
    await assertOrganizationPipelineAllowed(state.project_id, shared.remoteId);
  if (!backgroundExecutionContextEnabled()) return undefined;
  const authorizations: ChildPipelineAuthorization[] = [];
  const executionContext =
    state.execution_context ??
    (state.project_id
      ? await resolveBackgroundWorkspaceContext(
          state.project_id,
          state.worktree_id,
        )
      : undefined);
  const decision = await authorizeBackgroundExecution(
    executionContext,
    persistedPipelineContextResources(state, getStoredPipelineBySource),
    state.project_id
      ? { projectId: state.project_id, worktreeId: state.worktree_id }
      : state.scope === 'global'
        ? { scope: 'global' }
        : undefined,
    authorizations,
  );
  if (!decision.allow)
    throw new Error(
      decision.transient
        ? backgroundExecutionRetryMessage('run')
        : backgroundExecutionDeniedMessage(decision.reason, {
            ...(decision.subject ? { subject: decision.subject } : {}),
          }),
    );
  return { executionContext, childPipelineAuthorizations: authorizations };
}
