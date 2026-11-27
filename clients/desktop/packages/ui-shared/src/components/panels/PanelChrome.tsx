import {
  memo,
  useId,
  useRef,
  useState,
  type JSX,
  type NamedExoticComponent,
} from 'react';
import {
  ActionMenuItems,
  ActionMenuRowStyle,
  type ActionMenuItem,
} from '../../primitives/ActionMenuItems';
import { Menu } from '../../primitives/Menu';
import {
  ChevronDownMediumIcon,
  ChevronLeftMediumIcon,
  ChevronRightMediumIcon,
  ChevronTopMediumIcon,
  CloseIcon,
  MaximizeIcon,
  RestoreIcon,
} from '../../icons/AppIcons';
import { TitlebarIconButton } from '../TitlebarIconButton';
import {
  PanelCloseIcon,
  PanelFullScreenIcon,
  PanelNewWindowIcon,
  PanelSplitDirectionIcon,
} from '../../icons/PanelMenuIcons';
import { PanelLayoutIcon, type AppIcon } from '../../icons/AppIcons';
import type {
  PanelCollapseEdge,
  PanelIntentCallbacks,
  PanelSplitDirection,
} from '../../panels/registry-types';
import type { PanelTabStyle } from './PanelTabBar';

/**
 * All user-visible copy for the group chrome, injected via props because the
 * shared package cannot import the brand runtime. Apps that need branded or
 * localized copy pass their own labels; {@link DEFAULT_PANEL_CHROME_LABELS}
 * provides neutral English defaults.
 */
export interface PanelChromeLabels {
  /** Maximize ("Full screen") menu item label. */
  maximize: string;
  /** Restore direct-button label, shown only while maximized. */
  restore: string;
  /** Overflow ("…") menu trigger label. */
  more: string;
  /** Close-group menu item label (closes every tab in the group). */
  close: string;
  /** Split submenu section label. */
  split: string;
  splitUp: string;
  splitDown: string;
  splitLeft: string;
  splitRight: string;
  /** Pop-out menu item label; only used when the item renders. */
  popOut?: string;
  /** Why `popOut` is unavailable (the layout has a single group). */
  popOutBlocked?: string;
  /** Direct collapse-button label/tooltip, shown when the affordance is enabled. */
  collapse: string;
  /** Collapse-button tooltip shown when the affordance is blocked. */
  collapseBlocked: string;
  /** Direct expand-button label/tooltip, shown while the group is collapsed. */
  expand: string;
  /** Empty-group placeholder copy (group with zero tabs). */
  emptyGroup?: string;
  /** Empty-group placeholder close-group button label. */
  closeGroup?: string;
}

const DEFAULT_POP_OUT_LABEL = 'New window';

/** Neutral English defaults for {@link PanelChromeLabels}. */
export const DEFAULT_PANEL_CHROME_LABELS: PanelChromeLabels = {
  maximize: 'Full screen',
  restore: 'Exit full screen',
  more: 'More group actions',
  close: 'Close all',
  split: 'Split group',
  splitUp: 'Split up',
  splitDown: 'Split down',
  splitLeft: 'Split left',
  splitRight: 'Split right',
  popOut: DEFAULT_POP_OUT_LABEL,
  popOutBlocked: 'Split the layout first — the last group cannot pop out',
  collapse: 'Collapse',
  collapseBlocked:
    'Expand another panel first. At least one panel must stay expanded.',
  expand: 'Expand',
  emptyGroup: 'No panels in this group',
  closeGroup: 'Close group',
};

export interface PanelChromeProps {
  groupId: string;
  /** Whether this group is currently maximized (drives `aria-pressed`). */
  isMaximized: boolean;
  /**
   * Whether the layout has more than one group. Closing the last root group
   * and maximizing a lone group are both disabled (the grid engine always
   * holds at least one view, and maximize requires >= 2 views).
   */
  hasMultipleGroups: boolean;
  callbacks: PanelIntentCallbacks;
  /** @defaultValue {@link DEFAULT_PANEL_CHROME_LABELS} */
  labels?: PanelChromeLabels;
  /**
   * Whether the pop-out affordance should render. The button also requires
   * `callbacks.onPopOutGroup` to be present (optional until Phase 9).
   */
  canPopOut?: boolean;
  /**
   * Collapse affordance for this group, or `null`/absent to render no
   * collapse control (inner panel, collapsed already, or maximized).
   */
  collapse?: {
    edge: PanelCollapseEdge;
    blocked: boolean;
    branch?: boolean;
  } | null;
  /**
   * When set (and not maximized), renders the EXPAND toggle in the SAME
   * trailing slot (after the layout menu) the collapse chevron occupies when
   * expanded, so a collapsed group's toggle lines up pixel-for-pixel with the
   * expanded chrome. Used by the collapsed bar (horizontal orientation).
   * Mutually exclusive with {@link collapse}.
   */
  expand?: { edge: PanelCollapseEdge } | null;
  /** @deprecated Menus always use the shared owner-document floating layer. */
  floating?: boolean;
  /** Fixed-layout presentation: direct Full screen/Exit full screen and Hide buttons. */
  minimal?: { hideLabel: string };
  /**
   * The group's tab style. Both tab styles use the shared Lucide glyphs.
   * @defaultValue 'classic'
   */
  tabStyle?: PanelTabStyle;
}

const SPLIT_DIRECTIONS: readonly PanelSplitDirection[] = [
  'up',
  'down',
  'left',
  'right',
];

function splitDirectionLabel(
  labels: PanelChromeLabels,
  direction: PanelSplitDirection,
): string {
  switch (direction) {
    case 'up':
      return labels.splitUp;
    case 'down':
      return labels.splitDown;
    case 'left':
      return labels.splitLeft;
    case 'right':
      return labels.splitRight;
  }
}

/**
 * Directional chevrons come from the app icon set, the same glyphs every
 * other chevron in the app uses, rather than hand-rolled paths.
 */
/** Pointing AT the collapse edge (collapse direction). */
const COLLAPSE_ICONS: Record<PanelCollapseEdge, AppIcon> = {
  left: ChevronLeftMediumIcon,
  right: ChevronRightMediumIcon,
  top: ChevronTopMediumIcon,
  bottom: ChevronDownMediumIcon,
};

/** Pointing AWAY from the collapse edge (expand direction). */
const EXPAND_ICONS: Record<PanelCollapseEdge, AppIcon> = {
  left: ChevronRightMediumIcon,
  right: ChevronLeftMediumIcon,
  top: ChevronDownMediumIcon,
  bottom: ChevronTopMediumIcon,
};

interface ChromeIcons {
  maximize: AppIcon;
  restore: AppIcon;
  hide: AppIcon;
  /** Size of the maximize/restore arrows. */
  arrowSize: number;
}

const CHROME_ICONS: ChromeIcons = {
  maximize: MaximizeIcon,
  restore: RestoreIcon,
  hide: CloseIcon,
  arrowSize: 14,
};

/**
 * Group chrome: a direct restore button (while maximized), then the layout
 * menu holding the split directions, optional pop-out, full screen, and
 * close-all, then the collapse/expand caret as the trailing control.
 * Display-only; every gesture routes through {@link PanelIntentCallbacks}.
 */
function PanelChromeComponent({
  groupId,
  isMaximized,
  hasMultipleGroups,
  callbacks,
  labels,
  canPopOut,
  collapse,
  expand,
  minimal,
}: PanelChromeProps): JSX.Element {
  const resolvedLabels = labels ?? DEFAULT_PANEL_CHROME_LABELS;
  const icons = CHROME_ICONS;
  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();

  const popOutLabel = resolvedLabels.popOut ?? DEFAULT_POP_OUT_LABEL;
  const showPopOut =
    (canPopOut ?? false) && callbacks.onPopOutGroup !== undefined;

  // Middle menu section: New window + Full screen. Either may be absent (a
  // non-poppable group, or an already-maximized group).
  const showMaximize = !isMaximized;

  if (minimal !== undefined) {
    return (
      <div className="canopy-panel-chrome">
        <TitlebarIconButton
          surface="panelChrome"
          data-testid={
            isMaximized
              ? `panel-group-restore-${groupId}`
              : `panel-group-maximize-${groupId}`
          }
          icon={isMaximized ? icons.restore : icons.maximize}
          iconSize={icons.arrowSize}
          aria-label={
            isMaximized ? resolvedLabels.restore : resolvedLabels.maximize
          }
          title={isMaximized ? resolvedLabels.restore : resolvedLabels.maximize}
          disabled={!hasMultipleGroups}
          onClick={(): void => {
            callbacks.onMaximizeGroup(groupId, !isMaximized);
          }}
        />
        <TitlebarIconButton
          surface="panelChrome"
          data-testid={`panel-group-hide-${groupId}`}
          icon={icons.hide}
          aria-label={minimal.hideLabel}
          title={minimal.hideLabel}
          disabled={callbacks.onCollapseGroup === undefined}
          onClick={(): void => {
            if (isMaximized) callbacks.onMaximizeGroup(groupId, false);
            callbacks.onCollapseGroup?.(groupId, true);
          }}
        />
      </div>
    );
  }

  // Splits, then New window + Full screen, then Close all as the last group,
  // where the app's action menus keep their removal rows.
  const menuItems: ActionMenuItem[] = [
    ...SPLIT_DIRECTIONS.map(
      (direction): ActionMenuItem => ({
        key: `split-${direction}`,
        label: splitDirectionLabel(resolvedLabels, direction),
        icon: <PanelSplitDirectionIcon direction={direction} />,
        testId: `panel-group-split-${groupId}-${direction}`,
        onSelect: (): void => {
          callbacks.onSplitGroup(groupId, direction);
        },
      }),
    ),
    ...(showPopOut
      ? [
          {
            key: 'pop-out',
            label: popOutLabel,
            icon: <PanelNewWindowIcon />,
            separatorBefore: true,
            testId: `panel-group-pop-out-${groupId}`,
            // Popping out the ONLY group would empty the main grid, which the
            // layout engine refuses — so the row must read as unavailable
            // instead of silently doing nothing (same gate as Full screen).
            disabled: !hasMultipleGroups,
            tooltip: hasMultipleGroups
              ? undefined
              : resolvedLabels.popOutBlocked,
            onSelect: (): void => {
              callbacks.onPopOutGroup?.(groupId);
            },
          },
        ]
      : []),
    ...(showMaximize
      ? [
          {
            key: 'maximize',
            label: resolvedLabels.maximize,
            icon: <PanelFullScreenIcon />,
            separatorBefore: !showPopOut,
            testId: `panel-group-maximize-${groupId}`,
            disabled: !hasMultipleGroups,
            onSelect: (): void => {
              callbacks.onMaximizeGroup(groupId, true);
            },
          },
        ]
      : []),
    {
      key: 'close',
      label: resolvedLabels.close,
      icon: <PanelCloseIcon />,
      separatorBefore: true,
      testId: `panel-group-close-${groupId}`,
      disabled: !hasMultipleGroups,
      onSelect: (): void => {
        callbacks.onCloseGroup(groupId);
      },
    },
  ];

  const menuBody = (
    <Menu
      id={menuId}
      open={menuOpen}
      onOpenChange={setMenuOpen}
      anchorRef={triggerRef}
      placement="bottom-right"
      aria-label={resolvedLabels.more}
      data-testid={`panel-group-actions-menu-${groupId}`}
      className="w-max min-w-30 max-w-[calc(100vw-16px)]"
    >
      <ActionMenuRowStyle>
        <ActionMenuItems
          items={menuItems}
          onSelect={(item): void => {
            if (item.disabled || !item.onSelect) return;
            item.onSelect();
            setMenuOpen(false);
            // Hand focus back to the trigger, as a Menu pick does.
            triggerRef.current?.focus({ preventScroll: true });
          }}
        />
      </ActionMenuRowStyle>
    </Menu>
  );

  return (
    <div className="canopy-panel-chrome">
      {isMaximized ? (
        <TitlebarIconButton
          surface="panelChrome"
          data-testid={`panel-group-restore-${groupId}`}
          icon={icons.restore}
          iconSize={icons.arrowSize}
          aria-label={resolvedLabels.restore}
          title={resolvedLabels.restore}
          onClick={(): void => {
            callbacks.onMaximizeGroup(groupId, false);
          }}
        />
      ) : null}
      <div className="canopy-panel-chrome-menu-root">
        <TitlebarIconButton
          ref={triggerRef}
          surface="panelChrome"
          data-testid={`panel-group-menu-${groupId}`}
          // Layout, not generic overflow: this menu is the four split
          // directions plus window placement, so it takes the canvas-grid
          // glyph rather than the "…" every other overflow trigger uses.
          icon={PanelLayoutIcon}
          aria-label={resolvedLabels.more}
          title={resolvedLabels.more}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? menuId : undefined}
          onClick={(): void => {
            setMenuOpen((open) => !open);
          }}
        />
        {menuBody}
      </div>
      {/* The collapse/expand caret is always the trailing control. */}
      {collapse !== null &&
      collapse !== undefined &&
      callbacks.onCollapseGroup !== undefined ? (
        <TitlebarIconButton
          surface="panelChrome"
          data-testid={`panel-group-collapse-${groupId}`}
          icon={COLLAPSE_ICONS[collapse.edge]}
          aria-label={
            collapse.branch
              ? collapse.edge === 'left' || collapse.edge === 'right'
                ? 'Collapse column'
                : 'Collapse row'
              : resolvedLabels.collapse
          }
          title={
            collapse.blocked
              ? resolvedLabels.collapseBlocked
              : collapse.branch
                ? collapse.edge === 'left' || collapse.edge === 'right'
                  ? 'Collapse column'
                  : 'Collapse row'
                : resolvedLabels.collapse
          }
          disabled={collapse.blocked}
          onClick={(): void => {
            callbacks.onCollapseGroup?.(groupId, true);
          }}
        />
      ) : expand !== null &&
        expand !== undefined &&
        callbacks.onCollapseGroup !== undefined ? (
        <TitlebarIconButton
          surface="panelChrome"
          data-testid={`panel-group-expand-${groupId}`}
          icon={EXPAND_ICONS[expand.edge]}
          aria-label={resolvedLabels.expand}
          title={resolvedLabels.expand}
          onClick={(): void => {
            callbacks.onCollapseGroup?.(groupId, false);
          }}
        />
      ) : null}
    </div>
  );
}

export const PanelChrome: NamedExoticComponent<PanelChromeProps> =
  memo(PanelChromeComponent);
