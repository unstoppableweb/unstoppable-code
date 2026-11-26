import type { JSX, ReactNode } from 'react';
import { ModelProviderIcon } from '../../icons/ModelProviderIcon';
import { Button } from '../../primitives/Button';
import { ProviderRowLabel, ProviderStatusDot } from '../ProviderRowLabel';
import { SettingsRowsRow } from './SettingsRows';

// Google keeps one sign-in per computer, so a sign-in here (directly, or after
// Reconnect finds no models) can change the account the user's own Antigravity
// uses. Both states that lead to sign-in say so first.
const SHARED_SIGN_IN =
  'Signing in here can also change the account Antigravity uses on this computer.';

/** Host-neutral connection row; the host owns authentication and discovery. */
export function GoogleSubscriptionRow({
  connected,
  disconnected,
  appName,
  busy,
  onSignIn,
  onRefresh,
  onDisconnect,
  onReconnect,
  runtime,
  error,
}: {
  readonly connected: boolean;
  readonly disconnected: boolean;
  readonly appName: string;
  readonly busy: boolean;
  readonly onSignIn: () => void;
  readonly onRefresh: () => void;
  /**
   * Withdraws this app's access. Absent where the host can't change the
   * setting (a browser controlling the computer): no Disconnect button.
   */
  readonly onDisconnect?: () => void;
  /** Absent where the host can't change the setting: Reconnect is disabled. */
  readonly onReconnect?: () => void;
  /** The host's Antigravity CLI status and install controls, if any. */
  readonly runtime?: ReactNode;
  readonly error?: ReactNode;
}): JSX.Element {
  return (
    <SettingsRowsRow
      label={
        <ProviderRowLabel
          icon={<ModelProviderIcon provider="antigravity" size="md" />}
          name="Antigravity"
          status={
            <ProviderStatusDot tone={connected ? 'connected' : 'signed-out'} />
          }
        />
      }
      description={
        disconnected
          ? `Disconnected from ${appName}. Your Google sign-in is unchanged. ${SHARED_SIGN_IN}`
          : connected
            ? // Discovery confirms account access, not a paid subscription tier.
              'Antigravity connected'
            : // Version-neutral: the host's install control names the version it installs.
              `Install Antigravity CLI from this card if it is not installed, then sign in with your personal Google account. ${SHARED_SIGN_IN}`
      }
      dataTestId="google-subscription-connection"
      control={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || (disconnected && !onReconnect)}
            onClick={
              disconnected ? onReconnect : connected ? onRefresh : onSignIn
            }
          >
            {busy
              ? 'Updating…'
              : disconnected
                ? 'Reconnect'
                : connected
                  ? 'Refresh models'
                  : 'Connect account'}
          </Button>
          {connected && !disconnected && onDisconnect ? (
            // This withdraws app access only, never the shared native login.
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={onDisconnect}
            >
              Disconnect Antigravity
            </Button>
          ) : null}
        </div>
      }
    >
      {runtime}
      {error}
    </SettingsRowsRow>
  );
}
