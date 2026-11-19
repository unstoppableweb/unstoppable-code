import type { ChatSecretScope } from './chat-secret-store';

/*
 * RunWithSecrets commands running now, per chat, so the chat's Stop ends
 * them: a command holds secrets in its environment and must not outlive the
 * turn the person stopped. Kept free of other imports so the session
 * manager can load it.
 */

const running = new Map<string, Set<() => void>>();

function chatKey(scope: ChatSecretScope): string {
  return [scope.projectId, scope.worktreeId, scope.chatId].join('\0');
}

/** Registers a running command's stop; returns its removal. */
export function registerRunningSecretCommand(
  scope: ChatSecretScope,
  stop: () => void,
): () => void {
  const key = chatKey(scope);
  const stops = running.get(key) ?? new Set<() => void>();
  stops.add(stop);
  running.set(key, stops);
  return () => {
    stops.delete(stop);
    if (!stops.size && running.get(key) === stops) running.delete(key);
  };
}

/** Stops every RunWithSecrets command the chat is running. Never throws. */
export function stopRunningSecretCommands(scope: ChatSecretScope): void {
  for (const stop of [...(running.get(chatKey(scope)) ?? [])]) {
    try {
      stop();
    } catch {
      // A command that already ended has nothing to stop.
    }
  }
}
