import { getJsonStringField } from '@canopy/agent-transcript/lib/message-transforms';
import { isRootUserTurnBoundary } from '@canopy/agent-transcript/lib/turn-boundary';
import type { PersistedChatMessage as ChatMessage } from '@canopy/agent-transcript/types';
import { isTurnTimerMessage } from './turn-utils';

// Display-message folding (tool results, agent and Codex agent blocks,
// structural sharing) lives in browser-safe `@canopy/agent-transcript` so the
// web app can share it. Re-exported here for existing desktop imports.
export {
  mergeToolResults,
  shareDisplayMessages,
} from '@canopy/agent-transcript/lib/message-transforms';

// ---------------------------------------------------------------------------
// Reorder messages so turn timers appear at end of their turn group
// ---------------------------------------------------------------------------

function getSingleTextBlockText(message: ChatMessage): string | null {
  if (message.blocks.length !== 1) {
    return null;
  }
  const block = message.blocks[0];
  return block.type === 'text' ? block.text : null;
}

function isPromptEchoWhitespace(codeUnit: number): boolean {
  return (
    (codeUnit >= 0x0009 && codeUnit <= 0x000d) ||
    codeUnit === 0x0020 ||
    codeUnit === 0x00a0 ||
    codeUnit === 0x1680 ||
    (codeUnit >= 0x2000 && codeUnit <= 0x200a) ||
    codeUnit === 0x2028 ||
    codeUnit === 0x2029 ||
    codeUnit === 0x202f ||
    codeUnit === 0x205f ||
    codeUnit === 0x3000 ||
    codeUnit === 0xfeff
  );
}

function skipPromptEchoWhitespace(value: string, offset: number): number {
  while (
    offset < value.length &&
    isPromptEchoWhitespace(value.charCodeAt(offset))
  ) {
    offset += 1;
  }
  return offset;
}

/**
 * Compare the same canonical form as `value.trim().replace(/\s+/g, ' ')`
 * without allocating two normalized copies of potentially large prompts.
 */
function haveEquivalentPromptEchoText(left: string, right: string): boolean {
  let leftOffset = skipPromptEchoWhitespace(left, 0);
  let rightOffset = skipPromptEchoWhitespace(right, 0);

  while (leftOffset < left.length && rightOffset < right.length) {
    const leftWhitespace = isPromptEchoWhitespace(left.charCodeAt(leftOffset));
    const rightWhitespace = isPromptEchoWhitespace(
      right.charCodeAt(rightOffset),
    );
    if (leftWhitespace || rightWhitespace) {
      if (!leftWhitespace || !rightWhitespace) {
        return false;
      }
      leftOffset = skipPromptEchoWhitespace(left, leftOffset);
      rightOffset = skipPromptEchoWhitespace(right, rightOffset);
      continue;
    }
    if (left.charCodeAt(leftOffset) !== right.charCodeAt(rightOffset)) {
      return false;
    }
    leftOffset += 1;
    rightOffset += 1;
  }

  return (
    skipPromptEchoWhitespace(left, leftOffset) === left.length &&
    skipPromptEchoWhitespace(right, rightOffset) === right.length
  );
}

function isLikelyClaudeQueueEcho(
  messages: ChatMessage[],
  index: number,
): boolean {
  const message = messages[index];
  const nextMessage = messages[index + 1];
  if (
    !message ||
    !nextMessage ||
    message.role !== 'assistant' ||
    nextMessage.role !== 'user'
  ) {
    return false;
  }
  const messageText = getSingleTextBlockText(message);
  const nextText = getSingleTextBlockText(nextMessage);
  if (!messageText || !nextText) {
    return false;
  }
  return (
    Math.abs(nextMessage.timestamp - message.timestamp) <= 1_000 &&
    haveEquivalentPromptEchoText(messageText, nextText)
  );
}

/**
 * A canonical timer's turn anchor. Legacy timers carry no `turnId`, and a
 * canonical execution without a prompt carries no anchor. A continuation
 * after a tools load shares its prompt's anchor but heads its own turn.
 */
function canonicalTimer(
  message: ChatMessage,
): { anchor: string | undefined; toolsLoaded: boolean } | null {
  const block = message.blocks[0];
  return block?.type === 'turn_timer' && block.turnId !== undefined
    ? {
        anchor: block.userMessageId,
        toolsLoaded: block.spawnedBy?.toolsLoaded === true,
      }
    : null;
}

/** A wake's task label, spawning prompt and spawning call, from that call. */
function wakeCauseInTranscript(
  messages: readonly ChatMessage[],
  toolUseId: string,
): {
  taskLabel?: string;
  spawningUserMessageId?: string;
  spawningToolUseId?: string;
} {
  let prompt: string | undefined;
  for (const message of messages) {
    if (message.hidden) continue;
    if (isRootUserTurnBoundary(message)) prompt = message.id;
    for (const block of message.blocks) {
      if (block.type !== 'tool_use' || block.toolUseId !== toolUseId) continue;
      // A cron job's call names its work by its prompt.
      const taskLabel =
        getJsonStringField(block.input, 'description') ??
        getJsonStringField(block.input, 'command')?.split('\n')[0] ??
        getJsonStringField(block.input, 'prompt')?.split('\n')[0];
      return {
        ...(taskLabel ? { taskLabel: taskLabel.slice(0, 120) } : {}),
        ...(prompt === undefined ? {} : { spawningUserMessageId: prompt }),
        spawningToolUseId: toolUseId,
      };
    }
  }
  return {};
}

/** The display-only head row of a wake turn, built from its timer. */
function wakeBoundaryMessage(
  timer: ChatMessage,
  messages: readonly ChatMessage[],
): ChatMessage | null {
  const block = timer.blocks[0];
  if (
    block?.type !== 'turn_timer' ||
    block.turnId === undefined ||
    block.spawnedBy === undefined
  )
    return null;
  const toolUseId = block.spawnedBy.toolUseId;
  const cause =
    toolUseId === undefined ? {} : wakeCauseInTranscript(messages, toolUseId);
  // A tools-loaded continuation's load call is in its prompt's turn; when the
  // call's id isn't the transcript's, link the prompt.
  const prompt =
    block.spawnedBy.toolsLoaded &&
    cause.spawningUserMessageId === undefined &&
    block.userMessageId !== undefined
      ? { spawningUserMessageId: block.userMessageId }
      : {};
  return {
    // A canonical timer's id is `chatTurnTimerId(turnId)`, so this is the
    // wake's `wakeTurnKey`, the key its own turn diff is filed under (40f).
    id: `${timer.id}:wake`,
    role: 'system',
    timestamp: timer.timestamp,
    blocks: [
      {
        type: 'wake_boundary',
        turnId: block.turnId,
        ...cause,
        ...prompt,
        ...(block.spawnedBy.event ? { taskEvent: true } : {}),
        ...(block.spawnedBy.scheduled ? { scheduled: true } : {}),
        ...(block.spawnedBy.toolsLoaded ? { toolsLoaded: true } : {}),
        ...(block.spawnedBy.peerMessage ? { peerMessage: true } : {}),
      },
    ],
  };
}

/** Whether a canonical timer heads a wake's own turn in display. */
function startsWake(
  message: ChatMessage,
  canonical: { anchor: string | undefined; toolsLoaded: boolean },
  turnIds: ReadonlySet<string>,
): boolean {
  const block = message.blocks[0];
  return (
    block?.type === 'turn_timer' &&
    block.spawnedBy !== undefined &&
    (canonical.anchor === undefined ||
      !turnIds.has(canonical.anchor) ||
      canonical.toolsLoaded)
  );
}

/** A timer whose recorded cause is only another chat's message. */
function isPeerMessageOnlyCause(message: ChatMessage): boolean {
  const block = message.blocks[0];
  if (block?.type !== 'turn_timer' || block.spawnedBy === undefined)
    return false;
  const { peerMessage, ...rest } = block.spawnedBy;
  return peerMessage === true && Object.keys(rest).length === 0;
}

export function reorderMessagesForDisplay(
  messages: ChatMessage[],
  options: {
    /**
     * Keep the placement main's transcript turn index has always used: the
     * legacy timer, then timers with no anchor in the transcript, then the
     * anchor's own timers newest first. The index settles a prompt, picks its
     * reply and counts its work from this grouping; display alone folds a
     * later run with no prompt and no recorded cause into the turn it follows.
     */
    readonly indexOrder?: boolean;
    /**
     * Prompts whose completed turn is compacted on this page (rows missing
     * before a history cursor). A wake that only another chat's message
     * started stays in such a prompt's turn, so the turn's final reply and
     * its cursor cover the wake's rows until the full turn loads.
     */
    readonly compactedTurnIds?: ReadonlySet<string>;
  } = {},
): ChatMessage[] {
  // A canonical timer shows at the end of its anchor's turn wherever it was
  // appended, and every execution's timer shows (turn-state phase 40b).
  // Legacy timers keep their positional placement, the last one winning.
  const turnIds = new Set<string>();
  for (const message of messages) {
    if (!message.hidden && isRootUserTurnBoundary(message)) {
      turnIds.add(message.id);
    }
  }
  const anchoredTimers = new Map<string, ChatMessage[]>();
  // A prompt's later executions (a Stop and Resume) after its tools-loaded
  // continuation belong to that continuation's turn.
  const continuations = new Map<string, string>();
  // Where each timer row was appended. Executions are ordered by it, not by
  // `startedAt`, which a closing timer recomputes from the provider's duration.
  const timerPositions = new Map<ChatMessage, number>();
  // In display, a later run of an earlier prompt (a Resume) that starts after
  // a wake stays in the wake's turn with its rows, the latest turn, rather
  // than reaching back to the prompt above the wake. Main's index keeps
  // develop's placement, by anchor.
  const keepsPeerWakeIn = (promptId: string | undefined): boolean =>
    options.indexOrder === true ||
    (promptId !== undefined &&
      options.compactedTurnIds?.has(promptId) === true);
  let wakeTurnId: string | undefined;
  let promptId: string | undefined;
  for (const [position, message] of messages.entries()) {
    if (message.hidden) continue;
    if (isRootUserTurnBoundary(message)) {
      wakeTurnId = undefined;
      promptId = message.id;
      continue;
    }
    if (!isTurnTimerMessage(message)) continue;
    timerPositions.set(message, position);
    const canonical = canonicalTimer(message);
    if (
      canonical !== null &&
      options.indexOrder !== true &&
      !(isPeerMessageOnlyCause(message) && keepsPeerWakeIn(promptId)) &&
      startsWake(message, canonical, turnIds)
    ) {
      wakeTurnId = `${message.id}:wake`;
    }
    const anchor = canonical?.anchor;
    if (anchor === undefined || !turnIds.has(anchor)) continue;
    if (canonical?.toolsLoaded) {
      continuations.set(anchor, `${message.id}:wake`);
      continue;
    }
    const owner = wakeTurnId ?? continuations.get(anchor) ?? anchor;
    anchoredTimers.set(owner, [...(anchoredTimers.get(owner) ?? []), message]);
  }

  const result: ChatMessage[] = [];
  let pendingTimer: ChatMessage | null = null;
  const pendingCanonicalTimers: ChatMessage[] = [];
  let currentTurnId: string | undefined;
  // The prompt whose span this row is in, wakes included.
  let currentPromptId: string | undefined;
  const flushTurn = (): void => {
    // Newest first: a turn closes at its first timer, so the latest
    // execution's timer owns the turn and a resumed turn stays live. That
    // includes an execution with no prompt and no recorded cause, such as one
    // a reply from another chat started: it continues the turn it follows.
    // Before any turn boundary (a page that starts after its prompt) there is
    // no turn to own them; they stay as their own rows, in transcript order.
    const anchored =
      currentTurnId === undefined
        ? []
        : (anchoredTimers.get(currentTurnId) ?? []);
    if (options.indexOrder === true) {
      if (pendingTimer) result.push(pendingTimer);
      pendingTimer = null;
      result.push(
        ...pendingCanonicalTimers.splice(0),
        ...[...anchored].reverse(),
      );
      return;
    }
    const timers = [
      ...(pendingTimer ? [pendingTimer] : []),
      ...pendingCanonicalTimers.splice(0),
      ...anchored,
    ];
    pendingTimer = null;
    const newestFirst = currentTurnId === undefined ? -1 : 1;
    result.push(
      ...timers.sort(
        (a, b) =>
          newestFirst *
          ((timerPositions.get(b) ?? 0) - (timerPositions.get(a) ?? 0)),
      ),
    );
  };

  for (let index = 0; index < messages.length; index += 1) {
    const msg = messages[index];
    if (!msg || msg.hidden) {
      continue;
    }

    if (isLikelyClaudeQueueEcho(messages, index)) {
      continue;
    }

    if (isTurnTimerMessage(msg)) {
      const canonical = canonicalTimer(msg);
      // A wake heads its own turn (turn-state phase 40d), as does the
      // continuation after a tools load, where it was appended. Main's turn
      // index keeps one indexed turn per prompt but reads the prompt's own group.
      // The index groups a run another chat's message started as develop
      // did before that cause was recorded: the cause only labels the turn
      // in display, so every reply read stays the same.
      const indexIgnoresCause =
        isPeerMessageOnlyCause(msg) && keepsPeerWakeIn(currentPromptId);
      const wake =
        canonical !== null &&
        !indexIgnoresCause &&
        (canonical.anchor === undefined ||
          !turnIds.has(canonical.anchor) ||
          canonical.toolsLoaded)
          ? wakeBoundaryMessage(msg, messages)
          : null;
      if (wake !== null) {
        // The wake starts its own turn here, and its timer closes it.
        flushTurn();
        result.push(wake);
        currentTurnId = wake.id;
        anchoredTimers.set(wake.id, [
          msg,
          ...(anchoredTimers.get(wake.id) ?? []),
        ]);
      } else if (canonical === null) {
        pendingTimer = msg;
      } else if (
        canonical.anchor === undefined ||
        !turnIds.has(canonical.anchor)
      ) {
        pendingCanonicalTimers.push(msg);
      }
      continue;
    }

    if (isRootUserTurnBoundary(msg)) {
      flushTurn();
      currentTurnId = msg.id;
      currentPromptId = msg.id;
    }

    result.push(msg);
  }

  flushTurn();
  return result;
}
