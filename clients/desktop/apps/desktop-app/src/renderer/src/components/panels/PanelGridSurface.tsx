import { useLabsExperimentEnabled } from '@/stores/labsExperimentsStore';
import { ActivityCardToggle } from '@/components/activity/ActivityCardControl';
import { useChatTabRename } from '@/components/chat/ChatTabRenameDialog';
import { useTerminalRename } from '@canopy/ui-app/terminal-core';
import { PanelAddTabMenu } from '@/components/panels/PanelAddTabMenu';
import { ExportSessionConfirmationModal } from '@/components/shared/ExportSessionConfirmationModal';
import { ShareRunModal } from '@/components/shared/ShareRunModal';
import { PanelGridLoadingCard } from '@canopy/ui-shared/components/panels';
import { ConfirmDialog } from '@canopy/ui-shared/components';
import {
  archiveCloudTask,
  cloudTaskArchiveFailure,
} from '@/cloud-chats/archive-cloud-task';
import { POSTHOG_REPLAY_MASK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
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
import { initModPanePanelSync } from '@/lib/panels/mod-pane-panel-sync';
import { getPanelDefinition, renderPanelContent } from '@/lib/panels/registry';
import { isSharedContainerViewerLayout } from '@/lib/panels/shared-container-viewer-layout';
import {
  renderPanelTabAccessibleStatus,
  renderPanelTabAttention,
  renderPanelCollapsedTabIcon,
  renderPanelTabIcon,
  renderPanelTabLabel,
  renderPanelTabTooltip,
  renderPanelTabTrailing,
  usePanelTabTitleResolvers,
} from '@/lib/panels/tab-display';
import {
  requestRevealedTerminalPanelSpawn,
  requestSelectedTerminalPanelFocus,
} from '@/lib/panels/terminal-panel-activation';
import { initTerminalPanelSync } from '@/lib/panels/terminal-panel-sync';
import { panelKindsUnavailableFor } from '@/lib/panels/scope-panel-kinds';
import { webCoreLocalId } from '@/lib/chat-authority';
import { useScopeCapabilities } from '@/hooks/useScopeCapabilities';
import { workspaceFileSourceFor } from '@/lib/files/workspace-file-source';
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
import {
  useShownWorkspaceLayoutMode,
  useWorkspaceLayoutModeStore,
} from '@/stores/workspaceLayoutModeStore';
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
  useLayoutEffect,
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
  /**
   * Names what loads in the card shown until the grid mounts. A host that
   * shows the same card for its own wait first (the chat page, for an
   * entry's tabs) passes its label, so the card reads the same throughout.
   */
  loadingLabel?: string;
}

/**
 * New tabs the Side Panel added on its own while it was empty, by panel id.
 * They hold its starting point only until something real opens there: a
 * link from the chat, a file, an activity section. A New tab the user opened
 * with + is not listed and stays.
 */
const seededSidePanelNewTabIds = new Set<string>();

/**
 * Each worktree's file tree roots as last read, kept while its grid is away.
 * A grid mounts again on every switch to its worktree; starting from the
 * roots it already had, a read that confirms them changes nothing, where
 * starting empty rebuilt every tab service and rendered the whole grid chrome
 * a second time once the read answered.
 */
const EMPTY_START_PAGE_ROOTS: FileTreeRoot[] = [];
const REMEMBERED_START_PAGE_ROOTS_LIMIT = 64;
const startPageRootsByWorktree = new Map<string, FileTreeRoot[]>();

function rememberedStartPageRoots(worktreeKey: string): FileTreeRoot[] {
  return startPageRootsByWorktree.get(worktreeKey) ?? EMPTY_START_PAGE_ROOTS;
}

function rememberStartPageRoots(
  worktreeKey: string,
  roots: FileTreeRoot[],
): void {
  startPageRootsByWorktree.delete(worktreeKey);
  startPageRootsByWorktree.set(worktreeKey, roots);
  if (startPageRootsByWorktree.size > REMEMBERED_START_PAGE_ROOTS_LIMIT) {
    for (const oldest of startPageRootsByWorktree.keys()) {
      startPageRootsByWorktree.delete(oldest);
      break;
    }
  }
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
  initModPanePanelSync();
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
  loadingLabel,
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
  const [startPageRootsState, setStartPageRootsState] = useState(() => ({
    worktreeKey,
    roots: rememberedStartPageRoots(worktreeKey),
  }));
  // A grid moved to another worktree reads that worktree's roots, never the
  // previous one's.
  const startPageRoots =
    startPageRootsState.worktreeKey === worktreeKey
      ? startPageRootsState.roots
      : rememberedStartPageRoots(worktreeKey);
  const scopeCapabilities = useScopeCapabilities({ projectId });
  // Start pages are files and URLs in a local project's own folder; a cloud
  // chat's files are in its sandbox.
  const scopeHasLocalFiles =
    scopeCapabilities.fileSystemAccess !== 'none' &&
    workspaceFileSourceFor(worktreeId).onThisComputer;
  // A cloud task's first chat is the task: closing it would archive the
  // whole task, so a scope that can't close it keeps its tab. Paired-computer
  // scopes cannot create, rename, or close chat tabs yet (CAN-7907).
  const canCreateChatTab = scopeCapabilities.chatTabCreation !== false;
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
  // That kept tab archives the whole task instead, after a confirmation, as
  // the task's sidebar row does (CAN-6511).
  const [archiveTaskTitle, setArchiveTaskTitle] = useState<string | null>(null);
  const [archiveTaskStatus, setArchiveTaskStatus] = useState<
    'idle' | 'busy' | 'failed'
  >('idle');
  const [archiveTaskFailure, setArchiveTaskFailure] = useState('');
  const rootChatArchiveAction = useMemo(
    () =>
      rootChatTabKept && rootChatId !== null && !readOnly
        ? (
            tab: PanelTabModel,
          ): { label: string; onSelect: () => void } | undefined =>
            tab.kind === 'chat' &&
            (tab.instance?.chatTabId === worktreeId ||
              tab.instance?.chatTabId === rootChatId)
              ? {
                  label: 'Archive task',
                  onSelect: (): void => setArchiveTaskTitle(tab.title ?? ''),
                }
              : undefined
        : undefined,
    [readOnly, rootChatId, rootChatTabKept, worktreeId],
  );
  useEffect(() => {
    if (!startPageEnabled || readOnly || !scopeHasLocalFiles) return;
    let canceled = false;
    void Promise.all([
      window.api.getFileTreeRoots({ projectId, worktreeId }),
      useStartPageStore.getState().refresh(projectId, worktreeId),
    ])
      .then(([response]) => {
        // Roots that did not change keep their array: a new one rebuilds
        // every tab service and renders the whole grid chrome again.
        const known = rememberedStartPageRoots(worktreeKey);
        const roots =
          JSON.stringify(known) === JSON.stringify(response.roots)
            ? known
            : response.roots;
        rememberStartPageRoots(worktreeKey, roots);
        if (canceled) return;
        setStartPageRootsState((current) =>
          current.worktreeKey === worktreeKey && current.roots === roots
            ? current
            : { worktreeKey, roots },
        );
      })
      .catch(() => undefined);
    return (): void => {
      canceled = true;
    };
  }, [
    projectId,
    readOnly,
    scopeHasLocalFiles,
    startPageEnabled,
    worktreeId,
    worktreeKey,
  ]);

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
    if (!canCreateChatTab) unavailable.push('chat');
    if (!isInAppBrowserAvailable()) unavailable.push('browser');
    if (activityIsCard) unavailable.push('activity-section');
    return unavailable.length > 0 ? [...(kinds ?? []), ...unavailable] : kinds;
  }, [
    activityIsCard,
    addMenuExcludeKinds,
    canCreateChatTab,
    readOnly,
    readOnlyRunAllowed,
    unavailableForScope,
  ]);
  // Known from the first render for a worktree shown before, so switching to
  // it mounts its grid in the same commit that takes the previous one down.
  const layoutMode = useShownWorkspaceLayoutMode(worktreeKey);
  const modeHydrated = layoutMode !== null;
  const minimal = layoutMode === 'minimal';
  // The grid itself mounts once the worktree's layout is in memory, which on
  // a first visit is a second read after the mode's. The same store answers
  // the grid below, so this turns in the commit that mounts it.
  const layoutInMemory = usePanelLayoutStore(
    (state) => state.layouts[worktreeKey] !== undefined,
  );
  const gridLoading = !modeHydrated || !layoutInMemory;

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
    const seedNewTab = (): void => {
      const panelId = usePanelLayoutStore
        .getState()
        .addTab(worktreeKey, DEFAULT_EXTRAS_GROUP_ID, 'new-tab', {
          instance: { newTabId: crypto.randomUUID() },
          title: 'New tab',
          activate: false,
        });
      if (panelId !== null) seededSidePanelNewTabIds.add(panelId);
    };
    if (switchedChat) {
      seedNewTab();
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
    seedNewTab();
  }, [sidePanelChatTabId, sidePanelEmpty, worktreeKey]);
  // Something real opened in the Side Panel (a link from the chat, a file):
  // the New tabs it added on its own close, so it shows only what was opened.
  const seededNewTabsToClose = usePanelLayoutStore(
    useShallow((state): string[] => {
      const tabs = state.layouts[worktreeKey]?.viewModel.groups.find(
        (candidate) => candidate.groupId === DEFAULT_EXTRAS_GROUP_ID,
      )?.tabs;
      if (!tabs?.some((tab) => tab.kind !== 'new-tab')) return [];
      return tabs.flatMap((tab) =>
        tab.kind === 'new-tab' && seededSidePanelNewTabIds.has(tab.panelId)
          ? [tab.panelId]
          : [],
      );
    }),
  );
  useEffect(() => {
    const store = usePanelLayoutStore.getState();
    for (const panelId of seededNewTabsToClose) {
      seededSidePanelNewTabIds.delete(panelId);
      store.closeTab(worktreeKey, DEFAULT_EXTRAS_GROUP_ID, panelId);
    }
  }, [seededNewTabsToClose, worktreeKey]);
  // Before paint: a grid shown in its remembered mode takes that mode's
  // locked arrangement in the same frame, never one frame later.
  useLayoutEffect(() => {
    ensureEarlyAccessPanelRulesSync();
    void useWorkspaceLayoutModeStore.getState().load(worktreeKey);
  }, [worktreeKey]);
  useEffect(
    () => (): void => disposeWorktreePanelHydration(worktreeKey),
    [worktreeKey],
  );
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

  // Only the callback, never the controller: `share` is a new object on
  // every render, and depending on it rebuilt `services` below each time,
  // which rendered every panel group, tab bar and tab again.
  const shareEntryVisible = share.entryVisible;
  const canShareSession = useCallback(
    (chatTabId: string): boolean => {
      const tab = useChatStore
        .getState()
        .worktreeChats[
          `${projectId}/${worktreeId}`
        ]?.tabs.find((candidate) => candidate.id === chatTabId);
      return shareEntryVisible(tab?.sharedRun);
    },
    [projectId, shareEntryVisible, worktreeId],
  );

  const handleExportSession = useCallback(
    (chatTabId: string, ownerDocument?: Document): void => {
      openExport(chatTabId, ownerDocument);
    },
    [openExport],
  );

  const chatTabRename = useChatTabRename();
  const terminalRename = useTerminalRename(projectId, worktreeId);
  const tabTitles = usePanelTabTitleResolvers();
  const openTerminalRename = terminalRename.open;
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
    () =>
      scopeCapabilities.chatReadState === false
        ? undefined
        : chatReadStateServices(projectId, worktreeId),
    [projectId, scopeCapabilities.chatReadState, worktreeId],
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
      ...tabTitles,
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
        readOnly || !canCreateChatTab
          ? (tab: PanelTabModel): boolean =>
              (tab.kind !== 'chat' ||
                (readOnly &&
                  useChatStore
                    .getState()
                    .worktreeChats[
                      `${projectId}/${worktreeId}`
                    ]?.tabs.find((chatTab) => chatTab.id === tab.instance?.chatTabId)
                    ?.kind === 'file')) &&
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
        !readOnly &&
        scopeCapabilities.chatSessionTransfer === true &&
        canTransferChatSession(projectId)
          ? handleShareSession
          : undefined,
      canShareSession,
      onExportSession:
        !readOnly &&
        scopeCapabilities.chatSessionTransfer === true &&
        canTransferChatSession(projectId)
          ? handleExportSession
          : undefined,
      onRenameChat:
        readOnly || !canCreateChatTab ? undefined : handleRenameChat,
      onRenameTerminal:
        readOnly || scopeCapabilities.terminalRename !== true
          ? undefined
          : openTerminalRename,
      getTabArchiveAction: rootChatArchiveAction,
      // Not gated on read-only: viewers may mark chats read and unread.
      getChatReadState: chatReadState?.getChatReadState,
      onSetChatUnread: chatReadState?.onSetChatUnread,
      renderAddTabMenu,
      // Read-only scopes cannot start a chat, so `+` opens the add-panel menu
      // (filtered to the read-safe kinds) instead of creating one.
      onAddTabClick:
        readOnly || !canCreateChatTab ? undefined : handleAddChatTab,
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
      canCreateChatTab,
      effectiveAddMenuExcludeKinds,
      busyChatIds,
      readOnly,
      readOnlyRunAllowed,
      minimal,
      handleAddChatTab,
      handleExportSession,
      handleRenameChat,
      openTerminalRename,
      scopeCapabilities.chatSessionTransfer,
      scopeCapabilities.terminalRename,
      tabTitles,
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
      rootChatArchiveAction,
      startPageEnabled,
      startPageForTab,
      worktreeId,
      worktreeKey,
    ],
  );

  // The inset layout keeps the panel card on screen while the layout loads.
  // One element for the whole wait, the mode's read and then the layout's:
  // taking it down between the two left the space under the top bar empty,
  // with no card, until the grid mounted.
  const loadingCard = gridLoading ? (
    <PanelGridLoadingCard label={loadingLabel} />
  ) : null;

  if (!modeHydrated) {
    return <>{loadingCard}</>;
  }

  return (
    <>
      {loadingCard}
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
        // The card above covers this wait too, as one element.
        loadingFallback={null}
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
      {terminalRename.dialog}
      {archiveTaskTitle !== null && (
        <ConfirmDialog
          title={
            archiveTaskTitle.trim() === '' ? (
              'Archive task?'
            ) : (
              <>
                Archive “
                <span className={POSTHOG_REPLAY_MASK_CLASS}>
                  {archiveTaskTitle.trim()}
                </span>
                ”?
              </>
            )
          }
          message="This archives the task and all of its chats. Archived chats are kept until you delete them."
          confirmLabel="Archive task"
          dataTestId="cloud-task-archive-confirm"
          confirmTestId="cloud-task-archive-confirm-button"
          busy={archiveTaskStatus === 'busy'}
          errorMessage={
            archiveTaskStatus === 'failed' ? archiveTaskFailure : null
          }
          // The failure reaches here as display text only, so typed refusals and
          // offline failures can't be told apart from defects; recording here
          // would log expected outcomes as defects.
          errorRecordingDisabled
          onCancel={(): void => {
            setArchiveTaskStatus('idle');
            setArchiveTaskTitle(null);
          }}
          onConfirm={(): void => {
            setArchiveTaskStatus('busy');
            archiveCloudTask(projectId, worktreeId).then(
              () => {
                setArchiveTaskStatus('idle');
                setArchiveTaskTitle(null);
              },
              (error: unknown) => {
                setArchiveTaskFailure(cloudTaskArchiveFailure(error));
                setArchiveTaskStatus('failed');
              },
            );
          }}
        />
      )}
    </>
  );
}
