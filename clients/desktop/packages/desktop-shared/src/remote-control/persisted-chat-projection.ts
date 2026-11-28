import { isRootUserTurnBoundary } from '@canopy/agent-transcript/lib/turn-boundary';
import { extractCanonicalAgentArtifacts } from '../lib/agent-artifacts';
/**
 * Desktop-shared portal chat projection.
 *
 * The projection now lives in the browser-safe `@canopy/agent-transcript`
 * package so the hosted web run viewer (CAN-396) can reuse it. This module is
 * the thin desktop adapter: it injects the desktop's full `getRemoteControlChatToolFamily`
 * resolver so the desktop portal-sync output (with `toolFamily` stamped on
 * `tool_use` parts) is byte-for-byte unchanged, and re-exports the neutral
 * helpers at this path so existing importers are unaffected.
 */
import {
  getModelDisplayName,
  type PersistedChatMessage,
  type PersistedChatTab,
} from '../types';
import type {
  RemoteControlChatMessage,
  RemoteControlChatPart,
  RemoteControlTurnTimerAutoRoutedModel,
} from '@canopy/protocol/remote-control/shell';
import {
  REMOTE_CONTROL_CHAT_UNBOUNDED_LIMITS,
  isRecord,
  persistedParts as persistedPartsCore,
  delegationRootMessages,
  isVisiblePersistedChatMessage,
  type RemoteControlChatProjectionLimits,
} from '@canopy/agent-transcript';
import { getRemoteControlChatToolFamily } from '../lib/remote-control-tool-family';
import { persistedMessageToRemoteControlWireMessage } from '@canopy/agent-transcript/remote-control/remote-control-wire-message';
import { withTurnTimerEnds } from '@canopy/agent-transcript/remote-control/turn-timer-ends';

export {
  REMOTE_CONTROL_CHAT_PART_TEXT_MAX_CHARS,
  REMOTE_CONTROL_CHAT_SEED_MAX_BYTES,
  REMOTE_CONTROL_CHAT_SEED_MESSAGE_LIMIT,
  REMOTE_CONTROL_CHAT_TEXT_MAX_CHARS,
  REMOTE_CONTROL_CHAT_TRANSCRIPT_MESSAGE_LIMIT,
  deriveRuntimeChatMessageId,
  isRecord,
  limitRemoteControlChatTranscript,
  limitRemoteControlChatTranscriptForSeed,
  limitRemoteControlChatTranscriptForSeedWithMetadata,
  remoteControlChatMessageAttachmentsFromPaths,
  type RemoteControlChatTranscriptSeed,
  summarizeUnknown,
  truncateText,
  truncateToolInput,
} from '@canopy/agent-transcript';

/** Project a persisted message's blocks into portal parts, tool-family stamped. */
export function persistedParts(
  message: PersistedChatMessage,
): RemoteControlChatPart[] {
  return persistedPartsCore(message, getRemoteControlChatToolFamily, {
    includeAccountProxySwitches: true,
    includeClaudeModsSkipped: true,
    extractAgentArtifacts: extractCanonicalAgentArtifacts,
  });
}

/**
 * Project a persisted message into a neutral portal message, stamping the
 * canonical tool family on each `tool_use` part via `getRemoteControlChatToolFamily`.
 * The projection lives in `@canopy/agent-transcript`; see
 * {@link persistedMessageToRemoteControlWireMessage}.
 */
export function persistedMessageToRemoteControlMessage(
  input: Parameters<typeof persistedMessageToRemoteControlWireMessage>[0],
  limits?: RemoteControlChatProjectionLimits,
): RemoteControlChatMessage {
  return persistedMessageToRemoteControlWireMessage(
    input,
    getRemoteControlChatToolFamily,
    limits,
  );
}

/**
 * The `turn_timer` data fields attributing a turn to the model Auto picked
 * (see {@link RemoteControlTurnTimerAutoRoutedModel}), or `undefined` when the turn
 * was not routed by Auto. `autoRoutedModels` is the chat tab's map of
 * user message id to routed model.
 */
export function turnTimerAutoRoutedModelData(
  autoRoutedModels: Readonly<Record<string, string>> | undefined,
  userMessageId: string | undefined,
): RemoteControlTurnTimerAutoRoutedModel | undefined {
  const model =
    userMessageId === undefined ? undefined : autoRoutedModels?.[userMessageId];
  return model === undefined
    ? undefined
    : {
        autoRoutedModel: model,
        autoRoutedModelLabel: getModelDisplayName(model),
      };
}

/** Stamp Auto-routing attribution onto a projected message's timer parts. */
function withAutoRoutedModel(
  message: RemoteControlChatMessage,
  attribution: RemoteControlTurnTimerAutoRoutedModel | undefined,
): RemoteControlChatMessage {
  if (attribution === undefined || !message.parts) return message;
  return {
    ...message,
    parts: message.parts.map((part) =>
      part.kind === 'turn_timer' && isRecord(part.data)
        ? { ...part, data: { ...part.data, ...attribution } }
        : part,
    ),
  };
}

/**
 * True when a persisted message is a turn-timer carrier: the renderer persists
 * each turn's timer as its own `system` message holding a completed
 * `turn_timer` block. Used by {@link projectPersistedChatTranscript} to re-key
 * those rows into the wire timer namespace. A canonical timer (one carrying
 * its turn id) already has the id the live projection uses, so it is left out.
 */
function isCompletedTurnTimerMessage(message: PersistedChatMessage): boolean {
  return (
    message.role === 'system' &&
    message.blocks.some(
      (block) =>
        block.type === 'turn_timer' &&
        block.turnId === undefined &&
        typeof block.completedAt === 'number',
    )
  );
}

/**
 * Project a persisted transcript into neutral portal messages, converging each
 * turn's persisted timer row onto the LIVE wire timer id.
 *
 * The legacy live turn timer (`createPortalTurnTimer`, removed in turn-state
 * phases 42h and 43i) was emitted under `` `${userMessageId}:turn-timer` ``, while the renderer
 * persists its own timer row under a renderer-minted message id. Projecting
 * the persisted row under that minted id put the SAME logical timer on the
 * wire under two different messageIds, so the browser's upsert-by-id could not
 * collapse them — a refreshed portal transcript showed both a stale
 * "Working…" row (the cached live streaming frame) and the completed row (the
 * snapshot projection). Re-keying the first completed timer row of each turn
 * to `` `${userMessageId}:turn-timer` `` makes snapshot/history re-pushes
 * supersede the cached live frames instead of duplicating them.
 *
 * Only the FIRST completed timer per turn converges (the live path emits at
 * most one timer per turn); later continuation timers keep their persisted ids
 * so they never collide with each other.
 */
export function projectPersistedChatTranscript(input: {
  scope: 'worktree' | 'standalone' | 'app_advisor';
  workspaceLocalId?: string;
  worktreeLocalId?: string;
  chatId: string;
  messages: PersistedChatMessage[];
  /**
   * `wire` (default) keeps the portal caps. `local` is the projection a host
   * renders its own transcript from: nothing truncated, in-flight turn timers
   * (with their message marked streaming) and local image sources included,
   * so the shared transcript can stand in for the desktop's. Never publish a
   * `local` projection.
   */
  fidelity?: 'wire' | 'local';
  /**
   * The chat tab's `autoRoutedModels` (user message id → model Auto picked).
   * Each turn's timer carries its routed model so remote transcripts show the
   * same "Picked by model routing" chip as the desktop.
   */
  autoRoutedModels?: Readonly<Record<string, string>>;
  /** Main-owned outcomes, keyed by the turn's user message, retained on reload. */
  turnEnds?: PersistedChatTab['turnEnds'];
  unacceptedTurnEnds?: PersistedChatTab['unacceptedTurnEnds'];
  interruptedTurns?: PersistedChatTab['interruptedTurns'];
}): RemoteControlChatMessage[] {
  const limits: RemoteControlChatProjectionLimits | undefined =
    input.fidelity === 'local'
      ? {
          ...REMOTE_CONTROL_CHAT_UNBOUNDED_LIMITS,
          includeInFlightTurnTimers: true,
          includeLocalImageSources: true,
        }
      : { includeAssetReferences: input.scope !== 'app_advisor' };
  // Only the LIVE turn — the messages after the last user message — may
  // carry an in-flight timer and read as streaming. A persisted timer that
  // never completed on an earlier turn (a crash, a killed process) is stale
  // evidence, not a running turn, so it projects like any completed message.
  const visibleMessages = input.messages.filter(isVisiblePersistedChatMessage);
  const rootMessages = delegationRootMessages(visibleMessages);
  const liveTurnStart = rootMessages.reduce(
    (start, message, index) =>
      isRootUserTurnBoundary(message) ? index : start,
    0,
  );
  let turnUserMessageId: string | undefined;
  let turnTimerConverged = false;
  const projectedRows = rootMessages.map((message, index) => {
    if (isRootUserTurnBoundary(message)) {
      turnUserMessageId = message.id;
      turnTimerConverged = false;
    }
    const messageLimits =
      limits === undefined || index >= liveTurnStart
        ? limits
        : { ...limits, includeInFlightTurnTimers: false };
    const projected = withAutoRoutedModel(
      persistedMessageToRemoteControlMessage(
        {
          scope: input.scope,
          workspaceLocalId: input.workspaceLocalId,
          worktreeLocalId: input.worktreeLocalId,
          chatId: input.chatId,
          message,
          relatedMessages: visibleMessages,
        },
        messageLimits,
      ),
      // A window that opens mid-turn has no user row yet, so that partial
      // turn's timer carries no chip; the renderer-minted timer id cannot
      // name its user message.
      turnTimerAutoRoutedModelData(input.autoRoutedModels, turnUserMessageId),
    );
    if (
      turnUserMessageId !== undefined &&
      !turnTimerConverged &&
      isCompletedTurnTimerMessage(message)
    ) {
      turnTimerConverged = true;
      return {
        ...projected,
        messageId: `${turnUserMessageId}:turn-timer`,
      };
    }
    return projected;
  });
  return mergeSuffixedPersistedMessages(
    withTurnTimerEnds(rootMessages, projectedRows, input),
  );
}

/**
 * Converge renderer-suffixed persisted ids back onto one wire row (CAN-2608).
 *
 * The Claude stream-json path can emit several `assistant` events sharing one
 * SDK `message.id` (one per content block). The wire projector upserts them
 * all onto ONE portal row, but the renderer persists each event as its own
 * message with `ensureUniqueMessageId` suffixes (`base`, `base:2`, …). A
 * snapshot seed that re-pushed both verbatim put the SAME logical message on
 * the wire under two ids, so the browser rendered it twice (most visibly: a
 * duplicated ask-user tool row). Merging a suffixed row into its present base
 * row — parts appended in order, non-empty texts joined, terminal fields from
 * the later event — yields the renderer's complete view under the live id.
 *
 * Only rows whose suffix is `:<digits>` AND whose base id exists in the same
 * projection with the same role merge; anything else (e.g. `:turn-timer`
 * rows) passes through untouched.
 */
function mergeSuffixedPersistedMessages(
  messages: RemoteControlChatMessage[],
): RemoteControlChatMessage[] {
  const byId = new Map<string, RemoteControlChatMessage>();
  const out: RemoteControlChatMessage[] = [];
  for (const message of messages) {
    const match = /^(.+):\d+$/.exec(message.messageId);
    const base = match ? byId.get(match[1]) : undefined;
    if (base !== undefined && base.role === message.role) {
      const parts = [...(base.parts ?? []), ...(message.parts ?? [])];
      const text = [base.text, message.text].filter(Boolean).join('\n\n');
      // Timestamps merge only across values that EXIST. Consumers resolve a
      // message's display time as `updatedAtMs ?? createdAtMs`, and `0` is not
      // nullish: folding absent timestamps into `Math.max(… ?? 0, … ?? 0)`
      // stamped `updatedAtMs: 0` on every converged row, so
      // `persistedMessageToRemoteControlMessage` (which sets `createdAtMs` only) sent
      // each multi-block answer to the wire dated to the epoch. The cowork
      // transcript sorts by that time, so those answers jumped above the whole
      // conversation and read as missing.
      const createdCandidates = [base.createdAtMs, message.createdAtMs].filter(
        (value): value is number => typeof value === 'number',
      );
      const updatedCandidates = [base.updatedAtMs, message.updatedAtMs].filter(
        (value): value is number => typeof value === 'number',
      );
      Object.assign(base, {
        text,
        status: message.status,
        ...(createdCandidates.length > 0
          ? { createdAtMs: Math.min(...createdCandidates) }
          : {}),
        ...(updatedCandidates.length > 0
          ? { updatedAtMs: Math.max(...updatedCandidates) }
          : {}),
        ...(parts.length > 0 ? { parts } : {}),
        ...(message.hasAgentActivity === true
          ? { hasAgentActivity: true }
          : {}),
      });
      continue;
    }
    byId.set(message.messageId, message);
    out.push(message);
  }
  return out;
}
