import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { parsePipelineText } from '@canopy/pipeline-interop';

import { CanopyOperationError } from '../../../runtime/errors';
import type { NamespaceBackupRecord } from '../../../storage/backup-record';
import {
  backupRecordReference,
  decideRowWrite,
  parseOwnerFlipRecord,
  StorageRowOwnerError,
  type OwnerFlipRecordRead,
} from '../../../storage/owner-records';
import { STORAGE_OWNERSHIP } from '../../../storage/storage-ownership.generated';
import type {
  StorageOwnershipRow,
  StorageTransitionOwner,
  StorageWriterPrincipal,
} from '../../../storage/writer-authority';
import {
  assertRowWritable,
  OwnerRecordWriteError,
  ownerFlipRecordFile,
  type OwnerRecordWriteOptions,
  persistNamespaceBackupRecord,
  readOwnerFlipRecord,
  writeOwnerFlipRecord,
} from '../../storage-records';
import { createDaemonDefinitionReceipts } from '../daemon-definitions';
import { createPipelineDefinitionService } from '../definitions';
import { createPipelineDefinitionReplayStore } from '../replay-store';
import { createDaemonPipelineDefinitionStoreEnvironment } from '../store/daemon-environment';
import {
  createStoredPipelineDefinitionPort,
  createStoredPipelineDefinitionWriter,
} from '../store/definition-sources';
import {
  createPipelineDefinitionStore,
  type PipelineDefinitionStore,
} from '../store/definitions-store';

const DIGEST = 'a'.repeat(64);
const TEXT =
  'name: Alpha\non: dispatch\njobs:\n  run:\n    steps:\n      - run: echo alpha\n';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'owner-records-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeRecord(
  namespaceId: string,
  toOwner: StorageTransitionOwner,
  fromOwner: StorageTransitionOwner = toOwner === 'daemon'
    ? 'legacy'
    : 'daemon',
): void {
  const file = ownerFlipRecordFile(root, namespaceId);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      namespaceId,
      fromOwner,
      toOwner,
      workPackage: 'W6',
      backupRecord: backupRecordReference(namespaceId, DIGEST),
      flippedAt: '2026-11-24T10:00:00.000Z',
    }),
  );
}

/** Every file under the root but the owner records, by path and digest. */
function tree(): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (folder: string): void => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      if (relative(root, path) === 'storage-records') continue;
      if (statSync(path).isDirectory()) walk(path);
      else
        files[relative(root, path)] = createHash('sha256')
          .update(readFileSync(path))
          .digest('hex');
    }
  };
  if (existsSync(root)) walk(root);
  return files;
}

/** A definitions store over `root` that writes as `writer`. */
function store(writer: StorageWriterPrincipal): PipelineDefinitionStore {
  const env = createDaemonPipelineDefinitionStoreEnvironment({
    dataRoot: root,
    bundledPipelinesDir: join(root, 'bundled'),
    lock: {
      ensurePrivateLockDirectorySync: () => undefined,
      withOwnerLockFileSync: (_path, operation) => operation(),
    },
    flushDirectorySync: () => undefined,
  });
  return createPipelineDefinitionStore({
    ...env,
    // The writes themselves, without admission: the ownership table names
    // no daemon writer yet, and these tests are about the owner record.
    installUserFile: (fileName, data) => {
      mkdirSync(join(root, 'pipelines'), { recursive: true });
      writeFileSync(join(root, 'pipelines', fileName), data);
    },
    defaultWriter: () => writer,
  });
}

function save(
  definitions: PipelineDefinitionStore,
  name = 'Alpha',
): ReturnType<PipelineDefinitionStore['writeStoredPipeline']> {
  return definitions.writeStoredPipeline(
    {
      name,
      description: '',
      icon: '',
      content: parsePipelineText(TEXT),
      rawContent: TEXT,
    },
    { createId: `id-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` },
  );
}

async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected a rejection');
}

describe('pipeline store owner records and older-writer refusal (CAN-7690)', () => {
  it('lets only the owner a record names write, and fails closed on an unreadable one', () => {
    const record = (toOwner: StorageTransitionOwner): OwnerFlipRecordRead =>
      parseOwnerFlipRecord(
        JSON.stringify({
          namespaceId: 'pipeline_definitions',
          fromOwner: toOwner === 'daemon' ? 'legacy' : 'daemon',
          toOwner,
          workPackage: 'W6',
          backupRecord: backupRecordReference('pipeline_definitions', DIGEST),
          flippedAt: '2026-11-24T10:00:00.000Z',
        }),
        'pipeline_definitions',
      );
    const writers: StorageWriterPrincipal[] = [
      'electron_main',
      'desktop_cli',
      'daemon',
    ];
    const allowed = (read: OwnerFlipRecordRead): boolean[] =>
      writers.map((writer) => decideRowWrite(read, writer).allowed);
    expect(allowed({ kind: 'absent' })).toEqual([true, true, true]);
    expect(allowed(record('daemon'))).toEqual([false, false, true]);
    expect(allowed(record('legacy'))).toEqual([true, true, false]);
    expect(decideRowWrite(record('daemon'), 'electron_main')).toMatchObject({
      reason: 'owned_elsewhere',
      owner: 'daemon',
    });
    for (const text of [
      'not json',
      '{}',
      JSON.stringify({ namespaceId: 'pipeline_data' }),
      JSON.stringify({
        namespaceId: 'pipeline_definitions',
        fromOwner: 'daemon',
        toOwner: 'daemon',
        workPackage: 'W6',
        backupRecord: backupRecordReference('pipeline_definitions', DIGEST),
        flippedAt: '2026-11-24T10:00:00.000Z',
      }),
    ]) {
      const read = parseOwnerFlipRecord(text, 'pipeline_definitions');
      expect(read.kind).toBe('unreadable');
      expect(allowed(read)).toEqual([false, false, false]);
    }
  });

  it('reads a missing record as absent and a record it cannot read as unreadable', async () => {
    expect(await readOwnerFlipRecord(root, 'pipeline_definitions')).toEqual({
      kind: 'absent',
    });
    mkdirSync(ownerFlipRecordFile(root, 'pipeline_definitions'), {
      recursive: true,
    });
    expect(
      await readOwnerFlipRecord(root, 'pipeline_definitions'),
    ).toMatchObject({ kind: 'unreadable' });
    await expect(
      assertRowWritable(root, 'pipeline_definitions', 'electron_main'),
    ).rejects.toBeInstanceOf(StorageRowOwnerError);
  });

  it('refuses every definitions write path of a writer the record does not name, changing no byte, the daemon included', () => {
    const app = store('electron_main');
    const created = save(app);
    expect(created.ok).toBe(true);
    const daemon = store('daemon');
    for (const [owner, refusedStore, allowedStore] of [
      ['daemon', app, daemon],
      ['legacy', daemon, app],
    ] as const) {
      writeRecord('pipeline_definitions', owner);
      const before = tree();
      const results = [
        save(refusedStore, 'Beta'),
        refusedStore.writeStoredPipeline(
          {
            id: 'id-alpha',
            name: 'Alpha renamed',
            description: '',
            icon: '',
            content: parsePipelineText(TEXT),
            rawContent: TEXT,
          },
          { requireExisting: true, expectedRevision: null },
        ),
        refusedStore.removeStoredPipeline('id-alpha', {
          expectedRevision: null,
        }),
        refusedStore.reconcileStoredPipelineIndex(),
        refusedStore.removeUnlistedStoredPipelineDocument('id-alpha', DIGEST),
      ];
      for (const result of results)
        expect(result).toMatchObject({
          ok: false,
          reason: 'owner_moved',
          owner,
        });
      expect(
        refusedStore.writeStoredPipelineRemoteMetadata('id-alpha', {
          remoteId: 'remote-1',
          contentHash: DIGEST,
          shareScope: 'organization',
          sharedAt: '2026-11-24T10:00:00.000Z',
        }).success,
      ).toBe(false);
      expect(tree()).toEqual(before);
      expect(save(allowedStore, `Gamma ${owner}`).ok).toBe(true);
    }
  });

  it('fails closed for every writer when the definitions record cannot be read', () => {
    const app = store('electron_main');
    expect(save(app).ok).toBe(true);
    const file = ownerFlipRecordFile(root, 'pipeline_definitions');
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, '{"namespaceId": "pipeline_definitions"');
    const before = tree();
    for (const writer of ['electron_main', 'desktop_cli', 'daemon'] as const) {
      const result = save(store(writer), `Beta ${writer}`);
      expect(result).toMatchObject({ ok: false, reason: 'owner_moved' });
      expect(JSON.stringify(result)).toContain('can’t be read');
    }
    expect(tree()).toEqual(before);
  });

  it('answers a refused upsert and copy with targetUnavailable, never retried, naming the owner that keeps the store', async () => {
    const app = store('electron_main');
    const writer = createStoredPipelineDefinitionWriter(app);
    const service = createPipelineDefinitionService({
      ports: [createStoredPipelineDefinitionPort(app)],
      writer,
    });
    writeRecord('pipeline_definitions', 'daemon');
    const error = await rejection(() =>
      service.upsert(
        {
          definitionId: null,
          expectedRevision: null,
          scope: {},
          source: 'user',
          name: 'Alpha',
          format: 'yaml',
          document: TEXT,
        },
        new AbortController().signal,
      ),
    );
    expect(error).toBeInstanceOf(CanopyOperationError);
    expect(error).toMatchObject({
      payload: {
        kind: 'capability_unavailable',
        code: 'core.pipeline.targetUnavailable',
        retry: { kind: 'never' },
        details: { namespaceId: 'pipeline_definitions', owner: 'daemon' },
      },
    });
    expect(
      await rejection(() =>
        writer.copy(
          {
            definitionId: 'id-copy',
            origin: { source: 'user', definitionId: 'id-alpha' },
            name: 'Copy',
            description: '',
            icon: '',
            text: TEXT,
            pipeline: parsePipelineText(TEXT),
          },
          { scope: {}, signal: new AbortController().signal },
        ),
      ),
    ).toMatchObject({
      code: 'core.pipeline.targetUnavailable',
      details: { owner: 'daemon' },
    });
    expect(tree()).toEqual({});
  });

  it('refuses receipt writes and the rename-aside of an unreadable ledger for a writer the record does not name, the daemon included', async () => {
    const file = join(root, 'pipeline-definition-replays.json');
    const writes: string[] = [];
    const app = createPipelineDefinitionReplayStore({
      filePath: () => file,
      write: (target, contents) => {
        writes.push(target);
        writeFileSync(target, contents);
        return Promise.resolve();
      },
      assertWritable: () =>
        assertRowWritable(root, 'pipeline_definition_replays', 'electron_main'),
    });
    const daemon = createDaemonDefinitionReceipts({
      dataRoot: root,
      flushDirectory: () => Promise.resolve(),
    });
    const ledger = { entries: [], expired: [] };
    writeRecord('pipeline_definition_replays', 'daemon');
    await expect(app.save(ledger)).rejects.toBeInstanceOf(StorageRowOwnerError);
    expect(writes).toEqual([]);
    writeFileSync(file, 'not a ledger');
    await expect(app.load()).rejects.toBeInstanceOf(StorageRowOwnerError);
    expect(readFileSync(file, 'utf8')).toBe('not a ledger');
    expect(existsSync(`${file}.unreadable`)).toBe(false);
    rmSync(file);
    await daemon.save(ledger);
    expect(existsSync(file)).toBe(true);
    writeRecord('pipeline_definition_replays', 'legacy');
    const written = readFileSync(file, 'utf8');
    await expect(
      daemon.save({
        entries: [],
        expired: [
          { operation: 'core.pipeline.definition.upsert', key: DIGEST },
        ],
      }),
    ).rejects.toMatchObject({ reason: 'owned_elsewhere', owner: 'legacy' });
    expect(readFileSync(file, 'utf8')).toBe(written);
    await app.save(ledger);
    expect(writes).toEqual([file]);
  });

  it('writes an owner record only over a verified, persisted backup record it cites', async () => {
    const rows: readonly StorageOwnershipRow[] = STORAGE_OWNERSHIP.map((row) =>
      row.id === 'pipeline_definitions'
        ? {
            ...row,
            backupPolicy: 'required_before_flip',
            backupShape: 'namespace_backup',
            workPackage: 'W6',
          }
        : row,
    );
    const ports = {
      syncDirectory: (): Promise<'flushed'> => Promise.resolve('flushed'),
      isOutsideCheckouts: (): boolean => true,
      ownership: rows,
    };
    const input = {
      namespaceId: 'pipeline_definitions',
      fromOwner: 'legacy',
      toOwner: 'daemon',
      workPackage: 'W6',
      backupDigest: DIGEST,
      flippedAt: '2026-11-24T10:00:00.000Z',
    } as const;
    expect(
      await rejection(() => writeOwnerFlipRecord(root, input, ports)),
    ).toMatchObject({ code: 'BACKUP_RECORD_MISSING' });
    expect(existsSync(join(root, 'storage-records'))).toBe(false);
    const backup: NamespaceBackupRecord = {
      namespaceId: 'pipeline_definitions',
      backupPath: 'backups/pipeline-definitions-1/pipeline_definitions',
      sourceRevision: `sha256:${DIGEST}`,
      schemaVersion: 'none',
      createdAt: '2026-11-24T09:00:00.000Z',
      verifiedBy: { algorithm: 'sha256', digest: DIGEST },
      rollbackMigration: 'restorePipelineDefinitionsBackup',
      restoreTestedAt: '2026-11-24T09:00:01.000Z',
    };
    await persistNamespaceBackupRecord(root, backup, ports);
    const other = await rejection(() =>
      writeOwnerFlipRecord(
        root,
        { ...input, backupDigest: 'b'.repeat(64) },
        ports,
      ),
    );
    expect(other).toBeInstanceOf(OwnerRecordWriteError);
    expect(other).toMatchObject({ code: 'BACKUP_RECORD_INVALID' });
    expect(existsSync(ownerFlipRecordFile(root, 'pipeline_definitions'))).toBe(
      false,
    );
    const record = await writeOwnerFlipRecord(root, input, ports);
    expect(record).toMatchObject({
      toOwner: 'daemon',
      backupRecord:
        'storage-records/pipeline_definitions/namespace-backup.json#sha256:' +
        DIGEST,
    });
    expect(await readOwnerFlipRecord(root, 'pipeline_definitions')).toEqual({
      kind: 'record',
      record,
    });
    await expect(
      assertRowWritable(root, 'pipeline_definitions', 'electron_main'),
    ).rejects.toMatchObject({ owner: 'daemon' });
    await expect(
      assertRowWritable(root, 'pipeline_definitions', 'daemon'),
    ).resolves.toBeUndefined();
  });

  it('flushes every folder the record writers create, up to the data root', async () => {
    const rows: readonly StorageOwnershipRow[] = STORAGE_OWNERSHIP.map((row) =>
      row.id === 'pipeline_definitions'
        ? {
            ...row,
            backupPolicy: 'required_before_flip',
            backupShape: 'namespace_backup',
            workPackage: 'W6',
          }
        : row,
    );
    const flushed: string[] = [];
    const ports = {
      syncDirectory: (path: string): Promise<'flushed'> => {
        flushed.push(relative(root, path));
        return Promise.resolve('flushed');
      },
      isOutsideCheckouts: (): boolean => true,
      ownership: rows,
    };
    expect(existsSync(join(root, 'storage-records'))).toBe(false);
    await persistNamespaceBackupRecord(
      root,
      {
        namespaceId: 'pipeline_definitions',
        backupPath: 'backups/pipeline-definitions-1/pipeline_definitions',
        sourceRevision: `sha256:${DIGEST}`,
        schemaVersion: 'none',
        createdAt: '2026-11-24T09:00:00.000Z',
        verifiedBy: { algorithm: 'sha256', digest: DIGEST },
        rollbackMigration: 'restorePipelineDefinitionsBackup',
        restoreTestedAt: '2026-11-24T09:00:01.000Z',
      },
      ports,
    );
    // Each new folder's entry is in its parent: the data root holds storage-records.
    expect(flushed).toEqual([
      join('storage-records', 'pipeline_definitions'),
      'storage-records',
      '',
    ]);
  });

  it('flushes every folder up to the data root again on a retry after a failed flush, and on every later record', async () => {
    const rows: readonly StorageOwnershipRow[] = STORAGE_OWNERSHIP.map((row) =>
      row.id === 'pipeline_definitions'
        ? {
            ...row,
            backupPolicy: 'required_before_flip',
            backupShape: 'namespace_backup',
            workPackage: 'W6',
          }
        : row,
    );
    const backup: NamespaceBackupRecord = {
      namespaceId: 'pipeline_definitions',
      backupPath: 'backups/pipeline-definitions-1/pipeline_definitions',
      sourceRevision: `sha256:${DIGEST}`,
      schemaVersion: 'none',
      createdAt: '2026-11-24T09:00:00.000Z',
      verifiedBy: { algorithm: 'sha256', digest: DIGEST },
      rollbackMigration: 'restorePipelineDefinitionsBackup',
      restoreTestedAt: '2026-11-24T09:00:01.000Z',
    };
    let failRootFlush = true;
    const flushed: string[] = [];
    const ports = {
      syncDirectory: (path: string): Promise<'flushed'> => {
        const at = relative(root, path);
        if (at === '' && failRootFlush) {
          failRootFlush = false;
          return Promise.reject(new Error('flush failed'));
        }
        flushed.push(at);
        return Promise.resolve('flushed');
      },
      isOutsideCheckouts: (): boolean => true,
      ownership: rows,
    };
    await expect(
      persistNamespaceBackupRecord(root, backup, ports),
    ).rejects.toThrow('flush failed');
    const chain = [
      join('storage-records', 'pipeline_definitions'),
      'storage-records',
      '',
    ];
    flushed.length = 0;
    await persistNamespaceBackupRecord(root, backup, ports);
    expect(flushed).toEqual(chain);
    flushed.length = 0;
    await writeOwnerFlipRecord(
      root,
      {
        namespaceId: 'pipeline_definitions',
        fromOwner: 'legacy',
        toOwner: 'daemon',
        workPackage: 'W6',
        backupDigest: DIGEST,
        flippedAt: '2026-11-24T10:00:00.000Z',
      },
      ports,
    );
    expect(flushed).toEqual(chain);
  });

  describe('a record the host cannot confirm it saved', () => {
    const rows: readonly StorageOwnershipRow[] = STORAGE_OWNERSHIP.map((row) =>
      row.id === 'pipeline_definitions'
        ? {
            ...row,
            backupPolicy: 'required_before_flip',
            backupShape: 'namespace_backup',
            workPackage: 'W6',
          }
        : row,
    );
    const ports = (unconfirmed?: string): OwnerRecordWriteOptions => ({
      syncDirectory: (path) =>
        Promise.resolve(
          relative(root, path) === unconfirmed ? 'unsupported' : 'flushed',
        ),
      isOutsideCheckouts: () => true,
      ownership: rows,
    });
    const backup = (unconfirmed?: string): Promise<void> =>
      persistNamespaceBackupRecord(
        root,
        {
          namespaceId: 'pipeline_definitions',
          backupPath: 'backups/pipeline-definitions-1/pipeline_definitions',
          sourceRevision: `sha256:${DIGEST}`,
          schemaVersion: 'none',
          createdAt: '2026-11-24T09:00:00.000Z',
          verifiedBy: { algorithm: 'sha256', digest: DIGEST },
          rollbackMigration: 'restorePipelineDefinitionsBackup',
          restoreTestedAt: '2026-11-24T09:00:01.000Z',
        },
        ports(unconfirmed),
      );
    const flip = (unconfirmed: string): Promise<unknown> =>
      writeOwnerFlipRecord(
        root,
        {
          namespaceId: 'pipeline_definitions',
          fromOwner: 'legacy',
          toOwner: 'daemon',
          workPackage: 'W6',
          backupDigest: DIGEST,
          flippedAt: '2026-11-24T10:00:00.000Z',
        },
        ports(unconfirmed),
      );

    it.each([join('storage-records', 'pipeline_definitions'), ''])(
      'refuses a backup record when the flush of %j is unconfirmed',
      async (at) => {
        expect(await rejection(() => backup(at))).toMatchObject({
          code: 'FLUSH_UNCONFIRMED',
        });
      },
    );

    it('refuses an owner record when a flush is unconfirmed', async () => {
      await backup();
      expect(await rejection(() => flip('storage-records'))).toMatchObject({
        code: 'FLUSH_UNCONFIRMED',
      });
    });

    it('leaves no temporary file when the record cannot be synced', async () => {
      const probe = await open(join(root, 'probe'), 'w');
      const prototype = Reflect.getPrototypeOf(probe);
      await probe.close();
      if (!isFileHandle(prototype)) throw new Error('no FileHandle prototype');
      const sync = jest.spyOn(prototype, 'sync');
      sync.mockRejectedValueOnce(new Error('sync failed'));
      await expect(backup()).rejects.toThrow('sync failed');
      sync.mockRestore();
      const folder = join(root, 'storage-records', 'pipeline_definitions');
      expect(readdirSync(folder)).toEqual([]);
    });
  });
});

function isFileHandle(value: unknown): value is FileHandle {
  return typeof value === 'object' && value !== null && 'sync' in value;
}
