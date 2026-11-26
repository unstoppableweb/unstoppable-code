import { ControlButton } from '../../primitives/Button';
import {
  createContext,
  memo,
  useContext,
  useId,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type HTMLAttributes,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type NamedExoticComponent,
  type ReactNode,
} from 'react';
import {
  ChatIcon,
  CloseMediumIcon,
  PinIcon,
  QuestionMarkIcon,
} from '../../icons/AppIcons';
import { DragAndDropObserver } from '../../panels/dnd-observer';
import { SIDEBAR_INDICATOR_COLORS } from '../../lib/operational-status-colors';
import { useHorizontalOverflowScroll } from '../../lib/useHorizontalOverflowScroll';
import type { PanelDropEdge, PanelTabModel } from '../../panels/registry-types';
import { AgentStateGlyph } from '../AgentStateGlyph';
import { RichHoverTooltip } from '../../primitives/RichHoverTooltip';
import { ThinkingSpinner } from '../../primitives/ThinkingSpinner';
import { Tooltip } from '../../primitives/Tooltip';
import { PanelAddTabButton } from './PanelAddTabButton';
import {
  edgeHintClearance,
  PanelTabEdgeHints,
  useHiddenBusyTabs,
} from './PanelTabEdgeHints';
import { PanelTabListButton, useInPanelTabList } from './PanelTabListButton';
import { usePanelTabStripState } from './usePanelTabStripState';
import {
  clearPanelTabDrag,
  hasActivePanelTabDrag,
  readPanelTabDrag,
  startPanelTabDrag,
} from './panel-dnd';
import { PanelTabLiveReorderContext } from './panel-tab-live-reorder-context';
import { REPLAY_MASK_CLASS } from '../../lib/replay-privacy';

/**
 * The optional add-tab affordance of a group's tab bar. The shared layer is
 * app-agnostic: it only renders the `+` button (and an app-supplied menu
 * node); the app owns what "add" means, which panel kinds exist, and the
 * open/closed state of its menu.
 */
export interface PanelTabBarAddTab {
  /** Accessible label + tooltip copy for the button (app-provided). */
  label: string;
  /** Invoked with the owning group id when the button is clicked. */
  onAddTab: (groupId: string) => void;
  /** Independent one-click chat creation affordance. */
  addChat?: { label: string; onAddChat: (groupId: string) => void };
  /** Independent repeat action for the active Browser or Terminal. */
  quickAdd?: { label: string; onQuickAdd: (groupId: string) => void };
  /** Suppresses the direct primary action when this group is not eligible. */
  hidePrimary?: boolean;
  /**
   * Optional second affordance rendered right after the `+`: opens the
   * app-supplied add-panel menu. Hosts whose `+` performs a direct action
   * (desktop: new chat) use this for everything else.
   */
  addPanel?: {
    /** Accessible label + tooltip copy for the button. */
    label: string;
    /** Invoked with the owning group id when the button is clicked. */
    onAddPanel: (groupId: string) => void;
    /** App-supplied menu node, rendered inside the button's anchored wrapper. */
    menu?: ReactNode;
  };
  /**
   * App-supplied menu, rendered inside the button's anchored wrapper
   * (`position: relative`) while open. Presence means "open" and drives
   * `aria-expanded`; the app owns the state and dismissal behavior.
   */
  menu?: ReactNode;
}

/**
 * - `classic`: underlined tabs at their content width (down to a floor) in a
 *   strip that scrolls horizontally once they overflow.
 * - `fill`: Chrome-style tiles that hug their content while they fit and then
 *   share the row, shrinking down to their icon and further until every tab
 *   fits. The strip never scrolls, so hosts cap how many tabs a user opens
 *   into a row.
 */
export type PanelTabStyle = 'classic' | 'fill';

export interface PanelTabBarProps {
  groupId: string;
  /** Tabs in display order. */
  tabs: readonly PanelTabModel[];
  /** The selected tab of the group, or `null` for an empty group. */
  activePanelId: string | null;
  /** Disables tab drag sources. */
  draggable?: boolean;
  /** Matches {@link PanelIntentCallbacks.onSelectTab}. */
  onSelectTab: (groupId: string, panelId: string) => void;
  /** Matches {@link PanelIntentCallbacks.onCloseTab}. */
  onCloseTab: (groupId: string, panelId: string) => void;
  /** Host-neutral intent to open a tab; never selects or moves focus. */
  onTabIntent?: (
    groupId: string,
    tab: PanelTabModel,
    phase: 'start' | 'end',
    source: 'pointer' | 'focus',
  ) => void;
  /**
   * Whether a tab may be closed from the strip. Omitted means every tab is
   * closable, which is the historical behaviour.
   *
   * Hosts that route closing through their own workflow (the portal closes a
   * bound chat pane via a chat-close command, refusing while the chat is
   * streaming or the session is disconnected) need the control to reflect
   * that. Without it the button rendered enabled and silently did nothing.
   */
  canCloseTab?: (tab: PanelTabModel) => boolean;
  /**
   * Matches {@link PanelIntentCallbacks.onReorderTab}: a same-group tab-strip
   * drop reorders the tab to its final index. Omitted, same-group strip drops
   * do nothing.
   */
  onReorderTab?: (groupId: string, panelId: string, toIndex: number) => void;
  /**
   * Matches {@link PanelIntentCallbacks.onMovePanel}: a cross-group tab-strip
   * drop merges the dragged tab into this group (`edge: 'center'`) at the
   * indicated final index. Omitted, the strip accepts only its own tabs: a
   * tab dragged in from another group shows no insertion indicator.
   */
  onMovePanel?: (
    panelId: string,
    targetGroupId: string,
    edge: PanelDropEdge,
    targetIndex?: number,
  ) => void;
  /**
   * Whether a tab dragged in from another group may merge into this one
   * (matches {@link PanelIntentCallbacks.canDropPanel} for `center`). A
   * refused tab gets no insertion indicator and its drop is ignored.
   * Omitted, every cross-group merge is offered.
   */
  canMovePanelHere?: (panelId: string, targetGroupId: string) => boolean;
  /**
   * Optional per-tab icon (e.g. from the app's panel registry).
   *
   * Hovering a classic tab normally hides this icon and reveals the close
   * button in its slot; a `fill` tab shows the button at its right end
   * instead. An icon that renders a LIVE status glyph (a streaming spinner)
   * sets {@link PANEL_TAB_BUSY_ATTRIBUTE} on itself or a descendant: the
   * close button is then withheld for as long as the work runs (and a classic
   * tab keeps the icon visible on hover). Closing stays available from the
   * tab's context menu.
   */
  renderTabIcon?: (tab: PanelTabModel) => ReactNode;
  /**
   * Optional per-tab label renderer. When provided, its result REPLACES the
   * plain `tab.title` text inside the label wrapper (which keeps the string
   * `title` tooltip attribute either way). Used by apps to render live
   * per-entity labels (dynamic titles, status spinners, unread markers).
   */
  renderTabLabel?: (tab: PanelTabModel) => ReactNode;
  /**
   * Optional per-tab trailing content (e.g. unsaved-changes dot, read-only
   * lock). Classic tabs render it between the label and the close button;
   * `fill` tabs float it in the close button's box, which takes its place on
   * hover. Return nothing (not an empty wrapper) when there is no indicator:
   * `fill` styles reserve the box only while the slot has content.
   */
  renderTabTrailing?: (tab: PanelTabModel) => ReactNode;
  /** Spoken status for icon-only tabs whose explicit title masks descendants. */
  renderTabAccessibleStatus?: (tab: PanelTabModel) => ReactNode;
  /** Persistent attention remains visible when a fill tab shrinks to its icon. */
  renderTabAttention?: (tab: PanelTabModel) => ReactNode;
  /**
   * Optional plain-string title resolver used for the native hover tooltip
   * and the close button's accessible name. Apps provide it so those strings
   * match the friendly labels from {@link renderTabLabel} instead of the raw
   * view-model `tab.title` (which falls back to the panel kind id).
   */
  getTabTitle?: (tab: PanelTabModel) => string;
  /**
   * Whether {@link getTabTitle} returns user-authored text for this tab. The
   * bar then replay-masks every attribute and tooltip that carries it, and a
   * pinned tab takes its accessible name from a masked label instead.
   */
  isTabTitlePrivate?: (tab: PanelTabModel) => boolean;
  /**
   * Optional per-tab RICH tooltip renderer. A non-null result REPLACES the
   * native `title` tooltip for that tab (rendered through the shared
   * {@link Tooltip}, attached to the non-interactive label span so no
   * interactive control nests inside the trigger); `null`/omitted keeps the
   * plain string tooltip. Accessible names and the close button's label
   * still come from {@link getTabTitle}.
   */
  renderTabTooltip?: (tab: PanelTabModel) => ReactNode | null;
  /**
   * Optional per-tab hover CARD: a preview of what a background tab holds.
   * A non-null result replaces that tab's native `title` tooltip (and any
   * {@link renderTabTooltip}) with a card that opens after the pointer rests
   * on the tab, including its close button, hanging below it. Never asked for
   * the active tab, whose content is already on screen, or pinned tabs, which keep
   * their own tooltip. Other unpinned tabs use a shared label tooltip, so
   * crossing the active tab participates in the same handoff. Preview cards
   * stay anchored to their own tabs; the content mounts only while open.
   */
  renderTabHoverCard?: (tab: PanelTabModel) => ReactNode | null;
  /** Optional add-tab affordance; omitted, no `+` button renders. */
  addTab?: PanelTabBarAddTab;
  /** How the tabs lay out; see {@link PanelTabStyle}. Defaults to classic. */
  tabStyle?: PanelTabStyle;
  /**
   * Optional right-click handler for a tab. Fired from a `contextmenu`
   * listener on each tab (default prevented) with the owning group id, the
   * tab's panel id, and the event's viewport coordinates. Kept optional so the
   * shared layer stays app-agnostic: the app builds and positions the actual
   * menu (pin/unpin, close, close others/right/left/all). Omitted, right-click
   * falls through to the platform default.
   */
  onTabContextMenu?: (
    groupId: string,
    panelId: string,
    clientX: number,
    clientY: number,
  ) => void;
}

/**
 * Marker attribute an app-supplied leading icon sets on itself (or a
 * descendant) while its panel is doing live work. Panel CSS reads it through
 * `:has()` to withhold the hover close button while the work runs. Classic
 * tabs also keep the status glyph visible on hover instead of swapping in the
 * close button, so a running tab never loses its only progress signal to a
 * pointer resting on it. See {@link PanelTabBarProps.renderTabIcon}.
 */
export const PANEL_TAB_BUSY_ATTRIBUTE = 'data-panel-tab-busy';

const PanelTabStyleContext = createContext<PanelTabStyle>('classic');

/**
 * The style of the tab bar rendering the caller: app-supplied tab renderers
 * (icon, trailing) read it to match the bar they sit in. Anywhere outside a
 * tab bar, such as a collapsed group's icon strip, it reads `classic`.
 */
export function usePanelTabStyle(): PanelTabStyle {
  return useContext(PanelTabStyleContext);
}

/**
 * A chat tab's glyph in a fill tab bar: while the chat works, the accent
 * spinner, marked busy so the bar withholds its close button; otherwise the
 * chat icon. The icon carries no state: fill tabs show unread, plan review and
 * approval on their right. Desktop and web chat tabs both draw it, so a
 * crowded row reads the same on each. Extra props (unread hooks, test ids)
 * land on the wrapper.
 */
export function PanelFillChatTabGlyph({
  busy,
  ...props
}: {
  readonly busy: boolean;
} & HTMLAttributes<HTMLSpanElement>): JSX.Element {
  const inList = useInPanelTabList();
  if (busy && inList) {
    // In the ⌄ list the row keeps its chat icon; the spinner goes to the
    // row's right-hand status slot (panels.css places it), still marked busy.
    return (
      <span className="inline-flex shrink-0 items-center" {...props}>
        <ChatIcon size="sm" className="shrink-0" />
        <span
          className="canopy-panel-tab-list-busy"
          {...{ [PANEL_TAB_BUSY_ATTRIBUTE]: 'true' }}
        >
          <ThinkingSpinner sizePx={10} tone="accent" className="shrink-0" />
        </span>
      </span>
    );
  }
  if (busy) {
    return (
      <span
        className="inline-flex shrink-0 items-center"
        {...{ [PANEL_TAB_BUSY_ATTRIBUTE]: 'true' }}
        {...props}
      >
        <ThinkingSpinner
          // A little under the 12px provider glyph it stands for: the dense
          // dot grid reads heavier than a line glyph at the same size. It
          // centers in the fixed 14px icon slot, so the label never moves.
          sizePx={10}
          // The accent, as the sidebar's running worktree spinner uses: the
          // same "agent working here" signal in the theme's own colour.
          tone="accent"
          className="shrink-0"
        />
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center" {...props}>
      <ChatIcon size="sm" className="shrink-0" />
    </span>
  );
}

/**
 * A chat tab whose agent runs only background work: the pulsing grey dot
 * (turn-state D15), in the fill bar's 10px or the classic tab's 12px slot. Work
 * that blocks close keeps the busy marker that withholds the hover close.
 * Desktop and web chat tabs both draw it; each host decides when (no turn
 * running, nothing waiting on the user) and whether the work blocks close.
 */
export function PanelChatTabBackgroundGlyph({
  backgroundTasks,
  fill,
  unread = false,
  blocksClose = false,
  ...props
}: {
  readonly backgroundTasks: number;
  readonly fill: boolean;
  /**
   * The dot turns unread blue in place, in both bars, so the tab's one status
   * mark stays on its left rather than splitting across both ends.
   */
  readonly unread?: boolean;
  readonly blocksClose?: boolean;
} & HTMLAttributes<HTMLSpanElement>): JSX.Element {
  return (
    <span
      className="inline-flex shrink-0 items-center"
      {...(blocksClose ? { [PANEL_TAB_BUSY_ATTRIBUTE]: 'true' } : {})}
      {...props}
    >
      <AgentStateGlyph
        state="background"
        backgroundTasks={backgroundTasks}
        sizePx={fill ? 10 : 12}
        unread={unread}
      />
    </span>
  );
}

/**
 * Marks a chat tab whose agent is waiting on an unanswered question: the
 * sidebar row's question glyph in the same needs-input orange, so the tab
 * that holds the question reads like the row that reported it. Hosts decide
 * whether a question waits (desktop: an unanswered pending question; web: an
 * unanswered summary entry) and place it: a classic tab's leading slot, a
 * fill tab's right side. The glyph takes the compact 14px icon tier, which
 * fills the tab's icon slot and matches the close button it sits beside.
 */
export function PanelChatTabQuestionMarker({
  chatId,
}: {
  readonly chatId: string;
}): JSX.Element {
  return (
    <span
      role="img"
      aria-label="Question waiting"
      data-testid={`panel-tab-question-${chatId}`}
      className={`inline-flex shrink-0 items-center justify-center ${SIDEBAR_INDICATOR_COLORS.warning}`}
    >
      <QuestionMarkIcon size={14} aria-hidden="true" />
    </span>
  );
}

/**
 * Supplies {@link usePanelTabStyle} to tab renderers drawn outside a tab bar
 * that should still match one (and to tests). Every tab bar provides its own.
 */
export function PanelTabStyleProvider({
  value,
  children,
}: {
  value: PanelTabStyle;
  children: ReactNode;
}): JSX.Element {
  return (
    <PanelTabStyleContext.Provider value={value}>
      {children}
    </PanelTabStyleContext.Provider>
  );
}

function CloseGlyph(): JSX.Element {
  // 14px to match `.canopy-panel-tab-icon`, the slot it covers on hover.
  return <CloseMediumIcon size="sm" />;
}

function PinGlyph(): JSX.Element {
  return <PinIcon size="sm" />;
}

/**
 * Reveals `tab` inside the horizontally scrollable strip (ChatTabBar's
 * scroll-into-view convention: mutate `scrollLeft` only, never scroll
 * ancestors, and align to the nearest edge).
 */
function scrollTabIntoView(
  container: HTMLDivElement,
  tab: HTMLDivElement,
): void {
  const containerRect = container.getBoundingClientRect();
  const tabRect = tab.getBoundingClientRect();
  const tabLeft = tabRect.left - containerRect.left + container.scrollLeft;
  const tabRight = tabLeft + tabRect.width;
  // Clear of any "N running" hint on either edge, so the tab is not left
  // under it. (Hints only show where they leave room for the tab; see
  // PanelTabEdgeHints.)
  const startInset = edgeHintClearance(container, 'start');
  const endInset = edgeHintClearance(container, 'end');
  const visibleLeft = container.scrollLeft + startInset;
  const visibleRight = container.scrollLeft + container.clientWidth - endInset;

  if (tabLeft < visibleLeft) {
    container.scrollLeft = tabLeft - startInset;
  } else if (tabRight > visibleRight) {
    container.scrollLeft = tabRight - container.clientWidth + endInset;
  }
}

/** Snapshot of the props the strip drop-target callbacks need (kept in a ref
 * so the one-shot observer always sees the latest render's values). */
interface TabStripDndSnapshot {
  groupId: string;
  tabs: readonly PanelTabModel[];
  onReorderTab?: (groupId: string, panelId: string, toIndex: number) => void;
  onMovePanel?: (
    panelId: string,
    targetGroupId: string,
    edge: PanelDropEdge,
    targetIndex?: number,
  ) => void;
  canMovePanelHere?: (panelId: string, targetGroupId: string) => boolean;
}

/** The card hangs this far under the tab. */
const TAB_HOVER_CARD_GAP_PX = 8;

/** The preview follows the whole tab, including its close button. */
function tabInsideTrigger(trigger: HTMLElement): Element | null {
  return trigger.querySelector('[role="tab"]');
}

function PanelTabWithHoverCard({
  panelId,
  card,
  children,
}: {
  panelId: string;
  card: ReactNode;
  children: JSX.Element;
}): JSX.Element {
  return (
    <RichHoverTooltip
      content={card}
      suppressed={card === null}
      dataTestId={`panel-tab-hover-card-${panelId}`}
      deferUntilInteraction
      handoffMotion="jump"
      elevation="menu"
      surfacePadding="compact"
      surfaceClassName="w-70"
      triggerDisplay="contents"
      placement="below-start"
      placementGap={TAB_HOVER_CARD_GAP_PX}
      getPlacementAnchor={tabInsideTrigger}
      aboveBrowser
    >
      {children}
    </RichHoverTooltip>
  );
}

/**
 * The tab strip of a panel group. Roving-tabindex keyboard model:
 * ArrowLeft/ArrowRight move focus between tabs (wrapping), Enter/Space
 * select the focused tab.
 *
 * Overflowing tabs scroll horizontally (CSS, hidden scrollbar): vertical
 * mouse-wheel deltas pan the strip, and the active tab is kept scrolled into
 * view on selection/insertion (both ChatTabBar conventions). A running tab
 * scrolled out of view leaves a quiet dot at that edge
 * ({@link PanelTabEdgeHints}), and the ⌄ button after the strip lists every
 * tab ({@link PanelTabListButton}).
 *
 * Fill tabs: unpinned tabs hug their content while they fit; then the active
 * tab keeps its content width and the others share the rest, Chrome-style
 * (panels.css), down to a square tile that shows only the tab's number or
 * status glyph. Past that the strip scrolls.
 * Closing a tab with the pointer holds the remaining unpinned tabs at their
 * widths until the pointer leaves the strip, so the next tab's close button
 * lands under the pointer, as in Chrome.
 *
 * Each tab is a `role="tab"` element (a div, not a `<button>`, because the
 * per-tab close affordance is a real button and buttons must not nest).
 *
 * Drag & drop (Phase 6): tabs are draggable — dragstart writes the tab's
 * identity into the panel-tab transfer singleton (never `dataTransfer`,
 * which is unreadable during dragover) and dragend clears it. The strip is a
 * drop target (via {@link DragAndDropObserver}, counter-based enter/leave):
 * dragover with an active panel-tab drag shows an insertion indicator at the
 * nearest tab boundary; drop either reorders within this group
 * ({@link PanelTabBarProps.onReorderTab}) or merges a tab from another group
 * (`onMovePanel(..., 'center')`).
 *
 * Fill tabs reorder live instead where the host offers it
 * ({@link PanelTabLiveReorderContext}); elsewhere they keep the marker.
 *
 * The optional add-tab button sits OUTSIDE the scrollable strip so it never
 * scrolls away with overflowing tabs, and so the app-supplied menu anchored
 * to it is not clipped by the strip's `overflow-x: auto`.
 */
function PanelTabBarComponent({
  groupId,
  tabs,
  activePanelId,
  draggable = true,
  onSelectTab,
  onCloseTab,
  onTabIntent,
  canCloseTab,
  onReorderTab,
  onMovePanel,
  canMovePanelHere,
  renderTabIcon,
  renderTabLabel,
  renderTabTrailing,
  renderTabAccessibleStatus,
  renderTabAttention,
  getTabTitle,
  isTabTitlePrivate,
  renderTabTooltip,
  renderTabHoverCard,
  addTab,
  tabStyle = 'classic',
  onTabContextMenu,
}: PanelTabBarProps): JSX.Element {
  const statusIdPrefix = useId();
  const titleMask = (tab: PanelTabModel): string =>
    isTabTitlePrivate?.(tab) === true ? ` ${REPLAY_MASK_CLASS}` : '';
  // Click events copy attribute values past the replay mask, so a private
  // title names the close button through a masked label, never `aria-label`.
  const closeLabelId = (tab: PanelTabModel): string =>
    `${statusIdPrefix}-${tab.panelId}-close`;
  const closeLabelProps = (
    tab: PanelTabModel,
    title: string,
  ): { 'aria-label': string } | { 'aria-labelledby': string } =>
    isTabTitlePrivate?.(tab) === true
      ? { 'aria-labelledby': closeLabelId(tab) }
      : { 'aria-label': `Close ${title}` };
  const closeLabel = (tab: PanelTabModel, title: string): ReactNode =>
    isTabTitlePrivate?.(tab) === true ? (
      <span className="sr-only" id={closeLabelId(tab)}>
        Close {title}
      </span>
    ) : null;
  const fill = tabStyle === 'fill';
  const [focusedPanelId, setFocusedPanelId] = useState<string | null>(null);
  const tabElementsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  // Two scroll strips, each with its own wheel/overflow/thumb hook: pinned
  // tabs render in a left-anchored, bounded strip; unpinned tabs own the
  // remaining space (the ChatTabBar split). The DnD observer, drop-indicator
  // math, and active-tab reveal address the FULL `tabs` array (pinned first),
  // regardless of which strip a tab renders in.
  const pinnedScroll = useHorizontalOverflowScroll<HTMLDivElement>();
  const unpinnedScroll = useHorizontalOverflowScroll<HTMLDivElement>();
  const pinnedStripRef = pinnedScroll.ref;
  const unpinnedStripRef = unpinnedScroll.ref;
  // Running tabs scrolled out of the unpinned strip, for its edge hints.
  const hiddenRunning = useHiddenBusyTabs(
    unpinnedScroll.ref,
    unpinnedScroll.hasOverflow,
    PANEL_TAB_BUSY_ATTRIBUTE,
  );
  // The pinned strip scrolls too (it is capped), with its own hints.
  const hiddenPinnedRunning = useHiddenBusyTabs(
    pinnedScroll.ref,
    pinnedScroll.hasOverflow,
    PANEL_TAB_BUSY_ATTRIBUTE,
  );
  // Which edges show a hint, so a hint moving from one edge to the other
  // (the same count) still re-reveals the selected tab. Fill strips draw no
  // "N running" hints: ⌄ and its list carry what scrolled out of view.
  const hintEdges = fill
    ? '0000'
    : [
        hiddenPinnedRunning.start,
        hiddenPinnedRunning.end,
        hiddenRunning.start,
        hiddenRunning.end,
      ]
        .map((list) => (list.length > 0 ? '1' : '0'))
        .join('');
  // Fill strips show ⌄ only once the tabs no longer fit, with a dot while an
  // unread tab is out of view.
  const listRootRef = useRef<HTMLDivElement>(null);
  const stripState = usePanelTabStripState(
    unpinnedScroll.ref,
    pinnedScroll.ref,
    listRootRef,
    fill,
    tabs.some((tab) => tab.pinned === true),
  );
  // Whether the user has moved the strip themselves (wheel, drag, touch,
  // keys, or a hint's click) since the selected tab last changed.
  const userScrolledRef = useRef(false);
  // The pinned strip mounts only once a tab is pinned.
  const anyPinned = tabs.some((tab) => tab.pinned === true);
  const lastActivePanelIdRef = useRef(activePanelId);
  useEffect(() => {
    // Both strips (pinned and unpinned) and their hints and thumbs.
    const wraps = [pinnedScroll.ref, unpinnedScroll.ref]
      .map((ref) => ref.current?.parentElement)
      .filter((wrap): wrap is HTMLElement => wrap != null);
    const mark = (): void => {
      userScrolledRef.current = true;
    };
    const events = ['wheel', 'pointerdown', 'touchstart', 'keydown'] as const;
    // Capture phase: the scrollbar thumb stops its own pointerdown from
    // bubbling, and a thumb drag is a user scroll too.
    for (const wrap of wraps) {
      for (const name of events) {
        wrap.addEventListener(name, mark, { passive: true, capture: true });
      }
    }
    return (): void => {
      for (const wrap of wraps) {
        for (const name of events) {
          wrap.removeEventListener(name, mark, { capture: true });
        }
      }
    };
  }, [pinnedScroll.ref, unpinnedScroll.ref, anyPinned]);
  // A hint appears (and publishes its width, in its own layout effect)
  // after the selected tab was first scrolled into view. If the hint now
  // covers part of that tab, bring it clear. Not once the user has moved
  // the strip themselves, so their scroll is never pulled back, and not for
  // a tab scrolled fully out of view.
  useLayoutEffect(() => {
    if (lastActivePanelIdRef.current !== activePanelId) {
      lastActivePanelIdRef.current = activePanelId;
      userScrolledRef.current = false;
    }
    if (!hintEdges.includes('1')) return;
    if (userScrolledRef.current) return;
    const tab =
      activePanelId === null
        ? undefined
        : tabElementsRef.current.get(activePanelId);
    // Whichever strip the selected tab is in.
    const strip = tab?.closest<HTMLDivElement>('.canopy-panel-tab-strip');
    if (!strip || !tab) return;
    const box = strip.getBoundingClientRect();
    const rect = tab.getBoundingClientRect();
    if (rect.right <= box.left || rect.left >= box.right) return;
    scrollTabIntoView(strip, tab);
  }, [hintEdges, activePanelId]);

  const pinnedTabs = tabs.filter((tab) => tab.pinned === true);
  const unpinnedTabs = tabs.filter((tab) => tab.pinned !== true);
  const hasPinnedStrip = pinnedTabs.length > 0;
  const pinnedCount = pinnedTabs.length;

  // The bar itself: live reorder measures the title row from it.
  const barRef = useRef<HTMLDivElement>(null);

  // Drag state: which of OUR tabs is being dragged (styling only), and where
  // the insertion indicator sits (an index into `tabs`, `tabs.length` = end).
  const [draggingPanelId, setDraggingPanelId] = useState<string | null>(null);
  const [dropIndicatorIndex, setDropIndicatorIndex] = useState<number | null>(
    null,
  );

  // Latest-render snapshot for the strip observer (registered once per strip).
  const dndSnapshotRef = useRef<TabStripDndSnapshot>({
    groupId,
    tabs,
    onReorderTab,
    onMovePanel,
    canMovePanelHere,
  });
  dndSnapshotRef.current = {
    groupId,
    tabs,
    onReorderTab,
    onMovePanel,
    canMovePanelHere,
  };

  // Strip drop targets: one DragAndDropObserver per rendered strip (pinned +
  // unpinned). Each observer preventDefault()s dragover (required for `drop`)
  // and normalizes enter/leave with the counter trick. `insertionIndexAt`
  // walks the FULL tab list so a drop on either strip resolves a full-array
  // index; the store then clamps a reorder to the dragged tab's own partition.
  // Re-runs when the pinned strip mounts/unmounts (a tab was pinned/unpinned).
  useEffect(() => {
    const strips = [pinnedStripRef.current, unpinnedStripRef.current].filter(
      (element): element is HTMLDivElement => element !== null,
    );

    if (strips.length === 0) {
      return undefined;
    }

    const insertionIndexAt = (clientX: number): number => {
      const { tabs: currentTabs } = dndSnapshotRef.current;

      for (let index = 0; index < currentTabs.length; index++) {
        const element = tabElementsRef.current.get(currentTabs[index].panelId);

        if (!element) {
          continue;
        }

        const rect = element.getBoundingClientRect();

        if (clientX <= rect.left + rect.width / 2) {
          return index;
        }
      }

      return currentTabs.length;
    };

    const observers = strips.map(
      (strip) =>
        new DragAndDropObserver(strip, {
          onDragOver: (event): void => {
            if (!hasActivePanelTabDrag()) {
              return;
            }

            // Without a move intent the strip only reorders its own tabs,
            // and a merge the layout owner would refuse shows no indicator.
            const {
              groupId: stripGroupId,
              onMovePanel: move,
              canMovePanelHere: canMove,
            } = dndSnapshotRef.current;
            const dragged = readPanelTabDrag();

            if (
              dragged?.sourceGroupId !== stripGroupId &&
              (move === undefined ||
                (dragged !== null &&
                  canMove?.(dragged.panelId, stripGroupId) === false))
            ) {
              setDropIndicatorIndex(null);
              return;
            }

            setDropIndicatorIndex(insertionIndexAt(event.clientX));
          },
          onDragLeave: (): void => {
            setDropIndicatorIndex(null);
          },
          onDragEnd: (): void => {
            setDropIndicatorIndex(null);
          },
          onDrop: (event): void => {
            setDropIndicatorIndex(null);

            const dragged = readPanelTabDrag();

            if (!dragged) {
              return;
            }

            clearPanelTabDrag();

            const {
              groupId: targetGroupId,
              tabs: currentTabs,
              onReorderTab: reorder,
              onMovePanel: move,
              canMovePanelHere: canMove,
            } = dndSnapshotRef.current;

            const insertionIndex = insertionIndexAt(event.clientX);

            if (dragged.sourceGroupId !== targetGroupId) {
              if (canMove?.(dragged.panelId, targetGroupId) === false) {
                return;
              }
              // Cross-group strip drop: merge into this group at the exact
              // boundary advertised by the insertion indicator.
              move?.(dragged.panelId, targetGroupId, 'center', insertionIndex);
              return;
            }

            const fromIndex = currentTabs.findIndex(
              (tab) => tab.panelId === dragged.panelId,
            );

            if (fromIndex === -1) {
              return;
            }

            // The insertion index addresses the CURRENT array; removing the
            // tab first shifts later positions down by one (VS Code's
            // off-by-one fix), producing the final-array index the intent
            // contract wants. The store clamps it to the dragged tab's own
            // pinned/unpinned partition.
            const toIndex =
              insertionIndex > fromIndex ? insertionIndex - 1 : insertionIndex;

            if (toIndex !== fromIndex) {
              reorder?.(targetGroupId, dragged.panelId, toIndex);
            }
          },
        }),
    );

    return (): void => {
      for (const observer of observers) {
        observer.dispose();
      }
    };
  }, [hasPinnedStrip, pinnedStripRef, unpinnedStripRef]);

  // Fill tabs reorder live where the host offers it.
  const liveReorder = useContext(PanelTabLiveReorderContext)({
    fill,
    draggingPanelId,
    tabs,
    barRef,
    tabElementsRef,
    stripRef: dndSnapshotRef,
    setDropIndicatorIndex,
    getTabTitle,
    isTabTitlePrivate,
  });

  // Reveal the active tab inside whichever overflowing strip renders it.
  // Returns `true` when the reveal is settled (scrolled, or there is nothing to
  // scroll) and `false` when it had to be deferred because the strip is not
  // laid out yet (0 width — `scrollTabIntoView` would compute a garbage offset
  // from a zero-size container).
  const revealActiveTab = (): boolean => {
    if (activePanelId === null) {
      return true;
    }

    const isActivePinned = pinnedTabs.some(
      (tab) => tab.panelId === activePanelId,
    );
    const activeStripTabs = isActivePinned ? pinnedTabs : unpinnedTabs;

    // A one-tab strip cannot overflow horizontally, so revealing it cannot
    // change scroll position. Avoid forcing layout for the common one-chat
    // workspace case, especially when many panel groups mount together.
    if (activeStripTabs.length <= 1) {
      return true;
    }

    const activeScroll = isActivePinned ? pinnedScroll : unpinnedScroll;
    const strip = activeScroll.ref.current;

    // The leading tab is already fully visible when the strip is at its
    // natural start. This is the common initial-mount state; measuring every
    // tab bar here otherwise forces a document-wide layout before paint.
    if (
      activeStripTabs[0]?.panelId === activePanelId &&
      strip?.scrollLeft === 0
    ) {
      return true;
    }

    // The hook's observer-backed state can trail the current DOM on first mount
    // or when an insertion crosses the overflow threshold. Check the cheap
    // scroll metrics synchronously so an off-screen active tab is still
    // revealed before paint, while avoiding expensive rect reads for the
    // overwhelmingly common fitting strip.
    const hasCurrentOverflow =
      strip !== null && strip.scrollWidth - strip.clientWidth > 1;
    if (!activeScroll.hasOverflow && !hasCurrentOverflow) {
      return true;
    }

    const activeTab = tabElementsRef.current.get(activePanelId);
    if (!activeTab) {
      return false;
    }

    if (!strip || strip.clientWidth === 0) {
      return false;
    }

    scrollTabIntoView(strip, activeTab);
    return true;
  };

  // Whether the synchronous (layout-effect) reveal settled this render, so the
  // post-paint fallback below can skip a redundant second scroll.
  const layoutRevealSettledRef = useRef(false);

  // Keep the active tab revealed: selection changes and tab insertions can
  // land on a tab scrolled out of the overflowing strip it renders in. The
  // synchronous layout effect covers the common case where the strip is
  // already laid out (tab selection/insertion), so the reveal lands before
  // paint with no flash.
  // Pinning or unpinning the selected tab moves it to the other strip,
  // where it has to be revealed again.
  const activeIsPinned = tabs.some(
    (tab) => tab.panelId === activePanelId && tab.pinned === true,
  );
  useLayoutEffect(() => {
    layoutRevealSettledRef.current = revealActiveTab();
  }, [
    activePanelId,
    activeIsPinned,
    tabs.length,
    fill,
    pinnedScroll.hasOverflow,
    pinnedScroll.ref,
    unpinnedScroll.hasOverflow,
    unpinnedScroll.ref,
  ]);

  // A strip that still overflows but changes width (a split dragged
  // narrower) can leave the selected tab off screen: bring it back, unless
  // the user has moved the strip themselves since it was selected.
  const unpinnedWidth = hiddenRunning.width;
  const pinnedWidth = hiddenPinnedRunning.width;
  useLayoutEffect(() => {
    if (userScrolledRef.current) return;
    revealActiveTab();
    // Only on a width change; selection and insertion are handled above.
  }, [unpinnedWidth, pinnedWidth]);

  // Post-paint fallback for worktree navigation: the grid host sizes each
  // group's leaf (and thus its tab strip) in its OWN layout effect, which React
  // runs AFTER this portaled child's layout effect. So on navigation the
  // synchronous reveal above measures a 0-width strip and defers. A passive
  // effect runs after the grid has laid out, so the active tab is revealed once
  // its strip has a real width. Skipped when the layout effect already settled
  // (common case) to avoid a redundant scroll. Keyed identically to the layout
  // effect, so it only fires on selection/insertion/mount — never on user
  // scrolling.
  useEffect(() => {
    if (!layoutRevealSettledRef.current) {
      layoutRevealSettledRef.current = revealActiveTab();
    }
  }, [
    activePanelId,
    activeIsPinned,
    tabs.length,
    fill,
    pinnedScroll.hasOverflow,
    pinnedScroll.ref,
    unpinnedScroll.hasOverflow,
    unpinnedScroll.ref,
  ]);

  const handleTabDragStart = (
    event: ReactDragEvent<HTMLDivElement>,
    panelId: string,
  ): void => {
    startPanelTabDrag({ panelId, sourceGroupId: groupId });
    setDraggingPanelId(panelId);

    // Native payload is metadata-only (in-process identity travels through
    // the transfer singleton). Guard: synthetic test events lack dataTransfer.
    const dataTransfer: DataTransfer | null = event.dataTransfer;

    if (dataTransfer) {
      dataTransfer.effectAllowed = 'move';
    }

    liveReorder.dragStart(event, panelId);
  };

  const handleTabDragEnd = (): void => {
    // Fallback clear for aborted drags; a handled drop already cleared it.
    clearPanelTabDrag();
    setDraggingPanelId(null);
    setDropIndicatorIndex(null);
    liveReorder.dragEnd();
  };

  // The roving-tabindex holder: the last keyboard/pointer-focused tab if it
  // still exists, else the active tab, else the first tab.
  const rovingPanelId =
    focusedPanelId !== null &&
    tabs.some((tab) => tab.panelId === focusedPanelId)
      ? focusedPanelId
      : (activePanelId ?? tabs[0]?.panelId ?? null);

  const focusTabAt = (index: number): void => {
    const tab = tabs[index];

    if (!tab) {
      return;
    }

    setFocusedPanelId(tab.panelId);
    tabElementsRef.current.get(tab.panelId)?.focus();
  };

  const handleTabKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
    index: number,
  ): void => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const delta = event.key === 'ArrowLeft' ? -1 : 1;
      focusTabAt((index + delta + tabs.length) % tabs.length);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      focusTabAt(event.key === 'Home' ? 0 : tabs.length - 1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelectTab(groupId, tabs[index].panelId);
    }
  };

  // The dragged tab's own partition (null = not a same-group drag). Drop
  // indicators only show within that partition, and the pointer's insertion
  // index is clamped to the partition's boundary for display — matching where
  // the store's reorder clamp will actually place the tab.
  const draggedSectionPinned =
    draggingPanelId !== null
      ? tabs.find((tab) => tab.panelId === draggingPanelId)?.pinned === true
      : null;
  const displayDropIndex =
    dropIndicatorIndex === null
      ? null
      : draggedSectionPinned === true
        ? Math.min(dropIndicatorIndex, pinnedCount)
        : draggedSectionPinned === false
          ? Math.max(dropIndicatorIndex, pinnedCount)
          : dropIndicatorIndex;

  // A fill tab's content: one wrapping line of icon, then the label (with its
  // trailing content and the close button). As the tab narrows the label
  // wraps off the visible line, taking the close button with it, leaving the
  // icon alone and centered (panels.css).
  const renderFillTabContent = (
    tab: PanelTabModel,
    {
      icon,
      title,
      customTooltip,
      hoverCard,
      tabIsPinned,
    }: {
      icon: ReactNode;
      title: string;
      customTooltip: ReactNode;
      hoverCard: ReactNode;
      tabIsPinned: boolean;
    },
  ): JSX.Element => {
    const trailing = renderTabTrailing ? (
      // State indicators sit where the close button takes over on hover; an
      // icon-only pinned tile shows them on its corner instead (panels.css).
      <span className="canopy-panel-tab-trailing">
        {renderTabTrailing(tab)}
      </span>
    ) : null;

    if (tabIsPinned) {
      return (
        <>
          <span className="canopy-panel-tab-main">
            <span className="canopy-panel-tab-icon" aria-hidden="true">
              {icon ?? <PinGlyph />}
            </span>
          </span>
          {trailing}
        </>
      );
    }

    // The probe places the slot and hides it on a label too narrow to keep
    // text beside it; the slot carries the hover reveal, and its
    // `inline-flex` keeps it exactly the button's 24px box (panels.css). No
    // tooltip: the glyph is self-explanatory and its accessible name says
    // which tab.
    const closeControl =
      canCloseTab && !canCloseTab(tab) ? null : (
        <span className="canopy-panel-tab-close-probe">
          <span
            className={`canopy-panel-tab-close-slot inline-flex${titleMask(tab)}`}
          >
            <ControlButton
              type="button"
              presentation="panel-tab-close"
              data-testid={`panel-tab-close-${tab.panelId}`}
              {...closeLabelProps(tab, title)}
              tabIndex={-1}
              onClick={(event: ReactMouseEvent<HTMLButtonElement>): void => {
                // Closing must not also select the tab. The remaining tabs
                // re-share the row at once; while it is crowded the last tab
                // stays at the end of the row, under the pointer.
                event.stopPropagation();
                onCloseTab(groupId, tab.panelId);
              }}
            >
              <CloseGlyph />
            </ControlButton>
            {closeLabel(tab, title)}
          </span>
        </span>
      );

    return (
      <span className="canopy-panel-tab-main">
        {icon ? (
          <span className="canopy-panel-tab-icon" aria-hidden="true">
            {icon}
          </span>
        ) : null}
        {/* Label, trailing content, and close button share one wrapper: it
            holds the line's place for the label, and on hover makes room for
            the close button, which floats over its right end adding no width
            (panels.css). Tooltips follow the classic label's rules. */}
        <span className="canopy-panel-tab-label">
          {hoverCard !== null ? (
            // The tab carries the hover card, so the title needs no wrapper
            // of its own, and it fades out like every fill title rather
            // than ending in "…".
            <span className="canopy-panel-tab-title">
              {renderTabLabel ? renderTabLabel(tab) : tab.title}
            </span>
          ) : customTooltip !== null ? (
            // The trigger wrapper must shrink with the label (and grow from
            // its content, so the tab still hugs it), or a long title is cut
            // at the tab's edge instead of ending in an ellipsis.
            <Tooltip
              placement="top"
              label={customTooltip}
              suppressed={draggingPanelId !== null}
              allowShrink
              className="flex-auto"
            >
              <span className="canopy-panel-tab-title">
                {renderTabLabel ? renderTabLabel(tab) : tab.title}
              </span>
            </Tooltip>
          ) : (
            <span className="canopy-panel-tab-title" title={title}>
              {renderTabLabel ? renderTabLabel(tab) : tab.title}
            </span>
          )}
          {trailing}
          {closeControl}
        </span>
      </span>
    );
  };

  const renderTab = (tab: PanelTabModel): JSX.Element => {
    const fullIndex = tabs.findIndex((t) => t.panelId === tab.panelId);
    const isActive = tab.panelId === activePanelId;
    const tabIsPinned = tab.pinned === true;
    const icon = renderTabIcon?.(tab);
    const title = getTabTitle?.(tab) ?? tab.title;
    const privateTitle = isTabTitlePrivate?.(tab) === true;
    const titleId = `${statusIdPrefix}-${tab.panelId}-title`;
    // Preview-capable strips coordinate label tooltips too: a native title
    // on the active tab cannot dismiss the previous tab's preview.
    const customTooltip =
      renderTabTooltip?.(tab) ??
      // A private title gets this tooltip too: a native `title` attribute
      // would carry it past the replay mask.
      ((renderTabHoverCard || privateTitle) && !tabIsPinned ? (
        <span
          className={`block max-w-80 break-words whitespace-normal${titleMask(tab)}`}
        >
          {renderTabLabel?.(tab) ?? title}
        </span>
      ) : null);
    // A hover card previews a tab you cannot see, so the active tab and the
    // icon-only pinned tiles (which keep their own tooltip) never get one.
    const hoverCard =
      isActive || tabIsPinned ? null : (renderTabHoverCard?.(tab) ?? null);

    const classNames = ['canopy-panel-tab'];

    // Pinned tabs render in the compact "collapsed" style: icon only, no label
    // or close button, with the full title surfaced in a rich hover tooltip.
    if (tabIsPinned) {
      classNames.push('canopy-panel-tab-pinned');
    }

    if (tab.panelId === draggingPanelId) {
      classNames.push('canopy-panel-tab-dragging');
    }

    // Insertion indicator: a marker on the boundary the drop would insert at,
    // suppressed outside the dragged tab's own partition (cross-partition
    // reorders are clamped away by the store). The end-of-section marker sits
    // on the last tab of the dragged section (pinned → pinnedCount, else the
    // whole array's end).
    const sameSection =
      draggedSectionPinned === null || draggedSectionPinned === tabIsPinned;
    if (sameSection && displayDropIndex !== null) {
      const sectionEndIndex =
        draggedSectionPinned === true ? pinnedCount : tabs.length;
      const sectionLastFullIndex = sectionEndIndex - 1;
      if (displayDropIndex === fullIndex) {
        classNames.push('canopy-panel-tab-drop-before');
      } else if (
        displayDropIndex === sectionEndIndex &&
        fullIndex === sectionLastFullIndex
      ) {
        classNames.push('canopy-panel-tab-drop-after');
      }
    }

    const tabElement = (
      <div
        key={tab.panelId}
        role="tab"
        className={classNames.join(' ')}
        data-testid={`panel-tab-${tab.panelId}`}
        data-panel-kind={tab.kind}
        data-active={isActive ? 'true' : 'false'}
        data-pinned={tabIsPinned ? 'true' : 'false'}
        data-group-id={groupId}
        aria-selected={isActive}
        // Icon-only pinned tabs have no visible text, so the title has to come
        // through as an accessible name.
        aria-label={tabIsPinned && !privateTitle ? title : undefined}
        aria-labelledby={tabIsPinned && privateTitle ? titleId : undefined}
        aria-describedby={
          tabIsPinned && renderTabAccessibleStatus
            ? `${statusIdPrefix}-${tab.panelId}`
            : undefined
        }
        tabIndex={tab.panelId === rovingPanelId ? 0 : -1}
        draggable={draggable}
        ref={(element): void => {
          if (element) {
            tabElementsRef.current.set(tab.panelId, element);
          } else {
            tabElementsRef.current.delete(tab.panelId);
          }
        }}
        onClick={(): void => {
          setFocusedPanelId(tab.panelId);
          onSelectTab(groupId, tab.panelId);
        }}
        onKeyDown={(event): void => {
          handleTabKeyDown(event, fullIndex);
        }}
        onContextMenu={
          onTabContextMenu
            ? (event: ReactMouseEvent<HTMLDivElement>): void => {
                event.preventDefault();
                onTabContextMenu(
                  groupId,
                  tab.panelId,
                  event.clientX,
                  event.clientY,
                );
              }
            : undefined
        }
        // Hovering a tab comes before dragging it; a press with no hover
        // first (touch, pen) asks again.
        onPointerEnter={
          draggable || onTabIntent
            ? (event): void => {
                if (draggable) liveReorder.prepare?.(event);
                onTabIntent?.(groupId, tab, 'start', 'pointer');
              }
            : undefined
        }
        onPointerLeave={
          onTabIntent
            ? (): void => onTabIntent(groupId, tab, 'end', 'pointer')
            : undefined
        }
        onFocus={
          onTabIntent
            ? (event): void => {
                if (event.target === event.currentTarget)
                  onTabIntent(groupId, tab, 'start', 'focus');
              }
            : undefined
        }
        onBlur={
          onTabIntent
            ? (event): void => {
                if (event.target === event.currentTarget)
                  onTabIntent(groupId, tab, 'end', 'focus');
              }
            : undefined
        }
        onPointerDown={draggable ? liveReorder.prepare : undefined}
        onDragStart={(event): void => {
          if (!draggable) return;
          handleTabDragStart(event, tab.panelId);
        }}
        onDragEnd={(): void => {
          if (!draggable) return;
          handleTabDragEnd();
        }}
      >
        {fill && renderTabAttention ? (
          <span className="canopy-panel-tab-attention">
            {renderTabAttention(tab)}
          </span>
        ) : null}
        {tabIsPinned && privateTitle ? (
          <span className={`sr-only ${REPLAY_MASK_CLASS}`} id={titleId}>
            {title}
          </span>
        ) : null}
        {tabIsPinned && renderTabAccessibleStatus ? (
          <span className="sr-only" id={`${statusIdPrefix}-${tab.panelId}`}>
            {renderTabAccessibleStatus(tab)}
          </span>
        ) : null}
        {fill ? (
          renderFillTabContent(tab, {
            icon,
            title,
            customTooltip,
            hoverCard,
            tabIsPinned,
          })
        ) : tabIsPinned ? (
          // Compact icon-only pinned tab; falls back to the pin glyph when the
          // app provides no per-kind icon so the pill is never empty. The
          // `-main` wrapper carries the active underline.
          <span className="canopy-panel-tab-main">
            <span className="canopy-panel-tab-icon" aria-hidden="true">
              {icon ?? <PinGlyph />}
            </span>
          </span>
        ) : (
          <>
            {/* Icon + label share the `-main` wrapper so the active
                underline spans exactly that pair (not the trailing content
                or close button). */}
            <span className="canopy-panel-tab-main">
              {icon ? (
                <span className="canopy-panel-tab-icon" aria-hidden="true">
                  {icon}
                </span>
              ) : null}
              {/* The label wrapper keeps the string title attribute (tooltip
              fallback) even when an app label renderer replaces the plain
              text — unless the app supplies a RICH tooltip, which replaces
              the native one entirely. The rich tooltip is attached to the
              non-interactive label span (never the whole tab) so no
              interactive control nests inside the trigger. */}
              {hoverCard !== null ? (
                <span className="canopy-panel-tab-title">
                  <span className="relative inline-flex w-full min-w-0">
                    <span className="truncate">
                      {renderTabLabel ? renderTabLabel(tab) : tab.title}
                    </span>
                  </span>
                </span>
              ) : customTooltip !== null ? (
                <Tooltip
                  placement="top"
                  label={customTooltip}
                  suppressed={draggingPanelId !== null}
                >
                  <span className="canopy-panel-tab-title">
                    {renderTabLabel ? renderTabLabel(tab) : tab.title}
                  </span>
                </Tooltip>
              ) : (
                <span className="canopy-panel-tab-title" title={title}>
                  {renderTabLabel ? renderTabLabel(tab) : tab.title}
                </span>
              )}
            </span>
            {renderTabTrailing ? renderTabTrailing(tab) : null}
            {canCloseTab && !canCloseTab(tab) ? null : (
              // The slot is the tab's own element: `.canopy-panel-tab-close-slot`
              // carries the absolute positioning and hover reveal, and the
              // `inline-flex` keeps it exactly the button's 24px box. The
              // rich tooltip's trigger wrapper sits inside it, so the button
              // keeps its geometry while gaining an instant tooltip instead
              // of the laggy native `title`.
              <span
                className={`canopy-panel-tab-close-slot inline-flex${titleMask(tab)}`}
              >
                <Tooltip
                  label={
                    privateTitle ? (
                      <>
                        Close <span className={REPLAY_MASK_CLASS}>{title}</span>
                      </>
                    ) : (
                      `Close ${title}`
                    )
                  }
                  disabled={hoverCard !== null}
                >
                  <ControlButton
                    type="button"
                    presentation="panel-tab-close"
                    data-testid={`panel-tab-close-${tab.panelId}`}
                    {...closeLabelProps(tab, title)}
                    tabIndex={-1}
                    onClick={(
                      event: ReactMouseEvent<HTMLButtonElement>,
                    ): void => {
                      // Closing must not also select the tab.
                      event.stopPropagation();
                      onCloseTab(groupId, tab.panelId);
                    }}
                  >
                    <CloseGlyph />
                  </ControlButton>
                </Tooltip>
                {closeLabel(tab, title)}
              </span>
            )}
          </>
        )}
      </div>
    );

    // Keep the wrapper stable when selecting a previewed tab, so the tab's
    // DOM node and keyboard focus survive the active/background transition.
    if (!tabIsPinned && renderTabHoverCard) {
      return (
        <PanelTabWithHoverCard
          key={tab.panelId}
          panelId={tab.panelId}
          card={hoverCard}
        >
          {tabElement}
        </PanelTabWithHoverCard>
      );
    }

    if (!tabIsPinned) {
      return tabElement;
    }

    // Rich hover tooltip (Collapsed-style): the app's kind icon plus the full
    // title, since the pinned pill itself shows only the icon. An app-supplied
    // rich tooltip takes precedence, so normal, pinned, and collapsed tabs of
    // a kind share the same tooltip content.
    return (
      <Tooltip
        key={tab.panelId}
        placement="top"
        // A fill tile shrinks with its strip; its trigger wrapper must too
        // (panels.css).
        {...(fill
          ? { allowShrink: true, className: 'canopy-panel-tab-pinned-trigger' }
          : {})}
        label={
          customTooltip ?? (
            <span className="canopy-panel-tab-pinned-tooltip">
              {renderTabIcon?.(tab) ? (
                <span className="canopy-panel-tab-icon" aria-hidden="true">
                  {renderTabIcon(tab)}
                </span>
              ) : null}
              <span className={privateTitle ? REPLAY_MASK_CLASS : undefined}>
                {renderTabLabel ? renderTabLabel(tab) : title}
              </span>
            </span>
          )
        }
      >
        {tabElement}
      </Tooltip>
    );
  };

  return (
    <PanelTabStyleProvider value={tabStyle}>
      <div
        ref={barRef}
        className="canopy-panel-tab-bar"
        data-tab-style={tabStyle}
      >
        {hasPinnedStrip ? (
          <div className="canopy-panel-tab-strip-wrap canopy-panel-tab-strip-wrap-pinned">
            {
              <>
                <div
                  className="canopy-scroll-fade canopy-scroll-fade-start"
                  data-visible={pinnedScroll.showStartFade}
                  aria-hidden="true"
                />
                <div
                  className="canopy-scroll-fade canopy-scroll-fade-end"
                  data-visible={pinnedScroll.showEndFade}
                  aria-hidden="true"
                />
                <div
                  ref={pinnedScroll.thumbRef}
                  className="canopy-scroll-thumb"
                  data-overflow={pinnedScroll.hasOverflow}
                  data-revealed={pinnedScroll.isScrollbarRevealed}
                  aria-hidden="true"
                />
              </>
            }
            <div
              ref={pinnedStripRef}
              className="canopy-panel-tab-strip"
              role="tablist"
              aria-orientation="horizontal"
              aria-label="Pinned tabs"
              data-testid={`panel-tab-strip-pinned-${groupId}`}
            >
              {pinnedTabs.map((tab) => renderTab(tab))}
            </div>
            {/* Pinned tiles are 28px squares; the hints leave room for one. */}
            {fill ? null : (
              <PanelTabEdgeHints
                hidden={hiddenPinnedRunning}
                minTabWidth={28}
                testIdPrefix="panel-tab-edge-hint-pinned"
              />
            )}
          </div>
        ) : null}
        {hasPinnedStrip && unpinnedTabs.length > 0 ? (
          <div className="canopy-panel-tab-pinned-divider" aria-hidden="true" />
        ) : null}
        <div className="canopy-panel-tab-strip-wrap canopy-panel-tab-strip-wrap-unpinned">
          {
            <>
              <div
                className="canopy-scroll-fade canopy-scroll-fade-start"
                data-visible={unpinnedScroll.showStartFade}
                aria-hidden="true"
              />
              <div
                className="canopy-scroll-fade canopy-scroll-fade-end"
                data-visible={unpinnedScroll.showEndFade}
                aria-hidden="true"
              />
              <div
                ref={unpinnedScroll.thumbRef}
                className="canopy-scroll-thumb"
                data-overflow={unpinnedScroll.hasOverflow}
                data-revealed={unpinnedScroll.isScrollbarRevealed}
                data-active={unpinnedScroll.isScrollbarActive}
                aria-hidden="true"
              />
              {/* Fill rows: the thin line's hover and drag zone. */}
              {fill ? (
                <div
                  ref={unpinnedScroll.trackRef}
                  className="canopy-scroll-track"
                  data-overflow={unpinnedScroll.hasOverflow}
                  data-testid={`panel-tab-scroll-track-${groupId}`}
                  aria-hidden="true"
                />
              ) : null}
            </>
          }
          <div
            ref={unpinnedStripRef}
            className="canopy-panel-tab-strip"
            role="tablist"
            aria-label="Tabs"
            aria-orientation="horizontal"
            data-testid={`panel-tab-strip-${groupId}`}
          >
            {unpinnedTabs.map((tab) => renderTab(tab))}
          </div>
          {/* The selected tab keeps a 96px floor; the hints leave it room. */}
          {fill ? null : (
            <PanelTabEdgeHints hidden={hiddenRunning} minTabWidth={96} />
          )}
        </div>
        {addTab ? (
          <PanelAddTabButton groupId={groupId} addTab={addTab} />
        ) : null}
        {tabs.length > 0 ? (
          <PanelTabListButton
            rootRef={listRootRef}
            hidden={fill && !stripState.crowded}
            unreadOutOfView={fill && stripState.unreadOutOfView}
            groupId={groupId}
            tabs={tabs}
            activePanelId={activePanelId}
            onSelectTab={(listGroupId, panelId): void => {
              onSelectTab(listGroupId, panelId);
              // A pick always shows the tab, even the current one scrolled
              // out of view (no selection change would reveal it).
              userScrolledRef.current = false;
              const tab = tabElementsRef.current.get(panelId);
              const tabStrip = tab?.closest<HTMLDivElement>(
                '.canopy-panel-tab-strip',
              );
              if (tab && tabStrip) scrollTabIntoView(tabStrip, tab);
              // ⌄ hides once the list closes in a row that fits, so focus
              // moves to the picked tab rather than to a hidden button.
              if (fill && !stripState.crowded) {
                tab?.focus({ preventScroll: true });
              }
            }}
            onCloseTab={onCloseTab}
            {...(canCloseTab ? { canCloseTab } : {})}
            renderIcon={(tab): ReactNode => (
              // Drawn as the strip draws it, in the same style.
              <PanelTabStyleProvider value={tabStyle}>
                {renderTabIcon?.(tab) ?? null}
              </PanelTabStyleProvider>
            )}
            renderLabel={(tab): ReactNode =>
              renderTabLabel ? renderTabLabel(tab) : tab.title
            }
            renderTrailing={(tab): ReactNode => (
              <>
                {fill ? renderTabAttention?.(tab) : null}
                {renderTabTrailing?.(tab)}
              </>
            )}
            getTitle={(tab): string => getTabTitle?.(tab) ?? tab.title}
            {...(isTabTitlePrivate
              ? { isTitlePrivate: isTabTitlePrivate }
              : {})}
          />
        ) : null}
      </div>
    </PanelTabStyleProvider>
  );
}

export const PanelTabBar: NamedExoticComponent<PanelTabBarProps> =
  memo(PanelTabBarComponent);
