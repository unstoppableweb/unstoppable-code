import {
  getAgentModelSelectionId,
  type ChatTabPluginSelections,
  type PluginSelectionTombstones,
} from '@canopy/desktop-shared/types';
import {
  chatInheritsProjectDefaults,
  effectiveChatPluginSelections,
  effectiveGlobalPluginSelections,
  organizationLayersFor,
  globalLayerForConnectorScope,
  inheritedPluginSelections,
  projectDefaultsForChat,
  splitChosenChatPluginSelections,
  subtractPluginSelections,
  unionPluginSelections,
  chatSurfaceUsesGlobalPluginDefaults,
  type InheritedPluginLayers,
} from '@canopy/desktop-shared/lib/effective-plugin-selections';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import {
  mergeAgentChatPluginSelections,
  stripAgentOnlyChatPluginSelections,
} from './chatPluginSelections';
import { useGlobalPluginDefaultsStore } from '@/stores/globalPluginDefaultsStore';
import { useOrganizationLayerStore } from '@/stores/organizationLayerStore';
import type { OrganizationLayerView } from '@canopy/desktop-shared/lib/organization-capabilities';
import { useModelCatalogStore } from '@/stores/modelCatalogStore';
import type { useChatStore } from '@/stores/chatStore';
import {
  getProjectConnectorScope,
  getProjectPluginDefaults,
  getProjectPluginTombstones,
} from '@/stores/chat/tab-utils';
import { queueDesktopTryItSelectionUpdate } from './tryItContinuationRunner';
import { shouldMaterializeCodexThread } from '@/components/chat/codex-thread-materialization';

type ChatState = ReturnType<typeof useChatStore.getState>;
export interface PluginChatTarget {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

/**
 * The inherited layers a plugin list labels as defaults. A global the project
 * turned off is not inherited, so it is never labelled a global default.
 */
export function inheritedDefaultLayers(layers: InheritedPluginLayers): {
  project?: ChatTabPluginSelections;
  global?: ChatTabPluginSelections;
  organization?: ChatTabPluginSelections;
} {
  // A person's global connectors are not inherited in an organization's
  // workspace (CAN-6230), so they are never labelled global defaults there.
  const global = globalLayerForConnectorScope(
    layers.global,
    layers.connectorScope,
  );
  return {
    ...(layers.organization ? { organization: layers.organization } : {}),
    ...(layers.projectDefaults ? { project: layers.projectDefaults } : {}),
    ...(global
      ? {
          global: effectiveGlobalPluginSelections(global, [
            layers.projectTombstones,
          ]),
        }
      : {}),
  };
}

/**
 * Read the captured chat, never whichever tab happens to be active after IPC.
 * `projectDefaults` is the project layer the chat inherits: none for a chat
 * written before it was live (`chatInheritsProjectDefaults`), which owns every
 * ref it has until main normalizes it. `projectTombstones` are the globals the
 * project turned off, which the chat does not inherit either.
 */
export function chatPluginEditingState(
  state: ChatState,
  target: PluginChatTarget,
): {
  tab: ChatState['worktreeChats'][string]['tabs'][number];
  global: ChatTabPluginSelections | undefined;
  projectDefaults: ChatTabPluginSelections | undefined;
  projectTombstones: PluginSelectionTombstones | undefined;
  /** The organization fields of the chat's layers (CAN-6237). */
  organizationLayers: Pick<
    InheritedPluginLayers,
    'organization' | 'allowedOrganizationItems'
  >;
  organizationView: OrganizationLayerView | undefined;
  agent: ChatTabPluginSelections | undefined;
  effective: ChatTabPluginSelections;
} {
  const tab = state.worktreeChats[
    `${target.projectId}/${target.worktreeId}`
  ]?.tabs.find((t) => t.id === target.chatId);
  if (!tab) throw new Error('Chat is no longer available.');
  const defaults = useGlobalPluginDefaultsStore.getState();
  // The global layer this chat inherits: without a person's global
  // connectors in an organization's workspace (CAN-6230).
  const global =
    chatSurfaceUsesGlobalPluginDefaults(target.projectId) && defaults.hydrated
      ? globalLayerForConnectorScope(
          defaults.selections,
          getProjectConnectorScope(target.projectId, target.worktreeId),
        )
      : undefined;
  const rawProjectDefaults = projectDefaultsForChat(
    tab,
    getProjectPluginDefaults(
      target.projectId,
      target.worktreeId,
      state.worktreeDefaultPlugins,
    ),
  );
  const projectDefaults = rawProjectDefaults
    ? normalizePluginSelections(rawProjectDefaults)
    : undefined;
  const projectTombstones = getProjectPluginTombstones(target.projectId);
  // The organization's shared set, as the turn resolves it (CAN-6237); read
  // into the store before any edit (`editChatPlugins`).
  const organizationView = chatSurfaceUsesGlobalPluginDefaults(target.projectId)
    ? (useOrganizationLayerStore.getState().views[
        `${target.projectId}/${target.worktreeId}`
      ] ?? undefined)
    : undefined;
  const organizationLayers = organizationLayersFor(
    organizationView,
    chatInheritsProjectDefaults(tab),
  );
  // A chat pinned to an Agent route takes that Agent's plugins.
  const agentId = tab.model ? getAgentModelSelectionId(tab.model) : undefined;
  const agent = useModelCatalogStore
    .getState()
    .snapshot?.agents?.find((entry) => entry.id === agentId)?.pluginSelections;
  const displayed = effectiveChatPluginSelections({
    local: tab.pluginSelections,
    projectDefaults,
    global,
    projectTombstones,
    chatTombstones: tab.disabledGlobalPluginSelections,
    ...organizationLayers,
  });
  return {
    tab,
    global,
    projectDefaults,
    projectTombstones,
    organizationLayers,
    organizationView,
    agent,
    effective: normalizePluginSelections(
      mergeAgentChatPluginSelections(displayed, agent),
    ),
  };
}

/**
 * {@link chatPluginEditingState} for render: `null` when the chat is gone.
 * React reads the active chat id from the frame-batched render view, which can
 * still show a chat the live store has already removed.
 */
export function renderedChatPluginEditingState(
  state: ChatState,
  target: PluginChatTarget,
): ReturnType<typeof chatPluginEditingState> | null {
  return state.worktreeChats[
    `${target.projectId}/${target.worktreeId}`
  ]?.tabs.some((t) => t.id === target.chatId)
    ? chatPluginEditingState(state, target)
    : null;
}

/** Thrown when a chat cannot take a plugin change yet; callers may match on it. */
export const CHAT_PLUGINS_BUSY_MESSAGE =
  'Wait for this chat to finish before changing plugins.';

export async function editChatPlugins(
  getState: () => ChatState,
  target: PluginChatTarget,
  edit: (current: ChatTabPluginSelections) => ChatTabPluginSelections,
): Promise<void> {
  return queueDesktopTryItSelectionUpdate(target, async () => {
    // An unread organization layer would read the chat's organization picks
    // as not allowed, and the save would drop them.
    if (chatSurfaceUsesGlobalPluginDefaults(target.projectId))
      await useOrganizationLayerStore
        .getState()
        .load(target.projectId, target.worktreeId);
    const {
      tab,
      global,
      projectDefaults,
      projectTombstones,
      organizationLayers,
      agent,
      effective,
    } = chatPluginEditingState(getState(), target);
    if (
      tab.readOnly ||
      tab.pendingInitialCreation ||
      tab.status === 'streaming'
    )
      throw new Error(CHAT_PLUGINS_BUSY_MESSAGE);
    // Edits work on the effective set, whose refs keep their owners
    // (CAN-6235), so an owner-aware removal is saved as made; only a picker,
    // which keys rows by identity, needs owners put back.
    const chosen = edit(effective);
    const stripped = stripAgentOnlyChatPluginSelections(
      chosen,
      agent,
      tab.pluginSelections,
    );
    // Tombstones derive from the pre-strip chosen set so agent-locked stripping
    // cannot turn off a default the user left on.
    const { localSelections } = splitChosenChatPluginSelections({
      chosen: stripped,
      projectDefaults,
      global,
      projectTombstones,
      ...organizationLayers,
      previousLocal: tab.pluginSelections,
      previousTombstones: tab.disabledGlobalPluginSelections,
    });
    const { tombstones } = splitChosenChatPluginSelections({
      chosen,
      projectDefaults,
      global,
      projectTombstones,
      ...organizationLayers,
      previousTombstones: tab.disabledGlobalPluginSelections,
    });
    const inherits =
      global !== undefined ||
      projectDefaults !== undefined ||
      organizationLayers.organization !== undefined;
    const response = await window.api.chat.updatePlugins({
      ...target,
      pluginSelections: localSelections,
      ...(inherits ? { disabledGlobalPluginSelections: tombstones } : {}),
      deferredToolsAllowed: tab.deferredToolsAllowed,
      materializeCodexThread: shouldMaterializeCodexThread({
        providerType: tab.providerType,
        executionHarness: tab.executionHarness,
        sdkSessionId: tab.sdkSessionId,
      }),
      expectedCurrentThreadId: tab.sdkSessionId,
    });
    getState().setPluginSelections(
      response.pluginSelections,
      target,
      response.deferredToolsAllowed,
      {
        runtimeAlreadyUpdated: true,
        ...(inherits
          ? {
              disabledGlobalPluginSelections:
                response.disabledGlobalPluginSelections ?? tombstones,
            }
          : {}),
        ...(response.sdkSessionId
          ? { sdkSessionId: response.sdkSessionId }
          : {}),
      },
    );
  });
}

/**
 * Applies auth handler choices made on a chat's effective selections (for
 * example the Activity MCP proxy toggle) to the selections the chat owns.
 * Choices that match an inherited default are left to that default, so the
 * chat's own selection never picks up copies of inherited plugins.
 */
export async function setChatAuthPreferencesFromEffective(
  getState: () => ChatState,
  target: PluginChatTarget,
  next: ChatTabPluginSelections,
): Promise<boolean> {
  // Capture only the preference intent; selections may resolve while queued.
  const before = chatPluginEditingState(getState(), target).effective;
  const empty = normalizePluginSelections(undefined);
  const removed = {
    ...empty,
    mcpHttpAuthPreferences: subtractPluginSelections(before, next)
      .mcpHttpAuthPreferences,
  };
  const added = {
    ...empty,
    mcpHttpAuthPreferences: subtractPluginSelections(next, before)
      .mcpHttpAuthPreferences,
  };
  return queueDesktopTryItSelectionUpdate(target, async () => {
    const {
      tab,
      global,
      projectDefaults,
      projectTombstones,
      organizationLayers,
      effective,
    } = chatPluginEditingState(getState(), target);
    if (
      tab.readOnly ||
      tab.pendingInitialCreation ||
      tab.status === 'streaming'
    )
      throw new Error(CHAT_PLUGINS_BUSY_MESSAGE);
    const inherited = inheritedPluginSelections({
      projectDefaults,
      global,
      projectTombstones,
      ...organizationLayers,
    });
    const chosen = unionPluginSelections(
      subtractPluginSelections(effective, removed),
      added,
    );
    const { mcpHttpAuthPreferences } = inherited
      ? subtractPluginSelections(chosen, inherited)
      : chosen;
    const local = { ...normalizePluginSelections(tab.pluginSelections) };
    if (mcpHttpAuthPreferences)
      local.mcpHttpAuthPreferences = mcpHttpAuthPreferences;
    else delete local.mcpHttpAuthPreferences;
    const previous = JSON.stringify(tab.pluginSelections);
    const response = await window.api.chat.updatePlugins({
      ...target,
      pluginSelections: local,
      deferredToolsAllowed: tab.deferredToolsAllowed,
      materializeCodexThread: shouldMaterializeCodexThread({
        providerType: tab.providerType,
        executionHarness: tab.executionHarness,
        sdkSessionId: tab.sdkSessionId,
      }),
      expectedCurrentThreadId: tab.sdkSessionId,
    });
    const current = JSON.stringify(
      chatPluginEditingState(getState(), target).tab.pluginSelections,
    );
    // Main publishes the canonical settings before replying. Its own accepted
    // selections are not a competing edit; a different later selection still is.
    if (
      current !== previous &&
      current !== JSON.stringify(response.pluginSelections)
    )
      return false;
    return (
      getState().setPluginSelections(
        response.pluginSelections,
        target,
        response.deferredToolsAllowed,
        {
          runtimeAlreadyUpdated: true,
          ...(response.sdkSessionId
            ? { sdkSessionId: response.sdkSessionId }
            : {}),
        },
      ) !== undefined
    );
  });
}

/**
 * Persists a just-created chat's own selections and the inherited defaults it
 * turns off, resolving only after main has them so the chat's first turn
 * already sees them.
 */
export async function applyNewChatPluginSelections(
  getState: () => ChatState,
  target: PluginChatTarget,
  plugins: {
    pluginSelections: ChatTabPluginSelections;
    disabledGlobalPluginSelections?: PluginSelectionTombstones;
  },
): Promise<void> {
  const tombstones = plugins.disabledGlobalPluginSelections ?? {};
  const response = await window.api.chat.updatePlugins({
    ...target,
    pluginSelections: plugins.pluginSelections,
    disabledGlobalPluginSelections: tombstones,
  });
  getState().setPluginSelections(
    response.pluginSelections,
    target,
    response.deferredToolsAllowed,
    {
      runtimeAlreadyUpdated: true,
      disabledGlobalPluginSelections:
        response.disabledGlobalPluginSelections ?? tombstones,
      ...(response.sdkSessionId ? { sdkSessionId: response.sdkSessionId } : {}),
    },
  );
}
