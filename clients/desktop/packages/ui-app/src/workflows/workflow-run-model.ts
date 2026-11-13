import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import type { CanopyCapabilities } from '@canopy/app-core';
import { isFeatureSurfaceAvailable } from '@canopy/app-core/gating';
import type { StatusGlyphState } from '@canopy/ui-shared/lib';
import {
  WORKFLOW_KIND_LABELS,
  type WorkflowKind,
} from '@canopy/ui-shared/lib/workflow-labels';
import type {
  PipelineRunStatus,
  PipelineRunSummary,
} from '../code/activity/pipeline/PipelineRunRows';
import { formatRunDuration } from './workflow-time';

/**
 * The Workflows Runs feed's row model (CAN-3981). Hosts project their own
 * sources into these rows: desktop from its execution, automation-run and
 * watcher stores, web from the paired desktop's pipeline runs. The feed never
 * infers one kind from another: an automation run is built from its own run
 * record even when it started a pipeline.
 */
export type WorkflowRunKind = WorkflowKind;

/** Where a run that belongs to no project shows it ran. */
export const NO_PROJECT_LABEL = 'No project';

/**
 * Which execution target a pipeline run ran on (CAN-6326): this computer or
 * the cloud, as the Run dialog's "Run on" names them.
 */
export type WorkflowRunLocation = 'local' | 'cloud';

export const WORKFLOW_RUN_LOCATION_LABELS: Readonly<
  Record<WorkflowRunLocation, string>
> = {
  local: 'This computer',
  cloud: 'Cloud',
};

export const WORKFLOW_RUN_KINDS: readonly WorkflowRunKind[] = [
  'automation',
  'pipeline',
  'watcher',
];

export const WORKFLOW_RUN_KIND_LABELS: Readonly<
  Record<WorkflowRunKind, string>
> = WORKFLOW_KIND_LABELS;

/** One automation run's outcome, normalized from the host's run status. */
export type WorkflowAutomationRunStatus =
  | 'running'
  | 'success'
  | 'failure'
  | 'skipped'
  | 'canceled'
  | 'missed';

/** A watcher's place in its life, from data the hosts already hold. */
export type WorkflowWatcherState =
  | 'watching'
  | 'firing'
  | 'fired'
  | 'delivery-failed';

/** The one status vocabulary the feed filters, sorts and draws by. */
export type WorkflowRunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'watching'
  | 'success'
  | 'failure'
  | 'skipped'
  | 'canceled'
  | 'missed'
  | 'fired'
  | 'delivery-failed';

export const WORKFLOW_RUN_STATUSES: readonly WorkflowRunStatus[] = [
  'running',
  'waiting',
  'watching',
  'queued',
  'success',
  'failure',
  'skipped',
  'canceled',
  'missed',
  'fired',
  'delivery-failed',
];

export const WORKFLOW_RUN_STATUS_LABELS: Readonly<
  Record<WorkflowRunStatus, string>
> = {
  queued: 'Queued',
  running: 'Running',
  waiting: 'Waiting for you',
  watching: 'Watching',
  success: 'Succeeded',
  failure: 'Failed',
  skipped: 'Skipped',
  canceled: 'Canceled',
  missed: 'Missed',
  fired: 'Fired',
  'delivery-failed': 'Delivery failed',
};

/** What started a run. `by:` search tokens use these ids. */
export type WorkflowRunStarter =
  | 'schedule'
  | 'catch-up'
  | 'run-now'
  | 'automation'
  | 'manual'
  | 'plan-approved'
  | 'task-ready'
  | 'workflow'
  | 'app-advisor'
  | 'remote-control'
  | 'chat'
  | 'hook';

export const WORKFLOW_RUN_STARTERS: readonly WorkflowRunStarter[] = [
  'schedule',
  'catch-up',
  'run-now',
  'automation',
  'manual',
  'plan-approved',
  'task-ready',
  'workflow',
  'app-advisor',
  'remote-control',
  'chat',
  'hook',
];

export const WORKFLOW_RUN_STARTER_LABELS: Readonly<
  Record<WorkflowRunStarter, string>
> = {
  schedule: 'Schedule',
  'catch-up': 'Catch-up',
  'run-now': 'Run now',
  // A pipeline run an automation started, when its summary doesn't say
  // whether a schedule or Run now did (the automation run's own row does).
  automation: 'Automation',
  manual: 'Manual',
  'plan-approved': 'Plan approved',
  'task-ready': 'Task ready',
  workflow: 'Workflow',
  'app-advisor': ORCHESTRATOR_LABEL,
  'remote-control': 'Remote Control',
  chat: 'Chat',
  hook: 'Hook',
};

/**
 * Actions a row can offer. `respond`, `cancel` and `retry` are the row's
 * button; the rest sit in its More menu. `hide` is offered only where the
 * host already keeps a per-run dismiss state. A host lists only what applies
 * to the row and what it can perform, so an action it cannot do is absent,
 * not disabled.
 */
export type WorkflowRunAction =
  | 'respond'
  | 'cancel'
  | 'retry'
  | 'rerun'
  | 'open-library'
  | 'open-workflow'
  | 'go-to-chat'
  | 'inspect'
  | 'hide';

export const WORKFLOW_RUN_ACTION_LABELS: Readonly<
  Record<WorkflowRunAction, string>
> = {
  respond: 'Respond',
  cancel: 'Cancel',
  retry: 'Try again',
  rerun: 'Rerun',
  'open-library': 'Open in Library',
  'open-workflow': 'Open workflow',
  'go-to-chat': 'Go to chat',
  inspect: 'Inspect',
  hide: 'Hide',
};

const PRIMARY_RUN_ACTIONS: readonly WorkflowRunAction[] = [
  'respond',
  'cancel',
  'retry',
];

/** Whether the row opens a result, and the reason shown when it cannot. */
export type WorkflowRunResult =
  | { readonly available: true }
  | { readonly available: false; readonly reason?: string };

interface WorkflowRunRowBase {
  /** Stable across refreshes; unique in the feed. */
  readonly key: string;
  readonly name: string;
  readonly status: WorkflowRunStatus;
  readonly starter?: WorkflowRunStarter;
  /**
   * Where a pipeline run ran. Hosts set it only while the feed can list cloud
   * runs, so a feed of one location doesn't say so on every row.
   */
  readonly location?: WorkflowRunLocation;
  /** Project and place, such as `storefront · new worktree`. */
  readonly where?: string;
  /** Epoch milliseconds. */
  readonly startedAt?: number;
  /** Epoch milliseconds; absent while the run is active. */
  readonly endedAt?: number;
  /** What this run did, or why it has no result. */
  readonly detail?: string;
  /** Recorded output a row without a result expands to show. */
  readonly output?: string;
  readonly actions: readonly WorkflowRunAction[];
  /** Key of this run's Library row, when it still has one. */
  readonly libraryRowKey?: string;
  readonly result: WorkflowRunResult;
}

export interface WorkflowAutomationRunRow extends WorkflowRunRowBase {
  readonly kind: 'automation';
  readonly runId: string;
  readonly activityId: string;
  /** The pipeline execution this run created and therefore owns. */
  readonly linkedExecutionId?: string;
  readonly cancellable: boolean;
}

export interface WorkflowPipelineRunRow extends WorkflowRunRowBase {
  readonly kind: 'pipeline';
  /** The shared summary both hosts already build; never a second shape. */
  readonly summary: PipelineRunSummary;
}

export interface WorkflowWatcherRunRow extends WorkflowRunRowBase {
  readonly kind: 'watcher';
  readonly watcherId: string;
  readonly state: WorkflowWatcherState;
  /** The chat the watcher reports to. */
  readonly subscriberLabel?: string;
}

export type WorkflowRunRow =
  | WorkflowAutomationRunRow
  | WorkflowPipelineRunRow
  | WorkflowWatcherRunRow;

/** Pipeline execution status → feed status. */
export function workflowRunStatusFromPipeline(
  status: PipelineRunStatus,
): WorkflowRunStatus {
  switch (status) {
    case 'pending':
      return 'queued';
    case 'running':
      return 'running';
    case 'paused':
      return 'waiting';
    case 'success':
      return 'success';
    case 'failure':
      return 'failure';
    case 'cancelled':
      return 'canceled';
  }
}

/**
 * Host automation run status → feed status. Unknown values read as a
 * failure so a status this build does not know never looks like a success.
 */
export function normalizeAutomationRunStatus(
  status: string,
): WorkflowAutomationRunStatus {
  switch (status) {
    case 'running':
    case 'pending':
    case 'queued':
      return 'running';
    case 'success':
    case 'succeeded':
    case 'completed':
      return 'success';
    case 'skipped':
      return 'skipped';
    case 'cancelled':
    case 'canceled':
      return 'canceled';
    case 'missed':
      return 'missed';
    default:
      return 'failure';
  }
}

export function workflowRunStatusFromWatcher(
  state: WorkflowWatcherState,
): WorkflowRunStatus {
  switch (state) {
    case 'watching':
      return 'watching';
    case 'firing':
      return 'running';
    case 'fired':
      return 'fired';
    case 'delivery-failed':
      return 'delivery-failed';
  }
}

/** Running, waiting for a response, or watching: the rows pinned on top. */
export function isActiveWorkflowRunStatus(status: WorkflowRunStatus): boolean {
  return (
    status === 'queued' ||
    status === 'running' ||
    status === 'waiting' ||
    status === 'watching'
  );
}

/**
 * Status → the shared status glyph. Waiting on the user is Needs you;
 * watching is still running; a fired watcher is done. A skipped, canceled or
 * missed run ended without an outcome and takes the Cancelled stop glyph.
 */
export function workflowRunStatusGlyphState(
  status: WorkflowRunStatus,
): StatusGlyphState {
  switch (status) {
    case 'queued':
      return 'queued';
    case 'running':
    case 'watching':
      return 'running';
    case 'waiting':
      return 'needs-you';
    case 'success':
    case 'fired':
      return 'done';
    case 'failure':
    case 'delivery-failed':
      return 'failed';
    case 'missed':
    case 'skipped':
    case 'canceled':
      return 'cancelled';
  }
}

/**
 * The Duration cell: elapsed time for a finished run, otherwise the word for
 * where the run stands (`running`, `watching`, `skipped`).
 */
export function workflowRunDurationLabel(row: WorkflowRunRow): string {
  switch (row.status) {
    case 'queued':
      return 'queued';
    case 'running':
      return 'running';
    case 'watching':
      return 'watching';
    case 'skipped':
      return 'skipped';
    case 'missed':
      return 'missed';
    case 'fired':
      return 'fired';
    case 'delivery-failed':
      return 'not delivered';
    case 'waiting':
    case 'success':
    case 'failure':
    case 'canceled':
      break;
  }
  if (row.startedAt !== undefined && row.endedAt !== undefined) {
    const label = formatRunDuration(row.endedAt - row.startedAt);
    if (label) return label;
  }
  if (row.status === 'canceled') return 'canceled';
  if (row.status === 'waiting') return 'waiting';
  return '';
}

/** The Where cell: the run's location, then its project and place. */
export function workflowRunWhereLabel(row: WorkflowRunRow): string {
  return [
    row.location === undefined
      ? undefined
      : WORKFLOW_RUN_LOCATION_LABELS[row.location],
    row.where,
  ]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(' · ');
}

/** The action drawn as the row's button, if any. */
export function primaryWorkflowRunAction(
  actions: readonly WorkflowRunAction[],
): WorkflowRunAction | undefined {
  return PRIMARY_RUN_ACTIONS.find((action) => actions.includes(action));
}

/** The actions left for the row's More menu, in menu order. */
export function menuWorkflowRunActions(
  actions: readonly WorkflowRunAction[],
): readonly WorkflowRunAction[] {
  const primary = primaryWorkflowRunAction(actions);
  const order: readonly WorkflowRunAction[] = [
    'inspect',
    'open-workflow',
    'open-library',
    'rerun',
    'retry',
    'respond',
    'go-to-chat',
    'hide',
    'cancel',
  ];
  return order.filter(
    (action) => action !== primary && actions.includes(action),
  );
}

/**
 * Active rows first, then newest first. Rows without a start time sort last
 * within their group; ties keep a stable order by key.
 */
export function sortWorkflowRunRows(
  rows: readonly WorkflowRunRow[],
): readonly WorkflowRunRow[] {
  return [...rows].sort((a, b) => {
    const activeA = isActiveWorkflowRunStatus(a.status);
    const activeB = isActiveWorkflowRunStatus(b.status);
    if (activeA !== activeB) return activeA ? -1 : 1;
    const startedA = a.startedAt ?? Number.NEGATIVE_INFINITY;
    const startedB = b.startedAt ?? Number.NEGATIVE_INFINITY;
    if (startedA !== startedB) return startedB - startedA;
    return a.key.localeCompare(b.key);
  });
}

/** The Runs tab count: rows that are running, waiting or watching. */
export function countActiveWorkflowRuns(
  rows: readonly WorkflowRunRow[],
): number {
  return rows.filter((row) => isActiveWorkflowRunStatus(row.status)).length;
}

/** The run kinds this host can show, for the Kind filter's options. */
export function availableWorkflowRunKinds(
  capabilities: CanopyCapabilities,
): readonly WorkflowRunKind[] {
  return WORKFLOW_RUN_KINDS.filter((kind) => {
    if (kind === 'automation') {
      return isFeatureSurfaceAvailable(capabilities, 'workflow-automations');
    }
    if (kind === 'watcher') {
      return isFeatureSurfaceAvailable(capabilities, 'workflow-watchers');
    }
    return true;
  });
}
