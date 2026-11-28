import { randomBytes } from 'node:crypto';
import { readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';

import {
  STORAGE_OWNERSHIP,
  evaluateStorageWrite,
  type StorageOwnershipRow,
  type StorageTransitionOwner,
} from '../../storage';
import {
  validateNamespaceBackupRecord,
  type NamespaceBackupRecord,
} from '../../storage/backup-record';
import {
  namespaceBackupRecordPath,
  storageRecordsFolder,
  type OwnerFlipRecord,
} from '../../storage/owner-records';
import {
  persistNamespaceBackupRecord,
  readOwnerFlipRecord,
  writeOwnerFlipRecord,
} from '../storage-records';
import {
  fileSetDigest,
  fileSetManifest,
  resolveInsideDataRoot,
} from '../file-set-backup';
import { isRecord } from '../w5/commit-log/is-record';
import {
  isMissingDocumentError,
  logPreferencesWarning,
  type PreferencesLog,
} from './document';
import {
  PREFERENCES_BACKUPS_FOLDER,
  PREFERENCES_FAMILY_FILES,
  PREFERENCES_NAMESPACE_ID,
} from './family';
import { backupPreferences } from './preferences-backup';
import type { PreferencesRepository } from './repository';
import { PREFERENCES_FLIP_ENVELOPE_VERSION } from './silent-restore';

/*
 * The preferences owner-flip activation (CAN-8052, CAN-5722 slice R, r4
 * section 5.1, T8 steps 1 to 6). Inert: nothing calls it, and under the
 * compiled rows, where the row is legacy, it returns `inert` without reading
 * or writing anything. A failed backup never stops the flip (Q1b): the
 * daemon writes version 2 and serves, and every later launch retries the
 * backup and the owner record, which `writeOwnerFlipRecord` refuses without
 * a fresh verified backup.
 */

type SyncDirectory = (path: string) => Promise<'flushed' | 'unsupported'>;

/** Where a test can stop an activation, as a crash would. */
export type PreferencesOwnerFlipCheckpoint =
  | 'quiesced'
  | 'backed-up'
  | 'written'
  | 'recorded';

export interface PreferencesOwnerFlipOptions<T extends object> {
  readonly dataRoot: string;
  /**
   * The daemon document's repository (`createDaemonPreferences`), composed
   * with the same rows and envelope version 2.
   */
  readonly repository: Pick<
    PreferencesRepository<T>,
    'update' | 'hasPersistedState'
  >;
  /**
   * Host fact: labels of live processes on this data root that write
   * preferences themselves, as builds before the flip do. Any defers the
   * activation; a failure to list them defers it too.
   */
  readonly preFlipWriters: () => Promise<readonly string[]>;
  /**
   * Runs `operation` with every other preferences writer stopped. The
   * activation's own saves run inside it, and the host admits writes once it
   * returns (step 6).
   */
  readonly quiesce: <R>(operation: () => Promise<R>) => Promise<R>;
  /** Trusted host proof that a path is outside every checkout. */
  readonly isOutsideCheckouts: (dataRootRelativePath: string) => boolean;
  readonly syncDirectory: SyncDirectory;
  /** Host fact: a file flush needs a handle opened for writing (Windows). */
  readonly flushRequiresWriteHandle: boolean;
  /** Trusted composition only; defaults to the compiled ownership rows. */
  readonly ownership?: readonly StorageOwnershipRow[];
  readonly clock?: () => number;
  readonly log: PreferencesLog;
  readonly checkpoint?: (
    point: PreferencesOwnerFlipCheckpoint,
  ) => void | Promise<void>;
}

/** The step an activation that served without its owner record retries. */
export type PreferencesOwnerFlipPendingStep = 'backup' | 'envelope' | 'record';

/**
 * Every outcome but `inert` and `deferred` admits the daemon's writes, which
 * still pass the row's owner record check.
 */
export type PreferencesOwnerFlipOutcome =
  /** The rows don't make the daemon the row's writer; nothing was read. */
  | { readonly kind: 'inert' }
  /** A writer from before the flip is live; nothing was written. */
  | { readonly kind: 'deferred'; readonly peers: readonly string[] }
  /** An earlier launch recorded the daemon as the owner. */
  | { readonly kind: 'active' }
  /** The owner record names another owner, as a rollback leaves it. */
  | { readonly kind: 'owned-elsewhere'; readonly owner: StorageTransitionOwner }
  | { readonly kind: 'record-unreadable'; readonly reason: string }
  /** This launch took the backup, wrote version 2 and recorded the owner. */
  | {
      readonly kind: 'activated';
      readonly backup: NamespaceBackupRecord;
      readonly record: OwnerFlipRecord;
    }
  /** Serving without the owner record; the next launch retries. */
  | {
      readonly kind: 'pending';
      readonly step: PreferencesOwnerFlipPendingStep;
      readonly error: unknown;
    };

function hostPath(root: string, relative: string): string {
  return join(root, ...relative.split(posix.sep));
}

/** Whether the primary as stored, without recovery, is a version 2 envelope. */
async function storedPrimary(
  dataRoot: string,
): Promise<'absent' | 'version-2' | 'other'> {
  let text: string;
  try {
    text = await readFile(join(dataRoot, 'preferences.json'), 'utf8');
  } catch (error) {
    if (isMissingDocumentError(error)) return 'absent';
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) &&
      parsed.version === PREFERENCES_FLIP_ENVELOPE_VERSION
      ? 'version-2'
      : 'other';
  } catch {
    return 'other';
  }
}

/** The activation's own copies: `owner-flip-<stamp>-<random>`, nothing beside them. */
const OWNER_FLIP_COPY = /^owner-flip-\d{8}T\d{9}Z-[0-9a-f]{8}$/;

type PersistedBackup =
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'record'; readonly value: Record<string, unknown> };

async function persistedBackup(dataRoot: string): Promise<PersistedBackup> {
  let text: string;
  try {
    text = await readFile(
      hostPath(dataRoot, namespaceBackupRecordPath(PREFERENCES_NAMESPACE_ID)),
      'utf8',
    );
  } catch (error) {
    return isMissingDocumentError(error)
      ? { kind: 'absent' }
      : { kind: 'unreadable' };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed)
      ? { kind: 'record', value: parsed }
      : { kind: 'unreadable' };
  } catch {
    return { kind: 'unreadable' };
  }
}

async function persistedBackupPath(
  dataRoot: string,
): Promise<string | undefined> {
  const persisted = await persistedBackup(dataRoot);
  return persisted.kind === 'record' &&
    typeof persisted.value.backupPath === 'string'
    ? persisted.value.backupPath
    : undefined;
}

/**
 * The persisted record of an earlier attempt's copy, when the copy still
 * matches it and the family hasn't changed since: a new backup would hold
 * the same bytes, so a launch that retries reuses it instead of adding one.
 */
async function unchangedBackup(
  dataRoot: string,
  rows: readonly StorageOwnershipRow[],
  isOutsideCheckouts: (dataRootRelativePath: string) => boolean,
): Promise<NamespaceBackupRecord | undefined> {
  const persisted = await persistedBackup(dataRoot);
  if (persisted.kind !== 'record') return undefined;
  const result = validateNamespaceBackupRecord(persisted.value, {
    rows,
    isOutsideCheckouts,
  });
  if (!result.ok) return undefined;
  const { record } = result;
  if (
    record.namespaceId !== PREFERENCES_NAMESPACE_ID ||
    posix.dirname(record.backupPath) !== PREFERENCES_BACKUPS_FOLDER ||
    !OWNER_FLIP_COPY.test(posix.basename(record.backupPath))
  )
    return undefined;
  try {
    const copy = await fileSetManifest(
      await resolveInsideDataRoot(dataRoot, record.backupPath),
    );
    const live = await familyDigests(dataRoot);
    if (
      copy.kind !== 'directory' ||
      copy.directories.length > 0 ||
      fileSetDigest(copy) !== record.verifiedBy.digest ||
      copy.files.length !== live.size ||
      copy.files.some(({ path, sha256 }) => live.get(path) !== sha256)
    )
      return undefined;
  } catch {
    return undefined;
  }
  return record;
}

/** Each family file's sha256 under the data root, by name; a missing file is left out. */
async function familyDigests(
  dataRoot: string,
): Promise<ReadonlyMap<string, string>> {
  const digests = new Map<string, string>();
  for (const name of PREFERENCES_FAMILY_FILES) {
    const manifest = await fileSetManifest(join(dataRoot, name));
    if (manifest.kind === 'directory')
      throw new Error(`${name} is a folder, not a preferences file.`);
    if (manifest.kind === 'file') digests.set(name, manifest.sha256);
  }
  return digests;
}

/**
 * Removes the activation's copies no persisted record cites, as a crash
 * between a copy and its record, or a later attempt's new copy, leaves them.
 * Best effort; nothing is removed while the persisted record can't be read.
 */
async function discardUncitedCopies(dataRoot: string): Promise<void> {
  const persisted = await persistedBackup(dataRoot);
  if (persisted.kind === 'unreadable') return;
  const cited =
    persisted.kind === 'record' ? persisted.value.backupPath : undefined;
  if (persisted.kind === 'record' && typeof cited !== 'string') return;
  let names: string[];
  try {
    names = await readdir(hostPath(dataRoot, PREFERENCES_BACKUPS_FOLDER));
  } catch {
    return;
  }
  for (const name of names) {
    const relative = `${PREFERENCES_BACKUPS_FOLDER}/${name}`;
    if (!OWNER_FLIP_COPY.test(name) || relative === cited) continue;
    // eslint-disable-next-line admitted-writers/no-unadmitted-write -- removes only an uncited owner-flip-* copy under backups/preferences, never a row file; remove when preferences-backup.ts discards uncited copies itself.
    await rm(hostPath(dataRoot, relative), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
  }
}

/**
 * T8 for the preferences row: unless the owner record already decides, and
 * with no writer from before the flip live, quiesce, take G's backup and
 * keep its record, write version 2, record the daemon as the owner, and
 * return so the host admits writes. An attempt reuses the persisted copy
 * while the family is unchanged since it was taken, and otherwise backs up
 * under a new name; a restart part-way repeats the steps not yet durable.
 */
export async function activatePreferencesOwnerFlip<T extends object>(
  options: PreferencesOwnerFlipOptions<T>,
): Promise<PreferencesOwnerFlipOutcome> {
  const { dataRoot, log, repository } = options;
  const rows: readonly StorageOwnershipRow[] =
    options.ownership ?? STORAGE_OWNERSHIP;
  const clock = options.clock ?? Date.now;
  if (!evaluateStorageWrite(PREFERENCES_NAMESPACE_ID, 'daemon', rows).allowed)
    return { kind: 'inert' };
  const owner = await readOwnerFlipRecord(dataRoot, PREFERENCES_NAMESPACE_ID);
  if (owner.kind === 'unreadable')
    return { kind: 'record-unreadable', reason: owner.reason };
  if (owner.kind === 'record') {
    if (owner.record.toOwner !== 'daemon')
      return { kind: 'owned-elsewhere', owner: owner.record.toOwner };
    await reflushRecord(options);
    return { kind: 'active' };
  }
  // Step 1: covers a mixed-version upgrade, not a downgrade.
  const peers = await options.preFlipWriters().then(
    (live) => live,
    (): readonly string[] => ['unknown'],
  );
  if (peers.length > 0) return { kind: 'deferred', peers };
  const writes = {
    syncDirectory: options.syncDirectory,
    isOutsideCheckouts: options.isOutsideCheckouts,
    ownership: rows,
  };
  const checkpoint = async (
    point: PreferencesOwnerFlipCheckpoint,
  ): Promise<void> => {
    await options.checkpoint?.(point);
  };

  const backUp = async (): Promise<NamespaceBackupRecord> => {
    await discardUncitedCopies(dataRoot);
    const unchanged = await unchangedBackup(
      dataRoot,
      rows,
      options.isOutsideCheckouts,
    );
    if (unchanged !== undefined) return unchanged;
    const stamp = new Date(clock()).toISOString().replace(/[-:.]/g, '');
    const name = `owner-flip-${stamp}-${randomBytes(4).toString('hex')}`;
    const record = await backupPreferences({
      dataRoot,
      name,
      isOutsideCheckouts: options.isOutsideCheckouts,
      syncDirectory: options.syncDirectory,
      flushRequiresWriteHandle: options.flushRequiresWriteHandle,
      // Already quiesced; the activation is the only writer.
      quiesce: (operation) => operation(),
      ownership: rows,
      clock,
    });
    try {
      await persistNamespaceBackupRecord(dataRoot, record, writes);
    } catch (error) {
      // A copy no record cites is never restored; one that may be cited stays.
      if ((await persistedBackupPath(dataRoot)) !== record.backupPath)
        // eslint-disable-next-line admitted-writers/no-unadmitted-write -- removes only this attempt's uncited copy under backups/preferences, never a row file; remove when preferences-backup.ts discards uncited copies itself.
        await rm(hostPath(dataRoot, record.backupPath), {
          recursive: true,
          force: true,
        }).catch(() => undefined);
      throw error;
    }
    return record;
  };

  const writeVersion2 = async (): Promise<void> => {
    const stored = await storedPrimary(dataRoot);
    if (stored === 'version-2') return;
    // A fresh profile has nothing to convert; its first save writes version 2.
    if (stored === 'absent' && !(await repository.hasPersistedState())) return;
    // Last-good follows through the refresher (Q2).
    await repository.update(() => ({}));
    if ((await storedPrimary(dataRoot)) !== 'version-2')
      throw new Error('The preferences were not saved at envelope version 2.');
  };

  return options.quiesce(async (): Promise<PreferencesOwnerFlipOutcome> => {
    await checkpoint('quiesced');
    let backup: NamespaceBackupRecord | undefined;
    let backupError: unknown;
    try {
      backup = await backUp();
    } catch (error) {
      backupError = error;
      log.error(
        'The preferences backup before the owner flip failed; the flip proceeds and the next launch retries it.',
        error,
      );
    }
    if (backup !== undefined) await checkpoint('backed-up');
    try {
      await writeVersion2();
    } catch (error) {
      log.error(
        'The preferences could not be saved at envelope version 2; the next launch retries the owner flip.',
        error,
      );
      return { kind: 'pending', step: 'envelope', error };
    }
    await checkpoint('written');
    if (backup === undefined)
      return { kind: 'pending', step: 'backup', error: backupError };
    let record: OwnerFlipRecord;
    try {
      const row = rows.find(({ id }) => id === PREFERENCES_NAMESPACE_ID);
      record = await writeOwnerFlipRecord(
        dataRoot,
        {
          namespaceId: PREFERENCES_NAMESPACE_ID,
          fromOwner: 'legacy',
          toOwner: 'daemon',
          workPackage: row?.workPackage ?? '',
          backupDigest: backup.verifiedBy.digest,
          flippedAt: new Date(clock()).toISOString(),
        },
        writes,
      );
    } catch (error) {
      log.error(
        'The preferences owner record could not be written; the next launch retries the backup and the record.',
        error,
      );
      return { kind: 'pending', step: 'record', error };
    }
    await discardUncitedCopies(dataRoot);
    await checkpoint('recorded');
    return { kind: 'activated', backup, record };
  });
}

/**
 * An earlier launch's record may be in place without its folder flushes,
 * when the flush after its rename failed. Best effort: the record decides
 * either way.
 */
async function reflushRecord(
  options: Pick<
    PreferencesOwnerFlipOptions<object>,
    'dataRoot' | 'syncDirectory' | 'log'
  >,
): Promise<void> {
  const folder = hostPath(
    options.dataRoot,
    storageRecordsFolder(PREFERENCES_NAMESPACE_ID),
  );
  try {
    for (const at of [folder, dirname(folder), options.dataRoot])
      if ((await options.syncDirectory(at)) !== 'flushed')
        throw new Error('A folder flush was not confirmed.');
  } catch (error) {
    logPreferencesWarning(
      options.log,
      'The preferences owner record could not be flushed again.',
      error,
    );
  }
}
