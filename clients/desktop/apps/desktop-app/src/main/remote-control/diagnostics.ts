import type {
  RelayClientDiagnostic,
  RelayConnectionStatus,
} from './transport/relay-client';
import type { SessionClosedEvent } from './transport/session-manager';

/**
 * Remote control's connection diagnostics, recorded on this computer only.
 * Each carries bounded values: no device, session or account identifiers,
 * tokens, paths or payloads.
 */

/**
 * Why the service stopped its relay connection: another account signed in,
 * the account signed out, nothing needs the relay any more, or the app is
 * shutting down.
 */
export type RemoteRelayStopCause =
  | 'account_changed'
  | 'signed_out'
  | 'not_wanted'
  | 'dispose';

export interface RemoteRelayStoppedDiagnostic {
  cause: RemoteRelayStopCause;
  /**
   * `account_changed` only: the account key changed form (a credential
   * digest and a server ID), which may be the same account.
   */
  accountFormChanged?: boolean;
  /** The relay connection's status when it stopped. */
  relayStatus: RelayConnectionStatus;
  /** How long the relay connection had been running. */
  uptimeMs: number;
  /** Sessions this computer was hosting, ended by the stop. */
  hostSessions: number;
  /** Computers this one was controlling, disconnected by the stop. */
  hostConnections: number;
}

export type RemoteControlDiagnostic =
  | {
      kind: 'remote_relay_connection';
      remoteRelayConnection: RelayClientDiagnostic;
    }
  | { kind: 'remote_session_closed'; remoteSessionClosed: SessionClosedEvent }
  | {
      kind: 'remote_relay_stopped';
      remoteRelayStopped: RemoteRelayStoppedDiagnostic;
    };
