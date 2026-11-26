import type { ComponentType } from 'react';
import type {
  OrganizationSettingsNavModel,
  OrganizationSettingsNavTab,
  OrganizationSettingsSubtab,
  SettingsNavModel,
} from '@canopy/protocol/settings';
import {
  matchAccountNavKey,
  visibleAccountNavItems,
} from './account-nav-items';
import {
  organizationSettingsSubtabHref,
  organizationSettingsSubtabItem,
  teamNavItem,
} from './organization-nav-items';
import { parseSettingsPathname, pathSegments } from './settings-path';

export type SettingsNavIcon = ComponentType<{ size?: number }>;

/**
 * The shared groups. The rail shows one scope at a time: the viewer's
 * account, or the organization being browsed with its activity pages below.
 * Hosts may append their own groups (web adds Admin; desktop renders its
 * local settings groups below these).
 */
export type SettingsNavGroupId =
  | 'account'
  | 'organization'
  | 'organization-activity';

export interface SettingsNavRow {
  /** Stable, group-prefixed identity, e.g. `account-security`. */
  readonly key: string;
  readonly label: string;
  readonly icon: SettingsNavIcon;
  /** Where the row links. */
  readonly href: string;
  /** Blocked rows are shown but inert. Takes precedence over `attention`. */
  readonly disabled: boolean;
  /** Billing needs the viewer's action. */
  readonly attention: boolean;
  /** A "New" tag after the label. */
  readonly tag?: 'new';
}

export interface SettingsNavGroup<Id extends string = SettingsNavGroupId> {
  readonly id: Id;
  /**
   * The visible group heading. `null` for the scope's own rows, which sit
   * directly under the scope picker that names them.
   */
  readonly label: string | null;
  /** The group's accessible name, visible heading or not. */
  readonly ariaLabel: string;
  readonly rows: readonly SettingsNavRow[];
}

/** The Settings page row prefix; the page is the rest of the key. */
const SETTINGS_SUBTAB_ROW_PREFIX = 'organization-settings-';

/**
 * Organization rows in rail order: its pages, with the Settings pages split
 * around them so identity (General) leads and the commercial pages close.
 */
const ORGANIZATION_ROW_ORDER: readonly (
  | { readonly tab: OrganizationSettingsNavTab }
  | { readonly subtab: OrganizationSettingsSubtab }
)[] = [
  { subtab: 'general' },
  { tab: 'members' },
  { tab: 'groups' },
  { tab: 'projects' },
  { tab: 'memory' },
  { tab: 'transcripts' },
  { subtab: 'policies' },
  { subtab: 'project-defaults' },
  { subtab: 'connectors' },
  { subtab: 'integrations' },
  { subtab: 'usage' },
  { subtab: 'ai-gateway' },
  { subtab: 'billing' },
];

/** Pages about the organization's work rather than its setup. */
const ORGANIZATION_ACTIVITY_TABS: readonly OrganizationSettingsNavTab[] = [
  'feed',
  'statistics',
  'digests',
];

function organizationTabRow(
  organization: OrganizationSettingsNavModel,
  tab: OrganizationSettingsNavTab,
): SettingsNavRow {
  const item = teamNavItem(tab);
  return {
    key: `organization-${tab}`,
    label: item.label,
    icon: item.icon,
    href: item.href(organization.id),
    disabled: organization.disabledTabs.includes(tab),
    attention: false,
    ...(item.tag === undefined ? {} : { tag: item.tag }),
  };
}

function organizationGroups(
  organization: OrganizationSettingsNavModel,
): SettingsNavGroup[] {
  const visible = new Set(organization.visibleTabs);
  const subtabs = visible.has('settings') ? organization.settingsSubtabs : [];
  const settingsDisabled = organization.disabledTabs.includes('settings');
  const rows: SettingsNavRow[] = [];
  for (const entry of ORGANIZATION_ROW_ORDER) {
    if ('tab' in entry) {
      if (visible.has(entry.tab))
        rows.push(organizationTabRow(organization, entry.tab));
      continue;
    }
    if (subtabs === undefined || !subtabs.includes(entry.subtab)) continue;
    const item = organizationSettingsSubtabItem(entry.subtab);
    const attention =
      !settingsDisabled &&
      entry.subtab === 'billing' &&
      organization.billingNeedsAttention;
    rows.push({
      key: `${SETTINGS_SUBTAB_ROW_PREFIX}${entry.subtab}`,
      label: item.label,
      icon: item.icon,
      href: organizationSettingsSubtabHref(organization.id, entry.subtab),
      disabled: settingsDisabled,
      attention,
    });
  }
  // A host that has not resolved the Settings pages yet keeps one row.
  if (subtabs === undefined && visible.has('settings'))
    rows.push({
      ...organizationTabRow(organization, 'settings'),
      attention: !settingsDisabled && organization.billingNeedsAttention,
    });

  const activity = ORGANIZATION_ACTIVITY_TABS.filter((tab) =>
    visible.has(tab),
  ).map((tab) => organizationTabRow(organization, tab));

  const groups: SettingsNavGroup[] = [];
  if (rows.length > 0)
    groups.push({
      id: 'organization',
      label: null,
      ariaLabel: organization.name,
      rows,
    });
  if (activity.length > 0)
    groups.push({
      id: 'organization-activity',
      // The Personal organization has only its activity, so it needs no
      // second heading under the picker.
      label: rows.length > 0 ? 'Activity' : null,
      ariaLabel: rows.length > 0 ? 'Activity' : organization.name,
      rows: activity,
    });
  return groups;
}

/**
 * The settings rail's shared groups for the current scope: the account's
 * pages, or the browsed organization's (its setup pages, then its
 * activity). Visibility follows each destination's own page guard; it is
 * display policy, never an authorization boundary. `model.adminVisible` is
 * read by hosts that append Admin.
 */
export function buildSettingsNavGroups(
  model: SettingsNavModel,
): readonly SettingsNavGroup[] {
  if (model.organization !== null)
    return organizationGroups(model.organization);
  return [
    {
      id: 'account',
      label: null,
      ariaLabel: 'Account',
      rows: visibleAccountNavItems(model.account).map((item) => ({
        key: `account-${item.key}`,
        label: item.label,
        icon: item.icon,
        href: item.href,
        disabled: false,
        attention: false,
      })),
    },
  ];
}

/**
 * The logical row a pathname (optionally carrying its query) belongs to
 * among the shared groups, before checking that the row is visible. Hosts
 * with extra groups resolve their own paths first and fall back to this.
 */
export function settingsNavLogicalRowKey(
  pathname: string | null | undefined,
  organizationId: string | null,
): string | null {
  const [root, second] = pathSegments(pathname);
  if (root === 'account') {
    const key = matchAccountNavKey(pathname);
    return key === null ? null : `account-${key}`;
  }
  if (root === 'organization') {
    if (second === undefined || organizationId === null) return null;
    const route = parseSettingsPathname(pathname);
    if (
      route?.scope === 'organization' &&
      route.organizationId === organizationId &&
      route.page === 'settings'
    )
      return `${SETTINGS_SUBTAB_ROW_PREFIX}${route.subtab ?? 'general'}`;
    return route?.scope === 'organization' &&
      route.organizationId === organizationId
      ? `organization-${route.page}`
      : null;
  }
  return null;
}

/**
 * The one row current for a route, or `null`. A hidden, unknown, or
 * foreign-organization destination selects nothing rather than falling back
 * to a root row. A Settings page the viewer does not get shows the first one
 * they do (the page falls back the same way), so that row is selected.
 */
export function selectSettingsNavRow(
  groups: readonly SettingsNavGroup<string>[],
  pathname: string | null | undefined,
  organizationId: string | null,
  logicalKey: (
    pathname: string | null | undefined,
    organizationId: string | null,
  ) => string | null = settingsNavLogicalRowKey,
): string | null {
  const key = logicalKey(pathname, organizationId);
  if (key === null) return null;
  const rows = groups.flatMap((group) => group.rows);
  if (rows.some((row) => row.key === key)) return key;
  if (!key.startsWith(SETTINGS_SUBTAB_ROW_PREFIX)) return null;
  return (
    rows.find((row) => row.key.startsWith(SETTINGS_SUBTAB_ROW_PREFIX))?.key ??
    rows.find((row) => row.key === 'organization-settings')?.key ??
    null
  );
}
