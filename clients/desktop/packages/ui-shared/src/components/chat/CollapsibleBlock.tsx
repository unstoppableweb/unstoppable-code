import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';
import { useState, type JSX, type ReactNode } from 'react';
import { LightbulbIcon } from '../../icons/AppIcons';
import { STEP_ROW_BODY_CLASS, StepRow } from './StepRow';

/** A headline drawn from the thoughts is their content: replay blocks it. */
function blockedHeadline(headline: string | undefined): ReactNode {
  return headline === undefined ? undefined : (
    <span className={REPLAY_BLOCK_CLASS}>{headline}</span>
  );
}

export interface CollapsibleBlockProps {
  forceExpanded?: boolean;
  label: string;
  content: string;
  /** Override the leading icon; defaults to the thinking lightbulb. */
  icon?: ReactNode;
  /**
   * The block is still being written, so its label
   * shimmers. When it is done the row reads {@link doneLabel} if given.
   */
  running?: boolean;
  /** The label once the block is done ("Thought"). */
  doneLabel?: string;
}

const HEADLINE_PATTERN = /^\s*\*\*([^*\n]+)\*\*\s*$/gm;

/**
 * The latest headline in a reasoning summary, the bold line Codex and other
 * agents start each thought with ("**Checking worktree statuses**").
 */
export function thinkingHeadline(content: string): string | undefined {
  let headline: string | undefined;
  for (const match of content.matchAll(HEADLINE_PATTERN)) {
    const text = match[1]?.trim();
    if (text) headline = text;
  }
  return headline;
}

/**
 * Shared collapsed transcript block (Thinking, tool results, generic parts).
 * One source of truth for the desktop chat renderer and the web portal so
 * icons, preview text, and expansion chrome cannot drift apart.
 */
export function CollapsibleBlock({
  label,
  content,
  icon,
  forceExpanded = false,
  running = false,
  doneLabel,
}: CollapsibleBlockProps): JSX.Element {
  const [open, setIsOpen] = useState(false);
  const isOpen = forceExpanded || open;
  // Clean chat look: a step row like the rest, so its words line up with
  // theirs; the latest headline of the thoughts so far ("Checking worktree
  // statuses") shimmers while it runs; the opened text reads as quiet prose.

  return (
    <div data-chat-disclosure="">
      <StepRow
        step
        icon={icon ?? <LightbulbIcon />}
        label={
          running
            ? (blockedHeadline(thinkingHeadline(content)) ?? label)
            : (doneLabel ?? label)
        }
        running={running}
        expandable
        isOpen={isOpen}
        onToggle={(): void => setIsOpen((prev) => !prev)}
      />
      {isOpen && (
        <div
          className={`${REPLAY_BLOCK_CLASS} ${STEP_ROW_BODY_CLASS} max-h-75 overflow-auto whitespace-pre-wrap break-words fg-tertiary`}
          data-chat-reveal-body=""
        >
          {content}
        </div>
      )}
    </div>
  );
}
