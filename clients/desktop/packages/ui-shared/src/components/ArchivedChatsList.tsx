import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type JSX,
} from 'react';
import { CHAT_UNIT_LABEL, CHAT_UNIT_LABEL_PLURAL } from '@canopy/protocol';
import { SummaryIcon, UnarchiveIcon } from '../icons/AppIcons';
import {
  ARCHIVED_CHAT_SORT_OPTIONS,
  archivedChatTimeTooltip,
  countArchivedChats,
  filterArchivedChats,
  formatArchivedChatTime,
  groupArchivedChats,
  sortArchivedChats,
  type ArchivedChatFilter,
  type ArchivedChatSort,
} from '../lib/archived-chat-list';
import { OPERATIONAL_STATUS_COLORS } from '../lib/operational-status-colors';
import { REPLAY_MASK_CLASS } from '../lib/replay-privacy';
import { useMinuteClock } from '../lib/useMinuteClock';
import type { ArchivedChatsCardItem } from './ArchivedChatsCard';
import { Count, Dot } from './Badge';
import { Button } from './Button';
import { ListRow } from './ListRow';
import { LoadingSpinner } from './LoadingSpinner';
import {
  PageSearchControls,
  PageSearchField,
  PageSearchRow,
  SortDropdown,
} from './PageSearchRow';
import { RowActionButton } from './RowActions';
import { SearchEmptyState } from './SearchField';
import { SegmentedControl } from './SegmentedControl';
import { EmptyState } from './StatusBlocks';
import { Tooltip } from './Tooltip';

/** One archived chat, as its row in the full list shows it. */
export interface ArchivedChatsListItem extends ArchivedChatsCardItem {
  /** ISO timestamp the chat was archived. */
  readonly archivedAt: string;
  /** ISO timestamp the chat was started. */
  readonly createdAt: string;
  readonly turnCount: number;
}

export interface ArchivedChatsListProps {
  readonly items: readonly ArchivedChatsListItem[];
  readonly sort: ArchivedChatSort;
  readonly onSortChange: (sort: ArchivedChatSort) => void;
  /** Open the chat's read-only transcript (the row itself). */
  readonly onOpen: (id: string) => void;
  readonly onRestore: (id: string) => void;
  readonly onSummarize: (id: string) => void;
  readonly onMarkAllRead: () => void;
}

const CHATS_LOWER = CHAT_UNIT_LABEL_PLURAL.toLowerCase();
const RESTORE_LABEL = `Restore ${CHAT_UNIT_LABEL.toLowerCase()}`;

const FILTER_EMPTY_TITLES: Record<
  Exclude<ArchivedChatFilter, 'all'>,
  string
> = {
  unread: `No unread ${CHATS_LOWER}`,
  restorable: `No restorable ${CHATS_LOWER}`,
};

interface ArchivedChatsListRowProps {
  readonly item: ArchivedChatsListItem;
  /** The short time beside the row, already formatted for the minute. */
  readonly timeLabel: string;
  /** Full archived and started datetimes; empty renders no tooltip. */
  readonly timeTooltip: string;
  readonly onOpen: (id: string) => void;
  readonly onRestore: (id: string) => void;
  readonly onSummarize: (id: string) => void;
}

/**
 * One archived chat on the shared `ListRow`. The time sits in the trailing
 * slot and turns invisible (keeping its width) while the row is hovered,
 * focused or busy, where the Restore and Summarize tray takes its place.
 * Memoized on formatted strings, so a minute tick re-renders only the rows
 * whose label changed.
 */
const ArchivedChatsListRow = memo(function ArchivedChatsListRow({
  item,
  timeLabel,
  timeTooltip,
  onOpen,
  onRestore,
  onSummarize,
}: ArchivedChatsListRowProps): JSX.Element {
  const busy = item.restoring === true || item.summarizing === true;
  const unread = item.unread === true;
  // On a fine pointer the tray replaces the time; on touch the tray sits in
  // the row beside it, so the time stays.
  const timeVisibility = busy
    ? 'invisible'
    : 'pointer-fine:group-hover/list-row:invisible pointer-fine:group-focus-within/list-row:invisible';
  const description =
    item.meta !== undefined && item.meta !== '' ? (
      timeTooltip === '' ? (
        item.meta
      ) : (
        // The time is hidden while the row is hovered, so the full datetimes
        // hang off the meta line, which stays visible.
        <Tooltip
          label={timeTooltip}
          delay="long"
          allowShrink
          className="max-w-full min-w-0"
        >
          <span className="min-w-0 truncate">{item.meta}</span>
        </Tooltip>
      )
    ) : undefined;
  return (
    <ListRow
      size="md"
      onClick={(): void => onOpen(item.id)}
      icon={
        <span
          aria-hidden="true"
          className={`inline-flex items-center justify-center ${
            unread ? OPERATIONAL_STATUS_COLORS.unread.foreground : ''
          }`}
        >
          {/* The title's dot carries unread, so the fallback stays neutral. */}
          {item.icon ?? <Dot tone="filter" />}
        </span>
      }
      description={description}
      trailing={
        timeLabel === '' ? undefined : (
          <span className={`tabular-nums ${timeVisibility}`}>{timeLabel}</span>
        )
      }
      actionsReveal={!busy}
      actions={
        <>
          {item.restorable ? (
            <RowActionButton
              label={RESTORE_LABEL}
              testId="archived-chat-restore"
              disabled={busy}
              onClick={(): void => onRestore(item.id)}
            >
              {item.restoring === true ? (
                <LoadingSpinner />
              ) : (
                <UnarchiveIcon size="sm" />
              )}
            </RowActionButton>
          ) : null}
          <RowActionButton
            label="Summarize"
            testId="archived-chat-summarize"
            disabled={busy}
            onClick={(): void => onSummarize(item.id)}
          >
            {item.summarizing === true ? (
              <LoadingSpinner />
            ) : (
              <SummaryIcon size="sm" />
            )}
          </RowActionButton>
        </>
      }
      rowProps={{
        'data-testid': 'archived-chats-modal-row',
        'data-archived-chat-id': item.id,
      }}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        {unread ? <Dot tone="unread" label="Unread" /> : null}
        <span className={`${REPLAY_MASK_CLASS} truncate`}>{item.title}</span>
      </span>
    </ListRow>
  );
});

/** Focuses the main press of the row for `id`, if it is mounted. */
function focusRow(container: HTMLElement, id: string): boolean {
  for (const row of container.querySelectorAll<HTMLElement>(
    '[data-archived-chat-id]',
  )) {
    if (row.dataset.archivedChatId !== id) continue;
    const press = row.querySelector<HTMLElement>('button');
    if (press === null) return false;
    press.focus();
    return true;
  }
  return false;
}

/** Focuses the selected segment of the filter control. */
function focusFilter(container: HTMLElement | null): void {
  if (container === null) return;
  const selected = container.querySelector<HTMLElement>(
    'button[aria-checked="true"], button[aria-pressed="true"], button[aria-selected="true"]',
  );
  (selected ?? container.querySelector<HTMLElement>('button'))?.focus();
}

/**
 * Every archived chat for a worktree: a search and sort row, an All /
 * Unread / Restorable filter with counts and Mark all as read, then the
 * chats under sticky date headers (for the date sorts). Each row shows when
 * the chat was archived (or started, under that sort); Restore and Summarize
 * replace the time on hover or focus. Pure display: the host supplies the
 * chats, their in-flight state and the sort; the query and the filter are
 * local, so they reset when the host unmounts the list.
 */
export function ArchivedChatsList({
  items,
  sort,
  onSortChange,
  onOpen,
  onRestore,
  onSummarize,
  onMarkAllRead,
}: ArchivedChatsListProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ArchivedChatFilter>('all');
  const now = useMinuteClock();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const filterRef = useRef<HTMLDivElement | null>(null);
  const markAllPendingRef = useRef(false);
  const lastFocusedRef = useRef<{ id: string; index: number } | null>(null);

  // Stable row callbacks, so the memoized rows ignore a host that passes
  // fresh handlers on every render.
  const handlersRef = useRef({ onOpen, onRestore, onSummarize });
  useLayoutEffect(() => {
    handlersRef.current = { onOpen, onRestore, onSummarize };
  });
  const handleOpen = useCallback((id: string): void => {
    handlersRef.current.onOpen(id);
  }, []);
  const handleRestore = useCallback((id: string): void => {
    handlersRef.current.onRestore(id);
  }, []);
  const handleSummarize = useCallback((id: string): void => {
    handlersRef.current.onSummarize(id);
  }, []);

  const counts = useMemo(() => countArchivedChats(items), [items]);
  const { groups, shownIds, filteredCount, inFilterCount } = useMemo(() => {
    const inFilter = filterArchivedChats(items, { query: '', filter });
    const shown = filterArchivedChats(inFilter, { query, filter: 'all' });
    const sorted = sortArchivedChats(shown, sort);
    return {
      groups: groupArchivedChats(sorted, sort, now),
      shownIds: sorted.map((item) => item.id),
      filteredCount: sorted.length,
      inFilterCount: inFilter.length,
    };
  }, [items, filter, query, sort, now]);

  const hasQuery = query.trim() !== '';

  // A new view starts at the top of the list.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller !== null) scroller.scrollTop = 0;
  }, [query, filter, sort]);

  // Mark all as read unmounts once nothing is unread; keep keyboard focus in
  // the dialog by handing it to the filter control. The host's call is fire
  // and forget, so a failed mark leaves the request pending; only rescue
  // focus that actually fell to the document, never take it from wherever
  // the person has since moved (such as the transcript viewer).
  useEffect(() => {
    if (counts.unread > 0 || !markAllPendingRef.current) return;
    markAllPendingRef.current = false;
    const active = filterRef.current?.ownerDocument.activeElement ?? null;
    if (active !== null && active !== active.ownerDocument.body) return;
    focusFilter(filterRef.current);
  }, [counts.unread]);

  // A row can leave the list while it holds focus, such as an Unread row
  // marked read from elsewhere. When its focus fell to the document (not when
  // the person moved it, as into the transcript viewer), hand it to the row
  // that took its place, the one before it, or the filter control.
  useLayoutEffect(() => {
    const last = lastFocusedRef.current;
    const scroller = scrollerRef.current;
    if (last === null || scroller === null) return;
    if (shownIds.includes(last.id)) return;
    // Forget the row now, so a later focus loss (or a minute tick) never
    // pulls focus back to the list long after the row left it.
    lastFocusedRef.current = null;
    const active = scroller.ownerDocument.activeElement;
    if (active !== null && active !== scroller.ownerDocument.body) return;
    const nextId = shownIds[Math.min(last.index, shownIds.length - 1)];
    if (nextId === undefined || !focusRow(scroller, nextId)) {
      focusFilter(filterRef.current);
    }
  }, [shownIds]);

  const handleListFocus = (event: FocusEvent<HTMLDivElement>): void => {
    if (!(event.target instanceof HTMLElement)) return;
    const row = event.target.closest<HTMLElement>('[data-archived-chat-id]');
    const id = row?.dataset.archivedChatId;
    if (id === undefined) return;
    lastFocusedRef.current = { id, index: shownIds.indexOf(id) };
  };

  const clearSearch = (): void => setQuery('');
  const showAll = (): void => setFilter('all');

  let body: JSX.Element;
  if (counts.all === 0) {
    body = (
      <EmptyState
        testId="archived-chats-list-empty"
        title={`No archived ${CHATS_LOWER}`}
        titleWeight="normal"
      />
    );
  } else if (filteredCount === 0 && hasQuery) {
    body = (
      <SearchEmptyState
        testId="archived-chats-list-no-matches"
        title={`No archived ${CHATS_LOWER} match your search`}
        actionLabel="Clear search"
        onAction={clearSearch}
      />
    );
  } else if (filteredCount === 0 && filter !== 'all') {
    body = (
      <EmptyState
        testId="archived-chats-list-filter-empty"
        title={FILTER_EMPTY_TITLES[filter]}
        titleWeight="normal"
        action={
          <Button variant="secondary" size="sm" onClick={showAll}>
            Show all
          </Button>
        }
      />
    );
  } else {
    body = (
      <>
        {groups.map((group) => (
          <section
            key={group.key}
            aria-label={group.label ?? undefined}
            className="flex flex-col"
            data-archived-chats-group={group.key}
          >
            {group.label === null ? null : (
              // Opaque in the dialog card's own fill, so rows scroll under it.
              <p className="sticky top-0 z-10 flex h-7 items-end bg-card px-2 pb-1 text-xs fg-tertiary">
                {group.label}
              </p>
            )}
            <div className="flex flex-col gap-0.5">
              {group.items.map((item) => (
                <ArchivedChatsListRow
                  key={item.id}
                  item={item}
                  timeLabel={formatArchivedChatTime(
                    sort === 'started' ? item.createdAt : item.archivedAt,
                    now,
                  )}
                  timeTooltip={archivedChatTimeTooltip(item)}
                  onOpen={handleOpen}
                  onRestore={handleRestore}
                  onSummarize={handleSummarize}
                />
              ))}
            </div>
          </section>
        ))}
      </>
    );
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="archived-chats-list"
    >
      <div className="flex shrink-0 flex-col gap-2 px-6 pb-2">
        <PageSearchRow>
          <PageSearchField
            value={query}
            onValueChange={setQuery}
            aria-label={`Search archived ${CHATS_LOWER}`}
            placeholder={`Search archived ${CHATS_LOWER}`}
            count={
              hasQuery
                ? `${String(filteredCount)} of ${String(inFilterCount)}`
                : undefined
            }
            fieldTestId="archived-chats-search"
          />
          <PageSearchControls>
            <SortDropdown
              value={sort}
              options={ARCHIVED_CHAT_SORT_OPTIONS}
              onChange={onSortChange}
              testId="archived-chats-sort"
            />
          </PageSearchControls>
        </PageSearchRow>
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <div ref={filterRef}>
            <SegmentedControl<ArchivedChatFilter>
              value={filter}
              onChange={setFilter}
              label={`Filter archived ${CHATS_LOWER}`}
              width="content"
              dataTestId="archived-chats-filter"
              options={[
                {
                  value: 'all',
                  label: 'All',
                  trailing: <Count value={counts.all} />,
                },
                {
                  value: 'unread',
                  label: 'Unread',
                  trailing: <Count value={counts.unread} />,
                },
                {
                  value: 'restorable',
                  label: 'Restorable',
                  trailing: <Count value={counts.restorable} />,
                },
              ]}
            />
          </div>
          {counts.unread > 0 ? (
            <Button
              variant="ghost"
              size="compact"
              data-testid="archived-chats-mark-all-read"
              onClick={(): void => {
                markAllPendingRef.current = true;
                onMarkAllRead();
              }}
            >
              Mark all as read
            </Button>
          ) : null}
        </div>
      </div>
      <div
        ref={scrollerRef}
        onFocus={handleListFocus}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4"
      >
        {body}
      </div>
    </div>
  );
}
