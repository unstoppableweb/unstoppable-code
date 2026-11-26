import { classifyError } from '@canopy/protocol/app-errors/classification';
import { getRemoteChannelDisposition } from '@canopy/desktop-shared/remote-control/channel-dispositions';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type { RemoteHostUpdateStatus } from '@canopy/desktop-shared/types';
import {
  RemoteChannelUnavailableError,
  type AppAdvisorWindowStateParams,
  type DialogOpenResult,
  type HelloParams,
  type HelloResult,
  type RemoteVersion,
} from '../remote-protocol';
import type { SecureSession } from '../transport/session-manager';
import { RemoteHostConnection } from './host-connection';
import type { LocalRelease } from './host-update';

/** The controller profile a hello carries. */
export type HelloControllerProfile = NonNullable<HelloParams['controller']>;

/**
 * What the main process's session with a paired computer, separate from
 * that computer's window, says in its hello and may carry. CAN-7758 defines
 * the profile and the reviewed channel list, and CAN-7761 builds this from
 * them (`createOneWindowSessionPolicy`); until it is passed in, nothing
 * connects this way.
 */
export interface WindowlessSessionPolicy {
  controllerProfile: () => HelloControllerProfile;
  /** Whether a push on `channel` may be delivered, given the hello. */
  allowsChannel: (channel: string, hello: HelloResult) => boolean;
  /** Whether `channel` may be called or sent with `args`, given the hello. */
  allowsInvocation: (
    channel: string,
    args: readonly unknown[],
    hello: HelloResult,
  ) => boolean;
}

/** What a paired computer's windowless session reports, tagged with it. */
export type PairedComputerEvent =
  | {
      type: 'push';
      deviceId: string;
      channel: string;
      args: unknown[];
    }
  /**
   * A new handshake replaced a dropped session, so pushes may have been
   * missed and anything read from the computer should be read again. A
   * session that resumed lost nothing and reports no event.
   */
  | { type: 'reconnected'; deviceId: string }
  /** The connection closed; every hold on it was dropped. */
  | { type: 'closed'; deviceId: string }
  /**
   * What `connectionState` reports for it may have changed: the session
   * opened, dropped, was refused for its version, or the computer's
   * presence on the relay changed.
   */
  | { type: 'state'; deviceId: string };

/** A held computer's connection, before main adds pairing and presence. */
export type PairedComputerConnectionState =
  | { status: 'connecting' }
  | { status: 'connected'; hello: HelloResult; version: RemoteVersion }
  /**
   * The computer answered on a version this computer can't use: `hello` is
   * its answer, `update` the update one of the two can run, if any.
   */
  | {
      status: 'needs-update';
      hello: HelloResult;
      update: RemoteHostUpdateStatus | null;
    }
  /** It ended the session or withdrew access; no retries until held again. */
  | { status: 'ended'; message: string | null }
  /** The last attempt failed; it retries with backoff. */
  | { status: 'error'; message: string | null };

export type PairedComputerListener = (event: PairedComputerEvent) => void;

/** Keeps a paired computer's windowless connection open until released. */
export interface PairedComputerHold {
  readonly deviceId: string;
  /** False once released, or once the connection closed under it. */
  readonly held: boolean;
  /** Lets the connection go; it closes when no other hold keeps it. */
  release(): void;
}

/** The paired computer a hold connects to, as pairing pinned it. */
export interface PairedComputer {
  deviceId: string;
  publicKey: string;
}

class Hold implements PairedComputerHold {
  private releasedValue = false;

  constructor(
    readonly deviceId: string,
    private readonly onRelease: (hold: Hold) => void,
  ) {}

  get held(): boolean {
    return !this.releasedValue;
  }

  release(): void {
    if (this.releasedValue) return;
    this.releasedValue = true;
    this.onRelease(this);
  }

  /** The connection closed: the hold ends without asking it to close. */
  drop(): void {
    this.releasedValue = true;
  }
}

interface Entry {
  connection: RemoteHostConnection;
  holds: Set<Hold>;
}

export interface PairedComputerConnectionsOptions {
  /**
   * Absent: every hold is refused and every channel denied. `setPolicy`
   * changes it later.
   */
  policy: WindowlessSessionPolicy | null;
  version: RemoteVersion;
  release?: LocalRelease;
  /** Opens a control session to the computer. */
  connect: (computer: PairedComputer) => Promise<SecureSession>;
  log?: (message: string, context?: unknown) => void;
}

const NO_DIALOG: DialogOpenResult = { canceled: true, filePaths: [] };
const NO_APP_ADVISOR_WINDOW: AppAdvisorWindowStateParams = {
  open: false,
  focused: false,
};

/**
 * This computer's main-process connections to paired computers, one per
 * computer at most, shared by every hold on it. Each is its own session,
 * apart from the computer's window, which keeps its own full-tunnel
 * session. They reconnect and resume as the window's does.
 */
export class PairedComputerConnections {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<PairedComputerListener>();
  /** Events raised while others are being delivered, in order. */
  private readonly queued: PairedComputerEvent[] = [];
  private delivering = false;
  private policy: WindowlessSessionPolicy | null;

  constructor(private readonly options: PairedComputerConnectionsOptions) {
    this.policy = options.policy;
  }

  /** Whether holds are accepted: a policy is in place. */
  get enabled(): boolean {
    return this.policy !== null;
  }

  /**
   * Replaces the policy (the one-window switch turned on or off). Every
   * open connection closes and its holds are dropped, so no session keeps a
   * hello or channel list the new policy did not choose.
   */
  setPolicy(policy: WindowlessSessionPolicy | null): void {
    if (policy === this.policy) return;
    this.policy = policy;
    this.closeAll();
  }

  /** The held computer's connection, or null when nothing holds it. */
  connectionState(deviceId: string): PairedComputerConnectionState | null {
    const connection = this.entries.get(deviceId)?.connection;
    if (!connection) return null;
    const incompatible = connection.incompatibleHostInfo;
    if (incompatible) {
      return {
        status: 'needs-update',
        hello: incompatible,
        update: connection.update,
      };
    }
    if (connection.status === 'connected' && connection.hasOpenSession) {
      // A host is used only after its hello named a version this one checked.
      const hello = connection.hostInfo;
      if (hello?.version)
        return { status: 'connected', hello, version: hello.version };
    }
    if (connection.ended) return { status: 'ended', message: connection.error };
    if (connection.status === 'error')
      return { status: 'error', message: connection.error };
    return { status: 'connecting' };
  }

  /** Reports a `state` event for every held computer (presence changed). */
  noteStatesChanged(): void {
    for (const deviceId of Array.from(this.entries.keys())) {
      this.emit({ type: 'state', deviceId });
    }
  }

  /** Opens the computer's connection, or joins the open one. */
  hold(computer: PairedComputer): PairedComputerHold {
    const policy = this.policy;
    if (!policy) {
      throw classifyError(
        new Error('Connecting to another computer without its window is off.'),
        'external.state_changed',
      );
    }
    const existing = this.entries.get(computer.deviceId);
    const hold = new Hold(computer.deviceId, (released) =>
      this.released(released),
    );
    if (existing) {
      // Joining never clears a session the other computer ended on purpose.
      existing.holds.add(hold);
      return hold;
    }
    const connection = this.createConnection(computer, policy);
    this.entries.set(computer.deviceId, {
      connection,
      holds: new Set([hold]),
    });
    connection.keepConnected();
    return hold;
  }

  /**
   * Calls a tunneled channel the policy allows on a held computer.
   * `stillWanted` is asked again just before dispatch, after any wait for the
   * connection, so a caller that let go meanwhile sends nothing.
   */
  async invoke(
    deviceId: string,
    channel: string,
    args: unknown[],
    stillWanted: () => boolean = () => true,
  ): Promise<unknown> {
    const { connection, policy } = this.usable(deviceId, channel);
    await connection.ensure();
    // Released while it connected: dispatching now would open a session
    // that no hold keeps. Checked in the same turn as the dispatch below.
    if (!this.isCurrent(deviceId, connection) || !stillWanted())
      throw closedError();
    // The session the hello came from must still be the open one, or the
    // dispatch would go out on a replacement the policy never checked.
    if (!connection.hasOpenSession) throw closedError();
    // A suspended session would hold the call until it resumes, past the
    // check above: refused instead, so the caller asks again once active.
    if (connection.status !== 'connected') throw resumingError();
    const hello = connection.hostInfo;
    if (!hello || !policy.allowsInvocation(channel, args, hello)) {
      throw unavailable(channel);
    }
    // Dispatched on that session in this turn, with no wait after the checks.
    return connection.invokeOnOpenSession(channel, args);
  }

  /** Sends to a held computer; dropped unless the policy allows it. */
  send(
    deviceId: string,
    channel: string,
    args: unknown[],
    stillWanted: () => boolean = () => true,
  ): void {
    let usable: {
      connection: RemoteHostConnection;
      policy: WindowlessSessionPolicy;
    };
    try {
      usable = this.usable(deviceId, channel);
    } catch {
      return;
    }
    const { connection, policy } = usable;
    void connection.ensure().then(
      () => {
        if (!this.isCurrent(deviceId, connection) || !stillWanted()) return;
        if (!connection.hasOpenSession) return;
        if (connection.status !== 'connected') return;
        const hello = connection.hostInfo;
        if (hello && policy.allowsInvocation(channel, args, hello)) {
          connection.postOnOpenSession(channel, args);
        }
      },
      () => undefined,
    );
  }

  addListener(listener: PairedComputerListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Reconnects at once each connection whose computer is online. */
  retryNow(isOnline: (deviceId: string) => boolean): void {
    this.entries.forEach(({ connection }, deviceId) => {
      if (isOnline(deviceId)) connection.retryNow();
    });
  }

  /** Closes the computer's connection and drops its holds (unpair). */
  close(deviceId: string): void {
    const entry = this.entries.get(deviceId);
    if (!entry) return;
    this.entries.delete(deviceId);
    entry.holds.forEach((hold) => hold.drop());
    entry.connection.release();
    this.emit({ type: 'closed', deviceId });
  }

  /** Closes every connection (relay stopped, quit). */
  closeAll(): void {
    for (const deviceId of Array.from(this.entries.keys())) {
      this.close(deviceId);
    }
  }

  private isCurrent(
    deviceId: string,
    connection: RemoteHostConnection,
  ): boolean {
    return this.entries.get(deviceId)?.connection === connection;
  }

  private usable(
    deviceId: string,
    channel: string,
  ): { connection: RemoteHostConnection; policy: WindowlessSessionPolicy } {
    const policy = this.policy;
    // Opening a file locally is the window's own path, never the other
    // computer's: it would open on that computer's screen.
    if (
      !policy ||
      channel === IPC_CHANNELS.fileOpenExternal ||
      getRemoteChannelDisposition(channel) !== 'tunnel'
    ) {
      throw unavailable(channel);
    }
    const entry = this.entries.get(deviceId);
    if (!entry) {
      throw classifyError(
        new Error('This computer is not connected to that computer.'),
        'external.state_changed',
      );
    }
    return { connection: entry.connection, policy };
  }

  private createConnection(
    computer: PairedComputer,
    policy: WindowlessSessionPolicy,
  ): RemoteHostConnection {
    const { deviceId } = computer;
    const connection: RemoteHostConnection = new RemoteHostConnection({
      version: this.options.version,
      ...(this.options.release ? { release: this.options.release } : {}),
      ...(this.options.log ? { log: this.options.log } : {}),
      controllerProfile: policy.controllerProfile,
      connect: (): Promise<SecureSession> => this.options.connect(computer),
      onPush: (channel, args, surface, fromLiveSession): void => {
        if (surface === 'app-advisor' || this.listeners.size === 0) return;
        // A replacement session still in its hello would be filtered by the
        // previous session's hello: drop its pushes. The `reconnected` event
        // that follows asks listeners to read again. A resuming session is
        // still the live one and keeps delivering.
        if (!fromLiveSession) return;
        const hello = connection.hostInfo;
        if (!hello || !policy.allowsChannel(channel, hello)) return;
        this.emit({ type: 'push', deviceId, channel, args });
      },
      // No window here to show a picker or an App Advisor window in.
      onDialogOpen: (): Promise<DialogOpenResult> => Promise.resolve(NO_DIALOG),
      onAppAdvisorWindow: (): Promise<AppAdvisorWindowStateParams> =>
        Promise.resolve(NO_APP_ADVISOR_WINDOW),
      onStatusChange: (): void => {
        // Not yet in the map while it is created, and gone once closed.
        if (this.isCurrent(deviceId, connection))
          this.emit({ type: 'state', deviceId });
      },
      onReconnected: (): void => this.emit({ type: 'reconnected', deviceId }),
      onSessionEnded: (reason): void => {
        this.options.log?.('Remote control windowless connection ended', {
          reason,
        });
      },
    });
    return connection;
  }

  private released(hold: Hold): void {
    const entry = this.entries.get(hold.deviceId);
    if (!entry?.holds.delete(hold) || entry.holds.size > 0) return;
    this.close(hold.deviceId);
  }

  /**
   * Delivers events in the order they happened to every listener: one a
   * listener causes, such as `closed` from a release during a push, waits
   * until the current event has reached them all.
   */
  private emit(event: PairedComputerEvent): void {
    this.queued.push(event);
    if (this.delivering) return;
    this.delivering = true;
    try {
      for (
        let next = this.queued.shift();
        next !== undefined;
        next = this.queued.shift()
      ) {
        this.deliver(next);
      }
    } finally {
      this.delivering = false;
    }
  }

  private deliver(event: PairedComputerEvent): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(event);
      } catch (error) {
        // One listener must not keep the event from the others, nor throw
        // into the session that delivered it.
        this.options.log?.('Paired computer listener failed', {
          type: event.type,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

function closedError(): Error {
  return classifyError(
    new Error('The connection to that computer was closed.'),
    'external.state_changed',
  );
}

function resumingError(): Error {
  return classifyError(
    new Error('The connection to that computer is resuming. Try again.'),
    'external.state_changed',
  );
}

function unavailable(channel: string): Error {
  return classifyError(
    new RemoteChannelUnavailableError(channel),
    'external.state_changed',
  );
}
