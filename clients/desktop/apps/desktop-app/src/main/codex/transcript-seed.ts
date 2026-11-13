import type {
  PersistedChatBlock,
  PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import type { JsonValue } from '@canopy/execution-engine/node/codex-runtime/generated/serde_json/JsonValue';
import { readChatTabsFile, readChatTranscript } from '../lib/chat-tabs-reader';
import { readCodexReconstructionSeed } from './reconstruction-seed-store';

function textForBlock(block: PersistedChatBlock): string | null {
  if (block.type === 'text') return block.text;
  if (block.type === 'file_references') {
    const paths = block.references.map((reference) => reference.displayPath);
    return paths.length > 0 ? `Attached files: ${paths.join(', ')}` : null;
  }
  return null;
}

/**
 * Last-resort Codex reconstruction for a rollout that is genuinely absent.
 * Normal capability changes use the rollout's native response_item payloads;
 * this projection preserves the visible conversation and tool call/result
 * pairs for legacy imports and stale sessions instead of silently starting an
 * empty thread.
 */
export function persistedMessagesToCodexSeedItems(
  messages: readonly PersistedChatMessage[],
): JsonValue[] {
  const items: JsonValue[] = [];
  for (const message of messages) {
    // Subagent output is already represented in the root agent's tool result.
    // Re-injecting it as an independent root message duplicates context.
    if (message.parentBlockId || message.parentToolUseId) continue;

    const pendingText: string[] = [];
    const flushText = (): void => {
      const text = pendingText.splice(0).join('\n\n');
      if (!text) return;
      const role = message.role === 'system' ? 'developer' : message.role;
      items.push({
        type: 'message',
        role,
        content: [
          {
            type: role === 'assistant' ? 'output_text' : 'input_text',
            text,
          },
        ],
      });
    };

    for (const block of message.blocks) {
      const text = textForBlock(block);
      if (text?.trim()) {
        pendingText.push(text);
        continue;
      }
      if (block.type === 'tool_use') {
        flushText();
        items.push({
          type: 'function_call',
          name: block.toolName,
          arguments: block.input,
          call_id: block.toolUseId,
        });
      } else if (block.type === 'tool_result') {
        flushText();
        items.push({
          type: 'function_call_output',
          call_id: block.toolUseId,
          output: block.output,
        });
      }
    }
    flushText();
  }
  return items;
}

export async function loadPersistedCodexFallbackSeedItems(options: {
  projectId: string;
  worktreeId: string;
  chatId: string;
  excludeMessageId?: string;
}): Promise<JsonValue[]> {
  const tabs = await readChatTabsFile(options.projectId, options.worktreeId);
  const tab = tabs.tabs.find((candidate) => candidate.id === options.chatId);
  if (tab?.codexReconstructionSeedId) {
    const retainedSeed = await readCodexReconstructionSeed(
      tab.codexReconstructionSeedId,
    ).catch(() => []);
    if (retainedSeed.length > 0) return retainedSeed;
  }
  const messages = tab
    ? await readChatTranscript(
        options.projectId,
        options.worktreeId,
        options.chatId,
        true,
      )
    : [];
  return tab
    ? persistedMessagesToCodexSeedItems(
        options.excludeMessageId
          ? messages.filter(
              (message) => message.id !== options.excludeMessageId,
            )
          : messages,
      )
    : [];
}

/** A copied fork must have native history or a nonempty reconstruction before send. */
export async function loadCodexForkContinuation(options: {
  projectId: string;
  worktreeId: string;
  chatId: string;
  excludeMessageId?: string;
}): Promise<{ threadId: string } | { seedItems: JsonValue[] } | undefined> {
  const tabs = await readChatTabsFile(options.projectId, options.worktreeId);
  const tab = tabs.tabs.find((candidate) => candidate.id === options.chatId);
  if (!tab?.forkedFrom) return undefined;
  // Cross-provider continuations intentionally send only their handoff summary.
  // Reconstructing copied messages here would violate that user-visible contract.
  if (tab.forkedFrom.continuedFromProvider) return undefined;
  // The renderer may have committed a completed native fork while the session
  // was being prepared. Read that authoritative id instead of starting again.
  if (tab.sdkSessionId) return { threadId: tab.sdkSessionId };
  const messages = await readChatTranscript(
    options.projectId,
    options.worktreeId,
    options.chatId,
    true,
  );
  const boundaryId = tab.forkedFrom.atMessageId;
  const boundaryIndex = boundaryId
    ? messages.findIndex((message) => message.id === boundaryId)
    : -1;
  if (boundaryId && boundaryIndex < 0)
    throw new Error(
      'The forked conversation history is incomplete. Retry after its history is available.',
    );
  const currentIndex = options.excludeMessageId
    ? messages.findIndex((message) => message.id === options.excludeMessageId)
    : -1;
  const sourceMessages = boundaryId
    ? messages.slice(0, boundaryIndex + 1)
    : messages.slice(0, currentIndex < 0 ? undefined : currentIndex);
  // Forking a genuinely empty source requires no history transfer.
  if (!boundaryId && sourceMessages.length === 0) return undefined;
  const seedItems = persistedMessagesToCodexSeedItems(sourceMessages);
  if (seedItems.length === 0) {
    throw new Error(
      'The forked conversation could not be restored. Retry after its history is available.',
    );
  }
  return { seedItems };
}
