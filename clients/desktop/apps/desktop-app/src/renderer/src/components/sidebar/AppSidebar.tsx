import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import {
  Fragment,
  lazy,
  Suspense,
  type JSX,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { deriveSidebarNavRegions } from '@canopy/desktop-shared/lib/sidebar-nav-layout';
import { WORKSPACE_LABEL_PLURAL } from '@canopy/protocol/ui-labels';
import {
  ChevronDownIcon,
  ChevronDownMediumIcon,
  EditBigIcon,
  ExperimentIcon,
  PlusMediumIcon,
  SearchIcon,
  SettingsIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  ActionMenuRowStyle,
  DropdownMenuDivider,
  DropdownMenuItem,
  DropdownMenuItemIcon,
  type DropdownMenuItemStatus,
  DropdownMenuRowStyleProvider,
  DEFAULT_MENU_ROW_STYLE,
  QUIET_MENU_ROW_STYLE,
  FloatingMenu,
  FloatingMenuPointAnchor,
  SidebarMoreControl,
  SidebarNavMarker,
  useContextMenuPlacement,
} from '@canopy/ui-shared';
import {
  getSidebarNavItemDefs,
  type SidebarNavItemDef,
} from './sidebar-nav-items';
import {
  isSidebarNavigationHidden,
  measureSidebarNavigationThreshold,
} from './sidebar-navigation-visibility';
import { hasClaudeWorkerTerminalMode } from './workers-visibility';
import { WakeLockIndicator } from './WakeLockIndicator';
import { ResourceDiagnosticsPill } from '../resource-diagnostics/ResourceDiagnosticsPill';
import { DevBannerIcon } from './BannerGlyphs';
import { SidebarResizeHandle } from './SidebarResizeHandle';
import { SidebarAccountMenu } from './SidebarAccountMenu';
import { useDesktopWorkspaceContextAvailability } from '@/hooks/useDesktopWorkspaceContextSwitcher';
import { DesktopSidebarContextSwitcher } from './DesktopSidebarContextSwitcher';
import { SidebarFooterBanner } from './SidebarFooterBanner';
import { SidebarNavRow } from './SidebarNavRow';
import {
  activateSidebarNavItem,
  SidebarScrollArea,
} from '@canopy/ui-app/sidebar';
import {
  SidebarWorkspacesSection,
  MoreStickyLead,
} from './SidebarWorkspacesSection';
import { CustomizeSidebarModal } from './CustomizeSidebarModal';
import type { NavigationPage } from '@/stores/navigationStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useAppAdvisorStore } from '@/stores/appAdvisorStore';
import { ORCHESTRATOR_PAGE_EXPERIMENT_ID } from '@/lib/orchestratorPageExperiment';
import {
  AppAdvisorSidebarEntries,
  useAppAdvisorActiveEntryId,
  useAppAdvisorSidebarEntries,
} from '@/components/app-advisor/AppAdvisorSidebarEntries';
import {
  useLabsExperimentEnabled,
  useLabsHiddenSidebarKeys,
  useLabsOwnedSidebarKeys,
} from '@/stores/labsExperimentsStore';
import { useSidebarStore } from '@/stores/sidebarStore';
import {
  Surface,
  Badge,
  RailIconButton,
  RunningGlyph,
  ThinkingSpinner,
  TitlebarIconButton,
  useOverlayEscape,
} from '@canopy/ui-shared/components';
import {
  cancelSidebarPreviewClose,
  closeSidebarPreviewAndRefocusToggle,
  requestSidebarPreviewClose,
} from '@/lib/sidebar-preview-controller';
import { useObservabilityStore } from '@/stores/observabilityStore';
import { useResourceMonitorStore } from '@/stores/resourceMonitorStore';
import { subscribePreferencesUpdated } from '@/lib/preferences-events';
import { shouldSubscribeResourceMonitor } from '../sidebar-resource-monitor';
import { useAppBottomStatusHost } from '@/hooks/useAppBottomStatusHost';
import {
  shouldReserveSidebarTrafficLightRegion,
  sidebarMinWidthCss,
  sidebarMinWidthPx,
  titlebarCornerWidthCss,
  titlebarRowPaddingBottomCss,
  titlebarRowPaddingTopCss,
} from '../sidebar-layout';
import { readUiZoomFactor } from '@/lib/ui-zoom-factor';
import type { WorktreeDiffStatsStyle } from '@canopy/desktop-shared/types';
import {
  STICKY_WORKSPACE_SLOT_ROW_SELECTOR,
  STICKY_WORKSPACE_SLOT_SELECTOR,
} from '@canopy/ui-app/sidebar';
import {
  CHATS_SELECTED_ITEM_FLOW_SELECTOR,
  CHATS_SELECTED_PIN_SELECTOR,
  computeChatsSelectedPinBand,
  computeChatsSelectedPinState,
  computeStickySelectedPinBand,
  computeStickySelectedPinState,
  computeStickySelectedPinTopGroupHeight,
  NO_SELECTED_PIN,
  SELECTED_ITEM_FLOW_SELECTOR,
  SELECTED_PIN_BOTTOM_CLIP_VAR,
  SELECTED_PIN_BOTTOM_SELECTOR,
  SELECTED_PIN_HEADER_PART_SELECTOR,
  SELECTED_PIN_ROW_PART_SELECTOR,
  SELECTED_PIN_TOP_CLIP_VAR,
  SELECTED_PIN_TOP_HEIGHT_VAR,
  SELECTED_PIN_TOP_SELECTOR,
  type StickySelectedItemMetrics,
  type StickySelectedPinState,
} from '@canopy/ui-app/sidebar';
import {
  chatsContentHasRows,
  CHATS_CONTENT_SELECTOR,
  CHATS_HEADER_SELECTOR,
  CHATS_HEADER_STUCK_ATTR,
  isChatsContentOccluded,
} from '@canopy/ui-app/sidebar';
import { prefersReducedMotion } from '@canopy/ui-shared/lib';
import { formatShortcut as formatShortcutHint } from '@canopy/ui-shared/lib/shortcuts';
import { shouldShowProjectsPin } from '@canopy/ui-app/sidebar';
import {
  PROJECTS_HEADER_SELECTOR,
  PROJECTS_PIN_SELECTOR,
  SIDEBAR_ROOT_SELECTOR,
  SIDEBAR_VIEWPORT_SELECTOR,
  SIDEBAR_VIEWPORT_TEST_ID,
  STICKY_CONTROLS_SELECTOR,
} from '@canopy/ui-app/sidebar';
import { isDesktopSidebarShadowEnabled } from './desktop-sidebar-shadow-flag';
import { devPagesEntryTarget, isDevPage } from '@/components/pages/dev-pages';
import { isDesktopSharedSidebarEnabled } from './desktop-shared-sidebar-flag';
import { localPlatform } from '@/lib/local-platform';

const DesktopSidebarShadowPanel = lazy(() =>
  import('./DesktopSidebarShadowPanel').then((module) => ({
    default: module.DesktopSidebarShadowPanel,
  })),
);

const DesktopSidebarActivityToggle = lazy(() =>
  import('./DesktopSidebarActivityToggle').then((module) => ({
    default: module.DesktopSidebarActivityToggle,
  })),
);

const DesktopSharedSidebarHost = lazy(() =>
  import('./DesktopSharedSidebarHost').then((module) => ({
    default: module.DesktopSharedSidebarHost,
  })),
);

export interface AppSidebarProps {
  activePage: NavigationPage;
  onNavigate: (page: NavigationPage) => void;
  /**
   * A click on the current row: returns its section to the root, asking
   * about unsaved changes first.
   */
  onReturnToSectionRoot: (page: NavigationPage) => void;
  onSettingsClick: () => void;
  settingsOpen: boolean;
  /** Opens the Remote Control dialog from the account menu. */
  onCanopyPortalClick: () => void;
  /** Gates the Feed entry point behind `canopy-ledger-enabled`. */
  ledgerEnabled?: boolean;
  /**
   * Gates Claude Worker terminal-mode UI behind
   * `canopy-desktop-claude-tui-workers`.
   */
  claudeTuiWorkersEnabled: boolean;
  onAppAdvisorClick: () => void;
  /**
   * Mirror of the main-process App Advisor BrowserWindow visibility (sourced
   * from `useNavigationStore.appAdvisorOpen`). Drives the `aria-pressed`
   * reflection and the open-state color treatment.
   */
  appAdvisorOpen: boolean;
  /** True while any App Advisor chat tab has `status === 'streaming'`. */
  appAdvisorThinking: boolean;
  /**
   * True when App Advisor has unread output and the App Advisor window is
   * not currently focused. Drives blue unread styling on the nav button.
   */
  appAdvisorUnread: boolean;
  /** True while any Claude Worker card is queued, starting, or running. */
  workersActive: boolean;
}

// Shortcut hints read from the one registry (`formatShortcut(id)`).
const SEARCH_SHORTCUT = formatShortcutHint('open-command-palette');
const NEW_TASK_SHORTCUT = formatShortcutHint('new-task');
const STICKY_CONTROLS_TOP_PX = 1;
const NEW_TASK_MASK_EDGE_PX = 12;
const DEFAULT_WHEEL_LINE_HEIGHT_PX = 16;
const WORKSPACE_HEADER_TOP_VAR = '--sidebar-workspace-header-top';
/**
 * Height of the sticky Chats stack the Projects band stacks beneath: the
 * header, plus the selected chat's pinned copy while it is seated there.
 */
const CHATS_HEADER_HEIGHT_VAR = '--sidebar-chats-header-height';
/** Height of the pinned More row that tops the sticky stack. */
const MORE_HEIGHT_VAR = '--sidebar-more-height';

/**
 * Height of the occlusion band the scroll-driven clip keeps below the stuck
 * sticky controls: the 32px pinned workspace slot plus the 8px divider band.
 * Must match the `40px` term in `sidebar-workspace-flow-clip` (globals.css).
 */
const WORKSPACE_CLIP_BAND_PX = 40;

/** Height of the pinned workspace slot, matching its 2rem rule. */
const STICKY_WORKSPACE_SLOT_HEIGHT_PX = 32;
/**
 * The slot's height WHEN IT IS STANDING IN, and 0 when it is not.
 *
 * The band's depth was written as a flat 2rem for the slot, but the slot is
 * hidden whenever the selected-row pin already owns the header seat. The clip
 * then reserved 32px nothing was painting, leaving a strip of rail showing
 * neither band nor row directly under the pinned selection.
 */
const WORKSPACES_SLOT_HEIGHT_VAR = '--sidebar-workspaces-slot-height';

/** The label's live distance below the seat; consumed only by the projections. */
const EXTERNAL_PROJECTS_HEADER_OFFSET_VAR =
  '--sidebar-external-projects-header-offset';

/**
 * How far below the band's seat a host-rendered Projects label currently sits.
 *
 * The label sticks to the seat, but until it gets there it is still
 * travelling down the list, and the copies projected into the band are
 * positioned from this value. As a constant height it claimed the label was
 * already seated and the first project was painted ABOVE its own label.
 * Gating the projections until it seated fixed that picture and broke a
 * worse one: the clip is a pure function of scroll and keeps biting, so the
 * band cut the first project in half with nothing standing in. The clip and
 * the stand-in have to agree, which means tracking the label.
 *
 * Two deliberate scopings. It is written on the CONTROLS, where the slot and
 * the pin live, and not on the viewport — a custom property inherits, and on
 * the viewport a value that changes every frame the label moves restyled the
 * whole rail, Chats list included. And it is a SEPARATE property from the
 * header height: the clip and the row fade keep reading the height, because
 * they describe the band once it is occluding and must not shift while
 * nothing is stuck yet — feeding them the live value dimmed rows at rest.
 * Placement only: the handoff arithmetic reads the static height too, since
 * an activation window that grew with the label's distance stood the slot in
 * from scrollTop 0 whenever the label started far below its seat.
 */
function syncExternalProjectsHeaderOffset(
  viewport: HTMLElement,
  layout: StickyWorkspaceRailLayout,
  scrollTop: number,
): void {
  const { externalProjectsHeaderFlowTop, externalProjectsHeaderHeight } =
    layout;
  if (externalProjectsHeaderFlowTop === null) return;
  const seat = readPxVar(viewport, WORKSPACE_HEADER_TOP_VAR);
  const naturalTop = externalProjectsHeaderFlowTop - scrollTop;
  const offset = Math.round(
    Math.max(
      externalProjectsHeaderHeight,
      Math.max(seat, naturalTop) + externalProjectsHeaderHeight - seat,
    ),
  );
  const target = layout.stickyControls;
  if (target) {
    const value = `${offset}px`;
    if (
      target.style.getPropertyValue(EXTERNAL_PROJECTS_HEADER_OFFSET_VAR) !==
      value
    ) {
      target.style.setProperty(EXTERNAL_PROJECTS_HEADER_OFFSET_VAR, value);
    }
  }
}

function syncWorkspacesSlotHeightVar(
  viewport: HTMLElement,
  slotActive: boolean,
): void {
  const value = slotActive ? `${STICKY_WORKSPACE_SLOT_HEIGHT_PX}px` : '0px';
  if (viewport.style.getPropertyValue(WORKSPACES_SLOT_HEIGHT_VAR) !== value) {
    viewport.style.setProperty(WORKSPACES_SLOT_HEIGHT_VAR, value);
  }
}

/** Reads a px-valued custom property off an element, 0 when unset. */
function readPxVar(element: HTMLElement, name: string): number {
  const raw = element.style.getPropertyValue(name).trim();
  if (raw.length === 0) return 0;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Height of the selected chat's copy while it is seated under the Chats
 * header, per viewport; absent while it is not.
 *
 * The copy stacks between the Chats header and the Projects band, so while it
 * is up it is part of the sticky stack: the band seats beneath it, the Chats
 * rows are cut at its bottom rather than the header's, and the band sticks
 * that much earlier. Folding it into the Chats header term keeps every one of
 * those offsets derived from the one measurement they already share.
 */
const chatsSelectedPinHeight = new WeakMap<HTMLElement, number>();

/**
 * The line the selected chat slides under: the seated Chats header's bottom,
 * viewport-relative. Read from the stack vars rather than measured, so it is
 * free on the scroll path; the pinned copy is subtracted back out because the
 * row is released when it clears the header, not the copy.
 */
function chatsHeaderSeatBottom(viewport: HTMLElement): number {
  return (
    STICKY_CONTROLS_TOP_PX +
    readPxVar(viewport, MORE_HEIGHT_VAR) +
    readPxVar(viewport, CHATS_HEADER_HEIGHT_VAR) -
    (chatsSelectedPinHeight.get(viewport) ?? 0)
  );
}

/**
 * Seats or releases the selected chat's copy in the sticky stack and, when
 * that changes the stack, republishes the offsets derived from it. Returns
 * whether it changed; callers then refresh the clip geometry (and any cached
 * threshold) too. Runs only on the transition, never per frame.
 */
function syncChatsSelectedPinHeight(
  viewport: HTMLElement,
  height: number,
): boolean {
  if ((chatsSelectedPinHeight.get(viewport) ?? 0) === height) return false;
  if (height > 0) {
    chatsSelectedPinHeight.set(viewport, height);
  } else {
    chatsSelectedPinHeight.delete(viewport);
  }
  syncStickyWorkspaceHeaderOffset(viewport);
  return true;
}

/**
 * Every layout read the header-offset publication needs, taken before any of
 * its writes. Each value below is published as a custom property on the
 * viewport, and a custom property restyles every descendant that inherits it:
 * reading a height after such a write forces that whole-rail restyle
 * synchronously. Interleaving three reads with three writes cost three full
 * restyles of a large rail in one frame. None of the writes can move a value
 * read here: they set the sticky `top` of the Chats header, the selected
 * chat's seat and the Projects header, and vars that only position or clip,
 * never size, the measured elements.
 */
interface StickyWorkspaceHeaderOffsetMeasurement {
  readonly chatsHeader: HTMLElement | null;
  readonly chatsHeaderHeight: number;
  readonly moreHeight: number;
  readonly stickyControlsHeight: number;
  readonly projectsHeader: HTMLElement | null;
  readonly projectsHeaderHeight: number;
}

function measureStickyWorkspaceHeaderOffset(
  viewport: HTMLElement,
): StickyWorkspaceHeaderOffsetMeasurement | null {
  const stickyControls = viewport.querySelector<HTMLElement>(
    STICKY_CONTROLS_SELECTOR,
  );
  if (!stickyControls) return null;
  const chatsHeader = viewport.querySelector<HTMLElement>(
    CHATS_HEADER_SELECTOR,
  );
  const moreLead = viewport.querySelector<HTMLElement>(
    '[data-sidebar-more-lead]',
  );
  const projectsHeader = resolveExternalProjectsHeader(
    viewport,
    stickyControls,
  );
  return {
    chatsHeader,
    chatsHeaderHeight: chatsHeader?.offsetHeight ?? 0,
    moreHeight: moreLead?.offsetHeight ?? 0,
    stickyControlsHeight: stickyControls.getBoundingClientRect().height,
    projectsHeader,
    projectsHeaderHeight: projectsHeader?.offsetHeight ?? 0,
  };
}

/**
 * Publishes the natural-flow threshold at which a workspace identity moves
 * into the dedicated slot. The slot itself is a stable child of the controls
 * group and therefore never needs to be translated or repositioned. Writes
 * only: the caller measures first (`measureStickyWorkspaceHeaderOffset`).
 */
function applyStickyWorkspaceHeaderOffset(
  viewport: HTMLElement,
  measurement: StickyWorkspaceHeaderOffsetMeasurement | null,
): void {
  if (!measurement) {
    viewport.style.removeProperty(WORKSPACE_HEADER_TOP_VAR);
    return;
  }
  const {
    chatsHeader,
    chatsHeaderHeight,
    moreHeight,
    stickyControlsHeight,
    projectsHeader,
    projectsHeaderHeight,
  } = measurement;
  // Has the Projects band scrolled off the bottom of the rail? An expanded
  // Chats list puts it hundreds of rows down, and `position: sticky` cannot
  // help: it never lifts an element above its own place in the flow, and the
  // band's containing block begins exactly where the band sits. Chats is a
  // top-level SIBLING of Projects by contract (`chatsOutsideProjects`), so
  // widening that block is not available either.
  //
  // The Chats header sticks above the Projects controls, so the band's
  // bottom — the line every workspace-slot and clip offset is measured from —
  // sits that much lower (CAN-2363).
  // The selected chat's copy, while it is seated under the header, is part of
  // the stack everything below seats beneath. A map read, not a layout read.
  const chatsStackHeight =
    chatsHeaderHeight +
    (chatsHeader !== null ? (chatsSelectedPinHeight.get(viewport) ?? 0) : 0);
  const chatsHeaderValue = `${chatsStackHeight}px`;
  if (
    viewport.style.getPropertyValue(CHATS_HEADER_HEIGHT_VAR) !==
    chatsHeaderValue
  ) {
    viewport.style.setProperty(CHATS_HEADER_HEIGHT_VAR, chatsHeaderValue);
  }
  const moreValue = `${moreHeight}px`;
  if (viewport.style.getPropertyValue(MORE_HEIGHT_VAR) !== moreValue) {
    viewport.style.setProperty(MORE_HEIGHT_VAR, moreValue);
  }
  // Seat the Chats header directly under the pinned More row from this same
  // pass. Driving it imperatively keeps the stack's two offsets derived from
  // one measurement instead of two independent var resolutions.
  const chatsHeaderTop = `${STICKY_CONTROLS_TOP_PX + moreHeight}px`;
  if (chatsHeader !== null && chatsHeader.style.top !== chatsHeaderTop) {
    chatsHeader.style.top = chatsHeaderTop;
  }
  // The selected chat's seat is the header's zero-height sibling, stuck at
  // the header's bottom edge.
  const chatsPinSeat = viewport.querySelector<HTMLElement>(
    CHATS_SELECTED_PIN_SELECTOR,
  );
  const chatsPinSeatTop = `${
    STICKY_CONTROLS_TOP_PX + moreHeight + chatsHeaderHeight
  }px`;
  if (chatsPinSeat !== null && chatsPinSeat.style.top !== chatsPinSeatTop) {
    chatsPinSeat.style.top = chatsPinSeatTop;
  }
  // The band's bottom is the whole sticky stack: More, then the Chats header
  // (and a selected chat seated under it), then the controls themselves.
  const value = `${
    stickyControlsHeight +
    STICKY_CONTROLS_TOP_PX +
    moreHeight +
    chatsStackHeight
  }px`;
  if (viewport.style.getPropertyValue(WORKSPACE_HEADER_TOP_VAR) !== value) {
    viewport.style.setProperty(WORKSPACE_HEADER_TOP_VAR, value);
  }
  // A host-rendered Projects header sits BELOW the band rather than inside it,
  // so it inherits none of the band's seating and would otherwise pin at the
  // viewport's top edge, on top of More and the Chats header. The band's
  // bottom — just computed — is exactly where the legacy header sits, so seat
  // it there. The legacy header is a child of the band and carries no mark,
  // so this never touches it.
  if (projectsHeader !== null && projectsHeader.style.top !== value) {
    projectsHeader.style.top = value;
  }
  // The selected-item pin group is ABSOLUTELY positioned at the band's bottom
  // edge, so it contributes nothing to the band's measured height and lands on
  // exactly the offset a host-rendered Projects header was just seated at —
  // the two drew over each other. Publish that header's height so the group
  // clears it. The legacy rail renders its header INSIDE the band, leaves this
  // unset, and is unaffected.
  const externalProjectsHeight = `${projectsHeaderHeight}px`;
  if (
    viewport.style.getPropertyValue(EXTERNAL_PROJECTS_HEADER_HEIGHT_VAR) !==
    externalProjectsHeight
  ) {
    viewport.style.setProperty(
      EXTERNAL_PROJECTS_HEADER_HEIGHT_VAR,
      externalProjectsHeight,
    );
  }
  // Reserve the whole stack so programmatic scrolls (pending-worktree reveal,
  // selected-row restore) land below it rather than under it.
  if (viewport.style.scrollPaddingTop !== value) {
    viewport.style.scrollPaddingTop = value;
  }
}

/**
 * Measures, then publishes. For the callers outside the layout pass, which
 * republish only when the selected chat's copy seats or releases; the layout
 * pass takes the measurement before any of its writes and applies it later.
 */
function syncStickyWorkspaceHeaderOffset(viewport: HTMLElement): void {
  applyStickyWorkspaceHeaderOffset(
    viewport,
    measureStickyWorkspaceHeaderOffset(viewport),
  );
}

interface StickyWorkspaceSectionClip {
  readonly workspaceId: string;
  readonly header: HTMLElement;
  readonly headerFlowTop: number;
  readonly headerHeight: number;
  readonly rows: HTMLElement | null;
}

/**
 * Publishes the geometry the scroll-driven workspace clip animation needs.
 * The clip itself is pure CSS (a scroll-timeline animation over these vars),
 * so it stays correct on every composited frame with no per-scroll JS — but
 * that only holds while these vars are current, including at rest: a trackpad
 * fling delivers non-cancelable wheel events and paints frames before any
 * scroll handler runs, so the vars must already be correct before the
 * first scrolled frame. Called from every layout pass (cheap: two reads on
 * elements the observer callback has already laid out) and from the full
 * rail-layout cache build. Returns the measured sticky threshold, or null
 * when the workspace surfaces are absent.
 */
/**
 * The scroll offset at which the project rows reach the sticky controls' line
 * — i.e. when the band starts occluding them and the dedicated slot takes
 * over a workspace identity.
 *
 * This is the sticky sentinel's offset plus the height of anything rendered
 * between it and the project rows. The sentinel alone was correct only while
 * the rows began immediately after it; the Chats section (CAN-2363) now sits
 * in between and pushes them down by exactly its own height. With no such
 * section the term is zero and this is the previous value unchanged.
 */
function computeWorkspacesStickyThreshold(
  viewport: HTMLElement,
  sentinelOffsetTop: number,
): number {
  const chatsSection = viewport.querySelector<HTMLElement>(
    CHATS_CONTENT_SELECTOR,
  );
  // A selected chat seated under the Chats header lowers the band's seat by
  // its height, so the band reaches that seat — and sticks — that much sooner.
  return (
    sentinelOffsetTop +
    (chatsSection?.offsetHeight ?? 0) -
    (chatsSelectedPinHeight.get(viewport) ?? 0)
  );
}

/** The clip geometry `applyWorkspaceClipGeometryVars` publishes, measured. */
interface WorkspaceClipGeometry {
  readonly workspacesContent: HTMLElement;
  readonly stickyThreshold: number;
  readonly flowTop: string;
  readonly clipStart: string;
  readonly clipDistance: string;
  readonly bottomClipStart: string;
  readonly clipTotal: string;
}

/** Layout reads only; see `applyWorkspaceClipGeometryVars` for the writes. */
function measureWorkspaceClipGeometry(
  viewport: HTMLElement,
): WorkspaceClipGeometry | null {
  const stickySentinel = viewport.querySelector<HTMLElement>(
    '[data-testid="sidebar-sticky-workspace-sentinel"]',
  );
  const workspacesContent = viewport.querySelector<HTMLElement>(
    WORKSPACES_ROWS_SELECTOR,
  );
  // These three blocks deliberately run BEFORE the project-content guard
  // below: collapsing Projects unmounts `[data-sidebar-section-content]`, and
  // the Chats header stays on screen in that state, so its geometry must keep
  // refreshing or the trailing clip goes stale and chat rows paint through
  // the transparent pinned header.
  if (!stickySentinel || !workspacesContent) return null;
  const viewportScrollHeight = viewport.scrollHeight;
  const viewportClientHeight = viewport.clientHeight;
  const workspacesContentFlowTop =
    getLayoutOffsetTop(workspacesContent) - getLayoutOffsetTop(viewport);
  const stickyThreshold = computeWorkspacesStickyThreshold(
    viewport,
    stickySentinel.offsetTop,
  );
  const workspacesContentHeight = workspacesContent.offsetHeight;
  const clipStart = `${stickyThreshold}px`;
  // Deliberately unclamped: the animation's `to` state is the clip at
  // maximum scroll, and the timeline resolves to 100% progress whenever the
  // viewport cannot scroll at all. A sidebar whose content cannot reach the
  // sticky threshold needs a `to` value below 40px — negative down to the
  // `from` value at zero overflow — or the resolved end state would clip the
  // first workspace header while nothing is stuck.
  const clipDistance = `${viewportScrollHeight - viewportClientHeight - stickyThreshold}px`;
  const bottomClipStart = `${workspacesContentFlowTop + workspacesContentHeight - viewportClientHeight}px`;
  const clipTotal = `${viewportScrollHeight - viewportClientHeight}px`;
  // The rows layer's offset within the scroll CONTENT. Every other term of the
  // band's bottom edge is already a custom property the rail keeps current, so
  // publishing this one lets the clip line track the band in CSS instead of
  // being re-measured. Measurement could not keep up: the band's depth changes
  // continuously as pins activate and headers hand off, while measuring it per
  // frame is exactly what the scroll hot path forbids.
  return {
    workspacesContent,
    stickyThreshold,
    flowTop: `${workspacesContentFlowTop}px`,
    clipStart,
    clipDistance,
    bottomClipStart,
    clipTotal,
  };
}

/** Writes measured clip geometry; returns its sticky threshold, or null. */
function applyWorkspaceClipGeometryVars(
  geometry: WorkspaceClipGeometry | null,
): number | null {
  if (!geometry) return null;
  const {
    workspacesContent,
    stickyThreshold,
    flowTop,
    clipStart,
    clipDistance,
    bottomClipStart,
    clipTotal,
  } = geometry;
  if (
    workspacesContent.style.getPropertyValue(
      '--sidebar-workspaces-flow-top',
    ) !== flowTop
  ) {
    workspacesContent.style.setProperty(
      '--sidebar-workspaces-flow-top',
      flowTop,
    );
  }
  if (
    workspacesContent.style.getPropertyValue(
      '--sidebar-workspaces-clip-start',
    ) !== clipStart
  ) {
    workspacesContent.style.setProperty(
      '--sidebar-workspaces-clip-start',
      clipStart,
    );
  }
  if (
    workspacesContent.style.getPropertyValue(
      '--sidebar-workspaces-clip-distance',
    ) !== clipDistance
  ) {
    workspacesContent.style.setProperty(
      '--sidebar-workspaces-clip-distance',
      clipDistance,
    );
  }
  // Bottom clip geometry for the selected-item bottom pin. With no pin the
  // interpolated bottom inset holds the clip line exactly at the viewport's
  // bottom edge (clipping nothing visible); the pin var deepens it by the
  // pinned group. Published on every geometry pass so the always-on clip is
  // correct on the first composited frame of a fling, matching the top band.
  if (
    workspacesContent.style.getPropertyValue(
      '--sidebar-workspaces-bottom-clip-start',
    ) !== bottomClipStart
  ) {
    workspacesContent.style.setProperty(
      '--sidebar-workspaces-bottom-clip-start',
      bottomClipStart,
    );
  }
  if (
    workspacesContent.style.getPropertyValue(
      '--sidebar-workspaces-clip-total',
    ) !== clipTotal
  ) {
    workspacesContent.style.setProperty(
      '--sidebar-workspaces-clip-total',
      clipTotal,
    );
  }
  return stickyThreshold;
}

function syncWorkspaceClipGeometryVars(viewport: HTMLElement): number | null {
  return applyWorkspaceClipGeometryVars(measureWorkspaceClipGeometry(viewport));
}

interface StickySelectedPinLayout {
  /**
   * Which seat the top copy takes: under the row's project header below the
   * Projects band, or under the sticky Chats header above it.
   */
  readonly seat: 'project' | 'chats';
  readonly flowRow: HTMLElement;
  readonly flowHeader: HTMLElement | null;
  readonly flowGroupHeader: HTMLElement | null;
  readonly topGroupHeaderPart: HTMLElement | null;
  readonly bottomGroupHeaderPart: HTMLElement | null;
  readonly workspaceId: string | null;
  readonly metrics: StickySelectedItemMetrics;
  readonly topGroup: HTMLElement;
  /** The other seat's top host, kept hidden while this seat owns the pin. */
  readonly otherTopGroup: HTMLElement | null;
  readonly bottomGroup: HTMLElement;
  readonly bottomHeaderPart: HTMLElement;
}

interface StickyWorkspaceRailLayout {
  /** Rewritten in place when a selected chat's copy changes the stack. */
  stickyThreshold: number;
  /**
   * The Projects band and the footer stand-in whose visibility it drives.
   *
   * Only the element handles are cached; the comparison reads live rects on
   * each scroll. Caching the band's *position* is what broke this: the band is
   * `position: sticky`, Blink reports a stuck element's `offsetTop` at its
   * stuck position rather than its flow position, and the layout build is
   * deferred at `scrollTop === 0` — so the cached origin was whatever the band
   * happened to be doing at the first scroll, and the pin could stop appearing
   * entirely.
   *
   * Two rect reads per scroll event are affordable because this toggles a DOM
   * attribute rather than painting. The must-be-a-pure-function-of-scroll rule
   * belongs to the composited clip — a fling presents frames before any
   * handler runs — and that clip is gone; a stand-in that appears one frame
   * late is invisible to the user.
   */
  readonly stickyControls: HTMLElement | null;
  readonly projectsPin: HTMLElement | null;
  readonly primaryNavigation: HTMLElement | null;
  readonly primaryNavigationOffsetTop: number;
  readonly chatsSection: HTMLElement | null;
  readonly chatsSectionOffsetTop: number;
  /**
   * Cached separately from `chatsSection`: collapsing Chats unmounts the rows
   * but leaves the header on screen, and that is exactly the pass that has to
   * clear the stuck mark.
   */
  readonly chatsHeader: HTMLElement | null;
  /** Flow offset of a host-rendered Projects header, or null when inside the band. */
  readonly externalProjectsHeaderFlowTop: number | null;
  readonly externalProjectsHeaderHeight: number;
  /**
   * The band the Projects stand-in's visibility is measured against, resolved
   * ONCE here. The scroll hot path must not query the DOM — that is what this
   * cache is for — and an unconditional `querySelector` per frame is exactly
   * the regression the layout-cache test guards.
   */
  readonly projectsPinAnchor: HTMLElement | null;
  readonly workspacesContent: HTMLElement | null;
  readonly stickyWorkspaceSlot: HTMLElement | null;
  readonly stickySlotRows: ReadonlyMap<string, HTMLElement>;
  readonly stickySlotRowHeights: ReadonlyMap<string, number>;
  readonly wheelLineHeight: number;
  readonly viewportClientHeight: number;
  readonly workspaceSections: readonly StickyWorkspaceSectionClip[];
  readonly selectedPin: StickySelectedPinLayout | null;
  activeStickySlotRow: HTMLElement | null;
  incomingStickySlotRow: HTMLElement | null;
  incomingFlowHeader: HTMLElement | null;
  activeFlowSectionIndex: number;
  lastSyncedScrollTop: number | null;
  stickyControlsVisible: boolean;
}

/**
 * The flow row most recently marked inert because a pinned copy stands in.
 * Tracked per viewport (not re-queried) so a selection change can never
 * strand a stale `inert` on a row that no longer carries the selected mark.
 */
const stickySelectedPinInertRow = new WeakMap<HTMLElement, HTMLElement>();
const stickySelectedPinInertHeader = new WeakMap<HTMLElement, HTMLElement>();
const stickySelectedPinInertGroupHeader = new WeakMap<
  HTMLElement,
  HTMLElement
>();

function syncFlowHeaderAccessibility(header: HTMLElement): void {
  const covered =
    header.dataset.sidebarStickyFlowHidden === 'true' ||
    header.dataset.sidebarSelectedPinFlowHidden === 'true';
  header.inert = covered;
  if (covered) {
    header.setAttribute('aria-hidden', 'true');
  } else {
    header.removeAttribute('aria-hidden');
  }
}

/**
 * Measures the selected-item pin surfaces: the marked in-flow row, its
 * owning workspace header, and the two host groups the selected section
 * portals its pinned copies into. Returns null when nothing is selected, the
 * selected row is not currently laid out (collapsed/fading section), or the
 * pinned copies have not been portaled in (shared-sidebar host, loading
 * state) — revealing an empty pin band would clip rows nothing replaces.
 */
function measureStickySelectedPin(
  viewport: HTMLElement,
): StickySelectedPinLayout | null {
  const flowRow = viewport.querySelector<HTMLElement>(
    SELECTED_ITEM_FLOW_SELECTOR,
  );
  if (!flowRow) return measureChatsSelectedPin(viewport);
  if (flowRow.offsetParent === null || flowRow.offsetHeight === 0) {
    return null;
  }
  const workspaceRoot = flowRow.closest<HTMLElement>(
    '[data-sidebar-workspace-id]',
  );
  const header =
    workspaceRoot?.querySelector<HTMLElement>(
      '.sidebar-workspace-sticky-header',
    ) ?? null;
  if (!workspaceRoot) return null;
  const sidebarRoot = viewport.closest<HTMLElement>(SIDEBAR_ROOT_SELECTOR);
  const topGroup = viewport.querySelector<HTMLElement>(
    SELECTED_PIN_TOP_SELECTOR,
  );
  const bottomGroup =
    sidebarRoot?.querySelector<HTMLElement>(SELECTED_PIN_BOTTOM_SELECTOR) ??
    null;
  const topHeaderPart = topGroup?.querySelector<HTMLElement>(
    SELECTED_PIN_HEADER_PART_SELECTOR,
  );
  const topRowPart = topGroup?.querySelector<HTMLElement>(
    SELECTED_PIN_ROW_PART_SELECTOR,
  );
  const bottomHeaderPart = bottomGroup?.querySelector<HTMLElement>(
    SELECTED_PIN_HEADER_PART_SELECTOR,
  );
  const bottomRowPart = bottomGroup?.querySelector<HTMLElement>(
    SELECTED_PIN_ROW_PART_SELECTOR,
  );
  if (
    !topGroup ||
    !bottomGroup ||
    !bottomHeaderPart ||
    topHeaderPart?.childElementCount === undefined ||
    topRowPart?.childElementCount === undefined ||
    topRowPart.childElementCount === 0 ||
    bottomRowPart?.childElementCount === undefined ||
    bottomRowPart.childElementCount === 0
  ) {
    return null;
  }
  const groupRoot = flowRow.closest<HTMLElement>(
    '[data-sidebar-item-group-id]',
  );
  const flowGroupHeader =
    groupRoot?.querySelector<HTMLElement>('[data-sidebar-item-group-header]') ??
    null;
  const topGroupHeaderPart = topGroup.querySelector<HTMLElement>(
    '[data-sidebar-selected-pin-part="group-header"]',
  );
  const bottomGroupHeaderPart = bottomGroup.querySelector<HTMLElement>(
    '[data-sidebar-selected-pin-part="group-header"]',
  );
  const groupHeaderHeight = flowGroupHeader?.offsetHeight ?? 0;
  if (
    groupHeaderHeight > 0 &&
    (!topGroupHeaderPart?.childElementCount ||
      !bottomGroupHeaderPart?.childElementCount)
  )
    return null;
  const viewportFlowTop = getLayoutOffsetTop(viewport);
  return {
    seat: 'project',
    flowRow,
    flowGroupHeader,
    topGroupHeaderPart,
    bottomGroupHeaderPart,
    flowHeader: header,
    workspaceId: workspaceRoot.dataset.sidebarWorkspaceId ?? null,
    metrics: {
      rowFlowTop: getLayoutOffsetTop(flowRow) - viewportFlowTop,
      rowHeight: flowRow.offsetHeight,
      headerFlowTop: header
        ? getLayoutOffsetTop(header) - viewportFlowTop
        : getLayoutOffsetTop(workspaceRoot) - viewportFlowTop,
      headerHeight: header?.offsetHeight ?? 0,
      groupHeaderHeight,
      // The header is sticky and reports its stuck offset; it is always the
      // first in-flow child of its group, so the group's top is its flow top.
      groupHeaderFlowTop:
        flowGroupHeader && groupRoot
          ? getLayoutOffsetTop(groupRoot) - viewportFlowTop
          : 0,
    },
    topGroup,
    otherTopGroup: viewport.querySelector<HTMLElement>(
      CHATS_SELECTED_PIN_SELECTOR,
    ),
    bottomGroup,
    bottomHeaderPart,
  };
}

/**
 * The Chats counterpart of `measureStickySelectedPin`: the selected chat row,
 * the seat under the Chats header, and the rail-foot group. Null under the
 * same conditions — nothing selected, the row not laid out, or the copies not
 * portaled in. A collapsed Chats section still lays out its selected row (and
 * only that row), so it pins exactly as it does expanded.
 */
function measureChatsSelectedPin(
  viewport: HTMLElement,
): StickySelectedPinLayout | null {
  const flowRow = viewport.querySelector<HTMLElement>(
    CHATS_SELECTED_ITEM_FLOW_SELECTOR,
  );
  if (!flowRow || flowRow.offsetParent === null || flowRow.offsetHeight === 0) {
    return null;
  }
  const seat = viewport.querySelector<HTMLElement>(CHATS_SELECTED_PIN_SELECTOR);
  const seatRowPart = seat?.querySelector<HTMLElement>(
    SELECTED_PIN_ROW_PART_SELECTOR,
  );
  const bottomGroup =
    viewport
      .closest<HTMLElement>(SIDEBAR_ROOT_SELECTOR)
      ?.querySelector<HTMLElement>(SELECTED_PIN_BOTTOM_SELECTOR) ?? null;
  const bottomHeaderPart = bottomGroup?.querySelector<HTMLElement>(
    SELECTED_PIN_HEADER_PART_SELECTOR,
  );
  const bottomRowPart = bottomGroup?.querySelector<HTMLElement>(
    SELECTED_PIN_ROW_PART_SELECTOR,
  );
  if (
    !seat ||
    !bottomGroup ||
    !bottomHeaderPart ||
    !seatRowPart ||
    seatRowPart.childElementCount === 0 ||
    !bottomRowPart ||
    bottomRowPart.childElementCount === 0
  ) {
    return null;
  }
  const rowFlowTop = getLayoutOffsetTop(flowRow) - getLayoutOffsetTop(viewport);
  return {
    seat: 'chats',
    flowGroupHeader: null,
    topGroupHeaderPart: null,
    bottomGroupHeaderPart: null,
    flowRow,
    // The Chats header is never copied: it stays stuck on screen whenever
    // its rows are.
    flowHeader: null,
    workspaceId: null,
    metrics: {
      rowFlowTop,
      rowHeight: flowRow.offsetHeight,
      headerFlowTop: rowFlowTop,
      headerHeight: 0,
    },
    topGroup: seat,
    otherTopGroup: viewport.querySelector<HTMLElement>(
      SELECTED_PIN_TOP_SELECTOR,
    ),
    bottomGroup,
    bottomHeaderPart,
  };
}

function setPinSurfaceActive(surface: HTMLElement, active: boolean): void {
  if (surface.hidden !== !active) {
    surface.hidden = !active;
  }
  surface.inert = !active;
  if (active) {
    surface.removeAttribute('aria-hidden');
  } else {
    surface.setAttribute('aria-hidden', 'true');
  }
}

function setPinLengthVar(
  viewport: HTMLElement,
  name: string,
  value: number,
): void {
  if (value > 0) {
    viewport.style.setProperty(name, `${value}px`);
  } else {
    viewport.style.removeProperty(name);
  }
}

/** Clears every applied selected-pin surface, var, and flow-row covering. */
function resetStickySelectedPin(viewport: HTMLElement): void {
  const inertRow = stickySelectedPinInertRow.get(viewport);
  if (inertRow) {
    delete inertRow.dataset.sidebarSelectedPinFlowHidden;
    inertRow.inert = false;
    inertRow.removeAttribute('aria-hidden');
    stickySelectedPinInertRow.delete(viewport);
  }
  const inertGroupHeader = stickySelectedPinInertGroupHeader.get(viewport);
  if (inertGroupHeader) {
    delete inertGroupHeader.dataset.sidebarSelectedPinFlowHidden;
    inertGroupHeader.inert = false;
    inertGroupHeader.removeAttribute('aria-hidden');
    stickySelectedPinInertGroupHeader.delete(viewport);
  }
  const inertHeader = stickySelectedPinInertHeader.get(viewport);
  if (inertHeader) {
    delete inertHeader.dataset.sidebarSelectedPinFlowHidden;
    syncFlowHeaderAccessibility(inertHeader);
    stickySelectedPinInertHeader.delete(viewport);
  }
  if (viewport.dataset.sidebarSelectedPinApplied !== 'true') return;
  delete viewport.dataset.sidebarSelectedPinApplied;
  viewport.style.removeProperty(SELECTED_PIN_TOP_HEIGHT_VAR);
  viewport.style.removeProperty(SELECTED_PIN_TOP_CLIP_VAR);
  viewport.style.removeProperty(SELECTED_PIN_BOTTOM_CLIP_VAR);
  const topGroup = viewport.querySelector<HTMLElement>(
    SELECTED_PIN_TOP_SELECTOR,
  );
  const bottomGroup = viewport
    .closest<HTMLElement>(SIDEBAR_ROOT_SELECTOR)
    ?.querySelector<HTMLElement>(SELECTED_PIN_BOTTOM_SELECTOR);
  if (topGroup) setPinSurfaceActive(topGroup, false);
  if (bottomGroup) setPinSurfaceActive(bottomGroup, false);
  const chatsSeat = viewport.querySelector<HTMLElement>(
    CHATS_SELECTED_PIN_SELECTOR,
  );
  if (chatsSeat) setPinSurfaceActive(chatsSeat, false);
}

/**
 * Applies a computed pin state: reveals/hides the pinned copy groups, sizes
 * the clip-band vars, and covers the in-flow original while a copy stands in.
 */
function applyStickySelectedPin(
  viewport: HTMLElement,
  pin: StickySelectedPinLayout,
  state: StickySelectedPinState,
  band: {
    topGroupHeight: number;
    topClipExtension: number;
    bottomClipExtension: number;
  },
): void {
  const anyPin = state.top || state.bottom !== 'none';
  if (!anyPin) {
    resetStickySelectedPin(viewport);
    return;
  }
  viewport.dataset.sidebarSelectedPinApplied = 'true';
  setPinLengthVar(viewport, SELECTED_PIN_TOP_HEIGHT_VAR, band.topGroupHeight);
  setPinLengthVar(viewport, SELECTED_PIN_TOP_CLIP_VAR, band.topClipExtension);
  setPinLengthVar(
    viewport,
    SELECTED_PIN_BOTTOM_CLIP_VAR,
    band.bottomClipExtension,
  );
  setPinSurfaceActive(pin.topGroup, state.top);
  if (pin.otherTopGroup && !pin.otherTopGroup.hidden) {
    setPinSurfaceActive(pin.otherTopGroup, false);
  }
  setPinSurfaceActive(pin.bottomGroup, state.bottom !== 'none');
  const hasProjectHeader =
    state.bottom === 'header-row' || state.bottom === 'header-group-row';
  const hasGroupHeader =
    state.bottom === 'group-row' || state.bottom === 'header-group-row';
  if (pin.topGroupHeaderPart)
    setPinSurfaceActive(
      pin.topGroupHeaderPart,
      state.top && (pin.metrics.groupHeaderHeight ?? 0) > 0,
    );
  if (pin.bottomGroupHeaderPart)
    setPinSurfaceActive(pin.bottomGroupHeaderPart, hasGroupHeader);
  const bottomHeaderHidden = !hasProjectHeader;
  if (pin.bottomHeaderPart.hidden !== bottomHeaderHidden) {
    pin.bottomHeaderPart.hidden = bottomHeaderHidden;
  }
  const previousInertRow = stickySelectedPinInertRow.get(viewport);
  if (previousInertRow && previousInertRow !== pin.flowRow) {
    delete previousInertRow.dataset.sidebarSelectedPinFlowHidden;
    previousInertRow.inert = false;
    previousInertRow.removeAttribute('aria-hidden');
  }
  pin.flowRow.dataset.sidebarSelectedPinFlowHidden = 'true';
  pin.flowRow.inert = true;
  pin.flowRow.setAttribute('aria-hidden', 'true');
  stickySelectedPinInertRow.set(viewport, pin.flowRow);
  const previousInertHeader = stickySelectedPinInertHeader.get(viewport);
  if (
    previousInertHeader &&
    (previousInertHeader !== pin.flowHeader || !hasProjectHeader)
  ) {
    delete previousInertHeader.dataset.sidebarSelectedPinFlowHidden;
    syncFlowHeaderAccessibility(previousInertHeader);
    stickySelectedPinInertHeader.delete(viewport);
  }
  if (hasProjectHeader && pin.flowHeader) {
    pin.flowHeader.dataset.sidebarSelectedPinFlowHidden = 'true';
    syncFlowHeaderAccessibility(pin.flowHeader);
    stickySelectedPinInertHeader.set(viewport, pin.flowHeader);
  }
  const previousGroupHeader = stickySelectedPinInertGroupHeader.get(viewport);
  const coverGroupHeader = state.top || hasGroupHeader;
  if (
    previousGroupHeader &&
    (previousGroupHeader !== pin.flowGroupHeader || !coverGroupHeader)
  ) {
    delete previousGroupHeader.dataset.sidebarSelectedPinFlowHidden;
    previousGroupHeader.inert = false;
    previousGroupHeader.removeAttribute('aria-hidden');
    stickySelectedPinInertGroupHeader.delete(viewport);
  }
  if (coverGroupHeader && pin.flowGroupHeader) {
    pin.flowGroupHeader.dataset.sidebarSelectedPinFlowHidden = 'true';
    pin.flowGroupHeader.inert = true;
    pin.flowGroupHeader.setAttribute('aria-hidden', 'true');
    stickySelectedPinInertGroupHeader.set(viewport, pin.flowGroupHeader);
  }
}

interface StickySelectedPinAtRestMeasurement {
  readonly pin: StickySelectedPinLayout;
  readonly scrollTop: number;
  readonly clientHeight: number;
}

/**
 * How much of the Chats list's bottom overlaps the rail-foot pin band, in
 * the list's own box. `scrollDelta` carries rects measured at the current
 * offset into the caller's frame, as `shouldShowProjectsPin` does; without it
 * the cut trailed a wheel-driven scroll by one event and rows painted through
 * the pinned copy.
 */
function chatsBottomPinCut(
  chatsRect: DOMRect,
  hostRect: DOMRect,
  pinBand: number,
  scrollDelta: number,
): number {
  if (pinBand <= 0) return 0;
  return Math.min(
    chatsRect.height,
    Math.max(0, chatsRect.bottom - scrollDelta - (hostRect.bottom - pinBand)),
  );
}

/**
 * The at-rest counterpart of the scroll sync's Chats bottom cut. A layout
 * pass at rest can reveal the bottom pin without any scroll (a selection
 * below the fold, a resize), and the cut has to follow it.
 */
function syncChatsBottomPinCutAtRest(
  viewport: HTMLElement,
  pinBand: number,
): void {
  const chatsSection = viewport.querySelector<HTMLElement>(
    CHATS_CONTENT_SELECTOR,
  );
  if (!chatsSection) return;
  // Nothing pinned: nothing to cut, and no reason to measure. This runs on
  // every at-rest layout pass, including the startup mutation bursts.
  const value =
    pinBand <= 0
      ? '0px'
      : `${chatsBottomPinCut(
          chatsSection.getBoundingClientRect(),
          viewport.getBoundingClientRect(),
          pinBand,
          0,
        )}px`;
  if (
    chatsSection.style.getPropertyValue('--sidebar-chats-bottom-cut') !== value
  ) {
    chatsSection.style.setProperty('--sidebar-chats-bottom-cut', value);
  }
}

/**
 * Selected-pin sync for the deferred-cache rest state (scrollTop 0). Only
 * bottom pinning is reachable at rest, and it must survive the layout passes
 * that reset the full rail cache — a selection below the fold keeps its
 * bottom-pinned row without any scroll having happened.
 *
 * Layout reads only; `applyStickySelectedPinAtRest` does the writes.
 */
function measureStickySelectedPinAtRest(
  viewport: HTMLElement,
): StickySelectedPinAtRestMeasurement | null {
  const pin = measureStickySelectedPin(viewport);
  if (!pin) return null;
  return {
    pin,
    scrollTop: viewport.scrollTop,
    clientHeight: viewport.clientHeight,
  };
}

function applyStickySelectedPinAtRest(
  viewport: HTMLElement,
  measurement: StickySelectedPinAtRestMeasurement | null,
): void {
  // `chatsHeaderSeatBottom` reads inline styles, not layout: the stack vars
  // the header-offset pass published earlier in this same pass.
  const chatsState =
    measurement?.pin.seat === 'chats'
      ? computeChatsSelectedPinState({
          scrollTop: measurement.scrollTop,
          clientHeight: measurement.clientHeight,
          headerSeatBottom: chatsHeaderSeatBottom(viewport),
          rowFlowTop: measurement.pin.metrics.rowFlowTop,
          rowHeight: measurement.pin.metrics.rowHeight,
        })
      : null;
  // Seating or releasing the copy changes the stack those vars describe, so
  // that transition republishes them and the clip geometry. It measures after
  // this pass's writes, but only on the transition, never on every pass.
  if (
    syncChatsSelectedPinHeight(
      viewport,
      chatsState?.top && measurement ? measurement.pin.metrics.rowHeight : 0,
    )
  ) {
    syncWorkspaceClipGeometryVars(viewport);
  }
  if (!measurement) {
    resetStickySelectedPin(viewport);
    syncChatsBottomPinCutAtRest(viewport, 0);
    return;
  }
  const { pin } = measurement;
  if (chatsState) {
    const band = computeChatsSelectedPinBand(chatsState, pin.metrics.rowHeight);
    applyStickySelectedPin(viewport, pin, chatsState, band);
    syncChatsBottomPinCutAtRest(viewport, band.bottomClipExtension);
    return;
  }
  // An inline-style read, not a layout read: the band top the header-offset
  // pass published earlier in this same pass.
  const bandTopRaw = Number.parseFloat(
    viewport.style.getPropertyValue(WORKSPACE_HEADER_TOP_VAR),
  );
  const state = computeStickySelectedPinState({
    scrollTop: measurement.scrollTop,
    clientHeight: measurement.clientHeight,
    stickyBandTop: Number.isFinite(bandTopRaw) ? bandTopRaw : null,
    metrics: pin.metrics,
  });
  const band = computeStickySelectedPinBand(state, pin.metrics, false);
  applyStickySelectedPin(viewport, pin, state, band);
  syncChatsBottomPinCutAtRest(viewport, band.bottomClipExtension);
}

/**
 * The workspace-rows container the scroll-driven occlusion clip is written to.
 *
 * The legacy section marks it `data-sidebar-section-content` as a DIRECT child
 * of the Projects section; the shared surface nests it deeper, so it carries
 * its own mark rather than forcing that selector to become a descendant match
 * (which would find a cowork folder's content first). Either resolves.
 */
const WORKSPACES_ROWS_SELECTOR =
  '[data-sidebar-workspaces-rows], [data-testid="sidebar-section-code"] > [data-sidebar-section-content]';

/** Height of a Projects header rendered OUTSIDE the sticky band; 0 otherwise. */
const EXTERNAL_PROJECTS_HEADER_HEIGHT_VAR =
  '--sidebar-external-projects-header-height';

const stickyWorkspaceRailLayoutCache = new WeakMap<
  HTMLElement,
  StickyWorkspaceRailLayout
>();

// Cached with the rail's layout measurements, independently of Projects rows.
const sidebarNavigationThresholds = new WeakMap<HTMLElement, number | null>();

function restoreSidebarMoreFocus(trigger: HTMLButtonElement | null): void {
  if (!trigger?.isConnected) return;
  const focused = trigger.ownerDocument.activeElement;
  if (focused?.closest('[data-testid="sidebar-more-menu"]')) {
    trigger.focus({ preventScroll: true });
  }
}

function readSidebarNavigationHidden(
  viewport: HTMLElement | null,
  refresh = false,
): boolean {
  if (!viewport?.isConnected || viewport.scrollTop <= 0) return false;
  if (refresh || !sidebarNavigationThresholds.has(viewport)) {
    sidebarNavigationThresholds.set(
      viewport,
      measureSidebarNavigationThreshold(viewport),
    );
  }
  return isSidebarNavigationHidden(
    viewport.scrollTop,
    sidebarNavigationThresholds.get(viewport) ?? null,
  );
}

function invalidateStickyWorkspaceRailLayout(viewport: HTMLElement): void {
  const layout = stickyWorkspaceRailLayoutCache.get(viewport);
  if (layout) {
    resetWorkspaceSectionClips(layout);
    resetStickyWorkspaceSlot(layout);
  }
  stickyWorkspaceRailLayoutCache.delete(viewport);
}

function resetWorkspaceSectionClips(layout: StickyWorkspaceRailLayout): void {
  resetIncomingFlowHeader(layout);
  for (let index = 0; index <= layout.activeFlowSectionIndex; index += 1) {
    const { header, rows } = layout.workspaceSections[index];
    header.removeAttribute('aria-hidden');
    header.removeAttribute('data-sidebar-sticky-flow-hidden');
    header.inert = false;
    if (rows) {
      rows.removeAttribute('aria-hidden');
      rows.inert = false;
    }
  }
  layout.activeFlowSectionIndex = -1;
}

function resetStickyWorkspaceSlot(layout: StickyWorkspaceRailLayout): void {
  const { stickyWorkspaceSlot } = layout;
  if (stickyWorkspaceSlot) {
    stickyWorkspaceSlot.hidden = true;
    stickyWorkspaceSlot.inert = true;
    stickyWorkspaceSlot.setAttribute('aria-hidden', 'true');
    stickyWorkspaceSlot.removeAttribute('data-active-workspace-id');
  }
  for (const row of [
    layout.activeStickySlotRow,
    layout.incomingStickySlotRow,
  ]) {
    if (!row) continue;
    row.hidden = true;
    row.inert = true;
    row.setAttribute('aria-hidden', 'true');
    row.style.removeProperty('transform');
  }
  layout.activeStickySlotRow = null;
  layout.incomingStickySlotRow = null;
}

function resetCachedStickyWorkspaceRailLayout(viewport: HTMLElement): void {
  const layout = stickyWorkspaceRailLayoutCache.get(viewport);
  if (!layout) return;

  layout.primaryNavigation?.style.setProperty(
    '--sidebar-new-task-mask-start',
    `-${NEW_TASK_MASK_EDGE_PX}px`,
  );
  layout.primaryNavigation?.style.setProperty(
    '--sidebar-new-task-mask-end',
    '0px',
  );
  if (layout.workspacesContent) {
    // The clip geometry vars deliberately survive this reset: the scroll-driven
    // clip animation must already hold correct geometry when the next
    // composited fling starts, before any scroll handler can run. The layout
    // pass that triggered this reset refreshes them immediately after.
    layout.workspacesContent.removeAttribute(
      'data-sidebar-workspace-sticky-active',
    );
  }
  resetWorkspaceSectionClips(layout);
  resetStickyWorkspaceSlot(layout);
}

function getLayoutOffsetTop(element: HTMLElement): number {
  let offsetTop = 0;
  let current: HTMLElement | null = element;
  while (current) {
    offsetTop += current.offsetTop;
    current = current.offsetParent as HTMLElement | null;
  }
  return offsetTop;
}

function getStickyWorkspaceRailLayout(
  viewport: HTMLElement,
): StickyWorkspaceRailLayout | null {
  const cached = stickyWorkspaceRailLayoutCache.get(viewport);
  if (cached) return cached;

  const stickySentinel = viewport.querySelector<HTMLElement>(
    '[data-testid="sidebar-sticky-workspace-sentinel"]',
  );
  if (!stickySentinel) return null;

  const primaryNavigation = viewport.querySelector<HTMLElement>(
    '[data-testid="sidebar-primary-navigation"]',
  );
  const rootFontSize = Number.parseFloat(
    viewport.ownerDocument.defaultView
      ?.getComputedStyle(viewport.ownerDocument.documentElement)
      .getPropertyValue('font-size') ?? '',
  );
  // Real workspace headers remain in normal document flow. Cache only their
  // natural thresholds and matching rows; paint occlusion belongs to the
  // structural flow-layer clip, never to per-scroll element writes.
  const workspaceSections: StickyWorkspaceSectionClip[] = [];
  const viewportFlowTop = getLayoutOffsetTop(viewport);
  // A Projects header the HOST renders below the band, rather than the legacy
  // one that lives inside it. Its flow offset is cached so the rail can tell,
  // by arithmetic, whether it has reached its sticky seat yet.
  const stickyControlsElement = viewport.querySelector<HTMLElement>(
    STICKY_CONTROLS_SELECTOR,
  );
  const externalProjectsHeader = resolveExternalProjectsHeader(
    viewport,
    stickyControlsElement,
  );
  for (const header of Array.from(
    viewport.querySelectorAll<HTMLElement>('.sidebar-workspace-sticky-header'),
  )) {
    const workspaceRoot = header.closest<HTMLElement>(
      '[data-sidebar-workspace-id]',
    );
    const workspaceId = workspaceRoot?.dataset.sidebarWorkspaceId;
    if (!workspaceId) continue;
    // A collapsed workspace without a selected entry has no rows container.
    // Its header must still own a sticky slot threshold and have its flow
    // copy hidden; skipping it projects the following workspace prematurely.
    const rows = resolveStickyWorkspaceRows(header, workspaceRoot);
    workspaceSections.push({
      workspaceId,
      header,
      headerFlowTop: getLayoutOffsetTop(header) - viewportFlowTop,
      headerHeight: header.offsetHeight,
      rows,
    });
  }
  const chatsSectionMask = viewport.querySelector<HTMLElement>(
    CHATS_CONTENT_SELECTOR,
  );
  const stickyWorkspaceSlot = viewport.querySelector<HTMLElement>(
    STICKY_WORKSPACE_SLOT_SELECTOR,
  );
  const stickySlotRows = new Map<string, HTMLElement>();
  const stickySlotRowHeights = new Map<string, number>();
  for (const row of Array.from(
    viewport.querySelectorAll<HTMLElement>(STICKY_WORKSPACE_SLOT_ROW_SELECTOR),
  )) {
    const workspaceId = row.dataset.sidebarStickySlotWorkspaceId;
    if (workspaceId) {
      stickySlotRows.set(workspaceId, row);
      stickySlotRowHeights.set(workspaceId, row.offsetHeight);
    }
  }

  const railWorkspacesContent = viewport.querySelector<HTMLElement>(
    WORKSPACES_ROWS_SELECTOR,
  );
  const layout: StickyWorkspaceRailLayout = {
    stickyThreshold: computeWorkspacesStickyThreshold(
      viewport,
      stickySentinel.offsetTop,
    ),
    stickyControls: stickyControlsElement,
    projectsPinAnchor: resolveProjectsPinAnchor(
      viewport,
      stickyControlsElement,
    ),
    projectsPin:
      viewport
        .closest<HTMLElement>(SIDEBAR_ROOT_SELECTOR)
        ?.querySelector<HTMLElement>(PROJECTS_PIN_SELECTOR) ?? null,
    primaryNavigation,
    // Both offsets are the element's distance down the SCROLL CONTENT, and
    // both feed mask coordinates that are expressed in that same space.
    //
    // `offsetTop` alone cannot express that: it is measured from whatever
    // `offsetParent` happens to be, so any positioned wrapper between the
    // element and the viewport silently re-bases it — which is exactly what
    // happened when the shared surface introduced a `relative` scroll
    // container, sliding the Chats mask down by that wrapper's offset and
    // opening a growing blank band under the header. Walking to the viewport
    // makes the value independent of who wraps what.
    primaryNavigationOffsetTop: primaryNavigation
      ? getLayoutOffsetTop(primaryNavigation) - viewportFlowTop
      : 0,
    chatsSection: chatsSectionMask,
    chatsSectionOffsetTop: chatsSectionMask
      ? getLayoutOffsetTop(chatsSectionMask) - viewportFlowTop
      : 0,
    chatsHeader: viewport.querySelector<HTMLElement>(CHATS_HEADER_SELECTOR),
    externalProjectsHeaderFlowTop: externalProjectsHeader
      ? getLayoutOffsetTop(externalProjectsHeader) - viewportFlowTop
      : null,
    externalProjectsHeaderHeight: externalProjectsHeader?.offsetHeight ?? 0,
    workspacesContent: railWorkspacesContent,
    stickyWorkspaceSlot,
    stickySlotRows,
    stickySlotRowHeights,
    wheelLineHeight:
      Number.isFinite(rootFontSize) && rootFontSize > 0
        ? rootFontSize
        : DEFAULT_WHEEL_LINE_HEIGHT_PX,
    viewportClientHeight: viewport.clientHeight,
    workspaceSections,
    selectedPin: measureStickySelectedPin(viewport),
    activeStickySlotRow: null,
    incomingStickySlotRow: null,
    incomingFlowHeader: null,
    activeFlowSectionIndex: -1,
    lastSyncedScrollTop: null,
    stickyControlsVisible: false,
  };
  if (!sidebarNavigationThresholds.has(viewport)) {
    sidebarNavigationThresholds.set(
      viewport,
      measureSidebarNavigationThreshold(viewport),
    );
  }
  syncWorkspaceClipGeometryVars(viewport);
  stickyWorkspaceRailLayoutCache.set(viewport, layout);
  return layout;
}

/**
 * Activates the pinned slot copy for `section`. Returns whether a slot row is
 * actually standing in: surfaces that render the sticky controls without a
 * slot (the shared-sidebar host, the workspaces loading state) have no
 * replacement to show, and the caller must then leave the in-flow header
 * painted instead of hiding a header nothing replaces.
 */
function setStickyWorkspaceSlotActive(
  layout: StickyWorkspaceRailLayout,
  section: StickyWorkspaceSectionClip | null,
  incomingSection: StickyWorkspaceSectionClip | null,
  incomingDistance: number,
): boolean {
  const slot = layout.stickyWorkspaceSlot;
  const nextRow = section
    ? (layout.stickySlotRows.get(section.workspaceId) ?? null)
    : null;
  // `stickySlotRows` is a build-time snapshot; slot rows removed since the
  // last cache build (host surfaces dropping their slot copies) would
  // otherwise be "activated" as detached nodes and un-hide the slot with
  // nothing standing in. Treat a disconnected row as absent — the next
  // layout pass rebuilds the cache.
  if (!slot || !nextRow || !section || !nextRow.isConnected) {
    resetStickyWorkspaceSlot(layout);
    return false;
  }

  const incomingCandidate = incomingSection
    ? layout.stickySlotRows.get(incomingSection.workspaceId)
    : null;
  const incomingRow = incomingCandidate?.isConnected ? incomingCandidate : null;
  for (const row of [
    layout.activeStickySlotRow,
    layout.incomingStickySlotRow,
  ]) {
    if (!row || row === nextRow || row === incomingRow) continue;
    row.hidden = true;
    row.inert = true;
    row.setAttribute('aria-hidden', 'true');
    row.style.removeProperty('transform');
  }
  nextRow.hidden = false;
  layout.activeStickySlotRow = nextRow;
  // Preserve the natural inter-header spacing, capped at the 40px clip band
  // (the 32px header plus the rail's 8px divider gap). In particular, adjacent
  // collapsed sections have only a 1px gap: using the full band there would
  // push the first header upward even at scrollTop 0.
  const pushOffDistance = incomingSection
    ? Math.min(
        WORKSPACE_CLIP_BAND_PX,
        incomingSection.headerFlowTop - section.headerFlowTop,
      )
    : section.headerHeight;
  // The incoming copy follows normal flow 1:1; the old copy clears its gap.
  // No timed easing or layout reads occur in the scroll path.
  const outgoingOffset = incomingRow
    ? Math.min(0, incomingDistance - pushOffDistance)
    : 0;
  nextRow.style.transform = `translateY(${outgoingOffset}px)`;
  const measuredSlotRowHeight =
    layout.stickySlotRowHeights.get(section.workspaceId) ?? 0;
  const outgoingHeight = measuredSlotRowHeight || section.headerHeight;
  const outgoingIsExposed = outgoingOffset > -outgoingHeight;
  nextRow.inert = !outgoingIsExposed;
  if (outgoingIsExposed) {
    nextRow.removeAttribute('aria-hidden');
  } else {
    nextRow.setAttribute('aria-hidden', 'true');
  }
  if (incomingRow) {
    incomingRow.hidden = false;
    incomingRow.inert = false;
    incomingRow.removeAttribute('aria-hidden');
    incomingRow.style.transform = `translateY(${incomingDistance}px)`;
  }
  layout.incomingStickySlotRow = incomingRow;

  slot.hidden = false;
  slot.inert = false;
  slot.removeAttribute('aria-hidden');
  slot.dataset.activeWorkspaceId = section.workspaceId;
  return true;
}

function resetIncomingFlowHeader(layout: StickyWorkspaceRailLayout): void {
  if (!layout.incomingFlowHeader) return;
  layout.incomingFlowHeader.removeAttribute('data-sidebar-sticky-flow-hidden');
  syncFlowHeaderAccessibility(layout.incomingFlowHeader);
  layout.incomingFlowHeader = null;
}

function syncFlowWorkspaceAccessibility(
  layout: StickyWorkspaceRailLayout,
  activeSection: StickyWorkspaceSectionClip | null,
): void {
  const activeIndex = activeSection
    ? layout.workspaceSections.indexOf(activeSection)
    : -1;
  const previousIndex = layout.activeFlowSectionIndex;
  if (activeIndex === previousIndex) return;

  const firstChangedIndex = Math.max(0, Math.min(activeIndex, previousIndex));
  const lastChangedIndex = Math.max(activeIndex, previousIndex);
  for (let index = firstChangedIndex; index <= lastChangedIndex; index += 1) {
    const section = layout.workspaceSections[index];
    const headerCovered = index <= activeIndex;
    if (headerCovered) {
      section.header.setAttribute('data-sidebar-sticky-flow-hidden', 'true');
    } else {
      section.header.removeAttribute('data-sidebar-sticky-flow-hidden');
    }
    syncFlowHeaderAccessibility(section.header);

    if (!section.rows) continue;
    const rowsCovered = index < activeIndex;
    section.rows.inert = rowsCovered;
    if (rowsCovered) {
      section.rows.setAttribute('aria-hidden', 'true');
    } else {
      section.rows.removeAttribute('aria-hidden');
    }
  }
  layout.activeFlowSectionIndex = activeIndex;
}

/**
 * The rows container a sticky header owns.
 *
 * The native section lays the rows out as the header's next sibling. The
 * shared surface's `SidebarSection` wraps its header in a flex row and puts
 * the content beside THAT wrapper, so the header's own sibling is nothing;
 * fall back to the first content block under the workspace root that is not
 * inside a nested workspace. Without this every shared section reads as
 * collapsed and the seat handoff never pushes the outgoing header away.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function resolveStickyWorkspaceRows(
  header: HTMLElement,
  workspaceRoot: HTMLElement | null,
): HTMLElement | null {
  const selector =
    '[data-sidebar-section-content], [data-sidebar-folder-content]';
  const sibling = header.nextElementSibling;
  if (sibling instanceof HTMLElement && sibling.matches(selector)) {
    return sibling;
  }
  if (!workspaceRoot) return null;
  for (const candidate of Array.from(
    workspaceRoot.querySelectorAll<HTMLElement>(selector),
  )) {
    if (candidate.closest('[data-sidebar-workspace-id]') === workspaceRoot) {
      return candidate;
    }
  }
  return null;
}
/**
 * A Projects header rendered OUTSIDE the sticky band (a host-supplied header
 * seated below it). One portaled INTO the band is the legacy shape: the band's
 * own height already covers it, so it is not external.
 */
function resolveExternalProjectsHeader(
  viewport: HTMLElement,
  stickyControls: HTMLElement | null,
): HTMLElement | null {
  const header = viewport.querySelector<HTMLElement>(PROJECTS_HEADER_SELECTOR);
  if (!header) return null;
  return stickyControls?.contains(header) ? null : header;
}
/**
 * The sticky band whose approach to the foot of the rail decides the Projects
 * stand-in.
 *
 * On the legacy rail that band is the sticky controls container, which holds
 * the More row AND the real Projects header. When the shared surface supplies
 * the header it sits BELOW that container, so measuring the container would
 * track the More row — which never reaches the bottom, leaving the stand-in
 * permanently hidden and Projects exactly as unreachable as before it existed.
 *
 * Marked rather than branched on the flag: the rail's geometry already finds
 * the Chats header this way, and a host that renders its own Projects header
 * is the thing being detected, not which implementation is mounted.
 */
function resolveProjectsPinAnchor(
  viewport: HTMLElement,
  stickyControls: HTMLElement | null,
): HTMLElement | null {
  return (
    viewport.querySelector<HTMLElement>(PROJECTS_HEADER_SELECTOR) ??
    stickyControls
  );
}

/**
 * Show or hide the Projects stand-in from two already-measured rects.
 *
 * Split out from the rail sync so the same decision can run at rest. The
 * caller owns the reads: the scroll path hoists them above its writes, and
 * passing rects in keeps that ordering the caller's business. `scrollDelta`
 * carries the rects into the caller's frame — see `shouldShowProjectsPin`.
 */
function applyProjectsPinVisibility(
  projectsPin: HTMLElement,
  controlsRect: DOMRect,
  hostRect: DOMRect,
  scrollDelta: number,
): void {
  const nextHidden = !shouldShowProjectsPin({
    controlsTop: controlsRect.top,
    controlsHeight: controlsRect.height,
    hostBottom: hostRect.bottom,
    scrollDelta,
  });
  if (projectsPin.hidden !== nextHidden) {
    projectsPin.hidden = nextHidden;
  }
}

/**
 * The chat rows sit directly under their header at the top of the rail, so
 * the stuck mark can never legitimately survive a pass that lands at rest.
 * Cleared here because the scroll sync that owns it is skipped at
 * `scrollTop === 0`; left set, it would mislabel the toggle, not merely rotate
 * a chevron. Runs before the at-rest measurements, as it always has, and
 * removing an absent attribute invalidates nothing.
 */
function clearChatsHeaderStuckAtRest(viewport: HTMLElement): void {
  viewport
    .querySelector<HTMLElement>(CHATS_HEADER_SELECTOR)
    ?.removeAttribute(CHATS_HEADER_STUCK_ATTR);
}

interface RailAffordancesAtRestMeasurement {
  readonly projectsPin: HTMLElement;
  readonly pinAnchorRect: DOMRect;
  readonly hostRect: DOMRect;
}

/**
 * The at-rest counterparts of the scroll sync's two Chats/Projects
 * affordances: the stand-in's visibility here, and clearing the stuck mark
 * (`clearChatsHeaderStuckAtRest`).
 *
 * `syncStickyWorkspaceRail` is the only other caller, and `onViewportLayout`
 * deliberately skips it while `scrollTop === 0` to avoid building the
 * O(workspaces) geometry cache during startup mutations. But expanding Chats
 * pushes Projects below the fold WITHOUT moving the scroll position, so
 * without this the stand-in stays hidden until the user happens to scroll —
 * leaving Projects exactly as unreachable as it was before the stand-in
 * existed. Two queries and two rects, no geometry cache; the sibling
 * `measureStickySelectedPinAtRest` exists for the same reason.
 *
 * Layout reads only; `applyRailAffordancesAtRest` does the write. The
 * at-rest pass takes these rects before it publishes the sticky offsets.
 * Those offsets move only an anchor that is stuck to the TOP of the rail, and
 * the stand-in shows only once the anchor has left the BOTTOM, so a stuck
 * anchor reads "hidden" before and after the writes alike.
 */
function measureRailAffordancesAtRest(
  viewport: HTMLElement,
): RailAffordancesAtRestMeasurement | null {
  const stickyControls = viewport.querySelector<HTMLElement>(
    STICKY_CONTROLS_SELECTOR,
  );
  const projectsPin = viewport
    .closest<HTMLElement>(SIDEBAR_ROOT_SELECTOR)
    ?.querySelector<HTMLElement>(PROJECTS_PIN_SELECTOR);
  const pinAnchor = resolveProjectsPinAnchor(viewport, stickyControls);
  if (!pinAnchor || !projectsPin) return null;
  return {
    projectsPin,
    pinAnchorRect: pinAnchor.getBoundingClientRect(),
    hostRect: viewport.getBoundingClientRect(),
  };
}

function applyRailAffordancesAtRest(
  measurement: RailAffordancesAtRestMeasurement | null,
): void {
  if (!measurement) return;
  applyProjectsPinVisibility(
    measurement.projectsPin,
    measurement.pinAnchorRect,
    measurement.hostRect,
    // At rest the measurement and the decision share a frame.
    0,
  );
}

function syncStickyWorkspaceRail(
  viewport: HTMLElement,
  scrollTop = viewport.scrollTop,
): boolean | null {
  const cachedLayout = stickyWorkspaceRailLayoutCache.get(viewport);
  if (scrollTop === 0 && !cachedLayout) {
    // Browsers may emit a zero-position scroll event while restoring initial
    // layout. Keep that event as cheap as the layout callback above.
    return false;
  }
  const layout = cachedLayout ?? getStickyWorkspaceRailLayout(viewport);
  if (!layout) return null;
  if (layout.lastSyncedScrollTop === scrollTop) {
    return layout.stickyControlsVisible;
  }

  // A selected chat seats in the sticky stack ABOVE the Projects band, so it
  // is decided first: seating or releasing it moves the band's seat and the
  // threshold every term below is measured from.
  const pin = layout.selectedPin;
  const chatsPinState =
    pin?.seat === 'chats'
      ? computeChatsSelectedPinState({
          scrollTop,
          clientHeight: layout.viewportClientHeight,
          headerSeatBottom: chatsHeaderSeatBottom(viewport),
          rowFlowTop: pin.metrics.rowFlowTop,
          rowHeight: pin.metrics.rowHeight,
        })
      : null;
  if (
    syncChatsSelectedPinHeight(
      viewport,
      chatsPinState?.top && pin ? pin.metrics.rowHeight : 0,
    )
  ) {
    syncWorkspaceClipGeometryVars(viewport);
    // Recomputed directly rather than taken from the clip sync, which reports
    // nothing while the Projects rows are unmounted (Projects collapsed) —
    // the threshold still moves with the stack then.
    const sentinel = viewport.querySelector<HTMLElement>(
      '[data-testid="sidebar-sticky-workspace-sentinel"]',
    );
    if (sentinel) {
      layout.stickyThreshold = computeWorkspacesStickyThreshold(
        viewport,
        sentinel.offsetTop,
      );
    }
  }

  const { stickyThreshold } = layout;
  const stickyControlsVisible = scrollTop > 0 && scrollTop >= stickyThreshold;

  // ---- Layout READS ----------------------------------------------------
  //
  // Every rect this pass needs is taken here, before the first style write
  // below. The two were interleaved (write mask vars -> read the same
  // element's rect -> write the cut), and each read after a write forces a
  // synchronous relayout of the whole rail. On a sidebar with dozens of
  // worktrees that was ~2ms per read and several reads per wheel event:
  // `getBoundingClientRect` accounted for 48% of renderer CPU while
  // scrolling, and p95 frame time went from 9ms at 12 worktrees to 56ms at
  // 80. Reads-then-writes leaves at most one forced layout per event.
  const pinControls = layout.projectsPinAnchor;
  const pinTarget = layout.projectsPin;
  const measurePin = pinTarget !== null && pinControls !== null;
  const hostRect =
    measurePin || layout.chatsSection !== null
      ? viewport.getBoundingClientRect()
      : null;
  // `measurePin` already carries `pinControls !== null`.
  const controlsRect = measurePin ? pinControls.getBoundingClientRect() : null;
  const chatsRect =
    layout.chatsSection !== null
      ? layout.chatsSection.getBoundingClientRect()
      : null;
  // The header's LIVE bottom, not the seated value derived from the sticky
  // vars below. The click path measures live, and the announcement must not be
  // able to disagree with what the click then does.
  const chatsHeaderRect =
    layout.chatsSection !== null && layout.chatsHeader !== null
      ? layout.chatsHeader.getBoundingClientRect()
      : null;

  // ---- Layout WRITES ---------------------------------------------------

  // Projects stand-in at the foot of the rail, shown only while the real band
  // has scrolled clean off the bottom — which an expanded Chats list makes the
  // normal case. This has to live in the scroll-driven sync, not the
  // layout-driven one: an earlier revision toggled it from
  // `syncStickyWorkspaceHeaderOffset`, so the pin appeared when the list
  // expanded and then never went away when the band scrolled back.
  if (pinTarget !== null && controlsRect !== null && hostRect !== null) {
    // `scrollTop` is where the caller is about to land; the rects are where
    // things are now. Everything else in this pass is already expressed in the
    // predicted frame, so the stand-in has to be too.
    applyProjectsPinVisibility(
      pinTarget,
      controlsRect,
      hostRect,
      scrollTop - viewport.scrollTop,
    );
  }
  if (layout.workspacesContent) {
    if (stickyControlsVisible) {
      layout.workspacesContent.setAttribute(
        'data-sidebar-workspace-sticky-active',
        'true',
      );
    } else {
      layout.workspacesContent.removeAttribute(
        'data-sidebar-workspace-sticky-active',
      );
    }
  }
  const { primaryNavigation } = layout;
  if (primaryNavigation) {
    const maskStart =
      scrollTop > 0
        ? scrollTop - layout.primaryNavigationOffsetTop
        : -NEW_TASK_MASK_EDGE_PX;
    primaryNavigation.style.setProperty(
      '--sidebar-new-task-mask-start',
      `${maskStart}px`,
    );
    primaryNavigation.style.setProperty(
      '--sidebar-new-task-mask-end',
      `${maskStart + NEW_TASK_MASK_EDGE_PX}px`,
    );
  }

  // The Chats section sits between the nav and the sticky Projects controls,
  // so it needs the same fade as the nav rows as it passes beneath them.
  const { chatsSection, chatsHeader } = layout;
  // Whether the header currently stands over a fully hidden list. Only the
  // chevron reads this; the click path measures for itself.
  let chatsOccluded = false;
  if (chatsSection) {
    // Cut the rows at the Chats header's bottom edge — and only there. The
    // Projects band sits BELOW this list in flow, so the list never passes
    // behind it: the band travels up with the list until it reaches its own
    // sticky top, by which point the list's bottom is already above it.
    const chatsHeaderRaw = Number.parseFloat(
      viewport.style.getPropertyValue(CHATS_HEADER_HEIGHT_VAR),
    );
    const moreRaw = Number.parseFloat(
      viewport.style.getPropertyValue(MORE_HEIGHT_VAR),
    );
    const chatsHeaderBottom =
      (Number.isFinite(chatsHeaderRaw) ? chatsHeaderRaw : 0) +
      (Number.isFinite(moreRaw) ? moreRaw : 0) +
      STICKY_CONTROLS_TOP_PX;
    const chatsMaskStart =
      scrollTop > 0
        ? scrollTop + chatsHeaderBottom - layout.chatsSectionOffsetTop
        : -NEW_TASK_MASK_EDGE_PX;
    chatsSection.style.setProperty(
      '--sidebar-new-task-mask-start',
      `${chatsMaskStart}px`,
    );
    chatsSection.style.setProperty(
      '--sidebar-new-task-mask-end',
      `${chatsMaskStart + NEW_TASK_MASK_EDGE_PX}px`,
    );
    // Chats sits above the project list, so a long list (Show all) can reach
    // the selected-item bottom pin — whose surface is transparent on the
    // macOS translucent sidebar. Cut whatever overlaps that band.
    //
    // A selected chat's band is already decided for THIS pass; a project
    // selection's is decided further down, so it is read from the last one.
    const pinBottomRaw = Number.parseFloat(
      viewport.style.getPropertyValue(SELECTED_PIN_BOTTOM_CLIP_VAR),
    );
    // The Projects pin deliberately contributes nothing here: it sits below
    // the viewport rather than over it, so there is no content behind it to
    // cut.
    const pinBand =
      chatsPinState !== null && pin !== null
        ? computeChatsSelectedPinBand(chatsPinState, pin.metrics.rowHeight)
            .bottomClipExtension
        : Number.isFinite(pinBottomRaw)
          ? pinBottomRaw
          : 0;
    const bottomCut =
      chatsRect !== null && hostRect !== null
        ? chatsBottomPinCut(
            chatsRect,
            hostRect,
            pinBand,
            // The rects are where the list is now; the cut must land where
            // this pass is about to scroll it.
            scrollTop - viewport.scrollTop,
          )
        : 0;
    chatsSection.style.setProperty(
      '--sidebar-chats-bottom-cut',
      `${bottomCut}px`,
    );
    // Live client rects, the same pair the click path measures. The row check
    // is short-circuited behind the geometry so its query only runs in the
    // rare state where the announcement could change.
    //
    // Unlike the stand-in above, this is NOT carried into the predicted frame.
    // That is a deliberate asymmetry, not an oversight: the stand-in's
    // staleness could hide the only way back to Projects, while this one can
    // only misdescribe a control whose click measures live. It is worth being
    // precise about the cost, though — the trailing scroll event early-returns
    // on `lastSyncedScrollTop`, so a gesture that stops within one wheel delta
    // of the crossing leaves the mark wrong until the NEXT scroll, not merely
    // for a frame. The visible effect is a chevron and a label that briefly
    // disagree with what activating the header would do.
    chatsOccluded =
      chatsRect !== null &&
      chatsHeaderRect !== null &&
      isChatsContentOccluded({
        contentBottom: chatsRect.bottom,
        // A seated chat copy occludes the rows too.
        headerBottom:
          chatsHeaderRect.bottom + (chatsSelectedPinHeight.get(viewport) ?? 0),
      }) &&
      chatsContentHasRows(chatsSection);
  }
  if (chatsHeader) {
    // Cleared as readily as it is set: a collapse with nothing in Chats
    // selected unmounts the rows, which skips the block above entirely, and
    // the header must not keep pointing back at a list that is no longer
    // there.
    if (chatsOccluded) {
      if (chatsHeader.getAttribute(CHATS_HEADER_STUCK_ATTR) !== 'true') {
        chatsHeader.setAttribute(CHATS_HEADER_STUCK_ATTR, 'true');
      }
    } else if (chatsHeader.hasAttribute(CHATS_HEADER_STUCK_ATTR)) {
      chatsHeader.removeAttribute(CHATS_HEADER_STUCK_ATTR);
    }
  }

  // Select the last in-flow header to cross the fixed slot coordinate. The
  // slot remains fixed; its copies move during the next header's approach.
  const workspaceHeaderTop = Number.parseFloat(
    viewport.style.getPropertyValue(WORKSPACE_HEADER_TOP_VAR),
  );
  // Selected-item pin state precedes slot selection: an active top pin group
  // (selected workspace header + selected row) occupies the seat directly
  // below the controls, pushing the slot's replacement line — and therefore
  // when a later "current top" workspace header takes the slot — down by the
  // pinned group's height.
  // A chat's copy seats above the band and is already part of
  // `workspaceHeaderTop`, so it adds nothing to the group below the seat.
  const pinState: StickySelectedPinState =
    chatsPinState ??
    (pin
      ? computeStickySelectedPinState({
          scrollTop,
          clientHeight: layout.viewportClientHeight,
          stickyBandTop: Number.isFinite(workspaceHeaderTop)
            ? workspaceHeaderTop
            : null,
          metrics: pin.metrics,
        })
      : NO_SELECTED_PIN);
  const pinTopGroupHeight =
    pinState.top && pin?.seat === 'project'
      ? computeStickySelectedPinTopGroupHeight(pinState, pin.metrics)
      : 0;
  // The always-on scroll-driven clip starts biting the first in-flow header
  // WORKSPACE_CLIP_BAND_PX before the sticky threshold (its boundary sits a
  // constant 40px below the stuck controls at every scroll offset). The slot
  // copy therefore activates at that same offset: below the threshold the
  // un-stuck controls still travel with the flow, so the slot child is
  // pixel-coincident with the in-flow header it replaces and the handoff is
  // invisible. From there the first identity owns the dedicated slot until a
  // later header crosses its fixed coordinate.
  // No lower clamp: when the threshold itself sits inside the clip band
  // (every nav item moved into More), the clip already bites at scrollTop 0
  // and the slot must stand in from rest.
  // The window is the band's depth, and on the shared surface that includes
  // the Projects header rendered below the seat — the clip's own band does,
  // so it started biting the first header while this still said nothing had
  // crossed, and the first project was cut in half from the first pixel of
  // scroll with nothing standing in for it.
  // The live offset is for PLACEMENT only — it seats the slot and pin under
  // the label wherever the label currently is. The arithmetic below uses the
  // band's static depth: feeding it the live value made the activation window
  // grow with the label's distance, so with the nav expanded and Chats open
  // the slot stood in from scrollTop 0 — the first project's in-flow header
  // hidden and its copy painted rows lower, "shifted down" until the scroll
  // caught up with it.
  syncExternalProjectsHeaderOffset(viewport, layout, scrollTop);
  const { externalProjectsHeaderHeight } = layout;
  // A host-rendered label is the band's bottom edge: nothing is occluded, and
  // nothing may stand in, until that label is within the handoff window of
  // its seat. The legacy rail keeps its header inside the band and keeps the
  // threshold rule.
  const firstHeaderWithinReach =
    layout.externalProjectsHeaderFlowTop === null
      ? scrollTop >=
        stickyThreshold - WORKSPACE_CLIP_BAND_PX - externalProjectsHeaderHeight
      : layout.externalProjectsHeaderFlowTop - scrollTop <=
        readPxVar(viewport, WORKSPACE_HEADER_TOP_VAR) + WORKSPACE_CLIP_BAND_PX;
  let activeSection: StickyWorkspaceSectionClip | null = firstHeaderWithinReach
    ? (layout.workspaceSections[0] ?? null)
    : null;
  if (activeSection && Number.isFinite(workspaceHeaderTop)) {
    // The line a header must cross to own the slot: the band's bottom, which
    // on the shared surface includes a Projects header rendered below the
    // seat. Without that term a header was cut by the clip for one header's
    // height of travel before anything counted it as arrived, so nothing
    // stood in for it while it was sliced. Same omission the handoff
    // distance had; the legacy rail keeps its header inside the band and the
    // var is 0 there.
    const stickyLine =
      scrollTop +
      workspaceHeaderTop +
      externalProjectsHeaderHeight +
      pinTopGroupHeight;
    for (const section of layout.workspaceSections) {
      if (section.headerFlowTop > stickyLine) break;
      activeSection = section;
    }
  }
  const nextSection = activeSection
    ? layout.workspaceSections[
        layout.workspaceSections.indexOf(activeSection) + 1
      ]
    : null;
  // Distance from the incoming header to the band's BOTTOM — every surface
  // stacked below the seat, not just the pin. The shared surface renders its
  // Projects header outside the band, below the seat and above the pin; it
  // was not counted here, so the band the clip cuts at sat one header deeper
  // than the band the handoff measured to. For that header's height of travel
  // the incoming project header was already being cut in half while nothing
  // had started standing in for it — the two names read as printed over each
  // other. The legacy rail renders that header inside the band (the var is 0
  // there) and never showed it.
  const incomingDistance = nextSection
    ? nextSection.headerFlowTop -
      Math.max(scrollTop, stickyThreshold) -
      workspaceHeaderTop -
      externalProjectsHeaderHeight -
      pinTopGroupHeight
    : Infinity;
  // Start replacing the incoming flow header as soon as the structural clip
  // reaches it, including the divider's 8px gap below the 32px slot.
  const incomingSection =
    incomingDistance > 0 && incomingDistance < WORKSPACE_CLIP_BAND_PX
      ? (nextSection ?? null)
      : null;
  // While the top pin group is showing the selected workspace's header, the
  // slot must not duplicate that same header directly beneath it — the pin
  // copy IS the stuck header until a later workspace crosses the pinned line.
  const pinCoversActiveSection =
    pinState.top &&
    pin?.seat === 'project' &&
    activeSection !== null &&
    activeSection.workspaceId === pin.workspaceId;
  // Only hide in-flow headers when a slot row is genuinely standing in;
  // slot-less surfaces (shared-sidebar host, loading state) keep their flow
  // headers painted rather than hiding a header nothing replaces.
  const slotActive = setStickyWorkspaceSlotActive(
    layout,
    pinCoversActiveSection ? null : activeSection,
    incomingSection,
    incomingDistance,
  );
  // The band only reaches the slot's bottom while the slot is actually
  // standing in. When the selected-row pin already owns the header seat the
  // slot is hidden, and reserving its 2rem anyway left a strip of rail
  // showing neither band nor row directly under the pinned selection.
  syncWorkspacesSlotHeightVar(viewport, slotActive);
  resetIncomingFlowHeader(layout);
  syncFlowWorkspaceAccessibility(
    layout,
    slotActive || pinCoversActiveSection ? activeSection : null,
  );
  if (slotActive && layout.incomingStickySlotRow && incomingSection) {
    incomingSection.header.setAttribute(
      'data-sidebar-sticky-flow-hidden',
      'true',
    );
    syncFlowHeaderAccessibility(incomingSection.header);
    layout.incomingFlowHeader = incomingSection.header;
  }
  const pinBand = pin
    ? pin.seat === 'chats'
      ? computeChatsSelectedPinBand(pinState, pin.metrics.rowHeight)
      : computeStickySelectedPinBand(
          pinState,
          pin.metrics,
          slotActive && !pinCoversActiveSection,
        )
    : null;
  if (pin && pinBand) {
    applyStickySelectedPin(viewport, pin, pinState, pinBand);
  } else {
    resetStickySelectedPin(viewport);
  }
  layout.lastSyncedScrollTop = scrollTop;
  layout.stickyControlsVisible = stickyControlsVisible;

  return stickyControlsVisible;
}

/**
 * Pixel distance for a wheel event, applied 1:1 for pixel-mode input. For
 * real macOS input the OS bakes acceleration and momentum into per-event
 * pixel deltas, so `deltaY` IS the distance native scrolling would travel —
 * the takeover neither amplifies nor dampens it. (Synthesized CDP gestures
 * can over-report `deltaY` relative to their native consumption on
 * high-refresh displays; that is a test-input artifact, not something to
 * correct for here.)
 */
function wheelDeltaPixels(
  deltaY: number,
  deltaMode: number,
  viewportHeight: number,
  lineHeight: number,
): number {
  if (deltaMode === WheelEvent.DOM_DELTA_LINE) return deltaY * lineHeight;
  if (deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return deltaY * viewportHeight;
  }
  return deltaY;
}

/**
 * Maps a plain-page nav key to the `NavigationPage` it navigates to. App
 * Advisor is handled separately (it dispatches a dedicated callback, not
 * `onNavigate`). Desktop never lists Remote Control: it opens from the account
 * menu (CAN-3659).
 */
const NAV_PAGE_FOR_KEY: Record<string, NavigationPage> = {
  workflows: 'workflows',
  plugins: 'plugins',
  feed: 'feed',
  overview: 'overview',
  kanban: 'kanban',
  statistics: 'statistics',
  audit: 'audit',
  workers: 'workers',
};

/**
 * Pages the Workflows row stands for (CAN-3981): it opens Runs and stays
 * selected on any of its tabs.
 */
const WORKFLOWS_PAGES: ReadonlySet<NavigationPage> = new Set<NavigationPage>([
  'workflows',
  'workflows-schedule',
  'workflows-library',
]);

function isNavKeySelected(
  key: string,
  page: NavigationPage,
  activePage: NavigationPage,
): boolean {
  return key === 'workflows'
    ? WORKFLOWS_PAGES.has(activePage)
    : activePage === page;
}

/**
 * More-menu keys that carried an onboarding anchor in the original hardcoded
 * markup. Preserved so onboarding tour targeting is unchanged.
 */
const MORE_ONBOARDING_ANCHOR_KEYS: ReadonlySet<string> = new Set([
  'statistics',
  // Audit Trail moved out of the account menu into the sidebar nav (More region
  // by default), so it needs an onboarding anchor here just like the other
  // More-defaulted destinations above; its tour step now targets the More menu
  // instead of the account row.
  'audit',
]);

/**
 * How long the hover preview keeps the panel escaping (absolutely positioned,
 * with its clip wrapper's overflow lifted) after closing. Must outlast the
 * slide-out — `--sidebar-preview-duration`, 250ms as shipped — with enough
 * margin that the panel is never snapped back to its docked rendering while
 * still visibly travelling.
 */
const SIDEBAR_OVERLAY_RELEASE_MS = 320;

export function AppSidebar({
  activePage,
  onNavigate,
  onReturnToSectionRoot,
  onSettingsClick,
  settingsOpen,
  onCanopyPortalClick,
  ledgerEnabled = false,
  claudeTuiWorkersEnabled,
  onAppAdvisorClick,
  appAdvisorOpen,
  appAdvisorThinking,
  appAdvisorUnread,
  workersActive,
}: AppSidebarProps): JSX.Element {
  const hidden = useSidebarStore((s) => s.hidden);
  const previewing = useSidebarStore((s) => s.previewing);
  const width = useSidebarStore((s) => s.width);
  const setWidth = useSidebarStore((s) => s.setWidth);
  const sidebarNavLayout = useSidebarStore((s) => s.sidebarNavLayout);

  // CAN-2415: while hidden, hovering/focusing the titlebar toggle temporarily
  // reveals the sidebar as an overlay. The overlay takes the aside out of the
  // flex flow (absolute positioning) so the main content neither moves nor
  // resizes, and the persisted collapsed preference is untouched.
  const previewOverlayActive = hidden && previewing;
  const sidebarMenuRowStyle =
    useContextMenuPlacement() === 'cursor'
      ? QUIET_MENU_ROW_STYLE
      : DEFAULT_MENU_ROW_STYLE;
  // Effective "fully hidden" state: width 0, inert, out of hit-testing.
  const concealed = hidden && !previewing;
  useOverlayEscape(previewOverlayActive, closeSidebarPreviewAndRefocusToggle);

  // The preview reveals the sidebar by SLIDING the whole panel in from the
  // left, not by growing its width. The `<aside>` therefore keeps its normal
  // place in the flex row at width 0 the entire time it is hidden, and the
  // panel escapes it as an absolutely-positioned child. Nothing in the row
  // ever changes size, so the main content cannot shift.
  //
  // `overlayPresented` keeps the panel escaping (and unclipped) through the
  // slide-OUT; `previewSlidIn` is the transform target.
  const overlayPresented = useSidebarStore((s) => s.previewPresented);
  const setOverlayPresented = useSidebarStore((s) => s.setPreviewPresented);
  const previewSlidIn = useSidebarStore((s) => s.previewSlidIn);
  const setPreviewSlidIn = useSidebarStore((s) => s.setPreviewSlidIn);
  // True only for the frame that first puts the panel on screen. Re-entering
  // while it is still sliding out must NOT pin transitions off: the panel is
  // already presented, so the transform target simply changes and it reverses
  // continuously from wherever it happens to be.
  const [entryFrame, setEntryFrame] = useState(false);
  // Keyed on the panel being visibly slid IN, not merely presented: the
  // presented flag outlasts the panel by the slide-out, and pinning during
  // that tail would strip the expand animation while committing a blank
  // full-width region for a frame.
  const pinHandover = !hidden && previewSlidIn;

  // Settings takes over the whole window and expects a STATIC sidebar beneath
  // it. A preview left running underneath keeps the panel presented (and the
  // titlebar corner elevated) while the overlay is up, so the two interleave.
  // Opening settings releases the preview outright.
  useEffect((): void => {
    if (!settingsOpen) return;
    if (!previewing && !overlayPresented) return;
    requestSidebarPreviewClose({ immediate: true });
    setPreviewSlidIn(false);
    setOverlayPresented(false);
  }, [
    settingsOpen,
    previewing,
    overlayPresented,
    setOverlayPresented,
    setPreviewSlidIn,
  ]);
  // Suppresses the aside's width transition on the frame a revealed preview is
  // pinned open. The panel is already on screen at full width, so replaying the
  // docked 0 -> width animation would re-reveal what the user is looking at.
  //
  // Derived, NOT state set from an effect: the width jumps to its docked value
  // in the same commit that `hidden` flips, so the transition is created during
  // that commit's style resolution. Even a layout effect reacts one render too
  // late — the class has to be absent in the very same render.
  //
  // True only while the store still reports the panel as presented; the effect
  // below clears that a tick later, restoring the class with the width already
  // settled (so no transition can start from it).
  useEffect((): (() => void) | undefined => {
    if (previewOverlayActive) {
      if (!overlayPresented) setEntryFrame(true);
      setOverlayPresented(true);
      // Flip the transform only after the browser has actually COMPUTED the
      // off-screen starting position, otherwise there is nothing to animate
      // from and the panel jump-cuts into place. One `requestAnimationFrame`
      // is not enough: its callback still runs before that frame is painted,
      // so React's re-render lands in the same frame as the initial style.
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => {
          setPreviewSlidIn(true);
          setEntryFrame(false);
        });
      });
      return (): void => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
      };
    }
    // Pinning a fully revealed preview is a geometry handover, not a fresh
    // reveal. Keep `previewSlidIn` true through the first docked paint so the
    // sidebar, titlebar corner, and page spacer all omit their width
    // transitions while `hidden` changes from true to false. Clearing it in
    // this effect immediately can be batched with the store's pin update,
    // which recreates the transition before the browser resolves the docked
    // width and visibly replays 0 -> width.
    if (!hidden && previewSlidIn) {
      // `setPreviewPresented(false)` also clears `previewSlidIn`, so defer the
      // whole overlay release. Releasing only the presentation flag here
      // would erase the handover signal in the same synchronous store update.
      const frame = requestAnimationFrame(() => setOverlayPresented(false));
      return (): void => cancelAnimationFrame(frame);
    }
    setPreviewSlidIn(false);
    if (!overlayPresented) return;
    // Pinned open: the sidebar owns real layout space again, so it returns to
    // its docked rendering at once instead of sliding away.
    if (!hidden) {
      setOverlayPresented(false);
      return;
    }
    const timer = setTimeout(
      () => setOverlayPresented(false),
      SIDEBAR_OVERLAY_RELEASE_MS,
    );
    return (): void => clearTimeout(timer);
  }, [
    previewOverlayActive,
    hidden,
    overlayPresented,
    previewSlidIn,
    setOverlayPresented,
    setPreviewSlidIn,
  ]);

  // Drag-resize disables the width transition below so the sidebar edge
  // tracks the pointer instead of animating (and rubber-banding) behind it.
  const [isResizing, setIsResizing] = useState(false);

  const [showDiagnosticsPill, setShowDiagnosticsPill] = useState(true);
  const [worktreeDiffStatsStyle, setWorktreeDiffStatsStyle] =
    useState<WorktreeDiffStatsStyle>('short');
  const [workersTerminalMode, setWorkersTerminalMode] = useState(false);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  // Snapshot of navigation visibility taken when More opens. The live
  // value stays in `navigationHiddenRef`: it flips mid-scroll, and
  // wheel scrolling is applied on the main thread, so a React state write on
  // the crossing would re-render the whole sidebar and stall the scroll
  // exactly as the workspace header pins.
  const [moreMenuSnapshot, setMoreMenuSnapshot] = useState<
    ReturnType<typeof deriveSidebarNavRegions>
  >({ mainNav: [], more: [] });
  const [customizeOpen, setCustomizeOpen] = useState(false);
  // Preserve the main-nav context menu as another customization entry point.
  const [navContextMenu, setNavContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const navContextMenuAnchorRef = useRef<HTMLSpanElement | null>(null);
  const navigationHiddenRef = useRef(false);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  // Latest sidebar scroll viewport, captured by the layout callback so the
  // bottom pin overlay (a sibling of the scroll area) can forward wheel
  // input into the same takeover path the viewport itself uses.
  const sidebarViewportRef = useRef<HTMLElement | null>(null);
  const bottomPinHostRef = useRef<HTMLDivElement | null>(null);
  const appBottomStatusHost = useAppBottomStatusHost();
  // Latch the hidden flag for this sidebar mount so mid-session changes only
  // take effect after a reload, keeping the mounted implementation deterministic.
  const sharedSidebarEnabled = useMemo(isDesktopSharedSidebarEnabled, []);
  const contextAvailability = useDesktopWorkspaceContextAvailability();

  const commitNavigationHidden = (hidden: boolean): void => {
    if (navigationHiddenRef.current === hidden) return;
    navigationHiddenRef.current = hidden;
    // Closed-menu crossings do not schedule React work. An open menu keeps
    // its snapshot until this boundary changes, independent of Projects.
    if (moreOpen) {
      restoreSidebarMoreFocus(moreButtonRef.current);
      setMoreOpen(false);
    }
  };

  useEffect((): (() => void) | undefined => {
    const bottomPinHost = bottomPinHostRef.current;
    if (!bottomPinHost) return;

    // Portaled rows dispatch React wheel events through their owning React
    // tree instead of the host element's React tree. A native listener follows
    // the actual DOM bubble path, so wheel gestures over every portaled child
    // reliably reach the sibling sidebar viewport.
    const handleBottomPinWheel = (event: WheelEvent): void => {
      const viewport = sidebarViewportRef.current;
      if (!viewport || event.deltaY === 0 || event.ctrlKey) {
        return;
      }
      const maxScrollTop = viewport.scrollHeight - viewport.clientHeight;
      if (maxScrollTop <= 0) return;
      const layout = getStickyWorkspaceRailLayout(viewport);
      const deltaY = wheelDeltaPixels(
        event.deltaY,
        event.deltaMode,
        viewport.clientHeight,
        layout?.wheelLineHeight ?? DEFAULT_WHEEL_LINE_HEIGHT_PX,
      );
      const nextScrollTop = Math.min(
        maxScrollTop,
        Math.max(0, viewport.scrollTop + deltaY),
      );
      if (nextScrollTop === viewport.scrollTop) return;
      syncStickyWorkspaceRail(viewport, nextScrollTop);
      viewport.scrollTop = nextScrollTop;
    };

    bottomPinHost.addEventListener('wheel', handleBottomPinWheel);
    return () => {
      bottomPinHost.removeEventListener('wheel', handleBottomPinWheel);
    };
  }, []);

  useEffect(() => {
    if (!settingsOpen) return;
    setMoreOpen(false);
    setCustomizeOpen(false);
  }, [settingsOpen]);

  // App Advisor's `navigation.open_customize_sidebar` action requests the
  // CustomizeSidebarModal via navigationStore since it has no direct reference
  // to this component's local `customizeOpen` state. Mirrors the other
  // pending-request consume patterns in `WorktreeManager` (e.g.
  // `pendingWorkspaceSettings`).
  const customizeSidebarRequested = useNavigationStore(
    (state) => state.customizeSidebarRequested,
  );
  const consumeCustomizeSidebarRequest = useNavigationStore(
    (state) => state.consumeCustomizeSidebarRequest,
  );
  const openCommandPalette = useNavigationStore(
    (state) => state.openCommandPalette,
  );
  useEffect(() => {
    if (!customizeSidebarRequested) return;
    setCustomizeOpen(true);
    consumeCustomizeSidebarRequest();
  }, [consumeCustomizeSidebarRequest, customizeSidebarRequested]);

  const initializeResourceMonitor = useResourceMonitorStore(
    (s) => s.initialize,
  );
  const disposeResourceMonitor = useResourceMonitorStore((s) => s.dispose);
  const resourceMonitorReady = useResourceMonitorStore(
    (s) => s.initialized && !s.loading,
  );
  const initializeObservability = useObservabilityStore(
    (state) => state.initialize,
  );
  const appAdvisorButtonLabel = appAdvisorThinking
    ? `${ORCHESTRATOR_LABEL}: thinking`
    : appAdvisorUnread
      ? `${ORCHESTRATOR_LABEL}: unread`
      : ORCHESTRATOR_LABEL;
  const workersButtonLabel = workersActive
    ? 'Claude workers: active'
    : 'Claude workers';

  // Claude Workers only appears when a terminal-backed worker mode is enabled
  // or a worker is currently active, matching the gate the account menu used
  // before Workers moved into the sidebar nav.
  const workersVisible =
    claudeTuiWorkersEnabled && (workersTerminalMode || workersActive);

  // Early access only restyles the sidebar; nav regions follow the stored
  // layout whether it is on or off.
  const simplifiedSidebar = useLabsExperimentEnabled('sidebar');
  // Nav keys owned by Labs experiments that are off.
  const experimentHiddenKeys = useLabsHiddenSidebarKeys();
  // Nav keys any Labs experiment owns. Off keys never render, so the marker
  // only appears on pages whose experiment is on.
  const labsOwnedKeys = useLabsOwnedSidebarKeys();
  const navKeyMarker = (key: string): JSX.Element | null =>
    labsOwnedKeys.includes(key) ? <SidebarNavMarker kind="labs" /> : null;

  const navItemDefs = useMemo(() => getSidebarNavItemDefs(), []);
  const { mainNav, more } = useMemo(
    () =>
      deriveSidebarNavRegions(sidebarNavLayout, {
        workersVisible,
        ledgerEnabled,
        experimentHiddenKeys,
      }),
    [sidebarNavLayout, ledgerEnabled, workersVisible, experimentHiddenKeys],
  );

  useEffect(() => {
    void initializeObservability();
  }, [initializeObservability]);

  useEffect(() => {
    window.api
      .loadPreferences()
      .then((prefs) => {
        setShowDiagnosticsPill(prefs.showDiagnosticsPill);
        setWorktreeDiffStatsStyle(prefs.worktreeDiffStatsStyle ?? 'short');
        setWorkersTerminalMode(hasClaudeWorkerTerminalMode(prefs));
        setPreferencesLoaded(true);
      })
      .catch(() => {
        // Fail open on a transient preferences-load failure: keep the Claude
        // Workers nav item available rather than hiding it, matching the
        // enabled-on-load-failure behavior the account menu had before Workers
        // moved into the sidebar nav.
        setWorkersTerminalMode(true);
        setPreferencesLoaded(true);
      });
  }, []);

  useEffect(() => {
    const unsubscribe = subscribePreferencesUpdated((prefs) => {
      setShowDiagnosticsPill(prefs.showDiagnosticsPill);
      setWorktreeDiffStatsStyle(prefs.worktreeDiffStatsStyle ?? 'short');
      setWorkersTerminalMode(hasClaudeWorkerTerminalMode(prefs));
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (
      !shouldSubscribeResourceMonitor(preferencesLoaded, showDiagnosticsPill)
    ) {
      disposeResourceMonitor();
      return;
    }
    void initializeResourceMonitor();
  }, [
    disposeResourceMonitor,
    initializeResourceMonitor,
    preferencesLoaded,
    showDiagnosticsPill,
  ]);

  // Single chokepoint for every More-menu open/close path — pointer clicks,
  // Enter/Space on the button, and FloatingMenu's ArrowDown/ArrowUp anchor
  // opening measure the navigation boundary directly, including restored
  // scroll positions that have not dispatched a scroll event.
  const handleMoreOpenChange = (open: boolean): void => {
    if (open) {
      const viewport =
        sidebarViewportRef.current ??
        moreButtonRef.current?.closest<HTMLElement>(
          SIDEBAR_VIEWPORT_SELECTOR,
        ) ??
        null;
      const hidden = readSidebarNavigationHidden(viewport, true);
      // Synchronize before opening, without closing the new menu on this measurement.
      navigationHiddenRef.current = hidden;
      setMoreMenuSnapshot({ mainNav: hidden ? mainNav : [], more });
    }
    setMoreOpen(open);
  };

  const handleMoreItemClick = (action: () => void): void => {
    action();
    setMoreOpen(false);
  };

  const appAdvisorDocked = useAppAdvisorStore(
    (s) => s.open && s.layout === 'docked',
  );
  // The Orchestrator page experiment: the row then opens the Orchestrator as
  // a page here and lists its chats under it; off, the row is unchanged.
  const orchestratorPageEnabled = useLabsExperimentEnabled(
    ORCHESTRATOR_PAGE_EXPERIMENT_ID,
  );
  // The Orchestrator's chats list under its row like a project's; with
  // chats, its row collapses and expands them, as a project row does.
  const appAdvisorEntries = useAppAdvisorSidebarEntries(
    orchestratorPageEnabled,
    appAdvisorDocked,
  );
  const appAdvisorActiveEntryId = useAppAdvisorActiveEntryId();
  const appAdvisorCollapsed = useSidebarStore((s) => s.orchestratorCollapsed);
  // Thinking outranks unread outranks open, in both regions.
  const appAdvisorStatus: DropdownMenuItemStatus | undefined =
    appAdvisorThinking ? 'active' : appAdvisorUnread ? 'unread' : undefined;

  // App Advisor keeps its bespoke thinking/unread/open treatment in either
  // region, its orbit turning while it works; only padding, testid, onboarding
  // anchor, and the click wrapper differ between main nav and the More menu.
  const renderAppAdvisorButton = (
    def: SidebarNavItemDef,
    region: 'main' | 'more',
  ): JSX.Element => {
    const isMain = region === 'main';
    if (!isMain) {
      return (
        <DropdownMenuItem
          key={def.key}
          onClick={(): void => handleMoreItemClick(onAppAdvisorClick)}
          data-testid="sidebar-more-item-app-advisor"
          aria-label={appAdvisorButtonLabel}
          aria-pressed={appAdvisorOpen}
          status={appAdvisorStatus}
          selected={appAdvisorStatus === undefined && appAdvisorOpen}
        >
          <DropdownMenuItemIcon>
            <RunningGlyph running={appAdvisorThinking}>{def.icon}</RunningGlyph>
          </DropdownMenuItemIcon>
          {def.label}
        </DropdownMenuItem>
      );
    }
    const rowIcon = (
      <RunningGlyph running={appAdvisorThinking}>{def.icon}</RunningGlyph>
    );
    if (!orchestratorPageEnabled) {
      return (
        <SidebarNavRow
          key={def.key}
          onClick={onAppAdvisorClick}
          data-testid="sidebar-nav-app-advisor"
          data-onboarding-anchor="sidebar-app-advisor"
          aria-label={appAdvisorButtonLabel}
          aria-pressed={appAdvisorOpen}
          // The row background means "selected" across the sidebar, so a
          // status inks the leading glyph instead of tinting the row.
          selected={appAdvisorOpen}
          status={appAdvisorStatus}
          iconClassName="relative"
          icon={rowIcon}
        >
          {def.label}
        </SidebarNavRow>
      );
    }
    // On its page (docked in this window) the selected chat under the row
    // carries the selection, as a project's selected chat does; an empty new
    // chat (not listed yet) or a folded list leaves the row itself selected.
    const hasChats = appAdvisorEntries.length > 0;
    const rowSelected = appAdvisorDocked
      ? !appAdvisorEntries.some(
          (entry) => entry.id === appAdvisorActiveEntryId,
        ) || appAdvisorCollapsed
      : appAdvisorOpen;
    const toggleCollapsed = (): void => {
      useSidebarStore.getState().setOrchestratorCollapsed(!appAdvisorCollapsed);
    };
    const row = (
      <div key={def.key} className="group/sidebar-item relative">
        <SidebarNavRow
          // With chats the row folds them, like a project row; without, it
          // opens the Orchestrator page on its new-chat state.
          onClick={(event): void => {
            // A pointer click leaves no focus behind, so the row's hover
            // actions hide again once the pointer leaves.
            if (event.detail > 0) event.currentTarget.blur();
            if (hasChats) toggleCollapsed();
            else onAppAdvisorClick();
          }}
          data-testid="sidebar-nav-app-advisor"
          data-onboarding-anchor="sidebar-app-advisor"
          aria-label={appAdvisorButtonLabel}
          {...(hasChats
            ? { 'aria-expanded': !appAdvisorCollapsed }
            : { 'aria-pressed': appAdvisorOpen })}
          // The row background means "selected" across the sidebar, so a
          // status inks the leading glyph instead of tinting the row.
          selected={rowSelected}
          status={appAdvisorStatus}
          iconClassName="relative"
          icon={rowIcon}
        >
          {def.label}
        </SidebarNavRow>
        {/* New chat and, with chats, the fold chevron: revealed on hover
            like a project row's actions, and inset 2px from the row's edge
            on every side, like every sidebar row's controls. */}
        <span className="absolute inset-y-0 right-0.5 flex items-center gap-0.5">
          <RailIconButton
            icon={PlusMediumIcon}
            onClick={(event): void => {
              // A pointer click leaves no focus behind, so the + hides
              // again with the hover, as a project row's add action does.
              if (event.detail > 0) event.currentTarget.blur();
              useAppAdvisorStore.getState().openDocked({ newWorkEntry: true });
            }}
            data-testid="sidebar-app-advisor-new-chat"
            hoverSurface
            revealOnItemHover
            coarsePointerTarget
            aria-label={`New ${ORCHESTRATOR_LABEL} chat`}
            tooltipLabel="New chat"
          />
          {hasChats && (
            <RailIconButton
              icon={ChevronDownIcon}
              iconClassName={appAdvisorCollapsed ? '-rotate-90' : 'rotate-0'}
              onClick={(event): void => {
                if (event.detail > 0) event.currentTarget.blur();
                toggleCollapsed();
              }}
              data-testid="sidebar-app-advisor-collapse"
              hoverSurface
              revealOnItemHover
              coarsePointerTarget
              aria-expanded={!appAdvisorCollapsed}
              aria-label={`${appAdvisorCollapsed ? 'Expand' : 'Collapse'} ${ORCHESTRATOR_LABEL} chats`}
              tooltipLabel={appAdvisorCollapsed ? 'Expand' : 'Collapse'}
            />
          )}
        </span>
      </div>
    );
    if (!hasChats || appAdvisorCollapsed) return row;
    return (
      <Fragment key={def.key}>
        {row}
        <AppAdvisorSidebarEntries
          entries={appAdvisorEntries}
          docked={appAdvisorDocked}
        />
      </Fragment>
    );
  };

  // Claude Workers keeps the bespoke "active" affordance it had in the account
  // menu before moving into the sidebar nav: a sky-tinted tone, an
  // `aria-label` announcing the active state, and the shared thinking spinner in
  // place of its logo while a worker is queued/starting/running. Only padding, testid, onboarding
  // anchor, and the click wrapper differ between the main nav and the More menu.
  // The shared row rule: a row enters its page, and the current row returns
  // its section to the root (the Workflows row is current on all its tabs).
  const activateNavPage = (page: NavigationPage, current: boolean): void =>
    activateSidebarNavItem({
      active: current,
      onSelect: () => onNavigate(page),
      onReturnToRoot: () => onReturnToSectionRoot(page),
    });

  // While a worker runs, the shared spinner takes the Claude logo's place in
  // the slot (a turning logo would read oddly), as compact worktree rows do.
  const workersIcon = (def: SidebarNavItemDef): JSX.Element =>
    workersActive ? (
      <span
        data-testid="sidebar-workers-active"
        aria-hidden="true"
        className="inline-flex"
      >
        <ThinkingSpinner sizePx={12} />
      </span>
    ) : (
      def.icon
    );

  const renderWorkersButton = (
    def: SidebarNavItemDef,
    region: 'main' | 'more',
  ): JSX.Element | null => {
    const page = NAV_PAGE_FOR_KEY[def.key];
    if (!page) return null;
    const isMain = region === 'main';
    const isCurrentPage = activePage === page;
    if (!isMain) {
      return (
        <DropdownMenuItem
          key={def.key}
          onClick={(): void =>
            handleMoreItemClick(() => activateNavPage(page, isCurrentPage))
          }
          data-testid={`sidebar-more-item-${def.key}`}
          data-onboarding-anchor={
            MORE_ONBOARDING_ANCHOR_KEYS.has(def.key)
              ? `sidebar-${def.key}`
              : undefined
          }
          aria-label={workersButtonLabel}
          status={workersActive ? 'active' : undefined}
          selected={!workersActive && isCurrentPage}
        >
          <DropdownMenuItemIcon>{workersIcon(def)}</DropdownMenuItemIcon>
          {def.label}
        </DropdownMenuItem>
      );
    }
    return (
      <SidebarNavRow
        key={def.key}
        onClick={(): void => activateNavPage(page, isCurrentPage)}
        data-testid={`sidebar-nav-${def.key}`}
        data-onboarding-anchor={`sidebar-${def.key}`}
        aria-label={workersButtonLabel}
        selected={isCurrentPage}
        status={workersActive ? 'active' : undefined}
        icon={workersIcon(def)}
      >
        {def.label}
      </SidebarNavRow>
    );
  };

  const renderMainNavItem = (key: string): JSX.Element | null => {
    const def = navItemDefs[key];
    if (!def) return null;
    if (key === 'app-advisor') return renderAppAdvisorButton(def, 'main');
    if (key === 'workers') return renderWorkersButton(def, 'main');
    const page = NAV_PAGE_FOR_KEY[key];
    if (!page) return null;
    return (
      <SidebarNavRow
        key={def.key}
        onClick={(): void =>
          activateNavPage(page, isNavKeySelected(key, page, activePage))
        }
        data-testid={`sidebar-nav-${def.key}`}
        data-onboarding-anchor={`sidebar-${def.key}`}
        selected={isNavKeySelected(key, page, activePage)}
        icon={def.icon}
      >
        {def.label}
        {navKeyMarker(key)}
      </SidebarNavRow>
    );
  };

  const renderMoreItem = (key: string): JSX.Element | null => {
    const def = navItemDefs[key];
    if (!def) return null;
    if (key === 'app-advisor') return renderAppAdvisorButton(def, 'more');
    if (key === 'workers') return renderWorkersButton(def, 'more');
    const page = NAV_PAGE_FOR_KEY[key];
    if (!page) return null;
    // `onNavigate` dispatches `navigation.go_to_page` through App.tsx's
    // `dispatchUiAction`, shared with App Advisor navigation.
    return (
      <DropdownMenuItem
        key={def.key}
        onClick={(): void =>
          handleMoreItemClick(() =>
            activateNavPage(page, isNavKeySelected(key, page, activePage)),
          )
        }
        data-testid={`sidebar-more-item-${def.key}`}
        data-onboarding-anchor={
          MORE_ONBOARDING_ANCHOR_KEYS.has(key)
            ? `sidebar-${def.key}`
            : undefined
        }
        selected={isNavKeySelected(key, page, activePage)}
      >
        <DropdownMenuItemIcon>{def.icon}</DropdownMenuItemIcon>
        {def.label}
        {navKeyMarker(key)}
      </DropdownMenuItem>
    );
  };

  const devPagesTarget = devPagesEntryTarget();

  // Eligibility and ordering changes close the snapshot instead of moving
  // a focused destination. The next opening uses the current filtered groups.
  useLayoutEffect(() => {
    restoreSidebarMoreFocus(moreButtonRef.current);
    setMoreOpen(false);
  }, [mainNav, more, devPagesTarget]);
  // Retain the opening's keys until closing returns focus. Rendering newly
  // filtered keys first would remove the focused row before that handoff.
  const rolledMainItems = moreMenuSnapshot.mainNav
    .map(renderMoreItem)
    .filter((item) => item !== null);
  const customItems = moreMenuSnapshot.more
    .map(renderMoreItem)
    .filter((item) => item !== null);
  const hasCustomGroup = customItems.length > 0 || devPagesTarget !== null;
  const moreControl = (
    <SidebarMoreControl
      open={moreOpen}
      onOpenChange={handleMoreOpenChange}
      triggerRef={moreButtonRef}
      triggerTestId="sidebar-more"
      menuTestId="sidebar-more-menu"
      onboardingAnchor="sidebar-more"
      landmarkLabel="Project navigation actions"
      menuSize="sidebar"
    >
      {rolledMainItems}
      {rolledMainItems.length > 0 && hasCustomGroup && (
        <DropdownMenuDivider data-testid="sidebar-more-workspace-divider" />
      )}
      {customItems}
      {devPagesTarget !== null && (
        // Dev and E2E builds only: one entry for every development reference
        // page; the page itself carries tabs between them (DevPagesShell).
        // Not a customizable nav key, so it can never be persisted into a
        // sidebar layout.
        <DropdownMenuItem
          onClick={(): void =>
            handleMoreItemClick(() => onNavigate(devPagesTarget))
          }
          data-testid="sidebar-more-item-dev-pages"
          selected={isDevPage(activePage)}
        >
          <DropdownMenuItemIcon>
            <ExperimentIcon />
          </DropdownMenuItemIcon>
          Dev pages
          <SidebarNavMarker kind="dev" />
        </DropdownMenuItem>
      )}
      {/* Sections above, the setting that governs them below. */}
      {(rolledMainItems.length > 0 || hasCustomGroup) && (
        <DropdownMenuDivider data-testid="sidebar-more-customize-divider" />
      )}
      <DropdownMenuItem
        onClick={() =>
          handleMoreItemClick(() => {
            setCustomizeOpen(true);
          })
        }
        data-testid="sidebar-more-item-customize"
        // `customizeOpen` drives the CustomizeSidebarModal rendered below;
        // reflected here as the trigger's dialog state.
        aria-haspopup="dialog"
        aria-expanded={customizeOpen}
      >
        <DropdownMenuItemIcon>
          <SettingsIcon />
        </DropdownMenuItemIcon>
        Customize sidebar
      </DropdownMenuItem>
    </SidebarMoreControl>
  );

  const reserveTrafficLights =
    shouldReserveSidebarTrafficLightRegion(localPlatform());

  return (
    <>
      {appBottomStatusHost &&
        createPortal(
          <div
            className="flex min-w-0 items-center justify-center gap-3"
            data-testid="app-sidebar-bottom-status"
          >
            {/* A labeled pill, not a bare glyph: the host is a floating
                overlay (see App.tsx), so the label no longer costs a
                full-width band, and an icon alone read as a stray artifact
                under the composer. The tooltip still carries the full
                explanation. */}
            <WakeLockIndicator collapsed={false} statusBar />
          </div>,
          appBottomStatusHost,
        )}
      <aside
        // The width switches between 0 and `width`. The toggle stays
        // stationary because it does NOT live in this aside —
        // it lives in App.tsx's persistent titlebar corner at constant window
        // coordinates (see the paint-order comment there).
        // In preview-overlay mode the aside leaves the flex flow (absolute at
        // the window's left edge, z-30 under the sticky titlebar corner) so the
        // main shell keeps its full width while the sidebar floats above it.
        // Stays in the flex row in BOTH states — the preview never changes
        // this element's width, so the row's geometry is untouched. `z-30`
        // (under the sticky titlebar corner) lets the escaping panel paint over
        // the main content while it is revealed.
        className={`sidebar-resizable-surface sidebar-instant-interactions relative h-full shrink-0 select-none ${
          // Above ordinary page content AND page overlays (CoworkArchiveOverlay
          // and the archived-worktree viewer both sit at z-30), so the preview
          // is never activated behind an invisible surface. Dialogs share that
          // modal tier, so coexisting with a true modal is resolved in
          // behaviour rather than stacking: the controller releases the
          // preview as soon as a modal scrim mounts.
          overlayPresented ? 'z-sticky' : ''
        } ${
          isResizing || pinHandover
            ? ''
            : // The floor animates with the width. Applied at once, it put
              // a re-opened sidebar at its floor in one frame while the page
              // spacer was still closing over 200ms, so the top bar's
              // breadcrumb leapt right by the spacer's width and slid back.
              'sidebar-layout-transition transition-[width,min-width] duration-200 ease-in-out'
        }`}
        style={{
          width: hidden ? 0 : width,
          // The floor is physical-reserve aware (see `sidebarMinWidthCss`),
          // so a width persisted at another interface scale can never squeeze
          // the titlebar row's status area. A hidden sidebar has a floor of
          // 0, written out so the browser has a length to animate from.
          minWidth: hidden ? 0 : sidebarMinWidthCss(reserveTrafficLights),
        }}
        aria-hidden={concealed}
        onPointerEnter={
          previewOverlayActive
            ? (): void => cancelSidebarPreviewClose()
            : undefined
        }
        onPointerLeave={
          previewOverlayActive
            ? (event): void => {
                // The mirror of the toggle's guard: moving back onto the
                // toggle (which sits in the titlebar corner, above the panel)
                // is not leaving the preview either.
                const next = event.relatedTarget;
                if (
                  next instanceof Element &&
                  next.closest('[data-testid="app-titlebar-corner"]') !== null
                ) {
                  return;
                }
                requestSidebarPreviewClose({
                  unknownDestination: next === null,
                  pointer: { x: event.clientX, y: event.clientY },
                });
              }
            : undefined
        }
        onFocus={
          previewOverlayActive
            ? (): void => cancelSidebarPreviewClose()
            : undefined
        }
        onBlur={
          previewOverlayActive
            ? (event): void => {
                // focusout: close once focus leaves both the preview and the
                // titlebar toggle (which keeps the preview alive while it has
                // focus itself).
                // Losing focus only means "left the preview" when the
                // pointer is elsewhere too. Clicking a nav row navigates and
                // can drop focus entirely (relatedTarget null) while the
                // pointer is still sitting inside the panel.
                if (event.currentTarget.matches(':hover')) return;
                const next = event.relatedTarget;
                if (
                  next instanceof Element &&
                  (event.currentTarget.contains(next) ||
                    next.closest('[data-testid="sidebar-toggle"]') !== null)
                ) {
                  return;
                }
                requestSidebarPreviewClose();
              }
            : undefined
        }
        data-sidebar-preview={previewOverlayActive ? 'true' : undefined}
        data-testid="app-sidebar"
      >
        {/*
        Inner wrapper keeps the expanded width fixed regardless of the
        outer clip width, so content doesn't squish while the outer
        `<aside>` animates between 0 and `width`. `pointer-events-none` plus
        `aria-hidden` keep the width-0 aside out of hit-testing, and `inert`
        (native HTML attribute, React 19 passes it through) removes every
        descendant from the tab order and accessibility tree while hidden —
        without it, buttons inside the width-0 aside would still be
        keyboard-tabbable even though they're invisible.
      */}
        <div
          // While the panel is revealed it must paint OUTSIDE this box (the
          // aside is 0-wide when hidden), so the clip is lifted for the
          // duration — which is also what lets the panel's drop shadow render.
          className={`sidebar-resizable-clip absolute inset-0 ${
            overlayPresented ? 'overflow-visible' : 'overflow-hidden'
          }`}
        >
          <div
            inert={concealed}
            // Docked, the sidebar is part of the window surface, so
            // `app-sidebar-material` stays transparent and lets the window
            // material through. As a hover preview it floats ABOVE page
            // content, so `app-sidebar-preview-surface` paints an opaque
            // elevated surface over it. The material class stays on in both
            // states so its child rules (notably the `.bg-sidebar`
            // neutralization for workspace headers) keep applying.
            className={`app-sidebar-material sidebar-resizable-divider flex h-full flex-col text-s font-normal ${
              overlayPresented
                ? // Revealed: the panel escapes the 0-width aside and slides in
                  // from the left. `shadow-xl` is the design system's largest
                  // surface shadow (`--shadow-surface-xl`). The `-instant`
                  // modifier applies only on the first frame, pinning the
                  // off-screen start position without animating to it.
                  `app-sidebar-preview-surface sidebar-preview-slide absolute left-0 top-0 shadow-xl ${
                    // Only the very first presentation frame is instant.
                    // During the slide-OUT — and on re-entry while it is still
                    // sliding — the panel is already presented and must
                    // animate.
                    entryFrame ? 'sidebar-preview-instant' : ''
                  }`
                : 'relative'
            } ${
              concealed
                ? 'border-0 pointer-events-none'
                : 'border-y-0 border-l-0 border-r '
            }`}
            style={{
              width,
              minWidth: sidebarMinWidthCss(reserveTrafficLights),
              ...(overlayPresented
                ? {
                    // Short travel, not the full panel width: the panel
                    // nudges in from `--sidebar-preview-offset` while the
                    // opacity carries most of the reveal.
                    transform: previewSlidIn
                      ? 'translateX(0)'
                      : 'translateX(var(--sidebar-preview-offset, -16px))',
                    opacity: previewSlidIn ? 1 : 0,
                  }
                : {}),
            }}
            data-testid="sidebar-panel"
          >
            <div
              className="app-sidebar-content flex h-full flex-col"
              data-page-active={settingsOpen ? 'false' : 'true'}
            >
              {/* Early access: every menu the sidebar opens (project, chat
                  and section menus alike) takes the quiet row style of the
                  worktree row menu: small text, tertiary icons. Context
                  reaches the menus through their portals. */}
              <DropdownMenuRowStyleProvider value={sidebarMenuRowStyle}>
                {/* Titlebar row: a spacer reserves the persistent titlebar corner's
              full width (traffic lights + toggle, rendered by App.tsx as the
              app root's last child). No toggle is rendered here — the corner
              owns the single app-wide toggle at constant window coordinates. */}
                <div
                  // Docked, this row is a window-drag handle. While the sidebar
                  // is a hover preview it must NOT be: `-webkit-app-region: drag`
                  // makes the OS take the cursor, so the renderer stops seeing
                  // pointer events the moment they cross this band — the leave
                  // then arrives with no destination and the preview collapses
                  // just as the user reaches for the nav below it. The titlebar
                  // corner owns dragging in the collapsed state regardless.
                  className={`@container/sidebar-titlebar flex h-10 shrink-0 items-center ${
                    overlayPresented ? 'electron-no-drag' : 'electron-drag'
                  }`}
                  style={{
                    // Same centre line as the persistent corner in App.tsx, so
                    // the resource control stays level with the toggle, the
                    // history arrows and the macOS window buttons at every
                    // interface scale.
                    paddingTop: titlebarRowPaddingTopCss(reserveTrafficLights),
                    paddingBottom:
                      titlebarRowPaddingBottomCss(reserveTrafficLights),
                  }}
                  data-testid="sidebar-titlebar"
                >
                  <div
                    className="shrink-0"
                    style={{
                      width: titlebarCornerWidthCss(
                        reserveTrafficLights,
                        false,
                      ),
                    }}
                  />
                  {showDiagnosticsPill && (
                    <div
                      // Riding the slide in would drag the pill across the
                      // window with the panel; it fades in once the panel has
                      // landed instead. Docked (no `overlayPresented`) it just
                      // renders, with no fade at startup.
                      className={`sidebar-page-stationary-control electron-no-drag ml-auto flex h-7 min-w-0 flex-1 items-center justify-end pr-2 ${
                        overlayPresented ? 'sidebar-preview-delayed-fade' : ''
                      } ${
                        previewOverlayActive && !previewSlidIn
                          ? 'sidebar-preview-instant'
                          : ''
                      }`}
                      data-preview-visible={
                        overlayPresented && previewSlidIn ? 'true' : undefined
                      }
                      data-testid="sidebar-titlebar-resource-monitor"
                    >
                      <ResourceDiagnosticsPill
                        collapsed={false}
                        ready={resourceMonitorReady}
                        statusBar
                        compactLabel
                      />
                    </div>
                  )}
                </div>

                <div className="electron-no-drag flex flex-1 flex-col overflow-hidden">
                  {/* The Personal/organization switcher heads the sidebar
                (CAN-4053): changing the context changes everything below. */}
                  <DesktopSidebarContextSwitcher
                    availability={contextAvailability}
                    action={
                      <>
                        {sharedSidebarEnabled && (
                          <Suspense fallback={null}>
                            <DesktopSidebarActivityToggle foreground="top-bar" />
                          </Suspense>
                        )}
                        <TitlebarIconButton
                          icon={SearchIcon}
                          onClick={() => openCommandPalette()}
                          data-testid="sidebar-search"
                          data-onboarding-anchor="sidebar-search"
                          aria-label="Search"
                          tooltipShortcut={SEARCH_SHORTCUT}
                        />
                      </>
                    }
                  />
                  {/* The extra hairline on top matches the top bar's bottom
                hairline beside it, so New task shares a centre line with the
                first chat tab below that bar. */}
                  <div
                    data-testid="sidebar-fixed-navigation"
                    className="flex shrink-0 flex-col gap-px px-2 pb-px pt-[calc(8px+var(--border-hairline))]"
                  >
                    {/* New task */}
                    <SidebarNavRow
                      onClick={() => onNavigate('home')}
                      data-testid="sidebar-create-task"
                      data-onboarding-anchor="task-create"
                      aria-current={activePage === 'home' ? 'page' : undefined}
                      selected={activePage === 'home'}
                      icon={<EditBigIcon size={16} />}
                      shortcut={NEW_TASK_SHORTCUT}
                    >
                      New task
                    </SidebarNavRow>
                    {!contextAvailability.available && (
                      <div className="flex items-center gap-0.5">
                        <SidebarNavRow
                          className="min-w-0 flex-1"
                          onClick={() => openCommandPalette()}
                          data-testid="sidebar-search"
                          data-onboarding-anchor="sidebar-search"
                          aria-label="Search"
                          icon={<SearchIcon size={16} aria-hidden="true" />}
                          shortcut={SEARCH_SHORTCUT}
                        >
                          Search
                        </SidebarNavRow>
                        {sharedSidebarEnabled && (
                          <Suspense fallback={null}>
                            <DesktopSidebarActivityToggle foreground="top-bar" />
                          </Suspense>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="relative min-h-0 flex-1">
                    <SidebarScrollArea
                      className="h-full min-h-0"
                      contentClassName="relative px-2"
                      viewportClassName="pb-1 sidebar-scroll-mask"
                      viewportTestId={SIDEBAR_VIEWPORT_TEST_ID}
                      onViewportWheel={(event) => {
                        const viewport = event.currentTarget;
                        if (
                          !(viewport instanceof HTMLElement) ||
                          event.deltaY === 0 ||
                          event.ctrlKey
                        ) {
                          return;
                        }

                        const maxScrollTop =
                          viewport.scrollHeight - viewport.clientHeight;
                        if (maxScrollTop <= 0) return;

                        const layout = getStickyWorkspaceRailLayout(viewport);
                        const deltaY = wheelDeltaPixels(
                          event.deltaY,
                          event.deltaMode,
                          viewport.clientHeight,
                          layout?.wheelLineHeight ??
                            DEFAULT_WHEEL_LINE_HEIGHT_PX,
                        );
                        const nextScrollTop = Math.min(
                          maxScrollTop,
                          Math.max(0, viewport.scrollTop + deltaY),
                        );
                        // A non-cancelable event belongs to a sequence the
                        // compositor is already scrolling (latched before it
                        // reached the sidebar). Its delta WILL be applied
                        // natively; applying it here as well doubles the scroll
                        // speed for the rest of the gesture. Leave it alone —
                        // the always-on scroll-driven clip still bounds any
                        // occlusion lag to a single frame.
                        if (!event.cancelable) return;
                        // Cancel EVERY cancelable vertical wheel event over the
                        // scrollable sidebar — including the first one of a
                        // sequence and events at the scroll edges. If the first
                        // event of a trackpad gesture is not canceled, Chromium
                        // latches the whole sequence to composited scrolling and
                        // dispatches the remaining events as non-cancelable: the
                        // compositor then presents scrolled frames before the
                        // main thread can sync the sticky slot/clip, painting
                        // workspace rows through the transparent sticky band on
                        // fast flings. Keeping the entire gesture on the main
                        // thread commits the scroll offset and every sticky
                        // style write in the same frame. (The sidebar has no
                        // scrollable ancestor, so there is no scroll chaining
                        // to preserve.)
                        event.preventDefault();
                        if (nextScrollTop === viewport.scrollTop) return;
                        syncStickyWorkspaceRail(viewport, nextScrollTop);
                        viewport.scrollTop = nextScrollTop;
                      }}
                      onViewportLayout={(viewport) => {
                        sidebarViewportRef.current = viewport;
                        if (viewport.scrollTop <= 0) {
                          sidebarNavigationThresholds.delete(viewport);
                        } else {
                          sidebarNavigationThresholds.set(
                            viewport,
                            measureSidebarNavigationThreshold(viewport),
                          );
                        }
                        const navigationHidden =
                          readSidebarNavigationHidden(viewport);
                        // Measure before writing. Each value below is published
                        // as a custom property, and a property written on the
                        // rail restyles everything under it; a layout read after
                        // such a write forces that restyle synchronously. On a
                        // rail with dozens of worktrees, interleaving them cost
                        // four full restyles in this one frame.
                        const headerOffset =
                          measureStickyWorkspaceHeaderOffset(viewport);
                        if (viewport.scrollTop <= 0) {
                          resetCachedStickyWorkspaceRailLayout(viewport);
                          invalidateStickyWorkspaceRailLayout(viewport);
                          clearChatsHeaderStuckAtRest(viewport);
                          // The static DOM already represents the non-sticky
                          // state. Startup mutations can fire repeatedly while
                          // dozens of workspaces mount, so defer the O(workspaces)
                          // geometry cache until the first real scroll/wheel —
                          // but keep the scroll-driven clip's geometry vars
                          // current so the very first composited fling frame is
                          // already clipped correctly.
                          const clipGeometry =
                            measureWorkspaceClipGeometry(viewport);
                          // A selection below the fold keeps its bottom-pinned
                          // row at rest, so the pin sync cannot stay deferred
                          // with the geometry cache.
                          const selectedPin =
                            measureStickySelectedPinAtRest(viewport);
                          // Expanding Chats moves Projects below the fold
                          // without moving the scroll position, so the stand-in
                          // cannot wait for the deferred geometry cache either.
                          const railAffordances =
                            measureRailAffordancesAtRest(viewport);
                          // ---- Writes only from here. ----
                          applyStickyWorkspaceHeaderOffset(
                            viewport,
                            headerOffset,
                          );
                          const stickyThreshold =
                            applyWorkspaceClipGeometryVars(clipGeometry);
                          applyStickySelectedPinAtRest(viewport, selectedPin);
                          applyRailAffordancesAtRest(railAffordances);
                          // When the threshold itself sits inside the clip band
                          // (every nav item moved into More), the always-on clip
                          // already bites the first workspace header at rest, so
                          // the pinned slot must stand in from scrollTop 0 — the
                          // geometry cache cannot stay deferred here.
                          if (
                            stickyThreshold !== null &&
                            stickyThreshold <= WORKSPACE_CLIP_BAND_PX &&
                            getStickyWorkspaceRailLayout(viewport)
                          ) {
                            syncStickyWorkspaceRail(viewport);
                          }
                          commitNavigationHidden(navigationHidden);
                          return;
                        }
                        applyStickyWorkspaceHeaderOffset(
                          viewport,
                          headerOffset,
                        );
                        invalidateStickyWorkspaceRailLayout(viewport);
                        // The rail sync below rebuilds the layout cache, which
                        // republishes the clip geometry vars as part of the build.
                        syncStickyWorkspaceRail(viewport);
                        commitNavigationHidden(navigationHidden);
                      }}
                      onViewportScroll={(event) => {
                        const viewport = event.currentTarget;
                        const navigationHidden =
                          readSidebarNavigationHidden(viewport);
                        syncStickyWorkspaceRail(viewport);
                        commitNavigationHidden(navigationHidden);
                      }}
                    >
                      <div
                        className="flow-root"
                        data-testid="sidebar-scrolling-navigation"
                      >
                        <div
                          data-testid="sidebar-primary-navigation"
                          className="sidebar-new-task-scroll-mask flex flex-col gap-px"
                        >
                          {/* Nav items */}
                          <nav
                            className="flex flex-col gap-px"
                            data-testid="sidebar-main-nav"
                            onContextMenu={(event): void => {
                              // A row with its own context menu wins.
                              if (event.defaultPrevented) return;
                              event.preventDefault();
                              // The keyboard context-menu key reports 0,0:
                              // anchor below the focused row instead.
                              const target =
                                event.target instanceof Element
                                  ? event.target.getBoundingClientRect()
                                  : null;
                              setNavContextMenu(
                                event.clientX === 0 &&
                                  event.clientY === 0 &&
                                  target
                                  ? { x: target.left, y: target.bottom }
                                  : { x: event.clientX, y: event.clientY },
                              );
                            }}
                          >
                            {mainNav.map((key) => renderMainNavItem(key))}
                          </nav>
                          {navContextMenu && (
                            <>
                              <FloatingMenuPointAnchor
                                ref={navContextMenuAnchorRef}
                                x={navContextMenu.x}
                                y={navContextMenu.y}
                                ownerDocument={document}
                              />
                              <FloatingMenu
                                open
                                onOpenChange={(open): void => {
                                  if (!open) setNavContextMenu(null);
                                }}
                                anchorRef={navContextMenuAnchorRef}
                                placement="bottom-left"
                                className="w-56"
                                aria-label="Sidebar actions"
                                data-testid="sidebar-nav-context-menu"
                                onContextMenu={(event): void =>
                                  event.preventDefault()
                                }
                              >
                                <ActionMenuRowStyle>
                                  <DropdownMenuItem
                                    data-testid="sidebar-nav-context-customize"
                                    aria-haspopup="dialog"
                                    onClick={(): void => {
                                      setNavContextMenu(null);
                                      setCustomizeOpen(true);
                                    }}
                                  >
                                    <DropdownMenuItemIcon>
                                      <SettingsIcon />
                                    </DropdownMenuItemIcon>
                                    Customize sidebar…
                                  </DropdownMenuItem>
                                </ActionMenuRowStyle>
                              </FloatingMenu>
                            </>
                          )}
                        </div>

                        {/* More, its literal 12px gap, and the one real
                      Projects header are rendered by the section as one
                      native sticky group. Only workspace rows move beneath it. */}
                        <div
                          aria-hidden="true"
                          className="h-px"
                          data-testid="sidebar-sticky-workspace-sentinel"
                        />
                        <div data-testid="sidebar-sections">
                          {sharedSidebarEnabled ? (
                            <Suspense fallback={null}>
                              {/*
                              More is a SIBLING of the band, exactly as the
                              legacy section composes it — not the band's
                              `lead`. Its `sticky top-px` only escapes to the
                              top of the rail from out here; nested inside the
                              band it cannot leave that containing block, so it
                              rode down with it and every header below seated
                              on top of everything else. The wrapper also
                              carries `data-sidebar-more-lead`, which the rail
                              measures to seat the Chats and Projects headers.
                            */}
                              <MoreStickyLead lead={moreControl} />
                              {/* No band here: the shared host renders the
                                rail's sticky band itself, around the Projects
                                header and after the Chats section, exactly
                                where the legacy section put it. */}
                              <DesktopSharedSidebarHost
                                worktreeDiffStatsStyle={worktreeDiffStatsStyle}
                              />
                            </Suspense>
                          ) : (
                            <SidebarWorkspacesSection
                              stickyHeaderLead={moreControl}
                              worktreeDiffStatsStyle={worktreeDiffStatsStyle}
                            />
                          )}
                          {!sharedSidebarEnabled &&
                            isDesktopSidebarShadowEnabled() && (
                              <Suspense fallback={null}>
                                <DesktopSidebarShadowPanel />
                              </Suspense>
                            )}
                        </div>
                      </div>
                    </SidebarScrollArea>
                    {/* Bottom pin overlay for the selected worktree / work
                  entry: the selected section portals header + row copies into
                  these hosts, and the scroll sync reveals them while the
                  selection sits below the viewport. Kept below the scrollbar
                  rail (z-50) so the overlay thumb still paints and drags over
                  the pinned band. Its own context-aware material surface backs
                  up the scroll-driven clip without introducing an opaque seam
                  in translucent or hover-preview sidebars. */}
                    <div
                      ref={bottomPinHostRef}
                      aria-hidden="true"
                      className="sidebar-selected-pin-bottom absolute inset-x-0 bottom-0 z-20 px-2"
                      data-sidebar-selected-pin-bottom=""
                      data-testid="sidebar-selected-pin-bottom"
                      hidden
                      inert
                    >
                      <Surface
                        variant="section"
                        boundary="top"
                        aria-hidden="true"
                        className="pointer-events-none absolute -top-px left-2 right-2"
                        data-testid="sidebar-selected-pin-bottom-divider"
                      />
                      <div data-sidebar-selected-pin-part="header" />
                      <div data-sidebar-selected-pin-part="group-header" />
                      <div data-sidebar-selected-pin-part="row" />
                    </div>
                  </div>
                </div>

                {/* Projects, pinned to the foot of the rail while the real band
              is below the fold — which an expanded Chats list makes the normal
              case. Sticky cannot do this (it never lifts an element above its
              own place in the flow) and Chats must stay a top-level sibling of
              Projects, so the rail carries a stand-in instead.

              It lives OUTSIDE the scroll viewport, in the footer stack. An
              earlier revision floated it over the viewport like the
              selected-item pin, which meant the rows scrolling underneath had to
              be cut away with a mask — and that mask was re-rasterised over a
              multi-thousand-pixel layer on every scroll frame, which is what
              made fast scrolling stutter and shear. Out here nothing renders
              behind it, so there is no mask, no clip, and no per-frame work.
              Hidden until the sync says the real band has left the viewport. */}
                <button
                  type="button"
                  hidden
                  data-sidebar-projects-pin-bottom=""
                  data-testid="sidebar-projects-pin-bottom"
                  // The visible word is the section's name, which alone reads as
                  // a destination. This is the same "way back" the stuck Chats
                  // header offers in the other direction, so it says so — and
                  // keeps the visible label inside the accessible name.
                  aria-label={`Back to ${WORKSPACE_LABEL_PLURAL}`}
                  className="electron-no-drag flex shrink-0 items-center gap-1 px-4 py-1.5 text-left text-s font-normal fg-quaternary transition-colors hover:fg-secondary"
                  onClick={(event): void => {
                    // Scoped to this sidebar rather than the document: every
                    // other lookup in this file resolves through the rail's own
                    // root, and a document-wide query would address the wrong
                    // instance the moment a second sidebar tree exists.
                    const root = event.currentTarget.closest<HTMLElement>(
                      SIDEBAR_ROOT_SELECTOR,
                    );
                    const scroller = root?.querySelector<HTMLElement>(
                      SIDEBAR_VIEWPORT_SELECTOR,
                    );
                    // The same band the stand-in's VISIBILITY is measured
                    // against (`resolveProjectsPinAnchor`). They must agree: if
                    // this scrolled to the sticky controls while visibility
                    // tracked the shared Projects header, the button would jump
                    // the rail a couple of hundred pixels, leave the chat list
                    // on screen, and then stay visible because the header it is
                    // judged by had not moved.
                    const band =
                      root?.querySelector<HTMLElement>(
                        PROJECTS_HEADER_SELECTOR,
                      ) ??
                      root?.querySelector<HTMLElement>(
                        STICKY_CONTROLS_SELECTOR,
                      );
                    if (!scroller || !band) return;
                    // This button hides itself the moment the band is back in
                    // view, so a keyboard user who activated it would be left
                    // with focus on a hidden element — which the browser drops to
                    // `body`, losing their place in the rail entirely. Hand focus
                    // to the real band first; it is the thing they asked for.
                    // The Projects header explicitly, not just the band's first
                    // focusable: `StickyWorkspaceControls` renders its `lead` —
                    // the More button — ahead of the header, so a generic query
                    // lands focus on More while the label promised Projects.
                    // The fallback still matters on the shared-sidebar path,
                    // which passes `workspaceHeader={null}`.
                    const bandFocusTarget =
                      band.querySelector<HTMLElement>(
                        '[data-testid="sidebar-section-code-toggle"]',
                      ) ??
                      band.querySelector<HTMLElement>(
                        'button, [href], [tabindex]:not([tabindex="-1"])',
                      ) ??
                      band;
                    bandFocusTarget.focus({ preventScroll: true });
                    // Bring the real band to the top of the rail; from there its
                    // own top stickiness takes over and every project control is
                    // the real one.
                    scroller.scrollTo({
                      top:
                        scroller.scrollTop +
                        band.getBoundingClientRect().top -
                        scroller.getBoundingClientRect().top,
                      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
                    });
                  }}
                >
                  <span className="truncate">{WORKSPACE_LABEL_PLURAL}</span>
                  <ChevronDownMediumIcon
                    size="sm"
                    className="shrink-0"
                    aria-hidden="true"
                  />
                </button>

                {/* The shared surface portals its footer callout (the bulk
              removal notice) here, so it stays on screen while the rows
              scroll. Empty, and so zero height, until it does. With the
              callout's own 6px inset, it lines up with the rows' 8px gutter. */}
                <div
                  className="electron-no-drag shrink-0 px-0.5"
                  data-sidebar-footer-callout-host=""
                />

                {/* Development context and account controls remain anchored to
              the sidebar bottom, outside the workspace scroll area. */}
                <div
                  className="electron-no-drag shrink-0"
                  data-testid="sidebar-footer-items"
                >
                  <SidebarAccountMenu
                    activePage={activePage}
                    onNavigate={onNavigate}
                    onSettingsClick={onSettingsClick}
                    settingsOpen={settingsOpen}
                    onCanopyPortalClick={onCanopyPortalClick}
                    footerBanner={
                      <>
                        {window.devInfo.isDev && (
                          <div>
                            <SidebarFooterBanner
                              className="bg-warning-subtle fg-primary shadow-md"
                              title={window.devInfo.branch ?? 'DEV'}
                              testId="sidebar-dev-item"
                            >
                              <span className="ml-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center fg-warning">
                                <DevBannerIcon
                                  size={16}
                                  aria-hidden="true"
                                  data-testid="sidebar-dev-icon"
                                />
                              </span>
                              <span className="min-w-0 flex-1 truncate">
                                {window.devInfo.branch ?? 'Development build'}
                              </span>
                              <Badge
                                tone="warning"
                                variant="solid"
                                // Nested corner: the 20px label sits 4px from
                                // the 28px `rounded-row` banner's edges
                                // (`-mr-1` against its 8px padding), 6px from
                                // early access's 32px one (`-mr-0.5`).
                                className={
                                  simplifiedSidebar ? '-mr-0.5' : '-mr-1'
                                }
                                data-testid="sidebar-dev-badge"
                              >
                                DEV
                              </Badge>
                            </SidebarFooterBanner>
                          </div>
                        )}
                      </>
                    }
                  />
                </div>
              </DropdownMenuRowStyleProvider>
            </div>
          </div>
        </div>
        {!hidden && (
          <SidebarResizeHandle
            onResize={setWidth}
            width={width}
            minWidth={sidebarMinWidthPx(
              reserveTrafficLights,
              readUiZoomFactor(),
            )}
            onDragStateChange={setIsResizing}
          />
        )}
      </aside>
      {customizeOpen && (
        <CustomizeSidebarModal
          onClose={() => setCustomizeOpen(false)}
          workersVisible={workersVisible}
          ledgerEnabled={ledgerEnabled}
          experimentHiddenKeys={experimentHiddenKeys}
        />
      )}
    </>
  );
}
