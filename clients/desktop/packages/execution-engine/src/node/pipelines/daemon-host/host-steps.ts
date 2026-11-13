import type { PipelineHostStepSettlement } from '@canopy/core-runtime/node/pipeline/host';
import type {
  WorkerPipelineHostRequest,
  WorkerPipelineHostStepValues,
} from '@canopy/protocol/canopy-core';
import {
  EVERY_PIPELINE_HOST_ACTION,
  PIPELINE_NEEDS_DESKTOP_MESSAGE,
} from '@canopy/execution-engine/pipelines/host-actions';
import type { PipelineChatSendRecord } from '@canopy/execution-engine/types/pipeline';
import type {
  PipelineHostActionResult,
  PipelineHostActions,
} from '../executor/types';
import {
  fromPortableHostResult,
  hostPathsOf,
  hostRequestEnvelope,
  portableHostActionRequest,
  UNPORTABLE_HOST_RESULT,
} from '../host-request-portable';

/** How long a host step waits past its deadline for its owner's finalized answer. */
export const DAEMON_HOST_STEP_FINALIZE_GRACE_MS = 5_000;

/**
 * How early the executor's deadline abort may land before `deadlineAt`: its
 * timer is scheduled from the event loop's cached time, which lags the clock
 * under load. A cancel inside this window waits for the owner's own deadline
 * answer, which comes at `deadlineAt`.
 */
const DEADLINE_CLOCK_SLACK_MS = 1_000;

export interface DaemonHostStepChannel {
  /** Posts `{ kind: 'hostRequest', request }`. */
  raise(request: WorkerPipelineHostRequest): void;
  /** Posts `{ kind: 'hostRequestWithdrawn', executionId, requestId }`. */
  withdraw(executionId: string, requestId: string): void;
}

/** The pipeline host's host-step port (CAN-5771): each call is raised to the supervisor. */
export interface DaemonHostStepPort extends PipelineHostActions {
  /** The supervisor's `hostSettled` for one request; ignored when nothing waits for it. */
  settle(requestId: string, settlement: PipelineHostStepSettlement): void;
  /** The host is exiting: every waiting call ends as withdrawn. */
  close(): void;
}

/**
 * A send record the protocol refuses, so the executor reports the receipt as
 * invalid, as in process (section 6, stop 9).
 */
const INVALID_CHAT_SEND: PipelineChatSendRecord =
  Object.freeze<PipelineChatSendRecord>({
    version: 1,
    address: { kind: 'project', projectId: '', taskId: '', chatId: '' },
    userMessageId: '',
    state: 'sent',
    chatCreated: false,
    acceptedAt: '',
  });

const NEEDS_DESKTOP: PipelineHostActionResult = {
  status: 'failure',
  failureReason: 'needs_desktop',
  error: PIPELINE_NEEDS_DESKTOP_MESSAGE,
  outputs: {},
};

const WITHDRAWN_MESSAGE = 'The workflow host step was withdrawn.';

interface WaitingCall {
  settle(settlement: PipelineHostStepSettlement): void;
  close(): void;
}

function extrasOf(values: WorkerPipelineHostStepValues | null): {
  readonly pathOutputs: Readonly<Record<string, string>>;
  readonly errorMessage?: string;
  readonly invalidChatSend?: PipelineChatSendRecord;
} {
  return {
    pathOutputs: values?.pathOutputs ?? {},
    ...(values?.errorMessage !== undefined && {
      errorMessage: values.errorMessage,
    }),
    ...(values?.invalidChatSend && { invalidChatSend: INVALID_CHAT_SEND }),
  };
}

/** The finalizer's answer for a settlement that came at the deadline. */
function finalizedResult(
  settlement: PipelineHostStepSettlement,
): PipelineHostActionResult | undefined {
  if (
    settlement.kind !== 'settled' ||
    settlement.values?.timeout !== 'finalized'
  )
    return undefined;
  try {
    return fromPortableHostResult(
      settlement.result,
      extrasOf(settlement.values),
    );
  } catch {
    return undefined;
  }
}

export function createDaemonHostStepPort(
  channel: DaemonHostStepChannel,
): DaemonHostStepPort {
  const waiting = new Map<string, WaitingCall>();
  return {
    // Every host step is raised to the owner, which answers what it can.
    support: {
      hostName: 'the background workflow service',
      actions: EVERY_PIPELINE_HOST_ACTION,
    },
    run(request, caller, signal, controls): Promise<PipelineHostActionResult> {
      const portable = portableHostActionRequest(request);
      const hostPaths = hostPathsOf(request);
      if (
        portable === null ||
        Object.values(hostPaths ?? {}).some(
          (paths) => paths !== undefined && paths.length > 0,
        )
      )
        return Promise.resolve(UNPORTABLE_HOST_RESULT);
      const requestId = caller.idempotencyKey;
      const { executionId } = caller;
      // The executor never runs one key twice at once.
      if (waiting.has(requestId))
        return Promise.resolve(UNPORTABLE_HOST_RESULT);
      let resolveFinalized: (
        result: PipelineHostActionResult | undefined,
      ) => void = () => undefined;
      const finalized = new Promise<PipelineHostActionResult | undefined>(
        (resolve) => {
          resolveFinalized = resolve;
        },
      );
      controls?.registerTimeoutFinalizer(() => finalized);
      return new Promise<PipelineHostActionResult>((resolve, reject) => {
        let done = false;
        let atDeadline = false;
        let held: PipelineHostStepSettlement | null = null;
        let grace: ReturnType<typeof setTimeout> | undefined;
        const finish = (): void => {
          done = true;
          if (waiting.get(requestId) === call) waiting.delete(requestId);
          signal.removeEventListener('abort', aborted);
          if (grace !== undefined) clearTimeout(grace);
        };
        const call: WaitingCall = {
          settle(settlement): void {
            if (done) return;
            if (atDeadline) {
              finish();
              resolveFinalized(finalizedResult(settlement));
              return;
            }
            if (settlement.kind === 'unavailable') {
              finish();
              resolveFinalized(undefined);
              resolve(NEEDS_DESKTOP);
              return;
            }
            // The owner's deadline fired a moment before the executor's.
            if (settlement.values && settlement.values.timeout !== 'none') {
              held = settlement;
              return;
            }
            finish();
            resolveFinalized(undefined);
            try {
              resolve(
                fromPortableHostResult(
                  settlement.result,
                  extrasOf(settlement.values),
                ),
              );
            } catch (error) {
              reject(
                error instanceof Error ? error : new Error(WITHDRAWN_MESSAGE),
              );
            }
          },
          close(): void {
            if (done) return;
            finish();
            resolveFinalized(undefined);
            if (!atDeadline) reject(new Error(WITHDRAWN_MESSAGE));
          },
        };
        function aborted(): void {
          const reason: unknown = signal.reason;
          reject(
            reason instanceof Error ? reason : new Error(WITHDRAWN_MESSAGE),
          );
          if (
            controls &&
            Date.now() >= controls.deadlineAt - DEADLINE_CLOCK_SLACK_MS
          ) {
            if (held) {
              const settled = held;
              finish();
              resolveFinalized(finalizedResult(settled));
              return;
            }
            atDeadline = true;
            grace = setTimeout(() => {
              if (done) return;
              finish();
              resolveFinalized(undefined);
              channel.withdraw(executionId, requestId);
            }, DAEMON_HOST_STEP_FINALIZE_GRACE_MS);
            return;
          }
          const settledEarlier = held !== null;
          finish();
          resolveFinalized(undefined);
          if (!settledEarlier) channel.withdraw(executionId, requestId);
        }
        waiting.set(requestId, call);
        if (signal.aborted) {
          aborted();
          return;
        }
        signal.addEventListener('abort', aborted, { once: true });
        channel.raise(hostRequestEnvelope(portable, caller, controls));
      });
    },
    settle(requestId, settlement): void {
      waiting.get(requestId)?.settle(settlement);
    },
    close(): void {
      for (const call of [...waiting.values()]) call.close();
      waiting.clear();
    },
  };
}
