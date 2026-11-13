import * as yaml from 'js-yaml';
import {
  MAX_CURATED_PIPELINE_BYTES,
  type PipelineCatalogIssue,
  type CuratedPipelineSummary,
} from '@canopy/protocol/pipeline-catalog';
import { PORTABLE_PIPELINE_TRIGGER_TYPES } from '@canopy/protocol/pipelines';
import type { PipelinePackageManifestV1 } from '@canopy/protocol/pipelines';
import { normalizePipeline } from './normalize-pipeline';
import { getTriggerTypes } from './document';
import { LOCAL_ONLY_PIPELINE_TRIGGER_MESSAGE } from './portability';
import { parsePipelineText } from './parse-pipeline';

export class PipelineCatalogValidationError extends Error {
  constructor(public readonly issues: PipelineCatalogIssue[]) {
    super('Pipeline validation failed');
    this.name = 'PipelineCatalogValidationError';
  }
}
function fail(path: string, code: string, message: string): never {
  throw new PipelineCatalogValidationError([{ path, code, message }]);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** Reject alias graphs before any recursive semantic work; bound object expansion and nesting. */
function boundDocument(value: unknown): void {
  const seen = new Set<object>();
  let count = 0;
  function visit(value: unknown, depth: number): void {
    if (++count > 100000 || depth > 64)
      fail(
        'rawPipeline',
        'document_complexity',
        'Pipeline exceeds the document complexity limit',
      );
    if (typeof value !== 'object' || value === null) return;
    if (seen.has(value))
      fail(
        'rawPipeline',
        'yaml_alias',
        'YAML aliases are not supported in curated pipelines; inline each value',
      );
    seen.add(value);
    for (const child of Object.values(value)) visit(child, depth + 1);
  }
  visit(value, 0);
}
function optionalString(value: unknown, path: string, max: number): string {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > max)
    fail(
      path,
      'invalid_type',
      `Expected a string of at most ${max} characters`,
    );
  return value;
}
function safeSemanticIssue(error: unknown): PipelineCatalogIssue {
  const sourceMessage = error instanceof Error ? error.message : '';
  // Never return interpolated normalizer text: even a quoted identifier can
  // contain newlines or quotes and defeat substring redaction. Select only
  // static diagnostic prose; validated short identifiers may identify a path.
  const job = /Job "([A-Za-z_][A-Za-z0-9_]{0,127})"/i.exec(sourceMessage)?.[1];
  const step = /Step "([A-Za-z_][A-Za-z0-9_]{0,127})"/i.exec(
    sourceMessage,
  )?.[1];
  let path = job ? `jobs.${job}${step ? `.steps.${step}` : ''}` : 'rawPipeline';
  let message =
    'Pipeline definition is invalid; check the job and step configuration';
  if (/cycle/i.test(sourceMessage)) {
    path = 'jobs';
    message =
      'Job dependencies contain a cycle; each job must depend only on earlier jobs';
  } else if (/unknown job dependency/i.test(sourceMessage)) {
    path = 'jobs';
    message = 'A job references a dependency that is not declared in jobs';
  } else if (/scope/i.test(sourceMessage)) {
    path = 'scope';
    message =
      'Execution scope must contain unique global, directory or worktree values';
  } else if (/model alias|model_aliases/i.test(sourceMessage)) {
    path = 'model_aliases';
    message =
      'Invalid model alias configuration; check unique ids, defaults and collection references';
  } else if (/plugin.collection/i.test(sourceMessage)) {
    path = 'plugin_collections';
    message =
      'Invalid plugin collection configuration; check unique ids, portable defaults and referenced collections';
  } else if (/local_state/i.test(sourceMessage)) {
    path = 'local_state';
    message = 'local_state must be a list of paths';
  } else if (/Pipeline sandbox/.test(sourceMessage)) {
    path = 'sandbox';
    message = 'sandbox.vcpus must be 1, 2, 4 or 8';
  } else if (/dependenc/i.test(sourceMessage)) {
    path = 'dependencies';
    message =
      'Invalid dependency declaration; check kind, portable reference, fallback and affected step ids';
  } else if (/matrix|strategy/i.test(sourceMessage)) {
    message =
      'Invalid matrix strategy; check axis values, include/exclude rows, parallelism and the 256-variant limit';
  } else if (/target/i.test(sourceMessage)) {
    message =
      'Invalid step target; use supported scope fields and required workspace identifiers';
  } else if (/timeout/i.test(sourceMessage)) {
    message = 'Timeout must be a positive finite number of minutes';
  } else if (/retries/i.test(sourceMessage)) {
    message = 'Retries must be an integer between 0 and 50';
  } else if (/max_iterations/i.test(sourceMessage)) {
    message =
      'max_iterations must be an integer between 0 and 50 or a supported expression';
  } else if (/input/i.test(sourceMessage)) {
    path = 'on';
    message =
      'Invalid trigger inputs; check supported types, defaults, choices and numeric bounds under on.<trigger>.inputs';
  } else if (/trigger|\bon\b/i.test(sourceMessage)) {
    path = 'on';
    message = 'Declare supported dispatch, plan_ready or task_ready triggers';
  } else if (/identifier|step id|job key/i.test(sourceMessage)) {
    message =
      'Job and step identifiers must start with a letter or underscore and contain only letters, numbers and underscores';
  }
  return { path, code: 'invalid_pipeline', message };
}
/** Uses the exact normalizer consumed by desktop execution, with publication-only portability checks. */
export function validateCuratedPipeline(
  rawPipeline: string,
  options: { packageManifest?: PipelinePackageManifestV1 } = {},
): Pick<
  CuratedPipelineSummary,
  | 'name'
  | 'shortDescription'
  | 'icon'
  | 'version'
  | 'triggerTypes'
  | 'scopes'
  | 'jobCount'
  | 'stepCount'
  | 'contentSizeBytes'
> {
  if (!rawPipeline.trim())
    fail('rawPipeline', 'required', 'Pipeline content is required');
  const contentSizeBytes = new TextEncoder().encode(rawPipeline).byteLength;
  if (contentSizeBytes > MAX_CURATED_PIPELINE_BYTES)
    fail('rawPipeline', 'too_large', 'Pipeline must be at most 1 MiB');
  let document: unknown;
  let hasYamlAlias = false;
  const nodeStarts: number[] = [];
  try {
    document = yaml.load(rawPipeline, {
      schema: yaml.JSON_SCHEMA,
      listener(event, state) {
        if (event === 'open') {
          nodeStarts.push(state.position);
          return;
        }
        const start = nodeStarts.pop();
        if (
          start !== undefined &&
          rawPipeline.slice(start, state.position).trimStart().startsWith('*')
        )
          hasYamlAlias = true;
      },
    });
  } catch (error) {
    const mark = error instanceof yaml.YAMLException ? error.mark : undefined;
    throw new PipelineCatalogValidationError([
      {
        path: 'rawPipeline',
        code: 'invalid_yaml',
        message: 'Invalid YAML syntax',
        ...(mark ? { line: mark.line + 1, column: mark.column + 1 } : {}),
      },
    ]);
  }
  if (hasYamlAlias)
    fail(
      'rawPipeline',
      'yaml_alias',
      'YAML aliases are not supported in curated pipelines; inline each value',
    );
  boundDocument(document);
  if (!record(document))
    fail('rawPipeline', 'invalid_type', 'Pipeline document must be an object');
  const raw = document.pipeline ?? document;
  if (!record(raw))
    fail('pipeline', 'invalid_type', 'Pipeline must be an object');
  const allowed = new Set([
    'name',
    'description',
    'icon',
    'version',
    'readonly',
    'scope',
    'on',
    'env',
    'defaults',
    'jobs',
    'plugin_collections',
    'model_aliases',
    'dependencies',
    'assets',
    'local_state',
    'sandbox',
  ]);
  for (const key of Object.keys(raw))
    if (!allowed.has(key))
      fail(
        /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) ? key : 'rawPipeline',
        'unknown_field',
        'Unknown pipeline field',
      );
  // Curated definitions carry no file package, so v1 has nowhere to put
  // asset files; they travel only in automation shares.
  if (raw.assets !== undefined)
    fail(
      'assets',
      'unsupported_reference',
      'Curated definitions do not support file assets; share the automation that runs this pipeline instead',
    );
  const name = optionalString(raw.name, 'name', 256).trim();
  if (!name) fail('name', 'required', 'Pipeline name is required');
  const description = optionalString(raw.description, 'description', 65535);
  const icon = optionalString(raw.icon, 'icon', 128);
  const version = optionalString(raw.version, 'version', 64);
  if (
    !record(raw.jobs) ||
    Object.keys(raw.jobs).length === 0 ||
    Object.keys(raw.jobs).length > 1000
  )
    fail('jobs', 'invalid_jobs', 'Provide between 1 and 1000 jobs');
  const triggers =
    typeof raw.on === 'string'
      ? [raw.on]
      : record(raw.on)
        ? Object.keys(raw.on)
        : [];
  // A readable trigger that can't be published yet gets its own reason.
  if (triggers.includes('workflow'))
    fail('on', 'invalid_trigger', LOCAL_ONLY_PIPELINE_TRIGGER_MESSAGE);
  if (
    !triggers.length ||
    triggers.some(
      (trigger) =>
        !PORTABLE_PIPELINE_TRIGGER_TYPES.some((type) => type === trigger),
    )
  )
    fail(
      'on',
      'invalid_trigger',
      'Declare dispatch, plan_ready or task_ready triggers',
    );
  let stepCount = 0;
  for (const [jobId, job] of Object.entries(raw.jobs)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(jobId))
      fail(
        'jobs',
        'invalid_identifier',
        'Job ids must be at most 128 letters, numbers or underscores and start with a letter or underscore',
      );
    const jobPath = `jobs.${jobId}`;
    if (!record(job) || !Array.isArray(job.steps) || job.steps.length === 0)
      fail(
        `${jobPath}.steps`,
        'invalid_steps',
        'Each job must have a non-empty steps array',
      );
    if ((stepCount += job.steps.length) > 10000)
      fail(
        'jobs',
        'too_many_steps',
        'Pipeline must contain at most 10000 steps',
      );
    const explicitStepIds = new Set(
      job.steps.flatMap((step) =>
        record(step) && typeof step.id === 'string' ? [step.id] : [],
      ),
    );
    let autoStepIndex = 0;
    for (let index = 0; index < job.steps.length; index++) {
      const step: unknown = job.steps[index];
      const path = `${jobPath}.steps.${index}`;
      if (!record(step)) fail(path, 'invalid_step', 'Step must be an object');
      if (
        step.id !== undefined &&
        (typeof step.id !== 'string' ||
          !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(step.id))
      )
        fail(
          `${path}.id`,
          'invalid_identifier',
          'Step ids must be at most 128 letters, numbers or underscores and start with a letter or underscore',
        );
      if (
        (typeof step.run === 'string' && !!step.run.trim()) ===
        (typeof step.uses === 'string' && !!step.uses.trim())
      )
        fail(
          path,
          'invalid_step',
          'Each step must define exactly one non-empty run or uses',
        );
      let stepId = typeof step.id === 'string' ? step.id : '';
      if (!stepId) {
        do stepId = `__auto_step_${autoStepIndex++}`;
        while (explicitStepIds.has(stepId));
      }
      const hasBoundResource = (
        kind: 'pipeline_action' | 'child_pipeline',
        invocationKey: string,
      ): boolean => {
        const binding = options.packageManifest?.bindings.find(
          (candidate) =>
            !('target' in candidate) &&
            candidate.jobId === jobId &&
            candidate.stepId === stepId,
        );
        if (!binding) return false;
        return (
          options.packageManifest?.resources.some(
            (resource) =>
              binding.resourceIds.includes(resource.id) &&
              resource.kind === kind &&
              resource.invocationKeys.includes(invocationKey),
          ) === true
        );
      };
      const uses = typeof step.uses === 'string' ? step.uses : '';
      const packagedProjectAction =
        /^project\/[a-z0-9][a-z0-9/_-]*$/.test(uses) &&
        hasBoundResource('pipeline_action', uses);
      if (
        step.uses !== undefined &&
        (typeof step.uses !== 'string' ||
          (!/^builtin\/[a-z0-9][a-z0-9-]*$/.test(step.uses) &&
            !packagedProjectAction))
      )
        fail(
          `${path}.uses`,
          'unsupported_reference',
          'Curated definitions support builtin actions; local or external action files require a package',
        );
      if (step.uses === 'builtin/run-pipeline') {
        const childRef =
          record(step.with) && typeof step.with.pipeline === 'string'
            ? step.with.pipeline.trim()
            : '';
        if (!childRef || !hasBoundResource('child_pipeline', childRef))
          fail(
            `${path}.uses`,
            'unsupported_reference',
            'Child pipeline references require a matching self-contained pipeline package resource',
          );
      }
    }
  }
  if (Array.isArray(raw.model_aliases))
    for (let index = 0; index < raw.model_aliases.length; index++) {
      const alias: unknown = raw.model_aliases[index];
      if (
        record(alias) &&
        record(alias.defaults) &&
        'agent_id' in alias.defaults
      )
        fail(
          `model_aliases.${index}.defaults.agent_id`,
          'unsupported_reference',
          'Use portable inline model defaults instead of a local Agent id',
        );
    }
  const pipeline = parsePipelineText(rawPipeline);
  try {
    const normalized = normalizePipeline(pipeline);
    return {
      name,
      shortDescription: description.replace(/\s+/g, ' ').trim().slice(0, 256),
      icon,
      version,
      triggerTypes: getTriggerTypes(pipeline.on),
      scopes: normalized.scope,
      jobCount: Object.keys(raw.jobs).length,
      stepCount,
      contentSizeBytes,
    };
  } catch (error) {
    if (error instanceof PipelineCatalogValidationError) throw error;
    throw new PipelineCatalogValidationError([safeSemanticIssue(error)]);
  }
}
