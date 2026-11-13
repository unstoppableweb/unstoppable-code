import {
  APP_ADVISOR_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import {
  findPanelByInstanceKey,
  usePanelLayoutStore,
} from '@/stores/panelLayoutStore';
import { useChatStore } from '@/stores/chatStore';
import { waitForChatScopeLive } from '@/stores/chat/slices/revisioned';
import { chatScopeKey } from '@/stores/chat/revisioned-sync';
import { useBrowserStore } from '@/stores/browserStore';
import { getWorkspaceLayoutMode } from '@/stores/workspaceLayoutModeStore';
import { isCanopyDesktopStartPageEnabled } from '@/hooks/useCanopyDesktopStartPageEnabled';
import { openFileInBrowserPanel } from '@/lib/openFileInBrowserPanel';
import { requestBrowserPanel } from '@/lib/browserPanelActivation';
import { normalizeInAppBrowserInput } from '@/lib/browserUrl';
import {
  isHtmlStartPagePath,
  resolveStartPageAbsolutePath,
} from '@/lib/start-page/project-start-page';
import { isPanelHydrationGenerationCurrent } from './hydration-generation';
import { consumeStartPageSuppressed } from './start-page-suppression';
import { isWebCoreScope } from '@/lib/chat-authority';
export {
  consumeStartPageSuppressed,
  markStartPageSuppressed,
} from './start-page-suppression';

function splitWorktreeKey(worktreeKey: string): {
  projectId: string;
  worktreeId: string;
} {
  const separator = worktreeKey.indexOf('/');
  return {
    projectId: worktreeKey.slice(0, separator),
    worktreeId: worktreeKey.slice(separator + 1),
  };
}

function activePanelId(worktreeKey: string): string | null {
  const layout = usePanelLayoutStore.getState().layouts[worktreeKey];
  if (!layout || layout.activeGroupId === null) return null;
  return layout.groups[layout.activeGroupId]?.activePanelId ?? null;
}

function chatHasUserActivity(worktreeKey: string): boolean {
  const chat = useChatStore.getState().worktreeChats[worktreeKey];
  return (
    chat?.tabs.some(
      (tab) =>
        tab.kind !== 'file' &&
        (tab.messages.length > 0 ||
          tab.queuedMessages.length > 0 ||
          tab.status !== 'idle'),
    ) ?? false
  );
}

async function waitForPendingCreation(worktreeKey: string): Promise<boolean> {
  const pending = (): boolean =>
    useChatStore
      .getState()
      .worktreeChats[
        worktreeKey
      ]?.tabs.some((tab) => tab.pendingInitialCreation === true) ?? false;
  if (!pending()) return true;
  return new Promise<boolean>((resolve) => {
    let unsubscribe = (): void => undefined;
    const finish = (ready: boolean): void => {
      window.clearTimeout(timeout);
      unsubscribe();
      resolve(ready);
    };
    const timeout = window.setTimeout(() => finish(false), 15_000);
    unsubscribe = useChatStore.subscribe(() => {
      if (!pending()) finish(true);
    });
  });
}

async function waitUntilChatScopeLive(
  projectId: string,
  worktreeId: string,
): Promise<boolean> {
  if (await waitForChatScopeLive(projectId, worktreeId)) return true;
  const key = chatScopeKey(projectId, worktreeId);
  if (useChatStore.getState().chatStateSync[key]?.phase === 'live') return true;
  return new Promise<boolean>((resolve) => {
    let unsubscribe = (): void => undefined;
    const finish = (live: boolean): void => {
      window.clearTimeout(timeout);
      unsubscribe();
      resolve(live);
    };
    const timeout = window.setTimeout(() => finish(false), 15_000);
    unsubscribe = useChatStore.subscribe((state) => {
      if (state.chatStateSync[key]?.phase === 'live') finish(true);
    });
    if (useChatStore.getState().chatStateSync[key]?.phase === 'live') {
      finish(true);
    }
  });
}

/**
 * A file tab's panel is materialized by the chat-panel sync on a later
 * microtask, so it does not exist yet when `openFileTab` returns.
 */
async function waitForPanel(
  worktreeKey: string,
  instanceKey: string,
): Promise<boolean> {
  if (findPanelByInstanceKey(worktreeKey, instanceKey)) return true;
  return new Promise<boolean>((resolve) => {
    let unsubscribe = (): void => undefined;
    const finish = (found: boolean): void => {
      window.clearTimeout(timeout);
      unsubscribe();
      resolve(found);
    };
    const timeout = window.setTimeout(() => finish(false), 15_000);
    unsubscribe = usePanelLayoutStore.subscribe(() => {
      if (findPanelByInstanceKey(worktreeKey, instanceKey)) finish(true);
    });
  });
}

function placeFirst(
  worktreeKey: string,
  instanceKey: string,
  chatTabId: string | null,
): void {
  const opened = findPanelByInstanceKey(worktreeKey, instanceKey);
  if (!opened) return;
  const panels = usePanelLayoutStore.getState();
  if (getWorkspaceLayoutMode(worktreeKey) === 'advanced' && chatTabId) {
    const chat = findPanelByInstanceKey(worktreeKey, `chat:${chatTabId}`);
    if (
      chat &&
      opened.layoutKey === worktreeKey &&
      chat.layoutKey === worktreeKey
    ) {
      if (opened.groupId !== chat.groupId) {
        panels.movePanel(
          worktreeKey,
          opened.panelId,
          chat.groupId,
          'center',
          0,
        );
      }
      panels.reorderTab(worktreeKey, chat.groupId, opened.panelId, 0);
      panels.selectTab(worktreeKey, chat.groupId, opened.panelId, {
        focus: true,
      });
      return;
    }
  }
  panels.selectTab(opened.layoutKey, opened.groupId, opened.panelId, {
    focus: true,
  });
}

/**
 * Whether the user is still where the freshly opened file tab left them.
 * Opening the tab either made its panel the active one, or, when it opened
 * in another group, left the active panel alone. Anything else means the
 * user has moved on, and the start page must not pull them back.
 */
function fileStartPageStillWanted(
  worktreeKey: string,
  instanceKey: string,
  panelBefore: string | null,
): boolean {
  const opened = findPanelByInstanceKey(worktreeKey, instanceKey);
  if (!opened) return false;
  const active = activePanelId(worktreeKey);
  if (active === opened.panelId) return true;
  const layout = usePanelLayoutStore.getState().layouts[worktreeKey];
  return active === panelBefore && layout?.activeGroupId !== opened.groupId;
}

/** Opens a configured start page only for a layout created in this hydration. */
export async function maybeOpenStartPage(
  worktreeKey: string,
  generation: number,
  createdLayout: boolean,
  withAutomaticLayoutChanges: <T>(operation: () => Promise<T>) => Promise<T>,
): Promise<void> {
  const { projectId, worktreeId } = splitWorktreeKey(worktreeKey);
  if (
    !createdLayout ||
    !isCanopyDesktopStartPageEnabled() ||
    projectId === APP_ADVISOR_PROJECT_ID ||
    projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID ||
    isWebCoreScope(projectId) ||
    consumeStartPageSuppressed(worktreeKey)
  ) {
    return;
  }

  if (!(await waitUntilChatScopeLive(projectId, worktreeId))) return;
  if (!(await waitForPendingCreation(worktreeKey))) return;
  if (
    !isPanelHydrationGenerationCurrent(worktreeKey, generation) ||
    chatHasUserActivity(worktreeKey)
  ) {
    return;
  }

  const panelBefore = activePanelId(worktreeKey);
  const canActivateStartPage = (): boolean =>
    isPanelHydrationGenerationCurrent(worktreeKey, generation) &&
    activePanelId(worktreeKey) === panelBefore &&
    !chatHasUserActivity(worktreeKey);
  const chatTabId =
    useChatStore.getState().worktreeChats[worktreeKey]?.activeTabId ?? null;
  const resolved = await window.api
    .resolveProjectStartPage({ projectId, worktreeId })
    .catch(() => null);
  if (!resolved || !canActivateStartPage()) {
    return;
  }

  if (resolved.startPage.kind === 'url') {
    const url = normalizeInAppBrowserInput(
      resolved.startPage.url,
      useBrowserStore.getState().localServersOnly,
    );
    if (!url) return;
    await withAutomaticLayoutChanges(async () => {
      const opened = useBrowserStore
        .getState()
        .openUrlFromDevServer(projectId, worktreeId, { url });
      if (opened === null) return;
      if (!canActivateStartPage()) {
        if (opened.createdNewSession) {
          await useBrowserStore
            .getState()
            .destroyBrowser(projectId, worktreeId, opened.browserId)
            .catch(() => undefined);
        }
        return;
      }
      if (
        !(await requestBrowserPanel(
          projectId,
          worktreeId,
          opened.browserId,
          undefined,
          { focus: false },
        ))
      ) {
        if (opened.createdNewSession) {
          await useBrowserStore
            .getState()
            .destroyBrowser(projectId, worktreeId, opened.browserId)
            .catch(() => undefined);
        }
        return;
      }
      if (!canActivateStartPage()) {
        if (opened.createdNewSession) {
          await useBrowserStore
            .getState()
            .destroyBrowser(projectId, worktreeId, opened.browserId)
            .catch(() => undefined);
        }
        return;
      }
      placeFirst(worktreeKey, `browser:${opened.browserId}`, chatTabId);
    });
    return;
  }

  const roots = await window.api
    .getFileTreeRoots({ projectId, worktreeId })
    .then((response) => response.roots)
    .catch(() => []);
  const absolutePath = resolveStartPageAbsolutePath(resolved.startPage, roots);
  if (!absolutePath) return;
  const exists = await window.api
    .readFileContent({ absolutePath })
    .then((response) => response.kind !== 'missing')
    .catch(() => false);
  if (!exists || !canActivateStartPage()) {
    return;
  }

  if (isHtmlStartPagePath(absolutePath)) {
    await withAutomaticLayoutChanges(async () => {
      const browserId = await openFileInBrowserPanel(
        projectId,
        worktreeId,
        absolutePath,
        { focus: false },
      );
      if (!browserId) return;
      if (!canActivateStartPage()) {
        await useBrowserStore
          .getState()
          .destroyBrowser(projectId, worktreeId, browserId)
          .catch(() => undefined);
        return;
      }
      placeFirst(worktreeKey, `browser:${browserId}`, chatTabId);
    });
    return;
  }

  await withAutomaticLayoutChanges(async () => {
    const filename =
      absolutePath.replace(/\\/g, '/').split('/').pop() ?? absolutePath;
    const tabId = useChatStore
      .getState()
      .openFileTab({ absolutePath, filename }, { projectId, worktreeId });
    if (!tabId) return;
    const instanceKey = `file-diff:${tabId}`;
    // `canActivateStartPage` no longer applies: opening the tab is what changed
    // the active panel. The tab stays where it is if the hydration was
    // superseded, a conversation started, or the user moved on meanwhile.
    if (
      !(await waitForPanel(worktreeKey, instanceKey)) ||
      !isPanelHydrationGenerationCurrent(worktreeKey, generation) ||
      chatHasUserActivity(worktreeKey) ||
      !fileStartPageStillWanted(worktreeKey, instanceKey, panelBefore)
    ) {
      return;
    }
    placeFirst(worktreeKey, instanceKey, chatTabId);
  });
}
