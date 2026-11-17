import { AsyncLocalStorage } from 'node:async_hooks';

let tail: Promise<unknown> = Promise.resolve();
interface MutationScope {
  active: boolean;
  settled: Set<() => void>;
}
const active = new AsyncLocalStorage<MutationScope | undefined>();

/** One cache document, one mutation queue. A composed operation holds one slot. */
export function runSerializedPluginMutation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  if (active.getStore()?.active) return operation();
  const result = tail.then(async () => {
    const scope: MutationScope = { active: true, settled: new Set() };
    try {
      return await active.run(scope, operation);
    } finally {
      scope.active = false;
      active.run(undefined, () => {
        for (const callback of scope.settled) callback();
      });
    }
  });
  tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** Detached work must leave even a still-live parent's admission. Never await it from that parent. */
export function enqueueDetachedPluginMutation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  return active.run(undefined, () => runSerializedPluginMutation(operation));
}

export function afterPluginMutationSettled(callback: () => void): void {
  const scope = active.getStore();
  if (scope?.active) scope.settled.add(callback);
  else active.run(undefined, callback);
}

export function resetPluginMutationQueueForTests(): void {
  tail = Promise.resolve();
}
