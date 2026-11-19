import { parseShareFailure } from '@canopy/protocol/sharing';
import { randomUUID } from 'node:crypto';
import { createDesktopInstrumentationOperationKey } from '@canopy/desktop-instrumentation';
import {
  failDesktopOperation,
  reportMainAppError,
  startDesktopOperation,
  succeedDesktopOperation,
} from '@canopy/desktop-instrumentation/electron/main';
import { createAppError } from '@canopy/protocol/app-errors';
import type {
  DesktopInstrumentationContext,
  DesktopInstrumentationFailureReason,
} from '@canopy/desktop-instrumentation';
import type {
  ExecutionFailureCode,
  IPCResult,
  PipelineTriggerType,
  StepResult,
} from '@canopy/execution-engine/types/pipeline';
import type {
  ExecutionState,
  NormalizedStep,
  PipelineEngineErrorSite,
} from '@canopy/execution-engine/node/pipelines/executor/types';
import { getExecutionRunDurationMs } from '@canopy/execution-engine/node/pipelines/executor';
import {
  isExecutionFailureCode,
  isExecutionFailureOrigin,
} from '@canopy/execution-engine/node/pipelines/executor/execution-failure';
import {
  PIPELINE_HOST_FAILURE_REASON_OUTPUT,
  PIPELINE_HOST_FAILURE_REASONS,
  type PipelineHostFailureReason,
} from '@canopy/execution-engine/pipelines/host-actions';

const PIPELINE_CRUD_OPERATION_NAME = 'canopy.pipeline_crud';
const PIPELINE_EXECUTION_OPERATION_NAME = 'canopy.pipeline_execution';
const PIPELINE_STATE_SAVE_ERROR_SOURCE = 'pipeline.execution_state_save';
const PIPELINE_ENGINE_ERROR_SOURCE = 'pipeline.engine';

export type PipelineCrudAction =
  | 'list'
  | 'discover'
  | 'get'
  | 'create'
  | 'update'
  | 'delete'
  | 'duplicate'
  | 'shared_list'
  | 'shared_get'
  | 'shared_create'
  | 'shared_update'
  | 'shared_delete';

export interface PipelineCrudTelemetryContext {
  action: PipelineCrudAction;
  source?: 'bundled' | 'user' | 'project' | 'shared' | 'curated' | 'unknown';
  hasPipelineId?: boolean;
  hasProjectContext?: boolean;
  hasSearchQuery?: boolean;
  triggerType?: PipelineTriggerType;
  shareScope?: string;
}

function mapStatusToFailureReason(
  status: ExecutionState['status'] | 'failure',
): DesktopInstrumentationFailureReason {
  if (status === 'failure') {
    return 'error';
  }
  if (status === 'cancelled') {
    return 'abandoned';
  }
  return 'other';
}

function countPipelineSteps(state: ExecutionState): number {
  return Object.values(state.pipeline_snapshot.jobs).reduce(
    (total, job) => total + job.steps.length,
    0,
  );
}

function getPipelineSource(
  state: ExecutionState,
): 'bundled' | 'user' | 'file' | 'shared' | 'curated' | 'inline' {
  if (state.shared_pipeline_source) {
    return 'shared';
  }
  if (state.pipeline_preference_locator?.type === 'stored') {
    return state.pipeline_preference_locator.source;
  }
  if (state.pipeline_preference_locator?.type === 'file') {
    return 'file';
  }
  return 'inline';
}

function buildExecutionContext(
  state: ExecutionState,
): DesktopInstrumentationContext {
  const jobs = Object.values(state.jobs);
  return {
    status: state.status,
    trigger_type: state.event_name ?? 'dispatch',
    pipeline_source: getPipelineSource(state),
    job_count: Object.keys(state.pipeline_snapshot.jobs).length,
    step_count: countPipelineSteps(state),
    plugin_collection_count: Object.keys(
      state.resolved_plugin_collections ?? {},
    ).length,
    has_project_context: Boolean(state.project_id && state.worktree_id),
    has_parent_execution: Boolean(state.parent_execution_id),
    is_rerun: Boolean(state.rerun_source_id),
    paused_job_count: jobs.filter((job) => job.status === 'paused').length,
    failed_job_count: jobs.filter((job) => job.conclusion === 'failure').length,
    cancelled_job_count: jobs.filter((job) => job.conclusion === 'cancelled')
      .length,
    skipped_job_count: jobs.filter((job) => job.conclusion === 'skipped')
      .length,
    // Working time with whole-run pauses excluded, matching the run duration
    // the UI and usage events report.
    duration_ms:
      state.completed_at !== undefined
        ? getExecutionRunDurationMs(state)
        : undefined,
    // A closed code only, never the save error's text (CAN-7095).
    persist_failure_code: state.persist_failure_code,
    ...buildFailureContext(state),
  };
}

const HOST_FAILURE_REASONS: ReadonlySet<string> = new Set(
  PIPELINE_HOST_FAILURE_REASONS,
);

function isHostFailureReason(
  value: unknown,
): value is PipelineHostFailureReason {
  return typeof value === 'string' && HOST_FAILURE_REASONS.has(value);
}

/** The run's earliest-ended failed step, with its definition when known. */
function firstFailedStep(
  state: ExecutionState,
): { step: StepResult; definition: NormalizedStep | undefined } | undefined {
  let first:
    | { step: StepResult; definition: NormalizedStep | undefined }
    | undefined;
  for (const [jobId, job] of Object.entries(state.jobs)) {
    for (const [stepId, step] of Object.entries(job.steps)) {
      if (step.status !== 'failure') continue;
      if (
        first !== undefined &&
        (step.completed_at === undefined ||
          (first.step.completed_at !== undefined &&
            first.step.completed_at <= step.completed_at))
      )
        continue;
      const definition = (
        state.job_definitions[jobId] ?? state.pipeline_snapshot.jobs[jobId]
      )?.steps.find((candidate) => candidate.id === stepId);
      first = { step, definition };
    }
  }
  return first;
}

/** What kind of step failed, as a closed value. */
function failedStepKind(
  step: StepResult,
  definition: NormalizedStep | undefined,
): 'run' | 'agent' | 'pipeline' | 'builtin' | 'action' | undefined {
  if (definition?.run !== undefined) return 'run';
  if (step.agent_provider !== undefined) return 'agent';
  const uses = definition?.uses;
  if (uses === undefined) return undefined;
  if (uses === 'builtin/run-pipeline') return 'pipeline';
  return uses.startsWith('builtin/') ? 'builtin' : 'action';
}

/**
 * Why the run failed, in closed values only (CAN-7118): the engine's own
 * failure when it threw, else its first failed step's origin and code, that
 * step's typed host failure reason and its kind. Never an error's text.
 */
function buildFailureContext(
  state: ExecutionState,
): DesktopInstrumentationContext {
  const failed = firstFailedStep(state);
  const engineFailed = state.failure_origin !== undefined;
  const origin = engineFailed
    ? state.failure_origin
    : failed && (failed.step.failure_origin ?? 'step');
  const code = engineFailed ? state.failure_code : failed?.step.failure_code;
  const reason = failed?.step.outputs[PIPELINE_HOST_FAILURE_REASON_OUTPUT];
  return {
    failure_origin: isExecutionFailureOrigin(origin) ? origin : undefined,
    failure_code: isExecutionFailureCode(code) ? code : undefined,
    failed_step_failure_reason: isHostFailureReason(reason)
      ? reason
      : undefined,
    failed_step_kind: failed && failedStepKind(failed.step, failed.definition),
  };
}

function getExecutionOperationKey(executionId: string): string {
  return createDesktopInstrumentationOperationKey(`pipeline:${executionId}`);
}

function getEphemeralOperationKey(action: PipelineCrudAction): string {
  return createDesktopInstrumentationOperationKey(
    `pipeline-crud:${action}:${randomUUID()}`,
  );
}

function buildCrudContext(
  context: PipelineCrudTelemetryContext,
): DesktopInstrumentationContext {
  return {
    action: context.action,
    source: context.source,
    has_pipeline_id: context.hasPipelineId,
    has_project_context: context.hasProjectContext,
    has_search_query: context.hasSearchQuery,
    trigger_type: context.triggerType,
    share_scope: context.shareScope,
  };
}

function getResultCount(result: unknown): number | undefined {
  if (
    typeof result !== 'object' ||
    result === null ||
    !('success' in result) ||
    result.success !== true ||
    !('data' in result)
  ) {
    return undefined;
  }

  const { data } = result;
  if (Array.isArray(data)) {
    return data.length;
  }
  if (typeof data === 'object' && data !== null && 'data' in data) {
    const nestedData = data.data;
    return Array.isArray(nestedData) ? nestedData.length : undefined;
  }
  return undefined;
}

function shareFailureTelemetryContext(
  result: unknown,
): DesktopInstrumentationContext {
  try {
    if (
      typeof result !== 'object' ||
      result === null ||
      !('success' in result) ||
      result.success !== false ||
      !('failure' in result)
    )
      return {};
    const failure = parseShareFailure(result.failure);
    return failure
      ? {
          share_failure_kind: failure.kind,
          share_failure_stage: failure.stage,
        }
      : {};
  } catch {
    // Enrichment must not replace an operation's result with a telemetry error.
    return {};
  }
}

export async function withPipelineCrudTelemetry<T>(
  context: PipelineCrudTelemetryContext,
  operation: () => T | Promise<T>,
): Promise<T> {
  const operationKey = getEphemeralOperationKey(context.action);
  const baseContext = buildCrudContext(context);
  startDesktopOperation(PIPELINE_CRUD_OPERATION_NAME, {
    operationKey,
    context: baseContext,
  });

  try {
    const result = await operation();
    const failed =
      typeof result === 'object' &&
      result !== null &&
      'success' in result &&
      result.success === false;
    const resultContext: DesktopInstrumentationContext = {
      ...baseContext,
      status: failed ? 'failure' : 'success',
      result_count: getResultCount(result),
      ...shareFailureTelemetryContext(result),
    };
    if (failed) {
      failDesktopOperation(PIPELINE_CRUD_OPERATION_NAME, 'error', {
        operationKey,
        context: resultContext,
      });
    } else {
      succeedDesktopOperation(PIPELINE_CRUD_OPERATION_NAME, {
        operationKey,
        context: resultContext,
      });
    }
    return result;
  } catch (error) {
    failDesktopOperation(PIPELINE_CRUD_OPERATION_NAME, 'error', {
      operationKey,
      context: {
        ...baseContext,
        status: 'failure',
      },
    });
    throw error;
  }
}

export function withPipelineCrudTelemetrySync<T extends IPCResult<unknown>>(
  context: PipelineCrudTelemetryContext,
  operation: () => T,
): T {
  const operationKey = getEphemeralOperationKey(context.action);
  const baseContext = buildCrudContext(context);
  startDesktopOperation(PIPELINE_CRUD_OPERATION_NAME, {
    operationKey,
    context: baseContext,
  });

  try {
    const result = operation();
    const resultContext: DesktopInstrumentationContext = {
      ...baseContext,
      status: result.success ? 'success' : 'failure',
      result_count: getResultCount(result),
      ...shareFailureTelemetryContext(result),
    };
    if (result.success) {
      succeedDesktopOperation(PIPELINE_CRUD_OPERATION_NAME, {
        operationKey,
        context: resultContext,
      });
    } else {
      failDesktopOperation(PIPELINE_CRUD_OPERATION_NAME, 'error', {
        operationKey,
        context: resultContext,
      });
    }
    return result;
  } catch (error) {
    failDesktopOperation(PIPELINE_CRUD_OPERATION_NAME, 'error', {
      operationKey,
      context: {
        ...baseContext,
        status: 'failure',
      },
    });
    throw error;
  }
}

export function startPipelineExecutionTelemetry(state: ExecutionState): void {
  startDesktopOperation(PIPELINE_EXECUTION_OPERATION_NAME, {
    operationKey: getExecutionOperationKey(state.id),
    context: buildExecutionContext(state),
  });
}

export function finishPipelineExecutionTelemetry(state: ExecutionState): void {
  const context = buildExecutionContext(state);
  const operationKey = getExecutionOperationKey(state.id);

  if (state.status === 'success') {
    succeedDesktopOperation(PIPELINE_EXECUTION_OPERATION_NAME, {
      operationKey,
      context,
    });
    return;
  }

  failDesktopOperation(
    PIPELINE_EXECUTION_OPERATION_NAME,
    mapStatusToFailureReason(state.status),
    {
      operationKey,
      context,
    },
  );
}

/**
 * Stands in for the save's own error, which is gone by the time its run
 * settles. Its text is fixed, and only its V8 frames leave the app.
 */
class PipelineStateSaveError extends Error {
  constructor() {
    super("Couldn't save a pipeline run's state");
    this.name = 'PipelineStateSaveError';
  }
}

/**
 * Reports a settled run whose state a save could not write (CAN-7095) as one
 * app error. It carries the closed code only, as its source and status: the
 * save's error is gone by now, and its text, the run's error and its paths
 * never leave. The frames are this report's own, so the error is told apart
 * from other unexpected failures. A run whose saves all landed reports
 * nothing, and neither does one the store refused because another owner holds
 * it or this runner's lease ended: that owner's saved state stands (CAN-6198).
 */
export function reportPipelinePersistFailure(state: ExecutionState): void {
  const code = state.persist_failure_code;
  if (
    code === undefined ||
    code === 'write_refused_owned_by_other_process' ||
    code === 'write_refused_owner_fenced'
  )
    return;
  try {
    const nativeError = new PipelineStateSaveError();
    reportMainAppError(
      createAppError(
        code === 'ENOSPC' || code === 'EDQUOT'
          ? 'external.disk_full'
          : 'app.unexpected',
        {
          source: `${PIPELINE_STATE_SAVE_ERROR_SOURCE}:${code}`,
          detail: {
            name: nativeError.name,
            message: nativeError.message,
            status: code,
          },
        },
      ),
      { nativeError },
    );
  } catch {
    // Reporting never changes how the run settles.
  }
}

/**
 * Stands in for an engine or host-port error the run met (CAN-7118). Its
 * text is fixed, and only its V8 frames leave the app.
 */
class PipelineEngineError extends Error {
  constructor() {
    super('A pipeline run met an internal error');
    this.name = 'PipelineEngineError';
  }
}

/**
 * Reports an error the pipeline engine absorbed or failed a run with
 * (CAN-7118) as one app error. It carries the closed site and code only, as
 * its source and status: the error itself, its message and the run's paths
 * never leave. The frames are this report's own, as for a failed save.
 */
export function reportPipelineEngineError(
  _error: unknown,
  context: {
    readonly site: PipelineEngineErrorSite;
    readonly code: ExecutionFailureCode;
  },
): void {
  try {
    const { site, code } = context;
    const nativeError = new PipelineEngineError();
    reportMainAppError(
      createAppError(
        code === 'ENOSPC' || code === 'EDQUOT'
          ? 'external.disk_full'
          : 'app.unexpected',
        {
          source: `${PIPELINE_ENGINE_ERROR_SOURCE}.${site}:${code}`,
          detail: {
            name: nativeError.name,
            message: nativeError.message,
            status: code,
          },
        },
      ),
      { nativeError },
    );
  } catch {
    // Reporting never changes how the run goes.
  }
}
