import { randomUUID } from 'node:crypto';
import type { PipelineOwnerSettlement } from '@canopy/core-runtime/node/pipeline';
import type { PipelineHostSettlement } from '@canopy/core-runtime/node/pipeline/host';
import type {
  WorkerPipelineHostRequest,
  WorkerPipelineOwnerRequest,
} from '@canopy/protocol/canopy-core';
import type { DaemonHostStepChannel } from './host-steps';

/** The step an owner request is about; `_run`, 0, 0 for a run-level call. */
export interface PipelineOwnerStep {
  readonly executionId: string;
  readonly childExecutionId: string | null;
  readonly jobId: string;
  readonly stepId: string;
  readonly attempt: number;
  readonly iteration: number;
  readonly owner: WorkerPipelineHostRequest['owner'];
  /** 120_000 or 86_400_000 (CAN-5095 D13). */
  readonly deadlineMs: number;
}

/** How a model step asks its run's core while it runs (CAN-5095 D1). */
export interface PipelineOwnerClient {
  /** Resolves the settlement; rejects when withdrawn or when no owner answers. */
  request(
    body: WorkerPipelineOwnerRequest,
    step: PipelineOwnerStep,
    signal: AbortSignal,
  ): Promise<PipelineOwnerSettlement>;
}

/** The pipeline host's side of its owner client. */
export interface PipelineOwnerClientHost extends PipelineOwnerClient {
  /** The supervisor's `hostSettled`; false when no owner request has this id. */
  settle(requestId: string, settlement: PipelineHostSettlement): boolean;
  /** The host is checkpointing or exiting: every waiting and later request ends as withdrawn. */
  close(): void;
}

/** Deadlines for owner requests (CAN-5095 D13). */
export const PIPELINE_OWNER_DEADLINE_MS = Object.freeze({
  /** Routing can wait for proxy capacity; an approval or a tool can take a step's time. */
  long: 86_400_000,
  short: 120_000,
  /**
   * A request a run makes while it starts (CAN-6327): the start waits for
   * it, and the supervisor gives a start 30 s before it stops the host.
   */
  start: 10_000,
});

export const PIPELINE_OWNER_NOT_ANSWERING =
  'The app that started this workflow run is not answering.';
const WITHDRAWN_MESSAGE = 'The owner request was withdrawn.';
const UNANSWERED = 'The app could not answer this workflow step.';

interface Waiting {
  settle(settlement: PipelineHostSettlement): void;
  close(): void;
}

/**
 * Raises owner requests on the CAN-5771 host request channel: the supervisor
 * waits for the owner, relays each request and answers with `hostSettled`.
 */
export interface PipelineOwnerClientOptions {
  /**
   * The least an owner request with the short deadline or longer waits: a
   * remote owner's lease TTL (CP-11), so a request raised early in a relay
   * outage outlives the outage instead of ending at 120 s. Requests a run
   * makes while it starts keep their own, shorter, deadline.
   */
  readonly minimumDeadlineMs?: () => number | undefined;
}

export function createPipelineOwnerClient(
  channel: DaemonHostStepChannel,
  options: PipelineOwnerClientOptions = {},
): PipelineOwnerClientHost {
  const waiting = new Map<string, Waiting>();
  let closed = false;
  const deadlineOf = (deadlineMs: number): number => {
    const minimum = options.minimumDeadlineMs?.();
    return minimum !== undefined &&
      deadlineMs >= PIPELINE_OWNER_DEADLINE_MS.short
      ? Math.max(deadlineMs, minimum)
      : deadlineMs;
  };
  return {
    request(body, step, signal): Promise<PipelineOwnerSettlement> {
      const deadlineMs = deadlineOf(step.deadlineMs);
      // After a checkpoint or exit nothing would settle it.
      if (closed) return Promise.reject(new Error(WITHDRAWN_MESSAGE));
      const { executionId } = step;
      const requestId = `owner:${executionId}:${randomUUID()}`;
      return new Promise<PipelineOwnerSettlement>((resolve, reject) => {
        const finish = (): void => {
          waiting.delete(requestId);
          signal.removeEventListener('abort', aborted);
          clearTimeout(deadline);
        };
        function aborted(): void {
          finish();
          channel.withdraw(executionId, requestId);
          const reason: unknown = signal.reason;
          reject(
            reason instanceof Error ? reason : new Error(WITHDRAWN_MESSAGE),
          );
        }
        if (signal.aborted) {
          const reason: unknown = signal.reason;
          reject(
            reason instanceof Error ? reason : new Error(WITHDRAWN_MESSAGE),
          );
          return;
        }
        waiting.set(requestId, {
          settle(settlement): void {
            finish();
            if (settlement.kind === 'owner') resolve(settlement.settlement);
            else if (settlement.kind === 'unavailable')
              reject(new Error(PIPELINE_OWNER_NOT_ANSWERING));
            else reject(new Error(UNANSWERED));
          },
          close(): void {
            finish();
            reject(new Error(WITHDRAWN_MESSAGE));
          },
        });
        signal.addEventListener('abort', aborted, { once: true });
        // A request ends at its deadline even when nothing settles it.
        const deadline = setTimeout(() => {
          finish();
          channel.withdraw(executionId, requestId);
          reject(new Error(PIPELINE_OWNER_NOT_ANSWERING));
        }, deadlineMs);
        channel.raise({
          requestId,
          executionId,
          jobId: step.jobId,
          stepId: step.stepId,
          childExecutionId: step.childExecutionId,
          attempt: step.attempt,
          iteration: step.iteration,
          owner: step.owner,
          deadlineAt: new Date(Date.now() + deadlineMs).toISOString(),
          request: body,
        });
      });
    },
    settle(requestId, settlement): boolean {
      const call = waiting.get(requestId);
      if (!call) return false;
      call.settle(settlement);
      return true;
    },
    close(): void {
      closed = true;
      for (const call of [...waiting.values()]) call.close();
      waiting.clear();
    },
  };
}
