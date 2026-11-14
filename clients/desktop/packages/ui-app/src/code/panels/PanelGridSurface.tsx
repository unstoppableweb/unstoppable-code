'use client';

/**
 * PanelGridSurface — the reusable panel-grid host for one worktree key.
 *
 * Extracted from WorktreePart so both the Code worktree region and the Cowork
 * page can mount the same grid machinery: layout ensure (restore-or-default),
 * the chat⇄panel / browser-activation / chat-reveal bridges, intent callbacks,
 * the add-tab menu, the tab context menu, share-run, content adoption via
 * PanelContentRoot, and the E2E test API.
 *
 * NOT included (host responsibilities):
 * - The page shell/top bar (WorktreeTopBar vs CoworkTopBar) — hosts render
 *   this component inside a flex-column section; the grid fills the remainder
 *   (`min-h-0 flex-1`).
 * - Auxiliary (popped-out) window hosts — WorktreePart stays mounted for the
 *   app's lifetime and owns `AuxPanelWindow` rendering for ALL worktree keys.
 *   Additional surfaces must pass `includeAuxWindowContent={false}` so aux
 *   panel content is not double-portaled.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import type { PanelKind } from '@canopy/protocol';
import {
  PanelGridHost,
  type PanelTabBarAddTab,
  type PanelTabBarProps,
  type PanelTabStyle,
} from '@canopy/ui-shared/components/panels';
import {
  type PanelContentProps,
  type PanelGroupModel,
  type PanelIntentCallbacks,
  type PanelTabModel,
} from '@canopy/ui-shared/panels';
import {
  makeWorktreePanelKey,
  panelTabIndexForShownIndex,
  readPanelGroupRevealState,
  usePanelGridController,
  usePanelLayoutStore,
  usePanelLayoutViewModel,
} from './panel-layout-store';
import { registerPanelTabSelectionHandler } from './panel-tab-selection';
import {
  PanelHostContext,
  PanelWorktreeContext,
  type PanelHostState,
} from './panel-contexts';
import {
  acquirePanelContentElement,
  PanelContentRoot,
} from './PanelContentRoot';
import type { AppErrorBoundaryHost } from '../../feedback/AppErrorBoundary';
import {
  PanelTabContextMenu,
  type ClosePanelTab,
  type ClosePanelTabs,
  type PanelTabContextMenuProps,
  type PanelTabContextMenuTarget,
} from './PanelTabContextMenu';
import { splitGroupMovingActiveTab } from './split-active-tab';
import { useChatScopedSideViewCollapse } from './chat-scoped-collapse';

export interface PanelAddTabMenuRenderProps {
  readonly groupId: string;
  readonly worktreeKey: string;
  readonly excludeKinds?: readonly PanelKind[];
  readonly onSelect: (
    kind: PanelKind,
    opts?: {
      readonly instance?: Readonly<Record<string, string>>;
      readonly title?: string;
    },
  ) => void;
  readonly onClose: () => void;
}

export interface PanelGridSurfaceServices {
  renderPanelContent: (props: PanelContentProps) => ReactNode;
  /** Records a panel's render failure and offers its report. */
  panelErrorHost?: AppErrorBoundaryHost;
  renderTabIcon: (tab: PanelTabModel) => ReactNode;
  renderCollapsedTabIcon: (tab: PanelTabModel) => ReactNode;
  renderTabLabel: (tab: PanelTabModel) => ReactNode;
  /** Optional host intent callback; shared rendering never fetches. */
  onTabIntent?: PanelTabBarProps['onTabIntent'];
  getTabTitle: (tab: PanelTabModel) => string;
  renderTabAccessibleStatus?: (tab: PanelTabModel) => ReactNode;
  /** Persistent attention remains visible when a fill tab shrinks to its icon. */
  renderTabAttention?: (tab: PanelTabModel) => ReactNode;
  renderTabTooltip: (tab: PanelTabModel) => ReactNode | null;
  /**
   * Optional hover card for background tabs (a chat's preview). Omitted, every
   * tab keeps its tooltip; see `PanelTabBarProps.renderTabHoverCard`.
   */
  renderTabHoverCard?: (tab: PanelTabModel) => ReactNode | null;
  renderTabTrailing: (tab: PanelTabModel) => ReactNode;
  /** Optional host-owned start-page action for file and browser tabs. */
  getStartPageMenuState?: (
    tab: PanelTabModel,
  ) => { isStartPage: boolean } | null;
  onToggleStartPage?: (tab: PanelTabModel) => void;
  /**
   * Whether a tab may be closed from the strip. Omitted means every tab is
   * closable (historical behaviour, so desktop is unchanged). Hosts that route
   * closing through their own workflow use this so the control matches what
   * the handler will actually do.
   */
  canCloseTab?: (tab: PanelTabModel) => boolean;
  /** Omitted by hosts that cannot open panels in auxiliary windows. */
  canPopOutPanel?: (kind: string) => boolean;
  ensureLayout: (worktreeKey: string) => Promise<void>;
  /** Cancels pending mode/grid hydration when this surface changes owners. */
  disposeLayoutHydration?: (worktreeKey: string) => void;
  onSurfaceInit?: (worktreeKey: string) => (() => void) | undefined;
  activateBoundBrowserPanel: (
    projectId: string,
    worktreeId: string,
    groupId: string | null,
    panelId?: string,
  ) => void;
  /**
   * Optional host notification for an explicit user tab selection/reveal.
   * Hosts use this for surface-specific focus intent (desktop terminals),
   * while passive layout activation remains free of focus side effects.
   */
  onSelectPanel?: (layoutKey: string, groupId: string, panelId: string) => void;
  /**
   * Optional host notification for an explicit user expand gesture on a
   * collapsed group. This is the one reveal gesture with no `onSelectPanel`
   * of its own, because it reveals a group without naming a tab; `panelId` is
   * the group's active tab sampled BEFORE the expand, which is what the
   * gesture actually exposed. It is omitted only for an empty group.
   *
   * Passive store-driven expands (layout repair, hydration, restore)
   * deliberately never reach this, and neither does the incidental expand a
   * tab drop performs, so hosts may safely treat it as intent.
   */
  onExpandGroup?: (
    layoutKey: string,
    groupId: string,
    panelId?: string,
  ) => void;
  onBrowserViewBoundsInvalidated: () => void;
  onPopOutGroup: (layoutKey: string, groupId: string) => void;
  /** Omitted by hosts that cannot open panels in auxiliary windows. */
  onPopOutPanel?: (layoutKey: string, groupId: string, panelId: string) => void;
  onCloseTab: ClosePanelTab;
  /**
   * Optional host hook for closing a whole group. Omitted keeps the direct
   * store close. A host whose panes own external state (the portal's bound
   * chat panes) needs to run its own teardown, otherwise the panes vanish
   * while the entities stay live and get recreated on the next reconcile.
   */
  onCloseGroup?: (layoutKey: string, groupId: string) => void;
  onCloseTabs: ClosePanelTabs;
  onCopyFilePath?: (absolutePath: string) => void;
  onCopyRelativeFilePath?: (absolutePath: string) => void;
  onOpenFileInFileManager?: (absolutePath: string) => void;
  resolveFileTabPath?: (fileTabId: string) => string | undefined;
  openInFileManagerLabel?: string;
  /** File tab menus lead with reveal; see `PanelTabContextMenu`. */
  fileActionsFirst?: boolean;
  onShareSession?: (chatTabId: string, ownerDocument?: Document) => void;
  canShareSession?: (chatTabId: string) => boolean;
  onExportSession?: (chatTabId: string, ownerDocument?: Document) => void;
  /** Opens the host's chat rename dialog; omitted where rename is unsupported. */
  onRenameChat?: (chatTabId: string, ownerDocument?: Document) => void;
  /** Chat read state for the tab menu; see `PanelTabContextMenu`. */
  getChatReadState?: (chatTabId: string) => 'read' | 'unread' | undefined;
  /** A tab's archive row in its menu; see `PanelTabContextMenu`. */
  getTabArchiveAction?: PanelTabContextMenuProps['getArchiveAction'];
  /** Marks a chat unread or read; omitted where read state is unsupported. */
  onSetChatUnread?: (chatTabId: string, unread: boolean) => void;
  renderAddTabMenu: (props: PanelAddTabMenuRenderProps) => ReactNode;
  /**
   * Optional host action for the tab strip's `+` button. When provided it
   * REPLACES opening the add-panel menu (desktop: `+` creates a new chat in
   * the group). The menu stays reachable via right-click on the same button
   * until a dedicated add-panel affordance exists.
   */
  onAddTabClick?: (groupId: string) => void;
  /** Transactional repeat creation for an active Browser or Terminal tab. */
  onQuickAddPanel?: (kind: 'browser' | 'terminal', groupId: string) => void;
  /**
   * Opens an empty new tab in a fixed group (Side Panel, Bottom Drawer). When
   * set, those groups show a plain `+` that calls it instead of the add-panel
   * button and menu; the new tab lists what can be opened.
   */
  onNewTabInGroup?: (groupId: string) => void;
  /** Accessible label for the `+` button when {@link onAddTabClick} is set. */
  addTabLabel?: string;
  /**
   * In a flexible (non-fixed) layout, the `+` opens the add-panel menu, whose
   * first entry is the host's New Chat, instead of calling
   * {@link onAddTabClick}; the separate add-panel button is then not shown.
   * Fixed topologies keep {@link onAddTabClick} on their chat group.
   */
  addTabOpensMenu?: boolean;
  /**
   * How every group's tab bar lays out its tabs (classic by default).
   */
  tabStyle?: PanelTabStyle;
  /**
   * Optional per-group tab-strip accessory factory, rendered between the tab
   * strip and the group chrome (desktop: the archived-chats control on chat
   * groups).
   */
  tabStripAccessoryForGroup?: (group: PanelGroupModel) => ReactNode;
  /**
   * Optional content for a group while it has no tabs. `actions` adds a tab
   * to that group or opens its full add menu, the same paths as its `+`.
   */
  emptyContentForGroup?: (
    group: PanelGroupModel,
    actions: PanelEmptyGroupActions,
  ) => ReactNode;
}

export interface PanelEmptyGroupActions {
  readonly addTab: (
    kind: PanelKind,
    opts?: {
      readonly instance?: Readonly<Record<string, string>>;
      readonly title?: string;
    },
  ) => void;
  /** Opens or closes the full add menu beside the empty content's trigger. */
  readonly openAddMenu: () => void;
  /**
   * The add menu while the empty content opened it. The host renders it
   * inside the element that opened it, which the menu anchors to.
   */
  readonly addMenu?: ReactNode;
}

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
  auxLayoutKeys?: readonly string[];
  services: PanelGridSurfaceServices;
  /** Locks topology-changing chrome and callbacks while preserving resize/collapse/selection. */
  fixedTopology?: boolean;
  /** Fixed groups that show direct Full screen/Hide chrome and an Add panel catalog. */
  fixedTopologyChromeForGroup?: (
    group: PanelGroupModel,
  ) => { hideLabel: string } | undefined;
}

/**
 * A hidden chat's transcript mounts once its tab is first shown: a worktree
 * with many chats otherwise mounts and styles every one on each switch.
 */
function isChatPanelKind(kind: string): boolean {
  return kind === 'chat';
}

export function PanelGridSurface({
  projectId,
  worktreeId,
  hostState,
  includeAuxWindowContent = true,
  addMenuExcludeKinds,
  auxLayoutKeys = [],
  services,
  fixedTopology = false,
  fixedTopologyChromeForGroup,
}: PanelGridSurfaceProps): JSX.Element {
  const worktreeKey = makeWorktreePanelKey(projectId, worktreeId);
  const {
    renderPanelContent,
    renderTabIcon,
    renderCollapsedTabIcon,
    renderTabLabel,
    onTabIntent,
    getTabTitle,
    renderTabAccessibleStatus,
    renderTabAttention,
    renderTabTooltip,
    renderTabHoverCard,
    renderTabTrailing,
    getStartPageMenuState,
    onToggleStartPage,
    canCloseTab,
    canPopOutPanel,
    ensureLayout,
    disposeLayoutHydration,
    onSurfaceInit,
    activateBoundBrowserPanel,
    onSelectPanel,
    onExpandGroup,
    onBrowserViewBoundsInvalidated,
    onPopOutGroup,
    onPopOutPanel,
    onCloseTab,
    onCloseGroup,
    onCloseTabs,
    onCopyFilePath,
    onCopyRelativeFilePath,
    onOpenFileInFileManager,
    resolveFileTabPath,
    openInFileManagerLabel,
    fileActionsFirst,
    onShareSession,
    canShareSession,
    onExportSession,
    onRenameChat,
    getTabArchiveAction,
    getChatReadState,
    onSetChatUnread,
    renderAddTabMenu,
    tabStripAccessoryForGroup,
    emptyContentForGroup,
    onAddTabClick,
    onQuickAddPanel,
    onNewTabInGroup,
    addTabLabel,
    addTabOpensMenu = false,
    tabStyle,
  } = services;

  // Build (or reuse) the layout for the selected worktree. Runs as an effect
  // so store mutations never happen during render. Phase 5: the bridge first
  // awaits the persisted `panel-layout.json` load and restores it; only a
  // missing/corrupt file falls back to the default layout. The grid mounts
  // when either path commits (viewModel/controller flip non-null), so the
  // async load gap just extends the existing placeholder-frame paint.
  useEffect(() => {
    // Chat ⇄ panel sync bridge first (idempotent): its initial reconcile
    // then covers the layout the ensure call hydrates below. The browser
    // activation bridge (also idempotent) routes dev-server `Open` / App
    // Advisor browser requests to the exact bound Browser panel, and the
    // browser lifecycle coordinator translates committed panel closes into
    // permanent session destruction.
    // E2E hook: (re)install the panel test API for the visible layout. The
    // installer hard-gates on __CANOPY_E2E__ and returns undefined outside E2E
    // builds.
    const dispose = onSurfaceInit?.(worktreeKey);
    void ensureLayout(worktreeKey);
    return (): void => {
      dispose?.();
      disposeLayoutHydration?.(worktreeKey);
    };
  }, [disposeLayoutHydration, ensureLayout, onSurfaceInit, worktreeKey]);

  const viewModel = usePanelLayoutViewModel(worktreeKey);
  const controller = usePanelGridController(worktreeKey);
  const ownerSelection = useMemo(
    () => ({ projectId, worktreeId }),
    [projectId, worktreeId],
  );

  // Browser bounds contract (see BrowserPanelSurface JSDoc): BrowserPane's own
  // ResizeObserver covers pane RESIZES, but grid topology changes can MOVE a
  // browser pane without resizing it (e.g. maximizing/closing a sibling
  // group). The controller identity changes on every topology revision and on
  // wholesale rebuilds, so invalidating here covers those moves.
  useEffect(() => {
    if (controller !== null) {
      onBrowserViewBoundsInvalidated();
    }
  }, [controller, onBrowserViewBoundsInvalidated]);

  // Each chat tab keeps its own side panel open or closed.
  useChatScopedSideViewCollapse(worktreeKey);
  // Intent callbacks all dispatch through the store, bound to this worktree
  // key. `focusGroup` no-ops in the store when the group is already active,
  // so the capture-phase mousedown focus intent stays cheap.
  const callbacks = useMemo<PanelIntentCallbacks>(() => {
    const store = usePanelLayoutStore.getState;
    const key = worktreeKey;
    // Focus rules: selecting a Browser tab (or focusing a group whose active
    // panel is a Browser panel) EXPLICITLY makes that browser the worktree's
    // active browser. Focusing non-Browser content never clears the last
    // browser selection (the store only sets, never nulls, from here).
    return {
      onSelectTab: (groupId, panelId): void => {
        store().selectTab(key, groupId, panelId);
        activateBoundBrowserPanel(projectId, worktreeId, groupId, panelId);
        onSelectPanel?.(key, groupId, panelId);
      },
      onCloseTab: (groupId, panelId): void => {
        onCloseTab(key, groupId, panelId);
      },
      onCloseGroup: (groupId): void => {
        if (fixedTopology) return;
        if (onCloseGroup) {
          onCloseGroup(key, groupId);
          return;
        }
        store().closeGroup(key, groupId);
      },
      onSplitGroup: (groupId, direction): void => {
        if (!fixedTopology) splitGroupMovingActiveTab(key, groupId, direction);
      },
      onMaximizeGroup: (groupId, maximized): void => {
        // "Full screen" on a COLLAPSED group's overflow menu expands it in
        // the same transaction, so it reveals the group just as the expand
        // control does. Sample the group before the mutation, and notify only
        // for that case — maximizing an already-visible group reveals nothing
        // new.
        const before = readPanelGroupRevealState(key, groupId);
        store().maximizeGroup(key, groupId, maximized);
        if (maximized && before.collapsed) {
          onExpandGroup?.(key, groupId, before.activePanelId);
        }
      },
      onCollapseGroup: (groupId, collapsed, options): void => {
        const maximizedGroupId = store().layouts[key]?.maximizedGroupId;
        if (collapsed && maximizedGroupId !== null && maximizedGroupId) {
          store().maximizeGroup(key, maximizedGroupId, false);
        }
        if (collapsed) {
          store().collapseGroup(key, groupId);
          return;
        }
        const before = readPanelGroupRevealState(key, groupId);
        store().expandGroup(key, groupId);
        // A tab drop on a collapsed bar expands through this same callback,
        // but the expand is incidental to the move: the dropped tab becomes
        // active, so nothing the group already held was revealed. Notifying
        // there queued a reveal side effect for a panel that never becomes
        // active — and therefore never claims it — which would then fire on a
        // later PASSIVE activation.
        // Gated on the sampled flag for symmetry with `onMaximizeGroup`:
        // expanding an already-visible group reveals nothing, so it is not a
        // reveal gesture even when the chrome cannot currently produce one.
        if (before.collapsed && options?.gesture !== 'move') {
          onExpandGroup?.(key, groupId, before.activePanelId);
        }
      },
      onExpandGroupToTab: (groupId, panelId): void => {
        store().expandGroup(key, groupId, { activatePanelId: panelId });
        activateBoundBrowserPanel(projectId, worktreeId, groupId, panelId);
        onSelectPanel?.(key, groupId, panelId);
      },
      onFocusGroup: (groupId): void => {
        store().focusGroup(key, groupId);
        activateBoundBrowserPanel(projectId, worktreeId, groupId);
      },
      onMovePanel: (panelId, targetGroupId, edge, targetIndex): void => {
        // The strip's drop index counts only the selected chat's tabs.
        const tabIndex =
          targetIndex === undefined
            ? undefined
            : panelTabIndexForShownIndex(
                key,
                targetGroupId,
                panelId,
                targetIndex,
              );
        if (
          !fixedTopology &&
          store().movePanel(key, panelId, targetGroupId, edge, tabIndex)
        ) {
          activateBoundBrowserPanel(projectId, worktreeId, null, panelId);
        }
      },
      // Group drop predicate (same guards as movePanel): the body
      // highlight, tab-strip indicator, and collapsed bar never offer a
      // move the store refuses, such as a chat leaving the chat group.
      canDropPanel: (panelId, targetGroupId, edge): boolean =>
        !fixedTopology &&
        store().canMovePanel(key, panelId, targetGroupId, edge),
      // Root-edge drops (full-height/width groups at the grid's outer
      // edges); providing the callback is also what makes PanelGridHost
      // render the root-edge drop zones.
      onMovePanelToRootEdge: (panelId, edge): void => {
        if (!fixedTopology && store().movePanelToRootEdge(key, panelId, edge)) {
          activateBoundBrowserPanel(projectId, worktreeId, null, panelId);
        }
      },
      // Drop-affordance predicate: strips for edges whose drop would
      // silently no-op (same guards as movePanelToRootEdge) are suppressed
      // by the grid host, so the full-edge highlight never lies.
      canDropPanelAtRootEdge: (panelId, edge): boolean =>
        !fixedTopology && store().canMovePanelToRootEdge(key, panelId, edge),
      // Reordering within a group leaves the topology alone, so a fixed
      // layout allows it too.
      onReorderTab: (groupId, panelId, toIndex): void => {
        store().reorderTab(
          key,
          groupId,
          panelId,
          panelTabIndexForShownIndex(key, groupId, panelId, toIndex),
        );
      },
      // Phase 8 pull-out: moves the group into a new OS window via the
      // host's panel-windows service (which guards window-bound tabs and the
      // last remaining group; the chrome button already hides for
      // non-poppable groups via `canPopOutGroup`).
      onPopOutGroup: (groupId): void => {
        if (!fixedTopology) onPopOutGroup(key, groupId);
      },
    };
  }, [
    projectId,
    activateBoundBrowserPanel,
    onSelectPanel,
    onExpandGroup,
    fixedTopology,
    onCloseTab,
    onCloseGroup,
    onPopOutGroup,
    worktreeId,
    worktreeKey,
  ]);

  // Keyboard tab cycling (`panel-select-next-tab` / `-previous-tab`) selects
  // through the same intent as a tab click, so browser activation and the
  // host's terminal focus/spawn run for it too.
  useEffect(
    () =>
      registerPanelTabSelectionHandler(
        worktreeKey,
        (groupId: string, panelId: string): void => {
          callbacks.onSelectTab(groupId, panelId);
        },
      ),
    [callbacks, worktreeKey],
  );

  // Content adoption (no-remount handoff): the main grid's groups adopt the
  // stable per-panel containers owned by PanelContentRoot's registry instead
  // of rendering content inline; content itself renders exactly once in
  // <PanelContentRoot> below. Bound per worktree because container identity
  // is scoped `${worktreeKey}::${panelId}` (stable panel ids like
  // `panel-chat` repeat across worktrees).
  const getPanelContentElement = useCallback(
    (panelId: string): HTMLElement | null =>
      acquirePanelContentElement(worktreeKey, panelId),
    [worktreeKey],
  );

  // Add-tab affordance: the shared tab bar renders the `+` button; the
  // host owns the open-menu state (one group at most) and the menu of
  // registered panel kinds, and services selection via the store's addTab.
  const [addTabMenuGroupId, setAddTabMenuGroupId] = useState<string | null>(
    null,
  );
  // Which trigger opened it: the tab bar's `+`, or an empty group's own
  // content. The menu anchors to the element it renders in, so it renders
  // only beside the trigger that opened it.
  const [addTabMenuTrigger, setAddTabMenuTrigger] = useState<
    'tab-bar' | 'empty-content'
  >('tab-bar');

  // Tab right-click context menu (pin/unpin, close variants). One at a time,
  // addressed by group + panel of the visible layout.
  const [tabContextMenu, setTabContextMenu] =
    useState<PanelTabContextMenuTarget | null>(null);

  // The menus address groups of the visible layout only.
  useEffect(() => {
    setAddTabMenuGroupId(null);
    setTabContextMenu(null);
  }, [worktreeKey]);

  const handleTabContextMenu = useCallback(
    (
      groupId: string,
      panelId: string,
      clientX: number,
      clientY: number,
    ): void => {
      const tab = viewModel?.groups
        .find((group) => group.groupId === groupId)
        ?.tabs.find((candidate) => candidate.panelId === panelId);
      if (
        fixedTopology &&
        (tab === undefined ||
          (canCloseTab?.(tab) === false &&
            getTabArchiveAction?.(tab) === undefined))
      ) {
        return;
      }
      setTabContextMenu({ groupId, panelId, x: clientX, y: clientY });
    },
    [canCloseTab, fixedTopology, getTabArchiveAction, viewModel],
  );

  const handleCloseTabContextMenu = useCallback((): void => {
    setTabContextMenu(null);
  }, []);

  const handleNewWindow = useCallback(
    (groupId: string, panelId: string): void => {
      onPopOutPanel?.(worktreeKey, groupId, panelId);
    },
    [onPopOutPanel, worktreeKey],
  );

  // Tab-menu "Full screen" reuses the chrome intents, so it keeps their
  // browser activation and collapsed-group reveal behavior.
  const handleFullScreen = useCallback(
    (groupId: string, panelId: string): void => {
      callbacks.onSelectTab(groupId, panelId);
      callbacks.onMaximizeGroup(groupId, true);
    },
    [callbacks],
  );

  const handleLayoutGrid = useCallback(
    (width: number, height: number): void => {
      usePanelLayoutStore
        .getState()
        .layoutContainer(worktreeKey, width, height);
    },
    [worktreeKey],
  );

  const handleToggleAddTabMenu = useCallback((groupId: string): void => {
    setAddTabMenuTrigger('tab-bar');
    setAddTabMenuGroupId((current) => (current === groupId ? null : groupId));
  }, []);

  const handleCloseAddTabMenu = useCallback((): void => {
    setAddTabMenuGroupId(null);
  }, []);

  const handleAddTabSelect = useCallback(
    (
      groupId: string,
      kind: PanelKind,
      opts?: {
        readonly instance?: Readonly<Record<string, string>>;
        readonly title?: string;
      },
    ): void => {
      usePanelLayoutStore.getState().addTab(worktreeKey, groupId, kind, {
        ...(opts?.title !== undefined ? { title: opts.title } : {}),
        ...(opts?.instance !== undefined ? { instance: opts.instance } : {}),
      });
      setAddTabMenuGroupId(null);
    },
    [worktreeKey],
  );

  const hostEmptyContentForGroup = useMemo(
    () =>
      emptyContentForGroup === undefined
        ? undefined
        : (group: PanelGroupModel): ReactNode =>
            emptyContentForGroup(group, {
              addTab: (kind, opts): void => {
                handleAddTabSelect(group.groupId, kind, opts);
              },
              openAddMenu: (): void => {
                setAddTabMenuTrigger('empty-content');
                setAddTabMenuGroupId((current) =>
                  current === group.groupId ? null : group.groupId,
                );
              },
              addMenu:
                addTabMenuTrigger === 'empty-content' &&
                addTabMenuGroupId === group.groupId
                  ? renderAddTabMenu({
                      groupId: group.groupId,
                      worktreeKey,
                      ...(addMenuExcludeKinds !== undefined
                        ? { excludeKinds: addMenuExcludeKinds }
                        : {}),
                      onSelect: (kind, opts): void => {
                        handleAddTabSelect(group.groupId, kind, opts);
                      },
                      onClose: handleCloseAddTabMenu,
                    })
                  : undefined,
            }),
    [
      emptyContentForGroup,
      handleAddTabSelect,
      handleCloseAddTabMenu,
      addTabMenuTrigger,
      addTabMenuGroupId,
      addMenuExcludeKinds,
      renderAddTabMenu,
      worktreeKey,
    ],
  );

  const addTabForGroup = useCallback(
    (group: PanelGroupModel): PanelTabBarAddTab | undefined => {
      const hasChat = group.tabs.some((tab) => tab.kind === 'chat');
      const activeKind = group.tabs.find(
        (tab) => tab.panelId === group.activePanelId,
      )?.kind;
      const supportsQuickAdd =
        onQuickAddPanel !== undefined &&
        (activeKind === 'browser' || activeKind === 'terminal') &&
        // A kind this surface cannot add is not offered here either.
        !(addMenuExcludeKinds?.includes(activeKind) ?? false);
      const quickAdd =
        supportsQuickAdd &&
        (activeKind === 'browser' || activeKind === 'terminal')
          ? {
              label:
                activeKind === 'browser'
                  ? 'Add another browser'
                  : 'Add another Terminal',
              onQuickAdd: (groupId: string): void =>
                onQuickAddPanel?.(activeKind, groupId),
            }
          : undefined;
      const panelMenu =
        addTabMenuTrigger === 'tab-bar' && addTabMenuGroupId === group.groupId
          ? renderAddTabMenu({
              groupId: group.groupId,
              worktreeKey,
              ...(addMenuExcludeKinds !== undefined
                ? { excludeKinds: addMenuExcludeKinds }
                : {}),
              onSelect: (kind, opts): void => {
                handleAddTabSelect(group.groupId, kind, opts);
              },
              onClose: handleCloseAddTabMenu,
            })
          : undefined;

      if (fixedTopology) {
        if (
          fixedTopologyChromeForGroup?.(group) !== undefined &&
          onNewTabInGroup !== undefined
        ) {
          return { label: 'New tab', onAddTab: onNewTabInGroup };
        }
        if (fixedTopologyChromeForGroup?.(group) !== undefined) {
          return {
            label: 'Add panel',
            onAddTab: handleToggleAddTabMenu,
            hidePrimary: true,
            ...(quickAdd !== undefined ? { quickAdd } : {}),
            addPanel: {
              label: 'Add panel',
              onAddPanel: handleToggleAddTabMenu,
              menu: panelMenu,
            },
          };
        }
        if (!hasChat || onAddTabClick === undefined) return undefined;
        return {
          label: addTabLabel ?? 'New chat',
          onAddTab: onAddTabClick,
          addChat: {
            label: addTabLabel ?? 'New chat',
            onAddChat: onAddTabClick,
          },
        };
      }

      // The host's direct `+` action, unless its `+` opens the menu (whose
      // first entry is that same New Chat).
      const directAdd = addTabOpensMenu ? undefined : onAddTabClick;
      return {
        label: directAdd
          ? (addTabLabel ?? 'Add')
          : addTabOpensMenu
            ? 'New tab'
            : 'Add panel',
        onAddTab: directAdd ?? handleToggleAddTabMenu,
        ...(directAdd !== undefined && !hasChat ? { hidePrimary: true } : {}),
        ...(hasChat && directAdd
          ? {
              addChat: {
                label: addTabLabel ?? 'New chat',
                onAddChat: directAdd,
              },
            }
          : {}),
        ...(quickAdd !== undefined ? { quickAdd } : {}),
        // With a direct `+` action the add-panel menu moves to its own button.
        // Chat remains the first primary menu entry as well as having the
        // independent New Chat affordance.
        ...(directAdd
          ? {
              addPanel: {
                label: 'Add panel',
                onAddPanel: handleToggleAddTabMenu,
                menu: panelMenu,
              },
            }
          : {}),
        menu:
          directAdd === undefined && addTabMenuGroupId === group.groupId
            ? panelMenu
            : undefined,
      };
    },
    [
      addTabLabel,
      addTabOpensMenu,
      fixedTopology,
      fixedTopologyChromeForGroup,
      onAddTabClick,
      onQuickAddPanel,
      onNewTabInGroup,
      addTabMenuGroupId,
      addTabMenuTrigger,
      addMenuExcludeKinds,
      handleAddTabSelect,
      handleCloseAddTabMenu,
      handleToggleAddTabMenu,
      renderAddTabMenu,
      worktreeKey,
    ],
  );

  // Pop-out is capability-gated as a PAIR: both the eligibility check and
  // the action must exist, else neither group chrome nor tab menu offers it.
  const popOut = useMemo(
    () =>
      canPopOutPanel !== undefined && onPopOutPanel !== undefined
        ? {
            canPopOutGroup: (group: PanelGroupModel): boolean =>
              group.tabs.every((tab) => canPopOutPanel(tab.kind)),
            canPopOutPanel,
          }
        : undefined,
    [canPopOutPanel, onPopOutPanel],
  );

  return (
    <>
      {viewModel !== null && controller !== null && (
        <PanelHostContext.Provider value={hostState}>
          <PanelWorktreeContext.Provider value={ownerSelection}>
            <PanelGridHost
              layout={viewModel}
              gridController={controller}
              callbacks={callbacks}
              renderPanelContent={renderPanelContent}
              getPanelContentElement={getPanelContentElement}
              renderTabIcon={renderTabIcon}
              renderCollapsedTabIcon={renderCollapsedTabIcon}
              renderTabLabel={renderTabLabel}
              onTabIntent={onTabIntent}
              getTabTitle={getTabTitle}
              renderTabAccessibleStatus={renderTabAccessibleStatus}
              renderTabTooltip={renderTabTooltip}
              renderTabHoverCard={renderTabHoverCard}
              renderTabTrailing={renderTabTrailing}
              renderTabAttention={renderTabAttention}
              canCloseTab={canCloseTab}
              tabStyle={tabStyle}
              canPopOutGroup={
                fixedTopology ? undefined : popOut?.canPopOutGroup
              }
              fixedTopology={fixedTopology}
              fixedTopologyChromeForGroup={fixedTopologyChromeForGroup}
              onLayoutGrid={handleLayoutGrid}
              addTabForGroup={addTabForGroup}
              tabStripAccessoryForGroup={tabStripAccessoryForGroup}
              emptyContentForGroup={hostEmptyContentForGroup}
              onTabContextMenu={handleTabContextMenu}
              className="min-h-0 flex-1"
            />
          </PanelWorktreeContext.Provider>
        </PanelHostContext.Provider>
      )}
      {tabContextMenu !== null && (
        <PanelTabContextMenu
          layoutKey={worktreeKey}
          target={tabContextMenu}
          onClose={handleCloseTabContextMenu}
          onCloseTab={onCloseTab}
          onCloseTabs={onCloseTabs}
          canCloseTab={canCloseTab}
          onCopyFilePath={onCopyFilePath}
          onCopyRelativeFilePath={onCopyRelativeFilePath}
          onOpenFileInFileManager={onOpenFileInFileManager}
          resolveFileTabPath={resolveFileTabPath}
          openInFileManagerLabel={openInFileManagerLabel}
          fileActionsFirst={fileActionsFirst}
          onShareSession={onShareSession}
          canShareSession={canShareSession}
          onExportSession={onExportSession}
          onRenameChat={onRenameChat}
          getArchiveAction={getTabArchiveAction}
          getChatReadState={getChatReadState}
          onSetChatUnread={onSetChatUnread}
          onNewWindow={popOut !== undefined ? handleNewWindow : undefined}
          canOpenInNewWindow={popOut?.canPopOutPanel}
          onFullScreen={handleFullScreen}
          getStartPageMenuState={getStartPageMenuState}
          onToggleStartPage={onToggleStartPage}
          layoutLocked={fixedTopology}
          tabStyle={tabStyle}
        />
      )}
      <PanelContentRoot
        worktreeKey={worktreeKey}
        hostState={hostState}
        renderPanelContent={renderPanelContent}
        auxLayoutKeys={auxLayoutKeys}
        includeAuxWindows={includeAuxWindowContent}
        deferHiddenContent={isChatPanelKind}
        errorHost={services.panelErrorHost}
      />
    </>
  );
}
