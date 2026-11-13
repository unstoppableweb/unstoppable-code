'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { useStore } from 'zustand';
import type {
  CloudPipelineRunArtifactContent,
  CloudPipelineRunSession,
} from '@canopy/app-state/cloud-pipeline-runs';
import type {
  WorkerPipelineArtifact,
  WorkerPipelineExecutionView,
  WorkerPipelineJobDetail,
} from '@canopy/protocol/canopy-core';
import {
  Button,
  Fact,
  FactList,
  Notice,
  Surface,
} from '@canopy/ui-shared/components';
import { Markdown } from '@canopy/ui-shared/components/Markdown';
import {
  canCancelMatrixVariant,
  canRetryAllMatrixVariants,
  canRetryFailedMatrixVariants,
  getRetryableMatrixVariantIds,
  groupPipelineStatusReasons,
} from '@canopy/ui-shared/lib';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  PipelineRunDetail,
  type PipelineRunDetailStepSelection,
} from '../../code/activity/pipeline/PipelineRunDetail';
import {
  buildPipelineRunDetailJobs,
  flattenPipelineRunDetailSteps,
} from '../../code/activity/pipeline/PipelineRunDetailModel';
import type { PipelineRunPauseResponse } from '../../code/activity/pipeline/PipelineRunRows';
import {
  WORKFLOW_RUN_LOCATION_LABELS,
  WORKFLOW_RUN_STARTER_LABELS,
} from '../workflow-run-model';
import { workflowRunStarterOf } from '../workflow-run-starter';
import { formatRunStarted } from '../workflow-time';
import {
  CLOUD_RUN_RETRIES_IN_PLACE,
  cloudRunDetailView,
  cloudRunExecutionState,
  cloudRunStatusReasons,
  cloudRunSummary,
} from './cloud-run-projection';

export interface CloudPipelineRunDetailProps {
  /** From `useCloudPipelineRunSession`; null while it opens. */
  readonly session: CloudPipelineRunSession | null;
  /** A job to select first, such as the one a DAG click named. */
  readonly initialJobId?: string;
  readonly layout?: 'overlay' | 'panel';
  /** Opens another run: the new run a Start over made. */
  readonly onOpenRun?: (executionId: string) => void;
  /**
   * Opens the tracked plan the run saved. Omitted while the host has no home
   * for a cloud run's plan (CP-34); the plan is still named.
   */
  readonly onOpenPlan?: (planId: string) => void;
  /**
   * The run's linked chat, once runs carry one (`run_chat_id`, CAN-3379,
   * #5803). Hosts render the link here; nothing is drawn until they do.
   */
  readonly renderRunChat?: (view: WorkerPipelineExecutionView) => ReactNode;
}

const ARTIFACT_LABELS: Readonly<
  Record<WorkerPipelineArtifact['kind'], string>
> = {
  report: 'Report',
  report_json: 'Report data',
};

function artifactKey(artifact: WorkerPipelineArtifact): string {
  return `${artifact.kind}:${artifact.jobId ?? ''}:${artifact.stepId ?? ''}`;
}

function toPauseResponses(
  responses: readonly PipelineRunPauseResponse[] | undefined,
): Parameters<CloudPipelineRunSession['resume']>[0] {
  return responses?.map((response) => ({
    checkpointId: response.checkpoint_id,
    jobId: response.job_id,
    stepId: response.step_id,
    ...(response.answers === undefined
      ? {}
      : { answers: { ...response.answers } }),
  }));
}

/**
 * A cloud run's detail (CAN-6326, plan CP-38): the shared run detail fed by
 * the web core, with the run's full step logs read by position, its reports,
 * who started it and where, why it paused, and every control the desktop's
 * run rows offer, kept live over the run's events push. Host-agnostic: the
 * desktop and the web Workflows page (CP-39) pass a session over their own
 * web core carrier.
 */
export function CloudPipelineRunDetail({
  session,
  initialJobId,
  layout = 'overlay',
  onOpenRun,
  onOpenPlan,
  renderRunChat,
}: CloudPipelineRunDetailProps): JSX.Element {
  if (session === null)
    return (
      <p
        className="px-6 text-xs fg-secondary"
        role="status"
        data-testid="cloud-run-detail-loading"
      >
        Loading run…
      </p>
    );
  return (
    <CloudRunDetailBody
      session={session}
      initialJobId={initialJobId}
      layout={layout}
      onOpenRun={onOpenRun}
      onOpenPlan={onOpenPlan}
      renderRunChat={renderRunChat}
    />
  );
}

function CloudRunDetailBody({
  session,
  initialJobId,
  layout,
  onOpenRun,
  onOpenPlan,
  renderRunChat,
}: CloudPipelineRunDetailProps & {
  readonly session: CloudPipelineRunSession;
}): JSX.Element {
  const view = useStore(session, (state) => state.view);
  const error = useStore(session, (state) => state.error);
  const log = useStore(session, (state) => state.log);
  const live = useStore(session, (state) => state.live);
  const pending = useStore(session, (state) => state.pending);
  const controlError = useStore(session, (state) => state.controlError);

  const detailView = useMemo(
    () => (view === null ? null : cloudRunDetailView(view)),
    [view],
  );
  const steps = useMemo(
    () =>
      detailView === null
        ? []
        : flattenPipelineRunDetailSteps(
            buildPipelineRunDetailJobs(detailView.jobs),
          ),
    [detailView],
  );

  // The first log shown: the named job's first step, else the step that
  // needs attention (paused, then running, then failed), else the first.
  useEffect(() => {
    if (log !== null) return;
    const withStatus = (status: string): (typeof steps)[number] | undefined =>
      steps.find((entry) => entry.step.status === status);
    const first =
      steps.find((entry) => entry.job_id === initialJobId) ??
      withStatus('paused') ??
      withStatus('running') ??
      withStatus('failure') ??
      steps[0];
    if (first) session.selectStep(first.job_id, first.step.step_id);
  }, [initialJobId, log, session, steps]);

  const onSelectStep = useCallback(
    (selection: PipelineRunDetailStepSelection): void =>
      session.selectStep(selection.job_id, selection.step_id),
    [session],
  );
  // A refused control is shown from the session's `controlError`.
  const settle = (work: Promise<unknown>): void => {
    void work.catch(() => undefined);
  };

  if (view === null || detailView === null)
    return error === null ? (
      <p
        className="px-6 text-xs fg-secondary"
        role="status"
        data-testid="cloud-run-detail-loading"
      >
        Loading run…
      </p>
    ) : (
      <div className="px-6">
        <Notice intent="destructive" data-testid="cloud-run-detail-error">
          {error.message}
        </Notice>
      </div>
    );

  const summary = cloudRunSummary(view);
  const selectedStep =
    log === null ? null : { job_id: log.jobId, step_id: log.stepId };

  return (
    <PipelineRunDetail
      run={detailView}
      summary={summary}
      executionState={cloudRunExecutionState(view)}
      selectedStep={selectedStep}
      onSelectStep={onSelectStep}
      log={{
        lines: log?.entries.map((entry) => entry.text) ?? [],
        loading: log?.loading === true,
        ...(log?.error ? { error: log.error.message } : {}),
        ...(log?.capped === true
          ? { onLoadMore: (): void => session.loadMoreLog() }
          : {}),
      }}
      layout={layout}
      onCancel={(): void => settle(session.cancel())}
      onResume={(_id, responses): void =>
        settle(session.resume(toPauseResponses(responses)))
      }
      {...(CLOUD_RUN_RETRIES_IN_PLACE
        ? { onRetry: (): void => settle(session.retry()) }
        : {})}
      onRerun={(): void =>
        settle(
          session.rerun().then((executionId) => {
            // A detail closed, or moved to another run, while Start over was
            // pending stays where the user left it.
            if (!session.isClosed()) onOpenRun?.(executionId);
          }),
        )
      }
      cancelling={pending.cancel === true}
      resuming={pending.resume === true}
      retrying={pending.retry === true}
      rerunning={pending.rerun === true}
      mutationPending={Object.keys(pending).length > 0}
      {...(controlError === null ? {} : { errorMessage: controlError })}
    >
      <CloudRunFacts
        view={view}
        live={live}
        onOpenPlan={onOpenPlan}
        renderRunChat={renderRunChat}
      />
      <CloudRunMatrixControls
        view={view}
        session={session}
        busy={Object.keys(pending).length > 0}
      />
      <CloudRunArtifacts view={view} session={session} />
    </PipelineRunDetail>
  );
}

function CloudRunFacts({
  view,
  live,
  onOpenPlan,
  renderRunChat,
}: {
  readonly view: WorkerPipelineExecutionView;
  readonly live: ReturnType<CloudPipelineRunSession['getState']>['live'];
  readonly onOpenPlan?: (planId: string) => void;
  readonly renderRunChat?: (view: WorkerPipelineExecutionView) => ReactNode;
}): JSX.Element {
  const { execution, detail } = view;
  const starter = workflowRunStarterOf({
    initiator: detail?.initiation.initiator,
    event: detail?.initiation.event,
    hook: (detail?.initiation.hook ?? null) !== null,
    automationsAreScheduled: true,
  });
  const automationName =
    detail?.initiation.initiator?.kind === 'automation'
      ? detail.initiation.initiator.automationName
      : undefined;
  // An input request is asked by the pause form below; its reason would
  // only repeat it.
  const asking = (detail?.pendingPauses.length ?? 0) > 0;
  const reasons = groupPipelineStatusReasons(
    cloudRunStatusReasons(detail).filter(
      (reason) => !(asking && reason.kind === 'input_required'),
    ),
  );
  const plan = detail?.plan ?? null;
  const runChat = renderRunChat?.(view);
  return (
    <div className="flex flex-col gap-2" data-testid="cloud-run-facts">
      <FactList size="xs" labelWidth="6rem" dataTestId="cloud-run-fact-list">
        <Fact label="Started by" dataTestId="cloud-run-started-by">
          {automationName === undefined
            ? WORKFLOW_RUN_STARTER_LABELS[starter]
            : `${WORKFLOW_RUN_STARTER_LABELS[starter]} · ${automationName}`}
        </Fact>
        <Fact label="Ran on" dataTestId="cloud-run-location">
          {WORKFLOW_RUN_LOCATION_LABELS.cloud}
        </Fact>
        <Fact label="Started" numeric>
          {formatRunStarted(Date.parse(execution.startedAt), Date.now())}
        </Fact>
        {plan?.saved === true && (
          <Fact label="Plan" dataTestId="cloud-run-plan">
            {plan.planId !== null && onOpenPlan !== undefined ? (
              <Button
                variant="link"
                data-testid="cloud-run-open-plan"
                onClick={(): void => {
                  if (plan.planId !== null) onOpenPlan(plan.planId);
                }}
              >
                {plan.modified ? 'Open updated plan' : 'Open plan'}
              </Button>
            ) : plan.modified ? (
              'Updated its plan'
            ) : (
              'Saved a plan'
            )}
          </Fact>
        )}
      </FactList>
      {runChat}
      {reasons.map((group) => (
        <Notice
          key={group.key}
          intent="attention"
          title={group.heading}
          data-testid={`cloud-run-status-reason-${group.reasons[0]?.kind ?? 'unknown'}`}
        >
          {group.helper}
        </Notice>
      ))}
      {execution.status === 'failure' && execution.error !== null && (
        <Notice intent="destructive" data-testid="cloud-run-error">
          <span className={REPLAY_BLOCK_CLASS}>{execution.error}</span>
        </Notice>
      )}
      {live === 'offline' && (
        <Notice intent="neutral" data-testid="cloud-run-offline">
          Live updates stopped. Close and reopen this run to see its latest
          state.
        </Notice>
      )}
    </div>
  );
}

function matrixVariants(
  job: WorkerPipelineJobDetail,
): Readonly<Record<string, { readonly status: string }>> {
  return Object.fromEntries(
    job.variants.map((variant) => [variant.jobId, { status: variant.status }]),
  );
}

/** Matrix jobs' own controls: retry their variants, or cancel one. */
function CloudRunMatrixControls({
  view,
  session,
  busy,
}: {
  readonly view: WorkerPipelineExecutionView;
  readonly session: CloudPipelineRunSession;
  readonly busy: boolean;
}): JSX.Element | null {
  const status = view.execution.status;
  const rows = (view.detail?.jobs ?? [])
    .filter((job) => job.kind === 'matrix')
    .map((job) => {
      const group = {
        kind: job.kind,
        status: job.status,
        expansion: job.expansion,
        variant_job_ids: job.variants.map((variant) => variant.jobId),
      };
      const variants = matrixVariants(job);
      return {
        job,
        retryFailed:
          CLOUD_RUN_RETRIES_IN_PLACE &&
          canRetryFailedMatrixVariants(status, group, variants),
        retryAll:
          CLOUD_RUN_RETRIES_IN_PLACE &&
          canRetryAllMatrixVariants(status, group),
        failedIds: getRetryableMatrixVariantIds(group, variants),
        cancellable: job.variants.filter((variant) =>
          canCancelMatrixVariant(status, { status: variant.status }),
        ),
      };
    })
    .filter(
      (row) => row.retryFailed || row.retryAll || row.cancellable.length > 0,
    );
  if (rows.length === 0) return null;
  const settle = (work: Promise<void>): void => {
    void work.catch(() => undefined);
  };
  return (
    <div className="flex flex-col gap-1.5" data-testid="cloud-run-matrix">
      {rows.map(({ job, retryFailed, retryAll, failedIds, cancellable }) => (
        <div key={job.jobId} className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs fg-secondary">{job.name}</span>
          {retryFailed && (
            <Button
              variant="secondary"
              size="compact"
              disabled={busy}
              data-testid={`cloud-run-matrix-retry-failed-${job.jobId}`}
              onClick={(): void =>
                settle(session.retryMatrixJob(job.jobId, 'failed', failedIds))
              }
            >
              Try failed variants again
            </Button>
          )}
          {retryAll && (
            <Button
              variant="secondary"
              size="compact"
              disabled={busy}
              data-testid={`cloud-run-matrix-retry-all-${job.jobId}`}
              onClick={(): void =>
                settle(session.retryMatrixJob(job.jobId, 'all'))
              }
            >
              Try all variants again
            </Button>
          )}
          {cancellable.map((variant) => (
            <Button
              key={variant.jobId}
              variant="secondary"
              size="compact"
              disabled={busy}
              data-testid={`cloud-run-matrix-cancel-${variant.jobId}`}
              onClick={(): void =>
                settle(session.cancelMatrixVariant(job.jobId, variant.jobId))
              }
            >
              {`Cancel ${variant.name}`}
            </Button>
          ))}
        </div>
      ))}
    </div>
  );
}

type ArtifactRead =
  | { readonly state: 'loading' }
  | {
      readonly state: 'loaded';
      readonly content: CloudPipelineRunArtifactContent;
    }
  | { readonly state: 'failed'; readonly message: string };

/** The run's saved reports, each read in full when opened. */
function CloudRunArtifacts({
  view,
  session,
}: {
  readonly view: WorkerPipelineExecutionView;
  readonly session: CloudPipelineRunSession;
}): JSX.Element | null {
  const artifacts = view.detail?.artifacts ?? [];
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [reads, setReads] = useState<Readonly<Record<string, ArtifactRead>>>(
    {},
  );
  if (artifacts.length === 0) return null;

  const stepName = (artifact: WorkerPipelineArtifact): string | undefined => {
    if (artifact.jobId === null || artifact.stepId === null) return undefined;
    for (const job of view.detail?.jobs ?? [])
      for (const variant of job.variants)
        if (variant.jobId === artifact.jobId)
          return variant.steps.find((step) => step.stepId === artifact.stepId)
            ?.name;
    return undefined;
  };

  const toggle = (artifact: WorkerPipelineArtifact): void => {
    const key = artifactKey(artifact);
    if (openKey === key) {
      setOpenKey(null);
      return;
    }
    setOpenKey(key);
    if (reads[key]?.state === 'loaded') return;
    setReads((current) => ({ ...current, [key]: { state: 'loading' } }));
    void session.readArtifact(artifact).then(
      (content) =>
        setReads((current) => ({
          ...current,
          [key]: { state: 'loaded', content },
        })),
      (error: unknown) =>
        setReads((current) => ({
          ...current,
          [key]: {
            state: 'failed',
            message:
              error instanceof Error
                ? error.message
                : "The report couldn't be read.",
          },
        })),
    );
  };

  const open = openKey === null ? undefined : reads[openKey];
  return (
    <div className="flex flex-col gap-1.5" data-testid="cloud-run-artifacts">
      <div className="flex flex-wrap items-center gap-1.5">
        {artifacts.map((artifact) => {
          const key = artifactKey(artifact);
          const step = stepName(artifact);
          const label =
            step === undefined
              ? ARTIFACT_LABELS[artifact.kind]
              : `${ARTIFACT_LABELS[artifact.kind]} · ${step}`;
          return (
            <Button
              key={key}
              variant={openKey === key ? 'primary' : 'secondary'}
              size="compact"
              aria-expanded={openKey === key}
              data-testid={`cloud-run-artifact-${artifact.kind}`}
              onClick={(): void => toggle(artifact)}
            >
              {label}
            </Button>
          );
        })}
      </div>
      {open !== undefined && (
        // The report scrolls inside a capped box, so the steps stay in view.
        <div className="max-h-[40vh] overflow-auto">
          <Surface
            variant="outline"
            padding="compact"
            data-testid="cloud-run-artifact-content"
          >
            {open.state === 'loading' ? (
              <p className="text-xs fg-secondary" role="status">
                Loading report…
              </p>
            ) : open.state === 'failed' ? (
              <Notice intent="destructive">{open.message}</Notice>
            ) : (
              <div className={`flex flex-col gap-2 ${REPLAY_BLOCK_CLASS}`}>
                {open.content.artifact.kind === 'report' ? (
                  <Markdown>{open.content.text}</Markdown>
                ) : (
                  <pre className="whitespace-pre-wrap font-mono text-xs fg-secondary">
                    {open.content.text}
                  </pre>
                )}
                {open.content.truncated && (
                  <p className="text-3xs fg-secondary">
                    Showing the start of this report.
                  </p>
                )}
              </div>
            )}
          </Surface>
        </div>
      )}
    </div>
  );
}
