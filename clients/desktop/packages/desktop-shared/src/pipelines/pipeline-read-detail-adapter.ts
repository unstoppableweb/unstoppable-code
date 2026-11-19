import * as yaml from 'js-yaml';
import type { RemoteControlPipelineDefinitionViewModel } from '@canopy/protocol/remote-control/shell';
import { normalizePipelineScopes } from '@canopy/execution-engine/pipelines/scope';
import {
  getTriggerTypes,
  normalizeNeeds,
  type NormalizedPipeline,
  type Pipeline,
  type PipelineTriggerType,
  type Step,
} from '@canopy/execution-engine/types/pipeline';

const TRIGGER_LABELS: Record<PipelineTriggerType, string> = {
  dispatch: 'Manual',
  plan_ready: 'Plan ready',
  task_ready: 'Task ready',
  workflow: 'Workflow',
};

/** A job as both a parsed definition and a run's recorded snapshot carry it. */
interface ReadDetailJob {
  readonly name?: string;
  readonly needs?: string | string[];
  readonly steps: readonly Step[];
}

/**
 * What the read-only view projects: a parsed `Pipeline`, or the
 * `NormalizedPipeline` a run recorded as its snapshot.
 */
interface ReadDetailSource {
  readonly name: string;
  readonly description?: string;
  readonly version?: string;
  readonly icon?: string;
  readonly scope?: Pipeline['scope'];
  readonly jobs: Readonly<Record<string, ReadDetailJob>>;
}

function projectScopes(
  scope: Pipeline['scope'],
): ReturnType<typeof normalizePipelineScopes> {
  try {
    return normalizePipelineScopes(scope, 'Pipeline');
  } catch {
    return [];
  }
}

function projectStep(
  step: Step,
  jobId: string,
  index: number,
  includeRunSummary: boolean,
): RemoteControlPipelineDefinitionViewModel['jobs'][number]['steps'][number] {
  // Parsed YAML can carry alias-expanded non-string values despite the Step
  // type, so only string fields may reach the serialized view model; anything
  // else falls back to bounded copy.
  const uses = typeof step.uses === 'string' ? step.uses : undefined;
  const run = typeof step.run === 'string' ? step.run : undefined;
  const kind = uses ? 'action' : run ? 'script' : 'incomplete';
  return {
    id: typeof step.id === 'string' ? step.id : `${jobId}-step-${index + 1}`,
    name:
      (typeof step.name === 'string' ? step.name : undefined) ??
      (typeof step.id === 'string' ? step.id : undefined) ??
      `Step ${index + 1}`,
    kind,
    usesSummary:
      uses ??
      (run ? (includeRunSummary ? run.split('\n')[0] : 'Script') : null) ??
      'Not configured',
  };
}

type ProjectedDefinition = Omit<
  RemoteControlPipelineDefinitionViewModel,
  'canonicalYaml' | 'canonicalYamlTruncated'
>;

function projectSource(
  pipeline: ReadDetailSource,
  triggerSummary: string,
  includeRunSummary: boolean,
): ProjectedDefinition {
  return {
    name: pipeline.name,
    ...(pipeline.description ? { description: pipeline.description } : {}),
    ...(pipeline.version ? { version: pipeline.version } : {}),
    ...(pipeline.icon ? { icon: pipeline.icon } : {}),
    triggerSummary,
    scopes: projectScopes(pipeline.scope),
    jobs: Object.entries(pipeline.jobs).map(([id, job]) => ({
      id,
      name: job.name ?? id,
      dependencies: normalizeNeeds(job.needs),
      steps: job.steps.map((step, index) =>
        projectStep(step, id, index, includeRunSummary),
      ),
    })),
  };
}

function projectPipeline(
  pipeline: Pipeline,
  includeRunSummary: boolean,
): ProjectedDefinition {
  return projectSource(
    pipeline,
    getTriggerTypes(pipeline.on)
      .map((trigger) => TRIGGER_LABELS[trigger])
      .join(', '),
    includeRunSummary,
  );
}

// Bound on job + step rows serialized into canonical YAML. The dump runs
// synchronously in the renderer, and js-yaml's duplicate-reference discovery
// scales quadratically with object count, so an unbounded repository-controlled
// pipeline could stall the UI before any result budget applies.
const CANONICAL_YAML_MAX_ROWS = 2_000;

function pipelineRowCount(pipeline: ReadDetailSource): number {
  return Object.values(pipeline.jobs).reduce(
    (count, job) => count + 1 + job.steps.length,
    0,
  );
}

function pipelineWithRowLimit(
  pipeline: ReadDetailSource,
  rowLimit: number,
): ReadDetailSource {
  let remaining = rowLimit;
  const jobs: Record<string, ReadDetailJob> = {};
  for (const [id, job] of Object.entries(pipeline.jobs)) {
    if (remaining === 0) break;
    remaining -= 1;
    const stepCount = Math.min(job.steps.length, remaining);
    jobs[id] = { ...job, steps: job.steps.slice(0, stepCount) };
    remaining -= stepCount;
    if (stepCount < job.steps.length) break;
  }
  return { ...pipeline, jobs };
}

function withCanonicalYaml(
  pipeline: ReadDetailSource,
  projected: ProjectedDefinition,
): RemoteControlPipelineDefinitionViewModel {
  // Keep references enabled: repository-controlled alias graphs otherwise
  // expand recursively when `noRefs` is used and can exhaust the renderer or
  // Electron main process before the portal result budget is applied. The
  // row bound above keeps reference discovery itself from stalling the UI.
  const bounded = pipelineRowCount(pipeline) > CANONICAL_YAML_MAX_ROWS;
  const dumpSource = bounded
    ? pipelineWithRowLimit(pipeline, CANONICAL_YAML_MAX_ROWS)
    : pipeline;
  const canonicalYaml = yaml.dump({ pipeline: dumpSource }, { lineWidth: 120 });
  return {
    ...projected,
    canonicalYaml,
    ...(bounded ? { canonicalYamlTruncated: true } : {}),
  };
}

export function toPipelineDefinitionViewModel(
  pipeline: Pipeline,
): RemoteControlPipelineDefinitionViewModel {
  return withCanonicalYaml(pipeline, projectPipeline(pipeline, true));
}

/**
 * The definition a pipeline run started with, from its recorded
 * `ExecutionState.pipeline_snapshot`. The normalized snapshot keeps no
 * triggers, so the trigger summary is empty; its canonical YAML is the
 * snapshot as recorded.
 */
export function toPipelineRunDefinitionViewModel(
  snapshot: NormalizedPipeline,
): RemoteControlPipelineDefinitionViewModel {
  return withCanonicalYaml(snapshot, projectSource(snapshot, '', true));
}

export function toPipelineDefinitionViewModelWithoutCanonicalYaml(
  pipeline: Pipeline,
): Omit<
  RemoteControlPipelineDefinitionViewModel,
  'canonicalYaml' | 'canonicalYamlTruncated'
> {
  return projectPipeline(pipeline, false);
}
