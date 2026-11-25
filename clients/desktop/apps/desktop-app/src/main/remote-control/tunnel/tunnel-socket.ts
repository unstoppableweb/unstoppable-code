import { Duplex } from 'node:stream';
import type {
  TunnelOpenFailureCode,
  TunnelResetCode,
} from '@canopy/protocol/remote-control';

/** What a tunnel socket hands its stream multiplexer. */
export interface TunnelStreamSink {
  /** Queues bytes to send; `done` runs once they are handed to the session. */
  write(chunk: Buffer, done: (error?: Error | null) => void): void;
  /** Queues the half-close after every queued byte. */
  end(done: (error?: Error | null) => void): void;
  /** The socket's reader took this many delivered bytes. */
  consumed(bytes: number): void;
  /** Whether bytes this side has not sent yet may be compressed. */
  setCompression(enabled: boolean): void;
  /** The socket was destroyed, by its owner or by the multiplexer. */
  destroyed(error: Error | null): void;
}

/** The host would not open the stream. */
export class TunnelOpenError extends Error {
  readonly code: TunnelOpenFailureCode;
  constructor(code: TunnelOpenFailureCode) {
    super(`The other computer did not open the connection (${code}).`);
    this.name = 'TunnelOpenError';
    this.code = code;
  }
}

/** The other side reset the stream. */
export class TunnelResetError extends Error {
  readonly code: TunnelResetCode;
  constructor(code: TunnelResetCode) {
    super(`The connection through the other computer was reset (${code}).`);
    this.name = 'TunnelResetError';
    this.code = code;
  }
}

/** The session carrying the stream closed. */
export class TunnelClosedError extends Error {
  readonly code = 'ECONNRESET';
  constructor() {
    super('The connection to the other computer closed.');
    this.name = 'TunnelClosedError';
  }
}

export interface TunnelSocketInfo {
  streamId: number;
  host: string;
  port: number;
  /** True until the stream is open; a controller's opens wait for the host. */
  connecting: boolean;
  /**
   * False when the owner returns credit itself with `credit()`, as the
   * host does once its dialed socket accepted each write. By default,
   * bytes are credited once the reader takes them.
   */
  creditOnRead?: boolean;
}

/**
 * One tunnel stream as a Node socket. Writes queue on the stream and finish
 * once the multiplexer sends them under credit, so a writer feels the far
 * end's pace. Bytes from the far end are pushed to the reader, and credit is
 * returned only for bytes the reader took: a pipe takes them only while its
 * destination's `write()` accepts more, so a slow reader throttles the
 * sender. `end()` half-closes, and finishes only once the far end credited
 * every byte written, so a failure there still reaches the writer as an
 * error. `destroy()` resets the stream.
 *
 * It looks enough like a `net.Socket` (`connect`, `setTimeout`,
 * `setNoDelay`, `setKeepAlive`, `ref`) for `http.Agent#createConnection`.
 */
export class TunnelSocket extends Duplex {
  readonly streamId: number;
  readonly remoteHost: string;
  readonly remotePort: number;
  connecting: boolean;
  private readonly creditOnRead: boolean;
  private pushedBytes = 0;
  private reportedBytes = 0;
  /** Bytes a pending `read(size)` is waiting for. */
  private pendingReadBytes = 0;
  private idleTimeoutMs = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    info: TunnelSocketInfo,
    private readonly sink: TunnelStreamSink,
  ) {
    super({ allowHalfOpen: true });
    this.streamId = info.streamId;
    this.remoteHost = info.host;
    this.remotePort = info.port;
    this.connecting = info.connecting;
    this.creditOnRead = info.creditOnRead ?? true;
    // Credit for the last bytes, which no further read follows.
    this.on('end', () => this.reportConsumed());
  }

  /** Multiplexer: the stream is open. */
  markConnected(): void {
    if (!this.connecting || this.destroyed) return;
    this.connecting = false;
    this.emit('connect');
    this.emit('ready');
  }

  /** Multiplexer: bytes from the far end. */
  deliver(bytes: Buffer): void {
    if (this.destroyed) return;
    this.touch();
    this.pushedBytes += bytes.byteLength;
    this.push(bytes);
    // A flowing reader may have taken them already.
    this.reportConsumed();
  }

  /** Multiplexer: the far end half-closed. */
  deliverEnd(): void {
    if (this.destroyed) return;
    this.push(null);
  }

  override _read(): void {
    this.reportConsumed();
  }

  /**
   * Node calls `_read` before it takes the bytes `read()` returns, so the
   * bytes a reader just took are counted here, once they left the buffer.
   * Flowing readers and pipes read through this too.
   *
   * A `read(size)` that returns nothing waits for `size` bytes, which may
   * be more than the window. The bytes it will take count as taken, so
   * the sender can send the rest.
   */
  override read(size?: number): unknown {
    const chunk: unknown = super.read(size);
    if (size !== undefined && size > 0) {
      this.pendingReadBytes = chunk === null ? size : 0;
    } else if (size === undefined && chunk !== null) {
      this.pendingReadBytes = 0;
    }
    this.reportConsumed();
    return chunk;
  }

  /**
   * Owner: credits bytes it handled, when the socket does not credit reads.
   * It still counts once the socket closed: the host's dialed socket can
   * accept the last writes after both directions ended.
   */
  credit(bytes: number): void {
    if (this.creditOnRead || bytes <= 0) return;
    this.sink.consumed(bytes);
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.touch();
    this.sink.write(chunk, callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.sink.end(callback);
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    this.clearIdleTimer();
    this.sink.destroyed(error);
    callback(error);
  }

  /**
   * Turns compression of this side's outgoing bytes on or off, for bytes
   * not yet sent. A stream whose first bytes turn out to be TLS (a CONNECT
   * that is not a plain `ws://` upgrade) turns it off before writing them:
   * compressing them gains nothing and would show the relay their
   * compressed sizes. The other side needs no notice, since every message
   * says whether it is compressed.
   */
  setCompression(enabled: boolean): this {
    this.sink.setCompression(enabled);
    return this;
  }

  /**
   * Tunnel sockets carry bytes only: credit counts bytes the reader took,
   * which a decoded buffer no longer shows.
   */
  override setEncoding(_encoding: BufferEncoding): this {
    throw new Error(
      'A tunnel socket carries bytes only; decode what it reads.',
    );
  }

  /** Multiplexer: bytes of this socket went out, so it is not idle. */
  noteActivity(): void {
    this.touch();
  }

  /** Emits `timeout` after `ms` without reads or writes; 0 turns it off. */
  setTimeout(ms: number, onTimeout?: () => void): this {
    this.idleTimeoutMs = ms;
    if (onTimeout) {
      if (ms === 0) this.removeListener('timeout', onTimeout);
      else this.once('timeout', onTimeout);
    }
    this.touch();
    return this;
  }

  setNoDelay(): this {
    return this;
  }

  setKeepAlive(): this {
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }

  private reportConsumed(): void {
    if (!this.creditOnRead || this.destroyed) return;
    const held = Math.max(0, this.readableLength - this.pendingReadBytes);
    const consumed = this.pushedBytes - held - this.reportedBytes;
    if (consumed <= 0) return;
    this.reportedBytes += consumed;
    this.sink.consumed(consumed);
  }

  private touch(): void {
    this.clearIdleTimer();
    if (this.idleTimeoutMs <= 0 || this.destroyed) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.emit('timeout');
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}
