// Claude managed-terminal runtime state sync helpers.
import type { ClaudeTerminalRuntimeState } from '@canopy/desktop-shared/types';
import { parseChatAgentSentInfo } from '@canopy/protocol/remote-control/shell';
import type { ClaudeTerminalClientState } from '@/stores/claudeTerminalStore';
import type { ChatTab, QueuedChatMessage } from './types';
import { nextMsgId } from './ids';
import { newestUserTurnHasText } from './transcript-dedupe';
import { resolveTabProviderType } from './tab-utils';
import { chatStoreApi } from './store-ref';

export function mergeClaudeTerminalRuntimeState(
  tab: ChatTab,
  snapshot: ClaudeTerminalClientState,
): ClaudeTerminalRuntimeState {
  return {
    ...tab.claudeTerminal,
    ...(snapshot.terminalId ? { terminalId: snapshot.terminalId } : {}),
    ...(snapshot.sessionKey ? { sessionKey: snapshot.sessionKey } : {}),
    ...(snapshot.sdkSessionId ? { sdkSessionId: snapshot.sdkSessionId } : {}),
    turnState: snapshot.turnState,
    readyForInput: snapshot.readyForInput === true,
  };
}

export function claudeTerminalRuntimeStatesEqual(
  a: ClaudeTerminalRuntimeState | undefined,
  b: ClaudeTerminalRuntimeState,
): boolean {
  return (
    a?.terminalId === b.terminalId &&
    a?.sessionKey === b.sessionKey &&
    a?.sdkSessionId === b.sdkSessionId &&
    a?.turnState === b.turnState &&
    (a?.readyForInput === true) === (b.readyForInput === true) &&
    a?.startedAt === b.startedAt &&
    a?.lastHookAt === b.lastHookAt &&
    a?.lastSyncAt === b.lastSyncAt &&
    a?.lastError === b.lastError
  );
}

export function statusForClaudeTerminalTurnState(
  snapshot: ClaudeTerminalClientState,
  currentStatus: ChatTab['status'],
): ChatTab['status'] {
  if (snapshot.launchStatus === 'error') {
    return 'error';
  }
  if (
    snapshot.autoSendPending === true ||
    snapshot.launchStatus === 'starting'
  ) {
    return 'streaming';
  }
  switch (snapshot.turnState) {
    case 'starting':
    case 'running':
    case 'cleaning_up':
      return 'streaming';
    case 'error':
      return 'error';
    case 'idle':
      if (
        currentStatus === 'streaming' &&
        snapshot.lastLaunchConsumedInitialPrompt === true &&
        snapshot.readyForInput !== true
      ) {
        return 'streaming';
      }
      return currentStatus === 'streaming' ? 'idle' : currentStatus;
    case 'exited':
      return currentStatus === 'streaming' ? 'idle' : currentStatus;
    case 'uninitialized':
      return currentStatus;
  }
}

export function syncClaudeTerminalRuntimeStateToChatTab(
  snapshot: ClaudeTerminalClientState,
): void {
  const key = `${snapshot.projectId}/${snapshot.worktreeId}`;
  chatStoreApi().setState((state) => {
    const wc = state.worktreeChats[key];
    if (!wc) return state;

    let changed = false;
    const tabs = wc.tabs.map((tab) => {
      if (tab.id !== snapshot.chatId || tab.kind === 'file') {
        return tab;
      }
      if (resolveTabProviderType(tab) !== 'claude') {
        if (tab.claudeTerminal === undefined) {
          return tab;
        }
        changed = true;
        const nextTab = { ...tab };
        delete nextTab.claudeTerminal;
        return nextTab;
      }

      const claudeTerminal = mergeClaudeTerminalRuntimeState(tab, snapshot);
      const status = statusForClaudeTerminalTurnState(snapshot, tab.status);
      if (
        tab.status === status &&
        claudeTerminalRuntimeStatesEqual(tab.claudeTerminal, claudeTerminal)
      ) {
        return tab;
      }

      changed = true;
      return {
        ...tab,
        status,
        claudeTerminal,
        ...(snapshot.errorMessage ? { error: snapshot.errorMessage } : {}),
      };
    });

    if (!changed) {
      return state;
    }

    const updated = { ...wc, tabs };
    return {
      worktreeChats: { ...state.worktreeChats, [key]: updated },
    };
  });
}

export function appendConsumedClaudeTerminalInitialPrompt(
  tab: ChatTab,
  queuedMessage: QueuedChatMessage,
  submittedAt: number,
  messageIds?: { userMessageId: string; turnTimerMessageId: string },
): ChatTab {
  // Main-accepted input is matched by its id, never by text, so an identical
  // typed turn cannot absorb or lend agent attribution.
  const acceptedInputId = queuedMessage.dispatchOptions?.acceptedInputId
    ? (messageIds?.userMessageId ??
      queuedMessage.dispatchOptions.acceptedInputId)
    : undefined;
  const agentSent = acceptedInputId
    ? parseChatAgentSentInfo(
        queuedMessage.agentSent ?? queuedMessage.dispatchOptions?.agentSent,
      )
    : undefined;
  const newestUserTurnMatches = acceptedInputId
    ? tab.messages.some((message) => message.id === acceptedInputId)
    : newestUserTurnHasText(tab.messages, queuedMessage.text);
  let matchedMessages = tab.messages;
  const watcherFired = queuedMessage.dispatchOptions?.watcherFired;
  if (newestUserTurnMatches && (watcherFired || agentSent)) {
    for (let index = tab.messages.length - 1; index >= 0; index -= 1) {
      const message = tab.messages[index];
      if (message?.role !== 'user') continue;
      if (acceptedInputId && message.id !== acceptedInputId) continue;
      matchedMessages = [...tab.messages];
      matchedMessages[index] = {
        ...message,
        ...(watcherFired ? { watcherFired } : {}),
        ...(agentSent
          ? { agentSent, userMessageSource: 'agent' as const }
          : {}),
      };
      break;
    }
  }

  const messages = newestUserTurnMatches
    ? matchedMessages
    : [
        ...tab.messages,
        {
          id: acceptedInputId ?? messageIds?.userMessageId ?? nextMsgId(),
          role: 'user' as const,
          blocks: [
            ...(queuedMessage.fileReferences &&
            queuedMessage.fileReferences.length > 0
              ? [
                  {
                    type: 'file_references' as const,
                    references: queuedMessage.fileReferences,
                  },
                ]
              : []),
            { type: 'text' as const, text: queuedMessage.text },
          ],
          timestamp: submittedAt,
          ...(queuedMessage.attachmentPaths
            ? { attachmentPaths: queuedMessage.attachmentPaths }
            : {}),
          ...(queuedMessage.attachmentPromptContexts
            ? {
                attachmentPromptContexts:
                  queuedMessage.attachmentPromptContexts,
              }
            : {}),
          ...(queuedMessage.inputMode
            ? { inputMode: queuedMessage.inputMode }
            : {}),
          ...(watcherFired ? { watcherFired } : {}),
          ...(agentSent
            ? { agentSent, userMessageSource: 'agent' as const }
            : {}),
        },
        {
          id: messageIds?.turnTimerMessageId ?? nextMsgId(),
          role: 'system' as const,
          blocks: [
            {
              type: 'turn_timer' as const,
              startedAt: submittedAt,
              completedAt: null,
            },
          ],
          timestamp: submittedAt,
        },
      ];

  return {
    ...tab,
    messages,
    queuedMessages: tab.queuedMessages.filter((_, index) => index !== 0),
  };
}
