import type { ExplorerTranscriptMessage } from '@canopy/protocol/settings/organization-memory';
import {
  remoteControlToolPartOccurrence,
  type RemoteControlChatMessage,
  type RemoteControlChatPart,
} from '@canopy/protocol/remote-control/shell';

// ---------------------------------------------------------------------------
// The settings transcript message (memory source transcripts and organization
// transcript sessions) as the neutral chat message the shared `ChatMessageView`
// renders. The server projects each message from a `RemoteControlChatMessage`
// (apps/web/src/lib/org-transcripts/session-read.ts `toTranscriptMessage`), so
// this only restores the field names and drops anything it can't read.
// ---------------------------------------------------------------------------

const PART_KINDS: ReadonlySet<string> = new Set<RemoteControlChatPart['kind']>([
  'mcp_activation',
  'text',
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
  'account_switch',
  'mods_skipped',
]);

function isPartKind(value: unknown): value is RemoteControlChatPart['kind'] {
  return typeof value === 'string' && PART_KINDS.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The parts the renderer understands; unknown kinds and malformed entries are dropped. */
function readParts(value: unknown): RemoteControlChatPart[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts: RemoteControlChatPart[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !isPartKind(entry.kind)) continue;
    // Tool calls pair with their results by occurrence.
    const occurrence = remoteControlToolPartOccurrence(entry);
    parts.push({
      kind: entry.kind,
      ...(entry.data === undefined ? {} : { data: entry.data }),
      ...(occurrence === undefined ? {} : { occurrence }),
    });
  }
  return parts;
}

function readRole(role: string): RemoteControlChatMessage['role'] {
  return role === 'user' || role === 'system' ? role : 'assistant';
}

function readStatus(status: string): RemoteControlChatMessage['status'] {
  return status === 'failed' || status === 'cancelled' ? status : 'complete';
}

/**
 * A finished transcript message for `ChatMessageView`. A stored transcript is
 * never streaming, so an unknown or in-progress status renders as complete.
 */
export function toDesktopTranscriptChatMessage(
  message: ExplorerTranscriptMessage,
): RemoteControlChatMessage {
  const createdAtMs = Date.parse(message.occurredAt);
  const parts = readParts(message.parts);
  return {
    messageId: message.localMessageId,
    chatId: message.localChatId,
    role: readRole(message.role),
    status: readStatus(message.status),
    text: message.content,
    createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : 0,
    ...(parts === undefined ? {} : { parts }),
  };
}
