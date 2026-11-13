// ---------------------------------------------------------------------------
// Continue-on-AI-Credits request (renderer)
// ---------------------------------------------------------------------------
//
// A one-shot request the resume dialog leaves for a chat's usage-limit banner
// (CAN-5013): the person chose "On AI Credits now", the dialog closed and
// opened the chat, and the banner, which owns routing and the resend, runs its
// own credits action once it sees the request. Mirrors `chatPanelReveal`: one
// pending record, a newer request replaces an older one, and it expires so a
// banner that mounts on a later visit cannot spend.
//
// Matching is by chat id only. The registry names a cowork chat as
// `{ STANDALONE_CHAT_PROJECT_ID, <workspaceId>, chatId }`, while the live
// banner is keyed by the chat store's own ids, so a full-key match would miss
// cowork chats. Chat ids are unique and only one request is ever pending.
// `projectId` and `worktreeId` stay on the record for diagnostics.

export interface ContinueOnAiCreditsTarget {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

/** Long enough for a cold workspace switch, short enough to go stale. */
export const CONTINUE_ON_AI_CREDITS_TTL_MS = 30_000;

type Listener = () => void;

const listeners = new Set<Listener>();
let pending: (ContinueOnAiCreditsTarget & { at: number }) | null = null;

function isLive(chatId: string, now: number): boolean {
  return (
    pending !== null &&
    pending.chatId === chatId &&
    now - pending.at <= CONTINUE_ON_AI_CREDITS_TTL_MS
  );
}

function notify(): void {
  listeners.forEach((listener) => {
    listener();
  });
}

/** Ask the chat's banner to continue on AI Credits once it is on screen. */
export function requestContinueOnAiCredits(
  target: ContinueOnAiCreditsTarget,
  now: number = Date.now(),
): void {
  pending = {
    projectId: target.projectId,
    worktreeId: target.worktreeId,
    chatId: target.chatId,
    at: now,
  };
  notify();
}

/** Whether a live request targets this chat. Never mutates. */
export function peekContinueOnAiCredits(
  chatId: string,
  now: number = Date.now(),
): boolean {
  return isLive(chatId, now);
}

/**
 * Take the request for this chat. Removes it, expired or not, and reports
 * whether it was still live. Another chat's request is left in place.
 */
export function consumeContinueOnAiCredits(
  chatId: string,
  now: number = Date.now(),
): boolean {
  if (pending?.chatId !== chatId) return false;
  const live = isLive(chatId, now);
  pending = null;
  notify();
  return live;
}

/** Subscribe to request and consume changes. Returns an unsubscribe fn. */
export function subscribeContinueOnAiCredits(listener: Listener): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}
