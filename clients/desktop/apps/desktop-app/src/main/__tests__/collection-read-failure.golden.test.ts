// CAN-4170 golden: no collection read answers a short list while the
// Collection index can't be read. #10260 (CAN-4488) made a damaged-index
// rebuild that can't read a config fail Collection list reads until a
// reconcile reads every config. This drives the real store, catalog service
// and desktop dispatcher on a data root the suite owns, with that fault, and
// pins which reads fail typed, which keep working, and the picker residual.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  collectionEntryId,
  pluginEntryId,
  skillEntryId,
  type CanopyCallerDescriptor,
  type CatalogEntry,
} from '@canopy/protocol/canopy-core';
import type { InstalledSkillInfo } from '@canopy/desktop-shared/types/skills';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import type * as PluginService from '../plugins/plugin-service';
import type * as SkillService from '../skills/skill-service';
import type * as AccountCatalog from '../mcp/account-catalog';

type Handler = (...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (channel: string, handler: Handler): void => {
    handlers.set(channel, handler);
  },
}));
jest.mock('../lib/resource-context', () => ({
  resourceContextEnabled: (): boolean => false,
  resourceContextSnapshot: (): Promise<string> => Promise.resolve('context'),
  assertResourceContextSnapshot: (): Promise<void> => Promise.resolve(),
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

const PLUGIN = {
  name: 'linter',
  description: 'Lints',
  sourcePath: '/cache/linter',
  marketplaceId: 'owner/tools',
  providerSupport: { claude: 'native', codex: 'none' },
};
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
        plugins: [PLUGIN],
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
const STAMP = '2026-11-01T00:00:00.000Z';
const SKILL_ID = skillEntryId({ sourceId: 'user', skillName: 'deploy' });
const PLUGIN_ID = pluginEntryId({
  marketplaceId: 'owner/tools',
  pluginName: 'linter',
});

const inheritedDirs = {
  CANOPY_DATA_DIR: process.env.CANOPY_DATA_DIR,
  CANOPY_SECURE_DATA_DIR: process.env.CANOPY_SECURE_DATA_DIR,
};
let root = '';
const collectionsDir = (): string => join(root, 'data', 'collections');
const configPath = (id: string): string =>
  join(collectionsDir(), `collection-${id}.json`);

function seedConfig(id: string, name: string): void {
  writeFileSync(
    configPath(id),
    JSON.stringify({
      version: 2,
      collection: {
        id,
        name,
        description: '',
        skills: [],
        plugins: [],
        mcpServers: [],
        createdAt: STAMP,
        updatedAt: STAMP,
        revision: `rev-${name}`,
      },
    }),
  );
}

const caller = (
  grants: CanopyCallerDescriptor['grants'],
): CanopyCallerDescriptor => ({
  principalId: 'local-desktop-user',
  clientInstanceId: 'collection-read-failure-golden',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants,
});

let dispatcher: DesktopCanopyDispatcher;
let keyCount = 0;

function snapshot(
  kinds: CatalogEntry['kind'][],
): Promise<{ entries: { entryId: string }[] }> {
  return dispatcher.query(
    'core.catalog.snapshot.get',
    { scope: {}, kinds, includeUnavailable: true },
    { caller: caller(['core.catalog.read']) },
  );
}

function selectionGet(): Promise<{
  revision: number;
  selectedItemIds: string[];
  unavailableItemIds: string[];
}> {
  return dispatcher.query(
    'core.catalog.selection.get',
    { scope: {} },
    { caller: caller(['core.catalog.read']) },
  );
}

async function globalRevision(): Promise<number> {
  const [{ readPreferencesFile }, { normalizePluginSelections }, catalog, ids] =
    await Promise.all([
      import('../lib/preferences-store'),
      import('@canopy/execution-engine/lib/plugin-selections-normalization'),
      import('@canopy/core-runtime/node/catalog'),
      import('@canopy/protocol/canopy-core'),
    ]);
  const preferences = await readPreferencesFile();
  return catalog.catalogContentRevision(
    ids.catalogSelectionRefsOf(
      normalizePluginSelections(preferences.globalPluginSelections),
    ),
  );
}

async function selectionUpdate(selectedItemIds: string[]): Promise<unknown> {
  const idempotencyKey = `collection-read-${(keyCount += 1)}`;
  return dispatcher.instruction(
    'core.catalog.selection.update',
    {
      scope: {},
      expectedRevision: await globalRevision(),
      selectedItemIds,
      _meta: { idempotencyKey },
    },
    { caller: caller(['core.catalog.write']), metadata: { idempotencyKey } },
  );
}

async function refusal(call: Promise<unknown>): Promise<unknown> {
  try {
    await call;
  } catch (error) {
    if (!(error instanceof CanopyOperationError)) throw error;
    const { kind, code, retry } = error.payload;
    return { kind, code, retry };
  }
  throw new Error('expected a refusal');
}

const UNAVAILABLE = {
  kind: 'unavailable',
  code: undefined,
  retry: { kind: 'same_request' },
};
// A keyed write retries under its key.
const UNAVAILABLE_WRITE = {
  ...UNAVAILABLE,
  retry: { kind: 'same_idempotency_key' },
};

function loadIndexChannel(): Promise<unknown> {
  const handler = handlers.get('collections:load-index');
  if (!handler) throw new Error('no collections:load-index handler');
  return Promise.resolve(handler({ sender: { id: 1 } }));
}

const ids = (entries: { entryId: string }[]): string[] =>
  entries.map((entry) => entry.entryId).sort();

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'collection-read-failure-'));
  process.env.CANOPY_DATA_DIR = join(root, 'data');
  process.env.CANOPY_SECURE_DATA_DIR = join(root, 'secure');
  mkdirSync(collectionsDir(), { recursive: true });
  // #10260's fault: config A reads, config B is a folder (an I/O error), and
  // the index is damaged, so the rebuild can't finish.
  seedConfig(ID_A, 'Alpha');
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
  const { createDesktopRuntime } =
    await import('../canopy-runtime/desktop-runtime');
  dispatcher = createDesktopRuntime({ shutdownTimeoutMs: 25 });
  const { registerCollectionHandlers } =
    await import('../collections/collection-handlers');
  registerCollectionHandlers();
});

afterAll(async () => {
  await dispatcher.shutdown();
  for (const [name, value] of Object.entries(inheritedDirs)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("Collection reads while the index can't be read (CAN-4170)", () => {
  it('fails a catalog snapshot that covers collections, typed and retryable', async () => {
    expect({
      unfiltered: await refusal(snapshot([])),
      collections: await refusal(snapshot(['collection'])),
      mixed: await refusal(snapshot(['skill', 'collection'])),
    }).toEqual({
      unfiltered: UNAVAILABLE,
      collections: UNAVAILABLE,
      mixed: UNAVAILABLE,
    });
  });

  it('keeps serving skills, plugins and MCP servers', async () => {
    const { entries } = await snapshot(['skill', 'plugin', 'mcp_server']);
    expect(ids(entries)).toEqual([PLUGIN_ID, SKILL_ID].sort());
  });

  it('fails a selection read that holds a collection, never listing it as unavailable', async () => {
    expect(await refusal(selectionGet())).toEqual(UNAVAILABLE);
  });

  it('fails a selection update that selects a collection, never as an unknown entry', async () => {
    expect(
      await refusal(selectionUpdate([collectionEntryId(ID_A), SKILL_ID])),
    ).toEqual(UNAVAILABLE_WRITE);
  });

  it('applies a selection update with no collection, and reads it back', async () => {
    await expect(selectionUpdate([SKILL_ID])).resolves.toMatchObject({
      selectedItemIds: [SKILL_ID],
    });
    await expect(selectionGet()).resolves.toMatchObject({
      selectedItemIds: [SKILL_ID],
      unavailableItemIds: [],
    });
  });

  it('fails the collections channel and the Remote Control collection list', async () => {
    const { listRemoteControlCollections } =
      await import('../services/plugin-catalog-service');
    await expect(loadIndexChannel()).rejects.toThrow();
    await expect(listRemoteControlCollections()).rejects.toThrow();
  });

  // The named residual (CAN-7473): the picker keeps its other sections and
  // lists no collections until it has a load error state.
  it('still lists skills and plugins in the Remote Control picker catalog', async () => {
    const { buildPluginCatalog } =
      await import('../services/plugin-catalog-service');
    const catalog = await buildPluginCatalog();
    expect({
      collections: catalog.collections,
      skills: catalog.skills.map((skill) => skill.skillName),
      plugins: catalog.plugins.map((plugin) => plugin.pluginName),
    }).toEqual({ collections: [], skills: ['deploy'], plugins: ['linter'] });
  });

  it('fails the inventory sync reader and marks the capability inventory partial', async () => {
    const { listPersonalRemoteControlCollections } =
      await import('../services/plugin-catalog-service');
    const { readCapabilityInventory } =
      await import('../canopy-tools/capability-inventory');
    await expect(listPersonalRemoteControlCollections()).rejects.toThrow();
    const inventory = await readCapabilityInventory('collection');
    expect({
      items: inventory.items,
      installedPartial: inventory.partialTiers?.includes('installed'),
      unavailable: inventory.unavailable,
    }).toEqual({ items: [], installedPartial: true, unavailable: true });
  });

  it('lists both collections everywhere once every config reads', async () => {
    rmSync(configPath(ID_B), { recursive: true });
    seedConfig(ID_B, 'Beta');
    const { buildPluginCatalog } =
      await import('../services/plugin-catalog-service');
    const channel = await loadIndexChannel();
    expect({
      snapshot: ids((await snapshot(['collection'])).entries),
      channel: Array.isArray(channel)
        ? channel.map((row: { id: string }) => row.id).sort()
        : channel,
      picker: (await buildPluginCatalog()).collections
        .map((row) => row.id)
        .sort(),
    }).toEqual({
      snapshot: [collectionEntryId(ID_A), collectionEntryId(ID_B)].sort(),
      channel: [ID_A, ID_B].sort(),
      picker: [ID_A, ID_B].sort(),
    });
    await expect(
      selectionUpdate([collectionEntryId(ID_A), SKILL_ID]),
    ).resolves.toMatchObject({
      selectedItemIds: [collectionEntryId(ID_A), SKILL_ID],
    });
  });
});
