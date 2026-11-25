import { CanopyOperationError } from '@canopy/core-runtime';

/**
 * The deepest level the walk reads: the thrown value is level 0, so a cause
 * at most four links below it is visited and anything deeper is not.
 */
export const IPC_ERROR_CHAIN_MAX_DEPTH = 4;

function ownValue(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function links(value: unknown): unknown[] {
  const next: unknown[] = [];
  try {
    if (value instanceof CanopyOperationError) next.push(value.runtimeCause);
  } catch {
    /* A hostile prototype reads as no runtime cause. */
  }
  next.push(ownValue(value, 'cause'));
  return next.filter((link) => link !== undefined && link !== null);
}

/**
 * One walk over a rejected IPC value for the local failure record and the
 * rejection classifier, so they agree on which error matched. It visits the
 * thrown value, then each `CanopyOperationError.runtimeCause` and `cause`,
 * breadth-first by level, to {@link IPC_ERROR_CHAIN_MAX_DEPTH}. A value seen
 * once ends that branch, so a cycle ends the walk. Non-Error values are
 * visited like any other; property reads that throw count as absent.
 */
export function ipcErrorChain(thrown: unknown): readonly unknown[] {
  const visited = new Set<unknown>();
  const chain: unknown[] = [];
  let level: unknown[] = [thrown];
  for (
    let depth = 0;
    depth <= IPC_ERROR_CHAIN_MAX_DEPTH && level.length > 0;
    depth++
  ) {
    const next: unknown[] = [];
    for (const value of level) {
      if (visited.has(value)) continue;
      visited.add(value);
      chain.push(value);
      next.push(...links(value));
    }
    level = next;
  }
  return chain;
}

/** The first value in the chain that `match` accepts, or `undefined`. */
export function findInIpcErrorChain<T>(
  thrown: unknown,
  match: (value: unknown) => value is T,
): T | undefined {
  for (const value of ipcErrorChain(thrown)) {
    try {
      if (match(value)) return value;
    } catch {
      /* A value the matcher cannot read does not match. */
    }
  }
  return undefined;
}
