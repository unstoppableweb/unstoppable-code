import { useSyncExternalStore } from 'react';
import type { Descendant } from 'slate';
import type { AttachmentMeta } from '@canopy/desktop-shared/types';
import type { ChatTab } from '@/stores/chat/types';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { webCoreLocalId } from '@/lib/chat-authority';
import { serializeEditorValue } from '@canopy/ui-rich/editor';
import { draftHasContent } from '@/lib/chat-draft-content';
import { saveOpenChatDrafts } from '@/lib/chatDrafts';
import { importWebCoreChatFiles } from '@/lib/chatAttachments';
import {
  setWebCoreTaskDeletionHandler,
  setWebCoreUnsentWorkCheck,
} from '@/stores/chat/web-core';
import {
  forgetCloudChatDeletion,
  forgetCloudTaskDeletion,
  isCloudChatDeleted,
  isCloudTaskDeleted,
  keepDeletedChatTab,
  keptDeletedChatTab,
  listDeletedCloudChats,
  markCloudChatDeleted,
  subscribeCloudTaskDeletions,
  markCloudTaskDeleted,
} from '@/stores/chat/web-core/task-deletions';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { useChatStore } from '@/stores/chatStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { openCoworkWorkEntryFromSidebar } from '@/lib/openCoworkWorkEntryFromSidebar';
import { cloudAttachmentSource } from './cloud-chat-attachments';
import { cloudCoworkStore } from './cloud-cowork-store';
import { beginCloudTask } from './useCloudCoworkSidebar';

/*
 * A cloud task deleted on another device while this window held it
 * (CAN-6614). The chat store keeps the task's own chat as it was, so its
 * draft and attachments stay; the composer says what happened and offers
 * Start new chat, which carries them into a new task in the same project,
 * and Discard. While the chat holds unsent work, its sidebar row stays,
 * marked Deleted.
 */

type Scope = { readonly projectId: string; readonly worktreeId: string };

const keyOf = (scope: Scope): string =>
  `${scope.projectId}/${scope.worktreeId}`;

type ChatContents = Pick<
  ReturnType<typeof useChatStore.getState>,
  'tabDrafts' | 'worktreeChats'
>;

/**
 * What one chat of the deleted task still holds: by default its own chat,
 * whose id is the task's.
 */
export function deletedTaskContents(
  state: ChatContents,
  scope: Scope,
  tabId: string = scope.worktreeId,
): {
  readonly draft: Descendant[] | undefined;
  readonly attachments: readonly AttachmentMeta[];
} {
  const draft = state.tabDrafts[tabId];
  return {
    draft: draft !== undefined && draftHasContent(draft) ? draft : undefined,
    attachments:
      state.worktreeChats[keyOf(scope)]?.tabs.find((tab) => tab.id === tabId)
        ?.pendingAttachments ?? [],
  };
}

/**
 * The chat store after every open composer saved its text. Typing writes a
 * draft to storage after a pause without updating the store's draft map, so
 * every decision about what a deleted task still holds reads this, never the
 * map as it was (CAN-6614).
 */
function currentChatContents(): ChatContents {
  saveOpenChatDrafts();
  return useChatStore.getState();
}

/**
 * Whether one chat of the deleted task holds a draft with text, as its
 * composer holds it now.
 */
export function deletedChatHasDraft(scope: Scope, tabId: string): boolean {
  return (
    deletedTaskContents(currentChatContents(), scope, tabId).draft !== undefined
  );
}

/**
 * A chat's unsent work as a comparable value: its draft's text and file
 * references, and its attachments' paths.
 */
function unsentWorkKey(contents: {
  readonly draft: Descendant[] | undefined;
  readonly attachments: readonly AttachmentMeta[];
}): string {
  const draft =
    contents.draft === undefined ? null : serializeEditorValue(contents.draft);
  return JSON.stringify([
    draft?.text ?? '',
    draft?.fileReferences ?? [],
    contents.attachments.map((attachment) => attachment.absolutePath),
  ]);
}

/** The deleted task's chats that still hold a draft or attachments. */
function chatsWithUnsentWork(state: ChatContents, scope: Scope): string[] {
  return (state.worktreeChats[keyOf(scope)]?.tabs ?? [])
    .map((tab) => tab.id)
    .filter((tabId) => {
      const { draft, attachments } = deletedTaskContents(state, scope, tabId);
      return draft !== undefined || attachments.length > 0;
    });
}

/**
 * Deleted tasks whose row this window keeps, by scope key: the row's title
 * and the account they belong to, so going offline and back brings the row
 * back, and another account never sees it.
 */
const keptRows = new Map<
  string,
  { readonly scope: Scope; readonly title: string; readonly account: number }
>();

const currentAccount = (): number =>
  useWorkspaceContextStore.getState().accountEpoch;

/** Keeps the task's row, marked deleted, while its chat holds unsent work. */
function keepDeletedTaskRow(scope: Scope): void {
  const workspaceId = webCoreLocalId(scope.projectId);
  const taskId = webCoreLocalId(scope.worktreeId);
  if (workspaceId === null || taskId === null) return;
  // Every deleted task is recorded: one empty now may be typed into later,
  // so whether it is kept is decided from its live contents each time.
  const chat = currentChatContents();
  const tab = chat.worktreeChats[keyOf(scope)]?.tabs.find(
    (each) => each.id === scope.worktreeId,
  );
  const listed = cloudCoworkStore
    .getState()
    .tasksByProject[
      `web-core:${workspaceId}`
    ]?.find((task) => task.worktreeId === taskId);
  const title = listed?.title ?? tab?.customTitle ?? tab?.title ?? '';
  keptRows.set(keyOf(scope), { scope, title, account: currentAccount() });
  if (chatsWithUnsentWork(chat, scope).length > 0)
    cloudCoworkStore.getState().keepDeletedTask(workspaceId, taskId, title);
}

/**
 * Shows a recorded deleted task's row once one of its chats holds unsent
 * work, as when it is typed into after it was deleted empty.
 */
export function showDeletedTaskRowIfUnsent(scope: Scope): void {
  const row = keptRows.get(keyOf(scope));
  if (row === undefined || !isCloudTaskDeleted(scope)) return;
  const workspaceId = webCoreLocalId(scope.projectId);
  const taskId = webCoreLocalId(scope.worktreeId);
  if (workspaceId === null || taskId === null) return;
  const cowork = cloudCoworkStore.getState();
  const shown = cowork.tasksByProject[`web-core:${workspaceId}`]?.find(
    (task) => task.worktreeId === taskId,
  );
  if (shown?.deleted === true) return;
  if (chatsWithUnsentWork(currentChatContents(), scope).length === 0) return;
  cowork.keepDeletedTask(workspaceId, taskId, row.title);
}

/**
 * The deleted tasks whose chat this window keeps through going offline: same
 * account, still marked, and still in the chat store. The rest are dropped.
 */
export function deletedTasksKeptThroughOffline(): Scope[] {
  const live = currentChatContents();
  const kept: Scope[] = [];
  for (const [key, row] of keptRows) {
    if (
      row.account === currentAccount() &&
      isCloudTaskDeleted(row.scope) &&
      live.worktreeChats[key] !== undefined &&
      chatsWithUnsentWork(live, row.scope).length > 0
    )
      kept.push(row.scope);
    else keptRows.delete(key);
  }
  return kept;
}

/** The account each chat deleted on its own was deleted under, by chat key. */
const chatAccounts = new Map<string, number>();
const chatKeyOf = (scope: Scope, chatId: string): string =>
  `${keyOf(scope)}/${chatId}`;

function recordDeletedChatAccounts(): void {
  for (const { scope, chatId } of listDeletedCloudChats()) {
    const key = chatKeyOf(scope, chatId);
    if (!chatAccounts.has(key)) chatAccounts.set(key, currentAccount());
  }
}

/** A chat deleted on its own, kept through offline with its tab. */
export interface KeptDeletedChat {
  readonly scope: Scope;
  readonly tab: ChatTab;
}

/**
 * The chats deleted on their own, while their task stays, that this window
 * keeps through going offline: same account, and still holding unsent work
 * as their composers hold it now. Their live task is cleaned up as usual.
 */
export function deletedChatsKeptThroughOffline(): KeptDeletedChat[] {
  const live = currentChatContents();
  return listDeletedCloudChats().flatMap(({ scope, chatId }) => {
    if (isCloudTaskDeleted(scope)) return [];
    const key = chatKeyOf(scope, chatId);
    if (chatAccounts.get(key) !== currentAccount()) {
      chatAccounts.delete(key);
      return [];
    }
    // Shown now, or kept from an earlier offline and not shown since.
    const tab =
      live.worktreeChats[keyOf(scope)]?.tabs.find(
        (each) => each.id === chatId,
      ) ?? keptDeletedChatTab(scope, chatId);
    const draft = live.tabDrafts[chatId];
    const unsent =
      (draft !== undefined && draftHasContent(draft)) ||
      (tab?.pendingAttachments?.length ?? 0) > 0;
    if (tab === undefined || !unsent) {
      chatAccounts.delete(key);
      return [];
    }
    return [{ scope, tab }];
  });
}

/** Marks again the chats kept while the connection was replaced. */
export function rekeepDeletedChats(chats: readonly KeptDeletedChat[]): void {
  for (const { scope, tab } of chats) {
    markCloudChatDeleted(scope, tab.id);
    keepDeletedChatTab(scope, tab);
    chatAccounts.set(chatKeyOf(scope, tab.id), currentAccount());
  }
}

/** Marks again the deleted tasks kept while the connection was replaced. */
export function remarkDeletedTasks(scopes: readonly Scope[]): void {
  for (const scope of scopes) markCloudTaskDeleted(scope);
}

/** Once the cloud lists projects again, kept rows show again. */
function restoreKeptRows(): void {
  const cowork = cloudCoworkStore.getState();
  if (cowork.status !== 'online') return;
  let live: ChatContents | null = null;
  for (const { scope, title, account } of keptRows.values()) {
    if (account !== currentAccount() || !isCloudTaskDeleted(scope)) continue;
    const workspaceId = webCoreLocalId(scope.projectId);
    const taskId = webCoreLocalId(scope.worktreeId);
    if (workspaceId === null || taskId === null) continue;
    const projectKey = `web-core:${workspaceId}`;
    if (!cowork.projects.some((project) => project.key === projectKey))
      continue;
    const shown = cowork.tasksByProject[projectKey]?.find(
      (task) => task.worktreeId === taskId,
    );
    if (shown?.deleted === true) continue;
    // Only a task still holding unsent work shows its row again.
    live ??= currentChatContents();
    if (chatsWithUnsentWork(live, scope).length > 0)
      cowork.keepDeletedTask(workspaceId, taskId, title);
  }
}

let installed = false;

/** Installs what the web core backend does with a task deleted elsewhere. */
export function installCloudTaskDeletionHandler(): void {
  setWebCoreTaskDeletionHandler(keepDeletedTaskRow);
  setWebCoreUnsentWorkCheck((scope, chatId) => {
    const { draft, attachments } = deletedTaskContents(
      currentChatContents(),
      scope,
      chatId,
    );
    return draft !== undefined || attachments.length > 0;
  });
  if (installed) return;
  installed = true;
  cloudCoworkStore.subscribe(restoreKeptRows);
  subscribeCloudTaskDeletions(recordDeletedChatAccounts);
}

/**
 * Leaves a deleted task for good: its stored draft, its row and its chat go,
 * and the page moves off it if it is open.
 */
function leaveDeletedTask(scope: Scope): void {
  keptRows.delete(keyOf(scope));
  const chat = useChatStore.getState();
  for (const tab of chat.worktreeChats[keyOf(scope)]?.tabs ?? [])
    chat.clearTabDraft(tab.id);
  chat.clearTabDraft(scope.worktreeId);
  const workspaceId = webCoreLocalId(scope.projectId);
  const taskId = webCoreLocalId(scope.worktreeId);
  if (workspaceId !== null && taskId !== null)
    cloudCoworkStore.getState().forgetTask(workspaceId, taskId);
  chat.releaseChatScopeRevisioned(scope.projectId, scope.worktreeId);
  chat.cleanupWorktree(scope.projectId, scope.worktreeId);
  forgetCloudTaskDeletion(scope);
  const standalone = useStandaloneChatStore.getState();
  if (
    standalone.activeChatProjectId === scope.projectId &&
    standalone.activeWorkEntryId === scope.worktreeId
  )
    standalone.clearActiveWorkEntry();
}

/**
 * Drops one chat's draft and attachments; once no chat of the deleted task
 * holds any, the task goes too.
 */
function leaveDeletedChat(scope: Scope, tabId: string): void {
  const others = chatsWithUnsentWork(currentChatContents(), scope);
  const chat = useChatStore.getState();
  chat.clearTabDraft(tabId);
  // A deleted task goes once no chat holds unsent work; a chat deleted on
  // its own leaves its live task as it is.
  if (isCloudTaskDeleted(scope) && others.every((each) => each === tabId)) {
    leaveDeletedTask(scope);
    return;
  }
  forgetCloudChatDeletion(scope, tabId);
  // The chat has nothing left to offer, and nothing can reach the web core
  // for it: it leaves this window, so its composer never saves it back.
  const key = keyOf(scope);
  useChatStore.setState((state) => {
    const current = state.worktreeChats[key];
    if (current === undefined) return {};
    const tabs = current.tabs.filter((tab) => tab.id !== tabId);
    const activeTabId =
      current.activeTabId === tabId ? (tabs[0]?.id ?? '') : current.activeTabId;
    return {
      worktreeChats: {
        ...state.worktreeChats,
        [key]: {
          ...current,
          tabs,
          activeTabId,
          lastActiveEditableChatId:
            current.lastActiveEditableChatId === tabId
              ? activeTabId
              : current.lastActiveEditableChatId,
        },
      },
    };
  });
}

/**
 * Discards a deleted task's draft and attachments: one chat's, or with no
 * chat named, every chat's and its row.
 */
export function discardDeletedCloudTask(scope: Scope, tabId?: string): void {
  if (
    tabId === undefined
      ? !isCloudTaskDeleted(scope)
      : !isCloudChatDeleted(scope, tabId)
  )
    return;
  if (discardAsked === keyOf(scope)) setDiscardAsked(null);
  if (tabId === undefined) leaveDeletedTask(scope);
  else leaveDeletedChat(scope, tabId);
}

/** The deleted task whose composer asks to confirm a discard, by scope key. */
let discardAsked: string | null = null;
const discardListeners = new Set<() => void>();

function setDiscardAsked(key: string | null): void {
  discardAsked = key;
  for (const listener of [...discardListeners]) listener();
}

/**
 * The sidebar row's Discard. A draft with text is lost for good, so the task
 * opens and its composer asks first; attachments alone go at once.
 */
export function requestDeletedTaskDiscard(scope: Scope): void {
  if (!isCloudTaskDeleted(scope)) return;
  const state = currentChatContents();
  if (
    !chatsWithUnsentWork(state, scope).some(
      (tabId) => deletedTaskContents(state, scope, tabId).draft !== undefined,
    )
  ) {
    discardDeletedCloudTask(scope);
    return;
  }
  openCoworkWorkEntryFromSidebar(scope.projectId, scope.worktreeId);
  setDiscardAsked(keyOf(scope));
}

/** Whether this deleted task's composer is asked to confirm a discard. */
export function useDeletedTaskDiscardAsked(scope: Scope): boolean {
  return (
    useSyncExternalStore(
      (listener) => {
        discardListeners.add(listener);
        return (): void => {
          discardListeners.delete(listener);
        };
      },
      () => discardAsked,
    ) === keyOf(scope)
  );
}

/** The composer's confirmation closed without a discard. */
export function dismissDeletedTaskDiscard(scope: Scope): void {
  if (discardAsked === keyOf(scope)) setDiscardAsked(null);
}

/**
 * Starts a new task in the deleted task's project and opens it with one
 * chat's draft. Each attachment that came from a file on this computer is attached
 * again from that file; a pasted one has nothing to read again, and the
 * notice asked for it. Once the web core created the new task, that chat's
 * draft goes, and the deleted task with it when no other chat holds one,
 * unless the chat was edited meanwhile, when it stays with its edits; a
 * refused create keeps it all, and the new row says why.
 */
export function startNewChatFromDeletedTask(
  scope: Scope,
  tabId: string = scope.worktreeId,
): void {
  if (!isCloudChatDeleted(scope, tabId)) return;
  const moved = deletedTaskContents(currentChatContents(), scope, tabId);
  const { draft, attachments } = moved;
  const movedKey = unsentWorkKey(moved);
  const sourced = attachments.flatMap((attachment) => {
    const file = cloudAttachmentSource(attachment.absolutePath);
    return file === undefined ? [] : [{ file, name: attachment.filename }];
  });
  const unsourced = attachments
    .filter(
      (attachment) =>
        cloudAttachmentSource(attachment.absolutePath) === undefined,
    )
    .map((attachment) => attachment.filename);
  let started: ReturnType<typeof beginCloudTask>;
  try {
    started = beginCloudTask(scope.projectId, (target) => {
      if (draft !== undefined)
        useChatStore.getState().saveTabDraft(target.worktreeId, draft);
    });
  } catch (error) {
    reportClientAppError(error);
    return;
  }
  const target = {
    projectId: scope.projectId,
    worktreeId: started.worktreeId,
    chatId: started.worktreeId,
  };
  // Each file is read and uploaded on its own, so one that moved since is
  // named on the new chat while the rest attach.
  void Promise.all(
    sourced.map(async ({ file, name }) => {
      try {
        const { attachments: attached } = await importWebCoreChatFiles(target, [
          file,
        ]);
        if (attached.length === 0) return name;
        useChatStore.getState().addPendingAttachments(attached, target);
        return null;
      } catch (error) {
        reportClientAppError(error);
        return name;
      }
    }),
  ).then((failed) => {
    setFilesNotAttached(target.chatId, [
      ...unsourced,
      ...failed.filter((name): name is string => name !== null),
    ]);
  });
  // The source goes only if it still holds exactly what moved: anything
  // typed or attached there while the create was pending stays with it.
  void started.created.then(
    () => {
      if (!isCloudChatDeleted(scope, tabId)) return;
      const live = deletedTaskContents(currentChatContents(), scope, tabId);
      if (unsentWorkKey(live) === movedKey) leaveDeletedChat(scope, tabId);
    },
    () => undefined,
  );
}

/**
 * Files a new chat started from a deleted one couldn't take, by chat id, so
 * its composer names them rather than lose them silently.
 */
const MAX_NOT_ATTACHED = 32;
const notAttached = new Map<string, readonly string[]>();
const notAttachedListeners = new Set<() => void>();
let notAttachedVersion = 0;

function setFilesNotAttached(chatId: string, names: readonly string[]): void {
  if (names.length === 0 && !notAttached.has(chatId)) return;
  notAttached.delete(chatId);
  if (names.length > 0) notAttached.set(chatId, names);
  for (const oldest of notAttached.keys()) {
    if (notAttached.size <= MAX_NOT_ATTACHED) break;
    notAttached.delete(oldest);
  }
  notAttachedVersion += 1;
  for (const listener of [...notAttachedListeners]) listener();
}

/** The files the new chat couldn't take, or an empty list. */
export function useFilesNotAttached(
  chatId: string | undefined,
): readonly string[] {
  useSyncExternalStore(
    (listener) => {
      notAttachedListeners.add(listener);
      return (): void => {
        notAttachedListeners.delete(listener);
      };
    },
    () => notAttachedVersion,
  );
  return (chatId === undefined ? undefined : notAttached.get(chatId)) ?? [];
}

/** The person dismissed the new chat's notice about its files. */
export function dismissFilesNotAttached(chatId: string): void {
  setFilesNotAttached(chatId, []);
}
