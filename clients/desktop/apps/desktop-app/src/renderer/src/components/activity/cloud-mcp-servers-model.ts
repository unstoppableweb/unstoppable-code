import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import {
  createCloudChatCatalog,
  type CloudChatCatalog,
} from '@canopy/app-state/core-cowork';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { mcpPanelCardSubtitle } from '@canopy/ui-shared/lib';
import type { CollapsedIconColor } from '@/components/shared/panel-section';
import { webCoreLocalId } from '@/lib/chat-authority';
import { createRelayCoreCoworkInvoker } from '@/cloud-chats/relay-invoker';
import {
  cloudChatMcpServerItems,
  type CloudMcpServerItem,
} from '@/cloud-chats/cloud-mcp-servers';
import { webCoreChatId } from '@/stores/chat/web-core';
import {
  onSelectionSaveSettled,
  selectionSaveSettled,
} from '@/stores/chat/web-core/selection-saves';
import { taskCreationSettled } from '@/stores/chat/web-core/task-creations';
import { isCloudChatDeleted } from '@/stores/chat/web-core/task-deletions';
import { useWorktreeChatRenderState } from '@/stores/chatStore';

export interface CloudMcpServersModel {
  /** Whether the scope is a cloud task, so this model is the one shown. */
  readonly active: boolean;
  readonly servers: readonly CloudMcpServerItem[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
}

/**
 * A cloud task's MCP servers for the Activity rail (CAN-6608): the active
 * chat's servers from its web core catalog over the relay, never this
 * computer's MCP detection. Inactive, and reading nothing, for a local scope.
 */
export function useCloudMcpServersModel({
  projectId,
  worktreeId,
}: {
  readonly projectId: string;
  readonly worktreeId: string;
}): CloudMcpServersModel {
  const tabId =
    useWorktreeChatRenderState(
      `${projectId}/${worktreeId}`,
      (state) => state?.activeTabId,
    ) ?? null;
  const workspaceId = webCoreLocalId(projectId);
  const taskId = webCoreLocalId(worktreeId);
  const chatId = tabId === null ? null : webCoreChatId(tabId);
  const active = workspaceId !== null && taskId !== null;
  const catalog = useMemo((): CloudChatCatalog | null => {
    if (workspaceId === null || taskId === null || chatId === null) return null;
    if (typeof window === 'undefined' || !window.canopyCore) return null;
    return createCloudChatCatalog(
      createRelayCoreCoworkInvoker(window.canopyCore),
      { workspaceId, worktreeId: taskId, chatId },
    );
  }, [workspaceId, taskId, chatId]);
  // No catalog, no store: a local scope subscribes to nothing.
  const subscribe = useCallback(
    (listener: () => void): (() => void) =>
      catalog === null ? () => undefined : catalog.store.subscribe(listener),
    [catalog],
  );
  const state = useSyncExternalStore(
    subscribe,
    () => catalog?.store.getState() ?? null,
  );
  // The chat's selection is read after a task still being created exists,
  // and after a picker save still in flight lands.
  const refresh = useCallback(async (): Promise<void> => {
    if (catalog === null || tabId === null) return;
    // A task deleted on another device is never read again (CAN-6614).
    if (isCloudChatDeleted({ projectId, worktreeId }, tabId)) return;
    await taskCreationSettled({ projectId, worktreeId });
    await selectionSaveSettled(tabId);
    await catalog.refresh();
  }, [catalog, projectId, tabId, worktreeId]);
  useEffect(() => {
    const read = (): void => {
      void refresh().catch((caught: unknown) => reportClientAppError(caught));
    };
    read();
    // Connecting and signing in happen on the web, so read again when the
    // window comes back.
    window.addEventListener('focus', read);
    // The picker saves through its own catalog, so read again after each
    // save of this chat's selection settles.
    const unsubscribe =
      tabId === null ? undefined : onSelectionSaveSettled(tabId, read);
    return (): void => {
      window.removeEventListener('focus', read);
      unsubscribe?.();
    };
  }, [refresh, tabId]);
  const servers = useMemo(
    () =>
      state === null
        ? []
        : cloudChatMcpServerItems(
            state.plugins,
            state.selections,
            state.unavailableMcpServers,
          ),
    [state],
  );
  return {
    active,
    servers,
    // Until the first read lands there is nothing to show yet, not nothing.
    loading: active && (state === null || state.status === 'loading'),
    error:
      state?.status === 'error'
        ? 'This chat’s MCP servers couldn’t be read.'
        : null,
    refresh,
  };
}

export function useCloudMcpServersHeaderChrome(model: CloudMcpServersModel): {
  subtitle: string;
  collapsedIconColor: CollapsedIconColor;
} {
  return {
    subtitle: mcpPanelCardSubtitle({
      loading: model.loading && model.servers.length === 0,
      serverCount: model.servers.length,
    }),
    collapsedIconColor: model.servers.length > 0 ? 'blue' : 'muted',
  };
}
