import {
  forwardRef,
  type JSX,
  type MouseEventHandler,
  type ReactNode,
} from 'react';
import { REPLAY_MASK_CLASS } from '../../lib/replay-privacy';
import { LoadingSpinner } from '../LoadingSpinner';
import { STEP_ROW_TEXT_CLASS, StepRow } from './StepRow';
import {
  TURN_WAITING_LABEL,
  formatTurnElapsed,
  isTurnTimerPaused,
  useTurnElapsedSecond,
} from '../TurnTimer';
import type { TurnCompletionStatus } from './turn-completion-status';

export interface TurnWorkHeaderProps {
  /** Epoch ms when the turn started. */
  startedAt?: number;
  /** Epoch ms when the turn finished; empty while it runs. */
  finishedAt?: number | null;
  pausedAt?: number | null;
  resumedAt?: number | null;
  accumulatedPausedDurationMs?: number;
  /** The host shows a request waiting on the user; see `TurnTimerProps`. */
  waitingForUser?: boolean;
  /** The turn's total time, for hosts that only know that (web summaries). */
  elapsedMs?: number;
  /** Whether the turn is still running. Defaults to no `finishedAt`. */
  live?: boolean;
  /** How the turn ended; resolve it with `resolveTurnCompletionStatus`. */
  completionStatus?: TurnCompletionStatus;
  /** Whether the header folds the turn's steps; draws the chevron. */
  expandable?: boolean;
  isOpen?: boolean;
  onToggle?: MouseEventHandler<HTMLButtonElement>;
  ariaLabel?: string;
  /** What the turn did, in words, shown on hover. */
  title?: string;
  /** Words after the label, inside the toggle, in a lighter ink. */
  detail?: ReactNode;
  /**
   * A control of its own after the toggle and its chevron, such as a
   * finished turn's blocked, errored and interrupted steps (`TurnOutcomeControl`). It is
   * a sibling of the toggle, so its clicks never fold the turn.
   */
  outcome?: ReactNode;
  /** Count hook shared with classic summaries, without changing the wording. */
  stepCount?: number;
  /**
   * The header renders in a sticky head under its prompt. It ends at its
   * hairline; the head keeps the space below it, outside its backdrop.
   */
  pinned?: boolean;
  /**
   * Controls at the row's end: the running turn's watch, fork and
   * auto-archive actions, in view (and pinned with the header) while it runs.
   */
  trailing?: ReactNode;
  dataTestId?: string;
  /**
   * The turn was submitted but has no visible output yet: reads
   * "Starting…" as a polite status with no ticking time, so assistive tech
   * hears it once. The other timing props are ignored.
   */
  starting?: boolean;
  /**
   * With `starting`: the chat's worktree is still being set up, so the
   * status reads "Setting up this chat's copy of <project>" with a clock
   * from `startedAtMs`, until the host drops it and the same status reads
   * "Starting…". Resolve it with `resolveTurnStartingStatus`.
   */
  setup?: TurnStartingSetup;
}

/** The setup a starting turn waits on, as `TurnWorkHeader` shows it. */
export interface TurnStartingSetup {
  projectName?: string;
  /** Epoch ms the setup began; the clock counts up from here. */
  startedAtMs: number;
}

/** The pending turn's status label. */
export const TURN_STARTING_LABEL = 'Starting…';

/** Setup status words before the project name. */
export const TURN_SETUP_LABEL_PREFIX = "Setting up this chat's copy of ";

/** Stands in for a project with no name. */
export const TURN_SETUP_FALLBACK_PROJECT_NAME = 'the project';

export type TurnStartingStatus =
  | ({ kind: 'setup' } & TurnStartingSetup)
  | { kind: 'starting' }
  | null;

/**
 * What a turn's starting slot shows on every host. A starting turn whose
 * worktree's Git setup is still pending shows the setup status, clocked from
 * the worktree's creation (so a repair detour counts), else from the user
 * message; a starting turn otherwise reads "Starting…". Only `git-pending`
 * counts: the host holds the turn for Git setup alone.
 */
export function resolveTurnStartingStatus({
  starting,
  worktreeSetupPhase,
  worktreeCreatedAt,
  fallbackStartedAtMs,
  projectName,
  nowMs,
}: {
  starting: boolean;
  worktreeSetupPhase?: string | null;
  /** ISO string on desktop and Portal rows, epoch ms on cloud worktrees. */
  worktreeCreatedAt?: string | number | null;
  fallbackStartedAtMs?: number;
  projectName?: string | null;
  nowMs: number;
}): TurnStartingStatus {
  if (!starting) return null;
  if (worktreeSetupPhase !== 'git-pending') return { kind: 'starting' };
  const createdAtMs =
    typeof worktreeCreatedAt === 'number'
      ? worktreeCreatedAt
      : typeof worktreeCreatedAt === 'string'
        ? Date.parse(worktreeCreatedAt)
        : Number.NaN;
  const origin = Number.isFinite(createdAtMs)
    ? createdAtMs
    : (fallbackStartedAtMs ?? nowMs);
  const name = projectName?.trim();
  return {
    kind: 'setup',
    ...(name ? { projectName: name } : {}),
    startedAtMs: Math.min(origin, nowMs),
  };
}

/** Visible reply/activity ends the first send's pending status on every host. */
export function isStartingTurnOutput(kind: string, data: unknown): boolean {
  if (kind === 'tool_use' && typeof data === 'object' && data !== null) {
    const toolName =
      'toolName' in data && typeof data.toolName === 'string'
        ? data.toolName
        : 'name' in data
          ? data.name
          : undefined;
    if (toolName === 'EnterPlanMode') return false;
  }
  if (
    kind === 'image' ||
    kind === 'tool_use' ||
    kind === 'agent' ||
    kind === 'delegated_agent_call' ||
    kind === 'codex_agent' ||
    kind === 'workflow'
  )
    return true;
  if (kind !== 'text' && kind !== 'thinking') return false;
  const text =
    typeof data === 'string'
      ? data
      : typeof data === 'object' && data !== null && 'text' in data
        ? data.text
        : undefined;
  return typeof text === 'string' && text.trim().length > 0;
}

/** "28s", "3m 24s", "1h 5m": the header's duration, in words. */
export function formatWorkDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0)
    return remaining > 0 ? `${minutes}m ${remaining}s` : `${minutes}m`;
  return `${remaining}s`;
}

function headerLabel(
  state: 'setup' | 'starting' | 'live' | 'paused' | 'done',
  completionStatus: TurnWorkHeaderProps['completionStatus'],
  seconds: number | null,
): string {
  if (state === 'setup' || state === 'starting') return TURN_STARTING_LABEL;
  const time = seconds === null ? '' : formatWorkDuration(seconds);
  if (state === 'paused')
    return seconds === null
      ? TURN_WAITING_LABEL
      : `${TURN_WAITING_LABEL} · ${formatTurnElapsed(seconds)}`;
  if (state === 'live') return time ? `Working for ${time}` : 'Working';
  if (completionStatus === 'failed')
    return time ? `Failed after ${time}` : 'Failed';
  if (completionStatus === 'cancelled')
    return time ? `Stopped after ${time}` : 'Stopped';
  if (completionStatus === 'interrupted')
    return time ? `Interrupted after ${time}` : 'Interrupted';
  return time ? `Worked for ${time}` : 'Worked';
}

/**
 * The clean chat look's turn header, after the Codex app: "Working for 28s"
 * over a hairline while the turn runs, then "Worked for 3m 24s" with a
 * chevron that opens the steps the finished turn folded away.
 */
export const TurnWorkHeader = forwardRef<
  HTMLButtonElement,
  TurnWorkHeaderProps
>(function TurnWorkHeader(
  {
    startedAt,
    finishedAt,
    pausedAt,
    resumedAt,
    accumulatedPausedDurationMs,
    waitingForUser,
    elapsedMs,
    live,
    completionStatus = 'complete',
    expandable = false,
    isOpen = false,
    onToggle,
    ariaLabel,
    title,
    detail,
    outcome,
    stepCount,
    trailing,
    pinned = false,
    dataTestId,
    starting = false,
    setup,
  },
  ref,
): JSX.Element {
  const inSetup = starting && setup !== undefined;
  const running =
    !starting && finishedAt == null && (live ?? elapsedMs === undefined);
  const paused =
    running &&
    isTurnTimerPaused({ finishedAt, pausedAt, resumedAt, waitingForUser });
  const tickingSecond = useTurnElapsedSecond(
    inSetup
      ? { startedAt: setup.startedAtMs, live: true }
      : {
          startedAt,
          finishedAt,
          pausedAt,
          resumedAt,
          accumulatedPausedDurationMs,
          waitingForUser: running && waitingForUser === true,
          live: running && !paused,
        },
  );
  const seconds =
    elapsedMs !== undefined && !inSetup
      ? Math.max(0, Math.floor(elapsedMs / 1000))
      : tickingSecond;
  const state = inSetup
    ? 'setup'
    : starting
      ? 'starting'
      : paused
        ? 'paused'
        : running
          ? 'live'
          : 'done';
  const label = headerLabel(state, completionStatus, seconds);
  // One step row like every other, in the same text, starting at the step
  // icons' left edge, with a hairline under it that closes the header. It
  // sits apart from the prompt (24px of ink gap) and close to its hairline
  // (12px), with 20px from the hairline to the reply, whether the prompt is
  // in the turn or pinned above it (padding, not margin, so a pinned
  // header's backdrop covers it). A `pinned` header ends at its hairline: its
  // head supplies the space below, outside the backdrop, so content scrolling
  // under it is cut at the line. A starting turn has no steps for the
  // hairline to close yet, so it shows the working spinner and no hairline.
  // Its words are one polite status node whether they read setup or
  // "Starting…", so the hand-off is announced once; the setup clock sits
  // outside that node and is silent. A foldable header is one control: its
  // toggle stretches over the whole row, under the outcome and the actions.
  const foldable = !starting && expandable;
  return (
    <div
      className={`px-3 pt-2${pinned ? '' : ' pb-1'}${foldable ? ' relative' : ''}`}
      data-testid={dataTestId}
      data-turn-header={state}
    >
      <div
        className={`flex min-w-0 items-center gap-2 pb-1${starting ? '' : ' border-b'}`}
      >
        <StepRow
          ref={ref}
          icon={
            starting ? (
              <LoadingSpinner
                sizePx={14}
                decorative
                dataTestId="turn-starting-spinner"
              />
            ) : undefined
          }
          label={
            // Proportional figures: nothing follows the ticking time, so its
            // width changing moves nothing.
            <span title={title} data-turn-step-count={stepCount}>
              {starting ? (
                <>
                  <span role="status" aria-live="polite">
                    {inSetup ? (
                      <>
                        {TURN_SETUP_LABEL_PREFIX}
                        <span className={REPLAY_MASK_CLASS}>
                          {setup.projectName ??
                            TURN_SETUP_FALLBACK_PROJECT_NAME}
                        </span>
                      </>
                    ) : (
                      label
                    )}
                  </span>
                  {inSetup ? (
                    <span aria-hidden="true" data-turn-setup-clock="">
                      {` · ${formatTurnElapsed(seconds ?? 0)}`}
                    </span>
                  ) : null}
                </>
              ) : (
                label
              )}
            </span>
          }
          detail={detail}
          expandable={foldable}
          stretched={foldable}
          isOpen={isOpen}
          onToggle={onToggle}
          revealScope="turn"
          ariaLabel={ariaLabel}
          chevronAtRest
        />
        {outcome != null ? (
          // 6px after the chevron, as a step row's detail sits after its words.
          <span
            className={`relative -ml-0.5 flex min-w-0 items-center ${STEP_ROW_TEXT_CLASS}`}
            data-turn-work-header-outcome=""
          >
            {outcome}
          </span>
        ) : null}
        {trailing != null ? (
          <span
            className="relative ml-auto flex flex-shrink-0 items-center gap-0.5"
            data-testid="turn-work-header-actions"
          >
            {trailing}
          </span>
        ) : null}
      </div>
    </div>
  );
});
