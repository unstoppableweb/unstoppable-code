import {
  CoworkFolderMissingSchema,
  readCoworkFolderMissing,
  type CoworkFolderMissing,
} from '@canopy/protocol/canopy-core';
import { z } from 'zod';
import type { SecureSession, SessionCloseReason } from './session-manager';

/**
 * Request/response and event messaging over one secure session, with
 * keepalive. Both sides are symmetric peers; which methods each side serves
 * is decided by the host and client services built on top.
 */
const RequestSchema = z.object({
  kind: z.literal('request'),
  id: z.number().int().nonnegative(),
  method: z.string().min(1),
  params: z.unknown(),
});
const SuccessSchema = z.object({
  kind: z.literal('response'),
  id: z.number().int().nonnegative(),
  ok: z.literal(true),
  value: z.unknown(),
});
const FailureSchema = z.object({
  kind: z.literal('response'),
  id: z.number().int().nonnegative(),
  ok: z.literal(false),
  error: z.object({
    message: z.string(),
    code: z.string().optional(),
    coworkFolderMissing: CoworkFolderMissingSchema.optional(),
  }),
});
const EventSchema = z.object({
  kind: z.literal('event'),
  name: z.string().min(1),
  payload: z.unknown(),
});
const CloseSchema = z.object({
  kind: z.literal('close'),
  reason: z.string(),
});
const SessionMessageSchema = z.union([
  RequestSchema,
  SuccessSchema,
  FailureSchema,
  EventSchema,
  CloseSchema,
]);

export class RpcRemoteError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly coworkFolderMissing?: CoworkFolderMissing,
  ) {
    super(message);
    this.name = 'RpcRemoteError';
  }
}

export class RpcClosedError extends Error {
  constructor(readonly reason: SessionCloseReason) {
    super('The connection to the other computer closed.');
    this.name = 'RpcClosedError';
  }
}

export type RpcRequestHandler = (
  method: string,
  params: unknown,
) => Promise<unknown>;

export type RpcEventHandler = (name: string, payload: unknown) => void;

export interface RpcPeerOptions {
  onRequest: RpcRequestHandler;
  onEvent: RpcEventHandler;
  keepaliveIntervalMs?: number;
  idleTimeoutMs?: number;
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  /** Time left before the request times out, or null for no deadline. */
  remainingMs: number | null;
  /** When the running timer started; its time is spent from here. */
  startedAt: number;
}

const KEEPALIVE_EVENT = 'rpc.keepalive';
const DEFAULT_KEEPALIVE_MS = 15_000;
const DEFAULT_IDLE_TIMEOUT_MS = 45_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

function errorCode(error: unknown): string | undefined {
  if (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }
  return undefined;
}

export class RpcPeer {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private lastInboundAt = Date.now();
  private closed = false;
  private readonly closeListeners = new Set<
    (reason: SessionCloseReason) => void
  >();

  constructor(
    readonly session: SecureSession,
    private readonly options: RpcPeerOptions,
  ) {
    session.onMessage((value) => this.handleMessage(value));
    // Runs at once for a session that is already closed.
    session.onClose((reason) => this.handleClosed(reason));
    if (this.closed) return;
    // A suspended session waits for its resume deadline, not the idle
    // timeout; idle time counts again from when it is active.
    session.onStateChange((state) => {
      if (state === 'active') {
        this.lastInboundAt = Date.now();
        for (const [id, pending] of Array.from(this.pending))
          this.startDeadline(id, pending);
      } else {
        // A request held for the resume must not time out here and still
        // run there: its deadline waits too.
        for (const pending of Array.from(this.pending.values()))
          this.pauseDeadline(pending);
      }
    });
    const interval = options.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_MS;
    const idleTimeout = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.keepalive = setInterval(() => {
      // Paused while suspended or resuming; pending requests stay pending.
      if (this.session.state !== 'active') return;
      const lastActivity = Math.max(
        this.lastInboundAt,
        this.session.lastReceivedAt,
      );
      if (Date.now() - lastActivity > idleTimeout) {
        this.session.close('timeout');
        return;
      }
      this.notify(KEEPALIVE_EVENT, null);
    }, interval);
    this.keepalive.unref?.();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Requests sent and not yet answered. */
  get pendingRequests(): number {
    return this.pending.size;
  }

  onClose(listener: (reason: SessionCloseReason) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  request(
    method: string,
    params: unknown,
    options: { timeoutMs?: number | null } = {},
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new RpcClosedError('closed'));
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<unknown>((resolve, reject) => {
      const timeoutMs =
        options.timeoutMs === undefined
          ? (this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
          : options.timeoutMs;
      const pending: PendingRequest = {
        resolve,
        reject,
        timer: null,
        remainingMs: timeoutMs,
        startedAt: Date.now(),
      };
      this.pending.set(id, pending);
      this.startDeadline(id, pending);
      const fail = (error: Error): void => {
        if (pending.timer) clearTimeout(pending.timer);
        this.pending.delete(id);
        reject(error);
      };
      let sent: boolean;
      try {
        sent = this.session.sendMessage({
          kind: 'request',
          id,
          method,
          params,
        });
      } catch (error) {
        // Parameters that cannot be serialized fail only this request.
        fail(error instanceof Error ? error : new Error('Request not sent.'));
        return;
      }
      if (!sent) fail(new RpcClosedError('transport_error'));
    });
  }

  /** Runs a request's deadline, unless its session is not active. */
  private startDeadline(id: number, pending: PendingRequest): void {
    if (
      pending.timer !== null ||
      pending.remainingMs === null ||
      this.session.state !== 'active'
    ) {
      return;
    }
    pending.startedAt = Date.now();
    pending.timer = setTimeout(
      () => {
        if (this.pending.get(id) !== pending) return;
        this.pending.delete(id);
        pending.reject(
          new RpcRemoteError(
            'The other computer took too long to answer.',
            'timeout',
          ),
        );
      },
      Math.max(0, pending.remainingMs),
    );
  }

  private pauseDeadline(pending: PendingRequest): void {
    if (pending.timer === null || pending.remainingMs === null) return;
    clearTimeout(pending.timer);
    pending.timer = null;
    pending.remainingMs -= Date.now() - pending.startedAt;
  }

  /**
   * Fire-and-forget; a payload that cannot be serialized is dropped.
   * `onSerialized` is told the message's serialized size, for diagnostics.
   */
  notify(
    name: string,
    payload: unknown,
    onSerialized?: (byteLength: number) => void,
  ): boolean {
    if (this.closed) return false;
    try {
      return this.session.sendMessage(
        { kind: 'event', name, payload },
        { onSerialized },
      );
    } catch {
      return false;
    }
  }

  close(reason: SessionCloseReason = 'closed'): void {
    if (this.closed) return;
    try {
      this.session.sendMessage({ kind: 'close', reason });
    } catch {
      // Closing proceeds regardless.
    }
    // A suspended host session holds the close for the controller's resume.
    this.session.closeAfterDelivery(reason);
  }

  private handleMessage(value: unknown): void {
    this.lastInboundAt = Date.now();
    const parsed = SessionMessageSchema.safeParse(value);
    if (!parsed.success) {
      this.session.close('protocol_error');
      return;
    }
    const message = parsed.data;
    switch (message.kind) {
      case 'request':
        void this.serve(message.id, message.method, message.params);
        return;
      case 'response': {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (pending.timer) clearTimeout(pending.timer);
        if (message.ok) {
          pending.resolve(message.value);
        } else {
          pending.reject(
            Object.assign(
              new RpcRemoteError(
                message.error.message,
                message.error.code,
                message.error.coworkFolderMissing,
              ),
              message.error.coworkFolderMissing,
            ),
          );
        }
        return;
      }
      case 'event':
        if (message.name === KEEPALIVE_EVENT) return;
        this.options.onEvent(message.name, message.payload);
        return;
      case 'close':
        this.session.close('peer_closed');
        return;
    }
  }

  private async serve(
    id: number,
    method: string,
    params: unknown,
  ): Promise<void> {
    try {
      const value = await this.options.onRequest(method, params);
      this.session.sendMessage({ kind: 'response', id, ok: true, value });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Remote request failed.';
      const code = errorCode(error);
      const coworkFolderMissing = readCoworkFolderMissing(error);
      this.session.sendMessage({
        kind: 'response',
        id,
        ok: false,
        error: {
          message,
          ...(code === undefined ? {} : { code }),
          ...(coworkFolderMissing ? { coworkFolderMissing } : {}),
        },
      });
    }
  }

  private handleClosed(reason: SessionCloseReason): void {
    if (this.closed) return;
    this.closed = true;
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
    for (const pending of Array.from(this.pending.values())) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new RpcClosedError(reason));
    }
    this.pending.clear();
    for (const listener of Array.from(this.closeListeners)) listener(reason);
    this.closeListeners.clear();
  }
}
