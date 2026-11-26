import { randomUUID } from 'node:crypto';
import type { ChatCancelRequest } from '@canopy/desktop-shared/types';
import { buildChatSessionKey } from '../agents/session-key';
import { captureWaitingSecretRequests } from '../agent-secrets/waiting-secret-requests';
import { deferredToolsReloadCoordinator } from '../deferred-tools/reload-coordinator';
import { getChatTurnOwnership } from '../services/chat-turn-ownership';
import {
  cancelChatTurn,
  captureChatTurnStop,
  type ChatTurnCancelOutcome,
  type ChatTurnStopContext,
} from './chat-turn-cancel';
import { logMainProcessWarn } from './main-process-logging';
import { cancelTransientRetryForChat } from './transient-error-retry-service';
import { captureTurnEndAndDiff } from './turn-diff-capture';

const autoRoutingControllers = new Map<string, AbortController>();
function routingKey(request: ChatCancelRequest): string {
  return JSON.stringify([
    request.projectId,
    request.worktreeId,
    request.chatId,
  ]);
}

/** Register preparation so every ordinary Stop surface can abort Auto routing. */
export function beginChatAutoRouting(request: ChatCancelRequest): {
  controller: AbortController;
  dispose: () => void;
} {
  const key = routingKey(request);
  const controller = new AbortController();
  autoRoutingControllers.get(key)?.abort();
  autoRoutingControllers.set(key, controller);
  return {
    controller,
    dispose: (): void => {
      if (autoRoutingControllers.get(key) === controller)
        autoRoutingControllers.delete(key);
    },
  };
}

/**
 * Capture a Stop with the user message id of the turn it would end, in one
 * synchronous step: the Claude fence, the live turn, or a queued Codex dispatch.
 */
export function captureChatTurnStopWithTurn(request: ChatCancelRequest): {
  readonly context: ChatTurnStopContext;
  readonly userMessageId: string | undefined;
} {
  const context = captureChatTurnStop(request);
  return { context, userMessageId: context.turn?.userMessageId };
}

/**
 * The shared ordinary Stop sequence, committed before any caller broadcasts.
 * `captured` is a context the caller took without awaiting since.
 */
export async function stopChatTurn(
  request: ChatCancelRequest,
  captured?: ChatTurnStopContext,
): Promise<{
  type: 'result';
  is_error: false;
  result: 'Cancelled';
  canopy_turn_user_message_id?: string;
}> {
  const stopContext = captured ?? captureChatTurnStop(request);
  return withChatTurnStopOwner(stopContext, () =>
    runStopSequence(request, stopContext),
  );
}

export async function withChatTurnStopOwner<Result>(
  context: ChatTurnStopContext,
  run: () => Promise<Result>,
): Promise<Result> {
  const scope = context.target;
  const ownership = getChatTurnOwnership();
  const stopToken = Symbol('chat-turn-stop');
  const stopOwner = ownership.isBound()
    ? ownership.registerStopOwner(scope, {
        token: stopToken,
        userMessageId:
          context.turn?.userMessageId ?? context.fence?.userMessageId,
      })
    : undefined;
  try {
    return await run();
  } finally {
    if (stopOwner)
      ownership.removeStopOwner(scope, stopToken, stopOwner.operationEpoch);
  }
}

async function runStopSequence(
  request: ChatCancelRequest,
  stopContext: ChatTurnStopContext,
): Promise<{
  type: 'result';
  is_error: false;
  result: 'Cancelled';
  canopy_turn_user_message_id?: string;
}> {
  // Only the secret requests waiting as this Stop begins: a newer turn's
  // request, opened while the provider stops, is not this Stop's.
  const cancelWaitingSecretRequests = captureWaitingSecretRequests(request);
  autoRoutingControllers.get(routingKey(request))?.abort();
  cancelTransientRetryForChat(request, 'stop');
  deferredToolsReloadCoordinator.cancelActiveReload(
    request,
    'Deferred-tools reload was cancelled because the user stopped the chat.',
  );
  const userMessageId =
    stopContext.turn?.userMessageId ?? stopContext.fence?.userMessageId;
  // An idle native session has no turn id to fence a synthetic result. Keep
  // the IPC return/broadcast shape, but give that no-op event a unique token
  // so renderer turn matching cannot mistake it for a later send.
  const unboundNativeStopToken =
    stopContext.fence !== undefined && userMessageId === undefined
      ? randomUUID()
      : undefined;
  // A secret request the stopped turn left waiting is cancelled once the
  // provider is interrupted, even if that fails, not kept answerable: a late
  // answer would store a value no agent waits for.
  const cancellation = await cancelChatTurn(
    request,
    'stop',
    stopContext,
  ).finally((): void => {
    cancelWaitingSecretRequests();
  });
  const eventTurnUserMessageId =
    stopContext.unstartedDispatch &&
    cancellation.outcome === 'not-found' &&
    !cancellation.preparationsCancelled
      ? randomUUID()
      : (userMessageId ?? unboundNativeStopToken);
  const data = {
    type: 'result',
    is_error: false,
    result: 'Cancelled',
    ...(eventTurnUserMessageId
      ? { canopy_turn_user_message_id: eventTurnUserMessageId }
      : {}),
  } as const;
  await settleStoppedChatTurn(stopContext, cancellation);
  // Stop's abort fallback ends the turn with no provider terminal, so the
  // worktree turn's end capture never runs (turn-state phase 43e). A chat
  // with no turn baseline, such as a Cowork chat, has no diff to capture.
  if (cancellation.outcome === 'fallback-aborted' && userMessageId) {
    try {
      const { getChatStateService } =
        await import('../services/chat-state-service');
      const turnDiff = await captureTurnEndAndDiff(
        buildChatSessionKey(
          request.projectId,
          request.worktreeId,
          request.chatId,
        ),
        { userMessageId },
      );
      if (turnDiff)
        await getChatStateService().ingestProviderEvent({
          ...request,
          data: {
            type: 'turn_diff',
            userMessageId,
            ...turnDiff,
          },
          turnUserMessageId: userMessageId,
          mutationId: `stop-turn-diff:${request.chatId}:${randomUUID()}`,
        });
    } catch {
      // The diff is best-effort, as on the terminal path; Stop still settles.
    }
  }
  return data;
}

export async function settleStoppedChatTurn(
  context: ChatTurnStopContext,
  cancellation: ChatTurnCancelOutcome,
): Promise<void> {
  const { target, fence } = context;
  const turn =
    context.turn ??
    (fence?.userMessageId === undefined
      ? undefined
      : {
          userMessageId: fence.userMessageId,
          executionTurnId: fence.turnId,
        });
  const shouldSettle =
    cancellation.outcome !== 'not-found' || cancellation.preparationsCancelled;
  if (turn && !shouldSettle) return;
  if (!turn && fence) return;
  const [queue, { getChatStateService }] = await Promise.all([
    shouldSettle ? import('../services/chat-queue-service') : undefined,
    import('../services/chat-state-service'),
  ]);
  if (!(context.unstartedDispatch && cancellation.preparationsCancelled))
    queue
      ?.getChatQueueService()
      .onTurnTerminal(target, 'cancelled', turn?.userMessageId);
  if (turn) {
    const { cancellation: evidence } =
      await getChatStateService().ingestProviderEventWithResult({
        ...target,
        data: {
          type: 'result',
          is_error: false,
          result: 'Cancelled',
          canopy_turn_user_message_id: turn.userMessageId,
        },
        turnUserMessageId: turn.userMessageId,
        explicitStop: turn,
        mutationId: `manual-cancellation:${target.chatId}:${randomUUID()}`,
      });
    if (evidence) {
      void import('../app-advisor/watchers')
        .then(({ getAppAdvisorWatcherService }) =>
          getAppAdvisorWatcherService().reconcileStoppedTurn(target, evidence),
        )
        .catch((error: unknown) =>
          logMainProcessWarn(
            'Stopped chat watcher reconciliation failed.',
            error,
          ),
        );
    }
  }
  if (shouldSettle) {
    const { settleStoppedChatTurnRuns } =
      await import('../agent-runs/turn-runs');
    settleStoppedChatTurnRuns(target, turn?.userMessageId);
  }
  if (!turn)
    await getChatStateService().journalIdleStop(
      target,
      `manual-cancellation:${target.chatId}:${randomUUID()}`,
    );
}
