import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import type {
  Pipeline,
  PipelinePluginCollectionPreference,
  PipelinePluginDefault,
  PipelinePluginDefaultPreviewItem,
  Step,
} from '@canopy/execution-engine/types/pipeline';
import { isShareablePluginRef } from '@canopy/protocol/plugins';
import { getPipelinePluginDefaultKey } from '@canopy/execution-engine/pipelines/plugin-collections';
import { parseJsonInputValue } from './pipelineTriggerInputs';

/** The step whose "Send as" a workflow chooses (CAN-7186). */
const SEND_AGENT_MESSAGE_USES = 'builtin/send-agent-message';

/** The collection a send step with no selections of its own is given. */
const SEND_AS_COLLECTION_ID = 'send_as';

/**
 * Where a send step's own selections live, which is where its "Send as"
 * choice is kept:
 * - `collection`: the preferences on this machine of the workflow's plugin
 *   collection the step names (a converted automation's `chat_plugins`);
 * - `selections`: the step's own `plugin_selections` JSON;
 * - `none`: neither yet; a choice gives the step a collection.
 */
export type StepSendAsSource =
  | { readonly kind: 'collection'; readonly collectionId: string }
  | {
      readonly kind: 'selections';
      readonly selections: ChatTabPluginSelections;
    }
  | { readonly kind: 'none' };

/** The chat a send step's message goes to, for the selections it inherits. */
export interface StepSendAsChat {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
}

/**
 * What a send step's message inherits: the project whose defaults a chat
 * there loads, and the existing chat it goes to, when they are known.
 */
export interface StepSendAsTarget {
  readonly projectId?: string;
  readonly chat?: StepSendAsChat;
}

/**
 * `${{ inputs.name }}`, as conversion writes a step's target, or the bracket
 * form `${{ inputs['name'] }}`.
 */
const INPUT_EXPRESSION =
  /^\$\{\{\s*inputs(?:\.([A-Za-z0-9_-]+)|\[\s*(['"])([^'"]+)\2\s*\])\s*\}\}$/;

function stepText(step: Step, key: string): string | undefined {
  const value = step.with?.[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** A step input's value: written, or the run value its input reads. */
function resolvedText(
  step: Step,
  key: string,
  inputValues: Readonly<Record<string, string>> | undefined,
): string | undefined {
  const value = stepText(step, key);
  if (value === undefined) return undefined;
  const match = INPUT_EXPRESSION.exec(value);
  const input = match?.[1] ?? match?.[3];
  if (input !== undefined) return inputValues?.[input] || undefined;
  return value.includes('${{') ? undefined : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Where a send step keeps its "Send as" choice, or `undefined` when it is
 * not a send step or its selections are an expression the editor can't
 * change, or a collection the workflow doesn't declare.
 */
export function stepSendAsSource(
  step: Step,
  pipeline: Pipeline,
): StepSendAsSource | undefined {
  if (step.uses !== SEND_AGENT_MESSAGE_USES || step.run !== undefined)
    return undefined;
  const collectionId = stepText(step, 'plugin_collection_id');
  const selections = stepText(step, 'plugin_selections');
  // An existing Orchestrator chat refuses a hand-run turn that changes its
  // plugins, so a step that selects none isn't given any. One that already
  // does (a converted Orchestrator schedule, whose scheduled sends apply
  // them) shows and edits its choice.
  if (
    stepText(step, 'bot_id') !== undefined &&
    stepText(step, 'chat_id') !== undefined &&
    collectionId === undefined &&
    selections === undefined
  )
    return undefined;
  if (collectionId !== undefined) {
    if (selections !== undefined) return undefined;
    const id = collectionId.trim();
    return (pipeline.plugin_collections ?? []).some(
      (collection) => collection.id.trim() === id,
    )
      ? { kind: 'collection', collectionId: id }
      : undefined;
  }
  if (selections !== undefined) {
    // Text that doesn't parse fails the run anyway; the editor leaves it.
    const parsed = parseJsonInputValue(selections);
    return isRecord(parsed)
      ? { kind: 'selections', selections: normalizePluginSelections(parsed) }
      : undefined;
  }
  return { kind: 'none' };
}

/**
 * Where a send step's message goes, when its ids are written or read from
 * the run values shown (a workflow's first schedule's): the project, whose
 * defaults its chat inherits, and the existing chat, when it names one. An
 * Orchestrator target has no project defaults.
 */
export function stepSendAsTarget(
  step: Step,
  inputValues?: Readonly<Record<string, string>>,
): StepSendAsTarget {
  const bot = stepText(step, 'bot_id') !== undefined;
  const projectId = bot
    ? APP_ADVISOR_PROJECT_ID
    : resolvedText(step, 'project_id', inputValues);
  const chatId = resolvedText(step, 'chat_id', inputValues);
  const worktreeId = resolvedText(step, 'task_id', inputValues);
  return {
    ...(projectId !== undefined && !bot ? { projectId } : {}),
    ...(projectId !== undefined &&
    chatId !== undefined &&
    worktreeId !== undefined
      ? { chat: { projectId, worktreeId, chatId } }
      : {}),
  };
}

/**
 * The shareable plugins a send step's `plugins` input turns on, which can
 * bring connectors too, read through the run values shown when it names an
 * input. Another expression, or text that doesn't parse, brings none here;
 * the run refuses text that doesn't parse.
 */
export function stepSendAsPlugins(
  step: Step,
  inputValues?: Readonly<Record<string, string>>,
): PipelinePluginDefault[] {
  if (step.uses !== SEND_AGENT_MESSAGE_USES) return [];
  // An input the run fills (`${{ inputs.plugins }}`) reads the value shown.
  const text = resolvedText(step, 'plugins', inputValues);
  const parsed = text === undefined ? undefined : parseJsonInputValue(text);
  if (!Array.isArray(parsed)) return [];
  // Repeats are dropped by the run's own key, as the run drops them.
  const seen = new Set<string>();
  return parsed.flatMap((item): PipelinePluginDefault[] => {
    if (!isShareablePluginRef(item)) return [];
    const key = getPipelinePluginDefaultKey(item);
    if (seen.has(key)) return [];
    seen.add(key);
    return [item];
  });
}

/**
 * How many places load a plugin collection: steps that name it, and model
 * aliases whose defaults do. A "Send as" choice kept in it applies to all.
 */
export function pluginCollectionUsers(
  pipeline: Pipeline,
  collectionId: string,
): number {
  const steps = Object.values(pipeline.jobs).flatMap((job) =>
    job.steps.filter(
      (step) => stepText(step, 'plugin_collection_id')?.trim() === collectionId,
    ),
  ).length;
  const aliases = (pipeline.model_aliases ?? []).filter(
    (alias) =>
      alias.defaults !== undefined &&
      'plugin_collection_id' in alias.defaults &&
      alias.defaults.plugin_collection_id?.trim() === collectionId,
  ).length;
  return steps + aliases;
}

/**
 * The plugins a collection's enabled defaults matched in the catalog, as
 * selections: a catalog key is `<marketplaceId>/<pluginName>`.
 */
export function matchedDefaultPlugins(
  collectionId: string,
  previewItems: readonly PipelinePluginDefaultPreviewItem[],
  disabledDefaultKeys: readonly string[] = [],
): ChatTabPluginSelections['pluginRefs'] {
  const disabled = new Set(disabledDefaultKeys);
  return previewItems.flatMap((item) => {
    if (
      item.collectionId !== collectionId ||
      item.kind !== 'plugin' ||
      item.matchState !== 'matched' ||
      item.matchedCatalogKey === undefined ||
      (!item.required &&
        (disabled.has(item.defaultKey) || !item.enabledByDefault))
    )
      return [];
    const split = item.matchedCatalogKey.lastIndexOf('/');
    return split > 0
      ? [
          {
            marketplaceId: item.matchedCatalogKey.slice(0, split),
            pluginName: item.matchedCatalogKey.slice(split + 1),
          },
        ]
      : [];
  });
}

const EMPTY_SELECTIONS: ChatTabPluginSelections = {
  collectionIds: [],
  skillRefs: [],
  pluginRefs: [],
  mcpServerRefs: [],
};

/** A collection preference with nothing chosen. */
export function emptyCollectionPreference(): PipelinePluginCollectionPreference {
  return { disabledDefaultKeys: [], extraSelections: EMPTY_SELECTIONS };
}

/**
 * A step's own selections as the run resolves them: a collection's extras
 * and the plugins its enabled defaults matched, or its `plugin_selections`.
 */
export function stepSendAsSelections(
  source: StepSendAsSource,
  preference: PipelinePluginCollectionPreference | undefined,
  previewItems: readonly PipelinePluginDefaultPreviewItem[],
): ChatTabPluginSelections {
  switch (source.kind) {
    case 'selections':
      return source.selections;
    case 'none':
      return EMPTY_SELECTIONS;
    case 'collection': {
      const extra = preference?.extraSelections ?? EMPTY_SELECTIONS;
      return {
        ...extra,
        pluginRefs: [
          ...extra.pluginRefs,
          ...matchedDefaultPlugins(
            source.collectionId,
            previewItems,
            preference?.disabledDefaultKeys,
          ),
        ],
      };
    }
  }
}

/** The step with its `plugin_selections` replaced. */
export function withStepPluginSelections(
  step: Step,
  selections: ChatTabPluginSelections,
): Step {
  return {
    ...step,
    with: { ...step.with, plugin_selections: JSON.stringify(selections) },
  };
}

/**
 * The pipeline with a step that has no selections of its own given a new
 * empty plugin collection, so its "Send as" choice can be kept on this
 * machine and never in the YAML. Returns the collection's id.
 */
export function withStepSendAsCollection(
  pipeline: Pipeline,
  jobId: string,
  stepIndex: number,
  /** Ids not to reuse, such as ones a pending choice still names. */
  reserved: readonly string[] = [],
): { pipeline: Pipeline; collectionId: string } | undefined {
  const job = pipeline.jobs[jobId];
  const step = job?.steps[stepIndex];
  if (!job || !step) return undefined;
  const taken = new Set([
    ...(pipeline.plugin_collections ?? []).map((collection) => collection.id),
    ...reserved,
  ]);
  let collectionId = SEND_AS_COLLECTION_ID;
  for (let n = 2; taken.has(collectionId); n += 1)
    collectionId = `${SEND_AS_COLLECTION_ID}_${n}`;
  const steps = [...job.steps];
  steps[stepIndex] = {
    ...step,
    with: { ...step.with, plugin_collection_id: collectionId },
  };
  return {
    collectionId,
    pipeline: {
      ...pipeline,
      plugin_collections: [
        ...(pipeline.plugin_collections ?? []),
        { id: collectionId, name: 'Send as', defaults: [] },
      ],
      jobs: { ...pipeline.jobs, [jobId]: { ...job, steps } },
    },
  };
}
