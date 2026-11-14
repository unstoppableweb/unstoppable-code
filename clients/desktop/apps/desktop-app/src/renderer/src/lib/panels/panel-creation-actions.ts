import type { TerminalShellProfileId } from '@canopy/desktop-shared/types';
import { requireTerminalClient } from '@canopy/app-state/terminal';
import { isWebCoreScope } from '@/lib/chat-authority';
import { cloudTerminalsEnabled } from '@/lib/web-core-scope-capabilities';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useBrowserStore } from '@/stores/browserStore';
import { useGitHubStore } from '@/stores/githubStore';
import {
  getAuxPanelLayoutOwnerKey,
  usePanelLayoutStore,
} from '@/stores/panelLayoutStore';
import {
  ensureTerminalWorktreeHydrated,
  useTerminalStore,
} from '@/stores/terminalStore';
import { useTerminalActivityStore } from '@/stores/terminalActivityStore';
import { registerPendingBrowserActivation } from './browser-panel-activation';
import { browserPanelIdFor } from './browser-panel-identity';
import { discardOpenedBrowser } from './browser-panel-sync';
import { terminalPanelIdFor } from './terminal-panel-identity';
import {
  clearTerminalFocusRequest,
  requestTerminalFocus,
} from '@/lib/terminal-focus-intent';
import { extractIpcErrorMessage } from '@/lib/errors';

const splitKey = (key: string): { projectId: string; worktreeId: string } => {
  const separator = key.indexOf('/');
  return {
    projectId: key.slice(0, separator),
    worktreeId: key.slice(separator + 1),
  };
};

/**
 * Adds a Browser panel bound to a new session. The panel is placed
 * immediately; the backend session is created in the background while the
 * pane shows its opening spinner (or an inline Retry if creation fails).
 */
export async function createBrowserPanel(
  worktreeKey: string,
  requestedGroupId: string,
): Promise<boolean> {
  const ownerKey = getAuxPanelLayoutOwnerKey(worktreeKey) ?? worktreeKey;
  const { projectId, worktreeId } = splitKey(ownerKey);
  const opened = useBrowserStore.getState().openBrowser(projectId, worktreeId);
  // Unavailable in a window that shows another computer; the add menus do
  // not offer it there.
  if (opened === null) {
    return false;
  }
  const { browserId } = opened;
  const release = registerPendingBrowserActivation(browserId);
  let added: string | null = null;
  try {
    const store = usePanelLayoutStore.getState();
    added =
      store.addTab(worktreeKey, requestedGroupId, 'browser', {
        panelId: browserPanelIdFor(browserId),
        instance: { browserId },
      }) ??
      store.addTab(worktreeKey, requestedGroupId, 'browser', {
        instance: { browserId },
      });
  } finally {
    release();
  }
  if (added === null) {
    await discardOpenedBrowser(projectId, worktreeId, browserId);
    useGitHubStore
      .getState()
      .addToast('Unable to open Browser', 'error', undefined, {
        projectId,
        worktreeId,
      });
    return false;
  }
  void useBrowserStore
    .getState()
    .setActiveBrowser(projectId, worktreeId, browserId);
  return true;
}

export async function createTerminalPanel(
  worktreeKey: string,
  requestedGroupId: string,
  terminalProfileId: TerminalShellProfileId = 'default',
  title = 'Terminal',
  initialCommand?: string,
  ownerDocument: Document = document,
): Promise<boolean> {
  const ownerKey = getAuxPanelLayoutOwnerKey(worktreeKey) ?? worktreeKey;
  const { projectId, worktreeId } = splitKey(ownerKey);
  // A cloud task's shell runs in its sandbox through the bound scoped client;
  // main's local terminal host never gets a cloud id (CAN-6542, CAN-6395).
  const cloud = isWebCoreScope(worktreeId);
  let terminalId: string | null = null;
  let client: ReturnType<typeof requireTerminalClient> | null = null;
  try {
    if (
      cloud &&
      !cloudTerminalsEnabled(useFeatureFlagsStore.getState().isEnabled)
    )
      throw new Error('Terminals are not available for this cloud task.');
    client = requireTerminalClient();
    if (!cloud)
      await ensureTerminalWorktreeHydrated(projectId, worktreeId).catch(
        () => undefined,
      );
    const session = await client.command('terminal.spawn', {
      projectId,
      worktreeId,
      terminalProfileId,
      // A cloud terminal runs no startup command.
      ...(initialCommand && !cloud ? { initialCommand } : {}),
      cols: 80,
      rows: 24,
    });
    terminalId = session.id;
    useTerminalStore.getState().addGroupWithTerminal(session);
    // Creating a terminal is an explicit user gesture, so the new pane may
    // claim the caret once it mounts (CAN-2309).
    requestTerminalFocus(terminalId, ownerDocument);
    const store = usePanelLayoutStore.getState();
    const added =
      store.addTab(worktreeKey, requestedGroupId, 'terminal', {
        panelId: terminalPanelIdFor(terminalId),
        title,
        instance: { terminalId },
      }) ??
      store.addTab(worktreeKey, requestedGroupId, 'terminal', {
        title,
        instance: { terminalId },
      });
    if (added === null) throw new Error('Terminal bind failed');
    return true;
  } catch (error: unknown) {
    // A shell that cannot start stays failed: the toast carries the main
    // process reason and nothing opens with a different shell.
    let message = 'Unable to open Terminal';
    if (terminalId !== null) {
      clearTerminalFocusRequest(terminalId);
      useTerminalActivityStore.getState().markUserInitiatedClose(terminalId);
      await client
        ?.command('terminal.kill', { terminalId })
        .catch(() => undefined);
      useTerminalStore
        .getState()
        .removeTerminal(projectId, worktreeId, terminalId);
    } else if (error instanceof Error && error.message) {
      message = `${message}. ${extractIpcErrorMessage(error)}`;
    }
    useGitHubStore.getState().addToast(message, 'error', undefined, {
      projectId,
      worktreeId,
      blockMessageFromReplay: message !== 'Unable to open Terminal',
    });
    return false;
  }
}
