import type { PersistedChatMessage } from '../types';
import { sanitizePersistedChatMessageStream } from './message-sanitization';
import { isUserTurnBoundary } from './turn-boundary';

/**
 * Find in chat over a whole transcript, as one desktop chat and one cloud
 * chat both count it (CAN-6175 R12): `core.chat.transcript.search`'s result.
 */
export interface TranscriptSearchResult {
  matches: {
    /** Tool results are rendered inside their originating call message. */
    renderMessageId?: string;
    messageId: string;
    turnId: string;
    count: number;
  }[];
  totalCount: number;
}

const ROLES: ReadonlySet<unknown> = new Set(['user', 'assistant', 'system']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The persisted message shape both cores serve; anything else is dropped. */
export function isPersistedChatMessage(
  value: unknown,
): value is PersistedChatMessage {
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Literal, case-insensitive counting with the same RegExp `i` canonicalization
 * the renderer's DOM highlighter uses, so main's counts and the highlighted
 * ranges agree for characters whose `toLowerCase()` differs (İ, K, ſ).
 */
function countOccurrences(text: string, pattern: RegExp): number {
  let count = 0;
  pattern.lastIndex = 0;
  while (pattern.exec(text) !== null) count++;
  return count;
}

/** Scan canonical rows without hydrating the renderer or retaining message bodies. */
export async function searchTranscriptMessages(
  messages: AsyncIterable<PersistedChatMessage>,
  query: string,
  signal?: AbortSignal,
): Promise<TranscriptSearchResult> {
  const result: TranscriptSearchResult = { matches: [], totalCount: 0 };
  if (query.length < 2 || query.length > 256) return result;
  const pattern = new RegExp(escapeRegExp(query), 'gi');
  const toolOwners = new Map<string, string>();
  let turnId = '';
  let rows = 0;
  for await (const message of sanitizePersistedChatMessageStream(
    messages,
    signal,
  )) {
    signal?.throwIfAborted();
    if (!turnId || isUserTurnBoundary(message)) turnId = message.id;
    for (const block of message.blocks)
      if (block.type === 'tool_use')
        toolOwners.set(block.toolUseId, message.id);
    if (
      message.role === 'user' ||
      message.role === 'assistant' ||
      message.role === 'system'
    ) {
      const groups = new Map<string, number>();
      for (const block of message.blocks) {
        const text =
          block.type === 'text' || block.type === 'thinking'
            ? block.text
            : block.type === 'tool_result'
              ? block.output
              : '';
        const count = countOccurrences(text, pattern);
        if (count) {
          const owner =
            block.type === 'tool_result'
              ? (toolOwners.get(block.toolUseId) ?? message.id)
              : message.id;
          groups.set(owner, (groups.get(owner) ?? 0) + count);
        }
      }
      for (const [owner, count] of Array.from(groups)) {
        result.matches.push({
          messageId: message.id,
          turnId,
          count,
          ...(owner !== message.id ? { renderMessageId: owner } : {}),
        });
        result.totalCount += count;
      }
    }
    // Yield now and then, so a long transcript never blocks its host.
    if (++rows % 32 === 0)
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  signal?.throwIfAborted();
  return result;
}
