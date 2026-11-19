import type {
  CanopyRuntimeDescriptor,
  CanopyRuntimeDescriptorSource,
} from '../../daemon-ports';
import { canopyConnectError, type CanopyClientEndpoint } from '../../endpoint';
import type {
  CanopyDaemonSpawnCommand,
  CanopyDaemonSupervisor,
  CanopyStartupClaimHandle,
  CanopyStartupClaimPort,
} from '../../launcher-ports';

export type ScriptedPort =
  | 'read'
  | 'readToken'
  | 'inspect'
  | 'acquire'
  | 'release'
  | 'spawn'
  | 'terminate'
  | 'attach';

export const descriptorFor = (
  pid: number,
  major = 1,
): CanopyRuntimeDescriptor => ({
  version: 1,
  pid,
  startIdentity: `start-${pid}`,
  endpoint: { kind: 'socket', path: '/private/run/core.sock' },
  protocolRange: { min: major, max: major },
  buildVersion: '1.0.0',
  tokenRef: 'secret-token-ref',
});

/** Scripted descriptor, process table, claim, supervisor, and attach; records an ordered event log. */
export class ScriptedDaemon {
  readonly events: string[] = [];
  readonly spawns: CanopyDaemonSpawnCommand[] = [];
  readonly endpoints: CanopyClientEndpoint[] = [];
  readonly released: CanopyStartupClaimHandle[] = [];
  /** One fresh token per acquisition, never reused; `handle` is the latest. */
  readonly acquired: CanopyStartupClaimHandle[] = [];
  handle: CanopyStartupClaimHandle = { opaque: true };
  /** Released tokens: releasing one again, or any but the latest, has no effect. */
  readonly freed = new Set<CanopyStartupClaimHandle>();
  readonly live = new Map<number, string>();
  /** Answered in order; the last one repeats. */
  acquisitions: Array<'acquired' | 'held' | 'ambiguous'> = ['acquired'];
  releaseResult: 'released' | 'not_owner' | 'ambiguous' = 'released';
  refusals = 0;
  raw: unknown = null;
  /** What the spawned child does; by default it publishes after 10 ms unless it already exited. */
  child = (pid: number): void =>
    void setTimeout(() => this.live.has(pid) && this.publish(pid), 10);
  /** Awaited before a port answers: never-settling, late, or failing ports. */
  readonly gates = new Map<ScriptedPort, () => Promise<unknown>>();
  private readonly exits = new Map<
    number,
    (code: number | null, signal: string | null) => void
  >();

  publish(pid: number, major = 1): void {
    this.live.set(pid, `start-${pid}`);
    this.raw = descriptorFor(pid, major);
  }

  exit(
    pid: number,
    code: number | null = 1,
    signal: string | null = null,
  ): void {
    this.live.delete(pid);
    this.exits.get(pid)?.(code, signal);
  }

  hang(port: ScriptedPort): void {
    this.gates.set(port, () => new Promise<never>(() => {}));
  }

  /** Holds a port until the test opens it or fails it with a leaky error. */
  defer(port: ScriptedPort): { open(): void; fail(): void } {
    const latch = { open: (): void => {}, fail: (): void => {} };
    const gate = new Promise<void>((resolve, reject) => {
      latch.open = resolve;
      latch.fail = (): void => reject(new Error('/private secret'));
    });
    this.gates.set(port, () => gate);
    return latch;
  }

  count(event: string): number {
    return this.events.filter((entry) => entry.startsWith(event)).length;
  }

  private async step<T>(
    port: ScriptedPort,
    event: string,
    answer: () => T,
  ): Promise<T> {
    this.events.push(event);
    await this.gates.get(port)?.();
    return answer();
  }

  readonly descriptor: CanopyRuntimeDescriptorSource = {
    read: () => this.step('read', 'read', () => this.raw),
    readToken: (ref) => this.step('readToken', `token:${ref}`, () => 'secret'),
  };

  readonly supervisor: CanopyDaemonSupervisor = {
    inspectProcess: (pid) =>
      this.step('inspect', `inspect:${pid}`, () => {
        const startIdentity = this.live.get(pid);
        return startIdentity === undefined ? null : { startIdentity };
      }),
    spawnDaemon: (command) =>
      this.step('spawn', 'spawn', () => {
        const pid = 900;
        this.spawns.push(command);
        this.live.set(pid, `start-${pid}`);
        const exited = new Promise<{
          code: number | null;
          signal: string | null;
        }>((done) =>
          this.exits.set(pid, (code, signal) => done({ code, signal })),
        );
        this.child(pid);
        return { pid, exited };
      }),
    terminateDaemon: (daemon) =>
      this.step('terminate', `terminate:${daemon.pid}`, () => {
        if (this.terminateExits) this.exit(daemon.pid);
      }),
  };

  /** Whether `terminateDaemon` makes the child exit. */
  terminateExits = true;

  readonly claim: CanopyStartupClaimPort = {
    tryAcquire: () =>
      this.step('acquire', 'acquire', () => {
        const kind = this.acquisitions[0] ?? 'acquired';
        if (this.acquisitions.length > 1) this.acquisitions.shift();
        if (kind !== 'acquired') return { kind };
        this.handle = { opaque: true };
        this.acquired.push(this.handle);
        return { kind, handle: this.handle };
      }),
    /** Atomic compare-and-release of the latest token. */
    release: (handle) =>
      this.step('release', 'release', () => {
        this.released.push(handle);
        if (handle !== this.handle || this.freed.has(handle))
          return 'not_owner';
        if (this.releaseResult === 'released') this.freed.add(handle);
        return this.releaseResult;
      }),
  };

  readonly attach = (
    endpoint: CanopyClientEndpoint,
    setup: { readonly timeoutMs: number },
  ): Promise<string> =>
    this.step('attach', `attach:${setup.timeoutMs}`, () => {
      this.endpoints.push(endpoint);
      if (this.refusals-- > 0)
        throw canopyConnectError('unavailable', 'No core accepted.');
      return `client-${this.endpoints.length}`;
    });
}
