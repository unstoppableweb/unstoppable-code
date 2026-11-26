import type {
  CanopyErrorPayload,
  OperationOrigin,
  OperationRecord,
} from '@canopy/protocol/canopy-core';
import { OperationLedgerRefusedError } from '../operations/ledger/errors';
import type { OperationReceiptInput } from '../operations/ledger';
import type {
  OperationRecovery,
  OperationServicePort,
} from '../operations/service';

export const CORE_SUMMARY_DOMAIN = 'core.summary';
export const CORE_SUMMARY_REGENERATE_KIND = 'core.summary.regenerate';
export const SUMMARY_DEBOUNCE_MS = 30_000;
export const SUMMARY_LEDGER_QUIET_MS = 5 * 60_000;
export const SUMMARY_LEDGER_MAX_WAIT_MS = 30 * 60_000;
export const SUMMARY_RECOVERY_DELAY_MS = 60_000;
export const SUMMARY_GENERATION_FAILED: CanopyErrorPayload = {
  kind: 'internal',
  code: 'core.summary.generationFailed',
  message: 'The summary could not be generated.',
  retry: { kind: 'never' },
};
export const SUMMARY_SCHEDULE_SOURCE_ID = 'summary-schedule';

export type SummaryMode = 'incremental' | 'full';

export interface SummaryScope {
  workspaceId: string;
  worktreeId: string;
}

/** What one generation did. Portable: no summary text, provider output or path. */
export type SummaryGenerationResult =
  | { result: 'written'; sourceRevision: string }
  | { result: 'unchanged'; sourceRevision: string }
  | { result: 'skipped' }
  | { result: 'cancelled' };

export interface SummaryTimerHandle {
  cancel(): void;
}

export interface CoreSummaryScheduleHost {
  /** False in E2E builds: completed turns schedule nothing and nothing resumes. */
  isAutomaticSchedulingEnabled(): boolean;
  /** `ledger` while Summary publication is enabled, else `debounce`. Read per schedule. */
  cadence(): 'debounce' | 'ledger';
  hasActiveTurns(scope: SummaryScope): boolean;
  now(): number;
  setTimer(callback: () => void, delayMs: number): SummaryTimerHandle;
  /** One generation. Resolves with what it did; rejects when it failed. */
  generate(
    scope: SummaryScope,
    mode: SummaryMode,
    signal: AbortSignal,
  ): Promise<SummaryGenerationResult>;
  onError(error: unknown, context: string): void;
}

interface QueuedGeneration {
  operationId: string;
  mode: SummaryMode;
  timer?: SummaryTimerHandle;
  ready: boolean;
  firstDeferredAt?: number;
}

interface RunningGeneration {
  operationId: string;
  controller: AbortController;
}

interface ScopeState {
  queued?: QueuedGeneration;
  running?: RunningGeneration;
}

interface PendingRecovery {
  operation: OperationRecord;
  resolve(recovery: OperationRecovery): void;
}

function scopeKey(scope: SummaryScope): string {
  return `${scope.workspaceId}\u0000${scope.worktreeId}`;
}

function summaryScopeOf(operation: OperationRecord): SummaryScope | null {
  const { workspaceId, worktreeId } = operation.scope;
  return workspaceId && worktreeId ? { workspaceId, worktreeId } : null;
}

function summaryModeOf(operation: OperationRecord): SummaryMode | null {
  const context = operation.origin.context;
  if (typeof context !== 'object' || context === null || Array.isArray(context))
    return null;
  const mode = context.mode;
  return mode === 'incremental' || mode === 'full' ? mode : null;
}

/**
 * Worktree summary generations as `core.summary.regenerate` operations
 * (CAN-4114). The schedule owns the debounce and Ledger cadence, coalescing,
 * manual refresh and cancellation; the host supplies every fact and runs the
 * generation. A generation queued before a restart runs once after it; one
 * a restart interrupted is never run again.
 */
export class CoreSummarySchedule {
  private readonly operations: OperationServicePort;
  private readonly owner: { kind: 'system'; id: string };
  private readonly scopes = new Map<string, ScopeState>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly pendingRecoveries: PendingRecovery[] = [];
  private host: CoreSummaryScheduleHost | null = null;

  constructor(options: { operations: OperationServicePort; ownerId: string }) {
    this.operations = options.operations;
    this.owner = { kind: 'system', id: options.ownerId };
    this.operations.registerDomain({
      domain: CORE_SUMMARY_DOMAIN,
      kinds: [CORE_SUMMARY_REGENERATE_KIND],
      restartClass: 'resumable',
      cancel: (operation) => this.cancelOperation(operation),
      recover: (operation) => this.recover(operation),
    });
  }

  /** Recoveries wait for the host, as HookQueue's do. Call once. */
  registerHost(host: CoreSummaryScheduleHost): void {
    if (this.host) throw new Error('The summary schedule already has a host.');
    this.host = host;
    for (const recovery of this.pendingRecoveries.splice(0))
      this.recoverWith(host, recovery);
  }

  /** A completed turn: arm the debounce or Ledger cadence for the scope. */
  schedule(scope: SummaryScope): Promise<void> {
    const host = this.requireHost();
    if (!host.isAutomaticSchedulingEnabled()) return Promise.resolve();
    const key = scopeKey(scope);
    return this.withScopeLock(key, async () => {
      const state = this.stateOf(key);
      if (!state.queued) {
        const accepted = await this.operations.admit({
          kind: CORE_SUMMARY_REGENERATE_KIND,
          status: 'queued',
          origin: {
            kind: 'system',
            sourceId: SUMMARY_SCHEDULE_SOURCE_ID,
            context: { mode: 'incremental' },
          },
          owner: this.owner,
          scope: { ...scope },
        });
        state.queued = {
          operationId: accepted.operation.operationId,
          mode: 'incremental',
          ready: false,
        };
      }
      const queued = state.queued;
      queued.timer?.cancel();
      queued.timer = undefined;
      if (host.cadence() === 'ledger') {
        queued.firstDeferredAt ??= host.now();
        this.armLedgerCadence(host, scope, queued, SUMMARY_LEDGER_QUIET_MS);
        return;
      }
      queued.firstDeferredAt = undefined;
      this.armTimer(host, scope, queued, SUMMARY_DEBOUNCE_MS, () =>
        this.markReady(scope),
      );
    });
  }

  /** A manual refresh: generate in full mode now, or right after the running one. */
  refresh(
    scope: SummaryScope,
    origin: OperationOrigin,
  ): Promise<OperationRecord> {
    return this.request(scope, origin, undefined, undefined);
  }

  /**
   * A keyed request (core.summary.regenerate, PR3); same as refresh,
   * deduplicated by the receipt. `precondition` runs after the receipt lookup
   * finds no earlier request and before admission; a throw admits nothing.
   */
  regenerate(
    scope: SummaryScope,
    origin: OperationOrigin,
    receipt: OperationReceiptInput,
    precondition?: () => Promise<void>,
  ): Promise<OperationRecord> {
    return this.request(scope, origin, receipt, precondition);
  }

  /** Worktree cleanup: drop the queued run and stop the running one. */
  cancel(scope: SummaryScope): Promise<void> {
    const key = scopeKey(scope);
    return this.withScopeLock(key, async () => {
      const state = this.stateOf(key);
      const queued = state.queued;
      if (queued) {
        queued.timer?.cancel();
        state.queued = undefined;
        await this.operations.finish(queued.operationId, {
          status: 'cancelled',
        });
      }
      state.running?.controller.abort();
      this.release(key);
    });
  }

  isRunning(scope: SummaryScope): boolean {
    return this.scopes.get(scopeKey(scope))?.running !== undefined;
  }

  /** A queued or running generation exists for the scope. */
  isPending(scope: SummaryScope): boolean {
    const state = this.scopes.get(scopeKey(scope));
    return state?.queued !== undefined || state?.running !== undefined;
  }

  private request(
    scope: SummaryScope,
    origin: OperationOrigin,
    receipt: OperationReceiptInput | undefined,
    precondition: (() => Promise<void>) | undefined,
  ): Promise<OperationRecord> {
    this.requireHost();
    const key = scopeKey(scope);
    return this.withScopeLock(key, async () => {
      if (receipt) {
        const lookup = await this.operations.lookupReceipt(
          CORE_SUMMARY_REGENERATE_KIND,
          receipt,
        );
        if (lookup.status === 'key-reused')
          throw new OperationLedgerRefusedError(
            'key-reused',
            'This idempotency key was used with other parameters.',
          );
        if (lookup.status !== 'none') return lookup.operation;
        await precondition?.();
      }
      const state = this.stateOf(key);
      const superseded = state.queued;
      if (superseded) {
        superseded.timer?.cancel();
        state.queued = undefined;
        await this.operations.finish(superseded.operationId, {
          status: 'completed',
          outcome: { result: 'superseded' },
        });
      }
      const accepted = await this.operations.admit({
        kind: CORE_SUMMARY_REGENERATE_KIND,
        status: 'queued',
        origin,
        owner: this.owner,
        scope: { ...scope },
        ...(receipt ? { receipt } : {}),
      });
      if (accepted.status !== 'accepted') return accepted.operation;
      state.queued = {
        operationId: accepted.operation.operationId,
        mode: 'full',
        ready: true,
      };
      if (!state.running) await this.start(scope);
      return accepted.operation;
    });
  }

  private armTimer(
    host: CoreSummaryScheduleHost,
    scope: SummaryScope,
    queued: QueuedGeneration,
    delayMs: number,
    fire: () => Promise<void>,
  ): void {
    const key = scopeKey(scope);
    const timer = host.setTimer(() => {
      void this.withScopeLock(key, async () => {
        if (this.scopes.get(key)?.queued !== queued || queued.timer !== timer)
          return;
        queued.timer = undefined;
        await fire();
      }).catch((error: unknown) => {
        host.onError(error, 'summary-timer');
      });
    }, delayMs);
    queued.timer = timer;
  }

  /**
   * Waits `delayMs`, cut short by the scope's maximum wait, then marks the
   * run ready unless a turn is running: that defers it until the turn's
   * completion restarts the quiet period, or until the maximum wait runs out.
   */
  private armLedgerCadence(
    host: CoreSummaryScheduleHost,
    scope: SummaryScope,
    queued: QueuedGeneration,
    delayMs: number,
  ): void {
    const deadline =
      (queued.firstDeferredAt ?? host.now()) + SUMMARY_LEDGER_MAX_WAIT_MS;
    this.armTimer(
      host,
      scope,
      queued,
      Math.max(0, Math.min(delayMs, deadline - host.now())),
      () => this.ledgerCadenceFired(host, scope, queued, deadline),
    );
  }

  private async ledgerCadenceFired(
    host: CoreSummaryScheduleHost,
    scope: SummaryScope,
    queued: QueuedGeneration,
    deadline: number,
  ): Promise<void> {
    const remainingMs = deadline - host.now();
    if (remainingMs > 0 && host.hasActiveTurns(scope)) {
      this.armLedgerCadence(host, scope, queued, remainingMs);
      return;
    }
    queued.firstDeferredAt = undefined;
    await this.markReady(scope);
  }

  /** Runs under the scope lock. */
  private async markReady(scope: SummaryScope): Promise<void> {
    const state = this.stateOf(scopeKey(scope));
    if (!state.queued) return;
    state.queued.ready = true;
    if (!state.running) await this.start(scope);
  }

  /** Runs under the scope lock: moves the ready queued run to running. */
  private async start(scope: SummaryScope): Promise<void> {
    const host = this.requireHost();
    const key = scopeKey(scope);
    const state = this.stateOf(key);
    const queued = state.queued;
    if (!queued?.ready || state.running) return;
    queued.timer?.cancel();
    state.queued = undefined;
    const running: RunningGeneration = {
      operationId: queued.operationId,
      controller: new AbortController(),
    };
    state.running = running;
    try {
      await this.operations.transition(queued.operationId, 'running');
    } catch (error) {
      state.running = undefined;
      host.onError(error, 'summary-start');
      this.release(key);
      return;
    }
    void this.execute(host, scope, running, queued.mode);
  }

  private async execute(
    host: CoreSummaryScheduleHost,
    scope: SummaryScope,
    running: RunningGeneration,
    mode: SummaryMode,
  ): Promise<void> {
    const { signal } = running.controller;
    let settled:
      | { kind: 'resolved'; value: SummaryGenerationResult }
      | { kind: 'rejected'; error: unknown };
    try {
      settled = {
        kind: 'resolved',
        value: await host.generate(scope, mode, signal),
      };
    } catch (error) {
      settled = { kind: 'rejected', error };
    }
    const key = scopeKey(scope);
    await this.withScopeLock(key, async () => {
      try {
        await this.settle(host, running, settled);
      } catch (error) {
        host.onError(error, 'summary-settle');
      }
      const state = this.stateOf(key);
      if (state.running === running) state.running = undefined;
      if (state.queued?.ready) await this.start(scope);
      this.release(key);
    }).catch((error: unknown) => {
      host.onError(error, 'summary-settle');
    });
  }

  private async settle(
    host: CoreSummaryScheduleHost,
    running: RunningGeneration,
    settled:
      | { kind: 'resolved'; value: SummaryGenerationResult }
      | { kind: 'rejected'; error: unknown },
  ): Promise<void> {
    const { operationId, controller } = running;
    if (
      controller.signal.aborted ||
      (settled.kind === 'resolved' && settled.value.result === 'cancelled')
    ) {
      await this.operations.finish(operationId, { status: 'cancelled' });
      return;
    }
    if (settled.kind === 'rejected') {
      host.onError(settled.error, 'summary-generate');
      await this.operations.finish(operationId, {
        status: 'failed',
        error: SUMMARY_GENERATION_FAILED,
      });
      return;
    }
    const { value } = settled;
    await this.operations.finish(operationId, {
      status: 'completed',
      outcome:
        value.result === 'written' || value.result === 'unchanged'
          ? { result: value.result, sourceRevision: value.sourceRevision }
          : { result: 'skipped' },
    });
  }

  private async cancelOperation(
    operation: OperationRecord,
  ): Promise<'cancelled' | 'requested'> {
    const scope = summaryScopeOf(operation);
    if (!scope) return 'cancelled';
    const key = scopeKey(scope);
    return this.withScopeLock(key, async () => {
      const state = this.stateOf(key);
      const queued = state.queued;
      if (queued?.operationId === operation.operationId) {
        queued.timer?.cancel();
        state.queued = undefined;
        await this.operations.finish(queued.operationId, {
          status: 'cancelled',
        });
        this.release(key);
        return 'cancelled';
      }
      if (state.running?.operationId === operation.operationId) {
        state.running.controller.abort();
        return 'requested';
      }
      this.release(key);
      return 'cancelled';
    });
  }

  private recover(operation: OperationRecord): Promise<OperationRecovery> {
    return new Promise((resolve) => {
      const recovery = { operation, resolve };
      if (this.host) this.recoverWith(this.host, recovery);
      else this.pendingRecoveries.push(recovery);
    });
  }

  private recoverWith(
    host: CoreSummaryScheduleHost,
    recovery: PendingRecovery,
  ): void {
    const { operation } = recovery;
    void (async (): Promise<OperationRecovery> => {
      const scope = summaryScopeOf(operation);
      const mode = summaryModeOf(operation);
      if (!scope || !mode || !host.isAutomaticSchedulingEnabled())
        return { status: 'cancelled' };
      const before = await this.operations.statusBeforeRestart(
        operation.operationId,
      );
      if (before !== 'queued') return { status: 'lost' };
      const key = scopeKey(scope);
      return this.withScopeLock(key, (): Promise<OperationRecovery> => {
        const state = this.stateOf(key);
        if (state.queued) return Promise.resolve({ status: 'cancelled' });
        const queued: QueuedGeneration = {
          operationId: operation.operationId,
          mode,
          ready: false,
          firstDeferredAt: host.now(),
        };
        state.queued = queued;
        this.armTimer(host, scope, queued, SUMMARY_RECOVERY_DELAY_MS, () =>
          host.cadence() === 'ledger'
            ? this.ledgerCadenceFired(
                host,
                scope,
                queued,
                (queued.firstDeferredAt ?? host.now()) +
                  SUMMARY_LEDGER_MAX_WAIT_MS,
              )
            : this.markReady(scope),
        );
        return Promise.resolve({ status: 'queued' });
      });
    })().then(
      (result) => recovery.resolve(result),
      (error: unknown) => {
        host.onError(error, 'summary-recover');
        recovery.resolve({ status: 'lost' });
      },
    );
  }

  private requireHost(): CoreSummaryScheduleHost {
    if (!this.host)
      throw new Error('The summary schedule has no host registered.');
    return this.host;
  }

  private stateOf(key: string): ScopeState {
    let state = this.scopes.get(key);
    if (!state) {
      state = {};
      this.scopes.set(key, state);
    }
    return state;
  }

  private release(key: string): void {
    const state = this.scopes.get(key);
    if (state && !state.queued && !state.running) this.scopes.delete(key);
  }

  private withScopeLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key);
    const pending = previous
      ? previous.catch(() => undefined).then(work)
      : work();
    this.chains.set(key, pending);
    const clear = (): void => {
      if (this.chains.get(key) === pending) this.chains.delete(key);
    };
    void pending.then(clear, clear);
    return pending;
  }
}
