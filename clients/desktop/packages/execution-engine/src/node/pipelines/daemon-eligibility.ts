import * as path from 'node:path';
import { getBrandEnv } from '@canopy/execution-engine/brand/env';
import { isPipelineHostActionId } from '@canopy/execution-engine/pipelines/host-actions';
import { resolveActionRuntime } from './action-resolver';
import type { ResolvedActionRuntime } from './action-resolver';
import {
  getNormalizedTriggerInputDefs,
  resolvePipelineInputs,
} from './executor/execution-context';
import { MAX_NESTED_STEP_DEPTH } from './executor/nesting-limit';
import { normalizePipeline } from './executor/normalize-pipeline';
import { resolvePipelineModelAliasLenient } from '@canopy/execution-engine/pipelines/normalize-pipeline';
import type { ExecutionRuntime } from './executor/types';
import {
  getExecutionHarnessForModel,
  getModelSource,
} from '@canopy/execution-engine/model-catalog';
import type {
  ActionDefinition,
  Pipeline,
  PipelineScalar,
  ShellType,
  Step,
} from '@canopy/execution-engine/types/pipeline';

export const DAEMON_PIPELINE_REFUSAL_REASONS = [
  'model_step',
  'host_step',
  'child_pipeline',
  'tsx_runtime',
  'dynamic_action',
  'unresolved_action',
  'too_deep',
  'unknown_runtime',
  // CAN-5095: when model steps are admitted, a model step the daemon cannot run.
  'model_provider',
  'model_action',
  'dynamic_model',
  'model_alias',
  'plugin_collections',
  // CAN-5771: a send-agent-message step with host-path inputs.
  'host_paths',
  // CAN-5771: a send-agent-message step whose named model or plugin
  // collection only the app's executor resolves.
  'host_inputs',
] as const;
export type DaemonPipelineRefusalReason =
  (typeof DAEMON_PIPELINE_REFUSAL_REASONS)[number];

/**
 * Bundled actions that call a model (CAN-5086). Every bundled action that
 * declares `log_format_hint: agent` is refused by that hint as well; these
 * names also cover the actions that reach the Claude SDK without it.
 */
export const DAEMON_MODEL_BUILTIN_ACTIONS: ReadonlySet<string> = new Set([
  'agent-loop',
  'agent-prompt',
  'agent-resume',
  'condenser',
  'git-commit-push',
  'github-create-pr',
  'parallel-agents',
  'plan-with-review',
  'quality-gate',
  'router',
]);

/** The harness a daemon model step runs on (CAN-5095). */
export type DaemonModelHarness = 'claude' | 'codex';

/**
 * Bundled model actions the daemon runs when model steps are admitted, and
 * the harnesses each may use (CAN-5095 D2). Every other model action stays
 * in process.
 */
export const DAEMON_PORTABLE_MODEL_ACTIONS: ReadonlyMap<
  string,
  readonly DaemonModelHarness[]
> = new Map([
  ['agent-prompt', ['claude', 'codex']],
  ['agent-resume', ['claude', 'codex']],
  ['agent-loop', ['claude']],
  ['plan-with-review', ['claude']],
  ['quality-gate', ['claude']],
  ['router', ['claude']],
  ['condenser', ['claude']],
  // Several Claude SDK queries in one action subprocess, on the step's route (CAN-6012).
  ['parallel-agents', ['claude']],
]);

/**
 * Model actions whose post-processing their owner runs from the stored
 * outputs, portable only under `commitHooks: 'owner'` (CAN-6012 D3). Cloud
 * runs leave them `model_action` until CP-30 brokers their credentials.
 */
export const DAEMON_OWNER_HOOK_MODEL_ACTIONS: ReadonlyMap<
  string,
  readonly DaemonModelHarness[]
> = new Map([['git-commit-push', ['claude']]]);

const DAEMON_OWNER_HOOK_PORTABLE_MODEL_ACTIONS: ReadonlyMap<
  string,
  readonly DaemonModelHarness[]
> = new Map([
  ...DAEMON_PORTABLE_MODEL_ACTIONS,
  ...DAEMON_OWNER_HOOK_MODEL_ACTIONS,
]);

/**
 * Portable model actions whose model input is not `model`, with the runner's
 * own fallback chain: the step's input, then the run's preference variable,
 * then the runner's default (CAN-6012).
 */
const DAEMON_ACTION_MODEL_INPUTS: ReadonlyMap<
  string,
  {
    readonly input: string;
    readonly preferenceEnvSuffix: string;
    readonly runnerDefault: string;
  }
> = new Map([
  [
    'git-commit-push',
    {
      input: 'commit_model',
      preferenceEnvSuffix: 'PREF_COMMIT_GENERATION_MODEL',
      runnerDefault: 'haiku',
    },
  ],
]);

/**
 * Portable model actions that take an Ollama model (CAN-5831 D1): only the
 * model-aware agent actions resolve an Ollama route, in process as in the
 * daemon.
 */
export const DAEMON_OLLAMA_MODEL_ACTIONS: ReadonlySet<string> = new Set([
  'agent-prompt',
  'agent-resume',
]);

/**
 * Portable model actions whose model may name a workflow model alias
 * (CAN-5832): the step runner resolves aliases only for these.
 */
export const DAEMON_ALIAS_MODEL_ACTIONS: ReadonlySet<string> = new Set([
  'agent-prompt',
  'agent-resume',
]);

/** What a pipeline model alias names for one run, as its core resolved it (CAN-5832). */
export interface DaemonModelAliasResolution {
  readonly base: string;
  /** The alias adds plugins (an inline plugin collection or an Agent's plugins). */
  readonly plugins: boolean;
}

export interface DaemonPipelineClassifierOptions {
  /** `'refuse'` (default): any model step is `model_step`. */
  readonly modelSteps?: 'refuse' | 'claude_codex';
  /** `'refuse'` (default): any host step is `host_step`. `'owner'`: bundled host actions are portable (CAN-5771). */
  readonly hostSteps?: 'refuse' | 'owner';
  /** `'refuse'` (default): `git-commit-push` is `model_action`. `'owner'`: its owner runs the precommit-failure hook (CAN-6012 D3). */
  readonly commitHooks?: 'refuse' | 'owner';
  /**
   * `'refuse'` (default): a model step inside a composite action whose model
   * names one of the composite's inputs is `dynamic_model`. `'resolve'`: it
   * is classified by the value that input has when the step runs, when the
   * definition and the run's inputs fix it (CAN-6316 G4).
   */
  readonly compositeModels?: 'refuse' | 'resolve';
}

export type DaemonPipelineClassification =
  | {
      readonly eligible: true;
      /** Admitted model steps, composite steps included (0 under `'refuse'`). */
      readonly modelSteps: number;
      /** The harnesses those steps run on, sorted, without repeats. */
      readonly modelHarnesses: readonly DaemonModelHarness[];
      /** Admitted host steps, composite steps included; only under `hostSteps: 'owner'` (CAN-5771). */
      readonly hostSteps?: number;
    }
  | {
      readonly eligible: false;
      readonly reason: DaemonPipelineRefusalReason;
      /** The top-level job and step index that holds the refused step. */
      readonly jobId: string;
      readonly stepIndex: number;
      readonly uses?: string;
    };

export interface DaemonPipelineClassifierContext {
  readonly runtime: Pick<
    ExecutionRuntime,
    | 'bundledActionsDir'
    | 'getProjectActionsDir'
    | 'getProjectActionsDirCandidates'
    | 'tsxCli'
  >;
  /** The repository project actions resolve in; the run's `repoPath` or `cwd`. */
  readonly repoPath?: string;
  /**
   * The pipeline's model aliases, resolved for this run by its core
   * (CAN-5832). An alias step whose alias is absent here is `model_alias`.
   */
  readonly modelAliases?: Readonly<Record<string, DaemonModelAliasResolution>>;
  /**
   * The pipeline's plugin collections its core resolved for this run
   * (CAN-5832). A model step of a pipeline with a collection absent here is
   * `plugin_collections`.
   */
  readonly pluginCollections?: ReadonlySet<string>;
  /**
   * The run's inputs as its executor resolves them at start (CAN-6012): a
   * top-level step whose model is exactly `${{ inputs.NAME }}` is classified
   * by that input's value.
   */
  readonly inputs?: Readonly<Record<string, unknown>>;
  /**
   * The run's launch environment, where an action's model preference
   * variable lives (CAN-6012).
   */
  readonly env?: Readonly<Record<string, string>>;
}

/** A model value that is exactly one input (CAN-6012 D1). */
const INPUT_MODEL_EXPRESSION =
  /^\$\{\{\s*inputs\.([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}$/;

/**
 * The `inputs` a step's expressions read, as far as they are known before
 * the run: the run's for a top-level step, its composite action's for a step
 * inside one (CAN-6316 G4), or unknown.
 */
type StepInputs =
  | { readonly kind: 'run' }
  | {
      readonly kind: 'composite';
      /** What the executor passes each input; null when only the run decides it. */
      readonly values: Readonly<Record<string, string | null>>;
    }
  | { readonly kind: 'unknown' };

const RUN_INPUTS: StepInputs = { kind: 'run' };
const UNKNOWN_INPUTS: StepInputs = { kind: 'unknown' };

/** What `${{ inputs.NAME }}` reads in `inputs`, or null when it is not known. */
function inputValue(
  name: string,
  inputs: StepInputs,
  context: DaemonPipelineClassifierContext,
): string | null {
  switch (inputs.kind) {
    case 'run': {
      const value = context.inputs?.[name];
      return typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
        ? String(value)
        : null;
    }
    case 'composite':
      // An input the composite was not passed interpolates to ''.
      return Object.prototype.hasOwnProperty.call(inputs.values, name)
        ? (inputs.values[name] ?? null)
        : '';
    default:
      return null;
  }
}

/**
 * A `with` value as the executor interpolates it for a step that reads
 * `inputs`, or null when it is not known: only a literal or exactly one
 * input is.
 */
function staticWithValue(
  value: PipelineScalar,
  inputs: StepInputs,
  context: DaemonPipelineClassifierContext,
): string | null {
  if (typeof value !== 'string') return String(value);
  if (!value.includes('${{')) return value;
  const name = INPUT_MODEL_EXPRESSION.exec(value.trim())?.[1];
  return name === undefined ? null : inputValue(name, inputs, context);
}

/**
 * A step's `with`, its own `model` resolved from a built-in `$` alias as
 * normalization resolves it before the step runs. An unknown `$` alias stays
 * as written: normalization refuses it, and so does the classifier.
 */
function normalizedWith(step: Step): Step['with'] {
  const model = step.with?.model;
  return typeof model === 'string'
    ? { ...step.with, model: resolvePipelineModelAliasLenient(model) }
    : step.with;
}

/**
 * The inputs the executor passes a composite step's action, as
 * `resolveActionInputs` builds them: each declared input from the step's
 * `with` or its default, then the step's other `with` keys.
 */
function compositeInputs(
  step: Step,
  definition: ActionDefinition,
  inputs: StepInputs,
  context: DaemonPipelineClassifierContext,
): StepInputs {
  const provided = normalizedWith(step) ?? {};
  const values: Record<string, string | null> = {};
  for (const [name, input] of Object.entries(definition.inputs ?? {})) {
    const given = provided[name];
    if (given !== undefined && given !== null)
      values[name] = staticWithValue(given, inputs, context);
    // A default is passed as written, never interpolated.
    else if (input.default !== undefined) values[name] = String(input.default);
  }
  for (const [name, value] of Object.entries(provided))
    if (!Object.prototype.hasOwnProperty.call(values, name))
      values[name] = staticWithValue(value, inputs, context);
  return { kind: 'composite', values };
}

/**
 * A dispatched run's inputs, resolved as its executor resolves them at start;
 * undefined when they do not resolve, so expression models stay in process
 * and the run fails there as before (CAN-6012).
 */
export function resolveDaemonPipelineInputs(
  pipeline: Pipeline,
  inputs: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  try {
    return resolvePipelineInputs(
      getNormalizedTriggerInputDefs(normalizePipeline(pipeline), 'dispatch'),
      inputs === undefined ? undefined : { ...inputs },
    );
  } catch {
    return undefined;
  }
}

const BUILTIN_ACTION_PREFIX = 'builtin/';

/** A tsx step or action: portable on a runtime with its own tsx CLI (CAN-6316 G1). */
function tsxRuntime(
  context: DaemonPipelineClassifierContext,
): DaemonPipelineRefusalReason | null {
  return context.runtime.tsxCli ? null : 'tsx_runtime';
}

/** Host steps a pipeline may hold, and how many were found (CAN-5771). */
interface HostStepTally {
  readonly admit: boolean;
  count: number;
}

/** `send-agent-message` inputs that hold host paths; they never cross (D14). */
const SEND_HOST_PATH_INPUTS = [
  'attachments',
  'attachment_paths',
  'attachment_prompt_contexts',
  'file_references',
] as const;

/**
 * `send-agent-message` inputs the executor resolves before the host step,
 * against what only the app's runtime holds: a named model is checked against
 * the org model policy, and a plugin collection is resolved to its plugins.
 * The daemon's runtime has neither (CAN-5095), so such a send stays in process.
 */
const SEND_APP_RESOLVED_INPUTS = ['model', 'plugin_collection_id'] as const;

function resolveOrNull(
  uses: string,
  context: DaemonPipelineClassifierContext,
): ResolvedActionRuntime | null {
  try {
    return resolveActionRuntime(uses, context.runtime, context.repoPath);
  } catch {
    return null;
  }
}

/** The bundled action a `builtin/` reference resolves to, normalized as the resolver does. */
/** A `runs.using: host` step: portable only under `'owner'`, as a bundled host action. */
function classifyHostStep(
  step: Step,
  uses: string,
  resolved: ResolvedActionRuntime,
  context: DaemonPipelineClassifierContext,
  hosts: HostStepTally,
): DaemonPipelineRefusalReason | null {
  if (!hosts.admit) return 'host_step';
  const name = builtinActionName(uses, resolved, context);
  if (name === null || !isPipelineHostActionId(name)) return 'host_step';
  if (
    name === 'send-agent-message' &&
    SEND_HOST_PATH_INPUTS.some((input) => step.with?.[input] !== undefined)
  )
    return 'host_paths';
  if (
    name === 'send-agent-message' &&
    SEND_APP_RESOLVED_INPUTS.some((input) => step.with?.[input] !== undefined)
  )
    return 'host_inputs';
  hosts.count += 1;
  return null;
}

function builtinActionName(
  uses: string,
  resolved: ResolvedActionRuntime,
  context: DaemonPipelineClassifierContext,
): string | null {
  if (!uses.startsWith(BUILTIN_ACTION_PREFIX)) return null;
  return path.relative(
    path.resolve(context.runtime.bundledActionsDir),
    resolved.actionDir,
  );
}

/**
 * `inheritedShell` is the shell a step without its own runs with, as the
 * executor resolves it: the job's or pipeline's run default, or a composite
 * parent step's shell.
 */
function classifyStep(
  step: Step,
  context: DaemonPipelineClassifierContext,
  depth: number,
  inheritedShell: ShellType | undefined,
  hosts: HostStepTally,
): DaemonPipelineRefusalReason | null {
  if (step.log_format_hint === 'agent') return 'model_step';
  const shell = step.shell ?? inheritedShell;
  const uses = step.uses;
  if (uses === undefined) {
    return shell === 'tsx' ? tsxRuntime(context) : null;
  }
  if (uses.includes('${{')) return 'dynamic_action';
  const resolved = resolveOrNull(uses, context);
  if (!resolved) return 'unresolved_action';
  const definition = resolved.definition;
  if (definition.log_format_hint === 'agent') return 'model_step';
  const builtin = builtinActionName(uses, resolved, context);
  // Case-insensitive volumes resolve `builtin/Condenser` to `condenser`.
  if (
    builtin !== null &&
    DAEMON_MODEL_BUILTIN_ACTIONS.has(builtin.toLowerCase())
  ) {
    return 'model_step';
  }
  switch (definition.runs.using) {
    case 'host':
      return classifyHostStep(step, uses, resolved, context, hosts);
    case 'pipeline':
      return 'child_pipeline';
    case 'tsx':
      return tsxRuntime(context);
    case 'node':
    case 'python':
      return null;
    case 'composite':
      return classifySteps(
        definition.runs.steps,
        context,
        depth + 1,
        shell,
        hosts,
      );
    default:
      return 'unknown_runtime';
  }
}

/** Steps the executor fails for their depth are refused (CAN-6316 G5). */
function tooDeep(steps: readonly Step[], depth: number): boolean {
  return depth >= MAX_NESTED_STEP_DEPTH && steps.length > 0;
}

function classifySteps(
  steps: readonly Step[],
  context: DaemonPipelineClassifierContext,
  depth: number,
  inheritedShell: ShellType | undefined,
  hosts: HostStepTally,
): DaemonPipelineRefusalReason | null {
  if (tooDeep(steps, depth)) return 'too_deep';
  for (const step of steps) {
    const reason = classifyStep(step, context, depth, inheritedShell, hosts);
    if (reason) return reason;
  }
  return null;
}

/** Admitted model steps found while walking a pipeline (CAN-5095). */
interface ModelStepTally {
  count: number;
  readonly harnesses: Set<DaemonModelHarness>;
  /** The portable model actions under this classification's options. */
  readonly actions: ReadonlyMap<string, readonly DaemonModelHarness[]>;
  /** Whether a composite's model steps read its inputs (`compositeModels: 'resolve'`). */
  readonly compositeModels: boolean;
}

function stepModelValue(
  step: Step,
  definition: ActionDefinition,
  name: string,
  env: Readonly<Record<string, string>> | undefined,
): string {
  const spec = DAEMON_ACTION_MODEL_INPUTS.get(name);
  if (spec) {
    const raw = step.with?.[spec.input];
    // A blank input skips the preference, as the runner's `INPUT ?? PREF` does.
    if (raw !== undefined) return String(raw).trim() || spec.runnerDefault;
    return (
      getBrandEnv(env ?? {}, spec.preferenceEnvSuffix)?.trim() ||
      spec.runnerDefault
    );
  }
  const value = normalizedWith(step)?.model;
  if (value !== undefined) return String(value);
  const fallback = definition.inputs?.model?.default;
  return typeof fallback === 'string' ? fallback : '';
}

/** The model checks for a step of portable model action `name` (CAN-5095 D5a, CAN-5831, CAN-5832). */
function classifyModelStep(
  pipeline: Pipeline,
  step: Step,
  definition: ActionDefinition,
  name: string,
  context: DaemonPipelineClassifierContext,
  inputs: StepInputs,
  tally: ModelStepTally,
): DaemonPipelineRefusalReason | null {
  // The run's core resolves its collections at launch, by the trimmed ids
  // the executor looks them up with (CAN-5832).
  if (
    pipeline.plugin_collections?.some(
      (collection) => !context.pluginCollections?.has(collection.id.trim()),
    )
  )
    return 'plugin_collections';
  const collectionId = step.with?.plugin_collection_id;
  let addsPlugins = false;
  if (collectionId !== undefined) {
    if (
      !DAEMON_ALIAS_MODEL_ACTIONS.has(name) ||
      typeof collectionId !== 'string' ||
      !context.pluginCollections?.has(collectionId.trim())
    )
      return 'plugin_collections';
    addsPlugins = true;
  }
  let value = stepModelValue(step, definition, name, context.env);
  if (value.includes('${{')) {
    // Only a step's own `with.model` names an input: a run input for a
    // top-level step (CAN-6012 D1), its composite's inside one (CAN-6316 G4).
    const resolved =
      step.with?.model === undefined
        ? null
        : staticWithValue(value, inputs, context);
    if (resolved === null) return 'dynamic_model';
    value = resolved;
  }
  let model = value.trim();
  if (pipeline.model_aliases?.some((alias) => alias.id === model)) {
    const target = DAEMON_ALIAS_MODEL_ACTIONS.has(name)
      ? context.modelAliases?.[model]
      : undefined;
    if (target === undefined) return 'model_alias';
    addsPlugins ||= target.plugins;
    model = target.base.trim();
  }
  let harness: DaemonModelHarness;
  if (model.length === 0) {
    harness = 'claude';
  } else {
    if (
      getModelSource(model) === 'ollama' &&
      !DAEMON_OLLAMA_MODEL_ACTIONS.has(name)
    )
      return 'model_provider';
    const resolved = getExecutionHarnessForModel(model);
    const allowed = tally.actions.get(name) ?? [];
    const admitted = allowed.find((candidate) => candidate === resolved);
    if (admitted === undefined) return 'model_provider';
    harness = admitted;
  }
  // Only Claude steps load plugins in the daemon; Codex plugins stay in
  // process (CAN-6012).
  if (addsPlugins && harness !== 'claude') return 'plugin_collections';
  tally.count += 1;
  tally.harnesses.add(harness);
  return null;
}

function classifyStepAdmittingModels(
  pipeline: Pipeline,
  step: Step,
  context: DaemonPipelineClassifierContext,
  depth: number,
  inheritedShell: ShellType | undefined,
  tally: ModelStepTally,
  hosts: HostStepTally,
  inputs: StepInputs,
): DaemonPipelineRefusalReason | null {
  const shell = step.shell ?? inheritedShell;
  const uses = step.uses;
  if (uses === undefined) {
    if (step.log_format_hint === 'agent') return 'model_action';
    return shell === 'tsx' ? tsxRuntime(context) : null;
  }
  if (uses.includes('${{')) return 'dynamic_action';
  const resolved = resolveOrNull(uses, context);
  if (!resolved) return 'unresolved_action';
  const definition = resolved.definition;
  switch (definition.runs.using) {
    case 'composite':
      return classifyStepsAdmittingModels(
        pipeline,
        definition.runs.steps,
        context,
        depth + 1,
        shell,
        tally,
        hosts,
        tally.compositeModels
          ? compositeInputs(step, definition, inputs, context)
          : UNKNOWN_INPUTS,
      );
    case 'host':
      return classifyHostStep(step, uses, resolved, context, hosts);
    case 'pipeline':
      return 'child_pipeline';
    case 'tsx':
      return tsxRuntime(context);
    case 'node':
    case 'python': {
      // Case-insensitive volumes resolve `builtin/Condenser` to `condenser`.
      const name = builtinActionName(uses, resolved, context)?.toLowerCase();
      // Its owner's hook reads persisted step results, and a composite keeps
      // its nested ones in memory (CAN-6012 D3).
      if (
        name !== undefined &&
        depth > 0 &&
        DAEMON_OWNER_HOOK_MODEL_ACTIONS.has(name)
      )
        return 'model_action';
      if (name !== undefined && tally.actions.has(name)) {
        return classifyModelStep(
          pipeline,
          step,
          definition,
          name,
          context,
          inputs,
          tally,
        );
      }
      if (
        step.log_format_hint === 'agent' ||
        definition.log_format_hint === 'agent' ||
        (name !== undefined && DAEMON_MODEL_BUILTIN_ACTIONS.has(name))
      ) {
        return 'model_action';
      }
      return null;
    }
    default:
      return 'unknown_runtime';
  }
}

function classifyStepsAdmittingModels(
  pipeline: Pipeline,
  steps: readonly Step[],
  context: DaemonPipelineClassifierContext,
  depth: number,
  inheritedShell: ShellType | undefined,
  tally: ModelStepTally,
  hosts: HostStepTally,
  inputs: StepInputs,
): DaemonPipelineRefusalReason | null {
  if (tooDeep(steps, depth)) return 'too_deep';
  for (const step of steps) {
    const reason = classifyStepAdmittingModels(
      pipeline,
      step,
      context,
      depth,
      inheritedShell,
      tally,
      hosts,
      inputs,
    );
    if (reason) return reason;
  }
  return null;
}

/**
 * Whether every step of `pipeline` can run in the daemon (CAN-5086). By
 * default a step that calls a model refuses the run; with
 * `modelSteps: 'claude_codex'` the steps on the Claude and Codex harnesses
 * that CAN-5095 D2 and CAN-5831 admit are counted instead, Ollama models on
 * the agent actions included, and model alias steps by what
 * `context.modelAliases` says their alias names (CAN-5832). With
 * `compositeModels: 'resolve'`, a composite's model steps whose model names
 * one of its inputs are classified by that input's value (CAN-6316 G4). A
 * step the executor would fail for its nesting depth is `too_deep` (G5).
 * Fails closed on anything unknown.
 */
export function classifyDaemonPipeline(
  pipeline: Pipeline,
  context: DaemonPipelineClassifierContext,
  options?: DaemonPipelineClassifierOptions,
): DaemonPipelineClassification {
  const admitModels = options?.modelSteps === 'claude_codex';
  const tally: ModelStepTally = {
    count: 0,
    harnesses: new Set(),
    actions:
      options?.commitHooks === 'owner'
        ? DAEMON_OWNER_HOOK_PORTABLE_MODEL_ACTIONS
        : DAEMON_PORTABLE_MODEL_ACTIONS,
    compositeModels: options?.compositeModels === 'resolve',
  };
  const hosts: HostStepTally = {
    admit: options?.hostSteps === 'owner',
    count: 0,
  };
  for (const [jobId, job] of Object.entries(pipeline.jobs)) {
    const jobShell = job.defaults?.run?.shell ?? pipeline.defaults?.run?.shell;
    for (const [stepIndex, step] of job.steps.entries()) {
      const reason = admitModels
        ? classifyStepAdmittingModels(
            pipeline,
            step,
            context,
            0,
            jobShell,
            tally,
            hosts,
            RUN_INPUTS,
          )
        : classifyStep(step, context, 0, jobShell, hosts);
      if (reason) {
        return {
          eligible: false,
          reason,
          jobId,
          stepIndex,
          ...(step.uses !== undefined ? { uses: step.uses } : {}),
        };
      }
    }
  }
  return {
    eligible: true,
    modelSteps: tally.count,
    modelHarnesses: [...tally.harnesses].sort(),
    ...(hosts.admit && { hostSteps: hosts.count }),
  };
}
