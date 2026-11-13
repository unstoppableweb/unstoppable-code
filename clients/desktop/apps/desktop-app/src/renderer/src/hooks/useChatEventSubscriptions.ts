import { useEffect } from 'react';
import { flushSync } from 'react-dom';
import { subscribeToChatEvents } from '@/lib/chatEventFanout';
import { chatStoreRenderView, useChatStore } from '@/stores/chatStore';
import { windowFrameScheduler } from '@/stores/chat/frame-batched-store-view';
import { applyChatStateChangedForRender } from '@/stores/chat/render-cadence';
import {
  chatBannerKey,
  useAiCreditsBannerStore,
} from '@/stores/aiCreditsBannerStore';
import {
  composerRecoveryKey,
  composerRecoveryStore,
} from '@/stores/composerRecoveryStore';
import { useTransientRetryBannerStore } from '@/stores/transientRetryBannerStore';
import { useIngestionLagStore } from '@/stores/ingestionLagStore';
import { invalidateAiCreditsAvailabilityCache } from '@/hooks/useAiCreditsAvailability';
import { invalidateSharedAiCreditsRead } from '@/lib/openBillingPage';
import {
  recordChatEventApplied,
  recordChatStateApplied,
} from '@/lib/renderer-diagnostics/recorder';
import {
  invalidateAiCreditsUsageCache,
  refreshAiCreditsAfterChargedTurn,
} from '@/hooks/useAiCreditsUsage';
import { isRecord } from '@/stores/chat/utils';
import {
  chatBackends,
  localChatBackend,
  subscribeEachChatBackend,
} from '@/stores/chat/backend';
import type {
  ApprovalRequestEvent,
  ApprovalRuleAddedEvent,
  ChatEvent,
  ChatQueueUpdatedEvent,
  ChatSessionImportedEvent,
  ChatStateChangedEvent,
  ClaudeTerminalScheduledPromptEvent,
  DeferredToolsReloadEvent,
  HookChatTabStartedEvent,
  ChatTabDescriptionUpdatedEvent,
  McpAskUserEvent,
  PlanExitRequestEvent,
} from '@canopy/desktop-shared/types';
import {
  INGESTION_LAG_EVENT_TYPE,
  isAiCreditsNoBillingSourceEventData,
  isAiCreditsRoutingStatusEventData,
  isAiCreditsUsageLimitEventData,
  isChatIngestionLagEventData,
  isNoBillingSourceErrorEventData,
  isTransientRetryStateEventData,
} from '@canopy/desktop-shared/types';

/**
 * Bind a no-billing refusal to the composer submission it refused, so the
 * composer can get the prompt back (CAN-5348). The event is already applied,
 * so the transcript's newest user message is the refused turn's.
 */
function recordComposerRecoveryAbort(
  target: {
    projectId: string;
    worktreeId: string;
    chatId: string;
  },
  data: unknown,
): void {
  if (!isRecord(data) || typeof data.canopy_turn_user_message_id !== 'string')
    return;
  // A child refusal must never restore the root composer's inputs.
  if (typeof data.parent_tool_use_id === 'string') return;
  composerRecoveryStore.recordAbort(composerRecoveryKey(target), {
    lastUserMessageId: data.canopy_turn_user_message_id,
    userMessageCount: 0,
  });
}

function hasIngestionLagEventType(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === INGESTION_LAG_EVENT_TYPE
  );
}

export function useChatEventSubscriptions(): void {
  const handleChatEvent = useChatStore((s) => s.handleChatEvent);
  const handleChatStateChanged = useChatStore((s) => s.handleChatStateChanged);
  const handleChatQueueUpdated = useChatStore((s) => s.handleChatQueueUpdated);
  const handleHookTabStarted = useChatStore((s) => s.handleHookTabStarted);
  const handleSessionImported = useChatStore((s) => s.handleSessionImported);
  const handleScheduledTerminalPrompt = useChatStore(
    (s) => s.handleScheduledTerminalPrompt,
  );
  const handleMcpAskUser = useChatStore((s) => s.handleMcpAskUser);
  const handleApprovalRequest = useChatStore((s) => s.handleApprovalRequest);
  const handleApprovalCancelled = useChatStore(
    (s) => s.handleApprovalCancelled,
  );
  const handleApprovalAutoResolved = useChatStore(
    (s) => s.handleApprovalAutoResolved,
  );
  const handleApprovalRuleAdded = useChatStore(
    (s) => s.handleApprovalRuleAdded,
  );
  const handlePlanExitRequest = useChatStore((s) => s.handlePlanExitRequest);
  const verifyStreamingTabs = useChatStore((s) => s.verifyStreamingTabs);
  const handleTabDescriptionUpdated = useChatStore(
    (s) => s.handleTabDescriptionUpdated,
  );
  const handleDeferredToolsReloadEvent = useChatStore(
    (s) => s.handleDeferredToolsReloadEvent,
  );

  // Closing a tab/workspace releases snapshots even when its composer is not
  // mounted. Temporary transcript loading keeps the tab and its recovery.
  useEffect(
    () =>
      useChatStore.subscribe((state, previous) => {
        if (
          state.worktreeChats === previous.worktreeChats &&
          state.pendingEditorSelections === previous.pendingEditorSelections
        )
          return;
        for (const [worktreeKey, previousWorktree] of Object.entries(
          previous.worktreeChats,
        )) {
          const current = state.worktreeChats[worktreeKey];
          if (
            current?.tabs === previousWorktree.tabs &&
            state.pendingEditorSelections === previous.pendingEditorSelections
          )
            continue;
          const currentTabsById = new Map(
            current?.tabs.map(
              (candidate) => [candidate.id, candidate] as const,
            ) ?? [],
          );
          for (const tab of previousWorktree.tabs) {
            const key = `${worktreeKey}/${tab.id}`;
            const recovery = composerRecoveryStore.get(key);
            const currentTab = currentTabsById.get(tab.id);
            if (!currentTab) {
              composerRecoveryStore.forget(key);
              continue;
            }
            // The claim covers our own reservation mutations only. Once it
            // ends, every later user edit must invalidate delayed recovery.
            if (recovery?.claimed) continue;
            const selections = state.pendingEditorSelections[tab.id];
            const previousSelections = previous.pendingEditorSelections[tab.id];
            if (
              (currentTab.pendingAttachments !== tab.pendingAttachments &&
                JSON.stringify(currentTab.pendingAttachments ?? []) !==
                  JSON.stringify(tab.pendingAttachments ?? [])) ||
              currentTab.pendingRevertAttachmentPath !==
                tab.pendingRevertAttachmentPath ||
              (selections !== previousSelections &&
                JSON.stringify(selections ?? []) !==
                  JSON.stringify(previousSelections ?? []))
            ) {
              composerRecoveryStore.noteUserInput(key);
            }
          }
        }
      }),
    [],
  );

  // Revisioned canonical chat-state stream. Registered before any snapshot
  // query this renderer issues (listener-before-query): scopes hydrated via
  // `hydrateChatScopeRevisioned` buffer events received while their snapshot
  // request is pending and apply them in committed revision order.
  //
  // Every event applies to the store on arrival, so all non-React readers see
  // it at once. Streamed content (`isStreamedContentEvent`) reaches React
  // once per animation frame through `chatStoreRenderView`; any other store
  // update, user input, the window hiding, and unsubscribe publish it sooner.
  useEffect(() => {
    const stateBackends = chatBackends().filter(
      (backend) => typeof backend.chat.onStateChanged === 'function',
    );
    if (stateBackends.length === 0) return;
    const scheduler = windowFrameScheduler();
    const flush = (): void => chatStoreRenderView.flush();
    // Input commits pending content before the event reaches React's
    // handlers, so they act on what is current. A dispatched event gets no
    // microtask checkpoint between listeners, so the render is flushed here.
    const flushForInput = (): void => {
      if (!chatStoreRenderView.hasPendingNotification()) return;
      flushSync(flush);
    };
    const flushWhenHidden = (): void => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', flushWhenHidden);
    window.addEventListener('pointerdown', flushForInput, true);
    window.addEventListener('keydown', flushForInput, true);
    const onStateChanged = (event: ChatStateChangedEvent): void => {
      const startedAt = performance.now();
      const state = useChatStore.getState();
      applyChatStateChangedForRender(event, {
        apply: handleChatStateChanged,
        runtimeByChatId: state.runtimeByChatId,
        delegationStreamHints: state.delegationStreamHints,
        view: chatStoreRenderView,
        scheduler,
      });
      recordChatStateApplied(event, startedAt);
    };
    const unsubscribes = stateBackends.map((backend) =>
      backend.chat.onStateChanged(onStateChanged),
    );
    const unsubscribe = (): void => {
      for (const each of unsubscribes) each();
    };
    return (): void => {
      unsubscribe();
      flush();
      document.removeEventListener('visibilitychange', flushWhenHidden);
      window.removeEventListener('pointerdown', flushForInput, true);
      window.removeEventListener('keydown', flushForInput, true);
    };
  }, [handleChatStateChanged]);

  useEffect(() => {
    return subscribeEachChatBackend((backend) =>
      backend.chat.onChatQueueUpdated?.((event: ChatQueueUpdatedEvent) => {
        handleChatQueueUpdated(event);
      }),
    );
  }, [handleChatQueueUpdated]);

  useEffect(() => {
    let active = true;
    // Track the turn that actually used credits, independently of which chat
    // or model happens to be visible when it finishes. A fallback can turn
    // routing off before the terminal event; retain that turn's charge flag.
    const chargedTurns = new Set<string>();
    const retryTargetsUpdatedAfterSnapshotRequest = new Set<string>();
    const unsubscribe = subscribeToChatEvents((event: ChatEvent) => {
      if (hasIngestionLagEventType(event.data)) {
        if (isChatIngestionLagEventData(event.data)) {
          useIngestionLagStore.getState().setLag(
            {
              projectId: event.projectId,
              worktreeId: event.worktreeId,
              chatId: event.chatId,
            },
            event.data.lag,
          );
        }
        return;
      }
      const startedAt = performance.now();
      handleChatEvent(event);
      recordChatEventApplied(event, startedAt);
      // AI Credits routing status + usage-limit signals flow through the same
      // event pipeline for every surface, so feed the shared target-keyed banner
      // store here once — the shared banners then work on any surface (CAN-838).
      const target = {
        projectId: event.projectId,
        worktreeId: event.worktreeId,
        chatId: event.chatId,
      };
      const turnKey = JSON.stringify([
        event.projectId,
        event.worktreeId,
        event.chatId,
      ]);
      const data = event.data;
      if (isRecord(data)) {
        if (data.type === 'canopy_user_prompt') {
          chargedTurns.delete(turnKey);
          // Persistent sessions emit routing at spawn. A later turn inherits
          // that authoritative route until main reports a route change.
          if (
            useAiCreditsBannerStore.getState().routingActiveByChat[
              chatBannerKey(target)
            ]?.active
          ) {
            chargedTurns.add(turnKey);
          }
        }
        if (isAiCreditsRoutingStatusEventData(data) && data.active) {
          chargedTurns.add(turnKey);
        }
        const codex =
          data.type === 'codex' && isRecord(data.event) ? data.event : null;
        const terminal =
          (data.type === 'result' && data.canopy_session_continues !== true) ||
          data.type === 'error' ||
          codex?.type === 'turn.completed' ||
          codex?.type === 'turn.failed' ||
          codex?.type === 'error';
        if (terminal && chargedTurns.delete(turnKey)) {
          refreshAiCreditsAfterChargedTurn();
        }
      }
      // A successful root turn cannot need refusal recovery, including a
      // tool-free completion in a background chat whose composer is unmounted.
      if (
        isRecord(data) &&
        typeof data.canopy_turn_user_message_id === 'string' &&
        typeof data.parent_tool_use_id !== 'string'
      ) {
        const codex = isRecord(data.event) ? data.event : undefined;
        const succeeded =
          (data.type === 'result' &&
            data.is_error !== true &&
            data.canopy_session_continues !== true) ||
          (data.type === 'codex' && codex?.type === 'turn.completed');
        const recovery = composerRecoveryStore.get(composerRecoveryKey(target));
        if (
          succeeded &&
          recovery?.abort === null &&
          recovery.submission.userMessageId === data.canopy_turn_user_message_id
        ) {
          composerRecoveryStore.release(
            composerRecoveryKey(target),
            recovery.generation,
          );
        }
      }
      if (isAiCreditsRoutingStatusEventData(event.data)) {
        useAiCreditsBannerStore
          .getState()
          .setRoutingActive(target, event.data.active);
      } else if (isAiCreditsUsageLimitEventData(event.data)) {
        useAiCreditsBannerStore.getState().setUsageLimit(target, {
          provider: event.data.provider,
          resetsAt: event.data.resetsAt,
        });
        // Credits were just exhausted for this provider — drop all three cached
        // AI Credits reads so they re-fetch immediately instead of showing stale
        // state until the TTL lapses: the availability cache so the model picker
        // re-gates gateway models (CAN-838), and the usage cache so the Usage
        // tile and the sidebar low-balance alert reflect the new balance.
        invalidateAiCreditsAvailabilityCache();
        invalidateAiCreditsUsageCache();
        // ...and the recovery flows' retained answer, which is a THIRD cache.
        // It gates whether the recovery modal auto-commits a model on coverage,
        // so leaving it behind here would let a click after exhaustion commit a
        // model that can no longer run.
        invalidateSharedAiCreditsRead();
      } else if (isAiCreditsNoBillingSourceEventData(event.data)) {
        // A turn reached the hosted gateway and nothing could pay for it
        // (CAN-2413). Distinct from the pre-flight abort below: this one
        // already failed mid-turn, so the composer banner is the only recovery
        // affordance the user gets besides the in-transcript notice.
        useAiCreditsBannerStore.getState().setNoBillingSource(target, {
          provider: event.data.provider,
        });
        // Same reason the usage-limit branch invalidates: the renderer's 60s
        // caches would otherwise keep reporting credits as spendable, which
        // both hides the banner's derived path and leaves gateway models
        // selectable as if the balance were fine.
        invalidateAiCreditsAvailabilityCache();
        invalidateAiCreditsUsageCache();
        // Same third cache as the usage-limit branch: this turn already proved
        // nothing can pay, so a retained "covered" answer must not survive to
        // auto-commit a model in the recovery modal.
        invalidateSharedAiCreditsRead();
        // The composer decides later whether the refused turn did any work.
        recordComposerRecoveryAbort(target, event.data);
      } else if (isNoBillingSourceErrorEventData(event.data)) {
        // The turn was aborted because nothing could pay for it (ECW-9091).
        // `NoBillingSourceBanner` is the visible remedy, but it gates on the
        // renderer's 60s availability cache while the backstop gates on the
        // main process's 30s routing context — so across a credits-exhaustion
        // transition the backstop can fire while the renderer still believes
        // credits are spendable and hides the banner. That would be a fully
        // silent send: no reply, no rendered error (the desktop transcript has
        // no error-string surface), and no usage-limit event to invalidate on,
        // because no provider request was ever made.
        //
        // Dropping all three cached reads closes that window: the banner and the
        // model picker re-gate on the next render instead of waiting out the
        // TTL. This is what makes the `error_code` an actual signal rather than
        // a marker, matching the Ollama precedent it was modeled on.
        invalidateAiCreditsAvailabilityCache();
        invalidateAiCreditsUsageCache();
        // The recovery flows' retained answer is the third; see the
        // usage-limit branch above.
        invalidateSharedAiCreditsRead();
        recordComposerRecoveryAbort(target, event.data);
      } else if (isTransientRetryStateEventData(event.data)) {
        // Transient provider-error retry state flows through the same event
        // pipeline; feed the shared target-keyed store so the retry banner
        // renders on any surface. `active: false` clears it.
        retryTargetsUpdatedAfterSnapshotRequest.add(
          `${target.projectId}/${target.worktreeId}/${target.chatId}`,
        );
        useTransientRetryBannerStore.getState().setState(target, event.data);
      }
    });
    void localChatBackend()
      .chat.getTransientRetrySnapshot()
      .then((entries) => {
        if (!active) return;
        for (const entry of entries) {
          if (
            retryTargetsUpdatedAfterSnapshotRequest.has(
              `${entry.projectId}/${entry.worktreeId}/${entry.chatId}`,
            )
          ) {
            continue;
          }
          useTransientRetryBannerStore.getState().setState(entry, entry.data);
        }
      })
      .catch((): void => {
        // Push events remain authoritative if the initial snapshot is
        // unavailable during renderer startup.
      });
    return (): void => {
      active = false;
      unsubscribe();
    };
  }, [handleChatEvent]);

  useEffect(() => {
    const unsubscribe = localChatBackend().chat.onScheduledTerminalPrompt(
      (event: ClaudeTerminalScheduledPromptEvent) => {
        handleScheduledTerminalPrompt(event);
      },
    );
    return unsubscribe;
  }, [handleScheduledTerminalPrompt]);

  useEffect(() => {
    return localChatBackend().chat.onHookQueueRemoved((event) => {
      useChatStore.getState().handleHookQueueRemoved(event);
    });
  }, []);

  useEffect(() => {
    const unsubscribe = localChatBackend().chat.onHookTabStarted(
      (event: HookChatTabStartedEvent) => {
        handleHookTabStarted(event);
      },
    );
    return unsubscribe;
  }, [handleHookTabStarted]);

  useEffect(() => {
    if (!localChatBackend().chat.onChatSessionImported) return;
    return localChatBackend().chat.onChatSessionImported(
      (event: ChatSessionImportedEvent) => {
        handleSessionImported(event);
      },
    );
  }, [handleSessionImported]);

  useEffect(() => {
    const unsubscribe = localChatBackend().chat.onMcpAskUser(
      (event: McpAskUserEvent) => {
        handleMcpAskUser(event);
      },
    );
    return unsubscribe;
  }, [handleMcpAskUser]);

  useEffect(() => {
    const unsubscribe = localChatBackend().chat.onMcpExpireAskUser((event) => {
      useChatStore.getState().expireMcpQuestion(event.requestId);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    return subscribeEachChatBackend((backend) =>
      backend.approvals.onRequest((event: ApprovalRequestEvent) => {
        handleApprovalRequest(event);
      }),
    );
  }, [handleApprovalRequest]);

  useEffect(() => {
    return subscribeEachChatBackend((backend) =>
      backend.approvals.onCancelled((event) => {
        handleApprovalCancelled(event.requestId);
      }),
    );
  }, [handleApprovalCancelled]);

  useEffect(() => {
    return subscribeEachChatBackend((backend) =>
      backend.approvals.onAutoResolved((event) => {
        handleApprovalAutoResolved(event);
      }),
    );
  }, [handleApprovalAutoResolved]);

  useEffect(() => {
    const unsubscribe = localChatBackend().approvals.onRuleAdded(
      (event: ApprovalRuleAddedEvent) => {
        handleApprovalRuleAdded(event);
      },
    );
    return unsubscribe;
  }, [handleApprovalRuleAdded]);

  useEffect(() => {
    const unsubscribe = localChatBackend().chat.onPlanExitRequest(
      (event: PlanExitRequestEvent) => {
        handlePlanExitRequest(event);
      },
    );
    return unsubscribe;
  }, [handlePlanExitRequest]);

  useEffect(() => {
    return subscribeEachChatBackend((backend) =>
      backend.chat.onTabDescriptionUpdated(
        (event: ChatTabDescriptionUpdatedEvent) => {
          handleTabDescriptionUpdated(
            event.projectId,
            event.worktreeId,
            event.chatId,
            event.description,
          );
        },
      ),
    );
  }, [handleTabDescriptionUpdated]);

  useEffect(() => {
    const unsubscribe = localChatBackend().chat.onDeferredToolsReloadEvent(
      (event: DeferredToolsReloadEvent) => {
        handleDeferredToolsReloadEvent(event);
      },
    );
    return unsubscribe;
  }, [handleDeferredToolsReloadEvent]);

  useEffect(() => {
    const verifyIfVisible = (): void => {
      if (document.visibilityState !== 'visible') {
        return;
      }
      void verifyStreamingTabs();
    };

    const intervalId = window.setInterval(verifyIfVisible, 30_000);
    document.addEventListener('visibilitychange', verifyIfVisible);
    window.addEventListener('focus', verifyIfVisible);

    return (): void => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', verifyIfVisible);
      window.removeEventListener('focus', verifyIfVisible);
    };
  }, [verifyStreamingTabs]);
}
