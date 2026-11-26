import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { StorageWriteRefusedError } from '@canopy/core-runtime/storage';
import type * as AtomicFileModule from '../lib/atomic-file';
import type * as MapModule from '../lib/cowork-migration-map';

// CAN-4710: the three migration-marker rows. The cowork id-map leaks and never
// blocks; the adoption marker and the app-managed home markers are written
// durably and only by their admitted writers.

const mockDataDir = jest.fn<string, []>();
const mockWriteFailure = jest.fn<Error | undefined, [string]>();
const mockCalls: string[] = [];
const mockReport = jest.fn();
const mockWarn = jest.fn();

jest.mock('@canopy/execution-engine/canopy-paths', () => ({
  getCanopyDataDir: (): string => mockDataDir(),
}));
jest.mock('../lib/paths', () => ({
  getDataDir: (): string => mockDataDir(),
  getMigrationsFilePath: (): string => `${mockDataDir()}/migrations.json`,
  getCoworkMigrationMapFilePath: (): string =>
    `${mockDataDir()}/cowork-migration.json`,
  getStandaloneChatDir: (): string => `${mockDataDir()}/standalone-chat`,
  getAppManagedChatWorkspaceDir: (id: string): string =>
    `${mockDataDir()}/app-workspaces/${id}`,
  getAppAdvisorHomeDir: (): string =>
    `${mockDataDir()}/app-workspaces/app-advisor/home`,
  getPipelineEditorHomeDir: (): string =>
    `${mockDataDir()}/app-workspaces/pipeline-editor/home`,
  w5RecordReadPaths: {
    index: (): string => `${mockDataDir()}/workspaces/index.json`,
  },
  withCodeReviewStorageIdentity: <T>(run: () => Promise<T>): Promise<T> =>
    run(),
}));
jest.mock('../lib/code-review-storage-admission', () => ({
  ensureCodeReviewNamespaceQualification: (): Promise<void> =>
    Promise.resolve(),
  isCodeReviewWorkspaceTreePending: (): boolean => false,
}));
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessError: jest.fn(),
  logMainProcessWarn: (...args: unknown[]): void => {
    mockWarn(...args);
  },
}));
jest.mock('../lib/startup-step', () => ({
  reportStartupStepFailure: (...args: unknown[]): void => {
    mockReport(...args);
  },
}));
jest.mock('../lib/atomic-file', () => {
  const actual =
    jest.requireActual<typeof AtomicFileModule>('../lib/atomic-file');
  return {
    ...actual,
    writeFileAtomically: async (
      ...args: Parameters<typeof actual.writeFileAtomically>
    ): Promise<void> => {
      const failure = mockWriteFailure(basename(args[0]));
      if (failure) throw failure;
      return actual.writeFileAtomically(...args);
    },
    syncDirectory: async (folder: string): Promise<void> => {
      mockCalls.push(`sync ${basename(folder)}`);
      return actual.syncDirectory(folder);
    },
    createDirectoryDurably: async (
      folder: string,
      options: { readonly dataRoot: string },
    ): Promise<void> => {
      mockCalls.push(`durable ${basename(folder)}`);
      return actual.createDirectoryDurably(folder, options);
    },
  };
});

import { writeFileAtomically } from '../lib/atomic-file';
import {
  readCoworkMigrationMap,
  resolveCoworkWorkspaceId,
  writeCoworkMigrationMap,
} from '../lib/cowork-migration-map';
import { migrateStandaloneChatToCowork } from '../lib/cowork-migration';
import { migrateAppManagedChatWorkspaces } from '../lib/app-managed-workspaces';
import { hasMigrationRun } from '../lib/migrations';

let dataDir: string;
const mapPath = (): string => join(dataDir, 'cowork-migration.json');
const lastGoodPath = (): string =>
  join(dataDir, 'cowork-migration.last-good.json');
const read = (path: string): Promise<string> => readFile(path, 'utf8');
const mapText = (idMap: Record<string, string>): string =>
  `${JSON.stringify({ version: 1, idMap }, null, 2)}\n`;

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function damagedCopies(): Promise<string[]> {
  const names = (await readdir(dataDir))
    .filter((name) => /^cowork-migration\.damaged-.+\.json$/.test(name))
    .sort();
  return Promise.all(names.map((name) => read(join(dataDir, name))));
}

/** A fresh module instance: what the next launch sees. */
async function restart(): Promise<typeof MapModule> {
  let map: typeof MapModule | undefined;
  await jest.isolateModulesAsync(async (): Promise<void> => {
    map = await import('../lib/cowork-migration-map');
  });
  if (!map) throw new Error('map did not load');
  return map;
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'canopy-migration-markers-'));
  mockDataDir.mockReturnValue(dataDir);
  mockWriteFailure.mockReturnValue(undefined);
  mockCalls.length = 0;
  mockReport.mockClear();
  mockWarn.mockClear();
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const DAMAGED_SHAPES: readonly [string, string][] = [
  ['truncated JSON', '{"version": 1, "idMap": {"legacy-a": "ws'],
  ['a non-object document', '[1, 2]'],
  ['a missing version', '{"idMap": {"legacy-a": "ws-a"}}'],
  ['a non-integer version', '{"version": "1", "idMap": {}}'],
  ['an older version', '{"version": 0, "idMap": {}}'],
  ['a non-object idMap', '{"version": 1, "idMap": ["ws-a"]}'],
];

describe('cowork migration map', () => {
  it('serves a readable map and refreshes its last-good copy from it', async () => {
    await writeFile(mapPath(), mapText({ 'legacy-a': 'ws-a' }));

    const map = await restart();
    await expect(map.readCoworkMigrationMap()).resolves.toEqual({
      version: 1,
      idMap: { 'legacy-a': 'ws-a' },
    });
    await expect(read(lastGoodPath())).resolves.toBe(
      mapText({ 'legacy-a': 'ws-a' }),
    );
    await expect(damagedCopies()).resolves.toEqual([]);
  });

  it('drops non-string values as before and keeps the file as written', async () => {
    const text = '{"version": 1, "idMap": {"legacy-a": "ws-a", "legacy-b": 7}}';
    await writeFile(mapPath(), text);

    const map = await restart();
    await expect(map.readCoworkMigrationMap()).resolves.toEqual({
      version: 1,
      idMap: { 'legacy-a': 'ws-a' },
    });
    await expect(read(mapPath())).resolves.toBe(text);
  });

  it('reads a missing map with no last-good as empty and writes nothing', async () => {
    const map = await restart();
    await expect(map.readCoworkMigrationMap()).resolves.toEqual({
      version: 1,
      idMap: {},
    });
    await expect(readdir(dataDir)).resolves.toEqual([]);
  });

  it('restores a missing map from its last-good copy', async () => {
    await writeFile(lastGoodPath(), mapText({ 'legacy-a': 'ws-a' }));

    const map = await restart();
    await map.loadCoworkMigrationMapCache();
    expect(map.resolveCoworkWorkspaceId('legacy-a')).toBe('ws-a');
    await expect(read(mapPath())).resolves.toBe(
      mapText({ 'legacy-a': 'ws-a' }),
    );
  });

  it.each(DAMAGED_SHAPES)(
    'keeps %s aside and serves empty, leaving the map in place, with no last-good',
    async (_shape, text) => {
      await writeFile(mapPath(), text);

      const map = await restart();
      await expect(map.readCoworkMigrationMap()).resolves.toEqual({
        version: 1,
        idMap: {},
      });
      await expect(read(mapPath())).resolves.toBe(text);
      await expect(damagedCopies()).resolves.toEqual([text]);
      await expect(exists(lastGoodPath())).resolves.toBe(false);
      expect(mockReport).toHaveBeenCalledWith(
        'migration.cowork_map_recovery',
        expect.any(Error),
      );
    },
  );

  it.each(DAMAGED_SHAPES)(
    'keeps %s aside and installs the last-good copy over it',
    async (_shape, text) => {
      await writeFile(mapPath(), text);
      await writeFile(lastGoodPath(), mapText({ 'legacy-a': 'ws-a' }));

      const map = await restart();
      await expect(map.readCoworkMigrationMap()).resolves.toEqual({
        version: 1,
        idMap: { 'legacy-a': 'ws-a' },
      });
      await expect(read(mapPath())).resolves.toBe(
        mapText({ 'legacy-a': 'ws-a' }),
      );
      await expect(damagedCopies()).resolves.toEqual([text]);
    },
  );

  it('keeps one copy per distinct damaged content and at most five', async () => {
    const map = await restart();
    await writeFile(mapPath(), '{');
    await map.readCoworkMigrationMap();
    await map.readCoworkMigrationMap();
    await expect(damagedCopies()).resolves.toEqual(['{']);

    for (let index = 0; index < 6; index += 1) {
      await writeFile(mapPath(), `{${String(index)}`);
      await map.readCoworkMigrationMap();
    }
    const kept = await damagedCopies();
    expect(kept).toHaveLength(5);
    expect(kept).not.toContain('{');
    expect(kept).toContain('{5');
  });

  it('never restores over a newer map, and serves last-good in memory', async () => {
    const newer = '{"version": 2, "idMap": {"legacy-a": "ws-new"}}';
    await writeFile(mapPath(), newer);
    await writeFile(lastGoodPath(), mapText({ 'legacy-a': 'ws-a' }));

    const map = await restart();
    await map.loadCoworkMigrationMapCache();
    expect(map.resolveCoworkWorkspaceId('legacy-a')).toBe('ws-a');
    await expect(read(mapPath())).resolves.toBe(newer);
    await expect(damagedCopies()).resolves.toEqual([newer]);
  });

  it('serves a newer map as empty, as before, with no last-good', async () => {
    const newer = '{"version": 2, "idMap": {"legacy-a": "ws-new"}}';
    await writeFile(mapPath(), newer);

    const map = await restart();
    await map.loadCoworkMigrationMapCache();
    expect(map.resolveCoworkWorkspaceId('legacy-a')).toBe('legacy-a');
    await expect(read(mapPath())).resolves.toBe(newer);
  });

  it('rethrows an unreadable map with no last-good, and serves last-good when there is one', async () => {
    await mkdir(mapPath());

    const map = await restart();
    await expect(map.readCoworkMigrationMap()).rejects.toMatchObject({
      code: 'EISDIR',
    });

    await writeFile(lastGoodPath(), mapText({ 'legacy-a': 'ws-a' }));
    await expect(map.readCoworkMigrationMap()).resolves.toEqual({
      version: 1,
      idMap: { 'legacy-a': 'ws-a' },
    });
  });

  it('serves empty when the evidence copy fails, leaving the map in place', async () => {
    mockWriteFailure.mockImplementation((name) =>
      name.startsWith('cowork-migration.damaged-')
        ? new Error('disk full')
        : undefined,
    );
    await writeFile(mapPath(), '{');

    const map = await restart();
    await expect(map.readCoworkMigrationMap()).resolves.toEqual({
      version: 1,
      idMap: {},
    });
    await expect(read(mapPath())).resolves.toBe('{');
    expect(mockReport).toHaveBeenCalledWith(
      'migration.cowork_map_recovery',
      expect.any(Error),
    );
  });

  it('serves last-good when installing it fails', async () => {
    mockWriteFailure.mockImplementation((name) =>
      name === 'cowork-migration.json' ? new Error('disk full') : undefined,
    );
    await writeFile(mapPath(), '{');
    await writeFile(lastGoodPath(), mapText({ 'legacy-a': 'ws-a' }));

    const map = await restart();
    await expect(map.readCoworkMigrationMap()).resolves.toEqual({
      version: 1,
      idMap: { 'legacy-a': 'ws-a' },
    });
    await expect(read(mapPath())).resolves.toBe('{');
  });

  it('serves the map when refreshing last-good fails', async () => {
    mockWriteFailure.mockImplementation((name) =>
      name === 'cowork-migration.last-good.json'
        ? new Error('disk full')
        : undefined,
    );
    await writeFile(mapPath(), mapText({ 'legacy-a': 'ws-a' }));

    const map = await restart();
    await expect(map.readCoworkMigrationMap()).resolves.toEqual({
      version: 1,
      idMap: { 'legacy-a': 'ws-a' },
    });
  });

  it('writes last-good and then the map with the same content', async () => {
    await writeCoworkMigrationMap({ 'legacy-a': 'ws-a' });

    await expect(read(lastGoodPath())).resolves.toBe(
      mapText({ 'legacy-a': 'ws-a' }),
    );
    await expect(read(mapPath())).resolves.toBe(
      mapText({ 'legacy-a': 'ws-a' }),
    );
    expect(resolveCoworkWorkspaceId('legacy-a')).toBe('ws-a');
  });

  it('rejects only a failed map write, and a failed last-good write still writes the map', async () => {
    mockWriteFailure.mockImplementation((name) =>
      name === 'cowork-migration.last-good.json'
        ? new Error('disk full')
        : undefined,
    );
    await writeCoworkMigrationMap({ 'legacy-a': 'ws-a' });
    await expect(read(mapPath())).resolves.toBe(
      mapText({ 'legacy-a': 'ws-a' }),
    );

    mockWriteFailure.mockImplementation((name) =>
      name === 'cowork-migration.json' ? new Error('disk full') : undefined,
    );
    await expect(
      writeCoworkMigrationMap({ 'legacy-a': 'ws-b' }),
    ).rejects.toThrow('disk full');
    await expect(readCoworkMigrationMap()).resolves.toEqual({
      version: 1,
      idMap: { 'legacy-a': 'ws-a' },
    });
  });
});

describe('pending cowork migration over a damaged map', () => {
  it('keeps the evidence before the migration rewrites the map, and still completes', async () => {
    await writeFile(mapPath(), '{"version": 1, "idMap": {"legacy-a"');

    await migrateStandaloneChatToCowork();

    await expect(damagedCopies()).resolves.toEqual([
      '{"version": 1, "idMap": {"legacy-a"',
    ]);
    await expect(read(mapPath())).resolves.toBe(mapText({}));
    await expect(hasMigrationRun('cowork_workspaces')).resolves.toBe(true);
  });

  it('carries the last-good entries into the rewritten map', async () => {
    await writeFile(mapPath(), '{');
    await writeFile(lastGoodPath(), mapText({ 'legacy-a': 'ws-a' }));

    await migrateStandaloneChatToCowork();

    await expect(read(mapPath())).resolves.toBe(
      mapText({ 'legacy-a': 'ws-a' }),
    );
    expect(resolveCoworkWorkspaceId('legacy-a')).toBe('ws-a');
    await expect(hasMigrationRun('cowork_workspaces')).resolves.toBe(true);
  });

  it('still runs and completes when keeping the evidence fails', async () => {
    mockWriteFailure.mockImplementation((name) =>
      name.startsWith('cowork-migration.damaged-')
        ? new Error('disk full')
        : undefined,
    );
    await writeFile(mapPath(), '{');

    await migrateStandaloneChatToCowork();

    await expect(read(mapPath())).resolves.toBe(mapText({}));
    await expect(hasMigrationRun('cowork_workspaces')).resolves.toBe(true);
  });
});

describe('admitted writers', () => {
  const adoptionWriter = {
    namespace: 'data_dir_adoption_marker',
    writer: 'electron_main',
    module: 'main/ipc/preferences',
  } as const;

  it('admits the adoption marker write from its handler only', async () => {
    const target = join(dataDir, 'data-dir-adopted.json');
    await expect(
      writeFileAtomically(target, '{}', {
        durable: true,
        admittedWriter: adoptionWriter,
      }),
    ).resolves.toBeUndefined();
    await expect(writeFileAtomically(target, '{}')).rejects.toBeInstanceOf(
      StorageWriteRefusedError,
    );
    await expect(
      writeFileAtomically(target, '{}', {
        admittedWriter: { ...adoptionWriter, module: 'main/lib/migrations' },
      }),
    ).rejects.toBeInstanceOf(StorageWriteRefusedError);
  });

  it.each([
    'cowork-migration.json',
    'cowork-migration.last-good.json',
    'cowork-migration.damaged-2026-11-25T00-00-00-000Z-abcd1234.json',
  ])('refuses a write to %s by any other writer', async (name) => {
    await expect(
      writeFileAtomically(join(dataDir, name), '{}'),
    ).rejects.toBeInstanceOf(StorageWriteRefusedError);
    await expect(
      writeFileAtomically(join(dataDir, name), '{}', {
        admittedWriter: adoptionWriter,
      }),
    ).rejects.toBeInstanceOf(StorageWriteRefusedError);
  });
});

describe('app-managed home migration markers', () => {
  const advisorRoot = (): string =>
    join(dataDir, 'app-workspaces', 'app-advisor');
  const advisorMarker = (): string =>
    join(dataDir, '.app-advisor-home-migration-state');

  it('flushes the staging rename before creating the marker durably, then removes it', async () => {
    await mkdir(join(advisorRoot(), 'home'), { recursive: true });
    await writeFile(join(advisorRoot(), 'home', 'legacy.txt'), 'legacy');

    await migrateAppManagedChatWorkspaces();

    const staging = mockCalls.filter(
      (call) =>
        call === 'sync app-advisor' ||
        call === 'durable .app-advisor-home-migration-state',
    );
    expect(staging).toEqual([
      'sync app-advisor',
      'durable .app-advisor-home-migration-state',
    ]);
    await expect(
      read(join(advisorRoot(), 'home', 'home', 'legacy.txt')),
    ).resolves.toBe('legacy');
    await expect(exists(advisorMarker())).resolves.toBe(false);
    await expect(hasMigrationRun('app_advisor_home')).resolves.toBe(true);
  });

  it('resumes from the marker without staging again when the ledger lacks the mark', async () => {
    await mkdir(join(advisorRoot(), '.app-advisor-staged-home'), {
      recursive: true,
    });
    await writeFile(
      join(advisorRoot(), '.app-advisor-staged-home', 'legacy.txt'),
      'legacy',
    );
    await mkdir(join(advisorRoot(), 'home'), { recursive: true });
    await writeFile(join(advisorRoot(), 'home', 'new.txt'), 'new');
    await mkdir(advisorMarker());

    await migrateAppManagedChatWorkspaces();

    expect(mockCalls).not.toContain(
      'durable .app-advisor-home-migration-state',
    );
    await expect(
      read(join(advisorRoot(), 'home', 'home', 'legacy.txt')),
    ).resolves.toBe('legacy');
    await expect(read(join(advisorRoot(), 'home', 'new.txt'))).resolves.toBe(
      'new',
    );
    await expect(exists(advisorMarker())).resolves.toBe(false);
  });
});
