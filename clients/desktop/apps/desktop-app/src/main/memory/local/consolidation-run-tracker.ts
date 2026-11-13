import { resolve } from 'node:path';

/**
 * `first_enable`: memory sync sends this folder's memory to the cloud for a
 * first enable, so nothing may change it as a run would.
 */
export type LocalMemoryRunKind =
  | 'consolidation'
  | 'rebuild'
  | 'restore'
  | 'first_enable';

/**
 * In-memory "a consolidation run is executing" registry shared by the manual
 * trigger, the idle scheduler, rebuilds, snapshot restores, and the status
 * IPC, keyed by resolved scope directory so the same scope cannot run twice
 * at once.
 */
const running = new Map<string, LocalMemoryRunKind>();

export function isLocalMemoryConsolidationRunning(scopeDir: string): boolean {
  return running.has(resolve(scopeDir));
}

export function isLocalMemoryRebuildRunning(scopeDir: string): boolean {
  return running.get(resolve(scopeDir)) === 'rebuild';
}

/** Reserves the scope; returns false when a run is already executing. */
export function beginLocalMemoryConsolidationRun(
  scopeDir: string,
  kind: LocalMemoryRunKind = 'consolidation',
): boolean {
  const key = resolve(scopeDir);
  if (running.has(key)) return false;
  running.set(key, kind);
  return true;
}

export function endLocalMemoryConsolidationRun(scopeDir: string): void {
  running.delete(resolve(scopeDir));
}

export const localMemoryConsolidationRunTrackerTestExports = {
  reset(): void {
    running.clear();
  },
};
