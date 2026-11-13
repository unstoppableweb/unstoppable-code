import type {
  PipelineDefinitionSummary,
  WorkerPipelineExecution,
  WorkerPipelineExecutionView,
} from '@canopy/protocol/canopy-core';
import type { WorkflowLastRun } from '@canopy/ui-shared/lib';
import { cloudRunEventName } from '@canopy/app-state/cloud-pipeline-runs';
import {
  describePipelineTriggers,
  describeRunUnavailable,
  pipelineTriggerKinds,
  type WorkflowLibraryRow,
} from '../workflow-library-model';

/**
 * A workflow a cloud run can use (CAN-6341), as a Workflows › Library row:
 * a curated one is built in, the account's own is yours, and one its teams
 * or organizations own is shared. Run opens the cloud Run dialog; a
 * workflow that only starts from a plan or a task can't be started there.
 */

const KEY_PREFIX = 'cloud-definition:';

export function cloudDefinitionLibraryKey(definitionId: string): string {
  return `${KEY_PREFIX}${definitionId}`;
}

/** The definition id a cloud Library row stands for, or undefined. */
export function cloudDefinitionIdOfRow(
  row: Pick<WorkflowLibraryRow, 'key'>,
): string | undefined {
  return row.key.startsWith(KEY_PREFIX)
    ? row.key.slice(KEY_PREFIX.length)
    : undefined;
}

function lastRunOf(execution: WorkerPipelineExecution): WorkflowLastRun {
  const at = Date.parse(execution.completedAt ?? execution.startedAt);
  const state: WorkflowLastRun['state'] =
    execution.status === 'success'
      ? 'success'
      : execution.status === 'failure'
        ? 'failure'
        : execution.status === 'cancelled'
          ? 'canceled'
          : 'running';
  return {
    state,
    ...(Number.isNaN(at) ? {} : { at }),
    ...(execution.error === null ? {} : { errorMessage: execution.error }),
  };
}

/**
 * Each workflow's newest listed cloud run, by definition id: a cloud run's
 * `pipelineId` is the definition it started from.
 */
export function cloudDefinitionLastRuns(
  views: readonly WorkerPipelineExecutionView[],
): ReadonlyMap<string, WorkflowLastRun> {
  const newest = new Map<string, WorkerPipelineExecution>();
  for (const { execution } of views) {
    const known = newest.get(execution.pipelineId);
    if (
      known === undefined ||
      Date.parse(execution.startedAt) > Date.parse(known.startedAt)
    )
      newest.set(execution.pipelineId, execution);
  }
  return new Map(
    [...newest].map(([definitionId, execution]) => [
      definitionId,
      lastRunOf(execution),
    ]),
  );
}

export function cloudDefinitionLibraryRow(
  summary: PipelineDefinitionSummary,
  /** The organization a shared row belongs to, for its source label. */
  organizationName: (organizationId: string) => string | undefined,
  /** Its newest cloud run, from {@link cloudDefinitionLastRuns}. */
  lastRun?: WorkflowLastRun,
): WorkflowLibraryRow {
  const triggers = pipelineTriggerKinds(summary.triggerTypes);
  const runnable = cloudRunEventName(summary) !== null;
  const organizationId = summary.owner?.startsWith('org:')
    ? summary.owner.slice('org:'.length)
    : undefined;
  const organization =
    organizationId === undefined ? undefined : organizationName(organizationId);
  return {
    key: cloudDefinitionLibraryKey(summary.definitionId),
    kind: 'pipeline',
    name: summary.name,
    triggers,
    triggerText: describePipelineTriggers(triggers),
    steps: [],
    summary: summary.description,
    source:
      summary.source === 'curated'
        ? 'built-in'
        : summary.owner === 'personal'
          ? 'mine'
          : 'shared',
    ...(organization === undefined
      ? {}
      : { sourceLabel: `Shared by ${organization}` }),
    ...(summary.updatedAt === null
      ? {}
      : { changedAt: Date.parse(summary.updatedAt) }),
    ...(lastRun === undefined ? {} : { lastRun }),
    // Run shows disabled, with why, for a workflow it can't start.
    ...(runnable
      ? { actions: ['run', 'view-runs'] }
      : {
          actions: ['view-runs'],
          runUnavailableLabel: describeRunUnavailable(triggers),
        }),
  };
}
