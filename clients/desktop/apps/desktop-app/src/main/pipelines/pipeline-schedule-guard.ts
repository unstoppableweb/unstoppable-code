/**
 * CAN-5782: one pipeline's schedule guard. A person's definition write and
 * its approval stamp, **Approve for schedules**, and a timed fire's approval
 * check each hold it, so none of them reads the stored definition halfway
 * through another's write and stamp. Main is one process, so an in-process
 * FIFO mutex per pipeline ID is the whole guard.
 *
 * The guard is re-entrant within one holder's async context: a holder that
 * calls into code which takes the same pipeline's guard runs it at once
 * instead of waiting for itself.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const tails = new Map<string, Promise<void>>();
const held = new AsyncLocalStorage<ReadonlySet<string>>();

/** Runs `fn` holding `pipelineId`'s guard, after every earlier holder. */
export async function withPipelineScheduleGuard<T>(
  pipelineId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const holding = held.getStore();
  if (holding?.has(pipelineId)) return fn();
  const previous = tails.get(pipelineId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  tails.set(pipelineId, tail);
  await previous;
  try {
    return await held.run(new Set([...(holding ?? []), pipelineId]), fn);
  } finally {
    release();
    if (tails.get(pipelineId) === tail) tails.delete(pipelineId);
  }
}
