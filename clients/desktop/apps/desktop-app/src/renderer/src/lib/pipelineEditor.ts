import type { Pipeline } from '@canopy/execution-engine/types/pipeline';
import {
  getJobOrder,
  normalizeNeeds,
  parseLogFormatHint,
} from '@canopy/execution-engine/types/pipeline';
import {
  MAX_ITERATIONS_LIMIT,
  MAX_RETRIES_LIMIT,
  isExpressionTemplate,
  resolvePipelineModelAliasLenient,
} from '@canopy/execution-engine/pipelines/normalize-pipeline';
import { normalizePipelineScopes } from '@canopy/execution-engine/pipelines/scope';
import { normalizePipelineRunTarget } from '@canopy/desktop-shared/pipelines/target';
import { normalizeMatrixStrategy } from '@canopy/execution-engine/pipelines/matrix';
import { resolveKnownModel } from '@canopy/desktop-shared/types';
import { AGENT_MODEL_PREFIX } from '@canopy/execution-engine/types/agent-models';
import {
  declaredPipelineAssetIds,
  findPipelineAssetReferences,
  validatePipelineAssetDeclarations,
} from '@canopy/pipeline-interop/assets';

const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

// Model alias ids are referenced by `with.model` and are more permissive than
// job/step identifiers (leading digits and hyphens are allowed, mirroring the
// plugin-collection id shape).
const MODEL_ALIAS_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

// Steps whose `with.model` selects a model at run time. Kept in sync with the
// executor's `MODEL_AWARE_AGENT_ACTIONS`; the shared normalizer has no model
// registry, so the "did you mean a deleted alias?" lint lives here instead.
const MODEL_AWARE_STEP_USES = new Set([
  'builtin/agent-prompt',
  'builtin/agent-resume',
]);

function isValidMaxIterationsValue(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }

  if (typeof value === 'number') {
    return (
      Number.isSafeInteger(value) && value >= 0 && value <= MAX_ITERATIONS_LIMIT
    );
  }

  if (typeof value !== 'string') {
    return false;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }

  return isExpressionTemplate(trimmed);
}

/**
 * Check whether a string is a valid pipeline identifier
 * (job ID, step ID, etc.) per the executor's naming rule.
 */
export function isValidPipelineIdentifier(value: string): boolean {
  return IDENTIFIER_RE.test(value);
}

/**
 * Generate a unique job ID like `job_1`, `job_2`, etc.
 * that does not collide with any existing job IDs.
 */
export function createJobId(existingJobIds: string[]): string {
  let counter: number = 1;
  const existing: Set<string> = new Set(existingJobIds);
  let candidate: string = `job_${counter}`;
  while (existing.has(candidate)) {
    counter += 1;
    candidate = `job_${counter}`;
  }
  return candidate;
}

/**
 * Generate a unique step ID like `step_1`, `step_2`, etc.
 * that does not collide with any existing step IDs.
 */
export function createStepId(existingStepIds: string[]): string {
  let counter: number = 1;
  const existing: Set<string> = new Set(existingStepIds);
  let candidate: string = `step_${counter}`;
  while (existing.has(candidate)) {
    counter += 1;
    candidate = `step_${counter}`;
  }
  return candidate;
}

/**
 * Return a new Pipeline with a job key renamed from `oldJobId` to `newJobId`.
 * Preserves insertion order of jobs in the record, and updates all `needs`
 * references across the entire pipeline.
 */
export function renameJobId(
  pipeline: Pipeline,
  oldJobId: string,
  newJobId: string,
): Pipeline {
  // Guard: if newJobId already exists and isn't the key being renamed, bail out
  if (newJobId !== oldJobId && newJobId in pipeline.jobs) {
    return pipeline;
  }

  // Rebuild the jobs record, preserving insertion order
  const newJobs: Record<string, Pipeline['jobs'][string]> = {};

  for (const key of Object.keys(pipeline.jobs)) {
    const targetKey: string = key === oldJobId ? newJobId : key;
    const job = pipeline.jobs[key];
    newJobs[targetKey] = job;
  }

  // Update all `needs` references in every job
  for (const key of Object.keys(newJobs)) {
    const job = newJobs[key];
    if (job.needs === undefined) continue;

    if (typeof job.needs === 'string') {
      if (job.needs === oldJobId) {
        newJobs[key] = { ...job, needs: newJobId };
      }
    } else {
      const updated: string[] = job.needs.map((dep: string): string =>
        dep === oldJobId ? newJobId : dep,
      );
      newJobs[key] = { ...job, needs: updated };
    }
  }

  return { ...pipeline, jobs: newJobs };
}

export interface ValidationIssue {
  type: 'error' | 'warning';
  path: string;
  message: string;
}

export type PipelineEditorSelection =
  | { type: 'none' }
  | { type: 'job'; jobId: string }
  | { type: 'step'; jobId: string; stepIndex: number };

export function isPipelineSelectionValid(
  pipeline: Pipeline,
  selection: PipelineEditorSelection,
): boolean {
  if (selection.type === 'none') {
    return true;
  }

  const job = pipeline.jobs[selection.jobId];
  if (!job) {
    return false;
  }

  if (selection.type === 'job') {
    return true;
  }

  return selection.stepIndex >= 0 && selection.stepIndex < job.steps.length;
}

/**
 * `assets` / `local_state` shape errors, plus `${{ assets.<id> }}` reads of
 * ids the pipeline does not declare. A pipeline that declares no assets may
 * still read its parent's (child runs inherit the root run's `assets`), so
 * there an unknown id is a warning rather than an error.
 */
function getAssetValidation(pipeline: Pipeline): ValidationIssue[] {
  const issues: ValidationIssue[] = validatePipelineAssetDeclarations(
    pipeline,
  ).map((issue) => ({ type: 'error', ...issue }));
  const declared = declaredPipelineAssetIds(pipeline.assets);
  const declaresAssets = pipeline.assets !== undefined;
  for (const id of findPipelineAssetReferences(pipeline)) {
    if (declared.has(id)) continue;
    issues.push(
      declaresAssets
        ? {
            type: 'error',
            path: 'assets',
            message: `Expression reads asset "${id}", which this pipeline does not declare`,
          }
        : {
            type: 'warning',
            path: 'assets',
            message: `Expression reads asset "${id}", which resolves only when a parent pipeline that declares it runs this one`,
          },
    );
  }
  return issues;
}

/**
 * Return structured validation issues for a draft pipeline.
 */
export function getDraftValidation(pipeline: Pipeline): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Pipeline-level execution scope: defer to the shared normalizer so the
  // editor surfaces the same "scope ... is not supported" / duplicate-scope
  // errors the backend would raise at run time. A missing scope is valid
  // (defaults to `directory`), so this only flags explicitly-invalid values.
  try {
    normalizePipelineScopes(pipeline.scope, 'Workflow');
  } catch (err: unknown) {
    issues.push({
      type: 'error',
      path: 'scope',
      message:
        err instanceof Error ? err.message : 'Invalid workflow execution scope',
    });
  }

  // Model aliases (pipeline-level). Alias id errors block save; an inline
  // default with an empty base model / an Agent default with an empty agent id
  // is invalid YAML. An OMITTED `defaults` is valid — it marks a required
  // configuration slot for dispatch/automation, so it is never flagged here.
  const modelAliases = pipeline.model_aliases ?? [];
  const aliasIds: Set<string> = new Set();
  const seenAliasIds: Set<string> = new Set();
  for (let i = 0; i < modelAliases.length; i++) {
    const alias = modelAliases[i];
    const aliasPath = `model_aliases[${i}]`;
    const id = (alias.id ?? '').trim();

    if (id === '') {
      issues.push({
        type: 'error',
        path: aliasPath,
        message: 'Model alias ID is required',
      });
    } else if (!MODEL_ALIAS_ID_RE.test(id)) {
      issues.push({
        type: 'error',
        path: aliasPath,
        message: `Invalid model alias ID "${id}" — start with a letter or number and use only letters, numbers, underscores, or hyphens`,
      });
    } else if (seenAliasIds.has(id)) {
      issues.push({
        type: 'error',
        path: aliasPath,
        message: `Duplicate model alias ID "${id}"`,
      });
    }
    if (id !== '') {
      seenAliasIds.add(id);
      aliasIds.add(id);
    }

    const defaults = alias.defaults;
    if (defaults) {
      if ('agent_id' in defaults) {
        if (!defaults.agent_id || defaults.agent_id.trim() === '') {
          issues.push({
            type: 'error',
            path: aliasPath,
            message: `Model alias "${id || `#${i + 1}`}" agent default must reference an agent`,
          });
        }
      } else if (!defaults.base || defaults.base.trim() === '') {
        issues.push({
          type: 'error',
          path: aliasPath,
          message: `Model alias "${id || `#${i + 1}`}" inline default must set a base model`,
        });
      }
    }
  }

  issues.push(...getAssetValidation(pipeline));

  if (!pipeline.jobs) return issues;
  const jobIds: string[] = Object.keys(pipeline.jobs);
  const jobIdSet: Set<string> = new Set(jobIds);

  for (const jobId of jobIds) {
    const jobPath: string = `jobs.${jobId}`;
    const job = pipeline.jobs[jobId];
    if (Object.prototype.hasOwnProperty.call(job, 'foreach')) {
      issues.push({
        type: 'error',
        path: jobPath,
        message: `Job "${jobId}" uses removed field "foreach". Replace it with "strategy.matrix"`,
      });
    }
    if (Object.prototype.hasOwnProperty.call(job, 'max_parallel')) {
      issues.push({
        type: 'error',
        path: jobPath,
        message: `Job "${jobId}" defines legacy top-level "max_parallel". Move it to "strategy.max_parallel"`,
      });
    }
    try {
      normalizeMatrixStrategy(jobId, job.strategy);
    } catch (error) {
      issues.push({
        type: 'error',
        path: `${jobPath}.strategy`,
        message:
          error instanceof Error ? error.message : 'Invalid matrix strategy',
      });
    }

    // Invalid job ID
    if (!isValidPipelineIdentifier(jobId)) {
      issues.push({
        type: 'error',
        path: jobPath,
        message: `Invalid job ID "${jobId}" — must match /^[a-zA-Z_][a-zA-Z0-9_]*$/`,
      });
    }

    // Unknown job dependencies
    const needs: string[] = normalizeNeeds(job.needs);
    for (const dep of needs) {
      if (!jobIdSet.has(dep)) {
        issues.push({
          type: 'error',
          path: jobPath,
          message: `Unknown dependency "${dep}" — no such job exists`,
        });
      }
    }

    if (
      job.max_retries !== undefined &&
      (!Number.isSafeInteger(job.max_retries) ||
        job.max_retries < 0 ||
        job.max_retries > MAX_RETRIES_LIMIT)
    ) {
      issues.push({
        type: 'error',
        path: jobPath,
        message: `Invalid max_retries "${String(job.max_retries)}" — must be 0-${MAX_RETRIES_LIMIT}`,
      });
    }

    if (!isValidMaxIterationsValue(job.max_iterations)) {
      issues.push({
        type: 'error',
        path: jobPath,
        message: `Invalid max_iterations "${String(job.max_iterations)}" — must be 0-${MAX_ITERATIONS_LIMIT} or an expression`,
      });
    }

    // Step-level validation
    const stepIdsInJob: Set<string> = new Set();

    for (let i = 0; i < job.steps.length; i++) {
      const step = job.steps[i];
      const stepPath: string = `${jobPath}.steps[${i}]`;

      // Invalid step ID
      if (step.id !== undefined && !isValidPipelineIdentifier(step.id)) {
        issues.push({
          type: 'error',
          path: stepPath,
          message: `Invalid step ID "${step.id}" — must match /^[a-zA-Z_][a-zA-Z0-9_]*$/`,
        });
      }

      // Duplicate step ID within the job
      if (step.id !== undefined) {
        if (stepIdsInJob.has(step.id)) {
          issues.push({
            type: 'error',
            path: stepPath,
            message: `Duplicate step ID "${step.id}" within job "${jobId}"`,
          });
        }
        stepIdsInJob.add(step.id);
      }

      // Steps with both `run` and `uses`
      if (step.run !== undefined && step.uses !== undefined) {
        issues.push({
          type: 'error',
          path: stepPath,
          message: 'Step cannot have both "run" and "uses"',
        });
      }

      // Steps with neither `run` nor `uses`
      if (step.run === undefined && step.uses === undefined) {
        issues.push({
          type: 'warning',
          path: stepPath,
          message: 'Step has neither "run" nor "uses"',
        });
      }

      try {
        const logFormatHint = parseLogFormatHint(
          step.log_format_hint,
          `Step "${step.id ?? `steps[${String(i)}]`}" in job "${jobId}"`,
        );
        if (step.run !== undefined && logFormatHint !== undefined) {
          issues.push({
            type: 'error',
            path: stepPath,
            message: 'Step cannot define "log_format_hint" when using "run"',
          });
        }
      } catch (error) {
        issues.push({
          type: 'error',
          path: stepPath,
          message:
            error instanceof Error
              ? error.message
              : 'Invalid log_format_hint value',
        });
      }

      // Absolute working_directory
      if (
        step.working_directory !== undefined &&
        step.working_directory.startsWith('/')
      ) {
        issues.push({
          type: 'warning',
          path: stepPath,
          message: 'Absolute working_directory paths are not recommended',
        });
      }

      // Model-alias reference lint (warning): a model-aware step whose static
      // `with.model` matches no defined alias id, no known base model, and is
      // not an `agent_model_*` id likely references a deleted alias. Kept a
      // warning because provider model strings are open-ended.
      if (step.uses !== undefined && MODEL_AWARE_STEP_USES.has(step.uses)) {
        const modelValue = step.with?.model;
        const trimmedModel =
          typeof modelValue === 'string' ? modelValue.trim() : '';
        if (trimmedModel !== '' && !isExpressionTemplate(trimmedModel)) {
          const recognized =
            aliasIds.has(trimmedModel) ||
            (trimmedModel.startsWith('$') &&
              resolvePipelineModelAliasLenient(trimmedModel) !==
                trimmedModel) ||
            resolveKnownModel(trimmedModel) !== undefined ||
            trimmedModel.startsWith(AGENT_MODEL_PREFIX);
          if (!recognized) {
            issues.push({
              type: 'warning',
              path: stepPath,
              message: `Step model "${trimmedModel}" matches no defined model alias or known model — did you mean a deleted alias?`,
            });
          }
        }
      }

      // run-pipeline `target`: validate scope + worktree/directory shape via
      // the shared normalizer. This rejects camelCase fields (e.g.
      // `workspaceId`), unknown scopes, and missing required worktree fields
      // with the same messages the backend uses. A missing `target` is valid
      // (defaults to `inherit`), so this only flags malformed declarations.
      if (step.target !== undefined) {
        try {
          normalizePipelineRunTarget(
            step.target,
            `Step "${step.id ?? `steps[${String(i)}]`}" in job "${jobId}"`,
          );
        } catch (error) {
          issues.push({
            type: 'error',
            path: stepPath,
            message:
              error instanceof Error
                ? error.message
                : 'Invalid run-pipeline target',
          });
        }
      }
    }
  }

  // Cyclic job graphs
  try {
    getJobOrder(pipeline);
  } catch (err: unknown) {
    const message: string =
      err instanceof Error ? err.message : 'Unknown cycle detection error';
    issues.push({
      type: 'error',
      path: 'jobs',
      message,
    });
  }

  return issues;
}

export interface SafeJobOrderResult {
  order: string[];
  error?: string;
}

/**
 * Try to compute the topological job order. If it fails (cycle or missing
 * dependency), fall back to `Object.keys` order and include the error.
 */
export function getSafeJobOrder(pipeline: Pipeline): SafeJobOrderResult {
  if (!pipeline.jobs) return { order: [] };
  try {
    const order: string[] = getJobOrder(pipeline);
    return { order };
  } catch (err: unknown) {
    const error: string =
      err instanceof Error ? err.message : 'Unknown error computing job order';
    const order: string[] = Object.keys(pipeline.jobs);
    return { order, error };
  }
}
