import { Button } from '@canopy/ui-shared/components/Button';
import { LoadingButton } from '@canopy/ui-shared/components/LoadingButton';
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type {
  AiCreditsScopeRequest,
  CanopyCloudAccountPublicState,
  ChatModel,
  NativeAiCreditsAvailability,
  AgentProviderAuthStatus,
} from '@canopy/desktop-shared/types';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import {
  getExecutionHarnessForModel,
  getModelDisplayName,
  hasHydratedModelRegistry,
  isModelHarness,
} from '@canopy/desktop-shared/types';
import { isGatewayRoutableModel } from '@canopy/execution-engine/lib/gateway-model-availability';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import { lapsedOrgNames as lapsedOrgNamesFrom } from '@canopy/desktop-shared/lib/org-billing-state-parsing';
import {
  AI_CREDITS_GUEST_PURCHASE_LABEL,
  AI_CREDITS_PURCHASE_LABEL,
  connectProviderLabel,
  DialogModal,
  LoadingSpinner,
  MODEL_LIBRARY_UNLOCK_COPY,
  modelLibraryUnlockTitle,
  modelLibraryWaitingInBrowserBody,
  guestModelGateCopy,
  GuestModelGateContent,
} from '@canopy/ui-shared';
import { isCanopyCloudConnected } from '@/lib/canopy-cloud';
import { mayChangeCanopyCloudIdentity } from '@/lib/canopyCloudAccountChange';
import { brandText } from '@/lib/brand';
import {
  CONTACT_ORG_ADMIN_COPY,
  CONTACT_ORG_ADMIN_LAPSED_COPY,
  readSharedAiCreditsAvailability,
  resolveAiCreditsCoverage,
  useUnlockModelsAction,
  type UnlockModelsResult,
} from '@/lib/openBillingPage';
import { announceAiCreditsChanged } from '@/lib/aiCreditsChanged';
import { refreshWorkModelLibraryAccess } from '@/lib/modelLibraryAccess';
import {
  checkModelUnlockNow,
  retryModelUnlockApply,
  useModelUnlockIntentStore,
  type ModelUnlockPhase,
} from '@/lib/modelUnlockIntent';
import { modelUnlockIntentLabel } from '@/lib/modelUnlockLabel';
import { getProviderLabel } from '@/lib/providerLabels';
import { useCloudConnectGateStore } from '@/stores/cloudConnectGateStore';
import { guestModelGateTitle, guestModelGateToast } from '@/lib/guest-cta-copy';
import { AuthLoginModal } from '@/components/settings/AuthLoginModal';
import type { ModelRecovery } from '@/lib/modelPickerRowGate';
import type { GuestModelFallback } from '@/lib/guestModelFallback';
import { ErrorBanner } from '@canopy/ui-shared/components';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { GetAiCreditsCta } from './GetAiCreditsCta';
import { CreditsRecoveryView } from './CreditsRecoveryView';
import {
  trackCreditsRecoveryClick,
  type CreditsRecoveryAction,
} from '@/lib/creditsRecoveryTelemetry';

/**
 * CAN-2349 §3 — the ONE recovery modal.
 *
 * Every recoverable gate in the picker (A, B, C-escalation, H) routes here, so
 * the picker has exactly two answers to "you can't have this model yet": this
 * modal, or the shared disabled-reason reveal. It varies only by copy and which
 * CTAs it renders.
 *
 * The continue dialog stays its own component because it confirms an ACTION
 * rather than recovering a gate — but it shares the same primitives
 * (`DialogModal` shell, `LoadingSpinner` busy state, `GetAiCreditsCta`).
 */

/**
 * The selection resolved AT CLICK TIME.
 *
 * §4: the modal never re-derives its branch from live props. `AuthLoginModal`
 * invalidates the provider cache on unmount, which makes `useProviderAvailability`
 * report `loading: true`, and the row gate is OPTIMISTIC while loading — so a
 * user who CANCELS the login would trip a transient "gate cleared" and get the
 * model silently committed. Snapshot, don't observe.
 */
export interface PendingModelRecovery {
  readonly model: ChatModel;
  readonly recovery: ModelRecovery;
  /**
   * What the user was actually trying to do.
   *
   * `'select-model'` (default) is a row click: the model itself is gated, so
   * "add credits to use this model" is accurate copy.
   *
   * `'enable-ai-credits'` is the picker-footer escalation (case C). There
   * `model` is the CURRENT model and nothing is wrong with it — it is very
   * often an ordinary Claude/Codex model that bills fine to a subscription.
   * The user is switching a billing mode, so copy that claims the model
   * "runs on AI Credits" is simply false.
   */
  readonly intent?: 'select-model' | 'enable-ai-credits';
  /**
   * CAN-4703 — the guest model a `needs-account` gate offers instead,
   * snapshotted with the rest of the click so the named model cannot change
   * while the dialog is open. Only a model the guest can use right now is
   * offered.
   */
  readonly guestFallback?: GuestModelFallback;
}

/**
 * What the host did with a commit attempt.
 *
 * Returning `void` means "committed" — the ordinary case, and what keeps the
 * five existing call sites unchanged. A `{ ok: false }` says the host REFUSED
 * the commit and supplies the reason to show, which is the only way this modal
 * can tell "the model was applied" apart from "the host dropped it on the
 * floor". `ModelPicker` refuses when the pending row became provider-locked
 * while the modal was open: `chatStore.setModel` is fire-and-forget and its
 * `changeModel` IPC answers `accepted: false` for a cross-provider change on a
 * locked chat, so committing anyway would close this modal over a change that
 * never lands — the silent dead end CAN-2349 exists to remove.
 */
export type ModelCommitOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * What the host did with the guest fallback (CAN-4703).
 *
 * `redirected` is deliberately not a success: the fallback became recoverable
 * and the host replaced this recovery with the fallback's own, so nothing was
 * committed and this modal must neither latch, close, nor restore focus.
 */
export type GuestFallbackOutcome =
  | { readonly kind: 'committed' }
  | { readonly kind: 'redirected' }
  | { readonly kind: 'blocked'; readonly reason: string };

/** Internal result of one guarded commit attempt. */
type GuardedCommitOutcome =
  | { readonly kind: 'committed' }
  | { readonly kind: 'redirected' }
  | { readonly kind: 'blocked'; readonly reason: string };

/**
 * Shown when the commit itself threw rather than being refused. Deliberately
 * does not name a cause — an IPC rejection tells us nothing about why — but the
 * action is the same as every other blocked commit: try again.
 */
/** The one line every no-credits state leads with. */
const OUT_OF_CREDITS_COPY = "You're out of AI Credits.";
/** Case C's lead: the chat keeps its current billing until credits exist. */
const OUT_OF_CREDITS_BILLING_MODE_COPY =
  "You're out of AI Credits, so this chat stays on your subscription for now.";
/** Case C's title: what the user asked to do, not the model they are on. */
const BILLING_MODE_TITLE = 'Bill this chat to AI Credits';

const COMMIT_FAILED_REASON =
  'We couldn’t switch models just now. Check your connection and try again.';

export interface ModelRecoveryModalProps {
  readonly pending: PendingModelRecovery;
  readonly ownerDocument?: Document;
  /** Coverage/sign-in confirmed — commit the model. */
  readonly onCommit: (
    model: ChatModel,
  ) => ModelCommitOutcome | void | Promise<ModelCommitOutcome | void>;
  /** Case H only: open a fresh chat on this model instead of committing it. */
  readonly onStartNewChat?: (model: ChatModel) => void;
  readonly onCancel: () => void;
  /**
   * Owner of the chat being recovered (CAN-3463). AI Credits spill only onto
   * that owner's organization pool, so coverage, the lapsed-org list, and the
   * contact-admin copy all describe that one org. Omitted = navigation context.
   */
  readonly aiCreditsScope?: AiCreditsScopeRequest;
  /**
   * CAN-4028 — open browser checkout for the purchase that unlocks advanced
   * models, and remember the pending model so the host applies it once the
   * server confirms. Supplied by `ModelPicker`, which binds the application to
   * the ORIGINATING chat exactly as it binds {@link onCommit}.
   *
   * Optional: without it this modal opens checkout itself and applies
   * nothing, so the user picks the model again once it is unlocked.
   */
  readonly onUnlockPurchase?: (
    onResumed?: (result: UnlockModelsResult) => void,
  ) => Promise<UnlockModelsResult>;
  /**
   * CAN-4703 — select {@link PendingModelRecovery.guestFallback} on the
   * ORIGINATING chat instead of the gated model. Without it the gate offers no
   * fallback, whatever the snapshot holds.
   */
  readonly onUseGuestFallback?: (
    fallback: GuestModelFallback,
  ) => Promise<GuestFallbackOutcome>;
}

/**
 * Where the purchase branch is. Everything after `opened` is read from the
 * pending intent instead, because the poll loop that confirms the purchase is
 * owned by the app root and outlives this modal.
 *
 * `adopted` is a purchase this modal did not open (CAN-5030): an earlier
 * dialog's, which was closed, or another locked row's. One purchase unlocks
 * every advanced model, so this modal follows it instead of offering a second
 * checkout. `newPurchaseFailed` records that an explicit **Start a new
 * purchase** could not open, without dropping the purchase still followed.
 */
type UnlockAttempt =
  | { readonly status: 'idle' }
  | { readonly status: 'opening'; readonly requestId?: string }
  | { readonly status: 'opened'; readonly requestId?: string }
  | {
      readonly status: 'adopted';
      readonly requestId: string;
      readonly newPurchaseFailed?: true;
    }
  | { readonly status: 'contact-admin' }
  | { readonly status: 'failed' };

/** A phase in which the purchase is still unconfirmed and being followed. */
function isPendingUnlockPhase(
  phase: ModelUnlockPhase | null,
): phase is 'waiting' | 'timed-out' {
  return phase === 'waiting' || phase === 'timed-out';
}

/** The request id of a pending intent, or null when nothing is pending. */
function readPendingUnlockRequestId(): string | null {
  const { intent, phase } = useModelUnlockIntentStore.getState();
  return intent !== null && isPendingUnlockPhase(phase)
    ? intent.requestId
    : null;
}

/**
 * The request this modal follows: a pending intent always wins, so a stale
 * render can never narrate (or offer to replace) anything but the current
 * purchase. Otherwise, the attempt this modal opened or adopted.
 */
function trackedUnlockRequestId(
  attempt: UnlockAttempt,
  pendingRequestId: string | null,
): string | undefined {
  if (pendingRequestId !== null) return pendingRequestId;
  return attempt.status === 'opened' ||
    attempt.status === 'adopted' ||
    attempt.status === 'opening'
    ? attempt.requestId
    : undefined;
}

/** What the account read says. Snapshotted, never derived from live props. */
type AccountRead =
  | { readonly status: 'loading' }
  /** Read failed or came back inconclusive. NEVER offer a purchase on this. */
  | { readonly status: 'inconclusive' }
  | {
      readonly status: 'settled';
      readonly availability: NativeAiCreditsAvailability;
      readonly guest: boolean;
      /**
       * Orgs that have lost the `teams` capability, read off the SAME account
       * snapshot as `guest`.
       *
       * `resolveAiCreditsCoverage` never discovers these on its own — it only
       * ever echoes back the names its caller hands it (`lapsedOrgNames` is a
       * parameter with a `[]` default, see `openBillingPage.ts`). Omitting the
       * argument therefore guarantees `coverage.lapsedOrgNames` is empty, which
       * makes the lapsed branch below unreachable and drops a lapsed-org member
       * onto the ordinary self-serve purchase copy. `OrgLapsedBanner` sources
       * them the same way.
       */
      readonly lapsedOrgs: readonly string[];
      /**
       * CAN-4028 — this signed-in account still needs a card purchase before
       * the pending model can be selected. Snapshotted with the rest of the
       * read, so the branch cannot flip under the user between renders.
       */
      readonly libraryPurchaseRequired: boolean;
    };

/**
 * A recovery's account-dependent state belongs to that attempt and owner.
 * Remount before rendering a different recovery, rather than clearing old
 * controls in an effect after they have already painted. The picker supplies
 * its own attempt key for repeated selections with otherwise identical data.
 */
export function ModelRecoveryModal(
  props: ModelRecoveryModalProps,
): JSX.Element {
  const [accountEpoch, setAccountEpoch] = useState(0);
  const key = JSON.stringify([
    props.pending,
    props.aiCreditsScope,
    accountEpoch,
  ]);
  const lifetimeRef = useRef({ key, valid: true });
  if (lifetimeRef.current.key !== key) {
    lifetimeRef.current.valid = false;
    lifetimeRef.current = { key, valid: true };
  }
  const lifetime = lifetimeRef.current;
  const isCurrentAttempt = useCallback(
    (): boolean => lifetime.valid,
    [lifetime],
  );
  useEffect(() => {
    // StrictMode replays setup after cleanup on the same mounted attempt.
    lifetimeRef.current.valid = true;
    const invalidate = (event: Event): void => {
      if (!mayChangeCanopyCloudIdentity(event)) return;
      // Explicit sign-in must keep its CTA and browser continuation mounted.
      // The gate-close read already adopts the resulting account.
      if (useCloudConnectGateStore.getState().pending !== null) return;
      // Synchronous: a promise settling before the next render is stale too.
      lifetimeRef.current.valid = false;
      setAccountEpoch((epoch) => epoch + 1);
    };
    window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, invalidate);
    return (): void => {
      lifetimeRef.current.valid = false;
      window.removeEventListener(
        CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
        invalidate,
      );
    };
  }, []);
  return (
    <ModelRecoveryAttempt
      key={key}
      {...props}
      isCurrentAttempt={isCurrentAttempt}
    />
  );
}

function ModelRecoveryAttempt({
  pending,
  ownerDocument,
  onCommit,
  onStartNewChat,
  onCancel,
  aiCreditsScope,
  onUnlockPurchase,
  onUseGuestFallback,
  isCurrentAttempt,
}: ModelRecoveryModalProps & {
  readonly isCurrentAttempt: () => boolean;
}): JSX.Element | null {
  const modelLabel = getModelDisplayName(pending.model);
  const guestSignInRef = useRef<HTMLButtonElement | null>(null);
  /**
   * Can AI Credits actually run THIS model?
   *
   * `resolveAiCreditsCoverage(...).canSpendCredits` answers a question about
   * the ACCOUNT — "can you pay for a gateway-routed turn?" — and says nothing
   * about whether the pending model has a gateway route at all. A native-only
   * model (no `gatewayId`, e.g. `gpt-5.3-codex-spark`) gated on
   * `needs-billing-source` is cleared by signing in to the provider and by
   * nothing else: buying credits cannot route it, so neither committing it on
   * coverage nor offering a purchase would help.
   *
   * Scoped to `needs-billing-source` deliberately. The credits-shaped
   * recoveries (case B `needs-credits`, and the case-C billing-mode switch)
   * are only ever raised for models the picker already established are
   * credit-payable, so re-deriving routability there would risk suppressing a
   * legitimate recovery on a registry mismatch.
   *
   * Registry emptiness is genuinely AMBIGUOUS ("not loaded yet" vs. "no routes
   * exist"). The gateway registry starts empty and is filled from the
   * model-configuration broadcast, so during that window every model looks
   * non-routable — and neither answer may be acted on:
   *
   *  - Treating it as "native only" would strip the purchase path from users
   *    who genuinely can buy their way out.
   *  - Auto-COMMITTING on it selects a model with no gateway route and still no
   *    provider login, which is exactly the dead end this modal exists to
   *    prevent.
   *
   * So the AUTO-COMMIT fails closed (below), and RENDERING does not answer the
   * question at all: while `needsGatewayRoute && !gatewayRoutesKnown` the modal
   * shows a routes-loading shell and every branch that acts on routability
   * waits for the real answer. That pairing is load-bearing — the two used to
   * fail in opposite directions on the SAME render, which put a `Use {model}`
   * button in front of a covered account whose handler then refused to commit,
   * repainting the identical modal on every click.
   */
  // Readiness is a REGISTRY-LIFECYCLE question, not a route-count one.
  // `hasGatewayModelRoutes()` answers `false` both for "the registry has not
  // loaded" and for "a loaded, policy-filtered registry that legitimately has
  // zero gateway routes" — the second reachable once an org policy blocks every
  // gateway-routable entry while leaving an allowed native-only model. Keying
  // the loading shell off the route count would then wait forever for a route
  // that can never arrive, and the user would never reach the provider sign-in
  // branch that actually clears their gate.
  const gatewayRoutesKnown = hasHydratedModelRegistry();
  const needsGatewayRoute = pending.recovery.kind === 'needs-billing-source';
  /**
   * Fail-OPEN, and only ever read AFTER the routes-loading shell has returned,
   * so by then it is equal to `creditsProvenToRunPendingModel`. Kept distinct
   * because the open default is what makes that early return safe: it is the
   * reason an unknown registry can never render the native-only branch.
   */
  const creditsCanRunPendingModel =
    !needsGatewayRoute ||
    !gatewayRoutesKnown ||
    isGatewayRoutableModel(pending.model);
  /**
   * Fail-CLOSED. Drives the silent auto-commit, which runs from an EFFECT and
   * therefore still sees the ambiguous window the render path now skips. An
   * empty registry withholds the commit instead of guessing; the user reaches
   * the model through the rendered branch once the registry has loaded.
   */
  const creditsProvenToRunPendingModel =
    !needsGatewayRoute ||
    (gatewayRoutesKnown && isGatewayRoutableModel(pending.model));
  const [read, setRead] = useState<AccountRead>({ status: 'loading' });
  const [loginOpen, setLoginOpen] = useState(false);
  const [signInBusy, setSignInBusy] = useState(false);
  const [retryBusy, setRetryBusy] = useState(false);
  const mountedRef = useRef(true);
  const providerAuthSnapshotRef = useRef<{
    readonly provider: 'claude' | 'codex';
    readonly authenticated: false;
  } | null>(null);
  // §3 child-surface exclusivity: `CloudSyncModal` renders at `DialogModal`'s
  // modal tier, so without this we would cover the
  // sign-in modal we just asked for.
  const cloudGatePending = useCloudConnectGateStore((s) => s.pending);
  // Read through a ref so `refreshAccountRead` (and therefore the mount effect
  // that depends on it) keeps a stable identity across parent re-renders.
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  const onUseGuestFallbackRef = useRef(onUseGuestFallback);
  onUseGuestFallbackRef.current = onUseGuestFallback;
  /** Monotonic token; only the newest account read may apply its result. */
  const readSeqRef = useRef(0);
  /**
   * This modal commits AT MOST ONCE, whichever path gets there first.
   *
   * Closing the cloud gate wakes up two independent commit paths that both
   * re-read coverage and both conclude "covered": this modal's own gate-close
   * `refreshAccountRead`, and `GetAiCreditsCta`'s `proceedAfterConnect` →
   * `onCovered`. `GetAiCreditsCta.coveredRef` latches only the CTA's half, and
   * the two chains are two IPC hops each with no ordering between them, so
   * without a latch here a single sign-in can commit the model twice.
   *
   * The second commit is not merely redundant. `ModelPicker` clears
   * `recoveryModelChangeRef` when the first one lands, so a late duplicate
   * falls back to the LIVE `props.onModelChange` — re-selecting the model on
   * whatever chat is active by then, which is exactly the cross-chat leak that
   * ref was added to prevent.
   */
  const committedRef = useRef(false);
  /**
   * The host's reason for refusing the last commit, or `null`.
   *
   * Rendered as a status line that keeps this modal OPEN, because the refusal
   * is transient by construction: `ModelPicker` only refuses on
   * `locked-provider`, whose own copy ("stop the current turn, then switch")
   * describes something the user clears themselves. The recovery itself
   * SUCCEEDED — credits arrived, or the login landed — so cancelling it here
   * would throw that away; the user retries with the same button once the turn
   * finishes.
   */
  const [commitBlockedReason, setCommitBlockedReason] = useState<string | null>(
    null,
  );
  /**
   * How many times the user has pressed the blocked branch's **Try again**.
   *
   * Load-bearing, not telemetry. A still-refused retry calls
   * `setCommitBlockedReason` with the string it ALREADY holds, and React bails
   * out of a re-render on an unchanged value — so without a changing piece of
   * state the press produces no repaint at all. `lockedProviderReason` is
   * stable for the whole duration of a streaming or queued turn, so every press
   * before that turn ends would be a literal no-op: the dead click this ticket
   * exists to remove, inside the branch written to remove it.
   */
  const [commitAttempt, setCommitAttempt] = useState(0);
  /**
   * Busy state for the blocked branch's retry.
   *
   * `commitModel` awaits an IPC round trip, and this was the only async
   * affordance in the flow without one — every sibling (`renderRetry`,
   * `renderSignIn`, `GetAiCreditsCta`, and the `ConfirmDialog` spinner this
   * change shipped) disables and shows a spinner while in flight.
   * `commitInFlightRef` already made a double press harmless, but harmless is
   * not the same as visible.
   */
  const [commitRetryBusy, setCommitRetryBusy] = useState(false);
  /**
   * True while a credits branch is shown (CAN-4633), so the shared buttons
   * report clicks only from the no-credits state, not from the unlock,
   * native-only, or read-failure branches that reuse them.
   */
  const creditsRecoveryShownRef = useRef(false);
  const trackRecoveryClick = useCallback(
    (action: CreditsRecoveryAction): void => {
      if (!creditsRecoveryShownRef.current) return;
      trackCreditsRecoveryClick({ surface: 'model_recovery', action });
    },
    [],
  );
  /**
   * ASYNC because the host's answer is authoritative and comes from main.
   *
   * `ModelPicker` routes a row recovery through `setModelAndWait`, which
   * resolves to whether the ORIGINATING chat actually accepted the change — the
   * only answer that is correct across a chat-tab switch. A synchronous guess
   * from the rendered rows could refuse a valid commit or miss a real refusal.
   *
   * The in-flight latch matters as much as the committed one: awaiting opens a
   * window in which the same button (or a focus/visibilitychange re-probe) can
   * fire again, and two overlapping commits are exactly what `committedRef`
   * exists to prevent.
   */
  const commitInFlightRef = useRef(false);
  /**
   * The one guarded path every commit attempt takes — the recovered model and
   * the CAN-4703 guest fallback alike — so both share the latches, the
   * refusal handling, and the throw handling. `onBlocked` says where a
   * refusal is shown: the fallback must not land in the commit-blocked
   * branch, whose Try again commits the GATED model.
   */
  const runGuardedCommit = useCallback(
    async (
      attempt: () => Promise<GuardedCommitOutcome>,
      onBlocked: (reason: string) => void,
    ): Promise<boolean> => {
      if (!mountedRef.current || !isCurrentAttempt()) return false;
      if (committedRef.current) return true;
      if (commitInFlightRef.current) return false;
      commitInFlightRef.current = true;
      try {
        const outcome = await attempt();
        if (outcome.kind === 'blocked') {
          // NOT latched: a refused commit never reached the host's state, so
          // the retry must be allowed to try again.
          if (mountedRef.current && isCurrentAttempt())
            onBlocked(outcome.reason);
          return false;
        }
        // Nothing was committed: the host replaced this recovery with
        // another, which starts its own attempt.
        if (outcome.kind === 'redirected') return false;
        committedRef.current = true;
        return true;
      } catch (error) {
        reportClientAppError(error);
        // A THROW is not a refusal, but it strands the user the same way, and
        // every caller here latches busy state before awaiting: an escaping
        // rejection would leave the modal on "Checking your account…", or Try
        // again / Sign in permanently disabled, plus an unhandled rejection
        // from each `void` call site. Route it into the same blocked branch —
        // it already means "the recovery succeeded, the commit did not land"
        // and already offers the retry.
        if (mountedRef.current && isCurrentAttempt())
          onBlocked(COMMIT_FAILED_REASON);
        return false;
      } finally {
        commitInFlightRef.current = false;
      }
    },
    [isCurrentAttempt],
  );
  const commitModel = useCallback(
    async (model: ChatModel): Promise<boolean> => {
      const committed = await runGuardedCommit(async () => {
        const outcome = await onCommitRef.current(model);
        return outcome !== undefined && outcome.ok === false
          ? { kind: 'blocked', reason: outcome.reason }
          : { kind: 'committed' };
      }, setCommitBlockedReason);
      if (committed && mountedRef.current) setCommitBlockedReason(null);
      return committed;
    },
    [runGuardedCommit],
  );
  /**
   * CAN-4703 — the guest fallback's busy state and refusal. The refusal stays
   * inside the guest gate, with the fallback offered again, rather than in
   * the commit-blocked branch.
   */
  const [fallbackBusy, setFallbackBusy] = useState(false);
  const [fallbackError, setFallbackError] = useState<string | null>(null);
  const handleUseGuestFallback = useCallback(
    (fallback: GuestModelFallback): void => {
      const selectFallback = onUseGuestFallbackRef.current;
      if (!selectFallback || commitInFlightRef.current || committedRef.current)
        return;
      setFallbackBusy(true);
      setFallbackError(null);
      void runGuardedCommit(
        () => selectFallback(fallback),
        setFallbackError,
      ).finally(() => {
        if (mountedRef.current) setFallbackBusy(false);
      });
    },
    [runGuardedCommit],
  );

  useEffect(() => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
    };
  }, []);

  const refreshAccountRead = useCallback(
    async (
      options: { readonly fresh?: boolean } = {},
    ): Promise<AccountRead | undefined> => {
      // Only the newest read may write state. Two reads can overlap (mount +
      // Try again, or a re-run after `pending.model` changes), and the IPC pair
      // below is not ordered, so without this an older, staler answer can land
      // last and win.
      const seq = ++readSeqRef.current;
      let availability: NativeAiCreditsAvailability | null = null;
      let account: CanopyCloudAccountPublicState | null | undefined;
      // SHARED with `GetAiCreditsCta`'s post-connect read. Both wake on the same
      // gate close, and two independent reads of the same account can disagree —
      // the credits fan-out is network-backed and a transient failure degrades to
      // "uncovered", not to an error. That let this modal conclude *covered* and
      // commit while the CTA concluded *uncovered* and opened a billing page for
      // credits the user had just been granted. One episode, one answer.
      //
      // `fresh` is passed only by **Try again**, whose entire purpose is to ask
      // the question again — serving it the answer this modal already has would
      // make the button a no-op.
      availability = await readSharedAiCreditsAvailability({
        ...options,
        ...(aiCreditsScope ? { scope: aiCreditsScope } : {}),
      });
      try {
        account = await window.api.loadCanopyCloudAccount();
      } catch (error) {
        // An unreadable account is unknown, never signed out; record it.
        reportClientAppError(error);
        account = null;
      }
      // CAN-4028 — library access is its own server fact, read fresh alongside
      // the account so a guest who just signed in is judged as the account
      // they now are. Skipped for every other recovery kind: they are funding
      // or provider questions, and must not grow an extra cloud read.
      const libraryRead =
        pending.recovery.kind === 'needs-purchase' ||
        pending.recovery.kind === 'needs-account'
          ? await refreshWorkModelLibraryAccess(aiCreditsScope)
          : undefined;
      if (
        !mountedRef.current ||
        !isCurrentAttempt() ||
        seq !== readSeqRef.current
      )
        return;
      // The §7 guard lives in `resolveAiCreditsCoverage`, but the modal has to
      // distinguish "inconclusive" from "conclusively uncovered" to pick a
      // branch, so it checks the field itself rather than inferring it from
      // three false flags — inferring it is exactly the failure mode that keeps
      // both the old and new tests green while genuinely-uncovered users lose
      // their purchase CTA.
      if (!availability || availability.inconclusive === true) {
        setRead({ status: 'inconclusive' });
        return;
      }
      // Only the owner org's lapse can block this chat (CAN-3463); Personal
      // work has no owner org, so no lapse applies to it.
      const ownerOrganizationId = availability.ownerOrganization?.id;
      const orgBillingStates = ownerOrganizationId
        ? (account?.orgBillingStates ?? []).filter(
            (state) => state.organizationId === ownerOrganizationId,
          )
        : [];
      const guest =
        !isCanopyCloudConnected(account) ||
        isGuestAccount(account ?? undefined);
      // A row gated on `needs-purchase` stays gated when the re-read FAILS
      // (`null`): the lock was drawn from a real answer, and a blip is not
      // evidence it lifted. It does lift on any answered read that no longer
      // says `needs_purchase` — unlocked, or a server without the gate.
      //
      // A `needs-account` recovery reaches this only after sign-in, and then
      // only an explicit `needs_purchase` holds it: the guest's lock said
      // nothing about the account they signed in to.
      const libraryPurchaseRequired =
        !guest &&
        (pending.recovery.kind === 'needs-purchase'
          ? libraryRead === null || libraryRead?.access === 'needs_purchase'
          : pending.recovery.kind === 'needs-account' &&
            libraryRead?.access === 'needs_purchase');
      const nextRead: AccountRead = {
        status: 'settled',
        availability,
        guest,
        libraryPurchaseRequired,
        lapsedOrgs: lapsedOrgNamesFrom(
          orgBillingStates,
          orgBillingStates.map((state) => state.organizationId),
        ),
      };
      const coverage = resolveAiCreditsCoverage(
        nextRead.availability,
        nextRead.lapsedOrgs,
      );
      // Coverage may have appeared between the row click and this snapshot, or
      // while a contact-admin/inconclusive branch was waiting on Try again. In
      // either case the recovery has succeeded: commit immediately instead of
      // falling through to a misleading purchase branch with a "Use model"
      // button that would open billing again.
      //
      // `canSpendCredits` is ACCOUNT coverage, not proof this model can use it.
      // A native-only model (no `gatewayId`, e.g. `gpt-5.3-codex-spark`) whose
      // row is gated on `needs-billing-source` cannot be routed to credits at
      // all, so committing it here would select a model that has no way to run:
      // no gateway route and still no provider login. That branch is cleared by
      // signing in to the provider, and nothing else.
      // CAN-3026 — a `needs-account` recovery is NOT a funding question, so
      // coverage must not clear it. A guest may already be FUNDED, which makes
      // `canSpendCredits` true for exactly
      // the principal this gate exists to stop — and committing on it here would
      // silently hand the guest the expensive model the row gate just refused.
      //
      // Not a dead end: signing in clears `guest` on the gate-close re-read
      // below, this guard lifts, and the commit fires then.
      const guestAccountGateStands =
        pending.recovery.kind === 'needs-account' && nextRead.guest;
      // CAN-4028 — and neither may it clear a purchase lock. A signed-in
      // non-payer's balance can make `canSpendCredits` true while the library
      // stays locked, so committing here would select a model the server
      // refuses on the next send.
      if (
        !guestAccountGateStands &&
        !libraryPurchaseRequired &&
        coverage.canSpendCredits &&
        creditsProvenToRunPendingModel
      ) {
        announceAiCreditsChanged();
        // Only stop here if the commit LANDED. A refused commit (the row went
        // provider-locked) must still publish the settled read: returning early
        // on the mount read would pin the modal on "Checking your account…"
        // with nothing but its X, so the retry the refusal promises would not
        // exist on any branch.
        if (await commitModel(pending.model)) return;
      }
      if (
        !mountedRef.current ||
        !isCurrentAttempt() ||
        seq !== readSeqRef.current
      )
        return;
      setRead(nextRead);
      return nextRead;
      // `onCommit` is read through a ref (via the stable `commitModel`), NOT
      // taken as a dependency. Callers pass it as an inline arrow (`ModelPicker`
      // does), so depending on it would give this callback a new identity on
      // every parent render — and the mount effect below, which depends on it,
      // would re-fire and issue two more unthrottled IPC reads each time.
      // `ChatInput`'s `tab` prop changes on every streamed chunk, so a modal left
      // open during a turn would re-probe the account continuously. `commitModel`
      // is `useCallback([])`, so listing it costs nothing.
    },
    [
      aiCreditsScope,
      commitModel,
      creditsProvenToRunPendingModel,
      pending.model,
      pending.recovery.kind,
      isCurrentAttempt,
    ],
  );

  // ---- CAN-4028: the purchase that unlocks advanced models.
  // Adopted on open (CAN-5030): a purchase still pending from a closed dialog
  // or another locked row is resumed rather than offered again.
  const [unlockAttempt, setUnlockAttempt] = useState<UnlockAttempt>(
    (): UnlockAttempt => {
      const requestId = readPendingUnlockRequestId();
      return requestId === null
        ? { status: 'idle' }
        : { status: 'adopted', requestId };
    },
  );
  const [unlockCheckBusy, setUnlockCheckBusy] = useState(false);
  const [unlockApplyBusy, setUnlockApplyBusy] = useState(false);
  const unlockOpeningRef = useRef(false);
  const defaultUnlockModels = useUnlockModelsAction(aiCreditsScope);
  const onUnlockPurchaseRef = useRef(onUnlockPurchase);
  onUnlockPurchaseRef.current = onUnlockPurchase;
  /**
   * The pending intent, if any, read as primitives so the selection is stable
   * across polls that leave it unchanged.
   */
  const pendingUnlockRequestId = useModelUnlockIntentStore((state) =>
    state.intent !== null && isPendingUnlockPhase(state.phase)
      ? state.intent.requestId
      : null,
  );
  /**
   * The request this modal narrates, and its phase, or null.
   *
   * Matched on the request id so a different attempt is never narrated here
   * as this one's progress — except that a PENDING attempt is always adopted,
   * whichever chat or row started it, because buying again would duplicate it.
   */
  const unlockRequestId = trackedUnlockRequestId(
    unlockAttempt,
    pendingUnlockRequestId,
  );
  const unlockPhase = useModelUnlockIntentStore((state) =>
    unlockRequestId !== undefined && state.intent?.requestId === unlockRequestId
      ? state.phase
      : null,
  );
  /**
   * The model the followed purchase will switch to, which may not be the row
   * this modal was opened for. Its completion stays bound to the chat where
   * it started.
   */
  const unlockModelId = useModelUnlockIntentStore((state) =>
    unlockRequestId !== undefined && state.intent?.requestId === unlockRequestId
      ? state.intent.modelId
      : null,
  );
  const unlockModelLabel = modelUnlockIntentLabel(unlockModelId);

  /**
   * Reconcile with the store while open. A pending intent that appears or
   * replaces the followed one is adopted. An adopted intent that is cleared
   * (dismissed, or dropped with its account) returns this modal to ordinary
   * recovery. A completed one is kept, so its confirmation still renders.
   *
   * Never while opening (that attempt settles itself) or on the contact-admin
   * answer, and never over this modal's own untracked `opened` attempt: an
   * organization's purchase cannot be read back, so a missing phase there is
   * not evidence it was cleared.
   */
  const unlockStoreRequestId = useModelUnlockIntentStore(
    (state) => state.intent?.requestId ?? null,
  );
  useEffect(() => {
    if (
      unlockAttempt.status === 'opening' ||
      unlockAttempt.status === 'contact-admin'
    )
      return;
    if (pendingUnlockRequestId !== null) {
      if (
        (unlockAttempt.status !== 'opened' &&
          unlockAttempt.status !== 'adopted') ||
        unlockAttempt.requestId !== pendingUnlockRequestId
      ) {
        setUnlockAttempt({
          status: 'adopted',
          requestId: pendingUnlockRequestId,
        });
      }
      return;
    }
    if (
      unlockAttempt.status === 'adopted' &&
      unlockStoreRequestId !== unlockAttempt.requestId
    ) {
      setUnlockAttempt({ status: 'idle' });
    }
  }, [pendingUnlockRequestId, unlockAttempt, unlockStoreRequestId]);

  /**
   * Open checkout in the browser. With `replacing`, the explicit **Start a
   * new purchase** after a timeout; every other caller (the purchase button,
   * the guest's sign-in-then-purchase) re-reads the store first and adopts a
   * pending purchase instead, so a stale rendered CTA cannot open a second
   * checkout.
   */
  const openUnlockCheckout = useCallback(
    (replacing?: string): void => {
      if (unlockOpeningRef.current) return;
      const pendingRequestId = readPendingUnlockRequestId();
      if (pendingRequestId !== null) {
        const { phase } = useModelUnlockIntentStore.getState();
        if (pendingRequestId !== replacing || phase !== 'timed-out') {
          setUnlockAttempt({ status: 'adopted', requestId: pendingRequestId });
          return;
        }
      } else if (replacing !== undefined) {
        // The timed-out purchase is gone: nothing is left to replace, and the
        // reconcile effect has already returned this modal to its ordinary
        // branch, whose own button is the fresh purchase.
        return;
      }
      unlockOpeningRef.current = true;
      setUnlockAttempt({
        status: 'opening',
        ...(replacing === undefined ? {} : { requestId: replacing }),
      });
      const settle = (result: UnlockModelsResult): void => {
        if (!mountedRef.current) return;
        // A new purchase that could not open leaves the earlier one pending and
        // followed; say it failed without dropping that purchase.
        const stillPending = readPendingUnlockRequestId();
        if (result.outcome === 'failed' && stillPending !== null) {
          setUnlockAttempt({
            status: 'adopted',
            requestId: stillPending,
            newPurchaseFailed: true,
          });
          return;
        }
        // The original purchase can complete while its replacement opens.
        // A failed replacement must retain that confirmation and apply retry,
        // rather than offer another purchase over an already unlocked request.
        if (
          result.outcome === 'failed' &&
          replacing !== undefined &&
          useModelUnlockIntentStore.getState().intent?.requestId === replacing
        ) {
          setUnlockAttempt({ status: 'adopted', requestId: replacing });
          return;
        }
        if (result.outcome === 'unlocked') {
          // Already unlocked: no checkout opened. Re-read so the ordinary
          // branches take over and commit, exactly as if the lock had never
          // been drawn.
          setUnlockAttempt({ status: 'idle' });
          void refreshAccountRead({ fresh: true });
          return;
        }
        if (result.outcome === 'sign-in') {
          // The shared gate is up; this modal hides behind it and the gate-close
          // re-read picks the next branch. Checkout opens straight after the
          // sign-in and reports back through `settle`.
          setUnlockAttempt({ status: 'idle' });
          return;
        }
        setUnlockAttempt(
          result.outcome === 'opened'
            ? {
                status: 'opened',
                ...(result.requestId !== undefined
                  ? { requestId: result.requestId }
                  : {}),
              }
            : { status: result.outcome },
        );
      };
      void (async (): Promise<void> => {
        let result: UnlockModelsResult;
        try {
          result = await (onUnlockPurchaseRef.current
            ? onUnlockPurchaseRef.current(settle)
            : defaultUnlockModels({
                source: 'desktop',
                modelId: pending.model,
                onResumed: settle,
              }));
        } catch (error) {
          // The modal shows the failed unlock; record why it failed.
          reportClientAppError(error);
          result = { outcome: 'failed' };
        }
        unlockOpeningRef.current = false;
        settle(result);
      })();
    },
    [defaultUnlockModels, pending.model, refreshAccountRead],
  );

  const handleUnlockPurchase = useCallback((): void => {
    openUnlockCheckout();
  }, [openUnlockCheckout]);

  const handleUnlockCheckNow = useCallback((): void => {
    setUnlockCheckBusy(true);
    void checkModelUnlockNow().finally((): void => {
      if (mountedRef.current) setUnlockCheckBusy(false);
    });
  }, []);

  const handleUnlockApplyRetry = useCallback((): void => {
    setUnlockApplyBusy(true);
    void retryModelUnlockApply().finally((): void => {
      if (mountedRef.current) setUnlockApplyBusy(false);
    });
  }, []);

  /**
   * The CTA's commit path, held to the SAME fail-closed bar as the silent one.
   *
   * Which branch renders is decided by the fail-OPEN constant, so during the
   * empty-registry window a `needs-billing-source` guest reaches the guest
   * branch, signs in, receives free credits — and would commit a native-only
   * model that credits still cannot route. Gating only the silent auto-commit
   * left this second door open to exactly the dead end the split was added to
   * prevent. On unproven routability, re-read instead of committing: once the
   * registry has loaded the modal re-renders into the honest native-only
   * branch, which asks for a provider sign-in.
   */
  const handleCoveredFromCta = useCallback(async (): Promise<boolean> => {
    if (!creditsProvenToRunPendingModel) {
      void refreshAccountRead({ fresh: true });
      // Not a refusal: we are re-reading, and the CTA's one-shot latch SHOULD
      // stay open so the user can act again once the registry lands.
      return false;
    }
    // Propagated so a refused commit leaves the CTA's latch open — otherwise
    // the retry this modal promises is a dead click.
    return commitModel(pending.model);
  }, [
    commitModel,
    creditsProvenToRunPendingModel,
    pending.model,
    refreshAccountRead,
  ]);

  useEffect(() => {
    // Case H is billing-free: it needs no account state at all, so it must not
    // sit behind an account read that could fail and strand it on "couldn't
    // check your account" for a question that has nothing to do with billing.
    if (pending.recovery.kind === 'needs-new-chat') {
      return;
    }
    // FRESH. This is the branch-selecting read — the one the user's click on a
    // gated row is actually asking — and it is the only read in the flow that
    // could otherwise return an answer of unbounded age. It decides whether to
    // auto-commit on coverage, so a retained answer here could commit a model
    // whose credits were spent since, or show purchase copy to someone whose
    // admin just granted headroom. The GATE-CLOSE read below stays non-fresh:
    // that is the one that must share its answer with `GetAiCreditsCta`.
    void refreshAccountRead({ fresh: true });
  }, [pending.recovery.kind, refreshAccountRead]);

  /**
   * Re-read the account when the shared cloud gate closes.
   *
   * The branch this modal is showing was chosen from a PRE-sign-in snapshot, so
   * without this a guest who just signed in comes back to "Sign in to your
   * account…" — copy aimed at someone who is now signed in. The CTA's own
   * post-connect coverage check commits when credits are already there; this
   * covers the rest (a connect that yields no credits, or a cancelled one that
   * still changed account state).
   */
  const sawCloudGateRef = useRef(false);
  useEffect(() => {
    if (cloudGatePending !== null) {
      sawCloudGateRef.current = true;
      return;
    }
    if (!sawCloudGateRef.current) return;
    sawCloudGateRef.current = false;
    if (pending.recovery.kind === 'needs-new-chat') return;
    void refreshAccountRead();
  }, [cloudGatePending, pending.recovery.kind, refreshAccountRead]);

  const handleRetry = useCallback((): void => {
    trackRecoveryClick('retry');
    setRetryBusy(true);
    void (async (): Promise<void> => {
      await refreshAccountRead({ fresh: true });
      if (mountedRef.current) {
        setRetryBusy(false);
      }
    })();
  }, [refreshAccountRead, trackRecoveryClick]);

  const probeProviderAuth = useCallback(
    async (
      provider: 'claude' | 'codex',
    ): Promise<AgentProviderAuthStatus | null> => {
      try {
        return provider === 'claude'
          ? await window.api.getClaudeAuthStatus({ forceRefresh: true })
          : await window.api.getCodexAuthStatus({ forceRefresh: true });
      } catch (error) {
        // No snapshot: the login flow treats auth as unknown. Record it.
        reportClientAppError(error);
        return null;
      }
    },
    [],
  );

  /**
   * Take a settled provider-auth snapshot BEFORE mounting AuthLoginModal.
   * Besides making a cancelled login safe, this closes a stale-row race: if
   * auth was restored between the row click and this action, the model can be
   * committed without opening a login surface the user no longer needs.
   */
  const handleSignIn = useCallback((): void => {
    if (pending.recovery.kind !== 'needs-billing-source') return;
    trackRecoveryClick('provider_sign_in');
    const provider = pending.recovery.provider;
    setSignInBusy(true);
    void (async (): Promise<void> => {
      const status = await probeProviderAuth(provider);
      if (!mountedRef.current) return;
      if (status === null || status.probeFailed === true) {
        providerAuthSnapshotRef.current = null;
        setSignInBusy(false);
        setRead({ status: 'inconclusive' });
        return;
      }
      if (status.authenticated === true) {
        // Leave the button busy only when the commit actually landed — the
        // modal unmounts on that path. A refusal keeps it mounted, and a stuck
        // `signInBusy` would permanently disable the one retry affordance the
        // settled purchase branch still offers for case A.
        if (!(await commitModel(pending.model))) setSignInBusy(false);
        return;
      }
      providerAuthSnapshotRef.current = {
        provider,
        authenticated: false,
      };
      setSignInBusy(false);
      setLoginOpen(true);
    })();
  }, [
    commitModel,
    pending.model,
    pending.recovery,
    probeProviderAuth,
    trackRecoveryClick,
  ]);

  /**
   * §4 provider sign-in: re-probe with `forceRefresh` and commit ONLY on a
   * settled `authenticated: true`. A failed probe shows Try again, never
   * "you're still not signed in" — an inconclusive probe is not a logout.
   */
  const handleLoginClosed = useCallback((): void => {
    setLoginOpen(false);
    if (pending.recovery.kind !== 'needs-billing-source') {
      return;
    }
    const provider = pending.recovery.provider;
    const snapshot = providerAuthSnapshotRef.current;
    providerAuthSnapshotRef.current = null;
    if (!snapshot || snapshot.provider !== provider) {
      setSignInBusy(false);
      setRead({ status: 'inconclusive' });
      return;
    }
    setSignInBusy(true);
    void (async (): Promise<void> => {
      const status = await probeProviderAuth(provider);
      if (!mountedRef.current) return;
      if (status === null || status.probeFailed === true) {
        setSignInBusy(false);
        setRead({ status: 'inconclusive' });
        return;
      }
      if (status.authenticated === true) {
        // Same as `handleSignIn`: only a landed commit unmounts us, so a
        // refusal must release the button.
        if (!(await commitModel(pending.model))) setSignInBusy(false);
        return;
      }
      if (mountedRef.current) {
        setSignInBusy(false);
        void refreshAccountRead();
      }
    })();
  }, [
    pending.recovery,
    pending.model,
    commitModel,
    probeProviderAuth,
    refreshAccountRead,
  ]);

  // The login modal wins outright: it is the child surface we asked for.
  if (loginOpen && pending.recovery.kind === 'needs-billing-source') {
    return (
      <AuthLoginModal
        provider={pending.recovery.provider}
        ownerDocument={ownerDocument}
        onClose={handleLoginClosed}
      />
    );
  }

  // While the shared cloud gate is up this modal HIDES (display:none via the
  // overlay class) instead of unmounting, so `CloudSyncModal` is not buried
  // under our overlay.
  //
  // Hidden, NOT unmounted — load-bearing. `GetAiCreditsCta` is the thing that
  // called `requestConnect`, and `CloudConnectGate` closes by resolving first
  // and invoking `proceed` afterwards. Unmounting here left that callback an
  // orphan whose `mountedRef` was already false, so its post-connect coverage
  // re-read bailed out and fell through to opening a billing page: the guest
  // signed in, received the free starting credits the copy promised, and got a
  // purchase page plus a modal still telling them to sign in.
  //
  // Still a plain render-time read of the store, NOT a latched flag, so a
  // CANCELLED sign-in (where `proceed` never ran) brings the modal straight
  // back rather than leaving an invisible dialog holding a pending selection.
  const hiddenBehindCloudGate = cloudGatePending !== null;

  const signInProvider =
    pending.recovery.kind === 'needs-billing-source'
      ? pending.recovery.provider
      : null;

  /**
   * CAN-4766 — connect the current model's provider. It keeps the provider
   * sign-in flow (`AuthLoginModal`); only the label names the outcome.
   */
  const renderSignIn = (
    weight: 'primary' | 'secondary' = 'secondary',
    label: string = signInProvider
      ? connectProviderLabel(getProviderLabel(signInProvider))
      : '',
  ): JSX.Element | null => {
    if (!signInProvider) return null;
    return (
      <LoadingButton
        size="compact"
        variant={weight}
        className="w-full"
        data-testid="model-recovery-sign-in"
        loading={signInBusy}
        spinnerTestId="model-recovery-sign-in-spinner"
        onClick={handleSignIn}
      >
        {label}
      </LoadingButton>
    );
  };

  const renderRetry = (): JSX.Element => (
    <LoadingButton
      size="compact"
      variant="primary"
      className="w-full"
      data-testid="model-recovery-try-again"
      loading={retryBusy}
      spinnerTestId="model-recovery-try-again-spinner"
      onClick={handleRetry}
    >
      Try again
    </LoadingButton>
  );

  const handleDismiss = (): void => {
    trackRecoveryClick('dismiss');
    onCancel();
  };

  const shell = (
    title: string,
    body: JSX.Element,
    actions?: JSX.Element,
  ): JSX.Element => (
    <DialogModal
      onClose={handleDismiss}
      title={title}
      maxWidth="sm"
      // Matches AuthLoginModal so the two never fight over stacking order.
      // `hidden` while the cloud gate owns the screen — see
      // `hiddenBehindCloudGate`; the subtree stays mounted underneath.
      overlayClassName={hiddenBehindCloudGate ? 'hidden' : ''}
      dataTestId="model-recovery-modal"
      ownerDocument={ownerDocument}
    >
      <div className="flex flex-col gap-4">
        <div className="text-s leading-relaxed fg-secondary">{body}</div>
        {actions ? (
          <div className="flex flex-col gap-2 pointer-coarse:gap-4">
            {actions}
          </div>
        ) : null}
      </div>
    </DialogModal>
  );

  // ---- Case H: billing-free, and deliberately NOT the continue dialog's copy.
  // That dialog promises to bring a summary across, which is exactly what a
  // non-continuable pair cannot do. Promising it would be a lie.
  if (pending.recovery.kind === 'needs-new-chat') {
    const { lockedProvider, lockedHarness } = pending.recovery;
    const sourceHarness =
      lockedHarness ??
      (isModelHarness(lockedProvider) ? lockedProvider : undefined);
    const lockedLabel = sourceHarness
      ? `the ${getProviderLabel(sourceHarness)} harness`
      : getProviderLabel(lockedProvider);
    const targetHarness = getExecutionHarnessForModel(pending.model);
    const targetLabel = targetHarness
      ? `the ${getProviderLabel(targetHarness)} harness`
      : 'another harness';
    return shell(
      `Start a new chat with ${targetLabel}?`,
      <span data-testid="model-recovery-new-chat-body">
        {`This chat uses ${lockedLabel} and can't switch to ${targetLabel}. Starting a new chat leaves this one unchanged.`}
      </span>,
      <>
        <Button
          size="compact"
          variant="primary"
          className="w-full"
          data-testid="model-recovery-start-new-chat"
          onClick={(): void => onStartNewChat?.(pending.model)}
        >
          {`Start a new chat`}
        </Button>
      </>,
    );
  }

  // ---- Read in flight. Never assert an account state we haven't read.
  if (read.status === 'loading') {
    return shell(
      modelLabel,
      <span
        data-testid="model-recovery-checking"
        className="flex items-center gap-2"
      >
        <LoadingSpinner dataTestId="model-recovery-checking-spinner" />
        Checking your account…
      </span>,
    );
  }

  // ---- The recovery SUCCEEDED but the host refused the commit.
  //
  // Owns its own branch rather than decorating whichever branch happened to be
  // rendering, because the underlying account state is now "resolved" — the
  // credits landed, or the login went through — and every resolved branch
  // either has no action left or offers the wrong one (a covered account shown
  // a purchase). Only this branch can promise the retry the copy describes.
  //
  // **Try again** re-attempts the COMMIT rather than re-reading the account.
  // The account question is already answered — re-reading would be the wrong
  // retry for a provider-sign-in recovery, whose success came from
  // `probeProviderAuth` and which a coverage read would never re-establish. A
  // still-refused retry simply re-renders this branch. Takes priority over
  // every read-status branch below.
  if (commitBlockedReason !== null) {
    return shell(
      modelLabel,
      <span
        role="status"
        data-testid="model-recovery-commit-blocked"
        className="flex flex-col gap-2"
      >
        <span>{commitBlockedReason}</span>
        {/* Claims no condition. The reason above deliberately names no cause,
            because `false` also covers `setModelAndWait`'s pre-flight bail-outs
            and swallowed IPC rejections — so "once that clears" would have no
            antecedent, and on those paths "will be selected" is a promise that
            can never come true. Say what is certain: the model is still
            waiting, and there are two ways out. */}
        <span
          className="fg-secondary"
          data-testid="model-recovery-blocked-hint"
        >
          {commitAttempt === 0
            ? `${modelLabel} is still waiting. Try again, or close this and pick it from the picker later.`
            : `Still no luck. Try again, or close this and pick ${modelLabel} from the picker later.`}
        </span>
      </span>,
      <>
        <LoadingButton
          size="compact"
          variant="primary"
          className="w-full"
          data-testid="model-recovery-commit-retry"
          loading={commitRetryBusy}
          spinnerTestId="model-recovery-commit-retry-spinner"
          onClick={(): void => {
            // Counter FIRST: a still-refused commit re-sets the same reason,
            // which React treats as no change, so this is the only thing that
            // guarantees the press repaints and can be acknowledged.
            setCommitAttempt((n) => n + 1);
            setCommitRetryBusy(true);
            void commitModel(pending.model).finally(() => {
              if (mountedRef.current) setCommitRetryBusy(false);
            });
          }}
        >
          Try again
        </LoadingButton>
      </>,
    );
  }

  // ---- Routability still unknown, and it is the thing this branch turns on.
  //
  // `creditsCanRunPendingModel` fails OPEN and `creditsProvenToRunPendingModel`
  // fails CLOSED, so while the gateway registry is empty a `needs-billing-source`
  // recovery on an account that already has credits renders the self-serve
  // branch — and its button re-reads instead of committing, repainting the
  // identical modal. That is the silent no-op click this ticket exists to
  // remove. The registry genuinely IS still loading, so say so and let the
  // honest branch (purchase, or native-only) render once it lands.
  if (needsGatewayRoute && !gatewayRoutesKnown) {
    return shell(
      modelLabel,
      <span
        data-testid="model-recovery-checking-routes"
        className="flex items-center gap-2"
      >
        <LoadingSpinner dataTestId="model-recovery-checking-routes-spinner" />
        Checking what this model can run on…
      </span>,
    );
  }

  // ---- CAN-3026: a guest picked a model Canopy would pay for that is not on
  // the guest allowlist. An ACCOUNT is the missing thing, not a balance, so
  // this branch sits ahead of every credits branch and needs no billing
  // arithmetic at all. `needsGatewayRoute` is false for this kind, so the
  // routes-loading shell above never intercepts it.
  //
  // Conditioned on the LIVE `read.guest` as well as the snapshotted recovery:
  // a guest who signs in while this modal is open is no longer a guest, and
  // must fall straight through to the ordinary coverage branches (which then
  // commit) rather than being asked to sign in again.
  //
  // An inconclusive read deliberately falls through to the branch below. We
  // cannot prove guest-ness, and Try again is a better answer than a sign-in
  // prompt aimed at someone who may already be signed in.
  if (
    pending.recovery.kind === 'needs-account' &&
    read.status === 'settled' &&
    read.guest
  ) {
    // CAN-4028 — when the account will also need a purchase after sign-in,
    // say so up front with the shared unlock copy, so the sign-in is not
    // followed by a second, unannounced ask. Sign-in alone keeps its own copy.
    const thenPurchase =
      pending.recovery.access === 'needs_sign_in_then_purchase';
    // CAN-4703 — one value drives both the "right now" sentence and the
    // fallback button, so a snapshot without a host callback offers neither.
    const snapshotFallback =
      onUseGuestFallback === undefined ? undefined : pending.guestFallback;
    const fallback = snapshotFallback;
    const copy = guestModelGateCopy({
      modelLabel,
      appName: brandText.appName,
      access: thenPurchase ? 'needs_sign_in_then_purchase' : 'needs_sign_in',
      ...(fallback === undefined ? {} : { fallbackLabel: fallback.label }),
    });
    return (
      <DialogModal
        inset="flush"
        onClose={(): void => {
          if (!commitInFlightRef.current) onCancel();
        }}
        title={copy.title}
        maxWidth="sm"
        overlayClassName={hiddenBehindCloudGate ? 'hidden' : ''}
        dataTestId="model-recovery-modal"
        ownerDocument={ownerDocument}
        trapFocus
        initialFocusRef={guestSignInRef}
        // The picker owns composer restoration and its originating-chat guard.
        restoreFocusWhen={(): boolean => false}
        closeButtonDisabled={fallbackBusy}
        closeOnBackdrop={!fallbackBusy}
        closeOnEscape={!fallbackBusy}
      >
        <GuestModelGateContent
          subject={{
            modelLabel,
            appName: brandText.appName,
            access: thenPurchase
              ? 'needs_sign_in_then_purchase'
              : 'needs_sign_in',
          }}
          {...(fallback === undefined
            ? {}
            : {
                fallback: {
                  label: fallback.label,
                  onActivate: (): void => handleUseGuestFallback(fallback),
                },
              })}
          dataTestId="model-recovery"
          bodyTestId="model-recovery-needs-account"
          dismissTestId="model-recovery-cancel"
          busy={fallbackBusy}
          error={fallbackError}
          onDismiss={(): void => {
            if (!commitInFlightRef.current) onCancel();
          }}
          renderSignIn={(label): JSX.Element => (
            <Button
              size="compact"
              variant="primary"
              className="w-full"
              ref={guestSignInRef}
              data-testid="model-recovery-account-sign-in"
              // The fallback is one outcome; a sign-in started over it would be a
              // second, competing one.
              disabled={fallbackBusy}
              onClick={(): void => {
                // The purchase variant is the unlock action itself: it opens the
                // shared sign-in gate, then checkout in the browser as soon as a
                // real account exists, without a second ask in between.
                if (commitInFlightRef.current) return;
                if (thenPurchase) {
                  handleUnlockPurchase();
                  return;
                }
                // The SHARED gate, not a bespoke sign-in. This modal hides (rather
                // than unmounts) behind it — see `hiddenBehindCloudGate` — so the
                // gate-close effect above re-reads the account, `read.guest` flips
                // false, and the ordinary coverage path commits the model.
                //
                // `proceed` is empty for that reason: the commit is owned by the
                // coverage re-read, which is the only thing that can prove the new
                // account can actually run this model.
                useCloudConnectGateStore.getState().requestConnect(
                  {
                    title: guestModelGateTitle(),
                    // The panel's lead line and benefit rows carry the pitch.
                    subtitle: null,
                    toastMessage: guestModelGateToast(modelLabel),
                    guestBenefits: true,
                  },
                  () => {},
                );
              }}
            >
              {label}
            </Button>
          )}
        />
      </DialogModal>
    );
  }

  // ---- CAN-4028: signed in, and a card purchase is what unlocks this model.
  //
  // Ahead of every credits branch for the same reason the guest branch is: a
  // balance is not the missing thing. A non-payer's balance would otherwise
  // land them on "Use {model}", which the server will not honor for a locked
  // model.
  //
  // Reached two ways: a signed-in row click (`needs-purchase`), and a guest
  // who signed in from the branch above and still needs the purchase. The
  // second is why this reads the settled snapshot rather than the recovery
  // kind.
  //
  // Checkout is in the browser, so after it opens the rest is narrated from
  // the pending intent. The app root's poll confirms the purchase and applies
  // the model through the host; on success the host closes this modal.
  if (read.status === 'settled' && read.libraryPurchaseRequired) {
    // Every state of this dialog names the pending model, not the composer's
    // current one, which can differ while the purchase is in flight. A
    // followed purchase names its own model, which an adopted purchase may
    // not share with this row.
    const unlockTitle = modelLibraryUnlockTitle(
      unlockRequestId === undefined ? modelLabel : unlockModelLabel,
    );
    const purchaseButton = (label: string): JSX.Element => (
      <LoadingButton
        size="compact"
        variant="primary"
        className="w-full"
        data-testid="model-recovery-unlock-purchase"
        loading={unlockAttempt.status === 'opening'}
        spinnerTestId="model-recovery-unlock-purchase-spinner"
        onClick={handleUnlockPurchase}
      >
        {label}
      </LoadingButton>
    );
    const checkNowButton = (primary: boolean): JSX.Element => (
      <LoadingButton
        size="compact"
        variant={primary ? 'primary' : 'secondary'}
        className="w-full"
        data-testid="model-recovery-unlock-check-now"
        loading={unlockCheckBusy}
        spinnerTestId="model-recovery-unlock-check-now-spinner"
        loadingLabel={MODEL_LIBRARY_UNLOCK_COPY.checkingAction}
        onClick={handleUnlockCheckNow}
      >
        {MODEL_LIBRARY_UNLOCK_COPY.checkNowAction}
      </LoadingButton>
    );

    // The work belongs to an organization this user cannot fund. A personal
    // purchase would not unlock it, so none is offered.
    if (unlockAttempt.status === 'contact-admin') {
      return shell(
        unlockTitle,
        <span data-testid="model-recovery-unlock-contact-admin">
          {CONTACT_ORG_ADMIN_COPY}
        </span>,
      );
    }

    // Confirmed, but the model did not land. The unlock stands; only the
    // selection is offered again — the one place "Use {model}" appears.
    if (unlockPhase === 'apply-failed') {
      return shell(
        unlockTitle,
        <span
          role="status"
          data-testid="model-recovery-unlock-apply-failed"
          className="flex flex-col gap-2"
        >
          <span>{MODEL_LIBRARY_UNLOCK_COPY.confirmed}</span>
          <span>
            {unlockModelLabel === undefined
              ? MODEL_LIBRARY_UNLOCK_COPY.selectionFailed
              : `We couldn’t switch to ${unlockModelLabel} just now.`}
          </span>
        </span>,
        <>
          <LoadingButton
            size="compact"
            variant="primary"
            className="w-full"
            data-testid="model-recovery-unlock-use-model"
            loading={unlockApplyBusy}
            spinnerTestId="model-recovery-unlock-use-model-spinner"
            onClick={handleUnlockApplyRetry}
          >
            {unlockModelLabel === undefined
              ? MODEL_LIBRARY_UNLOCK_COPY.retrySelection
              : `Use ${unlockModelLabel}`}
          </LoadingButton>
        </>,
      );
    }

    // Confirmed. Either the host is applying the model right now and will
    // close this modal, or there was nothing left to apply (the selection
    // moved while the user was paying) and Close is the only thing to offer.
    if (unlockPhase === 'applying' || unlockPhase === 'unlocked') {
      return shell(
        unlockTitle,
        <span
          role="status"
          data-testid="model-recovery-unlock-confirmed"
          className="flex items-center gap-2"
        >
          {unlockPhase === 'applying' && (
            <LoadingSpinner
              dataTestId="model-recovery-unlock-confirmed-spinner"
              decorative
            />
          )}
          {MODEL_LIBRARY_UNLOCK_COPY.confirmed}
        </span>,
      );
    }

    // The poll stopped. That is all it means: the payment may still be in
    // progress, so nothing here calls it failed. The only way past it is an
    // explicit new purchase, which says it does not cancel this one.
    if (unlockPhase === 'timed-out' && unlockRequestId !== undefined) {
      const timedOutRequestId = unlockRequestId;
      const openingNew = unlockAttempt.status === 'opening';
      return shell(
        unlockTitle,
        <span
          data-testid="model-recovery-unlock-timed-out"
          className="flex flex-col gap-2"
        >
          <span role="status" className="flex flex-col gap-1">
            <span className="fg-primary">
              {MODEL_LIBRARY_UNLOCK_COPY.timedOutTitle}
            </span>
            <span>{MODEL_LIBRARY_UNLOCK_COPY.timedOutBody}</span>
          </span>
          <span data-testid="model-recovery-unlock-new-purchase-help">
            {MODEL_LIBRARY_UNLOCK_COPY.newPurchaseHelp}
          </span>
          {unlockAttempt.status === 'adopted' &&
          unlockAttempt.newPurchaseFailed === true ? (
            <ErrorBanner
              errorSource="model-recovery-unlock-failed"
              error="We couldn’t open your browser. Try again."
              className=""
              testId="model-recovery-unlock-failed"
            />
          ) : null}
        </span>,
        <>
          {checkNowButton(true)}
          <LoadingButton
            size="compact"
            variant="secondary"
            className="w-full"
            data-testid="model-recovery-unlock-new-purchase"
            loading={openingNew}
            spinnerTestId="model-recovery-unlock-new-purchase-spinner"
            onClick={(): void => openUnlockCheckout(timedOutRequestId)}
          >
            {MODEL_LIBRARY_UNLOCK_COPY.newPurchaseAction}
          </LoadingButton>
        </>,
      );
    }

    // Checkout is open in the browser, whether this modal opened it or adopted
    // it. Closing does not cancel: the purchase is in the browser, and the
    // pending model is still applied, in the chat where it started, when it
    // completes.
    if (unlockPhase === 'waiting') {
      return shell(
        unlockTitle,
        <span role="status" data-testid="model-recovery-unlock-waiting">
          {modelLibraryWaitingInBrowserBody(unlockModelLabel)}
        </span>,
        <>{checkNowButton(false)}</>,
      );
    }

    // Opened, but not (or no longer) followed: an organization-owned purchase
    // cannot be read back, so a re-check here would be a button that can
    // never report success, and no model is promised.
    if (unlockAttempt.status === 'opened') {
      return shell(
        unlockTitle,
        <span role="status" data-testid="model-recovery-unlock-waiting">
          {modelLibraryWaitingInBrowserBody()}
        </span>,
      );
    }

    return shell(
      unlockTitle,
      <span data-testid="model-recovery-unlock" className="flex flex-col gap-2">
        <span>{MODEL_LIBRARY_UNLOCK_COPY.purchaseBody}</span>
        {unlockAttempt.status === 'failed' ? (
          <ErrorBanner
            errorSource="model-recovery-unlock-failed"
            error="We couldn’t open your browser. Try again."
            className=""
            testId="model-recovery-unlock-failed"
          />
        ) : null}
      </span>,
      <>{purchaseButton(MODEL_LIBRARY_UNLOCK_COPY.purchaseAction)}</>,
    );
  }

  // ---- Read failed / inconclusive. Try again, sign-in for case A, NO purchase.
  if (read.status === 'inconclusive') {
    return shell(
      modelLabel,
      <span data-testid="model-recovery-inconclusive">
        {`We couldn't check your ${brandText.appName} account just now, so we don't know what's available for ${modelLabel}.`}
      </span>,
      <>
        {renderRetry()}
        {renderSignIn()}
      </>,
    );
  }

  // Pass the lapsed names IN: the helper only ever echoes back what it is
  // given, and it is what clears them again when the user can still spend.
  const coverage = resolveAiCreditsCoverage(read.availability, read.lapsedOrgs);
  const creditsLabel = AI_CREDITS_PURCHASE_LABEL;
  // Every purchase from this dialog goes to the browser, like the chat
  // banners, so the hand-off and Check again stay here and the composer
  // confirms the credits once they land (CAN-5160). Settings would end the
  // hand-off before the purchase did.
  const purchaseTracking = {
    billingDestination: 'browser',
    confirmArrival: 'model-picker',
    ...(aiCreditsScope ? { aiCreditsScope } : {}),
  } as const;
  // Case C: the user is switching this chat's billing mode, not unlocking a
  // model. Copy that names the model as the thing needing credits is wrong.
  const billingModeIntent = pending.intent === 'enable-ai-credits';
  // The branches below are the no-credits states for a credits-shaped
  // recovery (CAN-4633); each renders this so the view is recorded on mount.
  const creditsRecoveryView =
    pending.recovery.kind === 'needs-billing-source' ||
    pending.recovery.kind === 'needs-credits' ? (
      <CreditsRecoveryView
        surface="model_recovery"
        trigger={billingModeIntent ? 'billing_mode_switch' : 'model_select'}
        dedupeKey={pending.model}
        shownRef={creditsRecoveryShownRef}
      />
    ) : null;
  const trackPurchaseClick = (): void => trackRecoveryClick('credits_purchase');

  // ---- Native-only model with no provider login. Credits cannot route this
  // model at all, so offering a purchase would sell the user something that
  // does not unblock them. Connecting the provider is the ONLY exit.
  //
  // Checked BEFORE the guest branch on purpose. That branch offers a purchase
  // after sign-in and commits on coverage, which for a native-only model is a
  // promise AI Credits can never keep.
  if (!creditsCanRunPendingModel && signInProvider) {
    return shell(
      modelLabel,
      <span data-testid="model-recovery-native-only">
        {`This model runs on your ${getProviderLabel(signInProvider)} subscription — ${brandText.appName} AI Credits can't pay for it. ${connectProviderLabel(getProviderLabel(signInProvider))} to use it.`}
      </span>,
      renderSignIn('primary') ?? undefined,
    );
  }

  // ---- Guest / not connected (CAN-4766). A guest can't buy before signing
  // in, so the purchase action says both. Where the provider can run the
  // model, connecting it leads; a gateway-only model offers the purchase alone.
  if (read.guest) {
    return shell(
      modelLabel,
      <span data-testid="model-recovery-guest">
        {`Sign in, then buy AI Credits to use ${modelLabel}.`}
        {creditsRecoveryView}
      </span>,
      <>
        {renderSignIn('primary')}
        <GetAiCreditsCta
          label={AI_CREDITS_GUEST_PURCHASE_LABEL}
          onCovered={handleCoveredFromCta}
          onOpenedInApp={onCancel}
          onGetCreditsClick={(): void => trackRecoveryClick('account_sign_in')}
          {...(aiCreditsScope ? { aiCreditsScope } : {})}
          dataTestId="model-recovery-get-credits"
          buttonVariant={signInProvider ? 'secondary' : 'primary'}
          buttonSize="compact"
        />
      </>,
    );
  }

  // ---- Org member whose org has the credit pool but no headroom. They cannot
  // self-serve, so there is NO purchase CTA — but this must not be a dead-end
  // modal either: headroom can be granted while it is open, so Try again stays.
  if (coverage.showContactAdmin || coverage.lapsedOrgNames.length > 0) {
    const lapsed = coverage.lapsedOrgNames.length > 0;
    const ownerOrganizationName =
      read.status === 'settled'
        ? read.availability.ownerOrganization?.name
        : undefined;
    return shell(
      modelLabel,
      <span data-testid="model-recovery-contact-admin">
        {ownerOrganizationName ? (
          <span data-testid="model-recovery-contact-admin-org">
            {`${ownerOrganizationName}'s AI Credits balance can't cover this model right now. `}
          </span>
        ) : (
          `Your organization's AI Credits balance can't cover this model right now. `
        )}
        {lapsed ? CONTACT_ORG_ADMIN_LAPSED_COPY : CONTACT_ORG_ADMIN_COPY}
        {creditsRecoveryView}
      </span>,
      <>
        {renderRetry()}
        {renderSignIn()}
      </>,
    );
  }

  // ---- Ordinary self-serve. Case A leads with connecting the provider and
  // offers credits beside it (CAN-4766); case B never offers it (a
  // gateway-only model can never bill to a subscription, so connecting Claude
  // would not unblock anything).
  //
  // When a purchase is possible, the modal leads with the missing balance.
  const purchaseTitle = billingModeIntent
    ? BILLING_MODE_TITLE
    : signInProvider && coverage.showPurchase
      ? `Choose how to use ${modelLabel}`
      : modelLabel;
  return shell(
    purchaseTitle,
    <span data-testid="model-recovery-purchase">
      {billingModeIntent
        ? // Case C escalation: nothing is wrong with `modelLabel` — the user
          // asked to bill this chat to credits and has none to bill to.
          OUT_OF_CREDITS_BILLING_MODE_COPY
        : signInProvider
          ? coverage.showPurchase
            ? OUT_OF_CREDITS_COPY
            : `To use ${modelLabel}, connect ${getProviderLabel(signInProvider)} or add ${brandText.appName} AI Credits.`
          : `This model runs on ${brandText.appName} AI Credits. Add credits to start using it.`}
      {creditsRecoveryView}
    </span>,
    <>
      {renderSignIn('primary')}
      <GetAiCreditsCta
        label={
          coverage.showPurchase
            ? creditsLabel
            : billingModeIntent
              ? 'Bill this chat to AI Credits'
              : `Use ${modelLabel}`
        }
        onCovered={handleCoveredFromCta}
        {...(coverage.showPurchase
          ? purchaseTracking
          : { onOpenedInApp: onCancel })}
        onGetCreditsClick={trackPurchaseClick}
        {...(aiCreditsScope ? { aiCreditsScope } : {})}
        dataTestId="model-recovery-get-credits"
        buttonVariant={signInProvider ? 'secondary' : 'primary'}
        buttonSize="compact"
      />
    </>,
  );
}
