import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type {
  LocalMemorySnapshotReason,
  LocalMemorySnapshotSummary,
} from '@canopy/desktop-shared/types';
import { isRecord } from '../../lib/type-guards';
import {
  findChatHistoryProfileIndexLine,
  isChatHistoryProfileTopic,
  removeChatHistoryProfileIndexLines,
  replaceChatHistoryProfileIndexLine,
} from '@canopy/memory-consolidation/chat-history-profile';
import { recordMemoryEdit, withMemoryWriteLock } from './edit-coordination';
import {
  assertMemoryPathContained,
  assertMemoryScopeLockHeld,
  ensureOwnerOnlyMemoryDir,
  isMemoryMarkdownFileName,
} from './memory-files';
import { topicIdentity } from '@canopy/memory-consolidation/topic-identity';

export const LOCAL_MEMORY_SNAPSHOT_RETENTION = 10;
/**
 * Reasons whose newest snapshot outlives the count limit: the state before
 * the last rebuild and before the last restore are the ones a user rolls
 * back to, and routine consolidation snapshots would otherwise push them out.
 */
const PINNED_SNAPSHOT_REASONS: readonly LocalMemorySnapshotReason[] = [
  'rebuild',
  'restore',
];

const SNAPSHOTS_DIRNAME = '.snapshots';
const SNAPSHOT_MANIFEST = 'snapshot.json';
const SNAPSHOT_VERSION = 1;
const SNAPSHOT_ID_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}$/;

interface SnapshotManifest {
  version: 1;
  createdAt: string;
  reason: LocalMemorySnapshotReason;
  hasIndex: boolean;
  topics: string[];
}

/**
 * A scope's index and topic files exactly as they are. An empty scope is
 * `{ memoryMd: null, topicFiles: [] }`, a state like any other, so a caller
 * can always put back what it read.
 */
export interface LocalMemoryState {
  memoryMd: string | null;
  topicFiles: Array<{ filename: string; content: string }>;
}

export interface LocalMemorySnapshotContent extends LocalMemoryState {
  summary: LocalMemorySnapshotSummary;
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

function snapshotsDir(scopeDir: string): string {
  return join(scopeDir, SNAPSHOTS_DIRNAME);
}

export function isLocalMemorySnapshotId(value: unknown): value is string {
  return typeof value === 'string' && SNAPSHOT_ID_PATTERN.test(value);
}

function isSnapshotTopicFilename(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    basename(value) === value &&
    value !== '.' &&
    value !== '..' &&
    !value.startsWith('.') &&
    isMemoryMarkdownFileName(value)
  );
}

function isSnapshotReason(value: unknown): value is LocalMemorySnapshotReason {
  return (
    value === 'consolidation' ||
    value === 'rebuild' ||
    value === 'restore' ||
    value === 'sync'
  );
}

function parseManifest(value: unknown): SnapshotManifest | null {
  if (
    !isRecord(value) ||
    value.version !== SNAPSHOT_VERSION ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !isSnapshotReason(value.reason) ||
    typeof value.hasIndex !== 'boolean' ||
    !Array.isArray(value.topics) ||
    !value.topics.every(isSnapshotTopicFilename)
  ) {
    return null;
  }
  return {
    version: SNAPSHOT_VERSION,
    createdAt: value.createdAt,
    reason: value.reason,
    hasIndex: value.hasIndex,
    topics: value.topics.filter(isSnapshotTopicFilename),
  };
}

async function readTextOrNull(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null;
    throw error;
  }
}

/**
 * Every `topics/*.md` file a snapshot captures, so it holds what a rewrite
 * replaces. Anything that deletes topics on the strength of a snapshot (a
 * restore, a rebuild's clear) lists them here, so it never deletes a file
 * the snapshot could not have saved.
 */
export async function listTopicFilenames(scopeDir: string): Promise<string[]> {
  try {
    const entries = await readdir(join(scopeDir, 'topics'), {
      withFileTypes: true,
    });
    return entries
      .filter((entry) => entry.isFile() && isSnapshotTopicFilename(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return [];
    throw error;
  }
}

async function snapshotIds(scopeDir: string): Promise<string[]> {
  try {
    const entries = await readdir(snapshotsDir(scopeDir), {
      withFileTypes: true,
    });
    return entries
      .filter(
        (entry) => entry.isDirectory() && isLocalMemorySnapshotId(entry.name),
      )
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return [];
    throw error;
  }
}

/**
 * The summary of a snapshot that could be restored: its manifest and every
 * file the manifest lists read back. Null for a damaged snapshot. Retention
 * and the snapshot list both go through this one check, so a snapshot is
 * counted or offered only when a restore of it could succeed.
 */
async function readableSnapshotSummary(
  scopeDir: string,
  id: string,
): Promise<LocalMemorySnapshotSummary | null> {
  try {
    return (await readLocalMemorySnapshot(scopeDir, id)).summary;
  } catch {
    return null;
  }
}

/**
 * Keeps the newest {@link LOCAL_MEMORY_SNAPSHOT_RETENTION} readable
 * snapshots plus the newest one of each pinned reason, and always `justMade`
 * (ids sort by the clock, which can step back). Only snapshots whose
 * manifest and listed files all read back count toward the limit, so damaged
 * folders can never crowd out the good ones; damaged folders are left for
 * inspection, not deleted.
 */
async function pruneSnapshots(
  scopeDir: string,
  justMade: string,
): Promise<void> {
  const directory = snapshotsDir(scopeDir);
  const entries = await readdir(directory, { withFileTypes: true });
  const staleStaging = entries
    .filter(
      (entry) => entry.name.startsWith('.') && entry.name.endsWith('.tmp'),
    )
    .map((entry) => entry.name);
  const pinned = new Set<LocalMemorySnapshotReason>();
  let kept = 0;
  const expired: string[] = [];
  for (const id of await snapshotIds(scopeDir)) {
    const summary = await readableSnapshotSummary(scopeDir, id);
    if (summary === null) continue;
    const pinnable =
      PINNED_SNAPSHOT_REASONS.includes(summary.reason) &&
      !pinned.has(summary.reason);
    if (pinnable) pinned.add(summary.reason);
    if (kept < LOCAL_MEMORY_SNAPSHOT_RETENTION) kept += 1;
    else if (!pinnable && id !== justMade) expired.push(id);
  }
  for (const name of [...staleStaging, ...expired]) {
    await assertMemoryScopeLockHeld();
    await rm(join(directory, name), { recursive: true, force: true });
  }
}

function snapshotId(now: Date): string {
  return `${now.toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
}

/**
 * Reads the scope's index and every topic file a snapshot captures. This is
 * the state a destructive write captures for its rollback and later checks
 * with {@link runVerifiedLocalMemoryWrite}; an empty scope reads as
 * `{ memoryMd: null, topicFiles: [] }`, which is checked like any other.
 */
export async function readLocalMemoryState(
  scopeDir: string,
): Promise<LocalMemoryState> {
  const memoryMd = await readTextOrNull(join(scopeDir, 'MEMORY.md'));
  const topicFiles: Array<{ filename: string; content: string }> = [];
  for (const filename of await listTopicFilenames(scopeDir)) {
    const content = await readTextOrNull(join(scopeDir, 'topics', filename));
    if (content !== null) topicFiles.push({ filename, content });
  }
  return { memoryMd, topicFiles };
}

/**
 * Saves `state` as a new snapshot and prunes older ones (see
 * {@link pruneSnapshots}). Returns null for an empty state: there is nothing
 * to roll back to that a snapshot would hold.
 */
async function saveSnapshot(
  scopeDir: string,
  state: LocalMemoryState,
  reason: LocalMemorySnapshotReason,
  now: Date,
): Promise<LocalMemorySnapshotSummary | null> {
  const { memoryMd, topicFiles } = state;
  if (memoryMd === null && topicFiles.length === 0) return null;

  const id = snapshotId(now);
  const directory = snapshotsDir(scopeDir);
  await ensureOwnerOnlyMemoryDir(scopeDir, directory);
  const staging = join(directory, `.${id}.tmp`);
  const manifest: SnapshotManifest = {
    version: SNAPSHOT_VERSION,
    createdAt: now.toISOString(),
    reason,
    hasIndex: memoryMd !== null,
    topics: topicFiles.map((topic) => topic.filename),
  };
  try {
    await mkdir(join(staging, 'topics'), { recursive: true, mode: 0o700 });
    const write = (path: string, content: string): Promise<void> =>
      writeFile(path, content, { encoding: 'utf8', mode: 0o600 });
    if (memoryMd !== null) await write(join(staging, 'MEMORY.md'), memoryMd);
    for (const topic of topicFiles) {
      await write(join(staging, 'topics', topic.filename), topic.content);
    }
    await write(
      join(staging, SNAPSHOT_MANIFEST),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    await assertMemoryScopeLockHeld();
    await rename(staging, join(directory, id));
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  await pruneSnapshots(scopeDir, id);
  return {
    id,
    createdAt: manifest.createdAt,
    reason,
    topicCount: topicFiles.length,
  };
}

/**
 * Saves a state a caller has already read (see {@link readLocalMemoryState})
 * as a new snapshot, so the snapshot holds exactly the state the caller will
 * check before its destructive write. Returns null for an empty state.
 */
export async function saveLocalMemorySnapshot(
  scopeDir: string,
  state: LocalMemoryState,
  reason: LocalMemorySnapshotReason,
  now: Date = new Date(),
): Promise<LocalMemorySnapshotSummary | null> {
  return saveSnapshot(scopeDir, state, reason, now);
}

/**
 * Copies MEMORY.md and every topic file into a new snapshot and prunes older
 * ones (see {@link pruneSnapshots}). Returns null when the scope
 * has nothing to capture. Callers hold the scope's memory write lock so the
 * copy is consistent with the write that follows.
 */
export async function createLocalMemorySnapshot(
  scopeDir: string,
  reason: LocalMemorySnapshotReason,
  now: Date = new Date(),
): Promise<LocalMemorySnapshotSummary | null> {
  return saveSnapshot(
    scopeDir,
    await readLocalMemoryState(scopeDir),
    reason,
    now,
  );
}

async function readManifest(
  scopeDir: string,
  id: string,
): Promise<SnapshotManifest | null> {
  const raw = await readTextOrNull(
    join(snapshotsDir(scopeDir), id, SNAPSHOT_MANIFEST),
  );
  if (raw === null) return null;
  try {
    return parseManifest(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Snapshots that could be restored, newest first. A damaged one (unreadable
 * manifest, or a file it lists missing or unreadable) is skipped and left
 * on disk.
 */
export async function listLocalMemorySnapshots(
  scopeDir: string,
): Promise<LocalMemorySnapshotSummary[]> {
  const summaries: LocalMemorySnapshotSummary[] = [];
  for (const id of await snapshotIds(scopeDir)) {
    const summary = await readableSnapshotSummary(scopeDir, id);
    if (summary !== null) summaries.push(summary);
  }
  return summaries;
}

export async function readLocalMemorySnapshot(
  scopeDir: string,
  id: string,
): Promise<LocalMemorySnapshotContent> {
  if (!isLocalMemorySnapshotId(id)) {
    throw new Error('Choose a memory snapshot.');
  }
  const manifest = await readManifest(scopeDir, id);
  if (manifest === null) {
    throw new Error("Couldn't find that memory snapshot.");
  }
  const root = join(snapshotsDir(scopeDir), id);
  const memoryMd = manifest.hasIndex
    ? await readFile(join(root, 'MEMORY.md'), 'utf8')
    : null;
  const topicFiles: Array<{ filename: string; content: string }> = [];
  for (const filename of manifest.topics) {
    topicFiles.push({
      filename,
      content: await readFile(join(root, 'topics', filename), 'utf8'),
    });
  }
  return {
    summary: {
      id,
      createdAt: manifest.createdAt,
      reason: manifest.reason,
      topicCount: topicFiles.length,
    },
    memoryMd,
    topicFiles,
  };
}

async function unlinkIfPresent(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  }
}

/**
 * The index a restore writes: the snapshot's exact bytes. Limits apply when
 * the index is read or consolidated, never here, so a rollback loses nothing.
 * When the current profile topic is kept, the index links it exactly as the
 * current index does: its line takes the place of the snapshot's (or is
 * added), and with no current line the snapshot's goes, since it describes a
 * profile that is not restored. No other line changes.
 */
function restoredIndex(
  snapshotMemoryMd: string | null,
  keptProfile: { line: string | undefined } | null,
): string | null {
  if (keptProfile === null) return snapshotMemoryMd;
  if (keptProfile.line === undefined) {
    return snapshotMemoryMd === null
      ? null
      : removeChatHistoryProfileIndexLines(snapshotMemoryMd);
  }
  return replaceChatHistoryProfileIndexLine(
    snapshotMemoryMd ?? '',
    keptProfile.line,
  );
}

/** Whether two paths name one file (one name may be a case variant). */
async function sameFile(left: string, right: string): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([
      stat(left, { bigint: true }),
      stat(right, { bigint: true }),
    ]);
    return a.dev === b.dev && a.ino === b.ino;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    // Unknown: keep the file rather than risk deleting what was restored.
    return true;
  }
}

/**
 * The topics a restore deletes because it does not write them, worked out
 * before it writes anything. Names are compared by topic identity: on macOS
 * and Windows a snapshot's `travel.md` is written into the existing
 * `Travel.md`, which keeps its spelling, so an exact-name comparison would
 * delete the topic about to be restored. A case variant is deleted only when
 * it is a different file from the restored one, which happens only on a
 * case-sensitive filesystem.
 */
async function topicsOutsideSnapshot(
  scopeDir: string,
  restoredFilenames: readonly string[],
  keepCurrentProfile: boolean,
): Promise<string[]> {
  const topicsDir = join(scopeDir, 'topics');
  const outside: string[] = [];
  const restored = new Set(restoredFilenames);
  const restoredByIdentity = new Map<string, string[]>();
  for (const filename of restoredFilenames) {
    const identity = topicIdentity(filename);
    restoredByIdentity.set(identity, [
      ...(restoredByIdentity.get(identity) ?? []),
      filename,
    ]);
  }
  for (const filename of await listTopicFilenames(scopeDir)) {
    if (restored.has(filename)) continue;
    if (keepCurrentProfile && isChatHistoryProfileTopic(filename)) continue;
    const variants = restoredByIdentity.get(topicIdentity(filename)) ?? [];
    let isRestoredFile = false;
    for (const variant of variants) {
      const path = join(topicsDir, variant);
      isRestoredFile ||= await sameFile(join(topicsDir, filename), path);
    }
    if (!isRestoredFile) outside.push(join(topicsDir, filename));
  }
  return outside;
}

/**
 * Why a destructive write stopped: the scope's index or topics no longer
 * match the state the write captured for its rollback, so writing would
 * destroy content that rollback could not put back. `changedMemory` says
 * whether the write had already replaced or deleted a file before it found
 * the change; when it had, the caller still owns undoing that part.
 */
export class LocalMemoryScopeChangedError extends Error {
  constructor(readonly changedMemory = false) {
    super(
      changedMemory
        ? 'Memories changed while this was running, so it stopped part way.'
        : 'Memories changed while this was running, so nothing was changed.',
    );
    this.name = 'LocalMemoryScopeChangedError';
  }
}

interface StateFiles {
  memoryMd: string | null;
  topics: Map<string, string>;
  /** Topic content by identity, for identities only one name holds. */
  byIdentity: Map<string, string>;
  ambiguous: Set<string>;
}

function stateFiles(state: LocalMemoryState): StateFiles {
  const topics = new Map<string, string>();
  const byIdentity = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const topic of state.topicFiles) {
    topics.set(topic.filename, topic.content);
    const identity = topicIdentity(topic.filename);
    if (byIdentity.has(identity)) ambiguous.add(identity);
    byIdentity.set(identity, topic.content);
  }
  return { memoryMd: state.memoryMd, topics, byIdentity, ambiguous };
}

/**
 * A topic's content in a state, or null when the state does not hold it. A
 * name the state does not spell exactly falls back to its topic identity:
 * on macOS and Windows a write of `travel.md` lands in an existing
 * `Travel.md`, which keeps its spelling.
 */
function topicContent(files: StateFiles, filename: string): string | null {
  const exact = files.topics.get(filename);
  if (exact !== undefined) return exact;
  const identity = topicIdentity(filename);
  if (files.ambiguous.has(identity)) return null;
  return files.byIdentity.get(identity) ?? null;
}

/**
 * Whether `actual` is one of the `expected` states file by file: the index
 * and every topic either side names hold the bytes (or absence) of one of
 * the expected states. With one expected state this is exact equality. With
 * the states before and after a write, it accepts any point a write that
 * stopped part way can leave, and nothing else.
 */
function stateMatches(
  actual: LocalMemoryState,
  expected: readonly LocalMemoryState[],
): boolean {
  if (!expected.some((state) => state.memoryMd === actual.memoryMd)) {
    return false;
  }
  const actualFiles = stateFiles(actual);
  const expectedFiles = expected.map(stateFiles);
  const names = new Set([
    ...actual.topicFiles.map((topic) => topic.filename),
    ...expected.flatMap((state) =>
      state.topicFiles.map((topic) => topic.filename),
    ),
  ]);
  for (const name of Array.from(names)) {
    const content = topicContent(actualFiles, name);
    if (!expectedFiles.some((files) => topicContent(files, name) === content)) {
      return false;
    }
  }
  return true;
}

/** A file written next to its target; nothing live has changed yet. */
export interface StagedLocalMemoryFile {
  readonly targetPath: string;
  readonly temporaryPath: string;
  readonly content: string;
}

/**
 * The only way a verified write touches the scope (see
 * {@link runVerifiedLocalMemoryWrite}). `stage` writes temp siblings and
 * changes nothing live; do every `stage` (and any other read or preparation)
 * first. Each destructive call then checks its own target against the
 * expected states right before it renames or deletes, with no other I/O in
 * between; the first one checks the whole scope first. A mismatch rejects
 * with {@link LocalMemoryScopeChangedError} and every later call rejects too.
 */
export interface LocalMemoryWriteGuard {
  stage(targetPath: string, content: string): Promise<StagedLocalMemoryFile>;
  /** Renames a staged file over its target; resolves the bytes it replaced. */
  replace(staged: StagedLocalMemoryFile): Promise<string | null>;
  /** Deletes a file; a file already gone is fine. */
  remove(targetPath: string): Promise<void>;
  /** Renames `from` to `to`, checking whichever is an index or topic file. */
  move(from: string, to: string): Promise<void>;
}

type MemoryFileKey =
  | { kind: 'index' }
  | { kind: 'topic'; filename: string; identity: string };

/**
 * Builds the guard for one verified write. Bytes it wrote itself also count
 * as expected for that file, so a write may touch a file twice.
 */
function createLocalMemoryWriteGuard(
  scopeDir: string,
  expected: readonly LocalMemoryState[],
): {
  guard: LocalMemoryWriteGuard;
  discardStaged: () => Promise<void>;
} {
  const indexPath = join(scopeDir, 'MEMORY.md');
  const topicsDir = join(scopeDir, 'topics');
  const expectedFiles = expected.map(stateFiles);
  const staged = new Set<string>();
  const ownIndex: Array<string | null> = [];
  const ownTopics = new Map<string, Array<string | null>>();
  let verifiedScope = false;
  let changedMemory = false;
  let stopped = false;

  const keyFor = (path: string): MemoryFileKey | null => {
    if (path === indexPath) return { kind: 'index' };
    const filename = basename(path);
    return join(topicsDir, filename) === path &&
      isSnapshotTopicFilename(filename)
      ? { kind: 'topic', filename, identity: topicIdentity(filename) }
      : null;
  };
  const stop = (): never => {
    stopped = true;
    throw new LocalMemoryScopeChangedError(changedMemory);
  };
  // Bytes this file may hold: what an expected state holds under this exact
  // name or, failing that, under its topic identity (a case variant on
  // macOS and Windows), or what this write put there.
  const allowed = (key: MemoryFileKey, content: string): boolean => {
    if (key.kind === 'index') {
      return (
        expectedFiles.some((files) => files.memoryMd === content) ||
        ownIndex.includes(content)
      );
    }
    return (
      expectedFiles.some(
        (files) => topicContent(files, key.filename) === content,
      ) || (ownTopics.get(key.identity) ?? []).includes(content)
    );
  };
  const recordOwn = (key: MemoryFileKey, content: string | null): void => {
    if (key.kind === 'index') {
      ownIndex.push(content);
      return;
    }
    ownTopics.set(key.identity, [
      ...(ownTopics.get(key.identity) ?? []),
      content,
    ]);
  };
  /**
   * Checks `path` right before a destructive call and resolves the bytes it
   * holds. A file that is gone loses nothing when written or deleted. A
   * target that cannot be read stops the write with that error.
   */
  const verify = async (path: string): Promise<string | null> => {
    if (stopped) stop();
    await assertMemoryPathContained(scopeDir, dirname(path));
    await assertMemoryScopeLockHeld();
    const key = keyFor(path);
    if (key === null) return null;
    if (!verifiedScope) {
      let live: LocalMemoryState;
      try {
        live = await readLocalMemoryState(scopeDir);
      } catch {
        return stop();
      }
      if (!stateMatches(live, expected)) stop();
      verifiedScope = true;
    }
    let live: string | null;
    try {
      live = await readTextOrNull(path);
    } catch (error) {
      stopped = true;
      throw error;
    }
    if (live !== null && !allowed(key, live)) stop();
    return live;
  };

  const guard: LocalMemoryWriteGuard = {
    async stage(targetPath, content) {
      if (stopped) stop();
      await ensureOwnerOnlyMemoryDir(scopeDir, dirname(targetPath));
      const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
      staged.add(temporaryPath);
      await writeFile(temporaryPath, content, {
        encoding: 'utf8',
        mode: 0o600,
      });
      return { targetPath, temporaryPath, content };
    },
    async replace(file) {
      const previous = await verify(file.targetPath);
      await rename(file.temporaryPath, file.targetPath);
      staged.delete(file.temporaryPath);
      changedMemory = true;
      const key = keyFor(file.targetPath);
      if (key !== null) recordOwn(key, file.content);
      return previous;
    },
    async remove(targetPath) {
      await verify(targetPath);
      await unlinkIfPresent(targetPath);
      changedMemory = true;
      const key = keyFor(targetPath);
      if (key !== null) recordOwn(key, null);
    },
    async move(from, to) {
      await verify(from);
      await verify(to);
      await rename(from, to);
      changedMemory = true;
    },
  };
  return {
    guard,
    discardStaged: async (): Promise<void> => {
      await Promise.all(
        Array.from(staged, (path) => unlink(path).catch(() => undefined)),
      );
      staged.clear();
    },
  };
}

/**
 * Compare-before-destroy: the one guard every destructive write to a scope's
 * index or topics runs through (a rebuild's clear, a snapshot restore, the
 * rollback of either, and a consolidation commit and its rollback). The
 * scope must be in one of the `expected` states (see {@link stateMatches}):
 * the state the caller captured for its rollback, and, for a rollback, also
 * the state its own write was producing. An empty scope is an expected state
 * like any other. It checks once before `write` starts, so a changed scope
 * stages nothing, and `write` then makes every change through the
 * {@link LocalMemoryWriteGuard}, which checks the whole scope again before
 * the first rename or delete and each target before every one, after all
 * staging. Any mismatch or read failure rejects with
 * {@link LocalMemoryScopeChangedError}; temp files staged but not renamed
 * are always deleted. Callers hold the scope's memory write lock.
 */
export async function runVerifiedLocalMemoryWrite<T>(
  scopeDir: string,
  expected: readonly LocalMemoryState[],
  write: (guard: LocalMemoryWriteGuard) => Promise<T>,
): Promise<T> {
  let live: LocalMemoryState;
  try {
    live = await readLocalMemoryState(scopeDir);
  } catch {
    throw new LocalMemoryScopeChangedError();
  }
  if (!stateMatches(live, expected)) throw new LocalMemoryScopeChangedError();
  const { guard, discardStaged } = createLocalMemoryWriteGuard(
    scopeDir,
    expected,
  );
  try {
    return await write(guard);
  } finally {
    await discardStaged();
  }
}

/**
 * What a restore of `snapshot` over `prior` writes. The generated chat
 * history profile is refreshed from chat titles, so when `prior` holds the
 * profile topic it and its index line are kept, and the snapshot's are not
 * written.
 */
function planSnapshotRestore(
  prior: LocalMemoryState,
  snapshot: LocalMemoryState,
): {
  keepCurrentProfile: boolean;
  restoredTopics: LocalMemoryState['topicFiles'];
  target: LocalMemoryState;
} {
  const keptProfile = prior.topicFiles.filter((topic) =>
    isChatHistoryProfileTopic(topic.filename),
  );
  const keepCurrentProfile = keptProfile.length > 0;
  const restoredTopics = snapshot.topicFiles.filter(
    (topic) =>
      !(keepCurrentProfile && isChatHistoryProfileTopic(topic.filename)),
  );
  const memoryMd = restoredIndex(
    snapshot.memoryMd,
    keepCurrentProfile
      ? { line: findChatHistoryProfileIndexLine(prior.memoryMd ?? '') }
      : null,
  );
  return {
    keepCurrentProfile,
    restoredTopics,
    target: { memoryMd, topicFiles: [...restoredTopics, ...keptProfile] },
  };
}

/**
 * Writes a snapshot's index and topics over the scope and deletes topics it
 * does not hold, as {@link planSnapshotRestore} plans it from `prior`. Every
 * file is staged and every deletion worked out before the first change, which
 * goes through `guard`. Callers hold the scope's memory write lock.
 */
async function applySnapshotContent(
  scopeDir: string,
  plan: ReturnType<typeof planSnapshotRestore>,
  guard: LocalMemoryWriteGuard,
): Promise<void> {
  const topics: StagedLocalMemoryFile[] = [];
  for (const topic of plan.restoredTopics) {
    topics.push(
      await guard.stage(
        join(scopeDir, 'topics', topic.filename),
        topic.content,
      ),
    );
  }
  const indexPath = join(scopeDir, 'MEMORY.md');
  const index =
    plan.target.memoryMd === null
      ? null
      : await guard.stage(indexPath, plan.target.memoryMd);
  const outside = await topicsOutsideSnapshot(
    scopeDir,
    plan.restoredTopics.map((topic) => topic.filename),
    plan.keepCurrentProfile,
  );
  for (const topic of topics) await guard.replace(topic);
  if (index === null) await guard.remove(indexPath);
  else await guard.replace(index);
  for (const path of outside) await guard.remove(path);
}

/**
 * Whether the scope's index and topics are exactly `state`, as
 * {@link runVerifiedLocalMemoryWrite} checks before it writes. Any read
 * failure counts as a mismatch.
 */
export async function localMemoryScopeHoldsState(
  scopeDir: string,
  state: LocalMemoryState,
): Promise<boolean> {
  try {
    return stateMatches(await readLocalMemoryState(scopeDir), [state]);
  } catch {
    return false;
  }
}

/**
 * Whether snapshot `id` holds exactly `state`. Any read failure counts as a
 * mismatch.
 */
export async function localMemorySnapshotHoldsState(
  scopeDir: string,
  id: string,
  state: LocalMemoryState,
): Promise<boolean> {
  try {
    return stateMatches(await readLocalMemorySnapshot(scopeDir, id), [state]);
  } catch {
    return false;
  }
}

/**
 * Whether the scope's index and topics are exactly what snapshot `id` holds:
 * the same index bytes (or both absent) and the same topic files with the
 * same bytes. Any read failure counts as a mismatch.
 */
export async function localMemorySnapshotMatchesScope(
  scopeDir: string,
  id: string,
): Promise<boolean> {
  try {
    return await localMemorySnapshotHoldsState(
      scopeDir,
      id,
      await readLocalMemoryState(scopeDir),
    );
  } catch {
    return false;
  }
}

/**
 * Makes the scope's index and topics exactly `state`: deletes every topic file
 * it does not name (including files a failed write created), then writes its
 * topics and index byte for byte, or deletes the index it does not hold.
 * Unlike a restore, nothing of the current state is kept, the chat history
 * profile included. Names are compared exactly, so on a case-insensitive
 * filesystem a topic whose spelling changed is deleted and written again
 * under the saved spelling. Everything is staged before the first change.
 * Callers hold the scope's memory write lock, use this to undo their own
 * change, and pass the `guard` of a {@link runVerifiedLocalMemoryWrite}.
 */
export async function writeLocalMemoryStateExactly(
  scopeDir: string,
  state: LocalMemoryState,
  guard: LocalMemoryWriteGuard,
): Promise<void> {
  const saved = new Set(state.topicFiles.map((topic) => topic.filename));
  const extra = (await listTopicFilenames(scopeDir)).filter(
    (filename) => !saved.has(filename),
  );
  const topics: StagedLocalMemoryFile[] = [];
  for (const topic of state.topicFiles) {
    topics.push(
      await guard.stage(
        join(scopeDir, 'topics', topic.filename),
        topic.content,
      ),
    );
  }
  const indexPath = join(scopeDir, 'MEMORY.md');
  const index =
    state.memoryMd === null
      ? null
      : await guard.stage(indexPath, state.memoryMd);
  for (const filename of extra) {
    await guard.remove(join(scopeDir, 'topics', filename));
  }
  for (const topic of topics) await guard.replace(topic);
  if (index === null) await guard.remove(indexPath);
  else await guard.replace(index);
}

const LOCAL_MEMORY_RESTORE_SNAPSHOT_UNVERIFIED_MESSAGE =
  "Couldn't save a snapshot of current memories, so nothing was changed.";
export const LOCAL_MEMORY_RESTORE_SCOPE_CHANGED_MESSAGE =
  'Memories changed before the snapshot could be restored, so nothing was changed.';
export const LOCAL_MEMORY_RESTORE_ROLLBACK_SCOPE_CHANGED_MESSAGE =
  "Couldn't finish restoring the snapshot, and memories changed meanwhile, so they were left as they are.";

function emitRestoreRollbackWarning(error: unknown): void {
  process.emitWarning(error instanceof Error ? error.message : String(error), {
    code: 'LOCAL_MEMORY_RESTORE_ROLLBACK_FAILED',
  });
}

/**
 * Replaces MEMORY.md and the topic files with a snapshot, after snapshotting
 * the state it replaces. The generated chat history profile is refreshed from
 * chat titles, so the current profile topic and its index line are kept when
 * the profile topic is present. Inbox notes and imports are left as they are.
 *
 * Nothing is overwritten until the snapshot to restore has been read in
 * full, the snapshot of the replaced state reads back byte for byte the same
 * as that state, and the live scope still is that state (an empty scope
 * included) right before the first write; any failure rejects with memory
 * unchanged. A restore that fails part way writes the replaced state back,
 * but only while every file still holds either its replaced or its restored
 * bytes; otherwise it leaves the scope as it is and says so.
 *
 * `assertTarget` runs once the write lock is held and again right before
 * the first write: a throw there rejects with memory unchanged, and from
 * the first check with nothing written at all.
 */
export async function restoreLocalMemorySnapshot(
  scopeDir: string,
  id: string,
  assertTarget: () => void = () => undefined,
  precondition?: () => Promise<void>,
): Promise<{ previousSnapshotId: string | null }> {
  return withMemoryWriteLock(scopeDir, async () => {
    assertTarget();
    await precondition?.();
    await recordMemoryEdit(scopeDir);
    const snapshot = await readLocalMemorySnapshot(scopeDir, id);
    // Read once: the snapshot saves this state, the guard checks the scope
    // against it, and a failed restore writes it back, empty or not.
    const prior = await readLocalMemoryState(scopeDir);
    const previous = await saveSnapshot(scopeDir, prior, 'restore', new Date());
    if (
      previous !== null &&
      !(await localMemorySnapshotHoldsState(scopeDir, previous.id, prior))
    ) {
      throw new Error(LOCAL_MEMORY_RESTORE_SNAPSHOT_UNVERIFIED_MESSAGE);
    }
    const plan = planSnapshotRestore(prior, snapshot);
    assertTarget();
    try {
      await runVerifiedLocalMemoryWrite(scopeDir, [prior], (guard) =>
        applySnapshotContent(scopeDir, plan, guard),
      );
    } catch (error) {
      if (
        error instanceof LocalMemoryScopeChangedError &&
        !error.changedMemory
      ) {
        throw new Error(LOCAL_MEMORY_RESTORE_SCOPE_CHANGED_MESSAGE);
      }
      // A restore that failed or stopped part way leaves a mix of both
      // states; put the replaced state back exactly, even an empty one. A
      // non-empty one also stays saved as a snapshot.
      try {
        await runVerifiedLocalMemoryWrite(
          scopeDir,
          [prior, plan.target],
          (guard) => writeLocalMemoryStateExactly(scopeDir, prior, guard),
        );
      } catch (rollbackError) {
        emitRestoreRollbackWarning(rollbackError);
        if (rollbackError instanceof LocalMemoryScopeChangedError) {
          throw new Error(LOCAL_MEMORY_RESTORE_ROLLBACK_SCOPE_CHANGED_MESSAGE);
        }
      }
      if (error instanceof LocalMemoryScopeChangedError) {
        throw new Error(LOCAL_MEMORY_RESTORE_SCOPE_CHANGED_MESSAGE);
      }
      throw error;
    }
    return { previousSnapshotId: previous?.id ?? null };
  });
}
