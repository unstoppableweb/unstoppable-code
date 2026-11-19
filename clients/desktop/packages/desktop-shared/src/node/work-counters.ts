import { AsyncLocalStorage } from 'node:async_hooks';
import { CANOPY_ERROR_KINDS } from '@canopy/protocol/canopy-core';
import { serialize } from 'node:v8';
import {
  BACKGROUND_SERVICE_UNREACHABLE_REASONS,
  type BackgroundServiceUnreachableReason,
} from '../lib/background-service-status';
import {
  BoundedCounters,
  chatStorageWorkCounters,
  WORK_COUNTER_OVERFLOW_KEY,
  recordChatStorageScopeMutations,
} from '@canopy/core-runtime/node/chat/chat-storage-activity';
export {
  WORK_COUNTER_KEY_LIMIT,
  WORK_COUNTER_OVERFLOW_KEY,
  classifyChatStorageFile,
  isChatStoragePath,
  recordChatStorageFileWrite,
  recordChatStorageFileSync,
  recordChatStorageDirectorySync,
  recordChatStorageAtomicReplacement,
  recordChatStorageDeltaJournalCheckpoint,
  recordChatStorageCommit,
  recordChatStorageIndexSerializations,
  recordChatStorageIndexParses,
  recordChatStoragePayloadPass,
  recordChatStorageArtifactPublished,
  type ChatStorageFileClass,
} from '@canopy/core-runtime/node/chat/chat-storage-activity';

/**
 * Process-wide work counters for the desktop performance harness.
 *
 * Counting is a cheap, always-on increment on paths that already run: IPC
 * handler invocations and main → renderer deliveries, canonical chat-storage
 * writes, provider event ingestion, the backend each routed read used, and
 * W5 store reads, captures and commits.
 * Nothing here changes what the instrumented code does, in what order, or
 * with which payloads. Costly byte estimation runs only in an E2E build
 * (`__CANOPY_E2E__`) whose harness asked for it, and the snapshot and reset
 * query is installed only in E2E builds.
 *
 * The module has no Electron dependency so a future core daemon can host it.
 * See `docs/desktop-app-performance.md` ("Work counters and the local
 * ratchet") for the counter names and how the harness reads them. The
 * chat-storage hooks also feed the per-scope accounting in
 * `chat-storage-activity.ts`, which local diagnostics summarize; the harness
 * reset never touches it.
 */

export type WorkCounterSource =
  | 'ipc'
  | 'chatStorage'
  | 'provider'
  | 'route'
  | 'w5'
  | 'metadata'
  | 'stale'
  | 'w5Caller';

export interface WorkCountersSnapshot {
  /** Changes on every reset, so a reader can tell counts were cleared. */
  generation: number;
  ipc: Record<string, number>;
  chatStorage: Record<string, number>;
  provider: Record<string, number>;
  /**
   * Which backend served each routed read, for acceptance specs. The
   * performance harness does not sample it.
   */
  route: Record<string, number>;
  /**
   * W5 store work (CAN-5532): reads, captures, commits and record-port
   * calls, with their microsecond totals. Evidence for the store arms, not a
   * judged work metric.
   */
  w5: Record<string, number>;
  /**
   * Metadata file work outside W5 (CAN-6932): project config file probes and
   * reads by the caller that asked, and archive recovery journal scans.
   */
  metadata: Record<string, number>;
  /**
   * The broad session-stale signal (CAN-6970): requests by the source that
   * asked, broadcasts actually sent, session snapshot builds, and the chat
   * session activity notifications by reason.
   */
  stale: Record<string, number>;
  /**
   * W5 daemon captures and store reads by the IPC channel whose handler
   * asked (CAN-6944), `other` outside any handler. E2E builds only.
   */
  w5Caller: Record<string, number>;
}

export interface WorkCountersResetOptions {
  /**
   * Estimate main → renderer payload bytes with `v8.serialize`. Honoured only
   * in E2E builds; production builds compile the estimator out.
   */
  estimateIpcBytes?: boolean;
  /**
   * Estimate UTF-8 JSON bytes for delegation snapshots. Honoured only in E2E
   * builds; production builds never serialize these snapshots for counting.
   */
  estimateDelegationBytes?: boolean;
}

export interface WorkCountersQuery {
  snapshot(): WorkCountersSnapshot;
  reset(options?: WorkCountersResetOptions): WorkCountersSnapshot;
}

declare global {
  // Installed in E2E builds only, for the desktop performance harness.
  var __CANOPY_WORK_COUNTERS__: WorkCountersQuery | undefined;
}

export const WORK_COUNTERS_QUERY_KEY = '__CANOPY_WORK_COUNTERS__';

const counters: Record<WorkCounterSource, BoundedCounters> = {
  ipc: new BoundedCounters(),
  chatStorage: chatStorageWorkCounters,
  provider: new BoundedCounters(),
  route: new BoundedCounters(),
  w5: new BoundedCounters(),
  metadata: new BoundedCounters(),
  stale: new BoundedCounters(),
  w5Caller: new BoundedCounters(),
};
let generation = 0;
let estimateIpcBytes = false;
let estimateDelegationBytes = false;

function isE2eBuild(): boolean {
  return typeof __CANOPY_E2E__ !== 'undefined' && __CANOPY_E2E__;
}

export function snapshotWorkCounters(): WorkCountersSnapshot {
  return {
    generation,
    ipc: counters.ipc.snapshot(),
    chatStorage: counters.chatStorage.snapshot(),
    provider: counters.provider.snapshot(),
    route: counters.route.snapshot(),
    w5: counters.w5.snapshot(),
    metadata: counters.metadata.snapshot(),
    stale: counters.stale.snapshot(),
    w5Caller: counters.w5Caller.snapshot(),
  };
}

/** Clears every counter and starts a new generation. */
export function resetWorkCounters(
  options: WorkCountersResetOptions = {},
): WorkCountersSnapshot {
  counters.ipc.clear();
  counters.chatStorage.clear();
  counters.provider.clear();
  counters.route.clear();
  counters.w5.clear();
  counters.metadata.clear();
  counters.stale.clear();
  counters.w5Caller.clear();
  generation += 1;
  estimateIpcBytes = options.estimateIpcBytes === true;
  estimateDelegationBytes = options.estimateDelegationBytes === true;
  return snapshotWorkCounters();
}

/**
 * Approximate wire size of IPC arguments: Electron clones them with the same
 * V8 serializer. `undefined` when a value cannot be serialized.
 */
export function estimateIpcPayloadBytes(
  args: readonly unknown[],
): number | undefined {
  try {
    return serialize(args).byteLength;
  } catch {
    return undefined;
  }
}

/** One renderer → main invocation of a registered IPC handler. */
export function recordIpcInvoke(channel: string): void {
  counters.ipc.add(`invoke.${channel}`, 1);
}

/** One main → renderer message delivered on `channel` to one window. */
export function recordIpcSend(
  channel: string,
  windowLabel: string,
  args: readonly unknown[],
): void {
  const key = `send.${channel}.${windowLabel}`;
  counters.ipc.add(`${key}.messages`, 1);
  if (isE2eBuild() && estimateIpcBytes) {
    const bytes = estimateIpcPayloadBytes(args);
    if (bytes !== undefined) counters.ipc.add(`${key}.bytes`, bytes);
  }
}

/** Canonical mutations carried by one commit, in `scopeDirectory` if known. */
export function recordChatStorageMutations(
  count: number,
  scopeDirectory?: string,
): void {
  counters.chatStorage.add('mutations', count);
  recordChatStorageScopeMutations(count, scopeDirectory);
}

/** One `structuredClone` of a whole index or index set. */
export function recordChatStorageIndexClone(): void {
  counters.chatStorage.add('indexClones', 1);
}

export function recordProviderEventIngested(): void {
  counters.provider.add('eventsIngested', 1);
}

/** A provider event whose ingestion committed a canonical change. */
export function recordProviderEventApplied(): void {
  counters.provider.add('eventsApplied', 1);
}

/** One delegation snapshot at an offer, publication, or canonical admission. */
export function recordDelegationSnapshot(
  stage: 'offered' | 'published' | 'admitted',
  transcript: unknown,
): void {
  const key = `delegationSnapshots.${stage}`;
  try {
    counters.provider.add(key, 1);
    if (!isE2eBuild() || !estimateDelegationBytes) return;
    const serialized = JSON.stringify(transcript);
    if (typeof serialized !== 'string') return;
    counters.provider.add(
      `${key}.bytes`,
      Buffer.byteLength(serialized, 'utf8'),
    );
  } catch {
    // Counting and optional size estimates must never change the measured path.
  }
}

/**
 * Files IPC reads the route observes: roots and directory listings, `file`
 * (scoped `file:read-content`), `search` (one `file-index:get` search page)
 * and `link` (`file-reference:resolve`, CAN-5038).
 */
export type FilesRouteOperation =
  | 'roots'
  | 'directory'
  | 'file'
  | 'search'
  | 'link';

/**
 * One Files IPC read and the backend it was routed to (`direct` or `daemon`).
 * Counted once per request, before the backend runs.
 */
export function recordFilesRouteSelected(
  operation: FilesRouteOperation,
  backend: 'direct' | 'daemon',
): void {
  counters.route.add(`files.${operation}.${backend}`, 1);
}

/**
 * What a routed Files read did: `daemon.queries` per daemon query sent,
 * `daemon.retries` per conflict refresh, `daemon.served` when a daemon result
 * was returned, `daemon.failed.<kind>` for a typed failure, and
 * `direct.discarded` when a direct result was dropped because the route
 * changed while it ran. A read selected for a daemon that couldn't be reached
 * counts `daemon.fallback.<reason>` when the direct reader answered it
 * instead, or `daemon.bypassed` when a latched failure skipped the daemon.
 */
export function recordFilesRouteOutcome(
  operation: FilesRouteOperation,
  outcome:
    | 'daemon.queries'
    | 'daemon.retries'
    | 'daemon.served'
    | `daemon.failed.${string}`
    | `daemon.fallback.${BackgroundServiceUnreachableReason}`
    | 'daemon.bypassed'
    | 'direct.discarded',
): void {
  counters.route.add(`files.${operation}.${outcome}`, 1);
}

/**
 * One unit of W5 store work, or `delta` of a total such as microseconds.
 * Keys are documented in `docs/desktop-app-performance.md` ("W5 store arms").
 */
export function recordW5Work(key: string, delta = 1): void {
  counters.w5.add(key, delta);
  if (isE2eBuild()) chargeW5Caller(key);
}

/** Names the caller that metadata reads made inside `work` are counted under. */
export type MetadataReadCaller =
  | 'sidebar.project'
  | 'sidebar.worktree'
  | 'worktree.effective'
  | 'remote.projects-load';

const metadataReadCaller = new AsyncLocalStorage<MetadataReadCaller>();

export function runWithMetadataReadCaller<T>(
  caller: MetadataReadCaller,
  work: () => T,
): T {
  return metadataReadCaller.run(caller, work);
}

/**
 * One unit of metadata file work, keyed `<key>.<caller>`; a read outside any
 * named caller counts under `other`. Keys are documented in
 * `docs/desktop-app-performance.md` ("Metadata counters").
 */
export function recordMetadataRead(key: string): void {
  counters.metadata.add(
    `${key}.${metadataReadCaller.getStore() ?? 'other'}`,
    1,
  );
}

/** One unit of metadata work that has no caller attribution. */
export function recordMetadataWork(key: string, delta = 1): void {
  counters.metadata.add(key, delta);
}

/**
 * One unit of session-stale signal work, or `delta` of a `.us` total. Keys
 * are documented with the `stale` source in `docs/desktop-app-performance.md`.
 */
export function recordStaleWork(key: string, delta = 1): void {
  counters.stale.add(key, delta);
}

/** The W5 work an IPC handler's caller is charged with (CAN-6944). */
type W5CallerWork = 'capture' | 'storeRead';

interface W5CallerKeys {
  readonly capture: string;
  readonly storeRead: string;
}

const W5_OTHER_CALLER = 'other';
const w5Caller = new AsyncLocalStorage<string>();
const w5CallerKeys = new Map<string, W5CallerKeys>();

function keysForW5Caller(caller: string): W5CallerKeys {
  let keys = w5CallerKeys.get(caller);
  if (!keys) {
    keys = { capture: `${caller}.capture`, storeRead: `${caller}.storeRead` };
    w5CallerKeys.set(caller, keys);
  }
  return keys;
}

/**
 * Runs `work` charging its W5 captures and store reads to `caller`, an IPC
 * channel. Only E2E builds track the caller, so production pays nothing.
 */
export function runWithW5Caller<T>(caller: string, work: () => T): T {
  return isE2eBuild() ? w5Caller.run(caller, work) : work();
}

/**
 * Charges a W5 store key to the caller whose work recorded it. Both keys are
 * recorded on the caller's own async path, before the record port batches
 * reads: a record read that reached the daemon (`read.backend.capture`) or a
 * whole query's capture (`readView.captured`) is one capture request, and
 * `read.<file>.store` is a read the query's view did not serve.
 */
function chargeW5Caller(key: string): void {
  let kind: W5CallerWork | undefined;
  if (key === 'read.backend.capture' || key === 'readView.captured')
    kind = 'capture';
  else if (key.startsWith('read.') && key.endsWith('.store'))
    kind = 'storeRead';
  if (!kind) return;
  counters.w5Caller.add(
    keysForW5Caller(w5Caller.getStore() ?? W5_OTHER_CALLER)[kind],
    1,
  );
}

/**
 * Exposes `snapshot()` and `reset()` to the harness as
 * `globalThis.__CANOPY_WORK_COUNTERS__`. A no-op outside E2E builds.
 */
export function installWorkCountersQuery(): boolean {
  if (!isE2eBuild()) return false;
  const query: WorkCountersQuery = Object.freeze({
    snapshot: snapshotWorkCounters,
    reset: resetWorkCounters,
  });
  Object.defineProperty(globalThis, WORK_COUNTERS_QUERY_KEY, {
    configurable: true,
    value: query,
  });
  return true;
}

/** Production-safe Files-only projection; never installs the E2E reset API. */
export interface FilesWorkCountersSnapshot {
  generation: number;
  overflow: number;
  /**
   * `file` counts every `file:read-content` call, including the unscoped,
   * Codex image and sealed-viewer ones the route never sees, so it can
   * exceed `files.file.direct`. `search` counts `file-index:get` calls; one
   * call searches each root once per page, and a call that joins a walk in
   * progress searches nothing, so `files.search.direct` can differ from it
   * either way. `link` counts every `file-reference:resolve` call, including
   * the sealed-viewer ones the route never sees.
   */
  invocations: {
    roots: number;
    directory: number;
    file: number;
    search: number;
    link: number;
  };
  route: Record<string, number>;
}

export function snapshotFilesWorkCounters(): FilesWorkCountersSnapshot {
  const ipc = counters.ipc.snapshot();
  const route = counters.route.snapshot();
  const operations: FilesRouteOperation[] = [
    'roots',
    'directory',
    'file',
    'search',
    'link',
  ];
  const outcomes = [
    'direct',
    'daemon',
    'daemon.queries',
    'daemon.retries',
    'daemon.served',
    'daemon.bypassed',
    ...BACKGROUND_SERVICE_UNREACHABLE_REASONS.map(
      (reason) => `daemon.fallback.${reason}`,
    ),
    'direct.discarded',
  ];
  const failures = CANOPY_ERROR_KINDS;
  return {
    generation,
    overflow:
      (ipc[WORK_COUNTER_OVERFLOW_KEY] ?? 0) +
      (route[WORK_COUNTER_OVERFLOW_KEY] ?? 0),
    invocations: {
      roots: ipc['invoke.file-tree:roots'] ?? 0,
      directory: ipc['invoke.file-tree:directory'] ?? 0,
      file: ipc['invoke.file:read-content'] ?? 0,
      search: ipc['invoke.file-index:get'] ?? 0,
      link: ipc['invoke.file-reference:resolve'] ?? 0,
    },
    route: Object.fromEntries(
      operations.flatMap((operation) =>
        [...outcomes, ...failures.map((kind) => `daemon.failed.${kind}`)].map(
          (outcome) => {
            const key = `files.${operation}.${outcome}`;
            return [key, route[key] ?? 0];
          },
        ),
      ),
    ),
  };
}
