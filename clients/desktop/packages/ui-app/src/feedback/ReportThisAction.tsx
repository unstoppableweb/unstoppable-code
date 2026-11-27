'use client';

import { useEffect, useMemo, useState, type JSX } from 'react';
import type { AppError } from '@canopy/protocol/app-errors';
import {
  toFeedbackReportError,
  type FeedbackReportError,
  type FeedbackReportTelemetry,
} from '@canopy/protocol/feedback-report';
import type { CanopyClient } from '@canopy/app-core';
import { useOptionalCanopyClient } from '@canopy/app-state';
import { Button, type ButtonSize } from '@canopy/ui-shared/components';
import { FeedbackReportDialog } from './FeedbackReportDialogEntry';
import { ReportActionBoundary } from './ReportActionBoundary';
import { recordReportUnavailable } from '@canopy/ui-shared/lib';

export { ReportActionBoundary };

export interface ReportThisActionProps {
  readonly error: AppError;
  readonly appName: string;
  /** Session links read when the error happened. */
  readonly telemetry?: FeedbackReportTelemetry;
  readonly size?: ButtonSize;
  /**
   * `ghost` beside a retry in a notice or toast. `secondary` beside the
   * primary recovery of a caught render failure.
   */
  readonly variant?: 'ghost' | 'secondary';
}

/**
 * The secondary `Report this` action beside a defect's recovery. Only defects
 * offer it, and only where the client can deliver the report. The shared
 * dialog entry loads its form on opening and keeps load failures recoverable.
 */
export function ReportThisAction(props: ReportThisActionProps): JSX.Element {
  return (
    <ReportActionBoundary
      key={props.error.referenceId}
      referenceId={props.error.referenceId}
    >
      <ReportThisButton {...props} />
    </ReportActionBoundary>
  );
}

/** What reporting `error` needs here, or `null` when it cannot be offered. */
function useReportAvailability(error: AppError): {
  readonly feedback: NonNullable<CanopyClient['feedback']>;
  readonly reportError: FeedbackReportError;
  readonly diagnosticsSupported: boolean;
} | null {
  const client = useOptionalCanopyClient();
  const { reportError, threw } = useMemo(() => {
    try {
      return { reportError: toFeedbackReportError(error), threw: false };
    } catch {
      return { reportError: null, threw: true };
    }
  }, [error]);
  // Only a defect offers Report this, so only a defect's throw takes it away.
  const unreportable = threw && error.kind === 'defect';
  const { referenceId } = error;
  useEffect(() => {
    if (unreportable) recordReportUnavailable(referenceId);
  }, [unreportable, referenceId]);
  const feedback =
    client?.capabilities.feedbackReports === true ? client.feedback : undefined;
  if (error.kind !== 'defect' || !feedback || !reportError) return null;
  return {
    feedback,
    reportError,
    diagnosticsSupported: client?.capabilities.feedbackDiagnostics === true,
  };
}

/** Whether `Report this` can be offered for `error` where this is mounted. */
export function useCanReportError(error: AppError): boolean {
  return useReportAvailability(error) !== null;
}

export interface ReportThisDialogProps {
  readonly error: AppError;
  readonly appName: string;
  /** Session links read when the error happened. */
  readonly telemetry?: FeedbackReportTelemetry;
  readonly ownerDocument?: Document | undefined;
  readonly onClose: () => void;
}

/**
 * The report form on its own, for a surface whose `Report this` can leave the
 * screen while the form is open. Mount it beyond that surface, inside a
 * {@link ReportActionBoundary}.
 */
export function ReportThisDialog({
  error,
  appName,
  telemetry,
  ownerDocument,
  onClose,
}: ReportThisDialogProps): JSX.Element | null {
  const availability = useReportAvailability(error);
  if (!availability) return null;
  return (
    <FeedbackReportDialog
      appName={appName}
      client={availability.feedback}
      diagnosticsSupported={availability.diagnosticsSupported}
      error={availability.reportError}
      {...(telemetry ? { telemetry } : {})}
      ownerDocument={ownerDocument}
      onClose={onClose}
    />
  );
}

function ReportThisButton({
  error,
  appName,
  telemetry,
  size = 'sm',
  variant = 'ghost',
}: ReportThisActionProps): JSX.Element | null {
  const canReport = useCanReportError(error);
  // Set while open: a popped-out panel's form belongs in that panel's window.
  const [openIn, setOpenIn] = useState<Document | null>(null);
  if (!canReport) return null;
  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        aria-haspopup="dialog"
        onClick={(event): void => setOpenIn(event.currentTarget.ownerDocument)}
        data-testid="report-this-action"
      >
        Report this
      </Button>
      {openIn ? (
        <ReportThisDialog
          error={error}
          appName={appName}
          {...(telemetry ? { telemetry } : {})}
          ownerDocument={openIn}
          onClose={(): void => setOpenIn(null)}
        />
      ) : null}
    </>
  );
}
