import {
  readAutoResumeMetadata,
  readChatAutoResume,
  readToolInterruption,
  type AutoResumeMetadata,
  type ToolInterruption,
} from '@canopy/protocol/portal';
import { settledToolInterruption } from '../settlement';
import { readMcpActivationRecord } from '@canopy/protocol/mcp-servers';
import { isTurnFileRecord } from '@canopy/protocol/turn-files';
import {
  serializeAgentArtifactReceipts,
  type AgentArtifactReceiptV1,
} from '@canopy/protocol/agent-artifacts';
import { isDelegatedAgentCallBlock } from '../lib/delegation-transcript';
import { isClaudeModsSkippedBlock } from '../lib/claude-mods-skipped';
import { admittedResultCall } from '../lib/admitted-result-call';
import { isClaudeAiCreditsFallbackErrorCode } from '@canopy/protocol/llm-gateway';
import {
  isCodexAccountModelAccessFailure,
  readCodexAccountModelAccessFailure,
} from '@canopy/protocol/auth-recovery';
import { isHumanAuthoredUserMessage } from '../transcript-storage';
import {
  isVisiblePersistedChatMessage,
  type PersistedChatMessage,
} from '../types';
import type { SharedContainerPublishedChat } from '@canopy/protocol/shared-containers';
import {
  parseChatAgentSentInfo,
  parseChatWatcherFiredInfo,
  portalChatAssetId,
  pairToolResultOccurrences,
  portalToolOccurrenceId,
  type ChatAgentSentInfo,
  type ChatWatcherFiredInfo,
  type PortalChatMessage,
  type PortalChatPart,
  type PortalChatToolFamily,
  type PortalChatTurnGroup,
} from '@canopy/protocol/portal';
import { stripMemoryCitationTags } from '../lib/memory-citation';
import { isRootUserTurnBoundary } from '../lib/turn-boundary';
import { parseAgentSentInfo } from '@canopy/protocol/portal/external-agent-sender';
import { portalChatMessageAttachmentsFromPaths } from './message-attachments';

/**
 * Pure projection of a {@link PersistedChatMessage} into the neutral
 * {@link PortalChatMessage} shape consumed by the shared chat UI.
 *
 * Browser-safe and reusable by the desktop renderer's shared-ChatPanel bridge
 * (CAN-741) and the hosted web run viewer (CAN-396). Only serializable data +
 * `@canopy/protocol` wire types are referenced here; no Node/Electron.
 *
 * The tool-family bucket for `tool_use` parts is resolved through an injected
 * {@link ToolFamilyResolver} rather than baked in: the desktop projector passes
 * its full `getPortalChatToolFamily` so its portal-sync output is byte-for-byte
 * unchanged, while a host that omits it (the read-only web viewer, which derives
 * icons/labels from the tool name at render time) simply leaves `toolFamily`
 * unset.
 */

/** Maps a tool-name string to its canonical Portal tool family. */
export type ToolFamilyResolver = (toolName: string) => PortalChatToolFamily;

/**
 * Primary response text stays large enough for a normal completed model
 * response while remaining bounded for the Portal wire. For well-formed text,
 * 128k UTF-16 code units fit inside the 600KB transcript seed budget with
 * envelope headroom. Rich tool/reasoning data keeps its much smaller per-part
 * cap below.
 */
export const PORTAL_CHAT_TEXT_MAX_CHARS = 128_000;
export const PORTAL_CHAT_PART_TEXT_MAX_CHARS = 4_000;
export interface PortalChatProjectionLimits {
  extractAgentArtifacts?: (output: string) => readonly AgentArtifactReceiptV1[];
  textMaxChars?: number;
  partTextMaxChars?: number;
  objectMaxDepth?: number;
  objectMaxKeys?: number;
  arrayMaxItems?: number;
  /** Nested child text is a part; root text remains on the message. */
  includeText?: boolean;
  /**
   * Also project turn timers that have not completed, and mark their message
   * as still streaming. Off for the portal wire, where a live timer row
   * belongs to the runtime projection; on for a local host that renders its
   * own transcript from this projection and needs the in-flight row (slice
   * 5, desktop adopting the shared transcript). This function sees ONE
   * message and cannot tell a running turn from a timer that never completed
   * on an old one, so a host must scope the opt-in to the live turn (as
   * desktop-shared's `projectPersistedChatTranscript` does).
   */
  includeInFlightTurnTimers?: boolean;
  /**
   * Also carry an image block's local sources: its absolute on-host `path`
   * and inline `dataUrl`. An EXPLICIT opt-in, never inferred from the text
   * caps: the shared-container publish path projects with every cap at
   * `Infinity` too, and neither a machine path nor a raster belongs in a
   * published envelope or on the portal wire. Only a host rendering its own
   * transcript locally sets this; the wire carries the `alt` text alone.
   */
  includeLocalImageSources?: boolean;
  includeAssetReferences?: boolean;
  /**
   * Emit tool results separately, with their original block ordinals. Off by
   * default.
   */
  unfoldToolResults?: boolean;
  /** Live/synthetic adapters must opt out: their row identity is not durable. */
  outputLocators?: boolean;
  /**
   * Also project the account proxy's switch lines (CAN-4021), which name the
   * chat owner's proxy accounts, often by email. An EXPLICIT opt-in like the
   * local image sources: the Portal wire and a host's own transcript set it,
   * and the publish path, which shares a chat with others, never does.
   */
  includeAccountProxySwitches?: boolean;
  /** Explicitly include this notice; shared-container publish calls leave it off. */
  includeClaudeModsSkipped?: boolean;
}

/**
 * No truncation at all: the projection a host uses to render ITS OWN
 * transcript locally, where the wire caps would silently cut tool output the
 * host renders in full today. Never use this for anything that leaves the
 * machine. Caps only: the local-only extras (`includeInFlightTurnTimers`,
 * `includeLocalImageSources`) are separate opt-ins, because the publish path also
 * lifts every cap and must not inherit them.
 */
export const PORTAL_CHAT_UNBOUNDED_LIMITS: PortalChatProjectionLimits = {
  textMaxChars: Infinity,
  partTextMaxChars: Infinity,
  objectMaxDepth: Infinity,
  objectMaxKeys: Infinity,
  arrayMaxItems: Infinity,
};
const PORTAL_CHAT_OBJECT_MAX_DEPTH = 3;
const PORTAL_CHAT_OBJECT_MAX_KEYS = 24;
const PORTAL_CHAT_ARRAY_MAX_ITEMS = 24;
export const PORTAL_CHAT_TRANSCRIPT_MESSAGE_LIMIT = 80;

/**
 * Deeper cap used when the desktop seeds a chat's persisted history into the
 * remote-control (portal) server store. The server keeps rows that age out of
 * this window (it skips its older-than prune for at-cap snapshots), so this
 * bounds a single snapshot's wire size, not total remote history. Keep it
 * larger than {@link PORTAL_CHAT_TRANSCRIPT_MESSAGE_LIMIT}: the server treats
 * any snapshot at or above the SMALLER limit as possibly truncated.
 */
export const PORTAL_CHAT_SEED_MESSAGE_LIMIT = 300;

/**
 * Serialized-size budget for the `chatMessages` seed inside one
 * `portal.state.snapshot` event. The desktop outbox drops events over the
 * 1MiB events cap, and its oversized-snapshot recovery can only split
 * `entities`, not `chatMessages` — an over-budget seed would lose the whole
 * snapshot. 600KB leaves headroom for the snapshot's entities and envelope.
 */
export const PORTAL_CHAT_SEED_MAX_BYTES = 600_000;

export interface PortalChatTranscriptSeed {
  messages: PortalChatMessage[];
  truncated: boolean;
}

/** UTF-8 byte length without relying on host-provided encoding globals. */
function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const codePoint = value.codePointAt(i) ?? 0;
    if (codePoint <= 0x7f) {
      bytes += 1;
    } else if (codePoint <= 0x7ff) {
      bytes += 2;
    } else if (codePoint <= 0xffff) {
      bytes += 3;
    } else {
      bytes += 4;
      i += 1;
    }
  }
  return bytes;
}

/**
 * Byte-budgeted seed window: prioritizes the most recent messages while
 * preserving their original oldest-to-newest order. The combined serialized
 * size fits {@link PORTAL_CHAT_SEED_MAX_BYTES}, capped at
 * {@link PORTAL_CHAT_SEED_MESSAGE_LIMIT} messages. Always keeps at least the
 * newest message so a seed is never empty for a non-empty transcript.
 */
export function limitPortalChatTranscriptForSeedWithMetadata(
  messages: PortalChatMessage[],
): PortalChatTranscriptSeed {
  const capped = limitPortalChatTranscript(
    messages,
    PORTAL_CHAT_SEED_MESSAGE_LIMIT,
  );
  let totalBytes = 0;
  let start = capped.length;
  for (let i = capped.length - 1; i >= 0; i -= 1) {
    const size = utf8ByteLength(JSON.stringify(capped[i]));
    if (
      start < capped.length &&
      totalBytes + size > PORTAL_CHAT_SEED_MAX_BYTES
    ) {
      break;
    }
    totalBytes += size;
    start = i;
  }
  return {
    messages: start === 0 ? capped : capped.slice(start),
    truncated: capped.length < messages.length || start > 0,
  };
}

export function limitPortalChatTranscriptForSeed(
  messages: PortalChatMessage[],
): PortalChatMessage[] {
  return limitPortalChatTranscriptForSeedWithMetadata(messages).messages;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const suffix = `\n\n[truncated ${value.length - maxChars} chars]`;
  return `${value.slice(0, Math.max(0, maxChars - suffix.length))}${suffix}`;
}

/**
 * Bound a serialized tool input. Within the limit it is unchanged. A longer
 * JSON object stays valid JSON: its longest string fields shrink first, so
 * short fields such as a title or a path survive for the tool row label.
 * Anything else is cut like text.
 */
export function truncateToolInput(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return truncateText(input, maxChars);
  }
  if (!isRecord(parsed)) return truncateText(input, maxChars);
  const result: Record<string, unknown> = { ...parsed };
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const serialized = JSON.stringify(result);
    if (serialized.length <= maxChars) return serialized;
    let longestKey: string | undefined;
    let longest = 0;
    for (const [key, value] of Object.entries(result))
      if (typeof value === 'string' && value.length > longest) {
        longest = value.length;
        longestKey = key;
      }
    const value = longestKey === undefined ? undefined : result[longestKey];
    if (longestKey === undefined || typeof value !== 'string' || longest <= 64)
      break;
    const excess = serialized.length - maxChars;
    result[longestKey] = truncateText(
      value,
      Math.max(64, longest - excess - 64),
    );
  }
  return truncateText(JSON.stringify(result), maxChars);
}

function renderVerbatimAsMarkdownLiteral(value: string): string {
  return value
    .split(/\r\n|\r|\n/)
    .map((line) => `    ${line}`)
    .join('\n');
}

export function summarizeUnknown(value: unknown, maxChars: number): string {
  try {
    return truncateText(JSON.stringify(value), maxChars);
  } catch {
    return truncateText(String(value), maxChars);
  }
}

function readStringField(
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  if (!value) {
    return undefined;
  }
  const field = value[key];
  return typeof field === 'string' ? field : undefined;
}

/**
 * Canonical wire id for a runtime (provider SDK) chat event.
 *
 * This is the single source of truth shared by the desktop main-process wire
 * projector (`runtimeMessageId` in `chat-transcript-projector.ts`, which pushes
 * live portal messages) and the renderer transcript reducer
 * (`transcript-parser.ts`, whose parsed messages are persisted to the
 * `ChatTabsFile` and later re-pushed to the portal via
 * `projectPersistedChatTranscript`). Both sides MUST derive the same id for the
 * same event, otherwise a portal hydrate + SSE replay shows the same logical
 * message under two ids and duplicates the row.
 *
 * Precedence (do not reorder without updating both consumers and their tests):
 *  1. `tool:<toolUseId>` when the event is keyed by a tool_result
 *     (`toolResultToolUseId` is the first tool_result's non-empty id).
 *  2. the SDK message id (`message.id`, e.g. `msg_…`).
 *  3. the per-event SDK `uuid`.
 *  4. a top-level `message_id` / `id`.
 *
 * Returns undefined when the event carries none of these — callers then apply
 * their own per-turn fallback (`` `${userMessageId}:assistant` ``) or a locally
 * minted id.
 */
export function deriveRuntimeChatMessageId(
  data: Record<string, unknown>,
  toolResultToolUseId?: string,
): string | undefined {
  if (toolResultToolUseId !== undefined && toolResultToolUseId.length > 0) {
    return `tool:${toolResultToolUseId}`;
  }
  const message = isRecord(data.message) ? data.message : undefined;
  return (
    readStringField(message, 'id') ??
    readStringField(data, 'uuid') ??
    readStringField(data, 'message_id') ??
    readStringField(data, 'id')
  );
}

// Internal to this module (persistedParts). `isRecord`/`truncateText`/
// `summarizeUnknown` above stay exported only because the main projector
// re-imports them; this one has no external consumer.
function truncatePortalData(
  value: unknown,
  limits: {
    textMaxChars: number;
    objectMaxDepth: number;
    objectMaxKeys: number;
    arrayMaxItems: number;
  },
  depth = 0,
): unknown {
  if (typeof value === 'string') {
    return truncateText(value, limits.textMaxChars);
  }
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (depth >= limits.objectMaxDepth) {
    return summarizeUnknown(value, limits.textMaxChars);
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, limits.arrayMaxItems)
      .map((item) => truncatePortalData(item, limits, depth + 1));
    if (value.length > limits.arrayMaxItems) {
      items.push(`[truncated ${value.length - limits.arrayMaxItems} items]`);
    }
    return items;
  }
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    const entries = Object.entries(value);
    for (const [key, fieldValue] of entries.slice(0, limits.objectMaxKeys)) {
      result[key] = truncatePortalData(fieldValue, limits, depth + 1);
    }
    if (entries.length > limits.objectMaxKeys) {
      result._truncatedKeys = entries.length - limits.objectMaxKeys;
    }
    return result;
  }
  return summarizeUnknown(value, limits.textMaxChars);
}

/** Cap a transcript to its most recent `limit` messages (default {@link PORTAL_CHAT_TRANSCRIPT_MESSAGE_LIMIT}). */
export function limitPortalChatTranscript(
  messages: PortalChatMessage[],
  limit: number = PORTAL_CHAT_TRANSCRIPT_MESSAGE_LIMIT,
): PortalChatMessage[] {
  return messages.length <= limit ? messages : messages.slice(-limit);
}

/** The chronological pairing rule now lives with the occurrence contract. */
export { pairToolResultOccurrences };

/** Agent-sent attribution as flat fields; wire compaction stringifies nested objects. */
function agentSentWireFields(
  info: ChatAgentSentInfo | undefined,
): Record<string, string> {
  if (!info) return {};
  const { sender } = info;
  if (sender.kind === 'pipeline') {
    return {
      agentSentSenderKind: sender.kind,
      ...(sender.executionId !== undefined
        ? { agentSentExecutionId: sender.executionId }
        : {}),
      ...(sender.pipelineId !== undefined
        ? { agentSentPipelineId: sender.pipelineId }
        : {}),
      ...(sender.stepId !== undefined
        ? { agentSentStepId: sender.stepId }
        : {}),
      ...(sender.automationId !== undefined
        ? { agentSentAutomationId: sender.automationId }
        : {}),
      agentSentChatTitle: info.chatTitle,
      agentSentProjectLabel: info.projectLabel,
    };
  }
  return {
    agentSentSenderKind: sender.kind,
    ...(sender.kind === 'project'
      ? {
          agentSentProjectType: sender.projectType,
          agentSentProjectId: sender.projectId,
        }
      : sender.kind === 'cloud_chat'
        ? { agentSentProjectId: sender.projectId }
        : { agentSentBotId: sender.botId }),
    agentSentTaskId: sender.taskId,
    agentSentChatId: sender.chatId,
    agentSentChatTitle: info.chatTitle,
    agentSentProjectLabel: info.projectLabel,
  };
}

export function persistedParts(
  message: PersistedChatMessage,
  toolFamilyFor?: ToolFamilyResolver,
  limits: PortalChatProjectionLimits = {},
  relatedMessages: readonly PersistedChatMessage[] = [],
): PortalChatPart[] {
  const partTextMaxChars =
    limits.partTextMaxChars ?? PORTAL_CHAT_PART_TEXT_MAX_CHARS;
  const dataLimits = {
    textMaxChars: partTextMaxChars,
    objectMaxDepth: limits.objectMaxDepth ?? PORTAL_CHAT_OBJECT_MAX_DEPTH,
    objectMaxKeys: limits.objectMaxKeys ?? PORTAL_CHAT_OBJECT_MAX_KEYS,
    arrayMaxItems: limits.arrayMaxItems ?? PORTAL_CHAT_ARRAY_MAX_ITEMS,
  };
  const unfoldToolResults = limits.unfoldToolResults === true;
  // The default projection folds each tool_result into its paired tool_use
  // (the renderer expects the result inline) when BOTH blocks live in this
  // message. The unfolded opt-in skips this map and emits every result below.
  //
  // They usually do not: an agent emits the tool_use in one message and the
  // tool_result in the NEXT one, so only same-message pairs can fold here. A
  // tool_result whose tool_use is in another message is emitted as a standalone
  // `tool_result` part -- the same shape the live runtime projection emits --
  // and the consumer folds it across messages (`foldToolResultsIntoToolUses`).
  // Dropping those blocks instead stranded every cross-message tool call on a
  // perpetual pending spinner and discarded its output entirely (CAN-2523).
  const pairs = unfoldToolResults
    ? new Map<number, number>()
    : pairToolResultOccurrences(message.blocks, (block) =>
        block.type === 'tool_use' || block.type === 'tool_result'
          ? { kind: block.type, toolUseId: block.toolUseId }
          : undefined,
      );
  const matchedResults = new Set(pairs.values());
  // Resolve against canonical rows, before visible ids converge. The exact
  // same turn/lane pairing rule is used at durable provider admission.
  const rowIndex = relatedMessages.findIndex((row) => row.id === message.id);
  const previous =
    rowIndex < 0 ? relatedMessages : relatedMessages.slice(0, rowIndex);
  const revision =
    'revision' in message &&
    typeof message.revision === 'number' &&
    Number.isSafeInteger(message.revision) &&
    message.revision >= 0
      ? message.revision
      : 0;
  const occurrenceAt = (
    ordinal: number,
  ): Pick<PortalChatPart, 'occurrence'> => {
    // Occurrences only protect read locators.
    if (limits.outputLocators === false) return {};
    const block = message.blocks[ordinal];
    const pairing =
      block.type === 'tool_result'
        ? admittedResultCall(message, ordinal, previous, block.toolUseId)
        : {
            authoritative: true,
            call: { rowId: message.id, blockOrdinal: ordinal },
          };
    // A projection may see only part of the transcript, so a result whose call
    // it cannot find stays unkeyed rather than claiming its own address.
    if (!pairing.authoritative || !pairing.call) return {};
    const id = portalToolOccurrenceId(
      pairing.call.rowId,
      pairing.call.blockOrdinal,
    );
    return id === undefined ? {} : { occurrence: { id, revision } };
  };
  let metadataBytes = 0;
  const receiptMetadata = (
    output: string,
    isError: boolean,
    metadata?: unknown,
  ): { agentArtifacts?: AgentArtifactReceiptV1[] } => {
    if (isError) return {};
    const retained = serializeAgentArtifactReceipts(metadata);
    const receipts = retained.length
      ? retained
      : serializeAgentArtifactReceipts(limits.extractAgentArtifacts?.(output));
    if (!receipts.length) return {};
    const size = new TextEncoder().encode(JSON.stringify(receipts)).byteLength;
    if (metadataBytes + size > 512 * 1024) return {};
    metadataBytes += size;
    return { agentArtifacts: receipts };
  };
  const resultData = (
    block: Extract<
      PersistedChatMessage['blocks'][number],
      { type: 'tool_result' }
    >,
    blockOrdinal: number,
  ): {
    output: string;
    isError: boolean;
    interruption?: ToolInterruption;
    agentArtifacts?: AgentArtifactReceiptV1[];
    outputLocator?: PortalChatPart['outputLocator'];
  } => ({
    output: truncateText(block.output, partTextMaxChars),
    isError: block.isError,
    ...(settledToolInterruption(message, block)
      ? { interruption: settledToolInterruption(message, block) }
      : {}),
    ...receiptMetadata(block.output, block.isError, block.agentArtifacts),
    ...(limits.outputLocators !== false &&
    (block.fullOutputRef !== undefined ||
      block.output.length > partTextMaxChars)
      ? {
          outputLocator: {
            messageId: message.id,
            blockOrdinal,
            field: 'output',
          },
        }
      : {}),
  });

  return message.blocks.flatMap((block, blockIndex): PortalChatPart[] => {
    if (block.type === 'delegated_agent_call') {
      const children = relatedMessages.filter(
        (child) => child.parentBlockId === block.agentBlockId,
      );
      const subBlocks = children.flatMap((child) =>
        persistedParts(child, toolFamilyFor, {
          ...limits,
          partTextMaxChars: Number.POSITIVE_INFINITY,
          includeText: true,
        }).map((part) => ({
          ...part,
          data: {
            ...(isRecord(part.data) ? part.data : {}),
            messageId: child.id,
            occurredAt: child.timestamp,
            sequence: child.delegationSequence,
            // Who wrote an authored message, so viewers do not show a
            // user's steer or follow-up as the subagent's own reply. Flat
            // fields: the wire compaction stringifies nested objects.
            ...(child.delegationAuthor !== undefined
              ? { delegationAuthorKind: child.delegationAuthor.kind }
              : {}),
            ...(child.delegationAuthor?.kind === 'agent' &&
            child.delegationAuthor.description !== undefined
              ? {
                  delegationAuthorDescription:
                    child.delegationAuthor.description,
                }
              : {}),
            ...(child.delegationDelivery !== undefined
              ? { delegationDelivery: child.delegationDelivery }
              : {}),
            ...(child.role === 'user'
              ? agentSentWireFields(parseChatAgentSentInfo(child.agentSent))
              : {}),
          },
        })),
      );
      return [{ kind: 'agent', data: { delegation: block, subBlocks } }];
    }
    if (
      block.type === 'text' &&
      (limits.includeText ||
        block.providerErrorDetails !== undefined ||
        isClaudeAiCreditsFallbackErrorCode(block.errorCode) ||
        isCodexAccountModelAccessFailure(block.modelAccessFailure))
    ) {
      const modelAccessFailure = readCodexAccountModelAccessFailure(
        block.modelAccessFailure,
      );
      return [
        {
          kind: 'text',
          data: {
            ...(block.providerErrorDetails !== undefined
              ? { providerErrorDetails: block.providerErrorDetails }
              : {}),
            ...(isClaudeAiCreditsFallbackErrorCode(block.errorCode)
              ? { errorCode: block.errorCode }
              : {}),
            ...(modelAccessFailure ? { modelAccessFailure } : {}),
            text: truncateText(
              stripMemoryCitationTags(block.text),
              partTextMaxChars,
            ),
          },
        },
      ];
    }
    if (block.type === 'thinking') {
      // Thinking blocks are model output by definition, so citation control
      // tags are stripped here; tool inputs/results below pass through intact.
      return [
        {
          kind: 'thinking',
          data: {
            text: truncateText(
              stripMemoryCitationTags(block.text),
              partTextMaxChars,
            ),
          },
        },
      ];
    }
    if (block.type === 'tool_use') {
      const resultIndex = pairs.get(blockIndex);
      const result =
        resultIndex !== undefined ? message.blocks[resultIndex] : undefined;
      const paired =
        result?.type === 'tool_result' && resultIndex !== undefined
          ? resultData(result, resultIndex)
          : undefined;
      const display = block.display ?? block;
      // Older transcripts persisted object inputs despite the string type.
      const rawInput: unknown = display.input;
      const toolFamily = toolFamilyFor?.(display.toolName);
      return [
        {
          kind: 'tool_use',
          ...occurrenceAt(blockIndex),
          ...(toolFamily ? { toolFamily } : {}),
          data: {
            toolUseId: block.toolUseId,
            toolName: display.toolName,
            input:
              typeof rawInput === 'string'
                ? truncateToolInput(rawInput, dataLimits.textMaxChars)
                : truncatePortalData(rawInput, dataLimits),
            ...(paired ? { result: paired } : {}),
          },
        },
      ];
    }
    if (block.type === 'tool_result') {
      // A promoted visual travels as its full reference (never its bytes),
      // with the message that owns it, so a Portal read can be built from the
      // part alone even after a consumer folds the result elsewhere.
      const visual = block.visualRef
        ? { messageId: message.id, visual: block.visualRef }
        : undefined;
      // Paired tool_use is in THIS message: already folded inline above, so
      // only a visual still needs its own part. It carries no occurrence,
      // which would mark it as a result already folded into its call.
      // In unfolded mode there are no matched results: keep every result.
      if (matchedResults.has(blockIndex)) {
        return visual
          ? [
              {
                kind: 'tool_result',
                data: { toolUseId: block.toolUseId, ...visual },
              },
            ]
          : [];
      }
      // Otherwise carry the result on the wire so the consumer can pair it
      // with the tool_use it projected from an earlier message.
      const { outputLocator, ...data } = resultData(block, blockIndex);
      return [
        {
          kind: 'tool_result',
          ...occurrenceAt(blockIndex),
          ...(unfoldToolResults ? { blockOrdinal: blockIndex } : {}),
          ...(outputLocator ? { outputLocator } : {}),
          data: {
            toolUseId: block.toolUseId,
            ...data,
            ...visual,
          },
        },
      ];
    }
    if (block.type === 'file_references') {
      // Whole-plugin `@` mentions ride the file-reference pill with
      // `kind: 'plugin'` (`@canopy/desktop-shared/lib/plugin-mention`, not
      // importable here) and a `plugin://` locator, not a path. The web
      // portal renders this part as file chips, so they are left out; the
      // mention survives as its token in the text part.
      const references = block.references.filter(
        (reference) => reference.kind !== 'plugin',
      );
      if (references.length === 0) return [];
      return [
        {
          kind: 'attachment',
          data: {
            references: truncatePortalData(references, dataLimits),
          },
        },
      ];
    }
    if (block.type === 'image') {
      // The local sources travel only on explicit opt-in: the absolute path
      // names the host's filesystem and the raster is large, and the publish
      // path lifts every cap too, so lifted caps are not a local-only signal.
      return [
        {
          kind: 'image',
          data: {
            ...(limits.includeAssetReferences === true
              ? { assetId: portalChatAssetId(message.id, 'image', blockIndex) }
              : {}),
            ...(limits.includeLocalImageSources === true
              ? {
                  path: block.path,
                  ...(block.dataUrl !== undefined
                    ? { dataUrl: block.dataUrl }
                    : {}),
                }
              : {}),
            // Alt text can be a provider's unbounded `revised_prompt`, so it
            // takes the same cap as every other part text on the wire.
            ...(block.alt !== undefined
              ? { alt: truncateText(block.alt, partTextMaxChars) }
              : {}),
          },
        },
      ];
    }
    if (block.type === 'mcp_activation') {
      const record = readMcpActivationRecord(block.record);
      return record ? [{ kind: 'mcp_activation', data: { record } }] : [];
    }
    if (block.type === 'compaction_info') {
      return [
        {
          kind: 'compaction',
          data: {
            occurredAt: block.timestamp,
            // Both travel so the renderer can name who compacted (a Codex
            // compaction must not read as Claude's).
            provider: block.provider,
            interfaceMode: block.interfaceMode,
            ...(block.reason !== undefined ? { trigger: block.reason } : {}),
            ...(block.summary !== undefined
              ? { summary: truncateText(block.summary, partTextMaxChars) }
              : {}),
          },
        },
      ];
    }
    if (block.type === 'account_proxy_switch') {
      if (limits.includeAccountProxySwitches !== true) return [];
      return [
        {
          kind: 'account_switch',
          data: {
            occurredAt: block.timestamp,
            account: truncateText(block.account, partTextMaxChars),
            ...(block.previousAccount !== undefined
              ? {
                  previousAccount: truncateText(
                    block.previousAccount,
                    partTextMaxChars,
                  ),
                }
              : {}),
            ...(block.previousAtLimit === true
              ? { previousAtLimit: true }
              : {}),
          },
        },
      ];
    }
    if (block.type === 'claude_mods_skipped') {
      if (
        limits.includeClaudeModsSkipped !== true ||
        !isClaudeModsSkippedBlock(block)
      ) {
        return [];
      }
      return [
        {
          kind: 'mods_skipped',
          data: {
            occurredAt: block.timestamp,
            mods: block.mods.slice(0, 50).map((mod) => ({
              pluginId: truncateText(mod.pluginId, partTextMaxChars),
              reason: mod.reason,
            })),
          },
        },
      ];
    }
    if (block.type === 'turn_timer') {
      if (
        typeof block.completedAt === 'number' ||
        limits.includeInFlightTurnTimers === true
      ) {
        return [
          {
            kind: 'turn_timer',
            data: {
              ...(block.turnId === undefined ? {} : { turnId: block.turnId }),
              ...(block.userMessageId === undefined
                ? {}
                : { userMessageId: block.userMessageId }),
              ...(block.spawnedBy === undefined
                ? {}
                : { spawnedBy: block.spawnedBy }),
              startedAt: block.startedAt,
              pausedAt: block.pausedAt,
              resumedAt: block.resumedAt,
              accumulatedPausedDurationMs: block.accumulatedPausedDurationMs,
              completedAt: block.completedAt,
              ...(block.outcome === undefined
                ? {}
                : { outcome: block.outcome }),
            },
          },
        ];
      }
      return [];
    }
    if (block.type === 'text' && block.steering) {
      return [
        {
          kind: 'steering',
          data: {
            startsTurn: block.steering.startsTurn,
            ...(block.steering.rootUserMessageId
              ? { rootUserMessageId: block.steering.rootUserMessageId }
              : {}),
          },
        },
      ];
    }
    return [];
  });
}

/**
 * Project a persisted message into a neutral portal message. `status` is
 * `'complete'` — a persisted message is a settled block; live streaming status
 * is applied by the caller (the renderer bridge marks the in-flight message).
 */
export interface PortalPromptProvenance {
  promptSource: 'human' | 'automated';
  autoResume?: AutoResumeMetadata;
  watcherFired?: ChatWatcherFiredInfo;
  parts: [PortalChatPart];
}

/**
 * Provenance for a user row. The `prompt_source` part mirrors the top-level
 * fields because the Portal relay caches only text, parts and attachments.
 */
export function portalPromptProvenance(
  message: Pick<
    PersistedChatMessage,
    'role' | 'watcherFired' | 'userMessageSource' | 'autoResume'
  >,
): PortalPromptProvenance {
  const promptSource = isHumanAuthoredUserMessage(message)
    ? 'human'
    : 'automated';
  const autoResume =
    message.userMessageSource === 'auto_resume'
      ? readAutoResumeMetadata(message.autoResume)
      : undefined;
  const watcherFired = parseChatWatcherFiredInfo(message.watcherFired);
  return {
    promptSource,
    ...(autoResume ? { autoResume } : {}),
    ...(watcherFired ? { watcherFired } : {}),
    parts: [
      {
        kind: 'prompt_source',
        data: {
          source: promptSource,
          ...(autoResume ? { autoResume } : {}),
          ...(watcherFired ? { watcherFired } : {}),
        },
      },
    ],
  };
}

export function persistedMessageToPortalMessage(
  input: {
    scope: 'worktree' | 'standalone' | 'app_advisor';
    workspaceLocalId?: string;
    worktreeLocalId?: string;
    chatId: string;
    message: PersistedChatMessage;
    toolFamilyFor?: ToolFamilyResolver;
    relatedMessages?: readonly PersistedChatMessage[];
  },
  limits: PortalChatProjectionLimits = {},
): PortalChatMessage {
  if (!isVisiblePersistedChatMessage(input.message)) {
    throw new Error('Hidden persisted messages cannot be projected');
  }
  const joinedText = input.message.blocks
    .flatMap((block) =>
      block.type === 'text' &&
      block.providerErrorDetails === undefined &&
      !isClaudeAiCreditsFallbackErrorCode(block.errorCode) &&
      !isCodexAccountModelAccessFailure(block.modelAccessFailure)
        ? [
            block.verbatim
              ? renderVerbatimAsMarkdownLiteral(block.text)
              : block.text,
          ]
        : [],
    )
    .filter(Boolean)
    .join('\n\n');
  // Citation control tags are model output, so only assistant text is
  // sanitized; user and system text carrying the literal syntax stays intact.
  const text =
    input.message.role === 'assistant'
      ? stripMemoryCitationTags(joinedText)
      : joinedText;
  const parts = persistedParts(
    input.message,
    input.toolFamilyFor,
    limits,
    input.relatedMessages,
  );
  const provenance =
    input.message.role === 'user'
      ? portalPromptProvenance(input.message)
      : undefined;
  if (provenance) parts.push(...provenance.parts);
  const attachments =
    input.message.role === 'user' && input.message.attachmentPaths?.length
      ? portalChatMessageAttachmentsFromPaths(
          input.message.attachmentPaths,
        ).map((attachment, index) => ({
          ...attachment,
          ...(limits.includeAssetReferences === true
            ? {
                assetId: portalChatAssetId(
                  input.message.id,
                  'attachment',
                  index,
                ),
              }
            : {}),
        }))
      : [];
  // A message whose turn timer is still running is a live one: the shared
  // view derives `live` from the message status and hides an unfinished
  // timer row on a completed message, so the in-flight opt-in has to carry
  // the status with it.
  const hasInFlightTimer =
    limits.includeInFlightTurnTimers === true &&
    input.message.blocks.some(
      (block) =>
        block.type === 'turn_timer' && typeof block.completedAt !== 'number',
    );
  const agentSent =
    input.message.role === 'user'
      ? (parseAgentSentInfo(input.message.agentSent) ?? undefined)
      : undefined;

  return {
    messageId: input.message.id,
    chatId: input.chatId,
    role: input.message.role,
    ...(provenance
      ? {
          promptSource: provenance.promptSource,
          ...(provenance.autoResume
            ? { autoResume: provenance.autoResume }
            : {}),
          ...(provenance.watcherFired
            ? { watcherFired: provenance.watcherFired }
            : {}),
        }
      : {}),
    ...(input.message.role === 'user' && !isRootUserTurnBoundary(input.message)
      ? { continuesTurn: true }
      : {}),
    status:
      input.message.cancelled === true
        ? 'cancelled'
        : hasInFlightTimer
          ? 'streaming'
          : 'complete',
    text: truncateText(text, limits.textMaxChars ?? PORTAL_CHAT_TEXT_MAX_CHARS),
    ...(parts.length > 0 ? { parts } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(agentSent !== undefined ? { agentSent } : {}),
    createdAtMs: input.message.timestamp,
  };
}

export interface ImportedPortalChatTranscript {
  messages: PersistedChatMessage[];
  turnGroups: PortalChatTurnGroup[];
}

export interface RehydratedPublishedChatTab {
  id: string;
  title: string;
  description?: string;
  messages: PersistedChatMessage[];
  createdAt: string;
}

export interface PublishedChatRehydrationResult {
  tab: RehydratedPublishedChatTab;
  warnings: string[];
}

export interface PublishedChatDestination {
  projectId: string;
  worktreeId: string;
  chatId: string;
  resolveAttachment: (artifactRef: string) => string | undefined;
}

const PUBLISHED_PART_MAX_DEPTH = 8;
const PUBLISHED_PART_MAX_NODES = 2_000;
const PUBLISHED_PART_MAX_STRING_CHARS = 128_000;

function validatePublishedPartData(value: unknown): string | null {
  const pending: Array<{ value: unknown; depth: number }> = [
    { value, depth: 0 },
  ];
  const seen = new Set<object>();
  let nodes = 0;
  let stringChars = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > PUBLISHED_PART_MAX_NODES) return 'oversized';
    if (current.depth > PUBLISHED_PART_MAX_DEPTH) return 'deeply nested';
    if (typeof current.value === 'string') {
      stringChars += current.value.length;
      if (stringChars > PUBLISHED_PART_MAX_STRING_CHARS) return 'oversized';
      continue;
    }
    if (
      current.value === null ||
      typeof current.value === 'boolean' ||
      (typeof current.value === 'number' && Number.isFinite(current.value))
    ) {
      continue;
    }
    if (typeof current.value !== 'object') return 'unrepresentable';
    if (seen.has(current.value)) return 'cyclic';
    seen.add(current.value);
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>);
    for (const child of children) {
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
  return null;
}

function placeholderBlock(
  kind: string,
): PersistedChatMessage['blocks'][number] {
  return {
    type: 'text',
    text: `[Shared content unavailable: invalid ${kind} part]`,
  };
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function importSpawnedBy(value: Record<string, unknown>): {
  taskId?: string;
  toolUseId?: string;
  event?: true;
  scheduled?: true;
  toolsLoaded?: true;
} {
  return {
    ...(typeof value.taskId === 'string' ? { taskId: value.taskId } : {}),
    ...(typeof value.toolUseId === 'string'
      ? { toolUseId: value.toolUseId }
      : {}),
    ...(value.event === true ? { event: value.event } : {}),
    ...(value.scheduled === true ? { scheduled: value.scheduled } : {}),
    ...(value.toolsLoaded === true ? { toolsLoaded: true } : {}),
  };
}

function delegationSubBlockKind(
  value: unknown,
): value is 'text' | 'thinking' | 'tool_use' {
  return value === 'text' || value === 'thinking' || value === 'tool_use';
}

function steeringFromPortalParts(
  parts: readonly PortalChatPart[] | undefined,
): { startsTurn: boolean; rootUserMessageId?: string } | undefined {
  const steering = parts?.find((part) => part.kind === 'steering');
  const data = isRecord(steering?.data) ? steering.data : undefined;
  if (typeof data?.startsTurn !== 'boolean') return undefined;
  return {
    startsTurn: data.startsTurn,
    ...(typeof data.rootUserMessageId === 'string'
      ? { rootUserMessageId: data.rootUserMessageId }
      : {}),
  };
}

function portalPartToPersistedBlocks(
  part: PortalChatPart,
): PersistedChatMessage['blocks'] {
  const data = isRecord(part.data) ? part.data : undefined;
  switch (part.kind) {
    case 'mcp_activation': {
      const record = readMcpActivationRecord(data?.record);
      return record
        ? [{ type: 'mcp_activation', record }]
        : [placeholderBlock('mcp_activation')];
    }
    case 'text': {
      const modelAccessFailure = readCodexAccountModelAccessFailure(
        data?.modelAccessFailure,
      );
      return typeof data?.text === 'string'
        ? [
            {
              type: 'text',
              text: data.text,
              ...(typeof data.providerErrorDetails === 'string'
                ? { providerErrorDetails: data.providerErrorDetails }
                : {}),
              ...(isClaudeAiCreditsFallbackErrorCode(data.errorCode)
                ? { errorCode: data.errorCode }
                : {}),
              ...(modelAccessFailure ? { modelAccessFailure } : {}),
            },
          ]
        : [placeholderBlock('text')];
    }
    case 'thinking':
      return typeof data?.text === 'string'
        ? [{ type: 'thinking', text: data.text }]
        : [placeholderBlock('thinking')];
    case 'tool_use': {
      if (
        typeof data?.toolUseId !== 'string' ||
        typeof data.toolName !== 'string' ||
        !Object.prototype.hasOwnProperty.call(data, 'input')
      ) {
        return [placeholderBlock('tool_use')];
      }
      const input =
        typeof data.input === 'string'
          ? data.input
          : summarizeUnknown(data.input, Number.MAX_SAFE_INTEGER);
      const blocks: PersistedChatMessage['blocks'] = [
        {
          type: 'tool_use',
          toolUseId: data.toolUseId,
          toolName: data.toolName,
          input,
        },
      ];
      if (isRecord(data.result)) {
        if (
          typeof data.result.output === 'string' &&
          typeof data.result.isError === 'boolean'
        ) {
          blocks.push({
            type: 'tool_result',
            toolUseId: data.toolUseId,
            toolName: data.toolName,
            output: data.result.output,
            isError: data.result.isError,
            ...(readToolInterruption(data.result.interruption)
              ? { interruption: readToolInterruption(data.result.interruption) }
              : {}),
          });
        } else {
          blocks.push(placeholderBlock('tool_use result'));
        }
      }
      return blocks;
    }
    case 'tool_result':
      // A visual-only part repeats a result already folded into its
      // tool_use, and published copies carry no visual artifact.
      if (
        typeof data?.toolUseId === 'string' &&
        data.output === undefined &&
        data.visual !== undefined
      ) {
        return [];
      }
      return typeof data?.toolUseId === 'string' &&
        typeof data.output === 'string' &&
        typeof data.isError === 'boolean'
        ? [
            {
              type: 'tool_result',
              toolUseId: data.toolUseId,
              toolName:
                typeof data.toolName === 'string' ? data.toolName : 'Tool',
              output: data.output,
              isError: data.isError,
              ...(readToolInterruption(data.interruption)
                ? { interruption: readToolInterruption(data.interruption) }
                : {}),
            },
          ]
        : [placeholderBlock('tool_result')];
    case 'attachment': {
      if (!Array.isArray(data?.references)) {
        return Array.isArray(data?.attachmentPaths) &&
          data.attachmentPaths.every((path) => typeof path === 'string')
          ? [{ type: 'text', text: '[Shared attachment]' }]
          : [placeholderBlock('attachment')];
      }
      const references = data.references.flatMap((reference) => {
        if (!isRecord(reference) || typeof reference.displayPath !== 'string') {
          return [];
        }
        return [
          {
            displayPath: reference.displayPath,
            // Published references intentionally omit owner-local absolute
            // paths. Use the authenticated display path as an inert value.
            absolutePath: reference.displayPath,
            ...(typeof reference.repoName === 'string'
              ? { repoName: reference.repoName }
              : {}),
          },
        ];
      });
      return references.length === data.references.length
        ? [{ type: 'file_references', references }]
        : [placeholderBlock('attachment')];
    }
    case 'turn_timer':
      return data &&
        (data.startedAt === undefined || finiteNumber(data.startedAt)) &&
        (data.pausedAt === undefined ||
          data.pausedAt === null ||
          finiteNumber(data.pausedAt)) &&
        (data.resumedAt === undefined ||
          data.resumedAt === null ||
          finiteNumber(data.resumedAt)) &&
        (data.accumulatedPausedDurationMs === undefined ||
          finiteNumber(data.accumulatedPausedDurationMs)) &&
        (data.completedAt === null || finiteNumber(data.completedAt))
        ? [
            {
              type: 'turn_timer',
              ...(typeof data.turnId === 'string'
                ? { turnId: data.turnId }
                : {}),
              ...(typeof data.userMessageId === 'string'
                ? { userMessageId: data.userMessageId }
                : {}),
              ...(isRecord(data.spawnedBy)
                ? { spawnedBy: importSpawnedBy(data.spawnedBy) }
                : {}),
              ...(finiteNumber(data.startedAt)
                ? { startedAt: data.startedAt }
                : {}),
              ...(data.pausedAt === null || finiteNumber(data.pausedAt)
                ? { pausedAt: data.pausedAt }
                : {}),
              ...(data.resumedAt === null || finiteNumber(data.resumedAt)
                ? { resumedAt: data.resumedAt }
                : {}),
              ...(finiteNumber(data.accumulatedPausedDurationMs)
                ? {
                    accumulatedPausedDurationMs:
                      data.accumulatedPausedDurationMs,
                  }
                : {}),
              completedAt: data.completedAt,
              ...(data.outcome === 'completed' ||
              data.outcome === 'cancelled' ||
              data.outcome === 'failed'
                ? { outcome: data.outcome }
                : {}),
            },
          ]
        : [placeholderBlock('turn_timer')];
    case 'prompt_source':
      return [];
    case 'steering':
      return steeringFromPortalParts([part])
        ? []
        : [placeholderBlock('steering')];
    case 'image':
      return data
        ? [{ type: 'text', text: '[Shared image attachment]' }]
        : [placeholderBlock('image')];
    case 'compaction':
      return data && finiteNumber(data.occurredAt)
        ? [
            {
              type: 'text',
              text:
                typeof data.summary === 'string' && data.summary.length > 0
                  ? `[Conversation context compacted] ${data.summary}`
                  : '[Conversation context compacted]',
            },
          ]
        : [placeholderBlock('compaction')];
    case 'agent':
      if (isDelegatedAgentCallBlock(data?.delegation)) return [data.delegation];
      return data
        ? [
            {
              type: 'text',
              text:
                typeof data.description === 'string'
                  ? `[Shared agent activity: ${data.description}]`
                  : '[Shared agent activity]',
            },
          ]
        : [placeholderBlock('agent')];
    default:
      return [placeholderBlock(String((part as { kind?: unknown }).kind))];
  }
}

function validTurnGroup(value: PortalChatTurnGroup): boolean {
  if (
    typeof value.userMessageId !== 'string' ||
    !Array.isArray(value.intermediateMessageIds) ||
    !value.intermediateMessageIds.every((id) => typeof id === 'string') ||
    !Array.isArray(value.finalMessageIds) ||
    !value.finalMessageIds.every((id) => typeof id === 'string') ||
    (value.files !== undefined &&
      (!Array.isArray(value.files) || !value.files.every(isTurnFileRecord))) ||
    (value.expandedMessageIds !== undefined &&
      (!Array.isArray(value.expandedMessageIds) ||
        !value.expandedMessageIds.every((id) => typeof id === 'string'))) ||
    (value.revertedAt !== undefined && typeof value.revertedAt !== 'string') ||
    (value.revertedPreview !== undefined &&
      typeof value.revertedPreview !== 'string')
  ) {
    return false;
  }
  return (
    value.summary === undefined ||
    (isRecord(value.summary) &&
      Object.values(value.summary).every(
        (count) => Number.isSafeInteger(count) && count >= 0,
      ))
  );
}

/**
 * Defensive inverse projection for authenticated shared-container chats.
 * Free-form part payloads are validated independently so one corrupt part
 * becomes an inert visible placeholder without dropping adjacent content.
 */
export function portalChatMessagesToPersisted(
  messages: readonly PortalChatMessage[],
  turnGroups: readonly PortalChatTurnGroup[] = [],
): ImportedPortalChatTranscript {
  return {
    messages: messages.flatMap((message) => {
      const steering = steeringFromPortalParts(message.parts);
      const blocks: PersistedChatMessage['blocks'] =
        message.text || steering
          ? [
              {
                type: 'text',
                text: message.text,
                ...(steering ? { steering } : {}),
              },
            ]
          : [];
      for (const part of message.parts ?? []) {
        blocks.push(...portalPartToPersistedBlocks(part));
      }
      const children = new Map<string, PersistedChatMessage>();
      for (const part of message.parts ?? []) {
        if (
          part.kind !== 'agent' ||
          !isRecord(part.data) ||
          !isDelegatedAgentCallBlock(part.data.delegation) ||
          !Array.isArray(part.data.subBlocks)
        )
          continue;
        const parent = part.data.delegation;
        // Only known, read-only child kinds are reconstructed. Never recurse into arbitrary part data.
        for (const nested of part.data.subBlocks) {
          if (
            !isRecord(nested) ||
            !delegationSubBlockKind(nested.kind) ||
            !isRecord(nested.data)
          )
            continue;
          const data = nested.data;
          if (
            typeof data.messageId !== 'string' ||
            !data.messageId.startsWith(`${parent.agentBlockId}:`) ||
            !finiteNumber(data.occurredAt) ||
            !Number.isSafeInteger(data.sequence) ||
            Number(data.sequence) < 0
          )
            continue;
          const childBlocks = portalPartToPersistedBlocks({
            kind: nested.kind,
            data,
          });
          const existing = children.get(data.messageId);
          if (existing) existing.blocks.push(...childBlocks);
          else
            children.set(data.messageId, {
              id: data.messageId,
              role: 'assistant',
              timestamp: data.occurredAt,
              parentBlockId: parent.agentBlockId,
              delegationSequence: Number(data.sequence),
              blocks: childBlocks,
            });
        }
      }
      return [
        {
          id: message.messageId,
          role: message.role,
          timestamp: message.createdAtMs,
          ...(readChatAutoResume(message)
            ? {
                userMessageSource: 'auto_resume' as const,
                autoResume: readChatAutoResume(message),
              }
            : message.promptSource === 'automated'
              ? { userMessageSource: 'hook' as const }
              : {}),
          blocks,
        },
        ...Array.from(children.values()),
      ];
    }),
    turnGroups: turnGroups.filter(validTurnGroup).map((group) => ({
      ...group,
      intermediateMessageIds: [...group.intermediateMessageIds],
      finalMessageIds: [...group.finalMessageIds],
      ...(group.files
        ? { files: group.files.map((file) => ({ ...file })) }
        : {}),
      ...(group.expandedMessageIds
        ? { expandedMessageIds: [...group.expandedMessageIds] }
        : {}),
      ...(group.summary ? { summary: { ...group.summary } } : {}),
    })),
  };
}

/**
 * Rehydrate one published shared-container chat as an ordinary local tab.
 * Provider resume state is absent by construction because this builder emits
 * only the durable, presentation-safe fields represented by the publication.
 */
export function publishedChatToPersistedTab(
  published: SharedContainerPublishedChat,
  destination: PublishedChatDestination,
): PublishedChatRehydrationResult {
  const warnings: string[] = [];
  const seenMessageIds = new Set<string>();
  const normalizedMessages = published.messages.map((message, index) => {
    let messageId = message.messageId;
    if (!messageId || seenMessageIds.has(messageId)) {
      const original = messageId || '(missing)';
      messageId = `${destination.chatId}-message-${index + 1}`;
      while (seenMessageIds.has(messageId)) messageId = `${messageId}-copy`;
      warnings.push(
        `Message id ${original} was replaced while importing chat ${published.chatId}.`,
      );
    }
    seenMessageIds.add(messageId);
    if (message.chatId !== published.chatId) {
      warnings.push(
        `Message ${messageId} referenced a different chat id and was retained.`,
      );
    }

    const attachmentPaths: string[] = [];
    const parts = (message.parts ?? []).map((part, partIndex) => {
      const rawKind = (part as { kind?: unknown }).kind;
      const kind = typeof rawKind === 'string' ? rawKind : 'unknown';
      const invalidReason = validatePublishedPartData(
        (part as { data?: unknown }).data,
      );
      if (invalidReason) {
        warnings.push(
          `Message ${messageId} ${kind} part ${partIndex + 1} was ${invalidReason} and was preserved as a placeholder.`,
        );
        return { kind, data: undefined } as PortalChatPart;
      }
      if (
        ![
          'tool_use',
          'tool_result',
          'thinking',
          'attachment',
          'image',
          'agent',
          'turn_timer',
          'steering',
          'prompt_source',
          'compaction',
          'mcp_activation',
        ].includes(kind)
      ) {
        warnings.push(
          `Message ${messageId} has an unknown ${kind} part, which was preserved as a placeholder.`,
        );
      } else if (
        portalPartToPersistedBlocks(part).some(
          (block) =>
            block.type === 'text' &&
            block.text.startsWith('[Shared content unavailable:'),
        )
      ) {
        warnings.push(
          `Message ${messageId} ${kind} part ${partIndex + 1} was malformed and was preserved as a placeholder.`,
        );
      }
      if (kind === 'attachment') {
        const data = isRecord(part.data) ? part.data : undefined;
        const resolvedReferences: string[] = [];
        const references = Array.isArray(data?.attachmentPaths)
          ? data.attachmentPaths
          : [];
        for (const reference of references) {
          if (typeof reference !== 'string') continue;
          const resolved = destination.resolveAttachment(reference);
          if (resolved) {
            attachmentPaths.push(resolved);
            resolvedReferences.push(reference);
          } else
            warnings.push(
              `Attachment ${reference} in message ${messageId} could not be resolved.`,
            );
        }
        if (Array.isArray(data?.references)) {
          for (
            let referenceIndex = 0;
            referenceIndex < data.references.length;
            referenceIndex += 1
          ) {
            const reference = data.references[referenceIndex] as unknown;
            if (
              !isRecord(reference) ||
              typeof reference.artifactRef !== 'string'
            ) {
              warnings.push(
                `Attachment reference ${referenceIndex + 1} in message ${messageId} could not be resolved.`,
              );
              continue;
            }
            const artifactRef = reference.artifactRef;
            const resolved = destination.resolveAttachment(artifactRef);
            if (resolved) {
              attachmentPaths.push(resolved);
              resolvedReferences.push(artifactRef);
            } else
              warnings.push(
                `Attachment ${artifactRef} in message ${messageId} could not be resolved.`,
              );
          }
        }
        return {
          ...part,
          data:
            resolvedReferences.length > 0
              ? { attachmentPaths: Array.from(new Set(resolvedReferences)) }
              : undefined,
        };
      }
      return part;
    });
    return {
      ...message,
      messageId,
      chatId: destination.chatId,
      ...(parts.length > 0 ? { parts } : { parts: undefined }),
      importedAttachmentPaths: Array.from(new Set(attachmentPaths)),
    };
  });

  const converted = portalChatMessagesToPersisted(normalizedMessages);
  const messages = converted.messages.map((message, index) => {
    const paths = normalizedMessages[index]?.importedAttachmentPaths ?? [];
    return paths.length > 0 ? { ...message, attachmentPaths: paths } : message;
  });

  // The scope fields intentionally affect no persisted bytes. They document
  // the host-selected destination and keep the resolver interface symmetric
  // with the main-process writer that consumes this result.
  void destination.projectId;
  void destination.worktreeId;

  return {
    tab: {
      id: destination.chatId,
      title: published.title,
      ...(published.description ? { description: published.description } : {}),
      messages,
      createdAt: published.createdAt,
    },
    warnings,
  };
}
