import type {
  ExecutionState,
  JobGroupResult,
  JobResult,
  MaterializedJob,
  NormalizedJob,
  NormalizedPipeline,
  PipelineMatrixCombination,
  StepConclusion,
  StepResult,
} from '../../../types/pipeline';
import {
  MAX_MATRIX_VARIANTS,
  createMatrixPhysicalJobId,
  expandStaticMatrix,
} from '../../../pipelines/matrix';

const TERMINAL_JOB_STATUSES = new Set<JobResult['status']>([
  'success',
  'failure',
  'cancelled',
  'skipped',
]);

export interface MaterializedExecutionJobs {
  jobDefinitions: Record<string, MaterializedJob>;
  jobGroups: Record<string, JobGroupResult>;
  jobs: Record<string, JobResult>;
}

function createPendingStep(): StepResult {
  return { status: 'pending', outputs: {}, dynamic_env: {} };
}

export function createPendingPhysicalJob(job: MaterializedJob): JobResult {
  return {
    status: 'pending',
    steps: Object.fromEntries(
      job.steps.map((step) => [step.id, createPendingStep()]),
    ),
    outputs: {},
    retry_count: 0,
    retry_history: [],
    iteration_count: 0,
  };
}

function createPhysicalDefinition(
  logicalJobId: string,
  physicalJobId: string,
  job: NormalizedJob,
  matrix?: {
    index: number;
    total: number;
    values: PipelineMatrixCombination;
  },
): MaterializedJob {
  const definition = structuredClone(job);
  delete definition.strategy;
  return {
    ...definition,
    physical_job_id: physicalJobId,
    logical_job_id: logicalJobId,
    ...(matrix ? { matrix: structuredClone(matrix) } : {}),
  };
}

export function rematerializeJobDefinitions(
  state: ExecutionState,
  pipeline: NormalizedPipeline,
): Record<string, MaterializedJob> {
  return Object.fromEntries(
    Object.entries(state.job_definitions).map(
      ([physicalJobId, existingDefinition]) => {
        const logicalJob = pipeline.jobs[existingDefinition.logical_job_id];
        if (!logicalJob) {
          throw new Error(
            `Cached pipeline no longer defines job "${existingDefinition.logical_job_id}"`,
          );
        }
        const definition = createPhysicalDefinition(
          existingDefinition.logical_job_id,
          physicalJobId,
          logicalJob,
          existingDefinition.matrix,
        );
        if (existingDefinition.artifact_locator) {
          definition.artifact_locator = structuredClone(
            existingDefinition.artifact_locator,
          );
        }
        return [physicalJobId, definition];
      },
    ),
  );
}

export function materializeInitialJobs(
  pipeline: NormalizedPipeline,
): MaterializedExecutionJobs {
  const jobDefinitions: Record<string, MaterializedJob> = {};
  const jobGroups: Record<string, JobGroupResult> = {};
  const jobs: Record<string, JobResult> = {};
  let generatedVariantCount = 0;

  for (const [logicalJobId, job] of Object.entries(pipeline.jobs)) {
    if (!job.strategy) {
      const definition = createPhysicalDefinition(
        logicalJobId,
        logicalJobId,
        job,
      );
      jobDefinitions[logicalJobId] = definition;
      jobs[logicalJobId] = createPendingPhysicalJob(definition);
      jobGroups[logicalJobId] = {
        job_id: logicalJobId,
        kind: 'single',
        expansion: 'expanded',
        variant_job_ids: [logicalJobId],
        status: 'pending',
      };
      continue;
    }

    if (job.strategy.dynamic) {
      jobGroups[logicalJobId] = {
        job_id: logicalJobId,
        kind: 'matrix',
        expansion: 'pending',
        variant_job_ids: [],
        status: 'pending',
        fail_fast: job.strategy.fail_fast,
        resolved_max_parallel: job.strategy.max_parallel,
      };
      continue;
    }

    const combinations = expandStaticMatrix(logicalJobId, job.strategy);
    generatedVariantCount += combinations.length;
    if (generatedVariantCount > MAX_MATRIX_VARIANTS) {
      throw new Error(
        `Matrix expansion would exceed the execution limit of ${String(MAX_MATRIX_VARIANTS)} variants`,
      );
    }
    const variantJobIds = combinations.map((_combination, index) =>
      createMatrixPhysicalJobId(logicalJobId, index),
    );
    for (let index = 0; index < combinations.length; index += 1) {
      const combination = combinations[index];
      const physicalJobId = variantJobIds[index];
      const definition = createPhysicalDefinition(
        logicalJobId,
        physicalJobId,
        job,
        {
          index,
          total: combinations.length,
          values: combination,
        },
      );
      jobDefinitions[physicalJobId] = definition;
      jobs[physicalJobId] = createPendingPhysicalJob(definition);
    }
    const empty = combinations.length === 0;
    jobGroups[logicalJobId] = {
      job_id: logicalJobId,
      kind: 'matrix',
      expansion: 'expanded',
      variant_job_ids: variantJobIds,
      status: empty ? 'skipped' : 'pending',
      ...(empty
        ? {
            outcome: 'skipped' as const,
            conclusion: 'skipped' as const,
          }
        : {}),
      fail_fast: job.strategy.fail_fast,
      resolved_max_parallel:
        job.strategy.max_parallel ?? Math.max(combinations.length, 1),
    };
  }

  return { jobDefinitions, jobGroups, jobs };
}

export function commitMatrixExpansion(
  state: Pick<
    ExecutionState,
    'pipeline_snapshot' | 'job_definitions' | 'job_groups' | 'jobs'
  >,
  logicalJobId: string,
  combinations: readonly PipelineMatrixCombination[],
): void {
  const job = state.pipeline_snapshot.jobs[logicalJobId];
  const group = state.job_groups[logicalJobId];
  if (!job?.strategy || !group || group.kind !== 'matrix') {
    throw new Error(`Job "${logicalJobId}" is not a matrix job`);
  }
  if (group.variant_job_ids.length > 0) {
    throw new Error(`Job "${logicalJobId}" is already expanded`);
  }
  const variantJobIds = combinations.map((_combination, index) =>
    createMatrixPhysicalJobId(logicalJobId, index),
  );
  const definitions: Record<string, MaterializedJob> = {};
  const results: Record<string, JobResult> = {};
  for (let index = 0; index < combinations.length; index += 1) {
    const combination = combinations[index];
    const physicalJobId = variantJobIds[index];
    const definition = createPhysicalDefinition(
      logicalJobId,
      physicalJobId,
      job,
      {
        index,
        total: combinations.length,
        values: combination,
      },
    );
    definitions[physicalJobId] = definition;
    results[physicalJobId] = createPendingPhysicalJob(definition);
  }
  Object.assign(state.job_definitions, definitions);
  Object.assign(state.jobs, results);
  group.variant_job_ids = variantJobIds;
  group.expansion = 'expanded';
  group.error = undefined;
  group.status = combinations.length === 0 ? 'skipped' : 'pending';
  group.outcome = combinations.length === 0 ? 'skipped' : undefined;
  group.conclusion = combinations.length === 0 ? 'skipped' : undefined;
  group.resolved_max_parallel =
    job.strategy.max_parallel ?? Math.max(combinations.length, 1);
}

function aggregateConclusion(
  variants: readonly JobResult[],
): StepConclusion | undefined {
  if (
    variants.length > 0 &&
    variants.some((variant) => !TERMINAL_JOB_STATUSES.has(variant.status))
  ) {
    return undefined;
  }
  if (variants.some((variant) => variant.conclusion === 'failure')) {
    return 'failure';
  }
  if (variants.some((variant) => variant.conclusion === 'cancelled')) {
    return 'cancelled';
  }
  if (
    variants.length === 0 ||
    variants.every((variant) => variant.conclusion === 'skipped')
  ) {
    return 'skipped';
  }
  if (
    variants.every(
      (variant) =>
        variant.conclusion === 'success' || variant.conclusion === 'skipped',
    )
  ) {
    return 'success';
  }
  return undefined;
}

function aggregateStatus(variants: readonly JobResult[]): JobResult['status'] {
  const conclusion = aggregateConclusion(variants);
  if (conclusion) {
    if (variants.some((variant) => variant.outcome === 'failure')) {
      return 'failure';
    }
    if (variants.some((variant) => variant.outcome === 'cancelled')) {
      return 'cancelled';
    }
    return conclusion;
  }
  if (variants.some((variant) => variant.status === 'running'))
    return 'running';
  if (variants.some((variant) => variant.status === 'restarting')) {
    return 'restarting';
  }
  if (variants.some((variant) => variant.status === 'waiting_for_capacity')) {
    return 'waiting_for_capacity';
  }
  if (variants.some((variant) => variant.status === 'queued')) return 'queued';
  if (variants.some((variant) => variant.status === 'paused')) return 'paused';
  return 'pending';
}

export function refreshJobGroup(
  state: Pick<ExecutionState, 'job_groups' | 'jobs'>,
  logicalJobId: string,
): JobGroupResult {
  const group = state.job_groups[logicalJobId];
  if (!group) throw new Error(`Missing logical job group "${logicalJobId}"`);
  if (group.expansion !== 'expanded') return group;

  const variants = group.variant_job_ids.map((id) => state.jobs[id]);
  if (variants.some((variant) => !variant)) {
    throw new Error(
      `Logical job group "${logicalJobId}" has a missing variant`,
    );
  }
  const status = aggregateStatus(variants);
  const conclusion = aggregateConclusion(variants);
  group.status = status;
  group.conclusion = conclusion;
  group.outcome = variants.some((variant) => variant.outcome === 'failure')
    ? 'failure'
    : variants.some((variant) => variant.outcome === 'cancelled')
      ? 'cancelled'
      : conclusion;
  const starts = variants
    .map((variant) => variant.started_at)
    .filter((value): value is string => Boolean(value))
    .sort();
  group.started_at = starts[0];
  if (TERMINAL_JOB_STATUSES.has(status)) {
    const completions = variants
      .map((variant) => variant.completed_at)
      .filter((value): value is string => Boolean(value))
      .sort();
    group.completed_at = completions[completions.length - 1];
  } else {
    group.completed_at = undefined;
  }
  return group;
}

export function refreshAllJobGroups(
  state: Pick<ExecutionState, 'job_groups' | 'jobs'>,
): void {
  for (const logicalJobId of Object.keys(state.job_groups)) {
    refreshJobGroup(state, logicalJobId);
  }
}

export function isJobGroupTerminal(group: JobGroupResult | undefined): boolean {
  return Boolean(group && TERMINAL_JOB_STATUSES.has(group.status));
}

export function mergeGroupOutputs(
  state: Pick<ExecutionState, 'job_groups' | 'jobs'>,
  logicalJobId: string,
): Record<string, string> {
  const group = state.job_groups[logicalJobId];
  if (!group) return {};
  const outputs: Record<string, string> = {};
  for (const physicalJobId of group.variant_job_ids) {
    Object.assign(outputs, state.jobs[physicalJobId]?.outputs ?? {});
  }
  return outputs;
}
