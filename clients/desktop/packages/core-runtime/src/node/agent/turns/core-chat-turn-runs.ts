import {
  CanopyErrorPayloadSchema,
  WORKER_AGENT_TURN_FAILED_CODE,
  WORKER_AGENT_TURN_FAILED_MESSAGE,
  WorkerAgentTurnRunResultSchema,
  type CanopyErrorPayload,
  type OperationFailure,
  type OperationOrigin,
  type OperationOwner,
  type WorkerAgentTurnEvent,
  type WorkerAgentTurnOutcome,
  type WorkerAgentTurnRunParams,
  type WorkerAgentTurnScope,
  type WorkerAgentTurnWaitKind,
  type WorkerAgentTurnWaitResolution,
} from '@canopy/protocol/canopy-core';

import { CanopyOperationError } from '../../../runtime/errors';
import type {
  LocalWorkerDispatchResult,
  LocalWorkerExecution,
} from '../../operations/local-worker';
import type { OperationService } from '../../operations/service';

export const CORE_CHAT_TURN_RUN_KIND = 'core.chat.turn.run';
export const WORKER_AGENT_TURN_RUN = 'worker.agent.turn.run';

export interface TurnEventLocal {
  /** In-process only: the router's persistence acknowledgement for this frame. */
  readonly markPersistenceSettled?: () => void;
}
export type TurnEventSink = (
  event: WorkerAgentTurnEvent,
  local?: TurnEventLocal,
) => Promise<void>;
export type ChatTurnTranscriptPort = (
  event: Extract<WorkerAgentTurnEvent, { kind: 'transcript' }>,
  local: TurnEventLocal,
) => Promise<void>;

export interface ChatTurnRunRef {
  readonly turnRunId: string;
  readonly operationId: string;
  readonly scope: WorkerAgentTurnScope;
  readonly turnId: string;
  readonly eventNamespace: string;
}
export interface ChatTurnWaitObserver {
  opened(
    run: ChatTurnRunRef,
    wait: { waitId: string; waitKind: WorkerAgentTurnWaitKind },
  ): void;
  resolved(
    run: ChatTurnRunRef,
    wait: { waitId: string; resolution: WorkerAgentTurnWaitResolution },
  ): void;
}
export interface CoreChatTurnBeginRequest {
  params: WorkerAgentTurnRunParams;
  origin: OperationOrigin;
  owner: OperationOwner;
  transcript: ChatTurnTranscriptPort;
}
export type CoreChatTurnRunResult =
  | { status: 'completed'; ref: ChatTurnRunRef; eventCount: number }
  | {
      status: 'failed';
      ref: ChatTurnRunRef;
      error: CanopyErrorPayload;
      eventCount: number | null;
    }
  | { status: 'cancelled'; ref: ChatTurnRunRef; eventCount: number | null };
export interface CoreChatTurnRun {
  readonly ref: ChatTurnRunRef;
  /** Resolves once the parent operation is finished. Never rejects. */
  readonly settled: Promise<CoreChatTurnRunResult>;
}

export class TurnEventOutOfOrderError extends Error {
  constructor() {
    super('A chat turn event arrived out of order.');
    this.name = 'TurnEventOutOfOrderError';
  }
}

const TURN_FAILED: CanopyErrorPayload = {
  kind: 'internal',
  code: WORKER_AGENT_TURN_FAILED_CODE,
  message: WORKER_AGENT_TURN_FAILED_MESSAGE,
  retry: { kind: 'never' },
};
const OUTCOME_UNKNOWN: CanopyErrorPayload = {
  kind: 'unavailable',
  code: 'core.delegation.outcomeUnknown',
  message: 'The local worker did not report how this chat turn ended.',
  retry: { kind: 'never' },
};
const NOT_DISPATCHED: CanopyErrorPayload = {
  kind: 'internal',
  message: 'This chat turn could not be dispatched.',
  retry: { kind: 'never' },
};

function isPlaneQualifiedCode(
  code: string,
): code is `core.${string}.${string}` | `worker.${string}.${string}` {
  return /^(core|worker)\.[^.]+\..+$/.test(code);
}

function toErrorPayload(failure: OperationFailure): CanopyErrorPayload {
  const { code, ...rest } = failure;
  return code !== undefined && isPlaneQualifiedCode(code)
    ? { ...rest, code }
    : rest;
}

interface LiveTurnRun {
  readonly key: string;
  readonly turnKey: string;
  readonly ref: ChatTurnRunRef;
  readonly sink: TurnEventSink;
  nextSequence: number;
  terminalOutcome: WorkerAgentTurnOutcome | null;
  readonly openWaits: Set<string>;
  settled: boolean;
}

/**
 * Chat turns as core operations (CAN-4115). Each run is one
 * `core.chat.turn.run` whose `worker.agent.turn.run` child is dispatched
 * through `LocalWorkerExecution`. The worker reports the turn as a closed
 * provider-neutral envelope stream: the core checks its order, forwards each
 * transcript frame unparsed to the chat's transcript writer, tracks waits and
 * settles the run from the terminal envelope, never from a frame's payload.
 */
export class CoreChatTurnRuns {
  private readonly byKey = new Map<string, LiveTurnRun>();
  private readonly byRunId = new Map<string, LiveTurnRun>();
  private readonly byTurn = new Map<string, LiveTurnRun>();
  private readonly reserved = new Set<string>();
  private readonly waitObservers = new Set<ChatTurnWaitObserver>();

  constructor(
    private readonly options: {
      operations: OperationService;
      localWorker: LocalWorkerExecution;
      onError?: (error: unknown, context: string) => void;
    },
  ) {
    options.operations.registerDomain({
      domain: 'core.chat.turn',
      kinds: [CORE_CHAT_TURN_RUN_KIND],
      restartClass: 'lost',
      cancel: () => Promise.resolve('requested'),
    });
  }

  async begin(
    request: CoreChatTurnBeginRequest,
    runOptions: { signal?: AbortSignal; cancelledBy?: string } = {},
  ): Promise<CoreChatTurnRun> {
    const { operations } = this.options;
    const { params } = request;
    const { scope } = params;
    const turnKey = [
      scope.workspaceId,
      scope.worktreeId,
      scope.chatId,
      params.turnId,
    ].join('\u0000');
    const key = `${turnKey}\u0000${params.eventNamespace}`;
    if (this.byKey.has(key) || this.reserved.has(key))
      throw new CanopyOperationError({
        kind: 'failed_precondition',
        code: 'core.chat.turnRunActive',
        message: 'This chat turn is already running.',
        retry: { kind: 'never' },
      });
    this.reserved.add(key);
    let parentOperationId: string;
    try {
      const { operation } = await operations.admit({
        kind: CORE_CHAT_TURN_RUN_KIND,
        status: 'running',
        origin: request.origin,
        owner: request.owner,
        scope: {
          workspaceId: scope.workspaceId,
          worktreeId: scope.worktreeId,
          chatId: scope.chatId,
        },
      });
      parentOperationId = operation.operationId;
    } finally {
      this.reserved.delete(key);
    }
    const ref: ChatTurnRunRef = {
      turnRunId: params.turnRunId,
      operationId: parentOperationId,
      scope,
      turnId: params.turnId,
      eventNamespace: params.eventNamespace,
    };
    const live: LiveTurnRun = {
      key,
      turnKey,
      ref,
      sink: (event, local) => this.emit(live, request, event, local),
      nextSequence: 0,
      terminalOutcome: null,
      openWaits: new Set(),
      settled: false,
    };
    this.byKey.set(key, live);
    this.byRunId.set(params.turnRunId, live);
    this.byTurn.set(turnKey, live);

    const onAbort = (): void => {
      void operations
        .cancel(parentOperationId, {
          reason: 'The caller stopped this chat turn.',
          requestedBy: runOptions.cancelledBy ?? 'core',
        })
        .catch(() => undefined);
    };
    const { signal } = runOptions;
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    const settled = this.options.localWorker
      .dispatch({
        parentOperationId,
        operation: WORKER_AGENT_TURN_RUN,
        params,
        idempotencyKey: params.turnRunId,
      })
      .then(
        (dispatched) => this.settleDispatched(live, dispatched),
        (error: unknown) => this.settleRefused(live, error, signal),
      )
      .then((result) => {
        signal?.removeEventListener('abort', onAbort);
        this.release(live);
        return result;
      });
    void settled.then(() => {
      if (this.byRunId.get(params.turnRunId) === live)
        this.byRunId.delete(params.turnRunId);
    });
    return { ref, settled };
  }

  /** The worker side's sink for a live run; null when the run is unknown or settled. */
  sinkFor(turnRunId: string): TurnEventSink | null {
    return this.byRunId.get(turnRunId)?.sink ?? null;
  }

  /** The most recently begun live run of a chat turn, any namespace. */
  findLive(scope: WorkerAgentTurnScope, turnId: string): ChatTurnRunRef | null {
    const turnKey = [
      scope.workspaceId,
      scope.worktreeId,
      scope.chatId,
      turnId,
    ].join('\u0000');
    return this.byTurn.get(turnKey)?.ref ?? null;
  }

  observeWaits(observer: ChatTurnWaitObserver): () => void {
    this.waitObservers.add(observer);
    return (): void => {
      this.waitObservers.delete(observer);
    };
  }

  private emit(
    live: LiveTurnRun,
    request: CoreChatTurnBeginRequest,
    event: WorkerAgentTurnEvent,
    local: TurnEventLocal | undefined,
  ): Promise<void> {
    // Checked before any await: callbacks run in call order, so the core
    // sees every event once and in order.
    if (
      event.turnRunId !== live.ref.turnRunId ||
      event.sequence !== live.nextSequence
    )
      return Promise.reject(new TurnEventOutOfOrderError());
    live.nextSequence += 1;
    switch (event.kind) {
      case 'transcript':
        // Late frames still reach the transcript writer after settlement.
        return request.transcript(event, local ?? {});
      case 'wait_opened':
        if (!live.settled && !live.openWaits.has(event.waitId)) {
          live.openWaits.add(event.waitId);
          this.notifyWaits((observer) =>
            observer.opened(live.ref, {
              waitId: event.waitId,
              waitKind: event.waitKind,
            }),
          );
        }
        return Promise.resolve();
      case 'wait_resolved':
        if (!live.settled && live.openWaits.delete(event.waitId))
          this.notifyWaits((observer) =>
            observer.resolved(live.ref, {
              waitId: event.waitId,
              resolution: event.resolution,
            }),
          );
        return Promise.resolve();
      case 'terminal':
        if (!live.settled && live.terminalOutcome === null)
          live.terminalOutcome = event.outcome;
        return Promise.resolve();
      case 'accepted':
        return Promise.resolve();
    }
  }

  private notifyWaits(call: (observer: ChatTurnWaitObserver) => void): void {
    for (const observer of this.waitObservers) {
      try {
        call(observer);
      } catch (error) {
        this.options.onError?.(error, 'turn wait observer');
      }
    }
  }

  private async settleDispatched(
    live: LiveTurnRun,
    dispatched: LocalWorkerDispatchResult,
  ): Promise<CoreChatTurnRunResult> {
    const parsed = WorkerAgentTurnRunResultSchema.safeParse(dispatched.result);
    const result = parsed.success ? parsed.data : null;
    const status =
      live.terminalOutcome ??
      result?.status ??
      (dispatched.operation.status === 'cancelled' ? 'cancelled' : 'failed');
    const eventCount = result?.eventCount ?? null;
    const { ref } = live;
    if (status === 'completed') {
      await this.finish(ref.operationId, {
        status: 'completed',
        ...(result ? { outcome: result } : {}),
      });
      return {
        status: 'completed',
        ref,
        eventCount: eventCount ?? live.nextSequence,
      };
    }
    if (status === 'cancelled') {
      await this.finish(ref.operationId, { status: 'cancelled' });
      return { status: 'cancelled', ref, eventCount };
    }
    const error =
      live.terminalOutcome === 'failed' || result?.status === 'failed'
        ? TURN_FAILED
        : dispatched.operation.error
          ? toErrorPayload(dispatched.operation.error)
          : OUTCOME_UNKNOWN;
    await this.finish(ref.operationId, { status: 'failed', error });
    return { status: 'failed', ref, error, eventCount };
  }

  private async settleRefused(
    live: LiveTurnRun,
    error: unknown,
    signal: AbortSignal | undefined,
  ): Promise<CoreChatTurnRunResult> {
    this.options.onError?.(error, 'chat turn dispatch');
    const { ref } = live;
    const current = await this.options.operations
      .get(ref.operationId)
      .catch(() => null);
    if (signal?.aborted || current?.cancellation) {
      await this.finish(ref.operationId, { status: 'cancelled' });
      return { status: 'cancelled', ref, eventCount: null };
    }
    let failure = NOT_DISPATCHED;
    try {
      if (error instanceof CanopyOperationError) {
        const parsed = CanopyErrorPayloadSchema.safeParse(error.payload);
        if (parsed.success) {
          failure = {
            kind: parsed.data.kind,
            ...(parsed.data.code === undefined
              ? {}
              : { code: parsed.data.code }),
            message: NOT_DISPATCHED.message,
            retry: { kind: 'never' },
          };
        }
      }
    } catch {
      // Malformed typed-looking refusals still settle with the fixed payload.
    }
    await this.finish(ref.operationId, { status: 'failed', error: failure });
    return { status: 'failed', ref, error: failure, eventCount: null };
  }

  private async finish(
    operationId: string,
    terminal: Parameters<OperationService['finish']>[1],
  ): Promise<void> {
    try {
      await this.options.operations.finish(operationId, terminal);
    } catch (error) {
      this.options.onError?.(error, 'chat turn finish');
    }
  }

  private release(live: LiveTurnRun): void {
    for (const waitId of live.openWaits)
      this.notifyWaits((observer) =>
        observer.resolved(live.ref, { waitId, resolution: 'cancelled' }),
      );
    live.openWaits.clear();
    live.settled = true;
    if (this.byKey.get(live.key) === live) this.byKey.delete(live.key);
    if (this.byTurn.get(live.turnKey) !== live) return;
    // Another namespace of this turn may still be live: map the most
    // recently begun one.
    let newest: LiveTurnRun | undefined;
    for (const other of this.byKey.values())
      if (other.turnKey === live.turnKey) newest = other;
    if (newest) this.byTurn.set(live.turnKey, newest);
    else this.byTurn.delete(live.turnKey);
  }
}
