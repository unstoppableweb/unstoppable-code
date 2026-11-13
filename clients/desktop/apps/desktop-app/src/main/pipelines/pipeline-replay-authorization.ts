import type { ChildPipelineAuthorization } from '@canopy/execution-engine/node/pipelines/executor/child-pipeline-resolver';
import type {
  ExecutionState,
  ExecutionOptions,
} from '@canopy/execution-engine/node/pipelines/executor';
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
