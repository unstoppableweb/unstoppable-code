import { z } from 'zod';
import {
  RemoteOperationFailureSchema,
  readRemoteOperationFailure,
  type RemoteOperationFailure,
} from '@canopy/protocol/remote-control';
import { RemoteSessionError } from './errors';
import { MessageCodecError } from './message-codec';
import { defaultScheduler, type SchedulerPort } from './scheduler';
import type { SecureSession, SessionCloseReason } from './session-manager';

/**
 * Request/response and event messaging over one secure session, with
 * keepalive; the message shapes match the desktop's `rpc-peer.ts`.
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
    operationFailure: RemoteOperationFailureSchema.optional(),
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

/** The peer answered with an error and optional curated operation advice. */
export class RpcRemoteError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly operationFailure?: RemoteOperationFailure,
  ) {
    super(message);
    this.name = 'RpcRemoteError';
  }
}

/** The session closed before the request was answered; outcome unknown. */
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
  scheduler?: SchedulerPort;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: unknown;
}

const KEEPALIVE_EVENT = 'rpc.keepalive';
export const RPC_KEEPALIVE_INTERVAL_MS = 15_000;
export const RPC_IDLE_TIMEOUT_MS = 45_000;
export const RPC_REQUEST_TIMEOUT_MS = 120_000;
/** Requests this side may have outstanding at once. */
export const MAX_PENDING_RPC_REQUESTS = 1_024;
/** Requests from the peer this side serves at once; more are refused. */
export const MAX_CONCURRENT_RPC_SERVES = 64;

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
  private keepalive: unknown = null;
  private lastInboundAt: number;
  private closed = false;
  private serving = 0;
  private readonly scheduler: SchedulerPort;
  private readonly closeListeners = new Set<
    (reason: SessionCloseReason) => void
  >();

  constructor(
    readonly session: SecureSession,
    private readonly options: RpcPeerOptions,
  ) {
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.lastInboundAt = this.scheduler.now();
    session.onMessage((value) => this.handleMessage(value));
    // Runs at once for a session that is already closed.
    session.onClose((reason) => this.handleClosed(reason));
    if (this.closed) return;
    const interval = options.keepaliveIntervalMs ?? RPC_KEEPALIVE_INTERVAL_MS;
    const idleTimeout = options.idleTimeoutMs ?? RPC_IDLE_TIMEOUT_MS;
    this.keepalive = this.scheduler.setInterval(() => {
      const lastActivity = Math.max(
        this.lastInboundAt,
        this.session.lastReceivedAt,
      );
      if (this.scheduler.now() - lastActivity > idleTimeout) {
        this.session.close('timeout');
        return;
      }
      this.notify(KEEPALIVE_EVENT, null);
    }, interval);
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

  /**
   * Sends a request. `timeoutMs: null` waits indefinitely (a closing session
   * still rejects with `RpcClosedError`). Never retried.
   */
  request(
    method: string,
    params: unknown,
    options: { timeoutMs?: number | null } = {},
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new RpcClosedError('closed'));
    if (this.pending.size >= MAX_PENDING_RPC_REQUESTS) {
      return Promise.reject(
        new RemoteSessionError(
          'queue_full',
          'Too many requests are waiting for an answer.',
        ),
      );
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<unknown>((resolve, reject) => {
      const timeoutMs =
        options.timeoutMs === undefined
          ? (this.options.requestTimeoutMs ?? RPC_REQUEST_TIMEOUT_MS)
          : options.timeoutMs;
      const timer =
        timeoutMs === null
          ? null
          : this.scheduler.setTimeout(() => {
              this.pending.delete(id);
              reject(
                new RpcRemoteError(
                  'The other computer took too long to answer.',
                  'timeout',
                ),
              );
            }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.session
        .send({ kind: 'request', id, method, params })
        .catch((error: unknown) => {
          const pending = this.pending.get(id);
          if (pending === undefined) return;
          if (pending.timer !== null)
            this.scheduler.clearTimeout(pending.timer);
          this.pending.delete(id);
          // Parameters that cannot be serialized fail only this request.
          reject(
            error instanceof MessageCodecError ||
              (error instanceof RemoteSessionError &&
                error.code === 'queue_full')
              ? error
              : new RpcClosedError('transport_error'),
          );
        });
    });
  }

  /** Fire-and-forget; returns false when the message could not be queued. */
  notify(name: string, payload: unknown): boolean {
    if (this.closed) return false;
    const queued = this.session.enqueue({ kind: 'event', name, payload });
    if (!queued.accepted) return false;
    queued.sent.catch(() => undefined);
    return true;
  }

  close(reason: SessionCloseReason = 'closed'): void {
    if (this.closed) return;
    this.session.send({ kind: 'close', reason }).catch(() => undefined);
    this.session.close(reason);
  }

  private handleMessage(value: unknown): void {
    this.lastInboundAt = this.scheduler.now();
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
        if (pending.timer !== null) this.scheduler.clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.value);
        else
          pending.reject(
            new RpcRemoteError(
              message.error.message,
              message.error.code,
              message.error.operationFailure,
            ),
          );
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
    if (this.serving >= MAX_CONCURRENT_RPC_SERVES) {
      await this.respondError(
        id,
        new RemoteSessionError('queue_full', 'Too many requests at once.'),
      );
      return;
    }
    this.serving += 1;
    try {
      const value = await this.options.onRequest(method, params);
      try {
        await this.session.send({ kind: 'response', id, ok: true, value });
      } catch (error) {
        if (error instanceof MessageCodecError)
          await this.respondError(id, error);
      }
    } catch (error) {
      await this.respondError(id, error);
    } finally {
      this.serving -= 1;
    }
  }

  private async respondError(id: number, error: unknown): Promise<void> {
    const message =
      error instanceof Error ? error.message : 'Remote request failed.';
    const code = errorCode(error);
    const operationFailure = readRemoteOperationFailure(error);
    await this.session
      .send({
        kind: 'response',
        id,
        ok: false,
        error: {
          message,
          ...(code === undefined ? {} : { code }),
          ...(operationFailure ? { operationFailure } : {}),
        },
      })
      .catch(() => undefined);
  }

  private handleClosed(reason: SessionCloseReason): void {
    if (this.closed) return;
    this.closed = true;
    if (this.keepalive !== null) this.scheduler.clearInterval(this.keepalive);
    this.keepalive = null;
    for (const pending of Array.from(this.pending.values())) {
      if (pending.timer !== null) this.scheduler.clearTimeout(pending.timer);
      pending.reject(new RpcClosedError(reason));
    }
    this.pending.clear();
    for (const listener of Array.from(this.closeListeners)) listener(reason);
    this.closeListeners.clear();
  }
}
