export type {
  PipelineExecutionScope,
  PipelineTriggerType,
} from '@canopy/protocol/pipelines';
import type {
  PipelineDependency,
  PipelineDependencyInput,
} from '@canopy/protocol/pipelines';
import type {
  PipelineExecutionScope,
  PipelineTriggerType,
} from '@canopy/protocol/pipelines';
import type { PipelineSandboxHint } from './sandbox-size';
import type {
  ShareableClaudePluginRef,
  ShareableCodexPluginRef,
  ShareableDynamicPluginRef,
  ShareableSkillRef,
} from '@canopy/protocol/plugins';

/**
 * Definition alias for a pipeline/action `scope` declaration as it appears
 * in YAML: either a single execution scope or a non-empty array of them.
 * `inherit` is intentionally NOT part of this union — it is only valid for
 * `run-pipeline` step targets, never for a declared pipeline/action scope.
 */
export type PipelineScopeConfig =
  | PipelineExecutionScope
  | PipelineExecutionScope[];

export type PipelineScalar = string | number | boolean;

export type PipelineIntegerOrExpression = number | string;

/**
 * Any JSON-safe value. Used for matrix values and structured (`json`) trigger
 * inputs. Deliberately recursive so nested arrays/objects are
 * representable while non-JSON values (functions, `undefined`, `Date`, …) are
 * not.
 */
export type PipelineJsonValue =
  | null
  | string
  | number
  | boolean
  | PipelineJsonValue[]
  | { [key: string]: PipelineJsonValue };

export type PipelineMatrixCombination = Record<string, PipelineJsonValue>;

export type PipelineMatrixAxis = PipelineJsonValue[] | string;

export type PipelineMatrixDefinition =
  | string
  | Record<string, PipelineMatrixAxis | PipelineMatrixCombination[] | string>;

export interface JobStrategy {
  matrix: PipelineMatrixDefinition;
  fail_fast?: boolean;
  max_parallel?: number;
}

export type ShellType =
  | 'bash'
  | 'sh'
  | 'pwsh'
  | 'powershell'
  | 'cmd'
  | 'python'
  | 'node'
  | 'tsx';

export type LogFormatHint = 'agent';

export function parseLogFormatHint(
  value: unknown,
  location: string,
): LogFormatHint | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new Error(`${location} log_format_hint must be a string`);
  }

  const normalized = value.trim();
  switch (normalized) {
    case 'agent':
      return 'agent';
    default:
      throw new Error(
        `${location} log_format_hint "${String(value)}" is not supported. Supported values: agent`,
      );
  }
}

export interface RunDefaults {
  shell?: ShellType;
  working_directory?: string;
}

export interface PipelineDefaults {
  run?: RunDefaults;
}

/**
 * Target selection for a `builtin/run-pipeline` step. This is a first-class
 * step property (`target`), NOT an action input under `with`.
 *
 * YAML uses snake_case only (no camelCase aliases). A missing `target`
 * defaults to `{ scope: 'inherit' }`. `inherit` is valid only here, never as
 * a declared pipeline/action scope.
 *
 * - `directory.path` is optional; when omitted the child runs in the parent
 *   step's effective working directory. Relative paths resolve from that cwd.
 * - `worktree` requires `workspace_id` and `worktree.id` for an existing
 *   worktree. Create worktrees with `builtin/create-worktree`, then pass the
 *   returned id here.
 */
export type PipelineRunTarget =
  | { scope: 'inherit' }
  | { scope: 'global' }
  | { scope: 'directory'; path?: string }
  | {
      scope: 'worktree';
      workspace_id: string;
      worktree: { id: string };
    };

export interface Step {
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  target?: PipelineRunTarget;
  log_format_hint?: LogFormatHint;
  shell?: ShellType;
  with?: Record<string, PipelineScalar>;
  env?: Record<string, PipelineScalar>;
  continue_on_error?: boolean;
  timeout_minutes?: number;
  working_directory?: string;
  skip_on_missing_action?: boolean;
}

export interface Job {
  name?: string;
  needs?: string | string[];
  if?: string;
  env?: Record<string, PipelineScalar>;
  defaults?: PipelineDefaults;
  outputs?: Record<string, string>;
  timeout_minutes?: number;
  max_retries?: number;
  max_iterations?: PipelineIntegerOrExpression;
  continue_on_error?: boolean | string;
  strategy?: JobStrategy;
  steps: Step[];
}

export interface NormalizedStep {
  id: string;
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  target?: PipelineRunTarget;
  log_format_hint?: LogFormatHint;
  shell: ShellType;
  with?: Record<string, PipelineScalar>;
  env?: Record<string, PipelineScalar>;
  continue_on_error: boolean;
  timeout_minutes: number;
  working_directory?: string;
  skip_on_missing_action: boolean;
}

export interface NormalizedJob {
  name: string;
  needs: string[];
  if?: string;
  env?: Record<string, PipelineScalar>;
  outputs?: Record<string, string>;
  timeout_minutes: number;
  max_retries: number;
  max_iterations?: number;
  max_iterations_expression?: string;
  continue_on_error: boolean;
  continue_on_error_expression?: string;
  strategy?: NormalizedMatrixStrategy;
  steps: NormalizedStep[];
}

export interface NormalizedMatrixStrategy {
  matrix: PipelineMatrixDefinition;
  fail_fast: boolean;
  max_parallel?: number;
  dynamic: boolean;
}

export interface NormalizedPipeline {
  name: string;
  description?: string;
  icon?: string;
  version?: string;
  /**
   * Normalized execution scopes (always present after normalization). A
   * pipeline with no declared `scope` normalizes to `['directory']`.
   */
  scope: PipelineExecutionScope[];
  trigger_inputs?: Partial<
    Record<PipelineTriggerType, Record<string, PipelineInputDef>>
  >;
  inputs?: Record<string, PipelineInputDef>;
  env?: Record<string, PipelineScalar>;
  jobs: Record<string, NormalizedJob>;
  /**
   * Named collections of portable plugin defaults carried through from
   * `Pipeline.plugin_collections`. Present on the normalized shape so the
   * executor can resolve them without re-parsing the source.
   */
  plugin_collections?: PipelinePluginCollection[];
  /**
   * Validated named model abstractions carried through from
   * `Pipeline.model_aliases`. Present on the normalized shape so the executor
   * can resolve a step's `with.model` alias id without re-parsing the source.
   * (Backend owns the normalization logic; the transport layer only declares
   * the field.)
   */
  model_aliases?: PipelineModelAlias[];
  /**
   * Unified dependency rows (CAN-1314): every validated `Pipeline.dependencies`
   * entry plus one projected row per `plugin_collections` default that no
   * manifest entry claimed. Readiness surfaces and the executor consume this
   * list instead of re-deriving it from the raw manifest.
   */
  dependencies?: NormalizedPipelineDependency[];
  /** Validated `Pipeline.assets` with `required` and `install` defaulted. */
  assets?: NormalizedPipelineAssetDeclaration[];
  /** `Pipeline.local_state` carried through unchanged. */
  local_state?: string[];
}

/**
 * A concrete step affected by a dependency. `steps` in the manifest are bare
 * step ids; normalization resolves each id against every job that defines it
 * so downstream consumers never re-scan the job graph.
 */
export interface PipelineDependencyAffectedStep {
  job_id: string;
  step_id: string;
}

/**
 * A validated dependency row on the normalized pipeline shape.
 *
 * - `origin: 'manifest'` — declared in `Pipeline.dependencies` (possibly
 *   enriched with the `plugin_collections` default it matched by ref key).
 * - `origin: 'plugin_collection'` — projected from a `plugin_collections`
 *   default with no matching manifest entry; its id is
 *   `collection:<portable ref key>`.
 *
 * `scope` disambiguates an empty `affected_steps` array:
 *
 * - `scope: 'pipeline'` — the dependency affects the whole pipeline
 *   (manifest entry with no `steps` declaration and no collection linkage);
 *   `affected_steps` is always empty.
 * - `scope: 'steps'` — the dependency affects exactly `affected_steps`. An
 *   empty array here means no reachable step consumes it (e.g. a
 *   `plugin_collections` entry no step references), so there is nothing for
 *   missing-dependency handling to block.
 */
export type NormalizedPipelineDependency = PipelineDependency & {
  origin: 'manifest' | 'plugin_collection';
  scope: 'pipeline' | 'steps';
  affected_steps: PipelineDependencyAffectedStep[];
  /**
   * Portable ref key of the `plugin_collections` default this row represents
   * or was merged with, joining dependency rows to
   * `PipelinePluginDefaultPreviewItem.defaultKey`.
   */
  plugin_collection_default_key?: string;
};

export interface PipelineDispatchTrigger {
  inputs?: Record<string, PipelineInputDef>;
}

export interface PipelinePlanReadyTrigger {
  inputs?: Record<string, PipelineInputDef>;
}

export interface PipelineTaskReadyTrigger {
  inputs?: Record<string, PipelineInputDef>;
}

/**
 * Started from the Workflows page and its schedules (CAN-5782). Shaped like
 * `dispatch`; plugin collections stay top-level.
 */
export interface PipelineWorkflowTrigger {
  inputs?: Record<string, PipelineInputDef>;
}

export interface PipelineTriggerConfig {
  dispatch?: PipelineDispatchTrigger;
  plan_ready?: PipelinePlanReadyTrigger;
  task_ready?: PipelineTaskReadyTrigger;
  workflow?: PipelineWorkflowTrigger;
}

export type PipelineTrigger = PipelineTriggerType | PipelineTriggerConfig;

/**
 * Extract the active trigger types from a PipelineTrigger value.
 * Returns `['dispatch']` when trigger is missing (legacy pipelines).
 */
export function getTriggerTypes(
  trigger: PipelineTrigger | undefined | null,
): PipelineTriggerType[] {
  if (trigger == null) {
    return ['dispatch'];
  }

  const rawTypes: PipelineTriggerType[] = [];
  if (typeof trigger === 'string') {
    rawTypes.push(trigger);
  } else {
    if (trigger.dispatch !== undefined) {
      rawTypes.push('dispatch');
    }
    if (trigger.plan_ready !== undefined) {
      rawTypes.push('plan_ready');
    }
    if (trigger.task_ready !== undefined) {
      rawTypes.push('task_ready');
    }
    if (trigger.workflow !== undefined) {
      rawTypes.push('workflow');
    }
  }

  return Array.from(new Set(rawTypes));
}

export interface Pipeline {
  name: string;
  description?: string;
  icon?: string;
  version?: string;
  readonly?: boolean;
  /**
   * Declared execution scope(s) for this pipeline. A string or non-empty
   * string array of `global`/`directory`/`worktree`. When omitted, the
   * pipeline is treated as `directory` for backwards compatibility. No
   * existing YAML must be migrated.
   */
  scope?: PipelineScopeConfig;
  on: PipelineTrigger;
  env?: Record<string, PipelineScalar>;
  defaults?: PipelineDefaults;
  jobs: Record<string, Job>;
  /**
   * Optional named collections of portable plugin defaults that steps can
   * opt into via `with.plugin_collection_id` on `builtin/agent-prompt`,
   * `builtin/agent-resume` or `builtin/send-agent-message`. Only shareable skill and plugin refs are
   * permitted here; bundle refs are local-only.
   */
  plugin_collections?: PipelinePluginCollection[];
  /**
   * Optional named model abstractions that steps reference via
   * `with.model: <alias id>`. Each alias may be inline/portable or reference a
   * local Agent. This is the raw YAML-parsed form; the backend normalizes it
   * into `NormalizedPipeline.model_aliases`.
   */
  model_aliases?: PipelineModelAlias[];
  /**
   * Optional provider-neutral dependency manifest (CAN-1314): the plugins,
   * skills, MCP servers, connectors, local runtimes, and local packages this
   * pipeline uses, with required/optional and fallback declarations. Entries
   * matching a `plugin_collections` default by portable ref key enrich that
   * default's projected dependency row instead of adding a second row.
   * `required`/`fallback` may be omitted; normalization applies the defaults.
   */
  dependencies?: PipelineDependencyInput[];
  /**
   * Files this pipeline reads at run time, shared with it when its automation
   * is shared. Expressions read the resolved directory through
   * `${{ assets.<id>.path }}`.
   */
  assets?: PipelineAssetDeclaration[];
  /**
   * Per-runner state paths (databases, caches, checkouts) that must never
   * travel with a share. Asset paths may not overlap them.
   */
  local_state?: string[];
  /**
   * The cloud run sandbox this pipeline asks for (CAN-6325): `vcpus` raises
   * the run's default size. Desktop runs ignore it.
   */
  sandbox?: PipelineSandboxHint;
}

/** How an installed asset treats files that already exist on the recipient. */
export type PipelineAssetInstallMode = 'seed' | 'replace';

/** One `assets` entry as written in pipeline YAML. */
export interface PipelineAssetDeclaration {
  /** Matches `^[a-z][a-z0-9_]{0,31}$`; unique within the pipeline. */
  id: string;
  /** Author-side source directory; `~` expands to the home directory. */
  path: string;
  description?: string;
  /** Defaults to `true`. */
  required?: boolean;
  /** Defaults to `seed`. */
  install?: PipelineAssetInstallMode;
}

/** An `assets` entry after normalization applies the defaults. */
export interface NormalizedPipelineAssetDeclaration {
  id: string;
  path: string;
  description?: string;
  required: boolean;
  install: PipelineAssetInstallMode;
}

// ---------------------------------------------------------------------------
// Pipeline plugin-collection types (Phase T3)
// ---------------------------------------------------------------------------

/**
 * A single default entry inside a `PipelinePluginCollection`.
 * Only shareable skill and plugin refs are portable in pipeline YAML; bundle
 * refs are not allowed.
 */
export type PipelinePluginDefault =
  | (ShareableSkillRef & { required?: boolean })
  | (ShareableDynamicPluginRef & { required?: boolean })
  | (ShareableClaudePluginRef & { required?: boolean })
  | (ShareableCodexPluginRef & { required?: boolean });

/**
 * A named collection of portable plugin defaults. Steps reference a collection
 * by id via `with.plugin_collection_id`.
 */
export interface PipelinePluginCollection {
  id: string;
  name: string;
  description?: string;
  defaults: PipelinePluginDefault[];
}

// ---------------------------------------------------------------------------
// Pipeline model-alias types
// ---------------------------------------------------------------------------

/**
 * Inline/portable alias defaults: a concrete base model with optional Agent
 * instructions and an optional referenced plugin collection.
 */
export interface PipelineInlineModelAliasDefaults {
  base: string;
  instructions?: string;
  plugin_collection_id?: string;
}

/**
 * Agent-backed alias defaults: the alias resolves to a locally-defined Agent.
 */
export interface PipelineAgentModelAliasDefaults {
  agent_id: string;
}

/**
 * When present, an alias `defaults` object defines exactly one mode — inline or
 * Agent. An omitted `defaults` means the alias is a required configuration slot
 * that dispatch/automation must fill.
 */
export type PipelineModelAliasDefaults =
  | PipelineInlineModelAliasDefaults
  | PipelineAgentModelAliasDefaults;

/**
 * A named model abstraction. The alias `id` is the model identifier steps use
 * via `with.model: <id>`. Aligned with `PipelinePluginCollection` — an array of
 * named objects, NOT a map.
 */
export interface PipelineModelAlias {
  id: string;
  name: string;
  description?: string;
  defaults?: PipelineModelAliasDefaults;
}

/**
 * Value of a resolved pipeline input.
 *
 * Structurally identical to {@link PipelineJsonValue} but named separately
 * because it describes a different contract: what a *trigger input* may hold
 * once parsed. Only trigger-input defaults, `ExecutionState.inputs`, and the
 * expression `inputs` context are widened to this type. `PipelineScalar`,
 * external launch payloads, and pause/request input fields deliberately stay
 * scalar — structured values reach job/step `env` and `with` only via
 * `JSON.stringify()` at projection time.
 */
export type PipelineInputValue =
  | null
  | string
  | number
  | boolean
  | PipelineInputValue[]
  | { [key: string]: PipelineInputValue };

/** Scalar field kinds supported by runtime pause/input requests. */
export type PauseInputType = 'string' | 'boolean' | 'number' | 'choice';

/**
 * `'json'` accepts a structured (array/object/scalar/`null`) value, either as
 * a literal YAML default or parsed from a JSON string supplied at launch.
 */
export type PipelineInputType = PauseInputType | 'json';

export interface PipelineInputDef {
  description?: string;
  required?: boolean;
  /**
   * Widened to {@link PipelineInputValue} so `type: 'json'` inputs can declare
   * array/object/`null` defaults. Scalar defaults keep their exact previous
   * meaning.
   */
  default?: PipelineInputValue;
  type?: PipelineInputType;
  options?: string[];
  min?: number;
  max?: number;
  'hint-hide-ui-option'?: boolean;
}

export function normalizeNeeds(needs?: string | string[]): string[] {
  if (!needs) return [];
  return Array.isArray(needs) ? needs : [needs];
}

export function getJobOrder(pipeline: Pipeline): string[] {
  const ordered: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const jobs = pipeline.jobs;

  function visit(jobId: string): void {
    if (visited.has(jobId)) return;
    if (visiting.has(jobId)) {
      throw new Error(`Cycle detected in pipeline jobs at "${jobId}"`);
    }

    const job = jobs[jobId];
    if (!job) {
      throw new Error(`Unknown job dependency "${jobId}"`);
    }

    visiting.add(jobId);
    for (const dependency of normalizeNeeds(job.needs)) {
      visit(dependency);
    }
    visiting.delete(jobId);
    visited.add(jobId);
    ordered.push(jobId);
  }

  for (const jobId of Object.keys(jobs)) {
    visit(jobId);
  }

  return ordered;
}
