'use client';

import type { JSX, MouseEvent, PointerEvent } from 'react';
import type { AppError } from '@canopy/protocol/app-errors';
import type { FeedbackReportTelemetry } from '@canopy/protocol/feedback-report';
import { AppErrorDetails, NoticeButton } from '@canopy/ui-shared/components';
import { ReportActionBoundary, useCanReportError } from './ReportThisAction';

/** A failure chosen for reporting, kept by the host beyond its toast. */
export interface ToastFailureReport {
  readonly error: AppError;
  readonly telemetry?: FeedbackReportTelemetry;
}

const keepFromCard = (
  event: MouseEvent<HTMLElement> | PointerEvent<HTMLElement>,
): void => {
  event.stopPropagation();
};

/**
 * A background failure's reference, for quoting to support. The person's own
 * work (a failed script or command) has none. Selecting or copying it never
 * activates the toast card around it.
 */
export function ToastFailureReference({
  error,
}: {
  readonly error: AppError;
}): JSX.Element | null {
  if (error.kind === 'input') return null;
  return (
    <div
      className="pt-1"
      onClick={keepFromCard}
      onPointerDown={keepFromCard}
      data-testid="toast-failure-reference"
    >
      <AppErrorDetails
        presentation={{ referenceId: error.referenceId }}
        dataTestId="toast-failure-details"
      />
    </div>
  );
}

export interface ToastFailureReportButtonProps {
  readonly error: AppError;
  readonly telemetry?: FeedbackReportTelemetry;
  /** Opens the report dialog the host mounts outside the toast. */
  readonly onReport: (report: ToastFailureReport) => void;
}

/**
 * `Report this` on a background failure, in the toast's own action style. Only
 * defects offer it, and only where the client can deliver the report.
 */
export function ToastFailureReportButton(
  props: ToastFailureReportButtonProps,
): JSX.Element {
  return (
    <ReportActionBoundary
      key={props.error.referenceId}
      referenceId={props.error.referenceId}
    >
      <ReportButton {...props} />
    </ReportActionBoundary>
  );
}

function ReportButton({
  error,
  telemetry,
  onReport,
}: ToastFailureReportButtonProps): JSX.Element | null {
  if (!useCanReportError(error)) return null;
  return (
    <NoticeButton
      aria-haspopup="dialog"
      data-testid="toast-failure-report"
      onClick={(event): void => {
        event.stopPropagation();
        onReport({ error, ...(telemetry ? { telemetry } : {}) });
      }}
    >
      Report this
    </NoticeButton>
  );
}
