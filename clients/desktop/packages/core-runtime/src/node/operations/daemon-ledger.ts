import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, rmSync, statSync, statfsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  assertStorageWriteAllowed,
  evaluateStorageWrite,
  STORAGE_OWNERSHIP,
  type StorageOwnershipRow,
} from '../../storage';
import {
  StorageRowOwnerError,
  decideRowWrite,
  namespaceBackupRecordPath,
  storageRecordsFolder,
} from '../../storage/owner-records';
import {
  OwnerRecordWriteError,
  persistNamespaceBackupRecord,
  readOwnerFlipRecord,
  writeOwnerFlipRecord,
} from '../storage-records';
import type {
  backupOperationLedger,
  discardUncitedOperationLedgerCopy,
} from './ledger/backup';
import { OperationLedgerError } from './ledger/errors';
import type { OperationLedger } from './ledger/ledger';
import { OperationService, type OperationServiceOptions } from './service';

/** The ledger under a data root, as Electron main's path helper resolves it. */
export function operationLedgerPath(dataRoot: string): string {
  return join(dataRoot, 'operations', 'operation-ledger.sqlite');
}

/** Whether these rows let the daemon write the operation ledger. */
export function isDaemonOperationLedgerOwner(
  ownership: readonly StorageOwnershipRow[] = STORAGE_OWNERSHIP,
): boolean {
  return evaluateStorageWrite('operation_ledger', 'daemon', ownership).allowed;
}

/**
 * How long one open waits for another writer's lock. The open is
 * synchronous on the daemon thread, so it stays far below the ledger's
 * default.
 */
export const DAEMON_OPERATION_LEDGER_OPEN_BUSY_TIMEOUT_MS = 50;

/**
 * After another writer refuses the open, calls answer unavailable without
 * trying again until this much time has passed.
 */
export const DAEMON_OPERATION_LEDGER_RETRY_AFTER_MS = 1_000;

export const DAEMON_OPERATION_LEDGER_BACKUP_RETRY_AFTER_MS = 60_000;

export const DAEMON_OPERATION_LEDGER_BACKUP_DIR = 'backups/operation-ledger';

const NAMESPACE = 'operation_ledger';
const BACKUPS_KEPT = 3;
const BACKUP_NAME = /^\d{8}T\d{6}Z-[0-9a-f]{8}-[0-9a-f]{4}\.sqlite$/;
const FREE_SPACE_HEADROOM_BYTES = 256 * 1024 * 1024;

type SyncDirectory = (path: string) => Promise<'flushed' | 'unsupported'>;
type FirstOpenCheckpoint = 'locked' | 'copied' | 'recorded';

export interface DaemonOperationServiceOptions {
  readonly dataRoot: string;
  /** Trusted composition only; defaults to the compiled ownership rows. */
  readonly ownership?: readonly StorageOwnershipRow[];
  readonly onError?: OperationServiceOptions['onError'];
  readonly openBusyTimeoutMs?: number;
  readonly retryAfterMs?: number;
  readonly syncDirectory?: SyncDirectory;
  readonly clock?: () => number;
  readonly freeSpace?: (path: string) => number;
  readonly firstOpenCheckpoint?: (
    point: FirstOpenCheckpoint,
  ) => void | Promise<void>;
}

interface LedgerSteps {
  readonly backup: typeof backupOperationLedger;
  readonly discard: typeof discardUncitedOperationLedgerCopy;
}

interface LedgerModule {
  readonly OperationLedger: typeof OperationLedger;
  readonly backupOperationLedger: typeof backupOperationLedger;
  readonly discardUncitedOperationLedgerCopy: typeof discardUncitedOperationLedgerCopy;
}

interface OwnershipContext {
  readonly dataRoot: string;
  readonly ownership: readonly StorageOwnershipRow[] | undefined;
  readonly syncDirectory: SyncDirectory | undefined;
  readonly clock: () => number;
  readonly freeSpace: (path: string) => number;
  readonly checkpoint: (point: FirstOpenCheckpoint) => Promise<void>;
}

function backupUnverified(
  message: string,
  error?: unknown,
): OperationLedgerError {
  return new OperationLedgerError('BACKUP_UNVERIFIED', message, error);
}

function backupFailure(error: unknown): OperationLedgerError {
  if (
    error instanceof OperationLedgerError &&
    error.code === 'BACKUP_UNVERIFIED'
  )
    return error;
  if (
    error instanceof OperationLedgerError ||
    error instanceof OwnerRecordWriteError
  )
    return backupUnverified(error.message, error);
  return backupUnverified('The backup could not be written.', error);
}

function freeBytes(path: string): number {
  const stats = statfsSync(path);
  return Number(stats.bavail) * Number(stats.bsize);
}

function flushWith(
  syncDirectory: SyncDirectory | undefined,
): (folder: string) => Promise<void> {
  return async (folder: string): Promise<void> => {
    if (syncDirectory === undefined)
      throw backupUnverified('This host gave no folder flush to back up with.');
    if ((await syncDirectory(folder)) !== 'flushed')
      throw backupUnverified('A folder flush was not confirmed.');
  };
}

function guardedFlush(
  syncDirectory: SyncDirectory | undefined,
): SyncDirectory | undefined {
  if (syncDirectory === undefined) return undefined;
  return async (path: string): Promise<'flushed' | 'unsupported'> => {
    try {
      return await syncDirectory(path);
    } catch (error) {
      throw backupUnverified('A folder flush failed.', error);
    }
  };
}

async function recordCites(
  dataRoot: string,
  backupPath: string,
): Promise<boolean> {
  let record: unknown;
  try {
    record = JSON.parse(
      await readFile(
        join(dataRoot, ...namespaceBackupRecordPath(NAMESPACE).split('/')),
        'utf8',
      ),
    );
  } catch {
    return false;
  }
  return (
    typeof record === 'object' &&
    record !== null &&
    'backupPath' in record &&
    record.backupPath === backupPath
  );
}

async function backUpAndTakeOwnership(
  ledger: OperationLedger,
  steps: LedgerSteps,
  context: OwnershipContext,
): Promise<void> {
  const { dataRoot, clock } = context;
  const flush = flushWith(context.syncDirectory);
  const needed =
    2 * statSync(operationLedgerPath(dataRoot)).size +
    FREE_SPACE_HEADROOM_BYTES;
  if (context.freeSpace(dataRoot) < needed)
    throw backupUnverified(
      'There is not enough free space to back up the operation ledger.',
    );
  if (context.syncDirectory === undefined)
    throw backupUnverified('This host gave no folder flush to back up with.');
  const stamp = new Date(clock())
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  const ledgerTag = ledger.ledgerId.replace(/[^0-9a-f]/gi, '').slice(0, 8);
  const name = `${stamp}-${ledgerTag.toLowerCase().padEnd(8, '0')}-${randomBytes(2).toString('hex')}.sqlite`;
  const backupPath = `${DAEMON_OPERATION_LEDGER_BACKUP_DIR}/${name}`;
  if (existsSync(join(dataRoot, ...backupPath.split('/'))))
    throw backupUnverified('The backup path already exists.');
  const isOutsideCheckouts = (path: string): boolean => path === backupPath;
  const writes = {
    syncDirectory: context.syncDirectory,
    isOutsideCheckouts,
    ownership: context.ownership,
  };
  let record: Awaited<ReturnType<typeof backupOperationLedger>>;
  try {
    record = await steps.backup(ledger, {
      dataRoot,
      backupPath,
      isOutsideCheckouts,
      syncDirectory: context.syncDirectory,
      clock,
    });
    // The copy's folders may be new; flush them before a record cites it.
    await flush(join(dataRoot, 'backups'));
    await flush(dataRoot);
    await context.checkpoint('copied');
    await persistNamespaceBackupRecord(dataRoot, record, writes);
  } catch (error) {
    const failure = backupFailure(error);
    if (!(await recordCites(dataRoot, backupPath)))
      await steps
        .discard(dataRoot, backupPath)
        .catch((discardError: unknown): never => {
          throw backupUnverified(
            'The backup failed, and its partial copy could not be removed.',
            discardError,
          );
        });
    throw failure;
  }
  try {
    await writeOwnerFlipRecord(
      dataRoot,
      {
        namespaceId: NAMESPACE,
        fromOwner: 'legacy',
        toOwner: 'daemon',
        workPackage: 'W6',
        backupDigest: record.verifiedBy.digest,
        flippedAt: new Date(clock()).toISOString(),
      },
      writes,
    );
  } catch (error) {
    throw backupFailure(error);
  }
  await context.checkpoint('recorded');
  const folder = join(
    dataRoot,
    ...DAEMON_OPERATION_LEDGER_BACKUP_DIR.split('/'),
  );
  const copies = readdirSync(folder)
    .filter((entry) => BACKUP_NAME.test(entry))
    .sort();
  const kept = new Set([...copies.slice(-BACKUPS_KEPT), name]);
  for (const entry of copies)
    if (!kept.has(entry)) rmSync(join(folder, entry), { force: true });
}

async function reflushRecord(context: OwnershipContext): Promise<void> {
  const flush = flushWith(context.syncDirectory);
  const folder = join(
    context.dataRoot,
    ...storageRecordsFolder(NAMESPACE).split('/'),
  );
  await flush(folder);
  await flush(dirname(folder));
  await flush(context.dataRoot);
}

async function firstOpen(
  ledgerModule: LedgerModule,
  context: OwnershipContext,
  openBusyTimeoutMs: number,
): Promise<OperationLedger> {
  const ledger = ledgerModule.OperationLedger.open(
    operationLedgerPath(context.dataRoot),
    { openBusyTimeoutMs, keepSchema: true },
  );
  try {
    await context.checkpoint('locked');
    await backUpAndTakeOwnership(
      ledger,
      {
        backup: ledgerModule.backupOperationLedger,
        discard: ledgerModule.discardUncitedOperationLedgerCopy,
      },
      context,
    );
    ledger.migrateSchema();
    return ledger;
  } catch (error) {
    ledger.close();
    throw error;
  }
}

/**
 * The daemon's operation service (CAN-5092). Each open first checks that
 * the ownership rows make the daemon the ledger's writer, so a mis-gated
 * composition fails closed as `unavailable` and never loads the ledger
 * module or touches the path. A ledger another writer holds is tried at
 * most once per retry window.
 */
export function createDaemonOperationService(
  options: DaemonOperationServiceOptions,
): OperationService {
  const ownership = options.ownership ?? STORAGE_OWNERSHIP;
  const context: OwnershipContext = {
    dataRoot: options.dataRoot,
    ownership: options.ownership,
    syncDirectory: guardedFlush(options.syncDirectory),
    clock: options.clock ?? Date.now,
    freeSpace: options.freeSpace ?? freeBytes,
    checkpoint: async (point: FirstOpenCheckpoint): Promise<void> => {
      await options.firstOpenCheckpoint?.(point);
    },
  };
  const openBusyTimeoutMs =
    options.openBusyTimeoutMs ?? DAEMON_OPERATION_LEDGER_OPEN_BUSY_TIMEOUT_MS;
  let refused: {
    readonly error: OperationLedgerError;
    readonly until: number;
  } | null = null;
  const refuse = (error: unknown): void => {
    if (!(error instanceof OperationLedgerError)) return;
    if (error.code === 'WRITER_UNAVAILABLE')
      refused = {
        error,
        until:
          Date.now() +
          (options.retryAfterMs ?? DAEMON_OPERATION_LEDGER_RETRY_AFTER_MS),
      };
    else if (error.code === 'BACKUP_UNVERIFIED')
      refused = {
        error,
        until: Date.now() + DAEMON_OPERATION_LEDGER_BACKUP_RETRY_AFTER_MS,
      };
  };
  return new OperationService({
    openLedger: async (): Promise<OperationLedger> => {
      try {
        assertStorageWriteAllowed('operation_ledger', 'daemon', ownership);
      } catch (error) {
        throw new OperationLedgerError(
          'STORAGE_UNAVAILABLE',
          'This daemon does not own the operation ledger.',
          error,
        );
      }
      if (refused && Date.now() < refused.until) throw refused.error;
      refused = null;
      try {
        const read = await readOwnerFlipRecord(options.dataRoot, NAMESPACE);
        if (read.kind !== 'absent') {
          const decision = decideRowWrite(read, 'daemon');
          if (!decision.allowed)
            throw new OperationLedgerError(
              'WRITER_UNAVAILABLE',
              decision.message,
              new StorageRowOwnerError(NAMESPACE, decision),
            );
        }
        const ledgerModule = await import('./ledger');
        if (read.kind === 'absent')
          return await firstOpen(ledgerModule, context, openBusyTimeoutMs);
        const ledger = ledgerModule.OperationLedger.open(
          operationLedgerPath(options.dataRoot),
          { openBusyTimeoutMs },
        );
        try {
          await reflushRecord(context);
          return ledger;
        } catch (error) {
          ledger.close();
          throw error;
        }
      } catch (error) {
        refuse(error);
        throw error;
      }
    },
    ...(options.onError && { onError: options.onError }),
  });
}

export interface ReclaimDaemonOperationLedgerOptions {
  readonly dataRoot: string;
  readonly syncDirectory: SyncDirectory;
  readonly ownership?: readonly StorageOwnershipRow[];
  readonly clock?: () => number;
  readonly freeSpace?: (path: string) => number;
}

export async function reclaimDaemonOperationLedger(
  options: ReclaimDaemonOperationLedgerOptions,
): Promise<void> {
  const read = await readOwnerFlipRecord(options.dataRoot, NAMESPACE);
  if (read.kind !== 'record' || read.record.toOwner !== 'legacy')
    throw new OperationLedgerError(
      'STORAGE_UNAVAILABLE',
      'Only an operation ledger a rollback returned to the app is reclaimed this way.',
    );
  const ledgerModule = await import('./ledger');
  const ledger = ledgerModule.OperationLedger.open(
    operationLedgerPath(options.dataRoot),
  );
  try {
    await backUpAndTakeOwnership(
      ledger,
      {
        backup: ledgerModule.backupOperationLedger,
        discard: ledgerModule.discardUncitedOperationLedgerCopy,
      },
      {
        dataRoot: options.dataRoot,
        ownership: options.ownership,
        syncDirectory: guardedFlush(options.syncDirectory),
        clock: options.clock ?? Date.now,
        freeSpace: options.freeSpace ?? freeBytes,
        checkpoint: (): Promise<void> => Promise.resolve(),
      },
    );
  } finally {
    ledger.close();
  }
}
