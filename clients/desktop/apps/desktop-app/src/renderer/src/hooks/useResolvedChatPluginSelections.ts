import { useMemo } from 'react';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import {
  chatInheritsProjectDefaults,
  chatSurfaceUsesGlobalPluginDefaults,
  effectiveChatPluginSelections,
  normalizePluginSelectionTombstones,
  organizationLayersFor,
} from '@canopy/desktop-shared/lib/effective-plugin-selections';
import { useOrganizationLayer } from '@/stores/organizationLayerStore';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import { parseSelectionsJson } from '@/lib/pluginSelections';
import {
  useChatStore,
  useChatTabRenderState,
  useWorktreeChatRenderState,
  type ChatRenderTarget,
} from '@/stores/chatStore';
import { useGlobalPluginDefaultsStore } from '@/stores/globalPluginDefaultsStore';
import { useProjectsStore } from '@/stores/projectsStore';
import {
  connectorScopeForOwner,
  connectorScopeWorkspaceId,
} from '@/stores/chat/tab-utils';

function parseJsonKey(key: string | null): unknown {
  if (key === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(key);
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Read-only resolution of the plugin selections that apply to one worktree
 * chat. Chats that inherit default plugins (worktree and cowork chats) resolve
 * their effective set: the chat's own selections plus the project defaults
 * (scoped override, else the project's; none for a chat written before they
 * were live, see `chatInheritsProjectDefaults`) and the hydrated global
 * defaults the project did not turn off, minus the defaults the chat turned
 * off. Purpose-built surfaces keep the chat
 * resolution order: chat tab override, then worktree default, then project
 * default. Selections are compared via JSON keys so consumers (typically
 * `useDetectedMcpServers`) only refetch on structural changes; Zustand's
 * Object.is would otherwise miss equal-but-new selection objects.
 *
 * `chatId === null` resolves the worktree's active tab; passing `null`
 * project/worktree ids yields `null` (callers with an optional selection can
 * keep hook order stable).
 */
export function useResolvedChatPluginSelections(
  projectId: string | null,
  worktreeId: string | null,
  chatId: string | null,
): ChatTabPluginSelections | null {
  const worktreeKey = `${projectId ?? ''}/${worktreeId ?? ''}`;
  const inherits =
    projectId !== null && chatSurfaceUsesGlobalPluginDefaults(projectId);
  // The chat whose selections apply: `chatId`, else the worktree's active
  // tab. Its selectors run only when that chat's tab changes.
  const activeTabId = useWorktreeChatRenderState(
    worktreeKey,
    (chatState) => chatState?.activeTabId,
  );
  const resolvedTabId = chatId ?? activeTabId;
  const tabTarget: ChatRenderTarget | null =
    resolvedTabId === undefined
      ? null
      : {
          projectId: projectId ?? '',
          worktreeId: worktreeId ?? '',
          chatId: resolvedTabId,
        };
  const tabSelectionsKey = useChatTabRenderState(
    tabTarget,
    ({ tab }): string | null =>
      tab?.pluginSelections ? JSON.stringify(tab.pluginSelections) : null,
  );
  const tabInheritsProjectDefaults = useChatTabRenderState(
    tabTarget,
    ({ tab }): boolean => chatInheritsProjectDefaults(tab),
  );
  const tabTombstonesKey = useChatTabRenderState(
    tabTarget,
    ({ tab }): string | null => {
      if (!inherits) return null;
      const tombstones = tab?.disabledGlobalPluginSelections;
      return tombstones ? JSON.stringify(tombstones) : null;
    },
  );
  const worktreeDefaultSelectionsKey = useChatStore((state): string | null => {
    const selections = state.worktreeDefaultPlugins[worktreeKey];
    return selections ? JSON.stringify(selections) : null;
  });
  const projectDefaultSelectionsKey = useProjectsStore(
    (state): string | null => {
      const item = state.projects.find((p) => p.id === projectId);
      return item?.defaultPluginSelections
        ? JSON.stringify(item.defaultPluginSelections)
        : null;
    },
  );
  const projectTombstonesKey = useProjectsStore((state): string | null => {
    if (!inherits) return null;
    const tombstones = state.projects.find(
      (p) => p.id === projectId,
    )?.disabledGlobalPluginSelections;
    return tombstones ? JSON.stringify(tombstones) : null;
  });
  // In an organization's workspace a person's global connectors stay out
  // (CAN-6230); the owner binding keeps its identity until that row changes.
  const scopeWorkspaceId =
    inherits && projectId !== null && worktreeId !== null
      ? connectorScopeWorkspaceId(projectId, worktreeId)
      : undefined;
  const connectorScopeOwner = useProjectsStore((state) =>
    scopeWorkspaceId === undefined
      ? undefined
      : state.projects.find((p) => p.id === scopeWorkspaceId)?.owner,
  );
  // The organization's shared set, as the turn resolves it (CAN-6237).
  const organizationLayer = useOrganizationLayer(
    inherits ? projectId : null,
    worktreeId,
  );
  const globalSelectionsKey = useGlobalPluginDefaultsStore(
    (state): string | null =>
      inherits && state.hydrated ? JSON.stringify(state.selections) : null,
  );
  return useMemo((): ChatTabPluginSelections | null => {
    if (projectId === null || worktreeId === null) {
      return null;
    }
    if (inherits) {
      const projectDefaultsKey = tabInheritsProjectDefaults
        ? (worktreeDefaultSelectionsKey ?? projectDefaultSelectionsKey)
        : null;
      const projectDefaults = projectDefaultsKey
        ? parseSelectionsJson(projectDefaultsKey)
        : null;
      const global = globalSelectionsKey
        ? parseSelectionsJson(globalSelectionsKey)
        : null;
      return effectiveChatPluginSelections({
        local: tabSelectionsKey
          ? (parseSelectionsJson(tabSelectionsKey) ?? undefined)
          : undefined,
        projectDefaults: projectDefaults
          ? normalizePluginSelections(projectDefaults)
          : undefined,
        global: global ?? undefined,
        projectTombstones: normalizePluginSelectionTombstones(
          parseJsonKey(projectTombstonesKey),
        ),
        chatTombstones: normalizePluginSelectionTombstones(
          parseJsonKey(tabTombstonesKey),
        ),
        connectorScope: connectorScopeForOwner(connectorScopeOwner),
        ...organizationLayersFor(organizationLayer, tabInheritsProjectDefaults),
      });
    }
    if (tabSelectionsKey) {
      return parseSelectionsJson(tabSelectionsKey);
    }
    if (worktreeDefaultSelectionsKey) {
      return parseSelectionsJson(worktreeDefaultSelectionsKey);
    }
    if (projectDefaultSelectionsKey) {
      return parseSelectionsJson(projectDefaultSelectionsKey);
    }
    return null;
  }, [
    projectId,
    worktreeId,
    inherits,
    tabSelectionsKey,
    tabInheritsProjectDefaults,
    tabTombstonesKey,
    worktreeDefaultSelectionsKey,
    projectDefaultSelectionsKey,
    projectTombstonesKey,
    globalSelectionsKey,
    connectorScopeOwner,
    organizationLayer,
  ]);
}
