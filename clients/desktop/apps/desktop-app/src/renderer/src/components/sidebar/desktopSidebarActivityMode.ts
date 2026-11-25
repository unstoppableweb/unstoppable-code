import { useMemo } from 'react';
import type { Descendant } from 'slate';
import type { CanopyClient } from '@canopy/app-core';
import {
  sidebarActivityStandaloneChatKey,
  sidebarActivityWorktreeChatKey,
  useSidebarActivityModeStore,
  type SidebarActivityEntry,
} from '@canopy/app-state';
import {
  snapshotWorkspaceMatchesContext,
  type SidebarActivityHost,
  type SidebarActivityHostInventory,
} from '@canopy/ui-app';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import type { WorktreeChatBadgeChatRef } from '@canopy/desktop-shared/types';
import { draftHasContent } from '@/lib/chat-draft-content';
import { reportRendererConsoleError } from '@/lib/renderer-error-logging';
import { useChatStore } from '@/stores/chatStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useProjectsStore } from '@/stores/projectsStore';
import {
  getSidebarProjectEntries,
  useStandaloneChatStore,
} from '@/stores/standaloneChatStore';
import { openAutomationRunDestination } from '@/components/automations/resolveAutomationRunDestination';
import {
  getSidebarScopingContext,
  useSidebarScopingContext,
} from './useSidebarScopingContext';

/**
 * Desktop host for the shared sidebar Activity mode (CAN-390). The chat store
 * keys tabs by `<project>/<worktree>` for Code worktrees and by
 * `<project>/<work entry>` for Cowork, with tab ids equal to chat ids; these
 * helpers translate that into Activity's scope-qualified keys.
 */

interface ActivityChatTab {
  readonly id: string;
  readonly kind?: string;
  readonly unread?: boolean;
  readonly pendingAttachments?: readonly unknown[];
}

interface ActivityChatScopes {
  readonly worktreeChats: Readonly<
    Record<
      string,
      {
        readonly tabs: readonly ActivityChatTab[];
        readonly activeTabId: string;
      }
    >
  >;
}

export interface DesktopActivityDraftState extends ActivityChatScopes {
  readonly tabDrafts: Readonly<Record<string, Descendant[]>>;
  readonly composerTextPresent: Readonly<Record<string, boolean>>;
}

export interface DesktopActivityUnreadState extends ActivityChatScopes {
  readonly persistedWorktreeBadges: Readonly<
    Record<
      string,
      { readonly unreadChats: readonly WorktreeChatBadgeChatRef[] }
    >
  >;
}

/** One Cowork project's work entries with their unread chat refs. */
export interface DesktopActivityCoworkEntries {
  readonly projectId: string;
  readonly entries: readonly {
    readonly id: string;
    readonly unreadChats?: readonly WorktreeChatBadgeChatRef[];
  }[];
}

function splitScopeKey(
  scopeKey: string,
): { projectId: string; scopeId: string } | null {
  const separator = scopeKey.indexOf('/');
  if (separator < 1 || separator === scopeKey.length - 1) return null;
  return {
    projectId: scopeKey.slice(0, separator),
    scopeId: scopeKey.slice(separator + 1),
  };
}

/** Activity key of a chat-store tab, or `null` for an unparseable scope. */
export function desktopChatScopeActivityKey(
  scopeKey: string,
  chatId: string,
  coworkProjectIds: ReadonlySet<string>,
): string | null {
  const scope = splitScopeKey(scopeKey);
  if (scope === null || chatId === '') return null;
  return coworkProjectIds.has(scope.projectId)
    ? sidebarActivityStandaloneChatKey(scope.projectId, chatId)
    : sidebarActivityWorktreeChatKey(scope.projectId, scope.scopeId, chatId);
}

function tabHasDraft(
  tab: ActivityChatTab,
  state: DesktopActivityDraftState,
): boolean {
  if (state.composerTextPresent[tab.id] === true) return true;
  if ((tab.pendingAttachments?.length ?? 0) > 0) return true;
  const draft = state.tabDrafts[tab.id];
  return draft !== undefined && draftHasContent(draft);
}

/**
 * Keys of inventory chats holding unsent work: typed text or file references
 * (saved or still in the open composer) or pending attachments. A draft whose
 * chat cannot be matched to exactly one inventory row is dropped.
 */
export function collectDesktopDraftKeys(
  state: DesktopActivityDraftState,
  coworkProjectIds: ReadonlySet<string>,
  inventoryKeysByChatId: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  const keys = new Set<string>();
  const matchedTabIds = new Set<string>();
  for (const [scopeKey, scope] of Object.entries(state.worktreeChats)) {
    for (const tab of scope.tabs) {
      if (tab.kind !== undefined && tab.kind !== 'chat') continue;
      // Saved composer state is keyed only by tab id. When ids collide, only
      // attachments on this scoped tab prove that this particular chat has a draft.
      const candidates = inventoryKeysByChatId.get(tab.id);
      if (
        candidates && candidates.length > 1
          ? (tab.pendingAttachments?.length ?? 0) === 0
          : !tabHasDraft(tab, state)
      )
        continue;
      const key = desktopChatScopeActivityKey(
        scopeKey,
        tab.id,
        coworkProjectIds,
      );
      if (key === null) continue;
      matchedTabIds.add(tab.id);
      if (inventoryKeysByChatId.get(tab.id)?.includes(key) === true)
        keys.add(key);
    }
  }
  // A saved draft whose scope is no longer hydrated still names its chat;
  // it counts only when that chat id is unambiguous in the inventory.
  for (const [tabId, draft] of Object.entries(state.tabDrafts)) {
    if (matchedTabIds.has(tabId) || !draftHasContent(draft)) continue;
    const candidates = inventoryKeysByChatId.get(tabId);
    if (candidates?.length === 1) keys.add(candidates[0]);
  }
  return keys;
}

/**
 * Live unread keys, newline-joined and sorted so a selector can return a
 * stable primitive. Hydrated scopes are authoritative even when empty;
 * persisted badges cover unhydrated worktrees, and Cowork entry metadata
 * covers unhydrated work entries.
 */
export function desktopUnreadSignature(
  state: DesktopActivityUnreadState,
  cowork: readonly DesktopActivityCoworkEntries[],
  coworkProjectIds: ReadonlySet<string>,
): string {
  const keys: string[] = [];
  for (const [scopeKey, scope] of Object.entries(state.worktreeChats)) {
    for (const tab of scope.tabs) {
      if (tab.unread !== true) continue;
      const key = desktopChatScopeActivityKey(
        scopeKey,
        tab.id,
        coworkProjectIds,
      );
      if (key !== null) keys.push(key);
    }
  }
  for (const [scopeKey, badges] of Object.entries(
    state.persistedWorktreeBadges,
  )) {
    if (state.worktreeChats[scopeKey] !== undefined) continue;
    for (const chat of badges.unreadChats) {
      const key = desktopChatScopeActivityKey(
        scopeKey,
        chat.chatId,
        coworkProjectIds,
      );
      if (key !== null) keys.push(key);
    }
  }
  for (const { projectId, entries } of cowork) {
    for (const entry of entries) {
      if (state.worktreeChats[`${projectId}/${entry.id}`] !== undefined)
        continue;
      for (const chat of entry.unreadChats ?? [])
        keys.push(sidebarActivityStandaloneChatKey(projectId, chat.chatId));
    }
  }
  return keys.sort().join('\n');
}

/** The chat on screen, or `null` when no chat page shows one. */
export function desktopActiveChatKey(
  state: ActivityChatScopes & {
    readonly selectedWorktree: {
      readonly projectId: string;
      readonly worktreeId: string;
    } | null;
  },
  activePage: string,
  coworkProjectIds: ReadonlySet<string>,
): string | null {
  const selected = state.selectedWorktree;
  if (selected === null) return null;
  const cowork = coworkProjectIds.has(selected.projectId);
  if (activePage !== (cowork ? 'chat' : 'main')) return null;
  const scopeKey = `${selected.projectId}/${selected.worktreeId}`;
  const scope = state.worktreeChats[scopeKey];
  if (!scope?.tabs.some((tab) => tab.id === scope.activeTabId)) return null;
  return desktopChatScopeActivityKey(
    scopeKey,
    scope.activeTabId,
    coworkProjectIds,
  );
}

function workspaceContextKey(context: WorkspaceContext | undefined): string {
  return JSON.stringify(
    context === undefined
      ? ['desktop']
      : context.kind === 'organization'
        ? ['desktop', 'organization', context.organizationId]
        : ['desktop', 'personal'],
  );
}

function coworkProjectIdsOf(
  projects: readonly { readonly id: string; readonly type: string }[],
): Set<string> {
  return new Set(
    projects
      .filter((project) => project.type === 'cowork')
      .map((project) => project.id),
  );
}

function coworkEntriesOf(
  coworkProjectIds: ReadonlySet<string>,
): DesktopActivityCoworkEntries[] {
  const standalone = useStandaloneChatStore.getState();
  return Array.from(coworkProjectIds, (projectId) => ({
    projectId,
    entries: getSidebarProjectEntries(standalone, projectId),
  }));
}

export async function loadDesktopSidebarActivityInventory(
  client: CanopyClient,
): Promise<SidebarActivityHostInventory> {
  const snapshot = await client.query('session.snapshot', {
    includeChatSummaries: true,
  });
  // Read the context, drafts, and unread state as of completion, not as of
  // the click, so they agree with the inventory they classify.
  const context = getSidebarScopingContext();
  const inventory = {
    workspaces: snapshot.workspaces.filter((workspace) =>
      snapshotWorkspaceMatchesContext(workspace, context),
    ),
    worktrees: snapshot.worktrees,
    standaloneChats: snapshot.standaloneChats,
    chatSummaries: snapshot.chatSummaries,
  };
  // Cold Cowork projects may never have mounted their normal sidebar rows.
  // Hydrate the existing canonical metadata store before freezing membership;
  // otherwise an empty, unhydrated registry would incorrectly clear its dots.
  for (const workspace of inventory.workspaces) {
    if (workspace.type !== 'cowork') continue;
    const standalone = useStandaloneChatStore.getState();
    if (standalone.activeChatProjectId === workspace.localId)
      await standalone.refreshWorkEntries(workspace.localId);
    else await standalone.loadSidebarProjectEntries(workspace.localId);
  }
  const keysByChatId = new Map<string, string[]>();
  const addKey = (chatId: string, key: string): void => {
    const keys = keysByChatId.get(chatId);
    if (keys === undefined) keysByChatId.set(chatId, [key]);
    else keys.push(key);
  };
  for (const summary of inventory.chatSummaries) {
    if (
      summary.scope === 'worktree' &&
      summary.workspaceLocalId !== undefined &&
      summary.worktreeLocalId !== undefined
    )
      addKey(
        summary.chatId,
        sidebarActivityWorktreeChatKey(
          summary.workspaceLocalId,
          summary.worktreeLocalId,
          summary.chatId,
        ),
      );
  }
  for (const chat of inventory.standaloneChats)
    addKey(
      chat.localId,
      sidebarActivityStandaloneChatKey(chat.projectLocalId, chat.localId),
    );
  const coworkProjectIds = new Set(
    inventory.workspaces
      .filter((workspace) => workspace.type === 'cowork')
      .map((workspace) => workspace.localId),
  );
  const chat = useChatStore.getState();
  const unread = desktopUnreadSignature(
    chat,
    coworkEntriesOf(coworkProjectIds),
    coworkProjectIds,
  );
  const unreadKeys = new Set(unread === '' ? [] : unread.split('\n'));
  // Startup hydration may not have reached a worktree that has no persisted
  // badges yet. The live store knows nothing about that scope, so the
  // snapshot's own unread flag decides its membership.
  for (const summary of inventory.chatSummaries) {
    if (
      summary.scope !== 'worktree' ||
      summary.hasUnread !== true ||
      summary.workspaceLocalId === undefined ||
      summary.worktreeLocalId === undefined
    )
      continue;
    const scopeKey = `${summary.workspaceLocalId}/${summary.worktreeLocalId}`;
    if (
      chat.worktreeChats[scopeKey] !== undefined ||
      chat.persistedWorktreeBadges[scopeKey] !== undefined
    )
      continue;
    unreadKeys.add(
      sidebarActivityWorktreeChatKey(
        summary.workspaceLocalId,
        summary.worktreeLocalId,
        summary.chatId,
      ),
    );
  }
  return {
    inventory,
    unreadKeys,
    draftKeys: collectDesktopDraftKeys(chat, coworkProjectIds, keysByChatId),
  };
}

function openDesktopActivityChat(entry: SidebarActivityEntry): void {
  void openAutomationRunDestination(
    entry.kind === 'worktree-chat'
      ? {
          kind: 'worktree-chat',
          projectId: entry.workspaceLocalId,
          worktreeId: entry.worktreeLocalId,
          chatId: entry.chatId,
        }
      : {
          kind: 'cowork-chat',
          workspaceId: entry.projectLocalId,
          chatId: entry.chatId,
        },
  )
    .then((result) => {
      if (!result.ok) useGitHubStore.getState().addToast(result.error, 'error');
    })
    .catch((error: unknown) => {
      reportRendererConsoleError('Opening an Activity chat failed', { error });
      useGitHubStore
        .getState()
        .addToast("Couldn't open the chat. Try again.", 'error', undefined, {
          caught: error,
        });
    });
}

const EMPTY_KEYS: ReadonlySet<string> = new Set();

/**
 * The desktop Activity host. Live unread and active-chat subscriptions only
 * do work while Activity is on, so the chat store's streaming updates cost
 * nothing in the normal tree.
 */
export function useDesktopSidebarActivityHost(
  client: CanopyClient,
): SidebarActivityHost {
  const context = useSidebarScopingContext();
  const sessionKey = workspaceContextKey(context);
  const enabled = useSidebarActivityModeStore((state) => state.enabled);
  const projects = useProjectsStore((state) => state.projects);
  const coworkProjectIds = useMemo(
    () => coworkProjectIdsOf(projects),
    [projects],
  );
  const workEntries = useStandaloneChatStore((state) => state.workEntries);
  const sidebarEntriesByProject = useStandaloneChatStore(
    (state) => state.sidebarEntriesByProject,
  );
  const activeChatProjectId = useStandaloneChatStore(
    (state) => state.activeChatProjectId,
  );
  const cowork = useMemo(
    () =>
      Array.from(coworkProjectIds, (projectId) => ({
        projectId,
        entries: getSidebarProjectEntries(
          { workEntries, sidebarEntriesByProject, activeChatProjectId },
          projectId,
        ),
      })),
    [
      activeChatProjectId,
      coworkProjectIds,
      sidebarEntriesByProject,
      workEntries,
    ],
  );
  const unreadSignature = useChatStore((state) =>
    enabled ? desktopUnreadSignature(state, cowork, coworkProjectIds) : '',
  );
  // Only the two pages that show a chat matter here; a move between other
  // pages must not re-render the sidebar.
  const activePage = useNavigationStore((state) =>
    state.activePage === 'chat' || state.activePage === 'main'
      ? state.activePage
      : 'other',
  );
  const activeChatKey = useChatStore((state) =>
    enabled ? desktopActiveChatKey(state, activePage, coworkProjectIds) : null,
  );
  const unreadKeys = useMemo(
    (): ReadonlySet<string> =>
      unreadSignature === ''
        ? EMPTY_KEYS
        : new Set(unreadSignature.split('\n')),
    [sessionKey, unreadSignature],
  );
  return useMemo(
    (): SidebarActivityHost => ({
      sessionKey,
      loadInventory: () => loadDesktopSidebarActivityInventory(client),
      unreadKeys,
      activeChatKey,
      onOpenChat: openDesktopActivityChat,
    }),
    [activeChatKey, client, sessionKey, unreadKeys],
  );
}
