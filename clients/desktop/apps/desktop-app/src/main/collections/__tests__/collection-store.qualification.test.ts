// CAN-4488 golden: the collection config, index and legacy bundle stores
// qualified under their current owner, Electron main. It drives the real
// store on a data root the suite owns; only the resource-context policy,
// install receipts, subscriptions and the inventory signal are replaced, so
// each case can seed, fault or flip them. Every case starts a fresh module, as
// a restart does.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CollectionConfig,
  CollectionIndexEntry,
  CollectionIndexFile,
} from '@canopy/desktop-shared/types/collections';
import type * as AtomicFile from '../../lib/atomic-file';
import { getDataDir } from '../../lib/paths';
import type * as StoreModule from '../collection-store';

const mockContext = { enabled: false, state: 'context-1' };
jest.mock('../../lib/resource-context', () => ({
  resourceContextEnabled: (): boolean => mockContext.enabled,
  resourceContextSnapshot: (): Promise<string> =>
    Promise.resolve(mockContext.state),
  assertResourceContextSnapshot: (snapshot: string): Promise<void> =>
    snapshot === mockContext.state
      ? Promise.resolve()
      : Promise.reject(new Error('context-mismatch')),
}));

const mockAuthorization = { localManagement: true };
jest.mock('../../lib/resource-install-context', () => ({
  assertInstalledResourceContext: (): Promise<void> => Promise.resolve(),
  assertLocalCollectionManagementContext: (): Promise<void> =>
    mockAuthorization.localManagement
      ? Promise.resolve()
      : Promise.reject(new Error('resource-context-denied')),
  recordResourceInstall: (): Promise<void> => Promise.resolve(),
  classifyInstalledResourceOrigin: (): Promise<string> =>
    Promise.resolve('local'),
}));
jest.mock('../../canopy-cloud/shared-item-subscriptions', () => ({
  recordSharedItemInstall: jest.fn(),
  recordSharedItemUninstall: jest.fn(),
}));
jest.mock('../canopy-server-client', () => ({
  getSharedCollection: jest.fn(),
}));

const mockSignals: string[] = [];
jest.mock('../../services/desktop-inventory-sync-signals', () => ({
  notifyDesktopInventoryChanged: (kinds: string[]): void => {
    mockSignals.push(...kinds);
  },
}));

const mockFaults: {
  failWrite?: (path: string) => boolean;
  failAfterWrite?: (path: string) => boolean;
  hold?: (path: string) => Promise<void> | undefined;
} = {};
jest.mock('../../lib/atomic-file', () => {
  const actual: typeof AtomicFile = jest.requireActual('../../lib/atomic-file');
  return {
    ...actual,
    writeFileAtomically: (
      ...args: Parameters<typeof actual.writeFileAtomically>
    ): ReturnType<typeof actual.writeFileAtomically> => {
      if (mockFaults.failWrite?.(String(args[0])))
        return Promise.reject(new Error('injected write failure'));
      const held = mockFaults.hold?.(String(args[0]));
      if (held) return held.then(() => actual.writeFileAtomically(...args));
      // As a folder flush failing after the rename: the file is installed.
      if (mockFaults.failAfterWrite?.(String(args[0])))
        return actual
          .writeFileAtomically(...args)
          .then(() => Promise.reject(new Error('injected flush failure')));
      return actual.writeFileAtomically(...args);
    },
  };
});

type Store = typeof StoreModule;

const ID_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const ID_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const STAMP = '2026-11-01T00:00:00.000Z';

const collectionsDir = (): string => join(getDataDir(), 'collections');
const bundlesDir = (): string => join(getDataDir(), 'bundles');
const indexPath = (): string => join(collectionsDir(), 'index.json');
const configPath = (id: string): string =>
  join(collectionsDir(), `collection-${id}.json`);

function collection(
  id: string,
  name: string,
  revision = `rev-${name}`,
): CollectionConfig {
  return {
    id,
    name,
    description: '',
    skills: [],
    plugins: [],
    mcpServers: [],
    createdAt: STAMP,
    updatedAt: STAMP,
    revision,
  };
}

function seedConfig(id: string, name: string, revision?: string): void {
  mkdirSync(collectionsDir(), { recursive: true });
  writeFileSync(
    configPath(id),
    JSON.stringify({
      version: 2,
      collection: collection(id, name, revision),
    }),
  );
}

function seedIndex(value: unknown): void {
  mkdirSync(collectionsDir(), { recursive: true });
  writeFileSync(
    indexPath(),
    typeof value === 'string' ? value : JSON.stringify(value),
  );
}

function indexRow(
  id: string,
  name: string,
  revision = `rev-${name}`,
): CollectionIndexEntry {
  return {
    id,
    name,
    description: '',
    updatedAt: STAMP,
    revision,
    skillCount: 0,
    pluginCount: 0,
    mcpServerCount: 0,
    hasExistingShare: false,
  };
}

function completeIndex(rows: CollectionIndexEntry[]): CollectionIndexFile {
  return {
    version: 2,
    entrySchema: 2,
    memberCountsSchema: 1,
    authorLinkSchema: 1,
    collections: rows,
  };
}

function storedIndexRows(): unknown[] {
  const parsed: unknown = JSON.parse(readFileSync(indexPath(), 'utf8'));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('collections' in parsed) ||
    !Array.isArray(parsed.collections)
  )
    throw new Error('The index has no rows');
  return parsed.collections;
}

function setAside(prefix: string): string[] {
  return readdirSync(collectionsDir()).filter((name) =>
    name.startsWith(`index.json.${prefix}-`),
  );
}

async function loadStore(): Promise<Store> {
  jest.resetModules();
  return import('../collection-store');
}

async function names(store: Store): Promise<string[]> {
  return (await store.readCollectionIndex()).collections.map(
    (entry) => entry.name,
  );
}

// Own the data roots: never seed or delete files in an inherited directory.
const inheritedDirs = {
  CANOPY_DATA_DIR: process.env.CANOPY_DATA_DIR,
  CANOPY_SECURE_DATA_DIR: process.env.CANOPY_SECURE_DATA_DIR,
};
let ownedRoot = '';
beforeAll(() => {
  ownedRoot = mkdtempSync(join(tmpdir(), 'can-4488-'));
  process.env.CANOPY_DATA_DIR = join(ownedRoot, 'data');
  process.env.CANOPY_SECURE_DATA_DIR = join(ownedRoot, 'secure');
});
afterAll(() => {
  for (const [name, value] of Object.entries(inheritedDirs)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(ownedRoot, { recursive: true, force: true });
});

function once(match: (path: string) => boolean): (path: string) => boolean {
  let fired = false;
  return (path) => !fired && match(path) && (fired = true);
}

beforeEach(() => {
  expect(collectionsDir().startsWith(join(ownedRoot, 'data'))).toBe(true);
  rmSync(collectionsDir(), { recursive: true, force: true });
  rmSync(bundlesDir(), { recursive: true, force: true });
  mockContext.enabled = false;
  mockContext.state = 'context-1';
  mockAuthorization.localManagement = true;
  mockFaults.failWrite = undefined;
  mockFaults.failAfterWrite = undefined;
  mockFaults.hold = undefined;
  mockSignals.length = 0;
});

describe('collections_index recovery', () => {
  test('a newer index is set aside and rebuilt from the configs, never written over empty', async () => {
    seedConfig(ID_A, 'Alpha');
    const newer = JSON.stringify({
      version: 3,
      collections: [indexRow(ID_A, 'Alpha')],
    });
    seedIndex(newer);
    const store = await loadStore();

    expect(await names(store)).toEqual(['Alpha']);
    const [copy] = setAside('newer');
    expect(copy).toBeDefined();
    expect(readFileSync(join(collectionsDir(), copy ?? ''), 'utf8')).toBe(
      newer,
    );
  });

  test('an index with the wrong envelope is set aside as damaged and rebuilt', async () => {
    seedConfig(ID_A, 'Alpha');
    seedIndex({ version: 2, collections: {} });
    const store = await loadStore();

    expect(await names(store)).toEqual(['Alpha']);
    expect(setAside('damaged')).toHaveLength(1);
  });

  test('an unparseable index is set aside and rebuilt instead of failing every read', async () => {
    seedConfig(ID_A, 'Alpha');
    seedConfig(ID_B, 'Beta');
    seedIndex('{');
    const store = await loadStore();

    expect((await names(store)).sort()).toEqual(['Alpha', 'Beta']);
    const [copy] = setAside('damaged');
    expect(readFileSync(join(collectionsDir(), copy ?? ''), 'utf8')).toBe('{');
    await expect(
      store.saveCollectionConfig({ name: 'Gamma' }),
    ).resolves.toMatchObject({ name: 'Gamma' });
  });

  test('a rebuild skips temporary and set-aside files and keeps an unreadable config on disk', async () => {
    seedConfig(ID_A, 'Alpha');
    writeFileSync(
      join(collectionsDir(), `.collection-${ID_B}.json.1.x.tmp`),
      '{',
    );
    writeFileSync(configPath(ID_B), '{ not json');
    seedIndex('{');
    const store = await loadStore();

    expect(await names(store)).toEqual(['Alpha']);
    expect(readFileSync(configPath(ID_B), 'utf8')).toBe('{ not json');
  });

  test('an index that cannot be read fails closed and a delete leaves the config in place', async () => {
    seedConfig(ID_A, 'Alpha');
    mkdirSync(indexPath(), { recursive: true });
    const store = await loadStore();

    await expect(store.readCollectionIndex()).rejects.toThrow();
    await expect(store.deleteCollectionConfig(ID_A)).rejects.toThrow();
    expect(existsSync(configPath(ID_A))).toBe(true);
  });
});

describe('restart after an interrupted config/index mutation', () => {
  test('a config published without its index row is listed after restart', async () => {
    seedConfig(ID_A, 'Alpha');
    seedConfig(ID_B, 'Beta');
    seedIndex(completeIndex([indexRow(ID_A, 'Alpha')]));
    const store = await loadStore();

    expect(await names(store)).toEqual(['Alpha', 'Beta']);
    expect(storedIndexRows()).toHaveLength(2);
  });

  test('a reconcile whose write fails is retried on the next read', async () => {
    seedConfig(ID_A, 'Alpha');
    seedConfig(ID_B, 'Beta');
    seedIndex(completeIndex([indexRow(ID_A, 'Alpha')]));
    mockFaults.failWrite = once((path) => path === indexPath());
    const store = await loadStore();

    expect(await names(store)).toEqual(['Alpha', 'Beta']);
    expect(storedIndexRows()).toHaveLength(1);
    expect(await names(store)).toEqual(['Alpha', 'Beta']);
    expect(storedIndexRows()).toHaveLength(2);
  });

  test('a config whose stored id is not its file name is never listed', async () => {
    seedConfig(ID_A, 'Alpha');
    writeFileSync(
      configPath(ID_B),
      JSON.stringify({
        version: 2,
        collection: collection(ID_A, 'Impostor', 'rev-impostor'),
      }),
    );
    seedIndex(completeIndex([indexRow(ID_A, 'Alpha')]));
    const store = await loadStore();

    expect(await names(store)).toEqual(['Alpha']);
    expect(storedIndexRows()).toHaveLength(1);
  });

  test('a recovered config missing its name or description is never listed', async () => {
    const ID_C = 'cccccccc-0000-4000-8000-000000000003';
    seedConfig(ID_A, 'Alpha');
    const nameless: Record<string, unknown> = { ...collection(ID_B, 'Beta') };
    delete nameless.name;
    writeFileSync(
      configPath(ID_B),
      JSON.stringify({ version: 2, collection: nameless }),
    );
    const undescribed: Record<string, unknown> = {
      ...collection(ID_C, 'Gamma', 'rev-new'),
    };
    delete undescribed.description;
    writeFileSync(
      configPath(ID_C),
      JSON.stringify({ version: 2, collection: undescribed }),
    );
    const rows = [indexRow(ID_A, 'Alpha'), indexRow(ID_C, 'Gamma', 'rev-old')];
    seedIndex(completeIndex(rows));
    const store = await loadStore();

    expect(await names(store)).toEqual(['Alpha', 'Gamma']);
    expect(storedIndexRows()).toEqual(rows);
  });

  test('a recovered config with a non-string revision is never listed', async () => {
    seedConfig(ID_A, 'Alpha');
    writeFileSync(
      configPath(ID_B),
      JSON.stringify({
        version: 2,
        collection: { ...collection(ID_B, 'Beta'), revision: 7 },
      }),
    );
    const rows = [indexRow(ID_A, 'Alpha')];
    seedIndex(completeIndex(rows));
    const store = await loadStore();

    expect(await names(store)).toEqual(['Alpha']);
    expect(storedIndexRows()).toEqual(rows);
  });

  test('a recovered config whose revision the web rejects is never listed', async () => {
    const ID_C = 'cccccccc-0000-4000-8000-000000000003';
    seedConfig(ID_A, 'Alpha');
    seedConfig(ID_B, 'Beta', '   ');
    seedConfig(ID_C, 'Gamma', 'r'.repeat(257));
    // Falsy revisions the row would silently drop.
    [0, false, ''].forEach((revision, n) => {
      const id = `dddddddd-0000-4000-8000-00000000000${n}`;
      writeFileSync(
        configPath(id),
        JSON.stringify({
          version: 2,
          collection: { ...collection(id, `Falsy ${n}`), revision },
        }),
      );
    });
    const rows = [indexRow(ID_A, 'Alpha')];
    seedIndex(completeIndex(rows));
    const store = await loadStore();

    expect(await names(store)).toEqual(['Alpha']);
    expect(storedIndexRows()).toEqual(rows);
  });

  test('a config read that fails with an I/O error is retried on the next read', async () => {
    seedConfig(ID_A, 'Alpha');
    // A folder where the config goes fails the read with EISDIR, not bad content.
    mkdirSync(configPath(ID_B));
    seedIndex(completeIndex([indexRow(ID_A, 'Alpha')]));
    const store = await loadStore();
    expect(await names(store)).toEqual(['Alpha']);

    rmSync(configPath(ID_B), { recursive: true });
    seedConfig(ID_B, 'Beta');
    expect(await names(store)).toEqual(['Alpha', 'Beta']);
  });

  test('a rebuild that cannot read a config fails list reads until it finishes', async () => {
    seedConfig(ID_A, 'Alpha');
    mkdirSync(configPath(ID_B));
    seedIndex('{ not json');
    const store = await loadStore();

    await expect(store.readCollectionIndex()).rejects.toThrow();
    expect(setAside('damaged')).toHaveLength(1);
    // While the fault lasts, the partial replacement is never listed.
    await expect(store.readCollectionIndex()).rejects.toThrow();
    await expect(store.readPersonalCollectionIndex()).rejects.toThrow();

    rmSync(configPath(ID_B), { recursive: true });
    seedConfig(ID_B, 'Beta');
    expect(await names(store)).toEqual(['Alpha', 'Beta']);
    expect(setAside('damaged')).toHaveLength(1);
  });

  test('a config without member lists keeps the others listed', async () => {
    seedConfig(ID_A, 'Alpha');
    writeFileSync(
      configPath(ID_B),
      JSON.stringify({ version: 2, collection: { id: ID_B, name: 'Bare' } }),
    );
    seedIndex(completeIndex([indexRow(ID_A, 'Alpha')]));
    const store = await loadStore();

    expect(await names(store)).toEqual(['Alpha']);
  });

  test('a row left stale by an interrupted edit is projected again from its config', async () => {
    seedConfig(ID_A, 'Alpha renamed', 'rev-2');
    seedIndex(completeIndex([indexRow(ID_A, 'Alpha', 'rev-1')]));
    const store = await loadStore();

    expect(await names(store)).toEqual(['Alpha renamed']);
  });

  test('a row whose config an interrupted delete removed is dropped', async () => {
    seedConfig(ID_B, 'Beta');
    seedIndex(completeIndex([indexRow(ID_A, 'Alpha'), indexRow(ID_B, 'Beta')]));
    const store = await loadStore();

    expect(await names(store)).toEqual(['Beta']);
  });

  test('an unreadable config keeps its row and is never written over', async () => {
    mkdirSync(collectionsDir(), { recursive: true });
    const newer = JSON.stringify({ version: 3, collection: { id: ID_A } });
    writeFileSync(configPath(ID_A), newer);
    seedIndex(completeIndex([indexRow(ID_A, 'Alpha')]));
    const store = await loadStore();

    expect(await names(store)).toEqual(['Alpha']);
    await expect(
      store.saveCollectionConfig({ id: ID_A, name: 'Overwrite' }),
    ).rejects.toThrow();
    expect(readFileSync(configPath(ID_A), 'utf8')).toBe(newer);
  });
});

describe('bundles_legacy conversion', () => {
  function seedBundle(id: string, bundle: Record<string, unknown>): void {
    mkdirSync(bundlesDir(), { recursive: true });
    writeFileSync(
      join(bundlesDir(), `bundle-${id}.json`),
      JSON.stringify({ version: 1, bundle: { id, ...bundle } }),
    );
  }
  function seedBundleIndex(ids: string[]): void {
    mkdirSync(bundlesDir(), { recursive: true });
    writeFileSync(
      join(bundlesDir(), 'index.json'),
      JSON.stringify({ version: 1, bundles: ids.map((id) => ({ id })) }),
    );
  }

  test('converts bundles once and keeps the legacy files', async () => {
    seedBundle(ID_A, {
      name: 'Legacy',
      description: '',
      skills: [],
      plugins: [],
      createdAt: STAMP,
      updatedAt: STAMP,
    });
    seedBundleIndex([ID_A]);
    const store = await loadStore();

    expect(await names(store)).toEqual(['Legacy']);
    expect(existsSync(configPath(ID_A))).toBe(true);
    expect(existsSync(join(bundlesDir(), `bundle-${ID_A}.json`))).toBe(true);
  });

  test('a bundle without member lists converts instead of failing every read', async () => {
    seedBundle(ID_A, { name: 'Bare', createdAt: STAMP, updatedAt: STAMP });
    seedBundleIndex([ID_A]);
    const store = await loadStore();

    expect(await names(store)).toEqual(['Bare']);
    expect(
      (await store.readCollectionIndex()).collections[0]?.description,
    ).toBe('');
  });

  test('a bundle without a name is skipped and kept on disk', async () => {
    seedBundle(ID_A, { createdAt: STAMP, updatedAt: STAMP });
    seedBundleIndex([ID_A]);
    const store = await loadStore();

    expect(await names(store)).toEqual([]);
    expect(existsSync(configPath(ID_A))).toBe(false);
    expect(existsSync(join(bundlesDir(), `bundle-${ID_A}.json`))).toBe(true);
  });

  test('a bundle read that fails with an I/O error is converted on the next read', async () => {
    seedBundleIndex([ID_A]);
    // A folder where the bundle goes fails the read with EISDIR, not bad content.
    mkdirSync(join(bundlesDir(), `bundle-${ID_A}.json`));
    const store = await loadStore();

    await expect(store.readCollectionIndex()).rejects.toThrow();
    expect(existsSync(indexPath())).toBe(false);

    rmSync(join(bundlesDir(), `bundle-${ID_A}.json`), { recursive: true });
    seedBundle(ID_A, {
      name: 'Legacy',
      description: '',
      createdAt: STAMP,
      updatedAt: STAMP,
    });
    expect(await names(store)).toEqual(['Legacy']);
  });

  test('a bundle whose id differs from its index entry is skipped', async () => {
    mkdirSync(bundlesDir(), { recursive: true });
    writeFileSync(
      join(bundlesDir(), `bundle-${ID_A}.json`),
      JSON.stringify({
        version: 1,
        // Every row field is valid, so only the id guard can reject it.
        bundle: {
          id: '../escape',
          name: 'Escape',
          description: '',
          skills: [],
          plugins: [],
          createdAt: STAMP,
          updatedAt: STAMP,
        },
      }),
    );
    seedBundleIndex([ID_A]);
    const store = await loadStore();

    expect(await names(store)).toEqual([]);
    expect(readdirSync(collectionsDir()).sort()).toEqual(['index.json']);
  });

  test('a conversion interrupted after its configs reruns to the same result', async () => {
    seedBundle(ID_A, {
      name: 'Legacy',
      skills: [],
      plugins: [],
      createdAt: STAMP,
      updatedAt: STAMP,
    });
    seedBundleIndex([ID_A]);
    const first = await loadStore();
    await first.readCollectionIndex();
    const converted = readFileSync(configPath(ID_A), 'utf8');
    rmSync(indexPath());

    const restarted = await loadStore();
    expect(await names(restarted)).toEqual(['Legacy']);
    expect(readFileSync(configPath(ID_A), 'utf8')).toBe(converted);
  });

  test('a deleted converted collection is not read back from its bundle', async () => {
    seedBundle(ID_A, {
      name: 'Legacy',
      skills: [],
      plugins: [],
      mcpServers: [{ serverId: 'abc', configId: 'def' }],
      createdAt: STAMP,
      updatedAt: STAMP,
    });
    seedBundleIndex([ID_A]);
    const store = await loadStore();
    await store.readCollectionIndex();
    await store.deleteCollectionConfig(ID_A);

    const { listDetectedMcpServersForSelections } =
      await import('../../plugins/mcp-inventory');
    const result = await listDetectedMcpServersForSelections({
      collectionIds: [ID_A],
      pluginRefs: [],
      skillRefs: [],
    });
    expect(result.warnings).toContain(
      `Collection "${ID_A}" could not be loaded.`,
    );
  });
});

describe('mutation admission, rollback and invalidation', () => {
  test('concurrent saves serialize and both reach the index', async () => {
    const store = await loadStore();
    await Promise.all([
      store.saveCollectionConfig({ name: 'One' }),
      store.saveCollectionConfig({ name: 'Two' }),
    ]);

    expect((await names(store)).sort()).toEqual(['One', 'Two']);
  });

  test('a failed index publication restores the config and the index', async () => {
    const store = await loadStore();
    const saved = await store.saveCollectionConfig({ name: 'Alpha' });
    const config = readFileSync(configPath(saved.id), 'utf8');
    const index = readFileSync(indexPath(), 'utf8');
    mockFaults.failAfterWrite = once((path) => path === indexPath());
    mockSignals.length = 0;

    await expect(
      store.saveCollectionConfig({
        id: saved.id,
        revision: saved.revision,
        name: 'Edited',
      }),
    ).rejects.toThrow('injected flush failure');
    expect(readFileSync(configPath(saved.id), 'utf8')).toBe(config);
    expect(JSON.parse(readFileSync(indexPath(), 'utf8'))).toEqual(
      JSON.parse(index),
    );
    expect(mockSignals.at(-1)).toBe('collections');
  });

  test('a context change during a mutation sets no damaged index aside', async () => {
    seedConfig(ID_A, 'Alpha');
    seedIndex('{');
    mockContext.enabled = true;
    const store = await loadStore();
    await expect(
      store.saveCollectionConfig({ name: 'Beta' }, () => {
        mockContext.state = 'context-2';
      }),
    ).rejects.toThrow('context-mismatch');
    expect(setAside('damaged')).toEqual([]);
    expect(readFileSync(indexPath(), 'utf8')).toBe('{');
  });

  test('a context change during a mutation refuses it before any write', async () => {
    mockContext.enabled = true;
    const store = await loadStore();
    await expect(
      store.saveCollectionConfig({ name: 'Alpha' }, () => {
        mockContext.state = 'context-2';
      }),
    ).rejects.toThrow('context-mismatch');
    expect(existsSync(indexPath())).toBe(false);
    expect(mockSignals).toEqual([]);
  });

  test('a denied local management context refuses the delete and keeps the files', async () => {
    seedConfig(ID_A, 'Alpha');
    seedIndex(completeIndex([indexRow(ID_A, 'Alpha')]));
    mockContext.enabled = true;
    mockAuthorization.localManagement = false;
    const store = await loadStore();

    await expect(store.deleteCollectionConfig(ID_A)).rejects.toThrow(
      'resource-context-denied',
    );
    expect(existsSync(configPath(ID_A))).toBe(true);
    expect(storedIndexRows()).toHaveLength(1);
  });

  test('the inventory signal fires after a committed write and never for a refused one', async () => {
    const store = await loadStore();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = (): void => undefined;
    const atIndexWrite = new Promise<void>((resolve) => {
      reached = resolve;
    });
    mockFaults.hold = (path): Promise<void> | undefined => {
      if (path !== indexPath()) return undefined;
      reached();
      return gate;
    };
    const saving = store.saveCollectionConfig({ name: 'Alpha' });
    // A save that fails before its index write rejects here with its own error.
    await Promise.race([atIndexWrite, saving]);
    expect(mockSignals).toEqual([]);
    release();
    await saving;
    expect(mockSignals).toEqual(['collections']);

    mockSignals.length = 0;
    await expect(store.saveCollectionConfig({ name: '   ' })).rejects.toThrow(
      'Collection name is required',
    );
    expect(mockSignals).toEqual([]);
  });

  test('clearing a deleted share skips an unreadable config and clears the others', async () => {
    const store = await loadStore();
    const saved = await store.saveCollectionConfig({ name: 'Linked' });
    await store.writeCollectionRemoteMetadata(saved.id, {
      remoteId: 'remote-1',
      contentHash: 'hash-1',
      shareScope: 'private',
      sharedAt: STAMP,
    });
    writeFileSync(configPath(ID_B), '{ damaged');
    const rows = storedIndexRows();
    seedIndex({
      ...completeIndex([]),
      collections: [indexRow(ID_B, 'Other'), ...rows],
    });

    await expect(
      store.clearCollectionRemoteMetadataByRemoteId('remote-1'),
    ).resolves.toBe(1);
    const cleared = await store.readLocalCollectionSnapshot(saved.id);
    expect(cleared?.collection.remote).toBeUndefined();
  });
});
