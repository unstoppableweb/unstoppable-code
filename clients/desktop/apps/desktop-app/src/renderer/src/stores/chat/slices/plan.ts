import { isScopeRevisionedLive } from './revisioned';
import { isPlanProposal } from '@canopy/desktop-shared/plan-review';
import { isCoworkChatTarget } from '@/lib/cowork';
import { worktreeKey } from '../utils';
import {
  applyApprovedTrackedPlanToTab,
  beginPlanDispatch,
  applyDismissedTrackedPlanToTab,
  applyExecutedTrackedPlanToTab,
  applyPlanExitTabReviewState,
  applyPlanExitToTab,
  applyProposalTrackedPlanToTab,
  createTrackedPlanImplementation,
  findPendingPlanExitRequestIdForChat,
  getPendingPlanExitSource,
  getPlanExitTarget,
  hasPendingTrackedPlanReview,
  notifyPlanModeDisabled,
  updateTrackedPlanReview,
  type PlanExitTarget,
} from '../plan-utils';
import { restartClaudeTerminalForSettingsChange } from '../claudeTerminalPrompt';
import { canReceiveWorktreeChatActivity } from '../surface';
import { useGitHubStore } from '../../githubStore';
import {
  recordWorktreeChatTouch,
  scheduleIdleChatUnload,
  pendingEagerChatCreation,
} from '../hydration';
import {
  fireChatActivityNotification,
  getVisibleWorktreeKey,
  showUnreadChatToast,
  type UnreadChatToastOptions,
} from '../notifications';
import { useActivityStore } from '../../activityStore';
import { reconcileExecutedPlan } from '@/lib/plans/reconcile-tracked-plans';
import {
  getActiveWorktreeChatContext,
  updateCapturedChatTab,
} from '../context';
import {
  recordCodeReviewOrigin,
  setCodeReviewChatVisibility,
} from '../code-review-registry';
import {
  type PendingSystemInstruction,
  type TrackedPlanData,
} from '@canopy/desktop-shared/types';
import { type WorktreeChatState } from '../types';
import type { StateCreator } from 'zustand';
import type { ChatState, ChatPlanSlice } from '../state';
import { chatBackendFor, localChatBackend } from '../backend';

const pendingPlanMutationsByStore = new WeakMap<
  () => ChatState,
  Map<string, symbol>
>();

// Retain the canonical identity until projection finishes, including plan-file
// preparation. Revisions arriving meanwhile must update this same plan.
const pendingCursorPlanRequests = new Map<
  string,
  Promise<TrackedPlanData | null>
>();

function commitPlanExitResolution(
  getState: () => ChatState,
  target: Pick<PlanExitTarget, 'projectId' | 'worktreeId' | 'targetChatId'> & {
    expectedPendingPlanExitRequestId?: string;
  },
  keepPlanMode = false,
  reviewStatus?: 'approved' | 'dismissed',
): Promise<boolean> {
  return chatBackendFor(target)
    .chat.command({
      schemaVersion: 1,
      commandId: `renderer-plan-resolution-${crypto.randomUUID()}`,
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      command: {
        type: 'chat.patch_tab_settings',
        tabId: target.targetChatId,
        patch: {
          pendingPlanExit: null,
          pendingPlanExitRequestId: null,
          planMode: keepPlanMode,
          proposalMode: 'optional',
          ...(reviewStatus
            ? {
                trackedPlanReviewStatus: reviewStatus,
                hasOutstandingProposal: false,
              }
            : {}),
        },
        ...(target.expectedPendingPlanExitRequestId
          ? {
              expectedPendingPlanExitRequestId:
                target.expectedPendingPlanExitRequestId,
            }
          : {}),
      },
    })
    .then(async (response) => {
      if (response.outcome === 'applied') return true;
      getState().releaseChatScopeRevisioned(
        target.projectId,
        target.worktreeId,
      );
      await getState().hydrateChatScopeRevisioned(
        target.projectId,
        target.worktreeId,
      );
      return false;
    })
    .catch(async () => {
      getState().releaseChatScopeRevisioned(
        target.projectId,
        target.worktreeId,
      );
      await getState().hydrateChatScopeRevisioned(
        target.projectId,
        target.worktreeId,
      );
      return false;
    });
}

const planApprovalsInFlight = new Map<string, Promise<void>>();

async function approveResolvedPlanExit(
  target: PlanExitTarget,
  get: () => ChatState,
  set: (fn: (state: ChatState) => Partial<ChatState>) => void,
): Promise<void> {
  const source =
    target.pending?.source ??
    target.tab.pendingPlanExit?.source ??
    target.tab.trackedPlanSource ??
    'claude';
  // Cursor cannot consume its proposal until implementation admission is
  // coordinated with the durable review resolution.
  if (source === 'cursor') return;

  // A legacy tab cannot identify the revision the user reviewed. Keep its
  // proposal available and refuse before approving or starting any work.
  if (
    target.tab.trackedPlanId &&
    target.tab.latestRevisionNumber === undefined
  ) {
    useGitHubStore
      .getState()
      .addToast(
        "Couldn't identify the reviewed plan revision. Open the plan to implement it.",
        'error',
      );
    return;
  }

  if (source === 'opencode') {
    const requestId =
      target.pending?.requestId ?? target.tab.pendingPlanExitRequestId;
    const planId = target.tab.trackedPlanId;
    const revisionNumber = target.tab.latestRevisionNumber;
    if (!requestId || !planId || revisionNumber === undefined) return;
    // The canonical send atomically validates this proposal, persists its
    // approval and registers the implementation link before starting
    // implementation. Do not clear it first.
    const implementation = createTrackedPlanImplementation(
      planId,
      revisionNumber,
    );
    const disposition = await get().dispatchChatCommand(
      { projectId: target.projectId, worktreeId: target.worktreeId },
      {
        type: 'chat.send_message',
        chatId: target.targetChatId,
        userMessageId: implementation.userMessageId,
        text: 'Approved. Implement the plan.',
        planReviewApproval: { requestId, planId, revisionNumber },
        trackedPlanImplementation: implementation,
      },
    );
    if (disposition !== 'accepted') return;
    set((state) => {
      const pendingPlanExits = { ...state.pendingPlanExits };
      delete pendingPlanExits[requestId];
      return { pendingPlanExits };
    });
    await reconcileExecutedPlan(
      {
        projectId: target.projectId,
        worktreeId: target.worktreeId,
        chatId: target.targetChatId,
      },
      planId,
    );
    return;
  }
  const proposal = isPlanProposal({
    reviewMode: (target.pending?.toolInput ?? target.tab.pendingPlanExit)
      ?.reviewMode,
    source,
  });
  const applied = await commitPlanExitResolution(
    get,
    {
      ...target,
      expectedPendingPlanExitRequestId:
        target.pending?.requestId ?? target.tab.pendingPlanExitRequestId,
    },
    false,
    target.tab.trackedPlanId ? 'approved' : undefined,
  );
  if (!applied) return;
  // The chat decision is committed. Synchronize the tracked plan alongside
  // the implementation send; a failed sync is reported, never replayed here.
  const reviewSync = updateTrackedPlanReview(target, 'approved');

  set((state) =>
    applyPlanExitTabReviewState(state, target, applyApprovedTrackedPlanToTab),
  );
  scheduleIdleChatUnload();

  const text = proposal ? 'Approved. Implement the plan.' : 'Approved';
  const planId = target.tab.trackedPlanId;
  const revisionNumber = target.tab.latestRevisionNumber;
  const sendUntracked = (): void => {
    void get().sendMessage(text, undefined, {
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      chatId: target.targetChatId,
    });
  };
  if (!planId || revisionNumber === undefined) {
    await reviewSync;
    sendUntracked();
    return;
  }
  // Snapshot the reviewed revision before waiting: main links an
  // implementation only to an approved revision, so the send follows the
  // plan's approval. A failed sync is already reported; keep the approved
  // chat available for recovery without starting an untracked turn.
  const implementation = createTrackedPlanImplementation(
    planId,
    revisionNumber,
  );
  const synced = await reviewSync;
  if (synced === 'update-failed' || synced === 'skipped') {
    return;
  }
  await get().dispatchChatCommand(
    { projectId: target.projectId, worktreeId: target.worktreeId },
    {
      type: 'chat.send_message',
      chatId: target.targetChatId,
      userMessageId: implementation.userMessageId,
      text,
      trackedPlanImplementation: implementation,
    },
  );
}

export const createPlanSlice: StateCreator<ChatState, [], [], ChatPlanSlice> = (
  set,
  get,
) => ({
  pendingPlanExits: {},

  togglePlanMode: (target, onActivated): void => {
    const sel = target
      ? { projectId: target.projectId, worktreeId: target.worktreeId }
      : get().selectedWorktree;
    if (!sel) {
      onActivated?.(false);
      return;
    }
    if (isCoworkChatTarget(sel.projectId)) {
      onActivated?.(false);
      return;
    }

    const key = worktreeKey(sel);
    const wc = get().worktreeChats[key];
    if (!wc) {
      onActivated?.(false);
      return;
    }

    const chatId = target ? target.chatId : wc.activeTabId;
    const tab = wc.tabs.find((t) => t.id === chatId);
    if (!tab) {
      onActivated?.(false);
      return;
    }
    if (tab.kind === 'file') {
      onActivated?.(false);
      return;
    }

    // An acknowledged hint request means enable, including after waiting for
    // eager creation. Another control may already have enabled this target.
    if (onActivated && tab.planMode) {
      onActivated(true);
      return;
    }
    const capturedTarget = { ...sel, chatId };
    const eagerCreation = pendingEagerChatCreation(capturedTarget);
    if (eagerCreation) {
      void eagerCreation.then((ready) => {
        if (ready) get().togglePlanMode(capturedTarget, onActivated);
        else onActivated?.(false);
      });
      return;
    }
    const enabled = !tab.planMode;
    let pendingPlanMutations = pendingPlanMutationsByStore.get(get);
    if (!pendingPlanMutations) {
      pendingPlanMutations = new Map();
      pendingPlanMutationsByStore.set(get, pendingPlanMutations);
    }
    const mutations = pendingPlanMutations;
    const mutationKey = `${key}/${chatId}`;
    const mutation = Symbol();
    mutations.set(mutationKey, mutation);

    if (!enabled && (tab.pendingPlanExit || hasPendingTrackedPlanReview(tab))) {
      const requestId = findPendingPlanExitRequestIdForChat(
        get().pendingPlanExits,
        sel.projectId,
        sel.worktreeId,
        chatId,
      );
      void get().denyPlanExit(requestId ?? '');
    } else {
      set((state) => {
        const currentWc = state.worktreeChats[key];
        if (!currentWc) return state;
        const updatedTabs = currentWc.tabs.map((t) =>
          t.id === chatId ? { ...t, planMode: enabled } : t,
        );
        const updated = { ...currentWc, tabs: updatedTabs };
        return {
          worktreeChats: { ...state.worktreeChats, [key]: updated },
        };
      });
    }

    void chatBackendFor(sel)
      .chat.togglePlanMode({
        projectId: sel.projectId,
        worktreeId: sel.worktreeId,
        chatId,
        enabled,
      })
      .then(
        () => onActivated?.(enabled),
        () => {
          if (onActivated) {
            // Only the hint requests acknowledgement. A failed activation restores
            // that same target; normal plan controls retain their existing behavior.
            set((state) => {
              const current = state.worktreeChats[key];
              if (!current || mutations.get(mutationKey) !== mutation)
                return state;
              return {
                worktreeChats: {
                  ...state.worktreeChats,
                  [key]: {
                    ...current,
                    tabs: current.tabs.map((candidate) =>
                      candidate.id === chatId
                        ? { ...candidate, planMode: tab.planMode }
                        : candidate,
                    ),
                  },
                },
              };
            });
            onActivated(false);
          }
        },
      )
      .finally(() => {
        if (mutations.get(mutationKey) === mutation)
          mutations.delete(mutationKey);
      });
    // A live managed terminal only honors the new permission mode after a
    // relaunch with fresh CLI args.
    void restartClaudeTerminalForSettingsChange(sel, chatId).catch(
      () => undefined,
    );
  },

  handlePlanExitRequest: (event, mode): void => {
    const recovering = mode === 'recover';
    event = {
      ...event,
      toolInput: {
        ...event.toolInput,
        ...(event.source ? { source: event.source } : {}),
        ...(event.reviewMode ? { reviewMode: event.reviewMode } : {}),
      },
    };
    const key = `${event.projectId}/${event.worktreeId}`;
    if (!canReceiveWorktreeChatActivity(event.projectId, event.worktreeId)) {
      return;
    }

    // Canonical deltas own review identity in revisioned scopes. A delayed
    // notification cannot restore a retired request or replace its successor.
    if (isScopeRevisionedLive(get(), event.projectId, event.worktreeId)) {
      const tab = get().worktreeChats[key]?.tabs.find(
        (entry) => entry.id === event.chatId,
      );
      if (
        !tab?.pendingPlanExit ||
        tab.pendingPlanExitRequestId !== event.requestId
      )
        return;
    }

    if (!recovering) recordWorktreeChatTouch(key);
    const source = event.source ?? getPendingPlanExitSource(event.toolInput);
    let unreadToast: UnreadChatToastOptions | null = null;
    let osPlanPing: UnreadChatToastOptions | null = null;

    set((state) => {
      const visibleKey = getVisibleWorktreeKey(state.selectedWorktree);
      const entersUnread =
        !recovering && key !== visibleKey && !state.unreadWorktreeKeys.has(key);
      const nextUnread =
        !recovering && key !== visibleKey
          ? new Set(Array.from(state.unreadWorktreeKeys).concat(key))
          : state.unreadWorktreeKeys;

      // Also persist on the tab so the approval bar survives app restart
      const wc = state.worktreeChats[key];
      let nextChats = state.worktreeChats;
      if (wc) {
        const updatedTabs = wc.tabs.map((t) =>
          t.id === event.chatId
            ? recovering
              ? { ...t, trackedPlanReviewStatus: 'pending' as const }
              : applyPlanExitToTab(t, event)
            : t,
        );
        const updated = { ...wc, tabs: updatedTabs };
        nextChats = { ...state.worktreeChats, [key]: updated };
      }
      const tab = wc?.tabs.find((entry) => entry.id === event.chatId);
      if (entersUnread) {
        unreadToast = {
          projectId: event.projectId,
          worktreeId: event.worktreeId,
          chatId: event.chatId,
          chatTitle: tab?.title,
          reason: 'plan',
        };
      }
      if (!recovering && !entersUnread) {
        osPlanPing = {
          projectId: event.projectId,
          worktreeId: event.worktreeId,
          chatId: event.chatId,
          chatTitle: tab?.title,
          reason: 'plan',
        };
      }

      return {
        pendingPlanExits: {
          ...state.pendingPlanExits,
          [event.requestId]: {
            requestId: event.requestId,
            projectId: event.projectId,
            worktreeId: event.worktreeId,
            chatId: event.chatId,
            source,
            toolInput: event.toolInput,
          },
        },
        unreadWorktreeKeys: nextUnread,
        worktreeChats: nextChats,
      };
    });

    if (unreadToast) {
      showUnreadChatToast(unreadToast);
    }
    if (osPlanPing) {
      fireChatActivityNotification(osPlanPing);
    }

    if (
      (source === 'claude' || source === 'ollama' || source === 'opencode') &&
      event.planId &&
      !isCoworkChatTarget(event.projectId)
    ) {
      void useActivityStore
        .getState()
        .loadTrackedPlans(event.projectId, event.worktreeId);
      return;
    }

    const proposalSource =
      source === 'codex' || source === 'cursor' ? source : undefined;
    if (
      proposalSource &&
      isPlanProposal({
        reviewMode: event.reviewMode ?? event.toolInput.reviewMode,
        source,
      })
    ) {
      const pendingPlanText =
        typeof event.toolInput.plan === 'string'
          ? event.toolInput.plan
          : JSON.stringify(event.toolInput, null, 2);
      const existingTab = get().worktreeChats[key]?.tabs.find(
        (tab) => tab.id === event.chatId,
      );
      const existingPlanId =
        existingTab?.trackedPlanSource === proposalSource &&
        existingTab.trackedPlanReviewStatus !== 'dismissed'
          ? existingTab.trackedPlanId
          : undefined;

      const saveTrackedPlan = (
        planId: string | undefined,
      ): Promise<TrackedPlanData | null> =>
        planId
          ? window.api.activity.plans.update({
              proposalRequestId: event.requestId,
              projectId: event.projectId,
              worktreeId: event.worktreeId,
              planId,
              content: pendingPlanText,
              source: proposalSource,
              reviewStatus: 'pending',
              approvedAt: null,
              dismissedAt: null,
              chatId: event.chatId,
              initiationSource: 'user',
            })
          : window.api.activity.plans.create({
              proposalRequestId: event.requestId,
              projectId: event.projectId,
              worktreeId: event.worktreeId,
              source: proposalSource,
              content: pendingPlanText,
              reviewStatus: 'pending',
              chatId: event.chatId,
              initiationSource: 'user',
            });

      const projectionKey = `${key}/${event.chatId}`;
      const pendingCursorPlan =
        proposalSource === 'cursor'
          ? pendingCursorPlanRequests.get(projectionKey)
          : undefined;
      const trackedPlanRequest = pendingCursorPlan
        ? pendingCursorPlan.then((plan) => {
            if (!plan) throw new Error('Tracked Cursor plan unavailable');
            return saveTrackedPlan(plan.id);
          })
        : saveTrackedPlan(existingPlanId);
      if (proposalSource === 'cursor') {
        pendingCursorPlanRequests.set(projectionKey, trackedPlanRequest);
      }

      void trackedPlanRequest
        .then(async (trackedPlan) => {
          if (!trackedPlan) {
            return;
          }
          const preparedInstruction = await chatBackendFor(event)
            .chat.preparePlanFileSystemInstruction({
              projectId: event.projectId,
              worktreeId: event.worktreeId,
              planId: trackedPlan.id,
            })
            .then((response) => response.instruction)
            .catch(() => undefined);

          const currentTab = get().worktreeChats[key]?.tabs.find(
            (tab) => tab.id === event.chatId,
          );
          if (
            !currentTab ||
            currentTab.pendingPlanExitRequestId !== event.requestId ||
            !isPlanProposal(currentTab.pendingPlanExit) ||
            currentTab.trackedPlanReviewStatus !== 'pending'
          ) {
            return;
          }
          const pendingInstructions = recovering
            ? [...(currentTab.pendingSystemInstructions ?? [])]
            : [];
          if (preparedInstruction) {
            const index = pendingInstructions.findIndex(
              (entry) => entry.id === preparedInstruction.id,
            );
            if (index === -1) pendingInstructions.push(preparedInstruction);
            else pendingInstructions[index] = preparedInstruction;
          }
          const projectedTab = applyProposalTrackedPlanToTab(
            currentTab,
            proposalSource,
            trackedPlan.id,
            trackedPlan.latestRevisionNumber,
            pendingInstructions,
          );
          const persistedTab = recovering
            ? {
                ...projectedTab,
                attentionDismissedAt: currentTab.attentionDismissedAt,
              }
            : projectedTab;
          set((state) => {
            const currentWc = state.worktreeChats[key];
            if (!currentWc) {
              return state;
            }
            const latestTab = currentWc.tabs.find(
              (tab) => tab.id === event.chatId,
            );
            if (
              !latestTab ||
              latestTab.pendingPlanExitRequestId !== event.requestId ||
              !isPlanProposal(latestTab.pendingPlanExit) ||
              latestTab.trackedPlanReviewStatus !== 'pending'
            ) {
              return state;
            }

            const updatedTabs = currentWc.tabs.map((tab) =>
              tab.id === event.chatId ? persistedTab : tab,
            );
            const updated = { ...currentWc, tabs: updatedTabs };
            return {
              worktreeChats: { ...state.worktreeChats, [key]: updated },
            };
          });
          void chatBackendFor(event)
            .chat.command({
              schemaVersion: 1,
              commandId: `renderer-${proposalSource}-plan-${trackedPlan.id}-${trackedPlan.latestRevisionNumber}`,
              projectId: event.projectId,
              worktreeId: event.worktreeId,
              command: {
                type: 'chat.patch_tab_settings',
                tabId: event.chatId,
                expectedPendingPlanExitRequestId: event.requestId,
                patch: {
                  trackedPlanId: persistedTab.trackedPlanId,
                  trackedPlanSource: persistedTab.trackedPlanSource,
                  trackedPlanReviewStatus: persistedTab.trackedPlanReviewStatus,
                  hasOutstandingProposal: persistedTab.hasOutstandingProposal,
                  latestRevisionNumber: persistedTab.latestRevisionNumber,
                  pendingSystemInstructions:
                    persistedTab.pendingSystemInstructions ?? null,
                  ...(!recovering ? { attentionDismissedAt: null } : {}),
                },
              },
            })
            .catch(() => undefined);
          void useActivityStore
            .getState()
            .loadTrackedPlans(event.projectId, event.worktreeId);
        })
        .catch(() => {
          // Keep the committed proposal and its request ID available for recovery.
          // A late failure for an older revision must not replace a newer notice.
          set((state) => {
            const tab = state.worktreeChats[key]?.tabs.find(
              (entry) => entry.id === event.chatId,
            );
            if (tab?.pendingPlanExitRequestId !== event.requestId) return state;
            return {
              chatStateNotices: {
                ...state.chatStateNotices,
                [key]: {
                  kind: 'command_failed',
                  message: 'Could not save this plan. Try again.',
                },
              },
            };
          });
        })
        .finally(() => {
          if (
            pendingCursorPlanRequests.get(projectionKey) === trackedPlanRequest
          ) {
            pendingCursorPlanRequests.delete(projectionKey);
          }
        });
    }
  },

  approvePlanExit: (requestId): Promise<void> => {
    const target = getPlanExitTarget(requestId, get());
    if (!target) return Promise.resolve();
    if (
      !target.pending &&
      !target.tab.pendingPlanExit &&
      !hasPendingTrackedPlanReview(target.tab)
    ) {
      return Promise.resolve();
    }

    // A repeated approval for the same request while one is settling joins it
    // instead of sending the implementation request again.
    const approvalId =
      target.pending?.requestId ??
      target.tab.pendingPlanExitRequestId ??
      `${target.tab.trackedPlanId ?? ''}/${target.tab.latestRevisionNumber ?? ''}`;
    const inFlightKey = `${target.key}/${target.targetChatId}/${approvalId}`;
    const inFlight = planApprovalsInFlight.get(inFlightKey);
    if (inFlight) return inFlight;

    const release =
      target.tab.trackedPlanId && target.tab.latestRevisionNumber !== undefined
        ? beginPlanDispatch({
            projectId: target.projectId,
            worktreeId: target.worktreeId,
            id: target.tab.trackedPlanId,
            latestRevisionNumber: target.tab.latestRevisionNumber,
          })
        : undefined;
    if (
      target.tab.trackedPlanId &&
      target.tab.latestRevisionNumber !== undefined &&
      !release
    )
      return Promise.resolve();

    const approval = approveResolvedPlanExit(target, get, set).finally(() => {
      planApprovalsInFlight.delete(inFlightKey);
      release?.();
    });
    planApprovalsInFlight.set(inFlightKey, approval);
    return approval;
  },

  denyPlanExit: async (requestId): Promise<void> => {
    const target = getPlanExitTarget(requestId, get());
    if (!target) return;

    const applied = await commitPlanExitResolution(
      get,
      {
        ...target,
        expectedPendingPlanExitRequestId:
          target.pending?.requestId ?? target.tab.pendingPlanExitRequestId,
      },
      false,
      target.tab.trackedPlanId ? 'dismissed' : undefined,
    );
    if (!applied) return;

    let reviewSync: Promise<unknown> | undefined;
    if (target.tab.trackedPlanId) {
      reviewSync = updateTrackedPlanReview(target, 'dismissed');
    } else if (requestId) {
      void localChatBackend().chat.denyPlanExit({ requestId });
    }

    set((state) =>
      applyPlanExitTabReviewState(
        state,
        target,
        applyDismissedTrackedPlanToTab,
      ),
    );
    scheduleIdleChatUnload();
    await reviewSync;
  },

  dismissPlanForPipeline: async (requestId): Promise<void> => {
    const target = getPlanExitTarget(requestId, get());
    if (!target) return;

    const applied = await commitPlanExitResolution(
      get,
      {
        ...target,
        expectedPendingPlanExitRequestId:
          target.pending?.requestId ?? target.tab.pendingPlanExitRequestId,
      },
      false,
      target.tab.trackedPlanId ? 'approved' : undefined,
    );
    if (!applied) return;

    // Implicit plan approval is performed authoritatively in the main process
    // (`startPipelineExecutionFromMain`) for every `plan_ready` run, so we no
    // longer emit a duplicate approval here. Refetch that authoritative plan.
    set((state) =>
      applyPlanExitTabReviewState(state, target, applyApprovedTrackedPlanToTab),
    );
    notifyPlanModeDisabled(
      target.projectId,
      target.worktreeId,
      target.targetChatId,
    );
    scheduleIdleChatUnload();
    if (target.tab.trackedPlanId) {
      // The workflow already launched; a failed refresh must not relaunch it.
      await reconcileExecutedPlan(
        {
          projectId: target.projectId,
          worktreeId: target.worktreeId,
          chatId: target.targetChatId,
        },
        target.tab.trackedPlanId,
      );
    }
  },

  markTrackedPlanExecuted: ({ projectId, worktreeId, planId }): void => {
    const key = `${projectId}/${worktreeId}`;
    const currentWc = get().worktreeChats[key];
    if (!currentWc) return;
    const executedTabs = currentWc.tabs.filter(
      (tab) => tab.trackedPlanId === planId,
    );
    if (executedTabs.length === 0) return;

    void (async (): Promise<void> => {
      const results = await Promise.all(
        executedTabs.map(async (tab) => ({
          tab,
          applied: await commitPlanExitResolution(
            get,
            {
              projectId,
              worktreeId,
              targetChatId: tab.id,
              expectedPendingPlanExitRequestId: tab.pendingPlanExitRequestId,
            },
            false,
            'approved',
          ),
        })),
      );
      const appliedChatIds = new Set(
        results.filter(({ applied }) => applied).map(({ tab }) => tab.id),
      );
      if (appliedChatIds.size === 0) return;

      set((state) => {
        const latestWc = state.worktreeChats[key];
        if (!latestWc) return state;
        const updatedTabs = latestWc.tabs.map((tab) =>
          appliedChatIds.has(tab.id) && tab.trackedPlanId === planId
            ? applyExecutedTrackedPlanToTab(tab)
            : tab,
        );
        const nextPending = { ...state.pendingPlanExits };
        for (const [requestId, pending] of Object.entries(nextPending)) {
          if (
            pending.projectId === projectId &&
            pending.worktreeId === worktreeId &&
            appliedChatIds.has(pending.chatId)
          ) {
            delete nextPending[requestId];
          }
        }
        return {
          pendingPlanExits: nextPending,
          worktreeChats: {
            ...state.worktreeChats,
            [key]: { ...latestWc, tabs: updatedTabs },
          },
        };
      });
      for (const { tab } of results) {
        if (appliedChatIds.has(tab.id) && tab.planMode) {
          notifyPlanModeDisabled(projectId, worktreeId, tab.id);
        }
      }
      scheduleIdleChatUnload();
    })();
  },

  dismissRestoredPlanExit: (options): void => {
    const context = getActiveWorktreeChatContext(get());
    if (!context) return;
    const { activeTab: tab } = context;
    if (tab?.trackedPlanId) {
      void get().denyPlanExit('');
      return;
    }

    void (async (): Promise<void> => {
      const applied = await commitPlanExitResolution(
        get,
        {
          projectId: context.selection.projectId,
          worktreeId: context.selection.worktreeId,
          targetChatId: context.chatId,
          expectedPendingPlanExitRequestId: tab?.pendingPlanExitRequestId,
        },
        options?.keepPlanMode === true,
      );
      if (!applied) return;

      set((state) =>
        updateCapturedChatTab(state, context, (t) => ({
          ...t,
          pendingPlanExit: undefined,
          pendingPlanExitRequestId: undefined,
          planMode: options?.keepPlanMode === true ? t.planMode : false,
        })),
      );
      scheduleIdleChatUnload();
    })();
  },

  setCodeReviewChatVisible: (scopeKey, visible): void => {
    setCodeReviewChatVisibility(scopeKey, visible);
  },

  registerCodeReviewOrigin: (scopeKey, projectId, worktreeId): void => {
    recordCodeReviewOrigin(scopeKey, { projectId, worktreeId });
  },

  queuePlanImportInstruction: (chatId, sourceFilePath): void => {
    const instruction: PendingSystemInstruction = {
      id: `plan-import-${sourceFilePath}-${Date.now()}`,
      text: `The user imported the plan document at ${sourceFilePath} as a tracked plan. Reference this plan when continuing.`,
    };
    const durableTargets: Array<{
      projectId: string;
      worktreeId: string;
      pendingSystemInstructions: PendingSystemInstruction[];
    }> = [];
    set((state) => {
      const nextChats: Record<string, WorktreeChatState> = {};
      let changed = false;
      for (const [key, wc] of Object.entries(state.worktreeChats)) {
        const tabIndex = wc.tabs.findIndex((t) => t.id === chatId);
        if (tabIndex < 0) {
          nextChats[key] = wc;
          continue;
        }
        const updatedTabs = wc.tabs.map((tab) =>
          tab.id === chatId
            ? {
                ...tab,
                pendingSystemInstructions: [
                  ...(tab.pendingSystemInstructions ?? []),
                  instruction,
                ],
              }
            : tab,
        );
        const updatedTab = updatedTabs.find((tab) => tab.id === chatId);
        if (updatedTab) {
          const separator = key.indexOf('/');
          durableTargets.push({
            projectId: key.slice(0, separator),
            worktreeId: key.slice(separator + 1),
            pendingSystemInstructions: updatedTab.pendingSystemInstructions ?? [
              instruction,
            ],
          });
        }
        nextChats[key] = { ...wc, tabs: updatedTabs };
        changed = true;
      }
      if (!changed) {
        return state;
      }
      return { worktreeChats: { ...state.worktreeChats, ...nextChats } };
    });
    for (const target of durableTargets) {
      void chatBackendFor(target)
        .chat.command({
          schemaVersion: 1,
          commandId: `renderer-${crypto.randomUUID()}`,
          projectId: target.projectId,
          worktreeId: target.worktreeId,
          command: {
            type: 'chat.patch_tab_settings',
            tabId: chatId,
            patch: {
              pendingSystemInstructions: target.pendingSystemInstructions,
            },
          },
        })
        .catch(() => undefined);
    }
  },
});
