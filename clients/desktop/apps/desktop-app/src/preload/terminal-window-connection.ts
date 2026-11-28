/**
 * The window's own daemon connection (CAN-8069), loaded only once main first
 * admits a window, so no window parses the client and its schemas at startup.
 */
import {
  connectCanopyClient,
  connectCanopyWindowClient,
  type CanopyWindowAdmission,
} from '@canopy/core-client/node';
import { CanopyClientError } from '@canopy/core-client';
import {
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  WORKER_TERMINAL_INSTRUCTION_DEFINITIONS,
  WORKER_TERMINAL_STREAM_DEFINITIONS,
  type CanopyErrorPayload,
} from '@canopy/protocol/canopy-core';
import type {
  TerminalWindowApi,
  TerminalWindowReply,
} from '@canopy/desktop-shared/types';

/** Exactly what the daemon serves a window (CAN-8039) and the window uses. */
const WINDOW_DEFINITIONS = {
  queries: {},
  instructions: {
    ...CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
    'worker.terminal.write':
      WORKER_TERMINAL_INSTRUCTION_DEFINITIONS['worker.terminal.write'],
    'worker.terminal.resize':
      WORKER_TERMINAL_INSTRUCTION_DEFINITIONS['worker.terminal.resize'],
  },
  streams: {
    'worker.terminal.attach':
      WORKER_TERMINAL_STREAM_DEFINITIONS['worker.terminal.attach'],
  },
};

/**
 * 30 s, so the daemon's TTL (4×) is 120 s: a hidden window's timers can run
 * once a minute under Chromium's intensive throttling, and still renew.
 */
const RENEWAL_INTERVAL_MS = 30_000;
const CONNECT_TIMEOUT_MS = 10_000;

export interface TerminalWindowConnectionOptions {
  readonly admit: () => Promise<CanopyWindowAdmission | null>;
  readonly clientInstanceId: string;
  readonly foreground: () => boolean;
}

/** One live window connection; `signal` aborts once it ends for good. */
export type TerminalWindowConnection = Pick<
  TerminalWindowApi,
  'attach' | 'write' | 'resize' | 'close'
> & {
  readonly signal: AbortSignal;
  checkClock(): void;
};

const RECONNECTING: CanopyErrorPayload = {
  kind: 'unavailable',
  message: 'The window is reconnecting to the background service.',
  retry: { kind: 'same_request' },
};

const payloadOf = (error: unknown): CanopyErrorPayload =>
  error instanceof CanopyClientError
    ? error.payload
    : {
        kind: 'internal',
        message: 'The terminal call failed.',
        retry: { kind: 'never' },
      };

async function reply(
  call: () => Promise<unknown>,
): Promise<TerminalWindowReply> {
  try {
    return { ok: true, value: await call() };
  } catch (error) {
    return { ok: false, error: payloadOf(error) };
  }
}

export async function openTerminalWindowConnection(
  options: TerminalWindowConnectionOptions,
): Promise<TerminalWindowConnection | null> {
  const window = await connectCanopyWindowClient({
    admit: options.admit,
    connect: (admission) =>
      connectCanopyClient({
        endpoint: admission.endpoint,
        windowTicket: admission.ticket,
        timeoutMs: CONNECT_TIMEOUT_MS,
        clientName: 'desktop-window',
        clientVersion: '1',
        definitions: WINDOW_DEFINITIONS,
      }),
    lease: {
      clientInstanceId: options.clientInstanceId,
      label: 'Desktop window terminals',
      renewalIntervalMs: RENEWAL_INTERVAL_MS,
      presence: () => ({ interactive: true, foreground: options.foreground() }),
    },
  });
  if (!window) return null;
  return {
    signal: window.signal,
    checkClock: () => window.checkClock(),
    attach: async (params) => {
      try {
        const handle = await window.client.openStream(
          'worker.terminal.attach',
          params,
        );
        const frames = handle.frames[Symbol.asyncIterator]();
        return {
          ok: true,
          stream: {
            next: async () => {
              const next = await frames.next();
              return next.done
                ? { done: true }
                : { done: false, value: next.value };
            },
            close: () => {
              handle.close();
              return Promise.resolve();
            },
          },
        };
      } catch (error) {
        return { ok: false, error: payloadOf(error) };
      }
    },
    // While the lease reconnects, its closed client reports a call it never
    // sends as an unknown outcome; this one was never sent (CAN-8070).
    write: (params) =>
      window.client.signal.aborted
        ? Promise.resolve({ ok: false, error: RECONNECTING })
        : reply(() =>
            window.client.instruction('worker.terminal.write', params),
          ),
    resize: (params) =>
      window.client.signal.aborted
        ? Promise.resolve({ ok: false, error: RECONNECTING })
        : reply(() =>
            window.client.instruction('worker.terminal.resize', params),
          ),
    close: () => window.close(),
  };
}
