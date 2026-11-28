// Advisory usage counters for local memory files, persisted as a versioned
// JSON file (`usage.json`) per memory scope directory.
//
// All I/O is asynchronous (`node:fs/promises`) so no memory tool call or
// consolidation run performs blocking work on the Electron main event loop.
// Writes are serialized through an in-memory promise chain per scope
// directory so concurrent updates cannot lose counter bumps.
//
// Usage is advisory; content remains intact when counters fail. To keep that
// contract safe for retention decisions, the store persists `trackingSince`:
// the moment continuous usage tracking started for the scope. It is set when
// the file is first created and reset whenever a corrupt or incompatible
// file is recreated. Readers receive `trackingSince: null` when the store is
// absent, unreadable, contains any invalid row, or belongs to a scope whose
// last mutation failed to persist, which callers must treat as "usage
// unknown — never prune", not as zero usage.
//
// Failed mutations fail closed: a lost counter bump would otherwise leave an
// old zero-count row plus an intact tracking window on disk, which reads as
// affirmative evidence of non-use for a file that was actually used. A
// mutation failure therefore flags the scope in-memory (readers report
// tracking unavailable), best-effort deletes the persisted store so the
// fail-closed state survives a process restart, and the next successful
// write recreates the store with a fresh tracking window.
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { isRecord } from '../../lib/type-guards';
import { ensureOwnerOnlyDir } from '@canopy/memory-store/memory-files';
import { localMemoryReplicaHooks } from './replica-hooks';
import { memoryFileIdentity } from '@canopy/memory-consolidation/topic-identity';

export interface MemoryUsageEntry {
  usageCount: number;
  citationCount?: number;
  usageSignalCount?: number;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface MemoryUsageSnapshot {
  trackingSince: string | null;
  entries: Map<string, MemoryUsageEntry>;
}

interface UsageFile {
  version: 1;
  trackingSince: string;
  entries: Record<string, MemoryUsageEntry>;
}

const USAGE_FILE_VERSION = 1;
const USAGE_FILENAME = 'usage.json';
const MAX_FILE_KEY_LENGTH = 1_000;

function isValidTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isMemoryUsageEntry(value: unknown): value is MemoryUsageEntry {
  return (
    isRecord(value) &&
    typeof value.usageCount === 'number' &&
    Number.isInteger(value.usageCount) &&
    value.usageCount >= 0 &&
    validSignalCount(value.citationCount) &&
    validSignalCount(value.usageSignalCount) &&
    (value.lastUsedAt === null || isValidTimestamp(value.lastUsedAt)) &&
    isValidTimestamp(value.createdAt)
  );
}

function validSignalCount(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
  );
}

function parseUsageFile(raw: string): UsageFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== USAGE_FILE_VERSION ||
    !isValidTimestamp(parsed.trackingSince) ||
    !isRecord(parsed.entries)
  ) {
    return null;
  }
  const entries: Record<string, MemoryUsageEntry> = {};
  const seenPaths = new Set<string>();
  for (const [fileKey, entry] of Object.entries(parsed.entries)) {
    const path = normalizeFilePath(fileKey);
    if (path === undefined || !isMemoryUsageEntry(entry)) {
      // One invalid row poisons the whole store: dropping just that row
      // would make it indistinguishable from "never used" while the retained
      // tracking window still authorized pruning. Treat the file as corrupt
      // so tracking reads as unavailable, and the next write recreates the
      // store with a fresh tracking window (corrupt-recreate semantics).
      return null;
    }
    if (seenPaths.has(path)) {
      // Two distinct on-disk keys normalizing to the same path (e.g.
      // "topics/a.md" and "./topics/a.md") means the file was not produced
      // by this writer, which only persists normalized keys. Letting the
      // later row silently win would drop a row whose loss reads as "never
      // used" while trackingSince stayed valid — the same hazard as any
      // other invalid row, so the same corrupt-store handling applies.
      return null;
    }
    seenPaths.add(path);
    // Rows written before topic identity was case-folded can hold one topic
    // under two spellings (`topics/Build.md` from a listing, `topics/build.md`
    // from an index link). They are one file on macOS and Windows, so the
    // rows merge: every recorded use is kept, and the persisted store moves
    // to the folded key on its next write.
    const identity = memoryFileIdentity(path);
    const existing = entries[identity];
    entries[identity] = existing
      ? mergeUsageEntries(existing, entry)
      : {
          usageCount: entry.usageCount,
          lastUsedAt: entry.lastUsedAt,
          createdAt: entry.createdAt,
          ...(entry.citationCount !== undefined
            ? { citationCount: entry.citationCount }
            : {}),
          ...(entry.usageSignalCount !== undefined
            ? { usageSignalCount: entry.usageSignalCount }
            : {}),
        };
  }
  return {
    version: USAGE_FILE_VERSION,
    trackingSince: parsed.trackingSince,
    entries,
  };
}

function latestTimestamp(
  left: string | null,
  right: string | null,
): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return Date.parse(right) > Date.parse(left) ? right : left;
}

function mergeUsageEntries(
  left: MemoryUsageEntry,
  right: MemoryUsageEntry,
): MemoryUsageEntry {
  return {
    usageCount: left.usageCount + right.usageCount,
    ...(left.citationCount !== undefined || right.citationCount !== undefined
      ? {
          citationCount: (left.citationCount ?? 0) + (right.citationCount ?? 0),
        }
      : {}),
    ...(left.usageSignalCount !== undefined ||
    right.usageSignalCount !== undefined
      ? {
          usageSignalCount:
            (left.usageSignalCount ?? 0) + (right.usageSignalCount ?? 0),
        }
      : {}),
    lastUsedAt: latestTimestamp(left.lastUsedAt, right.lastUsedAt),
    createdAt:
      Date.parse(right.createdAt) < Date.parse(left.createdAt)
        ? right.createdAt
        : left.createdAt,
  };
}

/** A scope-relative path with separators and a leading `./` normalized. */
function normalizeFilePath(fileKey: string): string | undefined {
  const normalized = fileKey.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (
    !normalized ||
    normalized.length > MAX_FILE_KEY_LENGTH ||
    normalized.startsWith('/') ||
    normalized.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    return undefined;
  }
  return normalized;
}

/**
 * The key a file's usage is stored and looked up under: its normalized path,
 * with topics case-folded to their identity so every spelling of one topic
 * shares a row.
 */
function normalizeFileKey(fileKey: string): string | undefined {
  const path = normalizeFilePath(fileKey);
  return path === undefined ? undefined : memoryFileIdentity(path);
}

/** The usage row for a file, whatever spelling of its key the caller has. */
export function usageEntryFor(
  entries: ReadonlyMap<string, MemoryUsageEntry>,
  fileKey: string,
): MemoryUsageEntry | undefined {
  const key = normalizeFileKey(fileKey);
  return key === undefined ? undefined : entries.get(key);
}

function usageFilePath(scopeDir: string): string {
  return join(scopeDir, USAGE_FILENAME);
}

async function writeFileAtomically(
  scopeDir: string,
  content: string,
): Promise<void> {
  await ensureOwnerOnlyDir(scopeDir, { trustedScopeRoot: scopeDir });
  const filePath = usageFilePath(scopeDir);
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

type UsageFileState =
  | { kind: 'present'; file: UsageFile }
  | { kind: 'missing' }
  | { kind: 'corrupt' };

async function loadUsageFileState(scopeDir: string): Promise<UsageFileState> {
  let raw: string;
  try {
    raw = await readFile(usageFilePath(scopeDir), 'utf8');
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return { kind: 'missing' };
    }
    return { kind: 'corrupt' };
  }
  const file = parseUsageFile(raw);
  return file === null ? { kind: 'corrupt' } : { kind: 'present', file };
}

// Serializes mutations per scope directory so overlapping read-modify-write
// cycles cannot lose updates. The chain tail never rejects; usage is
// advisory, so persistence failures are swallowed after being contained —
// but never silently: a failed mutation flags its scope in
// `failedMutationScopes` so readers stop treating the stale persisted rows
// as pruning evidence.
const mutationChains = new Map<string, Promise<void>>();

// Scopes whose most recent usage mutation failed to persist. While flagged,
// `readUsage` reports tracking as unavailable (pruning stays disabled) and
// the next mutation rebuilds the store from scratch with a fresh tracking
// window instead of trusting anything written before the failure. A scope is
// unflagged only by a subsequent successful full write.
const failedMutationScopes = new Set<string>();

function enqueueUsageMutation(
  scopeDir: string,
  options: { createIfMissing: boolean },
  mutate: (file: UsageFile) => void,
): Promise<void> {
  const chainKey = resolve(scopeDir);
  const previous = mutationChains.get(chainKey) ?? Promise.resolve();
  const next = previous.then(async (): Promise<void> => {
    try {
      const diskState = await loadUsageFileState(scopeDir);
      // The missing-store early return must observe the real on-disk state
      // before the failure-flag override below: a mutation that declines to
      // create a missing store (deleteUsageEntries) must never fabricate one
      // for a failure-flagged scope — that would mint a fresh tracking
      // window and clear the flag without any usage ever being recorded.
      // Returning here leaves the flag intact for a real write to clear.
      if (diskState.kind === 'missing' && !options.createIfMissing) {
        return;
      }
      // After a failed mutation the persisted store is untrustworthy even
      // if it parses: it may hold a zero-count row for a file whose usage
      // bump was lost. Treat it as corrupt so the write below recreates it
      // with a fresh tracking window.
      const state: UsageFileState = failedMutationScopes.has(chainKey)
        ? { kind: 'corrupt' }
        : diskState;
      let file: UsageFile;
      if (state.kind === 'present') {
        file = state.file;
      } else {
        // First creation, or recreation after corruption or a failed
        // mutation: tracking restarts now, so zero counters cannot
        // masquerade as a full observation window for pruning decisions.
        file = {
          version: USAGE_FILE_VERSION,
          trackingSince: new Date().toISOString(),
          entries: {},
        };
      }
      mutate(file);
      await writeFileAtomically(scopeDir, `${JSON.stringify(file, null, 2)}\n`);
      failedMutationScopes.delete(chainKey);
    } catch {
      // Usage is advisory; content remains intact when counters fail. But
      // the failure must disable pruning for the scope: flag it in-memory
      // and best-effort invalidate the persisted store so the old rows
      // cannot resurface as non-use evidence after a process restart. If
      // the deletion fails too, the in-memory flag still covers this
      // process; the swallow keeps SearchMemory's hot path non-throwing.
      failedMutationScopes.add(chainKey);
      await unlink(usageFilePath(scopeDir)).catch(() => undefined);
    }
  });
  mutationChains.set(chainKey, next);
  return next;
}

function normalizedUniqueKeys(fileKeys: Iterable<string>): string[] {
  return Array.from(
    new Set(
      Array.from(fileKeys)
        .map(normalizeFileKey)
        .filter((fileKey): fileKey is string => fileKey !== undefined),
    ),
  );
}

type UsageSignals = Pick<
  MemoryUsageEntry,
  'citationCount' | 'usageSignalCount'
>;

function applyUsageCounts(
  scopeDir: string,
  counts: ReadonlyMap<string, number>,
  usedAt: string,
  signals?: ReadonlyMap<string, UsageSignals>,
): Promise<void> {
  // A synced replica also sends its uses to the cloud (design §15).
  localMemoryReplicaHooks()?.usageRecorded(scopeDir, counts, usedAt);
  return enqueueUsageMutation(
    scopeDir,
    { createIfMissing: true },
    (file): void => {
      for (const [fileKey, count] of Array.from(counts)) {
        const existing = file.entries[fileKey];
        const signal = signals?.get(fileKey);
        file.entries[fileKey] = {
          ...existing,
          usageCount: (existing?.usageCount ?? 0) + count,
          lastUsedAt: usedAt,
          createdAt: existing?.createdAt ?? usedAt,
          ...(signal?.citationCount !== undefined
            ? {
                citationCount:
                  (existing?.citationCount ?? 0) + signal.citationCount,
              }
            : {}),
          ...(signal?.usageSignalCount !== undefined
            ? {
                usageSignalCount:
                  (existing?.usageSignalCount ?? 0) + signal.usageSignalCount,
              }
            : {}),
        };
      }
    },
  );
}

/** One citation and/or distinctive-term signal per delivered file per turn. */
export async function recordUsageSignals(
  scopeDir: string,
  signals: readonly {
    fileKey: string;
    citationCount: number;
    usageSignalCount: number;
  }[],
): Promise<void> {
  const positive = new Map<string, UsageSignals>();
  for (const signal of signals) {
    if (signal.citationCount <= 0 && signal.usageSignalCount <= 0) continue;
    const key = normalizeFileKey(signal.fileKey);
    if (key === undefined) continue;
    const existing = positive.get(key);
    // One positive use per file per turn, including aliases of the same topic.
    positive.set(key, {
      citationCount: Math.max(
        existing?.citationCount ?? 0,
        signal.citationCount,
      ),
      usageSignalCount: Math.max(
        existing?.usageSignalCount ?? 0,
        signal.usageSignalCount,
      ),
    });
  }
  if (positive.size === 0) return;
  flushPendingUsageFor(scopeDir);
  // Use the same mutation and replica hook as reads/injections. Detailed
  // evidence stays local; sync receives only the existing generic use delta.
  await applyUsageCounts(
    scopeDir,
    new Map([...positive.keys()].map((key) => [key, 1])),
    new Date().toISOString(),
    positive,
  );
}

/** Delay before batched usage reaches disk; readers flush it first. */
export const USAGE_BATCH_DELAY_MS = 2_000;

/**
 * File keys a use names but that are costly to find, such as the topics an
 * index excerpt links. They are resolved when the batch is applied, never on
 * the path that records the use.
 */
export type DeferredUsageKeys = () => Iterable<string>;

interface PendingUsage {
  scopeDir: string;
  counts: Map<string, number>;
  /** One entry per recorded use, each counted once when resolved. */
  deferred: DeferredUsageKeys[];
  usedAt: string;
  timer: ReturnType<typeof setTimeout>;
}

// Uses recorded on hot paths (memory injection on every chat turn) wait here
// briefly so a burst of turns costs one usage.json write per scope. Every
// mutation and read of a scope applies them first, so prune revalidation
// never sees a store that is missing a recorded use.
const pendingUsage = new Map<string, PendingUsage>();

function flushPendingUsageFor(scopeDir: string): void {
  const chainKey = resolve(scopeDir);
  const pending = pendingUsage.get(chainKey);
  if (!pending) return;
  pendingUsage.delete(chainKey);
  clearTimeout(pending.timer);
  for (const resolveKeys of pending.deferred) {
    let fileKeys: string[];
    try {
      fileKeys = normalizedUniqueKeys(resolveKeys());
    } catch {
      // A use whose keys cannot be resolved still keeps the batch's other
      // uses; it simply names nothing more.
      continue;
    }
    for (const fileKey of fileKeys) {
      pending.counts.set(fileKey, (pending.counts.get(fileKey) ?? 0) + 1);
    }
  }
  if (pending.counts.size === 0) return;
  void applyUsageCounts(pending.scopeDir, pending.counts, pending.usedAt);
}

/**
 * Counts a use without waiting for the write, batching repeated uses of the
 * same scope into one write after {@link USAGE_BATCH_DELAY_MS}.
 * `deferredKeys` names more files of the same use (none of them in
 * `fileKeys`), resolved only when the
 * batch is applied (after the delay, or before any read or mutation of the
 * scope), so the caller pays nothing to find them.
 */
export function recordUsageSoon(
  scopeDir: string,
  fileKeys: string[],
  deferredKeys?: DeferredUsageKeys,
): void {
  const normalizedKeys = normalizedUniqueKeys(fileKeys);
  if (normalizedKeys.length === 0 && deferredKeys === undefined) return;
  const chainKey = resolve(scopeDir);
  let pending = pendingUsage.get(chainKey);
  if (!pending) {
    const timer = setTimeout(() => {
      flushPendingUsageFor(scopeDir);
    }, USAGE_BATCH_DELAY_MS);
    timer.unref?.();
    pending = { scopeDir, counts: new Map(), deferred: [], usedAt: '', timer };
    pendingUsage.set(chainKey, pending);
  }
  pending.usedAt = new Date().toISOString();
  if (deferredKeys !== undefined) pending.deferred.push(deferredKeys);
  for (const fileKey of normalizedKeys) {
    pending.counts.set(fileKey, (pending.counts.get(fileKey) ?? 0) + 1);
  }
}

/** Writes every batched use now; for shutdown. */
export async function flushPendingUsage(): Promise<void> {
  const scopes = Array.from(
    pendingUsage.values(),
    (pending) => pending.scopeDir,
  );
  for (const scopeDir of scopes) flushPendingUsageFor(scopeDir);
  await Promise.all(
    scopes.map(
      (scopeDir): Promise<void> =>
        mutationChains.get(resolve(scopeDir)) ?? Promise.resolve(),
    ),
  );
}

export async function recordUsage(
  scopeDir: string,
  fileKeys: string[],
): Promise<void> {
  const normalizedKeys = normalizedUniqueKeys(fileKeys);
  if (normalizedKeys.length === 0) return;
  flushPendingUsageFor(scopeDir);
  await applyUsageCounts(
    scopeDir,
    new Map(normalizedKeys.map((fileKey) => [fileKey, 1])),
    new Date().toISOString(),
  );
}

export async function seedEntry(
  scopeDir: string,
  fileKey: string,
): Promise<void> {
  const normalizedKey = normalizeFileKey(fileKey);
  if (normalizedKey === undefined) return;
  flushPendingUsageFor(scopeDir);
  await enqueueUsageMutation(
    scopeDir,
    { createIfMissing: true },
    (file): void => {
      if (file.entries[normalizedKey] === undefined) {
        file.entries[normalizedKey] = {
          usageCount: 0,
          lastUsedAt: null,
          createdAt: new Date().toISOString(),
        };
      }
    },
  );
}

export async function deleteUsageEntries(
  scopeDir: string,
  fileKeys: Iterable<string>,
): Promise<void> {
  const normalizedKeys = Array.from(fileKeys)
    .map(normalizeFileKey)
    .filter((fileKey): fileKey is string => fileKey !== undefined);
  if (normalizedKeys.length === 0) return;
  flushPendingUsageFor(scopeDir);
  // Deleting rows never restarts tracking for a healthy store; a missing
  // store stays missing rather than being created just to delete from it.
  await enqueueUsageMutation(
    scopeDir,
    { createIfMissing: false },
    (file): void => {
      for (const fileKey of normalizedKeys) {
        delete file.entries[fileKey];
      }
    },
  );
}

export async function readUsage(
  scopeDir: string,
): Promise<MemoryUsageSnapshot> {
  const chainKey = resolve(scopeDir);
  flushPendingUsageFor(scopeDir);
  // Join the per-scope mutation chain so any in-flight recordUsage write
  // settles before the read. Without this, a prune revalidation could
  // observe the pre-write zero-count snapshot for a topic whose usage bump
  // is mid-write and archive a just-used file. The chain tail never
  // rejects, and the failure flag is checked after it settles so a failed
  // in-flight mutation is also seen.
  await (mutationChains.get(chainKey) ?? Promise.resolve());
  if (failedMutationScopes.has(chainKey)) {
    // A mutation for this scope failed to persist, so the rows on disk may
    // be missing a usage bump that actually happened. Fail closed: report
    // tracking unavailable until a successful write rebuilds the store.
    return { trackingSince: null, entries: new Map() };
  }
  const state = await loadUsageFileState(scopeDir);
  if (state.kind !== 'present') {
    // Absent or unreadable usage data is "unknown", never "zero". Callers
    // must not use this snapshot as pruning evidence; the next successful
    // write recreates the store with a fresh trackingSince.
    return { trackingSince: null, entries: new Map() };
  }
  return {
    trackingSince: state.file.trackingSince,
    entries: new Map(Object.entries(state.file.entries)),
  };
}
