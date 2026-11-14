import {
  useEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from 'react';
import { getModelCatalogProviderLabel } from '@canopy/ui-shared';
import { CoinsIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  aiCreditsArrivalTitle,
  Notice,
  NoticeButton,
} from '@canopy/ui-shared/components';
import { subscriptionUsageLimits } from '@canopy/desktop-shared/lib/subscription-usage';
import { resolveAiCreditsFundingSource } from '@canopy/desktop-shared/lib/ai-credits-funding';
import type {
  AgentUsageOverview,
  NativeAccountProvider,
} from '@canopy/desktop-shared/types';
import { useChatTargetAiCreditsScope } from '@/lib/aiCreditsScope';
import { formatCredits } from '@/lib/ai-credits-format';
import { useAiCreditsUsage } from '@/hooks/useAiCreditsUsage';
import { useComposerWorkIsPersonal } from '@/hooks/useComposerAiCreditsBalance';
import {
  clearAiCreditsArrival,
  selectAiCreditsArrivalEvidence,
  selectRoutedAiCreditsArrivalForChat,
  useAiCreditsArrivalStore,
} from '@/lib/aiCreditsArrivalConfirmation';
import { selectProviderUsageLimitResumeAt } from '@/lib/claudeUsageLimitResume';
import { scheduleAt } from '@/lib/scheduleAt';
import { formatUsageLimitTimeLabel } from '@/lib/usage-limit-time-label';
import {
  chatBannerKey,
  useNoBillingSourceSignal,
  type NoBillingSourceSignal,
  type ChatBannerTarget,
} from '@/stores/aiCreditsBannerStore';
import { useObservabilityStore } from '@/stores/observabilityStore';

interface AiCreditsRoutingStatusBannerProps {
  /**
   * The chat this banner belongs to. Works for every surface — worktree,
   * standalone (cowork), App Advisor, pipeline editor, plan-explore — because
   * routing status is keyed by target and fed centrally from the main process
   * (CAN-838). Pass `null` to render nothing.
   */
  target: ChatBannerTarget | null;
  /**
   * Whether this banner should render. Computed once in `ChatInput` by the
   * shared billing resolver (`aiCreditsBannerVisible`) so the banner and the
   * model picker's toggle can never disagree, and so the banner stays visible
   * while the chat is set to AI Credits whether or not a turn is streaming.
   *
   * Deliberately narrower than "the chat bills to AI Credits": it is also false
   * when the account has no native login for the billing provider. See the
   * component doc below.
   */
  active: boolean;
  /** True while the current turn is actively running. */
  turnActive: boolean;
  /** Canonical refusal, including an explicit absence. */
  persistedRefusal?: NoBillingSourceSignal | null;
  /** The billed provider, used for the reset line. */
  provider?: NativeAccountProvider;
  /** Native model whose subscription windows apply to the next attempt. */
  model?: string;
  /**
   * Offers "Switch to subscription" when set. `ChatInput` passes it whenever
   * the chat can run on the provider subscription, including started Auto
   * chats whose picker toggle is locked (CAN-4200).
   *
   * A subscription that is still limited, or whose limit could not be read,
   * asks for confirmation first; the call reports what the user accepted so the
   * caller can restore the matching warning (CAN-4759).
   */
  onSwitchToSubscription?: (outcome: SubscriptionSwitchOutcome) => void;
  /**
   * The provider's last recorded native account change. A change re-reads the
   * reset line, because the new account has its own limits.
   */
  accountChangedAt?: number;
  /**
   * Offers "Continue" while the chat still has an unanswered usage-limit
   * interruption (CAN-4756): after credits arrive from Buy AI Credits, which
   * only route, or after an automatic resend failed. While it shows, the card
   * hides "Switch to subscription" so it keeps a single accent action.
   */
  continueInterruptedTurn?: ContinueInterruptedTurn;
}

/** The card's Continue action for an interrupted turn (CAN-4756). */
export interface ContinueInterruptedTurn {
  onContinue: () => void;
  busy: boolean;
  /** Feedback from a failed send, shown under the message. */
  error: string | null;
}

/** How long the card waits on a usage lookup before treating it as unknown. */
const PROVIDER_LIMIT_LOOKUP_TIMEOUT_MS = 10_000;

/**
 * What the latest usage snapshot says about switching back to the provider
 * subscription (CAN-4759). `unknown` covers a failed or timed-out lookup and an
 * exhausted window with no usable reset time: neither proves availability.
 */
export type ProviderLimitLookup =
  | { kind: 'checking' }
  | { kind: 'limited'; resetAt: number }
  | { kind: 'available' }
  | { kind: 'unknown' };

type SettledProviderLimit = Exclude<ProviderLimitLookup, { kind: 'checking' }>;

/**
 * What the user accepted when switching back to the subscription. `limited`
 * carries the reset the user confirmed, so the usage-limit banner can be
 * restored with exactly that time.
 */
export type SubscriptionSwitchOutcome = { targetKey: string } & (
  | { kind: 'limited'; provider: NativeAccountProvider; resetAt: number }
  | { kind: 'unknown'; provider: NativeAccountProvider }
  | { kind: 'available'; provider?: NativeAccountProvider }
);

function hasParsableReset(value: unknown): boolean {
  if (typeof value === 'string') return Number.isFinite(Date.parse(value));
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  const epochMs = value < 1_000_000_000_000 ? value * 1000 : value;
  return Number.isFinite(new Date(epochMs).getTime());
}

function classifyProviderUsageSnapshot(
  snapshot: AgentUsageOverview,
  provider: NativeAccountProvider,
  now: number,
  model?: string,
): SettledProviderLimit {
  const summary = snapshot.providers.find(
    (candidate) => candidate.provider === provider,
  );
  if (!summary) return { kind: 'unknown' };
  const rateLimits = subscriptionUsageLimits({
    provider,
    rateLimits: summary.rateLimits,
    model,
    surface: 'claude-code',
  });
  const subscriptionSnapshot = {
    ...snapshot,
    providers: snapshot.providers.map((entry) =>
      entry === summary ? { ...entry, rateLimits: [...rateLimits] } : entry,
    ),
  };

  // Reject epoch values outside Date's range before the shared selector tries
  // to turn them into ISO timestamps.
  if (
    rateLimits.some((limits) =>
      [limits.primary, limits.secondary].some(
        (window) =>
          typeof window?.usedPercent === 'number' &&
          window.usedPercent >= 100 &&
          typeof window.resetsAt === 'number' &&
          !hasParsableReset(window.resetsAt),
      ),
    )
  )
    return { kind: 'unknown' };
  // The farthest exhausted window decides, as for Schedule Resume.
  const resumeAt = selectProviderUsageLimitResumeAt(
    subscriptionSnapshot,
    provider,
    new Date(now),
  );
  const resetAt = resumeAt ? Date.parse(resumeAt) : Number.NaN;
  if (Number.isFinite(resetAt) && resetAt > now) {
    return { kind: 'limited', resetAt };
  }
  // Usage fetches can succeed at the IPC layer while reporting a provider
  // error with retained windows. Only a future exhausted window above remains
  // trustworthy in that case; old headroom is not proof of availability.
  if (summary.error || summary.errorInfo) return { kind: 'unknown' };
  const hasReadableWindow = rateLimits.some((limits) =>
    [limits.primary, limits.secondary].some((window) =>
      Number.isFinite(window?.usedPercent),
    ),
  );
  if (!hasReadableWindow) return { kind: 'unknown' };
  const exhaustedWithoutReset = rateLimits.some((limits) =>
    [limits.primary, limits.secondary].some(
      (window) =>
        typeof window?.usedPercent === 'number' &&
        window.usedPercent >= 100 &&
        !hasParsableReset(window.resetsAt),
    ),
  );
  return exhaustedWithoutReset ? { kind: 'unknown' } : { kind: 'available' };
}

/**
 * Whether the provider's current account is limited, and until when, for the
 * card's reset line and the switch confirmation (CAN-4200, CAN-4759).
 *
 * Fetches a fresh usage snapshot when the line becomes possible and again when
 * the native account changes; it never reads the cached store usage, which can
 * describe the previous account. A result for an older request is discarded.
 * Until the first lookup for the current account settles the answer is
 * `checking`; a hung lookup becomes `unknown` after a timeout. A failed refresh
 * keeps a known limit whose reset is still ahead, and a timer turns the limit
 * into `available` once the reset passes. Returns `null` while disabled.
 */
function useProviderLimitLookup(
  enabled: boolean,
  targetKey: string | null,
  provider: NativeAccountProvider | undefined,
  accountChangedAt: number | undefined,
  model: string | undefined,
): ProviderLimitLookup | null {
  const [state, setState] = useState<{
    key: string;
    value: SettledProviderLimit;
  } | null>(null);
  const key = `${targetKey ?? ''}|${provider ?? ''}:${accountChangedAt ?? ''}|${model ?? ''}`;

  useEffect(() => {
    if (!enabled || !provider) return;
    let cancelled = false;
    const requestedKey = key;
    let ready = false;
    let lastSummary: AgentUsageOverview['providers'][number] | undefined;
    const applySnapshot = (snapshot: AgentUsageOverview): void => {
      const summary = snapshot.providers.find(
        (item) => item.provider === provider,
      );
      // A late refresh from elsewhere must not replace a newer successful read.
      if (
        summary?.lastUpdatedAt &&
        lastSummary?.lastUpdatedAt &&
        Date.parse(summary.lastUpdatedAt) <
          Date.parse(lastSummary.lastUpdatedAt)
      )
        return;
      lastSummary = summary;
      const value = classifyProviderUsageSnapshot(
        snapshot,
        provider,
        Date.now(),
        model,
      );
      setState((previous) => {
        const known = previous?.key === requestedKey ? previous.value : null;
        return value.kind === 'unknown' &&
          (!summary || summary.error || summary.errorInfo) &&
          known?.kind === 'limited' &&
          known.resetAt > Date.now()
          ? previous
          : { key: requestedKey, value };
      });
    };
    // Observe successful newer reads without adding polling. Wait for this
    // account's own first read before trusting updates from other consumers.
    const unsubscribe = useObservabilityStore.subscribe(({ usage }) => {
      if (!ready || !usage) return;
      const summary = usage.providers.find(
        (item) => item.provider === provider,
      );
      if (summary !== lastSummary) applySnapshot(usage);
    });
    // Each lookup starts from `checking`: an earlier `available` may predate
    // the limit that sent this chat to credits. Only a known limit whose reset
    // is still ahead carries over while the new answer loads.
    setState((previous) =>
      previous?.key === requestedKey &&
      previous.value.kind === 'limited' &&
      previous.value.resetAt > Date.now()
        ? previous
        : null,
    );
    // A lookup that never settles must not hold the switch disabled forever.
    // A later answer for this request still lands.
    const timeout = setTimeout(() => {
      ready = true;
      setState((previous) =>
        previous?.key === requestedKey
          ? previous
          : { key: requestedKey, value: { kind: 'unknown' } },
      );
    }, PROVIDER_LIMIT_LOOKUP_TIMEOUT_MS);
    // Read through `getState` so the card does not re-render on every usage
    // refresh elsewhere in the app.
    const refresh =
      useObservabilityStore.getState().refreshProviderUsageSnapshot;
    refresh(provider).then(
      (snapshot) => {
        if (cancelled) return;
        clearTimeout(timeout);
        ready = true;
        applySnapshot(snapshot);
      },
      () => {
        if (cancelled) return;
        clearTimeout(timeout);
        ready = true;
        setState((previous) => {
          const known = previous?.key === requestedKey ? previous.value : null;
          return known?.kind === 'limited' && known.resetAt > Date.now()
            ? previous
            : { key: requestedKey, value: { kind: 'unknown' } };
        });
      },
    );
    return (): void => {
      cancelled = true;
      clearTimeout(timeout);
      unsubscribe();
    };
  }, [enabled, key, model, provider]);

  const resetAt =
    state?.value.kind === 'limited' ? state.value.resetAt : undefined;
  useEffect(() => {
    if (resetAt === undefined) return;
    return scheduleAt(resetAt, () =>
      setState((previous) =>
        previous?.value.kind === 'limited' && previous.value.resetAt === resetAt
          ? { key: previous.key, value: { kind: 'available' } }
          : previous,
      ),
    );
  }, [resetAt]);

  if (!enabled || !provider) return null;
  return state?.key === key ? state.value : { kind: 'checking' };
}

/**
 * Shared "you're using AI Credits for this session" status chip. Rendered once
 * in the universal `ChatInput`, it reflects the authoritative routing state the
 * main process reports for the given chat, so any current or future chat surface
 * shows it without per-surface wiring.
 *
 * On a native-capable model, the card offers an explicit subscription attempt
 * even when an auth probe is inconclusive. After a confirmed sign-out with
 * available credits and no explicit subscription override, the caller omits
 * `onSwitchToSubscription` and the card shows no switch (CAN-5349). A
 * gateway-only model has no native escape, so its existing visibility gate
 * remains narrower.
 *
 * The right side names the payer rather than always showing a number. A user
 * funded by their organization's shared pool has an empty personal wallet, and
 * the old chip reported that empty wallet as "0 credits" while the session
 * billed fine elsewhere — a number they could neither act on nor replenish. When
 * the org pool is covering, the chip says so and shows no number at all.
 */
export function AiCreditsRoutingStatusBanner({
  target,
  active,
  turnActive,
  provider,
  model,
  onSwitchToSubscription,
  accountChangedAt,
  continueInterruptedTurn,
  persistedRefusal,
}: AiCreditsRoutingStatusBannerProps): JSX.Element | null {
  const visible = target !== null && active;
  const scope = useChatTargetAiCreditsScope(target);
  const personalWallet = useComposerWorkIsPersonal(target?.projectId);
  const balance = useAiCreditsUsage(scope, {
    enabled: visible,
    personalWallet,
  });
  const liveRefusal = useNoBillingSourceSignal(
    persistedRefusal === undefined ? target : null,
  );
  const refusal =
    persistedRefusal === undefined ? liveRefusal : persistedRefusal;
  // Share the footer's owner-scoped snapshot. A refusal invalidates that cache;
  // until a successful newer read, an old positive count is not funding evidence.
  const state =
    balance.refreshing ||
    (refusal &&
      (balance.lastUpdatedAt === null ||
        balance.lastUpdatedAt <= refusal.detectedAt))
      ? null
      : balance.state;
  const canSwitch = visible && onSwitchToSubscription !== undefined;
  // The reset line only accompanies the button: it tells the user whether
  // switching back now would hit the limit again.
  const targetKey = target ? chatBannerKey(target) : null;
  const lookup = useProviderLimitLookup(
    canSwitch,
    targetKey,
    provider,
    accountChangedAt,
    model,
  );
  const resetAt = lookup?.kind === 'limited' ? lookup.resetAt : null;

  // Credits bought from this chat's usage-limit or No billing source banner
  // (CAN-5159, CAN-5160). The card confirms them until the first credits turn
  // starts or the user switches back; hiding the card alone keeps the record.
  const routedArrival = useAiCreditsArrivalStore((s) =>
    selectRoutedAiCreditsArrivalForChat(s, target),
  );
  const arrivalEvidence = useAiCreditsArrivalStore((s) =>
    selectAiCreditsArrivalEvidence(s, routedArrival?.handoffId),
  );
  const routedHandoffId = routedArrival?.handoffId ?? null;
  // Seeded with the mount-time value, so a card that mounts during a running
  // turn waits for the next turn to start. A turn that starts while the card
  // is hidden still clears, so the line cannot return on a later card.
  const wasTurnActive = useRef(turnActive);
  useEffect(() => {
    const started = !wasTurnActive.current && turnActive;
    wasTurnActive.current = turnActive;
    if (started && routedHandoffId !== null) {
      clearAiCreditsArrival(routedHandoffId);
    }
  }, [turnActive, routedHandoffId]);

  // The confirmation belongs to one chat, provider and account. Compare that
  // identity as a string so a re-allocated target object does not reset it.
  const identity = `${target ? chatBannerKey(target) : ''}|${provider ?? ''}|${model ?? ''}|${
    accountChangedAt ?? ''
  }`;
  const [confirmingFor, setConfirmingFor] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<'accept' | 'switch' | null>(
    null,
  );
  const acceptedRef = useRef(false);
  const switchButtonRef = useRef<HTMLButtonElement>(null);
  const acceptButtonRef = useRef<HTMLButtonElement>(null);

  const needsConfirmation =
    lookup?.kind === 'limited' || lookup?.kind === 'unknown';
  const confirming =
    canSwitch && confirmingFor === identity && needsConfirmation;

  // Drop a pending confirmation when the card hides, the action goes away, or
  // the chat, provider or account changes.
  useEffect(() => {
    setConfirmingFor(null);
  }, [identity, canSwitch]);

  // A limit that resets, or a newer snapshot reporting availability, ends the
  // confirmation without switching; focus returns to the switch button.
  useEffect(() => {
    if (confirmingFor !== null && lookup?.kind === 'available') {
      setConfirmingFor(null);
      setFocusRequest('switch');
    }
  }, [confirmingFor, lookup?.kind]);

  // Focus moves only in response to the user's own action, never on mount.
  useEffect(() => {
    if (focusRequest === null) return;
    setFocusRequest(null);
    (focusRequest === 'accept'
      ? acceptButtonRef
      : switchButtonRef
    ).current?.focus();
  }, [focusRequest]);

  if (!visible) {
    return null;
  }
  const providerLabel = provider ? getModelCatalogProviderLabel(provider) : '';

  // Switching back dismisses the purchase confirmation with the card.
  const switchToSubscription = (outcome: SubscriptionSwitchOutcome): void => {
    if (routedHandoffId !== null) clearAiCreditsArrival(routedHandoffId);
    onSwitchToSubscription?.(outcome);
  };

  const handleSwitch = (): void => {
    if (!onSwitchToSubscription || !targetKey) return;
    if (!provider || lookup?.kind === 'available') {
      switchToSubscription({
        kind: 'available',
        targetKey,
        ...(provider ? { provider } : {}),
      });
      return;
    }
    if (!needsConfirmation) return;
    acceptedRef.current = false;
    setConfirmingFor(identity);
    setFocusRequest('accept');
  };

  const cancel = (): void => {
    setConfirmingFor(null);
    setFocusRequest('switch');
  };

  const accept = (): void => {
    if (
      !onSwitchToSubscription ||
      !targetKey ||
      !provider ||
      acceptedRef.current
    )
      return;
    // Re-read the limit at acceptance: it may have reset since the prompt.
    if (lookup?.kind === 'limited' && lookup.resetAt > Date.now()) {
      acceptedRef.current = true;
      setConfirmingFor(null);
      switchToSubscription({
        kind: 'limited',
        targetKey,
        provider,
        resetAt: lookup.resetAt,
      });
      return;
    }
    if (lookup?.kind === 'unknown') {
      acceptedRef.current = true;
      setConfirmingFor(null);
      switchToSubscription({ kind: 'unknown', targetKey, provider });
      return;
    }
    cancel();
  };

  if (confirming && provider) {
    const confirmResetLabel = formatUsageLimitTimeLabel(resetAt ?? undefined);
    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
      if (event.key !== 'Escape') return;
      // Escape belongs to this prompt, not to a dialog or panel behind it.
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    return (
      <Notice
        intent="attention"
        title={
          confirmResetLabel
            ? `${providerLabel} is limited until ${confirmResetLabel}`
            : `Couldn't confirm your ${providerLabel} limit`
        }
        data-testid="chat-input-ai-credits-switch-confirm"
        onKeyDown={handleKeyDown}
        actions={
          <>
            <NoticeButton
              variant="secondary"
              data-testid="chat-input-ai-credits-switch-cancel"
              onClick={cancel}
            >
              Keep using credits
            </NoticeButton>
            <NoticeButton
              ref={acceptButtonRef}
              variant="primary"
              data-testid="chat-input-ai-credits-switch-accept"
              onClick={accept}
            >
              Switch anyway
            </NoticeButton>
          </>
        }
      >
        {confirmResetLabel
          ? 'Switch anyway?'
          : 'It may still be limited. Switch anyway?'}
      </Notice>
    );
  }

  const funding = resolveAiCreditsFundingSource(state);
  const resetLabel = formatUsageLimitTimeLabel(resetAt ?? undefined);
  const checking = lookup?.kind === 'checking';
  // A fresh purchase is the card's state until the first credits turn: the
  // title names the amount, so no balance repeats it.
  const arrivalTitle =
    routedArrival !== null
      ? aiCreditsArrivalTitle(arrivalEvidence ?? {})
      : null;
  // Credits bought from the No billing source banner were bought because no
  // subscription could pay, so while the card confirms them it offers no way
  // back to that dead end. A usage-limit purchase keeps the switch: that
  // subscription is still the user's once it resets.
  const switchAvailable =
    onSwitchToSubscription !== undefined &&
    routedArrival?.origin !== 'no-billing-source';
  // An interrupted turn waiting to continue takes the accent slot; the
  // switch returns once the turn is answered (CAN-4756).
  const offerSwitch = switchAvailable && continueInterruptedTurn === undefined;
  const continueButton = continueInterruptedTurn ? (
    <NoticeButton
      variant="primary"
      data-testid="chat-input-ai-credits-continue"
      disabled={continueInterruptedTurn.busy}
      aria-busy={continueInterruptedTurn.busy}
      onClick={continueInterruptedTurn.onContinue}
    >
      Continue
    </NoticeButton>
  ) : null;
  // The composer caps the card near 670px, so the card keeps to one line by
  // carrying the balance in its sentence and leaving the trailing slot to the
  // reset time and the switch.
  const coveredByChip =
    arrivalTitle === null && funding.kind === 'org-pool' ? (
      <span
        data-testid="chat-input-ai-credits-covered-by"
        // `min-w-0` + `truncate`, with an explicit ceiling: the trailing
        // slot is content-sized, so without `max-w-*` there would be
        // nothing for `overflow: hidden` to clip and a long org name would
        // push the copy instead of ellipsizing.
        className="min-w-0 max-w-64 truncate pr-3 font-medium"
        title={`Your personal credits are used up, so ${funding.orgName}'s shared credit pool is covering this session.`}
      >
        Covered by {funding.orgName}
      </span>
    ) : undefined;
  const switchButton = offerSwitch ? (
    <NoticeButton
      ref={switchButtonRef}
      // Staying on credits is what the user chose; switching back is an
      // alternative, so it takes the secondary surface, not the accent.
      variant="secondary"
      data-testid="chat-input-ai-credits-switch-to-subscription"
      // Until the first limit read settles, switching could skip the
      // confirmation a limited subscription needs. The read reports progress
      // inside this button (CAN-2349 decision 5) rather than as a detail line,
      // so the banner does not reflow when it settles.
      disabled={checking}
      busy={checking}
      busyLabel="Checking…"
      onClick={handleSwitch}
    >
      Switch to subscription
    </NoticeButton>
  ) : null;
  // The reset time tells the user whether switching back now would hit the
  // limit again, so it sits beside the button it explains rather than
  // stacking a second line under the message. It stays beside Continue too,
  // while the switch is hidden.
  const resetNote =
    switchAvailable && provider !== undefined && resetLabel !== null ? (
      <span
        data-testid="chat-input-ai-credits-limit-resets"
        className="mr-1 shrink-0 whitespace-nowrap tabular-nums fg-tertiary"
      >
        {providerLabel} resets {resetLabel}
      </span>
    ) : null;
  return (
    <Notice
      intent={arrivalTitle !== null ? 'positive' : 'neutral'}
      icon={
        arrivalTitle !== null ? undefined : (
          <CoinsIcon size={16} aria-hidden="true" />
        )
      }
      title={
        arrivalTitle !== null ? (
          <span data-testid="chat-input-ai-credits-arrival">
            {arrivalTitle}
          </span>
        ) : (
          'Using AI Credits'
        )
      }
      data-testid="chat-input-ai-credits-active"
      // Focusable from script so focus can follow "Continue on <default
      // credits model>" here when the usage-limit notice it replaces goes away (CAN-4900).
      tabIndex={-1}
      // The org name is plain text with no control chrome, so it sits 20px
      // from the edge (`pr-3` on top of the slot's 8px), which is what reads
      // as settled for bare text. The switch button comes last.
      actions={
        coveredByChip || resetNote || switchButton || continueButton ? (
          <>
            {coveredByChip}
            {resetNote}
            {switchButton}
            {continueButton}
          </>
        ) : undefined
      }
      detail={
        continueInterruptedTurn?.error ? (
          <div data-testid="chat-input-ai-credits-continue-error">
            {continueInterruptedTurn.error}
          </div>
        ) : undefined
      }
    >
      {/* `unknown` is "nothing trustworthy to say" (a blipped balance
          read), so it gets payer-agnostic copy rather than a guess. */}
      {arrivalTitle !== null ? (
        'Ready to use in this chat.'
      ) : funding.kind === 'org-pool' ? (
        `${funding.orgName}'s shared credit pool is covering this session.`
      ) : funding.kind === 'personal' ? (
        <>
          <span
            data-testid="chat-input-ai-credits-balance"
            className="tabular-nums"
          >
            {formatCredits(funding.credits)} left
          </span>
          .
        </>
      ) : (
        'This session is paid with AI Credits.'
      )}
    </Notice>
  );
}

/**
 * Shown after the user switched back to a subscription whose limit could not be
 * read (CAN-4759). Deliberately smaller than the usage-limit banner: it states
 * the uncertainty without claiming a limit or a reset time.
 */
export function SubscriptionAvailabilityNotice({
  provider,
  onDismiss,
}: {
  provider: NativeAccountProvider;
  onDismiss: () => void;
}): JSX.Element {
  return (
    <Notice
      intent="neutral"
      title={`Couldn't confirm your ${getModelCatalogProviderLabel(provider)} limit`}
      data-testid="chat-input-subscription-availability-notice"
      tabIndex={-1}
      onDismiss={onDismiss}
      dismissLabel="Dismiss subscription limit notice"
      dismissTestId="chat-input-subscription-availability-dismiss"
    >
      If it's still limited, your next message shows ways to continue.
    </Notice>
  );
}
