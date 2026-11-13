import type {
  LocalMemoryChatRef,
  LocalMemoryClient,
  LocalMemoryNotice,
  LocalMemoryScope,
  LocalMemorySyncClient,
} from '@canopy/app-core/local-memory';
import type { MemoryPanelScope } from '@canopy/ui-app/local-memory';
import type {
  ChatSearchCatalogEntry,
  LocalMemoryScopeRequest,
} from '@canopy/desktop-shared/types';
import { DESKTOP_LEDGER_NAVIGATOR } from '@/lib/ledger/ledger-navigator';
import { useGitHubStore } from '@/stores/githubStore';
import { useNavigationStore } from '@/stores/navigationStore';

const CHAT_UNAVAILABLE = 'That chat is no longer available.';

function request(scope: LocalMemoryScope): LocalMemoryScopeRequest {
  return scope.scope === 'user'
    ? { scope: 'user' }
    : { scope: 'workspace', workspaceId: scope.workspaceId };
}

function sameScope(
  left: LocalMemoryScopeRequest,
  right: LocalMemoryScopeRequest,
): boolean {
  return (
    left.scope === right.scope &&
    (left.scope === 'user' ||
      (right.scope === 'workspace' && left.workspaceId === right.workspaceId))
  );
}

const CHAT_SOURCES = new Set(['live', 'worktree-archive', 'cowork-archive']);

/** The catalog takes at most this many chat ids per request. */
const CATALOG_CHAT_IDS_PER_REQUEST = 500;

/**
 * The catalog rows of the given chats, however old they are; a live row wins
 * over an archived copy. Linked personal checkouts stay visible while an
 * organization is selected, as in the command palette.
 */
async function catalogChats(
  chatIds: readonly string[],
  linkedPersonalWorkspaceIds: readonly string[],
): Promise<Map<string, ChatSearchCatalogEntry>> {
  const batches: string[][] = [];
  for (
    let start = 0;
    start < chatIds.length;
    start += CATALOG_CHAT_IDS_PER_REQUEST
  )
    batches.push(chatIds.slice(start, start + CATALOG_CHAT_IDS_PER_REQUEST));
  const responses = await Promise.all(
    batches.map((ids) =>
      window.api.chatSearch.catalog({
        chatIds: ids,
        ...(linkedPersonalWorkspaceIds.length > 0
          ? { linkedPersonalWorkspaceIds: [...linkedPersonalWorkspaceIds] }
          : {}),
      }),
    ),
  );
  const chats = new Map<string, ChatSearchCatalogEntry>();
  for (const entry of responses.flatMap((response) => response.entries)) {
    if (!CHAT_SOURCES.has(entry.source)) continue;
    const known = chats.get(entry.chatId);
    if (!known || (known.source !== 'live' && entry.source === 'live'))
      chats.set(entry.chatId, entry);
  }
  return chats;
}

/** Memory sync's port over the desktop memory sync IPC. */
export const desktopMemorySyncClient: LocalMemorySyncClient = {
  state: () => window.api.getMemorySyncState(),
  watch: (onChange) => window.api.onMemorySyncChanged(onChange),
  updateSettings: (patch) => window.api.updateMemorySyncSettings(patch),
  previewMerge: (workspaceId) =>
    window.api.previewMemorySyncMerge(
      workspaceId === undefined ? {} : { workspaceId },
    ),
  applyMerge: (previewId, workspaceId) =>
    window.api.applyMemorySyncMerge(
      workspaceId === undefined ? { previewId } : { previewId, workspaceId },
    ),
  setProjectMemory: (workspaceId, keepOnThisComputer) =>
    window.api.setMemorySyncProjectMemory({ workspaceId, keepOnThisComputer }),
  readConflict: (path) => window.api.readMemorySyncConflict({ path }),
  settleConflict: (path, action) =>
    window.api.resolveMemorySyncConflict({ path, action }),
  history: (before) => window.api.listMemorySyncHistory({ before }),
  restore: (revision) => window.api.restoreMemorySyncRevision({ revision }),
  deleteFromCloud: () =>
    window.api.deleteMemorySyncFromCloud({ confirmed: true }),
};

/**
 * The Memory panel's port over the desktop local memory IPC. Hosts pass the
 * selected context's linked personal checkouts so source chats there resolve.
 */
export function createIpcLocalMemoryClient(
  linkedPersonalWorkspaceIds: readonly string[] = [],
): LocalMemoryClient {
  return {
    list: (scope) => window.api.listLocalMemoryFiles(request(scope)),
    read: (scope, fileKey) =>
      window.api.readLocalMemoryFile({ ...request(scope), fileKey }),
    updateFile: (scope, update) =>
      window.api.updateLocalMemoryFile({ ...request(scope), ...update }),
    deleteFile: (scope, target) =>
      window.api.deleteLocalMemoryFile({ ...request(scope), ...target }),
    status: (scope) =>
      window.api.getLocalMemoryConsolidationStatus(request(scope)),
    consolidate: (scope) => window.api.consolidateLocalMemory(request(scope)),
    rebuild: (scope) => window.api.rebuildLocalMemory(request(scope)),
    watch: (scope, onChange) => {
      const watched = request(scope);
      // Main keeps a filesystem watcher on the scope while the panel is
      // mounted, so notes written by agents or by hand arrive as changes.
      void window.api.watchLocalMemory(watched).catch(() => undefined);
      const unsubscribe = window.api.onLocalMemoryChanged((changed) => {
        if (sameScope(changed, watched)) onChange();
      });
      return (): void => {
        unsubscribe();
        void window.api.unwatchLocalMemory(watched).catch(() => undefined);
      };
    },
    lookupChats: async (
      chatIds,
    ): Promise<ReadonlyMap<string, LocalMemoryChatRef>> => {
      const chats = await catalogChats(chatIds, linkedPersonalWorkspaceIds);
      const found = new Map<string, LocalMemoryChatRef>();
      for (const chatId of chatIds) {
        const entry = chats.get(chatId);
        if (entry && entry.title) found.set(chatId, { title: entry.title });
      }
      return found;
    },
    watchChats: (onChange) => window.api.chatSearch.onUpdated(onChange),
    openChat: async (
      chatId,
    ): Promise<{ ok: true } | { ok: false; message: string }> => {
      const entry = (
        await catalogChats([chatId], linkedPersonalWorkspaceIds)
      ).get(chatId);
      if (!entry) return { ok: false, message: CHAT_UNAVAILABLE };
      const scope = {
        projectId: entry.projectId,
        worktreeId: entry.worktreeId,
      };
      const result = await DESKTOP_LEDGER_NAVIGATOR.openSource(scope, {
        kind: 'chat',
        projectId: entry.projectId,
        worktreeId: entry.worktreeId,
        chatId,
        archived: entry.source !== 'live',
      });
      return result.ok ? { ok: true } : { ok: false, message: result.message };
    },
    openSettings: () => useNavigationStore.getState().openSettings('memory'),
    openLink: (url): void => {
      void window.api.browser.openLink({ url });
    },
    sync: desktopMemorySyncClient,
  };
}

export const desktopLocalMemoryClient = createIpcLocalMemoryClient();

/** Memories saved for every project, which every Memory panel lists. */
export const USER_MEMORY_SCOPE: MemoryPanelScope = {
  scope: { scope: 'user' },
  label: 'Everywhere',
  savedFor: 'Every project',
};

/**
 * Shows a Memory panel notice as a toast. A notice answers a click in the
 * panel, so it shows even with in-app notifications off and never raises an
 * OS banner, as share toasts do. Notices can quote a memory's title, which
 * may be the memory's own text, so session replay never records them.
 */
export function notifyLocalMemory(notice: LocalMemoryNotice): void {
  useGitHubStore
    .getState()
    .addToast(
      notice.message,
      notice.tone === 'error' ? 'error' : 'success',
      undefined,
      {
        forceInApp: true,
        suppressOsNotification: true,
        blockMessageFromReplay: true,
        ...(notice.action
          ? {
              action: {
                label: notice.action.label,
                onClick: notice.action.run,
              },
            }
          : {}),
      },
    );
}
