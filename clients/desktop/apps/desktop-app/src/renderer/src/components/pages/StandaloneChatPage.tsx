import { Surface } from '@canopy/ui-shared/components';
import { DesktopErrorBanner } from '@/components/shared/DesktopErrorBanner';
/**
 * The Cowork page — the Cowork workspace UX aligned onto the Code-workspace
 * panel grid. Renders {@link CoworkTopBar} (New chat / archived chats / Open
 * in / layout dropdown — no git chrome) above a {@link PanelGridSurface}
 * keyed `(coworkWorkspaceId, activeWorkEntryId)`: each Work Entry is a
 * worktree-like multi-chat container occupying the worktreeId slot, so chat
 * tabs, archives, and panel layout are isolated per entry. Multi chat tabs
 * come from the standard chatStore model: cowork chats are ordinary chat
 * tabs persisted through `resolveChatTabsFilePath`, and the chat ⇄ panel
 * sync bridge materializes one chat panel per tab.
 *
 * This page still owns the cowork shell concerns: store initialization and
 * previous-worktree restore, cold-start CTA, work-entry metadata refresh
 * polling, archive-summary readiness, and the legacy archived-chat viewer
 * overlay (sidebar Archived entries persisted under `chat-history/{chatId}/`).
 *
 * Aux (popped-out) panel windows stay owned by the always-mounted
 * WorktreePart, so this grid passes `includeAuxWindowContent={false}`.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type JSX,
} from 'react';
import { subscribeToChatEvents } from '@/lib/chatEventFanout';
import { isBotProjectId } from '@canopy/protocol/chat-targets';
import { useChatStore, useWorktreeChatRenderState } from '@/stores/chatStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { reportRendererConsoleError } from '@/lib/renderer-error-logging';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import {
  isMainContentCoveredByAppAdvisorDock,
  subscribeAppAdvisorDockCover,
} from '@/stores/appAdvisorDockCover';
import { placeActiveStandaloneChatInGroup } from '@/lib/panels/startChatInGroup';
import { useArchivedContainersStore } from '@/stores/archivedContainersStore';
import { getSidebarScopingContext } from '@/components/sidebar/useSidebarScopingContext';
import { useProjectsStore } from '@/stores/projectsStore';
import { canNavigateToWorktreeFromSidebarItems } from '@/lib/worktreeNavigation';
import {
  getCoworkActivityStatus,
  shouldAcknowledgeCoworkTarget,
  shouldReassertRetainedCoworkEntryOnPageMount,
  selectionBelongsToContext,
  shouldRestorePreviousWorktreeAfterCoworkPageUnmount,
} from '@/lib/standaloneChatSelection';
import { StandaloneColdStartEmptyState } from '@/components/standalone-chat/StandaloneColdStartEmptyState';
import { CoworkArchiveOverlay } from '@/components/standalone-chat/CoworkArchiveOverlay';
import {
  sweepCoworkArchives,
  whenNoWorkEntryLoads,
} from '@/components/pages/cowork-archive-sweep';
import { useCoworkArchiveOverlayOpen } from '@/components/standalone-chat/coworkArchiveOverlayState';
import { useNavigationStore } from '@/stores/navigationStore';
import { CoworkTopBar } from '@/components/panels/CoworkTopBar';
import { PanelGridSurface } from '@/components/panels/PanelGridSurface';
import { WorktreeGitActionError } from '@/components/github/WorktreeGitActionError';
import type { PanelHostState } from '@/lib/panels/panel-host-context';
import { PanelGridLoadingCard } from '@canopy/ui-shared/components/panels';
import { isCoworkChatTarget } from '@/lib/cowork';
import type { WorktreeSelection } from '@canopy/desktop-shared/types';
import { ForkedContainerNotice } from '@/components/shared-containers/ForkedContainerNotice';
import { Notice, NoticeButton } from '@canopy/ui-shared/components';
import {
  CHAT_STATE_LOAD_ERROR_HEADING,
  CHAT_STATE_REFRESH_RETRY_LABEL,
} from '@/stores/chat/revisioned-copy';
import { ensureCloudScopeLifecycle } from '@/cloud-chats/cloud-scope-lifecycle';
import { useReportOpenCloudTask } from '@/cloud-chats/cloud-chat-ui-state';
import { useCoworkProjectReachable } from '@/lib/cowork-directory';
import { draftHasContent } from '@/lib/chat-draft-content';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Where a forked Work Entry's focus request lands (CAN-4782). */
const COWORK_FORK_FOCUS_TARGET = {
  page: 'chat',
  headerTestId: 'cowork-top-bar',
} as const;

/** Minimum spacing between chat-event-driven work-entry meta refreshes. */
const CHAT_EVENT_REFRESH_THROTTLE_MS = 1000;

/**
 * Under the spinner while an entry's chats, and then its panel layout, load.
 * One label for both waits, so the loading card does not change between them.
 */
const CHATS_LOADING_LABEL = 'Loading chats…';

export function StandaloneChatPage(): JSX.Element {
  const initialize = useStandaloneChatStore((s) => s.initialize);
  const activeChatProjectId = useStandaloneChatStore(
    (s) => s.activeChatProjectId,
  );
  const activeWorkEntryId = useStandaloneChatStore((s) => s.activeWorkEntryId);
  useReportOpenCloudTask(activeChatProjectId, activeWorkEntryId);
  const orgDefaultChatsError = useStandaloneChatStore(
    (s) => s.orgDefaultChatsError,
  );
  const createWorkEntryInProject = useStandaloneChatStore(
    (s) => s.createWorkEntryInProject,
  );
  const archiveOverlayChatId = useStandaloneChatStore(
    (s) => s.archiveOverlayChatId,
  );
  // The archived-container viewer is page-like: while it is open for a cowork
  // workspace, the entry-scoped top bar (New chat / Open in / layout) must not
  // render above it — matching the Code page, where the viewer overlay covers
  // WorktreeTopBar entirely. Same workspace gate as CoworkArchiveOverlay's
  // cowork branch (synchronous, never summary-loaded).
  const containerViewerOpen = useArchivedContainersStore(
    (s) =>
      s.viewer !== null &&
      !isBotProjectId(s.viewer.workspaceId) &&
      isCoworkChatTarget(s.viewer.workspaceId),
  );
  const refreshWorkEntries = useStandaloneChatStore(
    (s) => s.refreshWorkEntries,
  );
  // A cloud task's project, while the cloud is online; a local one always.
  const activeProjectReachable = useCoworkProjectReachable(activeChatProjectId);
  // A task whose first read failed has no chats to show, so its reason and
  // Retry take the grid's place instead of an empty panel group.
  const activeScopeKey =
    activeWorkEntryId === null
      ? null
      : `${activeChatProjectId}/${activeWorkEntryId}`;
  const activeLoadFailure = useChatStore((s) => {
    if (activeScopeKey === null) return null;
    const sync = s.chatStateSync[activeScopeKey];
    if (sync?.phase !== 'refresh_error') return null;
    if ((s.worktreeChats[activeScopeKey]?.tabs.length ?? 0) > 0) return null;
    return sync.reason ?? '';
  });
  // The page moves to a clicked entry before its tabs load (CAN-6754); until
  // that switch lands, the entry shows loading in its grid's place.
  const activeEntryLoading = useStandaloneChatStore(
    (s) =>
      s.loadingWorkEntryId !== null &&
      s.loadingWorkEntryId === s.activeWorkEntryId,
  );
  const retryChatStateRefresh = useChatStore((s) => s.retryChatStateRefresh);
  useEffect(() => {
    ensureCloudScopeLifecycle();
  }, []);
  // Going offline drops a cloud task's chats and selection; when its project
  // is reachable again, select the entry this page still shows so its chats
  // load again.
  const wasReachableRef = useRef(activeProjectReachable);
  useEffect(() => {
    const reconnected = activeProjectReachable && !wasReachableRef.current;
    wasReachableRef.current = activeProjectReachable;
    if (
      reconnected &&
      activeWorkEntryId !== null &&
      shouldReassertRetainedCoworkEntryOnPageMount(
        useChatStore.getState().selectedWorktree,
      )
    ) {
      useChatStore
        .getState()
        .selectWorktree(activeChatProjectId, activeWorkEntryId);
    }
  }, [activeProjectReachable, activeChatProjectId, activeWorkEntryId]);

  // Viewing the active chat counts as reading it. The Code page clears
  // unread inside `selectWorktree`/`acknowledgeSelectedWorktreeAttention`,
  // but both are gated to `activePage === 'main'`, so the cowork surface
  // acknowledges here — otherwise the sidebar work-entry unread badge would
  // linger after the chat is already on screen. Keyed on the active tab so
  // entry opens, in-entry tab switches, and page returns (this page
  // unmounts while inactive) each mark exactly the visible tab read. Docking
  // keeps this page mounted, so uncovering it must also acknowledge that tab.
  const coveredByAppAdvisorDock = useSyncExternalStore(
    subscribeAppAdvisorDockCover,
    isMainContentCoveredByAppAdvisorDock,
  );
  const activeEntryActiveTabId = useWorktreeChatRenderState(
    activeWorkEntryId ? `${activeChatProjectId}/${activeWorkEntryId}` : null,
    (chatState) => (activeWorkEntryId ? chatState?.activeTabId : undefined),
  );
  const activeEntryActiveTabHidden = useChatStore(
    (s) =>
      activeEntryActiveTabId !== undefined &&
      s.hiddenChatTabIds.has(activeEntryActiveTabId),
  );
  const markTargetRead = useChatStore((s) => s.markTargetRead);
  useEffect(() => {
    if (coveredByAppAdvisorDock) return;
    const target = {
      projectId: activeChatProjectId,
      workEntryId: activeWorkEntryId,
      tabId: activeEntryActiveTabId,
      activeTabHidden: activeEntryActiveTabHidden,
      archiveOverlayChatId,
    };
    if (!shouldAcknowledgeCoworkTarget(target)) {
      return;
    }
    markTargetRead(target.projectId, target.workEntryId, {
      tabId: target.tabId,
    });
  }, [
    activeChatProjectId,
    activeWorkEntryId,
    activeEntryActiveTabId,
    activeEntryActiveTabHidden,
    archiveOverlayChatId,
    coveredByAppAdvisorDock,
    markTargetRead,
  ]);

  // ---------------------------------------------------------------------------
  // Cold-start detection: a brand-new user who has never sent a message and has
  // only the default chat project. We hide the grid and show a single centered
  // CTA, mirroring the Code tab's zero-workspace Home surface. Keyed on whether
  // ANY work entry has activity (`lastMessageAt` set) — see `coldStartDismissed`
  // in the store for why the CTA dismissal is store-backed.
  // ---------------------------------------------------------------------------
  const initialized = useStandaloneChatStore((s) => s.initialized);
  const chatProjectsLoaded = useStandaloneChatStore(
    (s) => s.chatProjectsLoaded,
  );
  const chatProjectCount = useStandaloneChatStore((s) => s.chatProjects.length);
  // Cold start is about this window's own workspaces: a cloud project is
  // never in the list, and opening one is never a first run.
  const activeProjectListed = useStandaloneChatStore((s) =>
    s.chatProjects.some((project) => project.id === s.activeChatProjectId),
  );
  const workEntries = useStandaloneChatStore((s) => s.workEntries);
  const legacyArchivedChats = useStandaloneChatStore(
    (s) => s.legacyArchivedByProject[s.activeChatProjectId],
  );
  const loadLegacyArchivedChats = useStandaloneChatStore(
    (s) => s.loadLegacyArchivedChats,
  );
  const archivedChats = useChatStore((s) => s.archivedChats);
  const loadArchivedChats = useChatStore((s) => s.loadArchivedChats);
  const { archiveActivityLoaded, hasChatActivity } = useMemo(
    () =>
      getCoworkActivityStatus({
        projectId: activeChatProjectId,
        workEntries,
        legacyArchivedChats,
        archivedChats,
      }),
    [activeChatProjectId, archivedChats, legacyArchivedChats, workEntries],
  );
  useEffect(() => {
    if (!initialized || !activeChatProjectId) return;
    // Archive discovery only supports the cold-start decision. Once any live,
    // legacy, or already-loaded archive activity is known, hydrating hundreds
    // of unrelated Work Entry archive files cannot change the answer.
    if (hasChatActivity) return;
    if (legacyArchivedChats === undefined) {
      void loadLegacyArchivedChats(activeChatProjectId).catch(() => {
        // Archive activity detection is best-effort and retries on remount.
      });
      return;
    }

    // When the workspace really has no known activity, check archive files a
    // few at a time (CAN-6778). This stops on the first archived chat and
    // avoids the previous unbounded IPC fan-out plus one whole-store update
    // per Work Entry.
    let cancelled = false;
    const projectId = activeChatProjectId;
    void sweepCoworkArchives({
      entries: workEntries.map((entry) => ({
        id: entry.id,
        key: `${projectId}/${entry.id}`,
      })),
      read: (entryId) => loadArchivedChats(projectId, entryId),
      known: (key) =>
        Object.prototype.hasOwnProperty.call(
          useChatStore.getState().archivedChats,
          key,
        ),
      cancelled: () => cancelled,
      // Never ahead of a task the user opens: no read starts while one loads.
      ready: whenNoWorkEntryLoads,
    });
    return (): void => {
      cancelled = true;
    };
  }, [
    activeChatProjectId,
    hasChatActivity,
    initialized,
    legacyArchivedChats,
    loadArchivedChats,
    loadLegacyArchivedChats,
    workEntries,
  ]);
  const coldStartDismissed = useStandaloneChatStore(
    (s) => s.coldStartDismissed,
  );
  const startNewChat = useStandaloneChatStore((s) => s.startNewChat);
  const dismissColdStart = useStandaloneChatStore((s) => s.dismissColdStart);
  const activeDraftPresent = useChatStore(
    (state) =>
      activeEntryActiveTabId !== undefined &&
      draftHasContent(state.tabDrafts[activeEntryActiveTabId] ?? []),
  );
  const isColdStart =
    !coldStartDismissed &&
    !activeDraftPresent &&
    initialized &&
    chatProjectsLoaded &&
    archiveActivityLoaded &&
    activeProjectListed &&
    chatProjectCount <= 1 &&
    !hasChatActivity;

  const handleColdStartNewChat = useCallback((): void => {
    dismissColdStart();
    void startNewChat();
  }, [dismissColdStart, startNewChat]);

  // Tab-strip `+`: the standalone flow (empty-tab reuse, model defaults,
  // archive-overlay dismissal), then the resulting chat's panel lands in the
  // group whose `+` was clicked rather than the bridge's MRU placement.
  const handleTabStripNewChat = useCallback(
    (groupId: string): void => {
      void startNewChat().then(() => {
        const projectId = useStandaloneChatStore.getState().activeChatProjectId;
        const entryId = useStandaloneChatStore.getState().activeWorkEntryId;
        if (entryId === null) return;
        placeActiveStandaloneChatInGroup(`${projectId}/${entryId}`, groupId);
      });
    },
    [startNewChat],
  );

  // Page-shell state for panel content. Cowork has no list/kanban view modes
  // and no scripts/hooks settings tabs (those cards are worktree-only). The
  // page unmounts when the user leaves it, so while mounted the grid is on
  // screen unless Settings or an archive view covers it.
  const settingsOpen = useNavigationStore((s) => s.settingsOpen);
  const archiveOverlayOpen = useCoworkArchiveOverlayOpen('cowork');
  const gridVisible = !settingsOpen && !archiveOverlayOpen;
  const hostState = useMemo<PanelHostState>(
    () => ({ viewMode: 'list', viewModeReady: true, visible: gridVisible }),
    [gridVisible],
  );

  // ---------------------------------------------------------------------------
  // Discovery events (WorktreeManager normally owns this but is unmounted here)
  // ---------------------------------------------------------------------------
  const subscribeToDiscoveryEvents = useProjectsStore(
    (s) => s.subscribeToDiscoveryEvents,
  );
  useEffect(() => {
    return subscribeToDiscoveryEvents();
  }, [subscribeToDiscoveryEvents]);

  // ---------------------------------------------------------------------------
  // Previous worktree restoration
  // ---------------------------------------------------------------------------
  const previousWorktreeRef = useRef<WorktreeSelection | null>(null);

  useEffect(() => {
    const current = useChatStore.getState().selectedWorktree;
    if (current && !isCoworkChatTarget(current.projectId)) {
      previousWorktreeRef.current = current;
    } else {
      // Fall back to the chatStore-tracked previous selection. This covers
      // call sites (e.g. the failed-pipeline Debug button) that switch
      // chatStore into a cowork chat context before navigating, leaving
      // selectedWorktree already pointing at a cowork chat target by
      // the time this page mounts.
      const tracked =
        useChatStore.getState().selectedWorktreeBeforeStandaloneChat;
      const projectsState = useProjectsStore.getState();
      if (
        tracked &&
        canNavigateToWorktreeFromSidebarItems(
          projectsState.projects,
          tracked.projectId,
          tracked.worktreeId,
          projectsState.hasHydratedProjects,
        )
      ) {
        previousWorktreeRef.current = tracked;
      }
    }

    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        await initialize();
      } catch (error) {
        // Leave the page uninitialized, as before (CAN-7316). The console line
        // keeps the failure in local app-events, which feedback bundles carry;
        // it used to surface only as an unhandled rejection.
        reportClientAppError(error, { source: 'standalone-chat-initialize' });
        reportRendererConsoleError('Standalone chat initialize failed', {
          error,
        });
        return;
      }
      if (cancelled) return;
      // Re-assert the active Work Entry selection: navigating away can leave
      // chatStore pointed at a code worktree while this page's store still
      // has an entry active. A cowork selection already in place is the
      // explicit (possibly still-hydrating) destination and must survive —
      // see shouldReassertRetainedCoworkEntryOnPageMount.
      const standaloneState = useStandaloneChatStore.getState();
      if (
        standaloneState.activeWorkEntryId !== null &&
        shouldReassertRetainedCoworkEntryOnPageMount(
          useChatStore.getState().selectedWorktree,
        )
      ) {
        useChatStore
          .getState()
          .selectWorktree(
            standaloneState.activeChatProjectId,
            standaloneState.activeWorkEntryId,
          );
      }
    })();

    return (): void => {
      cancelled = true;
      // If the selection has already been changed to a real (non-standalone)
      // worktree while this page was mounted — e.g. the user clicked a Code
      // Workspaces row in the sidebar, which selects the worktree and then
      // navigates here-away — do not clobber it by restoring the previous
      // selection. Only restore when we're still in a cowork chat context
      // (the legacy standalone sentinel or a real cowork workspace id).
      const currentSelection = useChatStore.getState().selectedWorktree;
      if (
        !shouldRestorePreviousWorktreeAfterCoworkPageUnmount(currentSelection)
      ) {
        return;
      }
      const prev = previousWorktreeRef.current;
      if (
        prev &&
        selectionBelongsToContext(
          prev,
          useProjectsStore.getState().projects,
          getSidebarScopingContext(),
        )
      ) {
        useChatStore.getState().selectWorktree(prev.projectId, prev.worktreeId);
      } else {
        useChatStore.getState().deselectWorktree();
      }
    };
  }, [initialize]);

  // Refresh work-entry metas when agent activity starts in this workspace.
  // Persisted changes arrive through standaloneChat.onMetaUpdated; avoiding an
  // idle timer keeps large cowork workspaces entirely event-driven.
  const lastEventRefreshAtRef = useRef(0);
  useEffect(() => {
    const unsubscribe = subscribeToChatEvents((event) => {
      if (event.projectId !== activeChatProjectId) {
        return;
      }
      if (!isRecord(event.data)) {
        return;
      }
      if (event.data.type !== 'system') {
        return;
      }
      const now = Date.now();
      if (
        now - lastEventRefreshAtRef.current <
        CHAT_EVENT_REFRESH_THROTTLE_MS
      ) {
        return;
      }
      lastEventRefreshAtRef.current = now;
      void refreshWorkEntries(activeChatProjectId).catch(() => {
        // Metadata refresh failures should not break the page.
      });
    });
    return unsubscribe;
  }, [activeChatProjectId, refreshWorkEntries]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  // An open archive page, such as a cloud project's More page with no chat
  // left in it (CAN-6511), stays over the page instead of the cold start.
  if (isColdStart && !containerViewerOpen && !archiveOverlayOpen) {
    return (
      <section className="flex h-full" data-testid="page-chat">
        <StandaloneColdStartEmptyState onNewChat={handleColdStartNewChat} />
      </section>
    );
  }

  // The store guarantees an active Work Entry after initialize/switch, so the
  // placeholder below only shows during those transitions.
  const ready =
    initialized &&
    chatProjectsLoaded &&
    activeChatProjectId !== '' &&
    activeWorkEntryId !== null &&
    activeProjectReachable;

  return (
    <section className="flex h-full flex-col" data-testid="page-chat">
      {ready && !containerViewerOpen && (
        <>
          <CoworkTopBar workspaceId={activeChatProjectId} />
          {/* A failed git or GitHub action from this work entry's chats (a
              watched pull request that couldn't open), under the bar as on
              the worktree page. */}
          <WorktreeGitActionError
            projectId={activeChatProjectId}
            worktreeId={activeWorkEntryId}
          />
          <ForkedContainerNotice
            projectId={activeChatProjectId}
            worktreeId={activeWorkEntryId}
            focusTarget={COWORK_FORK_FOCUS_TARGET}
          />
        </>
      )}
      <Surface
        as="section"
        variant="workspace-panel"
        className="relative flex min-w-0 flex-1 flex-col overflow-hidden"
      >
        {orgDefaultChatsError?.projectId === activeChatProjectId && (
          <div className="px-4 pt-4">
            <DesktopErrorBanner
              errorSource="org-default-chats-provision-error"
              className=""
              error={orgDefaultChatsError.message}
              testId="org-default-chats-provision-error"
              secondaryAction={
                <NoticeButton
                  variant="primary"
                  data-testid="org-default-chats-provision-retry"
                  onClick={(): void => {
                    void createWorkEntryInProject(activeChatProjectId).catch(
                      () => undefined,
                    );
                  }}
                >
                  Try again
                </NoticeButton>
              }
            />
          </div>
        )}
        {!activeProjectReachable ? (
          <div className="p-4" data-testid="standalone-chat-offline">
            <Notice intent="neutral">Cloud chats are offline.</Notice>
          </div>
        ) : activeLoadFailure !== null && activeWorkEntryId !== null ? (
          <div className="p-4" data-testid="standalone-chat-load-error">
            <Notice
              errorSource="standalone-chat-page-load-heading"
              intent="destructive"
              title={CHAT_STATE_LOAD_ERROR_HEADING}
              actions={
                <NoticeButton
                  variant="primary"
                  data-testid="standalone-chat-load-retry"
                  onClick={(): void => {
                    retryChatStateRefresh(
                      activeChatProjectId,
                      activeWorkEntryId,
                    );
                  }}
                >
                  {CHAT_STATE_REFRESH_RETRY_LABEL}
                </NoticeButton>
              }
            >
              {activeLoadFailure}
            </Notice>
          </div>
        ) : ready && !activeEntryLoading ? (
          <PanelGridSurface
            projectId={activeChatProjectId}
            worktreeId={activeWorkEntryId}
            hostState={hostState}
            includeAuxWindowContent={false}
            onNewChatTab={handleTabStripNewChat}
            loadingLabel={CHATS_LOADING_LABEL}
          />
        ) : (
          // The same card the grid shows while its layout loads, so the
          // entry's wait and the grid's read as one: the card stays, and
          // the spinner and label show only when the wait runs long.
          <PanelGridLoadingCard
            testId="standalone-chat-loading"
            label={CHATS_LOADING_LABEL}
          />
        )}
        <CoworkArchiveOverlay />
      </Surface>
    </section>
  );
}
