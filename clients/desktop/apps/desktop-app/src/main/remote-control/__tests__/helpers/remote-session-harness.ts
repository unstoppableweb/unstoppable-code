import type { SchedulerPort } from '@canopy/remote-session';

/**
 * Test-only plumbing shared by the interop goldens: an in-memory relay that
 * carries frames between desktop (Node) and portable session managers in
 * order, with hooks to tamper with, drop or duplicate frames, and a manual
 * clock for timer-driven paths.
 */
export type FrameListener = (peerDeviceId: string, payload: Buffer) => void;

export interface FrameEvent {
  from: string;
  to: string;
  payload: Buffer;
}

/** Returns the frames to deliver for one sent frame (none drops it). */
export type FrameFilter = (event: FrameEvent) => Buffer[];

export class MemoryRelayEndpoint {
  private readonly frameListeners = new Set<FrameListener>();
  private readonly offlineListeners = new Set<(peer: string) => void>();
  private readonly undeliverableListeners = new Set<(peer: string) => void>();
  readonly sent: FrameEvent[] = [];

  constructor(
    readonly deviceId: string,
    private readonly hub: MemoryRelayHub,
  ) {}

  sendFrame(peerDeviceId: string, payload: Uint8Array): boolean {
    const event = {
      from: this.deviceId,
      to: peerDeviceId,
      payload: Buffer.from(payload),
    };
    this.sent.push(event);
    return this.hub.route(event);
  }

  onFrame(listener: FrameListener): () => void {
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

  onUndeliverable(listener: (peer: string) => void): () => void {
    this.undeliverableListeners.add(listener);
    return () => this.undeliverableListeners.delete(listener);
  }

  deliver(from: string, payload: Buffer): void {
    for (const listener of Array.from(this.frameListeners))
      listener(from, payload);
  }

  peerOffline(peer: string): void {
    for (const listener of Array.from(this.offlineListeners)) listener(peer);
  }
}

export class MemoryRelayHub {
  private readonly endpoints = new Map<string, MemoryRelayEndpoint>();
  private queue: Promise<void> = Promise.resolve();
  filter: FrameFilter = (event) => [event.payload];

  endpoint(deviceId: string): MemoryRelayEndpoint {
    const endpoint = new MemoryRelayEndpoint(deviceId, this);
    this.endpoints.set(deviceId, endpoint);
    return endpoint;
  }

  route(event: FrameEvent): boolean {
    const target = this.endpoints.get(event.to);
    if (!target) return false;
    const frames = this.filter(event);
    // Delivered later and in order, as a socket would.
    this.queue = this.queue.then(
      () =>
        new Promise<void>((resolve) => {
          setImmediate(() => {
            for (const frame of frames) target.deliver(event.from, frame);
            resolve();
          });
        }),
    );
    return true;
  }

  /** Waits until every frame sent so far was delivered. */
  async settle(rounds = 20): Promise<void> {
    for (let index = 0; index < rounds; index += 1) {
      await this.queue;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  disconnect(deviceId: string): void {
    this.endpoints.delete(deviceId);
    for (const endpoint of this.endpoints.values())
      endpoint.peerOffline(deviceId);
  }
}

interface ManualTimer {
  id: number;
  at: number;
  callback: () => void;
  interval: number | null;
}

/** A scheduler whose clock moves only when a test advances it. */
export class ManualScheduler implements SchedulerPort {
  private time = 1_700_000_000_000;
  private nextId = 1;
  private readonly timers = new Map<number, ManualTimer>();

  now(): number {
    return this.time;
  }

  random(): number {
    return 0.5;
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    return this.add(callback, delayMs, null);
  }

  setInterval(callback: () => void, intervalMs: number): unknown {
    return this.add(callback, intervalMs, intervalMs);
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.timers.delete(handle);
  }

  clearInterval(handle: unknown): void {
    if (typeof handle === 'number') this.timers.delete(handle);
  }

  get pending(): number {
    return this.timers.size;
  }

  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      let next: ManualTimer | null = null;
      for (const timer of this.timers.values()) {
        if (timer.at <= target && (next === null || timer.at < next.at))
          next = timer;
      }
      if (next === null) break;
      this.time = next.at;
      if (next.interval === null) this.timers.delete(next.id);
      else next.at += next.interval;
      next.callback();
    }
    this.time = target;
  }

  private add(
    callback: () => void,
    delayMs: number,
    interval: number | null,
  ): number {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, {
      id,
      at: this.time + Math.max(0, delayMs),
      callback,
      interval,
    });
    return id;
  }
}

/** Resolves after pending microtasks and immediates have run. */
export async function flush(rounds = 10): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
