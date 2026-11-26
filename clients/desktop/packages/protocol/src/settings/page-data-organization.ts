import { z } from 'zod';
import type { MemberProfileHeader } from '../team';
import type {
  AccountDigestDetail,
  DigestArchiveItem,
  DigestReportData,
  DigestRequestCredits,
} from './account-digests';
import { isInvoiceStatus, type InvoiceDetail } from './billing';
import { settingsDtoSchema } from './operation-definition';
import {
  incomingTeamInvitationShape,
  organizationDetailShape,
  organizationLapsedInfoSchema,
  organizationRoleSchema,
  organizationSummaryShape,
  type IncomingTeamInvitation,
  type OrganizationDetail,
  type OrganizationLapsedInfo,
  type OrganizationMemberProfileEditTarget,
  type OrganizationRole,
  type OrganizationSummary,
} from './organization';
import {
  digestArchiveItemShape,
  digestReportShape,
  digestRequestCreditsShape,
  organizationDigestDetailShape,
} from './organization-digests';
import {
  explorerFactDetailShape,
  explorerFactShape,
  explorerIngestJobPageShape,
  explorerMemoryConfigSnapshotShape,
  explorerSearchLogPageShape,
  explorerSourceTranscriptShape,
  type ExplorerFact,
  type ExplorerFactDetail,
  type ExplorerIngestJob,
  type ExplorerIngestJobStatus,
  type ExplorerMemoryConfigSnapshot,
  type ExplorerRankedFact,
  type ExplorerSearchLogEntry,
  type ExplorerSourceTranscript,
} from './organization-memory';
import {
  ORGANIZATION_TRANSCRIPT_VIEWS,
  type OrganizationSettingsRoute,
  type OrganizationsSettingsRoute,
  type OrganizationTranscriptView,
  type SettingsRoute,
} from './routes';

/**
 * First-screen data for the Organizations list and every organization route,
 * as the web server page and its loader pass it to client components today.
 * `settings.pageData` returns one member of this union for an organization
 * route; the web pages render the same DTO through the shared components.
 *
 * Host-only page inputs stay outside the DTO: the `?joined=1` and `?invite=1`
 * one-shot flags, the fact page's `?source=` selection and the graph view's
 * filter query are URL state the host reads, not route data.
 */

export const ORGANIZATION_PAGE_DATA_KINDS = [
  'organization.list',
  'organization.feed',
  'organization.feedItem',
  'organization.statistics',
  'organization.digests',
  'organization.digest',
  'organization.members',
  'organization.member',
  'organization.memberDigest',
  'organization.groups',
  'organization.projects',
  'organization.memory.facts',
  'organization.memory.graph',
  'organization.memory.ops',
  'organization.memory.fact',
  'organization.transcripts',
  'organization.transcripts.session',
  'organization.settings',
  'organization.invoice',
] as const;

export type OrganizationPageDataKind =
  (typeof ORGANIZATION_PAGE_DATA_KINDS)[number];

/* -------------------------------------------------------------------------- */
/* DTO types                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The Organizations list. Today the page passes no props: the list panel
 * reads memberships and incoming invitations on mount. Both are optional so
 * a server may prefill them; absent means "read through the table".
 */
export interface OrganizationListPageData {
  organizations?: OrganizationSummary[];
  invitations?: IncomingTeamInvitation[];
}

/**
 * The shared `loadTeamPageData` projection every TeamPage-backed tab
 * receives (Feed, Statistics, Digests, Members, Teams, Projects, Settings).
 */
export interface OrganizationTeamPageData {
  detail: OrganizationDetail;
  organizations: OrganizationSummary[];
  viewerEmail: string;
  billingEnabled: boolean;
  memoryEnabled: boolean;
  digestsEnabled: boolean;
  projectsEnabled: boolean;
  billingNeedsAttention: boolean;
  /** @deprecated Retained for shipped clients, which require it; the server always sends `true`. */
  freeAccess: boolean;
  /** @deprecated Retained for shipped clients, which require it; the server always sends `null`: no organization lapses. */
  lapsed: OrganizationLapsedInfo | null;
  /** The request came from a phone or tablet browser. Always false on desktop. */
  mobileBrowser: boolean;
  /**
   * Settings only, web only: outside agents (the hosted MCP servers) are on
   * for this viewer. Absent elsewhere, which hides the External agents card.
   */
  externalAgentsEnabled?: boolean;
  /**
   * Settings only: AI gateway setup is on for this viewer. Absent elsewhere,
   * which hides the AI gateway page and keeps the legacy Policies card.
   */
  aiGatewayEnabled?: boolean;
}

/** A feed permalink: the feed tab anchored on one item. */
export interface OrganizationFeedItemPageData extends OrganizationTeamPageData {
  highlightItemId: string;
}

/**
 * The request control above the org digest archive. `null` for viewers who
 * cannot request (members); `unavailable` hides the form exactly as the web
 * page does when the payer cannot be resolved.
 */
export type OrganizationDigestRequestState =
  | { status: 'ok'; credits: DigestRequestCredits }
  | { status: 'unavailable' }
  | null;

/**
 * The org Digests tab. Replaces the server-rendered `digestContent` element:
 * `archive` is `null` while the org is lapsed (TeamPage renders the lapsed
 * panel instead); otherwise it carries the rows and request state the shared
 * Digests page renders, including whether auto-refresh is active.
 */
export interface OrganizationDigestsPageData extends OrganizationTeamPageData {
  archive: {
    digests: DigestArchiveItem[];
    request: OrganizationDigestRequestState;
  } | null;
}

/** Older/newer neighbor ids within the archive the detail can serve. */
export interface OrganizationDigestNeighbors {
  olderId: string | null;
  newerId: string | null;
}

/** `/organization/[orgId]/digests/[digestId]`. */
export interface OrganizationDigestPageData {
  organization: { id: string; name: string; viewerRole: OrganizationRole };
  /** Viewer is OWNER/ADMIN: may manage sharing and reach cadence settings. */
  canEdit: boolean;
  /** Non-null when the org lost `teams`; the page renders only the notice. */
  lapsed: OrganizationLapsedInfo | null;
  /** `null` exactly when `lapsed` is non-null. */
  report: {
    digest: AccountDigestDetail;
    neighbors: OrganizationDigestNeighbors;
    /** Present only for editors whose digest carries a share path. */
    share: { sharePath: string; sharingEnabled: boolean } | null;
  } | null;
}

/** `/organization/[orgId]/members/[userId]` (`MemberProfilePageData`). */
export interface OrganizationMemberPageData {
  org: { id: string; name: string };
  member: MemberProfileHeader;
  viewerCanViewStats: boolean;
  /** The viewer may open this member's shared transcripts (owner, flag on). Absent from older servers. */
  viewerCanViewTranscripts?: boolean;
  editContext: OrganizationMemberProfileEditTarget | null;
  orgLapsed: boolean;
  orgTrialEndedAt: string | null;
  orgLapseReason: OrganizationLapsedInfo['lapseReason'];
  requiredPlanName: string | null;
  viewerCanEditOrg: boolean;
  showDigestsTab: boolean;
  isOwnProfile: boolean;
  mobileBrowser: boolean;
}

/** `/organization/[orgId]/members/[userId]/digests/[digestId]`. */
export interface OrganizationMemberDigestPageData {
  org: { id: string; name: string };
  member: { id: string; name: string };
  /** Share-safe projection: no costs, no share link, no sharing state. */
  digest: DigestReportData;
  neighbors: OrganizationDigestNeighbors;
}

/**
 * Memory pages render a not-enabled state when the rollout is off. `team`
 * carries the organization header the other tabs draw; older servers omit
 * it, and the page then renders without that header.
 */
export type OrganizationMemoryPageData<T> = {
  team?: OrganizationTeamPageData;
} & ({ enabled: false } | ({ enabled: true } & T));

export type OrganizationMemoryFactsPageData = OrganizationMemoryPageData<{
  initialFacts: Array<ExplorerFact | ExplorerRankedFact>;
  initialNextCursor: string | null;
}>;

/** The graph payload is read through `organization.memory.graph`. */
export type OrganizationMemoryGraphPageData = OrganizationMemoryPageData<
  Record<never, never>
>;

export type OrganizationMemoryOpsPageData = OrganizationMemoryPageData<{
  jobs: ExplorerIngestJob[];
  counts: Record<ExplorerIngestJobStatus, number>;
  searchEntries: ExplorerSearchLogEntry[];
  config: ExplorerMemoryConfigSnapshot;
}>;

/**
 * `/organization/[orgId]/memory/fact/[factId]`. The transcript is the first
 * source's; a host that selected another source reads it through
 * `organization.memory.factSource`.
 */
export type OrganizationMemoryFactPageData = OrganizationMemoryPageData<{
  detail: ExplorerFactDetail;
  transcript: ExplorerSourceTranscript | null;
}>;

/**
 * `/organization/[orgId]/transcripts[/exports|/access]`: owners only. The
 * Sessions, Exports and Access history contents load through the
 * `organization.transcripts.*` settings operations; page data carries only
 * the header, the active view and whether exports can be stored here.
 */
export interface OrganizationTranscriptsPageData {
  team: OrganizationTeamPageData;
  view: OrganizationTranscriptView;
  /** False when the deployment has no export storage: Export stays off, browsing works. */
  storageAvailable: boolean;
}

/**
 * `/organization/[orgId]/transcripts/sessions/[sessionId]`: the gate and
 * header only. The transcript loads through `organization.transcripts.session`
 * on mount, so a page-data prefetch never records a view.
 */
export interface OrganizationTranscriptSessionPageData {
  team: OrganizationTeamPageData;
  sessionId: string;
}

/** `/organization/[orgId]/billing/invoices/[invoiceId]`. No API route exists. */
export interface OrganizationInvoicePageData {
  invoice: InvoiceDetail;
}

/* -------------------------------------------------------------------------- */
/* Schemas                                                                     */
/* -------------------------------------------------------------------------- */

const teamPageDataFields = {
  detail: organizationDetailShape,
  organizations: z.array(organizationSummaryShape),
  viewerEmail: z.string(),
  billingEnabled: z.boolean(),
  memoryEnabled: z.boolean(),
  digestsEnabled: z.boolean(),
  projectsEnabled: z.boolean(),
  billingNeedsAttention: z.boolean(),
  /** @deprecated Retained for shipped clients, which require it; the server always sends `true`. */
  freeAccess: z.boolean(),
  /** @deprecated Retained for shipped clients, which require it; the server always sends `null`. */
  lapsed: organizationLapsedInfoSchema.nullable(),
  mobileBrowser: z.boolean(),
  externalAgentsEnabled: z.boolean().optional(),
  aiGatewayEnabled: z.boolean().optional(),
};

const teamPageDataShape = z.looseObject(teamPageDataFields);

export const organizationTeamPageDataSchema =
  settingsDtoSchema<OrganizationTeamPageData>(teamPageDataShape);

const neighborsShape = z.looseObject({
  olderId: z.string().nullable(),
  newerId: z.string().nullable(),
});

const memoryTeamField = { team: teamPageDataShape.optional() };

const memoryDisabledShape = z.looseObject({
  enabled: z.literal(false),
  ...memoryTeamField,
});

function memoryPageShape(fields: Record<string, z.ZodType>): z.ZodType {
  return z.union([
    memoryDisabledShape,
    z.looseObject({ enabled: z.literal(true), ...memoryTeamField, ...fields }),
  ]);
}

const lapseReasonShape = organizationLapsedInfoSchema.shape.lapseReason;

const pageDataShapes = {
  'organization.list': settingsDtoSchema<OrganizationListPageData>(
    z.looseObject({
      organizations: z.array(organizationSummaryShape).optional(),
      invitations: z.array(incomingTeamInvitationShape).optional(),
    }),
  ),
  'organization.feed': organizationTeamPageDataSchema,
  'organization.feedItem': settingsDtoSchema<OrganizationFeedItemPageData>(
    z.looseObject({
      ...teamPageDataFields,
      highlightItemId: z.string().min(1),
    }),
  ),
  'organization.statistics': organizationTeamPageDataSchema,
  'organization.digests': settingsDtoSchema<OrganizationDigestsPageData>(
    z.looseObject({
      ...teamPageDataFields,
      archive: z
        .looseObject({
          digests: z.array(digestArchiveItemShape),
          request: z
            .union([
              z.looseObject({
                status: z.literal('ok'),
                credits: digestRequestCreditsShape,
              }),
              z.looseObject({ status: z.literal('unavailable') }),
            ])
            .nullable(),
        })
        .nullable(),
    }),
  ),
  'organization.digest': settingsDtoSchema<OrganizationDigestPageData>(
    z
      .looseObject({
        organization: z.looseObject({
          id: z.string(),
          name: z.string(),
          viewerRole: organizationRoleSchema,
        }),
        canEdit: z.boolean(),
        lapsed: organizationLapsedInfoSchema.nullable(),
        report: z
          .looseObject({
            digest: organizationDigestDetailShape,
            neighbors: neighborsShape,
            share: z
              .looseObject({
                sharePath: z.string(),
                sharingEnabled: z.boolean(),
              })
              .nullable(),
          })
          .nullable(),
      })
      .refine((data) => (data.lapsed === null) === (data.report !== null)),
  ),
  'organization.members': organizationTeamPageDataSchema,
  'organization.member': settingsDtoSchema<OrganizationMemberPageData>(
    z.looseObject({
      org: z.looseObject({ id: z.string(), name: z.string() }),
      member: z.looseObject({
        id: z.string(),
        name: z.string(),
        email: z.string(),
        image: z.string().nullable(),
        role: organizationRoleSchema,
        memberSinceIso: z.string(),
      }),
      viewerCanViewStats: z.boolean(),
      viewerCanViewTranscripts: z.boolean().optional(),
      editContext: z
        .union([
          z.looseObject({ mode: z.literal('self') }),
          z.looseObject({
            mode: z.literal('org-member'),
            orgId: z.string(),
            userId: z.string(),
          }),
        ])
        .nullable(),
      orgLapsed: z.boolean(),
      orgTrialEndedAt: z.string().nullable(),
      orgLapseReason: lapseReasonShape,
      requiredPlanName: z.string().nullable(),
      viewerCanEditOrg: z.boolean(),
      showDigestsTab: z.boolean(),
      isOwnProfile: z.boolean(),
      mobileBrowser: z.boolean(),
    }),
  ),
  'organization.memberDigest':
    settingsDtoSchema<OrganizationMemberDigestPageData>(
      z.looseObject({
        org: z.looseObject({ id: z.string(), name: z.string() }),
        member: z.looseObject({ id: z.string(), name: z.string() }),
        digest: digestReportShape,
        neighbors: neighborsShape,
      }),
    ),
  'organization.groups': organizationTeamPageDataSchema,
  'organization.projects': organizationTeamPageDataSchema,
  'organization.memory.facts':
    settingsDtoSchema<OrganizationMemoryFactsPageData>(
      memoryPageShape({
        initialFacts: z.array(explorerFactShape),
        initialNextCursor: z.string().nullable(),
      }),
    ),
  'organization.memory.graph':
    settingsDtoSchema<OrganizationMemoryGraphPageData>(memoryPageShape({})),
  'organization.memory.ops': settingsDtoSchema<OrganizationMemoryOpsPageData>(
    memoryPageShape({
      jobs: explorerIngestJobPageShape.shape.jobs,
      counts: explorerIngestJobPageShape.shape.counts,
      searchEntries: explorerSearchLogPageShape.shape.entries,
      config: explorerMemoryConfigSnapshotShape,
    }),
  ),
  'organization.memory.fact': settingsDtoSchema<OrganizationMemoryFactPageData>(
    memoryPageShape({
      detail: explorerFactDetailShape,
      transcript: explorerSourceTranscriptShape.nullable(),
    }),
  ),
  'organization.transcripts':
    settingsDtoSchema<OrganizationTranscriptsPageData>(
      z.looseObject({
        team: teamPageDataShape,
        view: z.enum(ORGANIZATION_TRANSCRIPT_VIEWS),
        storageAvailable: z.boolean(),
      }),
    ),
  'organization.transcripts.session':
    settingsDtoSchema<OrganizationTranscriptSessionPageData>(
      z.looseObject({ team: teamPageDataShape, sessionId: z.string() }),
    ),
  'organization.settings': organizationTeamPageDataSchema,
  'organization.invoice': settingsDtoSchema<OrganizationInvoicePageData>(
    z.looseObject({
      invoice: z.looseObject({
        id: z.string(),
        number: z.string(),
        issuedAt: z.string(),
        periodStart: z.string(),
        periodEnd: z.string(),
        currency: z.string(),
        status: z.custom<string>(isInvoiceStatus),
        isCurrent: z.boolean(),
        billTo: z.looseObject({}),
        lineItems: z.array(z.looseObject({})),
        subtotalUsd: z.number(),
        taxUsd: z.number(),
        totalUsd: z.number(),
        amountPaidUsd: z.number(),
        amountRefundedUsd: z.number(),
        credits: z.looseObject({}),
      }),
    }),
  ),
} as const satisfies Record<OrganizationPageDataKind, z.ZodType>;

function pageDataMember<
  K extends OrganizationPageDataKind,
  T extends (typeof pageDataShapes)[K],
>(kind: K, data: T): z.ZodObject<{ kind: z.ZodLiteral<K>; data: T }> {
  return z.object({ kind: z.literal(kind), data });
}

export const organizationListPageDataSchema = pageDataMember(
  'organization.list',
  pageDataShapes['organization.list'],
);
export const organizationFeedPageDataSchema = pageDataMember(
  'organization.feed',
  pageDataShapes['organization.feed'],
);
export const organizationFeedItemPageDataSchema = pageDataMember(
  'organization.feedItem',
  pageDataShapes['organization.feedItem'],
);
export const organizationStatisticsPageDataSchema = pageDataMember(
  'organization.statistics',
  pageDataShapes['organization.statistics'],
);
export const organizationDigestsPageDataSchema = pageDataMember(
  'organization.digests',
  pageDataShapes['organization.digests'],
);
export const organizationDigestPageDataSchema = pageDataMember(
  'organization.digest',
  pageDataShapes['organization.digest'],
);
export const organizationMembersPageDataSchema = pageDataMember(
  'organization.members',
  pageDataShapes['organization.members'],
);
export const organizationMemberPageDataSchema = pageDataMember(
  'organization.member',
  pageDataShapes['organization.member'],
);
export const organizationMemberDigestPageDataSchema = pageDataMember(
  'organization.memberDigest',
  pageDataShapes['organization.memberDigest'],
);
export const organizationGroupsPageDataSchema = pageDataMember(
  'organization.groups',
  pageDataShapes['organization.groups'],
);
export const organizationProjectsPageDataSchema = pageDataMember(
  'organization.projects',
  pageDataShapes['organization.projects'],
);
export const organizationMemoryFactsPageDataSchema = pageDataMember(
  'organization.memory.facts',
  pageDataShapes['organization.memory.facts'],
);
export const organizationMemoryGraphPageDataSchema = pageDataMember(
  'organization.memory.graph',
  pageDataShapes['organization.memory.graph'],
);
export const organizationMemoryOpsPageDataSchema = pageDataMember(
  'organization.memory.ops',
  pageDataShapes['organization.memory.ops'],
);
export const organizationMemoryFactPageDataSchema = pageDataMember(
  'organization.memory.fact',
  pageDataShapes['organization.memory.fact'],
);
export const organizationTranscriptsPageDataSchema = pageDataMember(
  'organization.transcripts',
  pageDataShapes['organization.transcripts'],
);
export const organizationTranscriptSessionPageDataSchema = pageDataMember(
  'organization.transcripts.session',
  pageDataShapes['organization.transcripts.session'],
);
export const organizationSettingsPageDataSchema = pageDataMember(
  'organization.settings',
  pageDataShapes['organization.settings'],
);
export const organizationInvoicePageDataSchema = pageDataMember(
  'organization.invoice',
  pageDataShapes['organization.invoice'],
);

/** Every organization page-data member, discriminated by `kind`. */
export const organizationPageDataSchema = z.discriminatedUnion('kind', [
  organizationListPageDataSchema,
  organizationFeedPageDataSchema,
  organizationFeedItemPageDataSchema,
  organizationStatisticsPageDataSchema,
  organizationDigestsPageDataSchema,
  organizationDigestPageDataSchema,
  organizationMembersPageDataSchema,
  organizationMemberPageDataSchema,
  organizationMemberDigestPageDataSchema,
  organizationGroupsPageDataSchema,
  organizationProjectsPageDataSchema,
  organizationMemoryFactsPageDataSchema,
  organizationMemoryGraphPageDataSchema,
  organizationMemoryOpsPageDataSchema,
  organizationMemoryFactPageDataSchema,
  organizationTranscriptsPageDataSchema,
  organizationTranscriptSessionPageDataSchema,
  organizationSettingsPageDataSchema,
  organizationInvoicePageDataSchema,
]);

export type OrganizationPageData = z.infer<typeof organizationPageDataSchema>;

/** The page-data member for one kind. */
export type OrganizationPageDataFor<K extends OrganizationPageDataKind> =
  Extract<OrganizationPageData, { kind: K }>;

function organizationRouteKind(
  route: OrganizationSettingsRoute,
): OrganizationPageDataKind {
  switch (route.page) {
    case 'feed':
      return route.itemId === undefined
        ? 'organization.feed'
        : 'organization.feedItem';
    case 'statistics':
      return 'organization.statistics';
    case 'digests':
      return route.digestId === undefined
        ? 'organization.digests'
        : 'organization.digest';
    case 'members':
      if (route.userId === undefined) return 'organization.members';
      return route.digestId === undefined
        ? 'organization.member'
        : 'organization.memberDigest';
    case 'groups':
      return 'organization.groups';
    case 'projects':
      return 'organization.projects';
    case 'memory':
      if (route.factId !== undefined) return 'organization.memory.fact';
      if (route.memoryView === 'graph') return 'organization.memory.graph';
      if (route.memoryView === 'ops') return 'organization.memory.ops';
      return 'organization.memory.facts';
    case 'transcripts':
      return route.sessionId === undefined
        ? 'organization.transcripts'
        : 'organization.transcripts.session';
    case 'settings':
      return route.invoiceId === undefined
        ? 'organization.settings'
        : 'organization.invoice';
  }
}

/**
 * The page-data kind a validated route loads, or `null` for account routes
 * (which the account half of the union owns).
 */
export function organizationPageDataKindForRoute(
  route: OrganizationSettingsRoute | OrganizationsSettingsRoute,
): OrganizationPageDataKind;
export function organizationPageDataKindForRoute(
  route: SettingsRoute,
): OrganizationPageDataKind | null;
export function organizationPageDataKindForRoute(
  route: SettingsRoute,
): OrganizationPageDataKind | null {
  switch (route.scope) {
    case 'account':
      return null;
    case 'organizations':
      return 'organization.list';
    case 'organization':
      return organizationRouteKind(route);
  }
}

/** Validate untrusted page data for an organization route. */
export function parseOrganizationPageData(
  value: unknown,
): OrganizationPageData | null {
  const parsed = organizationPageDataSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
