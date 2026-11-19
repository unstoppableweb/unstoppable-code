import {
  isCanopyProxyErrorBody,
  parseCanopyProxyError,
} from '@canopy/protocol';
import type { RemoteControlChatMessage } from '@canopy/protocol/remote-control/shell';
import type { PersistedChatMessage } from '@canopy/agent-transcript/types';

type Message = PersistedChatMessage | RemoteControlChatMessage;

interface Row {
  promptBoundary: boolean;
  boundary?: string;
  proxyFailure?: { code: string; correlationId: string | null };
  timer?: {
    turnId: string;
    userMessageId: string;
    startedAt: number;
    completedAt: number | null;
    outcome?: unknown;
  };
  creditNotice: boolean;
  content: boolean;
  answer: boolean;
  failed: boolean;
}

function describe(message: Message): Row {
  const portal = 'messageId' in message;
  const parts = portal
    ? (message.parts ?? [])
    : message.blocks.map((block) => ({ kind: block.type, data: block }));
  const text = portal
    ? message.text
    : message.blocks
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('\n');
  const root =
    portal ||
    (!message.hidden && !message.parentBlockId && !message.parentToolUseId);
  const creditNotice =
    root &&
    message.role === 'system' &&
    parseCanopyProxyError(text)?.code === 'no_billing_source' &&
    parts.every((part) => part.kind === 'text');
  const data =
    parts.length === 1 && parts[0].kind === 'turn_timer'
      ? parts[0].data
      : undefined;
  const timer =
    root &&
    message.role === 'system' &&
    data &&
    typeof data === 'object' &&
    'turnId' in data &&
    typeof data.turnId === 'string' &&
    'userMessageId' in data &&
    typeof data.userMessageId === 'string' &&
    'startedAt' in data &&
    typeof data.startedAt === 'number' &&
    'completedAt' in data &&
    (typeof data.completedAt === 'number' || data.completedAt === null) &&
    !('spawnedBy' in data)
      ? {
          turnId: data.turnId,
          userMessageId: data.userMessageId,
          startedAt: data.startedAt,
          completedAt: data.completedAt,
          outcome: 'outcome' in data ? data.outcome : undefined,
        }
      : undefined;
  const content =
    root &&
    (text.trim().length > 0 ||
      parts.some((part) => part.kind !== 'turn_timer'));
  const nativeFailure =
    root && message.role === 'assistant' && text.startsWith('API Error:');
  const proxyFailure =
    root &&
    parts.every((part) => part.kind === 'text') &&
    (message.role === 'system' ||
      (message.role === 'assistant' && isCanopyProxyErrorBody(text)))
      ? parseCanopyProxyError(text)
      : null;
  return {
    promptBoundary:
      root &&
      message.role === 'user' &&
      !parts.some((part) => part.kind === 'tool_result'),
    ...(proxyFailure
      ? {
          proxyFailure: {
            code: proxyFailure.code,
            correlationId: proxyFailure.correlationId,
          },
        }
      : {}),
    boundary:
      root && message.role === 'user' && text.trim()
        ? portal
          ? message.messageId
          : message.id
        : undefined,
    timer,
    creditNotice,
    content,
    answer:
      root &&
      message.role === 'assistant' &&
      text.trim().length > 0 &&
      !parseCanopyProxyError(text) &&
      !nativeFailure,
    failed:
      nativeFailure ||
      (portal &&
        (message.status === 'failed' || message.status === 'cancelled')) ||
      (root && message.role === 'system' && content),
  };
}

/**
 * Retry appends another canonical execution for the SAME prompt. Collapse only
 * its recovered credit-only notice and empty attempt footer, once that later
 * execution has a canonically completed answer. A canonically cancelled partial
 * answer only replaces the empty attempt footer; its credit notice stays.
 * Unknown outcomes, including legacy timers, retain their artifacts.
 * Stored history and queue stay intact.
 * Run before either host floats timers to the end of a turn.
 */
export function omitRecoveredCreditHoldArtifacts<T extends Message>(
  messages: readonly T[],
): T[] {
  const omitted = new Set<number>();
  const failures = new Map<
    string,
    Array<{ index: number; correlationId: string | null; liveFailure: boolean }>
  >();
  let execution: string | undefined;
  let anchor: string | undefined;
  let attempts: Array<{
    index: number;
    row: Row;
    rows: Array<{ index: number; row: Row }>;
  }> = [];
  const finish = (): void => {
    for (let index = 1; index < attempts.length; index++) {
      const later = attempts[index];
      const timer = later.row.timer;
      if (
        !timer ||
        timer.completedAt === null ||
        (timer.outcome !== 'completed' && timer.outcome !== 'cancelled') ||
        !later.rows.some(({ row }) => row.answer) ||
        later.rows.some(({ row }) => row.failed)
      )
        continue;
      for (const prior of attempts.slice(0, index)) {
        if (
          !prior.row.timer ||
          prior.row.timer.completedAt === null ||
          timer.turnId === prior.row.timer.turnId ||
          timer.startedAt <= prior.row.timer.completedAt
        )
          continue;
        const notices = prior.rows.filter(({ row }) => row.creditNotice);
        if (notices.length === 0) continue;
        if (timer.outcome === 'completed') {
          for (const notice of notices) omitted.add(notice.index);
        }
        // A partial answer or tool activity still earns its original metadata.
        if (prior.rows.every(({ row }) => row.creditNotice || !row.content)) {
          omitted.add(prior.index);
        }
      }
    }
    attempts = [];
  };
  messages.forEach((message, index) => {
    const row = describe(message);
    if (row.promptBoundary || (row.timer && row.timer.turnId !== execution)) {
      failures.clear();
      execution = row.timer?.turnId;
    }
    // Live assistant/error frames and the persisted snapshot can publish the
    // same refusal under different row ids. Fold only within this execution;
    // a different reference or a later prompt/retry remains a separate failure.
    if (row.proxyFailure) {
      const { code, correlationId } = row.proxyFailure;
      const liveFailure =
        'messageId' in message &&
        message.role === 'assistant' &&
        message.status === 'failed';
      const seen = failures.get(code) ?? [];
      const previous = seen.find(
        (failure) =>
          failure.correlationId === null ||
          correlationId === null ||
          failure.correlationId === correlationId,
      );
      if (previous) {
        // Portal's turn groups keep the failed live row over its saved echo.
        // Retain that same row here or neither id would reach the transcript.
        if (previous.liveFailure && !liveFailure) {
          omitted.add(index);
          return;
        }
        omitted.add(previous.index);
        previous.index = index;
        previous.correlationId = correlationId ?? previous.correlationId;
        previous.liveFailure = liveFailure;
      } else seen.push({ index, correlationId, liveFailure });
      failures.set(code, seen);
    }
    if (row.boundary !== undefined) {
      finish();
      anchor = row.boundary;
    } else if (row.timer && row.timer.userMessageId === anchor) {
      attempts.push({ index, row, rows: [] });
    } else {
      attempts.at(-1)?.rows.push({ index, row });
    }
  });
  finish();
  return omitted.size === 0
    ? [...messages]
    : messages.filter((_, index) => !omitted.has(index));
}
