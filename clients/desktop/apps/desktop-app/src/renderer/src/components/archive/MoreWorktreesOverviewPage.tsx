/**
 * The More page for a code project on desktop: its hidden, archived and
 * deleted worktrees in one place, opened from the project's More row.
 *
 * The page itself is the shared `MoreWorktreesPage`; this host supplies the
 * items. Hidden worktrees come from the shared sidebar (which still owns
 * their Open, Unhide, Archive and Delete); archived and deleted ones come from
 * `useArchivedContainersStore`, whose actions and Empty trash run unchanged.
 * Cowork and App Advisor keep `ArchivedContainersOverviewPage`, which also
 * lists their legacy archived chats.
 */
import { useEffect, useMemo, useState, type JSX } from 'react';
import type { ArchivedContainerSummary } from '@canopy/desktop-shared/types';
import {
  Button,
  EmptyTrashDialog as SharedEmptyTrashDialog,
  MoreWorktreesPage,
  Notice,
  NoticeButton,
  type MoreWorktreeItem,
} from '@canopy/ui-shared/components';
import { formatByteSize } from '@canopy/ui-shared/lib';
import {
  archivedMoreWorktreeItem,
  formatMoreWorktreeDate,
  useHiddenMoreWorktreeItems,
  useSidebarMoreWorkspace,
} from '@canopy/ui-app';
import { POSTHOG_REPLAY_MASK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import {
  EMPTY_ARCHIVED_CONTAINERS,
  EMPTY_PENDING_ARCHIVED_CONTAINERS,
  useArchivedContainersStore,
} from '@/stores/archivedContainersStore';
import { useBranchDisplayStore } from '@/stores/branchDisplayStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { DeleteConfirmModal } from '@/components/shared/DeleteConfirmModal';
import {
  getArchivedContainerDiskUsageBytes,
  getArchivedContainerGuaranteedReclaimableBytes,
  getArchivedContainerDisplayName,
  getArchivedContainerState,
  getArchivedGitChangesBadge,
} from '@/lib/archivedContainerDisplay';
import { startArchivedEmptyTrash } from './ArchivedContainersOverviewPage';
import { useArchivedContainerBatchActions } from './useArchivedContainerActions';

export interface MoreWorktreesOverviewPageProps {
  readonly workspaceId: string;
  /** Leaves the page for the live surface beneath it. */
  readonly onClose: () => void;
}

const TEST_ID = 'more-worktrees';

export function MoreWorktreesOverviewPage({
  workspaceId,
  onClose,
}: MoreWorktreesOverviewPageProps): JSX.Element {
  const summaries = useArchivedContainersStore(
    (s) => s.byWorkspace[workspaceId] ?? EMPTY_ARCHIVED_CONTAINERS,
  );
  const pendingContainers = useArchivedContainersStore(
    (s) =>
      s.pendingByWorkspace[workspaceId] ?? EMPTY_PENDING_ARCHIVED_CONTAINERS,
  );
  const loaded = useArchivedContainersStore(
    (s) => s.loadedWorkspaces[workspaceId] === true,
  );
  const loadForWorkspace = useArchivedContainersStore(
    (s) => s.loadForWorkspace,
  );
  const openViewer = useArchivedContainersStore((s) => s.openViewer);
  const emptyTrash = useArchivedContainersStore((s) => s.emptyTrash);
  const cancelEmptyTrash = useArchivedContainersStore(
    (s) => s.cancelEmptyTrash,
  );
  const requestEmptyTrashConfirmation = useArchivedContainersStore(
    (s) => s.requestEmptyTrashConfirmation,
  );
  const dismissEmptyTrashConfirmation = useArchivedContainersStore(
    (s) => s.dismissEmptyTrashConfirmation,
  );
  const confirmingEmptyTrash = useArchivedContainersStore(
    (s) => s.emptyTrashConfirmationWorkspaceId === workspaceId,
  );
  const emptyTrashRun = useArchivedContainersStore((s) =>
    s.emptyTrashRun?.workspaceId === workspaceId ? s.emptyTrashRun : null,
  );
  const emptyTrashBusyElsewhere = useArchivedContainersStore(
    (s) =>
      s.emptyTrashRun !== null && s.emptyTrashRun.workspaceId !== workspaceId,
  );
  const addToast = useGitHubStore((s) => s.addToast);
  const getBranchDisplayName = useBranchDisplayStore((s) => s.getDisplayName);
  const mappingsVersion = useBranchDisplayStore((s) => s.mappingsVersion);
  const projectName = useProjectsStore(
    (s) => s.projects.find((project) => project.id === workspaceId)?.name,
  );
  const sidebarWorkspace = useSidebarMoreWorkspace(workspaceId);
  const actions = useArchivedContainerBatchActions(workspaceId);
  const [confirmingPurge, setConfirmingPurge] =
    useState<ArchivedContainerSummary | null>(null);

  // Archived and deleted worktrees load on their own; hidden ones never wait
  // for them. A failed load says so, with a way to try again.
  const [archiveLoadFailed, setArchiveLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  useEffect(() => {
    if (loaded) return undefined;
    let active = true;
    loadForWorkspace(workspaceId, { strict: true }).catch((error: unknown) => {
      reportClientAppError(error);
      if (active) setArchiveLoadFailed(true);
    });
    return (): void => {
      active = false;
    };
  }, [loaded, loadAttempt, loadForWorkspace, workspaceId]);

  const hiddenItems = useHiddenMoreWorktreeItems(workspaceId, {
    onBeforeOpen: onClose,
    testIdPrefix: TEST_ID,
  });

  const displayNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const container of summaries) {
      names.set(
        container.id,
        getArchivedContainerDisplayName(container, getBranchDisplayName),
      );
    }
    return names;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mappingsVersion invalidates the mapper cache
  }, [summaries, getBranchDisplayName, mappingsVersion]);

  const deletedContainers = useMemo(
    () =>
      summaries.filter(
        (container) => getArchivedContainerState(container) === 'deleted',
      ),
    [summaries],
  );

  const items = useMemo((): readonly MoreWorktreeItem[] | null => {
    // Nothing to show yet: the page's own loading state, not an empty one.
    if (!loaded && !archiveLoadFailed && hiddenItems.length === 0) {
      return null;
    }
    const pending = pendingContainers.map(
      (entry): MoreWorktreeItem => ({
        id: entry.containerId,
        state: entry.state,
        title: getArchivedContainerDisplayName(
          {
            id: entry.containerId,
            kind: entry.kind,
            name: entry.name,
            ...(entry.branchName !== undefined
              ? { branchName: entry.branchName }
              : {}),
          },
          getBranchDisplayName,
        ),
        ...(entry.branchName !== undefined ? { branch: entry.branchName } : {}),
        date: '',
        progressLabel: entry.state === 'archived' ? 'Archiving…' : 'Deleting…',
      }),
    );
    const retained = summaries.map((container): MoreWorktreeItem => {
      const state = getArchivedContainerState(container);
      const changes = getArchivedGitChangesBadge(container);
      return archivedMoreWorktreeItem({
        id: container.id,
        state,
        title: displayNames.get(container.id) ?? container.name,
        ...(container.branchName !== undefined
          ? { branch: container.branchName }
          : {}),
        ...(changes === null
          ? {}
          : {
              insertions: changes.insertions,
              deletions: changes.deletions,
            }),
        date: formatMoreWorktreeDate(
          state === 'archived'
            ? (container.lockedAt ?? container.archivedAt)
            : container.archivedAt,
        ),
        expiresAt: container.expiresAt ?? null,
        busy: actions.busy.has(container.id),
        onOpen: () => openViewer(workspaceId, container.id),
        onRestore: () => void actions.restore(container.id),
        onToggleState: () =>
          void actions.setArchived(container.id, state !== 'archived'),
        onDeletePermanently: () => setConfirmingPurge(container),
        testIdPrefix: TEST_ID,
      });
    });
    // A hidden worktree being archived or deleted is still in the sidebar
    // until its removal lands; it shows once, as the change in progress.
    const removing = new Set([
      ...pendingContainers.map((entry) => entry.containerId),
      ...summaries.map((container) => container.id),
    ]);
    return [
      ...hiddenItems.filter((item) => !removing.has(item.id)),
      ...pending,
      ...retained,
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mappingsVersion invalidates the mapper cache
  }, [
    loaded,
    archiveLoadFailed,
    hiddenItems,
    pendingContainers,
    summaries,
    displayNames,
    actions,
    openViewer,
    workspaceId,
    getBranchDisplayName,
    mappingsVersion,
  ]);

  useCurrentUiStateReporter('archivedContainers', {
    count: summaries.length + pendingContainers.length,
    viewerOpen: false,
    overviewOpen: true,
    workspaceId,
    emptyTrashConfirmationOpen: confirmingEmptyTrash,
  });

  // Confirm closes the preview at once; the run continues in the store and
  // the Empty trash button becomes its Stop control.
  const startEmptyTrash = (): void => {
    dismissEmptyTrashConfirmation();
    startArchivedEmptyTrash(workspaceId, emptyTrash, addToast);
  };
  const emptyTrashRunning = emptyTrashRun !== null;
  const emptyTrashCancelRequested = emptyTrashRun?.cancelRequested === true;
  const emptyTrashProgress =
    emptyTrashRun !== null
      ? `${Math.min(emptyTrashRun.completed + 1, emptyTrashRun.total)} of ${emptyTrashRun.total}`
      : null;

  const emptyTrashButton =
    deletedContainers.length > 0 || emptyTrashRunning ? (
      <Button
        variant="ghost-destructive"
        size="compact"
        data-testid={`${TEST_ID}-empty-trash`}
        data-running={emptyTrashRunning ? 'true' : 'false'}
        disabled={
          emptyTrashRunning
            ? emptyTrashCancelRequested
            : emptyTrashBusyElsewhere
        }
        onClick={(): void => {
          if (emptyTrashRunning) {
            if (!emptyTrashCancelRequested) cancelEmptyTrash();
            return;
          }
          requestEmptyTrashConfirmation(workspaceId);
        }}
      >
        {emptyTrashRunning
          ? emptyTrashCancelRequested
            ? 'Stopping…'
            : `Stop emptying trash · ${emptyTrashProgress ?? ''}`
          : 'Empty trash'}
      </Button>
    ) : undefined;

  return (
    <>
      <MoreWorktreesPage
        projectName={sidebarWorkspace?.name ?? projectName ?? 'project'}
        {...(sidebarWorkspace === undefined
          ? {}
          : { unitLabelPlural: sidebarWorkspace.unitLabelPlural })}
        items={items}
        {...(archiveLoadFailed ? { emptyMessage: 'No hidden worktrees.' } : {})}
        notices={
          loaded ? undefined : archiveLoadFailed ? (
            <Notice
              errorSource="more-worktrees-archive-load"
              intent="destructive"
              data-testid={`${TEST_ID}-archive-load-failed`}
              actions={
                <NoticeButton
                  onClick={(): void => {
                    setArchiveLoadFailed(false);
                    setLoadAttempt((attempt) => attempt + 1);
                  }}
                >
                  Try again
                </NoticeButton>
              }
            >
              Archived and deleted worktrees couldn't load.
            </Notice>
          ) : undefined
        }
        {...(emptyTrashButton === undefined
          ? {}
          : { actions: emptyTrashButton })}
        testIdPrefix={TEST_ID}
      />
      {confirmingEmptyTrash && (
        <DesktopEmptyTrashDialog
          items={deletedContainers}
          displayNames={displayNames}
          onCancel={dismissEmptyTrashConfirmation}
          onConfirm={startEmptyTrash}
        />
      )}
      {confirmingPurge !== null && (
        <DeleteConfirmModal
          title="Delete permanently?"
          message={
            <p className="text-s fg-secondary">
              Delete{' '}
              <span
                className={`${POSTHOG_REPLAY_MASK_CLASS} font-medium fg-primary`}
              >
                {displayNames.get(confirmingPurge.id) ?? confirmingPurge.name}
              </span>
              ? This permanently removes its chats and retained history and
              cannot be undone.
            </p>
          }
          confirmLabel="Delete permanently"
          pendingLabel="Deleting…"
          pending={actions.busy.has(confirmingPurge.id)}
          dataTestId={`${TEST_ID}-${confirmingPurge.id}-delete-confirmation`}
          confirmTestId={`${TEST_ID}-${confirmingPurge.id}-delete-confirm`}
          onCancel={() => setConfirmingPurge(null)}
          onConfirm={() => {
            const target = confirmingPurge;
            void actions
              .deletePermanently(target.id)
              .finally(() => setConfirmingPurge(null));
          }}
        />
      )}
    </>
  );
}

interface DesktopEmptyTrashDialogProps {
  readonly items: readonly ArchivedContainerSummary[];
  readonly displayNames: ReadonlyMap<string, string>;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

/**
 * Every Deleted worktree Empty trash removes, with the count and a
 * conservative lower bound for the disk space that comes back.
 */
function DesktopEmptyTrashDialog({
  items,
  displayNames,
  onCancel,
  onConfirm,
}: DesktopEmptyTrashDialogProps): JSX.Element {
  let guaranteedReclaimableBytes = 0;
  for (const item of items) {
    const bytes = getArchivedContainerGuaranteedReclaimableBytes(item);
    if (bytes !== null) guaranteedReclaimableBytes += bytes;
  }
  const count = items.length;
  return (
    <SharedEmptyTrashDialog
      itemTone="quiet"
      items={items.map((item) => {
        const bytes = getArchivedContainerDiskUsageBytes(item);
        return {
          id: item.id,
          name: displayNames.get(item.id) ?? item.name,
          trailing: (
            <span className="shrink-0 tabular-nums fg-secondary">
              {bytes !== null
                ? formatByteSize(bytes, { precision: 'adaptive' })
                : '…'}
            </span>
          ),
        };
      })}
      summary={
        <div
          className="flex items-center justify-between text-xs fg-secondary"
          data-testid={`${TEST_ID}-empty-trash-summary`}
        >
          <span>
            {count} {count === 1 ? 'item' : 'items'}
          </span>
          <span>
            Frees at least{' '}
            {formatByteSize(guaranteedReclaimableBytes, {
              precision: 'adaptive',
            })}
          </span>
        </div>
      }
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}
