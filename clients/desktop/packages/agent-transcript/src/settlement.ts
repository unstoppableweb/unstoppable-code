import {
  TOOL_SETTLEMENT_OUTPUT,
  readToolInterruption,
} from '@canopy/protocol/remote-control/shell';
import type { PersistedChatMessage, ToolInterruption } from './types';
import { isRootUserTurnBoundary } from './lib/turn-boundary';

/** A pure policy shared by persistence and restore projections. Times are epoch ms. */
export function selectInterruptedSettlementTime(input: {
  detectedAt: number;
  startedAt?: number;
  completedAt?: number | null;
  activity: readonly number[];
  runtimeActivityAt?: number;
  runtimeBelongsToTurn?: boolean;
}): number {
  const detectedAt =
    Number.isFinite(input.detectedAt) && input.detectedAt >= 0
      ? input.detectedAt
      : 0;
  const valid = (value: number | null | undefined): value is number =>
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= detectedAt;
  const start = valid(input.startedAt) ? input.startedAt : 0;
  if (valid(input.completedAt) && input.completedAt >= start)
    return input.completedAt;
  let latest: number | undefined;
  for (const time of input.activity)
    if (valid(time)) latest = Math.max(latest ?? 0, time);
  if (input.runtimeBelongsToTurn && valid(input.runtimeActivityAt))
    latest = Math.max(latest ?? 0, input.runtimeActivityAt);
  return Math.max(
    start,
    latest ?? (valid(input.startedAt) ? start : detectedAt),
  );
}

/** Never infer synthetic origin from output text alone. */
export function isSyntheticSettlementMessage(
  message: PersistedChatMessage,
): boolean {
  return (
    message.role === 'system' &&
    (message.id.startsWith('archive-cancel-') ||
      (message.blocks.length > 0 &&
        message.blocks.every(
          (block) =>
            block.type === 'tool_result' &&
            readToolInterruption(block.interruption) !== undefined,
        )))
  );
}

export function persistedInterruptedTurnRange(
  messages: readonly PersistedChatMessage[],
  userMessageId?: string,
): { start: number; end: number } {
  let start = userMessageId
    ? messages.findIndex((message) => message.id === userMessageId)
    : -1;
  if (start < 0 && userMessageId)
    return { start: messages.length, end: messages.length };
  if (start < 0) {
    for (let index = messages.length - 1; index >= 0; index--) {
      if (isRootUserTurnBoundary(messages[index])) {
        start = index;
        break;
      }
    }
  }
  start = Math.max(0, start);
  let end = start + 1;
  while (end < messages.length && !isRootUserTurnBoundary(messages[end])) end++;
  return { start, end: Math.min(end, messages.length) };
}

export function persistedInterruptedSettlementTime(
  messages: readonly PersistedChatMessage[],
  detectedAt: number,
  runtime?: {
    activeTurn?: { userMessageId: string; startedAt: number };
    lastActivityAt?: number;
  },
): number {
  const range = persistedInterruptedTurnRange(
    messages,
    runtime?.activeTurn?.userMessageId,
  );
  const turn = messages.slice(range.start, range.end);
  const timer = turn
    .flatMap((message) => message.blocks)
    .find((block) => block.type === 'turn_timer');
  return selectInterruptedSettlementTime({
    detectedAt,
    startedAt:
      timer?.type === 'turn_timer'
        ? timer.startedAt
        : runtime?.activeTurn?.startedAt,
    completedAt: timer?.type === 'turn_timer' ? timer.completedAt : undefined,
    activity: turn
      .filter((message) => !isSyntheticSettlementMessage(message))
      .flatMap((message) => [
        message.timestamp,
        ...message.blocks.flatMap((block) => [
          ...('timestamp' in block && typeof block.timestamp === 'number'
            ? [block.timestamp]
            : []),
          ...(block.type === 'turn_timer'
            ? [block.pausedAt, block.resumedAt].filter(
                (at): at is number => typeof at === 'number',
              )
            : []),
        ]),
      ]),
    runtimeActivityAt: runtime?.lastActivityAt,
    runtimeBelongsToTurn:
      runtime?.activeTurn !== undefined &&
      range.end === messages.length &&
      range.start < range.end,
  });
}

/** Conservative legacy projection; original stored output remains untouched. */
export function settledToolInterruption(
  message: PersistedChatMessage,
  block: PersistedChatMessage['blocks'][number],
): ToolInterruption | undefined {
  if (block.type !== 'tool_result') return undefined;
  const explicit = readToolInterruption(block.interruption);
  if (explicit) return explicit;
  if (!isSyntheticSettlementMessage(message)) return undefined;
  for (const reason of ['app_restart', 'fork', 'stopped'] as const)
    if (block.output === TOOL_SETTLEMENT_OUTPUT[reason])
      return { reason, at: message.timestamp };
  return undefined;
}

/** Accepted genuine outcomes win over settlement placeholders within their
 * owning turn. Retain carrier ids/timestamps so transcript anchors stay stable. */
export function supersedeToolInterruptions(
  messages: PersistedChatMessage[],
): PersistedChatMessage[] {
  if (
    !messages.some((message) =>
      message.blocks.some((block) => settledToolInterruption(message, block)),
    )
  )
    return messages;
  const realResults = new Set<string>();
  let turn = '';
  const key = (message: PersistedChatMessage, toolUseId: string): string =>
    JSON.stringify([
      message.parentBlockId || message.parentToolUseId ? '' : turn,
      message.parentBlockId ?? message.parentToolUseId ?? '',
      message.codexThreadId ?? '',
      message.codexTurnId ?? '',
      toolUseId,
    ]);
  for (const message of messages) {
    if (isRootUserTurnBoundary(message)) turn = message.id;
    for (const block of message.blocks)
      if (
        block.type === 'tool_result' &&
        !settledToolInterruption(message, block)
      )
        realResults.add(key(message, block.toolUseId));
  }
  turn = '';
  let changed = false;
  const next = messages.map((message) => {
    if (isRootUserTurnBoundary(message)) turn = message.id;
    const blocks = message.blocks.filter(
      (block) =>
        !(
          block.type === 'tool_result' &&
          settledToolInterruption(message, block) &&
          realResults.has(key(message, block.toolUseId))
        ),
    );
    if (blocks.length === message.blocks.length) return message;
    changed = true;
    return { ...message, blocks };
  });
  return changed ? next : messages;
}
