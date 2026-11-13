import { useLabsExperimentEnabled } from '@/stores/labsExperimentsStore';
import { ActivityCardToggle } from '@/components/activity/ActivityCardControl';
import { useChatTabRename } from '@/components/chat/ChatTabRenameDialog';
import { PanelAddTabMenu } from '@/components/panels/PanelAddTabMenu';
import { ExportSessionConfirmationModal } from '@/components/shared/ExportSessionConfirmationModal';
import { ShareRunModal } from '@/components/shared/ShareRunModal';
import {
  CenteredLoadingSpinner,
  DelayedLoadingPlaceholder,
} from '@canopy/ui-shared/components';
import { useCanopyDesktopStartPageEnabled } from '@/hooks/useCanopyDesktopStartPageEnabled';
import { useExportSessionAction } from '@/hooks/useExportSessionAction';
import { useShareRunAction } from '@/hooks/useShareRunAction';
import { dispatchBrowserViewBoundsInvalidated } from '@/lib/browserViewBounds';
import { panelErrorBoundaryHost } from '@/lib/desktop-error-boundary-host';
import { copyTextToClipboard } from '@/lib/clipboard';
import { formatFileReferencePath } from '@/lib/file-reference-paths';
import { addChatPanelToGroup } from '@/lib/panels/addChatPanel';
import {
  activateBoundBrowserPanel,
  initBrowserPanelActivation,
} from '@/lib/panels/browser-panel-activation';
import { initBrowserPanelSync } from '@/lib/panels/browser-panel-sync';
import { isBusyChatPanel, useBusyChatIds } from '@/lib/panels/busy-chat-panels';
import { initChatPanelReveal } from '@/lib/panels/chat-panel-activation';
import { chatReadStateServices } from '@/lib/panels/chat-read-state';
import {
  closePanelGroup,
  closePanelTab,
  closePanelTabs,
  registerChatPanelSyncOwner,
} from '@/lib/panels/chat-panel-sync';
import { ensureEarlyAccessPanelRulesSync } from '@/lib/panels/early-access-panel-rules';
import { isLastTabOfFixedGroup } from '@/lib/panels/fixed-group-close';
import {
  createBrowserPanel,
  createTerminalPanel,
} from '@/lib/panels/panel-creation-actions';
import {
  DEFAULT_EXTRAS_GROUP_ID,
  DEFAULT_TERMINAL_GROUP_ID,
} from '@/lib/panels/panel-group-ids';
import type { PanelHostState } from '@/lib/panels/panel-host-context';
import {
  disposeWorktreePanelHydration,
  ensureWorktreePanelLayout,
} from '@/lib/panels/persistence-bridge';
import { initPipelinePanelSync } from '@/lib/panels/pipeline-panel-sync';
import { initPlanPanelSync } from '@/lib/panels/plan-panel-sync';
import { getPanelDefinition, renderPanelContent } from '@/lib/panels/registry';
import { isSharedContainerViewerLayout } from '@/lib/panels/shared-container-viewer-layout';
import {
  panelTabDisplayTitle,
  renderPanelTabAccessibleStatus,
  renderPanelTabAttention,
  renderPanelCollapsedTabIcon,
  renderPanelTabIcon,
  renderPanelTabLabel,
  renderPanelTabTooltip,
  renderPanelTabTrailing,
} from '@/lib/panels/tab-display';
import {
  requestRevealedTerminalPanelSpawn,
  requestSelectedTerminalPanelFocus,
} from '@/lib/panels/terminal-panel-activation';
import { initTerminalPanelSync } from '@/lib/panels/terminal-panel-sync';
import { panelKindsUnavailableFor } from '@/lib/panels/scope-panel-kinds';
import { webCoreLocalId } from '@/lib/chat-authority';
import { useScopeCapabilities } from '@/hooks/useScopeCapabilities';
import { installPanelTestApi } from '@/lib/panels/test-api';
import { pt } from '@/lib/platform-text';
import { isInAppBrowserAvailable } from '@/lib/remote-control/in-app-browser-availability';
import { canTransferChatSession } from '@/lib/session-transfer-eligibility';
import {
  isSharedContainerPanelKind,
  sharedContainerExcludedPanelKinds,
} from '@/lib/shared-containers/panel-allowlist';
import {
  startPageFromAbsolutePath,
  startPageFromBrowserUrl,
  startPagesEqual,
} from '@/lib/start-page/project-start-page';
import { saveStartPageFromAction } from '@/lib/start-page/save-start-page';
import { uiText } from '@/lib/ui-text';
import { useWorkspaceAccess } from '@/lib/workspace-access';
import { selectBrowserSnapshot, useBrowserStore } from '@/stores/browserStore';
import {
  endChatIntent,
  noteChatIntent,
  type ChatPrefetchTarget,
} from '@/stores/chat/chat-prefetch';
import { useChatStore } from '@/stores/chatStore';
import { useNavigationMode } from '@/stores/navigationModeStore';
import { isLocalFileActionAvailable } from '@/lib/file-reveal';
import { createChatTabHoverCardRenderer } from '@/lib/panels/chat-tab-preview';
import { renderBrowserTabHoverCard } from '@/lib/panels/browser-tab-preview';
import {
  makeWorktreePanelKey,
  setFixedSidePanelTabsClosable,
  usePanelLayoutStore,
} from '@/stores/panelLayoutStore';
import { usePanelWindowsStore } from '@/stores/panelWindowsStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useStartPageStore } from '@/stores/startPageStore';
import { useWorkspaceLayoutModeStore } from '@/stores/workspaceLayoutModeStore';
import type { FileTreeRoot } from '@canopy/desktop-shared/types';
import { CHAT_UNIT_LABEL, isPanelKind, type PanelKind } from '@canopy/protocol';
import type { ProjectStartPage } from '@canopy/protocol/start-page';
import {
  PanelGridSurface as SharedPanelGridSurface,
  type PanelAddTabMenuRenderProps,
  type PanelGridSurfaceServices,
} from '@canopy/ui-app/panel-grid-surface';
import { LayoutDashboardIcon } from '@canopy/ui-shared/icons/AppIcons';
import type {
  PanelContentProps,
  PanelGroupModel,
  PanelTabModel,
} from '@canopy/ui-shared/panels';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { useShallow } from 'zustand/react/shallow';
import { SidePanelEmptyState } from './SidePanelEmptyState';

export interface PanelGridSurfaceProps {
  projectId: string;
  worktreeId: string;
  /** Page-shell state provided around every panel content subtree. */
  hostState: PanelHostState;
  /**
   * Whether this surface's PanelContentRoot also portals auxiliary
   * (popped-out) window content. Exactly one mounted surface may own aux
   * content — WorktreePart's. Defaults to `true`.
   */
  includeAuxWindowContent?: boolean;
  /**
   * Panel kinds omitted from this surface's add-panel menu. Temporary
   * capability restriction hook (e.g. `browser` on the App Advisor popout
   * until backend browser host ownership exists) — not a second contract.
   */
  addMenuExcludeKinds?: readonly PanelKind[];
  /**
   * Surface-specific New Chat creator for the tab-strip `+`. Cowork and App
   * Advisor pass their standalone `startNewChat()` (empty-tab reuse, model
   * defaults, archive-overlay dismissal); worktree surfaces omit it and get
   * the default grouped `addChatPanelToGroup` placement.
   */
  onNewChatTab?: (groupId: string) => void;
}

function canDesktopPanelPopOut(kind: string): boolean {
  return isPanelKind(kind) && getPanelDefinition(kind).canPopOut;
}

// Module-level so `services` identity churn (share-modal open/close) never
// invalidates the shared surface's intent-callbacks memo — the grid host is
// a renderer hot path.
function popOutGroupService(layoutKey: string, groupId: string): void {
  usePanelWindowsStore.getState().popOutGroup(layoutKey, groupId);
}

function popOutPanelService(
  layoutKey: string,
  groupId: string,
  panelId: string,
): void {
  usePanelWindowsStore.getState().popOutPanel(layoutKey, groupId, panelId);
}

function initializeSurface(worktreeKey: string): (() => void) | undefined {
  // Chat/panel sync reconciles an ordinary grid only while its key is the
  // selected worktree; see `registerChatPanelSyncOwner`.
  const disposeChatPanelSyncOwner = registerChatPanelSyncOwner(worktreeKey);
  initBrowserPanelActivation();
  initBrowserPanelSync();
  initPipelinePanelSync();
  initPlanPanelSync();
  initTerminalPanelSync();
  initChatPanelReveal();
  const disposePanelTestApi = installPanelTestApi(worktreeKey);
  return (): void => {
    disposePanelTestApi?.();
    disposeChatPanelSyncOwner();
  };
}

function renderAddTabMenu(props: PanelAddTabMenuRenderProps): ReactNode {
  return <PanelAddTabMenu {...props} />;
}

/**
 * Read-only scopes mount the standard registry, filtered by the access-derived
 * allowlist. A refused kind (a stale persisted terminal after consent was
 * revoked, a kind added later) never reaches its live renderer; the layout
 * repair closes it on the next pass.
 */
function renderReadOnlyRefusedPanel(props: PanelContentProps): ReactNode {
  return (
    <div
      data-testid="panel-read-only-refused"
      data-panel-id={props.panelId}
      className="flex min-h-0 flex-1 items-center justify-center p-6 text-s fg-secondary"
    >
      This panel is not available in a shared workspace
    </div>
  );
}

function minimalChromeForGroup(
  group: PanelGroupModel,
): { hideLabel: string } | undefined {
  if (group.groupId === DEFAULT_EXTRAS_GROUP_ID) {
    return { hideLabel: 'Collapse side panel' };
  }
  if (group.groupId === DEFAULT_TERMINAL_GROUP_ID) {
    return { hideLabel: 'Collapse bottom drawer' };
  }
  return undefined;
}

/**
 * Tab previews (Labs): a card for background chat and browser tabs; every
 * other kind keeps its tooltip.
 */
function createTabHoverCardRenderer(
  projectId: string,
  worktreeId: string,
): (tab: PanelTabModel) => ReactNode | null {
  const renderChat = createChatTabHoverCardRenderer(projectId, worktreeId);
  return (tab): ReactNode | null =>
    renderBrowserTabHoverCard(tab) ?? renderChat(tab);
}

export function PanelGridSurface({
  projectId,
  worktreeId,
  hostState,
  includeAuxWindowContent = true,
  addMenuExcludeKinds,
  onNewChatTab,
}: PanelGridSurfaceProps): JSX.Element {
  const worktreeKey = makeWorktreePanelKey(projectId, worktreeId);
  const access = useWorkspaceAccess();
  const readOnly = access.mode === 'read-only';
  const readOnlyRunAllowed = access.mode === 'read-only' && access.runAllowed;
  const fileActionsFirst = useNavigationMode() === 'work';
  const canRevealFile = isLocalFileActionAvailable('showInFinder');
  const startPageEnabled = useCanopyDesktopStartPageEnabled();
  const projectType = useProjectsStore(
    (state) => state.projects.find((project) => project.id === projectId)?.type,
  );
  const resolvedStartPage = useStartPageStore(
    (state) => state.resolved[`${projectId}:${worktreeId}`],
  );
  const [startPageRoots, setStartPageRoots] = useState<FileTreeRoot[]>([]);
  const scopeCapabilities = useScopeCapabilities({ projectId });
  // Start pages are files and URLs in a local project's own folder.
  const scopeHasLocalFiles = scopeCapabilities.fileSystemAccess !== 'none';
  // A cloud task's first chat is the task: closing it would archive the
  // whole task, so a scope that can't close it keeps its tab.
  const rootChatTabKept = scopeCapabilities.chatRootTabLifecycle !== true;
  const rootChatId = webCoreLocalId(worktreeId);
  const withRootChatTabKept = useCallback(
    (
      canClose: ((tab: PanelTabModel) => boolean) | undefined,
    ): ((tab: PanelTabModel) => boolean) | undefined =>
      rootChatTabKept && rootChatId !== null
        ? (tab): boolean =>
            !(
              tab.kind === 'chat' &&
              (tab.instance?.chatTabId === worktreeId ||
                tab.instance?.chatTabId === rootChatId)
            ) &&
            (canClose?.(tab) ?? true)
        : canClose,
    [rootChatId, rootChatTabKept, worktreeId],
  );
  useEffect(() => {
    if (!startPageEnabled || readOnly || !scopeHasLocalFiles) return;
    let canceled = false;
    void Promise.all([
      window.api.getFileTreeRoots({ projectId, worktreeId }),
      useStartPageStore.getState().refresh(projectId, worktreeId),
    ])
      .then(([response]) => {
        if (!canceled) setStartPageRoots(response.roots);
      })
      .catch(() => undefined);
    return (): void => {
      canceled = true;
    };
  }, [projectId, readOnly, scopeHasLocalFiles, startPageEnabled, worktreeId]);

  const startPageForTab = useCallback(
    (tab: PanelTabModel): ProjectStartPage | null => {
      if (!projectType) return null;
      if (tab.kind === 'file-diff') {
        const filePath =
          tab.instance?.filePath ??
          (tab.instance?.fileTabId
            ? useChatStore
                .getState()
                .worktreeChats[
                  worktreeKey
                ]?.tabs.find((chatTab) => chatTab.id === tab.instance?.fileTabId)
                ?.filePath
            : undefined);
        return filePath
          ? startPageFromAbsolutePath(filePath, startPageRoots, projectType)
          : null;
      }
      if (tab.kind !== 'browser' || !tab.instance?.browserId) return null;
      const snapshot = selectBrowserSnapshot(
        useBrowserStore.getState(),
        projectId,
        worktreeId,
        tab.instance.browserId,
      );
      if (!snapshot) return null;
      return startPageFromBrowserUrl(snapshot.url, startPageRoots, projectType);
    },
    [projectId, projectType, startPageRoots, worktreeId, worktreeKey],
  );
  // Shared-container viewers retain Activity panels because they have no card.
  const unavailableForScope = useMemo(
    () => panelKindsUnavailableFor(scopeCapabilities),
    [scopeCapabilities],
  );
  const activityIsCard =
    useLabsExperimentEnabled('activity-card') &&
    !isSharedContainerViewerLayout(worktreeKey);
  const effectiveAddMenuExcludeKinds = useMemo(():
    | readonly PanelKind[]
    | undefined => {
    const kinds = readOnly
      ? sharedContainerExcludedPanelKinds(readOnlyRunAllowed)
      : addMenuExcludeKinds;
    const unavailable: PanelKind[] = [...unavailableForScope];
    if (!isInAppBrowserAvailable()) unavailable.push('browser');
    if (activityIsCard) unavailable.push('activity-section');
    return unavailable.length > 0 ? [...(kinds ?? []), ...unavailable] : kinds;
  }, [
    activityIsCard,
    addMenuExcludeKinds,
    readOnly,
    readOnlyRunAllowed,
    unavailableForScope,
  ]);
  const modeEntry = useWorkspaceLayoutModeStore(
    useShallow((state) => state.entries[worktreeKey]),
  );
  const modeHydrated =
    modeEntry?.status === 'ready' || modeEntry?.status === 'error';
  const minimal = modeHydrated && modeEntry.mode === 'minimal';

  // Early access: the Side Panel can be emptied (it then lists what to
  // open), so its Activity and File explorer tabs close like any other.
  useEffect(() => {
    setFixedSidePanelTabsClosable(true);
  }, []);
  // Early access: the Side Panel is never tabless. Closing its last tab hides
  // it, and it holds a New tab for when it is shown again, so its starting
  // point reads as a tab like any other. Added without activating, so the
  // hidden Side Panel stays hidden. Not in a read-only shared container,
  // which refuses the New tab panel. Each chat has its own Side Panel tabs,
  // so it counts the tabs shown for the selected chat; a chat without any
  // gets its New tab without hiding the panel the user had open.
  const { sidePanelEmpty, sidePanelChatTabId } = usePanelLayoutStore(
    useShallow((state) => {
      const layout = state.layouts[worktreeKey];
      const group = layout?.viewModel.groups.find(
        (candidate) => candidate.groupId === DEFAULT_EXTRAS_GROUP_ID,
      );
      return {
        sidePanelEmpty: !readOnly && group?.tabs.length === 0,
        sidePanelChatTabId: layout?.chatScope?.activeChatTabId ?? null,
      };
    }),
  );
  const sidePanelChatRef = useRef<{
    readonly worktreeKey: string;
    readonly chatTabId: string | null;
  } | null>(null);
  useEffect(() => {
    const previous = sidePanelChatRef.current;
    sidePanelChatRef.current = { worktreeKey, chatTabId: sidePanelChatTabId };
    if (!sidePanelEmpty) return;
    const store = usePanelLayoutStore.getState();
    const switchedChat =
      previous !== null &&
      previous.worktreeKey === worktreeKey &&
      previous.chatTabId !== sidePanelChatTabId;
    if (switchedChat) {
      store.addTab(worktreeKey, DEFAULT_EXTRAS_GROUP_ID, 'new-tab', {
        instance: { newTabId: crypto.randomUUID() },
        title: 'New tab',
        activate: false,
      });
      return;
    }
    // A maximized group refuses to collapse; restore it first, as the Side
    // Panel toggle does.
    const maximizedGroupId = store.layouts[worktreeKey]?.maximizedGroupId;
    if (maximizedGroupId) {
      store.maximizeGroup(worktreeKey, maximizedGroupId, false);
    }
    if (
      usePanelLayoutStore.getState().layouts[worktreeKey]?.groups[
        DEFAULT_EXTRAS_GROUP_ID
      ]?.collapsed === undefined
    ) {
      store.collapseGroup(worktreeKey, DEFAULT_EXTRAS_GROUP_ID);
    }
    usePanelLayoutStore
      .getState()
      .addTab(worktreeKey, DEFAULT_EXTRAS_GROUP_ID, 'new-tab', {
        instance: { newTabId: crypto.randomUUID() },
        title: 'New tab',
        activate: false,
      });
  }, [sidePanelChatTabId, sidePanelEmpty, worktreeKey]);
  useEffect(() => {
    ensureEarlyAccessPanelRulesSync();
    void useWorkspaceLayoutModeStore.getState().load(worktreeKey);
    return (): void => disposeWorktreePanelHydration(worktreeKey);
  }, [worktreeKey]);
  // Busy chats keep their panel: the tab × is withheld and the context menu's
  // Close is disabled, instead of removing the panel for a chat the store
  // then refuses to close. The id set changes identity only when a chat's
  // closeability flips, which re-renders the tab bars.
  const busyChatIds = useBusyChatIds(projectId, worktreeId);
  const share = useShareRunAction(projectId, worktreeId);
  const exportSession = useExportSessionAction(projectId, worktreeId);
  const openShare = share.open;
  const openExport = exportSession.open;
  const auxWindows = usePanelWindowsStore((state) => state.auxWindows);
  const auxLayoutKeys = useMemo(
    (): string[] => Object.values(auxWindows).map((record) => record.layoutKey),
    [auxWindows],
  );
  const openFileInFileManager = useCallback(
    (absolutePath: string): void => {
      void window.api.showInFinder({
        absolutePath,
        projectId,
        worktreeId,
      });
    },
    [projectId, worktreeId],
  );
  const copyFilePath = useCallback((absolutePath: string): void => {
    void copyTextToClipboard(absolutePath);
  }, []);
  const copyRelativeFilePath = useCallback(
    (absolutePath: string): void => {
      void (async (): Promise<void> => {
        let worktreePath: string | undefined;
        try {
          worktreePath = await window.api.getWorktreePath({
            projectId,
            worktreeId,
          });
        } catch {
          worktreePath = undefined;
        }
        await copyTextToClipboard(
          formatFileReferencePath(absolutePath, worktreePath),
        );
      })();
    },
    [projectId, worktreeId],
  );
  const resolveFileTabPath = useCallback(
    (fileTabId: string): string | undefined => {
      const worktreeChat =
        useChatStore.getState().worktreeChats[`${projectId}/${worktreeId}`];
      const tab = worktreeChat?.tabs.find(
        (candidate) => candidate.id === fileTabId,
      );
      return tab?.kind === 'file' ? tab.filePath : undefined;
    },
    [projectId, worktreeId],
  );

  const handleShareSession = useCallback(
    (chatTabId: string, ownerDocument?: Document): void => {
      const chat =
        useChatStore.getState().worktreeChats[`${projectId}/${worktreeId}`];
      const tab = chat?.tabs.find((candidate) => candidate.id === chatTabId);
      openShare(
        chatTabId,
        tab?.title ?? 'Session',
        ownerDocument,
        tab?.sharedRun,
      );
    },
    [openShare, projectId, worktreeId],
  );

  const canShareSession = useCallback(
    (chatTabId: string): boolean => {
      const tab = useChatStore
        .getState()
        .worktreeChats[
          `${projectId}/${worktreeId}`
        ]?.tabs.find((candidate) => candidate.id === chatTabId);
      return share.entryVisible(tab?.sharedRun);
    },
    [projectId, share, worktreeId],
  );

  const handleExportSession = useCallback(
    (chatTabId: string, ownerDocument?: Document): void => {
      openExport(chatTabId, ownerDocument);
    },
    [openExport],
  );

  const chatTabRename = useChatTabRename();
  const openChatTabRename = chatTabRename.open;
  const handleRenameChat = useCallback(
    (chatTabId: string, ownerDocument?: Document): void => {
      openChatTabRename({
        projectId,
        worktreeId,
        tabId: chatTabId,
        ...(ownerDocument ? { ownerDocument } : {}),
      });
    },
    [openChatTabRename, projectId, worktreeId],
  );

  const chatReadState = useMemo(
    () => chatReadStateServices(projectId, worktreeId),
    [projectId, worktreeId],
  );

  // Archived chats live in each surface's top bar, never the tab strip.
  // Early access puts the Activity toggle at the main chat group's right end,
  // beside the card it opens, while that group shows a chat.
  const renderTabStripAccessory = useCallback(
    (group: PanelGroupModel): ReactNode => (
      <ActivityCardToggle
        projectId={projectId}
        worktreeId={worktreeId}
        groupId={group.groupId}
        activeTabKind={
          group.tabs.find((tab) => tab.panelId === group.activePanelId)?.kind ??
          null
        }
      />
    ),
    [projectId, worktreeId],
  );

  const handleAddChatTab = useCallback(
    (groupId: string): void => {
      if (onNewChatTab !== undefined) {
        onNewChatTab(groupId);
        return;
      }
      addChatPanelToGroup(makeWorktreePanelKey(projectId, worktreeId), groupId);
    },
    [onNewChatTab, projectId, worktreeId],
  );

  // Minimal keeps Activity and File explorer open. Early access lets the
  // Side Panel empty, so they close like any other tab there, and only the
  // last tab of a group Minimal must keep (the chat group) has no close.
  const canCloseMinimalTab = useCallback(
    (tab: PanelTabModel): boolean =>
      !isLastTabOfFixedGroup(
        usePanelLayoutStore.getState().layouts[worktreeKey]?.groups,
        tab.panelId,
      ),
    [worktreeKey],
  );

  const services = useMemo<PanelGridSurfaceServices>(
    () => ({
      renderPanelContent: readOnly
        ? (props): ReactNode =>
            isSharedContainerPanelKind(props.kind, readOnlyRunAllowed)
              ? renderPanelContent(props)
              : renderReadOnlyRefusedPanel(props)
        : renderPanelContent,
      panelErrorHost: panelErrorBoundaryHost,
      renderTabIcon: renderPanelTabIcon,
      renderCollapsedTabIcon: renderPanelCollapsedTabIcon,
      renderTabLabel: renderPanelTabLabel,
      onTabIntent: (groupId, tab, phase, source): void => {
        const chatId =
          tab.kind === 'chat' ? tab.instance?.chatTabId : undefined;
        const group =
          usePanelLayoutStore.getState().layouts[worktreeKey]?.groups[groupId];
        if (!chatId || !group || group.activePanelId === tab.panelId) return;
        const target: ChatPrefetchTarget = {
          kind: 'chat',
          projectId,
          worktreeId,
          chatId,
        };
        if (phase === 'start') noteChatIntent(target, source);
        else endChatIntent(target);
      },
      getTabTitle: panelTabDisplayTitle,
      renderTabAccessibleStatus: renderPanelTabAccessibleStatus,
      renderTabAttention: renderPanelTabAttention,
      renderTabTooltip: renderPanelTabTooltip,
      renderTabHoverCard: createTabHoverCardRenderer(projectId, worktreeId),
      renderTabTrailing: (tab): ReactNode => {
        const trailing = renderPanelTabTrailing(tab);
        const candidate = startPageForTab(tab);
        const isStartPage =
          startPageEnabled &&
          candidate !== null &&
          startPagesEqual(candidate, resolvedStartPage?.startPage);

        // No wrapper element: the fill tab's indicator slot lays these out and
        // must stay truly empty when an indicator component renders nothing,
        // or the tab would reserve room for an indicator it does not show.
        return (
          <>
            {trailing}
            {isStartPage && (
              <span
                aria-label="Start page"
                title="Start page"
                className="inline-flex fg-secondary"
                data-testid="panel-tab-start-page"
              >
                <LayoutDashboardIcon size="sm" />
              </span>
            )}
          </>
        );
      },
      getStartPageMenuState:
        startPageEnabled && !readOnly
          ? (tab): { isStartPage: boolean } | null => {
              const candidate = startPageForTab(tab);
              return candidate
                ? {
                    isStartPage: startPagesEqual(
                      candidate,
                      resolvedStartPage?.startPage,
                    ),
                  }
                : null;
            }
          : undefined,
      onToggleStartPage:
        startPageEnabled && !readOnly
          ? (tab): void => {
              const candidate = startPageForTab(tab);
              if (!candidate) return;
              void saveStartPageFromAction(
                projectId,
                startPagesEqual(candidate, resolvedStartPage?.startPage)
                  ? null
                  : candidate,
              );
            }
          : undefined,
      // A published chat is part of the share: closing its tab would archive
      // it, which is a write the read-only scope refuses. File tabs the
      // recipient opened share the chat panel kind and stay closable; main
      // accepts their discard on the viewer scope.
      canCloseTab: withRootChatTabKept(
        readOnly
          ? (tab: PanelTabModel): boolean =>
              (tab.kind !== 'chat' ||
                useChatStore
                  .getState()
                  .worktreeChats[
                    `${projectId}/${worktreeId}`
                  ]?.tabs.find((chatTab) => chatTab.id === tab.instance?.chatTabId)
                  ?.kind === 'file') &&
              (!minimal || canCloseMinimalTab(tab))
          : minimal
            ? (tab: PanelTabModel): boolean =>
                canCloseMinimalTab(tab) && !isBusyChatPanel(tab, busyChatIds)
            : busyChatIds.size > 0
              ? (tab: PanelTabModel): boolean =>
                  !isBusyChatPanel(tab, busyChatIds)
              : undefined,
      ),
      // No pop-out in read-only scopes: an auxiliary window renders outside
      // the access provider, so it would lose the read-only gating.
      canPopOutPanel: minimal || readOnly ? undefined : canDesktopPanelPopOut,
      ensureLayout: ensureWorktreePanelLayout,
      onSurfaceInit: initializeSurface,
      activateBoundBrowserPanel,
      // The renderer-global `document` is correct here and only here: these
      // services back the MAIN window's panel chrome. A popped-out panel
      // window never routes through them — `AuxPanelWindow` builds its own
      // `PanelIntentCallbacks` and passes its `childWindow.document`. Keep
      // that split if this surface ever gains a second host.
      onSelectPanel: (layoutKey, groupId, panelId): void => {
        requestSelectedTerminalPanelFocus(
          layoutKey,
          groupId,
          panelId,
          document,
        );
        // Selecting an unbound terminal tab is itself the request for a
        // terminal. Order with the focus call above does not matter: the
        // focus helper no-ops for an unbound panel, and the spawn records
        // its own focus gesture once it binds.
        requestRevealedTerminalPanelSpawn(
          projectId,
          worktreeId,
          layoutKey,
          groupId,
          panelId,
        );
      },
      // The one reveal gesture with no tab of its own: expanding a collapsed
      // bar. `panelId` is undefined here, so the helper falls back to the
      // group's active panel.
      onExpandGroup: (layoutKey, groupId, panelId): void => {
        requestRevealedTerminalPanelSpawn(
          projectId,
          worktreeId,
          layoutKey,
          groupId,
          panelId,
        );
      },
      onBrowserViewBoundsInvalidated: dispatchBrowserViewBoundsInvalidated,
      onPopOutGroup: popOutGroupService,
      onPopOutPanel: readOnly ? undefined : popOutPanelService,
      onCloseTab: closePanelTab,
      onCloseGroup: closePanelGroup,
      onCloseTabs: closePanelTabs,
      onCopyFilePath: copyFilePath,
      onCopyRelativeFilePath: copyRelativeFilePath,
      onOpenFileInFileManager:
        readOnly || !canRevealFile ? undefined : openFileInFileManager,
      resolveFileTabPath,
      openInFileManagerLabel: pt(uiText.fileManager.openItem),
      fileActionsFirst,
      onShareSession:
        !readOnly && canTransferChatSession(projectId)
          ? handleShareSession
          : undefined,
      canShareSession,
      onExportSession:
        !readOnly && canTransferChatSession(projectId)
          ? handleExportSession
          : undefined,
      onRenameChat: readOnly ? undefined : handleRenameChat,
      // Not gated on read-only: viewers may mark chats read and unread.
      getChatReadState: chatReadState?.getChatReadState,
      onSetChatUnread: chatReadState?.onSetChatUnread,
      renderAddTabMenu,
      // Read-only scopes cannot start a chat, so `+` opens the add-panel menu
      // (filtered to the read-safe kinds) instead of creating one.
      onAddTabClick: readOnly ? undefined : handleAddChatTab,
      // With fill tabs, `+` opens the add menu (New Chat first, then Browser,
      // Terminal, and the rest); Cmd/Ctrl+T still creates a chat directly.
      addTabOpensMenu: true,
      tabStyle: 'fill',
      // Early access: `+` in the Side Panel and Bottom Drawer opens an empty
      // new tab that lists what can be opened, instead of the add menu.
      onNewTabInGroup: !readOnly
        ? (groupId): void => {
            // The Bottom Drawer holds terminals only: its `+` opens one.
            if (groupId === DEFAULT_TERMINAL_GROUP_ID) {
              void createTerminalPanel(worktreeKey, groupId);
              return;
            }
            usePanelLayoutStore
              .getState()
              .addTab(worktreeKey, groupId, 'new-tab', {
                instance: { newTabId: crypto.randomUUID() },
                title: 'New tab',
              });
          }
        : undefined,
      onQuickAddPanel: (kind, groupId): void => {
        if (kind === 'browser') {
          void createBrowserPanel(worktreeKey, groupId);
        } else if (!readOnly || readOnlyRunAllowed) {
          void createTerminalPanel(worktreeKey, groupId);
        }
      },
      addTabLabel: readOnly ? 'Add panel' : `New ${CHAT_UNIT_LABEL}`,
      tabStripAccessoryForGroup: activityIsCard
        ? renderTabStripAccessory
        : undefined,
      // Early access: an empty Side Panel lists what can be opened there.
      emptyContentForGroup: (group, actions): ReactNode =>
        group.groupId === DEFAULT_EXTRAS_GROUP_ID ? (
          <SidePanelEmptyState
            worktreeKey={worktreeKey}
            groupId={group.groupId}
            actions={actions}
            {...(effectiveAddMenuExcludeKinds !== undefined
              ? { excludeKinds: effectiveAddMenuExcludeKinds }
              : {})}
          />
        ) : undefined,
    }),
    [
      activityIsCard,
      canCloseMinimalTab,
      effectiveAddMenuExcludeKinds,
      busyChatIds,
      readOnly,
      readOnlyRunAllowed,
      minimal,
      handleAddChatTab,
      handleExportSession,
      handleRenameChat,
      chatReadState,
      handleShareSession,
      canShareSession,
      copyFilePath,
      copyRelativeFilePath,
      fileActionsFirst,
      openFileInFileManager,
      canRevealFile,
      projectId,
      resolvedStartPage,
      renderTabStripAccessory,
      resolveFileTabPath,
      startPageEnabled,
      startPageForTab,
      worktreeId,
      worktreeKey,
    ],
  );

  if (!modeHydrated) {
    // The inset layout keeps the panel card on screen while the layout loads.
    return (
      <div
        className="flex min-h-0 min-w-0 flex-1"
        data-panel-grid-loading
        data-testid="panel-grid-loading"
      >
        <DelayedLoadingPlaceholder className="flex-1">
          <CenteredLoadingSpinner />
        </DelayedLoadingPlaceholder>
      </div>
    );
  }

  return (
    <>
      <SharedPanelGridSurface
        projectId={projectId}
        worktreeId={worktreeId}
        hostState={hostState}
        includeAuxWindowContent={includeAuxWindowContent}
        addMenuExcludeKinds={effectiveAddMenuExcludeKinds}
        auxLayoutKeys={auxLayoutKeys}
        services={services}
        fixedTopology={minimal}
        fixedTopologyChromeForGroup={
          minimal ? minimalChromeForGroup : undefined
        }
      />
      {share.target && (
        <ShareRunModal
          chatId={share.target.chatId}
          runTitle={share.target.title}
          ownerDocument={share.target.ownerDocument}
          existingShare={share.target.existingShare}
          onClose={share.close}
          onShare={share.submit}
          checkEligibility={share.checkEligibility}
          onShared={share.onShared}
        />
      )}
      {exportSession.target && (
        <ExportSessionConfirmationModal
          ownerDocument={exportSession.target.ownerDocument}
          onCancel={exportSession.close}
          onConfirm={exportSession.confirm}
        />
      )}
      {chatTabRename.dialog}
    </>
  );
}
