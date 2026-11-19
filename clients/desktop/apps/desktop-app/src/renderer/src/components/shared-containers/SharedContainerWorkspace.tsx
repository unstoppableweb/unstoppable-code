import { useDesktopFilesGuestGate } from '@/hooks/useDesktopFilesGuestGate';
/**
 * Shared-container recipient workspace.
 *
 * The recipient sees what the publisher sees, minus the ability to change
 * anything. This host mounts the SAME desktop panel host, registry, chat
 * surface, file viewer, browser and activity rail the publisher uses, for the
 * read-only scope `(shared-container-viewer, containerId)`. Read-only is a
 * property of that scope, supplied once through {@link WorkspaceAccessContext};
 * there are no recipient-only renderers, so the two views cannot drift.
 *
 * Main resolves every read on this scope to the sealed replica and fails
 * closed on every content write (`assertWritableScope`). The access context is
 * presentation: it hides the composer, turn actions, editors and mutate menus.
 *
 * This host still owns the replica lifecycle: loading, blocked and
 * nothing-published states, the header (title, View only, Make a copy, Run,
 * layout menu), and run consent, which gates only what executes code. The
 * viewer closes through ordinary navigation, like any worktree.
 */
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { WorktreeTopBar as SharedWorktreeTopBar } from '@canopy/ui-app';
import { CoworkTopBar } from '@/components/panels/CoworkTopBar';
import { WorktreeLaunchButton } from '@/components/activity/WorktreeLaunchButton';
import type {
  SharedContainerRepositorySummary,
  SharedContainerRevisionMetadata,
} from '@canopy/desktop-shared/types';
import { SHARED_CONTAINER_SYNC_PHASE_LABELS } from '@canopy/desktop-shared/types';
import { Button } from '@/components/shared/Button';
import { CopyIcon } from '@canopy/ui-shared/icons/AppIcons';
import { LoadingSpinner } from '@/components/shared/loading';
import { DEFAULT_PANEL_HOST_STATE } from '@/lib/panels/panel-host-context';
import { PanelGridSurface } from '@/components/panels/PanelGridSurface';
import { WorkspaceLayoutControls } from '@/components/panels/WorkspaceLayoutControls';
import { CollapsedTitlebarToggle } from '@/components/sidebar/CollapsedTitlebarToggle';
import {
  makeWorktreePanelKey,
  usePanelLayoutStore,
} from '@/stores/panelLayoutStore';
import { useChatStore } from '@/stores/chatStore';
import { useActivityStore } from '@/stores/activityStore';
import { requestChangedFilesRefresh } from '@/stores/changedFilesRefreshRuntime';
import { useFileListStore } from '@/stores/fileListStore';
import { useWorkspaceItemsStore } from '@/stores/workspaceItemsStore';
import {
  ensureTerminalWorktreeHydrated,
  useTerminalStore,
} from '@/stores/terminalStore';
import { sharedContainerBlockReasonCopy } from '@/lib/shared-containers/block-reason-copy';
import { sharedContainerCanView } from '@/lib/shared-containers/panel-allowlist';
import {
  repairSharedContainerPanelLayout,
  shouldCloseSharedContainerTerminalLayout,
} from '@/lib/shared-containers/panel-layout';
import {
  WorkspaceAccessContext,
  type WorkspaceAccess,
} from '@/lib/workspace-access';
import { useCanopyDesktopSharedContainerRunEnabled } from '@/hooks/useCanopyDesktopSharedContainerRunEnabled';
import {
  isReadableReplica,
  SHARED_CONTAINER_VIEWER_WORKSPACE_ID,
  useSharedContainerReplicasStore,
} from '@/stores/sharedContainerReplicasStore';
import { SharedContainerForkModal } from './SharedContainerForkModal';
import { forkRevisionFromReplica } from './useSharedContainerForkRevision';
import { SharedContainerRunPanel } from './SharedContainerRunPanel';
import { useSharedContainerRun } from './useSharedContainerRun';
import { ForkedContainerNotice } from './ForkedContainerNotice';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { Badge, Surface } from '@canopy/ui-shared/components';

const TERMINAL_HYDRATION_RETRY_MS = 1_000;

export interface SharedContainerWorkspaceProps {
  onClose: () => void;
}

export function SharedContainerWorkspace({
  onClose,
}: SharedContainerWorkspaceProps): JSX.Element | null {
  const viewer = useSharedContainerReplicasStore((state) => state.viewer);
  const entries = useSharedContainerReplicasStore((state) => state.entries);
  const retryContainer = useSharedContainerReplicasStore(
    (state) => state.retryContainer,
  );
  const [repositories, setRepositories] = useState<
    readonly SharedContainerRepositorySummary[]
  >([]);
  const [runSheetOpen, setRunSheetOpen] = useState(false);
  const [forkOpen, setForkOpen] = useState(false);
  const [revisionMetadata, setRevisionMetadata] = useState<
    | (SharedContainerRevisionMetadata & {
        containerId: string;
        revisionId: string;
      })
    | null
  >(null);

  const entry = entries.find(
    (candidate) =>
      candidate.container.id === viewer?.containerId &&
      candidate.organizationId === viewer.organizationId,
  );
  const canView = sharedContainerCanView(entry?.container.capabilities);
  const replica = viewer?.replica ?? null;
  const readable = isReadableReplica(replica);
  const viewerContainerId = viewer?.containerId ?? null;
  const readableRevisionId =
    replica?.status === 'available' || replica?.status === 'pinned'
      ? replica.revisionId
      : null;
  const containerType =
    replica?.containerType ?? entry?.container.containerType ?? 'CODE_WORKTREE';
  const surfaceContainerType =
    containerType === 'CODE_WORKTREE' ? 'CODE_WORKTREE' : 'COWORK_WORK_ENTRY';

  // Run affordance (CAN-2831). `runFeatureEnabled` is the flag + platform
  // gate; `runAllowed` additionally requires this device's stored consent, and
  // it is the only value that unlocks a panel kind. Main re-checks both on
  // every spawn, so neither is trusted as a boundary here.
  const runFeatureEnabled = useCanopyDesktopSharedContainerRunEnabled();
  const run = useSharedContainerRun({
    containerId: viewerContainerId,
    revisionId: readableRevisionId,
    featureEnabled: runFeatureEnabled && containerType === 'CODE_WORKTREE',
  });
  const runAllowed =
    run.availability === 'available' && run.status?.allowed === true;
  const closeTerminalLayout = shouldCloseSharedContainerTerminalLayout(
    run.availability,
    runAllowed,
  );
  const containerId = viewerContainerId;
  const filesGuestGate = useDesktopFilesGuestGate(containerId ?? undefined);
  const filesAccountStatus = filesGuestGate.status;
  const layoutKey =
    containerId === null
      ? null
      : makeWorktreePanelKey(SHARED_CONTAINER_VIEWER_WORKSPACE_ID, containerId);
  const [terminalReadyLayoutKey, setTerminalReadyLayoutKey] = useState<
    string | null
  >(null);
  const [terminalHydrationAttempt, setTerminalHydrationAttempt] = useState(0);
  const terminalRunAllowed = runAllowed && terminalReadyLayoutKey === layoutKey;
  // Read-only is a property of this scope. Every standard component under the
  // grid reads it; memoized so a viewer update never churns the context value.
  const access = useMemo<WorkspaceAccess>(
    () => ({
      mode: 'read-only',
      reason: 'shared-container',
      // Every repoless share (Cowork, cloud chat) takes the Cowork surface.
      containerType: surfaceContainerType,
      runAllowed: terminalRunAllowed,
    }),
    [surfaceContainerType, terminalRunAllowed],
  );

  // Chats are a real read-only chat scope: main projects the published chats
  // into canonical chat state on revision promote (and on open when missing),
  // so the standard chat store hydrates them like any worktree's tabs. Later
  // revisions arrive through the main-owned revisioned chat stream as in-place
  // updates, which is what keeps the reader's selected chat and scroll place.
  useEffect(() => {
    if (containerId === null || readableRevisionId === null) return;
    void useChatStore
      .getState()
      .loadTabsForTarget(SHARED_CONTAINER_VIEWER_WORKSPACE_ID, containerId, {
        skipActiveSessions: true,
      });
  }, [containerId, readableRevisionId]);

  const loadedRevisionRef = useRef<{
    containerId: string;
    revisionId: string;
    filesAccountStatus: 'loading' | 'guest' | 'signed-in';
    filesGuestGate: typeof filesGuestGate;
  } | null>(null);
  useEffect(() => {
    if (containerId === null || readableRevisionId === null) {
      loadedRevisionRef.current = null;
      return;
    }
    const previous = loadedRevisionRef.current;
    loadedRevisionRef.current = {
      containerId,
      revisionId: readableRevisionId,
      filesAccountStatus,
      filesGuestGate,
    };
    if (
      previous === null ||
      previous.containerId !== containerId ||
      (previous.revisionId === readableRevisionId &&
        previous.filesAccountStatus === filesAccountStatus &&
        previous.filesGuestGate === filesGuestGate)
    ) {
      return;
    }

    const projectId = SHARED_CONTAINER_VIEWER_WORKSPACE_ID;
    useFileListStore.getState().markFileTreeStale(projectId, containerId);
    const activity = useActivityStore.getState();
    const items = useWorkspaceItemsStore.getState();
    void Promise.allSettled([
      requestChangedFilesRefresh(projectId, containerId, { kind: 'automatic' }),
      ...(surfaceContainerType === 'CODE_WORKTREE'
        ? [activity.loadTrackedPlans(projectId, containerId)]
        : []),
      items.loadNotes(projectId, containerId),
      items.loadPrompts(projectId, containerId),
      ...(filesAccountStatus === 'signed-in'
        ? [
            items.loadAttachments(
              projectId,
              containerId,
              filesGuestGate.captureAccess(),
            ),
          ]
        : []),
    ]);
  }, [
    containerId,
    readableRevisionId,
    surfaceContainerType,
    filesGuestGate,
    filesAccountStatus,
  ]);

  // Hydrate the canonical terminal list before repairing a consented layout.
  // This preserves a live PTY when ordinary navigation remounts the viewer,
  // while still dropping persisted terminal tabs after an app restart.
  const layoutHydrated = usePanelLayoutStore((state) =>
    layoutKey === null ? false : state.layouts[layoutKey] !== undefined,
  );
  useEffect(() => {
    if (
      containerId === null ||
      layoutKey === null ||
      !layoutHydrated ||
      run.availability === 'loading'
    ) {
      return;
    }
    if (!runAllowed) {
      setTerminalReadyLayoutKey(null);
      repairSharedContainerPanelLayout(layoutKey, false);
      return;
    }
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    setTerminalReadyLayoutKey(null);
    void ensureTerminalWorktreeHydrated(
      SHARED_CONTAINER_VIEWER_WORKSPACE_ID,
      containerId,
    )
      .then(() => {
        if (cancelled) return;
        const sessions =
          useTerminalStore.getState().worktrees[layoutKey]?.sessions ?? {};
        const liveTerminalIds = new Set(
          Object.values(sessions)
            .filter((session) => session.live)
            .map((session) => session.id),
        );
        repairSharedContainerPanelLayout(layoutKey, true, liveTerminalIds);
        setTerminalReadyLayoutKey(layoutKey);
      })
      .catch(() => {
        if (cancelled) return;
        retryTimer = setTimeout(() => {
          setTerminalHydrationAttempt((attempt) => attempt + 1);
        }, TERMINAL_HYDRATION_RETRY_MS);
      });
    return (): void => {
      cancelled = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
  }, [
    containerId,
    layoutHydrated,
    layoutKey,
    run.availability,
    runAllowed,
    terminalHydrationAttempt,
  ]);

  // Reaches a layout that is already on screen, for two cases. Revocation:
  // main stops the container's terminals and script runs before it clears the
  // grant, and the status reload that follows yields an available-but-denied
  // status, which this repair acts on. Resolved flag-off and unpublished
  // states: the restored tab is leftover layout from a session when the share
  // was runnable, and leaving it up advertises a capability this share does
  // not have. Only `loading` is preserved, since main has not answered yet.
  useEffect(() => {
    if (!closeTerminalLayout || layoutKey === null) return;
    repairSharedContainerPanelLayout(layoutKey, false);
  }, [closeTerminalLayout, layoutKey]);

  // The sheet is meaningless once the affordance is gone, and leaving it
  // mounted over a revoked share would render a stale consent state.
  useEffect(() => {
    if (run.availability !== 'available') setRunSheetOpen(false);
  }, [run.availability]);

  useEffect(() => {
    if (viewerContainerId === null || readableRevisionId === null) {
      setRevisionMetadata(null);
      return;
    }
    const containerId = viewerContainerId;
    const revisionId = readableRevisionId;
    let cancelled = false;
    void window.api.sharedContainers
      .readRevisionMetadata({ containerId, revisionId })
      .then((metadata) => {
        if (!cancelled) {
          setRevisionMetadata({ ...metadata, containerId, revisionId });
        }
      })
      .catch(() => {
        if (!cancelled) setRevisionMetadata(null);
      });
    return (): void => {
      cancelled = true;
    };
  }, [readableRevisionId, viewerContainerId]);

  useEffect(() => {
    if (viewerContainerId === null || readableRevisionId === null) {
      setRepositories([]);
      return;
    }
    const containerId = viewerContainerId;
    const revisionId = readableRevisionId;
    let cancelled = false;
    void window.api.sharedContainers
      .listRepositories({ containerId, revisionId })
      .then((items) => {
        if (!cancelled) setRepositories(items);
      })
      .catch(() => {
        if (!cancelled) setRepositories([]);
      });
    return (): void => {
      cancelled = true;
    };
  }, [readableRevisionId, viewerContainerId]);

  // Phase ids are internal; the label record next to the phase union is the
  // only place this copy lives, so states and strings cannot drift.
  const loadingLabel =
    viewer?.syncPhase === undefined
      ? SHARED_CONTAINER_SYNC_PHASE_LABELS['checking-access']
      : SHARED_CONTAINER_SYNC_PHASE_LABELS[viewer.syncPhase];

  // Closing the surface must always release the realtime subscription, even
  // when the container disappeared out from under it (purge/revocation).
  useEffect(() => {
    if (viewer === null || !canView) {
      onClose();
    }
  }, [canView, onClose, viewer]);

  if (viewer === null || !canView) return null;

  const title =
    revisionMetadata?.containerId === viewer.containerId &&
    revisionMetadata.revisionId === readableRevisionId
      ? revisionMetadata.title
      : (entry?.container.title ?? 'Shared container');
  const ownerName = entry?.ownerName;

  return (
    <Surface
      data-testid="shared-container-surface"
      variant="pane"
      extent="parent"
      dragRegion={false}
      className="flex min-h-0 flex-col"
    >
      <SharedContainerTopBar
        containerType={surfaceContainerType}
        containerId={viewer.containerId}
        title={title}
        ownerName={ownerName}
        syncedAt={replica?.updatedAt}
        pinned={replica?.status === 'pinned'}
        readable={readable}
        canFork={readableRevisionId !== null}
        canRun={run.availability === 'available'}
        onRun={(): void => setRunSheetOpen(true)}
        onFork={(): void => setForkOpen(true)}
      />

      <ForkedContainerNotice
        projectId={SHARED_CONTAINER_VIEWER_WORKSPACE_ID}
        worktreeId={viewer.containerId}
      />

      {/* Stays mounted when the replica stops being readable, so the dialog
          can say so (and an in-flight copy keeps its dialog). Keyed by
          container: switching shares starts a fresh review. */}
      {forkOpen && (
        <SharedContainerForkModal
          key={viewer.containerId}
          containerId={viewer.containerId}
          organizationId={viewer.organizationId}
          access={viewer.access ?? 'organization'}
          revision={forkRevisionFromReplica(replica)}
          containerType={containerType}
          title={title}
          ownerName={ownerName}
          onClose={(): void => setForkOpen(false)}
        />
      )}

      <div className="flex min-h-0 flex-1 flex-col">
        {viewer.loading && !readable ? (
          <div
            data-testid="shared-container-loading"
            data-sync-phase={viewer.syncPhase ?? 'checking-access'}
            className="flex flex-1 items-center justify-center gap-2 text-s fg-secondary"
          >
            <LoadingSpinner tone="secondary" />
            <span>{loadingLabel}</span>
          </div>
        ) : viewer.openError !== null ? (
          <SharedContainerNotice
            testId="shared-container-open-error"
            title="Could not open this share"
            detail={viewer.openError}
            onRetry={(): void => {
              void retryContainer();
            }}
          />
        ) : replica === null ? (
          <SharedContainerNotice
            testId="shared-container-open-error"
            title="Could not open this share"
            detail="No replica state was returned for this container."
            onRetry={(): void => {
              void retryContainer();
            }}
          />
        ) : replica.status === 'blocked' ? (
          <SharedContainerNotice
            testId={`shared-container-blocked-${replica.reason}`}
            {...sharedContainerBlockReasonCopy(
              replica.reason,
              replica.repository,
            )}
            onRetry={(): void => {
              void retryContainer();
            }}
          />
        ) : replica.status === 'nothing-published' ? (
          <SharedContainerNotice
            testId="shared-container-nothing-published"
            title="Nothing has been shared yet"
            detail="The person who shared this has not published a revision. It will appear here once they do."
          />
        ) : readable ? (
          // The standard grid for the read-only scope. Multi-repo shares
          // show one root per repository in the file explorer and Changes.
          //
          // A re-sync of an already-readable container keeps its content on
          // screen behind this inline progress strip rather than blanking the
          // whole surface back to a spinner.
          //
          // Scope: this covers renderer-initiated re-syncs — "Re-check access"
          // and a re-open — because `applySyncPhase` only relabels a viewer
          // that is already `loading`. A publisher-pushed bump reconciled in
          // main emits the same phases but lands while `loading` is false, so
          // it stays silent. Widening the gate needs main to emit a terminal
          // phase first: `reconcile` only broadcasts replica state on success,
          // so a failed background sync would leave this strip running
          // forever, which is worse than not showing it (CAN-2551).
          <WorkspaceAccessContext.Provider value={access}>
            {viewer.loading && (
              <Surface variant="section" boundary="bottom" className="shrink-0">
                <div
                  data-testid="shared-container-resyncing"
                  data-sync-phase={viewer.syncPhase ?? 'checking-access'}
                  className="flex shrink-0 items-center gap-2 px-3 py-1 text-xs fg-secondary"
                >
                  <LoadingSpinner tone="secondary" />
                  <span>{loadingLabel}</span>
                </div>
              </Surface>
            )}
            <div
              data-testid="shared-container-workspace-grid"
              className="flex min-h-0 flex-1 flex-col"
            >
              <PanelGridSurface
                projectId={SHARED_CONTAINER_VIEWER_WORKSPACE_ID}
                worktreeId={viewer.containerId}
                hostState={DEFAULT_PANEL_HOST_STATE}
                includeAuxWindowContent={false}
              />
            </div>
          </WorkspaceAccessContext.Provider>
        ) : null}
      </div>

      {runSheetOpen && (
        <SharedContainerRunPanel
          run={run}
          {...(ownerName !== undefined ? { publisherName: ownerName } : {})}
          publisherUserId={entry?.container.ownerUserId ?? ''}
          repositories={repositories}
          onClose={(): void => setRunSheetOpen(false)}
        />
      )}
    </Surface>
  );
}

function SharedContainerTopBar({
  containerType,
  containerId,
  title,
  ownerName,
  syncedAt,
  pinned,
  readable,
  canFork,
  canRun,
  onRun,
  onFork,
}: {
  containerType: 'CODE_WORKTREE' | 'COWORK_WORK_ENTRY';
  containerId: string;
  title: string;
  ownerName?: string;
  syncedAt?: string;
  pinned: boolean;
  readable: boolean;
  canFork: boolean;
  canRun: boolean;
  onRun: () => void;
  onFork: () => void;
}): JSX.Element {
  const statusContent = (
    <div
      data-testid="shared-container-top-status"
      className="flex min-w-0 items-center gap-2"
    >
      <span
        data-testid="shared-container-title"
        className="flex h-7 min-w-0 items-center truncate pl-1 pr-2 text-s font-normal fg-primary"
        title={title}
      >
        {title}
      </span>
      {/* Read-only state the recipient reads, not a control: a quiet Badge. */}
      <Badge data-testid="shared-container-read-only-badge">View only</Badge>
      {ownerName !== undefined && (
        <span className="shrink-0 text-xs fg-quaternary">
          {/* The publisher is a person: replay records a box for the name. */}
          Shared by{' '}
          <span className={POSTHOG_REPLAY_BLOCK_CLASS}>{ownerName}</span>
        </span>
      )}
      {syncedAt !== undefined && (
        <span
          data-testid="shared-container-last-synced"
          className="shrink-0 text-xs fg-quaternary"
        >
          Synced {new Date(syncedAt).toLocaleString()}
        </span>
      )}
      {pinned && (
        <span
          data-testid="shared-container-pinned-badge"
          className="shrink-0 text-xs fg-quaternary"
        >
          Pinned
        </span>
      )}
    </div>
  );
  const launchControl = canRun ? (
    <WorktreeLaunchButton
      projectId={SHARED_CONTAINER_VIEWER_WORKSPACE_ID}
      worktreeId={containerId}
      onLaunch={onRun}
      launchLabel="Run"
      launchTestId="shared-container-run-open"
    />
  ) : undefined;
  // The worktree bar's trailing cluster already insets 9px from the edge; the
  // Cowork read-only bar mounts this accessory bare, so it carries its own.
  const trailingAccessory = (
    <div
      className={`electron-no-drag flex shrink-0 items-center gap-2${
        containerType === 'COWORK_WORK_ENTRY' ? ' pr-2.25' : ''
      }`}
    >
      {canFork && (
        <Button
          variant="secondary"
          size="sm"
          data-testid="shared-container-fork-open-modal"
          onClick={onFork}
          className="shrink-0"
        >
          <CopyIcon size="sm" aria-hidden="true" />
          Make a copy
        </Button>
      )}
      {readable && (
        <WorkspaceLayoutControls
          projectId={SHARED_CONTAINER_VIEWER_WORKSPACE_ID}
          worktreeId={containerId}
        />
      )}
    </div>
  );
  const leadingAccessory = <CollapsedTitlebarToggle />;

  return (
    <div data-testid="shared-container-surface-header" className="shrink-0">
      {containerType === 'COWORK_WORK_ENTRY' ? (
        <CoworkTopBar
          workspaceId={SHARED_CONTAINER_VIEWER_WORKSPACE_ID}
          readOnlyContent={{
            leadingAccessory,
            statusContent,
            launchControl,
            trailingAccessory,
          }}
        />
      ) : (
        <SharedWorktreeTopBar
          leadingAccessory={leadingAccessory}
          // Same frame `PrStatusBar` gives a publisher's worktree: 46px tall
          // with 9px insets, so the title and controls sit where they do on
          // the standard bar instead of against its edges.
          statusContent={
            <div className="@container/prbar electron-drag flex min-h-11.5 cursor-default items-center p-2.25">
              {statusContent}
            </div>
          }
          launchControl={launchControl}
          trailingAccessory={trailingAccessory}
        />
      )}
    </div>
  );
}

function SharedContainerNotice({
  testId,
  title,
  detail,
  onRetry,
}: {
  testId: string;
  title: string;
  detail: string;
  onRetry?: () => void;
}): JSX.Element {
  return (
    <div
      data-testid={testId}
      className="flex flex-1 flex-col items-center justify-center p-8 text-center gap-2"
    >
      <p className="text-s font-medium fg-primary">{title}</p>
      <p className="max-w-md text-s fg-secondary">{detail}</p>
      {onRetry !== undefined && (
        <Button
          className=""
          variant="secondary"
          size="sm"
          data-testid="shared-container-retry"
          onClick={onRetry}
        >
          Re-check access
        </Button>
      )}
    </div>
  );
}
