'use client';

import { type JSX, type ReactNode } from 'react';
import { OverlayScrollArea } from '@canopy/ui-shared';
import { Disclosure } from '@canopy/ui-shared/components';
import {
  FailedPendingExecutionCard,
  FailedQueuedHookPipelineCard,
  PendingExecutionCard,
  QueuedHookPipelineCard,
  type FailedPendingExecutionCardEntry,
  type FailedQueuedPipelineCardEntry,
  type PendingExecutionCardEntry,
  type QueuedPipelineCardEntry,
} from './PipelineQueuedCards';
import {
  PipelineRunTreeRow,
  type PipelineRunSummary,
  type PipelineRunTreeRowProps,
} from './PipelineRunRows';
import { type ExecutionTreeNode } from '@canopy/ui-shared/lib';

const NO_QUEUE_ENTRIES: readonly never[] = [];

function noop(): void {
  // A host with no queue projection never renders a queue card to click.
}

/**
 * Queued and pending executions are a desktop-only projection: they come from
 * the `pipelines:list-queued-executions` channel, and a run only becomes
 * portal-visible once the executor has actually started it. Rather than make
 * every non-desktop host pass four empty arrays and four no-op callbacks, the
 * queue half of this contract is optional and defaults to "this host has no
 * queue" (CAN-2865). Desktop passes all eight and is unchanged.
 */
export interface PipelineRunsSectionBodyProps {
  readonly layout: 'card' | 'frameless';
  readonly actionFeedback?: ReactNode;
  readonly queuedExecutions?: readonly QueuedPipelineCardEntry[];
  readonly failedQueuedExecutions?: readonly FailedQueuedPipelineCardEntry[];
  readonly pendingExecutions?: readonly PendingExecutionCardEntry[];
  readonly failedPendingExecutions?: readonly FailedPendingExecutionCardEntry[];
  readonly visibleRoots: readonly ExecutionTreeNode<PipelineRunSummary>[];
  readonly hiddenRoots: readonly ExecutionTreeNode<PipelineRunSummary>[];
  readonly hiddenExpanded: boolean;
  readonly onHiddenExpandedChange: (expanded: boolean) => void;
  readonly onCancelQueuedExecution?: (queueId: string) => void;
  readonly onDismissFailedQueuedExecution?: (queueId: string) => void;
  readonly onCancelPendingExecution?: (localId: string) => void;
  readonly onDismissFailedPendingExecution?: (localId: string) => void;
  readonly runRowProps: Omit<PipelineRunTreeRowProps, 'node'>;
}

export function PipelineRunsSectionBody({
  layout,
  actionFeedback,
  queuedExecutions = NO_QUEUE_ENTRIES,
  failedQueuedExecutions = NO_QUEUE_ENTRIES,
  pendingExecutions = NO_QUEUE_ENTRIES,
  failedPendingExecutions = NO_QUEUE_ENTRIES,
  visibleRoots,
  hiddenRoots,
  hiddenExpanded,
  onHiddenExpandedChange,
  onCancelQueuedExecution,
  onDismissFailedQueuedExecution,
  onCancelPendingExecution,
  onDismissFailedPendingExecution,
  runRowProps,
}: PipelineRunsSectionBodyProps): JSX.Element | null {
  const frameless = layout === 'frameless';
  const primaryRowCount =
    queuedExecutions.length +
    failedQueuedExecutions.length +
    pendingExecutions.length +
    failedPendingExecutions.length +
    visibleRoots.length;

  if (primaryRowCount === 0 && hiddenRoots.length === 0 && !actionFeedback) {
    return null;
  }

  return (
    <div
      className={
        frameless ? 'flex min-h-0 flex-1 flex-col gap-2' : 'flex flex-col gap-2'
      }
    >
      {actionFeedback}
      {primaryRowCount > 0 && (
        <div
          data-testid="pipeline-runs-primary-list"
          className={
            frameless
              ? 'min-h-0 flex-1 grid grid-cols-1 content-start gap-2 overflow-y-auto'
              : 'max-h-76 grid grid-cols-1 content-start gap-2 overflow-y-auto'
          }
        >
          {queuedExecutions.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {queuedExecutions.map((entry) => (
                <QueuedHookPipelineCard
                  key={entry.queueId}
                  entry={entry}
                  onCancel={onCancelQueuedExecution ?? noop}
                />
              ))}
            </div>
          )}
          {failedQueuedExecutions.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {failedQueuedExecutions.map((entry) => (
                <FailedQueuedHookPipelineCard
                  key={entry.queueId}
                  entry={entry}
                  onDismiss={onDismissFailedQueuedExecution ?? noop}
                />
              ))}
            </div>
          )}
          {pendingExecutions.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {pendingExecutions.map((entry) => (
                <PendingExecutionCard
                  key={entry.localId}
                  entry={entry}
                  onCancel={onCancelPendingExecution ?? noop}
                />
              ))}
            </div>
          )}
          {failedPendingExecutions.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {failedPendingExecutions.map((entry) => (
                <FailedPendingExecutionCard
                  key={entry.localId}
                  entry={entry}
                  onDismiss={onDismissFailedPendingExecution ?? noop}
                />
              ))}
            </div>
          )}
          {visibleRoots.map((node) => (
            <PipelineRunTreeRow
              key={node.summary.id}
              node={node}
              {...runRowProps}
            />
          ))}
        </div>
      )}

      {hiddenRoots.length > 0 && (
        // The chevron leads the toggle at its left edge, so it centers under
        // the action card's 16px Dispatch glyph above it.
        <Disclosure
          label={`Hidden (${hiddenRoots.length})`}
          open={hiddenExpanded}
          onOpenChange={onHiddenExpandedChange}
          dataTestId="pipeline-hidden"
          {...(frameless ? { className: 'shrink-0' } : {})}
        >
          <OverlayScrollArea
            viewportProps={{
              'data-testid': 'pipeline-hidden-viewport',
              onScroll: (event) => {
                const viewport = event.currentTarget;
                const maskImage =
                  viewport.scrollTop > 0
                    ? 'linear-gradient(to bottom, transparent, black 12px)'
                    : 'none';
                if (viewport.style.maskImage !== maskImage)
                  viewport.style.maskImage = maskImage;
              },
            }}
            viewportClassName="overflow-x-hidden"
            railClassName="-right-3"
            contentClassName="min-w-0 flex flex-col gap-1.5"
            // The frameless cap is `FRAMELESS_HIDDEN_GROUP_MAX_H`, spelled
            // out so the design-system lint can read it; the section test
            // pins the literal to the shared constant.
            className={frameless ? 'max-h-60' : 'max-h-76'}
          >
            {hiddenRoots.map((node) => (
              <PipelineRunTreeRow
                key={node.summary.id}
                node={node}
                {...runRowProps}
              />
            ))}
          </OverlayScrollArea>
        </Disclosure>
      )}
    </div>
  );
}
