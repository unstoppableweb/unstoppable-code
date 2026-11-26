import { useEffect, useState, type JSX, type ReactNode } from 'react';
import { CometSpinner } from '../../primitives/CometSpinner';
import { HoverCardIconSlot } from '../HoverCardIconSlot';
import { CircleXIcon, QuestionMarkIcon } from '../../icons/AppIcons';
import { formatRelativeTime } from '../../lib/format-relative-time';
import { OPERATIONAL_STATUS_COLORS } from '../../lib/operational-status-colors';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';
import { ChatTabPreviewReplyTicker } from './ChatTabPreviewReplyTicker';

/** What the chat is doing, as its preview card's status row says it. */
export type ChatTabPreviewStatus =
  /** A turn is running; `startedAt` (epoch ms) drives the live timer. */
  | { kind: 'working'; startedAt?: number }
  /** The agent waits on the user: a question, a tool approval or a plan. */
  | { kind: 'waiting'; reason: 'question' | 'approval' | 'plan' }
  /**
   * The last turn was stopped or cut short (cancelled, or interrupted by a
   * restart); not an error. `endedAt` is epoch ms.
   */
  | { kind: 'stopped'; endedAt?: number }
  /** The last turn ended in an error; `endedAt` is epoch ms. */
  | { kind: 'failed'; endedAt?: number }
  /** The last turn finished; `endedAt` is epoch ms. */
  | { kind: 'finished'; endedAt?: number }
  /** Nothing has been sent in this chat yet. */
  | { kind: 'empty' };

export interface ChatTabPreviewCardProps {
  /** The user's last prompt, or `null` while it is not known. */
  prompt: string | null;
  /** The agent's text messages in the latest turn, oldest first. */
  replies: readonly string[];
  status: ChatTabPreviewStatus;
  /** Tool calls the agent made in the latest turn; `null` while unknown. */
  toolCount: number | null;
}

const WAITING_LABELS: Record<
  Extract<ChatTabPreviewStatus, { kind: 'waiting' }>['reason'],
  string
> = {
  question: 'Question waiting',
  approval: 'Approval needed',
  plan: 'Plan waiting for review',
};

/** `0:28`, `12:05`, `1:02:09`: how long the running turn has taken. */
export function formatChatTabPreviewElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** `just now` in the first minute, then `4m ago`, `3h ago`, `2d ago`. */
function formatAgo(endedAt: number, now: number): string {
  return now - endedAt < 60_000 ? 'just now' : formatRelativeTime(endedAt, now);
}

/** A clock that ticks every `intervalMs` while the card is open. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return (): void => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function statusGlyphAndLabel(
  status: ChatTabPreviewStatus,
  now: number,
): { glyph: ReactNode; glyphColor?: string; label: string } {
  switch (status.kind) {
    case 'working':
      return {
        // The 12px spinner chat tabs use while streaming; the shared slot
        // centers it where the 14px glyphs sit, so the label stays put.
        glyph: (
          <CometSpinner sizePx={12} dataTestId="chat-tab-preview-spinner" />
        ),
        label:
          status.startedAt === undefined
            ? 'Working…'
            : `Working… ${formatChatTabPreviewElapsed(now - status.startedAt)}`,
      };
    case 'waiting':
      return {
        glyph: <QuestionMarkIcon size={14} />,
        glyphColor: 'fg-attention',
        label: WAITING_LABELS[status.reason],
      };
    // Stopping is not an error, so like finishing it is plain text in the
    // quiet status ink; only a real error gets a glyph, in the shared
    // failed ink.
    case 'stopped':
      return {
        glyph: null,
        label:
          status.endedAt === undefined
            ? 'Stopped'
            : `Stopped ${formatAgo(status.endedAt, now)}`,
      };
    case 'failed':
      return {
        glyph: <CircleXIcon size={14} />,
        glyphColor: OPERATIONAL_STATUS_COLORS.failed.foreground,
        label:
          status.endedAt === undefined
            ? 'Failed'
            : `Failed ${formatAgo(status.endedAt, now)}`,
      };
    case 'finished':
      return {
        glyph: null,
        label:
          status.endedAt === undefined
            ? 'Finished'
            : `Finished ${formatAgo(status.endedAt, now)}`,
      };
    case 'empty':
      return { glyph: null, label: 'No messages yet' };
  }
}

/**
 * Pure display card that previews a background chat from its tab: the
 * user's last prompt in a one-line bubble, the agent's latest reply as a
 * ticker of up to two lines, and a status row with a live timer and the
 * turn's tool count. The card sizes to what exists: no reply reserves no
 * space, and a zero or unknown tool count is left out. Only the status glyph
 * is colored. Mount it inside the tab's hover
 * surface (a `HoverCard` with `elevation="menu"` and compact padding);
 * the host supplies the chat's facts and re-renders as they change.
 */
export function ChatTabPreviewCard({
  prompt,
  replies,
  status,
  toolCount,
}: ChatTabPreviewCardProps): JSX.Element {
  // The timer reads seconds while a turn runs; ages read minutes.
  const now = useNow(status.kind === 'working' ? 1000 : 30_000);
  const { glyph, glyphColor, label } = statusGlyphAndLabel(status, now);
  const hasPrompt = prompt !== null && prompt.length > 0;
  return (
    // The surface pads 8px sides and 4px top; pulling 4px back sets the
    // bubble 4px in on every side under the 12px corner (an 8px bubble
    // corner nests inside it). Text sits 12px in from every edge; without
    // a bubble the top pads 8px more to keep it so.
    <div
      className={`-mx-1 flex flex-col gap-2.5 pb-2 text-xs${hasPrompt ? '' : ' pt-2'}`}
      data-testid="chat-tab-preview"
      data-status={status.kind}
    >
      {hasPrompt ? (
        <div
          className={`rounded-md bg-muted px-2 py-1 fg-primary ${REPLAY_BLOCK_CLASS}`}
          data-testid="chat-tab-preview-prompt"
        >
          {/* The fade masks its own box, so it sits inside the bubble rather
              than on it, which would fade the bubble's fill too. */}
          <span className="block truncate-fade">{prompt}</span>
        </div>
      ) : null}
      <div className="flex flex-col gap-2.5 px-2">
        {replies.length > 0 ? (
          <ChatTabPreviewReplyTicker messages={replies} />
        ) : null}
        <div
          className="flex min-h-4.5 items-center gap-2 text-2xs fg-tertiary"
          data-testid="chat-tab-preview-status"
        >
          {glyph === null ? null : (
            <HoverCardIconSlot>
              <span className={`inline-flex ${glyphColor ?? ''}`}>{glyph}</span>
            </HoverCardIconSlot>
          )}
          <span className="tabular-nums">{label}</span>
          {status.kind === 'empty' ||
          toolCount === null ||
          toolCount <= 0 ? null : (
            <span className="ml-auto">
              {toolCount === 1 ? '1 tool' : `${toolCount} tools`}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
