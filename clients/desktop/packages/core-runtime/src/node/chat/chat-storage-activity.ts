import { createHash } from 'node:crypto';

/**
 * Per-scope accounting of canonical chat-storage work, for local diagnostics.
 *
 * `work-counters.ts` counts chat-storage work process-wide for the performance
 * harness. This module splits the same writes, syncs, commits and mutations by
 * the chat-storage scope (`chat-storage-v2/<scope>`) they belong to, so the
 * desktop app can record which scopes churn, and how much, on a user's
 * machine. It is fed from the work-counter hooks and the commit path, holds a
 * bounded number of scopes, and is drained about once a minute by the
 * diagnostics emitter. It never touches the storage it describes.
 *
 * Scope identity (workspace and worktree or Work Entry id) is registered by
 * the chat-state repository when it opens a scope. Totals carry no identity,
 * so they may go to app-level diagnostics; per-scope entries may not.
 *
 * No Electron dependency, so a future core daemon can host it.
 */

export interface ChatStorageScopeIdentity {
  projectId: string;
  worktreeId: string;
}

export interface ChatStorageActivity {
  commits: number;
  mutations: number;
  bytesWritten: number;
  /** Transcript JSONL and append staging bytes only, not other storage classes. */
  transcriptBytesWritten: number;
  fileSyncs: number;
  directorySyncs: number;
  /** Summed commit durations, queue wait included. */
  commitMsTotal: number;
  commitMsMax: number;
  /** Longest wait for the scope's previous transaction. */
  queueWaitMsMax: number;
}

export interface ChatStorageScopeActivity {
  /** Opaque digest of the normalized scope directory; no raw identifiers. */
  scopeKey: string;
  /** Undefined when no repository registered the scope's directory. */
  identity: ChatStorageScopeIdentity | undefined;
  activity: ChatStorageActivity;
}

export interface ChatStorageActivityWindow {
  scopes: ChatStorageScopeActivity[];
  /** Every scope, plus work outside any single scope (manifests, parents). */
  total: ChatStorageActivity;
}

export interface ChatStorageCommitTiming {
  /** The `chat-storage-v2/<scope>` directory the commit published into. */
  scopeDirectory: string;
  /** From queue admission to applied indexes. */
  durationMs: number;
  /** Wait for the scope's previous transaction. */
  queueWaitMs: number;
}

/** Scopes tracked per window; activity beyond it still counts in the total. */
export const CHAT_STORAGE_ACTIVITY_SCOPE_LIMIT = 256;
/** Registered scope identities remembered; the oldest is forgotten first. */
export const CHAT_STORAGE_ACTIVITY_IDENTITY_LIMIT = 4096;

const SCOPE_ROOT = '/chat-storage-v2/';

function emptyActivity(): ChatStorageActivity {
  return {
    commits: 0,
    mutations: 0,
    bytesWritten: 0,
    transcriptBytesWritten: 0,
    fileSyncs: 0,
    directorySyncs: 0,
    commitMsTotal: 0,
    commitMsMax: 0,
    queueWaitMsMax: 0,
  };
}

const identities = new Map<string, ChatStorageScopeIdentity>();
let scopes = new Map<string, ChatStorageActivity>();
let total = emptyActivity();
let active = false;
let commitTotal = 0;

/**
 * The normalized `…/chat-storage-v2/<scope>` prefix of `path`, or undefined
 * for a path outside every scope directory.
 */
function scopeKeyOf(path: string): string | undefined {
  const normalized = path.includes('\\') ? path.replace(/\\/g, '/') : path;
  const root = normalized.lastIndexOf(SCOPE_ROOT);
  if (root === -1) return undefined;
  const scopeStart = root + SCOPE_ROOT.length;
  const scopeEnd = normalized.indexOf('/', scopeStart);
  const key = scopeEnd === -1 ? normalized : normalized.slice(0, scopeEnd);
  return key.length > scopeStart ? key : undefined;
}

function roundMs(value: number): number {
  return Math.round(Math.max(0, value) * 10) / 10;
}

/** Applies `update` to the path's scope (if any) and to the total. */
function record(
  path: string | undefined,
  update: (activity: ChatStorageActivity) => void,
): void {
  active = true;
  update(total);
  const key = path === undefined ? undefined : scopeKeyOf(path);
  if (key === undefined) return;
  let activity = scopes.get(key);
  if (activity === undefined) {
    if (scopes.size >= CHAT_STORAGE_ACTIVITY_SCOPE_LIMIT) return;
    activity = emptyActivity();
    scopes.set(key, activity);
  }
  update(activity);
}

/** Remembers which workspace and worktree (or Work Entry) own a scope. */
export function registerChatStorageScope(
  directory: string,
  identity: ChatStorageScopeIdentity,
): void {
  const key = scopeKeyOf(`${directory}/`);
  if (key === undefined) return;
  identities.delete(key);
  if (identities.size >= CHAT_STORAGE_ACTIVITY_IDENTITY_LIMIT) {
    const oldest = identities.keys().next();
    if (!oldest.done) identities.delete(oldest.value);
  }
  identities.set(key, {
    projectId: identity.projectId,
    worktreeId: identity.worktreeId,
  });
}

/** Bytes a chat-storage writer put in `path`. */
export function recordChatStorageScopeWrite(
  path: string,
  bytes: number,
  transcript = false,
): void {
  if (!(bytes > 0)) return;
  record(path, (activity) => {
    activity.bytesWritten += bytes;
    if (transcript) activity.transcriptBytesWritten += bytes;
  });
}

export function recordChatStorageScopeSync(
  path: string,
  kind: 'file' | 'directory',
): void {
  record(path, (activity) => {
    if (kind === 'file') activity.fileSyncs += 1;
    else activity.directorySyncs += 1;
  });
}

/** One published commit, with its scope and timing when the caller has them. */
export function recordChatStorageScopeCommit(
  timing?: ChatStorageCommitTiming,
): void {
  commitTotal += 1;
  const durationMs = timing === undefined ? 0 : roundMs(timing.durationMs);
  const queueWaitMs = timing === undefined ? 0 : roundMs(timing.queueWaitMs);
  record(
    timing === undefined ? undefined : `${timing.scopeDirectory}/`,
    (activity) => {
      activity.commits += 1;
      activity.commitMsTotal = roundMs(activity.commitMsTotal + durationMs);
      activity.commitMsMax = Math.max(activity.commitMsMax, durationMs);
      activity.queueWaitMsMax = Math.max(activity.queueWaitMsMax, queueWaitMs);
    },
  );
}

/** Canonical mutations one commit carried. */
export function recordChatStorageScopeMutations(
  count: number,
  scopeDirectory?: string,
): void {
  if (!(count > 0)) return;
  record(
    scopeDirectory === undefined ? undefined : `${scopeDirectory}/`,
    (activity) => {
      activity.mutations += count;
    },
  );
}

/** Commits published since the process started; never reset. */
export function chatStorageCommitTotal(): number {
  return commitTotal;
}

/**
 * The activity since the previous call, or undefined when there was none.
 * Starts a new window either way.
 */
export function takeChatStorageActivity():
  | ChatStorageActivityWindow
  | undefined {
  if (!active) return undefined;
  const window: ChatStorageActivityWindow = {
    scopes: Array.from(scopes, ([key, activity]) => ({
      scopeKey: createHash('sha256')
        .update('chat-storage-activity\0')
        .update(key)
        .digest('hex')
        .slice(0, 16),
      identity: identities.get(key),
      activity,
    })),
    total,
  };
  scopes = new Map();
  total = emptyActivity();
  active = false;
  return window;
}

export function resetChatStorageActivityForTests(): void {
  identities.clear();
  scopes = new Map();
  total = emptyActivity();
  active = false;
}

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

export class BoundedCounters {
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
    chatStorageWorkCounters.add(`serialized.${fileClass}.bytes`, bytes);
  chatStorageWorkCounters.add(`written.${fileClass}.bytes`, bytes);
  recordChatStorageScopeWrite(
    path,
    bytes,
    fileClass === 'transcript' || fileClass === 'appendStaging',
  );
}

export function recordChatStorageFileSync(path: string): void {
  if (!isChatStoragePath(path)) return;
  chatStorageWorkCounters.add('syncs.file', 1);
  // Subsets of `syncs.file` by file role, such as delta-journal commits.
  chatStorageWorkCounters.add(
    `syncs.file.${classifyChatStorageFile(path) ?? 'other'}`,
    1,
  );
  recordChatStorageScopeSync(path, 'file');
}

export function recordChatStorageDirectorySync(path: string): void {
  if (!isChatStoragePath(path)) return;
  chatStorageWorkCounters.add('syncs.directory', 1);
  chatStorageWorkCounters.add(
    `syncs.directory.${classifyChatStorageDirectory(path)}`,
    1,
  );
  recordChatStorageScopeSync(path, 'directory');
}

/** A rename that atomically published or replaced `path`. */
export function recordChatStorageAtomicReplacement(path: string): void {
  if (!isChatStoragePath(path)) return;
  chatStorageWorkCounters.add('atomicReplacements', 1);
  chatStorageWorkCounters.add(
    `atomicReplacements.${classifyChatStorageFile(path) ?? 'other'}`,
    1,
  );
}

/** One delta-journal checkpoint that published its index files. */
export function recordChatStorageDeltaJournalCheckpoint(): void {
  chatStorageWorkCounters.add('deltaJournal.checkpoints', 1);
}

/**
 * One scope transaction that published its journal record. `timing` also
 * attributes it, with its duration, to its scope's local diagnostics.
 */
export function recordChatStorageCommit(
  timing?: ChatStorageCommitTiming,
): void {
  chatStorageWorkCounters.add('commits', 1);
  recordChatStorageScopeCommit(timing);
}

/** Whole live, archive, or recovery indexes serialized to disk. */
export function recordChatStorageIndexSerializations(count: number): void {
  chatStorageWorkCounters.add('indexSerializations', count);
}

/** Whole live, archive, or recovery indexes parsed from disk. */
export function recordChatStorageIndexParses(count: number): void {
  chatStorageWorkCounters.add('indexParses', count);
}

/**
 * One pass that reads a staged transcript payload back from disk and parses
 * its rows. `hashed` marks a pass that also recomputed the payload digest to
 * verify it. The digest a commit computes while writing the payload is not a
 * read and is not counted.
 */
export function recordChatStoragePayloadPass(hashed: boolean): void {
  chatStorageWorkCounters.add('payloadReads', 1);
  chatStorageWorkCounters.add('payloadParses', 1);
  if (hashed) chatStorageWorkCounters.add('payloadHashes', 1);
}

/** One tool-output artifact file newly published. */
export function recordChatStorageArtifactPublished(): void {
  chatStorageWorkCounters.add('artifactsPublished', 1);
}

/** The chatStorage work counters; work-counters reports and resets them. */
export const chatStorageWorkCounters = new BoundedCounters();
