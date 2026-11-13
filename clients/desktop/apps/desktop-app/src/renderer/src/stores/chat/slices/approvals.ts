import {
  canReceiveWorktreeChatActivity,
  isSyntheticChatTarget,
} from '../surface';
import {
  ensureHydratedAndReplayPendingEvents,
  hydratedKeys,
  recordWorktreeChatTouch,
  pendingEagerChatCreation,
} from '../hydration';
import { worktreeKey } from '../utils';
import { pauseOpenTurnTimer, resumePausedTurnTimer } from '../event-transforms';
import type { StateCreator } from 'zustand';
import type {
  ApprovalMode,
  ApprovalRequestEvent,
} from '@canopy/desktop-shared/types';
import type { ChatState, ChatApprovalsSlice } from '../state';
import {
  approvalDefaultCacheKey,
  getApprovalDefaultsGeneration,
} from '../approval-defaults';
import { pendingTabCreation } from '../pending-tab-creation';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import {
  chatBackendFor,
  isCapabilityUnavailable,
  type ChatBackendScope,
} from '../backend';

/**
 * Keeps a still-live card at its current revision after a refused answer,
 * unless it was settled or re-delivered at a newer revision meanwhile.
 */
function refreshedApproval(
  state: ChatState,
  live: ApprovalRequestEvent,
): Partial<ChatState> {
  const current = state.pendingApprovals[live.requestId];
  if (
    !current ||
    (current.policyRevision ?? -1) > (live.policyRevision ?? -1)
  ) {
    return {};
  }
  return {
    pendingApprovals: { ...state.pendingApprovals, [live.requestId]: live },
  };
}

async function liveApprovalEvent(
  scope: ChatBackendScope,
  requestId: string,
): Promise<ApprovalRequestEvent | undefined> {
  try {
    return (await chatBackendFor(scope).approvals.pendingRequests()).find(
      (event) => event.requestId === requestId,
    );
  } catch {
    // The card is removed as before; record that the live check failed.
    reportClientAppError(new Error('Approval pending-request refresh failed'));
    return undefined;
  }
}

interface InFlightApprovalDefaultFetch {
  generation: number;
  forceFresh: boolean;
  promise?: Promise<ApprovalMode>;
}

// De-dupes concurrent `fetchApprovalDefault` callers for the same projectId
// and defaults generation. Invalidating defaults makes an older request stale,
// so the next caller starts a fresh lookup instead of inheriting its fallback.
const inFlightApprovalDefaultFetches = new Map<
  string,
  InFlightApprovalDefaultFetch
>();
const approvalModeTransitions = new Map<string, Promise<void>>();

function approvalModeTransitionKey(
  projectId: string,
  worktreeId: string,
  chatId: string,
): string {
  return `${projectId}/${worktreeId}/${chatId}`;
}

export function pendingApprovalModeTransitions(
  projectId: string,
  worktreeId: string,
  chatId: string,
): Promise<void> | undefined {
  const transitionKey = approvalModeTransitionKey(
    projectId,
    worktreeId,
    chatId,
  );
  const firstTransition = approvalModeTransitions.get(transitionKey);
  if (!firstTransition) return undefined;

  return (async (): Promise<void> => {
    let awaitedTransition: Promise<void> | undefined;
    while (true) {
      const latestTransition = approvalModeTransitions.get(transitionKey);
      if (!latestTransition || latestTransition === awaitedTransition) return;
      awaitedTransition = latestTransition;
      try {
        await latestTransition;
      } catch (error: unknown) {
        const supersedingTransition =
          approvalModeTransitions.get(transitionKey);
        if (
          !supersedingTransition ||
          supersedingTransition === latestTransition
        ) {
          throw error;
        }
      }
    }
  })();
}

function approvalTimerOwnerId(pending: ApprovalRequestEvent): string {
  return pending.timerPauseOwnerId ?? `approval:${pending.requestId}`;
}

// Releases only this approval's timer ownership. Another approval or ask-user
// prompt can continue holding the same timer pause.
function resumeApprovalTurnTimer(
  state: ChatState,
  pending: ApprovalRequestEvent | undefined,
): ChatState['worktreeChats'] {
  if (!pending) return state.worktreeChats;
  const key = `${pending.projectId}/${pending.worktreeId}`;
  const wc = state.worktreeChats[key];
  if (!wc) return state.worktreeChats;

  const resumedAt = Date.now();
  let tabsChanged = false;
  const tabs = wc.tabs.map((tab) => {
    if (tab.id !== pending.chatId) return tab;
    const resumedMessages = resumePausedTurnTimer(
      tab.messages,
      resumedAt,
      approvalTimerOwnerId(pending),
    );
    if (resumedMessages === tab.messages) return tab;
    tabsChanged = true;
    return { ...tab, messages: resumedMessages };
  });
  if (!tabsChanged) return state.worktreeChats;
  return { ...state.worktreeChats, [key]: { ...wc, tabs } };
}

export const createApprovalsSlice: StateCreator<
  ChatState,
  [],
  [],
  ChatApprovalsSlice
> = (set, get) => ({
  pendingApprovals: {},
  approvalDefaultsCache: {},

  handleApprovalRequest: (event): void => {
    if (event.surface === 'non-chat') return;
    const key = `${event.projectId}/${event.worktreeId}`;
    if (!canReceiveWorktreeChatActivity(event.projectId, event.worktreeId)) {
      void chatBackendFor(event)
        .approvals.dismiss({
          requestId: event.requestId,
          projectId: event.projectId,
          worktreeId: event.worktreeId,
          chatId: event.chatId,
        })
        .catch(() => undefined);
      return;
    }

    recordWorktreeChatTouch(key);
    set((state) => {
      const currentWc = state.worktreeChats[key];
      let nextWorktreeChats = state.worktreeChats;

      if (currentWc) {
        const now = Date.now();
        let tabsChanged = false;
        const tabs = currentWc.tabs.map((tab) => {
          if (tab.id !== event.chatId) return tab;
          const pausedMessages = pauseOpenTurnTimer(
            tab.messages,
            now,
            approvalTimerOwnerId(event),
          );
          if (pausedMessages === tab.messages) return tab;
          tabsChanged = true;
          return { ...tab, messages: pausedMessages };
        });
        if (tabsChanged) {
          nextWorktreeChats = {
            ...state.worktreeChats,
            [key]: { ...currentWc, tabs },
          };
        }
      }

      return {
        worktreeChats: nextWorktreeChats,
        pendingApprovals: {
          ...state.pendingApprovals,
          [event.requestId]: event,
        },
      };
    });
    // Like any other live chat activity, a prompt for an unopened worktree
    // hydrates it: the sidebar names the blocked chat from its tab.
    // `hydratedKeys` alone is the right gate. The hydration helper only
    // loads unhydrated keys, and idle unload clears the key together with
    // its `worktreeChats` entry.
    if (
      !hydratedKeys.has(key) &&
      !isSyntheticChatTarget(event.projectId, event.worktreeId)
    ) {
      ensureHydratedAndReplayPendingEvents(event.projectId, event.worktreeId);
    }
  },

  handleApprovalCancelled: (requestId): void => {
    const pending = get().pendingApprovals[requestId];
    if (!pending) {
      return;
    }
    set((state) => {
      const nextPendingApprovals = { ...state.pendingApprovals };
      delete nextPendingApprovals[requestId];
      return {
        pendingApprovals: nextPendingApprovals,
        worktreeChats: resumeApprovalTurnTimer(state, pending),
      };
    });
  },

  handleApprovalAutoResolved: (event): void => {
    // Main already settled the request as approved and committed the
    // transcript record. The renderer's job is only to take the card down,
    // release this approval's hold on the turn timer, and show the block.
    //
    // The pending entry may legitimately be missing (a hydrate or a racing
    // cancel could have dropped it first), so unlike `handleApprovalCancelled`
    // this does not bail on that: the event carries the full chat identity so
    // the resolution message still lands on the right tab.
    const pending = get().pendingApprovals[event.requestId];
    set((state) => {
      const nextPendingApprovals = { ...state.pendingApprovals };
      delete nextPendingApprovals[event.requestId];

      let worktreeChats = resumeApprovalTurnTimer(state, pending);

      const message = event.resolutionMessage;
      if (message) {
        const key = `${event.projectId}/${event.worktreeId}`;
        const wc = worktreeChats[key];
        if (wc) {
          let tabsChanged = false;
          const tabs = wc.tabs.map((tab) => {
            if (tab.id !== event.chatId) return tab;
            // Main mints the message id, so a duplicate delivery or a later
            // hydrate that already carries the block is a no-op.
            if (tab.messages.some((existing) => existing.id === message.id)) {
              return tab;
            }
            tabsChanged = true;
            return { ...tab, messages: [...tab.messages, message] };
          });
          if (tabsChanged) {
            worktreeChats = { ...worktreeChats, [key]: { ...wc, tabs } };
          }
        }
      }

      return { pendingApprovals: nextPendingApprovals, worktreeChats };
    });
    // Deliberately no persistence call of any kind: main committed this block
    // durably before it sent the event, and chat durability is main-owned.
  },

  respondToApproval: async (requestId, decision): Promise<void> => {
    const pending = get().pendingApprovals[requestId];
    if (!pending) {
      return;
    }
    let resolved: boolean;
    try {
      resolved = await chatBackendFor(pending).approvals.respond({
        requestId,
        projectId: pending.projectId,
        worktreeId: pending.worktreeId,
        chatId: pending.chatId,
        decision,
        ...(pending.policyRevision !== undefined
          ? { policyRevision: pending.policyRevision }
          : {}),
      });
    } catch {
      return;
    }
    if (!resolved) {
      const live = await liveApprovalEvent(pending, requestId);
      if (live) {
        set((state) => refreshedApproval(state, live));
        return;
      }
    }
    set((state) => {
      const nextPendingApprovals = { ...state.pendingApprovals };
      delete nextPendingApprovals[requestId];
      return {
        pendingApprovals: nextPendingApprovals,
        worktreeChats: resolved
          ? resumeApprovalTurnTimer(state, pending)
          : state.worktreeChats,
      };
    });
  },

  respondToSecretApproval: async (
    requestId,
    bindingId,
    secret,
  ): Promise<void> => {
    const pending = get().pendingApprovals[requestId];
    if (!pending || pending.secretInput?.bindingId !== bindingId) return;
    let resolved: boolean;
    try {
      resolved = await chatBackendFor(pending).approvals.respondSecretInput({
        requestId,
        projectId: pending.projectId,
        worktreeId: pending.worktreeId,
        chatId: pending.chatId,
        bindingId,
        secret,
        ...(pending.policyRevision !== undefined
          ? { policyRevision: pending.policyRevision }
          : {}),
      });
    } catch {
      // Never send secret-input transport details to telemetry.
      reportClientAppError(new Error('Secret approval response failed'));
      return;
    }
    // A refused response leaves the card for another try or Deny.
    if (!resolved) return;
    set((state) => {
      const nextPendingApprovals = { ...state.pendingApprovals };
      delete nextPendingApprovals[requestId];
      return {
        pendingApprovals: nextPendingApprovals,
        worktreeChats: resumeApprovalTurnTimer(state, pending),
      };
    });
  },

  dismissApproval: async (requestId): Promise<void> => {
    const pending = get().pendingApprovals[requestId];
    if (!pending) {
      return;
    }
    let resolved: boolean;
    try {
      resolved = await chatBackendFor(pending).approvals.dismiss({
        requestId,
        projectId: pending.projectId,
        worktreeId: pending.worktreeId,
        chatId: pending.chatId,
      });
    } catch {
      return;
    }
    if (!resolved) {
      const live = await liveApprovalEvent(pending, requestId);
      if (live) {
        set((state) => refreshedApproval(state, live));
        return;
      }
    }
    set((state) => {
      const nextPendingApprovals = { ...state.pendingApprovals };
      delete nextPendingApprovals[requestId];
      return {
        pendingApprovals: nextPendingApprovals,
        worktreeChats: resolved
          ? resumeApprovalTurnTimer(state, pending)
          : state.worktreeChats,
      };
    });
  },

  handleApprovalRuleAdded: (event): void => {
    const key = `${event.projectId}/${event.worktreeId}`;
    set((state) => {
      const wc = state.worktreeChats[key];
      if (!wc) return state;
      const updatedTabs = wc.tabs.map((tab) =>
        tab.id === event.chatId
          ? tab.sessionApprovalRules?.some(
              (existingRule) => existingRule.id === event.rule.id,
            )
            ? tab
            : {
                ...tab,
                sessionApprovalRules: [
                  ...(tab.sessionApprovalRules ?? []),
                  event.rule,
                ],
              }
          : tab,
      );
      const updated = { ...wc, tabs: updatedTabs };
      return {
        worktreeChats: { ...state.worktreeChats, [key]: updated },
      };
    });
  },

  setTabApprovalMode: async (target, mode): Promise<void> => {
    const sel = target
      ? { projectId: target.projectId, worktreeId: target.worktreeId }
      : get().selectedWorktree;
    if (!sel) return;

    const key = worktreeKey(sel);
    const wc = get().worktreeChats[key];
    if (!wc) return;

    const chatId = target ? target.chatId : wc.activeTabId;
    const tab = wc.tabs.find((t) => t.id === chatId);
    if (!tab) return;
    if (tab.kind === 'file') return;

    const transitionKey = approvalModeTransitionKey(
      sel.projectId,
      sel.worktreeId,
      chatId,
    );
    const previousTransition =
      approvalModeTransitions.get(transitionKey) ?? Promise.resolve();
    const transition = previousTransition
      .catch(() => undefined)
      .then(async (): Promise<void> => {
        const eagerCreation = pendingEagerChatCreation({ ...sel, chatId });
        if (eagerCreation && !(await eagerCreation)) {
          throw new Error('Cannot update a chat that was not created.');
        }
        const pendingCreation = pendingTabCreation(
          sel.projectId,
          sel.worktreeId,
          chatId,
        );
        if (pendingCreation) {
          const disposition = await pendingCreation;
          if (disposition !== 'accepted') {
            throw new Error('Cannot update a chat that was not created.');
          }
        }
        const currentTab = get().worktreeChats[key]?.tabs.find(
          (entry) => entry.id === chatId,
        );
        if (!currentTab || currentTab.kind === 'file') return;
        const previousMode = currentTab.approvalMode;

        const applyRendererMode = (
          nextMode: ApprovalMode | undefined,
        ): void => {
          set((state) => {
            const currentWc = state.worktreeChats[key];
            if (!currentWc) return state;
            const latestTab = currentWc.tabs.find(
              (entry) => entry.id === chatId,
            );
            if (!latestTab || latestTab.kind === 'file') return state;
            const updatedTabs = currentWc.tabs.map((entry) =>
              entry.id === chatId
                ? { ...entry, approvalMode: nextMode }
                : entry,
            );
            const updatedWorktree = { ...currentWc, tabs: updatedTabs };
            return {
              worktreeChats: {
                ...state.worktreeChats,
                [key]: updatedWorktree,
              },
            };
          });
        };

        try {
          await chatBackendFor(sel).approvals.setMode({
            projectId: sel.projectId,
            worktreeId: sel.worktreeId,
            chatId,
            mode,
            ...(previousMode ? { previousMode } : {}),
          });
        } catch (error: unknown) {
          // An authority that serves no approval mode keeps the tab's mode.
          if (isCapabilityUnavailable(error)) return;
          throw error;
        }
        applyRendererMode(mode);
      });
    approvalModeTransitions.set(transitionKey, transition);
    try {
      await transition;
    } finally {
      if (approvalModeTransitions.get(transitionKey) === transition) {
        approvalModeTransitions.delete(transitionKey);
      }
    }
  },

  fetchApprovalDefault: (
    projectId,
    worktreeId,
    options,
  ): Promise<ApprovalMode> => {
    const cacheKey = approvalDefaultCacheKey(projectId, worktreeId);
    const generation = getApprovalDefaultsGeneration();
    const inFlight = inFlightApprovalDefaultFetches.get(cacheKey);
    if (
      options?.forceFresh !== true &&
      (inFlight?.forceFresh || inFlight?.generation === generation) &&
      inFlight.promise
    ) {
      return inFlight.promise;
    }

    const request: InFlightApprovalDefaultFetch = {
      generation,
      forceFresh: options?.forceFresh === true,
    };
    // Publish the request before invoking IPC. A test double or unavailable
    // bridge can throw synchronously, and the catch path must still recognize
    // this as the current request instead of recursively starting fresh work.
    inFlightApprovalDefaultFetches.set(cacheKey, request);

    const fetchPromise = (async (): Promise<ApprovalMode> => {
      try {
        const mode = await chatBackendFor({
          projectId,
        }).approvals.getResolvedDefault({
          projectId,
          ...(worktreeId ? { worktreeId } : {}),
        });
        const currentGeneration = getApprovalDefaultsGeneration();
        const latestRequest = inFlightApprovalDefaultFetches.get(cacheKey);
        if (generation !== currentGeneration || latestRequest !== request) {
          if (
            latestRequest !== request &&
            latestRequest?.forceFresh &&
            latestRequest.promise
          ) {
            return latestRequest.promise;
          }
          if (options?.forceFresh === true) {
            return get().fetchApprovalDefault(projectId, worktreeId, {
              forceFresh: true,
            });
          }
          return get().approvalDefaultsCache[cacheKey] ?? 'ask';
        }
        set((state) => ({
          approvalDefaultsCache: {
            ...state.approvalDefaultsCache,
            [cacheKey]: mode,
          },
        }));
        return mode;
      } catch {
        const currentGeneration = getApprovalDefaultsGeneration();
        const latestRequest = inFlightApprovalDefaultFetches.get(cacheKey);
        if (generation !== currentGeneration || latestRequest !== request) {
          if (
            latestRequest !== request &&
            latestRequest?.forceFresh &&
            latestRequest.promise
          ) {
            return latestRequest.promise;
          }
          if (options?.forceFresh === true) {
            return get().fetchApprovalDefault(projectId, worktreeId, {
              forceFresh: true,
            });
          }
        }
        return get().approvalDefaultsCache[cacheKey] ?? 'ask';
      } finally {
        if (inFlightApprovalDefaultFetches.get(cacheKey) === request) {
          inFlightApprovalDefaultFetches.delete(cacheKey);
        }
      }
    })();

    request.promise = fetchPromise;
    return fetchPromise;
  },
});
