type ScopeCatchUpResetHandler = (projectId: string, worktreeId: string) => void;

let scopeCatchUpResetHandler: ScopeCatchUpResetHandler | null = null;

export function registerStaleChatCatchUpResetHandler(
  handler: ScopeCatchUpResetHandler,
): void {
  scopeCatchUpResetHandler = handler;
}

/**
 * Clears failed catch-up error entries for a reconnected scope so still-focused
 * stale tabs retry catch-up once the scope refresh finishes.
 */
export function clearFailedStaleChatCatchUpForScope(
  projectId: string,
  worktreeId: string,
): void {
  scopeCatchUpResetHandler?.(projectId, worktreeId);
}
