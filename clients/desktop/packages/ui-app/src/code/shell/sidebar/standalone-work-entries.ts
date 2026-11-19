import type { RemoteControlStandaloneWorkEntryFields } from '@canopy/protocol';
import {
  orderSidebarRows,
  toRecencyMs,
  workEntryRecencyMs,
  type SidebarSortMode,
  type SidebarWorkEntryOrderRow,
} from './sidebar-ordering';

/**
 * The fields of one flat portal standalone chat that grouping reads. Typed
 * structurally so the shell state's `standaloneChats` rows fit as they are.
 */
export interface GroupableStandaloneChat extends RemoteControlStandaloneWorkEntryFields {
  /** The chat's id on the paired desktop. */
  localId: string;
  /** The owning Cowork project on the paired desktop. */
  projectLocalId: string;
  title: string;
  /** ISO-8601 time of the chat's most recent message. */
  lastMessageAt?: string;
  /** ISO-8601 chat creation time. */
  createdAt?: string;
  archived?: boolean;
  hasActiveChat?: boolean;
  /** The chat's background tasks (D11), from the desktop's canonical state. */
  backgroundTasks?: number;
  hasUnread?: boolean;
}

/** One Chats-section row: a Work Entry and the flat chats that belong to it. */
export interface StandaloneWorkEntryRow<
  T extends GroupableStandaloneChat = GroupableStandaloneChat,
> extends SidebarWorkEntryOrderRow {
  /** Unique across the list: project, identity kind, and id. */
  key: string;
  projectLocalId: string;
  /**
   * The Work Entry id, or the chat's own id for a chat projected without one
   * (an older desktop), which then stands as a one-chat entry.
   */
  workEntryId: string;
  /** False when the row fell back to the chat id. */
  hasWorkEntry: boolean;
  /** The entry's resolved title, else the target chat's title. */
  title: string;
  status: 'active' | 'done';
  pinned: boolean;
  /** Desktop's persisted manual order within the project (0 = top). */
  order?: number;
  /** True when any chat in the entry has a turn in flight. */
  hasActiveChat: boolean;
  /** Background tasks across the entry's chats (turn-state phase 41b). */
  backgroundTasks: number;
  /** True when any chat in the entry has output the user has not viewed. */
  hasUnread: boolean;
  /** Every chat in the entry, in input order. */
  chats: T[];
  /** The chats with unviewed output, in input order. */
  unreadChats: T[];
  /** The chat to open for the row: the one with the newest activity. */
  targetChat: T;
}

export interface GroupStandaloneChatsOptions {
  /** The Chats section's ordering mode. Missing resolves to `'last-updated'`. */
  mode?: SidebarSortMode;
  /**
   * Leave out Work Entries with no message yet, as desktop's Chats section
   * does: an entry lists once it has a message (`workEntryLastMessageAt`),
   * while it is pinned, or while one of its chats is the open one. A chat
   * projected without an entry carries no such signal and always lists.
   */
  hideEmptyWorkEntries?: { openChatId?: string | null };
}

interface MutableGroup<T extends GroupableStandaloneChat> {
  key: string;
  projectLocalId: string;
  workEntryId: string;
  hasWorkEntry: boolean;
  firstIndex: number;
  chats: T[];
}

function chatActivityMs(chat: GroupableStandaloneChat): number | undefined {
  return toRecencyMs(chat.lastMessageAt) ?? toRecencyMs(chat.createdAt);
}

/** The later of two ISO timestamps, keeping whichever one parses. */
function laterTimestamp(
  current: string | undefined,
  candidate: string | undefined,
): string | undefined {
  const candidateMs = toRecencyMs(candidate);
  if (candidateMs === undefined) return current;
  const currentMs = toRecencyMs(current);
  return currentMs === undefined || candidateMs > currentMs
    ? candidate
    : current;
}

/** The earlier of two ISO timestamps, keeping whichever one parses. */
function earlierTimestamp(
  current: string | undefined,
  candidate: string | undefined,
): string | undefined {
  const candidateMs = toRecencyMs(candidate);
  if (candidateMs === undefined) return current;
  const currentMs = toRecencyMs(current);
  return currentMs === undefined || candidateMs < currentMs
    ? candidate
    : current;
}

function firstDefined<T extends GroupableStandaloneChat, V>(
  chats: readonly T[],
  read: (chat: T) => V | undefined,
): V | undefined {
  for (const chat of chats) {
    const value = read(chat);
    if (value !== undefined) return value;
  }
  return undefined;
}

function newestChat<T extends GroupableStandaloneChat>(
  chats: readonly [T, ...T[]],
): T {
  let target = chats[0];
  let targetMs = chatActivityMs(target);
  for (const chat of chats) {
    const ms = chatActivityMs(chat);
    if (ms !== undefined && (targetMs === undefined || ms > targetMs)) {
      target = chat;
      targetMs = ms;
    }
  }
  return target;
}

function buildRow<T extends GroupableStandaloneChat>(
  group: MutableGroup<T>,
  first: T,
): StandaloneWorkEntryRow<T> {
  const chats: readonly [T, ...T[]] = [first, ...group.chats.slice(1)];
  const targetChat = newestChat(chats);
  // Entry-level timestamps are folded across every sibling, not read from
  // the first one: siblings can carry projections of different ages.
  let lastMessageAt: string | undefined;
  let lastTouchedAt: string | undefined;
  let chatCreatedAt: string | undefined;
  for (const chat of chats) {
    lastMessageAt = laterTimestamp(lastMessageAt, chat.workEntryLastMessageAt);
    lastMessageAt = laterTimestamp(lastMessageAt, chat.lastMessageAt);
    lastTouchedAt = laterTimestamp(lastTouchedAt, chat.workEntryLastTouchedAt);
    chatCreatedAt = earlierTimestamp(chatCreatedAt, chat.createdAt);
  }
  return {
    key: group.key,
    projectLocalId: group.projectLocalId,
    workEntryId: group.workEntryId,
    hasWorkEntry: group.hasWorkEntry,
    title:
      firstDefined(chats, (chat) => chat.workEntryTitle) ?? targetChat.title,
    status: chats.some((chat) => chat.workEntryStatus === 'done')
      ? 'done'
      : 'active',
    pinned: chats.some((chat) => chat.workEntryPinned === true),
    order: firstDefined(chats, (chat) => chat.workEntryOrder),
    createdAt:
      firstDefined(chats, (chat) => chat.workEntryCreatedAt) ?? chatCreatedAt,
    lastMessageAt,
    lastTouchedAt,
    hasActiveChat: chats.some((chat) => chat.hasActiveChat === true),
    backgroundTasks: chats.reduce(
      (total, chat) => total + (chat.backgroundTasks ?? 0),
      0,
    ),
    hasUnread: chats.some((chat) => chat.hasUnread === true),
    chats: [...chats],
    unreadChats: chats.filter((chat) => chat.hasUnread === true),
    targetChat,
  };
}

/**
 * Desktop's persisted manual order: `order` ascending, rows without one after
 * every row with one, ties going to the newer entry, then first appearance.
 */
function compareManualOrder<T extends GroupableStandaloneChat>(
  left: { row: StandaloneWorkEntryRow<T>; firstIndex: number },
  right: { row: StandaloneWorkEntryRow<T>; firstIndex: number },
): number {
  const leftOrder = left.row.order;
  const rightOrder = right.row.order;
  if (leftOrder !== undefined && rightOrder !== undefined) {
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  } else if (leftOrder !== undefined) {
    return -1;
  } else if (rightOrder !== undefined) {
    return 1;
  }
  const leftCreated = toRecencyMs(left.row.createdAt);
  const rightCreated = toRecencyMs(right.row.createdAt);
  if (
    leftCreated !== undefined &&
    rightCreated !== undefined &&
    leftCreated !== rightCreated
  ) {
    return rightCreated - leftCreated;
  }
  return left.firstIndex - right.firstIndex;
}

/**
 * Turn the portal's flat standalone chats into Chats-section Work Entry rows
 * (CAN-3053), so the portal lists the same containers the desktop rail does.
 *
 * Chats group by project and Work Entry; a chat projected without an entry
 * stands alone under its own id. Archived chats are left out. Activity and
 * unread state are OR'd across an entry's chats, its recency is the newest
 * timestamp any of them carries, and the row opens the chat with the newest
 * activity. Rows then order the way desktop orders a section: pinned first,
 * then the section's mode through {@link orderSidebarRows}, starting from
 * desktop's persisted manual order.
 */
export function groupStandaloneChatsIntoWorkEntries<
  T extends GroupableStandaloneChat,
>(
  chats: readonly T[],
  options: GroupStandaloneChatsOptions = {},
): StandaloneWorkEntryRow<T>[] {
  const groups = new Map<string, MutableGroup<T>>();
  chats.forEach((chat, index) => {
    if (chat.archived === true) return;
    const entryId = chat.workEntryId;
    const hasWorkEntry = entryId !== undefined && entryId.length > 0;
    const id = hasWorkEntry ? entryId : chat.localId;
    // The identity kind is part of the key: an entry id and a chat id come
    // from different namespaces and must not merge by coincidence.
    const key = `${chat.projectLocalId}:${hasWorkEntry ? 'entry' : 'chat'}:${id}`;
    const existing = groups.get(key);
    if (existing) {
      existing.chats.push(chat);
      return;
    }
    groups.set(key, {
      key,
      projectLocalId: chat.projectLocalId,
      workEntryId: id,
      hasWorkEntry,
      firstIndex: index,
      chats: [chat],
    });
  });

  const manual: { row: StandaloneWorkEntryRow<T>; firstIndex: number }[] = [];
  const hideEmpty = options.hideEmptyWorkEntries;
  for (const group of groups.values()) {
    const first = group.chats[0];
    if (first === undefined) continue;
    if (
      hideEmpty !== undefined &&
      group.hasWorkEntry &&
      !group.chats.some(
        (chat) =>
          chat.workEntryLastMessageAt !== undefined ||
          chat.workEntryPinned === true ||
          chat.localId === hideEmpty.openChatId,
      )
    )
      continue;
    manual.push({ row: buildRow(group, first), firstIndex: group.firstIndex });
  }
  manual.sort(compareManualOrder);

  return orderSidebarRows(
    manual.map((entry) => entry.row),
    {
      mode: options.mode,
      isPinned: (row) => row.pinned,
      recencyMs: workEntryRecencyMs,
    },
  );
}
