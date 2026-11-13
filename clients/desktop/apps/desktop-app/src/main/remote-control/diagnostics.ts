import type { FeatureFlagSnapshotStatus } from '@canopy/protocol/feature-flags';
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

/** The inputs to whether remote control is available. */
export interface RemoteControlAvailability {
  /** The switch in Settings → Labs. */
  labsEnabled: boolean;
  flagEnabled: boolean;
  /** `ready` when the flag value is live rather than a fallback. */
  flagStatus: FeatureFlagSnapshotStatus;
}

/**
 * Why the service stopped its relay connection: another account signed in,
 * the feature flag or the Labs switch turned off, the account signed out,
 * nothing needs the relay any more, or the app is shutting down.
 */
export type RemoteRelayStopCause =
  | 'account_changed'
  | 'feature_flag'
  | 'labs_off'
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
  /** `feature_flag` only: whether the flag value was live. */
  flagStatus?: FeatureFlagSnapshotStatus;
  /**
   * `feature_flag` only: how long a transient flag change held the relay up
   * before it stopped; absent when it stopped at once.
   */
  heldMs?: number;
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
