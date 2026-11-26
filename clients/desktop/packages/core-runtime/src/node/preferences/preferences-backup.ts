import { randomUUID } from 'node:crypto';
import {
  copyFile,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';

import {
  createNamespaceBackupRecord,
  namespaceBackupPathError,
  type NamespaceBackupRecord,
} from '../../storage/backup-record';
import { STORAGE_OWNERSHIP } from '../../storage/storage-ownership.generated';
import type { StorageOwnershipRow } from '../../storage/writer-authority';
import {
  FileSetBackupError,
  fileSetDigest,
  fileSetManifest,
  isOccupied,
  resolveInsideDataRoot,
  syncFile,
  whenMissing,
  type FileSetFile,
  type FileSetManifest,
} from '../file-set-backup';
import {
  PREFERENCES_BACKUPS_FOLDER,
  PREFERENCES_FAMILY_FILES,
  PREFERENCES_NAMESPACE_ID,
} from './family';

/*
 * Backup and restore of the preferences family (CAN-7924): the document, its
 * last-good copy, the generation record and the usage-data denial journal,
 * one storage row with one namespace_backup record, taken and restored
 * together while the family's writer is stopped. Dormant: no production code
 * calls it, and it issues a record only while the row is
 * required_before_flip.
 */

/** The rollback migration each record names: {@link restorePreferencesBackup}. */
export const PREFERENCES_ROLLBACK_MIGRATION = 'restorePreferencesBackup';

/** In the backup folder while a restore from it is unfinished. */
const RESTORE_JOURNAL = 'restore-journal.json';
const FAMILY = new Set<string>(PREFERENCES_FAMILY_FILES);
/** No dots, so no name is one of the dotted folders and files placed beside a backup. */
const BACKUP_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

interface FamilyOptions {
  /** The data root the family and its backups live in. */
  readonly dataRoot: string;
  /** Trusted host proof that a path is outside every checkout. */
  readonly isOutsideCheckouts: (dataRootRelativePath: string) => boolean;
  /**
   * The host's folder flush: its secure-files port's `syncDirectory`. Any
   * answer but `flushed` refuses the backup or the restore.
   */
  readonly syncDirectory: (path: string) => Promise<'flushed' | 'unsupported'>;
  /** Host fact: a file flush needs a handle opened for writing (Windows). */
  readonly flushRequiresWriteHandle: boolean;
  /**
   * Runs `operation` with the preferences writer stopped. The family has one
   * writer process and no cross-process lock, so this is the only exclusion.
   */
  readonly quiesce: <T>(operation: () => Promise<T>) => Promise<T>;
  /** The ownership rows records are checked against. */
  readonly ownership?: readonly StorageOwnershipRow[];
  readonly clock?: () => number;
}

export interface PreferencesBackupOptions extends FamilyOptions {
  /** The backup's folder name under {@link PREFERENCES_BACKUPS_FOLDER}. */
  readonly name: string;
}

/** What a confirmed restore is about to replace, logged before any change. */
export interface PreferencesNewerLoss {
  readonly backupPath: string;
  /** Files that differ from the backup; their contents are set aside. */
  readonly files: readonly string[];
}

export interface PreferencesRestoreOptions extends FamilyOptions {
  /**
   * Restores over preferences changed since the backup, setting the current
   * files aside. Only a person's explicit confirmation sets it; never choose
   * it automatically. `log` records the loss before anything changes.
   */
  readonly acceptNewerLoss?: {
    readonly confirmedBy: 'person';
    readonly log: (loss: PreferencesNewerLoss) => void;
  };
}

export interface PreferencesRestoreResult {
  /** Files this run replaced or removed. */
  readonly restored: readonly string[];
  /** Data-root-relative folder holding the replaced files, if any. */
  readonly setAside?: string;
}

type Flush = (folder: string) => Promise<void>;

function unverified(message: string): FileSetBackupError {
  return new FileSetBackupError('BACKUP_UNVERIFIED', message);
}

function confirmedFlush(syncDirectory: FamilyOptions['syncDirectory']): Flush {
  return async (folder) => {
    if ((await syncDirectory(folder)) !== 'flushed')
      throw unverified('A folder flush was not confirmed.');
  };
}

function hostPath(root: string, relative: string): string {
  return join(root, ...relative.split(posix.sep));
}

/** A file's sha256, or undefined when nothing is there. */
async function fileDigest(path: string): Promise<string | undefined> {
  const manifest = await fileSetManifest(path);
  if (manifest.kind === 'directory')
    throw unverified(`${path} is a folder, not a preferences file.`);
  return manifest.kind === 'file' ? manifest.sha256 : undefined;
}

/**
 * The family's files under `root`, shaped as the manifest of a folder holding
 * them, so it digests equal to the manifest of a backup folder.
 */
async function familyManifest(root: string): Promise<FileSetManifest> {
  const files: FileSetFile[] = [];
  for (const name of [...PREFERENCES_FAMILY_FILES].sort()) {
    const manifest = await fileSetManifest(join(root, name));
    if (manifest.kind === 'directory')
      throw unverified(`${name} is a folder, not a preferences file.`);
    if (manifest.kind === 'file')
      files.push({
        path: name,
        bytes: manifest.bytes,
        sha256: manifest.sha256,
      });
  }
  return { kind: 'directory', directories: [], files };
}

function filesOf(manifest: FileSetManifest): ReadonlyMap<string, string> {
  return new Map(
    manifest.kind === 'directory'
      ? manifest.files.map((file) => [file.path, file.sha256])
      : [],
  );
}

function assertRequiredBeforeFlip(rows: readonly StorageOwnershipRow[]): void {
  const row = rows.find(
    (candidate) => candidate.id === PREFERENCES_NAMESPACE_ID,
  );
  if (
    row?.backupPolicy !== 'required_before_flip' ||
    row.backupShape !== 'namespace_backup'
  )
    throw new FileSetBackupError(
      'NOT_REQUIRED_BEFORE_FLIP',
      'The preferences row is not a required_before_flip namespace_backup row.',
    );
}

interface Placement {
  readonly root: string;
  /** Host path of the backup folder. */
  readonly copy: string;
  /** Each file's backup sha256; a missing name is absent from the backup. */
  readonly backup: ReadonlyMap<string, string>;
  /** Each file's sha256 before the restore began. */
  readonly before: ReadonlyMap<string, string>;
  /** Host folders the replaced files are copied to, and backups staged in. */
  readonly aside: string;
  readonly staging: string;
}

/**
 * Puts the backup's files in place under `root`, in family order. Each file
 * is either as it was or as in the backup at every moment: a replaced file is
 * copied aside and flushed first, and the backup's copy is staged, flushed and
 * renamed over it. A file the backup lacks is removed once its copy is aside.
 * A file already as in the backup is skipped, so a rerun resumes.
 */
async function placeFamily(
  placement: Placement,
  flush: Flush,
  writeHandle: boolean,
): Promise<string[]> {
  const { root, copy, backup, before, aside, staging } = placement;
  const changed: string[] = [];
  for (const name of PREFERENCES_FAMILY_FILES) {
    const live = join(root, name);
    const now = await fileDigest(live);
    const wanted = backup.get(name);
    if (now === wanted) continue;
    if (now !== before.get(name))
      throw unverified(`${name} changed while it was being restored.`);
    if (now !== undefined) {
      const kept = join(aside, name);
      if ((await fileDigest(kept)) !== now) {
        await mkdir(aside, { recursive: true });
        await rm(kept, { force: true });
        await copyFile(live, kept);
        await syncFile(kept, writeHandle);
        if ((await fileDigest(kept)) !== now)
          throw unverified(`The set-aside ${name} does not match.`);
        await flush(aside);
        await flush(dirname(aside));
      }
    }
    if (wanted === undefined) await rm(live);
    else {
      const staged = join(staging, name);
      await mkdir(staging, { recursive: true });
      await rm(staged, { force: true });
      await copyFile(join(copy, name), staged);
      await syncFile(staged, writeHandle);
      if ((await fileDigest(staged)) !== wanted)
        throw unverified(`The staged ${name} does not match its backup.`);
      await rename(staged, live);
    }
    await flush(root);
    changed.push(name);
  }
  return changed;
}

/**
 * Take a verified backup of the preferences family into
 * `<PREFERENCES_BACKUPS_FOLDER>/<name>` and return its `namespace_backup`
 * record (`storage-backup-restore.schema.yaml`). With the writer stopped, the
 * files are copied and flushed, checked unchanged since the copy began,
 * checked against the copy, and restore-tested into an empty root before the
 * record is issued. A failed backup removes what it wrote.
 */
export async function backupPreferences(
  options: PreferencesBackupOptions,
): Promise<NamespaceBackupRecord> {
  const clock = options.clock ?? Date.now;
  const flush = confirmedFlush(options.syncDirectory);
  const rows = options.ownership ?? STORAGE_OWNERSHIP;
  assertRequiredBeforeFlip(rows);
  const backupPath = `${PREFERENCES_BACKUPS_FOLDER}/${options.name}`;
  const pathError = BACKUP_NAME.test(options.name)
    ? namespaceBackupPathError(backupPath, options.isOutsideCheckouts)
    : 'The backup name must be letters, digits, "-" and "_".';
  if (pathError !== undefined) throw unverified(pathError);
  return options.quiesce(async () => {
    const root = options.dataRoot;
    const base = await resolveInsideDataRoot(root, backupPath);
    // A backup never replaces anything, an earlier backup included.
    if (await isOccupied(base))
      throw unverified('The backup path already exists.');
    const createdAt = new Date(clock()).toISOString();
    const manifest = await familyManifest(root);
    const digest = fileSetDigest(manifest);
    try {
      await mkdir(base, { recursive: true });
      for (const path of filesOf(manifest).keys()) {
        await copyFile(join(root, path), join(base, path));
        await syncFile(join(base, path), options.flushRequiresWriteHandle);
      }
      await flush(base);
      // Each folder's entry is in its parent, up to the data root.
      const realRoot = await realpath(root);
      for (
        let folder = base;
        folder !== realRoot && folder !== dirname(folder);
        folder = dirname(folder)
      )
        await flush(dirname(folder));
      if (fileSetDigest(await familyManifest(root)) !== digest)
        throw new FileSetBackupError(
          'NOT_QUIESCED',
          'The preferences changed while they were copied.',
        );
      if (fileSetDigest(await fileSetManifest(base)) !== digest)
        throw unverified('The copy does not match the preferences.');
      const scratch = `${base}.restore-test-${randomUUID()}`;
      await mkdir(scratch);
      try {
        await placeFamily(
          {
            root: scratch,
            copy: base,
            backup: filesOf(manifest),
            before: new Map(),
            aside: join(scratch, 'aside'),
            staging: join(scratch, 'staging'),
          },
          flush,
          options.flushRequiresWriteHandle,
        );
        if (fileSetDigest(await familyManifest(scratch)) !== digest)
          throw unverified('The restore test does not match the preferences.');
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
      const row = rows.find(({ id }) => id === PREFERENCES_NAMESPACE_ID);
      return createNamespaceBackupRecord(
        {
          namespaceId: PREFERENCES_NAMESPACE_ID,
          backupPath,
          sourceRevision: `sha256:${digest}`,
          schemaVersion: row?.schemaVersion ?? 'none',
          createdAt,
          verifiedBy: { algorithm: 'sha256', digest },
          rollbackMigration: PREFERENCES_ROLLBACK_MIGRATION,
          restoreTestedAt: new Date(
            Math.max(clock(), Date.parse(createdAt)),
          ).toISOString(),
        },
        { rows, isOutsideCheckouts: options.isOutsideCheckouts },
      );
    } catch (error) {
      await rm(base, { recursive: true, force: true });
      throw error;
    }
  });
}

/** An unfinished restore: where it sets files aside and stages copies. */
interface Journal {
  readonly digest: string;
  /** Each file's sha256 before the restore began. */
  readonly before: ReadonlyMap<string, string>;
  /** Data-root-relative folders beside the backup folder. */
  readonly aside: string;
  readonly staging: string;
}

function isFields(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The journal of an unfinished restore from `backupPath`. One this build
 * can't read, or one for another record, refuses the restore; it is never
 * resumed or rewritten.
 */
async function readJournal(
  path: string,
  backupPath: string,
  digest: string,
): Promise<Journal | undefined> {
  const text = await readFile(path, 'utf8').catch(whenMissing(undefined));
  if (text === undefined) return undefined;
  const another = unverified('Another restore from this backup is unfinished.');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw another;
  }
  if (
    !isFields(value) ||
    value.version !== 1 ||
    value.digest !== digest ||
    !isFields(value.before) ||
    typeof value.aside !== 'string' ||
    typeof value.staging !== 'string' ||
    !isBeside(value.aside, `${backupPath}.pre-restore-`, /^\d+(-\d+)?$/) ||
    !isBeside(value.staging, `${backupPath}.restore-`, /^[0-9a-f-]{36}$/)
  )
    throw another;
  const before = new Map<string, string>();
  for (const [name, sha256] of Object.entries(value.before)) {
    if (!FAMILY.has(name) || typeof sha256 !== 'string') throw another;
    before.set(name, sha256);
  }
  return { digest, before, aside: value.aside, staging: value.staging };
}

/** Whether `path` is `prefix` followed by a suffix `suffix` matches. */
function isBeside(path: string, prefix: string, suffix: RegExp): boolean {
  return path.startsWith(prefix) && suffix.test(path.slice(prefix.length));
}

async function writeJournal(
  path: string,
  journal: Journal,
  flush: Flush,
  writeHandle: boolean,
): Promise<void> {
  // Beside the backup folder: a leftover inside it would fail its digest.
  const temporary = `${dirname(path)}.restore-journal-${randomUUID()}.tmp`;
  await writeFile(
    temporary,
    JSON.stringify({
      version: 1,
      digest: journal.digest,
      before: Object.fromEntries(journal.before),
      aside: journal.aside,
      staging: journal.staging,
    }),
    { flag: 'wx' },
  );
  await syncFile(temporary, writeHandle);
  await rename(temporary, path);
  await flush(dirname(path));
}

/** Whether every file is as it was before the journaled restore, or as in the backup. */
function isRestoreProgress(
  now: ReadonlyMap<string, string>,
  journal: Journal,
  backup: ReadonlyMap<string, string>,
): boolean {
  return PREFERENCES_FAMILY_FILES.every(
    (name) =>
      now.get(name) === journal.before.get(name) ||
      now.get(name) === backup.get(name),
  );
}

/**
 * The rollback migration the family's records name. With the writer stopped,
 * it checks the backup against its record and the live files against the
 * backup before changing anything. Live preferences that differ from the
 * backup are refused unless a person confirmed the loss, and are then set
 * aside beside the backup, never deleted. A journal in the backup folder
 * marks the restore unfinished until every file is in place, so an
 * interrupted restore completes when it is run again.
 */
export async function restorePreferencesBackup(
  record: NamespaceBackupRecord,
  options: PreferencesRestoreOptions,
): Promise<PreferencesRestoreResult> {
  const clock = options.clock ?? Date.now;
  const rows = options.ownership ?? STORAGE_OWNERSHIP;
  const flush = confirmedFlush(options.syncDirectory);
  const writeHandle = options.flushRequiresWriteHandle;
  const verified = createNamespaceBackupRecord(record, {
    rows,
    isOutsideCheckouts: options.isOutsideCheckouts,
  });
  if (
    verified.namespaceId !== PREFERENCES_NAMESPACE_ID ||
    verified.rollbackMigration !== PREFERENCES_ROLLBACK_MIGRATION ||
    verified.verifiedBy.algorithm !== 'sha256' ||
    posix.dirname(verified.backupPath) !== PREFERENCES_BACKUPS_FOLDER ||
    !BACKUP_NAME.test(posix.basename(verified.backupPath))
  )
    throw unverified(
      'This record is not a preferences backup this build reads.',
    );
  const { backupPath } = verified;
  const digest = verified.verifiedBy.digest;
  return options.quiesce(async () => {
    const root = options.dataRoot;
    const base = await resolveInsideDataRoot(root, backupPath);
    const copy = await fileSetManifest(base, [RESTORE_JOURNAL]);
    if (
      copy.kind !== 'directory' ||
      copy.directories.length > 0 ||
      copy.files.some(({ path }) => !FAMILY.has(path)) ||
      fileSetDigest(copy) !== digest
    )
      throw unverified('The backup does not match its record.');
    const backup = filesOf(copy);
    const journalPath = join(base, RESTORE_JOURNAL);
    let journal = await readJournal(journalPath, backupPath, digest);
    const current = await familyManifest(root);
    const now = filesOf(current);
    let restored: string[] = [];
    if (fileSetDigest(current) !== digest) {
      if (journal === undefined || !isRestoreProgress(now, journal, backup)) {
        // Restoring into an empty family loses nothing, unless a restore had
        // already begun and the family was emptied since.
        if (journal !== undefined || now.size > 0) {
          const files = PREFERENCES_FAMILY_FILES.filter(
            (name) => now.get(name) !== backup.get(name),
          );
          if (options.acceptNewerLoss?.confirmedBy !== 'person')
            throw new FileSetBackupError(
              'NEWER_STATE',
              `Changed since the backup: ${files.join(', ')}. Nothing was restored.`,
            );
          options.acceptNewerLoss.log({ backupPath, files });
        }
        // A confirmed restart keeps the earlier set-aside folder.
        if (journal !== undefined)
          await rm(hostPath(root, journal.staging), {
            recursive: true,
            force: true,
          });
        const asideBase = `${backupPath}.pre-restore-${String(clock())}`;
        let aside = asideBase;
        for (let n = 1; await isOccupied(hostPath(root, aside)); n += 1)
          aside = `${asideBase}-${String(n)}`;
        journal = {
          digest,
          before: now,
          aside,
          staging: `${backupPath}.restore-${randomUUID()}`,
        };
        await writeJournal(journalPath, journal, flush, writeHandle);
      }
      restored = await placeFamily(
        {
          root,
          copy: base,
          backup,
          before: journal.before,
          aside: hostPath(root, journal.aside),
          staging: hostPath(root, journal.staging),
        },
        flush,
        writeHandle,
      );
      // Read back before the journal goes, so no misstep that didn't throw
      // becomes a finished restore.
      if (fileSetDigest(await familyManifest(root)) !== digest)
        throw unverified('The restored preferences do not match the backup.');
    }
    if (journal === undefined) return { restored };
    const staging = hostPath(root, journal.staging);
    await rm(staging, { recursive: true, force: true });
    await flush(dirname(staging));
    await rm(journalPath, { force: true });
    await flush(base);
    return (await isOccupied(hostPath(root, journal.aside)))
      ? { restored, setAside: journal.aside }
      : { restored };
  });
}
