import { getTriggerTypes } from '@canopy/execution-engine/types/pipeline';
import { getStoredPipelineBySource } from '../pipelines/pipeline-service';
import { SCHEDULE_DISPATCH_REQUIRED_MESSAGE } from './scheduled-workflow-refusal';

/**
 * Why an agent's automation can't target `action` (CAN-5782): an agent's
 * schedule runs only as `dispatch`, as before CAN-5782, so a stored workflow
 * it targets must declare it. `null` when it may, or when the target isn't a
 * stored workflow; the service checks every run on the definition it starts.
 * An action without a source is resolved as the scheduler resolves it: a
 * user workflow with its ID first, then a bundled one.
 */
export function agentDispatchTargetRefusal(action: unknown): string | null {
  if (
    typeof action !== 'object' ||
    action === null ||
    !('type' in action) ||
    action.type !== 'worktree_pipeline' ||
    !('pipelineId' in action) ||
    typeof action.pipelineId !== 'string'
  )
    return null;
  const declared =
    'pipelineSource' in action ? action.pipelineSource : undefined;
  const sources: readonly ('user' | 'bundled')[] =
    declared === 'user' || declared === 'bundled'
      ? [declared]
      : declared === undefined
        ? ['user', 'bundled']
        : [];
  const pipelineId = action.pipelineId;
  for (const source of sources) {
    const stored = getStoredPipelineBySource(source, pipelineId);
    if (!stored.success || !stored.data) continue;
    return getTriggerTypes(stored.data.content.on).includes('dispatch')
      ? null
      : SCHEDULE_DISPATCH_REQUIRED_MESSAGE;
  }
  return null;
}
