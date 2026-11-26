import {
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
  type OperationAcceptRequest,
  type OperationLedgerBackupOptions,
} from '../ledger';

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
