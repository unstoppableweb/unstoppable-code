'use client';

import {
  Button,
  ControlButton,
  DagProgressDots,
  StatusGlyph,
  type DagJobMeta,
} from '@canopy/ui-shared/components';
import { StepRow } from '@canopy/ui-shared/components/chat';
import {
  memo,
  useId,
  useMemo,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import {
  formatRelativeTime,
  type StatusBadgeTone,
  type StatusGlyphState,
} from '@canopy/ui-shared/lib';
import { ArrowUpRightIcon, GitHubIcon } from '@canopy/ui-shared/icons/AppIcons';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { githubWorkflowJobTiers } from './github-workflow-job-tiers';
import {
  githubWorkflowDefinitionTiers,
  type GitHubWorkflowRunRowGraph,
} from './github-workflow-definition-tiers';

/**
 * Structural mirror of the desktop `GitHubWorkflowRunState` union. Declared
 * here so this package stays free of `@canopy/desktop-shared`; the desktop
 * card maps its typed snapshot into this shape.
 */
export type GitHubWorkflowRunRowState =
  | { readonly kind: 'intermediate'; readonly status: string }
  | { readonly kind: 'terminal'; readonly conclusion: string }
  | {
      readonly kind: 'unsupported';
      readonly status: string | null;
      readonly conclusion: string | null;
      readonly terminal: boolean;
    };

export type { GitHubWorkflowRunRowJob } from '@canopy/ui-shared/lib/github-workflow-display';
export { githubWorkflowJobDagStatus } from '@canopy/ui-shared/lib/github-workflow-display';
import {
  githubWorkflowJobDagStatus,
  type GitHubWorkflowRunRowJob,
} from '@canopy/ui-shared/lib/github-workflow-display';

export interface GitHubWorkflowRunRowData {
  readonly repository: string;
  readonly runId: string;
  readonly runAttempt: number;
  readonly workflowName?: string;
  readonly runNumber?: number;
  readonly htmlUrl: string;
  readonly state: GitHubWorkflowRunRowState;
  readonly startedAt?: string;
  readonly observedAt: string;
  /** Absent until the watcher's first jobs read. */
  readonly jobs?: readonly GitHubWorkflowRunRowJob[];
  /**
   * The run's declared job graph, when its workflow definition was read.
   * Drives the tiers and shows jobs GitHub has not created yet as pending.
   */
  readonly definition?: GitHubWorkflowRunRowGraph;
}

export interface GitHubWorkflowRunRowStatus {
  /** Lower-case pill label matching the pipeline run pill vocabulary. */
  readonly label: string;
  readonly tone: StatusBadgeTone;
  readonly muted: boolean;
  /** True while GitHub still reports the run as not completed. */
  readonly active: boolean;
}

const INTERMEDIATE_LABELS: Readonly<Record<string, string>> = {
  requested: 'requested',
  queued: 'queued',
  pending: 'pending',
  waiting: 'waiting',
  in_progress: 'in progress',
};

const TERMINAL_LABELS: Readonly<Record<string, string>> = {
  action_required: 'action required',
  cancelled: 'cancelled',
  failure: 'failure',
  neutral: 'neutral',
  skipped: 'skipped',
  stale: 'stale',
  startup_failure: 'startup failure',
  success: 'success',
  timed_out: 'timed out',
};

function terminalTone(conclusion: string): StatusBadgeTone {
  switch (conclusion) {
    case 'success':
      return 'success';
    case 'failure':
    case 'timed_out':
    case 'startup_failure':
      return 'failed';
    case 'action_required':
      return 'warning';
    case 'cancelled':
      return 'paused';
    default:
      return 'neutral';
  }
}

/** Run state → status pill presentation. */
export function githubWorkflowRunRowStatus(
  state: GitHubWorkflowRunRowState,
): GitHubWorkflowRunRowStatus {
  if (state.kind === 'intermediate') {
    const label =
      INTERMEDIATE_LABELS[state.status] ?? state.status.replace(/_/g, ' ');
    return state.status === 'in_progress'
      ? { label, tone: 'active', muted: false, active: true }
      : { label, tone: 'paused', muted: true, active: true };
  }
  if (state.kind === 'terminal') {
    return {
      label:
        TERMINAL_LABELS[state.conclusion] ??
        state.conclusion.replace(/_/g, ' '),
      tone: terminalTone(state.conclusion),
      muted: false,
      active: false,
    };
  }
  const raw = state.terminal ? state.conclusion : state.status;
  return {
    label: raw
      ? raw.replace(/_/g, ' ')
      : state.terminal
        ? 'completed'
        : 'running',
    tone: 'neutral',
    muted: !state.terminal,
    active: !state.terminal,
  };
}

/** `CI #42 · attempt 2`, falling back to the run id when GitHub gave no name. */
export function githubWorkflowRunRowTitle(
  run: Pick<
    GitHubWorkflowRunRowData,
    'workflowName' | 'runNumber' | 'runId' | 'runAttempt'
  >,
): string {
  const workflowName = run.workflowName?.trim();
  const runRef =
    run.runNumber !== undefined ? `#${run.runNumber}` : `#${run.runId}`;
  const lead = workflowName ? `${workflowName} ${runRef}` : `Run ${runRef}`;
  return run.runAttempt > 1 ? `${lead} · attempt ${run.runAttempt}` : lead;
}

/** GitHub conclusions the shared job status folds into `skipped`. */
const JOB_OUTCOME_LABELS: Readonly<Record<string, string>> = {
  skipped: 'Skipped',
  neutral: 'Neutral',
  stale: 'Stale',
};

/** The run's tiers and jobs, before outcome labels. */
function githubWorkflowRunTiers(
  run: Pick<GitHubWorkflowRunRowData, 'definition' | 'jobs'>,
): { tiers: string[][]; jobs: Record<string, DagJobMeta> } {
  const observed = run.jobs ?? [];
  if (run.definition && run.definition.jobs.length > 0) {
    return githubWorkflowDefinitionTiers(run.definition, observed);
  }
  return {
    tiers: githubWorkflowJobTiers(observed),
    jobs: Object.fromEntries(
      observed.map((job) => [
        job.jobId,
        {
          jobId: job.jobId,
          name: job.name,
          status: githubWorkflowJobDagStatus(job),
          ...(job.startedAt ? { startedAt: job.startedAt } : {}),
          ...(job.completedAt ? { completedAt: job.completedAt } : {}),
        },
      ]),
    ),
  };
}

/**
 * A run's jobs as the DAG progress bar draws them: tiers from its declared
 * job graph when known, else inferred from when GitHub created each job.
 * A job GitHub ended as skipped, neutral or stale carries that word, since
 * all three draw as one status.
 */
export function githubWorkflowRunDag(
  run: Pick<GitHubWorkflowRunRowData, 'definition' | 'jobs'>,
): { tiers: string[][]; jobs: Record<string, DagJobMeta> } {
  const layout = githubWorkflowRunTiers(run);
  const jobs = { ...layout.jobs };
  for (const observed of run.jobs ?? []) {
    const meta = jobs[observed.jobId];
    const label =
      observed.status === 'completed' && observed.conclusion !== null
        ? JOB_OUTCOME_LABELS[observed.conclusion]
        : undefined;
    if (meta !== undefined && label !== undefined) {
      jobs[observed.jobId] = { ...meta, outcomeLabel: label };
    }
  }
  return { tiers: layout.tiers, jobs };
}

/**
 * The row's trailing glyph: the run's state as every other row draws it. A
 * run that ended without an outcome of its own (skipped, neutral, stale, or a
 * conclusion this app does not know) has none; its words say what it was.
 */
function githubWorkflowRunGlyphState(
  status: GitHubWorkflowRunRowStatus,
): StatusGlyphState | null {
  if (status.active) return status.tone === 'active' ? 'running' : 'queued';
  switch (status.tone) {
    case 'success':
      return 'done';
    case 'failed':
      return 'failed';
    case 'warning':
      return 'needs-you';
    case 'paused':
      return 'cancelled';
    default:
      return null;
  }
}

/**
 * Past this many jobs, or in a row under 28rem wide, the row names the
 * number of jobs instead of drawing a dot for each.
 */
const MAX_JOB_DOTS = 12;

/** A job's state in words, for the row's description. */
const JOB_STATUS_WORDS: Readonly<
  Record<NonNullable<DagJobMeta['status']>, string>
> = {
  pending: 'not started',
  running: 'running',
  restarting: 'restarting',
  success: 'passed',
  failure: 'failed',
  paused: 'waiting',
  cancelled: 'cancelled',
  skipped: 'skipped',
};

/**
 * What the job dots show, in words: each job with its state in run order,
 * or a count per state when the run has more jobs than the row draws.
 */
export function githubWorkflowRunJobsDescription(
  tiers: readonly (readonly string[])[],
  jobs: Readonly<Record<string, DagJobMeta>>,
): string | undefined {
  const ordered = tiers.flat().flatMap((jobId) => {
    const job = jobs[jobId];
    return job ? [job] : [];
  });
  if (ordered.length === 0) return undefined;
  const state = (job: DagJobMeta): string =>
    job.outcomeLabel !== undefined
      ? job.outcomeLabel.toLowerCase()
      : job.status === undefined
        ? 'not started'
        : JOB_STATUS_WORDS[job.status];
  if (ordered.length <= MAX_JOB_DOTS) {
    return `Jobs: ${ordered.map((job) => `${job.name} ${state(job)}`).join(', ')}.`;
  }
  const counts = new Map<string, number>();
  for (const job of ordered) {
    counts.set(state(job), (counts.get(state(job)) ?? 0) + 1);
  }
  return `${ordered.length} jobs: ${[...counts].map(([word, count]) => `${count} ${word}`).join(', ')}.`;
}

export interface GitHubWorkflowRunRowProps {
  run: GitHubWorkflowRunRowData;
  /** Opens the run on GitHub; the row's words are the affordance. */
  onOpen: () => void;
  /**
   * The run's jobs as a list, shown under the row when its jobs control is
   * opened. Without it the dots and the count are plain marks.
   */
  renderJobs?: () => ReactNode;
  /** The run's watcher button, at the row's end. */
  renderWatcherButton?: () => ReactNode;
  dataTestId?: string;
}

/**
 * One watched GitHub Actions run as an Agent activity row, in the grammar of
 * the capability rows beside it: the GitHub mark, the workflow title, then
 * its state, repository and start time as details, with one dot per job (a
 * count past twelve jobs or in a narrow row) and the state's glyph at the
 * end. With the run's workflow definition the dots follow the declared
 * `needs` graph and jobs GitHub has not created yet show as pending
 * (`githubWorkflowDefinitionTiers`); without it, tiers are inferred from when
 * GitHub created each job (`githubWorkflowJobTiers`).
 *
 * The row's words open the run on GitHub. The dots are a second control: it
 * opens the list of jobs under the row, each with its name and state.
 */
export const GitHubWorkflowRunRow = memo(function GitHubWorkflowRunRow({
  run,
  onOpen,
  renderJobs,
  renderWatcherButton,
  dataTestId,
}: GitHubWorkflowRunRowProps): JSX.Element {
  const status = githubWorkflowRunRowStatus(run.state);
  const title = githubWorkflowRunRowTitle(run);
  const layout = useMemo(
    () => githubWorkflowRunDag({ definition: run.definition, jobs: run.jobs }),
    [run.definition, run.jobs],
  );
  const glyphState = githubWorkflowRunGlyphState(status);
  const details = [
    // Named at the row's end instead when the outcome has no glyph.
    glyphState === null ? undefined : status.label,
    run.repository,
    run.startedAt ? formatRelativeTime(run.startedAt) : undefined,
  ]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join(' · ');
  const watcher = renderWatcherButton?.();
  // What the row shows that its name does not: when the run started and
  // what each dot stands for.
  const description = [
    run.startedAt ? `Started ${formatRelativeTime(run.startedAt)}.` : undefined,
    githubWorkflowRunJobsDescription(layout.tiers, layout.jobs),
  ]
    .filter((part): part is string => part !== undefined)
    .join(' ');
  const descriptionId = useId();
  const jobsListId = useId();
  const [jobsOpen, setJobsOpen] = useState(false);
  const jobCount = Object.keys(layout.jobs).length;
  const drawsDots = jobCount <= MAX_JOB_DOTS;
  // The dots in a wide row; the count in a narrow one, and for a strip too
  // long to sit beside the run's words.
  const jobMarks =
    jobCount === 0 ? null : (
      <>
        {drawsDots ? (
          <span className={`${REPLAY_BLOCK_CLASS} hidden @min-md/run:flex`}>
            <DagProgressDots tiers={layout.tiers} jobs={layout.jobs} />
          </span>
        ) : null}
        <span
          className={`text-xs tabular-nums fg-tertiary ${drawsDots ? '@min-md/run:hidden' : ''}`}
        >
          {jobCount} {jobCount === 1 ? 'job' : 'jobs'}
        </span>
      </>
    );
  return (
    <div
      // A container, so the row can trade its job dots for a count when it
      // is too narrow to hold them beside the title.
      className="@container/run flex min-w-0 flex-col"
      data-testid={dataTestId ?? `github-workflow-run-card-${run.runId}`}
      data-run-status={status.label}
    >
      <div className="relative flex min-w-0 items-center gap-1">
        <ControlButton
          type="button"
          data-testid={`github-workflow-run-open-${run.runId}`}
          presentation="capability-trigger"
          appearance={{ row: true }}
          onClick={onOpen}
          aria-label={`Open ${title} in ${run.repository} on GitHub, ${status.label}`}
          aria-describedby={description === '' ? undefined : descriptionId}
        >
          <StepRow
            step
            icon={<GitHubIcon size="sm" />}
            label={title}
            detail={`· ${details}`}
            extent="fill"
            trailing={
              <span className="flex shrink-0 fg-tertiary" aria-hidden="true">
                <ArrowUpRightIcon size="sm" />
              </span>
            }
          />
        </ControlButton>
        {jobMarks === null ? null : renderJobs === undefined ? (
          <span className="flex h-5 shrink-0 items-center">{jobMarks}</span>
        ) : (
          <Button
            variant="ghost"
            size="compact"
            aria-expanded={jobsOpen}
            aria-controls={jobsListId}
            aria-label={`${jobsOpen ? 'Hide' : 'Show'} jobs of ${title}`}
            onClick={(): void => setJobsOpen((open) => !open)}
            data-testid={`github-workflow-run-jobs-${run.runId}`}
          >
            {jobMarks}
          </Button>
        )}
        <span className="flex h-5 shrink-0 items-center pr-1">
          {glyphState === null ? (
            // An outcome with no glyph of its own (skipped, neutral, stale) is named
            // here, where it cannot be cut off with the details.
            <span className="text-xs fg-tertiary">{status.label}</span>
          ) : (
            <StatusGlyph state={glyphState} size={14} />
          )}
        </span>
        {description === '' ? null : (
          // The dots are marks; this names the start time and each job's
          // state for the link.
          <span id={descriptionId} className={`${REPLAY_BLOCK_CLASS} sr-only`}>
            {description}
          </span>
        )}
        {watcher ? <div className="shrink-0">{watcher}</div> : null}
      </div>
      {jobsOpen && renderJobs !== undefined ? (
        // Under the row's words: the jobs start where the title does.
        <div id={jobsListId} className="pt-1 pb-2 pl-6 text-xs">
          {renderJobs()}
        </div>
      ) : null}
    </div>
  );
});
