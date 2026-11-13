/*
 * Tells project memory (design §22) that a workspace's `cloudBinding` or
 * private memory choice was written, so the scope its memory resolves to
 * follows at once rather than at the next sync pass.
 */

type Listener = (workspaceId: string) => void;

const listeners = new Set<Listener>();

export function onWorkspaceMemoryBindingChanged(
  listener: Listener,
): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

export function notifyWorkspaceMemoryBindingChanged(workspaceId: string): void {
  for (const listener of listeners) listener(workspaceId);
}
