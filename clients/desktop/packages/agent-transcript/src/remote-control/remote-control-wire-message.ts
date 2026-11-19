/**
 * The full Portal projection of one persisted message: the neutral
 * {@link persistedMessageToRemoteControlMessage} core plus managed delegation cards
 * bounded for the wire, account-proxy switch and skipped-Mod rows, and
 * canonical agent-artifact receipts.
 *
 * Browser-safe. The tool-family bucket is injected ({@link ToolFamilyResolver}):
 * the desktop passes its full `getRemoteControlChatToolFamily` so its output is
 * byte-for-byte unchanged; a host without one leaves `toolFamily` unset.
 */
import { extractCanonicalAgentArtifacts } from '@canopy/protocol/agent-artifacts';
import type {
  RemoteControlChatMessage,
  RemoteControlChatPart,
} from '@canopy/protocol/remote-control/shell';
import { pairToolResultOccurrences } from '@canopy/protocol/remote-control/shell';
import type { PersistedChatMessage } from '../types';
import {
  isRecord,
  persistedMessageToRemoteControlMessage as persistedMessageToRemoteControlMessageCore,
  type RemoteControlChatProjectionLimits,
  type ToolFamilyResolver,
} from './persisted-chat-projection';
import {
  REMOTE_CONTROL_DELEGATION_SUB_BLOCKS_MAX_COUNT,
  projectRemoteControlDelegationPart,
} from './delegation-wire-projection';

function hasUnboundedProjectionLimits(
  limits: RemoteControlChatProjectionLimits | undefined,
): boolean {
  return (
    limits !== undefined &&
    limits.textMaxChars === Number.POSITIVE_INFINITY &&
    limits.partTextMaxChars === Number.POSITIVE_INFINITY &&
    limits.objectMaxDepth === Number.POSITIVE_INFINITY &&
    limits.objectMaxKeys === Number.POSITIVE_INFINITY &&
    limits.arrayMaxItems === Number.POSITIVE_INFINITY
  );
}

function projectedChildPartCount(message: PersistedChatMessage): number {
  const pairs = pairToolResultOccurrences(message.blocks, (block) =>
    block.type === 'tool_use' || block.type === 'tool_result'
      ? { kind: block.type, toolUseId: block.toolUseId }
      : undefined,
  );
  const matchedResults = new Set(pairs.values());
  return message.blocks.reduce((count, block, blockIndex) => {
    if (
      block.type === 'tool_result' &&
      matchedResults.has(blockIndex) &&
      block.visualRef === undefined
    ) {
      return count;
    }
    if (
      block.type === 'text' ||
      block.type === 'thinking' ||
      block.type === 'tool_use' ||
      block.type === 'tool_result' ||
      block.type === 'image' ||
      block.type === 'compaction_info' ||
      block.type === 'mcp_activation' ||
      block.type === 'account_proxy_switch' ||
      block.type === 'claude_mods_skipped' ||
      block.type === 'delegated_agent_call'
    ) {
      return count + 1;
    }
    if (
      block.type === 'file_references' &&
      block.references.some((reference) => reference.kind !== 'plugin')
    ) {
      return count + 1;
    }
    if (block.type === 'turn_timer' && typeof block.completedAt === 'number') {
      return count + 1;
    }
    return count;
  }, 0);
}

function boundDelegationRelatedMessages(
  message: PersistedChatMessage,
  relatedMessages: readonly PersistedChatMessage[] | undefined,
): {
  relatedMessages: readonly PersistedChatMessage[] | undefined;
  omittedByBlockId: ReadonlyMap<string, number>;
} {
  if (relatedMessages === undefined) {
    return { relatedMessages, omittedByBlockId: new Map() };
  }
  const agentBlockIds = new Set(
    message.blocks.flatMap((block) =>
      block.type === 'delegated_agent_call' ? [block.agentBlockId] : [],
    ),
  );
  if (agentBlockIds.size === 0) {
    return { relatedMessages, omittedByBlockId: new Map() };
  }

  const retainedCounts = new Map<string, number>();
  const omittedByBlockId = new Map<string, number>();
  const retainedIndexes = new Set<number>();
  for (let index = relatedMessages.length - 1; index >= 0; index -= 1) {
    const child = relatedMessages[index];
    const parentBlockId = child?.parentBlockId;
    if (child === undefined || parentBlockId === undefined) continue;
    if (!agentBlockIds.has(parentBlockId)) continue;
    const retainedCount = retainedCounts.get(parentBlockId) ?? 0;
    if (retainedCount < REMOTE_CONTROL_DELEGATION_SUB_BLOCKS_MAX_COUNT) {
      retainedCounts.set(parentBlockId, retainedCount + 1);
      retainedIndexes.add(index);
      continue;
    }
    omittedByBlockId.set(
      parentBlockId,
      (omittedByBlockId.get(parentBlockId) ?? 0) +
        projectedChildPartCount(child),
    );
  }

  return {
    relatedMessages: relatedMessages.filter((_, index) =>
      retainedIndexes.has(index),
    ),
    omittedByBlockId,
  };
}

function projectDelegationPartsOnWire(
  message: RemoteControlChatMessage,
  omittedByBlockId: ReadonlyMap<string, number>,
): RemoteControlChatMessage {
  if (!message.parts?.some((part) => part.kind === 'agent')) return message;
  let changed = false;
  const parts = message.parts.flatMap((part): RemoteControlChatPart[] => {
    if (part.kind !== 'agent' || !isRecord(part.data)) return [part];
    const data = part.data;
    if (!isRecord(data.delegation)) return [part];
    const agentBlockId = data.delegation.agentBlockId;
    const omitted =
      typeof agentBlockId === 'string'
        ? (omittedByBlockId.get(agentBlockId) ?? 0)
        : 0;
    const prepared: RemoteControlChatPart =
      omitted > 0
        ? {
            ...part,
            data: {
              ...data,
              subBlocksTruncated: true,
              omittedSubBlocks:
                (typeof data.omittedSubBlocks === 'number' &&
                Number.isSafeInteger(data.omittedSubBlocks) &&
                data.omittedSubBlocks >= 0
                  ? data.omittedSubBlocks
                  : 0) + omitted,
            },
          }
        : part;
    const projected = projectRemoteControlDelegationPart(prepared);
    changed = true;
    // This is already a managed card: never restore stale/unbounded children.
    return projected === null ? [] : [projected];
  });
  return changed ? { ...message, parts } : message;
}

/**
 * Project a persisted message into a neutral portal message, stamping the
 * canonical tool family on each `tool_use` part through `toolFamilyFor`.
 */
export function persistedMessageToRemoteControlWireMessage(
  input: {
    scope: 'worktree' | 'standalone' | 'app_advisor';
    workspaceLocalId?: string;
    worktreeLocalId?: string;
    chatId: string;
    message: PersistedChatMessage;
    relatedMessages?: readonly PersistedChatMessage[];
    /** False for live/synthetic rows that cannot support canonical reads. */
    outputLocators?: boolean;
  },
  toolFamilyFor: ToolFamilyResolver | undefined,
  limits?: RemoteControlChatProjectionLimits,
): RemoteControlChatMessage {
  const shouldProjectDelegations = !hasUnboundedProjectionLimits(limits);
  const boundedChildren = shouldProjectDelegations
    ? boundDelegationRelatedMessages(input.message, input.relatedMessages)
    : {
        relatedMessages: input.relatedMessages,
        omittedByBlockId: new Map<string, number>(),
      };
  const message = persistedMessageToRemoteControlMessageCore(
    {
      ...input,
      relatedMessages: boundedChildren.relatedMessages,
      toolFamilyFor,
    },
    // The owner's Portal and transcript show the switch lines; only the
    // publish path, which calls the core projection, leaves them out.
    {
      ...limits,
      ...(input.outputLocators === undefined
        ? {}
        : { outputLocators: input.outputLocators }),
      includeAccountProxySwitches: true,
      includeClaudeModsSkipped: true,
      extractAgentArtifacts: extractCanonicalAgentArtifacts,
    },
  );
  return shouldProjectDelegations
    ? projectDelegationPartsOnWire(message, boundedChildren.omittedByBlockId)
    : message;
}
