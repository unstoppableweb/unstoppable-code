import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  createNamespaceBackupRecord,
  namespaceBackupPathError,
  type NamespaceBackupRecord,
} from '../../storage/backup-record';
import { STORAGE_OWNERSHIP } from '../../storage/storage-ownership.generated';
import type { StorageOwnershipRow } from '../../storage/writer-authority';
import {
  copyFileSet,
  FileSetBackupError,
  fileSetDigest,
  fileSetManifest,
  isOccupied,
  resolveInsideDataRoot,
  syncFile,
  whenMissing,
  type FileSetManifest,
} from '../file-set-backup';
import type { WorkEntryRegistryRow } from './registry';
import type { WorkEntryRepository } from './repository';

/*
 * Backup and restore of the Work Entry registries (CAN-4476): every
 * `<container>/<workspace>/<fileName>` the work_entries row's patterns match,
 * under one namespace_backup record. Copies are taken in each workspace's
 * repository queue and restored through its raw install, so this module never
 * writes the row. Dormant: no production code calls it, and it issues a
 * record only while the row is required_before_flip.
 */

export const WORK_ENTRIES_NAMESPACE_ID = 'work_entries';
/** The rollback migration each record names: {@link restoreWorkEntryRegistriesBackup}. */
export const WORK_ENTRIES_ROLLBACK_MIGRATION =
  'restoreWorkEntryRegistriesBackup';
/** Data-root-relative folder holding one folder per backup. */
export const WORK_ENTRIES_BACKUPS_FOLDER = 'backups/work-entries';
/** The row's patterns are `<data>/<container>/{}/<fileName>`. */
const CONTAINERS: readonly string[] = ['app-workspaces', 'workspaces'];
/** In the backup folder while a restore from it is unfinished. */
const RESTORE_JOURNAL = 'restore-journal.json';
/** No dots, so no name is one of the dotted folders and files placed beside a backup. */
const BACKUP_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface RegistryOptions<Row extends WorkEntryRegistryRow> {
  readonly dataRoot: string;
  /** The registry's name in each workspace folder: `work-entries.json`. */
  readonly fileName: string;
  readonly repository: Pick<
    WorkEntryRepository<Row>,
    'transact' | 'installRaw'
  >;
  /**
   * The data-root-relative, slash-separated path the repository writes for a
   * workspace; it may throw for a folder name that is no workspace id. A
   * registry elsewhere, such as a stale `workspaces/app-advisor` copy, has
   * no writer.
   */
  readonly registryPathOf: (workspaceId: string) => string;
  /** Trusted host proof that a path is outside every checkout. */
  readonly isOutsideCheckouts: (dataRootRelativePath: string) => boolean;
  /** The secure-files port's `syncDirectory`; anything but `flushed` refuses. */
  readonly syncDirectory: (path: string) => Promise<'flushed' | 'unsupported'>;
  /** Host fact: a file flush needs a handle opened for writing (Windows). */
  readonly flushRequiresWriteHandle: boolean;
  /** The ownership rows records are checked against. */
  readonly ownership?: readonly StorageOwnershipRow[];
  readonly clock?: () => number;
}

export interface WorkEntryBackupOptions<
  Row extends WorkEntryRegistryRow,
> extends RegistryOptions<Row> {
  /** The backup's folder name under {@link WORK_ENTRIES_BACKUPS_FOLDER}. */
  readonly name: string;
  /** The registry codec's parse; the restore test compares through it. */
  readonly parse: (text: string) => unknown;
}

/** What a confirmed restore is about to replace, logged before any change. */
export interface WorkEntryNewerLoss {
  readonly backupPath: string;
  readonly files: readonly string[];
}

export interface WorkEntryRestoreOptions<
  Row extends WorkEntryRegistryRow,
> extends RegistryOptions<Row> {
  /**
   * Restores over registries changed since the backup, setting them aside.
   * Only a person's explicit confirmation sets it; never choose it
   * automatically. `log` records the loss before anything changes.
   */
  readonly acceptNewerLoss?: {
    readonly confirmedBy: 'person';
    readonly log: (loss: WorkEntryNewerLoss) => void;
  };
}

export interface WorkEntryRestoreResult {
  /** Registries this run installed. */
  readonly restored: readonly string[];
  /** Data-root-relative folder holding the replaced registries, if any. */
  readonly setAside?: string;
  /**
   * Backed-up registries no writer serves or whose workspace folder is gone.
   * Workspace folders are outside this namespace, so none is recreated.
   */
  readonly notInstalled: readonly string[];
}

interface Registry {
  /** Data-root-relative: `<container>/<workspaceId>/<fileName>`. */
  readonly path: string;
  readonly workspaceId: string;
}

type Flush = (folder: string) => Promise<void>;

function unverified(message: string): FileSetBackupError {
  return new FileSetBackupError('BACKUP_UNVERIFIED', message);
}

function confirmedFlush(
  syncDirectory: RegistryOptions<WorkEntryRegistryRow>['syncDirectory'],
): Flush {
  return async (folder) => {
    if ((await syncDirectory(folder)) !== 'flushed')
      throw unverified('A folder flush was not confirmed.');
  };
}

/** Flushes `from` and each folder above it, up to and including `top`. */
async function flushUpTo(
  from: string,
  top: string,
  flush: Flush,
): Promise<void> {
  for (let folder = from; ; folder = dirname(folder)) {
    await flush(folder);
    if (folder === top || folder === dirname(folder)) return;
  }
}

function hostPath(root: string, relative: string): string {
  return join(root, ...relative.split(posix.sep));
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A file's sha256, or undefined when nothing is there. */
async function fileDigest(path: string): Promise<string | undefined> {
  const manifest = await fileSetManifest(path);
  if (manifest.kind === 'directory')
    throw unverified(`${path} is a folder, not a registry.`);
  return manifest.kind === 'file' ? manifest.sha256 : undefined;
}

function assertFileName(fileName: string): void {
  if (!FILE_NAME.test(fileName))
    throw unverified('The registry file name must be one plain file name.');
}

function assertRequiredBeforeFlip(rows: readonly StorageOwnershipRow[]): void {
  const row = rows.find(({ id }) => id === WORK_ENTRIES_NAMESPACE_ID);
  if (
    row?.backupPolicy !== 'required_before_flip' ||
    row.backupShape !== 'namespace_backup'
  )
    throw new FileSetBackupError(
      'NOT_REQUIRED_BEFORE_FLIP',
      'The work_entries row is not a required_before_flip namespace_backup row.',
    );
}

function isServed(
  registryPathOf: (workspaceId: string) => string,
  { path, workspaceId }: Registry,
): boolean {
  try {
    return registryPathOf(workspaceId) === path;
  } catch {
    return false;
  }
}

/** Every registry the row's patterns match under `root`, refusing symbolic links. */
async function findRegistries(
  root: string,
  fileName: string,
): Promise<Registry[]> {
  const found: Registry[] = [];
  for (const container of CONTAINERS) {
    const stats = await lstat(join(root, container)).catch(whenMissing(null));
    if (stats === null) continue;
    if (!stats.isDirectory()) throw unverified(`${container} is not a folder.`);
    for (const workspaceId of (await readdir(join(root, container))).sort()) {
      const folder = await lstat(join(root, container, workspaceId)).catch(
        whenMissing(null),
      );
      if (folder?.isSymbolicLink())
        throw unverified(`${container}/${workspaceId} is a symbolic link.`);
      if (!folder?.isDirectory()) continue;
      const path = `${container}/${workspaceId}/${fileName}`;
      const file = await lstat(hostPath(root, path)).catch(whenMissing(null));
      if (file === null) continue;
      if (!file.isFile()) throw unverified(`${path} is not a regular file.`);
      found.push({ path, workspaceId });
    }
  }
  return found;
}

/** A backup folder's registries and their sha256, unless it holds anything else. */
function backedUpRegistries(
  copy: FileSetManifest,
  fileName: string,
): ReadonlyMap<string, Registry & { readonly sha256: string }> | undefined {
  if (copy.kind !== 'directory') return undefined;
  const registries = new Map<string, Registry & { readonly sha256: string }>();
  const folders = new Set<string>();
  for (const { path, sha256: digest } of copy.files) {
    const [container, workspaceId, name, ...rest] = path.split('/');
    if (rest.length > 0 || !CONTAINERS.includes(container) || name !== fileName)
      return undefined;
    registries.set(path, { path, workspaceId, sha256: digest });
    folders.add(container).add(`${container}/${workspaceId}`);
  }
  return isDeepStrictEqual([...copy.directories].sort(), [...folders].sort())
    ? registries
    : undefined;
}

function parsesEqual(
  parse: (text: string) => unknown,
  restored: Uint8Array,
  live: Uint8Array,
): boolean {
  // Decoded as the repository's raw install decodes before it parses.
  const decode = (bytes: Uint8Array): string =>
    new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
  try {
    return isDeepStrictEqual(parse(decode(restored)), parse(decode(live)));
  } catch {
    return false;
  }
}

/**
 * Take a verified backup of every Work Entry registry into
 * `<WORK_ENTRIES_BACKUPS_FOLDER>/<name>` and return its `namespace_backup`
 * record. Each served registry is copied and flushed in its workspace's
 * queue; one no writer serves is copied as it is. The copy is checked against
 * the bytes read and restore-tested into a scratch folder, compared byte for
 * byte and through `parse`, so a registry that does not parse refuses the
 * backup: its restore could not install it. A failed backup removes what it
 * wrote.
 */
export async function backupWorkEntryRegistries<
  Row extends WorkEntryRegistryRow,
>(options: WorkEntryBackupOptions<Row>): Promise<NamespaceBackupRecord> {
  const clock = options.clock ?? Date.now;
  const flush = confirmedFlush(options.syncDirectory);
  const writeHandle = options.flushRequiresWriteHandle;
  const rows = options.ownership ?? STORAGE_OWNERSHIP;
  assertRequiredBeforeFlip(rows);
  assertFileName(options.fileName);
  const backupPath = `${WORK_ENTRIES_BACKUPS_FOLDER}/${options.name}`;
  const pathError = BACKUP_NAME.test(options.name)
    ? namespaceBackupPathError(backupPath, options.isOutsideCheckouts)
    : 'The backup name must be letters, digits, "-" and "_".';
  if (pathError !== undefined) throw unverified(pathError);
  const root = options.dataRoot;
  const base = await resolveInsideDataRoot(root, backupPath);
  // A backup never replaces anything, an earlier backup included.
  if (await isOccupied(base))
    throw unverified('The backup path already exists.');
  const createdAt = new Date(clock()).toISOString();
  const registries = await findRegistries(root, options.fileName);
  const copied = new Map<string, Uint8Array>();
  try {
    await mkdir(base, { recursive: true });
    for (const registry of registries) {
      const copy = async (): Promise<void> => {
        const bytes = await readFile(hostPath(root, registry.path)).catch(
          whenMissing(null),
        );
        // Removed with its workspace since it was found.
        if (bytes === null) return;
        const target = hostPath(base, registry.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes, { flag: 'wx' });
        await syncFile(target, writeHandle);
        copied.set(registry.path, bytes);
      };
      if (isServed(options.registryPathOf, registry))
        await options.repository.transact(registry.workspaceId, copy);
      else await copy();
    }
    const manifest = await fileSetManifest(base);
    if (
      manifest.kind !== 'directory' ||
      manifest.files.length !== copied.size ||
      manifest.files.some(({ path, sha256: digest }) => {
        const bytes = copied.get(path);
        return bytes === undefined || sha256(bytes) !== digest;
      })
    )
      throw unverified('The copy does not match the registries.');
    // Walk order lists each folder before its children; flush them first.
    for (const folder of [...manifest.directories].reverse())
      await flush(hostPath(base, folder));
    // Each folder's entry is in its parent, up to the data root.
    await flushUpTo(base, await realpath(root), flush);
    const digest = fileSetDigest(manifest);

    const scratch = `${base}.restore-test-${randomUUID()}`;
    try {
      await copyFileSet(base, scratch, manifest, writeHandle);
      if (fileSetDigest(await fileSetManifest(scratch)) !== digest)
        throw unverified('The restore test does not match the backup.');
      for (const [path, live] of copied) {
        const restored = await readFile(hostPath(scratch, path));
        if (!parsesEqual(options.parse, restored, live))
          throw unverified(`The restore test of ${path} does not parse equal.`);
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }

    const row = rows.find(({ id }) => id === WORK_ENTRIES_NAMESPACE_ID);
    return createNamespaceBackupRecord(
      {
        namespaceId: WORK_ENTRIES_NAMESPACE_ID,
        backupPath,
        sourceRevision: `sha256:${digest}`,
        schemaVersion: row?.schemaVersion ?? 'none',
        createdAt,
        verifiedBy: { algorithm: 'sha256', digest },
        rollbackMigration: WORK_ENTRIES_ROLLBACK_MIGRATION,
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
}

/** An unfinished restore. */
interface Journal {
  readonly digest: string;
  /** Each target registry's sha256 before the restore began, when present. */
  readonly before: ReadonlyMap<string, string>;
  /** Data-root-relative set-aside folder beside the backup folder. */
  readonly aside: string;
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
  registries: ReadonlyMap<string, Registry>,
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
  const asidePrefix = `${backupPath}.pre-restore-`;
  if (
    !isFields(value) ||
    value.version !== 1 ||
    value.digest !== digest ||
    !isFields(value.before) ||
    typeof value.aside !== 'string' ||
    !value.aside.startsWith(asidePrefix) ||
    !/^\d+(-\d+)?$/.test(value.aside.slice(asidePrefix.length))
  )
    throw another;
  const before = new Map<string, string>();
  for (const [registry, digestBefore] of Object.entries(value.before)) {
    if (!registries.has(registry) || typeof digestBefore !== 'string')
      throw another;
    before.set(registry, digestBefore);
  }
  return { digest, before, aside: value.aside };
}

async function writeJournal(
  path: string,
  journal: Journal,
  flush: Flush,
  writeHandle: boolean,
): Promise<void> {
  // Beside the backup folder: a leftover inside it would fail its digest.
  const temporary = `${dirname(path)}.restore-journal-${randomUUID()}.tmp`;
  const { digest, before, aside } = journal;
  await writeFile(
    temporary,
    JSON.stringify({
      version: 1,
      digest,
      before: Object.fromEntries(before),
      aside,
    }),
    { flag: 'wx' },
  );
  await syncFile(temporary, writeHandle);
  await rename(temporary, path);
  await flush(dirname(path));
}

/** Whether the workspace folder is there; a symbolic link refuses the restore. */
async function hasWorkspaceFolder(
  root: string,
  { path }: Registry,
): Promise<boolean> {
  const [container, workspaceId] = path.split('/');
  for (const folder of [container, `${container}/${workspaceId}`]) {
    const stats = await lstat(hostPath(root, folder)).catch(whenMissing(null));
    if (stats === null) return false;
    if (!stats.isDirectory())
      throw unverified(`${folder} is not a workspace folder.`);
  }
  return true;
}

/**
 * The rollback migration the row's records name. It checks the backup against
 * its record and the live registries against the backup before changing
 * anything. Registries that differ are refused unless a person confirmed the
 * loss. Each registry installs through the repository's `installRaw`, whose
 * `beforeInstall` sets the replaced bytes aside beside the backup in the same
 * queue slot, so no write lands unsaved between them; nothing is deleted. A
 * journal in the backup folder marks the restore unfinished until every
 * registry is in place, so an interrupted restore completes when rerun.
 */
export async function restoreWorkEntryRegistriesBackup<
  Row extends WorkEntryRegistryRow,
>(
  record: NamespaceBackupRecord,
  options: WorkEntryRestoreOptions<Row>,
): Promise<WorkEntryRestoreResult> {
  const clock = options.clock ?? Date.now;
  const rows = options.ownership ?? STORAGE_OWNERSHIP;
  const flush = confirmedFlush(options.syncDirectory);
  const writeHandle = options.flushRequiresWriteHandle;
  assertFileName(options.fileName);
  const verified = createNamespaceBackupRecord(record, {
    rows,
    isOutsideCheckouts: options.isOutsideCheckouts,
  });
  if (
    verified.namespaceId !== WORK_ENTRIES_NAMESPACE_ID ||
    verified.rollbackMigration !== WORK_ENTRIES_ROLLBACK_MIGRATION ||
    verified.verifiedBy.algorithm !== 'sha256' ||
    posix.dirname(verified.backupPath) !== WORK_ENTRIES_BACKUPS_FOLDER ||
    !BACKUP_NAME.test(posix.basename(verified.backupPath))
  )
    throw unverified(
      'This record is not a Work Entry backup this build reads.',
    );
  const { backupPath } = verified;
  const digest = verified.verifiedBy.digest;
  const root = options.dataRoot;
  const base = await resolveInsideDataRoot(root, backupPath);
  const copy = await fileSetManifest(base, [RESTORE_JOURNAL]);
  const registries = backedUpRegistries(copy, options.fileName);
  if (registries === undefined || fileSetDigest(copy) !== digest)
    throw unverified('The backup does not match its record.');

  const targets: (Registry & { readonly sha256: string })[] = [];
  const notInstalled: string[] = [];
  for (const registry of registries.values()) {
    if (
      isServed(options.registryPathOf, registry) &&
      (await hasWorkspaceFolder(root, registry))
    )
      targets.push(registry);
    else notInstalled.push(registry.path);
  }
  const now = new Map<string, string>();
  for (const { path } of targets) {
    const current = await fileDigest(hostPath(root, path));
    if (current !== undefined) now.set(path, current);
  }
  const pending = targets.filter(
    ({ path, sha256: want }) => now.get(path) !== want,
  );
  const journalPath = join(base, RESTORE_JOURNAL);
  let journal = await readJournal(journalPath, backupPath, digest, registries);
  const restored: string[] = [];
  if (pending.length > 0) {
    const progress = journal?.before;
    if (
      journal === undefined ||
      progress === undefined ||
      !targets.every(
        ({ path, sha256: want }) =>
          now.get(path) === progress.get(path) || now.get(path) === want,
      )
    ) {
      // Installing where no registry is, or was when a restore began, loses
      // nothing.
      const files = pending
        .filter(({ path }) => now.has(path) || progress?.has(path) === true)
        .map(({ path }) => path);
      if (files.length > 0) {
        if (options.acceptNewerLoss?.confirmedBy !== 'person')
          throw new FileSetBackupError(
            'NEWER_STATE',
            `Changed since the backup: ${files.join(', ')}. Nothing was restored.`,
          );
        options.acceptNewerLoss.log({ backupPath, files });
      }
      // A confirmed restart keeps the earlier set-aside folder.
      const asideBase = `${backupPath}.pre-restore-${String(clock())}`;
      let aside = asideBase;
      for (let n = 1; await isOccupied(hostPath(root, aside)); n += 1)
        aside = `${asideBase}-${String(n)}`;
      journal = { digest, before: now, aside };
      await writeJournal(journalPath, journal, flush, writeHandle);
    }
    const { before } = journal;
    const aside = hostPath(root, journal.aside);
    for (const { path, workspaceId, sha256: want } of pending) {
      const bytes = await readFile(hostPath(base, path));
      if (sha256(bytes) !== want)
        throw unverified(`The backup of ${path} changed during the restore.`);
      const live = hostPath(root, path);
      const setAside = async (): Promise<void> => {
        const current = await fileDigest(live);
        if (current === want) return;
        if (current !== before.get(path))
          throw unverified(`${path} changed while it was being restored.`);
        const kept = hostPath(aside, path);
        if (current === undefined || (await fileDigest(kept)) === current)
          return;
        await mkdir(dirname(kept), { recursive: true });
        await rm(kept, { force: true });
        await writeFile(kept, await readFile(live), { flag: 'wx' });
        await syncFile(kept, writeHandle);
        if ((await fileDigest(kept)) !== current)
          throw unverified(`The set-aside ${path} does not match.`);
        await flushUpTo(dirname(kept), dirname(aside), flush);
      };
      await options.repository.installRaw(workspaceId, bytes, {
        beforeInstall: setAside,
      });
      await flush(dirname(live));
      restored.push(path);
    }
    // Read back before the journal goes, so no misstep that didn't throw
    // becomes a finished restore.
    for (const { path, sha256: want } of targets)
      if ((await fileDigest(hostPath(root, path))) !== want)
        throw unverified('The restored registries do not match the backup.');
  }
  if (journal === undefined) return { restored, notInstalled };
  await rm(journalPath, { force: true });
  await flush(base);
  return (await isOccupied(hostPath(root, journal.aside)))
    ? { restored, setAside: journal.aside, notInstalled }
    : { restored, notInstalled };
}
