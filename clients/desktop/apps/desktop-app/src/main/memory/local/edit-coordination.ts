import { resolve } from 'node:path';
import { withMemoryScopeLock } from './scope-lock';
import {
  advanceMemoryScopeRevision,
  memoryScopeNeedsBackfill,
  prepareMemoryScopeForWrite,
  readMemoryScopeRevision,
} from './scope-manifest';

const writes = new Map<string, Promise<unknown>>();

/**
 * The scope's document revision, persisted in its manifest so that it holds
 * across processes. A write that read the scope earlier compares it again
 * under {@link withMemoryWriteLock} before replacing what it read.
 */
export function memoryEditRevision(scopeDir: string): Promise<string> {
  return readMemoryScopeRevision(resolve(scopeDir));
}

/**
 * Records a document write (index, topics or a note's text). Call it under
 * {@link withMemoryWriteLock}, before the write: a write that then fails
 * only makes a concurrent consolidation start over.
 */
export function recordMemoryEdit(scopeDir: string): Promise<void> {
  return advanceMemoryScopeRevision(resolve(scopeDir));
}

/**
 * Runs `write` alone among this process's writers to the scope, then under
 * the scope's cross-process lock, once the scope is ready for it (see
 * `prepareMemoryScopeForWrite`): a scope a newer build made read-only
 * rejects with `LocalMemoryScopeReadOnlyError` before `write` runs.
 */
export async function withMemoryWriteLock<T>(
  scopeDir: string,
  write: () => Promise<T>,
): Promise<T> {
  const key = resolve(scopeDir);
  const previous = writes.get(key) ?? Promise.resolve();
  const operation = previous
    .catch(() => undefined)
    .then(() =>
      withMemoryScopeLock(key, async () => {
        await prepareMemoryScopeForWrite(key);
        return write();
      }),
    );
  writes.set(key, operation);
  try {
    return await operation;
  } finally {
    if (writes.get(key) === operation) writes.delete(key);
  }
}

/**
 * Runs a pending backfill before the explorer hands out per-file revisions,
 * so its first save does not find the file changed by the backfill. Best
 * effort: reading goes on when it cannot run now.
 */
export async function backfillMemoryScopeBeforeRead(
  scopeDir: string,
): Promise<void> {
  try {
    if (!(await memoryScopeNeedsBackfill(scopeDir))) return;
    await withMemoryWriteLock(scopeDir, () => Promise.resolve());
  } catch (error) {
    process.emitWarning(
      error instanceof Error ? error.message : String(error),
      {
        code: 'LOCAL_MEMORY_BACKFILL_DEFERRED',
      },
    );
  }
}

/**
 * Raised by a caller's precondition, checked under the scope's write lock
 * before a rebuild or restore changes anything: the caller's view of the
 * scope no longer holds, so nothing is changed.
 */
export class LocalMemoryPreconditionError extends Error {}
