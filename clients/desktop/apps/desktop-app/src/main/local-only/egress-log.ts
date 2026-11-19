/**
 * Records outbound attempts the local-only egress guard blocked, in
 * `local-only-egress.jsonl` in the app data directory
 * (docs/local-only-build.md).
 *
 * One JSON line per host and source per run, so a retry loop cannot grow the
 * file. Lines are appended asynchronously, one write at a time, so the guard
 * never blocks the main thread; the shutdown cleanup awaits
 * `drainEgressLog()`, so a test reading the file after quit sees every line
 * the file could take. A line it couldn't take is held (up to 64) and written
 * with a later blocked attempt. Lines hold the time, host, source and a short
 * stack summary of file names only. Full URLs, query strings, headers and absolute paths are
 * never written. One main-process log warning per host.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { getLocalOnlyEgressLogPath } from '../lib/paths';

/** `node`, `renderer`, or a session label such as `session:visual-preview`. */
export type EgressSource = string;

export interface EgressLogEntry {
  readonly time: string;
  readonly host: string;
  readonly source: EgressSource;
  readonly stack: readonly string[];
}

const STACK_FRAMES = 6;
/** Lines held while the file can't be written; at most this many. */
const MAX_PENDING = 64;
/** After a failed write, the next attempt waits this long. */
const WRITE_RETRY_MS = 1_000;
/** Longest the quit-time drain waits, matching the main-process log drain. */
const DRAIN_TIMEOUT_MS = 1_000;
const recorded = new Set<string>();
const warnedHosts = new Set<string>();
const pending: EgressLogEntry[] = [];
let lastWriteFailureAt: number | null = null;
let warnedWriteFailure = false;
let warnedPendingFull = false;
/** The append in progress; it never rejects. */
let writing: Promise<void> | null = null;

/**
 * Reduces a stack to at most six `function (file:line)` frames, keeping only
 * each file's base name so no private path reaches a CI artifact.
 */
export function summarizeStack(stack: string | undefined): string[] {
  if (!stack) return [];
  const frames: string[] = [];
  for (const line of stack.split('\n').slice(1)) {
    const match = /^\s*at (?:(.+?) \()?(.+?)(?::(\d+))?(?::\d+)?\)?$/.exec(
      line,
    );
    if (!match) continue;
    const [, fn, location, lineNumber] = match;
    if (location === undefined) continue;
    if (location.includes('local-only/egress-') || location === 'native') {
      continue;
    }
    const file = basename(location.replace(/^file:\/\//, ''));
    frames.push(
      `${fn ?? '<anonymous>'} (${file}${lineNumber ? `:${lineNumber}` : ''})`,
    );
    if (frames.length >= STACK_FRAMES) break;
  }
  return frames;
}

/**
 * Records one blocked attempt. Never throws. `captureStack` runs only for a
 * new host and source, so a retry loop doesn't build a stack per attempt.
 */
export function recordBlockedEgress(
  host: string,
  source: EgressSource,
  captureStack?: () => string | undefined,
): void {
  const key = `${source}\u0000${host}`;
  if (recorded.has(key)) {
    // A repeat adds no line, but retries any line still held.
    flushPending();
    return;
  }
  if (!warnedHosts.has(host)) {
    warnedHosts.add(host);
    logMainProcessWarn(
      `[local-only] Blocked an outbound request to ${host} (${source}). See local-only-egress.jsonl.`,
    );
  }
  if (pending.length < MAX_PENDING) {
    // Recorded only once queued: a pair turned away by a full queue is
    // queued by a later attempt once the file takes the held lines.
    recorded.add(key);
    pending.push({
      time: new Date().toISOString(),
      host,
      source,
      stack: summarizeStack(captureStack?.()),
    });
  } else if (!warnedPendingFull) {
    warnedPendingFull = true;
    logMainProcessWarn(
      `[local-only] local-only-egress.jsonl is unwritable and ${MAX_PENDING} lines are waiting; later blocked attempts aren't recorded there until it can be written.`,
    );
  }
  flushPending();
}

/**
 * Starts appending every held line unless a write is already running; lines
 * that arrive meanwhile follow once it succeeds. A line the file couldn't take
 * stays held and is retried with a later blocked attempt, at most once per
 * `WRITE_RETRY_MS` (unless `force`), so a persistent failure costs at most one
 * write attempt per second rather than one per connection.
 */
function flushPending(now = Date.now(), force = false): void {
  if (writing !== null || pending.length === 0) return;
  if (
    !force &&
    lastWriteFailureAt !== null &&
    now - lastWriteFailureAt < WRITE_RETRY_MS
  ) {
    return;
  }
  writing = appendHeld(pending.length).finally(() => {
    writing = null;
    if (lastWriteFailureAt === null) flushPending();
  });
}

/** Appends the first `count` held lines and drops them once written. Never rejects. */
async function appendHeld(count: number): Promise<void> {
  try {
    const path = getLocalOnlyEgressLogPath();
    await mkdir(dirname(path), { recursive: true });
    await appendFile(
      path,
      pending
        .slice(0, count)
        .map((entry) => `${JSON.stringify(entry)}\n`)
        .join(''),
      'utf8',
    );
    pending.splice(0, count);
    lastWriteFailureAt = null;
    warnedWriteFailure = false;
    warnedPendingFull = false;
  } catch (error) {
    lastWriteFailureAt = Date.now();
    if (warnedWriteFailure) return;
    warnedWriteFailure = true;
    logMainProcessWarn(
      `[local-only] Could not record a blocked request: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Waits for the write in progress, then tries once more for any line still
 * held, ignoring the retry delay. Shutdown cleanup awaits it before quitting,
 * so it gives up after `timeoutMs`: a stalled data directory must not hold
 * quit. Never rejects.
 */
export async function drainEgressLog(
  timeoutMs = DRAIN_TIMEOUT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  const drained = (async (): Promise<void> => {
    await settleWrites();
    flushPending(Date.now(), true);
    await settleWrites();
  })();
  try {
    await Promise.race([drained, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** Resolves once no write is running, including any a finished write chained. */
async function settleWrites(): Promise<void> {
  const current = writing;
  if (current === null) return;
  await current;
  await settleWrites();
}

export function resetEgressLogForTests(): void {
  recorded.clear();
  warnedHosts.clear();
  pending.length = 0;
  lastWriteFailureAt = null;
  warnedWriteFailure = false;
  warnedPendingFull = false;
  writing = null;
}
