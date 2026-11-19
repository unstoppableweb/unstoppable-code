import {
  collapseAgentArtifactsByItem,
  mergeAgentArtifactsByPrecedence,
  serializeAgentArtifactReceipts,
  type AgentArtifactReceiptV1,
} from '@canopy/protocol/agent-artifacts';
import type { RemoteControlChatMessage } from '@canopy/protocol/remote-control/shell';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readToolUseId(data: Record<string, unknown>): string | undefined {
  return typeof data.toolUseId === 'string'
    ? data.toolUseId
    : typeof data.tool_use_id === 'string'
      ? data.tool_use_id
      : undefined;
}

/**
 * Validated receipts carried by one successful tool result. Errors carry no
 * receipts, and anything that fails validation is dropped.
 */
function readResultReceipts(result: unknown): AgentArtifactReceiptV1[] {
  if (!isRecord(result) || result.isError === true) return [];
  if (result.agentArtifacts === undefined) return [];
  return serializeAgentArtifactReceipts(result.agentArtifacts);
}

/**
 * The capability receipts one turn produced, in transcript order. Reads only
 * the structured `agentArtifacts` metadata on folded `tool_use.data.result`
 * and standalone `tool_result.data` parts (never the truncated text output),
 * counts each tool call once when both representations are present,
 * collapses repeat mentions of one item to its latest receipt (a Found never
 * replaces a Recommended), and keeps one receipt per item (run > created/updated > recommended > found), as the
 * desktop projection does. Pipeline runs are kept for the shared run card;
 * GitHub workflow runs stay with their desktop row.
 */
export function collectTurnAgentArtifacts(
  messages: readonly RemoteControlChatMessage[],
): readonly AgentArtifactReceiptV1[] {
  const seenToolUseIds = new Set<string>();
  let receipts: AgentArtifactReceiptV1[] = [];
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (part.kind !== 'tool_use' && part.kind !== 'tool_result') continue;
      if (!isRecord(part.data)) continue;
      const toolUseId = readToolUseId(part.data);
      const result = part.kind === 'tool_use' ? part.data.result : part.data;
      const incoming = readResultReceipts(result);
      if (incoming.length === 0) continue;
      if (toolUseId !== undefined) {
        if (seenToolUseIds.has(toolUseId)) continue;
        seenToolUseIds.add(toolUseId);
      }
      receipts = mergeAgentArtifactsByPrecedence(receipts, incoming);
    }
  }
  return collapseAgentArtifactsByItem(receipts);
}
