'use client';

import type { JSX } from 'react';
import type { WorkerPipelineSurvivalAssessment } from '@canopy/protocol/canopy-core';
import {
  Notice,
  NoticeList,
  NoticeListItem,
} from '@canopy/ui-shared/components';
import { formatTimingTimestamp, parseIsoToEpoch } from '@canopy/ui-shared/lib';

/** Same explanatory unit on desktop and Portal; no speculative recovery action. */
export function PipelineRunBackgroundNotice({
  appDependencyApplicable,
  assessment,
  status,
  pausedAt,
}: {
  readonly appDependencyApplicable: boolean;
  readonly assessment?: WorkerPipelineSurvivalAssessment;
  readonly status: string;
  readonly pausedAt?: string;
}): JSX.Element | null {
  if (!appDependencyApplicable) return null;
  const active =
    status === 'running' || status === 'pending' || status === 'queued';
  const paused = status === 'paused';
  if (!assessment && !active && !paused) return null;
  const continues = assessment?.disposition === 'continues';
  const pauses = assessment?.disposition === 'pauses';
  // Conditional wording does not claim that the originating app is currently
  // closed: a paired client may be displaying its last received projection.
  // Only an assessment that pauses asks to keep the app open: unassessed
  // runs, such as shell-only background runs, may well continue.
  const title = paused
    ? 'Run paused'
    : active && continues
      ? 'Continues after you close the app'
      : active && pauses
        ? 'Keep the app open'
        : 'Background support';
  return (
    // The message slot is an inline span: block-level lines are spans too.
    <Notice
      intent="neutral"
      role="status"
      title={title}
      data-testid="pipeline-run-background-notice"
    >
      {continues ? (
        <span className="block">
          Ledger is unavailable while the app is closed. Model steps can
          continue without it.
        </span>
      ) : (
        <>
          {active && pauses && (
            <span className="block">This run pauses when the app closes.</span>
          )}
          {assessment?.blockers.length ? (
            <NoticeList>
              {assessment.blockers.map((blocker) => (
                <NoticeListItem key={blocker.code}>
                  {blocker.explanation}
                </NoticeListItem>
              ))}
            </NoticeList>
          ) : (
            <span className="block">
              Background support has not been verified for this workflow.
            </span>
          )}
        </>
      )}
      {paused && parseIsoToEpoch(pausedAt) !== null && (
        <span className="block">
          Checkpoint saved{' '}
          <time dateTime={pausedAt}>{formatTimingTimestamp(pausedAt)}</time>.
        </span>
      )}
    </Notice>
  );
}
