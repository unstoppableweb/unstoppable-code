import { ControlButton } from '../Button';
import { useId, type JSX, type ReactNode } from 'react';
import type {
  PanelCollapseEdge,
  PanelGroupModel,
  PanelIntentCallbacks,
  PanelTabModel,
} from '../../panels/registry-types';
import { TitlebarIconButton } from '../TitlebarIconButton';
import { Tooltip } from '../Tooltip';
import { REPLAY_MASK_CLASS } from '../../lib/replay-privacy';
import {
  ChevronDownMediumIcon,
  ChevronLeftMediumIcon,
  ChevronRightMediumIcon,
  ChevronTopMediumIcon,
} from '../../icons/AppIcons';
import type { AppIcon } from '../../icons/AppIcons';
import { PanelAddTabButton } from './PanelAddTabButton';
import { PanelAddPanelButton } from './PanelAddPanelButton';
import {
  DEFAULT_PANEL_CHROME_LABELS,
  PanelChrome,
  type PanelChromeLabels,
} from './PanelChrome';
import type { PanelTabBarAddTab } from './PanelTabBar';

export interface PanelCollapsedBarProps {
  group: PanelGroupModel;
  edge: PanelCollapseEdge;
  /** Whether this group is the layout's active (focused) group. */
  isActiveGroup: boolean;
  /**
   * Whether the layout has more than one group; forwarded to the chrome so
   * the overflow menu can disable maximize/close for a lone group.
   */
  hasMultipleGroups: boolean;
  callbacks: PanelIntentCallbacks;
  /** Whether the pop-out affordance may render in the overflow menu. */
  canPopOut?: boolean;
  /** Chrome copy override; defaults to neutral English labels. */
  chrome?: PanelChromeLabels;
  /** Optional add-tab affordance (same seam as the expanded tab bar). */
  addTab?: PanelTabBarAddTab;
  /** Optional per-tab icon renderer (same seam as the tab bar). */
  renderTabIcon?: (tab: PanelTabModel) => ReactNode;
  /** Plain-string title resolver for icon tooltips. */
  getTabTitle?: (tab: PanelTabModel) => string;
  isTabTitlePrivate?: (tab: PanelTabModel) => boolean;
  renderTabAccessibleStatus?: (tab: PanelTabModel) => ReactNode;
  /**
   * Optional per-tab RICH tooltip renderer (same seam as the tab bar). A
   * non-null result replaces the plain-title tooltip on a collapsed tab
   * icon, so collapsed tabs share the same rich tooltip as normal/pinned
   * tabs. Accessible names still come from {@link getTabTitle}.
   */
  renderTabTooltip?: (tab: PanelTabModel) => ReactNode | null;
  /**
   * Same app-supplied accessory slot as the expanded title bar (desktop: the
   * archived-chats control). Rendered in the collapsed bar too so an
   * accessory electing a collapsed owner group — or a fully collapsed layout
   * — never unmounts its global listeners.
   */
  tabStripAccessory?: ReactNode;
}

/**
 * App medium chevrons pointing AWAY from the collapse edge (the expand
 * direction), at the same 16px size every other chevron in the app uses.
 */
const EXPAND_GLYPHS: Record<PanelCollapseEdge, AppIcon> = {
  left: ChevronRightMediumIcon,
  right: ChevronLeftMediumIcon,
  top: ChevronDownMediumIcon,
  bottom: ChevronTopMediumIcon,
};

function FallbackTabGlyph(): JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
    </svg>
  );
}

/**
 * Bar rendered in place of a collapsed group's title/body: a vertical strip
 * for left/right edges, a horizontal bar for top/bottom. It keeps the group's
 * chrome controls in place — the add-tab button, the layout menu, and the
 * expand/collapse toggle — so collapsing never removes an action, plus a
 * strip of tab icons for click-to-expand-to-tab.
 *
 * Control placement mirrors the expanded title bar: on the horizontal bar the
 * tab icons lead and the controls trail (right), ending with the expand
 * toggle; on the vertical strip the controls stack at the top (add, layout
 * menu, toggle) above the tab icons, so the toggle closes the control stack
 * just as the caret closes the expanded cluster. The
 * overflow menu's own actions expand the group as a side effect via the store
 * (split/add/maximize auto-expand; only "Close all" leaves it collapsed).
 */
export function PanelCollapsedBar({
  group,
  edge,
  isActiveGroup,
  hasMultipleGroups,
  callbacks,
  canPopOut,
  chrome,
  addTab,
  renderTabIcon,
  getTabTitle,
  isTabTitlePrivate,
  renderTabAccessibleStatus,
  renderTabTooltip,
  tabStripAccessory,
}: PanelCollapsedBarProps): JSX.Element {
  const statusIdPrefix = useId();
  const orientation =
    edge === 'left' || edge === 'right' ? 'vertical' : 'horizontal';
  const isVertical = orientation === 'vertical';
  // A right-edge strip has room to the LEFT; every other edge reads better
  // with the default top placement (the tooltip clamps to the viewport).
  const tooltipPlacement: 'top' | 'left' = edge === 'right' ? 'left' : 'top';
  const expandLabel = chrome?.expand ?? DEFAULT_PANEL_CHROME_LABELS.expand;

  // Horizontal bar: the expand toggle lives INSIDE the chrome (same trailing
  // slot as the expanded collapse chevron) so the menu/toggle cluster lines up
  // pixel-for-pixel with the expanded title bar. Vertical strip: a standalone
  // toggle closes the control stack, just above the tab icons.
  const expandToggle = isVertical ? (
    // The strip's own tooltip, so a right-edge strip can place it to the
    // left; the button's built-in one is off.
    <Tooltip label={expandLabel} placement={tooltipPlacement}>
      <TitlebarIconButton
        surface="panelChrome"
        icon={EXPAND_GLYPHS[edge]}
        tooltipLabel=""
        data-testid={`panel-group-expand-${group.groupId}`}
        aria-label={expandLabel}
        onClick={(): void => {
          callbacks.onCollapseGroup?.(group.groupId, false);
        }}
      />
    </Tooltip>
  ) : null;

  const addButton =
    addTab !== undefined ? (
      <PanelAddTabButton groupId={group.groupId} addTab={addTab} />
    ) : null;

  // Same Add panel affordance as the expanded title bar: with a direct `+`
  // (New Chat) the add-panel menu lives on its own button, and a collapsed
  // group would otherwise have NO way to receive non-chat panels.
  const addPanelButton = addTab?.addPanel ? (
    <PanelAddPanelButton groupId={group.groupId} addPanel={addTab.addPanel} />
  ) : null;

  const moreMenu = (
    <PanelChrome
      groupId={group.groupId}
      isMaximized={false}
      hasMultipleGroups={hasMultipleGroups}
      callbacks={callbacks}
      labels={chrome}
      canPopOut={canPopOut}
      collapse={null}
      expand={isVertical ? null : { edge }}
      floating
    />
  );

  const tabIcons = (
    <div className="canopy-panel-collapsed-tabs">
      {group.tabs.map((tab) => {
        const title = getTabTitle?.(tab) ?? tab.title;
        const icon = renderTabIcon?.(tab);
        const customTooltip = renderTabTooltip?.(tab) ?? null;
        const mask =
          isTabTitlePrivate?.(tab) === true ? REPLAY_MASK_CLASS : undefined;

        return (
          <Tooltip
            key={tab.panelId}
            label={customTooltip ?? <span className={mask}>{title}</span>}
            placement={tooltipPlacement}
          >
            {/* A private title names the button through a masked label, not
                `aria-label`, which click events copy past the mask. */}
            <span className={mask ? `contents ${mask}` : 'contents'}>
              <ControlButton
                type="button"
                presentation="panel-collapsed-tab"
                data-testid={`panel-collapsed-tab-${tab.panelId}`}
                data-active-tab={
                  tab.panelId === group.activePanelId ? 'true' : 'false'
                }
                {...(mask
                  ? {
                      'aria-labelledby': `${statusIdPrefix}-${tab.panelId}-title`,
                    }
                  : { 'aria-label': title })}
                aria-describedby={
                  renderTabAccessibleStatus
                    ? `${statusIdPrefix}-${tab.panelId}`
                    : undefined
                }
                onClick={(): void => {
                  callbacks.onExpandGroupToTab?.(group.groupId, tab.panelId);
                }}
              >
                {icon ?? <FallbackTabGlyph />}
                {renderTabAccessibleStatus ? (
                  <span
                    className="sr-only"
                    id={`${statusIdPrefix}-${tab.panelId}`}
                  >
                    {renderTabAccessibleStatus(tab)}
                  </span>
                ) : null}
              </ControlButton>
              {mask ? (
                <span
                  className="sr-only"
                  id={`${statusIdPrefix}-${tab.panelId}-title`}
                >
                  {title}
                </span>
              ) : null}
            </span>
          </Tooltip>
        );
      })}
    </div>
  );

  return (
    <div
      className={`canopy-panel-collapsed-bar canopy-panel-collapsed-bar-${orientation}`}
      data-testid={`panel-collapsed-bar-${group.groupId}`}
      data-edge={edge}
      data-active={isActiveGroup ? 'true' : 'false'}
    >
      {orientation === 'vertical' ? (
        <>
          {addButton}
          {addPanelButton}
          {tabStripAccessory}
          {moreMenu}
          {expandToggle}
          {tabIcons}
        </>
      ) : (
        <>
          {tabIcons}
          {addButton}
          {addPanelButton}
          {tabStripAccessory}
          {moreMenu}
        </>
      )}
    </div>
  );
}
