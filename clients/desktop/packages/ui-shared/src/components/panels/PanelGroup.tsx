import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type NamedExoticComponent,
  type ReactNode,
} from 'react';
import type { IDisposable } from '../../panels/disposable';
import { DragAndDropObserver } from '../../panels/dnd-observer';
import { PANEL_CONTENT_ADOPTED_EVENT } from '../../panels/panel-content-adoption';
import {
  computeDropTarget,
  type DropTargetResult,
} from '../../panels/drop-geometry';
import { scheduleWindowAnimationFrame } from '../../panels/window-registry';
import type {
  PanelContentProps,
  PanelDropEdge,
  PanelGroupModel,
  PanelIntentCallbacks,
  PanelTabModel,
} from '../../panels/registry-types';
import { Button } from '../Button';
import {
  DEFAULT_PANEL_CHROME_LABELS,
  PanelChrome,
  type PanelChromeLabels,
} from './PanelChrome';
import { PanelAddPanelButton } from './PanelAddPanelButton';
import { PanelCollapsedBar } from './PanelCollapsedBar';
import {
  clearPanelTabDrag,
  dropDirectionToDropEdge,
  hasActivePanelTabDrag,
  readPanelTabDrag,
} from './panel-dnd';
import { PanelDropOverlay } from './PanelDropOverlay';
import {
  PanelTabBar,
  type PanelTabBarAddTab,
  type PanelTabBarProps,
  type PanelTabStyle,
} from './PanelTabBar';

export interface PanelGroupProps {
  group: PanelGroupModel;
  /** Whether this group is the layout's active (focused) group. */
  isActiveGroup: boolean;
  /** Whether this group is currently maximized. */
  isMaximized: boolean;
  /**
   * Whether this group is shown at all: `true` when no group is maximized or
   * this group is the maximized one. Drives each tab's
   * {@link PanelContentProps.isVisible}.
   */
  isGroupVisible: boolean;
  /**
   * Whether the layout has more than one group; gates the close and
   * maximize affordances (closing the last root group is disabled, and
   * maximize needs at least two groups).
   */
  hasMultipleGroups: boolean;
  callbacks: PanelIntentCallbacks;
  /** Renders one panel's content (typically the app registry's `render`). */
  renderPanelContent: (props: PanelContentProps) => ReactNode;
  /**
   * Content adoption mode (the no-remount handoff, doc 10 A5/A6): when
   * provided, each tab body wrapper does NOT render {@link renderPanelContent}
   * inline. Instead it ADOPTS the app-owned stable container element for its
   * panel (`appendChild`), and on unmount/tab-removal detaches it WITHOUT
   * destroying its subtree. The app renders content into those containers
   * exactly once (e.g. via a portal root), so the content DOM — and its React
   * subtree — survives every move: across groups, layouts, and OS windows.
   *
   * Contract:
   * - The function must be referentially stable and should get-or-create the
   *   container (a `null` return renders an empty tab body permanently — the
   *   adopter does not poll).
   * - Containers must be created in the OPENER realm (doc 13 rule) so
   *   cross-document adoption into auxiliary windows preserves prototypes.
   * - Adoption is idempotent and last-adopter-wins: `appendChild` moves the
   *   node atomically, and a stale adopter's cleanup only detaches the
   *   container when it is still the container's parent — it never steals the
   *   node from a newer adopter.
   */
  getPanelContentElement?: (panelId: string) => HTMLElement | null;
  /** Chrome copy override; defaults to neutral English labels. */
  chrome?: PanelChromeLabels;
  /** Whether the pop-out affordance may render for this group. */
  canPopOut?: boolean;
  /** Hides topology-editing chrome for layouts whose group structure is fixed. */
  fixedTopology?: boolean;
  /** Direct Full screen/Hide chrome for one fixed-topology group. */
  fixedTopologyChrome?: { hideLabel: string };
  /** Optional per-tab icon renderer, forwarded to the tab bar. */
  renderTabIcon?: (tab: PanelTabModel) => ReactNode;
  /**
   * Optional per-tab icon renderer used ONLY by the collapsed icon bar. Lets
   * the app render an activity-aware icon (e.g. a pulsing tint) while a group
   * is collapsed without altering the expanded tab bar's leading icon. Falls
   * back to {@link renderTabIcon} when omitted.
   */
  renderCollapsedTabIcon?: (tab: PanelTabModel) => ReactNode;
  /** Optional per-tab label renderer, forwarded to the tab bar. */
  renderTabLabel?: (tab: PanelTabModel) => ReactNode;
  /** Forwarded unchanged to each tab header. */
  onTabIntent?: PanelTabBarProps['onTabIntent'];
  /** Plain-string title resolver for tooltips + close-button accessible names. */
  getTabTitle?: (tab: PanelTabModel) => string;
  renderTabAccessibleStatus?: (tab: PanelTabModel) => ReactNode;
  /** Persistent attention remains visible when a fill tab shrinks to its icon. */
  renderTabAttention?: (tab: PanelTabModel) => ReactNode;
  /**
   * Optional per-tab RICH tooltip renderer, forwarded to the tab bar AND the
   * collapsed icon bar. A non-null result replaces the plain/native tooltip
   * for that tab in every presentation (normal, pinned, collapsed).
   */
  renderTabTooltip?: (tab: PanelTabModel) => ReactNode | null;
  /**
   * Optional per-tab hover card for background tabs, forwarded to the tab
   * bar only; see {@link PanelTabBarProps.renderTabHoverCard}.
   */
  renderTabHoverCard?: (tab: PanelTabModel) => ReactNode | null;
  /** Optional per-tab trailing renderer, forwarded to the tab bar. */
  renderTabTrailing?: (tab: PanelTabModel) => ReactNode;
  /** Forwarded to {@link PanelTabBar}; omitted means every tab is closable. */
  canCloseTab?: (tab: PanelTabModel) => boolean;
  /** Optional add-tab affordance, forwarded to the tab bar. */
  addTab?: PanelTabBarAddTab;
  /** How the tab bar lays out its tabs, forwarded to it. */
  tabStyle?: PanelTabStyle;
  /**
   * Optional app-owned node rendered in the title bar between the tab strip
   * and the group chrome (e.g. the desktop archived-chats control on chat
   * groups). Only rendered while the group is expanded.
   */
  tabStripAccessory?: ReactNode;
  /**
   * Optional app-owned content for the group while it has no tabs, in place
   * of the generic "no panels" message (desktop: the Side Panel's list of
   * what can be opened there).
   */
  emptyContent?: ReactNode;
  /**
   * Optional tab right-click handler, forwarded to the tab bar. The app builds
   * the actual context menu (pin/unpin, close, close others/right/left/all).
   */
  onTabContextMenu?: (
    groupId: string,
    panelId: string,
    clientX: number,
    clientY: number,
  ) => void;
}

interface AdoptedPanelTabContentProps {
  panelId: string;
  kind: string;
  hidden: boolean;
  getPanelContentElement: (panelId: string) => HTMLElement | null;
}

/**
 * One tab body wrapper in content-adoption mode: instead of rendering content
 * inline, it adopts the app-owned stable container for `panelId` into itself
 * (`appendChild` — which also works cross-document for auxiliary windows) and
 * detaches it on unmount WITHOUT touching the container's subtree.
 *
 * Ordering guarantee (the move hazard): when a panel moves between two
 * adopters, React may run the new adopter's mount before the old adopter's
 * cleanup (e.g. across separate commits, or effect scheduling differences).
 * `appendChild` moves the node atomically, so the LAST adopter always wins;
 * the cleanup's `parentElement === wrapper` guard makes a stale cleanup a
 * no-op instead of detaching the container from its NEW parent.
 */
const AdoptedPanelTabContent = memo(function AdoptedPanelTabContent({
  panelId,
  kind,
  hidden,
  getPanelContentElement,
}: AdoptedPanelTabContentProps): JSX.Element {
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Layout effect so adoption commits in the same frame as the wrapper's DOM
  // insertion (no flash of empty tab body). Deps are the panel identity and
  // the (stable) getter — hidden toggles must NOT re-run adoption.
  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;

    if (!wrapper) {
      return undefined;
    }

    const container = getPanelContentElement(panelId);

    if (!container) {
      return undefined;
    }

    // Idempotent adopt: re-appending an already-adopted child would still
    // detach/re-insert it in the DOM, so skip when we are already the parent.
    if (container.parentElement !== wrapper) {
      wrapper.appendChild(container);
      // The move reset every scroll offset inside the container. Let content
      // that owns its scroll position reapply it before the next paint.
      const EventConstructor = container.ownerDocument.defaultView?.Event;
      if (EventConstructor) {
        container.dispatchEvent(
          new EventConstructor(PANEL_CONTENT_ADOPTED_EVENT),
        );
      }
    }

    return (): void => {
      // Detach WITHOUT destroying: the container's subtree belongs to the
      // app's content root (portal target) and must survive the detach. The
      // parent check keeps a stale cleanup from stealing the container after
      // a newer adopter has already moved it (last-adopter-wins).
      if (container.parentElement === wrapper) {
        container.remove();
      }
    };
  }, [panelId, getPanelContentElement]);

  return (
    <div
      ref={wrapperRef}
      className="canopy-panel-content"
      data-panel-kind={kind}
      hidden={hidden}
    />
  );
});

/**
 * Whether `element` is a vertical scroller whose top meets the title strip
 * (within 4px of the group body's top), so content scrolling in it passes
 * under the strip.
 */
function scrollerMeetsTitleStrip(element: Element, body: Element): boolean {
  if (element.scrollHeight <= element.clientHeight + 1) return false;
  return (
    element.getBoundingClientRect().top - body.getBoundingClientRect().top < 4
  );
}

/** Upper bound on the elements one title-edge measurement visits. */
const TITLE_EDGE_SCAN_LIMIT = 400;

/**
 * Whether any rendered scroller meeting the title strip is scrolled down.
 * Walks only rendered elements whose top meets the strip: a scroller that
 * meets it has only such ancestors inside the body, so the walk stays near
 * the top of the content instead of visiting a whole transcript.
 *
 * Elements are read through the `Element` interface only, never checked with
 * `instanceof`: content in a popped-out panel window comes from that
 * window's realm, where the opener's constructors do not match.
 */
function isTitleStripScrollerScrolled(body: HTMLElement): boolean {
  const bodyTop = body.getBoundingClientRect().top;
  const queue: Element[] = Array.from(body.children);
  let visited = 0;
  while (queue.length > 0 && visited < TITLE_EDGE_SCAN_LIMIT) {
    const element = queue.shift();
    if (element === undefined) break;
    visited += 1;
    // Hidden (inactive) tab content does not count.
    if (element.hasAttribute('hidden')) continue;
    if (element.getClientRects().length === 0) {
      // A `display: contents` wrapper has no box of its own, but its
      // children do; anything else without boxes is not rendered.
      const view = element.ownerDocument.defaultView;
      if (view?.getComputedStyle(element).display === 'contents') {
        queue.push(...Array.from(element.children));
      }
      continue;
    }
    if (element.getBoundingClientRect().top - bodyTop >= 4) continue;
    if (scrollerMeetsTitleStrip(element, body) && element.scrollTop > 0) {
      return true;
    }
    queue.push(...Array.from(element.children));
  }
  return false;
}

/**
 * One tabbed grid leaf: a title bar (tab strip + chrome actions) above a body
 * that keeps EVERY tab's content mounted, hiding non-active tabs with the
 * `hidden` attribute so switching tabs never remounts content.
 *
 * Drop target (Phase 6): the group BODY owns the edge/center drop-overlay
 * wiring — the body (not the whole group) so the tab strip keeps its own
 * insertion-indicator drop handling, mirroring VS Code's overlay offset that
 * excludes the tab strip. A {@link DragAndDropObserver} on the body element
 * (counter-based enter/leave, `preventDefault`ed dragover so `drop` fires)
 * classifies the pointer via {@link computeDropTarget} — throttled to one
 * computation per animation frame — and drives the {@link PanelDropOverlay}.
 * Drops read the in-process transfer singleton and dispatch
 * `callbacks.onMovePanel` with the mapped {@link PanelDropEdge}.
 *
 * The group root intentionally does NOT carry `data-orientation`: the parent
 * branch orientation lives in the imperative grid tree and is not part of
 * {@link PanelGroupModel}, so it is not cheaply available here. Specs that
 * need tree shape should assert on serialized grid data instead.
 */
function PanelGroupComponent({
  group,
  isActiveGroup,
  isMaximized,
  isGroupVisible,
  hasMultipleGroups,
  callbacks,
  renderPanelContent,
  getPanelContentElement,
  chrome,
  canPopOut,
  fixedTopology = false,
  fixedTopologyChrome,
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
  canCloseTab,
  addTab,
  tabStyle,
  tabStripAccessory,
  emptyContent,
  onTabContextMenu,
}: PanelGroupProps): JSX.Element {
  // Collapse state (Phase 8): `collapsedEdge` drives the icon-bar swap and
  // content visibility; `chromeCollapse` is the chrome's direct-button prop,
  // suppressed while already collapsed, maximized, or the affordance is
  // absent/'none'.
  const collapsedEdge = group.collapsed?.edge ?? null;
  const affordance = group.collapseAffordance;
  const chromeCollapse =
    !isMaximized &&
    collapsedEdge === null &&
    affordance !== undefined &&
    affordance.state !== 'none'
      ? {
          edge:
            affordance.state === 'enabled'
              ? (affordance.branchEdge ?? affordance.edge)
              : affordance.edge,
          blocked: affordance.state === 'blocked',
          branch:
            affordance.state === 'enabled' &&
            affordance.branchEdge !== undefined,
        }
      : null;

  // Bound wrappers (not bare method references) so the intent methods are
  // always invoked on the callbacks object, and stable across re-renders for
  // the memoized tab bar.
  const handleSelectTab = useCallback(
    (tabGroupId: string, panelId: string): void => {
      callbacks.onSelectTab(tabGroupId, panelId);
    },
    [callbacks],
  );
  const handleCloseTab = useCallback(
    (tabGroupId: string, panelId: string): void => {
      callbacks.onCloseTab(tabGroupId, panelId);
    },
    [callbacks],
  );
  const handleReorderTab = useCallback(
    (tabGroupId: string, panelId: string, toIndex: number): void => {
      callbacks.onReorderTab?.(tabGroupId, panelId, toIndex);
    },
    [callbacks],
  );
  const handleMovePanel = useCallback<PanelIntentCallbacks['onMovePanel']>(
    (panelId, targetGroupId, edge, targetIndex): void => {
      callbacks.onMovePanel(panelId, targetGroupId, edge, targetIndex);
    },
    [callbacks],
  );

  const canMovePanelHere = useCallback(
    (panelId: string, targetGroupId: string): boolean =>
      callbacks.canDropPanel?.(panelId, targetGroupId, 'center') !== false,
    [callbacks],
  );

  // Body drop-target state: whether a drag is over the body (overlay
  // visibility) and the latest pointer classification (highlight box).
  const rootRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [isDragOverBody, setIsDragOverBody] = useState(false);
  const [dropTarget, setDropTarget] = useState<DropTargetResult | null>(null);

  // Fill tabs (early access) draw the title strip's divider only while the
  // content under it is scrolled: a list at its top needs no edge. Only a
  // vertical scroller that meets the strip counts, so an inset surface
  // scrolling inside the content (an inset card) does not.
  //
  // Showing a tab, expanding a collapsed group, or turning tracking on fires
  // no scroll event, and hidden content keeps its scroll offset, so the edge
  // is measured from the visible content then rather than assumed to be at
  // the top. Adopted content reapplies its own scroll offset after the move,
  // so it is measured again on the next frame. Scrolls are measured the same
  // way, at most once a frame, rather than from the event's target.
  const tracksTitleEdge = tabStyle === 'fill';
  const [contentScrolled, setContentScrolled] = useState(false);
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!tracksTitleEdge || body === null) return undefined;
    // Set before the frame is requested and cleared by its callback, so it
    // stays correct where the frame runs synchronously (no rAF).
    let frameScheduled = false;
    let scheduledFrame: IDisposable | null = null;
    const measure = (): void => {
      setContentScrolled(isTitleStripScrollerScrolled(body));
    };
    const measureNextFrame = (): void => {
      // Coalesce: one pending measurement serves every event until it runs.
      if (frameScheduled) return;
      frameScheduled = true;
      scheduledFrame = scheduleWindowAnimationFrame(body, () => {
        frameScheduled = false;
        measure();
      });
    };
    measure();
    measureNextFrame();
    body.addEventListener('scroll', measureNextFrame, {
      capture: true,
      passive: true,
    });
    // Not a bubbling event: listen in the capture phase.
    body.addEventListener(PANEL_CONTENT_ADOPTED_EVENT, measureNextFrame, {
      capture: true,
    });
    return (): void => {
      scheduledFrame?.dispose();
      body.removeEventListener('scroll', measureNextFrame, { capture: true });
      body.removeEventListener(PANEL_CONTENT_ADOPTED_EVENT, measureNextFrame, {
        capture: true,
      });
    };
  }, [tracksTitleEdge, group.activePanelId, collapsedEdge]);

  // Latest-render snapshot so the one-shot observer sees current values.
  const dropSnapshotRef = useRef({ group, callbacks });
  dropSnapshotRef.current = { group, callbacks };

  useEffect(() => {
    if (fixedTopology) {
      setIsDragOverBody(false);
      setDropTarget(null);
      return undefined;
    }
    // The body is `display: none` while collapsed (CSS `[data-collapsed]`
    // rule) and cannot receive drag events, so the collapse-bar sibling
    // takes over as the drop target — attach the SAME observer wiring to the
    // group root instead of the body. `enableSplitting: false` collapses the
    // edge thresholds to 0 so every drop classifies as `center` (merge-only;
    // a collapsed group cannot be split), matching Task 5's `collapsedEdge`
    // gate on `onMovePanel`.
    const target = collapsedEdge !== null ? rootRef.current : bodyRef.current;

    if (!target) {
      return undefined;
    }

    const classifyAt = (clientX: number, clientY: number): DropTargetResult => {
      const rect = target.getBoundingClientRect();

      return computeDropTarget(
        { width: rect.width, height: rect.height },
        { x: clientX - rect.left, y: clientY - rect.top },
        collapsedEdge !== null ? { enableSplitting: false } : undefined,
      );
    };

    // dragover fires continuously; throttle geometry + state updates to one
    // per animation frame. Frames are scheduled on the window OWNING the
    // body element (window registry) so throttling tracks the right window
    // once groups render inside auxiliary windows; the helper falls back to
    // synchronous invocation where rAF is unavailable (minimal test
    // environments). `frameScheduled` is set BEFORE requesting the frame and
    // cleared by the callback, so the logic stays correct even when rAF
    // invokes synchronously (test mocks, the sync fallback).
    const dropAccepted = (edge: PanelDropEdge): boolean => {
      const dragged = readPanelTabDrag();
      const { group: currentGroup, callbacks: currentCallbacks } =
        dropSnapshotRef.current;
      return (
        dragged === null ||
        currentCallbacks.canDropPanel?.(
          dragged.panelId,
          currentGroup.groupId,
          edge,
        ) !== false
      );
    };

    let scheduledFrame: IDisposable | null = null;
    let frameScheduled = false;
    let pendingPointer: { x: number; y: number } | null = null;

    const applyPendingClassification = (): void => {
      frameScheduled = false;

      if (!pendingPointer) {
        return;
      }

      const result = classifyAt(pendingPointer.x, pendingPointer.y);
      pendingPointer = null;
      // A move the layout owner would refuse gets no highlight.
      if (!dropAccepted(dropDirectionToDropEdge(result.direction))) {
        setDropTarget(null);
        return;
      }
      // Overlay boxes are direction-determined; keep the previous object
      // when the direction is unchanged so memoized children skip work.
      setDropTarget((previous) =>
        previous !== null && previous.direction === result.direction
          ? previous
          : result,
      );
    };

    const cancelPendingClassification = (): void => {
      pendingPointer = null;
      frameScheduled = false;
      scheduledFrame?.dispose();
      scheduledFrame = null;
    };

    const clearDropFeedback = (): void => {
      cancelPendingClassification();
      setIsDragOverBody(false);
      setDropTarget(null);
    };

    const observer = new DragAndDropObserver(target, {
      onDragEnter: (): void => {
        if (hasActivePanelTabDrag()) {
          setIsDragOverBody(true);
        }
      },
      onDragOver: (event): void => {
        // The observer already preventDefault()ed (so `drop` will fire);
        // only classify/render feedback for in-process panel-tab drags.
        if (!hasActivePanelTabDrag()) {
          return;
        }

        setIsDragOverBody(true);
        pendingPointer = { x: event.clientX, y: event.clientY };

        if (!frameScheduled) {
          frameScheduled = true;
          scheduledFrame = scheduleWindowAnimationFrame(
            target,
            applyPendingClassification,
          );
        }
      },
      onDragLeave: (): void => {
        clearDropFeedback();
      },
      onDragEnd: (): void => {
        clearDropFeedback();
      },
      onDrop: (event): void => {
        clearDropFeedback();

        const dragged = readPanelTabDrag();

        if (!dragged) {
          return;
        }

        clearPanelTabDrag();

        // Classify from the drop's own coordinates (never the throttled
        // state, which can lag the pointer by a frame).
        const { direction } = classifyAt(event.clientX, event.clientY);
        const edge = dropDirectionToDropEdge(direction);
        const { group: currentGroup, callbacks: currentCallbacks } =
          dropSnapshotRef.current;

        // Dropping a group's only tab onto its own center cannot change the
        // layout — skip the intent entirely.
        if (
          edge === 'center' &&
          dragged.sourceGroupId === currentGroup.groupId &&
          currentGroup.tabs.length === 1
        ) {
          return;
        }

        if (
          currentCallbacks.canDropPanel?.(
            dragged.panelId,
            currentGroup.groupId,
            edge,
          ) === false
        ) {
          return;
        }

        currentCallbacks.onMovePanel(
          dragged.panelId,
          currentGroup.groupId,
          edge,
        );
      },
    });

    return (): void => {
      cancelPendingClassification();
      observer.dispose();
    };
    // Reattaches (root <-> body) when the group's collapsed state flips.
  }, [collapsedEdge, fixedTopology]);

  return (
    <div
      ref={rootRef}
      className="canopy-panel-group"
      data-testid={`panel-group-${group.groupId}`}
      data-group-id={group.groupId}
      data-active={isActiveGroup ? 'true' : 'false'}
      data-collapsed={collapsedEdge ?? undefined}
      data-title-edge={
        tracksTitleEdge ? (contentScrolled ? 'scrolled' : 'top') : undefined
      }
      // Capture-phase so any mousedown anywhere inside the group (tabs,
      // chrome, or content) focuses the group before the target handles it.
      onMouseDownCapture={(): void => {
        callbacks.onFocusGroup(group.groupId);
      }}
    >
      {/* Title chrome renders only while expanded. When collapsed, the same
          controls (add, layout menu, toggle) move into the collapse bar
          below; keeping them here too would double the
          `panel-group-menu`/`panel-add-tab` test ids in the DOM. The body (content) is unaffected and stays
          mounted, so the no-remount invariant holds. */}
      {collapsedEdge === null ? (
        <div
          className="canopy-panel-group-title"
          data-testid={`panel-group-title-${group.groupId}`}
        >
          <PanelTabBar
            groupId={group.groupId}
            tabs={group.tabs}
            activePanelId={group.activePanelId}
            onSelectTab={handleSelectTab}
            onCloseTab={handleCloseTab}
            onReorderTab={handleReorderTab}
            // A fixed layout keeps every tab in its own group: tabs still
            // reorder within the strip, but never move to another group.
            onMovePanel={fixedTopology ? undefined : handleMovePanel}
            canMovePanelHere={canMovePanelHere}
            renderTabIcon={renderTabIcon}
            renderTabLabel={renderTabLabel}
            onTabIntent={onTabIntent}
            getTabTitle={getTabTitle}
            renderTabAccessibleStatus={renderTabAccessibleStatus}
            renderTabTooltip={renderTabTooltip}
            renderTabHoverCard={renderTabHoverCard}
            renderTabTrailing={renderTabTrailing}
            renderTabAttention={renderTabAttention}
            canCloseTab={canCloseTab}
            addTab={addTab}
            tabStyle={tabStyle}
            onTabContextMenu={onTabContextMenu}
          />
          {addTab?.addPanel ? (
            <PanelAddPanelButton
              groupId={group.groupId}
              addPanel={addTab.addPanel}
            />
          ) : null}
          {tabStripAccessory}
          {fixedTopology && fixedTopologyChrome !== undefined ? (
            <PanelChrome
              groupId={group.groupId}
              isMaximized={isMaximized}
              hasMultipleGroups={hasMultipleGroups}
              callbacks={callbacks}
              labels={chrome}
              minimal={fixedTopologyChrome}
              tabStyle={tabStyle}
            />
          ) : !fixedTopology ? (
            <PanelChrome
              groupId={group.groupId}
              isMaximized={isMaximized}
              hasMultipleGroups={hasMultipleGroups}
              callbacks={callbacks}
              labels={chrome}
              canPopOut={canPopOut}
              collapse={chromeCollapse}
              tabStyle={tabStyle}
            />
          ) : null}
        </div>
      ) : null}
      <div
        ref={bodyRef}
        className="canopy-panel-group-body"
        data-testid={`panel-group-body-${group.groupId}`}
      >
        {group.tabs.length === 0 && emptyContent !== undefined ? (
          <div
            className="flex h-full min-h-0 flex-col"
            data-testid={`panel-empty-group-${group.groupId}`}
          >
            {emptyContent}
          </div>
        ) : group.tabs.length === 0 ? (
          <div
            className="flex h-full min-h-0 flex-col items-center justify-center gap-3 px-6 text-center"
            data-testid={`panel-empty-group-${group.groupId}`}
          >
            <p className="fg-secondary text-s">
              {chrome?.emptyGroup ??
                DEFAULT_PANEL_CHROME_LABELS.emptyGroup ??
                'No panels in this group'}
            </p>
            <div className="flex items-center gap-2">
              {addTab ? (
                // Toggle-only: the menu node itself is mounted exactly once,
                // by the tab bar's add button (its anchored wrapper) — the
                // same open state serves both triggers. Rendering
                // `addTab.menu` here too would double-portal the menu.
                <Button
                  size="sm"
                  data-testid={`panel-empty-group-add-${group.groupId}`}
                  aria-haspopup="menu"
                  aria-expanded={addTab.menu !== undefined}
                  onClick={(): void => {
                    addTab.onAddTab(group.groupId);
                  }}
                >
                  {addTab.label}
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                data-testid={`panel-empty-group-close-${group.groupId}`}
                disabled={!hasMultipleGroups}
                onClick={(): void => {
                  callbacks.onCloseGroup(group.groupId);
                }}
              >
                {chrome?.closeGroup ??
                  DEFAULT_PANEL_CHROME_LABELS.closeGroup ??
                  'Close group'}
              </Button>
            </div>
          </div>
        ) : null}
        {/* Tabs hidden for another chat keep their body (hidden, not
            unmounted), so a page or preview survives switching chats. */}
        {[...group.tabs, ...(group.hiddenTabs ?? [])].map((tab) => {
          const isActiveTab = tab.panelId === group.activePanelId;

          // Adoption mode: the wrapper adopts the app-owned container; the
          // app's content root computes isActive/isVisible and renders the
          // content into the container exactly once, so moving a tab across
          // groups/layouts/windows never remounts its DOM.
          if (getPanelContentElement) {
            return (
              <AdoptedPanelTabContent
                key={tab.panelId}
                panelId={tab.panelId}
                kind={tab.kind}
                hidden={!isActiveTab}
                getPanelContentElement={getPanelContentElement}
              />
            );
          }

          return (
            <div
              key={tab.panelId}
              className="canopy-panel-content"
              data-panel-kind={tab.kind}
              hidden={!isActiveTab}
            >
              {renderPanelContent({
                panelId: tab.panelId,
                kind: tab.kind,
                isActive: isActiveGroup && isActiveTab,
                isVisible:
                  isActiveTab && isGroupVisible && collapsedEdge === null,
              })}
            </div>
          );
        })}
        <PanelDropOverlay
          groupId={group.groupId}
          direction={dropTarget?.direction ?? null}
          overlayBox={dropTarget?.overlayBox ?? null}
          visible={isDragOverBody}
          // Zones are invisible (transparent, pointer-events: none) but give
          // synthetic-DnD specs stable, addressable per-edge targets.
          showZones={isDragOverBody}
        />
      </div>
      {collapsedEdge !== null && !fixedTopology ? (
        <PanelCollapsedBar
          group={group}
          edge={collapsedEdge}
          isActiveGroup={isActiveGroup}
          hasMultipleGroups={hasMultipleGroups}
          callbacks={callbacks}
          canPopOut={canPopOut}
          chrome={chrome}
          addTab={addTab}
          renderTabIcon={renderCollapsedTabIcon ?? renderTabIcon}
          getTabTitle={getTabTitle}
          renderTabAccessibleStatus={renderTabAccessibleStatus}
          renderTabTooltip={renderTabTooltip}
          tabStripAccessory={tabStripAccessory}
        />
      ) : null}
    </div>
  );
}

export const PanelGroup: NamedExoticComponent<PanelGroupProps> =
  memo(PanelGroupComponent);
