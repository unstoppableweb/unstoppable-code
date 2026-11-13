import type { DeviceRelayDeviceInfo } from '@canopy/protocol/device-relay';
import type {
  RelayConnectionStatus,
  RemoteRelay,
} from '../transport/relay-client';

/**
 * Test double for the device relay: routes frames between endpoints of one
 * in-process hub on the next macrotask, preserving order like the real
 * socket path.
 */
export class InMemoryRelayHub {
  private readonly endpoints = new Map<string, InMemoryRelayEndpoint>();
  readonly delivered: Array<{ from: string; to: string; bytes: number }> = [];
  /**
   * Like the real relay: a frame to a device that is not connected is
   * accepted and answered with `undeliverable`, instead of refused at once.
   */
  reportUndeliverable = false;
  /** Optional tap that may rewrite or drop frames in flight. */
  tap: ((from: string, to: string, payload: Buffer) => Buffer | null) | null =
    null;

  register(endpoint: InMemoryRelayEndpoint): void {
    this.endpoints.set(endpoint.deviceId, endpoint);
    for (const other of Array.from(this.endpoints.values())) {
      if (other !== endpoint) other.notifyPeers();
    }
  }

  unregister(endpoint: InMemoryRelayEndpoint): void {
    if (this.endpoints.get(endpoint.deviceId) !== endpoint) return;
    this.endpoints.delete(endpoint.deviceId);
    for (const other of Array.from(this.endpoints.values())) {
      other.peerOffline(endpoint.deviceId);
    }
  }

  peersOf(deviceId: string): DeviceRelayDeviceInfo[] {
    return Array.from(this.endpoints.values())
      .filter((endpoint) => endpoint.deviceId !== deviceId && endpoint.online)
      .map((endpoint) => endpoint.info());
  }

  route(from: string, to: string, payload: Uint8Array): boolean {
    const target = this.endpoints.get(to);
    if (!target || !target.online) {
      if (!this.reportUndeliverable) return false;
      const source = this.endpoints.get(from);
      setImmediate(() => source?.undeliverable(to));
      return true;
    }
    let frame: Buffer | null = Buffer.from(payload);
    if (this.tap) frame = this.tap(from, to, frame);
    if (frame === null) return true;
    const copy = Buffer.from(frame);
    this.delivered.push({ from, to, bytes: copy.byteLength });
    setImmediate(() => target.deliver(from, copy));
    return true;
  }
}

export class InMemoryRelayEndpoint implements RemoteRelay {
  readonly features: ReadonlyArray<string> = [];
  connectionStatus: RelayConnectionStatus = 'stopped';
  online = false;
  private readonly frameListeners = new Set<
    (peer: string, payload: Buffer) => void
  >();
  private readonly offlineListeners = new Set<(peer: string) => void>();
  private readonly undeliverableListeners = new Set<(peer: string) => void>();

  constructor(
    private readonly hub: InMemoryRelayHub,
    readonly info: () => DeviceRelayDeviceInfo,
    private readonly onPeersChange: () => void,
  ) {}

  get deviceId(): string {
    return this.info().deviceId;
  }

  get peers(): ReadonlyArray<DeviceRelayDeviceInfo> {
    return this.online ? this.hub.peersOf(this.deviceId) : [];
  }

  start(): void {
    this.online = true;
    this.connectionStatus = 'connected';
    this.hub.register(this);
    this.onPeersChange();
  }

  stop(): void {
    this.online = false;
    this.connectionStatus = 'stopped';
    this.hub.unregister(this);
  }

  announce(): void {
    this.hub.register(this);
  }

  /** Drops off the hub and joins again, as a fresh relay connection does. */
  reconnectNow(): void {
    if (!this.online) return;
    this.hub.unregister(this);
    for (const peer of this.hub.peersOf(this.deviceId)) {
      this.peerOffline(peer.deviceId);
    }
    this.hub.register(this);
    this.onPeersChange();
  }

  notifyPeers(): void {
    this.onPeersChange();
  }

  peerOffline(deviceId: string): void {
    for (const listener of Array.from(this.offlineListeners))
      listener(deviceId);
    this.onPeersChange();
  }

  undeliverable(deviceId: string): void {
    for (const listener of Array.from(this.undeliverableListeners))
      listener(deviceId);
  }

  onUndeliverable(listener: (peer: string) => void): () => void {
    this.undeliverableListeners.add(listener);
    return () => this.undeliverableListeners.delete(listener);
  }

  deliver(from: string, payload: Buffer): void {
    for (const listener of Array.from(this.frameListeners)) {
      listener(from, payload);
    }
  }

  sendFrame(peerDeviceId: string, payload: Uint8Array): boolean {
    if (!this.online) return false;
    return this.hub.route(this.deviceId, peerDeviceId, payload);
  }

  onFrame(listener: (peer: string, payload: Buffer) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onPeerOffline(listener: (peer: string) => void): () => void {
    this.offlineListeners.add(listener);
    return () => this.offlineListeners.delete(listener);
  }

  // Presence here only goes offline; nothing announces a peer online.
  onPeerOnline(): () => void {
    return () => undefined;
  }
}

export async function flushRelay(rounds = 20): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
