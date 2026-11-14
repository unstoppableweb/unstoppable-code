'use client';

import type { JSX, ReactNode } from 'react';
import type { SettingsErrorCode } from '@canopy/protocol/settings';
import { Button } from '@canopy/ui-shared/components/Button';
import { ErrorBanner } from '@canopy/ui-shared/components/StatusBlocks';
import { TRY_AGAIN_LABEL } from '@canopy/ui-shared/components/useRetry';
import { SettingsPageColumn } from '../layout/SettingsPageColumn';

/**
 * Host states around hosted settings content: signed out, expired, offline,
 * access lost and unsupported server. Pages keep their own, more precise
 * errors; these cover the frame a host draws before a page renders. While a
 * route loads, hosts show its page skeleton (`HostedSettingsRouteLoading`).
 *
 * Each state sits in the shared settings column, so its text starts where the
 * page's header will. Inside the account frame (or a page) the column adds no
 * second inset.
 */

export const HOSTED_SETTINGS_COPY = {
  signedOut: 'Sign in to manage your account and organizations.',
  expired: 'Your session ended. Sign in again to continue.',
  offline: "Couldn't load these settings. Check your connection.",
  accessLost: 'You no longer have access to this organization.',
  unsupported: 'These settings need a newer server.',
  uncertain: "Couldn't confirm the change. Check again before trying again.",
  signIn: 'Sign in',
  retry: 'Try again',
  organizations: 'Organizations',
  openOnWeb: 'Open on web',
} as const;

function StateFrame({
  testId,
  message,
  children,
}: {
  testId: string;
  message: ReactNode;
  children?: ReactNode;
}): JSX.Element {
  return (
    <SettingsPageColumn>
      <div
        className="flex flex-col items-start gap-3"
        data-testid={testId}
        role="status"
      >
        <p className="text-s fg-secondary">{message}</p>
        {children}
      </div>
    </SettingsPageColumn>
  );
}

export interface HostedSettingsErrorStateProps {
  readonly code: SettingsErrorCode | 'signed_out';
  readonly onRetry?: () => void;
  /**
   * A retry of a failed load is running: the failure stays and its Try again
   * capsule spins in place until the retry settles.
   */
  readonly retrying?: boolean;
  readonly onSignIn?: () => void;
  readonly onOpenOrganizations?: () => void;
  readonly onOpenOnWeb?: () => void;
}

/** The recovery state for a failure code, with its single recovery action. */
export function HostedSettingsErrorState({
  code,
  onRetry,
  retrying = false,
  onSignIn,
  onOpenOrganizations,
  onOpenOnWeb,
}: HostedSettingsErrorStateProps): JSX.Element {
  switch (code) {
    case 'signed_out':
    case 'unauthenticated':
      return (
        <StateFrame
          testId="hosted-settings-signed-out"
          message={HOSTED_SETTINGS_COPY.signedOut}
        >
          {onSignIn ? (
            <Button variant="secondary" size="compact" onClick={onSignIn}>
              {HOSTED_SETTINGS_COPY.signIn}
            </Button>
          ) : null}
        </StateFrame>
      );
    case 'expired':
      return (
        <StateFrame
          testId="hosted-settings-expired"
          message={HOSTED_SETTINGS_COPY.expired}
        >
          {onSignIn ? (
            <Button variant="secondary" size="compact" onClick={onSignIn}>
              {HOSTED_SETTINGS_COPY.signIn}
            </Button>
          ) : null}
        </StateFrame>
      );
    case 'forbidden':
    case 'not_found':
      return (
        <StateFrame
          testId="hosted-settings-access-lost"
          message={HOSTED_SETTINGS_COPY.accessLost}
        >
          {onOpenOrganizations ? (
            <Button
              variant="secondary"
              size="compact"
              onClick={onOpenOrganizations}
            >
              {HOSTED_SETTINGS_COPY.organizations}
            </Button>
          ) : null}
        </StateFrame>
      );
    case 'unsupported_server':
      return (
        <StateFrame
          testId="hosted-settings-unsupported"
          message={HOSTED_SETTINGS_COPY.unsupported}
        >
          {onOpenOnWeb ? (
            <Button variant="secondary" size="compact" onClick={onOpenOnWeb}>
              {HOSTED_SETTINGS_COPY.openOnWeb}
            </Button>
          ) : null}
        </StateFrame>
      );
    case 'uncertain':
      return (
        <StateFrame
          testId="hosted-settings-uncertain"
          message={HOSTED_SETTINGS_COPY.uncertain}
        >
          {onRetry ? (
            <Button variant="secondary" size="compact" onClick={onRetry}>
              {HOSTED_SETTINGS_COPY.retry}
            </Button>
          ) : null}
        </StateFrame>
      );
    case 'offline':
    case 'invalid_response':
    case 'failed':
      // The page's own content failed, under a header that stays: one
      // notice with Try again, as every settings section's load failure.
      return (
        <SettingsPageColumn>
          <div data-testid="hosted-settings-failed">
            <ErrorBanner
              errorSource="hosted-settings-load"
              displayErrorCode={
                code === 'offline' ? 'external.offline' : undefined
              }
              className=""
              error={HOSTED_SETTINGS_COPY.offline}
              onRetry={onRetry}
              retryLabel={TRY_AGAIN_LABEL}
              retrying={retrying}
            />
          </div>
        </SettingsPageColumn>
      );
  }
}
