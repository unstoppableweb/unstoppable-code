import type {
  ExecutionEvent,
  ExecutionState,
  StepOutputEvent,
} from '@canopy/execution-engine/node/pipelines/executor/types';

/**
 * Observers attached to EVERY pipeline execution so a run started outside the
 * browser still reaches a connected Remote Control session.
 *
 * The desktop renderer has always had an ambient channel: every execution
 * broadcasts through `emitExecutionEvent` regardless of who started it. The
 * browser had no equivalent — `portal.pipeline.event` was only ever produced by
 * a forwarder that `runPipeline` and the portal control runtime attached to
 * their own executions. A run dispatched from the desktop therefore streamed
 * nothing, and because the browser fires each `portal.state.request` once per
 * `(session, scope, target)`, it never asked again either: the run stayed
 * invisible until a full page reload (CAN-2865).
 *
 * This is a registration seam rather than a direct call because
 * `services/pipelines-service` already imports `pipelines/pipeline-handlers`;
 * importing the forwarder back into the handlers would close that cycle.
 * `pipelines-service` registers the factory at module scope and owns every
 * policy decision (is a browser attached, is this execution already forwarded);
 * the handlers only ask for observers and attach whatever they get.
 */
export interface PipelineRunObservers {
  readonly onEvent: (event: ExecutionEvent) => void;
  readonly onStepOutput: (event: StepOutputEvent) => void;
  /**
   * Publish the handle's current state once at attach time.
   *
   * Observers attach after `executePipeline` returns, so the first
   * `execution.started` event can land before anyone is listening. Priming
   * means a browser sees the run even when it missed that edge.
   */
  readonly prime?: (state: ExecutionState) => void;
}

export type PipelineRunObserverFactory = (
  executionId: string,
) => PipelineRunObservers | null;

let factory: PipelineRunObserverFactory | null = null;

export function setPipelineRunObserverFactory(
  next: PipelineRunObserverFactory | null,
): void {
  factory = next;
}

/**
 * Observers for one execution, or `null` when nothing is listening.
 *
 * Failures are swallowed: pipeline execution must not depend on the browser
 * projection being constructible.
 */
export function createPipelineRunObservers(
  executionId: string,
): PipelineRunObservers | null {
  if (!factory) return null;
  try {
    return factory(executionId);
  } catch {
    return null;
  }
}
