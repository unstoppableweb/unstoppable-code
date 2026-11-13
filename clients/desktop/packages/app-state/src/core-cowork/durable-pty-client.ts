// ---------------------------------------------------------------------------
// A cloud terminal on the web core's durable `worker.terminal.*` operations
// (CAN-4160). The web runtime drives it in place of its direct sandbox PTY
// socket, with the same surface; the desktop drives it over the renderer
// relay (CAN-6175).
//
// It creates one interactive shell in the chat, or reattaches to one a
// previous page created (CAN-6094), and reads its output from the browser's
// web core connection (CAN-6091), whose invoker acknowledges each item it
// hands over. The terminal outlives a dropped attach and a page reload: the
// client reattaches from the last item it delivered, so output is neither
// lost nor repeated, and the exit still arrives after the last output. Input
// goes through `worker.terminal.write`, one call at a time, and is never
// resent (write is idempotency `none`).
//
// The web core offers these operations only to users with the
// `canopy-cloud-durable-terminals` flag on; `/chat` evaluates it on the
// server, and the runtime constructs this client only when it is on.
// ---------------------------------------------------------------------------

import {
  CanopyErrorPayloadSchema,
  CanopyStreamCursorSchema,
  WORKER_FILESYSTEM_QUERY_DEFINITIONS,
  WORKER_TERMINAL_INSTRUCTION_DEFINITIONS,
  WorkerTerminalAttachItemSchema,
  type CanopyErrorPayload,
  type CanopyStreamCursor,
  type WorkerTerminalAttachItem,
} from '@canopy/protocol/canopy-core';
import {
  CoreCoworkRequestError,
  type CoreCoworkInvoker,
  type CoreCoworkStream,
} from './invoker';

/** A terminal's size in character cells. */
export interface DurablePtyDimensions {
  readonly cols: number;
  readonly rows: number;
}

export type DurablePtyClientState = 'idle' | 'connecting' | 'open' | 'closed';

/** What the client uses of a web core connection: the browser's, or the desktop relay's. */
export interface DurableTerminalConnection {
  readonly invoker: CoreCoworkInvoker;
  readonly signal: AbortSignal;
}

/** Why a terminal closed; an exit by signal has no code. */
export type DurablePtyCloseReason =
  | { readonly kind: 'connection-lost'; readonly phase: 'connecting' | 'open' }
  | { readonly kind: 'exit'; readonly code: number | null };

/** Where a later page reattaches: the terminal and the output it holds. */
export interface DurablePtyResume {
  readonly terminalId: string;
  readonly offset: number;
}

export interface DurablePtyClientOptions {
  /**
   * The current connection, read at every call: it serves calls only while
   * online, and a connection that closed is replaced by the next one.
   */
  readonly client: () => DurableTerminalConnection | undefined;
  readonly chatId: string;
  /** The size a new shell starts at; a reattach without one keeps its own. */
  readonly dimensions?: DurablePtyDimensions;
  /** Reattaches to this terminal instead of creating one. */
  readonly resume?: DurablePtyResume;
  readonly env?: Readonly<Record<string, string>>;
  readonly onData: (bytes: Uint8Array) => void;
  readonly onClose: (reason: DurablePtyCloseReason) => void;
  readonly onOpen?: () => void;
  readonly randomUUID?: () => string;
  readonly setTimeout?: typeof globalThis.setTimeout;
  readonly clearTimeout?: typeof globalThis.clearTimeout;
}

type Frame =
  | {
      readonly kind: 'item';
      readonly cursor: CanopyStreamCursor;
      readonly item: WorkerTerminalAttachItem;
    }
  | {
      readonly kind: 'end';
      readonly completed: boolean;
      readonly error: CanopyErrorPayload | null;
    };

const ROOTS =
  WORKER_FILESYSTEM_QUERY_DEFINITIONS['worker.filesystem.roots.list'];
const CREATE =
  WORKER_TERMINAL_INSTRUCTION_DEFINITIONS['worker.terminal.create'];
// Under the 1 MiB `input` limit once base64 encoded.
const WRITE_MAX_BYTES = 512 * 1024;
const ATTEMPTS = 5;
const INITIAL_DELAY_MS = 500;
const MAX_DELAY_MS = 8_000;
// How long a disposed client keeps reading for the exit its kill causes.
const DRAIN_TIMEOUT_MS = 5_000;
const NO_CONNECTION: CanopyErrorPayload = {
  kind: 'unavailable',
  message: 'The web core connection is closed.',
  retry: { kind: 'same_request' },
};
const INVALID_FRAME: CanopyErrorPayload = {
  kind: 'internal',
  message: 'The terminal stream sent an invalid frame.',
  retry: { kind: 'never' },
};
const GONE_CODES: ReadonlySet<string> = new Set([
  'worker.terminal.notFound',
  'worker.terminal.snapshotRequired',
]);
export const DURABLE_PTY_SKIPPED_MARKER =
  '\r\n\x1b[2m[Earlier output skipped]\x1b[0m\r\n';

/** The terminal or this caller's access to it is gone for good. */
const isGone = (error: CanopyErrorPayload): boolean =>
  error.kind === 'not_found' ||
  error.retry.kind === 'never' ||
  (error.code !== undefined && GONE_CODES.has(error.code));

const payloadOf = (error: unknown): CanopyErrorPayload =>
  error instanceof CoreCoworkRequestError
    ? error.payload
    : {
        kind: 'internal',
        message: 'The terminal call failed.',
        retry: { kind: 'never' },
      };

const delayOf = (attempt: number): number =>
  Math.min(MAX_DELAY_MS, INITIAL_DELAY_MS * 2 ** attempt);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

function toFrame(value: unknown): Frame {
  if (isRecord(value) && value.kind === 'item') {
    const cursor = CanopyStreamCursorSchema.safeParse(value.cursor);
    const item = WorkerTerminalAttachItemSchema.safeParse(value.item);
    if (cursor.success && item.success)
      return { kind: 'item', cursor: cursor.data, item: item.data };
  }
  if (isRecord(value) && value.kind === 'end') {
    const error = CanopyErrorPayloadSchema.safeParse(value.error);
    return {
      kind: 'end',
      completed: value.outcome === 'completed',
      error: error.success ? error.data : null,
    };
  }
  return { kind: 'end', completed: false, error: INVALID_FRAME };
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

function bytesOf(item: WorkerTerminalAttachItem): Uint8Array {
  return item.encoding === 'utf8'
    ? new TextEncoder().encode(item.data)
    : Uint8Array.from(atob(item.data), (char) => char.charCodeAt(0));
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const all = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.length, 0),
  );
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.length;
  }
  return all;
}

export class DurablePtyClient {
  private readonly readState: () => DurablePtyClientState;
  private readonly readResume: () => DurablePtyResume | undefined;
  readonly connect: () => void;
  readonly write: (bytes: Uint8Array<ArrayBuffer>) => void;
  readonly resize: (dimensions: DurablePtyDimensions) => void;
  /** Ends the shell: closing the panel or losing the terminal. */
  readonly dispose: () => void;
  get state(): DurablePtyClientState {
    return this.readState();
  }
  /** Undefined until the shell exists; persisted so a reload can reattach. */
  get resume(): DurablePtyResume | undefined {
    return this.readResume();
  }
  constructor(options: DurablePtyClientOptions) {
    const { onData, onClose, onOpen } = options;
    const schedule = options.setTimeout ?? globalThis.setTimeout;
    const cancel = options.clearTimeout ?? globalThis.clearTimeout;
    const randomUUID =
      options.randomUUID ?? ((): string => crypto.randomUUID());
    const scope = { chatId: options.chatId };
    // Only the size: the caller's object can carry more than create accepts.
    const sizeOf = (size: DurablePtyDimensions): DurablePtyDimensions => ({
      cols: size.cols,
      rows: size.rows,
    });
    let dimensions = options.dimensions && sizeOf(options.dimensions);
    // The size the shell has; unknown for a reattached one.
    let applied: DurablePtyDimensions | undefined;
    let state: DurablePtyClientState = 'idle';
    let terminalId = options.resume?.terminalId;
    let exited = false;
    let stream: CoreCoworkStream | undefined;
    // A disposed client's attach, read only to acknowledge through the exit:
    // the web core ends a subscription once its last item is acknowledged,
    // and closing the handle locally does not cancel it.
    let draining: CoreCoworkStream | undefined;
    let drainTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    let failures = 0;
    // The last item delivered: a reattach resumes after it.
    let cursor: CanopyStreamCursor | null = null;
    let offset = options.resume?.offset ?? 0;
    // Input and sizes, sent in order one call at a time: the web core orders
    // only what a client sends one at a time.
    let queued: (
      | { readonly input: Uint8Array }
      | { readonly size: DurablePtyDimensions }
    )[] = [];
    let writing = false;
    // Read through a call: callbacks and awaits change it behind narrowing.
    const closed = (): boolean => state === 'closed';
    const live = (): DurableTerminalConnection => {
      const current = options.client();
      if (!current || current.signal.aborted)
        throw new CoreCoworkRequestError(NO_CONNECTION);
      return current;
    };
    const request = async (
      method: string,
      params: Record<string, unknown>,
    ): Promise<unknown> => {
      const reply = await live().invoker.request(method, params);
      if (!reply.ok) throw new CoreCoworkRequestError(reply.error);
      return reply.value;
    };
    /** Retries an unavailable connection, as one that is still coming online. */
    const patiently = async (
      method: string,
      params: Record<string, unknown>,
    ): Promise<unknown> => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await request(method, params);
        } catch (error) {
          if (
            closed() ||
            payloadOf(error).kind !== 'unavailable' ||
            attempt + 1 >= ATTEMPTS
          )
            throw error;
          await new Promise((resolve) => schedule(resolve, delayOf(attempt)));
        }
      }
    };

    const kill = (): void => {
      if (terminalId === undefined || exited) return;
      void request('worker.terminal.kill', { scope, terminalId }).catch(
        () => undefined,
      );
    };
    const stop = (): void => {
      state = 'closed';
      if (timer !== undefined) cancel(timer);
      timer = undefined;
      void stream?.close();
      stream = undefined;
      queued = [];
    };
    const finish = (reason: DurablePtyCloseReason): void => {
      if (state === 'closed') return;
      if (reason.kind === 'exit') exited = true;
      // Nothing will read this shell again; like a dropped socket, end it.
      else kill();
      stop();
      onClose(reason);
    };
    const lost = (): void =>
      finish({
        kind: 'connection-lost',
        phase: state === 'open' ? 'open' : 'connecting',
      });

    const deliver = (
      at: CanopyStreamCursor,
      item: WorkerTerminalAttachItem,
    ): void => {
      // Already delivered: a replayed item after a reattach.
      if (
        cursor !== null &&
        at.daemonEpoch === cursor.daemonEpoch &&
        at.sequence <= cursor.sequence
      )
        return;
      cursor = at;
      failures = 0;
      if (item.truncatedBefore)
        onData(new TextEncoder().encode(DURABLE_PTY_SKIPPED_MARKER));
      // A listener may have closed the terminal.
      if (closed()) return;
      const bytes = bytesOf(item).subarray(
        Math.max(0, offset - item.fromOffset),
      );
      offset = Math.max(offset, item.toOffset);
      if (bytes.length > 0) onData(bytes);
      if (closed()) return;
      if (item.exit !== null) {
        const { code } = item.exit;
        finish({ kind: 'exit', code: typeof code === 'number' ? code : null });
      }
    };

    const endDrain = (): void => {
      if (drainTimer !== undefined) cancel(drainTimer);
      drainTimer = undefined;
      void draining?.close();
      draining = undefined;
    };
    /** Reads a closed client's attach only to acknowledge through its exit. */
    const drainOn = (handle: CoreCoworkStream): void => {
      if (exited) {
        void handle.close();
        return;
      }
      endDrain();
      draining = handle;
      drainTimer = schedule(endDrain, DRAIN_TIMEOUT_MS);
    };

    const retry = (error: CanopyErrorPayload | null): void => {
      void stream?.close();
      stream = undefined;
      if (
        state === 'closed' ||
        (error !== null && isGone(error)) ||
        failures >= ATTEMPTS
      ) {
        lost();
        return;
      }
      timer = schedule(() => {
        timer = undefined;
        void attach();
      }, delayOf(failures));
      failures += 1;
    };

    const read = async (
      handle: CoreCoworkStream,
      client: DurableTerminalConnection,
    ): Promise<void> => {
      for (;;) {
        const next = await handle.next().catch(() => ({ done: true }) as const);
        const frame = next.done ? null : toFrame(next.value);
        if (draining === handle) {
          if (frame === null || frame.kind === 'end' || frame.item.exit)
            endDrain();
          else continue;
          return;
        }
        if (stream !== handle) return;
        if (frame === null) {
          // The connection ended under the stream: its replacement resumes.
          retry(null);
          return;
        }
        if (frame.kind === 'item') {
          deliver(frame.cursor, frame.item);
          continue;
        }
        if (frame.completed) lost();
        else retry(client.signal.aborted ? null : frame.error);
        return;
      }
    };

    const attach = async (): Promise<void> => {
      if (state === 'closed' || terminalId === undefined) return;
      let used: DurableTerminalConnection | undefined;
      let handle: CoreCoworkStream;
      try {
        used = live();
        handle = await used.invoker.openStream('worker.terminal.attach', {
          scope,
          terminalId,
          fromOffset: offset,
          ...(cursor === null ? {} : { cursor }),
        });
      } catch (error) {
        // A connection that closed under the call says nothing about the
        // terminal: the next attempt uses its replacement.
        retry(used?.signal.aborted === false ? payloadOf(error) : null);
        return;
      }
      if (closed()) drainOn(handle);
      else {
        stream = handle;
        failures = 0;
        if (state === 'connecting') {
          state = 'open';
          // A dispose here leaves the read loop draining the handle.
          onOpen?.();
          if (
            !closed() &&
            dimensions &&
            (dimensions.cols !== applied?.cols ||
              dimensions.rows !== applied.rows)
          )
            this.resize(dimensions);
        }
      }
      void read(handle, used);
    };

    const start = async (): Promise<void> => {
      if (terminalId === undefined) {
        const created = dimensions ?? { cols: 80, rows: 24 };
        try {
          // A shell starts in the chat's first file root: its single
          // checkout, else its workspace.
          const { roots } = ROOTS.result.parse(
            await patiently('worker.filesystem.roots.list', { scope }),
          );
          const [root] = roots;
          if (root === undefined) throw new Error('The chat has no file root.');
          // One key for every attempt, so a retry never starts a second shell.
          const terminal = CREATE.result.parse(
            await patiently('worker.terminal.create', {
              scope,
              cwdRootId: root.fileRootId,
              cwdRelativePath: '',
              ...created,
              kind: 'interactive',
              ...(options.env === undefined ? {} : { env: { ...options.env } }),
              _meta: { idempotencyKey: randomUUID() },
            }),
          );
          terminalId = terminal.terminalId;
          applied = created;
        } catch {
          lost();
          return;
        }
        // Disposed while starting: nobody holds this shell.
        if (closed()) {
          kill();
          return;
        }
      }
      await attach();
    };

    const drain = async (): Promise<void> => {
      writing = true;
      while (
        queued.length > 0 &&
        state === 'open' &&
        terminalId !== undefined
      ) {
        const head = queued[0];
        if (head !== undefined && 'size' in head) {
          queued.shift();
          // A newer size right behind it replaces this one.
          const after = queued[0];
          if (after !== undefined && 'size' in after) continue;
          try {
            await request('worker.terminal.resize', {
              scope,
              terminalId,
              ...head.size,
            });
            applied = head.size;
          } catch {
            // The next resize corrects a size that did not apply.
          }
          continue;
        }
        const chunks: Uint8Array[] = [];
        for (
          let next = queued[0];
          next !== undefined && 'input' in next;
          next = queued[0]
        ) {
          chunks.push(next.input);
          queued.shift();
          // An Enter ends the frame: a shell switches its terminal mode after
          // reading a line, and input arriving with it is read in the old mode.
          if (next.input.includes(13)) break;
        }
        const input = concat(chunks);
        for (
          let at = 0;
          at < input.length && state === 'open';
          at += WRITE_MAX_BYTES
        ) {
          try {
            await request('worker.terminal.write', {
              scope,
              terminalId,
              input: toBase64(input.subarray(at, at + WRITE_MAX_BYTES)),
              encoding: 'base64',
            });
          } catch (error) {
            const payload = payloadOf(error);
            if (
              payload.kind === 'not_found' ||
              (payload.code !== undefined && GONE_CODES.has(payload.code))
            )
              lost();
            // shortcut: other failures drop the input, since an unknown
            // outcome is never resent; surface them if users report it.
          }
        }
      }
      writing = false;
    };

    this.readState = (): DurablePtyClientState => state;
    this.readResume = (): DurablePtyResume | undefined =>
      terminalId === undefined ? undefined : { terminalId, offset };
    this.connect = (): void => {
      if (state !== 'idle') return;
      state = 'connecting';
      void start();
    };
    this.write = (bytes): void => {
      if (state !== 'open') return;
      queued.push({ input: bytes });
      if (!writing) void drain();
    };
    this.resize = (next): void => {
      dimensions = sizeOf(next);
      if (state !== 'open') return;
      queued.push({ size: dimensions });
      if (!writing) void drain();
    };
    this.dispose = (): void => {
      if (state === 'closed') return;
      const open = stream;
      stream = undefined;
      kill();
      stop();
      // An attach still opening is drained when it resolves.
      if (open) drainOn(open);
    };
  }
}
