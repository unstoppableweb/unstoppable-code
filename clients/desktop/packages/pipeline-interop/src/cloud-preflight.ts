import { AGENT_MODEL_PREFIX } from '@canopy/protocol/agents';
import type { Pipeline, ShellType, Step } from './document';
import { STATIC_MODEL_REFERENCE_ALIASES } from './static-model-reference-aliases';
import type { PipelineExecutionScope } from '@canopy/protocol/pipelines';
import { executionContextSatisfies, normalizePipelineScopes } from './scope';

/*
 * Cloud run preflight (CAN-6169, plan CP-18): every step a cloud run cannot
 * execute, found in the definition before the run is recorded, so no sandbox
 * starts for a run that would be refused.
 *
 * Two sources, both in `docs/pipelines-cloud-parity.md`:
 *
 * - The pipeline host gaps. The cloud runner is the daemon pipeline host,
 *   which refuses these at start (`classifyDaemonPipeline`, run with model
 *   steps and owner-settled host steps admitted). Preflight refuses the same
 *   steps for the same reason until a ticket closes each gap.
 * - The parity matrix refusals (R4, R5, R7, R8, R11), which the host would
 *   run but the cloud must not.
 *
 * Unlike the host, preflight lists every refused step, not the first. A
 * step whose model a cloud run can't use (R1 to R3, and the run owner's model
 * policy) is not refused here: `cloud-model-preflight` lists it with the
 * cloud models the user may confirm instead (CAN-6174). R9 (Claude terminal
 * mode) is a chat setting that pipeline steps can't select.
 */

export const CLOUD_RUN_REFUSAL_REASONS = [
  // Pipeline host gaps, named as `DAEMON_PIPELINE_REFUSAL_REASONS` names them.
  'child_pipeline',
  'model_action',
  'dynamic_action',
  'dynamic_model',
  'model_alias',
  'plugin_collections',
  'host_paths',
  'host_inputs',
  'unresolved_action',
  // Parity matrix refusals and the cloud run scope.
  'action_scope',
  'orchestrator',
  'desktop_path',
  'windows_shell',
  'local_state',
  'local_runtime',
  'run_scope',
] as const;

export type CloudRunRefusalReason = (typeof CLOUD_RUN_REFUSAL_REASONS)[number];

/** One refused item: the step that holds it, or the whole definition. */
export interface CloudRunRefusal {
  readonly reason: CloudRunRefusalReason;
  /**
   * The parity matrix row (`R4`), pipeline host gap (`G1`) or plan ticket
   * (`CP-29`) that explains the refusal and its alternative.
   */
  readonly parityId: string;
  readonly message: string;
  /** Absent for a refusal of the whole definition. */
  readonly jobId?: string;
  readonly stepIndex?: number;
  readonly uses?: string;
}

/**
 * What the pipeline host decides for a step that runs a bundled action with
 * no inputs: `portable`, or the host's refusal reason. Taken from
 * `classifyDaemonPipeline` over the bundled manifests; the
 * `cloud-preflight-host-parity` golden fails when the two disagree or a
 * bundled action is missing here. Composite actions pass their model to the
 * model step inside them as `${{ inputs.model }}`, which the host resolves
 * from the step's own `model` (G4).
 */
export const CLOUD_RUN_BUNDLED_ACTIONS: Readonly<
  Record<string, 'portable' | CloudRunRefusalReason>
> = {
  'agent-loop': 'portable',
  'agent-prompt': 'portable',
  'agent-resume': 'portable',
  coder: 'portable',
  'comms-setup': 'portable',
  'complexity-assessor': 'portable',
  condenser: 'portable',
  'context-discovery': 'portable',
  'create-bot-entry': 'portable',
  'create-project-entry': 'portable',
  'create-worktree': 'portable',
  'discover-review-tracks': 'portable',
  discovery: 'portable',
  'gather-linear-context': 'portable',
  'git-commit-push': 'portable',
  'git-workspace-details': 'portable',
  'github-create-pr': 'portable',
  'github-fetch-branch-pr': 'portable',
  'github-post-review-comment': 'portable',
  'greenfield-detection': 'portable',
  'hello-world-js': 'portable',
  'hello-world-py': 'portable',
  'hello-world-ts': 'portable',
  'historical-context': 'portable',
  'http-request': 'portable',
  memory: 'portable',
  'memory-read': 'portable',
  'memory-write': 'portable',
  'move-to-group': 'portable',
  notify: 'portable',
  'parallel-agents': 'portable',
  'phase-compaction': 'portable',
  'pipeline-report': 'portable',
  'plan-path-validation': 'portable',
  'plan-validation': 'portable',
  'plan-with-review': 'portable',
  planner: 'portable',
  'qa-fixer': 'portable',
  'qa-reviewer': 'portable',
  'quality-gate': 'portable',
  'read-linear-ticket': 'portable',
  'request-input': 'portable',
  'requirements-from-task': 'portable',
  'requirements-interactive': 'portable',
  router: 'portable',
  'run-pipeline': 'child_pipeline',
  'send-agent-message': 'portable',
  'spec-critic': 'portable',
  'spec-gatherer': 'portable',
  'spec-quick': 'portable',
  'spec-researcher': 'portable',
  'spec-validation': 'portable',
  'spec-writer': 'portable',
  'wait-for-agent-reply': 'portable',
};

/**
 * The bundled model actions the host runs (`DAEMON_PORTABLE_MODEL_ACTIONS`).
 * Their step inputs are checked as the host checks them.
 */
export const CLOUD_RUN_PORTABLE_MODEL_ACTIONS: ReadonlySet<string> = new Set([
  'agent-prompt',
  'agent-resume',
  'agent-loop',
  'plan-with-review',
  'quality-gate',
  'router',
  'condenser',
  'parallel-agents',
]);

/**
 * The bundled composite actions whose one model step runs the composite's
 * `model` input, with the portable model action that step runs and whether
 * it takes the composite step's `permission_preset` (the others fix their
 * own). A step of one is checked as a step of that action. The host parity
 * golden reads them from the manifests.
 */
export const CLOUD_RUN_COMPOSITE_MODEL_ACTIONS: Readonly<
  Record<
    string,
    { readonly action: string; readonly forwardsPermissionPreset: boolean }
  >
> = {
  coder: { action: 'agent-prompt', forwardsPermissionPreset: true },
  'complexity-assessor': {
    action: 'agent-prompt',
    forwardsPermissionPreset: false,
  },
  'context-discovery': {
    action: 'agent-prompt',
    forwardsPermissionPreset: false,
  },
  discovery: { action: 'agent-prompt', forwardsPermissionPreset: true },
  'greenfield-detection': {
    action: 'agent-prompt',
    forwardsPermissionPreset: false,
  },
  'historical-context': {
    action: 'agent-prompt',
    forwardsPermissionPreset: false,
  },
  'phase-compaction': { action: 'condenser', forwardsPermissionPreset: false },
  planner: { action: 'agent-prompt', forwardsPermissionPreset: false },
  'plan-validation': {
    action: 'agent-prompt',
    forwardsPermissionPreset: false,
  },
  'qa-fixer': { action: 'agent-prompt', forwardsPermissionPreset: true },
  'qa-reviewer': { action: 'agent-prompt', forwardsPermissionPreset: false },
  'requirements-from-task': {
    action: 'agent-prompt',
    forwardsPermissionPreset: true,
  },
  'requirements-interactive': {
    action: 'agent-prompt',
    forwardsPermissionPreset: false,
  },
  'spec-critic': { action: 'agent-prompt', forwardsPermissionPreset: false },
  'spec-gatherer': { action: 'agent-prompt', forwardsPermissionPreset: false },
  'spec-quick': { action: 'agent-prompt', forwardsPermissionPreset: false },
  'spec-researcher': {
    action: 'agent-prompt',
    forwardsPermissionPreset: false,
  },
  'spec-validation': {
    action: 'agent-prompt',
    forwardsPermissionPreset: false,
  },
  'spec-writer': { action: 'agent-prompt', forwardsPermissionPreset: false },
};

/**
 * The bundled actions that commit, push or open a pull request, which a
 * folder or worktree run's host runs with the run's brokered GitHub
 * credentials (`DAEMON_BROKERED_REPOSITORY_MODEL_ACTIONS`, CAN-6739). Each
 * writes its text with a Claude model named by its own input, or the
 * runner's default (`DAEMON_ACTION_MODEL_INPUTS`); the host parity golden
 * keeps them equal.
 */
export const CLOUD_RUN_REPOSITORY_MODEL_INPUTS: Readonly<
  Record<string, { readonly input: string; readonly runnerDefault: string }>
> = {
  'git-commit-push': { input: 'commit_model', runnerDefault: 'haiku' },
  'github-create-pr': { input: 'pr_model', runnerDefault: 'sonnet' },
};

/** The bundled host actions (`runs.using: host`) the owner settles. */
export const CLOUD_RUN_HOST_ACTIONS: ReadonlySet<string> = new Set([
  'create-bot-entry',
  'create-project-entry',
  'create-worktree',
  'move-to-group',
  'send-agent-message',
  'wait-for-agent-reply',
]);

/**
 * Bundled actions whose manifest `scope` leaves out `global`, which the
 * executor refuses in a global run. The host parity golden reads the scopes
 * from the manifests.
 */
export const CLOUD_RUN_BUNDLED_ACTIONS_OUTSIDE_GLOBAL: ReadonlySet<string> =
  new Set([
    'discover-review-tracks',
    'git-commit-push',
    'git-workspace-details',
    'github-create-pr',
    'github-fetch-branch-pr',
    'github-post-review-comment',
  ]);

/**
 * Bundled actions whose manifest `scope` leaves out `directory`, which the
 * executor refuses in a folder run (CAN-6739): they commit to and open pull
 * requests from a worktree's own branch. The host parity golden reads the
 * scopes from the manifests.
 */
export const CLOUD_RUN_BUNDLED_ACTIONS_OUTSIDE_DIRECTORY: ReadonlySet<string> =
  new Set(['git-commit-push', 'github-create-pr']);

/** Host actions that reach the Orchestrator when they name a `bot_id` (R4). */
const BOT_TARGET_ACTIONS: ReadonlySet<string> = new Set([
  'move-to-group',
  'send-agent-message',
  'wait-for-agent-reply',
]);

/**
 * The input that names each memory action's file (CAN-6317). A cloud run
 * keeps these files with the pipeline's data only when they stay in the
 * run's folder; one on the author's computer can't be reached (R5).
 */
const MEMORY_PATH_INPUTS: Readonly<Record<string, string>> = {
  memory: 'db_path',
  'memory-read': 'file',
  'memory-write': 'file',
};

/** `send-agent-message` inputs naming desktop task files (R11). */
const SEND_DESKTOP_FILE_INPUTS = [
  'attachment_paths',
  'attachment_prompt_contexts',
  'file_references',
] as const;

/** `send-agent-message` inputs only the app's executor resolves. */
const SEND_APP_RESOLVED_INPUTS = ['model', 'plugin_collection_id'] as const;

const WINDOWS_SHELLS: ReadonlySet<ShellType> = new Set([
  'pwsh',
  'powershell',
  'cmd',
]);

/**
 * What each refusal tells the user: the reason, then the supported
 * alternative for the pipeline host gaps (CAN-6316), as the parity matrix
 * lists them.
 */
const MESSAGES: Readonly<Record<CloudRunRefusalReason, string>> = {
  child_pipeline:
    "Cloud runs can't start another workflow yet. Copy its jobs into this workflow, or run the workflow on This computer.",
  model_action:
    'Cloud runs start agents only through the bundled agent actions. Use agent-prompt for this step, or run the workflow on This computer.',
  dynamic_action:
    "An expression can't choose a step's action. Name the action in uses, and choose between steps with if.",
  dynamic_model:
    "Cloud runs can't use a model chosen by an expression. Name the model in this step.",
  model_alias:
    "Cloud runs can't use a model alias that names an Agent or has no default model. Name the model in this step, or run the workflow on This computer.",
  plugin_collections:
    "Cloud runs can't load this plugin collection. Remove it, or run the workflow on This computer.",
  host_paths:
    "Cloud runs can't attach files to a message yet. Put the text in text or text_file, or run the workflow on This computer.",
  host_inputs:
    "Cloud runs can't send a message with its own model or plugin collection yet. Remove its model and plugin collection, or run the workflow on This computer.",
  unresolved_action: "Cloud runs can't find this action.",
  action_scope:
    'This action runs only in a folder or worktree. Run the workflow in a project or worktree.',
  orchestrator: 'The Orchestrator only runs in the desktop app.',
  desktop_path: 'This step uses a folder on your computer.',
  windows_shell: "Cloud runs use Linux, which doesn't have this shell.",
  local_state:
    'Files listed in local_state stay on the computer that owns them.',
  local_runtime:
    "This workflow needs Ollama, which runs on your computer and can't be reached from the cloud.",
  run_scope:
    "This workflow doesn't run as a global workflow. Run it in a project or worktree.",
};

/** `run_scope` for a run in a project folder or a worktree (CP-29). */
const RUN_SCOPE_MESSAGES: Readonly<Record<PipelineExecutionScope, string>> = {
  global: MESSAGES.run_scope,
  directory:
    "This workflow doesn't run in a project folder. Run it in a worktree, or as a global workflow if it allows that.",
  worktree:
    "This workflow doesn't run in a worktree. Run it in a project folder, or as a global workflow if it allows that.",
};

/** An action that runs only in a worktree, in a folder run (CAN-6739). */
const WORKTREE_ACTION_MESSAGE =
  'This action runs only in a worktree. Run the workflow in a worktree.';

/** R11: files from a desktop task's attachments folder, which never leave it. */
const DESKTOP_FILES_MESSAGE =
  'This message attaches files from your computer. Put the text in text or text_file, or run the workflow on This computer.';

const BUILTIN_PREFIX = 'builtin/';

function isExpression(value: unknown): boolean {
  return typeof value === 'string' && value.includes('${{');
}

/**
 * The bundled action a `builtin/` reference names, normalized as the
 * resolver normalizes it (`builtin/./run-pipeline` is `run-pipeline`), or
 * null when it leaves the bundled actions folder. Case is kept: the runner's
 * Linux file system resolves names exactly.
 */
function bundledActionName(uses: string): string | null {
  const segments = uses
    .slice(BUILTIN_PREFIX.length)
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0 || segments.includes('..')) return null;
  return segments.join('/');
}

/** A folder that names a place on the computer, not one inside the checkout. */
function isDesktopPath(value: unknown): boolean {
  if (typeof value !== 'string' || isExpression(value)) return false;
  const path = value.trim().replace(/\\/g, '/');
  return (
    path.startsWith('/') ||
    path.startsWith('~') ||
    /^[A-Za-z]:/.test(path) ||
    escapesItsFolder(path)
  );
}

/** Whether a relative path's `..` segments climb above the folder it starts in. */
function escapesItsFolder(path: string): boolean {
  let depth = 0;
  for (const segment of path.split('/')) {
    if (segment === '..') depth -= 1;
    else if (segment !== '' && segment !== '.') depth += 1;
    if (depth < 0) return true;
  }
  return false;
}

interface StepAt {
  readonly jobId: string;
  readonly stepIndex: number;
  readonly step: Step;
}

/** Where a refused item is: a step, a whole job, or the whole definition. */
type At = StepAt | { readonly jobId: string };

type Refuse = (
  reason: CloudRunRefusalReason,
  parityId: string,
  at?: At,
  message?: string,
) => void;

function checkHostAction(name: string, at: StepAt, refuse: Refuse): void {
  const input = at.step.with ?? {};
  if (name === 'create-bot-entry') refuse('orchestrator', 'R4', at);
  if (BOT_TARGET_ACTIONS.has(name) && input.bot_id !== undefined)
    refuse('orchestrator', 'R4', at);
  if (name !== 'send-agent-message') return;
  if (SEND_DESKTOP_FILE_INPUTS.some((key) => input[key] !== undefined))
    refuse('host_paths', 'R11', at, DESKTOP_FILES_MESSAGE);
  else if (input.attachments !== undefined) refuse('host_paths', 'G6', at);
  if (SEND_APP_RESOLVED_INPUTS.some((key) => input[key] !== undefined))
    refuse('host_inputs', 'CP-32', at);
}

/**
 * What a cloud run resolves a step's model alias to (CAN-6439): its inline
 * default's base model and the plugin collection it adds. `undefined` when
 * `model` names no alias of the workflow; `null` for an alias a cloud run
 * can't resolve: one that names an Agent, whose definition lives on a
 * computer, or one with no default, which only a desktop preference fills.
 * The web core resolves the rest before the run starts.
 */
export function cloudModelAliasOf(
  pipeline: Pick<Pipeline, 'model_aliases'>,
  model: string,
):
  | { readonly base: string; readonly pluginCollectionId?: string }
  | null
  | undefined {
  const alias = pipeline.model_aliases?.find(
    // Normalization trims alias ids, which the executor then resolves.
    (candidate) => candidate.id.trim() === model.trim(),
  );
  if (alias === undefined) return undefined;
  const defaults = alias.defaults;
  if (defaults === undefined || 'agent_id' in defaults) return null;
  const written = String(defaults.base).trim();
  // A built-in `$` alias names its model, as pipeline normalization
  // resolves it, so the host resolves the alias to a model it knows.
  const base = Object.prototype.hasOwnProperty.call(
    STATIC_MODEL_REFERENCE_ALIASES,
    written,
  )
    ? (STATIC_MODEL_REFERENCE_ALIASES[written] ?? written)
    : written;
  if (base === '' || base.startsWith(AGENT_MODEL_PREFIX)) return null;
  const collection = defaults.plugin_collection_id?.trim();
  return {
    base,
    ...(collection !== undefined &&
      collection !== '' && {
        pluginCollectionId: collection,
      }),
  };
}

/**
 * The model actions that take a model alias or a plugin collection of their
 * own on the pipeline host (`DAEMON_ALIAS_MODEL_ACTIONS`, CAN-5832); the host
 * parity golden keeps them equal.
 */
export const CLOUD_RUN_ALIAS_MODEL_ACTIONS: ReadonlySet<string> = new Set([
  'agent-prompt',
  'agent-resume',
]);

/** A step's alias or collection on a model action the host doesn't take them on. */
const ALIAS_ACTION_MESSAGE =
  'Cloud runs use model aliases only in agent-prompt and agent-resume steps. Name the model in this step, or run the workflow on This computer.';
const COLLECTION_ACTION_MESSAGE =
  'Cloud runs load a plugin collection only in agent-prompt and agent-resume steps. Remove it from this step, or run the workflow on This computer.';
/** A step's collection the workflow doesn't declare, which fails at start on desktop too. */
const UNDECLARED_COLLECTION_MESSAGE =
  "This step names a plugin collection the workflow doesn't declare. Add it to plugin_collections, or remove it from this step.";

/**
 * A repository action's model checks, as the host makes them (CAN-6739): it
 * takes neither a model alias nor a plugin collection, and its model is
 * written, never an expression. `cloud-model-preflight` checks the model.
 */
function checkRepositoryModel(
  pipeline: Pipeline,
  at: StepAt,
  refuse: Refuse,
  input: string,
): void {
  const inputs = at.step.with ?? {};
  if (inputs.plugin_collection_id !== undefined)
    refuse('plugin_collections', 'CP-25', at, COLLECTION_ACTION_MESSAGE);
  const model = inputs[input] === undefined ? '' : String(inputs[input]);
  if (isExpression(model)) {
    refuse('dynamic_model', 'G4', at);
    return;
  }
  const alias = cloudModelAliasOf(pipeline, model);
  if (alias === null) refuse('model_alias', 'CP-25', at);
  else if (alias !== undefined)
    refuse('model_alias', 'CP-25', at, ALIAS_ACTION_MESSAGE);
}

/**
 * A model step's checks, as the host makes them. Plugin collections and
 * inline model aliases are the web core's to resolve before the run starts
 * (CAN-6439); the host takes them on agent-prompt and agent-resume steps
 * only, a composite's through the model step inside it.
 * `cloud-model-preflight` lists a step that loads a collection on a Codex
 * model, which the host refuses (CAN-6012).
 */
function checkModelAction(
  pipeline: Pipeline,
  at: StepAt,
  refuse: Refuse,
  action: string,
  composite: boolean,
): void {
  const input = at.step.with ?? {};
  const model = input.model === undefined ? '' : String(input.model);
  // A composite's own plugin collection reaches none of its steps.
  const collection = composite ? undefined : input.plugin_collection_id;
  if (collection !== undefined && !CLOUD_RUN_ALIAS_MODEL_ACTIONS.has(action))
    refuse('plugin_collections', 'CP-25', at, COLLECTION_ACTION_MESSAGE);
  else if (
    collection !== undefined &&
    !pipeline.plugin_collections?.some(
      ({ id }) => id.trim() === String(collection).trim(),
    )
  )
    refuse('plugin_collections', 'CP-25', at, UNDECLARED_COLLECTION_MESSAGE);
  if (isExpression(model)) {
    refuse('dynamic_model', 'G4', at);
    return;
  }
  const alias = cloudModelAliasOf(pipeline, model);
  if (alias === null) refuse('model_alias', 'CP-25', at);
  else if (alias !== undefined && !CLOUD_RUN_ALIAS_MODEL_ACTIONS.has(action))
    refuse('model_alias', 'CP-25', at, ALIAS_ACTION_MESSAGE);
}

function checkStep(
  pipeline: Pipeline,
  at: StepAt,
  inheritedShell: ShellType | undefined,
  scope: PipelineExecutionScope,
  refuse: Refuse,
): void {
  const { step } = at;
  const shell = step.shell ?? inheritedShell;
  if (shell !== undefined && WINDOWS_SHELLS.has(shell))
    refuse('windows_shell', 'R7', at);
  if (isDesktopPath(step.working_directory) || isDesktopPath(step.with?.cwd))
    refuse('desktop_path', 'R5', at);
  const uses = step.uses;
  if (uses === undefined) {
    if (step.log_format_hint === 'agent') refuse('model_action', 'G3', at);
    return;
  }
  if (isExpression(uses)) {
    refuse('dynamic_action', 'G4', at);
    return;
  }
  // Project and marketplace actions resolve in a checkout (CP-29).
  const name = uses.startsWith(BUILTIN_PREFIX) ? bundledActionName(uses) : null;
  const verdict =
    name !== null &&
    Object.prototype.hasOwnProperty.call(CLOUD_RUN_BUNDLED_ACTIONS, name)
      ? CLOUD_RUN_BUNDLED_ACTIONS[name]
      : undefined;
  if (name === null || verdict === undefined) {
    refuse('unresolved_action', 'CP-29', at);
    return;
  }
  if (verdict !== 'portable') {
    refuse(verdict, parityIdOf(verdict), at);
    return;
  }
  // A folder or worktree run has the checkout these actions work in (CP-29).
  if (
    scope === 'global' &&
    CLOUD_RUN_BUNDLED_ACTIONS_OUTSIDE_GLOBAL.has(name)
  ) {
    refuse('action_scope', 'CP-29', at);
    return;
  }
  if (
    scope === 'directory' &&
    CLOUD_RUN_BUNDLED_ACTIONS_OUTSIDE_DIRECTORY.has(name)
  ) {
    refuse('action_scope', 'CP-29', at, WORKTREE_ACTION_MESSAGE);
    return;
  }
  const memoryPathInput = Object.prototype.hasOwnProperty.call(
    MEMORY_PATH_INPUTS,
    name,
  )
    ? MEMORY_PATH_INPUTS[name]
    : undefined;
  if (
    memoryPathInput !== undefined &&
    isDesktopPath(step.with?.[memoryPathInput])
  ) {
    refuse('desktop_path', 'R5', at);
    return;
  }
  if (CLOUD_RUN_HOST_ACTIONS.has(name)) checkHostAction(name, at, refuse);
  else if (
    Object.prototype.hasOwnProperty.call(
      CLOUD_RUN_REPOSITORY_MODEL_INPUTS,
      name,
    )
  )
    checkRepositoryModel(
      pipeline,
      at,
      refuse,
      CLOUD_RUN_REPOSITORY_MODEL_INPUTS[name]?.input ?? '',
    );
  else if (CLOUD_RUN_PORTABLE_MODEL_ACTIONS.has(name))
    checkModelAction(pipeline, at, refuse, name, false);
  else if (
    Object.prototype.hasOwnProperty.call(
      CLOUD_RUN_COMPOSITE_MODEL_ACTIONS,
      name,
    )
  )
    checkModelAction(
      pipeline,
      at,
      refuse,
      CLOUD_RUN_COMPOSITE_MODEL_ACTIONS[name]?.action ?? '',
      true,
    );
  else if (step.log_format_hint === 'agent') refuse('model_action', 'G3', at);
}

function parityIdOf(reason: CloudRunRefusalReason): string {
  switch (reason) {
    case 'child_pipeline':
      return 'G2';
    case 'model_action':
      return 'G3';
    case 'dynamic_action':
    case 'dynamic_model':
      return 'G4';
    default:
      return 'CP-29';
  }
}

/** Where the run executes: global, in a project folder, or in a worktree (CP-29). */
export interface CloudRunPreflightOptions {
  readonly scope?: PipelineExecutionScope;
}

/**
 * Every item of `pipeline` a cloud run in `scope` (global unless named)
 * refuses, in document order; empty when it may run. Throws only when the
 * definition's `scope` is invalid, as normalization does.
 */
export function preflightCloudRun(
  pipeline: Pipeline,
  options: CloudRunPreflightOptions = {},
): readonly CloudRunRefusal[] {
  const scope = options.scope ?? 'global';
  const refusals: CloudRunRefusal[] = [];
  const refuse: Refuse = (reason, parityId, at, message) => {
    refusals.push({
      reason,
      parityId,
      message: message ?? MESSAGES[reason],
      ...(at === undefined ? {} : { jobId: at.jobId }),
      ...(at === undefined || !('step' in at)
        ? {}
        : {
            stepIndex: at.stepIndex,
            ...(at.step.uses === undefined ? {} : { uses: at.step.uses }),
          }),
    });
  };
  // A worktree also serves a workflow declared for a folder.
  if (
    !executionContextSatisfies(
      normalizePipelineScopes(pipeline.scope, 'scope'),
      scope,
    )
  )
    refuse('run_scope', 'CP-29', undefined, RUN_SCOPE_MESSAGES[scope]);
  if ((pipeline.local_state?.length ?? 0) > 0) refuse('local_state', 'R8');
  if (
    Array.isArray(pipeline.dependencies) &&
    pipeline.dependencies.some(
      (dependency) => dependency.kind === 'local_runtime',
    )
  )
    refuse('local_runtime', 'R3');
  if (isDesktopPath(pipeline.defaults?.run?.working_directory))
    refuse('desktop_path', 'R5');
  for (const [jobId, job] of Object.entries(pipeline.jobs)) {
    const shell = job.defaults?.run?.shell ?? pipeline.defaults?.run?.shell;
    if (isDesktopPath(job.defaults?.run?.working_directory))
      refuse('desktop_path', 'R5', { jobId });
    // Raw text is parsed, not normalized, so a job may lack its steps.
    if (!Array.isArray(job.steps)) continue;
    for (const [stepIndex, step] of job.steps.entries())
      checkStep(pipeline, { jobId, stepIndex, step }, shell, scope, refuse);
  }
  return refusals;
}
