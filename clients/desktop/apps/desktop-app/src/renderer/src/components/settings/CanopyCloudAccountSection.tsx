import { SecureStorageNotice } from '@/components/auth/SecureStorageNotice';
import {
  type JSX,
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useRef,
} from 'react';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import { BrandLogo } from '@/components/BrandLogo';
import {
  Button,
  ProviderStatusDot,
  StatusLabel,
} from '@canopy/ui-shared/components';
import { CanopyCloudApiKeyField } from '@/components/auth/CanopyCloudApiKeyField';
import { CloudAccountRecoveryNotice } from '@/components/auth/CloudAccountRecoveryNotice';
import {
  useCanopyCloudAuth,
  type CanopyCloudConnectSuccess,
} from '@/components/auth/useCanopyCloudAuth';
import {
  didGuestMergeFail,
  showGuestMergeFailureToast,
} from '@/components/auth/guestMergeFailure';
import { SettingsRow } from './SettingsLayout';

export interface CanopyCloudAccountSectionProps {
  /**
   * Notifies the host whenever the authoritative connection state changes.
   * The first notification is sent after the initial account load resolves,
   * so hosts can keep controls safely disabled without showing disconnected
   * copy during the loading state.
   * The connection signal is mode-independent and remains true when a saved
   * OAuth credential exists while the user is viewing the API-key editor.
   */
  onConnectedChange?: (connected: boolean) => void;
}

/**
 * The cloud account as one settings row, for a `SettingsGroup` on Settings →
 * Accounts and Privacy: mark, name, and status dot as the label, the account
 * state as the hint, and every action as a capsule in the row's control: the
 * sign-in actions, and the switch between browser sign-in and an API key.
 * The API-key field sits under the row while that mode is active.
 *
 * The mode switch is a quiet (ghost) capsule, not a peer of the sign-in
 * action: on a surface whose whole job is one decision, presenting the manual
 * fallback with equal weight split the user's attention between the method
 * and the action.
 *
 * The blocking sign-in splash and the cloud-connect modal do not render this
 * row: they share `components/auth/CloudAuthPanel`, which is built for a
 * single conversion decision rather than for sitting among account rows.
 */
export function CanopyCloudAccountSection({
  onConnectedChange,
}: CanopyCloudAccountSectionProps = {}): JSX.Element {
  const handleConnectSuccess = useCallback(
    (result: CanopyCloudConnectSuccess): void => {
      if (didGuestMergeFail(result)) showGuestMergeFailureToast();
    },
    [],
  );
  const auth = useCanopyCloudAuth({
    onConnectedChange,
    onConnectSuccess: handleConnectSuccess,
  });
  const {
    cloudName,
    accountInfo,
    loading,
    mode,
    setMode,
    apiKeyInput,
    handleApiKeyInputChange,
    apiKeyVisible,
    setApiKeyVisible,
    validating,
    oauthPending,
    disconnecting,
    accountUnreadable,
    repairing,
    errorMessage,
    successMessage,
    storageAvailable,
    apiKeyConnected,
    oauthConnected,
    busy,
    statusGreen,
  } = auth;
  const oauthLoginRef = useRef<HTMLButtonElement | null>(null);
  const oauthCancelRef = useRef<HTMLButtonElement | null>(null);
  const previousOauthPendingRef = useRef(oauthPending);
  const previousUnreadableRef = useRef(accountUnreadable);
  const guestAccount = isGuestAccount(auth.account);

  // After a successful reset the tile swaps from the recovery notice back to
  // the OAuth pane; put focus on the login CTA the user is now expected to
  // press instead of leaving it on the removed button's former position.
  useLayoutEffect(() => {
    const wasUnreadable = previousUnreadableRef.current;
    previousUnreadableRef.current = accountUnreadable;
    if (!wasUnreadable || accountUnreadable) return;
    const login = oauthLoginRef.current;
    if (
      login &&
      login.ownerDocument.activeElement === login.ownerDocument.body
    ) {
      login.focus();
    }
  }, [accountUnreadable]);

  useLayoutEffect(() => {
    const wasPending = previousOauthPendingRef.current;
    previousOauthPendingRef.current = oauthPending;
    if (oauthPending) {
      oauthCancelRef.current?.focus();
    } else if (wasPending) {
      const login = oauthLoginRef.current;
      if (
        login &&
        login.ownerDocument.activeElement === login.ownerDocument.body
      ) {
        login.focus();
      }
    }
  }, [oauthPending]);

  // Session replay blocks the account's name and email, not the copy around
  // them.
  const signedInAs: ReactNode = accountInfo ? (
    <>
      Signed in as{' '}
      <span className={POSTHOG_REPLAY_BLOCK_CLASS}>{accountInfo.name}</span> (
      <span className={POSTHOG_REPLAY_BLOCK_CLASS}>{accountInfo.email}</span>)
    </>
  ) : null;

  // The row's one status line: what the account is doing right now.
  let statusLine: ReactNode = null;
  if (loading) {
    statusLine = <>Checking {cloudName} account&hellip;</>;
  } else if (!accountUnreadable && mode === 'oauth') {
    let oauthStatus: ReactNode;
    if (oauthPending) {
      oauthStatus = <>Waiting for browser sign-in&hellip;</>;
    } else if (disconnecting) {
      oauthStatus = <>Disconnecting&hellip;</>;
    } else if (oauthConnected && accountInfo && !errorMessage) {
      oauthStatus = signedInAs;
    } else if (errorMessage) {
      oauthStatus = <StatusLabel>{errorMessage}</StatusLabel>;
    } else {
      oauthStatus = `Sign in through your browser to connect your ${cloudName} account.`;
    }
    statusLine = (
      <span data-testid="settings-account-canopy-cloud-oauth">
        {oauthStatus}
      </span>
    );
  } else if (!accountUnreadable && mode === 'api_key') {
    let apiKeyStatus: ReactNode;
    if (validating) {
      apiKeyStatus = <>Validating {cloudName} API key&hellip;</>;
    } else if (errorMessage) {
      apiKeyStatus = <StatusLabel>{errorMessage}</StatusLabel>;
    } else if (apiKeyConnected && accountInfo) {
      apiKeyStatus = signedInAs;
    } else {
      apiKeyStatus = `Paste a ${cloudName} API key to connect your account.`;
    }
    statusLine = (
      <span data-testid="settings-account-canopy-cloud-api-key">
        {apiKeyStatus}
      </span>
    );
  }

  const oauthActive = !loading && !accountUnreadable && mode === 'oauth';
  const apiKeyActive = !loading && !accountUnreadable && mode === 'api_key';
  const showSuccess =
    Boolean(successMessage) &&
    !errorMessage &&
    (oauthActive ? !oauthPending : apiKeyActive && !validating);

  return (
    <>
      <SettingsRow
        dataTestId="settings-account-canopy-cloud-section"
        label={
          <span className="inline-flex items-center gap-2">
            <BrandLogo size={16} className="shrink-0" aria-hidden />
            {cloudName}
            {!loading && mode && (
              <ProviderStatusDot
                data-testid="settings-account-canopy-cloud-status-dot"
                tone={statusGreen ? 'connected' : 'failed'}
              />
            )}
          </span>
        }
        description={statusLine}
        control={
          oauthActive ? (
            <>
              {/* A manual key overwrites the guest credential without a
                  guest-link ticket, so it cannot preserve guest work. Keep the
                  fallback hidden until that destructive transition has
                  confirmation and recovery semantics. */}
              {!guestAccount && (
                <Button
                  size="compact"
                  variant="secondary"
                  onClick={(): void => setMode('api_key')}
                  disabled={busy}
                  data-testid="settings-account-canopy-cloud-mode-api-key"
                >
                  Use an API key instead
                </Button>
              )}
              {oauthPending && (
                <Button
                  size="compact"
                  ref={oauthCancelRef}
                  variant="secondary"
                  onClick={(): void => void auth.handleCancelOAuthLogin()}
                  data-testid="settings-account-canopy-cloud-oauth-cancel"
                >
                  Cancel
                </Button>
              )}
              {/* Disconnect is the quieter account action beside the main
                  "Change account". */}
              {oauthConnected && !oauthPending && (
                <Button
                  size="compact"
                  variant="secondary"
                  onClick={(): void => void auth.handleDisconnect()}
                  disabled={busy}
                  data-testid="settings-account-canopy-cloud-disconnect"
                >
                  Disconnect
                </Button>
              )}
              <Button
                size="compact"
                ref={oauthLoginRef}
                variant="secondary"
                onClick={(): void => void auth.handleStartOAuthLogin()}
                disabled={busy || !storageAvailable}
                data-testid="settings-account-canopy-cloud-oauth-login"
              >
                {oauthPending
                  ? 'Waiting for browser…'
                  : oauthConnected
                    ? 'Change account'
                    : 'Sign in'}
              </Button>
            </>
          ) : apiKeyActive ? (
            // API-key mode connects through its field under the row.
            <Button
              size="compact"
              variant="secondary"
              onClick={(): void => setMode('oauth')}
              disabled={busy}
              data-testid="settings-account-canopy-cloud-mode-oauth"
            >
              Back to sign in
            </Button>
          ) : null
        }
      >
        <SecureStorageNotice
          failure={auth.secureStorageFailure}
          retrying={auth.storageRetrying}
          onRetry={(): void => void auth.retrySecureStorage()}
        />

        {/* Recovery replaces both sign-in panes. Saving a new credential next
            to an entry this build cannot decrypt would leave the user in the
            same state, so the reset has to come first. */}
        {!loading && accountUnreadable && (
          <div data-testid="settings-account-canopy-cloud-recovery">
            <CloudAccountRecoveryNotice
              resetting={repairing}
              errorMessage={errorMessage}
              onReset={auth.resetUnreadableAccount}
            />
          </div>
        )}

        {showSuccess && (
          <p className="text-xs fg-secondary">{successMessage}</p>
        )}

        {apiKeyActive && (
          <CanopyCloudApiKeyField
            value={apiKeyInput}
            onChange={handleApiKeyInputChange}
            visible={apiKeyVisible}
            onToggleVisible={(): void => setApiKeyVisible((prev) => !prev)}
            disabled={loading || !storageAvailable || busy}
          />
        )}
      </SettingsRow>
    </>
  );
}
