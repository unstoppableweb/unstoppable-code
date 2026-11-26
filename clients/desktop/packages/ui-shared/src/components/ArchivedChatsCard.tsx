import { ListRowFrame } from '../primitives/ListRow';
import type { CSSProperties, JSX, ReactNode } from 'react';
import { CHAT_UNIT_LABEL } from '@canopy/protocol';
import { SummaryIcon, UnarchiveIcon } from '../icons/AppIcons';
import { OPERATIONAL_STATUS_COLORS } from '../lib/operational-status-colors';
import { REPLAY_MASK_CLASS } from '../lib/replay-privacy';
import { Dot } from '../primitives/Badge';
import { ControlButton, Button } from '../primitives/Button';
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRowStyleProvider,
  DropdownMenuSurface,
  QUIET_MENU_ROW_STYLE,
} from '../primitives/DropdownMenu';
import { LoadingSpinner } from '../primitives/LoadingSpinner';
import { Tooltip } from '../primitives/Tooltip';

/** The drawn line width of the card's 14px Lucide glyphs, in CSS px. */
const CARD_ICON_STROKE_PX = 1.5;

/** One archived chat, as its row in the card shows it. */
export interface ArchivedChatsCardItem {
  readonly id: string;
  /** The chat's display title; it truncates on one line. */
  readonly title: string;
  /** Facts beside the title, such as "Opus 5.5 · 10 turns". */
  readonly meta?: string;
  /** The chat's provider mark, about 14px; the row inks it. */
  readonly icon?: ReactNode;
  /** Unread: the leading mark takes the shared unread ink. */
  readonly unread?: boolean;
  /** Still within the restore window, so Restore is offered. */
  readonly restorable: boolean;
  readonly restoring?: boolean;
  readonly summarizing?: boolean;
}

export interface ArchivedChatsCardProps {
  readonly items: readonly ArchivedChatsCardItem[];
  /** Archived chats beyond `items`; a trailing row opens the full list. */
  readonly overflowCount: number;
  /** Open the chat's read-only transcript (the row itself). */
  readonly onOpen: (id: string) => void;
  readonly onRestore: (id: string) => void;
  readonly onSummarize: (id: string) => void;
  /** Open the full archived chats list. */
  readonly onShowAll: () => void;
  readonly className?: string;
  readonly style?: CSSProperties;
}

function ArchivedChatsCardRow({
  item,
  onOpen,
  onRestore,
  onSummarize,
}: {
  item: ArchivedChatsCardItem;
  onOpen: () => void;
  onRestore: () => void;
  onSummarize: () => void;
}): JSX.Element {
  // While either request runs, both actions read as busy: `aria-disabled`
  // keeps them focusable and announced, dimmed, without the filled disabled
  // surface a ghost control does not have.
  const busy = item.restoring === true || item.summarizing === true;
  const restoreLabel = `Restore ${CHAT_UNIT_LABEL.toLowerCase()}`;
  return (
    // The row is a menu row: 8px corners nested in the card's 12px under its
    // 4px inset, the menu hover, and the arrow cursor. Opening the transcript
    // and the two actions are sibling buttons, so no control nests in another.
    <ListRowFrame
      layout="archive-menu"
      data-testid="chat-tab-archive-popover-row"
      data-archived-chat-id={item.id}
    >
      <ControlButton
        type="button"
        onClick={onOpen}
        presentation="archived-chat-row"
      >
        <span
          aria-hidden="true"
          data-unread={item.unread === true ? 'true' : undefined}
          className={`inline-flex h-4 w-4 shrink-0 items-center justify-center ${
            item.unread === true
              ? OPERATIONAL_STATUS_COLORS.unread.foreground
              : 'fg-tertiary'
          }`}
        >
          {item.icon ?? (
            <Dot tone={item.unread === true ? 'unread' : 'filter'} />
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className={`${REPLAY_MASK_CLASS} truncate text-xs fg-primary`}>
            {item.title}
          </span>
          {item.meta ? (
            <span className="truncate text-2xs fg-tertiary">{item.meta}</span>
          ) : null}
        </span>
      </ControlButton>
      <span className="flex shrink-0 items-center">
        {item.restorable ? (
          <Tooltip label={restoreLabel}>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label={restoreLabel}
              data-testid="archived-chat-restore"
              aria-disabled={busy || undefined}
              onClick={busy ? undefined : onRestore}
            >
              {item.restoring === true ? (
                <LoadingSpinner />
              ) : (
                <UnarchiveIcon
                  size={14}
                  drawnStrokeWidth={CARD_ICON_STROKE_PX}
                />
              )}
            </Button>
          </Tooltip>
        ) : null}
        <Tooltip label="Summarize">
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="Summarize"
            data-testid="archived-chat-summarize"
            aria-disabled={busy || undefined}
            onClick={busy ? undefined : onSummarize}
          >
            {item.summarizing === true ? (
              <LoadingSpinner />
            ) : (
              <SummaryIcon size={14} drawnStrokeWidth={CARD_ICON_STROKE_PX} />
            )}
          </Button>
        </Tooltip>
      </span>
    </ListRowFrame>
  );
}

/**
 * The archived chats hover card: a quiet menu of the most recently archived
 * chats on the shared menu surface. A section label in sentence case, then
 * one row per chat with its provider mark, title and facts, and the ghost
 * Restore (while still restorable) and Summarize icon buttons. A trailing
 * row opens the full list when more are archived. Pure display: the host
 * positions the card and supplies the chats and their in-flight state.
 */
export function ArchivedChatsCard({
  items,
  overflowCount,
  onOpen,
  onRestore,
  onSummarize,
  onShowAll,
  className = '',
  style,
}: ArchivedChatsCardProps): JSX.Element {
  return (
    <DropdownMenuSurface
      role="group"
      aria-label={`Archived ${CHAT_UNIT_LABEL.toLowerCase()}s`}
      className={`w-80 ${className}`}
      style={style}
    >
      <DropdownMenuRowStyleProvider value={QUIET_MENU_ROW_STYLE}>
        <DropdownMenuLabel>
          Archived {CHAT_UNIT_LABEL.toLowerCase()}s
        </DropdownMenuLabel>
        <div className="max-h-80 overflow-y-auto overscroll-contain">
          {items.map((item) => (
            <ArchivedChatsCardRow
              key={item.id}
              item={item}
              onOpen={() => onOpen(item.id)}
              onRestore={() => onRestore(item.id)}
              onSummarize={() => onSummarize(item.id)}
            />
          ))}
        </div>
        {overflowCount > 0 ? (
          <DropdownMenuItem
            asButton
            onClick={onShowAll}
            data-testid="chat-tab-archive-more"
          >
            {/* An empty icon slot lines the label up with the chat titles. */}
            <span aria-hidden="true" className="h-4 w-4 shrink-0" />
            {overflowCount} more…
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuRowStyleProvider>
    </DropdownMenuSurface>
  );
}
