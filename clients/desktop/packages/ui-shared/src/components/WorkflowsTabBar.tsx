import type { JSX } from 'react';
import {
  BulletListIcon,
  PlayCircleIcon,
  ScheduleIcon,
} from '../icons/AppIcons';
import {
  WORKFLOWS_TAB_LABELS,
  WORKFLOWS_TABS,
  type WorkflowsTabId,
} from '../lib/workflows-tabs';
import { TabBar, type TabBarChangeSource, type TabBarItem } from './TabBar';

const TAB_ICONS: Readonly<Record<WorkflowsTabId, JSX.Element>> = {
  workflows: <PlayCircleIcon size="sm" />,
  'workflows-schedule': <ScheduleIcon size="sm" />,
  'workflows-library': <BulletListIcon size="sm" />,
};

/** How the user picked a tab. */
export type WorkflowsTabChangeSource = TabBarChangeSource;

export interface WorkflowsTabBarProps {
  readonly value: WorkflowsTabId;
  readonly onChange: (
    tab: WorkflowsTabId,
    source: WorkflowsTabChangeSource,
  ) => void;
  /**
   * Focus the selected tab when the bar mounts. A host whose panels each
   * render their own bar sets it after a keyboard change, so focus follows
   * the selection into the new panel's bar.
   */
  readonly focusSelectedOnMount?: boolean;
  /**
   * A count beside a tab's label, in the current context. A tab with no
   * entry, or with zero, shows none.
   */
  readonly counts?: Readonly<Partial<Record<WorkflowsTabId, number>>>;
  /**
   * The tabs a host serves, in their usual order; every tab by default. A
   * host with no schedules of its own leaves Schedule out.
   */
  readonly tabs?: readonly WorkflowsTabId[];
  /** Placement only; the tab list owns its own layout. */
  readonly className?: string;
}

/** Element id of a Workflows tab, for the panel's `aria-labelledby`. */
export function workflowsTabElementId(tab: WorkflowsTabId): string {
  return `workflows-tab-${tab}`;
}

/** Element id the host gives the panel the tabs control. */
export const WORKFLOWS_TAB_PANEL_ID = 'workflows-tab-panel';

/**
 * The Workflows page's Runs | Schedule | Library tabs (CAN-3981).
 * Only the selected tab is in the Tab order; the arrow keys, Home and End
 * move between tabs and select the one they land on.
 */
export function WorkflowsTabBar({
  value,
  onChange,
  focusSelectedOnMount = false,
  counts,
  tabs = WORKFLOWS_TABS,
  className,
}: WorkflowsTabBarProps): JSX.Element {
  const items: readonly TabBarItem<WorkflowsTabId>[] = WORKFLOWS_TABS.filter(
    (tab) => tabs.includes(tab),
  ).map((tab) => ({
    id: tab,
    label: WORKFLOWS_TAB_LABELS[tab],
    icon: TAB_ICONS[tab],
    count: counts?.[tab],
    dataTestId: `workflows-tab-${tab}`,
    countTestId: `workflows-tab-count-${tab}`,
    tabId: workflowsTabElementId(tab),
  }));
  return (
    <TabBar
      items={items}
      value={value}
      onChange={onChange}
      label="Workflows"
      panelId={WORKFLOWS_TAB_PANEL_ID}
      focusSelectedOnMount={focusSelectedOnMount}
      dataTestId="workflows-tabs"
      className={className}
    />
  );
}
