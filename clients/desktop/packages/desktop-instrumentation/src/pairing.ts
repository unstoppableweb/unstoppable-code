export interface PairingTelemetryContext {
  pairing_kind: 'phone_code' | 'computer_outgoing' | 'computer_incoming';
  pairing_entry: 'portal_modal' | 'pair_computer_dialog' | 'incoming_prompt';
  peer_platform: 'darwin' | 'win32' | 'linux' | 'unknown';
  is_additional_device?: boolean;
}

export type PairingTelemetryOutcome =
  | 'approved'
  | 'rejected'
  | 'declined'
  | 'failed'
  | 'cancelled'
  | 'expired'
  | 'timed_out';
export interface PairingTelemetryAttempt {
  end(outcome: PairingTelemetryOutcome): void;
}
export type PairingTelemetryRecorder = (
  context: PairingTelemetryContext,
) => PairingTelemetryAttempt | undefined;

/** Controller profile of a Remote Control device; bounded, never an ID. */
export type RemoteControlTelemetryDeviceKind =
  | 'desktop'
  | 'mobile'
  | 'browser'
  | 'hosted';

/**
 * How a pairing was approved: `link` (a pairing-link proof), `code` (the
 * person here compared codes) or `expected` (CAN-7606: the one hosted
 * pairing this computer's own Connect Slack click armed, approved with no
 * prompt).
 */
export type RemoteControlTelemetryPairMethod = 'link' | 'code' | 'expected';

export type RemoteControlPairingFailureReason =
  | 'denied'
  | 'expired'
  | 'proof_invalid'
  | 'proof_consumed'
  | 'persist_failed'
  | 'cancelled';

export type RemoteControlSessionEndReason =
  | 'disconnected'
  | 'revoked'
  | 'expired'
  | 'disabled'
  | 'removed';

/**
 * Remote Control host events. The controlled computer is the only place a
 * pairing completes or a session is authorized, so it records each once.
 * Values are fixed enums only: never secrets, proofs, codes, names or IDs.
 */
export type RemoteControlTelemetryEvent =
  | {
      event: 'device_add';
      device_kind: RemoteControlTelemetryDeviceKind;
      pair_method: RemoteControlTelemetryPairMethod;
    }
  | {
      event: 'pairing_fail';
      device_kind: RemoteControlTelemetryDeviceKind;
      pair_method: RemoteControlTelemetryPairMethod;
      failure_reason: RemoteControlPairingFailureReason;
    }
  | {
      event: 'session_start';
      device_kind: RemoteControlTelemetryDeviceKind;
      is_delegated: boolean;
    }
  | {
      event: 'session_end';
      device_kind: RemoteControlTelemetryDeviceKind;
      end_reason: RemoteControlSessionEndReason;
    }
  | { event: 'device_remove'; device_kind: RemoteControlTelemetryDeviceKind };

export type RemoteControlTelemetryRecorder = (
  event: RemoteControlTelemetryEvent,
) => void;
