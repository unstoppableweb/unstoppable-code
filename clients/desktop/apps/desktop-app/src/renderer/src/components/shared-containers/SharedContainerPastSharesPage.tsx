/**
 * The recipient's Past shares page (CAN-4052): the shares they removed, which
 * can be restored, and the ones accepted on this computer.
 *
 * Opened from the "Past shares" row of the Shared with you section and
 * mounted by `WorktreeManager` in the "Archived and deleted" overview's
 * overlay slot. Wiring only: the list is the shared display component, and
 * every row action runs through the same store paths as the sidebar.
 */
import { Count } from '@canopy/ui-shared/primitives/Badge';
import { useEffect, type JSX } from 'react';
import {
  Surface,
  HeaderActionButton,
  SharedContainerPastSharesList,
} from '@canopy/ui-shared/components';
import { BackIcon } from '@canopy/ui-shared/icons/AppIcons';
import { PageTitlebar } from '@/components/shared/PageTitlebar';
import { openAcceptedSharedContainer } from '@/lib/sharedContainerPastSharesNavigation';
import { restoreSharedContainerWithFeedback } from '@/lib/shared-containers/restoreSharedContainerWithFeedback';
import { useSharedContainerReplicasStore } from '@/stores/sharedContainerReplicasStore';
import { SharedContainerRecipientActionsMenu } from './SharedContainerRecipientActionsMenu';
import { useScopedSharedContainerEntries } from './useScopedSharedContainerEntries';

const TEST_ID = 'shared-container-past-shares-page';

export interface SharedContainerPastSharesPageProps {
  onClose: () => void;
}

export function SharedContainerPastSharesPage({
  onClose,
}: SharedContainerPastSharesPageProps): JSX.Element {
  const { acceptedEntries, removedEntries } = useScopedSharedContainerEntries();
  const removedStatus = useSharedContainerReplicasStore(
    (state) => state.removedStatus,
  );
  const restoringIds = useSharedContainerReplicasStore(
    (state) => state.restoringIds,
  );
  const acceptedRecords = useSharedContainerReplicasStore(
    (state) => state.acceptedRecords,
  );
  const loadRemoved = useSharedContainerReplicasStore(
    (state) => state.loadRemoved,
  );

  // The owner revoking a removed share sends this device nothing, so the
  // sidebar's list can be stale by the time the page is opened.
  useEffect(() => {
    void loadRemoved();
  }, [loadRemoved]);

  const totalCount = acceptedEntries.length + removedEntries.length;

  return (
    <Surface
      data-testid={TEST_ID}
      variant="pane"
      extent="parent"
      className="flex min-h-0 flex-col"
    >
      {/* Sized by its header row and kept out of the window drag region, like
          the "Archived and deleted" overview this page shares a slot with. */}
      <PageTitlebar
        height="content"
        dragRegion={false}
        divider
        testId={`${TEST_ID}-titlebar`}
      >
        <div className="flex flex-wrap items-center gap-3 px-4 py-2">
          <HeaderActionButton
            tone="neutral"
            data-testid={`${TEST_ID}-back`}
            onClick={onClose}
            title="Back to the project"
          >
            <BackIcon size="sm" aria-hidden="true" />
            Back
          </HeaderActionButton>
          <span
            className="text-s font-medium fg-primary"
            data-testid={`${TEST_ID}-title`}
          >
            Past shares
          </span>
          <span
            data-testid={`${TEST_ID}-count`}
            className="text-xs fg-secondary"
          >
            <Count value={totalCount} /> {totalCount === 1 ? 'share' : 'shares'}
          </span>
        </div>
      </PageTitlebar>
      <SharedContainerPastSharesList
        removed={removedEntries.map((entry) => ({
          id: entry.container.id,
          title: entry.container.title,
          ...(entry.ownerName !== undefined
            ? { ownerName: entry.ownerName }
            : {}),
          dismissedAt: entry.dismissedAt,
        }))}
        accepted={acceptedEntries.map((entry) => {
          const acceptedAt = acceptedRecords[entry.container.id]?.acceptedAt;
          return {
            id: entry.container.id,
            title: entry.container.title,
            ...(entry.ownerName !== undefined
              ? { ownerName: entry.ownerName }
              : {}),
            ...(acceptedAt !== undefined ? { acceptedAt } : {}),
          };
        })}
        removedStatus={removedStatus === 'idle' ? 'loading' : removedStatus}
        restoringIds={restoringIds}
        onRestore={(id): void => {
          const entry = removedEntries.find(
            (candidate) => candidate.container.id === id,
          );
          if (entry === undefined) return;
          void restoreSharedContainerWithFeedback(id, entry.container.title);
        }}
        onOpenAccepted={(id): void => {
          const entry = acceptedEntries.find(
            (candidate) => candidate.container.id === id,
          );
          // Opening closes this page: the viewer takes the same slot.
          if (entry !== undefined) openAcceptedSharedContainer(entry);
        }}
        onRetryRemoved={(): void => {
          void loadRemoved();
        }}
        renderAcceptedActions={(id): JSX.Element | null => {
          const entry = acceptedEntries.find(
            (candidate) => candidate.container.id === id,
          );
          return entry === undefined ? null : (
            <SharedContainerRecipientActionsMenu entry={entry} reveal={false} />
          );
        }}
      />
    </Surface>
  );
}
