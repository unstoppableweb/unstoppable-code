import { createHash } from 'node:crypto';
import type {
  AgentDelegationError,
  AgentDelegationEvent,
  AgentDelegationTerminalStatus,
  AgentDelegationUsage,
  AgentDelegationTranscriptItem,
} from '@canopy/protocol/delegation';
import {
  cleanupDiagnostic,
  cleanupTarget,
  describeValue,
  LocalDelegationCleanupError,
  type LocalDelegationCleanupFailure,
  type LocalDelegationCleanupResource,
  type LocalDelegationCleanupTarget,
} from './cleanup-diagnostics';
import { hasValidDelegationLineage } from './types';
import type {
  AgentRunRequest,
  AgentRunnerAdapter,
  AgentSteeringRequest,
  DelegatedEventSink,
  DelegationStopReason,
  DelegationStopReceipt,
  NativeRunHandle,
  ResolvedAgentRouteSnapshot,
  RunnerAvailability,
} from './types';
import type { ChatInputAdmission } from '@canopy/protocol/remote-control/shell/input-delivery';
import type {
  DelegationTranscriptChange,
  DelegationTranscriptPort,
  DelegationTranscriptTarget,
} from './transcript-port';

export interface LocalDelegationOutcome {
  readonly status: AgentDelegationTerminalStatus;
  readonly finalText?: string;
  readonly usage?: AgentDelegationUsage;
  readonly error?: AgentDelegationError;
}

export class DelegationRunnerError extends Error {
  constructor(readonly detail: AgentDelegationError) {
    super(detail.message);
  }
}

function transcriptStorageError(): DelegationRunnerError {
  return new DelegationRunnerError({
    code: 'runtime_error',
    message:
      'The delegated transcript could not be saved. Retained partial output is available.',
    retryable: false,
  });
}

function transcriptMutationKey(
  target: DelegationTranscriptTarget,
  changes: readonly DelegationTranscriptChange[],
): string {
  const targetKey = [
    target.kind,
    target.chatId,
    target.delegationId,
    target.runGeneration,
  ];
  const itemIdentities = changes.map(({ row }) => [row.id, row.itemRevision]);
  return createHash('sha256')
    .update(JSON.stringify([targetKey, itemIdentities]))
    .digest('hex');
}

export interface LocalDelegationContext {
  readonly request: AgentRunRequest;
  readonly signal: AbortSignal;
  emit(event: AgentDelegationEvent['event']): Promise<void>;
  /**
   * Register immediately when a resource is acquired. Success removes it once.
   * A callback registered without a resource is reported as `unlabelled`.
   */
  retain(
    close: () => Promise<void>,
    resource?: LocalDelegationCleanupResource,
  ): void;
  /** Native owner-specific interruption only. Never stop a shared worker. */
  setInterrupt(interrupt: () => Promise<void>): void;
  /** Bind steering to this exact native turn. */
  setSteer(
    steer: (request: AgentSteeringRequest) => Promise<ChatInputAdmission>,
  ): void;
  /**
   * Present only for a stream-backed generation with a transcript port:
   * durably admit canonical child row changes, in call order. A rejected
   * admission fails the run; content is never silently dropped.
   */
  readonly appendChildChanges?: (
    changes: readonly DelegationTranscriptChange[],
  ) => Promise<void>;
  /**
   * Present with `appendChildChanges`: a required transcript write outside
   * admission failed (for example a command-output spool). The first failure
   * wins and the run ends as a transcript storage failure, even if a stop
   * overlaps.
   */
  readonly failTranscript?: (error: unknown) => void;
}

type Cleanup = () => Promise<void>;

/** Registration order; a success is removed, a failure replaces `pending`. */
type CleanupAttempt = Map<Cleanup, LocalDelegationCleanupFailure>;

interface LocalRun {
  readonly request: AgentRunRequest;
  readonly controller: AbortController;
  readonly cleanups: Map<Cleanup, LocalDelegationCleanupTarget>;
  /** Only while a cleanup attempt runs. */
  cleanupAttempt?: CleanupAttempt;
  cleanupAttempts: number;
  readonly abort: () => void;
  readonly signal: AbortSignal;
  task: Promise<void>;
  cleanup?: Promise<void>;
  interrupt?: () => Promise<void>;
  interruption?: Promise<void>;
  steer?: (request: AgentSteeringRequest) => Promise<ChatInputAdmission>;
  stopReason?: DelegationStopReason;
  transcriptQueue: Promise<void>;
  transcriptError?: DelegationRunnerError;
}

/** Common local lifecycle; native execution and events remain adapter-owned. */
export class LocalDelegationRunner implements AgentRunnerAdapter {
  private readonly runs = new Map<string, LocalRun>();
  readonly adapterVersion = '1';
  constructor(
    readonly harnessId: string,
    readonly runtimeKind: string,
    private readonly available: (
      route: ResolvedAgentRouteSnapshot,
    ) => Promise<RunnerAvailability>,
    private readonly execute: (
      context: LocalDelegationContext,
    ) => Promise<LocalDelegationOutcome>,
    private readonly reportError: (error: unknown) => void,
    private readonly options: {
      readonly transcriptPort?: DelegationTranscriptPort;
    } = {},
  ) {}

  canRun(route: ResolvedAgentRouteSnapshot): Promise<RunnerAvailability> {
    return this.available(route);
  }

  start(
    request: AgentRunRequest,
    sink: DelegatedEventSink,
  ): Promise<NativeRunHandle> {
    const transcriptPort = this.options.transcriptPort;
    let transcriptTarget: DelegationTranscriptTarget | undefined;
    if (request.transcriptStream !== undefined) {
      const target = request.transcriptStream.target;
      if (
        transcriptPort === undefined ||
        target.kind !== 'delegation' ||
        target.chatId !== request.parent.chatId ||
        target.delegationId !== request.delegationId ||
        target.runGeneration !== request.runGeneration
      )
        return Promise.reject(
          new Error('Invalid local delegation transcript launch'),
        );
      transcriptTarget = {
        kind: 'delegation',
        chatId: target.chatId,
        delegationId: target.delegationId,
        runGeneration: target.runGeneration,
      };
    }
    if (
      this.runs.has(request.delegationId) ||
      request.signal.aborted ||
      !hasValidDelegationLineage(request.parent) ||
      request.effectivePermission !== 'read-only'
    )
      return Promise.reject(new Error('Invalid local delegation launch'));
    const controller = new AbortController();
    let sequence = 0;
    let tail: Promise<void> = Promise.resolve();
    const turn = 0;
    let currentItems: readonly AgentDelegationTranscriptItem[] = [];
    let currentSourceItems: readonly AgentDelegationTranscriptItem[] = [];
    let currentItemPayloadBytes: readonly number[] = [];
    let currentItemsPayloadBytes = 0;
    const currentItemIds = new Map<string, string>();
    let currentUsage: AgentDelegationUsage = {};
    const totalUsage = (usage: AgentDelegationUsage): AgentDelegationUsage => {
      const sum: Record<string, number> = {};
      for (const key of [
        'inputTokens',
        'outputTokens',
        'cachedInputTokens',
        'cacheCreationInputTokens',
        'costUsd',
      ] as const)
        if (usage[key] !== undefined) sum[key] = usage[key] ?? 0;
      return sum;
    };
    const boundProgressText = (text: string): string => {
      const bytes = Buffer.from(text, 'utf8');
      if (bytes.byteLength <= 65_536) return text;
      let start = bytes.byteLength - 65_536;
      while (start < bytes.byteLength && ((bytes[start] ?? 0) & 0xc0) === 0x80)
        start++;
      return bytes.subarray(start).toString('utf8');
    };
    const emit = (event: AgentDelegationEvent['event']): Promise<void> => {
      let queuedEvent = event;
      let sourceItems: readonly AgentDelegationTranscriptItem[] | undefined;
      let capturedItems: readonly AgentDelegationTranscriptItem[] | undefined;
      let legacyTranscriptEvent:
        | Extract<AgentDelegationEvent['event'], { type: 'transcript' }>
        | undefined;
      if (event.type === 'usage') {
        currentUsage = event.usage;
        queuedEvent = { ...event, usage: totalUsage(event.usage) };
      } else if (event.type === 'progress' && streamTarget !== undefined) {
        // A stream-backed preview never claims truncation: the stream keeps it all.
        queuedEvent = {
          ...event,
          text: boundProgressText(event.text),
          ...(event.truncated === undefined ? {} : { truncated: false }),
        };
      }
      if (event.type === 'transcript') {
        sourceItems = event.items.slice();
        capturedItems = event.items.map((item) => ({ ...item }));
        legacyTranscriptEvent =
          streamTarget === undefined || event.truncated === undefined
            ? { ...event, items: capturedItems }
            : { ...event, items: capturedItems, truncated: false };
        queuedEvent = legacyTranscriptEvent;
      }
      const occurredAt = Date.now();
      const delivered = tail.then(async (): Promise<void> => {
        let emittedEvent = queuedEvent;
        let nextItems: readonly AgentDelegationTranscriptItem[] | undefined;
        let nextItemPayloadBytes: readonly number[] | undefined;
        let nextItemsPayloadBytes: number | undefined;
        const newItemIds = new Map<string, string>();
        if (sourceItems !== undefined && capturedItems !== undefined) {
          const candidateItems = currentItems.slice(0, sourceItems.length);
          const candidateItemPayloadBytes = currentItemPayloadBytes.slice(
            0,
            sourceItems.length,
          );
          let payloadBytes = currentItemsPayloadBytes;
          for (
            let index = sourceItems.length;
            index < currentItemPayloadBytes.length;
            index++
          )
            payloadBytes -= currentItemPayloadBytes[index] ?? 0;
          // Recorder snapshots preserve object identity for unchanged Map values.
          // Compare those identities so only added or changed items are projected.
          for (let index = 0; index < sourceItems.length; index++) {
            const sourceItem = sourceItems[index];
            const item = capturedItems[index];
            if (!sourceItem || !item) continue;
            if (currentSourceItems[index] === sourceItem) continue;
            let id = currentItemIds.get(item.id) ?? newItemIds.get(item.id);
            if (!id) {
              id = `turn${turn}:${createHash('sha256').update(item.id).digest('hex')}`;
              newItemIds.set(item.id, id);
            }
            const projected = { ...item, id, sequence: item.sequence };
            const itemPayloadBytes = Buffer.byteLength(
              JSON.stringify(projected) ?? 'null',
            );
            payloadBytes +=
              itemPayloadBytes - (currentItemPayloadBytes[index] ?? 0);
            candidateItems[index] = projected;
            candidateItemPayloadBytes[index] = itemPayloadBytes;
          }
          const itemCount = candidateItems.length;
          const serializedBytes = 2 + payloadBytes + Math.max(0, itemCount - 1);
          if (itemCount > 65_536 || serializedBytes > 16 * 1024 * 1024) {
            if (streamTarget !== undefined) return;
            throw new Error(
              'Delegated continuation transcript exceeds retention limits',
            );
          }
          nextItems = candidateItems;
          nextItemPayloadBytes = candidateItemPayloadBytes;
          nextItemsPayloadBytes = payloadBytes;
          emittedEvent =
            legacyTranscriptEvent === undefined
              ? { type: 'transcript', items: candidateItems }
              : { ...legacyTranscriptEvent, items: candidateItems };
        }
        await sink({
          delegationId: request.delegationId,
          runGeneration: request.runGeneration,
          sequence: ++sequence,
          occurredAt,
          event: emittedEvent,
        });
        if (
          sourceItems !== undefined &&
          nextItems !== undefined &&
          nextItemPayloadBytes !== undefined &&
          nextItemsPayloadBytes !== undefined
        ) {
          currentSourceItems = sourceItems;
          currentItems = nextItems;
          currentItemPayloadBytes = nextItemPayloadBytes;
          currentItemsPayloadBytes = nextItemsPayloadBytes;
          newItemIds.forEach((projectedId, itemId) =>
            currentItemIds.set(itemId, projectedId),
          );
        }
      });
      // One caller must observe its rejected event without poisoning the
      // serialized channel for later progress and the terminal receipt.
      tail = delivered.catch(() => undefined);
      return delivered;
    };
    const abort = (): void => {
      controller.abort();
      const run = this.runs.get(request.delegationId);
      if (run?.interrupt && !run.interruption) {
        run.interruption = run.interrupt();
        void run.interruption.catch(this.reportError);
      }
    };
    const run: LocalRun = {
      request,
      controller,
      cleanups: new Map(),
      cleanupAttempts: 0,
      abort,
      signal: request.signal,
      task: Promise.resolve(),
      transcriptQueue: Promise.resolve(),
    };
    this.runs.set(request.delegationId, run);
    request.signal.addEventListener('abort', abort, { once: true });
    const streamTarget = transcriptTarget;
    const streamPort = transcriptPort;
    const appendChildChanges =
      streamTarget !== undefined && streamPort !== undefined
        ? (changes: readonly DelegationTranscriptChange[]): Promise<void> => {
            let queuedChanges: readonly DelegationTranscriptChange[] = [];
            let cloneFailed = false;
            try {
              queuedChanges = structuredClone(changes);
            } catch {
              cloneFailed = true;
            }
            const mutationKey = cloneFailed
              ? ''
              : transcriptMutationKey(streamTarget, queuedChanges);
            let storageFailure: DelegationRunnerError | undefined;
            const admission = run.transcriptQueue.then(async () => {
              if (run.transcriptError) {
                storageFailure = run.transcriptError;
                throw run.transcriptError;
              }
              if (cloneFailed) {
                storageFailure = transcriptStorageError();
                throw storageFailure;
              }
              // Not tied to the run's signal: rows written while a stopped run
              // finishes must still be retained, and the run drains them.
              let result: Awaited<ReturnType<typeof streamPort.appendChanges>>;
              try {
                result = await streamPort.appendChanges({
                  target: streamTarget,
                  mutationKey,
                  changes: queuedChanges,
                });
              } catch (error) {
                storageFailure =
                  error instanceof DelegationRunnerError
                    ? error
                    : transcriptStorageError();
                throw storageFailure;
              }
              if (!result.ok) {
                storageFailure = transcriptStorageError();
                throw storageFailure;
              }
              return result.value;
            });
            const receiptDelivery = admission.then(async (receipt) => {
              await emit({
                type: 'transcript_receipt',
                streamRevision: receipt.streamRevision,
                mutationKey: receipt.mutationKey,
                replayed: receipt.replayed,
                items: receipt.items.map(({ id, itemRevision, final }) => ({
                  id,
                  itemRevision,
                  final,
                })),
              });
            });
            run.transcriptQueue = receiptDelivery.then(
              (): void => undefined,
              (): void => {
                if (storageFailure !== undefined)
                  run.transcriptError ??= storageFailure;
              },
            );
            void receiptDelivery.catch(() => undefined);
            return receiptDelivery;
          }
        : undefined;
    const context: LocalDelegationContext = {
      request,
      signal: controller.signal,
      emit,
      retain: (close, resource) => {
        if (!run.cleanups.has(close))
          run.cleanups.set(close, cleanupTarget(resource));
      },
      setInterrupt: (interrupt) => {
        run.interrupt = interrupt;
        if (controller.signal.aborted) abort();
      },
      setSteer: (steer) => {
        run.steer = steer;
      },
      ...(appendChildChanges === undefined
        ? {}
        : {
            appendChildChanges,
            failTranscript: (error: unknown): void => {
              run.transcriptError ??=
                error instanceof DelegationRunnerError
                  ? error
                  : transcriptStorageError();
            },
          }),
    };
    const launchRun = (): void => {
      run.task = Promise.resolve()
        .then(async () => {
          let outcome: LocalDelegationOutcome;
          let executionError: unknown;
          try {
            if (streamTarget !== undefined && request.signal.aborted)
              outcome = { status: 'cancelled' };
            else outcome = await this.execute(context);
            outcome = {
              ...outcome,
              usage: totalUsage(outcome.usage ?? currentUsage),
            };
          } catch (error) {
            executionError = error;
            outcome = {
              status: 'failed',
              error:
                error instanceof DelegationRunnerError
                  ? error.detail
                  : {
                      code: 'runtime_error',
                      message:
                        'The delegated runner failed. Retained partial output is available.',
                      retryable: false,
                    },
            };
            this.reportError(error);
          }
          if (controller.signal.aborted)
            outcome = {
              ...outcome,
              status:
                run.stopReason === 'deadline_exceeded'
                  ? 'deadline_exceeded'
                  : 'cancelled',
            };
          try {
            await this.cleanup(run);
          } catch {
            // cleanup() reported this attempt.
            outcome = {
              ...outcome,
              status: 'failed',
              error: {
                code: 'launch_uncertain',
                message: 'Delegated runner cleanup could not be confirmed.',
                retryable: false,
              },
            };
          }
          if (streamTarget !== undefined) {
            await run.transcriptQueue;
            if (run.transcriptError) {
              if (executionError !== run.transcriptError)
                this.reportError(run.transcriptError);
              outcome = {
                ...outcome,
                status: 'failed',
                error: run.transcriptError.detail,
              };
            }
          }
          await emit({ type: 'terminal', ...outcome });
        })
        .catch(this.reportError);
    };

    if (streamTarget === undefined || streamPort === undefined) {
      launchRun();
      return Promise.resolve({ runId: request.delegationId });
    }

    return Promise.resolve()
      .then(() => streamPort.open({ target: streamTarget }, request.signal))
      .then((result) => {
        if (!result.ok || request.signal.aborted)
          throw new Error('Invalid local delegation transcript launch');
        launchRun();
        return { runId: request.delegationId };
      })
      .catch((error: unknown) => {
        request.signal.removeEventListener('abort', abort);
        if (this.runs.get(request.delegationId) === run)
          this.runs.delete(request.delegationId);
        if (error instanceof Error) throw error;
        throw new Error('Unable to open the delegated transcript stream');
      });
  }

  async stop(
    handle: NativeRunHandle,
    reason: DelegationStopReason,
  ): Promise<DelegationStopReceipt> {
    const run = this.runs.get(handle.runId);
    if (!run) return { stopped: true };
    run.stopReason ??= reason;
    run.abort();
    try {
      await this.bounded(run, run.task);
      await this.bounded(run, this.cleanup(run));
      return { stopped: true };
    } catch {
      return {
        stopped: false,
        error: {
          code: 'launch_uncertain',
          message: 'The delegated runner has not confirmed cancellation.',
          retryable: false,
        },
      };
    }
  }

  async steer(
    handle: NativeRunHandle,
    request: AgentSteeringRequest,
  ): Promise<ChatInputAdmission> {
    const run = this.runs.get(handle.runId);
    if (!run || run.controller.signal.aborted)
      return {
        kind: 'rejected',
        attemptId: request.attemptId,
        reason: 'The delegated turn is no longer active',
        fallback: 'ordinary',
      };
    // No handler is bound (still starting, or none): nothing was delivered,
    // so the message can wait for the run to end and start a follow-up.
    if (!run.steer)
      return {
        kind: 'rejected',
        attemptId: request.attemptId,
        reason: 'The active delegated provider does not support steering',
        fallback: 'ordinary',
      };
    return run.steer(request);
  }

  async close(handle: NativeRunHandle): Promise<void> {
    const run = this.runs.get(handle.runId);
    if (!run) return;
    await this.bounded(run, run.task);
    await this.bounded(run, this.cleanup(run));
    run.signal.removeEventListener('abort', run.abort);
    this.runs.delete(handle.runId);
  }

  private cleanup(run: LocalRun): Promise<void> {
    if (run.cleanup) return run.cleanup;
    run.cleanup = (async (): Promise<void> => {
      run.cleanupAttempts += 1;
      const entries = Array.from(run.cleanups);
      const attempt: CleanupAttempt = new Map(
        entries.map(
          ([close, target]): [Cleanup, LocalDelegationCleanupFailure] => [
            close,
            { ...target, settlement: 'pending' },
          ],
        ),
      );
      run.cleanupAttempt = attempt;
      await Promise.all(
        entries.reverse().map(async ([close, target]) => {
          let settlement: 'threw' | 'rejected' = 'threw';
          try {
            const closing = close();
            settlement = 'rejected';
            await closing;
            run.cleanups.delete(close);
            attempt.delete(close);
          } catch (error) {
            // Only the checked descriptor outlives this scope.
            attempt.set(close, {
              ...target,
              settlement,
              ...describeValue(error),
            });
          }
        }),
      );
      run.cleanupAttempt = undefined;
      if (attempt.size > 0) {
        const error = this.cleanupError(run, 'rejected', attempt);
        this.report(error);
        throw error;
      }
    })().finally(() => {
      run.cleanup = undefined;
    });
    return run.cleanup;
  }

  private bounded(run: LocalRun, operation: Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = this.cleanupError(run, 'timeout');
        reject(error);
        this.report(error);
      }, 15_000);
      void operation.then(resolve, reject).finally(() => clearTimeout(timer));
    });
  }

  /** A timeout outside an attempt lists no failures; each attempt reported its own. */
  private cleanupError(
    run: LocalRun,
    outcome: 'rejected' | 'timeout',
    attempt = run.cleanupAttempt,
  ): LocalDelegationCleanupError {
    return new LocalDelegationCleanupError(
      cleanupDiagnostic({
        harnessId: this.harnessId,
        runtimeKind: this.runtimeKind,
        delegationId: run.request.delegationId,
        runGeneration: run.request.runGeneration,
        attempt: run.cleanupAttempts,
        outcome,
        retained: run.cleanups.size,
        failures: attempt ? Array.from(attempt.values()) : [],
      }),
    );
  }

  /** Reporting can never change a settlement. */
  private report(error: unknown): void {
    try {
      this.reportError(error);
    } catch {
      // The settlement already carries the failure.
    }
  }
}
