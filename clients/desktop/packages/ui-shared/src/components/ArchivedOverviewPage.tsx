'use client';

import type { JSX, ReactNode } from 'react';
import { BackIcon } from '../icons/AppIcons';
import { REPLAY_MASK_CLASS } from '../lib/replay-privacy';
import type { ArchivedContainerState } from '../lib/archived-state';
import { Count } from './Badge';
import {
  ARCHIVED_LIST_CONTAINER_CLASS_NAME,
  ArchivedOverviewRow,
} from './ArchivedOverviewRow';
import { ArchivedStateFilterDropdown } from './ArchivedStateFilterDropdown';
import { DelayedLoadingPlaceholder } from './DelayedLoadingPlaceholder';
import { HeaderActionButton } from './HeaderActionButton';
import { SearchField } from './SearchField';
import { Skeleton } from './Skeleton';
import { Surface } from './Surface';

export interface ArchivedOverviewPageProps {
  workspaceId: string;
  workspaceName: string;
  totalCount: number;
  loaded: boolean;
  hasMatches: boolean;
  query: string;
  onQueryChange: (query: string) => void;
  hiddenStates: ArchivedContainerState[];
  onHiddenStatesChange: (states: ArchivedContainerState[]) => void;
  onClose: () => void;
  headerActions?: ReactNode;
  renderHeader?: (content: ReactNode) => ReactNode;
  error?: ReactNode;
  emptyMessage?: string;
  children: ReactNode;
}

export function ArchivedOverviewPage({
  workspaceId,
  workspaceName,
  totalCount,
  loaded,
  hasMatches,
  query,
  onQueryChange,
  hiddenStates,
  onHiddenStatesChange,
  onClose,
  headerActions,
  renderHeader,
  error,
  emptyMessage = 'Restore archived or deleted items from this project here.',
  children,
}: ArchivedOverviewPageProps): JSX.Element {
  const header = (
    <div className="flex flex-wrap items-center gap-3 px-4 py-2">
      <HeaderActionButton
        tone="neutral"
        data-testid="archived-overview-back"
        onClick={onClose}
        title="Back to the project"
      >
        <BackIcon size="sm" aria-hidden="true" />
        Back
      </HeaderActionButton>
      <div className="flex min-w-0 flex-col">
        <span
          className="text-s font-medium fg-primary"
          data-testid="archived-overview-title"
        >
          Archived and deleted
        </span>
        <span
          className={`${REPLAY_MASK_CLASS} truncate text-2xs fg-secondary`}
          data-testid="archived-overview-workspace-name"
        >
          {workspaceName}
        </span>
      </div>
      <span
        data-testid="archived-overview-count"
        className="text-xs fg-secondary"
      >
        <Count value={totalCount} /> {totalCount === 1 ? 'item' : 'items'}
      </span>
      {headerActions}
    </div>
  );
  return (
    <Surface
      data-testid="archived-overview-page"
      data-workspace-id={workspaceId}
      variant="pane"
      extent="parent"
      className="flex min-h-0 flex-col"
    >
      {renderHeader ? (
        renderHeader(header)
      ) : (
        <Surface variant="section" boundary="bottom" className="shrink-0">
          <div className="shrink-0" data-testid="archived-overview-titlebar">
            {header}
          </div>
        </Surface>
      )}
      <Surface variant="section" boundary="bottom" className="shrink-0">
        <div className="flex shrink-0 items-center gap-2 px-4 py-2">
          <SearchField
            value={query}
            onValueChange={onQueryChange}
            placeholder="Search archived and deleted"
            aria-label="Search archived and deleted"
            data-testid="archived-overview-search"
            className="min-w-0 flex-1"
          />
          <ArchivedStateFilterDropdown
            hiddenStates={hiddenStates}
            onChange={onHiddenStatesChange}
          />
        </div>
      </Surface>
      <div
        className={`${ARCHIVED_LIST_CONTAINER_CLASS_NAME} min-h-0 flex-1 overflow-y-auto px-3 py-2`}
      >
        {error ??
          (!loaded ? (
            <DelayedLoadingPlaceholder slowNote="Still loading archived and deleted items…">
              <ArchivedOverviewListSkeleton />
            </DelayedLoadingPlaceholder>
          ) : totalCount === 0 ? (
            <div
              className="px-2 py-6 text-center text-xs fg-secondary"
              data-testid="archived-overview-empty"
            >
              {emptyMessage}
            </div>
          ) : !hasMatches ? (
            <div
              className="px-2 py-6 text-center text-xs fg-secondary"
              data-testid="archived-overview-no-matches"
            >
              {query.trim() ? (
                <>No items match &ldquo;{query.trim()}&rdquo;</>
              ) : (
                'No items match the current filter'
              )}
            </div>
          ) : (
            children
          ))}
      </div>
    </Surface>
  );
}

/** Plain rows of the real shape: a name, a size, and a date each. */
const SAMPLE_OVERVIEW_ROWS: ReadonlyArray<{
  readonly id: string;
  readonly state: ArchivedContainerState;
  readonly title: string;
  readonly size: string;
  readonly date: string;
}> = [
  {
    id: 'sample-1',
    state: 'archived',
    title: 'Fix the checkout retry',
    size: '12 MB',
    date: 'Jan 4',
  },
  {
    id: 'sample-2',
    state: 'deleted',
    title: 'Update the docs sidebar',
    size: '3 MB',
    date: 'Jan 2',
  },
  {
    id: 'sample-3',
    state: 'archived',
    title: 'Add release notes',
    size: '8 MB',
    date: 'Dec 30',
  },
];

const noop = (): void => undefined;

/**
 * The retained items that have not arrived: the shared overview row itself,
 * rendered from plain samples inside the measured `Skeleton`, so the bars sit
 * where the rows will.
 */
function ArchivedOverviewListSkeleton(): JSX.Element {
  return (
    <Skeleton
      loading
      label="Loading archived and deleted items"
      testId="archived-overview-loading"
    >
      <div className="flex flex-col gap-0.5">
        {SAMPLE_OVERVIEW_ROWS.map((row) => (
          <ArchivedOverviewRow
            key={row.id}
            state={row.state}
            title={row.title}
            stateTooltip={null}
            trailing={
              <span className="shrink-0 text-2xs tabular-nums fg-secondary">
                {row.size}
              </span>
            }
            date={row.date}
            onOpen={noop}
            actions={null}
          />
        ))}
      </div>
    </Skeleton>
  );
}
