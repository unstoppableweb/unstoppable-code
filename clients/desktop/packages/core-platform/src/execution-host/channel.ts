import { deserialize, serialize } from 'node:v8';

/**
 * Hosts launched over the owned-process primitive exchange messages as lines
 * on stdin and stdout. A frame line is the marker followed by the base64 of
 * the V8 serialization of one message, so messages keep the structured-clone
 * shapes `utilityProcess` gives them. Other stdout lines are host output.
 */
export const EXECUTION_HOST_CHANNEL_ENV = 'CANOPY_EXECUTION_HOST_CHANNEL';
export const EXECUTION_HOST_STDIO_CHANNEL = 'stdio';

const FRAME_MARKER = '\u001ecanopy-host:';
const NEWLINE = 0x0a;

export function encodeExecutionHostFrame(message: unknown): Buffer {
  return Buffer.from(
    `${FRAME_MARKER}${serialize(message).toString('base64')}\n`,
    'utf8',
  );
}

/** The largest frame a reader buffers; a frame past it fails its host. */
export const MAX_EXECUTION_HOST_FRAME_BYTES = 128 * 1024 * 1024;

const MARKER_BYTES = Buffer.from(FRAME_MARKER, 'utf8');

/**
 * Splits a byte stream into lines and decodes frames. Output that is not a
 * frame goes to `onOther`; an unterminated line that is not a frame is passed
 * on as it arrives, so only a frame is buffered, and only up to
 * `maxFrameBytes`. A larger frame is dropped and reported to `onOversize`.
 * A frame that does not decode is dropped and reported to `onCorrupt`, never
 * to `onOther`: the message a waiting request needed is gone, so the owner
 * must fail it (CAN-7116).
 */
export class ExecutionHostFrameReader {
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  /** The unterminated line: not yet known, a frame, other output, or dropped. */
  private mode: 'unknown' | 'frame' | 'other' | 'dropped' = 'unknown';

  constructor(
    private readonly onFrame: (message: unknown) => void,
    private readonly onOther: (bytes: Buffer) => void,
    private readonly onOversize: () => void = (): void => undefined,
    private readonly maxFrameBytes = MAX_EXECUTION_HOST_FRAME_BYTES,
    private readonly onCorrupt: () => void = (): void => undefined,
  ) {}

  push(chunk: Uint8Array): void {
    let bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    while (bytes.byteLength > 0) {
      const end = bytes.indexOf(NEWLINE);
      const piece = end < 0 ? bytes : bytes.subarray(0, end + 1);
      bytes = end < 0 ? Buffer.alloc(0) : bytes.subarray(end + 1);
      this.take(piece, end >= 0);
    }
  }

  /** Hands an unterminated last line to `onOther`, or a cut frame to `onCorrupt`. */
  end(): void {
    const frame = this.mode === 'frame';
    const rest = this.reset();
    if (rest.byteLength === 0) return;
    if (frame) this.onCorrupt();
    else this.onOther(rest);
  }

  private take(piece: Buffer, complete: boolean): void {
    if (this.mode === 'dropped' || this.mode === 'other') {
      if (this.mode === 'other') this.onOther(piece);
      if (complete) this.mode = 'unknown';
      return;
    }
    this.pending.push(piece);
    this.pendingBytes += piece.byteLength;
    if (
      this.mode === 'unknown' &&
      this.pendingBytes >= MARKER_BYTES.byteLength
    ) {
      const head = Buffer.concat(this.pending);
      if (!head.subarray(0, MARKER_BYTES.byteLength).equals(MARKER_BYTES)) {
        this.reset();
        if (!complete) this.mode = 'other';
        this.onOther(head);
        return;
      }
      this.mode = 'frame';
    }
    if (this.mode === 'frame' && this.pendingBytes > this.maxFrameBytes) {
      this.reset();
      if (!complete) this.mode = 'dropped';
      this.onOversize();
      return;
    }
    if (complete) this.line(this.reset());
  }

  private reset(): Buffer {
    const bytes = Buffer.concat(this.pending);
    this.pending = [];
    this.pendingBytes = 0;
    this.mode = 'unknown';
    return bytes;
  }

  /** One complete line, its newline included. */
  private line(line: Buffer): void {
    const text = line.toString('utf8');
    if (!text.startsWith(FRAME_MARKER)) {
      this.onOther(line);
      return;
    }
    let message: unknown;
    try {
      message = deserialize(
        Buffer.from(text.slice(FRAME_MARKER.length).trimEnd(), 'base64'),
      );
    } catch {
      this.onCorrupt();
      return;
    }
    this.onFrame(message);
  }
}

/**
 * The host side of the launcher's channel, shaped like Electron's
 * `ParentPort`: messages arrive as `{ data }`.
 */
export interface ExecutionHostChannel {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown;
  once(event: 'message', listener: (event: { data: unknown }) => void): unknown;
}

export interface ConnectedExecutionHostChannel extends ExecutionHostChannel {
  /** Exits once every message posted before it has been written. */
  exit(code: number): void;
  /** Whether posted messages wait past the channel's high-water mark. */
  congested(): boolean;
  /** Calls `listener` once, when no posted message is waiting. */
  onceDrained(listener: () => void): void;
  /**
   * Called once when the launcher can no longer be reached. Without a
   * handler the host exits, as a utility process does with its parent.
   */
  onDisconnect(handler: () => void): void;
}

interface ParentPortLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown;
  once(event: 'message', listener: (event: { data: unknown }) => void): unknown;
}

function isParentPort(value: unknown): value is ParentPortLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'postMessage') === 'function' &&
    typeof Reflect.get(value, 'on') === 'function' &&
    typeof Reflect.get(value, 'once') === 'function'
  );
}

/** Queued frame bytes past which a stdio channel reports congestion. */
export const EXECUTION_HOST_CHANNEL_HIGH_WATER_BYTES = 1024 * 1024;

/**
 * The stdio channel over the given streams. Frames are written in order and
 * a full pipe holds later frames until it drains; past `highWaterBytes` of
 * held frames the channel reports congestion, so a producer that checks it
 * can stop producing. `exit` waits for every frame posted before it.
 */
export function createStdioExecutionHostChannel(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  exitProcess: (code: number) => void,
  highWaterBytes = EXECUTION_HOST_CHANNEL_HIGH_WATER_BYTES,
): ConnectedExecutionHostChannel {
  const listeners = new Set<(event: { data: unknown }) => void>();
  const queued: Buffer[] = [];
  let queuedBytes = 0;
  const drained: (() => void)[] = [];
  let blocked = false;
  let failed = false;
  let exitCode: number | undefined;
  let exiting = false;
  let disconnect: (() => void) | undefined;
  let disconnected = false;
  const lost = (): void => {
    if (disconnected) return;
    disconnected = true;
    if (disconnect) disconnect();
    else exitProcess(0);
  };
  const reader = new ExecutionHostFrameReader(
    (data) => {
      for (const listener of Array.from(listeners)) listener({ data });
    },
    () => undefined,
    undefined,
    undefined,
    // A launcher frame that does not decode may have been a request the
    // launcher waits on; ending as for a lost launcher settles it by exit.
    lost,
  );
  const flush = (): void => {
    while (!blocked && !failed) {
      const frame = queued.shift();
      if (!frame) break;
      queuedBytes -= frame.byteLength;
      blocked = !output.write(frame);
    }
    if ((queued.length === 0 && !blocked) || failed)
      for (const listener of drained.splice(0)) listener();
    if (exiting || exitCode === undefined) return;
    if (queued.length > 0 && !failed) return;
    const code = exitCode;
    if (failed) {
      exiting = true;
      exitProcess(code);
    }
    // Writes complete in order, so this callback follows every frame.
    else if (!blocked) {
      exiting = true;
      output.write('', () => exitProcess(code));
    }
  };
  input.on('data', (chunk: Buffer) => reader.push(chunk));
  input.once('end', lost);
  input.once('close', lost);
  input.on('error', lost);
  output.on('drain', () => {
    blocked = false;
    flush();
  });
  // The launcher stopped reading: nothing posted can reach it any more.
  output.on('error', () => {
    failed = true;
    queued.length = 0;
    queuedBytes = 0;
    lost();
    flush();
  });

  const channel: ConnectedExecutionHostChannel = {
    postMessage(message: unknown): void {
      if (failed || exitCode !== undefined) return;
      const frame = encodeExecutionHostFrame(message);
      queued.push(frame);
      queuedBytes += frame.byteLength;
      flush();
    },
    on(_event, listener) {
      listeners.add(listener);
      return channel;
    },
    once(_event, listener) {
      const once = (event: { data: unknown }): void => {
        listeners.delete(once);
        listener(event);
      };
      listeners.add(once);
      return channel;
    },
    exit(code: number): void {
      exitCode ??= code;
      flush();
    },
    onDisconnect(handler: () => void): void {
      disconnect = handler;
    },
    congested: () => queuedBytes >= highWaterBytes,
    onceDrained(listener: () => void): void {
      if ((queued.length === 0 && !blocked) || failed) listener();
      else drained.push(listener);
    },
  };
  return channel;
}

/**
 * The channel to whichever launcher started this host: Electron's
 * `process.parentPort` for a utility process, or stdio for a host launched
 * over the owned-process primitive. Undefined when the module was imported
 * in process rather than launched as a host.
 */
export function connectExecutionHostChannel():
  | ConnectedExecutionHostChannel
  | undefined {
  const parentPort: unknown = Reflect.get(process, 'parentPort');
  if (isParentPort(parentPort)) {
    return {
      postMessage: (message) => parentPort.postMessage(message),
      on: (event, listener) => parentPort.on(event, listener),
      once: (event, listener) => parentPort.once(event, listener),
      exit: (code) => process.exit(code),
      // A utility process ends with its parent.
      onDisconnect: () => undefined,
      // Electron's port queues without bound and reports nothing to wait for.
      congested: () => false,
      onceDrained: (listener) => listener(),
    };
  }
  if (process.env[EXECUTION_HOST_CHANNEL_ENV] === EXECUTION_HOST_STDIO_CHANNEL)
    return createStdioExecutionHostChannel(
      process.stdin,
      process.stdout,
      (code) => process.exit(code),
    );
  return undefined;
}
