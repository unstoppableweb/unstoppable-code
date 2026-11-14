import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import type {
  PersistedChatBlock,
  PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import {
  extractClaudeTranscriptEventAttachments,
  projectClaudeTranscriptEventToMessage,
  stripClaudeTranscriptInlineAttachments,
} from '../integration/claude-terminal-transcript-sync';
import { isRecord } from '../lib/type-guards';
import { summarizeTitle } from './claude-discovery';

/**
 * Projects provider-native session files into Canopy's persisted chat shape
 * for the bulk project import (CAN-2439).
 *
 * - Claude Code transcripts reuse the terminal-mode projection, so an
 *   imported history renders exactly like a chat Canopy captured live.
 * - Codex rollouts project their `response_item` records: user and agent
 *   messages, tool calls with their outputs, and reasoning summaries.
 *   Provider-injected context (`<environment_context>`, developer
 *   instructions) is dropped rather than shown as user text.
 *
 * Both readers refuse files above {@link MAX_IMPORT_TRANSCRIPT_BYTES} so one
 * runaway session cannot stall the whole batch; the caller reports such a
 * session as skipped.
 */

export const MAX_IMPORT_TRANSCRIPT_BYTES = 48 * 1024 * 1024;

export interface ProjectedTranscript {
  messages: PersistedChatMessage[];
  title: string | null;
  firstTimestamp: number | null;
  /** Non-fatal problems, such as an attachment that could not be written. */
  warnings: string[];
}

export class TranscriptTooLargeError extends Error {
  constructor(
    sizeBytes: number,
    maxBytes: number = MAX_IMPORT_TRANSCRIPT_BYTES,
  ) {
    super(
      `Transcript is ${Math.round(sizeBytes / (1024 * 1024))} MB, above the ${Math.round(maxBytes / (1024 * 1024))} MB import limit`,
    );
    this.name = 'TranscriptTooLargeError';
  }
}

export interface ProjectionOptions {
  /** Override for tests; defaults to {@link MAX_IMPORT_TRANSCRIPT_BYTES}. */
  maxBytes?: number;
  /**
   * Where inline base64 image/document payloads are written, exactly as the
   * live terminal sync does. Without it those payloads are dropped rather
   * than embedded as text.
   */
  attachmentsDir?: string;
}

/**
 * Reads a JSONL transcript record by record. Streaming keeps the parse off a
 * single main-thread block: the event loop turns between chunks, so import
 * progress events still reach the renderer while a large file is read. The
 * size gate runs first so an oversized file is refused before any read.
 */
async function readJsonLines(
  filePath: string,
  maxBytes: number = MAX_IMPORT_TRANSCRIPT_BYTES,
): Promise<Record<string, unknown>[]> {
  const stats = await stat(filePath);
  if (stats.size > maxBytes) {
    throw new TranscriptTooLargeError(stats.size, maxBytes);
  }
  const records: Record<string, unknown>[] = [];
  const input = createReadStream(filePath, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isRecord(parsed)) records.push(parsed);
      } catch {
        // A crash can leave one torn trailing record; keep everything before it.
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return records;
}

function dedupeById(messages: PersistedChatMessage[]): PersistedChatMessage[] {
  const seen = new Set<string>();
  const out: PersistedChatMessage[] = [];
  for (const message of messages) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    out.push(message);
  }
  return out;
}

export function firstUserText(messages: PersistedChatMessage[]): string | null {
  for (const message of messages) {
    if (message.role !== 'user') continue;
    for (const block of message.blocks) {
      if (block.type === 'text' && block.text.trim()) {
        return summarizeTitle(block.text);
      }
    }
  }
  return null;
}

export async function projectClaudeTranscriptFile(
  filePath: string,
  options: ProjectionOptions = {},
): Promise<ProjectedTranscript> {
  const records = await readJsonLines(filePath, options.maxBytes);
  const warnings: string[] = [];
  let title: string | null = null;
  const messages: PersistedChatMessage[] = [];
  for (const record of records) {
    if (record.type === 'ai-title' && typeof record.aiTitle === 'string') {
      title ??= summarizeTitle(record.aiTitle);
      continue;
    }
    if (record.type === 'summary' && typeof record.summary === 'string') {
      title ??= summarizeTitle(record.summary);
      continue;
    }
    if (record.isSidechain === true) continue;
    const { event, attachmentPaths, hadAttachments } = options.attachmentsDir
      ? await extractAttachments(record, options.attachmentsDir, warnings)
      : stripAttachments(record);
    const message = projectClaudeTranscriptEventToMessage(event, {
      hasExtractedAttachments: hadAttachments,
    });
    if (!message) continue;
    messages.push(
      attachmentPaths.length > 0 ? { ...message, attachmentPaths } : message,
    );
  }
  const deduped = dedupeById(messages);
  return {
    messages: deduped,
    title: title ?? firstUserText(deduped),
    firstTimestamp: deduped[0]?.timestamp ?? null,
    warnings,
  };
}

interface AttachmentStep {
  event: Record<string, unknown>;
  attachmentPaths: string[];
  hadAttachments: boolean;
}

async function extractAttachments(
  record: Record<string, unknown>,
  attachmentsDir: string,
  warnings: string[],
): Promise<AttachmentStep> {
  const { event, attachmentPaths } =
    await extractClaudeTranscriptEventAttachments(
      record,
      attachmentsDir,
      warnings,
    );
  return {
    event,
    attachmentPaths,
    hadAttachments: attachmentPaths.length > 0 || event !== record,
  };
}

/**
 * Writes one inline base64 payload into `attachmentsDir` through the same
 * extractor the Claude path uses, so every imported attachment is named and
 * deduplicated the same way. Returns the written path, or `null` (with a
 * warning) when it could not be written.
 */
export async function writeInlineAttachment(
  mediaType: string,
  base64: string,
  attachmentsDir: string,
  warnings: string[],
): Promise<string | null> {
  const event = {
    message: {
      content: [
        {
          type: mediaType.startsWith('image/') ? 'image' : 'document',
          source: { type: 'base64', media_type: mediaType, data: base64 },
        },
      ],
    },
  };
  const { attachmentPaths } = await extractClaudeTranscriptEventAttachments(
    event,
    attachmentsDir,
    warnings,
  );
  return attachmentPaths[0] ?? null;
}

// Without an attachments directory a text-free image turn still projects as
// a user message (empty text, no paths) so the turn is not silently lost; the
// import flow always supplies a directory, so this is the fallback only.
function stripAttachments(record: Record<string, unknown>): AttachmentStep {
  const { event, stripped } = stripClaudeTranscriptInlineAttachments(record);
  return { event, attachmentPaths: [], hadAttachments: stripped };
}

// ---- Codex rollouts ------------------------------------------------------

const CODEX_INJECTED_CONTEXT_TAGS = [
  'environment_context',
  'user_instructions',
  'system_instruction',
  'turn_aborted',
  'permissions_instructions',
];
// Compiled once: this runs for every Codex user message of every imported
// chat. `String#replace` resets `lastIndex`, so reusing the global regexes
// across calls is safe.
const CODEX_INJECTED_CONTEXT_PATTERNS = CODEX_INJECTED_CONTEXT_TAGS.map(
  (tag) => new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, 'g'),
);

function stripInjectedCodexContext(text: string): string {
  let out = text;
  for (const pattern of CODEX_INJECTED_CONTEXT_PATTERNS) {
    out = out.replace(pattern, '');
  }
  return out.trim();
}

function codexContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      if (!isRecord(item)) return '';
      if (
        (item.type === 'input_text' ||
          item.type === 'output_text' ||
          item.type === 'text') &&
        typeof item.text === 'string'
      ) {
        return item.text;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function codexOutputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (isRecord(output)) {
    if (typeof output.content === 'string') return output.content;
    if (Array.isArray(output.content)) return codexContentText(output.content);
    if (typeof output.output === 'string') return output.output;
    return JSON.stringify(output);
  }
  return output === undefined || output === null ? '' : JSON.stringify(output);
}

function codexOutputIsError(output: unknown): boolean {
  if (!isRecord(output)) return false;
  if (typeof output.success === 'boolean') return !output.success;
  if (
    isRecord(output.metadata) &&
    typeof output.metadata.exit_code === 'number'
  ) {
    return output.metadata.exit_code !== 0;
  }
  return false;
}

function recordTimestamp(
  record: Record<string, unknown>,
  fallback: number,
): number {
  if (typeof record.timestamp === 'string') {
    const parsed = Date.parse(record.timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/** Stable message id for the `index`th message projected from `seed`. */
export function messageId(seed: string, index: number): string {
  return createHash('sha256')
    .update(`${seed}\n${index}`)
    .digest('hex')
    .slice(0, 32);
}

interface CodexProjectionState {
  messages: PersistedChatMessage[];
  toolNames: Map<string, string>;
}

function codexUserMessage(
  payload: Record<string, unknown>,
  id: string,
  timestamp: number,
): PersistedChatMessage | null {
  const text = stripInjectedCodexContext(codexContentText(payload.content));
  if (!text) return null;
  return { id, role: 'user', timestamp, blocks: [{ type: 'text', text }] };
}

function codexAssistantMessage(
  payload: Record<string, unknown>,
  id: string,
  timestamp: number,
): PersistedChatMessage | null {
  const text = codexContentText(payload.content).trim();
  if (!text) return null;
  return { id, role: 'assistant', timestamp, blocks: [{ type: 'text', text }] };
}

function codexReasoningMessage(
  payload: Record<string, unknown>,
  id: string,
  timestamp: number,
): PersistedChatMessage | null {
  const summary = Array.isArray(payload.summary)
    ? payload.summary
        .map((item) =>
          isRecord(item) && typeof item.text === 'string' ? item.text : '',
        )
        .filter(Boolean)
        .join('\n\n')
    : '';
  if (!summary.trim()) return null;
  return {
    id,
    role: 'assistant',
    timestamp,
    blocks: [{ type: 'thinking', text: summary }],
  };
}

function codexToolCallInput(payload: Record<string, unknown>): string {
  const raw =
    payload.type === 'function_call' ? payload.arguments : payload.input;
  return typeof raw === 'string' ? raw : JSON.stringify(raw ?? {});
}

function codexToolCallMessage(
  payload: Record<string, unknown>,
  id: string,
  timestamp: number,
  state: CodexProjectionState,
): PersistedChatMessage {
  const callId = typeof payload.call_id === 'string' ? payload.call_id : id;
  const name = typeof payload.name === 'string' ? payload.name : 'tool';
  state.toolNames.set(callId, name);
  const block: PersistedChatBlock = {
    type: 'tool_use',
    toolUseId: callId,
    toolName: name,
    input: codexToolCallInput(payload),
  };
  return { id, role: 'assistant', timestamp, blocks: [block] };
}

function codexToolOutputMessage(
  payload: Record<string, unknown>,
  id: string,
  timestamp: number,
  state: CodexProjectionState,
): PersistedChatMessage {
  const callId = typeof payload.call_id === 'string' ? payload.call_id : id;
  const fallbackName = typeof payload.name === 'string' ? payload.name : '';
  const block: PersistedChatBlock = {
    type: 'tool_result',
    toolUseId: callId,
    toolName: state.toolNames.get(callId) ?? fallbackName,
    output: codexOutputText(payload.output),
    isError: codexOutputIsError(payload.output),
  };
  return { id, role: 'system', timestamp, blocks: [block] };
}

function projectCodexResponseItem(
  payload: Record<string, unknown>,
  id: string,
  timestamp: number,
  state: CodexProjectionState,
): PersistedChatMessage | null {
  switch (payload.type) {
    case 'message':
      if (payload.role === 'user')
        return codexUserMessage(payload, id, timestamp);
      if (payload.role === 'assistant') {
        return codexAssistantMessage(payload, id, timestamp);
      }
      return null;
    case 'reasoning':
      return codexReasoningMessage(payload, id, timestamp);
    case 'function_call':
    case 'custom_tool_call':
      return codexToolCallMessage(payload, id, timestamp, state);
    case 'function_call_output':
    case 'custom_tool_call_output':
      return codexToolOutputMessage(payload, id, timestamp, state);
    default:
      return null;
  }
}

export function projectCodexRolloutRecords(
  records: Record<string, unknown>[],
  seed: string,
): ProjectedTranscript {
  const state: CodexProjectionState = { messages: [], toolNames: new Map() };
  let lastTimestamp = Date.now();
  records.forEach((record, index) => {
    if (record.type !== 'response_item' || !isRecord(record.payload)) return;
    const timestamp = recordTimestamp(record, lastTimestamp);
    lastTimestamp = timestamp;
    const message = projectCodexResponseItem(
      record.payload,
      messageId(seed, index + 1),
      timestamp,
      state,
    );
    if (message) state.messages.push(message);
  });
  const deduped = dedupeById(state.messages);
  return {
    messages: deduped,
    title: firstUserText(deduped),
    firstTimestamp: deduped[0]?.timestamp ?? null,
    warnings: [],
  };
}

export async function projectCodexRolloutFile(
  filePath: string,
  options: ProjectionOptions = {},
): Promise<ProjectedTranscript> {
  return projectCodexRolloutRecords(
    await readJsonLines(filePath, options.maxBytes),
    filePath,
  );
}
