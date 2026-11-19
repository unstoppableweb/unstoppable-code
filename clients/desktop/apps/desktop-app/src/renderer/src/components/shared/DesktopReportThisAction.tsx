import { useMemo, type ComponentProps, type JSX, type ReactNode } from 'react';
import type { CanopyClient } from '@canopy/app-core';
import {
  CanopyClientProvider,
  useOptionalCanopyClient,
} from '@canopy/app-state';
import { ReportActionBoundary, ReportThisAction } from '@canopy/ui-app';
import { useCanopyCloudConnected } from '@/hooks/useCanopyCloudConnected';

type Props = ComponentProps<typeof ReportThisAction>;

/** Account eligibility belongs to the host; the report UI stays shared. */
export function DesktopReportThisAction(props: Props): JSX.Element {
  return (
    <ReportActionBoundary referenceId={props.error.referenceId}>
      <DesktopReportEligibility>
        {(eligible): ReactNode =>
          eligible ? <ReportThisAction {...props} /> : null
        }
      </DesktopReportEligibility>
    </ReportActionBoundary>
  );
}

/**
 * Lends its children the account-derived report capability. It reads the
 * account, so mount it only beside an actual defect.
 */
export function DesktopReportEligibility({
  children,
}: {
  children: (eligible: boolean) => ReactNode;
}): JSX.Element {
  // The same event-driven account check excludes both minted and normalized
  // guests, and fails closed until the first account read settles. Mount it
  // only beside an actual defect, including the root's separate provider.
  const connected = useCanopyCloudConnected();
  const client = useOptionalCanopyClient();
  const reportClient = useMemo<CanopyClient | null>(() => {
    if (connected !== true || !client) return null;
    // Scope the account-derived capability to recovery without replacing the
    // app's IPC client or disposing any of its stores. Keep the feedback port
    // itself available for ordinary Send feedback, including guests.
    return {
      capabilities: { ...client.capabilities, feedbackReports: true },
      ...(client.feedback ? { feedback: client.feedback } : {}),
      query: client.query.bind(client),
      command: client.command.bind(client),
      subscribe: client.subscribe.bind(client),
    };
  }, [client, connected]);
  return reportClient ? (
    <CanopyClientProvider client={reportClient}>
      {children(true)}
    </CanopyClientProvider>
  ) : (
    <>{children(false)}</>
  );
}
