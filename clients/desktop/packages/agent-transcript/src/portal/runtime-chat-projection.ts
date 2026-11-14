/**
 * Live projection of raw desktop provider events (`chat:event` payloads) into
 * canonical whole Portal messages. Browser-safe: Electron main, the desktop
 * renderer, the portable CanopyClient adapter and hosted clients share it.
 *
 * The tool-family bucket stamped on `tool_use` parts is injected through
 * {@link RuntimeChatProjectionInput.toolFamilyFor}: the desktop passes its full
 * `getPortalChatToolFamily` (through the `@canopy/desktop-shared` re-export,
 * so its output is unchanged), and a host without a resolver leaves
 * `toolFamily` unset.
 */
import type { AgentArtifactReceiptV1 } from '@canopy/protocol/agent-artifacts';
import {
  extractCanonicalAgentArtifacts,
  MAX_AGENT_ARTIFACT_METADATA_BYTES,
} from '@canopy/protocol/agent-artifacts';
import { isAgentDelegationTranscript } from '@canopy/protocol/delegation';
import {
  readPortalToolOccurrence,
  readPortalToolOutputLocator,
} from '@canopy/protocol/portal';
import { isClaudeAiCreditsFallbackErrorCode } from '@canopy/protocol/llm-gateway';
import {
  CANOPY_MODEL_ACCESS_FAILURE_FIELD,
  readCodexAccountModelAccessFailure,
} from '@canopy/protocol/auth-recovery';
import type {
  PortalChatMessage,
  PortalChatPart,
  PortalChatToolFamily,
} from '@canopy/protocol/portal';
import {
  CANOPY_ACCOUNT_PROXY_SWITCH_EVENT_TYPE,
  CANOPY_CLAUDE_MODS_SKIPPED_EVENT_TYPE,
  type PersistedChatMessage,
} from '../types';
import {
  applyClaudeTranscriptEvent,
  createEmptyTranscriptReducerState,
} from '../lib/transcript-parser';
import { delegationTranscriptMessages } from '../lib/delegation-transcript';
import {
  codexMcpToolName,
  previewCodexMcpToolResult,
} from '../lib/codex-mcp-tool-results';
import { previewCodexDynamicToolContent } from '../lib/codex-dynamic-tool-results';
import { stripMemoryCitationTags } from '../lib/memory-citation';
import { applyAssistantPatches } from '../lib/assistant-snapshot';
import { isProviderUsageLimitFrame } from './provider-usage-limit';
import {
  PORTAL_CHAT_PART_TEXT_MAX_CHARS,
  PORTAL_CHAT_TEXT_MAX_CHARS,
  deriveRuntimeChatMessageId,
  isRecord,
  summarizeUnknown,
  truncateText,
  truncateToolInput,
  type ToolFamilyResolver,
} from './persisted-chat-projection';
import { persistedMessageToPortalWireMessage } from './portal-wire-message';

/** `toolFamily` for a `tool_use` part, or nothing when no resolver is set. */
function toolFamilyField(
  toolFamilyFor: ToolFamilyResolver | undefined,
  toolName: string,
): { toolFamily?: PortalChatToolFamily } {
  return toolFamilyFor ? { toolFamily: toolFamilyFor(toolName) } : {};
}

function runtimeReceiptMetadata(
  output: string,
  isError: boolean,
  budget = { remaining: MAX_AGENT_ARTIFACT_METADATA_BYTES },
): { agentArtifacts?: AgentArtifactReceiptV1[] } {
  if (isError) return {};
  const receipts = extractCanonicalAgentArtifacts(output);
  if (!receipts.length) return {};
  const bytes = new TextEncoder().encode(JSON.stringify(receipts)).byteLength;
  if (bytes > budget.remaining) return {};
  budget.remaining -= bytes;
  return { agentArtifacts: receipts };
}

function readString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === 'string' ? field : undefined;
}

const NON_MESSAGE_RUNTIME_CHAT_EVENT_TYPES = new Set([
  'canopy_ai_credits_routing',
  // Historical one-way archive request retained for persisted transcript
  // projection; new runtime events use canopy_set_auto_archive_requested.
  'canopy_archive_chat_requested',
  // Cursor streams incremental patches against one assistant message, never
  // a self-contained message; a stateless projection of one patch is a blank
  // row. Hosts fold them through `createCursorAssistantPatchProjector`.
  'canopy_assistant_patch',
  // Cursor reported usage is composer banner state, mirrored via the chat
  // summary, not a transcript row.
  'canopy_cursor_usage',
  'canopy_opencode_usage',
  'canopy_turn_usage',
  'canopy_set_auto_archive_requested',
  'canopy_usage_limit_reached',
  'canopy_user_prompt',
  'claude_terminal_transcript_sync',
  'phase',
  'system',
  'thread.started',
  'turn_diff',
  'turn.started',
]);

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (!isRecord(block)) return '';
      if (typeof block.text === 'string') return block.text;
      if (typeof block.content === 'string') return block.content;
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    return summarizeUnknown(content, PORTAL_CHAT_PART_TEXT_MAX_CHARS);
  }
  return content
    .map((entry) => {
      if (isRecord(entry) && typeof entry.text === 'string') return entry.text;
      return summarizeUnknown(entry, PORTAL_CHAT_PART_TEXT_MAX_CHARS);
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * SDK `TerminalReason` values that end a turn by intent rather than by failure.
 * The Claude SDK yields these on a `result` carrying `is_error: true`, so the
 * error flag alone cannot tell a real provider failure from a deliberate stop.
 *
 * `aborted_tools` is the one plan mode rides: `canUseTool` answers
 * `ExitPlanMode` with `behavior: 'deny', interrupt: true`
 * (`claude-session.ts`) so the plan routes into Canopy's own review UI.
 * `aborted_streaming` is the user pressing Stop.
 *
 * NOTE: keep in sync with the duplicates in `main/lib/chat-turn-audit.ts` and
 * the renderer's `stores/chat/turn-events.ts`. Those two already classified
 * both reasons as interrupts, which is why desktop showed the plan while the
 * portal — projecting through this module — claimed "Agent run failed"
 * (CAN-3019). They live in separate process bundles, so a shared import is not
 * appropriate here.
 */
const USER_ABORT_TERMINAL_REASONS = ['aborted_streaming', 'aborted_tools'];

function runtimeStatus(
  data: Record<string, unknown>,
): PortalChatMessage['status'] {
  const type = readString(data, 'type');
  // Check the abort reason BEFORE the error branch: a gracefully-yielded abort
  // sets `is_error: true` and would otherwise read as a failure. Abort reasons
  // only ever arrive on `result` events, so guard on the type — a future frame
  // that happens to carry a matching string must not launder a real failure.
  const terminalReason = readString(data, 'terminal_reason');
  if (
    type === 'result' &&
    terminalReason !== undefined &&
    USER_ABORT_TERMINAL_REASONS.includes(terminalReason)
  ) {
    return 'cancelled';
  }
  if (type === 'error' || data.is_error === true || type === 'turn.failed') {
    return 'failed';
  }
  if (type === 'cancelled' || type === 'turn.cancelled') return 'cancelled';
  return 'complete';
}

function runtimeMessageId(
  data: Record<string, unknown>,
  parts: PortalChatPart[],
  fallbackMessageId: string | undefined,
): string | undefined {
  const toolResult = parts.find((part) => part.kind === 'tool_result');
  const toolUseId = toolResult
    ? readString(toolResult.data, 'toolUseId')
    : undefined;
  return deriveRuntimeChatMessageId(data, toolUseId) ?? fallbackMessageId;
}

function runtimeText(data: Record<string, unknown>): string {
  const direct =
    readString(data, 'text') ??
    readString(data, 'delta') ??
    readString(data, 'result') ??
    readString(data, 'message');
  const message = data.message;
  // Truthy fallthrough: an empty-string direct field falls through to the
  // structured message/data content, matching the pre-strip semantics. The
  // bare `error` code (an SDK enum member like `billing_error`) is the LAST
  // resort: an errored frame that carries real text must show that text, not
  // have it replaced by the code (CAN-2601).
  const raw =
    direct ||
    (isRecord(message)
      ? textFromContent(message.content)
      : textFromContent(data.content)) ||
    readString(data, 'error') ||
    '';
  // Only sanitize model-authored assistant text; error and cancellation
  // surfaces pass through so literal citation syntax in them stays visible.
  const visible =
    runtimeStatus(data) === 'complete' ? stripMemoryCitationTags(raw) : raw;
  return truncateText(visible, PORTAL_CHAT_TEXT_MAX_CHARS);
}

/** Structural admission port: no desktop-main dependency in the projector. */
export interface RuntimeToolAdmission {
  readonly revision: number;
  readonly tools: readonly {
    readonly sourceToken: string;
    readonly occurrenceId: string;
    /** Retained mappings keep their own admission frontier. */
    readonly revision?: number;
    readonly result?: {
      readonly rowId: string;
      readonly blockOrdinal: number;
      readonly needsRead: boolean;
    };
  }[];
}

function stampRuntimeToolPart(
  part: PortalChatPart,
  token: string,
  admission: RuntimeToolAdmission | undefined,
): PortalChatPart {
  const mapping = admission?.tools.find((tool) => tool.sourceToken === token);
  if (!mapping || !admission) return part;
  const occurrence = readPortalToolOccurrence({
    id: mapping.occurrenceId,
    revision: mapping.revision ?? admission.revision,
  });
  if (!occurrence) return part;
  const outputLocator =
    mapping.result?.needsRead === true
      ? readPortalToolOutputLocator({
          messageId: mapping.result.rowId,
          blockOrdinal: mapping.result.blockOrdinal,
          field: 'output',
        })
      : undefined;
  return {
    ...part,
    occurrence,
    ...(outputLocator && part.kind === 'tool_result' ? { outputLocator } : {}),
    ...(outputLocator &&
    part.kind === 'tool_use' &&
    isRecord(part.data) &&
    isRecord(part.data.result)
      ? {
          data: {
            ...part.data,
            result: { ...part.data.result, outputLocator },
          },
        }
      : {}),
  };
}

function runtimeParts(
  data: Record<string, unknown>,
  toolFamilyFor: ToolFamilyResolver | undefined,
  admission?: RuntimeToolAdmission,
): PortalChatPart[] {
  const receiptBudget = { remaining: MAX_AGENT_ARTIFACT_METADATA_BYTES };
  const message = isRecord(data.message) ? data.message : null;
  const content = Array.isArray(message?.content)
    ? message.content
    : Array.isArray(data.content)
      ? data.content
      : [];
  const parts: PortalChatPart[] = [];

  for (let index = 0; index < content.length; index += 1) {
    const block: unknown = content[index];
    if (!isRecord(block)) continue;
    if (block.type === 'thinking') {
      // Thinking is model output; tool inputs/results below pass through
      // unsanitized so literal citation syntax in tool data stays intact.
      parts.push({
        kind: 'thinking',
        data: {
          text: truncateText(
            stripMemoryCitationTags(
              readString(block, 'thinking') ?? readString(block, 'text') ?? '',
            ),
            PORTAL_CHAT_PART_TEXT_MAX_CHARS,
          ),
        },
      });
      continue;
    }
    if (block.type === 'tool_use') {
      // Provider inputs are parsed JSON objects; serialize them whole so the
      // bound below can keep short fields (a title or path) valid.
      const input =
        typeof block.input === 'string'
          ? block.input
          : isRecord(block.input)
            ? JSON.stringify(block.input)
            : summarizeUnknown(
                block.input ?? {},
                PORTAL_CHAT_PART_TEXT_MAX_CHARS,
              );
      const toolName = readString(block, 'name') ?? 'unknown';
      parts.push(
        stampRuntimeToolPart(
          {
            kind: 'tool_use',
            ...toolFamilyField(toolFamilyFor, toolName),
            data: {
              toolUseId: readString(block, 'id') ?? '',
              toolName,
              input: truncateToolInput(input, PORTAL_CHAT_PART_TEXT_MAX_CHARS),
            },
          },
          String(index),
          admission,
        ),
      );
      continue;
    }
    if (block.type === 'tool_result') {
      parts.push(
        stampRuntimeToolPart(
          {
            kind: 'tool_result',
            data: {
              toolUseId: readString(block, 'tool_use_id') ?? '',
              ...runtimeReceiptMetadata(
                toolResultText(block.content),
                block.is_error === true,
                receiptBudget,
              ),
              output: truncateText(
                toolResultText(block.content),
                PORTAL_CHAT_PART_TEXT_MAX_CHARS,
              ),
              isError: block.is_error === true,
            },
          },
          String(index),
          admission,
        ),
      );
    }
  }

  return parts.filter((part) => {
    if (part.kind !== 'thinking') return true;
    const partData = isRecord(part.data) ? part.data : {};
    return typeof partData.text === 'string' && partData.text.length > 0;
  });
}

function runtimeCodexMessage(input: {
  chatId: string;
  data: Record<string, unknown>;
  toolFamilyFor: ToolFamilyResolver | undefined;
}): PortalChatMessage | null {
  const event = isRecord(input.data.event) ? input.data.event : null;
  if (!event) return null;

  const eventType = readString(event, 'type');
  const item = isRecord(event.item) ? event.item : null;
  if (
    !item ||
    (eventType !== 'item.started' &&
      eventType !== 'item.updated' &&
      eventType !== 'item.completed')
  )
    return null;

  const itemId = readString(item, 'id');
  const itemType = readString(item, 'type');
  if (!itemId || !itemType) return null;

  const now = Date.now();
  if (itemType === 'dynamic_tool_call' || itemType === 'mcp_tool_call') {
    // Share identities and result normalization with durable Codex history so
    // hydration replaces the live row instead of introducing another call.
    const toolUseId = `codex-${itemId}`;
    const status = readString(item, 'status') ?? '';
    const dynamic = itemType === 'dynamic_tool_call';
    const toolName = dynamic
      ? (readString(item, 'tool') ?? 'unknown')
      : codexMcpToolName(
          readString(item, 'server') ?? '',
          readString(item, 'tool') ?? '',
        );
    const completed =
      eventType === 'item.completed' ||
      status === 'completed' ||
      status === 'failed';
    const parts: PortalChatPart[] = [
      {
        kind: 'tool_use',
        ...toolFamilyField(input.toolFamilyFor, toolName),
        data: {
          toolUseId,
          toolName,
          input: truncateText(
            JSON.stringify(item.arguments ?? {}),
            PORTAL_CHAT_PART_TEXT_MAX_CHARS,
          ),
        },
      },
    ];
    if (completed) {
      const result = dynamic
        ? {
            output: previewCodexDynamicToolContent({
              contentItems: item.content_items,
              success: typeof item.success === 'boolean' ? item.success : null,
            }),
            isError: item.success === false || status === 'failed',
          }
        : previewCodexMcpToolResult({
            status,
            result: item.result,
            error: item.error,
          });
      parts.push({
        kind: 'tool_result',
        data: {
          toolUseId,
          ...runtimeReceiptMetadata(result.output, result.isError),
          output: truncateText(result.output, PORTAL_CHAT_PART_TEXT_MAX_CHARS),
          isError: result.isError,
        },
      });
    }
    return {
      messageId: toolUseId,
      chatId: input.chatId,
      role: 'system',
      status: completed ? 'complete' : 'streaming',
      text: '',
      parts,
      createdAtMs: now,
      updatedAtMs: now,
    };
  }

  if (eventType !== 'item.completed') return null;
  if (itemType === 'reasoning') {
    const text =
      readString(item, 'text') ?? readString(item, 'summary_text') ?? '';
    if (!text.trim()) return null;
    return {
      messageId: `codex-${itemId}`,
      chatId: input.chatId,
      role: 'assistant',
      status: 'complete',
      text: '',
      parts: [
        {
          kind: 'thinking',
          data: {
            text: truncateText(
              stripMemoryCitationTags(text),
              PORTAL_CHAT_PART_TEXT_MAX_CHARS,
            ),
          },
        },
      ],
      createdAtMs: now,
      updatedAtMs: now,
    };
  }

  if (itemType === 'agent_message' || itemType === 'plan') {
    const text = readString(item, 'text') ?? '';
    if (!text.trim()) return null;
    return {
      messageId: `codex-${itemId}`,
      chatId: input.chatId,
      role: 'assistant',
      status: 'complete',
      text: truncateText(
        stripMemoryCitationTags(text),
        PORTAL_CHAT_TEXT_MAX_CHARS,
      ),
      createdAtMs: now,
      updatedAtMs: now,
    };
  }

  if (itemType === 'command_execution') {
    const status = readString(item, 'status') ?? '';
    const exitCode =
      typeof item.exit_code === 'number' ? item.exit_code : undefined;
    const output = readString(item, 'aggregated_output') ?? '';
    const toolName = 'command';
    // Durable Codex history names the call the same way, so a live row and
    // its hydrated copy share one call identity.
    const toolUseId = `codex-${itemId}`;
    return {
      messageId: toolUseId,
      chatId: input.chatId,
      role: 'assistant',
      status: 'complete',
      text: '',
      parts: [
        {
          kind: 'tool_use',
          ...toolFamilyField(input.toolFamilyFor, toolName),
          data: {
            toolUseId,
            toolName,
            input: truncateText(
              readString(item, 'command') ?? '',
              PORTAL_CHAT_PART_TEXT_MAX_CHARS,
            ),
          },
        },
        {
          kind: 'tool_result',
          data: {
            toolUseId,
            ...runtimeReceiptMetadata(
              output,
              status === 'failed' || (exitCode !== undefined && exitCode !== 0),
            ),
            output: truncateText(
              output.length > 0
                ? output
                : status === 'completed'
                  ? 'Done'
                  : status,
              PORTAL_CHAT_PART_TEXT_MAX_CHARS,
            ),
            isError:
              status === 'failed' || (exitCode !== undefined && exitCode !== 0),
          },
        },
      ],
      createdAtMs: now,
      updatedAtMs: now,
    };
  }

  return null;
}

/**
 * Project a raw desktop provider event into the canonical whole-message shape.
 * This browser-safe implementation is shared by Electron main and renderer so
 * the shared chat store never grows a second delta accumulator.
 */
export interface RuntimeChatProjectionInput {
  scope: 'worktree' | 'standalone' | 'app_advisor';
  workspaceLocalId?: string;
  worktreeLocalId?: string;
  chatId: string;
  data: unknown;
  fallbackMessageId?: string;
  admission?: RuntimeToolAdmission;
  /** Stamps `toolFamily` on `tool_use` parts; absent leaves it unset. */
  toolFamilyFor?: ToolFamilyResolver;
}

export function runtimeChatEventToPortalMessage(
  input: RuntimeChatProjectionInput,
): PortalChatMessage | null {
  if (!isRecord(input.data)) return null;
  const admission = input.scope === 'worktree' ? input.admission : undefined;
  // Usage/rate-limit frames are banner state, not transcript messages: the
  // desktop never renders them as rows (transcript-parser routes them to the
  // composer usage-limit banner), and the portal mirrors that banner via
  // `PortalChatSummaryEntity.usageLimit`. Projecting them here produced a
  // literal `rate_limit` bubble plus a failed 429 bubble (CAN-2601), and a
  // failed bubble with OpenAI's upsell text for Codex (CAN-4564).
  if (isProviderUsageLimitFrame(input.data)) return null;
  const type = readString(input.data, 'type');
  const displayErrorCode = input.data.canopy_display_error_code;
  // The canonical reducer attaches the terminal to the assistant's notice,
  // or authors a notice if the SDK emitted only a result. Do not add a second
  // live row for the same rejection ahead of that durable projection.
  if (type === 'result' && isClaudeAiCreditsFallbackErrorCode(displayErrorCode))
    return null;
  if (
    type === 'canopy_delegation' &&
    isAgentDelegationTranscript(input.data.delegation)
  ) {
    const messages = delegationTranscriptMessages(input.data.delegation);
    return persistedMessageToPortalWireMessage(
      {
        ...input,
        message: messages[0],
        relatedMessages: messages,
        outputLocators: false,
      },
      input.toolFamilyFor,
    );
  }
  if (type === CANOPY_ACCOUNT_PROXY_SWITCH_EVENT_TYPE) {
    return runtimeAccountProxySwitchMessage({ ...input, data: input.data });
  }
  if (type === CANOPY_CLAUDE_MODS_SKIPPED_EVENT_TYPE) {
    return runtimeClaudeModsSkippedMessage({ ...input, data: input.data });
  }
  if (type === 'codex') {
    const projected = runtimeCodexMessage({
      chatId: input.chatId,
      data: input.data,
      toolFamilyFor: input.toolFamilyFor,
    });
    if (!projected || !admission) return projected;
    const event = isRecord(input.data.event) ? input.data.event : undefined;
    const item = event && isRecord(event.item) ? event.item : undefined;
    const itemId = item ? readString(item, 'id') : undefined;
    if (!itemId) return projected;
    return {
      ...projected,
      parts: projected.parts?.map((part) =>
        part.kind === 'tool_use' || part.kind === 'tool_result'
          ? stampRuntimeToolPart(
              part,
              `${itemId}:${part.kind === 'tool_use' ? 'call' : 'result'}`,
              admission,
            )
          : part,
      ),
    };
  }
  // The desktop chat IPC channel also carries known host control records that
  // are not transcript messages. Filter those concrete controls without
  // imposing a policy on future provider message types.
  if (type && NON_MESSAGE_RUNTIME_CHAT_EVENT_TYPES.has(type)) {
    return null;
  }
  const parts = runtimeParts(input.data, input.toolFamilyFor, admission);
  const isToolResultEvent =
    type === 'user' &&
    parts.some(
      (part) => part.kind === 'tool_result' || part.kind === 'tool_use',
    );
  if (type === 'user' && !isToolResultEvent) return null;

  const text = isToolResultEvent ? '' : runtimeText(input.data);
  const status = runtimeStatus(input.data);
  const isTerminalTurnEvent =
    type === 'result' ||
    type === 'turn.completed' ||
    type === 'turn.cancelled' ||
    type === 'turn.failed';
  if (isTerminalTurnEvent && status !== 'failed') return null;

  const now = Date.now();
  const messageId =
    runtimeMessageId(input.data, parts, input.fallbackMessageId) ??
    `${input.chatId}:${type ?? 'event'}`;
  // A Codex turn refused for the account's model carries its recovery
  // notice on the terminal result (CAN-4716); the raw text rides in the part.
  const modelAccessFailure =
    type === 'result'
      ? readCodexAccountModelAccessFailure(
          input.data[CANOPY_MODEL_ACCESS_FAILURE_FIELD],
        )
      : undefined;
  const projected: PortalChatMessage = {
    messageId,
    chatId: input.chatId,
    role: 'assistant',
    status,
    text:
      isClaudeAiCreditsFallbackErrorCode(displayErrorCode) || modelAccessFailure
        ? ''
        : text,
    ...(isClaudeAiCreditsFallbackErrorCode(displayErrorCode)
      ? {
          parts: [
            { kind: 'text', data: { text, errorCode: displayErrorCode } },
          ],
        }
      : modelAccessFailure
        ? { parts: [{ kind: 'text', data: { text, modelAccessFailure } }] }
        : parts.length > 0
          ? { parts }
          : {}),
    createdAtMs: now,
    updatedAtMs: now,
  };
  if (
    (type === 'result' || type === 'error') &&
    status === 'failed' &&
    typeof input.data.canopy_provider_error_details === 'string' &&
    input.data.canopy_provider_error_details.length > 0
  ) {
    projected.text = '';
    projected.parts = [
      {
        kind: 'text',
        data: {
          text,
          providerErrorDetails: input.data.canopy_provider_error_details,
        },
      },
    ];
  }
  const refusedUserMessageId = input.data.canopy_turn_user_message_id;
  if (
    (type === 'canopy_ai_credits_no_billing_source' ||
      (type === 'error' && input.data.error_code === 'no_billing_source')) &&
    typeof refusedUserMessageId === 'string' &&
    typeof input.data.parent_tool_use_id !== 'string'
  ) {
    return {
      ...projected,
      status: 'failed',
      errorCode: 'no_billing_source',
      errorMessage: projected.text,
      parts: [
        ...(projected.parts ?? []),
        {
          kind: 'text',
          data: {
            text: '',
            composerRefusal: {
              code: 'no_billing_source',
              userMessageId: refusedUserMessageId,
            },
            errorText: projected.text,
          },
        },
      ],
    };
  }
  return projected;
}

/**
 * The account proxy moved the chat to another account. Every provider's
 * reducer persists the event the same way, so the live row is that persisted
 * row, projected as the owner's Portal shows it after a reload.
 */
function runtimeAccountProxySwitchMessage(input: {
  scope: 'worktree' | 'standalone' | 'app_advisor';
  workspaceLocalId?: string;
  worktreeLocalId?: string;
  chatId: string;
  data: Record<string, unknown>;
  toolFamilyFor?: ToolFamilyResolver;
}): PortalChatMessage | null {
  const now = Date.now();
  const [message] = applyClaudeTranscriptEvent(
    createEmptyTranscriptReducerState(),
    input.data,
    {
      now,
      createMessageId: (): string =>
        `${input.chatId}:account-proxy-switch:${now}`,
      childToolLiveness: { kind: 'unknown' },
    },
  ).messages;
  if (message === undefined) return null;
  return persistedMessageToPortalWireMessage(
    { ...input, message },
    input.toolFamilyFor,
  );
}

/** Project the launch notice through the same reducer used by durable history. */
function runtimeClaudeModsSkippedMessage(input: {
  scope: 'worktree' | 'standalone' | 'app_advisor';
  workspaceLocalId?: string;
  worktreeLocalId?: string;
  chatId: string;
  data: Record<string, unknown>;
  toolFamilyFor?: ToolFamilyResolver;
}): PortalChatMessage | null {
  const now = Date.now();
  const sourceEventId = readString(input.data, 'sourceEventId');
  const [message] = applyClaudeTranscriptEvent(
    createEmptyTranscriptReducerState(),
    input.data,
    {
      now,
      createMessageId: (): string =>
        `${input.chatId}:${sourceEventId ?? `claude-mods-skipped:${now}`}`,
      childToolLiveness: { kind: 'unknown' },
    },
  ).messages;
  if (message === undefined) return null;
  return persistedMessageToPortalWireMessage(
    { ...input, message },
    input.toolFamilyFor,
  );
}

/** True for the incremental assistant patch frames the Cursor harness emits. */
export function isCursorAssistantPatchEvent(
  data: unknown,
): data is Record<string, unknown> {
  return (
    isRecord(data) &&
    data.type === 'canopy_assistant_patch' &&
    (data.provider === 'cursor' ||
      data.provider === 'copilot' ||
      data.provider === 'antigravity' ||
      data.provider === 'opencode')
  );
}

export interface CursorAssistantPatchProjector {
  /**
   * Fold one live event. Returns the complete projected message after a
   * Cursor patch applies, or `null` for any other event and for a patch the
   * folded state cannot accept (which is dropped, never shown blank).
   */
  apply(data: unknown): PortalChatMessage | null;
}

/**
 * Stateful live projection for Cursor turns (Remote Control).
 *
 * Claude and Codex emit self-contained frames, so
 * {@link runtimeChatEventToPortalMessage} can project each one on its own.
 * Cursor's `CursorEventProjection` instead streams `canopy_assistant_patch`
 * frames — `{ index, block }` and `{ index, appendText }` edits against one
 * assistant (or host-notice `system`) message — exactly the shape the state
 * service folds into the persisted transcript with `applyAssistantPatches`.
 * One projector per dispatched turn replays that same fold in memory and
 * re-projects the whole message each revision, so the browser sees the text
 * grow under the patch's own `messageId` (the persisted id) instead of a
 * blank fallback-keyed row. `updatedAtMs` is strictly monotonic per message
 * so consumers that key wire updates on it treat every revision as new.
 */
export function createCursorAssistantPatchProjector(input: {
  scope: 'worktree' | 'standalone' | 'app_advisor';
  workspaceLocalId?: string;
  worktreeLocalId?: string;
  chatId: string;
  /** Stamps `toolFamily` on `tool_use` parts; absent leaves it unset. */
  toolFamilyFor?: ToolFamilyResolver;
}): CursorAssistantPatchProjector {
  const folded = new Map<string, PersistedChatMessage>();
  const lastUpdatedAtMs = new Map<string, number>();
  return {
    apply(data: unknown): PortalChatMessage | null {
      if (!isCursorAssistantPatchEvent(data)) return null;
      const messageId = readString(data, 'messageId');
      if (!messageId) return null;
      const message = applyAssistantPatches(folded.get(messageId), data);
      if (!message) return null;
      folded.set(messageId, message);
      const updatedAtMs = Math.max(
        Date.now(),
        (lastUpdatedAtMs.get(messageId) ?? 0) + 1,
      );
      lastUpdatedAtMs.set(messageId, updatedAtMs);
      return {
        ...persistedMessageToPortalWireMessage(
          {
            scope: input.scope,
            ...(input.workspaceLocalId !== undefined
              ? { workspaceLocalId: input.workspaceLocalId }
              : {}),
            ...(input.worktreeLocalId !== undefined
              ? { worktreeLocalId: input.worktreeLocalId }
              : {}),
            chatId: input.chatId,
            message,
            outputLocators: false,
          },
          input.toolFamilyFor,
        ),
        updatedAtMs,
      };
    },
  };
}

export function isTerminalRuntimeChatEvent(data: unknown): boolean {
  if (!isRecord(data)) return false;
  const type = readString(data, 'type');
  if (type === 'error') return true;
  if (type === 'result') return data.canopy_session_continues !== true;
  if (
    type === 'cancelled' ||
    type === 'turn.completed' ||
    type === 'turn.cancelled' ||
    type === 'turn.failed'
  ) {
    return true;
  }
  if (type === 'codex' && isRecord(data.event)) {
    const eventType = readString(data.event, 'type');
    return (
      eventType === 'turn.completed' ||
      eventType === 'turn.failed' ||
      eventType === 'turn.cancelled'
    );
  }
  return false;
}
