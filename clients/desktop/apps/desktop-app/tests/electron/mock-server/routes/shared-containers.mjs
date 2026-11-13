import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  getScenario,
  keyFromBearer,
  recordScenarioActivity,
} from '../control-plane.mjs';
import {
  isSharedContainersCloudApiKey,
  SHARED_CONTAINERS_CLOUD_API_KEY_PREFIX,
} from '../../sharedContainersCloudFixtureKey.mjs';

export const SHARED_CONTAINERS_CLOUD_API_KEY =
  SHARED_CONTAINERS_CLOUD_API_KEY_PREFIX;
export const SHARED_CONTAINERS_ORGANIZATION_ID =
  '77777777-7777-4777-8777-777777777777';
export const SHARED_CONTAINERS_ORGANIZATION_NAME = 'Shared Containers E2E';
/** The one team of the fixture organization; Ada is its only member. */
export const SHARED_CONTAINERS_TEAM_ID = '88888888-8888-4888-8888-888888888888';

const NOW = '2026-08-01T12:00:00.000Z';
const OWNER = {
  userId: '99999999-9999-4999-8999-999999999999',
  name: 'Mock Owner',
};
const MEMBERS = [
  {
    userId: '11111111-1111-4111-8111-111111111111',
    name: 'Ada Lovelace',
    teamIds: [SHARED_CONTAINERS_TEAM_ID],
  },
  {
    userId: '22222222-2222-4222-8222-222222222222',
    name: 'Grace Hopper',
    teamIds: [],
  },
];

/** 32 random bytes, base64url: the same shape the web service mints. */
function newLinkToken() {
  return randomBytes(32).toString('base64url');
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * The organization's member roster, overridable per scenario.
 *
 * A scenario may pass `sharedContainers: { members: [...] }` to model an
 * organization the default roster cannot: an empty array is the owner alone,
 * which is the only way to reach the "You're the only person in {org}" empty
 * state. A member may carry `teamIds` to take part in the Team audience's
 * `teamId` filter.
 */
function membersFor(key) {
  const configured = getScenario(key)?.sharedContainers?.members;
  return Array.isArray(configured) ? configured : MEMBERS;
}

/** The wire member summary: `teamIds` is fixture-only and never returned. */
function memberSummary(member) {
  return {
    userId: member.userId,
    name: member.name,
    ...(member.image ? { image: member.image } : {}),
  };
}

/**
 * Whether the fixture organization allows sharing outside it. Mirrors the
 * server default (off); `sharedContainers.allowExternalContainerSharing: true`
 * turns it on. The cloud account route reports the same value on the
 * organization summary.
 */
export function sharedContainersAllowExternalSharing(key) {
  return (
    getScenario(key)?.sharedContainers?.allowExternalContainerSharing === true
  );
}

/**
 * Owner-facing and recipient-facing container ref. Seeded scenario containers
 * predate `owner`/`access`, so they are filled in here: an organization
 * container reads as organization access, one without an organization as a
 * direct (personal) share. A seeded owner keeps its own name when it is on
 * the scenario's roster (a recipient fixture shares from Ada Lovelace), and
 * reads as the mock owner otherwise.
 */
function containerRef(container, members, request) {
  const organizationId = container.organizationId ?? undefined;
  const ownerUserId = container.ownerUserId ?? OWNER.userId;
  const rosterOwner = members.find((member) => member.userId === ownerUserId);
  return {
    ...container,
    ...(container.latestRevision
      ? { latestRevision: revisionForClient(request, container.latestRevision) }
      : {}),
    owner:
      container.owner ??
      (rosterOwner
        ? memberSummary(rosterOwner)
        : { userId: ownerUserId, name: OWNER.name }),
    ...(organizationId !== undefined
      ? {
          organizationName:
            container.organizationName ?? SHARED_CONTAINERS_ORGANIZATION_NAME,
        }
      : {}),
    access:
      container.access ??
      (organizationId === undefined ? 'direct' : 'organization'),
  };
}

/**
 * `organizationId` is an optional ownership hint on every container-scoped
 * route: absent is accepted, present must match the container.
 */
function organizationHintMatches(hint, container) {
  return hint === null || hint === (container.organizationId ?? null);
}

function jsonResponse(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function readJsonBody(request) {
  return new Promise((resolve) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      try {
        resolve(raw.trim() ? JSON.parse(raw) : undefined);
      } catch {
        resolve(undefined);
      }
    });
    request.on('error', () => resolve(undefined));
  });
}

function revisionForClient(request, revision) {
  if (!revision || Number(request.headers['x-pipeline-package-version']) >= 5)
    return revision;
  const { package: ignored, ...legacy } = revision;
  return legacy;
}

/**
 * The `revision.package` summary the server derives from a committed package.
 * Exported so a recipient replica can be seeded with the same metadata the
 * listing reports for that revision.
 */
export function sharedContainerPackageMetadata(download) {
  return packageMetadata(download);
}

// Mirrors summarizeSharedContainerCapabilityPackage: plugin skills, commands
// and agents are carried but a copy does not install them, so they are
// neither counted nor listed as runnable scripts.
const PLUGIN_MEMBER_KINDS = new Set([
  'plugin_skill',
  'plugin_command',
  'plugin_agent',
]);

function packageMetadata(download) {
  const counts = {
    skills: 0,
    pipelines: 0,
    agents: 0,
    automations: 0,
    hooks: 0,
  };
  const executableFiles = new Set();
  const twins = new Map();
  for (const resource of download.manifest.resources) {
    if (PLUGIN_MEMBER_KINDS.has(resource.kind)) continue;
    const category = {
      standalone_skill: 'skills',
      agent_definition: 'agents',
      pipeline_definition: 'pipelines',
      automation_definition: 'automations',
      hook_definition: 'hooks',
    }[resource.kind];
    const key = JSON.stringify([
      resource.kind,
      resource.sourceLabel,
      resource.sourceVisibility,
      resource.trees.map((tree) => tree.rootName).sort(),
    ]);
    const providers = new Set(resource.trees.map((tree) => tree.provider));
    const groups = twins.get(key) ?? [];
    const twin =
      resource.kind === 'standalone_skill' &&
      groups.find((group) =>
        [...providers].every((provider) => !group.has(provider)),
      );
    if (twin) for (const provider of providers) twin.add(provider);
    else {
      if (category) counts[category] += 1;
      groups.push(providers);
      twins.set(key, groups);
    }
    for (const tree of resource.trees)
      for (const entry of tree.entries) {
        if (entry.mode === 'execute')
          executableFiles.add(`${tree.rootName}/${entry.path}`);
      }
  }
  return {
    digest: download.digest,
    counts,
    executableFiles: [...executableFiles].sort(),
  };
}

function packageAttachmentValid(body) {
  if (body.carryParentPackage !== undefined)
    return (
      body.carryParentPackage === true &&
      typeof body.parentRevisionId === 'string' &&
      !body.capabilityPackage &&
      body.committedPackageUploadId === undefined
    );
  if (
    body.capabilityPackage === undefined &&
    body.committedPackageUploadId === undefined
  )
    return true;
  return (
    body.capabilityPackage?.version === 1 &&
    /^pp:v1:[A-Za-z0-9_-]{43}$/.test(body.capabilityPackage.digest) &&
    typeof body.committedPackageUploadId === 'string'
  );
}

function stateFor(request) {
  return stateForKey(keyFromBearer(request));
}

function stateForKey(key) {
  const scenario = getScenario(key);
  scenario.sharedContainersState ??= {
    containers: [],
    grants: [],
    stagedRevisions: [],
    nextContainer: 1,
    nextGrant: 1,
    nextRevision: 1,
  };
  return scenario.sharedContainersState;
}

/**
 * Shares the recipient removed, newest first, each kept with its grants so a
 * restore puts back exactly what the dismiss took. Seeded state may omit it.
 */
function dismissedFor(state) {
  state.dismissed ??= [];
  return state.dismissed;
}

function dismissalNotFound(response) {
  jsonResponse(response, 404, {
    error: 'Shared container not found',
    code: 'shared-container-dismissal-not-found',
  });
}

function inboxStreamSnapshot(state) {
  return new Map(
    state.containers.map((container) => [container.id, container.revision]),
  );
}

function changedInboxContainers(previous, state) {
  return state.containers.filter(
    (container) => previous.get(container.id) !== container.revision,
  );
}

function ciphertextLengthFor(plaintextSizeBytes) {
  const chunkSize = 1024 * 1024;
  const chunkCount = Math.max(1, Math.ceil(plaintextSizeBytes / chunkSize));
  return 33 + plaintextSizeBytes + chunkCount * 16;
}

function consumeBody(request) {
  return new Promise((resolve) => {
    request.on('data', () => undefined);
    request.on('end', resolve);
    request.on('error', resolve);
  });
}

/** Listings a signed-in key outside the fixture reads as empty. */
const SIGNED_IN_EMPTY_LISTINGS = new Set([
  '/api/v1/shared-containers/shared-with-me',
  '/api/v1/shared-containers/shared-by-me',
  '/api/v1/shared-containers/dismissed',
]);

function requireFixtureKey(request, response) {
  if (isSharedContainersCloudApiKey(keyFromBearer(request))) return true;
  jsonResponse(response, 401, { error: 'Invalid API key.' });
  return false;
}

function containerSummary(state, body) {
  const suffix = String(state.nextContainer++).padStart(12, '0');
  const personal = body.organizationId === undefined;
  return {
    id: `33333333-3333-4333-8333-${suffix}`,
    ...(personal ? {} : { organizationId: body.organizationId }),
    ownerUserId: OWNER.userId,
    owner: OWNER,
    ...(personal
      ? {}
      : { organizationName: SHARED_CONTAINERS_ORGANIZATION_NAME }),
    access: personal ? 'direct' : 'organization',
    worktreeId: body.worktreeId,
    containerType: body.worktreeId.startsWith('bbbb')
      ? 'COWORK_WORK_ENTRY'
      : 'CODE_WORKTREE',
    title: body.worktreeId.startsWith('bbbb') ? 'Shared Work Entry' : 'main',
    revision: 0,
    createdAt: NOW,
    updatedAt: NOW,
    capabilities: ['VIEW'],
  };
}

/**
 * An email recipient always renders as that address with `status: 'invited'`,
 * whether or not an account exists, exactly like the server: the owner must
 * not learn who has an account.
 */
function grantSummary(state, containerId, recipient, capabilities) {
  const suffix = String(state.nextGrant++).padStart(12, '0');
  return {
    id: `44444444-4444-4444-8444-${suffix}`,
    containerId,
    recipient:
      recipient.kind === 'email'
        ? { kind: 'email', email: recipient.email, status: 'invited' }
        : {
            kind: 'member',
            ...memberSummary(
              MEMBERS.find((member) => member.userId === recipient.userId),
            ),
          },
    capabilities,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** Canonical recipient from the request body; accepts the legacy alias. */
function requestRecipient(body) {
  if (
    typeof body?.recipientUserId === 'string' &&
    body.recipient === undefined
  ) {
    return { kind: 'member', userId: body.recipientUserId };
  }
  const recipient = body?.recipient;
  if (recipient?.kind === 'member' && typeof recipient.userId === 'string') {
    return { kind: 'member', userId: recipient.userId };
  }
  if (recipient?.kind === 'email' && typeof recipient.email === 'string') {
    const email = recipient.email.trim().toLowerCase();
    return email.includes('@') ? { kind: 'email', email } : null;
  }
  return null;
}

function sameRecipient(grant, recipient) {
  // Seeded grants predate the `kind` discriminant; they are members.
  const kind = grant.recipient?.kind ?? 'member';
  if (kind !== recipient.kind) return false;
  return recipient.kind === 'email'
    ? grant.recipient.email === recipient.email
    : grant.recipient.userId === recipient.userId;
}

/** Seeded grants predate the `kind` discriminant; they are members. */
function grantResponse(grant) {
  return grant.recipient && grant.recipient.kind === undefined
    ? { ...grant, recipient: { kind: 'member', ...grant.recipient } }
    : grant;
}

export async function handleSharedContainersRequest(request, response, url) {
  const { pathname } = url;
  if (
    !pathname.startsWith('/api/v1/shared-containers') &&
    !pathname.startsWith('/api/v1/shared-container-links')
  ) {
    return false;
  }

  const uploadMatch =
    /^\/api\/v1\/shared-containers\/([^/]+)\/revisions\/uploads\/([^/]+)$/.exec(
      pathname,
    );
  if (uploadMatch && request.method === 'PUT') {
    const scenarioKey = url.searchParams.get('scenarioKey');
    if (!scenarioKey) {
      jsonResponse(response, 401, { error: 'Invalid upload target.' });
      return true;
    }
    await consumeBody(request);
    recordScenarioActivity(scenarioKey, 'sharedContainersUpload');
    response.writeHead(200);
    response.end();
    return true;
  }

  if (/\/revisions\/[^/]+\/package(?:\/|$)/.test(pathname))
    response.setHeader('Cache-Control', 'no-store');

  // Every mock account advertises `shared-containers-v1`, so the sidebar of
  // any signed-in spec reads these listings. Outside the fixture they are
  // empty, not a 401 the sidebar would render as a load failure.
  const signedInKey = keyFromBearer(request);
  if (
    request.method === 'GET' &&
    SIGNED_IN_EMPTY_LISTINGS.has(pathname) &&
    signedInKey &&
    !isSharedContainersCloudApiKey(signedInKey)
  ) {
    jsonResponse(response, 200, { containers: [], nextCursor: null });
    return true;
  }

  if (!requireFixtureKey(request, response)) return true;

  const key = keyFromBearer(request);
  const method = request.method;
  const state = stateFor(request);
  const organizationId = url.searchParams.get('organizationId');

  if (
    pathname === '/api/v1/shared-containers/shared-with-me/stream' &&
    method === 'GET'
  ) {
    if (getScenario(key)?.sharedContainers?.stream !== 'enabled') {
      jsonResponse(response, 404, { error: 'Not found.' });
      return true;
    }

    let snapshot = inboxStreamSnapshot(state);
    let eventId = 0;
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    response.write('retry: 60000\n: connected\n\n');
    const timer = setInterval(() => {
      const latest = stateForKey(key);
      const changed = changedInboxContainers(snapshot, latest);
      snapshot = inboxStreamSnapshot(latest);
      for (const container of changed) {
        eventId += 1;
        response.write(
          `id: mock-inbox-${eventId}\nevent: sharedcontainer.detail\ndata: ${JSON.stringify(
            {
              payload: {
                containerId: container.id,
                revision: container.revision,
              },
            },
          )}\n\n`,
        );
      }
    }, 250);
    timer.unref?.();
    request.on('close', () => clearInterval(timer));
    return true;
  }

  if (pathname === '/api/v1/shared-containers' && method === 'POST') {
    const body = await readJsonBody(request);
    const recipient = requestRecipient(body);
    const inviteDelayMs =
      getScenario(key)?.sharedContainers?.inviteDelayMs ?? 0;
    if (typeof inviteDelayMs === 'number' && inviteDelayMs > 0) {
      await delay(inviteDelayMs);
    }
    const inviteError = getScenario(key)?.sharedContainers?.inviteError;
    if (inviteError) {
      recordScenarioActivity(key, 'sharedContainersInviteError');
      jsonResponse(
        response,
        inviteError.status ?? 500,
        inviteError.body ?? { error: 'Shared container invite failed.' },
      );
      return true;
    }
    // No `organizationId` creates a personal container, which only takes
    // email (direct) recipients. A member grant needs the organization.
    const personal = body?.organizationId === undefined;
    if (
      (!personal &&
        body?.organizationId !== SHARED_CONTAINERS_ORGANIZATION_ID) ||
      typeof body?.worktreeId !== 'string' ||
      !recipient ||
      (recipient.kind === 'member' &&
        (personal ||
          !MEMBERS.some((member) => member.userId === recipient.userId))) ||
      !Array.isArray(body?.capabilities)
    ) {
      jsonResponse(response, 400, { error: 'Invalid request.' });
      return true;
    }
    if (
      recipient.kind === 'email' &&
      !personal &&
      !sharedContainersAllowExternalSharing(key)
    ) {
      recordScenarioActivity(key, 'sharedContainersExternalSharingRefused');
      jsonResponse(response, 403, {
        error: 'This organization does not allow sharing outside it.',
        code: 'external-sharing-disabled',
      });
      return true;
    }
    let container = state.containers.find(
      (candidate) => candidate.worktreeId === body.worktreeId,
    );
    if (!container) {
      container = containerSummary(state, body);
      state.containers.push(container);
    }
    let grant = state.grants.find(
      (candidate) =>
        candidate.containerId === container.id &&
        sameRecipient(candidate, recipient),
    );
    if (!grant) {
      grant = grantSummary(state, container.id, recipient, body.capabilities);
      state.grants.push(grant);
    }
    recordScenarioActivity(
      key,
      recipient.kind === 'email'
        ? 'sharedContainersCreateEmail'
        : 'sharedContainersCreate',
    );
    jsonResponse(response, 201, {
      container: containerRef(container, membersFor(key), request),
      grant: grantResponse(grant),
    });
    return true;
  }

  if (pathname === '/api/v1/shared-containers/members' && method === 'GET') {
    const query = (url.searchParams.get('q') ?? '').toLowerCase();
    // Team audience: only members of that team of the organization.
    const teamId = url.searchParams.get('teamId');
    recordScenarioActivity(key, 'sharedContainersMembers');
    jsonResponse(response, 200, {
      members: membersFor(key)
        .filter(
          (member) =>
            (member.userId.toLowerCase() === query ||
              member.name.toLowerCase().includes(query)) &&
            (teamId === null ||
              (Array.isArray(member.teamIds) &&
                member.teamIds.includes(teamId))),
        )
        .map(memberSummary),
    });
    return true;
  }

  if (
    (pathname === '/api/v1/shared-containers/shared-by-me' ||
      pathname === '/api/v1/shared-containers/shared-with-me') &&
    method === 'GET'
  ) {
    // CAN-2551. This branch used to always 200, so a listing failure could not
    // be exercised at all. `sharedContainers.sharedWithMeError` scripts one:
    // either a shorthand string ('blocked-by-org-billing' -> the real 403 the
    // server sends for a lapsed org) or an explicit `{ status, body }`.
    // Deliberately scoped to `shared-with-me` only, so `shared-by-me` keeps
    // its existing unconditional behavior.
    const sharedWithMeError =
      pathname === '/api/v1/shared-containers/shared-with-me'
        ? getScenario(key)?.sharedContainers?.sharedWithMeError
        : undefined;
    if (sharedWithMeError) {
      // Fail loudly on an unrecognized shorthand. Without this, a typo'd string
      // ('blocked-by-billing', say) falls through to `scripted.status ?? 500`
      // on a plain string, which silently yields a generic 500 — the spec still
      // "passes" while exercising a completely different branch than the author
      // intended.
      if (
        typeof sharedWithMeError === 'string' &&
        sharedWithMeError !== 'blocked-by-org-billing'
      ) {
        jsonResponse(response, 500, {
          error: `Unknown sharedWithMeError shorthand: ${sharedWithMeError}. Use 'blocked-by-org-billing' or an explicit { status, body }.`,
        });
        return true;
      }
      const scripted =
        sharedWithMeError === 'blocked-by-org-billing'
          ? {
              status: 403,
              body: {
                error:
                  "Your organization's trial has ended. Subscribe to Business to restore team features.",
                code: 'blocked-by-org-billing',
              },
            }
          : sharedWithMeError;
      jsonResponse(
        response,
        scripted.status ?? 500,
        scripted.body ?? {
          error: 'Shared container listing failed.',
        },
      );
      return true;
    }
    // Without `organizationId`, shared-by-me lists personal containers and
    // shared-with-me lists direct shares (email or outside-organization
    // grants). An organization listing never includes direct shares.
    const direct = organizationId === null;
    const byMe = pathname === '/api/v1/shared-containers/shared-by-me';
    recordScenarioActivity(
      key,
      direct
        ? byMe
          ? 'sharedContainersListPersonalByMe'
          : 'sharedContainersListDirectWithMe'
        : byMe
          ? 'sharedContainersListOrganizationByMe'
          : 'sharedContainersListOrganizationWithMe',
    );
    const members = membersFor(key);
    const containers = state.containers
      // A container reachable only through its link is not shared with this
      // account until the link is claimed.
      .filter((container) => byMe || container.linkOnly !== true)
      .map((container) => containerRef(container, members, request))
      .filter((container) =>
        direct
          ? byMe
            ? container.organizationId === undefined
            : container.access === 'direct'
          : container.organizationId === organizationId &&
            container.access !== 'direct',
      );
    for (const container of containers) {
      recordScenarioActivity(key, `sharedContainersListed:${container.id}`);
    }
    jsonResponse(response, 200, {
      containers,
      nextCursor: null,
    });
    return true;
  }

  const recipientsMatch =
    /^\/api\/v1\/shared-containers\/([^/]+)\/recipients$/.exec(pathname);
  if (recipientsMatch && method === 'GET') {
    jsonResponse(response, 200, {
      recipients: [
        ...state.grants
          .filter((grant) => grant.containerId === recipientsMatch[1])
          .map(grantResponse),
        // The owner still sees a recipient who removed the share, revoke-only.
        ...dismissedFor(state)
          .filter((entry) => entry.container.id === recipientsMatch[1])
          .flatMap((entry) =>
            entry.grants.map((grant) => ({
              ...grantResponse(grant),
              dismissedAt: entry.dismissedAt,
            })),
          ),
      ],
      nextCursor: null,
    });
    return true;
  }

  // Revoke one grant or pending email invite by grant id. Email recipients
  // expose no user id, so this is the desktop's only revoke route.
  const grantMatch =
    /^\/api\/v1\/shared-containers\/([^/]+)\/grants\/([^/]+)$/.exec(pathname);
  if (grantMatch && method === 'DELETE') {
    const container = state.containers.find(
      (candidate) => candidate.id === grantMatch[1],
    );
    const grant = state.grants.find(
      (candidate) =>
        candidate.containerId === grantMatch[1] &&
        candidate.id === grantMatch[2],
    );
    // Revoking a recipient who removed the share deletes what they could
    // restore from; their next restore answers 404.
    const dismissedEntry = dismissedFor(state).find(
      (entry) =>
        entry.container.id === grantMatch[1] &&
        organizationHintMatches(organizationId, entry.container),
    );
    if (!container && dismissedEntry) {
      if (!dismissedEntry.grants.some((entry) => entry.id === grantMatch[2])) {
        jsonResponse(response, 404, {
          error: 'Grant not found.',
          code: 'shared-container-grant-not-found',
        });
        return true;
      }
      state.dismissed = state.dismissed.filter(
        (entry) => entry !== dismissedEntry,
      );
      recordScenarioActivity(key, 'sharedContainersRevoke');
      response.writeHead(204);
      response.end();
      return true;
    }
    if (!container || !organizationHintMatches(organizationId, container)) {
      jsonResponse(response, 404, { error: 'Not found.' });
      return true;
    }
    if (!grant) {
      jsonResponse(response, 404, {
        error: 'Grant not found.',
        code: 'shared-container-grant-not-found',
      });
      return true;
    }
    state.grants = state.grants.filter((candidate) => candidate !== grant);
    recordScenarioActivity(key, 'sharedContainersRevoke');
    response.writeHead(204);
    response.end();
    return true;
  }

  const dismissMatch = /^\/api\/v1\/shared-containers\/([^/]+)\/dismiss$/.exec(
    pathname,
  );
  if (dismissMatch && method === 'DELETE') {
    const container = state.containers.find(
      (candidate) => candidate.id === dismissMatch[1],
    );
    if (!container || !organizationHintMatches(organizationId, container)) {
      jsonResponse(response, 404, { error: 'Not found.' });
      return true;
    }
    // Recoverable (CAN-4052): the share and its grants move aside instead of
    // being dropped, so `…/restore` can put them back.
    state.dismissed = [
      {
        container,
        grants: state.grants.filter(
          (grant) => grant.containerId === dismissMatch[1],
        ),
        dismissedAt: new Date().toISOString(),
      },
      ...dismissedFor(state).filter(
        (entry) => entry.container.id !== dismissMatch[1],
      ),
    ];
    state.containers = state.containers.filter(
      (candidate) => candidate.id !== dismissMatch[1],
    );
    state.grants = state.grants.filter(
      (grant) => grant.containerId !== dismissMatch[1],
    );
    recordScenarioActivity(key, 'sharedContainersDismiss');
    response.writeHead(204);
    response.end();
    return true;
  }

  if (pathname === '/api/v1/shared-containers/dismissed' && method === 'GET') {
    recordScenarioActivity(key, 'sharedContainersListDismissed');
    const members = membersFor(key);
    // Scoped like shared-with-me: an organization lists its own removed
    // shares, no organization lists the direct ones.
    const entries = dismissedFor(state)
      .map((entry) => ({
        ...containerRef(entry.container, members, request),
        dismissedAt: entry.dismissedAt,
      }))
      .filter((container) =>
        organizationId === null
          ? container.access === 'direct'
          : container.organizationId === organizationId &&
            container.access !== 'direct',
      );
    const requestedLimit = Number(url.searchParams.get('limit') ?? 20);
    const limit =
      Number.isInteger(requestedLimit) && requestedLimit > 0
        ? requestedLimit
        : 20;
    // The cursor is the id of the last container already returned.
    const cursor = url.searchParams.get('cursor');
    const start = cursor
      ? entries.findIndex((container) => container.id === cursor) + 1
      : 0;
    const containers = entries.slice(start, start + limit);
    jsonResponse(response, 200, {
      containers,
      nextCursor:
        start + limit < entries.length
          ? (containers[containers.length - 1]?.id ?? null)
          : null,
    });
    return true;
  }

  const restoreMatch = /^\/api\/v1\/shared-containers\/([^/]+)\/restore$/.exec(
    pathname,
  );
  if (restoreMatch && method === 'POST') {
    const entry = dismissedFor(state).find(
      (candidate) => candidate.container.id === restoreMatch[1],
    );
    const live = state.containers.find(
      (candidate) => candidate.id === restoreMatch[1],
    );
    const container = entry?.container ?? live;
    // One answer for "never removed", "owner revoked", and "wrong
    // organization", as on the real route.
    if (!container || !organizationHintMatches(organizationId, container)) {
      dismissalNotFound(response);
      return true;
    }
    if (entry) {
      state.dismissed = state.dismissed.filter(
        (candidate) => candidate !== entry,
      );
      // A restored share returns as a pending invitation; the inbox stream
      // reports it because the container reappears in `state.containers`.
      state.containers.push(entry.container);
      state.grants.push(...entry.grants);
    }
    recordScenarioActivity(key, 'sharedContainersRestore');
    jsonResponse(response, 200, {
      container: containerRef(container, membersFor(key), request),
    });
    return true;
  }

  const revokeMatch =
    /^\/api\/v1\/shared-containers\/([^/]+)\/recipients\/([^/]+)$/.exec(
      pathname,
    );
  if (revokeMatch && method === 'DELETE') {
    // Legacy by-user revoke; the desktop now revokes by grant id. It also
    // drops a removed share for the container, which lets a recipient spec
    // model "the owner revoked me" for a seeded share that has no grant row.
    state.dismissed = dismissedFor(state).filter(
      (entry) => entry.container.id !== revokeMatch[1],
    );
    state.grants = state.grants.filter(
      (grant) =>
        grant.containerId !== revokeMatch[1] ||
        grant.recipient.userId !== revokeMatch[2],
    );
    recordScenarioActivity(key, 'sharedContainersRevoke');
    response.writeHead(204);
    response.end();
    return true;
  }

  state.revisions ??= [];
  const revisionPackageMatch =
    /^\/api\/v1\/shared-containers\/([^/]+)\/revisions\/([^/]+)\/package(?:\/blobs\/([^/]+))?$/.exec(
      pathname,
    );
  if (revisionPackageMatch && method === 'GET') {
    response.setHeader('Cache-Control', 'no-store');
    const [, containerId, revisionId, sha256] = revisionPackageMatch;
    const container = state.containers.find(
      (entry) => entry.id === containerId,
    );
    const revision = state.revisions.find(
      (entry) =>
        entry.containerId === containerId && entry.revision.id === revisionId,
    );
    // Mirrors `resolveContainerAccess`: the owner, a grant holder, or, for an
    // organization share, any member of its organization (every fixture
    // account is a member of the one fixture organization).
    const hasAccess =
      container?.owner?.userId === OWNER.userId ||
      state.grants.some((grant) => grant.containerId === containerId) ||
      (container !== undefined &&
        containerRef(container, membersFor(key), request).access ===
          'organization');
    if (
      !container ||
      !hasAccess ||
      !organizationHintMatches(organizationId, container) ||
      !revision ||
      revision.retired ||
      !revision.packageDownload
    ) {
      jsonResponse(response, 404, { error: 'Revision package not found.' });
      return true;
    }
    const download = revision.packageDownload;
    const expected = url.searchParams.get('expectedPackageDigest');
    if (!/^pp:v1:[A-Za-z0-9_-]{43}$/.test(expected ?? '')) {
      jsonResponse(response, 400, {
        error: 'Expected package digest required.',
      });
      return true;
    }
    if (expected !== download.digest) {
      jsonResponse(response, 409, { error: 'Package digest mismatch.' });
      return true;
    }
    const kinds = download.manifest.resources.map((entry) => entry.kind);
    const required = kinds.some((kind) => kind.endsWith('_definition'))
      ? 5
      : kinds.some((kind) =>
            ['pipeline_action', 'child_pipeline'].includes(kind),
          )
        ? 4
        : download.manifest.bindings.some(
              (binding) => binding.target === 'subject',
            )
          ? 3
          : download.manifest.publisherNotes !== undefined
            ? 2
            : 1;
    if (!(Number(request.headers['x-pipeline-package-version']) >= required)) {
      jsonResponse(response, 426, {
        code: 'pipeline_package_client_upgrade_required',
        requiredPackageVersion: required,
      });
      return true;
    }
    if (sha256) {
      const belongs = download.manifest.resources.some((resource) =>
        resource.trees.some((tree) =>
          tree.entries.some((entry) => entry.sha256 === sha256),
        ),
      );
      const bytes = download.blobs?.[sha256];
      if (!belongs || !bytes) {
        jsonResponse(response, 404, { error: 'Package blob not found.' });
        return true;
      }
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      response.end(Buffer.from(bytes, 'base64'));
    } else
      jsonResponse(response, 200, {
        digest: download.digest,
        manifest: download.manifest,
      });
    return true;
  }
  const revisionMatch =
    /^\/api\/v1\/shared-containers\/([^/]+)\/revisions\/([^/]+)$/.exec(
      pathname,
    );
  if (revisionMatch && revisionMatch[2] !== 'latest' && method === 'GET') {
    const container = state.containers.find(
      (entry) => entry.id === revisionMatch[1],
    );
    const stored = state.revisions.find(
      (entry) =>
        entry.containerId === revisionMatch[1] &&
        entry.revision.id === revisionMatch[2],
    );
    if (
      !container ||
      !stored ||
      stored.retired ||
      !organizationHintMatches(organizationId, container)
    )
      jsonResponse(response, 404, { error: 'Revision not found.' });
    else
      jsonResponse(response, 200, {
        revision: revisionForClient(request, stored.revision),
      });
    return true;
  }

  const latestMatch =
    /^\/api\/v1\/shared-containers\/([^/]+)\/revisions\/latest$/.exec(pathname);
  if (latestMatch && method === 'GET') {
    const container = state.containers.find(
      (candidate) => candidate.id === latestMatch[1],
    );
    if (!container || !organizationHintMatches(organizationId, container)) {
      jsonResponse(response, 404, { error: 'Not found.' });
      return true;
    }
    recordScenarioActivity(key, 'sharedContainersResolveLatest');
    const detail = containerRef(container, membersFor(key), request);
    detail.latestRevision = revisionForClient(request, detail.latestRevision);
    jsonResponse(response, 200, detail);
    return true;
  }

  const stageMatch =
    /^\/api\/v1\/shared-containers\/([^/]+)\/revisions\/stage$/.exec(pathname);
  if (stageMatch && method === 'POST') {
    const body = await readJsonBody(request);
    const container = state.containers.find(
      (candidate) => candidate.id === stageMatch[1],
    );
    if (
      !container ||
      !organizationHintMatches(body?.organizationId ?? null, container) ||
      !Array.isArray(body?.artifacts) ||
      !packageAttachmentValid(body)
    ) {
      jsonResponse(response, 400, { error: 'Invalid request.' });
      return true;
    }
    state.stagedRevisions = state.stagedRevisions.filter(
      (entry) =>
        !entry.createdAt || entry.createdAt > Date.now() - 24 * 60 * 60 * 1_000,
    );
    const replay = state.stagedRevisions.find(
      (entry) => entry.stagingSessionId === body.idempotencyKey,
    );
    if (
      replay &&
      (replay.containerId !== container.id ||
        !isDeepStrictEqual(replay.request, body))
    ) {
      jsonResponse(response, 409, {
        error: 'Stage idempotency key is already in use.',
      });
      return true;
    }
    if (replay?.committedRevision) {
      jsonResponse(response, 409, {
        code: 'shared-container-stage-already-committed',
      });
      return true;
    }
    let packageDownload = replay?.packageDownload;
    if (!replay && body.parentRevisionId) {
      const parent = state.revisions.find(
        (entry) =>
          entry.containerId === container.id &&
          entry.revision.id === body.parentRevisionId &&
          !entry.retired,
      );
      if (!parent) {
        jsonResponse(response, 404, { error: 'Parent revision not found.' });
        return true;
      }
      if (body.carryParentPackage) {
        if (!parent.packageDownload) {
          jsonResponse(response, 422, {
            error: 'Parent package unavailable.',
            code: 'shared_container_parent_package_unavailable',
          });
          return true;
        }
        packageDownload = parent.packageDownload;
      }
    }
    if (!replay && body.capabilityPackage) {
      const upload =
        getScenario(key)?.sharedContainers?.packageUploads?.[
          body.committedPackageUploadId
        ];
      if (
        !upload ||
        upload.state !== 'COMMITTED' ||
        new Date(upload.expiresAt).getTime() <= Date.now() ||
        upload.digest !== body.capabilityPackage.digest
      ) {
        jsonResponse(response, 422, {
          error: 'Committed package upload is invalid or expired.',
          ...(upload?.state === 'COMMITTED' &&
          upload.digest === body.capabilityPackage.digest &&
          new Date(upload.expiresAt).getTime() <= Date.now()
            ? { code: 'shared_container_package_upload_expired' }
            : {}),
        });
        return true;
      }
      packageDownload = structuredClone(upload);
    }
    const revisionNumber = replay?.revisionNumber ?? state.nextRevision++;
    const revisionId = `55555555-5555-4555-8555-${String(revisionNumber).padStart(12, '0')}`;
    const stagingSessionId = body.idempotencyKey;
    if (!replay)
      state.stagedRevisions.push({
        containerId: container.id,
        revisionId,
        revisionNumber,
        stagingSessionId,
        request: body,
        createdAt: Date.now(),
        packageDownload,
      });
    const host = request.headers.host;
    const uploadTargets = body.artifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      target: {
        url: `http://${host}/api/v1/shared-containers/${container.id}/revisions/uploads/${artifact.artifactId}?scenarioKey=${encodeURIComponent(key)}`,
        method: 'PUT',
        headers: {
          'content-length': String(
            ciphertextLengthFor(Number(artifact.objectSizeBytes)),
          ),
          'x-goog-meta-plaintext-sha256': artifact.hash,
        },
        expiresAt: '2026-09-02T12:00:00.000Z',
      },
      key: {
        scheme: 'AES_256_GCM_CHUNKED_V1',
        dataKey: Buffer.alloc(32, 1).toString('base64'),
        aad: `artifact:${artifact.artifactId}`,
      },
    }));
    recordScenarioActivity(key, 'sharedContainersStage');
    jsonResponse(response, 200, {
      stagingSessionId,
      revisionId,
      uploadTargets,
    });
    return true;
  }

  const commitMatch =
    /^\/api\/v1\/shared-containers\/([^/]+)\/revisions\/commit$/.exec(pathname);
  if (commitMatch && method === 'POST') {
    const body = await readJsonBody(request);
    const staged = state.stagedRevisions.find(
      (candidate) =>
        candidate.containerId === commitMatch[1] &&
        candidate.stagingSessionId === body?.stagingSessionId,
    );
    const container = state.containers.find(
      (candidate) => candidate.id === commitMatch[1],
    );
    if (
      !staged ||
      !container ||
      !organizationHintMatches(organizationId, container)
    ) {
      jsonResponse(response, 404, { error: 'Not found.' });
      return true;
    }
    if (staged.committedRevision) {
      jsonResponse(response, 200, {
        revision: revisionForClient(request, staged.committedRevision),
      });
      return true;
    }
    if (
      staged.createdAt &&
      staged.createdAt <= Date.now() - 24 * 60 * 60 * 1_000
    ) {
      staged.packageDownload = undefined;
      jsonResponse(response, 404, { error: 'Staging session expired.' });
      return true;
    }
    const manifest = staged.request.artifacts.find(
      (artifact) => artifact.artifactId === staged.revisionId,
    );
    const revision = {
      ...(staged.packageDownload
        ? { package: packageMetadata(staged.packageDownload) }
        : {}),
      ...(staged.request.parentRevisionId
        ? { parentRevisionId: staged.request.parentRevisionId }
        : {}),
      id: staged.revisionId,
      revision: staged.revisionNumber,
      schemaVersion: staged.request.schemaVersion,
      sourceDeviceId: staged.request.sourceDeviceId,
      artifactObjectKey: `mock/${staged.revisionId}`,
      artifactHash: manifest?.hash ?? `sha256:${'0'.repeat(64)}`,
      artifactSizeBytes: manifest?.objectSizeBytes ?? '0',
      artifacts: staged.request.artifacts,
      artifactCount: staged.request.artifacts.length,
      totalSizeBytes: String(
        staged.request.artifacts.reduce(
          (total, artifact) => total + Number(artifact.objectSizeBytes),
          0,
        ),
      ),
      createdAt: NOW,
    };
    state.revisions.push({
      containerId: container.id,
      revision,
      packageDownload: staged.packageDownload,
    });
    staged.committedRevision = revision;
    staged.packageDownload = undefined;
    const live = state.revisions.filter(
      (entry) => entry.containerId === container.id && !entry.retired,
    );
    for (const retired of live.slice(0, Math.max(0, live.length - 20))) {
      retired.retired = true;
      retired.packageDownload = undefined;
    }
    container.revision = staged.revisionNumber;
    container.updatedAt = NOW;
    container.latestRevision = revision;
    recordScenarioActivity(key, 'sharedContainersCommit');
    jsonResponse(response, 200, {
      revision: revisionForClient(request, revision),
    });
    return true;
  }

  // Capability links. The owner routes mirror the web service: one link per
  // container, reset rotates the token, and turning it off or resetting it
  // revokes every grant that came through the link.
  if (pathname === '/api/v1/shared-containers/link' && method === 'PUT') {
    state.links ??= [];
    const body = await readJsonBody(request);
    const audience = body?.audience;
    if (
      typeof body?.worktreeId !== 'string' ||
      (audience !== 'ANYONE' && audience !== 'ORGANIZATION')
    ) {
      jsonResponse(response, 400, { error: 'Invalid request.' });
      return true;
    }
    let container = state.containers.find(
      (candidate) => candidate.worktreeId === body.worktreeId,
    );
    if (!container) {
      container = containerSummary(state, body);
      state.containers.push(container);
    }
    let link = state.links.find(
      (candidate) => candidate.containerId === container.id,
    );
    if (!link) {
      link = { containerId: container.id, token: newLinkToken(), audience };
      state.links.push(link);
    }
    recordScenarioActivity(key, `sharedContainersLinkSet:${audience}`);
    jsonResponse(response, 200, {
      container,
      link: { audience: link.audience, url: `/share/view/${link.token}` },
    });
    return true;
  }
  const linkMatch =
    /^\/api\/v1\/shared-containers\/([^/]+)\/link(\/reset)?$/.exec(pathname);
  if (linkMatch) {
    state.links ??= [];
    const containerId = linkMatch[1];
    const container = state.containers.find(
      (candidate) => candidate.id === containerId,
    );
    if (!container) {
      jsonResponse(response, 404, { error: 'Not found.' });
      return true;
    }
    const existing = state.links.find(
      (candidate) => candidate.containerId === containerId,
    );
    const revokeLinkGrants = (link, predicate = () => true) => {
      state.grants = state.grants.filter(
        (grant) => !(grant.viaLinkToken === link.token && predicate(grant)),
      );
    };
    const linkResponse = (link) => ({
      audience: link.audience,
      url: `/share/view/${link.token}`,
    });
    if (linkMatch[2] && method === 'POST') {
      if (!existing) {
        jsonResponse(response, 404, { error: 'Not found.' });
        return true;
      }
      revokeLinkGrants(existing);
      existing.token = newLinkToken();
      recordScenarioActivity(key, 'sharedContainersLinkReset');
      jsonResponse(response, 200, linkResponse(existing));
      return true;
    }
    if (!linkMatch[2] && method === 'GET') {
      jsonResponse(response, 200, existing ? linkResponse(existing) : null);
      return true;
    }
    if (!linkMatch[2] && method === 'PUT') {
      const body = await readJsonBody(request);
      const audience = body?.audience;
      if (audience !== 'ANYONE' && audience !== 'ORGANIZATION') {
        jsonResponse(response, 400, { error: 'Invalid request.' });
        return true;
      }
      if (existing) {
        if (existing.audience === 'ANYONE' && audience === 'ORGANIZATION') {
          revokeLinkGrants(existing, (grant) => grant.access === 'direct');
        }
        existing.audience = audience;
      } else {
        state.links.push({ containerId, token: newLinkToken(), audience });
      }
      recordScenarioActivity(key, `sharedContainersLinkSet:${audience}`);
      jsonResponse(
        response,
        200,
        linkResponse(
          state.links.find(
            (candidate) => candidate.containerId === containerId,
          ),
        ),
      );
      return true;
    }
    if (!linkMatch[2] && method === 'DELETE') {
      if (existing) {
        revokeLinkGrants(existing);
        state.links = state.links.filter((candidate) => candidate !== existing);
      }
      recordScenarioActivity(key, 'sharedContainersLinkRemoved');
      response.writeHead(204);
      response.end();
      return true;
    }
  }

  const tokenMatch =
    /^\/api\/v1\/shared-container-links\/([^/]+)(\/claim)?$/.exec(pathname);
  if (tokenMatch) {
    state.links ??= [];
    const link = state.links.find(
      (candidate) => candidate.token === tokenMatch[1],
    );
    const container = link
      ? state.containers.find((candidate) => candidate.id === link.containerId)
      : undefined;
    if (!link || !container) {
      jsonResponse(response, 404, { error: 'Not found.' });
      return true;
    }
    const scripted = getScenario(key)?.sharedContainers?.linkLanding;
    if (!tokenMatch[2] && method === 'GET') {
      recordScenarioActivity(key, 'sharedContainersLinkResolve');
      if (scripted && scripted.state !== 'ready') {
        jsonResponse(response, 200, scripted);
        return true;
      }
      const ref = containerRef(container, membersFor(key), { headers: {} });
      jsonResponse(response, 200, {
        state: 'ready',
        audience: link.audience,
        title: container.title ?? 'Shared project',
        containerType: container.containerType,
        owner: ref.owner,
        ...(ref.organizationName
          ? { organizationName: ref.organizationName }
          : {}),
        lastPublishedAt: container.updatedAt ?? NOW,
        contents: scripted?.contents ?? {
          repositoryCount: 1,
          repositoryNames: ['app'],
          chatCount: 2,
          fileCount: 3,
        },
        eligible: true,
        alreadyHasAccess: link.claimed === true,
      });
      return true;
    }
    if (tokenMatch[2] && method === 'POST') {
      if (scripted && scripted.state !== 'ready') {
        jsonResponse(response, 404, { error: 'Not found.' });
        return true;
      }
      link.claimed = true;
      container.linkOnly = false;
      recordScenarioActivity(key, 'sharedContainersLinkClaim');
      jsonResponse(
        response,
        200,
        containerRef(container, membersFor(key), request),
      );
      return true;
    }
  }

  if (method === 'POST') {
    recordScenarioActivity(key, 'sharedContainersUnexpectedMutation');
  }
  jsonResponse(response, 404, { error: 'Not found.' });
  return true;
}
