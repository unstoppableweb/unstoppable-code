import { AsyncLocalStorage } from 'node:async_hooks';
import type { Stats } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  constants,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { flushDirectory } from '@canopy/core-platform/directory-flush';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { isPathInside } from '@canopy/execution-engine/node/lib/path-safety';

// Owner-only permissions for memory data at rest. Node accepts `mode` on all
// platforms; on Windows it is effectively a no-op, which is the intended
// graceful degradation (no chmod calls that could throw there).
export const MEMORY_DIR_MODE = 0o700;
export const MEMORY_FILE_MODE = 0o600;

export function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

export async function ensureOwnerOnlyDir(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: MEMORY_DIR_MODE });
  // mkdir's mode only applies on creation; tighten pre-existing directories
  // (e.g. created by the open-memory-folder flow) to owner-only too.
  try {
    await chmod(directory, MEMORY_DIR_MODE);
  } catch (error) {
    // Windows has no POSIX modes; keep the directory as created there. On
    // POSIX platforms fail closed instead of writing memory data into a
    // directory whose permissions could not be tightened.
    if (hostOperatingSystem() !== 'win32') throw error;
  }
}

/**
 * A memory path that is a symbolic link or junction, lies under one, or
 * resolves outside its scope directory. `linkedPath` is the first component
 * that broke containment.
 */
export class MemoryPathNotContainedError extends Error {
  constructor(readonly linkedPath: string) {
    super(`${linkedPath} is a link or leads outside its memory folder`);
    this.name = 'MemoryPathNotContainedError';
  }
}

/**
 * Rejects with {@link MemoryPathNotContainedError} unless `path` stays in
 * `scopeDir`: every existing component below the scope directory is a real
 * file or directory, never a symbolic link or junction (lstat reports both
 * as links), and the deepest existing one resolves inside the scope
 * directory's real path, which also catches other reparse points. Missing
 * components pass, so a write may create them. The scope directory itself
 * is trusted as it is reached; a data root may be linked.
 */
export async function assertMemoryPathContained(
  scopeDir: string,
  path: string,
): Promise<void> {
  const root = resolve(scopeDir);
  const target = resolve(path);
  if (!isPathInside(root, target)) throw new MemoryPathNotContainedError(path);
  if (target === root) return;
  let deepest = root;
  for (const segment of relative(root, target).split(sep)) {
    const next = join(deepest, segment);
    let info: Stats;
    try {
      info = await lstat(next);
    } catch (error) {
      if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ENOTDIR')) break;
      throw error;
    }
    if (info.isSymbolicLink()) throw new MemoryPathNotContainedError(next);
    deepest = next;
  }
  if (deepest === root) return;
  const [rootReal, deepestReal] = await Promise.all([
    realpath(root),
    realpath(deepest),
  ]);
  if (deepestReal === rootReal || !isPathInside(rootReal, deepestReal)) {
    throw new MemoryPathNotContainedError(deepest);
  }
}

/** Whether `path` stays in `scopeDir` (see {@link assertMemoryPathContained}). */
export async function isMemoryPathContained(
  scopeDir: string,
  path: string,
): Promise<boolean> {
  try {
    await assertMemoryPathContained(scopeDir, path);
    return true;
  } catch (error) {
    if (error instanceof MemoryPathNotContainedError) return false;
    throw error;
  }
}

/**
 * {@link ensureOwnerOnlyDir} for a directory in `scopeDir`, refusing one
 * that is a link or under one before anything is created or chmodded.
 */
export async function ensureOwnerOnlyMemoryDir(
  scopeDir: string,
  directory: string,
): Promise<void> {
  await assertMemoryPathContained(scopeDir, directory);
  await ensureOwnerOnlyDir(directory);
}

/** A scope lock a critical section holds (see `withMemoryScopeLock`). */
export interface HeldMemoryScopeLock {
  assertHeld(): Promise<void>;
}

interface ScopeLockHold {
  lock: HeldMemoryScopeLock;
  active: boolean;
}

const heldScopeLocks = new AsyncLocalStorage<readonly ScopeLockHold[]>();

/** Runs `critical` as a section holding `lock`, nested in any outer one. */
export async function runHoldingMemoryScopeLock<T>(
  lock: HeldMemoryScopeLock,
  critical: () => Promise<T>,
): Promise<T> {
  const hold: ScopeLockHold = { lock, active: true };
  try {
    return await heldScopeLocks.run(
      [...(heldScopeLocks.getStore() ?? []), hold],
      critical,
    );
  } finally {
    hold.active = false;
  }
}

/**
 * Call right before each write commit (a rename, link, create or delete of a
 * memory file). Inside a section holding scope locks it rejects with
 * `LocalMemoryScopeLockLostError` once another process has taken one over,
 * so a holder never commits a write after losing its lock. Elsewhere, and
 * in work a section leaves running after it ends, it does nothing.
 */
export async function assertMemoryScopeLockHeld(): Promise<void> {
  for (const hold of heldScopeLocks.getStore() ?? []) {
    if (hold.active) await hold.lock.assertHeld();
  }
}

export interface MemoryFileTimes {
  atime: Date;
  mtime: Date;
}

const WRITE_TEMP_PREFIX = '.memory-write-';
const WRITE_TEMP_PATTERN = /^\.memory-write-[0-9a-f-]{36}\.tmp$/;
const RETIRE_TEMP_PATTERN = /^\.memory-retire-[0-9a-f-]{36}\.tmp$/;

/**
 * A sibling temp file for a write into `directory`: a dot entry every reader
 * ignores, whose name does not grow with the target's. Only writers holding
 * the scope lock create these, so one found under the lock was left by a
 * writer that died (see {@link sweepAbandonedMemoryWrites}).
 */
function memoryWriteTempPath(directory: string): string {
  return join(directory, `${WRITE_TEMP_PREFIX}${randomUUID()}.tmp`);
}

/** The scope's folders a write may leave a temp file in, the scope first. */
const WRITE_FOLDERS = [
  '',
  'inbox',
  join('inbox', '.consolidated'),
  'imported',
  join('imported', '.consolidated'),
  'topics',
];

/**
 * Removes the temp files of writes that never finished: a writer that died
 * between writing its temp file and renaming it leaves one behind. Call it
 * holding the scope lock, so no live writer's temp file can be among them.
 * A name a move retired (see {@link retireName}) goes only while another
 * name holds its file; alone, it may hold an editor's save, and stays.
 * Folders that are links, or under one, are left alone.
 */
export async function sweepAbandonedMemoryWrites(
  scopeDir: string,
): Promise<void> {
  for (const folder of WRITE_FOLDERS) {
    const directory = join(scopeDir, folder);
    if (!(await isMemoryPathContained(scopeDir, directory))) continue;
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ENOTDIR')) {
        continue;
      }
      throw error;
    }
    for (const name of names.filter(
      (entry) =>
        WRITE_TEMP_PATTERN.test(entry) || RETIRE_TEMP_PATTERN.test(entry),
    )) {
      const path = join(directory, name);
      const info = await lstat(path).catch(() => null);
      if (info === null || info.isDirectory()) continue;
      if (RETIRE_TEMP_PATTERN.test(name) && info.nlink < 2) continue;
      await assertMemoryScopeLockHeld();
      await unlink(path).catch(() => undefined);
    }
  }
}

/**
 * Replaces a memory file in `scopeDir` owner-only through a sibling temp
 * file and rename, refusing a directory that is a link or under one (see
 * {@link assertMemoryPathContained}); a link at `filePath` itself is
 * replaced, never followed. With `times`, the replacement keeps them: they
 * are set on the temp file before the rename, so the target never holds the
 * new bytes with a new modification time, even after a crash. The temp file
 * is a dot entry whose name does not grow with the target's, so a target
 * near the file name length limit can still be replaced.
 */
export async function writeMemoryFileAtomically(
  scopeDir: string,
  filePath: string,
  content: string | Buffer,
  times?: MemoryFileTimes,
): Promise<void> {
  await replaceThroughTempFile(scopeDir, filePath, content, times);
}

/**
 * {@link writeMemoryFileAtomically} while `unchanged` still holds right
 * before the rename; false, with nothing replaced, once it does not. The
 * scope lock keeps the app's writers out, not another editor: checked last,
 * a save that editor makes while the caller decided what to write is kept.
 */
export function replaceMemoryFileIfUnchanged(
  scopeDir: string,
  filePath: string,
  content: string | Buffer,
  unchanged: () => Promise<boolean>,
): Promise<boolean> {
  return replaceThroughTempFile(
    scopeDir,
    filePath,
    content,
    undefined,
    unchanged,
  );
}

async function replaceThroughTempFile(
  scopeDir: string,
  filePath: string,
  content: string | Buffer,
  times?: MemoryFileTimes,
  unchanged?: () => Promise<boolean>,
): Promise<boolean> {
  const directory = dirname(filePath);
  await ensureOwnerOnlyMemoryDir(scopeDir, directory);
  const temporaryPath = memoryWriteTempPath(directory);
  try {
    await writeFile(temporaryPath, content, {
      encoding: 'utf8',
      flag: 'wx',
      mode: MEMORY_FILE_MODE,
    });
    if (times) await utimes(temporaryPath, times.atime, times.mtime);
    await assertMemoryPathContained(scopeDir, directory);
    await assertMemoryScopeLockHeld();
    if (unchanged !== undefined && !(await unchanged())) {
      await unlink(temporaryPath).catch(() => undefined);
      return false;
    }
    await rename(temporaryPath, filePath);
    return true;
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

/**
 * Memory files are `.md` exactly; the check is case-sensitive everywhere
 * (listing, consolidation input, pending-note counts) so a `NOTE.MD` is
 * consistently ignored rather than counted in one place and skipped in
 * another. Dot entries (`.lock/`, `.sync/`, temp and editor files) are never
 * memory.
 */
export function isMemoryMarkdownFileName(name: string): boolean {
  return name.endsWith('.md') && !name.startsWith('.');
}

const HARD_LINK_UNSUPPORTED = ['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS', 'EMLINK'];

function hardLinksUnsupported(error: unknown): boolean {
  return (
    !isNodeError(error, 'EEXIST') &&
    HARD_LINK_UNSUPPORTED.some((code) => isNodeError(error, code))
  );
}

/** A create-only write or move whose destination name is taken. */
class MemoryFileExistsError extends Error {
  readonly code = 'EEXIST';

  constructor(readonly path: string) {
    super(`${path} already exists`);
    this.name = 'MemoryFileExistsError';
  }
}

async function assertAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return;
    throw error;
  }
  throw new MemoryFileExistsError(path);
}

/**
 * Gives the complete file at `temporary` the name `destination`, which must
 * not exist yet; the temp file's name is gone afterwards. A hard link
 * publishes it atomically and never replaces anything. Without hard links no
 * portable rename refuses an existing target, so the name is checked free
 * and then renamed onto: only a writer outside the scope lock (an older
 * build, the user) creating that exact name in between could be replaced.
 * Either way a crash leaves the destination absent or complete, never cut
 * short. Callers have checked containment and the scope lock.
 */
async function publishWithoutReplacing(
  temporary: string,
  destination: string,
  tryLink: boolean,
): Promise<void> {
  if (tryLink) {
    try {
      await link(temporary, destination);
      // Published: a temp name left behind is swept as an abandoned write.
      await unlink(temporary).catch(() => undefined);
      return;
    } catch (error) {
      if (isNodeError(error, 'EEXIST')) {
        throw new MemoryFileExistsError(destination);
      }
      if (!hardLinksUnsupported(error)) throw error;
    }
  }
  await assertAbsent(destination);
  await rename(temporary, destination);
}

/**
 * Creates a memory file in `scopeDir` owner-only, whole or not at all,
 * rejecting with {@link MemoryFileExistsError} when `filePath` is taken. The
 * bytes go to a sibling temp file first, so a crash part way never leaves a
 * file cut short under the new name.
 */
export async function writeNewMemoryFile(
  scopeDir: string,
  filePath: string,
  content: string,
): Promise<void> {
  const directory = dirname(filePath);
  await assertMemoryPathContained(scopeDir, directory);
  const temporaryPath = memoryWriteTempPath(directory);
  try {
    await writeFile(temporaryPath, content, {
      encoding: 'utf8',
      flag: 'wx',
      mode: MEMORY_FILE_MODE,
    });
    await assertMemoryPathContained(scopeDir, directory);
    await assertMemoryScopeLockHeld();
    await publishWithoutReplacing(temporaryPath, filePath, true);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

/**
 * {@link writeNewMemoryFile}, or with `replace` {@link writeMemoryFileAtomically},
 * for a file that must survive a crash before the caller drops the only other
 * copy of its content: the bytes and the name are flushed to disk before it
 * resolves. A taken name rejects with EEXIST unless `replace` is set.
 */
export async function writeMemoryFileDurably(
  scopeDir: string,
  filePath: string,
  content: string | Buffer,
  options: { replace: boolean; times?: MemoryFileTimes },
): Promise<void> {
  const directory = dirname(filePath);
  await ensureOwnerOnlyMemoryDir(scopeDir, directory);
  const temporaryPath = memoryWriteTempPath(directory);
  try {
    const handle = await open(temporaryPath, 'wx', MEMORY_FILE_MODE);
    try {
      await handle.writeFile(content, 'utf8');
      if (options.times) {
        await handle.utimes(options.times.atime, options.times.mtime);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertMemoryPathContained(scopeDir, directory);
    await assertMemoryScopeLockHeld();
    if (options.replace) {
      await rename(temporaryPath, filePath);
    } else {
      await publishWithoutReplacing(temporaryPath, filePath, true);
    }
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  await flushDirectory(directory);
}

/** A move whose source changed after it was linked: nothing was moved. */
class MemoryFileChangedError extends Error {
  readonly code = 'ECHANGED';

  constructor(readonly path: string) {
    super(`${path} changed while it was moved`);
    this.name = 'MemoryFileChangedError';
  }
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

async function identityOf(path: string): Promise<FileIdentity | null> {
  try {
    const info = await lstat(path, { bigint: true });
    return info.isFile() ? { dev: info.dev, ino: info.ino } : null;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null;
    throw error;
  }
}

function sameIdentity(
  left: FileIdentity | null,
  right: FileIdentity | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

/**
 * Whether two names reach one directory entry, as two spellings of a name
 * do where the file system folds letter case or normalization: one file
 * whose directory lists at most one of the names. Two hard links list both.
 */
async function isOneEntry(left: string, right: string): Promise<boolean> {
  if (dirname(left) !== dirname(right)) return false;
  if (!sameIdentity(await identityOf(left), await identityOf(right))) {
    return false;
  }
  const names = await readdir(dirname(left));
  return !(names.includes(basename(left)) && names.includes(basename(right)));
}

const RETIRE_TEMP_PREFIX = '.memory-retire-';

/**
 * Takes `path`'s name away from whatever file holds it now, atomically, and
 * removes that file only when `moved` says it is the file the caller moved
 * elsewhere. Any other file, one an editor saved there since, gets its name
 * back. A name never loses a file nobody checked: the check runs on the
 * file the rename took, which no one else can reach under its retired
 * name. A crash in between leaves the retired name, a dot entry no reader
 * or sweep touches, with the bytes it holds.
 */
async function retireName(
  path: string,
  moved: (retired: string) => Promise<boolean>,
): Promise<'retired' | 'gone' | 'kept'> {
  const retired = join(
    dirname(path),
    `${RETIRE_TEMP_PREFIX}${randomUUID()}.tmp`,
  );
  await assertMemoryScopeLockHeld();
  try {
    await rename(path, retired);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return 'gone';
    throw error;
  }
  if (await moved(retired)) {
    await unlink(retired);
    return 'retired';
  }
  try {
    await publishWithoutReplacing(retired, path, true);
  } catch (error) {
    if (!isNodeError(error, 'EEXIST')) throw error;
    // A later save took the name meanwhile and supersedes this one, as an
    // editor's own save replacing it would.
    await unlink(retired);
  }
  return 'kept';
}

/** The bytes at `path`, or null when there is no file. */
export async function readMemoryFileBytes(
  path: string,
): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ENOTDIR')) {
      return null;
    }
    throw error;
  }
}

// `fatal` rejects bytes that are not UTF-8 instead of replacing them with
// U+FFFD; `ignoreBOM` keeps a leading BOM as a character, as decoding the
// buffer itself does, so the text is the bytes' own decoding and nothing else.
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * A memory file as it is on disk. Only `bytes` identifies it: decoding
 * replaces every byte that is not UTF-8 with U+FFFD, so two files can decode
 * alike and the text can never prove a file unchanged. `text` is null for
 * bytes that are not UTF-8 text, which memory sync cannot carry at all.
 */
export interface MemoryFileContent {
  bytes: Buffer;
  text: string | null;
}

/** The file at `path` as {@link MemoryFileContent}; null without a file. */
export async function readMemoryFile(
  path: string,
): Promise<MemoryFileContent | null> {
  const bytes = await readMemoryFileBytes(path);
  if (bytes === null) return null;
  try {
    return { bytes, text: UTF8.decode(bytes) };
  } catch {
    return { bytes, text: null };
  }
}

/** Whether two reads of a memory file found the same file, by its bytes. */
export function sameMemoryFileContent(
  left: MemoryFileContent | null,
  right: MemoryFileContent | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.bytes.equals(right.bytes);
}

/** Whether `path` names the very file a move published under its new name. */
type HoldsMovedFile = (path: string) => Promise<boolean>;

/**
 * Gives the file `source` names the name `destination`, which must be free,
 * and tells that file apart from any other afterwards.
 *
 * The file is linked under a private name first, and its identity is read
 * there: that name is one only this move knows, so the identity is the file
 * the move took, never a save someone made under a public name since. The
 * destination is then published from that private link, so the new name
 * only ever holds that same file. An identity read back from the
 * destination after publishing it would be whatever is there now, which an
 * editor's save can be, and a cleanup bound to it would remove that save.
 *
 * Rejects with EEXIST once the destination is taken, unless it already is
 * that very file, as a crash between linking and retiring leaves it.
 */
async function linkMovedFile(
  source: string,
  destination: string,
): Promise<HoldsMovedFile> {
  const staged = memoryWriteTempPath(dirname(destination));
  await link(source, staged);
  try {
    const moved = await identityOf(staged);
    const holds: HoldsMovedFile = async (path) =>
      sameIdentity(await identityOf(path), moved);
    try {
      await publishWithoutReplacing(staged, destination, true);
    } catch (error) {
      if (!isNodeError(error, 'EEXIST') || !(await holds(destination))) {
        throw error;
      }
    }
    return holds;
  } finally {
    await unlink(staged).catch(() => undefined);
  }
}

/**
 * {@link linkMovedFile} where hard links are unavailable: the file is
 * copied, and the copy is told apart by the bytes copied, read from the
 * temp file before it is published (see {@link copyWithoutReplacing}).
 */
async function copyMovedFile(
  scopeDir: string,
  source: string,
  destination: string,
  times: MemoryFileTimes | undefined,
): Promise<HoldsMovedFile> {
  const copied = await copyWithoutReplacing(
    scopeDir,
    source,
    destination,
    times,
  );
  return async (path) =>
    (await readMemoryFileBytes(path))?.equals(copied) === true;
}

/**
 * Moves a file in `scopeDir` to a name that must not exist yet. Unlike
 * rename, an existing destination (a note saved meanwhile under the same
 * name) is never replaced: the move rejects with EEXIST and changes nothing.
 * Node offers no rename that refuses an existing target (`renamex_np` with
 * `RENAME_EXCL`, `renameat2` with `RENAME_NOREPLACE`), so the file is hard
 * linked under the new name (see {@link linkMovedFile}) and the old name is
 * then retired only while it still names that file and the new name still
 * holds it (see {@link retireName}): an editor that saved over the source
 * in between keeps its save there, and the move rejects with ECHANGED; one
 * that took the destination keeps its save too, and the move rejects with
 * EEXIST. Either changes nothing, so the caller reads it and decides again,
 * and no save is removed for being under a name this move wrote. With
 * `expectedBytes`, the moved file must also still hold exactly those bytes,
 * the ones the caller read and decided on; raw bytes are the only content a
 * move can be held to, since text decoded from a file it cannot decode is
 * not the file (see {@link readMemoryFile}). Two spellings of one directory
 * entry, as a
 * case-insensitive file system has, are respelled by a rename, which
 * removes no file. A destination that already is the source, as a crash
 * between linking and retiring leaves it, only loses the old name. Where
 * hard links are unavailable the file is copied instead (see
 * {@link copyMovedFile}), which keeps `times`, the source's own by default.
 * A source that is a link, or either end under one, is refused (see
 * {@link assertMemoryPathContained}).
 */
export async function moveWithoutReplacing(
  scopeDir: string,
  source: string,
  destination: string,
  options: { times?: MemoryFileTimes; expectedBytes?: Buffer } = {},
): Promise<void> {
  await assertMemoryPathContained(scopeDir, source);
  await assertMemoryPathContained(scopeDir, dirname(destination));
  const expected = options.expectedBytes ?? null;
  const holdsExpected = async (path: string): Promise<boolean> =>
    expected === null ||
    (await readMemoryFileBytes(path))?.equals(expected) === true;
  if (await isOneEntry(source, destination)) {
    if (!(await holdsExpected(source))) {
      throw new MemoryFileChangedError(source);
    }
    await assertMemoryScopeLockHeld();
    await rename(source, destination);
    return;
  }
  await assertMemoryScopeLockHeld();
  let holds: HoldsMovedFile;
  try {
    holds = await linkMovedFile(source, destination);
  } catch (error) {
    if (!hardLinksUnsupported(error)) throw error;
    holds = await copyMovedFile(scopeDir, source, destination, options.times);
  }
  // Set once the destination no longer holds the file moved: a save made
  // there takes the name, so the move keeps the source and removes nothing.
  let destinationTaken = false;
  let retired: Awaited<ReturnType<typeof retireName>>;
  try {
    retired = await retireName(source, async (path) => {
      if (!(await holds(path)) || !(await holdsExpected(path))) return false;
      destinationTaken = !(await holds(destination));
      return !destinationTaken;
    });
  } catch (error) {
    // Leave exactly one copy: the source, where it was.
    await retireName(destination, holds).catch(() => undefined);
    throw error;
  }
  if (retired === 'retired') return;
  if (retired === 'gone') {
    // The old name went while the file moved: the destination holds it, the
    // only copy left, so it stays. Otherwise nothing of it is left to keep.
    if (await holds(destination)) return;
    throw new MemoryFileChangedError(source);
  }
  if (destinationTaken) throw new MemoryFileExistsError(destination);
  await retireName(destination, holds);
  throw new MemoryFileChangedError(source);
}

/** Copies `source` under `destination` without replacing; the bytes copied. */
async function copyWithoutReplacing(
  scopeDir: string,
  source: string,
  destination: string,
  times: MemoryFileTimes | undefined,
): Promise<Buffer> {
  const directory = dirname(destination);
  const temporaryPath = memoryWriteTempPath(directory);
  try {
    const kept = times ?? (await lstat(source));
    await copyFile(source, temporaryPath, constants.COPYFILE_EXCL);
    await utimes(temporaryPath, kept.atime, kept.mtime);
    const copied = await readFile(temporaryPath);
    await assertMemoryPathContained(scopeDir, directory);
    await assertMemoryScopeLockHeld();
    await publishWithoutReplacing(temporaryPath, destination, false);
    return copied;
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}
