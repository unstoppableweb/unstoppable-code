import {
  canReceiveWorktreeChatActivity,
  isAppAdvisorChatTarget,
  isAppAdvisorWindowFocused,
} from '../surface';
import {
  ensureHydratedAndReplayPendingEvents,
  pruneUnreadWorktreeKey,
  queuePendingHydrationEvent,
  recordWorktreeChatTouch,
  scheduleIdleChatUnload,
} from '../hydration';
import { hasPendingQuestionForChat } from '../pending-questions';
import { isScopeRevisionedLive } from './revisioned';
import { tagStatusWrite } from '../runtime-divergence';
import {
  fireChatActivityNotification,
  getVisibleWorktreeKey,
  showUnreadChatToast,
  type UnreadChatToastOptions,
} from '../notifications';
import {
  appendStaleAskUserAnswerResult,
  closeOpenTurnTimers,
  pauseOpenTurnTimer,
  resumePausedTurnTimer,
} from '../event-transforms';
import { redactMcpAnswersForDisplay } from '../messages';
import { formatAskUserAnswers } from '@canopy/desktop-shared/lib/ask-user-answers';
import type { McpQuestionAnswer } from '@canopy/desktop-shared/types';
import type { StateCreator } from 'zustand';
import type { ChatState, ChatQuestionsSlice } from '../state';
import type { PendingQuestion } from '../types';
import { localChatBackend } from '../backend';
import { isWebCoreScope } from '@/lib/chat-authority';

interface WorktreeTarget {
  projectId: string;
  worktreeId: string;
}

/**
 * Settle the unread a question raised on its tab once that question stops
 * being actionable.
 *
 * Rule: the tab's `unread` is cleared only when (a) the tab carries the
 * `unreadRaisedByQuestion` marker — the question, not a completed turn,
 * transitioned it into unread — and (b) the answer settles the tab's last
 * unanswered question. A completed-turn unread never carries the marker and
 * therefore survives untouched. Answers clear; dismissals and expiries only
 * release the marker (`clearUnread: false`), immediately and whatever else is
 * still pending, so the unread a never-read question raised survives until
 * the chat is selected and can never be cleared by a sibling's later answer
 * or mis-attributed to a question that is already gone.
 */
function settleQuestionRaisedUnread(
  worktreeChats: ChatState['worktreeChats'],
  unreadWorktreeKeys: Set<string>,
  pq: PendingQuestion,
  pendingQuestionsAfter: Record<string, PendingQuestion>,
  clearUnread: boolean,
): {
  worktreeChats: ChatState['worktreeChats'];
  unreadWorktreeKeys: Set<string>;
  clearedChatId: string | undefined;
} {
  const unchanged = {
    worktreeChats,
    unreadWorktreeKeys,
    clearedChatId: undefined,
  };
  const key = `${pq.projectId}/${pq.worktreeId}`;
  const wc = worktreeChats[key];
  const tab = wc?.tabs.find((candidate) => candidate.id === pq.chatId);
  if (!wc || !tab || tab.unreadRaisedByQuestion !== true) {
    return unchanged;
  }
  if (
    clearUnread &&
    hasPendingQuestionForChat(
      pendingQuestionsAfter,
      pq.projectId,
      pq.worktreeId,
      pq.chatId,
    )
  ) {
    // Another unanswered question on this tab still owns the unread; the
    // answer to its last one settles it.
    return unchanged;
  }
  // A dismissal or expiry releases the marker at once, siblings or not: the
  // dismissed question was never read, so the unread must survive until the
  // chat is selected, and a later answer to a sibling must not clear it.
  const shouldClear = clearUnread && tab.unread === true;
  const tabs = wc.tabs.map((candidate) => {
    if (candidate.id !== pq.chatId) return candidate;
    const next = { ...candidate };
    delete next.unreadRaisedByQuestion;
    return shouldClear ? { ...next, unread: false } : next;
  });
  return {
    worktreeChats: { ...worktreeChats, [key]: { ...wc, tabs } },
    unreadWorktreeKeys: shouldClear
      ? pruneUnreadWorktreeKey(unreadWorktreeKeys, key, tabs)
      : unreadWorktreeKeys,
    clearedChatId: shouldClear ? pq.chatId : undefined,
  };
}

/**
 * Whether a question's answer is a chat command rather than the local
 * provider's waiter: an async question, or any question a web core chat
 * raised, which its own authority settles (CAN-6175).
 */
function answersByCommand(
  pending: PendingQuestion | undefined,
): pending is PendingQuestion {
  return (
    pending !== undefined &&
    (pending.delivery === 'async' || isWebCoreScope(pending.projectId))
  );
}

export const createQuestionsSlice: StateCreator<
  ChatState,
  [],
  [],
  ChatQuestionsSlice
> = (set, get) => {
  // Shared answer implementation: performs the provider IPC, applies the
  // desktop accepted/stale-fallback state transitions, and (for stale answers)
  // dispatches the fallback message. Returns the worktree owning the answered
  // question so awaited callers can flush persistence before acknowledging.
  // Both the fire-and-forget (`answerMcpQuestion`) and awaited
  // (`answerMcpQuestionAndWait`) variants reuse it so their behavior stays
  // identical apart from the durable flush.
  const applyAnswer = async (
    requestId: string,
    answers: McpQuestionAnswer[],
  ): Promise<WorktreeTarget | undefined> => {
    const pending = get().pendingQuestions[requestId];
    if (answersByCommand(pending)) {
      const target = {
        projectId: pending.projectId,
        worktreeId: pending.worktreeId,
      };
      const result = await get().dispatchChatCommand(target, {
        type: 'chat.answer_question',
        chatId: pending.chatId,
        questionId: requestId,
        answers,
      });
      if (result !== 'accepted')
        throw new Error('Question answer was not accepted');
      return target;
    }
    const response = await localChatBackend().chat.answerMcpQuestion({
      requestId,
      answers,
    });
    let fallbackDispatch:
      | {
          text: string;
          target: { projectId: string; worktreeId: string; chatId: string };
        }
      | undefined;
    let target: WorktreeTarget | undefined;
    let clearedUnreadChatId: string | undefined;
    set((state) => {
      const pq = state.pendingQuestions[requestId];
      if (!pq) return state;
      target = { projectId: pq.projectId, worktreeId: pq.worktreeId };
      const answeredAt = Date.now();
      const displayAnswers = redactMcpAnswersForDisplay(pq.questions, answers);
      const fallbackMessageText = formatAskUserAnswers(displayAnswers);
      const key = `${pq.projectId}/${pq.worktreeId}`;
      const wc = state.worktreeChats[key];
      let nextWorktreeChats = state.worktreeChats;
      let nextPendingQuestions = state.pendingQuestions;
      if (wc) {
        if (response.accepted) {
          // Canonical runtime projects `awaiting_input` as streaming and
          // settles the turn itself; only legacy scopes resume locally.
          const canonicalOwnsStatus = isScopeRevisionedLive(
            state,
            pq.projectId,
            pq.worktreeId,
          );
          let tabsChanged = false;
          const tabs = wc.tabs.map((tab) => {
            if (tab.id !== pq.chatId) {
              return tab;
            }
            const resumedMessages = resumePausedTurnTimer(
              tab.messages,
              answeredAt,
              `question:${requestId}`,
            );
            const shouldStream =
              !canonicalOwnsStatus &&
              resumedMessages !== tab.messages &&
              tab.status !== 'streaming';
            if (shouldStream) tagStatusWrite(tab.id, 'question-answer');
            if (resumedMessages === tab.messages && !shouldStream) {
              return tab;
            }
            tabsChanged = true;
            return {
              ...tab,
              status: shouldStream ? ('streaming' as const) : tab.status,
              messages: resumedMessages,
              lastEventAt: answeredAt,
            };
          });
          if (tabsChanged) {
            const updated = { ...wc, tabs };
            nextWorktreeChats = {
              ...state.worktreeChats,
              [key]: updated,
            };
          }
        } else {
          let staleResultAppended = false;
          const tabs = wc.tabs.map((tab) => {
            if (tab.id !== pq.chatId) {
              return tab;
            }
            const result = appendStaleAskUserAnswerResult(
              tab.messages,
              pq,
              fallbackMessageText,
            );
            if (!result.appended) {
              return tab;
            }
            staleResultAppended = true;
            return {
              ...tab,
              status: 'idle' as const,
              messages: closeOpenTurnTimers(result.messages, {
                closePaused: true,
              }),
              lastEventAt: answeredAt,
            };
          });
          const updated = staleResultAppended ? { ...wc, tabs } : wc;
          if (staleResultAppended) {
            nextWorktreeChats = {
              ...state.worktreeChats,
              [key]: updated,
            };
          }
        }
      }
      if (!response.accepted) {
        nextPendingQuestions = { ...state.pendingQuestions };
        delete nextPendingQuestions[requestId];
        fallbackDispatch = {
          text: fallbackMessageText,
          target: {
            projectId: pq.projectId,
            worktreeId: pq.worktreeId,
            chatId: pq.chatId,
          },
        };
      } else {
        nextPendingQuestions = {
          ...state.pendingQuestions,
          [requestId]: {
            ...pq,
            answers: displayAnswers,
            answeredAt,
          },
        };
      }
      // The question is no longer actionable either way: clear the unread it
      // raised so the sidebar row does not keep a bare blue dot with nothing
      // new to see once the orange question dot goes away.
      const settled = settleQuestionRaisedUnread(
        nextWorktreeChats,
        state.unreadWorktreeKeys,
        pq,
        nextPendingQuestions,
        true,
      );
      clearedUnreadChatId = settled.clearedChatId;
      return {
        worktreeChats: settled.worktreeChats,
        pendingQuestions: nextPendingQuestions,
        ...(settled.unreadWorktreeKeys !== state.unreadWorktreeKeys
          ? { unreadWorktreeKeys: settled.unreadWorktreeKeys }
          : {}),
      };
    });
    if (
      target &&
      clearedUnreadChatId &&
      isScopeRevisionedLive(get(), target.projectId, target.worktreeId)
    ) {
      // Durable read state is main-owned; without this relay the persisted
      // unread would resurrect the dot on the next launch. Attention is left
      // alone: answering a question does not dismiss a pending plan review.
      void get().dispatchChatCommand(target, {
        type: 'chat.mark_read',
        chatId: clearedUnreadChatId,
      });
    }
    if (fallbackDispatch) {
      await get().sendMessage(
        fallbackDispatch.text,
        undefined,
        fallbackDispatch.target,
      );
    }
    return target;
  };

  // Shared dismiss implementation: performs the provider IPC and removes the
  // entry, scheduling a save so the removal is projected. Returns the worktree
  // target so awaited callers can flush before acknowledging.
  const applyDismiss = async (
    requestId: string,
  ): Promise<WorktreeTarget | undefined> => {
    const pending = get().pendingQuestions[requestId];
    if (answersByCommand(pending)) {
      const target = {
        projectId: pending.projectId,
        worktreeId: pending.worktreeId,
      };
      const result = await get().dispatchChatCommand(target, {
        type: 'chat.dismiss_question',
        chatId: pending.chatId,
        questionId: requestId,
      });
      if (result !== 'accepted')
        throw new Error('Question dismissal was not accepted');
      return target;
    }
    await localChatBackend().chat.dismissMcpQuestion({ requestId });
    let target: WorktreeTarget | undefined;
    set((state) => {
      const pq = state.pendingQuestions[requestId];
      const next = { ...state.pendingQuestions };
      delete next[requestId];
      if (!pq) {
        return { pendingQuestions: next };
      }
      target = { projectId: pq.projectId, worktreeId: pq.worktreeId };
      const settled = settleQuestionRaisedUnread(
        state.worktreeChats,
        state.unreadWorktreeKeys,
        pq,
        next,
        false,
      );
      return { pendingQuestions: next, worktreeChats: settled.worktreeChats };
    });
    return target;
  };

  return {
    pendingQuestions: {},

    handleMcpAskUser: (event): void => {
      const key = `${event.projectId}/${event.worktreeId}`;
      if (!canReceiveWorktreeChatActivity(event.projectId, event.worktreeId)) {
        return;
      }

      recordWorktreeChatTouch(key);
      let unreadToast: UnreadChatToastOptions | null = null;
      let osQuestionPing: UnreadChatToastOptions | null = null;

      // Store all MCP questions for live worktrees regardless of selected
      // worktree so background agents don't hang waiting for an answer.
      set((state) => {
        const currentWc = state.worktreeChats[key];
        let nextWorktreeChats = state.worktreeChats;
        let nextUnread = state.unreadWorktreeKeys;
        const visibleKey = getVisibleWorktreeKey(state.selectedWorktree);
        const isAppAdvisorTarget = isAppAdvisorChatTarget(
          event.projectId,
          event.worktreeId,
        );
        const shouldMarkUnread = isAppAdvisorTarget
          ? !isAppAdvisorWindowFocused()
          : currentWc === undefined ||
            currentWc.activeTabId !== event.chatId ||
            // A collapsed chat panel is not on screen even as the active tab.
            state.hiddenChatTabIds.has(event.chatId) ||
            key !== visibleKey;
        const existingPending =
          state.pendingQuestions[event.requestId] !== undefined;
        const alreadyUnread = currentWc?.tabs.some(
          (tab) => tab.id === event.chatId && tab.unread === true,
        );
        const tabTitle = currentWc?.tabs.find(
          (tab) => tab.id === event.chatId,
        )?.title;

        if (currentWc) {
          let tabsChanged = false;
          const now = Date.now();
          const tabs = currentWc.tabs.map((tab) => {
            if (tab.id !== event.chatId) return tab;
            const pausedMessages = pauseOpenTurnTimer(
              tab.messages,
              now,
              `question:${event.requestId}`,
            );
            const shouldUpdateUnread = shouldMarkUnread && tab.unread !== true;
            const nextTab =
              pausedMessages !== tab.messages ||
              tab.status === 'streaming' ||
              shouldUpdateUnread
                ? {
                    ...tab,
                    status: 'idle' as const,
                    messages: pausedMessages,
                    lastEventAt: now,
                    ...(shouldMarkUnread
                      ? { unread: true, attentionDismissedAt: undefined }
                      : {}),
                    // Only a transition into unread is attributable to this
                    // question; an already-unread tab keeps whatever raised it,
                    // and a manual mark left over from before is dropped.
                    ...(shouldUpdateUnread
                      ? {
                          unreadRaisedByQuestion: true,
                          unreadMarkedManually: undefined,
                        }
                      : {}),
                  }
                : tab;
            if (nextTab !== tab) {
              tabsChanged = true;
            }
            return nextTab;
          });

          if (tabsChanged) {
            const updated = { ...currentWc, tabs };
            nextWorktreeChats = {
              ...state.worktreeChats,
              [key]: updated,
            };
          }
        }

        if (shouldMarkUnread && !state.unreadWorktreeKeys.has(key)) {
          nextUnread = new Set(state.unreadWorktreeKeys);
          nextUnread.add(key);
        }

        if (shouldMarkUnread && !alreadyUnread && !existingPending) {
          unreadToast = {
            projectId: event.projectId,
            worktreeId: event.worktreeId,
            chatId: event.chatId,
            chatTitle: tabTitle,
            reason: 'question',
          };
        } else if (!shouldMarkUnread && !existingPending) {
          osQuestionPing = {
            projectId: event.projectId,
            worktreeId: event.worktreeId,
            chatId: event.chatId,
            chatTitle: tabTitle,
            reason: 'question',
          };
        }

        return {
          worktreeChats: nextWorktreeChats,
          unreadWorktreeKeys: nextUnread,
          pendingQuestions: {
            ...state.pendingQuestions,
            [event.requestId]: {
              requestId: event.requestId,
              projectId: event.projectId,
              worktreeId: event.worktreeId,
              chatId: event.chatId,
              questions: event.questions,
              // When the bridge forwards an explicit `toolUseId` on the IPC
              // payload (Codex paths), copy it onto the pending record so the
              // transcript matcher can pair this card to a specific tool_use
              // block deterministically. Left undefined for the Claude path.
              ...(event.toolUseId ? { toolUseId: event.toolUseId } : {}),
            },
          },
        };
      });

      if (!get().worktreeChats[key]) {
        queuePendingHydrationEvent(key, { kind: 'ask-user', event });
        ensureHydratedAndReplayPendingEvents(event.projectId, event.worktreeId);
      }

      if (unreadToast) {
        showUnreadChatToast(unreadToast);
      }
      if (osQuestionPing) {
        fireChatActivityNotification(osQuestionPing);
      }
    },

    answerMcpQuestion: (requestId, answers): void => {
      void applyAnswer(requestId, answers).then(
        () => {
          scheduleIdleChatUnload();
        },
        () => {
          // IPC failed — leave pending so the user can retry
        },
      );
    },

    answerMcpQuestionAndWait: async (requestId, answers): Promise<void> => {
      // Hydrated/already-answered records resolve as an idempotent success and
      // never re-invoke the provider waiter — this backs duplicate-answer safety
      // after a restart and portal command retries.
      const existing = get().pendingQuestions[requestId];
      if (existing?.answeredAt !== undefined) {
        return;
      }
      // A rejected IPC here propagates, leaving the question actionable. The
      // answered record is committed by main before the IPC resolves, so no
      // renderer-side flush is needed for durability.
      await applyAnswer(requestId, answers);
      scheduleIdleChatUnload();
    },

    dismissMcpQuestion: (requestId): void => {
      void applyDismiss(requestId).then(
        () => {
          scheduleIdleChatUnload();
        },
        () => {
          // IPC failed — leave pending so the user can retry
        },
      );
    },

    dismissMcpQuestionAndWait: async (requestId): Promise<void> => {
      // A missing entry (already dismissed/removed) is an idempotent completed
      // no-op — no provider call, no rejection. An already-answered record is
      // retained on purpose for durable answered projection: a stale/out-of-
      // order dismiss must not erase it, mirroring the answer path's
      // `answeredAt` guard.
      const existing = get().pendingQuestions[requestId];
      if (!existing || existing.answeredAt !== undefined) {
        return;
      }
      // A rejected IPC here propagates, leaving the question actionable. The
      // removal is committed by main before the IPC resolves.
      await applyDismiss(requestId);
      scheduleIdleChatUnload();
    },

    expireMcpQuestion: (requestId): void => {
      set((state) => {
        const pq = state.pendingQuestions[requestId];
        if (!pq) {
          return {};
        }
        const next = { ...state.pendingQuestions };
        delete next[requestId];
        const settled = settleQuestionRaisedUnread(
          state.worktreeChats,
          state.unreadWorktreeKeys,
          pq,
          next,
          false,
        );
        return { pendingQuestions: next, worktreeChats: settled.worktreeChats };
      });
      scheduleIdleChatUnload();
    },
  };
};
