import { lazy, Suspense, type JSX } from 'react';
import type { ExecutionState } from '@canopy/execution-engine/types/pipeline';
import type { PlanReadyPipelineModalOnRun } from '@/components/chat/PlanReadyPipelineModal';
import { PipelineReportModal } from './PipelineReportModal';

// The pipeline picker is large and only needed once a follow-up opens, so it
// stays out of the detail body's bundle.
const PlanReadyPipelineModal = lazy(() =>
  import('@/components/chat/PlanReadyPipelineModal').then((module) => ({
    default: module.PlanReadyPipelineModal,
  })),
);

export interface PipelineExecutionReportDialog {
  executionId: string;
  pipelineName: string;
  /** Document the dialog renders in; captured when it opened. */
  ownerDocument?: Document;
}

export interface PipelineExecutionFollowUpDialog {
  execution: ExecutionState;
  ownerDocument?: Document;
}

/**
 * Secondary dialogs of the shared execution-action controller: the run
 * report and the plan-ready pipeline follow-up. Both portal into the document
 * of whichever surface opened them (captured when the dialog opens), so a
 * panel in an auxiliary window gets its dialog there rather than in the main
 * window. Nothing renders in place, so hosts can mount this anywhere.
 */
export function PipelineExecutionActionDialogs({
  report,
  onCloseReport,
  followUp,
  followUpRunning,
  followUpError,
  followUpErrorRecorded,
  onCloseFollowUp,
  onRunFollowUp,
}: {
  report: PipelineExecutionReportDialog | null;
  onCloseReport: () => void;
  followUp: PipelineExecutionFollowUpDialog | null;
  followUpRunning: boolean;
  followUpError: string | null;
  followUpErrorRecorded: boolean;
  onCloseFollowUp: () => void;
  onRunFollowUp: PlanReadyPipelineModalOnRun;
}): JSX.Element {
  return (
    <>
      {report ? (
        <PipelineReportModal
          executionId={report.executionId}
          pipelineName={report.pipelineName}
          onClose={onCloseReport}
          ownerDocument={report.ownerDocument}
        />
      ) : null}
      {followUp ? (
        <Suspense fallback={null}>
          <PlanReadyPipelineModal
            projectId={followUp.execution.project_id}
            worktreeId={followUp.execution.worktree_id}
            onClose={onCloseFollowUp}
            onRun={onRunFollowUp}
            isRunning={followUpRunning}
            runError={followUpError}
            runErrorRecorded={followUpErrorRecorded}
            ownerDocument={followUp.ownerDocument}
          />
        </Suspense>
      ) : null}
    </>
  );
}
