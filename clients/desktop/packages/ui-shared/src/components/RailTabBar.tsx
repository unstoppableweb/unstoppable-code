import type { JSX, ReactNode } from 'react';
import { SegmentedControl } from '../primitives/SegmentedControl';

export interface RailTabBarTab<TId extends string> {
  id: TId;
  label: string;
  /** Optional test id applied to the tab button. */
  dataTestId?: string;
}

export interface RailTabBarProps<TId extends string> {
  tabs: readonly RailTabBarTab<TId>[];
  activeTab: TId;
  onTabChange: (tab: TId) => void;
  /** Right-aligned actions rendered after the tab strip. */
  actions?: ReactNode;
  /**
   * When true the row receives the `electron-drag` class so the desktop
   * Electron window can be dragged from the empty space, and tab buttons
   * receive `electron-no-drag` so clicks still work. The web portal must
   * leave this off.
   */
  electronDrag?: boolean;
  /**
   * Enforce ≥44px touch targets on the tab buttons (CAN-1206). Opt-in so the
   * desktop rail header stays pixel-identical; the web portal passes it only
   * for the mobile-drawer variant.
   */
  touchTarget?: boolean;
}

/**
 * Top header row of the activity right rail and the plan panel: the panel's
 * two to four tabs as a `SegmentedControl` with tab semantics, and optional
 * actions at the end. A single tab draws no control.
 */
export function RailTabBar<TId extends string>({
  tabs,
  activeTab,
  onTabChange,
  actions,
  electronDrag = false,
  touchTarget = false,
}: RailTabBarProps<TId>): JSX.Element {
  const rowClass = `${electronDrag ? 'electron-drag ' : ''}flex items-center justify-between border-b px-3 py-1.5`;
  return (
    <div className={rowClass}>
      {tabs.length < 2 ? (
        // One view is not a choice: draw no control, but keep its 28px (44px
        // on touch) so the header keeps its height.
        <span
          aria-hidden="true"
          data-testid="rail-tab-bar-spacer"
          className={`h-7${touchTarget ? ' pointer-coarse:h-11' : ''}`}
        />
      ) : (
        <div className={electronDrag ? 'electron-no-drag' : undefined}>
          <SegmentedControl
            value={activeTab}
            options={tabs.map((tab) => ({
              value: tab.id,
              label: tab.label,
              dataTestId: tab.dataTestId,
            }))}
            onChange={onTabChange}
            label="Panel views"
            semantics="tabs"
            width="content"
            touchTarget={touchTarget}
          />
        </div>
      )}
      {actions != null && (
        <div className="flex items-center gap-1.5">{actions}</div>
      )}
    </div>
  );
}
