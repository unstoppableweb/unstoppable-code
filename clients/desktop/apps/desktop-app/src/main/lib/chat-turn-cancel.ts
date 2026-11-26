import type { ChatCancelRequest } from '@canopy/desktop-shared/types';
import { stopRunningSecretCommands } from '../agent-secrets/running-commands';
import type { AgentSession } from '../agents/types';
import {
  captureClaudeStopFence,
  interruptClaudeSessionForStop,
  isClaudeStopFenceCurrent,
  type ClaudeStopFence,
} from '../agents/claude-session';
import {
  drainChatSessionEvents,
  suppressCodexAuthenticationRecovery,
  getAllActiveSessionInfos,
  getSession,
  getSessionProviderType,
  buildSessionKey,
  markSessionForNextTurnRecreation,
  markSessionTeardownCause,
} from '../agents/session-manager';
import {
  cancelChatTurnPreparations,
  chatTurnPreparationTargets,
  snapshotChatTurnPreparations,
  type PendingChatTurnPreparation,
} from './chat-turn-preparation';
import {
  getChatTurnOwnership,
  type ChatTurnOwnershipSnapshot,
} from '../services/chat-turn-ownership';

export { beginChatTurnPreparation } from './chat-turn-preparation';

export interface ChatTurnStopContext {
  readonly target: ChatCancelRequest;
  readonly session: AgentSession | undefined;
  readonly fence: ClaudeStopFence | undefined;
  readonly turn?: ChatTurnStopIdentity;
  readonly unstartedDispatch?: UnstartedDispatch;
  /** Sends being prepared at capture; Stop owns these when no turn runs. */
  readonly preparations?: ReadonlySet<PendingChatTurnPreparation>;
}

export interface ChatTurnStopIdentity {
  readonly userMessageId: string;
  readonly executionTurnId?: string;
}

interface UnstartedDispatch {
  readonly userMessageId: string;
  readonly token: symbol;
  readonly operationEpoch: number;
  readonly serviceEpoch: symbol;
}

function stopOwnershipSnapshot(
  target: ChatCancelRequest,
): ChatTurnOwnershipSnapshot | undefined {
  const ownership = getChatTurnOwnership();
  return ownership.isBound() ? ownership.getSnapshot(target) : undefined;
}

function isUnstartedDispatchPhase(
  snapshot: ChatTurnOwnershipSnapshot | undefined,
): snapshot is ChatTurnOwnershipSnapshot {
  return (
    snapshot?.knowledge === 'known' &&
    snapshot.receipt !== undefined &&
    snapshot.committed !== undefined &&
    snapshot.receipt.state.current === undefined &&
    snapshot.committed.state.current === undefined &&
    snapshot.unacknowledgedLifecycle.length === 0
  );
}

function uniqueUnstartedDispatch(
  snapshot: ChatTurnOwnershipSnapshot | undefined,
): UnstartedDispatch | undefined {
  if (
    !isUnstartedDispatchPhase(snapshot) ||
    snapshot.dispatchOwners.length !== 1
  )
    return;
  const [owner] = snapshot.dispatchOwners;
  if (!owner?.userMessageId || owner.turnId !== undefined) return;
  return {
    userMessageId: owner.userMessageId,
    token: owner.token,
    operationEpoch: owner.operationEpoch,
    serviceEpoch: snapshot.serviceEpoch,
  };
}

function capturedStopTurn(
  snapshot: ChatTurnOwnershipSnapshot | undefined,
  fence: ClaudeStopFence | undefined,
): ChatTurnStopIdentity | undefined {
  const live = (snapshot?.receipt ?? snapshot?.committed)?.state.current;
  if (!fence) {
    return live?.userMessageId === undefined
      ? undefined
      : { userMessageId: live.userMessageId, executionTurnId: live.id };
  }
  if (fence.userMessageId === undefined) return undefined;
  const bound = [
    snapshot?.receipt?.state.current,
    snapshot?.receipt?.state.lastEnded,
    snapshot?.committed?.state.current,
    snapshot?.committed?.state.lastEnded,
  ].find(
    (record) => record?.id === fence.turnId && record?.userMessageId,
  )?.userMessageId;
  const owners = (snapshot?.dispatchOwners ?? []).filter(
    (owner) => owner.userMessageId !== undefined,
  );
  const dispatch =
    owners.find((owner) => owner.turnId === fence.turnId) ??
    (owners.length === 1 && owners[0]?.turnId === undefined
      ? owners[0]
      : undefined);
  const userMessageId =
    fence.userMessageId === fence.turnId
      ? (bound ?? dispatch?.userMessageId ?? fence.userMessageId)
      : fence.userMessageId;
  return { userMessageId, executionTurnId: fence.turnId };
}

export interface ChatTurnCancelOutcome {
  readonly context: ChatTurnStopContext;
  readonly outcome:
    | 'interrupted'
    | 'fallback-aborted'
    | 'cancelled'
    | 'not-found';
  /** Set when this still-current Stop cancelled at least one preparing send. */
  readonly preparationsCancelled?: true;
}

/** Capture the session/process and native-turn identities without awaiting. */
export function captureChatTurnStop(
  target: ChatCancelRequest,
): ChatTurnStopContext {
  const session = getSession(
    target.projectId,
    target.worktreeId,
    target.chatId,
  );
  const fence = captureClaudeStopFence(session);
  const snapshot = stopOwnershipSnapshot(target);
  const unstartedDispatch =
    fence === undefined &&
    session !== undefined &&
    getSessionProviderType(
      target.projectId,
      target.worktreeId,
      target.chatId,
    ) === 'codex'
      ? uniqueUnstartedDispatch(snapshot)
      : undefined;
  return {
    target,
    session,
    fence,
    turn: unstartedDispatch
      ? { userMessageId: unstartedDispatch.userMessageId }
      : capturedStopTurn(snapshot, fence),
    ...(unstartedDispatch ? { unstartedDispatch } : {}),
    preparations: snapshotChatTurnPreparations(target),
  };
}

/**
 * Stop contexts for each live session and each preparing send of one chat,
 * taken before any await. A chat's first send has no session yet.
 */
export function captureChatTurnStopsForChat(
  chatId: string,
): ChatTurnStopContext[] {
  const targets = new Map<string, ChatCancelRequest>();
  for (const target of [
    ...getAllActiveSessionInfos().filter((info) => info.chatId === chatId),
    ...chatTurnPreparationTargets(chatId),
  ]) {
    targets.set(buildSessionKey(target.projectId, target.worktreeId, chatId), {
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      chatId,
    });
  }
  return Array.from(targets.values(), captureChatTurnStop);
}

/**
 * A Stop captured a chat's first send before it had a session. If that send
 * registers its session before Stop acts, recapture the chat for the same
 * send: this Stop owns it, but never a newer send's turn.
 */
export function adoptPreparingSendSession(
  context: ChatTurnStopContext,
): ChatTurnStopContext {
  const captured = context.preparations;
  if (context.session !== undefined || !captured || captured.size === 0)
    return context;
  const fresh = captureChatTurnStop(context.target);
  if (fresh.session === undefined) return context;
  const ownedIds = new Set<string>();
  for (const preparation of Array.from(captured))
    if (preparation.userMessageId !== undefined)
      ownedIds.add(preparation.userMessageId);
  const preparations = new Set(
    Array.from(fresh.preparations ?? []).filter(
      (preparation) =>
        captured.has(preparation) ||
        (preparation.userMessageId !== undefined &&
          ownedIds.has(preparation.userMessageId)),
    ),
  );
  if (fresh.fence === undefined) {
    if (
      fresh.turn
        ? !ownedIds.has(fresh.turn.userMessageId)
        : preparations.size === 0
    )
      return context;
    return { ...fresh, preparations };
  }
  const { turnId, userMessageId } = fresh.fence;
  const boundUserMessageId = fresh.turn?.userMessageId ?? userMessageId;
  const ownsTurn =
    boundUserMessageId !== undefined && ownedIds.has(boundUserMessageId);
  const idle = turnId === undefined && userMessageId === undefined;
  // Never take a newer send's or a wake's turn.
  if (!ownsTurn && !(idle && preparations.size > 0)) return context;
  return { ...fresh, preparations };
}

/** Whether a captured Stop still refers to the registered session and turn. */
export function isChatTurnStopCurrent(context: ChatTurnStopContext): boolean {
  if (
    getSession(
      context.target.projectId,
      context.target.worktreeId,
      context.target.chatId,
    ) !== context.session
  ) {
    return false;
  }
  if (context.fence !== undefined)
    return isClaudeStopFenceCurrent(context.session, context.fence);
  const snapshot = stopOwnershipSnapshot(context.target);
  const queued = context.unstartedDispatch;
  if (queued) {
    const current = uniqueUnstartedDispatch(snapshot);
    return (
      current?.token === queued.token &&
      current.operationEpoch === queued.operationEpoch &&
      current.serviceEpoch === queued.serviceEpoch &&
      current.userMessageId === queued.userMessageId
    );
  }
  const live = capturedStopTurn(snapshot, undefined);
  return (
    live === undefined || live.executionTurnId === context.turn?.executionTurnId
  );
}

function markStopRecreationIfStillOwned(context: ChatTurnStopContext): void {
  const { target, session } = context;
  if (
    session === undefined ||
    getSession(target.projectId, target.worktreeId, target.chatId) !== session
  ) {
    return;
  }
  markSessionForNextTurnRecreation(
    target.projectId,
    target.worktreeId,
    target.chatId,
    'stop',
  );
  try {
    markSessionTeardownCause(
      buildSessionKey(target.projectId, target.worktreeId, target.chatId),
      'stop',
    );
  } catch {
    // Session-cause bookkeeping must never block Stop.
  }
}

function sameTarget(
  left: ChatCancelRequest,
  right: ChatCancelRequest,
): boolean {
  return (
    left.projectId === right.projectId &&
    left.worktreeId === right.worktreeId &&
    left.chatId === right.chatId
  );
}

function cancelOwnedPreparations(
  context: ChatTurnStopContext,
  intent: 'stop' | 'teardown',
): {
  settled: Promise<void>;
  idleSendsCancelled: boolean;
  anyCancelled: boolean;
} {
  const userMessageId = context.fence?.userMessageId;
  // A send's dispatch can begin its own preparation after Stop's capture.
  const preparedUserMessageIds = new Set(
    Array.from(
      context.preparations ?? [],
      (preparation) => preparation.userMessageId,
    ),
  );
  // Native Stop owns one captured turn, or, when no turn runs, the sends that
  // were preparing when it was captured. Do not invalidate a new send that
  // entered while this operation was resolving its asynchronous services.
  // Teardown and providers without native turn identity retain the legacy
  // whole-chat cancellation behavior.
  let idleSendsCancelled = false;
  let anyCancelled = false;
  const owns = (preparation: PendingChatTurnPreparation): boolean => {
    if (intent === 'teardown') return true;
    if (context.unstartedDispatch)
      return (
        preparation.userMessageId === context.unstartedDispatch.userMessageId
      );
    if (context.fence === undefined) return true;
    if (userMessageId !== undefined)
      return preparation.userMessageId === userMessageId;
    const owned =
      context.preparations?.has(preparation) === true ||
      (preparation.userMessageId !== undefined &&
        preparedUserMessageIds.has(preparation.userMessageId));
    if (owned) idleSendsCancelled = true;
    return owned;
  };
  const settled = cancelChatTurnPreparations(context.target, (preparation) => {
    const owned = owns(preparation);
    if (owned) anyCancelled = true;
    return owned;
  });
  return { settled, idleSendsCancelled, anyCancelled };
}

function isContextSessionRegistered(context: ChatTurnStopContext): boolean {
  return (
    getSession(
      context.target.projectId,
      context.target.worktreeId,
      context.target.chatId,
    ) === context.session
  );
}

function isCancellationCurrent(
  context: ChatTurnStopContext,
  intent: 'stop' | 'teardown',
): boolean {
  return intent === 'teardown'
    ? isContextSessionRegistered(context)
    : isChatTurnStopCurrent(context);
}

/** Stop a foreground turn or destructively tear down a session. */
export async function cancelChatTurn(
  req: ChatCancelRequest,
  intent: 'stop' | 'teardown' = 'teardown',
  captured?: ChatTurnStopContext,
  options: { preserveAuthRecovery?: boolean } = {},
): Promise<ChatTurnCancelOutcome> {
  const context = captured ?? captureChatTurnStop(req);
  const { session } = context;
  if (
    !sameTarget(req, context.target) ||
    !isCancellationCurrent(context, intent)
  ) {
    return { context, outcome: 'not-found' };
  }
  const queued = intent === 'stop' ? context.unstartedDispatch : undefined;
  const queuedStopEpoch = queued
    ? stopOwnershipSnapshot(req)?.operationEpoch
    : undefined;
  suppressCodexAuthenticationRecovery(req);
  // A RunWithSecrets command must not outlive the turn: every Stop entry
  // point (the window, the Portal, a turn-specific cancel) ends it here.
  stopRunningSecretCommands({
    projectId: req.projectId,
    worktreeId: req.worktreeId,
    chatId: req.chatId,
  });
  // The local preparation table is synchronous, so cancel the captured send
  // before any dynamic service import can yield to a newer send or wake.
  const preparations = cancelOwnedPreparations(context, intent);
  if (!options.preserveAuthRecovery) {
    const { clearPendingAuthResume } = await import('./auth-failure-turn-stop');
    clearPendingAuthResume(req);
  }
  // Lazy by design: chat-state and chat-queue both import this cancellation
  // helper. Deferring their reverse edges breaks those initialization cycles;
  // the packaged Electron main build exercises these local import paths.
  const [stateModule, queueModule] = await Promise.all([
    import('../services/chat-state-service'),
    import('../services/chat-queue-service'),
  ]);
  const getChatStateService = stateModule.getChatStateService;
  const getChatQueueService = queueModule.getChatQueueService;
  const finishCancellation = (
    outcome: ChatTurnCancelOutcome['outcome'],
  ): ChatTurnCancelOutcome => {
    let preparationsCancelled = false;
    if (preparations.anyCancelled) {
      preparationsCancelled = isCancellationCurrent(context, intent);
      if (
        queued &&
        !preparationsCancelled &&
        isContextSessionRegistered(context)
      ) {
        // The preparation may retire its dispatch during cancellation. The
        // same epoch with no successor still permits settling just that send.
        const snapshot = stopOwnershipSnapshot(req);
        preparationsCancelled =
          isUnstartedDispatchPhase(snapshot) &&
          snapshot.serviceEpoch === queued.serviceEpoch &&
          snapshot.operationEpoch === queuedStopEpoch &&
          snapshot.dispatchOwners.length === 0;
      }
      if (queued && preparationsCancelled) {
        // Only the untagged terminal releases the queue's cancelled
        // preparation reservation. Do this while it still belongs to Stop.
        getChatQueueService().onTurnTerminal(req, 'cancelled');
      }
    }
    return {
      context,
      outcome,
      ...(preparationsCancelled ? { preparationsCancelled: true } : {}),
    };
  };
  // The session object can survive several turns. Check its captured native
  // turn epoch again after imports, before touching queue/input state.
  if (!isCancellationCurrent(context, intent)) {
    if (!queued) return { context, outcome: 'not-found' };
    await preparations.settled;
    return finishCancellation('not-found');
  }
  getChatQueueService().invalidatePendingInputOperations(req);
  await preparations.settled;
  // The queue holds a Stop reservation for a send whose preparation Stop
  // cancelled, until an untagged terminal arrives. An idle native Stop has no
  // turn to end, so release that hold here for every Stop caller, as a
  // non-native Stop's terminal does. Nothing reaches the session transcript.
  // A newer send that took the session while the settlements ran keeps its
  // ownership.
  if (preparations.idleSendsCancelled && isCancellationCurrent(context, intent))
    getChatQueueService().onTurnTerminal(req, 'cancelled');

  const providerType = getSessionProviderType(
    req.projectId,
    req.worktreeId,
    req.chatId,
  );
  if (
    intent === 'teardown' &&
    (providerType === 'claude' || providerType === 'ollama')
  ) {
    markStopRecreationIfStillOwned(context);
  }

  let outcome: ChatTurnCancelOutcome['outcome'] =
    session === undefined ? 'not-found' : 'cancelled';
  try {
    await getChatStateService().inputDelivery.stop(req, async () => {
      // inputDelivery.stop may yield while suspending its durable ledger.
      // Avoid invoking an old Stop against a newer foreground epoch.
      if (!isCancellationCurrent(context, intent)) {
        outcome = 'not-found';
        return;
      }
      if (!session) return;
      if (intent === 'stop' && providerType === 'claude') {
        const nativeStop = await interruptClaudeSessionForStop(
          session,
          context.fence,
        );
        if (nativeStop.outcome === 'interrupted') {
          outcome = 'interrupted';
          return;
        }
        if (nativeStop.outcome === 'fallback-aborted') {
          outcome = 'fallback-aborted';
          // The native helper has disposed the captured process. Never mark a
          // replacement session registered under this target.
          markStopRecreationIfStillOwned(context);
          return;
        }
        // Ollama, Codex, and restricted/non-native sessions retain the
        // destructive compatibility behavior. Only Claude/Ollama recreate.
        if (providerType === 'claude' || providerType === 'ollama') {
          markStopRecreationIfStillOwned(context);
        }
      } else if (intent === 'stop' && providerType === 'ollama') {
        // Ollama has no native interrupt receipt seam; its stop remains the
        // established destructive cancel/recreate behavior.
        markStopRecreationIfStillOwned(context);
      }
      await session.cancel();
    });
  } catch {
    // Swallow cancel errors (e.g. interruptTurn() JSON-RPC failure). Callers
    // still reset UI/session state through their normal cleanup paths.
  } finally {
    // Provider cancellation can produce a real terminal prefix. Drain it
    // before Stop returns even when the native helper completed by receipt
    // rather than by calling the destructive AgentSession.cancel().
    try {
      await drainChatSessionEvents(req.projectId, req.worktreeId, req.chatId);
    } catch {
      // Preserve cancellation's non-throwing compatibility contract.
    }
  }
  return finishCancellation(outcome);
}

/** Queued Interrupt preserves Claude's query and waits for its real result. */
export async function interruptChatTurnForQueuedMessage(
  req: ChatCancelRequest,
): Promise<void> {
  const context = captureChatTurnStop(req);
  const { session } = context;
  if (!session) return;
  // Lazy by design: chat-state reaches this helper through chat-queue, so a
  // static reverse import would create an initialization cycle. The packaged
  // Electron main build exercises this local import path.
  const { getChatStateService } =
    await import('../services/chat-state-service');
  const state = getChatStateService();
  if (!isChatTurnStopCurrent(context)) return;
  try {
    await state.inputDelivery.stop(req, async () => {
      if (!isChatTurnStopCurrent(context)) return;
      const provider = getSessionProviderType(
        req.projectId,
        req.worktreeId,
        req.chatId,
      );
      if (provider === 'claude') {
        const nativeStop = await interruptClaudeSessionForStop(
          session,
          context.fence,
        );
        if (nativeStop.outcome === 'interrupted') return;
        if (nativeStop.outcome === 'fallback-aborted') {
          markStopRecreationIfStillOwned(context);
          return;
        }
      }
      if (
        session.interruptWithPendingSweep &&
        session.getSteeringCapabilities?.()?.interrupt === true
      ) {
        await session.interruptWithPendingSweep();
      } else {
        if (session.hasPendingSteeringInput?.())
          throw new Error(
            'Pending input could not be withdrawn; the replacement remains queued.',
          );
        if (provider === 'claude' || provider === 'ollama')
          markStopRecreationIfStillOwned(context);
        // Before receipt negotiation (or on an older runtime) retain the
        // established cancel/recreate fallback without invalidating this
        // queued replacement's operation epoch as a composer Stop would.
        await session.cancel();
      }
    });
  } finally {
    // The real terminal may have been admitted by a native interrupt that
    // returned above; commit it before the queue releases its replacement.
    await drainChatSessionEvents(req.projectId, req.worktreeId, req.chatId);
  }
}
