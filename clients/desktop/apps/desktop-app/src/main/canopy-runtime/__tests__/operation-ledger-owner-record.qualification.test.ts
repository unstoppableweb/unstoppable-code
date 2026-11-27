import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { CanopyOperationError } from '@canopy/core-runtime';
import { OperationLedgerError } from '@canopy/core-runtime/node/operations';
import { StorageRowOwnerError } from '@canopy/core-runtime/node/pipeline/store';
import { createCoreOperationAdapter } from '../core-operation-adapter';

/*
 * CAN-7972: Electron main opens the operation ledger only while the row's
 * owner record names the app, or while there is no record. A record naming
 * the daemon, or one that can't be read, refuses the open before the ledger
 * file is created or touched, so an older app can't write a ledger the
 * daemon keeps (the CAN-7690 check, in a release before the owner change).
 * Each refusal says which case it is: another owner keeps the ledger, or the
 * record can't be read.
 */

let root: string;
const adapters: Array<{ close(): void }> = [];

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'operation-ledger-owner-record-'));
});

afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.close();
  rmSync(root, { recursive: true, force: true });
});

function ledgerFile(): string {
  return path.join(root, 'operations', 'operation-ledger.sqlite');
}

function recordFile(): string {
  return path.join(
    root,
    'storage-records',
    'operation_ledger',
    'owner-flip.json',
  );
}

function record(toOwner: 'daemon' | 'legacy'): void {
  mkdirSync(path.dirname(recordFile()), { recursive: true });
  writeFileSync(
    recordFile(),
    JSON.stringify({
      namespaceId: 'operation_ledger',
      fromOwner: toOwner === 'daemon' ? 'legacy' : 'daemon',
      toOwner,
      workPackage: 'W6',
      backupRecord: `storage-records/operation_ledger/namespace-backup.json#sha256:${'a'.repeat(64)}`,
      flippedAt: '2026-11-26T05:00:00.000Z',
    }),
  );
}

function unreadableRecord(): void {
  mkdirSync(path.dirname(recordFile()), { recursive: true });
  writeFileSync(recordFile(), '{ not json');
}

/** The ledger's files under the data root, by name. */
function ledgerFiles(): string[] {
  const folder = path.dirname(ledgerFile());
  return existsSync(folder) ? readdirSync(folder).sort() : [];
}

function adapter(): ReturnType<typeof createCoreOperationAdapter> {
  const created = createCoreOperationAdapter({ ledgerPath: ledgerFile });
  adapters.push(created);
  return created;
}

type ListHandler = ReturnType<
  typeof createCoreOperationAdapter
>['queries']['core.operation.list'];

function list(
  created: ReturnType<typeof createCoreOperationAdapter>,
): ReturnType<ListHandler> {
  return created.queries['core.operation.list'](
    {},
    {} as Parameters<ListHandler>[1],
  );
}

type Adapter = ReturnType<typeof createCoreOperationAdapter>;
type GetHandler = Adapter['queries']['core.operation.get'];
type CancelHandler = Adapter['instructions']['core.operation.cancel'];
type EventsHandler = Adapter['streams']['core.operation.events'];

function get(created: Adapter): ReturnType<GetHandler> {
  return created.queries['core.operation.get'](
    { operationId: 'operation-1' },
    {} as Parameters<GetHandler>[1],
  );
}

function cancel(created: Adapter): ReturnType<CancelHandler> {
  return created.instructions['core.operation.cancel'](
    { operationId: 'operation-1', reason: 'Stop.' },
    { caller: { principalId: 'local-user' } } as Parameters<CancelHandler>[1],
  );
}

function events(created: Adapter): ReturnType<EventsHandler> {
  return created.streams['core.operation.events'](
    {},
    {} as Parameters<EventsHandler>[1],
    {
      emitAt: () => 0,
      end: () => undefined,
    } as unknown as Parameters<EventsHandler>[2],
  );
}

async function openRefusal(): Promise<unknown> {
  return adapter()
    .service.ready()
    .then(
      () => null,
      (reason: unknown) => reason,
    );
}

describe('older app opens of the operation ledger refused once another owner keeps it (CAN-7972)', () => {
  it('refuses a core.operation.list while the record names the daemon, creating no ledger file', async () => {
    record('daemon');
    await expect(list(adapter())).rejects.toBeInstanceOf(CanopyOperationError);
    expect(ledgerFiles()).toEqual([]);
  });

  it('refuses a core.operation.get while the record names the daemon, creating no ledger file', async () => {
    record('daemon');
    await expect(get(adapter())).rejects.toMatchObject({
      payload: { kind: 'unavailable' },
    });
    expect(ledgerFiles()).toEqual([]);
  });

  it('refuses a core.operation.cancel while the record names the daemon, creating no ledger file', async () => {
    record('daemon');
    await expect(cancel(adapter())).rejects.toMatchObject({
      payload: { kind: 'unavailable' },
    });
    expect(ledgerFiles()).toEqual([]);
  });

  it('refuses core.operation.events while the record names the daemon, creating no ledger file', async () => {
    record('daemon');
    await expect(events(adapter())).rejects.toMatchObject({
      payload: { kind: 'unavailable' },
    });
    expect(ledgerFiles()).toEqual([]);
  });

  it('refuses the open while the owner record cannot be read, creating no ledger file', async () => {
    unreadableRecord();
    await expect(list(adapter())).rejects.toBeInstanceOf(CanopyOperationError);
    expect(ledgerFiles()).toEqual([]);
  });

  it('raises a refusal under the daemon’s record as an unavailable writer that says another owner keeps the ledger', async () => {
    record('daemon');
    const error = await openRefusal();
    expect(error).toBeInstanceOf(OperationLedgerError);
    expect((error as OperationLedgerError).code).toBe('WRITER_UNAVAILABLE');
    expect((error as OperationLedgerError).message).toContain(
      'The background service keeps this data now',
    );
    const underlying = (error as OperationLedgerError).underlying;
    expect(underlying).toBeInstanceOf(StorageRowOwnerError);
    expect((underlying as StorageRowOwnerError).reason).toBe('owned_elsewhere');
    expect((underlying as StorageRowOwnerError).owner).toBe('daemon');
    expect(ledgerFiles()).toEqual([]);
  });

  it('raises a refusal under an unreadable record as an unavailable writer that says the record can’t be read, not that another owner keeps it', async () => {
    unreadableRecord();
    const error = await openRefusal();
    expect(error).toBeInstanceOf(OperationLedgerError);
    expect((error as OperationLedgerError).code).toBe('WRITER_UNAVAILABLE');
    expect((error as OperationLedgerError).message).toContain('can’t be read');
    expect((error as OperationLedgerError).message).not.toContain(
      'keeps this data now',
    );
    const underlying = (error as OperationLedgerError).underlying;
    expect(underlying).toBeInstanceOf(StorageRowOwnerError);
    expect((underlying as StorageRowOwnerError).reason).toBe(
      'record_unreadable',
    );
    expect((underlying as StorageRowOwnerError).owner).toBeUndefined();
    expect(ledgerFiles()).toEqual([]);
  });

  it('opens as before with no owner record', async () => {
    await expect(list(adapter())).resolves.toBeDefined();
    expect(existsSync(ledgerFile())).toBe(true);
  });

  it('opens once the record names the app again after a rollback', async () => {
    record('legacy');
    await expect(list(adapter())).resolves.toBeDefined();
    expect(existsSync(ledgerFile())).toBe(true);
  });

  it('checks the record at each open, so a refusal is not kept once the record is gone', async () => {
    record('daemon');
    const created = adapter();
    await expect(list(created)).rejects.toBeInstanceOf(CanopyOperationError);
    expect(ledgerFiles()).toEqual([]);
    rmSync(recordFile());
    await expect(list(created)).resolves.toBeDefined();
    expect(existsSync(ledgerFile())).toBe(true);
  });
});
