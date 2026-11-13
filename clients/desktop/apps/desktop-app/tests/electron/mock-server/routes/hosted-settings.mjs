// Hosted account and organization settings surface (desktop settings bridge).
//
// Serves what `apps/desktop-app/src/main/canopy-cloud/settings-session.ts`
// and `settings-client.ts` call, so Electron specs can drive hosted settings
// through the real bridge:
//
//   POST /api/v1/<ns>/auth-link                (Bearer `csk_`) → { url }
//   GET  /api/v1/<ns>/auth-link/consume?code=  → 303 + Set-Cookie session
//   GET  /api/v1/settings/bootstrap[?organizationId=]
//   POST /api/v1/settings/page-data            { route }
//   the `SETTINGS_OPERATIONS` entries listed in OPERATION_ROUTES below
//   POST /api/auth/sign-out                    (bridge disposal)
//   GET  /api/account/organizations/:id/stream (feed SSE, `Last-Event-ID`)
//
// Opt-in: a key without a `hostedSettings` scenario slice is never answered
// here. Its auth-link mint falls through to `routes/cloud.mjs` unchanged, so
// existing specs keep their behavior. Everything after the mint is
// authenticated by the minted session cookie, not the Bearer key: a request
// without a live session cookie gets 401. The cookie resolves to the scenario
// key through this module's session table.
//
// Every keyed request is recorded in order (`GET /__mock/hosted-settings/
// :key/requests`) and counted in `GET /__mock/activity/:key` as
// `hostedSettings:<operation>`, so specs can assert which table entries the
// desktop called and that it never reached a financial or unknown route.
//
// Control routes (JSON bodies):
//
//   GET  /__mock/hosted-settings/:key/requests       → request log and counters
//   GET  /__mock/hosted-settings/:key/state          → current server data
//   POST /__mock/hosted-settings/:key/sessions/expire → every session answers 401
//   POST /__mock/hosted-settings/:key/feed           { organizationId?, items }
//   POST /__mock/hosted-settings/:key/feed/close     { organizationId? }
//   GET  /__mock/hosted-settings-unauthenticated     → requests with no session
//
// Scenario slice (all optional; see ./README.md):
//
//   hostedSettings: {
//     mint: 'ok' | 'two-factor-pending' | 'rate-limited' | { status, body }
//           | [ ...one per mint attempt, the last repeats ],
//     retryAfterSeconds: 60,
//     consume: 'ok' | 'login',
//     twoFactorUser: false,        // consume also sets the proof cookie
//     bootstrap: 'ok' | 'unsupported' | 'viewer-mismatch',
//     integrationsEnabled: true,   // false: bootstrap reports Integrations
//                                  // off and its page data answers 404
//     viewer: { id?, name?, email? },
//     incomingInvitations: [...],  // { id, organization, role, invitedByName, createdAt, expiresAt }
//     organizations: [...],        // defaultHostedSettingsOrganizations() shape
//     brandDisplayName: 'Canopy',
//     cloudGatewayKeys: { '<organizationId>': 'none' | 'saved' | ... },
//                                  // cloud chat key statuses; absent: 404
//     operationErrors: { '<operation>': { status, body? } },
//     operationDelaysMs: { '<operation>': ms },
//     feed: {
//       organizationId,            // default: the team the viewer owns
//       items: [...],              // already in the feed (feed.page)
//       scriptedItems: [...],      // appended when the first stream opens
//       dropAfterScripted: false,  // end the first stream after them
//       reconnect: 'allow' | 'unauthorized' | 'forbidden',
//       stream: 'enabled' | 'disabled',
//     },
//   }

import { randomUUID } from 'node:crypto';
import {
  DEFAULT_SCENARIO,
  getScenario,
  keyFromBearer,
  recordScenarioActivity,
} from '../control-plane.mjs';
import { CLOUD_ACCOUNT } from './cloud.mjs';
import {
  HOSTED_SETTINGS_ORG_IDS,
  HOSTED_SETTINGS_PASSWORD,
  HOSTED_SETTINGS_TIME,
  authSources,
  billingSummary,
  bootstrapPayload,
  canEditOrganization,
  clone,
  creditsSummary,
  defaultApiKeys,
  defaultDigestPreferences,
  defaultHostedSettingsOrganizations,
  defaultPublicProfile,
  factDetail,
  feedItem,
  formatFeedFrame,
  gitHubConnection,
  invoicePage,
  organizationDetail,
  organizationSummary,
  modelCatalog,
  pageDataResponse,
  subscriptionPricing,
  teamUsage,
  visibleOrganizations,
} from './hosted-settings-fixtures.mjs';

/** Two card charges, so the Billing history table has rows to show. */
const ACCOUNT_BILLING_CHARGES = Object.freeze([
  {
    id: 'chg_mock_topup',
    kind: 'CREDIT_TOP_UP',
    status: 'SUCCEEDED',
    amountUsd: 25,
    amountRefundedUsd: 0,
    currency: 'usd',
    description: 'AI credits top-up',
    seatCount: null,
    periodStart: null,
    periodEnd: null,
    cardBrand: 'visa',
    cardLast4: '4242',
    createdAt: '2026-10-02T09:00:00.000Z',
  },
  {
    id: 'chg_mock_renewal',
    kind: 'SUBSCRIPTION_RENEWAL',
    status: 'SUCCEEDED',
    amountUsd: 20,
    amountRefundedUsd: 0,
    currency: 'usd',
    description: 'Pro plan',
    seatCount: 1,
    periodStart: '2026-10-01T00:00:00.000Z',
    periodEnd: '2026-11-01T00:00:00.000Z',
    cardBrand: 'visa',
    cardLast4: '4242',
    createdAt: '2026-10-01T09:00:00.000Z',
  },
]);

/** Better Auth's default session cookie name (no prefix configured on web). */
export const HOSTED_SETTINGS_SESSION_COOKIE = 'better-auth.session_token';
/** `TWO_FACTOR_VERIFIED_COOKIE` in `apps/web/src/lib/account-api-contracts.ts`. */
export const HOSTED_SETTINGS_TWO_FACTOR_COOKIE = 'canopy.two_factor_verified';

const MINT_PATH = /^\/api\/v1\/([^/]+)\/auth-link$/;
const CONSUME_PATH = /^\/api\/v1\/([^/]+)\/auth-link\/consume$/;
const CONTROL_PATH = /^\/__mock\/hosted-settings\/([^/]+)(\/.*)?$/;
const UNAUTHENTICATED_LOG_PATH = '/__mock/hosted-settings-unauthenticated';
const SESSION_PATH_PREFIXES = [
  '/api/v1/settings/',
  '/api/account/',
  '/api/auth/',
  '/api/cloud/github/',
];
/**
 * Payment routes the table deliberately omits (setup intents, card mutation,
 * charging, automatic top-up, subscription mutation and plan-change quotes).
 * They are answered 404 and flagged `financial: true` in the request log.
 */
const FINANCIAL_PATH =
  /\/billing\/(?:setup-intent|payment-method|subscription|credits\/(?:top-up|auto-top-up))(?:\/|$)|\/invites\/seat-quote(?:\/|$)/;
const STREAM_POLL_MS = 50;
const STREAM_RETRY_ADVICE_MS = 1_000;
const UNAUTHENTICATED_LOG_CAP = 200;

/** code → scenario key; single use. */
const codeOwners = new Map();
/** session token → scenario key. */
const sessionOwners = new Map();
/** Requests to session routes that carried no known session cookie. */
const unauthenticatedRequests = [];

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

function readRawBody(request) {
  return new Promise((resolve) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => resolve(raw));
    request.on('error', () => resolve(''));
  });
}

/** `undefined` for an empty body, `null` for malformed JSON. */
async function readJsonBody(request) {
  const raw = await readRawBody(request);
  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function header(request, name) {
  const raw = request.headers?.[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

function parseCookies(request) {
  const cookies = {};
  for (const pair of (header(request, 'cookie') ?? '').split(';')) {
    const index = pair.indexOf('=');
    if (index === -1) continue;
    const name = pair.slice(0, index).trim();
    if (name) cookies[name] = pair.slice(index + 1).trim();
  }
  return cookies;
}

/** The trusted web origin, like Better Auth's `baseURL`: this server. */
function requestOrigin(request, url) {
  const host = header(request, 'host');
  return host ? `http://${host}` : url.origin;
}

function sessionToken(request) {
  const value = parseCookies(request)[HOSTED_SETTINGS_SESSION_COOKIE];
  if (!value) return undefined;
  return decodeURIComponent(value).split('.')[0] || undefined;
}

/* -------------------------------------------------------------------------- */
/* Per-key state                                                               */
/* -------------------------------------------------------------------------- */

function emptyFeed() {
  return {
    events: [],
    nextSequence: 1,
    connections: 0,
    openStreams: 0,
    lastEventIds: [],
    scriptedPending: [],
    enders: new Set(),
  };
}

function appendFeedEvent(feed, item) {
  const sequence = feed.nextSequence;
  feed.nextSequence += 1;
  const event = {
    sequence,
    eventId: `mock-feed-event-${sequence}-${item.id}`,
    occurredAt: item.occurredAt ?? HOSTED_SETTINGS_TIME,
    item: clone(item),
  };
  feed.events.push(event);
  return event;
}

function initialState(config, scenario) {
  const accountOverride = isRecord(scenario.cloud?.account)
    ? scenario.cloud.account
    : {};
  const viewer = {
    id: accountOverride.id ?? CLOUD_ACCOUNT.id,
    name: accountOverride.name ?? CLOUD_ACCOUNT.name,
    email: accountOverride.email ?? CLOUD_ACCOUNT.email,
    ...(isRecord(config.viewer) ? config.viewer : {}),
  };
  const organizations = {};
  const orgOrder = [];
  for (const org of clone(
    config.organizations ?? defaultHostedSettingsOrganizations(viewer),
  )) {
    organizations[org.id] = org;
    orgOrder.push(org.id);
  }
  const feeds = {};
  for (const id of orgOrder) feeds[id] = emptyFeed();
  const feedConfig = isRecord(config.feed) ? config.feed : {};
  const feedOrgId = feedConfig.organizationId ?? HOSTED_SETTINGS_ORG_IDS.owner;
  const seededFeed = feeds[feedOrgId];
  if (seededFeed !== undefined) {
    for (const item of feedConfig.items ?? [feedItem()]) {
      appendFeedEvent(seededFeed, item);
    }
    seededFeed.scriptedPending = clone(feedConfig.scriptedItems ?? []);
  }
  const incomingInvitations = clone(config.incomingInvitations ?? []).map(
    ({ organization, ...invitation }) => {
      if (organizations[organization.id] === undefined) {
        organizations[organization.id] = { ...organization, viewerRole: null };
        feeds[organization.id] = emptyFeed();
      }
      return {
        ...invitation,
        organizationId: organization.id,
        organizationName: organization.name,
        organizationTeamName: invitation.organizationTeamName ?? null,
      };
    },
  );
  return {
    incomingInvitations,
    aiGatewayEnabled: config.aiGatewayEnabled === true,
    personalGateway: clone(config.personalGateway ?? null),
    cloudGatewayKeys: clone(config.cloudGatewayKeys ?? null),
    gatewayRevision: 0,
    viewer,
    viewerIdReported:
      config.bootstrap === 'viewer-mismatch'
        ? `${viewer.id}-mismatch`
        : viewer.id,
    brandDisplayName: config.brandDisplayName ?? 'Canopy',
    integrationsEnabled: config.integrationsEnabled !== false,
    twoFactorUser: config.twoFactorUser === true,
    password: HOSTED_SETTINGS_PASSWORD,
    profile: { name: viewer.name, image: null },
    publicProfile: defaultPublicProfile(),
    digestPreferences: defaultDigestPreferences(),
    pushPreferences: { pushEnabled: false },
    apiKeys: defaultApiKeys(),
    invites: clone(config.invites ?? []),
    organizations,
    orgOrder,
    feeds,
    codes: new Map(),
    sessions: new Set(),
    proofs: new Set(),
    nextId: 1,
    requests: [],
    mints: [],
    consumes: [],
    signOuts: 0,
  };
}

/**
 * Runtime state for `key`, or `null` when the key has no `hostedSettings`
 * slice. The frozen default scenario is never mutated; re-registering a key
 * drops its state (and so every session minted for it).
 */
function stateForKey(key) {
  const scenario = getScenario(key);
  if (scenario === DEFAULT_SCENARIO || !isRecord(scenario?.hostedSettings)) {
    return null;
  }
  scenario.hostedSettingsState ??= initialState(
    scenario.hostedSettings,
    scenario,
  );
  return scenario.hostedSettingsState;
}

/** Mirror membership changes into the existing account-probe fixture. */
function synchronizeCloudMembership(ctx) {
  const scenario = getScenario(ctx.key);
  const cloud = (scenario.cloud ??= {});
  const memberships = ctx.state.orgOrder
    .map((id) => ctx.state.organizations[id])
    .filter((org) => !org.isPersonal);
  const previous = new Map(
    (cloud.organizations ?? []).map((org) => [org.id, org]),
  );
  const unrelated = [...previous.values()].filter(
    (org) => ctx.state.organizations[org.id] === undefined,
  );
  cloud.organizations = [
    ...unrelated,
    ...memberships.map((org) => ({
      ...previous.get(org.id),
      id: org.id,
      name: org.name,
      role: org.viewerRole,
      createdAt: previous.get(org.id)?.createdAt ?? HOSTED_SETTINGS_TIME,
      updatedAt: previous.get(org.id)?.updatedAt ?? HOSTED_SETTINGS_TIME,
    })),
  ];
  const billing = new Map(
    (cloud.orgBillingStates ?? []).map((entry) => [
      entry.organizationId,
      entry,
    ]),
  );
  cloud.orgBillingStates = [
    ...[...billing.values()].filter((entry) =>
      unrelated.some((org) => org.id === entry.organizationId),
    ),
    ...memberships.map((org) => ({
      ...billing.get(org.id),
      organizationId: org.id,
      organizationName: org.name,
      teamsEntitled: billing.get(org.id)?.teamsEntitled ?? org.lapsed === null,
    })),
  ];
}

function endOrganizationStreams(state, id) {
  for (const end of Array.from(state.feeds[id]?.enders ?? [])) end();
}

function configForKey(key) {
  return getScenario(key)?.hostedSettings ?? {};
}

function nextId(state, prefix) {
  const id = state.nextId;
  state.nextId += 1;
  return `${prefix}${String(id).padStart(12, '0')}`;
}

/* -------------------------------------------------------------------------- */
/* Request context                                                             */
/* -------------------------------------------------------------------------- */

function createContext(request, response, url, key, state) {
  const entry = {
    seq: state ? state.requests.length + 1 : unauthenticatedRequests.length + 1,
    at: new Date().toISOString(),
    method: request.method,
    path: `${url.pathname}${url.search}`,
    operation: null,
    authenticated: false,
    origin: header(request, 'origin') ?? null,
    lastEventId: header(request, 'last-event-id') ?? null,
    financial: false,
    body: undefined,
    status: null,
  };
  if (state) state.requests.push(entry);
  return { request, response, url, key, state, entry };
}

function respond(ctx, status, body, headers = {}) {
  ctx.entry.status = status;
  ctx.response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    ...headers,
  });
  ctx.response.end(body === undefined ? '' : JSON.stringify(body));
}

function recordOperation(ctx, operation) {
  ctx.entry.operation = operation;
  recordScenarioActivity(ctx.key, `hostedSettings:${operation}`);
}

/* -------------------------------------------------------------------------- */
/* Auth link: mint and consume                                                 */
/* -------------------------------------------------------------------------- */

function mintBehavior(config, attempt) {
  const mint = config.mint ?? 'ok';
  if (!Array.isArray(mint)) return mint;
  if (mint.length === 0) return 'ok';
  return mint[Math.min(attempt, mint.length - 1)];
}

async function handleMint(request, response, url, namespace) {
  const key = keyFromBearer(request);
  if (!key?.startsWith('csk_')) return false;
  const state = stateForKey(key);
  if (!state) return false;

  const ctx = createContext(request, response, url, key, state);
  recordOperation(ctx, 'auth-link.mint');
  const body = await readJsonBody(request);
  if (!isRecord(body) || typeof body.redirectPath !== 'string') {
    respond(ctx, 400, { error: 'redirectPath is required' });
    return true;
  }
  ctx.entry.body = { redirectPath: body.redirectPath };
  // Parity with `routes/cloud.mjs`, which counts every mint by destination.
  recordScenarioActivity(key, `authLinkMint:${body.redirectPath}`);

  const config = configForKey(key);
  const behavior = mintBehavior(config, state.mints.length);
  const mint = { at: ctx.entry.at, redirectPath: body.redirectPath, status: 0 };
  state.mints.push(mint);

  if (behavior === 'two-factor-pending') {
    mint.status = 403;
    // `resolveAuthLinkUser` → `jsonError(403, ...)` in the real route.
    respond(ctx, 403, { error: 'Two-factor authentication required' });
    return true;
  }
  if (behavior === 'rate-limited') {
    mint.status = 429;
    respond(
      ctx,
      429,
      { error: 'Too many requests' },
      { 'retry-after': String(config.retryAfterSeconds ?? 60) },
    );
    return true;
  }
  if (isRecord(behavior)) {
    mint.status = behavior.status ?? 500;
    respond(ctx, mint.status, behavior.body ?? { error: 'Mint failed' });
    return true;
  }

  const code = `hs-${randomUUID()}`;
  codeOwners.set(code, key);
  state.codes.set(code, { redirectPath: body.redirectPath });
  mint.status = 200;
  const consumeUrl = new URL(
    `/api/v1/${namespace}/auth-link/consume`,
    requestOrigin(request, url),
  );
  consumeUrl.searchParams.set('code', code);
  respond(ctx, 200, { url: consumeUrl.toString() });
  return true;
}

function redirect(ctx, location, cookies = []) {
  ctx.entry.status = 303;
  const headers = [
    ['location', location],
    ['cache-control', 'no-store'],
    ...cookies.map((cookie) => ['set-cookie', cookie]),
  ];
  ctx.response.writeHead(303, headers.flat());
  ctx.response.end();
}

function handleConsume(request, response, url) {
  const code = url.searchParams.get('code');
  const key = code ? codeOwners.get(code) : undefined;
  // Codes this module did not mint (for example the static one
  // `routes/cloud.mjs` hands out) are not ours to answer.
  if (key === undefined) return false;
  codeOwners.delete(code);
  const state = stateForKey(key);
  const origin = requestOrigin(request, url);
  if (!state) {
    response.writeHead(303, { location: `${origin}/login` });
    response.end();
    return true;
  }
  const ctx = createContext(request, response, url, key, state);
  recordOperation(ctx, 'auth-link.consume');
  const pending = state.codes.get(code);
  state.codes.delete(code);
  const config = configForKey(key);
  if (pending === undefined || config.consume === 'login') {
    state.consumes.push({ at: ctx.entry.at, accepted: false });
    redirect(ctx, `${origin}/login`);
    return true;
  }

  const token = randomUUID();
  sessionOwners.set(token, key);
  state.sessions.add(token);
  const cookies = [
    `${HOSTED_SETTINGS_SESSION_COOKIE}=${token}.mock-signature; Path=/; HttpOnly; SameSite=Lax`,
  ];
  if (state.twoFactorUser) {
    const proof = `mock-proof-${token}`;
    state.proofs.add(proof);
    cookies.push(
      `${HOSTED_SETTINGS_TWO_FACTOR_COOKIE}=${proof}; Path=/; HttpOnly; SameSite=Lax`,
    );
  }
  state.consumes.push({
    at: ctx.entry.at,
    accepted: true,
    twoFactorProof: state.twoFactorUser,
  });
  const target = new URL(pending.redirectPath, origin);
  redirect(ctx, target.toString(), cookies);
  return true;
}

/* -------------------------------------------------------------------------- */
/* Operations                                                                  */
/* -------------------------------------------------------------------------- */

const ORG = '/api/account/organizations/([^/]+)';

function orgFor(ctx, match) {
  const org = ctx.state.organizations[decodeURIComponent(match[1])];
  if (org === undefined || !ctx.state.orgOrder.includes(org.id)) {
    respond(ctx, 404, { error: 'Organization not found' });
    return null;
  }
  return org;
}

function editableOrgFor(ctx, match) {
  const org = orgFor(ctx, match);
  if (org === null) return null;
  if (!canEditOrganization(org.viewerRole)) {
    respond(ctx, 403, { error: 'Forbidden' });
    return null;
  }
  return org;
}

function bodyName(ctx) {
  const name = ctx.body?.name;
  if (typeof name !== 'string' || name.trim() === '') {
    respond(ctx, 400, { error: 'name is required' });
    return null;
  }
  return name.trim();
}

function ownerCount(org) {
  return org.members.filter((entry) => entry.role === 'OWNER').length;
}

function projectSummary(entry) {
  const summary = clone(entry);
  for (const field of ['grants', 'createdBy', 'createdAt', 'updatedAt']) {
    delete summary[field];
  }
  return summary;
}

function projectPage(org, project) {
  return {
    data: org.projects.map(project),
    revision: `rev-${org.projects.length}`,
    nextCursor: null,
  };
}

function updateConfig(ctx, match) {
  const org = editableOrgFor(ctx, match);
  if (org === null) return;
  if (!isRecord(ctx.body) || Object.keys(ctx.body).length === 0) {
    respond(ctx, 400, { error: 'Nothing to update' });
    return;
  }
  for (const [field, value] of Object.entries(ctx.body)) {
    if (Object.prototype.hasOwnProperty.call(org.config, field)) {
      org.config[field] = clone(value);
    }
  }
  respond(ctx, 200, clone(org.config));
}

function lastOwner(ctx) {
  respond(ctx, 409, {
    error: 'An organization needs at least one owner.',
    code: 'last_owner',
  });
}

const CLOUD_GATEWAY_KEY_PATH =
  /^\/api\/v1\/settings\/ai-gateway\/organization\/([^/]+)\/cloud-key$/;

/**
 * The `SETTINGS_OPERATIONS` entries this mock serves, keyed by the request
 * each entry builds. Names match the table so the request log and
 * `operationErrors` speak the same vocabulary as the desktop.
 */
const OPERATION_ROUTES = [
  {
    operation: 'account.settings.ai-gateway.read',
    method: 'GET',
    path: /^\/api\/v1\/settings\/ai-gateway$/,
    handle(ctx) {
      if (!ctx.state.aiGatewayEnabled)
        return respond(ctx, 404, { error: 'Not found' });
      respond(ctx, 200, { gateway: clone(ctx.state.personalGateway) });
    },
  },
  {
    operation: 'ai-gateway.authorize',
    method: 'POST',
    path: /^\/api\/v1\/settings\/ai-gateway\/authorize$/,
    handle(ctx) {
      if (!ctx.state.aiGatewayEnabled)
        return respond(ctx, 404, { error: 'Not found' });
      const scope = ctx.body?.scope;
      if (scope?.kind === 'personal') {
        const id = getScenario(ctx.key).cloud?.personalOrganizationId;
        return scope.expectedOrganizationId === id
          ? respond(ctx, 200, { organizationId: id })
          : respond(ctx, 409, {
              code: 'stale_scope',
              error: 'Reload settings',
            });
      }
      const org = ctx.state.organizations[scope?.organizationId];
      if (!org || org.isPersonal || !canEditOrganization(org.viewerRole))
        return respond(ctx, 403, { error: 'Forbidden' });
      respond(ctx, 200, { organizationId: org.id });
    },
  },
  {
    operation: 'account.settings.ai-gateway.update',
    method: 'PATCH',
    path: /^\/api\/v1\/settings\/ai-gateway$/,
    handle(ctx) {
      if (!ctx.state.aiGatewayEnabled)
        return respond(ctx, 404, { error: 'Not found' });
      const cloud = getScenario(ctx.key).cloud;
      const { expectedOrganizationId, expectedRevision, ...patch } =
        ctx.body ?? {};
      if (expectedOrganizationId !== cloud?.personalOrganizationId)
        return respond(ctx, 409, {
          code: 'stale_scope',
          error: 'Reload settings',
        });
      if (
        expectedRevision !== (ctx.state.personalGateway?.revision ?? 'absent')
      )
        return respond(ctx, 409, {
          code: 'stale_revision',
          error: 'Reload settings',
        });
      const gateway = {
        organizationId: expectedOrganizationId,
        displayName: null,
        baseUrl: null,
        models: [],
        enabled: false,
        onlyThisGateway: false,
        promptCachePassthrough: true,
        ...ctx.state.personalGateway,
        ...patch,
      };
      if (gateway.enabled && (!gateway.baseUrl || gateway.models.length === 0))
        return respond(ctx, 400, { error: 'Add a URL and model' });
      gateway.revision = `gateway-${++ctx.state.gatewayRevision}`;
      ctx.state.personalGateway = gateway;
      if (gateway.enabled)
        cloud.personalModelGateway = {
          organizationId: gateway.organizationId,
          kind: 'model-gateway',
          baseUrl: gateway.baseUrl,
          models: gateway.models,
          enforced: gateway.onlyThisGateway,
          promptCachePassthrough: gateway.promptCachePassthrough,
          ...(gateway.displayName ? { displayName: gateway.displayName } : {}),
        };
      else delete cloud.personalModelGateway;
      respond(ctx, 200, { gateway: clone(gateway) });
    },
  },
  {
    operation: 'organization.settings.ai-gateway.cloud-key.read',
    method: 'GET',
    path: CLOUD_GATEWAY_KEY_PATH,
    handle(ctx, match) {
      const keys = ctx.state.cloudGatewayKeys;
      if (!keys) return respond(ctx, 404, { error: 'Not found' });
      const id = decodeURIComponent(match[1]);
      respond(ctx, 200, { status: keys[id] ?? 'none' });
    },
  },
  {
    operation: 'organization.settings.ai-gateway.cloud-key.save',
    method: 'PUT',
    path: CLOUD_GATEWAY_KEY_PATH,
    handle(ctx, match) {
      const keys = ctx.state.cloudGatewayKeys;
      if (!keys) return respond(ctx, 404, { error: 'Not found' });
      const id = decodeURIComponent(match[1]);
      keys[id] = 'saved';
      respond(ctx, 200, { status: keys[id] });
    },
  },
  {
    operation: 'organization.settings.ai-gateway.cloud-key.remove',
    method: 'DELETE',
    path: CLOUD_GATEWAY_KEY_PATH,
    handle(ctx, match) {
      const keys = ctx.state.cloudGatewayKeys;
      if (!keys) return respond(ctx, 404, { error: 'Not found' });
      const id = decodeURIComponent(match[1]);
      keys[id] = 'none';
      respond(ctx, 200, { status: keys[id] });
    },
  },

  /* Hosted settings reads ------------------------------------------------ */
  {
    operation: 'settings.bootstrap',
    method: 'GET',
    path: /^\/api\/v1\/settings\/bootstrap$/,
    handle(ctx) {
      const config = configForKey(ctx.key);
      if (config.bootstrap === 'unsupported') {
        respond(ctx, 404, { error: 'Not found' });
        return;
      }
      const organizationId =
        ctx.url.searchParams.get('organizationId') ?? undefined;
      respond(ctx, 200, bootstrapPayload(ctx.state, organizationId));
    },
  },
  {
    operation: 'settings.pageData',
    method: 'POST',
    path: /^\/api\/v1\/settings\/page-data$/,
    handle(ctx) {
      if (configForKey(ctx.key).bootstrap === 'unsupported') {
        respond(ctx, 404, { error: 'Not found' });
        return;
      }
      if (!isRecord(ctx.body) || !isRecord(ctx.body.route)) {
        respond(ctx, 400, { error: 'route is required' });
        return;
      }
      const route = ctx.body.route;
      const feed =
        typeof route.organizationId === 'string'
          ? ctx.state.feeds[route.organizationId]
          : undefined;
      const result = pageDataResponse(
        ctx.state,
        route,
        (feed?.events ?? []).map((event) => event.item),
      );
      respond(ctx, result.status, result.body);
    },
  },

  /* Account ---------------------------------------------------------------- */
  {
    operation: 'account.avatar.remove',
    method: 'PATCH',
    path: /^\/api\/account\/profile$/,
    when: (ctx) => isRecord(ctx.body) && ctx.body.image === null,
    handle(ctx) {
      ctx.state.profile.image = null;
      respond(ctx, 200, {
        name: ctx.state.profile.name,
        image: ctx.state.profile.image,
      });
    },
  },
  {
    operation: 'account.details.update',
    method: 'PATCH',
    path: /^\/api\/account\/profile$/,
    handle(ctx) {
      const name = bodyName(ctx);
      if (name === null) return;
      ctx.state.profile.name = name;
      respond(ctx, 200, {
        name: ctx.state.profile.name,
        image: ctx.state.profile.image,
      });
    },
  },
  {
    operation: 'account.profile.read',
    method: 'GET',
    path: /^\/api\/account\/public-profile$/,
    handle(ctx) {
      respond(ctx, 200, { settings: clone(ctx.state.publicProfile) });
    },
  },
  {
    operation: 'account.profile.update',
    method: 'PATCH',
    path: /^\/api\/account\/public-profile$/,
    handle(ctx) {
      if (!isRecord(ctx.body)) {
        respond(ctx, 400, { error: 'Invalid body' });
        return;
      }
      const allowed = [
        'username',
        'enabled',
        'bio',
        'links',
        'showCost',
        'showHeatmap',
      ];
      for (const field of allowed) {
        if (ctx.body[field] !== undefined) {
          ctx.state.publicProfile[field] = clone(ctx.body[field]);
        }
      }
      respond(ctx, 200, { settings: clone(ctx.state.publicProfile) });
    },
  },
  {
    operation: 'account.notifications.digestPreferences.read',
    method: 'GET',
    path: /^\/api\/account\/digest-preferences$/,
    handle(ctx) {
      respond(ctx, 200, clone(ctx.state.digestPreferences));
    },
  },
  {
    operation: 'account.notifications.digestPreferences.update',
    method: 'PATCH',
    path: /^\/api\/account\/digest-preferences$/,
    handle(ctx) {
      if (!isRecord(ctx.body)) {
        respond(ctx, 400, { error: 'Invalid body' });
        return;
      }
      for (const field of [
        'daily',
        'weekly',
        'monthly',
        'weeklyAnchorDay',
        'monthlyAnchorDay',
      ]) {
        if (ctx.body[field] !== undefined) {
          ctx.state.digestPreferences[field] = ctx.body[field];
        }
      }
      respond(ctx, 200, clone(ctx.state.digestPreferences));
    },
  },
  {
    operation: 'account.notifications.push.read',
    method: 'GET',
    path: /^\/api\/account\/notification-preferences$/,
    handle(ctx) {
      respond(ctx, 200, clone(ctx.state.pushPreferences));
    },
  },
  {
    operation: 'account.notifications.push.update',
    method: 'PATCH',
    path: /^\/api\/account\/notification-preferences$/,
    handle(ctx) {
      if (typeof ctx.body?.pushEnabled !== 'boolean') {
        respond(ctx, 400, { error: 'pushEnabled is required' });
        return;
      }
      ctx.state.pushPreferences.pushEnabled = ctx.body.pushEnabled;
      respond(ctx, 200, clone(ctx.state.pushPreferences));
    },
  },
  {
    operation: 'account.apiKeys.list',
    method: 'GET',
    path: /^\/api\/account\/api-keys$/,
    handle(ctx) {
      respond(ctx, 200, clone(ctx.state.apiKeys));
    },
  },
  {
    operation: 'account.apiKeys.create',
    method: 'POST',
    path: /^\/api\/account\/api-keys$/,
    handle(ctx) {
      const name = bodyName(ctx);
      if (name === null) return;
      const id = nextId(ctx.state, 'api-key-e2e-');
      const userApiKey = {
        id,
        name,
        source: 'settings',
        createdIp: null,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
      };
      ctx.state.apiKeys.push(userApiKey);
      // A placeholder shaped like a key; it authenticates nothing.
      respond(ctx, 200, {
        userApiKey: clone(userApiKey),
        token: `csk_mock_created_${id}`,
      });
    },
  },
  {
    operation: 'account.apiKeys.revoke',
    method: 'DELETE',
    path: /^\/api\/account\/api-keys\/([^/]+)$/,
    handle(ctx, match) {
      const id = decodeURIComponent(match[1]);
      const index = ctx.state.apiKeys.findIndex((entry) => entry.id === id);
      if (index === -1) {
        respond(ctx, 404, { error: 'API key not found' });
        return;
      }
      ctx.state.apiKeys.splice(index, 1);
      respond(ctx, 200, { ok: true });
    },
  },
  {
    operation: 'account.security.authSources',
    method: 'GET',
    path: /^\/api\/account\/auth-sources$/,
    handle(ctx) {
      respond(ctx, 200, authSources(ctx.state));
    },
  },
  {
    operation: 'account.security.changePassword',
    method: 'POST',
    path: /^\/api\/auth\/change-password$/,
    handle(ctx) {
      const { currentPassword, newPassword } = ctx.body ?? {};
      // Passwords never enter the request log.
      ctx.entry.body = { redacted: true };
      if (
        typeof currentPassword !== 'string' ||
        typeof newPassword !== 'string'
      ) {
        respond(ctx, 400, {
          code: 'VALIDATION_ERROR',
          message: 'Invalid body',
        });
        return;
      }
      if (currentPassword !== ctx.state.password) {
        respond(ctx, 400, {
          code: 'INVALID_PASSWORD',
          message: 'Invalid password',
        });
        return;
      }
      ctx.state.password = newPassword;
      respond(ctx, 200, {
        token: null,
        user: {
          id: ctx.state.viewer.id,
          email: ctx.state.viewer.email,
          name: ctx.state.profile.name,
        },
      });
    },
  },
  {
    operation: 'auth.signOut',
    method: 'POST',
    path: /^\/api\/auth\/sign-out$/,
    handle(ctx) {
      const token = sessionToken(ctx.request);
      // The owner mapping stays so later requests with this cookie are
      // logged against the key as `session.rejected`.
      ctx.state.sessions.delete(token);
      ctx.state.signOuts += 1;
      respond(
        ctx,
        200,
        { success: true },
        {
          'set-cookie': `${HOSTED_SETTINGS_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
        },
      );
    },
  },
  {
    operation: 'account.billing.summary',
    method: 'GET',
    path: /^\/api\/account\/billing$/,
    handle(ctx) {
      respond(ctx, 200, billingSummary());
    },
  },
  {
    operation: 'account.billing.credits',
    method: 'GET',
    path: /^\/api\/account\/billing\/credits$/,
    handle(ctx) {
      respond(ctx, 200, creditsSummary());
    },
  },
  {
    operation: 'account.billing.invoices',
    method: 'GET',
    path: /^\/api\/account\/billing\/invoices$/,
    handle(ctx) {
      respond(ctx, 200, invoicePage());
    },
  },
  {
    operation: 'account.billing.charges',
    method: 'GET',
    path: /^\/api\/account\/billing\/history$/,
    handle(ctx) {
      respond(ctx, 200, {
        charges: ACCOUNT_BILLING_CHARGES,
        nextCursor: null,
      });
    },
  },
  {
    operation: 'account.billing.creditsLedger',
    method: 'GET',
    path: /^\/api\/account\/billing\/credits\/ledger$/,
    handle(ctx) {
      respond(ctx, 200, { email: CLOUD_ACCOUNT.email, entries: [] });
    },
  },
  {
    operation: 'account.github.connection.read',
    method: 'GET',
    path: /^\/api\/cloud\/github\/connection$/,
    handle(ctx) {
      respond(ctx, 200, gitHubConnection());
    },
  },
  {
    operation: 'organization.github.connect',
    method: 'POST',
    path: /^\/api\/account\/teams\/([^/]+)\/github\/connect$/,
    handle(ctx, match) {
      const org = editableOrgFor(ctx, match);
      if (org === null) return;
      // A seeded handoff only: no live installation, callback or connection write.
      respond(ctx, 200, {
        installUrl: 'https://github.com/apps/canopy-e2e/installations/new',
      });
    },
  },

  /* Invitations (before `organizations/:id`, which would capture them) ----- */
  {
    operation: 'organization.invitations.incoming',
    method: 'GET',
    path: /^\/api\/account\/organizations\/invitations$/,
    handle(ctx) {
      respond(ctx, 200, { invitations: clone(ctx.state.incomingInvitations) });
    },
  },
  {
    operation: 'organization.invitations.respond',
    method: 'PATCH',
    path: /^\/api\/account\/organizations\/invitations\/([^/]+)$/,
    handle(ctx, match) {
      const invitation = ctx.state.incomingInvitations.find(
        (entry) => entry.id === decodeURIComponent(match[1]),
      );
      if (invitation === undefined) {
        respond(ctx, 404, { error: 'Invitation not found' });
        return;
      }
      const action = ctx.body?.action;
      if (!['accept', 'decline'].includes(action)) {
        respond(ctx, 400, { error: 'Invalid action' });
        return;
      }
      if (action === 'accept') {
        const org = ctx.state.organizations[invitation.organizationId];
        if (!ctx.state.orgOrder.includes(org.id)) {
          org.viewerRole = invitation.role;
          if (
            !org.members.some((member) => member.id === ctx.state.viewer.id)
          ) {
            org.members.push({
              ...ctx.state.viewer,
              image: null,
              role: invitation.role,
              subTeamIds: [],
              memberSince: HOSTED_SETTINGS_TIME,
            });
          }
          ctx.state.orgOrder.push(org.id);
        }
        synchronizeCloudMembership(ctx);
      }
      ctx.state.incomingInvitations = ctx.state.incomingInvitations.filter(
        (entry) => entry.id !== invitation.id,
      );
      respond(ctx, 200, { ok: true });
    },
  },
  {
    operation: 'organization.invitations.status',
    method: 'GET',
    path: /^\/api\/account\/invites$/,
    when: (ctx) =>
      ctx.url.searchParams.has('organizationId') ||
      ctx.url.searchParams.has('email'),
    handle(ctx) {
      const organizationId = ctx.url.searchParams.get('organizationId');
      const email = ctx.url.searchParams.get('email');
      const invite = ctx.state.invites.find(
        (entry) =>
          entry.organizationId === organizationId &&
          entry.invitedEmail === email &&
          entry.status === 'ACTIVE',
      );
      respond(
        ctx,
        200,
        invite === undefined
          ? { status: 'not-found' }
          : { status: 'pending', inviteId: invite.id },
      );
    },
  },
  {
    operation: 'organization.invitations.list',
    method: 'GET',
    path: /^\/api\/account\/invites$/,
    handle(ctx) {
      respond(ctx, 200, {
        enabled: true,
        invites: clone(
          ctx.state.invites.filter(
            (invite) => invite.createdByUserId === ctx.state.viewer.id,
          ),
        ),
      });
    },
  },
  {
    operation: 'organization.invitations.list',
    method: 'GET',
    path: new RegExp(`^${ORG}/invites$`),
    handle(ctx, match) {
      const org = orgFor(ctx, match);
      if (org === null) return;
      if (!canEditOrganization(org.viewerRole)) {
        respond(ctx, 403, { error: 'Forbidden' });
        return;
      }
      const invites = ctx.state.invites.filter(
        (invite) =>
          invite.organizationId === org.id &&
          invite.status === 'ACTIVE' &&
          (org.viewerRole === 'OWNER' ||
            invite.createdByUserId === ctx.state.viewer.id),
      );
      const cursor = ctx.url.searchParams.get('cursor');
      const start = cursor
        ? invites.findIndex((invite) => invite.id === cursor) + 1
        : 0;
      const items = invites
        .slice(start, start + 50)
        .map(({ id, code, createdByUserId, ...invite }) => ({
          ...invite,
          externalId: id,
        }));
      respond(ctx, 200, {
        enabled: true,
        items,
        nextCursor:
          start + 50 < invites.length ? items.at(-1).externalId : null,
      });
    },
  },
  {
    operation: 'organization.invitations.revoke',
    method: 'DELETE',
    path: new RegExp(`^${ORG}/invites/([^/]+)$`),
    handle(ctx, match) {
      const org = orgFor(ctx, match);
      if (org === null) return;
      const invite = ctx.state.invites.find(
        (invite) =>
          invite.id === match[2] &&
          invite.organizationId === org.id &&
          (org.viewerRole === 'OWNER' ||
            invite.createdByUserId === ctx.state.viewer.id),
      );
      if (!canEditOrganization(org.viewerRole) || !invite) {
        respond(ctx, 404, { error: 'Invite not found' });
        return;
      }
      invite.status = 'REVOKED';
      respond(ctx, 204);
    },
  },
  {
    operation: 'organization.members.invite',
    method: 'POST',
    path: /^\/api\/account\/invites$/,
    handle(ctx) {
      const { organizationId, email, role = 'MEMBER' } = ctx.body ?? {};
      const org = ctx.state.organizations[organizationId];
      if (org === undefined) {
        respond(ctx, 404, { error: 'Organization not found' });
        return;
      }
      if (!canEditOrganization(org.viewerRole)) {
        respond(ctx, 403, { error: 'Forbidden' });
        return;
      }
      if (typeof email !== 'string' || !email.includes('@')) {
        respond(ctx, 400, { error: 'A valid email is required' });
        return;
      }
      // The real API lists an open invite as `ACTIVE` with `invitedEmail`.
      const id = nextId(ctx.state, 'd1000000-0000-4000-8000-');
      const invite = {
        id,
        code: `invite-${id}`,
        createdByUserId: ctx.state.viewer.id,
        status: 'ACTIVE',
        organizationId,
        organizationTeamName: null,
        role,
        invitedEmail: email,
        seatPaymentState: 'READY',
        createdAt: new Date().toISOString(),
      };
      ctx.state.invites.push(invite);
      respond(ctx, 200, {
        ...clone(invite),
        emailQueued: true,
        emailSuppressed: false,
        emailDeferred: false,
      });
    },
  },

  /* Organizations ---------------------------------------------------------- */
  {
    operation: 'organization.list',
    method: 'GET',
    path: /^\/api\/account\/organizations$/,
    handle(ctx) {
      respond(ctx, 200, {
        organizations: visibleOrganizations(ctx.state).map(organizationSummary),
      });
    },
  },
  {
    operation: 'organization.create',
    method: 'POST',
    path: /^\/api\/account\/organizations$/,
    handle(ctx) {
      const name = bodyName(ctx);
      if (name === null) return;
      const id = nextId(ctx.state, 'a1000000-0000-4000-8000-');
      const viewer = ctx.state.viewer;
      const template = defaultHostedSettingsOrganizations(viewer)[1];
      const org = {
        ...template,
        id,
        name,
        members: [
          {
            ...viewer,
            image: null,
            role: 'OWNER',
            subTeamIds: [],
            memberSince: new Date().toISOString(),
          },
        ],
        subTeams: [],
        projects: [],
        facts: [],
      };
      ctx.state.organizations[id] = org;
      ctx.state.orgOrder.push(id);
      ctx.state.feeds[id] = emptyFeed();
      synchronizeCloudMembership(ctx);
      respond(ctx, 200, organizationDetail(org));
    },
  },
  {
    operation: 'organization.delete',
    method: 'DELETE',
    path: new RegExp(`^${ORG}$`),
    handle(ctx, match) {
      const org = orgFor(ctx, match);
      if (org === null) return;
      if (org.viewerRole !== 'OWNER') {
        respond(ctx, 403, { error: 'Forbidden' });
        return;
      }
      if (org.isPersonal) {
        respond(ctx, 400, { error: 'Cannot delete Personal organization' });
        return;
      }
      endOrganizationStreams(ctx.state, org.id);
      ctx.state.orgOrder = ctx.state.orgOrder.filter((id) => id !== org.id);
      // Retain a tombstone until cloud membership has been reconciled.
      org.viewerRole = null;
      synchronizeCloudMembership(ctx);
      delete ctx.state.organizations[org.id];
      delete ctx.state.feeds[org.id];
      ctx.state.invites = ctx.state.invites.filter(
        (entry) => entry.organizationId !== org.id,
      );
      ctx.state.incomingInvitations = ctx.state.incomingInvitations.filter(
        (entry) => entry.organizationId !== org.id,
      );
      respond(ctx, 200, { ok: true });
    },
  },
  {
    operation: 'organization.leave',
    method: 'POST',
    path: new RegExp(`^${ORG}/leave$`),
    handle(ctx, match) {
      const org = orgFor(ctx, match);
      if (org === null) return;
      if (org.viewerRole === 'OWNER' && ownerCount(org) < 2) {
        lastOwner(ctx);
        return;
      }
      endOrganizationStreams(ctx.state, org.id);
      org.members = org.members.filter(
        (entry) => entry.id !== ctx.state.viewer.id,
      );
      org.viewerRole = null;
      ctx.state.orgOrder = ctx.state.orgOrder.filter((id) => id !== org.id);
      synchronizeCloudMembership(ctx);
      respond(ctx, 200, { ok: true });
    },
  },
  {
    operation: 'organization.detail',
    method: 'GET',
    path: new RegExp(`^${ORG}$`),
    handle(ctx, match) {
      const org = orgFor(ctx, match);
      if (org) respond(ctx, 200, organizationDetail(org));
    },
  },
  {
    operation: 'organization.rename',
    method: 'PATCH',
    path: new RegExp(`^${ORG}$`),
    handle(ctx, match) {
      const org = editableOrgFor(ctx, match);
      if (org === null) return;
      const name = bodyName(ctx);
      if (name === null) return;
      org.name = name;
      respond(ctx, 200, organizationDetail(org));
    },
  },
  {
    operation: 'organization.members.updateRole',
    method: 'PATCH',
    path: new RegExp(`^${ORG}/members/([^/]+)$`),
    handle(ctx, match) {
      const org = editableOrgFor(ctx, match);
      if (org === null) return;
      const target = org.members.find(
        (entry) => entry.id === decodeURIComponent(match[2]),
      );
      const role = ctx.body?.role;
      if (target === undefined) {
        respond(ctx, 404, { error: 'Member not found' });
        return;
      }
      if (!['OWNER', 'ADMIN', 'MEMBER'].includes(role)) {
        respond(ctx, 400, { error: 'Invalid role' });
        return;
      }
      if (target.role === 'OWNER' && role !== 'OWNER' && ownerCount(org) < 2) {
        lastOwner(ctx);
        return;
      }
      target.role = role;
      if (target.id === ctx.state.viewer.id) org.viewerRole = role;
      respond(ctx, 200, organizationDetail(org));
    },
  },
  {
    operation: 'organization.members.remove',
    method: 'DELETE',
    path: new RegExp(`^${ORG}/members/([^/]+)$`),
    handle(ctx, match) {
      const org = editableOrgFor(ctx, match);
      if (org === null) return;
      const userId = decodeURIComponent(match[2]);
      const target = org.members.find((entry) => entry.id === userId);
      if (target === undefined) {
        respond(ctx, 404, { error: 'Member not found' });
        return;
      }
      if (target.role === 'OWNER' && ownerCount(org) < 2) {
        lastOwner(ctx);
        return;
      }
      org.members = org.members.filter((entry) => entry.id !== userId);
      respond(ctx, 200, organizationDetail(org));
    },
  },
  {
    operation: 'organization.teams.create',
    method: 'POST',
    path: new RegExp(`^${ORG}/teams$`),
    handle(ctx, match) {
      const org = editableOrgFor(ctx, match);
      if (org === null) return;
      const name = bodyName(ctx);
      if (name === null) return;
      org.subTeams.push({
        id: nextId(ctx.state, 'c2000000-0000-4000-8000-'),
        name,
      });
      respond(ctx, 200, organizationDetail(org));
    },
  },
  {
    operation: 'organization.teams.rename',
    method: 'PATCH',
    path: new RegExp(`^${ORG}/teams/([^/]+)$`),
    handle(ctx, match) {
      const org = editableOrgFor(ctx, match);
      if (org === null) return;
      const team = org.subTeams.find(
        (entry) => entry.id === decodeURIComponent(match[2]),
      );
      if (team === undefined) {
        respond(ctx, 404, { error: 'Team not found' });
        return;
      }
      const name = bodyName(ctx);
      if (name === null) return;
      team.name = name;
      respond(ctx, 200, organizationDetail(org));
    },
  },
  {
    operation: 'organization.teams.delete',
    method: 'DELETE',
    path: new RegExp(`^${ORG}/teams/([^/]+)$`),
    handle(ctx, match) {
      const org = editableOrgFor(ctx, match);
      if (org === null) return;
      const teamId = decodeURIComponent(match[2]);
      if (!org.subTeams.some((entry) => entry.id === teamId)) {
        respond(ctx, 404, { error: 'Team not found' });
        return;
      }
      org.subTeams = org.subTeams.filter((entry) => entry.id !== teamId);
      for (const entry of org.members) {
        entry.subTeamIds = entry.subTeamIds.filter((id) => id !== teamId);
      }
      respond(ctx, 200, organizationDetail(org));
    },
  },
  {
    operation: 'organization.projects.list',
    method: 'GET',
    path: new RegExp(`^${ORG}/projects$`),
    when: (ctx) => ctx.url.searchParams.get('view') === 'management',
    handle(ctx, match) {
      const org = editableOrgFor(ctx, match);
      if (org === null) return;
      respond(
        ctx,
        200,
        projectPage(org, (entry) => clone(entry)),
      );
    },
  },
  {
    operation: 'organization.projects.memberList',
    method: 'GET',
    path: new RegExp(`^${ORG}/projects$`),
    handle(ctx, match) {
      const org = orgFor(ctx, match);
      if (org) respond(ctx, 200, projectPage(org, projectSummary));
    },
  },
  {
    operation: 'organization.memory.facts',
    method: 'GET',
    path: new RegExp(`^${ORG}/memory-explorer/facts$`),
    handle(ctx, match) {
      const org = editableOrgFor(ctx, match);
      if (org) respond(ctx, 200, { facts: clone(org.facts), nextCursor: null });
    },
  },
  {
    operation: 'organization.memory.fact',
    method: 'GET',
    // `facts/batch` is the graph selection read, not a fact id.
    path: new RegExp(`^${ORG}/memory-explorer/facts/(?!batch$)([^/]+)$`),
    handle(ctx, match) {
      const org = editableOrgFor(ctx, match);
      if (org === null) return;
      const factId = decodeURIComponent(match[2]);
      const entry = org.facts.find((candidate) => candidate.id === factId);
      if (entry === undefined) {
        respond(ctx, 404, { error: 'Fact not found' });
        return;
      }
      respond(ctx, 200, factDetail(entry));
    },
  },
  {
    operation: 'organization.settings.config',
    method: 'GET',
    path: new RegExp(`^${ORG}/config$`),
    handle(ctx, match) {
      const org = orgFor(ctx, match);
      if (org) respond(ctx, 200, clone(org.config));
    },
  },
  {
    operation: 'organization.settings.usage.update',
    method: 'PATCH',
    path: new RegExp(`^${ORG}/config$`),
    when: (ctx) =>
      isRecord(ctx.body) &&
      Object.keys(ctx.body).length === 1 &&
      ctx.body.usageStatsMinRole !== undefined,
    handle: updateConfig,
  },
  {
    operation: 'organization.settings.policies.update',
    method: 'PATCH',
    path: new RegExp(`^${ORG}/config$`),
    handle: updateConfig,
  },
  {
    operation: 'organization.settings.modelCatalog',
    method: 'GET',
    path: /^\/api\/account\/model-catalog$/,
    handle(ctx) {
      respond(ctx, 200, { models: modelCatalog() });
    },
  },
  {
    operation: 'organization.settings.subscriptionPricing',
    method: 'GET',
    path: new RegExp(`^${ORG}/subscription-pricing$`),
    handle(ctx, match) {
      const org = orgFor(ctx, match);
      if (org) respond(ctx, 200, subscriptionPricing(org));
    },
  },
  {
    operation: 'organization.settings.subscriptionPricing.update',
    method: 'PUT',
    path: new RegExp(`^${ORG}/subscription-pricing$`),
    handle(ctx, match) {
      const org = editableOrgFor(ctx, match);
      if (org === null) return;
      const { planKey, monthlyPriceUsd } = ctx.body ?? {};
      const known = subscriptionPricing(org).plans.some(
        (plan) => plan.planKey === planKey,
      );
      if (!known) {
        respond(ctx, 400, { error: 'Unknown plan' });
        return;
      }
      org.subscriptionPricingOverrides = {
        ...org.subscriptionPricingOverrides,
        [planKey]: monthlyPriceUsd,
      };
      respond(ctx, 200, subscriptionPricing(org));
    },
  },
  {
    operation: 'organization.statistics.usage',
    method: 'GET',
    path: new RegExp(`^${ORG}/usage$`),
    handle(ctx, match) {
      const org = orgFor(ctx, match);
      if (org === null) return;
      const query = ctx.url.searchParams;
      respond(
        ctx,
        200,
        teamUsage({
          scope: query.get('scope') ?? 'organization',
          teamId: query.get('teamId'),
          userId: query.get('userId'),
          granularity: query.get('granularity') ?? 'day',
          startIso: query.get('start') ?? HOSTED_SETTINGS_TIME,
          endIso: query.get('end') ?? HOSTED_SETTINGS_TIME,
        }),
      );
    },
  },
  {
    operation: 'organization.statistics.routingBacktest.lookup',
    method: 'GET',
    path: new RegExp(`^${ORG}/model-routing-backtests$`),
    handle(ctx, match) {
      const org = orgFor(ctx, match);
      if (org === null) return;
      // No eligible turns: the card renders its settled unavailable state.
      respond(ctx, 200, {
        backtest: null,
        estimate: null,
        unavailableReason: 'no_eligible_turns',
      });
    },
  },
  {
    operation: 'organization.feed.page',
    method: 'GET',
    path: new RegExp(`^${ORG}/feed$`),
    handle(ctx, match) {
      const org = orgFor(ctx, match);
      if (org === null) return;
      const events = ctx.state.feeds[org.id]?.events ?? [];
      respond(ctx, 200, {
        items: events.map((event) => clone(event.item)).reverse(),
        nextCursor: null,
      });
    },
  },
  {
    // The web adapter's viewer evidence (CAN-3383). The fixture account id is
    // not a UUID, which the status requires, so the viewer gets a fixed one.
    operation: 'organization.dataSharing.viewer',
    method: 'GET',
    path: new RegExp(`^${ORG}/data-sharing$`),
    handle(ctx, match) {
      const org = orgFor(ctx, match);
      if (org === null) return;
      respond(ctx, 200, {
        viewerUserId: 'a0000000-0000-4000-8000-0000000000ff',
        scopes: {
          metadata: 'private',
          plans: 'unknown',
          summaries: 'unknown',
          transcripts: 'unknown',
        },
      });
    },
  },
  {
    operation: 'organization.billing.summary',
    method: 'GET',
    path: new RegExp(`^${ORG}/billing$`),
    handle(ctx, match) {
      const org = orgFor(ctx, match);
      if (org) {
        respond(
          ctx,
          200,
          billingSummary({ organization: true, lapsed: org.lapsed !== null }),
        );
      }
    },
  },
  {
    operation: 'organization.billing.credits',
    method: 'GET',
    path: new RegExp(`^${ORG}/billing/credits$`),
    handle(ctx, match) {
      const org = orgFor(ctx, match);
      if (org) respond(ctx, 200, creditsSummary());
    },
  },
  {
    operation: 'organization.billing.history',
    method: 'GET',
    path: new RegExp(`^${ORG}/billing/history$`),
    handle(ctx, match) {
      const org = editableOrgFor(ctx, match);
      if (org) respond(ctx, 200, { charges: [], nextCursor: null });
    },
  },
  {
    operation: 'organization.billing.credits.ledger',
    method: 'GET',
    path: new RegExp(`^${ORG}/billing/credits/ledger$`),
    handle(ctx, match) {
      const org = orgFor(ctx, match);
      if (org) respond(ctx, 200, { email: CLOUD_ACCOUNT.email, entries: [] });
    },
  },
  {
    operation: 'organization.billing.invoices',
    method: 'GET',
    path: new RegExp(`^${ORG}/billing/invoices$`),
    handle(ctx, match) {
      const org = editableOrgFor(ctx, match);
      if (org) respond(ctx, 200, invoicePage());
    },
  },
];

/** Operation names this mock serves, for specs and tests. */
export const HOSTED_SETTINGS_MOCK_OPERATIONS = Object.freeze(
  OPERATION_ROUTES.map((route) => route.operation),
);

/* -------------------------------------------------------------------------- */
/* Feed stream                                                                 */
/* -------------------------------------------------------------------------- */

function parseLastEventId(request) {
  const raw = header(request, 'last-event-id');
  return typeof raw === 'string' && /^\d+$/.test(raw.trim())
    ? Number(raw.trim())
    : null;
}

function handleStream(ctx, organizationId) {
  recordOperation(ctx, 'organization.feed.stream');
  const config = isRecord(configForKey(ctx.key).feed)
    ? configForKey(ctx.key).feed
    : {};
  const org = ctx.state.orgOrder.includes(organizationId)
    ? ctx.state.organizations[organizationId]
    : undefined;
  const feed = ctx.state.feeds[organizationId];
  if (org === undefined || feed === undefined || config.stream === 'disabled') {
    respond(ctx, 404, { error: 'Not found' });
    return;
  }
  const reconnecting = feed.connections > 0;
  feed.connections += 1;
  feed.lastEventIds.push(ctx.entry.lastEventId);
  if (reconnecting && config.reconnect === 'unauthorized') {
    respond(ctx, 401, { error: 'Authentication required' });
    return;
  }
  if (reconnecting && config.reconnect === 'forbidden') {
    respond(ctx, 403, { error: 'Forbidden' });
    return;
  }

  ctx.entry.status = 200;
  ctx.response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  ctx.response.write(`retry: ${STREAM_RETRY_ADVICE_MS}\n: connected\n\n`);
  feed.openStreams += 1;

  const cursor = parseLastEventId(ctx.request);
  let lastSent = cursor ?? feed.events.at(-1)?.sequence ?? 0;
  // Scripted items arrive live on the first connection.
  const scripted = feed.scriptedPending.splice(0);
  const scriptedThrough =
    scripted.length === 0
      ? null
      : scripted.map((item) => appendFeedEvent(feed, item)).at(-1).sequence;
  const dropAfterScripted =
    !reconnecting &&
    config.dropAfterScripted === true &&
    scriptedThrough !== null;

  let closed = false;
  const end = () => {
    if (!ctx.response.writableEnded) ctx.response.end();
  };
  const flush = () => {
    if (closed || ctx.response.destroyed || ctx.response.writableEnded) return;
    // A cleared or re-registered scenario ends the stream.
    if (stateForKey(ctx.key) !== ctx.state) {
      end();
      return;
    }
    for (const event of feed.events) {
      if (event.sequence > lastSent) {
        ctx.response.write(formatFeedFrame(event));
        lastSent = event.sequence;
      }
    }
    if (dropAfterScripted && lastSent >= scriptedThrough) end();
  };
  const timer = setInterval(flush, STREAM_POLL_MS);
  timer.unref?.();
  feed.enders.add(end);
  flush();
  ctx.response.on('close', () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    feed.enders.delete(end);
    feed.openStreams -= 1;
  });
}

/* -------------------------------------------------------------------------- */
/* Session-authenticated dispatch                                              */
/* -------------------------------------------------------------------------- */

function isSessionPath(pathname) {
  return SESSION_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function logUnauthenticated(request, url) {
  unauthenticatedRequests.push({
    at: new Date().toISOString(),
    method: request.method,
    path: `${url.pathname}${url.search}`,
  });
  if (unauthenticatedRequests.length > UNAUTHENTICATED_LOG_CAP) {
    unauthenticatedRequests.shift();
  }
}

async function handleSessionRequest(request, response, url) {
  const token = sessionToken(request);
  const key = token === undefined ? undefined : sessionOwners.get(token);
  const state = key === undefined ? null : stateForKey(key);
  if (state === null) {
    logUnauthenticated(request, url);
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'Authentication required' }));
    return;
  }

  const ctx = createContext(request, response, url, key, state);
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    ctx.body = await readJsonBody(request);
    ctx.entry.body = clone(ctx.body);
  }
  if (!state.sessions.has(token)) {
    recordOperation(ctx, 'session.rejected');
    respond(ctx, 401, { error: 'Authentication required' });
    return;
  }
  ctx.entry.authenticated = true;

  const { pathname } = url;
  if (state.twoFactorUser) {
    const proof = parseCookies(request)[HOSTED_SETTINGS_TWO_FACTOR_COOKIE];
    if (!proof || !state.proofs.has(decodeURIComponent(proof))) {
      recordOperation(ctx, 'session.twoFactorRequired');
      respond(ctx, 403, { error: 'Two-factor authentication required' });
      return;
    }
  }
  // Better Auth's origin check: `/api/auth/*` needs the trusted `Origin`.
  if (
    pathname.startsWith('/api/auth/') &&
    ctx.entry.origin !== requestOrigin(request, url)
  ) {
    recordOperation(ctx, 'auth.invalidOrigin');
    respond(ctx, 403, { code: 'INVALID_ORIGIN', message: 'Invalid origin' });
    return;
  }
  if (FINANCIAL_PATH.test(pathname)) {
    ctx.entry.financial = true;
    recordOperation(ctx, 'financial');
    respond(ctx, 404, { error: 'Payment routes are not part of the mock' });
    return;
  }

  const stream = /^\/api\/account\/organizations\/([^/]+)\/stream$/.exec(
    pathname,
  );
  if (stream && request.method === 'GET') {
    handleStream(ctx, decodeURIComponent(stream[1]));
    return;
  }

  for (const route of OPERATION_ROUTES) {
    if (route.method !== request.method) continue;
    const match = route.path.exec(pathname);
    if (!match || (route.when !== undefined && !route.when(ctx))) continue;
    recordOperation(ctx, route.operation);
    const config = configForKey(key);
    const delayMs = config.operationDelaysMs?.[route.operation];
    if (typeof delayMs === 'number' && delayMs > 0) await delay(delayMs);
    const failure = config.operationErrors?.[route.operation];
    if (isRecord(failure)) {
      respond(
        ctx,
        failure.status ?? 500,
        failure.body ?? { error: 'Scripted failure' },
      );
      return;
    }
    await route.handle(ctx, match);
    return;
  }

  recordOperation(ctx, 'unmatched');
  respond(ctx, 404, { error: `Unhandled hosted settings route: ${pathname}` });
}

/* -------------------------------------------------------------------------- */
/* Control routes                                                              */
/* -------------------------------------------------------------------------- */

function controlJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function feedSummary(state) {
  const summary = {};
  for (const [id, feed] of Object.entries(state.feeds)) {
    summary[id] = {
      connections: feed.connections,
      openStreams: feed.openStreams,
      lastEventIds: [...feed.lastEventIds],
      events: feed.events.map((event) => ({
        sequence: event.sequence,
        eventId: event.eventId,
        itemId: event.item.id,
      })),
    };
  }
  return summary;
}

async function handleControl(request, response, match) {
  const key = decodeURIComponent(match[1]);
  const subpath = match[2] ?? '';
  const state = stateForKey(key);
  if (!state) {
    controlJson(response, 404, {
      error: `No hostedSettings scenario registered for ${key}.`,
    });
    return;
  }
  const method = request.method;

  if (method === 'GET' && subpath === '/requests') {
    controlJson(response, 200, {
      requests: clone(state.requests),
      mints: clone(state.mints),
      consumes: clone(state.consumes),
      signOuts: state.signOuts,
      activeSessions: state.sessions.size,
      feeds: feedSummary(state),
    });
    return;
  }
  if (method === 'GET' && subpath === '/state') {
    controlJson(response, 200, {
      viewer: clone(state.viewer),
      profile: clone(state.profile),
      publicProfile: clone(state.publicProfile),
      digestPreferences: clone(state.digestPreferences),
      pushPreferences: clone(state.pushPreferences),
      apiKeys: clone(state.apiKeys),
      invites: clone(state.invites),
      incomingInvitations: clone(state.incomingInvitations),
      organizations: state.orgOrder.map((id) => ({
        ...organizationDetail(state.organizations[id]),
        config: clone(state.organizations[id].config),
      })),
    });
    return;
  }
  if (method !== 'POST') {
    controlJson(response, 404, {
      error: `Unhandled hosted-settings control route: ${method} ${subpath}`,
    });
    return;
  }

  const parsed = await readJsonBody(request);
  const body = parsed === undefined ? {} : parsed;
  if (!isRecord(body)) {
    controlJson(response, 400, { error: 'Expected a JSON object body.' });
    return;
  }

  if (subpath === '/sessions/expire') {
    const expired = state.sessions.size;
    state.sessions.clear();
    controlJson(response, 200, { ok: true, expired });
    return;
  }

  const organizationId = body.organizationId ?? HOSTED_SETTINGS_ORG_IDS.owner;
  const feed = state.feeds[organizationId];
  if (subpath === '/feed' || subpath === '/feed/close') {
    if (feed === undefined) {
      controlJson(response, 404, {
        error: `No organization ${organizationId} for ${key}.`,
      });
      return;
    }
  }
  if (subpath === '/feed') {
    if (!Array.isArray(body.items) || body.items.length === 0) {
      controlJson(response, 400, { error: 'Expected items: FeedItem[].' });
      return;
    }
    const events = body.items.map((item) =>
      appendFeedEvent(feed, feedItem(isRecord(item) ? item : {})),
    );
    controlJson(response, 200, {
      ok: true,
      sequences: events.map((event) => event.sequence),
    });
    return;
  }
  if (subpath === '/feed/close') {
    const closed = feed.enders.size;
    for (const end of [...feed.enders]) end();
    controlJson(response, 200, { ok: true, closed });
    return;
  }

  controlJson(response, 404, {
    error: `Unhandled hosted-settings control route: ${method} ${subpath}`,
  });
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Handle a hosted settings request. Returns `true` when answered. Auth-link
 * routes for keys without a `hostedSettings` slice return `false`, so the
 * cloud surface keeps answering them.
 */
export async function handleHostedSettingsRequest(request, response, url) {
  const { pathname } = url;
  const method = request.method;

  if (method === 'GET' && pathname === UNAUTHENTICATED_LOG_PATH) {
    controlJson(response, 200, { requests: clone(unauthenticatedRequests) });
    return true;
  }
  const control = CONTROL_PATH.exec(pathname);
  if (control) {
    await handleControl(request, response, control);
    return true;
  }

  const mint = MINT_PATH.exec(pathname);
  if (mint && method === 'POST') {
    return handleMint(request, response, url, mint[1]);
  }
  if (CONSUME_PATH.test(pathname) && method === 'GET') {
    return handleConsume(request, response, url);
  }

  if (isSessionPath(pathname)) {
    await handleSessionRequest(request, response, url);
    return true;
  }
  return false;
}

/** Test seam: forget every minted code and session. */
export function resetHostedSettingsSessions() {
  codeOwners.clear();
  sessionOwners.clear();
  unauthenticatedRequests.length = 0;
}
