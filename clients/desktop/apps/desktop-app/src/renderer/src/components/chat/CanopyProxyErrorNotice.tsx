import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import {
  computeUsageLimitResumePrompt,
  isCurrentFailureNotice,
} from '@canopy/agent-transcript';
import {
  MODEL_LIBRARY_UNLOCK_COPY,
  CanopyProxyErrorPresentation,
  CanopyProxySettingsAction,
  NoticeButton,
  useCanopyProxyErrorCopy,
} from '@canopy/ui-shared/components';
import { copyTextToClipboard } from '@/lib/clipboard';
import {
  CONTACT_ORG_ADMIN_COPY,
  useUnlockModelsAction,
  type UnlockModelsResult,
} from '@/lib/openBillingPage';
import type { AiCreditsScopeRequest } from '@canopy/desktop-shared/types';
import type { ModelLibraryAccess } from '@canopy/protocol/models';
import {
  aiCreditsScopeKey,
  readNavigationScopeKey,
  useChatTargetAiCreditsScope,
  useNavigationScopeKey,
} from '@/lib/aiCreditsScope';
import { useWorkModelLibraryAccess } from '@/hooks/useModelLibraryAccess';
import { useModelLibraryAccessStore } from '@/lib/modelLibraryAccess';
import { useModelUnlockIntentStore } from '@/lib/modelUnlockIntent';
import {
  useChatStore,
  useChatTabRenderState,
  type ChatMessage,
} from '@/stores/chatStore';
import { resolveChat } from './resolve-chat-target';
import { chatBannerKey } from '@/stores/aiCreditsBannerStore';
import {
  useTransientRetryBannerStore,
  useTransientRetryState,
} from '@/stores/transientRetryBannerStore';
import type {
  CanopyProxyError,
  CanopyProxyErrorCode,
} from './chatConnectionErrors';
import {
  openAccountOrganizationPage,
  openCloudAccountSettings,
} from '@/lib/navigation/settings-destinations';

type NoticeAction =
  | 'settings'
  | 'retry'
  | 'copy-id'
  | 'unlock'
  | 'organizations';

/**
 * The notice's recovery action for each refusal. What the notice says comes
 * from the shared app-error catalog (`CanopyProxyErrorPresentation`), so this
 * table holds only the action.
 *
 * Four codes name who pays, because who pays is what failed:
 * `no_billing_source` (the empty balance), `guest_model_not_allowed` (signing
 * in changes who pays), `work_owner_not_member` (the work belongs to an
 * organization the user has left, CAN-3462), and `model_locked` (the model
 * needs a first AI Credit purchase, CAN-4028).
 */
function noticeAction(code: CanopyProxyErrorCode): NoticeAction {
  switch (code) {
    case 'credentials_unavailable':
      return 'settings';
    case 'upstream_unavailable':
      return 'retry';
    case 'invalid_request':
      return 'copy-id';
    case 'no_billing_source':
      // Not rendered here: the transcript shows the shared stop line and the
      // composer's No billing source banner owns the payment choice
      // (CAN-5160). Kept for exhaustiveness.
      return 'copy-id';
    case 'session_budget_exhausted':
      // Buying credits can't raise the limit stamped on this chat, and trying
      // again hits the same 402, so the notice offers neither.
      return 'copy-id';
    case 'guest_model_not_allowed':
      // Trying again sends the same model and hits the same refusal. The
      // account section is where the guest signs in.
      return 'settings';
    case 'model_locked':
      // CAN-4028: the account is signed in and may hold spendable credits that
      // don't unlock advanced models, so this is NOT the `billing` action,
      // whose coverage read would call the problem solved. No Try again: until
      // the purchase lands, it fails the same way.
      return 'unlock';
    case 'proxy_internal_error':
      return 'copy-id';
    case 'work_owner_not_member':
      // CAN-3462: trying again hits the same refusal, so the notice opens the
      // Organizations list, where the user can accept an invitation back.
      return 'organizations';
  }
}

/**
 * Retry re-uses the shared resume-prompt helper on the *complete* transcript.
 *
 * An earlier revision sliced the transcript through the last user message so
 * the original prompt was always re-sent. That is unsafe: a gateway failure can
 * land on a later model call within the same agentic turn, after tool calls
 * already succeeded, and replaying the original prompt would repeat those file
 * edits and external side effects. Passing the full list lets the helper return
 * `Continue` when agent activity exists and re-send the user message only when
 * the turn really was just a prompt that never reached the model.
 */
function computeProxyRetryPrompt(
  messages: ChatMessage[],
): ReturnType<typeof computeUsageLimitResumePrompt> {
  return computeUsageLimitResumePrompt(messages);
}

/**
 * The account and owner scope a local unlock result belongs to (CAN-5951). A
 * checkout opened for one account or chat owner says nothing about another, so
 * a result recorded under one identity is never rendered under the next.
 */
function unlockIdentity(
  accountKey: string | null | undefined,
  scopeKey: string,
  ownerKey: string | undefined,
): string {
  return `${String(accountKey)}\u0000${scopeKey}\u0000${ownerKey ?? ''}`;
}

/**
 * Click-time read of the same account-bound, owner-scoped access that
 * `useWorkModelLibraryAccess` renders. The store can move between a render and
 * the click that render's button receives, so the handler asks again rather
 * than trusting its closure.
 */
function readLiveUnlockState(scope: AiCreditsScopeRequest | undefined): {
  readonly identity: string;
  readonly scopeIdentity: string;
  readonly ownerKey: string | undefined;
  readonly access: ModelLibraryAccess | undefined;
} {
  const scopeKey = aiCreditsScopeKey(scope, readNavigationScopeKey());
  const { accountKey, workAccess } = useModelLibraryAccessStore.getState();
  const read = workAccess?.[scopeKey];
  const ownerKey = read?.accountKey === accountKey ? read?.ownerKey : undefined;
  return {
    identity: unlockIdentity(accountKey, scopeKey, ownerKey),
    scopeIdentity: unlockIdentity(accountKey, scopeKey, undefined),
    ownerKey,
    access:
      scope !== undefined && read?.accountKey === accountKey
        ? read?.access
        : undefined,
  };
}

type LocalUnlockResult = UnlockModelsResult | { readonly outcome: 'opening' };

export interface CanopyProxyErrorNoticeProps {
  error: CanopyProxyError;
  /** Tab this block was rendered from, used to target the retry re-send. */
  originChatTabId?: string;
  /**
   * Raw text of the system message block this notice replaced. Identifies the
   * notice in the transcript so Retry can be disabled once the chat has moved
   * past it, including for bodies truncated before the correlation id.
   */
  sourceText?: string;
}

/**
 * Replaces the raw structured proxy body that would otherwise render as a
 * `role: 'system'` text block. Without this the user sees the JSON we
 * synthesized, which is strictly worse than the opaque 502 it replaced.
 */
export const CanopyProxyErrorNotice = memo(function CanopyProxyErrorNotice({
  error,
  originChatTabId,
  sourceText,
}: CanopyProxyErrorNoticeProps): JSX.Element | null {
  const [copied, setCopied] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const action = noticeAction(error.code);
  const correlationId = error.correlationId;
  // Resolve retry-ability so an unreachable target disables the button instead
  // of silently no-oping on click. Surfaces whose tabs are not registered in
  // `worktreeChats` (App Advisor, plan-explore) land here.
  //
  // Deliberately a one-shot `getState()` read rather than a store subscription:
  // this notice lives in the transcript, so a selector would re-walk every
  // worktree × every tab on each streaming delta of every subsequent turn. The
  // answer only depends on `originChatTabId`, and the tab is by construction
  // already registered whenever this block renders.
  const retryTarget = useMemo(
    () => resolveChat(originChatTabId)?.target ?? null,
    [originChatTabId],
  );
  const canRetry = retryTarget !== null;
  const automaticRetry = useTransientRetryState(retryTarget);

  // Retry dispatches a BILLED, non-idempotent turn, so it must also be gated on
  // the chat actually being idle. `sendMessage` has no streaming guard of its
  // own (`resolveSendMessageTargetTab` aborts only for missing/file/read-only
  // tabs), and `upstream_unavailable` is exactly the classification that makes
  // this chat eligible for `transient-error-retry-service` auto-retry — so
  // without this the user can double-send by clicking while an auto-retry turn
  // is in flight, or after it already succeeded, since this block stays in the
  // transcript with a live button.
  //
  // Unlike `canRetry` this must be reactive, but it stays cheap: the selector
  // indexes the ONE worktree this notice belongs to instead of walking every
  // worktree × tab, and returns a boolean, so a streaming delta on any other
  // chat cannot re-render this block.
  const isStreaming = useChatTabRenderState(retryTarget, ({ tab }) => {
    if (!retryTarget) {
      return false;
    }
    return tab?.status === 'streaming';
  });

  // Retry must only ever act on the chat's CURRENT unresolved failure.
  //
  // Gating on `isStreaming` alone is not enough: this notice lives in the
  // transcript permanently, so once the turn settles — a manual retry finished,
  // or `transient-error-retry-service` recovered the chat on its own — the tab
  // returns to `idle` and this historical button would go live again. Clicking
  // it then dispatches a fresh billed, non-idempotent `Continue` against a
  // failure that was already resolved, which is the same double-charge the
  // streaming gate exists to prevent, just deferred.
  //
  // While this notice is still the last thing in the transcript it is the live
  // failure; the moment anything is appended after it — including the retry's
  // own user message — it becomes history. See `isCurrentFailureNotice` for why
  // identity is the raw source text rather than the correlation id. Same
  // scoping discipline as above: one worktree, one message, one boolean.
  const isLatestFailure = useChatTabRenderState(retryTarget, ({ tab }) => {
    if (!retryTarget) {
      return false;
    }
    const messages = tab?.messages ?? [];
    return isCurrentFailureNotice(messages, sourceText, correlationId);
  });

  // Transcript blocks unmount routinely (tab switch, navigation), so the
  // "Copied" reset timer is tracked and cleared rather than left pending.
  const copiedResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => (): void => {
      if (copiedResetTimer.current !== null) {
        clearTimeout(copiedResetTimer.current);
      }
    },
    [],
  );

  const handleCopyId = useCallback((): void => {
    if (!correlationId) {
      return;
    }
    void (async (): Promise<void> => {
      const ok = await copyTextToClipboard(correlationId);
      if (ok) {
        setCopied(true);
        if (copiedResetTimer.current !== null) {
          clearTimeout(copiedResetTimer.current);
        }
        copiedResetTimer.current = setTimeout(() => {
          copiedResetTimer.current = null;
          setCopied(false);
        }, 2000);
      }
    })();
  }, [correlationId]);

  // ---- `model_locked` (CAN-4028): purchase recovery, not the coverage flow.
  //
  // Scoped to THIS chat's owner, so an organization's work opens the
  // organization's billing (or tells a member who cannot fund it to ask an
  // admin) instead of selling a personal purchase that would not unlock it.
  //
  // CAN-5951: this block lives in the transcript, so a purchase made after it
  // rendered — here, from the composer, or in an earlier session — must still
  // read as resolved after the next turn, a remount, or a relaunch. Only the
  // current account's access for this chat's owner can say so; a later
  // successful turn may have used another model. The unlock branch therefore
  // refreshes and watches that scoped access while mounted (single-flight per
  // scope); every other code leaves the read disabled.
  //
  // Transcript blocks unmount routinely (tab switch, navigation) while the
  // unlock awaits IPC, so its continuation checks this before setting state.
  // Re-armed inside the effect so a double-invoke (StrictMode, `<Activity>`
  // reuse) does not leave it permanently false.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
    };
  }, []);
  const isUnlockBranch = action === 'unlock';
  const unlockScope = useChatTargetAiCreditsScope(retryTarget);
  const unlockModels = useUnlockModelsAction(unlockScope);
  // `undefined` is unknown: no read has landed for this account and owner yet,
  // or this notice has no chat to scope by. Neither resolves it.
  const scopedAccess = useWorkModelLibraryAccess(
    unlockScope,
    isUnlockBranch && unlockScope !== undefined,
  );
  const unlockAccountKey = useModelLibraryAccessStore(
    (state) => state.accountKey,
  );
  const navigationScopeKey = useNavigationScopeKey();
  const unlockScopeKey = aiCreditsScopeKey(unlockScope, navigationScopeKey);
  const unlockOwnerKey = useModelLibraryAccessStore((state) => {
    const read = state.workAccess?.[unlockScopeKey];
    return read?.accountKey === state.accountKey ? read?.ownerKey : undefined;
  });
  const currentScopeIdentity = unlockIdentity(
    unlockAccountKey,
    unlockScopeKey,
    undefined,
  );
  const currentUnlockIdentity = unlockIdentity(
    unlockAccountKey,
    unlockScopeKey,
    unlockOwnerKey,
  );
  // Discard the result when identity changes, including A → B → A. Merely
  // filtering an old result on read would resurrect A's previous success.
  const [localUnlock, setLocalUnlock] = useState<{
    readonly identity: string;
    readonly result: LocalUnlockResult | null;
  }>({ identity: currentUnlockIdentity, result: null });
  if (localUnlock.identity !== currentUnlockIdentity) {
    // Initial owner discovery belongs to the checkout already opening for
    // this account and scope. Keep it disabled until the handoff completes;
    // established-owner changes must still discard the previous result.
    const discoveringOwnerWhileOpening =
      localUnlock.identity === currentScopeIdentity &&
      unlockOwnerKey !== undefined &&
      localUnlock.result?.outcome === 'opening';
    setLocalUnlock({
      identity: currentUnlockIdentity,
      result: discoveringOwnerWhileOpening ? localUnlock.result : null,
    });
  }
  const unlockResult =
    localUnlock.identity === currentUnlockIdentity ? localUnlock.result : null;
  const unlockAttemptRef = useRef(0);
  const mountedScopeIdentity = useRef<string | null>(null);
  const mountedOwnerKey = useRef<string | undefined>(unlockOwnerKey);
  useLayoutEffect(() => {
    mountedScopeIdentity.current = currentScopeIdentity;
    mountedOwnerKey.current = readLiveUnlockState(unlockScope).ownerKey;
    return (): void => {
      // Fence a completion even after an account/scope round trip.
      mountedScopeIdentity.current = null;
      unlockAttemptRef.current += 1;
    };
  }, [currentScopeIdentity, unlockScope]);
  useLayoutEffect(() => {
    // The first owner read can land during checkout's own refresh. Keep that
    // request's feedback; only a change away from an established owner fences
    // the attempt (including an owner round trip).
    if (
      mountedOwnerKey.current !== undefined &&
      mountedOwnerKey.current !== unlockOwnerKey
    ) {
      unlockAttemptRef.current += 1;
    }
    mountedOwnerKey.current = unlockOwnerKey;
  }, [unlockOwnerKey]);
  const canConfirmLocally =
    typeof unlockAccountKey === 'string' &&
    unlockAccountKey.length > 0 &&
    unlockScope !== undefined;
  const unlockRequestId =
    unlockResult?.outcome === 'opened' ? unlockResult.requestId : undefined;
  // Confirmed by the app root's poll for the purchase THIS notice opened.
  // Match the attempt, account and work scope, including while access is
  // unknown. The boolean selector tracks confirmation, not unrelated phases.
  const unlockConfirmed = useModelUnlockIntentStore(
    (state) =>
      unlockRequestId !== undefined &&
      canConfirmLocally &&
      state.intent?.requestId === unlockRequestId &&
      state.intent.accountId === unlockAccountKey &&
      (unlockOwnerKey === undefined || state.intent.owner === unlockOwnerKey) &&
      state.intent.chatId === (retryTarget?.chatId ?? null) &&
      state.intent.scope !== undefined &&
      aiCreditsScopeKey(state.intent.scope, navigationScopeKey) ===
        aiCreditsScopeKey(unlockScope, navigationScopeKey) &&
      (state.phase === 'unlocked' ||
        state.phase === 'applying' ||
        state.phase === 'apply-failed'),
  );
  // Current scoped access decides whenever it is known: `unlocked` resolves
  // the notice, and any explicit locked value outranks an older local success.
  // Only while access is unknown may this mount's own confirmed checkout (or
  // the action's fresh read) resolve it.
  const unlocked =
    isUnlockBranch &&
    (scopedAccess === 'unlocked' ||
      (scopedAccess === undefined &&
        canConfirmLocally &&
        (unlockConfirmed || unlockResult?.outcome === 'unlocked')));
  const handleUnlock = useCallback((): void => {
    // A stale button: the store already unlocked this scope, or moved to
    // another account or owner, before React re-rendered. The subscription
    // renders the right state; opening checkout here would sell a purchase
    // that is already made, or one for the wrong owner.
    const live = readLiveUnlockState(unlockScope);
    if (
      mountedScopeIdentity.current !== currentScopeIdentity ||
      live.scopeIdentity !== currentScopeIdentity ||
      (unlockOwnerKey !== undefined && live.ownerKey !== unlockOwnerKey) ||
      live.access === 'unlocked'
    ) {
      return;
    }
    unlockAttemptRef.current += 1;
    const attempt = unlockAttemptRef.current;
    setLocalUnlock({
      identity: live.identity,
      result: { outcome: 'opening' },
    });
    void (async (): Promise<void> => {
      let result: UnlockModelsResult;
      try {
        // No model to apply: this chat is already on the model that was
        // refused. Unlocking makes the next send work, and that send is the
        // user's to make — nothing is resent from here.
        result = await unlockModels({
          source: 'desktop',
          ...(originChatTabId ? { chatId: originChatTabId } : {}),
        });
      } catch {
        result = { outcome: 'failed' };
      }
      // The block can unmount mid-read, and a newer attempt or another
      // account or owner replaces this one's answer.
      const latest = readLiveUnlockState(unlockScope);
      if (
        !mountedRef.current ||
        mountedScopeIdentity.current !== currentScopeIdentity ||
        attempt !== unlockAttemptRef.current ||
        latest.scopeIdentity !== currentScopeIdentity ||
        (unlockOwnerKey !== undefined && latest.ownerKey !== unlockOwnerKey)
      ) {
        return;
      }
      setLocalUnlock({
        identity: latest.identity,
        result: result.outcome === 'sign-in' ? null : result,
      });
    })();
  }, [
    currentScopeIdentity,
    originChatTabId,
    unlockModels,
    unlockOwnerKey,
    unlockScope,
  ]);

  const handleOpenSettings = useCallback((): void => {
    // The cloud account section, NOT the Codex sign-in modal the harness
    // connection CTA opens: AI Credits auth is the Canopy cloud account.
    openCloudAccountSettings();
  }, []);

  const handleRetry = useCallback((): void => {
    const resolved = resolveChat(originChatTabId);
    if (!resolved) {
      return;
    }
    // Re-check against live state rather than trusting the `disabled` attribute
    // alone: that value is computed at render time, and the auto-retry service
    // can start a turn between that render and this click. Sending here would
    // bill a second non-idempotent turn against a chat that is already running,
    // or against a failure that has already been resolved.
    //
    // BOTH render-time gates are re-checked, not just the streaming one — they
    // guard the same billed dispatch, so an asymmetric guard just moves the
    // race rather than closing it.
    const liveTab = useChatStore
      .getState()
      .worktreeChats[
        `${resolved.target.projectId}/${resolved.target.worktreeId}`
      ]?.tabs.find((tab) => tab.id === resolved.target.chatId);
    const liveRetry =
      useTransientRetryBannerStore.getState().stateByChat[
        chatBannerKey(resolved.target)
      ];
    if (
      liveTab?.status === 'streaming' ||
      (liveRetry && !liveRetry.exhausted)
    ) {
      return;
    }
    if (
      !isCurrentFailureNotice(
        liveTab?.messages ?? [],
        sourceText,
        correlationId,
      )
    ) {
      return;
    }
    setRetrying(true);
    void (async (): Promise<void> => {
      try {
        const prompt = computeProxyRetryPrompt(resolved.messages);
        await useChatStore
          .getState()
          .sendMessage(
            prompt.text,
            prompt.fileReferences,
            resolved.target,
            prompt.inputMode ?? 'typed',
            {
              ...(prompt.attachmentPaths?.length
                ? { attachmentPaths: prompt.attachmentPaths }
                : {}),
              ...(prompt.attachmentPromptContexts?.length
                ? { attachmentPromptContexts: prompt.attachmentPromptContexts }
                : {}),
            },
          );
      } catch {
        // `sendMessage` surfaces its own failure into the transcript. Swallow
        // here so a rejection does not escape as an unhandled renderer promise
        // rejection, which the app-events diagnostics tree records as a
        // renderer console error. `finally` still restores the button.
      } finally {
        setRetrying(false);
      }
    })();
  }, [originChatTabId, sourceText, correlationId]);

  // The unlock branch's outcome line, in the same supporting slot. A resolved
  // notice says so in its title instead, and drops every recovery line.
  const unlockOutcome =
    action === 'unlock' && !unlocked ? unlockResult?.outcome : undefined;
  const unlockStatus =
    unlockOutcome === 'opened' ? (
      <div data-testid="chat-canopy-proxy-error-unlock-waiting">
        {MODEL_LIBRARY_UNLOCK_COPY.waitingInBrowser}
      </div>
    ) : unlockOutcome === 'contact-admin' ? (
      <div data-testid="chat-canopy-proxy-error-unlock-contact-admin">
        {CONTACT_ORG_ADMIN_COPY}
      </div>
    ) : unlockOutcome === 'failed' ? (
      <div data-testid="chat-canopy-proxy-error-unlock-failed">
        {"Couldn't open your browser."}
      </div>
    ) : null;

  const detail = unlockStatus ?? undefined;

  // One recommended action per state: Retry where it is offered, otherwise
  // the action the notice points at (Open settings, the unlock purchase, or
  // Copy details when reporting the id IS the next step). Copy details is the
  // quiet alternative everywhere else.
  const copyIdVariant = action === 'copy-id' ? 'primary' : 'secondary';

  // A resolved notice drops its error id with the failure it described, so
  // Copy details goes too.
  const offersCopyId = Boolean(correlationId) && !unlocked;

  // Never hand the notice an empty actions row (an unlocked notice has
  // nothing left to offer).
  const hasActions =
    offersCopyId ||
    action === 'settings' ||
    action === 'organizations' ||
    (action === 'unlock' && !unlocked) ||
    action === 'retry';

  const actions = hasActions ? (
    <>
      {offersCopyId ? (
        <NoticeButton
          variant={copyIdVariant}
          data-testid="chat-canopy-proxy-error-copy-id"
          onClick={handleCopyId}
        >
          {copied ? 'Copied' : 'Copy details'}
        </NoticeButton>
      ) : null}
      {action === 'settings' ? (
        <CanopyProxySettingsAction onClick={handleOpenSettings} />
      ) : null}
      {action === 'organizations' ? (
        <NoticeButton
          variant="primary"
          data-testid="chat-canopy-proxy-error-view-organizations"
          onClick={(): void => {
            openAccountOrganizationPage({ scope: 'organizations' });
          }}
        >
          View organizations
        </NoticeButton>
      ) : null}
      {action === 'unlock' && !unlocked ? (
        <NoticeButton
          variant="primary"
          data-testid="chat-canopy-proxy-error-unlock"
          onClick={handleUnlock}
          disabled={unlockResult?.outcome === 'opening'}
        >
          {/* The proxy says which remedy applies. A guest signs in first and
              is taken to checkout from there only if still needed. */}
          {error.recovery === 'sign_in'
            ? MODEL_LIBRARY_UNLOCK_COPY.signInAction
            : MODEL_LIBRARY_UNLOCK_COPY.purchaseAction}
        </NoticeButton>
      ) : null}
      {action === 'retry' ? (
        <NoticeButton
          variant="primary"
          data-testid="chat-canopy-proxy-error-retry"
          onClick={handleRetry}
          disabled={retrying || !canRetry || isStreaming || !isLatestFailure}
          {...(!canRetry
            ? { title: 'This chat is no longer open.' }
            : isStreaming
              ? {
                  title: 'This chat is already running. Wait for it to finish.',
                }
              : !isLatestFailure
                ? {
                    title: 'This chat has moved on since this failed.',
                  }
                : {})}
        >
          Try again
        </NoticeButton>
      ) : null}
    </>
  ) : undefined;

  // A failed attempt may still be inside a live automatic retry cycle. Its
  // countdown/cancel banner owns recovery until main ends that cycle.
  const hidden =
    error.code === 'upstream_unavailable' &&
    isLatestFailure &&
    automaticRetry !== null &&
    !automaticRetry.exhausted;
  const copy = useCanopyProxyErrorCopy(error, !hidden);
  if (hidden) return null;

  return (
    <CanopyProxyErrorPresentation
      state={unlocked ? 'resolved' : 'unresolved'}
      announcement="live"
      dataTestId="chat-canopy-proxy-error"
      title={copy.title}
      {...(detail !== undefined ? { detail } : {})}
      {...(actions !== undefined ? { actions } : {})}
    >
      {copy.description}
    </CanopyProxyErrorPresentation>
  );
});
