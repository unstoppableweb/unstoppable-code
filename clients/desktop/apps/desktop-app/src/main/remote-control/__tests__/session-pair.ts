import type { DeviceRelayDeviceInfo } from '@canopy/protocol/device-relay';
import {
  generateDeviceKeyPair,
  type DeviceKeyPair,
} from '../crypto/device-key';
import {
  RemoteSessionManager,
  type SessionGrant,
  type SecureSession,
} from '../transport/session-manager';
import {
  flushRelay,
  InMemoryRelayEndpoint,
  type InMemoryRelayHub,
} from './in-memory-relay';

/** One computer on an in-memory relay, with its session manager. */
export interface TestDevice {
  identity: DeviceKeyPair;
  endpoint: InMemoryRelayEndpoint;
  manager: RemoteSessionManager;
  incoming: SecureSession[];
}

export function createTestDevice(
  hub: InMemoryRelayHub,
  name: string,
): TestDevice {
  const identity = generateDeviceKeyPair();
  const info = (): DeviceRelayDeviceInfo => ({
    deviceId: identity.deviceId,
    name,
    platform: 'linux',
    appVersion: '1.0.0',
    publicKey: identity.publicKey,
    acceptsRemoteControl: true,
  });
  const endpoint = new InMemoryRelayEndpoint(hub, info, () => undefined);
  endpoint.start();
  const incoming: SecureSession[] = [];
  const manager = new RemoteSessionManager({
    transport: endpoint,
    identity: (): DeviceKeyPair => identity,
    authorize: (): SessionGrant => ({
      kind: 'desktop',
      kindAuthenticated: false,
      rootDeviceId: null,
      expiresAt: null,
    }),
    onIncomingSession: (session: SecureSession): void => {
      incoming.push(session);
    },
  });
  return { identity, endpoint, manager, incoming };
}

/** Opens a control session from `from` to `to`. */
export async function openControlSession(
  from: TestDevice,
  to: TestDevice,
): Promise<{ initiator: SecureSession; responder: SecureSession }> {
  const before = to.incoming.length;
  const pending = from.manager.connect({
    peerDeviceId: to.identity.deviceId,
    purpose: 'control',
    pinnedPeerPublicKey: to.identity.publicKey,
  });
  await flushRelay();
  const initiator = await pending;
  const responder = to.incoming[before];
  if (!responder) throw new Error('No incoming session.');
  return { initiator, responder };
}
