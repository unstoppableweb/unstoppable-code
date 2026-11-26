import type {
  ScriptRunTracking,
  StoppedScriptRun,
} from '@canopy/core-runtime/node/script/execution';
import type { WorkerScriptExecuteResult } from '@canopy/protocol/canopy-core';
import type { ExternalScriptRuns } from './script-runner';

export interface DaemonScriptRunEntry {
  readonly signal: AbortSignal;
  /** A stop or drain reached the run, or its worktree is draining: it must not run anywhere. */
  fenced(): boolean;
  /** Shows the run in the running-script views. */
  markStarted(): void;
  settle(result: WorkerScriptExecuteResult): void;
  /** Removes the run; idempotent. */
  end(): void;
}

interface Entry {
  readonly tracking: ScriptRunTracking & { runId: string };
  readonly abort: AbortController;
  started: boolean;
  result: WorkerScriptExecuteResult | null;
  readonly ended: Promise<void>;
  finish(): void;
}

function worktreeKey(projectId: string, worktreeId: string): string {
  return JSON.stringify([projectId, worktreeId]);
}

function sameScript(
  tracking: ScriptRunTracking,
  target: ScriptRunTracking,
): boolean {
  return (
    tracking.projectId === target.projectId &&
    tracking.worktreeId === target.worktreeId &&
    tracking.scriptKey === target.scriptKey &&
    (tracking.kind ?? 'script') === (target.kind ?? 'script')
  );
}

/** The runs this Electron main sent to the daemon, as `ExternalScriptRuns` (D17). */
export class DaemonScriptRuns implements ExternalScriptRuns {
  private readonly entries = new Set<Entry>();
  private readonly listeners = new Set<() => void>();
  private readonly draining = new Map<string, number>();

  constructor(
    private readonly options: {
      readonly sweep: (projectId: string, worktreeId: string) => Promise<void>;
    },
  ) {}

  begin(tracking: ScriptRunTracking & { runId: string }): DaemonScriptRunEntry {
    let finish = (): void => undefined;
    const entry: Entry = {
      tracking,
      abort: new AbortController(),
      started: false,
      result: null,
      ended: new Promise<void>((resolve) => {
        finish = resolve;
      }),
      finish: (): void => finish(),
    };
    this.entries.add(entry);
    return {
      signal: entry.abort.signal,
      fenced: (): boolean =>
        entry.abort.signal.aborted ||
        this.draining.has(worktreeKey(tracking.projectId, tracking.worktreeId)),
      markStarted: (): void => {
        if (entry.started || !this.entries.has(entry)) return;
        entry.started = true;
        this.notify();
      },
      settle: (result): void => {
        entry.result = result;
      },
      end: (): void => {
        if (!this.entries.delete(entry)) return;
        entry.finish();
        if (entry.started) this.notify();
      },
    };
  }

  list(): ScriptRunTracking[] {
    return this.started().map((entry) => entry.tracking);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  stop(target: ScriptRunTracking): Promise<StoppedScriptRun[]> {
    return this.stopEntries(
      this.started().filter((entry) => sameScript(entry.tracking, target)),
    );
  }

  async stopRun(
    target: ScriptRunTracking & { runId: string },
  ): Promise<StoppedScriptRun | null> {
    const [stopped] = await this.stopEntries(
      this.started().filter(
        (entry) =>
          sameScript(entry.tracking, target) &&
          entry.tracking.runId === target.runId,
      ),
    );
    return stopped ?? null;
  }

  drainMatching(
    target: { projectId: string; worktreeId: string },
    shouldDrain: (tracking: ScriptRunTracking) => boolean,
  ): Promise<StoppedScriptRun[]> {
    return this.stopEntries(
      this.inWorktree(target.projectId, target.worktreeId).filter(
        (entry) => entry.started && shouldDrain(entry.tracking),
      ),
    );
  }

  /**
   * Drains the worktree's daemon runs through `sweep` first, which waits for
   * each run's process tree to exit (CAN-5839), then ends this process's
   * entries, including runs not started yet.
   */
  async drainWorktree(projectId: string, worktreeId: string): Promise<void> {
    const key = worktreeKey(projectId, worktreeId);
    this.draining.set(key, (this.draining.get(key) ?? 0) + 1);
    try {
      await this.options.sweep(projectId, worktreeId);
      await this.stopEntries(this.inWorktree(projectId, worktreeId));
    } finally {
      const remaining = (this.draining.get(key) ?? 1) - 1;
      if (remaining > 0) this.draining.set(key, remaining);
      else this.draining.delete(key);
    }
  }

  stopAll(): void {
    this.entries.forEach((entry) => entry.abort.abort());
  }

  private started(): Entry[] {
    return Array.from(this.entries).filter((entry) => entry.started);
  }

  private inWorktree(projectId: string, worktreeId: string): Entry[] {
    return Array.from(this.entries).filter(
      (entry) =>
        entry.tracking.projectId === projectId &&
        entry.tracking.worktreeId === worktreeId,
    );
  }

  private async stopEntries(entries: Entry[]): Promise<StoppedScriptRun[]> {
    entries.forEach((entry) => entry.abort.abort());
    await Promise.all(entries.map((entry) => entry.ended));
    return entries.map(
      (entry): StoppedScriptRun => ({
        response: {
          success: false,
          exitCode: entry.result?.exitCode ?? null,
          output: '',
          timedOut: entry.result?.timedOut ?? false,
          durationMs: entry.result?.durationMs ?? 0,
        },
        tracking: entry.tracking,
      }),
    );
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener());
  }
}
