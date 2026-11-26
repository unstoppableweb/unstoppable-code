import type { JSX } from 'react';
import type {
  FeedbackReportClient,
  FeedbackReportDraft,
  FeedbackReportError,
  FeedbackReportTelemetry,
} from '@canopy/protocol/feedback-report';
import type { FeedbackDialogReportType } from './FeedbackDialog';

export interface FeedbackReportDialogProps {
  readonly appName: string;
  readonly client: FeedbackReportClient;
  /** The client's `feedbackDiagnostics` capability. */
  readonly diagnosticsSupported: boolean;
  readonly onClose: () => void;
  readonly initialReportType?: FeedbackDialogReportType;
  /** Reports this failure. Without it the dialog is ordinary feedback. */
  readonly error?: FeedbackReportError;
  /** Session links read when the error happened, never at opening. */
  readonly telemetry?: FeedbackReportTelemetry;
  /** The window to draw in: a popped-out panel's, not the main one. */
  readonly ownerDocument?: Document | undefined;
}

export type DraftState =
  | { status: 'loading' }
  | { status: 'ready'; draft: FeedbackReportDraft }
  | { status: 'unavailable' };

export interface FeedbackReportDialogContentProps extends FeedbackReportDialogProps {
  readonly openingDraft?: Promise<DraftState>;
  /** The latest displayed error when this opening started. */
  readonly recentError?: FeedbackReportError | undefined;
}

export type FeedbackReportDialogComponent = (
  props: FeedbackReportDialogContentProps,
) => JSX.Element;
