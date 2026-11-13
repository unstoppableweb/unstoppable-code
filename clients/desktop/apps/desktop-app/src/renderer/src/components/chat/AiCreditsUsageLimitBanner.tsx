import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import type {
  AiCreditsRoutingMode,
  NativeAiCreditsAvailability,
} from '@canopy/desktop-shared/types';
import {
  chatBannerKey,
  useAiCreditsBannerStore,
  useAiCreditsRoutingActive,
  useVisibleUsageLimitBanner,
  type ChatBannerTarget,
} from '@/stores/aiCreditsBannerStore';
import {
  CONTACT_ORG_ADMIN_COPY,
  resolveAiCreditsCoverage,
} from '@/lib/openBillingPage';
import {
  AI_CREDITS_PURCHASE_LABEL,
  AI_CREDITS_REOPEN_BILLING_LABEL,
  AiCreditsArrivedNotice,
  UsageLimitNotice,
  NoticeButton,
  usageLimitModelSwitchActionLabel,
  usageLimitModelSwitchFailureDetail,
  usageLimitModelSwitchMessage,
  usageLimitModelSwitchPurchaseMessage,
} from '@canopy/ui-shared/components';
import { formatUsageLimitTimeLabel } from '@/lib/usage-limit-time-label';
import type { CreditsModelRoutability } from '@/lib/chatBillingFramework';
import type { CreditsModelSwitchResult } from '@/lib/creditsModelSwitch';
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

/**
 * Every recovery action is a house `Button`: `secondary` for the alternative
 * and global choices (No, resume at reset; Always) and `primary` for the
 * single recommended action per state (Just this chat, Buy AI Credits, Use AI
 * Credits), so no state ever shows two equally weighted solid actions. The
 * offer leads with the per-chat action and never makes the global opt-in the
 * accent (CAN-5159). The credits-arrival notice has no accent action when the
 * surface cannot route one chat: buying credits from this chat routes this
 * chat where it can, so the only choice left there, Always, stays secondary.
 * A model that can't run on AI Credits gets no credits actions at all; its one
 * accent action is Continue on the credits model (CAN-4900).
 */

/**
 * Scope of each offer action (CAN-5159), read by assistive technology after
 * the short label. The question in the message names the choice, so the
 * labels stay short and no tooltip repeats them.
 */
const USE_CREDITS_NOW_SCOPE =
  "Spends AI Credits in this chat only. Other chats aren't affected.";
const ALWAYS_USE_CREDITS_SCOPE =
  'Spends AI Credits automatically in every chat whenever a usage limit is hit.';

/**
 * Worktree-only "Schedule Resume" affordance. Passed in by surfaces that support
 * scheduled automations; omitted elsewhere so the button is simply not shown.
 */
export interface UsageLimitScheduleResume {
  onSchedule: () => void;
  inFlight: boolean;
  disabled: boolean;
  error: string | null;
  scheduledForLabel: string | null;
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
   * time"). Omit on surfaces without per-session override plumbing — the
   * persistent "Always use credits" action still works everywhere.
   */
  onUseJustThisTime?: () => void;
  /**
   * Surfaces without per-session routing: this chat's own billing choice,
   * the same one the model picker makes. Renders the offer's "Use credits
   * now" when `onUseJustThisTime` is absent, and routes the chat once credits
   * bought from this banner arrive (CAN-5159). Omit when the picker's billing
   * toggle is hidden or locked.
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
   * Picking credits (for example via "Just this chat") shows that card at
   * once, before any turn routes, so the limit notice yields to it instead of
   * offering the credits the user just chose (CAN-4757). Defaults to `false`.
   */
  aiCreditsCardVisible?: boolean;
  /**
   * Sends the interrupted turn again once the user chooses AI Credits from
   * this banner (CAN-4756). Runs after the routing action in the same click,
   * and after Always only once its preference save succeeds. Credits arriving
   * from Buy AI Credits only route and never call it.
   */
  onContinueAfterUsingCredits?: () => void;
  /**
   * Whether the chat's model can bill to AI Credits (CAN-4900). Only
   * `'routable'` offers credits; `'not-routable'` explains the gate and offers
   * the credits model instead; `'unknown'` (cold catalog) offers neither.
   * Required so no surface can show a credits offer the resolver would ignore.
   */
  modelRoutability: CreditsModelRoutability;
  /** The chat's model as the picker names it, for the gated message. */
  modelLabel?: string;
  /**
   * The default credits model as the picker names it. Omit when that model
   * can't run on AI Credits either; the message then asks for another model.
   */
  creditsModelLabel?: string;
  /**
   * Worktree-only: move the chat onto the credits model and route this session
   * through AI Credits. Omit to show the gated message without the button.
   */
  onContinueOnCreditsModel?: () => Promise<CreditsModelSwitchResult>;
}

/**
 * Shared usage-limit banner. Rendered once in the universal `ChatInput`, it
 * surfaces on every chat surface — worktree, standalone, App Advisor, pipeline
 * editor, plan-explore, and any future surface — driven by the target-keyed
 * banner store.
 *
 * The recovery CTA is now driven by native Canopy entitlements (CAN-1235): users
 * with a spendable personal balance (native OR already-linked UD) or an org with
 * spendable headroom get the switch-and-resume affordance; org members with no
 * headroom get a static "contact your org admin" message; fully-uncovered users
 * are pointed at the native pricing page. No UD-linking path is surfaced.
 */
export function AiCreditsUsageLimitBanner({
  target,
  onUseJustThisTime,
  onUseCreditsForThisChat,
  scheduleResume,
  billsToAiCredits,
  aiCreditsCardVisible = false,
  onContinueAfterUsingCredits,
  modelRoutability,
  modelLabel,
  creditsModelLabel,
  onContinueOnCreditsModel,
}: AiCreditsUsageLimitBannerProps): JSX.Element | null {
  const banner = useVisibleUsageLimitBanner(target);
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
  // scope, so the fallback action is not drawn and then swapped for the
  // offer a moment later.
  const [coverageSettled, setCoverageSettled] = useState(false);
  const [routingMode, setRoutingMode] = useState<AiCreditsRoutingMode | null>(
    null,
  );
  const [savingMode, setSavingMode] = useState(false);
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
  const useCreditsNowScopeId = useId();
  const alwaysUseCreditsScopeId = useId();
  // Continue on the credits model (CAN-4900). A result that lands after the
  // banner unmounts, moves to another limit, or sees the model change is
  // stale and ignored. That includes the switch's own model landing: the tab
  // is then on the routable model, so the banner shows that state rather
  // than a failure that no longer describes it.
  const [switchPending, setSwitchPending] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const switchScopeRef = useRef({ cancelled: false });
  const dismissKey = banner?.dismissKey ?? null;
  useEffect(() => {
    const scope = { cancelled: false };
    switchScopeRef.current = scope;
    setSwitchPending(false);
    setSwitchError(null);
    return (): void => {
      scope.cancelled = true;
    };
  }, [modelRoutability, dismissKey]);
  /**
   * Bumped to re-run the availability/preferences read below. Coverage can
   * appear while the banner is open (a purchase completed in the browser), and
   * the banner's own affordances are all derived from that read.
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

  // Effective billing overrides stale live routing after a subscription switch.
  // The composer card also hides the notice before the first credits turn.
  // Billing to credits alone does not hide it: a credits-only account has no
  // card to yield to, so the notice stays (CAN-4757). Keep the store entry so
  // switching back can restore the warning.
  const yieldsToLiveRouting = routingActive && billsCredits;
  const bannerVisible =
    banner !== null && !yieldsToLiveRouting && !aiCreditsCardVisible;

  // Load the consolidated native availability signal + persisted routing mode so
  // the recovery affordances are gated on real state. Runs only while visible.
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
        const [native, prefs] = await Promise.all([
          window.api.loadNativeAiCreditsAvailability(creditsScope),
          window.api.loadPreferences(),
        ]);
        if (cancelled) return;
        setAvailability(native);
        setRoutingMode(prefs.aiCreditsRoutingMode ?? 'off');
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
  // The same per-chat action is the offer's "Just this chat". The two
  // candidates last differently: `onUseJustThisTime` routes the session until
  // the limit resets, while `onUseCreditsForThisChat` is the picker's per-chat
  // billing choice, which stays until the chat switches back (the picker or
  // the card's "Switch to subscription"). Both stay within this chat.
  // A model that can't run on AI Credits never gets a per-chat action, so
  // credits bought here never route a chat the resolver would ignore
  // (CAN-4900); the arrival offers the credits model instead.
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

  if (!target || !banner || !bannerVisible || autoRouting) {
    return null;
  }

  // Mid-purchase the hand-off answers the question; it asks again only if
  // the purchase ends without routing this chat.
  const showOffer =
    creditsRoutable &&
    canSwitchAndResume &&
    routingMode === 'off' &&
    !billsCredits &&
    pendingHandoff === null;
  // The gate (CAN-4900): the message names the model wherever credits would
  // otherwise be offered or sold, and the switch shows wherever this surface
  // can make it. `'unknown'` shows neither.
  const modelNotRoutable = modelRoutability === 'not-routable';
  const switchTargetLabel = onContinueOnCreditsModel
    ? creditsModelLabel
    : undefined;
  const showModelSwitch =
    modelNotRoutable &&
    coverageSettled &&
    canSwitchAndResume &&
    Boolean(modelLabel) &&
    switchTargetLabel !== undefined;
  const gatedModelLabel =
    modelNotRoutable && (canSwitchAndResume || showPricing)
      ? modelLabel
      : undefined;
  // Spending from the confirmation retires it before the action runs, so a
  // failed action cannot bring it back.
  const clearArrival = (): void => {
    clearAiCreditsArrivalForChat(target);
  };
  const withArrivalCleared =
    (action: () => void): (() => void) =>
    (): void => {
      clearArrival();
      action();
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

  // Choosing credits for this chat continues the interrupted turn in the same
  // click, after routing applies (CAN-4756).
  const routeThenContinue =
    (action: () => void): (() => void) =>
    (): void => {
      action();
      onContinueAfterUsingCredits?.();
    };

  // The limit stays recorded on success: the banner yields to the "Using AI
  // Credits" card, and switching back restores the warning (CAN-4759).
  const continueOnCreditsModel = (): void => {
    if (!onContinueOnCreditsModel || switchTargetLabel === undefined) return;
    const scope = switchScopeRef.current;
    setSwitchError(null);
    setSwitchPending(true);
    void (async (): Promise<void> => {
      let result: CreditsModelSwitchResult;
      try {
        result = await onContinueOnCreditsModel();
      } catch {
        result = 'switch-failed';
      }
      if (scope.cancelled) return;
      setSwitchPending(false);
      if (result === 'switch-failed') {
        setSwitchError(
          usageLimitModelSwitchFailureDetail({
            targetModelLabel: switchTargetLabel,
            ...(resetsLabel ? { resetsLabel } : {}),
          }),
        );
      }
    })();
  };

  const enableOnQuota = (): void => {
    clearArrival();
    setSavingMode(true);
    // The chat clicked in, even if this banner moves to another chat while
    // the preference saves.
    const routeChat = perChatAction;
    // Arrival was cleared before saving; a late completion must not retire a
    // newer confirmation for this chat.
    const finish = (): void => {
      setSavingMode(false);
      dismissUsageLimit(target, banner.dismissKey);
    };
    void window.api.savePreferences({ aiCreditsRoutingMode: 'on-quota' }).then(
      () => {
        finish();
        // Only a saved preference continues the chat. Main routes on-quota
        // only once it saw the limit live, which a restored limit was not,
        // so route this chat before the resend.
        routeChat?.();
        onContinueAfterUsingCredits?.();
      },
      () => {
        // Swallow — preference save can fail if userData is unavailable.
        finish();
      },
    );
  };

  // Two inks (design owner, 2026-09-17): the title names the state in a few
  // words and the message that follows it names the choice the buttons
  // decide between, so each label can stay short. The offer states the reset
  // and asks whether to use credits, the purchase state names the credits
  // its button gets (never a plan upgrade, CAN-5160), and the no-headroom org
  // state carries the admin copy because it has no button at all.
  // Once a resume is scheduled the banner says what happens next (design
  // owner, 2026-09-17): the sentence names the scheduled time, the schedule
  // button goes away, and only the actions that would change the outcome
  // (spend credits now) remain to answer the question.
  const scheduledFor = scheduleResume?.scheduledForLabel ?? null;
  const showScheduleResume = Boolean(scheduleResume) && scheduledFor === null;
  // The question about credits always gets a way to say yes. When the offer
  // cannot be shown (coverage unreadable or
  // inconclusive, or routing already set to something other than off), this
  // primary action routes just this chat through credits; main still checks
  // coverage when the turn is sent. It waits for the coverage read to settle
  // so the row does not draw this action and then swap it for the offer.
  const showUseAiCredits =
    creditsRoutable &&
    Boolean(onUseJustThisTime) &&
    coverageSettled &&
    !showOffer &&
    !showPricing &&
    !showContactAdmin &&
    scheduledFor === null;
  const showActionRow =
    showOffer ||
    showContactAdmin ||
    showPricing ||
    showScheduleResume ||
    showUseAiCredits ||
    showModelSwitch;
  const hasActionButton =
    showScheduleResume ||
    showOffer ||
    showPricing ||
    showUseAiCredits ||
    showModelSwitch;
  // A yes/no question about spending credits ends the message whenever a
  // button can say yes, so every label only has to answer it: the resume
  // button becomes the "no" (CAN-5159).
  const asksToUseCredits = showOffer || showUseAiCredits;
  const creditsNoun = arrivalId !== null ? 'your credits' : 'AI Credits';
  const question = scheduledFor
    ? `Do you want to use ${creditsNoun} to keep going now?`
    : resetsLabel
      ? `Do you want to use ${creditsNoun} to keep going?`
      : `Do you want to use ${creditsNoun} until your quota resets?`;
  // Shown only while the purchase CTA is rendered, so it cannot outlive it.
  const visibleHandoff = showPricing ? pendingHandoff : null;
  const handoffCopy =
    visibleHandoff !== null
      ? aiCreditsHandoffCopy(visibleHandoff.feedback)
      : null;

  // The message after the title: the choice or the next step. Mid-purchase
  // the step's title is the notice's own, so only its message follows.
  const continuation = handoffCopy ? (
    <span data-testid="chat-input-usage-limit-handoff">
      {handoffCopy.message}
    </span>
  ) : gatedModelLabel ? (
    <span
      data-testid={
        scheduledFor
          ? 'chat-input-usage-limit-scheduled'
          : 'chat-input-usage-limit-model-not-routable'
      }
    >
      {showPricing
        ? usageLimitModelSwitchPurchaseMessage({
            modelLabel: gatedModelLabel,
            ...(switchTargetLabel
              ? { targetModelLabel: switchTargetLabel }
              : {}),
            ...(resetsLabel ? { resetsLabel } : {}),
            ...(scheduledFor ? { scheduledForLabel: scheduledFor } : {}),
          })
        : usageLimitModelSwitchMessage({
            modelLabel: gatedModelLabel,
            ...(switchTargetLabel
              ? { targetModelLabel: switchTargetLabel }
              : {}),
            ...(resetsLabel ? { resetsLabel } : {}),
            ...(scheduledFor ? { scheduledForLabel: scheduledFor } : {}),
          })}
    </span>
  ) : scheduledFor ? (
    <span data-testid="chat-input-usage-limit-scheduled">
      This chat resumes automatically at {scheduledFor}
      {showOffer
        ? `. ${question}`
        : showPricing
          ? ', or buy AI Credits to keep going now.'
          : '.'}
    </span>
  ) : asksToUseCredits ? (
    resetsLabel ? (
      `Your quota resets around ${resetsLabel}. ${question}`
    ) : (
      question
    )
  ) : showPricing ? (
    `Buy AI Credits to keep going now, or wait for your quota to reset${
      resetsLabel ? ` around ${resetsLabel}` : ''
    }.`
  ) : showContactAdmin ? (
    <span data-testid="chat-input-usage-limit-contact-admin">
      {CONTACT_ORG_ADMIN_COPY}
    </span>
  ) : creditsRoutable ? (
    `Continue on AI Credits or wait for your quota to reset${
      resetsLabel ? ` around ${resetsLabel}` : ''
    }.`
  ) : (
    // No action here can take credits for this model (CAN-4900).
    `Wait for your quota to reset${resetsLabel ? ` around ${resetsLabel}` : ''}.`
  );

  // Post-action feedback only (a failed switch or schedule); never a standing
  // subtitle.
  const detail = switchError ? (
    <div data-testid="chat-input-usage-limit-switch-error">{switchError}</div>
  ) : scheduleResume?.error ? (
    <div>{scheduleResume.error}</div>
  ) : undefined;

  // Actions order alternatives → recommended, left → right, so the single
  // accent action always sits at the far right: the delayed fallback (No,
  // resume at reset) and the global opt-in (Always) stay among the
  // alternatives, and spending credits in this chat (or getting credits) is
  // last (CAN-5159). Answers to the question, a hand-off, and three or more
  // buttons move to their own row, left-aligned with the message, so the
  // copy keeps the full width.
  // Shown for the whole hand-off except after a failed check; disabled until
  // the CTA reports controls for this chat.
  const showReopenBilling =
    visibleHandoff !== null && visibleHandoff.feedback !== 'check-failed';
  const actionCount =
    (showOffer && perChatAction ? 1 : 0) +
    (showOffer ? 1 : 0) +
    (showPricing ? 1 : 0) +
    (showReopenBilling ? 1 : 0) +
    (showScheduleResume ? 1 : 0) +
    (showUseAiCredits ? 1 : 0) +
    (showModelSwitch ? 1 : 0);
  const actionsPlacement =
    asksToUseCredits ||
    showModelSwitch ||
    visibleHandoff !== null ||
    actionCount >= 3
      ? 'below'
      : 'trailing';
  const resumeLabel = `${asksToUseCredits ? 'No, resume' : 'Resume'} at ${
    resetsLabel ?? 'reset'
  }`;
  const actions = hasActionButton ? (
    <span
      data-testid={
        showOffer ? 'chat-input-usage-limit-ai-credits-offer' : undefined
      }
      className="contents"
    >
      {showScheduleResume && scheduleResume && (
        <NoticeButton
          variant="secondary"
          onClick={scheduleResume.onSchedule}
          disabled={scheduleResume.inFlight || scheduleResume.disabled}
          data-testid="chat-input-usage-limit-schedule-resume"
        >
          {resumeLabel}
        </NoticeButton>
      )}
      {/* Scope descriptions sit beside their buttons, not inside them, so
          they never join the accessible name; `sr-only` is absolutely
          positioned and adds no gap to the row. */}
      {showOffer && (
        <>
          <NoticeButton
            variant="secondary"
            onClick={enableOnQuota}
            disabled={savingMode}
            aria-describedby={alwaysUseCreditsScopeId}
            data-testid="chat-input-usage-limit-ai-credits-always-on-quota"
          >
            Always
          </NoticeButton>
          <span id={alwaysUseCreditsScopeId} className="sr-only">
            {ALWAYS_USE_CREDITS_SCOPE}
          </span>
        </>
      )}
      {showOffer && perChatAction && (
        <>
          <NoticeButton
            variant="primary"
            onClick={withArrivalCleared(routeThenContinue(perChatAction))}
            aria-describedby={useCreditsNowScopeId}
            data-testid="chat-input-usage-limit-ai-credits-once"
          >
            Just this chat
          </NoticeButton>
          <span id={useCreditsNowScopeId} className="sr-only">
            {USE_CREDITS_NOW_SCOPE}
          </span>
        </>
      )}
      {showUseAiCredits && onUseJustThisTime && (
        <NoticeButton
          variant="primary"
          onClick={withArrivalCleared(routeThenContinue(onUseJustThisTime))}
          data-testid="chat-input-usage-limit-use-ai-credits"
        >
          Use AI Credits
        </NoticeButton>
      )}
      {showModelSwitch && switchTargetLabel !== undefined && (
        <NoticeButton
          variant="primary"
          onClick={withArrivalCleared(continueOnCreditsModel)}
          busy={switchPending}
          disabled={switchPending}
          data-testid="chat-input-usage-limit-continue-on-credits-model"
        >
          {usageLimitModelSwitchActionLabel(switchTargetLabel)}
        </NoticeButton>
      )}
      {showReopenBilling && (
        <NoticeButton
          variant="secondary"
          onClick={(): void => handoffControls?.onReopenBilling?.()}
          busy={handoffControls?.reopenPending === true}
          disabled={
            handoffControls?.onReopenBilling === undefined ||
            handoffControls.reopenDisabled
          }
          // Keep focus where it was (often the composer), like the CTA.
          onMouseDown={(e): void => e.preventDefault()}
          data-testid="chat-input-usage-limit-reopen-billing"
        >
          {AI_CREDITS_REOPEN_BILLING_LABEL}
        </NoticeButton>
      )}
      {showPricing && (
        <GetAiCreditsCta
          label={AI_CREDITS_PURCHASE_LABEL}
          {...(creditsScope ? { aiCreditsScope: creditsScope } : {})}
          // NOT `enableOnQuota`. That writes the GLOBAL
          // `aiCreditsRoutingMode: 'on-quota'` preference, which only the
          // explicit Always use credits button may do. Buying credits here is
          // consent to spend them in THIS chat (CAN-5159): once the arrival
          // settles, the auto-route above routes this chat and the card
          // confirms it. It never opts the user into automatic credit spend
          // on every future limit, in every chat.
          //
          // Always the browser, even when Settings → Billing could open
          // in-app: the purchase stays tracked in this waiting chat, so the
          // auto-route above fires without a second click. Settings would
          // clear the hand-off and the offer would ask again.
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
      )}
    </span>
  ) : undefined;

  // The same continuation and actions under a positive title once credits
  // bought here are available. Generic until the balance read settles, so
  // the title changes at most once.
  if (arrivalId !== null) {
    return (
      <AiCreditsArrivedNotice
        ref={attachNotice}
        addedCredits={arrivalEvidence?.addedCredits ?? null}
        balanceCredits={arrivalEvidence?.balanceCredits ?? null}
        data-testid="chat-input-usage-limit-banner"
        tabIndex={-1}
        onDismiss={dismiss}
        dismissTestId="chat-input-usage-limit-dismiss"
        {...(detail !== undefined ? { detail } : {})}
        {...(showActionRow ? { actions, actionsPlacement } : {})}
      >
        {continuation}
      </AiCreditsArrivedNotice>
    );
  }

  return (
    <UsageLimitNotice
      provider={banner.provider === 'codex' ? 'codex' : 'claude'}
      // Mid-purchase the step the user is on replaces the limit they already
      // acted on, as on every purchase path (CAN-5160).
      {...(handoffCopy !== null && visibleHandoff !== null
        ? {
            purchaseStep: {
              title: handoffCopy.title,
              failed: visibleHandoff.feedback === 'check-failed',
            },
          }
        : {})}
      ref={attachNotice}
      data-testid="chat-input-usage-limit-banner"
      tabIndex={-1}
      onDismiss={dismiss}
      dismissLabel="Dismiss usage limit notice"
      dismissTestId="chat-input-usage-limit-dismiss"
      {...(detail !== undefined ? { detail } : {})}
      {...(showActionRow ? { actions, actionsPlacement } : {})}
    >
      {continuation}
    </UsageLimitNotice>
  );
}
