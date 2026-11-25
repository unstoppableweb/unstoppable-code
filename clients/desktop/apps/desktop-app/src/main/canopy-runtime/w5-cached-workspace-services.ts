import type {
  W5CaptureFile,
  W5CaptureRequest,
  W5CaptureResult,
} from '@canopy/core-runtime/node/w5/commit-log/capture-contract';
import { recordW5Work } from '@canopy/desktop-shared/node/work-counters';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { runW5ReadView } from '../lib/w5-commit-log-file-store';
import {
  isInsideW5ReadView,
  runInW5CapturedView,
  type W5ReadViewOutcome,
} from '../lib/w5-read-view';
import { setW5ReadOnlyLockContext } from '../lib/w5-repository-locks';
import { W5_AGGREGATE_KEYS } from '../lib/w5-work-counters';
import {
  defaultCoreWorkspaceReadServices,
  type CoreWorkspaceReadServices,
} from './core-workspace-adapter';

/*
 * TRANSITIONAL (CAN-7155, W5 readers S-9, Seam A): the dispatcher's
 * workspace and worktree reads (`core.workspace.*`, `core.worktree.*` and
 * their legacy wrappers) can use Electron main's read cache when selected.
 * Selection is currently off on every build. Only the
 * read view selects the images; pure file reads memoize parsed values and
 * give each consumer a deep copy. RR1 removal filtering, the discovery
 * overlay and the in-process list lock run as before, over the cache's
 * images instead of a fresh capture. Kept out of `w5-read-cache.ts`, which
 * main loads lazily, so the composition root does not load the cache.
 * W10's core read model (CAN-7153) replaces it.
 */

/** A cached capture of one query's files and the data root it is under. */
export interface W5ReadCacheServe {
  readonly capture: W5CaptureResult;
  readonly root: string;
}

interface W5ReadCacheServer {
  serve(request: W5CaptureRequest): Promise<W5ReadCacheServe | undefined>;
  markDirty(files: readonly W5CaptureFile[]): void;
}

let server: W5ReadCacheServer | undefined;
let loggedServeFailure = false;

/** External watchers invalidate before notifying readers; never creates a cache. */
export function markDesktopW5ReadCacheDirty(
  files: readonly W5CaptureFile[],
): void {
  server?.markDirty(files);
}

/** The process's cache, once created; until then every query captures. */
export function registerDesktopW5ReadCacheServer(
  next: W5ReadCacheServer | undefined,
): void {
  server = next;
  // The server's writer check leaves out locks that read views take.
  setW5ReadOnlyLockContext(next ? isInsideW5ReadView : (): boolean => false);
}

export function isDesktopW5ReadCacheSelected(): boolean {
  // Off until the CAN-7155 follow-up turns serving on (Mike, 2026-11-23).
  return false;
}

/**
 * `runW5ReadView` over the cache's capture of `request` when it can answer
 * one, else today's capture. A cached view refuses writes and defers RR1
 * cleanup exactly as a captured one does.
 */
export async function runDesktopW5CachedReadView<T>(
  request: W5CaptureRequest,
  work: (view: W5ReadViewOutcome) => Promise<T>,
): Promise<T> {
  let served: W5ReadCacheServe | undefined;
  try {
    served = await server?.serve(request);
  } catch (error) {
    // A serve fault never fails a read: today's path still answers it.
    if (!loggedServeFailure) {
      loggedServeFailure = true;
      logMainProcessWarn('[w5-read-cache] serve failed; reads capture', {
        error,
      });
    }
  }
  if (!served) return runW5ReadView(request, work);
  recordW5Work(W5_AGGREGATE_KEYS.queryReadView);
  recordW5Work('readView.cached');
  return runInW5CapturedView(served.capture, served.root, work, {
    cacheParsedReads: true,
  });
}

/**
 * The composition root's `workspaceServices`: undefined where the cache is
 * not selected, so those builds keep the adapter's defaults unchanged.
 */
export function createDesktopW5CachedWorkspaceServices():
  | CoreWorkspaceReadServices
  | undefined {
  if (!isDesktopW5ReadCacheSelected()) return undefined;
  return {
    ...defaultCoreWorkspaceReadServices(),
    readView: runDesktopW5CachedReadView,
  };
}
