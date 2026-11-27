import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';

import {
  createNamespaceBackupRecord,
  namespaceBackupPathError,
  type NamespaceBackupRecord,
} from '../../../storage/backup-record';
import {
  backupRecordReference,
  storageRecordsFolder,
  type OwnerFlipRecordRead,
} from '../../../storage/owner-records';
import { STORAGE_OWNERSHIP } from '../../../storage/storage-ownership.generated';
import type {
  StorageOwnershipRow,
  StorageTransitionOwner,
} from '../../../storage/writer-authority';
import {
  FileSetBackupError,
  copyFileSet,
  fileSetDigest,
  fileSetManifest,
  isOccupied,
  resolveInsideDataRoot,
  syncFile,
  whenMissing,
  type FileSetManifest,
} from '../../file-set-backup';
import {
  persistNamespaceBackupRecord,
  readOwnerFlipRecord,
  writeOwnerFlipRecord,
} from '../../storage-records';
import {
  PIPELINE_DEFINITIONS_BACKUP_MEMBERS,
  type PipelineDefinitionsBackupMember,
} from './definitions-backup-members';
import { INTENT_FILE } from './install-journal';

/*
 * Backup and restore of the pipeline definitions family (CAN-5340): the
 * definitions folder, the definition write receipts and the per-pipeline
 * data, each one storage row with its own namespace_backup record, taken and
 * restored together while the family's writers are stopped. Dormant: no
 * production code calls it, and it issues records only for rows that are
 * required_before_flip.
 */

export { PIPELINE_DEFINITIONS_BACKUP_MEMBERS };

/** The rollback migration each record names: {@link restorePipelineDefinitionsBackup}. */
export const PIPELINE_DEFINITIONS_ROLLBACK_MIGRATION =
  'restorePipelineDefinitionsBackup';

const INSTALL_INTENTS_DIR = 'pipeline-install-intents';
const COPY_NAME = 'data';
/** A restore's staging folder in the data root, named `<prefix><uuid>`. */
const STAGING_PREFIX = '.pipeline-definitions-restore-';
/** In the backup folder while a restore from it is unfinished. */
const RESTORE_JOURNAL = 'restore-journal.json';
/** The definitions store's writer lock, the one every host takes. */
const WRITER_LOCK_DIR = 'locks/pipeline-definitions';
const WRITER_LOCK_MAX_WAIT_MS = 5_000;
const WRITER_LOCK_TIMEOUT = 'The workflow definitions are being written.';

/** core-platform's owner lock over a lock file, as the host supplies it. */
export interface PipelineDefinitionsWriterLock {
  ensurePrivateLockDirectory(directory: string): Promise<void>;
  withOwnerLockFile<T>(
    lockPath: string,
    operation: () => Promise<T>,
    options: {
      readonly maxWaitMs: number;
      readonly timeoutMessage: string;
    },
  ): Promise<T>;
}

interface FamilyOptions {
  /** The data root every path is relative to. */
  readonly dataRoot: string;
  /** Trusted host proof that a path is outside every checkout. */
  readonly isOutsideCheckouts: (dataRootRelativePath: string) => boolean;
  /**
   * The host's folder flush: its secure-files port's `syncDirectory`. Any
   * answer but `flushed` refuses the backup or the restore.
   */
  readonly syncDirectory: (path: string) => Promise<'flushed' | 'unsupported'>;
  /**
   * Host fact: a file flush needs a handle opened for writing, as Windows
   * `FlushFileBuffers` does.
   */
  readonly flushRequiresWriteHandle: boolean;
  /**
   * Runs `operation` with every writer of the family stopped and resolves
   * with its result. The backup and the restore touch nothing outside it.
   */
  readonly quiesce: <T>(operation: () => Promise<T>) => Promise<T>;
  /** Held for the whole backup or restore, inside `quiesce`. */
  readonly lock: PipelineDefinitionsWriterLock;
  /** The ownership rows records are checked against. */
  readonly ownership?: readonly StorageOwnershipRow[];
  readonly clock?: () => number;
}

export interface PipelineDefinitionsBackupOptions extends FamilyOptions {
  /** Data-root-relative folder to create; one subfolder per row. */
  readonly backupPath: string;
}

/** What a confirmed restore is about to replace, logged before any change. */
export interface PipelineDefinitionsNewerLoss {
  readonly backupPath: string;
  /** Rows changed since the backup, whose contents will be set aside. */
  readonly rows: readonly string[];
}

export interface PipelineDefinitionsRestoreOptions extends FamilyOptions {
  /**
   * Restores over rows changed since the backup, setting their current
   * contents aside. Only a person's explicit confirmation sets it; never
   * choose it automatically. `log` records the loss before anything changes.
   */
  readonly acceptNewerLoss?: {
    readonly confirmedBy: 'person';
    readonly log: (loss: PipelineDefinitionsNewerLoss) => void;
  };
  /**
   * The owner the rows had when the backup was taken. A row whose owner
   * record names another owner is returned to it; without `owner`, any
   * owner record refuses the restore.
   */
  readonly owner?: StorageTransitionOwner;
}

export interface PipelineDefinitionsRestoreResult {
  /** Rows replaced from the backup. */
  readonly restored: readonly string[];
  /** Rows that already held the backup's contents. */
  readonly unchanged: readonly string[];
  /** Data-root-relative paths of contents the restore set aside. */
  readonly setAside: readonly string[];
}

interface RowPlan {
  readonly member: PipelineDefinitionsBackupMember;
  readonly copy: string;
  readonly manifest: FileSetManifest;
  /** Where an interrupted restore of the row stopped, when it resumes. */
  readonly resume?: {
    /** The set-aside path that restore chose. */
    readonly aside: string;
    /** The top-level entries it placed, in order. */
    readonly placed: readonly string[];
  };
}

/** Called as a row starts, before each entry is placed, and as it finishes. */
interface RowProgress {
  started(namespaceId: string, aside: string): Promise<void>;
  placing(namespaceId: string, name: string): Promise<void>;
  /** A further set-aside path for the row, named before anything moves in. */
  asideAdded(namespaceId: string, aside: string): Promise<void>;
  finished(namespaceId: string): Promise<void>;
}

/** A set-aside path beside `path` that nothing occupies yet. */
async function freshAside(
  root: string,
  path: string,
  clock: () => number,
): Promise<string> {
  const base = `${path}.pre-restore-${String(clock())}`;
  let aside = base;
  for (let n = 1; await isOccupied(hostPath(root, aside)); n += 1)
    aside = `${base}-${String(n)}`;
  return aside;
}

function unverified(message: string): FileSetBackupError {
  return new FileSetBackupError('BACKUP_UNVERIFIED', message);
}

type Flush = (folder: string) => Promise<void>;

/** The host's folder flush, refusing unless it confirms the flush. */
function confirmedFlush(syncDirectory: FamilyOptions['syncDirectory']): Flush {
  return async (folder) => {
    if ((await syncDirectory(folder)) !== 'flushed')
      throw unverified('A folder flush was not confirmed.');
  };
}

async function isFolder(path: string): Promise<boolean> {
  return (
    (await lstat(path).catch(whenMissing(undefined)))?.isDirectory() === true
  );
}

function hostPath(root: string, relative: string): string {
  return join(root, ...relative.split(posix.sep));
}

/**
 * A rename, mkdir or rmdir by folder: the folder it took an entry from, the
 * one it added an entry to or removed one from, and a folder it created.
 */
interface Move {
  readonly from?: string;
  readonly to: string;
  readonly created?: string;
}

/**
 * The folders the moves changed, ordered so each move's destination is
 * flushed before its source and a created folder's parent before the
 * folder, so no crash between two flushes loses an entry from both places.
 * Ties keep the order the folders were first named in.
 */
function flushOrder(moves: readonly Move[]): string[] {
  const folders = new Set<string>();
  const edges: (readonly [earlier: string, then: string])[] = [];
  for (const { from, to, created } of moves) {
    folders.add(to);
    if (from !== undefined && from !== to) edges.push([to, from]);
    if (created !== undefined) edges.push([dirname(created), created]);
    for (const folder of [from, created && dirname(created)])
      if (folder !== undefined) folders.add(folder);
  }
  const order: string[] = [];
  while (order.length < folders.size) {
    const next = [...folders].find(
      (folder) =>
        !order.includes(folder) &&
        edges.every(
          ([earlier, then]) => then !== folder || order.includes(earlier),
        ),
    );
    if (next === undefined)
      throw unverified('The restore has no safe order to flush its moves.');
    order.push(next);
  }
  return order;
}

/** The moves not yet flushed, and the one way to flush them. */
interface MovePlan {
  record(...moves: readonly Move[]): void;
  /** Flushes every recorded move's folders in `flushOrder`, then forgets them. */
  flush(): Promise<void>;
}

function movePlan(flush: Flush): MovePlan {
  const pending: Move[] = [];
  return {
    record: (...moves) => {
      pending.push(...moves);
    },
    flush: async () => {
      // A folder a later move removed has nothing left to flush; its removal
      // is in its parent.
      for (const folder of flushOrder(pending))
        if (await isFolder(folder)) await flush(folder);
      pending.length = 0;
    },
  };
}

/**
 * The moves earlier attempts may have made for a row and lost the flushes
 * of: the row's entries into each set-aside path, and the staged copy, from
 * the staging folder the journal names, into the row.
 */
function rowMoves(
  root: string,
  member: PipelineDefinitionsBackupMember,
  asides: readonly string[],
  staging: string | undefined,
): Move[] {
  const live = hostPath(root, member.path);
  // A file row and its set-aside copies are entries of the data root.
  if (member.kind === 'file')
    return [{ from: staging && hostPath(root, staging), to: dirname(live) }];
  const moves: Move[] = [{ to: live, created: live }];
  for (const aside of asides) {
    const path = hostPath(root, aside);
    moves.push({ from: live, to: path, created: path });
  }
  if (staging !== undefined)
    moves.push({
      from: hostPath(root, `${staging}/${member.namespaceId}`),
      to: live,
    });
  return moves;
}

function isEmpty(manifest: FileSetManifest): boolean {
  return (
    manifest.kind === 'absent' ||
    (manifest.kind === 'directory' &&
      manifest.directories.length === 0 &&
      manifest.files.length === 0)
  );
}

/**
 * Whether a row holds its backup's contents. A folder row that is absent and
 * one holding only other rows' excluded entries are the same empty row.
 */
function holdsBackup(
  member: PipelineDefinitionsBackupMember,
  current: FileSetManifest,
  backup: FileSetManifest,
): boolean {
  return (
    fileSetDigest(current) === fileSetDigest(backup) ||
    (member.kind === 'directory' && isEmpty(current) && isEmpty(backup))
  );
}

/** The owners a restore returns a row to, and moves one away from. */
const RETURNABLE: readonly StorageTransitionOwner[] = ['legacy', 'daemon'];

/** A row the restore returns to `owner` from `from`, the owner it moved to. */
interface OwnerReturn {
  readonly from: StorageTransitionOwner;
  readonly owner: StorageTransitionOwner;
  readonly workPackage: string;
}

function ownerRefused(namespaceId: string, why: string): FileSetBackupError {
  return new FileSetBackupError(
    'OWNER_RECORD',
    `The ${namespaceId} owner record ${why}. Nothing was restored.`,
  );
}

/**
 * What a restore does with a row's owner record (CAN-7842): nothing when
 * there is none or it already names `owner` (`returned` when it is this
 * backup's own return, whose flushes the restore repeats), or a return to
 * `owner` from the owner the row moved to since the backup, or from this
 * backup's own `offline` fence. Anything else refuses, before anything
 * changes.
 */
function ownerReturn(
  namespaceId: string,
  read: OwnerFlipRecordRead,
  thisBackup: string,
  owner: StorageTransitionOwner | undefined,
): OwnerReturn | 'returned' | undefined {
  if (read.kind === 'absent') return undefined;
  if (read.kind === 'unreadable')
    throw ownerRefused(namespaceId, `can't be read (${read.reason})`);
  const { fromOwner, toOwner, workPackage, backupRecord } = read.record;
  if (owner === undefined)
    throw ownerRefused(
      namespaceId,
      `names ${toOwner}; name the owner to return the row to`,
    );
  if (!RETURNABLE.includes(owner))
    throw ownerRefused(namespaceId, `can't be returned to ${owner}`);
  const ours = backupRecord === thisBackup;
  if (toOwner === owner)
    return ours && fromOwner === 'offline' ? 'returned' : undefined;
  if (toOwner === 'offline' && ours && RETURNABLE.includes(fromOwner))
    return { from: fromOwner, owner, workPackage };
  if (RETURNABLE.includes(toOwner))
    return { from: toOwner, owner, workPackage };
  throw ownerRefused(
    namespaceId,
    `names ${toOwner}, which a restore doesn't return from`,
  );
}

function assertRequiredBeforeFlip(rows: readonly StorageOwnershipRow[]): void {
  for (const member of PIPELINE_DEFINITIONS_BACKUP_MEMBERS) {
    const row = rows.find((candidate) => candidate.id === member.namespaceId);
    if (
      row?.backupPolicy !== 'required_before_flip' ||
      row.backupShape !== 'namespace_backup'
    )
      throw new FileSetBackupError(
        'NOT_REQUIRED_BEFORE_FLIP',
        `${member.namespaceId} is not a required_before_flip namespace_backup row.`,
      );
  }
}

/** An install in flight changes definitions and data under the copy. */
async function assertNoInstallInFlight(root: string): Promise<void> {
  const names = await readdir(join(root, INSTALL_INTENTS_DIR)).catch(
    whenMissing<string[]>([]),
  );
  if (names.some((name) => INTENT_FILE.test(name)))
    throw new FileSetBackupError(
      'NOT_QUIESCED',
      'A workflow install is still in flight.',
    );
}

/**
 * Runs `operation` holding the definitions store's writer lock, so no
 * store write on any host interleaves with the backup or the restore.
 */
async function underWriterLock<T>(
  options: Pick<FamilyOptions, 'dataRoot' | 'lock'>,
  operation: () => Promise<T>,
): Promise<T> {
  const directory = hostPath(options.dataRoot, WRITER_LOCK_DIR);
  await options.lock.ensurePrivateLockDirectory(directory);
  try {
    return await options.lock.withOwnerLockFile(
      join(directory, 'writer.lock'),
      operation,
      {
        maxWaitMs: WRITER_LOCK_MAX_WAIT_MS,
        timeoutMessage: WRITER_LOCK_TIMEOUT,
      },
    );
  } catch (error) {
    if (error instanceof Error && error.message === WRITER_LOCK_TIMEOUT)
      throw new FileSetBackupError('NOT_QUIESCED', WRITER_LOCK_TIMEOUT);
    throw error;
  }
}

/** The row's own top-level entries, leaving names of other rows out. */
async function ownEntries(
  live: string,
  member: PipelineDefinitionsBackupMember,
): Promise<string[]> {
  const names = await readdir(live).catch(whenMissing<string[]>([]));
  return names.filter((name) => !member.exclude.includes(name)).sort();
}

/**
 * Puts each row's copy in place under `root`. A file row is renamed in; a
 * folder row's entries are moved in one by one, `commitLast` last, and the
 * entries of other rows in the folder are never touched. A row's earlier
 * contents are set aside beside it, never deleted. A row that resumes keeps
 * the entries its interrupted restore placed and the set-aside path it
 * chose, and moves and places only what is left.
 *
 * A restore passes `progress` and its data-root-relative `staging` folder,
 * which stays until the restore finishes so a retry can tell an entry that
 * was never placed from one placed and then removed. Without them the
 * staging folder is removed at the end.
 */
async function putInPlace(
  root: string,
  plans: readonly RowPlan[],
  options: Pick<
    FamilyOptions,
    'syncDirectory' | 'flushRequiresWriteHandle' | 'clock'
  >,
  restore?: {
    readonly progress: RowProgress;
    readonly staging: string;
    readonly moves: MovePlan;
  },
): Promise<void> {
  const clock = options.clock ?? Date.now;
  const flush = confirmedFlush(options.syncDirectory);
  const staging = hostPath(
    root,
    restore?.staging ?? `${STAGING_PREFIX}${randomUUID()}`,
  );
  // Every rename, mkdir and rmdir is recorded with the folders it changed.
  // The journal records no step until all of them are flushed, so it never
  // claims a change a crash could still lose.
  const moves = restore?.moves ?? movePlan(flush);
  const flushDirty = (): Promise<void> => moves.flush();
  const journal = async (step: () => Promise<void>): Promise<void> => {
    await flushDirty();
    await step();
  };
  const move = async (from: string, to: string): Promise<void> => {
    await rename(from, to);
    moves.record({ from: dirname(from), to: dirname(to) });
  };
  const makeFolder = async (folder: string): Promise<void> => {
    await mkdir(folder, { recursive: true });
    moves.record({ to: dirname(folder), created: folder });
  };
  const removeFolder = async (folder: string): Promise<void> => {
    await rmdir(folder);
    moves.record({ to: dirname(folder) });
  };
  await mkdir(staging);
  // The journal names the staging folder, so its entry in the data root is
  // durable before anything is named from it.
  if (restore !== undefined) await flush(dirname(staging));
  try {
    for (const { member, copy, manifest, resume } of plans) {
      const live = hostPath(root, member.path);
      const staged = join(staging, member.namespaceId);
      const folders = await copyFileSet(
        copy,
        staged,
        manifest,
        options.flushRequiresWriteHandle,
      );
      if (
        fileSetDigest(await fileSetManifest(staged)) !== fileSetDigest(manifest)
      )
        throw unverified('The staged copy does not match its backup.');
      for (const folder of folders) await flush(folder);
      const placed = new Set(resume?.placed ?? []);
      const aside =
        resume?.aside ?? (await freshAside(root, member.path, clock));
      const asidePath = hostPath(root, aside);
      await journal(async () => {
        await restore?.progress.started(member.namespaceId, aside);
      });
      const place = async (
        from: string,
        to: string,
        name: string,
      ): Promise<void> => {
        await journal(async () => {
          await restore?.progress.placing(member.namespaceId, name);
        });
        await move(from, to);
      };
      if (member.kind === 'file') {
        if (!placed.has('') && (await isOccupied(live)))
          await move(live, asidePath);
        if (manifest.kind !== 'absent' && !(await isOccupied(live)))
          await place(staged, live, '');
      } else {
        // Anything but a folder at the row's path is set aside whole.
        const occupant = await lstat(live).catch(whenMissing(undefined));
        if (occupant !== undefined && !occupant.isDirectory())
          await move(live, asidePath);
        const current = (await ownEntries(live, member))
          .filter((name) => !placed.has(name))
          .sort((a, b) =>
            a === member.commitLast ? -1 : b === member.commitLast ? 1 : 0,
          );
        if (current.length > 0) {
          await makeFolder(asidePath);
          let extra: string | undefined;
          for (const name of current) {
            // A resumed attempt's earlier move may be durable in the set-aside
            // copy and the row alike; the row's copy then goes to a further
            // one the journal names first, never over the first.
            let target = asidePath;
            if (
              resume !== undefined &&
              (await isOccupied(join(asidePath, name)))
            ) {
              if (extra === undefined) {
                const added = await freshAside(root, member.path, clock);
                await makeFolder(hostPath(root, added));
                await journal(async () => {
                  await restore?.progress.asideAdded(member.namespaceId, added);
                });
                extra = added;
              }
              target = hostPath(root, extra);
            }
            await move(join(live, name), join(target, name));
            // The index leaves first, so no index names a document already
            // gone; it is durable in the set-aside folder before it leaves.
            if (name === member.commitLast) await flushDirty();
          }
          await flushDirty();
        }
        if (manifest.kind === 'directory') {
          await makeFolder(live);
          const incoming = (await readdir(staged)).sort((a, b) =>
            a === member.commitLast ? 1 : b === member.commitLast ? -1 : 0,
          );
          for (const name of incoming) {
            if (placed.has(name) && (await isOccupied(join(live, name))))
              continue;
            // Every document is durable before the index that names it.
            if (name === member.commitLast) await flush(live);
            await place(join(staged, name), join(live, name), name);
          }
        } else if (
          (await readdir(live).catch(whenMissing(undefined)))?.length === 0
        )
          await removeFolder(live);
      }
      if (await isFolder(live)) await flush(live);
      // The entries of the row and of its set-aside copy are in the parent.
      await flush(dirname(live));
      // The row is read back before it is recorded done, so no misstep that
      // didn't throw becomes a claim.
      if (
        !holdsBackup(
          member,
          await fileSetManifest(live, member.exclude),
          manifest,
        )
      )
        throw unverified(
          `The restored ${member.namespaceId} does not match its backup.`,
        );
      await journal(async () => {
        await restore?.progress.finished(member.namespaceId);
      });
    }
  } finally {
    if (restore === undefined)
      await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Take a verified backup of the pipeline definitions family and return one
 * `namespace_backup` record per row (`storage-backup-restore.schema.yaml`).
 * With the family's writers stopped, each row is copied, flushed, checked
 * unchanged since the copy began, checked against its copy, digested, and
 * restore-tested into an empty root before any record is issued. A failed
 * backup removes what it wrote.
 */
export async function backupPipelineDefinitions(
  options: PipelineDefinitionsBackupOptions,
): Promise<readonly NamespaceBackupRecord[]> {
  const clock = options.clock ?? Date.now;
  const flush = confirmedFlush(options.syncDirectory);
  const rows = options.ownership ?? STORAGE_OWNERSHIP;
  assertRequiredBeforeFlip(rows);
  const recordPath = (member: PipelineDefinitionsBackupMember): string =>
    `${options.backupPath}/${member.namespaceId}`;
  for (const path of [
    options.backupPath,
    ...PIPELINE_DEFINITIONS_BACKUP_MEMBERS.map(recordPath),
  ]) {
    const pathError = namespaceBackupPathError(
      path,
      options.isOutsideCheckouts,
    );
    if (pathError !== undefined) throw unverified(pathError);
  }
  return options.quiesce(() =>
    underWriterLock(options, async () => {
      const root = options.dataRoot;
      const base = await resolveInsideDataRoot(root, options.backupPath);
      // A backup never replaces a file: not an earlier copy, and never a row.
      if (await isOccupied(base))
        throw unverified('The backup path already exists.');
      await assertNoInstallInFlight(root);
      const createdAt = new Date(clock()).toISOString();
      const sources: RowPlan[] = [];
      for (const member of PIPELINE_DEFINITIONS_BACKUP_MEMBERS)
        sources.push({
          member,
          manifest: await fileSetManifest(
            hostPath(root, member.path),
            member.exclude,
          ),
          copy: join(base, member.namespaceId, COPY_NAME),
        });
      const realRoot = await realpath(root);
      try {
        const folders = new Set<string>();
        for (const { member, manifest, copy } of sources) {
          await mkdir(join(base, member.namespaceId), { recursive: true });
          folders.add(join(base, member.namespaceId));
          const source = hostPath(root, member.path);
          for (const folder of await copyFileSet(
            source,
            copy,
            manifest,
            options.flushRequiresWriteHandle,
          ))
            folders.add(folder);
        }
        for (const folder of folders) await flush(folder);
        await flush(base);
        // Each folder's entry is in its parent, up to the data root. All of
        // them are flushed, not only the ones this backup created, so a folder
        // an earlier failed backup left is made durable too.
        for (
          let folder = base;
          folder !== realRoot && folder !== dirname(folder);
          folder = dirname(folder)
        )
          await flush(dirname(folder));
        for (const { member, manifest, copy } of sources) {
          const now = await fileSetManifest(
            hostPath(root, member.path),
            member.exclude,
          );
          if (fileSetDigest(now) !== fileSetDigest(manifest))
            throw new FileSetBackupError(
              'NOT_QUIESCED',
              `${member.namespaceId} changed while it was copied.`,
            );
          if (
            fileSetDigest(await fileSetManifest(copy)) !==
            fileSetDigest(manifest)
          )
            throw unverified(
              `The ${member.namespaceId} copy does not match the row it was taken from.`,
            );
        }
        const scratch = `${base}.restore-test-${randomUUID()}`;
        await mkdir(scratch);
        try {
          await putInPlace(scratch, sources, options);
          for (const { member, manifest } of sources) {
            const restored = await fileSetManifest(
              hostPath(scratch, member.path),
              member.exclude,
            );
            if (fileSetDigest(restored) !== fileSetDigest(manifest))
              throw unverified(
                `The restored ${member.namespaceId} does not match the row it was taken from.`,
              );
          }
        } finally {
          await rm(scratch, { recursive: true, force: true });
        }
        const restoreTestedAt = new Date(
          Math.max(clock(), Date.parse(createdAt)),
        ).toISOString();
        return sources.map(({ member, manifest }) => {
          const digest = fileSetDigest(manifest);
          const row = rows.find(
            (candidate) => candidate.id === member.namespaceId,
          );
          return createNamespaceBackupRecord(
            {
              namespaceId: member.namespaceId,
              backupPath: recordPath(member),
              sourceRevision: `sha256:${digest}`,
              schemaVersion: row?.schemaVersion ?? 'none',
              createdAt,
              verifiedBy: { algorithm: 'sha256', digest },
              rollbackMigration: PIPELINE_DEFINITIONS_ROLLBACK_MIGRATION,
              restoreTestedAt,
            },
            { rows, isOutsideCheckouts: options.isOutsideCheckouts },
          );
        });
      } catch (error) {
        await rm(base, { recursive: true, force: true });
        throw error;
      }
    }),
  );
}

/** The rows a restore puts back, as the journal names them. */
function journalRows(
  records: readonly NamespaceBackupRecord[],
): readonly (readonly string[])[] {
  return records
    .map(({ namespaceId, verifiedBy }) => [namespaceId, verifiedBy.digest])
    .sort();
}

/** How far an interrupted restore got with one row. */
type RowJournal =
  | {
      readonly status: 'pending';
      /** The row's contents before the restore. */
      readonly before: FileSetManifest;
      /** Set-aside paths earlier restores of the row used. */
      readonly asides: readonly string[];
    }
  | {
      readonly status: 'in_progress';
      readonly before: FileSetManifest;
      readonly asides: readonly string[];
      /** The set-aside path the row's earlier contents go to. */
      readonly aside: string;
      /** The staging folder the row's entries are placed from. */
      readonly staging: string;
      /** Top-level entries named before each was placed, in order. */
      readonly placed: readonly string[];
      /**
       * The entry named from this `staging` folder and maybe not yet moved:
       * the only named entry that may be missing from the row.
       */
      readonly moving: string | null;
    }
  | {
      readonly status: 'done';
      /** The digest of the row's contents once it was in place. */
      readonly digest: string;
      readonly asides: readonly string[];
    };

interface Journal {
  /** Every staging folder the restore created, removed when it finishes. */
  readonly staging: readonly string[];
  readonly rows: ReadonlyMap<string, RowJournal>;
}

function isFields(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function manifestOf(value: unknown): FileSetManifest | undefined {
  if (!isFields(value)) return undefined;
  if (value.kind === 'absent') return { kind: 'absent' };
  if (
    value.kind === 'file' &&
    typeof value.bytes === 'number' &&
    typeof value.sha256 === 'string'
  )
    return { kind: 'file', bytes: value.bytes, sha256: value.sha256 };
  if (
    value.kind !== 'directory' ||
    !Array.isArray(value.directories) ||
    !Array.isArray(value.files)
  )
    return undefined;
  const directories = value.directories.filter(
    (entry): entry is string => typeof entry === 'string',
  );
  const files = value.files.flatMap((entry: unknown) =>
    isFields(entry) &&
    typeof entry.path === 'string' &&
    typeof entry.bytes === 'number' &&
    typeof entry.sha256 === 'string'
      ? [{ path: entry.path, bytes: entry.bytes, sha256: entry.sha256 }]
      : [],
  );
  return files.length === value.files.length &&
    directories.length === value.directories.length
    ? { kind: 'directory', directories, files }
    : undefined;
}

function stringsOf(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter(
    (entry): entry is string => typeof entry === 'string',
  );
  return strings.length === value.length ? strings : undefined;
}

const STAGING_NAME = /^\.pipeline-definitions-restore-[0-9a-f-]{36}$/;

/** Whether `aside` is a set-aside path the restore could have chosen for `member`. */
function isAsideOf(
  aside: string,
  member: PipelineDefinitionsBackupMember,
): boolean {
  const suffix = aside.slice(`${member.path}.pre-restore-`.length);
  return (
    aside.startsWith(`${member.path}.pre-restore-`) &&
    /^\d+(-\d+)?$/.test(suffix)
  );
}

function rowJournalOf(
  value: unknown,
  member: PipelineDefinitionsBackupMember,
  staging: readonly string[],
): RowJournal | undefined {
  if (!isFields(value)) return undefined;
  const asides = stringsOf(value.asides);
  if (asides === undefined || asides.some((aside) => !isAsideOf(aside, member)))
    return undefined;
  if (value.status === 'done')
    return typeof value.digest === 'string'
      ? { status: 'done', digest: value.digest, asides }
      : undefined;
  const before = manifestOf(value.before);
  if (before === undefined) return undefined;
  if (value.status === 'pending') return { status: 'pending', before, asides };
  const placed = stringsOf(value.placed);
  const moving =
    value.moving === null || typeof value.moving === 'string'
      ? value.moving
      : undefined;
  return value.status === 'in_progress' &&
    moving !== undefined &&
    (moving === null || placed?.includes(moving) === true) &&
    typeof value.aside === 'string' &&
    isAsideOf(value.aside, member) &&
    typeof value.staging === 'string' &&
    staging.includes(value.staging) &&
    placed !== undefined
    ? {
        status: 'in_progress',
        before,
        asides,
        aside: value.aside,
        staging: value.staging,
        placed,
        moving,
      }
    : undefined;
}

/**
 * The journal of an interrupted restore from these records: where each row
 * got to. A journal for other records, or one this build can't read,
 * refuses the restore with a typed error; it is never resumed or rewritten.
 */
async function readJournal(
  path: string,
  rows: readonly (readonly string[])[],
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
    JSON.stringify(value.rows) !== JSON.stringify(rows) ||
    !isFields(value.state)
  )
    throw another;
  const staging = stringsOf(value.staging);
  if (staging === undefined || staging.some((name) => !STAGING_NAME.test(name)))
    throw another;
  const journal = new Map<string, RowJournal>();
  for (const member of PIPELINE_DEFINITIONS_BACKUP_MEMBERS) {
    const parsed = rowJournalOf(
      value.state[member.namespaceId],
      member,
      staging,
    );
    if (parsed === undefined) throw another;
    journal.set(member.namespaceId, parsed);
  }
  if (Object.keys(value.state).length !== journal.size) throw another;
  return { staging, rows: journal };
}

/**
 * A manifest's contents by top-level entry: each entry's files and folders
 * in canonical form. A file row is one entry named ''.
 */
function topLevelEntries(manifest: FileSetManifest): Map<string, string> {
  if (manifest.kind === 'absent') return new Map();
  if (manifest.kind === 'file') return new Map([['', manifest.sha256]]);
  const parts = new Map<string, string[]>();
  const add = (path: string, part: string): void => {
    const [name = ''] = path.split('/');
    parts.set(name, [...(parts.get(name) ?? []), part]);
  };
  for (const folder of manifest.directories) add(folder, `d ${folder}`);
  for (const file of manifest.files)
    add(file.path, `f ${file.path} ${file.sha256}`);
  return new Map(
    [...parts].map(([name, entry]) => [name, entry.sort().join('\n')]),
  );
}

/**
 * Whether a row an interrupted restore had started holds exactly that
 * restore's work. The restore first moves each earlier top-level entry to
 * the set-aside folder, then names each entry of the backup in the journal
 * and moves it in. So every entry the row holds must be whole: as it was
 * before, or, once named, as it is in the backup. The set-aside folder holds
 * only whole earlier entries, every earlier entry is in one of the two, and
 * every named entry is in the row, except the one named from the journal's
 * staging folder and maybe not yet moved, while its staged copy is whole. Anything deleted, added or changed since the
 * restore began fails it, except inside a further set-aside copy, which holds
 * only entries the first one also holds and which it doesn't read.
 */
function isRestoreProgress(progress: {
  readonly current: FileSetManifest;
  readonly aside: FileSetManifest;
  readonly staged: FileSetManifest;
  readonly before: FileSetManifest;
  readonly backup: FileSetManifest;
  readonly placed: readonly string[];
  readonly moving: string | null;
}): boolean {
  const earlier = topLevelEntries(progress.before);
  const restored = topLevelEntries(progress.backup);
  const live = topLevelEntries(progress.current);
  const setAside = topLevelEntries(progress.aside);
  const staged = topLevelEntries(progress.staged);
  const placed = new Set(progress.placed);
  if (placed.size !== progress.placed.length) return false;
  for (const [name, entry] of live)
    if ((placed.has(name) ? restored : earlier).get(name) !== entry)
      return false;
  for (const [name, entry] of setAside)
    if (earlier.get(name) !== entry) return false;
  for (const [name, entry] of earlier)
    if (
      setAside.get(name) !== entry &&
      (placed.has(name) || live.get(name) !== entry)
    )
      return false;
  for (const name of placed)
    if (
      !restored.has(name) ||
      (!live.has(name) &&
        (name !== progress.moving || staged.get(name) !== restored.get(name)))
    )
      return false;
  return true;
}

async function writeJournal(
  path: string,
  text: string,
  flush: Flush,
  writeHandle: boolean,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, text, { flag: 'wx' });
  await syncFile(temporary, writeHandle);
  await rename(temporary, path);
  await flush(dirname(path));
}

/**
 * The rollback migration the family's records name. With the family's
 * writers stopped, it checks every row's copy against its record and every
 * row against its current contents before changing anything: a row changed
 * since the backup is refused unless a person confirmed the loss, and its
 * contents are then set aside, never deleted. A journal in the backup folder
 * marks the restore unfinished until every row is in place, so an
 * interrupted restore completes when it is run again.
 */
export async function restorePipelineDefinitionsBackup(
  records: readonly NamespaceBackupRecord[],
  options: PipelineDefinitionsRestoreOptions,
): Promise<PipelineDefinitionsRestoreResult> {
  const rows = options.ownership ?? STORAGE_OWNERSHIP;
  const flush = confirmedFlush(options.syncDirectory);
  const verified = records.map((record) =>
    createNamespaceBackupRecord(record, {
      rows,
      isOutsideCheckouts: options.isOutsideCheckouts,
    }),
  );
  const byRow = new Map(verified.map((record) => [record.namespaceId, record]));
  const parents = new Set(
    verified.map((record) => posix.dirname(record.backupPath)),
  );
  const [parent] = parents;
  if (
    parent === undefined ||
    parents.size !== 1 ||
    verified.length !== PIPELINE_DEFINITIONS_BACKUP_MEMBERS.length ||
    byRow.size !== verified.length ||
    PIPELINE_DEFINITIONS_BACKUP_MEMBERS.some(
      ({ namespaceId }) => !byRow.has(namespaceId),
    ) ||
    verified.some(
      (record) =>
        record.rollbackMigration !== PIPELINE_DEFINITIONS_ROLLBACK_MIGRATION ||
        record.verifiedBy.algorithm !== 'sha256',
    )
  )
    throw unverified(
      'These records are not one pipeline definitions backup this build reads.',
    );
  return options.quiesce(() =>
    underWriterLock(options, async () => {
      const root = options.dataRoot;
      await assertNoInstallInFlight(root);
      const base = await resolveInsideDataRoot(root, parent);
      const journal = join(base, RESTORE_JOURNAL);
      const rows = journalRows(verified);
      const journalled = await readJournal(journal, rows);
      // An earlier attempt's journaled moves, and this attempt's, are flushed
      // in one order before any journal write, so no write records or forgets
      // a move whose destination isn't durable.
      const moves = movePlan(flush);
      const state = new Map<string, RowJournal>();
      const plans: RowPlan[] = [];
      const unchanged: string[] = [];
      const newer: string[] = [];
      /** The entries each resumed row has placed and still holds. */
      const resumed = new Map<string, readonly string[]>();
      for (const member of PIPELINE_DEFINITIONS_BACKUP_MEMBERS) {
        const record = byRow.get(member.namespaceId);
        if (record === undefined) throw unverified('A record is missing.');
        const copy = await resolveInsideDataRoot(
          root,
          `${record.backupPath}/${COPY_NAME}`,
        );
        const manifest = await fileSetManifest(copy);
        const digest = record.verifiedBy.digest;
        if (fileSetDigest(manifest) !== digest)
          throw unverified(
            `The ${member.namespaceId} copy does not match its record.`,
          );
        const current = await fileSetManifest(
          hostPath(root, member.path),
          member.exclude,
        );
        const row = journalled?.rows.get(member.namespaceId);
        const asides = row?.asides ?? [];
        if (row !== undefined)
          moves.record(
            ...rowMoves(
              root,
              member,
              asides,
              row.status === 'in_progress' ? row.staging : undefined,
            ),
          );
        if (holdsBackup(member, current, manifest)) {
          unchanged.push(member.namespaceId);
          state.set(member.namespaceId, { status: 'done', digest, asides });
          continue;
        }
        // A row resumes without a person's confirmation only while it holds
        // exactly what the interrupted restore left; any other difference is
        // newer state.
        if (row?.status === 'in_progress') {
          const progress = {
            current,
            aside: await fileSetManifest(hostPath(root, row.aside)),
            staged: await fileSetManifest(
              hostPath(root, `${row.staging}/${member.namespaceId}`),
            ),
            before: row.before,
            backup: manifest,
            placed: row.placed,
            moving: row.moving,
          };
          if (isRestoreProgress(progress)) {
            // An entry named but missing from the row was never moved, so
            // it isn't placed; every name kept is in the row from here on.
            const live = topLevelEntries(current);
            const placed = row.placed.filter(
              (name) => name !== row.moving || live.has(name),
            );
            resumed.set(member.namespaceId, placed);
            state.set(member.namespaceId, row);
            plans.push({
              member,
              copy,
              manifest,
              resume: { aside: row.aside, placed },
            });
            continue;
          }
        } else if (
          row?.status === 'pending' &&
          fileSetDigest(current) === fileSetDigest(row.before)
        ) {
          state.set(member.namespaceId, row);
          plans.push({ member, copy, manifest });
          continue;
        }
        // Restoring over an empty row loses nothing, unless a restore had
        // already begun and the row was emptied since.
        if (row !== undefined || !isEmpty(current))
          newer.push(member.namespaceId);
        state.set(member.namespaceId, {
          status: 'pending',
          before: current,
          asides,
        });
        plans.push({ member, copy, manifest });
      }
      const returns = new Map<string, OwnerReturn>();
      const returned: string[] = [];
      for (const record of verified) {
        const back = ownerReturn(
          record.namespaceId,
          await readOwnerFlipRecord(root, record.namespaceId),
          backupRecordReference(record.namespaceId, record.verifiedBy.digest),
          options.owner,
        );
        if (back === 'returned') returned.push(record.namespaceId);
        else if (back !== undefined) returns.set(record.namespaceId, back);
      }
      if (newer.length > 0) {
        if (options.acceptNewerLoss?.confirmedBy !== 'person')
          throw new FileSetBackupError(
            'NEWER_STATE',
            `Changed since the backup: ${newer.join(', ')}. Nothing was restored.`,
          );
        options.acceptNewerLoss.log({ backupPath: parent, rows: newer });
      }
      const recordOptions = {
        syncDirectory: options.syncDirectory,
        isOutsideCheckouts: options.isOutsideCheckouts,
        ownership: options.ownership,
      };
      const flip = async (
        record: NamespaceBackupRecord,
        { workPackage }: OwnerReturn,
        fromOwner: StorageTransitionOwner,
        toOwner: StorageTransitionOwner,
      ): Promise<void> => {
        const { namespaceId, verifiedBy } = record;
        const flippedAt = new Date((options.clock ?? Date.now)());
        await writeOwnerFlipRecord(
          root,
          {
            namespaceId,
            fromOwner,
            toOwner,
            workPackage,
            backupDigest: verifiedBy.digest,
            flippedAt: flippedAt.toISOString(),
          },
          recordOptions,
        );
      };
      // An offline record keeps every writer out of a row whose owner moved,
      // from before anything changes until the row is back in place. A fence
      // an earlier attempt left is written again, so it is flushed too.
      for (const record of verified) {
        const back = returns.get(record.namespaceId);
        if (back === undefined) continue;
        await persistNamespaceBackupRecord(root, record, recordOptions);
        await flip(record, back, back.from, 'offline');
      }
      const returnOwners = async (): Promise<void> => {
        for (const record of verified) {
          const back = returns.get(record.namespaceId);
          if (back !== undefined)
            await flip(record, back, 'offline', back.owner);
        }
        // An earlier attempt's return may not have been flushed.
        for (const namespaceId of returned) {
          const folder = hostPath(root, storageRecordsFolder(namespaceId));
          await flush(folder);
          await flush(dirname(folder));
          await flush(root);
        }
      };
      const staging = [...(journalled?.staging ?? [])];
      const save = async (): Promise<void> => {
        await moves.flush();
        await writeJournal(
          journal,
          JSON.stringify({
            version: 1,
            rows,
            staging,
            state: Object.fromEntries(state),
          }),
          flush,
          options.flushRequiresWriteHandle,
        );
      };
      const update = async (
        namespaceId: string,
        next: (row: RowJournal) => RowJournal,
      ): Promise<void> => {
        const row = state.get(namespaceId);
        if (row === undefined) throw unverified('A row is missing.');
        state.set(namespaceId, next(row));
        await save();
      };
      if (plans.length > 0) {
        const current = `${STAGING_PREFIX}${randomUUID()}`;
        staging.push(current);
        // The journal names the staging folder before it exists.
        await save();
        await putInPlace(root, plans, options, {
          staging: current,
          moves,
          progress: {
            started: (namespaceId, aside) =>
              update(namespaceId, (row) => {
                if (row.status === 'done') throw unverified('A row is done.');
                return {
                  status: 'in_progress',
                  before: row.before,
                  asides: row.asides.includes(aside)
                    ? row.asides
                    : [...row.asides, aside],
                  aside,
                  staging: current,
                  placed: resumed.get(namespaceId) ?? [],
                  moving: null,
                };
              }),
            // The entry is named last before it moves, so a retry finds it
            // either in the row or still whole in the staging folder.
            placing: (namespaceId, name) =>
              update(namespaceId, (row) => {
                if (row.status !== 'in_progress')
                  throw unverified('A row has not started.');
                return {
                  ...row,
                  placed: [...row.placed.filter((n) => n !== name), name],
                  moving: name,
                };
              }),
            asideAdded: (namespaceId, aside) =>
              update(namespaceId, (row) => {
                if (row.status !== 'in_progress')
                  throw unverified('A row has not started.');
                return { ...row, asides: [...row.asides, aside] };
              }),
            finished: (namespaceId) =>
              update(namespaceId, (row) => {
                const record = byRow.get(namespaceId);
                if (record === undefined)
                  throw unverified('A record is missing.');
                return {
                  status: 'done',
                  digest: record.verifiedBy.digest,
                  asides: row.asides,
                };
              }),
          },
        });
      }
      const setAside: string[] = [];
      for (const member of PIPELINE_DEFINITIONS_BACKUP_MEMBERS)
        for (const aside of state.get(member.namespaceId)?.asides ?? [])
          if (await isOccupied(hostPath(root, aside))) setAside.push(aside);
      if (journalled !== undefined || plans.length > 0) {
        // Every row's flushes run again before the journal goes, whether this
        // attempt touched the row or not: an earlier attempt may have put a row
        // in place and then failed to flush it.
        for (const member of PIPELINE_DEFINITIONS_BACKUP_MEMBERS) {
          const row = journalled?.rows.get(member.namespaceId);
          moves.record(
            ...rowMoves(
              root,
              member,
              state.get(member.namespaceId)?.asides ?? [],
              row?.status === 'in_progress' ? row.staging : undefined,
            ),
          );
        }
        await moves.flush();
        await flush(root);
        // Every row is in place and durable before its owner returns.
        await returnOwners();
        for (const name of staging)
          await rm(hostPath(root, name), { recursive: true, force: true });
        // The staging folders' removal is durable before the journal that
        // names them goes, so none can come back unnamed.
        if (staging.length > 0) await flush(root);
        await rm(journal, { force: true });
        await flush(base);
      } else await returnOwners();
      return {
        restored: plans.map(({ member }) => member.namespaceId),
        unchanged,
        setAside,
      };
    }),
  );
}
