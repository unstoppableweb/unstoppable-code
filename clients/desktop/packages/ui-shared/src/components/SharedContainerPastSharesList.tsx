import { useMemo, useState, type JSX, type ReactNode } from 'react';
import {
  ARCHIVED_LIST_CONTAINER_CLASS_NAME,
  OverviewListRow,
} from './ArchivedOverviewRow';
import { Button } from './Button';
import { DelayedLoadingPlaceholder } from './DelayedLoadingPlaceholder';
import { Skeleton } from './Skeleton';
import { SearchField } from './SearchField';
import { Stack } from './Stack';
import { Notice, NoticeButton } from './Notice';
import { TRY_AGAIN_LABEL } from './useRetry';
import { formatDateOrEmpty } from '../lib/format-date';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';
import { Heading } from './Heading';

/** One share in the Past shares list, removed or accepted. */
export interface PastShareItem {
  id: string;
  title: string;
  /** Absent while the owner's name has not resolved. */
  ownerName?: string;
}

export interface RemovedPastShareItem extends PastShareItem {
  /** ISO time the recipient removed the share. */
  dismissedAt: string;
}

export interface AcceptedPastShareItem extends PastShareItem {
  /** ISO time this computer accepted the share; absent sorts last. */
  acceptedAt?: string;
}

export interface SharedContainerPastSharesListProps {
  removed: readonly RemovedPastShareItem[];
  accepted: readonly AcceptedPastShareItem[];
  /**
   * `unsupported`: the connected server cannot list or restore removed
   * shares, so only the Accepted group renders.
   */
  removedStatus: 'loading' | 'success' | 'error' | 'unsupported';
  /** Ids whose restore is in flight. */
  restoringIds: readonly string[];
  onRestore: (id: string) => void;
  onOpenAccepted: (id: string) => void;
  onRetryRemoved: () => void;
  /** The accepted row's action controls. */
  renderAcceptedActions?: (id: string) => ReactNode;
}

const TEST_ID = 'shared-container-past-shares';

function byTimeDescending(
  left: string | undefined,
  right: string | undefined,
): number {
  if (left === right) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return right.localeCompare(left);
}

function matches(item: PastShareItem, query: string): boolean {
  if (query.length === 0) return true;
  return (
    item.title.toLowerCase().includes(query) ||
    (item.ownerName?.toLowerCase().includes(query) ?? false)
  );
}

function OwnerLine({ name }: { name: string | undefined }): JSX.Element | null {
  if (name === undefined) return null;
  return (
    <span className="max-w-40 shrink-0 truncate text-2xs fg-secondary">
      Shared by <span className={REPLAY_BLOCK_CLASS}>{name}</span>
    </span>
  );
}

function GroupHeading({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="px-2 pb-1 pt-2">
      <Heading level={3} variant="label">
        {children}
      </Heading>
    </div>
  );
}

/** The Removed group: each share with its Restore action. */
function RemovedGroup({
  items,
  restoringIds,
  onRestore,
}: {
  items: readonly RemovedPastShareItem[];
  restoringIds: readonly string[];
  onRestore: (id: string) => void;
}): JSX.Element {
  return (
    <section data-testid={`${TEST_ID}-removed`}>
      <GroupHeading>Removed</GroupHeading>
      <div className="flex flex-col gap-0.5">
        {items.map((item) => {
          const restoring = restoringIds.includes(item.id);
          return (
            <OverviewListRow
              key={item.id}
              testId={`${TEST_ID}-removed-row-${item.id}`}
              state="removed"
              busy={restoring}
              leading={null}
              title={item.title}
              trailing={<OwnerLine name={item.ownerName} />}
              date={formatDateOrEmpty(item.dismissedAt)}
              dateTooltip={`Removed ${formatDateOrEmpty(item.dismissedAt)}`}
              actionsReserve="inline"
              actions={
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={restoring}
                  onClick={(): void => onRestore(item.id)}
                  data-testid={`${TEST_ID}-restore-${item.id}`}
                >
                  {restoring ? 'Restoring…' : 'Restore'}
                </Button>
              }
            />
          );
        })}
      </div>
    </section>
  );
}

/** Plain removed shares the loading skeleton measures. */
const SAMPLE_REMOVED: readonly RemovedPastShareItem[] = [
  {
    id: 'past-share-sample-1',
    title: 'Release checklist',
    ownerName: 'Sam Lee',
    dismissedAt: '2026-01-02T00:00:00.000Z',
  },
  {
    id: 'past-share-sample-2',
    title: 'Onboarding notes',
    ownerName: 'Alex Kim',
    dismissedAt: '2026-01-01T00:00:00.000Z',
  },
];

const noop = (): void => undefined;

/**
 * The recipient's past shares: the ones they removed, which can be restored,
 * then the ones accepted on this computer. Pure and callback-driven; the host
 * owns the listing, the restore, and how an accepted share opens.
 */
export function SharedContainerPastSharesList({
  removed,
  accepted,
  removedStatus,
  restoringIds,
  onRestore,
  onOpenAccepted,
  onRetryRemoved,
  renderAcceptedActions,
}: SharedContainerPastSharesListProps): JSX.Element {
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLowerCase();
  const unsupported = removedStatus === 'unsupported';
  const visibleRemoved = useMemo(
    () =>
      unsupported
        ? []
        : removed
            .filter((item) => matches(item, normalizedQuery))
            .sort((left, right) =>
              byTimeDescending(left.dismissedAt, right.dismissedAt),
            ),
    [normalizedQuery, removed, unsupported],
  );
  const visibleAccepted = useMemo(
    () =>
      accepted
        .filter((item) => matches(item, normalizedQuery))
        .sort((left, right) =>
          byTimeDescending(left.acceptedAt, right.acceptedAt),
        ),
    [accepted, normalizedQuery],
  );
  const removedFailed = removedStatus === 'error';
  const removedLoading = removedStatus === 'loading' && removed.length === 0;
  const totalCount = (unsupported ? 0 : removed.length) + accepted.length;
  const nothingVisible =
    visibleRemoved.length === 0 && visibleAccepted.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid={TEST_ID}>
      <div className="shrink-0 border-b">
        <SearchField
          size="lg"
          value={query}
          onValueChange={setQuery}
          placeholder="Search past shares"
          aria-label="Search past shares"
          data-testid={`${TEST_ID}-search`}
        />
      </div>
      <div
        className={`${ARCHIVED_LIST_CONTAINER_CLASS_NAME} min-h-0 flex-1 overflow-y-auto px-3 py-2`}
      >
        <Stack gap="inline">
          {removedFailed && (
            <Notice
              errorSource="shared-container-past-shares-list"
              intent="destructive"
              data-testid={`${TEST_ID}-removed-error`}
              actions={
                <NoticeButton
                  onClick={onRetryRemoved}
                  data-testid={`${TEST_ID}-removed-retry`}
                >
                  {TRY_AGAIN_LABEL}
                </NoticeButton>
              }
            >
              Couldn&rsquo;t load removed shares.
            </Notice>
          )}
          <div>
            {removedLoading && (
              // An auto-height box: the placeholder's full-height floor would
              // otherwise push the Accepted group below the fold.
              <div>
                <DelayedLoadingPlaceholder slowNote="Still loading removed shares…">
                  <Skeleton
                    loading
                    label="Loading removed shares"
                    testId={`${TEST_ID}-removed-loading`}
                  >
                    <RemovedGroup
                      items={SAMPLE_REMOVED}
                      restoringIds={[]}
                      onRestore={noop}
                    />
                  </Skeleton>
                </DelayedLoadingPlaceholder>
              </div>
            )}
            {totalCount === 0 && !removedFailed && !removedLoading ? (
              <div
                className="px-2 py-6 text-center text-xs fg-secondary"
                data-testid={`${TEST_ID}-empty`}
              >
                Shares you accept or remove appear here.
              </div>
            ) : totalCount > 0 && nothingVisible ? (
              <div
                className="px-2 py-6 text-center text-xs fg-secondary"
                data-testid={`${TEST_ID}-no-matches`}
              >
                No shares match &ldquo;{query.trim()}&rdquo;
              </div>
            ) : null}
            {visibleRemoved.length > 0 && (
              <RemovedGroup
                items={visibleRemoved}
                restoringIds={restoringIds}
                onRestore={onRestore}
              />
            )}
            {visibleAccepted.length > 0 && (
              <section data-testid={`${TEST_ID}-accepted`}>
                <GroupHeading>Accepted</GroupHeading>
                <div className="flex flex-col gap-0.5">
                  {visibleAccepted.map((item) => (
                    <OverviewListRow
                      key={item.id}
                      testId={`${TEST_ID}-accepted-row-${item.id}`}
                      state="accepted"
                      leading={null}
                      title={item.title}
                      trailing={<OwnerLine name={item.ownerName} />}
                      date={formatDateOrEmpty(item.acceptedAt)}
                      {...(item.acceptedAt
                        ? {
                            dateTooltip: `Accepted ${formatDateOrEmpty(item.acceptedAt)}`,
                          }
                        : {})}
                      onOpen={(): void => onOpenAccepted(item.id)}
                      openTestId={`${TEST_ID}-accepted-open-${item.id}`}
                      actions={renderAcceptedActions?.(item.id) ?? null}
                    />
                  ))}
                </div>
              </section>
            )}
          </div>
        </Stack>
      </div>
    </div>
  );
}
