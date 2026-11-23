'use client';

import type { SettingsPageDataKind } from '@canopy/protocol/settings';
import type { SettingsPageProps } from './page-props';
// `React.lazy`'s signature, plus loading ahead of a visit. Imported as `lazy`
// so every entry keeps the `lazy(() => import(…))` form the settings parity
// check reads.
import {
  preloadablePage as lazy,
  type PreloadablePage,
} from './preloadable-page';

/**
 * One lazy chunk per hosted settings page, keyed by page-data kind. Hosts
 * without server rendering (desktop) resolve a route's page through this
 * table; web route files import the same page modules directly.
 *
 * Every module listed here is a narrow entry: importing it never pulls in
 * payment editors, Stripe, or other pages. Each entry can also load its
 * chunk ahead of a visit (`preloadSettingsPage`).
 */
type PageComponent<K extends SettingsPageDataKind> = PreloadablePage<
  SettingsPageProps<K>
>;

export type HostedSettingsPageRegistry = {
  readonly [K in SettingsPageDataKind]: PageComponent<K>;
};

export const HOSTED_SETTINGS_PAGES: HostedSettingsPageRegistry = {
  'account.account': lazy(() =>
    import('../account/AccountPage').then((m) => ({ default: m.AccountPage })),
  ),
  'account.profile': lazy(() =>
    import('../account/PublicProfilePage').then((m) => ({
      default: m.PublicProfilePage,
    })),
  ),
  'account.digests': lazy(() =>
    import('../digests/AccountDigestsPage').then((m) => ({
      default: m.AccountDigestsPage,
    })),
  ),
  'account.digest': lazy(() =>
    import('../digests/AccountDigestPage').then((m) => ({
      default: m.AccountDigestPage,
    })),
  ),
  'account.notifications': lazy(() =>
    import('../account/NotificationsPage').then((m) => ({
      default: m.NotificationsPage,
    })),
  ),
  'account.plugins': lazy(() =>
    import('../customize/PluginsPage').then((m) => ({
      default: m.PluginsPage,
    })),
  ),
  'account.mcp': lazy(() =>
    import('../customize/McpPage').then((m) => ({
      default: m.McpPage,
    })),
  ),
  'account.delegation': lazy(() =>
    import('../delegation/DelegationPage').then((m) => ({
      default: m.DelegationPage,
    })),
  ),
  'account.labs': lazy(() =>
    import('../labs/LabsPage').then((m) => ({
      default: m.LabsPage,
    })),
  ),
  'account.appearance': lazy(() =>
    import('../appearance/AppearancePage').then((m) => ({
      default: m.AppearancePage,
    })),
  ),
  'account.integrations': lazy(() =>
    import('../github/AccountIntegrationsPage').then((m) => ({
      default: m.AccountIntegrationsPage,
    })),
  ),
  'account.security': lazy(() =>
    import('../account/SecurityPage').then((m) => ({
      default: m.SecurityPage,
    })),
  ),
  'account.model-providers': lazy(() =>
    import('../model-providers/AccountModelProvidersPage').then((m) => ({
      default: m.AccountModelProvidersPage,
    })),
  ),
  'account.ai-gateway': lazy(() =>
    import('../ai-gateway/AccountAiGatewayPage').then((m) => ({
      default: m.AccountAiGatewayPage,
    })),
  ),
  'account.billing': lazy(() =>
    import('../billing/AccountBillingPage').then((m) => ({
      default: m.AccountBillingPage,
    })),
  ),
  'account.invoice': lazy(() =>
    import('../billing/AccountInvoicePage').then((m) => ({
      default: m.AccountInvoicePage,
    })),
  ),
  'organization.list': lazy(() =>
    import('../organization/OrganizationListPage').then((m) => ({
      default: m.OrganizationListPage,
    })),
  ),
  'organization.feed': lazy(() =>
    import('../organization/OrganizationFeedPage').then((m) => ({
      default: m.OrganizationFeedPage,
    })),
  ),
  'organization.feedItem': lazy(() =>
    import('../organization/OrganizationFeedItemPage').then((m) => ({
      default: m.OrganizationFeedItemPage,
    })),
  ),
  'organization.statistics': lazy(() =>
    import('../organization/OrganizationStatisticsPage').then((m) => ({
      default: m.OrganizationStatisticsPage,
    })),
  ),
  'organization.digests': lazy(() =>
    import('../digests/OrganizationDigestsPage').then((m) => ({
      default: m.OrganizationDigestsPage,
    })),
  ),
  'organization.digest': lazy(() =>
    import('../digests/OrganizationDigestPage').then((m) => ({
      default: m.OrganizationDigestPage,
    })),
  ),
  'organization.members': lazy(() =>
    import('../organization/OrganizationMembersPage').then((m) => ({
      default: m.OrganizationMembersPage,
    })),
  ),
  'organization.member': lazy(() =>
    import('../organization/OrganizationMemberPage').then((m) => ({
      default: m.OrganizationMemberPage,
    })),
  ),
  'organization.memberDigest': lazy(() =>
    import('../digests/OrganizationMemberDigestPage').then((m) => ({
      default: m.OrganizationMemberDigestPage,
    })),
  ),
  'organization.groups': lazy(() =>
    import('../organization/OrganizationGroupsPage').then((m) => ({
      default: m.OrganizationGroupsPage,
    })),
  ),
  'organization.projects': lazy(() =>
    import('../organization/OrganizationProjectsPage').then((m) => ({
      default: m.OrganizationProjectsPage,
    })),
  ),
  'organization.memory.facts': lazy(() =>
    import('../memory/OrganizationMemoryFactsPage').then((m) => ({
      default: m.OrganizationMemoryFactsPage,
    })),
  ),
  'organization.memory.graph': lazy(() =>
    import('../memory/OrganizationMemoryGraphPage').then((m) => ({
      default: m.OrganizationMemoryGraphPage,
    })),
  ),
  'organization.memory.ops': lazy(() =>
    import('../memory/OrganizationMemoryOpsPage').then((m) => ({
      default: m.OrganizationMemoryOpsPage,
    })),
  ),
  'organization.memory.fact': lazy(() =>
    import('../memory/OrganizationMemoryFactPage').then((m) => ({
      default: m.OrganizationMemoryFactPage,
    })),
  ),
  'organization.settings': lazy(() =>
    import('../organization/OrganizationSettingsPage').then((m) => ({
      default: m.OrganizationSettingsPage,
    })),
  ),
  'organization.invoice': lazy(() =>
    import('../billing/OrganizationInvoicePage').then((m) => ({
      default: m.OrganizationInvoicePage,
    })),
  ),
};
