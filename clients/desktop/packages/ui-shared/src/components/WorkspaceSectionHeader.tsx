import { Dot } from './Badge';
import {
  useCallback,
  useRef,
  useState,
  type JSX,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { DropdownMenuItem, DropdownMenuItemIcon } from './DropdownMenu';
import { ActionMenuRowStyle } from './ActionMenuItems';
import { FloatingMenu, FloatingMenuPointAnchor } from './FloatingMenu';
import {
  CHAT_UNIT_LABEL,
  CHAT_UNIT_LABEL_PLURAL,
  CLOUD_BACKEND_LABEL,
  REMOTE_CONTROL_LABEL,
  WORKSPACE_LABEL,
  WORKTREE_UNIT_LABEL,
  WORKTREE_UNIT_LABEL_PLURAL,
} from '@canopy/protocol';
import {
  ArchiveIcon,
  ChevronDownIcon,
  MoreHorizontalIcon,
  PlusMediumIcon,
  SettingsIcon,
  TrashIcon,
} from '../icons/AppIcons';
import { CloudBackendIcon } from '../icons/CloudBackendIcon';
import { DeviceBackendIcon } from '../icons/DeviceBackendIcon';
import { RailIconButton } from './RailIconButton';
import { RichHoverTooltip } from './RichHoverTooltip';
import { useMediaQuery } from './useMediaQuery';
import { ProjectAvatarBadge } from './ProjectAvatarBadge';
import { WorkspaceIconDisclosureSwap } from './WorkspaceIconDisclosureSwap';
import { SIDEBAR_ROW_TRAILING_CELL_CLASSNAME } from './sidebar-item-classes';
import { SidebarPinnedBadge, SIDEBAR_PINNED_LABEL } from './SidebarPinnedBadge';
import { REPLAY_MASK_CLASS } from '../lib/replay-privacy';
import { useSidebarHeaderRest } from '../lib/useSidebarHeaderRest';

export type WorkspaceSectionWarning = 'settings-warning' | null;
export type WorkspaceSectionType = 'single-repo' | 'multi-repo' | 'cowork';

export function workspaceChildUnitLabel(
  workspaceType: WorkspaceSectionType,
  grammaticalNumber: 'singular' | 'plural' = 'singular',
):
  | typeof CHAT_UNIT_LABEL
  | typeof CHAT_UNIT_LABEL_PLURAL
  | typeof WORKTREE_UNIT_LABEL
  | typeof WORKTREE_UNIT_LABEL_PLURAL {
  if (workspaceType === 'cowork') {
    return grammaticalNumber === 'plural'
      ? CHAT_UNIT_LABEL_PLURAL
      : CHAT_UNIT_LABEL;
  }
  return grammaticalNumber === 'plural'
    ? WORKTREE_UNIT_LABEL_PLURAL
    : WORKTREE_UNIT_LABEL;
}

/** Where this workspace's work executes. Drives the header backend pip. */
export type WorkspaceSectionBackend = 'remote-control' | 'cloud';

const BACKEND_PIP = {
  'remote-control': { Icon: DeviceBackendIcon, label: REMOTE_CONTROL_LABEL },
  cloud: { Icon: CloudBackendIcon, label: CLOUD_BACKEND_LABEL },
} as const;

/**
 * One right-click action on a workspace row. Hosts supply only the actions
 * they can actually serve: a rail that cannot open the destination omits the
 * entry rather than rendering a permanently dead row, and an empty list
 * renders no menu at all.
 */
export interface WorkspaceSectionHeaderContextAction {
  readonly id: string;
  readonly label: string;
  readonly onSelect: () => void;
  readonly testId?: string;
  /** Leading glyph for the row. Hosts own the icon vocabulary. */
  readonly icon?: ReactNode;
}

export interface WorkspaceSectionHeaderProps {
  /** Workspace display name. */
  name: string;
  /**
   * `secondary` sets the name in the sidebar's quiet grey, brightening on
   * hover, for a disclosure row such as Hidden worktrees.
   */
  nameTone?: 'primary' | 'secondary';
  /** Hex color used to tint the leading badge. Mirrors desktop palette. */
  colorHex?: string;
  /** Workspace kind rendered by the leading badge. */
  workspaceType: WorkspaceSectionType;
  /**
   * GitHub owner avatar laid over a single-repo project's leading badge, the
   * kind badge staying underneath as the load/error fallback. Ignored for
   * multi-repo and cowork projects.
   */
  avatarUrl?: string;
  /**
   * Where this workspace's work executes, rendered as a small trailing pip.
   * Omitted — every host that fronts a single backend — nothing renders and the
   * header DOM is unchanged.
   */
  backend?: WorkspaceSectionBackend;
  /**
   * Marks the workspace as a transient adhoc multi-repo container. When true,
   * the section name renders with reduced emphasis to signal its temporary
   * nature. Ignored for single-repo workspaces.
   */
  temporary?: boolean;
  /** Count of worktrees attached to this workspace. */
  worktreeCount: number;
  /**
   * The user pinned this project to the top of the Projects list. The
   * sidebar header shows a quiet pin just left of the count, and hides it
   * with the count while the trailing controls are on screen.
   */
  pinnedToTop?: boolean;
  /**
   * When the count is shown.
   *
   * - `'at-rest'` (default) — visible at rest, yielding to the hover-revealed
   *   trailing controls. Today's behavior for every host.
   * - `'collapsed-only'` — shown ONLY while the section is collapsed, i.e. the
   *   one state where the rows it counts are not on screen to be counted.
   * - `'hidden'` — never shown (desktop early access).
   */
  countPresentation?: 'at-rest' | 'collapsed-only' | 'hidden';
  /** Restrict visible rail typography to the sidebar's sm/xs scale. */
  textScale?: 'default' | 'sidebar';
  /** Optional repo count rendered as the multi-repo sub-label. */
  repoCount?: number;
  /**
   * Optional list of repo names for the multi-repo sub-label tooltip. When
   * supplied, the `<N> repos` count becomes a hover/focus tooltip target
   * that lists the underlying repos. Capped at the first 12 entries with a
   * `+ N more` line for long lists. Ignored for single-repo workspaces and
   * when omitted.
   */
  repoNames?: string[];
  /** True iff the section is currently collapsed. */
  collapsed: boolean;
  /** Optional warning treatment for the settings-button affordance. */
  warning?: WorkspaceSectionWarning;
  /** Whether the section can be toggled. Defaults to `worktreeCount > 0`. */
  canToggleCollapse?: boolean;
  /** True when the leading badge is non-interactive (drag disabled). */
  disableDrag?: boolean;
  /** Whether to render the trailing collapse chevron. Defaults to true. */
  showCollapseChevron?: boolean;
  /**
   * Render the disclosure chevron over the leading icon slot instead of the
   * trailing action rail: the workspace icon shows at rest (no chevron in the
   * default state, even while collapsed), and hovering or focusing the row
   * swaps the icon for the chevron in place, so the row never reflows. When a
   * `dragHandleSlot` is supplied, the host owns rendering that swap inside
   * its slot (wrap the icon in `WorkspaceIconDisclosureSwap`); without a
   * slot, the built-in badge is wrapped automatically.
   *
   * Setting this also makes the trailing action region inert for collapse:
   * the deferred hover-action overlay keeps its own presses instead of
   * routing the first one to disclosure. That routing only existed because
   * the row had no visible disclosure affordance; the icon-slot chevron
   * replaces it, and keeping both turns every near-miss on settings/add into
   * an accidental collapse.
   *
   * Only applies when the primary button owns the collapse toggle (i.e. no
   * `onSelectName`) and the section can actually be toggled. Defaults to
   * false so surfaces with a dedicated trailing chevron are unaffected.
   */
  inlineCollapseChevron?: boolean;
  /** True when the "+" add affordance is disabled (e.g. no repos yet). */
  addDisabled?: boolean;
  /** Optional tooltip rendered on the disabled add affordance. */
  addDisabledTitle?: string;
  /** Click handler for the collapse toggle. */
  onToggleCollapse: () => void;
  /** Optional select-workspace click on the leading badge area. */
  onSelectBadge?: () => void;
  /**
   * Optional select-workspace click on the name/count button. When supplied,
   * the trailing chevron remains the dedicated collapse control.
   */
  onSelectName?: () => void;
  /** Optional add-worktree button handler. Button is hidden when omitted. */
  onAdd?: () => void;
  /** Optional settings button handler. Button is hidden when omitted. */
  onSettings?: () => void;
  /** Optional row-options button handler. Button is hidden when omitted. */
  onOptions?: (event: MouseEvent<HTMLButtonElement>) => void;
  /**
   * Optional delete-workspace button handler. Button is hidden when omitted
   * (the browser Remote Control only supplies it behind the destructive-actions
   * flag). Rendered with destructive styling; the host is responsible for the
   * confirmation dialog.
   */
  onDelete?: () => void;
  /**
   * Wording, glyph, and tone for `onDelete`. `'archive'` presents the
   * reversible server-side archive that hosts without a settings dialog hang
   * on the row itself; `'delete'` (the default) keeps the destructive trash
   * treatment existing hosts already render.
   */
  removalPresentation?: 'archive' | 'delete';
  /** Optional drag handle attributes/listeners forwarded as a slot wrapper. */
  dragHandleSlot?: ReactNode;
  /** Stable testid hook for automation on the outer wrapper. */
  dataTestId?: string;
  /**
   * Appended to `dataTestId` and to every fixed test id this header and its
   * badge emit. A header is rendered up to four times at once — in flow, in
   * the sticky slot and in both selected-pin bands — so a copy's controls
   * must stay addressable apart from the in-flow header's, by the convention
   * pinned rows already use: `-sticky-slot`, `-pin-top`, `-pin-bottom`. Omit
   * for the in-flow header, whose ids stay bare (CAN-3127).
   */
  testIdSuffix?: string;
  /**
   * Optional data attributes applied to the inline "add" button. Useful for
   * stamping onboarding anchors or test ids on the button without coupling
   * the shared header to onboarding concerns.
   */
  addButtonDataAttrs?: Record<`data-${string}`, string>;
  /** Optional data attributes applied to the row-options button. */
  optionsButtonDataAttrs?: Record<`data-${string}`, string>;
  /**
   * Optional data attributes applied to the primary name/collapse button.
   * Shared disclosure rows use this to preserve stable automation hooks.
   */
  primaryButtonDataAttrs?: Record<`data-${string}`, string>;
  /**
   * When true, the inline add button renders without requiring hover. Used
   * by guided tours to keep the button visible while the user follows the
   * popover. Defaults to false (hover-only, the existing behavior).
   */
  forceShowAddButton?: boolean;
  /**
   * When true, every hover-gated header control (settings button, add button,
   * collapse chevron) renders in its visible state without requiring hover, so
   * hovering the header produces no layout reflow. Used by guided tours that
   * anchor a popover to this header and must not have the anchor jitter when
   * the pointer enters the header. Defaults to false (hover-only behavior).
   */
  forceShowControls?: boolean;
  /**
   * Keep pointer-only hover actions overlaid and route the initial press to
   * disclosure until the pointer moves within the row. A direct
   * enter-and-press at the resting counter therefore still toggles the section,
   * while keyboard focus reveals and activates the actions immediately. Only
   * the slot's background is routed that way: a press that lands on a revealed
   * control (add, settings, delete, chevron) always runs that control.
   *
   * `inlineCollapseChevron` disables that press routing: with a visible
   * chevron in the left region the row no longer needs its trailing controls
   * to double as a disclosure target.
   */
  deferHoverActions?: boolean;
  /**
   * Enforce a ≥44px touch target on the header's primary (collapse/select) row
   * (CAN-1206). Opt-in so the desktop rail stays pixel-identical; the web
   * portal passes it only for the mobile-drawer variant.
   */
  touchTarget?: boolean;
  /**
   * Right-click actions for this workspace row. Omitted or empty renders no
   * context menu and leaves the browser's own menu alone.
   */
  contextMenuActions?: readonly WorkspaceSectionHeaderContextAction[];
  /**
   * Host-rendered rows appended to the context menu after `contextMenuActions`.
   * The host owns their items and closes the menu through `close` once a
   * command has run. Supplying this alone is enough to enable the menu.
   */
  renderContextMenuItems?: (close: () => void) => ReactNode;
  /**
   * Show the row-options button and have it open the context menu under the
   * button, as desktop's project header does. Ignored without a context menu
   * and superseded by an explicit `onOptions`.
   */
  optionsOpensContextMenu?: boolean;
  /**
   * Hides the row-options button for fine pointers, for a host whose menu
   * opens by right-click. The button stays mounted, so touch (which has no
   * right-click) keeps it.
   */
  hideOptionsForFinePointer?: boolean;
  /** Accessible name and automation hook for the context menu surface. */
  contextMenuLabel?: string;
  contextMenuTestId?: string;
}

/**
 * Workspace section header used at the top of every workspace block in the
 * left worktree rail. Pure display: drag, select, add, settings, and
 * collapse handlers are forwarded by the host (desktop wraps with dnd-kit,
 * web wraps with portal command dispatch).
 */
/**
 * Hover-yield padding for the name button, indexed by how many trailing
 * controls reveal on a fine pointer. Static strings so Tailwind can see every
 * class; 28px per control, 4px for the slot's gaps and inset.
 * The layout group survives rest, so a focused trailing control keeps its
 * reserved space even after the hover-reveal group has been retired.
 */
const DEFERRED_ACTION_PADDING: readonly string[] = [
  '',
  'pointer-fine:group-hover/sidebar-item:pr-8 pointer-fine:group-focus-within/sidebar-item:pr-8 pointer-fine:workspace-header-actions-focused:pr-8',
  'pointer-fine:group-hover/sidebar-item:pr-15 pointer-fine:group-focus-within/sidebar-item:pr-15 pointer-fine:workspace-header-actions-focused:pr-15',
  'pointer-fine:group-hover/sidebar-item:pr-22 pointer-fine:group-focus-within/sidebar-item:pr-22 pointer-fine:workspace-header-actions-focused:pr-22',
  'pointer-fine:group-hover/sidebar-item:pr-29 pointer-fine:group-focus-within/sidebar-item:pr-29 pointer-fine:workspace-header-actions-focused:pr-29',
  'pointer-fine:group-hover/sidebar-item:pr-36 pointer-fine:group-focus-within/sidebar-item:pr-36 pointer-fine:workspace-header-actions-focused:pr-36',
];

export function WorkspaceSectionHeader({
  name,
  nameTone = 'primary',
  colorHex,
  workspaceType,
  avatarUrl,
  backend,
  temporary,
  worktreeCount,
  pinnedToTop = false,
  countPresentation = 'at-rest',
  textScale = 'default',
  repoCount,
  repoNames,
  collapsed,
  warning,
  canToggleCollapse,
  disableDrag,
  showCollapseChevron = true,
  inlineCollapseChevron = false,
  addDisabled,
  addDisabledTitle,
  onToggleCollapse,
  onSelectBadge,
  onSelectName,
  onAdd,
  onSettings,
  onOptions: onOptionsProp,
  onDelete,
  removalPresentation = 'delete',
  dragHandleSlot,
  dataTestId,
  testIdSuffix = '',
  addButtonDataAttrs,
  optionsButtonDataAttrs,
  primaryButtonDataAttrs,
  forceShowAddButton,
  forceShowControls,
  deferHoverActions,
  touchTarget = false,
  contextMenuActions,
  renderContextMenuItems,
  optionsOpensContextMenu = false,
  hideOptionsForFinePointer = false,
  contextMenuLabel = `${WORKSPACE_LABEL} actions`,
  contextMenuTestId = 'workspace-section-context-menu',
}: WorkspaceSectionHeaderProps): JSX.Element {
  const hasContextMenu =
    (contextMenuActions?.length ?? 0) > 0 ||
    renderContextMenuItems !== undefined;
  // The control the menu hands focus back to when it closes: the options
  // button that opened it, or the header row itself for a right-click. The
  // menu is positioned against an inert pointer anchor that cannot hold focus,
  // so without this Escape dropped focus onto the document body.
  const contextMenuReturnFocusRef = useRef<HTMLElement | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const headerRest = useSidebarHeaderRest(
    collapsed === true,
    contextMenu !== null,
  );
  // The options button either runs the caller's handler or, on desktop's
  // project rows, opens the same menu a right-click does — under the button.
  const onOptions:
    | ((event: MouseEvent<HTMLButtonElement>) => void)
    | undefined =
    onOptionsProp ??
    (optionsOpensContextMenu && hasContextMenu
      ? (event): void => {
          const rect = event.currentTarget.getBoundingClientRect();
          contextMenuReturnFocusRef.current = event.currentTarget;
          setContextMenu({ x: rect.left, y: rect.bottom });
        }
      : undefined);
  const displayName =
    typeof name === 'string' && name.trim().length > 0
      ? name
      : 'Untitled project';
  const isMultiRepo = workspaceType === 'multi-repo';
  const childUnitLabel = workspaceChildUnitLabel(workspaceType).toLowerCase();
  const childUnitLabelPlural = workspaceChildUnitLabel(
    workspaceType,
    'plural',
  ).toLowerCase();
  const computedCanToggle = canToggleCollapse ?? worktreeCount > 0;
  // Pointer behavior cannot be expressed with responsive CSS alone. Default
  // to fine-pointer semantics during SSR, then follow the live primary pointer.
  const isCoarsePointer = useMediaQuery('(pointer: coarse)');
  const nameTogglesCollapse = isCoarsePointer || onSelectName === undefined;
  const collapseLabel = computedCanToggle
    ? collapsed
      ? `Expand ${displayName}`
      : `Collapse ${displayName}`
    : `${displayName} has no ${childUnitLabelPlural}`;
  const hasSettingsWarning = warning === 'settings-warning';
  const hasPersistentControls =
    Boolean(forceShowControls) ||
    Boolean(onSettings && hasSettingsWarning) ||
    Boolean(onOptions && forceShowControls) ||
    Boolean(onAdd && (addDisabled || forceShowAddButton)) ||
    Boolean(showCollapseChevron && computedCanToggle && !deferHoverActions);
  const defersPointerHoverActions =
    Boolean(deferHoverActions) && !hasPersistentControls;
  // The name yields exactly the width the revealed controls occupy: 24px per
  // control plus the slot's gaps. Counting them — rather than assuming two, or
  // three with an options menu — is what keeps the name from running under
  // the settings cog when a caller reveals settings, add AND the collapse
  // chevron (CAN-3053). The chevron only renders on fine pointers, which is
  // the only place this padding applies.
  // An options button hidden for fine pointers takes no room there.
  const deferredControlCount =
    [
      onDelete,
      onSettings,
      hideOptionsForFinePointer ? undefined : onOptions,
      onAdd,
    ].filter((handler) => handler !== undefined).length +
    (showCollapseChevron ? 1 : 0);
  const deferredActionPadding =
    DEFERRED_ACTION_PADDING[
      Math.min(deferredControlCount, DEFERRED_ACTION_PADDING.length - 1)
    ];
  // The inline chevron is the row's disclosure affordance, so the trailing
  // controls stop doubling as one.
  const usesInlineChevron =
    inlineCollapseChevron && nameTogglesCollapse && computedCanToggle;
  const primaryButtonIsDragActivator =
    primaryButtonDataAttrs?.['data-workspace-drag-activator'] !== undefined;
  const guardsPointerHoverActions =
    defersPointerHoverActions &&
    worktreeCount > 0 &&
    computedCanToggle &&
    !usesInlineChevron;
  const actionSlotRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const contextMenuAnchorRef = useRef<HTMLSpanElement | null>(null);
  const handleContextMenu = (event: MouseEvent<HTMLDivElement>): void => {
    if (!hasContextMenu) return;
    event.preventDefault();
    event.stopPropagation();
    // As the desktop project header did: the row takes focus with its menu, so
    // its revealed controls stay put and Escape has a place to return to.
    rootRef.current?.focus({ preventScroll: true });
    contextMenuReturnFocusRef.current = rootRef.current;
    setContextMenu({ x: event.clientX, y: event.clientY });
  };
  const pointerHoverActionsInteractiveRef = useRef(false);
  const suppressGuardedActionClickRef = useRef(false);
  const isPointWithinActionSlot = useCallback(
    (clientX: number, clientY: number): boolean => {
      const rect = actionSlotRef.current?.getBoundingClientRect();
      return Boolean(
        rect &&
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom,
      );
    },
    [],
  );
  const handlePointerEnter = useCallback(
    (event: PointerEvent): void => {
      if (!guardsPointerHoverActions) return;
      if (
        event.relatedTarget instanceof Node &&
        event.currentTarget.contains(event.relatedTarget)
      ) {
        return;
      }
      pointerHoverActionsInteractiveRef.current = !isPointWithinActionSlot(
        event.clientX,
        event.clientY,
      );
    },
    [guardsPointerHoverActions, isPointWithinActionSlot],
  );
  const handlePointerMove = useCallback(
    (event: PointerEvent): void => {
      if (
        !guardsPointerHoverActions ||
        pointerHoverActionsInteractiveRef.current
      ) {
        return;
      }
      if (!isPointWithinActionSlot(event.clientX, event.clientY)) {
        pointerHoverActionsInteractiveRef.current = true;
        suppressGuardedActionClickRef.current = false;
      }
    },
    [guardsPointerHoverActions, isPointWithinActionSlot],
  );

  const handlePointerLeave = useCallback(
    (event: PointerEvent): void => {
      if (!guardsPointerHoverActions) return;
      if (
        event.relatedTarget instanceof Node &&
        event.currentTarget.contains(event.relatedTarget)
      ) {
        return;
      }
      pointerHoverActionsInteractiveRef.current = false;
      suppressGuardedActionClickRef.current = false;
    },
    [guardsPointerHoverActions],
  );
  const handleActionPointerDownCapture = useCallback(
    (event: PointerEvent): void => {
      if (!guardsPointerHoverActions || event.button !== 0) {
        return;
      }
      if (
        pointerHoverActionsInteractiveRef.current ||
        event.pointerType === 'touch'
      ) {
        suppressGuardedActionClickRef.current = false;
        return;
      }
      // Only the slot's own background is ambiguous. By the time the press
      // lands the controls are revealed under the cursor, so a press ON one of
      // them is a deliberate press of that control — rerouting it to
      // disclosure collapses the workspace instead of running the action (the
      // accidental-collapse trade `inlineCollapseChevron` documents, which
      // hosts without an inline chevron were still paying).
      if (
        event.target instanceof Element &&
        event.target.closest('button, a, [role="button"]')
      ) {
        suppressGuardedActionClickRef.current = false;
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      suppressGuardedActionClickRef.current = true;
      onToggleCollapse();
    },
    [guardsPointerHoverActions, onToggleCollapse],
  );
  const handleActionKeyDownCapture = useCallback((): void => {
    suppressGuardedActionClickRef.current = false;
  }, []);
  const handleActionPointerCancelCapture = useCallback((): void => {
    suppressGuardedActionClickRef.current = false;
  }, []);
  const handleActionClickCapture = useCallback((event: MouseEvent): void => {
    if (!suppressGuardedActionClickRef.current) return;
    suppressGuardedActionClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  // The row's hover highlight spans the whole header, so the disclosure
  // hitbox matches it: clicks on the row background (padding, gaps, the
  // strips above and below the controls) toggle collapse. Interactive
  // controls keep their own actions, and the trailing action region stays
  // inert so a near-miss on settings/add cannot collapse the section (see
  // the inlineCollapseChevron docs above).
  // A pointer click on a control inside the header (the icon handle, the
  // name) leaves that control focused, and `group-focus-within` would then
  // keep the hover actions revealed instead of restoring the counter. The
  // callers gate on `event.detail > 0`, so keyboard activation (detail 0)
  // keeps its focus location and accessible action reveal — the legacy
  // ProjectHeader rule.
  const clearPointerFocus = (): void => {
    const root = rootRef.current;
    const active = root?.ownerDocument.activeElement;
    if (root && active instanceof HTMLElement && root.contains(active)) {
      active.blur();
    }
  };
  const handleRowBackgroundClick = (
    event: MouseEvent<HTMLDivElement>,
  ): void => {
    if (!computedCanToggle) return;
    if (event.target instanceof Element) {
      if (event.target.closest('[data-workspace-header-actions]')) {
        return;
      }
      const button = event.target.closest('button');
      // Buttons own their actions — except the icon drag handle: for
      // keyboard/AT it is a pure reorder control (Enter/Space pick up
      // dnd-kit's sortable, matching its "Reorder" name), while a plain
      // POINTER click that never became a drag falls through to the row
      // toggle here, so the hover-revealed chevron still responds to clicks.
      // Keyboard activation synthesizes detail-0 clicks and must not fall
      // through — a "Reorder" control collapsing the section would
      // contradict its announced semantics when dragging is disabled.
      if (
        button &&
        (button.dataset.workspaceDragActivator !== 'icon' || event.detail === 0)
      ) {
        return;
      }
    }
    onToggleCollapse();
    if (event.detail > 0) clearPointerFocus();
  };

  // The leading badge doubles as the drag handle (when dragHandleSlot is
  // supplied) and as a select-workspace affordance (when onSelectBadge is
  // supplied). When dragHandleSlot is omitted, desktop still wants the badge
  // to be tinted but non-grabbable.
  const badgeClickable = !disableDrag || onSelectBadge !== undefined;
  const badgeBaseClass = `focus-ring relative inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
    onSelectBadge && disableDrag ? 'cursor-pointer' : 'cursor-default'
  }`;

  const badgeKind = (
    <ProjectAvatarBadge
      testIdSuffix={testIdSuffix}
      kind={workspaceType}
      temporary={temporary}
      color={colorHex}
      avatarUrl={avatarUrl}
    />
  );
  // Hosts that supply a dragHandleSlot render the disclosure swap inside
  // their own slot; the built-in badge only wraps itself.
  const badgeContent = usesInlineChevron ? (
    <WorkspaceIconDisclosureSwap
      collapsed={collapsed}
      testIdSuffix={testIdSuffix}
    >
      {badgeKind}
    </WorkspaceIconDisclosureSwap>
  ) : (
    badgeKind
  );

  // Sits outside the name button: that button carries an explicit `aria-label`,
  // which would suppress a nested label entirely for assistive tech.
  //
  // Yields to the hover actions exactly as the worktree counter does. When
  // `deferHoverActions` is on, the action slot becomes `absolute inset-y-0
  // right-0` on reveal — the pip's own spot — and the positioned sibling paints
  // over it. Hiding is the same trade the counter already makes for this
  // collision, and the pip's information is at rest, not mid-interaction.
  // Gates the DISPLAY only: `worktreeCount` still drives `computedCanToggle`
  // and the hover-action guard, which must not change with presentation.
  const countVisible =
    worktreeCount > 0 &&
    countPresentation !== 'hidden' &&
    (countPresentation === 'at-rest' || collapsed === true);
  // What sits at the trailing edge at rest (the count, and a pinned header's
  // pin) yields to the trailing controls whenever they are on screen. Those
  // controls are hover-revealed on a fine pointer but ALWAYS shown on a coarse
  // one (`pointer-coarse:flex` below), so hiding only on hover left both
  // rendered on top of each other at rest on touch (CAN-2518). Mirror the
  // controls' visibility exactly on both pointer types.
  // Slot focus can outlive collapse; its visibility must also retire the
  // counter and pin independently of the hover-reveal group.
  const atRestTrailingClassName = defersPointerHoverActions
    ? 'pointer-fine:group-hover/sidebar-item:hidden pointer-fine:group-focus-within/sidebar-item:hidden pointer-fine:workspace-header-actions-focused:hidden'
    : onDelete || onSettings || onOptions || onAdd || showCollapseChevron
      ? 'group-hover/sidebar-item:hidden group-focus-within/sidebar-item:hidden pointer-coarse:hidden'
      : '';
  // The rows' trailing cell. The header row is inset 4px on the right where
  // the rows below it are inset 6px, so `mr-0.5` puts the count on the same
  // right edge as their ages and counts. Narrowed on touch, where the header's
  // 44px controls stay beside it; the right edge stays put either way.
  const sidebarCounter =
    textScale === 'sidebar' && countVisible ? (
      <span
        className={`${SIDEBAR_ROW_TRAILING_CELL_CLASSNAME} mr-0.5 pointer-coarse:w-5 ${atRestTrailingClassName}`}
        data-testid={`workspace-section-counter${testIdSuffix}`}
      >
        {worktreeCount}
      </span>
    ) : null;
  const backendPip = ((): JSX.Element | null => {
    if (backend === undefined) return null;
    const { Icon, label } = BACKEND_PIP[backend];
    return (
      <span
        role="img"
        aria-label={label}
        title={label}
        data-testid={`workspace-backend-pip${testIdSuffix}`}
        data-backend={backend}
        className={`inline-flex shrink-0 items-center fg-tertiary ${
          defersPointerHoverActions
            ? 'pointer-fine:group-hover/sidebar-item:hidden pointer-fine:group-focus-within/sidebar-item:hidden pointer-fine:workspace-header-actions-focused:hidden'
            : onDelete || onSettings || onAdd || showCollapseChevron
              ? 'group-hover/sidebar-item:hidden group-focus-within/sidebar-item:hidden'
              : ''
        }`}
      >
        <Icon size="sm" />
      </span>
    );
  })();

  const nameLabel = (
    <span
      className={`${REPLAY_MASK_CLASS} min-w-0 truncate ${textScale === 'sidebar' ? 'text-s font-normal' : 'text-m font-semibold'} leading-snug ${isMultiRepo && textScale !== 'sidebar' ? 'fg-info' : nameTone === 'secondary' ? 'fg-secondary transition-colors group-hover/sidebar-item:fg-primary' : 'fg-primary'}`}
      title={displayName}
    >
      {displayName}
    </span>
  );

  // The icon-slot disclosure swap makes the badge the visible collapse
  // affordance, so without a select action the built-in badge toggles and its
  // accessible name says so ("workspace" keeps it distinct from the primary
  // toggle's name for assistive tech and automation). Host-provided drag
  // handles instead stay reorder controls; their pointer clicks reach the
  // toggle through handleRowBackgroundClick's icon fall-through.
  const iconToggleLabel = collapsed
    ? `Expand project ${displayName}`
    : `Collapse project ${displayName}`;
  const badge =
    usesInlineChevron && !onSelectBadge ? (
      <button
        type="button"
        className={badgeBaseClass}
        aria-label={iconToggleLabel}
        onClick={onToggleCollapse}
      >
        {badgeContent}
      </button>
    ) : badgeClickable ? (
      <button
        type="button"
        className={badgeBaseClass}
        aria-label={
          onSelectBadge ? `Select ${displayName}` : `Reorder ${displayName}`
        }
        onClick={onSelectBadge}
      >
        {badgeContent}
      </button>
    ) : (
      <span className={badgeBaseClass} aria-hidden="true">
        {badgeContent}
      </span>
    );

  // The inner flex row normally owns the minimum height so it matches the 24px
  // action controls. Sidebar touch layouts also expand the outer wrapper to the
  // 44px touch-target minimum, preventing its controls from overlapping the
  // next row. Hover actions can enter layout without changing the header height.
  return (
    <div
      ref={rootRef}
      data-testid={
        dataTestId === undefined ? undefined : `${dataTestId}${testIdSuffix}`
      }
      // `min-w-0 flex-1`: hosts mount this header as a flex item (e.g. inside
      // SidebarSection's header row). Without an explicit minimum the nowrap
      // workspace name's min-content width would become the whole sidebar's
      // floor, forcing horizontal overflow at narrow widths instead of letting
      // the name truncate.
      className={`${headerRest.resting ? '' : 'group group/sidebar-item '}min-w-0 flex-1 ${textScale === 'sidebar' ? 'rounded-row' : 'rounded-md'} ${
        textScale === 'sidebar'
          ? `${touchTarget ? 'min-h-11' : 'h-8'} py-0 pl-1.5 pr-1`
          : 'px-1.5 py-1.5'
      } ${
        textScale === 'sidebar'
          ? 'fg-primary hover:bg-subtle duration-0'
          : 'fg-primary/80 hover:bg-subtle hover:fg-primary'
      } transition-colors`}
      data-sidebar-header-resting={headerRest.resting || undefined}
      onPointerEnter={(event): void => {
        headerRest.onPointerEnter(event);
        handlePointerEnter(event);
      }}
      onFocusCapture={headerRest.onFocusCapture}
      onKeyDownCapture={headerRest.onKeyDownCapture}
      onPointerMove={(event): void => {
        headerRest.onPointerMove(event);
        handlePointerMove(event);
      }}
      onPointerLeave={handlePointerLeave}
      onClick={usesInlineChevron ? handleRowBackgroundClick : undefined}
      onContextMenu={hasContextMenu ? handleContextMenu : undefined}
      // Programmatically focusable only, so a right-click menu can return focus
      // here; the row stays out of the Tab order.
      tabIndex={hasContextMenu ? -1 : undefined}
    >
      <div
        className={`group/workspace-header relative flex items-center ${textScale === 'sidebar' ? 'h-full gap-1.5' : 'gap-1'} ${touchTarget ? 'min-h-11' : textScale === 'sidebar' ? '' : 'min-h-6'}`}
      >
        {dragHandleSlot !== undefined ? dragHandleSlot : badge}

        <button
          type="button"
          onClick={(event): void => {
            if (nameTogglesCollapse) onToggleCollapse();
            else onSelectName?.();
            if (event.detail > 0) clearPointerFocus();
          }}
          disabled={nameTogglesCollapse && !computedCanToggle}
          {...(primaryButtonDataAttrs ?? {})}
          className={`focus-ring flex min-w-0 flex-1 items-center gap-2 text-left ${primaryButtonIsDragActivator ? 'cursor-default ' : ''}disabled:cursor-default${
            defersPointerHoverActions ? ` ${deferredActionPadding}` : ''
          }${touchTarget ? ' min-h-11 self-stretch' : ''}`}
          aria-label={`${nameTogglesCollapse ? collapseLabel : `Select ${displayName}`}${
            pinnedToTop ? `, ${SIDEBAR_PINNED_LABEL}` : ''
          }`}
          aria-expanded={
            nameTogglesCollapse && computedCanToggle ? !collapsed : undefined
          }
        >
          {nameLabel}
          {textScale !== 'sidebar' && countVisible && (
            <span className="shrink-0 text-s fg-secondary">
              {worktreeCount}
            </span>
          )}
          {textScale === 'sidebar' && pinnedToTop ? (
            // One trailing group, so the pin sits just left of the count
            // instead of splitting the free space with the counter's own
            // `ml-auto`. Unpinned headers keep the bare counter.
            <span className="ml-auto flex shrink-0 items-center">
              <SidebarPinnedBadge
                testId={`workspace-section-pinned-badge${testIdSuffix}`}
                fadeOnRowHover={false}
                className={atRestTrailingClassName}
              />
              {sidebarCounter}
            </span>
          ) : (
            sidebarCounter
          )}
        </button>

        {backendPip}

        <div
          ref={actionSlotRef}
          data-testid={`workspace-section-actions${testIdSuffix}`}
          data-workspace-header-actions="true"
          // 2px from the row's edge on every side: the header's 4px end
          // padding holds its resting count, so only the controls move out.
          className={`${
            hasPersistentControls
              ? 'flex shrink-0 items-center gap-0.5 -mr-0.5'
              : defersPointerHoverActions
                ? // Once revealed this overlay sits above the primary button
                  // and swallows presses that land between the controls, so
                  // the trailing region cannot reach the collapse toggle.
                  'flex shrink-0 items-center gap-0.5 pointer-fine:invisible pointer-fine:absolute pointer-fine:inset-y-0 pointer-fine:-right-0.5 pointer-fine:group-hover/sidebar-item:visible pointer-fine:group-focus-within/sidebar-item:visible pointer-fine:focus-within:visible'
                : 'hidden shrink-0 items-center gap-0.5 -mr-0.5 group-hover/sidebar-item:flex group-focus-within/sidebar-item:flex focus-within:flex pointer-coarse:flex'
          } pointer-coarse:gap-0`}
          onPointerDownCapture={handleActionPointerDownCapture}
          onPointerCancelCapture={handleActionPointerCancelCapture}
          onKeyDownCapture={handleActionKeyDownCapture}
          onClickCapture={handleActionClickCapture}
        >
          {onDelete && (
            <RailIconButton
              icon={removalPresentation === 'archive' ? ArchiveIcon : TrashIcon}
              onClick={onDelete}
              data-testid={`workspace-section-remove${testIdSuffix}`}
              hoverSurface
              revealOnItemHover={!forceShowControls}
              coarsePointerTarget
              tone={
                removalPresentation === 'archive' ? 'neutral' : 'destructive'
              }
              aria-label={
                removalPresentation === 'archive'
                  ? `Archive project ${displayName}`
                  : `Delete ${displayName}`
              }
              tooltipLabel={
                removalPresentation === 'archive'
                  ? 'Archive project'
                  : undefined
              }
            />
          )}

          {onSettings && (
            <span className="relative inline-flex">
              <RailIconButton
                icon={SettingsIcon}
                onClick={onSettings}
                hoverSurface
                revealOnItemHover={!hasSettingsWarning && !forceShowControls}
                coarsePointerTarget
                tone="neutral"
                aria-label={`Settings for ${displayName}`}
                tooltipLabel="Settings"
              />
              {hasSettingsWarning && (
                <Dot
                  tone="unread"
                  data-testid={`workspace-settings-warning-dot${testIdSuffix}`}
                  className="pointer-events-none absolute right-0.5 top-0.5"
                />
              )}
            </span>
          )}

          {onOptions && (
            // `contents` keeps the button a direct flex item of the slot;
            // the fine-pointer variant hides it where right-click opens the
            // same menu.
            <span
              className={
                hideOptionsForFinePointer
                  ? 'contents pointer-fine:hidden'
                  : 'contents'
              }
            >
              <RailIconButton
                icon={MoreHorizontalIcon}
                onClick={onOptions}
                {...(optionsButtonDataAttrs ?? {})}
                hoverSurface
                aria-haspopup="menu"
                revealOnItemHover={!forceShowControls}
                coarsePointerTarget
                aria-label={`More actions for ${displayName}`}
                tooltipLabel="More actions"
              />
            </span>
          )}

          {onAdd && (
            <RailIconButton
              icon={PlusMediumIcon}
              onClick={onAdd}
              disabled={addDisabled}
              {...(addButtonDataAttrs ?? {})}
              hoverSurface
              revealOnItemHover={
                !addDisabled && !(forceShowAddButton || forceShowControls)
              }
              coarsePointerTarget
              aria-label={`Create ${childUnitLabel} for ${displayName}`}
              tooltipLabel={
                addDisabled ? addDisabledTitle : `Create ${childUnitLabel}`
              }
            />
          )}

          {showCollapseChevron && !isCoarsePointer && (
            <RailIconButton
              icon={ChevronDownIcon}
              iconClassName={collapsed ? '-rotate-90' : 'rotate-0'}
              onClick={(event): void => {
                onToggleCollapse();
                if (event.detail > 0) clearPointerFocus();
              }}
              disabled={!computedCanToggle}
              hoverSurface
              revealOnItemHover={!computedCanToggle && !forceShowControls}
              coarsePointerTarget
              touchTarget={touchTarget}
              aria-label={collapseLabel}
            />
          )}
        </div>
      </div>
      {isMultiRepo && repoCount !== undefined && textScale !== 'sidebar' && (
        <div className="ml-6 -mt-1.5">
          <RepoCountWithTooltip
            count={repoCount}
            repoNames={repoNames}
            textScale={textScale}
          />
        </div>
      )}
      {contextMenu !== null &&
        hasContextMenu &&
        rootRef.current?.ownerDocument.body !== undefined && (
          <>
            <FloatingMenuPointAnchor
              ref={contextMenuAnchorRef}
              x={contextMenu.x}
              y={contextMenu.y}
              ownerDocument={rootRef.current.ownerDocument}
              data-testid={`${contextMenuTestId}-anchor`}
            />
            <FloatingMenu
              open
              onOpenChange={(open): void => {
                if (!open) setContextMenu(null);
              }}
              anchorRef={contextMenuAnchorRef}
              returnFocusRef={contextMenuReturnFocusRef}
              placement="bottom-left"
              className="w-45"
              aria-label={contextMenuLabel}
              data-testid={contextMenuTestId}
              onContextMenu={(event): void => event.preventDefault()}
            >
              <ActionMenuRowStyle>
                {contextMenuActions?.map((action) => (
                  <DropdownMenuItem
                    key={action.id}
                    data-testid={action.testId}
                    onClick={(): void => {
                      setContextMenu(null);
                      action.onSelect();
                    }}
                  >
                    {action.icon && (
                      <DropdownMenuItemIcon>{action.icon}</DropdownMenuItemIcon>
                    )}
                    <span className="truncate">{action.label}</span>
                  </DropdownMenuItem>
                ))}
                {renderContextMenuItems?.((): void => setContextMenu(null))}
              </ActionMenuRowStyle>
            </FloatingMenu>
          </>
        )}
    </div>
  );
}

const REPO_TOOLTIP_MAX_NAMES = 12;
const REPO_TOOLTIP_GAP = 6;

/**
 * Renders the `<N> repo(s)` count for a multi-repo workspace, wrapping it in
 * a hover/focus tooltip when `repoNames` is supplied. Renders without a
 * tooltip when `repoNames` is empty.
 */
function RepoCountWithTooltip({
  count,
  repoNames,
  textScale,
}: {
  count: number;
  repoNames?: string[];
  textScale: 'default' | 'sidebar';
}): JSX.Element {
  const label = `${count} ${count === 1 ? 'repo' : 'repos'}`;
  const hasNames = Array.isArray(repoNames) && repoNames.length > 0;
  if (!hasNames) {
    return (
      <span
        className={`${textScale === 'sidebar' ? 'text-s' : 'text-xs'} fg-secondary/60`}
      >
        {label}
      </span>
    );
  }
  return (
    <RepoTooltipTrigger
      label={label}
      repoNames={repoNames}
      textScale={textScale}
    />
  );
}

/**
 * The multi-repo `<N> repos` sub-label and its list of repository names, on
 * the shared rich hover tooltip: it hangs under the label from its left edge
 * and flips above when there is no room below.
 */
function RepoTooltipTrigger({
  label,
  repoNames,
  textScale,
}: {
  label: string;
  repoNames: string[];
  textScale: 'default' | 'sidebar';
}): JSX.Element {
  const visibleNames = repoNames.slice(0, REPO_TOOLTIP_MAX_NAMES);
  const remaining = repoNames.length - visibleNames.length;

  return (
    <RichHoverTooltip
      placement="below-start"
      placementGap={REPO_TOOLTIP_GAP}
      surfacePadding="relaxed"
      surfaceClassName="min-w-35 max-w-65"
      content={
        <div className="flex flex-col text-xs gap-1">
          <span
            className={`block ${textScale === 'sidebar' ? 'text-xs' : 'text-3xs'} font-normal fg-secondary`}
          >
            Repositories
          </span>
          <ul className="flex flex-col gap-0.5">
            {visibleNames.map((repoName, index) => (
              <li key={`${repoName}-${index}`} className="truncate">
                {repoName}
              </li>
            ))}
            {remaining > 0 && (
              <li className="fg-secondary/80">+ {remaining} more</li>
            )}
          </ul>
        </div>
      }
    >
      <button
        type="button"
        aria-label={`Repositories: ${repoNames.join(', ')}`}
        className={`focus-ring rounded-sm border-0 bg-transparent p-0 ${textScale === 'sidebar' ? 'text-s' : 'text-xs'} fg-secondary/60 underline-offset-2 hover:underline focus:underline`}
      >
        {label}
      </button>
    </RichHoverTooltip>
  );
}
