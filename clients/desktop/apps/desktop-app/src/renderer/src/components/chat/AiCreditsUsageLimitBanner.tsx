import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
} from 'react';
import { isPairedComputerId } from '@canopy/protocol/authority-qualified-id';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import type { NativeAiCreditsAvailability } from '@canopy/desktop-shared/types';
import {
  chatBannerKey,
  useAiCreditsBannerStore,
  useAiCreditsRoutingActive,
  useVisibleUsageLimitBanner,
  type ChatBannerTarget,
} from '@/stores/aiCreditsBannerStore';
import { resolveAiCreditsCoverage } from '@/lib/openBillingPage';
import {
  AI_CREDITS_GUEST_PURCHASE_LABEL,
  AI_CREDITS_PURCHASE_LABEL,
  NoticeButton,
  resumeAtLabel,
  USAGE_LIMIT_RESUME_COPY,
  usageLimitMessage,
} from '@canopy/ui-shared/components';
import { CreditsNotice, type CreditsNoticeOwner } from '@canopy/ui-app/credits';
import { CreditsRowPendingAction } from '@canopy/ui-app/providers';
import { formatUsageLimitTimeLabel } from '@/lib/usage-limit-time-label';
import type { CreditsModelRoutability } from '@/lib/chatBillingFramework';
import {
  GetAiCreditsCta,
  type GetAiCreditsHandoffState,
} from './GetAiCreditsCta';
import { aiCreditsHandoffCopy } from './aiCreditsHandoffCopy';
import {
  useAiCreditsWalletKey,
  useChatTargetAiCreditsScope,
} from '@/lib/aiCreditsScope';
import {
  endAiCreditsHandoff,
  selectAiCreditsHandoff,
  useAiCreditsHandoffStore,
} from '@/stores/aiCreditsHandoffStore';
import {
  clearAiCreditsArrivalForChat,
  markAiCreditsArrivalRouted,
  selectAiCreditsArrivalEvidence,
  selectAiCreditsArrivalForChat,
  useAiCreditsArrivalStore,
} from '@/lib/aiCreditsArrivalConfirmation';
import {
  consumeContinueOnAiCredits,
  peekContinueOnAiCredits,
  subscribeContinueOnAiCredits,
} from '@/lib/usage-limit/continueOnAiCreditsRequest';
import { useIsGuestCredential } from '@/hooks/useIsGuestCredential';
import { trackCreditsRecoveryClick } from '@/lib/creditsRecoveryTelemetry';
import {
  DesktopProviderChoiceDialog,
  useDesktopProviderChoice,
} from './providerChoice/DesktopProviderChoice';
import {
  desktopCreditsBalance,
  type DesktopChoiceRow,
  type DesktopProviderChoiceContext,
} from './providerChoice/providerChoiceFacts';

/**
 * Provider choice (CAN-6860): the notice says when the limit resets and
 * offers two actions, a secondary Resume at {time} and one primary
 * provider-choice control (a Continue menu with "Continue with X" and Choose
 * provider, or "Switch provider"). The purchase is the credits row of the
 * list it opens, and a hand-off started there finishes here: the notice
 * shows the provider choice and Check again, and the row Reopen billing. Credits bought
 * that way route this chat once they land. Automatic credits on every limit
 * is the Models settings page's "When a usage limit is reached" row, never an
 * action here. The banner steps aside while the chat bills another
 * subscription provider, and keeps the limit recorded so switching back
 * shows it again.
 */

/** An organization member whose pool needs its admin. */
const CONTACT_ADMIN_OWNER: CreditsNoticeOwner = {
  kind: 'organization',
  canFund: false,
  creditPool: true,
};
/** Anyone this chat's coverage read lets buy, or who is mid-purchase. */
const BUYER_OWNER: CreditsNoticeOwner = { kind: 'personal' };

/**
 * Worktree-only "Schedule Resume" affordance. Passed in by surfaces that support
 * scheduled automations; omitted elsewhere so the button is simply not shown.
 */
export interface UsageLimitScheduleResume {
  onSchedule: () => void;
  /** Deletes the pending resume, timed or usage check (CAN-7483). */
  onCancel?: () => void;
  inFlight: boolean;
  disabled: boolean;
  error: string | null;
  /** A confirmed outcome to announce, such as a canceled resume. */
  status?: string | null;
  scheduledForLabel: string | null;
  /**
   * The pending resume's kind: `reset` resumes at its time; `check` checks
   * usage then and resumes only once the provider is back.
   */
  pendingKind?: 'reset' | 'check' | null;
  /** A pending check's next time, with its date when not today. */
  checkAtLabel?: string | null;
}

interface AiCreditsUsageLimitBannerProps {
  /**
   * The chat this banner belongs to. Works on every surface because usage-limit
   * signals are keyed by target and fed centrally from the main process
   * (CAN-838). Pass `null` to render nothing.
   */
  target: ChatBannerTarget | null;
  /**
   * Worktree-only: route just this session through AI Credits ("just this
   * time"). Routes the chat once credits bought from this banner arrive, and
   * for the resume dialog's "On AI Credits now". Omit on surfaces without
   * per-session override plumbing.
   */
  onUseJustThisTime?: () => void;
  /**
   * Surfaces without per-session routing: this chat's own billing choice,
   * the same one the model picker makes. Used in place of
   * `onUseJustThisTime` when that is absent, for the same two cases
   * (CAN-5159). Omit when the picker's billing toggle is hidden or locked.
   */
  onUseCreditsForThisChat?: () => void;
  /** Worktree-only "Schedule Resume" support. Omit to hide the button. */
  scheduleResume?: UsageLimitScheduleResume;
  /**
   * Whether the chat's effective billing is AI Credits, from the shared billing
   * resolver. An explicit subscription choice outranks the live routing bit,
   * which can stay true after a finished credits turn (CAN-4759). Omit when the
   * framework is unresolved to fall back to the live routing bit.
   */
  billsToAiCredits?: boolean;
  /**
   * True while the composer shows the "Using AI Credits" card for this chat.
   * Picking credits (for example the credits row of the provider list) shows
   * that card at once, before any turn routes, so the limit notice yields to
   * it instead of offering the credits the user just chose (CAN-4757).
   * Defaults to `false`.
   */
  aiCreditsCardVisible?: boolean;
  /**
   * Sends the interrupted turn again once the resume dialog's "On AI Credits
   * now" request claimed here has routed the chat (CAN-4756, CAN-5013).
   * Credits arriving from a purchase only route and never call it.
   */
  onContinueAfterUsingCredits?: () => void;
  /**
   * Whether the chat's model can bill to AI Credits (CAN-4900). Only
   * `'routable'` lets arriving credits or the resume dialog's request route
   * this chat; `'unknown'` (cold catalog) keeps that request until it settles.
   * Required so no surface can route credits the resolver would ignore.
   */
  modelRoutability: CreditsModelRoutability;
  /**
   * The composer's provider-choice facts and switch handler, set whenever
   * `target` is. `undefined` renders nothing.
   */
  providerChoice: DesktopProviderChoiceContext | undefined;
}

/**
 * Shared usage-limit banner. Rendered once in the universal `ChatInput`, it
 * surfaces on every chat surface — worktree, standalone, App Advisor, pipeline
 * editor, plan-explore, and any future surface — driven by the target-keyed
 * banner store.
 *
 * The native coverage read (CAN-1235) feeds the provider list's credits row:
 * a spendable balance makes it usable, an organization member with no
 * headroom is pointed at the admin, and anyone else can buy credits there.
 */
export function AiCreditsUsageLimitBanner(
  props: AiCreditsUsageLimitBannerProps,
): JSX.Element | null {
  if (props.target !== null && isPairedComputerId(props.target.projectId)) {
    return null;
  }
  return <AiCreditsUsageLimitBannerContent {...props} />;
}

function AiCreditsUsageLimitBannerContent({
  target,
  onUseJustThisTime,
  onUseCreditsForThisChat,
  scheduleResume,
  billsToAiCredits,
  aiCreditsCardVisible = false,
  onContinueAfterUsingCredits,
  modelRoutability,
  providerChoice: providerChoiceContext,
}: AiCreditsUsageLimitBannerProps): JSX.Element | null {
  const banner = useVisibleUsageLimitBanner(target);
  const isGuest = useIsGuestCredential();
  const routingActive = useAiCreditsRoutingActive(target);
  const billsCredits = billsToAiCredits ?? routingActive;
  // Coverage is a question about THIS chat's owner (CAN-3463).
  const creditsScope = useChatTargetAiCreditsScope(target);
  const dismissUsageLimit = useAiCreditsBannerStore((s) => s.dismissUsageLimit);
  // Credits bought from this banner's Get credits (CAN-5160).
  const arrival = useAiCreditsArrivalStore((s) =>
    selectAiCreditsArrivalForChat(s, target, 'usage-limit'),
  );
  const arrivalEvidence = useAiCreditsArrivalStore((s) =>
    selectAiCreditsArrivalEvidence(s, arrival?.handoffId),
  );

  const [availability, setAvailability] =
    useState<NativeAiCreditsAvailability | null>(null);
  // True once the coverage read has answered (or failed) for the current
  // scope, so the credits row does not read as loading and then change a
  // moment later.
  const [coverageSettled, setCoverageSettled] = useState(false);
  // The purchase CTA's controls for the retained hand-off, with the chat they
  // were reported in (CAN-5162, CAN-5534).
  const [handoff, setHandoff] = useState<{
    readonly state: GetAiCreditsHandoffState;
    readonly chatKey: string | null;
  } | null>(null);
  // The browser checkout pending in this chat's purchase scope, from this
  // chat or a sibling (CAN-5534). It outlives this banner, so the message is
  // derived from it rather than from the CTA's report.
  const walletKey = useAiCreditsWalletKey(target);
  const pendingHandoff = useAiCreditsHandoffStore((s) =>
    selectAiCreditsHandoff(s, walletKey),
  );
  const chatKey = target ? chatBannerKey(target) : null;
  const chatKeyRef = useRef(chatKey);
  chatKeyRef.current = chatKey;
  const reportHandoff = useCallback(
    (state: GetAiCreditsHandoffState | null): void => {
      setHandoff(
        state === null ? null : { state, chatKey: chatKeyRef.current },
      );
    },
    [],
  );
  /**
   * Bumped to re-run the availability read below. Coverage can appear while
   * the banner is open (a purchase completed in the browser), and the credits
   * row and the arrival route are derived from that read.
   */
  const [coverageToken, setCoverageToken] = useState(0);
  const refreshCoverage = useCallback((): void => {
    setCoverageSettled(false);
    setAvailability(null);
    setCoverageToken((token) => token + 1);
  }, []);
  useEffect(() => {
    window.addEventListener(
      CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
      refreshCoverage,
    );
    return (): void => {
      window.removeEventListener(
        CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
        refreshCoverage,
      );
    };
  }, [refreshCoverage]);

  const noticeRef = useRef<HTMLDivElement | null>(null);
  const restoreNoticeFocus = useRef(false);
  const attachNotice = useCallback((element: HTMLDivElement | null): void => {
    if (element === null) {
      const previous = noticeRef.current;
      restoreNoticeFocus.current =
        previous !== null &&
        previous.contains(previous.ownerDocument.activeElement);
      // A synchronous notice replacement may restore focus in this commit.
      // Hiding the banner must not reclaim it when the user later returns.
      queueMicrotask((): void => {
        restoreNoticeFocus.current = false;
      });
    } else if (restoreNoticeFocus.current) {
      element.focus();
      restoreNoticeFocus.current = false;
    }
    noticeRef.current = element;
  }, []);

  // A Resume or Cancel click swaps or disables its own button. When that
  // leaves focus nowhere, return it to the notice; if the person moved
  // focus elsewhere meanwhile, leave it there (CAN-7483).
  const resumeActionFocusPending = useRef(false);
  const noteResumeActionFocus = useCallback((): void => {
    const notice = noticeRef.current;
    resumeActionFocusPending.current =
      notice !== null && notice.contains(notice.ownerDocument.activeElement);
  }, []);
  const resumeTransitionKey = `${scheduleResume?.inFlight === true}|${
    scheduleResume?.scheduledForLabel ?? ''
  }|${scheduleResume?.error ?? ''}|${scheduleResume?.status ?? ''}`;
  useEffect(() => {
    if (!resumeActionFocusPending.current) return;
    const notice = noticeRef.current;
    if (notice === null) return;
    const active = notice.ownerDocument.activeElement;
    if (active === null || active === notice.ownerDocument.body) {
      notice.focus();
    }
    if (scheduleResume?.inFlight !== true) {
      resumeActionFocusPending.current = false;
    }
  }, [resumeTransitionKey, scheduleResume?.inFlight]);

  // Effective billing overrides stale live routing after a subscription switch.
  // The composer card also hides the notice before the first credits turn.
  // Billing to credits alone does not hide it: a credits-only account has no
  // card to yield to, so the notice stays (CAN-4757). Keep the store entry so
  // switching back can restore the warning.
  const yieldsToLiveRouting = routingActive && billsCredits;
  // Step aside while the chat bills another subscription provider: the limit
  // is that provider's, not this chat's any more. The store entry stays, so
  // switching back shows it again. Hidden, neither the arrival auto-route
  // nor the resume-dialog claim below acts (both need a visible banner).
  const steppedAside =
    providerChoiceContext !== undefined &&
    banner !== null &&
    (providerChoiceContext.current === 'claude' ||
      providerChoiceContext.current === 'codex') &&
    providerChoiceContext.current !== banner.provider;
  const bannerVisible =
    banner !== null &&
    !yieldsToLiveRouting &&
    !aiCreditsCardVisible &&
    !steppedAside;

  // Load the consolidated native availability signal so the credits row and
  // the arrival route are gated on real state. Runs only while visible.
  // Never let another owner's coverage stand in while this one loads.
  useEffect(() => {
    setAvailability(null);
    setCoverageSettled(false);
  }, [creditsScope]);

  useEffect(() => {
    if (!bannerVisible) {
      return;
    }
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        const native =
          await window.api.loadNativeAiCreditsAvailability(creditsScope);
        if (cancelled) return;
        setAvailability(native);
        setCoverageSettled(true);
      } catch {
        if (!cancelled) {
          setAvailability(null);
          setCoverageSettled(true);
        }
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [bannerVisible, coverageToken, creditsScope]);

  // Short enough to sit on a button: a clock time when the quota resets
  // today, a weekday plus time otherwise.
  const resetsLabel = useMemo(
    (): string | null => formatUsageLimitTimeLabel(banner?.resetsAt),
    [banner?.resetsAt],
  );

  // Shared coverage decision (ECW-9091) so this banner and the
  // no-billing-source banner can never disagree about who may buy credits.
  const {
    canSpendCredits: canSwitchAndResume,
    showContactAdmin,
    showPurchase,
  } = resolveAiCreditsCoverage(availability);
  // The purchase CTA stays mounted while a retained hand-off is pending in
  // this scope. A coverage re-read (an account change on return from the
  // browser) must not drop it: the CTA records the arrival that routes the
  // originating chat (CAN-5159). An organization that now needs its admin
  // hides the purchase here; the record itself stays.
  const showPricing =
    showPurchase || (pendingHandoff !== null && !showContactAdmin);
  // Controls bound to this record and this chat; a report from another chat
  // or an earlier record is ignored until the CTA reports again.
  const handoffControls =
    showPricing &&
    pendingHandoff !== null &&
    handoff !== null &&
    handoff.state.handoffId === pendingHandoff.id &&
    handoff.chatKey === chatKey
      ? handoff.state
      : null;
  // That account change also supersedes the CTA's automatic check, so once
  // this banner's own read finds the credits, the CTA checks again: once per
  // landing, after any check already running. A covered check ends the
  // hand-off, so it is never asked twice.
  const handoffCheckAgain = handoffControls?.onCheckAgain;
  const handoffChecking = handoffControls?.checking === true;
  const creditsLandedMidHandoff =
    handoffControls !== null && coverageSettled && canSwitchAndResume;
  const checkedLandingRef = useRef(false);
  useEffect(() => {
    if (!creditsLandedMidHandoff) {
      checkedLandingRef.current = false;
      return;
    }
    if (checkedLandingRef.current || handoffChecking || !handoffCheckAgain)
      return;
    // A check still running refuses; `checking` reports it, and this asks
    // again once it settles. A check that ran but could not conclude is not
    // repeated: the hand-off stays, and its Check again is the way forward.
    checkedLandingRef.current = handoffCheckAgain();
  }, [creditsLandedMidHandoff, handoffChecking, handoffCheckAgain]);

  // Confirm the arrival only while this chat's coverage is settled and
  // spendable; hiding it otherwise keeps the record for when it is again.
  const arrivalId =
    arrival !== null && coverageSettled && canSwitchAndResume
      ? arrival.handoffId
      : null;
  // Buying credits from this chat's Get credits is consent to spend them in
  // this chat, never in every chat (CAN-5159). Once they arrive the chat is
  // routed through credits and the "Using AI Credits" card confirms the
  // purchase, so the notice never asks again. A chat that already bills to
  // credits only marks the record routed, so it cannot route a later limit.
  // The two candidates last differently: `onUseJustThisTime` routes the session until
  // the limit resets, while `onUseCreditsForThisChat` is the picker's per-chat
  // billing choice, which stays until the chat switches back (the picker or
  // the card's "Switch to subscription"). Both stay within this chat.
  // A model that can't run on AI Credits never gets a per-chat action, so
  // credits bought here never route a chat the resolver would ignore
  // (CAN-4900); the provider list's credits row offers the credits model.
  const creditsRoutable = modelRoutability === 'routable';
  const perChatAction = creditsRoutable
    ? (onUseJustThisTime ?? onUseCreditsForThisChat)
    : undefined;
  const perChatActionRef = useRef(perChatAction);
  perChatActionRef.current = perChatAction;
  const autoRouting =
    bannerVisible &&
    arrivalId !== null &&
    perChatAction !== undefined &&
    !billsCredits;
  const confirmOnly = arrivalId !== null && billsCredits;
  const lastRoutedId = useRef<string | null>(null);
  useEffect(() => {
    if (arrivalId === null || (!autoRouting && !confirmOnly)) return;
    if (lastRoutedId.current === arrivalId) return;
    lastRoutedId.current = arrivalId;
    // Synchronous, so the mark and the routing land in one render.
    markAiCreditsArrivalRouted(arrivalId);
    // Routing only: an arrival never sends the interrupted turn by itself.
    // The "Using AI Credits" card offers Continue for that (CAN-4756).
    if (autoRouting) perChatActionRef.current?.();
  }, [autoRouting, confirmOnly, arrivalId]);

  // The resume dialog's "On AI Credits now" (CAN-5013): the dialog opened
  // this chat and left a request; this banner runs its own credits action and
  // the resend, exactly as a click here would. The first visible banner for
  // the chat claims the request, so a slow coverage read can neither expire it
  // nor let another banner take it. A chat that turns out unable to spend
  // drops it and keeps showing its provider choice.
  const continueRequested = useSyncExternalStore(
    subscribeContinueOnAiCredits,
    () => (target ? peekContinueOnAiCredits(target.chatId) : false),
    () => false,
  );
  const intentBlocked =
    showPricing || showContactAdmin || pendingHandoff !== null;
  const canConsumeIntent =
    bannerVisible &&
    coverageSettled &&
    creditsRoutable &&
    canSwitchAndResume &&
    perChatAction !== undefined &&
    !intentBlocked;
  // An uncatalogued model is still loading, not a model that can't run on
  // credits.
  const intentSettledUnusable =
    bannerVisible &&
    coverageSettled &&
    modelRoutability !== 'unknown' &&
    !canConsumeIntent;
  const targetRef = useRef(target);
  targetRef.current = target;
  const continueAfterUsingCreditsRef = useRef(onContinueAfterUsingCredits);
  continueAfterUsingCreditsRef.current = onContinueAfterUsingCredits;
  // The chat whose request this banner claimed; null when none is held.
  const claimedChatRef = useRef<string | null>(null);
  const targetChatId = target?.chatId ?? null;
  // The scope the coverage values describe. In the commit where it changes,
  // they are still the previous owner's until the reset effect re-renders.
  const coverageScopeRef = useRef(creditsScope);
  useEffect(() => {
    const scopeChanged = coverageScopeRef.current !== creditsScope;
    coverageScopeRef.current = creditsScope;
    if (
      targetChatId !== null &&
      continueRequested &&
      bannerVisible &&
      claimedChatRef.current === null &&
      consumeContinueOnAiCredits(targetChatId)
    ) {
      claimedChatRef.current = targetChatId;
    }
    const claimed = claimedChatRef.current;
    if (claimed === null) return;
    // Each branch drops the claim before any callback, so a throwing
    // callback cannot run it twice.
    if (claimed !== targetChatId) {
      claimedChatRef.current = null;
      return;
    }
    // Arriving credits route first and never resend; once billing follows,
    // the branch below sends the turn exactly once.
    if (autoRouting) return;
    if (billsCredits) {
      claimedChatRef.current = null;
      continueAfterUsingCreditsRef.current?.();
      return;
    }
    // A banner that hides before acting (the limit reset, a dismissal) drops
    // the claim, so a later limit on this mount never spends without a click.
    if (!bannerVisible) {
      claimedChatRef.current = null;
      return;
    }
    if (scopeChanged) return;
    if (canConsumeIntent) {
      claimedChatRef.current = null;
      const current = targetRef.current;
      if (current) clearAiCreditsArrivalForChat(current);
      perChatActionRef.current?.();
      continueAfterUsingCreditsRef.current?.();
      return;
    }
    if (intentSettledUnusable) claimedChatRef.current = null;
    // Otherwise coverage is still loading; keep the claim.
  }, [
    targetChatId,
    creditsScope,
    continueRequested,
    bannerVisible,
    autoRouting,
    billsCredits,
    canConsumeIntent,
    intentSettledUnusable,
  ]);

  const providerChoice = useDesktopProviderChoice({
    context: providerChoiceContext,
    condition: 'quota_limit',
    credits: {
      balance: desktopCreditsBalance({
        settled: coverageSettled,
        canSpend: canSwitchAndResume,
        inconclusive:
          coverageSettled && availability === null && !canSwitchAndResume,
      }),
      viewer: isGuest ? 'guest' : 'signed-in',
      owner: showContactAdmin ? CONTACT_ADMIN_OWNER : BUYER_OWNER,
      pending: showPricing && pendingHandoff !== null,
      pendingFeedback: pendingHandoff?.feedback ?? null,
    },
  });

  if (
    !target ||
    !banner ||
    !bannerVisible ||
    autoRouting ||
    providerChoice === null
  ) {
    return null;
  }

  // Spending from the confirmation retires it before the action runs, so a
  // failed action cannot bring it back.
  const clearArrival = (): void => {
    clearAiCreditsArrivalForChat(target);
  };

  const dismiss = (): void => {
    clearArrival();
    // Only the notice that started the purchase ends it (CAN-5534); a sibling
    // chat's notice dismisses just itself.
    if (
      walletKey !== null &&
      pendingHandoff !== null &&
      pendingHandoff.origin === 'usage-limit' &&
      pendingHandoff.originChatKey === chatBannerKey(target)
    ) {
      endAiCreditsHandoff(
        walletKey,
        pendingHandoff.id,
        pendingHandoff.accountGeneration,
      );
    }
    dismissUsageLimit(target, banner.dismissKey);
  };

  // Once a resume is scheduled the banner says what happens next (design
  // owner, 2026-09-17): the sentence names the scheduled time and the
  // schedule button goes away.
  const scheduledFor = scheduleResume?.scheduledForLabel ?? null;
  const pendingKind =
    scheduledFor === null ? null : (scheduleResume?.pendingKind ?? 'reset');
  const showScheduleResume = Boolean(scheduleResume) && scheduledFor === null;
  const showCancelResume =
    pendingKind !== null && scheduleResume?.onCancel !== undefined;
  const providerName = banner?.provider === 'codex' ? 'Codex' : 'Claude';
  const scheduleFeedback =
    scheduleResume?.error ?? scheduleResume?.status ?? null;
  // Shown only while the purchase CTA is rendered, so it cannot outlive it.
  const visibleHandoff = showPricing ? pendingHandoff : null;
  const handoffCopy =
    visibleHandoff !== null
      ? aiCreditsHandoffCopy(visibleHandoff.feedback)
      : null;

  // The tracked browser hand-off (CAN-5534): the notice shows it for the
  // purchase and, mid-purchase, for Check again.
  const purchaseControl = (
    <GetAiCreditsCta
      label={AI_CREDITS_PURCHASE_LABEL}
      {...(creditsScope ? { aiCreditsScope: creditsScope } : {})}
      // Never writes the GLOBAL `aiCreditsRoutingMode` preference; only the
      // Models settings page's usage-limit row may. Buying credits here is
      // consent to spend them in THIS chat (CAN-5159): once the arrival
      // settles, the auto-route above routes this chat and the card
      // confirms it. It never opts the user into automatic credit spend
      // on every future limit, in every chat.
      //
      // Always the browser, even when Settings → Billing could open
      // in-app: the purchase stays tracked in this waiting chat, so the
      // auto-route above fires without a second click. Settings would
      // clear the hand-off and the notice would ask again.
      //
      // The CTA already fires `announceAiCreditsChanged()` on coverage,
      // which re-reads availability. Re-reading is all this needs to do.
      onCovered={refreshCoverage}
      buttonVariant="primary"
      buttonSize="sm"
      handoffLayout="compact"
      onHandoffChange={reportHandoff}
      billingDestination="browser"
      confirmArrival="usage-limit"
      persistHandoffFor={target}
      dataTestId="chat-input-usage-limit-view-plans"
    />
  );

  // The coverage read feeds the notice's prompt: an organization that needs
  // its admin offers no purchase, and a purchase is offered only when this
  // chat's owner can't spend credits yet, or to finish one in progress.
  const owner = showContactAdmin ? CONTACT_ADMIN_OWNER : BUYER_OWNER;

  const handoffPending =
    visibleHandoff === null
      ? null
      : {
          feedback: visibleHandoff.feedback,
          // Shown for the whole hand-off except after a failed check;
          // disabled until the CTA reports controls for this chat.
          reopenBilling: {
            ...(handoffControls?.onReopenBilling !== undefined
              ? { onReopen: handoffControls.onReopenBilling }
              : {}),
            pending: handoffControls?.reopenPending === true,
            disabled: handoffControls?.reopenDisabled === true,
            testId: 'chat-input-usage-limit-reopen-billing',
          },
        };
  const arrived =
    arrivalId === null
      ? null
      : {
          addedCredits: arrivalEvidence?.addedCredits ?? null,
          balanceCredits: arrivalEvidence?.balanceCredits ?? null,
        };

  // The credits row's purchase: this banner's tracked hand-off, so the
  // arrival auto-route above still routes this chat once credits land.
  // While a hand-off is pending the row offers Reopen billing (Check again
  // after a failed check). Both act on the notice's own tracked hand-off
  // (the `completion` slot): a second tracked CTA here would report on
  // mount, close the list at once, and leave the notice's controls bound to
  // an instance that then unmounts.
  const handoffReopen =
    handoffControls?.reopenDisabled === true
      ? undefined
      : handoffControls?.onReopenBilling;
  const renderCreditsRowAction = (row: DesktopChoiceRow): JSX.Element | null =>
    row.action === 'check-again' ? (
      <CreditsRowPendingAction
        row={row}
        {...(handoffReopen !== undefined
          ? {
              onReopenBilling: (): void => {
                providerChoice.closeDialog();
                handoffReopen();
              },
            }
          : {})}
        reopenPending={handoffControls?.reopenPending === true}
        {...(handoffCheckAgain !== undefined
          ? {
              onCheckAgain: (): void => {
                providerChoice.closeDialog();
                handoffCheckAgain();
              },
            }
          : {})}
        checking={handoffChecking}
      />
    ) : (
      <GetAiCreditsCta
        label={
          row.action === 'sign-in-to-buy'
            ? AI_CREDITS_GUEST_PURCHASE_LABEL
            : AI_CREDITS_PURCHASE_LABEL
        }
        {...(creditsScope ? { aiCreditsScope: creditsScope } : {})}
        onCovered={refreshCoverage}
        buttonVariant="secondary"
        buttonSize="sm"
        handoffLayout="compact"
        onHandoffChange={(next): void => {
          reportHandoff(next);
          if (next !== null) providerChoice.closeDialog();
        }}
        billingDestination="browser"
        confirmArrival="usage-limit"
        persistHandoffFor={target}
        onGetCreditsClick={(): void => {
          trackCreditsRecoveryClick({
            surface: 'chat_banner',
            action:
              row.action === 'sign-in-to-buy'
                ? 'account_sign_in'
                : 'credits_purchase',
            provider: 'credits',
          });
          // See NoBillingSourceBanner: a guest's sign-in closes the list.
          if (row.action === 'sign-in-to-buy') providerChoice.closeDialog();
          else providerChoice.notePurchaseStart();
        }}
        dataTestId="provider-choice-action-credits"
      />
    );
  // The message after the title: the reset, or the next step. Mid-purchase
  // the step's title is the notice's own, so only its message follows.
  const choiceMessage = handoffCopy ? (
    <span data-testid="chat-input-usage-limit-handoff">
      {handoffCopy.message}
    </span>
  ) : pendingKind === 'check' ? (
    <span data-testid="chat-input-usage-limit-scheduled">
      {USAGE_LIMIT_RESUME_COPY.checking(
        scheduleResume?.checkAtLabel ?? scheduledFor ?? '',
        providerName,
      )}
    </span>
  ) : scheduledFor ? (
    <span data-testid="chat-input-usage-limit-scheduled">
      {USAGE_LIMIT_RESUME_COPY.scheduled(scheduledFor)}
    </span>
  ) : scheduleResume && resetsLabel === null ? (
    // Only a host that can wait for usage names the unknown reset; the
    // mirror keeps the generic message.
    USAGE_LIMIT_RESUME_COPY.unknownReset(providerName)
  ) : (
    usageLimitMessage(resetsLabel ?? undefined)
  );
  return (
    <>
      <CreditsNotice
        condition="quota_limit"
        owner={owner}
        placement="composer"
        purchase={{ kind: 'host', mode: 'handoff', control: purchaseControl }}
        providerChoice={providerChoice.notice(
          'chat-input-usage-limit-provider-choice',
        )}
        completion={purchaseControl}
        pending={handoffPending}
        arrived={arrived}
        provider={banner.provider === 'codex' ? 'codex' : 'claude'}
        secondaryAction={
          showCancelResume && scheduleResume?.onCancel ? (
            <NoticeButton
              variant="secondary"
              onClick={(): void => {
                noteResumeActionFocus();
                scheduleResume.onCancel?.();
              }}
              disabled={scheduleResume.inFlight}
              data-testid="chat-input-usage-limit-cancel-resume"
            >
              {USAGE_LIMIT_RESUME_COPY.cancel}
            </NoticeButton>
          ) : showScheduleResume && scheduleResume ? (
            <NoticeButton
              variant="secondary"
              onClick={(): void => {
                noteResumeActionFocus();
                scheduleResume.onSchedule();
              }}
              disabled={scheduleResume.inFlight || scheduleResume.disabled}
              data-testid="chat-input-usage-limit-schedule-resume"
            >
              {resetsLabel !== null
                ? resumeAtLabel(resetsLabel)
                : USAGE_LIMIT_RESUME_COPY.resumeWhenBack(providerName)}
            </NoticeButton>
          ) : undefined
        }
        actionsPlacement={visibleHandoff !== null ? 'below' : 'trailing'}
        ref={attachNotice}
        data-testid="chat-input-usage-limit-banner"
        tabIndex={-1}
        onDismiss={dismiss}
        // The arrival keeps its own dismiss label.
        {...(arrivalId === null
          ? { dismissLabel: 'Dismiss usage limit notice' }
          : {})}
        dismissTestId="chat-input-usage-limit-dismiss"
        // Post-action feedback only (a failed or canceled resume, or why a
        // usage check stopped); never a standing subtitle. It sits in the
        // notice's own polite region.
        {...(scheduleFeedback
          ? {
              detail: (
                <div data-testid="chat-input-usage-limit-resume-feedback">
                  {scheduleFeedback}
                </div>
              ),
            }
          : {})}
      >
        {choiceMessage}
      </CreditsNotice>
      <DesktopProviderChoiceDialog
        choice={providerChoice}
        renderCreditsAction={renderCreditsRowAction}
      />
    </>
  );
}
