import {
  CANOPY_HOST_EXECUTION_MEMBER,
  CanopyJsonRpcMessageSchema,
  type CanopyCallerDescriptor,
  type CanopyJsonRpcMessage,
} from '@canopy/protocol/canopy-core';
import {
  PIPELINE_SESSION_LEASE_METHOD,
  PIPELINE_SESSION_MAX_PLAINTEXT_BYTES,
  PipelineSessionLeaseSchema,
  type PipelineSessionLease,
} from '@canopy/protocol/pipeline-relay';
import {
  CanopyOperationError,
  canopyInvalidArgumentError,
  canopyUnavailableError,
} from '../../../runtime/errors';
import { serveLocalWorkerBinding } from '../../../runtime/local-worker-binding-server';
import {
  errorResponse,
  type WorkerBindingConnection,
  type WorkerBindingDefinitions,
} from '../../../runtime/local-worker-binding-wire';
import type { CanopyDispatcher } from '../../../runtime/types';
import {
  createPipelineRelaySession,
  type PipelineRelaySessionFailure,
} from './relay-session';

/*
 * A cloud runner's end of one relay attachment (CP-11, CAN-6161): the
 * end-to-end session in its `runner` role, and the worker binding served
 * over it, as the trusted web core. Every request runs as `caller`, the
 * caller the runner credential names; nothing in params says who calls.
 *
 * The leg refuses `_execution` (CAN-6161 No `_execution`): host-local launch,
 * owner and host-step values are the runner's own and never cross the relay,
 * so a request that carries them is answered `invalid_argument` without
 * reaching a handler. A leg lives for one attachment: when the relay drops
 * it, every call and stream it served ends, and the runner dials again.
 */

export interface PipelineRelayLegOptions {
  readonly dispatcher: CanopyDispatcher;
  /** The runner dispatcher's maps. */
  readonly definitions: WorkerBindingDefinitions;
  /** The web core, as the runner credential names it, with its grants. */
  readonly caller: CanopyCallerDescriptor;
  /** The incarnation's 32-byte session key, from its activation. */
  readonly sessionKey: Uint8Array;
  /** Sends one frame on the runner's relay connection; false once it closed. */
  readonly send: (text: string) => boolean;
  /**
   * The leg ended on its own: a frame it could not accept, a session that
   * failed, or a binding that stopped. The runner closes the connection.
   */
  readonly onEnded?: (reason: PipelineRelayLegEnd) => void;
  /** Supplies the session's handshake nonce; random by default. */
  readonly nonce?: () => Buffer;
  /**
   * The web core's lease notice (`pipeline.session.lease`, CP-11), which
   * the leg answers itself and never passes to the binding. Without it a
   * notice is dropped. Answering `'refuse'` ends the leg at once, before
   * anything else it holds or receives reaches the binding.
   */
  readonly onLease?: (lease: PipelineSessionLease) => 'refuse' | void;
  /**
   * Observes each envelope the leg opened (`in`) or sealed (`out`), as a
   * conformance kit records the wire. The leg itself logs none.
   */
  readonly trace?: (direction: 'in' | 'out', envelope: string) => void;
}

export type PipelineRelayLegEnd =
  | { readonly kind: 'session'; readonly reason: PipelineRelaySessionFailure }
  | { readonly kind: 'binding' };

export interface PipelineRelayLeg {
  /** One frame the relay delivered on the runner's connection. */
  receive(text: string): void;
  /** The connection closed: the session and everything served on it end. */
  close(): void;
  /** Aborts once the leg has ended, for any reason. */
  readonly signal: AbortSignal;
  /** Its session finished its handshake: a core is on the other end. */
  readonly established: boolean;
}

function carriesHostExecution(message: CanopyJsonRpcMessage): boolean {
  return (
    'method' in message &&
    Object.prototype.hasOwnProperty.call(
      message.params,
      CANOPY_HOST_EXECUTION_MEMBER,
    )
  );
}

function isLeaseNotice(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'method' in value &&
    value.method === PIPELINE_SESSION_LEASE_METHOD
  );
}

function hostExecutionRefused(): CanopyOperationError {
  return canopyInvalidArgumentError(
    'A relay request never carries host execution values.',
  );
}

export function servePipelineRelayLeg(
  options: PipelineRelayLegOptions,
): PipelineRelayLeg {
  const ended = new AbortController();
  const inbound: CanopyJsonRpcMessage[] = [];
  let waiting:
    | {
        resolve(message: CanopyJsonRpcMessage): void;
        reject(error: Error): void;
      }
    | undefined;

  const end = (reason: PipelineRelayLegEnd | null): void => {
    if (ended.signal.aborted) return;
    ended.abort();
    session.close();
    waiting?.reject(canopyUnavailableError());
    waiting = undefined;
    if (reason !== null) options.onEnded?.(reason);
  };

  const deliver = (message: CanopyJsonRpcMessage): void => {
    const receiver = waiting;
    waiting = undefined;
    if (receiver) receiver.resolve(message);
    else inbound.push(message);
  };

  const sendEnvelope = (message: CanopyJsonRpcMessage): void => {
    const text = JSON.stringify(message);
    // Refused before a byte is written: the binding answers the call, or
    // ends the stream, with the typed error and stays open.
    if (Buffer.byteLength(text, 'utf8') > PIPELINE_SESSION_MAX_PLAINTEXT_BYTES)
      throw new CanopyOperationError({
        kind: 'resource_exhausted',
        message: 'The reply is larger than the relay carries.',
        retry: { kind: 'never' },
      });
    options.trace?.('out', text);
    if (!session.send(text)) {
      end({ kind: 'binding' });
      throw canopyUnavailableError();
    }
  };

  const session = createPipelineRelaySession({
    role: 'runner',
    sessionKey: options.sessionKey,
    send: options.send,
    onReady: () => undefined,
    onMessage: (plaintext) => {
      options.trace?.('in', plaintext);
      let value: unknown;
      try {
        value = JSON.parse(plaintext);
      } catch {
        end({ kind: 'binding' });
        return;
      }
      // The lease notice is the leg's own, outside the operation namespaces.
      if (isLeaseNotice(value)) {
        const notice = PipelineSessionLeaseSchema.safeParse(value);
        if (!notice.success) end({ kind: 'binding' });
        else if (options.onLease?.(notice.data.params) === 'refuse')
          end({ kind: 'binding' });
        return;
      }
      const parsed = CanopyJsonRpcMessageSchema.safeParse(value);
      if (!parsed.success) {
        end({ kind: 'binding' });
        return;
      }
      const message = parsed.data;
      if (!carriesHostExecution(message)) {
        deliver(message);
        return;
      }
      // A request is answered so its caller does not wait; a notification
      // that carries them is dropped.
      if ('id' in message && message.id !== null)
        try {
          sendEnvelope(errorResponse(message.id, hostExecutionRefused()));
        } catch {
          // The leg ended meanwhile.
        }
    },
    onFailed: (reason) => end({ kind: 'session', reason }),
    ...(options.nonce && { nonce: options.nonce }),
  });

  const connection: WorkerBindingConnection = {
    signal: ended.signal,
    send: (message) =>
      Promise.resolve().then(() => {
        if (ended.signal.aborted) throw canopyUnavailableError();
        sendEnvelope(message);
      }),
    receive: () => {
      if (ended.signal.aborted) return Promise.reject(canopyUnavailableError());
      const next = inbound.shift();
      if (next) return Promise.resolve(next);
      return new Promise((resolve, reject) => {
        waiting = { resolve, reject };
      });
    },
    close: () => end({ kind: 'binding' }),
  };

  const server = serveLocalWorkerBinding({
    dispatcher: options.dispatcher,
    definitions: options.definitions,
    caller: options.caller,
    connection,
  });
  server.signal.addEventListener('abort', () => end({ kind: 'binding' }), {
    once: true,
  });

  return {
    receive: (text) => {
      if (!ended.signal.aborted) session.receive(text);
    },
    close: () => {
      if (ended.signal.aborted) return;
      end(null);
      server.close();
    },
    signal: ended.signal,
    get established() {
      return session.ready;
    },
  };
}
