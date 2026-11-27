import { useEffect, useState, type JSX } from 'react';
import {
  aiCreditsHandoffSentence,
  AI_CREDITS_PURCHASE_LABEL,
  AI_CREDITS_REOPEN_BILLING_LABEL,
  Button,
} from '@canopy/ui-shared/components';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import {
  FIRST_RUN_ACCOUNT_CHANGE_LABEL,
  FIRST_RUN_ACCOUNT_CONNECT_LABEL,
  FIRST_RUN_ACCOUNT_WAITING_LABEL,
  FirstRunAccountRow,
  type FirstRunAccountRowState,
} from '@canopy/ui-app/onboarding';
import { BrandLogo } from '@/components/BrandLogo';
import {
  didGuestMergeFail,
  showGuestMergeFailureToast,
} from '@/components/auth/guestMergeFailure';
import {
  useCanopyCloudAuth,
  type CanopyCloudConnectSuccess,
  type UseCanopyCloudAuthResult,
} from '@/components/auth/useCanopyCloudAuth';
import {
  GetAiCreditsCta,
  type GetAiCreditsHandoffState,
} from '@/components/chat/GetAiCreditsCta';
import { aiCreditsHandoffCopy } from '@/components/chat/aiCreditsHandoffCopy';
import {
  invalidateAiCreditsAvailabilityCache,
  useAiCreditsAvailability,
} from '@/hooks/useAiCreditsAvailability';
import { brandText } from '@/lib/brand';
import { announceCanopyCloudAccountChanged } from '@/lib/canopyCloudAccountChange';
import { useCloudConnectGateStore } from '@/stores/cloudConnectGateStore';

/** Sized like the provider rows' Connect buttons beside it. */
function handleConnectSuccess(result: CanopyCloudConnectSuccess): void {
  if (didGuestMergeFail(result)) showGuestMergeFailureToast();
}

/**
 * true: a real account; false: a guest or no account; null: still reading.
 * The hook reads as not connected while it holds an error, but a failed
 * Change account leaves the real account it had signed in.
 */
function accountSignedIn(auth: UseCanopyCloudAuthResult): boolean | null {
  if (auth.loading) return null;
  if (auth.connected) return true;
  return (
    auth.errorMessage !== null &&
    auth.accountInfo !== undefined &&
    auth.account !== null &&
    !isGuestAccount(auth.account)
  );
}

/** Signs in again in the browser, as on the Claude and Codex rows. */
function ChangeAccountButton({
  auth,
}: {
  readonly auth: UseCanopyCloudAuthResult;
}): JSX.Element {
  return (
    <Button
      size="compact"
      onClick={(): void => void auth.handleStartOAuthLogin()}
      disabled={auth.busy || auth.oauthPending || !auth.storageAvailable}
      data-testid="first-run-account-action"
    >
      {auth.oauthPending
        ? FIRST_RUN_ACCOUNT_WAITING_LABEL
        : FIRST_RUN_ACCOUNT_CHANGE_LABEL}
    </Button>
  );
}

/**
 * The first-run account row with the desktop's sign-in and purchase
 * (CAN-4762, CAN-4765). A guest or signed-out user gets Connect, which only
 * signs in through the shared cloud connect gate and never opens billing.
 * Once signed in, the row says who is signed in and Buy AI Credits is the
 * second step: the shared control skips billing when the account already has
 * credits, and otherwise opens billing in the browser, keeping the wait and
 * Check again in this row. With credits, Change account signs in again in
 * the browser, as on the Claude and Codex rows.
 */
export function FirstRunAccountRowHost({
  onAction,
}: {
  /**
   * The user picked this row's way to pay: `connect` (sign in) or `buy`
   * (a purchase hand-off started). For the billing setup gate's analytics.
   */
  readonly onAction?: (action: 'connect' | 'buy') => void;
} = {}): JSX.Element {
  // The one account source, so the dot, the email and the action agree. The
  // page has no key field, so nothing is saved on unmount.
  const auth = useCanopyCloudAuth({
    autoSaveApiKey: false,
    onConnectSuccess: handleConnectSuccess,
  });
  const signedIn = accountSignedIn(auth);
  const email = auth.accountInfo?.email;
  const credits = useAiCreditsAvailability();
  const accountId = auth.accountInfo?.id ?? null;
  // The credits hook marks its last answer stale both on a routine refresh
  // and after an account change. Only the second can belong to another
  // account, so a stale answer counts only for the account it settled under.
  const [creditsAccountId, setCreditsAccountId] = useState<
    string | null | undefined
  >(undefined);
  if (
    !credits.loading &&
    credits.stale !== true &&
    creditsAccountId !== accountId
  ) {
    setCreditsAccountId(accountId);
  }
  const creditsSettling =
    credits.loading ||
    (credits.stale === true && creditsAccountId !== accountId);
  const creditsReady = credits.eligible && !creditsSettling;
  // The hook keeps its error until its own next action, so show it only under
  // the account it was raised for: a sign-in or sign-out elsewhere dismisses
  // it, and switching back does not bring it back.
  const [errorOwner, setErrorOwner] = useState<{
    readonly message: string;
    readonly accountId: string | null;
    readonly dismissed: boolean;
  } | null>(null);
  if ((errorOwner?.message ?? null) !== auth.errorMessage) {
    setErrorOwner(
      auth.errorMessage === null
        ? null
        : { message: auth.errorMessage, accountId, dismissed: false },
    );
  } else if (
    errorOwner !== null &&
    !errorOwner.dismissed &&
    errorOwner.accountId !== accountId
  ) {
    setErrorOwner({ ...errorOwner, dismissed: true });
  }
  const attention =
    errorOwner !== null &&
    !errorOwner.dismissed &&
    errorOwner.message === auth.errorMessage &&
    errorOwner.accountId === accountId
      ? errorOwner.message
      : null;
  const [handoff, setHandoff] = useState<GetAiCreditsHandoffState | null>(null);
  // The purchase control unmounts on sign-out without reporting its hand-off
  // as closed, so drop it here; it must not come back on the next sign-in.
  // The derived value below hides it on the render before this runs.
  useEffect(() => {
    if (signedIn !== true) setHandoff(null);
  }, [signedIn]);
  const activeHandoff = signedIn === true ? handoff : null;

  const state: FirstRunAccountRowState =
    activeHandoff !== null
      ? {
          kind: 'handoff',
          message: aiCreditsHandoffSentence(
            aiCreditsHandoffCopy(activeHandoff.feedback),
          ),
        }
      : creditsReady
        ? { kind: 'ready' }
        : { kind: 'offer' };

  let action: JSX.Element | null;
  if (signedIn !== true) {
    action = (
      <Button
        size="compact"
        // Inert until the account read settles.
        disabled={signedIn === null}
        // No connect context: the modal's default copy describes a plain
        // sign-in. The AI Credits context would promise billing. The gate
        // proceeds without a modal when its own read finds a real account
        // this row's read missed, so re-read rather than do nothing; the gate
        // confirmed that account, so it is not an identity change.
        onClick={(): void => {
          onAction?.('connect');
          useCloudConnectGateStore
            .getState()
            .requestConnect({}, () =>
              announceCanopyCloudAccountChanged('same-account-refresh'),
            );
        }}
        data-testid="first-run-account-action"
      >
        {FIRST_RUN_ACCOUNT_CONNECT_LABEL}
      </Button>
    );
  } else if (activeHandoff === null && creditsReady) {
    action = <ChangeAccountButton auth={auth} />;
  } else if (activeHandoff === null && creditsSettling) {
    // Nothing until the balance read settles, so a ready account never
    // flashes Buy AI Credits before Change account.
    action = null;
  } else {
    action = (
      <span className="flex items-center gap-2">
        {activeHandoff !== null &&
          activeHandoff.feedback !== 'check-failed' && (
            <Button
              size="compact"
              onClick={(): void => activeHandoff.onReopenBilling?.()}
              disabled={
                activeHandoff.onReopenBilling === undefined ||
                activeHandoff.reopenPending ||
                activeHandoff.reopenDisabled
              }
              data-testid="first-run-account-reopen-billing"
            >
              {AI_CREDITS_REOPEN_BILLING_LABEL}
            </Button>
          )}
        <GetAiCreditsCta
          label={AI_CREDITS_PURCHASE_LABEL}
          // A read that found credits (after Check again) re-reads
          // availability, so the row turns ready.
          onCovered={(): void => invalidateAiCreditsAvailabilityCache()}
          // Inert until the balance read settles, so the decision never
          // comes from a guess.
          disabled={credits.loading}
          // The row is one line: the CTA shows only Check again and the row's
          // description says what is happening.
          handoffLayout="compact"
          // Always the browser, so the wait and Check again stay on this page
          // instead of leaving it for Settings.
          billingDestination="browser"
          onHandoffChange={(next): void => {
            // A purchase hand-off starting is the Buy click.
            if (next !== null && handoff === null) onAction?.('buy');
            setHandoff(next);
          }}
          dataTestId="first-run-account-action"
        />
      </span>
    );
  }

  return (
    <FirstRunAccountRow
      state={state}
      logo={<BrandLogo size={16} aria-hidden />}
      appName={brandText.appName}
      signedIn={signedIn}
      account={
        email ? (
          <span
            className={POSTHOG_REPLAY_BLOCK_CLASS}
            data-testid="first-run-account-identity"
          >
            {email}
          </span>
        ) : undefined
      }
      action={action}
      attention={attention}
    />
  );
}
