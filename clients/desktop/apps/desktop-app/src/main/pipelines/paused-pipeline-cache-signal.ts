const durablePausedPipelineListeners = new Set<
  (executionIds?: readonly string[]) => void
>();

/**
 * Lightweight zero-dependency signal notifying runtime-status caches when
 * persisted pipeline executions are archived, deleted, or restored outside
 * live execution broadcasts.
 */
export function subscribeDurablePausedPipelinesChanged(
  listener: (executionIds?: readonly string[]) => void,
): () => void {
  durablePausedPipelineListeners.add(listener);
  return (): void => {
    durablePausedPipelineListeners.delete(listener);
  };
}

export function notifyDurablePausedPipelinesChanged(
  executionIds?: readonly string[],
): void {
  for (const listener of Array.from(durablePausedPipelineListeners)) {
    listener(executionIds);
  }
}
