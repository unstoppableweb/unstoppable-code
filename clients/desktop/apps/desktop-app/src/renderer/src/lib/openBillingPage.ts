import {
  aiCreditsConfirmationBalanceLoader,
  personalBalanceReading,
  readAiCreditsConfirmationBalance,
  type PersonalBalanceReading,
} from '@/lib/aiCreditsConfirmationBalance';
import { useCallback } from 'react';
import {
  creditsBillingOwnerKey,
  resolveCreditsCoverage,
  type CreditsCoverage,
} from '@canopy/app-state/billing/credits';
import type {
  AiCreditsScopeRequest,
  NativeAiCreditsAvailability,
} from '@canopy/desktop-shared/types';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import {
  cloudAccountIdentityKey,
  isGuestAccount,
} from '@canopy/desktop-shared/lib/guest-account';
import { settingsPaymentHandoffResultSchema } from '@canopy/protocol/settings/payment-handoff';
import { settingsActionErrorCopy } from '@canopy/ui-app/settings/errors';
import { useGitHubStore } from '@/stores/githubStore';
import {
  buildBillingTopUpIntentPath,
  isBillingIntentIdentifier,
  resolveCreditsBillingTarget,
  type ModelLibraryUnlockSource,
} from '@canopy/protocol/billing';
import {
  AI_CREDITS_PURCHASE_LABEL,
  CONTACT_ORG_ADMIN_COPY,
  MODEL_LIBRARY_UNLOCK_COPY,
} from '@canopy/ui-shared/components';
import { hostedSettingsOpenable } from '@/components/settings/hosted/hosted-settings-availability';
import { registeredCreditsHandoffClient } from '@/client/hosted-settings-client-registry';
import { announceAiCreditsChanged } from '@/lib/aiCreditsChanged';
import { brandText } from '@/lib/brand';
import { isCanopyCloudConnected } from '@/lib/canopy-cloud';
import { openAuthenticatedCloudPageReported } from '@/lib/openAuthenticatedCloudPage';
import {
  aiCreditsScopeKey,
  readNavigationScopeKey,
} from '@/lib/aiCreditsScope';
import {
  useCloudConnectGateStore,
  type CloudConnectGateContext,
} from '@/stores/cloudConnectGateStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { resolveCreditsBillingPath } from '@/lib/contextBillingTarget';
import { refreshWorkModelLibraryAccess } from '@/lib/modelLibraryAccess';
import {
  openSettingsPathOrWebReported,
  type SettingsOpenResult,
} from '@/lib/navigation/settings-destinations';
import {
  beginModelUnlockIntent,
  type ModelUnlockIntentHandlers,
} from '@/lib/modelUnlockIntent';

/**
 * Shared AI-Credits purchase affordances (ECW-9091).
 *
 * Extracted from `AiCreditsUsageLimitBanner` so every banner that offers a
 * credits CTA — the usage-limit banner and the no-billing-source banner — makes
 * the same org-coverage decision and hands off to the same billing page. Two
 * copies of this logic would silently drift and start showing a purchase CTA to
 * org members who cannot buy.
 */

/**
 * Copy for an org member whose org carries the credit-pool capability but has no
 * spendable headroom right now. Defined once with the shared recovery copy.
 */
export { CONTACT_ORG_ADMIN_COPY };

/** Which credits affordance a banner offers; see `resolveCreditsCoverage`. */
export type AiCreditsCoverage = CreditsCoverage;

// Compatibility re-export; new callers import `@/lib/aiCreditsChanged`.
export { announceAiCreditsChanged };

/**
 * The single in-flight availability read, shared by everyone who asks at once.
 *
 * Closing the cloud gate wakes several independent readers on the same event —
 * `ModelRecoveryModal`'s gate-close `refreshAccountRead`, `GetAiCreditsCta`'s
 * post-connect coverage check, and the gate's own re-check. Each used to issue
 * its own IPC read, and two reads of the same account CAN disagree: the credits
 * fan-out is network-backed, and a transient org-credit failure degrades to
 * "uncovered" rather than to an error. That let the modal conclude *covered*
 * and commit while the CTA concluded *uncovered* and opened a billing page for
 * the credits the user had just been granted.
 *
 * ONE ANSWER PER EPISODE is the guarantee. Sharing only the *in-flight* promise
 * would make agreement a timing coincidence: the modal reads availability before
 * account state, while the CTA's post-connect read waits behind a
 * `loadCanopyCloudAccount()` hop, so a fast first read settles during that hop
 * and the second reader issues its own — reopening the disagreement whenever the
 * two answers differ. So the SETTLED RESULT is retained for the episode too, not
 * just the pending promise.
 *
 * Be precise about what that does and does not promise. Readers within one
 * episode always agree. An episode can also END between two readers — on an
 * account change, a gate close, or credit exhaustion from another chat — and
 * then the second reader correctly gets a *different, newer* answer rather than
 * a shared stale one. That is the intended behavior, not a hole: the two are
 * answering questions about different account states. What can never happen is
 * two readers disagreeing about the *same* state, or an answer surviving the
 * state it described.
 *
 * AN EPISODE IS AN ACCOUNT EPOCH, which is what keeps retention safe rather
 * than merely cheap. "In flight" alone is the wrong key: this read fans out per
 * org over the network under a multi-second budget, and `GetAiCreditsCta` seeds
 * one the moment it mounts — so a read STARTED as a guest can still be joined
 * AFTER the user signs in. A guest's pre-sign-in answer is a plain uncovered
 * result carrying no `inconclusive` marker, so joining it post-connect
 * reintroduces the exact bug this helper was added to prevent, only now with
 * both readers confidently agreeing on the previous account. The inverse is
 * just as bad: a stale *covered* answer committing a recovery under an account
 * that no longer holds the credits.
 *
 * Every read is therefore stamped with the epoch it began in, and the epoch is
 * bumped by anything that can change the answer: a cloud-account change, the
 * connect gate closing, and every caller that explicitly asks for a fresh read.
 * A reader from an older epoch never inherits an answer about somebody else.
 *
 * RETENTION IS BOUNDED THREE WAYS, because a retained answer about money is
 * only safe while it is still true:
 *
 * 1. Every decision point that needs current truth — **Try again**, **Check
 *    again**, the post-purchase focus probe, the start of each purchase
 *    attempt, and the recovery modal's opening read — passes `{ fresh: true }`,
 *    which opens a new episode. Without that, retention would silently defeat
 *    the post-purchase re-probe, whose entire job is to notice that the answer
 *    just changed.
 * 2. Anything that changes the answer ends the episode: a cloud-account change,
 *    the connect gate closing, and credit exhaustion mid-session.
 * 3. {@link SHARED_READ_MAX_AGE_MS} is the backstop for everything nobody
 *    thought of. It mirrors `useAiCreditsAvailability`'s TTL for the same
 *    stated reason — a stale value must not be able to outlive the session
 *    because some future flow forgot to invalidate. Two review rounds of this
 *    change were spent on exactly that class of miss, so the episode is capped
 *    rather than trusted.
 */
const SHARED_READ_MAX_AGE_MS = 60_000;

type SharedAvailabilityEntry = {
  readonly epoch: number;
  /** `null` while the read is still in flight; stamped when it settles. */
  settledAt: number | null;
  readonly value: Promise<NativeAiCreditsAvailability | null>;
};
/**
 * Episodes are per owner scope (CAN-3463): two chats owned by different orgs
 * are different questions, and joining one's answer from the other would name
 * the wrong pool. The navigation context is part of every key.
 */
const sharedAvailability = new Map<string, SharedAvailabilityEntry>();
let currentAccountEpoch = 0;

/**
 * Open a new availability episode: drop the retained answer and start counting
 * from a fresh epoch, because whatever it described may no longer be true.
 *
 * Exported so tests can reset this module-level state, and called on every
 * `CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT` — including the one
 * {@link announceAiCreditsChanged} dispatches — on cloud-gate close, and on any
 * `{ fresh: true }` read.
 */
export function invalidateSharedAiCreditsRead(): void {
  currentAccountEpoch += 1;
  sharedAvailability.clear();
}

// Bump on ANY account change, not just the ones routed through
// `announceAiCreditsChanged` — sign-in and sign-out reach this event by other
// paths, and those are precisely the transitions that make an in-flight read
// describe the wrong user. Guarded for non-DOM (test/node) import contexts.
if (
  typeof window !== 'undefined' &&
  typeof window.addEventListener === 'function'
) {
  window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, (): void => {
    invalidateSharedAiCreditsRead();
  });
}

/**
 * Read native AI-credits availability, returning the CURRENT EPISODE's answer
 * — pending or already settled — rather than issuing a second read.
 *
 * Pass `{ fresh: true }` when the caller's whole purpose is to notice a change
 * (**Try again**, **Check again**, the post-purchase focus probe, the start of
 * a purchase attempt). That opens a new episode, so it both gets current truth
 * and gives everyone who reads alongside it the same answer.
 *
 * Never throws or rejects: the bridge itself can be absent (older builds, test
 * surfaces that render without stubbing `window.api`), so a SYNCHRONOUS throw
 * is contained here alongside a rejection. Both mean the same thing — "no
 * read" — which callers must treat as *unknown*, never as "no credits".
 */
export function readSharedAiCreditsAvailability(
  options: {
    readonly fresh?: boolean;
    /** Owner of the work being asked about; omitted = navigation context. */
    readonly scope?: AiCreditsScopeRequest;
  } = {},
): Promise<NativeAiCreditsAvailability | null> {
  const key = aiCreditsScopeKey(options.scope, readNavigationScopeKey());
  const retained = sharedAvailability.get(key);
  if (options.fresh === true) {
    invalidateSharedAiCreditsRead();
  } else if (
    retained?.epoch === currentAccountEpoch &&
    // Age out only a SETTLED answer. While a read is still in flight it is
    // always joinable, because in-flight coalescing is the stronger property
    // and the one this helper was originally added for: aging out a pending
    // read would start a parallel duplicate whose answer could differ from the
    // one another surface is already awaiting. Only a retained *result* can go
    // stale, and only a retained result is capped.
    (retained.settledAt === null ||
      Date.now() - retained.settledAt < SHARED_READ_MAX_AGE_MS)
  ) {
    return retained.value;
  }
  let started: Promise<NativeAiCreditsAvailability | null>;
  try {
    started = window.api
      .loadNativeAiCreditsAvailability(options.scope)
      .catch((): NativeAiCreditsAvailability | null => null);
  } catch {
    return Promise.resolve(null);
  }
  const epochAtStart = currentAccountEpoch;
  const entry: SharedAvailabilityEntry = {
    epoch: epochAtStart,
    settledAt: null,
    // Retained after it settles, so a reader arriving one IPC hop later gets
    // this same answer instead of asking again and possibly getting a
    // different one. The episode — not the promise's lifetime — is the scope.
    //
    // The epoch is re-checked AT RESOLUTION, not only at join time, because
    // dropping the handle cannot reach a caller that is already awaiting this
    // promise. Credits can be exhausted by another chat while a recovery read
    // is in flight: without this, that read would resolve `covered` afterwards
    // and its existing awaiters would commit a model whose credits are gone.
    // A superseded answer degrades to `null`, which every caller already
    // handles as *unknown* — the modal shows its inconclusive branch, the CTA
    // shows "we couldn't check your account", and neither commits nor
    // purchases. Failing to an honest non-answer is the only safe way to
    // retract an answer someone is already waiting on.
    value: started.then((value) =>
      epochAtStart === currentAccountEpoch ? value : null,
    ),
  };
  void started.finally((): void => {
    if (sharedAvailability.get(key) === entry) {
      entry.settledAt = Date.now();
    }
  });
  sharedAvailability.set(key, entry);
  return entry.value;
}

/**
 * Resolve which credits affordance (if any) a banner should offer. The rules
 * are the shared purchase state's `resolveCreditsCoverage`: a `null` or
 * inconclusive read offers nothing.
 */
export function resolveAiCreditsCoverage(
  availability: NativeAiCreditsAvailability | null,
): AiCreditsCoverage {
  return resolveCreditsCoverage(availability);
}

/**
 * The page credits are bought on for the selected navigation context: the
 * organization's billing for its OWNER (the only role that can fund its pool),
 * the personal account billing page for everyone else (CAN-3463).
 */
function creditsBillingPath(
  availability: NativeAiCreditsAvailability | null,
  scope?: AiCreditsScopeRequest,
): string {
  try {
    const { context, organizations } =
      useWorkspaceContextStore.getState().state;
    if (availability?.ownerOrganization) {
      return resolveCreditsBillingPath(
        {
          kind: 'organization',
          organizationId: availability.ownerOrganization.id,
        },
        organizations,
      );
    }
    // A work-scoped read with no organization owner is Personal (or could not
    // establish an owner). Never substitute an unrelated live org selection.
    if (scope?.kind === 'work') return '/account/billing';
    return resolveCreditsBillingPath(context, organizations);
  } catch {
    return '/account/billing';
  }
}

/**
 * The plain, unauthenticated AI Credits page (`pricingUrl`, named for the
 * retired pricing page): the last resort when the signed-in hand-off opened
 * nothing. Resolves to whether a browser page opened.
 */
async function openUnauthenticatedBillingPage(
  availability: NativeAiCreditsAvailability | null,
): Promise<boolean> {
  const url = availability?.pricingUrl;
  if (!url) return false;
  try {
    await window.api.browser.openExternal({ url });
    return true;
  } catch {
    // Best-effort external open.
    return false;
  }
}

/**
 * Where a Buy AI Credits billing open went. `'settings'`: Billing opened
 * inside Settings and the user has NOT left the app. `'web'`: a browser page
 * opened (signed-in billing, or the unauthenticated billing fallback).
 * `'failed'`: nothing opened.
 */
export type BillingPageOpenResult = SettingsOpenResult | 'failed';

let stopSettingsCloseReread: (() => void) | null = null;

/**
 * Re-read AI Credits once Settings closes after an in-app Billing open
 * (CAN-4691). A top-up from there still finishes in the browser, and the
 * surfaces behind Settings stay mounted holding a conclusive answer that
 * nothing re-reads on a timer (the availability TTL applies only when a
 * consumer re-runs its read). Announced through the same
 * `announceAiCreditsChanged` the browser-return probe uses, so usage, account
 * and model-library surfaces refresh too. Unlike that probe it announces on
 * close whether or not anything was bought: there is no prior read to compare
 * against, and one extra refresh per in-app open is cheap. One-shot: a later
 * Settings visit does not re-read again, so a purchase that lands after the
 * close shows up only on a later availability read.
 */
function rereadAiCreditsWhenSettingsCloses(): void {
  stopSettingsCloseReread?.();
  const unsubscribe = useNavigationStore.subscribe((state, previous) => {
    if (!previous.settingsOpen || state.settingsOpen) return;
    unsubscribe();
    stopSettingsCloseReread = null;
    announceAiCreditsChanged();
  });
  stopSettingsCloseReread = unsubscribe;
}

/**
 * Where a Buy AI Credits click may open billing (CAN-5159). `'auto'`: Settings
 * → Billing in-app when hosted settings are openable, otherwise the browser.
 * `'browser'`: always the browser, for inline chat banners that must keep the
 * purchase hand-off (waiting state, Check again, arrival) in the chat.
 */
export type BillingDestination = 'auto' | 'browser';

export interface OpenBillingPageOptions {
  /** Defaults to `'auto'`. */
  destination?: BillingDestination;
  /**
   * Appends the `topUp=1&reason=credits&source=<topUpSource>` intent to the
   * signed-in billing path, so the web page opens its top-up. Never sent to
   * the unauthenticated billing fallback.
   */
  topUpSource?: ModelLibraryUnlockSource;
}

/**
 * The owner billing path with the credits top-up intent appended. A path the
 * intent builder rejects falls back to the plain owner path: a bad intent
 * must never stop billing from opening.
 */
function withCreditsTopUpIntent(
  path: string,
  source: ModelLibraryUnlockSource,
): string {
  try {
    return buildBillingTopUpIntentPath(path, { reason: 'credits', source });
  } catch {
    return path;
  }
}

/** The signed-in web billing page, skipping Settings (CAN-5159). */
async function openBillingInBrowser(
  path: string,
): Promise<BillingPageOpenResult> {
  return (await openAuthenticatedCloudPageReported(path)) ? 'web' : 'failed';
}

/**
 * Open the credits billing page (CAN-4691). With the default `'auto'`
 * destination: inside Settings when hosted settings are openable in this
 * window (never a Remote Control window, never with the rollout flag off),
 * otherwise the web page already signed in. With `'browser'` (CAN-5159): the
 * signed-in web page even when Settings could open, so the caller's
 * "finish this in your browser" state survives; it never answers
 * `'settings'` and never arms the Settings-close re-read. Either way, only
 * when the signed-in hand-off opened nothing, the plain AI Credits page.
 *
 * The answer is load-bearing for callers that render a "finish this in your
 * browser" state. `'settings'` means there is no browser to return from, so
 * they must not render one. `'failed'` happens when the signed-in hand-off
 * opens nothing AND `availability` carries no `pricingUrl` (a `null` read, or
 * one that never resolved); a caller that assumed a page opened would strand
 * the user waiting on one that does not exist, so it keeps the button and
 * says so instead.
 */
export async function openBillingPage(
  availability: NativeAiCreditsAvailability | null,
  scope?: AiCreditsScopeRequest,
  options: OpenBillingPageOptions = {},
): Promise<BillingPageOpenResult> {
  const ownerPath = creditsBillingPath(availability, scope);
  const path = options.topUpSource
    ? withCreditsTopUpIntent(ownerPath, options.topUpSource)
    : ownerPath;
  const result =
    options.destination === 'browser'
      ? await openBillingInBrowser(path)
      : await openSettingsPathOrWebReported(path);
  if (result === 'settings') rereadAiCreditsWhenSettingsCloses();
  if (result !== 'failed') return result;
  return (await openUnauthenticatedBillingPage(availability))
    ? 'web'
    : 'failed';
}

/**
 * The connect-gate context for every Buy AI Credits click (CAN-4691). The
 * gate shows the toast as it closes, before the billing page opens, so it
 * names where that page will open. Call it at click time: whether hosted
 * settings are openable can change between render and click. A `'browser'`
 * destination always names the web billing page.
 */
export function getAiCreditsConnectContext(
  options: { destination?: BillingDestination } = {},
): CloudConnectGateContext {
  const opensSettings =
    options.destination !== 'browser' && hostedSettingsOpenable();
  return {
    title: AI_CREDITS_PURCHASE_LABEL,
    subtitle: `Connect your ${brandText.appName} account to buy credits.`,
    toastMessage: opensSettings
      ? "You're connected. Opening Billing in Settings so you can buy credits."
      : "You're connected. Opening your billing page so you can buy credits.",
  };
}

/**
 * The one "Buy AI Credits" click handler, shared by every surface that offers
 * the purchase action (CAN-2413): the composer's `NoBillingSourceBanner` and
 * the in-transcript `CanopyProxyErrorNotice`.
 *
 * The gate hand-off is the part that must not be duplicated. Opening billing
 * directly dead-ends a guest credential — it has a device key, so it reads as
 * "connected", but it cannot buy credits: hosted Settings → Billing needs the
 * signed-in account, and `openBillingPage`'s web fallback mints a magic link
 * that has no non-guest credential to exchange. Routing through
 * `requestConnect` opens the shared sign-in modal first and auto-resumes the
 * hand-off once a real account exists. A second copy of that rationale in
 * another component is how one of the two surfaces silently loses it.
 *
 * `availability` only feeds the unauthenticated pricing-URL fallback, so
 * callers without a native availability read (the transcript notice) can pass
 * nothing and still get the in-app or signed-in billing page.
 */
export function useGetAiCreditsAction(
  scope?: AiCreditsScopeRequest,
): (availability?: NativeAiCreditsAvailability | null) => void {
  const requestConnect = useCloudConnectGateStore((s) => s.requestConnect);
  return useCallback(
    (availability: NativeAiCreditsAvailability | null = null): void => {
      requestConnect(getAiCreditsConnectContext(), async () => {
        const scopedAvailability =
          availability ??
          (scope ? await readSharedAiCreditsAvailability({ scope }) : null);
        return openBillingPage(scopedAvailability, scope);
      });
    },
    [requestConnect, scope],
  );
}

/** Billing-owner key for an availability read: `personal` or `org:<id>`. */
function billingOwnerKey(
  availability: NativeAiCreditsAvailability | null,
): string | null {
  return creditsBillingOwnerKey(availability);
}

/**
 * The billing owner of `scope` right now, or null when the read could not
 * establish one. Uses the shared episode read, so it agrees with every other
 * surface asking about the same work.
 *
 * A read that a new episode retracted asks the current episode once
 * (CAN-5030). Confirming an unlock announces the credits change while its
 * owner check is in flight; with no recent answer to join (a Check now after
 * the poll timed out), that check was retracted and the purchased model was
 * never applied. A retraction means "ask again", not "no owner". A second
 * retraction, or a failed read, still resolves null.
 * After a real account switch the retry answers for the new account; callers
 * compare the key with the owner they expect, so that still fails closed.
 */
export async function readBillingOwnerKey(
  scope?: AiCreditsScopeRequest,
): Promise<string | null> {
  const options = scope ? { scope } : {};
  const epoch = currentAccountEpoch;
  const availability = await readSharedAiCreditsAvailability(options);
  if (availability === null && epoch !== currentAccountEpoch) {
    return billingOwnerKey(await readSharedAiCreditsAvailability(options));
  }
  return billingOwnerKey(availability);
}

/**
 * Can this user fund the organization that owns the work? Only its OWNER can,
 * the same rule `resolveCreditsBillingTarget` applies to the credits hand-off.
 */
function canFundOrganization(organizationId: string): boolean {
  try {
    const { organizations } = useWorkspaceContextStore.getState().state;
    return (
      resolveCreditsBillingTarget(
        { kind: 'organization', organizationId },
        organizations,
      ).kind === 'organization'
    );
  } catch {
    return false;
  }
}

export interface UnlockModelsRequest {
  /**
   * Forwarded to checkout for attribution. Always `desktop`, whichever surface
   * started the recovery: it is also how checkout knows to offer the link back
   * to this app once the unlock is confirmed.
   */
  readonly source: 'desktop';
  /** The model the user asked for, when there is one to apply afterwards. */
  readonly modelId?: string;
  /** The chat it was asked for in. */
  readonly chatId?: string;
  /** Applies {@link modelId} once the unlock is confirmed. */
  readonly apply?: ModelUnlockIntentHandlers['apply'];
  readonly isStillWanted?: ModelUnlockIntentHandlers['isStillWanted'];
  /**
   * Reports the checkout attempt that follows a guest's sign-in, so the
   * surface that asked can narrate it. Called only after a `sign-in` outcome,
   * once a real account exists.
   */
  readonly onResumed?: (result: UnlockModelsResult) => void;
}

/**
 * What happened when the user asked to unlock.
 *
 * - `opened`: checkout is open in the browser. `requestId` is present when the
 *   desktop is following the purchase and will confirm it on its own.
 * - `sign-in`: a guest was sent to the shared sign-in gate first. Checkout
 *   opens after it, and only if the account still needs a purchase.
 * - `unlocked`: a fresh read says this account is already unlocked, so no
 *   checkout was opened.
 * - `contact-admin`: the work belongs to an organization this user cannot
 *   fund. Show {@link CONTACT_ORG_ADMIN_COPY}.
 * - `failed`: an authenticated opening could not be confirmed.
 */
export type UnlockModelsResult =
  | { readonly outcome: 'opened'; readonly requestId?: string }
  | { readonly outcome: 'sign-in' }
  | { readonly outcome: 'unlocked' }
  | { readonly outcome: 'contact-admin' }
  | { readonly outcome: 'failed' };

/**
 * Start reading the personal balance now; `current()` is the reading if it
 * has already finished, else `null` for good.
 */
function readStartingBalance(scope: AiCreditsScopeRequest | undefined): {
  readonly current: () => PersonalBalanceReading | null;
} {
  const load = aiCreditsConfirmationBalanceLoader();
  if (load === null || scope === undefined) return { current: () => null };
  let reading: PersonalBalanceReading | null = null;
  let closed = false;
  void readAiCreditsConfirmationBalance(load, scope).then((read): void => {
    if (!closed) reading = personalBalanceReading(read.response);
  });
  return {
    current: (): PersonalBalanceReading | null => {
      closed = true;
      return reading;
    },
  };
}

async function openUnlockCheckout(
  scope: AiCreditsScopeRequest | undefined,
  request: UnlockModelsRequest,
  {
    joinCurrentEpisode = false,
  }: { readonly joinCurrentEpisode?: boolean } = {},
): Promise<UnlockModelsResult> {
  const scopeKey = aiCreditsScopeKey(scope, readNavigationScopeKey());
  const epochBeforeAccount = currentAccountEpoch;
  let account;
  try {
    account = await window.api.loadCanopyCloudAccount();
  } catch {
    return { outcome: 'failed' };
  }
  const accountId = account?.account?.id;
  const accountKey = cloudAccountIdentityKey(account);
  if (
    !account?.hasApiKey ||
    isGuestAccount(account) ||
    !accountId ||
    !accountKey ||
    epochBeforeAccount !== currentAccountEpoch ||
    scopeKey !== aiCreditsScopeKey(scope, readNavigationScopeKey())
  ) {
    return { outcome: 'failed' };
  }
  // Fresh: the owner decides which billing page opens and whose purchase this
  // is, and a retained answer could name a pool the work no longer belongs to.
  // Starting a fresh shared read advances the episode synchronously. Fence
  // subsequent asynchronous reads against that episode, including overlaps.
  //
  // After a sign-in the gate's close has already opened a new episode, and the
  // recovery modal is reading in it. Joining that read gives both the same
  // current answer; forcing another would retract the modal's to `null`.
  const pendingAvailability = readSharedAiCreditsAvailability({
    fresh: !joinCurrentEpisode,
    ...(scope ? { scope } : {}),
  });
  // The balance before checkout opens, so the confirmation can name the
  // credits added (CAN-5160). Only a reading that finished before the open
  // counts: one that lands after could already include the purchase.
  const startingBalance = readStartingBalance(scope);
  const epoch = currentAccountEpoch;
  const isCurrent = (expectedEpoch: number): boolean =>
    expectedEpoch === currentAccountEpoch &&
    scopeKey === aiCreditsScopeKey(scope, readNavigationScopeKey());
  const sameAccount = async (): Promise<boolean> => {
    const current = await window.api.loadCanopyCloudAccount();
    return (
      current.hasApiKey &&
      !isGuestAccount(current) &&
      current.account?.id === accountId &&
      cloudAccountIdentityKey(current) === accountKey
    );
  };
  const availability = await pendingAvailability;
  if (!availability || availability.inconclusive === true || !isCurrent(epoch))
    return { outcome: 'failed' };
  const ownerOrganization = availability.ownerOrganization;
  if (ownerOrganization && !canFundOrganization(ownerOrganization.id))
    return { outcome: 'contact-admin' };
  const owner = billingOwnerKey(availability);
  const read = await refreshWorkModelLibraryAccess(scope);
  // A missing read cannot confirm access or track a purchase. A known
  // conflicting account/owner must not authorize even opening checkout.
  if (
    read !== null &&
    (read.accountKey !== accountKey || read.ownerKey !== owner)
  )
    return { outcome: 'failed' };
  try {
    if (!(await sameAccount()) || !isCurrent(epoch))
      return { outcome: 'failed' };
    if (read?.authoritative === true && read.access === 'unlocked')
      return { outcome: 'unlocked' };
    if (ownerOrganization && !canFundOrganization(ownerOrganization.id))
      return { outcome: 'contact-admin' };
  } catch {
    return { outcome: 'failed' };
  }
  const startingBalanceAtOpen = startingBalance.current();
  // The client's hand-off never rejects: a transport rejection, which may
  // follow a launch, is a failed open with no retry or fallback.
  const handoff = registeredCreditsHandoffClient();
  if (handoff === null) return { outcome: 'failed' };
  const result = settingsPaymentHandoffResultSchema.safeParse(
    await handoff.open({
      accountId,
      owner: ownerOrganization
        ? { kind: 'organization', organizationId: ownerOrganization.id }
        : { kind: 'personal' },
      intent: {
        kind: 'top-up',
        reason: 'unlock_models',
        source: request.source,
        ...(isBillingIntentIdentifier(request.modelId)
          ? { modelId: request.modelId }
          : {}),
        ...(isBillingIntentIdentifier(request.chatId)
          ? { chatId: request.chatId }
          : {}),
      },
    }),
  );
  if (!result.success || !result.data.ok) return { outcome: 'failed' };
  const requestId = result.data.requestId;
  // Browser success stands even when tracking cannot be established afterwards.
  if (!requestId || !read || read.access === undefined || !isCurrent(epoch))
    return { outcome: 'opened' };
  try {
    const pendingOwner = readSharedAiCreditsAvailability({
      fresh: true,
      ...(scope ? { scope } : {}),
    });
    const trackingEpoch = currentAccountEpoch;
    const freshOwner = billingOwnerKey(await pendingOwner);
    if (
      freshOwner === null ||
      freshOwner !== owner ||
      !(await sameAccount()) ||
      !isCurrent(trackingEpoch)
    )
      return { outcome: 'opened' };
    beginModelUnlockIntent(
      {
        requestId,
        accountId: accountKey,
        owner: freshOwner,
        chatId: request.chatId ?? null,
        ...(scope?.kind === 'work' ? { scope } : {}),
        modelId: request.modelId ?? null,
        startedAt: Date.now(),
        source: request.source,
        ...(startingBalanceAtOpen !== null
          ? { startingBalance: startingBalanceAtOpen }
          : {}),
      },
      {
        ...(request.apply ? { apply: request.apply } : {}),
        ...(request.isStillWanted
          ? { isStillWanted: request.isStillWanted }
          : {}),
        resolveOwner: () => readBillingOwnerKey(scope),
        refreshAccess: () => refreshWorkModelLibraryAccess(scope),
      },
    );
    return { outcome: 'opened', requestId };
  } catch {
    return { outcome: 'opened' };
  }
}

/**
 * The one "unlock advanced models" action (CAN-4028), beside
 * {@link useGetAiCreditsAction} and deliberately separate from it.
 *
 * That action's coverage check answers "can this account pay for a turn?",
 * and reports success whenever any spendable credit exists. Library access is
 * a different fact: the daily free credits are spendable and do not unlock
 * anything, so routing a locked model through the credits flow would tell a
 * non-payer their problem was solved.
 *
 * Opens the owner's billing page in the browser with the top-up already
 * open, and remembers the attempt so the desktop can confirm it. A guest goes
 * through the shared sign-in gate first, for the same reason
 * `useGetAiCreditsAction` does: a guest credential cannot buy anything.
 */
export async function unlockModels(
  scope: AiCreditsScopeRequest | undefined,
  request: UnlockModelsRequest,
): Promise<UnlockModelsResult> {
  // The owner is the one shown when the unlock was asked for; checkout below
  // re-reads the context, so a switch while this reads the account would
  // otherwise move the purchase to the new owner (CAN-6937).
  const scopeKey = aiCreditsScopeKey(scope, readNavigationScopeKey());
  let needsAccount = false;
  try {
    // A guest credential cannot buy anything, and neither can no credential
    // at all: both sign in first.
    const account = await window.api.loadCanopyCloudAccount();
    needsAccount = !isCanopyCloudConnected(account) || isGuestAccount(account);
  } catch {
    return { outcome: 'failed' };
  }
  if (scopeKey !== aiCreditsScopeKey(scope, readNavigationScopeKey()))
    return { outcome: 'failed' };
  if (!needsAccount) return openUnlockCheckout(scope, request);
  useCloudConnectGateStore.getState().requestConnect(
    {
      title: MODEL_LIBRARY_UNLOCK_COPY.title,
      subtitle: MODEL_LIBRARY_UNLOCK_COPY.guestBody,
    },
    (): void => {
      // Runs only after a real account exists. `openUnlockCheckout` re-reads
      // access first, so an account that already qualifies is never sent to
      // checkout.
      //
      // A surface that asked to hear the outcome narrates it itself; anyone
      // else gets a toast, so a failure after sign-in is never silent.
      const report = (result: UnlockModelsResult): void => {
        if (request.onResumed) {
          request.onResumed(result);
          return;
        }
        if (result.outcome === 'failed' || result.outcome === 'contact-admin') {
          useGitHubStore.getState().addToast(
            result.outcome === 'contact-admin'
              ? CONTACT_ORG_ADMIN_COPY
              : settingsActionErrorCopy(null, {
                  action: 'open this payment page',
                }),
            'error',
            undefined,
            { forceInApp: true },
          );
        }
      };
      void openUnlockCheckout(scope, request, {
        joinCurrentEpisode: true,
      }).then(report, (): void => report({ outcome: 'failed' }));
    },
  );
  return { outcome: 'sign-in' };
}

/** {@link unlockModels} bound to one owner scope, for components. */
export function useUnlockModelsAction(
  scope?: AiCreditsScopeRequest,
): (request: UnlockModelsRequest) => Promise<UnlockModelsResult> {
  return useCallback(
    (request: UnlockModelsRequest): Promise<UnlockModelsResult> =>
      unlockModels(scope, request),
    [scope],
  );
}
