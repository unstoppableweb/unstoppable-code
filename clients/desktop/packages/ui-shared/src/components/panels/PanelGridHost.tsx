import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type JSX,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { DisposableStore, toDisposable } from '../../lib/disposable';
import { DragAndDropObserver } from '../../panels/dnd-observer';
import { getWindow } from '../../lib/window-registry';
import type {
  PanelContentProps,
  PanelGroupModel,
  PanelIntentCallbacks,
  PanelLayoutViewModel,
  PanelRootDropEdge,
  PanelTabModel,
} from '../../panels/registry-types';
import type { PanelGridController } from './grid-host-types';
import {
  clearPanelTabDrag,
  hasActivePanelTabDrag,
  readPanelTabDrag,
} from './panel-dnd';
import type { PanelChromeLabels } from './PanelChrome';
import type {
  PanelTabBarAddTab,
  PanelTabBarProps,
  PanelTabStyle,
} from './PanelTabBar';
import { PanelGroup } from './PanelGroup';
import { PanelBranchCollapsedBar } from './PanelBranchCollapsedBar';

/** The four root-edge drop zones, in render order. */
const ROOT_DROP_EDGES: readonly PanelRootDropEdge[] = [
  'top',
  'bottom',
  'left',
  'right',
];

export interface PanelGridHostProps {
  /** The derived group/tab view-model: WHAT exists, not where it sits. */
  layout: PanelLayoutViewModel;
  /**
   * The seam to the stateful layout owner. The store owns the grid and all
   * topology mutations; the host only attaches, sizes, and portals content.
   * See {@link PanelGridController} for the ownership contract.
   */
  gridController: PanelGridController;
  callbacks: PanelIntentCallbacks;
  /** Renders one panel's content (from the app's panel registry). */
  renderPanelContent: (props: PanelContentProps) => ReactNode;
  /**
   * Content adoption mode, forwarded to every {@link PanelGroup}: resolves
   * the app-owned stable container element a tab body should adopt instead
   * of rendering `renderPanelContent` inline. See
   * {@link PanelGroupProps.getPanelContentElement} for the full contract.
   */
  getPanelContentElement?: (panelId: string) => HTMLElement | null;
  /** Which OS window this grid lives in; drives `data-window`.
   * @defaultValue `'main'` */
  windowLabel?: 'main' | 'aux';
  className?: string;
  /** Chrome copy override, forwarded to every group's chrome. */
  chromeLabels?: PanelChromeLabels;
  /** Optional per-tab icon renderer, forwarded to every group's tab bar. */
  renderTabIcon?: (tab: PanelTabModel) => ReactNode;
  /**
   * Optional per-tab icon renderer used ONLY by each group's collapsed icon
   * bar (activity-aware collapsed icons); falls back to {@link renderTabIcon}.
   */
  renderCollapsedTabIcon?: (tab: PanelTabModel) => ReactNode;
  /** Optional per-tab label renderer, forwarded to every group's tab bar. */
  renderTabLabel?: (tab: PanelTabModel) => ReactNode;
  /** Forwarded unchanged to each tab header. */
  onTabIntent?: PanelTabBarProps['onTabIntent'];
  /** Plain-string title resolver for tooltips + close-button accessible names. */
  getTabTitle?: (tab: PanelTabModel) => string;
  isTabTitlePrivate?: (tab: PanelTabModel) => boolean;
  renderTabAccessibleStatus?: (tab: PanelTabModel) => ReactNode;
  /** Persistent attention remains visible when a fill tab shrinks to its icon. */
  renderTabAttention?: (tab: PanelTabModel) => ReactNode;
  /**
   * Optional per-tab RICH tooltip renderer, forwarded to every group's tab
   * bar and collapsed icon bar. A non-null result replaces the plain/native
   * tooltip for that tab in every presentation (normal, pinned, collapsed);
   * other tabs keep their simple tooltip.
   */
  renderTabTooltip?: (tab: PanelTabModel) => ReactNode | null;
  /**
   * Optional per-tab hover card for background tabs, forwarded to every
   * group's tab bar; see {@link PanelTabBarProps.renderTabHoverCard}.
   */
  renderTabHoverCard?: (tab: PanelTabModel) => ReactNode | null;
  /** Optional per-tab trailing renderer, forwarded to every group's tab bar. */
  renderTabTrailing?: (tab: PanelTabModel) => ReactNode;
  /** Forwarded to each {@link PanelGroup}; omitted means every tab is closable. */
  canCloseTab?: (tab: PanelTabModel) => boolean;
  /** How every group's tab bar lays out its tabs. */
  tabStyle?: PanelTabStyle;
  /** Per-group pop-out gate (e.g. every tab's definition `canPopOut`). */
  canPopOutGroup?: (group: PanelGroupModel) => boolean;
  /** Hides topology-editing group chrome while preserving panel content. */
  fixedTopology?: boolean;
  /** Selects fixed groups that receive direct Full screen/Hide chrome. */
  fixedTopologyChromeForGroup?: (
    group: PanelGroupModel,
  ) => { hideLabel: string } | undefined;
  /**
   * Optional sizing seam for stateful owners that need to observe container
   * layout commits. When omitted, the host lays out the grid directly.
   */
  onLayoutGrid?: (width: number, height: number) => void;
  /**
   * Optional per-group add-tab affordance factory (label + click intent +
   * app-owned menu node); returning `undefined` renders no `+` button for
   * that group.
   */
  addTabForGroup?: (group: PanelGroupModel) => PanelTabBarAddTab | undefined;
  /**
   * Optional per-group tab-strip accessory factory, rendered in the group's
   * title bar between the tab strip and the chrome (e.g. the desktop
   * archived-chats control on chat groups). Returning `undefined` renders
   * nothing for that group.
   */
  tabStripAccessoryForGroup?: (group: PanelGroupModel) => ReactNode;
  /**
   * Optional per-group content shown while a group has no tabs, in place of
   * the generic empty message. Returning `undefined` keeps the default.
   */
  emptyContentForGroup?: (group: PanelGroupModel) => ReactNode;
  /**
   * Optional tab right-click handler, forwarded to every group's tab bar. The
   * app builds and positions the actual context menu (pin/unpin, close, close
   * others/right/left/all). Omitted, right-click falls through to the default.
   */
  onTabContextMenu?: (
    groupId: string,
    panelId: string,
    clientX: number,
    clientY: number,
  ) => void;
}

/**
 * The controlled grid host: renders the panel layout for one window.
 *
 * Ownership split (binding, see {@link PanelGridController}): the stateful
 * wrapper owns the Grid instance and mutates its topology; this component is
 * purely display glue —
 *
 * 1. attaches `controller.grid.element` into its host div (re-attaching when
 *    the grid identity changes, e.g. a wholesale rebuild on restore),
 * 2. drives `grid.layout(width, height)` from a host ResizeObserver and on
 *    every revision bump,
 * 3. portals a {@link PanelGroup} into each group's stable leaf element,
 * 4. decorates and forwards {@link PanelIntentCallbacks}, and
 * 5. renders the ROOT-edge drop zones (`panel-drop-zone-root-${edge}`)
 *    over the grid while an in-process panel-tab drag is in flight —
 *    IF the callbacks implement `onMovePanelToRootEdge`. The strips sit
 *    above group content, so within their narrow bounds they win over the
 *    group-body edge zones (native hit-testing; the group body never sees
 *    the dragover), and they do not exist in the DOM outside a drag.
 *    Edges whose drop the layout owner reports as a no-op for the dragged
 *    panel (`canDropPanelAtRootEdge`) render NO strip, so the UI never
 *    shows a full-edge highlight that a release would silently refuse.
 *    Root-edge drops are dispatched from the HOST's drag observer (which
 *    sees the drop wherever native hit-testing lands it, as long as a
 *    strip is hovered); the strip's own drop handler is only a backstop.
 *
 * Content identity: each group portal targets the leaf container element the
 * controller resolves via `getLeafElement`. Leaf elements are created once
 * per group by the store (grid-leaf-adapter pattern) and keep their identity
 * across splits, moves, relayouts, and revision bumps, so portal subtrees —
 * and therefore panel content DOM — never remount across topology changes.
 */
export function PanelGridHost({
  layout,
  gridController,
  callbacks,
  renderPanelContent,
  getPanelContentElement,
  windowLabel,
  className,
  chromeLabels,
  renderTabIcon,
  renderCollapsedTabIcon,
  renderTabLabel,
  onTabIntent,
  getTabTitle,
  isTabTitlePrivate,
  renderTabAccessibleStatus,
  renderTabAttention,
  renderTabTooltip,
  renderTabHoverCard,
  renderTabTrailing,
  canCloseTab,
  tabStyle,
  canPopOutGroup,
  fixedTopology = false,
  fixedTopologyChromeForGroup,
  onLayoutGrid,
  addTabForGroup,
  tabStripAccessoryForGroup,
  emptyContentForGroup,
  onTabContextMenu,
}: PanelGridHostProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const attachedGridElementRef = useRef<HTMLElement | null>(null);
  const attachmentDisposablesRef = useRef<DisposableStore | null>(null);
  const appliedRevisionRef = useRef<number | null>(null);

  // Root-edge drop zones (VS Code window-edge drops): `rootDragArmed` flips
  // while an in-process panel-tab drag is over the host, which is what
  // renders the edge hit strips; `rootDropEdge` is the strip currently
  // hovered (drives the full-edge highlight overlay). The ref mirrors the
  // hovered edge synchronously (set by the strip handlers themselves, not
  // at render) so the HOST observer's native drop listener — which runs
  // before React's delegated dispatch — always sees the current hover.
  const [rootDragArmed, setRootDragArmed] = useState(false);
  const [rootDropEdge, setRootDropEdge] = useState<PanelRootDropEdge | null>(
    null,
  );
  const hoveredRootEdgeRef = useRef<PanelRootDropEdge | null>(null);

  const setHoveredRootEdge = (edge: PanelRootDropEdge | null): void => {
    hoveredRootEdgeRef.current = edge;
    setRootDropEdge(edge);
  };

  const latestGridRef = useRef(gridController.grid);
  latestGridRef.current = gridController.grid;
  const onLayoutGridRef = useRef(onLayoutGrid);
  onLayoutGridRef.current = onLayoutGrid;

  // Latest-render snapshot so the one-shot arming observer and the strip
  // drop handlers always see current callbacks.
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const layoutGrid = (width: number, height: number): void => {
    const w = Math.max(0, Math.floor(width));
    const h = Math.max(0, Math.floor(height));

    if (w > 0 && h > 0) {
      if (onLayoutGridRef.current !== undefined) {
        onLayoutGridRef.current(w, h);
      } else {
        latestGridRef.current.layout(w, h);
      }
    }
  };

  const detachGrid = (): void => {
    attachmentDisposablesRef.current?.dispose();
    attachmentDisposablesRef.current = null;

    const element = attachedGridElementRef.current;

    // Only detach the element from OUR host; the store owns the grid (and
    // may have already adopted its element elsewhere, e.g. an aux window).
    if (element && element.parentElement === hostRef.current) {
      element.remove();
    }

    attachedGridElementRef.current = null;
    appliedRevisionRef.current = null;
  };

  const grid = gridController.grid;
  const gridRevision = gridController.revision;

  // Attachment and topology layout depend only on the engine identity and
  // revision. Panel selection/content renders keep the same engine snapshot
  // and must not re-enter this layout effect.
  useLayoutEffect(() => {
    const host = hostRef.current;

    if (!host) {
      return;
    }

    if (attachedGridElementRef.current !== grid.element) {
      detachGrid();
      host.appendChild(grid.element);
      attachedGridElementRef.current = grid.element;

      const store = new DisposableStore();
      attachmentDisposablesRef.current = store;

      // Construct the observer from the HOST element's own realm (window
      // registry): a ResizeObserver only observes elements rendered in its
      // owning window, so an aux-window grid host needs the aux window's
      // constructor (doc 05 §7.8).
      const hostWindow = getWindow(host);

      if (typeof hostWindow.ResizeObserver !== 'undefined') {
        const observer = new hostWindow.ResizeObserver((entries) => {
          const rect = entries[0]?.contentRect;

          if (rect) {
            layoutGrid(rect.width, rect.height);
          } else {
            layoutGrid(host.clientWidth, host.clientHeight);
          }
        });
        observer.observe(host);
        store.add(toDisposable(() => observer.disconnect()));
      } else {
        // ResizeObserver delivers the initial host dimensions before paint.
        // Reading client geometry immediately after appending the grid forces
        // style and layout during the navigation click task, so only use the
        // synchronous path in environments that cannot observe the host.
        layoutGrid(host.clientWidth, host.clientHeight);
      }

      appliedRevisionRef.current = gridRevision;
    } else if (appliedRevisionRef.current !== gridRevision) {
      // Same grid instance, mutated topology: relayout so new/removed
      // leaves get their boxes without waiting for a host resize.
      appliedRevisionRef.current = gridRevision;
      layoutGrid(host.clientWidth, host.clientHeight);
    }
  }, [grid, gridRevision]);

  useLayoutEffect(() => {
    return (): void => {
      detachGrid();
    };
  }, []);

  // Arming observer for the root-edge zones: a counter-based
  // DragAndDropObserver on the host root (every group body, tab strip, and
  // strip is inside it, so their drag events bubble here). The strips only
  // exist in the DOM while armed, so they can never swallow pointer events
  // outside a drag.
  useEffect(() => {
    const host = hostRef.current;

    if (!host) {
      return undefined;
    }

    const disarm = (): void => {
      hoveredRootEdgeRef.current = null;
      setRootDragArmed(false);
      setRootDropEdge(null);
    };

    const observer = new DragAndDropObserver(host, {
      onDragEnter: (): void => {
        if (hasActivePanelTabDrag()) {
          setRootDragArmed(true);
        }
      },
      onDragOver: (): void => {
        // dragover only re-arms (same-value setState bails out); per-strip
        // hover classification lives on the strip elements themselves.
        if (hasActivePanelTabDrag()) {
          setRootDragArmed(true);
        }
      },
      onDragLeave: disarm,
      onDragEnd: disarm,
      // Non-root drops are handled by their targets (group bodies and tab
      // strips, whose own native observers run as the event bubbles). A
      // ROOT-EDGE drop is handled HERE, at a level that receives the event
      // no matter which element native hit-testing resolved under the
      // pointer: while a strip is hovered (`hoveredRootEdgeRef`), the drop
      // dispatches the root-edge intent even if it targeted a decorative
      // layer above the strip. Consuming the transfer here also makes the
      // strip's own (later, React-delegated) drop handler a no-op, so the
      // intent never double-fires.
      onDrop: (event): void => {
        const edge = hoveredRootEdgeRef.current;
        disarm();

        if (edge === null) {
          return;
        }

        event.preventDefault();
        const dragged = readPanelTabDrag();

        if (!dragged) {
          return;
        }

        clearPanelTabDrag();
        callbacksRef.current.onMovePanelToRootEdge?.(dragged.panelId, edge);
      },
    });

    return (): void => {
      observer.dispose();
    };
  }, []);

  // Root-edge drops are only offered when the layout owner implements the
  // intent (e.g. auxiliary-window layouts omit it and render no strips).
  const supportsRootEdgeDrops = callbacks.onMovePanelToRootEdge !== undefined;

  // Backstop for the HOST observer's drop handling (which normally runs
  // first, as the native event bubbles, and consumes the transfer): if the
  // host listener somehow did not handle the drop, the strip's own React
  // handler still dispatches the intent.
  const handleRootEdgeDrop = (
    event: ReactDragEvent<HTMLDivElement>,
    edge: PanelRootDropEdge,
  ): void => {
    event.preventDefault();
    // Keep the (bubbled) drop away from any other React handler: within its
    // own bounds a root strip always wins.
    event.stopPropagation();
    hoveredRootEdgeRef.current = null;
    setRootDragArmed(false);
    setRootDropEdge(null);

    const dragged = readPanelTabDrag();

    if (!dragged) {
      return;
    }

    clearPanelTabDrag();
    callbacksRef.current.onMovePanelToRootEdge?.(dragged.panelId, edge);
  };

  // While a drag is armed, suppress the strips for edges whose drop the
  // layout owner reports as a no-op (`canDropPanelAtRootEdge`, e.g. the
  // dragged panel already IS the sole root-level group at that edge): a
  // full-edge highlight whose release then silently changes nothing is a
  // lying affordance. With the strip absent, the band falls through to the
  // group-body edge zones underneath. Absent predicate = every edge offered.
  const draggedTab = rootDragArmed ? readPanelTabDrag() : null;
  const droppableRootEdges = ROOT_DROP_EDGES.filter(
    (edge) =>
      draggedTab === null ||
      (callbacks.canDropPanelAtRootEdge?.(draggedTab.panelId, edge) ?? true),
  );

  const rootDropZones =
    supportsRootEdgeDrops && rootDragArmed
      ? droppableRootEdges.map((edge) => (
          <div
            key={edge}
            className={`canopy-panel-root-drop-zone canopy-panel-root-drop-zone-${edge}`}
            data-testid={`panel-drop-zone-root-${edge}`}
            data-edge={edge}
            onDragEnter={(event): void => {
              event.preventDefault();
              if (hasActivePanelTabDrag()) {
                setHoveredRootEdge(edge);
              }
            }}
            onDragOver={(event): void => {
              event.preventDefault();
              if (hasActivePanelTabDrag()) {
                setHoveredRootEdge(edge);
              }
            }}
            onDragLeave={(): void => {
              if (hoveredRootEdgeRef.current === edge) {
                hoveredRootEdgeRef.current = null;
              }
              setRootDropEdge((current) => (current === edge ? null : current));
            }}
            onDrop={(event): void => {
              handleRootEdgeDrop(event, edge);
            }}
          />
        ))
      : null;

  const rootDropOverlay =
    supportsRootEdgeDrops &&
    rootDragArmed &&
    rootDropEdge !== null &&
    droppableRootEdges.includes(rootDropEdge) ? (
      <div
        className={`canopy-panel-root-drop-overlay canopy-panel-root-drop-overlay-${rootDropEdge}`}
        data-testid="panel-drop-overlay-root"
        data-edge={rootDropEdge}
        aria-hidden="true"
      />
    ) : null;

  // What the host's per-group factories give each group, built once per
  // group list and factory. `PanelGroup` is memoized: handed a new add-tab
  // descriptor, accessory or chrome object on every render of this host, each
  // group, its tab bar and every tab rendered again whenever anything above
  // the grid did, with nothing of theirs changed.
  const groupParts = useMemo(
    () =>
      new Map(
        layout.groups.map((group) => [
          group.groupId,
          {
            canPopOut: canPopOutGroup?.(group) ?? false,
            fixedTopologyChrome: fixedTopologyChromeForGroup?.(group),
            addTab: addTabForGroup?.(group),
            tabStripAccessory: tabStripAccessoryForGroup?.(group),
            emptyContent:
              group.tabs.length === 0
                ? emptyContentForGroup?.(group)
                : undefined,
          },
        ]),
      ),
    [
      layout.groups,
      canPopOutGroup,
      fixedTopologyChromeForGroup,
      addTabForGroup,
      tabStripAccessoryForGroup,
      emptyContentForGroup,
    ],
  );

  const hasMultipleGroups = layout.groups.length > 1;
  const groupById = new Map(
    layout.groups.map((group) => [group.groupId, group]),
  );
  const branchRemoteControls =
    typeof document === 'undefined' || layout.maximizedGroupId !== null
      ? null
      : gridController.getCollapsedBranches?.().map((branch) =>
          createPortal(
            <PanelBranchCollapsedBar
              groups={branch.groupIds.flatMap((id) => {
                const group = groupById.get(id);
                return group === undefined ? [] : [group];
              })}
              edge={branch.edge}
              callbacks={callbacks}
              renderTabIcon={renderCollapsedTabIcon ?? renderTabIcon}
              getTabTitle={getTabTitle}
              isTabTitlePrivate={isTabTitlePrivate}
              renderTabAccessibleStatus={renderTabAccessibleStatus}
              renderTabTooltip={renderTabTooltip}
            />,
            branch.element,
            `branch-${branch.groupIds[0]}`,
          ),
        );

  const groupRemoteControls =
    typeof document === 'undefined'
      ? null
      : layout.groups.map((group) => {
          const leafElement = gridController.getLeafElement(group.groupId);

          if (!leafElement) {
            return null;
          }

          const isActiveGroup = group.groupId === layout.activeGroupId;
          const isMaximized = group.groupId === layout.maximizedGroupId;
          const isGroupVisible =
            layout.maximizedGroupId === null || isMaximized;
          const parts = groupParts.get(group.groupId);

          return createPortal(
            <PanelGroup
              group={group}
              isActiveGroup={isActiveGroup}
              isMaximized={isMaximized}
              isGroupVisible={isGroupVisible}
              hasMultipleGroups={hasMultipleGroups}
              callbacks={callbacks}
              renderPanelContent={renderPanelContent}
              getPanelContentElement={getPanelContentElement}
              chrome={chromeLabels}
              canPopOut={parts?.canPopOut ?? false}
              fixedTopology={fixedTopology}
              fixedTopologyChrome={parts?.fixedTopologyChrome}
              renderTabIcon={renderTabIcon}
              renderCollapsedTabIcon={renderCollapsedTabIcon}
              renderTabLabel={renderTabLabel}
              onTabIntent={onTabIntent}
              getTabTitle={getTabTitle}
              isTabTitlePrivate={isTabTitlePrivate}
              renderTabAccessibleStatus={renderTabAccessibleStatus}
              renderTabTooltip={renderTabTooltip}
              renderTabHoverCard={renderTabHoverCard}
              renderTabTrailing={renderTabTrailing}
              renderTabAttention={renderTabAttention}
              canCloseTab={canCloseTab}
              tabStyle={tabStyle}
              addTab={parts?.addTab}
              tabStripAccessory={parts?.tabStripAccessory}
              emptyContent={parts?.emptyContent}
              onTabContextMenu={onTabContextMenu}
            />,
            leafElement,
            group.groupId,
          );
        });

  return (
    <div
      ref={hostRef}
      className={
        className
          ? `canopy-panel-grid-host ${className}`
          : 'canopy-panel-grid-host'
      }
      data-testid="panel-grid-root"
      data-window={windowLabel ?? 'main'}
    >
      {groupRemoteControls}
      {branchRemoteControls}
      {rootDropOverlay}
      {rootDropZones}
    </div>
  );
}
