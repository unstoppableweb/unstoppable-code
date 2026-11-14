'use client';

import type { JSX, ReactNode } from 'react';
import type {
  AppError,
  AppErrorDisplayPolicy,
} from '@canopy/protocol/app-errors';
import { ErrorBanner } from '@canopy/ui-shared/components';

export interface PullRequestActionErrorProps {
  /** The worktree's latest failed git or pull request action. */
  readonly error: string | AppError | null | undefined;
  /** The raw reason behind `Copy details`, never rendered. */
  readonly details?: string;
  readonly onDismiss: () => void;
  readonly onRetry?: () => void;
  readonly retrying?: boolean;
  readonly onStartOver?: () => void;
  readonly starting?: boolean;
  readonly secondaryAction?: ReactNode;
  /** The host's raw-detail policy. */
  readonly displayPolicy: AppErrorDisplayPolicy;
  /** The host's `Report this`, rendered only beside a defect. */
  readonly renderReportAction?: (error: AppError) => ReactNode;
}

/**
 * A failed git or pull request action, directly below a worktree's top bar on
 * desktop and in the Portal. It never sits inside the bar's frame. The text
 * can name repositories and quote git output, so it is blocked from replay.
 */
export function PullRequestActionError({
  error,
  details,
  onDismiss,
  onRetry,
  retrying,
  onStartOver,
  starting,
  secondaryAction,
  displayPolicy,
  renderReportAction,
}: PullRequestActionErrorProps): JSX.Element | null {
  if (!error) return null;
  return (
    <div className="shrink-0 px-3 pt-2">
      <ErrorBanner
        errorSource="pr-action-error"
        className=""
        error={error}
        blockMessageFromReplay
        testId="pr-action-error"
        dismissTestId="pr-action-error-dismiss"
        onDismiss={onDismiss}
        displayPolicy={displayPolicy}
        {...(details === undefined ? {} : { details })}
        {...(onRetry ? { onRetry, retrying: retrying === true } : {})}
        {...(onStartOver ? { onStartOver, starting: starting === true } : {})}
        {...(secondaryAction ? { secondaryAction } : {})}
        {...(renderReportAction ? { reportAction: renderReportAction } : {})}
      />
    </div>
  );
}
