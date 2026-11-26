import type { JSX } from 'react';
import type {
  LedgerActorLabel,
  LedgerActorRef,
  LedgerEntrySearchItem,
} from '@canopy/protocol/canopy-core';
import { Skeleton } from '../../primitives/Skeleton';
import { LedgerThreadList } from './LedgerThreadList';
import type { LedgerDensity } from './ledger-entry-slots';

export interface LedgerThreadListSkeletonProps {
  readonly density: LedgerDensity;
  readonly rows?: number;
  /** Placement only: margin and flex participation. */
  readonly className?: string;
}

/**
 * Entries are tall (about 150px), so three fill a side panel and leave room
 * below them for the slow-load note.
 */
const DEFAULT_ROWS = 3;

const SAMPLE_TIME = '2026-01-01T12:00:00.000Z';
const SAMPLE_NOW = new Date('2026-01-01T12:30:00.000Z');

const SAMPLE_AUTHOR: LedgerActorRef = {
  actorId: 'ledger-skeleton-author',
  kind: 'chat',
  authorityId: 'ledger-skeleton',
};

const SAMPLE_ACTORS: Readonly<Record<string, LedgerActorLabel>> = {
  [SAMPLE_AUTHOR.actorId]: {
    actorId: SAMPLE_AUTHOR.actorId,
    kind: SAMPLE_AUTHOR.kind,
    displayName: 'Fix the flaky checkout test',
  },
};

/**
 * Plain samples: a title and two or three lines of body, with no lists,
 * files or highlights, so each entry draws as avatar, header, title, body
 * and actions.
 */
const SAMPLE_BODIES = [
  'The retry test races the payment stub and asserts before the second attempt settles. Wait on the settled event instead of a fixed timeout.',
  'The upload finished, but the status check keeps returning in progress. Retry with backoff and give up after ten minutes.',
  'Keep the current cache key and add the lockfile hash to it, so a dependency change always rebuilds the image from scratch.',
] as const;

function sampleEntry(index: number): LedgerEntrySearchItem {
  return {
    entryId: `ledger-skeleton-${index}`,
    revision: 1,
    type: 'TASK',
    status: 'IN_PROGRESS',
    title: 'Stabilize the checkout retry test',
    content: SAMPLE_BODIES[index % SAMPLE_BODIES.length] ?? '',
    highlights: [],
    referenceFiles: [],
    owner: SAMPLE_AUTHOR,
    author: SAMPLE_AUTHOR,
    attributionKind: 'self_reported',
    createdAt: SAMPLE_TIME,
    updatedAt: SAMPLE_TIME,
    sourceAvailability: 'available',
    sourceKind: 'chat',
    syncState: 'mirrored',
  };
}

const noop = (): void => undefined;

/**
 * Feed entries that have not arrived: `LedgerThreadList` itself, rendered
 * from plain samples inside the measured `Skeleton`, so the bars sit where
 * the entries will. "Loading entries" is announced to assistive technology
 * only. Wrap it in `DelayedLoadingPlaceholder` so a fast read never flashes
 * it.
 */
export function LedgerThreadListSkeleton({
  density,
  rows = DEFAULT_ROWS,
  className = '',
}: LedgerThreadListSkeletonProps): JSX.Element {
  const count = Math.max(1, Math.floor(rows));
  const entries = Array.from({ length: count }, (_, index) =>
    sampleEntry(index),
  );
  return (
    <div
      data-testid="ledger-thread-list-skeleton"
      data-density={density}
      className={className}
    >
      <Skeleton loading label="Loading entries">
        <LedgerThreadList
          entries={entries}
          actors={SAMPLE_ACTORS}
          density={density}
          now={SAMPLE_NOW}
          openEntry={null}
          onToggleOpen={noop}
          onOpenFile={noop}
          hasMore={false}
          loadingMore={false}
          loadMoreError={null}
          onLoadMore={noop}
        />
      </Skeleton>
    </div>
  );
}
