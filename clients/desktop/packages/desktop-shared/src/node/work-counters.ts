import { AsyncLocalStorage } from 'node:async_hooks';
import { CANOPY_ERROR_KINDS } from '@canopy/protocol/canopy-core';
import { serialize } from 'node:v8';
import {
  BACKGROUND_SERVICE_UNREACHABLE_REASONS,
  type BackgroundServiceUnreachableReason,
} from '../lib/background-service-status';
import {
  recordChatStorageScopeCommit,
  recordChatStorageScopeMutations,
  recordChatStorageScopeSync,
  recordChatStorageScopeWrite,
  type ChatStorageCommitTiming,
} from './chat-storage-activity';

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
  | 'metadata';

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

/** Distinct counter names kept per source; later names fold into overflow. */
export const WORK_COUNTER_KEY_LIMIT = 4096;

/** Counts increments that arrived after a source reached its key limit. */
export const WORK_COUNTER_OVERFLOW_KEY = 'overflow';

export type ChatStorageFileClass =
  /** The version 2 metadata write-ahead journal. */
  | 'journal'
  /** The delta journal of a version 3 scope (`delta-journal.log`). */
  | 'deltaJournal'
  /** A delta-journal checkpoint's progress marker (`delta-checkpoint.json`). */
  | 'checkpointMarker'
  | 'liveIndex'
  | 'archiveIndex'
  | 'recoveryIndex'
  | 'payload'
  | 'transcript'
  | 'appendStaging'
  | 'activeSidecar'
  | 'transcriptIndex'
  | 'turnIndex'
  | 'messageIndex'
  | 'artifact'
  /** A delegated agent's transcript log (`transcripts/delegations/`). */
  | 'delegationLog'
  /** The per-chat delegation result and generation registry. */
  | 'delegationRegistry'
  | 'childTranscript'
  | 'childActiveSidecar'
  | 'childAppendStaging'
  | 'childStreamMetadata'
  | 'childMessageIndex'
  | 'manifest'
  | 'other';

class BoundedCounters {
  private readonly values = new Map<string, number>();

  public add(key: string, delta: number): void {
    const current = this.values.get(key);
    if (current !== undefined) {
      this.values.set(key, current + delta);
      return;
    }
    if (this.values.size >= WORK_COUNTER_KEY_LIMIT) {
      this.values.set(
        WORK_COUNTER_OVERFLOW_KEY,
        (this.values.get(WORK_COUNTER_OVERFLOW_KEY) ?? 0) + 1,
      );
      return;
    }
    this.values.set(key, delta);
  }

  public snapshot(): Record<string, number> {
    return Object.fromEntries(this.values);
  }

  public clear(): void {
    this.values.clear();
  }
}

const counters: Record<WorkCounterSource, BoundedCounters> = {
  ipc: new BoundedCounters(),
  chatStorage: new BoundedCounters(),
  provider: new BoundedCounters(),
  route: new BoundedCounters(),
  w5: new BoundedCounters(),
  metadata: new BoundedCounters(),
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

function pathSegments(path: string): string[] {
  return path.split(/[\\/]+/);
}

/** Drops the `.<uuid>.tmp` suffix atomic writers give their staging files. */
function publishedName(name: string): string {
  return name.replace(/\.[0-9a-f-]{36}\.tmp$/i, '');
}

function classifyTranscriptFile(name: string): ChatStorageFileClass {
  if (name.endsWith('.append.tmp')) return 'appendStaging';
  if (name.endsWith('.rewrite.tmp')) return 'transcript';
  const published = publishedName(name);
  if (published.endsWith('.active.json')) return 'activeSidecar';
  if (published.endsWith('.index.json')) return 'transcriptIndex';
  if (published.endsWith('.turns.json')) return 'turnIndex';
  if (published.endsWith('.jsonl')) return 'transcript';
  return 'other';
}

function classifyDelegationFile(path: readonly string[]): ChatStorageFileClass {
  if (path[1] === 'registry') return 'delegationRegistry';
  const v2 = path.indexOf('v2');
  const name = path[path.length - 1] ?? '';
  const published = publishedName(name).replace(/\.checkpoint$/, '');
  if (published === 'stream-catalog.json' && path.length === 1)
    return 'childStreamMetadata';
  if (v2 < 0) return 'delegationLog';
  if (
    published === 'descriptor.json' ||
    published === 'registry.jsonl' ||
    published === 'registry.index.json'
  )
    return 'childStreamMetadata';
  if (
    path.includes('message-index') ||
    published.includes('sequence-index') ||
    published.endsWith('.index.json') ||
    published.endsWith('.turns.json')
  )
    return 'childMessageIndex';
  if (name.endsWith('.append.tmp')) return 'childAppendStaging';
  if (published.endsWith('.active.json')) return 'childActiveSidecar';
  if (published.endsWith('.jsonl')) return 'childTranscript';
  return 'delegationLog';
}

/**
 * The role a file plays in canonical chat storage
 * (`chat-storage-v2/<scope>/…` and its authority manifests), or `undefined`
 * for files outside it. Temporary files take the class of their target.
 */
export function classifyChatStorageFile(
  path: string,
): ChatStorageFileClass | undefined {
  const segments = pathSegments(path);
  const root = segments.lastIndexOf('chat-storage-v2');
  if (root === -1) {
    return segments.includes('chat-storage-manifests') ? 'manifest' : undefined;
  }
  const [area, entry] = segments.slice(root + 2);
  if (area === undefined) return 'other';
  if (area.startsWith('metadata-journal.jsonl')) return 'journal';
  if (area.startsWith('delta-journal.log')) return 'deltaJournal';
  if (area.startsWith('delta-journal-v2.log')) return 'deltaJournal';
  if (area.startsWith('delta-checkpoint.json')) return 'checkpointMarker';
  if (area.startsWith('live-index.json')) return 'liveIndex';
  if (area.startsWith('archive-index.json')) return 'archiveIndex';
  if (area.startsWith('recovery-index.json')) return 'recoveryIndex';
  if (area === 'pending-transcripts') return 'payload';
  if (area !== 'transcripts' || entry === undefined) return 'other';
  if (entry === 'tool-output' || entry === 'visuals') return 'artifact';
  if (entry === 'delegations')
    return classifyDelegationFile(segments.slice(root + 4));
  if (entry === 'message-index') return 'messageIndex';
  return classifyTranscriptFile(entry);
}

/** Where a synced chat-storage directory sits, for sync attribution. */
function classifyChatStorageDirectory(path: string): string {
  const segments = pathSegments(path).filter(Boolean);
  const root = segments.lastIndexOf('chat-storage-v2');
  if (root === -1) return 'manifest';
  const [area, entry, ...rest] = segments.slice(root + 2);
  if (area === undefined) return 'scope';
  if (area !== 'transcripts')
    return area === 'pending-transcripts' ? 'payload' : 'other';
  if (entry === undefined) return 'transcripts';
  if (entry === 'tool-output' || entry === 'visuals') return 'artifact';
  if (entry === 'message-index') return 'messageIndex';
  if (entry !== 'delegations') return 'other';
  if (rest[1] === 'registry') return 'delegationRegistry';
  return rest.includes('v2') ? 'childStream' : 'delegations';
}

/** Whether a file or directory belongs to canonical chat storage. */
export function isChatStoragePath(path: string): boolean {
  const segments = pathSegments(path);
  return (
    segments.includes('chat-storage-v2') ||
    segments.includes('chat-storage-manifests')
  );
}

/**
 * Bytes a chat-storage writer put in `path`. `serialized` marks bytes it also
 * produced by JSON serialization rather than by copying existing bytes.
 */
export function recordChatStorageFileWrite(
  path: string,
  bytes: number,
  serialized: boolean,
): void {
  const fileClass = classifyChatStorageFile(path);
  if (fileClass === undefined) return;
  if (serialized)
    counters.chatStorage.add(`serialized.${fileClass}.bytes`, bytes);
  counters.chatStorage.add(`written.${fileClass}.bytes`, bytes);
  recordChatStorageScopeWrite(
    path,
    bytes,
    fileClass === 'transcript' || fileClass === 'appendStaging',
  );
}

export function recordChatStorageFileSync(path: string): void {
  if (!isChatStoragePath(path)) return;
  counters.chatStorage.add('syncs.file', 1);
  // Subsets of `syncs.file` by file role, such as delta-journal commits.
  counters.chatStorage.add(
    `syncs.file.${classifyChatStorageFile(path) ?? 'other'}`,
    1,
  );
  recordChatStorageScopeSync(path, 'file');
}

export function recordChatStorageDirectorySync(path: string): void {
  if (!isChatStoragePath(path)) return;
  counters.chatStorage.add('syncs.directory', 1);
  counters.chatStorage.add(
    `syncs.directory.${classifyChatStorageDirectory(path)}`,
    1,
  );
  recordChatStorageScopeSync(path, 'directory');
}

/** A rename that atomically published or replaced `path`. */
export function recordChatStorageAtomicReplacement(path: string): void {
  if (!isChatStoragePath(path)) return;
  counters.chatStorage.add('atomicReplacements', 1);
  counters.chatStorage.add(
    `atomicReplacements.${classifyChatStorageFile(path) ?? 'other'}`,
    1,
  );
}

/** One delta-journal checkpoint that published its index files. */
export function recordChatStorageDeltaJournalCheckpoint(): void {
  counters.chatStorage.add('deltaJournal.checkpoints', 1);
}

/**
 * One scope transaction that published its journal record. `timing` also
 * attributes it, with its duration, to its scope's local diagnostics.
 */
export function recordChatStorageCommit(
  timing?: ChatStorageCommitTiming,
): void {
  counters.chatStorage.add('commits', 1);
  recordChatStorageScopeCommit(timing);
}

/** Canonical mutations carried by one commit, in `scopeDirectory` if known. */
export function recordChatStorageMutations(
  count: number,
  scopeDirectory?: string,
): void {
  counters.chatStorage.add('mutations', count);
  recordChatStorageScopeMutations(count, scopeDirectory);
}

/** Whole live, archive, or recovery indexes serialized to disk. */
export function recordChatStorageIndexSerializations(count: number): void {
  counters.chatStorage.add('indexSerializations', count);
}

/** One `structuredClone` of a whole index or index set. */
export function recordChatStorageIndexClone(): void {
  counters.chatStorage.add('indexClones', 1);
}

/** Whole live, archive, or recovery indexes parsed from disk. */
export function recordChatStorageIndexParses(count: number): void {
  counters.chatStorage.add('indexParses', count);
}

/**
 * One pass that reads a staged transcript payload back from disk and parses
 * its rows. `hashed` marks a pass that also recomputed the payload digest to
 * verify it. The digest a commit computes while writing the payload is not a
 * read and is not counted.
 */
export function recordChatStoragePayloadPass(hashed: boolean): void {
  counters.chatStorage.add('payloadReads', 1);
  counters.chatStorage.add('payloadParses', 1);
  if (hashed) counters.chatStorage.add('payloadHashes', 1);
}

/** One tool-output artifact file newly published. */
export function recordChatStorageArtifactPublished(): void {
  counters.chatStorage.add('artifactsPublished', 1);
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
