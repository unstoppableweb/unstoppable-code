'use client';

import { Component, type JSX, type ReactNode } from 'react';
import type { AppErrorPresentation } from '@canopy/protocol/app-errors';
import { recordReportUnavailable } from '../lib/report-unavailable';
import { AppErrorDetails } from '../primitives/AppErrorDetails';
import { ErrorState } from '../primitives/StatusBlocks';

/** The room a fallback frames. It never changes what was recorded. */
export type ErrorFallbackLayout = 'window' | 'fill' | 'inline';

const LAYOUT_CLASS_NAMES: Record<ErrorFallbackLayout, string> = {
  window: 'flex h-screen w-screen overflow-auto bg-base p-6 fg-primary',
  fill: 'flex h-full min-h-0 w-full min-w-0 flex-1 overflow-auto',
  inline: 'flex w-full min-w-0',
};

export interface ErrorFallbackProps {
  readonly layout: ErrorFallbackLayout;
  /** One sentence naming the place that failed: `Couldn't show this panel.` */
  readonly message: ReactNode;
  /** Names the scope it recovers: `Reload panel`. Defaults to `Try again`. */
  readonly recoveryLabel?: string;
  /**
   * What a named recovery announces while busy: `Reloading panel…`. Its
   * button shows only a spinner, so this is the busy accessible name.
   */
  readonly recoveringLabel?: string;
  readonly onRecover?: () => void;
  readonly recovering?: boolean;
  /** A quiet action after the recovery, which stays first. */
  readonly reportAction?: ReactNode;
  /** Host-approved only: a stable build's presentation carries no raw detail. */
  readonly presentation?: Pick<
    AppErrorPresentation,
    'referenceId' | 'rawDetail'
  > | null;
  /** The room `inline` holds, so a failed chart keeps its place. */
  readonly minHeight?: number;
  readonly testId?: string;
}

/** Details are optional: losing them must never take the recovery with them. */
class ErrorFallbackDetailsBoundary extends Component<
  { readonly children: ReactNode; readonly referenceId?: string },
  { readonly failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(): void {
    // Details are gone for this defect: record that once per defect, with a
    // fixed source only.
    recordReportUnavailable(this.props.referenceId);
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * The one display of a caught render failure on desktop and web: the shared
 * {@link ErrorState} in place of what failed, its reference ID right under
 * the message, then two actions: the primary recovery and a secondary
 * `Report this`. Recording
 * and lifecycle belong to the boundary around it, so rendering this reports
 * nothing beyond Details that failed to render.
 */
export function ErrorFallback({
  layout,
  message,
  recoveryLabel,
  recoveringLabel,
  onRecover,
  recovering,
  reportAction,
  presentation,
  minHeight,
  testId,
}: ErrorFallbackProps): JSX.Element {
  const details = presentation ? (
    <ErrorFallbackDetailsBoundary
      key={presentation.referenceId}
      referenceId={presentation.referenceId}
    >
      <AppErrorDetails
        align="center"
        presentation={presentation}
        dataTestId={testId ? `${testId}-details` : 'error-fallback-details'}
      />
    </ErrorFallbackDetailsBoundary>
  ) : undefined;
  return (
    <div
      className={LAYOUT_CLASS_NAMES[layout]}
      style={
        layout === 'inline' && minHeight !== undefined
          ? { minHeight }
          : undefined
      }
      data-testid={testId}
    >
      {/* Auto margins center it without clipping the top when it overflows. */}
      <div className="m-auto w-full min-w-0 max-w-2xl">
        <ErrorState
          space={layout === 'window' ? 'page' : 'panel'}
          message={message}
          subtitle={details}
          onRetry={onRecover}
          retryLabel={recoveryLabel}
          retryingLabel={recoveringLabel}
          retryVariant="primary"
          retrying={recovering}
          retryTestId={testId ? `${testId}-recover` : undefined}
          secondaryAction={reportAction}
        />
      </div>
    </div>
  );
}
