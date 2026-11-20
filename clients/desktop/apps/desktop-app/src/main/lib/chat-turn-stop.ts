import { randomUUID } from 'node:crypto';
import type { ChatCancelRequest } from '@canopy/desktop-shared/types';
import { buildChatSessionKey } from '../agents/session-key';
import { captureWaitingSecretRequests } from '../agent-secrets/waiting-secret-requests';
import { deferredToolsReloadCoordinator } from '../deferred-tools/reload-coordinator';
import { getChatTurnOwnership } from '../services/chat-turn-ownership';
import {
  cancelChatTurn,
  captureChatTurnStop,
  type ChatTurnStopContext,
} from './chat-turn-cancel';
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
 * synchronous step: the Claude fence's turn, else the chat's live turn.
 */
export function captureChatTurnStopWithTurn(request: ChatCancelRequest): {
  readonly context: ChatTurnStopContext;
  readonly userMessageId: string | undefined;
} {
  const context = captureChatTurnStop(request);
  const { fence } = context;
  const ownership = getChatTurnOwnership();
  const snapshot = ownership.isBound()
    ? ownership.getSnapshot({
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        chatId: request.chatId,
      })
    : undefined;
  if (fence?.userMessageId === undefined) {
    const live =
      snapshot?.receipt?.state.current ?? snapshot?.committed?.state.current;
    return { context, userMessageId: live?.userMessageId };
  }
  const bound = boundUserMessageId(request, fence);
  if (bound !== undefined || fence.turnId !== fence.userMessageId)
    return { context, userMessageId: bound ?? fence.userMessageId };
  // Claude started this turn before its prompt bound: it runs the message
  // its dispatch owner was taken for, which Stop settles too.
  const owners = (snapshot?.dispatchOwners ?? []).filter(
    (owner) => owner.userMessageId !== undefined,
  );
  const dispatched =
    owners.find((owner) => owner.turnId === fence.turnId) ??
    (owners.length === 1 && owners[0]?.turnId === undefined
      ? owners[0]
      : undefined);
  return {
    context,
    userMessageId: dispatched?.userMessageId ?? fence.userMessageId,
  };
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
  // S blocks admission and holds wake from capture until this Stop's release
  // and settle are durable, so no newer dispatch can start mid-Stop.
  const scope = {
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    chatId: request.chatId,
  };
  const ownership = getChatTurnOwnership();
  const stopToken = Symbol('chat-turn-stop');
  const stopOwner = ownership.isBound()
    ? ownership.registerStopOwner(scope, {
        token: stopToken,
        ...(stopContext.fence?.userMessageId
          ? { userMessageId: stopContext.fence.userMessageId }
          : {}),
      })
    : undefined;
  try {
    return await runStopSequence(request, stopContext);
  } finally {
    if (stopOwner)
      ownership.removeStopOwner(scope, stopToken, stopOwner.operationEpoch);
  }
}

/**
 * Claude can start a turn before its prompt's evidence binds it, and a fence
 * captured then names the turn by its own id. Canonical state learns the user
 * message later; the queue's gate and dispatch owner were taken under that
 * message, so Stop settles it. A wake that no message bound keeps its id.
 */
function boundUserMessageId(
  scope: ChatCancelRequest,
  fence: ChatTurnStopContext['fence'],
): string | undefined {
  if (fence?.turnId === undefined || fence.userMessageId !== fence.turnId)
    return undefined;
  const ownership = getChatTurnOwnership();
  if (!ownership.isBound()) return undefined;
  const snapshot = ownership.getSnapshot({
    projectId: scope.projectId,
    worktreeId: scope.worktreeId,
    chatId: scope.chatId,
  });
  for (const view of [snapshot.receipt, snapshot.committed]) {
    for (const turn of [view?.state.current, view?.state.lastEnded]) {
      if (turn?.id === fence.turnId && turn.userMessageId !== undefined)
        return turn.userMessageId;
    }
  }
  return undefined;
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
  const userMessageId = stopContext.fence?.userMessageId;
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
  const { outcome } = await cancelChatTurn(
    request,
    'stop',
    stopContext,
  ).finally((): void => {
    cancelWaitingSecretRequests();
  });
  // Lazy local imports break the queue/state/cancellation initialization cycle.
  const [{ getChatQueueService }, { getChatStateService }] = await Promise.all([
    import('../services/chat-queue-service'),
    import('../services/chat-state-service'),
  ]);
  // Providers may stop silently. Release the gate and durably settle the turn;
  // duplicate provider terminal events remain idempotent.
  const settledUserMessageId =
    boundUserMessageId(request, stopContext.fence) ?? userMessageId;
  const eventTurnUserMessageId = settledUserMessageId ?? unboundNativeStopToken;
  const data = {
    type: 'result',
    is_error: false,
    result: 'Cancelled',
    ...(eventTurnUserMessageId
      ? { canopy_turn_user_message_id: eventTurnUserMessageId }
      : {}),
  } as const;
  // There is no captured turn to release or persist. In particular, never
  // send an untagged terminal into a native session after its epoch changed.
  // cancelChatTurn released the queue's hold on any send it cancelled.
  if (stopContext.fence !== undefined && userMessageId === undefined) {
    return data;
  }
  getChatQueueService().onTurnTerminal(
    request,
    'cancelled',
    settledUserMessageId,
  );
  await getChatStateService().ingestProviderEvent({
    ...request,
    data,
    ...(settledUserMessageId
      ? { turnUserMessageId: settledUserMessageId }
      : {}),
    mutationId: `manual-cancellation:${request.chatId}:${randomUUID()}`,
  });
  const { settleStoppedChatTurnRuns } = await import('../agent-runs/turn-runs');
  settleStoppedChatTurnRuns(request, settledUserMessageId);
  // Stop's abort fallback ends the turn with no provider terminal, so the
  // worktree turn's end capture never runs (turn-state phase 43e). A chat
  // with no turn baseline, such as a Cowork chat, has no diff to capture.
  if (outcome === 'fallback-aborted' && settledUserMessageId) {
    try {
      const turnDiff = await captureTurnEndAndDiff(
        buildChatSessionKey(
          request.projectId,
          request.worktreeId,
          request.chatId,
        ),
        { userMessageId: settledUserMessageId },
      );
      if (turnDiff)
        await getChatStateService().ingestProviderEvent({
          ...request,
          data: {
            type: 'turn_diff',
            userMessageId: settledUserMessageId,
            ...turnDiff,
          },
          turnUserMessageId: settledUserMessageId,
          mutationId: `stop-turn-diff:${request.chatId}:${randomUUID()}`,
        });
    } catch {
      // The diff is best-effort, as on the terminal path; Stop still settles.
    }
  }
  return data;
}
