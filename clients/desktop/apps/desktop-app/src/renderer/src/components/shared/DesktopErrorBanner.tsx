import type { ComponentProps, JSX } from 'react';
import { ErrorBanner } from '@canopy/ui-shared/components';
import { brandText } from '@/lib/brand';
import { rendererAppErrorDisplayPolicy } from '@/lib/renderer-app-error';
import { DesktopReportThisAction } from './DesktopReportThisAction';
import { DesktopRestartAppAction } from './DesktopRestartAppAction';

type Props = Omit<
  ComponentProps<typeof ErrorBanner>,
  'displayPolicy' | 'reportAction'
>;

/**
 * The shared `ErrorBanner` with the renderer's raw-detail policy and the
 * desktop `Report this` gate. The banner renders the report action only
 * beside a defect, with the error whose reference it shows; the gate's own
 * boundary keeps a report failure from hiding the original error.
 *
 * A background-service refusal (CAN-7137) gets Restart app, the only step
 * that reconnects the service, unless the caller passed its own action.
 */
export function DesktopErrorBanner(props: Props): JSX.Element | null {
  const { error, secondaryAction } = props;
  const restart =
    secondaryAction === undefined &&
    typeof error === 'object' &&
    error !== null &&
    error.code === 'external.background_service_unavailable';
  return (
    <ErrorBanner
      {...props}
      {...(restart ? { secondaryAction: <DesktopRestartAppAction /> } : {})}
      displayPolicy={rendererAppErrorDisplayPolicy}
      reportAction={(defect): JSX.Element => (
        <DesktopReportThisAction error={defect} appName={brandText.appName} />
      )}
    />
  );
}
