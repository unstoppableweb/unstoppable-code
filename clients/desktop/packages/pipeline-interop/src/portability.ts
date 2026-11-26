import { isPortablePipelineTriggerType } from '@canopy/protocol/pipelines';
import {
  getTriggerTypes,
  type Pipeline,
  type PipelineTrigger,
} from './document';
import { parsePipelineText } from './parse-pipeline';

/** Why a curated publication of a definition that declares `workflow` is refused. */
export const LOCAL_ONLY_PIPELINE_TRIGGER_MESSAGE =
  "Curated workflows can't have a Workflow trigger yet.";

/**
 * How deep inline child pipelines are followed. A pipeline with inline
 * children deeper than this is treated as declaring the trigger: it fails
 * closed rather than publishing an unchecked child.
 */
const MAX_INLINE_CHILD_DEPTH = 8;

/**
 * Whether a trigger value names a trigger curated publication refuses:
 * `workflow`, which desktops before v1.20.0 can't read in the curated catalog
 * (CAN-5782 deferred item 1). Shares carry it.
 */
function declaresLocalOnlyPipelineTrigger(
  trigger: PipelineTrigger | undefined | null,
): boolean {
  return getTriggerTypes(trigger).some(
    (type) => !isPortablePipelineTriggerType(type),
  );
}

/**
 * Whether a pipeline, or any literal inline child it runs through
 * `with.pipeline_yaml`, declares a trigger curated publication refuses, even
 * beside other triggers. Child pipelines referenced by id or path are files
 * of their own, checked in the package that carries them.
 */
export function pipelineDeclaresLocalOnlyTrigger(
  pipeline: Pipeline,
  depth = 0,
): boolean {
  if (declaresLocalOnlyPipelineTrigger(pipeline.on)) return true;
  // Raw text is parsed, not normalized: `jobs`, a job or a step may be any
  // value, so each is checked before it is read.
  const jobs: unknown = pipeline.jobs;
  if (jobs === null || typeof jobs !== 'object') return false;
  const jobValues: readonly unknown[] = Object.values(jobs);
  for (const job of jobValues) {
    if (job === null || typeof job !== 'object') continue;
    const steps: unknown = 'steps' in job ? job.steps : undefined;
    if (!Array.isArray(steps)) continue;
    const stepValues: readonly unknown[] = steps;
    for (const step of stepValues) {
      if (step === null || typeof step !== 'object') continue;
      // Every literal `with.pipeline_yaml` is checked, whatever `uses` says:
      // aliases such as `builtin/./run-pipeline` resolve to the same action,
      // and a stray match only over-refuses.
      const settings: unknown = 'with' in step ? step.with : undefined;
      const inline =
        settings !== null &&
        typeof settings === 'object' &&
        'pipeline_yaml' in settings
          ? settings.pipeline_yaml
          : undefined;
      if (typeof inline !== 'string') continue;
      // Too deep to check: refuse rather than share an unchecked child.
      if (depth >= MAX_INLINE_CHILD_DEPTH) return true;
      let child: Pipeline;
      try {
        child = parsePipelineText(inline);
      } catch {
        continue;
      }
      if (pipelineDeclaresLocalOnlyTrigger(child, depth + 1)) return true;
    }
  }
  return false;
}

/**
 * {@link pipelineDeclaresLocalOnlyTrigger} for raw YAML or JSON. Text that
 * does not parse is left to the caller's own validation and reads as false.
 */
export function rawPipelineDeclaresLocalOnlyTrigger(raw: string): boolean {
  let pipeline: Pipeline;
  try {
    pipeline = parsePipelineText(raw);
  } catch {
    return false;
  }
  return pipelineDeclaresLocalOnlyTrigger(pipeline);
}
