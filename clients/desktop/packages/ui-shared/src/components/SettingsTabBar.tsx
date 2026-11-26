import type { JSX, ReactNode } from 'react';
import { TabBar, type TabBarItem } from '../primitives/TabBar';

export interface SettingsTab<T extends string> {
  id: T;
  label: string;
  icon?: ReactNode;
  danger?: boolean;
}

export interface SettingsTabBarProps<T extends string> {
  tabs: ReadonlyArray<SettingsTab<T>>;
  activeTab: T;
  onChange: (next: T) => void;
}

/**
 * Tab bar header used by `ProjectSettingsModal` and `WorkspaceSettingsModal`:
 * the shared `TabBar` at dialog density. Generic over the tab id type so each
 * modal keeps its own union literal (e.g. `'details' | 'scripts' | ...`).
 */
export function SettingsTabBar<T extends string>({
  tabs,
  activeTab,
  onChange,
}: SettingsTabBarProps<T>): JSX.Element {
  const items: readonly TabBarItem<T>[] = tabs.map((tab) => ({
    id: tab.id,
    label: tab.label,
    icon: tab.icon,
    tone: tab.danger === true ? 'destructive' : 'default',
  }));
  return (
    <TabBar
      items={items}
      value={activeTab}
      onChange={(next): void => onChange(next)}
      label="Settings sections"
      density="compact"
      scrollable
      inset="dialog"
    />
  );
}
