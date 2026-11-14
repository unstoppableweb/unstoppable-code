import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type {
  AgentProviderType,
  NativeAiCreditsAvailability,
} from '@canopy/desktop-shared/types';
import { brandText } from '@/lib/brand';
import { resolveAiCreditsCoverage } from '@/lib/openBillingPage';
import { getModelCatalogProviderLabel } from '@canopy/ui-shared';
import {
  AiCreditsArrivedNotice,
  AI_CREDITS_PURCHASE_LABEL,
  AI_CREDITS_REOPEN_BILLING_LABEL,
  CreditsRecoveryNotice,
  DISPATCH_DEAD_END_COPY,
  NoticeButton,
  POLICY_BILLING_DEAD_END_COPY,
  POLICY_ONLY_DEAD_END_COPY,
  connectProviderLabel,
  creditsOnlyDeadEndCopy,
  failedTurnCopy,
  notSignedInCopy,
  type CreditsRecoveryCopy,
} from '@canopy/ui-shared/components';
import { TimeslotIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  GetAiCreditsCta,
  type GetAiCreditsHandoffState,
} from './GetAiCreditsCta';
import type { AiCreditsCheckFeedbackKind } from '@canopy/ui-shared';
import { aiCreditsHandoffCopy } from './aiCreditsHandoffCopy';
import {
  useAiCreditsWalletKey,
  useChatTargetAiCreditsScope,
} from '@/lib/aiCreditsScope';
import {
  selectAiCreditsHandoff,
  useAiCreditsHandoffStore,
} from '@/stores/aiCreditsHandoffStore';
import {
  clearAiCreditsArrival,
  markAiCreditsArrivalRouted,
  selectAiCreditsArrivalEvidence,
  selectAiCreditsArrivalForChat,
  useAiCreditsArrivalStore,
  type AiCreditsArrivalOrigin,
} from '@/lib/aiCreditsArrivalConfirmation';
import {
  chatBannerKey,
  useNoBillingSourceSignal,
  type ChatBannerTarget,
  type NoBillingSourceSignal,
} from '@/stores/aiCreditsBannerStore';
import {
  trackCreditsRecoveryClick,
  type CreditsRecoveryTrigger,
} from '@/lib/creditsRecoveryTelemetry';
import { CreditsRecoveryView } from './CreditsRecoveryView';
import { AuthLoginModal } from '@/components/settings/AuthLoginModal';
import type { ProviderModelAvailability } from '@/hooks/useProviderAvailability';
import type { BillingLane } from '@canopy/desktop-shared/lib/default-model-lane';

/**
 * Button tiers mirror `AiCreditsUsageLimitBanner` so every recovery action
 * across every chat banner reads as one system: the house `Button` recipe,
 * `primary` for the single recommended action and `secondary` for the
 * alternative. CAN-4766: "Connect {provider}" leads where it shows and
 * "Buy AI Credits" follows; the purchase is primary only when it stands alone
 * or a hand-off is waiting on it.
 */

/** The purchases this banner confirms. The usage-limit banner owns its own. */
const ARRIVAL_ORIGINS: readonly AiCreditsArrivalOrigin[] = [
  'no-billing-source',
  'model-picker',
];

export interface NoBillingSourceBannerProps {
  /** Provider the current model resolves to. Only `claude` / `codex` can bill. */
  provider: AgentProviderType;
  /** The main-owned queue is preserving a prompt after a credit refusal. */
  queuedCreditHeld?: boolean;
  /** Live native-auth / credits availability for that provider. */
  availability: ProviderModelAvailability;
  /**
   * True while `OrgLapsedBanner` is already explaining this same dead end
   * (CAN-2311 review round 3). See the sequencing note on that banner's
   * `onVisibleChange`: a lapsed org zeroes its credit pool, so its members trip
   * this banner's condition too, and stacking the two hands the user "Buy AI
   * Credits" directly above "Contact your org admin to restore your team". The
   * banner that names the cause goes first; this one takes over the moment that
   * one is dismissed or the org is restored, so the self-serve remedies are
   * deferred, never lost.
   */
  orgLapseVisible?: boolean;
  /**
   * Chat this composer belongs to, used to read the runtime no-billing-source
   * signal (CAN-2413). `null` on surfaces without a resolvable chat target,
   * which simply leaves the pre-flight (derived) path as the only trigger.
   */
  target?: ChatBannerTarget | null;
  /** Committed refusal for canonical chats, including an explicit absence. */
  persistedRefusal?: NoBillingSourceSignal | null;
  /**
   * True when the selected model can ONLY run through the gateway. A native
   * provider login cannot run that model, so the sign-in button would be a dead
   * end and is hidden. Sourced from the same `isGatewayOnlyModel` helper the
   * billing toggle uses, so the two never disagree about what a login buys.
   */
  gatewayOnlyModel?: boolean;
  /**
   * Effective billing framework for this chat, from the same
   * `resolveChatBillingFramework` call that drives the composer's billing
   * toggle (CAN-2413 review).
   *
   * Scopes the RUNTIME signal only. A user who reacts to this banner by
   * switching the chat to Subscription has already resolved the problem: the
   * next turn bills a native login, not credits, and `selectBillingFramework`
   * does not clear the stored signal — so without this the banner keeps
   * insisting credits are required and recommends an action the user just took.
   *
   * Deliberately `!== 'subscription'` rather than `=== 'ai-credits'`: when the
   * framework is unresolved (for example, no model) the banner keeps today's
   * behavior. Only an explicit switch away suppresses it.
   * The derived pre-flight path is untouched — it describes an account that
   * cannot pay either way.
   */
  effectiveBillingFramework?: 'subscription' | 'ai-credits' | null;
  /**
   * Set when default-model lane resolution found NO dispatchable (lane, model)
   * pair at all — the CAN-1929 dead end.
   *
   * Distinct from every other trigger here, and the distinction is the point:
   * `derived` says "no billing source", which can be flatly wrong for this
   * case. A user with a perfectly good Claude subscription whose org allows
   * only gateway-routed models has a billing source; what they lack is one
   * that intersects their policy allowance. `missing` names which half is
   * absent so the CTA can point at the remedy that actually helps.
   */
  noDispatchableModel?: {
    missing: 'billing-lane' | 'policy-allowance' | 'both';
    lanesNeeded?: readonly BillingLane[];
    /**
     * Whether an org model policy is actually in force. See the note on the
     * producing memo in `ChatInput`: `missing`/`lanesNeeded` alone cannot tell
     * an org allowlist apart from a default model that is simply gateway-only,
     * and only the org-flavored copy below may act on the difference.
     */
    policyRestricted?: boolean;
    /**
     * Whether the resolver still found a runnable, policy-allowed candidate on
     * some lane. Separates the billing-shaped `missing: 'both'` (an allowed
     * lane exists but is unpaid) from the allowlist-shaped one (no allowed
     * runnable model anywhere), which need opposite remedies (CAN-2436).
     */
    hasPolicyAllowedLane?: boolean;
  } | null;
  /**
   * The composer's streaming state. Used only to retire the arrival
   * confirmation when the next turn starts (CAN-5160).
   */
  turnActive?: boolean;
  /**
   * True while the composer shows the "Using AI Credits" card for this chat.
   * The card has its own arrival state (CAN-5159), so credits bought here are
   * confirmed there instead of in a second notice beside it. Defaults to
   * `false`.
   */
  aiCreditsCardVisible?: boolean;
  /**
   * True when the same billing resolver says that card WILL show once this
   * chat can spend credits. The CTA learns about a purchase before the
   * composer's eligibility read does, so without this the notice would flash
   * for a frame before the card takes over. Defaults to `false`.
   */
  aiCreditsCardExpected?: boolean;
}

/**
 * "Nothing can pay for this turn" banner (ECW-9091).
 *
 * A user with neither a native provider login nor spendable AI Credits used to
 * get no signal at all until they sent a message and hit a raw
 * `Not logged in · Please run /login` — a message that names one remedy and
 * hides the other. This banner surfaces the dead end up front and offers both
 * ways out.
 *
 * Rendered once in the universal `ChatInput`, so it reaches every chat surface.
 * It needs no IPC or store plumbing of its own beyond the native availability
 * read that decides purchase-vs-contact-admin: the visibility condition is
 * derived from `useProviderAvailability`, which the input already consumes.
 *
 * Note the deliberate asymmetry with the main-process backstop: this banner
 * hides while availability is `loading` (an inconclusive auth probe is not a
 * confirmed logout). The billing resolver keeps subscription choice reachable
 * through that same probe blip; this banner still avoids claiming sign-out.
 * Provider credentials supplied through Canopy Environments count toward
 * `nativeAuth` in `useProviderAvailability`, as they do in the send path.
 */
export function NoBillingSourceBanner({
  provider,
  queuedCreditHeld = false,
  availability,
  orgLapseVisible = false,
  target = null,
  persistedRefusal,
  gatewayOnlyModel = false,
  effectiveBillingFramework = null,
  noDispatchableModel = null,
  turnActive = false,
  aiCreditsCardVisible = false,
  aiCreditsCardExpected = false,
}: NoBillingSourceBannerProps): JSX.Element | null {
  const [nativeAvailability, setNativeAvailability] =
    useState<NativeAiCreditsAvailability | null>(null);
  // `nativeAvailability === null` is ambiguous on its own: it means BOTH "the
  // read has not come back yet" and "the read came back empty / rejected". The
  // fallback CTA below must distinguish them (CAN-2413 review round 2) —
  // offering an enabled purchase button during the pending window lets an org
  // member whose pool is exhausted click through to a billing flow they cannot
  // use, before the coverage read that would have told them to contact their
  // admin has resolved. That is the exact dead end this round set out to close,
  // reintroduced through the fix for it.
  const [coverageSettled, setCoverageSettled] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  // The credits CTA's controls for the retained hand-off, with the chat they
  // were reported in (CAN-5162, CAN-5534).
  const [handoff, setHandoff] = useState<{
    readonly state: GetAiCreditsHandoffState;
    readonly chatKey: string | null;
  } | null>(null);
  const liveRefusal = useNoBillingSourceSignal(
    persistedRefusal === undefined ? target : null,
  );
  const runtimeSignal =
    persistedRefusal === undefined ? liveRefusal : persistedRefusal;
  // Coverage is a question about THIS chat's owner (CAN-3463).
  const creditsScope = useChatTargetAiCreditsScope(target);
  // The browser checkout pending in this chat's purchase scope, from this
  // chat or a sibling (CAN-5534). It outlives this banner, so the waiting
  // copy is derived from it rather than from the CTA's report.
  const walletKey = useAiCreditsWalletKey(target);
  const pendingHandoff = useAiCreditsHandoffStore((s) =>
    selectAiCreditsHandoff(s, walletKey),
  );
  // A surface without a chat target keeps the CTA's local hand-off, as before.
  const currentHandoff: {
    readonly id: string | null;
    readonly feedback: AiCreditsCheckFeedbackKind | null;
  } | null =
    walletKey !== null
      ? pendingHandoff
      : handoff === null
        ? null
        : { id: null, feedback: handoff.state.feedback };
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

  const billable = provider === 'claude' || provider === 'codex';
  // Today's pre-flight condition, unchanged: nothing can pay for the NEXT turn.
  const derived =
    !availability.loading &&
    !availability.nativeAuth &&
    !availability.creditsEligible;
  // The runtime trigger deliberately BYPASSES `!availability.nativeAuth`, and
  // that bypass is the entire CAN-2413 fix. The reported state is a user with a
  // working native Codex login on a gateway-only model: the native login is
  // real, so the derived condition is false forever, while the turn still died
  // on an empty credit balance. Requiring `!nativeAuth` here is precisely why
  // the banner never rendered for the failure it exists to explain.
  //
  // `runtimeSignal` is evidence from a turn that already failed, not a probe,
  // so it does not wait on `availability.loading` either.
  //
  // `orgLapseVisible` folds into `visible` rather than into the early return
  // below, so a deferral behaves exactly like the probe-in-flight case: the
  // banner body hides while any login modal it already opened stays mounted.
  //
  // ...but a signal from a turn that already failed still goes stale the moment
  // the user routes around it. Switching this chat to Subscription billing is
  // exactly that: `selectBillingFramework` drops `aiCreditsRouting` and sets
  // `subscriptionBillingOverride` without touching the stored signal, so the
  // banner would keep demanding credits for a chat whose next turn bills a
  // native login instead. Scope the runtime trigger to a chat that is still on
  // the credits route (see `effectiveBillingFramework`).
  const runtimeSignalActive =
    runtimeSignal !== null && effectiveBillingFramework !== 'subscription';
  // The lane resolver already did the joint availability x policy walk and came
  // up empty, so this is a conclusion, not a probe — it does not wait on
  // `availability.loading` any more than the runtime signal does.
  const dispatchDeadEnd = noDispatchableModel !== null;
  // The org-flavored arms REQUIRE a real policy (CAN-2436). `lanesNeeded` is
  // built from lanes that have a runnable, policy-allowed default candidate, so
  // a lane also drops out when nothing is runnable on it for reasons that have
  // nothing to do with an allowlist — a gateway-only default model yields
  // exactly `['ai-credits']` for a user with no organization at all. Claiming
  // "your organization only allows…" there is simply false, and it displaced
  // the accurate CAN-2413/ECW-9091 copy below.
  const policyRestricted = noDispatchableModel?.policyRestricted === true;
  const creditsOnlyDeadEnd =
    policyRestricted &&
    noDispatchableModel?.lanesNeeded?.length === 1 &&
    noDispatchableModel.lanesNeeded[0] === 'ai-credits';
  // `missing: 'policy-allowance'` with NO lane named is a different dead end
  // from `creditsOnlyDeadEnd`: it means the org allowlist leaves nothing
  // runnable on ANY lane, credits included. Telling that user their org "only
  // allows models that require AI Credits" — and offering a Buy AI Credits CTA
  // that cannot possibly unblock them — is both wrong and a spend prompt for
  // nothing. Their only route through is the org admin.
  //
  // Same `policyRestricted` requirement as above, and for the same reason: this
  // arm sends the user to an org admin and suppresses every credits CTA
  // (`creditsCanHelp`), which is a dead end of its own for someone who has no
  // organization. `missing: 'policy-allowance'` is reachable without a policy
  // whenever no lane has a runnable candidate at all.
  //
  // `missing: 'both'` with NO policy-allowed lane is the same dead end wearing
  // a different label (CAN-2436 review): the resolver reports `both` whenever
  // nothing is confirmed available, and when the allowlist leaves no runnable
  // candidate on ANY lane there is no billing source that could help either.
  // `hasPolicyAllowedLane` is the resolver fact that separates it from the
  // billing-shaped `both` the copy below still describes.
  const policyOnlyDeadEnd =
    policyRestricted &&
    ((noDispatchableModel?.missing === 'policy-allowance' &&
      (noDispatchableModel.lanesNeeded?.length ?? 0) === 0) ||
      (noDispatchableModel?.missing === 'both' &&
        noDispatchableModel.hasPolicyAllowedLane === false));
  const visible =
    billable &&
    !orgLapseVisible &&
    (derived || runtimeSignalActive || dispatchDeadEnd);

  // Re-arm the coverage gate for EVERY read, DURING RENDER (CAN-2413 review
  // round 4). This is React's documented adjust-state-during-render pattern,
  // not an effect, and the distinction is the whole point: a passive
  // `useEffect` reset runs *after* the re-entry render has already committed,
  // so there is one live frame showing the previous read's enabled CTA before
  // the reset lands. React instead discards this render and immediately
  // re-renders with the adjusted state, so that frame never reaches the DOM
  // and is never clickable.
  //
  // Why re-arm at all: this component stays mounted while `visible` cycles
  // (org-lapse toggling, `AuthLoginModal` force-refreshing the auth probe, a
  // Subscription switch and back), and each cycle starts a fresh read. A flag
  // that only latched true left the CTA enabled from a previous — possibly
  // FAILED — read while the new one was still in flight.
  const [readVisible, setReadVisible] = useState(visible);
  if (visible !== readVisible) {
    setReadVisible(visible);
    if (visible) {
      setCoverageSettled(false);
    }
  }

  /**
   * Bumped when the shared CTA's fresher read concludes the account is covered.
   *
   * The read below runs once per `visible` cycle, and `visible` is driven by
   * `runtimeSignalActive` on the CAN-2413 path rather than by `creditsEligible`
   * — so without this the banner would keep its stale "no billing source" copy
   * over an account that can now pay, and the click that discovered it would be
   * entirely silent. Mirrors the `refreshCoverage` token in
   * `AiCreditsUsageLimitBanner`.
   */
  const [refreshCoverage, setRefreshCoverage] = useState(0);

  // The richer native read (org coverage + pricing URL) that decides which CTA
  // to show. `useAiCreditsAvailability` only returns `{ eligible, loading }`,
  // so it cannot distinguish "buy credits" from "contact your org admin".
  // Loaded only while the banner is actually visible.
  // Another owner's answer must never stand in for this one's, even while the
  // new read is in flight: drop it the moment the chat's owner scope changes.
  // Declared before the read so a scope change resets, then re-reads.
  useEffect(() => {
    setNativeAvailability(null);
    setCoverageSettled(false);
  }, [creditsScope]);

  useEffect(() => {
    if (!visible) {
      return;
    }
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        const native =
          await window.api.loadNativeAiCreditsAvailability(creditsScope);
        if (!cancelled) {
          setNativeAvailability(native);
        }
      } catch {
        if (!cancelled) {
          setNativeAvailability(null);
        }
      } finally {
        // Settled either way — a rejected read is a CONCLUSIVE "we could not
        // determine coverage", which is what unblocks the fallback CTA. Only
        // the still-in-flight window keeps it disabled.
        if (!cancelled) {
          setCoverageSettled(true);
        }
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [visible, refreshCoverage, creditsScope]);

  // The modal must NOT be gated on `visible`: its own mount force-refreshes
  // the provider auth probe, which flips `availability.loading` true and
  // hides the banner. Unmounting the modal with the banner produced an
  // infinite open → refresh → hide → remount blink loop; instead the banner
  // body hides on its own while the modal stays up until its own onClose.
  const providerLabel = getModelCatalogProviderLabel(provider);
  const coverage = resolveAiCreditsCoverage(nativeAvailability);
  const { showPurchase } = coverage;
  // A pure policy dead end is always an admin conversation, whatever the
  // account's credit coverage says.
  const showContactAdmin = coverage.showContactAdmin || policyOnlyDeadEnd;

  // A native login cannot run a gateway-only model, so offering "Connect
  // {provider}" there sends the user through an auth flow that leaves them
  // exactly as stuck. Credits are the only remedy for that model.
  //
  // `!nativeAuth` is the second half of the same rule (CAN-2413 review): on the
  // runtime path the user may ALREADY be signed in natively — that is the exact
  // reported state — so "Connect Codex" asks them to redo something they
  // have done. The derived path still shows it, since `derived` requires
  // `!nativeAuth` to be true in the first place.
  //
  // A pure POLICY dead end is the third case: every lane the user can pay for
  // is blocked by the org allowlist, so another login changes nothing.
  const showSignIn =
    !gatewayOnlyModel &&
    !availability.nativeAuth &&
    noDispatchableModel?.missing !== 'policy-allowance' &&
    (noDispatchableModel?.lanesNeeded === undefined ||
      noDispatchableModel.lanesNeeded.some(
        (lane) => lane === 'claude-native' || lane === 'codex-native',
      ));

  // Last-resort credits CTA. `resolveAiCreditsCoverage(null)` returns
  // `showPurchase: false` AND `showContactAdmin: false`, and `nativeAvailability`
  // is null both on the first render after the banner becomes visible (the
  // effect above only runs once `visible` flips true, so this is a guaranteed
  // flash, not just an error case) and permanently if that IPC rejects. Combined
  // with a hidden sign-in button that left a banner whose entire purpose is
  // recovery rendering ZERO actions, plus a stray footer divider under it —
  // flagged independently by both reviewers and by Copilot.
  //
  // Offering credits here does not resurrect the "don't push a paying user at
  // the purchase page" hazard that made `showPurchase` conservative: we only
  // reach this branch when the user has no other way forward, and the CTA
  // routes through the cloud-connect gate (`useGetAiCreditsAction`), which
  // opens the authenticated billing page without needing the availability read.
  //
  // Gated on `coverageSettled` so it cannot fire during the in-flight window:
  // while the read is pending we still RENDER the button (so the banner is
  // never actionless and the copy never trails off) but leave it DISABLED, and
  // it goes live only once coverage is known — at which point either
  // `showPurchase` / `showContactAdmin` has taken over, or the read really was
  // inconclusive and credits are the honest last resort.
  //
  // `!canSpendCredits` is load-bearing, not belt-and-braces (CAN-2413 review
  // round 5). `resolveAiCreditsCoverage` reports a fully COVERED account as
  // `canSpendCredits: true` with `showPurchase` AND `showContactAdmin` both
  // false — the same flag combination as an inconclusive read. Without this
  // term the fallback treats "you can pay now" as "we could not tell", so a
  // user whose admin just restored their quota, or who topped up in another
  // window, is handed an enabled "Buy AI Credits" telling them to buy
  // something they already have.
  const showFallbackCredits =
    coverageSettled &&
    !coverage.canSpendCredits &&
    !showSignIn &&
    !showPurchase &&
    !showContactAdmin;
  // No money button on a policy dead end — buying credits cannot lift an org
  // allowlist, so every credits affordance is suppressed rather than merely
  // deprioritized.
  const creditsCanHelp = !policyOnlyDeadEnd;
  // Coverage came back sufficient: the condition that raised this banner is
  // resolved, so it stands down rather than keep selling credits. It has
  // nothing left to add: the AI Credits card already reports the balance, the
  // transcript keeps the stop line, and a "you can send it now" notice kept
  // the dead end's warning and Sign in action beside its own all-clear. The
  // next dispatched message clears the runtime signal, so a later refusal
  // starts a fresh read. A dispatch dead end, org policy or not, still shows:
  // the lane resolver found no model this chat can run, which spendable
  // credits alone do not change, and the banner is its only recovery.
  const coverageRecovered = coverageSettled && coverage.canSpendCredits;
  const standDown =
    coverageRecovered && !dispatchDeadEnd && pendingHandoff === null;
  const pendingCredits = !coverageSettled && !showSignIn;
  // A retained hand-off keeps the CTA, and with it Check again, whatever the
  // pre-flight read last said: a fresh purchase never replaces it.
  const showCreditsButton =
    creditsCanHelp &&
    (showPurchase ||
      showFallbackCredits ||
      pendingCredits ||
      pendingHandoff !== null);

  // A local hand-off ends with its CTA; a retained one is re-reported by the
  // CTA instead, so clearing here would race that report.
  useEffect(() => {
    if (walletKey === null) setHandoff(null);
  }, [walletKey, creditsScope, visible, showCreditsButton]);
  // NOTHING that spends money is clickable while a read is in flight — not the
  // fallback, and not a `showPurchase` inherited from the previous read. That
  // single rule is what makes it safe to keep the last-known availability
  // rather than blanking it: the copy stays stable across a `visible` cycle
  // (no button vanishing and reappearing inside an `aria-live` region) while
  // the click-through hazard stays closed, because the decision a stale read
  // produced can be *shown* but never *acted on*.
  const creditsDisabled = !coverageSettled;
  // Never render an empty actions row.
  const hasActions = showSignIn || showCreditsButton;

  // Credits bought from this banner's Buy AI Credits (CAN-5160), and from the
  // model picker or its recovery dialog, which have no notice of their own.
  const arrival = useAiCreditsArrivalStore((s) =>
    selectAiCreditsArrivalForChat(s, target, ARRIVAL_ORIGINS),
  );
  const arrivalEvidence = useAiCreditsArrivalStore((s) =>
    selectAiCreditsArrivalEvidence(s, arrival?.handoffId),
  );
  const arrivalHandoffId = arrival?.handoffId ?? null;
  // The "Using AI Credits" card confirms the purchase itself, so the record
  // moves there rather than stacking a second notice beside it. Once routed
  // the card owns its lifecycle; the notice below is only for a chat that
  // has no card, such as a gateway-only model.
  useEffect(() => {
    if (aiCreditsCardVisible && arrivalHandoffId !== null) {
      markAiCreditsArrivalRouted(arrivalHandoffId);
    }
  }, [aiCreditsCardVisible, arrivalHandoffId]);
  // A record exists only after this banner's own CTA found coverage, so the
  // dead end is over whatever this banner's lagging re-read says. Gating on
  // that read would paint the attention notice for a frame and announce
  // twice. While the org-lapse banner explains its dead end the record waits.
  const arrivalPending = billable && !orgLapseVisible && arrival !== null;
  // Until the expected card takes the slot, show nothing: neither the
  // notice it replaces nor the dead end the purchase just ended.
  const awaitingCard = arrivalPending && aiCreditsCardExpected;
  const showArrival =
    arrivalPending && !aiCreditsCardVisible && !aiCreditsCardExpected;

  // Seeded with the mount-time value, so a banner that mounts during a
  // running turn waits for the next turn to start.
  const wasTurnActive = useRef(turnActive);
  useEffect(() => {
    const started = !wasTurnActive.current && turnActive;
    wasTurnActive.current = turnActive;
    if (started && arrivalHandoffId !== null) {
      clearAiCreditsArrival(arrivalHandoffId);
    }
  }, [turnActive, arrivalHandoffId]);

  // A switch to Subscription means the chat no longer spends the credits.
  // Only the edge from credits counts: before the purchase lands the chat
  // already resolves to a locked 'subscription' with no credits, and the
  // record arrives while that value still stands. The composer keeps this
  // banner mounted across chats, so only an edge within one chat counts.
  const frameworkKey = target ? chatBannerKey(target) : null;
  const previousFramework = useRef({
    key: frameworkKey,
    value: effectiveBillingFramework,
  });
  useEffect(() => {
    const switched =
      previousFramework.current.key === frameworkKey &&
      previousFramework.current.value === 'ai-credits' &&
      effectiveBillingFramework === 'subscription';
    previousFramework.current = {
      key: frameworkKey,
      value: effectiveBillingFramework,
    };
    if (switched && arrivalHandoffId !== null) {
      clearAiCreditsArrival(arrivalHandoffId);
    }
  }, [frameworkKey, effectiveBillingFramework, arrivalHandoffId]);

  // The Check again button the user pressed unmounts when the arrival
  // replaces the attention notice; move focus to the arrival in that commit.
  // Same pattern as `AiCreditsUsageLimitBanner`.
  const noticeRef = useRef<HTMLDivElement | null>(null);
  const restoreNoticeFocus = useRef(false);
  const attachNotice = useCallback((element: HTMLDivElement | null): void => {
    if (element === null) {
      const previous = noticeRef.current;
      restoreNoticeFocus.current =
        previous !== null &&
        previous.contains(previous.ownerDocument.activeElement);
      // Hiding the banner must not reclaim focus when it later returns.
      queueMicrotask((): void => {
        restoreNoticeFocus.current = false;
      });
    } else if (restoreNoticeFocus.current) {
      element.focus();
      restoreNoticeFocus.current = false;
    }
    noticeRef.current = element;
  }, []);

  // Shown only while the CTA is rendered, so it cannot outlive its button.
  // A retained check must finish recording arrival even if this banner's
  // independent coverage read has already recovered.
  const visibleHandoff =
    showCreditsButton && (!coverageRecovered || pendingHandoff !== null)
      ? currentHandoff
      : null;
  // Controls bound to this record and this chat. Until the CTA reports them
  // here (a switch from a sibling chat), Reopen billing stays disabled.
  const handoffControls =
    visibleHandoff !== null &&
    handoff !== null &&
    handoff.state.handoffId === visibleHandoff.id &&
    handoff.chatKey === chatKey
      ? handoff.state
      : null;
  const showReopenBilling =
    visibleHandoff !== null && visibleHandoff.feedback !== 'check-failed';

  const actions = hasActions ? (
    <>
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
          data-testid="chat-input-no-billing-source-reopen-billing"
        >
          {AI_CREDITS_REOPEN_BILLING_LABEL}
        </NoticeButton>
      )}
      {showCreditsButton && (
        /* The title lives on a WRAPPER, not the button: Chromium
           suppresses pointer events on disabled controls, so a
           `title` on the button itself never renders a tooltip —
           exactly when the explanation is needed. */
        <span {...(creditsDisabled ? { title: 'Checking your account…' } : {})}>
          {/* The shared CTA owns the whole purchase hand-off — the
              cloud-connect gate, the post-return coverage re-read and
              the "Check again" state — so every credits button in the
              app behaves identically. `disabled` keeps this banner's
              own rule: the button is rendered but inert until this
              surface's coverage read settles. */}
          <GetAiCreditsCta
            label={AI_CREDITS_PURCHASE_LABEL}
            {...(creditsScope ? { aiCreditsScope: creditsScope } : {})}
            // Re-read rather than ignore: the CTA's read is fresher
            // than this banner's, so "covered" here means the
            // condition that raised the banner is gone and the copy
            // is now stale.
            //
            // Re-arms `coverageSettled` alongside the token, for the
            // same reason the `visible` cycle does: while the new
            // read is in flight nothing that spends money may be
            // clickable on the previous read's decision.
            onCovered={(): void => {
              setCoverageSettled(false);
              setRefreshCoverage((n) => n + 1);
            }}
            // Only the inconclusive-read fallback opts in. On that
            // branch the coverage read has already failed, so
            // re-reading it to explain the failure is a dead end and
            // the hand-off is the action the branch exists to offer.
            handoffOnInconclusiveRead={showFallbackCredits}
            // Secondary beside Connect; primary alone or once a hand-off
            // puts Check again on this button.
            buttonVariant={
              showSignIn && visibleHandoff === null ? 'secondary' : 'primary'
            }
            buttonSize="sm"
            disabled={creditsDisabled}
            // This action bar is a horizontal, right-aligned row; the
            // default stacked hand-off block would re-flow it.
            handoffLayout="compact"
            // Always the browser, even when Settings → Billing could open
            // in-app (CAN-5159): the waiting state and Check again stay in
            // this chat instead of the purchase being lost in Settings. The
            // default route clears the hand-off on an in-app open, so an
            // arrival notice here could never show.
            billingDestination="browser"
            onHandoffChange={reportHandoff}
            confirmArrival="no-billing-source"
            {...(target ? { persistHandoffFor: target } : {})}
            onGetCreditsClick={(): void =>
              trackCreditsRecoveryClick({
                surface: 'chat_banner',
                action: 'credits_purchase',
              })
            }
            dataTestId="chat-input-no-billing-source-get-credits"
          />
        </span>
      )}
    </>
  ) : undefined;

  if (!billable || (!visible && !loginOpen && !showArrival)) {
    // Eligibility and the credits card can recover before the CTA's probe.
    // Keep its retained completion mounted without showing a second notice.
    return pendingHandoff !== null ? <span hidden>{actions}</span> : null;
  }

  // Copy branches on WHICH trigger fired. The runtime signal means a turn
  // already failed, so the past tense is the accurate account; reusing the
  // pre-flight "not connected" line would also be plainly wrong for the case
  // this exists to fix, where the user IS signed in natively. The derived copy
  // is untouched — keep it in step with the main-process backstop in
  // `claude-session.ts` / `codex-session.ts`, which describes the same dead
  // end.
  //
  // "didn't cover" rather than "ran out" (CAN-2413 review): the hosted
  // `billed === null` that produces this 402 means "no positive personal
  // balance AND no funded eligible org pool", which includes a user who never
  // had credits at all. The case this banner exists to fix — a working native
  // login on a gateway-only model — makes a brand-new user one of the
  // likeliest people to see it, and "ran out" tells them they spent something
  // they never had.
  //
  // CAN-1929: name the half that is actually missing. Telling a Claude
  // subscriber they have "no billing source" because their org only allows
  // gateway-routed models sends them to fix the one thing that was never
  // broken.
  //
  // CAN-2436: the dead-end arms are ordered ahead of the runtime and derived
  // copy only while they ADD information — that is, while an org allowlist is
  // the thing the user has to act on. With no policy in force they described
  // the same dead end less accurately (and, for `creditsOnlyDeadEnd`, named an
  // organization that does not exist), so they now fall through to the copy
  // that names the actual remedy.
  //
  // Each arm is a short title (the state) plus the message that follows it on
  // the same line (the consequence or remedy); the buttons name the actions.
  const copy: CreditsRecoveryCopy = policyOnlyDeadEnd
    ? POLICY_ONLY_DEAD_END_COPY
    : // Mid-purchase, the step the user is on replaces the dead end they
      // already acted on (CAN-5162).
      visibleHandoff !== null
      ? aiCreditsHandoffCopy(visibleHandoff.feedback)
      : // `missing === 'policy-allowance'` is NOT a second arm here: the
        // resolver only returns it when `lanesNeeded` is empty, which is
        // exactly `policyOnlyDeadEnd` above.
        creditsOnlyDeadEnd
        ? creditsOnlyDeadEndCopy(brandText.appName)
        : policyRestricted &&
            noDispatchableModel?.missing === 'both' &&
            noDispatchableModel.hasPolicyAllowedLane !== false
          ? POLICY_BILLING_DEAD_END_COPY
          : // Every remaining dispatch dead end keeps the copy ECW-9091
            // shipped: without a policy the resolver's verdict is about
            // payment, and the CTAs below name the remedy.
            dispatchDeadEnd
            ? DISPATCH_DEAD_END_COPY
            : runtimeSignalActive
              ? failedTurnCopy(brandText.appName)
              : notSignedInCopy({ appName: brandText.appName, providerLabel });

  // Same precedence as the copy: a dispatch dead end, then a failed turn. A
  // pure org-policy dead end is not a credits state, so it records no view.
  const recoveryTrigger: CreditsRecoveryTrigger = dispatchDeadEnd
    ? 'no_dispatchable_model'
    : runtimeSignalActive
      ? 'failed_turn'
      : 'preflight';

  return (
    <>
      {visible &&
        !policyOnlyDeadEnd &&
        !standDown &&
        !showArrival &&
        !awaitingCard && (
          <CreditsRecoveryView
            surface="chat_banner"
            trigger={recoveryTrigger}
            dedupeKey={target ? chatBannerKey(target) : 'composer'}
          />
        )}
      {showArrival ? (
        // Its own component and live-region scope, not a `copy` arm. Only
        // the title and body: Check again belongs to the dead end.
        <AiCreditsArrivedNotice
          ref={attachNotice}
          addedCredits={arrivalEvidence?.addedCredits ?? null}
          balanceCredits={arrivalEvidence?.balanceCredits ?? null}
          data-testid="chat-input-no-billing-source-arrival"
          tabIndex={-1}
          onDismiss={(): void => {
            if (arrivalHandoffId !== null) {
              clearAiCreditsArrival(arrivalHandoffId);
            }
          }}
          dismissTestId="chat-input-no-billing-source-arrival-dismiss"
        >
          You can send it now.
        </AiCreditsArrivedNotice>
      ) : visible && !standDown && !awaitingCard ? (
        <CreditsRecoveryNotice
          ref={attachNotice}
          // Waiting on a purchase is not a warning; only a failed check is.
          intent={
            visibleHandoff !== null &&
            visibleHandoff.feedback !== 'check-failed'
              ? 'neutral'
              : 'attention'
          }
          {...(visibleHandoff !== null &&
          visibleHandoff.feedback !== 'check-failed'
            ? { icon: <TimeslotIcon size={16} aria-hidden="true" /> }
            : {})}
          {...(showSignIn
            ? {
                connectAction: {
                  onConnect: (): void => {
                    trackCreditsRecoveryClick({
                      surface: 'chat_banner',
                      action: 'provider_sign_in',
                    });
                    setLoginOpen(true);
                  },
                  label:
                    visibleHandoff !== null
                      ? `${connectProviderLabel(providerLabel)} instead`
                      : connectProviderLabel(providerLabel),
                  variant: visibleHandoff !== null ? 'secondary' : 'primary',
                  testId: 'chat-input-no-billing-source-sign-in',
                },
              }
            : {})}
          queued={queuedCreditHeld && !policyOnlyDeadEnd}
          title={copy.title}
          data-testid="chat-input-no-billing-source-banner"
          contactAdmin={showContactAdmin}
          contactAdminTestId="chat-input-no-billing-source-contact-admin"
          {...(actions !== undefined
            ? {
                actions,
                // The hand-off's buttons get their own row, so the copy
                // keeps the full width.
                actionsPlacement:
                  visibleHandoff !== null ? 'below' : 'trailing',
              }
            : {})}
        >
          {copy.message}
        </CreditsRecoveryNotice>
      ) : null}
      {/* Rendered as a SIBLING of the `role="status"` element, not inside it.
          `DialogModal` does not portal, so nesting the modal here would make a
          `dialog` a DOM child of a polite live region — invalid ARIA, and
          assistive tech would announce the entire modal (terminal included) as
          a status update. `ModelPicker` renders this same modal outside any
          live region. */}
      {loginOpen && (
        <AuthLoginModal
          provider={provider}
          onClose={(): void => setLoginOpen(false)}
        />
      )}
    </>
  );
}
