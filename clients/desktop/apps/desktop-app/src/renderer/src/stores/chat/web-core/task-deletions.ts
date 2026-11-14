import { useSyncExternalStore } from 'react';
import { isWebCoreScope } from '@/lib/chat-authority';
import type { ChatTab } from '../types';

/**
 * Cloud tasks deleted on another device while this window held them, by the
 * store's scope key (CAN-6614). The web core told this window the task is
 * gone: it removed the task's own chat, ended its event stream not found, or
 * answered a snapshot or a new chat not found. From then on nothing about
 * the task is sent to the web core, and the store keeps the task's own chat
 * as it was, so its draft and attachments stay until the person starts a
 * new chat with them or discards them. A local scope is never marked.
 */

type Scope = { readonly projectId: string; readonly worktreeId: string };

const deleted = new Set<string>();
/**
 * Chats deleted on another device while their task stays, by scope key and
 * store chat id: kept read-only for their unsent work, while the task's
 * other chats go on as usual.
 */
const deletedChats = new Map<
  string,
  { readonly scope: Scope; readonly chatId: string }
>();
/**
 * The tabs of chats deleted on their own that this window keeps through
 * going offline, by chat key: the web core lists them no more, so the
 * scope's next snapshot gets them from here.
 */
const keptChatTabs = new Map<string, ChatTab>();
const chatKeyOf = (scope: Scope, chatId: string): string =>
  `${scope.projectId}/${scope.worktreeId}/${chatId}`;
const listeners = new Set<() => void>();
let version = 0;

const keyOf = (scope: Scope): string =>
  `${scope.projectId}/${scope.worktreeId}`;

function changed(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

/** Marks a cloud task deleted; false when it already was, or is local. */
export function markCloudTaskDeleted(scope: Scope): boolean {
  if (!isWebCoreScope(scope.projectId) || !isWebCoreScope(scope.worktreeId))
    return false;
  const key = keyOf(scope);
  if (deleted.has(key)) return false;
  deleted.add(key);
  changed();
  return true;
}

/** Whether the web core said this cloud task is gone. */
export function isCloudTaskDeleted(scope: Scope): boolean {
  return deleted.has(keyOf(scope));
}

/**
 * Marks one chat of a live cloud task deleted, keeping the task live;
 * false when it already was, or is local.
 */
export function markCloudChatDeleted(scope: Scope, chatId: string): boolean {
  if (!isWebCoreScope(scope.projectId) || !isWebCoreScope(scope.worktreeId))
    return false;
  const key = chatKeyOf(scope, chatId);
  if (deletedChats.has(key)) return false;
  deletedChats.set(key, { scope, chatId });
  changed();
  return true;
}

/** Whether this cloud chat is gone: its task, or the chat on its own. */
export function isCloudChatDeleted(scope: Scope, chatId: string): boolean {
  return (
    isCloudTaskDeleted(scope) || deletedChats.has(chatKeyOf(scope, chatId))
  );
}

/** The person left a chat deleted on its own: started a new chat or discarded it. */
export function forgetCloudChatDeletion(scope: Scope, chatId: string): void {
  keptChatTabs.delete(chatKeyOf(scope, chatId));
  if (deletedChats.delete(chatKeyOf(scope, chatId))) changed();
}

/** Every chat deleted on its own, while its task stays. */
export function listDeletedCloudChats(): {
  readonly scope: Scope;
  readonly chatId: string;
}[] {
  return [...deletedChats.values()];
}

/** Keeps a chat deleted on its own for its scope's next snapshot. */
export function keepDeletedChatTab(scope: Scope, tab: ChatTab): void {
  keptChatTabs.set(chatKeyOf(scope, tab.id), tab);
}

/** A kept tab of a chat deleted on its own, if this window keeps one. */
export function keptDeletedChatTab(
  scope: Scope,
  chatId: string,
): ChatTab | undefined {
  return keptChatTabs.get(chatKeyOf(scope, chatId));
}

/** The kept tabs of a scope's chats deleted on their own. */
export function keptDeletedChatTabs(scope: Scope): ChatTab[] {
  return [...deletedChats.entries()].flatMap(([key, chat]) => {
    const tab = keptChatTabs.get(key);
    return tab !== undefined &&
      chat.scope.projectId === scope.projectId &&
      chat.scope.worktreeId === scope.worktreeId
      ? [tab]
      : [];
  });
}

/** The person left the deleted task: started a new chat or discarded it. */
export function forgetCloudTaskDeletion(scope: Scope): void {
  let forgot = deleted.delete(keyOf(scope));
  for (const key of [...deletedChats.keys()])
    if (key.startsWith(`${keyOf(scope)}/`)) {
      keptChatTabs.delete(key);
      forgot = deletedChats.delete(key);
    }
  if (forgot) changed();
}

/** Forgets every deleted task and chat: the connection that reported them is gone. */
export function clearCloudTaskDeletions(): void {
  if (deleted.size === 0 && deletedChats.size === 0) return;
  deleted.clear();
  deletedChats.clear();
  keptChatTabs.clear();
  changed();
}

/** For `useSyncExternalStore`: changes whenever a task is marked or forgotten. */
export function subscribeCloudTaskDeletions(listener: () => void): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

export function cloudTaskDeletionsVersion(): number {
  return version;
}

/** Whether the web core said this cloud task is gone; false for no scope. */
export function useCloudTaskDeleted(
  projectId: string | undefined,
  worktreeId: string | undefined,
): boolean {
  useSyncExternalStore(subscribeCloudTaskDeletions, cloudTaskDeletionsVersion);
  return (
    projectId !== undefined &&
    worktreeId !== undefined &&
    isCloudTaskDeleted({ projectId, worktreeId })
  );
}

/** Whether this cloud chat is gone, its task or on its own; false for none. */
export function useCloudChatDeleted(
  projectId: string | undefined,
  worktreeId: string | undefined,
  chatId: string | undefined,
): boolean {
  useSyncExternalStore(subscribeCloudTaskDeletions, cloudTaskDeletionsVersion);
  return (
    projectId !== undefined &&
    worktreeId !== undefined &&
    chatId !== undefined &&
    isCloudChatDeleted({ projectId, worktreeId }, chatId)
  );
}
