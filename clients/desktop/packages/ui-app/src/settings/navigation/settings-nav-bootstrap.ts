import type {
  OrganizationSettingsSubtab,
  SettingsBootstrap,
  SettingsNavModel,
  SettingsOrganizationBootstrap,
} from '@canopy/protocol/settings';
import { visibleOrganizationSettingsSubtabs } from '@canopy/protocol/settings/organization-permissions';

/**
 * The settings rail model for a bootstrap. The organization group appears
 * only when the bootstrap was requested for an organization the viewer is
 * browsing (explicit navigation or selection), never from membership order.
 * Hosts without a server-rendered rail (desktop) build the rail from this.
 *
 * A lapsed organization keeps Integrations only while GitHub is connected
 * (or a server too old to say), so the connection can be removed. Hosts
 * without the outside-agents card never offer it.
 */
export function settingsNavModelFromBootstrap(
  bootstrap: SettingsBootstrap,
  browsedOrganizationId: string | null,
): SettingsNavModel {
  const organization =
    browsedOrganizationId !== null &&
    bootstrap.organization !== null &&
    bootstrap.organization.id === browsedOrganizationId
      ? bootstrap.organization
      : null;
  const membership =
    organization === null
      ? undefined
      : bootstrap.organizations.find(
          (candidate) => candidate.id === organization.id,
        );
  return {
    account: {
      aiGatewayEnabled: bootstrap.account.aiGatewayEnabled,
      billingEnabled: bootstrap.account.billingEnabled,
      digestsEnabled: bootstrap.account.digestsEnabled,
      integrationsEnabled: bootstrap.account.integrationsEnabled,
      delegationEnabled: bootstrap.account.delegationEnabled,
    },
    // Global Admin is a web-only surface; organization roles never imply it.
    adminVisible: false,
    organization:
      organization === null
        ? null
        : {
            id: organization.id,
            name: organization.name,
            visibleTabs: organization.visibleTabs,
            disabledTabs: organization.disabledTabs,
            billingNeedsAttention: organization.billingNeedsAttention,
            viewerRole: organization.viewerRole,
            logoUrl: membership?.logoUrl ?? null,
            isPersonal: organization.isPersonal,
            settingsSubtabs:
              organizationSettingsSubtabsFromBootstrap(organization),
          },
    organizations: bootstrap.organizations.map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      logoUrl: candidate.logoUrl ?? null,
      role: candidate.role,
      isPersonal: candidate.isPersonal,
    })),
    viewer: {
      name: bootstrap.viewer.name,
      email: bootstrap.viewer.email,
      image: bootstrap.viewer.image ?? null,
    },
  };
}

/**
 * The Settings pages a bootstrap's organization offers this viewer, in rail
 * order: the rail's rows, and the page a bare or hidden `?tab=` opens.
 */
export function organizationSettingsSubtabsFromBootstrap(
  organization: SettingsOrganizationBootstrap,
): OrganizationSettingsSubtab[] {
  if (organization.isPersonal) return [];
  return visibleOrganizationSettingsSubtabs({
    aiGatewayEnabled: organization.aiGatewayEnabled,
    viewerRole: organization.viewerRole,
    lapsed: organization.lapse !== null,
    billingEnabled: organization.billingEnabled,
    canViewUsageStats: organization.canViewUsageStats,
    githubConnected: organization.githubConnected ?? null,
    externalAgentsPolicy: false,
  });
}
