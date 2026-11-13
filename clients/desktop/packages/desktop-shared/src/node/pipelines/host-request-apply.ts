import {
  PIPELINE_HOST_STEP_PATH_OUTPUTS,
  type WorkerPipelineHostRequest,
  type WorkerPipelineHostResult,
  type WorkerPipelineHostStepValues,
} from '@canopy/protocol/canopy-core';
import { buildPipelineHostIdempotencyKey } from '@canopy/execution-engine/pipelines/host-actions';
import type { UsageInitiationSource } from '../../types';
import type {
  PipelineAgentChatAddress,
  PipelineExecutionInitiator,
} from '@canopy/execution-engine/types/pipeline';
import { hostArtifactsDir } from '@canopy/execution-engine/node/pipelines/executor/host-action-runner';
import type {
  PipelineHostActionCaller,
  PipelineHostActionControls,
  PipelineHostActionResult,
  PipelineHostActions,
} from '@canopy/execution-engine/node/pipelines/executor/types';
import {
  fromPortableHostActionRequest,
  toPortableHostResult,
  UNPORTABLE_HOST_RESULT,
} from '@canopy/execution-engine/node/pipelines/host-request-portable';

/*
 * The owner's side of a daemon host step (CAN-5771): one request raised by a
 * daemon run, applied with the desktop host of the run's start. The caller
 * and controls the executor built in process are rebuilt from the request
 * and the run, and the deadline and timeout finalizer are enforced here, as
 * the executor enforces them in process. Shared by Electron main and the
 * CAN-4151 slice, so both compositions run one copy.
 */

/** The run a daemon host request belongs to, as its admitting core knows it (CAN-5771). */
export interface PortableHostRunContext {
  readonly executionsDir: string;
  readonly pipelineId?: string;
  readonly pipelineName?: string;
  readonly executionContext?: string;
  readonly initiationSource?: UsageInitiationSource;
  readonly agentOrigin?: PipelineAgentChatAddress;
  readonly initiator?: PipelineExecutionInitiator;
}

/** The owner's answer to one host request: the portable result and its host-local values. */
export interface PortableHostAnswer {
  readonly result: WorkerPipelineHostResult;
  readonly values: WorkerPipelineHostStepValues;
}

const NOT_WAITING: WorkerPipelineHostResult = {
  status: 'failure',
  failureReason: 'not_found',
  message: 'This host request is no longer waiting.',
  outputs: {},
};

const TIMED_OUT_MESSAGE = 'The host step timed out.';

const TIMED_OUT: WorkerPipelineHostResult = {
  status: 'failure',
  failureReason: null,
  message: TIMED_OUT_MESSAGE,
  outputs: {},
};

const WITHDRAWN: WorkerPipelineHostResult = {
  status: 'failure',
  failureReason: null,
  message: 'The host request was withdrawn.',
  outputs: {},
};

const FAILED_UNEXPECTEDLY: WorkerPipelineHostResult = {
  status: 'failure',
  failureReason: null,
  message: 'The host step failed unexpectedly.',
  outputs: {},
};

const ERROR_MESSAGE_MAX = 8_192;

/** `setTimeout`'s longest delay; a later deadline re-arms. */
const MAX_TIMER_MS = 2 ** 31 - 1;

const settledWith = (
  result: WorkerPipelineHostResult,
  timeout: WorkerPipelineHostStepValues['timeout'],
): PortableHostAnswer => ({ result, values: { pathOutputs: {}, timeout } });

/** A host result as it crosses: portable outputs, and its host paths host-locally. */
function answerOf(
  result: PipelineHostActionResult,
  timeout: WorkerPipelineHostStepValues['timeout'],
): PortableHostAnswer {
  const { portable, pathOutputs, invalidChatSend } =
    toPortableHostResult(result);
  const kept: WorkerPipelineHostStepValues['pathOutputs'] = {};
  for (const key of PIPELINE_HOST_STEP_PATH_OUTPUTS) {
    const value = pathOutputs[key];
    if (value !== undefined) kept[key] = value;
  }
  return {
    result: portable,
    values: {
      pathOutputs: kept,
      timeout,
      ...(invalidChatSend !== undefined && { invalidChatSend: true }),
    },
  };
}

function unexpectedAnswer(error: unknown): PortableHostAnswer {
  const message = (
    error instanceof Error ? error.message : String(error)
  ).slice(0, ERROR_MESSAGE_MAX);
  return {
    result: FAILED_UNEXPECTEDLY,
    values: {
      pathOutputs: {},
      timeout: 'none',
      ...(message.length > 0 && { errorMessage: message }),
    },
  };
}

/**
 * Applies one host request raised by a daemon run with `host`, rebuilding the
 * executor's caller and controls, enforcing the request's deadline and
 * running the host's timeout finalizer as the executor does in process.
 * Never throws; an unexpected host error is answered redacted, with its own
 * message in `values.errorMessage`, and reported to `onError`.
 */
export function applyPortableHostRequest(options: {
  readonly request: WorkerPipelineHostRequest;
  readonly host: PipelineHostActions;
  readonly run: PortableHostRunContext;
  readonly signal: AbortSignal;
  readonly onError?: (error: unknown) => void;
}): Promise<PortableHostAnswer> {
  const { request, host, run, signal } = options;
  const { executionId, jobId, stepId, attempt, iteration, requestId } = request;
  const childId = request.childExecutionId;
  const key = buildPipelineHostIdempotencyKey({
    executionId,
    jobId,
    ...(childId !== null && { childId }),
    stepId,
    attempt,
    iteration,
  });
  if (requestId !== key)
    return Promise.resolve(settledWith(NOT_WAITING, 'none'));
  const hostRequest = fromPortableHostActionRequest(request.request, undefined);
  if (hostRequest === null)
    return Promise.resolve(
      settledWith(
        toPortableHostResult(UNPORTABLE_HOST_RESULT).portable,
        'none',
      ),
    );
  if (signal.aborted) return Promise.resolve(settledWith(WITHDRAWN, 'none'));
  const deadlineAt = Date.parse(request.deadlineAt);
  // Past its deadline the step has already timed out: no host effect starts.
  if (Date.now() >= deadlineAt)
    return Promise.resolve(settledWith(TIMED_OUT, 'unfinalized'));

  const { executionsDir, ...context } = run;
  const caller: PipelineHostActionCaller = {
    executionId,
    jobId,
    stepId,
    attempt,
    iteration,
    idempotencyKey: requestId,
    ...(childId !== null && { childId }),
    ...(context.pipelineId !== undefined && { pipelineId: context.pipelineId }),
    ...(context.pipelineName !== undefined && {
      pipelineName: context.pipelineName,
    }),
    ...(context.executionContext !== undefined && {
      executionContext: context.executionContext,
    }),
    ...(context.initiationSource !== undefined && {
      initiationSource: context.initiationSource,
    }),
    ...(context.agentOrigin !== undefined && {
      agentOrigin: context.agentOrigin,
    }),
    ...(context.initiator !== undefined && { initiator: context.initiator }),
  };
  let finalizer:
    | (() => Promise<PipelineHostActionResult | undefined>)
    | undefined;
  const controls: PipelineHostActionControls = {
    deadlineAt,
    artifactsDir: hostArtifactsDir(executionsDir, executionId, requestId),
    registerTimeoutFinalizer(finalize): void {
      finalizer = finalize;
    },
  };
  const deadline = new AbortController();

  return new Promise<PortableHostAnswer>((resolve) => {
    // The first of the deadline, a withdrawal and the host's own answer wins.
    let decided = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const decide = (): boolean => {
      if (decided) return false;
      decided = true;
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', withdrawn);
      return true;
    };
    function withdrawn(): void {
      if (decide()) resolve(settledWith(WITHDRAWN, 'none'));
    }
    const finalize = async (): Promise<PortableHostAnswer> => {
      try {
        const result = finalizer ? await finalizer() : undefined;
        if (result !== undefined) return answerOf(result, 'finalized');
      } catch {
        // A finalizer that throws counts as none.
      }
      return settledWith(TIMED_OUT, 'unfinalized');
    };
    const onDeadline = (): void => {
      if (!decide()) return;
      deadline.abort(new Error(TIMED_OUT_MESSAGE));
      void finalize().then(resolve);
    };
    const arm = (): void => {
      const remaining = Math.max(0, deadlineAt - Date.now());
      timer = setTimeout(
        remaining > MAX_TIMER_MS ? arm : onDeadline,
        Math.min(remaining, MAX_TIMER_MS),
      );
    };
    signal.addEventListener('abort', withdrawn, { once: true });
    arm();
    (async (): Promise<PipelineHostActionResult> =>
      host.run(
        hostRequest,
        caller,
        AbortSignal.any([signal, deadline.signal]),
        controls,
      ))().then(
      (result) => {
        if (!decide()) return;
        try {
          resolve(answerOf(result, 'none'));
        } catch (error) {
          resolve(unexpected(error));
        }
      },
      (error: unknown) => {
        if (decide()) resolve(unexpected(error));
      },
    );
    function unexpected(error: unknown): PortableHostAnswer {
      try {
        options.onError?.(error);
      } catch {
        // Reporting never changes the answer.
      }
      return unexpectedAnswer(error);
    }
  });
}
