import type { Duplex } from 'node:stream';
import { z } from 'zod';
import {
  REMOTE_EVENTS,
  REMOTE_METHODS,
  TUNNEL_INITIAL_WINDOW_BYTES,
  TUNNEL_MAX_CHUNK_BYTES,
  TUNNEL_MAX_STREAM_ID,
  TUNNEL_MAX_STREAMS,
  TUNNEL_SESSION_WINDOW_BYTES,
  TunnelCreditParamsSchema,
  TunnelDataParamsSchema,
  TunnelEndParamsSchema,
  TunnelOpenParamsSchema,
  TunnelOpenResultSchema,
  TunnelResetParamsSchema,
  TunnelStreamIdSchema,
  type TunnelDestinationClass,
  type TunnelOpenFailureCode,
  type TunnelOpenResult,
  type TunnelResetCode,
} from '@canopy/protocol/remote-control';
import {
  TunnelClosedError,
  TunnelOpenError,
  TunnelResetError,
  TunnelSocket,
} from './tunnel-socket';

/**
 * Tunnel streams over one control session (docs/remote-control-protocol.md,
 * "Tunnel streams"). Both roles use it: the controller opens streams, the
 * host serves `tunnel.open` through its open handler and splices each
 * stream to the socket the handler returns.
 *
 * Invariants (the randomized golden case checks them):
 *
 * - Ordering. A stream's queue is sent strictly from its head: its data in
 *   write order, then its end; nothing follows its end. Once a stream is
 *   reset, either way, nothing more is sent or delivered for it.
 * - Window accounting. A sender holds at most the window uncredited per
 *   stream (`outstanding`) and the session cap across streams
 *   (`inFlight`); a receiver resets a stream whose bytes pass either
 *   (`uncredited`, `received`). Credit is returned only for bytes the
 *   reader took; the host's reader is its dialed socket, which takes a
 *   byte once it accepted the write. A pending sized read counts the bytes
 *   it waits for as taken. Received bytes are copied, so what a receiver
 *   holds is what it charged. Dropping a stream releases its share on both
 *   counters.
 * - Fairness. Streams send one chunk each in turn. A stream out of window
 *   leaves the turns until its credit returns; streams waiting on the
 *   session cap rejoin first, in the order they started waiting. Data held
 *   back by the session's unacknowledged bytes keeps its turn without
 *   stopping other streams' ends.
 * - Open lifecycle. A controller stream sends nothing before its open
 *   settles; data and an end that arrive before then are held and
 *   delivered on success, dropped on failure. A host stream exists only
 *   once dialed; any message for it while dialing cancels the dial. A
 *   reset is accepted in every state.
 * - Teardown. Session close destroys every stream, dialed socket and
 *   timer; queued writes fail instead of hanging. A socket's `end()`
 *   finishes only once the far end credited every byte before it, so a
 *   failure up to then reaches the writer as an error. A stream that ended
 *   both ways and is fully credited leaves without a reset; on the host,
 *   its dialed socket accepted every byte by then. Destroying a socket
 *   before then cancels its stream with a reset. A failed write, an error,
 *   or a close with a write unfinished on the dialed socket resets a live
 *   stream, and a reset either way destroys the dialed socket.
 *
 * A malformed or overrunning message resets only its stream. Nothing here
 * throws into the session or closes it.
 */

/** The session the streams travel over; an RPC peer is one. */
export interface TunnelTransport {
  /** Returns false when the session can no longer send. */
  notify(
    name: string,
    payload: unknown,
    options: { compress: boolean },
  ): boolean;
  request(
    method: string,
    params: unknown,
    options: { timeoutMs: number | null },
  ): Promise<unknown>;
  /**
   * Sealed bytes the session holds for a resume and the peer has not
   * acknowledged. Stream data and credit wait while it is high. A session
   * that does not resume holds none.
   */
  heldBytes?(): number;
  /** Told when held bytes are let go, usually because an ack arrived. */
  onHeldBytesReleased?(listener: () => void): () => void;
}

export interface TunnelOpenRequest {
  host: string;
  port: number;
  /**
   * What the controller classified the destination as. The host's policy
   * refuses an open whose resolved address is not of this class.
   */
  class: TunnelDestinationClass;
  /**
   * The controller said at open that the stream carries TLS, so the host
   * sends it uncompressed too. A stream can also turn compression off
   * later on its own side (`TunnelSocket.setCompression`).
   */
  tls: boolean;
}

export type TunnelOpenDecision =
  | { ok: true; socket: Duplex }
  | { ok: false; code: TunnelOpenFailureCode };

/**
 * The host's answer to one `tunnel.open`: a connected socket, or why not.
 * `signal` aborts when the controller cancels or the session closes; a
 * socket returned after that is destroyed.
 */
export type TunnelOpenHandler = (
  request: TunnelOpenRequest,
  signal: AbortSignal,
) => Promise<TunnelOpenDecision>;

/** Refuses every open: the host carries no streams for this controller. */
export const refuseTunnelOpens: TunnelOpenHandler = () =>
  Promise.resolve({ ok: false, code: 'unavailable' });

export interface TunnelStreamMuxOptions {
  role: 'controller' | 'host';
  transport: TunnelTransport;
  /** Host: dials each stream. Without it every open is refused. */
  open?: TunnelOpenHandler;
  /** Both peers must use the window the host advertises. */
  initialWindowBytes?: number;
  maxStreams?: number;
  /** Controller: how long a `tunnel.open` may take. */
  openTimeoutMs?: number;
  /**
   * Held bytes past which stream data and credit wait for an ack; defaults
   * to 4 MiB, a quarter of the re-send buffer.
   */
  heldBytesLimit?: number;
  /** How long small credit waits to coalesce; defaults to 10 ms. */
  creditTickMs?: number;
}

/** One stream's flow-control state, for diagnostics and tests. */
export interface TunnelStreamCounters {
  /** Bytes sent and not yet credited by the far end. */
  outstandingBytes: number;
  /** Bytes received and not yet credited back. */
  uncreditedBytes: number;
}

/** Messages that broke the stream protocol; each reset only its stream. */
export interface TunnelMuxProblems {
  malformed: number;
  overruns: number;
  /** Messages for streams that are gone, usually after a reset crossed. */
  stray: number;
}

type QueueEntry =
  | {
      kind: 'data';
      bytes: Buffer;
      offset: number;
      done: (error?: Error | null) => void;
    }
  | { kind: 'end'; done: (error?: Error | null) => void };

interface StreamState {
  id: number;
  socket: TunnelSocket;
  /** A controller's stream waits for the host's answer before sending. */
  open: boolean;
  compress: boolean;
  queue: QueueEntry[];
  outstanding: number;
  localEnded: boolean;
  uncredited: number;
  /** Consumed by the reader, not yet credited back. */
  pendingCredit: number;
  remoteEnded: boolean;
  /** The client's first byte was seen, so TLS detection is done. */
  sniffed: boolean;
  /**
   * Controller: bytes and an end that came before its open settled, held
   * until it does. The open's answer was sent first, but its promise may
   * settle after messages read in the same batch.
   */
  early: Buffer[];
  earlyEnd: boolean;
  /** The sent end's callback, run once every byte before it is credited. */
  endDone: ((error?: Error | null) => void) | null;
}

/** Chunks one pump sends before yielding to the event loop. */
const BURST_CHUNKS = 16;
/**
 * Held bytes past which stream data and credit wait for an ack: a quarter
 * of the session's 16 MiB re-send buffer, so sealing overhead, control
 * messages and RPC traffic can never push it over and end resumability.
 */
const DEFAULT_HELD_BYTES_LIMIT = 4 * 1024 * 1024;
/** Credit waits this long to coalesce, unless a quarter window is due. */
const CREDIT_TICK_MS = 10;
const DEFAULT_OPEN_TIMEOUT_MS = 30_000;
/** A TLS record's content type for a handshake: a ClientHello starts so. */
const TLS_HANDSHAKE_RECORD = 0x16;

const StreamRefSchema = z.object({ streamId: TunnelStreamIdSchema });

export class TunnelStreamMux {
  private readonly streams = new Map<number, StreamState>();
  /** Host: opens still dialing, by stream id. */
  private readonly dialing = new Map<number, AbortController>();
  /**
   * Host: every dialed socket until it closes, by its stream's id, including
   * one still open after its stream completed. It keeps its place under the
   * stream limit until then, and a session close reaches it too.
   */
  private readonly destinations = new Map<Duplex, number>();
  /** Streams with queued work, in round-robin order. */
  private readonly ready = new Set<StreamState>();
  /** Streams held back only by the session-wide cap. */
  private readonly sessionBlocked = new Set<StreamState>();
  private readonly window: number;
  private readonly maxStreams: number;
  private inFlight = 0;
  private received = 0;
  /** Controller: the next id; host: the largest id opened so far. */
  private streamIdCursor = 0;
  private pumpHandle: ReturnType<typeof setImmediate> | null = null;
  /** Streams with credit to return, sent together. */
  private readonly creditDue = new Set<StreamState>();
  private creditTimer: ReturnType<typeof setTimeout> | null = null;
  /** Data or credit is waiting for the session's held bytes to drop. */
  private awaitingRelease = false;
  /** The credit tick passed while held bytes were too high. */
  private creditOverdue = false;
  private readonly stopWatchingHeld: (() => void) | null;
  private closed = false;
  readonly problems: TunnelMuxProblems = {
    malformed: 0,
    overruns: 0,
    stray: 0,
  };

  constructor(private readonly options: TunnelStreamMuxOptions) {
    this.window = options.initialWindowBytes ?? TUNNEL_INITIAL_WINDOW_BYTES;
    this.maxStreams = options.maxStreams ?? TUNNEL_MAX_STREAMS;
    this.stopWatchingHeld =
      options.transport.onHeldBytesReleased?.(() => this.heldReleased()) ??
      null;
  }

  /** Bytes sent on every stream and not yet credited. */
  get inFlightBytes(): number {
    return this.inFlight;
  }

  get streamCount(): number {
    return this.streams.size + this.dialing.size;
  }

  /**
   * Host: places under the stream limit in use: streams open or dialing,
   * and sockets still open after their stream completed.
   */
  private occupiedSlots(): number {
    let flushing = 0;
    for (const streamId of this.destinations.values()) {
      if (!this.streams.has(streamId)) flushing += 1;
    }
    return this.streamCount + flushing;
  }

  counters(streamId: number): TunnelStreamCounters | null {
    const stream = this.streams.get(streamId);
    if (!stream) return null;
    return {
      outstandingBytes: stream.outstanding,
      uncreditedBytes: stream.uncredited,
    };
  }

  /**
   * Controller: opens a stream to `host:port` on the host. The socket emits
   * `connect` once the host opened it, or is destroyed with a
   * {@link TunnelOpenError}. Writes before then wait.
   */
  openStream(
    host: string,
    port: number,
    options: { class: TunnelDestinationClass; tls?: boolean },
  ): TunnelSocket {
    if (this.options.role !== 'controller') {
      throw new Error('Only a controller opens tunnel streams.');
    }
    const tls = options.tls === true;
    const id = this.streamIdCursor + 1;
    const stream = this.createStream(id, host, port, tls, false);
    if (this.closed || id > TUNNEL_MAX_STREAM_ID) {
      const error = this.closed
        ? new TunnelClosedError()
        : new TunnelOpenError('limit');
      // Its error and close events still come after the caller listens.
      stream.socket.destroy(error);
      return stream.socket;
    }
    this.streamIdCursor = id;
    this.streams.set(id, stream);
    this.options.transport
      .request(
        REMOTE_METHODS.tunnelOpen,
        {
          streamId: id,
          host,
          port,
          class: options.class,
          ...(tls ? { tls } : {}),
        },
        { timeoutMs: this.options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS },
      )
      .then(
        (value) => {
          const result = TunnelOpenResultSchema.safeParse(value);
          this.settleOpen(
            stream,
            result.success ? result.data : { ok: false, code: 'unavailable' },
          );
        },
        () => {
          // No answer, perhaps a timeout: the host may still be dialing.
          if (this.streams.get(stream.id) === stream)
            this.send(
              REMOTE_EVENTS.tunnelReset,
              { streamId: id, code: 'cancelled' },
              stream,
            );
          this.settleOpen(stream, { ok: false, code: 'unavailable' });
        },
      );
    return stream.socket;
  }

  /**
   * Host: serves one `tunnel.open`. Parameters that fail the schema, or an
   * id the controller used before, are refused as a failed request.
   */
  async serveOpen(params: unknown): Promise<TunnelOpenResult> {
    const request = TunnelOpenParamsSchema.parse(params);
    if (this.options.role !== 'host' || this.closed) {
      return { ok: false, code: 'unavailable' };
    }
    // Ids only grow, so a late message for an old stream never reaches a
    // new one.
    if (request.streamId <= this.streamIdCursor) {
      throw new Error('Tunnel stream ids must increase.');
    }
    this.streamIdCursor = request.streamId;
    if (this.occupiedSlots() >= this.maxStreams) {
      return { ok: false, code: 'limit' };
    }
    const open = this.options.open ?? refuseTunnelOpens;
    const abort = new AbortController();
    this.dialing.set(request.streamId, abort);
    const tls = request.tls === true;
    let decision: TunnelOpenDecision;
    try {
      decision = await open(
        {
          host: request.host,
          port: request.port,
          class: request.class,
          tls,
        },
        abort.signal,
      );
    } catch {
      decision = { ok: false, code: 'unreachable' };
    } finally {
      this.dialing.delete(request.streamId);
    }
    if (!decision.ok) return { ok: false, code: decision.code };
    if (abort.signal.aborted || this.closed) {
      decision.socket.destroy();
      return { ok: false, code: 'unavailable' };
    }
    const stream = this.createStream(
      request.streamId,
      request.host,
      request.port,
      tls,
      true,
    );
    this.streams.set(stream.id, stream);
    const destination = decision.socket;
    this.destinations.set(destination, stream.id);
    destination.once('close', () => this.destinations.delete(destination));
    // A failed write or an error resets the stream while it lives, also
    // after the stream's own socket closed with the upload not yet written.
    splice(stream.socket, destination, () => {
      if (this.isLive(stream)) this.reset(stream, 'error');
    });
    return { ok: true };
  }

  /**
   * Routes one session event. Returns whether it was a tunnel event; it
   * never throws.
   */
  handleEvent(name: string, payload: unknown): boolean {
    try {
      switch (name) {
        case REMOTE_EVENTS.tunnelData:
          this.receiveData(payload);
          return true;
        case REMOTE_EVENTS.tunnelCredit:
          this.receiveCredit(payload);
          return true;
        case REMOTE_EVENTS.tunnelEnd:
          this.receiveEnd(payload);
          return true;
        case REMOTE_EVENTS.tunnelReset:
          this.receiveReset(payload);
          return true;
        default:
          return false;
      }
    } catch {
      // A failing socket must not reach the session's message handler.
      this.problems.malformed += 1;
      return true;
    }
  }

  /** The session closed: every stream ends with a connection reset. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pumpHandle) clearImmediate(this.pumpHandle);
    this.pumpHandle = null;
    if (this.creditTimer) clearTimeout(this.creditTimer);
    this.creditTimer = null;
    this.creditDue.clear();
    this.stopWatchingHeld?.();
    for (const abort of Array.from(this.dialing.values())) abort.abort();
    this.dialing.clear();
    for (const destination of Array.from(this.destinations.keys()))
      destination.destroy();
    this.destinations.clear();
    for (const stream of Array.from(this.streams.values())) {
      const error = new TunnelClosedError();
      this.forget(stream, error);
      stream.socket.destroy(error);
    }
  }

  private createStream(
    id: number,
    host: string,
    port: number,
    tls: boolean,
    open: boolean,
  ): StreamState {
    const stream: StreamState = {
      id,
      socket: new TunnelSocket(
        {
          streamId: id,
          host,
          port,
          connecting: !open,
          // The host credits bytes once its dialed socket accepted them.
          creditOnRead: this.options.role === 'controller',
        },
        {
          write: (chunk, done) => this.enqueue(stream, chunk, done),
          end: (done) => this.enqueueEnd(stream, done),
          consumed: (bytes) => this.consumed(stream, bytes),
          setCompression: (enabled) => {
            stream.compress = enabled;
          },
          destroyed: (error) => this.socketDestroyed(stream, error),
        },
      ),
      open,
      compress: !tls,
      queue: [],
      outstanding: 0,
      localEnded: false,
      uncredited: 0,
      pendingCredit: 0,
      remoteEnded: false,
      sniffed: false,
      early: [],
      earlyEnd: false,
      endDone: null,
    };
    return stream;
  }

  private settleOpen(stream: StreamState, result: TunnelOpenResult): void {
    if (this.streams.get(stream.id) !== stream) return;
    if (!result.ok) {
      const error = new TunnelOpenError(result.code);
      this.forget(stream, error);
      stream.socket.destroy(error);
      return;
    }
    stream.open = true;
    stream.socket.markConnected();
    const early = stream.early.splice(0);
    for (const bytes of early) stream.socket.deliver(bytes);
    if (stream.earlyEnd) {
      stream.earlyEnd = false;
      stream.socket.deliverEnd();
      this.completeIfDone(stream);
    }
    this.markReady(stream);
  }

  private isLive(stream: StreamState): boolean {
    return !this.closed && this.streams.get(stream.id) === stream;
  }

  private enqueue(
    stream: StreamState,
    chunk: Buffer,
    done: (error?: Error | null) => void,
  ): void {
    if (!this.isLive(stream)) {
      done(new TunnelClosedError());
      return;
    }
    if (chunk.byteLength === 0) {
      done();
      return;
    }
    stream.queue.push({ kind: 'data', bytes: chunk, offset: 0, done });
    this.markReady(stream);
  }

  private enqueueEnd(
    stream: StreamState,
    done: (error?: Error | null) => void,
  ): void {
    if (!this.isLive(stream)) {
      done(new TunnelClosedError());
      return;
    }
    stream.queue.push({ kind: 'end', done });
    this.markReady(stream);
  }

  private markReady(stream: StreamState): void {
    if (stream.queue.length === 0 || !this.isLive(stream)) return;
    this.ready.add(stream);
    this.schedulePump();
  }

  private schedulePump(): void {
    if (this.pumpHandle !== null || this.closed) return;
    this.pumpHandle = setImmediate(() => {
      this.pumpHandle = null;
      this.pump();
    });
  }

  /**
   * Sends queued work one chunk per stream in turn. A stream out of credit
   * leaves the rotation until credit returns.
   */
  private pump(): void {
    this.flushCredits(this.creditOverdue);
    let sent = 0;
    let blocked = false;
    while (sent < BURST_CHUNKS && !this.closed) {
      let progressed = false;
      for (const stream of Array.from(this.ready)) {
        if (sent >= BURST_CHUNKS || this.closed) break;
        const head = stream.queue[0];
        // Data waits for an ack to make room in the re-send buffer and
        // keeps its turn; other streams' ends still go out.
        if (head?.kind === 'data' && stream.open && this.heldBacklog()) {
          blocked = true;
          continue;
        }
        this.ready.delete(stream);
        if (!head || !stream.open || !this.isLive(stream)) continue;
        if (head.kind === 'end') {
          stream.queue.shift();
          stream.localEnded = true;
          if (
            !this.send(REMOTE_EVENTS.tunnelEnd, { streamId: stream.id }, stream)
          )
            return;
          stream.endDone = head.done;
          this.settleEnd(stream);
          this.completeIfDone(stream);
          sent += 1;
          progressed = true;
          continue;
        }
        const streamRoom = this.window - stream.outstanding;
        if (streamRoom <= 0) continue;
        const sessionRoom = TUNNEL_SESSION_WINDOW_BYTES - this.inFlight;
        if (sessionRoom <= 0) {
          this.sessionBlocked.add(stream);
          continue;
        }
        const size = Math.min(
          head.bytes.byteLength - head.offset,
          TUNNEL_MAX_CHUNK_BYTES,
          streamRoom,
          sessionRoom,
        );
        const bytes = head.bytes.subarray(head.offset, head.offset + size);
        // The controller is the client: its first byte says whether it
        // speaks TLS, whatever the open said.
        if (this.options.role === 'controller') this.sniffClient(stream, bytes);
        if (
          !this.send(
            REMOTE_EVENTS.tunnelData,
            { streamId: stream.id, bytes },
            stream,
          )
        )
          return;
        stream.outstanding += size;
        this.inFlight += size;
        head.offset += size;
        stream.socket.noteActivity();
        if (head.offset === head.bytes.byteLength) {
          stream.queue.shift();
          head.done();
        }
        sent += 1;
        progressed = true;
        // To the back of the rotation.
        if (stream.queue.length > 0) this.ready.add(stream);
      }
      // Only streams waiting for an ack are left.
      if (!progressed) break;
    }
    if (blocked) this.awaitingRelease = true;
    if (sent >= BURST_CHUNKS && this.ready.size > 0) this.schedulePump();
  }

  /**
   * The client's first byte opens a TLS handshake record (0x16) when the
   * stream carries TLS, as an https CONNECT does; plain HTTP and a ws://
   * upgrade start with a method name. Both sides then stop compressing
   * the stream, with no message between them.
   */
  private sniffClient(stream: StreamState, bytes: Uint8Array): void {
    if (stream.sniffed) return;
    stream.sniffed = true;
    if (bytes[0] === TLS_HANDSHAKE_RECORD) stream.compress = false;
  }

  /** Sends one stream message; false once the session cannot send. */
  private send(name: string, payload: unknown, stream: StreamState): boolean {
    return this.options.transport.notify(name, payload, {
      compress: stream.compress,
    });
  }

  /** The session holds too many unacknowledged bytes to send more data. */
  private heldBacklog(): boolean {
    return (
      (this.options.transport.heldBytes?.() ?? 0) >
      (this.options.heldBytesLimit ?? DEFAULT_HELD_BYTES_LIMIT)
    );
  }

  /** An ack let go of held bytes: resume what waited, off the receive path. */
  private heldReleased(): void {
    if (!this.awaitingRelease || this.closed || this.heldBacklog()) return;
    this.awaitingRelease = false;
    this.schedulePump();
  }

  /**
   * Credit for bytes the reader took. It is coalesced per stream and sent
   * once a quarter window is due, or on a short tick.
   */
  private consumed(stream: StreamState, bytes: number): void {
    if (!this.isLive(stream)) return;
    stream.pendingCredit += bytes;
    this.creditDue.add(stream);
    if (stream.pendingCredit >= this.window / 4) this.flushCredits(false);
    else this.scheduleCreditFlush();
  }

  private scheduleCreditFlush(): void {
    if (this.creditTimer !== null || this.closed) return;
    this.creditTimer = setTimeout(() => {
      this.creditTimer = null;
      this.flushCredits(true);
    }, this.options.creditTickMs ?? CREDIT_TICK_MS);
    this.creditTimer.unref?.();
  }

  /**
   * Sends credit that is due: a quarter window or more, or any amount once
   * the tick passed (`all`). Nothing goes while held bytes are too high;
   * smaller credit waits for its tick.
   */
  private flushCredits(all: boolean): void {
    if (this.creditDue.size === 0 || this.closed) return;
    if (this.heldBacklog()) {
      this.awaitingRelease = true;
      if (all) this.creditOverdue = true;
      return;
    }
    if (all) {
      this.creditOverdue = false;
      if (this.creditTimer) clearTimeout(this.creditTimer);
      this.creditTimer = null;
    }
    const quarter = this.window / 4;
    for (const stream of Array.from(this.creditDue)) {
      const credit = stream.pendingCredit;
      if (!this.isLive(stream) || credit === 0) {
        this.creditDue.delete(stream);
        continue;
      }
      if (!all && credit < quarter) continue;
      this.creditDue.delete(stream);
      stream.pendingCredit = 0;
      stream.uncredited -= credit;
      this.received -= credit;
      this.send(
        REMOTE_EVENTS.tunnelCredit,
        { streamId: stream.id, bytes: credit },
        stream,
      );
      this.completeIfDone(stream);
    }
    if (this.creditDue.size > 0) this.scheduleCreditFlush();
  }

  private socketDestroyed(stream: StreamState, error: Error | null): void {
    if (!this.isLive(stream)) return;
    // Both directions ended, the far end credited every byte written and
    // the reader took everything: the socket closed on its own. The stream
    // stays until the last credit goes out, so neither side's accounting
    // runs ahead of the other's. A destroy before then cancels it.
    if (
      error === null &&
      stream.localEnded &&
      stream.queue.length === 0 &&
      stream.socket.writableFinished &&
      stream.socket.readableEnded
    ) {
      this.completeIfDone(stream);
      return;
    }
    this.forget(stream, error ?? new TunnelClosedError());
    this.send(
      REMOTE_EVENTS.tunnelReset,
      { streamId: stream.id, code: error ? 'error' : 'cancelled' },
      stream,
    );
  }

  /**
   * Both sides ended and every byte both ways is credited: the stream is
   * done, with no reset.
   */
  private completeIfDone(stream: StreamState): void {
    if (
      stream.localEnded &&
      stream.remoteEnded &&
      stream.queue.length === 0 &&
      stream.outstanding === 0 &&
      stream.uncredited === 0 &&
      this.streams.get(stream.id) === stream
    ) {
      this.forget(stream);
    }
  }

  /**
   * The far end credited every byte this side sent before its end, so the
   * socket's `end()` finishes. Until then a reset fails it.
   */
  private settleEnd(stream: StreamState): void {
    if (stream.outstanding > 0 || !stream.endDone) return;
    const done = stream.endDone;
    stream.endDone = null;
    done();
  }

  /**
   * Drops a stream and its share of the session's accounting. Writes still
   * queued on it fail with `error`; streams waiting on the session's cap
   * get the room it held.
   */
  private forget(
    stream: StreamState,
    error: Error = new TunnelClosedError(),
  ): void {
    if (this.streams.get(stream.id) === stream) this.streams.delete(stream.id);
    const freed = stream.outstanding;
    this.inFlight -= stream.outstanding;
    this.received -= stream.uncredited;
    stream.outstanding = 0;
    stream.uncredited = 0;
    stream.pendingCredit = 0;
    this.ready.delete(stream);
    this.sessionBlocked.delete(stream);
    this.creditDue.delete(stream);
    stream.early.length = 0;
    const queued = stream.queue.splice(0);
    for (const entry of queued) entry.done(error);
    const endDone = stream.endDone;
    stream.endDone = null;
    endDone?.(error);
    if (freed > 0) this.wakeSessionBlocked();
  }

  /**
   * The session's cap has room again: streams waiting on it rejoin the
   * turns at the front, in the order they started waiting, ahead of any
   * stream already in the rotation.
   */
  private wakeSessionBlocked(): void {
    if (this.sessionBlocked.size === 0) return;
    const woken = Array.from(this.sessionBlocked).filter(
      (blocked) => blocked.queue.length > 0 && this.isLive(blocked),
    );
    this.sessionBlocked.clear();
    if (woken.length === 0) return;
    const rest = Array.from(this.ready).filter(
      (stream) => !woken.includes(stream),
    );
    this.ready.clear();
    for (const stream of [...woken, ...rest]) this.ready.add(stream);
    this.schedulePump();
  }

  /** Resets one stream for a protocol problem and tells the far end. */
  private reset(stream: StreamState, code: TunnelResetCode): void {
    const error = new TunnelResetError(code);
    this.forget(stream, error);
    this.send(REMOTE_EVENTS.tunnelReset, { streamId: stream.id, code }, stream);
    stream.socket.destroy(error);
    this.abandonDestination(stream.id);
  }

  /**
   * Host: a reset abandons the stream's dialed socket. Destroying the
   * stream's own socket does not reach it once that socket closed and left
   * it writing, or after the stream completed.
   */
  private abandonDestination(streamId: number): void {
    for (const [destination, id] of Array.from(this.destinations)) {
      if (id === streamId) destination.destroy();
    }
  }

  /** A malformed message: reset its stream if it names a live one. */
  private malformed(payload: unknown): void {
    this.problems.malformed += 1;
    const ref = StreamRefSchema.safeParse(payload);
    if (!ref.success) return;
    const stream = this.streams.get(ref.data.streamId);
    if (stream) this.reset(stream, 'protocol');
    else this.refuseDialing(ref.data.streamId);
  }

  /**
   * Host: a message for a stream still dialing. The dial is cancelled and
   * the stream reset, so no byte is lost silently; a socket the dial still
   * returns is destroyed. Returns whether the stream was dialing.
   */
  private refuseDialing(streamId: number): boolean {
    const dialing = this.dialing.get(streamId);
    if (!dialing) return false;
    dialing.abort();
    this.options.transport.notify(
      REMOTE_EVENTS.tunnelReset,
      { streamId, code: 'protocol' },
      { compress: false },
    );
    return true;
  }

  /**
   * The stream a data, credit or end message is for. On the host nothing
   * but a reset may arrive for a stream still dialing. On the controller,
   * data and an end may arrive for a stream whose open has not settled:
   * the host answered first, but the answer's promise can settle after
   * messages read in the same batch. Those are held, not delivered, until
   * the open settles (`openingAllowed`).
   */
  private live(streamId: number, openingAllowed = false): StreamState | null {
    const stream = this.streams.get(streamId);
    if (stream?.open || (stream && openingAllowed)) return stream;
    if (stream) {
      this.problems.malformed += 1;
      this.reset(stream, 'protocol');
      return null;
    }
    if (this.refuseDialing(streamId)) {
      this.problems.malformed += 1;
      return null;
    }
    this.problems.stray += 1;
    return null;
  }

  private receiveData(payload: unknown): void {
    const parsed = TunnelDataParamsSchema.safeParse(payload);
    if (!parsed.success) {
      this.malformed(payload);
      return;
    }
    const stream = this.live(parsed.data.streamId, true);
    if (!stream) return;
    const size = parsed.data.bytes.byteLength;
    if (stream.remoteEnded) {
      this.problems.malformed += 1;
      this.reset(stream, 'protocol');
      return;
    }
    if (
      stream.uncredited + size > this.window ||
      this.received + size > TUNNEL_SESSION_WINDOW_BYTES
    ) {
      this.problems.overruns += 1;
      this.reset(stream, 'flow_control');
      return;
    }
    stream.uncredited += size;
    this.received += size;
    const bytes = parsed.data.bytes;
    if (this.options.role === 'host') this.sniffClient(stream, bytes);
    // A copy: a view would keep the whole decoded message alive while only
    // its bytes count against the window.
    const chunk = Buffer.from(bytes);
    if (stream.open) stream.socket.deliver(chunk);
    else stream.early.push(chunk);
  }

  private receiveCredit(payload: unknown): void {
    const parsed = TunnelCreditParamsSchema.safeParse(payload);
    if (!parsed.success) {
      this.malformed(payload);
      return;
    }
    const stream = this.live(parsed.data.streamId);
    if (!stream) return;
    if (parsed.data.bytes > stream.outstanding) {
      this.problems.malformed += 1;
      this.reset(stream, 'protocol');
      return;
    }
    stream.outstanding -= parsed.data.bytes;
    this.inFlight -= parsed.data.bytes;
    this.settleEnd(stream);
    // Streams already waiting on the session's cap go first, in the order
    // they started waiting, so a stream that keeps returning credit cannot
    // take every freed byte and starve them.
    this.wakeSessionBlocked();
    this.markReady(stream);
    this.completeIfDone(stream);
  }

  private receiveEnd(payload: unknown): void {
    const parsed = TunnelEndParamsSchema.safeParse(payload);
    if (!parsed.success) {
      this.malformed(payload);
      return;
    }
    const stream = this.live(parsed.data.streamId, true);
    if (!stream) return;
    if (stream.remoteEnded) {
      this.problems.malformed += 1;
      this.reset(stream, 'protocol');
      return;
    }
    stream.remoteEnded = true;
    if (!stream.open) {
      stream.earlyEnd = true;
      return;
    }
    stream.socket.deliverEnd();
    this.completeIfDone(stream);
  }

  private receiveReset(payload: unknown): void {
    const parsed = TunnelResetParamsSchema.safeParse(payload);
    const ref = parsed.success
      ? parsed.data
      : StreamRefSchema.safeParse(payload).data;
    if (!parsed.success) this.problems.malformed += 1;
    if (!ref) return;
    // A host's controller cancelling an open still dialing.
    const dialing = this.dialing.get(ref.streamId);
    if (dialing) {
      dialing.abort();
      return;
    }
    // Also for a stream already complete whose socket is still open.
    this.abandonDestination(ref.streamId);
    // Accepted for a stream still opening too: that is how either side
    // cancels it.
    const stream = this.streams.get(ref.streamId);
    if (!stream) {
      this.problems.stray += 1;
      return;
    }
    // Never answered: a reset for a reset would bounce.
    const error = new TunnelResetError(
      parsed.success ? parsed.data.code : 'protocol',
    );
    this.forget(stream, error);
    stream.socket.destroy(error);
  }
}

/**
 * Host: joins a stream to the socket its open handler dialed. Each side's
 * end half-closes the other; an error or an early close on either resets.
 * Uploaded bytes are credited once the socket accepted each write, so the
 * stream completes only after every byte was written; a failed write or a
 * socket error calls `fail`, which resets it instead.
 */
function splice(stream: TunnelSocket, socket: Duplex, fail: () => void): void {
  let writing = 0;
  stream.on('data', (chunk: Buffer) => {
    writing += 1;
    const more = socket.write(chunk, (error) => {
      writing -= 1;
      if (error) fail();
      else stream.credit(chunk.byteLength);
    });
    if (!more) stream.pause();
  });
  socket.on('drain', () => stream.resume());
  stream.on('end', () => socket.end());
  socket.pipe(stream);
  socket.on('error', (error: Error) => {
    fail();
    stream.destroy(error);
  });
  socket.on('close', () => {
    // Closed with a write it never finished: those bytes are lost.
    if (writing > 0) fail();
    if (!stream.writableEnded || !stream.readableEnded) stream.destroy();
  });
  stream.on('error', () => socket.destroy());
  // A stream socket that ended both ways leaves the dialed socket to finish
  // its writes, which the stream waits for, and close on its own; any other
  // close abandons it.
  stream.on('close', () => {
    if (stream.errored || !stream.readableEnded || !stream.writableFinished)
      socket.destroy();
  });
}
