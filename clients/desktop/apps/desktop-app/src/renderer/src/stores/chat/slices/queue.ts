import { MESSAGE_NO_LONGER_EDITABLE_NOTICE } from '@canopy/ui-shared/components';
import { toAppError } from '@canopy/protocol/app-errors';
import {
  reportClientAppError,
  resolveClientAppError,
} from '@canopy/desktop-instrumentation/client';
import { inlineFailure, type InlineFailure } from '@/lib/inline-app-error';
import { getWorktreeChatContext } from '../context';
import { getChatToastAttribution } from '../notifications';
import { useGitHubStore } from '../../githubStore';
import { isWebCoreScope } from '@/lib/chat-authority';
import {
  isUnconfirmedQueueWrite,
  pendingQueueRead,
  queueCommandNotice,
  queueShownNotice,
} from '../web-core/queue-unconfirmed';
import { blockedPersistenceKeys } from '../persistence';
import { isTerminalBackedInterfaceMode } from '@canopy/desktop-shared/types';
import { useClaudeTerminalStore } from '@/stores/claudeTerminalStore';
import { attachmentMetasFromPaths } from '../attachments';
import { cancelProvisionalFirstSendQueue } from '../provisional-first-send';
import { type ChatTab, type QueuedChatMessage } from '../types';
import {
  clearWorktreeHydrationState,
  removeWorktreeRuntimeState,
  scheduleIdleChatUnload,
} from '../hydration';
import type { StateCreator } from 'zustand';
import type {
  ChatState,
  ChatQueueSlice,
  QueuedMessageEditFailure,
  UnsavedQueuedEdit,
} from '../state';
import {
  chatBackendFor,
  ignoreUnavailable,
  localChatBackend,
  reportUnlessUnavailable,
} from '../backend';

// The pending host lock request per edited entry. Leaving the editor (cancel,
// switch, or save) forgets the attempt, so a rejection the host reports only
// because that unlock or edit landed first is not mistaken for a lost message.
const pendingEditLocks = new Map<string, symbol>();

function editLockKey(key: string, chatId: string, entryId: string): string {
  return JSON.stringify([key, chatId, entryId]);
}

/**
 * The identity a queued row keeps across host queue refreshes, which rebuild
 * the row objects. Its edit failure is stored and found by this key.
 */
export function queuedMessageEditFailureKey(
  message: QueuedChatMessage,
): string | undefined {
  return (
    message.hostQueueEntryId ??
    message.dispatchOptions?.acceptedInputId ??
    message.dispatchOptions?.userMessageId
  );
}

type ChatSet = Parameters<StateCreator<ChatState, [], [], ChatQueueSlice>>[0];

/**
 * The chat whose open editor holds `message`, found by the message's
 * identity when the editor opens (CAN-6799); undefined for a message with
 * no identity, such as a scheduled send.
 */
export function findQueuedEditScope(
  state: Pick<ChatState, 'worktreeChats'>,
  message: QueuedChatMessage,
): QueuedEditScope | undefined {
  const id = queuedMessageEditFailureKey(message);
  if (id === undefined) return undefined;
  for (const [worktreeKey, chats] of Object.entries(state.worktreeChats)) {
    const tab = chats?.tabs.find(
      (candidate) =>
        candidate.editingQueuedMessageIndex !== undefined &&
        candidate.queuedMessages.some(
          (row) => queuedMessageEditFailureKey(row) === id,
        ),
    );
    if (tab) return { worktreeKey, chatId: tab.id };
  }
  return undefined;
}

function sameUnsavedQueuedEdit(
  a: Omit<UnsavedQueuedEdit, 'text'>,
  b: Omit<UnsavedQueuedEdit, 'text'>,
): boolean {
  return (
    a.worktreeKey === b.worktreeKey && a.chatId === b.chatId && a.id === b.id
  );
}

interface QueuedEditScope {
  worktreeKey: string;
  chatId: string;
}

/**
 * Replaces the chat's queued-edit failure: `failure` shows on `row`, or the
 * chat has none when either is missing. A row that already left the queue has
 * nowhere to show it; its disappearance is the outcome the person sees.
 */
function setQueuedEditFailure(
  set: ChatSet,
  scope: QueuedEditScope,
  row: QueuedChatMessage | undefined,
  failure: InlineFailure | null,
): void {
  set((state) => {
    const current = state.queuedMessageEditFailures;
    const next: Record<string, QueuedMessageEditFailure> = {};
    let removed = false;
    for (const [entryKey, existing] of Object.entries(current)) {
      if (
        existing.worktreeKey === scope.worktreeKey &&
        existing.chatId === scope.chatId
      )
        removed = true;
      else next[entryKey] = existing;
    }
    const entryKey = row ? queuedMessageEditFailureKey(row) : undefined;
    if (!row || !entryKey || !failure)
      return removed ? { queuedMessageEditFailures: next } : state;
    next[entryKey] = { ...failure, ...scope, text: row.text };
    return { queuedMessageEditFailures: next };
  });
}

function findQueuedRow(
  state: ChatState,
  scope: QueuedEditScope,
  entryId: string,
): QueuedChatMessage | undefined {
  return state.worktreeChats[scope.worktreeKey]?.tabs
    .find((tab) => tab.id === scope.chatId)
    ?.queuedMessages.find((row) => row.hostQueueEntryId === entryId);
}

/** Whether the chat a queued message's command came from is still shown. */
function chatStillShown(
  state: Pick<ChatState, 'worktreeChats'>,
  key: string,
  chatId: string,
): boolean {
  return (
    state.worktreeChats[key]?.tabs.some((tab) => tab.id === chatId) === true
  );
}

/**
 * Says what a cloud queued message's Cancel, Run now or edit left when it
 * can't be confirmed (CAN-7196): a notice, never a failure. False for any
 * other error. The web core backend read the queue again before answering;
 * when that read failed, the notice says it is still checking, and once the
 * backend's next read is in, says what the queue shows. A sign-out, account
 * change or disconnect that cleared the chat while the command or its read
 * was out leaves nothing of it in the next session.
 */
function noticeUnconfirmedQueueCommand(
  sel: { readonly projectId: string; readonly worktreeId: string },
  chatId: string,
  error: unknown,
  command: 'cancel' | 'force' | 'edit',
  shown: () => boolean,
): boolean {
  if (!isWebCoreScope(sel.projectId)) return false;
  const notice = queueCommandNotice(error, command);
  if (notice === null) return false;
  if (!shown()) return true;
  const toast = (message: string): void => {
    const { meta, onClick } = getChatToastAttribution({
      projectId: sel.projectId,
      worktreeId: sel.worktreeId,
      chatId,
    });
    useGitHubStore.getState().addToast(message, 'info', onClick, meta);
  };
  toast(notice);
  void pendingQueueRead(error)?.then(() => {
    if (shown()) toast(queueShownNotice(error, command));
  });
  return true;
}

/**
 * A cloud Cancel or Run now's failure handler: one that can't be confirmed
 * says what the queue shows; any other is reported as before.
 */
function settleQueueCommandFailure(
  sel: { readonly projectId: string; readonly worktreeId: string },
  chatId: string,
  command: 'cancel' | 'force',
  shown: () => boolean,
): (error: unknown) => void {
  return (error) => {
    if (!noticeUnconfirmedQueueCommand(sel, chatId, error, command, shown))
      reportUnlessUnavailable(error);
  };
}

export const createQueueSlice: StateCreator<
  ChatState,
  [],
  [],
  ChatQueueSlice
> = (set, get, api) => ({
  queuedMessageEditFailures: {},
  unsavedQueuedEdits: [],

  keepUnsavedQueuedEdit: (edit): void => {
    // Only a malformed call is skipped: a cleared edit keeps its empty text.
    if (typeof edit?.id !== 'string' || typeof edit.text !== 'string') return;
    set((state) => ({
      unsavedQueuedEdits: [
        ...state.unsavedQueuedEdits.filter(
          (kept) => !sameUnsavedQueuedEdit(kept, edit),
        ),
        edit,
      ],
    }));
  },

  keepQueuedEditIfRowLeft: (openedIn, message, text): void => {
    const id = queuedMessageEditFailureKey(message);
    if (id === undefined || text.trim() === message.text.trim()) return;
    const stillQueued = get()
      .worktreeChats[openedIn.worktreeKey]?.tabs.find(
        (tab) => tab.id === openedIn.chatId,
      )
      ?.queuedMessages.some((row) => queuedMessageEditFailureKey(row) === id);
    if (stillQueued) return;
    get().keepUnsavedQueuedEdit({ ...openedIn, id, text });
  },

  dismissUnsavedQueuedEdit: (edit): void => {
    set((state) => {
      const kept = state.unsavedQueuedEdits.filter(
        (candidate) => !sameUnsavedQueuedEdit(candidate, edit),
      );
      return kept.length === state.unsavedQueuedEdits.length
        ? state
        : { unsavedQueuedEdits: kept };
    });
  },

  dismissQueuedMessageEditFailure: (entryKey): void => {
    if (get().queuedMessageEditFailures[entryKey] === undefined) return;
    set((state) => {
      const next = { ...state.queuedMessageEditFailures };
      delete next[entryKey];
      return { queuedMessageEditFailures: next };
    });
  },

  clearQueuedMessage: (index, target): void => {
    const context = getWorktreeChatContext(get(), target);
    if (!context) return;
    const { selection: sel, key, chatId, activeTab } = context;
    const targetMessage = activeTab?.queuedMessages[index];
    const queuedHookQueueId = targetMessage?.queuedHookQueueId;
    const isHookPlaceholder = queuedHookQueueId !== undefined;

    if (isHookPlaceholder) {
      void localChatBackend()
        .chat.cancelQueuedHookChat({
          queueId: queuedHookQueueId,
        })
        .then(
          ({ cancelled }) => {
            if (!cancelled) {
              return;
            }

            set((state) => {
              const currentWc = state.worktreeChats[key];
              if (!currentWc) return state;

              const currentTab = currentWc.tabs.find(
                (tab) => tab.id === chatId,
              );
              const currentMessage = currentTab?.queuedMessages[index];
              if (
                currentTab?.queuedHookPlaceholder !== true ||
                currentMessage?.queuedHookQueueId !== queuedHookQueueId
              ) {
                return state;
              }

              const filteredTabs = currentWc.tabs.filter(
                (tab) => tab.id !== chatId,
              );
              const previousActiveTabId = currentWc.activeTabId;
              const nextActiveTabId =
                previousActiveTabId === chatId
                  ? (filteredTabs[filteredTabs.length - 1]?.id ?? '')
                  : previousActiveTabId;
              const updated = {
                ...currentWc,
                tabs: filteredTabs,
                activeTabId: nextActiveTabId,
              };
              return {
                worktreeChats: {
                  ...state.worktreeChats,
                  [key]: updated,
                },
              };
            });
          },
          () => {
            // Leave the placeholder intact so the user can retry cancellation.
          },
        );
      return;
    }

    if (targetMessage?.hostQueueEntryId) {
      void chatBackendFor(sel)
        .chat.cancelQueuedMessage({
          projectId: sel.projectId,
          worktreeId: sel.worktreeId,
          chatId,
          entryId: targetMessage.hostQueueEntryId,
        })
        .catch(
          settleQueueCommandFailure(sel, chatId, 'cancel', () =>
            chatStillShown(get(), key, chatId),
          ),
        );
      return;
    }

    const acceptedInputId = targetMessage?.dispatchOptions?.acceptedInputId;
    const removeLocal = (): void => {
      set((state) => {
        const currentWc = state.worktreeChats[key];
        if (!currentWc) return state;

        const updatedTabs = currentWc.tabs.map((t) =>
          t.id === chatId
            ? {
                ...cancelProvisionalFirstSendQueue(
                  t,
                  targetMessage?.dispatchOptions?.userMessageId,
                ),
                queuedMessages: t.queuedMessages.filter((message, i) =>
                  acceptedInputId
                    ? message.dispatchOptions?.acceptedInputId !==
                      acceptedInputId
                    : i !== index,
                ),
              }
            : t,
        );
        return {
          worktreeChats: {
            ...state.worktreeChats,
            [key]: { ...currentWc, tabs: updatedTabs },
          },
        };
      });
    };
    if (!acceptedInputId) {
      removeLocal();
      return;
    }
    // Main retains accepted agent input; settle it first so it can never be
    // delivered later. A refusal keeps the entry so the user can retry.
    void chatBackendFor(sel)
      .chat.cancelQueuedMessage({
        projectId: sel.projectId,
        worktreeId: sel.worktreeId,
        chatId,
        entryId: acceptedInputId,
      })
      .then(removeLocal, () => undefined);
  },

  forceQueuedMessage: (index, target): void => {
    const context = getWorktreeChatContext(get(), target);
    if (!context) return;
    const { selection: sel, key, chatId, activeTab } = context;
    const targetMessage = activeTab?.queuedMessages[index];
    if (!activeTab || !targetMessage) return;

    if (targetMessage.queuedHookQueueId) {
      void localChatBackend()
        .chat.forceQueuedHookChat({
          queueId: targetMessage.queuedHookQueueId,
        })
        .catch((error: unknown) => {
          // Leave the placeholder intact so the user can retry forcing it.
          reportClientAppError(error);
        });
      return;
    }

    if (targetMessage.hostQueueEntryId) {
      void chatBackendFor(sel)
        .chat.forceQueuedMessage({
          projectId: sel.projectId,
          worktreeId: sel.worktreeId,
          chatId,
          entryId: targetMessage.hostQueueEntryId,
        })
        .catch(
          settleQueueCommandFailure(sel, chatId, 'force', () =>
            chatStillShown(get(), key, chatId),
          ),
        );
      return;
    }

    // Host queues above dispatch by entry id. Legacy local queues drain their
    // head once cancellation settles, so promote only the selected prompt.
    const promoteTarget = (queued: QueuedChatMessage[]): QueuedChatMessage[] =>
      queued[index] === targetMessage
        ? [targetMessage, ...queued.filter((_, i) => i !== index)]
        : queued;

    if (activeTab.status === 'streaming') {
      if (isTerminalBackedInterfaceMode(activeTab.interfaceMode)) {
        const runtime = useClaudeTerminalStore
          .getState()
          .getStateForChat(sel.projectId, sel.worktreeId, chatId);
        if (runtime?.terminalId) {
          set((state) => {
            const currentWc = state.worktreeChats[key];
            if (!currentWc) return state;

            const updatedTabs = currentWc.tabs.map((tab) =>
              tab.id === chatId
                ? {
                    ...tab,
                    queuedMessages: promoteTarget(tab.queuedMessages),
                    forceQueuedMessageCancelPending: true,
                  }
                : tab,
            );
            return {
              worktreeChats: {
                ...state.worktreeChats,
                [key]: { ...currentWc, tabs: updatedTabs },
              },
            };
          });
          void window.api.terminal
            .write({ terminalId: runtime.terminalId, data: '\x03' })
            .catch((error: unknown) => {
              reportClientAppError(error);
              set((state) => {
                const currentWc = state.worktreeChats[key];
                if (!currentWc) return state;
                const updatedTabs = currentWc.tabs.map((tab) =>
                  tab.id === chatId
                    ? {
                        ...tab,
                        forceQueuedMessageCancelPending: undefined,
                      }
                    : tab,
                );
                return {
                  worktreeChats: {
                    ...state.worktreeChats,
                    [key]: { ...currentWc, tabs: updatedTabs },
                  },
                };
              });
            });
          return;
        }
      }

      set((state) => {
        const currentWc = state.worktreeChats[key];
        if (!currentWc) return state;

        const updatedTabs = currentWc.tabs.map((tab) =>
          tab.id === chatId
            ? {
                ...tab,
                queuedMessages: promoteTarget(tab.queuedMessages),
                forceQueuedMessageCancelPending: true,
              }
            : tab,
        );
        return {
          worktreeChats: {
            ...state.worktreeChats,
            [key]: { ...currentWc, tabs: updatedTabs },
          },
        };
      });
      void get().cancelSession({
        projectId: sel.projectId,
        worktreeId: sel.worktreeId,
        chatId,
      });
      return;
    }

    const restoredAttachments = attachmentMetasFromPaths(
      targetMessage.attachmentPaths,
      targetMessage.attachmentPromptContexts,
    );
    set((state) => {
      const currentWc = state.worktreeChats[key];
      if (!currentWc) return state;
      const updatedTabs = currentWc.tabs.map((tab) =>
        tab.id === chatId
          ? {
              ...tab,
              queuedMessages: tab.queuedMessages.filter(
                (message) => message !== targetMessage,
              ),
              pendingAttachments: restoredAttachments,
            }
          : tab,
      );
      return {
        worktreeChats: {
          ...state.worktreeChats,
          [key]: { ...currentWc, tabs: updatedTabs },
        },
      };
    });
    void get().sendMessage(
      targetMessage.text,
      targetMessage.fileReferences,
      {
        projectId: sel.projectId,
        worktreeId: sel.worktreeId,
        chatId,
      },
      targetMessage.inputMode,
      targetMessage.dispatchOptions,
    );
  },

  setEditingQueuedMessage: async (
    requestedIndex,
    target,
    expected,
  ): Promise<void> => {
    const context = getWorktreeChatContext(get(), target);
    if (!context) return;
    const { selection: sel, key, chatId, activeTab } = context;
    const attemptKey = editLockKey(key, chatId, '');
    const scope: QueuedEditScope = { worktreeKey: key, chatId };
    // The failure shows on the row the person chose to edit.
    const showUnavailable = (row: QueuedChatMessage | undefined): void => {
      setQueuedEditFailure(set, scope, row, {
        error: MESSAGE_NO_LONGER_EDITABLE_NOTICE,
      });
    };
    const updateEditing = (
      index: number | null,
      focusAllowed = true,
      pendingId?: string,
    ): void => {
      set((state) => {
        const wc = state.worktreeChats[key];
        if (!wc) return state;
        return {
          worktreeChats: {
            ...state.worktreeChats,
            [key]: {
              ...wc,
              tabs: wc.tabs.map((tab) => {
                if (tab.id !== chatId) return tab;
                const next = { ...tab };
                if (pendingId) next.pendingQueuedMessageEditId = pendingId;
                else delete next.pendingQueuedMessageEditId;
                if (index === null) {
                  delete next.editingQueuedMessageIndex;
                  delete next.editingQueuedMessageFocusAllowed;
                } else {
                  next.editingQueuedMessageIndex = index;
                  next.editingQueuedMessageFocusAllowed = focusAllowed;
                }
                return next;
              }),
            },
          },
        };
      });
    };
    if (requestedIndex === null) {
      pendingEditLocks.delete(attemptKey);
      const previousIndex = activeTab?.editingQueuedMessageIndex;
      const previousEntryId =
        previousIndex === undefined
          ? undefined
          : activeTab?.queuedMessages[previousIndex]?.hostQueueEntryId;
      updateEditing(null);
      if (previousEntryId) {
        await chatBackendFor(sel)
          .chat.setQueuedMessageEditLock({
            ...sel,
            chatId,
            entryId: previousEntryId,
            locked: false,
          })
          .catch(ignoreUnavailable);
      } else if (
        activeTab?.status === 'idle' &&
        activeTab.queuedMessages.length > 0
      ) {
        get().forceQueuedMessage(0, { ...sel, chatId });
      }
      return;
    }
    if (pendingEditLocks.has(attemptKey)) return;
    const queued = activeTab?.queuedMessages ?? [];
    const index = expected
      ? queued.findIndex(
          (candidate) =>
            candidate === expected ||
            (expected.hostQueueEntryId !== undefined &&
              candidate.hostQueueEntryId === expected.hostQueueEntryId),
        )
      : requestedIndex;
    const message = queued[index];
    if (
      !message ||
      message.pendingSend ||
      message.queuedHookQueueId ||
      message.editLocked ||
      activeTab?.editingQueuedMessageIndex !== undefined
    ) {
      showUnavailable(message);
      return;
    }
    setQueuedEditFailure(set, scope, undefined, null);
    if (!message.hostQueueEntryId) {
      updateEditing(index);
      return;
    }
    const entryId = message.hostQueueEntryId;
    const attempt = Symbol(entryId);
    pendingEditLocks.set(attemptKey, attempt);
    updateEditing(null, true, entryId);
    const selection = get().selectedWorktree;
    const activeTabId = get().worktreeChats[key]?.activeTabId;
    const stillInContext = (): boolean => {
      const current = get().selectedWorktree;
      return (
        current?.projectId === selection?.projectId &&
        current?.worktreeId === selection?.worktreeId &&
        get().worktreeChats[key]?.activeTabId === activeTabId
      );
    };
    const unsubscribe = api.subscribe(() => {
      if (!stillInContext() && pendingEditLocks.get(attemptKey) === attempt) {
        pendingEditLocks.delete(attemptKey);
        updateEditing(null);
      }
    });
    let focusMoved = false;
    const onFocus = (): void => {
      focusMoved = true;
    };
    globalThis.document?.addEventListener('focusin', onFocus);
    try {
      await chatBackendFor(sel).chat.setQueuedMessageEditLock({
        ...sel,
        chatId,
        entryId,
        locked: true,
      });
      const currentTab = get().worktreeChats[key]?.tabs.find(
        (tab) => tab.id === chatId,
      );
      const currentIndex =
        currentTab?.queuedMessages.findIndex(
          (row) => row.hostQueueEntryId === entryId,
        ) ?? -1;
      const currentMessage = currentTab?.queuedMessages[currentIndex];
      if (
        pendingEditLocks.get(attemptKey) !== attempt ||
        !stillInContext() ||
        !currentMessage ||
        currentMessage.pendingSend ||
        currentMessage.queuedHookQueueId ||
        currentTab?.editingQueuedMessageIndex !== undefined
      ) {
        // Only a successful acquisition owns a lock that this attempt may release.
        await chatBackendFor(sel).chat.setQueuedMessageEditLock({
          ...sel,
          chatId,
          entryId,
          locked: false,
        });
        if (pendingEditLocks.get(attemptKey) === attempt && stillInContext())
          showUnavailable(findQueuedRow(get(), scope, entryId));
        return;
      }
      updateEditing(currentIndex, !focusMoved);
    } catch (error) {
      const appError = toAppError(resolveClientAppError(error));
      if (
        appError &&
        pendingEditLocks.get(attemptKey) === attempt &&
        stillInContext()
      )
        setQueuedEditFailure(
          set,
          scope,
          findQueuedRow(get(), scope, entryId),
          inlineFailure(appError, 'Couldn’t open this message for editing.'),
        );
    } finally {
      unsubscribe();
      globalThis.document?.removeEventListener('focusin', onFocus);
      if (pendingEditLocks.get(attemptKey) === attempt) {
        pendingEditLocks.delete(attemptKey);
        const currentTab = get().worktreeChats[key]?.tabs.find(
          (tab) => tab.id === chatId,
        );
        if (currentTab?.pendingQueuedMessageEditId) updateEditing(null);
      }
    }
  },

  saveEditedQueuedMessage: (
    requestedIndex,
    text,
    fileReferences,
    attachmentPaths,
    attachmentPromptContexts,
    inputMode,
    scheduledSendDraft,
    target,
    expected,
  ): void => {
    const context = getWorktreeChatContext(get(), target);
    if (!context) return;
    const { selection: sel, key, chatId, activeTab } = context;
    const scope: QueuedEditScope = { worktreeKey: key, chatId };
    const index = expected
      ? (activeTab?.queuedMessages.findIndex(
          (candidate) =>
            candidate === expected ||
            (expected.hostQueueEntryId !== undefined &&
              candidate.hostQueueEntryId === expected.hostQueueEntryId),
        ) ?? -1)
      : requestedIndex;
    const edited = activeTab?.queuedMessages[index];
    // Keeps the text the save didn't store (CAN-6799), unless it's unchanged.
    const keepUnsaved = (
      row: QueuedChatMessage | undefined,
      unconfirmed = false,
    ): void => {
      const id =
        row === undefined ? undefined : queuedMessageEditFailureKey(row);
      if (row === undefined || id === undefined || row.text === text) return;
      get().keepUnsavedQueuedEdit({
        ...scope,
        id,
        text,
        ...(unconfirmed ? { unconfirmed: true as const } : {}),
      });
    };
    // The edited row already left the queue: nothing is left to save to.
    if (index < 0 || !edited) {
      keepUnsaved(expected);
      return;
    }
    const hostQueueEntryId = edited.hostQueueEntryId;
    if (hostQueueEntryId) {
      pendingEditLocks.delete(editLockKey(key, chatId, ''));
      // Close the editor before the host round-trip. Queue refreshes preserve
      // the currently edited host entry by id, so leaving this index set would
      // remount the stale editor even after the host accepted the new text.
      set((state) => {
        const currentWc = state.worktreeChats[key];
        if (!currentWc) return state;
        const updatedTabs = currentWc.tabs.map((tab) => {
          if (
            tab.id !== chatId ||
            tab.editingQueuedMessageIndex === undefined
          ) {
            return tab;
          }
          const nextTab = { ...tab };
          delete nextTab.editingQueuedMessageIndex;
          return nextTab;
        });
        return {
          worktreeChats: {
            ...state.worktreeChats,
            [key]: { ...currentWc, tabs: updatedTabs },
          },
        };
      });

      void chatBackendFor(sel)
        .chat.editQueuedMessage({
          projectId: sel.projectId,
          worktreeId: sel.worktreeId,
          chatId,
          entryId: hostQueueEntryId,
          text,
          ...(fileReferences ? { fileReferences } : {}),
          ...(attachmentPaths ? { attachmentPaths } : {}),
          ...(attachmentPromptContexts ? { attachmentPromptContexts } : {}),
          ...(inputMode ? { inputMode } : {}),
        })
        .catch((error: unknown) => {
          // One that may have saved keeps its text as unconfirmed, never as
          // unsaved (CAN-7196).
          keepUnsaved(
            edited,
            isWebCoreScope(sel.projectId) && isUnconfirmedQueueWrite(error),
          );
          // One that may have saved, or that Core forgot, says what the
          // queue now shows, never "Couldn't save" (CAN-7196).
          const unconfirmed = noticeUnconfirmedQueueCommand(
            sel,
            chatId,
            error,
            'edit',
            () => chatStillShown(get(), key, chatId),
          );
          const appError = unconfirmed
            ? null
            : toAppError(resolveClientAppError(error));
          if (appError)
            setQueuedEditFailure(
              set,
              scope,
              findQueuedRow(get(), scope, hostQueueEntryId),
              inlineFailure(appError, 'Couldn’t save your edit.'),
            );
          // A failed edit leaves the host lock intact; release it so the queue
          // can continue draining after the local editor has closed.
          void chatBackendFor(sel)
            .chat.setQueuedMessageEditLock({
              projectId: sel.projectId,
              worktreeId: sel.worktreeId,
              chatId,
              entryId: hostQueueEntryId,
              locked: false,
            })
            .catch(reportUnlessUnavailable);
        });
      return;
    }

    // Main retains the attributed body of accepted agent input. Update it
    // before the local copy so the terminal write and transcript import agree;
    // the open editor holds the drain until main answers.
    const acceptedInputId =
      activeTab?.queuedMessages[index]?.dispatchOptions?.acceptedInputId;
    const applyLocalEdit = (applyText: boolean): void => {
      set((state) => {
        const currentWc = state.worktreeChats[key];
        if (!currentWc) return state;
        const updatedTabs = currentWc.tabs.map((tab) => {
          if (tab.id !== chatId) return tab;
          const targetIndex = acceptedInputId
            ? tab.queuedMessages.findIndex(
                (message) =>
                  message.dispatchOptions?.acceptedInputId === acceptedInputId,
              )
            : index;
          const existing = tab.queuedMessages[targetIndex];
          if (!existing || !applyText) {
            // Main refused the edit or the input already left: close the editor.
            if (!acceptedInputId) return tab;
            const nextTab = { ...tab };
            delete nextTab.editingQueuedMessageIndex;
            return nextTab;
          }
          const updatedMessage: QueuedChatMessage = {
            ...existing,
            text,
            ...(fileReferences && fileReferences.length > 0
              ? { fileReferences }
              : { fileReferences: undefined }),
            ...(attachmentPaths && attachmentPaths.length > 0
              ? { attachmentPaths }
              : { attachmentPaths: undefined }),
            ...(attachmentPromptContexts && attachmentPromptContexts.length > 0
              ? { attachmentPromptContexts }
              : { attachmentPromptContexts: undefined }),
            ...(inputMode ? { inputMode } : {}),
            ...(scheduledSendDraft
              ? { scheduledSendDraft }
              : { scheduledSendDraft: undefined }),
          };
          const nextMessages = tab.queuedMessages.slice();
          nextMessages[targetIndex] = updatedMessage;
          const nextTab: ChatTab = {
            ...tab,
            queuedMessages: nextMessages,
          };
          delete nextTab.editingQueuedMessageIndex;
          return nextTab;
        });
        return {
          worktreeChats: {
            ...state.worktreeChats,
            [key]: { ...currentWc, tabs: updatedTabs },
          },
        };
      });

      const refreshedWc = get().worktreeChats[key];
      const refreshedTab = refreshedWc?.tabs.find((t) => t.id === chatId);
      if (
        refreshedTab &&
        refreshedTab.status === 'idle' &&
        refreshedTab.queuedMessages.length > 0 &&
        refreshedTab.editingQueuedMessageIndex === undefined
      ) {
        get().forceQueuedMessage(0, {
          projectId: sel.projectId,
          worktreeId: sel.worktreeId,
          chatId,
        });
      }
    };
    if (!acceptedInputId) {
      applyLocalEdit(true);
      return;
    }
    void chatBackendFor(sel)
      .chat.editQueuedMessage({
        projectId: sel.projectId,
        worktreeId: sel.worktreeId,
        chatId,
        entryId: acceptedInputId,
        text,
        ...(fileReferences ? { fileReferences } : {}),
        ...(attachmentPaths ? { attachmentPaths } : {}),
        ...(attachmentPromptContexts ? { attachmentPromptContexts } : {}),
        ...(inputMode ? { inputMode } : {}),
      })
      .then(
        () => applyLocalEdit(true),
        () => {
          keepUnsaved(edited);
          applyLocalEdit(false);
        },
      );
  },

  dropWorktreeQueuedState: (projectId, worktreeId): void => {
    const key = `${projectId}/${worktreeId}`;
    set((state) => removeWorktreeRuntimeState(state, projectId, worktreeId));
    set((state) => {
      const failures = Object.entries(state.queuedMessageEditFailures);
      const unsaved = state.unsavedQueuedEdits.filter(
        (edit) => edit.worktreeKey !== key,
      );
      if (
        !failures.some(([, failure]) => failure.worktreeKey === key) &&
        unsaved.length === state.unsavedQueuedEdits.length
      )
        return state;
      return {
        queuedMessageEditFailures: Object.fromEntries(
          failures.filter(([, failure]) => failure.worktreeKey !== key),
        ),
        unsavedQueuedEdits: unsaved,
      };
    });

    blockedPersistenceKeys.delete(key);
    clearWorktreeHydrationState(key);
    scheduleIdleChatUnload();
  },
});
