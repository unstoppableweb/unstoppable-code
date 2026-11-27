import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  IN_PROCESS_LEASE_TERMS,
  IN_PROCESS_WORKER_TARGET,
} from '@canopy/protocol/canopy-core';
import {
  validateNamespaceBackupRecord,
  type NamespaceBackupRecord,
} from '../../../storage/backup-record';
import { STORAGE_OWNERSHIP } from '../../../storage/storage-ownership.generated';
import {
  OPERATION_LEDGER_SCHEMA_VERSION,
  OperationLedger,
  OperationLedgerError,
  backupOperationLedger,
  restoreOperationLedgerBackup,
  returnOperationLedger,
  type OperationAcceptRequest,
  type OperationLedgerBackupOptions,
} from '../ledger';
import { createDaemonOperationService } from '../daemon-ledger';
import {
  assertRowWritable,
  persistNamespaceBackupRecord,
  readOwnerFlipRecord,
  writeOwnerFlipRecord,
} from '../../storage-records';
import {
  Crash,
  crashFs,
} from '../../pipeline/__tests__/definitions-backup-crash-fs';
import { strictFlush } from '../../pipeline/__tests__/definitions-backup-fixtures';

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected an error');
}
function request(
  overrides: Partial<OperationAcceptRequest> = {},
): OperationAcceptRequest {
  return {
    kind: 'core.pipeline.run',
    origin: { kind: 'client', sourceId: 'desktop-window-1' },
    owner: { kind: 'principal', id: 'local-user' },
    scope: { workspaceId: 'alpha', worktreeId: 'main' },
    ...overrides,
  };
}
const keyed = {
  caller: 'local-user',
  idempotencyKey: 'run-1',
  fingerprint: 'params-a',
};
let dir: string;
let dbPath: string;
let now: number;
let ledger: OperationLedger;
function open(): OperationLedger {
  return OperationLedger.open(dbPath, { clock: () => now });
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'operation-ledger-qualification-'));
  dbPath = join(dir, 'operations', 'operation-ledger.sqlite');
  now = Date.parse('2026-10-27T10:00:00.000Z');
  ledger = open();
});
afterEach(() => {
  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('operation ledger persistence qualification', () => {
  const outside = (): boolean => true;
  const synced: string[] = [];
  const backup = (
    options: Omit<OperationLedgerBackupOptions, 'syncDirectory'>,
  ): Promise<NamespaceBackupRecord> =>
    backupOperationLedger(ledger, {
      ...options,
      syncDirectory: (path): Promise<'flushed'> => {
        synced.push(path);
        return Promise.resolve('flushed');
      },
    });
  it('admits one writer at a time', () => {
    const error = thrown(() =>
      OperationLedger.open(dbPath, { openBusyTimeoutMs: 0 }),
    );
    expect(error).toBeInstanceOf(OperationLedgerError);
    expect(error).toMatchObject({ code: 'WRITER_UNAVAILABLE' });
  });

  it('never opens a newer schema', () => {
    ledger.close();
    const db = new DatabaseSync(dbPath);
    db.prepare(
      `UPDATE operation_meta SET value = ? WHERE key = 'schema_version'`,
    ).run(String(OPERATION_LEDGER_SCHEMA_VERSION + 1));
    db.close();
    expect(thrown(() => open())).toMatchObject({ code: 'UNSUPPORTED_SCHEMA' });
    ledger = OperationLedger.open(join(dir, 'other.sqlite'));
  });

  it('fails to open a damaged ledger file and leaves it unchanged', () => {
    ledger.close();
    const bytes = Buffer.alloc(4096, 0x5a);
    writeFileSync(dbPath, bytes);
    expect(() => open()).toThrow();
    expect(readFileSync(dbPath)).toEqual(bytes);
    ledger = OperationLedger.open(join(dir, 'other.sqlite'));
  });

  it('upgrades a version 1 ledger in place, keeping its records', () => {
    const kept = ledger.accept(request({ receipt: keyed })).operation;
    const ledgerId = ledger.ledgerId;
    ledger.close();
    const db = new DatabaseSync(dbPath);
    for (const table of [
      'initiated_work_heads',
      'delegations',
      'delegation_leases',
      'execution_targets',
    ])
      db.exec(`DROP TABLE ${table}`);
    db.prepare(
      `UPDATE operation_meta SET value = '1' WHERE key = 'schema_version'`,
    ).run();
    db.close();
    ledger = open();
    expect(ledger.ledgerId).toBe(ledgerId);
    expect(ledger.get(kept.operationId)).toEqual(kept);
    expect(ledger.registerTarget(IN_PROCESS_WORKER_TARGET)).toMatchObject(
      IN_PROCESS_WORKER_TARGET,
    );
  });

  it('upgrades a version 2 ledger in place and records source heads', () => {
    const kept = ledger.accept(request({ receipt: keyed })).operation;
    ledger.close();
    const db = new DatabaseSync(dbPath);
    db.exec('DROP TABLE initiated_work_heads');
    db.prepare(
      `UPDATE operation_meta SET value = '2' WHERE key = 'schema_version'`,
    ).run();
    db.close();
    ledger = open();
    expect(ledger.get(kept.operationId)).toEqual(kept);
    expect(ledger.sourceHead('github.pr', 'subject-1')).toBeNull();
    ledger.recordSourceHead('github.pr', 'subject-1', 'head-1');
    ledger.recordSourceHead('github.pr', 'subject-1', 'head-2');
    expect(ledger.sourceHead('github.pr', 'subject-1')).toBe('head-2');
    expect(ledger.sourceHead('github.pr', 'subject-2')).toBeNull();
  });

  it('keeps delegation lease rows readable across schema-3 builds', () => {
    ledger.registerTarget(IN_PROCESS_WORKER_TARGET);
    const held = ledger.acquireLease(
      IN_PROCESS_WORKER_TARGET.targetId,
      IN_PROCESS_LEASE_TERMS,
    );
    ledger.close();
    const db = new DatabaseSync(dbPath);
    const stored = db
      .prepare('SELECT record_json FROM delegation_leases WHERE lease_id = ?')
      .get(held.leaseId)?.record_json;
    db.close();
    // A build from before the remote executor fields parses this row with a
    // strict schema, so a run's lease writes exactly the keys it always has.
    const row: unknown = JSON.parse(String(stored));
    expect(Object.keys(row ?? {}).sort()).toEqual([
      'acquiredAt',
      'binding',
      'expiresAt',
      'leaseId',
      'releaseReason',
      'releasedAt',
      'renewAfterMs',
      'runEpoch',
      'signal',
      'targetId',
      'ttlMs',
    ]);
    ledger = open();
    ledger.acquireLease(
      IN_PROCESS_WORKER_TARGET.targetId,
      IN_PROCESS_LEASE_TERMS,
    );
    expect(ledger.getLease(held.leaseId)).toEqual({
      ...held,
      releasedAt: new Date(now).toISOString(),
      releaseReason: 'process-ended',
    });
  });

  it('commits writes made atomically together, or none of them', () => {
    expect(() =>
      ledger.atomically(() => {
        ledger.recordSourceHead('github.pr', 'subject-1', 'head-1');
        ledger.accept(request());
        throw new Error('later write failed');
      }),
    ).toThrow('later write failed');
    expect(ledger.sourceHead('github.pr', 'subject-1')).toBeNull();
    expect(ledger.list({ limit: 10 }).items).toHaveLength(0);
  });

  it('issues a verified, restore-tested namespace_backup record and restores from it', async () => {
    const kept = ledger.accept(request({ receipt: keyed })).operation;
    const target = ledger.registerTarget(IN_PROCESS_WORKER_TARGET);
    const record = await backup({
      dataRoot: dir,
      backupPath: 'backups/operation-ledger-1.sqlite',
      isOutsideCheckouts: outside,
      clock: () => now,
    });
    expect(
      validateNamespaceBackupRecord(record, {
        rows: STORAGE_OWNERSHIP,
        isOutsideCheckouts: outside,
      }).ok,
    ).toBe(true);
    expect(record).toMatchObject({
      namespaceId: 'operation_ledger',
      schemaVersion: OPERATION_LEDGER_SCHEMA_VERSION,
      sourceRevision: `${ledger.ledgerId}:1`,
      verifiedBy: { algorithm: 'sha256' },
      rollbackMigration: 'restoreOperationLedgerBackup',
    });
    expect(synced).toContain(join(realpathSync(dir), 'backups'));
    const later = ledger.accept(request()).operation;
    ledger.close();
    restoreOperationLedgerBackup(record, {
      dataRoot: dir,
      databasePath: dbPath,
      isOutsideCheckouts: outside,
    });
    ledger = open();
    expect(ledger.get(kept.operationId)).toEqual(kept);
    expect(ledger.get(later.operationId)).toBeNull();
    expect(ledger.getTarget(target.targetId)).toEqual(target);
  });

  it('restores in place on the writer connection, never swapping the database file', async () => {
    const kept = ledger.accept(request()).operation;
    ledger.recordSourceHead('github.pr', 'subject-1', 'head-1');
    const record = await backup({
      dataRoot: dir,
      backupPath: 'backups/operation-ledger-in-place.sqlite',
      isOutsideCheckouts: outside,
    });
    ledger.accept(request());
    ledger.recordSourceHead('github.pr', 'subject-1', 'head-2');
    ledger.recordSourceHead('github.pr', 'subject-2', 'head-3');
    ledger.close();
    const before = statSync(dbPath).ino;
    restoreOperationLedgerBackup(record, {
      dataRoot: dir,
      databasePath: dbPath,
      isOutsideCheckouts: outside,
    });
    expect(statSync(dbPath).ino).toBe(before);
    const previousLedgerId = record.sourceRevision.split(':')[0];
    expect(readdirSync(join(dir, 'operations'))).toEqual([
      'operation-ledger.sqlite',
    ]);
    ledger = open();
    expect(ledger.list({ limit: 10 }).items).toEqual([kept]);
    expect(ledger.eventsHead()).toBe(1);
    expect(ledger.sourceHead('github.pr', 'subject-1')).toBe('head-1');
    expect(ledger.sourceHead('github.pr', 'subject-2')).toBeNull();
    expect(ledger.ledgerId).not.toBe(previousLedgerId);
  });

  it('refuses to restore while the ledger is open or from a changed copy', async () => {
    ledger.accept(request());
    const record = await backup({
      dataRoot: dir,
      backupPath: 'backups/operation-ledger-2.sqlite',
      isOutsideCheckouts: outside,
    });
    expect(
      thrown(() =>
        restoreOperationLedgerBackup(record, {
          dataRoot: dir,
          databasePath: dbPath,
          isOutsideCheckouts: outside,
        }),
      ),
    ).toMatchObject({ code: 'WRITER_UNAVAILABLE' });

    ledger.close();
    writeFileSync(join(dir, 'backups/operation-ledger-2.sqlite'), 'changed');
    expect(
      thrown(() =>
        restoreOperationLedgerBackup(record, {
          dataRoot: dir,
          databasePath: dbPath,
          isOutsideCheckouts: outside,
        }),
      ),
    ).toMatchObject({ code: 'BACKUP_UNVERIFIED' });
    ledger = open();
  });

  it('never overwrites a file, the live ledger included', async () => {
    const kept = ledger.accept(request()).operation;
    for (const backupPath of [
      'operations/operation-ledger.sqlite',
      'operations/operation-ledger.sqlite-wal',
    ])
      await expect(
        backup({
          dataRoot: dir,
          backupPath,
          isOutsideCheckouts: outside,
        }),
      ).rejects.toThrow(/already exists/);
    expect(ledger.get(kept.operationId)).toEqual(kept);
    ledger.close();
    ledger = open();
    expect(ledger.get(kept.operationId)).toEqual(kept);
  });

  it('issues no record when the host cannot confirm the backup folder was flushed', async () => {
    ledger.accept(request());
    await expect(
      backupOperationLedger(ledger, {
        dataRoot: dir,
        backupPath: 'backups/operation-ledger-unflushed.sqlite',
        isOutsideCheckouts: outside,
        syncDirectory: (): Promise<'unsupported'> =>
          Promise.resolve('unsupported'),
      }),
    ).rejects.toMatchObject({ code: 'BACKUP_UNVERIFIED' });
  });
});

describe('operation ledger rollback and first-open backup (CAN-7655)', () => {
  const outside = (): boolean => true;
  const flushed = (): Promise<'flushed'> => Promise.resolve('flushed');
  const DAEMON_OWNED = STORAGE_OWNERSHIP.map((row) =>
    row.id === 'operation_ledger'
      ? { ...row, transitionOwner: 'daemon' as const, currentWriters: [] }
      : row,
  );
  const ledgerRows = (at: string): readonly unknown[] => {
    const reader = OperationLedger.open(
      join(at, 'operations', 'operation-ledger.sqlite'),
    );
    try {
      return reader.list({ limit: 50 }).items;
    } finally {
      reader.close();
    }
  };
  const takeBackup = (): Promise<NamespaceBackupRecord> =>
    backupOperationLedger(ledger, {
      dataRoot: dir,
      backupPath:
        'backups/operation-ledger/20261126T050000Z-aaaaaaaa-0001.sqlite',
      isOutsideCheckouts: outside,
      syncDirectory: flushed,
      clock: () => now,
    });
  const giveBack = (
    record: NamespaceBackupRecord,
    overrides: Record<string, unknown> = {},
  ): Promise<void> =>
    (
      returnOperationLedger as unknown as (
        record: NamespaceBackupRecord,
        options: Record<string, unknown>,
      ) => Promise<void>
    )(record, {
      owner: 'legacy',
      dataRoot: dir,
      databasePath: dbPath,
      isOutsideCheckouts: outside,
      syncDirectory: flushed,
      ...overrides,
    });
  const failureOf = (run: () => Promise<unknown>): Promise<unknown> =>
    Promise.resolve()
      .then(run)
      .then(
        () => null,
        (error: unknown) => error,
      );

  it('returns a backup into an empty data root, read back equal', async () => {
    const kept = ledger.accept(request()).operation;
    const record = await takeBackup();
    ledger.close();
    const empty = realpathSync(
      mkdtempSync(join(tmpdir(), 'operation-ledger-empty-')),
    );
    try {
      cpSync(join(dir, 'backups'), join(empty, 'backups'), {
        recursive: true,
      });
      await giveBack(record, {
        dataRoot: empty,
        databasePath: join(empty, 'operations', 'operation-ledger.sqlite'),
      });
      expect(ledgerRows(empty)).toEqual([kept]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
      ledger = open();
    }
  });

  it('refuses to return a backup over newer writes, changing nothing', async () => {
    ledger.accept(request());
    const record = await takeBackup();
    const newer = ledger.accept(
      request({ origin: { kind: 'client', sourceId: 'later' } }),
    ).operation;
    ledger.close();
    expect(await failureOf(() => giveBack(record))).toMatchObject({
      code: 'NEWER_STATE',
    });
    ledger = open();
    expect(ledger.get(newer.operationId)).toEqual(newer);
  });

  it('returns a backup over newer writes once a person confirms the loss', async () => {
    const kept = ledger.accept(request()).operation;
    const record = await takeBackup();
    const newer = ledger.accept(
      request({ origin: { kind: 'client', sourceId: 'later' } }),
    ).operation;
    ledger.close();
    await giveBack(record, { acceptNewerLoss: 'person-confirmed' });
    ledger = open();
    expect(ledger.get(kept.operationId)).toEqual(kept);
    expect(ledger.get(newer.operationId)).toBeNull();
  });

  it('refuses to return a backup over a newer source head alone, until a person confirms the loss', async () => {
    ledger.accept(request());
    const record = await takeBackup();
    ledger.recordSourceHead('github.pr', 'subject-1', 'head-1');
    ledger.close();
    expect(await failureOf(() => giveBack(record))).toMatchObject({
      code: 'NEWER_STATE',
    });
    ledger = open();
    expect(ledger.sourceHead('github.pr', 'subject-1')).toBe('head-1');
    ledger.close();
    await giveBack(record, { acceptNewerLoss: 'person-confirmed' });
    ledger = open();
    expect(ledger.sourceHead('github.pr', 'subject-1')).toBeNull();
  });

  it('returns a copy an older build left into this build, at this build schema', async () => {
    const kept = ledger.accept(request()).operation;
    const record = await takeBackup();
    ledger.close();
    const copy = join(dir, ...record.backupPath.split('/'));
    const older = new DatabaseSync(copy);
    try {
      older.exec('DROP TABLE initiated_work_heads');
      older
        .prepare(
          `UPDATE operation_meta SET value = '2' WHERE key = 'schema_version'`,
        )
        .run();
    } finally {
      older.close();
    }
    const digest = createHash('sha256')
      .update(readFileSync(copy))
      .digest('hex');
    await giveBack(
      { ...record, verifiedBy: { algorithm: 'sha256', digest } },
      { acceptNewerLoss: 'person-confirmed' },
    );
    ledger = open();
    expect(ledger.get(kept.operationId)).toEqual(kept);
    expect(ledger.sourceHead('github.pr', 'subject-1')).toBeNull();
  });

  it('returns the row to the app: the record names it again, the app writes and the daemon is refused', async () => {
    ledger.accept(request());
    const record = await takeBackup();
    const writes = { syncDirectory: flushed, isOutsideCheckouts: outside };
    await persistNamespaceBackupRecord(dir, record, writes);
    await writeOwnerFlipRecord(
      dir,
      {
        namespaceId: 'operation_ledger',
        fromOwner: 'legacy',
        toOwner: 'daemon',
        workPackage: 'W6',
        backupDigest: record.verifiedBy.digest,
        flippedAt: '2026-11-26T05:00:00.000Z',
      },
      writes,
    );
    ledger.close();
    await giveBack(record);
    ledger = open();
    await expect(
      readOwnerFlipRecord(dir, 'operation_ledger'),
    ).resolves.toMatchObject({
      kind: 'record',
      record: {
        fromOwner: 'daemon',
        toOwner: 'legacy',
        backupRecord: `storage-records/operation_ledger/namespace-backup.json#sha256:${record.verifiedBy.digest}`,
      },
    });
    await expect(
      assertRowWritable(dir, 'operation_ledger', 'electron_main'),
    ).resolves.toBeUndefined();
    await expect(
      assertRowWritable(dir, 'operation_ledger', 'daemon'),
    ).rejects.toMatchObject({ reason: 'owned_elsewhere' });
  });

  it('finishes an interrupted return on a retry, with no loss to confirm', async () => {
    const kept = ledger.accept(request()).operation;
    const record = await takeBackup();
    const writes = { syncDirectory: flushed, isOutsideCheckouts: outside };
    await persistNamespaceBackupRecord(dir, record, writes);
    await writeOwnerFlipRecord(
      dir,
      {
        namespaceId: 'operation_ledger',
        fromOwner: 'legacy',
        toOwner: 'daemon',
        workPackage: 'W6',
        backupDigest: record.verifiedBy.digest,
        flippedAt: '2026-11-26T05:00:00.000Z',
      },
      writes,
    );
    ledger.close();
    const records = join(dir, 'storage-records', 'operation_ledger');
    expect(
      await failureOf(() =>
        giveBack(record, {
          syncDirectory: (path: string): Promise<'flushed' | 'unsupported'> =>
            Promise.resolve(path === records ? 'unsupported' : 'flushed'),
        }),
      ),
    ).not.toBeNull();
    await giveBack(record);
    await expect(
      readOwnerFlipRecord(dir, 'operation_ledger'),
    ).resolves.toMatchObject({ kind: 'record', record: { toOwner: 'legacy' } });
    ledger = open();
    expect(ledger.get(kept.operationId)).toEqual(kept);
  });

  it('flushes the owner record on a retry that finds the requested owner already named', async () => {
    ledger.accept(request());
    const record = await takeBackup();
    const writes = { syncDirectory: flushed, isOutsideCheckouts: outside };
    await persistNamespaceBackupRecord(dir, record, writes);
    await writeOwnerFlipRecord(
      dir,
      {
        namespaceId: 'operation_ledger',
        fromOwner: 'legacy',
        toOwner: 'daemon',
        workPackage: 'W6',
        backupDigest: record.verifiedBy.digest,
        flippedAt: '2026-11-26T05:00:00.000Z',
      },
      writes,
    );
    ledger.close();
    const records = join(dir, 'storage-records', 'operation_ledger');
    const ownerFlip = join(records, 'owner-flip.json');
    const named = (): boolean =>
      existsSync(ownerFlip) &&
      (JSON.parse(readFileSync(ownerFlip, 'utf8')) as { toOwner?: string })
        .toOwner === 'legacy';
    const unflushedOnceNamed = (
      path: string,
    ): Promise<'flushed' | 'unsupported'> =>
      Promise.resolve(path === records && named() ? 'unsupported' : 'flushed');
    expect(
      await failureOf(() =>
        giveBack(record, { syncDirectory: unflushedOnceNamed }),
      ),
    ).not.toBeNull();
    await expect(
      readOwnerFlipRecord(dir, 'operation_ledger'),
    ).resolves.toMatchObject({ kind: 'record', record: { toOwner: 'legacy' } });
    expect(
      await failureOf(() =>
        giveBack(record, { syncDirectory: unflushedOnceNamed }),
      ),
    ).toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    const synced: string[] = [];
    await giveBack(record, {
      syncDirectory: (path: string): Promise<'flushed'> => {
        synced.push(path);
        return Promise.resolve('flushed');
      },
    });
    expect(synced).toContain(records);
    ledger = open();
  });

  it('returns an unchanged older ledger after a crash between the owner record and the migration', async () => {
    const kept = ledger.accept(request()).operation;
    ledger.close();
    const older = new DatabaseSync(dbPath);
    try {
      older.exec('DROP TABLE initiated_work_heads');
      older
        .prepare(
          `UPDATE operation_meta SET value = '2' WHERE key = 'schema_version'`,
        )
        .run();
    } finally {
      older.close();
    }
    const at = realpathSync(dir);
    const crashed = (
      createDaemonOperationService as unknown as (
        options: Record<string, unknown>,
      ) => ReturnType<typeof createDaemonOperationService>
    )({
      dataRoot: at,
      ownership: DAEMON_OWNED,
      syncDirectory: flushed,
      firstOpenCheckpoint: (point: string): void => {
        if (point === 'recorded') throw new Error('crash');
      },
    });
    try {
      expect(await failureOf(() => crashed.list({ limit: 1 }))).not.toBeNull();
    } finally {
      crashed.close();
    }
    const record = JSON.parse(
      readFileSync(
        join(
          at,
          'storage-records',
          'operation_ledger',
          'namespace-backup.json',
        ),
        'utf8',
      ),
    ) as NamespaceBackupRecord;
    await giveBack(record, {
      dataRoot: at,
      databasePath: join(at, 'operations', 'operation-ledger.sqlite'),
    });
    await expect(
      readOwnerFlipRecord(at, 'operation_ledger'),
    ).resolves.toMatchObject({ kind: 'record', record: { toOwner: 'legacy' } });
    ledger = open();
    expect(ledger.get(kept.operationId)).toEqual(kept);
  });

  it.each([
    ['an owner record that cannot be read', {}, 'not json'],
    ['no owner to return the row to', { owner: undefined }, null],
  ])(
    'refuses to return a backup given %s, restoring nothing',
    async (_name, overrides, recordText) => {
      ledger.accept(request());
      const record = await takeBackup();
      const newer = ledger.accept(
        request({ origin: { kind: 'client', sourceId: 'later' } }),
      ).operation;
      if (recordText !== null) {
        mkdirSync(join(dir, 'storage-records', 'operation_ledger'), {
          recursive: true,
        });
        writeFileSync(
          join(dir, 'storage-records', 'operation_ledger', 'owner-flip.json'),
          recordText,
        );
      }
      ledger.close();
      expect(
        await failureOf(() =>
          giveBack(record, {
            acceptNewerLoss: 'person-confirmed',
            ...overrides,
          }),
        ),
      ).toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
      ledger = open();
      expect(ledger.get(newer.operationId)).toEqual(newer);
    },
  );

  it('ends with one cited copy, both records and the ledger unchanged after a crash before any flush of the first daemon open', async () => {
    const kept = ledger.accept(request()).operation;
    ledger.close();
    const attempt = async (
      at: string,
      syncDirectory: (path: string) => Promise<'flushed' | 'unsupported'>,
    ): Promise<unknown> => {
      const service = (
        createDaemonOperationService as unknown as (
          options: Record<string, unknown>,
        ) => ReturnType<typeof createDaemonOperationService>
      )({ dataRoot: at, ownership: DAEMON_OWNED, syncDirectory });
      try {
        await service.list({ limit: 1 });
        return null;
      } catch (error) {
        return error;
      } finally {
        service.close();
      }
    };
    const run = async (crash?: number): Promise<string[] | string> => {
      const at = realpathSync(
        mkdtempSync(join(tmpdir(), 'operation-ledger-crash-')),
      );
      const scratch = [at];
      try {
        cpSync(dir, at, { recursive: true });
        const fs = crashFs(at, strictFlush);
        fs.crashBefore(crash);
        const failure = await attempt(at, fs.syncDirectory);
        if (crash === undefined) return [...fs.flushed];
        if (
          !(
            failure instanceof Crash ||
            (failure instanceof OperationLedgerError &&
              failure.underlying instanceof Crash)
          )
        )
          return `crash before flush ${String(crash)}: the attempt ended with ${failure === null ? 'success' : failure instanceof Error ? failure.message : JSON.stringify(failure)}`;
        const image = fs.durableImage();
        scratch.push(image);
        const retried = await attempt(image, strictFlush);
        if (retried !== null)
          return `crash before flush ${String(crash)}: the retry failed with ${retried instanceof Error ? retried.message : JSON.stringify(retried)}`;
        const backup = JSON.parse(
          readFileSync(
            join(
              image,
              'storage-records',
              'operation_ledger',
              'namespace-backup.json',
            ),
            'utf8',
          ),
        ) as { backupPath: string; verifiedBy: { digest: string } };
        const owner = await readOwnerFlipRecord(image, 'operation_ledger');
        const problems = [
          ...(existsSync(join(image, backup.backupPath))
            ? []
            : ['the cited copy is missing']),
          ...(owner.kind === 'record' &&
          owner.record.toOwner === 'daemon' &&
          owner.record.backupRecord.endsWith(backup.verifiedBy.digest)
            ? []
            : [
                'the owner record does not name the daemon over the cited copy',
              ]),
          ...(JSON.stringify(ledgerRows(image)).includes(kept.operationId)
            ? []
            : ['the ledger lost its operation']),
        ];
        return problems.length === 0
          ? []
          : `crash before flush ${String(crash)}: ${problems.join('; ')}`;
      } finally {
        for (const path of scratch)
          rmSync(path, { recursive: true, force: true });
      }
    };
    const listed = await run();
    expect(Array.isArray(listed) ? listed.length : 0).toBeGreaterThan(0);
    const failures: string[] = [];
    for (
      let point = 0;
      point < (Array.isArray(listed) ? listed.length : 0);
      point += 1
    ) {
      const result = await run(point);
      if (typeof result === 'string') failures.push(result);
    }
    expect(failures).toEqual([]);
    ledger = open();
  }, 120_000);
});
