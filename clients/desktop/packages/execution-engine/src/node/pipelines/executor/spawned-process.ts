import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { finished } from 'node:stream/promises';
import { readFile } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { killChildProcessGroup } from '@canopy/execution-engine/node/lib/process-kill';
import { wrapWindowsCommandShim } from '@canopy/execution-engine/node/lib/windows-process';
import {
  SpillingRecordStore,
  trackLateStorageCleanup,
  type RecordStore,
} from '@canopy/execution-engine/node/pipelines/executor/record-store';
import { SurrogatePairGuard } from '@canopy/execution-engine/node/pipelines/executor/surrogate-safe-text';

/**
 * A spilled record's remaining work, run by the host when it is ready to take
 * the output. It EMITS in bounded pieces; returning the masked record as one
 * string would rebuild the resident term the store exists to remove.
 */
export type StoredLineCompletion = (
  emit: (text: string) => void,
) => Promise<void>;

/** Builds the store one record is assembled in. */
export type RecordStoreFactory = (
  spillAfterChars: number,
  label: string,
) => RecordStore;
import { redactRecordFromSource } from '@canopy/execution-engine/node/pipelines/executor/streaming-json-redactor';
import {
  classifyJsonDocumentStart,
  type JsonDocumentStart,
  extendMatchToFurthestOverlap,
  redactJsonPreservingFormat,
  withJsonEscapedVariants,
} from '@canopy/execution-engine/lib/redaction';
import { parseOutputFile } from './execution-context';
import type {
  ExecutionResourceMonitor,
  SpawnedProcessResult,
  SpawnedProcessRunOptions,
  SpawnedProcessSpec,
} from './types';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';

export const FORCE_KILL_DELAY_MS = 5_000;

/**
 * Retention contract for a line still being assembled.
 *
 * Deciding what to do with a line needs the WHOLE line: whether it is really
 * JSON (a leading `{` is only a guess), how overlapping configured values merge,
 * which names an object's keys already occupy, and whether a value spans the
 * line's end. So a line is held until it completes and then handled by the same
 * pass every other line takes, and retention is O(longest line).
 *
 * There is deliberately NO size-based rejection. A previous version capped the
 * held line, which made ACCEPTANCE depend on delivery: a valid 64,000,023-character
 * record with no configured value was byte-faithful when it arrived with its
 * newline in one call and was rejected when split before its closing syntax.
 * Same bytes, same child, different answer. Raising the number would only move
 * that boundary, so the cap is gone.
 *
 * O(longest line) is the cost this stream's other consumer already pays:
 * `step-runner.ts`'s `onTranscriptLine` hands COMPLETE records to
 * `redactSerializedJsonLine`, and the whole-delivery path here always
 * materialized the line too. The residual — a child that never writes a line
 * break at all — is inherent to any line-oriented consumer of that stream and is
 * not specific to masking; what matters is that finite valid input now gets the
 * same answer however it is chunked. `applyOutputBackpressure` below bounds the
 * secondary cost so a fast producer cannot also grow the queued-write set.
 */

/** Whitespace-only prefixes cannot be part of the document decision, so they are
 * released early rather than held with the line. */
export const MAX_UNDECIDED_WHITESPACE_CHARS = 1_000_000;

/**
 * Smallest size an open pending segment grows to before a new one starts.
 *
 * Purely an allocation-shape choice: it bounds the segment COUNT so a child
 * writing one character at a time does not create one string object per
 * character, while staying small enough that appending never re-copies much.
 */
const COALESCE_SEGMENT_CHARS = 4_096;

/**
 * Retained-line size above which the line moves to private storage.
 *
 * A MEMORY-MANAGEMENT threshold, not an acceptance limit: nothing is rejected
 * or truncated at it, and a record that crosses it gets exactly the output it
 * would have got below it.
 */
export const RETAINED_LINE_SPILL_CHARS = 8 * 1024 * 1024;

/**
 * Deterministic work counters for regression tests.
 *
 * A wall-clock ratio is a diagnostic, not a bound: it varies with load and
 * invites threshold-raising when it flakes. These count the operations that
 * actually made a path expensive, so a regression is provable and
 * machine-independent.
 */
export const spawnedProcessWorkCounters = {
  /** Times a boundary probe scanned for a multi-line value continuation. */
  boundaryProbes: 0,
  /**
   * Characters actually COPIED out of the pending line.
   *
   * The newline counter alongside this one counts offsets, which stayed linear
   * while the real cost — V8 re-flattening the accumulated rope on every
   * `indexOf` — was quadratic. This counts copies, which is what was expensive.
   */
  pendingCharsMaterialized: 0,
  /** Characters examined by document-shape classification. */
  shapeCharsClassified: 0,
  reset(): void {
    spawnedProcessWorkCounters.boundaryProbes = 0;
    spawnedProcessWorkCounters.pendingCharsMaterialized = 0;
    spawnedProcessWorkCounters.shapeCharsClassified = 0;
  },
};

type AgentTerminalResultStatus = 'success' | 'failure';

interface FinalizeProcessOptions {
  preserveForceKillTimer?: boolean;
}

export interface LocalSpawnedProcessOptions extends SpawnedProcessRunOptions {
  /**
   * Retained-line size above which a record moves to private storage.
   *
   * Exists so a test can FORCE the stored path at a small size and prove it was
   * actually entered — a green run on a small record proves nothing about it.
   * Production leaves it at `RETAINED_LINE_SPILL_CHARS`.
   */
  spillAfterChars?: number;
  /**
   * Replaces the record store this step's redactors use.
   *
   * Exists so storage create/write/read/flush failures can be injected for ONE
   * step and shown to fail that step cleanly while an unrelated concurrent step
   * and the shared host stay healthy. Production leaves it unset and gets
   * `SpillingRecordStore`.
   */
  createRecordStore?: RecordStoreFactory;
  onSpawn?: (pid: number) => void;
  resourceMonitor?: ExecutionResourceMonitor;
  onProcessCleanup?: (cleanup: Promise<void>) => void;
  /**
   * Backpressure from whatever carries `onOutput` on. While it is congested
   * the step's pipes are held, so the step blocks instead of the carrier
   * queueing its output without bound.
   */
  outputGate?: SpawnedProcessOutputGate;
}

export interface SpawnedProcessOutputGate {
  congested(): boolean;
  /** Calls `listener` once, when the carried output has drained. */
  onceDrained(listener: () => void): void;
}

/**
 * True if a cut at `index` would fall between the two UTF-16 code units of
 * a surrogate pair (an astral character, e.g. most emoji). Slicing there
 * produces two pieces that each look like valid, intact JS strings and
 * concatenate back correctly — but each piece, written independently to a
 * real sink (a log file append, an IPC call), re-encodes its lone surrogate
 * to U+FFFD, corrupting the character even though the two JS strings never
 * looked wrong on their own. Nudging the cut back by one unit keeps the
 * pair together in the later piece instead.
 */
function retreatFromSurrogateSplit(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return index;
  const before = text.charCodeAt(index - 1);
  const at = text.charCodeAt(index);
  const isHighSurrogate = before >= 0xd800 && before <= 0xdbff;
  const isLowSurrogate = at >= 0xdc00 && at <= 0xdfff;
  return isHighSurrogate && isLowSurrogate ? index - 1 : index;
}

/**
 * Streaming secret-value redactor. Buffers by character count (UTF-16 code
 * units, matching `string.length`), not by line: a configured secret value
 * that itself contains embedded newlines (a multi-line credential, e.g. a
 * PEM private key stored whole as one `secrets:` value) cannot be caught by
 * a line-oriented buffer, because each of its lines becomes "complete" and
 * gets flushed out — checked and found not to match on its own — before the
 * rest of the value has even arrived. By the time later chunks complete the
 * value, the earlier lines are already gone and can never be retroactively
 * redacted. Holding back only as many trailing characters as the longest
 * configured value could still need (`holdbackSize`) catches both a
 * multi-line value and a single-line value split across an arbitrary chunk
 * boundary, uniformly, with no line-buffering at all.
 *
 * INVARIANT: `this.buffer` never holds more than a small, fixed amount of
 * text — `holdbackSize` plus whatever one chunk just added — no matter how
 * long the underlying stream is or how long a matched span has been open.
 * This is the core design change from an earlier revision, which retained
 * the ENTIRE raw span of a still-growing match (unbounded memory and
 * per-chunk work, both proportional to how long the match had been open —
 * confirmed quadratic: colliding periodic values fed one character at a
 * time cost 52/187/747ms at 2,000/4,000/8,000 characters). The key
 * realization: `***` is a fixed-size placeholder independent of match
 * length, so once a prefix of an open match is confirmed (nothing that has
 * arrived so far can ever retroactively need those exact characters back),
 * there is no reason to keep them just to eventually replace them with the
 * same literal `***` — `this.inOpenMatch` remembers only THAT a match is
 * open, not where its raw text was, and the small retained tail is enough
 * to keep recognizing further overlap without ever rescanning history.
 *
 * `redactChunk`/`flush` both drive `drain`, which repeatedly finds the
 * leftmost still-viable match, extends it to cover any other occurrence
 * (of any configured value, including a further occurrence of the same
 * one) that overlaps and reaches further via the shared
 * `extendMatchToFurthestOverlap` (`lib/redaction.ts`, also used by
 * `redactValues` — the durable-output redaction path had this exact
 * overlap gap too until both were fixed together, and must stay the one
 * place this algorithm lives), and only finalizes (`***`) a match whose
 * fully extended span ends before the unsafe tail — deferring anything
 * whose extended span still reaches that tail, since a not-yet-fully-arrived
 * overlapping value could still extend it further once more text shows up.
 * When deferring, `drain` retains only the trailing `holdbackSize`-ish
 * window of the (fully, uncappedly extended) match rather than the whole
 * span: everything before that window is provably done — extension used
 * ALL currently-arrived text, so nothing before `match.end - holdbackSize`
 * could still be the start of an occurrence that hasn't fully arrived
 * (such an occurrence's own span would already fit within arrived text,
 * so it would already have been found and merged). No collision analysis
 * between configured values is needed anywhere in this: the bound holds
 * unconditionally, for any configured value set.
 */
export class SecretValueRedactor {
  private readonly values: string[];
  private readonly structuredValues: string[];
  private readonly holdbackSize: number;
  private buffer = '';
  /**
   * The current line's not-yet-terminated tail, held ONLY while it could
   * still turn out to be a JSON document (see `assembleLines`). Plain text is
   * never held here, so ordinary step output keeps streaming at the cadence it
   * always did.
   */
  /**
   * The line being assembled, once it is large enough to leave memory.
   *
   * One store, two backings: identical semantics either way, so the choice can
   * never change what is accepted or emitted — only where the bytes sit.
   */
  private store: RecordStore | undefined;
  /** Bounded head and tail of a spilled line; every routing decision needs only these. */
  private spillHead = '';
  /**
   * The stored record's document shape, decided MONOTONICALLY over everything
   * appended to the store — not over `spillHead`.
   *
   * `spillHead` is a fixed-size boundary-probe window. A record whose first
   * few dozen characters were whitespace classified as `undecided` there and
   * was routed to the raw byte matcher, which found a configured `nABCDE…`
   * inside the serialized `\nABCDE…` escape and produced invalid JSON while
   * the step reported success. Each appended chunk is examined at most once,
   * and only until the first non-whitespace character decides the answer.
   */
  private spillShape: JsonDocumentStart = 'undecided';
  private spillTail = '';
  /** A spilled record's masked output, delivered asynchronously. */
  private completion: StoredLineCompletion | undefined;
  /**
   * Completions the host has claimed and not yet finished.
   *
   * A completion replays its record through the same raw matcher that new
   * lines use, and that matcher holds back the start of a configured value
   * until the text after it decides the match. Emitting a new line while a
   * replay is part way through releases that held start on its own, and the
   * rest of the value follows separately, unmasked. The host normally pauses
   * the child while a completion runs, but stopping a step resumes the pipes
   * so the child can reach EOF — so this has to be enforced here, not left to
   * the host's pause.
   */
  private runningCompletions = 0;
  /**
   * The store an UNCLAIMED completion owns. A claimed completion disposes its
   * own store; one that is never run — its step was cancelled first — would
   * otherwise leave the private file behind.
   */
  private completionStore: RecordStore | undefined;
  private pendingDrain: Promise<void> | undefined;
  /**
   * A finished stored record waiting for enough FOLLOWING text to decide
   * whether a configured value starts inside it and continues past its
   * terminator.
   *
   * The resident path has always waited for that context (`deferredLine`).
   * The stored path decided with whatever happened to be buffered when the
   * terminator arrived, so the same bytes masked or leaked depending only on
   * which backing they landed in — the one thing `record-store.ts` promises
   * the backing cannot change.
   */
  private deferredStore:
    | {
        store: RecordStore;
        terminator: string;
        head: string;
        tail: string;
        shape: JsonDocumentStart;
        raw: boolean;
      }
    | undefined;
  private readonly pendingSegments: string[] = [];
  /** Sum of `pendingSegments` lengths, maintained incrementally. */
  private pendingLength = 0;
  /** Leading segments already searched for a line break. */
  private pendingScannedSegments = 0;
  /** Memoized `pendingSegments.join('')`; cleared whenever a segment is added. */
  private pendingJoined: string | undefined = '';
  /**
   * True once part of the CURRENT line has already been released through
   * the raw matcher — the rest of that line must follow it there, or output
   * would be reordered.
   */
  private lineIsRaw = false;
  /**
   * A complete JSON line withheld because its own tail could begin a configured
   * multi-line value that continues past it. Emitting it structurally puts its
   * bytes out unmasked and appends its terminator outside the raw matcher, so
   * the occurrence would never be seen. Bounded: one line, which this class
   * already materialized, plus one lookahead window.
   */
  private deferredLine = '';
  /**
   * How far document-shape classification has examined the pending line, and
   * what it concluded.
   *
   * The answer is MONOTONE: every character examined before the first
   * non-whitespace one was whitespace, and once a non-whitespace character is
   * seen the shape is final. Re-running `classifyJsonDocumentStart` over the
   * whole buffer on every chunk made an all-whitespace prefix cost O(len) per
   * chunk — 287.6/1,091.9/4,182.9 ms for 16k/32k/64k one-character writes,
   * quadrupling per doubling. Both fields reset exactly where the pending line
   * resets, which is the only boundary at which the answer can change.
   */
  private pendingShape: JsonDocumentStart = 'undecided';
  /** Leading segments already examined by shape classification. */
  private pendingShapeSegments = 0;
  /** Values containing a newline, indexed by first character. Only these can
   * begin inside a line and continue past its terminator. */
  private readonly multilineByFirstChar = new Map<string, string[]>();
  private readonly multilineWindow: number;
  /**
   * True while a match has been confirmed to start but not yet finalized —
   * its raw prefix has already been trimmed from `this.buffer` (nothing
   * else could ever need those exact characters back), so `this.buffer`
   * holds only its still-relevant trailing window. The eventual single
   * `***` covers the whole logical match regardless of how many times its
   * retained window got trimmed while open.
   */
  private inOpenMatch = false;
  /**
   * Relative position within `this.buffer`, valid only while
   * `inOpenMatch`, where the open match's CONFIRMED span ends. Not always
   * `holdbackSize`: a match shorter than `holdbackSize` retains from its
   * own start (`keepFrom = match.start`, not `match.end - holdbackSize`),
   * which can pull in trailing text that arrived after the match's own end
   * but wasn't part of it — that trailing text must NOT be treated as
   * confirmed-match content on the next call, so its exact boundary is
   * tracked explicitly rather than assumed to be a fixed offset.
   */
  private openMatchConfirmedEnd = 0;
  /**
   * A raw child-process `stdout`/`stderr` 'data' Buffer boundary is not
   * guaranteed to align with a UTF-8 character boundary — a multi-byte
   * character can arrive split across two chunks. Decoding each chunk
   * independently via `Buffer#toString('utf8')` turns the split character
   * into a replacement character (U+FFFD) on each side, breaking any exact
   * string match that spans it and leaking the rest of the secret as raw
   * text `StringDecoder` holds back an
   * incomplete trailing multi-byte sequence across `write` calls instead of
   * emitting it as a replacement character, so a value split mid-character
   * is decoded correctly once the rest of it arrives.
   */
  private readonly decoder = new StringDecoder('utf8');
  /** String input holds a trailing high surrogate here until its partner arrives. */
  private readonly inputPairs = new SurrogatePairGuard();

  /**
   * A spilled record's masked output, once the host is ready to take it.
   *
   * `redactChunk` stays synchronous, so every existing caller is unaffected; a
   * record that had to spill reports its completion here. The host pauses that
   * pipe until it settles, which keeps output ordered and cannot deadlock —
   * replaying storage progresses without any further input.
   *
   * It emits in bounded pieces rather than resolving with the masked record.
   * Returning one string would rebuild, in the host, exactly the resident term
   * the store was introduced to remove.
   */
  takePendingCompletion(): StoredLineCompletion | undefined {
    const pending = this.completion;
    this.completion = undefined;
    this.completionStore = undefined;
    return pending;
  }

  /** True while any record is still owned by storage rather than emitted. */
  get hasStoredWork(): boolean {
    return (
      this.store !== undefined ||
      this.deferredStore !== undefined ||
      this.completion !== undefined
    );
  }

  /** Releases storage. Safe on every exit path, including abnormal. */
  async disposeStorage(): Promise<void> {
    const store = this.store;
    const deferred = this.deferredStore;
    const unclaimed = this.completionStore;
    this.store = undefined;
    this.deferredStore = undefined;
    this.completion = undefined;
    this.completionStore = undefined;
    this.spillHead = '';
    this.spillShape = 'undecided';
    this.spillTail = '';
    if (store) await store.dispose();
    // A record still waiting for context owns a store too; dropping the
    // reference without disposing it leaks the file on cancel and timeout.
    if (deferred) await deferred.store.dispose();
    if (unclaimed) await unclaimed.dispose();
  }

  /**
   * Every character this instance is holding, for the bounded-memory
   * assertions to read.
   *
   * It used to count only the raw matcher's holdback, the pending line and the
   * deferred line, while claiming to cover "everything this instance can be
   * holding" — so the one term that could actually grow, the record store's
   * resident text, was invisible to every assertion written against it.
   */
  get bufferedCharacterLength(): number {
    return (
      this.buffer.length +
      this.pendingLength +
      this.deferredLine.length +
      this.spillHead.length +
      this.spillTail.length +
      // The store's own resident text. Leaving it out reported zero while the
      // store held the whole record waiting for its file — a bound that was
      // not measuring the term it existed to bound.
      (this.store?.residentLength ?? 0) +
      (this.deferredStore?.store.residentLength ?? 0)
    );
  }

  constructor(
    values: readonly string[],
    private readonly spillAfterChars: number = RETAINED_LINE_SPILL_CHARS,
    private readonly createRecordStore: RecordStoreFactory = (
      after,
      label,
    ): RecordStore => new SpillingRecordStore(after, label),
  ) {
    // Expanded with each value's JSON-escaped form: this raw matcher runs
    // over an arbitrary, not-necessarily-JSON child-process byte stream
    // (see class doc comment), where a secret's real embedded newline may
    // already have been serialized to its two-character escape sequence
    // before this process saw a byte. `withJsonEscapedVariants` only adds
    // candidate substrings, so it can only redact more, never less. Output
    // that IS valid JSON never reaches this matcher at all — `emitLine`
    // below routes it to the structural redactor instead, which decodes
    // rather than guesses and so cannot corrupt the document.
    // Eligibility is decided ONCE, from each value's ORIGINAL form, before
    // expansion — the same rule `redactNormalizedText` documents. Filtering
    // after expansion instead would let JSON escaping promote a value that
    // was deliberately too short to qualify (`ab"cd`, five characters) into
    // a six-character escaped variant that matches, which is the opposite
    // of what the floor is for.
    this.values = Array.from(
      new Set(
        withJsonEscapedVariants(values.filter((value) => value.length >= 6)),
      ),
    ).sort((left, right) => right.length - left.length);
    // The structural path keeps the ORIGINAL values: it matches inside
    // decoded string tokens, where the raw configured value is exactly what
    // appears, and it applies the documented >= 6 eligibility floor to that
    // original form rather than to a longer escaped variant of a value that
    // was itself too short to qualify.
    let longestMultiline = 0;
    for (const value of this.values) {
      if (!value.includes('\n')) continue;
      longestMultiline = Math.max(longestMultiline, value.length);
      const first = value.charAt(0);
      const bucket = this.multilineByFirstChar.get(first);
      if (bucket) bucket.push(value);
      else this.multilineByFirstChar.set(first, [value]);
    }
    this.multilineWindow = longestMultiline === 0 ? 0 : longestMultiline - 1;
    this.structuredValues = Array.from(new Set(values));
    this.holdbackSize =
      this.values.length === 0 ? 0 : (this.values[0]?.length ?? 0) - 1;
  }

  redactChunk(chunk: Buffer | string): string {
    // A decoded Buffer never ends between the halves of a surrogate pair; a
    // string chunk can. Everything below may route the two halves differently
    // (one released through the raw matcher, the other appended to storage,
    // where it is encoded alone and reads back as U+FFFD), so a string caller
    // gets the same whole-pair chunks the decoder gives the host.
    const text =
      typeof chunk === 'string'
        ? this.inputPairs.take(chunk)
        : this.decoder.write(chunk);
    if (this.values.length === 0) return text;
    if (this.completionInProgress) {
      // Nothing after a stored record may be emitted before it, and nothing
      // may share the raw matcher with its replay. Held until it finishes;
      // the next chunk or `flush` assembles it.
      this.appendPending(text);
      return '';
    }
    return this.assembleLines(text, false);
  }

  /** True while a stored record's output is pending or being emitted. */
  get completionInProgress(): boolean {
    return this.completion !== undefined || this.runningCompletions > 0;
  }

  flush(): string {
    // `decoder.end()` resolves any trailing incomplete multi-byte sequence
    // left over from the very last `redactChunk` call — there is no further
    // data coming, so it is decoded now rather than held back forever.
    // A high surrogate still held here has no partner coming: it is released
    // as written, exactly as the host releases one at the end of a stream.
    const tail = this.inputPairs.flush() + this.decoder.end();
    if (this.values.length === 0) {
      const rest = this.pendingText() + tail;
      this.resetPending();
      return rest;
    }
    return this.assembleLines(tail, true);
  }

  /**
   * Splits the incoming stream into whole lines so a line that is itself a
   * complete JSON document can be masked structurally
   * (`redactJsonPreservingFormat`) instead of by raw substring match.
   *
   * The raw matcher is correct for arbitrary bytes but cannot be correct for
   * serialized JSON: it has no way to tell a secret that genuinely appears
   * in the data from one that coincidentally equals part of the document's
   * own syntax. Both halves of that are reproducible against the real durable
   * writer — a configured `nABCDE` splices into the `\n` escape
   * of `"\nABCDE"`, and a configured `","subtype":` splices across two
   * ordinary fields — each corrupting a record that never contained the
   * secret at all.
   *
   * Everything that is NOT a valid JSON line still goes through the raw
   * matcher, in stream order, byte for byte: plain-text and malformed-output
   * protection is unchanged, and so is its latency, because a partial line is
   * only ever held back when it could still become a JSON document
   * (`looksLikeJsonDocument`). Once a partial line has been released raw, the
   * rest of that line stays raw (`lineIsRaw`) so ordering can never break.
   */
  /**
   * Appends an arrived chunk without materializing the accumulated line.
   *
   * Small writes are coalesced into the open tail segment rather than each
   * becoming its own array entry: a child emitting one character at a time
   * would otherwise create one JS string object per character (a megabyte of
   * whitespace became a million-entry array, costing far more than the data).
   * Coalescing is only ever applied to a segment NEITHER scanner has examined,
   * so growing it in place cannot invalidate a cursor.
   */
  private appendPending(text: string): void {
    if (text.length === 0) return;
    const lastIndex = this.pendingSegments.length - 1;
    const last = this.pendingSegments[lastIndex];
    if (
      last !== undefined &&
      last.length < COALESCE_SEGMENT_CHARS &&
      lastIndex >= this.pendingScannedSegments &&
      lastIndex >= this.pendingShapeSegments
    ) {
      this.pendingSegments[lastIndex] = last + text;
    } else {
      this.pendingSegments.push(text);
    }
    this.pendingLength += text.length;
    this.pendingJoined = undefined;
  }

  /** Appends to storage, keeping the bounded head and tail the probes need. */
  private appendToStore(text: string): void {
    const store = this.store;
    if (!store) return;
    if (this.spillShape === 'undecided') {
      this.spillShape = classifyJsonDocumentStart(text);
      spawnedProcessWorkCounters.shapeCharsClassified += text.length;
    }
    const keep = this.multilineWindow + this.holdbackSize + 2;
    if (this.spillHead.length < keep)
      this.spillHead = (this.spillHead + text).slice(0, keep);
    this.spillTail = (this.spillTail + text).slice(-keep);
    // A saturated store is the ONE thing this may wait on: a store write
    // drains without any further input from the child, so pausing on it
    // cannot become the circular wait that pausing on retained size was.
    const accepted = store.append(text);
    // Creating the file is asynchronous, and until it exists every further
    // append lands in memory. That wait is the ONLY thing that makes the
    // threshold a bound, so it is published as backpressure exactly like a
    // saturated queue — and like a queue drain, it progresses without the
    // child writing anything more, so it cannot become a circular wait.
    const settling = store.settling();
    if ((accepted && !settling) || this.pendingDrain) return;
    const drain = settling
      ? settling.then(() => (accepted ? undefined : store.whenDrained()))
      : store.whenDrained();
    // Observed here too, so a drain the host never claims (the step ended
    // first) cannot surface as an unhandled rejection. The host still sees the
    // original promise's rejection and still fails the step on it.
    void drain.catch(() => undefined);
    this.pendingDrain = drain;
  }

  /**
   * A saturated store's drain, for the host to wait on. Also how a flush
   * failure reaches the step instead of being swallowed.
   */
  takePendingDrain(): Promise<void> | undefined {
    const pending = this.pendingDrain;
    this.pendingDrain = undefined;
    return pending;
  }

  /**
   * Moves already-SCANNED segments into storage.
   *
   * Only segments the newline search has passed move, so the search invariant
   * holds: everything left in `pendingSegments` is exactly what may still
   * contain a line break. Routing arriving text straight to storage instead
   * hides the terminator and the line never completes.
   */
  private moveScannedToStore(): void {
    if (this.pendingScannedSegments === 0) return;
    const moving = this.pendingSegments.splice(0, this.pendingScannedSegments);
    this.pendingScannedSegments = 0;
    this.pendingShapeSegments = 0;
    this.pendingJoined = undefined;
    let moved = 0;
    for (const segment of moving) moved += segment.length;
    this.pendingLength -= moved;
    this.store ??= this.createRecordStore(this.spillAfterChars, 'line');
    this.appendToStore(moving.join(''));
  }

  /**
   * Decides how a finished stored record must be emitted, then builds the work
   * that emits it.
   *
   * The decision happens HERE rather than inside the returned work because it
   * depends on state the caller is about to reset, and on the following text
   * the caller has just finished waiting for. Routing is the same question the
   * resident path answers in `emitLine`, asked with the same inputs.
   */
  private beginStoredCompletion(
    held: {
      store: RecordStore;
      terminator: string;
      head: string;
      tail: string;
      shape: JsonDocumentStart;
      raw: boolean;
    },
    following: string,
    trailing: string,
    final: boolean,
  ): void {
    const routeRaw =
      held.raw ||
      held.shape !== 'json' ||
      this.crossBoundaryMatchReaches(held.head) ||
      this.crossBoundaryFromLine(held.tail, following);
    this.completionStore = held.store;
    this.completion = async (emit: (text: string) => void): Promise<void> => {
      this.runningCompletions += 1;
      try {
        if (!routeRaw) {
          // The raw matcher's holdback is released just before the first
          // structural byte, exactly as `emitLine` does — and only then, so a
          // record that turns out not to be JSON still reaches the raw path
          // with its holdback intact.
          let drained = false;
          const structural = (text: string): void => {
            if (!drained) {
              drained = true;
              const carried = this.drainRaw(true);
              if (carried.length > 0) emit(carried);
            }
            emit(text);
          };
          const masked = await redactRecordFromSource(
            { chunks: () => held.store.replay() },
            this.structuredValues,
            structural,
          );
          if (masked) {
            if (!drained) {
              const carried = this.drainRaw(true);
              if (carried.length > 0) emit(carried);
            }
            emit(held.terminator);
            if (trailing.length > 0) emit(this.redactRaw(trailing));
            if (final) emit(this.drainRaw(true));
            return;
          }
        }
        for await (const chunk of held.store.replay())
          emit(this.redactRaw(chunk));
        emit(this.redactRaw(held.terminator));
        if (trailing.length > 0) emit(this.redactRaw(trailing));
        // Only at the end of the stream. Draining here unconditionally
        // released the record's tail before the continuation arrived, so a
        // value spanning the terminator could never complete — which is the
        // whole reason this record was routed raw. The resident path does not
        // drain between lines either; the holdback is the mechanism.
        if (final) emit(this.drainRaw(true));
      } finally {
        this.runningCompletions -= 1;
        await held.store.dispose();
      }
    };
  }

  /**
   * Hands a finished stored record to the completion, waiting first if a
   * configured value could begin inside it and continue past its terminator.
   *
   * Waiting is bounded by the longest configured multi-line value, and nothing
   * after the record may be emitted while it waits — the same two rules the
   * resident deferral follows.
   */
  private settleStoredRecord(final: boolean): void {
    const held = this.deferredStore;
    if (!held) return;
    if (!final && this.pendingLength < this.multilineWindow) return;
    this.deferredStore = undefined;
    const trailing = final ? this.pendingText() : '';
    if (final) this.resetPending();
    this.beginStoredCompletion(
      held,
      final ? trailing : this.pendingPrefix(this.multilineWindow),
      trailing,
      final,
    );
  }

  /** Drops everything pending. */
  private resetPending(): void {
    this.pendingSegments.length = 0;
    this.pendingLength = 0;
    this.pendingScannedSegments = 0;
    this.pendingShape = 'undecided';
    this.pendingShapeSegments = 0;
    this.pendingJoined = '';
  }

  /**
   * The pending line as one string.
   *
   * Deliberately NOT called per chunk. Holding the line as one growing string
   * and calling `indexOf` on it each time forced V8 to flatten the whole rope
   * every chunk — an O(n) copy per chunk, O(n^2) overall, which measured
   * 15.6/46.4/183.1/768.0 ms at 1/2/4/8 MiB while the chunk-list equivalent
   * measured 0.1/0.1/0.1/0.3 ms. The newline counter added earlier could not
   * see this because it counts offsets, not copies.
   */
  private pendingText(): string {
    if (this.pendingJoined === undefined) {
      this.pendingJoined = this.pendingSegments.join('');
      spawnedProcessWorkCounters.pendingCharsMaterialized +=
        this.pendingJoined.length;
    }
    return this.pendingJoined;
  }

  /**
   * A bounded prefix of the pending line.
   *
   * Boundary matching only ever needs a limited window past the line's end, so
   * building `line + pendingLine` to then slice a prefix out of it materialized
   * the entire buffer for a few characters of context.
   */
  private pendingPrefix(maxChars: number): string {
    if (maxChars >= this.pendingLength) return this.pendingText();
    let out = '';
    for (const segment of this.pendingSegments) {
      out += segment;
      if (out.length >= maxChars) break;
    }
    const prefix = out.length > maxChars ? out.slice(0, maxChars) : out;
    spawnedProcessWorkCounters.pendingCharsMaterialized += prefix.length;
    return prefix;
  }

  /** Incremental, monotone document-shape classification. See `pendingShape`. */
  private pendingDocumentShape(): JsonDocumentStart {
    if (this.pendingShape !== 'undecided') return this.pendingShape;
    // Only the not-yet-examined segments can change an 'undecided' answer: every
    // character before them was whitespace, and the classifier's answer for a
    // whitespace-only prefix followed by X is X's own answer. Resuming from a
    // SEGMENT cursor (not a character offset) also keeps this O(1) per chunk
    // when the child writes one character at a time.
    let examined = 0;
    while (this.pendingShapeSegments < this.pendingSegments.length) {
      const segment = this.pendingSegments[this.pendingShapeSegments] ?? '';
      const shape = classifyJsonDocumentStart(segment);
      examined += segment.length;
      if (shape !== 'undecided') {
        this.pendingShape = shape;
        break;
      }
      this.pendingShapeSegments += 1;
    }
    spawnedProcessWorkCounters.shapeCharsClassified += examined;
    return this.pendingShape;
  }

  private assembleLines(text: string, final: boolean): string {
    let output = '';
    this.appendPending(text);
    if (this.deferredStore) {
      // Nothing that follows a withheld record may be emitted before it, so
      // this returns either way: with the completion set, or still waiting.
      this.settleStoredRecord(final);
      return output;
    }
    if (this.deferredLine !== '') {
      const line = this.deferredLine;
      const haveContext = final || this.pendingLength >= this.multilineWindow;
      if (!haveContext) return output;
      this.deferredLine = '';
      // Bounded context: only the window a multi-line value could span is
      // needed, never the whole accumulated buffer.
      if (
        this.crossBoundaryFromLine(
          line,
          this.pendingPrefix(this.multilineWindow),
        )
      ) {
        // The value really does span: the raw matcher has to see the line whole
        // so the occurrence is masked. Masking outranks structural fidelity for
        // a line that genuinely carries a secret.
        output += this.redactRaw(line);
      } else {
        output += this.emitLine(line, true);
      }
    }
    // A line break cannot straddle two chunks, so only segments that have not
    // been searched yet can contain one. Searching the arriving chunk instead
    // of the accumulated string is what removes the per-chunk re-flatten.
    for (;;) {
      let found = -1;
      let foundSegment = -1;
      for (
        let index = this.pendingScannedSegments;
        index < this.pendingSegments.length;
        index += 1
      ) {
        const at = (this.pendingSegments[index] ?? '').indexOf('\n');
        if (at !== -1) {
          found = at;
          foundSegment = index;
          break;
        }
        this.pendingScannedSegments = index + 1;
      }
      if (found === -1) {
        // No terminator yet. Once the retained line crosses the threshold, move
        // the part already known to hold no line break into storage. Only
        // SCANNED segments move, so the newline search keeps seeing everything
        // that could still contain a terminator.
        if (
          this.pendingLength + (this.store?.length ?? 0) >=
          this.spillAfterChars
        )
          this.moveScannedToStore();
        break;
      }
      if (this.store) {
        // The line lives in storage. Move its remaining head there, hand the
        // whole record to the async completion, and stop: nothing after a
        // withheld line may be emitted before it — the same ordering rule the
        // deferred-line path uses.
        const segment = this.pendingSegments[foundSegment] ?? '';
        const upTo =
          this.pendingSegments.slice(0, foundSegment).join('') +
          segment.slice(0, found + 1);
        const terminator = upTo.endsWith('\r\n') ? '\r\n' : '\n';
        const body = upTo.slice(0, upTo.length - terminator.length);
        const remainder = [
          segment.slice(found + 1),
          ...this.pendingSegments.slice(foundSegment + 1),
        ].join('');
        if (body.length > 0) this.appendToStore(body);
        this.deferredStore = {
          store: this.store,
          terminator,
          head: this.spillHead,
          shape: this.spillShape,
          // WITH the terminator: a value that spans the line break has that
          // break inside it, and the resident path asks the same question with
          // the line's own terminator included. Leaving it out made every
          // newline-bearing value unfindable at exactly this boundary.
          tail: this.spillTail + terminator,
          raw: this.lineIsRaw,
        };
        this.pendingSegments.length = 0;
        this.pendingLength = 0;
        this.pendingScannedSegments = 0;
        this.pendingShape = 'undecided';
        this.pendingShapeSegments = 0;
        this.pendingJoined = '';
        this.store = undefined;
        this.spillHead = '';
        this.spillShape = 'undecided';
        this.spillTail = '';
        this.lineIsRaw = false;
        if (remainder.length > 0) this.appendPending(remainder);
        // Decide now if the remainder already carries enough context; if not,
        // the record waits for it exactly as a resident line would.
        this.settleStoredRecord(final);
        return output;
      }
      const segment = this.pendingSegments[foundSegment] ?? '';
      const head = this.pendingSegments.slice(0, foundSegment);
      head.push(segment.slice(0, found + 1));
      const line = head.join('');
      spawnedProcessWorkCounters.pendingCharsMaterialized += line.length;
      const remainder = this.pendingSegments.slice(foundSegment + 1);
      const tailOfSegment = segment.slice(found + 1);
      this.resetPending();
      if (tailOfSegment.length > 0) this.appendPending(tailOfSegment);
      for (const rest of remainder) this.appendPending(rest);
      output += this.closeLine(line, final);
      this.lineIsRaw = false;
      // Nothing after a withheld line may be emitted before it.
      if (this.deferredLine !== '') return output;
    }
    if (final) {
      if (this.store) {
        // A child that never writes a line break still wrote output. Reading
        // lines does not entitle a line reader to discard what it is holding
        // at EOF, and this branch used to ignore the store entirely — the
        // whole record vanished while the step reported success.
        const tail = this.pendingText();
        if (tail.length > 0) this.appendToStore(tail);
        const held = {
          store: this.store,
          terminator: '',
          head: this.spillHead,
          shape: this.spillShape,
          tail: this.spillTail,
          raw: this.lineIsRaw,
        };
        this.resetPending();
        this.store = undefined;
        this.spillHead = '';
        this.spillShape = 'undecided';
        this.spillTail = '';
        this.lineIsRaw = false;
        this.beginStoredCompletion(held, '', '', true);
        return output;
      }
      output += this.closeLine(this.pendingText(), true);
      this.resetPending();
      this.lineIsRaw = false;
      return output + this.drainRaw(true);
    }
    if (this.pendingLength === 0) return output;
    if (this.lineIsRaw) {
      // The rest of a line already released raw follows it there rather than
      // being retained, or this class's bounded-memory guarantee would depend
      // on the child eventually writing a newline.
      output += this.redactRaw(this.pendingText());
      this.resetPending();
      return output;
    }
    // Whitespace so far is UNDECIDED, not "not a document". Committing the
    // line to the raw matcher on the strength of a leading space is what
    // corrupted an otherwise ordinary record when a child wrote the
    // whitespace and the record in two separate writes.
    const shape = this.pendingDocumentShape();
    if (shape === 'other') {
      output += this.redactRaw(this.pendingText());
      this.resetPending();
      this.lineIsRaw = true;
      return output;
    }
    if (shape === 'undecided') {
      // Whitespace so far is undecided, not decided-no — but "undecided" must
      // not mean "retain forever". A child that writes nothing but spaces can
      // otherwise grow this buffer without limit, which is the same unbounded
      // state the cap exists to prevent. Release it through the raw matcher
      // once it reaches the cap, and deliberately do NOT latch `lineIsRaw`:
      // the released text is whitespace only, so the only configured value
      // that could span from it into the record that follows would have to
      // contain that record's own opening syntax — the coincidental collision
      // this module deliberately leaves unmasked. Latching instead is exactly
      // the bug that corrupted a record after a leading space.
      if (this.pendingLength >= MAX_UNDECIDED_WHITESPACE_CHARS) {
        output += this.redactRaw(this.pendingText());
        this.resetPending();
      }
      return output;
    }
    return output;
  }

  /** Finishes whichever path the current line is on. */
  private closeLine(line: string, final: boolean): string {
    return this.lineIsRaw ? this.redactRaw(line) : this.emitLine(line, final);
  }

  /**
   * True when a configured value GENUINELY spans from the text the raw
   * matcher is still holding into `nextText` — resolved, not guessed.
   *
   * Answering the weaker question — "could the retained holdback be the opening
   * of SOME multi-line value?" — is not sufficient. A possible prefix is not a
   * match, and treating it as one poisons every later line:
   *
   * - It routes a SEPARATE, complete JSON document through the byte matcher
   *  merely because the previous line happened to end with a value's first
   *  line. A configured `nABCDE` then splices the `n` out of that document's
   *  own `\n` escape and produces `"\***"`, which no longer parses.
   * - It gates the over-cap branch, so the cap never engages and retention
   *  grows with the input — 8,000,021 characters against a 1,000,000 cap in
   *  the reproduction.
   *
   * Values are bounded, so the question is answerable with bounded lookahead:
   * a value that starts inside the holdback must finish within its own length
   * of the boundary. One `indexOf` per value over that window settles it. A
   * real continuation still routes raw, because masking a genuine occurrence
   * outranks preserving the shape of output that was never a document; a
   * prefix that does not continue releases the holdback and lets the line be
   * treated as the document it is.
   */
  private crossBoundaryMatchReaches(nextText: string): boolean {
    if (this.values.length === 0) return false;
    // Nothing retained means nothing can span into `nextText`.
    if (this.buffer.length === 0 && !this.inOpenMatch) return false;
    spawnedProcessWorkCounters.boundaryProbes += 1;
    const boundary = this.buffer.length;
    const probe = this.buffer + nextText.slice(0, this.holdbackSize + 1);
    for (const value of this.values) {
      // A crossing occurrence cannot start earlier than this, so the search
      // window — and therefore the work — is bounded by the longest value.
      const from = Math.max(0, boundary - value.length + 1);
      const index = probe.indexOf(value, from);
      if (index !== -1 && index < boundary) return true;
    }
    return false;
  }

  /**
   * True when some suffix of `line` is a proper prefix of a configured value
   * that contains a newline — i.e. a value could begin inside this line and
   * continue past its terminator.
   *
   * Only newline-bearing values are considered, because the line ends with its
   * own terminator: any occurrence that reaches past it must contain that
   * newline. That makes this a no-op for the common case of single-line secrets
   * and keeps the work bounded by the longest multi-line value rather than by
   * the output.
   */
  private tailMayStartMultilineValue(line: string): boolean {
    if (this.multilineWindow === 0) return false;
    spawnedProcessWorkCounters.boundaryProbes += 1;
    const window = Math.min(line.length, this.multilineWindow);
    for (let offset = 1; offset <= window; offset += 1) {
      const start = line.length - offset;
      const candidates = this.multilineByFirstChar.get(line.charAt(start));
      if (!candidates) continue;
      const suffix = line.slice(start);
      for (const value of candidates) {
        if (value.length > suffix.length && value.startsWith(suffix))
          return true;
      }
    }
    return false;
  }

  /**
   * True when a configured value genuinely begins inside `line` and completes
   * within `following` — the mirror of `crossBoundaryMatchReaches`, for the
   * direction where the retained context is a line we have not emitted yet.
   */
  private crossBoundaryFromLine(line: string, following: string): boolean {
    if (this.values.length === 0) return false;
    spawnedProcessWorkCounters.boundaryProbes += 1;
    const boundary = Math.min(line.length, this.multilineWindow + 1);
    const probe =
      line.slice(line.length - boundary) +
      following.slice(0, this.multilineWindow + 1);
    for (const value of this.values) {
      const from = Math.max(0, boundary - value.length + 1);
      const index = probe.indexOf(value, from);
      if (index !== -1 && index < boundary) return true;
    }
    return false;
  }

  /**
   * Masks one whole line, preferring the structural path. Anything the raw
   * matcher is still holding back from EARLIER output is released first, so
   * a structurally-masked line can never jump ahead of text that preceded
   * it.
   *
   * Releasing that holdback is only safe once nothing retained could still
   * begin a configured multi-line value. Releasing it unconditionally is NOT
   * safe: the argument that a value spanning the newline would have to
   * continue into JSON syntax or an escape assumes the following line belongs
   * to the same document, which is not true of arbitrary custom-action stdout
   * that merely happens to contain a JSON-shaped line.
   * `crossBoundaryFromLine` checks instead of assuming.
   */
  private emitLine(line: string, final: boolean): string {
    if (line.length === 0) return '';
    let body = line;
    let terminator = '';
    if (body.endsWith('\n')) {
      body = body.slice(0, -1);
      terminator = '\n';
      if (body.endsWith('\r')) {
        body = body.slice(0, -1);
        terminator = '\r\n';
      }
    }
    // Plain text goes to the raw matcher regardless, and that is where a
    // cross-line match resolves naturally — so it never pays for the boundary
    // probe. Ordinary log output was costing 20-430x more per line than it
    // needed to because the scan ran before this check rather than after it.
    if (classifyJsonDocumentStart(body) !== 'json') return this.redactRaw(line);
    // A REAL occurrence outranks the shape of the output it appears in. The
    // forward context is everything buffered after this line, not just the line,
    // because a multi-line value can span a whole JSON line and land in the one
    // after it.
    // Bounded: `crossBoundaryMatchReaches` slices at most `holdbackSize + 1`
    // characters past the boundary, so concatenating the entire pending buffer
    // materialized megabytes to read a few dozen characters.
    const forward = line + this.pendingPrefix(this.holdbackSize + 1);
    if (
      // A value that begins in retained holdback and reaches into this line...
      this.crossBoundaryMatchReaches(forward) ||
      // ...or one that begins inside this line and completes after it. The
      // second direction was missing entirely: the line's own terminator is
      // appended outside the raw matcher, so an occurrence starting at or
      // inside this line was never looked for.
      this.crossBoundaryFromLine(line, this.pendingPrefix(this.multilineWindow))
    )
      return this.redactRaw(line);
    // Emitting structurally releases this line's bytes AND appends its
    // terminator outside the raw matcher, so a value that begins in this line
    // and continues past it would never be seen. If that is possible, hold the
    // line until there is enough context to decide. At `final` nothing more can
    // arrive, so nothing can span and there is nothing to wait for.
    // "Enough context" is about text that FOLLOWS the candidate, so the two
    // directions need different amounts. For a value starting inside this line
    // the line itself is not context — only `pendingLine` is; counting the line
    // let a long line be emitted with no following text at all, releasing the
    // very bytes that needed masking.
    const undecidedFromLine =
      this.pendingLength < this.multilineWindow &&
      this.tailMayStartMultilineValue(line);
    const undecidedFromHoldback =
      forward.length < this.multilineWindow + 1 &&
      this.tailMayStartMultilineValue(this.buffer);
    if (!final && (undecidedFromLine || undecidedFromHoldback)) {
      // Waiting is the only safe answer: emitting now releases bytes we may
      // still have to mask, and they cannot be recalled.
      this.deferredLine = line;
      return '';
    }
    const structured = redactJsonPreservingFormat(body, this.structuredValues);
    if (structured === null) return this.redactRaw(line);
    return this.drainRaw(true) + structured + terminator;
  }

  private redactRaw(text: string): string {
    if (text.length === 0) return '';
    this.buffer += text;
    return this.drain(false);
  }

  private drainRaw(final: boolean): string {
    if (this.buffer.length === 0 && !this.inOpenMatch) return '';
    return this.drain(final);
  }

  /**
   * Emits everything from `this.buffer` that can be safely decided right
   * now, leaving only a small, bounded remainder in `this.buffer` for next
   * time (or, at `final`, emitting everything since no more text can ever
   * arrive). See the class docstring for the safety argument.
   */
  private drain(final: boolean): string {
    let cursor = 0;
    let output = '';
    let deferred = false;
    // Per-value "next occurrence at/after N" cache, built ONCE for this
    // whole `drain` call and queried with a non-decreasing `from` per value
    // throughout (the outer search below always starts at `cursor`, which
    // only ever grows; `extendMatchToFurthestOverlap`'s own retiring loop
    // only advances). This is what keeps a configured value that never
    // occurs in `this.buffer` at all cheap: one remaining-length `indexOf`
    // miss for the whole call, not one per match found elsewhere — a value
    // rebuilding this cache (or resetting `from` to 0) on every match found
    // would reopen that quadratic cost, confirmed by measurement (a
    // dense-match/absent-values case went from under 500ms to ~48s).
    const nextIndexCache = new Map<
      string,
      { index: number; searchedFrom: number }
    >();
    const nextIndexAtOrAfter = (value: string, from: number): number => {
      const cached = nextIndexCache.get(value);
      if (cached && from >= cached.searchedFrom) {
        if (cached.index === -1) return -1;
        if (cached.index >= from) return cached.index;
      }
      const found = this.buffer.indexOf(value, from);
      nextIndexCache.set(value, { index: found, searchedFrom: from });
      return found;
    };

    for (;;) {
      let match: { start: number; end: number } | null;
      if (this.inOpenMatch) {
        // Continuing a match left open by the PREVIOUS `redactChunk`/`flush`
        // call: `cursor` is still 0 here, and `this.openMatchConfirmedEnd`
        // (computed when this match was last deferred) is exactly where its
        // confirmed span ends within the current buffer — seed extension
        // there directly, no per-value search needed to "rediscover" what
        // is already known.
        match = { start: cursor, end: this.openMatchConfirmedEnd };
      } else {
        match = null;
        for (const value of this.values) {
          const start = nextIndexAtOrAfter(value, cursor);
          if (start === -1) continue;
          if (match === null || start < match.start) {
            match = { start, end: start + value.length };
          }
        }
        if (match === null) break;
      }

      const boundary = final
        ? this.buffer.length
        : Math.max(0, this.buffer.length - this.holdbackSize);

      // `match.start` itself can be within the risk zone (the last
      // `holdbackSize`-ish characters of currently-arrived text): a
      // DIFFERENT, longer, earlier-starting value could still be
      // not-yet-fully-arrived there, and emitting `[cursor, match.start)`
      // as raw text now would permanently discard the prefix it needs once
      // it does arrive — confirmed by differential fuzzing against
      // `redactValues`. Treat this exactly like no match being found yet:
      // defer to the tail logic below, which only ever releases up to the
      // same safe `boundary`. `inOpenMatch` (if already true) is left
      // untouched, so a continuation just keeps waiting for more text.
      if (!this.inOpenMatch && match.start >= boundary) break;

      match = extendMatchToFurthestOverlap(
        this.values,
        match,
        nextIndexAtOrAfter,
      );

      if (match.end > boundary) {
        // Can't yet decide the true final extent — a not-yet-fully-arrived
        // overlapping value could still extend it once more text shows up.
        // `final` never reaches here: `match.end <= this.buffer.length`
        // always (extension only uses currently-arrived text), and at
        // `final`, `boundary === this.buffer.length`. `match.start` is
        // already confirmed `< boundary` above, so the prefix before it is
        // genuinely safe to release now.
        if (!this.inOpenMatch) {
          output += this.buffer.slice(cursor, match.start);
        }
        this.inOpenMatch = true;
        // Safe to advance the cursor to only `holdbackSize` before the
        // confirmed end: everything before that is fully covered by
        // CONFIRMED occurrences (extension used all currently-arrived text
        // to find `match.end`), so it can never be the not-yet-complete
        // start of anything still arriving — such an occurrence would
        // already fit within arrived text and already be merged in. When
        // the match itself is shorter than `holdbackSize`, this retains
        // from `match.start` instead (nothing earlier to keep), which can
        // pull in trailing text that arrived after `match.end` but isn't
        // part of the match — `openMatchConfirmedEnd` records exactly where
        // the match's own confirmed span ends within the retained slice, so
        // that trailing text is never mistaken for confirmed-match content.
        cursor = retreatFromSurrogateSplit(
          this.buffer,
          Math.max(match.start, match.end - this.holdbackSize),
        );
        this.openMatchConfirmedEnd = match.end - cursor;
        deferred = true;
        break;
      }

      output += this.inOpenMatch
        ? '***'
        : this.buffer.slice(cursor, match.start) + '***';
      this.inOpenMatch = false;
      cursor = match.end;
      // Loop again: more matches may remain later in the buffer.
    }

    if (!deferred) {
      if (final) {
        output += this.buffer.slice(cursor);
        cursor = this.buffer.length;
      } else if (!this.inOpenMatch) {
        const safeEnd = retreatFromSurrogateSplit(
          this.buffer,
          Math.max(cursor, this.buffer.length - this.holdbackSize),
        );
        output += this.buffer.slice(cursor, safeEnd);
        cursor = safeEnd;
      }
    }
    // Single physical trim for the whole call — never re-sliced mid-loop,
    // which is what keeps the cache above valid throughout.
    this.buffer = this.buffer.slice(cursor);
    return output;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseAgentTerminalResultLine(
  line: string,
): AgentTerminalResultStatus | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.type !== 'result') return undefined;

  const subtype =
    typeof parsed.subtype === 'string' ? parsed.subtype : undefined;
  if (subtype) return subtype === 'success' ? 'success' : 'failure';
  return parsed.is_error === false ? 'success' : 'failure';
}

async function readOutputMap(
  filePath: string,
): Promise<Record<string, string>> {
  try {
    return parseOutputFile(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return {};
    throw error;
  }
}

export async function runSpawnedProcessLocally(
  processSpec: SpawnedProcessSpec,
  options: LocalSpawnedProcessOptions,
): Promise<SpawnedProcessResult> {
  if (options.signal.aborted) {
    return {
      status: 'cancelled',
      conclusion: 'cancelled',
      outcome: 'cancelled',
      outputs: {},
      dynamic_env: {},
      log_file: options.logFile,
    };
  }

  return new Promise((resolve) => {
    const logStream = fs.createWriteStream(options.logFile, { flags: 'a' });
    const logStreamFinished = finished(logStream);
    let settled = false;
    let timedOut = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let resolveProcessCleanup: (() => void) | undefined;
    let agentTerminalTimer: NodeJS.Timeout | undefined;
    let agentTerminalLineBuffer = '';
    const timers: { timeout?: NodeJS.Timeout } = {};
    let child: ReturnType<typeof spawn> | undefined;
    let resourceHandle: { unregister(): void } | null = null;
    const spillAfterChars =
      options.spillAfterChars ?? RETAINED_LINE_SPILL_CHARS;
    const stdoutRedactor = new SecretValueRedactor(
      options.secretValues ?? [],
      spillAfterChars,
      options.createRecordStore,
    );
    const stderrRedactor = new SecretValueRedactor(
      options.secretValues ?? [],
      spillAfterChars,
      options.createRecordStore,
    );
    let redactionFailure: Error | undefined;
    /**
     * Runs redaction so a failure becomes THIS step's failure.
     *
     * Letting it escape a `data` callback or the finalize flush takes the host
     * down — in the shared utility process that fails every concurrent request,
     * not just the responsible step. Continuing past it would release unmasked
     * output. So the failure is recorded, the child is stopped, and nothing more
     * is written.
     */
    /**
     * Pauses the child's streams while the log write queue is saturated and
     * resumes on drain. Retention for a line being assembled is O(line); this
     * keeps a fast producer from also growing the queued-write set on top of it,
     * and keeps bulk writing off the event loop's critical path.
     */
    /**
     * Independent pause reasons over one pair of pipes.
     *
     * The log sink draining must not resume a child another reason still needs
     * held — the previous single-flag version let one drain callback override a
     * different, still-saturated queue. A child resumes only when NO reason
     * holds it.
     */
    const pauseReasons = new Set<string>();
    /**
     * Set once the step is being STOPPED (cancelled or past its deadline).
     *
     * A paused pipe never reaches EOF, so the child's `close` never fires —
     * and a pipe paused on a stalled `mkdtemp` stayed paused until the
     * filesystem answered, holding a cancelled step open indefinitely. Once
     * terminating, every hold is released and further holds are ignored: the
     * only reader that matters now is the one draining the pipe to EOF.
     */
    let terminating = false;
    const beginTermination = (): void => {
      terminating = true;
      pauseReasons.clear();
      child?.stdout?.resume();
      child?.stderr?.resume();
    };
    const holdChild = (reason: string): void => {
      if (terminating) return;
      pauseReasons.add(reason);
      child?.stdout?.pause();
      child?.stderr?.pause();
    };
    const releaseChild = (reason: string): void => {
      pauseReasons.delete(reason);
      if (pauseReasons.size > 0) return;
      child?.stdout?.resume();
      child?.stderr?.resume();
    };
    /**
     * Every output site goes through this.
     *
     * Each write is encoded to UTF-8 on its own, so a surrogate pair split
     * across two writes reached the saved file as two replacement characters
     * while concatenating the live fragments still looked perfect. Holding a
     * trailing lone high surrogate back until the next write keeps both copies
     * correct AND identical.
     */
    const pairGuards: Record<'stdout' | 'stderr', SurrogatePairGuard> = {
      stdout: new SurrogatePairGuard(),
      stderr: new SurrogatePairGuard(),
    };
    /**
     * Set when the step settles. Storage work that outlives a cancelled or
     * timed-out step is still owned and still cleaned up, but none of it may
     * reach the output of a step whose caller has already been answered.
     */
    let outputSealed = false;
    /** Stored completions currently emitting, per stream. */
    const storedInFlight: Record<'stdout' | 'stderr', number> = {
      stdout: 0,
      stderr: 0,
    };
    /**
     * Streams whose output ends at a stored record because the step is being
     * stopped while that record is still owned by storage.
     *
     * Stopping resumes the pipes so the child can reach EOF, and the redactor
     * holds everything that arrives behind an unfinished stored record. That
     * hold must not grow for as long as a slow replay or a child ignoring
     * SIGTERM keeps it going, and the finalizer already ends such a stream at
     * the record boundary. Deciding it here, once, keeps the two consistent:
     * nothing after the record is published, however the timing falls.
     */
    const endedAtRecord: Record<'stdout' | 'stderr', boolean> = {
      stdout: false,
      stderr: false,
    };
    const acceptsOutput = (
      stream: 'stdout' | 'stderr',
      redactor: SecretValueRedactor,
    ): boolean => {
      if (outputSealed || endedAtRecord[stream]) return false;
      if (
        terminating &&
        (storedInFlight[stream] > 0 ||
          redactor.completionInProgress ||
          redactor.hasStoredWork)
      ) {
        endedAtRecord[stream] = true;
        return false;
      }
      return true;
    };
    const writeOut = (stream: 'stdout' | 'stderr', text: string): void => {
      if (outputSealed || text.length === 0) return;
      const safe = pairGuards[stream].take(text);
      if (safe.length === 0) return;
      applyOutputBackpressure(logStream.write(safe));
      options.onOutput?.(stream, safe);
      applyGateBackpressure();
    };
    /** Releases a genuinely unpaired trailing surrogate at the very end. */
    const flushPairGuards = (): void => {
      for (const stream of ['stdout', 'stderr'] as const) {
        const trailing = pairGuards[stream].flush();
        if (trailing.length === 0) continue;
        logStream.write(trailing);
        options.onOutput?.(stream, trailing);
      }
    };
    let gateHeld = false;
    const applyGateBackpressure = (): void => {
      const gate = options.outputGate;
      if (!gate || !child || gateHeld || !gate.congested()) return;
      gateHeld = true;
      holdChild('output-gate');
      gate.onceDrained(() => {
        gateHeld = false;
        releaseChild('output-gate');
      });
    };
    let logSinkHeld = false;
    const applyOutputBackpressure = (queueAccepted: boolean): void => {
      // Attach at most ONE drain listener while the sink is held. A record
      // that emits in many pieces produces many refused writes before a single
      // drain fires, and one listener per refusal accumulated them on the log
      // stream (a MaxListenersExceededWarning, and a growing callback list).
      if (queueAccepted || !child || logSinkHeld) return;
      logSinkHeld = true;
      holdChild('log-sink');
      logStream.once('drain', () => {
        logSinkHeld = false;
        releaseChild('log-sink');
      });
    };
    /**
     * Delivers a stored record's masked output in order.
     *
     * The pipes are held until the replay resolves, which keeps output ordered
     * AND cannot deadlock: replaying storage progresses without further input,
     * unlike the retained-line pause this replaces.
     */
    /**
     * In-flight stored drains, so finalization waits for them.
     *
     * Without this the write raced `logStream.end()`: the data handler had
     * already CLAIMED the completion, so the finalizer's own sweep found
     * nothing to wait for, and a record that resolved after the stream closed
     * was silently dropped — a whole record of output lost with a `success`
     * result.
     */
    let storedDrains: Promise<void> = Promise.resolve();
    /** When the step's declared budget ends; finalization still honours it. */
    let deadlineAt = Number.POSITIVE_INFINITY;
    /**
     * Waits for a saturated record store to drain before letting the child
     * write more, and turns a storage-write failure into THIS step's failure.
     */
    const drainStorageWrites = (
      redactor: SecretValueRedactor,
      stream: 'stdout' | 'stderr',
    ): void => {
      const pending = redactor.takePendingDrain();
      if (!pending) return;
      const reason = `storage-${stream}`;
      holdChild(reason);
      const settle = pending
        .catch((error: unknown) => {
          redactionFailure ??=
            error instanceof Error ? error : new Error(String(error));
        })
        .finally(() => {
          releaseChild(reason);
        });
      storedDrains = storedDrains.then(() => settle);
    };
    const drainStored = (
      redactor: SecretValueRedactor,
      stream: 'stdout' | 'stderr',
    ): void => {
      drainStorageWrites(redactor, stream);
      const pending = redactor.takePendingCompletion();
      if (!pending) return;
      const reason = `stored-${stream}`;
      holdChild(reason);
      storedInFlight[stream] += 1;
      const settle = pending((text) => {
        writeOut(stream, text);
      })
        .catch((error: unknown) => {
          // A storage or transformation failure fails THIS step through the
          // existing precedence; it never degrades to unprocessed output.
          redactionFailure ??=
            error instanceof Error ? error : new Error(String(error));
        })
        .finally(() => {
          storedInFlight[stream] -= 1;
          releaseChild(reason);
        });
      // Declared before it is chained. `.then` callbacks run on a later
      // microtask, so the previous order was not a live defect — but it read
      // as one, and a future refactor that inlined the chain would make it one.
      storedDrains = storedDrains.then(() => settle);
    };
    const guardRedaction = (redact: () => string): string => {
      if (redactionFailure) return '';
      try {
        return redact();
      } catch (error) {
        redactionFailure =
          error instanceof Error ? error : new Error(String(error));
        // Only a child that is still RUNNING gets escalated. The final flush
        // happens inside `finalize`, which runs after `child.on('close')` has
        // already cleared the force-kill timer — so a failure there armed a
        // fresh 5-second timer that nothing would ever clear. It held the
        // event loop open past the end of the step (jest's delayed-exit
        // warning) and then sent SIGKILL to an exited process group, which is
        // a recycled-PID hazard rather than a no-op.
        if (child && child.exitCode === null && child.signalCode === null) {
          killChildProcessGroup(child, 'SIGTERM');
          scheduleForceKill(child);
        }
        return '';
      }
    };
    const completeProcessCleanup = (): void => {
      resolveProcessCleanup?.();
      resolveProcessCleanup = undefined;
    };
    const beginProcessCleanup = (): void => {
      if (resolveProcessCleanup) return;
      const cleanup = new Promise<void>((resolve) => {
        resolveProcessCleanup = resolve;
      });
      options.onProcessCleanup?.(cleanup);
    };
    const scheduleForceKill = (
      target: ReturnType<typeof spawn>,
      forceKillOptions?: { unref?: boolean },
    ): void => {
      if (forceKillTimer) return;
      beginProcessCleanup();
      forceKillTimer = setTimeout(() => {
        forceKillTimer = undefined;
        killChildProcessGroup(target, 'SIGKILL');
        completeProcessCleanup();
      }, FORCE_KILL_DELAY_MS);
      if (forceKillOptions?.unref) forceKillTimer.unref?.();
    };

    const onAbort = (): void => {
      if (!child) return;
      beginTermination();
      killChildProcessGroup(child, 'SIGTERM');
      scheduleForceKill(child);
    };

    const finalize = async (
      partial: Omit<
        SpawnedProcessResult,
        'outputs' | 'dynamic_env' | 'log_file'
      >,
      finalizeOptions?: FinalizeProcessOptions,
    ): Promise<void> => {
      if (settled) return;
      settled = true;
      if (timers.timeout) clearTimeout(timers.timeout);
      if (forceKillTimer && !finalizeOptions?.preserveForceKillTimer) {
        clearTimeout(forceKillTimer);
        forceKillTimer = undefined;
        completeProcessCleanup();
      }
      if (agentTerminalTimer) clearTimeout(agentTerminalTimer);
      options.signal.removeEventListener('abort', onAbort);
      child?.stdout?.unpipe(logStream);
      child?.stderr?.unpipe(logStream);
      // A step that is being STOPPED settles without waiting on storage; a step
      // that finished normally waits for every byte — but never past its own
      // deadline or a cancellation, because a filesystem call that does not
      // return must not hold the caller forever. Either way the storage stays
      // owned: whatever is not awaited here is tracked and cleaned up late.
      let abandon =
        partial.status === 'cancelled' || timedOut || options.signal.aborted;
      let abandonedAs: 'cancelled' | 'timeout' | undefined;
      let stopWatching: () => void = () => undefined;
      const abandonment = new Promise<'cancelled' | 'timeout'>((resolve) => {
        const onCancel = (): void => {
          resolve('cancelled');
        };
        options.signal.addEventListener('abort', onCancel, { once: true });
        const budget = setTimeout(
          () => {
            resolve('timeout');
          },
          Math.max(0, Math.min(deadlineAt - Date.now(), 2_147_483_647)),
        );
        stopWatching = (): void => {
          clearTimeout(budget);
          options.signal.removeEventListener('abort', onCancel);
        };
      });
      const untilAbandoned = async (
        work: Promise<unknown>,
      ): Promise<boolean> => {
        if (abandon) return false;
        const winner = await Promise.race([
          work.then(
            () => 'done' as const,
            () => 'done' as const,
          ),
          abandonment,
        ]);
        if (winner === 'done') return true;
        abandon = true;
        abandonedAs = winner;
        return false;
      };
      const streams = [
        [stdoutRedactor, 'stdout'],
        [stderrRedactor, 'stderr'],
      ] as const;
      // A stored record still in flight must land BEFORE the final flush, or
      // its bytes would follow the tail that comes after them.
      const sweepStoredRecords = async (): Promise<void> => {
        for (const [redactor, stream] of streams) {
          if (abandon) return;
          const pending = redactor.takePendingCompletion();
          if (!pending) continue;
          storedInFlight[stream] += 1;
          const run = pending((text) => {
            writeOut(stream, text);
          })
            .catch((error: unknown) => {
              // A failure after the step settled cannot change its result;
              // before that, it fails the step like any masking failure.
              if (abandon) return;
              redactionFailure ??=
                error instanceof Error ? error : new Error(String(error));
            })
            .finally(() => {
              storedInFlight[stream] -= 1;
            });
          if (!(await untilAbandoned(run))) trackLateStorageCleanup(run);
        }
      };
      // Any drain already in flight must land BEFORE the final flush, or its
      // bytes would be written after `logStream.end()` and silently dropped.
      if (await untilAbandoned(storedDrains.catch(() => undefined)))
        // Records finished during the run land before the tail that follows
        // them...
        await sweepStoredRecords();
      for (const [redactor, stream] of streams) {
        // A stream whose record is still owned by storage cannot have its
        // tail emitted without that record, so a stopped step ends its output
        // at the record boundary instead of publishing bytes out of order.
        if (
          abandon &&
          (endedAtRecord[stream] ||
            storedInFlight[stream] > 0 ||
            redactor.hasStoredWork)
        )
          continue;
        writeOut(
          stream,
          guardRedaction(() => redactor.flush()),
        );
      }
      // ...and `flush()` itself finishes the record a child left unterminated,
      // so its completion has to be swept too. Sweeping only before the flush
      // dropped that record entirely while the step reported success.
      await sweepStoredRecords();
      if (!abandon) flushPairGuards();
      outputSealed = true;
      logStream.end();
      try {
        await logStreamFinished;
      } catch {
        // Preserve the original process result even if flushing the log fails.
      }
      // Storage is released on every exit path — success, failure,
      // cancellation, timeout and abnormal child exit. A disposal still waiting
      // on uninterruptible filesystem work is tracked rather than awaited past
      // the caller's cancellation or deadline.
      const disposal = Promise.all([
        storedDrains.catch(() => undefined),
        stdoutRedactor.disposeStorage(),
        stderrRedactor.disposeStorage(),
      ]);
      trackLateStorageCleanup(disposal);
      if (!abandon) await Promise.race([disposal, abandonment]);
      stopWatching();
      if (abandonedAs === 'timeout')
        partial = {
          ...partial,
          status: 'failure',
          conclusion: 'failure',
          outcome: 'failure',
          error: `Step timed out after ${options.timeout_minutes} minute(s)`,
        };
      else if (abandonedAs === 'cancelled')
        partial = {
          ...partial,
          status: 'cancelled',
          conclusion: 'cancelled',
          outcome: 'cancelled',
        };
      resourceHandle?.unregister();

      let outputs: Record<string, string> = {};
      let dynamic_env: Record<string, string> = {};
      /** A real (non-ENOENT) failure to read the declared output/env maps. */
      let outputReadFailure: Error | undefined;
      try {
        [outputs, dynamic_env] = await Promise.all([
          readOutputMap(options.outputFile),
          readOutputMap(options.envFile),
        ]);
      } catch (error) {
        outputs = {};
        dynamic_env = {};
        outputReadFailure =
          error instanceof Error ? error : new Error(String(error));
      }
      // Precedence, because this catch used to return BEFORE the redaction
      // check and so could report success for a step whose output was never
      // masked as promised: a broken masking promise outranks an unreadable
      // output map, since output may already have been streamed. Either one
      // fails the step; neither may report success. A cancelled step stays
      // cancelled and carries the reason instead of being relabelled.
      const requiredFailure = redactionFailure ?? outputReadFailure;
      if (requiredFailure) {
        resolve({
          ...partial,
          status: partial.status === 'cancelled' ? 'cancelled' : 'failure',
          exit_code: partial.exit_code ?? 1,
          error: requiredFailure.message,
          outputs,
          dynamic_env,
          log_file: options.logFile,
        });
        return;
      }
      resolve({
        ...partial,
        outputs,
        dynamic_env,
        log_file: options.logFile,
      });
    };

    const scheduleAgentTerminalWatchdog = (
      status: AgentTerminalResultStatus,
    ): void => {
      if (
        !child ||
        settled ||
        agentTerminalTimer ||
        options.agentTerminalResultGraceMs === undefined
      ) {
        return;
      }
      agentTerminalTimer = setTimeout(() => {
        void (async (): Promise<void> => {
          if (!child || settled) return;
          const outputs = await readOutputMap(options.outputFile).catch(
            (): Record<string, string> => ({}),
          );
          const hasActionOutputs = Object.keys(outputs).length > 0;
          killChildProcessGroup(child, 'SIGTERM');
          scheduleForceKill(child, { unref: true });

          if (status === 'success' && hasActionOutputs) {
            await finalize(
              {
                status: 'success',
                conclusion: 'success',
                outcome: 'success',
                exit_code: 0,
              },
              { preserveForceKillTimer: true },
            );
            return;
          }
          await finalize(
            {
              status: 'failure',
              conclusion: 'failure',
              outcome: 'failure',
              error:
                status === 'success'
                  ? `Agent emitted a terminal result but did not exit within ${options.agentTerminalResultGraceMs} ms before writing action outputs`
                  : `Agent emitted a terminal error result but did not exit within ${options.agentTerminalResultGraceMs} ms`,
            },
            { preserveForceKillTimer: true },
          );
        })();
      }, options.agentTerminalResultGraceMs);
      agentTerminalTimer.unref?.();
    };

    const observeAgentTerminalOutput = (chunk: Buffer | string): void => {
      if (
        options.agentTerminalResultGraceMs === undefined ||
        agentTerminalTimer
      ) {
        return;
      }
      agentTerminalLineBuffer +=
        typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const lines = agentTerminalLineBuffer.split(/\r?\n/);
      agentTerminalLineBuffer = lines.pop() ?? '';
      if (agentTerminalLineBuffer.length > 16_384) {
        agentTerminalLineBuffer = agentTerminalLineBuffer.slice(-16_384);
      }
      for (const line of lines) {
        const status = parseAgentTerminalResultLine(line);
        if (status) {
          scheduleAgentTerminalWatchdog(status);
          break;
        }
      }
    };

    try {
      const spawnSpec = wrapWindowsCommandShim(processSpec);
      child = spawn(spawnSpec.command, spawnSpec.args, {
        cwd: options.cwd,
        env: { ...options.env, ...processSpec.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: hostOperatingSystem() !== 'win32',
        windowsHide: true,
      });
    } catch (error) {
      void finalize({
        status: 'failure',
        conclusion: 'failure',
        outcome: 'failure',
        exit_code: 1,
        error: String(error),
      });
      return;
    }

    if (typeof child.pid === 'number') {
      options.onSpawn?.(child.pid);
    }
    resourceHandle =
      typeof child.pid === 'number' && options.resource
        ? (options.resourceMonitor?.registerProcess({
            id: `pipeline-step:${options.resource.executionId}:${options.resource.jobId}:${options.resource.stepId}:${String(options.resource.attempt)}:${String(child.pid)}`,
            groupId: 'pipelines',
            kind: 'pipeline-step',
            label: options.resource.label,
            pid: child.pid,
            processGroupId: child.pid,
            startedAt: new Date().toISOString(),
            metadata: {
              type: 'pipeline',
              pipeline: {
                executionId: options.resource.executionId,
                pipelineId: options.resource.pipelineId,
                pipelineName: options.resource.pipelineName,
                jobId: options.resource.jobId,
                stepId: options.resource.stepId,
                attempt: options.resource.attempt,
                iteration: options.resource.iteration,
              },
            },
          }) ?? null)
        : null;

    deadlineAt = Date.now() + options.timeout_minutes * 60_000;
    timers.timeout = setTimeout(() => {
      if (!child) return;
      timedOut = true;
      beginTermination();
      killChildProcessGroup(child, 'SIGTERM');
      scheduleForceKill(child);
    }, options.timeout_minutes * 60_000);

    child.stdout?.on('data', (chunk: Buffer | string) => {
      observeAgentTerminalOutput(chunk);
      if (!acceptsOutput('stdout', stdoutRedactor)) return;
      const text = guardRedaction(() => stdoutRedactor.redactChunk(chunk));
      writeOut('stdout', text);
      drainStored(stdoutRedactor, 'stdout');
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (!acceptsOutput('stderr', stderrRedactor)) return;
      const text = guardRedaction(() => stderrRedactor.redactChunk(chunk));
      writeOut('stderr', text);
      drainStored(stderrRedactor, 'stderr');
    });

    options.signal.addEventListener('abort', onAbort, { once: true });
    if (options.signal.aborted) onAbort();

    child.on('error', async (error) => {
      await finalize({
        status: options.signal.aborted ? 'cancelled' : 'failure',
        conclusion: options.signal.aborted ? 'cancelled' : 'failure',
        outcome: options.signal.aborted ? 'cancelled' : 'failure',
        error: String(error),
      });
    });
    child.on('close', async (code) => {
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
        forceKillTimer = undefined;
      }
      completeProcessCleanup();
      if (options.signal.aborted) {
        await finalize({
          status: 'cancelled',
          conclusion: 'cancelled',
          outcome: 'cancelled',
        });
      } else if (timedOut) {
        await finalize({
          status: 'failure',
          conclusion: 'failure',
          outcome: 'failure',
          error: `Step timed out after ${options.timeout_minutes} minute(s)`,
          exit_code: code ?? undefined,
        });
      } else if (code === 0) {
        await finalize({
          status: 'success',
          conclusion: 'success',
          outcome: 'success',
          exit_code: 0,
        });
      } else {
        await finalize({
          status: 'failure',
          conclusion: 'failure',
          outcome: 'failure',
          exit_code: code ?? undefined,
          error: `Process exited with code ${code ?? 'unknown'}`,
        });
      }
    });
  });
}
