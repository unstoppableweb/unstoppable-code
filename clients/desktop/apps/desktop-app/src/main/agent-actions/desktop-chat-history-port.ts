import type { AgentChatHistoryPort } from '@canopy/agent-actions/families/chat-history';
import { AgentPortError } from '@canopy/agent-actions';
import type { CanopyInjectedToolRuntime } from '../canopy-tools/core';
import {
  queryChatHistory,
  queryChatExcerpt,
  type ChatHistoryToolScope,
} from '../canopy-tools/session-runtime';

function scopeFor(host: CanopyInjectedToolRuntime): ChatHistoryToolScope {
  const scope = host.worktreeWatcherRuntime;
  if (!scope)
    throw new AgentPortError(
      'surface_unavailable',
      'The calling chat scope is unavailable.',
    );
  return {
    projectId: scope.projectId,
    worktreeId: scope.worktreeId,
    chatId: scope.chatId,
  };
}
/** The same memory-granted operations as the injected tools, with trusted root-chat scope. */
export const desktopChatHistoryPort: AgentChatHistoryPort<CanopyInjectedToolRuntime> =
  {
    search: (input, call) =>
      queryChatHistory({ ...input, ...scopeFor(call.host) }),
    excerpt: (input, call) =>
      queryChatExcerpt({ ...input, ...scopeFor(call.host) }),
  };
