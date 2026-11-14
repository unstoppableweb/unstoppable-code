import { type JSX, useCallback, useState } from 'react';
import type { LaunchAtLoginStatus } from '@canopy/desktop-shared/types';
import { toAppError } from '@canopy/protocol/app-errors';
import { resolveClientAppError } from '@canopy/desktop-instrumentation/client';
import {
  Notice,
  NoticeButton,
  ToggleSwitch,
} from '@canopy/ui-shared/components';
import { DesktopErrorBanner } from '@/components/shared/DesktopErrorBanner';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { brandText } from '@/lib/brand';
import { inlineFailure, type InlineFailure } from '@/lib/inline-app-error';
import { resolvePlatformText } from '@/lib/platform-text';
import { uiText } from '@/lib/ui-text';
import {
  useLaunchAtLoginStatus,
  useLaunchAtLoginStore,
} from '@/stores/launchAtLoginStore';
import { SettingsRow } from './SettingsLayout';

const TOGGLE_ID = 'settings-launch-at-login-toggle';

function failureCopy(requested: boolean): string {
  return requested
    ? 'Could not turn this on. Try again.'
    : 'Could not turn this off. Try again.';
}

function rendererPlatform(): LaunchAtLoginStatus['platform'] {
  const platform = typeof window !== 'undefined' ? window.platform : undefined;
  return platform === 'darwin' || platform === 'win32' ? platform : 'linux';
}

/**
 * Settings → General → Startup (CAN-3449): whether the OS opens the app when
 * the user signs in. There is no saved preference; the toggle shows the OS's
 * own record, re-read on mount and whenever the window regains focus, so a
 * change made in System Settings or Task Manager is reflected here. The main
 * process writes to the OS and answers with its read-back.
 */
export function LaunchAtLoginSection(): JSX.Element | null {
  const { status, hydrated, busy, error } = useLaunchAtLoginStatus();
  // The store records that a round trip failed; the reason behind Copy
  // details comes from the rejection this toggle saw.
  const [failure, setFailure] = useState<InlineFailure | null>(null);
  // The status names the platform the OS answered for (the E2E fake can
  // impersonate Windows); before it loads, the renderer's own platform keeps
  // the first paint from showing the wrong label.
  const platform = status?.platform ?? rendererPlatform();
  const supported = status?.supported ?? false;
  const pendingApproval = status?.pendingApproval ?? false;
  const checked = (status?.enabled ?? false) || pendingApproval;

  useCurrentUiStateReporter('settings.launchAtLogin', {
    loaded: hydrated,
    supported,
    unsupportedReason: status?.unsupportedReason ?? null,
    enabled: status?.enabled ?? false,
    pendingApproval,
    busy,
    error: error?.reason ?? null,
  });

  const handleChange = useCallback((next: boolean): void => {
    // The store records a failed round trip for the error line below.
    setFailure(null);
    useLaunchAtLoginStore
      .getState()
      .setEnabled(next)
      .catch((caught: unknown) => {
        const appError = toAppError(resolveClientAppError(caught));
        if (appError) setFailure(inlineFailure(appError, failureCopy(next)));
      });
  }, []);

  const openSystemSettings = useCallback((): void => {
    void useLaunchAtLoginStore.getState().openSystemSettings();
  }, []);

  if (platform === 'linux') return null;

  const label = resolvePlatformText(uiText.launchAtLogin.toggleLabel, platform);

  return (
    <SettingsRow
      label={label}
      htmlFor={TOGGLE_ID}
      dataTestId="settings-canopy-launch-at-login"
      description={
        status?.unsupportedReason === 'development-build' ? (
          <span data-testid="launch-at-login-unavailable">
            Available in the installed app.
          </span>
        ) : undefined
      }
      control={
        <ToggleSwitch
          id={TOGGLE_ID}
          checked={checked}
          disabled={!hydrated || busy || !supported}
          label={label}
          onChange={handleChange}
          dataTestId="launch-at-login-toggle"
        />
      }
    >
      {pendingApproval && (
        <Notice
          intent="attention"
          data-testid="launch-at-login-needs-approval"
          actions={
            <NoticeButton
              onClick={openSystemSettings}
              data-testid="launch-at-login-open-system-settings"
            >
              Open System Settings
            </NoticeButton>
          }
        >
          Allow {brandText.appName} in System Settings to finish turning this
          on.
        </Notice>
      )}
      <DesktopErrorBanner
        errorSource="launch-at-login-error"
        className=""
        error={
          error === null
            ? null
            : error.reason === 'failed' && failure !== null
              ? failure.error
              : failureCopy(error.requested)
        }
        {...(error?.reason === 'failed' && failure?.details !== undefined
          ? { details: failure.details }
          : {})}
        testId="launch-at-login-error"
        secondaryAction={
          platform === 'win32' ? (
            // The usual cause on Windows is the Startup apps switch in
            // Windows Settings or Task Manager, which only the user can
            // flip back.
            <NoticeButton
              onClick={openSystemSettings}
              data-testid="launch-at-login-open-startup-apps"
            >
              Open Startup apps
            </NoticeButton>
          ) : undefined
        }
      />
    </SettingsRow>
  );
}
