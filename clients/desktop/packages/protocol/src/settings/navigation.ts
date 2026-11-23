/** Browser-safe definitions for serializable settings navigation props. */
import type { SettingsOrganizationRole } from './bootstrap';
import type { OrganizationSettingsSubtab } from './routes';

export interface AccountSettingsNavFlags {
  aiGatewayEnabled?: boolean;
  /**
   * The host's `providerApiKeys` capability (`CanopyCapabilities`), resolved
   * where the page is served: the person may keep their own Claude and
   * ChatGPT API keys for cloud chats, so the Model providers page shows.
   * Web sets it from the server-only provider-keys flag; desktop keeps no
   * cloud provider keys and leaves it unset, which hides the item.
   */
  providerApiKeys?: boolean;
  billingEnabled: boolean;
  digestsEnabled: boolean;
  integrationsEnabled: boolean;
  /**
   * The External agents (MCP) page is on for this user. Web only: it is a
   * hosted page, not a shared settings route, so absent hides its item.
   */
  externalAgentsEnabled?: boolean;
  /** Web only: Customize is available; desktop keeps its local Plugins tab. */
  pluginsEnabled?: boolean;
  /** Web only: Customize is available; desktop keeps its local MCP tab. */
  mcpEnabled?: boolean;
  /**
   * Account Labs lists at least one experiment for this user. Web only:
   * desktop keeps Labs in its own Settings, so absent hides the item.
   */
  labsEnabled?: boolean;
  /**
   * The Appearance page (chat detail) is listed. Web only: desktop sets
   * chat detail under Display → Appearance, so absent hides the item.
   */
  appearanceEnabled?: boolean;
  /**
   * The Delegation page (cloud delegation limits, CAN-7571) is listed: cloud
   * managed delegation is on for this user. Absent from servers before the
   * field, which hides the item.
   */
  delegationEnabled?: boolean;
  /**
   * Free app access is on (CAN-3926).
   * @deprecated Retained for shipped clients, which require it; the server always sends `true`. Current navigation always names the Billing item "AI Credits".
   */
  freeAccess?: boolean;
}

export const ORGANIZATION_SETTINGS_NAV_TABS = [
  'feed',
  'statistics',
  'digests',
  'members',
  'groups',
  'projects',
  'memory',
  'settings',
] as const;

export type OrganizationSettingsNavTab =
  (typeof ORGANIZATION_SETTINGS_NAV_TABS)[number];

/**
 * Tabs that stay LIVE while the org is lapsed, because they host actions the
 * server deliberately leaves EXEMPT from the capability gate (CAN-2311).
 *
 * Blanking these was a real gap: the exemptions exist so a lapsed org can
 * shrink to a payable seat count before subscribing, demote a compromised
 * admin, fix a mistyped org name the billing screens print back at it, revoke a
 * third party's standing GitHub access, and leave or delete the org at all.
 * Billing lives inside Settings, so a lapsed owner still reaches the one
 * surface that undoes the lapse. `groups` stays live because sub-team
 * membership removal is exempt server-side; existing project definitions and
 * wind-down actions stay available too. Gated sub-sections inside these tabs
 * are suppressed at their own render sites; the server remains the enforcement
 * boundary either way.
 *
 * The single source for the team page's lapsed panel and the settings rail.
 */
export const LAPSED_LIVE_TABS: ReadonlySet<OrganizationSettingsNavTab> =
  new Set<OrganizationSettingsNavTab>([
    'members',
    'settings',
    'groups',
    'projects',
  ]);

export interface OrganizationSettingsNavModel {
  id: string;
  name: string;
  visibleTabs: OrganizationSettingsNavTab[];
  disabledTabs: OrganizationSettingsNavTab[];
  billingNeedsAttention: boolean;
  /**
   * The viewer's role, for the scope picker's subtitle. Optional so a host
   * that has not read it yet still draws the rail.
   */
  viewerRole?: SettingsOrganizationRole;
  /** The organization's logo, for the scope picker. */
  logoUrl?: string | null;
  /** The viewer's Personal organization, which has no Settings pages. */
  isPersonal?: boolean;
  /**
   * The Settings pages (General, Policies, Integrations, Usage, Billing)
   * this viewer gets, from `visibleOrganizationSettingsSubtabs`. Each is its
   * own rail row. Absent means unknown: the rail shows one Settings row.
   */
  settingsSubtabs?: OrganizationSettingsSubtab[];
}

/**
 * One scope the settings rail can switch to: an organization the viewer
 * belongs to. The viewer's own account is always a scope too.
 */
export interface SettingsNavOrganizationScope {
  id: string;
  name: string;
  logoUrl: string | null;
  role: SettingsOrganizationRole;
  isPersonal: boolean;
}

export interface SettingsNavModel {
  account: AccountSettingsNavFlags;
  adminVisible: boolean;
  organization: OrganizationSettingsNavModel | null;
  /**
   * The organizations the viewer belongs to, in server order, for the rail's
   * scope picker. Never use the order to pick a default organization.
   * Absent while unknown: the picker lists the browsed organization only.
   */
  organizations?: SettingsNavOrganizationScope[];
  /** The signed-in viewer, for the scope picker's account row. */
  viewer?: SettingsNavViewer;
}

/** Who the account scope belongs to. */
export interface SettingsNavViewer {
  name: string | null;
  email: string;
  image: string | null;
}
