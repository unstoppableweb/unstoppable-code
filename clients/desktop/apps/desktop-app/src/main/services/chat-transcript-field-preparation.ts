import {
  codexItemOutputBody,
  codexOutputChunks,
  codexOutputText,
  type CodexItemOutputBody,
  type PreparedCodexItem,
  type PreparedCodexItemOutput,
} from '@canopy/agent-transcript';
import type { PersistedToolOutputReference } from '@canopy/agent-transcript/types';
import { REMOTE_CONTROL_CHAT_PART_TEXT_MAX_CHARS } from '@canopy/agent-transcript/remote-control/persisted-chat-projection';
import {
  TOOL_OUTPUT_INLINE_BYTES,
  TOOL_OUTPUT_PREVIEW_HEAD_BYTES,
} from '@canopy/agent-transcript/transcript-storage';
import type { TranscriptFieldPreparation } from './chat-state-contracts';

/**
 * Format 4 ingest preparation for final Codex tool bodies.
 *
 * Main ingest streams the canonical body of a final `function_call_output`,
 * `mcp_tool_call` or `dynamic_tool_call` item through the scope transaction's
 * `transcriptFields` port, then hands the shared reducer a bounded preview
 * and its reference. Main never builds or joins the whole structured body,
 * and it yields to the event loop while serializing. Without the port
 * (format 2 and 3 scopes, older repositories) nothing is prepared and
 * ingest is unchanged.
 */

/** Must equal the marker of the artifact preview builder. */
const PREVIEW_MARKER = '\n[Full output stored separately]\n';
/** Code units kept from the start: enough for the head byte budget. */
const HEAD_KEEP_CHARS = TOOL_OUTPUT_PREVIEW_HEAD_BYTES + 2;
/** Code units kept from the end: more than any tail budget, plus a pair. */
const TAIL_KEEP_CHARS = TOOL_OUTPUT_INLINE_BYTES + 2;
const YIELD_AFTER_CHARS = 256 * 1024;
const YIELD_AFTER_MS = 8;

export interface CodexFieldPreparationOptions {
  signal?: AbortSignal;
  /** Test seam; defaults to one `setImmediate` turn. */
  yieldToEventLoop?: () => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** The same head as the artifact preview builder. */
function utf8Prefix(value: string, bytes: number): string {
  let end = 0;
  let used = 0;
  while (end < value.length) {
    const point = value.codePointAt(end);
    if (point === undefined) break;
    const size = point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
    if (used + size > bytes) break;
    used += size;
    end += point > 0xffff ? 2 : 1;
  }
  return value.slice(0, end);
}

/**
 * The artifact preview of a body from its first and last code units. Equal
 * to the whole-string builder: its head never reads past `HEAD_KEEP_CHARS`
 * and its tail never reaches the start of a `TAIL_KEEP_CHARS` suffix.
 */
export function transcriptFieldPreviewFromEnds(
  start: string,
  end: string,
): string {
  const head = utf8Prefix(start, TOOL_OUTPUT_PREVIEW_HEAD_BYTES);
  const tailBudget =
    TOOL_OUTPUT_INLINE_BYTES - Buffer.byteLength(head + PREVIEW_MARKER);
  let tailStart = end.length;
  let used = 0;
  while (tailStart > 0) {
    const last = end.charCodeAt(tailStart - 1);
    const prior = tailStart >= 2 ? end.charCodeAt(tailStart - 2) : 0;
    const paired = isLowSurrogate(last) && isHighSurrogate(prior);
    const size = paired ? 4 : last < 0x80 ? 1 : last < 0x800 ? 2 : 3;
    if (used + size > tailBudget) break;
    used += size;
    tailStart -= paired ? 2 : 1;
  }
  return head + PREVIEW_MARKER + end.slice(tailStart);
}

/** UTF-8 length, head and tail of a body seen chunk by chunk. */
class BodyObserver {
  public bytes = 0;
  public codeUnits = 0;
  public unpairedSurrogate = false;
  private tail = '';
  private endsWithHigh = false;

  public add(chunk: string): void {
    if (chunk.length === 0) return;
    // Buffer counts an unpaired surrogate as three bytes. A pair split across
    // chunks counts as two of those, but encodes as four bytes.
    let bytes = Buffer.byteLength(chunk, 'utf8');
    const splitPair = this.endsWithHigh && isLowSurrogate(chunk.charCodeAt(0));
    if (splitPair) bytes -= 2;
    this.bytes += bytes;
    this.codeUnits += chunk.length;
    if (!this.unpairedSurrogate)
      this.unpairedSurrogate = hasUnpairedSurrogate(
        chunk,
        this.endsWithHigh && !splitPair,
        splitPair,
      );
    this.endsWithHigh = isHighSurrogate(chunk.charCodeAt(chunk.length - 1));
    this.tail =
      chunk.length >= TAIL_KEEP_CHARS
        ? chunk.slice(-TAIL_KEEP_CHARS)
        : this.tail.slice(-(TAIL_KEEP_CHARS - chunk.length)) + chunk;
  }

  /** Whether the body ended on an unpaired high surrogate. */
  public get pendingHigh(): boolean {
    return this.endsWithHigh;
  }

  public get end(): string {
    return this.tail;
  }
}

/**
 * Whether `chunk` holds an unpaired surrogate. `previousUnpairedHigh` means
 * the prior chunk ended on a high surrogate that this chunk does not pair;
 * `startsPaired` means its first code unit completes the prior chunk's pair.
 */
function hasUnpairedSurrogate(
  chunk: string,
  previousUnpairedHigh: boolean,
  startsPaired: boolean,
): boolean {
  if (previousUnpairedHigh) return true;
  for (let index = startsPaired ? 1 : 0; index < chunk.length; index += 1) {
    const code = chunk.charCodeAt(index);
    if (isHighSurrogate(code)) {
      if (index + 1 >= chunk.length) return false;
      if (!isLowSurrogate(chunk.charCodeAt(index + 1))) return true;
      index += 1;
    } else if (isLowSurrogate(code)) return true;
  }
  return false;
}

function createPacer(
  yieldToEventLoop: () => Promise<void>,
): (chars: number) => Promise<void> {
  let chars = 0;
  let since = performance.now();
  return async (count) => {
    chars += count;
    if (chars < YIELD_AFTER_CHARS && performance.now() - since < YIELD_AFTER_MS)
      return;
    await yieldToEventLoop();
    chars = 0;
    since = performance.now();
  };
}

function preparedOutput(
  field: CodexItemOutputBody['field'],
  value: string,
  reference?: PersistedToolOutputReference,
  needsRead = false,
): PreparedCodexItemOutput {
  const output: PreparedCodexItemOutput =
    field === 'text'
      ? reference
        ? { field, text: value, textRef: reference }
        : { field, text: value }
      : reference
        ? { field, output: value, fullOutputRef: reference }
        : { field, output: value };
  return needsRead ? { ...output, needsRead: true } : output;
}

interface SourceState {
  failed: boolean;
}

async function prepareBody(
  port: TranscriptFieldPreparation,
  chatId: string,
  field: CodexItemOutputBody['field'],
  chunks: Iterable<string>,
  state: SourceState,
  options: CodexFieldPreparationOptions,
): Promise<PreparedCodexItemOutput> {
  const { signal } = options;
  const pace = createPacer(
    options.yieldToEventLoop ??
      ((): Promise<void> =>
        new Promise<void>((resolve) => setImmediate(resolve))),
  );
  const iterator = chunks[Symbol.iterator]();
  let exhausted = false;
  const pull = (): string | undefined => {
    if (exhausted) return undefined;
    let next: IteratorResult<string>;
    try {
      next = iterator.next();
    } catch (error) {
      state.failed = true;
      throw error;
    }
    if (next.done) {
      exhausted = true;
      return undefined;
    }
    return next.value;
  };
  const observer = new BodyObserver();
  // Small bodies stay inline. Hold chunks only until the body crosses the
  // inline budget; that prefix is bounded by the budget plus one chunk.
  const prefix: string[] = [];
  for (;;) {
    signal?.throwIfAborted();
    const chunk = pull();
    if (chunk === undefined)
      return preparedOutput(
        field,
        prefix.join(''),
        undefined,
        observer.codeUnits > REMOTE_CONTROL_CHAT_PART_TEXT_MAX_CHARS,
      );
    observer.add(chunk);
    prefix.push(chunk);
    await pace(chunk.length);
    if (observer.bytes > TOOL_OUTPUT_INLINE_BYTES) break;
  }
  const start = prefix.join('').slice(0, HEAD_KEEP_CHARS);
  async function* stream(): AsyncGenerator<string, void, undefined> {
    const held = prefix.splice(0, prefix.length);
    for (let index = 0; index < held.length; index += 1) yield held[index];
    for (;;) {
      signal?.throwIfAborted();
      const chunk = pull();
      if (chunk === undefined) return;
      observer.add(chunk);
      yield chunk;
      await pace(chunk.length);
    }
  }
  const reference = await port.publish(chatId, stream(), signal);
  if (!exhausted)
    throw new Error('Transcript field publication ended before its body');
  const unpaired = observer.unpairedSurrogate || observer.pendingHigh;
  const expectedBytes = unpaired ? observer.codeUnits * 2 : observer.bytes;
  if (
    reference.encoding !== (unpaired ? 'utf-16le' : 'utf-8') ||
    reference.byteLength !== expectedBytes
  )
    throw new Error('Transcript field reference does not match its body');
  return preparedOutput(
    field,
    transcriptFieldPreviewFromEnds(start, observer.end),
    reference,
    reference !== undefined ||
      observer.codeUnits > REMOTE_CONTROL_CHAT_PART_TEXT_MAX_CHARS,
  );
}

/**
 * Prepare the final output body of one Codex event for the reducer. Returns
 * undefined when there is no port or the event has no final output body.
 * Bodies over the inline budget are published through the port; smaller
 * bodies are returned whole. Publication runs under the caller's scope
 * transaction, so its rollback covers a later failure.
 */
export async function prepareCodexItemFields(
  port: TranscriptFieldPreparation | undefined,
  chatId: string,
  event: unknown,
  options: CodexFieldPreparationOptions = {},
): Promise<PreparedCodexItem | undefined> {
  if (port?.format !== 4 || !isRecord(event)) return undefined;
  const body = codexItemOutputBody(event);
  if (!body) return undefined;
  const state: SourceState = { failed: false };
  let output: PreparedCodexItemOutput;
  try {
    output = await prepareBody(
      port,
      chatId,
      body.field,
      body.chunks,
      state,
      options,
    );
  } catch (error) {
    if (!state.failed || options.signal?.aborted) throw error;
    // An unreadable provider value (a throwing getter) makes the chunked
    // normalizer throw where the synchronous one applies its bounded
    // fallback. Publish that synchronous text instead, so both stay equal.
    const whole = body.whole();
    output = await prepareBody(
      port,
      chatId,
      body.field,
      codexOutputChunks(() => codexOutputText(whole)),
      { failed: false },
      options,
    );
  }
  return { itemId: body.itemId, output };
}
