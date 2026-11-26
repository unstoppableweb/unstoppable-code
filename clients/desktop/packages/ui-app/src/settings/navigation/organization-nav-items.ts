import {
  BarChart3,
  Boxes,
  ConnectorsIcon,
  CreditCard,
  Database,
  FeedIcon,
  FileText,
  FolderGit2,
  MessagesSquare,
  Network,
  PluginsIcon,
  Settings,
  Shield,
  SkillIcon,
  Users,
} from '@canopy/ui-shared/icons/AppIcons';
import { AI_CREDITS_LABEL } from '@canopy/ui-shared';
import {
  LAPSED_LIVE_TABS,
  organizationSettingsNavTabForRoute,
  type OrganizationSettingsNavTab,
  type OrganizationSettingsSubtab,
} from '@canopy/protocol/settings';
import { parseSettingsPathname } from './settings-path';

export { LAPSED_LIVE_TABS };

export type TeamTab = OrganizationSettingsNavTab;

export interface TeamNavItem {
  readonly key: TeamTab;
  readonly label: string;
  /** One sentence under the page header title. See `docs/ux-writing.md`. */
  readonly description: string;
  readonly icon: typeof FeedIcon;
  readonly href: (orgId: string) => string;
  /** A "New" tag both rails draw after the label, for a recently added page. */
  readonly tag?: 'new';
}

/**
 * Shared by the settings rail, which lists these in this order, and the
 * organization page header, which shows the current item's label and
 * description.
 */
export const TEAM_NAV_ITEMS: readonly TeamNavItem[] = [
  {
    key: 'feed',
    label: 'Timeline',
    description: 'Recent work from everyone in this organization.',
    icon: FeedIcon,
    href: (id) => `/organization/${id}`,
  },
  {
    key: 'statistics',
    label: 'Statistics',
    description: 'Usage, savings and impact across this organization.',
    icon: BarChart3,
    href: (id) => `/organization/${id}/statistics`,
  },
  {
    key: 'digests',
    label: 'Digests',
    description: "Regular summaries of this organization's work.",
    icon: FileText,
    href: (id) => `/organization/${id}/digests`,
  },
  {
    key: 'members',
    label: 'Members',
    description: 'The people in this organization and their roles.',
    icon: Users,
    href: (id) => `/organization/${id}/members`,
  },
  {
    key: 'groups',
    label: 'Teams',
    description: 'Groups of members inside this organization.',
    icon: Boxes,
    href: (id) => `/organization/${id}/teams`,
  },
  {
    key: 'projects',
    label: 'Projects',
    description: 'Projects in this organization and who can use them.',
    icon: FolderGit2,
    href: (id) => `/organization/${id}/projects`,
  },
  {
    key: 'memory',
    label: 'Memory',
    description: "Facts agents have learned from this organization's work.",
    icon: Database,
    href: (id) => `/organization/${id}/memory`,
  },
  {
    // Owners only; the server decides who gets it (`transcriptsEnabled`).
    key: 'transcripts',
    label: 'Transcripts',
    description:
      'Chat transcripts members share with this organization. Only owners can see this page.',
    icon: MessagesSquare,
    href: (id) => `/organization/${id}/transcripts`,
    tag: 'new',
  },
  {
    key: 'settings',
    label: 'Settings',
    description:
      'Control how this organization is set up, governed and billed.',
    icon: Settings,
    href: (id) => `/organization/${id}/settings`,
  },
];

/** The item for a tab; the page header reads its label and description. */
export function teamNavItem(tab: TeamTab): TeamNavItem {
  const item = TEAM_NAV_ITEMS.find((candidate) => candidate.key === tab);
  if (!item) throw new Error(`Unknown organization nav item: ${tab}`);
  return item;
}

/**
 * The tab a route belongs to within ONE organization. `null` for any other
 * organization's routes, routes outside `/organization/<orgId>`, and unknown
 * sub-routes, so a caller never marks an unrelated tab current. Timeline
 * permalinks light Timeline, member details and their digests light Members,
 * Memory views and facts light Memory, and invoice details light Settings.
 */
export function matchTeamNavTab(
  pathname: string | null | undefined,
  orgId: string,
): TeamTab | null {
  return organizationSettingsNavTabForRoute(
    parseSettingsPathname(pathname),
    orgId,
  );
}

export interface OrganizationSettingsSubtabItem {
  readonly key: OrganizationSettingsSubtab;
  readonly label: string;
  /** One sentence under the page header title. See `docs/ux-writing.md`. */
  readonly description: string;
  readonly icon: typeof FeedIcon;
}

/**
 * The organization's Settings pages. Each is its own settings rail row and
 * names its page header; the order is the rail's (identity first, then the
 * rules the organization sets for members, its connections, and the
 * commercial pages last, side by side).
 */
export const ORGANIZATION_SETTINGS_SUBTAB_ITEMS: readonly OrganizationSettingsSubtabItem[] =
  [
    {
      key: 'general',
      label: 'General',
      description: "The organization's name, logo and work digests.",
      icon: Settings,
    },
    {
      key: 'policies',
      label: 'Policies',
      description:
        'What members share, and which models and agents they can use.',
      icon: Shield,
    },
    {
      key: 'project-defaults',
      label: 'Project defaults',
      description: 'What every project in this organization gets by default.',
      icon: SkillIcon,
    },
    {
      key: 'connectors',
      label: 'Connectors',
      description: 'Tools the organization holds and shares with its projects.',
      icon: ConnectorsIcon,
    },
    {
      key: 'integrations',
      label: 'Integrations',
      description:
        'Accounts the organization connects for everyone, such as GitHub.',
      icon: PluginsIcon,
    },
    {
      key: 'usage',
      label: 'Usage',
      description:
        'Who can see statistics, and what your AI provider plans cost.',
      icon: BarChart3,
    },
    {
      key: 'ai-gateway',
      label: 'AI gateway',
      description: 'Give members models from your gateway.',
      icon: Network,
    },
    {
      key: 'billing',
      // Keeps its `billing` key and `?tab=billing` URL, so existing deep links
      // still land.
      label: AI_CREDITS_LABEL,
      description: 'The AI Credits pool, payment method and past payments.',
      icon: CreditCard,
    },
  ];

/** The item for a Settings page. */
export function organizationSettingsSubtabItem(
  key: OrganizationSettingsSubtab,
): OrganizationSettingsSubtabItem {
  const item = ORGANIZATION_SETTINGS_SUBTAB_ITEMS.find(
    (candidate) => candidate.key === key,
  );
  if (!item) throw new Error(`Unknown organization settings page: ${key}`);
  return item;
}

/** Where a Settings page lives; General keeps the bare Settings URL. */
export function organizationSettingsSubtabHref(
  orgId: string,
  key: OrganizationSettingsSubtab,
): string {
  const base = `/organization/${orgId}/settings`;
  return key === 'general' ? base : `${base}?tab=${key}`;
}

/**
 * The Settings page a request shows: the requested one when the viewer gets
 * it, otherwise the first one they get. A stale or hidden `?tab=` falls back
 * rather than 404ing. `null` when the viewer gets none.
 */
export function resolveOrganizationSettingsSubtab(
  requested: OrganizationSettingsSubtab | null,
  visible: readonly OrganizationSettingsSubtab[],
): OrganizationSettingsSubtab | null {
  if (requested !== null && visible.includes(requested)) return requested;
  return visible[0] ?? null;
}
