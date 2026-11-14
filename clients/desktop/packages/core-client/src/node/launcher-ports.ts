// Host-injected stand-ins for the C5 startup claim and C2c supervised launch;
// replace with their contracts once those land.
import type { CanopyDaemonProcessInspector } from './daemon-ports';

/** Opaque, unique token per acquisition; never reused, retained on adoption. */
export type CanopyStartupClaimHandle = object;

export type CanopyStartupClaimAcquisition =
  | {
      readonly kind: 'acquired';
      readonly handle: CanopyStartupClaimHandle;
      /** Bind proof retained when this acquisition replaced a departed lineage. */
      readonly recovered?: { readonly endpointBound: boolean };
    }
  | { readonly kind: 'held' | 'ambiguous' };

export interface CanopyStartupClaimPort {
  tryAcquire(signal: AbortSignal): Promise<CanopyStartupClaimAcquisition>;
  /** Called only after confirmed child cleanup; signal fences late release completion. Never unlinks an endpoint. */
  release(
    handle: CanopyStartupClaimHandle,
    signal?: AbortSignal,
  ): Promise<'released' | 'not_owner' | 'ambiguous'>;
}

export interface CanopyDaemonSpawnCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly signal: AbortSignal;
  /** Handed to the child for adoption; never encoded into `args`. */
  readonly claimHandle?: CanopyStartupClaimHandle;
}

export interface CanopySpawnedDaemon {
  readonly pid: number;
  readonly exited: Promise<{
    readonly code: number | null;
    readonly signal: string | null;
  }>;
}

export interface CanopyDaemonSupervisor extends CanopyDaemonProcessInspector {
  /**
   * Resolves once a child exists. If native handle construction fails and
   * cleanup is unconfirmed, rejects with a CanopyClientError carrying
   * cleanupUnconfirmed=true; the launcher must retain its startup claim.
   */
  spawnDaemon(command: CanopyDaemonSpawnCommand): Promise<CanopySpawnedDaemon>;
  /** Atomically disowns an authenticated serving child; retained adapters need no commit hook. */
  commitDaemon?(daemon: CanopySpawnedDaemon, signal: AbortSignal): void;
  /** Stops the entire owned group, including descendants after root exit. */
  terminateDaemon(
    daemon: CanopySpawnedDaemon,
    signal: AbortSignal,
  ): Promise<void>;
}
