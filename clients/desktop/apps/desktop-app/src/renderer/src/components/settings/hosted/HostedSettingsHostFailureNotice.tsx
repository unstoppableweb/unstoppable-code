import type { JSX } from 'react';
import { DesktopErrorBanner } from '@/components/shared/DesktopErrorBanner';
import { useHostedSettingsAccount } from './desktop-settings-host-context';
import {
  clearHostedSettingsFailure,
  useHostedSettingsHostFailure,
} from './hosted-settings-host-failure';
import type { HostedSettingsLocation } from './hosted-settings-location';

/**
 * The failed host action on this hosted settings page (a link that couldn't
 * open, a sign-in that couldn't start), for `SettingsPageNoticeProvider`:
 * the shared page shows it below its header.
 */
export function HostedSettingsHostFailureNotice({
  location,
}: {
  readonly location: HostedSettingsLocation;
}): JSX.Element | null {
  const account = useHostedSettingsAccount();
  const failure = useHostedSettingsHostFailure(location, account);
  return (
    <DesktopErrorBanner
      errorSource="hosted-settings-host-failure"
      className=""
      error={failure?.error}
      {...(failure?.details === undefined ? {} : { details: failure.details })}
      testId="hosted-settings-host-failure"
      onDismiss={(): void => clearHostedSettingsFailure()}
    />
  );
}
