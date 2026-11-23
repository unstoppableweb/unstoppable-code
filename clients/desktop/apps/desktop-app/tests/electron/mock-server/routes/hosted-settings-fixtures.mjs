// Fake data for the hosted settings mock surface (./hosted-settings.mjs).
//
// Every DTO here is shaped after the wire contracts in
// `packages/protocol/src/settings/` (bootstrap, page data, operation results)
// and is checked against those zod schemas by `hosted-settings.test.mjs`.
// This file is plain ESM loaded outside the TS build graph, so it restates
// the shapes instead of importing them; the schema test catches drift.
//
// Only placeholder identities are used (example.com / example.test
// addresses, fake ids). Nothing here is a real credential.

import { CLOUD_ACCOUNT } from './cloud.mjs';

export const HOSTED_SETTINGS_TIME = '2026-10-01T12:00:00.000Z';
const EARLIER = '2026-09-01T12:00:00.000Z';
const LATER = '2026-10-31T12:00:00.000Z';

/** The account `/api/v1/<ns>/account` reports unless a scenario renames it. */
export const HOSTED_SETTINGS_VIEWER = Object.freeze({
  id: CLOUD_ACCOUNT.id,
  name: CLOUD_ACCOUNT.name,
  email: CLOUD_ACCOUNT.email,
});

export const HOSTED_SETTINGS_ORG_IDS = Object.freeze({
  personal: 'a0000000-0000-4000-8000-000000000001',
  owner: 'a0000000-0000-4000-8000-000000000002',
  member: 'a0000000-0000-4000-8000-000000000003',
  lapsed: 'a0000000-0000-4000-8000-000000000004',
});

export const HOSTED_SETTINGS_TEAMMATES = Object.freeze({
  avery: Object.freeze({
    id: 'b1000000-0000-4000-8000-000000000001',
    name: 'Avery Example',
    email: 'avery@example.com',
  }),
  blake: Object.freeze({
    id: 'b1000000-0000-4000-8000-000000000002',
    name: 'Blake Example',
    email: 'blake@example.com',
  }),
  casey: Object.freeze({
    id: 'b1000000-0000-4000-8000-000000000003',
    name: 'Casey Example',
    email: 'casey@example.com',
  }),
});

export const HOSTED_SETTINGS_SUB_TEAM_ID =
  'c1000000-0000-4000-8000-000000000001';
export const HOSTED_SETTINGS_DIGEST_ID = 'digest-e2e-weekly-1';
export const HOSTED_SETTINGS_INVOICE_ID = '2026-09-01';
export const HOSTED_SETTINGS_FACT_ID = 'fact-e2e-1';
export const HOSTED_SETTINGS_FEED_ITEM_ID = 'feed-e2e-1';
export const HOSTED_SETTINGS_PASSWORD = 'correct-horse-e2e';

/** Mirrors `LAPSED_LIVE_TABS` in `packages/protocol/src/settings/navigation.ts`. */
const LAPSED_LIVE_TABS = new Set(['members', 'settings', 'groups', 'projects']);
const ROLE_RANK = { MEMBER: 0, ADMIN: 1, OWNER: 2 };

export function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export function canEditOrganization(role) {
  return role === 'OWNER' || role === 'ADMIN';
}

function member(person, role, subTeamIds = []) {
  return { ...person, image: null, role, subTeamIds, memberSince: EARLIER };
}

function defaultConfig() {
  return {
    usageStatsMinRole: 'ADMIN',
    allowExternalContainerSharing: false,
    enforceMemberDataSharing: false,
    enforceMemberModelPolicy: false,
    blockedModelIds: [],
    reviewedModelIds: [],
    enforceMemberModelGateway: false,
    modelGatewayDisplayName: null,
    modelGatewayRevision: 'mock-gateway-1',
    modelGatewayBaseUrl: null,
    modelGatewayModels: [],
    modelGatewayEnforced: false,
    modelGatewayPromptCachePassthrough: false,
    enforcedSync: {
      transcripts: null,
      plans: null,
      metadata: null,
      summaries: null,
    },
  };
}

function project(organizationId, index, name) {
  return {
    id: `e1000000-0000-4000-8000-00000000000${index}`,
    organizationId,
    name,
    description: `${name} fixture project`,
    kind: 'CODE',
    location: 'LOCAL',
    repository: {
      provider: 'github',
      host: 'github.com',
      owner: 'example-org',
      name: name.toLowerCase().replace(/\s+/g, '-'),
      providerRepoId: `90000${index}`,
      defaultBranch: 'main',
      verification: 'VERIFIED',
    },
    state: 'ACTIVE',
    revision: 1,
    authorizationVersion: 1,
    defaultListed: true,
    preference: 'FOLLOW_DEFAULTS',
    listed: true,
    capabilities: { administer: true, manageCloud: false, use: true },
    instance: null,
    grants: [{ defaultListed: true, principal: { type: 'organization' } }],
    createdBy: {
      id: HOSTED_SETTINGS_VIEWER.id,
      name: HOSTED_SETTINGS_VIEWER.name,
    },
    createdAt: EARLIER,
    updatedAt: HOSTED_SETTINGS_TIME,
  };
}

function fact(id, text) {
  return {
    id,
    factText: text,
    evidenceType: 'OBSERVED',
    evidenceQuote: null,
    validAt: EARLIER,
    invalidAt: null,
    createdAt: EARLIER,
    expiredAt: null,
    invalidatedById: null,
    liveness: 'live',
    entities: [
      {
        id: 'entity-e2e-1',
        canonicalName: 'build-service',
        entityType: 'SERVICE',
      },
    ],
  };
}

/**
 * The seeded organizations, in server order: a Personal organization, a team
 * the viewer owns, a team where the viewer is a MEMBER, and a lapsed team
 * the viewer administers.
 */
export function defaultHostedSettingsOrganizations(
  viewer = HOSTED_SETTINGS_VIEWER,
) {
  const { avery, blake, casey } = HOSTED_SETTINGS_TEAMMATES;
  return [
    {
      id: HOSTED_SETTINGS_ORG_IDS.personal,
      name: viewer.name,
      isPersonal: true,
      viewerRole: 'OWNER',
      members: [member(viewer, 'OWNER')],
      subTeams: [],
      lapsed: null,
      config: defaultConfig(),
      projects: [],
      facts: [],
    },
    {
      id: HOSTED_SETTINGS_ORG_IDS.owner,
      name: 'Northwind Labs',
      isPersonal: false,
      viewerRole: 'OWNER',
      members: [
        member(viewer, 'OWNER', [HOSTED_SETTINGS_SUB_TEAM_ID]),
        member(avery, 'ADMIN', [HOSTED_SETTINGS_SUB_TEAM_ID]),
        member(blake, 'MEMBER'),
      ],
      subTeams: [{ id: HOSTED_SETTINGS_SUB_TEAM_ID, name: 'Platform' }],
      lapsed: null,
      config: defaultConfig(),
      projects: [project(HOSTED_SETTINGS_ORG_IDS.owner, 1, 'Build Service')],
      facts: [
        fact(HOSTED_SETTINGS_FACT_ID, 'The build service deploys from main.'),
      ],
    },
    {
      id: HOSTED_SETTINGS_ORG_IDS.member,
      name: 'Fabrikam Research',
      isPersonal: false,
      viewerRole: 'MEMBER',
      members: [member(casey, 'OWNER'), member(viewer, 'MEMBER')],
      subTeams: [],
      lapsed: null,
      config: { ...defaultConfig(), usageStatsMinRole: 'MEMBER' },
      projects: [project(HOSTED_SETTINGS_ORG_IDS.member, 2, 'Research Notes')],
      facts: [],
    },
    {
      id: HOSTED_SETTINGS_ORG_IDS.lapsed,
      name: 'Contoso Archive',
      isPersonal: false,
      viewerRole: 'ADMIN',
      members: [member(avery, 'OWNER'), member(viewer, 'ADMIN')],
      subTeams: [],
      lapsed: {
        trialEndedAt: EARLIER,
        lapseReason: 'trial_ended',
        requiredPlanName: 'Team',
      },
      config: defaultConfig(),
      projects: [],
      facts: [],
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* Organization projections                                                    */
/* -------------------------------------------------------------------------- */

export function viewerRoleClears(org, minRole) {
  return ROLE_RANK[org.viewerRole] >= ROLE_RANK[minRole];
}

function memberDto(entry) {
  return {
    id: entry.id,
    name: entry.name,
    email: entry.email,
    image: entry.image,
    role: entry.role,
    subTeamIds: [...entry.subTeamIds],
  };
}

export function organizationSummary(org) {
  return {
    id: org.id,
    name: org.name,
    role: org.viewerRole,
    memberCount: org.members.length,
    subTeamCount: org.subTeams.length,
    logoUrl: null,
  };
}

export function organizationDetail(org) {
  return {
    isPersonal: org.isPersonal,
    id: org.id,
    name: org.name,
    viewerRole: org.viewerRole,
    members: org.members.map(memberDto),
    subTeams: org.subTeams.map((team) => ({
      id: team.id,
      name: team.name,
      memberCount: org.members.filter((entry) =>
        entry.subTeamIds.includes(team.id),
      ).length,
    })),
    usageStatsMinRole: org.config.usageStatsMinRole,
    canViewUsageStats: viewerRoleClears(org, org.config.usageStatsMinRole),
    logoUrl: null,
    // A seeded organization may override its GitHub connection.
    githubConnection: org.githubConnection ?? {
      connected: false,
      accountLogin: null,
    },
    enforcedSync: clone(org.config.enforcedSync),
    enforceMemberDataSharing: org.config.enforceMemberDataSharing,
    allowExternalContainerSharing: org.config.allowExternalContainerSharing,
  };
}

/** `SettingsOrganizationBootstrap`, mirroring `loadOrganizationSettingsNavModel`. */
export function organizationBootstrap(org) {
  const canViewUsageStats = viewerRoleClears(org, org.config.usageStatsMinRole);
  const visibleTabs = ['feed'];
  if (canViewUsageStats) visibleTabs.push('statistics');
  if (!org.isPersonal) {
    visibleTabs.push('digests', 'members', 'groups', 'projects');
    if (canEditOrganization(org.viewerRole)) visibleTabs.push('memory');
    visibleTabs.push('settings');
  }
  const lapsed = org.lapsed !== null;
  return {
    id: org.id,
    name: org.name,
    viewerRole: org.viewerRole,
    isPersonal: org.isPersonal,
    visibleTabs,
    disabledTabs: lapsed
      ? visibleTabs.filter((tab) => !LAPSED_LIVE_TABS.has(tab))
      : [],
    billingNeedsAttention: lapsed,
    billingEnabled: true,
    memoryEnabled: !org.isPersonal,
    digestsEnabled: true,
    projectsEnabled: true,
    canViewUsageStats,
    freeAccess: true,
    githubConnected: org.githubConnection?.connected ?? false,
    lapse: lapsed ? clone(org.lapsed) : null,
  };
}

export function bootstrapPayload(state, organizationId) {
  const org =
    organizationId === undefined || !state.orgOrder.includes(organizationId)
      ? undefined
      : state.organizations[organizationId];
  return {
    version: 1,
    viewer: {
      id: state.viewerIdReported,
      email: state.viewer.email,
      name: state.profile.name,
      image: state.profile.image,
    },
    account: {
      aiGatewayEnabled: state.aiGatewayEnabled,
      billingEnabled: true,
      digestsEnabled: true,
      // `hostedSettings.integrationsEnabled: false` models a server with the
      // Cloud Git (Integrations) page off.
      integrationsEnabled: state.integrationsEnabled !== false,
      delegationEnabled: state.delegationEnabled === true,
      freeAccess: true,
    },
    organizations: state.orgOrder.map((id) => {
      const entry = state.organizations[id];
      return {
        id: entry.id,
        name: entry.name,
        logoUrl: null,
        role: entry.viewerRole,
        isPersonal: entry.isPersonal,
      };
    }),
    organization:
      org === undefined
        ? null
        : {
            ...organizationBootstrap(org),
            aiGatewayEnabled: state.aiGatewayEnabled,
          },
  };
}

/**
 * The organizations the viewer's lists show. Production's
 * `listOrganizationsForUser` leaves the personal organization out; the
 * settings bootstrap still carries it as a membership.
 */
export function visibleOrganizations(state) {
  return state.orgOrder
    .map((id) => state.organizations[id])
    .filter((org) => !org.isPersonal);
}

export function teamPageData(state, org) {
  return {
    detail: organizationDetail(org),
    organizations: state.orgOrder.map((id) =>
      organizationSummary(state.organizations[id]),
    ),
    viewerEmail: state.viewer.email,
    billingEnabled: true,
    memoryEnabled: !org.isPersonal,
    digestsEnabled: true,
    projectsEnabled: true,
    billingNeedsAttention: org.lapsed !== null,
    freeAccess: true,
    lapsed: clone(org.lapsed),
    mobileBrowser: false,
  };
}

/** `GET /api/account/model-catalog`: the catalog model policy names. */
export function modelCatalog() {
  return [
    {
      id: 'claude-sonnet-5-5',
      label: 'Claude Sonnet 5.5',
      description: 'Balanced model for everyday work.',
      recommendedHarness: 'claude',
    },
    {
      id: 'claude-opus-5-5',
      label: 'Claude Opus 5.5',
      description: 'Most capable model for complex work.',
      recommendedHarness: 'claude',
    },
    { id: 'gpt-fixture', label: 'GPT Fixture', recommendedHarness: 'codex' },
  ];
}

const SUBSCRIPTION_PLANS = [
  {
    planKey: 'anthropic:max',
    provider: 'anthropic',
    label: 'Claude Max',
    rawPlanTypes: ['max'],
    accountCount: 2,
    defaultMonthlyUsd: 200,
  },
  {
    planKey: 'openai:pro',
    provider: 'openai',
    label: 'ChatGPT Pro',
    rawPlanTypes: ['pro'],
    accountCount: 1,
    defaultMonthlyUsd: null,
  },
];

/** `.../subscription-pricing`, applying the org's saved overrides. */
export function subscriptionPricing(org) {
  const overrides = org.subscriptionPricingOverrides ?? {};
  return {
    canEdit: canEditOrganization(org.viewerRole),
    plans: SUBSCRIPTION_PLANS.map((plan) => {
      const override = overrides[plan.planKey] ?? null;
      return {
        ...plan,
        rawPlanTypes: [...plan.rawPlanTypes],
        overrideMonthlyUsd: override,
        effectiveMonthlyUsd: override ?? plan.defaultMonthlyUsd,
      };
    }),
  };
}

/** Fixed daily costs, so the usage charts render the same bars every run. */
const USAGE_DAILY_COST_USD = Object.freeze([
  4.2, 6.8, 3.1, 7.5, 5.4, 8.9, 2.6, 6.1, 7.9, 4.7,
]);

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `.../usage`: ten days of usage from the start of the requested range, with
 * headline cards and per-provider cost and token buckets. That fills the
 * statistics charts the way the `bars` loading skeleton anticipates.
 */
export function teamUsage({
  scope,
  teamId = null,
  userId = null,
  granularity = 'day',
  startIso,
  endIso,
}) {
  const startMs = Date.parse(startIso);
  const firstDayMs = Number.isNaN(startMs)
    ? Date.parse(HOSTED_SETTINGS_TIME)
    : startMs;
  const buckets = USAGE_DAILY_COST_USD.map((totalCostUsd, index) => ({
    bucketStartIso: new Date(firstDayMs + index * DAY_MS).toISOString(),
    totalCostUsd,
  }));
  const totalCostUsd = USAGE_DAILY_COST_USD.reduce(
    (sum, cost) => sum + cost,
    0,
  );
  const tokensForCost = (cost) => Math.round(cost * 10_000);
  const totalTokens = buckets.reduce(
    (sum, bucket) => sum + tokensForCost(bucket.totalCostUsd) * 2,
    0,
  );
  return {
    scope,
    teamId,
    range: { startIso, endIso, granularity },
    filterUserId: userId,
    headline: [
      {
        key: 'totalCostUsd',
        label: 'Total cost',
        value: Math.round(totalCostUsd * 100) / 100,
        previousValue: 48.3,
        unit: 'currency',
      },
      {
        key: 'totalTokens',
        label: 'Total tokens',
        value: totalTokens,
        previousValue: 980_000,
        unit: 'tokens',
      },
      {
        key: 'turns',
        label: 'Turns',
        value: 214,
        previousValue: 187,
        unit: 'count',
      },
    ],
    tokensByProvider: buckets.map((bucket) => ({
      bucketStartIso: bucket.bucketStartIso,
      key: 'claude',
      inputTokens: tokensForCost(bucket.totalCostUsd),
      outputTokens: tokensForCost(bucket.totalCostUsd),
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    })),
    tokensByModel: [],
    costByProvider: buckets.map((bucket) => ({ ...bucket, key: 'claude' })),
    costByModel: [],
    toolCategoryTotals: [
      { toolCategory: 'bash', total: 96 },
      { toolCategory: 'edit', total: 71 },
      { toolCategory: 'read', total: 132 },
    ],
    eventTypeStatusCounts: [
      { eventType: 'worktree_chat', status: 'success', count: 198 },
      { eventType: 'worktree_chat', status: 'failure', count: 16 },
    ],
    byUser: [],
    impactByUser: [],
    pipelines: [],
    mostExpensiveRuns: [],
  };
}

/* -------------------------------------------------------------------------- */
/* Account fixtures                                                            */
/* -------------------------------------------------------------------------- */

export function defaultPublicProfile() {
  return {
    username: 'portal-e2e',
    enabled: false,
    bio: null,
    links: [],
    showCost: false,
    showHeatmap: true,
  };
}

export function defaultDigestPreferences() {
  return {
    daily: false,
    weekly: true,
    monthly: false,
    weeklyAnchorDay: 1,
    monthlyAnchorDay: 1,
  };
}

export function defaultApiKeys() {
  return [
    {
      id: 'api-key-e2e-desktop',
      name: 'Desktop app',
      source: 'desktop',
      createdIp: null,
      createdAt: EARLIER,
      lastUsedAt: HOSTED_SETTINGS_TIME,
    },
  ];
}

export function authSources(state) {
  return {
    user: {
      name: state.profile.name,
      email: state.viewer.email,
      twoFactorEnabled: state.twoFactorUser,
    },
    sources: [
      {
        providerId: 'credential',
        accountId: 'credential-e2e',
        label: 'Email and password',
        linkedAt: EARLIER,
        canUnlink: false,
      },
    ],
  };
}

export function gitHubConnection() {
  return {
    state: 'DISCONNECTED',
    githubLogin: null,
    verifiedAt: null,
    readyForProjects: false,
    targets: [],
  };
}

export function digestArchiveItem(overrides = {}) {
  return {
    externalId: HOSTED_SETTINGS_DIGEST_ID,
    cadence: 'WEEKLY',
    periodStart: '2026-09-21T00:00:00.000Z',
    periodEnd: '2026-09-28T00:00:00.000Z',
    headline: 'A quiet fixture week',
    variant: 'FULL',
    status: 'READY',
    billedCredits: null,
    createdAt: '2026-09-28T01:00:00.000Z',
    ...overrides,
  };
}

export function digestReport(overrides = {}) {
  return {
    externalId: HOSTED_SETTINGS_DIGEST_ID,
    subjectType: 'USER',
    cadence: 'WEEKLY',
    periodStart: '2026-09-21T00:00:00.000Z',
    periodEnd: '2026-09-28T00:00:00.000Z',
    headline: 'A quiet fixture week',
    executiveSummaryMarkdown: 'Fixture summary.',
    bodyMarkdown: '## Fixture\n\nNothing notable happened.',
    variant: 'FULL',
    ...overrides,
  };
}

export function digestRequestCredits() {
  return {
    spendable: true,
    balanceCredits: 1200,
    fundingKey: 0,
    fundingLabel: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Billing (non-payment reads only)                                            */
/* -------------------------------------------------------------------------- */

export function billingSummary({ organization = false, lapsed = false } = {}) {
  return {
    pendingCancellation: null,
    plan: organization
      ? { key: 'team', displayName: 'Team', billingModel: 'PER_SEAT' }
      : { key: 'individual', displayName: 'Individual', billingModel: 'FLAT' },
    status: lapsed ? 'CANCELED' : 'ACTIVE',
    trial: null,
    nextBillingDate: lapsed ? null : LATER,
    nextBillingAmountUsd: lapsed ? null : 20,
    seatCount: organization ? 3 : null,
    paymentMethod: {
      brand: 'visa',
      last4: '4242',
      expMonth: 12,
      expYear: 2030,
    },
    walletBalanceUsd: 0,
    capabilities: [],
    coverageNotes: [],
  };
}

export function creditsSummary() {
  return {
    balanceCredits: 1200,
    balanceUsd: 12,
    split: {
      dripCredits: '0',
      allotmentCredits: '1200',
      purchasedCredits: '0',
    },
    allotmentTotalCredits: 2000,
    dailyDripCapCredits: 0,
    nextRefillAt: null,
    nextAllotmentAt: LATER,
    autoTopUp: {
      enabled: false,
      amountUsd: null,
      thresholdCredits: null,
      maxMonthlyUsd: null,
      disabledReason: null,
    },
    monthlySpentUsd: 8,
    usagePeriodStart: HOSTED_SETTINGS_TIME,
    usagePeriodEnd: LATER,
    usagePeriodKind: 'billing-cycle',
    monthlyResetAt: LATER,
    activeSource: 'canopy',
    udLinked: false,
  };
}

function invoiceListItem() {
  return {
    id: HOSTED_SETTINGS_INVOICE_ID,
    number: 'INV-20260901',
    issuedAt: '2026-09-01T00:00:00.000Z',
    periodStart: '2026-09-01T00:00:00.000Z',
    periodEnd: '2026-10-01T00:00:00.000Z',
    currency: 'usd',
    status: 'PAID',
    isCurrent: false,
    totalUsd: 20,
    amountPaidUsd: 20,
    amountRefundedUsd: 0,
    lineItemCount: 1,
    cardBrand: 'visa',
    cardLast4: '4242',
  };
}

export function invoicePage() {
  return { invoices: [invoiceListItem()], nextCursor: null };
}

export function invoiceDetail({ organizationName = null, email = null } = {}) {
  return {
    id: HOSTED_SETTINGS_INVOICE_ID,
    number: 'INV-20260901',
    issuedAt: '2026-09-01T00:00:00.000Z',
    periodStart: '2026-09-01T00:00:00.000Z',
    periodEnd: '2026-10-01T00:00:00.000Z',
    currency: 'usd',
    status: 'PAID',
    isCurrent: false,
    billTo:
      organizationName === null
        ? { kind: 'user', name: HOSTED_SETTINGS_VIEWER.name, email }
        : { kind: 'organization', name: organizationName, email: null },
    lineItems: [
      {
        id: 'line-e2e-1',
        description: 'Subscription',
        amountUsd: 20,
      },
    ],
    subtotalUsd: 20,
    taxUsd: 0,
    totalUsd: 20,
    amountPaidUsd: 20,
    amountRefundedUsd: 0,
    credits: {
      usageGroups: [],
      totalUsedCredits: 0,
      addedGroups: [],
      totalAddedCredits: 0,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Memory explorer                                                             */
/* -------------------------------------------------------------------------- */

export function factDetail(entry) {
  return {
    ...clone(entry),
    sources: [
      {
        id: 'source-e2e-1',
        transcriptTurnId: null,
        referenceTime: EARLIER,
        actor: {
          id: HOSTED_SETTINGS_VIEWER.id,
          name: HOSTED_SETTINGS_VIEWER.name,
          email: HOSTED_SETTINGS_VIEWER.email,
        },
      },
    ],
    supersessionChain: [],
  };
}

function memoryOps() {
  return {
    jobs: [
      {
        id: 'ingest-job-e2e-1',
        status: 'DONE',
        attempts: 1,
        heartbeatStale: false,
        lastError: null,
        createdAt: EARLIER,
        updatedAt: HOSTED_SETTINGS_TIME,
      },
    ],
    counts: { PENDING: 0, RUNNING: 0, DONE: 1, FAILED: 0, DEAD: 0 },
    searchEntries: [
      {
        id: 'search-e2e-1',
        query: 'deploy branch',
        queryDecryptFailed: false,
        injectedFacts: [],
        gatePassed: true,
        truncated: false,
        latencyMs: 12,
        createdAt: HOSTED_SETTINGS_TIME,
        user: {
          id: HOSTED_SETTINGS_VIEWER.id,
          name: HOSTED_SETTINGS_VIEWER.name,
          email: HOSTED_SETTINGS_VIEWER.email,
        },
      },
    ],
    config: {
      embedderId: 'fixture-embedder',
      rerankerId: 'fixture-reranker',
      tauRerank: null,
      tauCosine: null,
      efSearch: 64,
      triageModel: 'fixture-model',
      distillModel: 'fixture-model',
      judgeModel: 'fixture-model',
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Feed                                                                        */
/* -------------------------------------------------------------------------- */

/** A `pr_opened` `FeedItem`; overrides merge over the defaults. */
export function feedItem(overrides = {}) {
  const id = overrides.id ?? HOSTED_SETTINGS_FEED_ITEM_ID;
  return {
    id,
    type: 'pr_opened',
    occurredAt: HOSTED_SETTINGS_TIME,
    actor: {
      userId: HOSTED_SETTINGS_TEAMMATES.avery.id,
      displayName: HOSTED_SETTINGS_TEAMMATES.avery.name,
    },
    worktreeId: null,
    repoName: 'example-org/build-service',
    prNumber: 42,
    prUrl: 'https://github.com/example-org/build-service/pull/42',
    title: `Fixture pull request ${id}`,
    branchName: 'fixture-branch',
    checkStatus: 'passing',
    reviewStatus: 'pending',
    hasConflicts: false,
    commentCount: 0,
    summary: null,
    ...overrides,
  };
}

/**
 * `count` feed items an hour apart, oldest first (the order the feed appends
 * them), so the Timeline tab is long enough to scroll.
 */
export function timelineFeedItems(count) {
  const newestMs = Date.parse(HOSTED_SETTINGS_TIME);
  return Array.from({ length: count }, (_, index) =>
    feedItem({
      id: `feed-e2e-timeline-${index + 1}`,
      occurredAt: new Date(
        newestMs - (count - index) * 60 * 60 * 1000,
      ).toISOString(),
      prNumber: 100 + index,
      prUrl: `https://github.com/example-org/build-service/pull/${100 + index}`,
      title: `Fixture pull request ${index + 1} of ${count}`,
    }),
  );
}

/** One SSE frame: `id: <seq>\nevent: feed.item\ndata: <RealtimeFeedEnvelope>\n\n`. */
export function formatFeedFrame(event) {
  const envelope = {
    type: 'feed.item',
    eventId: event.eventId,
    occurredAt: event.occurredAt,
    sequence: event.sequence,
    payload: event.item,
  };
  return `id: ${event.sequence}\nevent: feed.item\ndata: ${JSON.stringify(envelope)}\n\n`;
}

/* -------------------------------------------------------------------------- */
/* Page data                                                                   */
/* -------------------------------------------------------------------------- */

const ACCOUNT_PAGES = new Set([
  'account',
  'profile',
  'digests',
  'notifications',
  'integrations',
  'plugins',
  'mcp',
  'delegation',
  'security',
  'ai-gateway',
  'billing',
  'labs',
  'appearance',
]);

function isRouteId(value) {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/.test(value) &&
    !value.includes('..')
  );
}

/**
 * The page-data kind for a route, mirroring `settingsPageDataKindForRoute`.
 * Returns `null` for a route the real `settingsRouteSchema` would reject at
 * the level this mock checks (scope, page, ids).
 */
export function pageDataKindForRoute(route) {
  if (route === null || typeof route !== 'object' || Array.isArray(route)) {
    return null;
  }
  if (route.scope === 'organizations') return 'organization.list';
  if (route.scope === 'account') {
    if (!ACCOUNT_PAGES.has(route.page)) return null;
    if (route.page === 'digests' && route.digestId !== undefined) {
      return isRouteId(route.digestId) ? 'account.digest' : null;
    }
    if (route.page === 'billing' && route.invoiceId !== undefined) {
      return isRouteId(route.invoiceId) ? 'account.invoice' : null;
    }
    return `account.${route.page}`;
  }
  if (route.scope !== 'organization' || !isRouteId(route.organizationId)) {
    return null;
  }
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
    case 'settings':
      return route.invoiceId === undefined
        ? 'organization.settings'
        : 'organization.invoice';
    default:
      return null;
  }
}

/** Every page-data kind, for tests that cover the whole union. */
export const HOSTED_SETTINGS_PAGE_DATA_ROUTES = Object.freeze([
  { scope: 'account', page: 'account' },
  { scope: 'account', page: 'profile' },
  { scope: 'account', page: 'digests' },
  { scope: 'account', page: 'digests', digestId: HOSTED_SETTINGS_DIGEST_ID },
  { scope: 'account', page: 'notifications' },
  { scope: 'account', page: 'integrations' },
  { scope: 'account', page: 'plugins' },
  { scope: 'account', page: 'mcp' },
  { scope: 'account', page: 'delegation' },
  { scope: 'account', page: 'security' },
  { scope: 'account', page: 'billing' },
  { scope: 'account', page: 'billing', invoiceId: HOSTED_SETTINGS_INVOICE_ID },
  { scope: 'account', page: 'labs' },
  { scope: 'account', page: 'appearance' },
  { scope: 'organizations' },
  ...[
    { page: 'feed' },
    { page: 'feed', itemId: HOSTED_SETTINGS_FEED_ITEM_ID },
    { page: 'statistics' },
    { page: 'digests' },
    { page: 'digests', digestId: HOSTED_SETTINGS_DIGEST_ID },
    { page: 'members' },
    { page: 'members', userId: HOSTED_SETTINGS_TEAMMATES.avery.id },
    {
      page: 'members',
      userId: HOSTED_SETTINGS_TEAMMATES.avery.id,
      digestId: HOSTED_SETTINGS_DIGEST_ID,
    },
    { page: 'groups' },
    { page: 'projects' },
    { page: 'memory' },
    { page: 'memory', memoryView: 'graph' },
    { page: 'memory', memoryView: 'ops' },
    { page: 'memory', factId: HOSTED_SETTINGS_FACT_ID },
    { page: 'settings' },
    {
      page: 'settings',
      subtab: 'billing',
      invoiceId: HOSTED_SETTINGS_INVOICE_ID,
    },
  ].map((route) => ({
    scope: 'organization',
    organizationId: HOSTED_SETTINGS_ORG_IDS.owner,
    ...route,
  })),
]);

/** `{ status, body }` failure, or `{ data }` for a page-data kind. */
function notFound() {
  return { status: 404, body: { error: 'Not found' } };
}

function forbidden() {
  return { status: 403, body: { error: 'Forbidden' } };
}

function accountPageData(state, kind, route) {
  switch (kind) {
    case 'account.ai-gateway':
      return state.aiGatewayEnabled
        ? {
            data: {
              organizationId: HOSTED_SETTINGS_ORG_IDS.personal,
              gateway: clone(state.personalGateway),
            },
          }
        : notFound();
    case 'account.account':
      return {
        data: {
          initialName: state.profile.name,
          initialImage: state.profile.image,
          role: 'user',
          email: state.viewer.email,
        },
      };
    case 'account.profile':
      return {
        data: {
          initialSettings: clone(state.publicProfile),
          displayName: state.profile.name,
          avatarUrl: state.profile.image,
        },
      };
    case 'account.digests':
      return {
        data: {
          digests: [digestArchiveItem()],
          billing: { status: 'ok', billing: digestRequestCredits() },
        },
      };
    case 'account.digest':
      if (route.digestId !== HOSTED_SETTINGS_DIGEST_ID) return notFound();
      return {
        data: {
          digest: digestReport(),
          audiences: visibleOrganizations(state).map((org) => ({
            organizationId: org.id,
            organizationName: org.name,
            featured: false,
            lapsed: org.lapsed !== null,
          })),
          neighbors: { olderDigestId: null, newerDigestId: null },
        },
      };
    case 'account.notifications':
      return { data: {} };
    // Desktop opens Labs in its own section; the kind still loads like web's.
    case 'account.labs':
      return { data: {} };
    // Desktop opens these in its own sections; the kinds still load like web's.
    case 'account.plugins':
    case 'account.mcp':
      return { data: {} };
    // Desktop keeps Chat detail under Display; the kind still loads like web's.
    case 'account.appearance':
      return { data: {} };
    // The page loads its limits through account.settings.delegation.read;
    // like the web page, it is not found while delegation is off.
    case 'account.delegation':
      if (state.delegationEnabled !== true) return null;
      return { data: {} };
    case 'account.integrations':
      // The web page guard 404s while the server's Integrations flag is off.
      if (state.integrationsEnabled === false) return null;
      return { data: { userId: state.viewer.id } };
    case 'account.security':
      return {
        data: {
          brandDisplayName: state.brandDisplayName,
          emailPasswordAuthEnabled: true,
        },
      };
    case 'account.billing':
      return {
        data: {
          orgs: visibleOrganizations(state).map((org) => ({
            id: org.id,
            name: org.name,
            canManageBilling: canEditOrganization(org.viewerRole),
          })),
          orgCovered: false,
          chrome: {
            planDisplayName: 'Individual',
            trial: null,
            hasPaymentMethod: true,
          },
          freeAccess: true,
        },
      };
    case 'account.invoice':
      if (route.invoiceId !== HOSTED_SETTINGS_INVOICE_ID) return notFound();
      return {
        data: { invoice: invoiceDetail({ email: state.viewer.email }) },
      };
    default:
      return null;
  }
}

/** Memory pages carry the team header, as `loadMemoryPageData` serves it. */
function memoryPage(state, org, build) {
  if (!canEditOrganization(org.viewerRole)) return forbidden();
  const team = teamPageData(state, org);
  if (org.isPersonal) return { data: { team, enabled: false } };
  return { data: { team, enabled: true, ...build() } };
}

function organizationPageData(state, kind, route, feedItems) {
  if (kind === 'organization.list') {
    return {
      data: {
        organizations: visibleOrganizations(state).map(organizationSummary),
        invitations: clone(state.incomingInvitations),
      },
    };
  }
  const org = state.organizations[route.organizationId];
  if (!state.orgOrder.includes(route.organizationId)) return notFound();
  const canEdit = canEditOrganization(org.viewerRole);
  switch (kind) {
    case 'organization.feed':
    case 'organization.statistics':
    case 'organization.members':
    case 'organization.groups':
    case 'organization.projects':
    case 'organization.settings':
      if (
        route.subtab === 'ai-gateway' &&
        (!state.aiGatewayEnabled || !canEdit)
      )
        return notFound();
      return {
        data: {
          ...teamPageData(state, org),
          aiGatewayEnabled: state.aiGatewayEnabled,
        },
      };
    case 'organization.feedItem':
      if (!feedItems.some((item) => item.id === route.itemId))
        return notFound();
      return {
        data: { ...teamPageData(state, org), highlightItemId: route.itemId },
      };
    case 'organization.digests':
      return {
        data: {
          ...teamPageData(state, org),
          archive:
            org.lapsed === null
              ? {
                  digests: [digestArchiveItem({ subjectType: 'ORGANIZATION' })],
                  request: canEdit
                    ? { status: 'ok', credits: digestRequestCredits() }
                    : null,
                }
              : null,
        },
      };
    case 'organization.digest':
      if (route.digestId !== HOSTED_SETTINGS_DIGEST_ID) return notFound();
      return {
        data: {
          organization: {
            id: org.id,
            name: org.name,
            viewerRole: org.viewerRole,
          },
          canEdit,
          lapsed: clone(org.lapsed),
          report:
            org.lapsed === null
              ? {
                  digest: digestReport({
                    subjectType: 'ORGANIZATION',
                    sharingEnabled: false,
                  }),
                  neighbors: { olderId: null, newerId: null },
                  share: canEdit
                    ? { sharePath: '/d/fixture-share', sharingEnabled: false }
                    : null,
                }
              : null,
        },
      };
    case 'organization.member':
    case 'organization.memberDigest': {
      const subject = org.members.find((entry) => entry.id === route.userId);
      if (subject === undefined) return notFound();
      if (kind === 'organization.memberDigest') {
        if (route.digestId !== HOSTED_SETTINGS_DIGEST_ID) return notFound();
        return {
          data: {
            org: { id: org.id, name: org.name },
            member: { id: subject.id, name: subject.name },
            digest: digestReport(),
            neighbors: { olderId: null, newerId: null },
          },
        };
      }
      const isOwnProfile = subject.id === state.viewer.id;
      return {
        data: {
          org: { id: org.id, name: org.name },
          member: {
            id: subject.id,
            name: subject.name,
            email: subject.email,
            image: subject.image,
            role: subject.role,
            memberSinceIso: subject.memberSince,
          },
          viewerCanViewStats: viewerRoleClears(
            org,
            org.config.usageStatsMinRole,
          ),
          editContext: isOwnProfile
            ? { mode: 'self' }
            : canEdit
              ? { mode: 'org-member', orgId: org.id, userId: subject.id }
              : null,
          orgLapsed: org.lapsed !== null,
          orgTrialEndedAt: org.lapsed?.trialEndedAt ?? null,
          orgLapseReason: org.lapsed?.lapseReason ?? null,
          requiredPlanName: org.lapsed?.requiredPlanName ?? null,
          viewerCanEditOrg: canEdit,
          showDigestsTab: true,
          isOwnProfile,
          mobileBrowser: false,
        },
      };
    }
    case 'organization.memory.facts':
      return memoryPage(state, org, () => ({
        initialFacts: clone(org.facts),
        initialNextCursor: null,
      }));
    case 'organization.memory.graph':
      return memoryPage(state, org, () => ({}));
    case 'organization.memory.ops':
      return memoryPage(state, org, memoryOps);
    case 'organization.memory.fact': {
      const entry = org.facts.find(
        (candidate) => candidate.id === route.factId,
      );
      if (entry === undefined && canEdit && !org.isPersonal) return notFound();
      return memoryPage(state, org, () => ({
        detail: factDetail(entry),
        transcript: null,
      }));
    }
    case 'organization.invoice':
      if (!canEdit) return forbidden();
      if (route.invoiceId !== HOSTED_SETTINGS_INVOICE_ID) return notFound();
      return {
        data: { invoice: invoiceDetail({ organizationName: org.name }) },
      };
    default:
      return null;
  }
}

/**
 * Page data for a route: `{ status: 200, body: { kind, data } }`, or the
 * failure the web loader would produce.
 */
export function pageDataResponse(state, route, feedItems = []) {
  const kind = pageDataKindForRoute(route);
  if (kind === null) {
    return { status: 400, body: { error: 'Invalid settings route' } };
  }
  const result = kind.startsWith('account.')
    ? accountPageData(state, kind, route)
    : organizationPageData(state, kind, route, feedItems);
  if (result === null) return notFound();
  if (result.data === undefined) return result;
  return { status: 200, body: { kind, data: result.data } };
}
