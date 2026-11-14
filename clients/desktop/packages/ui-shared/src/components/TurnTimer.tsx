import {
  useEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type ComponentPropsWithoutRef,
} from 'react';
import { ChatToolStepGroup } from './ChatToolStepGroup';
import { ChatCopyAction } from './chat/ChatCopyAction';
import { PlanCopyAction, type PlanCopyState } from './chat/PlanCopyAction';
import type { TurnCompletionStatus } from './chat/turn-completion-status';
import { Tooltip } from './Tooltip';
import {
  completionStampTooltip,
  formatCompletionTimestamp,
} from '../lib/format-completion-timestamp';

export interface TurnTimerProps {
  /** Epoch ms when the turn started. When omitted, no elapsed time is
   * shown and the indicator reads as a plain working/completed state. */
  startedAt?: number;
  /** Epoch ms when the turn finished. Falsy means the turn is still
   * running. */
  finishedAt?: number | null;
  /** Epoch ms when the turn paused while waiting on user input. */
  pausedAt?: number | null;
  /** Epoch ms when the paused turn resumed after user input. */
  resumedAt?: number | null;
  /** Total completed pause time from previous pause/resume cycles. */
  accumulatedPausedDurationMs?: number;
  /**
   * The host shows a request waiting on the user for this unfinished turn
   * (desktop: a pending tool approval for the turn's chat). Pauses the timer
   * in the same render as that request, before its committed pause arrives.
   * `false` never overrides a pause the timer's own fields record, and a
   * finished turn ignores it.
   */
  waitingForUser?: boolean;
  /** Force a live ticking timer. Defaults to true when `finishedAt` is
   * not set. The web portal may pass `isStreaming=false` even without a
   * finish timestamp to render the simple "Working..." pill. */
  isStreaming?: boolean;
  /**
   * Optional inline trailing action (e.g., a Fork-chat button). Rendered
   * after the elapsed-time label in both live and completed states; callers
   * should pass content that is appropriate while the timer is still running.
   */
  trailing?: ReactNode;
  /**
   * Clean chat look: while the turn runs, the row holds this live line
   * ("Thinking") instead of its actions, which the host shows in the turn's
   * header. The row keeps its height from the first frame to the last, so
   * the reply above never moves when the turn finishes. Pass `null` while a
   * step line above already says what the turn is doing; left out, a running
   * row says "Thinking" (or the working label) on its own.
   */
  liveLine?: ReactNode;
  /**
   * Optional control rendered right after the completion stamp and, like the
   * stamp, always visible (CAN-1521's turn-level thumbs up/down, CAN-4278).
   */
  stampAccessory?: ReactNode;
  /**
   * The finished reply's text. Shows a Copy button once the turn completes
   * (CAN-4704). Classic look: right after the completion stamp, ahead of the
   * thumbs, visible at rest like them. Clean look: ahead of the row's other
   * actions.
   */
  copyText?: string;
  /**
   * The finished turn proposes a plan: its Copy plan action replaces the
   * reply's Copy, in the same place, and stays in view while the plan's
   * Markdown is unavailable (CAN-5354).
   */
  planCopy?: PlanCopyState;
  /**
   * Clean chat look: the "…" menu (a {@link TurnMoreMenu}) with the turn's
   * less-used actions, after the inline icons.
   */
  moreMenu?: ReactNode;
  /**
   * Clean chat look: the model routing picked, named in the time's tooltip
   * instead of a chip in the row.
   */
  modelLabel?: string;
  /**
   * Opt into the desktop transcript's row insets: the user bubble's `px-3`
   * text inset, so the timer shares one left edge with the flat assistant
   * prose above it, plus the wider bottom gap that separates a finished turn
   * from the next one.
   *
   * Opt-in rather than baked in, because it is a desktop layout decision: the
   * web portal and the shared Code tab render this row in padding-free
   * wrappers, and insetting it there pushes the timer off the left edge its
   * own prose sits on.
   */
  inset?: boolean;
  /**
   * Set when the host column already separates turns with an 8px gap that
   * does not collapse with this row's bottom margin (a flex `gap-2` column).
   * The row then trims its own margin so the gap to the next turn matches
   * desktop, where the 20px margin collapses with the turn spacing (CAN-4278).
   */
  hostTurnGap?: boolean;
  /**
   * Replaces the live `Working...` label while the host knows what the turn
   * is doing (e.g. `Compacting context…`). Ignored once the timer is paused
   * or completed.
   */
  workingLabel?: string;
  /**
   * Outcome shown once the turn has stopped; resolve it with
   * `resolveTurnCompletionStatus`.
   */
  completionStatus?: TurnCompletionStatus;
}

/**
 * Reveal rules for the hover-only parts of a successfully completed footer
 * (CAN-4278). Timer rows stay visible; separate action slots can opt into
 * this reveal policy. Faded parts
 * stay in the layout, tab order, and accessibility tree; only their opacity
 * changes, so revealing them never moves the transcript. No transition: the
 * reveal is intentionally instant.
 *
 * - `group-hover/turn`: the transcript's per-turn wrapper is hovered.
 * - `group-data-[hover]/turn`: the same reveal driven from a hoisted sticky
 *   prompt, which sits outside its own turn wrapper and so cannot trigger
 *   `group-hover` through the DOM.
 * - `group-focus-within/turn`: keyboard focus anywhere inside the turn,
 *   including the row's own actions.
 * - `group-data-[focus-within]/footer`: focus inside the footer row as React
 *   reports it, which also covers portaled menus opened from the row.
 * - `pointer-coarse` / `hover:none`: touch and other no-hover devices keep
 *   the row visible, since nothing there could reveal it.
 */
/** The footer's first word for each way a turn ends. */
const TURN_COMPLETION_LABELS: Record<TurnCompletionStatus, string> = {
  complete: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};

const ROW_REVEAL_CLASSNAME =
  'opacity-0 group-hover/turn:opacity-100 group-data-[hover]/turn:opacity-100 group-focus-within/turn:opacity-100 group-data-[focus-within]/footer:opacity-100 pointer-coarse:opacity-100 [@media(hover:none)]:opacity-100';

/** Shared policy for timer rows and separately mounted turn action slots. */
function turnFooterRevealClassName(
  completed: boolean,
  completionStatus: TurnTimerProps['completionStatus'] = 'complete',
  alwaysVisible = false,
): string {
  return completed && completionStatus === 'complete' && !alwaysVisible
    ? ROW_REVEAL_CLASSNAME
    : '';
}

/**
 * One hover-only part of a turn footer, for hosts that mount their own
 * actions in a {@link TurnFooterRow}. It applies the same reveal policy as the
 * timer row's label and trailing actions.
 */
export function TurnFooterReveal({
  completed,
  completionStatus,
  alwaysVisible = false,
  children,
  ...props
}: Omit<ComponentPropsWithoutRef<'span'>, 'className'> & {
  completed: boolean;
  completionStatus?: TurnTimerProps['completionStatus'];
  alwaysVisible?: boolean;
}): JSX.Element {
  const reveal = turnFooterRevealClassName(
    completed,
    completionStatus,
    alwaysVisible,
  );
  return (
    <span
      {...props}
      className={`flex items-center gap-0.5 pointer-coarse:gap-4${reveal ? ` ${reveal}` : ''}`}
    >
      {children}
    </span>
  );
}

/**
 * Document events after which a row that holds focus re-checks it. React
 * delivers no blur when the focused element unmounts (facebook/react#12363),
 * for example a menu item that closes its own menu on click or Escape.
 */
const FOCUS_RECHECK_EVENTS = [
  'click',
  'focusin',
  'pointerdown',
  'keydown',
  'keyup',
];

/**
 * The clean chat look's footer controls (copy, fork, "•••", thumbs) are the
 * shared ghost `Button`, which owns their 28px capsule, ink, hover and focus;
 * the row only keeps their icons at 14px.
 */
const CLEAN_TURN_FOOTER_CONTROLS_CLASSNAME = '[&_svg]:size-3.5';

/**
 * A turn footer row. The row itself never fades, so its height never changes;
 * hover-only parts fade through {@link TurnFooterReveal} or TurnTimer.
 * React focus events include portaled descendants, unlike CSS focus-within,
 * so the row tracks focus itself and exposes it as `data-focus-within`.
 */
export function TurnFooterRow({
  variant = 'timer',
  inset = false,
  hostTurnGap = false,
  children,
  ...props
}: Omit<
  ComponentPropsWithoutRef<'div'>,
  'className' | 'onFocusCapture' | 'onBlurCapture'
> & {
  variant?: 'timer' | 'actions';
  inset?: boolean;
  hostTurnGap?: boolean;
}): JSX.Element {
  const [focusWithin, setFocusWithin] = useState(false);
  const focusedRef = useRef<Element | null>(null);
  useEffect(() => {
    if (!focusWithin) return undefined;
    // A popped-out panel renders the row in another window's document.
    const ownerDocument = focusedRef.current?.ownerDocument ?? document;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const recheck = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      // Run after the event's handlers, so React has recorded any new focus.
      timer = setTimeout(() => {
        const focused = focusedRef.current;
        if (
          focused?.isConnected === true &&
          focused.ownerDocument.activeElement === focused
        )
          return;
        focusedRef.current = null;
        setFocusWithin(false);
      }, 0);
    };
    for (const type of FOCUS_RECHECK_EVENTS)
      ownerDocument.addEventListener(type, recheck, true);
    return (): void => {
      for (const type of FOCUS_RECHECK_EVENTS)
        ownerDocument.removeEventListener(type, recheck, true);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [focusWithin]);
  // Clean chat look: the row is one more line in the turn's rhythm, in the
  // step rows' text, rather than a small stamp tucked under the last row.

  const className =
    variant === 'actions'
      ? `group/footer flex justify-end gap-0.5 pointer-coarse:gap-4 ${CLEAN_TURN_FOOTER_CONTROLS_CLASSNAME}`
      : `group/footer flex min-h-7 items-center gap-1.5 pointer-coarse:gap-4 text-s fg-secondary ${inset ? 'px-3' : ''} ${hostTurnGap ? 'mb-3' : 'mb-5'} ${CLEAN_TURN_FOOTER_CONTROLS_CLASSNAME}`;
  return (
    <div
      {...props}
      data-focus-within={focusWithin ? '' : undefined}
      // Paint containment must not clip focus rings or enlarged hit targets.
      // Keep it only on inactive fine-pointer rows; touch rows stay uncontained.
      className={`${className} content-auto group-hover/turn:content-visible group-data-[hover]/turn:content-visible focus-within:content-visible data-[focus-within]:content-visible pointer-coarse:content-visible [@media(hover:none)]:content-visible`}
      // `auto` remembers the measured height of inactive historical rows.
      style={{
        ...props.style,
        containIntrinsicSize: 'auto 28px',
      }}
      onFocusCapture={(event): void => {
        focusedRef.current = event.target;
        setFocusWithin(true);
      }}
      // Moving focus between two controls in the row fires the next focus
      // event right after this blur, which marks the row again.
      onBlurCapture={(): void => setFocusWithin(false)}
    >
      {children}
    </div>
  );
}

/**
 * A turn's elapsed whole seconds minus its pauses. Older saved timers carry
 * `pausedAt`/`resumedAt` without a pause total, so that interval stands in.
 */
export function getElapsedSecond(
  startedAt: number | undefined,
  finishedAt: number | null | undefined,
  pausedAt?: number | null,
  resumedAt?: number | null,
  accumulatedPausedDurationMs?: number,
): number | null {
  if (
    startedAt == null ||
    [
      startedAt,
      finishedAt,
      pausedAt,
      resumedAt,
      accumulatedPausedDurationMs,
    ].some((value) => value != null && !Number.isFinite(value))
  )
    return null;
  const endAt = finishedAt ?? Date.now();
  const completedPauseMs =
    typeof accumulatedPausedDurationMs === 'number'
      ? Math.max(0, accumulatedPausedDurationMs)
      : pausedAt != null && resumedAt != null
        ? Math.max(0, resumedAt - Math.max(startedAt, pausedAt))
        : 0;
  const activePauseMs =
    pausedAt == null || resumedAt != null
      ? 0
      : Math.max(0, endAt - Math.max(startedAt, pausedAt));
  return Math.max(
    0,
    Math.floor((endAt - startedAt - completedPauseMs - activePauseMs) / 1000),
  );
}

/**
 * Self-ticking completion-stamp label ("just now" / "5m ago" / "10:11 AM" /
 * "Apr 10, 9:15 AM") for a completed turn. Completed turn groups are frozen
 * by referential identity upstream (incremental-turn-groups), so the label
 * must re-render itself; the refresh cadence tracks the label's own
 * transitions ("just now" flips at exactly one minute, the minutes tier moves
 * every minute, and the clock-time tiers only change at day rollover) and
 * state only changes when the text changes.
 */
function useCompletionStampLabel(timestamp: number | null): string | null {
  const [label, setLabel] = useState<string | null>(() =>
    timestamp != null ? formatCompletionTimestamp(timestamp) : null,
  );

  useEffect((): (() => void) | undefined => {
    if (timestamp == null) {
      setLabel(null);
      return undefined;
    }
    setLabel(formatCompletionTimestamp(timestamp));
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = (): void => {
      const ageMs = Date.now() - timestamp;
      const delay =
        ageMs < 60_000
          ? Math.max(60_000 - ageMs, 1_000)
          : ageMs < 3_600_000
            ? 30_000
            : 60_000;
      timer = setTimeout((): void => {
        setLabel(formatCompletionTimestamp(timestamp));
        arm();
      }, delay);
    };
    arm();
    return (): void => {
      if (timer != null) clearTimeout(timer);
    };
  }, [timestamp]);

  return timestamp != null ? label : null;
}

/**
 * Whether an unfinished turn is paused: its own fields record an open pause,
 * or the host shows a request waiting on the user. A finished turn never is.
 */
export function isTurnTimerPaused({
  finishedAt,
  pausedAt,
  resumedAt,
  waitingForUser,
}: {
  finishedAt?: number | null;
  pausedAt?: number | null;
  resumedAt?: number | null;
  waitingForUser?: boolean;
}): boolean {
  return (
    finishedAt == null &&
    ((pausedAt != null && resumedAt == null) || waitingForUser === true)
  );
}

/** The completed pause time the timer's own fields record. */
function completedPauseMs(
  startedAt: number,
  pausedAt: number | null | undefined,
  resumedAt: number | null | undefined,
  accumulatedPausedDurationMs: number | undefined,
): number {
  if (typeof accumulatedPausedDurationMs === 'number')
    return Math.max(0, accumulatedPausedDurationMs);
  return pausedAt != null && resumedAt != null
    ? Math.max(0, resumedAt - Math.max(startedAt, pausedAt))
    : 0;
}

/**
 * A turn's elapsed whole seconds, minus pauses, ticking once a second while
 * `live`. Null without a start time.
 *
 * While the host waits on the user before the turn's own pause is recorded,
 * the wait starts at a boundary captured once for that turn's uninterrupted
 * wait: rerenders and replaced timer objects never move it. The recorded
 * pause replaces it once it arrives, so the wait is subtracted once; a pause
 * recorded slightly earlier than the boundary may correct the time a little.
 * The boundary is presentation only and resets with the turn's start.
 */
export function useTurnElapsedSecond({
  startedAt,
  finishedAt,
  pausedAt,
  resumedAt,
  accumulatedPausedDurationMs,
  waitingForUser = false,
  live,
}: {
  startedAt?: number;
  finishedAt?: number | null;
  pausedAt?: number | null;
  resumedAt?: number | null;
  accumulatedPausedDurationMs?: number;
  waitingForUser?: boolean;
  live: boolean;
}): number | null {
  // The host waits before the timer's own fields record a pause.
  const hostWaitOnly =
    waitingForUser &&
    startedAt != null &&
    finishedAt == null &&
    !(pausedAt != null && resumedAt == null);
  const waitBoundaryRef = useRef<{ startedAt: number; atMs: number } | null>(
    null,
  );
  const [displayedSecond, setDisplayedSecond] = useState(() =>
    getElapsedSecond(
      startedAt,
      finishedAt,
      pausedAt,
      resumedAt,
      accumulatedPausedDurationMs,
    ),
  );
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const displayedSecondRef = useRef(displayedSecond);

  useEffect(() => {
    displayedSecondRef.current = displayedSecond;
  }, [displayedSecond]);

  useEffect((): (() => void) => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    let effectivePausedAt = pausedAt;
    let effectiveResumedAt = resumedAt;
    let effectivePausedDurationMs = accumulatedPausedDurationMs;
    if (hostWaitOnly && startedAt != null) {
      let boundary =
        waitBoundaryRef.current?.startedAt === startedAt
          ? waitBoundaryRef.current.atMs
          : Date.now();
      // Delivery may skip the open pause and bring its closed interval while
      // the host still waits. Move past that interval before deducting its
      // committed duration, so the provisional endpoint does not count it twice.
      if (
        pausedAt != null &&
        resumedAt != null &&
        pausedAt <= boundary &&
        resumedAt > boundary
      ) {
        boundary = resumedAt;
      }
      waitBoundaryRef.current = { startedAt, atMs: boundary };
      effectivePausedDurationMs = completedPauseMs(
        startedAt,
        pausedAt,
        resumedAt,
        accumulatedPausedDurationMs,
      );
      effectivePausedAt = boundary;
      effectiveResumedAt = null;
    } else {
      waitBoundaryRef.current = null;
    }

    const initial = getElapsedSecond(
      startedAt,
      live ? null : (finishedAt ?? effectivePausedAt),
      effectivePausedAt,
      effectiveResumedAt,
      effectivePausedDurationMs,
    );
    if (displayedSecondRef.current !== initial) {
      displayedSecondRef.current = initial;
      setDisplayedSecond(initial);
    }

    if (!live || startedAt == null) {
      return (): void => undefined;
    }
    intervalRef.current = setInterval((): void => {
      const next = getElapsedSecond(
        startedAt,
        null,
        pausedAt,
        resumedAt,
        accumulatedPausedDurationMs,
      );
      if (displayedSecondRef.current !== next) {
        displayedSecondRef.current = next;
        setDisplayedSecond(next);
      }
    }, 1000);
    return (): void => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [
    accumulatedPausedDurationMs,
    finishedAt,
    hostWaitOnly,
    live,
    pausedAt,
    resumedAt,
    startedAt,
  ]);

  return displayedSecond;
}

/** A paused turn's status label, before its elapsed time. */
export const TURN_WAITING_LABEL = 'Waiting for you';

export function formatTurnElapsed(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`;
  }
  return `${minutes}:${String(remaining).padStart(2, '0')}`;
}

/**
 * Pure display timer indicator for an in-flight chat turn. Mirrors the
 * canopy desktop TurnTimer footprint (live ticking elapsed time, then
 * "Completed in M:SS" / "Completed in H:MM:SS" on finish), while also supporting the simpler web
 * portal variant where the host already knows whether the turn is
 * streaming and does not have a `startedAt` timestamp.
 */
export function TurnTimer({
  startedAt,
  finishedAt,
  pausedAt,
  resumedAt,
  accumulatedPausedDurationMs,
  waitingForUser,
  isStreaming,
  trailing,
  liveLine,
  stampAccessory,
  copyText,
  planCopy,
  moreMenu,
  modelLabel,
  inset = false,
  hostTurnGap = false,
  workingLabel,
  completionStatus = 'complete',
}: TurnTimerProps): JSX.Element {
  // Clean chat look: the turn's header owns the elapsed time ("Working for
  // 28s") and the transcript's live line what the turn is doing, so this
  // row keeps only its stamp and actions.

  const resolvedWorkingLabel = workingLabel ?? 'Working…';
  const paused = isTurnTimerPaused({
    finishedAt,
    pausedAt,
    resumedAt,
    waitingForUser,
  });
  const live =
    finishedAt == null &&
    !paused &&
    (isStreaming === undefined ? finishedAt == null : isStreaming === true);
  const displayedSecond = useTurnElapsedSecond({
    startedAt,
    finishedAt,
    pausedAt,
    resumedAt,
    accumulatedPausedDurationMs,
    waitingForUser,
    live,
  });

  const completionLabel = TURN_COMPLETION_LABELS[completionStatus];
  let label: string;
  if (displayedSecond != null) {
    const formatted = formatTurnElapsed(displayedSecond);
    label = live
      ? `${resolvedWorkingLabel} ${formatted}`
      : paused
        ? `${TURN_WAITING_LABEL} · ${formatted}`
        : `${completionLabel} ${completionStatus === 'complete' ? 'in' : 'after'} ${formatted}`;
  } else {
    label = live
      ? resolvedWorkingLabel
      : paused
        ? TURN_WAITING_LABEL
        : completionLabel;
  }

  const state: 'live' | 'paused' | 'completed' = live
    ? 'live'
    : paused
      ? 'paused'
      : 'completed';

  const completedAtMs =
    state === 'completed' && finishedAt != null ? finishedAt : null;
  const completedTitle =
    completedAtMs != null
      ? `${completionLabel} at ${new Date(completedAtMs).toLocaleString()}`
      : undefined;
  const relativeLabel = useCompletionStampLabel(completedAtMs);
  // The timestamp and the thumbs beside it lead the row and stay visible as
  // the delimiter between turns; everything else fades in on turn hover or
  // focus. Opacity only, so the row never changes height.
  // A running turn keeps its controls (watch, fork, auto-archive) in view,
  // so an armed watcher or auto-archive is always visible. Clean chat look:
  // the reply row is always in view, in its quiet ink.
  const reveal = turnFooterRevealClassName(
    state === 'completed',
    completionStatus,
    true,
  );
  const replyToCopy =
    state === 'completed' && copyText !== undefined && copyText.trim() !== ''
      ? copyText
      : undefined;
  // A plan turn keeps exactly one copy action: its plan's.
  const copyAction =
    state !== 'completed' ? undefined : planCopy !== undefined ? (
      <PlanCopyAction
        state={planCopy}
        appearance="footer"
        dataTestId="turn-copy-plan"
      />
    ) : replyToCopy !== undefined ? (
      <ChatCopyAction text={replyToCopy} dataTestId="turn-copy-message" />
    ) : undefined;
  // Clean chat look: a finished turn's row drops "Completed in …", but a
  // failed, cancelled or interrupted turn keeps its outcome so it never
  // reads as done.
  const outcomeShown = state === 'completed' && completionStatus !== 'complete';
  // The running turn's live line in the transcript says what it is doing,
  // so this row never does: it only holds the turn's actions, in place.

  if (state !== 'completed') {
    // Clean chat look, running or paused: the row is the live line's slot,
    // the same height with or without it. The line brings its own inset. A
    // paused turn is not working, so it holds no live line.
    return (
      <TurnFooterRow
        hostTurnGap={hostTurnGap}
        data-testid="turn-timer"
        data-state={state}
      >
        {state !== 'live' ? null : liveLine === undefined ? (
          <ChatToolStepGroup
            summary=""
            inset={inset}
            live={{
              label: workingLabel ?? 'Thinking',
              icon: null,
            }}
          />
        ) : (
          liveLine
        )}
      </TurnFooterRow>
    );
  }

  return (
    <TurnFooterRow
      inset={inset}
      hostTurnGap={hostTurnGap}
      data-testid="turn-timer"
      data-state={state}
    >
      {outcomeShown && (
        <span
          data-testid="turn-timer-label"
          className="min-w-0 truncate whitespace-nowrap tabular-nums"
          title={completedTitle}
        >
          {label}
        </span>
      )}

      {/* Clean chat look: Copy, Fork, "•••" for the rest, the thumbs, then
          the time, all in one quiet gray, the icons 2px apart; always in
          view, never only on hover. */}
      {(copyAction !== undefined ||
        stampAccessory != null ||
        trailing != null ||
        moreMenu != null) && (
        <span
          data-testid="turn-actions"
          // Leading the row, the first icon (not its 28px button) lines up
          // with the reply's text.
          className={`flex items-center gap-0.5 pointer-coarse:gap-4${outcomeShown ? '' : ' -ml-1.75'}`}
        >
          {copyAction}
          <span
            data-testid="turn-actions-reveal"
            className={`flex items-center gap-0.5 pointer-coarse:gap-4${reveal ? ` ${reveal}` : ''}`}
          >
            {trailing}
            {moreMenu}
            {stampAccessory != null && (
              <span
                data-testid="turn-timer-stamp-accessory"
                className="flex shrink-0 items-center gap-0.5 pointer-coarse:gap-4"
              >
                {stampAccessory}
              </span>
            )}
          </span>
        </span>
      )}
      {relativeLabel != null &&
        completedAtMs != null &&
        ((): JSX.Element => {
          const stamp = (
            <span
              data-testid="turn-timer-relative"
              // Timestamps keep their quiet ink while the turn is hovered or focused.
              className={`ml-1 shrink-0 whitespace-nowrap text-xs proportional-nums fg-tertiary ${reveal}`}
            >
              {relativeLabel}
            </span>
          );
          // Only what the stamp doesn't already say: the exact time behind
          // "5m ago", the model. Never the stamp again.
          const hover = completionStampTooltip(completedAtMs, modelLabel);
          return hover === undefined ? (
            stamp
          ) : (
            <Tooltip label={hover}>{stamp}</Tooltip>
          );
        })()}
    </TurnFooterRow>
  );
}
