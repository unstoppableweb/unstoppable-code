import type {
  PipelineInputDef,
  PipelineInputValue,
  PipelineJsonValue,
  MatrixContext,
  PipelineExecutionInitiator,
  PipelineScalar,
  PipelineTriggerType,
} from '@canopy/execution-engine/types/pipeline';
import { BRAND } from '@canopy/brand/current';
import type { NormalizedPipeline } from '@canopy/execution-engine/pipelines/types';
import type { CanopyEventData, NormalizedJob, JobResult } from './types';
import { isPipelineInputValue } from '@canopy/execution-engine/pipelines/json-values';
import { resolvePipelineModelAlias } from '@canopy/execution-engine/pipelines/normalize-pipeline';

export type {
  CanopyEventData,
  CanopyEventInput,
  PlanReadyEventData,
  PlanReadyEventInput,
} from './types';

export interface ExpressionStepState {
  outputs: Record<string, string>;
  outcome?: string;
  conclusion?: string;
}

export interface ExpressionNeedsState {
  outputs: Record<string, string>;
  result?: string;
  children?: MatrixNeedsChild[];
}

export interface MatrixNeedsChild {
  job_id: string;
  matrix: Record<string, PipelineJsonValue>;
  status: JobResult['status'];
  result?: JobResult['conclusion'];
  conclusion?: JobResult['conclusion'];
  outcome?: JobResult['outcome'];
  outputs: Record<string, string>;
}

export interface ExpressionJobState {
  is_retry: boolean;
  retry_count: number;
  max_retries: number;
}

/** `canopy.initiator`: snake_case so expressions and `toJson()` read it. */
export interface ExpressionCanopyInitiator {
  kind: string;
  automation_id?: string;
  automation_name?: string;
  project_id?: string;
  task_id?: string;
  chat_id?: string;
}

export interface ExpressionCanopyContext {
  event_name: string;
  event: CanopyEventData;
  /** Empty in a run with no project. */
  project_id: string;
  /** Empty in a run with no task. */
  task_id: string;
  /** Serialized run owner, `personal` when the run recorded none. */
  owner: string;
  initiator: ExpressionCanopyInitiator;
  /** Per-pipeline state dir (`<data>/pipeline-data/<key>/state`), when resolved. */
  pipeline_data_dir?: string;
}

/** `assets.<id>.path` for each resolved asset of the run. */
export type ExpressionAssetsContext = Record<string, { path: string }>;

/** Project resolved asset paths into the `assets` expression root. */
export function buildExpressionAssets(
  assetPaths: Record<string, string> | undefined,
): ExpressionAssetsContext | undefined {
  if (assetPaths === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(assetPaths).map(([id, assetPath]) => [
      id,
      { path: assetPath },
    ]),
  );
}

/** Project the trusted run identity into `canopy.*` expression fields. */
export function buildExpressionCanopyIdentity(identity: {
  projectId?: string;
  worktreeId?: string;
  executionContext?: string;
  initiator?: PipelineExecutionInitiator;
}): Pick<
  ExpressionCanopyContext,
  'project_id' | 'task_id' | 'owner' | 'initiator'
> {
  return {
    project_id: identity.projectId ?? '',
    task_id: identity.worktreeId ?? '',
    owner: identity.executionContext ?? 'personal',
    initiator: expressionInitiator(identity.initiator),
  };
}

function expressionInitiator(
  initiator: PipelineExecutionInitiator | undefined,
): ExpressionCanopyInitiator {
  if (!initiator) return { kind: 'user' };
  switch (initiator.kind) {
    case 'automation':
      return {
        kind: initiator.kind,
        automation_id: initiator.automationId,
        ...(initiator.automationName
          ? { automation_name: initiator.automationName }
          : {}),
      };
    case 'agent':
    case 'app_advisor':
      return initiator.chat
        ? {
            kind: initiator.kind,
            project_id: initiator.chat.projectId,
            task_id: initiator.chat.worktreeId,
            chat_id: initiator.chat.chatId,
          }
        : { kind: initiator.kind };
    default:
      return { kind: initiator.kind };
  }
}

export interface ExpressionContext {
  env: Record<string, string>;
  /**
   * Resolved trigger inputs. Widened to {@link PipelineInputValue} by the
   * matrix transport contract so `type: 'json'` inputs can carry structured
   * values into expressions. Scalar inputs are unaffected; job/step `env` and
   * `with` stay scalar and receive structured values only via
   * `JSON.stringify()` at projection time.
   */
  inputs: Record<string, PipelineInputValue>;
  steps: Record<string, ExpressionStepState>;
  needs: Record<string, ExpressionNeedsState>;
  job: ExpressionJobState;
  canopy: ExpressionCanopyContext;
  matrix?: MatrixContext;
  /** `${{ assets.<id>.path }}`; inherited by child runs. */
  assets?: ExpressionAssetsContext;
  [key: string]: unknown;
}

export interface RehydratedJobContext {
  steps: Record<string, ExpressionStepState>;
  dynamicEnv: Record<string, string>;
}

function toExpressionRoot(value: string): string {
  return value
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part, index) =>
      index === 0 ? part : `${part.charAt(0).toUpperCase()}${part.slice(1)}`,
    )
    .join('');
}

function scalarToString(value: PipelineScalar | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return String(value);
}

export function cascadeEnv(
  ...layers: Array<Record<string, PipelineScalar | string> | undefined>
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const layer of layers) {
    if (!layer) {
      continue;
    }
    for (const [key, value] of Object.entries(layer)) {
      const normalized = scalarToString(value);
      if (normalized !== undefined) {
        result[key] = normalized;
      }
    }
  }

  return result;
}

function toEnvKey(inputName: string): string {
  return `INPUT_${inputName.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}`;
}

/**
 * Project an input value into its environment-variable string form.
 *
 * Scalars keep their existing `String(value)` rendering byte-for-byte.
 * Structured (`type: 'json'`) values are serialized with `JSON.stringify()`,
 * per the transport contract: job/step `env` and `with` stay scalar, and
 * structured values reach them only at projection time.
 */
function inputValueToString(
  value: PipelineInputValue | undefined,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value !== null && typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

export function inputsToEnv(
  inputs: Record<string, PipelineInputValue | undefined>,
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(inputs)) {
    const normalized = inputValueToString(value);
    if (normalized !== undefined) {
      result[toEnvKey(key)] = normalized;
    }
  }

  return result;
}

function parsePipelineInputValue(
  name: string,
  definition: PipelineInputDef,
  rawValue: string,
): PipelineInputValue {
  switch (definition.type ?? 'string') {
    case 'string':
      return rawValue;
    case 'number': {
      const trimmed = rawValue.trim();
      const parsed = Number(trimmed);
      if (!trimmed || !Number.isFinite(parsed)) {
        throw new Error(`Workflow input "${name}" must be a finite number`);
      }
      if (definition.min !== undefined && parsed < definition.min) {
        throw new Error(
          `Workflow input "${name}" must be greater than or equal to ${String(definition.min)}`,
        );
      }
      if (definition.max !== undefined && parsed > definition.max) {
        throw new Error(
          `Workflow input "${name}" must be less than or equal to ${String(definition.max)}`,
        );
      }
      return parsed;
    }
    case 'boolean': {
      const normalized = rawValue.trim().toLowerCase();
      if (normalized === 'true') {
        return true;
      }
      if (normalized === 'false') {
        return false;
      }
      throw new Error(`Workflow input "${name}" must be "true" or "false"`);
    }
    case 'choice': {
      // Choice options on the `model` input are normalized to concrete model
      // ids by `normalizePipeline`, so a provided alias (`$cheap`) must go
      // through the same resolution before comparison — and the resolved id
      // is what flows downstream so validation and execution agree.
      const candidate =
        name === 'model' ? resolvePipelineModelAlias(rawValue) : rawValue;
      if (definition.options?.includes(candidate)) {
        return candidate;
      }
      throw new Error(
        `Workflow input "${name}" must be one of: ${(definition.options ?? []).join(', ')}`,
      );
    }
    case 'json':
      try {
        const parsed: unknown = JSON.parse(rawValue);
        if (!isPipelineInputValue(parsed)) {
          throw new Error('not JSON-safe');
        }
        return parsed;
      } catch {
        throw new Error(`Workflow input "${name}" must be valid JSON`);
      }
  }
}

export function getNormalizedTriggerInputDefs(
  normalizedPipeline: NormalizedPipeline,
  eventName: PipelineTriggerType,
): Record<string, PipelineInputDef> | undefined {
  if (eventName === 'dispatch') {
    return (
      normalizedPipeline.trigger_inputs?.dispatch ?? normalizedPipeline.inputs
    );
  }

  if (normalizedPipeline.trigger_inputs) {
    return normalizedPipeline.trigger_inputs[eventName];
  }

  return undefined;
}

export function resolvePipelineInputs(
  definitions: Record<string, PipelineInputDef> | undefined,
  provided: Record<string, string> | undefined,
): Record<string, PipelineInputValue> {
  const declaredInputs = definitions ?? {};
  const rawInputs = provided ?? {};
  const resolved: Record<string, PipelineInputValue> = {};
  const errors: string[] = [];

  for (const inputName of Object.keys(rawInputs)) {
    if (!(inputName in declaredInputs)) {
      errors.push(`Workflow input "${inputName}" is not declared`);
    }
  }

  for (const [inputName, definition] of Object.entries(declaredInputs)) {
    const rawValue = rawInputs[inputName];
    if (rawValue !== undefined) {
      try {
        resolved[inputName] = parsePipelineInputValue(
          inputName,
          definition,
          rawValue,
        );
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
      continue;
    }

    if (definition.default !== undefined) {
      resolved[inputName] = definition.default;
      continue;
    }

    if (definition.required) {
      errors.push(`Workflow input "${inputName}" is required`);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      [
        'Workflow input validation failed:',
        ...errors.map((error) => `- ${error}`),
      ].join('\n'),
    );
  }

  return resolved;
}

export function mergePipelineInputs(
  definitions: Record<string, PipelineInputDef> | undefined,
  existing: Record<string, PipelineInputValue> | undefined,
  overrides: Record<string, string> | undefined,
): Record<string, PipelineInputValue> {
  const existingInputs = existing ?? {};
  const rawOverrides = overrides ?? {};
  if (!definitions) {
    const overrideNames = Object.keys(rawOverrides);
    if (overrideNames.length > 0) {
      throw new Error(
        [
          'Workflow input validation failed:',
          ...overrideNames.map(
            (inputName) => `- Workflow input "${inputName}" is not declared`,
          ),
        ].join('\n'),
      );
    }

    return { ...existingInputs };
  }

  const declaredInputs = definitions;
  const resolved: Record<string, PipelineInputValue> = {};
  const errors: string[] = [];

  for (const inputName of Object.keys(rawOverrides)) {
    if (!(inputName in declaredInputs)) {
      errors.push(`Workflow input "${inputName}" is not declared`);
    }
  }

  for (const [inputName, definition] of Object.entries(declaredInputs)) {
    const rawOverride = rawOverrides[inputName];
    if (rawOverride !== undefined) {
      try {
        resolved[inputName] = parsePipelineInputValue(
          inputName,
          definition,
          rawOverride,
        );
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
      continue;
    }

    if (inputName in existingInputs) {
      resolved[inputName] = existingInputs[inputName];
      continue;
    }

    if (definition.default !== undefined) {
      resolved[inputName] = definition.default;
      continue;
    }

    if (definition.required) {
      errors.push(`Workflow input "${inputName}" is required`);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      [
        'Workflow input validation failed:',
        ...errors.map((error) => `- ${error}`),
      ].join('\n'),
    );
  }

  return resolved;
}

export function parseOutputFile(content: string): Record<string, string> {
  const outputs: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    if (!rawLine) {
      continue;
    }

    const separatorIndex = rawLine.indexOf('=');
    if (separatorIndex < 0) {
      throw new Error(`Invalid output line "${rawLine}"`);
    }

    const key = rawLine.slice(0, separatorIndex);
    if (!key) {
      throw new Error(`Invalid output line "${rawLine}"`);
    }

    outputs[key] = rawLine.slice(separatorIndex + 1);
  }

  return outputs;
}

export function buildExpressionContext(
  input: Partial<ExpressionContext>,
): ExpressionContext {
  const canopy = input.canopy ?? {
    event_name: 'dispatch',
    event: {},
    ...buildExpressionCanopyIdentity({}),
  };
  const context: ExpressionContext = {
    env: input.env ?? {},
    inputs: input.inputs ?? {},
    steps: input.steps ?? {},
    needs: input.needs ?? {},
    job: input.job ?? {
      is_retry: false,
      retry_count: 0,
      max_retries: 0,
    },
    canopy,
    ...(input.matrix ? { matrix: input.matrix } : {}),
    ...(input.assets ? { assets: input.assets } : {}),
  };
  context[BRAND.internalName] = canopy;
  context[toExpressionRoot(BRAND.internalName)] = canopy;
  return context;
}

export function rehydrateJobContext(
  normalizedJob: NormalizedJob,
  jobResult: JobResult,
): RehydratedJobContext {
  const steps: Record<string, ExpressionStepState> = {};
  const dynamicEnv: Record<string, string> = {};

  for (const step of normalizedJob.steps) {
    const stepResult = jobResult.steps[step.id];
    if (!stepResult) {
      continue;
    }

    steps[step.id] = {
      outputs: { ...stepResult.outputs },
      outcome: stepResult.outcome,
      conclusion: stepResult.conclusion,
    };

    Object.assign(dynamicEnv, stepResult.dynamic_env);
  }

  return { steps, dynamicEnv };
}
