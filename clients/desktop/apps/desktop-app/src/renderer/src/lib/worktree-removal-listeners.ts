import { reportClientAppError } from '@canopy/desktop-instrumentation/client';

type WorktreeRemovalListener = (worktreeKey: string) => void;

const listeners = new Set<WorktreeRemovalListener>();

export function registerWorktreeRemovalListener(
  listener: WorktreeRemovalListener,
): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

export function notifyWorktreeRemoved(worktreeKey: string): void {
  for (const listener of listeners) {
    try {
      listener(worktreeKey);
    } catch (error) {
      // Observer cleanup must not turn a confirmed removal into a failed archive.
      reportClientAppError(error);
    }
  }
}
