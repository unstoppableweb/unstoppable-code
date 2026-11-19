import { createHash } from 'node:crypto';
import {
  CORE_INITIATED_WORK_QUEUED_HOOK_CHAT_KIND,
  CORE_INITIATED_WORK_QUEUED_HOOK_PIPELINE_KIND,
  isTerminalOperationStatus,
  type CanopyErrorPayload,
  type CanopyJsonValue,
  type CanopyWorkspaceScope,
  type InitiatedWorkQueuedHookOutcome,
  type OperationRecord,
} from '@canopy/protocol/canopy-core';
import { validateId } from '../identifiers';
import {
  OperationLedgerRefusedError,
  type OperationReceiptInput,
} from '../operations/ledger';
import {
  OperationCancelRefusedError,
  type OperationRecovery,
  type OperationService,
} from '../operations/service';
import {
  type HookQueuePayloadStore,
  type HookQueueKind,
  type HookQueueSavedEntry,
} from './hook-queue-store';

export const HOOK_QUEUE_DOMAIN = 'core.initiatedWork.hookQueue';

export interface HookQueueEntryRef {
  kind: HookQueueKind;
  operationId: string;
  queueId: string;
  operation: OperationRecord;
}
export interface HookQueueEnqueueRequest {
  kind: HookQueueKind;
  queueId: string;
  runOperationId: string;
  actionIndex: number;
  scope: CanopyWorkspaceScope;
  payload: CanopyJsonValue;
}
export type HookQueueAdmission =
  | { status: 'queued'; operationId: string }
  | { status: 'existing'; operation: OperationRecord };
export type HookQueueLookup =
  | { status: 'none' }
  | { status: 'waiting'; operationId: string }
  | { status: 'ended'; operation: OperationRecord };
export type HookQueueResumption =
  | { status: 'queued' }
  | { status: 'model_unavailable' }
  | { status: 'invalidated'; message: string };
export type HookQueueReconciliation =
  | { status: 'started'; outcome: InitiatedWorkQueuedHookOutcome }
  | { status: 'not_started' }
  | { status: 'lost' };
export interface HookQueueHost {
  reserve(entry: HookQueueEntryRef): void;
  release(entry: HookQueueEntryRef): void;
  resume(
    entry: HookQueueEntryRef,
    saved: HookQueueSavedEntry,
    released: Promise<void>,
  ): Promise<HookQueueResumption>;
  reconcile(
    entry: HookQueueEntryRef,
    saved: HookQueueSavedEntry,
  ): Promise<HookQueueReconciliation>;
  cancel(entry: HookQueueEntryRef): Promise<void>;
  cancelled?(entry: HookQueueEntryRef): void;
}
interface PendingRecovery {
  operation: OperationRecord;
  resolve: (recovery: OperationRecovery) => void;
}
const KINDS = {
  chat: CORE_INITIATED_WORK_QUEUED_HOOK_CHAT_KIND,
  pipeline: CORE_INITIATED_WORK_QUEUED_HOOK_PIPELINE_KIND,
};
const UNREADABLE =
  "This queued hook work's saved details could not be read, so it was not run.";
function receipt(
  kind: HookQueueKind,
  queueId: string,
  runOperationId: string,
  actionIndex: number,
): OperationReceiptInput {
  validateId(queueId, 'queueId');
  validateId(runOperationId, 'runOperationId');
  return {
    caller: HOOK_QUEUE_DOMAIN,
    idempotencyKey: queueId,
    fingerprint: createHash('sha256')
      .update(kind)
      .update('\0')
      .update(runOperationId)
      .update('\0')
      .update(queueId)
      .update('\0')
      .update(String(actionIndex))
      .digest('hex'),
  };
}
function kindOf(operation: OperationRecord): HookQueueKind {
  return operation.kind === KINDS.chat ? 'chat' : 'pipeline';
}
function refOf(operation: OperationRecord): HookQueueEntryRef | null {
  const queueId = operation.receipt?.idempotencyKey;
  return queueId
    ? {
        kind: kindOf(operation),
        operationId: operation.operationId,
        queueId,
        operation,
      }
    : null;
}
function invalidated(message: string): CanopyErrorPayload {
  return {
    kind: 'failed_precondition',
    code: 'core.initiatedWork.hookQueue.invalidated',
    message,
    retry: { kind: 'never' },
  };
}
function finished(error: unknown): boolean {
  return (
    error instanceof OperationLedgerRefusedError &&
    error.refusal === 'invalid-state'
  );
}

export class HookQueue {
  private readonly hosts = new Map<HookQueueKind, HookQueueHost>();
  private readonly pending: Record<HookQueueKind, PendingRecovery[]> = {
    chat: [],
    pipeline: [],
  };
  private readonly releases = new Map<string, () => void>();
  private readonly enqueuing = new Set<string>();
  private readonly enqueueChains = new Map<string, Promise<unknown>>();
  private readonly recoveryCleanup = new Map<string, string>();
  private readonly operations: OperationService;
  private readonly payloads: HookQueuePayloadStore;
  private readonly onError: (error: unknown, context: string) => void;

  constructor(options: {
    operations: OperationService;
    payloads: HookQueuePayloadStore;
    onError?: (error: unknown, context: string) => void;
  }) {
    this.operations = options.operations;
    this.payloads = options.payloads;
    this.onError = options.onError ?? ((): void => {});
    this.operations.registerDomain({
      domain: HOOK_QUEUE_DOMAIN,
      kinds: Object.values(KINDS),
      restartClass: 'resumable',
      cancel: (operation) => this.cancelEntry(operation),
      recover: (operation) => this.recover(operation),
    });
    this.operations.subscribe(({ operation }) => {
      if (
        operation.status === 'cancelled' &&
        (operation.kind === KINDS.chat || operation.kind === KINDS.pipeline)
      ) {
        const ref = refOf(operation);
        if (ref) this.hosts.get(kindOf(operation))?.cancelled?.(ref);
      }
      if (operation.status === 'paused') return;
      this.releases.get(operation.operationId)?.();
      this.releases.delete(operation.operationId);
      const queueId = this.recoveryCleanup.get(operation.operationId);
      if (queueId && isTerminalOperationStatus(operation.status)) {
        this.recoveryCleanup.delete(operation.operationId);
        void this.payloads.remove(queueId).catch((error: unknown) => {
          this.onError(error, 'hook-queue-recovery-cleanup');
        });
      }
    });
  }

  registerHost(kind: HookQueueKind, host: HookQueueHost): void {
    this.hosts.set(kind, host);
    const pending = this.pending[kind].splice(0);
    for (const recovery of pending) this.recoverWith(host, recovery);
  }

  async lookup(
    kind: HookQueueKind,
    queueId: string,
    runOperationId: string,
    actionIndex: number,
  ): Promise<HookQueueLookup> {
    const result = await this.operations.lookupReceipt(
      KINDS[kind],
      receipt(kind, queueId, runOperationId, actionIndex),
    );
    if (result.status === 'none') return { status: 'none' };
    if (result.status === 'key-reused')
      throw new OperationLedgerRefusedError(
        'key-reused',
        'This request was already made with different details.',
      );
    if (result.status === 'in-progress')
      return { status: 'waiting', operationId: result.operation.operationId };
    return { status: 'ended', operation: result.operation };
  }

  enqueue(request: HookQueueEnqueueRequest): Promise<HookQueueAdmission> {
    return this.withQueueLock(request.queueId, () =>
      this.enqueueSerial(request),
    );
  }

  private withQueueLock<T>(
    queueId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const previous = this.enqueueChains.get(queueId);
    const pending = previous
      ? previous.catch(() => undefined).then(work)
      : work();
    this.enqueueChains.set(queueId, pending);
    const clear = (): void => {
      if (this.enqueueChains.get(queueId) === pending)
        this.enqueueChains.delete(queueId);
    };
    void pending.then(clear, clear);
    return pending;
  }

  private async enqueueSerial(
    request: HookQueueEnqueueRequest,
  ): Promise<HookQueueAdmission> {
    const existing = await this.lookup(
      request.kind,
      request.queueId,
      request.runOperationId,
      request.actionIndex,
    );
    if (existing.status === 'ended')
      return { status: 'existing', operation: existing.operation };
    if (existing.status === 'waiting') {
      const operation = await this.operations.get(existing.operationId);
      if (!operation) throw new Error('The queued hook work is not recorded.');
      return { status: 'existing', operation };
    }
    const run = await this.operations.get(request.runOperationId);
    if (!run)
      throw new Error('The hook run for this queued work is not recorded.');
    this.enqueuing.add(request.queueId);
    try {
      await this.payloads.write({
        version: 1,
        kind: request.kind,
        queueId: request.queueId,
        runOperationId: request.runOperationId,
        actionIndex: request.actionIndex,
        revision: 1,
        savedAt: new Date().toISOString(),
        payload: request.payload,
      });
      try {
        const admitted = await this.operations.admit({
          kind: KINDS[request.kind],
          status: 'queued',
          receipt: receipt(
            request.kind,
            request.queueId,
            request.runOperationId,
            request.actionIndex,
          ),
          origin: {
            kind: run.origin.kind,
            sourceId: run.origin.sourceId,
            ...(run.origin.context !== undefined
              ? { context: run.origin.context }
              : {}),
          },
          owner: run.owner,
          scope: request.scope,
        });
        return admitted.status === 'accepted'
          ? { status: 'queued', operationId: admitted.operation.operationId }
          : { status: 'existing', operation: admitted.operation };
      } catch (error) {
        await this.payloads.remove(request.queueId);
        throw error;
      }
    } finally {
      this.enqueuing.delete(request.queueId);
    }
  }

  saveEdit(entry: HookQueueSavedEntry): Promise<void> {
    return this.payloads.write(entry);
  }

  async markStarting(operationId: string): Promise<'started' | 'ended'> {
    try {
      await this.operations.transition(operationId, 'running');
      return 'started';
    } catch (error) {
      if (finished(error)) return 'ended';
      throw error;
    }
  }

  async finishStarted(
    operationId: string,
    queueId: string,
    outcome: InitiatedWorkQueuedHookOutcome,
  ): Promise<void> {
    try {
      await this.operations.finish(operationId, {
        status: 'completed',
        outcome,
      });
    } catch (error) {
      if (!finished(error)) throw error;
    }
    await this.payloads.remove(queueId);
  }
  async finishCancelled(operationId: string, queueId: string): Promise<void> {
    try {
      await this.operations.finish(operationId, { status: 'cancelled' });
    } catch (error) {
      if (!finished(error)) throw error;
    }
    await this.payloads.remove(queueId);
  }
  async finishFailed(
    operationId: string,
    queueId: string,
    code: 'core.initiatedWork.hookQueue.startFailed',
    message: string,
  ): Promise<void> {
    try {
      await this.operations.finish(operationId, {
        status: 'failed',
        error: {
          kind: 'internal',
          code,
          message: message.slice(0, 4096),
          retry: { kind: 'never' },
        },
      });
    } catch (error) {
      if (!finished(error)) throw error;
    }
    await this.payloads.remove(queueId);
  }

  private async cancelEntry(operation: OperationRecord): Promise<'cancelled'> {
    const kind = kindOf(operation);
    const index = this.pending[kind].findIndex(
      (item) => item.operation.operationId === operation.operationId,
    );
    if (index >= 0) {
      const [pending] = this.pending[kind].splice(index, 1);
      pending.resolve({ status: 'cancelled' });
      const ref = refOf(operation);
      if (ref) await this.payloads.remove(ref.queueId);
      return 'cancelled';
    }
    const host = this.hosts.get(kind);
    if (!host)
      throw new OperationCancelRefusedError(
        'Nothing running here can cancel this queued hook work yet.',
      );
    const ref = refOf(operation);
    if (ref) await host.cancel(ref);
    return 'cancelled';
  }

  private recover(operation: OperationRecord): Promise<OperationRecovery> {
    return new Promise((resolve) => {
      const host = this.hosts.get(kindOf(operation));
      const recovery = { operation, resolve };
      if (host) this.recoverWith(host, recovery);
      else this.pending[kindOf(operation)].push(recovery);
    });
  }

  private recoverWith(host: HookQueueHost, pending: PendingRecovery): void {
    const ref = refOf(pending.operation);
    if (!ref) {
      pending.resolve({ status: 'lost' });
      return;
    }
    const released = new Promise<void>((resolve) => {
      this.releases.set(ref.operationId, resolve);
    });
    host.reserve(ref);
    void (async (): Promise<void> => {
      const before = await this.operations.statusBeforeRestart(ref.operationId);
      const read = await this.payloads.read(ref.queueId);
      if (read.status !== 'ok') {
        host.release(ref);
        pending.resolve({
          status: 'failed',
          error: invalidated(
            read.status === 'newer'
              ? 'This queued hook work was saved by a newer version of the app, so it was not run.'
              : UNREADABLE,
          ),
        });
        return;
      }
      const saved = read.entry;
      const matched = await this.operations.lookupReceipt(
        KINDS[saved.kind],
        receipt(
          saved.kind,
          saved.queueId,
          saved.runOperationId,
          saved.actionIndex,
        ),
      );
      if (
        saved.kind !== ref.kind ||
        !('operation' in matched) ||
        matched.operation.operationId !== ref.operationId
      ) {
        host.release(ref);
        pending.resolve({ status: 'failed', error: invalidated(UNREADABLE) });
        return;
      }
      if (before !== 'queued') {
        const result = await host.reconcile(ref, saved);
        if (result.status !== 'not_started') {
          host.release(ref);
          this.recoveryCleanup.set(ref.operationId, ref.queueId);
          pending.resolve(
            result.status === 'started'
              ? { status: 'completed', outcome: result.outcome }
              : { status: 'lost' },
          );
          return;
        }
      }
      const resumed = await host.resume(ref, saved, released);
      if (resumed.status !== 'queued') {
        host.release(ref);
        this.recoveryCleanup.set(ref.operationId, ref.queueId);
        pending.resolve({
          status: 'failed',
          error:
            resumed.status === 'model_unavailable'
              ? {
                  kind: 'failed_precondition',
                  code: 'core.initiatedWork.hookQueue.modelUnavailable',
                  message:
                    "The queued hook chat's model is no longer available.",
                  retry: { kind: 'never' },
                }
              : invalidated(resumed.message),
        });
      } else pending.resolve({ status: 'queued' });
    })().catch((error: unknown) => {
      this.onError(error, 'hook-queue-recover');
      host.release(ref);
      pending.resolve({ status: 'lost' });
    });
  }

  async sweep(): Promise<void> {
    for (const queueId of await this.payloads.list()) {
      if (this.enqueuing.has(queueId)) continue;
      await this.withQueueLock(queueId, async (): Promise<void> => {
        const saved = await this.payloads.read(queueId);
        if (saved.status !== 'ok') return;
        const entry = saved.entry;
        const result = await this.operations.lookupReceipt(
          KINDS[entry.kind],
          receipt(entry.kind, queueId, entry.runOperationId, entry.actionIndex),
        );
        if (result.status === 'key-reused')
          this.onError(
            new Error('The queued hook work receipt has different details.'),
            'hook-queue-sweep',
          );
        else if (result.status !== 'in-progress')
          await this.payloads.remove(queueId);
      });
    }
  }
}
