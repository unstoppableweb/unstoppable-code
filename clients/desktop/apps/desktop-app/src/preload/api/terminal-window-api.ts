import type { CanopyErrorPayload } from '@canopy/protocol/canopy-core';
import {
  IPC_CHANNELS,
  type TerminalWindowApi,
  type TerminalWindowConnectRequest,
  type TerminalWindowConnectResponse,
  type TerminalWindowReconnectRequest,
  type TerminalWindowRouteResponse,
} from '@canopy/desktop-shared/types';
import type {
  TerminalWindowConnection,
  TerminalWindowConnectionOptions,
} from '../terminal-window-connection';

export interface TerminalWindowApiDeps {
  readonly invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  /** Loads the connection module on first use, then opens a connection. */
  readonly open: (
    options: TerminalWindowConnectionOptions,
  ) => Promise<TerminalWindowConnection | null>;
  readonly clientInstanceId: string;
  readonly foreground: () => boolean;
  /** Registers a check for when the page becomes visible again. */
  readonly onVisible: (listener: () => void) => void;
}

/**
 * Never sent, so the same request may go another way (CAN-8070): unlike an
 * unknown outcome, which is `unavailable` with retry `never`.
 */
const NOT_CONNECTED: CanopyErrorPayload = {
  kind: 'unavailable',
  message: "This window isn't connected to the background service.",
  retry: { kind: 'same_request' },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

// Main is trusted; these only tell its answer from its `null`.
const isConnectResponse = (
  value: unknown,
): value is TerminalWindowConnectResponse =>
  isRecord(value) &&
  isRecord(value.endpoint) &&
  isRecord(value.ticket) &&
  isRecord(value.runtime);

const isRouteResponse = (
  value: unknown,
): value is TerminalWindowRouteResponse =>
  isRecord(value) &&
  typeof value.terminalId === 'string' &&
  Array.isArray(value.rights);

/**
 * `window.api.terminalWindow` (CAN-8069): the window's own daemon connection
 * for the terminals main grants it. It connects only to the endpoint and
 * runtime main's verified connection reached, with a ticket main issues for
 * each connection. The renderer's terminal router calls it (CAN-8070).
 */
export function createTerminalWindowApi(
  deps: TerminalWindowApiDeps,
): TerminalWindowApi {
  let opening: Promise<TerminalWindowConnection | null> | null = null;
  let current: TerminalWindowConnection | null = null;
  /** Bumped by `close`, so a connection still opening is closed on arrival. */
  let generation = 0;
  const closedListeners = new Set<() => void>();

  /** Asked for a terminal first; a reconnect says so, and main gates it. */
  const admit = async (
    request: TerminalWindowConnectRequest | TerminalWindowReconnectRequest,
  ): ReturnType<TerminalWindowConnectionOptions['admit']> => {
    const response = await deps.invoke(
      IPC_CHANNELS.terminalWindowConnect,
      'terminalId' in request
        ? { terminalId: request.terminalId }
        : { reconnect: true },
    );
    if (!isConnectResponse(response)) return null;
    return {
      endpoint: response.endpoint,
      ticket: response.ticket,
      runtime: response.runtime,
    };
  };

  /** Asks main first, so a window it keeps on the relay never loads the client. */
  const openAdmitted = async (
    request: TerminalWindowConnectRequest,
  ): Promise<TerminalWindowConnection | null> => {
    let first = await admit(request);
    if (!first) return null;
    return deps.open({
      admit: async () => {
        const admission = first ?? (await admit({ reconnect: true }));
        first = null;
        return admission;
      },
      clientInstanceId: deps.clientInstanceId,
      foreground: deps.foreground,
    });
  };

  const live = (): TerminalWindowConnection | null =>
    current && !current.signal.aborted ? current : null;

  // Registered on the first connection, so preload load touches no DOM.
  let watchingVisibility = false;

  const adopt = (opened: TerminalWindowConnection): void => {
    current = opened;
    opened.signal.addEventListener(
      'abort',
      () => {
        if (current === opened) current = null;
        for (const listener of Array.from(closedListeners)) listener();
      },
      { once: true },
    );
    if (!watchingVisibility) {
      watchingVisibility = true;
      deps.onVisible(() => live()?.checkClock());
    }
  };

  return {
    connect: async (request) => {
      // Main may refuse another terminal's ask; each waiter then asks for its
      // own, one opening at a time.
      while (opening) await opening;
      if (live()) return true;
      const started = generation;
      const mine = openAdmitted(request).catch(() => null);
      opening = mine;
      void mine.then((opened) => {
        if (opening === mine) opening = null;
        if (!opened) return;
        if (started === generation) adopt(opened);
        else void opened.close();
      });
      const opened = await mine;
      return opened !== null && opened === live();
    },
    route: async (request) => {
      if (!live()) return null;
      const granted = await deps.invoke(IPC_CHANNELS.terminalWindowRoute, {
        terminalId: request.terminalId,
      });
      return isRouteResponse(granted) ? granted : null;
    },
    release: async (request) => {
      await deps.invoke(IPC_CHANNELS.terminalWindowRelease, {
        terminalId: request.terminalId,
      });
    },
    attach: (params) =>
      live()?.attach(params) ??
      Promise.resolve({ ok: false, error: NOT_CONNECTED }),
    write: (params) =>
      live()?.write(params) ??
      Promise.resolve({ ok: false, error: NOT_CONNECTED }),
    resize: (params) =>
      live()?.resize(params) ??
      Promise.resolve({ ok: false, error: NOT_CONNECTED }),
    onClosed: (listener) => {
      closedListeners.add(listener);
      return () => void closedListeners.delete(listener);
    },
    close: async () => {
      generation += 1;
      const window = current;
      current = null;
      await window?.close();
    },
  };
}
