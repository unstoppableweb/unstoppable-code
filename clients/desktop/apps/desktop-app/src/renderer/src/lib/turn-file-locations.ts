import type { TranscriptTurnFile } from '@canopy/agent-transcript/transcript-storage';
import { isPairedComputerId } from '@canopy/protocol/authority-qualified-id';
import { reconcileTurnFileRecords } from '@canopy/protocol/turn-files';
import type {
  FileTreeRoot,
  ShowFilesWorkspaceTarget,
} from '@canopy/desktop-shared/types';
import {
  locateTurnFile,
  type TurnFileLocation,
} from '@canopy/desktop-shared/lib/turn-files';

/**
 * Roots rarely change within a transcript render pass; a short cache keeps a
 * chat with many file-bearing turns from repeating the same host query.
 */
const ROOTS_CACHE_MS = 10_000;
/** Host checks in flight at once; a large scaffold must not burst the IPC. */
const CHECK_CONCURRENCY = 8;
const rootsCache = new Map<
  string,
  { expiresAt: number; roots: Promise<readonly FileTreeRoot[]> }
>();

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async (): Promise<void> => {
      while (next < items.length) {
        const index = next;
        next += 1;
        const item = items[index];
        if (item !== undefined) results[index] = await task(item);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/** Drop expired entries so a long session with many chats stays bounded. */
function pruneExpired(
  cache: Map<string, { expiresAt: number }>,
  now: number,
): void {
  cache.forEach((entry, key) => {
    if (entry.expiresAt <= now) cache.delete(key);
  });
}

function rootsFor(
  target: ShowFilesWorkspaceTarget,
): Promise<readonly FileTreeRoot[]> {
  if (isPairedComputerId(target.projectId)) return Promise.resolve([]);
  const key = `${target.projectId}/${target.worktreeId}`;
  const now = Date.now();
  const cached = rootsCache.get(key);
  if (cached && cached.expiresAt > now) return cached.roots;
  const roots = window.api
    .getFileTreeRoots({
      projectId: target.projectId,
      worktreeId: target.worktreeId,
    })
    .then((response) => response.roots);
  pruneExpired(rootsCache, now);
  const entry = { expiresAt: now + ROOTS_CACHE_MS, roots };
  rootsCache.set(key, entry);
  roots.catch(() => {
    if (rootsCache.get(key) === entry) rootsCache.delete(key);
  });
  return roots;
}

/**
 * Existence answers are reused for the same short window so a transcript that
 * remounts file-bearing turns (virtualization, switching chats) does not
 * repeat one host check per file. An end-of-turn recheck refreshes it.
 */
const existenceCache = new Map<
  string,
  { expiresAt: number; exists: Promise<boolean> }
>();

function existsAsFile(
  target: ShowFilesWorkspaceTarget,
  absolutePath: string,
): Promise<boolean> {
  if (isPairedComputerId(target.projectId)) return Promise.resolve(false);
  const key = `${target.projectId}/${target.worktreeId}|${absolutePath}`;
  const now = Date.now();
  const cached = existenceCache.get(key);
  if (cached && cached.expiresAt > now) return cached.exists;
  // The markdown link resolver already answers "does this regular file exist
  // inside the target's roots" without reading it, so a chip is presented
  // only when the same host check that opening relies on would succeed.
  const filename = absolutePath.slice(absolutePath.lastIndexOf('/') + 1);
  const exists = window.api
    .resolveFileReference({
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      baseFilePath: absolutePath,
      href: encodeURIComponent(filename),
    })
    .then((resolved) => resolved?.kind === 'file');
  pruneExpired(existenceCache, now);
  const entry = { expiresAt: now + ROOTS_CACHE_MS, exists };
  existenceCache.set(key, entry);
  exists.catch(() => {
    if (existenceCache.get(key) === entry) existenceCache.delete(key);
  });
  return exists;
}

type Located =
  | {
      location: TurnFileLocation;
      file: TranscriptTurnFile;
      identity: string;
      sourceIdentities: string[];
      available: boolean;
      failed?: boolean;
    }
  | { location?: undefined; failed: boolean };

async function locateExistingTurnFile(
  target: ShowFilesWorkspaceTarget,
  file: TranscriptTurnFile,
): Promise<Located> {
  let roots: readonly FileTreeRoot[];
  try {
    roots = await rootsFor(target);
  } catch {
    return { failed: true };
  }
  const location = locateTurnFile(file.path, roots);
  if (!location) return { failed: false };
  const identity = (entry: TurnFileLocation): string => {
    const path = /^(?:[a-z]:\/|\/\/)/i.test(entry.absolutePath)
      ? entry.absolutePath.toLowerCase()
      : entry.absolutePath;
    return `${target.projectId}/${target.worktreeId}:${path}`;
  };
  const sourceIdentities = (file.movedFrom ?? []).flatMap((path) => {
    const source = locateTurnFile(path, roots);
    return source ? [identity(source)] : [];
  });
  let available = false;
  let failed = false;
  if (file.state === 'ready' && !file.removed) {
    try {
      available = await existsAsFile(target, location.absolutePath);
    } catch {
      failed = true;
    }
  }
  return {
    location,
    file,
    identity: identity(location),
    sourceIdentities,
    available,
    failed,
  };
}

export interface TurnFileLocationsResolution {
  /** Files that exist as regular files inside a root, in transcript order. */
  located: TurnFileLocation[];
  /** Canonically deduplicated mutations still in flight; never actionable. */
  pending: TranscriptTurnFile[];
  /** Source paths joined to each displayed pending path by scoped host identity. */
  pendingPathAliases: readonly (readonly [
    sourcePath: string,
    pendingPath: string,
  ])[];
  /**
   * True when a host check could not be completed for at least one file, as
   * opposed to the file being absent. Callers should not treat that as a
   * final answer.
   */
  failed: boolean;
}

/**
 * Keeps the files that exist as regular files inside a root of their
 * workspace, in transcript order. Paths outside every root, missing files
 * and directories are dropped rather than presented as dead chips. `fresh`
 * refreshes the short-lived caches first, for the end-of-turn recheck.
 */
export async function resolveTurnFileLocations(
  target: ShowFilesWorkspaceTarget,
  files: readonly TranscriptTurnFile[],
  options: { fresh?: boolean } = {},
): Promise<TurnFileLocationsResolution> {
  if (
    options.fresh ||
    files.some((file) => file.removed || file.movedFrom?.length)
  ) {
    // Drop what this pass would otherwise reuse, once, so the files of one
    // turn still share a single roots read and one existence check each.
    for (const file of files) {
      const scope = file.target ?? target;
      const prefix = `${scope.projectId}/${scope.worktreeId}`;
      if (options.fresh) rootsCache.delete(prefix);
      existenceCache.forEach((_entry, key) => {
        if (key.startsWith(`${prefix}|`)) existenceCache.delete(key);
      });
    }
  }
  const results = await mapWithConcurrency(files, CHECK_CONCURRENCY, (file) =>
    locateExistingTurnFile(file.target ?? target, file),
  );
  const located = reconcileTurnFileRecords(
    results.flatMap((result) => (result.location ? [result] : [])),
  );
  const pendingByIdentity = new Map(
    located
      .filter((entry) => entry.file.state === 'creating')
      .map((entry) => [entry.identity, entry.file.path]),
  );
  return {
    pendingPathAliases: results.flatMap((result) => {
      if (!result.location || result.file.state !== 'creating') return [];
      const pendingPath = pendingByIdentity.get(result.identity);
      return pendingPath ? [[result.file.path, pendingPath] as const] : [];
    }),
    located: located
      .filter((entry) => entry.file.state === 'ready' && entry.available)
      .map(({ location, file }) => ({
        ...location,
        ...(file.target ? { target: file.target } : {}),
        ...(file.change ? { change: file.change } : {}),
        ...(file.saved ? { saved: true } : {}),
      })),
    pending: [
      ...located
        .filter((entry) => entry.file.state === 'creating')
        .map((entry) => entry.file),
      ...results.flatMap((result, index) => {
        const file = files[index];
        return !result.location && result.failed && file?.state === 'creating'
          ? [file]
          : [];
      }),
    ],
    failed: results.some((result) => result.failed === true),
  };
}
