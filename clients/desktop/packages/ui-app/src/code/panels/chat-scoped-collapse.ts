import { useEffect } from 'react';
import {
  usePanelLayoutStore,
  type WorktreePanelLayout,
} from './panel-layout-store';
import { isChatScopedPanelKind } from './panel-chat-scope';

/**
 * Each chat tab keeps its own side view open or closed.
 *
 * A side view is a group that shows one chat's content beside it (the Side
 * Panel in Minimal mode, any group of only chat-scoped tabs in Advanced). Its
 * tabs already follow the selected chat (`panel-chat-scope`); this makes its
 * open/closed state follow too. Whatever the user does to the side view in
 * one chat is remembered for that chat only, survives restarts, and comes
 * back when that chat is selected again. A chat with nothing remembered
 * keeps the view as it is.
 */

const STORAGE_KEY = 'canopy.panels.chatSideViewCollapsed.v1';
/** Bounds the remembered chats so storage cannot grow without end. */
const MAX_REMEMBERED = 400;

/** `${layoutKey}\u0000${groupId}\u0000${chatTabId}` → collapsed. */
type Memory = Map<string, boolean>;

let memory: Memory | null = null;

function readMemory(): Memory {
  if (memory !== null) return memory;
  memory = new Map();
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (
            Array.isArray(entry) &&
            typeof entry[0] === 'string' &&
            typeof entry[1] === 'boolean'
          ) {
            memory.set(entry[0], entry[1]);
          }
        }
      }
    }
  } catch {
    // Unreadable memory starts empty.
  }
  return memory;
}

function writeMemory(next: Memory): void {
  while (next.size > MAX_REMEMBERED) {
    const oldest = next.keys().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  try {
    globalThis.localStorage?.setItem(
      STORAGE_KEY,
      JSON.stringify([...next.entries()]),
    );
  } catch {
    // Storage full or unavailable: the memory still holds for this session.
  }
}

function memoryKey(
  layoutKey: string,
  groupId: string,
  chatTabId: string,
): string {
  return `${layoutKey}\u0000${groupId}\u0000${chatTabId}`;
}

function remember(key: string, collapsed: boolean): void {
  const current = readMemory();
  if (current.get(key) === collapsed) return;
  // Re-insert so the most recent entries survive the bound.
  current.delete(key);
  current.set(key, collapsed);
  writeMemory(current);
}

/** Groups that only show the selected chat's own content. */
function sideViewGroupIds(layout: WorktreePanelLayout): string[] {
  const ids: string[] = [];
  for (const [groupId, group] of Object.entries(layout.groups)) {
    if (group.tabs.some((tab) => tab.kind === 'chat')) continue;
    if (
      groupId === 'group-extras' ||
      (group.tabs.length > 0 &&
        group.tabs.every((tab) => isChatScopedPanelKind(tab.kind)))
    ) {
      ids.push(groupId);
    }
  }
  return ids;
}

/** Keeps the side views of `layoutKey` open or closed per chat tab. */
export function useChatScopedSideViewCollapse(layoutKey: string): void {
  useEffect(() => {
    // Null at first, so the first sync restores the current chat's own state
    // (after a restart, or when this layout mounts) instead of overwriting it.
    let previousChat: string | null = null;
    let applying = false;
    /**
     * Restores the layout refused (a maximized group blocks collapse and
     * expand): groupId → the state the chat wants and the state the group had
     * when it was refused. Retried until it lands; dropped if the user changes
     * the group first, since what they did then wins.
     */
    let pending = new Map<
      string,
      { readonly wanted: boolean; readonly refusedAt: boolean }
    >();
    const apply = (groupId: string, wanted: boolean): boolean => {
      const store = usePanelLayoutStore.getState();
      return wanted
        ? store.collapseGroup(layoutKey, groupId)
        : store.expandGroup(layoutKey, groupId, { focus: false });
    };
    const sync = (): void => {
      if (applying) return;
      const layout = usePanelLayoutStore.getState().layouts[layoutKey];
      const chat = layout?.chatScope?.activeChatTabId ?? null;
      if (layout === undefined || chat === null) {
        previousChat = chat;
        pending = new Map();
        return;
      }
      const groupIds = sideViewGroupIds(layout);
      const collapsedOf = (groupId: string): boolean | undefined => {
        const group =
          usePanelLayoutStore.getState().layouts[layoutKey]?.groups[groupId];
        return group === undefined ? undefined : group.collapsed !== undefined;
      };
      applying = true;
      try {
        if (chat !== previousChat) {
          // A different chat: bring back what it had.
          previousChat = chat;
          pending = new Map();
          for (const groupId of groupIds) {
            const wanted = readMemory().get(
              memoryKey(layoutKey, groupId, chat),
            );
            const collapsed = collapsedOf(groupId);
            if (wanted === undefined || collapsed === undefined) continue;
            if (wanted === collapsed) continue;
            if (!apply(groupId, wanted)) {
              pending.set(groupId, { wanted, refusedAt: collapsed });
            }
          }
        } else {
          // The same chat: retry what was refused, unless the user moved on.
          for (const [groupId, entry] of [...pending]) {
            const collapsed = collapsedOf(groupId);
            if (
              collapsed === undefined ||
              collapsed === entry.wanted ||
              collapsed !== entry.refusedAt
            ) {
              pending.delete(groupId);
              continue;
            }
            if (apply(groupId, entry.wanted)) pending.delete(groupId);
          }
        }
      } finally {
        applying = false;
      }
      // Remember what this chat's side views are now; a group still waiting
      // to be restored keeps what the chat wants.
      for (const groupId of groupIds) {
        if (pending.has(groupId)) continue;
        const collapsed = collapsedOf(groupId);
        if (collapsed === undefined) continue;
        remember(memoryKey(layoutKey, groupId, chat), collapsed);
      }
    };
    sync();
    return usePanelLayoutStore.subscribe(sync);
  }, [layoutKey]);
}
