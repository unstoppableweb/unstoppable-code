import {
  bindCloudChatThread,
  type CloudChatThread,
  type CloudChatThreadTarget,
  type ProjectCloudChatMessages,
} from '@canopy/app-state/core-cowork';
import type { ChatStoreState } from '@canopy/app-state';
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import { projectAgentTaskTranscript } from '@canopy/agent-transcript/agent-tasks';
import { projectPersistedChatTranscript } from '@canopy/desktop-shared/portal/persisted-chat-projection';
import { createRelayCoreCoworkInvoker } from './relay-invoker';

/** Open cloud chats kept streaming, so switching back needs no re-read. */
export const CLOUD_CHAT_THREAD_LIMIT = 8;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const ROLES: ReadonlySet<unknown> = new Set(['user', 'assistant', 'system']);

/** The persisted message shape both cores serve; anything else is dropped. */
function isPersistedChatMessage(value: unknown): value is PersistedChatMessage {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    ROLES.has(value.role) &&
    typeof value.timestamp === 'number' &&
    Array.isArray(value.blocks) &&
    value.blocks.every(
      (block) => isRecord(block) && typeof block.type === 'string',
    )
  );
}

export const projectCloudChatMessages: ProjectCloudChatMessages = ({
  chatKey,
  messages,
  tasks,
}) =>
  // Subagent rows nest into their spawn call's card (CAN-5976).
  projectAgentTaskTranscript({
    messages: messages.filter(isPersistedChatMessage),
    tasks,
    project: (rows) =>
      projectPersistedChatTranscript({
        scope: 'worktree',
        chatId: chatKey,
        messages: [...rows],
        // This renderer shows the transcript itself: nothing truncated.
        fidelity: 'local',
      }),
  });

interface ChatStoreHandle {
  getState(): ChatStoreState;
}

/** Bound threads, least recently opened first, with the store each writes to. */
const threads = new Map<
  string,
  { readonly thread: CloudChatThread; readonly store: ChatStoreHandle }
>();

/**
 * The thread for `target`, bound once and kept in a small LRU. Evicting a
 * thread ends its stream and drops it from the shared store.
 */
export function retainCloudChatThread(
  target: CloudChatThreadTarget,
  chatStore: ChatStoreHandle,
): CloudChatThread | null {
  if (typeof window === 'undefined' || !window.canopyCore) return null;
  const existing = threads.get(target.key);
  if (
    existing &&
    existing.store === chatStore &&
    existing.thread.target.workspaceId === target.workspaceId &&
    existing.thread.target.worktreeId === target.worktreeId
  ) {
    threads.delete(target.key);
    threads.set(target.key, existing);
    return existing.thread;
  }
  existing?.thread.close();
  threads.delete(target.key);
  const thread = bindCloudChatThread({
    invoker: createRelayCoreCoworkInvoker(window.canopyCore),
    target,
    chatStore,
    project: projectCloudChatMessages,
  });
  threads.set(target.key, { thread, store: chatStore });
  for (const [key, oldest] of threads) {
    if (threads.size <= CLOUD_CHAT_THREAD_LIMIT) break;
    oldest.thread.close();
    threads.delete(key);
  }
  return thread;
}

/** Ends every cloud chat thread: the web core went offline or was turned off. */
export function closeAllCloudChatThreads(): void {
  const open = [...threads.values()];
  threads.clear();
  for (const { thread } of open) thread.close();
}
