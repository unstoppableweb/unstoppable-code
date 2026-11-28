import type { WebContents } from 'electron';
import type { CanopyClientEndpoint } from '@canopy/core-client/node';
import type {
  CanopyWorkspaceScope,
  CoreClientWindowIssueResult,
  CoreClientWindowRevokeParams,
  CoreClientWindowRight,
} from '@canopy/protocol/canopy-core';
import type { TerminalSession } from '@canopy/protocol/terminal';
import { isBotProjectId } from '@canopy/protocol/chat-targets';
import type {
  TerminalWindowConnectResponse,
  TerminalWindowRouteResponse,
} from '@canopy/desktop-shared/types';
import type { ElectronDaemonSession } from '../canopy-runtime/electron-daemon-connection';
import type { ElectronDaemonClient } from '../canopy-runtime/electron-daemon-host';
import { keepsTerminalRecords } from './record-client';

/**
 * Main's admission of its own windows to the daemon's terminals (CAN-8068):
 * a single-use ticket per window, and per-terminal grants for the daemon
 * terminals that window shows. Each window is keyed by its renderer's web
 * contents, so the early access Orchestrator view keeps its instance while it
 * moves between windows. Everything is bound to main's terminal lease: a new
 * lease rotates every instance and re-grants what each still shows.
 *
 * Main still decides when a terminal is lost; a window stream ending never
 * is. Nothing here changes what a window shows until a window asks.
 */

/** The app windows that may hold their own daemon terminal connection. */
export type TerminalWindowSurface = 'main' | 'orchestrator';

const WINDOW_LABELS: Readonly<Record<TerminalWindowSurface, string>> = {
  main: 'Desktop window',
  orchestrator: 'Orchestrator window',
};

/** Every operation a window connection needs on main's terminal session. */
const WINDOW_OPERATIONS = [
  'core.client.window.issue',
  'core.client.window.grant',
  'core.client.window.revoke',
  'core.events.unsubscribe',
] as const;

/**
 * Whether windows may connect on this session: it serves window admission,
 * stream unsubscribe and the terminal record. Otherwise every window keeps
 * main's relay, as before CAN-8022.
 */
export function admitsTerminalWindows(
  session: Pick<ElectronDaemonClient, 'manifest'>,
): boolean {
  return (
    WINDOW_OPERATIONS.every((operation) =>
      session.manifest.has('operations', operation),
    ) && keepsTerminalRecords(session)
  );
}

/** Q-F: only a shell takes a window's input; a Claude terminal's comes through main. */
export function terminalWindowRights(
  session: Pick<TerminalSession, 'kind'>,
): readonly CoreClientWindowRight[] {
  return session.kind === undefined || session.kind === 'shell'
    ? ['attach', 'write', 'resize']
    : ['attach', 'resize'];
}

/** Bot terminals show in both windows, as their events do; others in the main window only. */
function shows(surface: TerminalWindowSurface, projectId: string): boolean {
  return surface === 'main' || isBotProjectId(projectId);
}

export type TerminalWindowContents = Pick<
  WebContents,
  'isDestroyed' | 'on' | 'removeListener'
>;

/** A daemon terminal main mirrors, as a window would attach to it. */
export interface TerminalWindowTarget {
  readonly scope: CanopyWorkspaceScope;
  readonly session: TerminalSession;
}

export interface TerminalWindowAdmissionPort {
  /** Main's terminal session; rejects when the daemon can't be reached. */
  readonly session: () => Promise<ElectronDaemonSession<ElectronDaemonClient>>;
  /** Whether main's record says the daemon can't be reached right now. */
  readonly latched: () => boolean;
  readonly endpointOf: (
    client: Pick<ElectronDaemonClient, 'identity'>,
  ) => CanopyClientEndpoint | undefined;
  /** The daemon terminal main mirrors under this id, or `null`. */
  readonly terminal: (terminalId: string) => TerminalWindowTarget | null;
  readonly createId: () => string;
  readonly log: (message: string, details: Record<string, unknown>) => void;
}

interface AdmittedWindow {
  readonly surface: TerminalWindowSurface;
  /** Rotated on navigation, crash and each new lease, so no stale revoke lands on it. */
  instanceId: string;
  /** Counts navigations and crashes, so a call from the page before is dropped. */
  page: number;
  /** The terminals this instance was granted, by id. */
  readonly grants: Map<string, readonly CoreClientWindowRight[]>;
  /** Grants still being sent: main keeps relaying them until they land. */
  readonly granting: Set<string>;
  readonly detach: () => void;
}

export interface TerminalWindowAdmission {
  /**
   * A ticket for this window, or `null` to keep it on main's relay. Asked for
   * a terminal (CAN-8070), main answers `null` without opening its session
   * unless it mirrors that daemon terminal for the window: an in-process
   * terminal's pane never opens main's session or wakes an idle daemon.
   * Without one it asks main's session, as in CAN-8068.
   */
  connect(
    contents: TerminalWindowContents,
    surface: TerminalWindowSurface,
    terminalId?: string,
  ): Promise<TerminalWindowConnectResponse | null>;
  /**
   * A fresh ticket for a window connection's own reconnect (CAN-8070), only
   * while the window reads a daemon terminal main still mirrors for it, so a
   * reconnect never opens main's session or wakes an idle daemon.
   */
  reconnect(
    contents: TerminalWindowContents,
    surface: TerminalWindowSurface,
  ): Promise<TerminalWindowConnectResponse | null>;
  /**
   * Grants an admitted window one daemon terminal it shows, or `null` when
   * that terminal stays on main's relay.
   */
  route(
    contents: TerminalWindowContents,
    surface: TerminalWindowSurface,
    terminalId: string,
  ): Promise<TerminalWindowRouteResponse | null>;
  /** The window handed a routed terminal back to main's relay (CAN-8070). */
  release(
    contents: TerminalWindowContents,
    surface: TerminalWindowSurface,
    terminalId: string,
  ): void;
  /**
   * Whether the renderer `target` reads this terminal on its own connection,
   * so main sends it no output (CAN-8070). True from the grant landing until
   * its release or a revoke; never for a route answered `null`.
   */
  reads(target: object, terminalId: string): boolean;
  /** The terminal exited, was killed, released or is being recreated. */
  revokeTerminal(terminalId: string): void;
}

const REGISTRATION = 'terminal-windows';

export function createTerminalWindowAdmission(
  port: TerminalWindowAdmissionPort,
): TerminalWindowAdmission {
  // Keyed by object: a delivery filter looks a window up by its send target.
  const windows = new Map<object, AdmittedWindow>();
  const registered = new WeakSet<object>();
  /** The session window calls go to, while it lives; never opened to revoke. */
  let active: ElectronDaemonSession<ElectronDaemonClient> | undefined;
  /** The lease every current instance belongs to. */
  let leaseId: string | undefined;

  const warn = (message: string, error: unknown): void =>
    port.log(message, {
      reason: error instanceof Error ? error.name : 'error',
    });

  const liveClient = (): ElectronDaemonClient | null => {
    const session = active;
    if (!session || session.signal.aborted) return null;
    try {
      return session.client;
    } catch {
      return null;
    }
  };

  /**
   * Revokes main couldn't send while its connection was down. Sent before
   * the next window call on the same lease; a new lease already ended them.
   */
  const undelivered = new Map<string, CoreClientWindowRevokeParams>();

  const hold = (params: CoreClientWindowRevokeParams): void => {
    undelivered.set(
      `${params.windowInstanceId}\0${params.terminalId ?? ''}`,
      params,
    );
  };

  const send = (
    client: ElectronDaemonClient,
    params: CoreClientWindowRevokeParams,
  ): void => {
    void client
      .instruction('core.client.window.revoke', params)
      .catch((error: unknown) => {
        // A refusal on a live connection is final; a dropped one is retried.
        if (client.signal.aborted) hold(params);
        warn('Could not revoke a window terminal grant.', error);
      });
  };

  const flush = (client: ElectronDaemonClient): void => {
    const held = Array.from(undelivered.values());
    undelivered.clear();
    for (const params of held) send(client, params);
  };

  const revoke = (windowInstanceId: string, terminalId?: string): void => {
    const params: CoreClientWindowRevokeParams = {
      windowInstanceId,
      ...(terminalId !== undefined && { terminalId }),
    };
    const client = liveClient();
    if (!client) {
      // Kept only while a session lives: its lease ending ends the window.
      if (active && !active.signal.aborted) hold(params);
      return;
    }
    flush(client);
    send(client, params);
  };

  /** Ends the instance on the daemon; the window gets a fresh one on its next ask. */
  const resetWindow = (window: AdmittedWindow): void => {
    revoke(window.instanceId);
    window.grants.clear();
    window.instanceId = port.createId();
    window.page += 1;
  };

  const admitted = (
    contents: TerminalWindowContents,
    surface: TerminalWindowSurface,
  ): AdmittedWindow => {
    const existing = windows.get(contents);
    if (existing?.surface === surface) return existing;
    if (existing) {
      resetWindow(existing);
      existing.detach();
      windows.delete(contents);
    }
    const reset = (): void => {
      const window = windows.get(contents);
      if (window) resetWindow(window);
    };
    const destroyed = (): void => {
      const window = windows.get(contents);
      if (!window) return;
      revoke(window.instanceId);
      window.detach();
      windows.delete(contents);
    };
    contents.on('did-navigate', reset);
    contents.on('render-process-gone', reset);
    contents.on('destroyed', destroyed);
    const window: AdmittedWindow = {
      surface,
      instanceId: port.createId(),
      page: 0,
      grants: new Map(),
      granting: new Set(),
      detach: (): void => {
        contents.removeListener('did-navigate', reset);
        contents.removeListener('render-process-gone', reset);
        contents.removeListener('destroyed', destroyed);
      },
    };
    windows.set(contents, window);
    return window;
  };

  /** Re-grants an instance's terminals on `client`, dropping those main no longer mirrors. */
  const regrant = (
    window: AdmittedWindow,
    client: ElectronDaemonClient,
  ): void => {
    for (const [terminalId, rights] of Array.from(window.grants)) {
      if (port.terminal(terminalId) === null) {
        window.grants.delete(terminalId);
        continue;
      }
      const instanceId = window.instanceId;
      void client
        .instruction('core.client.window.grant', {
          windowInstanceId: instanceId,
          terminalId,
          rights: [...rights],
        })
        .catch((error: unknown) => {
          if (
            window.instanceId === instanceId &&
            window.grants.get(terminalId) === rights
          )
            window.grants.delete(terminalId);
          warn('Could not re-grant a window terminal.', error);
        });
    }
  };

  /** Each instance died with the old lease (window-admission leaseEnded). */
  const leaseChanged = (next: string, client: ElectronDaemonClient): void => {
    const previous = leaseId;
    leaseId = next;
    if (previous === undefined || previous === next) return;
    undelivered.clear();
    for (const window of windows.values()) {
      window.instanceId = port.createId();
      regrant(window, client);
    }
  };

  /** Main relays the terminal to this window again. */
  const dropGrant = (window: AdmittedWindow, terminalId: string): void => {
    if (window.grants.delete(terminalId)) revoke(window.instanceId, terminalId);
  };

  /** The daemon terminal main mirrors under this id that `surface` shows. */
  const shown = (
    surface: TerminalWindowSurface,
    terminalId: string,
  ): TerminalWindowTarget | null => {
    const target = port.terminal(terminalId);
    return target && shows(surface, target.session.projectId) ? target : null;
  };

  /** Main's terminal session when it admits windows, or `null`. */
  const sessionForWindows = async (): Promise<ElectronDaemonClient | null> => {
    // A latched daemon is not contacted: the ask would respawn it.
    if (port.latched()) return null;
    let session: ElectronDaemonSession<ElectronDaemonClient>;
    let client: ElectronDaemonClient;
    try {
      session = await port.session();
      client = session.client;
    } catch {
      return null;
    }
    if (!admitsTerminalWindows(client)) return null;
    active = session;
    if (!registered.has(session)) {
      registered.add(session);
      // A live lease issues it before register returns.
      session.lease.register(REGISTRATION, (lease, connected) => {
        leaseChanged(lease.leaseId, connected);
      });
    }
    flush(client);
    return client;
  };

  const issueTicket = async (
    contents: TerminalWindowContents,
    surface: TerminalWindowSurface,
  ): Promise<TerminalWindowConnectResponse | null> => {
    const client = await sessionForWindows();
    if (!client || contents.isDestroyed()) return null;
    const endpoint = port.endpointOf(client);
    if (!endpoint || endpoint.kind === 'inMemory') return null;
    const window = admitted(contents, surface);
    const instanceId = window.instanceId;
    let issued: CoreClientWindowIssueResult;
    try {
      issued = await client.instruction('core.client.window.issue', {
        windowInstanceId: instanceId,
        label: WINDOW_LABELS[surface],
        _meta: { idempotencyKey: port.createId() },
      });
    } catch (error) {
      // A refusal (a cap, a lost connection) keeps this window on the relay.
      warn('Could not issue a window terminal ticket.', error);
      return null;
    }
    // Navigated, crashed, closed or re-leased meanwhile: that instance is done.
    if (windows.get(contents) !== window || window.instanceId !== instanceId) {
      revoke(instanceId);
      return null;
    }
    return {
      windowInstanceId: instanceId,
      endpoint: {
        kind: endpoint.kind,
        path: endpoint.path,
        auth: {
          secret: endpoint.auth.secret,
          dataRootHash: endpoint.auth.dataRootHash,
        },
        ...(endpoint.maxFrameBytes !== undefined && {
          maxFrameBytes: endpoint.maxFrameBytes,
        }),
      },
      runtime: {
        runtimeId: client.identity.runtimeId,
        daemonEpoch: client.identity.daemonEpoch,
      },
      ticket: { ticketId: issued.ticketId, secret: issued.secret },
      expiresAt: issued.expiresAt,
    };
  };

  return {
    async connect(contents, surface, terminalId) {
      if (contents.isDestroyed()) return null;
      if (terminalId !== undefined && !shown(surface, terminalId)) return null;
      return issueTicket(contents, surface);
    },

    async reconnect(contents, surface) {
      const window = windows.get(contents);
      if (window?.surface !== surface || contents.isDestroyed()) return null;
      // Main mirrors a terminal this window reads, so its session is needed
      // anyway; otherwise the connection ends instead of waking the daemon.
      const reading = Array.from(window.grants.keys()).some(
        (terminalId) => shown(surface, terminalId) !== null,
      );
      return reading ? issueTicket(contents, surface) : null;
    },

    async route(contents, surface, terminalId) {
      const window = windows.get(contents);
      if (!window || window.surface !== surface || contents.isDestroyed())
        return null;
      const target = shown(surface, terminalId);
      if (!target) return null;
      const { page } = window;
      const client = await sessionForWindows();
      // The page that asked is gone; a new lease alone keeps it.
      if (windows.get(contents) !== window || window.page !== page) return null;
      if (!client) {
        // A `null` answer means main relays it: an earlier grant goes too.
        dropGrant(window, terminalId);
        return null;
      }
      const rights = terminalWindowRights(target.session);
      const instanceId = window.instanceId;
      // Recorded before the call, so an exit meanwhile revokes it too.
      window.grants.set(terminalId, rights);
      window.granting.add(terminalId);
      try {
        await client.instruction('core.client.window.grant', {
          windowInstanceId: instanceId,
          terminalId,
          rights: [...rights],
        });
      } catch (error) {
        if (window.grants.get(terminalId) === rights)
          window.grants.delete(terminalId);
        warn('Could not grant a window terminal.', error);
        return null;
      } finally {
        window.granting.delete(terminalId);
      }
      if (window.grants.get(terminalId) !== rights) {
        // Revoked while granting: the grant must not outlive it.
        if (window.instanceId === instanceId) revoke(instanceId, terminalId);
        return null;
      }
      if (window.instanceId !== instanceId) {
        // Re-leased while granting: the window hears `null` and keeps main's
        // relay, so the grant the new lease carried over is dropped too.
        dropGrant(window, terminalId);
        return null;
      }
      return {
        scope: target.scope,
        terminalId,
        rights,
        session: target.session,
      };
    },

    release(contents, surface, terminalId) {
      const window = windows.get(contents);
      if (window?.surface === surface) dropGrant(window, terminalId);
    },

    reads(target, terminalId) {
      const window = windows.get(target);
      return (
        window !== undefined &&
        window.grants.has(terminalId) &&
        !window.granting.has(terminalId)
      );
    },

    revokeTerminal(terminalId) {
      for (const window of windows.values()) {
        if (!window.grants.delete(terminalId)) continue;
        revoke(window.instanceId, terminalId);
      }
    },
  };
}
