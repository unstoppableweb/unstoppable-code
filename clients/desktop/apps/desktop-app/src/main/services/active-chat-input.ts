import {
  readChatWatcherSnapshot,
  consumeChatWatcherTranscript,
} from './chat-state-service';
import {
  chatTerminalLifecycle,
  type ActiveChatInputProvider,
  type CanonicalChatAddress,
  type ChatWatcherEvidence,
  type ChatTerminalDisposition,
  type WatcherDeliveryIngressCheck,
  type ChatWatcherHeldOutcome,
} from '@canopy/desktop-shared/lib/chat-watcher-contracts';
import {
  STANDALONE_CHAT_PROJECT_ID,
  isTerminalBackedInterfaceMode,
} from '@canopy/desktop-shared/types';
import { botIdForProjectId } from '@canopy/protocol/chat-targets';
import { isInputLedger } from '@canopy/desktop-shared/chat-input-delivery';
import { serializeVisibleReadMessage } from '@canopy/desktop-shared/lib/chat-history-serialization';
import { isUserTurnBoundary } from '@canopy/agent-transcript/lib/turn-boundary';
import {
  ensureBotRegistryLoaded,
  requireBotWorkspace,
} from '../project-discovery/bots/registry';
import { resolveCoworkWorkspaceId } from '../lib/cowork-migration-map';

export interface ChatLifecycleTarget {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

/** Source normalization is independent of every watcher's recipient policy. */
export async function resolveCanonicalChatAddress(
  target: ChatLifecycleTarget,
): Promise<CanonicalChatAddress | null> {
  const { resolveAuthorizedChat } =
    await import('../project-discovery/chat-target');
  const { readBotEntries } = await import('../project-discovery/bots/target');
  const projectId = resolveCoworkWorkspaceId(
    target.projectId === STANDALONE_CHAT_PROJECT_ID
      ? target.worktreeId
      : target.projectId,
  );
  let taskId = target.worktreeId;
  if (target.projectId === STANDALONE_CHAT_PROJECT_ID) {
    // Legacy standalone scopes omit the owning Work Entry required by discovery.
    const { resolveWorkEntryForChat } =
      await import('../lib/cowork-work-entries');
    const { entryId } = await resolveWorkEntryForChat(projectId, target.chatId);
    if (!entryId) return null;
    taskId = entryId;
  }
  const botId = botIdForProjectId(projectId);
  if (botId) {
    await ensureBotRegistryLoaded?.();
    const bot = requireBotWorkspace(botId);
    if (
      !(await readBotEntries(bot.botId)).some(
        (entry) => entry.id === target.worktreeId,
      )
    )
      return null;
    return {
      botId,
      taskId: target.worktreeId,
      chatId: target.chatId,
    };
  }
  const context = await resolveAuthorizedChat(
    { projectId, taskId, chatId: target.chatId },
    { kind: 'app_advisor', chatId: target.chatId },
  );
  return context.address;
}

/** Capture once at acceptance, retaining this value through terminal delivery. */
export async function captureChatWatcherEvidence(
  address: CanonicalChatAddress,
): Promise<ChatWatcherEvidence> {
  if ('botId' in address) {
    await ensureBotRegistryLoaded?.();
    requireBotWorkspace(address.botId);
  } else {
    const botId = botIdForProjectId(address.projectId);
    if (botId) {
      await ensureBotRegistryLoaded?.();
      requireBotWorkspace(botId);
    }
  }
  const { requireAuthorizedProject } =
    await import('../project-discovery/owner-policy');
  const { requireBotAccess } = await import('../project-discovery/bots/target');
  if ('botId' in address) {
    await requireBotAccess({
      kind: 'app_advisor',
      chatId: address.chatId,
    });
    return { sourceOwner: null };
  }
  const project = await requireAuthorizedProject(address.projectId, {
    kind: 'app_advisor',
    chatId: address.chatId,
  });
  return {
    sourceOwner: project.owner,
    resourceIncarnation: project.incarnation,
  };
}

export function getCanonicalChatTerminalDisposition(
  data: unknown,
  status: string,
  hasVisibleOutput?: boolean,
): ChatTerminalDisposition {
  if (status === 'interrupted' || status === 'cancelled') return 'interrupted';
  if (
    status === 'failure' ||
    status === 'failed' ||
    status === 'error' ||
    (typeof data === 'object' &&
      data !== null &&
      (('type' in data && data.type === 'error') ||
        ('is_error' in data && data.is_error === true)))
  )
    return 'error';
  return hasVisibleOutput === false ? 'no_output' : 'completed';
}

/** A failed or missing turn read is unavailable, never evidence of no output. */
export async function hasCanonicalTurnVisibleOutput(
  target: ChatLifecycleTarget,
  sourceInputId: string,
): Promise<boolean | undefined> {
  try {
    return await consumeChatWatcherTranscript(target, async (messages) => {
      let found = false;
      let output = false;
      for await (const message of messages) {
        const visible = serializeVisibleReadMessage(message);
        // Folded steering and question answers stay inside the root's turn.
        if (visible?.role === 'user' && isUserTurnBoundary(message)) {
          if (found && message.id !== sourceInputId) break;
          found = message.id === sourceInputId;
        } else if (found && visible?.role === 'assistant') output = true;
      }
      return found ? output : undefined;
    });
  } catch {
    return undefined;
  }
}

export async function checkWatcherDeliveryIngress(
  request: ChatLifecycleTarget & {
    watcherFired?: unknown;
    watcherDeliveryId?: string;
  },
): Promise<Awaited<ReturnType<WatcherDeliveryIngressCheck>>> {
  if (!request.watcherFired || !request.watcherDeliveryId)
    return { allowed: true };
  try {
    // Non-chat watchers can target chats without a canonical address.
    const address = await resolveCanonicalChatAddress(request).catch(
      () => null,
    );
    const { getAppAdvisorWatcherService } =
      await import('../app-advisor/watchers');
    return getAppAdvisorWatcherService().checkDeliveryIngress(
      request.watcherDeliveryId,
      address,
    );
  } catch {
    return { allowed: false, outcome: 'held', reason: 'runtime_unavailable' };
  }
}

export class WatcherDeliveryHeldError extends Error {
  public readonly outcome = 'held';
  public constructor(public readonly reason: ChatWatcherHeldOutcome['reason']) {
    super('Watcher delivery is held.');
    this.name = 'WatcherDeliveryHeldError';
  }
}

export function getActiveChatInputProvider(): ActiveChatInputProvider {
  return {
    getActiveChatInput: async (
      address,
    ): Promise<
      Awaited<ReturnType<ActiveChatInputProvider['getActiveChatInput']>>
    > => {
      try {
        let projectId: string;
        if ('projectId' in address) {
          projectId = address.projectId;
          const botId = botIdForProjectId(projectId);
          if (botId) {
            await ensureBotRegistryLoaded?.();
            requireBotWorkspace(botId);
          }
        } else {
          await ensureBotRegistryLoaded?.();
          projectId = requireBotWorkspace(address.botId).projectId;
        }
        const target = {
          projectId,
          worktreeId: address.taskId,
          chatId: address.chatId,
        };
        const { runtimeStateFromEvidence } =
          await import('../project-discovery/runtime-state');
        const state = await readChatWatcherSnapshot(target);
        const tab = state.tabsFile.tabs.find(
          (candidate) => candidate.id === address.chatId,
        );
        if (!tab) return { state: 'unknown' };
        if (isTerminalBackedInterfaceMode(tab.interfaceMode)) {
          const { getClaudeTerminalSessionService } =
            await import('../integration/claude-terminal-session-service');
          const activity =
            await getClaudeTerminalSessionService().getActiveChatInput(target);
          if (activity.state === 'active' || activity.state === 'pending')
            return activity;
          if (isInputLedger(tab.inputDelivery)) {
            const pending = tab.inputDelivery.rows.find((row) =>
              ['sending', 'pending', 'queued', 'editing'].includes(row.state),
            );
            if (pending) return { state: 'pending', inputId: pending.id };
            if (
              tab.inputDelivery.rows.some(
                (row) =>
                  row.state === 'uncertain' || row.state === 'cancelling',
              )
            )
              return { state: 'unknown' };
          }
          const pending =
            state.runtimeByChatId[address.chatId]?.queuedMessages?.[0];
          return pending
            ? { state: 'pending', inputId: pending.request.userMessageId }
            : activity;
        }
        const runtime = state.runtimeByChatId[address.chatId];
        const observed = runtimeStateFromEvidence(runtime);
        if (
          runtime?.activeTurn &&
          (observed === 'running' ||
            observed === 'queued' ||
            (runtime.status === 'awaiting_input' &&
              runtime.error?.code !== 'interrupted'))
        )
          return { state: 'active', inputId: runtime.activeTurn.userMessageId };
        if (isInputLedger(tab.inputDelivery)) {
          const rows = tab.inputDelivery.rows;
          for (const row of rows) {
            const attempt = row.attempts.find(
              (candidate) => candidate.id === row.currentAttemptId,
            );
            // A native-mode chat runs no terminal turns; managed-terminal
            // imports never record settlement, so their attempts are stale.
            if (
              attempt?.pickedUpAt !== undefined &&
              attempt.generation !== 'managed-terminal' &&
              attempt.turnSettledAt === undefined &&
              attempt.completedAt === undefined &&
              attempt.withdrawnAt === undefined
            )
              return {
                state: 'active',
                inputId: attempt.rootUserMessageId ?? row.id,
              };
          }
          const pending = rows.find((row) =>
            ['sending', 'pending', 'queued', 'editing'].includes(row.state),
          );
          if (pending) return { state: 'pending', inputId: pending.id };
          if (
            rows.some(
              (row) => row.state === 'uncertain' || row.state === 'cancelling',
            )
          )
            return { state: 'unknown' };
        }
        const queued = runtime?.queuedMessages?.[0];
        if (queued)
          return { state: 'pending', inputId: queued.request.userMessageId };
        const { getActiveChatIds, getSession } =
          await import('../agents/session-manager');
        if (
          getActiveChatIds(target.projectId, target.worktreeId).includes(
            target.chatId,
          ) ||
          getSession(
            target.projectId,
            target.worktreeId,
            target.chatId,
          )?.hasPendingSteeringInput?.() === true
        )
          return { state: 'unknown' };
        return {
          state:
            observed === 'idle' ||
            observed === 'error' ||
            observed === 'interrupted'
              ? 'idle'
              : 'unknown',
        };
      } catch {
        return { state: 'unknown' };
      }
    },
  };
}

export type CanonicalChatProducerContext = {
  address: CanonicalChatAddress;
  evidence: ChatWatcherEvidence;
};

export async function captureCanonicalChatProducerContext(
  target: ChatLifecycleTarget,
): Promise<CanonicalChatProducerContext | null> {
  try {
    const address = await resolveCanonicalChatAddress(target);
    return address
      ? { address, evidence: await captureChatWatcherEvidence(address) }
      : null;
  } catch {
    return null;
  }
}

export async function notifyCanonicalChatStarted(
  target: ChatLifecycleTarget,
  sourceInputId: string,
  occurredAt: string,
  context = captureCanonicalChatProducerContext(target),
): Promise<void> {
  const captured = await context;
  if (!captured) return;
  occurredAt =
    (await getCanonicalInputAcceptedAt(target, sourceInputId)) ?? occurredAt;
  const { getAppAdvisorWatcherService } =
    await import('../app-advisor/watchers');
  await getAppAdvisorWatcherService().handleCanonicalChatStartedEvent({
    kind: 'started',
    eventId: JSON.stringify(['started', captured.address, sourceInputId]),
    ...captured,
    sourceInputId,
    occurredAt,
    observedAt: new Date().toISOString(),
  });
}

export async function notifyCanonicalChatTerminal(
  target: ChatLifecycleTarget,
  sourceInputId: string,
  data: unknown,
  status: string,
  occurredAt: string,
  context: Promise<CanonicalChatProducerContext | null>,
  acceptedAt?: string,
): Promise<void> {
  const captured = await context;
  if (!captured) return;
  const lifecycle = chatTerminalLifecycle(data);
  const sourceInputAcceptedAt =
    (await getCanonicalInputAcceptedAt(target, sourceInputId)) ?? acceptedAt;
  // An input that never ran has no acceptance time; its end still reaches the
  // watchers bound to it. Any other end needs one to bind a `next` cursor.
  if (!sourceInputAcceptedAt && lifecycle.endReason === undefined) return;
  const hasOutput =
    lifecycle.endReason === undefined
      ? await hasCanonicalTurnVisibleOutput(target, sourceInputId)
      : undefined;
  const { getAppAdvisorWatcherService } =
    await import('../app-advisor/watchers');
  await getAppAdvisorWatcherService().handleCanonicalChatTerminalEvent({
    kind: 'terminal',
    eventId: JSON.stringify(['terminal', captured.address, sourceInputId]),
    ...captured,
    sourceInputId,
    occurredAt,
    observedAt: new Date().toISOString(),
    sourceInputAcceptedAt: sourceInputAcceptedAt ?? '',
    disposition: getCanonicalChatTerminalDisposition(data, status, hasOutput),
    ...lifecycle,
  });
}

export async function getCanonicalInputAcceptedAt(
  target: ChatLifecycleTarget,
  sourceInputId: string,
): Promise<string | undefined> {
  try {
    const snapshot = await readChatWatcherSnapshot(target);
    const tab = snapshot.tabsFile.tabs.find(
      (candidate) => candidate.id === target.chatId,
    );
    if (isInputLedger(tab?.inputDelivery)) {
      // A turn-starting row's root is the row itself. A steering row only
      // names the earlier root it joined, so its time is not the root's.
      const row = tab.inputDelivery.rows.find(
        (candidate) => candidate.id === sourceInputId,
      );
      if (row) return new Date(row.createdAt).toISOString();
    }
    return await consumeChatWatcherTranscript(target, async (messages) => {
      for await (const message of messages) {
        if (message.id === sourceInputId && message.role === 'user')
          return new Date(message.timestamp).toISOString();
      }
      return undefined;
    });
  } catch {
    return undefined;
  }
}
