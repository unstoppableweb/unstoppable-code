import type { NormalizedStep } from '../../../types/pipeline';

/*
 * A run's graceful checkpoint (CAN-6199): while it drains, no new step
 * starts, and the steps already running may finish. A host wait, a step that
 * only waits on its owner such as `wait-for-agent-reply`, never holds the
 * drain: its replay picks up the same wait.
 */

/** Host steps that only wait on their owner; a checkpoint does not wait for them. */
const HOST_WAIT_ACTIONS: ReadonlySet<string> = new Set([
  'builtin/wait-for-agent-reply',
]);

/** Whether a step only waits on its owner, so a checkpoint replays it instead of waiting. */
export function isPipelineHostWaitStep(
  step: Pick<NormalizedStep, 'uses'>,
): boolean {
  return step.uses !== undefined && HOST_WAIT_ACTIONS.has(step.uses);
}

export interface PipelineStepDrain {
  /**
   * Resolves once a step may start, with the function that marks it done;
   * the step counts as running from then on. While the run drains it waits
   * until `signal` aborts, which the checkpoint does once the drain ends.
   */
  admit(signal: AbortSignal, hostWait: boolean): Promise<() => void>;
  /**
   * Marks a step that waits to start on something other than the drain,
   * such as memory (CAN-6325), with the function that ends the wait. Like a
   * host wait it never holds the drain: a run whose remaining steps all wait
   * so stops at once.
   */
  wait(): () => void;
  /** Whether the run drains now, so a step that would start waits for it. */
  isDraining(): boolean;
  /**
   * Starts draining. `quiet` is called once, when no step but host waits
   * runs and at least one step waits to start or one host wait runs; a run
   * that has nothing left to start finishes on its own instead.
   */
  drain(quiet: () => void): void;
  /** Releases every step waiting to start, as when the run has finished. */
  release(): void;
}

export function createPipelineStepDrain(): PipelineStepDrain {
  let running = 0;
  let hostWaits = 0;
  let draining = false;
  let quiet: (() => void) | undefined;
  const waiting = new Set<() => void>();

  const check = (): void => {
    if (!quiet || running > 0 || (waiting.size === 0 && hostWaits === 0))
      return;
    const done = quiet;
    quiet = undefined;
    done();
  };

  const enter = (hostWait: boolean): (() => void) => {
    if (hostWait) hostWaits += 1;
    else running += 1;
    let left = false;
    check();
    return () => {
      if (left) return;
      left = true;
      if (hostWait) hostWaits -= 1;
      else running -= 1;
      check();
    };
  };

  return {
    admit(signal, hostWait) {
      if (!draining || signal.aborted) return Promise.resolve(enter(hostWait));
      return new Promise((resolve) => {
        const wake = (): void => {
          waiting.delete(wake);
          signal.removeEventListener('abort', wake);
          resolve(enter(hostWait));
        };
        waiting.add(wake);
        signal.addEventListener('abort', wake, { once: true });
        check();
      });
    },
    wait() {
      return enter(true);
    },
    isDraining() {
      return draining;
    },
    drain(onQuiet) {
      draining = true;
      quiet = onQuiet;
      check();
    },
    release() {
      draining = false;
      quiet = undefined;
      for (const wake of [...waiting]) wake();
    },
  };
}
