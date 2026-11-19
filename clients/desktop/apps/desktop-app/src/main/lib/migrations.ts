import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pruneDamagedCopies } from '@canopy/execution-engine/node/lib/damaged-copies';
import {
  createDirectoryDurably,
  writeFileAtomically,
  type AdmittedWriterTarget,
} from './atomic-file';
import {
  logMainProcessError,
  logMainProcessWarn,
} from './main-process-logging';
import {
  createMigrationsDamagedPath,
  createMigrationsLastGoodPath,
  isMigrationsDamagedFileName,
} from './migrations-file-paths';
import { getMigrationsFilePath } from './paths';
import { reportStartupStepFailure } from './startup-step';
import { isErrnoException, isRecord } from './type-guards';

const MIGRATION_STATE_VERSION = 1;

const MIGRATIONS_WRITER: AdmittedWriterTarget = {
  namespace: 'startup_migrations',
  writer: 'electron_main',
  module: 'main/lib/migrations',
};

type MigrationState = { version: typeof MIGRATION_STATE_VERSION } & Record<
  string,
  unknown
>;

export type MigrationLedgerUnavailableReason = 'damaged' | 'newer_version';

/**
 * The ledger cannot be trusted this run: it was written by a newer version,
 * or it is unreadable with no usable last-good copy. Gated migrations are
 * skipped rather than run again, and nothing is written.
 */
export class MigrationLedgerUnavailableError extends Error {
  public readonly reason: MigrationLedgerUnavailableReason;

  public constructor(reason: MigrationLedgerUnavailableReason) {
    super(
      reason === 'newer_version'
        ? 'The migration ledger was written by a newer version'
        : 'The migration ledger is unreadable and has no usable last-good copy',
    );
    this.name = 'MigrationLedgerUnavailableError';
    this.reason = reason;
  }
}

type LedgerFile =
  | { kind: 'missing' }
  | { kind: 'ready'; state: MigrationState; bytes: Buffer }
  | { kind: 'damaged'; bytes: Buffer }
  | { kind: 'newer' };

function parseLedger(bytes: Buffer): LedgerFile {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { kind: 'damaged', bytes };
  }
  if (!isRecord(value)) return { kind: 'damaged', bytes };
  if ('version' in value && value.version !== MIGRATION_STATE_VERSION) {
    const newer =
      typeof value.version === 'number' &&
      Number.isInteger(value.version) &&
      value.version > MIGRATION_STATE_VERSION;
    return newer ? { kind: 'newer' } : { kind: 'damaged', bytes };
  }
  return {
    kind: 'ready',
    state: { version: MIGRATION_STATE_VERSION, ...value },
    bytes,
  };
}

async function readLedgerFile(filePath: string): Promise<LedgerFile> {
  try {
    return parseLedger(await readFile(filePath));
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return { kind: 'missing' };
    }
    throw error;
  }
}

function writeLedgerFile(
  filePath: string,
  content: string | Buffer,
): Promise<void> {
  return writeFileAtomically(filePath, content, {
    encoding: 'utf8',
    durable: true,
    admittedWriter: MIGRATIONS_WRITER,
  });
}

// Every read and write runs in turn, so a mark never drops another mark and
// a read sees every earlier mark from this process. Electron's
// single-instance lock keeps other desktop processes out.
let ledgerQueue: Promise<void> = Promise.resolve();

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = ledgerQueue.then(task);
  ledgerQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Last-good content this process has confirmed, per ledger path. */
const confirmedLastGood = new Map<string, Buffer>();
/** Completions whose marker write failed or had an unknown outcome. */
const unrecordedCompletions = new Set<string>();
const reportedUnavailable = new Set<string>();

function completionKey(filePath: string, migrationKey: string): string {
  return `${filePath}\n${migrationKey}`;
}

function unavailable(
  filePath: string,
  reason: MigrationLedgerUnavailableReason,
): MigrationLedgerUnavailableError {
  if (!reportedUnavailable.has(filePath)) {
    reportedUnavailable.add(filePath);
    logMainProcessWarn(
      '[migrations] Migration ledger unavailable; skipping gated migrations',
      { reason },
    );
    // Reported once per ledger path with its closed reason; the source names it.
    reportStartupStepFailure(
      reason === 'damaged'
        ? 'migration.ledger_unavailable.damaged'
        : 'migration.ledger_unavailable.newer_version',
      new MigrationLedgerUnavailableError(reason),
    );
  }
  return new MigrationLedgerUnavailableError(reason);
}

async function confirmLastGood(filePath: string, bytes: Buffer): Promise<void> {
  if (confirmedLastGood.get(filePath)?.equals(bytes)) return;
  const lastGoodPath = createMigrationsLastGoodPath(filePath);
  try {
    const lastGood = await readLedgerFile(lastGoodPath);
    if (lastGood.kind !== 'ready' || !lastGood.bytes.equals(bytes)) {
      await writeLedgerFile(lastGoodPath, bytes);
    }
    confirmedLastGood.set(filePath, bytes);
  } catch (error) {
    logMainProcessError(
      '[migrations] Failed to refresh the migration ledger last-good copy:',
      error,
    );
    reportStartupStepFailure('migration.ledger_last_good', error);
  }
}

/** Keeps `bytes` once as a damaged copy, with at most the newest five. */
async function keepDamagedCopy(filePath: string, bytes: Buffer): Promise<void> {
  const folder = dirname(filePath);
  for (const name of await readdir(folder)) {
    if (!isMigrationsDamagedFileName(name)) continue;
    const existing = await readFile(join(folder, name)).catch(() => null);
    if (existing?.equals(bytes)) return;
  }
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  await writeFileAtomically(
    createMigrationsDamagedPath(filePath, stamp),
    bytes,
    {
      durable: true,
      overwrite: false,
      admittedWriter: MIGRATIONS_WRITER,
    },
  );
  await pruneDamagedCopies({
    directory: folder,
    prefix: 'migrations.damaged-',
    suffix: '.json',
    uniqueTail: true,
  });
}

/**
 * The trusted ledger, restoring last-good over a damaged or missing primary.
 * A damaged primary stays in place until the restore is installed, so a
 * restart never reads an empty ledger in its place.
 */
async function loadLedger(filePath: string): Promise<MigrationState> {
  const primary = await readLedgerFile(filePath);
  if (primary.kind === 'ready') {
    await confirmLastGood(filePath, primary.bytes);
    return primary.state;
  }
  if (primary.kind === 'newer') throw unavailable(filePath, 'newer_version');

  const lastGood = await readLedgerFile(createMigrationsLastGoodPath(filePath));
  if (primary.kind === 'missing' && lastGood.kind === 'missing') {
    return { version: MIGRATION_STATE_VERSION };
  }
  if (primary.kind === 'damaged')
    await keepDamagedCopy(filePath, primary.bytes);
  if (lastGood.kind !== 'ready') throw unavailable(filePath, 'damaged');

  await writeLedgerFile(filePath, lastGood.bytes);
  confirmedLastGood.set(filePath, lastGood.bytes);
  logMainProcessWarn(
    '[migrations] Restored the migration ledger from its last-good copy',
    { primary: primary.kind },
  );
  return lastGood.state;
}

/**
 * Whether `migrationKey` completed. Rejects with
 * {@link MigrationLedgerUnavailableError} when the ledger cannot be trusted,
 * so the caller skips its migration for this run.
 */
export async function hasMigrationRun(migrationKey: string): Promise<boolean> {
  if (migrationKey === 'version') {
    return false;
  }
  const filePath = getMigrationsFilePath();
  const key = completionKey(filePath, migrationKey);
  return serialized(async (): Promise<boolean> => {
    if (unrecordedCompletions.has(key)) return true;
    const state = await loadLedger(filePath);
    return state[migrationKey] === true;
  });
}

/**
 * Record that `migrationKey` completed. Call only after the migration
 * succeeds. Last-good is written first, so it never lacks a marker the
 * primary has. If either write fails, the completion is still remembered
 * for this process and the error is rethrown.
 */
export async function markMigrationRun(migrationKey: string): Promise<void> {
  if (migrationKey === 'version') {
    throw new TypeError('"version" is not a migration key');
  }
  const filePath = getMigrationsFilePath();
  await serialized(async (): Promise<void> => {
    try {
      const state = await loadLedger(filePath);
      if (state[migrationKey] === true) return;
      const content = `${JSON.stringify({ ...state, [migrationKey]: true }, null, 2)}\n`;
      const folder = dirname(filePath);
      await createDirectoryDurably(folder, { dataRoot: folder });
      await writeLedgerFile(createMigrationsLastGoodPath(filePath), content);
      await writeLedgerFile(filePath, content);
      confirmedLastGood.set(filePath, Buffer.from(content, 'utf8'));
    } catch (error) {
      // Inside the queue, so a read queued behind this mark sees it.
      unrecordedCompletions.add(completionKey(filePath, migrationKey));
      throw error;
    }
  });
}
