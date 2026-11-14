import {
  normalizeAgentAliasBase,
  resolvePipelineAgentAliasRoute,
} from './agent-alias-model';
import { STATIC_MODEL_REFERENCE_ALIASES } from './static-model-reference-aliases';
import {
  getJobOrder,
  normalizeNeeds,
  parseLogFormatHint,
  type Job,
  type Pipeline,
  type PipelineInputDef,
  type PipelineInputType,
  type PipelineInputValue,
  type PipelineModelAlias,
  type PipelineModelAliasDefaults,
  type PipelinePluginCollection,
  type PipelinePluginDefault,
  type PipelineScalar,
  type PipelineTrigger,
  type PipelineTriggerType,
  type ShellType,
  type Step,
} from './document';
import {
  getPipelinePluginDefaultKey,
  getPipelinePluginDefaultRef,
} from './plugin-defaults';
import { normalizePipelineAssets, normalizePipelineLocalState } from './assets';
import { validatePipelineSandboxHint } from './sandbox-size';
import { normalizePipelineScopes } from './scope';
import { normalizePipelineRunTarget } from './target';
import {
  getShareablePluginRefKey,
  normalizeGitHubRepoRef,
} from '@canopy/protocol/plugins';
import {
  assertNoSecretLikeContent,
  normalizePipelineDependency,
} from '@canopy/protocol/pipelines';
import type {
  NormalizedPipelineDependency,
  PipelineDependencyAffectedStep,
} from './document';
import type {
  NormalizedJob,
  NormalizedPipeline,
  NormalizedStep,
} from './document';
import { isPipelineInputValue } from './json-values';
import { AGENT_MODEL_PREFIX } from '@canopy/protocol/agents';
import {
  expandStaticMatrix,
  MATRIX_JOB_ID_PREFIX,
  MAX_MATRIX_VARIANTS,
  normalizeMatrixStrategy,
} from './matrix';

export const DEFAULT_TIMEOUT_MINUTES = 360;
export const DEFAULT_SHELL = 'bash';
export const MAX_RETRIES_LIMIT = 50;
export const MAX_ITERATIONS_LIMIT = 50;
const PIPELINE_INPUT_TYPES = new Set<PipelineInputType>([
  'string',
  'boolean',
  'number',
  'choice',
  'json',
]);

/**
 * Identifiers used in expressions (job keys, step ids) must be safe for the
 * expression evaluator's property-access syntax. Hyphens are parsed as minus,
 * whitespace breaks tokenisation, and leading digits confuse the lexer.
 */
const VALID_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const VALID_RUNTIME_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;
const RESERVED_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const PLUGIN_COLLECTION_ACTIONS = new Set([
  'builtin/agent-prompt',
  'builtin/agent-resume',
  'builtin/send-agent-message',
]);
const MODEL_ALIAS_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const RESERVED_AGENT_PLUGIN_COLLECTION_PREFIX = '__canopy_agent_model__:';

const PIPELINE_MODEL_ALIASES = STATIC_MODEL_REFERENCE_ALIASES;

export function resolvePipelineModelAlias(model: string): string {
  const resolved = PIPELINE_MODEL_ALIASES[model];
  if (resolved) {
    return resolved;
  }
  if (/^\$[a-z][a-z0-9-]*$/.test(model)) {
    throw new Error(`Unknown pipeline model alias "${model}"`);
  }
  return model;
}

/**
 * Non-throwing variant for display/edit surfaces (hook editors, activity
 * views) that render configs they did not validate: known aliases resolve to
 * their target model, anything else — including an unknown `$...` id — is
 * returned unchanged for the caller to render as-is.
 */
export function resolvePipelineModelAliasLenient(model: string): string {
  return PIPELINE_MODEL_ALIASES[model] ?? model;
}

function resolvePipelineModelAliasesInEnvironment(
  environment: Record<string, PipelineScalar> | undefined,
): Record<string, PipelineScalar> | undefined {
  if (!environment) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(environment).map(([key, value]) => [
      key,
      typeof value === 'string' && (key === 'MODEL' || key.endsWith('_MODEL'))
        ? resolvePipelineModelAlias(value)
        : value,
    ]),
  );
}

interface NormalizedJobMaxIterations {
  maxIterations?: number;
  maxIterationsExpression?: string;
}

export function validatePipelineIdentifier(
  value: string,
  kind: string,
  parent?: string,
): void {
  if (!VALID_IDENTIFIER.test(value)) {
    const location = parent ? ` in ${parent}` : '';
    throw new Error(
      `Invalid ${kind} "${value}"${location}: ` +
        'identifiers must start with a letter or underscore and contain only ' +
        'letters, digits, and underscores (no hyphens or whitespace)',
    );
  }
}

/**
 * Validates a persisted runtime identifier used as a lookup key or log-path
 * segment. This accepts the hyphenated identifiers written by older state
 * versions while excluding path separators and traversal syntax.
 */
export function validatePipelineRuntimeIdentifier(
  value: string,
  kind: string,
): void {
  if (!VALID_RUNTIME_IDENTIFIER.test(value)) {
    throw new Error(
      `Invalid ${kind} "${value}": identifiers must start with a letter or underscore and contain only letters, digits, underscores, and hyphens`,
    );
  }
}

function validateInputDefaultValue(
  inputName: string,
  type: PipelineInputType,
  value: PipelineInputValue,
  min?: number,
  max?: number,
  options?: string[],
): void {
  switch (type) {
    case 'string':
      if (typeof value !== 'string') {
        throw new Error(
          `Pipeline input "${inputName}" has invalid default value: expected a string`,
        );
      }
      return;
    case 'boolean':
      if (typeof value !== 'boolean') {
        throw new Error(
          `Pipeline input "${inputName}" has invalid default value: expected a boolean`,
        );
      }
      return;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(
          `Pipeline input "${inputName}" has invalid default value: expected a finite number`,
        );
      }
      if (min !== undefined && value < min) {
        throw new Error(
          `Pipeline input "${inputName}" has invalid default value: expected a number >= ${String(min)}`,
        );
      }
      if (max !== undefined && value > max) {
        throw new Error(
          `Pipeline input "${inputName}" has invalid default value: expected a number <= ${String(max)}`,
        );
      }
      return;
    case 'choice':
      if (typeof value !== 'string' || !options?.includes(value)) {
        throw new Error(
          `Pipeline input "${inputName}" has invalid default value: expected one of the configured options`,
        );
      }
      return;
    case 'json':
      if (!isPipelineInputValue(value)) {
        throw new Error(
          `Pipeline input "${inputName}" has invalid default value: expected a JSON-safe value`,
        );
      }
      return;
  }
}

export function isExpressionTemplate(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.startsWith('${{') || !trimmed.endsWith('}}')) {
    return false;
  }

  const expression = trimmed.slice(3, -2);
  return (
    expression.trim().length > 0 &&
    !expression.includes('${{') &&
    !expression.includes('}}')
  );
}

/**
 * YAML (JSON_SCHEMA) parses unquoted `if: false` / `if: true` to booleans,
 * not strings, even though the schema types declare `if?: string`. Coerce
 * booleans to the equivalent condition strings so `evaluateCondition`
 * receives a string expression (the evaluator understands `true`/`false`
 * literals) instead of crashing the execution at runtime. Any other
 * non-string value is a definition error surfaced at save/normalize time.
 */
function normalizeCondition(
  rawValue: unknown,
  location: string,
): string | undefined {
  if (rawValue === undefined || rawValue === null) {
    return undefined;
  }
  if (typeof rawValue === 'string') {
    return rawValue;
  }
  if (typeof rawValue === 'boolean') {
    return rawValue ? 'true' : 'false';
  }
  throw new Error(
    `${location} has invalid if condition (${typeof rawValue}): must be a string expression or boolean`,
  );
}

function normalizeJobMaxIterations(
  jobKey: string,
  rawValue: Job['max_iterations'],
): NormalizedJobMaxIterations {
  if (rawValue === undefined) {
    return {};
  }

  if (typeof rawValue === 'number') {
    if (
      !Number.isSafeInteger(rawValue) ||
      rawValue < 0 ||
      rawValue > MAX_ITERATIONS_LIMIT
    ) {
      throw new Error(
        `Job "${jobKey}" has invalid max_iterations "${String(rawValue)}": must be 0-${MAX_ITERATIONS_LIMIT} or an expression`,
      );
    }

    return { maxIterations: rawValue };
  }

  if (typeof rawValue !== 'string') {
    throw new Error(
      `Job "${jobKey}" has invalid max_iterations "${String(rawValue)}": must be 0-${MAX_ITERATIONS_LIMIT} or an expression`,
    );
  }

  const trimmed = rawValue.trim();
  if (!trimmed || !isExpressionTemplate(trimmed)) {
    throw new Error(
      `Job "${jobKey}" has invalid max_iterations "${String(rawValue)}": must be 0-${MAX_ITERATIONS_LIMIT} or an expression`,
    );
  }

  return {
    maxIterationsExpression: trimmed,
  };
}

const SUPPORTED_TRIGGER_TYPES = new Set([
  'dispatch',
  'plan_ready',
  'task_ready',
  'workflow',
]);

interface ExtractedTriggerInputs {
  dispatch?: Record<string, PipelineInputDef>;
  plan_ready?: Record<string, PipelineInputDef>;
  task_ready?: Record<string, PipelineInputDef>;
  workflow?: Record<string, PipelineInputDef>;
}

function validateTriggerObject(
  triggerValue: unknown,
  triggerName: string,
): void {
  if (triggerValue === undefined || triggerValue === null) {
    return;
  }
  if (typeof triggerValue !== 'object' || Array.isArray(triggerValue)) {
    throw new Error(
      `Pipeline "on.${triggerName}" must be a plain object ` +
        `(e.g., \`${triggerName}: { inputs: { ... } }\`) or omitted.`,
    );
  }
}

function extractTriggerInputs(on: PipelineTrigger): ExtractedTriggerInputs {
  if (typeof on === 'string') {
    if (!SUPPORTED_TRIGGER_TYPES.has(on)) {
      throw new Error(
        `Unsupported trigger type "${on}". Supported types: ${Array.from(SUPPORTED_TRIGGER_TYPES).join(', ')}`,
      );
    }
    return {};
  }

  if (!on || typeof on !== 'object' || Array.isArray(on)) {
    throw new Error(
      'Pipeline "on" field must be a trigger type string (e.g., "dispatch") or a trigger configuration object',
    );
  }

  const keys = Object.keys(on);
  for (const key of keys) {
    if (!SUPPORTED_TRIGGER_TYPES.has(key)) {
      throw new Error(
        `Unsupported trigger type "${key}". Supported types: ${Array.from(SUPPORTED_TRIGGER_TYPES).join(', ')}`,
      );
    }
  }

  if (keys.length === 0) {
    throw new Error(
      'Pipeline "on" field must define at least one trigger type (e.g., "dispatch")',
    );
  }

  validateTriggerObject(on.dispatch, 'dispatch');
  validateTriggerObject(on.plan_ready, 'plan_ready');
  validateTriggerObject(on.task_ready, 'task_ready');
  validateTriggerObject(on.workflow, 'workflow');

  const result: ExtractedTriggerInputs = {};

  if (on.dispatch && typeof on.dispatch === 'object') {
    result.dispatch = on.dispatch.inputs;
  }

  if (on.plan_ready && typeof on.plan_ready === 'object') {
    result.plan_ready = on.plan_ready.inputs;
  }

  if (on.task_ready && typeof on.task_ready === 'object') {
    result.task_ready = on.task_ready.inputs;
  }

  if (on.workflow && typeof on.workflow === 'object') {
    result.workflow = on.workflow.inputs;
  }

  return result;
}

function normalizePipelineInputs(
  inputs: Record<string, PipelineInputDef> | undefined,
): Record<string, PipelineInputDef> | undefined {
  if (!inputs) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(inputs).map(([inputName, rawDefinition]) => {
      validatePipelineIdentifier(inputName, 'pipeline input name');

      if (
        !rawDefinition ||
        typeof rawDefinition !== 'object' ||
        Array.isArray(rawDefinition)
      ) {
        throw new Error(`Pipeline input "${inputName}" must be an object`);
      }

      const resolvedType = rawDefinition.type ?? 'string';
      if (!PIPELINE_INPUT_TYPES.has(resolvedType)) {
        throw new Error(
          `Pipeline input "${inputName}" has unsupported type "${String(rawDefinition.type)}"`,
        );
      }

      const normalizedMin = rawDefinition.min;
      const normalizedMax = rawDefinition.max;
      if (resolvedType === 'number') {
        if (
          normalizedMin !== undefined &&
          (typeof normalizedMin !== 'number' || !Number.isFinite(normalizedMin))
        ) {
          throw new Error(
            `Pipeline input "${inputName}" has invalid min value: expected a finite number`,
          );
        }
        if (
          normalizedMax !== undefined &&
          (typeof normalizedMax !== 'number' || !Number.isFinite(normalizedMax))
        ) {
          throw new Error(
            `Pipeline input "${inputName}" has invalid max value: expected a finite number`,
          );
        }
        if (
          normalizedMin !== undefined &&
          normalizedMax !== undefined &&
          normalizedMin > normalizedMax
        ) {
          throw new Error(
            `Pipeline input "${inputName}" has invalid numeric range: min cannot be greater than max`,
          );
        }
      } else if (normalizedMin !== undefined || normalizedMax !== undefined) {
        throw new Error(
          `Pipeline input "${inputName}" may only define min/max when type is "number"`,
        );
      }

      const isModelInput = inputName === 'model';
      let normalizedOptions: string[] | undefined;
      if (resolvedType === 'choice') {
        if (
          !Array.isArray(rawDefinition.options) ||
          rawDefinition.options.length === 0
        ) {
          throw new Error(
            `Pipeline input "${inputName}" with type "choice" must define a non-empty options array`,
          );
        }

        const seenOptions = new Set<string>();
        normalizedOptions = rawDefinition.options.map((option) => {
          if (typeof option !== 'string' || option.length === 0) {
            throw new Error(
              `Pipeline input "${inputName}" has an invalid choice option`,
            );
          }
          const normalizedOption = isModelInput
            ? resolvePipelineModelAlias(option)
            : option;
          if (seenOptions.has(normalizedOption)) {
            throw new Error(
              `Pipeline input "${inputName}" has duplicate choice option "${normalizedOption}"`,
            );
          }
          seenOptions.add(normalizedOption);
          return normalizedOption;
        });
      } else if (rawDefinition.options !== undefined) {
        throw new Error(
          `Pipeline input "${inputName}" may only define options when type is "choice"`,
        );
      }

      if (
        rawDefinition.required !== undefined &&
        typeof rawDefinition.required !== 'boolean'
      ) {
        throw new Error(
          `Pipeline input "${inputName}" has invalid required value: expected a boolean`,
        );
      }

      if (
        rawDefinition['hint-hide-ui-option'] !== undefined &&
        typeof rawDefinition['hint-hide-ui-option'] !== 'boolean'
      ) {
        throw new Error(
          `Pipeline input "${inputName}" has invalid hint-hide-ui-option value: expected a boolean`,
        );
      }

      const normalizedDefault =
        isModelInput && typeof rawDefinition.default === 'string'
          ? resolvePipelineModelAlias(rawDefinition.default)
          : rawDefinition.default;
      if (normalizedDefault !== undefined) {
        validateInputDefaultValue(
          inputName,
          resolvedType,
          normalizedDefault,
          normalizedMin,
          normalizedMax,
          normalizedOptions,
        );
      }

      return [
        inputName,
        {
          description: rawDefinition.description,
          required: rawDefinition.required,
          default: normalizedDefault,
          type: resolvedType,
          options: normalizedOptions,
          min: normalizedMin,
          max: normalizedMax,
          'hint-hide-ui-option': rawDefinition['hint-hide-ui-option'],
        } satisfies PipelineInputDef,
      ];
    }),
  );
}

interface ResolvedStepDefaults {
  shell: NormalizedStep['shell'];
  timeout_minutes: number;
  working_directory?: string;
  continue_on_error: boolean;
  skip_on_missing_action: boolean;
}

function isAbsolutePath(pathValue: string): boolean {
  return (
    pathValue.startsWith('/') ||
    pathValue.startsWith('\\') ||
    /^[a-zA-Z]:[\\/]/.test(pathValue)
  );
}

function validateWorkingDirectory(
  workingDirectory: string | undefined,
  location: string,
): void {
  if (!workingDirectory) {
    return;
  }

  if (isAbsolutePath(workingDirectory)) {
    throw new Error(`${location} working_directory must be relative`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  context: string,
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${context} unexpected field "${key}"`);
    }
  }
}

function normalizeRequired(value: unknown, context: string): boolean {
  if (value === undefined) {
    return false;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`${context} required must be a boolean`);
  }
  return value;
}

function normalizePluginDefault(
  value: unknown,
  context: string,
): PipelinePluginDefault {
  if (!isRecord(value)) {
    throw new Error(`${context} must be an object`);
  }
  // Collection defaults are projected into dependency rows, so they carry
  // the same no-credentials contract as explicit manifest entries.
  assertNoSecretLikeContent(value, context);

  const required = normalizeRequired(value.required, context);
  if (value.type === 'bundle') {
    throw new Error(
      'plugin_collections defaults only support shareable skill, plugin, claude_plugin, and codex_plugin refs; Collections are local-only in pipeline defaults',
    );
  }

  if (value.type === 'skill') {
    assertOnlyKeys(
      value,
      ['type', 'source', 'skill_name', 'required'],
      context,
    );
    const rawSource = value.source;
    if (!isRecord(rawSource)) {
      throw new Error(`${context} skill source must be an object`);
    }
    const skillName =
      typeof value.skill_name === 'string' ? value.skill_name.trim() : '';
    if (!skillName) {
      throw new Error(`${context} skill_name must be a non-empty string`);
    }

    if (rawSource.type === 'builtin') {
      assertOnlyKeys(rawSource, ['type', 'id'], `${context} skill source`);
      if (rawSource.id !== 'app') {
        throw new Error(`${context} builtin skill source id must be "app"`);
      }
      return {
        type: 'skill',
        source: { type: 'builtin', id: 'app' },
        skill_name: skillName,
        required,
      };
    }

    assertOnlyKeys(rawSource, ['type', 'repo'], `${context} skill source`);
    if (rawSource.type !== 'github' || typeof rawSource.repo !== 'string') {
      throw new Error(`${context} skill source must be builtin or github`);
    }

    return {
      type: 'skill',
      source: {
        type: 'github',
        repo: normalizeGitHubRepoRef(rawSource.repo),
      },
      skill_name: skillName,
      required,
    };
  }

  if (value.type === 'plugin' || value.type === 'claude_plugin') {
    assertOnlyKeys(
      value,
      ['type', 'marketplace', 'plugin_name', 'required'],
      context,
    );
    const rawMarketplace = value.marketplace;
    if (!isRecord(rawMarketplace)) {
      throw new Error(`${context} marketplace must be an object`);
    }
    const pluginName =
      typeof value.plugin_name === 'string' ? value.plugin_name.trim() : '';
    if (!pluginName) {
      throw new Error(`${context} plugin_name must be a non-empty string`);
    }
    if (rawMarketplace.type === 'builtin') {
      assertOnlyKeys(rawMarketplace, ['type', 'id'], `${context} marketplace`);
      if (typeof rawMarketplace.id !== 'string' || !rawMarketplace.id.trim()) {
        throw new Error(
          `${context} builtin marketplace id must be a non-empty string`,
        );
      }
      return {
        type: value.type,
        marketplace: { type: 'builtin', id: 'app' },
        plugin_name: pluginName,
        required,
      };
    }

    assertOnlyKeys(rawMarketplace, ['type', 'repo'], `${context} marketplace`);
    if (
      rawMarketplace.type !== 'github' ||
      typeof rawMarketplace.repo !== 'string'
    ) {
      throw new Error(`${context} marketplace must be builtin or github`);
    }

    return {
      type: value.type,
      marketplace: {
        type: 'github',
        repo: normalizeGitHubRepoRef(rawMarketplace.repo),
      },
      plugin_name: pluginName,
      required,
    };
  }

  if (value.type === 'codex_plugin') {
    assertOnlyKeys(
      value,
      ['type', 'marketplace', 'plugin_name', 'required'],
      context,
    );
    const rawMarketplace = value.marketplace;
    if (!isRecord(rawMarketplace)) {
      throw new Error(`${context} marketplace must be an object`);
    }
    const pluginName =
      typeof value.plugin_name === 'string' ? value.plugin_name.trim() : '';
    if (!pluginName) {
      throw new Error(`${context} plugin_name must be a non-empty string`);
    }

    if (rawMarketplace.type !== 'codex-builtin') {
      throw new Error(
        `${context} marketplace must be codex-builtin for codex_plugin refs`,
      );
    }
    assertOnlyKeys(rawMarketplace, ['type', 'id'], `${context} marketplace`);
    if (typeof rawMarketplace.id !== 'string' || !rawMarketplace.id.trim()) {
      throw new Error(
        `${context} codex-builtin marketplace id must be a non-empty string`,
      );
    }

    return {
      type: 'codex_plugin',
      marketplace: {
        type: 'codex-builtin',
        id: rawMarketplace.id.trim(),
      },
      plugin_name: pluginName,
      required,
    };
  }

  throw new Error(
    `${context} type must be "skill", "plugin", "claude_plugin", or "codex_plugin"`,
  );
}

function normalizePluginCollections(
  collections: unknown,
): PipelinePluginCollection[] | undefined {
  if (collections === undefined) {
    return undefined;
  }
  if (!Array.isArray(collections)) {
    throw new Error('Pipeline plugin_collections must be an array');
  }

  const seenCollectionIds = new Set<string>();
  const normalized: PipelinePluginCollection[] = [];
  const rawCollections: readonly unknown[] = collections;
  for (
    let collectionIndex = 0;
    collectionIndex < rawCollections.length;
    collectionIndex += 1
  ) {
    const rawCollection = rawCollections[collectionIndex];
    const context = `Pipeline plugin_collections[${collectionIndex}]`;
    if (!isRecord(rawCollection)) {
      throw new Error(`${context} must be an object`);
    }

    const id =
      typeof rawCollection.id === 'string' ? rawCollection.id.trim() : '';
    if (!id) {
      throw new Error(`${context} id must be a non-empty string`);
    }
    if (id.startsWith(RESERVED_AGENT_PLUGIN_COLLECTION_PREFIX)) {
      throw new Error(
        `${context} id cannot start with reserved prefix "${RESERVED_AGENT_PLUGIN_COLLECTION_PREFIX}"`,
      );
    }
    if (seenCollectionIds.has(id)) {
      throw new Error(`Duplicate plugin collection id "${id}"`);
    }
    seenCollectionIds.add(id);

    const name =
      typeof rawCollection.name === 'string' ? rawCollection.name.trim() : '';
    if (!name) {
      throw new Error(`${context} name must be a non-empty string`);
    }
    if (!Array.isArray(rawCollection.defaults)) {
      throw new Error(`${context} defaults must be an array`);
    }

    const seenDefaultKeys = new Set<string>();
    const defaults = rawCollection.defaults.map((rawDefault, defaultIndex) => {
      const normalizedDefault = normalizePluginDefault(
        rawDefault,
        `${context}.defaults[${defaultIndex}]`,
      );
      const key = getPipelinePluginDefaultKey(normalizedDefault);
      if (seenDefaultKeys.has(key)) {
        throw new Error(`${context} contains duplicate default "${key}"`);
      }
      seenDefaultKeys.add(key);
      return normalizedDefault;
    });

    normalized.push({
      id,
      name,
      ...(typeof rawCollection.description === 'string' &&
      rawCollection.description.trim()
        ? { description: rawCollection.description.trim() }
        : {}),
      defaults,
    });
  }

  return normalized.length > 0 ? normalized : undefined;
}

const PROJECTED_DEPENDENCY_ID_PREFIX = 'collection:';

function dedupeAffectedSteps(
  steps: readonly PipelineDependencyAffectedStep[],
): PipelineDependencyAffectedStep[] {
  const seen = new Set<string>();
  const deduped: PipelineDependencyAffectedStep[] = [];
  for (const step of steps) {
    const key = `${step.job_id}\u0000${step.step_id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(step);
  }
  return deduped;
}

/**
 * Resolve bare manifest step ids against every job that defines them. Step
 * ids are only unique within a job, so one bare id may resolve to several
 * job/step pairs.
 */
function resolveDependencyAffectedSteps(
  jobs: Record<string, NormalizedJob>,
  stepIds: readonly string[] | undefined,
  context: string,
): PipelineDependencyAffectedStep[] {
  if (!stepIds) {
    return [];
  }
  const resolved: PipelineDependencyAffectedStep[] = [];
  for (const stepId of stepIds) {
    let found = false;
    for (const [jobId, job] of Object.entries(jobs)) {
      if (job.steps.some((step) => step.id === stepId)) {
        resolved.push({ job_id: jobId, step_id: stepId });
        found = true;
      }
    }
    if (!found) {
      throw new Error(
        `${context} steps references unknown step id "${stepId}"`,
      );
    }
  }
  return dedupeAffectedSteps(resolved);
}

/**
 * Steps a plugin collection reaches: those referencing it directly via
 * `with.plugin_collection_id`, plus those whose `with.model` resolves to a
 * model alias carrying that collection id.
 */
function resolvePluginCollectionAffectedSteps(
  jobs: Record<string, NormalizedJob>,
  collectionId: string,
  modelAliases: readonly PipelineModelAlias[] | undefined,
): PipelineDependencyAffectedStep[] {
  const aliasIds = new Set<string>();
  for (const alias of modelAliases ?? []) {
    const defaults = alias.defaults;
    if (
      defaults &&
      'plugin_collection_id' in defaults &&
      defaults.plugin_collection_id === collectionId
    ) {
      aliasIds.add(alias.id);
    }
  }

  const affected: PipelineDependencyAffectedStep[] = [];
  for (const [jobId, job] of Object.entries(jobs)) {
    for (const step of job.steps) {
      if (!step.uses || !PLUGIN_COLLECTION_ACTIONS.has(step.uses)) {
        continue;
      }
      const stepCollectionId =
        typeof step.with?.plugin_collection_id === 'string'
          ? step.with.plugin_collection_id.trim()
          : undefined;
      const stepModel =
        typeof step.with?.model === 'string'
          ? step.with.model.trim()
          : undefined;
      if (
        stepCollectionId === collectionId ||
        (stepModel !== undefined && aliasIds.has(stepModel))
      ) {
        affected.push({ job_id: jobId, step_id: step.id });
      }
    }
  }
  return dedupeAffectedSteps(affected);
}

/**
 * Build the unified dependency rows (CAN-1314): validated manifest entries
 * first, then one projected row per `plugin_collections` default that no
 * manifest entry claimed by portable ref key. A manifest entry that matches a
 * default is enriched (join key, required-OR, inherited affected steps) so a
 * plugin never appears as two rows.
 */
function normalizePipelineDependencies(
  rawDependencies: unknown,
  jobs: Record<string, NormalizedJob>,
  pluginCollections: readonly PipelinePluginCollection[] | undefined,
  modelAliases: readonly PipelineModelAlias[] | undefined,
): NormalizedPipelineDependency[] | undefined {
  if (rawDependencies !== undefined && !Array.isArray(rawDependencies)) {
    throw new Error('Pipeline dependencies must be an array');
  }

  const manifest: NormalizedPipelineDependency[] = [];
  const seenIds = new Set<string>();
  const explicitFallbackIds = new Set<string>();
  const manifestByRefKey = new Map<string, NormalizedPipelineDependency>();
  const rawEntries: readonly unknown[] = Array.isArray(rawDependencies)
    ? rawDependencies
    : [];
  for (let index = 0; index < rawEntries.length; index += 1) {
    const context = `Pipeline dependencies[${index}]`;
    const rawEntry = rawEntries[index];
    const dependency = normalizePipelineDependency(rawEntry, context);
    if (isRecord(rawEntry) && rawEntry.fallback !== undefined) {
      explicitFallbackIds.add(dependency.id);
    }
    if (dependency.id.startsWith(PROJECTED_DEPENDENCY_ID_PREFIX)) {
      throw new Error(
        `${context} id cannot start with reserved prefix "${PROJECTED_DEPENDENCY_ID_PREFIX}"`,
      );
    }
    if (seenIds.has(dependency.id)) {
      throw new Error(`Duplicate pipeline dependency id "${dependency.id}"`);
    }
    seenIds.add(dependency.id);
    if (dependency.fallback === 'queue') {
      throw new Error(`${context} fallback "queue" is not supported yet`);
    }

    const normalized: NormalizedPipelineDependency = {
      ...dependency,
      origin: 'manifest',
      scope: dependency.steps === undefined ? 'pipeline' : 'steps',
      affected_steps: resolveDependencyAffectedSteps(
        jobs,
        dependency.steps,
        context,
      ),
    };
    if (normalized.kind === 'plugin' || normalized.kind === 'skill') {
      const refKey = getShareablePluginRefKey(normalized.ref);
      if (manifestByRefKey.has(refKey)) {
        throw new Error(
          `Pipeline dependencies contain duplicate ref "${refKey}"`,
        );
      }
      manifestByRefKey.set(refKey, normalized);
    }
    manifest.push(normalized);
  }

  const projectedByKey = new Map<string, NormalizedPipelineDependency>();
  for (const collection of pluginCollections ?? []) {
    const collectionSteps = resolvePluginCollectionAffectedSteps(
      jobs,
      collection.id,
      modelAliases,
    );
    for (const collectionDefault of collection.defaults) {
      const defaultKey = getPipelinePluginDefaultKey(collectionDefault);
      const required =
        collectionDefault.required === true && collectionSteps.length > 0;

      const manifestEntry = manifestByRefKey.get(defaultKey);
      if (manifestEntry) {
        manifestEntry.plugin_collection_default_key = defaultKey;
        manifestEntry.required = manifestEntry.required || required;
        // Promotion to required must not leave a defaulted `skip` fallback in
        // place; an explicitly declared fallback is author intent and wins.
        if (
          manifestEntry.required &&
          !explicitFallbackIds.has(manifestEntry.id)
        ) {
          manifestEntry.fallback = 'block';
        }
        // A merged entry inherits the collection's referencing steps unless
        // the author declared `steps` explicitly. An unreferenced collection
        // must not erase a manifest entry's pipeline-wide reach.
        if (manifestEntry.steps === undefined && collectionSteps.length > 0) {
          manifestEntry.scope = 'steps';
          manifestEntry.affected_steps = dedupeAffectedSteps([
            ...manifestEntry.affected_steps,
            ...collectionSteps,
          ]);
        }
        continue;
      }

      const existing = projectedByKey.get(defaultKey);
      if (existing) {
        existing.required = existing.required || required;
        if (existing.required) {
          existing.fallback = 'block';
        }
        existing.affected_steps = dedupeAffectedSteps([
          ...existing.affected_steps,
          ...collectionSteps,
        ]);
        continue;
      }

      const ref = getPipelinePluginDefaultRef(collectionDefault);
      const common = {
        id: `${PROJECTED_DEPENDENCY_ID_PREFIX}${defaultKey}`,
        required,
        fallback: required ? ('block' as const) : ('skip' as const),
        origin: 'plugin_collection' as const,
        scope: 'steps' as const,
        affected_steps: collectionSteps,
        plugin_collection_default_key: defaultKey,
      };
      projectedByKey.set(
        defaultKey,
        ref.type === 'skill'
          ? { ...common, kind: 'skill', ref }
          : { ...common, kind: 'plugin', ref },
      );
    }
  }

  const all = [...manifest, ...Array.from(projectedByKey.values())];
  if (all.length === 0) {
    return undefined;
  }

  const allIds = new Set(all.map((dependency) => dependency.id));
  for (const dependency of manifest) {
    for (const alternative of dependency.alternatives ?? []) {
      if (alternative === dependency.id) {
        throw new Error(
          `Pipeline dependency "${dependency.id}" cannot list itself as an alternative`,
        );
      }
      if (!allIds.has(alternative)) {
        throw new Error(
          `Pipeline dependency "${dependency.id}" references unknown alternative "${alternative}"`,
        );
      }
    }
  }

  return all;
}

function normalizeModelAliasDefaults(
  rawDefaults: unknown,
  context: string,
): PipelineModelAliasDefaults {
  if (!isRecord(rawDefaults)) {
    throw new Error(`${context} must be an object`);
  }

  const hasBase = Object.prototype.hasOwnProperty.call(rawDefaults, 'base');
  const hasAgentId = Object.prototype.hasOwnProperty.call(
    rawDefaults,
    'agent_id',
  );
  if (!hasBase && !hasAgentId) {
    throw new Error(`${context} must specify base or agent_id`);
  }

  if (hasAgentId) {
    const agentId =
      typeof rawDefaults.agent_id === 'string'
        ? rawDefaults.agent_id.trim()
        : '';
    if (!agentId || !agentId.startsWith(AGENT_MODEL_PREFIX)) {
      throw new Error(
        `${context} agent_id must be a non-empty agent_model_* string`,
      );
    }
    const defaults = {
      agent_id: agentId,
      ...normalizeAgentAliasBase(rawDefaults.base),
    };
    resolvePipelineAgentAliasRoute(defaults);
    return defaults;
  }

  const base =
    typeof rawDefaults.base === 'string' ? rawDefaults.base.trim() : '';
  if (!base) {
    throw new Error(`${context} base must be a non-empty string`);
  }
  if (base.startsWith(AGENT_MODEL_PREFIX)) {
    throw new Error(
      `${context} base cannot be an agent_model_* id; use agent_id`,
    );
  }
  const instructions =
    rawDefaults.instructions === undefined
      ? undefined
      : typeof rawDefaults.instructions === 'string'
        ? rawDefaults.instructions
        : null;
  if (instructions === null) {
    throw new Error(`${context} instructions must be a string`);
  }
  const pluginCollectionId =
    rawDefaults.plugin_collection_id === undefined
      ? undefined
      : typeof rawDefaults.plugin_collection_id === 'string'
        ? rawDefaults.plugin_collection_id.trim()
        : null;
  if (pluginCollectionId === null || pluginCollectionId === '') {
    throw new Error(
      `${context} plugin_collection_id must be a non-empty string`,
    );
  }

  return {
    base: resolvePipelineModelAlias(base),
    ...(instructions !== undefined ? { instructions } : {}),
    ...(pluginCollectionId ? { plugin_collection_id: pluginCollectionId } : {}),
  };
}

function normalizeModelAliases(
  aliases: unknown,
): PipelineModelAlias[] | undefined {
  if (aliases === undefined) return undefined;
  if (!Array.isArray(aliases)) {
    throw new Error('Pipeline model_aliases must be an array');
  }

  const seenIds = new Set<string>();
  const normalized: PipelineModelAlias[] = [];

  aliases.forEach((rawAlias, index) => {
    const context = `Pipeline model_aliases[${index}]`;
    if (!isRecord(rawAlias)) {
      throw new Error(`${context} must be an object`);
    }

    const id = typeof rawAlias.id === 'string' ? rawAlias.id.trim() : '';
    if (!id) throw new Error(`${context} id must be a non-empty string`);
    if (!MODEL_ALIAS_ID_PATTERN.test(id)) {
      throw new Error(
        `${context} id must start with a letter or number and contain only letters, numbers, underscores, and hyphens`,
      );
    }
    if (seenIds.has(id)) {
      throw new Error(`Duplicate model alias id "${id}"`);
    }
    seenIds.add(id);

    const name = typeof rawAlias.name === 'string' ? rawAlias.name.trim() : '';
    if (!name) throw new Error(`${context} name must be a non-empty string`);

    const description =
      rawAlias.description === undefined
        ? undefined
        : typeof rawAlias.description === 'string'
          ? rawAlias.description.trim()
          : null;
    if (description === null) {
      throw new Error(`${context} description must be a string`);
    }

    const defaults =
      rawAlias.defaults === undefined
        ? undefined
        : normalizeModelAliasDefaults(rawAlias.defaults, `${context}.defaults`);

    normalized.push({
      id,
      name,
      ...(description ? { description } : {}),
      ...(defaults ? { defaults } : {}),
    });
  });

  return normalized.length > 0 ? normalized : undefined;
}

function validateModelAliasPluginCollectionReferences(
  aliases: readonly PipelineModelAlias[] | undefined,
  collections: readonly PipelinePluginCollection[] | undefined,
): void {
  const ids = new Set((collections ?? []).map((collection) => collection.id));
  for (const alias of aliases ?? []) {
    const defaults = alias.defaults;
    if (!defaults) continue;
    if (
      !('plugin_collection_id' in defaults) ||
      !defaults.plugin_collection_id
    ) {
      continue;
    }
    if (!ids.has(defaults.plugin_collection_id)) {
      throw new Error(
        `Pipeline model alias "${alias.id}" references unknown plugin_collection_id "${defaults.plugin_collection_id}"`,
      );
    }
  }
}

function validatePluginCollectionReferences(
  pipeline: Pick<NormalizedPipeline, 'jobs'>,
  collections: readonly PipelinePluginCollection[] | undefined,
): void {
  const ids = new Set((collections ?? []).map((collection) => collection.id));
  for (const [jobId, job] of Object.entries(pipeline.jobs)) {
    for (const step of job.steps) {
      if (
        !step.uses ||
        !PLUGIN_COLLECTION_ACTIONS.has(step.uses) ||
        step.with?.plugin_collection_id === undefined
      ) {
        continue;
      }

      if (typeof step.with.plugin_collection_id !== 'string') {
        throw new Error(
          `Step "${step.id}" in job "${jobId}" plugin_collection_id must be a string`,
        );
      }
      const collectionId = step.with.plugin_collection_id.trim();
      if (!ids.has(collectionId)) {
        throw new Error(
          `Step "${step.id}" in job "${jobId}" references unknown plugin_collection_id "${collectionId}"`,
        );
      }
    }
  }
}

export function assignStepIds(
  steps: Step[],
  jobKey: string,
  defaultShell: ShellType = DEFAULT_SHELL,
): NormalizedStep[] {
  const usedIds = new Set<string>();

  for (const step of steps) {
    if (!step.id) {
      continue;
    }
    validatePipelineIdentifier(step.id, 'step id', `job "${jobKey}"`);
    if (usedIds.has(step.id)) {
      throw new Error(`Duplicate step id "${step.id}" in job "${jobKey}"`);
    }
    usedIds.add(step.id);
  }

  let autoIndex = 0;
  return steps.map((step) => {
    if (step.id) {
      return {
        id: step.id,
        name: step.name,
        if: step.if,
        uses: step.uses,
        run: step.run,
        target: step.target,
        log_format_hint: step.log_format_hint,
        shell: defaultShell,
        with: step.with,
        env: step.env,
        continue_on_error: false,
        timeout_minutes: DEFAULT_TIMEOUT_MINUTES,
        working_directory: step.working_directory,
        skip_on_missing_action: false,
      };
    }

    let generatedId = `__auto_step_${autoIndex}`;
    while (usedIds.has(generatedId)) {
      autoIndex += 1;
      generatedId = `__auto_step_${autoIndex}`;
    }
    usedIds.add(generatedId);
    autoIndex += 1;

    return {
      id: generatedId,
      name: step.name,
      if: step.if,
      uses: step.uses,
      run: step.run,
      target: step.target,
      log_format_hint: step.log_format_hint,
      shell: defaultShell,
      with: step.with,
      env: step.env,
      continue_on_error: false,
      timeout_minutes: DEFAULT_TIMEOUT_MINUTES,
      working_directory: step.working_directory,
      skip_on_missing_action: false,
    };
  });
}

export function resolveStepDefaults(
  pipeline: Pipeline,
  job: Job,
  step: Step,
  defaultShell: ShellType = DEFAULT_SHELL,
): ResolvedStepDefaults {
  const pipelineRunDefaults = pipeline.defaults?.run;
  const jobRunDefaults = job.defaults?.run;

  const working_directory =
    step.working_directory ??
    jobRunDefaults?.working_directory ??
    pipelineRunDefaults?.working_directory;

  return {
    shell:
      step.shell ??
      jobRunDefaults?.shell ??
      pipelineRunDefaults?.shell ??
      defaultShell,
    timeout_minutes:
      step.timeout_minutes ?? job.timeout_minutes ?? DEFAULT_TIMEOUT_MINUTES,
    working_directory,
    continue_on_error: step.continue_on_error ?? false,
    skip_on_missing_action: step.skip_on_missing_action ?? false,
  };
}

function normalizeStep(
  pipeline: Pipeline,
  jobKey: string,
  job: Job,
  step: Step,
  generatedId: string,
  defaultShell: ShellType,
): NormalizedStep {
  const location = `Step "${generatedId}" in job "${jobKey}"`;
  const runCount = Number(Boolean(step.run)) + Number(Boolean(step.uses));
  if (runCount !== 1) {
    throw new Error(`${location} must define exactly one of run or uses`);
  }

  const logFormatHint = parseLogFormatHint(step.log_format_hint, location);
  if (step.run && logFormatHint !== undefined) {
    throw new Error(`${location} cannot define log_format_hint on run steps`);
  }

  const defaults = resolveStepDefaults(pipeline, job, step, defaultShell);
  validateWorkingDirectory(defaults.working_directory, `Step "${generatedId}"`);

  return {
    id: generatedId,
    name: step.name,
    if: normalizeCondition(step.if, location),
    uses: step.uses,
    run: step.run,
    target: normalizePipelineRunTarget(step.target, location),
    log_format_hint: logFormatHint,
    shell: defaults.shell,
    with:
      step.with && typeof step.with.model === 'string'
        ? {
            ...step.with,
            model: resolvePipelineModelAlias(step.with.model),
          }
        : step.with,
    env: resolvePipelineModelAliasesInEnvironment(step.env),
    continue_on_error: defaults.continue_on_error,
    timeout_minutes: defaults.timeout_minutes,
    working_directory: defaults.working_directory,
    skip_on_missing_action: defaults.skip_on_missing_action,
  };
}

function normalizeJob(
  pipeline: Pipeline,
  jobKey: string,
  job: Job,
  defaultShell: ShellType,
): NormalizedJob {
  const legacyFields = isRecord(job) ? job : undefined;
  const legacyErrors: string[] = [];
  if (legacyFields?.foreach !== undefined) {
    legacyErrors.push(
      `Job "${jobKey}" uses removed field "foreach". Replace it with "strategy.matrix"; see docs/pipelines.md#matrix-jobs.`,
    );
  }
  if (legacyFields?.max_parallel !== undefined) {
    legacyErrors.push(
      `Job "${jobKey}" defines legacy top-level "max_parallel". Move it to "strategy.max_parallel".`,
    );
  }
  if (legacyErrors.length > 0) {
    throw new Error(legacyErrors.join('\n'));
  }
  const maxRetries = job.max_retries ?? 0;
  if (
    !Number.isSafeInteger(maxRetries) ||
    maxRetries < 0 ||
    maxRetries > MAX_RETRIES_LIMIT
  ) {
    throw new Error(
      `Job "${jobKey}" has invalid max_retries "${String(job.max_retries)}": must be 0-${MAX_RETRIES_LIMIT}`,
    );
  }
  const { maxIterations, maxIterationsExpression } = normalizeJobMaxIterations(
    jobKey,
    job.max_iterations,
  );
  const strategy = normalizeMatrixStrategy(jobKey, job.strategy);
  let continueOnError = false;
  let continueOnErrorExpression: string | undefined;
  if (typeof job.continue_on_error === 'boolean') {
    continueOnError = job.continue_on_error;
  } else if (
    typeof job.continue_on_error === 'string' &&
    isExpressionTemplate(job.continue_on_error)
  ) {
    continueOnErrorExpression = job.continue_on_error.trim();
  } else if (job.continue_on_error !== undefined) {
    throw new Error(
      `Job "${jobKey}" continue_on_error must be a boolean or one complete expression`,
    );
  }

  const assignedSteps = assignStepIds(job.steps, jobKey, defaultShell);
  const steps = assignedSteps.map((assignedStep, index) =>
    normalizeStep(
      pipeline,
      jobKey,
      job,
      job.steps[index],
      assignedStep.id,
      defaultShell,
    ),
  );

  return {
    name: job.name?.trim() || jobKey,
    needs: normalizeNeeds(job.needs),
    if: normalizeCondition(job.if, `Job "${jobKey}"`),
    env: resolvePipelineModelAliasesInEnvironment(job.env),
    outputs: job.outputs,
    timeout_minutes: job.timeout_minutes ?? DEFAULT_TIMEOUT_MINUTES,
    max_retries: maxRetries,
    max_iterations: maxIterations,
    max_iterations_expression: maxIterationsExpression,
    strategy,
    continue_on_error: continueOnError,
    continue_on_error_expression: continueOnErrorExpression,
    steps,
  };
}

export interface NormalizePipelineOptions {
  /**
   * Default shell to use when a step does not specify one and no pipeline-
   * or job-level default is set. Callers running in an environment that knows
   * the host platform (e.g. the main process) should pass the platform-
   * appropriate shell here. Renderer/browser callers should rely on the
   * fallback `'bash'` or pass an explicit value derived from
   * `window.platform`.
   */
  defaultShell?: ShellType;
}

export function normalizePipeline(
  pipeline: Pipeline,
  options: NormalizePipelineOptions = {},
): NormalizedPipeline {
  const defaultShell = options.defaultShell ?? DEFAULT_SHELL;
  if (Object.prototype.hasOwnProperty.call(pipeline, 'inputs')) {
    throw new Error(
      'Pipeline defines top-level "inputs" which is no longer supported. Move inputs under "on.<trigger>.inputs" (e.g., "on.dispatch.inputs", "on.plan_ready.inputs", "on.task_ready.inputs", or "on.workflow.inputs").',
    );
  }

  if (pipeline.on === undefined || pipeline.on === null) {
    throw new Error(
      'Pipeline must define an "on" field specifying its trigger type (e.g., "on: dispatch").',
    );
  }

  for (const jobKey of Object.keys(pipeline.jobs)) {
    validatePipelineIdentifier(jobKey, 'job key');
    if (RESERVED_OBJECT_KEYS.has(jobKey)) {
      throw new Error(`Job key "${jobKey}" is reserved`);
    }
    if (jobKey.startsWith(MATRIX_JOB_ID_PREFIX)) {
      throw new Error(
        `Job key "${jobKey}" uses reserved prefix "${MATRIX_JOB_ID_PREFIX}"`,
      );
    }
  }

  getJobOrder(pipeline);

  const extracted = extractTriggerInputs(pipeline.on);
  const normalizedDispatchInputs = normalizePipelineInputs(extracted.dispatch);
  const normalizedPlanReadyInputs = normalizePipelineInputs(
    extracted.plan_ready,
  );
  const normalizedTaskReadyInputs = normalizePipelineInputs(
    extracted.task_ready,
  );
  const normalizedWorkflowInputs = normalizePipelineInputs(extracted.workflow);

  let triggerInputs:
    | Partial<Record<PipelineTriggerType, Record<string, PipelineInputDef>>>
    | undefined;

  if (
    normalizedDispatchInputs ||
    normalizedPlanReadyInputs ||
    normalizedTaskReadyInputs ||
    normalizedWorkflowInputs
  ) {
    triggerInputs = {};
    if (normalizedDispatchInputs) {
      triggerInputs.dispatch = normalizedDispatchInputs;
    }
    if (normalizedPlanReadyInputs) {
      triggerInputs.plan_ready = normalizedPlanReadyInputs;
    }
    if (normalizedTaskReadyInputs) {
      triggerInputs.task_ready = normalizedTaskReadyInputs;
    }
    if (normalizedWorkflowInputs) {
      triggerInputs.workflow = normalizedWorkflowInputs;
    }
  }

  const jobs = Object.fromEntries(
    Object.entries(pipeline.jobs).map(([jobKey, job]) => [
      jobKey,
      normalizeJob(pipeline, jobKey, job, defaultShell),
    ]),
  );
  let staticVariantCount = 0;
  for (const [jobId, job] of Object.entries(jobs)) {
    if (!job.strategy || job.strategy.dynamic) continue;
    staticVariantCount += expandStaticMatrix(jobId, job.strategy).length;
    if (staticVariantCount > MAX_MATRIX_VARIANTS) {
      throw new Error(
        `Pipeline generates ${String(staticVariantCount)} static matrix variants; the execution limit is ${String(MAX_MATRIX_VARIANTS)}`,
      );
    }
  }
  const pluginCollections = normalizePluginCollections(
    pipeline.plugin_collections,
  );
  const modelAliases = normalizeModelAliases(pipeline.model_aliases);
  validatePluginCollectionReferences({ jobs }, pluginCollections);
  validateModelAliasPluginCollectionReferences(modelAliases, pluginCollections);
  const dependencies = normalizePipelineDependencies(
    pipeline.dependencies,
    jobs,
    pluginCollections,
    modelAliases,
  );
  const assets = normalizePipelineAssets(pipeline.assets);
  const localState = normalizePipelineLocalState(pipeline.local_state);
  // Only a cloud run reads the sandbox hint; every host refuses a bad one.
  const sandboxProblem = validatePipelineSandboxHint(pipeline.sandbox);
  if (sandboxProblem !== null) throw new Error(sandboxProblem);

  return {
    name: pipeline.name,
    description: pipeline.description,
    icon: pipeline.icon,
    version: pipeline.version,
    scope: normalizePipelineScopes(pipeline.scope, 'Pipeline'),
    trigger_inputs: triggerInputs,
    inputs: normalizedDispatchInputs,
    env: resolvePipelineModelAliasesInEnvironment(pipeline.env),
    jobs,
    ...(pluginCollections ? { plugin_collections: pluginCollections } : {}),
    ...(modelAliases ? { model_aliases: modelAliases } : {}),
    ...(dependencies ? { dependencies } : {}),
    ...(assets ? { assets } : {}),
    ...(localState ? { local_state: localState } : {}),
  };
}
