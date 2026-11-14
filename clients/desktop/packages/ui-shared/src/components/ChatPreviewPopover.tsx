import type { JSX } from 'react';
import { PlanModeIcon } from '../icons';
import { REPLAY_BLOCK_CLASS, REPLAY_MASK_CLASS } from '../lib/replay-privacy';
import { ModelProviderIcon } from '../icons/ModelProviderIcon';
import { RichHoverCard } from './RichHoverTooltip';
import { Stack } from './Stack';

export type ChatPreviewProviderType =
  | 'claude'
  | 'codex'
  | 'ollama'
  | 'cursor'
  | 'copilot'
  | 'antigravity'
  | 'opencode';

/**
 * Compact chat row rendered inside sidebar badge hover popovers.
 */
export interface ChatPreviewRow {
  chatId: string;
  title: string;
  providerType: ChatPreviewProviderType | undefined;
  preview: string | undefined;
  scheduledAt?: string;
  /**
   * Host-formatted schedule line (`Every hour · next 6:00 PM`,
   * `Sends Tue 9:00 AM`). When present it replaces the generic
   * `Scheduled for …` line derived from `scheduledAt`.
   */
  scheduleLabel?: string;
  /** Marks a plan-explore chat row so the popover renders a plan icon. */
  isPlan?: boolean;
  /**
   * Set when the user marked the chat unread themselves. The row then says so
   * instead of showing its last response, which is not why the dot is there.
   */
  markedUnread?: boolean;
}

/** Secondary line for a chat the user marked unread themselves. */
export const CHAT_PREVIEW_MARKED_UNREAD_COPY = 'Marked as unread';

export interface ChatPreviewPopoverProps {
  anchorRect: DOMRect;
  rows: ChatPreviewRow[];
  heading: string;
  /** Lets the badge that opened it name it in `aria-describedby`. */
  id?: string;
}

/**
 * The sidebar badge cards (chats, scripts, hooks, terminals, workflows): the
 * menu's corners, shadow and fill with card inset, like the worktree preview
 * card beside them.
 */
export const BADGE_HOVER_CARD_SURFACE = {
  elevation: 'menu',
  surfacePadding: 'card',
} as const;

function formatScheduledDateTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString();
}

export function ChatPreviewPopover({
  anchorRect,
  rows,
  heading,
  id,
}: ChatPreviewPopoverProps): JSX.Element | null {
  // Portaled to the body, out of any parent's replay block. Chat titles are
  // recorded; each message preview is conversation content and carries its
  // own block.
  return (
    <RichHoverCard
      anchorRect={anchorRect}
      id={id}
      role="tooltip"
      {...BADGE_HOVER_CARD_SURFACE}
      surfaceClassName="min-w-50 max-w-75"
    >
      <Stack gap="tight">
        <div className="text-3xs font-semibold fg-secondary">{heading}</div>
        {rows.length === 0 ? (
          <div className="text-xs fg-secondary">No chat details</div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {rows.map((row) => (
              <div key={row.chatId} className="min-w-0">
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="inline-flex shrink-0 items-center">
                    {row.isPlan ? (
                      <PlanModeIcon size="sm" className="fg-secondary" />
                    ) : (
                      <ModelProviderIcon
                        provider={row.providerType ?? 'claude'}
                        size="xs"
                        tone="secondary"
                      />
                    )}
                  </span>
                  <span
                    className={`${REPLAY_MASK_CLASS} truncate font-medium fg-primary`}
                  >
                    {row.title}
                  </span>
                </div>
                <div
                  className={`${REPLAY_BLOCK_CLASS} truncate pl-4.5 text-3xs fg-secondary`}
                >
                  {row.markedUnread
                    ? CHAT_PREVIEW_MARKED_UNREAD_COPY
                    : (row.preview ?? 'No response yet')}
                </div>
                {row.scheduleLabel ? (
                  <div className="truncate pl-4.5 text-3xs fg-secondary">
                    {row.scheduleLabel}
                  </div>
                ) : (
                  row.scheduledAt && (
                    <div className="truncate pl-4.5 text-3xs fg-secondary">
                      Scheduled for {formatScheduledDateTime(row.scheduledAt)}
                    </div>
                  )
                )}
              </div>
            ))}
          </div>
        )}
      </Stack>
    </RichHoverCard>
  );
}
