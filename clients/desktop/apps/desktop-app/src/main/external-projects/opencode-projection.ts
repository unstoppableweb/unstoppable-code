import type {
  PersistedChatBlock,
  PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import { isRecord } from '../lib/type-guards';
import {
  firstUserText,
  messageId,
  writeInlineAttachment,
  type ProjectedTranscript,
} from './chat-projection';
import type { OpenCodeMessageRow } from './opencode-store';

/**
 * Projects an OpenCode session's `session_message` rows into Canopy's
 * persisted chat shape, with the same blocks the Codex projection writes:
 * user text, assistant text, reasoning as a collapsed thinking block, and
 * tool calls with their results. A completed context compaction becomes a
 * system note carrying its summary. User files that are inline data URLs are
 * written through the Claude attachment extractor; anything else is named in
 * a note rather than fetched.
 */

export interface OpenCodeProjectionOptions {
  /** The destination chat's attachments directory. */
  attachmentsDir: string;
}

const DATA_URL = /^data:([^;,]*)(?:;[^;,]*)*;base64,(.+)$/s;

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function rowTime(row: OpenCodeMessageRow, fallback: number): number {
  const time = row.data.time;
  if (isRecord(time) && typeof time.created === 'number') return time.created;
  return row.timeCreated > 0 ? row.timeCreated : fallback;
}

function single(
  id: string,
  role: PersistedChatMessage['role'],
  timestamp: number,
  block: PersistedChatBlock,
): PersistedChatMessage {
  return { id, role, timestamp, blocks: [block] };
}

async function userMessage(
  row: OpenCodeMessageRow,
  timestamp: number,
  options: OpenCodeProjectionOptions,
  warnings: string[],
): Promise<PersistedChatMessage | null> {
  const attachmentPaths: string[] = [];
  const unavailable: string[] = [];
  const files = Array.isArray(row.data.files) ? row.data.files : [];
  for (const file of files) {
    if (!isRecord(file)) continue;
    const mime = nonEmpty(file.mime) ?? nonEmpty(file.mediaType);
    const url = typeof file.url === 'string' ? file.url : '';
    const inline = DATA_URL.exec(url);
    const written = inline
      ? await writeInlineAttachment(
          mime ?? inline[1] ?? '',
          inline[2] ?? '',
          options.attachmentsDir,
          warnings,
        )
      : null;
    if (written) attachmentPaths.push(written);
    else
      unavailable.push(
        `Attachment unavailable: ${nonEmpty(file.filename) ?? nonEmpty(file.name) ?? mime ?? 'file'}`,
      );
  }
  const text = [nonEmpty(row.data.text)?.trim() ?? '', ...unavailable]
    .filter(Boolean)
    .join('\n');
  if (!text && attachmentPaths.length === 0) return null;
  return {
    id: messageId(row.id, 0),
    role: 'user',
    timestamp,
    blocks: [{ type: 'text', text }],
    ...(attachmentPaths.length > 0 ? { attachmentPaths } : {}),
  };
}

function toolErrorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (isRecord(error) && typeof error.message === 'string')
    return error.message;
  return error === undefined ? '' : JSON.stringify(error);
}

function toolContentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((part) =>
      isRecord(part) && part.type === 'text' && typeof part.text === 'string'
        ? part.text
        : '',
    )
    .filter(Boolean)
    .join('\n');
}

/** The messages one `content[]` item renders as; an incomplete item renders as none. */
function contentMessages(
  item: unknown,
  id: (index: number) => string,
  timestamp: number,
): PersistedChatMessage[] {
  if (!isRecord(item)) return [];
  if (item.type === 'text') {
    const text = nonEmpty(item.text)?.trim();
    return text
      ? [single(id(0), 'assistant', timestamp, { type: 'text', text })]
      : [];
  }
  if (item.type === 'reasoning') {
    const text = nonEmpty(item.text);
    return text
      ? [single(id(0), 'assistant', timestamp, { type: 'thinking', text })]
      : [];
  }
  if (item.type !== 'tool') return [];
  const toolName = nonEmpty(item.name);
  const state = item.state;
  if (!toolName || !isRecord(state)) return [];
  const toolUseId = nonEmpty(item.id) ?? id(0);
  const input =
    typeof state.input === 'string'
      ? state.input
      : JSON.stringify(state.input ?? {});
  const use = single(id(0), 'assistant', timestamp, {
    type: 'tool_use',
    toolUseId,
    toolName,
    input,
  });
  if (state.status === 'completed' || state.status === 'error') {
    const isError = state.status === 'error';
    return [
      use,
      single(id(1), 'system', timestamp, {
        type: 'tool_result',
        toolUseId,
        toolName,
        output: isError
          ? toolErrorText(state.error)
          : toolContentText(state.content),
        isError,
      }),
    ];
  }
  // Still streaming or running when the store was copied: the call, no result.
  return [use];
}

export async function projectOpenCodeSession(
  rows: OpenCodeMessageRow[],
  options: OpenCodeProjectionOptions,
): Promise<ProjectedTranscript> {
  const warnings: string[] = [];
  const messages: PersistedChatMessage[] = [];
  let clock = Date.now();
  for (const row of rows) {
    const timestamp = rowTime(row, clock);
    clock = timestamp;
    if (row.type === 'user') {
      const message = await userMessage(row, timestamp, options, warnings);
      if (message) messages.push(message);
    } else if (row.type === 'assistant') {
      const content = Array.isArray(row.data.content) ? row.data.content : [];
      content.forEach((item, index) => {
        messages.push(
          ...contentMessages(
            item,
            (part) => messageId(row.id, index * 2 + part),
            timestamp,
          ),
        );
      });
    } else if (row.type === 'compaction') {
      const summary = nonEmpty(row.data.summary);
      if (row.data.status === 'completed' && summary) {
        messages.push(
          single(messageId(row.id, 0), 'system', timestamp, {
            type: 'text',
            text: `Context summary: ${summary.trim()}`,
          }),
        );
      }
    }
  }
  return {
    messages,
    title: firstUserText(messages),
    firstTimestamp: messages[0]?.timestamp ?? null,
    warnings,
  };
}
