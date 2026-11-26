import { useMemo, type JSX, type ReactNode } from 'react';
import {
  HarnessSetupHostProvider,
  THIS_COMPUTER_WORDING,
  type HarnessSetupHost,
} from '@canopy/ui-app/harness-setup';
import {
  reportClientAppError,
  resolveClientAppError,
} from '@canopy/desktop-instrumentation/client';
import { toAppError } from '@canopy/protocol/app-errors';
import { isProviderSignInLink } from '@canopy/desktop-shared/lib/provider-sign-in-links';
import { DesktopErrorBanner } from '@/components/shared/DesktopErrorBanner';
import { brand } from '@/lib/brand';
import {
  inlineFailure,
  inlineFailureWithMainSentence,
} from '@/lib/inline-app-error';
import { emitPreferencesUpdated } from '@/lib/preferences-events';
import { openSignInLink } from '@/lib/remote-control/open-sign-in-link';
import { AuthLoginModal } from './AuthLoginModal';

/**
 * The desktop's ports for the shared provider rows: its error banner and
 * failure wording, the preference broadcast after a connection changes, and
 * the terminal sign-in modal. Links open through the remote-aware opener, so
 * a desktop controlling another computer opens them on its own browser; a
 * Cursor link opens only on Cursor's sign-in host.
 */
function createDesktopHarnessSetupHost(): HarnessSetupHost {
  return {
    failure: (cause, fallback, mode) => {
      const appError = toAppError(resolveClientAppError(cause));
      if (!appError) return null;
      return mode === 'host-leads'
        ? inlineFailureWithMainSentence(appError, fallback)
        : inlineFailure(appError, fallback);
    },
    reportError: (cause) => {
      reportClientAppError(cause);
    },
    renderFailure: ({ source, testId, failure, onDismiss, flush }) => (
      <DesktopErrorBanner
        errorSource={source}
        {...(flush ? { className: '' } : {})}
        error={failure?.error}
        {...(failure?.details === undefined
          ? {}
          : { details: failure.details })}
        {...(onDismiss ? { onDismiss } : {})}
        {...(testId === undefined ? {} : { testId })}
      />
    ),
    openSignInLink: (url, link) => {
      if (link === 'cursor' && !isProviderSignInLink('cursor', url)) return;
      openSignInLink(url);
    },
    afterConnectionChange: async () => {
      emitPreferencesUpdated(await window.api.loadPreferences());
    },
    renderSignIn: ({ provider, onClose }) => (
      <AuthLoginModal provider={provider} onClose={onClose} />
    ),
    appName: brand.displayName,
    // Settings always describe the computer the window drives as this one.
    wording: THIS_COMPUTER_WORDING,
    // The platform of the computer the window shows, which in a window that
    // controls another computer is that computer's.
    computerPlatform: window.platform,
  };
}

/** Puts the desktop's ports above shared provider rows. */
export function DesktopHarnessSetupHost({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  const host = useMemo(createDesktopHarnessSetupHost, []);
  return (
    <HarnessSetupHostProvider host={host}>{children}</HarnessSetupHostProvider>
  );
}
