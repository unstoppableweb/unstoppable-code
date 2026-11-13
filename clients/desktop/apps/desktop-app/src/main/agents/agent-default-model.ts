import {
  AGENT_MODELS,
  APP_ADVISOR_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  isAgentModel,
  isBaseModelSelectableForAgent,
  isInheritingAgentModel,
  resolveAgentModelDefinition,
  type ChatModel,
  type PreferencesData,
} from '@canopy/desktop-shared/types';
import {
  formatAgentRouteModelId,
  parseAgentRouteModelId,
} from '@canopy/protocol/agents';
import {
  requireLaneAwareDefaultSelection,
  resolveAppAdvisorDefaultModel,
} from '../lib/default-model-lane-resolver';
import { readPreferencesFile } from '../lib/preferences-store';
import { isCoworkWorkspace } from '../lib/workspace-registry';

/**
 * The Settings default a new chat in `projectId` would start on, used to
 * materialize an Agent that inherits the default model. Mirrors the
 * destination's own default: the model a new App Advisor chat starts on, otherwise the
 * chat lane default for Cowork and the Pipeline Assistant, or the worktree
 * lane default.
 */
export async function resolveAgentDestinationDefaultModel(
  projectId: string | undefined,
): Promise<ChatModel> {
  const preferences = await readPreferencesFile();
  if (projectId === APP_ADVISOR_PROJECT_ID) {
    return resolveAppAdvisorDefaultModel(preferences);
  }
  const selection = await requireLaneAwareDefaultSelection(
    preferences,
    projectId !== undefined &&
      (isCoworkWorkspace(projectId) || projectId === PIPELINE_EDITOR_PROJECT_ID)
      ? 'chat'
      : 'worktree',
    { workspaceId: projectId ?? null },
    undefined,
    // Answers "what would this chat start on?" without restamping the
    // Portal catalog projection.
    false,
  );
  return selection.model;
}

// Catalogs are rebuilt on every streamed message; this bounds the default
// resolutions they trigger.
const CATALOG_AGENT_DEFAULT_TTL_MS = 2_000;
const catalogAgentDefaults = new Map<
  string,
  { at: number; model: Promise<ChatModel | undefined> }
>();

/**
 * The model a Portal catalog for `projectId` describes an Agent on the default
 * model by: the default that destination pins it to. Undefined while no such
 * Agent exists, or when the destination has no usable default.
 */
export function resolveCatalogAgentDefaultModel(
  projectId: string,
): Promise<ChatModel | undefined> {
  if (!AGENT_MODELS.some((model) => isInheritingAgentModel(model)))
    return Promise.resolve(undefined);
  const now = Date.now();
  const cached = catalogAgentDefaults.get(projectId);
  if (cached && now - cached.at < CATALOG_AGENT_DEFAULT_TTL_MS)
    return cached.model;
  const model = resolveAgentDestinationDefaultModel(projectId).catch(
    (): undefined => undefined,
  );
  catalogAgentDefaults.set(projectId, { at: now, model });
  return model;
}

export function resetCatalogAgentDefaultModelsForTests(): void {
  catalogAgentDefaults.clear();
}

/** The settings a destination's default model resolves from. */
const DEFAULT_MODEL_PREFERENCE_KEYS = [
  'defaultChatProvider',
  'defaultChatModelByProvider',
  'defaultWorktreeProvider',
  'defaultWorktreeModelByProvider',
  'appAdvisorModel',
] as const satisfies readonly (keyof PreferencesData)[];

/**
 * After a default-model setting changes, drop cached destination defaults and
 * re-project loaded Portal catalogs, so Default-model Agent rows follow it.
 */
export async function refreshCatalogAgentDefaults(
  changed: Partial<PreferencesData>,
): Promise<void> {
  if (!DEFAULT_MODEL_PREFERENCE_KEYS.some((key) => key in changed)) return;
  catalogAgentDefaults.clear();
  if (!AGENT_MODELS.some((model) => isInheritingAgentModel(model))) return;
  // Lazy: the Portal bus reaches services that import this module.
  const { notifyPortalModelCatalogChanged } =
    await import('../portal/portal-event-bus');
  await notifyPortalModelCatalogChanged();
}

/**
 * Chat model id pinning an inheriting Agent to a resolved default. A default
 * that is itself an Agent would nest Agents, so it is refused.
 */
export function formatInheritedAgentRoute(
  agentId: string,
  defaultModel: ChatModel,
): string {
  if (isAgentModel(defaultModel)) {
    throw new Error(
      `Agent "${agentId}" uses the default model, but the default model is an Agent. Choose a provider model as the default in Settings, or choose a base model for this Agent.`,
    );
  }
  return formatAgentRouteModelId(agentId, defaultModel);
}

/**
 * Refuse a route id for an Agent with its own base model, so a supplied route
 * cannot run a pinned Agent on another model.
 */
export function assertAgentRouteModel(model: ChatModel): void {
  const route = parseAgentRouteModelId(model);
  if (route && !isInheritingAgentModel(route.agentId)) {
    throw new Error(
      `Agent "${route.agentId}" has its own base model. Choose the Agent itself instead of "${model}".`,
    );
  }
}

/**
 * Refuse a route whose pinned base is no longer selectable before anything is
 * written; runtime would refuse it only after the send was saved.
 */
function assertAgentRouteBaseAvailable(model: ChatModel): void {
  const route = parseAgentRouteModelId(model);
  // A pinned Agent runs on its own base, whatever route names it.
  if (
    !route ||
    !isInheritingAgentModel(route.agentId) ||
    isBaseModelSelectableForAgent(route.baseModel)
  )
    return;
  const name =
    resolveAgentModelDefinition(route.agentId)?.name ?? route.agentId;
  throw new Error(
    `Agent "${name}" is set to unavailable model "${route.baseModel}". Choose the Agent again or choose another model.`,
  );
}

/**
 * The route a send must carry, settled before anything about the send is
 * saved or queued; undefined when the selection needs no pin. The selection is
 * the requested model, else the chat's stored one. A chat already on this
 * Agent's route keeps it, so Settings changes never reroute it. Throws for a
 * nested default, an unusable default, or a route forged for a pinned Agent.
 */
export async function resolveSendModelPin(
  projectId: string,
  stored: ChatModel | undefined,
  requested: ChatModel | undefined,
): Promise<ChatModel | undefined> {
  const selected = requested ?? stored;
  if (selected === undefined) return undefined;
  // A stored route stays valid after its Agent stops inheriting.
  if (selected !== stored) assertAgentRouteModel(selected);
  const pinned = await pinSelectedAgent(projectId, stored, selected);
  // Whatever the send carries is checked: the selection, a route the chat
  // keeps, or one pinned just now.
  assertAgentRouteBaseAvailable(pinned ?? selected);
  return pinned;
}

async function pinSelectedAgent(
  projectId: string,
  stored: ChatModel | undefined,
  selected: ChatModel,
): Promise<ChatModel | undefined> {
  if (!isInheritingAgentModel(selected)) return undefined;
  if (
    stored !== undefined &&
    parseAgentRouteModelId(stored)?.agentId === selected
  )
    return stored;
  return formatInheritedAgentRoute(
    selected,
    await resolveAgentDestinationDefaultModel(projectId),
  );
}

/**
 * Pin a bare inheriting Agent to the default of the chat it is chosen for;
 * any other model is returned unchanged. Throws when no default is usable.
 */
export async function pinInheritingAgentToDestination(
  model: ChatModel,
  projectId: string,
): Promise<ChatModel> {
  assertAgentRouteModel(model);
  return isInheritingAgentModel(model)
    ? formatInheritedAgentRoute(
        model,
        await resolveAgentDestinationDefaultModel(projectId),
      )
    : model;
}
