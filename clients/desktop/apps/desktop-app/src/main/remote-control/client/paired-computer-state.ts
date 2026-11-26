import type {
  PairedComputerState,
  PairedComputerUpdateReason,
} from '@canopy/desktop-shared/types';
import {
  DESKTOP_ONE_WINDOW_MIN_PROTOCOL_VERSION,
  type HelloResult,
  type RemoteVersion,
} from '../remote-protocol';
import { oneWindowHostCapabilities } from './one-window-session-policy';
import type { PairedComputerConnectionState } from './paired-computer-connections';

export interface PairedComputerStateInput {
  /** The one-window switch, as main applies it. */
  oneWindowOn: boolean;
  /** Remote Control is running here (on, signed in, relay started). */
  remoteControlOn: boolean;
  paired: boolean;
  /** On the relay, or shown online through a session's presence grace. */
  online: boolean;
  /** Null when nothing holds the computer. */
  connection: PairedComputerConnectionState | null;
  local: RemoteVersion;
}

/**
 * A paired computer's state for the main window (CAN-7761): why it can't be
 * used, with both versions when one of the two needs an update, or what it
 * serves once connected. Reasons that hold for every computer come first.
 */
export function pairedComputerState(
  input: PairedComputerStateInput,
): PairedComputerState {
  if (!input.oneWindowOn)
    return { status: 'unavailable', reason: 'one-window-off', message: null };
  if (!input.remoteControlOn)
    return {
      status: 'unavailable',
      reason: 'remote-control-off',
      message: null,
    };
  if (!input.paired)
    return { status: 'unavailable', reason: 'not-paired', message: null };
  const { connection, local } = input;
  if (!connection) return { status: 'idle' };
  switch (connection.status) {
    case 'needs-update':
      return {
        status: 'needs-update',
        reason: updateReason(connection.hello, local),
        computerVersion: connection.hello.version ?? null,
        computerAppVersion: connection.hello.appVersion,
        thisComputerVersion: local,
        update: connection.update,
      };
    case 'connected':
      return {
        status: 'connected',
        version: connection.version,
        capabilities: oneWindowHostCapabilities(connection.hello, local),
      };
    case 'ended':
      return {
        status: 'unavailable',
        reason: 'ended',
        message: connection.message,
      };
    case 'error':
    case 'connecting':
      if (!input.online)
        return { status: 'unavailable', reason: 'offline', message: null };
      return connection.status === 'error'
        ? {
            status: 'unavailable',
            reason: 'error',
            message: connection.message,
          }
        : { status: 'connecting' };
  }
}

/** Which of the two computers is too old for the other, from its answer. */
function updateReason(
  hello: HelloResult,
  local: RemoteVersion,
): PairedComputerUpdateReason {
  const host = hello.version;
  if (local.protocolVersion < DESKTOP_ONE_WINDOW_MIN_PROTOCOL_VERSION)
    return 'this-computer-older';
  if (!host || host.protocolVersion < DESKTOP_ONE_WINDOW_MIN_PROTOCOL_VERSION)
    return 'computer-too-old';
  if (host.protocolVersion > local.protocolVersion)
    return 'this-computer-older';
  return 'computer-without-one-window';
}
