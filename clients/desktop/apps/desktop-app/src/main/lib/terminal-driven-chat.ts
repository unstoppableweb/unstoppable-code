import {
  getProviderForModel,
  isTerminalBackedInterfaceMode,
  type ClaudeTerminalTurnState,
  type PersistedChatTab,
} from '@canopy/desktop-shared/types';

/** The tab settings that decide whether a chat's terminal drives it. */
export type TerminalDrivenChatTab = Pick<
  PersistedChatTab,
  'kind' | 'providerType' | 'model' | 'interfaceMode' | 'sdkSessionId'
>;

/** The provider a persisted chat tab runs on, from its provider or model. */
export function persistedTabProvider(
  tab: TerminalDrivenChatTab | undefined,
):
  | 'claude'
  | 'codex'
  | 'ollama'
  | 'cursor'
  | 'copilot'
  | 'antigravity'
  | 'opencode'
  | undefined {
  if (!tab || tab.kind === 'file') return undefined;
  return (
    tab.providerType ?? (tab.model ? getProviderForModel(tab.model) : undefined)
  );
}

/**
 * Whether a chat's turns are driven by its managed Claude Code terminal, so
 * a revisioned send cannot drive it: a Claude chat whose terminal turn is
 * starting, running, or cleaning up, or whose tab is terminal-backed and
 * holds a terminal session.
 */
export function isTerminalDrivenChat(
  tab: TerminalDrivenChatTab | undefined,
  terminalTurnState: ClaudeTerminalTurnState | undefined,
): boolean {
  if (!tab || persistedTabProvider(tab) !== 'claude') return false;
  return (
    terminalTurnState === 'starting' ||
    terminalTurnState === 'running' ||
    terminalTurnState === 'cleaning_up' ||
    (isTerminalBackedInterfaceMode(tab.interfaceMode) &&
      tab.sdkSessionId !== undefined)
  );
}

/** {@link isTerminalDrivenChat} with the chat's live terminal state. */
export async function resolveTerminalDrivenChat(target: {
  projectId: string;
  worktreeId: string;
  tab: PersistedChatTab | undefined;
}): Promise<boolean> {
  if (!target.tab || persistedTabProvider(target.tab) !== 'claude') {
    return false;
  }
  const turnState = await claudeTerminalTurnStates();
  return isTerminalDrivenChat(
    target.tab,
    turnState({ ...target, chatId: target.tab.id }),
  );
}

/** A synchronous reader of chats' live Claude Code terminal turn states. */
export async function claudeTerminalTurnStates(): Promise<
  (chat: {
    projectId: string;
    worktreeId: string;
    chatId: string;
  }) => ClaudeTerminalTurnState | undefined
> {
  // Lazy by design: terminal-session-service imports chat-service while
  // installing its runtime hooks, so a static import would create a cycle.
  const { getClaudeTerminalSessionService } =
    await import('../integration/claude-terminal-session-service');
  const service = getClaudeTerminalSessionService();
  return (chat) =>
    service.getState(chat.projectId, chat.worktreeId, chat.chatId)?.turnState;
}
