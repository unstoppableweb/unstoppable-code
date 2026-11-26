import { ownsW5RepositoryLock } from './w5-repository-locks';
import { AsyncLocalStorage } from 'node:async_hooks';

const workspaceMutationTails = new Map<string, Promise<void>>();
// Shared services can be called from an already serialized IPC operation.
// Preserve that operation's queue ownership so nested service boundaries do
// not enqueue behind themselves and deadlock.
const activeWorkspaceMutation = new AsyncLocalStorage<boolean>();

/** Whether the caller runs inside `serializeWorkspaceMutation`. */
export function ownsWorkspaceMutation(): boolean {
  return activeWorkspaceMutation.getStore() === true;
}

export async function serializeWorkspaceMutation<T>(
  operation: () => Promise<T>,
  cancellation?: { signal: AbortSignal; error: () => Error },
): Promise<T> {
  const checkCancelled = (): void => {
    if (cancellation?.signal.aborted) throw cancellation.error();
  };
  checkCancelled();
  if (activeWorkspaceMutation.getStore() === true) {
    return operation();
  }
  if (ownsW5RepositoryLock()) {
    throw new Error('Workspace serialization must precede W5 repository locks');
  }
  const key = 'all-workspace-mutations';
  const previous = workspaceMutationTails.get(key) ?? Promise.resolve();
  let started: (() => void) | undefined;
  const result = previous
    .catch(() => undefined)
    .then(() => {
      started?.();
      checkCancelled();
      return activeWorkspaceMutation.run(true, operation);
    });
  const removeTail = (): void => {
    if (workspaceMutationTails.get(key) === tail)
      workspaceMutationTails.delete(key);
  };
  // Cancellation releases only the waiting caller. Keep its queue position
  // until the predecessor settles and the cancelled callback is skipped.
  const tail = result.then(removeTail, removeTail);
  workspaceMutationTails.set(key, tail);
  if (!cancellation) return result;
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(cancellation.error());
    const cleanup = (): void =>
      cancellation.signal.removeEventListener('abort', abort);
    started = cleanup;
    cancellation.signal.addEventListener('abort', abort, { once: true });
    if (cancellation.signal.aborted) abort();
    void result.then(resolve, reject);
  });
}

export async function serializeChatProjectOperation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  return serializeWorkspaceMutation(operation);
}
