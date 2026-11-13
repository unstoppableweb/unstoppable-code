import type {
  WorkerPipelineArtifact,
  WorkerPipelineExecutionDetail,
  WorkerPipelineExecutionView,
  WorkerPipelineJobDetail,
  WorkerPipelineStepDetail,
} from '@canopy/protocol/canopy-core';
import {
  canRerunExecution,
  canResumeExecution,
  canRetryExecution,
  compactPipelineStatusReasonLabel,
  hasRerunReplayData,
  type PipelineStatusReason,
} from '@canopy/ui-shared/lib';
import type {
  PipelineRunDetailJob,
  PipelineRunDetailPauseCheckpoint,
  PipelineRunDetailStep,
  PipelineRunDetailView,
} from '../../code/activity/pipeline/PipelineRunDetailModel';
import {
  isPipelineExecutionActiveStatus,
  type PipelineRunExecutionState,
  type PipelineRunJobGroup,
  type PipelineRunJobResult,
  type PipelineRunSummary,
} from '../../code/activity/pipeline/PipelineRunRows';
import {
  NO_PROJECT_LABEL,
  workflowRunStatusFromPipeline,
  type WorkflowPipelineRunRow,
  type WorkflowRunAction,
  type WorkflowRunRow,
} from '../workflow-run-model';
import { workflowRunStarterOf } from '../workflow-run-starter';

/*
 * Cloud workflow runs in the shared run views (CAN-6326, plan CP-38): the
 * web core's execution and detail projection (CAN-6214) in the snake_case
 * shapes `PipelineRunRows` and `PipelineRunDetail` already draw, so a cloud
 * run renders and gates its controls exactly as a run on this computer does.
 * Desktop and web (CP-39) both read through these.
 */

/** A cloud run's key in the Runs feed; never a local execution's. */
export function cloudWorkflowRunKey(executionId: string): string {
  return `cloud-run:${executionId}`;
}

/** The run's active blockers, in the shared reason shape. */
export function cloudRunStatusReasons(
  detail: WorkerPipelineExecutionDetail | undefined,
): readonly PipelineStatusReason[] {
  return (detail?.statusReasons ?? []).map((reason) => ({
    id: reason.id,
    kind: reason.kind,
    code: reason.code,
    ...(reason.provider === undefined ? {} : { provider: reason.provider }),
    ...(reason.resetsAt === undefined ? {} : { resets_at: reason.resetsAt }),
  }));
}

/** The run's own report: a report its whole run saved, or else a step's. */
export function cloudRunReport(
  detail: WorkerPipelineExecutionDetail | undefined,
): WorkerPipelineArtifact | undefined {
  const reports = (detail?.artifacts ?? []).filter(
    (artifact) => artifact.kind === 'report',
  );
  return reports.find((artifact) => artifact.jobId === null) ?? reports[0];
}

export function cloudRunSummary(
  view: WorkerPipelineExecutionView,
): PipelineRunSummary {
  const { execution, detail } = view;
  const planId = detail?.plan?.planId ?? undefined;
  const rerunSourceId = detail?.initiation.rerunSourceId ?? undefined;
  return {
    id: execution.executionId,
    pipeline_id: execution.pipelineId,
    pipeline_name: execution.name,
    status: execution.status,
    status_reasons: cloudRunStatusReasons(detail),
    started_at: execution.startedAt,
    ...(planId === undefined ? {} : { planId }),
    ...(detail?.plan?.modified === true ? { plan_modified: true } : {}),
    ...(detail?.plan?.saved === true ? { has_plan: true } : {}),
    ...(cloudRunReport(detail) === undefined ? {} : { has_report: true }),
    ...(rerunSourceId === undefined ? {} : { rerun_source_id: rerunSourceId }),
    ...(execution.parentExecutionId === null
      ? {}
      : { parent_execution_id: execution.parentExecutionId }),
    ...(detail?.hidden === true ? { hidden: true } : {}),
  };
}

function stepResults(
  steps: readonly WorkerPipelineStepDetail[],
): PipelineRunJobResult['steps'] {
  return Object.fromEntries(
    steps.map((step) => [step.stepId, { status: step.status }]),
  );
}

/** The steps a logical job declares: its first physical run's. */
function declaredSteps(
  job: WorkerPipelineJobDetail,
): readonly WorkerPipelineStepDetail[] {
  return job.variants[0]?.steps ?? [];
}

/**
 * The execution state the DAG bar and the rerun gate read. The detail says
 * only whether a plan's or task's text was kept for a rerun, not the text;
 * the gate asks no more than that, so a kept text reads as present.
 */
export function cloudRunExecutionState(
  view: WorkerPipelineExecutionView,
): PipelineRunExecutionState | undefined {
  const { detail } = view;
  if (detail === undefined) return undefined;
  const jobs: Record<string, PipelineRunJobResult> = {};
  const groups: Record<string, PipelineRunJobGroup> = {};
  for (const job of detail.jobs) {
    for (const variant of job.variants)
      jobs[variant.jobId] = {
        status: variant.status,
        ...(variant.startedAt === null
          ? {}
          : { started_at: variant.startedAt }),
        ...(variant.completedAt === null
          ? {}
          : { completed_at: variant.completedAt }),
        steps: stepResults(variant.steps),
      };
    groups[job.jobId] = {
      kind: job.kind,
      status: job.status,
      variant_job_ids: job.variants.map((variant) => variant.jobId),
      ...(job.startedAt === null ? {} : { started_at: job.startedAt }),
      ...(job.completedAt === null ? {} : { completed_at: job.completedAt }),
      ...(job.maxParallel === null
        ? {}
        : { resolved_max_parallel: job.maxParallel }),
    };
  }
  const kept = 'kept for a rerun';
  return {
    pipeline_snapshot: {
      jobs: Object.fromEntries(
        detail.jobs.map((job) => [
          job.jobId,
          {
            name: job.name,
            needs: job.needs,
            steps: declaredSteps(job).map((step) => ({ id: step.stepId })),
          },
        ]),
      ),
    },
    jobs,
    job_groups: groups,
    ...(detail.initiation.event === null
      ? {}
      : { event_name: detail.initiation.event }),
    inputs_persisted: detail.rerun.inputsPersisted,
    rerun_context: {
      event_data: {
        ...(detail.rerun.planReadyText
          ? { plan_ready: { plan_text: kept } }
          : {}),
        ...(detail.rerun.taskReadyText
          ? { task_ready: { task_text: kept } }
          : {}),
      },
    },
    status_reasons: cloudRunStatusReasons(detail),
    pending_pauses: cloudRunPendingPauses(detail),
  };
}

function detailStep(step: WorkerPipelineStepDetail): PipelineRunDetailStep {
  return { step_id: step.stepId, name: step.name, status: step.status };
}

/** The checkpoints a resume may answer, in the shared pause form's shape. */
export function cloudRunPendingPauses(
  detail: WorkerPipelineExecutionDetail | undefined,
): readonly PipelineRunDetailPauseCheckpoint[] {
  return (detail?.pendingPauses ?? []).map((pause) => ({
    id: pause.id,
    kind: pause.kind,
    job_id: pause.jobId,
    logical_job_id: pause.logicalJobId,
    step_id: pause.stepId,
    ...(pause.requestUnavailableReason === undefined
      ? {}
      : { request_unavailable_reason: pause.requestUnavailableReason }),
    ...(pause.request === undefined
      ? {}
      : {
          request: {
            ...(pause.request.title === undefined
              ? {}
              : { title: pause.request.title }),
            ...(pause.request.message === undefined
              ? {}
              : { message: pause.request.message }),
            fields: pause.request.fields,
          },
        }),
  }));
}

/** The job tree the shared detail draws: a matrix job lists its variants. */
export function cloudRunDetailView(
  view: WorkerPipelineExecutionView,
): PipelineRunDetailView {
  const jobs: PipelineRunDetailJob[] = (view.detail?.jobs ?? []).map((job) =>
    job.kind === 'matrix'
      ? {
          job_id: job.jobId,
          name: job.name,
          status: job.status,
          steps: [],
          variants: job.variants.map((variant) => ({
            job_id: variant.jobId,
            name: variant.name,
            status: variant.status,
            steps: variant.steps.map(detailStep),
          })),
        }
      : {
          // A single job's one physical run has its own id, which its log
          // reads name.
          job_id: job.variants[0]?.jobId ?? job.jobId,
          name: job.name,
          status: job.status,
          steps: declaredSteps(job).map(detailStep),
        },
  );
  return {
    id: view.execution.executionId,
    pipeline_name: view.execution.name,
    jobs,
    pending_pauses: cloudRunPendingPauses(view.detail),
  };
}

/**
 * Whether a cloud run can be tried again in place. The web core refuses an
 * ended run's in-place retry, and matrix retries with it, until the run
 * supervisor can bring it back (CP-19); Start over is the retry until then.
 * In-place retry needs an ended run, so it is never offered yet.
 */
export const CLOUD_RUN_RETRIES_IN_PLACE = false;

/**
 * What a cloud run row can do, by the same gates a local run uses, less the
 * in-place retry the web core refuses (see `CLOUD_RUN_RETRIES_IN_PLACE`).
 */
export function cloudRunActions(
  view: WorkerPipelineExecutionView,
): readonly WorkflowRunAction[] {
  const summary = cloudRunSummary(view);
  const actions: WorkflowRunAction[] = [];
  if (canResumeExecution(summary)) actions.push('respond');
  if (isPipelineExecutionActiveStatus(summary.status)) actions.push('cancel');
  if (CLOUD_RUN_RETRIES_IN_PLACE && canRetryExecution(summary))
    actions.push('retry');
  if (
    canRerunExecution(summary) &&
    hasRerunReplayData(cloudRunExecutionState(view))
  )
    actions.push('rerun');
  return actions;
}

/** Why a run stopped, or what it is waiting for, in one line. */
function cloudRunRowDetail(
  view: WorkerPipelineExecutionView,
): string | undefined {
  const { execution, detail } = view;
  if (execution.status === 'paused')
    return compactPipelineStatusReasonLabel(cloudRunStatusReasons(detail));
  if (execution.status === 'failure' && execution.error !== null)
    return execution.error;
  return undefined;
}

const time = (value: string | null): number | undefined => {
  if (value === null) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/**
 * One cloud run as a Runs feed row. It ran in the cloud and, for now, in no
 * project: cloud runs start with No project only (CAN-6187).
 */
export function cloudWorkflowRunRow(
  view: WorkerPipelineExecutionView,
): WorkflowPipelineRunRow {
  const { execution, detail } = view;
  const rowDetail = cloudRunRowDetail(view);
  return {
    kind: 'pipeline',
    key: cloudWorkflowRunKey(execution.executionId),
    name: execution.name,
    status: workflowRunStatusFromPipeline(execution.status),
    starter: workflowRunStarterOf({
      initiator: detail?.initiation.initiator,
      event: detail?.initiation.event,
      hook: (detail?.initiation.hook ?? null) !== null,
      automationsAreScheduled: true,
    }),
    location: 'cloud',
    where: NO_PROJECT_LABEL,
    startedAt: time(execution.startedAt),
    endedAt: time(execution.completedAt),
    ...(rowDetail === undefined ? {} : { detail: rowDetail }),
    actions: cloudRunActions(view),
    result: { available: true },
    summary: cloudRunSummary(view),
  };
}

/** The cloud run a Runs feed row shows, or undefined for any other row. */
export function cloudExecutionIdOfRow(row: WorkflowRunRow): string | undefined {
  return row.kind === 'pipeline' && row.location === 'cloud'
    ? row.summary.id
    : undefined;
}

/**
 * Whether a cloud run has its own Runs feed row: a child run is listed
 * under its parent's detail, as a local one is, and a hidden run was
 * dismissed.
 */
export function isListedCloudRun(view: WorkerPipelineExecutionView): boolean {
  return (
    view.execution.parentExecutionId === null && view.detail?.hidden !== true
  );
}
