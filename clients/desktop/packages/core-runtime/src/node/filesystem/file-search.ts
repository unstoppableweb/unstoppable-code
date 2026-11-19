import { randomBytes } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import picomatch from 'picomatch';
import {
  WORKER_FILESYSTEM_SEARCH_DEFAULT_LIMIT,
  type WorkerFilesystemSearchMatch,
  type WorkerFilesystemSearchParams,
  type WorkerFilesystemSearchPurpose,
  type WorkerFilesystemSearchResult,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../runtime/errors';
import {
  isDefaultIgnoredPath,
  readDirectoryEntries,
  sortDirectoryEntries,
  type FileSystemReadBoundary,
} from './directory-reader';
import type { FileGlobMatcher, FileIndexingMatchPolicy } from './file-indexing';
import type { FilesystemRoot } from './root-catalog';

/** One walked file. `absolutePath` is host-local and never leaves the host. */
export interface IndexedFile {
  relativePath: string;
  filename: string;
  absolutePath: string;
}

export type FileIndexMatcher = Pick<
  FileGlobMatcher,
  'isIndexExcluded' | 'isTraversalDeferred'
>;

export interface FileIndexWalkOptions {
  readonly matcher: FileIndexMatcher;
  readonly readBoundary?: FileSystemReadBoundary;
}

export interface FileIndexPageOptions {
  /** A file the walk yields but the page does not count, such as a query miss. */
  readonly accept?: (file: IndexedFile) => boolean;
  /**
   * Whether `file` still fits the page, asked for every matching file. A
   * file that does not fit ends a nonempty page and starts the next one; an
   * empty page takes it anyway, so a page never stalls.
   */
  readonly fits?: (file: IndexedFile) => boolean;
  readonly signal?: AbortSignal;
}

export interface FileIndexPage {
  files: IndexedFile[];
  /** Nothing is left to visit; otherwise the walk continues on the next call. */
  exhausted: boolean;
}

/** A resumable index walk: pages concatenate to one uninterrupted walk. */
export interface FileIndexWalk {
  next(limit: number, options?: FileIndexPageOptions): Promise<FileIndexPage>;
}

type WalkEntry = Awaited<ReturnType<typeof readDirectoryEntries>>[number] & {
  name: string;
};

interface WalkFrame {
  readonly entries: readonly WalkEntry[];
  index: number;
}

function isMissingError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    Reflect.get(error, 'code') === 'ENOENT'
  );
}

/**
 * The file index walk the desktop composed in `lib/file-system-listing.ts`,
 * as an explicit stack so a page can stop and resume. Each directory is read
 * once, when the walk reaches it: entries sort directories first, then by
 * `localeCompare`. Excluded directories and symlinked directories are never
 * entered, and a directory whose real path was already visited is skipped.
 * Directories the matcher defers are walked after everything else, in the
 * order they were found. A page is full at `limit` files, and it reports a
 * remainder whenever any entry or deferred directory is left unvisited, even
 * one that yields no file.
 */
export function createFileIndexWalk(
  root: Pick<FilesystemRoot, 'absolutePath' | 'excludedDescendantRoots'>,
  options: FileIndexWalkOptions,
): FileIndexWalk {
  const rootPath = root.absolutePath;
  const { matcher, readBoundary } = options;
  const frames: WalkFrame[] = [];
  const deferred: string[] = [];
  const visited = new Set<string>();
  let started = false;
  let deferredPhase = false;
  let deferredIndex = 0;

  async function enter(directory: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    let realDirectory: string;
    try {
      if (readBoundary) {
        await readBoundary.assertDirectory(rootPath, directory);
        realDirectory = resolve(directory);
      } else {
        realDirectory = await realpath(directory);
      }
    } catch (error) {
      if (isMissingError(error)) return;
      throw error instanceof Error ? error : new Error(String(error));
    }
    if (visited.has(realDirectory)) return;
    visited.add(realDirectory);
    const entries = await readDirectoryEntries(
      rootPath,
      directory,
      root.excludedDescendantRoots,
      readBoundary,
    );
    frames.push({
      entries: sortDirectoryEntries(
        entries.map((entry) => ({ ...entry, name: entry.entry.name })),
      ),
      index: 0,
    });
  }

  return {
    async next(limit, pageOptions = {}): Promise<FileIndexPage> {
      const { accept, fits, signal } = pageOptions;
      const files: IndexedFile[] = [];
      if (!started) {
        started = true;
        await enter(rootPath, signal);
      }
      for (;;) {
        const frame = frames[frames.length - 1];
        if (frame) {
          const entry = frame.entries[frame.index];
          if (entry === undefined) {
            frames.pop();
            continue;
          }
          if (files.length >= limit) return { files, exhausted: false };
          frame.index += 1;
          if (entry.kind === 'directory') {
            if (
              entry.isSymlink ||
              matcher.isIndexExcluded(entry.relativePath, 'directory')
            )
              continue;
            if (
              !deferredPhase &&
              matcher.isTraversalDeferred?.(entry.relativePath) === true
            ) {
              deferred.push(entry.absolutePath);
              continue;
            }
            await enter(entry.absolutePath, signal);
            continue;
          }
          if (matcher.isIndexExcluded(entry.relativePath, 'file')) continue;
          const file: IndexedFile = {
            relativePath: entry.relativePath,
            filename: basename(entry.absolutePath),
            absolutePath: entry.absolutePath,
          };
          if (accept && !accept(file)) continue;
          if (fits && !fits(file) && files.length > 0) {
            frame.index -= 1;
            return { files, exhausted: false };
          }
          files.push(file);
          continue;
        }
        deferredPhase = true;
        const directory = deferred[deferredIndex];
        if (directory === undefined) return { files, exhausted: true };
        if (files.length >= limit) return { files, exhausted: false };
        deferredIndex += 1;
        await enter(directory, signal);
      }
    },
  };
}

/** One whole walk, stopped after `maxEntries` files (the explorer cap). */
export async function walkFileIndex(
  root: Pick<FilesystemRoot, 'absolutePath' | 'excludedDescendantRoots'>,
  options: FileIndexWalkOptions,
  maxEntries = Number.POSITIVE_INFINITY,
): Promise<{ files: IndexedFile[]; truncated: boolean }> {
  const page = await createFileIndexWalk(root, options).next(maxEntries);
  return { files: page.files, truncated: !page.exhausted };
}

/**
 * Ignore status for a whole-root index from one listing of the root's
 * ignored untracked paths (`git ls-files --others --ignored --exclude-standard
 * --directory -z`), instead of a `check-ignore` test per file, which takes
 * minutes in a large repository. A path is ignored when it is listed or lies
 * under a listed directory (an entry ending in `/`). An absent listing marks
 * nothing. A failed one marks the default ignore list instead and calls
 * `onIgnoreStateUnknown`.
 */
export async function readIgnoredPathMatcher(
  list: (() => Promise<readonly string[]>) | null,
  onIgnoreStateUnknown?: () => void,
): Promise<(relativePath: string) => boolean> {
  if (!list) return () => false;
  let entries: readonly string[];
  try {
    entries = await list();
  } catch {
    onIgnoreStateUnknown?.();
    return isDefaultIgnoredPath;
  }
  if (entries.length === 0) return () => false;
  const ignored = new Set(entries);
  return (relativePath) => {
    if (ignored.has(relativePath)) return true;
    for (
      let separator = relativePath.indexOf('/');
      separator !== -1;
      separator = relativePath.indexOf('/', separator + 1)
    ) {
      if (ignored.has(relativePath.slice(0, separator + 1))) return true;
    }
    return false;
  };
}

/** Which matcher a search walks with. */
export type FilesystemSearchPurpose = WorkerFilesystemSearchPurpose;

/** A root a search walks: the host-private catalog fields it needs. */
export type FilesystemSearchRoot = Pick<
  FilesystemRoot,
  'id' | 'absolutePath' | 'gitAware' | 'excludedDescendantRoots'
>;

/** What one search walk reads with, composed by its host per request. */
export interface FilesystemSearchInputs {
  /** The matcher for the request's `purpose`. */
  readonly matcher: FileIndexMatcher;
  /** Case rule for `include` and `exclude`, the host's indexing policy. */
  readonly policy: FileIndexingMatchPolicy;
  readonly readBoundary?: FileSystemReadBoundary;
  /**
   * Ignored untracked paths under a Git-aware root, as `git ls-files
   * --others --ignored --exclude-standard --directory -z` lists them. Absent
   * marks nothing ignored; a rejection marks the default ignore list and
   * sets `ignoreStateUnknown` on the result.
   */
  readonly listIgnoredPathEntries?: (
    root: string,
  ) => Promise<readonly string[]>;
}

export interface FilesystemSearchHost {
  /** Resolves the root and inputs for a new walk; not called for a cursor. */
  resolve(): Promise<{
    root: FilesystemSearchRoot;
    inputs: FilesystemSearchInputs;
  }>;
  /** A cursor continues only under the catalog revision it started under. */
  readonly revision?: string;
  /** The JSON-encoded page budget of a framed binding; unset in process. */
  readonly maxResultBytes?: number;
  readonly signal?: AbortSignal;
}

/** A matched walk entry, for host projections that need its local path. */
export interface FilesystemSearchFile extends IndexedFile {
  isIgnored: boolean;
}

export interface FilesystemSearchPage {
  readonly result: WorkerFilesystemSearchResult;
  /** Each match's walk entry, in match order. */
  readonly files: readonly FilesystemSearchFile[];
}

export interface FilesystemSearchEngine {
  search(
    params: WorkerFilesystemSearchParams,
    host: FilesystemSearchHost,
  ): Promise<FilesystemSearchPage>;
  /** Ends an unfinished walk a client will not continue. */
  release(cursor: string): void;
}

export interface FilesystemSearchEngineOptions {
  /** Open walks kept for their cursors; the least recently used go first. */
  readonly maxOpenWalks?: number;
  /** A cursor expires this long after its page was returned. */
  readonly cursorIdleMs?: number;
  readonly now?: () => number;
}

export const FILESYSTEM_SEARCH_MAX_OPEN_WALKS = 256;
export const FILESYSTEM_SEARCH_CURSOR_IDLE_MS = 60_000;

/**
 * Room for the page's envelope, `nextCursor` and `catalogRevision`. The match
 * schema's path bound keeps one match under 400 KiB encoded, so a page's
 * first match, which `fits` never refuses, stays inside a framed budget.
 */
const PAGE_ENVELOPE_BYTES = 4 * 1024;
/** A match's keys, punctuation, `kind` and `isIgnored`. */
const MATCH_OVERHEAD_BYTES = 96;

type FilesystemSearchFailure =
  | 'notFound'
  | 'modeUnavailable'
  | 'cursorExpired'
  | 'cursorMismatch';

export function filesystemSearchError(
  reason: FilesystemSearchFailure,
): CanopyOperationError {
  const code: `worker.filesystem.search.${FilesystemSearchFailure}` = `worker.filesystem.search.${reason}`;
  switch (reason) {
    case 'notFound':
      return new CanopyOperationError({
        kind: 'not_found',
        code,
        message: 'The selected filesystem root does not exist.',
        retry: { kind: 'never' },
      });
    case 'modeUnavailable':
      return new CanopyOperationError({
        kind: 'capability_unavailable',
        code,
        message: 'Only name search is available.',
        retry: { kind: 'never' },
      });
    case 'cursorExpired':
      return new CanopyOperationError({
        kind: 'not_found',
        code,
        message: 'The search cursor expired. Start the search again.',
        retry: { kind: 'never' },
      });
    case 'cursorMismatch':
      return new CanopyOperationError({
        kind: 'invalid_argument',
        code,
        message: 'The search cursor belongs to a different search.',
        retry: { kind: 'never' },
      });
  }
}

function revisionConflict(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'conflict',
    code: 'worker.filesystem.search.revisionConflict',
    message: 'Filesystem roots changed. Refresh the roots and retry.',
    retry: { kind: 'after_refresh', resource: 'filesystem-roots' },
  });
}

function jsonBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function sortedScope(
  scope: WorkerFilesystemSearchParams['scope'],
): Array<[string, unknown]> {
  return Object.entries(scope).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

/** Everything a cursor must repeat except `limit` and `maxBytesPerMatch`. */
function searchIdentity(params: WorkerFilesystemSearchParams): string {
  return JSON.stringify([
    sortedScope(params.scope),
    params.fileRootId,
    params.mode,
    params.query,
    params.purpose ?? 'mentions',
    params.include ?? [],
    params.exclude ?? [],
  ]);
}

function globFilter(
  globs: readonly string[] | undefined,
  policy: FileIndexingMatchPolicy,
): ((relativePath: string) => boolean) | null {
  const patterns = (globs ?? []).filter((glob) => glob.length > 0);
  return patterns.length === 0
    ? null
    : picomatch(patterns, { dot: true, nocase: !policy.caseSensitive });
}

/** `query`, `include` and `exclude` over a walked file's root-relative path. */
function matchFilter(
  params: WorkerFilesystemSearchParams,
  policy: FileIndexingMatchPolicy,
): ((file: IndexedFile) => boolean) | undefined {
  const query = params.query.toLowerCase();
  const include = globFilter(params.include, policy);
  const exclude = globFilter(params.exclude, policy);
  if (query === '' && !include && !exclude) return undefined;
  return (file) =>
    (query === '' || file.relativePath.toLowerCase().includes(query)) &&
    (!include || include(file.relativePath)) &&
    !exclude?.(file.relativePath);
}

/**
 * Walks Git-ignored directories after everything else, as the explorer
 * already does for dependency trees, so a capped index reaches the files
 * the repository tracks before generated or cached trees.
 */
export function deferIgnoredDirectories(
  matcher: FileIndexMatcher,
  isIgnored: (relativePath: string) => boolean,
): FileIndexMatcher {
  return {
    isIndexExcluded: (relativePath, kind) =>
      matcher.isIndexExcluded(relativePath, kind),
    isTraversalDeferred: (relativePath) =>
      matcher.isTraversalDeferred?.(relativePath) === true ||
      isIgnored(`${relativePath}/`),
  };
}

interface OpenWalk {
  readonly identity: string;
  readonly revision: string | undefined;
  readonly root: FilesystemSearchRoot;
  readonly walk: FileIndexWalk;
  readonly accept: ((file: IndexedFile) => boolean) | undefined;
  readonly isIgnored: (relativePath: string) => boolean;
  readonly ignoreStateUnknown: boolean;
  touchedAt: number;
}

/**
 * `worker.filesystem.search` in `name` mode over one root: the desktop file
 * index walk, paged. A page that ends before the walk does returns a
 * single-use cursor to the same paused walk (its visited set, deferred
 * directories and ignore listing), so every page of one search concatenates
 * to exactly one uninterrupted walk. Open walks live in memory only.
 */
export function createFilesystemSearchEngine(
  options: FilesystemSearchEngineOptions = {},
): FilesystemSearchEngine {
  const maxOpenWalks = options.maxOpenWalks ?? FILESYSTEM_SEARCH_MAX_OPEN_WALKS;
  const idleMs = options.cursorIdleMs ?? FILESYSTEM_SEARCH_CURSOR_IDLE_MS;
  const now = options.now ?? Date.now;
  const open = new Map<string, OpenWalk>();

  const expired = (walk: OpenWalk, at: number): boolean =>
    at - walk.touchedAt > idleMs;

  function keep(walk: OpenWalk): string {
    const at = now();
    for (const [cursor, entry] of Array.from(open)) {
      if (open.size < maxOpenWalks && !expired(entry, at)) break;
      open.delete(cursor);
    }
    const cursor = `fs1.${randomBytes(24).toString('base64url')}`;
    walk.touchedAt = at;
    open.set(cursor, walk);
    return cursor;
  }

  function take(cursor: string, identity: string): OpenWalk {
    const walk = open.get(cursor);
    if (!walk || expired(walk, now())) {
      open.delete(cursor);
      throw filesystemSearchError('cursorExpired');
    }
    if (walk.identity !== identity)
      throw filesystemSearchError('cursorMismatch');
    open.delete(cursor);
    return walk;
  }

  async function begin(
    params: WorkerFilesystemSearchParams,
    host: FilesystemSearchHost,
    identity: string,
  ): Promise<OpenWalk> {
    const { root, inputs } = await host.resolve();
    const list = inputs.listIgnoredPathEntries;
    let ignoreStateUnknown = false;
    const isIgnored = await readIgnoredPathMatcher(
      root.gitAware && list
        ? (): Promise<readonly string[]> => list(root.absolutePath)
        : null,
      () => {
        ignoreStateUnknown = true;
      },
    );
    return {
      identity,
      revision: host.revision,
      root,
      walk: createFileIndexWalk(root, {
        matcher: deferIgnoredDirectories(inputs.matcher, isIgnored),
        ...(inputs.readBoundary && { readBoundary: inputs.readBoundary }),
      }),
      accept: matchFilter(params, inputs.policy),
      isIgnored,
      ignoreStateUnknown,
      touchedAt: now(),
    };
  }

  return {
    async search(params, host): Promise<FilesystemSearchPage> {
      if (params.mode !== 'name')
        throw filesystemSearchError('modeUnavailable');
      const identity = searchIdentity(params);
      let walk: OpenWalk;
      if (params.cursor === undefined) {
        walk = await begin(params, host, identity);
      } else {
        walk = take(params.cursor, identity);
        if (walk.revision !== host.revision) throw revisionConflict();
      }
      const limit = params.limit ?? WORKER_FILESYSTEM_SEARCH_DEFAULT_LIMIT;
      let budget =
        host.maxResultBytes === undefined
          ? undefined
          : host.maxResultBytes - PAGE_ENVELOPE_BYTES;
      const fileRootIdBytes = jsonBytes(params.fileRootId);
      const page = await walk.walk.next(limit, {
        ...(walk.accept && { accept: walk.accept }),
        ...(budget !== undefined && {
          fits: (file: IndexedFile): boolean => {
            if (budget === undefined) return true;
            budget -=
              MATCH_OVERHEAD_BYTES +
              fileRootIdBytes +
              jsonBytes(file.relativePath) +
              jsonBytes(file.filename);
            return budget >= 0;
          },
        }),
        ...(host.signal && { signal: host.signal }),
      });
      const isIgnored = walk.isIgnored;
      const files: FilesystemSearchFile[] = [];
      const matches: WorkerFilesystemSearchMatch[] = [];
      for (const file of page.files) {
        const ignored = isIgnored(file.relativePath);
        files.push({ ...file, isIgnored: ignored });
        matches.push({
          fileRootId: params.fileRootId,
          path: file.relativePath,
          kind: 'file',
          name: file.filename,
          isIgnored: ignored,
        });
      }
      return {
        result: {
          matches,
          nextCursor: page.exhausted ? null : keep(walk),
          truncated: !page.exhausted,
          ...(walk.ignoreStateUnknown && { ignoreStateUnknown: true }),
        },
        files,
      };
    },
    release(cursor): void {
      open.delete(cursor);
    },
  };
}
