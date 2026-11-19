// CAN-4170 golden: collection management and sharing as Electron main serves
// them today, captured before the collection engine moves into core. It
// drives the 20 real collections:* handlers, App Advisor's collection sharing
// actions on their main host, over the real collection, skill, package and account stores on the isolated test
// data root. Only IPC registration, the cloud base URL and Electron's window
// and keychain are replaced, and HTTP goes to an in-test fake cloud. Each step
// waits for the shared-item subscription upload it starts. A change
// here is a behaviour change: re-record deliberately with
// `pnpm test <this file> -u` and review the snapshot diff.
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserWindow, safeStorage } from 'electron';
import { BRAND } from '@canopy/brand/current';
import { COLLECTIONS_CHANNELS } from '@canopy/desktop-shared/constants/collection-channels';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import type { PipelinePackageManifestV1 } from '@canopy/protocol/pipelines';
import { computePipelinePackageDigestSync } from '@canopy/execution-engine/node/pipelines/package-contract';
import type * as CloudConfig from '../canopy-cloud/config';
import { getFeatureFlagService } from '../feature-flags';
import { toIpcRejection } from '../ipc/app-error-rejection';
import { getDataDir } from '../lib/paths';
import {
  flushSharedItemSubscriptions,
  readSharedItemSubscriptionLedger,
} from '../canopy-cloud/shared-item-subscriptions';
import {
  invalidateCanopyCloudAccountCache,
  saveCanopyCloudAccount,
  type CanopyCloudAccountEntry,
} from '../lib/canopy-cloud-account-store';

jest.setTimeout(60_000);

type Handler = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (channel: string, handler: Handler): void => {
    handlers.set(channel, handler);
  },
}));
jest.mock('../canopy-cloud/config', () => ({
  ...jest.requireActual<typeof CloudConfig>('../canopy-cloud/config'),
  getCanopyCloudBaseUrl: (): string => 'https://cloud.example.test',
}));

const BASE = 'https://cloud.example.test';
const SUBSCRIPTIONS = '/api/v1/shared-item-subscriptions/batch';
const API = `/api/v1/${BRAND.web.apiNamespace}`;
const ACCOUNT = 'account-one';
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const PERSONAL_ORG = '33333333-3333-4333-8333-333333333333';
const TEAM_A = '44444444-4444-4444-8444-444444444444';
const ORG_PROJECT = '55555555-5555-4555-8555-555555555555';
const ORG_INSTANCE = '66666666-6666-4666-8666-666666666666';
const CAPABILITIES = ['collections-crud-v1', 'resource-context-v1'];
const ORG_PROJECTS = CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key;
const SECRET_LINE = ['pass', 'word=correct-horse-staple'].join('');

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function text(value: unknown, key: string): string {
  if (!isRecord(value) || typeof value[key] !== 'string')
    throw new Error(`Missing ${key}`);
  return value[key];
}
function field(value: unknown, key: string): unknown {
  if (!isRecord(value)) throw new Error(`Missing ${key}`);
  return value[key];
}
function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

const STAMP = '2026-11-01T00:00:00.000Z';
const EDITED = '2026-11-02T00:00:00.000Z';
const FIXED_TIMES = new Set([STAMP, EDITED, '2026-11-01T01:00:00.000Z']);

function organization(id: string): Json {
  return {
    id,
    name: `Org ${id.slice(0, 4)}`,
    role: 'MEMBER',
    createdAt: STAMP,
    updatedAt: STAMP,
  };
}

function orgSummary(): {
  id: string;
  name: string;
  role: 'MEMBER';
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: ORG_A,
    name: 'Org 1111',
    role: 'MEMBER',
    createdAt: STAMP,
    updatedAt: STAMP,
  };
}

function accountEntry(capabilities: string[]): CanopyCloudAccountEntry {
  return {
    apiKey: 'csk_collections',
    capabilities,
    account: {
      id: ACCOUNT,
      name: 'Account One',
      email: 'account-one@example.test',
      role: 'DEVELOPER',
    },
    personalOrganizationId: PERSONAL_ORG,
    organizations: [orgSummary()],
    teams: [
      {
        id: TEAM_A,
        name: 'Release team',
        organization: orgSummary(),
        createdAt: STAMP,
        updatedAt: STAMP,
      },
    ],
    createdAt: STAMP,
    updatedAt: STAMP,
  };
}

interface Upload {
  manifest: PipelinePackageManifestV1;
  digest: string;
  blobs: Map<string, Uint8Array>;
}

interface Cloud {
  capabilities: string[];
  collections: Map<string, Json>;
  skills: Map<string, Json>;
  uploads: Map<string, Upload>;
  packages: Map<string, Upload>;
  requests: string[];
  nextId: number;
}

let cloud: Cloud;

function resetCloud(): void {
  cloud = {
    capabilities: [...CAPABILITIES],
    collections: new Map(),
    skills: new Map(),
    uploads: new Map(),
    packages: new Map(),
    requests: [],
    nextId: 1,
  };
}
resetCloud();

function ownerFor(body: Json): Json {
  if (
    body.shareScope === 'organization' &&
    typeof body.organizationId === 'string'
  )
    return { type: 'organization', id: body.organizationId, name: 'Org' };
  if (body.shareScope === 'team')
    return {
      type: 'team',
      id: TEAM_A,
      name: 'Release team',
      organization: { id: ORG_A, name: 'Org 1111' },
    };
  return { type: 'user', id: ACCOUNT, name: 'Account One' };
}

function packageSummary(upload: Upload): Json {
  return {
    digest: upload.digest,
    version: 1,
    resources: upload.manifest.resources.map((resource) => ({
      id: resource.id,
      displayName: resource.displayName,
      kind: resource.kind,
      sourceLabel: resource.sourceLabel,
      fileCount: resource.trees.reduce(
        (sum, tree) => sum + tree.entries.length,
        0,
      ),
      totalBytes: resource.trees.reduce(
        (sum, tree) =>
          sum + tree.entries.reduce((size, entry) => size + entry.size, 0),
        0,
      ),
      affectedSteps: [],
    })),
    environmentRequirements: upload.manifest.environmentRequirements,
    totalFiles: upload.manifest.totalFiles,
    totalBytes: upload.manifest.totalBytes,
  };
}

function storeCollection(id: string, body: Json, previous?: Json): Json {
  const write: unknown = JSON.parse(text(body, 'rawCollection'));
  if (!isRecord(write) || !Array.isArray(write.items))
    throw new Error('Invalid collection document');
  const customSkills: Json[] = [];
  const payloads: unknown[] = Array.isArray(body.customSkills)
    ? body.customSkills
    : [];
  const items = write.items.map((item: unknown): unknown => {
    if (
      !isRecord(item) ||
      item.type !== 'custom_skill' ||
      typeof item.clientKey !== 'string'
    )
      return item;
    const payload = payloads.find(
      (candidate: unknown) =>
        isRecord(candidate) && candidate.clientKey === item.clientKey,
    );
    const rawSkill = text(payload, 'rawSkill');
    const skillId = `skill-${id}-${String(customSkills.length + 1)}`;
    const skill: Json = {
      id: skillId,
      name: text(payload, 'name'),
      description: '',
      rawSkill,
      contentHash: sha256(rawSkill),
      shareScope: 'private',
      owner: { type: 'user', id: ACCOUNT, name: 'Account One' },
      createdBy: { id: ACCOUNT, name: 'Account One', email: null },
      createdAt: STAMP,
      updatedAt: STAMP,
      canUpdate: true,
      canDelete: true,
      publicShare: null,
    };
    cloud.skills.set(skillId, skill);
    customSkills.push(skill);
    return {
      type: 'custom_skill',
      skillId,
      skill_name: item.skill_name,
      contentHash: sha256(rawSkill),
      ...(item.required === undefined ? {} : { required: item.required }),
    };
  });
  const resolved = customSkills.length === 0;
  const document = {
    version: 1,
    name: write.name,
    description: write.description ?? '',
    items,
  };
  const rawCollection = resolved
    ? text(body, 'rawCollection')
    : JSON.stringify(document);
  const ref = isRecord(body.capabilityPackage)
    ? body.capabilityPackage
    : undefined;
  const upload = ref ? cloud.packages.get(text(ref, 'digest')) : undefined;
  const detail: Json = {
    id,
    name: document.name,
    description: document.description,
    contentHash: sha256(rawCollection),
    itemCounts: {
      skills: items.filter(
        (item: unknown) => isRecord(item) && item.type === 'skill',
      ).length,
      plugins: items.filter(
        (item: unknown) =>
          isRecord(item) && typeof item.plugin_name === 'string',
      ).length,
      customSkills: customSkills.length,
    },
    shareScope:
      previous && body.shareScope === undefined
        ? previous.shareScope
        : (body.shareScope ?? 'private'),
    owner:
      previous && body.shareScope === undefined
        ? previous.owner
        : ownerFor(body),
    createdBy: { id: ACCOUNT, name: 'Account One', email: null },
    createdAt: STAMP,
    updatedAt: previous ? EDITED : STAMP,
    canUpdate: true,
    canDelete: true,
    publicShare: previous?.publicShare ?? null,
    rawCollection,
    collection: document,
    customSkills,
    ...(upload
      ? { distributionMode: 'package', package: packageSummary(upload) }
      : {}),
  };
  cloud.collections.set(id, detail);
  return detail;
}

function seedForeign(id: string, owner: Json, extra: Json = {}): Json {
  const rawCollection = JSON.stringify({
    version: 1,
    name: `Foreign ${id}`,
    description: '',
    items: [],
  });
  const detail: Json = {
    id,
    name: `Foreign ${id}`,
    description: '',
    contentHash: sha256(rawCollection),
    itemCounts: { skills: 0, plugins: 0, customSkills: 0 },
    shareScope: owner.type === 'organization' ? 'organization' : 'private',
    owner,
    createdBy: { id: 'someone-else', name: 'Someone Else', email: null },
    createdAt: STAMP,
    updatedAt: STAMP,
    canUpdate: false,
    canDelete: false,
    publicShare: null,
    rawCollection,
    collection: JSON.parse(rawCollection),
    customSkills: [],
    ...extra,
  };
  cloud.collections.set(id, detail);
  return detail;
}

function errorResponse(status: number, error: string, code?: string): Response {
  return Response.json({ error, ...(code ? { code } : {}) }, { status });
}

function jsonBody(init: RequestInit | undefined): unknown {
  const body = init?.body;
  if (typeof body !== 'string') throw new Error('Expected a JSON body');
  return JSON.parse(body);
}

function bodyBytes(init: RequestInit | undefined): Uint8Array {
  const body = init?.body;
  if (body instanceof Uint8Array) return new Uint8Array(body);
  if (typeof body === 'string') return new TextEncoder().encode(body);
  throw new Error('Unexpected blob body');
}

function summaryOf(detail: Json): Json {
  const summary = { ...detail };
  delete summary.rawCollection;
  delete summary.collection;
  delete summary.customSkills;
  delete summary.package;
  delete summary.distributionMode;
  return summary;
}

function listCollections(url: URL): Response {
  const scope = url.searchParams.get('shareScope');
  const organizationId = url.searchParams.get('organizationId');
  const rows = Array.from(cloud.collections.values()).filter((detail) => {
    const owner = detail.owner;
    if (!isRecord(owner)) return false;
    if (scope === 'private')
      return owner.type === 'user' && owner.id === ACCOUNT;
    if (scope === 'organization')
      return (
        (owner.type === 'organization' && owner.id === organizationId) ||
        (owner.type === 'team' &&
          isRecord(owner.organization) &&
          owner.organization.id === organizationId)
      );
    return owner.type !== 'organization' || owner.id !== ORG_B;
  });
  const body = JSON.stringify({ collections: rows.map(summaryOf) });
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json',
      etag: `"${sha256(body).slice(0, 12)}"`,
    },
  });
}

async function fakeCloud(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<Response> {
  const response = route(input, init);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const local = new Response(bytes.length > 0 ? bytes : null, {
    status: response.status,
    headers: response.headers,
  });
  Object.defineProperty(local, 'json', {
    value: (): Promise<unknown> =>
      Promise.resolve(JSON.parse(new TextDecoder().decode(bytes))),
  });
  return local;
}

function route(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Response {
  const url = new URL(
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
  );
  const method = (init?.method ?? 'GET').toUpperCase();
  const headers = new Headers(init?.headers);
  const conditional = headers.get('if-none-match');
  cloud.requests.push(
    `${method} ${url.pathname}${url.search}${conditional ? ` if-none-match` : ''}`,
  );
  if (url.origin !== BASE) throw new TypeError('Unexpected origin');
  if (url.pathname === SUBSCRIPTIONS && method === 'POST') {
    const body = jsonBody(init);
    const upserts = field(body, 'upserts');
    const removals = field(body, 'removals');
    if (!Array.isArray(upserts) || !Array.isArray(removals))
      return errorResponse(400, 'Invalid batch.');
    const describe = (entry: unknown): string =>
      `${text(entry, 'kind')}:${text(entry, 'sourceKind')}:${text(entry, 'remoteId')}`;
    for (const entry of upserts)
      cloud.requests.push(
        `  upsert ${describe(entry)} hash=${String(field(entry, 'contentHash'))}`,
      );
    for (const entry of removals)
      cloud.requests.push(`  removal ${describe(entry)}`);
    return Response.json({
      upserts: upserts.map(() => ({ ok: true })),
      removals: removals.map(() => ({ ok: true })),
    });
  }
  if (url.pathname.startsWith('/.well-known/'))
    return Response.json({ capabilities: cloud.capabilities });
  if (url.pathname === `${API}/account`)
    return Response.json({
      ...accountEntry(cloud.capabilities),
      capabilities: cloud.capabilities,
    });
  const skill = new RegExp(`^${API}/skills/([^/]+)$`).exec(url.pathname);
  if (skill && method === 'GET') {
    const detail = cloud.skills.get(skill[1]);
    return detail
      ? Response.json(detail)
      : errorResponse(404, 'Skill not found.', 'not_found');
  }
  if (url.pathname === `${API}/teams`)
    return Response.json({
      data: [
        {
          id: TEAM_A,
          name: 'Release team',
          organization: organization(ORG_A),
          createdAt: STAMP,
          updatedAt: STAMP,
        },
      ],
    });
  if (url.pathname === `${API}/collections`) {
    if (method === 'GET') {
      const response = listCollections(url);
      const etag = response.headers.get('etag');
      return conditional && conditional === etag
        ? new Response(null, { status: 304, headers: { etag } })
        : response;
    }
    const body = jsonBody(init);
    if (!isRecord(body)) return errorResponse(400, 'Invalid body.');
    if (body.shareScope === 'organization' && body.organizationId !== ORG_A)
      return errorResponse(
        403,
        'You are not a member of this organization.',
        'forbidden',
      );
    const id = `shared-${String(cloud.nextId++)}`;
    return Response.json(storeCollection(id, body), { status: 201 });
  }
  const publicShare = new RegExp(
    `^${API}/collections/([^/]+)/public-share$`,
  ).exec(url.pathname);
  if (publicShare) {
    const detail = cloud.collections.get(publicShare[1]);
    if (!detail)
      return errorResponse(404, 'Collection not found.', 'not_found');
    if (detail.canUpdate !== true)
      return errorResponse(
        403,
        'Only the owner can publish this collection.',
        'forbidden',
      );
    if (method === 'DELETE') {
      detail.publicShare = null;
      return new Response(null, { status: 204 });
    }
    const share = {
      externalId: `pub-${publicShare[1]}`,
      pinnedContentHash: detail.contentHash,
      upToDate: true,
      sharePath: `/share/collections/pub-${publicShare[1]}`,
      createdAt: STAMP,
      updatedAt: STAMP,
    };
    detail.publicShare = share;
    return Response.json({ publicShare: share });
  }
  const one = new RegExp(`^${API}/collections/([^/]+)$`).exec(url.pathname);
  if (one) {
    const detail = cloud.collections.get(one[1]);
    if (!detail)
      return errorResponse(404, 'Collection not found.', 'not_found');
    if (method === 'GET') return Response.json(detail);
    if (detail.canUpdate !== true)
      return errorResponse(
        403,
        'You cannot change this collection.',
        'forbidden',
      );
    if (method === 'DELETE') {
      cloud.collections.delete(one[1]);
      return new Response(null, { status: 204 });
    }
    const body = jsonBody(init);
    if (!isRecord(body)) return errorResponse(400, 'Invalid body.');
    if (
      typeof body.expectedContentHash === 'string' &&
      body.expectedContentHash !== detail.contentHash
    )
      return errorResponse(
        409,
        'The collection changed since you loaded it.',
        'conflict',
      );
    return Response.json(storeCollection(one[1], body, detail));
  }
  if (
    url.pathname === '/api/v1/pipeline-packages/uploads' &&
    method === 'POST'
  ) {
    const body = jsonBody(init);
    const manifest = field(body, 'manifest');
    const digest = text(body, 'expectedDigest');
    if (!isPackageManifest(manifest))
      return errorResponse(400, 'Invalid manifest.');
    const uploadId = `upload-${String(cloud.uploads.size + 1)}`;
    cloud.uploads.set(uploadId, { manifest, digest, blobs: new Map() });
    return Response.json({
      uploadId,
      expiresAt: '2026-11-01T01:00:00.000Z',
      missingBlobs: Array.from(
        new Set(
          manifest.resources.flatMap((resource) =>
            resource.trees.flatMap((tree) =>
              tree.entries.map((entry) => entry.sha256),
            ),
          ),
        ),
      ),
    });
  }
  const blobUpload =
    /^\/api\/v1\/pipeline-packages\/uploads\/([^/]+)\/blobs\/([^/]+)$/.exec(
      url.pathname,
    );
  if (blobUpload) {
    const upload = cloud.uploads.get(blobUpload[1]);
    if (!upload) return errorResponse(404, 'Upload not found.');
    const bytes = bodyBytes(init);
    if (sha256(bytes) !== blobUpload[2])
      return errorResponse(400, 'Blob hash mismatch.');
    upload.blobs.set(blobUpload[2], bytes);
    return new Response(null, { status: 204 });
  }
  const commit =
    /^\/api\/v1\/pipeline-packages\/uploads\/([^/]+)\/commit$/.exec(
      url.pathname,
    );
  if (commit) {
    const upload = cloud.uploads.get(commit[1]);
    if (!upload) return errorResponse(404, 'Upload not found.');
    cloud.packages.set(upload.digest, upload);
    return Response.json({
      uploadId: commit[1],
      digest: upload.digest,
      package: packageSummary(upload),
    });
  }
  const download =
    /^\/api\/v1\/collections\/([^/]+)\/package(?:\/blobs\/([^/]+))?$/.exec(
      url.pathname,
    );
  if (download) {
    const detail = cloud.collections.get(download[1]);
    const summary = detail?.package;
    const expected = url.searchParams.get('expectedPackageDigest');
    if (!detail || !isRecord(summary))
      return errorResponse(404, 'Package not found.', 'not_found');
    if (summary.digest !== expected)
      return errorResponse(409, 'The package changed.', 'package_changed');
    const upload = cloud.packages.get(text(summary, 'digest'));
    if (!upload) return errorResponse(404, 'Package not found.', 'not_found');
    if (!download[2])
      return Response.json({
        digest: upload.digest,
        manifest: upload.manifest,
      });
    const blob = upload.blobs.get(download[2]);
    return blob
      ? new Response(Buffer.from(blob))
      : errorResponse(404, 'Blob not found.');
  }
  return errorResponse(404, `No fake route for ${method} ${url.pathname}`);
}

function isPackageManifest(value: unknown): value is PipelinePackageManifestV1 {
  return (
    isRecord(value) &&
    value.version === 1 &&
    Array.isArray(value.resources) &&
    Array.isArray(value.environmentRequirements)
  );
}

function withRequirement(upload: Upload, displayName: string): Upload {
  const manifest: PipelinePackageManifestV1 = {
    ...upload.manifest,
    environmentRequirements: [
      ...upload.manifest.environmentRequirements,
      {
        id: `mcp-${displayName.toLowerCase()}`,
        kind: 'mcp',
        displayName,
        required: true,
        affectedSteps: [],
        setupHint: `Connect the ${displayName} MCP server.`,
      },
    ],
  };
  const variant = {
    manifest,
    digest: computePipelinePackageDigestSync(manifest),
    blobs: upload.blobs,
  };
  cloud.packages.set(variant.digest, variant);
  return variant;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const SHA = /\b[0-9a-f]{64}\b/g;
const DIGEST = /pp:v1:[A-Za-z0-9_-]{43}/g;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const FIXED_IDS = new Set([
  ORG_A,
  ORG_B,
  PERSONAL_ORG,
  TEAM_A,
  ORG_PROJECT,
  ORG_INSTANCE,
]);

class Normalizer {
  private readonly tokens = new Map<string, string>();
  private readonly counters = new Map<string, number>();

  private token(kind: string, raw: string): string {
    const known = this.tokens.get(raw);
    if (known) return known;
    const next = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, next);
    const token = `<${kind}:${String(next)}>`;
    this.tokens.set(raw, token);
    return token;
  }

  apply(input: unknown): unknown {
    const serialized = JSON.stringify(input ?? null)
      .split(getDataDir())
      .join('<data>')
      .split(`/api/v1/${BRAND.web.apiNamespace}`)
      .join('/api/v1/<brand-api>')
      .split(`/.well-known/${BRAND.web.wellKnownNamespace}`)
      .join('/.well-known/<brand>')
      .split(BRAND.displayName)
      .join('<Brand>')
      .replace(DIGEST, (digest) => this.token('digest', digest))
      .replace(SHA, (hash) => this.token('sha', hash))
      .replace(UUID, (id) => (FIXED_IDS.has(id) ? id : this.token('uuid', id)))
      .replace(ISO, (time) => (FIXED_TIMES.has(time) ? time : '<time>'));
    const parsed: unknown = JSON.parse(serialized);
    return parsed;
  }
}

interface Thrown {
  name: string;
  message: string;
  code?: unknown;
  reason?: unknown;
}
interface Rejection {
  renderer: unknown;
  thrown: Thrown;
}
type Outcome = { value: unknown } | { rejected: Rejection };

function describeThrown(error: unknown): Thrown {
  if (!(error instanceof Error))
    return { name: typeof error, message: String(error) };
  return {
    name: error.name,
    message: error.message,
    ...('code' in error ? { code: error.code } : {}),
    ...('reason' in error ? { reason: error.reason } : {}),
  };
}

function rendererView(channel: string, error: unknown): unknown {
  const rejection = toIpcRejection(channel, error);
  const decoded: unknown = JSON.parse(rejection.message);
  if (!isRecord(decoded)) return rejection.message;
  const appError = decoded.appError;
  return {
    legacy: decoded.legacy,
    ...(isRecord(appError) ? { appError: appError.code } : {}),
    ...(decoded.operationFailure === undefined
      ? {}
      : { operationFailure: decoded.operationFailure }),
  };
}

async function invoke(channel: string, ...args: unknown[]): Promise<Outcome> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Missing handler ${channel}`);
  try {
    return { value: await handler({ sender: { id: 7 } }, ...args) };
  } catch (error) {
    return {
      rejected: {
        renderer: rendererView(channel, error),
        thrown: describeThrown(error),
      },
    };
  }
}

function valueOf(outcome: Outcome): unknown {
  if ('value' in outcome) return outcome.value;
  throw new Error(`Rejected: ${JSON.stringify(outcome.rejected.thrown)}`);
}

class Recorder {
  private readonly steps: Json[] = [];
  private readonly normalizer = new Normalizer();

  async record(label: string, run: () => Promise<unknown>): Promise<unknown> {
    cloud.requests.length = 0;
    let result: unknown;
    let outcome: Json;
    try {
      result = await run();
      await settleSubscriptions();
      outcome = { result };
    } catch (error) {
      outcome = { threw: describeThrown(error) };
    }
    this.steps.push({ step: label, ...outcome, cloud: [...cloud.requests] });
    return result;
  }

  async call(
    label: string,
    channel: string,
    ...args: unknown[]
  ): Promise<Outcome> {
    cloud.requests.length = 0;
    const outcome = await invoke(channel, ...args);
    await settleSubscriptions();
    this.steps.push({ step: label, ...outcome, cloud: [...cloud.requests] });
    return outcome;
  }

  /**
   * For a step whose handler records a shared install mid-flight. The save
   * calls recordSharedItemInstall, which starts the subscription batch without
   * awaiting it (shared-item-subscriptions.ts `void updateLedger(...).then(
   * flushSharedItemSubscriptions)`), so the batch can land between any of the
   * requests the handler sends after the save. The batch keeps its own ordered
   * list; every other request stays in `cloud`, in order.
   */
  async callWithBackgroundSubscriptions(
    label: string,
    channel: string,
    ...args: unknown[]
  ): Promise<Outcome> {
    cloud.requests.length = 0;
    const outcome = await invoke(channel, ...args);
    await settleSubscriptions();
    const ordered: string[] = [];
    const subscriptions: string[] = [];
    let inBatch = false;
    for (const line of cloud.requests) {
      // The fake cloud records a batch and its entry lines in one synchronous
      // call, so they are always adjacent.
      if (line === `POST ${SUBSCRIPTIONS}`) inBatch = true;
      else if (!line.startsWith('  ')) inBatch = false;
      (inBatch ? subscriptions : ordered).push(line);
    }
    this.steps.push({ step: label, ...outcome, cloud: ordered, subscriptions });
    return outcome;
  }

  snapshot(): unknown {
    return this.normalizer.apply(this.steps);
  }
}

let orgProjects = true;

async function switchContext(organizationId: string): Promise<unknown> {
  const { getWorkspaceContextService } =
    await import('../lib/workspace-context-service');
  const state = await getWorkspaceContextService().setContext({
    kind: 'organization',
    organizationId,
  });
  return state.context;
}

async function settleSubscriptions(): Promise<void> {
  await readSharedItemSubscriptionLedger();
  await flushSharedItemSubscriptions();
}

async function resetLocalState(): Promise<void> {
  const dataDir = getDataDir();
  for (const dir of [
    'collections',
    'skills',
    'pipeline-packages',
    'workspaces',
    'shared-item-update-subscriptions.json',
    'workspace-context.json',
    'resource-install-receipts.json',
    'pipeline-package-installs.json',
    'pipeline-package-dismissals.json',
    'invocable-inventory-cache.json',
    'plugins-cache.json',
  ])
    rmSync(join(dataDir, dir), { recursive: true, force: true });
  resetCloud();
  await saveCanopyCloudAccount(accountEntry(CAPABILITIES));
  invalidateCanopyCloudAccountCache();
  const { __resetWorkspaceContextServiceForTests, getWorkspaceContextService } =
    await import('../lib/workspace-context-service');
  __resetWorkspaceContextServiceForTests();
  await getWorkspaceContextService().initialize();
}

const SEALED = 'sealed:';
function seal(plain: string): Buffer {
  return Buffer.from(
    `${SEALED}${Buffer.from(plain, 'utf8').toString('base64')}`,
  );
}
function unseal(sealed: Buffer): string {
  const content = sealed.toString('utf8');
  if (!content.startsWith(SEALED)) throw new Error('Unable to decrypt');
  return Buffer.from(content.slice(SEALED.length), 'base64').toString('utf8');
}

beforeAll(async () => {
  const home = join(getDataDir(), '..', 'home');
  mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  jest.spyOn(safeStorage, 'encryptString').mockImplementation(seal);
  jest.spyOn(safeStorage, 'decryptString').mockImplementation(unseal);
  const flags = getFeatureFlagService();
  const original = flags.isEnabled.bind(flags);
  jest
    .spyOn(flags, 'isEnabled')
    .mockImplementation((key) =>
      key === ORG_PROJECTS ? orgProjects : original(key),
    );
  jest.spyOn(globalThis, 'fetch').mockImplementation(fakeCloud);
  BrowserWindow.fromWebContents = (): null => null;
  const { registerCollectionHandlers } =
    await import('../collections/collection-handlers');
  registerCollectionHandlers();
});

afterEach(settleSubscriptions);

beforeEach(async () => {
  orgProjects = true;
  await resetLocalState();
});

function collectionDocument(name: string, items: unknown[] = []): string {
  return JSON.stringify({
    version: 1,
    name,
    description: `${name} description`,
    items,
  });
}

async function writeCustomSkill(name: string, body: string): Promise<void> {
  const { writeRawSkill } = await import('../skills/skill-service');
  writeRawSkill({
    skillName: name,
    rawSkill: `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`,
  });
}

interface LocalInput {
  name: string;
  skills?: unknown[];
  mcpServers?: unknown[];
  sharedSource?: unknown;
}

async function saveLocal(input: LocalInput): Promise<Json> {
  const saved = valueOf(
    await invoke(COLLECTIONS_CHANNELS.SAVE_COLLECTION, {
      description: `${input.name} description`,
      skills: [],
      plugins: [],
      mcpServers: [],
      ...input,
    }),
  );
  await settleSubscriptions();
  if (!isRecord(saved)) throw new Error('Save returned nothing');
  return saved;
}

describe('with organization projects on, the unconfigured default', () => {
  test('local collections: save, index, load, revisions, delete, duplicate', async () => {
    const r = new Recorder();
    await writeCustomSkill('release-notes', 'Write the release notes.');
    const first = await r.call(
      'save a new collection',
      COLLECTIONS_CHANNELS.SAVE_COLLECTION,
      {
        name: '  Release kit  ',
        description: 'For releases',
        skills: [{ sourceId: 'custom:app', skillName: 'release-notes' }],
        plugins: [{ marketplaceId: 'local-tools', pluginName: 'notes' }],
        mcpServers: [],
      },
    );
    const saved = valueOf(first);
    const id = text(saved, 'id');
    const revision = text(saved, 'revision');
    await r.call('save without a name', COLLECTIONS_CHANNELS.SAVE_COLLECTION, {
      name: '   ',
    });
    await r.call(
      'save an invalid skill reference',
      COLLECTIONS_CHANNELS.SAVE_COLLECTION,
      {
        name: 'Broken',
        skills: [{ sourceId: 7 }],
      },
    );
    await r.call('save an unsafe id', COLLECTIONS_CHANNELS.SAVE_COLLECTION, {
      id: '../escape',
      name: 'Escape',
    });
    await r.call('load the index', COLLECTIONS_CHANNELS.LOAD_INDEX);
    await r.call(
      'load the collection',
      COLLECTIONS_CHANNELS.LOAD_COLLECTION,
      id,
    );
    await r.call(
      'load a missing collection',
      COLLECTIONS_CHANNELS.LOAD_COLLECTION,
      'abcdef00-0000-4000-8000-000000000000',
    );
    const edited = await r.call(
      'save an edit at the read revision',
      COLLECTIONS_CHANNELS.SAVE_COLLECTION,
      {
        ...(isRecord(saved) ? saved : {}),
        name: 'Release kit v2',
      },
    );
    await r.call(
      'save an edit at a stale revision',
      COLLECTIONS_CHANNELS.SAVE_COLLECTION,
      {
        ...(isRecord(saved) ? saved : {}),
        revision,
        name: 'Lost edit',
      },
    );
    await r.call(
      'save an edit without a revision',
      COLLECTIONS_CHANNELS.SAVE_COLLECTION,
      {
        id,
        name: 'Legacy editor',
      },
    );
    await r.call(
      'save an edit of a removed row',
      COLLECTIONS_CHANNELS.SAVE_COLLECTION,
      {
        id: 'abcdef00-0000-4000-8000-000000000001',
        revision: text(valueOf(edited), 'revision'),
        name: 'Ghost',
      },
    );
    await r.call('duplicate it', COLLECTIONS_CHANNELS.DUPLICATE_COLLECTION, {
      collectionId: id,
    });
    await r.call(
      'duplicate a missing collection',
      COLLECTIONS_CHANNELS.DUPLICATE_COLLECTION,
      {
        collectionId: 'abcdef00-0000-4000-8000-000000000000',
      },
    );
    await r.call(
      'duplicate an invalid id',
      COLLECTIONS_CHANNELS.DUPLICATE_COLLECTION,
      { collectionId: 'Not An Id' },
    );
    await r.call('index after duplicate', COLLECTIONS_CHANNELS.LOAD_INDEX);
    await r.call('delete it', COLLECTIONS_CHANNELS.DELETE_COLLECTION, id);
    await r.call('delete it again', COLLECTIONS_CHANNELS.DELETE_COLLECTION, id);
    await r.call(
      'delete an unsafe id',
      COLLECTIONS_CHANNELS.DELETE_COLLECTION,
      '../escape',
    );
    await r.call('index after delete', COLLECTIONS_CHANNELS.LOAD_INDEX);
    expect(r.snapshot()).toMatchSnapshot();
  });

  test('hosted sharing: create, list, get, update, publish, revoke, delete', async () => {
    const r = new Recorder();
    await writeCustomSkill('release-notes', 'Write the release notes.');
    const local = await saveLocal({
      name: 'Release kit',
      skills: [{ sourceId: 'custom:app', skillName: 'release-notes' }],
    });
    const withMcp = await saveLocal({
      name: 'Connected kit',
      mcpServers: [{ serverId: 'abc123', configId: 'def456' }],
    });
    const raw = collectionDocument('Release kit', [
      {
        type: 'skill',
        source: { type: 'builtin', id: 'examples' },
        skill_name: 'changelog',
      },
    ]);
    const created = await r.call(
      'share privately from a local collection',
      COLLECTIONS_CHANNELS.SHARED_CREATE,
      {
        sourceCollectionId: local.id,
        rawCollection: raw,
      },
    );
    const sharedId = text(field(valueOf(created), 'value'), 'id');
    await r.call(
      'the local collection now links the share',
      COLLECTIONS_CHANNELS.LOAD_COLLECTION,
      local.id,
    );
    await r.call(
      'share a collection holding MCP servers',
      COLLECTIONS_CHANNELS.SHARED_CREATE,
      {
        sourceCollectionId: withMcp.id,
        rawCollection: collectionDocument('Connected kit'),
      },
    );
    await r.call(
      'share to a team without a team id',
      COLLECTIONS_CHANNELS.SHARED_CREATE,
      {
        rawCollection: raw,
        shareScope: 'team',
      },
    );
    await r.call(
      'share to an organization without its id',
      COLLECTIONS_CHANNELS.SHARED_CREATE,
      {
        rawCollection: raw,
        shareScope: 'organization',
      },
    );
    await r.call(
      'share to a member organization from the Personal context',
      COLLECTIONS_CHANNELS.SHARED_CREATE,
      {
        rawCollection: collectionDocument('Org kit'),
        shareScope: 'organization',
        organizationId: ORG_A,
      },
    );
    seedForeign('shared-foreign-org', {
      type: 'organization',
      id: ORG_B,
      name: 'Org 2222',
    });
    seedForeign('shared-other-user', {
      type: 'user',
      id: 'someone-else',
      name: 'Someone Else',
    });
    await r.call(
      'list shared collections',
      COLLECTIONS_CHANNELS.SHARED_LIST,
      {},
    );
    await r.call(
      'list again with nothing changed',
      COLLECTIONS_CHANNELS.SHARED_LIST,
      {},
    );
    await r.call(
      'list with a query and limit',
      COLLECTIONS_CHANNELS.SHARED_LIST,
      {
        query: 'kit',
        limit: 2,
        createdBy: 'me',
      },
    );
    await r.call('get the share', COLLECTIONS_CHANNELS.SHARED_GET, sharedId);
    await r.call(
      'get a missing share',
      COLLECTIONS_CHANNELS.SHARED_GET,
      'shared-missing',
    );
    await r.call(
      'get a share owned by an organization the account is not in',
      COLLECTIONS_CHANNELS.SHARED_GET,
      'shared-foreign-org',
    );
    await r.call(
      'get a share another person owns',
      COLLECTIONS_CHANNELS.SHARED_GET,
      'shared-other-user',
    );
    const current = text(field(valueOf(created), 'value'), 'contentHash');
    await r.call(
      'update at the current content hash',
      COLLECTIONS_CHANNELS.SHARED_UPDATE,
      {
        collectionId: sharedId,
        sourceCollectionId: local.id,
        rawCollection: collectionDocument('Release kit', []),
        expectedContentHash: current,
      },
    );
    await r.call(
      'update at a stale content hash',
      COLLECTIONS_CHANNELS.SHARED_UPDATE,
      {
        collectionId: sharedId,
        rawCollection: collectionDocument('Lost update'),
        expectedContentHash: current,
      },
    );
    await r.call(
      'update a share another person owns',
      COLLECTIONS_CHANNELS.SHARED_UPDATE,
      {
        collectionId: 'shared-other-user',
        rawCollection: collectionDocument('Takeover'),
      },
    );
    await r.call(
      'the local link after the update',
      COLLECTIONS_CHANNELS.LOAD_INDEX,
    );
    await r.call(
      'publish a public link',
      COLLECTIONS_CHANNELS.SHARED_PUBLIC_PUBLISH,
      sharedId,
    );
    await r.call(
      'publish a share another person owns',
      COLLECTIONS_CHANNELS.SHARED_PUBLIC_PUBLISH,
      'shared-other-user',
    );
    await r.call(
      'revoke the public link',
      COLLECTIONS_CHANNELS.SHARED_PUBLIC_REVOKE,
      sharedId,
    );
    await r.call(
      'revoke a missing share',
      COLLECTIONS_CHANNELS.SHARED_PUBLIC_REVOKE,
      'shared-missing',
    );
    await r.call('delete the share', COLLECTIONS_CHANNELS.SHARED_DELETE, {
      collectionId: sharedId,
    });
    await r.call(
      'the local link is cleared',
      COLLECTIONS_CHANNELS.LOAD_COLLECTION,
      local.id,
    );
    await r.call('delete a missing share', COLLECTIONS_CHANNELS.SHARED_DELETE, {
      collectionId: sharedId,
    });
    await r.record('switch to the organization context', () =>
      switchContext(ORG_A),
    );
    const orgShare = await r.call(
      'share to the member organization',
      COLLECTIONS_CHANNELS.SHARED_CREATE,
      {
        rawCollection: collectionDocument('Org kit'),
        shareScope: 'organization',
        organizationId: ORG_A,
      },
    );
    await r.call(
      'share to an organization the account is not in',
      COLLECTIONS_CHANNELS.SHARED_CREATE,
      {
        rawCollection: collectionDocument('Stray kit'),
        shareScope: 'organization',
        organizationId: ORG_B,
      },
    );
    await r.call('share to a team', COLLECTIONS_CHANNELS.SHARED_CREATE, {
      rawCollection: collectionDocument('Team kit'),
      shareScope: 'team',
      teamId: TEAM_A,
    });
    await r.call(
      'list in the organization context',
      COLLECTIONS_CHANNELS.SHARED_LIST,
      {},
    );
    await r.call(
      'get a personal share from the organization context',
      COLLECTIONS_CHANNELS.SHARED_GET,
      'shared-other-user',
    );
    await r.call(
      'move the organization share to the personal scope',
      COLLECTIONS_CHANNELS.SHARED_UPDATE,
      {
        collectionId: text(field(valueOf(orgShare), 'value'), 'id'),
        rawCollection: collectionDocument('Org kit'),
        shareScope: 'private',
      },
    );
    expect(r.snapshot()).toMatchSnapshot();
  });

  test('hosted calls without the collections capability', async () => {
    const r = new Recorder();
    cloud.capabilities = ['resource-context-v1'];
    await saveCanopyCloudAccount(accountEntry(['resource-context-v1']));
    invalidateCanopyCloudAccountCache();
    await r.call('list', COLLECTIONS_CHANNELS.SHARED_LIST, {});
    await r.call('get', COLLECTIONS_CHANNELS.SHARED_GET, 'shared-1');
    await r.call('create', COLLECTIONS_CHANNELS.SHARED_CREATE, {
      rawCollection: collectionDocument('Kit'),
    });
    await r.call('update', COLLECTIONS_CHANNELS.SHARED_UPDATE, {
      collectionId: 'shared-1',
      rawCollection: collectionDocument('Kit'),
    });
    await r.call('delete', COLLECTIONS_CHANNELS.SHARED_DELETE, {
      collectionId: 'shared-1',
    });
    await r.call(
      'publish',
      COLLECTIONS_CHANNELS.SHARED_PUBLIC_PUBLISH,
      'shared-1',
    );
    await r.call(
      'revoke',
      COLLECTIONS_CHANNELS.SHARED_PUBLIC_REVOKE,
      'shared-1',
    );
    await r.call(
      'import readiness',
      COLLECTIONS_CHANNELS.IMPORT_READINESS,
      'shared-1',
    );
    await r.call('package commit', COLLECTIONS_CHANNELS.PACKAGE_COMMIT, {
      analysisId: 'analysis-1',
    });
    expect(r.snapshot()).toMatchSnapshot();
  });

  test('capability packages: analyze, the secret check, cancel, commit, readiness, install', async () => {
    const r = new Recorder();
    await writeCustomSkill('release-notes', 'Write the release notes.');
    await writeCustomSkill('deploy-keys', `Use ${SECRET_LINE} to deploy.`);
    const clean = await saveLocal({
      name: 'Release kit',
      skills: [{ sourceId: 'custom:app', skillName: 'release-notes' }],
    });
    const leaky = await saveLocal({
      name: 'Deploy kit',
      skills: [{ sourceId: 'custom:app', skillName: 'deploy-keys' }],
    });
    const raw = collectionDocument('Release kit');
    const analysis = valueOf(
      await r.call(
        'analyze a collection with a custom skill',
        COLLECTIONS_CHANNELS.PACKAGE_ANALYZE,
        {
          collectionId: clean.id,
          rawCollection: raw,
        },
      ),
    );
    const blocked = valueOf(
      await r.call(
        'analyze a collection whose skill holds a secret',
        COLLECTIONS_CHANNELS.PACKAGE_ANALYZE,
        {
          collectionId: leaky.id,
          rawCollection: collectionDocument('Deploy kit'),
        },
      ),
    );
    await r.call(
      'analyze a missing collection',
      COLLECTIONS_CHANNELS.PACKAGE_ANALYZE,
      {
        collectionId: 'abcdef00-0000-4000-8000-000000000000',
        rawCollection: raw,
      },
    );
    await r.call(
      'commit the blocked analysis',
      COLLECTIONS_CHANNELS.PACKAGE_COMMIT,
      {
        analysisId: text(blocked, 'analysisId'),
      },
    );
    const second = valueOf(
      await r.call('analyze again', COLLECTIONS_CHANNELS.PACKAGE_ANALYZE, {
        collectionId: clean.id,
        rawCollection: raw,
      }),
    );
    await r.call(
      'cancel the second analysis',
      COLLECTIONS_CHANNELS.PACKAGE_CANCEL_ANALYSIS,
      text(second, 'analysisId'),
    );
    await r.call(
      'commit the cancelled analysis',
      COLLECTIONS_CHANNELS.PACKAGE_COMMIT,
      {
        analysisId: text(second, 'analysisId'),
      },
    );
    const committed = field(
      valueOf(
        await r.call(
          'commit the clean analysis',
          COLLECTIONS_CHANNELS.PACKAGE_COMMIT,
          {
            analysisId: text(analysis, 'analysisId'),
          },
        ),
      ),
      'value',
    );
    const shared = field(
      valueOf(
        await r.call(
          'share it with its package',
          COLLECTIONS_CHANNELS.SHARED_CREATE,
          {
            sourceCollectionId: clean.id,
            rawCollection: raw,
            capabilityPackage: field(committed, 'capabilityPackage'),
            committedPackageUploadId: field(
              committed,
              'committedPackageUploadId',
            ),
          },
        ),
      ),
      'value',
    );
    const sharedId = text(shared, 'id');
    await r.call(
      'import readiness of the packaged share',
      COLLECTIONS_CHANNELS.IMPORT_READINESS,
      sharedId,
    );
    const digest = text(field(committed, 'capabilityPackage'), 'digest');
    const upload = cloud.packages.get(digest);
    if (!upload) throw new Error('The package was not committed');
    const variant = withRequirement(upload, 'Linear');
    const needsMcp = storeCollection('shared-needs-mcp', {
      rawCollection: raw,
      capabilityPackage: { version: 1, digest: variant.digest },
    });
    await r.call(
      'import readiness when a required MCP server is missing',
      COLLECTIONS_CHANNELS.IMPORT_READINESS,
      'shared-needs-mcp',
    );
    await r.call(
      'import readiness of a missing share',
      COLLECTIONS_CHANNELS.IMPORT_READINESS,
      'shared-missing',
    );
    const packageRef = { version: 1, digest: variant.digest };
    await r.callWithBackgroundSubscriptions(
      'install into a new collection',
      COLLECTIONS_CHANNELS.PACKAGE_INSTALL,
      {
        collectionId: 'shared-needs-mcp',
        packageRef,
        createCollection: {
          name: 'Installed kit',
          description: 'From a share',
          sharedSource: {
            remoteId: 'shared-needs-mcp',
            fetchedAt: STAMP,
            contentHash: needsMcp.contentHash,
          },
        },
      },
    );
    await r.call(
      'the installed collection is listed',
      COLLECTIONS_CHANNELS.LOAD_INDEX,
    );
    await r.call(
      'install into an existing collection',
      COLLECTIONS_CHANNELS.PACKAGE_INSTALL,
      {
        collectionId: sharedId,
        localCollectionId: leaky.id,
        packageRef: field(committed, 'capabilityPackage'),
      },
    );
    await r.call(
      'install naming both a new and an existing collection',
      COLLECTIONS_CHANNELS.PACKAGE_INSTALL,
      {
        collectionId: sharedId,
        localCollectionId: clean.id,
        createCollection: { name: 'Both' },
        packageRef,
      },
    );
    await r.call(
      'install naming neither',
      COLLECTIONS_CHANNELS.PACKAGE_INSTALL,
      {
        collectionId: sharedId,
        packageRef,
      },
    );
    await r.call(
      'install whose new collection names another origin',
      COLLECTIONS_CHANNELS.PACKAGE_INSTALL,
      {
        collectionId: sharedId,
        createCollection: {
          name: 'Mismatch',
          sharedSource: { remoteId: 'shared-elsewhere', fetchedAt: STAMP },
        },
        packageRef,
      },
    );
    await r.call(
      'install into a missing collection',
      COLLECTIONS_CHANNELS.PACKAGE_INSTALL,
      {
        collectionId: sharedId,
        localCollectionId: 'abcdef00-0000-4000-8000-000000000000',
        packageRef,
      },
    );
    await r.call(
      'install a package the share no longer carries',
      COLLECTIONS_CHANNELS.PACKAGE_INSTALL,
      {
        collectionId: sharedId,
        localCollectionId: clean.id,
        packageRef,
      },
    );
    expect(r.snapshot()).toMatchSnapshot();
  });

  test('apply a shared update to an installed collection', async () => {
    const r = new Recorder();
    const upstream = storeCollection('shared-upstream', {
      rawCollection: collectionDocument('Upstream kit', [
        {
          type: 'skill',
          source: { type: 'builtin', id: 'examples' },
          skill_name: 'changelog',
        },
      ]),
    });
    const installed = await saveLocal({
      name: 'Upstream kit',
      sharedSource: {
        remoteId: 'shared-upstream',
        fetchedAt: STAMP,
        contentHash: upstream.contentHash,
      },
    });
    const plain = await saveLocal({ name: 'Plain kit' });
    storeCollection(
      'shared-upstream',
      {
        rawCollection: collectionDocument('Upstream kit', [
          { type: 'custom_skill', clientKey: 'tone', skill_name: 'tone' },
        ]),
        customSkills: [
          {
            clientKey: 'tone',
            name: 'tone',
            rawSkill:
              '---\nname: tone\ndescription: Tone skill\n---\nKeep it plain.\n',
          },
        ],
      },
      upstream,
    );
    await r.call(
      'apply at a stale revision',
      COLLECTIONS_CHANNELS.APPLY_SHARED_UPDATE,
      {
        collectionId: installed.id,
        expectedRevision: 'abcdef00-0000-4000-8000-00000000beef',
      },
    );
    await r.call(
      'apply without a revision',
      COLLECTIONS_CHANNELS.APPLY_SHARED_UPDATE,
      {
        collectionId: installed.id,
      },
    );
    await r.call(
      'apply to an invalid id',
      COLLECTIONS_CHANNELS.APPLY_SHARED_UPDATE,
      {
        collectionId: 'Not An Id',
        expectedRevision: 'abc',
      },
    );
    await r.call(
      'apply to a collection with no shared source',
      COLLECTIONS_CHANNELS.APPLY_SHARED_UPDATE,
      {
        collectionId: plain.id,
        expectedRevision: plain.revision,
      },
    );
    const applied = await r.call(
      'apply the update',
      COLLECTIONS_CHANNELS.APPLY_SHARED_UPDATE,
      {
        collectionId: installed.id,
        expectedRevision: installed.revision,
      },
    );
    const after = field(valueOf(applied), 'collection');
    storeCollection(
      'shared-upstream',
      {
        rawCollection: collectionDocument('Upstream kit', [
          {
            type: 'skill',
            source: { type: 'builtin', id: 'examples' },
            skill_name: 'no-such-skill',
          },
        ]),
      },
      cloud.collections.get('shared-upstream'),
    );
    await r.call(
      'apply an update whose skill cannot be resolved',
      COLLECTIONS_CHANNELS.APPLY_SHARED_UPDATE,
      {
        collectionId: installed.id,
        expectedRevision: text(after, 'revision'),
      },
    );
    await r.call(
      'the collection keeps its last applied state',
      COLLECTIONS_CHANNELS.LOAD_COLLECTION,
      installed.id,
    );
    cloud.collections.delete('shared-upstream');
    await r.call(
      'apply after the share was deleted',
      COLLECTIONS_CHANNELS.APPLY_SHARED_UPDATE,
      {
        collectionId: installed.id,
        expectedRevision: text(after, 'revision'),
      },
    );
    expect(r.snapshot()).toMatchSnapshot();
  });

  test("App Advisor's collection sharing actions on their main host", async () => {
    const r = new Recorder();
    const { dispatchAdvisorCollectionSharingAction } =
      await import('../app-advisor/advisor-collection-sharing-actions');
    const { mainAdvisorCollectionSharingHost } =
      await import('../app-advisor/advisor-collection-sharing-actions-host');
    const questions: unknown[] = [];
    let answer: { selectedOptions: string[]; answeredBy?: 'person' | 'agent' } =
      { selectedOptions: [] };
    const host = mainAdvisorCollectionSharingHost({
      chatId: 'advisor-chat',
      requestUserAnswers: (asked) => {
        questions.push(asked);
        return Promise.resolve([answer]);
      },
    });
    const act = (
      label: string,
      action: Parameters<typeof dispatchAdvisorCollectionSharingAction>[0],
    ): Promise<unknown> =>
      r.record(label, () =>
        dispatchAdvisorCollectionSharingAction(action, host),
      );
    await writeCustomSkill('tone', 'Keep it plain.');
    const local = await saveLocal({
      name: 'Advisor kit',
      skills: [{ sourceId: 'custom:app', skillName: 'tone' }],
    });
    const unresolved = await saveLocal({
      name: 'Unresolved kit',
      skills: [
        { sourceId: 'custom:app', skillName: 'tone' },
        { sourceId: 'builtin:examples', skillName: 'changelog' },
      ],
    });
    const withMcp = await saveLocal({
      name: 'Connected kit',
      mcpServers: [{ serverId: 'abc123', configId: 'def456' }],
    });
    await act('share a missing collection', {
      type: 'collections.share',
      id: 'abcdef00-0000-4000-8000-000000000000',
      shareScope: 'team',
      teamId: TEAM_A,
    });
    await act('share a collection holding MCP servers', {
      type: 'collections.share',
      id: text(withMcp, 'id'),
      shareScope: 'team',
      teamId: TEAM_A,
    });
    await act('share to an organization the account is not in', {
      type: 'collections.share',
      id: text(local, 'id'),
      shareScope: 'organization',
      organizationId: ORG_B,
    });
    await act(
      'share to the organization while the Personal context is selected',
      {
        type: 'collections.share',
        id: text(local, 'id'),
        shareScope: 'organization',
      },
    );
    await r.record('switch to the organization context', () =>
      switchContext(ORG_A),
    );
    await act('share a collection whose skill is not installed', {
      type: 'collections.share',
      id: text(unresolved, 'id'),
      shareScope: 'organization',
      organizationId: ORG_A,
    });
    const shared = await act('share to a member organization', {
      type: 'collections.share',
      id: text(local, 'id'),
      shareScope: 'organization',
      organizationId: ORG_A,
    });
    const sharedId = text(
      field(field(shared, 'result'), 'sharedCollection'),
      'id',
    );
    await act('list shared collections', {
      type: 'collections.list_shared',
      query: 'kit',
      limit: 5,
    });
    await act('update the share from the local collection', {
      type: 'collections.update_shared',
      collectionId: sharedId,
      id: text(local, 'id'),
    });
    await act('update from a missing local collection', {
      type: 'collections.update_shared',
      collectionId: sharedId,
      id: 'abcdef00-0000-4000-8000-000000000000',
    });
    storeCollection('shared-incoming', {
      rawCollection: collectionDocument('Incoming kit', [
        {
          type: 'skill',
          source: { type: 'builtin', id: 'examples' },
          skill_name: 'changelog',
        },
      ]),
    });
    const incoming = cloud.collections.get('shared-incoming');
    if (incoming)
      incoming.package = {
        digest: `pp:v1:${'A'.repeat(43)}`,
        version: 1,
        resources: [],
        environmentRequirements: [],
        totalFiles: 0,
        totalBytes: 0,
      };
    answer = { selectedOptions: ['Cancel'], answeredBy: 'person' };
    await act('import declined by the person', {
      type: 'collections.import_shared',
      collectionId: 'shared-incoming',
    });
    answer = { selectedOptions: ['Import'], answeredBy: 'agent' };
    await act('import confirmed only by an agent', {
      type: 'collections.import_shared',
      collectionId: 'shared-incoming',
    });
    answer = { selectedOptions: ['Import'], answeredBy: 'person' };
    await act('import confirmed by the person, its package unavailable', {
      type: 'collections.import_shared',
      collectionId: 'shared-incoming',
    });
    await act('import a missing share', {
      type: 'collections.import_shared',
      collectionId: 'shared-missing',
    });
    await act('delete the share', {
      type: 'collections.delete_shared',
      collectionId: sharedId,
    });
    await act('delete it again', {
      type: 'collections.delete_shared',
      collectionId: sharedId,
    });
    await r.record('questions asked', () => Promise.resolve(questions));
    expect(r.snapshot()).toMatchSnapshot();
  });
});

describe('with organization projects off', () => {
  beforeEach(async () => {
    orgProjects = false;
    await resetLocalState();
  });

  test('hosted calls and installs skip the context checks', async () => {
    const r = new Recorder();
    seedForeign('shared-foreign-org', {
      type: 'organization',
      id: ORG_B,
      name: 'Org 2222',
    });
    const upstream = storeCollection('shared-upstream', {
      rawCollection: collectionDocument('Upstream kit'),
    });
    await r.call(
      'list shared collections',
      COLLECTIONS_CHANNELS.SHARED_LIST,
      {},
    );
    await r.call('list again', COLLECTIONS_CHANNELS.SHARED_LIST, {});
    await r.call(
      'get a share owned by an organization the account is not in',
      COLLECTIONS_CHANNELS.SHARED_GET,
      'shared-foreign-org',
    );
    await r.call(
      'share to an organization the account is not in',
      COLLECTIONS_CHANNELS.SHARED_CREATE,
      {
        rawCollection: collectionDocument('Stray kit'),
        shareScope: 'organization',
        organizationId: ORG_B,
      },
    );
    await r.call('share to a team', COLLECTIONS_CHANNELS.SHARED_CREATE, {
      rawCollection: collectionDocument('Team kit'),
      shareScope: 'team',
      teamId: TEAM_A,
    });
    const installed = await r.call(
      'install a collection from a share',
      COLLECTIONS_CHANNELS.SAVE_COLLECTION,
      {
        name: 'Upstream kit',
        description: '',
        skills: [],
        plugins: [],
        mcpServers: [],
        sharedSource: {
          remoteId: 'shared-upstream',
          fetchedAt: STAMP,
          contentHash: upstream.contentHash,
        },
      },
    );
    const id = text(valueOf(installed), 'id');
    await r.call('load it', COLLECTIONS_CHANNELS.LOAD_COLLECTION, id);
    await r.call('load the index', COLLECTIONS_CHANNELS.LOAD_INDEX);
    await r.call(
      'apply the unchanged share',
      COLLECTIONS_CHANNELS.APPLY_SHARED_UPDATE,
      {
        collectionId: id,
        expectedRevision: text(valueOf(installed), 'revision'),
      },
    );
    await r.call('delete it', COLLECTIONS_CHANNELS.DELETE_COLLECTION, id);
    expect(r.snapshot()).toMatchSnapshot();
  });
});
