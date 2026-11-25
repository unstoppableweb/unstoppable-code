import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import type { CanopyApi } from '@canopy/desktop-shared/types';
import { toAppError } from '@canopy/protocol/app-errors';
import { resolveClientAppError } from '@canopy/desktop-instrumentation/client';
import { brandText } from '@/lib/brand';
import { isIpcCancellation } from '@/lib/errors';
import { inlineFailure } from '@/lib/inline-app-error';
import {
  beginHostedSettingsAction,
  currentHostedSettingsFailureScope,
  raiseHostedSettingsFailure,
} from './hosted-settings-host-failure';

let signingIn = false;

/**
 * Sign in from a hosted settings recovery state, through the same OAuth
 * entry point as the account menu's Sign in. Success announces the account
 * change, which reloads hosted settings for the signed-in account. A failure
 * shows on the page the sign-in started from, unless the person has moved on.
 * A second call while one is in flight does nothing.
 */
export function startHostedSettingsSignIn(): void {
  if (signingIn) return;
  const api: Partial<CanopyApi> | undefined = window.api;
  const start = api?.startCanopyCloudOAuthLogin;
  if (typeof start !== 'function') return;
  signingIn = true;
  const attempt = beginHostedSettingsAction();
  // Signing in changes the account, so the failure belongs to the page only.
  const scope = currentHostedSettingsFailureScope(null);
  void start()
    .then((result) => {
      const authenticated =
        result.status.authenticated &&
        result.status.account != null &&
        result.status.missingCapabilities.length === 0;
      if (authenticated) {
        window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
      } else {
        raiseHostedSettingsFailure(attempt, scope, {
          error: 'Couldn’t complete sign-in. Try again.',
        });
      }
    })
    .catch((error: unknown) => {
      // A cancelled or replaced sign-in shows nothing (CAN-6895).
      if (isIpcCancellation(error)) return;
      const appError = toAppError(resolveClientAppError(error));
      if (appError)
        raiseHostedSettingsFailure(
          attempt,
          scope,
          inlineFailure(
            appError,
            `Couldn’t start sign-in. Check your ${brandText.serverName} configuration.`,
          ),
        );
    })
    .finally(() => {
      signingIn = false;
    });
}
