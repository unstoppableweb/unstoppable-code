import { randomUUID } from 'node:crypto';
import { createDesktopInstrumentationOperationKey } from '@canopy/desktop-instrumentation';
import {
  failDesktopOperation,
  startDesktopOperation,
  succeedDesktopOperation,
} from '@canopy/desktop-instrumentation/electron/main';
import type {
  DesktopInstrumentationContext,
  DesktopInstrumentationFailureReason,
} from '@canopy/desktop-instrumentation';
import type {
  IPCResult,
  PipelineTriggerType,
} from '@canopy/execution-engine/types/pipeline';
import type { ExecutionState } from '@canopy/execution-engine/node/pipelines/executor/types';
import { getExecutionRunDurationMs } from '@canopy/execution-engine/node/pipelines/executor';

const PIPELINE_CRUD_OPERATION_NAME = 'canopy.pipeline_crud';
const PIPELINE_EXECUTION_OPERATION_NAME = 'canopy.pipeline_execution';

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
