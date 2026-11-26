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
import type { AdmittedTurnApprovals } from './admitted-turn-approvals';
import type {
  LocalWorkerDispatchResult,
  LocalWorkerExecution,
} from '../../operations/local-worker';
import type { OperationServicePort } from '../../operations/service';

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
/** The approval a turn with a launch was admitted against. */
export interface CoreChatTurnApproval<Admitted> {
  /** The id the launch carries; the serving host reads the approval by it. */
  admissionId: string;
  /** The approval authority revision the caller resolved it at. */
  policyRevision: number;
  admitted: Admitted;
}
export interface CoreChatTurnBeginRequest<Admitted = never> {
  params: WorkerAgentTurnRunParams;
  origin: OperationOrigin;
  owner: OperationOwner;
  transcript: ChatTurnTranscriptPort;
  /** Required when params carry a launch. */
  approval?: CoreChatTurnApproval<Admitted>;
}
/** The host's approval authority: its revision, and the admitted approvals. */
export interface CoreChatTurnApprovalAuthority<Admitted> {
  /** The revision of the approval policy that governs this chat. */
  currentRevision(scope: WorkerAgentTurnScope): number;
  readonly admitted: AdmittedTurnApprovals<Admitted>;
  /**
   * What a launch whose revision has moved gets: 'refuse' (the default) fails
   * the turn; 'dispatch-without' dispatches it without the launch or an
   * admitted approval, so the worker serves it as a turn with no launch.
   */
  readonly onStaleLaunch?: 'refuse' | 'dispatch-without';
}
export const CORE_CHAT_APPROVAL_POLICY_STALE = 'core.chat.approvalPolicyStale';
export const CORE_CHAT_APPROVAL_ADMISSION_MISMATCH =
  'core.chat.approvalAdmissionMismatch';

function approvalPolicyStaleError(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'failed_precondition',
    code: CORE_CHAT_APPROVAL_POLICY_STALE,
    message: 'The approval settings changed after this chat turn was admitted.',
    retry: { kind: 'never' },
  });
}
function withoutLaunch(
  params: WorkerAgentTurnRunParams,
): WorkerAgentTurnRunParams {
  const { launch, ...rest } = params;
  void launch;
  return rest;
}
function approvalAdmissionMismatchError(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'failed_precondition',
    code: CORE_CHAT_APPROVAL_ADMISSION_MISMATCH,
    message: "This chat turn's launch does not match its admitted approval.",
    retry: { kind: 'never' },
  });
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
export class CoreChatTurnRuns<Admitted = never> {
  private readonly byKey = new Map<string, LiveTurnRun>();
  private readonly byRunId = new Map<string, LiveTurnRun>();
  private readonly byTurn = new Map<string, LiveTurnRun>();
  private readonly reserved = new Set<string>();
  private readonly waitObservers = new Set<ChatTurnWaitObserver>();

  constructor(
    private readonly options: {
      operations: OperationServicePort;
      localWorker: LocalWorkerExecution;
      /** Without it, a turn whose params carry a launch is refused. */
      approvals?: CoreChatTurnApprovalAuthority<Admitted>;
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
    request: CoreChatTurnBeginRequest<Admitted>,
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
    let approval = this.checkApproval(request);
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
    // Admission awaited: a rule saved meanwhile makes the approval stale.
    if (
      approval &&
      this.dispatchesStaleWithout() &&
      this.isStale(approval, scope)
    )
      approval = null;
    const refusal = approval ? this.admitApproval(approval, params) : null;
    if (refusal) {
      await this.finish(parentOperationId, {
        status: 'failed',
        error: refusal.payload,
      });
      throw refusal;
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
        params: approval || !params.launch ? params : withoutLaunch(params),
        idempotencyKey: params.turnRunId,
      })
      .then(
        (dispatched) => this.settleDispatched(live, dispatched),
        (error: unknown) => this.settleRefused(live, error, signal),
      )
      .then((result) => {
        signal?.removeEventListener('abort', onAbort);
        if (approval)
          this.options.approvals?.admitted.release(approval.admissionId);
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

  private dispatchesStaleWithout(): boolean {
    return this.options.approvals?.onStaleLaunch === 'dispatch-without';
  }

  private isStale(
    approval: CoreChatTurnApproval<Admitted>,
    scope: WorkerAgentTurnScope,
  ): boolean {
    const authority = this.options.approvals;
    return (
      !authority || authority.currentRevision(scope) !== approval.policyRevision
    );
  }

  /**
   * A launch must name the approval it was admitted against, at the current
   * revision. Checked before the parent operation is admitted; a stale one is
   * refused, or with 'dispatch-without' dispatched without its launch.
   */
  private checkApproval(
    request: CoreChatTurnBeginRequest<Admitted>,
  ): CoreChatTurnApproval<Admitted> | null {
    const { approval } = request;
    const launched = request.params.launch?.approval;
    if (!approval && !launched) return null;
    if (
      !approval ||
      !launched ||
      !this.options.approvals ||
      launched.admissionId !== approval.admissionId ||
      launched.policyRevision !== approval.policyRevision
    )
      throw approvalAdmissionMismatchError();
    if (this.isStale(approval, request.params.scope)) {
      if (this.dispatchesStaleWithout()) return null;
      throw approvalPolicyStaleError();
    }
    return approval;
  }

  /** Records the admission; the refusal when the revision moved or the id is taken. */
  private admitApproval(
    approval: CoreChatTurnApproval<Admitted>,
    params: WorkerAgentTurnRunParams,
  ): CanopyOperationError | null {
    const authority = this.options.approvals;
    if (!authority || this.isStale(approval, params.scope))
      return approvalPolicyStaleError();
    return authority.admitted.add(
      approval.admissionId,
      { turnRunId: params.turnRunId, scope: params.scope },
      approval.policyRevision,
      approval.admitted,
    )
      ? null
      : approvalAdmissionMismatchError();
  }

  private emit(
    live: LiveTurnRun,
    request: CoreChatTurnBeginRequest<Admitted>,
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
    terminal: Parameters<OperationServicePort['finish']>[1],
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
