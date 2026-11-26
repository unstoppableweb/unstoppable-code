import { createHash, randomUUID } from 'node:crypto';
import {
  constants,
  createReadStream,
  type BigIntStats,
  type Dirent,
  type Stats,
} from 'node:fs';
import {
  copyFile,
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import type { W5BackupPosition } from './commit-log/commit-log';
import { readW5BackupPosition } from './commit-log/backup-position';
import { readSchemaVersion } from './commit-log/database';
import { W5_COMMIT_LOG_SCHEMA_VERSION } from './commit-log/schema-version';
import { W5CommitLogError, W5CommitRefusedError } from './commit-log/errors';
import {
  w5RootEvidenceScope,
  requireW5RootEvidenceScope,
  sameW5RootEvidenceScope,
  type W5RootEvidenceScope,
} from './service-history';
import { isErrnoException } from './maintenance-guards';
import type { W5BackupReadContext } from './backup';

interface CaptureState {
  scope?: W5RootEvidenceScope;
  readonly directories: Map<string, Stats>;
}

const SET_ASIDE_RECORD = /^commit-log\.set-aside-[0-9a-f-]{36}\.json$/;

const isNameList = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((name) => typeof name === 'string');

interface SetAsideHistory {
  /** `w5/` entries, the record itself included. */
  readonly entries: Set<string>;
  readonly backups: Set<string>;
}

/**
 * The history that pre-writer checks recorded beside the unopenable logs they
 * set aside (CAN-7849). Only that history: anything a later log wrote is
 * still history without its log.
 */
async function setAsideHistory(
  w5: string,
  entries: readonly Dirent[],
): Promise<SetAsideHistory> {
  const history: SetAsideHistory = { entries: new Set(), backups: new Set() };
  for (const entry of entries) {
    if (!entry.isFile() || !SET_ASIDE_RECORD.test(entry.name)) continue;
    let value: unknown;
    try {
      value = JSON.parse(await readFile(join(w5, entry.name), 'utf8'));
    } catch {
      continue;
    }
    if (
      typeof value !== 'object' ||
      value === null ||
      !('version' in value) ||
      value.version !== 1 ||
      !('reason' in value) ||
      value.reason !== 'unopenable' ||
      !('history' in value) ||
      !isNameList(value.history) ||
      !('backups' in value) ||
      !isNameList(value.backups)
    )
      continue;
    history.entries.add(entry.name);
    for (const name of value.history) history.entries.add(name);
    for (const name of value.backups) history.backups.add(name);
  }
  return history;
}

async function noEarlierLogArtifacts(
  root: string,
  capture?: CaptureState,
): Promise<void> {
  const w5 = join(root, 'w5');
  for (const [path, identity] of capture?.directories ?? [])
    await requireDirectoryIdentity(path, identity);
  let entries;
  try {
    entries = await readdir(w5, { withFileTypes: true });
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return;
    throw error;
  }
  // A set-aside log holds this history; its loss was recorded, not suffered.
  const setAside = await setAsideHistory(w5, entries);
  for (const entry of entries) {
    if (
      entry.name !== 'backups' &&
      !entry.isSymbolicLink() &&
      setAside.entries.has(entry.name)
    )
      continue;
    if (
      entry.name !== 'backups' ||
      !entry.isDirectory() ||
      entry.isSymbolicLink()
    )
      throw new W5CommitLogError(
        'STORAGE_UNAVAILABLE',
        'W5 history exists without its log.',
      );
    for (const backup of await readdir(join(w5, 'backups'), {
      withFileTypes: true,
    })) {
      const path = join(w5, 'backups', backup.name);
      const created = capture?.directories.get(path);
      if (
        !backup.isDirectory() ||
        backup.isSymbolicLink() ||
        (!created &&
          !setAside.backups.has(backup.name) &&
          (await readdir(path)).length !== 0)
      )
        throw new W5CommitLogError(
          'STORAGE_UNAVAILABLE',
          'W5 history exists without its log.',
        );
      if (created) await requireDirectoryIdentity(path, created);
    }
  }
}
async function directoryIdentity(path: string): Promise<Stats | undefined> {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new W5CommitLogError(
        'STORAGE_UNAVAILABLE',
        'Unsafe W5 backup directory.',
      );
    return stat;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function requireDirectoryIdentity(
  path: string,
  before: Stats | undefined,
): Promise<void> {
  const after = await directoryIdentity(path);
  if (before?.dev !== after?.dev || before?.ino !== after?.ino)
    throw new W5CommitLogError(
      'STORAGE_UNAVAILABLE',
      'W5 backup directory changed.',
    );
}
/** Cold backup read only. Never creates, migrates or recovers a canonical log. */
export async function readOnlyW5BackupPosition(
  dataRoot: string,
): Promise<W5BackupPosition> {
  return readPosition(dataRoot);
}

/** Only directories made by this live capture context may gain backup files. */
export function createReadOnlyW5BackupContext(
  dataRoot: string,
): W5BackupReadContext {
  const capture: CaptureState = { directories: new Map() };
  return {
    dataRoot,
    host: {
      snapshot: (): Promise<W5BackupPosition> =>
        readPosition(dataRoot, capture),
    },
    captureCreated: async (directory: string): Promise<void> => {
      const scope = capture.scope;
      if (!scope) return;
      const suppliedPath = resolve(directory);
      // Resolve root aliases without following a symlink at the backup itself.
      const path = join(
        await realpath(dirname(suppliedPath)),
        basename(suppliedPath),
      );
      if (dirname(path) !== join(scope.canonicalDataRoot, 'w5', 'backups'))
        throw new W5CommitLogError(
          'STORAGE_UNAVAILABLE',
          'Unsafe W5 backup directory.',
        );
      await requireW5RootEvidenceScope(scope);
      await noEarlierLogArtifacts(scope.canonicalDataRoot, capture);
      const identity = await directoryIdentity(suppliedPath);
      if (!identity || (await readdir(path)).length !== 0)
        throw new W5CommitLogError(
          'STORAGE_UNAVAILABLE',
          'Unsafe W5 backup directory.',
        );
      await requireDirectoryIdentity(path, identity);
      await requireW5RootEvidenceScope(scope);
      capture.directories.set(path, identity);
    },
  };
}

function emptyPosition(): W5BackupPosition {
  return {
    commitId: 0,
    schemaVersion: W5_COMMIT_LOG_SCHEMA_VERSION,
    revisions: {},
  };
}

/** Any `w5_` object, even a partial schema the writer could not initialize. */
function holdsW5Objects(db: DatabaseSync): boolean {
  return (
    db
      .prepare(
        "SELECT 1 AS found FROM sqlite_master WHERE name LIKE 'w5\\_%' ESCAPE '\\' LIMIT 1",
      )
      .get() !== undefined
  );
}

async function readPosition(
  dataRoot: string,
  capture?: CaptureState,
): Promise<W5BackupPosition> {
  if (capture?.scope) await requireW5RootEvidenceScope(capture.scope);
  const scope = await w5RootEvidenceScope(dataRoot);
  if (capture?.scope && !sameW5RootEvidenceScope(scope, capture.scope))
    throw new W5CommitLogError(
      'STORAGE_UNAVAILABLE',
      'W5 backup root changed.',
    );
  const directory = join(scope.canonicalDataRoot, 'w5');
  const parent = await directoryIdentity(directory);
  const path = join(directory, 'commit-log.sqlite');
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'ENOENT') throw error;
    await noEarlierLogArtifacts(scope.canonicalDataRoot, capture);
    await requireDirectoryIdentity(directory, parent);
    await requireW5RootEvidenceScope(scope);
    if (capture) capture.scope = scope;
    return emptyPosition();
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
    throw new W5CommitLogError('STORAGE_UNAVAILABLE', 'Unsafe W5 backup log.');
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec('BEGIN');
    // A log without W5 objects is what its next writer initializes (CAN-7849).
    const position = holdsW5Objects(db)
      ? readW5BackupPosition(db)
      : emptyPosition();
    if (
      position.schemaVersion < 1 ||
      position.schemaVersion > W5_COMMIT_LOG_SCHEMA_VERSION
    )
      throw new W5CommitLogError(
        'UNSUPPORTED_SCHEMA',
        'Unsupported W5 backup log.',
      );
    const after = await lstat(path);
    await requireDirectoryIdentity(directory, parent);
    await requireW5RootEvidenceScope(scope);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      !after.isFile() ||
      after.isSymbolicLink() ||
      after.nlink !== 1
    )
      throw new W5CommitLogError(
        'STORAGE_UNAVAILABLE',
        'W5 backup log changed.',
      );
    return position;
  } catch (error) {
    if (
      error instanceof W5CommitLogError ||
      error instanceof W5CommitRefusedError
    )
      throw error;
    const code: unknown =
      typeof error === 'object' && error !== null && 'errcode' in error
        ? error.errcode
        : undefined;
    throw new W5CommitLogError(
      code === 5 || code === 6 ? 'WRITER_UNAVAILABLE' : 'STORAGE_UNAVAILABLE',
      'W5 backup log is unavailable.',
      error,
    );
  } finally {
    db?.close();
  }
}

/** The inode at `w5/commit-log.sqlite`; bigint keeps NTFS file ids exact. */
export interface W5LogIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

/**
 * The commit log as found before this launch's first writer opens it.
 * `absent` has no log and no WAL or rollback journal with bytes beside it;
 * `setAside` names the files of an unopenable log this check moved away.
 * `initialized` is a single-link regular file whose main file holds a
 * supported W5 schema; `preserved` names its copy when a WAL or hot journal
 * with bytes was beside it. `preserved` is any other log a writer could open
 * (zero-byte, schema-less, a schema only in its WAL, or a journal without its
 * log) or an unopenable one that was not set aside, copied byte for byte
 * before any writer ran. A log that is linked, not a regular file, has a
 * newer schema or could not be read, any error, and a damaged log whose
 * files could not be copied are `unverified`.
 */
export type W5PreWriterLog =
  | { readonly state: 'absent'; readonly setAside?: string }
  | {
      readonly state: 'initialized';
      readonly log: W5LogIdentity;
      readonly preserved?: string;
    }
  | {
      readonly state: 'preserved';
      /** Absent when only a journal was found. */
      readonly log?: W5LogIdentity;
      readonly preserved: string;
    }
  | { readonly state: 'unverified' };

const UNVERIFIED: W5PreWriterLog = Object.freeze({ state: 'unverified' });

/** `-shm` is excluded: SQLite rebuilds it and never reads it without a WAL. */
const LOG_SIDECARS = ['-wal', '-journal'] as const;

interface LogPart {
  readonly suffix: '' | (typeof LOG_SIDECARS)[number];
  readonly stat: BigIntStats;
}

function isSingleLinkFile(stat: BigIntStats): boolean {
  return stat.isFile() && stat.nlink === 1n;
}

function sameFileState(a: BigIntStats, b: BigIntStats): boolean {
  return (
    a.isFile() &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

async function lstatIfPresent(path: string): Promise<BigIntStats | undefined> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

/** SQLite's own verdict that the bytes are damaged, never an access failure. */
function reportsCorruption(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('errcode' in error))
    return false;
  const code = error.errcode;
  if (typeof code !== 'number') return false;
  const primary = code & 0xff;
  return primary === SQLITE_CORRUPT || primary === SQLITE_NOTADB;
}

/**
 * Reads only: `immutable` takes no locks and creates no `-wal`/`-shm`, and
 * ignores any WAL. `corrupt` is SQLite reporting damaged bytes; any other
 * failure (access, I/O, a race) is `unreadable`.
 */
function mainFileSchema(
  path: string,
): 'supported' | 'newer' | 'none' | 'corrupt' | 'unreadable' {
  const url = pathToFileURL(path);
  url.searchParams.set('immutable', '1');
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(url, { readOnly: true });
    const version = readSchemaVersion(db);
    if (version === null || !Number.isSafeInteger(version) || version < 1)
      return 'none';
    return version > W5_COMMIT_LOG_SCHEMA_VERSION ? 'newer' : 'supported';
  } catch (error) {
    return reportsCorruption(error) ? 'corrupt' : 'unreadable';
  } finally {
    db?.close();
  }
}

/**
 * The schema read of `mainFileSchema`, as a writer's open makes it: under
 * SQLite's shared lock and through any WAL, so a held log reports busy and a
 * repairable one opens. Read-only; on a WAL-mode header SQLite may create an
 * empty `-wal`/`-shm`.
 */
function lockedReadReportsCorruption(path: string): boolean {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true, timeout: 0 });
    readSchemaVersion(db);
    return false;
  } catch (error) {
    return reportsCorruption(error);
  } finally {
    try {
      db?.close();
    } catch {
      // Closing a failed read-only connection writes nothing.
    }
  }
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function flushFile(path: string): Promise<void> {
  const handle = await open(path, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Copies the log's files beside it as `commit-log.preserved-<digest>.sqlite*`
 * with a manifest written last. Names follow the bytes, so the same log is
 * kept once however often it is seen; nothing here deletes or overwrites a
 * copy of other bytes. Returns the data-root-relative name.
 */
async function preserveLogParts(
  directory: string,
  parts: readonly LogPart[],
  syncDirectory: (path: string) => Promise<unknown>,
): Promise<string> {
  const token = randomUUID();
  const source = (suffix: string): string =>
    join(directory, `commit-log.sqlite${suffix}`);
  const staged = parts.map((part) => ({
    ...part,
    temporary: join(
      directory,
      `.commit-log.preserving-${token}.sqlite${part.suffix}`,
    ),
  }));
  const temporaryManifest = join(
    directory,
    `.commit-log.preserving-${token}.json`,
  );
  try {
    for (const part of staged)
      await copyFile(
        source(part.suffix),
        part.temporary,
        constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
      );
    // Unchanged sources mean the copies hold the bytes a writer would open.
    for (const suffix of ['', ...LOG_SIDECARS]) {
      const before = staged.find((part) => part.suffix === suffix)?.stat;
      const after = await lstatIfPresent(source(suffix));
      if (
        before === undefined
          ? after !== undefined
          : after === undefined || !sameFileState(after, before)
      )
        throw new W5CommitLogError(
          'STORAGE_UNAVAILABLE',
          'W5 log changed while it was preserved.',
        );
    }
    const described: {
      readonly suffix: string;
      readonly size: number;
      readonly sha256: string;
    }[] = [];
    for (const part of staged) {
      await flushFile(part.temporary);
      described.push({
        suffix: part.suffix,
        size: Number(part.stat.size),
        sha256: await fileSha256(part.temporary),
      });
    }
    const name = `commit-log.preserved-${createHash('sha256')
      .update(JSON.stringify(described))
      .digest('hex')
      .slice(0, 32)}`;
    // An earlier copy under this name holds these same bytes.
    for (const part of staged)
      await rename(
        part.temporary,
        join(directory, `${name}.sqlite${part.suffix}`),
      );
    await writeFile(
      temporaryManifest,
      `${JSON.stringify({ version: 1, source: 'w5/commit-log.sqlite', parts: described }, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    await flushFile(temporaryManifest);
    await rename(temporaryManifest, join(directory, `${name}.json`));
    await syncDirectory(directory);
    return `w5/${name}`;
  } finally {
    for (const path of [
      ...staged.map((part) => part.temporary),
      temporaryManifest,
    ])
      await unlink(path).catch(() => undefined);
  }
}

interface LogFiles {
  readonly main?: BigIntStats;
  readonly parts: readonly LogPart[];
  /** A linked or special sidecar is never copied or moved through. */
  readonly uncopyable: boolean;
}

async function readLogFiles(path: string): Promise<LogFiles> {
  const main = await lstatIfPresent(path);
  const parts: LogPart[] = main ? [{ suffix: '', stat: main }] : [];
  let uncopyable = false;
  for (const suffix of LOG_SIDECARS) {
    const stat = await lstatIfPresent(`${path}${suffix}`);
    if (stat === undefined) continue;
    if (stat.isFile()) parts.push({ suffix, stat });
    else uncopyable = true;
  }
  return main ? { main, parts, uncopyable } : { parts, uncopyable };
}

/** Same parts, each the same file with the same size and times. */
async function partsUnchanged(
  path: string,
  parts: readonly LogPart[],
): Promise<boolean> {
  for (const suffix of ['', ...LOG_SIDECARS]) {
    const before = parts.find((part) => part.suffix === suffix)?.stat;
    const now = await lstatIfPresent(`${path}${suffix}`);
    if (before === undefined || now === undefined) {
      if (before !== now) return false;
    } else if (!sameFileState(now, before)) return false;
  }
  return true;
}

const LIVE_LOG_NAMES = new Set([
  'commit-log.sqlite',
  ...LOG_SIDECARS.map((suffix) => `commit-log.sqlite${suffix}`),
]);

/**
 * The W5 history a set-aside leaves without its log, for its record to list.
 * `undefined` where `noEarlierLogArtifacts` refuses even listed history (a
 * symlink or a backup that is not a directory): moving the log would then
 * cost its commits and still refuse.
 */
async function historyBesideLog(
  directory: string,
): Promise<
  { readonly entries: string[]; readonly backups: string[] } | undefined
> {
  const entries: string[] = [];
  const backups: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (LIVE_LOG_NAMES.has(entry.name)) continue;
    if (entry.isSymbolicLink()) return undefined;
    entries.push(entry.name);
    if (entry.name !== 'backups') continue;
    if (!entry.isDirectory()) return undefined;
    for (const backup of await readdir(join(directory, 'backups'), {
      withFileTypes: true,
    })) {
      if (!backup.isDirectory() || backup.isSymbolicLink()) return undefined;
      backups.push(backup.name);
    }
  }
  return { entries, backups };
}

/**
 * Moves a log SQLite reports damaged out of the writers' path (CAN-7849),
 * so the root is the one a launch without any log starts from. Only after a
 * verified byte-for-byte copy, a locked read that also reports damage (a
 * held log reports busy instead; a WAL that repairs it opens), the caller's
 * admission and an unchanged identity for every part; then renames only,
 * sidecars before the main file. The record lists the history beside the
 * log, which the read-only capture then accepts without it. Anything else
 * leaves the log in place.
 */
async function setAsideUnopenableLog(
  directory: string,
  observed: BigIntStats,
  syncDirectory: (path: string) => Promise<unknown>,
  admit: () => Promise<boolean>,
): Promise<string | undefined> {
  const path = join(directory, 'commit-log.sqlite');
  if (!lockedReadReportsCorruption(path)) return undefined;
  // The locked read may have created an empty `-wal`; it moves with the log.
  const files = await readLogFiles(path);
  if (
    files.uncopyable ||
    files.main === undefined ||
    !sameFileState(files.main, observed)
  )
    return undefined;
  const preserved = await preserveLogParts(
    directory,
    files.parts,
    syncDirectory,
  );
  const history = await historyBesideLog(directory);
  if (history === undefined || !(await admit())) return undefined;
  const name = `commit-log.set-aside-${randomUUID()}`;
  const movedNames = files.parts.map((part) => `${name}.sqlite${part.suffix}`);
  const temporaryRecord = join(directory, `.${name}.json`);
  try {
    await writeFile(
      temporaryRecord,
      `${JSON.stringify(
        {
          version: 1,
          source: 'w5/commit-log.sqlite',
          reason: 'unopenable',
          preserved,
          parts: files.parts.map((part) => part.suffix),
          setAsideAt: new Date().toISOString(),
          history: [...history.entries, ...movedNames],
          backups: history.backups,
        },
        null,
        2,
      )}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    await flushFile(temporaryRecord);
    if (!(await partsUnchanged(path, files.parts))) return undefined;
    await rename(temporaryRecord, join(directory, `${name}.json`));
    await syncDirectory(directory);
  } finally {
    await unlink(temporaryRecord).catch(() => undefined);
  }
  // Main last: a main file without its moved WAL is still unopenable.
  const ordered = [...files.parts].sort(
    (a, b) => Number(a.suffix === '') - Number(b.suffix === ''),
  );
  for (const part of ordered) {
    const current = await lstatIfPresent(`${path}${part.suffix}`);
    if (!current || !sameFileState(current, part.stat)) return undefined;
    await rename(
      `${path}${part.suffix}`,
      join(directory, `${name}.sqlite${part.suffix}`),
    );
  }
  await syncDirectory(directory);
  return `w5/${name}`;
}

/**
 * Call before any writer of this launch can open, create or recover the log.
 * The copy lets a refused capture launch over a damaged log without a writer
 * losing its bytes: the writers' initialization of a schema-less file or
 * their WAL replay then never decides what later launches see. With
 * `admitSetAside`, a log SQLite cannot open is also moved aside (see
 * `setAsideUnopenableLog`); without it, or when that does not complete, the
 * log stays and is copied.
 */
export async function observeW5LogBeforeWriters(
  canonicalDataRoot: string,
  syncDirectory: (path: string) => Promise<unknown>,
  admitSetAside?: () => Promise<boolean>,
): Promise<W5PreWriterLog> {
  const directory = join(canonicalDataRoot, 'w5');
  const path = join(directory, 'commit-log.sqlite');
  try {
    const parent = await lstatIfPresent(directory);
    if (parent === undefined) return { state: 'absent' };
    if (!parent.isDirectory()) return UNVERIFIED;
    const { main, parts, uncopyable } = await readLogFiles(path);
    // Only sidecar bytes are replayed or folded into the log by a writer.
    const pending = parts.some(
      (part) => part.suffix !== '' && part.stat.size > 0n,
    );
    const preserve = async (
      files: LogFiles = { parts, uncopyable },
    ): Promise<string | undefined> =>
      files.uncopyable
        ? undefined
        : preserveLogParts(directory, files.parts, syncDirectory).catch(
            () => undefined,
          );
    if (main === undefined) {
      if (uncopyable) return UNVERIFIED;
      if (!pending) return { state: 'absent' };
      const preserved = await preserve();
      return preserved === undefined
        ? UNVERIFIED
        : { state: 'preserved', preserved };
    }
    if (!isSingleLinkFile(main)) return UNVERIFIED;
    const schema = mainFileSchema(path);
    const after = await lstat(path, { bigint: true });
    if (
      schema === 'newer' ||
      schema === 'unreadable' ||
      !isSingleLinkFile(after) ||
      after.dev !== main.dev ||
      after.ino !== main.ino
    )
      return UNVERIFIED;
    const log: W5LogIdentity = { dev: main.dev, ino: main.ino };
    if (schema === 'supported' && !pending && !uncopyable)
      return { state: 'initialized', log };
    if (schema === 'corrupt' && !uncopyable && admitSetAside) {
      const setAside = await setAsideUnopenableLog(
        directory,
        main,
        syncDirectory,
        admitSetAside,
      ).catch(() => undefined);
      if (setAside !== undefined) return { state: 'absent', setAside };
      // The log stays; its locked read may have added an empty `-wal`.
      const current = await readLogFiles(path);
      if (current.main === undefined || !sameFileState(current.main, main))
        return UNVERIFIED;
      const preserved = await preserve(current);
      return preserved === undefined
        ? UNVERIFIED
        : { state: 'preserved', log, preserved };
    }
    const preserved = await preserve();
    // #10597 launched this log, ignoring its sidecars; an uncopied one still does.
    if (schema === 'supported')
      return {
        state: 'initialized',
        log,
        ...(preserved !== undefined && { preserved }),
      };
    return preserved === undefined
      ? UNVERIFIED
      : { state: 'preserved', log, preserved };
  } catch {
    return UNVERIFIED;
  }
}

/** Whether the log is still the single-link file a pre-writer check found. */
async function isObservedW5Log(
  path: string,
  log: W5LogIdentity,
): Promise<boolean> {
  const current = await lstatIfPresent(path);
  return (
    current !== undefined &&
    isSingleLinkFile(current) &&
    current.dev === log.dev &&
    current.ino === log.ino
  );
}

/**
 * Whether the log the next writer opens is still the observed one: the same
 * single-link file, or, where only a journal was found, none or a writer's
 * new single-link file. `absent` holds whatever a writer created since.
 */
export async function w5LogMatchesObservation(
  canonicalDataRoot: string,
  observed: W5PreWriterLog,
): Promise<boolean> {
  if (observed.state === 'absent') return true;
  if (observed.state === 'unverified') return false;
  const path = join(canonicalDataRoot, 'w5', 'commit-log.sqlite');
  try {
    if (observed.log !== undefined)
      return await isObservedW5Log(path, observed.log);
    const current = await lstatIfPresent(path);
    return current === undefined || isSingleLinkFile(current);
  } catch {
    return false;
  }
}
