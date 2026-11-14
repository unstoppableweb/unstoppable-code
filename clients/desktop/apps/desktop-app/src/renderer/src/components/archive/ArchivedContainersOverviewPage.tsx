import { Stack } from '@canopy/ui-shared/components';
/**
 * Full-page "Archived and deleted" overview for one workspace.
 *
 * Hosted in the same overlay slot as the archived-container viewer
 * (`WorktreeManager` for code workspaces, `CoworkArchiveOverlay` for cowork
 * and the App Advisor popout) so the left nav stays visible. Lists every
 * retained container in the workspace — "Deleted" items the retention sweep
 * will remove at their expiry and "Archived" items kept until the user
 * deletes them — plus, for cowork / App Advisor, the read-only legacy
 * archived chats. Rows open the per-container viewer, whose Back returns
 * here. "Empty trash" permanently deletes every Deleted item after a preview
 * of what goes and how much disk space comes back.
 *
 * All reads and mutations go through `useArchivedContainersStore`; this page
 * never touches archive files or re-implements retention rules.
 */
import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import { useEffect, useMemo, useState, type JSX, type ReactNode } from 'react';
import type {
  ArchivedContainerSummary,
  StandaloneChatMeta,
} from '@canopy/desktop-shared/types';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import {
  Surface,
  ArchivedOverviewPage,
  ArchivedOverviewRow as SharedArchivedOverviewRow,
  ArchivedStateIcon,
  EmptyTrashDialog as SharedEmptyTrashDialog,
  HeaderActionButton,
  ListRow,
} from '@canopy/ui-shared/components';
import { formatCostAmount } from '@canopy/ui-shared/components/cost';
import { formatByteSize, matchesArchivedQuery } from '@canopy/ui-shared/lib';
import {
  GitPullRequestIcon,
  TrashPermanentlyIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  EMPTY_ARCHIVED_CONTAINERS,
  EMPTY_PENDING_ARCHIVED_CONTAINERS,
  useArchivedContainersStore,
  type PendingArchivedContainer,
} from '@/stores/archivedContainersStore';
import { useBranchDisplayStore } from '@/stores/branchDisplayStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { LoadingSpinner } from '@/components/shared/loading/spinners/LoadingSpinner';
import { PageTitlebar } from '@/components/shared/PageTitlebar';
import {
  CancelActionButton,
  RunningActionIcon,
} from '@/components/shared/CancelableActionButton';
import { DiffCounts } from '@/components/worktree/DiffCounts';
import { getStandaloneRowLabel } from '@/components/standalone-chat/standaloneChatRowHelpers';
import {
  getArchivedContainerDiskUsageBytes,
  getArchivedContainerGuaranteedReclaimableBytes,
  isArchivedContainerDiskUsageComplete,
  getArchivedContainerDisplayName,
  getArchivedContainerState,
  getArchivedContainerStateDescription,
  getArchivedContainerStateLabel,
  getArchivedGitChangesBadge,
  getArchivedGitChangesTooltip,
  getArchivedPullRequestIndicator,
  type ArchivedContainerState,
} from '@/lib/archivedContainerDisplay';
import { formatDateOrEmpty } from '@/lib/format';
import { ArchivedContainerActionsMenu } from './ArchivedContainerActionsMenu';
import { POSTHOG_REPLAY_MASK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';

export type ArchivedContainersOverviewSurface =
  | 'code'
  | 'cowork'
  | 'app-advisor';

export interface ArchivedContainersOverviewPageProps {
  workspaceId: string;
  surface: ArchivedContainersOverviewSurface;
  /** Back: leave the overview and return to the live surface beneath it. */
  onClose: () => void;
}

/** Stable empty legacy list so selectors never allocate per snapshot. */
const EMPTY_LEGACY_CHATS: readonly StandaloneChatMeta[] = Object.freeze([]);

export function ArchivedContainersOverviewPage({
  workspaceId,
  surface,
  onClose,
}: ArchivedContainersOverviewPageProps): JSX.Element {
  const summaries = useArchivedContainersStore(
    (s) => s.byWorkspace[workspaceId] ?? EMPTY_ARCHIVED_CONTAINERS,
  );
  // Removals confirmed in the UI whose container main has not committed
  // yet. They render as placeholder rows so the list reacts instantly.
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
  // The in-flight Empty trash run for THIS workspace (a run elsewhere leaves
  // this page's button idle but blocked from starting a second run).
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

  useEffect(() => {
    if (!loaded) {
      void loadForWorkspace(workspaceId);
    }
  }, [loaded, loadForWorkspace, workspaceId]);

  // Workspace name for the header, from whichever store owns the surface.
  const codeWorkspaceName = useProjectsStore((s) =>
    surface === 'code'
      ? s.projects.find((project) => project.id === workspaceId)?.name
      : undefined,
  );
  const coworkWorkspaceName = useStandaloneChatStore((s) =>
    surface === 'cowork'
      ? s.chatProjects.find((project) => project.id === workspaceId)?.name
      : undefined,
  );
  const workspaceName =
    surface === 'app-advisor'
      ? ORCHESTRATOR_LABEL
      : (codeWorkspaceName ?? coworkWorkspaceName ?? workspaceId);

  // Legacy (pre-entry) archived chats: cowork and App Advisor only. They are
  // read-only and open the legacy archive overlay; retention prunes them on
  // its own schedule, so they list under a separate heading.
  const usesLegacyChats = surface !== 'code';
  const legacyChats = useStandaloneChatStore((s) =>
    usesLegacyChats
      ? (s.legacyArchivedByProject[workspaceId] ?? EMPTY_LEGACY_CHATS)
      : EMPTY_LEGACY_CHATS,
  );
  const legacyLoaded = useStandaloneChatStore(
    (s) =>
      !usesLegacyChats || s.legacyArchivedByProject[workspaceId] !== undefined,
  );
  const loadLegacyArchivedChats = useStandaloneChatStore(
    (s) => s.loadLegacyArchivedChats,
  );
  useEffect(() => {
    if (usesLegacyChats && !legacyLoaded) {
      void loadLegacyArchivedChats(workspaceId).catch(() => {
        // Best-effort: the legacy section simply stays empty.
      });
    }
  }, [usesLegacyChats, legacyLoaded, loadLegacyArchivedChats, workspaceId]);

  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLowerCase();
  const [hiddenStates, setHiddenStates] = useState<ArchivedContainerState[]>(
    [],
  );
  const hiddenStateSet = useMemo(() => new Set(hiddenStates), [hiddenStates]);

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

  const visibleContainers = useMemo(
    () =>
      summaries.filter((container) => {
        const state = getArchivedContainerState(container);
        return (
          !hiddenStateSet.has(state) &&
          matchesArchivedQuery(
            normalizedQuery,
            displayNames.get(container.id),
            container.name,
            container.branchName,
            getArchivedContainerStateLabel(state),
          )
        );
      }),
    [summaries, displayNames, normalizedQuery, hiddenStateSet],
  );
  const pendingDisplayNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const pending of pendingContainers) {
      names.set(
        pending.containerId,
        getArchivedContainerDisplayName(
          {
            id: pending.containerId,
            kind: pending.kind,
            name: pending.name,
            ...(pending.branchName !== undefined
              ? { branchName: pending.branchName }
              : {}),
          },
          getBranchDisplayName,
        ),
      );
    }
    return names;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mappingsVersion invalidates the mapper cache
  }, [pendingContainers, getBranchDisplayName, mappingsVersion]);
  const visiblePendingContainers = useMemo(
    () =>
      pendingContainers.filter(
        (pending) =>
          !hiddenStateSet.has(pending.state) &&
          matchesArchivedQuery(
            normalizedQuery,
            pendingDisplayNames.get(pending.containerId),
            pending.name,
            pending.branchName,
            getArchivedContainerStateLabel(pending.state),
          ),
      ),
    [pendingContainers, pendingDisplayNames, normalizedQuery, hiddenStateSet],
  );
  // Legacy chats are always "Archived" items.
  const visibleLegacyChats = useMemo(
    () =>
      hiddenStateSet.has('archived')
        ? []
        : legacyChats.filter((chat) =>
            matchesArchivedQuery(
              normalizedQuery,
              getStandaloneRowLabel(chat),
              chat.title,
            ),
          ),
    [legacyChats, normalizedQuery, hiddenStateSet],
  );

  const deletedContainers = useMemo(
    () =>
      summaries.filter(
        (container) => getArchivedContainerState(container) === 'deleted',
      ),
    [summaries],
  );
  const totalCount =
    summaries.length + pendingContainers.length + legacyChats.length;

  useCurrentUiStateReporter('archivedContainers', {
    count: summaries.length + pendingContainers.length,
    viewerOpen: false,
    overviewOpen: true,
    workspaceId,
    emptyTrashConfirmationOpen: confirmingEmptyTrash,
  });

  const openContainer = (containerId: string): void => {
    openViewer(workspaceId, containerId);
  };

  const openLegacyChat = (chatId: string): void => {
    const standalone = useStandaloneChatStore.getState();
    if (workspaceId === APP_ADVISOR_PROJECT_ID) {
      void standalone.selectArchive(chatId);
      return;
    }
    void standalone.openArchivedChatFromSidebar(workspaceId, chatId);
  };

  // Confirm closes the preview at once; the run continues in the store and
  // the Empty trash button becomes its cancel control (git-action pattern:
  // same label, spinner in the icon slot, hover ✕, click to cancel).
  const startEmptyTrash = (): void => {
    dismissEmptyTrashConfirmation();
    startArchivedEmptyTrash(workspaceId, emptyTrash, addToast);
  };
  const emptyTrashRunning = emptyTrashRun !== null;
  const emptyTrashCancelRequested = emptyTrashRun?.cancelRequested === true;
  const emptyTrashCancellable = emptyTrashRunning && !emptyTrashCancelRequested;
  const emptyTrashProgress =
    emptyTrashRun !== null
      ? `${Math.min(emptyTrashRun.completed + 1, emptyTrashRun.total)} of ${emptyTrashRun.total}`
      : null;

  return (
    <>
      <ArchivedOverviewPage
        workspaceId={workspaceId}
        workspaceName={workspaceName}
        totalCount={totalCount}
        loaded={loaded}
        hasMatches={
          visibleContainers.length +
            visiblePendingContainers.length +
            visibleLegacyChats.length >
          0
        }
        query={query}
        onQueryChange={setQuery}
        hiddenStates={hiddenStates}
        onHiddenStatesChange={setHiddenStates}
        onClose={onClose}
        renderHeader={(content) => (
          <ArchivedOverviewHeaderShell surface={surface}>
            {content}
          </ArchivedOverviewHeaderShell>
        )}
        headerActions={
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {/* Mirrors the worktree top bar's git actions: while the run is
              active the button keeps its label, swaps its icon for a
              spinner, and IS the cancel control (with a hover ✕ in the icon
              slot). Cancel is honored between items only. */}
            <div
              className="group/gitaction relative inline-flex items-center"
              data-testid="archived-overview-empty-trash-group"
              data-running={emptyTrashRunning ? 'true' : 'false'}
              data-cancel-requested={
                emptyTrashCancelRequested ? 'true' : 'false'
              }
            >
              <HeaderActionButton
                tone="destructive"
                // Same group-hover parity as the git actions so the pill stays
                // lit while the pointer is on the ✕ overlay beside it.
                groupHover
                onClick={() => {
                  if (emptyTrashCancellable) {
                    cancelEmptyTrash();
                    return;
                  }
                  if (emptyTrashRunning) return;
                  requestEmptyTrashConfirmation(workspaceId);
                }}
                disabled={
                  emptyTrashRunning
                    ? !emptyTrashCancellable
                    : deletedContainers.length === 0 || emptyTrashBusyElsewhere
                }
                aria-label={
                  emptyTrashCancellable
                    ? 'Cancel Empty trash'
                    : emptyTrashCancelRequested
                      ? 'Stopping after the current item'
                      : undefined
                }
                data-testid="archived-overview-empty-trash"
                title={
                  emptyTrashCancellable
                    ? 'Stop after the current item finishes'
                    : emptyTrashCancelRequested
                      ? 'Stopping after the current item'
                      : deletedContainers.length === 0
                        ? 'Empty trash is unavailable'
                        : 'Permanently delete every deleted item in this project'
                }
              >
                {emptyTrashRunning ? (
                  <RunningActionIcon
                    cancellationRequested={emptyTrashCancelRequested}
                    spinnerTone="destructive"
                  />
                ) : (
                  <TrashPermanentlyIcon size="sm" aria-hidden="true" />
                )}
                Empty trash
                {emptyTrashProgress !== null && (
                  <span
                    className="tabular-nums opacity-70"
                    data-testid="archived-overview-empty-trash-progress"
                  >
                    {emptyTrashProgress}
                  </span>
                )}
              </HeaderActionButton>
              {emptyTrashCancellable && (
                <CancelActionButton
                  tone="destructive"
                  onCancel={cancelEmptyTrash}
                  label="Cancel Empty trash"
                />
              )}
            </div>
          </div>
        }
      >
        <Stack gap="item">
          <div
            className="flex flex-col gap-0.5"
            data-testid="archived-overview-list"
          >
            {visiblePendingContainers.map((pending) => (
              <PendingArchivedRow
                key={pending.containerId}
                pending={pending}
                displayName={
                  pendingDisplayNames.get(pending.containerId) ?? pending.name
                }
              />
            ))}
            {visibleContainers.map((container) => (
              <ArchivedOverviewRow
                key={container.id}
                container={container}
                displayName={displayNames.get(container.id) ?? container.name}
                onOpen={() => openContainer(container.id)}
              />
            ))}
          </div>
          {visibleLegacyChats.length > 0 && (
            <div data-testid="archived-overview-legacy">
              <div className="px-2 py-1 text-2xs font-medium fg-tertiary">
                Legacy archived chats
              </div>
              <div className="flex flex-col gap-0.5">
                {visibleLegacyChats.map((chat) => (
                  <ListRow
                    key={chat.id}
                    data-testid={`archived-overview-legacy-row-${chat.id}`}
                    data-standalone-chat-id={chat.id}
                    data-archived="true"
                    onClick={() => openLegacyChat(chat.id)}
                    icon={<ArchivedStateIcon state="archived" />}
                    trailing={formatDateOrEmpty(
                      chat.archivedAt ?? chat.lastMessageAt ?? chat.createdAt,
                    )}
                  >
                    <span title={getStandaloneRowLabel(chat)}>
                      {getStandaloneRowLabel(chat)}
                    </span>
                  </ListRow>
                ))}
              </div>
            </div>
          )}
        </Stack>
      </ArchivedOverviewPage>
      {confirmingEmptyTrash && (
        <DesktopEmptyTrashDialog
          items={deletedContainers}
          displayNames={displayNames}
          onCancel={dismissEmptyTrashConfirmation}
          onConfirm={startEmptyTrash}
        />
      )}
    </>
  );
}

/**
 * Runs Empty trash for a workspace and reports how it went: stopped early,
 * items that failed, or items that became Archived and were kept. Shared by
 * the More page and the cowork overview.
 */
export function startArchivedEmptyTrash(
  workspaceId: string,
  emptyTrash: ReturnType<
    typeof useArchivedContainersStore.getState
  >['emptyTrash'],
  addToast: ReturnType<typeof useGitHubStore.getState>['addToast'],
): void {
  void emptyTrash(workspaceId)
    .then((result) => {
      const itemWord = (count: number): string =>
        count === 1 ? 'item' : 'items';
      if (result.cancelled) {
        addToast(
          `Stopped emptying trash. ${result.deletedIds.length} ${itemWord(
            result.deletedIds.length,
          )} deleted, ${result.remainingIds.length} left.`,
          'info',
        );
      }
      if (result.failedIds.length > 0) {
        addToast(
          `Couldn't delete ${result.failedIds.length} ${itemWord(
            result.failedIds.length,
          )}. Try again.`,
          'error',
        );
      }
      if (!result.cancelled && result.remainingIds.length > 0) {
        const keptVerb = result.remainingIds.length === 1 ? 'was' : 'were';
        addToast(
          `${result.remainingIds.length} ${itemWord(
            result.remainingIds.length,
          )} became Archived and ${keptVerb} kept.`,
          'info',
        );
      }
    })
    .catch(() => {
      addToast(
        "Trash was emptied, but the latest archive state couldn't be loaded. Refresh and check the remaining items.",
        'error',
      );
    });
}

interface ArchivedOverviewHeaderShellProps {
  surface: ArchivedContainersOverviewSurface;
  children: ReactNode;
}

/**
 * Top-bar shell for the overview header (CAN-3054).
 *
 * Only the code surface needs the reservation. There `WorktreeManager` mounts
 * this page as an `absolute inset-0` overlay on its own root, so the overlay
 * covers `WorktreeTopBar` and owns the window's top row itself — and the page
 * header shares an origin with the persistent titlebar corner (the app-wide
 * sidebar toggle plus, on macOS, the traffic-light reserve) the moment the
 * sidebar is hidden. Without a reservation "Archived and deleted" and Back
 * paint underneath it. `PageTitlebar` contributes the same animated leading
 * inset every other page uses, and it is zero-width while the sidebar is
 * docked, so the docked layout is untouched.
 *
 * The other two surfaces already sit below something that owns the top row, so
 * an inline reservation there would only indent the header for no reason:
 * - cowork: `StandaloneChatPage` keeps `CoworkTopBar` (which carries its own
 *   `CollapsedTitlebarToggle`) mounted while the overview is open — it unmounts
 *   only for the container viewer — and the overlay's containing block is the
 *   grid section beneath that bar.
 * - app-advisor: `CoworkArchiveOverlay` pushes this page below a full-width
 *   drag strip that reserves the popout's titlebar row.
 */
function ArchivedOverviewHeaderShell({
  surface,
  children,
}: ArchivedOverviewHeaderShellProps): JSX.Element {
  if (surface !== 'code') {
    return (
      <Surface variant="section" boundary="bottom" className="shrink-0">
        <div className="shrink-0" data-testid="archived-overview-titlebar">
          {children}
        </div>
      </Surface>
    );
  }
  // Sized by its header row rather than the shared 40px strip, and kept out
  // of the window drag region like its cowork-surface twin above.
  return (
    <PageTitlebar
      height="content"
      dragRegion={false}
      divider
      testId="archived-overview-titlebar"
    >
      {children}
    </PageTitlebar>
  );
}

interface PendingArchivedRowProps {
  pending: PendingArchivedContainer;
  displayName: string;
}

/**
 * Placeholder for a removal main is still capturing. Same shape as a real
 * row, but a spinner stands in for the state icon and there is nothing to
 * open, size, or act on yet.
 */
function PendingArchivedRow({
  pending,
  displayName,
}: PendingArchivedRowProps): JSX.Element {
  const progressLabel =
    pending.state === 'archived' ? 'Archiving…' : 'Deleting…';
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={`${progressLabel} ${displayName}`}
      data-testid={`archived-overview-pending-${pending.containerId}`}
      data-state={pending.state}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left"
    >
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        <LoadingSpinner tone="secondary" />
      </span>
      <span
        className={`${POSTHOG_REPLAY_MASK_CLASS} min-w-0 flex-1 truncate text-xs leading-snug fg-primary/60`}
        title={displayName}
      >
        {displayName}
      </span>
      <span className="shrink-0 text-2xs fg-secondary">{progressLabel}</span>
    </div>
  );
}

interface ArchivedOverviewRowProps {
  container: ArchivedContainerSummary;
  displayName: string;
  onOpen: () => void;
}

function ArchivedOverviewRow({
  container,
  displayName,
  onOpen,
}: ArchivedOverviewRowProps): JSX.Element {
  const state = getArchivedContainerState(container);
  const stateLabel = getArchivedContainerStateLabel(state);
  // Immutable aggregates from the archive manifest — rendering the row never
  // triggers Git, GitHub, or changed-file list work.
  const changesBadge = getArchivedGitChangesBadge(container);
  const pullRequestIndicator = getArchivedPullRequestIndicator(container);
  const diskUsageBytes = getArchivedContainerDiskUsageBytes(container);
  const diskUsageComplete = isArchivedContainerDiskUsageComplete(container);
  // The shared row formats every supplied number, including zero, as a
  // dollar amount, so absent and zero totals both stay omitted here.
  const observedCostUsd =
    Number.isFinite(container.observedCostUsd) &&
    container.observedCostUsd !== undefined &&
    container.observedCostUsd > 0
      ? container.observedCostUsd
      : undefined;
  const stateDate = formatDateOrEmpty(
    state === 'archived'
      ? (container.lockedAt ?? container.archivedAt)
      : container.archivedAt,
  );
  return (
    <SharedArchivedOverviewRow
      state={state}
      title={displayName}
      titleTooltip={container.branchName ?? displayName}
      stateTooltipTestId={`archived-overview-state-tooltip-${container.id}`}
      stateTestId={`archived-overview-state-${container.id}`}
      stateTooltip={
        <Stack gap="tight">
          <div className="font-medium fg-primary">{stateLabel}</div>
          <span className="fg-secondary">
            {getArchivedContainerStateDescription(
              state,
              formatDateOrEmpty(container.expiresAt),
            )}
          </span>
        </Stack>
      }
      {...(observedCostUsd === undefined
        ? {}
        : { observedCostLabel: formatCostAmount(observedCostUsd) })}
      trailing={
        <>
          {pullRequestIndicator !== null && (
            <span
              data-testid={`archived-overview-pr-${container.id}`}
              title={pullRequestIndicator.tooltip}
              aria-label={pullRequestIndicator.tooltip}
              className="flex shrink-0 items-center fg-secondary"
            >
              <GitPullRequestIcon size="xs" />
            </span>
          )}
          {changesBadge !== null && (
            <span
              data-testid={`archived-overview-diff-${container.id}`}
              title={getArchivedGitChangesTooltip(changesBadge)}
              aria-label={getArchivedGitChangesTooltip(changesBadge)}
              className="shrink-0"
            >
              <DiffCounts
                compact
                stats={{
                  insertions: changesBadge.insertions,
                  deletions: changesBadge.deletions,
                }}
              />
            </span>
          )}
          <span
            data-testid={`archived-overview-size-${container.id}`}
            className="shrink-0 text-2xs tabular-nums fg-secondary"
            title="Measured archive footprint; retained Git objects may be shared"
          >
            {diskUsageBytes !== null
              ? `${diskUsageComplete ? '' : 'At least '}${formatByteSize(diskUsageBytes, { precision: 'adaptive' })}`
              : '…'}
          </span>
        </>
      }
      date={stateDate}
      dateTooltip={`${stateLabel} ${stateDate}`}
      onOpen={onOpen}
      openTestId={`archived-overview-open-${container.id}`}
      testId={`archived-overview-row-${container.id}`}
      actions={
        <ArchivedContainerActionsMenu
          summary={container}
          testIdPrefix={`archived-overview-${container.id}`}
        />
      }
    />
  );
}

interface DesktopEmptyTrashDialogProps {
  items: readonly ArchivedContainerSummary[];
  displayNames: ReadonlyMap<string, string>;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Scrollable preview of every Deleted item that Empty trash removes, with the
 * total count and a conservative lower bound for disk space that comes back.
 * Git bytes are excluded because other refs or archives may retain them.
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
    if (bytes !== null) {
      guaranteedReclaimableBytes += bytes;
    }
  }
  const count = items.length;
  const itemWord = count === 1 ? 'item' : 'items';
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
          data-testid="archived-overview-empty-trash-summary"
        >
          <span>
            {count} {itemWord}
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
