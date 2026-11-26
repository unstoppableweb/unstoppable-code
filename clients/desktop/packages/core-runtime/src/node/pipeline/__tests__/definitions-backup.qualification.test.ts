import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';

import {
  validateNamespaceBackupRecord,
  type NamespaceBackupRecord,
} from '../../../storage/backup-record';
import { fileSetDigest, fileSetManifest } from '../../file-set-backup';
import {
  createPipelineDefinitionReplayStore,
  pipelineDefinitionReplaysPath,
} from '../replay-store';
import { createPipelineAssetStore } from '../store/assets';
import { createDaemonPipelineAssetEnvironment } from '../store/daemon-assets';
import { createDaemonPipelineDefinitionStoreEnvironment } from '../store/daemon-environment';
import {
  PIPELINE_DEFINITIONS_BACKUP_MEMBERS,
  backupPipelineDefinitions,
  restorePipelineDefinitionsBackup,
  type PipelineDefinitionsBackupOptions,
  type PipelineDefinitionsNewerLoss,
  type PipelineDefinitionsRestoreOptions,
} from '../store/definitions-backup';
import { createPipelineDefinitionStore } from '../store/definitions-store';
import {
  FAMILY,
  FLIP_READY,
  recordingLock,
  strictFlush,
  type RecordingLock,
} from './definitions-backup-fixtures';
import { Crash, crashFs } from './definitions-backup-crash-fs';

/** Filesystem errors a case injects, each thrown once by the named call. */
const mockFaults: {
  readonly op: string;
  readonly path: string;
  readonly code: string;
  readonly when?: () => boolean;
}[] = [];

function mockFault(op: string, path: unknown): Error | undefined {
  const index = mockFaults.findIndex(
    (fault) =>
      fault.op === op &&
      fault.path === String(path) &&
      (fault.when?.() ?? true),
  );
  const [fault] = index < 0 ? [] : mockFaults.splice(index, 1);
  return fault === undefined
    ? undefined
    : Object.assign(new Error(`${fault.code}: ${op} '${fault.path}'`), {
        code: fault.code,
      });
}

jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof fsp>('node:fs/promises');
  const faulty =
    <A extends unknown[], R>(op: string, call: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> => {
      const fault = mockFault(op, args[0]);
      return fault === undefined ? call(...args) : Promise.reject(fault);
    };
  return {
    ...actual,
    rename: jest.fn(actual.rename),
    copyFile: jest.fn(actual.copyFile),
    mkdir: jest.fn(actual.mkdir),
    open: jest.fn(actual.open),
    lstat: jest.fn(faulty('lstat', actual.lstat)),
    readdir: jest.fn(faulty('readdir', actual.readdir)),
    readFile: jest.fn(faulty('readFile', actual.readFile)),
  };
});

const actual = jest.requireActual<typeof fsp>('node:fs/promises');
const rename = jest.mocked(fsp.rename);
const copyFile = jest.mocked(fsp.copyFile);
const mkdir = jest.mocked(fsp.mkdir);
const open = jest.mocked(fsp.open);

const outside = (): boolean => true;
/** Every crash point of one scenario, with headroom over a measured run. */
const CRASH_POINTS_TIMEOUT_MS = 82_000;
let root: string;
let quiesced: number;
let now: number;
let lock: RecordingLock;

type FamilyOptions = PipelineDefinitionsBackupOptions &
  PipelineDefinitionsRestoreOptions;

function options(overrides: Partial<FamilyOptions> = {}): FamilyOptions {
  return {
    dataRoot: root,
    backupPath: 'backups/pipeline-definitions-1',
    isOutsideCheckouts: outside,
    syncDirectory: strictFlush,
    flushRequiresWriteHandle: false,
    quiesce: async (operation) => {
      quiesced += 1;
      return operation();
    },
    lock,
    ownership: FLIP_READY,
    clock: () => now,
    ...overrides,
  };
}

function write(relative: string, text: string, at = root): void {
  const path = join(at, relative);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

const RECEIPT = 'a'.repeat(64);

function seed(): void {
  write(
    'pipelines/index.json',
    JSON.stringify({
      version: 1,
      pipelines: [
        {
          id: 'alpha',
          name: 'Alpha',
          filename: 'alpha.yaml',
          description: '',
          icon: '',
          createdAt: '2026-11-20T10:00:00.000Z',
          updatedAt: '2026-11-21T10:00:00.000Z',
          revision: 3,
        },
        {
          id: 'zeta',
          name: 'Zeta',
          filename: 'zeta.yaml',
          description: '',
          icon: '',
          createdAt: '2026-11-20T10:00:00.000Z',
          updatedAt: '2026-11-20T10:00:00.000Z',
          revision: 1,
        },
      ],
    }),
  );
  write('pipelines/alpha.yaml', 'name: Alpha\non: dispatch\njobs: {}\n');
  write('pipelines/zeta.yaml', 'name: Zeta\non: dispatch\njobs: {}\n');
  write('pipelines/.project-share-links.json', '{"p":"link-1"}');
  write(
    'pipeline-definition-replays.json',
    JSON.stringify({
      version: 1,
      entries: [],
      expired: [{ operation: 'core.pipeline.definition.upsert', key: RECEIPT }],
    }),
  );
  write(
    'pipeline-data/alpha/assets.json',
    JSON.stringify({
      version: 1,
      assets: { tool: { installMode: 'seed', files: { 'tool.sh': RECEIPT } } },
    }),
  );
  write('pipeline-data/alpha/assets/tool/tool.sh', 'echo tool\n');
  mkdirSync(join(root, 'pipeline-data/alpha/state'), { recursive: true });
}

/** Every family row's contents, keyed by row. */
async function contents(at = root): Promise<Record<string, string>> {
  const entries: [string, string][] = [];
  for (const member of PIPELINE_DEFINITIONS_BACKUP_MEMBERS)
    entries.push([
      member.namespaceId,
      fileSetDigest(
        await fileSetManifest(join(at, member.path), member.exclude),
      ),
    ]);
  return Object.fromEntries(entries);
}

function listed(at: string): unknown {
  const store = createPipelineDefinitionStore(
    createDaemonPipelineDefinitionStoreEnvironment({
      dataRoot: at,
      bundledPipelinesDir: join(at, 'bundled'),
      lock: {
        ensurePrivateLockDirectorySync: () => undefined,
        withOwnerLockFileSync: (_path, operation) => operation(),
      },
      flushDirectorySync: () => undefined,
    }),
  );
  return store
    .listStoredPipelines()
    .data?.filter((info) => info.source === 'user')
    .map(({ id, name, revision }) => ({ id, name, revision }));
}

/** What the family's own readers answer under a data root. */
async function read(at: string): Promise<unknown> {
  return {
    definitions: listed(at),
    replays: await createPipelineDefinitionReplayStore({
      filePath: () => pipelineDefinitionReplaysPath(at),
      write: () => Promise.reject(new Error('read only')),
    }).load(),
    assets: await createPipelineAssetStore(
      createDaemonPipelineAssetEnvironment({
        dataRoot: at,
        flushDirectorySync: () => undefined,
      }),
    ).readManifest('alpha'),
  };
}

async function thrown(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected an error');
}

/** A data root holding only a copy of `root`'s backups. */
function emptyRootWithBackups(): string {
  const empty = mkdtempSync(join(tmpdir(), 'pipeline-definitions-restore-'));
  cpSync(join(root, 'backups'), join(empty, 'backups'), { recursive: true });
  return empty;
}

const stray = (at: string): string[] =>
  readdirSync(at).filter((name) => name.startsWith('.pipeline'));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pipeline-definitions-backup-'));
  quiesced = 0;
  lock = recordingLock();
  now = Date.parse('2026-11-23T16:00:00.000Z');
  rename.mockImplementation(actual.rename);
  copyFile.mockImplementation(actual.copyFile);
  mkdir.mockImplementation(actual.mkdir);
  mockFaults.length = 0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('pipeline definitions backup and restore (CAN-5340)', () => {
  it('issues no record while the rows are not required_before_flip, and writes nothing', async () => {
    seed();
    const error = await thrown(() =>
      backupPipelineDefinitions(options({ ownership: undefined })),
    );
    expect(error).toMatchObject({ code: 'NOT_REQUIRED_BEFORE_FLIP' });
    expect(quiesced).toBe(0);
    expect(existsSync(join(root, 'backups'))).toBe(false);
  });

  it('issues one verified, restore-tested namespace_backup record per row', async () => {
    seed();
    const records = await backupPipelineDefinitions(options());
    const live = await contents();
    expect(quiesced).toBe(1);
    expect(records.map((record) => record.namespaceId)).toEqual(FAMILY);
    for (const record of records) {
      expect(
        validateNamespaceBackupRecord(record, {
          rows: FLIP_READY,
          isOutsideCheckouts: outside,
        }).ok,
      ).toBe(true);
      expect(record).toMatchObject({
        backupPath: `backups/pipeline-definitions-1/${record.namespaceId}`,
        sourceRevision: `sha256:${live[record.namespaceId]}`,
        verifiedBy: { algorithm: 'sha256', digest: live[record.namespaceId] },
        rollbackMigration: 'restorePipelineDefinitionsBackup',
        createdAt: '2026-11-23T16:00:00.000Z',
      });
    }
    const copy = join(root, 'backups/pipeline-definitions-1');
    expect(
      readFileSync(join(copy, 'pipeline_definitions/data/alpha.yaml'), 'utf8'),
    ).toContain('name: Alpha');
    expect(
      existsSync(
        join(copy, 'pipeline_definitions/data/.project-share-links.json'),
      ),
    ).toBe(false);
    expect(readdirSync(join(root, 'backups'))).toEqual([
      'pipeline-definitions-1',
    ]);
  });

  it("restores into an empty data root, read back equal through each row's own reader", async () => {
    seed();
    const before = await contents();
    const answered = await read(root);
    expect(answered).toEqual({
      definitions: [
        { id: 'alpha', name: 'Alpha', revision: 3 },
        { id: 'zeta', name: 'Zeta', revision: 1 },
      ],
      replays: {
        entries: [],
        expired: [
          { operation: 'core.pipeline.definition.upsert', key: RECEIPT },
        ],
      },
      assets: {
        version: 1,
        assets: {
          tool: { installMode: 'seed', files: { 'tool.sh': RECEIPT } },
        },
      },
    });
    const records = await backupPipelineDefinitions(options());
    const empty = emptyRootWithBackups();
    try {
      const result = await restorePipelineDefinitionsBackup(
        records,
        options({ dataRoot: empty }),
      );
      expect(result).toEqual({ restored: FAMILY, unchanged: [], setAside: [] });
      expect(await contents(empty)).toEqual(before);
      expect(await read(empty)).toEqual(answered);
      expect(
        statSync(join(empty, 'pipeline-data/alpha/state')).isDirectory(),
      ).toBe(true);
      expect(stray(empty)).toEqual([]);
      expect(
        readdirSync(join(empty, 'backups/pipeline-definitions-1')).sort(),
      ).toEqual(FAMILY.slice().sort());
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('refuses to restore over writes made after the backup, changing nothing', async () => {
    seed();
    const records = await backupPipelineDefinitions(options());
    write('pipelines/beta.yaml', 'name: Beta\non: dispatch\njobs: {}\n');
    write('pipeline-definition-replays.json', '{"version":1,"receipts":["r"]}');
    const newer = await contents();
    const error = await thrown(() =>
      restorePipelineDefinitionsBackup(records, options()),
    );
    expect(error).toMatchObject({ code: 'NEWER_STATE' });
    expect(String(error)).toContain(
      'pipeline_definition_replays, pipeline_definitions',
    );
    expect(await contents()).toEqual(newer);
    expect(stray(root)).toEqual([]);
    expect(
      existsSync(
        join(root, 'backups/pipeline-definitions-1/restore-journal.json'),
      ),
    ).toBe(false);
  });

  it('restores over newer writes only on a person-confirmed loss, setting them aside and leaving the share-link catalog in place', async () => {
    seed();
    const before = await contents();
    const records = await backupPipelineDefinitions(options());
    write('pipelines/beta.yaml', 'name: Beta\non: dispatch\njobs: {}\n');
    write('pipelines/.project-share-links.json', '{"p":"link-2"}');
    const catalog = statSync(join(root, 'pipelines/.project-share-links.json'));
    const events: string[] = [];
    const logged: PipelineDefinitionsNewerLoss[] = [];
    rename.mockImplementation(async (source, target) => {
      events.push('rename');
      await actual.rename(source, target);
    });
    const result = await restorePipelineDefinitionsBackup(
      records,
      options({
        acceptNewerLoss: {
          confirmedBy: 'person',
          log: (loss) => {
            events.push('log');
            logged.push(loss);
          },
        },
      }),
    );
    expect(logged).toEqual([
      {
        backupPath: 'backups/pipeline-definitions-1',
        rows: ['pipeline_definitions'],
      },
    ]);
    expect(events[0]).toBe('log');
    expect(result).toEqual({
      restored: ['pipeline_definitions'],
      unchanged: ['pipeline_definition_replays', 'pipeline_data'],
      setAside: [`pipelines.pre-restore-${String(now)}`],
    });
    expect(await contents()).toEqual(before);
    const kept = join(root, 'pipelines/.project-share-links.json');
    expect(readFileSync(kept, 'utf8')).toBe('{"p":"link-2"}');
    expect(statSync(kept)).toMatchObject({
      ino: catalog.ino,
      mtimeMs: catalog.mtimeMs,
    });
    const aside = join(root, `pipelines.pre-restore-${String(now)}`);
    expect(readdirSync(aside).sort()).toEqual([
      'alpha.yaml',
      'beta.yaml',
      'index.json',
      'zeta.yaml',
    ]);
  });

  it('refuses a copy that no longer matches its record, changing nothing', async () => {
    seed();
    const records = await backupPipelineDefinitions(options());
    write(
      'backups/pipeline-definitions-1/pipeline_data/data/alpha/assets/tool/tool.sh',
      'changed\n',
    );
    rmSync(join(root, 'pipelines'), { recursive: true });
    const live = await contents();
    expect(
      await thrown(() => restorePipelineDefinitionsBackup(records, options())),
    ).toMatchObject({ code: 'BACKUP_UNVERIFIED' });
    expect(await contents()).toEqual(live);
  });

  it('refuses records that are not one whole family backup', async () => {
    seed();
    const records = await backupPipelineDefinitions(options());
    const second = await backupPipelineDefinitions(
      options({ backupPath: 'backups/pipeline-definitions-2' }),
    );
    const tampered: NamespaceBackupRecord[] = records.map((record) => ({
      ...record,
      rollbackMigration: 'restoreOperationLedgerBackup',
    }));
    for (const set of [
      records.slice(1),
      [...records, records[0]],
      tampered,
      [records[0], records[1], second[2]],
    ])
      expect(
        await thrown(() => restorePipelineDefinitionsBackup(set, options())),
      ).toMatchObject({ code: 'BACKUP_UNVERIFIED' });
  });

  it('runs only while the family is quiesced: a write during the copy fails the backup and leaves no copy', async () => {
    seed();
    copyFile.mockImplementationOnce(async (source, target, mode) => {
      writeFileSync(join(root, 'pipelines/late.yaml'), 'name: Late\n');
      await actual.copyFile(source, target, mode);
    });
    const error = await thrown(() => backupPipelineDefinitions(options()));
    expect(error).toMatchObject({ code: 'NOT_QUIESCED' });
    expect(existsSync(join(root, 'backups/pipeline-definitions-1'))).toBe(
      false,
    );
  });

  it('touches nothing when the family cannot be quiesced', async () => {
    seed();
    const refuse = (): Promise<never> =>
      Promise.reject(new Error('writers still running'));
    await expect(
      backupPipelineDefinitions(options({ quiesce: refuse })),
    ).rejects.toThrow('writers still running');
    expect(existsSync(join(root, 'backups'))).toBe(false);
  });

  it('refuses while a workflow install is in flight', async () => {
    seed();
    const records = await backupPipelineDefinitions(options());
    write(
      'pipeline-install-intents/0a7f2c1e-5b3d-4e8a-9c6f-1d2e3f4a5b6c.json',
      '{}',
    );
    expect(
      await thrown(() =>
        backupPipelineDefinitions(options({ backupPath: 'backups/second' })),
      ),
    ).toMatchObject({ code: 'NOT_QUIESCED' });
    rmSync(join(root, 'pipelines'), { recursive: true });
    expect(
      await thrown(() => restorePipelineDefinitionsBackup(records, options())),
    ).toMatchObject({ code: 'NOT_QUIESCED' });
  });

  it('never overwrites a path', async () => {
    seed();
    write('backups/pipeline-definitions-1/keep.txt', 'keep');
    expect(
      await thrown(() => backupPipelineDefinitions(options())),
    ).toMatchObject({ code: 'BACKUP_UNVERIFIED' });
    expect(
      readFileSync(
        join(root, 'backups/pipeline-definitions-1/keep.txt'),
        'utf8',
      ),
    ).toBe('keep');
  });

  it('completes an interrupted restore when run again, with the index put in place last', async () => {
    seed();
    const before = await contents();
    const records = await backupPipelineDefinitions(options());
    const empty = emptyRootWithBackups();
    try {
      const index = join(empty, 'pipelines', 'index.json');
      rename.mockImplementation(async (source, target) => {
        if (target === index) throw new Error('killed');
        await actual.rename(source, target);
      });
      await expect(
        restorePipelineDefinitionsBackup(records, options({ dataRoot: empty })),
      ).rejects.toThrow('killed');
      const interrupted = await contents(empty);
      expect(interrupted.pipeline_definition_replays).toBe(
        before.pipeline_definition_replays,
      );
      expect(interrupted.pipeline_data).toBe(before.pipeline_data);
      expect(readdirSync(join(empty, 'pipelines')).sort()).toEqual([
        'alpha.yaml',
        'zeta.yaml',
      ]);
      expect(listed(empty)).toEqual([]);
      rename.mockImplementation(actual.rename);
      now += 1000;
      const result = await restorePipelineDefinitionsBackup(
        records,
        options({ dataRoot: empty }),
      );
      // The retry keeps the documents already placed and places the index.
      expect(result).toEqual({
        restored: ['pipeline_definitions'],
        unchanged: ['pipeline_definition_replays', 'pipeline_data'],
        setAside: [],
      });
      expect(stray(empty)).toEqual([]);
      expect(await contents(empty)).toEqual(before);
      expect(
        existsSync(
          join(empty, 'backups/pipeline-definitions-1/restore-journal.json'),
        ),
      ).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("holds the definitions store's own writer lock for every change, and refuses while another writer holds it", async () => {
    seed();
    const records = await backupPipelineDefinitions(options());
    let storeLock = '';
    createDaemonPipelineDefinitionStoreEnvironment({
      dataRoot: root,
      bundledPipelinesDir: join(root, 'bundled'),
      lock: {
        ensurePrivateLockDirectorySync: () => undefined,
        withOwnerLockFileSync: (path, operation) => {
          storeLock = path;
          return operation();
        },
      },
      flushDirectorySync: () => undefined,
    }).withWriterLock(() => undefined, { maxWaitMs: 0, timeoutMessage: '' });
    expect(lock.paths).toEqual([storeLock]);
    rmSync(join(root, 'pipelines'), { recursive: true });
    const unlocked: string[] = [];
    rename.mockImplementation(async (source, target) => {
      if (!lock.held()) unlocked.push(String(target));
      await actual.rename(source, target);
    });
    await restorePipelineDefinitionsBackup(records, options());
    expect(unlocked).toEqual([]);
    expect(lock.paths).toEqual([storeLock, storeLock]);
    rmSync(join(root, 'pipelines'), { recursive: true });
    writeFileSync(storeLock, String(process.pid));
    const before = await contents();
    expect(
      await thrown(() => restorePipelineDefinitionsBackup(records, options())),
    ).toMatchObject({ code: 'NOT_QUIESCED' });
    expect(await contents()).toEqual(before);
  });

  it('completes a restore killed at any row boundary, and no kill leaves an index naming a missing document', async () => {
    seed();
    const before = await contents();
    const answered = await read(root);
    const records = await backupPipelineDefinitions(options());
    const recordsFile = join(root, 'records.json');
    writeFileSync(recordsFile, JSON.stringify(records));
    const dry = emptyRootWithBackups();
    const flushed: string[] = [];
    try {
      await restorePipelineDefinitionsBackup(
        records,
        options({
          dataRoot: dry,
          syncDirectory: (path) => {
            flushed.push(path.slice(realpathSync(dry).length));
            return strictFlush(path);
          },
        }),
      );
    } finally {
      rmSync(dry, { recursive: true, force: true });
    }
    const after = (path: string, nth = 1): number => {
      let seen = 0;
      const index = flushed.findIndex(
        (each) => each === path && ++seen === nth,
      );
      if (index < 0) throw new Error(`No flush of ${path}`);
      return index + 1;
    };
    const boundaries = [
      after('/backups/pipeline-definitions-1'),
      after(''),
      after('/pipeline-data'),
      after('/pipelines'),
      after('/pipelines', 2),
    ];
    for (const killAt of boundaries) {
      const killed = emptyRootWithBackups();
      try {
        const child = spawnSync(
          process.execPath,
          [
            '--disable-warning=ExperimentalWarning',
            '--import',
            'tsx',
            join(__dirname, 'definitions-backup-kill.fixture.ts'),
            killed,
            recordsFile,
            String(killAt),
          ],
          { encoding: 'utf8', timeout: 60_000 },
        );
        expect({ killAt, signal: child.signal, stderr: child.stderr }).toEqual({
          killAt,
          signal: 'SIGKILL',
          stderr: '',
        });
        expect([[], listed(root)]).toContainEqual(listed(killed));
        await restorePipelineDefinitionsBackup(
          records,
          options({ dataRoot: killed }),
        );
        expect(await contents(killed)).toEqual(before);
        expect(await read(killed)).toEqual(answered);
        expect(
          existsSync(
            join(killed, 'backups/pipeline-definitions-1/restore-journal.json'),
          ),
        ).toBe(false);
      } finally {
        rmSync(killed, { recursive: true, force: true });
      }
    }
  });

  it('refuses to resume over writes made after a failed restore, unless a person confirms and logs the loss', async () => {
    seed();
    const before = await contents();
    const records = await backupPipelineDefinitions(options());
    const empty = emptyRootWithBackups();
    try {
      const data = join(empty, 'pipeline-data', 'alpha');
      rename.mockImplementation(async (source, target) => {
        if (target === data) throw new Error('failed');
        await actual.rename(source, target);
      });
      await expect(
        restorePipelineDefinitionsBackup(records, options({ dataRoot: empty })),
      ).rejects.toThrow('failed');
      rename.mockImplementation(actual.rename);
      write(
        'pipelines/beta.yaml',
        'name: Beta\non: dispatch\njobs: {}\n',
        empty,
      );
      const later = await contents(empty);
      const error = await thrown(() =>
        restorePipelineDefinitionsBackup(records, options({ dataRoot: empty })),
      );
      expect(error).toMatchObject({ code: 'NEWER_STATE' });
      expect(String(error)).toContain(
        'Changed since the backup: pipeline_definitions.',
      );
      expect(await contents(empty)).toEqual(later);
      const logged: PipelineDefinitionsNewerLoss[] = [];
      await restorePipelineDefinitionsBackup(
        records,
        options({
          dataRoot: empty,
          acceptNewerLoss: {
            confirmedBy: 'person',
            log: (loss) => logged.push(loss),
          },
        }),
      );
      expect(logged).toEqual([
        {
          backupPath: 'backups/pipeline-definitions-1',
          rows: ['pipeline_definitions'],
        },
      ]);
      expect(await contents(empty)).toEqual(before);
      expect(
        readFileSync(
          join(empty, `pipelines.pre-restore-${String(now)}`, 'beta.yaml'),
          'utf8',
        ),
      ).toContain('Beta');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('sets the index aside before any document it names, so a confirmed restore stopped mid-set-aside never lists a missing workflow', async () => {
    seed();
    const before = await contents();
    const records = await backupPipelineDefinitions(options());
    const original = listed(root);
    write('pipelines/beta.yaml', 'name: Beta\non: dispatch\njobs: {}\n');
    const aside = join(root, `pipelines.pre-restore-${String(now)}`);
    rename.mockImplementation(async (source, target) => {
      if (target === join(aside, 'beta.yaml')) throw new Error('stopped');
      await actual.rename(source, target);
    });
    const confirmed = {
      confirmedBy: 'person' as const,
      log: (): void => undefined,
    };
    await expect(
      restorePipelineDefinitionsBackup(
        records,
        options({ acceptNewerLoss: confirmed }),
      ),
    ).rejects.toThrow('stopped');
    expect([[], original]).toContainEqual(listed(root));
    rename.mockImplementation(actual.rename);
    now += 1000;
    await restorePipelineDefinitionsBackup(records, options());
    expect(await contents()).toEqual(before);
  });

  it('flushes the data root after each folder row and before the journal goes', async () => {
    seed();
    const records = await backupPipelineDefinitions(options());
    const empty = emptyRootWithBackups();
    const flushed: string[] = [];
    try {
      await restorePipelineDefinitionsBackup(
        records,
        options({
          dataRoot: empty,
          syncDirectory: (path) => {
            flushed.push(path.slice(realpathSync(empty).length));
            return strictFlush(path);
          },
        }),
      );
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
    const last = (path: string): number => flushed.lastIndexOf(path);
    const journalGone = last('/backups/pipeline-definitions-1');
    for (const folder of ['/pipeline-data', '/pipelines']) {
      const placed = last(folder);
      const root = flushed.indexOf('', placed);
      expect({
        folder,
        flushedRootAfter: root > placed && root < journalGone,
      }).toEqual({
        folder,
        flushedRootAfter: true,
      });
    }
  });

  it('completes a confirmed restore killed while it sets the earlier definitions aside', async () => {
    seed();
    const before = await contents();
    const records = await backupPipelineDefinitions(options());
    write('pipelines/beta.yaml', 'name: Beta\non: dispatch\njobs: {}\n');
    const original = listed(root);
    const recordsFile = join(
      tmpdir(),
      `definitions-records-${String(process.pid)}.json`,
    );
    writeFileSync(recordsFile, JSON.stringify(records));
    const copy = (): string => {
      const at = mkdtempSync(join(tmpdir(), 'pipeline-definitions-confirmed-'));
      cpSync(root, at, { recursive: true });
      return at;
    };
    const dry = copy();
    const flushed: string[] = [];
    try {
      await restorePipelineDefinitionsBackup(
        records,
        options({
          dataRoot: dry,
          acceptNewerLoss: { confirmedBy: 'person', log: () => undefined },
          syncDirectory: (path) => {
            flushed.push(path.slice(realpathSync(dry).length));
            return strictFlush(path);
          },
        }),
      );
    } finally {
      rmSync(dry, { recursive: true, force: true });
    }
    const boundaries = [
      flushed.indexOf('/pipelines') + 1,
      flushed.findIndex((path) => path.startsWith('/pipelines.pre-restore-')) +
        1,
    ];
    expect(boundaries.every((boundary) => boundary > 0)).toBe(true);
    try {
      for (const killAt of boundaries) {
        const killed = copy();
        try {
          const child = spawnSync(
            process.execPath,
            [
              '--disable-warning=ExperimentalWarning',
              '--import',
              'tsx',
              join(__dirname, 'definitions-backup-kill.fixture.ts'),
              killed,
              recordsFile,
              String(killAt),
              'accept',
            ],
            { encoding: 'utf8', timeout: 60_000 },
          );
          expect({
            killAt,
            signal: child.signal,
            stderr: child.stderr,
          }).toEqual({
            killAt,
            signal: 'SIGKILL',
            stderr: '',
          });
          expect([[], original]).toContainEqual(listed(killed));
          await restorePipelineDefinitionsBackup(
            records,
            options({ dataRoot: killed }),
          );
          expect(await contents(killed)).toEqual(before);
        } finally {
          rmSync(killed, { recursive: true, force: true });
        }
      }
    } finally {
      rmSync(recordsFile, { force: true });
    }
  });

  it('flushes every folder the backup creates, up to the data root, before it issues records', async () => {
    seed();
    const flushed: string[] = [];
    const records = await backupPipelineDefinitions(
      options({
        backupPath: 'backups/nested/pipeline-definitions-1',
        syncDirectory: (path) => {
          flushed.push(path.slice(realpathSync(root).length));
          return strictFlush(path);
        },
      }),
    );
    expect(records).toHaveLength(3);
    // Each new folder's entry lives in its parent: the parent's flush makes it durable.
    expect({
      root: flushed.includes(''),
      backups: flushed.includes('/backups'),
      nested: flushed.includes('/backups/nested'),
      base: flushed.includes('/backups/nested/pipeline-definitions-1'),
    }).toEqual({ root: true, backups: true, nested: true, base: true });
  });

  it('treats a file deleted from a row an interrupted restore had finished as newer state: refused unless a person confirms and logs the loss', async () => {
    seed();
    const before = await contents();
    const records = await backupPipelineDefinitions(options());
    const empty = emptyRootWithBackups();
    try {
      const index = join(empty, 'pipelines', 'index.json');
      rename.mockImplementation(async (source, target) => {
        if (target === index) throw new Error('killed');
        await actual.rename(source, target);
      });
      await expect(
        restorePipelineDefinitionsBackup(records, options({ dataRoot: empty })),
      ).rejects.toThrow('killed');
      rename.mockImplementation(actual.rename);
      expect((await contents(empty)).pipeline_data).toBe(before.pipeline_data);
      rmSync(join(empty, 'pipeline-data/alpha/assets/tool/tool.sh'));
      const later = await contents(empty);
      const error = await thrown(() =>
        restorePipelineDefinitionsBackup(records, options({ dataRoot: empty })),
      );
      expect(error).toMatchObject({ code: 'NEWER_STATE' });
      expect(String(error)).toContain(
        'Changed since the backup: pipeline_data.',
      );
      expect(await contents(empty)).toEqual(later);
      now += 1000;
      const logged: PipelineDefinitionsNewerLoss[] = [];
      await restorePipelineDefinitionsBackup(
        records,
        options({
          dataRoot: empty,
          acceptNewerLoss: {
            confirmedBy: 'person',
            log: (loss) => logged.push(loss),
          },
        }),
      );
      expect(logged).toEqual([
        {
          backupPath: 'backups/pipeline-definitions-1',
          rows: ['pipeline_data'],
        },
      ]);
      expect(await contents(empty)).toEqual(before);
      expect(
        existsSync(
          join(empty, `pipeline-data.pre-restore-${String(now)}`, 'alpha'),
        ),
      ).toBe(true);
      expect(
        existsSync(
          join(empty, 'backups/pipeline-definitions-1/restore-journal.json'),
        ),
      ).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('treats a top-level entry an interrupted restore placed and that was then removed as newer state, while an untouched retry completes', async () => {
    seed();
    const before = await contents();
    const records = await backupPipelineDefinitions(options());
    const empty = emptyRootWithBackups();
    const untouched = mkdtempSync(
      join(tmpdir(), 'pipeline-definitions-untouched-'),
    );
    try {
      const zeta = join(empty, 'pipelines', 'zeta.yaml');
      rename.mockImplementation(async (source, target) => {
        if (target === zeta) throw new Error('killed');
        await actual.rename(source, target);
      });
      await expect(
        restorePipelineDefinitionsBackup(records, options({ dataRoot: empty })),
      ).rejects.toThrow('killed');
      rename.mockImplementation(actual.rename);
      expect(readdirSync(join(empty, 'pipelines'))).toEqual(['alpha.yaml']);
      cpSync(empty, untouched, { recursive: true });
      now += 1000;
      await restorePipelineDefinitionsBackup(
        records,
        options({ dataRoot: untouched }),
      );
      expect(await contents(untouched)).toEqual(before);
      expect(stray(untouched)).toEqual([]);

      rmSync(join(empty, 'pipelines', 'alpha.yaml'));
      const later = await contents(empty);
      const error = await thrown(() =>
        restorePipelineDefinitionsBackup(records, options({ dataRoot: empty })),
      );
      expect(error).toMatchObject({ code: 'NEWER_STATE' });
      expect(String(error)).toContain(
        'Changed since the backup: pipeline_definitions.',
      );
      expect(await contents(empty)).toEqual(later);
      const logged: PipelineDefinitionsNewerLoss[] = [];
      await restorePipelineDefinitionsBackup(
        records,
        options({
          dataRoot: empty,
          acceptNewerLoss: {
            confirmedBy: 'person',
            log: (loss) => logged.push(loss),
          },
        }),
      );
      expect(logged).toEqual([
        {
          backupPath: 'backups/pipeline-definitions-1',
          rows: ['pipeline_definitions'],
        },
      ]);
      expect(await contents(empty)).toEqual(before);
      expect(stray(empty)).toEqual([]);
      expect(
        existsSync(
          join(empty, 'backups/pipeline-definitions-1/restore-journal.json'),
        ),
      ).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
      rmSync(untouched, { recursive: true, force: true });
    }
  });

  it('treats an entry an earlier attempt placed as placed after a retry refills the staging folder, so removing it is newer state', async () => {
    seed();
    const before = await contents();
    const records = await backupPipelineDefinitions(options());
    const empty = emptyRootWithBackups();
    try {
      const pipelines = join(empty, 'pipelines');
      // Stops each attempt just before the index is named, after the
      // documents are in place.
      const stopping = options({
        dataRoot: empty,
        syncDirectory: (path) =>
          path === pipelines && existsSync(join(pipelines, 'zeta.yaml'))
            ? Promise.reject(new Error('stopped'))
            : strictFlush(path),
      });
      await expect(
        restorePipelineDefinitionsBackup(records, stopping),
      ).rejects.toThrow('stopped');
      expect(readdirSync(pipelines).sort()).toEqual([
        'alpha.yaml',
        'zeta.yaml',
      ]);
      now += 1000;
      await expect(
        restorePipelineDefinitionsBackup(records, stopping),
      ).rejects.toThrow('stopped');
      rmSync(join(pipelines, 'zeta.yaml'));
      const later = await contents(empty);
      const error = await thrown(() =>
        restorePipelineDefinitionsBackup(records, options({ dataRoot: empty })),
      );
      expect(error).toMatchObject({ code: 'NEWER_STATE' });
      expect(String(error)).toContain(
        'Changed since the backup: pipeline_definitions.',
      );
      expect(await contents(empty)).toEqual(later);
      const logged: PipelineDefinitionsNewerLoss[] = [];
      await restorePipelineDefinitionsBackup(
        records,
        options({
          dataRoot: empty,
          acceptNewerLoss: {
            confirmedBy: 'person',
            log: (loss) => logged.push(loss),
          },
        }),
      );
      expect(logged).toEqual([
        {
          backupPath: 'backups/pipeline-definitions-1',
          rows: ['pipeline_definitions'],
        },
      ]);
      expect(await contents(empty)).toEqual(before);
      expect(stray(empty)).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('flushes the folders an earlier failed backup left, up to the data root, before the next backup issues records', async () => {
    seed();
    let failRootFlush = true;
    await expect(
      backupPipelineDefinitions(
        options({
          syncDirectory: (path) => {
            if (failRootFlush && path.slice(realpathSync(root).length) === '') {
              failRootFlush = false;
              return Promise.reject(new Error('flush failed'));
            }
            return strictFlush(path);
          },
        }),
      ),
    ).rejects.toThrow('flush failed');
    // The failed backup removed its own folder; backups/ stays.
    expect(readdirSync(join(root, 'backups'))).toEqual([]);
    const flushed: string[] = [];
    await backupPipelineDefinitions(
      options({
        backupPath: 'backups/pipeline-definitions-2',
        syncDirectory: (path) => {
          flushed.push(path.slice(realpathSync(root).length));
          return strictFlush(path);
        },
      }),
    );
    expect({
      root: flushed.includes(''),
      backups: flushed.includes('/backups'),
      base: flushed.includes('/backups/pipeline-definitions-2'),
    }).toEqual({ root: true, backups: true, base: true });
  });

  it('flushes every row again before the journal goes when a retry finds the rows already in place', async () => {
    seed();
    const before = await contents();
    const records = await backupPipelineDefinitions(options());
    const empty = emptyRootWithBackups();
    try {
      const journal = join(
        empty,
        'backups/pipeline-definitions-1/restore-journal.json',
      );
      let rootFlushes = 0;
      await expect(
        restorePipelineDefinitionsBackup(
          records,
          options({
            dataRoot: empty,
            // The last row is in place when its data-root flush fails.
            syncDirectory: (path) =>
              path.slice(realpathSync(empty).length) === '' &&
              existsSync(join(empty, 'pipelines', 'index.json')) &&
              ++rootFlushes === 1
                ? Promise.reject(new Error('flush failed'))
                : strictFlush(path),
          }),
        ),
      ).rejects.toThrow('flush failed');
      expect(await contents(empty)).toEqual(before);
      expect(existsSync(journal)).toBe(true);
      const flushed: string[] = [];
      let journalGoneAt = -1;
      const result = await restorePipelineDefinitionsBackup(
        records,
        options({
          dataRoot: empty,
          syncDirectory: (path) => {
            const at = path.slice(realpathSync(empty).length);
            if (journalGoneAt < 0 && !existsSync(journal))
              journalGoneAt = flushed.length;
            flushed.push(at);
            return strictFlush(path);
          },
        }),
      );
      expect(result.restored).toEqual([]);
      expect(existsSync(journal)).toBe(false);
      const beforeJournalGoes = flushed.slice(
        0,
        journalGoneAt < 0 ? flushed.length : journalGoneAt,
      );
      expect({
        root: beforeJournalGoes.includes(''),
        pipelines: beforeJournalGoes.includes('/pipelines'),
        data: beforeJournalGoes.includes('/pipeline-data'),
      }).toEqual({ root: true, pipelines: true, data: true });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('flushes the removal of its staging folders before the journal that names them goes', async () => {
    seed();
    const records = await backupPipelineDefinitions(options());
    const empty = emptyRootWithBackups();
    try {
      const journal = join(
        empty,
        'backups/pipeline-definitions-1/restore-journal.json',
      );
      const rootFlushes: { strays: number; journal: boolean }[] = [];
      await restorePipelineDefinitionsBackup(
        records,
        options({
          dataRoot: empty,
          syncDirectory: (path) => {
            if (path.slice(realpathSync(empty).length) === '')
              rootFlushes.push({
                strays: stray(empty).length,
                journal: existsSync(journal),
              });
            return strictFlush(path);
          },
        }),
      );
      expect(rootFlushes).toContainEqual({ strays: 0, journal: true });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("resumes without confirmation after a crash between creating the staging folder and the first row's flush", async () => {
    seed();
    const before = await contents();
    const records = await backupPipelineDefinitions(options());
    const empty = emptyRootWithBackups();
    try {
      let rootFlushed = false;
      let journalFlushes = 0;
      await expect(
        restorePipelineDefinitionsBackup(
          records,
          options({
            dataRoot: empty,
            // Stops once the first row's entry is named, before it moves.
            syncDirectory: (path) => {
              const at = path.slice(realpathSync(empty).length);
              if (at === '') rootFlushed = true;
              if (
                at === '/backups/pipeline-definitions-1' &&
                ++journalFlushes === 3
              )
                return Promise.reject(new Error('crashed'));
              return strictFlush(path);
            },
          }),
        ),
      ).rejects.toThrow('crashed');
      // A crash loses a new folder whose parent was never flushed.
      if (!rootFlushed)
        for (const name of stray(empty))
          rmSync(join(empty, name), { recursive: true, force: true });
      await restorePipelineDefinitionsBackup(
        records,
        options({ dataRoot: empty }),
      );
      expect(await contents(empty)).toEqual(before);
      expect(stray(empty)).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('journals no step before the moves and folders it follows are flushed, so a crash that loses unflushed changes still resumes', async () => {
    seed();
    const before = await contents();
    const records = await backupPipelineDefinitions(options());
    const empty = emptyRootWithBackups();
    try {
      const base = join(empty, 'backups/pipeline-definitions-1');
      const pipelines = join(empty, 'pipelines');
      // The crash model: a rename or a new folder is lost unless its parent
      // folder is flushed before the crash.
      const unflushed: { parent: string; undo: () => void }[] = [];
      let placedOne = false;
      rename.mockImplementation(async (source, target) => {
        await actual.rename(source, target);
        const from = String(source);
        const to = String(target);
        unflushed.push({
          parent: dirname(to),
          undo: () => renameSync(to, from),
        });
        if (to.startsWith(`${pipelines}${sep}`)) placedOne = true;
      });
      mkdir.mockImplementation(async (path, mode) => {
        const folder = String(path);
        const existed = existsSync(folder);
        const made = await actual.mkdir(path, mode);
        if (!existed)
          unflushed.push({
            parent: dirname(folder),
            undo: () => rmSync(folder, { recursive: true, force: true }),
          });
        return made;
      });
      const flush = (path: string): void => {
        for (let i = unflushed.length - 1; i >= 0; i -= 1)
          if (unflushed[i]?.parent === path) unflushed.splice(i, 1);
      };
      await expect(
        restorePipelineDefinitionsBackup(
          records,
          options({
            dataRoot: empty,
            // After the first definition moves in, the next journal step is
            // made durable and then the process dies.
            syncDirectory: (path) => {
              flush(path);
              return placedOne && path === base
                ? Promise.reject(new Error('crashed'))
                : strictFlush(path);
            },
          }),
        ),
      ).rejects.toThrow('crashed');
      rename.mockImplementation(actual.rename);
      mkdir.mockImplementation(actual.mkdir);
      for (const change of unflushed.reverse()) change.undo();
      await restorePipelineDefinitionsBackup(
        records,
        options({ dataRoot: empty }),
      );
      expect(await contents(empty)).toEqual(before);
      expect(stray(empty)).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("sets aside a regular file at a folder row's path whole, and resumes after a crash mid-set-aside", async () => {
    seed();
    const before = await contents();
    const records = await backupPipelineDefinitions(options());
    const live = join(root, 'pipelines');
    rmSync(live, { recursive: true, force: true });
    writeFileSync(live, 'not a folder\n');
    const refused = await thrown(() =>
      restorePipelineDefinitionsBackup(records, options()),
    );
    expect(refused).toMatchObject({ code: 'NEWER_STATE' });
    let failMkdir = true;
    mkdir.mockImplementation(async (path, mode) => {
      if (failMkdir && String(path) === live) {
        failMkdir = false;
        throw new Error('crashed');
      }
      return actual.mkdir(path, mode);
    });
    const first = now;
    await expect(
      restorePipelineDefinitionsBackup(
        records,
        options({
          acceptNewerLoss: { confirmedBy: 'person', log: () => undefined },
        }),
      ),
    ).rejects.toThrow('crashed');
    mkdir.mockImplementation(actual.mkdir);
    now += 1000;
    await restorePipelineDefinitionsBackup(records, options());
    expect(await contents()).toEqual(before);
    expect(
      readFileSync(
        join(root, `pipelines.pre-restore-${String(first)}`),
        'utf8',
      ),
    ).toBe('not a folder\n');
    expect(stray(root)).toEqual([]);
  });

  const CONFIRMED = {
    acceptNewerLoss: { confirmedBy: 'person', log: (): void => undefined },
  } as const;
  const BETA = 'name: Beta\non: dispatch\njobs: {}\n';

  it('restores a folder row that was absent at backup over one that now holds entries, setting them aside and leaving the row absent', async () => {
    seed();
    rmSync(join(root, 'pipeline-data'), { recursive: true, force: true });
    const before = await contents();
    const records = await backupPipelineDefinitions(options());
    write('pipeline-data/beta/assets.json', '{"version":1,"assets":{}}');
    const result = await restorePipelineDefinitionsBackup(
      records,
      options(CONFIRMED),
    );
    const aside = `pipeline-data.pre-restore-${String(now)}`;
    expect(result).toEqual({
      restored: ['pipeline_data'],
      unchanged: ['pipeline_definition_replays', 'pipeline_definitions'],
      setAside: [aside],
    });
    expect(await contents()).toEqual(before);
    expect(existsSync(join(root, 'pipeline-data'))).toBe(false);
    expect(readFileSync(join(root, aside, 'beta/assets.json'), 'utf8')).toBe(
      '{"version":1,"assets":{}}',
    );
    expect(stray(root)).toEqual([]);
  });

  it("opens every file it flushes read-write when the host's flush needs a write handle, and read-only otherwise", async () => {
    seed();
    const fileFlushFlags = (): string[] =>
      open.mock.calls.flatMap(([path, flags]) =>
        typeof flags === 'string' && !String(path).endsWith('writer.lock')
          ? [flags]
          : [],
      );
    open.mockClear();
    const records = await backupPipelineDefinitions(
      options({ flushRequiresWriteHandle: true }),
    );
    write('pipelines/beta.yaml', BETA);
    await restorePipelineDefinitionsBackup(
      records,
      options({ flushRequiresWriteHandle: true, ...CONFIRMED }),
    );
    const writeHandle = fileFlushFlags();
    open.mockClear();
    await backupPipelineDefinitions(
      options({ backupPath: 'backups/pipeline-definitions-2' }),
    );
    const readOnly = fileFlushFlags();
    expect({
      writeHandle: [...new Set(writeHandle)],
      readOnly: [...new Set(readOnly)],
    }).toEqual({ writeHandle: ['r+'], readOnly: ['r'] });
  });

  it('refuses, moving and overwriting nothing, when it cannot list a row it is about to replace', async () => {
    seed();
    const records = await backupPipelineDefinitions(options());
    write('pipelines/index.json', '{"version":1,"pipelines":[]}');
    write('pipelines/alpha.yaml', 'name: Alpha 2\non: dispatch\njobs: {}\n');
    write('pipelines/beta.yaml', BETA);
    const newer = await contents();
    let journalled = false;
    rename.mockImplementation(async (source, target) => {
      await actual.rename(source, target);
      if (String(target).endsWith('restore-journal.json')) journalled = true;
    });
    mockFaults.push({
      op: 'readdir',
      path: join(root, 'pipelines'),
      code: 'EMFILE',
      when: () => journalled,
    });
    const error = await thrown(() =>
      restorePipelineDefinitionsBackup(records, options(CONFIRMED)),
    );
    expect(error).toMatchObject({ code: 'EMFILE' });
    expect(await contents()).toEqual(newer);
  });

  it('reads each row back before it records the row done, so a row that does not match its backup is never claimed restored', async () => {
    seed();
    const records = await backupPipelineDefinitions(options());
    write('pipelines/beta.yaml', BETA);
    const live = join(root, 'pipelines');
    // A write that ignores the writer lock lands while the row is placed.
    rename.mockImplementation(async (source, target) => {
      await actual.rename(source, target);
      if (String(target) === join(live, 'index.json'))
        writeFileSync(join(live, 'stray.yaml'), 'name: Stray\n');
    });
    const error = await thrown(() =>
      restorePipelineDefinitionsBackup(records, options(CONFIRMED)),
    );
    expect(error).toMatchObject({ code: 'BACKUP_UNVERIFIED' });
    expect(String(error)).toContain('pipeline_definitions');
    expect(
      readFileSync(
        join(root, 'backups/pipeline-definitions-1/restore-journal.json'),
        'utf8',
      ),
    ).toContain('"pipeline_definitions":{"status":"in_progress"');
  });

  it("refuses when it cannot read an unfinished restore's journal, and leaves the journal as it was", async () => {
    seed();
    const records = await backupPipelineDefinitions(options());
    write('pipelines/beta.yaml', BETA);
    const journal = join(
      root,
      'backups/pipeline-definitions-1/restore-journal.json',
    );
    await expect(
      restorePipelineDefinitionsBackup(
        records,
        options({
          ...CONFIRMED,
          syncDirectory: (path) =>
            existsSync(journal)
              ? Promise.reject(new Error('crashed'))
              : strictFlush(path),
        }),
      ),
    ).rejects.toThrow('crashed');
    const saved = readFileSync(journal, 'utf8');
    mockFaults.push({ op: 'readFile', path: journal, code: 'EIO' });
    const error = await thrown(() =>
      restorePipelineDefinitionsBackup(records, options(CONFIRMED)),
    );
    expect(error).toMatchObject({ code: 'EIO' });
    expect(readFileSync(journal, 'utf8')).toBe(saved);
  });

  it('refuses when it cannot tell whether a row exists, in the backup and in the restore', async () => {
    seed();
    // Both of the backup's reads of the row fail the same way.
    for (let read = 0; read < 2; read += 1)
      mockFaults.push({
        op: 'lstat',
        path: join(root, 'pipeline-data'),
        code: 'EIO',
      });
    expect(
      await thrown(() => backupPipelineDefinitions(options())),
    ).toMatchObject({ code: 'EIO' });
    expect(existsSync(join(root, 'backups'))).toBe(false);
    mockFaults.length = 0;
    const records = await backupPipelineDefinitions(options());
    write('pipeline-definition-replays.json', '{"version":1,"entries":[]}');
    const newer = await contents();
    mockFaults.push({
      op: 'lstat',
      path: join(root, 'pipeline-definition-replays.json'),
      code: 'EIO',
    });
    expect(
      await thrown(() => restorePipelineDefinitionsBackup(records, options())),
    ).toMatchObject({ code: 'EIO' });
    expect(await contents()).toEqual(newer);
    expect(stray(root)).toEqual([]);
  });

  it('refuses to back up or restore while the host cannot confirm a folder flush, and completes once it can', async () => {
    seed();
    const before = await contents();
    const unsupported = (): Promise<'unsupported'> =>
      Promise.resolve('unsupported');
    expect(
      await thrown(() =>
        backupPipelineDefinitions(options({ syncDirectory: unsupported })),
      ),
    ).toMatchObject({ code: 'BACKUP_UNVERIFIED' });
    expect(existsSync(join(root, 'backups/pipeline-definitions-1'))).toBe(
      false,
    );
    const records = await backupPipelineDefinitions(options());
    write('pipelines/beta.yaml', BETA);
    const newer = await contents();
    expect(
      await thrown(() =>
        restorePipelineDefinitionsBackup(
          records,
          options({ ...CONFIRMED, syncDirectory: unsupported }),
        ),
      ),
    ).toMatchObject({ code: 'BACKUP_UNVERIFIED' });
    expect(await contents()).toEqual(newer);
    await restorePipelineDefinitionsBackup(records, options(CONFIRMED));
    expect(await contents()).toEqual(before);
  });

  it('flushes the folder an entry moves into before the folder it leaves, so no crash between the two loses the entry', async () => {
    seed();
    const before = await contents();
    const records = await backupPipelineDefinitions(options());
    const newerIndex = '{"version":1,"pipelines":[]}';
    write('pipelines/index.json', newerIndex);
    write('pipelines/beta.yaml', BETA);
    // The crash model, both halves: a moved entry has left its old folder
    // once that folder is flushed, and is in its new folder once that folder
    // is flushed and the new folder's own entry is durable in its parent.
    const moves: { from: string; to: string; arrived: boolean }[] = [];
    const created = new Map<string, boolean>();
    rename.mockImplementation(async (source, target) => {
      await actual.rename(source, target);
      moves.push({ from: String(source), to: String(target), arrived: false });
    });
    mkdir.mockImplementation(async (path, mode) => {
      const folder = String(path);
      const existed = existsSync(folder);
      const made = await actual.mkdir(path, mode);
      if (!existed) created.set(folder, false);
      return made;
    });
    const lost: string[] = [];
    const flushed = (path: string): void => {
      for (const folder of created.keys())
        if (dirname(folder) === path) created.set(folder, true);
      for (const move of moves) {
        const into = dirname(move.to);
        if (into === path) move.arrived = true;
        const safe = move.arrived && created.get(into) !== false;
        if (
          dirname(move.from) === path &&
          into !== path &&
          !safe &&
          !lost.includes(move.to.slice(root.length))
        )
          lost.push(move.to.slice(root.length));
      }
    };
    const result = await restorePipelineDefinitionsBackup(
      records,
      options({
        ...CONFIRMED,
        syncDirectory: (path) => {
          flushed(path);
          return strictFlush(path);
        },
      }),
    );
    expect(lost).toEqual([]);
    expect(await contents()).toEqual(before);
    const [aside = ''] = result.setAside;
    expect(readFileSync(join(root, aside, 'index.json'), 'utf8')).toBe(
      newerIndex,
    );
  });

  it('refuses to back up when it cannot list the install intents', async () => {
    seed();
    mkdirSync(join(root, 'pipeline-install-intents'), { recursive: true });
    mockFaults.push({
      op: 'readdir',
      path: join(root, 'pipeline-install-intents'),
      code: 'EACCES',
    });
    expect(
      await thrown(() => backupPipelineDefinitions(options())),
    ).toMatchObject({ code: 'EACCES' });
    expect(existsSync(join(root, 'backups'))).toBe(false);
  });

  it('restores a definitions folder that was absent at backup over one holding a share-link catalog and a document, leaving the catalog and setting the document aside', async () => {
    seed();
    rmSync(join(root, 'pipelines'), { recursive: true, force: true });
    const records = await backupPipelineDefinitions(options());
    write('pipelines/.project-share-links.json', '{"p":"link-3"}');
    write('pipelines/beta.yaml', BETA);
    const catalog = statSync(join(root, 'pipelines/.project-share-links.json'));
    const result = await restorePipelineDefinitionsBackup(
      records,
      options(CONFIRMED),
    );
    const aside = `pipelines.pre-restore-${String(now)}`;
    expect(result).toEqual({
      restored: ['pipeline_definitions'],
      unchanged: ['pipeline_definition_replays', 'pipeline_data'],
      setAside: [aside],
    });
    expect(readdirSync(join(root, 'pipelines'))).toEqual([
      '.project-share-links.json',
    ]);
    expect(
      statSync(join(root, 'pipelines/.project-share-links.json')),
    ).toMatchObject({ ino: catalog.ino, mtimeMs: catalog.mtimeMs });
    expect(readFileSync(join(root, aside, 'beta.yaml'), 'utf8')).toBe(BETA);
    expect(
      existsSync(
        join(root, 'backups/pipeline-definitions-1/restore-journal.json'),
      ),
    ).toBe(false);
    expect(stray(root)).toEqual([]);
  });

  it('treats a definitions folder holding only the share-link catalog as the absent folder it was backed up as, and changes nothing', async () => {
    seed();
    rmSync(join(root, 'pipelines'), { recursive: true, force: true });
    const records = await backupPipelineDefinitions(options());
    write('pipelines/.project-share-links.json', '{"p":"link-3"}');
    const catalog = statSync(join(root, 'pipelines/.project-share-links.json'));
    const result = await restorePipelineDefinitionsBackup(records, options());
    expect(result).toEqual({
      restored: [],
      unchanged: [
        'pipeline_definition_replays',
        'pipeline_data',
        'pipeline_definitions',
      ],
      setAside: [],
    });
    expect(
      statSync(join(root, 'pipelines/.project-share-links.json')),
    ).toMatchObject({ ino: catalog.ino, mtimeMs: catalog.mtimeMs });
    expect(
      existsSync(
        join(root, 'backups/pipeline-definitions-1/restore-journal.json'),
      ),
    ).toBe(false);
    expect(stray(root)).toEqual([]);
  });

  /**
   * The strict folder flush plus the crash model across attempts: each
   * folder keeps its entries as of its last flush, and every moment a
   * person's earlier entry is in neither the row nor a set-aside copy the
   * data root durably names is recorded. The first set-aside flush that
   * would make every earlier entry durable in that copy answers
   * `unsupported` once, which ends the attempt.
   */
  function flushTracker(
    live: string,
    earlier: readonly string[],
  ): {
    readonly syncDirectory: FamilyOptions['syncDirectory'];
    readonly lost: string[];
    readonly refused: () => boolean;
  } {
    const parent = dirname(live);
    const prefix = `${basename(live)}.pre-restore-`;
    const isAside = (folder: string): boolean =>
      dirname(folder) === parent && basename(folder).startsWith(prefix);
    const flushed = new Map<string, ReadonlySet<string>>([
      [parent, new Set(readdirSync(parent))],
      [live, new Set(readdirSync(live))],
    ]);
    const lost: string[] = [];
    let refused = false;
    return {
      lost,
      refused: () => refused,
      syncDirectory: async (path) => {
        if (
          !refused &&
          isAside(path) &&
          earlier.every((name) => existsSync(join(path, name)))
        ) {
          refused = true;
          return 'unsupported';
        }
        const answer = await strictFlush(path);
        flushed.set(path, new Set(readdirSync(path)));
        for (const name of earlier) {
          const durable =
            flushed.get(live)?.has(name) === true ||
            [...flushed].some(
              ([folder, names]) =>
                isAside(folder) &&
                flushed.get(parent)?.has(basename(folder)) === true &&
                names.has(name),
            );
          if (!durable && !lost.includes(name)) lost.push(name);
        }
        return answer;
      },
    };
  }

  it('flushes the set-aside copy an earlier attempt filled before the row on a resumed retry, so no crash loses an entry it moved out', async () => {
    seed();
    const records = await backupPipelineDefinitions(options());
    write('pipelines/index.json', '{"version":1,"pipelines":[]}');
    write('pipelines/beta.yaml', BETA);
    const earlier = ['alpha.yaml', 'beta.yaml', 'index.json', 'zeta.yaml'];
    const tracker = flushTracker(join(root, 'pipelines'), earlier);
    const attempt = options({ syncDirectory: tracker.syncDirectory });
    expect(
      await thrown(() =>
        restorePipelineDefinitionsBackup(records, { ...attempt, ...CONFIRMED }),
      ),
    ).toMatchObject({ code: 'BACKUP_UNVERIFIED' });
    expect(tracker.refused()).toBe(true);
    const result = await restorePipelineDefinitionsBackup(records, attempt);
    expect(tracker.lost).toEqual([]);
    const aside = `pipelines.pre-restore-${String(now)}`;
    expect(result).toMatchObject({
      restored: ['pipeline_definitions'],
      setAside: [aside],
    });
    expect(readdirSync(join(root, aside)).sort()).toEqual(earlier);
    expect(readFileSync(join(root, aside, 'beta.yaml'), 'utf8')).toBe(BETA);
  });

  it('flushes the set-aside copy before the row when a retry finds an emptied folder row equal to its absent backup', async () => {
    seed();
    rmSync(join(root, 'pipeline-data'), { recursive: true, force: true });
    const records = await backupPipelineDefinitions(options());
    write('pipeline-data/beta/assets.json', '{"version":1,"assets":{}}');
    const tracker = flushTracker(join(root, 'pipeline-data'), ['beta']);
    const attempt = options({ syncDirectory: tracker.syncDirectory });
    expect(
      await thrown(() =>
        restorePipelineDefinitionsBackup(records, { ...attempt, ...CONFIRMED }),
      ),
    ).toMatchObject({ code: 'BACKUP_UNVERIFIED' });
    expect(tracker.refused()).toBe(true);
    const result = await restorePipelineDefinitionsBackup(records, attempt);
    expect(tracker.lost).toEqual([]);
    const aside = `pipeline-data.pre-restore-${String(now)}`;
    expect(result.unchanged).toContain('pipeline_data');
    expect(result.setAside).toEqual([aside]);
    expect(readFileSync(join(root, aside, 'beta/assets.json'), 'utf8')).toBe(
      '{"version":1,"assets":{}}',
    );
  });

  it('flushes every set-aside copy an earlier attempt used before the row, when the retry finds newer state and sets more aside', async () => {
    seed();
    const records = await backupPipelineDefinitions(options());
    write('pipelines/index.json', '{"version":1,"pipelines":[]}');
    write('pipelines/beta.yaml', BETA);
    const earlier = ['alpha.yaml', 'beta.yaml', 'index.json', 'zeta.yaml'];
    const tracker = flushTracker(join(root, 'pipelines'), earlier);
    const attempt = options({
      syncDirectory: tracker.syncDirectory,
      ...CONFIRMED,
    });
    expect(
      await thrown(() => restorePipelineDefinitionsBackup(records, attempt)),
    ).toMatchObject({ code: 'BACKUP_UNVERIFIED' });
    expect(tracker.refused()).toBe(true);
    write('pipelines/stray.yaml', 'name: Stray\n');
    const first = `pipelines.pre-restore-${String(now)}`;
    now += 1000;
    const second = `pipelines.pre-restore-${String(now)}`;
    const result = await restorePipelineDefinitionsBackup(records, attempt);
    expect(tracker.lost).toEqual([]);
    expect([...result.setAside].sort()).toEqual([first, second]);
    expect(readdirSync(join(root, first)).sort()).toEqual(earlier);
    expect(readdirSync(join(root, second))).toEqual(['stray.yaml']);
  });

  it('flushes the set-aside copy before the definitions folder when a retry finds only the share-link catalog over an absent backup', async () => {
    seed();
    rmSync(join(root, 'pipelines'), { recursive: true, force: true });
    const records = await backupPipelineDefinitions(options());
    write('pipelines/.project-share-links.json', '{"p":"link-4"}');
    write('pipelines/beta.yaml', BETA);
    const tracker = flushTracker(join(root, 'pipelines'), ['beta.yaml']);
    const attempt = options({ syncDirectory: tracker.syncDirectory });
    expect(
      await thrown(() =>
        restorePipelineDefinitionsBackup(records, { ...attempt, ...CONFIRMED }),
      ),
    ).toMatchObject({ code: 'BACKUP_UNVERIFIED' });
    expect(tracker.refused()).toBe(true);
    const result = await restorePipelineDefinitionsBackup(records, attempt);
    expect(tracker.lost).toEqual([]);
    const aside = `pipelines.pre-restore-${String(now)}`;
    expect(result.unchanged).toContain('pipeline_definitions');
    expect(result.setAside).toEqual([aside]);
    expect(readdirSync(join(root, 'pipelines'))).toEqual([
      '.project-share-links.json',
    ]);
    expect(readFileSync(join(root, aside, 'beta.yaml'), 'utf8')).toBe(BETA);
  });

  it('sets the replays file aside within one folder, so its move is durable in one flush', async () => {
    seed();
    const records = await backupPipelineDefinitions(options());
    const replays = 'pipeline-definition-replays.json';
    write(replays, '{"version":1,"entries":[]}');
    const lost: string[] = [];
    const result = await restorePipelineDefinitionsBackup(
      records,
      options({
        ...CONFIRMED,
        syncDirectory: async (path) => {
          const answer = await strictFlush(path);
          if (
            path === root &&
            !readdirSync(root).some(
              (name) =>
                name === replays || name.startsWith(`${replays}.pre-restore-`),
            )
          )
            lost.push(path);
          return answer;
        },
      }),
    );
    expect(lost).toEqual([]);
    expect(result).toMatchObject({
      restored: ['pipeline_definition_replays'],
      setAside: [`${replays}.pre-restore-${String(now)}`],
    });
  });

  describe('a crash before any flush of a restore attempt', () => {
    const JOURNAL = 'backups/pipeline-definitions-1/restore-journal.json';
    /** A file's bytes, or a folder's names and contents. */
    const tree = (path: string): string =>
      statSync(path).isDirectory()
        ? JSON.stringify(
            readdirSync(path)
              .sort()
              .map((name) => [name, tree(join(path, name))]),
          )
        : readFileSync(path, 'base64');
    /** Every top-level entry of the family's rows, with its contents. */
    const entries = (at: string): [string, string][] =>
      PIPELINE_DEFINITIONS_BACKUP_MEMBERS.flatMap(
        (member): [string, string][] => {
          const path = join(at, member.path);
          if (!existsSync(path)) return [];
          if (member.kind === 'file') return [[member.path, tree(path)]];
          return readdirSync(path)
            .filter((name) => !member.exclude.includes(name))
            .map((name): [string, string] => [
              `${member.path}/${name}`,
              tree(join(path, name)),
            ]);
        },
      );
    /** Whether an entry is whole in its row or in one of its set-aside copies. */
    const kept = (at: string, [path, text]: [string, string]): boolean => {
      const [row = '', ...rest] = path.split('/');
      return [
        row,
        ...readdirSync(at).filter((name) =>
          name.startsWith(`${row}.pre-restore-`),
        ),
      ].some((place) => {
        const candidate = join(at, place, ...rest);
        return existsSync(candidate) && tree(candidate) === text;
      });
    };
    const journalText = (at: string): string | undefined =>
      existsSync(join(at, JOURNAL))
        ? readFileSync(join(at, JOURNAL), 'utf8')
        : undefined;
    const isJournal = (
      value: unknown,
    ): value is {
      readonly state: Record<string, { readonly moving?: unknown }>;
    } => typeof value === 'object' && value !== null && 'state' in value;
    /** The entry the visible journal names as moving into a row. */
    const moving = (at: string, row: string): unknown => {
      const text = journalText(at);
      const journal: unknown =
        text === undefined ? undefined : JSON.parse(text);
      return isJournal(journal) ? journal.state[row]?.moving : undefined;
    };
    /** A field of a row's entry in the journal in `at`. */
    const journaled = (at: string, row: string, field: string): unknown => {
      const text = journalText(at);
      const journal: unknown =
        text === undefined ? undefined : JSON.parse(text);
      return isJournal(journal)
        ? Reflect.get(journal.state[row] ?? {}, field)
        : undefined;
    };
    const listed = (value: unknown): unknown[] =>
      Array.isArray(value) ? value : [];
    const isNewer = (error: unknown): boolean =>
      error instanceof Error && 'code' in error && error.code === 'NEWER_STATE';
    const same = (path: string, at: string, relative: string): boolean =>
      existsSync(join(at, relative)) &&
      realpathSync(path) === realpathSync(join(at, relative));

    interface Scenario {
      readonly name: string;
      /** Changes to the seeded root before its backup, and after it. */
      readonly before?: () => void;
      readonly after?: () => void;
      /**
       * An earlier attempt, failed by one refused flush, or stopped by a crash
       * before one so the next attempt starts on what is durable.
       */
      readonly first?: {
        readonly confirmed: boolean;
        readonly refuse?: (at: string) => (path: string) => boolean;
        readonly crash?: (at: string) => (path: string) => boolean;
      };
      /** Entries the person writes before the attempt that crashes. */
      readonly between?: Readonly<Record<string, string>>;
      readonly confirmed: boolean;
      /**
       * Whether the retry may refuse newer state: never, or only while no
       * journal write of the crashed attempt is durable, so the newer state
       * it confirmed was never recorded.
       */
      readonly newer: 'never' | 'uncovered';
      /** The crash points to try, by the flushes before them; all by default. */
      readonly points?: (flushed: readonly string[], index: number) => boolean;
      /** A row whose journaled set-aside paths must survive and be reported. */
      readonly reported?: string;
      /** A row whose further set-aside copies may hold only duplicates. */
      readonly duplicates?: {
        readonly path: string;
        readonly namespaceId: string;
      };
    }

    const afterJournal = (flushed: readonly string[], index: number): boolean =>
      basename(flushed[index - 1] ?? '') === 'pipeline-definitions-1';
    const isRoot = (path: string): boolean =>
      /^pipeline-definitions-(crash|points)-/.test(basename(path));
    /** Before the flush of a row whose set-aside copy already holds `holds`. */
    const intoAside =
      (row: string, holds: string, left?: string) =>
      (at: string) =>
      (path: string): boolean =>
        same(path, at, row) &&
        readdirSync(at).some(
          (name) =>
            name.startsWith(`${row}.pre-restore-`) &&
            existsSync(join(at, name, holds)),
        ) &&
        (left === undefined || existsSync(join(at, row, left)));
    const dataBoth = {
      after: () => write('pipeline-data/beta/notes.json', '{"notes":1}'),
      first: { confirmed: true, crash: intoAside('pipeline-data', 'beta') },
      confirmed: false,
      newer: 'never',
    } as const;

    const pipelinesNewer = (): void => {
      write('pipelines/index.json', '{"version":1,"pipelines":[]}');
      write('pipelines/beta.yaml', BETA);
    };
    const movedIntoRow =
      (at: string) =>
      (path: string): boolean => {
        const name = moving(at, 'pipeline_definitions');
        return (
          same(path, at, 'pipelines') &&
          typeof name === 'string' &&
          readdirSync(join(at, 'pipelines')).includes(name)
        );
      };
    const scenarios: readonly Scenario[] = [
      {
        name: 'a restore into an empty root',
        after: () => {
          for (const member of PIPELINE_DEFINITIONS_BACKUP_MEMBERS)
            rmSync(join(root, member.path), { recursive: true, force: true });
        },
        confirmed: false,
        newer: 'never',
      },
      {
        name: 'a confirmed restore over newer contents in every row',
        after: () => {
          pipelinesNewer();
          write(
            'pipeline-definition-replays.json',
            '{"version":1,"entries":[]}',
          );
          write('pipeline-data/beta/notes.json', '{"notes":1}');
        },
        confirmed: true,
        newer: 'uncovered',
      },
      {
        name: 'C1: a retry after an entry moved from staging into the row and the row flush failed',
        after: pipelinesNewer,
        first: { confirmed: true, refuse: movedIntoRow },
        confirmed: false,
        newer: 'never',
      },
      {
        name: 'C2: a journal write after that move, before the row is flushed',
        after: pipelinesNewer,
        first: { confirmed: true, refuse: movedIntoRow },
        confirmed: false,
        newer: 'never',
        points: afterJournal,
      },
      {
        name: 'C4: a confirmed retry over a row changed since, with an entry half placed',
        after: pipelinesNewer,
        first: { confirmed: true, refuse: movedIntoRow },
        between: {
          'pipelines/gamma.yaml': 'name: Gamma\non: dispatch\njobs: {}\n',
        },
        confirmed: true,
        newer: 'uncovered',
      },
      {
        name: 'C4-0: a confirmed retry over a row changed since its set-aside flush failed',
        after: pipelinesNewer,
        first: {
          confirmed: true,
          refuse: (at) => (path) =>
            basename(path).startsWith('pipelines.pre-restore-') &&
            same(dirname(path), at, '.'),
        },
        between: {
          'pipelines/gamma.yaml': 'name: Gamma\non: dispatch\njobs: {}\n',
        },
        confirmed: true,
        newer: 'uncovered',
      },
      {
        name: 'C5: a retry after the file row moved in and the data root flush failed',
        after: () =>
          write(
            'pipeline-definition-replays.json',
            '{"version":1,"entries":[]}',
          ),
        first: {
          confirmed: true,
          refuse: (at) => (path) =>
            same(path, at, '.') &&
            moving(at, 'pipeline_definition_replays') === '',
        },
        confirmed: false,
        newer: 'never',
      },
      {
        name: 'C6: a retry that finds a row equal to its backup after its set-aside flush failed',
        before: () =>
          rmSync(join(root, 'pipeline-data'), { recursive: true, force: true }),
        after: () => write('pipeline-data/beta/notes.json', '{"notes":1}'),
        first: {
          confirmed: true,
          refuse: (at) => (path) =>
            basename(path).startsWith('pipeline-data.pre-restore-') &&
            same(dirname(path), at, '.'),
        },
        confirmed: false,
        newer: 'never',
      },
      {
        name: 'R-a: a resumed folder row whose set-aside folder entries are durable in the row and its copy alike',
        ...dataBoth,
      },
      {
        name: 'R-a2: a resumed row where some entries are in both and the rest only in the row',
        after: pipelinesNewer,
        first: {
          confirmed: true,
          crash: intoAside('pipelines', 'index.json', 'alpha.yaml'),
        },
        confirmed: false,
        newer: 'never',
        duplicates: { path: 'pipelines', namespaceId: 'pipeline_definitions' },
      },
      {
        name: 'R-b: a resumed row whose set-aside file entries are durable in both',
        after: pipelinesNewer,
        first: { confirmed: true, crash: intoAside('pipelines', 'zeta.yaml') },
        confirmed: false,
        newer: 'never',
      },
      {
        name: 'R-c: a crash after a further set-aside folder is made, before the journal names it',
        ...dataBoth,
        points: (flushed, index) =>
          basename(flushed[index] ?? '') === 'pipeline-definitions-1' &&
          isRoot(flushed[index - 1] ?? ''),
      },
      {
        name: 'R-d: a confirmed retry over a row changed since, with entries in both',
        ...dataBoth,
        between: { 'pipeline-data/gamma/notes.json': '{"notes":2}' },
        confirmed: true,
        newer: 'uncovered',
      },
      {
        name: 'R-d0: R-d before the further set-aside folder is first flushed',
        ...dataBoth,
        between: { 'pipeline-data/gamma/notes.json': '{"notes":2}' },
        confirmed: true,
        newer: 'uncovered',
        points: (flushed, index) =>
          !flushed
            .slice(0, index)
            .some((path) => /\.pre-restore-\d+-\d+$/.test(basename(path))),
      },
      {
        name: 'R-e: a crash just after the journal names a further set-aside folder still empty',
        ...dataBoth,
        points: afterJournal,
        reported: 'pipeline_data',
      },
      {
        name: 'R-f: a second retry after a crash in the retry that used a further set-aside folder',
        ...dataBoth,
        points: (flushed, index) =>
          flushed
            .slice(0, index)
            .some((path) => /\.pre-restore-\d+-\d+$/.test(basename(path))),
      },
    ];

    /**
     * Copies the root, runs the scenario's attempts on the copy, crashing the
     * last before flush `crash`, then retries on what the crash left and
     * checks the retry restores every row and keeps every entry the person
     * had. Without `crash` it only lists the attempt's flushes.
     */
    async function crashAt(
      scenario: Scenario,
      records: readonly NamespaceBackupRecord[],
      crash?: number,
    ): Promise<{
      readonly flushed: readonly string[];
      readonly failure?: string;
    }> {
      const at = mkdtempSync(join(tmpdir(), 'pipeline-definitions-points-'));
      const scratch = [at];
      try {
        cpSync(root, at, { recursive: true });
        const people = entries(at);
        let work = at;
        let fs = crashFs(at, strictFlush);
        const attempt = (
          dataRoot: string,
          confirmed: boolean,
          syncDirectory: FamilyOptions['syncDirectory'] = fs.syncDirectory,
        ): ReturnType<typeof restorePipelineDefinitionsBackup> =>
          restorePipelineDefinitionsBackup(
            records,
            options({
              dataRoot,
              syncDirectory,
              ...(confirmed ? CONFIRMED : {}),
            }),
          );
        const { first } = scenario;
        if (first?.refuse !== undefined) {
          fs.refuseOnce(first.refuse(at));
          expect(
            await thrown(() => attempt(at, first.confirmed)),
          ).toMatchObject({ code: 'BACKUP_UNVERIFIED' });
        }
        if (first?.crash !== undefined) {
          fs.crashOnce(first.crash(at));
          expect(
            await thrown(() => attempt(at, first.confirmed)),
          ).toBeInstanceOf(Crash);
          work = fs.durableImage();
          scratch.push(work);
          fs = crashFs(work, strictFlush);
        }
        // The person's own writes are durable before the next attempt starts.
        for (const [path, text] of Object.entries(scenario.between ?? {})) {
          write(path, text, work);
          fs.settle(join(work, path));
          people.push([path, tree(join(work, path))]);
        }
        const journalBefore = journalText(work);
        fs.crashBefore(crash);
        const crashed = await attempt(work, scenario.confirmed).then(
          () => false,
          (error: unknown) => {
            if (error instanceof Crash) return true;
            throw error;
          },
        );
        const flushed = [...fs.flushed];
        if (!crashed) return { flushed };
        const durable = fs.durableImage();
        scratch.push(durable);
        const named = (
          scenario.reported === undefined
            ? []
            : listed(journaled(durable, scenario.reported, 'asides'))
        ).filter(
          (aside): aside is string =>
            typeof aside === 'string' && existsSync(join(durable, aside)),
        );
        const asidesOf = (row: string): string[] =>
          readdirSync(durable)
            .filter((name) => name.startsWith(`${row}.pre-restore-`))
            .sort();
        // The entries the retry finds whole in the row and its set-aside copy
        // alike: not yet placed, in a row the journal has in progress.
        const dup = scenario.duplicates;
        const [firstAside = ''] = dup === undefined ? [] : asidesOf(dup.path);
        const placedBefore =
          dup === undefined
            ? []
            : listed(journaled(durable, dup.namespaceId, 'placed'));
        const both =
          dup === undefined ||
          firstAside === '' ||
          journaled(durable, dup.namespaceId, 'status') !== 'in_progress'
            ? []
            : readdirSync(join(durable, dup.path)).filter(
                (name) =>
                  !placedBefore.includes(name) &&
                  existsSync(join(durable, firstAside, name)) &&
                  tree(join(durable, firstAside, name)) ===
                    tree(join(durable, dup.path, name)),
              );
        let reported: readonly string[] = [];
        const retry = (confirmed: boolean): Promise<unknown> =>
          attempt(durable, confirmed, strictFlush).then(
            (result) => {
              reported = result.setAside;
              return undefined;
            },
            (error: unknown) => error,
          );
        let error = await retry(false);
        if (
          isNewer(error) &&
          scenario.newer === 'uncovered' &&
          journalText(durable) === journalBefore
        )
          error = await retry(true);
        const point = `crash before flush ${String(crash)} (${basename(flushed[flushed.length - 1] ?? '')} last)`;
        if (error !== undefined)
          return {
            flushed,
            failure: `${point}: the retry threw ${error instanceof Error ? String(error) : JSON.stringify(error)}`,
          };
        const unreported = named.filter(
          (aside) =>
            !existsSync(join(durable, aside)) || !reported.includes(aside),
        );
        if (unreported.length > 0)
          return {
            flushed,
            failure: `${point}: journaled set-aside paths gone or unreported: ${unreported.join(', ')}`,
          };
        if (dup !== undefined) {
          const row = dup.path;
          const [first = '', ...further] = asidesOf(row);
          const extra = further.flatMap((aside) =>
            readdirSync(join(durable, aside)).map(
              (name) => [aside, name] as const,
            ),
          );
          const wrong = [
            ...extra
              .filter(
                ([aside, name]) =>
                  !existsSync(join(durable, first, name)) ||
                  tree(join(durable, aside, name)) !==
                    tree(join(durable, first, name)),
              )
              .map(([aside, name]) => `${aside}/${name} is no duplicate`),
            ...both
              .filter((name) => !extra.some(([, held]) => held === name))
              .map(
                (name) => `${name} was in both but no further copy holds it`,
              ),
            ...people
              .filter(([path]) => path.startsWith(`${row}/`))
              .filter(([path, text]) => {
                const inFirst = join(
                  durable,
                  first,
                  path.slice(row.length + 1),
                );
                return !existsSync(inFirst) || tree(inFirst) !== text;
              })
              .map(([path]) => `${path} is not in ${first}`),
          ];
          if (wrong.length > 0)
            return { flushed, failure: `${point}: ${wrong.join('; ')}` };
        }
        const again = await attempt(durable, false, strictFlush);
        const lost = people
          .filter((entry) => !kept(durable, entry))
          .map(([path]) => path);
        return again.restored.length > 0 || lost.length > 0
          ? {
              flushed,
              failure: `${point}: restored again ${again.restored.join(', ')}; lost ${lost.join(', ')}`,
            }
          : { flushed };
      } finally {
        for (const path of scratch)
          rmSync(path, { recursive: true, force: true });
      }
    }

    it.each(scenarios)(
      '$name: the retry restores every row and keeps every entry',
      async (scenario) => {
        seed();
        scenario.before?.();
        const records = await backupPipelineDefinitions(options());
        scenario.after?.();
        const { flushed } = await crashAt(scenario, records);
        const points = flushed
          .map((_, index) => index)
          .filter((index) => scenario.points?.(flushed, index) ?? true);
        expect(points.length).toBeGreaterThan(0);
        const failures: string[] = [];
        for (const point of points) {
          const { failure } = await crashAt(scenario, records, point);
          if (failure !== undefined) failures.push(failure);
        }
        expect(failures).toEqual([]);
      },
      CRASH_POINTS_TIMEOUT_MS,
    );
  });
});
