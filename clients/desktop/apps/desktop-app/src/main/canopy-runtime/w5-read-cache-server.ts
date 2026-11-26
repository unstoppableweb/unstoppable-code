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

/*
 * TRANSITIONAL (CAN-7155, W5 readers S-9): the read cache's serving entry
 * points, kept light so `lib/*` readers can use them without loading the
 * dispatcher adapter or the cache itself. Seam A's dispatcher reads open a
 * cached view (`runDesktopW5CachedReadView`); Seam B's direct readers
 * (CAN-7835) wrap their unchanged read in `readThroughDesktopW5Cache`.
 * W10's core read model (CAN-7153) replaces both.
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

/** The index and every file of each workspace it names. */
export const W5_DISCOVER_REQUEST: W5CaptureRequest = Object.freeze({
  files: Object.freeze([]),
  discoverWorkspaces: true,
});

/** The index alone. */
export const W5_INDEX_REQUEST: W5CaptureRequest = Object.freeze({
  files: Object.freeze([Object.freeze({ kind: 'index' as const })]),
  discoverWorkspaces: false,
});

/** One workspace file, without the index; see {@link readThroughDesktopW5Cache}. */
export function w5WorkspaceFileRequest(
  kind: 'manifest' | 'worktrees',
  workspaceId: string,
): W5CaptureRequest {
  return { files: [{ kind, workspaceId }], discoverWorkspaces: false };
}

let server: W5ReadCacheServer | undefined;
let loggedServeFailure = false;
let loggedUncapturedRead = false;

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

async function serveFromCache(
  request: W5CaptureRequest,
): Promise<W5ReadCacheServe | undefined> {
  try {
    return await server?.serve(request);
  } catch (error) {
    // A serve fault never fails a read: today's path still answers it.
    if (!loggedServeFailure) {
      loggedServeFailure = true;
      logMainProcessWarn('[w5-read-cache] serve failed; reads capture', {
        error,
      });
    }
    return undefined;
  }
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
  const served = await serveFromCache(request);
  if (!served) return runW5ReadView(request, work);
  recordW5Work(W5_AGGREGATE_KEYS.queryReadView);
  recordW5Work('readView.cached');
  return runInW5CapturedView(served.capture, served.root, work, {
    cacheParsedReads: true,
  });
}

/**
 * Runs a direct reader's unchanged `read` over the cache's capture of
 * `request` when the cache can answer it; otherwise runs `read` as today,
 * with no view. A served run refuses writes and defers RR1 cleanup until it
 * closes. A run that read a file `request` left out, whether it resolved or
 * rejected, is dropped and `read` runs again as today: its result was
 * decided on a refused read. Its deferred cleanup already ran and re-reads.
 *
 * Requests that name no index skip the cache's `lagging` rule: callers must
 * use only the files' bytes, never their revisions.
 *
 * A served value `acceptServed` refuses is dropped the same way, so a caller
 * can confirm against today's read any answer the image may hold stale. A
 * served rejection skips it: a caller that needs every refusal confirmed
 * must resolve, not throw, from `read`.
 */
export async function readThroughDesktopW5Cache<T>(
  request: W5CaptureRequest,
  read: () => Promise<T>,
  options: { readonly acceptServed?: (value: T) => boolean } = {},
): Promise<T> {
  const served = await serveFromCache(request);
  if (!served) return read();
  recordW5Work('readView.cachedDirect');
  // The view's own list, which grows as `read` goes.
  const seen: { uncapturedReads?: readonly W5CaptureFile[] } = {};
  const run = runInW5CapturedView(
    served.capture,
    served.root,
    (view) => {
      if (view.status === 'captured')
        seen.uncapturedReads = view.uncapturedReads;
      return read();
    },
    { cacheParsedReads: true },
  );
  // Settled either way before the check; `run` itself carries the result.
  await run.catch(() => undefined);
  const uncaptured = seen.uncapturedReads ?? [];
  if (uncaptured.length > 0) {
    recordW5Work('readView.cacheMiss.uncaptured');
    if (!loggedUncapturedRead) {
      loggedUncapturedRead = true;
      logMainProcessWarn(
        '[w5-read-cache] a served read named a file outside its request; it reads again',
        { files: uncaptured },
      );
    }
    return read();
  }
  const { acceptServed } = options;
  if (!acceptServed) return run;
  const value = await run;
  if (acceptServed(value)) return value;
  recordW5Work('readView.cacheMiss.unaccepted');
  return read();
}
