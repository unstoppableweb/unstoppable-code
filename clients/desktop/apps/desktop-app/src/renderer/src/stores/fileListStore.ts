import {
  createBoundedReadEvidence,
  type ReadEvidenceCursor,
  type ReadEvidenceSnapshot,
} from '@canopy/desktop-shared/lib/bounded-read-evidence';
import { useEffect } from 'react';
import { create } from 'zustand';
import { CoreCoworkRequestError } from '@canopy/app-state/core-cowork';
import {
  cloudSandboxNotAwakeFromDetails,
  type CloudSandboxNotAwakeCode,
} from '@canopy/protocol/cloud-session';
import type {
  FileIndexResponse,
  FileTreeEntry,
  FileTreeDirectoryResponse,
  FileTreeRoot,
  FileTreeRootsResponse,
} from '@canopy/desktop-shared/types';
import { workspaceFileSourceFor } from '@/lib/files/workspace-file-source';

/**
 * Cache entry for a full-worktree file index. Mention search is keyed by
 * `${projectId}/${worktreeId}`; explorer search uses the suffixed key returned
 * by {@link getFileTreeIndexCacheKey} so its inclusive results cannot leak
 * into Cmd+P or `@` mentions.
 */
interface CachedIndexEntry {
  data: FileIndexResponse;
  fetchedAt: number;
}

/**
 * Cache entry for the lazy file-tree explorer's root descriptors. Keyed by
 * `${projectId}/${worktreeId}`.
 */
interface CachedRootsEntry {
  data: FileTreeRootsResponse;
  fetchedAt: number;
}

/**
 * Cache entry for a single directory's immediate children in the lazy file
 * tree. Keyed by `${projectId}/${worktreeId}::${repoId}::${relativeDir}`.
 */
interface CachedDirectoryEntry {
  data: FileTreeDirectoryResponse;
  fetchedAt: number;
}

/**
 * Why a folder's children could not load. `reason` is the web core's own for
 * a cloud chat's sandbox: asleep, or a wake it could not fund.
 */
export interface FileTreeLoadError {
  readonly message: string;
  readonly reason?: 'sandbox_sleeping' | 'insufficient_credits';
  readonly cloudCode?: string;
}

/** A cloud chat's sandbox that could not serve its files, as the web core said. */
export interface FileTreeSandboxNotAwake {
  readonly code: CloudSandboxNotAwakeCode;
  readonly wakeAllowed: boolean;
}

interface FileListState {
  // Full-worktree indexes for mention search and explorer search. Purpose-
  // specific cache keys keep their different exclusion semantics isolated.
  indexCache: Record<string, CachedIndexEntry>;
  indexErrors: Record<string, string>;
  indexLoading: Set<string>;
  indexVersions: Record<string, number>;

  // Explorer roots.
  rootsCache: Record<string, CachedRootsEntry>;
  rootsErrors: Record<string, string>;
  rootsLoading: Set<string>;
  rootsVersions: Record<string, number>;

  // Explorer directory listings.
  directoryCache: Record<string, CachedDirectoryEntry>;
  directoryErrors: Record<string, FileTreeLoadError>;
  directoryLoading: Set<string>;
  directoryVersions: Record<string, number>;

  // A cloud scope whose sandbox refused its files because it is not awake,
  // by worktree key. Every folder and the explorer search share it.
  sandboxNotAwake: Record<string, FileTreeSandboxNotAwake>;

  // Explorer UI state. The standalone tree uses the worktree key; embedded
  // trees append their owning file-tab scope so surfaces never share state.
  fileTreeExpandedPaths: Record<string, Set<string>>;
  // Explorer scroll offset, retained across remounts (navigation, panel
  // collapse/expand, worktree switches) so the tree returns to where the user
  // left it. Keyed by the same per-surface UI key as expansion state.
  fileTreeScrollPositions: Record<string, number>;

  fetchFileIndex: (projectId: string, worktreeId: string) => Promise<void>;
  fetchFileTreeIndex: (projectId: string, worktreeId: string) => Promise<void>;
  fetchFileTreeRoots: (projectId: string, worktreeId: string) => Promise<void>;
  fetchFileTreeDirectory: (
    projectId: string,
    worktreeId: string,
    repoId: string,
    relativeDir: string,
  ) => Promise<void>;
  setFileTreeExpandedPaths: (
    projectId: string,
    worktreeId: string,
    paths: Set<string>,
    uiStateScope?: string,
  ) => void;
  toggleFileTreeExpandedPath: (
    projectId: string,
    worktreeId: string,
    path: string,
    uiStateScope?: string,
  ) => void;
  setFileTreeScrollPosition: (
    projectId: string,
    worktreeId: string,
    scrollTop: number,
    uiStateScope?: string,
  ) => void;
  /**
   * Drops deleted entries from their folder's cached listing, and the
   * listings below them, before any refresh. A listing that still shows one
   * within {@link DELETED_ENTRY_TOMBSTONE_MS} keeps it out.
   */
  removeFileTreeEntries: (
    projectId: string,
    worktreeId: string,
    repoId: string,
    relativePaths: readonly string[],
  ) => void;
  /**
   * Lets listings show deleted paths again on evidence newer than the delete:
   * `entries` the explorer just created or moved something to (and the
   * folders above them), or every delete made before `deletedBefore`, a
   * {@link fileTreeSequenceNow} taken when a turn that has since ended began.
   */
  retireFileTreeTombstones: (
    projectId: string,
    worktreeId: string,
    which:
      | {
          readonly entries: readonly {
            readonly repoId: string;
            readonly relativePath: string;
          }[];
        }
      | { readonly deletedBefore: number },
  ) => void;
  /** Forgets that a cloud scope's sandbox was asleep, and its folders' sleeping errors. */
  clearSandboxNotAwake: (projectId: string, worktreeId: string) => void;
  markFileTreeStale: (projectId: string, worktreeId: string) => void;
  invalidate: (projectId: string, worktreeId: string) => void;
  invalidateAll: () => void;
}

export function getWorktreeCacheKey(
  projectId: string,
  worktreeId: string,
): string {
  return `${projectId}/${worktreeId}`;
}

export function getFileTreeUiStateKey(
  projectId: string,
  worktreeId: string,
  uiStateScope?: string,
): string {
  const worktreeKey = getWorktreeCacheKey(projectId, worktreeId);
  return uiStateScope
    ? `${worktreeKey}::file-tree-ui:${uiStateScope}`
    : worktreeKey;
}

export function getFileTreeIndexCacheKey(
  projectId: string,
  worktreeId: string,
): string {
  return `${getWorktreeCacheKey(projectId, worktreeId)}::file-explorer`;
}

export function getDirectoryCacheKey(
  projectId: string,
  worktreeId: string,
  repoId: string,
  relativeDir: string,
): string {
  return `${getWorktreeCacheKey(projectId, worktreeId)}::${repoId}::${relativeDir}`;
}

/** How long a deleted entry stays out of listings that still show it. */
export const DELETED_ENTRY_TOMBSTONE_MS = 60_000;

/** A deleted entry kept out of listings: when it expires, and when it was made. */
interface DeletedEntryTombstone {
  readonly expiresAt: number;
  /** {@link fileTreeSequenceNow} when the delete landed. */
  readonly deletedAt: number;
}

/**
 * Deleted entries a listing must not bring back, by their folder's cache key
 * then path. It ends on evidence newer than the delete: a listing without the
 * path, a listing from this computer requested after the delete, the
 * explorer creating or moving something to the path, or a turn that started
 * after the delete ending ({@link FileListState.retireFileTreeTombstones}).
 * A cloud listing that still shows the path proves nothing on its own: the
 * web core's listings lag a delete.
 */
const deletedEntryTombstones = new Map<
  string,
  Map<string, DeletedEntryTombstone>
>();

let fileTreeSequence = 0;

/** A point in the explorer's own order of deletes, reads and turns. */
export function fileTreeSequenceNow(): number {
  fileTreeSequence += 1;
  return fileTreeSequence;
}

function parentRelativePath(relativePath: string): string {
  const slash = relativePath.lastIndexOf('/');
  return slash === -1 ? '' : relativePath.slice(0, slash);
}

/**
 * Drops tombstoned entries from a fresh listing and ends the tombstones it no
 * longer needs. `authoritativeAfter` is set for a listing from this computer:
 * it reads the disk, so it is the truth about every delete before it.
 */
function withoutDeletedEntries(
  key: string,
  incoming: FileTreeDirectoryResponse,
  authoritativeAfter: number | null,
): FileTreeDirectoryResponse {
  const tombstones = deletedEntryTombstones.get(key);
  if (tombstones === undefined) return incoming;
  const now = Date.now();
  const listed = new Set(incoming.entries.map((entry) => entry.relativePath));
  for (const [path, tombstone] of tombstones) {
    if (
      tombstone.expiresAt <= now ||
      !listed.has(path) ||
      (authoritativeAfter !== null && tombstone.deletedAt < authoritativeAfter)
    )
      tombstones.delete(path);
  }
  if (tombstones.size === 0) {
    deletedEntryTombstones.delete(key);
    return incoming;
  }
  return {
    ...incoming,
    entries: incoming.entries.filter(
      (entry) => !tombstones.has(entry.relativePath),
    ),
  };
}

/** The directory listing state a delete rewrites. */
interface DirectoryListings {
  directoryCache: Record<string, CachedDirectoryEntry>;
  directoryErrors: Record<string, FileTreeLoadError>;
  directoryVersions: Record<string, number>;
  directoryLoading: Set<string>;
}

/** Removes `relativePath` from the cached listing under `parentKey`, in place. */
function dropFromParentListing(
  directoryCache: Record<string, CachedDirectoryEntry>,
  parentKey: string,
  relativePath: string,
): void {
  const parent = directoryCache[parentKey];
  if (!parent) return;
  const entries = parent.data.entries.filter(
    (entry) => entry.relativePath !== relativePath,
  );
  if (entries.length === parent.data.entries.length) return;
  directoryCache[parentKey] = { ...parent, data: { ...parent.data, entries } };
}

/**
 * Forgets a deleted folder's own listing and every listing below it, in
 * place; a listing of them still in flight is discarded.
 */
function forgetListingsUnder(
  listings: DirectoryListings,
  ownKey: string,
): void {
  const below = (key: string): boolean =>
    key === ownKey || key.startsWith(`${ownKey}/`);
  for (const key of Object.keys(listings.directoryCache).filter(below))
    delete listings.directoryCache[key];
  for (const key of Object.keys(listings.directoryErrors).filter(below))
    delete listings.directoryErrors[key];
  for (const key of Object.keys(listings.directoryVersions).filter(below))
    listings.directoryVersions[key] =
      (listings.directoryVersions[key] ?? 0) + 1;
  for (const key of [...listings.directoryLoading].filter(below))
    listings.directoryLoading.delete(key);
}

/**
 * `errors` without the scope's `sandbox_sleeping` folder errors: once any read
 * of the scope succeeds, the sandbox is awake, and a folder that failed while
 * it slept (collapsed, say) must load again when it is shown.
 */
function withoutSleepingErrors(
  errors: Record<string, FileTreeLoadError>,
  worktreeKey: string,
): Record<string, FileTreeLoadError> {
  const prefix = `${worktreeKey}::`;
  const entries = Object.entries(errors);
  const kept = entries.filter(
    ([key, value]) =>
      !key.startsWith(prefix) || value.reason !== 'sandbox_sleeping',
  );
  return kept.length === entries.length ? errors : Object.fromEntries(kept);
}

function loadErrorOf(error: unknown, fallback: string): FileTreeLoadError {
  if (error instanceof CoreCoworkRequestError) {
    const details: unknown = error.payload.details;
    const reason =
      typeof details === 'object' && details !== null && 'reason' in details
        ? details.reason
        : undefined;
    const cloudCode =
      typeof details === 'object' && details !== null && 'cloudCode' in details
        ? details.cloudCode
        : undefined;
    return {
      message: error.message,
      ...(reason === 'sandbox_sleeping' || reason === 'insufficient_credits'
        ? { reason }
        : {}),
      ...(typeof cloudCode === 'string' ? { cloudCode } : {}),
    };
  }
  return { message: error instanceof Error ? error.message : fallback };
}

/** The not-awake sandbox a failed read names, or null for any other failure. */
function sandboxNotAwakeOf(error: unknown): FileTreeSandboxNotAwake | null {
  return error instanceof CoreCoworkRequestError
    ? cloudSandboxNotAwakeFromDetails(error.payload.details)
    : null;
}

/** `record` with `key` set to the not-awake sandbox `error` names, or left out. */
function withSandboxNotAwake(
  record: Record<string, FileTreeSandboxNotAwake>,
  key: string,
  error: unknown,
): Record<string, FileTreeSandboxNotAwake> {
  const notAwake = sandboxNotAwakeOf(error);
  return notAwake === null ? record : { ...record, [key]: notAwake };
}

function isStale(
  entry: { fetchedAt: number } | undefined,
  maxAgeMs = 60_000,
): boolean {
  if (!entry) return true;
  return Date.now() - entry.fetchedAt > maxAgeMs;
}

export function isFileIndexStale(
  entry: CachedIndexEntry | undefined,
  maxAgeMs = 60_000,
): boolean {
  return isStale(entry, maxAgeMs);
}

export function isFileTreeCacheStale(
  entry: { fetchedAt: number } | undefined,
  maxAgeMs = 60_000,
): boolean {
  return isStale(entry, maxAgeMs);
}

function omitKey<V>(record: Record<string, V>, key: string): Record<string, V> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

function removeFromSet(set: Set<string>, key: string): Set<string> {
  if (!set.has(key)) return set;
  const next = new Set(set);
  next.delete(key);
  return next;
}

function sameFileTreeRoot(left: FileTreeRoot, right: FileTreeRoot): boolean {
  return (
    left.repoId === right.repoId &&
    left.repoName === right.repoName &&
    left.absolutePath === right.absolutePath &&
    left.rootKind === right.rootKind
  );
}

function sameFileTreeEntry(left: FileTreeEntry, right: FileTreeEntry): boolean {
  return (
    left.name === right.name &&
    left.relativePath === right.relativePath &&
    left.absolutePath === right.absolutePath &&
    left.kind === right.kind &&
    left.isIgnored === right.isIgnored &&
    left.isIndexExcluded === right.isIndexExcluded &&
    left.isSymlink === right.isSymlink &&
    left.hasChildren === right.hasChildren
  );
}

/**
 * Reuse unchanged list items by stable path identity. An identical response
 * keeps the whole array reference; additions/removals allocate one shallow
 * list while preserving every unaffected item for memoized tree rows.
 */
function reconcileItems<T>(
  previous: T[],
  incoming: T[],
  keyOf: (item: T) => string,
  equals: (left: T, right: T) => boolean,
): T[] {
  const previousByKey = new Map(previous.map((item) => [keyOf(item), item]));
  const reconciled = incoming.map((item) => {
    const existing = previousByKey.get(keyOf(item));
    return existing && equals(existing, item) ? existing : item;
  });
  return previous.length === reconciled.length &&
    reconciled.every((item, index) => item === previous[index])
    ? previous
    : reconciled;
}

function reconcileRootsResponse(
  previous: FileTreeRootsResponse | undefined,
  incoming: FileTreeRootsResponse,
): FileTreeRootsResponse {
  if (!previous) return incoming;
  const roots = reconcileItems(
    previous.roots,
    incoming.roots,
    (root) => root.repoId,
    sameFileTreeRoot,
  );
  return roots === previous.roots ? previous : { roots };
}

function reconcileDirectoryResponse(
  previous: FileTreeDirectoryResponse | undefined,
  incoming: FileTreeDirectoryResponse,
): FileTreeDirectoryResponse {
  if (!previous) return incoming;
  const entries = reconcileItems(
    previous.entries,
    incoming.entries,
    (entry) => `${entry.kind}:${entry.relativePath}`,
    sameFileTreeEntry,
  );
  return entries === previous.entries ? previous : { entries };
}

// Root descriptors are shared by every file-tree surface in a worktree. Keep
// overlapping consumers on the same request so an earlier waiter cannot be
// invalidated by a redundant later fetch and resume before any roots commit.
const inFlightRootsRequests = new Map<string, Promise<void>>();
/** Extra reads a roots waiter makes when invalidations keep discarding them. */
const MAX_INVALIDATED_ROOTS_RETRIES = 2;

type FilesRendererEvidenceEvent = {
  key: string;
  operation: 'roots' | 'directory';
  version: number;
  request: number;
  phase: 'started' | 'success' | 'failed' | 'discarded';
};
const filesEvidence = createBoundedReadEvidence<FilesRendererEvidenceEvent>();
let filesRequestSequence = 0;

/**
 * Number of released full file indexes kept after their last consumer lets
 * go. Indexes a visible consumer retains are always kept; past this allowance
 * the oldest released entry is evicted and fetched again on demand.
 */
export const FILE_INDEX_RELEASED_ALLOWANCE = 2;

// Residency bookkeeping lives outside Zustand state, so retaining or
// releasing an index never re-renders a subscriber. Only an eviction writes.
const fileIndexRetainCounts = new Map<string, number>();
/** Released, unretained index keys, oldest first. */
const releasedFileIndexKeys: string[] = [];

function removeReleasedFileIndexKey(key: string): void {
  const index = releasedFileIndexKeys.indexOf(key);
  if (index !== -1) releasedFileIndexKeys.splice(index, 1);
}

function hasResidentFileIndexState(key: string): boolean {
  const state = useFileListStore.getState();
  return (
    key in state.indexCache ||
    key in state.indexErrors ||
    state.indexLoading.has(key)
  );
}

/**
 * Drops released entries past the allowance, oldest first. An evicted entry
 * that is still refreshing is fenced by the version bump, so its in-flight
 * response cannot repopulate the cache.
 */
function enforceReleasedFileIndexAllowance(): void {
  const evicted: string[] = [];
  while (releasedFileIndexKeys.length > FILE_INDEX_RELEASED_ALLOWANCE) {
    const key = releasedFileIndexKeys.shift();
    if (key === undefined) break;
    if ((fileIndexRetainCounts.get(key) ?? 0) > 0) continue;
    evicted.push(key);
  }
  if (evicted.length === 0) return;
  useFileListStore.setState((state) => {
    const indexCache = { ...state.indexCache };
    const indexErrors = { ...state.indexErrors };
    const indexVersions = { ...state.indexVersions };
    const indexLoading = new Set(state.indexLoading);
    for (const key of evicted) {
      delete indexCache[key];
      delete indexErrors[key];
      indexLoading.delete(key);
      indexVersions[key] = (state.indexVersions[key] ?? 0) + 1;
    }
    return { indexCache, indexErrors, indexVersions, indexLoading };
  });
}

/** Moves a key to the newest end of the released list when nothing retains it. */
let releasedFileIndexEnforcementQueued = false;

// A view switching keys releases its old key in the same React commit that
// retains the new one, cleanups first. Enforcing after the commit keeps a key
// that is being retained again.
function scheduleReleasedFileIndexEnforcement(): void {
  if (releasedFileIndexEnforcementQueued) return;
  releasedFileIndexEnforcementQueued = true;
  // A promise job rather than queueMicrotask, which fake timers replace.
  void Promise.resolve().then((): void => {
    releasedFileIndexEnforcementQueued = false;
    enforceReleasedFileIndexAllowance();
  });
}

function noteReleasedFileIndex(key: string): void {
  if ((fileIndexRetainCounts.get(key) ?? 0) > 0) return;
  removeReleasedFileIndexKey(key);
  if (!hasResidentFileIndexState(key)) return;
  releasedFileIndexKeys.push(key);
  scheduleReleasedFileIndexEnforcement();
}

/**
 * Keeps the full file index under `key` resident until the returned release
 * runs. Counts are per key, so overlapping consumers share one entry; the
 * release is idempotent. Retaining does not fetch: each consumer keeps its
 * own fetch gate and fetches again when its entry is missing.
 */
export function retainFileIndex(key: string): () => void {
  fileIndexRetainCounts.set(key, (fileIndexRetainCounts.get(key) ?? 0) + 1);
  removeReleasedFileIndexKey(key);
  let released = false;
  return (): void => {
    if (released) return;
    released = true;
    const count = (fileIndexRetainCounts.get(key) ?? 0) - 1;
    if (count > 0) {
      fileIndexRetainCounts.set(key, count);
      return;
    }
    fileIndexRetainCounts.delete(key);
    noteReleasedFileIndex(key);
  };
}

/**
 * Retains the index under `key` for as long as the calling component shows
 * it. Pass `null` while nothing is shown.
 */
export function useRetainFileIndex(key: string | null): void {
  useEffect((): (() => void) | undefined => {
    if (key === null) return undefined;
    return retainFileIndex(key);
  }, [key]);
}

/**
 * Holds a lease on `key` across an asynchronous fetch-then-read, so settling
 * unretained fetches cannot evict the entry between the two. Releasing marks
 * the entry as most recently used.
 */
export async function withRetainedFileIndex<T>(
  key: string,
  read: () => Promise<T>,
): Promise<T> {
  const release = retainFileIndex(key);
  try {
    return await read();
  } finally {
    release();
  }
}

/**
 * One versioned full-index read. A response commits only while its version is
 * current; invalidation and eviction bump the version to discard it. An entry
 * that commits while nothing retains it joins the released list.
 */
async function loadFileIndex(
  key: string,
  worktreeKey: string,
  request: () => Promise<FileIndexResponse>,
): Promise<void> {
  const { getState, setState } = useFileListStore;
  const version = (getState().indexVersions[key] ?? 0) + 1;

  setState((state) => ({
    indexVersions: { ...state.indexVersions, [key]: version },
    indexErrors: omitKey(state.indexErrors, key),
    indexLoading: new Set(state.indexLoading).add(key),
  }));

  let committed = false;
  try {
    const data = await request();
    setState((state) => {
      if ((state.indexVersions[key] ?? 0) !== version) return state;
      committed = true;
      return {
        indexCache: {
          ...state.indexCache,
          [key]: { data, fetchedAt: Date.now() },
        },
        indexErrors: omitKey(state.indexErrors, key),
        indexLoading: removeFromSet(state.indexLoading, key),
        directoryErrors: withoutSleepingErrors(
          state.directoryErrors,
          worktreeKey,
        ),
        sandboxNotAwake: omitKey(state.sandboxNotAwake, worktreeKey),
      };
    });
  } catch (error: unknown) {
    setState((state) => {
      if ((state.indexVersions[key] ?? 0) !== version) return state;
      committed = true;
      return {
        indexErrors: {
          ...state.indexErrors,
          [key]:
            error instanceof Error ? error.message : 'Unable to load files.',
        },
        indexLoading: removeFromSet(state.indexLoading, key),
        sandboxNotAwake: withSandboxNotAwake(
          state.sandboxNotAwake,
          worktreeKey,
          error,
        ),
      };
    });
  }
  if (committed) noteReleasedFileIndex(key);
}

export const useFileListStore = create<FileListState>((set, get) => ({
  indexCache: {},
  indexErrors: {},
  indexLoading: new Set<string>(),
  indexVersions: {},

  rootsCache: {},
  rootsErrors: {},
  rootsLoading: new Set<string>(),
  rootsVersions: {},

  directoryCache: {},
  directoryErrors: {},
  directoryLoading: new Set<string>(),
  directoryVersions: {},

  sandboxNotAwake: {},

  fileTreeExpandedPaths: {},
  fileTreeScrollPositions: {},

  fetchFileIndex: (projectId, worktreeId): Promise<void> =>
    loadFileIndex(
      getWorktreeCacheKey(projectId, worktreeId),
      getWorktreeCacheKey(projectId, worktreeId),
      () =>
        workspaceFileSourceFor(worktreeId).getFileIndex({
          projectId,
          worktreeId,
        }),
    ),

  fetchFileTreeIndex: (projectId, worktreeId): Promise<void> =>
    loadFileIndex(
      getFileTreeIndexCacheKey(projectId, worktreeId),
      getWorktreeCacheKey(projectId, worktreeId),
      () =>
        workspaceFileSourceFor(worktreeId).getFileIndex({
          projectId,
          worktreeId,
          purpose: 'file-explorer',
        }),
    ),

  fetchFileTreeRoots: (projectId, worktreeId): Promise<void> => {
    const key = getWorktreeCacheKey(projectId, worktreeId);
    const existing = inFlightRootsRequests.get(key);
    if (existing) return existing;

    /** One roots read. Returns false when an invalidation discarded it. */
    const loadRoots = async (): Promise<boolean> => {
      const version = (get().rootsVersions[key] ?? 0) + 1;
      let committed = false;
      const event = {
        key,
        operation: 'roots' as const,
        version,
        request: ++filesRequestSequence,
      };
      filesEvidence.record({ ...event, phase: 'started' });

      set((state) => ({
        rootsVersions: { ...state.rootsVersions, [key]: version },
        rootsErrors: omitKey(state.rootsErrors, key),
        rootsLoading: new Set(state.rootsLoading).add(key),
      }));

      try {
        const incoming = await workspaceFileSourceFor(
          worktreeId,
        ).getFileTreeRoots({
          projectId,
          worktreeId,
        });
        set((state) => {
          if ((state.rootsVersions[key] ?? 0) !== version) {
            filesEvidence.record({ ...event, phase: 'discarded' });
            return state;
          }
          filesEvidence.record({ ...event, phase: 'success' });
          committed = true;
          const data = reconcileRootsResponse(
            state.rootsCache[key]?.data,
            incoming,
          );
          return {
            rootsCache: {
              ...state.rootsCache,
              [key]: { data, fetchedAt: Date.now() },
            },
            rootsErrors: omitKey(state.rootsErrors, key),
            rootsLoading: removeFromSet(state.rootsLoading, key),
          };
        });
      } catch (error: unknown) {
        set((state) => {
          if ((state.rootsVersions[key] ?? 0) !== version) {
            filesEvidence.record({ ...event, phase: 'discarded' });
            return state;
          }
          filesEvidence.record({ ...event, phase: 'failed' });
          committed = true;
          return {
            rootsErrors: {
              ...state.rootsErrors,
              [key]:
                error instanceof Error
                  ? error.message
                  : 'Unable to load files.',
            },
            rootsLoading: removeFromSet(state.rootsLoading, key),
            sandboxNotAwake: withSandboxNotAwake(
              state.sandboxNotAwake,
              key,
              error,
            ),
          };
        });
      }
      return committed;
    };

    let settle: () => void = () => undefined;
    const request = new Promise<void>((resolve) => {
      settle = resolve;
    });
    inFlightRootsRequests.set(key, request);
    void (async (): Promise<void> => {
      try {
        // Waiters read the cache right after this resolves, so it resolves
        // only once current roots (or an error) commit. An invalidation
        // discards the read in flight (a worktree's first diff stats do this
        // at startup); follow the request that replaced it, or read again.
        for (let attempt = 0; attempt <= MAX_INVALIDATED_ROOTS_RETRIES; ) {
          if (await loadRoots()) return;
          attempt += 1;
          const replacement = inFlightRootsRequests.get(key);
          if (replacement !== undefined && replacement !== request) {
            await replacement;
            return;
          }
          inFlightRootsRequests.set(key, request);
        }
      } finally {
        if (inFlightRootsRequests.get(key) === request) {
          inFlightRootsRequests.delete(key);
        }
        settle();
      }
    })();
    return request;
  },

  fetchFileTreeDirectory: async (
    projectId,
    worktreeId,
    repoId,
    relativeDir,
  ): Promise<void> => {
    const key = getDirectoryCacheKey(
      projectId,
      worktreeId,
      repoId,
      relativeDir,
    );
    const worktreeKey = getWorktreeCacheKey(projectId, worktreeId);
    const source = workspaceFileSourceFor(worktreeId);
    const requestedAt = fileTreeSequenceNow();
    const version = (get().directoryVersions[key] ?? 0) + 1;
    const event = {
      key,
      operation: 'directory' as const,
      version,
      request: ++filesRequestSequence,
    };
    filesEvidence.record({ ...event, phase: 'started' });

    set((state) => ({
      directoryVersions: { ...state.directoryVersions, [key]: version },
      directoryErrors: omitKey(state.directoryErrors, key),
      directoryLoading: new Set(state.directoryLoading).add(key),
    }));

    try {
      const incoming = await source.getFileTreeDirectory({
        projectId,
        worktreeId,
        repoId,
        relativeDir,
      });
      set((state) => {
        if ((state.directoryVersions[key] ?? 0) !== version) {
          filesEvidence.record({ ...event, phase: 'discarded' });
          return state;
        }
        filesEvidence.record({ ...event, phase: 'success' });
        const data = reconcileDirectoryResponse(
          state.directoryCache[key]?.data,
          withoutDeletedEntries(
            key,
            incoming,
            source.onThisComputer ? requestedAt : null,
          ),
        );
        return {
          directoryCache: {
            ...state.directoryCache,
            [key]: { data, fetchedAt: Date.now() },
          },
          directoryErrors: withoutSleepingErrors(
            omitKey(state.directoryErrors, key),
            worktreeKey,
          ),
          directoryLoading: removeFromSet(state.directoryLoading, key),
          sandboxNotAwake: omitKey(state.sandboxNotAwake, worktreeKey),
        };
      });
    } catch (error: unknown) {
      set((state) => {
        if ((state.directoryVersions[key] ?? 0) !== version) {
          filesEvidence.record({ ...event, phase: 'discarded' });
          return state;
        }
        filesEvidence.record({ ...event, phase: 'failed' });
        return {
          directoryErrors: {
            ...state.directoryErrors,
            [key]: loadErrorOf(error, "Couldn't load this folder."),
          },
          directoryLoading: removeFromSet(state.directoryLoading, key),
          sandboxNotAwake: withSandboxNotAwake(
            state.sandboxNotAwake,
            worktreeKey,
            error,
          ),
        };
      });
    }
  },

  setFileTreeExpandedPaths: (
    projectId,
    worktreeId,
    paths,
    uiStateScope,
  ): void => {
    const key = getFileTreeUiStateKey(projectId, worktreeId, uiStateScope);
    set((state) => ({
      fileTreeExpandedPaths: {
        ...state.fileTreeExpandedPaths,
        [key]: new Set(paths),
      },
    }));
  },

  toggleFileTreeExpandedPath: (
    projectId,
    worktreeId,
    path,
    uiStateScope,
  ): void => {
    const key = getFileTreeUiStateKey(projectId, worktreeId, uiStateScope);
    set((state) => {
      const nextPaths = new Set(state.fileTreeExpandedPaths[key] ?? []);
      if (nextPaths.has(path)) {
        nextPaths.delete(path);
      } else {
        nextPaths.add(path);
      }
      return {
        fileTreeExpandedPaths: {
          ...state.fileTreeExpandedPaths,
          [key]: nextPaths,
        },
      };
    });
  },

  setFileTreeScrollPosition: (
    projectId,
    worktreeId,
    scrollTop,
    uiStateScope,
  ): void => {
    const key = getFileTreeUiStateKey(projectId, worktreeId, uiStateScope);
    set((state) => ({
      fileTreeScrollPositions: {
        ...state.fileTreeScrollPositions,
        [key]: scrollTop,
      },
    }));
  },

  removeFileTreeEntries: (
    projectId,
    worktreeId,
    repoId,
    relativePaths,
  ): void => {
    const tombstone: DeletedEntryTombstone = {
      expiresAt: Date.now() + DELETED_ENTRY_TOMBSTONE_MS,
      deletedAt: fileTreeSequenceNow(),
    };
    for (const relativePath of relativePaths) {
      const parentKey = getDirectoryCacheKey(
        projectId,
        worktreeId,
        repoId,
        parentRelativePath(relativePath),
      );
      const tombstones =
        deletedEntryTombstones.get(parentKey) ??
        new Map<string, DeletedEntryTombstone>();
      tombstones.set(relativePath, tombstone);
      deletedEntryTombstones.set(parentKey, tombstones);
    }
    set((state) => {
      const next: DirectoryListings = {
        directoryCache: { ...state.directoryCache },
        directoryErrors: { ...state.directoryErrors },
        directoryVersions: { ...state.directoryVersions },
        directoryLoading: new Set(state.directoryLoading),
      };
      for (const relativePath of relativePaths) {
        const key = (dir: string): string =>
          getDirectoryCacheKey(projectId, worktreeId, repoId, dir);
        dropFromParentListing(
          next.directoryCache,
          key(parentRelativePath(relativePath)),
          relativePath,
        );
        forgetListingsUnder(next, key(relativePath));
      }
      return next;
    });
  },

  retireFileTreeTombstones: (projectId, worktreeId, which): void => {
    const directoryPrefix = `${getWorktreeCacheKey(projectId, worktreeId)}::`;
    if ('deletedBefore' in which) {
      for (const [key, tombstones] of deletedEntryTombstones) {
        if (!key.startsWith(directoryPrefix)) continue;
        for (const [path, tombstone] of tombstones)
          if (tombstone.deletedAt < which.deletedBefore)
            tombstones.delete(path);
        if (tombstones.size === 0) deletedEntryTombstones.delete(key);
      }
      return;
    }
    // The path and every folder above it exist again.
    for (const { repoId, relativePath } of which.entries) {
      for (
        let path = relativePath;
        path !== '';
        path = parentRelativePath(path)
      ) {
        const key = getDirectoryCacheKey(
          projectId,
          worktreeId,
          repoId,
          parentRelativePath(path),
        );
        const tombstones = deletedEntryTombstones.get(key);
        tombstones?.delete(path);
        if (tombstones?.size === 0) deletedEntryTombstones.delete(key);
      }
    }
  },

  clearSandboxNotAwake: (projectId, worktreeId): void => {
    const worktreeKey = getWorktreeCacheKey(projectId, worktreeId);
    set((state) => ({
      directoryErrors: withoutSleepingErrors(
        state.directoryErrors,
        worktreeKey,
      ),
      sandboxNotAwake: omitKey(state.sandboxNotAwake, worktreeKey),
    }));
  },

  markFileTreeStale: (projectId, worktreeId): void => {
    const worktreeKey = getWorktreeCacheKey(projectId, worktreeId);
    const explorerIndexKey = getFileTreeIndexCacheKey(projectId, worktreeId);
    const directoryPrefix = `${worktreeKey}::`;
    set((state) => {
      const indexCache = { ...state.indexCache };
      for (const key of [worktreeKey, explorerIndexKey]) {
        const entry = indexCache[key];
        if (entry) indexCache[key] = { ...entry, fetchedAt: 0 };
      }
      const rootsCache = { ...state.rootsCache };
      const rootEntry = rootsCache[worktreeKey];
      if (rootEntry) {
        rootsCache[worktreeKey] = { ...rootEntry, fetchedAt: 0 };
      }
      const directoryCache = { ...state.directoryCache };
      for (const [key, entry] of Object.entries(directoryCache)) {
        if (key.startsWith(directoryPrefix)) {
          directoryCache[key] = { ...entry, fetchedAt: 0 };
        }
      }
      return { indexCache, rootsCache, directoryCache };
    });
  },

  invalidate: (projectId, worktreeId): void => {
    const worktreeKey = getWorktreeCacheKey(projectId, worktreeId);
    const explorerIndexKey = getFileTreeIndexCacheKey(projectId, worktreeId);
    const directoryPrefix = `${worktreeKey}::`;
    inFlightRootsRequests.delete(worktreeKey);
    // The entries are dropped below; a later commit re-joins the released list.
    removeReleasedFileIndexKey(worktreeKey);
    removeReleasedFileIndexKey(explorerIndexKey);

    set((state) => {
      // Index
      const nextIndexCache = omitKey(state.indexCache, worktreeKey);
      delete nextIndexCache[explorerIndexKey];
      const nextIndexErrors = omitKey(state.indexErrors, worktreeKey);
      delete nextIndexErrors[explorerIndexKey];
      const nextIndexVersions = {
        ...state.indexVersions,
        [worktreeKey]: (state.indexVersions[worktreeKey] ?? 0) + 1,
        [explorerIndexKey]: (state.indexVersions[explorerIndexKey] ?? 0) + 1,
      };
      const nextIndexLoading = removeFromSet(
        removeFromSet(state.indexLoading, worktreeKey),
        explorerIndexKey,
      );

      // Roots
      const nextRootsCache = omitKey(state.rootsCache, worktreeKey);
      const nextRootsErrors = omitKey(state.rootsErrors, worktreeKey);
      const nextRootsVersions = {
        ...state.rootsVersions,
        [worktreeKey]: (state.rootsVersions[worktreeKey] ?? 0) + 1,
      };
      const nextRootsLoading = removeFromSet(state.rootsLoading, worktreeKey);

      // Directories — drop everything for this worktree.
      const nextDirectoryCache: Record<string, CachedDirectoryEntry> = {};
      for (const [key, value] of Object.entries(state.directoryCache)) {
        if (!key.startsWith(directoryPrefix)) {
          nextDirectoryCache[key] = value;
        }
      }
      const nextDirectoryErrors: Record<string, FileTreeLoadError> = {};
      for (const [key, value] of Object.entries(state.directoryErrors)) {
        if (!key.startsWith(directoryPrefix)) {
          nextDirectoryErrors[key] = value;
        }
      }
      const nextDirectoryVersions: Record<string, number> = {};
      for (const [key, value] of Object.entries(state.directoryVersions)) {
        // Bump versions for in-flight fetches so their results discard.
        nextDirectoryVersions[key] = key.startsWith(directoryPrefix)
          ? value + 1
          : value;
      }
      const nextDirectoryLoading = new Set<string>();
      state.directoryLoading.forEach((key) => {
        if (!key.startsWith(directoryPrefix)) {
          nextDirectoryLoading.add(key);
        }
      });

      return {
        indexCache: nextIndexCache,
        indexErrors: nextIndexErrors,
        indexVersions: nextIndexVersions,
        indexLoading: nextIndexLoading,
        rootsCache: nextRootsCache,
        rootsErrors: nextRootsErrors,
        rootsVersions: nextRootsVersions,
        rootsLoading: nextRootsLoading,
        directoryCache: nextDirectoryCache,
        directoryErrors: nextDirectoryErrors,
        directoryVersions: nextDirectoryVersions,
        directoryLoading: nextDirectoryLoading,
        sandboxNotAwake: omitKey(state.sandboxNotAwake, worktreeKey),
      };
    });
  },

  invalidateAll: (): void => {
    inFlightRootsRequests.clear();
    releasedFileIndexKeys.length = 0;
    deletedEntryTombstones.clear();
    set((state) => {
      const bumpEvery = (
        versions: Record<string, number>,
      ): Record<string, number> => {
        const next: Record<string, number> = {};
        for (const [key, value] of Object.entries(versions)) {
          next[key] = value + 1;
        }
        return next;
      };
      return {
        indexCache: {},
        indexErrors: {},
        indexLoading: new Set<string>(),
        indexVersions: bumpEvery(state.indexVersions),
        rootsCache: {},
        rootsErrors: {},
        rootsLoading: new Set<string>(),
        rootsVersions: bumpEvery(state.rootsVersions),
        directoryCache: {},
        directoryErrors: {},
        directoryLoading: new Set<string>(),
        directoryVersions: bumpEvery(state.directoryVersions),
        sandboxNotAwake: {},
      };
    });
  },
}));

export type { CachedIndexEntry, CachedRootsEntry, CachedDirectoryEntry };

export type FilesRendererEvidenceTarget = {
  projectId: string;
  worktreeId: string;
} & (
  | { operation: 'roots' }
  | { operation: 'directory'; repoId: string; relativeDir: string }
);

export interface FilesRendererEvidenceSnapshot extends ReadEvidenceSnapshot<
  Omit<FilesRendererEvidenceEvent, 'key'> & { matchesTarget: boolean }
> {
  source: 'desktop-renderer-file-list-store-v1';
  version: number;
  settled: boolean;
  hasError: boolean;
  currentSuccess: boolean;
  itemCount: number;
}

/** Selectors are inputs only: neither paths, file contents nor errors leave the store. */
export function snapshotFilesRendererEvidence(
  target: FilesRendererEvidenceTarget,
  after?: ReadEvidenceCursor,
): FilesRendererEvidenceSnapshot {
  const state = useFileListStore.getState();
  const roots = target.operation === 'roots';
  const key =
    target.operation === 'roots'
      ? getWorktreeCacheKey(target.projectId, target.worktreeId)
      : getDirectoryCacheKey(
          target.projectId,
          target.worktreeId,
          target.repoId,
          target.relativeDir,
        );
  const version =
    (roots ? state.rootsVersions : state.directoryVersions)[key] ?? 0;
  const cache = roots ? state.rootsCache[key] : state.directoryCache[key];
  const settled = !(roots ? state.rootsLoading : state.directoryLoading).has(
    key,
  );
  const hasError = key in (roots ? state.rootsErrors : state.directoryErrors);
  const snapshot = filesEvidence.snapshot(after);
  const entries = snapshot.entries.map(({ key: entryKey, ...entry }) => ({
    ...entry,
    matchesTarget: entryKey === key && entry.operation === target.operation,
  }));
  const targetEntries = entries.filter((entry) => entry.matchesTarget);
  const success = targetEntries.find(
    (entry) => entry.version === version && entry.phase === 'success',
  );
  const starts = targetEntries.filter((entry) => entry.phase === 'started');
  const finished = new Set(
    targetEntries
      .filter((entry) => entry.phase !== 'started')
      .map((entry) => entry.request),
  );
  return {
    source: 'desktop-renderer-file-list-store-v1',
    ...snapshot,
    entries,
    version,
    settled,
    hasError,
    currentSuccess:
      snapshot.complete &&
      success !== undefined &&
      starts.some((entry) => entry.request === success.request) &&
      starts.every((entry) => finished.has(entry.request)) &&
      settled &&
      !hasError &&
      !isFileTreeCacheStale(cache),
    itemCount: roots
      ? (state.rootsCache[key]?.data.roots.length ?? 0)
      : (state.directoryCache[key]?.data.entries.length ?? 0),
  };
}

const evidenceGlobal: PropertyDescriptorMap = {
  __CANOPY_FILES_RENDERER_EVIDENCE__: {
    value: Object.freeze({ snapshot: snapshotFilesRendererEvidence }),
  },
};
// First evaluation wins, as in main: after a dev HMR reload of this store the
// observer keeps reporting the first instance until the window reloads.
if (
  Object.keys(evidenceGlobal).every(
    (key) => !Object.getOwnPropertyDescriptor(globalThis, key),
  )
) {
  Object.defineProperties(globalThis, evidenceGlobal);
}
