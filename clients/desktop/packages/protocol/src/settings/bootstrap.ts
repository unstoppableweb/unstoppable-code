import { z } from 'zod';
import { ORGANIZATION_SETTINGS_NAV_TABS } from './navigation';
import { settingsRouteIdSchema } from './routes';

export const SETTINGS_BOOTSTRAP_VERSION = 1;

export const settingsOrganizationRoleSchema = z.enum([
  'OWNER',
  'ADMIN',
  'MEMBER',
]);

export type SettingsOrganizationRole = z.infer<
  typeof settingsOrganizationRoleSchema
>;

/** One organization the viewer belongs to, in server order. Never use the
 * order to pick a default organization. */
export const settingsOrganizationMembershipSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string(),
  logoUrl: z.string().nullable().optional(),
  role: settingsOrganizationRoleSchema,
  isPersonal: z.boolean(),
});

export type SettingsOrganizationMembership = z.infer<
  typeof settingsOrganizationMembershipSchema
>;

export const settingsOrganizationLapseSchema = z.looseObject({
  trialEndedAt: z.string().nullable(),
  lapseReason: z.string().nullable(),
  requiredPlanName: z.string().nullable(),
});

const organizationNavTabSchema = z.enum(ORGANIZATION_SETTINGS_NAV_TABS);

/**
 * The settings rail model and page gates for one organization the request
 * named. Mirrors `loadOrganizationSettingsNavData` and
 * `loadOrganizationSettingsNavModel` on web.
 */
export const settingsOrganizationBootstrapSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string(),
  viewerRole: settingsOrganizationRoleSchema,
  isPersonal: z.boolean(),
  visibleTabs: z.array(organizationNavTabSchema),
  disabledTabs: z.array(organizationNavTabSchema),
  billingNeedsAttention: z.boolean(),
  aiGatewayEnabled: z.boolean().optional(),
  billingEnabled: z.boolean(),
  memoryEnabled: z.boolean(),
  digestsEnabled: z.boolean(),
  projectsEnabled: z.boolean(),
  canViewUsageStats: z.boolean(),
  /** @deprecated Retained for shipped clients, which require it; the server always sends `true`. */
  freeAccess: z.boolean(),
  /**
   * The GitHub App is connected. A lapsed organization keeps Integrations on
   * the rail only to disconnect it. Absent from servers before this field;
   * hosts then treat the state as unknown.
   */
  githubConnected: z.boolean().optional(),
  /**
   * The viewer may open the organization Transcripts page: an owner of a
   * non-Personal organization with the release flag on. Sent as its own field,
   * never as a `visibleTabs` entry, because shipped desktops reject a tab name
   * they don't know (docs/organization-transcripts.md). Absent from older
   * servers; hosts then show no Transcripts tab.
   */
  transcriptsEnabled: z.boolean().optional(),
  /** @deprecated Retained for shipped clients, which require it; the server always sends `null`: no organization lapses. */
  lapse: settingsOrganizationLapseSchema.nullable(),
});

export type SettingsOrganizationBootstrap = z.infer<
  typeof settingsOrganizationBootstrapSchema
>;

/**
 * Everything a host needs to draw the hosted settings rail and gate its
 * pages. Version 1 is additive: hosts tolerate unknown fields and reject
 * malformed required data. A server without this route is an unsupported
 * server, not an empty account.
 */
export const settingsBootstrapSchema = z.looseObject({
  version: z.literal(SETTINGS_BOOTSTRAP_VERSION),
  viewer: z.looseObject({
    /** The account id `/api/v1/<brand>/account` reports for this user. */
    id: z.string().min(1),
    email: z.string(),
    name: z.string().nullable(),
    image: z.string().nullable().optional(),
  }),
  account: z.looseObject({
    aiGatewayEnabled: z.boolean().optional(),
    billingEnabled: z.boolean(),
    digestsEnabled: z.boolean(),
    integrationsEnabled: z.boolean(),
    /** Cloud managed delegation is on: the Delegation page is listed (CAN-7571). */
    delegationEnabled: z.boolean().optional(),
    /** @deprecated Retained for shipped clients, which require it; the server always sends `true`. */
    freeAccess: z.boolean(),
  }),
  organizations: z.array(settingsOrganizationMembershipSchema),
  /** Present when the request named an organization the viewer belongs to. */
  organization: settingsOrganizationBootstrapSchema.nullable(),
});

export type SettingsBootstrap = z.infer<typeof settingsBootstrapSchema>;

export const settingsBootstrapInputSchema = z.strictObject({
  organizationId: settingsRouteIdSchema.optional(),
});

export type SettingsBootstrapInput = z.infer<
  typeof settingsBootstrapInputSchema
>;

/** Whether the bootstrap lists an organization by explicit id. */
export function settingsBootstrapHasOrganization(
  bootstrap: Pick<SettingsBootstrap, 'organizations'>,
  organizationId: string,
): boolean {
  return bootstrap.organizations.some(
    (organization) => organization.id === organizationId,
  );
}
