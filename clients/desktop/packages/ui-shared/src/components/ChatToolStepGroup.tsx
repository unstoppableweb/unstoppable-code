'use client';

import {
  memo,
  useLayoutEffect,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { ChevronDownIcon, ChevronRightIcon } from '../icons';
import { ThinkingSpinner } from './ThinkingSpinner';
import { StepTenseProvider, useCleanChatLook } from './chat-look';
import {
  STEP_GROUP_BODY_CLASS,
  STEP_GROUP_NESTED_BODY_CLASS,
  StepRow,
} from './chat/StepRow';
import type { ChatToolStepLive } from './chat/live-tool-activity';
import { TOOL_APPROVAL_WAITING_LABEL } from './chat/tool-approval-wait';
import { TurnOutcomeWords } from './chat/TurnOutcomeWords';

/**
 * One transcript row standing in for a run of agent steps (tool calls, and
 * thinking when the host counts it). Closed, it reads like "Searched 3 times,
 * read 4 files"; while a call still runs, its label and a spinner follow the
 * summary. Opening it shows every step (`children`), as the host renders
 * them, and they keep updating while the turn runs.
 *
 * `liveSteps` (CAN-4274) are the newest steps of a run the turn is still
 * adding to; they show under the closed row instead of the running label,
 * since their own row already spins. Hosts own segmentation and the summary
 * text; this component is display only.
 *
 * Under the clean chat look a run is every step between two replies, drawn
 * as one closed line (see `groupCleanSteps`).
 */
export const ChatToolStepGroup = memo(function ChatToolStepGroup({
  summary,
  runningLabel,
  runningWaiting = false,
  forceExpanded = false,
  openRequest,
  liveSteps,
  hiddenSteps,
  collapsedStepCount,
  trailingActivity,
  children,
  icon,
  failedCount = 0,
  blockedCount = 0,
  interruptedCount = 0,
  live,
  inset = true,
}: {
  /** Plain-words summary of every step in the run. */
  summary: string;
  /** Label of the call still running, when the turn is running. */
  runningLabel?: ReactNode;
  /** The running label's call waits for approval: no spinner, a note instead. */
  runningWaiting?: boolean;
  /** Opens the group without changing its saved state (search reveal). */
  forceExpanded?: boolean;
  /**
   * Opens the group as saved state once per new object, so a host can reveal
   * a step and the person can still close the group.
   */
  openRequest?: object;
  /** The newest steps, shown under the closed row while the run is live. */
  liveSteps?: ReactNode;
  /** Only the hidden prefix, so expanding leaves the recent rows mounted. */
  hiddenSteps?: ReactNode;
  /** A summary must stand for at least two calls, never one. */
  collapsedStepCount?: number;
  /** Current activity after the visible recent calls. */
  trailingActivity?: ReactNode;
  /** Every step in the run, rendered when the group is open. */
  children?: ReactNode;
  /**
   * The run's kind of step. Under the clean chat look the group leads with
   * it, like a step row.
   */
  icon?: ReactNode;
  /** Clean chat look: how many steps ran into an error, said quietly after the words. */
  failedCount?: number;
  /**
   * Clean chat look: how many steps an approval rule or the person stopped
   * before they ran, said before the errors ("· 2 blocked · 1 error").
   */
  blockedCount?: number;
  /**
   * Clean chat look: how many steps were cut off without a result, said
   * after the errors ("· 1 error · 1 interrupted").
   */
  interruptedCount?: number;
  /**
   * Clean chat look: the run is the running turn's tail. Its line shimmers
   * what the turn is doing now ("Running pnpm test", "Thinking") instead of
   * the summary, in the same place, so nothing moves as steps arrive. A
   * call waiting for approval says so ("Waiting to run pnpm test") and holds
   * still.
   */
  live?: ChatToolStepLive;
  /**
   * Clean chat look: the line's own 12px text inset. Off where its host
   * already insets it (the web timer row inside its message).
   */
  inset?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState<boolean | null>(null);
  // A host reveal opens the group as saved state, so it can be closed again.
  useLayoutEffect(() => {
    if (openRequest) setOpen(true);
  }, [openRequest]);
  const clean = useCleanChatLook();
  if (clean) {
    if (collapsedStepCount !== undefined && collapsedStepCount < 2) {
      return (
        <div
          className={STEP_GROUP_BODY_CLASS}
          data-testid="chat-tool-step-live"
        >
          {children}
          {trailingActivity}
          {trailingActivity == null && live?.showWhenUngrouped && (
            <div className={`flex min-w-0 max-w-full${inset ? ' px-3' : ''}`}>
              <StepRow label={live.label} icon={live.icon} running />
            </div>
          )}
        </div>
      );
    }
    // Clean chat look: one closed line per run, live or done; only the
    // person opens it, so steps never pop open and fold away while they
    // stream.
    const isOpen = forceExpanded || open === true;
    const expandable = children !== undefined && children !== null;
    const waiting = live?.waiting === true;
    return (
      <div
        data-testid="chat-tool-step-group"
        data-chat-disclosure=""
        data-live={live === undefined ? undefined : ''}
        data-tool-approval={waiting ? 'waiting' : undefined}
      >
        <div className={`flex min-w-0 max-w-full${inset ? ' px-3' : ''}`}>
          <StepRow
            prioritizeDetail
            step={live !== undefined}
            icon={live === undefined ? icon : live.icon}
            label={
              <span data-testid="chat-tool-step-summary">
                {live === undefined ? (
                  summary
                ) : (
                  <StepTenseProvider value={waiting ? 'waiting' : 'running'}>
                    {live.label}
                  </StepTenseProvider>
                )}
              </span>
            }
            detail={
              waiting ? (
                <span data-testid="chat-tool-step-waiting">
                  {TOOL_APPROVAL_WAITING_LABEL}
                </span>
              ) : live === undefined &&
                (blockedCount > 0 ||
                  failedCount > 0 ||
                  interruptedCount > 0) ? (
                <TurnOutcomeWords
                  outcomes={{
                    blocked: blockedCount,
                    failed: failedCount,
                    interrupted: interruptedCount,
                  }}
                  entryTestIdPrefix="chat-tool-step"
                />
              ) : undefined
            }
            running={live !== undefined && !waiting}
            expandable={expandable}
            isOpen={isOpen}
            onToggle={(): void => setOpen(!isOpen)}
          />
        </div>
        {isOpen && expandable ? (
          <div
            className={STEP_GROUP_NESTED_BODY_CLASS}
            data-chat-reveal-body=""
          >
            {hiddenSteps ?? children}
          </div>
        ) : null}
        {liveSteps !== undefined ? (
          // "Show only recent steps": the newest steps stay in view under
          // the closed line while the run is live.
          <div
            className={STEP_GROUP_NESTED_BODY_CLASS}
            data-testid="chat-tool-step-live"
          >
            {liveSteps}
            {trailingActivity}
          </div>
        ) : null}
      </div>
    );
  }
  const isOpen = forceExpanded || (open ?? false);
  const showLiveSteps = liveSteps !== undefined && !isOpen;
  const running = showLiveSteps ? undefined : runningLabel;
  const hasRunning = running !== undefined && running !== null;

  return (
    <div data-testid="chat-tool-step-group">
      <div className="flex min-w-0 max-w-full px-3">
        <button
          type="button"
          onClick={(): void => setOpen((previous) => !(previous ?? false))}
          aria-expanded={isOpen}
          className="flex min-w-0 max-w-full items-center gap-2 py-1 text-left text-xs fg-secondary transition-colors hover:fg-primary"
        >
          <span className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center">
            {isOpen ? <ChevronDownIcon /> : <ChevronRightIcon />}
          </span>
          <span
            className={hasRunning ? 'flex-shrink-0' : 'min-w-0 truncate'}
            data-testid="chat-tool-step-summary"
          >
            {summary}
          </span>
          {hasRunning ? (
            <span className="flex min-w-0 items-center gap-2">
              <span aria-hidden="true" className="fg-tertiary">
                ·
              </span>
              <span
                className="min-w-0 truncate fg-primary"
                data-testid="chat-tool-step-running"
              >
                {running}
              </span>
              {runningWaiting ? (
                <span
                  className="flex-shrink-0 fg-tertiary"
                  data-testid="chat-tool-step-waiting"
                >
                  {TOOL_APPROVAL_WAITING_LABEL}
                </span>
              ) : (
                <span className="inline-flex flex-shrink-0 -translate-y-px fg-accent">
                  <ThinkingSpinner />
                </span>
              )}
            </span>
          ) : null}
        </button>
      </div>
      {isOpen ? <div className="pl-5.5">{children}</div> : null}
      {showLiveSteps ? (
        <div className="pl-5.5" data-testid="chat-tool-step-live">
          {liveSteps}
        </div>
      ) : null}
    </div>
  );
});
