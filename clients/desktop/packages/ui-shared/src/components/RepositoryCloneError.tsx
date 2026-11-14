import type { JSX, ReactNode } from 'react';
import type {
  AppError,
  AppErrorDisplayPolicy,
} from '@canopy/protocol/app-errors';
import { ErrorBanner } from './StatusBlocks';

export interface RepositoryCloneErrorProps {
  /** Safe clone copy, or the structured error when it is classified. */
  readonly message: string | AppError;
  readonly id?: string;
  readonly testId?: string;
  /** Names the repository ahead of a string message. */
  readonly prefix?: string;
  /** The raw clone output behind `Copy details`, never rendered. */
  readonly details?: string;
  readonly onRetry?: () => void;
  readonly onDismiss?: () => void;
  /** The host's raw-detail policy. Missing fails closed. */
  readonly displayPolicy?: AppErrorDisplayPolicy;
  /**
   * The host's `Report this`, rendered only beside a defect with the error
   * whose reference the banner shows.
   */
  readonly reportAction?: (error: AppError) => ReactNode;
}

/**
 * A failed clone, as the shared inline error. Hosts supply safe copy;
 * presentation never decides completion or Retry. The text can name
 * repositories and quote git output, so it is blocked from replay.
 */
export function RepositoryCloneError({
  message,
  id,
  testId,
  prefix,
  details,
  onRetry,
  onDismiss,
  displayPolicy,
  reportAction,
}: RepositoryCloneErrorProps): JSX.Element {
  return (
    <div id={id}>
      <ErrorBanner
        errorSource="repository-clone"
        className=""
        error={
          prefix && typeof message === 'string'
            ? `${prefix}: ${message}`
            : message
        }
        blockMessageFromReplay
        {...(testId === undefined ? {} : { testId })}
        {...(details === undefined ? {} : { details })}
        {...(onRetry ? { onRetry } : {})}
        {...(onDismiss ? { onDismiss } : {})}
        {...(displayPolicy ? { displayPolicy } : {})}
        {...(reportAction ? { reportAction } : {})}
      />
    </div>
  );
}
