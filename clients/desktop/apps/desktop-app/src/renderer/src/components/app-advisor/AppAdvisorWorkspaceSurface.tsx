import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import { draftHasContent } from '@/lib/chat-draft-content';
import {
  desktopFileSessionController,
  useDesktopFileSessionRevision,
} from '@/lib/file-viewer/desktop-file-session-controller';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
/**
 * AppAdvisorWorkspaceSurface — the App Advisor popout's equivalent of
 * `StandaloneChatPage`: a full cowork-style workspace over entry-keyed
 * `(app-advisor, <workEntryId>)` chats.
 *
 * Layout: {@link AppAdvisorNav} (collapsible, width-only) beside a persistent
 * main column of {@link AppAdvisorTopBar}, {@link PanelGridSurface} keyed
 * `(app-advisor, activeWorkEntryId)`, and the shared {@link CoworkArchiveOverlay}.
 * Ask-user questions ask in the chat's composer (see `ChatInput`).
 *
 * Responsibilities:
 * - scoped store bootstrap (`initializeScoped('app-advisor')`) with a
 *   ready/loading gate until the workspace + active entry are established;
 * - work-entry metadata refresh: visibility-gated 1.5s polling plus a
 *   throttled chat-event refresh (the popout does not receive main-window
 *   `standaloneChatMetaUpdated` events);
 * - plugin slash-command discovery subscription (WorktreeManager is not
 *   mounted in this renderer — previously supplied by `AppAdvisorPanel`);
 * - throttled `reportWindowUiState` reports (ids and booleans only);
 * - `includeAuxWindowContent={true}`: this renderer is the intended
 *   auxiliary-content owner (WorktreePart is not mounted here);
 * - browser panels use the main-process host-window routing and therefore
 *   have the same add-panel availability as the cowork surface.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import { subscribeToChatEvents } from '@/lib/chatEventFanout';
import {
  APP_ADVISOR_PROJECT_ID,
  type AppAdvisorJson,
  type AppAdvisorWindowBatchRemovalDialog,
  type AppAdvisorWindowUiState,
} from '@canopy/desktop-shared/types';
import { useChatStore, useWorktreeChatRenderState } from '@/stores/chatStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { placeActiveStandaloneChatInGroup } from '@/lib/panels/startChatInGroup';
import { useArchivedContainersStore } from '@/stores/archivedContainersStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { PanelGridSurface } from '@/components/panels/PanelGridSurface';
import type { PanelHostState } from '@/lib/panels/panel-host-context';
import { CoworkArchiveOverlay } from '@/components/standalone-chat/CoworkArchiveOverlay';
import { AppAdvisorNav } from '@/components/app-advisor/AppAdvisorNav';
import { AppAdvisorTitlebarCorner } from '@/components/app-advisor/AppAdvisorTitlebarCorner';
import { AppAdvisorTopBar } from '@/components/app-advisor/AppAdvisorTopBar';
import { WorktreeGitActionError } from '@/components/github/WorktreeGitActionError';
import { AppAdvisorFloatingSurface } from '@/components/app-advisor/AppAdvisorFloatingSurface';
import { useAppAdvisorDockedBrowserFallback } from '@/components/app-advisor/useAppAdvisorDockedBrowserFallback';
import { useAppAdvisorStore } from '@/stores/appAdvisorStore';
import { LoadingSpinner } from '@/components/shared/loading/spinners/LoadingSpinner';
import { subscribeBrowserPanelActivation } from '@/lib/browserPanelActivation';
import { initBrowserPanelActivation } from '@/lib/panels/browser-panel-activation';
import { ensureWorktreePanelLayout } from '@/lib/panels/persistence-bridge';
import { makeWorktreePanelKey } from '@/stores/panelLayoutStore';

/** Whether any App Advisor chat tab holds attachments waiting to send. */
function hasPendingAttachments(
  worktreeChats: ReturnType<typeof useChatStore.getState>['worktreeChats'],
): boolean {
  return Object.values(worktreeChats).some((chats) =>
    chats.tabs.some((tab) => (tab.pendingAttachments?.length ?? 0) > 0),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Minimum spacing between chat-event-driven work-entry meta refreshes. */
const CHAT_EVENT_REFRESH_THROTTLE_MS = 1000;

/** Popout fallback for persisted metadata updates sent only to the main window. */
const WORK_ENTRY_REFRESH_INTERVAL_MS = 1500;

/** Trailing-edge throttle for `reportWindowUiState` reports. */
const UI_STATE_REPORT_THROTTLE_MS = 250;

export interface AppAdvisorWorkspaceSurfaceProps {
  settingsModalOpen: boolean;
  onOpenSettings: () => void;
}

export function AppAdvisorWorkspaceSurface({
  settingsModalOpen,
  onOpenSettings,
}: AppAdvisorWorkspaceSurfaceProps): JSX.Element {
  const initializeScoped = useStandaloneChatStore((s) => s.initializeScoped);
  const initialized = useStandaloneChatStore((s) => s.initialized);
  const scopedWorkspaceId = useStandaloneChatStore((s) => s.scopedWorkspaceId);
  const activeWorkEntryId = useStandaloneChatStore((s) => s.activeWorkEntryId);
  const refreshWorkEntries = useStandaloneChatStore(
    (s) => s.refreshWorkEntries,
  );
  const activeEntryKey =
    activeWorkEntryId !== null
      ? `${APP_ADVISOR_PROJECT_ID}/${activeWorkEntryId}`
      : null;
  const activeChatId = useWorktreeChatRenderState(
    activeEntryKey,
    (chatState) =>
      activeWorkEntryId !== null ? (chatState?.activeTabId ?? null) : null,
  );
  // Early access floating layout: it shows chats only, so a file tab (an
  // agent's ShowFiles, a file link) needs the full layout's panels.
  const activeTabIsFile = useWorktreeChatRenderState(
    activeEntryKey,
    (chatState) =>
      chatState?.tabs.find((tab) => tab.id === chatState.activeTabId)?.kind ===
      'file',
  );
  const firstChatTabId = useWorktreeChatRenderState(
    activeEntryKey,
    (chatState) => chatState?.tabs.find((tab) => tab.kind !== 'file')?.id,
  );

  // The archived-container viewer is page-like: while it is open for this
  // popout, the entry-scoped top bar must not render above it (Code-page
  // parity — the viewer covers WorktreeTopBar there). The viewer overlay
  // itself renders its own titlebar drag spacer in the top bar's place.
  const containerViewerOpen = useArchivedContainersStore(
    (s) => s.viewer !== null && s.viewer.workspaceId === APP_ADVISOR_PROJECT_ID,
  );
  const archivedOverviewWorkspaceId = useArchivedContainersStore((s) =>
    s.overview?.workspaceId === APP_ADVISOR_PROJECT_ID
      ? s.overview.workspaceId
      : null,
  );
  const emptyTrashConfirmationOpen = useArchivedContainersStore(
    (s) => s.emptyTrashConfirmationWorkspaceId === APP_ADVISOR_PROJECT_ID,
  );
  const emptyTrashRunning = useArchivedContainersStore(
    (s) => s.emptyTrashRun?.workspaceId === APP_ADVISOR_PROJECT_ID,
  );
  const lastArchivedOverviewRequest = useArchivedContainersStore(
    (s) => s.lastArchivedOverviewRequest,
  );
  // Unsaved work in App Advisor: typed, unsent text, file references or
  // attachments in any chat (the open composer, or a draft kept for another
  // tab), or a file tab's unsaved edits. Reported so the main process keeps
  // this page instead of remaking it, which would lose that work.
  const hasUnsentChatDraft = useChatStore(
    (s) =>
      Object.keys(s.composerTextPresent).length > 0 ||
      Object.values(s.tabDrafts).some(draftHasContent) ||
      hasPendingAttachments(s.worktreeChats),
  );
  const fileTabIds = useChatStore((s) =>
    Object.values(s.worktreeChats)
      .flatMap((chats) => chats.tabs)
      .filter((tab) => tab.kind === 'file')
      .map((tab) => tab.id)
      .join('\n'),
  );
  // Re-renders as file sessions change, so the dirty check below is current.
  useDesktopFileSessionRevision();
  const hasDirtyFile =
    fileTabIds !== '' &&
    fileTabIds
      .split('\n')
      .some((tabId) => desktopFileSessionController.isDirty(tabId));
  const hasUnsentDraft = hasUnsentChatDraft || hasDirtyFile;

  // ---------------------------------------------------------------------------
  // Scoped store bootstrap
  // ---------------------------------------------------------------------------
  useEffect(() => {
    void initializeScoped(APP_ADVISOR_PROJECT_ID).catch(() => {
      // Bootstrap is retried on remount; the loading gate stays up.
    });
  }, [initializeScoped]);

  // ---------------------------------------------------------------------------
  // Nav collapse persistence (`PreferencesData.appAdvisorNavCollapsed`)
  // ---------------------------------------------------------------------------
  const [navCollapsed, setNavCollapsed] = useState<boolean>(false);
  useEffect(() => {
    let cancelled = false;
    void window.api
      .loadPreferences()
      .then((prefs) => {
        if (!cancelled) {
          setNavCollapsed(prefs.appAdvisorNavCollapsed === true);
        }
      })
      .catch(() => undefined);
    return (): void => {
      cancelled = true;
    };
  }, []);
  const handleToggleNavCollapsed = useCallback((): void => {
    setNavCollapsed((current) => {
      const next = !current;
      void window.api
        .savePreferences({ appAdvisorNavCollapsed: next })
        .catch(() => {
          // Collapse persistence is best-effort.
        });
      return next;
    });
  }, []);

  // Page-shell state for panel content. App Advisor mirrors cowork: no
  // list/kanban view modes and no scripts/hooks settings tabs.
  const startNewChat = useStandaloneChatStore((s) => s.startNewChat);
  // Tab-strip `+`: the standalone flow (empty-tab reuse, model defaults,
  // archive-overlay dismissal), then the resulting chat's panel lands in the
  // group whose `+` was clicked rather than the bridge's MRU placement.
  const handleTabStripNewChat = useCallback(
    (groupId: string): void => {
      void startNewChat().then(() => {
        const entryId = useStandaloneChatStore.getState().activeWorkEntryId;
        if (entryId === null) return;
        placeActiveStandaloneChatInGroup(
          `${APP_ADVISOR_PROJECT_ID}/${entryId}`,
          groupId,
        );
      });
    },
    [startNewChat],
  );

  const hostState = useMemo<PanelHostState>(
    () => ({ viewMode: 'list', viewModeReady: true }),
    [],
  );

  // ---------------------------------------------------------------------------
  // Discovery events (WorktreeManager/AppAdvisorPanel are not mounted here)
  // ---------------------------------------------------------------------------
  const subscribeToDiscoveryEvents = useProjectsStore(
    (s) => s.subscribeToDiscoveryEvents,
  );
  useEffect(() => {
    return subscribeToDiscoveryEvents();
  }, [subscribeToDiscoveryEvents]);

  // Throttled refresh when agent activity starts in this workspace. Persisted
  // changes are event-driven through standaloneChat.onMetaUpdated.
  const lastEventRefreshAtRef = useRef(0);
  useEffect(() => {
    const unsubscribe = subscribeToChatEvents((event) => {
      if (event.projectId !== APP_ADVISOR_PROJECT_ID) {
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
      void refreshWorkEntries(APP_ADVISOR_PROJECT_ID).catch(() => {
        // Metadata refresh failures should not break the surface.
      });
    });
    return unsubscribe;
  }, [refreshWorkEntries]);

  // Main-side metadata writes currently notify only the main renderer. Keep
  // this separate popout current without refreshing while it is hidden.
  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void refreshWorkEntries(APP_ADVISOR_PROJECT_ID).catch(() => {
        // Metadata refresh failures should not break the surface.
      });
    }, WORK_ENTRY_REFRESH_INTERVAL_MS);
    return (): void => {
      window.clearInterval(interval);
    };
  }, [refreshWorkEntries]);

  // ---------------------------------------------------------------------------
  // Readiness
  // ---------------------------------------------------------------------------
  const ready =
    initialized &&
    scopedWorkspaceId === APP_ADVISOR_PROJECT_ID &&
    activeWorkEntryId !== null;

  // ---------------------------------------------------------------------------
  // Current-UI-state reports (§ locked ids-and-booleans contract). Reports the
  // initial state after readiness and subsequent SEMANTIC changes — not
  // animation frames or message updates — through a trailing-edge throttle.
  // ---------------------------------------------------------------------------
  const groupEditorId = useCurrentUiStateStore((state) => {
    const slice = state.slices['sidebar.itemGroupEditor.app-advisor'];
    return slice &&
      typeof slice === 'object' &&
      !Array.isArray(slice) &&
      typeof slice.groupId === 'string'
      ? slice.groupId
      : null;
  });
  // The nav's bulk removal dialog reports into this window's store; main
  // only reads the main window's, so it crosses with the window report.
  const batchRemovalDialogSlice = useCurrentUiStateStore(
    (state) => state.slices['appAdvisor.batchRemovalDialog'],
  );
  const batchRemovalDialog = useMemo(
    () => readBatchRemovalDialog(batchRemovalDialogSlice),
    [batchRemovalDialogSlice],
  );
  const reportTimerRef = useRef<number | null>(null);
  const lastReportedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!ready) return;
    const state: AppAdvisorWindowUiState = {
      activeWorkEntryId,
      activeChatId,
      navCollapsed,
      groupEditorId,
      settingsModalOpen,
      archivedOverviewOpen: archivedOverviewWorkspaceId !== null,
      archivedOverviewWorkspaceId,
      emptyTrashConfirmationOpen,
      emptyTrashRunning,
      lastArchivedOverviewRequestId:
        lastArchivedOverviewRequest?.requestId ?? null,
      lastArchivedOverviewConfirmationOpened:
        lastArchivedOverviewRequest?.confirmationOpened ?? null,
      hasUnsentDraft,
      batchRemovalDialog,
    };
    const serialized = JSON.stringify(state);
    if (serialized === lastReportedRef.current) return;
    if (reportTimerRef.current !== null) {
      window.clearTimeout(reportTimerRef.current);
    }
    reportTimerRef.current = window.setTimeout(() => {
      reportTimerRef.current = null;
      lastReportedRef.current = serialized;
      void window.api.appAdvisor.reportWindowUiState(state).catch(() => {
        // Reports are best-effort; the next semantic change retries.
      });
    }, UI_STATE_REPORT_THROTTLE_MS);
    return (): void => {
      if (reportTimerRef.current !== null) {
        window.clearTimeout(reportTimerRef.current);
        reportTimerRef.current = null;
      }
    };
  }, [
    ready,
    activeWorkEntryId,
    activeChatId,
    navCollapsed,
    groupEditorId,
    settingsModalOpen,
    archivedOverviewWorkspaceId,
    emptyTrashConfirmationOpen,
    emptyTrashRunning,
    lastArchivedOverviewRequest,
    hasUnsentDraft,
    batchRemovalDialog,
  ]);

  // Early access: the window can be a small floating chat (see
  // `floating-layout.ts` in main); the full window keeps the nav and panels.
  const floating = useAppAdvisorStore((s) => s.layout === 'floating');
  // Docked: the Orchestrator page in the main window's content area, beside
  // the main sidebar, under the main window's top bar for it. It draws only
  // the panel grid, in the main window's card layout.
  const docked = useAppAdvisorStore((s) => s.layout === 'docked');
  // The archive views (the archived overview, its viewer, and the Empty
  // trash confirmation) only render in the full window, so one opened while
  // the person uses the floating panel expands App Advisor there. An open
  // request for one already lands in the full window (main), keeping its
  // background and focus options; one made while App Advisor is hidden or
  // the person works elsewhere waits for the next open instead of showing
  // and focusing it (CAN-1993).
  const archiveViewRequested =
    archivedOverviewWorkspaceId !== null ||
    containerViewerOpen ||
    emptyTrashConfirmationOpen;
  const appAdvisorOpen = useAppAdvisorStore((s) => s.open);
  useEffect(() => {
    if (
      floating &&
      archiveViewRequested &&
      appAdvisorOpen &&
      document.hasFocus()
    ) {
      useAppAdvisorStore.getState().expandDialog();
    }
  }, [floating, archiveViewRequested, appAdvisorOpen]);

  // Browser panels open through the grid's activation bridge, which the
  // floating layout does not mount. Install the bridge so a request made
  // while floating queues until the full layout's grid loads its layout,
  // and expand App Advisor there to show it.
  useEffect(() => {
    if (!floating) return;
    initBrowserPanelActivation();
    return subscribeBrowserPanelActivation((target): void => {
      // Only for a request that asks for the user's attention, while the
      // panel shows: an agent's background open (focus: false) or one made
      // while App Advisor is closed queues for the next time the full
      // layout opens, without popping it up or taking focus (CAN-1993).
      if (target.projectId !== APP_ADVISOR_PROJECT_ID) return;
      if (target.focus !== false && useAppAdvisorStore.getState().open) {
        // Browser panels show in the separate window, which hosts their
        // native views.
        useAppAdvisorStore.getState().openSeparateWindow();
        return;
      }
      // Floating mounts no grid, so load the entry's panel layout for the
      // activation bridge to land the browser in, instead of timing out.
      void ensureWorktreePanelLayout(
        makeWorktreePanelKey(APP_ADVISOR_PROJECT_ID, target.worktreeId),
      ).catch(() => undefined);
    });
  }, [floating]);

  // Docked, the grid lands a browser panel, but its native view lives in the
  // separate window: a browser the person asks to see moves App Advisor there.
  useAppAdvisorDockedBrowserFallback(docked, activeWorkEntryId);

  // A file tab the person selects in the open chat while floating expands
  // App Advisor to the full layout, where its panel shows. A file an agent
  // opens while the person works elsewhere stays a tab for later, without
  // pulling Canopy forward (CAN-1993). Opening floating on a file tab the
  // full layout left active is not a request for it either: the panel shows
  // the entry's chat instead.
  const floatingTabRef = useRef<{
    entryId: string | null;
    tabId: string | null;
  } | null>(null);
  useEffect(() => {
    const previous = floatingTabRef.current;
    floatingTabRef.current = floating
      ? { entryId: activeWorkEntryId, tabId: activeChatId }
      : null;
    if (!floating || !activeTabIsFile || activeWorkEntryId === null) return;
    const sameEntry =
      previous !== null && previous.entryId === activeWorkEntryId;
    if (sameEntry && previous.tabId === activeChatId) return;
    if (sameEntry && document.hasFocus()) {
      useAppAdvisorStore.getState().expandDialog();
      return;
    }
    // Back to the chat the person had open, while it is still a chat tab.
    const previousChatId = sameEntry
      ? useChatStore
          .getState()
          .worktreeChats[
            `${APP_ADVISOR_PROJECT_ID}/${activeWorkEntryId}`
          ]?.tabs.find((tab) => tab.id === previous.tabId && tab.kind !== 'file')
          ?.id
      : undefined;
    const chatId = previousChatId ?? firstChatTabId;
    if (chatId !== undefined) {
      useChatStore.getState().switchTab(chatId, {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: activeWorkEntryId,
      });
    }
  }, [
    floating,
    activeWorkEntryId,
    activeChatId,
    activeTabIsFile,
    firstChatTabId,
  ]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  if (floating) {
    return (
      <div
        className="relative flex h-full min-h-0 w-full flex-1 overflow-hidden"
        data-testid="app-advisor-workspace-surface"
        data-layout="floating"
      >
        <AppAdvisorFloatingSurface
          ready={ready}
          activeWorkEntryId={activeWorkEntryId}
          activeChatId={activeChatId}
        />
      </div>
    );
  }
  if (docked) {
    // The main window's frame: the same inset cards as a worktree or cowork
    // chat under its top bar (`data-main-frame='split'` in globals.css). The
    // top bar, sidebar and window material are the main window's own.
    return (
      <div
        className="relative flex h-full min-h-0 w-full flex-1 overflow-hidden"
        data-testid="app-advisor-workspace-surface"
        data-layout="docked"
        data-window-layout="inset"
      >
        <main
          className="relative flex min-w-0 flex-1 flex-col"
          data-main-frame="split"
          data-main-frame-under-host-bar=""
        >
          {ready && !containerViewerOpen && (
            <WorktreeGitActionError
              projectId={APP_ADVISOR_PROJECT_ID}
              worktreeId={activeWorkEntryId}
            />
          )}
          <section className="relative flex min-h-55 min-w-0 flex-1 flex-col overflow-hidden">
            {ready ? (
              <>
                <PanelGridSurface
                  key={`${APP_ADVISOR_PROJECT_ID}/${activeWorkEntryId}`}
                  projectId={APP_ADVISOR_PROJECT_ID}
                  worktreeId={activeWorkEntryId}
                  hostState={hostState}
                  includeAuxWindowContent={true}
                  onNewChatTab={handleTabStripNewChat}
                />
                <CoworkArchiveOverlay surface="app-advisor" />
              </>
            ) : (
              <div
                className="flex flex-1 items-center justify-center"
                data-testid="app-advisor-workspace-loading"
              >
                <LoadingSpinner tone="secondary" />
              </div>
            )}
          </section>
        </main>
      </div>
    );
  }
  return (
    <div
      // The main window's inset layout (globals.css): the nav and top bar sit
      // on the window material and each panel group below is its own card.
      className="app-window-material relative flex h-full min-h-0 w-full flex-1 overflow-hidden"
      data-testid="app-advisor-workspace-surface"
      data-window-layout="inset"
      data-sidebar-hidden={navCollapsed ? 'true' : undefined}
    >
      <AppAdvisorNav collapsed={navCollapsed} />
      {/* The main column stays mounted across nav collapse/expand — the nav
          changes width only. */}
      <main
        className="relative flex min-w-0 flex-1 flex-col"
        data-main-frame="split"
      >
        {ready && !containerViewerOpen && (
          <>
            <AppAdvisorTopBar navCollapsed={navCollapsed} />
            {/* A failed git or GitHub action from this work entry's chats (a
                watched pull request that couldn't open), under the bar as on
                the worktree page. */}
            <WorktreeGitActionError
              projectId={APP_ADVISOR_PROJECT_ID}
              worktreeId={activeWorkEntryId}
            />
          </>
        )}
        <section
          className="relative flex min-h-55 min-w-0 flex-1 flex-col overflow-hidden bg-card/50"
          data-testid="app-advisor-content"
        >
          {ready ? (
            <>
              <PanelGridSurface
                key={`${APP_ADVISOR_PROJECT_ID}/${activeWorkEntryId}`}
                projectId={APP_ADVISOR_PROJECT_ID}
                worktreeId={activeWorkEntryId}
                hostState={hostState}
                includeAuxWindowContent={true}
                onNewChatTab={handleTabStripNewChat}
              />
              <CoworkArchiveOverlay surface="app-advisor" />
            </>
          ) : (
            <div
              className="flex flex-1 items-center justify-center"
              data-testid="app-advisor-workspace-loading"
            >
              <div className="flex flex-col items-center gap-3 fg-secondary">
                <LoadingSpinner tone="secondary" />
                <span className="text-s">Loading {ORCHESTRATOR_LABEL}…</span>
              </div>
            </div>
          )}
        </section>
      </main>
      {/* Rendered LAST so its drag region and buttons paint above the nav
          and top bar (later drag rects beat earlier ones in Electron). */}
      <AppAdvisorTitlebarCorner
        collapsed={navCollapsed}
        onToggleCollapsed={handleToggleNavCollapsed}
        onOpenSettings={onOpenSettings}
      />
    </div>
  );
}

/** The nav's open batch removal dialog slice, or `null` when closed. */
function readBatchRemovalDialog(
  slice: AppAdvisorJson | undefined,
): AppAdvisorWindowBatchRemovalDialog | null {
  if (
    slice === null ||
    typeof slice !== 'object' ||
    Array.isArray(slice) ||
    slice.open !== true
  ) {
    return null;
  }
  const { mode, phase, count } = slice;
  if (
    (mode !== 'archive' && mode !== 'delete') ||
    (phase !== 'confirm' && phase !== 'running' && phase !== 'results') ||
    typeof count !== 'number'
  ) {
    return null;
  }
  return { open: true, mode, count, phase };
}
