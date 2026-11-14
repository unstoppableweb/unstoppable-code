'use client';

import { StatusPill } from './StatusPill';
import { Stack } from './Stack';
import { useEffect, useId, useRef, type JSX, type RefObject } from 'react';
import { Button } from './Button';
import { TextInput } from './Field';
import { FormField } from './FormField';
import { LoadingSpinner } from './LoadingSpinner';
import { Notice } from './Notice';
import { PickerMenuOptionCheck } from './PickerMenu';
import { ErrorBanner, ErrorState } from './StatusBlocks';

/**
 * One repository the picker can show. `id` is the host's stable identity for
 * the row (desktop uses the full name; web uses GitHub's immutable repository
 * id), so a rename never moves the selection. `fullName` is only what the user
 * reads.
 */
export interface GitHubRepositoryPickerRow {
  readonly id: string;
  readonly fullName: string;
  readonly description: string | null;
  readonly private: boolean;
  /**
   * Display metadata only: it adds the Archived badge and nothing else. An
   * archived repository can be chosen unless the host also gives it an
   * `unavailableReason`, so one host's policy never disables another's rows.
   */
  readonly archived: boolean;
  /**
   * Set to make the row unavailable: it cannot be chosen, and this text says
   * why, on the row. The only thing that disables a row. Empty means none.
   */
  readonly unavailableReason?: string;
}

/**
 * Paging for a host whose listing arrives in pages. The host owns the cursor,
 * the request and the rows it has so far; the picker only asks for more.
 */
export interface GitHubRepositoryPickerPaging {
  /** A further page can be requested. Offered even when no row matches yet. */
  readonly hasMore: boolean;
  /**
   * A requested page is in flight. Must be true for the whole request: the
   * picker keeps the rows it has, disables a second request, and restores
   * keyboard focus once the request settles.
   */
  readonly loadingMore: boolean;
  /** Why the last request for a page failed. The button becomes Try again. */
  readonly error?: string;
  readonly onLoadMore: () => void;
}

export interface GitHubRepositoryPickerProps {
  /** The rows to show, already filtered by the host for `search`. */
  readonly repositories: readonly GitHubRepositoryPickerRow[];
  /**
   * How many repositories the account has before `search` narrowed them. Zero
   * means "GitHub returned none"; above zero with no rows means "no matches".
   */
  readonly totalCount: number;
  /** The first page is loading: only a loading line shows. */
  readonly loading: boolean;
  /** A non-empty message replaces the list and offers `onRetry`. */
  readonly error: string;
  readonly search: string;
  readonly onSearchChange: (value: string) => void;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onRetry: () => void;
  /**
   * Test id of the scrolling list container. The Load more button and the
   * notice take `${testId}-load-more` and `${testId}-notice`.
   */
  readonly testId?: string;
  /** Present for a paged listing; absent when the host lists everything. */
  readonly paging?: GitHubRepositoryPickerPaging;
  /** Label above the search field. Defaults to "Repository". */
  readonly label?: string;
  /** Defaults to "Search your repositories". */
  readonly searchPlaceholder?: string;
  /** Shown when `totalCount` is zero. Defaults to the GitHub-returned-none copy. */
  readonly emptyMessage?: string;
  /**
   * Shown when `totalCount` is above zero and no row matches. Defaults to
   * quoting `search`; a host that searches only the pages it has loaded says so.
   */
  readonly noMatchMessage?: string;
  /** A state worth knowing while choosing, such as an incomplete search. */
  readonly notice?: string;
}

/**
 * Keeps keyboard focus from being lost when a page the user asked for settles.
 *
 * Load more stays mounted while more pages remain, so focus stays on it. When
 * the last page removes it, focus would drop to the document; this continues at
 * the first row the page added, else the row before it, else the search field.
 * Focus the user already moved elsewhere is never taken, and a request the host
 * never reflects as `loadingMore` cannot move focus later.
 */
function useLoadMoreFocus(
  searchRef: RefObject<HTMLInputElement | null>,
  loadingMore: boolean,
  rowCount: number,
): {
  readonly rowRefs: RefObject<(HTMLButtonElement | null)[]>;
  readonly beginLoad: (from: number) => void;
} {
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // The page this component asked for: where its rows start, and whether the
  // host has shown it in flight yet.
  const pendingLoad = useRef<{ from: number; started: boolean } | null>(null);

  useEffect(() => {
    const pending = pendingLoad.current;
    if (pending === null) return;
    if (loadingMore) {
      pending.started = true;
      return;
    }
    if (!pending.started) return;
    pendingLoad.current = null;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    const rows = rowRefs.current;
    const target =
      rows[pending.from] ?? rows[pending.from - 1] ?? searchRef.current;
    target?.focus();
  }, [loadingMore, rowCount, searchRef]);

  const beginLoad = (from: number): void => {
    pendingLoad.current = { from, started: false };
  };

  return { rowRefs, beginLoad };
}

interface RepositoryRowProps {
  readonly repository: GitHubRepositoryPickerRow;
  readonly selected: boolean;
  readonly reasonId: string;
  readonly onSelect: (id: string) => void;
  readonly buttonRef: (element: HTMLButtonElement | null) => void;
}

function RepositoryRow({
  repository,
  selected,
  reasonId,
  onSelect,
  buttonRef,
}: RepositoryRowProps): JSX.Element {
  const reason =
    repository.unavailableReason === undefined ||
    repository.unavailableReason === ''
      ? null
      : repository.unavailableReason;
  const unavailable = reason !== null;
  const tone = unavailable ? 'fg-tertiary' : 'hover:bg-secondary/30 fg-primary';
  return (
    <li>
      <button
        ref={buttonRef}
        type="button"
        aria-pressed={selected}
        aria-disabled={unavailable || undefined}
        aria-describedby={unavailable ? reasonId : undefined}
        onClick={() => {
          if (!unavailable) onSelect(repository.id);
        }}
        className={`focus-ring flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left transition-colors ${tone}${
          unavailable ? ' cursor-not-allowed' : ''
        }`}
      >
        <div className="flex w-full items-center gap-2">
          <span className="truncate text-s font-medium">
            {repository.fullName}
          </span>
          {repository.private && <StatusPill>Private</StatusPill>}
          {repository.archived && <StatusPill>Archived</StatusPill>}
          <PickerMenuOptionCheck
            selected={selected}
            reserveSpace
            className="ml-auto"
          />
        </div>
        {repository.description && (
          <span
            className={`line-clamp-2 text-xs ${
              unavailable ? 'fg-tertiary' : 'fg-secondary'
            }`}
          >
            {repository.description}
          </span>
        )}
        {unavailable && (
          <span id={reasonId} className="text-xs fg-secondary">
            {reason}
          </span>
        )}
      </button>
    </li>
  );
}

interface PagingFooterProps {
  readonly paging: GitHubRepositoryPickerPaging;
  readonly testId: string | undefined;
  readonly onLoadMore: () => void;
}

/**
 * Pinned to the bottom of the scrolling list, so a long page never scrolls the
 * way to the next one out of reach.
 */
function PagingFooter({
  paging,
  testId,
  onLoadMore,
}: PagingFooterProps): JSX.Element {
  const { loadingMore, error } = paging;
  let label = 'Load more';
  if (error) label = 'Try again';
  return (
    <div className="sticky bottom-0 flex items-center justify-between gap-3 border-t bg-base px-3 py-2">
      {error ? (
        <ErrorBanner
          errorSource="paging-footer"
          className="min-w-0 flex-1"
          error={error}
        />
      ) : (
        <span aria-hidden="true" />
      )}
      <Button
        variant="secondary"
        size="compact"
        data-testid={testId ? `${testId}-load-more` : undefined}
        aria-disabled={loadingMore || undefined}
        aria-busy={loadingMore || undefined}
        onClick={onLoadMore}
      >
        {loadingMore ? (
          <>
            <LoadingSpinner decorative />
            Loading more
          </>
        ) : (
          label
        )}
      </Button>
    </div>
  );
}

/**
 * Searchable list of GitHub repositories to choose one from. Pure display: the
 * host owns the data, the filtering, the selection, the paging and every
 * transport detail, and this component only reports what the user did.
 *
 * Rows are buttons in a list, not a listbox: Tab reaches each row and Enter or
 * Space chooses it, and the chosen row reports `aria-pressed`. An unavailable
 * row is `aria-disabled` rather than `disabled`, so it stays reachable and its
 * reason is read with it.
 */
export function GitHubRepositoryPicker({
  repositories,
  totalCount,
  loading,
  error,
  search,
  onSearchChange,
  selectedId,
  onSelect,
  onRetry,
  testId,
  paging,
  label = 'Repository',
  searchPlaceholder = 'Search your repositories',
  emptyMessage = 'No repositories returned from GitHub.',
  noMatchMessage,
  notice,
}: GitHubRepositoryPickerProps): JSX.Element {
  const reasonIdPrefix = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const loadingMore = paging?.loadingMore === true;
  const rowCount = repositories.length;
  const { rowRefs, beginLoad } = useLoadMoreFocus(
    searchRef,
    loadingMore,
    rowCount,
  );

  const requestMore = (): void => {
    if (paging === undefined || paging.loadingMore) return;
    beginLoad(rowCount);
    paging.onLoadMore();
  };

  const settled = !loading && !error;

  return (
    <Stack gap="inline">
      <FormField label={label}>
        {(control) => (
          <TextInput
            {...control}
            ref={searchRef}
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            // A host may wrap the picker in a form; Enter here only refines
            // the search and must not submit it.
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.preventDefault();
            }}
            placeholder={searchPlaceholder}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="search"
          />
        )}
      </FormField>

      <div
        className="max-h-64 overflow-y-auto rounded-lg border bg-base"
        data-testid={testId}
        aria-busy={loading || undefined}
      >
        {/* One region that stays mounted, so a screen reader announces the
            state it changes to (loading, none, no match, how many). */}
        <div role="status">
          {loading && (
            <div className="px-3 py-4 text-xs fg-secondary">
              Loading your GitHub repositories…
            </div>
          )}

          {settled && totalCount === 0 && (
            <div className="px-3 py-4 text-xs fg-secondary">{emptyMessage}</div>
          )}

          {settled && totalCount > 0 && rowCount === 0 && (
            <div className="px-3 py-4 text-xs fg-secondary">
              {noMatchMessage ?? <>No matches for &ldquo;{search}&rdquo;.</>}
            </div>
          )}

          {settled && rowCount > 0 && (
            <span className="sr-only">
              {rowCount === 1 ? '1 repository' : `${rowCount} repositories`}
            </span>
          )}

          {loadingMore && (
            <span className="sr-only">Loading more repositories</span>
          )}
        </div>

        {!loading && error && (
          <ErrorState space="panel" message={error} onRetry={onRetry} />
        )}

        {settled && rowCount > 0 && (
          <ul className="divide-y">
            {repositories.map((repository, index) => (
              <RepositoryRow
                key={repository.id}
                repository={repository}
                selected={repository.id === selectedId}
                reasonId={`${reasonIdPrefix}-reason-${index}`}
                onSelect={onSelect}
                buttonRef={(element) => {
                  rowRefs.current[index] = element;
                }}
              />
            ))}
          </ul>
        )}

        {settled && paging?.hasMore === true && (
          <PagingFooter
            paging={paging}
            testId={testId}
            onLoadMore={requestMore}
          />
        )}
      </div>

      {notice && (
        <Notice data-testid={testId ? `${testId}-notice` : undefined}>
          {notice}
        </Notice>
      )}
    </Stack>
  );
}
