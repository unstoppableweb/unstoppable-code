import type { JSX } from 'react';
import {
  CUSTOMIZE_LABEL,
  ORCHESTRATOR_LABEL,
  REMOTE_CONTROL_LABEL,
} from '@canopy/protocol';
import type { SidebarNavItemKey } from '@canopy/protocol/sidebar';
import {
  AppAdvisorIcon,
  BarChart4BarsIcon,
  CustomizeIcon,
  FeedIcon,
  HistoryIcon,
  KanbanIcon,
  LayoutDashboardIcon,
  RemoteControlIcon,
  WorkflowsIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { ClaudeLogo } from '@canopy/ui-shared/icons';

/**
 * Re-exported so hosts get the key union from one import alongside the
 * registry. Deriving it locally from `SIDEBAR_NAV_ITEM_KEYS` would collapse to
 * `string` — that export is deliberately widened for untrusted persisted
 * layouts — and silently drop the exhaustiveness `Record<SidebarNavItemKey,
 * SidebarNavItemDef>` below is there to enforce.
 */
export type { SidebarNavItemKey };

/**
 * Desktop's sidebar row icon size, which the shared sidebar now matches (web
 * chat parity, slice 6). Hosts may still pass their own size rather than the
 * registry baking one in.
 */
const DEFAULT_NAV_ICON_SIZE = 16;

export interface SidebarNavItemDef {
  readonly key: SidebarNavItemKey;
  readonly label: string;
  readonly icon: JSX.Element;
}

/**
 * Label + icon per canonical nav key, shared by the desktop sidebar and the
 * web portal sidebar so the two render one vocabulary rather than two
 * hand-maintained lists.
 *
 * Presentation-only: ordering comes from the `SidebarNavLayout` model in
 * `@canopy/protocol/sidebar`, and activation, active-page state, and
 * availability are resolved by each host at render time.
 */
export function getSidebarNavItemDefs(
  iconSize: number = DEFAULT_NAV_ICON_SIZE,
): Record<SidebarNavItemKey, SidebarNavItemDef> {
  return {
    'app-advisor': {
      key: 'app-advisor',
      label: ORCHESTRATOR_LABEL,
      icon: <AppAdvisorIcon size={iconSize} />,
    },
    // One row for the Automations, Pipelines and Watchers panels (CAN-3980).
    workflows: {
      key: 'workflows',
      label: 'Workflows',
      icon: <WorkflowsIcon size={iconSize} />,
    },
    plugins: {
      key: 'plugins',
      label: CUSTOMIZE_LABEL,
      icon: <CustomizeIcon size={iconSize} />,
    },
    feed: {
      key: 'feed',
      label: 'Feed',
      icon: <FeedIcon size={iconSize} />,
    },
    overview: {
      key: 'overview',
      label: 'Overview',
      icon: <LayoutDashboardIcon size={iconSize} />,
    },
    kanban: {
      key: 'kanban',
      label: 'Kanban',
      icon: <KanbanIcon size={iconSize} />,
    },
    statistics: {
      key: 'statistics',
      label: 'Statistics',
      icon: <BarChart4BarsIcon size={iconSize} aria-hidden="true" />,
    },
    'remote-control': {
      key: 'remote-control',
      label: REMOTE_CONTROL_LABEL,
      icon: <RemoteControlIcon size={iconSize} />,
    },
    audit: {
      key: 'audit',
      label: 'Audit trail',
      icon: <HistoryIcon size={iconSize} />,
    },
    workers: {
      key: 'workers',
      label: 'Claude workers',
      icon: (
        <ClaudeLogo width={iconSize} height={iconSize} aria-hidden="true" />
      ),
    },
  };
}
