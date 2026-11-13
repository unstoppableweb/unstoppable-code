'use client';

import { useContext, type JSX, type ReactNode, type RefObject } from 'react';
import type { PipelineRunArtifactReceiptV1 } from '@canopy/protocol/agent-artifacts';
import {
  Button,
  Tooltip,
  DagProgressDots,
  GroupedDiffStats,
  SpinnerStyleProvider,
  StatusGlyph,
  type DagJobMeta,
  joinDetails,
} from '@canopy/ui-shared/components';
import {
  formatElapsed,
  OPERATIONAL_STATUS_COLORS,
  runStatusGlyphState,
  type StatusGlyphState,
} from '@canopy/ui-shared/lib';
import {
  GitHubIcon,
  CirclePauseIcon,
  StopFilledIcon,
  PlayIcon,
  PipelineIcon,
  GitPullRequestIcon,
  GitMergeQueueIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  REPLAY_BLOCK_CLASS,
  REPLAY_MASK_CLASS,
} from '@canopy/ui-shared/lib/replay-privacy';
import {
  githubWorkflowRunDag,
  githubWorkflowRunRowStatus,
  githubWorkflowRunRowTitle,
  type GitHubWorkflowRunRowData,
} from '../github/GitHubWorkflowRunRow';
import {
  pipelineRunDag,
  type PipelineRunExecutionState,
} from '../pipeline/PipelineRunRows';
import {
  DrawerRow,
  InspectorOpenAction,
  InspectorSection,
  InspectorSubtitle,
} from './DrawerRow';
import { DrawerRowPresentationContext } from './drawer-presentation';

export type BackgroundTrayRunStatus =
  | 'running'
  | 'needs-input'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  /** Ended without a confirmed success or failure (a skipped GitHub run). */
  | 'completed';

export type BackgroundTrayRunKind = 'pipeline' | 'github' | 'github-pr';

/** A run's jobs, laid out as the DAG progress bar draws them. */
export interface BackgroundTrayRunDag {
  readonly tiers: string[][];
  readonly jobs: Record<string, DagJobMeta>;
}

/**
 * A run the chat follows, as the drawer lists it: a pipeline run, or a
 * GitHub Actions run or pull request a watcher follows (D1b), including its Portal projection.
 */
export interface BackgroundTrayRun {
  /** The host's key for the run: its receipts' dedupe key. */
  readonly id: string;
  readonly kind: BackgroundTrayRunKind;
  readonly name: string;
  readonly status: BackgroundTrayRunStatus;
  /** Epoch milliseconds, or null when unknown. */
  readonly startedAt: number | null;
  /** Its jobs, or null until the host knows them. */
  readonly dag: BackgroundTrayRunDag | null;
  /** The input checkpoint's question while the run waits on the user. */
  readonly question: string | null;
  /** A GitHub run's `owner/repository`. */
  readonly repository: string | null;
  /** Its own word for its state, in place of the status label (Merged). */
  readonly statusLabel?: string;
  /** Present only when the host has observed the pull request diff. */
  readonly diffStats?: {
    readonly insertions: number;
    readonly deletions: number;
  };
  /** Preserve PR lifecycle separately from the generic run status. */
  readonly pullRequestState?: 'open' | 'merge-queue' | 'merged' | 'closed';
  /** One quiet inspector line after the repository (a pull request's base). */
  readonly note?: string;
}

export const RUN_STATUS_LABELS: Record<BackgroundTrayRunStatus, string> = {
  running: 'Running',
  'needs-input': 'Needs input',
  paused: 'Paused',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
  completed: 'Completed',
};

/** Where the run stands, on the shared glyph map. */
const RUN_GLYPH_STATES: Record<BackgroundTrayRunStatus, StatusGlyphState> = {
  running: 'running',
  'needs-input': 'needs-you',
  paused: 'paused',
  succeeded: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
  completed: 'done',
};

export function isFinishedTrayRun(status: BackgroundTrayRunStatus): boolean {
  return (
    status === 'succeeded' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'completed'
  );
}

/**
 * A pipeline run's drawer state from its execution status: an input
 * checkpoint asks the user something; an action pause waits to be resumed.
 */
export function pipelineTrayRunStatus(
  status: string,
  pendingPauses: PipelineRunExecutionState['pending_pauses'],
): BackgroundTrayRunStatus {
  switch (status) {
    case 'paused':
      return pendingPauses?.some((pause) => pause.kind === 'input') === true
        ? 'needs-input'
        : 'paused';
    case 'success':
      return 'succeeded';
    case 'failure':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'running';
  }
}

/**
 * A run's name, or its kind while the receipt has none (a run can arrive
 * before its pipeline's name), so a row never starts with a blank.
 */
export function runDisplayName(run: BackgroundTrayRun): string {
  const name = run.name.trim();
  if (name !== '') return name;
  return run.kind === 'pipeline'
    ? 'Pipeline run'
    : run.kind === 'github'
      ? 'GitHub run'
      : 'Pull request';
}

/** A pipeline run's drawer row, from its receipt and live state. */
export function pipelineBackgroundTrayRun(
  id: string,
  receipt: Pick<
    PipelineRunArtifactReceiptV1,
    'pipelineName' | 'startedAt' | 'queuedAt'
  >,
  status: string,
  state: PipelineRunExecutionState | undefined,
): BackgroundTrayRun {
  const input = state?.pending_pauses?.find((pause) => pause.kind === 'input');
  const startedAt = Date.parse(receipt.startedAt ?? receipt.queuedAt);
  return {
    id,
    kind: 'pipeline',
    name: receipt.pipelineName,
    status: pipelineTrayRunStatus(status, state?.pending_pauses),
    startedAt: Number.isNaN(startedAt) ? null : startedAt,
    dag: state === undefined ? null : pipelineRunDag(state),
    question: input?.request?.message ?? input?.request?.title ?? null,
    repository: null,
  };
}

/** A watched GitHub Actions run's drawer row, from its latest snapshot. */
export function githubBackgroundTrayRun(
  id: string,
  run: GitHubWorkflowRunRowData,
): BackgroundTrayRun {
  const { active, tone } = githubWorkflowRunRowStatus(run.state);
  const startedAt =
    run.startedAt === undefined ? Number.NaN : Date.parse(run.startedAt);
  return {
    id,
    kind: 'github',
    name: githubWorkflowRunRowTitle(run),
    // Only GitHub's success is a success; a skipped, neutral, stale or
    // unknown outcome ended without one.
    status: active
      ? 'running'
      : tone === 'success'
        ? 'succeeded'
        : tone === 'failed' || tone === 'warning'
          ? 'failed'
          : tone === 'paused'
            ? 'cancelled'
            : 'completed',
    startedAt: Number.isNaN(startedAt) ? null : startedAt,
    dag: githubWorkflowRunDag(run),
    question: null,
    repository: run.repository,
  };
}

/** A watched pull request's last snapshot, as its watcher observed it. */
export interface GitHubPullRequestRowData {
  readonly repository: string;
  readonly number: number;
  readonly title?: string;
  readonly additions?: number;
  readonly deletions?: number;
  readonly state: 'open' | 'closed' | 'merged';
  readonly baseRefName: string;
  readonly queue: { readonly position: number | null } | null;
}

/**
 * A watched pull request's drawer row: live while open, finished once merged
 * or closed. It has no jobs and no Stop.
 */
export function githubPullRequestBackgroundTrayRun(
  id: string,
  pr: GitHubPullRequestRowData,
): BackgroundTrayRun {
  const queued =
    pr.queue === null
      ? null
      : pr.queue.position === null
        ? 'in the merge queue'
        : `position ${pr.queue.position} in the merge queue`;
  return {
    id,
    kind: 'github-pr',
    ...(pr.additions !== undefined && pr.deletions !== undefined
      ? { diffStats: { insertions: pr.additions, deletions: pr.deletions } }
      : {}),
    pullRequestState:
      pr.state === 'open' && pr.queue !== null ? 'merge-queue' : pr.state,
    name: pr.title ? `#${pr.number} ${pr.title}` : `#${pr.number}`,
    status:
      pr.state === 'merged'
        ? 'succeeded'
        : pr.state === 'closed'
          ? 'cancelled'
          : 'running',
    statusLabel:
      pr.state === 'merged'
        ? 'Merged'
        : pr.state === 'closed'
          ? 'Closed'
          : queued === null
            ? 'Open'
            : 'In merge queue',
    startedAt: null,
    dag: null,
    question: null,
    repository: pr.repository,
    note:
      pr.state === 'open' && queued !== null
        ? `into ${pr.baseRefName} · ${queued}`
        : `into ${pr.baseRefName}`,
  };
}

/** The run's running jobs, in tier order. */
function runningJobs(dag: BackgroundTrayRunDag | null): string | null {
  if (dag === null) return null;
  const names = dag.tiers.flat().flatMap((jobId) => {
    const job = dag.jobs[jobId];
    return job?.status === 'running' || job?.status === 'restarting'
      ? [job.name]
      : [];
  });
  return names.length === 0 ? null : names.join(', ');
}

export interface RunRowActions {
  readonly onStop?: (runId: string) => void;
  /** Opens a run waiting for input, where the user answers it. */
  readonly onRespond?: (runId: string) => void;
  readonly onResume?: (runId: string) => void;
  readonly onDismiss?: (runId: string) => void;
  /** Opens the run: its detail, or a GitHub run's page. */
  readonly onOpen?: (runId: string) => void;
  readonly onJobClick?: (runId: string, jobId: string) => void;
  /** The run's watcher button, beside its jobs in the inspector. */
  readonly renderWatcher?: (run: BackgroundTrayRun) => ReactNode;
}

export interface RunRowProps extends RunRowActions {
  readonly run: BackgroundTrayRun;
  readonly now: number;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly listRef: RefObject<HTMLDivElement | null>;
  readonly topInset: number;
}

/**
 * The row's one action; a GitHub run has no Stop (D1b). A host without
 * Respond or Resume (the Portal) can still stop a waiting or paused run.
 */
type RunActionTone = 'accent' | 'destructive' | 'quiet';
/**
 * A run action's accessible name. Never the run's name: session replay
 * records attributes verbatim, and a title can be private.
 */
function runActionAriaLabel(run: BackgroundTrayRun, suffix: string): string {
  if (run.kind === 'github-pr') return 'Dismiss pull request';
  switch (suffix) {
    case 'stop':
      return 'Stop run';
    case 'respond':
      return 'Respond to run';
    case 'resume':
      return 'Resume run';
    default:
      return 'Dismiss run';
  }
}

function runAction(
  run: BackgroundTrayRun,
  { onStop, onRespond, onResume, onDismiss }: RunRowActions,
): {
  label: string;
  suffix: string;
  tone: RunActionTone;
  handler?: (runId: string) => void;
} {
  switch (run.status) {
    case 'running':
      return {
        label: 'Stop',
        suffix: 'stop',
        tone: 'destructive',
        handler: run.kind === 'pipeline' ? onStop : undefined,
      };
    case 'needs-input':
    case 'paused': {
      const handler = run.status === 'paused' ? onResume : onRespond;
      if (handler === undefined && run.kind === 'pipeline') {
        return {
          label: 'Stop',
          suffix: 'stop',
          tone: 'destructive',
          handler: onStop,
        };
      }
      // View opens the run where its question is answered: the drawer's one
      // accent action.
      return run.status === 'paused'
        ? { label: 'Resume', suffix: 'resume', tone: 'quiet', handler }
        : { label: 'View', suffix: 'respond', tone: 'accent', handler };
    }
    default:
      // Hides the finished run from the drawer; it returns to its turn.
      return {
        label: 'Hide',
        suffix: 'dismiss',
        tone: 'quiet',
        handler: onDismiss,
      };
  }
}

const PR_STATE_APPEARANCE = {
  open: {
    Icon: GitPullRequestIcon,
    color: OPERATIONAL_STATUS_COLORS.success.foreground,
  },
  'merge-queue': {
    Icon: GitMergeQueueIcon,
    color: 'fg-warning-strong',
  },
  merged: {
    Icon: GitMergeIcon,
    color: OPERATIONAL_STATUS_COLORS.merged.foreground,
  },
  closed: {
    Icon: GitPullRequestClosedIcon,
    color: OPERATIONAL_STATUS_COLORS.failed.foreground,
  },
};

const RUN_ACTION_VARIANTS = {
  accent: 'primary',
  destructive: 'ghost-destructive',
  quiet: 'ghost-overlay',
} as const;

/** One job of the open run: its glyph, its name and how long it took. */
export function RunJobRows({
  run,
  dag,
  now,
  onJobClick,
}: {
  readonly run: BackgroundTrayRun;
  readonly dag: BackgroundTrayRunDag;
  readonly now: number;
  readonly onJobClick?: (runId: string, jobId: string) => void;
}): JSX.Element {
  const presentation = useContext(DrawerRowPresentationContext);
  const modal = presentation === 'modal';
  return (
    // The glyph the collapsed strip shows at 12px, here at the row's 14px,
    // always the round comet. Times end in the row's time column: past the
    // 56px action column and its 12px gap.
    <SpinnerStyleProvider value="comet">
      {/* One list per tier, in run order, read as one list: each job named
          with its state ("Build: running"), as the job bar named its dots. */}
      <div
        className={`${REPLAY_BLOCK_CLASS} flex flex-col gap-2 ${modal ? '' : presentation === 'legacy' ? 'pr-17' : 'pr-9.5'}`}
        data-testid="background-tray-run-jobs"
      >
        {dag.tiers.map((tier, index) => (
          <ul
            key={tier.join(' ') || String(index)}
            className="flex flex-col gap-2"
            data-testid="dag-progress-tier"
          >
            {tier.map((jobId) => {
              const job = dag.jobs[jobId];
              if (job === undefined) return null;
              const started = job.startedAt ? Date.parse(job.startedAt) : NaN;
              const ended = job.completedAt ? Date.parse(job.completedAt) : now;
              const time = Number.isNaN(started)
                ? null
                : formatElapsed(Math.max(0, ended - started));
              const state = runStatusGlyphState(job.status) ?? 'queued';
              const accessibleName = `${job.name}: ${job.status ?? 'pending'}`;
              const name = (
                <span className="min-w-0 flex-1 truncate text-left fg-primary">
                  {job.name}
                </span>
              );
              return (
                <li
                  key={jobId}
                  className="flex min-w-0 items-center gap-2.5"
                  data-job-state={state}
                  {...(onJobClick
                    ? {}
                    : { 'data-job-id': jobId, 'aria-label': accessibleName })}
                >
                  <span className="flex w-3.5 shrink-0 justify-center">
                    {presentation !== 'legacy' &&
                    state === 'paused' &&
                    run.status === 'needs-input' ? (
                      <CirclePauseIcon
                        size={14}
                        drawnStrokeWidth={1.5}
                        className="fg-warning-strong"
                        aria-hidden="true"
                      />
                    ) : (
                      <StatusGlyph state={state} size={14} />
                    )}
                  </span>
                  {onJobClick ? (
                    <button
                      type="button"
                      className="focus-ring flex min-w-0 flex-1 rounded-sm"
                      onClick={(): void => onJobClick(run.id, jobId)}
                      data-job-id={jobId}
                      aria-label={accessibleName}
                    >
                      {name}
                    </button>
                  ) : (
                    name
                  )}
                  {time !== null && (
                    <span className="shrink-0 text-s tabular-nums">{time}</span>
                  )}
                </li>
              );
            })}
          </ul>
        ))}
      </div>
    </SpinnerStyleProvider>
  );
}

function runElapsedLabel(run: BackgroundTrayRun, now: number): string {
  const fallback = run.statusLabel ?? RUN_STATUS_LABELS[run.status];
  if (run.startedAt === null) return fallback;
  if (!isFinishedTrayRun(run.status))
    return formatElapsed(Math.max(0, now - run.startedAt));
  const ends = Object.values(run.dag?.jobs ?? {})
    .flatMap((job) => (job.completedAt ? [Date.parse(job.completedAt)] : []))
    .filter((time) => Number.isFinite(time) && time >= (run.startedAt ?? 0));
  return ends.length > 0
    ? formatElapsed(Math.max(...ends) - run.startedAt)
    : fallback;
}

/**
 * A run's row and inspector (D6, D1b): its jobs as dots, elapsed time or
 * state, and one action; the inspector adds the full job bar and the run's
 * watcher, the question it waits on (three lines, D10) or its running job,
 * and Open run (Open on GitHub for a GitHub run).
 */
function LegacyRunRow({
  run,
  now,
  open,
  onToggle,
  listRef,
  topInset,
  ...actions
}: RunRowProps): JSX.Element {
  const presentation = useContext(DrawerRowPresentationContext);
  const redesigned = false;
  const elapsedLabel = runElapsedLabel(run, now);
  const statusLabel = run.statusLabel ?? RUN_STATUS_LABELS[run.status];
  const { onOpen, onJobClick, renderWatcher } = actions;
  const action = runAction(run, actions);
  const { handler } = action;
  const current = runningJobs(run.dag);
  const { Icon: PullRequestIcon, color: pullRequestColor } =
    PR_STATE_APPEARANCE[
      run.pullRequestState ??
        (run.status === 'succeeded'
          ? 'merged'
          : run.status === 'cancelled'
            ? 'closed'
            : 'open')
    ];
  const watcher = renderWatcher?.(run) ?? null;
  // Resume and Answer say what they do, unlike the › that opens View
  // completed, and take the time's place so the other rows' times stay put.
  const actionLabel =
    !redesigned || !handler
      ? null
      : action.suffix === 'resume'
        ? 'Resume'
        : action.suffix === 'respond'
          ? 'Answer'
          : null;
  // Names the labeled actions for their run, so a screen reader tells the
  // rows apart: as masked text, never an attribute, since session replay
  // records attributes verbatim.
  const actionRunName = (
    <span className="sr-only">
      {' '}
      <span className={REPLAY_MASK_CLASS}>{runDisplayName(run)}</span>
    </span>
  );
  // A paused run's way in sits beside Resume rather than under its jobs.
  const openBesideAction =
    actionLabel !== null && action.suffix === 'resume' && onOpen !== undefined;
  // A pull request has nothing to unfold: its row opens it on GitHub.
  const linkRow =
    redesigned && run.kind === 'github-pr' && presentation !== 'modal';
  // The strip of job glyphs, then what the run waits on.
  const note =
    run.status === 'needs-input'
      ? run.question
      : run.status === 'paused'
        ? RUN_STATUS_LABELS[run.status]
        : null;
  const dots =
    run.dag === null || run.dag.tiers.length === 0 ? null : (
      <span className={REPLAY_BLOCK_CLASS}>
        <DagProgressDots tiers={run.dag.tiers} jobs={run.dag.jobs} />
      </span>
    );
  const details =
    run.kind !== 'pipeline' ? (
      <p
        className={`min-w-0 flex-1 truncate ${redesigned ? '' : 'fg-secondary'}`}
      >
        <span className={REPLAY_BLOCK_CLASS}>{run.repository}</span>
        {current !== null && (
          <span className="fg-tertiary">
            {' · '}
            <span className={REPLAY_MASK_CLASS}>{current}</span>
            {' running'}
          </span>
        )}
        {run.note !== undefined && (
          <span
            className={`${REPLAY_BLOCK_CLASS} fg-tertiary`}
          >{` · ${run.note}`}</span>
        )}
      </p>
    ) : current !== null ? (
      <p
        className={`min-w-0 flex-1 truncate ${redesigned ? '' : 'fg-secondary'}`}
      >
        <span className={REPLAY_MASK_CLASS}>{current}</span>
        <span className="fg-tertiary"> · running</span>
      </p>
    ) : null;
  // With no job bar to sit beside, the watcher ends the details line.
  const watcherOnDetails = !redesigned && run.dag === null && details !== null;
  return (
    <DrawerRow
      rowKey={`run:${run.id}`}
      testId={`background-tray-run-${run.id}`}
      // Running: its kind's glyph and a shimmering name; otherwise where it
      // stands (waiting, paused, finished).
      glyph={
        run.kind === 'github-pr' ? (
          <PullRequestIcon
            size={14}
            aria-hidden="true"
            className={pullRequestColor}
          />
        ) : run.status !== 'running' ? (
          <StatusGlyph state={RUN_GLYPH_STATES[run.status]} size={14} />
        ) : run.kind === 'github' ? (
          <GitHubIcon size={14} aria-hidden="true" />
        ) : (
          <PipelineIcon size="sm" aria-hidden="true" />
        )
      }
      running={run.kind !== 'github-pr' && run.status === 'running'}
      name={<span className={REPLAY_MASK_CLASS}>{runDisplayName(run)}</span>}
      headerAccessory={
        redesigned &&
        (run.kind === 'pipeline' || linkRow) &&
        presentation !== 'modal'
          ? watcher
          : undefined
      }
      detail={
        dots === null && note === null ? undefined : (
          <span className="flex min-w-0 items-center gap-2">
            {dots}
            {note !== null && (
              <span className={`${REPLAY_BLOCK_CLASS} min-w-0 truncate`}>
                {note}
              </span>
            )}
          </span>
        )
      }
      trailing={
        actionLabel !== null ? (
          <span className="sr-only">{statusLabel}</span>
        ) : redesigned ? (
          <>
            {elapsedLabel}
            {elapsedLabel !== statusLabel && (
              <span className="sr-only"> · {statusLabel}</span>
            )}
          </>
        ) : run.status !== 'running' || run.startedAt === null ? (
          <span
            className={
              run.kind === 'github-pr' && run.status === 'succeeded'
                ? OPERATIONAL_STATUS_COLORS.merged.foreground
                : undefined
            }
          >
            {run.statusLabel ?? RUN_STATUS_LABELS[run.status]}
          </span>
        ) : run.startedAt !== null ? (
          formatElapsed(now - run.startedAt)
        ) : undefined
      }
      openAction={
        // Answer already opens this run to answer its pending question.
        onOpen && !(handler && action.suffix === 'respond') && !openBesideAction
          ? {
              label: run.kind === 'pipeline' ? 'Open run' : 'Open on GitHub',
              onClick: (): void => onOpen(run.id),
            }
          : undefined
      }
      attention={run.status === 'needs-input'}
      action={
        actionLabel !== null && handler ? (
          <span className="flex items-center gap-1">
            {openBesideAction && (
              <Button
                variant="ghost-overlay"
                size="compact"
                data-testid="background-tray-row-open"
                onClick={(): void => onOpen?.(run.id)}
              >
                Open run
                {actionRunName}
              </Button>
            )}
            <Button
              variant={action.tone === 'accent' ? 'primary' : 'secondary'}
              size="compact"
              data-testid={`background-tray-run-${run.id}-${action.suffix}`}
              onClick={(): void => handler(run.id)}
            >
              {actionLabel}
              {actionRunName}
            </Button>
          </span>
        ) : redesigned ? (
          handler && !isFinishedTrayRun(run.status) ? (
            <Tooltip label={action.label}>
              <Button
                variant={action.tone === 'accent' ? 'primary' : 'ghost-overlay'}
                size="compact"
                iconOnly
                aria-label={runActionAriaLabel(run, action.suffix)}
                data-testid={`background-tray-run-${run.id}-${action.suffix}`}
                onClick={(): void => handler(run.id)}
              >
                <StopFilledIcon size="xs" />
              </Button>
            </Tooltip>
          ) : undefined
        ) : handler ? (
          <Button
            variant={RUN_ACTION_VARIANTS[action.tone]}
            size="sm"
            className="min-w-full"
            aria-label={runActionAriaLabel(run, action.suffix)}
            data-testid={`background-tray-run-${run.id}-${action.suffix}`}
            onClick={(): void => handler(run.id)}
          >
            {action.label}
          </Button>
        ) : undefined
      }
      inspector={
        linkRow
          ? undefined
          : {
              open,
              onToggle,
              footer:
                redesigned &&
                watcher !== null &&
                !isFinishedTrayRun(run.status) ? (
                  run.kind === 'pipeline' ? (
                    <p className="min-w-0 flex-1">
                      The result will be sent to this chat when it finishes.
                    </p>
                  ) : (
                    watcher
                  )
                ) : undefined,
              render: (): JSX.Element => (
                <>
                  {redesigned &&
                    run.status === 'needs-input' &&
                    run.question !== null && (
                      <InspectorSubtitle>
                        <p
                          className={`${REPLAY_BLOCK_CLASS} whitespace-pre-wrap break-words`}
                          data-testid="background-tray-run-question"
                        >
                          {run.question}
                        </p>
                      </InspectorSubtitle>
                    )}
                  {redesigned && details !== null && (
                    <InspectorSubtitle>{details}</InspectorSubtitle>
                  )}
                  {run.dag !== null &&
                    run.dag.tiers.some((tier) => tier.length > 0) && (
                      <InspectorSection>
                        <RunJobRows
                          run={run}
                          dag={run.dag}
                          now={now}
                          onJobClick={onJobClick}
                        />
                      </InspectorSection>
                    )}
                  {!redesigned && watcher !== null && !watcherOnDetails && (
                    <div className="flex min-w-0 items-center">{watcher}</div>
                  )}
                  {!redesigned &&
                    run.status === 'needs-input' &&
                    run.question !== null && (
                      // Pipeline authors write the question; it may quote the run's
                      // inputs.
                      <p
                        className={`${REPLAY_BLOCK_CLASS} line-clamp-3 fg-secondary`}
                        data-testid="background-tray-run-question"
                      >
                        {run.question}
                      </p>
                    )}
                  {watcherOnDetails ? (
                    <div className="flex min-w-0 items-center gap-2">
                      {details}
                      {watcher}
                    </div>
                  ) : (
                    !redesigned && details
                  )}
                  {!redesigned && onOpen && (
                    <InspectorOpenAction
                      label={
                        run.kind === 'pipeline' ? 'Open run' : 'Open on GitHub'
                      }
                      onClick={(): void => onOpen(run.id)}
                    />
                  )}
                </>
              ),
            }
      }
      listRef={listRef}
      topInset={topInset}
    />
  );
}

export function RunRow(props: RunRowProps): JSX.Element {
  const presentation = useContext(DrawerRowPresentationContext);
  return presentation === 'legacy' ? (
    <LegacyRunRow {...props} />
  ) : (
    <DrawerRunRow {...props} />
  );
}

/** The shared drawer keeps its summary intact; disclosure adds only new information. */
function DrawerRunRow({
  run,
  now,
  open,
  onToggle,
  listRef,
  topInset,
  ...actions
}: RunRowProps): JSX.Element {
  const { onOpen, onRespond, onResume, onStop, onJobClick, renderWatcher } =
    actions;
  const paused = run.status === 'paused';
  const needsInput = run.status === 'needs-input';
  const finished = isFinishedTrayRun(run.status);
  const isPr = run.kind === 'github-pr';
  const hasJobs = run.dag !== null && Object.keys(run.dag.jobs).length > 0;
  const hasDetails =
    !isPr && (hasJobs || Boolean(run.note) || Boolean(run.repository));
  const prAppearance =
    PR_STATE_APPEARANCE[
      run.pullRequestState ??
        (run.status === 'succeeded'
          ? 'merged'
          : run.status === 'cancelled'
            ? 'closed'
            : 'open')
    ];
  const Glyph = prAppearance.Icon;
  const elapsed = runElapsedLabel(run, now);
  const label = run.statusLabel ?? RUN_STATUS_LABELS[run.status];
  // Tabular digits keep the ticking time from shifting, wherever the status
  // shows (beside the name, or as the detail before the job dots).
  const status =
    elapsed === label
      ? label
      : joinDetails([label, <span className="tabular-nums">{elapsed}</span>]);
  const actionRunName = (
    <span className="sr-only">
      {' '}
      <span className={REPLAY_MASK_CLASS}>{runDisplayName(run)}</span>
    </span>
  );
  const action =
    needsInput && onRespond ? (
      // Ghost buttons beside it sit flush; a filled button keeps 4px from
      // them.
      <span className="flex pl-1">
        <Button
          variant="primary"
          size="compact"
          data-testid={`background-tray-run-${run.id}-respond`}
          onClick={() => onRespond(run.id)}
        >
          Answer{actionRunName}
        </Button>
      </span>
    ) : paused ? (
      <span className="flex items-center">
        {onOpen && (
          <Button
            variant="ghost-overlay"
            size="compact"
            data-testid="background-tray-row-open"
            onClick={() => onOpen(run.id)}
          >
            Open run{actionRunName}
          </Button>
        )}
        <Tooltip
          label={
            onResume ? 'Resume run' : 'Resume is not available in this view.'
          }
        >
          <span className="inline-flex">
            <Button
              variant="ghost-overlay"
              size="compact"
              iconOnly
              aria-label="Resume run"
              disabled={!onResume}
              aria-description={
                onResume ? undefined : 'Resume is not available in this view.'
              }
              data-testid={`background-tray-run-${run.id}-resume`}
              onClick={() => onResume?.(run.id)}
            >
              <PlayIcon size="sm" fill="currentColor" />
              {actionRunName}
            </Button>
          </span>
        </Tooltip>
      </span>
    ) : !finished && run.kind === 'pipeline' ? (
      <Tooltip
        label={onStop ? 'Stop run' : 'Stop is not available in this view.'}
      >
        <span className="inline-flex">
          <Button
            variant="ghost-overlay"
            size="compact"
            iconOnly
            aria-label="Stop run"
            disabled={!onStop}
            aria-description={
              onStop ? undefined : 'Stop is not available in this view.'
            }
            data-testid={`background-tray-run-${run.id}-stop`}
            onClick={() => onStop?.(run.id)}
          >
            <StopFilledIcon size="sm" />
          </Button>
        </span>
      </Tooltip>
    ) : undefined;
  const jobDots =
    run.dag && hasJobs ? (
      // A flex box, not a line of text, so the strip centres on the row
      // instead of sitting on the text's baseline.
      <span className={`${REPLAY_BLOCK_CLASS} flex`}>
        <DagProgressDots tiers={run.dag.tiers} jobs={run.dag.jobs} />
      </span>
    ) : undefined;
  return (
    <DrawerRow
      rowKey={`run:${run.id}`}
      testId={`background-tray-run-${run.id}`}
      listRef={listRef}
      topInset={topInset}
      glyph={
        isPr ? (
          <Glyph size="sm" className={prAppearance.color} />
        ) : run.status !== 'running' ? (
          <StatusGlyph state={RUN_GLYPH_STATES[run.status]} size={14} />
        ) : run.kind === 'github' ? (
          <GitHubIcon size="sm" />
        ) : (
          <PipelineIcon size="sm" />
        )
      }
      name={<span className={REPLAY_MASK_CLASS}>{runDisplayName(run)}</span>}
      detail={
        isPr ? undefined : needsInput ? (
          <span
            className={REPLAY_BLOCK_CLASS}
            data-testid="background-tray-run-question"
          >
            {run.question}
          </span>
        ) : paused ? (
          'Paused'
        ) : jobDots ? (
          // Where it stands reads first, beside the name; the job dots
          // follow it.
          status
        ) : undefined
      }
      status={isPr || paused || needsInput || jobDots ? undefined : status}
      // After the text with a plain gap, no dot: separators join text items
      // only, and the job dots are not text.
      trailing={
        isPr && run.diffStats ? (
          <GroupedDiffStats
            insertions={run.diffStats.insertions}
            deletions={run.diffStats.deletions}
          />
        ) : !isPr && !paused && !needsInput ? (
          jobDots
        ) : undefined
      }
      trailingOverflow={isPr ? 'keep' : 'clip'}
      headerAccessory={renderWatcher?.(run)}
      running={run.kind !== 'github-pr' && run.status === 'running'}
      attention={needsInput}
      action={action}
      openAction={
        onOpen && !paused && !(needsInput && onRespond)
          ? {
              label: run.kind === 'pipeline' ? 'Open run' : 'Open on GitHub',
              onClick: () => onOpen(run.id),
              external: run.kind !== 'pipeline',
            }
          : undefined
      }
      inspector={
        hasDetails
          ? {
              open,
              onToggle,
              render: () => (
                <>
                  {run.repository && (
                    <p className={`${REPLAY_BLOCK_CLASS} text-s fg-tertiary`}>
                      {run.repository}
                    </p>
                  )}
                  {run.note && (
                    <p className={`${REPLAY_BLOCK_CLASS} text-s fg-secondary`}>
                      {run.note}
                    </p>
                  )}
                  {run.dag && hasJobs && (
                    <RunJobRows
                      run={run}
                      dag={run.dag}
                      now={now}
                      onJobClick={onJobClick}
                    />
                  )}
                </>
              ),
            }
          : undefined
      }
    />
  );
}
