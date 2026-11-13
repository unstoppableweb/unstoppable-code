'use client';

import { type JSX, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { CloudRunControlKeys } from '@canopy/app-state/cloud-pipeline-runs';
import type { CoreCoworkInvoker } from '@canopy/app-state/core-cowork';
import type { WorkerPipelineExecutionView } from '@canopy/protocol/canopy-core';
import { Badge, Button, DialogModal } from '@canopy/ui-shared/components';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { pipelineRunStatusBadge } from '../../code/activity/pipeline/PipelineRunRows';
import { WORKFLOW_RUN_LOCATION_LABELS } from '../workflow-run-model';
import { CloudPipelineRunDetail } from './CloudPipelineRunDetail';
import { useCloudPipelineRunSession } from './useCloudPipelineRunSession';

export interface CloudPipelineRunDialogProps {
  /** The host's web core carrier: the relay on desktop, the connection on web. */
  readonly invoker: CoreCoworkInvoker;
  readonly executionId: string;
  readonly initialJobId?: string;
  readonly onClose: () => void;
  /** Opens another run in place of this one, such as a Start over's. */
  readonly onOpenRun?: (executionId: string) => void;
  /** Every newer read of the run, for a list to follow. */
  readonly onView?: (view: WorkerPipelineExecutionView) => void;
  readonly onOpenPlan?: (planId: string) => void;
  readonly renderRunChat?: (view: WorkerPipelineExecutionView) => ReactNode;
  /** The host's control keys, so a control sent again from a row replays. */
  readonly controlKeys?: CloudRunControlKeys;
}

/**
 * A cloud run's detail in a full-window dialog (CAN-6326), as the Portal
 * shows a run's: the log pane needs the window's width. Opening it follows
 * the run live; closing it stops.
 */
export function CloudPipelineRunDialog({
  invoker,
  executionId,
  initialJobId,
  onClose,
  onOpenRun,
  onView,
  onOpenPlan,
  renderRunChat,
  controlKeys,
}: CloudPipelineRunDialogProps): JSX.Element {
  const session = useCloudPipelineRunSession(
    invoker,
    executionId,
    onView,
    controlKeys,
  );
  return (
    <DialogModal
      inset="flush"
      onClose={onClose}
      maxWidth="full"
      maxHeight="100%"
      // The log pane scrolls on its own; a scrolling body would defeat it.
      scrollableBody={false}
      showCloseButton={false}
      trapFocus
      closeOnEscape
      dataTestId="cloud-run-detail-dialog"
      title={
        session === null ? 'Workflow run' : <DialogTitle session={session} />
      }
      subtitle={`${WORKFLOW_RUN_LOCATION_LABELS.cloud} run`}
      topRightActions={
        <Button
          variant="ghost"
          size="compact"
          data-testid="cloud-run-detail-close"
          onClick={onClose}
        >
          Close
        </Button>
      }
    >
      <CloudPipelineRunDetail
        session={session}
        initialJobId={initialJobId}
        layout="overlay"
        onOpenRun={onOpenRun}
        onOpenPlan={onOpenPlan}
        renderRunChat={renderRunChat}
      />
    </DialogModal>
  );
}

function DialogTitle({
  session,
}: {
  readonly session: NonNullable<ReturnType<typeof useCloudPipelineRunSession>>;
}): JSX.Element {
  const execution = useStore(session, (state) => state.view?.execution);
  if (execution === undefined) return <span>Workflow run</span>;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className={`truncate ${REPLAY_MASK_CLASS}`}>{execution.name}</span>
      <Badge
        {...pipelineRunStatusBadge(execution.status)}
        data-testid="cloud-run-detail-status"
      >
        {execution.status}
      </Badge>
    </span>
  );
}
