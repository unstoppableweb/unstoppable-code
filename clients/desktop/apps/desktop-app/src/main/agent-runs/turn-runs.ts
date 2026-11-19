import { randomUUID } from 'node:crypto';
import {
  WORKER_AGENT_TURN_FAILED_CODE,
  WORKER_AGENT_TURN_FAILED_MESSAGE,
  WORKER_AGENT_TURN_PAYLOAD_FORMAT,
  type OperationOrigin,
  type WorkerAgentTurnEvent,
  type WorkerAgentTurnOutcome,
  type WorkerAgentTurnRunResult,
  type WorkerAgentTurnWaitKind,
  type WorkerAgentTurnWaitResolution,
} from '@canopy/protocol/canopy-core';
import type { TurnEventSink } from '@canopy/core-runtime/node/agent/turns';
import { CanopyOperationError } from '@canopy/core-runtime';
import type { UsageInitiationSource } from '@canopy/desktop-shared/types';
import { getActiveDesktopRuntimeIfAccepting } from '../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import { stopChatTurnExactly } from '../canopy-runtime/chat-turn-stop';
import {
  getChatTurnAuditStatus,
  isRootTerminalChatEventData,
  readCodexRootThreadId,
  readCodexRootTurnId,
} from '../lib/chat-turn-audit';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { isRecord } from '../lib/type-guards';
import { StagedAgentRun, discardStagedAgentRun } from './staged-agent-run';
import { stageTurn } from './turn-worker-host';

export class TurnWorkerUnavailableError extends Error {
  declare readonly cause?: unknown;

  constructor(options?: { cause?: unknown }) {
    super('The chat turn could not start on the local worker.');
    this.name = 'TurnWorkerUnavailableError';
    if (options && 'cause' in options) this.cause = options.cause;
  }
}

export interface BeginChatTurnRunRequest {
  scope: { workspaceId: string; worktreeId: string; chatId: string };
  /** The turn's user message id. */
  turnId: string;
  /** `providerEventSequenceNamespace ?? 'initial'`. */
  eventNamespace: string;
  providerId: string;
  model: string | null;
  initiationSource: UsageInitiationSource | undefined;
  /**
   * 'host' (default): the caller settles the run. 'root-terminal': the run
   * settles itself after a frame it classified as the root terminal has been
   * committed, with chatTurnOutcomeOf(frame); a newer root-terminal run of the
   * same chat settles any older one: completed when it continues the same
   * turn, else cancelled.
   */
  settleOn?: 'host' | 'root-terminal';
  /**
   * The session options' `sdkSessionId`, as the event router seeds it: a
   * reused Codex thread emits no init, and without its root thread a child
   * thread's terminal would read as the root terminal.
   */
  codexRootThreadId?: string;
}

/**
 * A deferred-tools continuation's namespace, one per reload: the run it
 * continues stays live (the router suppressed its root terminal) until the
 * continuation begins, so a shared namespace would collide with it.
 */
export function deferredReloadEventNamespace(reloadRequestId: string): string {
  return `deferred-reload:${reloadRequestId}`;
}

export type ChatTurnEventHandler = (
  data: unknown,
  markPersistenceSettled?: () => void,
) => void | Promise<void>;

export interface ChatTurnRunHandle {
  readonly turnRunId: string;
  /** Aborted when the run is cancelled; checked before the provider send. */
  readonly signal: AbortSignal;
  execute<T>(fn: () => T | Promise<T>): Promise<T>;
  executeSync<T>(fn: () => T): T;
  /** Wrap the dispatch's provider event handler; call once per run. */
  observe(
    handler: ChatTurnEventHandler,
  ): (data: unknown, markPersistenceSettled?: () => void) => Promise<void>;
  /** The provider accepted the prompt. Idempotent. */
  accepted(): void;
  /** The host settled the turn. First call wins. */
  settle(outcome: WorkerAgentTurnOutcome): void;
  /** The dispatch ended without settling: failed when `error` is given, else cancelled. No-op once accepted or settled. */
  abandon(error?: unknown): void;
}

/** getChatTurnAuditStatus mapped to the run outcome (D9). */
export function chatTurnOutcomeOf(
  eventData: Record<string, unknown>,
): WorkerAgentTurnOutcome {
  const status = getChatTurnAuditStatus(eventData);
  return status === 'success'
    ? 'completed'
    : status === 'failure'
      ? 'failed'
      : 'cancelled';
}

function turnOrigin(
  source: UsageInitiationSource | undefined,
): OperationOrigin {
  return source === 'user' || source === 'portal'
    ? { kind: 'client', sourceId: 'local-desktop-user' }
    : { kind: 'system', sourceId: `chat-turn:${source ?? 'unknown'}` };
}

/** Live host runs by chat and turn, so an ordinary Stop can settle them. */
const liveHostRuns = new Map<string, Set<() => void>>();

function hostRunKey(
  scope: { projectId: string; worktreeId: string; chatId: string },
  turnId: string,
): string {
  return [scope.projectId, scope.worktreeId, scope.chatId, turnId].join(
    '\u0000',
  );
}

/**
 * An ordinary Stop settled this turn in chat state without a provider
 * terminal (a provider can stop silently): settle its live runs cancelled.
 * Without a user message id (no provider stop fence), Stop ended the chat's
 * current turn, so every live run of the chat settles.
 */
export function settleStoppedChatTurnRuns(
  scope: { projectId: string; worktreeId: string; chatId: string },
  userMessageId: string | undefined,
): void {
  const chatPrefix = hostRunKey(scope, '');
  const keys =
    userMessageId === undefined
      ? Array.from(liveHostRuns.keys()).filter((key) =>
          key.startsWith(chatPrefix),
        )
      : [hostRunKey(scope, userMessageId)];
  for (const key of keys)
    for (const cancel of Array.from(liveHostRuns.get(key) ?? [])) cancel();
}

/** Live root-terminal runs by chat, so a newer turn supersedes an older one. */
const liveRootTerminalRuns = new Map<
  string,
  { run: ChatTurnRunHandle; turnId: string }
>();

export type ChatTurnWaitEvent =
  | { kind: 'wait_opened'; waitId: string; waitKind: WorkerAgentTurnWaitKind }
  | {
      kind: 'wait_resolved';
      waitId: string;
      resolution: WorkerAgentTurnWaitResolution;
    };

/** The live run's wait emitter per chat; a newer run of the chat replaces it. */
const liveTurnWaitEmitters = new Map<
  string,
  (event: ChatTurnWaitEvent) => boolean
>();

function turnWaitKey(scope: {
  workspaceId: string;
  worktreeId: string;
  chatId: string;
}): string {
  return [scope.workspaceId, scope.worktreeId, scope.chatId].join('\u0000');
}

/**
 * Emit a wait envelope on the chat's live turn run (CAN-4128). Returns false
 * when the chat has no live run, or the worker has not taken it yet; the
 * request still waits.
 */
export function emitChatTurnWait(
  scope: { workspaceId: string; worktreeId: string; chatId: string },
  event: ChatTurnWaitEvent,
): boolean {
  return liveTurnWaitEmitters.get(turnWaitKey(scope))?.(event) ?? false;
}

function isTurnRunActive(error: unknown): boolean {
  return (
    error instanceof CanopyOperationError &&
    error.payload.code === 'core.chat.turnRunActive'
  );
}

/**
 * One chat turn as a `core.chat.turn.run` on the in-process worker
 * (CAN-4115). The run is recorded before this resolves; the host then runs
 * session acquisition and the provider send through `execute` and
 * `executeSync`, routes provider events through `observe`, and settles the
 * run exactly once.
 */
export async function beginChatTurnRun(
  request: BeginChatTurnRunRequest,
): Promise<ChatTurnRunHandle> {
  const runtime = getActiveDesktopRuntimeIfAccepting();
  if (!runtime) throw new TurnWorkerUnavailableError();
  const { scope, turnId } = request;
  const turnRunId = randomUUID();
  const staged = new StagedAgentRun({ kind: 'turn', runId: turnRunId });
  const controller = new AbortController();
  let resolveSettlement: (result: WorkerAgentTurnRunResult) => void = () =>
    undefined;
  const settlement = new Promise<WorkerAgentTurnRunResult>((resolve) => {
    resolveSettlement = resolve;
  });
  let eventSequence = 0;
  let codexRootThreadId = request.codexRootThreadId;
  let codexRootTurnId: string | undefined;
  let handlerRef: ChatTurnEventHandler | undefined;
  let sinkRef: TurnEventSink | undefined;
  let acceptedOnce = false;
  let settled = false;
  const waitKey = turnWaitKey(scope);
  // Set once begin succeeds; settling can run before that.
  const waitEmitter: { current?: (event: ChatTurnWaitEvent) => boolean } = {};

  const emit = (event: WorkerAgentTurnEvent, context: string): void => {
    sinkRef?.(event).catch((error: unknown) => {
      logMainProcessWarn(`[turn-runs] The ${context} envelope failed`, {
        turnRunId,
        error,
      });
    });
  };
  const runKey = hostRunKey(
    {
      projectId: scope.workspaceId,
      worktreeId: scope.worktreeId,
      chatId: scope.chatId,
    },
    turnId,
  );
  const cancelForStop = (): void => settleOnce('cancelled');
  const chatKey = [scope.workspaceId, scope.worktreeId, scope.chatId].join(
    '\u0000',
  );
  const settleOnce = (outcome: WorkerAgentTurnOutcome): void => {
    if (settled) return;
    settled = true;
    if (liveRootTerminalRuns.get(chatKey)?.run.turnRunId === turnRunId)
      liveRootTerminalRuns.delete(chatKey);
    if (
      waitEmitter.current &&
      liveTurnWaitEmitters.get(waitKey) === waitEmitter.current
    )
      liveTurnWaitEmitters.delete(waitKey);
    const live = liveHostRuns.get(runKey);
    live?.delete(cancelForStop);
    if (live?.size === 0) liveHostRuns.delete(runKey);
    if (sinkRef)
      emit(
        {
          kind: 'terminal',
          turnRunId,
          sequence: eventSequence++,
          outcome,
        },
        'terminal',
      );
    const base = { turnRunId, eventCount: eventSequence };
    resolveSettlement(
      outcome === 'failed'
        ? {
            ...base,
            status: 'failed',
            error: {
              code: WORKER_AGENT_TURN_FAILED_CODE,
              message: WORKER_AGENT_TURN_FAILED_MESSAGE,
            },
          }
        : { ...base, status: outcome },
    );
  };
  const stop = async (): Promise<void> => {
    controller.abort();
    try {
      await stopChatTurnExactly(
        {
          projectId: scope.workspaceId,
          worktreeId: scope.worktreeId,
          chatId: scope.chatId,
        },
        turnId,
      );
    } finally {
      settleOnce('cancelled');
    }
  };
  stageTurn(turnRunId, {
    run: staged,
    attach: (sink) => {
      sinkRef = sink;
    },
    settlement,
    stop,
  });

  let run: Awaited<ReturnType<typeof runtime.chatTurnRuns.begin>>;
  try {
    run = await runtime.chatTurnRuns.begin(
      {
        params: {
          turnRunId,
          scope,
          turnId,
          eventNamespace: request.eventNamespace,
          providerId: request.providerId.slice(0, 64),
          model: request.model?.slice(0, 256) || null,
          materializationId: null,
        },
        origin: turnOrigin(request.initiationSource),
        owner: { kind: 'system', id: LOCAL_DESKTOP_AUTHORITY_ID },
        transcript: async (event, local) => {
          await handlerRef?.(event.payload, local.markPersistenceSettled);
        },
      },
      { cancelledBy: 'local-desktop-user' },
    );
  } catch (cause) {
    discardStagedAgentRun(turnRunId);
    if (isTurnRunActive(cause)) throw cause;
    throw new TurnWorkerUnavailableError({ cause });
  }
  const emitter = (event: ChatTurnWaitEvent): boolean => {
    const sink = sinkRef;
    if (!sink || settled) return false;
    void sink({ ...event, turnRunId, sequence: eventSequence++ }).catch(
      (error: unknown) =>
        logMainProcessWarn('[turn-runs] A wait envelope was refused', {
          turnRunId,
          error,
        }),
    );
    return true;
  };
  waitEmitter.current = emitter;
  if (!settled) liveTurnWaitEmitters.set(waitKey, emitter);
  const live = liveHostRuns.get(runKey) ?? new Set<() => void>();
  live.add(cancelForStop);
  liveHostRuns.set(runKey, live);
  // A parent that finished without the host (dispatch refused, worker
  // unavailable) closes the staged run, so a waiting execute rejects.
  void run.settled.then((result) => {
    if (!settled) settleOnce(result.status);
    if (!staged.closed)
      staged.close(
        result.status === 'failed'
          ? new TurnWorkerUnavailableError({ cause: result.error })
          : new TurnWorkerUnavailableError(),
      );
    discardStagedAgentRun(turnRunId);
  });

  let observed = false;
  const handle: ChatTurnRunHandle = {
    turnRunId,
    signal: controller.signal,
    execute: <T>(fn: () => T | Promise<T>): Promise<T> => staged.execute(fn),
    // Cancellation aborts the signal before its exact-turn Stop settles the
    // run: a cancelled run never sends.
    executeSync: <T>(fn: () => T): T => {
      controller.signal.throwIfAborted();
      return staged.executeSync(fn);
    },
    observe: (handler) => {
      if (observed)
        throw new Error('A chat turn run observes one event handler.');
      observed = true;
      handlerRef = handler;
      return async (data, mark): Promise<void> => {
        // The router's classification: a new root thread resets its turn.
        const nextRootThreadId = readCodexRootThreadId(data);
        if (nextRootThreadId && nextRootThreadId !== codexRootThreadId) {
          codexRootThreadId = nextRootThreadId;
          codexRootTurnId = undefined;
        }
        codexRootTurnId =
          readCodexRootTurnId(data, codexRootThreadId) ?? codexRootTurnId;
        const terminal =
          isRecord(data) &&
          isRootTerminalChatEventData(data, codexRootThreadId, codexRootTurnId);
        const sink = sinkRef;
        if (!sink) {
          logMainProcessWarn(
            '[turn-runs] A provider event arrived before the worker took the run',
            { turnRunId },
          );
          await handler(data, mark);
        } else
          await sink(
            {
              kind: 'transcript',
              turnRunId,
              sequence: eventSequence++,
              format: WORKER_AGENT_TURN_PAYLOAD_FORMAT,
              terminal,
              payload: data,
            },
            mark ? { markPersistenceSettled: mark } : {},
          );
        if (terminal && request.settleOn === 'root-terminal' && isRecord(data))
          settleOnce(chatTurnOutcomeOf(data));
      };
    },
    accepted: (): void => {
      if (acceptedOnce) return;
      acceptedOnce = true;
      if (sinkRef)
        emit(
          { kind: 'accepted', turnRunId, sequence: eventSequence++ },
          'accepted',
        );
    },
    settle: settleOnce,
    abandon: (error): void => {
      if (acceptedOnce || settled) return;
      settleOnce(
        error === undefined || controller.signal.aborted
          ? 'cancelled'
          : 'failed',
      );
    },
  };
  if (request.settleOn === 'root-terminal') {
    const older = liveRootTerminalRuns.get(chatKey);
    older?.run.settle(older.turnId === turnId ? 'completed' : 'cancelled');
    liveRootTerminalRuns.set(chatKey, { run: handle, turnId });
  }
  return handle;
}
