import { lstat, mkdir, open } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import type {
  PlatformSecureFileServices,
  PlatformServices,
} from '../../../platform/platform-services';
import type {
  VaultIoClass,
  VaultMutationFailure,
  VaultSecretRef,
} from '../../../vault/contracts';
import { readSealedBox } from './aes-gcm';
import { isLiveMigrationIntent } from './migration-intent';
import { VAULT_RECORD_FORMAT } from './record-format';
import {
  checkpointWal,
  closeVaultStoreDatabase,
  hasRecords,
  openVaultStoreDatabase,
  readDurability,
  vaultStoreUnavailable,
  type VaultCheckpointHook,
  type VaultStoreDurability,
  type VaultStoreUnavailable,
} from './store-database';
import {
  decodeEntry,
  decodeIntent,
  decodeTombstone,
  isRevision,
  snapshotEntry,
  snapshotIntent,
  utf8Bytes,
  type VaultEntryDraft,
  type VaultHeaderDraft,
  type VaultIntentDraft,
  type VaultStoredEntry,
  type VaultStoredHeader,
  type VaultStoredIntent,
  type VaultStoredTombstone,
} from './store-records';
import { isVaultId } from './vault-keys';

/*
 * The vault's durable store (CAN-4500 unit B). Each write is one synchronous
 * SQLite transaction inside the call, so an intent is durable before the
 * caller's promise exists. The daemon vault composition owns its lifetime.
 */

export const VAULT_STORE_FILE = 'vault.sqlite';

export type VaultStoreWriteStep =
  /** The store is faulted or closed, or a write is already in progress. */
  | 'store'
  /** The header, intent or entry state does not admit this write. */
  | 'precondition'
  /** BEGIN or a statement failed; the transaction rolled back. */
  | 'write'
  /** COMMIT (its sync) failed; it may have landed. */
  | 'commit'
  /** The header committed, but may not be in the database file. */
  | 'checkpoint';

/**
 * Every failed write. `not_written`: nothing changed. `uncertain`: the commit
 * may have landed, or landed only in the WAL, and the store faults until it is
 * reopened. `step` is internal context, never a branch for callers.
 */
export interface VaultStoreWriteFailure {
  readonly kind: 'not_written' | 'uncertain';
  readonly step: VaultStoreWriteStep;
  /** Set when SQLite threw at `write`; diagnostic only. */
  readonly io?: VaultIoClass;
}

export type VaultStoreWrite<T> =
  | { readonly kind: 'written'; readonly value: T }
  | VaultStoreWriteFailure;

function writeFailure(
  kind: VaultStoreWriteFailure['kind'],
  step: VaultStoreWriteStep,
  io?: VaultIoClass,
): VaultStoreWriteFailure {
  return Object.freeze(io ? { kind, step, io } : { kind, step });
}

/** Test seam only; production passes none. A hook throws to inject its fault. */
export interface VaultStoreFaults {
  /** Inside the transaction, before its first statement. */
  readonly beforeWrite?: () => void;
  /** After every statement, before COMMIT: written, not yet synced. */
  readonly beforeSync?: () => void;
  /** Wraps COMMIT; throwing before or after `commit()` is a sync error. */
  readonly sync?: (commit: () => void) => void;
  /** Wraps each WAL checkpoint: after a header or tombstone commits, and at each open of a store with a header. */
  readonly checkpoint?: VaultCheckpointHook;
}

export interface VaultStoreOpenOptions {
  /** The vault's own folder, from the caller; its parent must be private. */
  readonly folder: string;
  readonly platform: Pick<PlatformServices, 'os' | 'secureFiles'>;
  readonly openBusyTimeoutMs?: number;
  readonly clock?: () => Date;
  readonly faults?: VaultStoreFaults;
}

/** Internal authenticated journal CAS; bytes are validated by migration-storage. */
export interface VaultMigrationUpdate {
  readonly expected: string | null;
  readonly next: string;
}

const MIGRATION_KEY = 'copilot_migration_v1';
const MIGRATION_MARKER = 'copilot_migration_format';
const AUTHORITY_KEY = 'copilot_authority_v1';
const AUTHORITY_MARKER = 'copilot_authority_format';

export interface VaultStore {
  /** Null until `writeHeader` commits; a store without one holds no record. */
  readonly header: VaultStoredHeader | null;
  readonly state: 'open' | 'faulted' | 'closed';
  /** Only into an empty store, once its key slot exists (Q4c item 7). */
  writeHeader(draft: VaultHeaderDraft): VaultStoreWrite<VaultStoredHeader>;
  recordIntent(
    draft: VaultIntentDraft,
    migration?: VaultMigrationUpdate,
  ): VaultStoreWrite<VaultStoredIntent>;
  /** Balanced begin/end fence; concurrent retries share the same intent. */
  setIntentRunning(sequence: number, running: boolean): void;
  isIntentRunning(sequence: number): boolean;
  readCopilotAuthority(): string | null;
  writeCopilotAuthority(update: VaultMigrationUpdate): VaultStoreWrite<void>;
  readMigrationJournal(): string | null;
  writeMigrationJournal(update: VaultMigrationUpdate): VaultStoreWrite<void>;
  /** Writes the revision and settles its pending put intent. */
  commitEntry(
    sequence: number,
    draft: VaultEntryDraft,
  ): VaultStoreWrite<VaultStoredEntry>;
  /**
   * Erases the entry's row and settles its pending delete intent (Q5 rule 5),
   * then checkpoints so the ciphertext leaves the files on disk.
   */
  commitTombstone(
    sequence: number,
    revision: number,
  ): VaultStoreWrite<VaultStoredTombstone>;
  /**
   * Retention (unit E): removes each named tombstone and any row behind it,
   * then checkpoints. The entry's intents stay, so its accepted keys keep
   * replaying and its committed delete keeps it closed. A tombstone without a
   * committed delete intent is kept. Returns how many tombstones it removed.
   */
  pruneTombstones(entryIds: readonly string[]): VaultStoreWrite<number>;
  /**
   * Reconnects a faulted store to its existing file, which shows what an
   * uncertain write left (unit E). True once the store is open. One attempt
   * only: a store that cannot reopen (a missing file, another header, a busy
   * lock) is closed for good. One without a header never reopens.
   */
  reopen(): boolean;
  // Reads throw once the store is faulted or closed.
  listEntries(): readonly VaultStoredEntry[];
  readEntry(entryId: string): VaultStoredEntry | null;
  listIntents(): readonly VaultStoredIntent[];
  findIntent(family: string, idempotencyKey: string): VaultStoredIntent | null;
  readTombstone(entryId: string): VaultStoredTombstone | null;
  listTombstones(): readonly VaultStoredTombstone[];
  durability(): VaultStoreDurability;
  /** Releases the exclusive lock. Idempotent. */
  close(): void;
}

export type VaultStoreOpenResult =
  | { readonly kind: 'opened'; readonly store: VaultStore }
  | VaultStoreUnavailable;

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null
    ? Reflect.get(error, 'code')
    : undefined;
}

const ERRNO_IO_CLASSES: ReadonlyMap<string, VaultIoClass> = new Map([
  ['ENOSPC', 'no_space'],
  ['EDQUOT', 'no_space'],
  ['EFBIG', 'no_space'],
  ['EACCES', 'access_denied'],
  ['EPERM', 'not_permitted'],
  ['EROFS', 'read_only'],
  ['EIO', 'io'],
  ['EBUSY', 'busy'],
]);
// SQLite primary result codes (the low byte of an extended code).
const SQLITE_IO_CLASSES: ReadonlyMap<number, VaultIoClass> = new Map([
  [3, 'not_permitted'], // SQLITE_PERM
  [5, 'busy'], // SQLITE_BUSY
  [6, 'busy'], // SQLITE_LOCKED
  [8, 'read_only'], // SQLITE_READONLY
  [10, 'io'], // SQLITE_IOERR
  [13, 'no_space'], // SQLITE_FULL
  [23, 'access_denied'], // SQLITE_AUTH
]);

/** Closed class of a thrown filesystem or SQLite error; drops its message. */
export function vaultIoClass(error: unknown): VaultIoClass {
  if (typeof error !== 'object' || error === null) return 'other';
  const code: unknown = Reflect.get(error, 'code');
  const errno =
    typeof code === 'string' ? ERRNO_IO_CLASSES.get(code) : undefined;
  if (errno) return errno;
  const errcode: unknown = Reflect.get(error, 'errcode');
  if (typeof errcode === 'number' && Number.isInteger(errcode))
    return SQLITE_IO_CLASSES.get(errcode & 0xff) ?? 'other';
  return 'other';
}

/** A failed write as an `unavailable` outcome; only a thrown call has a class. */
export function vaultStoreUnavailableOutcome(
  ref: VaultSecretRef,
  written: VaultStoreWriteFailure,
): Extract<VaultMutationFailure, { readonly kind: 'unavailable' }> {
  return written.io && written.step === 'write'
    ? { kind: 'unavailable', ref, step: written.step, io: written.io }
    : { kind: 'unavailable', ref };
}

async function createExclusive(create: () => Promise<unknown>): Promise<void> {
  try {
    await create();
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
  }
}

async function isPrivate(
  secureFiles: PlatformSecureFileServices,
  path: string,
  kind: 'file' | 'directory',
): Promise<boolean> {
  try {
    const result = await secureFiles.permissions({
      path,
      kind,
      mode: 'owner-only',
      action: 'restrict',
    });
    return result.state === 'private';
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

// A journal without its database is a vault whose file was lost: SQLite
// would discard the journal and start empty (plan Q4c item 7).
async function isOrphanedJournal(databasePath: string): Promise<boolean> {
  if (await exists(databasePath)) return false;
  return (
    (await exists(`${databasePath}-wal`)) ||
    (await exists(`${databasePath}-journal`))
  );
}

// The database file is created owner-only before SQLite writes a byte; its
// WAL inherits that mode.
async function prepareFolder(
  folder: string,
  databasePath: string,
  secureFiles: PlatformSecureFileServices,
): Promise<VaultStoreUnavailable | null> {
  try {
    await createExclusive(() => mkdir(folder, { mode: 0o700 }));
  } catch (error) {
    return vaultStoreUnavailable('folder', vaultIoClass(error));
  }
  if (!(await isPrivate(secureFiles, folder, 'directory')))
    return vaultStoreUnavailable('permissions');
  let orphaned: boolean;
  try {
    orphaned = await isOrphanedJournal(databasePath);
  } catch (error) {
    return vaultStoreUnavailable('folder', vaultIoClass(error));
  }
  if (orphaned) return vaultStoreUnavailable('init_state');
  try {
    await createExclusive(async () => {
      const handle = await open(databasePath, 'wx', 0o600);
      await handle.close();
    });
  } catch (error) {
    return vaultStoreUnavailable('folder', vaultIoClass(error));
  }
  if (!(await isPrivate(secureFiles, databasePath, 'file')))
    return vaultStoreUnavailable('permissions');
  try {
    // Flushes the folder and file entries on every open, which is cheap and
    // covers a creation an earlier open did not finish. Steady-state writes
    // never sync a folder. Windows flushes with CAN-5151 D1's label.
    await secureFiles.syncDirectory(dirname(folder));
    await secureFiles.syncDirectory(folder);
  } catch (error) {
    return vaultStoreUnavailable('folder', vaultIoClass(error));
  }
  return null;
}

/** Opens or creates the store; every failure is the one `store_unavailable`. */
export async function openVaultStore(
  options: VaultStoreOpenOptions,
): Promise<VaultStoreOpenResult> {
  const { folder, platform, openBusyTimeoutMs = 2_000 } = options;
  if (typeof folder !== 'string' || !isAbsolute(folder))
    throw new TypeError('The vault folder must be an absolute path.');
  const databasePath = join(folder, VAULT_STORE_FILE);
  const refused = await prepareFolder(
    folder,
    databasePath,
    platform.secureFiles,
  );
  if (refused) return refused;
  const opened = openVaultStoreDatabase(databasePath, {
    os: platform.os,
    openBusyTimeoutMs,
    checkpoint: options.faults?.checkpoint,
  });
  if (!('db' in opened)) return opened;
  return {
    kind: 'opened',
    store: createVaultStore(opened.db, opened.header, databasePath, options),
  };
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function sameHeader(
  left: VaultStoredHeader | null,
  right: VaultStoredHeader,
): boolean {
  return (
    left !== null &&
    left.vaultId === right.vaultId &&
    left.createdAt === right.createdAt &&
    sameBytes(left.wrappedDataKey.nonce, right.wrappedDataKey.nonce) &&
    sameBytes(
      left.wrappedDataKey.ciphertext,
      right.wrappedDataKey.ciphertext,
    ) &&
    sameBytes(left.wrappedDataKey.tag, right.wrappedDataKey.tag)
  );
}

const REFUSED = Symbol('vault store precondition');

/** BLOB bytes for text a snapshot already validated. */
function storedText(value: string): Uint8Array {
  const bytes = utf8Bytes(value);
  if (bytes === null) throw new TypeError('Invalid vault text.');
  return bytes;
}

function createVaultStore(
  initialDb: DatabaseSync,
  initialHeader: VaultStoredHeader | null,
  databasePath: string,
  options: VaultStoreOpenOptions,
): VaultStore {
  const faults = options.faults ?? {};
  const clock = options.clock ?? ((): Date => new Date());
  let db = initialDb;
  let header = initialHeader;
  let state: VaultStore['state'] = 'open';

  function now(): string {
    return clock().toISOString();
  }

  function rollback(
    step: VaultStoreWriteStep,
    io?: VaultIoClass,
  ): VaultStoreWriteFailure {
    try {
      if (db.isTransaction) db.exec('ROLLBACK');
    } catch {
      // Nothing committed, but the connection's state is now unknown.
      state = 'faulted';
    }
    return writeFailure('not_written', step, io);
  }

  function write<T>(run: () => T | typeof REFUSED): VaultStoreWrite<T> {
    // A write re-entered from a hook or clock must not roll back the outer one.
    if (state !== 'open' || db.isTransaction)
      return writeFailure('not_written', 'store');
    let value: T | typeof REFUSED;
    try {
      db.exec('BEGIN IMMEDIATE');
      faults.beforeWrite?.();
      value = run();
      faults.beforeSync?.();
    } catch (error) {
      return rollback('write', vaultIoClass(error));
    }
    if (value === REFUSED) return rollback('precondition');
    try {
      const commit = (): void => db.exec('COMMIT');
      if (faults.sync) faults.sync(commit);
      else commit();
    } catch {
      // The outcome_unknown path: only a reopen shows what landed.
      state = 'faulted';
      rollback('commit');
      return writeFailure('uncertain', 'commit');
    }
    return { kind: 'written', value };
  }

  // A header that may be only in the WAL is not reported written; the open
  // after the fault checkpoints it again.
  function checkpointHeader(): boolean {
    try {
      if (checkpointWal(db, faults.checkpoint)) return true;
    } catch {
      // Same outcome as an incomplete checkpoint.
    }
    state = 'faulted';
    return false;
  }

  // Until a checkpoint the database file keeps the erased ciphertext and the
  // WAL keeps the frames that wrote it. Best effort: the tombstone is already
  // durable, and every open checkpoints again.
  function flushErasure(): void {
    try {
      checkpointWal(db, faults.checkpoint);
    } catch {
      // Same outcome as an incomplete checkpoint.
    }
  }

  function readable(): DatabaseSync {
    if (state !== 'open') throw new Error('The vault store is unavailable.');
    return db;
  }

  function pendingIntent(
    sequence: number,
    kind: VaultIntentDraft['kind'],
  ): VaultStoredIntent | null {
    const row = db
      .prepare(
        `SELECT * FROM vault_intents
          WHERE sequence = ? AND kind = ? AND state = 'pending'`,
      )
      .get(sequence, kind);
    return row ? decodeIntent(row) : null;
  }

  // The schema trigger refuses these too; this check does not depend on it.
  function isTombstoned(entryId: Uint8Array): boolean {
    return (
      db
        .prepare('SELECT 1 AS found FROM vault_tombstones WHERE entry_id = ?')
        .get(entryId) !== undefined
    );
  }

  // Outlives the tombstone, so a pruned entry is never written again.
  function hasCommittedDelete(entryId: Uint8Array): boolean {
    return (
      db
        .prepare(
          `SELECT 1 AS found FROM vault_intents
            WHERE entry_id = ? AND kind = 'delete' AND state = 'committed'`,
        )
        .get(entryId) !== undefined
    );
  }

  function settleIntent(sequence: number, revision: number): void {
    db.prepare(
      `UPDATE vault_intents SET state = 'committed', outcome_revision = ?
        WHERE sequence = ?`,
    ).run(revision, sequence);
  }

  function readEntry(entryId: string): VaultStoredEntry | null {
    const store = readable();
    const id = utf8Bytes(entryId);
    if (id === null) return null;
    const row = store
      .prepare('SELECT * FROM vault_entries WHERE entry_id = ?')
      .get(id);
    return row ? decodeEntry(row) : null;
  }

  const runningIntents = new Map<number, number>();

  function readCopilotAuthority(): string | null {
    const rows = readable()
      .prepare('SELECT key, value FROM vault_meta WHERE key IN (?, ?)')
      .all(AUTHORITY_KEY, AUTHORITY_MARKER);
    if (rows.length === 0) return null;
    const payload = rows.find((row) => row.key === AUTHORITY_KEY)?.value;
    const marker = rows.find((row) => row.key === AUTHORITY_MARKER)?.value;
    if (rows.length !== 2 || marker !== '1' || typeof payload !== 'string')
      throw new Error('Copilot authority metadata is unavailable.');
    return payload;
  }

  function readMigrationJournal(): string | null {
    const rows = readable()
      .prepare('SELECT key, value FROM vault_meta WHERE key IN (?, ?)')
      .all(MIGRATION_KEY, MIGRATION_MARKER);
    if (rows.length === 0) return null;
    const journal = rows.find((row) => row.key === MIGRATION_KEY)?.value;
    const marker = rows.find((row) => row.key === MIGRATION_MARKER)?.value;
    if (rows.length !== 2 || marker !== '1' || typeof journal !== 'string')
      throw new Error('Migration metadata is unavailable.');
    return journal;
  }

  function updateMigration(update: VaultMigrationUpdate): boolean {
    if (header === null || readMigrationJournal() !== update.expected)
      return false;
    if (typeof update.next !== 'string' || update.next.length > 1_048_576)
      throw new TypeError('Invalid migration metadata.');
    db.prepare(
      'INSERT OR REPLACE INTO vault_meta (key, value) VALUES (?, ?)',
    ).run(MIGRATION_KEY, update.next);
    db.prepare(
      'INSERT OR IGNORE INTO vault_meta (key, value) VALUES (?, ?)',
    ).run(MIGRATION_MARKER, '1');
    return true;
  }

  return {
    readCopilotAuthority,
    writeCopilotAuthority(update): VaultStoreWrite<void> {
      return write(() => {
        if (header === null || readCopilotAuthority() !== update.expected)
          return REFUSED;
        if (
          typeof update.next !== 'string' ||
          Buffer.byteLength(update.next) > 262144
        )
          throw new TypeError('Invalid Copilot authority metadata.');
        db.prepare(
          'INSERT OR REPLACE INTO vault_meta (key, value) VALUES (?, ?)',
        ).run(AUTHORITY_KEY, update.next);
        db.prepare(
          'INSERT OR IGNORE INTO vault_meta (key, value) VALUES (?, ?)',
        ).run(AUTHORITY_MARKER, '1');
      });
    },
    get header(): VaultStoredHeader | null {
      return header;
    },
    get state(): VaultStore['state'] {
      return state;
    },

    writeHeader(draft): VaultStoreWrite<VaultStoredHeader> {
      const { vaultId, wrappedDataKey } = draft;
      const box = readSealedBox(wrappedDataKey);
      if (!isVaultId(vaultId) || box === null)
        throw new TypeError('Invalid vault header.');
      const result = write((): VaultStoredHeader | typeof REFUSED => {
        if (header !== null || hasRecords(db)) return REFUSED;
        const stored: VaultStoredHeader = {
          vaultId,
          wrappedDataKey: {
            nonce: Uint8Array.from(box.nonce),
            ciphertext: Uint8Array.from(box.ciphertext),
            tag: Uint8Array.from(box.tag),
          },
          createdAt: now(),
        };
        db.prepare(
          `INSERT INTO vault_header (singleton, format_version, vault_id,
            wrap_nonce, wrap_ciphertext, wrap_tag, created_at)
            VALUES (1, ?, ?, ?, ?, ?, ?)`,
        ).run(
          VAULT_RECORD_FORMAT.version,
          vaultId,
          stored.wrappedDataKey.nonce,
          stored.wrappedDataKey.ciphertext,
          stored.wrappedDataKey.tag,
          stored.createdAt,
        );
        return stored;
      });
      if (result.kind !== 'written') return result;
      if (!checkpointHeader()) return writeFailure('uncertain', 'checkpoint');
      header = result.value;
      return result;
    },

    setIntentRunning(sequence, running): void {
      const count = (runningIntents.get(sequence) ?? 0) + (running ? 1 : -1);
      if (count > 0) runningIntents.set(sequence, count);
      else runningIntents.delete(sequence);
    },
    isIntentRunning: (sequence) => runningIntents.has(sequence),
    readMigrationJournal,
    writeMigrationJournal(update): VaultStoreWrite<void> {
      return write(() => (updateMigration(update) ? undefined : REFUSED));
    },

    recordIntent(draft, migration): VaultStoreWrite<VaultStoredIntent> {
      const intent = snapshotIntent(draft);
      const idempotencyKey = storedText(intent.idempotencyKey);
      const entryId = storedText(intent.entryId);
      return write((): VaultStoredIntent | typeof REFUSED => {
        if (header === null) return REFUSED;
        // A migration import binds its minted ID in the same intent transaction.
        if (migration !== undefined) {
          if (
            intent.kind !== 'put' ||
            intent.family !== 'copilot-account' ||
            intent.expectedRevision !== null ||
            !updateMigration(migration)
          )
            return REFUSED;
          if (
            db
              .prepare('SELECT 1 FROM vault_entries WHERE family = ?')
              .get(intent.family) ||
            db
              .prepare('SELECT * FROM vault_intents ORDER BY sequence')
              .all()
              .map(decodeIntent)
              .some(
                (item, _index, intents) =>
                  item.family === intent.family &&
                  isLiveMigrationIntent(item, intents, (sequence) =>
                    runningIntents.has(sequence),
                  ),
              )
          )
            return REFUSED;
        }
        if (
          intent.family === 'copilot-account' &&
          intent.idempotencyKey.startsWith('copilot-migration:') &&
          migration === undefined
        )
          return REFUSED;
        const recordedAt = now();
        const { lastInsertRowid } = db
          .prepare(
            `INSERT INTO vault_intents (kind, family, idempotency_key,
              entry_id, expected_revision, receipt, state, recorded_at)
              VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
          )
          .run(
            intent.kind,
            intent.family,
            idempotencyKey,
            entryId,
            intent.expectedRevision,
            intent.receipt,
            recordedAt,
          );
        return {
          ...intent,
          sequence: Number(lastInsertRowid),
          state: 'pending',
          outcomeRevision: null,
          recordedAt,
        };
      });
    },

    commitEntry(sequence, draft): VaultStoreWrite<VaultStoredEntry> {
      if (!isRevision(sequence))
        throw new TypeError('Invalid intent sequence.');
      if (header === null) return writeFailure('not_written', 'precondition');
      const entry = snapshotEntry(draft, header.vaultId);
      const entryId = storedText(entry.entryId);
      const label = storedText(entry.label);
      return write((): VaultStoredEntry | typeof REFUSED => {
        const intent = pendingIntent(sequence, 'put');
        if (
          intent === null ||
          intent.entryId !== entry.entryId ||
          intent.family !== entry.family ||
          isTombstoned(entryId) ||
          hasCommittedDelete(entryId)
        )
          return REFUSED;
        const at = now();
        // An entry's family is fixed: a mismatched replace updates nothing.
        const { changes } = db
          .prepare(
            `INSERT INTO vault_entries (entry_id, family, revision, expires_at,
              label, nonce, ciphertext, tag, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (entry_id) DO UPDATE SET revision = excluded.revision,
                expires_at = excluded.expires_at, label = excluded.label,
                nonce = excluded.nonce, ciphertext = excluded.ciphertext,
                tag = excluded.tag, updated_at = excluded.updated_at
              WHERE family = excluded.family`,
          )
          .run(
            entryId,
            entry.family,
            entry.revision,
            entry.expiresAt,
            label,
            entry.sealed.nonce,
            entry.sealed.ciphertext,
            entry.sealed.tag,
            at,
            at,
          );
        if (Number(changes) !== 1) return REFUSED;
        settleIntent(sequence, entry.revision);
        return readEntry(entry.entryId) ?? REFUSED;
      });
    },

    commitTombstone(sequence, revision): VaultStoreWrite<VaultStoredTombstone> {
      if (!isRevision(sequence) || !isRevision(revision))
        throw new TypeError('Invalid vault tombstone.');
      const result = write((): VaultStoredTombstone | typeof REFUSED => {
        const intent = pendingIntent(sequence, 'delete');
        if (header === null || intent === null) return REFUSED;
        const tombstone: VaultStoredTombstone = {
          entryId: intent.entryId,
          family: intent.family,
          revision,
          sequence,
          committedAt: now(),
        };
        const entryId = storedText(tombstone.entryId);
        if (hasCommittedDelete(entryId)) return REFUSED;
        db.prepare('DELETE FROM vault_entries WHERE entry_id = ?').run(entryId);
        db.prepare(
          `INSERT INTO vault_tombstones (entry_id, family, revision, sequence,
            committed_at) VALUES (?, ?, ?, ?, ?)`,
        ).run(
          entryId,
          tombstone.family,
          tombstone.revision,
          tombstone.sequence,
          tombstone.committedAt,
        );
        settleIntent(sequence, revision);
        return tombstone;
      });
      if (result.kind === 'written') flushErasure();
      return result;
    },

    pruneTombstones(entryIds): VaultStoreWrite<number> {
      const ids = entryIds.map(storedText);
      const result = write((): number | typeof REFUSED => {
        if (header === null) return REFUSED;
        let pruned = 0;
        for (const entryId of ids) {
          // Only its committed delete intent keeps a pruned entry closed.
          if (!hasCommittedDelete(entryId)) continue;
          const { changes } = db
            .prepare('DELETE FROM vault_tombstones WHERE entry_id = ?')
            .run(entryId);
          if (Number(changes) === 0) continue;
          pruned += 1;
          // A row behind a tombstone is a tamper or a partial rollback;
          // removing the tombstone must not bring it back.
          db.prepare('DELETE FROM vault_entries WHERE entry_id = ?').run(
            entryId,
          );
        }
        return pruned;
      });
      if (result.kind === 'written' && result.value > 0) flushErasure();
      return result;
    },

    reopen(): boolean {
      if (state !== 'faulted') return state === 'open';
      if (header === null) return false;
      // Closing gives up the exclusive lock, so a failed attempt is final:
      // a later one could find the file written by another process.
      state = 'closed';
      closeVaultStoreDatabase(db);
      const reopened = openVaultStoreDatabase(databasePath, {
        os: options.platform.os,
        // Runs inside a write call, so it never waits on another holder.
        openBusyTimeoutMs: 0,
        checkpoint: faults.checkpoint,
        existing: true,
      });
      if (!('db' in reopened)) return false;
      if (!sameHeader(reopened.header, header)) {
        closeVaultStoreDatabase(reopened.db);
        return false;
      }
      db = reopened.db;
      state = 'open';
      return true;
    },

    listEntries(): readonly VaultStoredEntry[] {
      return readable()
        .prepare('SELECT * FROM vault_entries ORDER BY entry_id')
        .all()
        .map(decodeEntry);
    },
    readEntry,
    listIntents(): readonly VaultStoredIntent[] {
      return readable()
        .prepare('SELECT * FROM vault_intents ORDER BY sequence')
        .all()
        .map(decodeIntent);
    },
    findIntent(family, idempotencyKey): VaultStoredIntent | null {
      const store = readable();
      const key = utf8Bytes(idempotencyKey);
      if (key === null) return null;
      const row = store
        .prepare(
          'SELECT * FROM vault_intents WHERE family = ? AND idempotency_key = ?',
        )
        .get(family, key);
      return row ? decodeIntent(row) : null;
    },
    readTombstone(entryId): VaultStoredTombstone | null {
      const store = readable();
      const id = utf8Bytes(entryId);
      if (id === null) return null;
      const row = store
        .prepare('SELECT * FROM vault_tombstones WHERE entry_id = ?')
        .get(id);
      return row ? decodeTombstone(row) : null;
    },
    listTombstones(): readonly VaultStoredTombstone[] {
      return readable()
        .prepare('SELECT * FROM vault_tombstones ORDER BY sequence')
        .all()
        .map(decodeTombstone);
    },
    durability(): VaultStoreDurability {
      return readDurability(readable());
    },
    close(): void {
      state = 'closed';
      closeVaultStoreDatabase(db);
    },
  };
}
