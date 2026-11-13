import type { JsonValue } from './generated/serde_json/JsonValue';
import type { DynamicToolCallOutputContentItem } from './generated/v2/DynamicToolCallOutputContentItem';
import type { ThreadItem } from './generated/v2/ThreadItem';
import { codexAsyncQuestionText } from '@canopy/agent-transcript/lib/codex-tool-images';

/** Upgrade gate: every generated item requires a deliberate display decision. */
export const CODEX_THREAD_ITEM_DISPOSITIONS = {
  userMessage: 'host-input',
  hookPrompt: 'host-input',
  agentMessage: 'display',
  functionCallOutput: 'display',
  plan: 'display',
  reasoning: 'display',
  commandExecution: 'display',
  fileChange: 'display',
  mcpToolCall: 'display',
  dynamicToolCall: 'display',
  collabAgentToolCall: 'display',
  subAgentActivity: 'display',
  webSearch: 'display',
  imageView: 'agent-input',
  sleep: 'deferred',
  imageGeneration: 'display',
  enteredReviewMode: 'display',
  exitedReviewMode: 'display',
  contextCompaction: 'display',
} satisfies Record<
  ThreadItem['type'],
  'display' | 'host-input' | 'agent-input' | 'deferred'
>;

export interface CodexThreadItemProjectionOptions {
  transformCommandOutput?: (output: string) => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readBoolean(
  record: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
}

function readStringArray(
  record: Record<string, unknown>,
  key: string,
): string[] {
  const value = record[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function parseJsonValue(value: unknown): JsonValue | undefined {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (const entry of value) {
      const parsed = parseJsonValue(entry);
      if (parsed === undefined) {
        return undefined;
      }
      result.push(parsed);
    }
    return result;
  }
  if (isRecord(value)) {
    const result: { [key in string]?: JsonValue } = {};
    for (const [key, entry] of Object.entries(value)) {
      const parsed = parseJsonValue(entry);
      if (parsed === undefined) {
        return undefined;
      }
      result[key] = parsed;
    }
    return result;
  }
  return undefined;
}

function parseDynamicToolCallOutputContentItems(
  value: unknown,
): DynamicToolCallOutputContentItem[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const contentItems: DynamicToolCallOutputContentItem[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    if (item.type === 'inputText' && typeof item.text === 'string') {
      contentItems.push({ type: 'inputText', text: item.text });
      continue;
    }
    if (item.type === 'inputImage' && typeof item.imageUrl === 'string') {
      contentItems.push({ type: 'inputImage', imageUrl: item.imageUrl });
      continue;
    }
    if (item.type === 'inputAudio' && typeof item.audioUrl === 'string') {
      contentItems.push({ type: 'inputAudio', audioUrl: item.audioUrl });
      continue;
    }
    contentItems.push({
      type: 'inputText',
      text: '[unsupported output omitted]',
    });
  }
  return contentItems;
}

function parseFileChanges(
  value: unknown,
): Array<{ path: string; kind: string; movePath?: string }> {
  if (!Array.isArray(value)) {
    return [];
  }

  const changes: Array<{ path: string; kind: string; movePath?: string }> = [];
  for (const changeValue of value) {
    if (!isRecord(changeValue)) {
      continue;
    }
    const path = readString(changeValue, 'path');
    const kindRecord = isRecord(changeValue.kind)
      ? changeValue.kind
      : undefined;
    const kind = kindRecord ? readString(kindRecord, 'type') : undefined;
    if (path && kind) {
      const movePath = kindRecord
        ? (readString(kindRecord, 'move_path') ??
          readString(kindRecord, 'movePath'))
        : undefined;
      changes.push({ path, kind, ...(movePath ? { movePath } : {}) });
    }
  }
  return changes;
}

function parseCollabAgentsStates(
  value: unknown,
): Record<string, { status: string; message: string | null }> | null {
  if (!isRecord(value)) {
    return null;
  }

  const result: Record<string, { status: string; message: string | null }> = {};
  for (const [threadId, raw] of Object.entries(value)) {
    if (!isRecord(raw)) {
      return null;
    }
    const status = readString(raw, 'status');
    if (!status || (typeof raw.message !== 'string' && raw.message !== null)) {
      return null;
    }
    result[threadId] = {
      status,
      message: typeof raw.message === 'string' ? raw.message : null,
    };
  }
  return result;
}

function projectCollabAgentToolCall(
  item: Record<string, unknown>,
  itemId: string,
): Record<string, unknown> | null {
  const tool = readString(item, 'tool');
  const status = readString(item, 'status');
  const senderThreadId = readString(item, 'senderThreadId');
  if (
    !tool ||
    !status ||
    !senderThreadId ||
    !Array.isArray(item.receiverThreadIds) ||
    !item.receiverThreadIds.every(
      (threadId): threadId is string => typeof threadId === 'string',
    )
  ) {
    return null;
  }
  const agentsStates = parseCollabAgentsStates(item.agentsStates);
  if (!agentsStates) {
    return null;
  }

  return {
    type: 'collab_agent_tool_call',
    id: itemId,
    tool,
    status,
    sender_thread_id: senderThreadId,
    receiver_thread_ids: item.receiverThreadIds,
    prompt: typeof item.prompt === 'string' ? item.prompt : '',
    agents_states: agentsStates,
    ...(typeof item.model === 'string' ? { model: item.model } : {}),
    ...(typeof item.reasoningEffort === 'string'
      ? { reasoning_effort: item.reasoningEffort }
      : {}),
  };
}

/**
 * Project an app-server thread item into the provider-neutral Codex JSONL
 * shape shared by interactive chat and pipeline transcript consumers.
 */
export function projectCodexThreadItem(
  value: unknown,
  options: CodexThreadItemProjectionOptions = {},
): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }
  const itemType = readString(value, 'type');
  const itemId = readString(value, 'id');
  if (!itemType || !itemId) {
    return null;
  }

  switch (itemType) {
    case 'agentMessage':
      return {
        type: 'agent_message',
        id: itemId,
        // The text already contains the questions as a fallback for clients
        // without structured question controls. These are two representations
        // of the same item, not two assistant messages.
        text:
          readString(value, 'text') || codexAsyncQuestionText(value.questions),
        phase: readString(value, 'phase') ?? '',
        ...(value.delivery === 'async'
          ? { delivery: 'async', questions: value.questions }
          : {}),
      };
    case 'reasoning':
      return {
        type: 'reasoning',
        id: itemId,
        text:
          readStringArray(value, 'content').join('\n') ||
          readStringArray(value, 'summary').join('\n'),
      };
    case 'commandExecution': {
      const output = readString(value, 'aggregatedOutput') ?? '';
      return {
        type: 'command_execution',
        id: itemId,
        command: readString(value, 'command') ?? '',
        aggregated_output: options.transformCommandOutput?.(output) ?? output,
        status: readString(value, 'status') ?? '',
        exit_code: readNumber(value, 'exitCode') ?? null,
      };
    }
    case 'fileChange':
      return {
        type: 'file_change',
        id: itemId,
        status: readString(value, 'status') ?? '',
        changes: parseFileChanges(value.changes),
      };
    case 'mcpToolCall':
      return {
        type: 'mcp_tool_call',
        id: itemId,
        server: readString(value, 'server') ?? '',
        tool: readString(value, 'tool') ?? '',
        status: readString(value, 'status') ?? '',
        arguments: parseJsonValue(value.arguments ?? null) ?? null,
        result: parseJsonValue(value.result ?? null) ?? null,
        error: parseJsonValue(value.error ?? null) ?? null,
      };
    case 'webSearch':
      return {
        type: 'web_search',
        id: itemId,
        query: readString(value, 'query') ?? '',
        ...(isRecord(value.action)
          ? { action: parseJsonValue(value.action) }
          : {}),
        status: value.action ? 'completed' : 'in_progress',
      };
    case 'imageGeneration': {
      const savedPath = readString(value, 'savedPath');
      const revisedPrompt = readString(value, 'revisedPrompt');
      return {
        type: 'image_generation',
        id: itemId,
        status: readString(value, 'status') ?? '',
        ...(revisedPrompt ? { revised_prompt: revisedPrompt } : {}),
        ...(savedPath ? { saved_path: savedPath } : {}),
      };
    }
    case 'imageView':
      return {
        type: 'image_view',
        id: itemId,
        path: readString(value, 'path') ?? '',
      };
    case 'plan':
      return {
        type: 'plan',
        id: itemId,
        text: readString(value, 'text') ?? '',
      };
    case 'functionCallOutput':
      return {
        type: 'function_call_output',
        id: itemId,
        name: readString(value, 'name') ?? '',
        namespace: readString(value, 'namespace') ?? null,
        output: parseJsonValue(value.output) ?? null,
      };
    case 'enteredReviewMode':
    case 'exitedReviewMode':
      return {
        type:
          itemType === 'enteredReviewMode'
            ? 'entered_review_mode'
            : 'exited_review_mode',
        id: itemId,
        review: readString(value, 'review') ?? '',
      };
    case 'subAgentActivity':
      return {
        type: 'sub_agent_activity',
        id: itemId,
        kind: readString(value, 'kind') ?? '',
        agent_thread_id: readString(value, 'agentThreadId') ?? '',
        agent_path: readString(value, 'agentPath') ?? '',
      };
    case 'dynamicToolCall':
      return {
        type: 'dynamic_tool_call',
        id: itemId,
        namespace: readString(value, 'namespace') ?? null,
        tool: readString(value, 'tool') ?? '',
        arguments: Object.prototype.hasOwnProperty.call(value, 'arguments')
          ? (parseJsonValue(value.arguments ?? null) ?? null)
          : null,
        status: readString(value, 'status') ?? '',
        content_items: parseDynamicToolCallOutputContentItems(
          value.contentItems,
        ),
        success: readBoolean(value, 'success') ?? null,
      };
    case 'collabAgentToolCall':
      return projectCollabAgentToolCall(value, itemId);
    case 'contextCompaction':
      return {
        type: 'context_compaction',
        id: itemId,
      };
    default:
      return null;
  }
}
