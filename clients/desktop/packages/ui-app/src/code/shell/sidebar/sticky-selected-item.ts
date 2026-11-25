/**
 * Selected-item pinning for the sidebar workspace list.
 *
 * The currently selected worktree (code workspaces) or work entry (cowork
 * workspaces) stays in view while the list scrolls:
 *
 * - Scrolling down past the selection pins a copy of the selected row
 *   directly below its own workspace header inside the sticky controls band
 *   (the header copy occupies the seat the workspace slot normally uses, and
 *   any later "current top" workspace header sticks below the pinned pair).
 * - Scrolling up past the selection pins a copy of the row to the bottom of
 *   the scroll area; once the owning workspace header would also leave the
 *   viewport it joins the pinned group above the row.
 *
 * - A selected Chats row (the section above Projects) seats under the sticky
 *   Chats header instead, and at the foot of the rail without a header copy
 *   (see `computeChatsSelectedPinState`).
 *
 * The flow originals mark themselves with `data-sidebar-selected-item`; the
 * scroll-sync in AppSidebar measures that mark, computes the pin state as a
 * pure function of the scroll offset, and toggles the dedicated host
 * surfaces that ProjectSection / SidebarCoworkWorkspaceRow portal their
 * pinned copies into. The scroll-driven workspace clip (extended through the
 * CSS vars below) remains the primary occlusion path. The pin hosts mirror the
 * active material: owned opaque/preview fills paint directly, while the macOS
 * translucent case stays transparent so the ancestor tint paints only once.
 */

/**
 * Where a selected row's pinned copy seats. Rows default to the project seat
 * below the Projects band; the Chats section's rows carry
 * `data-sidebar-selected-pin-seat="chats"` instead. They have no project
 * header — the sticky Chats header above the band names them — so their top
 * copy seats directly under that header rather than against the Projects band
 * (CAN-2363 opted them out entirely, which let a selected chat scroll away).
 */
export const SELECTED_PIN_SEAT_ATTR = 'data-sidebar-selected-pin-seat';
export type SelectedPinSeat = 'chats';

/** The selected project row the Projects-band pin measures. */
export const SELECTED_ITEM_FLOW_SELECTOR = `[data-sidebar-selected-item]:not([${SELECTED_PIN_SEAT_ATTR}="chats"])`;
/** The selected Chats row the Chats-header pin measures. */
export const CHATS_SELECTED_ITEM_FLOW_SELECTOR = `[data-sidebar-selected-item][${SELECTED_PIN_SEAT_ATTR}="chats"]`;
/**
 * The seat directly under the sticky Chats header that holds the selected
 * chat's top copy. A zero-height sticky sibling of the header, so revealing it
 * moves nothing in the flow.
 */
export const CHATS_SELECTED_PIN_SELECTOR = '[data-sidebar-chats-selected-pin]';
export const SELECTED_PIN_TOP_SELECTOR = '[data-sidebar-selected-pin-top]';
export const SELECTED_PIN_BOTTOM_SELECTOR =
  '[data-sidebar-selected-pin-bottom]';
export const SELECTED_PIN_HEADER_PART_SELECTOR =
  '[data-sidebar-selected-pin-part="header"]';
export const SELECTED_PIN_GROUP_HEADER_PART_SELECTOR =
  '[data-sidebar-selected-pin-part="group-header"]';
export const SELECTED_PIN_ROW_PART_SELECTOR =
  '[data-sidebar-selected-pin-part="row"]';

/** Height of the active top pin group; offsets the workspace slot seat. */
export const SELECTED_PIN_TOP_HEIGHT_VAR = '--sidebar-selected-pin-top-height';
/** Extra top-clip band depth contributed by the active top pin group. */
export const SELECTED_PIN_TOP_CLIP_VAR = '--sidebar-selected-pin-top-clip';
/** Bottom-clip band depth occupied by the active bottom pin group. */
export const SELECTED_PIN_BOTTOM_CLIP_VAR =
  '--sidebar-selected-pin-bottom-clip';

export interface StickySelectedItemMetrics {
  /** Flow offset of the selected row, relative to the scroll viewport. */
  readonly rowFlowTop: number;
  readonly rowHeight: number;
  /** Flow offset of the owning workspace header, viewport-relative. */
  readonly headerFlowTop: number;
  readonly headerHeight: number;
  readonly groupHeaderFlowTop?: number;
  readonly groupHeaderHeight?: number;
}

export type StickySelectedBottomPin =
  | 'none'
  | 'row'
  | 'header-row'
  | 'group-row'
  | 'header-group-row';

export interface StickySelectedPinState {
  readonly top: boolean;
  readonly bottom: StickySelectedBottomPin;
}

export interface StickySelectedPinBand {
  /** Height of the active top pin group (header + row), else 0. */
  readonly topGroupHeight: number;
  /** Extra depth added to the 40px top clip band, else 0. */
  readonly topClipExtension: number;
  /** Depth of the bottom clip band covering the bottom pin group, else 0. */
  readonly bottomClipExtension: number;
}

export const NO_SELECTED_PIN: StickySelectedPinState = {
  top: false,
  bottom: 'none',
};

/**
 * Pure pin-state decision. `stickyBandTop` is the viewport-relative bottom of
 * the stuck sticky controls (the `--sidebar-workspace-header-top` value);
 * `null` when the controls have not published a threshold, which disables
 * top pinning (bottom pinning is independent of the sticky band).
 */
export function computeStickySelectedPinState(params: {
  scrollTop: number;
  clientHeight: number;
  stickyBandTop: number | null;
  metrics: StickySelectedItemMetrics;
}): StickySelectedPinState {
  const { scrollTop, clientHeight, stickyBandTop, metrics } = params;
  const rowViewportTop = metrics.rowFlowTop - scrollTop;

  // Top pin: the row would slide under its own workspace header's pinned
  // seat (which sits directly below the stuck controls).
  if (
    stickyBandTop !== null &&
    rowViewportTop <=
      stickyBandTop + metrics.headerHeight + (metrics.groupHeaderHeight ?? 0)
  ) {
    return { top: true, bottom: 'none' };
  }

  // Bottom pin: the row's natural position falls below its bottom seat.
  const rowSeatTop = clientHeight - metrics.rowHeight;
  if (rowViewportTop > rowSeatTop) {
    const groupHeight = metrics.groupHeaderHeight ?? 0;
    const groupPinned =
      groupHeight > 0 &&
      (metrics.groupHeaderFlowTop ?? 0) - scrollTop > rowSeatTop - groupHeight;
    const headerSeatTop =
      rowSeatTop - (groupPinned ? groupHeight : 0) - metrics.headerHeight;
    const headerViewportTop = metrics.headerFlowTop - scrollTop;
    return {
      top: false,
      bottom:
        headerViewportTop > headerSeatTop
          ? groupPinned
            ? 'header-group-row'
            : 'header-row'
          : groupPinned
            ? 'group-row'
            : 'row',
    };
  }

  return NO_SELECTED_PIN;
}

/**
 * Band geometry for an applied pin state. `slotShowsOtherWorkspace` is true
 * when the regular workspace slot is standing in for a workspace other than
 * the selection's (scrolled past the selected workspace entirely), which
 * deepens the top clip band by that later header's seat.
 */
export function computeStickySelectedPinBand(
  state: StickySelectedPinState,
  metrics: StickySelectedItemMetrics,
  slotShowsOtherWorkspace: boolean,
): StickySelectedPinBand {
  const topGroupHeight = computeStickySelectedPinTopGroupHeight(state, metrics);
  const topClipExtension = state.top
    ? metrics.rowHeight +
      (metrics.groupHeaderHeight ?? 0) +
      (slotShowsOtherWorkspace ? metrics.headerHeight : 0)
    : 0;
  const bottomClipExtension =
    state.bottom === 'none'
      ? 0
      : metrics.rowHeight +
        (state.bottom === 'group-row' || state.bottom === 'header-group-row'
          ? (metrics.groupHeaderHeight ?? 0)
          : 0) +
        (state.bottom === 'header-row' || state.bottom === 'header-group-row'
          ? metrics.headerHeight
          : 0);
  return { topGroupHeight, topClipExtension, bottomClipExtension };
}

export function computeStickySelectedPinTopGroupHeight(
  state: StickySelectedPinState,
  metrics: StickySelectedItemMetrics,
): number {
  return state.top
    ? metrics.headerHeight +
        (metrics.groupHeaderHeight ?? 0) +
        metrics.rowHeight
    : 0;
}

export interface SelectedPinHosts {
  readonly topHeader: HTMLElement;
  readonly topRow: HTMLElement;
  readonly bottomHeader: HTMLElement;
  readonly bottomRow: HTMLElement;
  readonly topGroupHeader: HTMLElement | null;
  readonly bottomGroupHeader: HTMLElement | null;
}

/**
 * Finds the four pinned-copy hosts from anywhere inside the sidebar. Returns
 * null when either pin surface is absent (shared-sidebar host, workspaces
 * loading state), in which case callers must not portal pinned copies.
 */
export function findSelectedPinHosts(
  origin: HTMLElement | null,
): SelectedPinHosts | null {
  const sidebarRoot = origin?.closest<HTMLElement>(
    '[data-testid="app-sidebar"]',
  );
  if (!sidebarRoot) return null;
  const topGroup = sidebarRoot.querySelector<HTMLElement>(
    SELECTED_PIN_TOP_SELECTOR,
  );
  const bottomGroup = sidebarRoot.querySelector<HTMLElement>(
    SELECTED_PIN_BOTTOM_SELECTOR,
  );
  const topHeader = topGroup?.querySelector<HTMLElement>(
    SELECTED_PIN_HEADER_PART_SELECTOR,
  );
  const topRow = topGroup?.querySelector<HTMLElement>(
    SELECTED_PIN_ROW_PART_SELECTOR,
  );
  const bottomHeader = bottomGroup?.querySelector<HTMLElement>(
    SELECTED_PIN_HEADER_PART_SELECTOR,
  );
  const bottomRow = bottomGroup?.querySelector<HTMLElement>(
    SELECTED_PIN_ROW_PART_SELECTOR,
  );
  if (!topHeader || !topRow || !bottomHeader || !bottomRow) return null;
  return {
    topHeader,
    topRow,
    bottomHeader,
    bottomRow,
    topGroupHeader:
      topGroup?.querySelector<HTMLElement>(
        SELECTED_PIN_GROUP_HEADER_PART_SELECTOR,
      ) ?? null,
    bottomGroupHeader:
      bottomGroup?.querySelector<HTMLElement>(
        SELECTED_PIN_GROUP_HEADER_PART_SELECTOR,
      ) ?? null,
  };
}

/** The same six hosts (or both none), so a re-find can keep its state. */
export function sameSelectedPinHosts(
  a: SelectedPinHosts | null,
  b: SelectedPinHosts | null,
): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.topHeader === b.topHeader &&
    a.topRow === b.topRow &&
    a.bottomHeader === b.bottomHeader &&
    a.bottomRow === b.bottomRow &&
    a.topGroupHeader === b.topGroupHeader &&
    a.bottomGroupHeader === b.bottomGroupHeader
  );
}

/**
 * Pin-state decision for a selected Chats row. The Chats header sits above
 * the Projects band and stays stuck under the More row, so the row's top seat
 * is that header's seated bottom edge (`headerSeatBottom`, viewport-relative,
 * EXCLUDING any active Chats pin — including it would move the release line
 * down by the copy's own height).
 *
 * The bottom pin is the row alone: the header is on screen whenever its rows
 * are, so it never needs a copy of its own at the foot of the rail.
 */
export function computeChatsSelectedPinState(params: {
  scrollTop: number;
  clientHeight: number;
  headerSeatBottom: number;
  rowFlowTop: number;
  rowHeight: number;
}): StickySelectedPinState {
  const { scrollTop, clientHeight, headerSeatBottom, rowFlowTop, rowHeight } =
    params;
  const rowViewportTop = rowFlowTop - scrollTop;
  // Strictly past the seat, and never at rest: with nothing above Chats the
  // first row can sit exactly on the seat line at scrollTop 0.
  if (scrollTop > 0 && rowViewportTop < headerSeatBottom) {
    return { top: true, bottom: 'none' };
  }
  if (rowViewportTop > clientHeight - rowHeight) {
    return { top: false, bottom: 'row' };
  }
  return NO_SELECTED_PIN;
}

/**
 * Projects-band geometry for a Chats pin: none at the top, because the copy
 * seats above the band and the rail folds its height into the band's own seat
 * instead; the row's height at the bottom, where it shares the rail-foot group
 * with project selections.
 */
export function computeChatsSelectedPinBand(
  state: StickySelectedPinState,
  rowHeight: number,
): StickySelectedPinBand {
  return {
    topGroupHeight: 0,
    topClipExtension: 0,
    bottomClipExtension: state.bottom === 'none' ? 0 : rowHeight,
  };
}

export interface ChatsSelectedPinHosts {
  /** The row part of the seat under the Chats header. */
  readonly top: HTMLElement;
  /** The rail-foot group's row part, shared with project selections. */
  readonly bottomRow: HTMLElement;
}

/**
 * Finds the Chats pin hosts from anywhere inside the sidebar. Returns null
 * when the rail has no Chats seat (the web portal, which pins nothing, or a
 * loading state), in which case callers must not portal pinned copies.
 */
export function findChatsSelectedPinHosts(
  origin: HTMLElement | null,
): ChatsSelectedPinHosts | null {
  const sidebarRoot = origin?.closest<HTMLElement>(
    '[data-testid="app-sidebar"]',
  );
  if (!sidebarRoot) return null;
  const top = sidebarRoot
    .querySelector<HTMLElement>(CHATS_SELECTED_PIN_SELECTOR)
    ?.querySelector<HTMLElement>(SELECTED_PIN_ROW_PART_SELECTOR);
  const bottomRow = sidebarRoot
    .querySelector<HTMLElement>(SELECTED_PIN_BOTTOM_SELECTOR)
    ?.querySelector<HTMLElement>(SELECTED_PIN_ROW_PART_SELECTOR);
  if (!top || !bottomRow) return null;
  return { top, bottomRow };
}
