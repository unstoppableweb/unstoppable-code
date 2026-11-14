'use client';

import { Component, type ErrorInfo, type JSX, type ReactNode } from 'react';
import {
  getAppErrorThrownType,
  type AppError,
  type AppErrorPresentation,
  type AppErrorThrownType,
} from '@canopy/protocol/app-errors';
import type { FeedbackReportTelemetry } from '@canopy/protocol/feedback-report';
import {
  ErrorFallback,
  type ErrorFallbackProps,
} from '@canopy/ui-shared/components';
import { ReportActionBoundary } from './ReportActionBoundary';

export interface AppErrorBoundaryCapture {
  readonly appError: AppError | null;
  readonly telemetry: FeedbackReportTelemetry | null;
}

/** Fixed values only: this reaches logs, so it never holds user content. */
export type AppErrorBoundaryContext = Readonly<Record<string, string>>;

/** What a shared boundary can't know itself: telemetry, policy and eligibility. */
export interface AppErrorBoundaryHost {
  /** Called once per caught occurrence, from the commit that caught it. */
  capture(
    error: unknown,
    info: ErrorInfo,
    context: AppErrorBoundaryContext | undefined,
    thrownType?: AppErrorThrownType,
  ): AppErrorBoundaryCapture;
  /** Only what this build may show. A stable build gets no raw detail. */
  present(
    appError: AppError,
  ): Pick<AppErrorPresentation, 'referenceId' | 'rawDetail'>;
  renderReportAction(
    appError: AppError,
    telemetry: FeedbackReportTelemetry | null,
  ): ReactNode;
  /** Throws framework control flow (a redirect) so it never reads as a defect. */
  rethrow?(error: unknown): void;
}

export interface AppErrorBoundaryProps extends Pick<
  ErrorFallbackProps,
  'layout' | 'message' | 'recoveryLabel' | 'minHeight' | 'testId'
> {
  readonly children: ReactNode;
  /** Without one, the fallback keeps its copy and recovery, and nothing else. */
  readonly host?: AppErrorBoundaryHost | undefined;
  /** A new value means different content: the failure and its record clear. */
  readonly resetKey?: string | number | undefined;
  readonly context?: AppErrorBoundaryContext | undefined;
  /** Wraps the fallback only: a dialog's chrome, a provider it needs. */
  readonly renderFrame?: ((fallback: JSX.Element) => ReactNode) | undefined;
  /**
   * Replaces the default remount. A returned promise holds the recovery busy
   * until it settles; a rejection or throw keeps the fallback usable.
   */
  readonly onRecover?: (() => void | Promise<void>) | undefined;
  /**
   * The recovery replaces the document, so the failed tree must not remount
   * behind it. The fallback stays, and stays usable if nothing replaced it.
   */
  readonly recoveryReplacesDocument?: boolean | undefined;
}

interface AppErrorBoundaryState {
  /** Separate from `failure`: `throw null` is a failure too. */
  readonly failed: boolean;
  readonly failure: unknown;
  readonly captured: AppErrorBoundaryCapture | null;
  readonly recovering: boolean;
  readonly resetKey: string | number | undefined;
}

/**
 * Objects pass through, so a valid app error keeps its identity and a foreign
 * realm's `Error` keeps its message. A thrown primitive never reaches a report,
 * because its text could be anything.
 */
function normalizeThrown(value: unknown): unknown {
  return typeof value === 'object' && value !== null
    ? value
    : new Error('A non-error value was thrown during render');
}

function ReportActionSlot({
  host,
  appError,
  telemetry,
}: {
  readonly host: AppErrorBoundaryHost;
  readonly appError: AppError;
  readonly telemetry: FeedbackReportTelemetry | null;
}): ReactNode {
  return host.renderReportAction(appError, telemetry);
}

/** The factory and its resulting Details both render beneath a guard. */
function PresentationSlot({
  host,
  appError,
  display,
}: {
  readonly host: AppErrorBoundaryHost;
  readonly appError: AppError;
  readonly display: ErrorFallbackProps;
}): JSX.Element {
  return <ErrorFallback {...display} presentation={host.present(appError)} />;
}

/**
 * Contains a render failure to its children and shows `ErrorFallback` in their
 * place. Recording, policy and reporting come from the injected host; the
 * lifecycle is here so every scope records once and recovers the same way.
 */
export class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  /** The recovery in flight. Replaced or cleared, its completion is ignored. */
  private attempt: symbol | null = null;

  constructor(props: AppErrorBoundaryProps) {
    super(props);
    this.state = {
      failed: false,
      failure: undefined,
      captured: null,
      recovering: false,
      resetKey: props.resetKey,
    };
  }

  static getDerivedStateFromError(
    failure: unknown,
  ): Partial<AppErrorBoundaryState> {
    return { failed: true, failure, captured: null, recovering: false };
  }

  static getDerivedStateFromProps(
    props: AppErrorBoundaryProps,
    state: AppErrorBoundaryState,
  ): Partial<AppErrorBoundaryState> | null {
    if (props.resetKey === state.resetKey) return null;
    return {
      resetKey: props.resetKey,
      failed: false,
      failure: undefined,
      captured: null,
      recovering: false,
    };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    this.attempt = null;
    const { host, context } = this.props;
    if (!host) return;
    let captured: AppErrorBoundaryCapture | null = null;
    try {
      const thrownType = getAppErrorThrownType(error);
      captured = host.capture(
        normalizeThrown(error),
        info,
        context,
        thrownType,
      );
    } catch {
      // Never retried: a partial capture may already have recorded. The
      // fallback keeps its copy and recovery without Details or Report this.
    }
    this.setState({ captured });
  }

  override componentDidUpdate(previous: AppErrorBoundaryProps): void {
    if (previous.resetKey !== this.props.resetKey) this.attempt = null;
  }

  override componentWillUnmount(): void {
    this.attempt = null;
  }

  private clearFailure(): void {
    this.setState({
      failed: false,
      failure: undefined,
      captured: null,
      recovering: false,
    });
  }

  private readonly handleRecover = (): void => {
    const { onRecover, recoveryReplacesDocument } = this.props;
    if (!onRecover) {
      this.clearFailure();
      return;
    }
    if (this.attempt !== null) return;
    const attempt = Symbol('recovery');
    this.attempt = attempt;
    const settle = (succeeded: boolean): void => {
      if (this.attempt !== attempt) return;
      this.attempt = null;
      if (succeeded && recoveryReplacesDocument !== true) this.clearFailure();
      else this.setState({ recovering: false });
    };
    let result: void | Promise<void>;
    try {
      result = onRecover();
    } catch {
      settle(false);
      return;
    }
    if (result === undefined) {
      settle(true);
      return;
    }
    this.setState({ recovering: true });
    // A popped-out window can return a promise from another realm. Assimilate
    // it rather than using instanceof, which would clear the failure early.
    Promise.resolve(result).then(
      () => settle(true),
      () => settle(false),
    );
  };

  override render(): ReactNode {
    const { children, host, renderFrame } = this.props;
    const { failed, failure, captured, recovering } = this.state;
    if (!failed) return children;

    // Here rather than `getDerivedStateFromError`, which can't reach the host:
    // throwing from this render means nothing commits, so nothing is captured.
    host?.rethrow?.(failure);

    const { layout, message, recoveryLabel, minHeight, testId } = this.props;
    const appError = captured?.appError ?? null;
    const display: ErrorFallbackProps = {
      layout,
      message,
      recoveryLabel,
      minHeight,
      testId,
      onRecover: this.handleRecover,
      recovering,
      reportAction:
        host && appError ? (
          <ReportActionBoundary key={appError.referenceId}>
            <ReportActionSlot
              host={host}
              appError={appError}
              telemetry={captured?.telemetry ?? null}
            />
          </ReportActionBoundary>
        ) : undefined,
    };
    const fallback =
      host && appError ? (
        <ReportActionBoundary
          key={appError.referenceId}
          fallback={<ErrorFallback {...display} />}
        >
          <PresentationSlot host={host} appError={appError} display={display} />
        </ReportActionBoundary>
      ) : (
        <ErrorFallback {...display} />
      );
    return renderFrame ? renderFrame(fallback) : fallback;
  }
}
