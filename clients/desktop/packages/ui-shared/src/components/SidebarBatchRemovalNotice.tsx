'use client';

import type { JSX } from 'react';
import { REPLAY_MASK_CLASS } from '../lib/replay-privacy';
import { LoadingSpinner } from '../primitives/LoadingSpinner';
import { Notice, NoticeButton } from '../primitives/Notice';
import {
  unitCountLabel,
  type SidebarBatchUnitLabel,
} from './worktree-count-label';

/** `remove` when the queued batches mix archive and delete. */
export type SidebarBatchRemovalVerb = 'archive' | 'delete' | 'remove';

export interface SidebarBatchRemovalNoticeProps {
  readonly verb: SidebarBatchRemovalVerb;
  /** Names the queued rows; a queue that mixes kinds names them as items. */
  readonly unitLabel: SidebarBatchUnitLabel;
  readonly running: boolean;
  /** Stop was pressed; the in-flight removal still finishes. */
  readonly stopRequested: boolean;
  readonly total: number;
  /** Removed successfully. */
  readonly done: number;
  readonly failed: number;
  readonly skipped: number;
  /** Still pending: queued while running, or dropped by Stop once idle. */
  readonly notStarted: number;
  /** Rows already gone whose background cleanup still runs. */
  readonly cleanupRunning?: number;
  /** Of `failed`, those whose background cleanup failed after the row left. */
  readonly lateFailed?: number;
  readonly onStop: () => void;
  readonly onShowDetails: () => void;
  readonly onDismiss: () => void;
  readonly testId?: string;
}

const PROGRESSIVE: Readonly<Record<SidebarBatchRemovalVerb, string>> = {
  archive: 'Archiving',
  delete: 'Deleting',
  remove: 'Removing',
};
const PAST: Readonly<Record<SidebarBatchRemovalVerb, string>> = {
  archive: 'Archived',
  delete: 'Deleted',
  remove: 'Removed',
};

/**
 * Bulk removal of sidebar rows (CAN-3975) running in the background: progress with
 * Stop while the queue drains, then what did not finish, with Details.
 * Renders nothing when everything succeeded; the rows leaving is the outcome.
 * Pure display; the rail feeds it the queue's counts.
 */
export function SidebarBatchRemovalNotice({
  verb,
  unitLabel,
  running,
  stopRequested,
  total,
  done,
  failed,
  skipped,
  notStarted,
  cleanupRunning = 0,
  lateFailed = 0,
  onStop,
  onShowDetails,
  onDismiss,
  testId = 'worktree-batch-removal-notice',
}: SidebarBatchRemovalNoticeProps): JSX.Element | null {
  if (running) {
    return (
      <Notice
        data-testid={testId}
        intent="neutral"
        icon={<LoadingSpinner sizePx={14} decorative />}
        role="status"
        title={`${PROGRESSIVE[verb]} ${unitLabel.plural}`}
        actions={
          <NoticeButton
            onClick={onStop}
            disabled={stopRequested}
            data-testid={`${testId}-stop`}
          >
            {stopRequested ? 'Stopping…' : 'Stop'}
          </NoticeButton>
        }
      >
        {done} of {total} done.
      </Notice>
    );
  }
  const parts: string[] = [];
  if (failed > 0) parts.push(`${failed} failed`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  if (notStarted > 0) parts.push(`${notStarted} not started`);
  if (parts.length === 0) return null;
  const outcome = `${parts.join(', ')}.`;
  return (
    <Notice
      data-testid={testId}
      intent="attention"
      role="status"
      title={`${PAST[verb]} ${done} of ${unitCountLabel(unitLabel, total)}`}
      actions={
        <NoticeButton onClick={onShowDetails} data-testid={`${testId}-details`}>
          Details
        </NoticeButton>
      }
      onDismiss={onDismiss}
      dismissTestId={`${testId}-dismiss`}
      {...(cleanupRunning > 0
        ? { detail: cleanupRunningSentence(unitLabel, cleanupRunning) }
        : {})}
    >
      {cleanupRunning > 0
        ? outcome
        : lateFailed > 0
          ? `Cleanup finished. ${outcome}`
          : outcome}
    </Notice>
  );
}

function cleanupRunningSentence(
  unitLabel: SidebarBatchUnitLabel,
  count: number,
): string {
  return `Cleanup is still running for ${unitCountLabel(unitLabel, count)}, so more errors may appear.`;
}

const PRESENT: Readonly<Record<SidebarBatchRemovalVerb, string>> = {
  archive: 'archive',
  delete: 'delete',
  remove: 'remove',
};

export interface SidebarBatchCleanupFailureNoticeProps {
  readonly verb: SidebarBatchRemovalVerb;
  readonly unitLabel: SidebarBatchUnitLabel;
  /** Names of the batch's rows whose background cleanup failed. */
  readonly failedLabels: readonly string[];
  /** The batch's rows whose background cleanup still runs. */
  readonly cleanupRunning: number;
  readonly onShowDetails: () => void;
  readonly onDismiss: () => void;
  readonly testId?: string;
}

/**
 * A finished batch whose rows already left the rail, reporting cleanup that
 * failed afterwards (the rows are back). Further failures from the same
 * batch join it; it says so while more cleanup still runs.
 */
export function SidebarBatchCleanupFailureNotice({
  verb,
  unitLabel,
  failedLabels,
  cleanupRunning,
  onShowDetails,
  onDismiss,
  testId = 'worktree-batch-cleanup-notice',
}: SidebarBatchCleanupFailureNoticeProps): JSX.Element | null {
  const [onlyLabel] = failedLabels;
  if (onlyLabel === undefined) return null;
  const failed = failedLabels.length;
  return (
    <Notice
      data-testid={testId}
      intent="attention"
      role="status"
      title={
        failed === 1 ? (
          <>
            Couldn't {PRESENT[verb]}{' '}
            <span className={REPLAY_MASK_CLASS}>{onlyLabel}</span>
          </>
        ) : (
          `Couldn't ${PRESENT[verb]} ${unitCountLabel(unitLabel, failed)}`
        )
      }
      actions={
        <NoticeButton onClick={onShowDetails} data-testid={`${testId}-details`}>
          Details
        </NoticeButton>
      }
      onDismiss={onDismiss}
      dismissTestId={`${testId}-dismiss`}
    >
      {cleanupRunning > 0
        ? cleanupRunningSentence(unitLabel, cleanupRunning)
        : `Cleanup finished. ${failed} failed.`}
    </Notice>
  );
}
