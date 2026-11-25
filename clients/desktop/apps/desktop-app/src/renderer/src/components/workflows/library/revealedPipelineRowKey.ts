import type { PipelineInfo } from '@canopy/execution-engine/types/pipeline';
import { scheduledUserPipeline } from '@/lib/workflows/library-projection';
import type { WorkflowLibraryTarget } from './useWorkflowLibraryRows';

/**
 * The Library row of a local pipeline, by id. Ids are unique per source only,
 * so a project file with the same id never stands in for the installed copy.
 * A user pipeline without a row of its own is revealed on the listed row
 * that stands for it: the automation that owns it, a schedule of its
 * workflow page, or a schedule that runs it.
 */
export function revealedPipelineRowKey(
  targets: ReadonlyMap<string, WorkflowLibraryTarget>,
  pipelineId: string,
  rowKeys: ReadonlySet<string>,
): string | null {
  const pipelines: PipelineInfo[] = [];
  for (const target of Array.from(targets.values())) {
    if (target.kind === 'pipeline') pipelines.push(target.pipeline);
  }
  let key: string | null = null;
  let pipeline: PipelineInfo | undefined;
  for (const [entryKey, target] of Array.from(targets)) {
    if (
      target.kind === 'pipeline' &&
      target.pipeline.id === pipelineId &&
      target.pipeline.source !== 'project'
    ) {
      key = entryKey;
      pipeline = target.pipeline;
      break;
    }
  }
  if (key === null || rowKeys.has(key) || pipeline?.source !== 'user') {
    return key;
  }
  for (const [entryKey, target] of Array.from(targets)) {
    if (target.kind !== 'automation' || !rowKeys.has(entryKey)) continue;
    const { activity } = target;
    if (
      activity.ownedPipeline?.pipelineId === pipelineId ||
      activity.workflowSchedule?.pipelineId === pipelineId ||
      scheduledUserPipeline(activity, pipelines)?.id === pipelineId
    ) {
      return entryKey;
    }
  }
  return key;
}
