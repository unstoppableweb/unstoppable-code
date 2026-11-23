// CAN-4170 golden: local collections through core.catalog.entry.get and
// core.catalog.entry.upsert on the desktop dispatcher, over the real
// collection store on a data root the suite owns. A stored config that can't
// be read is answered as unreadable, never as missing.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  collectionEntryId,
  type CanopyCallerDescriptor,
  type CatalogCollectionMembers,
} from '@canopy/protocol/canopy-core';
import type { InstalledSkillInfo } from '@canopy/desktop-shared/types/skills';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import type * as PluginService from '../plugins/plugin-service';
import type * as SkillService from '../skills/skill-service';
import type * as AccountCatalog from '../mcp/account-catalog';
import type * as CloudAccountStore from '../lib/canopy-cloud-account-store';
import type * as ServerClient from '../collections/canopy-server-client';
import type * as SharedItemSubscriptions from '../canopy-cloud/shared-item-subscriptions';

// Resource contexts are off unless a case turns them on, with the signed-in
// account below and an organization whose context the foreground refuses.
const mockContext: { enabled: boolean; refusedOrganization: string | null } = {
  enabled: false,
  refusedOrganization: null,
};
jest.mock('../lib/resource-context', () => {
  const decide = (resource: { owner?: unknown }): Promise<void> => {
    const owner = resource.owner;
    return typeof owner === 'object' &&
      owner !== null &&
      'type' in owner &&
      owner.type === 'organization' &&
      'id' in owner &&
      owner.id === mockContext.refusedOrganization
      ? Promise.reject(new Error('Resource unavailable (context)'))
      : Promise.resolve();
  };
  return {
    resourceContextEnabled: (): boolean => mockContext.enabled,
    resourceContextSnapshot: (): Promise<string> => Promise.resolve('context'),
    assertResourceContextSnapshot: (): Promise<void> => Promise.resolve(),
    assertResourceContext: decide,
    assertResourceContextForContext: decide,
  };
});
jest.mock('../lib/canopy-cloud-account-store', () => {
  const actual = jest.requireActual<typeof CloudAccountStore>(
    '../lib/canopy-cloud-account-store',
  );
  return {
    ...actual,
    readCanopyCloudAccountWithStatus: (
      ...args: Parameters<typeof actual.readCanopyCloudAccountWithStatus>
    ): Promise<unknown> =>
      mockContext.enabled
        ? Promise.resolve({
            status: 'ok',
            entry: { account: { id: 'account-1' } },
          })
        : actual.readCanopyCloudAccountWithStatus(...args),
  };
});
// Only the outside organization's share is still live; every other share an
// installed collection came from has been revoked.
jest.mock('../collections/canopy-server-client', () => ({
  ...jest.requireActual<typeof ServerClient>(
    '../collections/canopy-server-client',
  ),
  getSharedCollection: (remoteId: string): Promise<unknown> =>
    remoteId === 'remote-outside'
      ? Promise.resolve({
          id: 'remote-outside',
          owner: {
            type: 'organization',
            id: 'dededede-0000-4000-8000-00000000000e',
            name: null,
          },
          shareScope: 'organization',
          contentHash: 'a'.repeat(64),
        })
      : Promise.reject(new Error('Shared collection not found')),
}));
// Installs and uninstalls are not synced to the hosted service from here.
jest.mock('../canopy-cloud/shared-item-subscriptions', () => ({
  ...jest.requireActual<typeof SharedItemSubscriptions>(
    '../canopy-cloud/shared-item-subscriptions',
  ),
  recordSharedItemInstall: (): void => undefined,
  recordSharedItemUninstall: (): void => undefined,
}));

const SKILL: InstalledSkillInfo = {
  name: 'deploy',
  sourceId: 'user',
  description: 'Deploy the app',
  source: 'user',
  installedAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  updateAvailable: false,
};
jest.mock('../skills/skill-service', () => ({
  ...jest.requireActual<typeof SkillService>('../skills/skill-service'),
  loadSkills: (): { success: true; data: InstalledSkillInfo[] } => ({
    success: true,
    data: [SKILL],
  }),
}));
const pluginsCache = (): unknown => ({
  success: true,
  data: {
    marketplaces: [
      {
        id: 'owner/tools',
        name: 'Tools',
        sourceType: 'github',
        sourceUrl: 'https://github.com/owner/tools',
        installLocation: '/cache',
        pluginCount: 1,
        plugins: [
          {
            name: 'linter',
            description: 'Lints',
            sourcePath: '/cache/linter',
            marketplaceId: 'owner/tools',
            providerSupport: { claude: 'native', codex: 'none' },
          },
        ],
        validProviders: ['claude'],
      },
    ],
  },
});
jest.mock('../plugins/plugin-service', () => ({
  ...jest.requireActual<typeof PluginService>('../plugins/plugin-service'),
  loadMarketplaces: (): Promise<unknown> => Promise.resolve(pluginsCache()),
  loadMarketplacesCacheOnly: (): Promise<unknown> =>
    Promise.resolve(pluginsCache()),
}));
jest.mock('../mcp/account-catalog', () => ({
  ...jest.requireActual<typeof AccountCatalog>('../mcp/account-catalog'),
  loadAccountMcpRefConnections: (): Promise<null> => Promise.resolve(null),
}));

const ID_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const ID_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const ID_S = 'cccccccc-0000-4000-8000-000000000003';
const ID_NONE = 'dddddddd-0000-4000-8000-000000000004';
const STAMP = '2026-11-01T00:00:00.000Z';
const SERVER = 'eeeeeeee-0000-4000-8000-000000000005';
const CONFIG = 'ffffffff-0000-4000-8000-000000000006';
const OTHER_SERVER = '99999999-0000-4000-8000-000000000007';
const ID_X = '12121212-0000-4000-8000-000000000008';
const ORG_OWNER = { type: 'organization', organizationId: 'org-1' };
const ID_PAIR = '34343434-0000-4000-8000-000000000009';
const ID_ORG = '56565656-0000-4000-8000-00000000000a';
const ID_REVOKED = '78787878-0000-4000-8000-00000000000b';
const ID_OUTSIDE = '9a9a9a9a-0000-4000-8000-00000000000c';
const ID_MALFORMED = 'bcbcbcbc-0000-4000-8000-00000000000d';
const ORG_OUTSIDE = 'dededede-0000-4000-8000-00000000000e';
const ID_MALFORMED_OUTSIDE = 'efefefef-0000-4000-8000-00000000000f';
const ID_UNDATED = '13131313-0000-4000-8000-000000000010';
const UNREADABLE = {
  kind: 'failed_precondition',
  code: 'core.catalog.entryUnreadable',
};
const SAME_IDS = { serverId: SERVER, configId: CONFIG };
const OTHER_MCP = { serverId: OTHER_SERVER, configId: CONFIG };
const PAIR = [SAME_IDS, { ...SAME_IDS, owner: ORG_OWNER }];
const OWNER_UNKNOWN = {
  kind: 'failed_precondition',
  code: undefined,
  retry: { kind: 'never' },
};
const OWNER_UNKNOWN_MESSAGE =
  "This edit changes MCP server connections that can't be told apart here. Edit the collection in the app.";
const SHARE_HASH = 'a'.repeat(64);

const MEMBERS = {
  skills: [
    { sourceId: 'user', skillName: 'deploy' },
    { sourceId: 'user', skillName: 'ghost' },
  ],
  plugins: [{ marketplaceId: 'owner/tools', pluginName: 'linter' }],
  mcpServers: [{ serverId: SERVER, configId: CONFIG }],
};
const UNRESOLVED = [
  { kind: 'skill', sourceId: 'user', skillName: 'ghost' },
  { kind: 'mcp_server', serverId: SERVER, configId: CONFIG },
];

const inheritedDirs = {
  CANOPY_DATA_DIR: process.env.CANOPY_DATA_DIR,
  CANOPY_SECURE_DATA_DIR: process.env.CANOPY_SECURE_DATA_DIR,
};
let root = '';
const collectionsDir = (): string => join(root, 'data', 'collections');
const configPath = (id: string): string =>
  join(collectionsDir(), `collection-${id}.json`);
const preferencesPath = (): string => join(root, 'data', 'preferences.json');

function seedConfig(
  id: string,
  name: string,
  extra: Record<string, unknown> = {},
): void {
  writeFileSync(
    configPath(id),
    JSON.stringify({
      version: 2,
      collection: {
        id,
        name,
        description: `${name} collection`,
        skills: MEMBERS.skills,
        plugins: MEMBERS.plugins,
        mcpServers: [{ serverId: SERVER, configId: CONFIG, owner: ORG_OWNER }],
        createdAt: STAMP,
        updatedAt: STAMP,
        revision: `rev-${name}`,
        ...extra,
      },
    }),
  );
}

function storedCollection(id: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(configPath(id), 'utf8'));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('collection' in parsed) ||
    typeof parsed.collection !== 'object' ||
    parsed.collection === null
  )
    throw new Error(`No stored collection ${id}`);
  return { ...parsed.collection };
}

const caller = (
  grants: CanopyCallerDescriptor['grants'],
): CanopyCallerDescriptor => ({
  principalId: 'local-desktop-user',
  clientInstanceId: 'collection-entries-golden',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants,
});

let dispatcher: DesktopCanopyDispatcher;
let keyCount = 0;
let preferencesBefore = '';

function get(id: string): Promise<unknown> {
  return dispatcher.query(
    'core.catalog.entry.get',
    { kind: 'collection', read: 'entry', entryId: collectionEntryId(id) },
    { caller: caller(['core.catalog.read']) },
  );
}

type UpsertRequest = {
  name: string;
  description?: string;
  members?: CatalogCollectionMembers;
  sharedRevision?: {
    remoteId: string;
    contentHash: string;
    fromPublicShare: boolean;
  } | null;
} & (
  | { entryId: null; expectedRevision: null }
  | { entryId: string; expectedRevision: string }
);

function upsert(
  request: UpsertRequest,
  options: {
    key?: string;
    grants?: CanopyCallerDescriptor['grants'];
  } = {},
): Promise<unknown> {
  const idempotencyKey = options.key ?? `collection-entries-${(keyCount += 1)}`;
  const base = {
    kind: 'collection' as const,
    name: request.name,
    description: request.description ?? '',
    members: request.members ?? { skills: [], plugins: [], mcpServers: [] },
    sharedRevision: request.sharedRevision ?? null,
    _meta: { idempotencyKey },
  };
  return dispatcher.instruction(
    'core.catalog.entry.upsert',
    request.entryId === null
      ? { ...base, entryId: null, expectedRevision: null }
      : {
          ...base,
          entryId: request.entryId,
          expectedRevision: request.expectedRevision,
        },
    {
      caller: caller(options.grants ?? ['core.catalog.write']),
      metadata: { idempotencyKey },
    },
  );
}

function remove(
  id: string,
  expectedRevision: string,
  key = `collection-delete-${(keyCount += 1)}`,
): Promise<unknown> {
  return dispatcher.instruction(
    'core.catalog.entry.delete',
    {
      kind: 'collection',
      entryId: collectionEntryId(id),
      expectedRevision,
      _meta: { idempotencyKey: key },
    },
    {
      caller: caller(['core.catalog.write']),
      metadata: { idempotencyKey: key },
    },
  );
}

async function refusal(call: Promise<unknown>): Promise<unknown> {
  try {
    await call;
  } catch (error) {
    if (!(error instanceof CanopyOperationError)) throw error;
    const { kind, code, details } = error.payload;
    return { kind, code, details };
  }
  throw new Error('expected a refusal');
}

async function refusalWithRetry(call: Promise<unknown>): Promise<unknown> {
  try {
    await call;
  } catch (error) {
    if (!(error instanceof CanopyOperationError)) throw error;
    const { kind, code, retry } = error.payload;
    return { kind, code, retry };
  }
  throw new Error('expected a refusal');
}

/** Every entry in the collections directory, with a file's bytes. */
function collectionFiles(): Record<string, string> {
  return Object.fromEntries(
    readdirSync(collectionsDir())
      .sort()
      .map((name) => {
        const path = join(collectionsDir(), name);
        return [
          name,
          statSync(path).isDirectory()
            ? 'directory'
            : readFileSync(path, 'utf8'),
        ];
      }),
  );
}

async function withResourceContext(work: () => Promise<void>): Promise<void> {
  mockContext.enabled = true;
  try {
    await work();
  } finally {
    mockContext.enabled = false;
    mockContext.refusedOrganization = null;
  }
}

/** Installs `id` from the share `remoteId`, as the signed-in account. */
async function recordInstall(
  id: string,
  remoteId: string,
  ownerContext:
    | { kind: 'personal' }
    | { kind: 'organization'; organizationId: string },
  extra: Record<string, unknown> = {},
): Promise<void> {
  seedConfig(id, id === ID_REVOKED ? 'Revoked' : 'Outside', {
    ...extra,
    sharedSource: {
      remoteId,
      fetchedAt: STAMP,
      fromPublicShare: false,
      contentHash: SHARE_HASH,
    },
  });
  const { createResourceInstallReceiptsStore } =
    await import('../lib/resource-install-receipts');
  await createResourceInstallReceiptsStore('account-1').record({
    family: 'collections',
    remoteId,
    localResourceIds: [id],
    shareScope:
      ownerContext.kind === 'organization' ? 'organization' : 'private',
    ownerContext,
    hash: SHARE_HASH,
    authorizedAt: STAMP,
  });
}

async function entryOf(id: string): Promise<Record<string, unknown>> {
  const read: unknown = await get(id);
  if (
    typeof read !== 'object' ||
    read === null ||
    !('entry' in read) ||
    typeof read.entry !== 'object' ||
    read.entry === null
  )
    throw new Error(`No entry for ${id}`);
  return { ...read.entry };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'collection-entries-'));
  process.env.CANOPY_DATA_DIR = join(root, 'data');
  process.env.CANOPY_SECURE_DATA_DIR = join(root, 'secure');
  mkdirSync(collectionsDir(), { recursive: true });
  seedConfig(ID_A, 'Alpha');
  seedConfig(ID_S, 'Shared', {
    sharedSource: {
      remoteId: 'remote-1',
      fetchedAt: STAMP,
      fromPublicShare: false,
      contentHash: SHARE_HASH,
    },
    remote: {
      remoteId: 'remote-2',
      contentHash: SHARE_HASH,
      shareScope: 'team',
      sharedAt: STAMP,
    },
  });
  // #10260's fault: config B is a folder (an I/O error) and the index is
  // damaged, so the index can't be rebuilt while B can't be read.
  mkdirSync(configPath(ID_B));
  writeFileSync(join(collectionsDir(), 'index.json'), '{ not json');
  const { updatePreferencesFile } = await import('../lib/preferences-store');
  await updatePreferencesFile((current) => ({
    ...current,
    globalPluginSelections: {
      collectionIds: [ID_A],
      skillRefs: [],
      pluginRefs: [],
    },
  }));
  preferencesBefore = readFileSync(preferencesPath(), 'utf8');
  const { createDesktopRuntime } =
    await import('../canopy-runtime/desktop-runtime');
  dispatcher = createDesktopRuntime({ shutdownTimeoutMs: 25 });
});

afterAll(async () => {
  await dispatcher.shutdown();
  for (const [name, value] of Object.entries(inheritedDirs)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe('Local collections through core.catalog.entry (CAN-4170)', () => {
  it('reads a collection with its revision, members and the members nothing installed answers', async () => {
    expect(await get(ID_A)).toEqual({
      read: 'entry',
      entry: {
        kind: 'collection',
        entryId: collectionEntryId(ID_A),
        revision: 'rev-Alpha',
        name: 'Alpha',
        description: 'Alpha collection',
        members: MEMBERS,
        createdAt: STAMP,
        updatedAt: STAMP,
        sharedSource: null,
        share: null,
        unresolvedMembers: UNRESOLVED,
      },
    });
  });

  it('reads where an added collection came from and its own share link', async () => {
    const entry = await entryOf(ID_S);
    expect({
      sharedSource: entry.sharedSource,
      share: entry.share,
    }).toEqual({
      sharedSource: {
        remoteId: 'remote-1',
        contentHash: SHARE_HASH,
        fromPublicShare: false,
        fetchedAt: STAMP,
      },
      share: {
        remoteId: 'remote-2',
        contentHash: SHARE_HASH,
        shareScope: 'team',
        sharedAt: STAMP,
      },
    });
  });

  it('answers a collection the store does not have as not found', async () => {
    expect(await refusal(get(ID_NONE))).toEqual({
      kind: 'not_found',
      code: 'core.catalog.entryNotFound',
      details: undefined,
    });
  });

  it('answers a collection that cannot be read as unreadable, never as not found, while the index cannot be read', async () => {
    expect(await refusal(get(ID_B))).toMatchObject({
      kind: 'failed_precondition',
      code: 'core.catalog.entryUnreadable',
    });
    const listed = await refusal(
      dispatcher.query(
        'core.catalog.snapshot.get',
        { scope: {}, kinds: ['collection'], includeUnavailable: true },
        { caller: caller(['core.catalog.read']) },
      ),
    );
    expect(listed).toMatchObject({ kind: 'unavailable' });
  });

  it('creates a collection with a trimmed name, keeping the members nothing installed answers', async () => {
    const created: unknown = await upsert({
      entryId: null,
      expectedRevision: null,
      name: '  Gamma  ',
      description: 'New',
      members: MEMBERS,
    });
    if (
      typeof created !== 'object' ||
      created === null ||
      !('entry' in created) ||
      typeof created.entry !== 'object' ||
      created.entry === null ||
      !('entryId' in created.entry) ||
      typeof created.entry.entryId !== 'string'
    )
      throw new Error('No created entry');
    expect(created.entry).toMatchObject({
      kind: 'collection',
      name: 'Gamma',
      description: 'New',
      members: MEMBERS,
      sharedSource: null,
      share: null,
      unresolvedMembers: UNRESOLVED,
    });
    const id = created.entry.entryId.slice('collection:'.length);
    expect(await get(id)).toEqual({ read: 'entry', entry: created.entry });
  });

  it('replaces a collection at the revision read, keeping its provenance, share link and member owners', async () => {
    const before = await entryOf(ID_S);
    const replaced: unknown = await upsert({
      entryId: collectionEntryId(ID_S),
      expectedRevision: 'rev-Shared',
      name: 'Shared renamed',
      members: MEMBERS,
    });
    expect(replaced).toMatchObject({
      entry: {
        name: 'Shared renamed',
        sharedSource: before.sharedSource,
        share: before.share,
        createdAt: STAMP,
      },
    });
    const stored = storedCollection(ID_S);
    expect({
      revisionChanged: stored.revision !== 'rev-Shared',
      mcpServers: stored.mcpServers,
    }).toEqual({
      revisionChanged: true,
      mcpServers: [{ serverId: SERVER, configId: CONFIG, owner: ORG_OWNER }],
    });
  });

  it('reads and replaces a collection with no stored date, leaving it undated (CAN-5239)', async () => {
    // A legacy config without createdAt: JSON drops the undefined field.
    seedConfig(ID_UNDATED, 'Undated', { createdAt: undefined });
    const read = await entryOf(ID_UNDATED);
    expect({ read: 'createdAt' in read, revision: read.revision }).toEqual({
      read: false,
      revision: 'rev-Undated',
    });
    const replaced: unknown = await upsert({
      entryId: collectionEntryId(ID_UNDATED),
      expectedRevision: 'rev-Undated',
      name: 'Undated renamed',
      members: MEMBERS,
    });
    if (
      typeof replaced !== 'object' ||
      replaced === null ||
      !('entry' in replaced) ||
      typeof replaced.entry !== 'object' ||
      replaced.entry === null
    )
      throw new Error('No replaced entry');
    const written: Record<string, unknown> = { ...replaced.entry };
    const stored = storedCollection(ID_UNDATED);
    expect({
      written: 'createdAt' in written,
      name: written.name,
      stored: 'createdAt' in stored,
      revisionChanged: stored.revision !== 'rev-Undated',
    }).toEqual({
      written: false,
      name: 'Undated renamed',
      stored: false,
      revisionChanged: true,
    });
    expect(await get(ID_UNDATED)).toEqual({ read: 'entry', entry: written });
  });

  it('drops a removed MCP member with its owner, and gives an added one none', async () => {
    const current = await entryOf(ID_S);
    if (typeof current.revision !== 'string') throw new Error('No revision');
    await upsert({
      entryId: collectionEntryId(ID_S),
      expectedRevision: current.revision,
      name: 'Shared renamed',
      members: {
        ...MEMBERS,
        mcpServers: [{ serverId: OTHER_SERVER, configId: CONFIG }],
      },
    });
    expect(storedCollection(ID_S).mcpServers).toEqual([
      { serverId: OTHER_SERVER, configId: CONFIG },
    ]);
  });

  it('keeps a personal and an organization MCP member with the same ids, owners included, through a replace that leaves them', async () => {
    seedConfig(ID_PAIR, 'Pair', { mcpServers: PAIR });
    const before = readFileSync(configPath(ID_PAIR), 'utf8');
    const read = await entryOf(ID_PAIR);
    const members = { ...MEMBERS, mcpServers: [SAME_IDS, SAME_IDS] };
    expect(read.members).toEqual(members);
    await upsert({
      entryId: collectionEntryId(ID_PAIR),
      expectedRevision: 'rev-Pair',
      name: 'Pair',
      description: 'Pair collection',
      members,
    });
    const after = readFileSync(configPath(ID_PAIR), 'utf8');
    expect(after).not.toBe(before);
    expect(JSON.stringify(storedCollection(ID_PAIR).mcpServers)).toBe(
      JSON.stringify(PAIR),
    );
  });

  it('refuses an edit that removes or adds one of several MCP members with the same ids, writing nothing', async () => {
    seedConfig(ID_PAIR, 'Pair', { mcpServers: PAIR });
    const before = readFileSync(configPath(ID_PAIR), 'utf8');
    const edit = (
      mcpServers: CatalogCollectionMembers['mcpServers'],
    ): Promise<unknown> =>
      refusalWithRetry(
        upsert({
          entryId: collectionEntryId(ID_PAIR),
          expectedRevision: 'rev-Pair',
          name: 'Pair',
          members: { ...MEMBERS, mcpServers },
        }),
      );
    expect({
      removed: await edit([SAME_IDS]),
      added: await edit([SAME_IDS, SAME_IDS, SAME_IDS]),
    }).toEqual({ removed: OWNER_UNKNOWN, added: OWNER_UNKNOWN });
    expect(readFileSync(configPath(ID_PAIR), 'utf8')).toBe(before);
  });

  it('refuses adding an MCP member with the ids of an organization member, writing nothing', async () => {
    seedConfig(ID_ORG, 'Org');
    const before = readFileSync(configPath(ID_ORG), 'utf8');
    const added = upsert({
      entryId: collectionEntryId(ID_ORG),
      expectedRevision: 'rev-Org',
      name: 'Org',
      members: { ...MEMBERS, mcpServers: [SAME_IDS, SAME_IDS] },
    });
    await expect(added).rejects.toThrow(OWNER_UNKNOWN_MESSAGE);
    expect(await refusalWithRetry(added)).toEqual(OWNER_UNKNOWN);
    expect(readFileSync(configPath(ID_ORG), 'utf8')).toBe(before);
  });

  it('keeps both owners of a same-id pair when an edit changes the members beside it', async () => {
    seedConfig(ID_PAIR, 'Pair', { mcpServers: PAIR });
    await upsert({
      entryId: collectionEntryId(ID_PAIR),
      expectedRevision: 'rev-Pair',
      name: 'Pair renamed',
      members: {
        skills: [],
        plugins: MEMBERS.plugins,
        mcpServers: [SAME_IDS, OTHER_MCP, SAME_IDS],
      },
    });
    expect(storedCollection(ID_PAIR)).toMatchObject({
      name: 'Pair renamed',
      skills: [],
      mcpServers: [SAME_IDS, OTHER_MCP, { ...SAME_IDS, owner: ORG_OWNER }],
    });
  });

  it('drops every MCP member with the same ids when an edit removes them all', async () => {
    seedConfig(ID_PAIR, 'Pair', { mcpServers: PAIR });
    await upsert({
      entryId: collectionEntryId(ID_PAIR),
      expectedRevision: 'rev-Pair',
      name: 'Pair',
      members: { ...MEMBERS, mcpServers: [OTHER_MCP] },
    });
    expect(storedCollection(ID_PAIR).mcpServers).toEqual([OTHER_MCP]);
  });

  it('refuses a replace at another revision and writes nothing', async () => {
    const before = readFileSync(configPath(ID_A), 'utf8');
    expect(
      await refusal(
        upsert({
          entryId: collectionEntryId(ID_A),
          expectedRevision: 'rev-stale',
          name: 'Alpha changed',
        }),
      ),
    ).toEqual({
      kind: 'conflict',
      code: 'core.catalog.revisionConflict',
      details: { currentRevision: 'rev-Alpha' },
    });
    expect(readFileSync(configPath(ID_A), 'utf8')).toBe(before);
  });

  it('refuses to replace a collection that cannot be read, or one the store does not have', async () => {
    expect({
      unreadable: await refusal(
        upsert({
          entryId: collectionEntryId(ID_B),
          expectedRevision: 'rev-B',
          name: 'Beta',
        }),
      ),
      missing: await refusal(
        upsert({
          entryId: collectionEntryId(ID_NONE),
          expectedRevision: 'rev-none',
          name: 'None',
        }),
      ),
    }).toMatchObject({
      unreadable: {
        kind: 'failed_precondition',
        code: 'core.catalog.entryUnreadable',
      },
      missing: { kind: 'not_found', code: 'core.catalog.entryNotFound' },
    });
    expect(statSync(configPath(ID_B)).isDirectory()).toBe(true);
  });

  it('answers a replayed upsert from its first outcome and refuses its key with other params', async () => {
    const params = {
      entryId: null,
      expectedRevision: null,
      name: 'Replayed',
    };
    const first = await upsert(params, { key: 'replayed-key' });
    expect(await upsert(params, { key: 'replayed-key' })).toEqual(first);
    expect(
      await refusal(
        upsert({ ...params, name: 'Other' }, { key: 'replayed-key' }),
      ),
    ).toMatchObject({ kind: 'conflict' });
  });

  // The ledger records an outcome of up to 32,768 characters (CAN-5898); with
  // 16-character skill names, 268 members fit the worst-case entry, 269 don't.
  it('saves a collection just under the ledger cap and refuses one just over it, writing nothing', async () => {
    const skills = (count: number): CatalogCollectionMembers['skills'] =>
      Array.from({ length: count }, (_, index) => ({
        sourceId: 'user',
        skillName: `skill-${String(index).padStart(4, '0')}`.padEnd(16, 'x'),
      }));
    const capped = (count: number): Promise<unknown> =>
      upsert({
        entryId: null,
        expectedRevision: null,
        name: 'Cap',
        members: { skills: skills(count), plugins: [], mcpServers: [] },
      });
    const before = readdirSync(collectionsDir()).sort();
    expect(await refusal(capped(269))).toMatchObject({
      kind: 'resource_exhausted',
    });
    expect(readdirSync(collectionsDir()).sort()).toEqual(before);
    const saved: unknown = await capped(268);
    expect(saved).toMatchObject({
      entry: { name: 'Cap', members: { skills: skills(268) } },
    });
    const added = readdirSync(collectionsDir()).filter(
      (name) => !before.includes(name),
    );
    expect(added).toHaveLength(1);
    const [file] = added;
    const id = file?.slice('collection-'.length, -'.json'.length) ?? '';
    expect(storedCollection(id)).toMatchObject({
      name: 'Cap',
      skills: skills(268),
    });
  });

  it('refuses an upsert when the installed catalog cannot be read, writing nothing, and its key then writes once', async () => {
    const service = await import('../services/plugin-catalog-service');
    const before = collectionFiles();
    const current = await entryOf(ID_S);
    if (typeof current.revision !== 'string') throw new Error('No revision');
    const create = {
      entryId: null,
      expectedRevision: null,
      name: 'Pending',
    } as const;
    const failing = jest
      .spyOn(service, 'buildCachedPluginCatalog')
      .mockRejectedValue(new Error('catalog read failed'));
    try {
      expect({
        create: await refusalWithRetry(
          upsert(create, { key: 'installed-unreadable' }),
        ),
        replace: await refusalWithRetry(
          upsert({
            entryId: collectionEntryId(ID_S),
            expectedRevision: current.revision,
            name: 'Shared pending',
          }),
        ),
      }).toEqual({
        create: {
          kind: 'unavailable',
          retry: { kind: 'same_idempotency_key' },
        },
        replace: {
          kind: 'unavailable',
          retry: { kind: 'same_idempotency_key' },
        },
      });
    } finally {
      failing.mockRestore();
    }
    expect(collectionFiles()).toEqual(before);
    expect((await entryOf(ID_S)).revision).toBe(current.revision);
    // A refusal the key had recorded would replay here; this one runs.
    const created: unknown = await upsert(create, {
      key: 'installed-unreadable',
    });
    if (
      typeof created !== 'object' ||
      created === null ||
      !('entry' in created) ||
      typeof created.entry !== 'object' ||
      created.entry === null ||
      !('entryId' in created.entry) ||
      typeof created.entry.entryId !== 'string' ||
      !('revision' in created.entry) ||
      typeof created.entry.revision !== 'string'
    )
      throw new Error('The retry answered no entry');
    const id = created.entry.entryId.slice('collection:'.length);
    expect(
      Object.keys(collectionFiles()).filter(
        (name) => name.startsWith('collection-') && !(name in before),
      ),
    ).toEqual([`collection-${id}.json`]);
    expect(storedCollection(id)).toMatchObject({
      name: 'Pending',
      revision: created.entry.revision,
    });
    expect(await upsert(create, { key: 'installed-unreadable' })).toEqual(
      created,
    );
    expect(
      Object.keys(collectionFiles()).filter(
        (name) => name.startsWith('collection-') && !(name in before),
      ),
    ).toEqual([`collection-${id}.json`]);
  });

  it('refuses an upsert from a caller without the catalog write grant', async () => {
    expect(
      await refusal(
        upsert(
          { entryId: null, expectedRevision: null, name: 'Denied' },
          { grants: ['core.catalog.read'] },
        ),
      ),
    ).toMatchObject({ kind: 'permission_denied' });
  });

  it('leaves shared updates and import for later PRs', async () => {
    const unavailable = { kind: 'capability_unavailable' };
    expect({
      sharedRevision: await refusal(
        upsert({
          entryId: collectionEntryId(ID_S),
          expectedRevision: 'any',
          name: 'Shared',
          sharedRevision: {
            remoteId: 'remote-1',
            contentHash: SHARE_HASH,
            fromPublicShare: false,
          },
        }),
      ),
      importReadiness: await refusal(
        dispatcher.query(
          'core.catalog.entry.get',
          {
            kind: 'collection',
            read: 'importReadiness',
            remoteId: 'remote-1',
            fromPublicShare: false,
          },
          { caller: caller(['core.catalog.read']) },
        ),
      ),
    }).toMatchObject({
      sharedRevision: unavailable,
      importReadiness: unavailable,
    });
    expect(storedCollection(ID_A).revision).toBe('rev-Alpha');
  });

  it('refuses a guarded store delete at another revision or of a missing collection, deleting nothing', async () => {
    seedConfig(ID_X, 'Guarded');
    const store = await import('../collections/collection-store');
    const codeOf = async (call: Promise<void>): Promise<unknown> =>
      call.then(
        () => 'deleted',
        (error: unknown) =>
          typeof error === 'object' && error !== null && 'code' in error
            ? error.code
            : error,
      );
    expect({
      stale: await codeOf(
        store.deleteCollectionConfig(ID_X, { expectedRevision: 'rev-stale' }),
      ),
      missing: await codeOf(
        store.deleteCollectionConfig(ID_NONE, { expectedRevision: 'rev-any' }),
      ),
    }).toEqual({ stale: 'conflict', missing: 'not_found' });
    expect(existsSync(configPath(ID_X))).toBe(true);
  });

  it('deletes without a guard as before, a missing collection included', async () => {
    const store = await import('../collections/collection-store');
    await expect(store.deleteCollectionConfig(ID_X)).resolves.toBeUndefined();
    await expect(
      store.deleteCollectionConfig(ID_NONE),
    ).resolves.toBeUndefined();
    expect(existsSync(configPath(ID_X))).toBe(false);
  });

  it('deletes a collection at the revision read, and answers a replay from its first outcome', async () => {
    const deleted = {
      kind: 'collection',
      entryId: collectionEntryId(ID_A),
      deleted: true,
    };
    expect(await remove(ID_A, 'rev-Alpha', 'delete-alpha')).toEqual(deleted);
    expect(await remove(ID_A, 'rev-Alpha', 'delete-alpha')).toEqual(deleted);
    expect({
      file: existsSync(configPath(ID_A)),
      read: await refusal(get(ID_A)),
    }).toEqual({
      file: false,
      read: {
        kind: 'not_found',
        code: 'core.catalog.entryNotFound',
        details: undefined,
      },
    });
  });

  it('refuses a delete at another revision, of a missing collection or of one that cannot be read', async () => {
    const current = await entryOf(ID_S);
    expect({
      stale: await refusal(remove(ID_S, 'rev-stale')),
      missing: await refusal(remove(ID_NONE, 'rev-any')),
      unreadable: await refusal(remove(ID_B, 'rev-any')),
    }).toEqual({
      stale: {
        kind: 'conflict',
        code: 'core.catalog.revisionConflict',
        details: { currentRevision: current.revision },
      },
      missing: {
        kind: 'not_found',
        code: 'core.catalog.entryNotFound',
        details: undefined,
      },
      unreadable: {
        kind: 'failed_precondition',
        code: 'core.catalog.entryUnreadable',
        details: undefined,
      },
    });
    expect({
      shared: existsSync(configPath(ID_S)),
      unreadable: statSync(configPath(ID_B)).isDirectory(),
    }).toEqual({ shared: true, unreadable: true });
  });

  it('reads and writes collections while another listed collection cannot be read', async () => {
    const service = await import('../services/plugin-catalog-service');
    const catalog = service.buildCachedPluginCatalog;
    const listed = jest
      .spyOn(service, 'buildCachedPluginCatalog')
      .mockImplementation(async () => ({
        ...(await catalog()),
        collections: [
          {
            id: ID_B,
            name: 'Beta',
            description: '',
            skillCount: 0,
            pluginCount: 0,
            mcpServerCount: 0,
          },
        ],
      }));
    try {
      const created: unknown = await upsert({
        entryId: null,
        expectedRevision: null,
        name: 'Beside an unreadable one',
        members: MEMBERS,
      });
      expect(created).toMatchObject({
        entry: {
          name: 'Beside an unreadable one',
          unresolvedMembers: UNRESOLVED,
        },
      });
      if (
        typeof created !== 'object' ||
        created === null ||
        !('entry' in created) ||
        typeof created.entry !== 'object' ||
        created.entry === null ||
        !('entryId' in created.entry) ||
        typeof created.entry.entryId !== 'string'
      )
        throw new Error('The create answered no entry');
      expect(
        await get(created.entry.entryId.slice('collection:'.length)),
      ).toEqual({ read: 'entry', entry: created.entry });
      expect(await get(ID_S)).toMatchObject({ read: 'entry' });
    } finally {
      listed.mockRestore();
    }
    expect(statSync(configPath(ID_B)).isDirectory()).toBe(true);
  });

  it('never answers or replaces a stored collection whose members the contract refuses, and still removes it', async () => {
    seedConfig(ID_MALFORMED, 'Malformed', { skills: {} });
    const before = readFileSync(configPath(ID_MALFORMED), 'utf8');
    expect({
      read: await refusal(get(ID_MALFORMED)),
      replace: await refusal(
        upsert({
          entryId: collectionEntryId(ID_MALFORMED),
          expectedRevision: 'rev-Malformed',
          name: 'Malformed renamed',
        }),
      ),
    }).toMatchObject({ read: UNREADABLE, replace: UNREADABLE });
    expect(readFileSync(configPath(ID_MALFORMED), 'utf8')).toBe(before);
    expect(await remove(ID_MALFORMED, 'rev-Malformed')).toEqual({
      kind: 'collection',
      entryId: collectionEntryId(ID_MALFORMED),
      deleted: true,
    });
    expect(existsSync(configPath(ID_MALFORMED))).toBe(false);
  });

  it('refuses to delete a stored collection whose members the contract refuses outside the context', async () => {
    await recordInstall(
      ID_MALFORMED_OUTSIDE,
      'remote-malformed-outside',
      { kind: 'organization', organizationId: ORG_OUTSIDE },
      { skills: {} },
    );
    const before = readFileSync(configPath(ID_MALFORMED_OUTSIDE), 'utf8');
    await withResourceContext(async () => {
      mockContext.refusedOrganization = ORG_OUTSIDE;
      expect(
        await refusal(remove(ID_MALFORMED_OUTSIDE, 'rev-Outside')),
      ).toMatchObject(UNREADABLE);
    });
    expect(readFileSync(configPath(ID_MALFORMED_OUTSIDE), 'utf8')).toBe(before);
  });

  it('deletes an installed collection whose share was revoked, which reads and replaces still refuse', async () => {
    await recordInstall(ID_REVOKED, 'remote-revoked', { kind: 'personal' });
    const before = readFileSync(configPath(ID_REVOKED), 'utf8');
    await withResourceContext(async () => {
      expect({
        read: await refusal(get(ID_REVOKED)),
        replace: await refusal(
          upsert({
            entryId: collectionEntryId(ID_REVOKED),
            expectedRevision: 'rev-Revoked',
            name: 'Revoked renamed',
          }),
        ),
      }).toMatchObject({ read: UNREADABLE, replace: UNREADABLE });
      expect(readFileSync(configPath(ID_REVOKED), 'utf8')).toBe(before);
      expect(await remove(ID_REVOKED, 'rev-Revoked')).toEqual({
        kind: 'collection',
        entryId: collectionEntryId(ID_REVOKED),
        deleted: true,
      });
    });
    expect(existsSync(configPath(ID_REVOKED))).toBe(false);
  });

  it('refuses to read, replace or delete a collection outside the context, writing nothing', async () => {
    await recordInstall(ID_OUTSIDE, 'remote-outside', {
      kind: 'organization',
      organizationId: ORG_OUTSIDE,
    });
    const before = readFileSync(configPath(ID_OUTSIDE), 'utf8');
    await withResourceContext(async () => {
      mockContext.refusedOrganization = ORG_OUTSIDE;
      expect({
        read: await refusal(get(ID_OUTSIDE)),
        replace: await refusal(
          upsert({
            entryId: collectionEntryId(ID_OUTSIDE),
            expectedRevision: 'rev-Outside',
            name: 'Outside renamed',
          }),
        ),
        delete: await refusal(remove(ID_OUTSIDE, 'rev-Outside')),
      }).toMatchObject({
        read: UNREADABLE,
        replace: UNREADABLE,
        delete: UNREADABLE,
      });
    });
    expect(readFileSync(configPath(ID_OUTSIDE), 'utf8')).toBe(before);
  });

  it('never writes selections', () => {
    expect(readFileSync(preferencesPath(), 'utf8')).toBe(preferencesBefore);
  });
});
