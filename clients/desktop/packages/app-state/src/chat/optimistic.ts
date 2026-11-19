import type {
  RemoteControlChatMessage,
  RemoteControlChatMessageAttachment,
} from '@canopy/protocol/remote-control/shell';

/**
 * Optimistic user-echo + reconciliation for the shared chat store.
 *
 * Neutral port of `apps/web/src/components/remote-control/remote-control-chat-optimistic.ts`.
 * When the user sends, the UI wants the message to appear instantly rather than
 * waiting for the server round-trip. The store inserts an *optimistic*
 * `RemoteControlChatMessage` (marked by an `optimistic-` id prefix); when the
 * authoritative frame for that turn arrives via `chat.message`, the optimistic
 * echo is pruned so it does not double-render.
 *
 * Only the user echo is modelled here — the assistant's streaming reply is
 * driven by authoritative frames + the thread `status`. The store's
 * `addOptimisticUserMessage` also raises `status`/`turnActive` at send time
 * (the web original inserted a `pending` assistant placeholder for the same
 * purpose): the authoritative `turn_timer` streaming frame only lands after
 * the full host round trip, and without the raise the transcript showed no
 * working indicator until then.
 */

/** Marker prefix identifying a store-generated optimistic message. */
export const OPTIMISTIC_ID_PREFIX = 'optimistic-';

/**
 * Clock skew tolerated when matching an authoritative message to the optimistic
 * echo it supersedes.
 *
 * Divergence from the web original: `remote-control-chat-optimistic.ts` uses an
 * asymmetric lower-bounded window; this port uses a symmetric `|Δt|` window.
 * Both timestamps are logical *creation* times for the same send (client
 * `createdAtMs` vs. server `createdAtMs`), so they track closely — the symmetric
 * form is simpler and, like the original, assumes client/server clocks agree
 * within one second.
 */
export const RECONCILE_SKEW_MS = 1000;

/** True when a message is a store-generated optimistic echo. */
export function isOptimisticMessage(
  message: RemoteControlChatMessage,
): boolean {
  return message.messageId.startsWith(OPTIMISTIC_ID_PREFIX);
}

/**
 * Build an optimistic user echo for immediate display.
 *
 * A caller-supplied `localId` is normalized to carry {@link OPTIMISTIC_ID_PREFIX}
 * so {@link isOptimisticMessage} (and therefore reconciliation) always
 * recognizes it. Callers issuing concurrent sends should pass distinct
 * `createdAtMs`/`localId` values, since ids collide on an identical `createdAtMs`
 * with no `localId`.
 */
export function makeOptimisticUserMessage(args: {
  chatId: string;
  text: string;
  createdAtMs: number;
  localId?: string;
  attachments?: readonly RemoteControlChatMessageAttachment[];
}): RemoteControlChatMessage {
  const messageId =
    args.localId === undefined
      ? `${OPTIMISTIC_ID_PREFIX}${args.createdAtMs}-user`
      : args.localId.startsWith(OPTIMISTIC_ID_PREFIX)
        ? args.localId
        : `${OPTIMISTIC_ID_PREFIX}${args.localId}`;
  return {
    messageId,
    chatId: args.chatId,
    role: 'user',
    promptSource: 'human',
    status: 'complete',
    text: args.text,
    ...(args.attachments !== undefined && args.attachments.length > 0
      ? { attachments: [...args.attachments] }
      : {}),
    createdAtMs: args.createdAtMs,
  };
}

/**
 * True when `authoritative` (a non-optimistic frame) supersedes `optimistic`:
 * same role, identical text, within {@link RECONCILE_SKEW_MS}.
 */
function supersedes(
  optimistic: RemoteControlChatMessage,
  authoritative: RemoteControlChatMessage,
): boolean {
  return (
    optimistic.role === authoritative.role &&
    optimistic.text === authoritative.text &&
    Math.abs(optimistic.createdAtMs - authoritative.createdAtMs) <=
      RECONCILE_SKEW_MS
  );
}

/**
 * Remove optimistic echoes superseded by an authoritative message. A no-op when
 * `authoritative` is itself optimistic.
 */
export function reconcileOptimistic(
  messages: readonly RemoteControlChatMessage[],
  authoritative: RemoteControlChatMessage,
): RemoteControlChatMessage[] {
  if (isOptimisticMessage(authoritative)) {
    return [...messages];
  }
  return messages.filter(
    (message) =>
      !isOptimisticMessage(message) || !supersedes(message, authoritative),
  );
}

/**
 * True when `candidate` (a not-yet-inserted optimistic echo) is already covered
 * by an authoritative message in `messages`. Guards the late-echo race: if the
 * server frame arrives before the UI inserts the echo, `reconcileOptimistic`
 * ran against an empty optimistic set, so inserting the echo now would strand it
 * permanently. Callers skip the insert when this returns true.
 */
export function hasAuthoritativeMatch(
  messages: readonly RemoteControlChatMessage[],
  candidate: RemoteControlChatMessage,
): boolean {
  return messages.some(
    (message) =>
      !isOptimisticMessage(message) && supersedes(candidate, message),
  );
}
