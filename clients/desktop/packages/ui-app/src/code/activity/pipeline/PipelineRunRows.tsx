'use client';

import { type JSX, type ReactNode } from 'react';
import { CHAT_UNIT_LABEL, ORCHESTRATOR_LABEL } from '@canopy/protocol';
import {
  Badge,
  Button,
  DagProgressBar,
  ExecutionActionButton,
  PauseResumeIcon,
  PipelineDispatchedTime,
  type DagJobMeta,
  type DagJobStatus,
} from '@canopy/ui-shared/components';
import {
  canResumeExecution,
  canRetryExecution,
  canRerunExecution,
  compactPipelineStatusReasonLabel,
  computeDagTiers,
  hasRerunReplayData,
  statusBadgeClassName,
  statusBadgeTone,
  type BadgeTone,
  type ExecutionTreeNode,
  type PipelineStatusReason,
  type StatusBadgeTone,
} from '@canopy/ui-shared/lib';
import {
  ChevronIcon,
  EyeIcon,
  EyeOffIcon,
  PipelineIcon,
  PlanModeIcon,
  RerunIcon,
  RetryIcon,
} from '@canopy/ui-shared/icons';
import {
  MessageIcon as AppCatalogMessageIcon,
  FileIcon as AppCatalogFileIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  HookTriggerIndicator,
  type PipelineHookTriggerSource,
} from './PipelineQueuedCards';
import { Surface } from '@canopy/ui-shared/components';

export type PipelineRunStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'success'
  | 'failure'
  | 'cancelled';

export interface PipelineRunSummary {
  readonly id: string;
  readonly pipeline_id: string;
  readonly pipeline_name: string;
  readonly status: PipelineRunStatus;
  readonly status_reasons: readonly PipelineStatusReason[];
  readonly started_at: string;
  readonly project_id?: string;
  readonly worktree_id?: string;
  readonly planId?: string;
  readonly plan_modified?: boolean;
  readonly has_plan?: boolean;
  readonly has_report?: boolean;
  readonly rerun_source_id?: string;
  readonly parent_execution_id?: string;
  readonly hidden?: boolean;
  readonly trigger_source?: PipelineHookTriggerSource;
}

export interface PipelineRunJobDefinition {
  readonly name?: string;
  readonly needs: readonly string[];
  readonly steps: readonly { readonly id: string }[];
}

/**
 * The result shape needed to render one physical matrix variant.
 */
export interface PipelineRunJobResult {
  readonly status: string;
  readonly started_at?: string;
  readonly completed_at?: string;
  readonly steps: Readonly<
    Record<
      string,
      {
        readonly status: string;
      }
    >
  >;
}

export interface PipelineRunJobGroup {
  readonly kind: 'single' | 'matrix';
  readonly status: string;
  readonly variant_job_ids: readonly string[];
  readonly started_at?: string;
  readonly completed_at?: string;
  readonly resolved_max_parallel?: number;
}

const TERMINAL_VARIANT_STATUSES = new Set([
  'success',
  'failure',
  'cancelled',
  'skipped',
]);

/** `3 / 5 complete` for a matrix job, or `undefined` for ordinary jobs. */
function getMatrixVariantProgress(
  group: PipelineRunJobGroup | undefined,
  jobs: Readonly<Record<string, PipelineRunJobResult>>,
): string | undefined {
  if (group?.kind !== 'matrix') return undefined;
  const complete = group.variant_job_ids.filter((id) =>
    TERMINAL_VARIANT_STATUSES.has(jobs[id]?.status),
  ).length;
  return `${String(complete)} / ${String(group.variant_job_ids.length)} complete`;
}

/**
 * `3 succeeded · 1 failed · 1 running`.
 *
 * Counts read the actual **outcome** where it disagrees with status, so a
 * `continue_on_error` fan-out never reports its failed children as clean.
 */
function getMatrixVariantBreakdown(
  group: PipelineRunJobGroup | undefined,
  jobs: Readonly<Record<string, PipelineRunJobResult>>,
): string | undefined {
  if (group?.kind !== 'matrix' || group.variant_job_ids.length === 0) {
    return undefined;
  }
  const BUCKETS: Readonly<Record<string, string>> = {
    success: 'succeeded',
    failure: 'failed',
    running: 'running',
    restarting: 'running',
    paused: 'paused',
    queued: 'queued',
    waiting_for_capacity: 'queued',
    pending: 'queued',
    skipped: 'skipped',
    cancelled: 'cancelled',
  };
  const ORDER = [
    'succeeded',
    'failed',
    'running',
    'paused',
    'queued',
    'skipped',
    'cancelled',
  ];
  const counts = new Map<string, number>();
  for (const id of group.variant_job_ids) {
    const status = jobs[id]?.status;
    if (!status) continue;
    const label = BUCKETS[status];
    if (label === undefined) continue;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const parts = ORDER.filter((label) => (counts.get(label) ?? 0) > 0).map(
    (label) => `${String(counts.get(label))} ${label}`,
  );
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function toDagJobStatus(status: string | undefined): DagJobStatus | undefined {
  switch (status) {
    case 'pending':
    case 'running':
    case 'restarting':
    case 'success':
    case 'failure':
    case 'paused':
    case 'cancelled':
    case 'skipped':
      return status;
    default:
      return undefined;
  }
}

export interface PipelineRunExecutionState {
  readonly pipeline_snapshot: {
    readonly jobs: Readonly<Record<string, PipelineRunJobDefinition>>;
  };
  readonly jobs: Readonly<Record<string, PipelineRunJobResult>>;
  readonly job_groups: Readonly<Record<string, PipelineRunJobGroup>>;
  readonly event_name?: string;
  readonly inputs_persisted?: boolean;
  readonly rerun_context?: {
    readonly event_data?: {
      readonly task_ready?: { readonly task_text?: string };
      readonly plan_ready?: { readonly plan_text?: string };
    };
  };
  readonly trigger_source?: PipelineHookTriggerSource;
  readonly status_reasons?: readonly PipelineStatusReason[];
  readonly pending_pauses?: readonly {
    readonly id: string;
    readonly kind: 'input' | 'action';
    readonly job_id: string;
    readonly logical_job_id: string;
    readonly step_id: string;
    readonly request?: {
      readonly title?: string;
      readonly message?: string;
      readonly fields: readonly unknown[];
    };
  }[];
}

export interface PipelineRunPauseResponse {
  readonly checkpoint_id: string;
  readonly job_id: string;
  readonly step_id: string;
  readonly answers?: Readonly<Record<string, string | number | boolean>>;
}

export interface PipelineRunBreadcrumbEntry {
  readonly executionId: string;
  readonly label: string;
}

export type PipelineRunRenderSlot = (run: PipelineRunSummary) => ReactNode;

/**
 * Exported so the shared run DETAIL gates its Cancel chip on the same
 * predicate the rows do, rather than minting a third copy (desktop has one).
 */
export function isPipelineExecutionActiveStatus(
  status: PipelineRunStatus,
): boolean {
  return status === 'pending' || status === 'running' || status === 'paused';
}

/**
 * Execution status → shared status-badge tone. `pending` is a muted paused
 * chip so a queued run reads quieter than a paused one.
 */
function getPipelineExecutionStatusBadgeTone(status: PipelineRunStatus): {
  tone: StatusBadgeTone;
  muted: boolean;
} {
  switch (status) {
    case 'running':
      return { tone: 'active', muted: false };
    case 'success':
      return { tone: 'success', muted: false };
    case 'failure':
      return { tone: 'failed', muted: false };
    case 'cancelled':
    case 'paused':
      return { tone: 'paused', muted: false };
    default:
      return { tone: 'paused', muted: true };
  }
}

export function getPipelineExecutionStatusBadgeClassName(
  status: PipelineRunStatus,
): string {
  const { tone, muted } = getPipelineExecutionStatusBadgeTone(status);
  return statusBadgeClassName(tone, { muted });
}

/**
 * The execution status at the head of a run row, as the shared `Badge`'s
 * tone and quiet state; the badge's label is the raw status. Completed rows
 * pass `muted` to quiet it beside their deemphasized timestamp.
 */
export function pipelineRunStatusBadge(
  status: PipelineRunStatus,
  options: { readonly muted?: boolean } = {},
): { tone: BadgeTone; muted: boolean } {
  const { tone, muted } = getPipelineExecutionStatusBadgeTone(status);
  return {
    tone: statusBadgeTone(tone),
    muted: options.muted === true || muted,
  };
}

function getStepProgress(
  jobResult: PipelineRunJobResult | undefined,
  jobDefinition: PipelineRunJobDefinition,
): string | undefined {
  if (!jobResult) return undefined;
  const total = jobDefinition.steps.length;
  if (total === 0) return undefined;
  let completed = 0;
  for (const step of jobDefinition.steps) {
    const status = jobResult.steps[step.id]?.status;
    if (
      status === 'success' ||
      status === 'failure' ||
      status === 'cancelled' ||
      status === 'skipped'
    ) {
      completed++;
    }
  }
  return `${completed}/${total}`;
}

/** A run's jobs as the DAG progress bar draws them, from its execution state. */
export function pipelineRunDag(executionState: PipelineRunExecutionState): {
  tiers: string[][];
  jobs: Record<string, DagJobMeta>;
} {
  const jobDefinitions = executionState.pipeline_snapshot.jobs;
  const jobs: Record<string, DagJobMeta> = {};
  for (const [jobId, jobDefinition] of Object.entries(jobDefinitions)) {
    const group = executionState.job_groups?.[jobId];
    const result = executionState.jobs[group?.variant_job_ids[0] ?? jobId];
    jobs[jobId] = {
      jobId,
      name: jobDefinition.name ?? jobId,
      status: toDagJobStatus(group?.status ?? result?.status),
      startedAt: group?.started_at ?? result?.started_at,
      completedAt: group?.completed_at ?? result?.completed_at,
      stepProgress:
        group?.kind === 'matrix'
          ? undefined
          : getStepProgress(result, jobDefinition),
      variantProgress: getMatrixVariantProgress(group, executionState.jobs),
      variantBreakdown: getMatrixVariantBreakdown(group, executionState.jobs),
      maxParallel: group?.resolved_max_parallel,
    };
  }
  return { tiers: computeDagTiers(jobDefinitions), jobs };
}

export function PipelineRunDagProgressBar({
  executionState,
  muted = false,
  onJobClick = (): void => undefined,
}: {
  executionState: PipelineRunExecutionState;
  muted?: boolean;
  onJobClick?: (jobId: string) => void;
}): JSX.Element {
  const { tiers, jobs } = pipelineRunDag(executionState);
  return (
    <DagProgressBar
      tiers={tiers}
      jobs={jobs}
      muted={muted}
      onJobClick={onJobClick}
    />
  );
}

export function RerunLineageLabel({
  summary,
  summaryLookup,
  onOpenSource,
}: {
  summary: Pick<PipelineRunSummary, 'rerun_source_id'>;
  summaryLookup: Readonly<Record<string, PipelineRunSummary>>;
  onOpenSource: (executionId: string) => void;
}): JSX.Element | null {
  const sourceId = summary.rerun_source_id;
  if (!sourceId) return null;
  const sourceSummary = summaryLookup[sourceId];
  const label = sourceSummary?.pipeline_name ?? sourceId.slice(0, 8);
  return (
    <ExecutionActionButton
      label={`Started over from ${label}`}
      ariaLabel={`Started over from ${label}`}
      onClick={(): void => onOpenSource(sourceId)}
      className="mt-1"
    />
  );
}

export function SubPipelineButton({
  count,
  expanded,
  onClick,
}: {
  count: number;
  expanded: boolean;
  onClick: () => void;
}): JSX.Element {
  const subPipelineLabel = `${count} sub-workflow${count !== 1 ? 's' : ''}`;
  return (
    <ExecutionActionButton
      label={subPipelineLabel}
      ariaLabel={subPipelineLabel}
      icon={<ChevronIcon open={expanded} />}
      onClick={onClick}
      className="mt-1.5"
    />
  );
}

export function FollowUpButton({
  label,
  icon,
  onClick,
  disabled = false,
  dataTestId,
}: {
  label: string;
  icon: JSX.Element;
  onClick: () => void;
  disabled?: boolean;
  dataTestId?: string;
}): JSX.Element {
  return (
    <ExecutionActionButton
      label={label}
      ariaLabel={label}
      icon={icon}
      onClick={onClick}
      disabled={disabled}
      dataTestId={dataTestId}
    />
  );
}

export interface ActiveRunRowProps {
  summary: PipelineRunSummary;
  executionState?: PipelineRunExecutionState;
  cancellingId: string | null;
  resumingId: string | null;
  mutationPending?: boolean;
  onOpenDetail: () => void;
  /** Hosts that cannot cancel omit it, and the Cancel chip is not rendered. */
  onCancel?: (id: string) => void;
  /** Optional like `onCancel`: absent hides the Resume chip. */
  onResume?: (id: string, pauseResponses?: PipelineRunPauseResponse[]) => void;
  onJobClick: (jobId: string) => void;
  /** Optional like `onCancel`: absent hides the plan chip. */
  onOpenPlan?: (executionId: string) => void;
  summaryLookup: Readonly<Record<string, PipelineRunSummary>>;
  onOpenSource: (executionId: string) => void;
  renderAdvisorBadge?: PipelineRunRenderSlot;
  renderWatcherButton?: PipelineRunRenderSlot;
  childrenSection?: ReactNode;
}

export function ActiveRunRow({
  summary,
  executionState,
  cancellingId,
  resumingId,
  mutationPending = false,
  onOpenDetail,
  onCancel,
  onResume,
  onJobClick,
  onOpenPlan,
  summaryLookup,
  onOpenSource,
  renderAdvisorBadge,
  renderWatcherButton,
  childrenSection,
}: ActiveRunRowProps): JSX.Element {
  const hookTriggerSource =
    summary.trigger_source ?? executionState?.trigger_source;
  const inputRequested =
    executionState?.pending_pauses?.some(
      (checkpoint) => checkpoint.kind === 'input',
    ) === true;
  const canResumeFromPreview =
    summary.status === 'paused' &&
    executionState !== undefined &&
    !inputRequested;
  return (
    <Surface variant="group" interactive padding="compact">
      <div
        role="button"
        tabIndex={0}
        data-testid={`pipeline-run-card-${summary.id}`}
        className="cursor-pointer"
        onClick={onOpenDetail}
        onKeyDown={(event): void => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onOpenDetail();
          }
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge {...pipelineRunStatusBadge(summary.status)}>
                {summary.status}
              </Badge>
              <PipelineDispatchedTime
                startedAt={summary.started_at}
                testId={`pipeline-run-dispatched-${summary.id}`}
              />
              <HookTriggerIndicator triggerSource={hookTriggerSource} />
              {summary.plan_modified === true && (
                <Badge tone="special">Plan updated</Badge>
              )}
              {inputRequested && (
                <Badge tone="warning" aria-label="Workflow input required">
                  Input required
                </Badge>
              )}
              {renderAdvisorBadge?.(summary)}
              {renderWatcherButton?.(summary)}
            </div>
            <div className="mt-1 truncate text-xs font-medium fg-primary/80">
              {summary.pipeline_name}
            </div>
            <RerunLineageLabel
              summary={summary}
              summaryLookup={summaryLookup}
              onOpenSource={onOpenSource}
            />
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {summary.planId && onOpenPlan !== undefined ? (
              <ExecutionActionButton
                label=""
                icon={<PlanModeIcon size="sm" />}
                onClick={() => onOpenPlan(summary.id)}
                dataTestId={`pipeline-run-plan-${summary.id}`}
                ariaLabel="Open tracked plan"
              />
            ) : null}
            {canResumeFromPreview && onResume !== undefined && (
              <ExecutionActionButton
                label={resumingId === summary.id ? 'Resuming…' : 'Resume'}
                ariaLabel={resumingId === summary.id ? 'Resuming…' : 'Resume'}
                icon={<PauseResumeIcon paused size="sm" />}
                variant="warning"
                dataTestId={`pipeline-run-resume-${summary.id}`}
                onClick={(): void => onResume(summary.id)}
                disabled={mutationPending || resumingId === summary.id}
              />
            )}
            {onCancel !== undefined &&
              isPipelineExecutionActiveStatus(summary.status) && (
                <ExecutionActionButton
                  label={cancellingId === summary.id ? 'Cancelling…' : 'Cancel'}
                  ariaLabel={
                    cancellingId === summary.id ? 'Cancelling…' : 'Cancel'
                  }
                  variant="destructive-chip"
                  dataTestId={`pipeline-run-cancel-${summary.id}`}
                  onClick={(): void => onCancel(summary.id)}
                  disabled={mutationPending || cancellingId === summary.id}
                />
              )}
          </div>
        </div>
        {executionState && (
          <PipelineRunDagProgressBar
            executionState={executionState}
            onJobClick={onJobClick}
          />
        )}
      </div>
      {childrenSection}
    </Surface>
  );
}

export interface CompletedRunRowProps {
  summary: PipelineRunSummary;
  executionState?: PipelineRunExecutionState;
  onOpenDetail: () => void;
  /**
   * The follow-up, plan, report, retry and start-over actions are optional
   * like `onDebugFailure`: a host that cannot perform one omits it and its
   * chip is not rendered.
   */
  onChatFollowUp?: (executionId: string) => void;
  onReportChatFollowUp?: (executionId: string) => void;
  onViewReport?: (executionId: string) => void;
  onPipelineFollowUp?: (executionId: string) => void;
  onOpenPlan?: (executionId: string) => void;
  onRetry?: (executionId: string) => void;
  onRerun?: (executionId: string) => void;
  /**
   * Optional: hosts with no App Advisor surface (the web portal) omit it and
   * the Debug chip is not rendered at all. A permanently disabled control is
   * the defect CAN-2865 removes, so absent must stay absent here.
   */
  onDebugFailure?: (executionId: string) => void;
  onResumePauseReason: () => void;
  onToggleHidden?: () => void;
  chatFollowUpDisabled?: boolean;
  onJobClick: (jobId: string) => void;
  retrying: boolean;
  rerunning: boolean;
  mutationPending?: boolean;
  debuggingFailureId: string | null;
  summaryLookup: Readonly<Record<string, PipelineRunSummary>>;
  onOpenSource: (executionId: string) => void;
  renderAdvisorBadge?: PipelineRunRenderSlot;
  renderWatcherButton?: PipelineRunRenderSlot;
  childrenSection?: ReactNode;
}

export function CompletedRunRow({
  summary,
  executionState,
  onOpenDetail,
  onChatFollowUp,
  onReportChatFollowUp,
  onViewReport,
  onPipelineFollowUp,
  onOpenPlan,
  onRetry,
  onRerun,
  onDebugFailure,
  onResumePauseReason,
  onToggleHidden,
  chatFollowUpDisabled = false,
  onJobClick,
  retrying,
  rerunning,
  mutationPending = false,
  debuggingFailureId,
  summaryLookup,
  onOpenSource,
  renderAdvisorBadge,
  renderWatcherButton,
  childrenSection,
}: CompletedRunRowProps): JSX.Element {
  const canResume = canResumeExecution(summary);
  const canRetry = onRetry !== undefined && canRetryExecution(summary);
  const canRerun = onRerun !== undefined && canRerunExecution(summary);
  const hasPlanActions =
    summary.has_plan === true &&
    (onChatFollowUp !== undefined ||
      onPipelineFollowUp !== undefined ||
      (summary.planId !== undefined && onOpenPlan !== undefined));
  const hasReportActions =
    summary.has_report === true &&
    (onReportChatFollowUp !== undefined || onViewReport !== undefined);
  const rerunSupported = hasRerunReplayData(executionState);
  const hidden = summary.hidden === true;
  const hookTriggerSource =
    summary.trigger_source ?? executionState?.trigger_source;
  const pauseReasonLabel = compactPipelineStatusReasonLabel(
    executionState?.status_reasons ?? summary.status_reasons,
  );
  return (
    <Surface
      variant="group"
      interactive
      className="group/pipeline-run relative"
    >
      <div className="px-3 py-2.5">
        {onToggleHidden && (
          <div className="absolute right-2 top-2 z-10 opacity-0 transition-opacity group-hover/pipeline-run:opacity-100 focus-within:opacity-100">
            <Button
              type="button"
              variant="ghost-overlay"
              size="compact"
              iconOnly
              data-testid={`pipeline-run-toggle-hidden-${summary.id}`}
              onClick={(event): void => {
                event.stopPropagation();
                onToggleHidden();
              }}
              aria-label={hidden ? 'Show workflow run' : 'Hide workflow run'}
            >
              {hidden ? <EyeIcon /> : <EyeOffIcon />}
            </Button>
          </div>
        )}
        <div
          role="button"
          tabIndex={0}
          data-testid={`pipeline-run-card-${summary.id}`}
          className="cursor-pointer"
          onClick={onOpenDetail}
          onKeyDown={(event): void => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onOpenDetail();
            }
          }}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge {...pipelineRunStatusBadge(summary.status, { muted: true })}>
              {summary.status}
            </Badge>
            <PipelineDispatchedTime
              startedAt={summary.started_at}
              testId={`pipeline-run-dispatched-${summary.id}`}
            />
            <HookTriggerIndicator triggerSource={hookTriggerSource} />
            {summary.plan_modified === true && (
              <Badge tone="special">Plan updated</Badge>
            )}
            {renderAdvisorBadge?.(summary)}
            {renderWatcherButton?.(summary)}
          </div>
          <div className="mt-1 truncate text-xs fg-secondary">
            {summary.pipeline_name}
          </div>
          <RerunLineageLabel
            summary={summary}
            summaryLookup={summaryLookup}
            onOpenSource={onOpenSource}
          />
          {executionState && (
            <PipelineRunDagProgressBar
              executionState={executionState}
              muted
              onJobClick={onJobClick}
            />
          )}
          {(canResume ||
            canRetry ||
            canRerun ||
            (onDebugFailure !== undefined && summary.status === 'failure')) && (
            <div className="mt-3 flex flex-wrap gap-2">
              {onDebugFailure !== undefined && summary.status === 'failure' && (
                <ExecutionActionButton
                  label={
                    debuggingFailureId === summary.id ? 'Opening…' : 'Debug'
                  }
                  icon={<AppCatalogMessageIcon size="sm" />}
                  onClick={() => onDebugFailure(summary.id)}
                  disabled={debuggingFailureId !== null}
                  dataTestId={`pipeline-run-debug-failure-${summary.id}`}
                  ariaLabel={`Debug failed workflow with ${ORCHESTRATOR_LABEL}`}
                />
              )}
              {canResume && (
                <ExecutionActionButton
                  label={pauseReasonLabel}
                  onClick={onResumePauseReason}
                  dataTestId={`pipeline-run-needs-input-${summary.id}`}
                  ariaLabel={`Open paused workflow run: ${pauseReasonLabel}`}
                  variant="warning"
                />
              )}
              {canRetry && onRetry !== undefined && (
                <ExecutionActionButton
                  label={retrying ? 'Trying again…' : 'Try again'}
                  icon={<RetryIcon size="sm" />}
                  onClick={() => onRetry(summary.id)}
                  disabled={retrying || mutationPending}
                  dataTestId={`pipeline-run-retry-${summary.id}`}
                  ariaLabel="Try the workflow run again"
                  variant="warning"
                />
              )}
              {canRerun && onRerun !== undefined && (
                <ExecutionActionButton
                  label={rerunning ? 'Starting over…' : 'Start over'}
                  icon={<RerunIcon size="sm" />}
                  onClick={() => onRerun(summary.id)}
                  disabled={rerunning || mutationPending || !rerunSupported}
                  dataTestId={`pipeline-run-rerun-${summary.id}`}
                  ariaLabel="Start workflow run over"
                  variant="destructive-chip"
                />
              )}
            </div>
          )}
          {(hasPlanActions || hasReportActions) && (
            <div className="mt-3 flex flex-wrap gap-2">
              {hasPlanActions && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-3xs font-medium fg-secondary/60">
                    Plan
                  </span>
                  {onChatFollowUp !== undefined && (
                    <FollowUpButton
                      label={CHAT_UNIT_LABEL}
                      icon={<AppCatalogMessageIcon size="sm" />}
                      onClick={() => onChatFollowUp(summary.id)}
                      disabled={chatFollowUpDisabled}
                      dataTestId={`pipeline-run-chat-follow-up-${summary.id}`}
                    />
                  )}
                  {onPipelineFollowUp !== undefined && (
                    <FollowUpButton
                      label="Workflow"
                      icon={<PipelineIcon />}
                      onClick={() => onPipelineFollowUp(summary.id)}
                      dataTestId={`pipeline-run-pipeline-follow-up-${summary.id}`}
                    />
                  )}
                  {summary.planId && onOpenPlan !== undefined ? (
                    <ExecutionActionButton
                      label=""
                      icon={<PlanModeIcon size="sm" />}
                      onClick={() => onOpenPlan(summary.id)}
                      dataTestId={`pipeline-run-plan-${summary.id}`}
                      ariaLabel="Open tracked plan"
                    />
                  ) : null}
                </div>
              )}
              {hasReportActions && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-3xs font-medium fg-secondary/60">
                    Report
                  </span>
                  {onReportChatFollowUp !== undefined && (
                    <FollowUpButton
                      label={CHAT_UNIT_LABEL}
                      icon={<AppCatalogMessageIcon size="sm" />}
                      onClick={() => onReportChatFollowUp(summary.id)}
                      disabled={chatFollowUpDisabled}
                      dataTestId={`pipeline-run-report-follow-up-${summary.id}`}
                    />
                  )}
                  {onViewReport !== undefined && (
                    <ExecutionActionButton
                      label=""
                      icon={<AppCatalogFileIcon size="sm" aria-hidden="true" />}
                      onClick={() => onViewReport(summary.id)}
                      dataTestId={`pipeline-run-view-report-${summary.id}`}
                      ariaLabel="View workflow report"
                    />
                  )}
                </div>
              )}
            </div>
          )}
        </div>
        {childrenSection}
      </div>
    </Surface>
  );
}

export interface PipelineRunTreeRowProps {
  node: ExecutionTreeNode<PipelineRunSummary>;
  expandedIds: ReadonlySet<string>;
  onToggleExpand: (id: string) => void;
  statesById: Readonly<Record<string, PipelineRunExecutionState | undefined>>;
  cancellingId: string | null;
  resumingId: string | null;
  onOpenDetail: (
    rootId: string,
    viewStack: readonly PipelineRunBreadcrumbEntry[],
    jobId?: string,
  ) => void;
  /** See {@link ActiveRunRowProps.onCancel}. */
  onCancel?: (id: string) => void;
  /** See {@link ActiveRunRowProps.onResume}. */
  onResume?: (id: string, pauseResponses?: PipelineRunPauseResponse[]) => void;
  /**
   * The follow-up, plan, report, retry and start-over actions: see
   * {@link CompletedRunRowProps.onChatFollowUp}.
   */
  onChatFollowUp?: (id: string) => void;
  onReportChatFollowUp?: (id: string) => void;
  onViewReport?: (id: string) => void;
  onPipelineFollowUp?: (id: string) => void;
  onOpenPlan?: (id: string) => void;
  onRetry?: (id: string) => void;
  onRerun?: (id: string) => void;
  /** See {@link CompletedRunRowProps.onDebugFailure}. */
  onDebugFailure?: (id: string) => void;
  onToggleHidden?: (id: string, hidden: boolean) => void;
  chatFollowUpDisabled: boolean;
  retryingIds: ReadonlySet<string>;
  rerunningIds: ReadonlySet<string>;
  mutatingPendingIds?: ReadonlySet<string>;
  debuggingFailureId: string | null;
  summaryLookup: Readonly<Record<string, PipelineRunSummary>>;
  onOpenSource: (executionId: string) => void;
  parentChain: readonly PipelineRunBreadcrumbEntry[];
  renderAdvisorBadge?: PipelineRunRenderSlot;
  renderWatcherButton?: PipelineRunRenderSlot;
}

export function PipelineRunTreeRow({
  node,
  expandedIds,
  onToggleExpand,
  statesById,
  cancellingId,
  resumingId,
  onOpenDetail,
  onCancel,
  onResume,
  onChatFollowUp,
  onReportChatFollowUp,
  onViewReport,
  onPipelineFollowUp,
  onOpenPlan,
  onRetry,
  onRerun,
  onDebugFailure,
  onToggleHidden,
  chatFollowUpDisabled,
  retryingIds,
  rerunningIds,
  mutatingPendingIds,
  debuggingFailureId,
  summaryLookup,
  onOpenSource,
  parentChain,
  renderAdvisorBadge,
  renderWatcherButton,
}: PipelineRunTreeRowProps): JSX.Element {
  const { summary, children } = node;
  const isExpanded = expandedIds.has(summary.id);
  const isActive = isPipelineExecutionActiveStatus(summary.status);
  const isRoot = parentChain.length === 0;
  const viewStack =
    parentChain.length === 0
      ? []
      : [
          ...parentChain.slice(1),
          { executionId: summary.id, label: summary.pipeline_name },
        ];
  const rootId =
    parentChain.length === 0 ? summary.id : parentChain[0].executionId;
  const childParentChain = [
    ...parentChain,
    { executionId: summary.id, label: summary.pipeline_name },
  ];
  const childrenSection =
    children.length > 0 ? (
      <>
        <SubPipelineButton
          count={children.length}
          expanded={isExpanded}
          onClick={() => onToggleExpand(summary.id)}
        />
        {isExpanded && (
          <div className="mt-2 flex flex-col gap-1.5 border-l-2 ml-1 pl-2.5">
            {children.map((child) => (
              <PipelineRunTreeRow
                key={child.summary.id}
                node={child}
                expandedIds={expandedIds}
                onToggleExpand={onToggleExpand}
                statesById={statesById}
                cancellingId={cancellingId}
                resumingId={resumingId}
                onOpenDetail={onOpenDetail}
                onCancel={onCancel}
                onResume={onResume}
                onChatFollowUp={onChatFollowUp}
                onReportChatFollowUp={onReportChatFollowUp}
                onViewReport={onViewReport}
                onPipelineFollowUp={onPipelineFollowUp}
                onOpenPlan={onOpenPlan}
                onRetry={onRetry}
                onRerun={onRerun}
                onDebugFailure={onDebugFailure}
                onToggleHidden={onToggleHidden}
                chatFollowUpDisabled={chatFollowUpDisabled}
                retryingIds={retryingIds}
                rerunningIds={rerunningIds}
                mutatingPendingIds={mutatingPendingIds}
                debuggingFailureId={debuggingFailureId}
                summaryLookup={summaryLookup}
                onOpenSource={onOpenSource}
                parentChain={childParentChain}
                renderAdvisorBadge={renderAdvisorBadge}
                renderWatcherButton={renderWatcherButton}
              />
            ))}
          </div>
        )}
      </>
    ) : undefined;
  const openDetail = (): void => onOpenDetail(rootId, viewStack);
  const openJob = (jobId: string): void =>
    onOpenDetail(rootId, viewStack, jobId);
  return (
    <div>
      {isActive ? (
        <ActiveRunRow
          summary={summary}
          executionState={statesById[summary.id]}
          cancellingId={cancellingId}
          resumingId={resumingId}
          mutationPending={mutatingPendingIds?.has(summary.id) === true}
          onOpenDetail={openDetail}
          onCancel={onCancel}
          onResume={onResume}
          onJobClick={openJob}
          onOpenPlan={onOpenPlan}
          summaryLookup={summaryLookup}
          onOpenSource={onOpenSource}
          renderAdvisorBadge={renderAdvisorBadge}
          renderWatcherButton={renderWatcherButton}
          childrenSection={childrenSection}
        />
      ) : (
        <CompletedRunRow
          summary={summary}
          executionState={statesById[summary.id]}
          onOpenDetail={openDetail}
          onChatFollowUp={onChatFollowUp}
          onReportChatFollowUp={onReportChatFollowUp}
          onViewReport={onViewReport}
          onPipelineFollowUp={onPipelineFollowUp}
          onOpenPlan={onOpenPlan}
          onRetry={onRetry}
          onRerun={onRerun}
          onDebugFailure={onDebugFailure}
          onResumePauseReason={openDetail}
          onToggleHidden={
            isRoot && onToggleHidden
              ? (): void => onToggleHidden(summary.id, !summary.hidden)
              : undefined
          }
          chatFollowUpDisabled={chatFollowUpDisabled}
          onJobClick={openJob}
          retrying={retryingIds.has(summary.id)}
          rerunning={rerunningIds.has(summary.id)}
          mutationPending={mutatingPendingIds?.has(summary.id) === true}
          debuggingFailureId={debuggingFailureId}
          summaryLookup={summaryLookup}
          onOpenSource={onOpenSource}
          renderAdvisorBadge={renderAdvisorBadge}
          renderWatcherButton={renderWatcherButton}
          childrenSection={childrenSection}
        />
      )}
    </div>
  );
}
