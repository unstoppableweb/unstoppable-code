/**
 * Chat-scoped content tabs: each chat tab of a layout keeps its own browser,
 * file, plan and run tabs, so switching chats also switches what those
 * groups show (the Side Panel in Minimal mode, any content group in
 * Advanced).
 *
 * Rules (pure; the layout store applies them on every commit):
 *
 * - A content tab of a {@link CHAT_SCOPED_PANEL_KINDS} kind records the chat
 *   tab it opened for in `chatScope`. Navigation and worktree-wide panels
 *   (Activity, File explorer, terminals, usage, …) never do and always show.
 * - The selected chat is the active chat tab of the most recently focused
 *   group showing one. Focusing a non-chat tab keeps the previous chat.
 * - A scoped tab is hidden while another chat of the same window is
 *   selected. A tab whose chat is absent from this window shows for every
 *   chat, so closing or popping out a chat never strands its tabs. A group
 *   that holds chat tabs hides nothing: tabs beside the chats themselves are
 *   their peers, not a side view.
 * - Each group remembers its active tab per chat and restores it when that
 *   chat is selected again. A group whose active tab becomes hidden falls
 *   back to that memory, then the chat's own last tab, then the first shown
 *   tab.
 */
import type { PanelKind } from '@canopy/protocol';

/** Content kinds that belong to the chat they were opened for. */
export const CHAT_SCOPED_PANEL_KINDS: ReadonlySet<PanelKind> =
  new Set<PanelKind>([
    'browser',
    'file-diff',
    'pipeline-execution',
    'plan',
    'plan-diagram',
    'chat-visuals',
    'subagent-chat',
    'session-breakdown',
    'new-tab',
  ]);

export function isChatScopedPanelKind(kind: PanelKind): boolean {
  return CHAT_SCOPED_PANEL_KINDS.has(kind);
}

interface ChatScopeTab {
  readonly panelId: string;
  readonly kind: PanelKind;
  readonly instance?: Readonly<Record<string, string>>;
  readonly chatScope?: string;
}

interface ChatScopeGroup {
  readonly tabs: readonly ChatScopeTab[];
  readonly activePanelId: string | null;
}

/** The selected chat of a layout and the chats selectable in that window. */
export interface PanelChatScope {
  readonly activeChatTabId: string;
  readonly presentChatTabIds: ReadonlySet<string>;
}

/** groupId → chatTabId → the group's last active panel for that chat. */
export type PanelChatScopeMemory = Readonly<
  Record<string, Readonly<Record<string, string>>>
>;

function chatTabIdOf(tab: ChatScopeTab | undefined): string | undefined {
  if (tab?.kind !== 'chat') return undefined;
  const chatTabId = tab.instance?.chatTabId;
  return chatTabId !== undefined && chatTabId.length > 0
    ? chatTabId
    : undefined;
}

/** Every chat tab id held by the given groups. */
export function collectChatTabIds(
  groupSets: Iterable<Readonly<Record<string, ChatScopeGroup>>>,
): Set<string> {
  const ids = new Set<string>();
  for (const groups of groupSets) {
    for (const group of Object.values(groups)) {
      for (const tab of group.tabs) {
        const chatTabId = chatTabIdOf(tab);
        if (chatTabId !== undefined) ids.add(chatTabId);
      }
    }
  }
  return ids;
}

/**
 * The selected chat: the active chat tab of the most recently focused group
 * that shows one, else `previous` while its chat is still present.
 */
export function resolveChatScope(
  groups: Readonly<Record<string, ChatScopeGroup>>,
  mruGroupIds: readonly string[],
  presentChatTabIds: ReadonlySet<string>,
  previousActiveChatTabId: string | null,
): PanelChatScope | null {
  const order = [
    ...mruGroupIds,
    ...Object.keys(groups).filter((groupId) => !mruGroupIds.includes(groupId)),
  ];
  for (const groupId of order) {
    const group = groups[groupId];
    if (group === undefined) continue;
    const chatTabId = chatTabIdOf(
      group.tabs.find((tab) => tab.panelId === group.activePanelId),
    );
    if (chatTabId !== undefined) {
      return { activeChatTabId: chatTabId, presentChatTabIds };
    }
  }
  if (
    previousActiveChatTabId !== null &&
    presentChatTabIds.has(previousActiveChatTabId)
  ) {
    return { activeChatTabId: previousActiveChatTabId, presentChatTabIds };
  }
  return null;
}

/** Whether `tab` belongs to a chat other than the selected one. */
export function isTabScopedOut(
  tab: ChatScopeTab,
  scope: PanelChatScope | null,
): boolean {
  return (
    scope !== null &&
    tab.chatScope !== undefined &&
    tab.chatScope !== scope.activeChatTabId &&
    isChatScopedPanelKind(tab.kind) &&
    scope.presentChatTabIds.has(tab.chatScope)
  );
}

/** Which of `group`'s tabs are hidden for the selected chat. */
export function groupHiddenTabPredicate(
  group: ChatScopeGroup,
  scope: PanelChatScope | null,
): (tab: ChatScopeTab) => boolean {
  if (scope === null || group.tabs.some((tab) => tab.kind === 'chat')) {
    return () => false;
  }
  return (tab) => isTabScopedOut(tab, scope);
}

/**
 * Converts an insertion index counted over the SHOWN tabs to one over every
 * tab, so a drop between two shown tabs never lands among hidden ones in a
 * way that reorders the shown strip differently.
 */
export function shownIndexToTabIndex(
  tabs: readonly ChatScopeTab[],
  shownIndex: number,
  isHidden: (tab: ChatScopeTab) => boolean,
): number {
  if (!tabs.some(isHidden)) return shownIndex;
  let shown = 0;
  for (let index = 0; index < tabs.length; index += 1) {
    if (isHidden(tabs[index])) continue;
    if (shown === shownIndex) return index;
    shown += 1;
  }
  return tabs.length;
}

function pickFallbackPanelId(
  shownTabs: readonly ChatScopeTab[],
  activeChatTabId: string,
  remembered: string | undefined,
): string | null {
  if (
    remembered !== undefined &&
    shownTabs.some((tab) => tab.panelId === remembered)
  ) {
    return remembered;
  }
  const ownTabs = shownTabs.filter((tab) => tab.chatScope === activeChatTabId);
  return ownTabs[ownTabs.length - 1]?.panelId ?? shownTabs[0]?.panelId ?? null;
}

/**
 * Applies the active-tab rules for `scope` to every group. Returns the same
 * `groups` object when nothing changed.
 */
export function applyChatScopeToGroups<G extends ChatScopeGroup>(
  groups: Readonly<Record<string, G>>,
  scope: PanelChatScope | null,
  previousActiveChatTabId: string | null,
  memory: PanelChatScopeMemory,
  liveChatTabIds?: ReadonlySet<string>,
): { groups: Readonly<Record<string, G>>; memory: PanelChatScopeMemory } {
  if (scope === null) return { groups, memory };
  const { activeChatTabId } = scope;
  const switched = previousActiveChatTabId !== activeChatTabId;
  let nextGroups: Record<string, G> | null = null;
  const nextMemory: Record<string, Readonly<Record<string, string>>> = {};
  for (const [groupId, group] of Object.entries(groups)) {
    const isHidden = groupHiddenTabPredicate(group, scope);
    const shownTabs = group.tabs.filter((tab) => !isHidden(tab));
    const groupMemory = memory[groupId] ?? {};
    const remembered = groupMemory[activeChatTabId];
    const activeTab = group.tabs.find(
      (tab) => tab.panelId === group.activePanelId,
    );
    const activeShown = activeTab !== undefined && !isHidden(activeTab);
    let activePanelId = group.activePanelId;
    if (!activeShown) {
      activePanelId = pickFallbackPanelId(
        shownTabs,
        activeChatTabId,
        remembered,
      );
    } else if (
      switched &&
      activeTab.kind !== 'chat' &&
      remembered !== undefined &&
      shownTabs.some((tab) => tab.panelId === remembered)
    ) {
      // Coming back to a chat brings back what this group showed for it.
      activePanelId = remembered;
    }
    if (activePanelId !== group.activePanelId) {
      nextGroups ??= { ...groups };
      nextGroups[groupId] = { ...group, activePanelId };
    }
    // Only panels the group still holds are worth remembering.
    const kept: Record<string, string> = {};
    for (const [chatTabId, panelId] of Object.entries(groupMemory)) {
      if (
        (liveChatTabIds ?? scope.presentChatTabIds).has(chatTabId) &&
        group.tabs.some((tab) => tab.panelId === panelId)
      ) {
        kept[chatTabId] = panelId;
      }
    }
    if (activePanelId !== null) kept[activeChatTabId] = activePanelId;
    if (Object.keys(kept).length > 0) nextMemory[groupId] = kept;
  }
  return { groups: nextGroups ?? groups, memory: nextMemory };
}
