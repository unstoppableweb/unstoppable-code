'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ExternalAgentComputer,
  ExternalAgentComputerList,
  ExternalAgentConnectionSummary,
} from '@canopy/protocol/external-agents';
import type { ExternalAgentComputersClient } from '@canopy/app-core';

export type PortalOnlyComputer =
  ExternalAgentComputerList['portalOnly'][number];

/** How often a list that needs watching refreshes while the page is visible. */
const POLL_MS = 10_000;
/**
 * How long polling continues after the last mount, focus, return to visible
 * or explicit load. Each list call that misses the server's presence cache
 * opens a relay connection, so a tab left open must not poll forever.
 */
const POLL_WINDOW_MS = 300_000;
/** Focus and `visibilitychange` fire together; one refresh serves both. */
const MIN_REFRESH_GAP_MS = 2_000;
/** A background request older than this is treated as abandoned. */
const IN_FLIGHT_STALE_MS = 30_000;

export interface ExternalAgentComputersState {
  /** Null until the first successful load. */
  readonly computers: readonly ExternalAgentComputer[] | null;
  readonly portalOnly: readonly PortalOnlyComputer[];
  /** The last explicit load failed and nothing has succeeded since. */
  readonly problem: boolean;
  /** An explicit load: it supersedes any request in flight. */
  readonly load: () => Promise<void>;
  /** Suspends background refreshes while the person acts on a row. */
  readonly setPaused: (paused: boolean) => void;
}

/**
 * True when the list could still change in a way the person is waiting for:
 * nothing connected yet, a computer to connect, or one that is offline,
 * pending removal or still reached through Remote Control.
 */
export function computersNeedWatching(
  state: Pick<ExternalAgentComputersState, 'computers' | 'portalOnly'>,
): boolean {
  const { computers, portalOnly } = state;
  if (computers === null) return false;
  if (computers.length === 0 || portalOnly.length > 0) return true;
  return computers.some(
    (computer) =>
      !(
        computer.agents === 'connected' &&
        computer.online &&
        !computer.viaPortal
      ),
  );
}

function hasDeviceAccess(connection: ExternalAgentConnectionSummary): boolean {
  const desktops = connection.access.desktops;
  return desktops === 'all' || (typeof desktops === 'number' && desktops > 0);
}

/**
 * The Agents notice: an active Tasks agent with device access, and no computer
 * it can work on yet. Computers still reached through Remote Control already
 * say "Needs connecting" on their rows, and agents still reach them.
 */
export function shouldShowConnectComputerNotice(
  connections: readonly ExternalAgentConnectionSummary[],
  state:
    | Pick<ExternalAgentComputersState, 'computers' | 'portalOnly'>
    | undefined,
): boolean {
  if (state === undefined || state.computers === null) return false;
  const needsComputer = connections.some(
    (connection) =>
      connection.server === 'tasks' &&
      connection.status === 'active' &&
      hasDeviceAccess(connection),
  );
  if (!needsComputer) return false;
  if (state.portalOnly.length > 0) return false;
  return !state.computers.some(
    (computer) => computer.agents === 'connected' || computer.viaPortal,
  );
}

interface ListSnapshot {
  readonly computers: readonly ExternalAgentComputer[] | null;
  readonly portalOnly: readonly PortalOnlyComputer[];
  readonly problem: boolean;
}

const EMPTY: ListSnapshot = { computers: null, portalOnly: [], problem: false };

/**
 * The External agents Computers list. It loads once, then refreshes itself on
 * focus, on return to visible, and on a bounded poll while the list needs
 * watching. Background refreshes never raise the error notice.
 */
export function useExternalAgentComputers(
  client: ExternalAgentComputersClient | undefined,
): ExternalAgentComputersState {
  const [snapshot, setSnapshot] = useState<ListSnapshot>(EMPTY);
  const snapshotRef = useRef<ListSnapshot>(EMPTY);
  const generationRef = useRef(0);
  const mountedRef = useRef(false);
  const inFlightSinceRef = useRef<number | null>(null);
  const lastAppliedAtRef = useRef(0);
  const pausedRef = useRef(false);
  const pollUntilRef = useRef(0);
  // The effect's scheduler, so an explicit load can restart the poll.
  const scheduleRef = useRef<() => void>(() => undefined);

  const apply = useCallback((next: ListSnapshot): void => {
    snapshotRef.current = next;
    setSnapshot(next);
  }, []);

  const request = useCallback(
    async (explicit: boolean): Promise<void> => {
      if (client === undefined) return;
      generationRef.current += 1;
      const generation = generationRef.current;
      inFlightSinceRef.current = Date.now();
      const result = await client.list();
      if (!mountedRef.current || generation !== generationRef.current) return;
      inFlightSinceRef.current = null;
      lastAppliedAtRef.current = Date.now();
      if (result.ok) {
        apply({
          computers: result.value.computers,
          portalOnly: result.value.portalOnly,
          problem: false,
        });
      } else if (explicit) {
        apply({ ...snapshotRef.current, problem: true });
      }
      scheduleRef.current();
    },
    [apply, client],
  );

  const load = useCallback(async (): Promise<void> => {
    pollUntilRef.current = Date.now() + POLL_WINDOW_MS;
    await request(true);
  }, [request]);

  const setPaused = useCallback((paused: boolean): void => {
    pausedRef.current = paused;
  }, []);

  useEffect(() => {
    // A new client starts from an empty list.
    snapshotRef.current = EMPTY;
    setSnapshot(EMPTY);
    if (client === undefined) return undefined;
    mountedRef.current = true;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    inFlightSinceRef.current = null;
    lastAppliedAtRef.current = 0;

    const inFlight = (): boolean => {
      const since = inFlightSinceRef.current;
      return since !== null && Date.now() - since < IN_FLIGHT_STALE_MS;
    };

    const clearTimer = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };

    const schedule = (): void => {
      clearTimer();
      if (disposed || document.visibilityState === 'hidden') return;
      if (!computersNeedWatching(snapshotRef.current)) return;
      const remaining = pollUntilRef.current - Date.now();
      if (remaining <= 0) return;
      timer = setTimeout(
        () => {
          timer = null;
          if (Date.now() >= pollUntilRef.current) return;
          if (pausedRef.current || inFlight()) {
            schedule();
            return;
          }
          void request(false);
        },
        Math.min(POLL_MS, remaining),
      );
    };
    scheduleRef.current = schedule;

    const background = (): void => {
      if (disposed || inFlight()) return;
      if (pausedRef.current) {
        // Keep the poll alive, so it resumes once the person stops acting
        // on a row, even if no explicit load follows.
        schedule();
        return;
      }
      void request(false);
    };

    const onReturn = (): void => {
      if (disposed) return;
      if (document.visibilityState === 'hidden') {
        clearTimer();
        return;
      }
      pollUntilRef.current = Date.now() + POLL_WINDOW_MS;
      if (Date.now() - lastAppliedAtRef.current < MIN_REFRESH_GAP_MS) {
        schedule();
        return;
      }
      background();
    };

    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('focus', onReturn);
    pollUntilRef.current = Date.now() + POLL_WINDOW_MS;
    void request(true);

    return (): void => {
      disposed = true;
      mountedRef.current = false;
      scheduleRef.current = (): void => undefined;
      // Any response still in flight belongs to this run; drop it.
      generationRef.current += 1;
      inFlightSinceRef.current = null;
      clearTimer();
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('focus', onReturn);
    };
  }, [client, request]);

  return {
    computers: snapshot.computers,
    portalOnly: snapshot.portalOnly,
    problem: snapshot.problem,
    load,
    setPaused,
  };
}
