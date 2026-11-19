import {
  Button,
  type ButtonSize,
  type ButtonVariant,
} from '@canopy/ui-shared/components/Button';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import type {
  AiCreditsScopeRequest,
  CanopyCloudAccountPublicState,
  NativeAiCreditsAvailability,
} from '@canopy/desktop-shared/types';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import {
  useAiCreditsWalletKey,
  useStableAiCreditsScope,
} from '@/lib/aiCreditsScope';
import {
  AI_CREDITS_CHECK_AGAIN_LABEL,
  AI_CREDITS_HANDOFF_COPY,
  AiCreditsCheckFeedback,
  LoadingSpinner,
  type AiCreditsCheckFeedbackKind,
} from '@canopy/ui-shared';
import { resolveCreditsCoverage } from '@canopy/app-state/billing/credits';
import {
  getAiCreditsConnectContext,
  invalidateSharedAiCreditsRead,
  readSharedAiCreditsAvailability,
  type BillingDestination,
  type BillingPageOpenResult,
  type OpenBillingPageOptions,
} from '@/lib/openBillingPage';
import { announceAiCreditsChanged } from '@/lib/aiCreditsChanged';
import {
  beginAiCreditsArrivalHandoff,
  type AiCreditsArrivalHandoff,
  type AiCreditsArrivalOrigin,
} from '@/lib/aiCreditsArrivalConfirmation';
import {
  isConnectedNonGuest,
  useCloudConnectGateStore,
} from '@/stores/cloudConnectGateStore';
import {
  chatBannerKey,
  type ChatBannerTarget,
} from '@/stores/aiCreditsBannerStore';
import {
  aiCreditsCoverageProbe,
  aiCreditsPurchaseStore,
  selectAiCreditsHandoff,
  useAiCreditsHandoffStore,
} from '@/stores/aiCreditsHandoffStore';

/**
 * CAN-2349 §3 — the one "Buy AI Credits" affordance.
 *
 * Cases A, B and C, plus the two existing banners, all end in the same place:
 * `requestConnect` → `openBillingPage` → either Billing opens inside Settings
 * (the CTA returns to idle) or the user leaves for the browser → they come
 * back → we reprobe and either commit or keep waiting. Which of the two a
 * click may open is the host's `billingDestination`: overlay hosts keep
 * `'auto'` (Settings when it can open), while the inline chat banners pass
 * `'browser'` so the purchase stays tracked in the chat (CAN-5159). Implementing
 * that per branch is how coverage detection, throttling, cache invalidation and
 * `CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT` get subtly wrong in four places at once,
 * so it lives here and takes only what actually varies.
 *
 * `onCovered` is the ONLY behavioral seam, which is why case C reuses this
 * verbatim: C flips `billing.onChange('ai-credits')` where A/B commit a model.
 */

/**
 * Read availability without ever throwing.
 *
 * The bridge itself can be absent (older builds, and test surfaces that render
 * this component without stubbing `window.api`), so the call can throw
 * SYNCHRONOUSLY as well as reject. Both mean the same thing here — "no read" —
 * and neither may escape into a render effect.
 */
function readAvailabilitySafely(
  options: {
    readonly fresh?: boolean;
    readonly scope?: AiCreditsScopeRequest | undefined;
  } = {},
): Promise<NativeAiCreditsAvailability | null> {
  // Shared, so a post-connect read this component makes cannot disagree with
  // the one `ModelRecoveryModal` makes on the same gate close. See
  // `readSharedAiCreditsAvailability`.
  return readSharedAiCreditsAvailability({
    ...(options.fresh === true ? { fresh: true } : {}),
    ...(options.scope ? { scope: options.scope } : {}),
  });
}

/**
 * Read native credits availability fresh from main.
 *
 * `force` bypasses the throttle and is what **Check again** passes: a user who
 * returns within 60s of an automatic probe and presses the button themselves
 * must not get a silent no-op. The automatic focus/visibilitychange path does
 * NOT force, so ordinary window switching costs nothing.
 */
function probeCreditsAvailability(
  force: boolean,
  scope: AiCreditsScopeRequest | undefined,
  key: string,
): Promise<NativeAiCreditsAvailability | null> {
  // The renderer-wide throttle of the shared purchase state: only a probe
  // that asked about the SAME owner is joined; another chat's answer would
  // name another organization's pool (CAN-3463).
  //
  // Through `readAvailabilitySafely` so a SYNCHRONOUS bridge throw is
  // contained here. FRESH, always: this is the post-purchase re-probe, whose
  // entire job is to notice that the answer just changed.
  return aiCreditsCoverageProbe.probe(force, key, () =>
    readAvailabilitySafely({ fresh: true, scope }),
  );
}

/**
 * A forced, non-covered **Check again** stays busy at least this long from the
 * click (CAN-5162), so repeating the same answer is still a visible change.
 * Request time counts toward it; a covered result never waits.
 */
const CHECK_AGAIN_MIN_BUSY_MS = 500;

export type GetAiCreditsCtaVariant = 'primary' | 'inline';

/**
 * The browser hand-off a compact host describes in its own notice copy while
 * this CTA shows only **Check again**. Primitive fields plus one stable
 * callback, so a host can store it in state without re-triggering the CTA.
 */
export interface GetAiCreditsHandoffState {
  /**
   * What the last Check again concluded, or `null` while simply waiting for
   * the user to finish in the browser.
   */
  readonly feedback: AiCreditsCheckFeedbackKind | null;
  /**
   * Opens billing again without leaving the hand-off. Absent after a failed
   * check, which is retried with Check again instead.
   */
  readonly onReopenBilling?: () => void;
  readonly reopenPending: boolean;
  readonly reopenDisabled: boolean;
  /**
   * Check again, for a host whose own coverage read found the credits while
   * this hand-off's automatic check could not conclude (an account change on
   * return supersedes it). A covered check records the arrival; any other
   * answer leaves the hand-off as it was. Returns `false` when a check or
   * reopen is already running, so the host can ask again once it finishes.
   */
  readonly onCheckAgain: () => boolean;
  /** A check or reopen is running; Check again waits for it to finish. */
  readonly checking: boolean;
  /**
   * The retained hand-off these controls act on (CAN-5534), or `null` for a
   * CTA that keeps its hand-off locally. A host binds the controls to it.
   */
  readonly handoffId: string | null;
}

export interface GetAiCreditsCtaProps {
  /** e.g. "Buy AI Credits" / "Add credits to use Claude Opus 4.5". */
  readonly label: string;
  /** Case-specific line rendered above the button. */
  readonly description?: string;
  /**
   * Coverage was detected. Commit the model (A/B) or flip the billing toggle
   * (C). The only behavioral difference between the three call sites.
   */
  /**
   * Return `false` to say the coverage was real but the host could NOT act on
   * it — `ModelRecoveryModal` returns it when the pending row went
   * provider-locked. The one-shot latch below is not armed in that case, so
   * the user can press this button again once the lock clears. Returning
   * `void` (the common case) means committed.
   */
  readonly onCovered: () => boolean | void | Promise<boolean | void>;
  /**
   * Optional compact-surface escape hatch (case C). A picker footer cannot
   * explain guest, contact-admin, or inconclusive account state, so it
   * asks its parent to open the full recovery modal for those branches.
   */
  readonly onNeedsRecovery?: () => void;
  /** `'primary'` = modal button, `'inline'` = picker-footer button. */
  readonly variant?: GetAiCreditsCtaVariant;
  /** The host surface's button treatment; a compact secondary by default. */
  readonly buttonVariant?: ButtonVariant;
  readonly buttonSize?: ButtonSize;
  /**
   * How the post-hand-off state is laid out.
   *
   * `'block'` (default) stacks the "finish this in your browser" line above
   * **Check again**, which is right for the modal and the picker footer — both
   * are vertical, full-width surfaces.
   *
   * `'compact'` is for the two banners, whose action bar is a row of buttons:
   * dropping a two-line block into it re-flows the whole bar. There the CTA
   * renders only **Check again** and reports the hand-off through
   * `onHandoffChange`, so the host's own title and message say what is
   * happening and **Reopen billing** joins the host's buttons.
   */
  readonly handoffLayout?: 'block' | 'compact';
  /**
   * Host-supplied inert gate, ORed with this component's own `busy` state.
   *
   * `NoBillingSourceBanner` keeps the button RENDERED but disabled while its
   * own coverage read is in flight, so the action bar never changes width and
   * nothing that spends money is clickable on a decision made from a stale
   * read. That is the host's fact to know, not this component's.
   */
  readonly disabled?: boolean;
  /**
   * Hand off to billing when the post-connect coverage read is INCONCLUSIVE,
   * instead of stopping to report that it failed.
   *
   * Opt-in, and only correct for a host whose affordance exists *because* that
   * same read was already inconclusive — `NoBillingSourceBanner`'s fallback
   * CTA. There, explaining the failure is a guaranteed dead end: the read that
   * would have to succeed is the one that just failed, so the branch added to
   * guarantee the banner is never actionless becomes reliably actionless.
   *
   * Safe because the hand-off does not depend on the read: `openBillingPage`
   * only consults availability for its unauthenticated `pricingUrl` fallback,
   * and tries the in-app or signed-in billing page first regardless. This restores
   * the unconditional open the hand-rolled button had before the shared CTA
   * replaced it.
   *
   * Every other host keeps the default: they have an inconclusive branch of
   * their own to explain the outcome, and guessing on their behalf would push
   * a possibly-covered user at a purchase page.
   */
  readonly handoffOnInconclusiveRead?: boolean;
  /**
   * Owner of the work this CTA is for (CAN-3463). Every coverage read asks
   * about this owner's organization pool only; omitted = navigation context.
   */
  readonly aiCreditsScope?: AiCreditsScopeRequest;
  /**
   * Billing opened inside Settings (CAN-4691). Called once after an in-app
   * open, never after a browser hand-off or a failed open, so an overlay host
   * (dialog, popover) can close itself and let the user see Settings. Inline
   * banner hosts omit it.
   */
  readonly onOpenedInApp?: () => void;
  /**
   * Where a click may open billing (CAN-5159). `'auto'` (default) opens
   * Settings → Billing in-app when it can, which ends this CTA's hand-off.
   * `'browser'` always opens the signed-in web top-up, so the waiting state,
   * Check again, the focus re-check and the arrival record survive in the
   * host. For inline banner hosts with no overlay to close.
   */
  readonly billingDestination?: BillingDestination;
  /**
   * Compact hosts only: receives the browser hand-off while it lasts, or
   * `null` when there is none. Hosts clear their own copy when the CTA is
   * removed; unmount never updates a parent.
   */
  readonly onHandoffChange?: (handoff: GetAiCreditsHandoffState | null) => void;
  /** The user pressed the button. For recovery telemetry (CAN-4633). */
  readonly onGetCreditsClick?: () => void;
  /**
   * Track the browser hand-off so its first covered return records an
   * arrival confirmation for the chat in `aiCreditsScope` (CAN-5160). Only a
   * host that renders that confirmation opts in, naming itself as the
   * record's origin. Untracked when omitted.
   */
  readonly confirmArrival?: AiCreditsArrivalOrigin;
  /**
   * Keep the browser hand-off in `aiCreditsHandoffStore` for this chat's
   * purchase scope instead of in this instance (CAN-5534). Switching chats,
   * hiding the host or unmounting then keeps the waiting state, Check again
   * and the arrival, and every opted-in CTA in the scope shows the return
   * controls instead of a second purchase. Hosts without it keep the local
   * lifecycle.
   */
  readonly persistHandoffFor?: ChatBannerTarget;
  readonly dataTestId?: string;
}

/** The retained hand-off an async operation started under. */
interface HandoffSession {
  readonly walletKey: string;
  readonly id: string;
  readonly accountGeneration: number;
}

/**
 * What a post-connect coverage re-read concluded.
 *
 * `'gone'` is deliberately distinct from `'uncovered'`: the read finished, but
 * the CTA that asked for it is no longer mounted, so the answer belongs to
 * nobody. Callers must not translate it into a purchase.
 */
type CoverageCommitOutcome = 'covered' | 'uncovered' | 'unknown' | 'gone';

/**
 * Shown above Check again in the stacked layout, the same step the banners
 * name in their own title and message (CAN-5160).
 */
const HANDOFF_COPY = AI_CREDITS_HANDOFF_COPY.waiting;

/**
 * A browser destination also asks the web page to open its credits top-up
 * (CAN-5159); only the chat banners use it, so the source is always the banner.
 */
function billingOpenOptions(
  destination: BillingDestination,
): OpenBillingPageOptions {
  return destination === 'browser'
    ? { destination, topUpSource: 'banner' }
    : { destination };
}

export function GetAiCreditsCta({
  label,
  description,
  onCovered,
  onNeedsRecovery,
  variant = 'primary',
  buttonVariant = variant === 'inline' ? 'secondary' : 'primary',
  buttonSize = 'compact',
  handoffLayout = 'block',
  disabled = false,
  handoffOnInconclusiveRead = false,
  aiCreditsScope,
  onOpenedInApp,
  billingDestination = 'auto',
  onHandoffChange,
  onGetCreditsClick,
  confirmArrival,
  persistHandoffFor,
  dataTestId = 'get-ai-credits-cta',
}: GetAiCreditsCtaProps): JSX.Element {
  const { scope: stableAiCreditsScope, key: aiCreditsScopeKey } =
    useStableAiCreditsScope(aiCreditsScope);
  // Read through a ref so the stable callbacks below always ask about the
  // CURRENT owner without re-subscribing their listeners.
  const scopeRef = useRef(stableAiCreditsScope);
  scopeRef.current = stableAiCreditsScope;
  const scopeKeyRef = useRef(aiCreditsScopeKey);
  const requestConnect = useCloudConnectGateStore((s) => s.requestConnect);
  const cloudGatePending = useCloudConnectGateStore((s) => s.pending);
  const [busy, setBusy] = useState(false);
  const [localHandedOff, setLocalHandedOff] = useState(false);
  const [handoffFailed, setHandoffFailed] = useState(false);
  /**
   * The post-connect coverage read did not resolve.
   *
   * Distinct state from {@link handoffFailed}, because it is a distinct fact
   * with distinct copy: "we couldn't open the billing page" is wrong when the
   * truth is "we couldn't tell whether you need one". Without this, an
   * `'unknown'` outcome is a SILENT dead click in every host that has no
   * recovery modal to explain it — both banners mount this CTA without
   * `onNeedsRecovery`, and the picker footer reaches the same path whenever its
   * pre-gate read was conclusive. During an availability outage every click
   * would appear to do nothing at all.
   */
  const [readFailed, setReadFailed] = useState(false);
  /**
   * What the last Check again concluded while handed off (CAN-5162). Only a
   * conclusive uncovered read or a failed forced read sets it; a covered read,
   * a new hand-off and a scope change clear it.
   */
  const [localCheckFeedback, setLocalCheckFeedback] =
    useState<AiCreditsCheckFeedbackKind | null>(null);
  // Store mode (CAN-5534): the hand-off and its last verdict come from the
  // purchase scope's retained record instead of this instance. Both hooks run
  // in either mode; a `null` key selects nothing.
  const walletKey = useAiCreditsWalletKey(persistHandoffFor ?? null);
  const storeMode = walletKey !== null;
  const handoffRecord = useAiCreditsHandoffStore((s) =>
    selectAiCreditsHandoff(s, walletKey),
  );
  const handedOff = storeMode ? handoffRecord !== null : localHandedOff;
  const checkFeedback = storeMode
    ? (handoffRecord?.feedback ?? null)
    : localCheckFeedback;
  const walletKeyRef = useRef(walletKey);
  walletKeyRef.current = walletKey;
  const handoffRecordRef = useRef(handoffRecord);
  handoffRecordRef.current = handoffRecord;
  const originChatKeyRef = useRef<string | null>(null);
  originChatKeyRef.current = persistHandoffFor
    ? chatBannerKey(persistHandoffFor)
    : null;
  /**
   * The record this instance just created, for the scope it created it in,
   * so it does not immediately re-read what its own open established.
   */
  const createdHandoffRef = useRef<{
    readonly id: string;
    readonly scopeKey: string;
  } | null>(null);
  const [reopenPending, setReopenPending] = useState(false);
  const mountedRef = useRef(true);
  /**
   * Bumped on every scope change and on unmount. An awaited read, minimum-busy
   * timer or reopen captures it and must find it unchanged before acting: a
   * scope that changes away and back leaves the key equal but the generation
   * moved on.
   */
  const lifecycleRef = useRef(0);
  /**
   * The one check or reopen in flight for this instance. Serializes Check
   * again, focus/visibility checks and Reopen billing, and lets a stale
   * completion recognize that it no longer owns the busy state.
   */
  const operationRef = useRef<object | null>(null);
  const minimumBusyHoldRef = useRef<{
    readonly timer: ReturnType<typeof setTimeout>;
    readonly release: () => void;
  } | null>(null);
  const checkAgainButtonRef = useRef<HTMLButtonElement | null>(null);
  const primaryButtonRef = useRef<HTMLButtonElement | null>(null);
  const restoreFocusAfterReopenRef = useRef(false);
  const availabilityRef = useRef<NativeAiCreditsAvailability | null>(null);
  /**
   * The in-flight seed read, so the hand-off can AWAIT it instead of racing it.
   * A user who clicks the moment this button appears would otherwise reach
   * `openBillingPage(null)`, whose unauthenticated fallback has no pricing URL
   * and therefore opens nothing at all.
   */
  const availabilityPromiseRef =
    useRef<Promise<NativeAiCreditsAvailability | null> | null>(null);
  // A prop/context change takes effect during render, before an effect can run:
  // a click in that frame must not consume the previous owner's settled value.
  if (scopeKeyRef.current !== aiCreditsScopeKey) {
    scopeKeyRef.current = aiCreditsScopeKey;
    availabilityRef.current = null;
    availabilityPromiseRef.current = null;
  }
  const awaitingCloudGateRef = useRef(false);
  const sawCloudGateRef = useRef(false);
  const handoffStartedRef = useRef(false);
  /**
   * `onCovered` fires AT MOST ONCE per hand-off.
   *
   * Returning from the browser commonly fires `focus` and `visibilitychange`
   * together. `probeCreditsAvailability` shares the in-flight read, but each
   * awaiting caller resumes with the same covered result and would invoke
   * `onCovered` independently — committing a model twice, flipping the billing
   * toggle twice, or running quota recovery twice. Reset when a new hand-off
   * begins so a later covered → uncovered → purchase cycle still commits.
   */
  const coveredRef = useRef(false);
  const coveredCommitRef = useRef<object | null>(null);
  // Read through a ref so the focus/visibilitychange listeners below never have
  // to re-register just because the caller passed a new closure.
  const onCoveredRef = useRef(onCovered);
  onCoveredRef.current = onCovered;
  const onOpenedInAppRef = useRef(onOpenedInApp);
  onOpenedInAppRef.current = onOpenedInApp;
  const billingDestinationRef = useRef(billingDestination);
  billingDestinationRef.current = billingDestination;
  const onHandoffChangeRef = useRef(onHandoffChange);
  onHandoffChangeRef.current = onHandoffChange;
  const onGetCreditsClickRef = useRef(onGetCreditsClick);
  onGetCreditsClickRef.current = onGetCreditsClick;
  const confirmArrivalRef = useRef(confirmArrival);
  confirmArrivalRef.current = confirmArrival;
  /**
   * The browser hand-off an arrival confirmation may come from (CAN-5160).
   * Started at the click so its baseline balance read can finish before the
   * browser opens; dropped on every path that is not a browser return.
   */
  const arrivalHandoffRef = useRef<AiCreditsArrivalHandoff | null>(null);
  const openingLatchRef = useRef<{
    readonly walletKey: string;
    readonly token: object;
    readonly accountGeneration: number;
  } | null>(null);
  const clearArrivalHandoff = useCallback((): void => {
    arrivalHandoffRef.current?.cancel();
    arrivalHandoffRef.current = null;
    const opening = openingLatchRef.current;
    openingLatchRef.current = null;
    if (opening !== null) {
      aiCreditsPurchaseStore.releaseOpening(opening.walletKey, opening.token);
    }
  }, []);
  const ensureArrivalHandoff = useCallback((): void => {
    const origin = confirmArrivalRef.current;
    if (origin === undefined) return;
    if (arrivalHandoffRef.current?.isLive() === true) return;
    arrivalHandoffRef.current = beginAiCreditsArrivalHandoff(
      scopeRef.current,
      origin,
      walletKeyRef.current ?? undefined,
    );
  }, []);
  // NOTE: availability lives ONLY in `availabilityRef`, and every path that
  // learns one writes it there directly.
  //
  // It used to be mirrored into state and re-synced back into the ref during
  // render. Nothing ever read that state — no rendered output depends on
  // availability — so its only effect was to undo the one write that matters:
  // `resolveAvailabilityForHandoff` deliberately clears the ref to `null` after
  // a failed read so the next hand-off re-reads instead of replaying the
  // failure, and a render-phase re-sync silently restored the stale value on
  // the very next render. A render-phase ref write is also unsafe under
  // StrictMode double-rendering. Do not reintroduce either half.

  const cancelMinimumBusyHold = useCallback((): void => {
    const hold = minimumBusyHoldRef.current;
    minimumBusyHoldRef.current = null;
    if (hold) {
      clearTimeout(hold.timer);
      // Settle the awaiting check so its `finally` runs; it then finds the
      // generation moved on and does nothing else.
      hold.release();
    }
  }, []);

  /** The retained hand-off pending now, in store mode. */
  const currentHandoffSession = useCallback((): HandoffSession | null => {
    const key = walletKeyRef.current;
    const record = handoffRecordRef.current;
    if (key === null || record === null) return null;
    return {
      walletKey: key,
      id: record.id,
      accountGeneration: record.accountGeneration,
    };
  }, []);
  /** Write a Check again verdict where this instance keeps it. */
  const writeCheckFeedback = useCallback(
    (
      session: HandoffSession | null,
      feedback: AiCreditsCheckFeedbackKind | null,
    ): void => {
      if (session === null) {
        setLocalCheckFeedback(feedback);
        return;
      }
      aiCreditsPurchaseStore.setFeedback(
        session.walletKey,
        session.id,
        session.accountGeneration,
        feedback,
      );
    },
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
      lifecycleRef.current += 1;
      operationRef.current = null;
      cancelMinimumBusyHold();
      clearArrivalHandoff();
    };
  }, [cancelMinimumBusyHold, clearArrivalHandoff]);

  // Seed the pricing URL / org coverage that `openBillingPage` needs. Not
  // forced: the shared throttle already keeps this cheap across mounts. The
  // promise is retained so a click that lands before it settles can await it
  // rather than handing off with a `null` availability.
  useEffect(() => {
    const seedKey = aiCreditsScopeKey;
    availabilityRef.current = null;
    lifecycleRef.current += 1;
    operationRef.current = null;
    cancelMinimumBusyHold();
    setBusy(false);
    setLocalHandedOff(false);
    setHandoffFailed(false);
    setReadFailed(false);
    setLocalCheckFeedback(null);
    setReopenPending(false);
    awaitingCloudGateRef.current = false;
    sawCloudGateRef.current = false;
    handoffStartedRef.current = false;
    coveredRef.current = false;
    coveredCommitRef.current = null;
    clearArrivalHandoff();
    const seed = readAvailabilitySafely({ scope: stableAiCreditsScope });
    availabilityPromiseRef.current = seed;
    void seed.then((native) => {
      if (
        mountedRef.current &&
        scopeKeyRef.current === seedKey &&
        availabilityPromiseRef.current === seed
      ) {
        availabilityRef.current = native;
      }
    });
  }, [
    aiCreditsScopeKey,
    stableAiCreditsScope,
    cancelMinimumBusyHold,
    clearArrivalHandoff,
  ]);

  /**
   * The availability the hand-off should use, waiting on the seed read if it is
   * still in flight. A rejected/`null` read still resolves to `null` — the
   * caller decides what to do about it — but it is never skipped merely because
   * the user was fast.
   */
  const resolveAvailabilityForHandoff =
    useCallback(async (): Promise<NativeAiCreditsAvailability | null> => {
      const requestScopeKey = scopeKeyRef.current;
      const generation = lifecycleRef.current;
      if (availabilityRef.current !== null) {
        return availabilityRef.current;
      }
      const pending =
        availabilityPromiseRef.current ??
        readAvailabilitySafely({ scope: scopeRef.current });
      availabilityPromiseRef.current = pending;
      const native = await pending;
      if (
        !mountedRef.current ||
        lifecycleRef.current !== generation ||
        scopeKeyRef.current !== requestScopeKey
      )
        return null;
      if (native === null) {
        // A settled-`null` promise must not be cached HERE, or a seed read that
        // failed once would be replayed for the life of this instance and
        // every later hand-off would keep losing the `pricingUrl` fallback —
        // the exact failure this helper exists to prevent.
        //
        // Note the scope: `readSharedAiCreditsAvailability` now retains its
        // answer for the surrounding episode, so clearing this instance ref
        // only un-caches within that episode. It is not a leak — every path
        // that reaches a hand-off opens a fresh episode first — but this ref is
        // no longer the outermost cache it was written to be.
        if (availabilityPromiseRef.current === pending) {
          availabilityPromiseRef.current = null;
        }
      }
      availabilityRef.current = native;
      return native;
    }, []);

  /**
   * Re-read coverage and commit if credits have appeared.
   *
   * Success is `canSpendCredits === true` and nothing else. A failed or
   * inconclusive read leaves the hand-off state up with **Check again** rather
   * than asserting "you still have no credits" — the read failing is not
   * evidence about the user's balance.
   */
  /**
   * Invoke `onCovered` at most once per hand-off.
   *
   * Announcing is deliberately NOT done here: a confirmed-covered read is
   * app-wide news (it invalidates the availability cache) and stays true even
   * when this instance has already committed, so callers announce
   * unconditionally and use this only to guard the one-shot commit.
   *
   * The latch arms only on a host that ACTED. A host returning `false` saw the
   * coverage but could not apply it (the pending row went provider-locked), and
   * arming on that would turn every later press of this button into a silent
   * no-op — the latch is only reset by `beginBillingHandoff`, which a
   * covered-account retry never reaches.
   */
  const commitCovered = useCallback(async (): Promise<void> => {
    if (coveredRef.current) return;
    // Provisional latch, taken BEFORE awaiting. The host's answer can now take
    // an IPC round trip, and `focus` + `visibilitychange` commonly fire
    // together on return from the browser — without holding the latch across
    // the await, both would pass the check and commit twice, which is the exact
    // double-commit this latch exists to prevent.
    coveredRef.current = true;
    const commit = {};
    coveredCommitRef.current = commit;
    const generation = lifecycleRef.current;
    const isCurrent = (): boolean =>
      mountedRef.current &&
      lifecycleRef.current === generation &&
      coveredCommitRef.current === commit;
    try {
      const accepted = await onCoveredRef.current();
      if (!isCurrent()) return;
      if (accepted === false) {
        // Refused: the host saw the coverage but could not apply it. Release
        // the latch so the user can press again once the block clears.
        coveredRef.current = false;
      }
    } catch {
      if (!isCurrent()) return;
      // A throw is not a commit. Releasing matters more here than anywhere
      // else: nothing resets this latch except `beginBillingHandoff`, which a
      // covered-account retry never reaches, so keeping it armed would make
      // every later confirmed-covered read a silent no-op for the life of the
      // hand-off.
      coveredRef.current = false;
    }
  }, []);

  /**
   * Commit if a fresh read shows coverage; report whether it did.
   *
   * Used after a successful cloud connect: the account a guest signs in to
   * may already hold credits. Handing them off to a BILLING page at that
   * point would ask them to buy what they have and park them on "Check
   * again" until they happen to alt-tab back.
   *
   * FOUR outcomes, not two. Only ONE of them may open a billing page, so each
   * non-answer has to stay distinguishable from a real "no credits":
   *
   * - `'gone'` — this CTA unmounted while the read was in flight. Collapsing it
   *   into `'uncovered'` is what let a cancelled or superseded recovery still
   *   open a billing page: the caller read "no credits" from what was really
   *   "nobody is asking any more".
   * - `'unknown'` — the read failed or came back `inconclusive`. Asserting a
   *   balance from a read that did not resolve is the same error this PR fixed
   *   in `resolveAiCreditsCoverage` and in the modal's inconclusive branch, and
   *   it is visible to the user: the modal renders "we couldn't check your
   *   account" from the SAME read that would have sent them to a purchase page.
   * - `'uncovered'` — a settled read that genuinely shows no credits. The only
   *   outcome that justifies a hand-off.
   */
  const commitIfAlreadyCovered =
    useCallback(async (): Promise<CoverageCommitOutcome> => {
      const requestScopeKey = scopeKeyRef.current;
      const generation = lifecycleRef.current;
      const accountGeneration =
        walletKeyRef.current === null
          ? null
          : useAiCreditsHandoffStore.getState().accountGeneration;
      const native = await readAvailabilitySafely({
        scope: scopeRef.current,
      });
      if (
        !mountedRef.current ||
        lifecycleRef.current !== generation ||
        scopeKeyRef.current !== requestScopeKey ||
        (accountGeneration !== null &&
          useAiCreditsHandoffStore.getState().accountGeneration !==
            accountGeneration)
      ) {
        return 'gone';
      }
      if (native !== null) {
        availabilityRef.current = native;
      }
      if (native === null || native.inconclusive === true) {
        return 'unknown';
      }
      if (!resolveCreditsCoverage(native).canSpendCredits) {
        return 'uncovered';
      }
      // Covered without a browser return: nothing arrived from a hand-off.
      clearArrivalHandoff();
      setBusy(false);
      announceAiCreditsChanged();
      void commitCovered();
      return 'covered';
    }, [clearArrivalHandoff, commitCovered]);

  /**
   * Wait out the rest of {@link CHECK_AGAIN_MIN_BUSY_MS} from `startedAt`.
   * Cancelled (and settled early) by a scope change or unmount.
   */
  const waitForMinimumBusy = useCallback((startedAt: number): Promise<void> => {
    const remaining = CHECK_AGAIN_MIN_BUSY_MS - (Date.now() - startedAt);
    if (remaining <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout((): void => {
        if (minimumBusyHoldRef.current?.timer === timer) {
          minimumBusyHoldRef.current = null;
        }
        resolve();
      }, remaining);
      minimumBusyHoldRef.current = { timer, release: resolve };
    });
  }, []);

  /**
   * Re-read coverage while handed off.
   *
   * `force` is **Check again**: it bypasses the throttle, clears the previous
   * verdict while pending (so the same answer twice is still announced), and
   * reports a failed or inconclusive read as such. An automatic focus or
   * visibility read stays silent unless it is conclusive: its `null` may only
   * mean "throttled". `quiet` forces the read for a host but reports nothing
   * the user did not ask for. Only a covered read commits, and it never waits.
   */
  const checkCoverage = useCallback(
    async (force: boolean, quiet = false): Promise<void> => {
      if (!mountedRef.current) return;
      // Per-instance guard, not just the shared probe: `focus` and
      // `visibilitychange` both fire on return, and two callers awaiting the
      // SAME shared probe would each fall through to `commitCovered` below.
      // It also keeps a check from racing a Reopen billing.
      if (operationRef.current !== null) return;
      // Store mode reads for the retained record, which a sibling may have
      // ended or which may have expired while the machine slept.
      const storeBacked = walletKeyRef.current !== null;
      if (storeBacked) aiCreditsPurchaseStore.expire();
      const session = storeBacked ? currentHandoffSession() : null;
      if (storeBacked && session === null) return;
      if (
        session !== null &&
        force &&
        handoffRecordRef.current?.identityUnverified
      ) {
        // The root owns identity reconciliation and fences older responses.
        // Its verified result activates a fresh coverage read below.
        window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
        return;
      }
      const operation = {};
      operationRef.current = operation;
      const generation = lifecycleRef.current;
      const requestScopeKey = scopeKeyRef.current;
      const isCurrent = (): boolean =>
        mountedRef.current &&
        lifecycleRef.current === generation &&
        scopeKeyRef.current === requestScopeKey &&
        operationRef.current === operation &&
        (session === null ||
          aiCreditsPurchaseStore.isCurrent(
            session.walletKey,
            session.id,
            session.accountGeneration,
          ));
      const startedAt = Date.now();
      setBusy(true);
      if (force && !quiet) writeCheckFeedback(session, null);
      try {
        let native: NativeAiCreditsAvailability | null = null;
        try {
          // Sibling chats share a retained hand-off, so they share its read
          // too rather than each probing for their own chat.
          native = await probeCreditsAvailability(
            force,
            scopeRef.current,
            session === null
              ? requestScopeKey
              : `handoff:${session.id}:${session.accountGeneration}`,
          );
        } catch {
          native = null;
        }
        if (!isCurrent()) return;
        if (native === null || native.inconclusive === true) {
          // Not evidence about the balance. An automatic read keeps whatever
          // we already said; a forced one says the check itself failed.
          if (!force || quiet) return;
          await waitForMinimumBusy(startedAt);
          if (!isCurrent()) return;
          writeCheckFeedback(session, 'check-failed');
          return;
        }
        availabilityRef.current = native;
        if (resolveCreditsCoverage(native).canSpendCredits) {
          if (session !== null) {
            // Claimed once for the record: the arrival is recorded for the
            // chat that started it, whichever chat found the credits, and
            // before the announcement so its account recheck reconciles it.
            const completed = aiCreditsPurchaseStore.complete(
              session.walletKey,
              session.id,
              session.accountGeneration,
            );
            if (!completed) return;
            handoffStartedRef.current = false;
            announceAiCreditsChanged();
            void commitCovered();
            return;
          }
          setLocalCheckFeedback(null);
          setLocalHandedOff(false);
          // The hand-off is over, so the one-shot latch must open again or a
          // later purchase from this same instance would spin forever.
          handoffStartedRef.current = false;
          // Only the hand-off's first covered return records an arrival, and
          // before the announcement, so its account recheck reconciles it.
          arrivalHandoffRef.current?.recordCovered();
          // Keep the cancellation handle until cleanup: identity may still
          // be resolving, and a scope change or unmount must fence it too.
          // Announce every confirmed-covered read, even if this instance has
          // already committed: hosts (the usage-limit banner) re-derive their
          // affordances from it, and skipping it leaves them stale.
          announceAiCreditsChanged();
          void commitCovered();
          return;
        }
        if (quiet || (session !== null && !force)) return;
        if (force) {
          await waitForMinimumBusy(startedAt);
          if (!isCurrent()) return;
        }
        writeCheckFeedback(session, 'uncovered');
      } finally {
        // A stale completion must not release a newer operation's guard or
        // clear its busy state.
        if (operationRef.current === operation) {
          operationRef.current = null;
          if (mountedRef.current && lifecycleRef.current === generation) {
            setBusy(false);
          }
        }
      }
    },
    [
      commitCovered,
      currentHandoffSession,
      waitForMinimumBusy,
      writeCheckFeedback,
    ],
  );

  /**
   * **Reopen billing** after a conclusive uncovered check (CAN-5162).
   *
   * Reuses the hand-off's availability resolver and `openBillingPage` without
   * re-arming the one-shot hand-off latch, which stays held while the user is
   * in the browser. Serialized with checks, so repeated clicks open one page.
   */
  const reopenBilling = useCallback((): void => {
    if (!mountedRef.current) return;
    if (operationRef.current !== null) return;
    const storeBacked = walletKeyRef.current !== null;
    const session = storeBacked ? currentHandoffSession() : null;
    if (storeBacked && session === null) return;
    const operation = {};
    operationRef.current = operation;
    const generation = lifecycleRef.current;
    const requestScopeKey = scopeKeyRef.current;
    const scope = scopeRef.current;
    const sessionCurrent = (): boolean =>
      session === null ||
      aiCreditsPurchaseStore.isCurrent(
        session.walletKey,
        session.id,
        session.accountGeneration,
      );
    const isCurrent = (): boolean =>
      mountedRef.current &&
      lifecycleRef.current === generation &&
      scopeKeyRef.current === requestScopeKey &&
      operationRef.current === operation &&
      sessionCurrent();
    setReopenPending(true);
    void (async (): Promise<void> => {
      let result: BillingPageOpenResult | 'stale';
      try {
        const native = await resolveAvailabilityForHandoff();
        // Validate BEFORE opening: the open is a visible side effect.
        result = isCurrent()
          ? await aiCreditsPurchaseStore.openHandoff({
              availability: native,
              scope,
              options: billingOpenOptions(billingDestinationRef.current),
            })
          : 'stale';
      } catch {
        result = 'failed';
      } finally {
        if (isCurrent()) setReopenPending(false);
        if (operationRef.current === operation) operationRef.current = null;
      }
      if (
        !mountedRef.current ||
        lifecycleRef.current !== generation ||
        scopeKeyRef.current !== requestScopeKey ||
        !sessionCurrent() ||
        result === 'stale'
      )
        return;
      setReopenPending(false);
      restoreFocusAfterReopenRef.current = true;
      if (session !== null) {
        // A retained hand-off outlives a reopen that failed or opened
        // Settings: the first browser checkout may still complete, so the
        // scope never drops back to a fresh purchase here. A failure keeps
        // the last verdict and releases the button for a retry.
        if (result === 'web') writeCheckFeedback(session, null);
        if (result === 'settings') {
          restoreFocusAfterReopenRef.current = false;
          onOpenedInAppRef.current?.();
        }
        return;
      }
      setLocalCheckFeedback(null);
      if (result === 'web') {
        // Still handed off: the focus/visibility listeners stay registered.
        return;
      }
      setLocalHandedOff(false);
      handoffStartedRef.current = false;
      clearArrivalHandoff();
      if (result === 'settings') {
        restoreFocusAfterReopenRef.current = false;
        // Call the host last: it may unmount us.
        onOpenedInAppRef.current?.();
        return;
      }
      setHandoffFailed(true);
    })();
  }, [
    clearArrivalHandoff,
    currentHandoffSession,
    resolveAvailabilityForHandoff,
    writeCheckFeedback,
  ]);

  // Reopen billing disappears once it settles; keep keyboard focus on the CTA
  // instead of dropping it to the document.
  useEffect(() => {
    if (!restoreFocusAfterReopenRef.current || reopenPending) return;
    restoreFocusAfterReopenRef.current = false;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    (handedOff ? checkAgainButtonRef : primaryButtonRef).current?.focus();
  }, [handedOff, reopenPending, checkFeedback]);

  const visibleCheckFeedback = handedOff ? checkFeedback : null;
  const reopenDisabled = busy || disabled;
  // The block layout renders the verdict itself, with Reopen billing only
  // after a conclusive uncovered check.
  const checkFeedbackState = useMemo((): {
    readonly kind: AiCreditsCheckFeedbackKind;
    readonly onReopenBilling?: () => void;
    readonly reopenPending: boolean;
    readonly reopenDisabled: boolean;
  } | null => {
    if (visibleCheckFeedback === null) return null;
    return {
      kind: visibleCheckFeedback,
      ...(visibleCheckFeedback === 'uncovered'
        ? { onReopenBilling: reopenBilling }
        : {}),
      reopenPending,
      reopenDisabled,
    };
  }, [visibleCheckFeedback, reopenBilling, reopenPending, reopenDisabled]);
  const checkAgain = useCallback((): boolean => {
    if (!mountedRef.current || operationRef.current !== null) return false;
    void checkCoverage(true, true);
    return true;
  }, [checkCoverage]);
  // A compact host describes the whole hand-off, so Reopen billing is offered
  // while waiting too; only a failed check leaves it out. `checking` makes
  // each check re-render the host, which needs it to ask again afterwards.
  const handoffId = handoffRecord?.id ?? null;
  const handoffState = useMemo((): GetAiCreditsHandoffState | null => {
    if (!handedOff) return null;
    // Rebuilt for every scope, so a host reused across chats in one purchase
    // scope receives controls bound to the chat it now shows.
    void aiCreditsScopeKey;
    return {
      feedback: visibleCheckFeedback,
      ...(visibleCheckFeedback === 'check-failed'
        ? {}
        : { onReopenBilling: reopenBilling }),
      reopenPending,
      reopenDisabled,
      onCheckAgain: checkAgain,
      checking: busy || reopenPending,
      handoffId,
    };
  }, [
    aiCreditsScopeKey,
    handoffId,
    handedOff,
    visibleCheckFeedback,
    reopenBilling,
    reopenPending,
    reopenDisabled,
    checkAgain,
    busy,
  ]);

  // Hand the compact host its hand-off. Keyed on the memoized state, so a
  // host re-render alone never calls back.
  useEffect(() => {
    onHandoffChangeRef.current?.(handoffState);
  }, [handoffState]);

  // Store mode (CAN-5534): arriving at a retained hand-off — a remount, a
  // hidden banner shown again, or a switch to another chat in the scope —
  // re-reads coverage at once, past the throttle, so credits bought while
  // away are found without Check again. Quiet: only coverage is acted on.
  // Keyed on the chat's scope too, because sibling chats share the record.
  const handoffAccountGeneration = handoffRecord?.accountGeneration;
  const handoffIdentityReady =
    handoffRecord?.accountKey !== undefined &&
    handoffRecord.identityUnverified === false;
  useEffect(() => {
    if (
      storeMode &&
      handoffId !== null &&
      handoffRecordRef.current?.identityUnverified
    ) {
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
    }
    // Retry on re-entry only. Identity updates themselves must not cause a
    // retry loop while the account remains unreadable.
  }, [storeMode, handoffId, aiCreditsScopeKey]);
  useEffect(() => {
    if (!storeMode) return;
    // An older generation may still be awaiting a bridge read. Detach its
    // local latch so verified identity can start a fresh session read.
    operationRef.current = null;
    cancelMinimumBusyHold();
    setBusy(false);
    setReopenPending(false);
    coveredRef.current = false;
    coveredCommitRef.current = null;
  }, [storeMode, handoffId, handoffAccountGeneration, cancelMinimumBusyHold]);
  useEffect(() => {
    if (!storeMode || handoffId === null || !handoffIdentityReady) return;
    const created = createdHandoffRef.current;
    createdHandoffRef.current = null;
    if (created?.id === handoffId && created.scopeKey === aiCreditsScopeKey) {
      return;
    }
    void checkCoverage(true, true);
  }, [
    storeMode,
    handoffId,
    handoffAccountGeneration,
    handoffIdentityReady,
    aiCreditsScopeKey,
    checkCoverage,
  ]);

  // §5 post-purchase return. Registered ONLY while handed off to billing, so an
  // ordinary alt-tab away from the picker costs nothing.
  useEffect(() => {
    if (!handedOff) {
      return;
    }
    const onReturn = (): void => {
      // Returning to the app is the moment a just-completed checkout becomes
      // observable, so it is the moment worth spending a probe on.
      if (document.visibilityState === 'hidden') return;
      void checkCoverage(false);
    };
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    return (): void => {
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, [handedOff, checkCoverage]);

  /**
   * Route the purchase through the shared cloud connect gate rather than
   * opening billing directly. A guest credential is "technically connected" (it
   * has a device key) but cannot buy credits, so a bare billing open would dead
   * end them. `requestConnect` short-circuits when a real account is already
   * connected, so a signed-in user goes straight to billing in one click.
   */
  const beginBillingHandoff = useCallback((): void => {
    // Cleared BEFORE the already-started guard, not after. Reaching this
    // function at all means this CTA is no longer waiting on a gate, so an
    // early return that skips the reset leaves the flag armed — and a stale
    // `true` lets the NEXT unrelated cloud gate to close (Remote Control, an
    // upgrade nudge) drive this CTA's `proceedAfterConnect` and open a billing
    // page nobody asked for.
    awaitingCloudGateRef.current = false;
    if (handoffStartedRef.current) return;
    // Store mode: one initial open per purchase scope. A hand-off already
    // pending there (a sibling's) is adopted rather than opened again.
    const storeWalletKey = walletKeyRef.current;
    const accountGeneration =
      useAiCreditsHandoffStore.getState().accountGeneration;
    let openingLatch: object | null = null;
    if (storeWalletKey !== null) {
      const opening = openingLatchRef.current;
      if (
        opening?.walletKey === storeWalletKey &&
        opening.accountGeneration === accountGeneration
      ) {
        openingLatch = opening.token;
      } else {
        clearArrivalHandoff();
        openingLatch = aiCreditsPurchaseStore.claimOpening(storeWalletKey);
      }
      if (openingLatch === null) {
        clearArrivalHandoff();
        setBusy(false);
        return;
      }
    }
    handoffStartedRef.current = true;
    // A fresh hand-off is a fresh chance to commit. A previous host callback
    // can still be pending, so revoke its ownership of this latch as well.
    coveredRef.current = false;
    coveredCommitRef.current = null;
    setHandoffFailed(false);
    setLocalCheckFeedback(null);
    // Reuses the click's hand-off; one made after a sign-in starts here.
    ensureArrivalHandoff();
    void (async (): Promise<void> => {
      const requestScopeKey = scopeKeyRef.current;
      const generation = lifecycleRef.current;
      const scope = scopeRef.current;
      const releaseLatch = (): void => {
        if (storeWalletKey !== null && openingLatch !== null) {
          aiCreditsPurchaseStore.releaseOpening(storeWalletKey, openingLatch);
          if (openingLatchRef.current?.token === openingLatch) {
            openingLatchRef.current = null;
          }
        }
      };
      const isCurrent = (): boolean =>
        mountedRef.current &&
        lifecycleRef.current === generation &&
        scopeKeyRef.current === requestScopeKey &&
        (storeWalletKey === null ||
          useAiCreditsHandoffStore.getState().accountGeneration ===
            accountGeneration);
      // Wait for a conclusive read first: `openBillingPage`'s unauthenticated
      // fallback needs `pricingUrl`, and without it a rejected authenticated
      // hand-off opens NOTHING.
      const native = await resolveAvailabilityForHandoff();
      // Check BEFORE opening, not after. `openBillingPage` has a visible side
      // effect — a browser tab or the Settings overlay — so a post-open bail
      // still leaves the user looking at a page they can no longer connect to
      // anything they did.
      if (!isCurrent()) {
        releaseLatch();
        if (mountedRef.current && lifecycleRef.current === generation) {
          clearArrivalHandoff();
          handoffStartedRef.current = false;
          setBusy(false);
        }
        return;
      }
      const arrivalHandoff = arrivalHandoffRef.current;
      arrivalHandoff?.markExternalOpen();
      let result: BillingPageOpenResult;
      try {
        result = await aiCreditsPurchaseStore.openHandoff({
          availability: native,
          scope,
          options: billingOpenOptions(billingDestinationRef.current),
        });
      } catch {
        result = 'failed';
      } finally {
        releaseLatch();
      }
      // A late result never attaches to another chat or account: the scope
      // change already cancelled the provisional arrival handle.
      if (!isCurrent()) {
        arrivalHandoff?.cancel();
        if (mountedRef.current && lifecycleRef.current === generation) {
          handoffStartedRef.current = false;
          setBusy(false);
        }
        return;
      }
      setBusy(false);
      if (result === 'web') {
        const owned = arrivalHandoffRef.current === arrivalHandoff;
        if (owned) arrivalHandoff?.retain();
        if (storeWalletKey === null) {
          setLocalHandedOff(true);
          return;
        }
        // Ownership of the arrival handle moves to the store, which keeps
        // it across chat switches and unmounts.
        arrivalHandoffRef.current = null;
        const record = aiCreditsPurchaseStore.begin({
          walletKey: storeWalletKey,
          originChatKey: originChatKeyRef.current,
          originScopeKey: requestScopeKey,
          origin: confirmArrivalRef.current ?? null,
          accountGeneration,
          arrival: owned ? arrivalHandoff : null,
        });
        // The record is the scope's latch from here; this instance's own
        // one-shot latch opens again for after it ends.
        handoffStartedRef.current = false;
        if (record !== null) {
          createdHandoffRef.current = {
            id: record.id,
            scopeKey: requestScopeKey,
          };
        }
        return;
      }
      // Not a browser hand-off: release the one-shot latch so the button works
      // again.
      handoffStartedRef.current = false;
      clearArrivalHandoff();
      if (result === 'settings') {
        // The user is looking at Settings → Billing inside the app, so there
        // is no browser return to wait for. This CTA stops tracking the
        // purchase; `openBillingPage` re-reads AI Credits for every mounted
        // surface once Settings closes. Call the host last: it may unmount us.
        onOpenedInAppRef.current?.();
        return;
      }
      // Nothing opened. Say so and keep the button live rather than parking the
      // user on "finish this in your browser" for a page that never appeared.
      setHandoffFailed(true);
    })();
  }, [
    clearArrivalHandoff,
    ensureArrivalHandoff,
    resolveAvailabilityForHandoff,
  ]);

  /**
   * What to do once an account is connected.
   *
   * Coverage is re-read FIRST. Signing in is itself a way to acquire credits —
   * a new account starts with free ones, which is exactly what the guest copy
   * promises — so handing a now-covered user off to a BILLING page would
   * contradict the offer they just accepted and park them on "Check again"
   * until they happened to alt-tab back.
   */
  const proceedAfterConnect = useCallback((): void => {
    void (async (): Promise<void> => {
      const generation = lifecycleRef.current;
      const outcome = await commitIfAlreadyCovered();
      if (!mountedRef.current || lifecycleRef.current !== generation) return;
      if (outcome === 'covered') {
        awaitingCloudGateRef.current = false;
        return;
      }
      if (outcome === 'gone') {
        // The affordance that asked for this is no longer on screen — the user
        // cancelled, or another path committed and tore it down. Opening an
        // external billing page for a request nobody is waiting on is the one
        // outcome worse than doing nothing: it is unattributable to any action
        // the user can still see.
        awaitingCloudGateRef.current = false;
        clearArrivalHandoff();
        setBusy(false);
        return;
      }
      if (outcome === 'unknown') {
        // We do not know whether they have credits, so we must not act as if we
        // know they do not — but we must not go silent either. Only the
        // recovery modal has an inconclusive branch to explain this; the two
        // banners and the picker footer have none, so without saying something
        // here an explicit purchase click just stops.
        //
        // ...unless the host's affordance EXISTS because this read was already
        // inconclusive, in which case reporting the failure is the dead end and
        // the hand-off is the useful answer. See `handoffOnInconclusiveRead`.
        if (handoffOnInconclusiveRead) {
          beginBillingHandoff();
          return;
        }
        awaitingCloudGateRef.current = false;
        clearArrivalHandoff();
        if (mountedRef.current) {
          setBusy(false);
          setReadFailed(true);
        }
        return;
      }
      beginBillingHandoff();
    })();
  }, [
    beginBillingHandoff,
    clearArrivalHandoff,
    commitIfAlreadyCovered,
    handoffOnInconclusiveRead,
  ]);

  const requestBillingHandoff = useCallback((): void => {
    clearArrivalHandoff();
    const storeWalletKey = walletKeyRef.current;
    if (storeWalletKey !== null) {
      const token = aiCreditsPurchaseStore.claimOpening(storeWalletKey);
      if (token === null) {
        setBusy(false);
        return;
      }
      openingLatchRef.current = {
        walletKey: storeWalletKey,
        token,
        accountGeneration:
          useAiCreditsHandoffStore.getState().accountGeneration,
      };
    }
    awaitingCloudGateRef.current = true;
    sawCloudGateRef.current = false;
    // Open a fresh availability episode for this attempt.
    //
    // The gate close does this too, but an already-signed-in user never sees a
    // gate: `requestConnect` short-circuits and runs `proceedAfterConnect`
    // straight away. Without this, that path would decide whether to charge
    // someone from an answer retained since this button mounted. There is no
    // second reader on the short-circuit path (the modal's gate-close effect
    // requires a gate that actually opened), so nothing loses its shared answer
    // by starting a new episode here.
    invalidateSharedAiCreditsRead();
    // Read the baseline alongside coverage, after claiming shared ownership:
    // a sibling that loses the latch must not supersede the winning handle.
    ensureArrivalHandoff();
    const generation = lifecycleRef.current;
    const requestScopeKey = scopeKeyRef.current;
    const connectContext = getAiCreditsConnectContext({
      destination: billingDestinationRef.current,
    });
    requestConnect(connectContext, (): void => {
      if (
        !mountedRef.current ||
        lifecycleRef.current !== generation ||
        scopeKeyRef.current !== requestScopeKey
      )
        return;
      proceedAfterConnect();
    });
  }, [
    clearArrivalHandoff,
    ensureArrivalHandoff,
    proceedAfterConnect,
    requestConnect,
  ]);

  // When the shared cloud modal closes, it performs its own account re-check
  // before invoking `proceed`. Mirror that read so a cancelled gate can clear
  // this button's busy state, while a successful sign-in keeps the spinner in
  // the originating affordance until the guarded billing hand-off runs.
  useEffect(() => {
    if (!awaitingCloudGateRef.current) return;
    if (cloudGatePending) {
      sawCloudGateRef.current = true;
      return;
    }
    if (!sawCloudGateRef.current) return;
    const generation = lifecycleRef.current;
    void window.api
      .loadCanopyCloudAccount()
      .then((account) => {
        if (
          !mountedRef.current ||
          lifecycleRef.current !== generation ||
          !awaitingCloudGateRef.current
        )
          return;
        if (isConnectedNonGuest(account)) {
          // Coverage first: a just-created account may already have the free
          // starting credits the guest copy promised.
          proceedAfterConnect();
          return;
        }
        awaitingCloudGateRef.current = false;
        clearArrivalHandoff();
        setBusy(false);
      })
      .catch(() => {
        if (!mountedRef.current || lifecycleRef.current !== generation) return;
        awaitingCloudGateRef.current = false;
        clearArrivalHandoff();
        setBusy(false);
      });
  }, [clearArrivalHandoff, cloudGatePending, proceedAfterConnect]);

  const handleGetCredits = useCallback((): void => {
    onGetCreditsClickRef.current?.();
    setBusy(true);
    // A new attempt supersedes EVERY previous verdict, not just the newest
    // one. Clearing only `readFailed` let the two warning lines stack: a first
    // attempt that opened nothing leaves `handoffFailed` up, and a second that
    // cannot read coverage adds `readFailed` beneath it — two `role="status"`
    // regions giving one click two different explanations.
    setHandoffFailed(false);
    setReadFailed(false);
    if (!onNeedsRecovery) {
      requestBillingHandoff();
      return;
    }

    // Case C lives in the picker footer, where account-state explanations do
    // not fit. Read the real state before deciding whether this can remain a
    // one-click billing hand-off or must escalate into ModelRecoveryModal.
    void (async (): Promise<void> => {
      const requestScopeKey = scopeKeyRef.current;
      const generation = lifecycleRef.current;
      let native: NativeAiCreditsAvailability | null = null;
      let account: CanopyCloudAccountPublicState | null | undefined;
      try {
        // Read through the SHARED helper, not the bridge directly. A raw read
        // is neither retained for the episode (so a shared reader a microtask
        // later could legitimately return a different answer about the same
        // account — the disagreement `openBillingPage.ts` states can never
        // happen) nor epoch-stamped, so it could not be retracted if credits
        // drained mid-flight. `commitCovered()` below flips the chat's billing
        // framework on this answer, so it must be retractable. `fresh: true`
        // matches the intent — this click is asking the question now — and
        // opens the episode `requestBillingHandoff` would otherwise open a
        // moment later.
        [native, account] = await Promise.all([
          readAvailabilitySafely({ fresh: true, scope: scopeRef.current }),
          window.api.loadCanopyCloudAccount(),
        ]);
      } catch {
        native = null;
        account = null;
      }
      if (
        !mountedRef.current ||
        lifecycleRef.current !== generation ||
        scopeKeyRef.current !== requestScopeKey
      ) {
        return;
      }
      availabilityRef.current = native;

      const coverage = resolveCreditsCoverage(native);
      if (coverage.canSpendCredits) {
        setBusy(false);
        announceAiCreditsChanged();
        void commitCovered();
        return;
      }
      if (
        native === null ||
        native.inconclusive === true ||
        !isConnectedNonGuest(account) ||
        coverage.showContactAdmin
      ) {
        setBusy(false);
        onNeedsRecovery();
        return;
      }
      requestBillingHandoff();
    })();
  }, [commitCovered, onNeedsRecovery, requestBillingHandoff]);

  if (handedOff) {
    const checkAgain = (
      <Button
        variant={buttonVariant}
        size={buttonSize}
        ref={checkAgainButtonRef}
        data-testid={`${dataTestId}-check-again`}
        // Honors the host's inert gate as well as our own busy state, exactly
        // like the primary button below. A host that knows its own read is in
        // flight means it for every control in this CTA, not just the one it
        // happened to be looking at when it passed the prop.
        disabled={busy || disabled || reopenPending}
        aria-busy={busy}
        onMouseDown={(e): void => e.preventDefault()}
        // Forced: bypasses the §5 throttle so a user returning inside the
        // 60s window gets a real read instead of a silent no-op.
        onClick={(): void => void checkCoverage(true)}
      >
        {busy && (
          <span
            className="pointer-events-none absolute inset-y-0 left-0.5 flex items-center"
            aria-hidden="true"
          >
            <LoadingSpinner dataTestId={`${dataTestId}-spinner`} decorative />
          </span>
        )}
        {AI_CREDITS_CHECK_AGAIN_LABEL}
      </Button>
    );

    // Compact: one button, no stacked paragraph, so a banner's action bar
    // keeps its shape. The host's notice copy explains the hand-off.
    if (handoffLayout === 'compact') {
      return (
        <span
          className="inline-flex shrink-0 items-center"
          data-testid={`${dataTestId}-handoff`}
        >
          {checkAgain}
        </span>
      );
    }

    return (
      <div
        className="flex flex-col gap-1.5"
        data-testid={`${dataTestId}-handoff`}
      >
        <p className="text-2xs leading-snug fg-secondary">
          <span className="font-medium fg-primary">{HANDOFF_COPY.title}.</span>{' '}
          {HANDOFF_COPY.message}
        </p>
        {checkAgain}
        {/* Always mounted while handed off, so a new verdict is a change
            inside an existing polite region rather than a new region. */}
        <div
          role="status"
          aria-live="polite"
          data-testid={`${dataTestId}-check-feedback-region`}
        >
          {checkFeedbackState ? (
            <AiCreditsCheckFeedback
              kind={checkFeedbackState.kind}
              {...(checkFeedbackState.onReopenBilling
                ? { onReopenBilling: checkFeedbackState.onReopenBilling }
                : {})}
              reopenPending={checkFeedbackState.reopenPending}
              reopenDisabled={checkFeedbackState.reopenDisabled}
              dataTestId={`${dataTestId}-check-feedback`}
            />
          ) : null}
        </div>
      </div>
    );
  }

  const containerClass =
    handoffLayout === 'compact'
      ? 'inline-flex shrink-0 flex-col items-stretch gap-1.5'
      : variant === 'inline'
        ? 'flex flex-col gap-1.5 pt-1.5'
        : 'flex flex-col gap-1.5';

  return (
    <div className={containerClass}>
      {description ? (
        <p className="text-2xs leading-snug fg-secondary">{description}</p>
      ) : null}
      <Button
        variant={buttonVariant}
        size={buttonSize}
        ref={primaryButtonRef}
        data-testid={dataTestId}
        disabled={busy || disabled}
        aria-busy={busy || disabled}
        onMouseDown={(e): void => e.preventDefault()}
        onClick={handleGetCredits}
      >
        {busy && (
          <LoadingSpinner dataTestId={`${dataTestId}-spinner`} decorative />
        )}
        {label}
      </Button>
      {/* Nothing opened (no authenticated hand-off AND no pricing URL). Saying
          so beats parking the user on a "finish this in your browser" state for
          a page that never appeared. */}
      {handoffFailed ? (
        <p
          role="status"
          data-testid={`${dataTestId}-handoff-failed`}
          className="text-2xs leading-snug fg-warning"
        >
          We couldn&apos;t open your billing page. Check your connection and try
          again.
        </p>
      ) : null}
      {/* The post-connect read never resolved, so we genuinely do not know
          whether this user needs to buy anything. Say that, rather than
          silently doing nothing or asserting a balance we did not read. */}
      {readFailed ? (
        <p
          role="status"
          data-testid={`${dataTestId}-read-failed`}
          className="text-2xs leading-snug fg-warning"
        >
          We couldn&apos;t check your account. Check your connection and try
          again.
        </p>
      ) : null}
    </div>
  );
}
