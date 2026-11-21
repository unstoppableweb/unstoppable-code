import type { PersistedChatBlock, PersistedChatMessage } from '../types';

export function isAgentActivityBlock(block: PersistedChatBlock): boolean {
  return (
    block.type === 'image' ||
    block.type === 'thinking' ||
    block.type === 'tool_use' ||
    block.type === 'tool_result' ||
    block.type === 'codex_agent_call'
  );
}

export function messageHasAgentActivity(
  message: PersistedChatMessage,
): boolean {
  return (
    message.role !== 'user' &&
    message.blocks.some((block) =>
      block.type === 'text'
        ? message.role === 'assistant' && block.text.trim().length > 0
        : isAgentActivityBlock(block),
    )
  );
}
