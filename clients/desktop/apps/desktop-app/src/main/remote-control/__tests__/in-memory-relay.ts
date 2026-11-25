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
  /**
   * Frames held for a device, delivered together by `release` as one
   * socket read hands a client several frames at once.
   */
  private readonly held = new Map<string, Array<() => void>>();

  /** Holds every frame to `deviceId` until `release`. */
  hold(deviceId: string): void {
    if (!this.held.has(deviceId)) this.held.set(deviceId, []);
  }

  heldCount(deviceId: string): number {
    return this.held.get(deviceId)?.length ?? 0;
  }

  /** Delivers the held frames in order, in one go, and stops holding. */
  release(deviceId: string): void {
    const frames = this.held.get(deviceId) ?? [];
    this.held.delete(deviceId);
    for (const deliver of frames) deliver();
  }

  /** Each device's relay link; a cut loses every frame in flight on it. */
  private readonly links = new Map<string, number>();

  /** The device's relay connection is cut, as a relay restart does. */
  cut(deviceId: string): void {
    this.links.set(deviceId, this.link(deviceId) + 1);
  }

  private link(deviceId: string): number {
    return this.links.get(deviceId) ?? 0;
  }

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
    const fromLink = this.link(from);
    const toLink = this.link(to);
    const deliver = (): void => {
      if (this.link(from) !== fromLink || this.link(to) !== toLink) return;
      target.deliver(from, copy);
    };
    const held = this.held.get(to);
    if (held) held.push(deliver);
    else setImmediate(deliver);
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
  private readonly onlineListeners = new Set<(peer: string) => void>();

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

  /**
   * Loses the relay connection: frames in flight to or from this device are
   * dropped, and each side sees the other go offline.
   */
  dropConnection(): void {
    if (!this.online) return;
    const peers = this.hub.peersOf(this.deviceId);
    this.online = false;
    this.connectionStatus = 'stopped';
    this.hub.cut(this.deviceId);
    this.hub.unregister(this);
    for (const peer of peers) this.peerOffline(peer.deviceId);
  }

  /** Joins again; each side sees the other come online. */
  restoreConnection(peers: ReadonlyArray<InMemoryRelayEndpoint>): void {
    this.online = true;
    this.connectionStatus = 'connected';
    this.hub.register(this);
    for (const peer of peers) {
      if (!peer.online) continue;
      this.peerOnline(peer.deviceId);
      peer.peerOnline(this.deviceId);
    }
  }

  peerOnline(deviceId: string): void {
    for (const listener of Array.from(this.onlineListeners)) listener(deviceId);
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

  // Only restoreConnection announces a peer online.
  onPeerOnline(listener: (peer: string) => void): () => void {
    this.onlineListeners.add(listener);
    return () => this.onlineListeners.delete(listener);
  }
}

export async function flushRelay(rounds = 20): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
