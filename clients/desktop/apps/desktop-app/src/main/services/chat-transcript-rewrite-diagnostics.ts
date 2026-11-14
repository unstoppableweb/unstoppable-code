import { createHash } from 'node:crypto';

/**
 * Why the transcript planner rewrote an existing chat's committed history.
 * Intentional replacements (import, reset, migration, fork) never report.
 */
export type ChatTranscriptRewriteReason =
  | 'patch'
  | 'removal'
  | 'mixed_active'
  | 'prompt_relocation'
  | 'replacement';

/**
 * Content-free record of one full committed transcript rewrite. Shaped as
 * flat optional `AppDiagnosticRecord` fields so it can be forwarded verbatim
 * once the `chat_transcript_full_rewrite` kind is registered there. It never
 * carries message ids, text, paths, or scope identifiers; the chat key is an
 * opaque digest that only correlates repeated rewrites of one chat.
 */
export interface ChatTranscriptFullRewriteDiagnostic {
  version: 1;
  timestamp: string;
  kind: 'chat_transcript_full_rewrite';
  reason: ChatTranscriptRewriteReason;
  chatTranscriptRewriteChatKey: string;
  chatTranscriptRewriteCommittedRows: number;
  chatTranscriptRewriteCommittedBytes: number;
  /** JSONL bytes serialized by this replacement; cloned prefix excluded. */
  chatTranscriptRewriteBytesWritten?: number;
  /** Serialized replacement through publication/index work; excludes queue wait. */
  chatTranscriptRewriteDurationMs?: number;
  chatTranscriptRewritePatchedRows: number;
  chatTranscriptRewriteRemovedRows: number;
  /** Distinct block types of the patched rows, sorted, at most 8. */
  chatTranscriptRewritePatchedBlockTypes: string[];
  /** Whether the replacement also keeps an active tail (a live turn). */
  chatTranscriptRewriteActiveTail: boolean;
  /** Rewrites of this chat suppressed by the rate limit since the last record. */
  chatTranscriptRewriteSuppressedCount: number;
}

/** Content-free alert when one chat repeatedly rewrites a large transcript. */
export interface ChatTranscriptRewriteRateDiagnostic {
  version: 1;
  timestamp: string;
  kind: 'chat_transcript_rewrite_rate_exceeded';
  chatTranscriptRewriteChatKey: string;
  chatTranscriptRewriteRateWindowMs: number;
  chatTranscriptRewriteRateThresholdBytes: number;
  chatTranscriptRewriteRateCommittedBytes: number;
  chatTranscriptRewriteRateRewrites: number;
  chatTranscriptRewriteRateReasons: ChatTranscriptRewriteReason[];
}

export interface ChatTranscriptFullRewrite {
  chatId: string;
  reason: ChatTranscriptRewriteReason;
  committedRows: number;
  committedBytes: number;
  measurement?: { bytesWritten: number; durationMs: number };
  patchedRows: number;
  removedRows: number;
  patchedBlockTypes: Iterable<string>;
  activeTail: boolean;
}

export type ChatTranscriptRewriteDiagnosticSink = (
  diagnostic: ChatTranscriptFullRewriteDiagnostic,
) => void;
export type ChatTranscriptRewriteRateDiagnosticSink = (
  diagnostic: ChatTranscriptRewriteRateDiagnostic,
) => void;

/** At most one record per chat per minute; storms show up as counts. */
export const CHAT_TRANSCRIPT_REWRITE_DIAGNOSTIC_INTERVAL_MS = 60_000;
export const CHAT_TRANSCRIPT_REWRITE_RATE_WINDOW_MS = 60_000;
export const CHAT_TRANSCRIPT_REWRITE_RATE_BUCKET_MS = 10_000;
export const CHAT_TRANSCRIPT_REWRITE_RATE_THRESHOLD_BYTES = 128 * 1024 * 1024;
const MAX_TRACKED_CHATS = 256;
const MAX_BLOCK_TYPES = 8;
const RATE_BUCKET_COUNT =
  CHAT_TRANSCRIPT_REWRITE_RATE_WINDOW_MS /
  CHAT_TRANSCRIPT_REWRITE_RATE_BUCKET_MS;
const RATE_REASON_BITS: Record<ChatTranscriptRewriteReason, number> = {
  patch: 1 << 0,
  removal: 1 << 1,
  mixed_active: 1 << 2,
  prompt_relocation: 1 << 3,
  replacement: 1 << 4,
};
const RATE_REASONS: ChatTranscriptRewriteReason[] = [
  'mixed_active',
  'patch',
  'prompt_relocation',
  'removal',
  'replacement',
];
const CHAT_KEY_HASH_PREFIX = createHash('sha256').update(
  'chat-transcript-rewrite\0',
);

// Cold metadata-only transactions must not load the Electron logging host.
function logRewriteWarning(message: string, diagnostic: unknown): void {
  void import('../lib/main-process-logging')
    .then(({ logMainProcessWarn }) => logMainProcessWarn(message, diagnostic))
    .catch(() => undefined);
}

const logRecord: ChatTranscriptRewriteDiagnosticSink = (diagnostic) =>
  logRewriteWarning(
    '[chat-storage] full committed transcript rewrite',
    diagnostic,
  );
const logRateRecord: ChatTranscriptRewriteRateDiagnosticSink = (diagnostic) =>
  logRewriteWarning(
    '[chat-storage] full rewrite rate above threshold',
    diagnostic,
  );
const discardRateRecord: ChatTranscriptRewriteRateDiagnosticSink = () =>
  undefined;

interface RateState {
  bucketSlots: Float64Array;
  bucketBytes: Float64Array;
  bucketRewrites: Float64Array;
  bucketReasons: Uint8Array;
  lastAlertAt?: number;
}

/** Every record (after rate limiting) reaches the main log. */
let log: ChatTranscriptRewriteDiagnosticSink = logRecord;
/** Production rate alerts share the main log; tests can replace or drop them. */
let rateLog: ChatTranscriptRewriteRateDiagnosticSink = logRateRecord;
/** Installed by the production chat state host: app diagnostics. */
let forward: ChatTranscriptRewriteDiagnosticSink | undefined;
/** Rate alerts are forwarded separately from full-rewrite records. */
let rateForward: ChatTranscriptRewriteRateDiagnosticSink | undefined;
let now: () => number = Date.now;
const lastRecordedAt = new Map<string, number>();
const suppressed = new Map<string, number>();
const rateStates = new Map<string, RateState>();

function opaqueChatKey(chatId: string): string {
  return CHAT_KEY_HASH_PREFIX.copy()
    .update(chatId)
    .digest()
    .toString('hex', 0, 8);
}

function boundedBlockTypes(types: Iterable<string>): string[] {
  if (Array.isArray(types) && types.length === 0) return [];
  return Array.from(new Set(types)).sort().slice(0, MAX_BLOCK_TYPES);
}

function newRateState(): RateState {
  const bucketSlots = new Float64Array(RATE_BUCKET_COUNT);
  bucketSlots.fill(-1);
  return {
    bucketSlots,
    bucketBytes: new Float64Array(RATE_BUCKET_COUNT),
    bucketRewrites: new Float64Array(RATE_BUCKET_COUNT),
    bucketReasons: new Uint8Array(RATE_BUCKET_COUNT),
  };
}

/** Move every reported chat to the tail, evicting only rate state when full. */
function touchRateState(key: string): RateState {
  let state = rateStates.get(key);
  if (state === undefined) state = newRateState();
  rateStates.delete(key);
  rateStates.set(key, state);
  if (rateStates.size > MAX_TRACKED_CHATS) {
    const oldest = rateStates.keys().next().value;
    if (oldest !== undefined) rateStates.delete(oldest);
  }
  return state;
}

function reportRate(
  rewrite: ChatTranscriptFullRewrite,
  key: string,
  at: number,
): void {
  const state = touchRateState(key);
  const slot = Math.floor(at / CHAT_TRANSCRIPT_REWRITE_RATE_BUCKET_MS);
  const bucketIndex =
    ((slot % RATE_BUCKET_COUNT) + RATE_BUCKET_COUNT) % RATE_BUCKET_COUNT;
  const previousSlot = state.bucketSlots[bucketIndex];
  if (
    previousSlot !== slot &&
    (previousSlot < slot - (RATE_BUCKET_COUNT - 1) || previousSlot > slot)
  ) {
    state.bucketSlots[bucketIndex] = slot;
    state.bucketBytes[bucketIndex] = 0;
    state.bucketRewrites[bucketIndex] = 0;
    state.bucketReasons[bucketIndex] = 0;
  }
  state.bucketSlots[bucketIndex] = slot;
  state.bucketBytes[bucketIndex] += rewrite.committedBytes;
  state.bucketRewrites[bucketIndex] += 1;
  state.bucketReasons[bucketIndex] |= RATE_REASON_BITS[rewrite.reason];

  const oldestSlot = slot - (RATE_BUCKET_COUNT - 1);
  let committedBytes = 0;
  let rewrites = 0;
  let reasonMask = 0;
  for (let index = 0; index < RATE_BUCKET_COUNT; index += 1) {
    const bucketSlot = state.bucketSlots[index];
    if (bucketSlot >= oldestSlot && bucketSlot <= slot) {
      committedBytes += state.bucketBytes[index];
      rewrites += state.bucketRewrites[index];
      reasonMask |= state.bucketReasons[index];
    }
  }
  if (committedBytes < CHAT_TRANSCRIPT_REWRITE_RATE_THRESHOLD_BYTES) return;
  if (
    state.lastAlertAt !== undefined &&
    at - state.lastAlertAt < CHAT_TRANSCRIPT_REWRITE_RATE_WINDOW_MS
  )
    return;

  state.lastAlertAt = at;
  const reasons: ChatTranscriptRewriteReason[] = [];
  for (let index = 0; index < RATE_REASONS.length; index += 1) {
    const reason = RATE_REASONS[index];
    if ((reasonMask & RATE_REASON_BITS[reason]) !== 0) reasons.push(reason);
  }
  const diagnostic: ChatTranscriptRewriteRateDiagnostic = {
    version: 1,
    timestamp: new Date(at).toISOString(),
    kind: 'chat_transcript_rewrite_rate_exceeded',
    chatTranscriptRewriteChatKey: key,
    chatTranscriptRewriteRateWindowMs: CHAT_TRANSCRIPT_REWRITE_RATE_WINDOW_MS,
    chatTranscriptRewriteRateThresholdBytes:
      CHAT_TRANSCRIPT_REWRITE_RATE_THRESHOLD_BYTES,
    chatTranscriptRewriteRateCommittedBytes: committedBytes,
    chatTranscriptRewriteRateRewrites: rewrites,
    chatTranscriptRewriteRateReasons: reasons,
  };
  try {
    rateLog(diagnostic);
  } catch {
    // Rate diagnostics never affect a canonical commit.
  }
  try {
    rateForward?.(diagnostic);
  } catch {
    // Rate diagnostics never affect a canonical commit.
  }
}

/**
 * Report a full committed rewrite. Rate-limited per chat; the record carries
 * the number of rewrites suppressed since the previous one. Never throws.
 */
export function reportChatTranscriptFullRewrite(
  rewrite: ChatTranscriptFullRewrite,
): void {
  try {
    const key = opaqueChatKey(rewrite.chatId);
    const at = now();
    try {
      // Rate state must observe every durable rewrite, including suppressed
      // ones, without making the commit path depend on diagnostics.
      reportRate(rewrite, key, at);
    } catch {
      // Rate diagnostics never affect a canonical commit.
    }
    const previous = lastRecordedAt.get(key);
    if (
      previous !== undefined &&
      at - previous < CHAT_TRANSCRIPT_REWRITE_DIAGNOSTIC_INTERVAL_MS
    ) {
      suppressed.set(key, (suppressed.get(key) ?? 0) + 1);
      return;
    }
    lastRecordedAt.delete(key);
    lastRecordedAt.set(key, at);
    if (lastRecordedAt.size > MAX_TRACKED_CHATS) {
      const oldest = lastRecordedAt.keys().next().value;
      if (oldest !== undefined) {
        lastRecordedAt.delete(oldest);
        suppressed.delete(oldest);
      }
    }
    const suppressedCount = suppressed.get(key) ?? 0;
    suppressed.delete(key);
    const record: ChatTranscriptFullRewriteDiagnostic = {
      version: 1,
      timestamp: new Date(at).toISOString(),
      kind: 'chat_transcript_full_rewrite',
      reason: rewrite.reason,
      chatTranscriptRewriteChatKey: key,
      chatTranscriptRewriteCommittedRows: rewrite.committedRows,
      chatTranscriptRewriteCommittedBytes: rewrite.committedBytes,
      chatTranscriptRewritePatchedRows: rewrite.patchedRows,
      chatTranscriptRewriteRemovedRows: rewrite.removedRows,
      chatTranscriptRewritePatchedBlockTypes: boundedBlockTypes(
        rewrite.patchedBlockTypes,
      ),
      chatTranscriptRewriteActiveTail: rewrite.activeTail,
      chatTranscriptRewriteSuppressedCount: suppressedCount,
    };
    if (rewrite.measurement !== undefined) {
      record.chatTranscriptRewriteBytesWritten =
        rewrite.measurement.bytesWritten;
      record.chatTranscriptRewriteDurationMs = rewrite.measurement.durationMs;
    }
    log(record);
    forward?.(record);
  } catch {
    // Diagnostics never affect a canonical commit.
  }
}

/**
 * Route records to app diagnostics in addition to the main log. The storage
 * layer does not import observability itself: backends are also built by
 * read-only tools and tests that must not start its disk writer.
 */
export function installChatTranscriptRewriteDiagnosticSink(
  sink: ChatTranscriptRewriteDiagnosticSink,
): void {
  forward = sink;
}

/** Forward rate alerts to app diagnostics independently of rewrite records. */
export function installChatTranscriptRewriteRateDiagnosticSink(
  sink: ChatTranscriptRewriteRateDiagnosticSink,
): void {
  rateForward = sink;
}

/** Test seam: capture records (no log line) and control the clock. */
export function setChatTranscriptRewriteDiagnosticsForTests(
  options: {
    sink?: ChatTranscriptRewriteDiagnosticSink;
    rateSink?: ChatTranscriptRewriteRateDiagnosticSink;
    now?: () => number;
  } = {},
): void {
  log = options.sink ?? logRecord;
  rateLog = options.rateSink ?? discardRateRecord;
  forward = undefined;
  rateForward = undefined;
  now = options.now ?? Date.now;
  lastRecordedAt.clear();
  suppressed.clear();
  rateStates.clear();
}
