import {
  CLOUD_MODEL_ALTERNATIVES_MAX,
  type CloudModelChoice,
  type CloudModelHarness,
  type CloudModelOption,
  type CloudModelPreflightItem,
  type CloudModelPreflightReason,
} from '@canopy/protocol/canopy-core';
import { CLOUD_RUN_COMPOSITE_MODEL_ACTIONS } from './cloud-preflight';
import type { Pipeline, Step } from './document';
import { STATIC_MODEL_REFERENCE_ALIASES } from './static-model-reference-aliases';

/*
 * Cloud model preflight (CAN-6174, plan CP-26): rows R1 to R3 of
 * `docs/pipelines-cloud-parity.md` and the run owner's model policy, checked
 * for every model step before a cloud run starts.
 *
 * `findCloudModelItems` lists each model step a cloud run can't run as
 * written, with the cloud models the user may pick instead. It changes
 * nothing. `applyCloudModelChoices` is the only way a step's model changes
 * for a cloud run, and it refuses unless the user confirmed one listed
 * alternative for every item. The local definition is never edited: the
 * result is the snapshot the cloud run pins.
 *
 * Steps that `preflightCloudRun` refuses outright (expression models,
 * unresolved model aliases, plugin collections) are left to it; this module
 * skips them so one step is never listed twice.
 */

/**
 * What a step that names no model runs: the desktop's `DEFAULT_CLAUDE_MODEL`,
 * which the step runner checks against model policy and pins (CAN-5095).
 * The cloud preflight host parity golden keeps the two equal.
 */
export const CLOUD_DEFAULT_STEP_MODEL = 'opus[1m]';

/**
 * The bundled model actions a cloud run executes, with the harnesses each
 * runs there (`DAEMON_PORTABLE_MODEL_ACTIONS`; the host parity golden keeps
 * them equal). An alternative for a step must run on one of them.
 */
export const CLOUD_MODEL_ACTION_HARNESSES: Readonly<
  Record<string, readonly CloudModelHarness[]>
> = {
  'agent-prompt': ['claude', 'codex'],
  'agent-resume': ['claude', 'codex'],
  'agent-loop': ['claude'],
  'plan-with-review': ['claude'],
  'quality-gate': ['claude'],
  router: ['claude'],
  condenser: ['claude'],
  'parallel-agents': ['claude'],
};

/** The cloud catalog and the run owner's model policy, as preflight sees them. */
export interface CloudModelContext {
  /** The models cloud runs offer, by AI Gateway id, in display order. */
  readonly catalog: readonly CloudModelOption[];
  /** Whether the run owner's model policy refuses a cloud model id. */
  readonly isBlocked: (modelId: string) => boolean;
}

const MESSAGES: Readonly<Record<CloudModelPreflightReason, string>> = {
  subscription_model:
    "Cloud runs can't use this model. It needs the subscription you signed in with on this computer.",
  local_harness: 'This step uses {harness}, which only runs on your computer.',
  local_model:
    "Ollama models run on your computer and can't be reached from the cloud.",
  blocked_model: "Your organization's model policy doesn't allow this model.",
  action_harness: 'In cloud runs, this step only runs Claude models.',
};

const HARNESS_NAMES = {
  cursor: 'Cursor',
  copilot: 'Copilot',
  opencode: 'OpenCode',
} as const;

const PARITY_IDS: Readonly<Record<CloudModelPreflightReason, string>> = {
  subscription_model: 'R1',
  local_harness: 'R2',
  local_model: 'R3',
  blocked_model: 'CP-68',
  action_harness: 'CP-24',
};

const BUILTIN_PREFIX = 'builtin/';

/** `<jobId>#<stepIndex>`: the step an item and its choice belong to. */
export function cloudModelItemKey(jobId: string, stepIndex: number): string {
  return `${jobId}#${stepIndex}`;
}

/** The bundled model action a step's model runs on. */
interface StepModelAction {
  readonly action: string;
  /** The step runs a composite action whose model step runs `action` (CAN-6316 G4). */
  readonly composite: boolean;
  /** The step's own `permission_preset` reaches the model step. */
  readonly ownPermissionPreset: boolean;
}

/** The bundled model action a step's model runs on, or null. */
function modelActionOf(step: Step): StepModelAction | null {
  const uses = step.uses;
  if (uses === undefined || !uses.startsWith(BUILTIN_PREFIX)) return null;
  const name = uses
    .slice(BUILTIN_PREFIX.length)
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/');
  if (Object.prototype.hasOwnProperty.call(CLOUD_MODEL_ACTION_HARNESSES, name))
    return { action: name, composite: false, ownPermissionPreset: true };
  const inner = Object.prototype.hasOwnProperty.call(
    CLOUD_RUN_COMPOSITE_MODEL_ACTIONS,
    name,
  )
    ? CLOUD_RUN_COMPOSITE_MODEL_ACTIONS[name]
    : undefined;
  return inner === undefined
    ? null
    : {
        action: inner.action,
        composite: true,
        ownPermissionPreset: inner.forwardsPermissionPreset,
      };
}

type LocalHarness = keyof typeof HARNESS_NAMES;

/** The local-only harness a model id names (the desktop's model id formats). */
function localHarnessOf(model: string): LocalHarness | 'ollama' | null {
  if (model === 'cursor-default' || model.startsWith('cursor:'))
    return 'cursor';
  if (model.startsWith('copilot:')) return 'copilot';
  if (model.startsWith('opencode:')) return 'opencode';
  if (model.startsWith('ollama-')) return 'ollama';
  return null;
}

/** Whether `preflightCloudRun` already refuses the step's model or plugins. */
function refusedOutright(
  pipeline: Pipeline,
  step: Step,
  composite: boolean,
  model: string,
): boolean {
  return (
    model.includes('${{') ||
    (pipeline.plugin_collections?.length ?? 0) > 0 ||
    // A composite's own plugin collection reaches none of its steps.
    (!composite && step.with?.plugin_collection_id !== undefined) ||
    (pipeline.model_aliases?.some((alias) => alias.id === model) ?? false)
  );
}

/**
 * The harnesses `step` runs on in the cloud: its action's, without Codex
 * when the model step runs with `permission_preset: none`, which the step
 * runner refuses on the Codex harness because Codex can't disable its native
 * tools. A composite that fixes its model step's preset ignores the step's.
 */
function harnessesFor(
  step: Step,
  runs: StepModelAction,
): readonly CloudModelHarness[] {
  const harnesses = CLOUD_MODEL_ACTION_HARNESSES[runs.action] ?? [];
  const preset = runs.ownPermissionPreset
    ? step.with?.permission_preset
    : undefined;
  return preset !== undefined && String(preset).trim() === 'none'
    ? harnesses.filter((harness) => harness !== 'codex')
    : harnesses;
}

/** What a step's model is, as preflight judges it. */
interface StepModel {
  /** The local-only harness it names, or null. */
  readonly local: LocalHarness | 'ollama' | null;
  /** Its cloud catalog entry, when it has one. */
  readonly cloud: CloudModelOption | undefined;
  /** The harnesses the step's action runs in the cloud. */
  readonly runs: readonly CloudModelHarness[];
}

/** Why the step needs a replacement, or null when it runs as written. */
function reasonFor(
  { local, cloud, runs }: StepModel,
  context: CloudModelContext,
): CloudModelPreflightReason | null {
  if (local === 'ollama') return 'local_model';
  if (local !== null) return 'local_harness';
  if (cloud === undefined) return 'subscription_model';
  if (context.isBlocked(cloud.modelId)) return 'blocked_model';
  return runs.includes(cloud.harness) ? null : 'action_harness';
}

/**
 * Catalog models the step's action runs and the policy allows, other than
 * its own, with its own harness first.
 */
function alternativesFor(
  { cloud, runs }: StepModel,
  context: CloudModelContext,
): CloudModelOption[] {
  const preferred = cloud?.harness;
  return context.catalog
    .filter(
      (option) =>
        runs.includes(option.harness) &&
        option.modelId !== cloud?.modelId &&
        !context.isBlocked(option.modelId),
    )
    .sort(
      (a, b) =>
        Number(b.harness === preferred) - Number(a.harness === preferred),
    )
    .slice(0, CLOUD_MODEL_ALTERNATIVES_MAX);
}

/** The step's item, or null when it isn't a model step that needs one. */
function itemFor(
  pipeline: Pipeline,
  at: {
    readonly jobId: string;
    readonly stepIndex: number;
    readonly step: Step;
  },
  context: CloudModelContext,
  byId: ReadonlyMap<string, CloudModelOption>,
): CloudModelPreflightItem | null {
  const { jobId, stepIndex, step } = at;
  const runs = modelActionOf(step);
  if (runs === null) return null;
  const written =
    step.with?.model === undefined ? '' : String(step.with.model).trim();
  if (refusedOutright(pipeline, step, runs.composite, written)) return null;
  const model =
    ownValue(STATIC_MODEL_REFERENCE_ALIASES, written) ??
    (written === '' ? CLOUD_DEFAULT_STEP_MODEL : written);
  const local = localHarnessOf(model);
  const judged: StepModel = {
    local,
    cloud: local === null ? byId.get(gatewayIdOf(model)) : undefined,
    runs: harnessesFor(step, runs),
  };
  const reason = reasonFor(judged, context);
  if (reason === null) return null;
  const harness = local ?? judged.cloud?.harness;
  const stepName = step.name ?? step.id;
  return {
    itemKey: cloudModelItemKey(jobId, stepIndex),
    reason,
    parityId: PARITY_IDS[reason],
    message: MESSAGES[reason].replace(
      '{harness}',
      local !== null && local !== 'ollama' ? HARNESS_NAMES[local] : '',
    ),
    jobId,
    stepIndex,
    ...(stepName === undefined ? {} : { stepName }),
    uses: step.uses ?? '',
    model: written,
    ...(harness === undefined ? {} : { harness }),
    alternatives: alternativesFor(judged, context),
  };
}

/** Whether any step runs a bundled model action, so models need a check. */
export function hasCloudModelSteps(pipeline: Pipeline): boolean {
  return Object.values(pipeline.jobs).some(
    (job) =>
      Array.isArray(job.steps) &&
      job.steps.some((step) => modelActionOf(step) !== null),
  );
}

/**
 * The model steps of `pipeline` a cloud run can't run as written, in
 * document order, each with its alternatives: catalog models the step's
 * action runs and the policy allows, the step's own harness first.
 */
export function findCloudModelItems(
  pipeline: Pipeline,
  context: CloudModelContext,
): CloudModelPreflightItem[] {
  const byId = new Map(context.catalog.map((model) => [model.modelId, model]));
  const items: CloudModelPreflightItem[] = [];
  for (const [jobId, job] of Object.entries(pipeline.jobs)) {
    // Raw text is parsed, not normalized, so a job may lack its steps.
    if (!Array.isArray(job.steps)) continue;
    for (const [stepIndex, step] of job.steps.entries()) {
      const item = itemFor(pipeline, { jobId, stepIndex, step }, context, byId);
      if (item !== null) items.push(item);
    }
  }
  return items;
}

/**
 * The AI Gateway id of each desktop model the cloud can route, and the
 * desktop's model aliases: root `package.json` `claude-code` and `codex`
 * `models[].gatewayId` and `modelAliases`, which the web core can't read.
 * The cloud preflight host parity golden keeps both equal to it. A model
 * with no gateway id runs only with a subscription sign-in (R1).
 */
export const CLOUD_NATIVE_MODEL_GATEWAY_IDS: Readonly<Record<string, string>> =
  {
    'claude-fable-5-2': 'anthropic/claude-fable-5.2',
    'claude-fable-5-1': 'anthropic/claude-fable-5.1',
    'opus[1m]': 'anthropic/claude-opus-5.5',
    sonnet: 'anthropic/claude-sonnet-5.5',
    haiku: 'anthropic/claude-haiku-5.5',
    'claude-fable-5': 'anthropic/claude-fable-5',
    'claude-opus-5': 'anthropic/claude-opus-5',
    'claude-sonnet-5': 'anthropic/claude-sonnet-5',
    'claude-opus-4-8': 'anthropic/claude-opus-4.8',
    'claude-opus-4-7': 'anthropic/claude-opus-4.7',
    'claude-opus-4-6': 'anthropic/claude-opus-4.6',
    'claude-haiku-4-5-20251001': 'anthropic/claude-haiku-4.5',
    'gpt-6.1-terra': 'openai/gpt-6.1-terra',
    'gpt-6-luna': 'openai/gpt-6-luna',
    'gpt-5.6-sol': 'openai/gpt-5.6-sol',
    'gpt-5.6-terra': 'openai/gpt-5.6-terra',
    'gpt-5.6-luna': 'openai/gpt-5.6-luna',
  };

export const CLOUD_NATIVE_MODEL_ALIASES: Readonly<Record<string, string>> = {
  fable: 'claude-fable-5-2',
  'fable[1m]': 'claude-fable-5-2',
  opus: 'opus[1m]',
  'claude-opus-5-5': 'opus[1m]',
  'sonnet[1m]': 'sonnet',
  'claude-sonnet-5-5': 'sonnet',
  'claude-sonnet-4-5': 'sonnet',
  'claude-sonnet-4-5-20250514': 'sonnet',
  'claude-sonnet-4-5-20250929': 'sonnet',
  'claude-sonnet-4-6': 'sonnet',
  'claude-haiku-5-5': 'haiku',
  'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
  'gpt-5.4': 'gpt-6-sol',
  'gpt-5.4-mini': 'gpt-6-luna',
  'gpt-5.5': 'gpt-6.1-sol',
};

function ownValue(
  table: Readonly<Record<string, string>>,
  key: string,
): string | undefined {
  return Object.prototype.hasOwnProperty.call(table, key)
    ? table[key]
    : undefined;
}

/**
 * The cloud catalog id a desktop model id or alias names: its pinned AI
 * Gateway id, or the id itself (a gateway id such as `anthropic/claude-opus-5.5`).
 */
function gatewayIdOf(model: string): string {
  const resolved = ownValue(CLOUD_NATIVE_MODEL_ALIASES, model) ?? model;
  return ownValue(CLOUD_NATIVE_MODEL_GATEWAY_IDS, resolved) ?? resolved;
}

export type CloudModelChoicesOutcome =
  | {
      readonly ok: true;
      readonly pipeline: Pipeline;
      /** Each replacement, for the run's record. */
      readonly applied: readonly (CloudModelChoice & {
        readonly from: string;
      })[];
    }
  | {
      readonly ok: false;
      /** Items with no confirmed choice, or a choice it doesn't list. */
      readonly unconfirmed: readonly string[];
      /** Choices for steps that have no item. */
      readonly unknown: readonly string[];
    };

/**
 * `pipeline` with each item's model replaced by the user's confirmed
 * choice, or the items still unconfirmed. Every item needs exactly one
 * choice naming one of its listed alternatives, and every choice must belong
 * to an item: a choice is never inferred, defaulted or carried to another
 * step. `pipeline` itself is not changed.
 */
export function applyCloudModelChoices(
  pipeline: Pipeline,
  items: readonly CloudModelPreflightItem[],
  choices: readonly CloudModelChoice[],
): CloudModelChoicesOutcome {
  const chosen = new Map<string, string[]>();
  for (const choice of choices)
    chosen.set(choice.itemKey, [
      ...(chosen.get(choice.itemKey) ?? []),
      choice.modelId,
    ]);
  const keys = new Set(items.map((item) => item.itemKey));
  const unknown = [...chosen.keys()].filter((key) => !keys.has(key));
  const unconfirmed = items
    .filter((item) => {
      const picked = chosen.get(item.itemKey);
      return (
        picked === undefined ||
        picked.length !== 1 ||
        !item.alternatives.some((option) => option.modelId === picked[0])
      );
    })
    .map((item) => item.itemKey);
  if (unconfirmed.length > 0 || unknown.length > 0)
    return { ok: false, unconfirmed, unknown };
  if (items.length === 0) return { ok: true, pipeline, applied: [] };

  const jobs: Pipeline['jobs'] = { ...pipeline.jobs };
  const applied: (CloudModelChoice & { from: string })[] = [];
  for (const item of items) {
    const modelId = chosen.get(item.itemKey)?.[0];
    const job = jobs[item.jobId];
    const step = job?.steps[item.stepIndex];
    if (modelId === undefined || job === undefined || step === undefined)
      return { ok: false, unconfirmed: [item.itemKey], unknown: [] };
    const steps = [...job.steps];
    steps[item.stepIndex] = { ...step, with: { ...step.with, model: modelId } };
    jobs[item.jobId] = { ...job, steps };
    applied.push({ itemKey: item.itemKey, modelId, from: item.model });
  }
  return { ok: true, pipeline: { ...pipeline, jobs }, applied };
}
