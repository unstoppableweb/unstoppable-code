import {
  foldedRemoteControlToolOccurrenceIds,
  isFoldedRemoteControlToolResult,
  pairToolResultOccurrences,
  remoteControlToolPartOccurrence,
  readRemoteControlChatPartVisual,
  readToolInterruption,
} from '@canopy/protocol/remote-control/shell';
import { hideDelegationTransportParts } from './delegation-display';

function isRecordPart(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function partsOf(message: { parts?: unknown }): readonly unknown[] {
  return Array.isArray(message.parts) ? message.parts : [];
}

function isPromptSourcePart(part: unknown): boolean {
  return isRecordPart(part) && (part.kind ?? part.type) === 'prompt_source';
}

function startsOwningTurn(message: unknown): boolean {
  if (
    !isRecordPart(message) ||
    message.role !== 'user' ||
    message.continuesTurn === true
  )
    return false;
  const parts = partsOf(message);
  if (
    parts.some(
      (part) =>
        isRecordPart(part) &&
        part.kind === 'steering' &&
        isRecordPart(part.data) &&
        part.data.startsTurn === false,
    )
  )
    return false;
  // Native tool responses can carry the user role and a prompt-source part.
  return !(
    parts.some(
      (part) =>
        isRecordPart(part) && (part.kind ?? part.type) === 'tool_result',
    ) &&
    parts.every(
      (part) =>
        isPromptSourcePart(part) ||
        (isRecordPart(part) && (part.kind ?? part.type) === 'tool_result'),
    )
  );
}

function resultOutput(result: Record<string, unknown>): string {
  return typeof result.output === 'string'
    ? result.output
    : typeof result.content === 'string'
      ? result.content
      : typeof result.text === 'string'
        ? result.text
        : '';
}

/**
 * A tool_result part that carries a visual, reduced to what renders it. The
 * visual stays its own part, so its duplicated output text is dropped.
 */
function visualResultPart(part: unknown): Record<string, unknown> | undefined {
  if (!isRecordPart(part) || (part.kind ?? part.type) !== 'tool_result')
    return undefined;
  const visual = readRemoteControlChatPartVisual({
    kind: 'tool_result',
    data: part.data,
  });
  if (!visual) return undefined;
  const data = isRecordPart(part.data) ? part.data : {};
  return {
    kind: 'tool_result',
    data: {
      ...(typeof data.toolUseId === 'string'
        ? { toolUseId: data.toolUseId }
        : {}),
      ...(typeof data.messageId === 'string'
        ? { messageId: data.messageId }
        : {}),
      visual,
    },
  };
}

/**
 * Fold standalone tool_result messages into their paired tool_use parts.
 *
 * Live-streamed turns deliver the tool call and its result as SEPARATE portal
 * messages (the result is keyed by its tool_use_id so delivery stays
 * idempotent). Rendering them raw shows the tool card with a perpetual
 * pending spinner plus a duplicate "Tool result" row — the desktop folds the
 * result into the call, and so does the persisted-snapshot path, so the live
 * path must match. Only consumed result parts are removed; unmatched results
 * stay visible. Result-only rows whose parts were all consumed are dropped,
 * including their legacy duplicated output text. A result with a visual stays
 * as a visual part; one without output pairs with nothing.
 */
export function foldToolResultsIntoToolUses<
  T extends { parts?: unknown; text?: string; content?: string },
>(inputMessages: readonly T[]): T[] {
  const visible = hideDelegationTransportParts(inputMessages);
  // A merge can keep a result part beside the call it was already folded into.
  const alreadyFolded = foldedRemoteControlToolOccurrenceIds(
    visible.flatMap((message) => partsOf(message)),
  );
  const messages =
    alreadyFolded.size === 0
      ? visible
      : visible.flatMap((message) => {
          const parts = partsOf(message);
          const kept = parts.filter(
            (part) =>
              visualResultPart(part) !== undefined ||
              !isFoldedRemoteControlToolResult(part, alreadyFolded),
          );
          if (kept.length === parts.length) return [message];
          return kept.length === 0 ? [] : [{ ...message, parts: kept }];
        });
  let turn = 0;
  const occurrences = messages.flatMap((message) => {
    if (startsOwningTurn(message)) turn++;
    return partsOf(message).map((part) => ({ part, turn }));
  });
  const pairs = pairToolResultOccurrences(occurrences, ({ part, turn }) => {
    if (!isRecordPart(part)) return undefined;
    const kind = part.kind ?? part.type;
    if (kind !== 'tool_use' && kind !== 'tool_result') return undefined;
    const data = isRecordPart(part.data) ? part.data : part;
    if (kind === 'tool_use' && data.result !== undefined) return undefined;
    if (
      kind === 'tool_result' &&
      visualResultPart(part) &&
      resultOutput(data).length === 0
    )
      return undefined;
    const toolUseId =
      typeof data.toolUseId === 'string'
        ? data.toolUseId
        : typeof data.tool_use_id === 'string'
          ? data.tool_use_id
          : undefined;
    const occurrence = remoteControlToolPartOccurrence(part);
    return toolUseId
      ? {
          kind,
          toolUseId: JSON.stringify([turn, toolUseId]),
          ...(occurrence ? { occurrenceId: occurrence.id } : {}),
        }
      : undefined;
  });
  if (
    pairs.size === 0 &&
    !occurrences.some(({ part }) => visualResultPart(part))
  )
    return messages;
  const consumed = new Set(pairs.values());

  const folded: T[] = [];
  let occurrenceIndex = 0;
  for (const message of messages) {
    const parts = partsOf(message);
    let changed = false;
    let consumedHere = false;
    const nextParts = parts.flatMap((part) => {
      const index = occurrenceIndex++;
      const visual = visualResultPart(part);
      if (visual) {
        changed = true;
        return [visual];
      }
      if (consumed.has(index)) {
        changed = true;
        consumedHere = true;
        return [];
      }
      const resultIndex = pairs.get(index);
      const resultPart =
        resultIndex !== undefined ? occurrences[resultIndex]?.part : undefined;
      if (!isRecordPart(part) || !isRecordPart(resultPart)) return [part];
      const data = isRecordPart(part.data) ? part.data : part;
      const result = isRecordPart(resultPart.data)
        ? resultPart.data
        : resultPart;
      const output = resultOutput(result);
      const interruption = readToolInterruption(result.interruption);
      changed = true;
      const occurrence = remoteControlToolPartOccurrence(resultPart);
      return [
        {
          ...part,
          ...(occurrence ? { occurrence } : {}),
          data: {
            ...data,
            result: {
              output,
              isError: result.isError === true || result.is_error === true,
              ...(interruption ? { interruption } : {}),
              ...(resultPart.outputLocator
                ? { outputLocator: resultPart.outputLocator }
                : {}),
              // Structured receipts outlive the truncated output; the
              // transcript validates them before rendering capability tiles.
              ...(result.agentArtifacts !== undefined
                ? { agentArtifacts: result.agentArtifacts }
                : {}),
            },
          },
        },
      ];
    });
    // Result content now lives inside the paired tool_use card. Drop the
    // standalone tool_result message even when it carries text — runtime
    // tool-result events historically duplicated the result output into
    // `content`, which rendered the raw result again as a response bubble.
    // A user-role result row's prompt_source marker alone renders nothing.
    if (
      parts.length > 0 &&
      (nextParts.length === 0 ||
        (consumedHere && nextParts.every(isPromptSourcePart)))
    ) {
      continue;
    }
    folded.push(changed ? { ...message, parts: nextParts } : message);
  }
  return folded;
}
