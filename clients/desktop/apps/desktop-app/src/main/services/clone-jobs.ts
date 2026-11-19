import { repositoryCloneErrorMessage } from '@canopy/protocol/remote-control/shell';
import { basename } from 'node:path';
import type { CloneJobSnapshot } from '@canopy/desktop-shared/types';
import {
  estimateClonePercent,
  inferCloneRepoName,
  redactRemoteUrlCredentials,
  redactRemoteUrlCredentialsInText,
  type GitCloneProgressUpdate,
} from '../lib/git-clone-progress';

/** Rejection for a clone the user cancelled or the app stopped. */
export class CloneCancelledError extends Error {
  constructor() {
    super('Clone cancelled');
    this.name = 'CloneCancelledError';
  }
}

/** Handle the clone work uses to report into its job. */
export interface CloneJobContext {
  signal: AbortSignal;
  /**
   * Record the empty checkout directory this clone has reserved, and how to
   * release that reservation once the job has removed the directory.
   */
  setDestination: (
    path: string,
    releaseRemovedDestination?: () => Promise<void>,
  ) => void;
  progress: (update: GitCloneProgressUpdate) => void;
  /** The checkout is complete; the project is now being added. */
  finishing: () => void;
}

export interface CloneJobRegistryDependencies {
  changed: (jobs: CloneJobSnapshot[]) => void;
  removeDirectory: (path: string) => Promise<void>;
  now: () => number;
  /** Minimum spacing of progress-only broadcasts. State changes are immediate. */
  progressThrottleMs?: number;
}

interface CloneJobEntry {
  snapshot: CloneJobSnapshot;
  controller: AbortController;
  settled: Promise<void>;
  /** The user asked to cancel; a shutdown abort leaves this unset. */
  cancelRequested?: boolean;
  releaseRemovedDestination?: () => Promise<void>;
}

const DEFAULT_PROGRESS_THROTTLE_MS = 250;
const SHUTDOWN_TIMEOUT_MS = 5_000;

/**
 * In-memory registry of interactive Add project clones. Main owns every job:
 * renderers observe snapshots and ask to background, cancel, or dismiss.
 *
 * A job that finishes while still in the foreground is dropped at once (the
 * Add project dialog handles the outcome). A background job keeps its terminal
 * state until the renderer dismisses it. Cancelled jobs are always dropped
 * after their partial checkout is removed.
 */
export class CloneJobRegistry {
  private readonly jobs = new Map<string, CloneJobEntry>();
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastBroadcastAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly deps: CloneJobRegistryDependencies) {}

  list(): CloneJobSnapshot[] {
    return Array.from(this.jobs.values()).map((entry) => ({
      ...entry.snapshot,
    }));
  }

  async run<T extends { id: string; name: string }>(
    input: {
      id: string;
      remoteUrl: string;
      /**
       * Keep a partial checkout when the clone fails or the app shuts down,
       * for recovery. An explicit Cancel still removes it.
       */
      preserveDestinationOnFailure?: boolean;
    },
    work: (context: CloneJobContext) => Promise<T>,
  ): Promise<T> {
    if (this.jobs.has(input.id)) {
      throw new Error('A clone with this id is already running');
    }
    const controller = new AbortController();
    let markSettled: () => void = () => undefined;
    const entry: CloneJobEntry = {
      controller,
      settled: new Promise<void>((resolve) => {
        markSettled = resolve;
      }),
      snapshot: {
        id: input.id,
        repoName: inferCloneRepoName(input.remoteUrl),
        remoteUrl: redactRemoteUrlCredentials(input.remoteUrl),
        destinationPath: null,
        status: 'running',
        phase: 'starting',
        phasePercent: null,
        percent: 0,
        processedCount: null,
        totalCount: null,
        received: null,
        throughput: null,
        startedAt: this.deps.now(),
        background: false,
        cancellable: true,
        workspaceId: null,
        workspaceName: null,
        error: null,
      },
    };
    this.jobs.set(input.id, entry);
    this.flush();
    const snapshot = entry.snapshot;

    try {
      const result = await work({
        signal: controller.signal,
        setDestination: (path, releaseRemovedDestination): void => {
          entry.releaseRemovedDestination = releaseRemovedDestination;
          snapshot.destinationPath = path;
          snapshot.repoName = basename(path);
          this.flush();
        },
        progress: (update): void => {
          if (snapshot.phase === 'finishing') return;
          snapshot.phase = update.phase;
          snapshot.phasePercent = update.percent;
          snapshot.processedCount = update.processed;
          snapshot.totalCount = update.total;
          if (update.received !== null) snapshot.received = update.received;
          if (update.throughput !== null)
            snapshot.throughput = update.throughput;
          snapshot.percent = Math.max(
            snapshot.percent,
            estimateClonePercent(update.phase, update.percent),
          );
          this.scheduleProgressBroadcast();
        },
        finishing: (): void => {
          snapshot.phase = 'finishing';
          snapshot.phasePercent = null;
          snapshot.processedCount = null;
          snapshot.totalCount = null;
          snapshot.throughput = null;
          snapshot.cancellable = false;
          snapshot.percent = Math.max(
            snapshot.percent,
            estimateClonePercent('finishing', null),
          );
          this.flush();
        },
      });
      // A cancel can race the last moments of a clone that still succeeds.
      // Honor it rather than adding a project the user asked to stop.
      if (controller.signal.aborted && snapshot.phase !== 'finishing') {
        throw new CloneCancelledError();
      }
      if (snapshot.background) {
        snapshot.status = 'succeeded';
        snapshot.percent = 100;
        snapshot.cancellable = false;
        snapshot.workspaceId = result.id;
        snapshot.workspaceName = result.name;
      } else {
        this.jobs.delete(input.id);
      }
      this.flush();
      return result;
    } catch (error) {
      const cancelled = controller.signal.aborted;
      // Before `finishing` the checkout is partial. The work callback must
      // reserve the directory before reporting it via setDestination.
      // After `finishing` the clone is complete and stays on disk, matching
      // the behavior when adding the project fails. A caller preserving
      // failures keeps the checkout after an error or shutdown; only the
      // user's Cancel discards it.
      if (
        (!input.preserveDestinationOnFailure ||
          (cancelled && entry.cancelRequested === true)) &&
        snapshot.phase !== 'finishing' &&
        snapshot.destinationPath
      ) {
        try {
          await this.deps.removeDirectory(snapshot.destinationPath);
        } catch (cleanupError) {
          const failure =
            cleanupError instanceof Error
              ? cleanupError
              : new Error('Unable to remove the partial checkout');
          snapshot.status = 'failed';
          snapshot.background = true;
          snapshot.cancellable = false;
          snapshot.throughput = null;
          snapshot.error = redactRemoteUrlCredentialsInText(
            `Couldn't remove the incomplete clone at ${snapshot.destinationPath}. Remove it manually.`,
          );
          this.flush();
          throw failure;
        }
        // Released only after the removal: a crash in between leaves a held
        // reservation for launch recovery, never a released live checkout.
        try {
          await entry.releaseRemovedDestination?.();
        } catch {
          // The reservation stays held; launch recovery reports it.
        }
      }
      if (cancelled && snapshot.phase !== 'finishing') {
        this.jobs.delete(input.id);
        this.flush();
        throw new CloneCancelledError();
      }
      if (snapshot.background) {
        snapshot.status = 'failed';
        snapshot.cancellable = false;
        snapshot.throughput = null;
        snapshot.error = repositoryCloneErrorMessage(error);
      } else {
        this.jobs.delete(input.id);
      }
      this.flush();
      throw error;
    } finally {
      markSettled();
    }
  }

  /** Hand a running job to the sidebar. False when it already finished. */
  background(id: string): boolean {
    const entry = this.jobs.get(id);
    if (!entry || entry.snapshot.status !== 'running') return false;
    entry.snapshot.background = true;
    this.flush();
    return true;
  }

  /**
   * Stop a running clone and wait until its process has exited and the job
   * has settled. No-op once the project is being added.
   *
   * Resolves once the clone has stopped, even when its partial checkout
   * could not be removed: that failure is reported on the job, which stays
   * failed in the background with manual removal guidance until dismissed.
   */
  async cancel(id: string): Promise<void> {
    const entry = this.jobs.get(id);
    if (
      !entry ||
      entry.snapshot.status !== 'running' ||
      !entry.snapshot.cancellable
    ) {
      return;
    }
    entry.snapshot.status = 'cancelling';
    entry.snapshot.cancellable = false;
    entry.snapshot.throughput = null;
    entry.cancelRequested = true;
    this.flush();
    entry.controller.abort();
    await entry.settled;
  }

  dismiss(id: string): void {
    const entry = this.jobs.get(id);
    if (
      !entry ||
      (entry.snapshot.status !== 'succeeded' &&
        entry.snapshot.status !== 'failed')
    ) {
      return;
    }
    this.jobs.delete(id);
    this.flush();
  }

  /**
   * Abort every running clone and wait (bounded) for it to settle. Unlike
   * Cancel, a shutdown keeps checkouts a caller preserves for recovery.
   */
  async shutdown(): Promise<void> {
    const pending = Array.from(this.jobs.values()).filter(
      (entry) =>
        entry.snapshot.status === 'running' ||
        entry.snapshot.status === 'cancelling',
    );
    for (const entry of pending) entry.controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(pending.map((entry) => entry.settled)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
  }

  private scheduleProgressBroadcast(): void {
    if (this.throttleTimer) return;
    const throttleMs =
      this.deps.progressThrottleMs ?? DEFAULT_PROGRESS_THROTTLE_MS;
    const wait = this.lastBroadcastAt + throttleMs - this.deps.now();
    if (wait <= 0) {
      this.flush();
      return;
    }
    this.throttleTimer = setTimeout(() => {
      this.throttleTimer = null;
      this.flush();
    }, wait);
  }

  private flush(): void {
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
    this.lastBroadcastAt = this.deps.now();
    this.deps.changed(this.list());
  }
}
