import type {
  WorkerPipelineHostRequest,
  WorkerPipelineHostResult,
} from '@canopy/protocol/canopy-core';
import type {
  PipelineHostActionCaller,
  PipelineHostActionControls,
  PipelineHostActionResult,
  PipelineHostActions,
} from '@canopy/execution-engine/node/pipelines/executor/types';
import {
  fromPortableHostActionRequest,
  fromPortableHostResult,
  hostPathsOf,
  hostRequestEnvelope,
  portableHostActionRequest,
  portableOwner,
  toPortableHostResult,
  UNPORTABLE_HOST_RESULT,
  type SendHostPaths,
} from '@canopy/execution-engine/node/pipelines/host-request-portable';
import {
  EVERY_PIPELINE_HOST_ACTION,
  PIPELINE_NEEDS_DESKTOP_MESSAGE,
} from '@canopy/execution-engine/pipelines/host-actions';
import type { PipelineChatSendRecord } from '@canopy/execution-engine/types/pipeline';
import { peekDesktopCanopyRuntime } from '../canopy-runtime/desktop-runtime-access';

/*
 * Host steps cross the local worker boundary as worker-to-core requests
 * (CAN-4140, CAN-5077). The executor's port raises every host step on
 * `worker.pipeline.hostRequests` with the run's owner; core
 * settles each with `worker.pipeline.hostRequest.respond`. What doesn't
 * cross yet stays in process, keyed by request id: the full caller (core
 * applies the request's own action, inputs and owner), the step's abort
 * signal, the executor's controls (artifacts directory, timeout finalizer),
 * the desktop host that applies the policy, the host's own unexpected
 * error, `send-agent-message`'s host-path inputs and the host-path outputs
 * the boundary refuses (CAN-5086).
 */

interface InProcessHostCall {
  readonly host: PipelineHostActions;
  readonly caller: PipelineHostActionCaller;
  readonly controls: PipelineHostActionControls | undefined;
  /** The step's own signal: the executor withdrawing the call stops the host. */
  readonly signal: AbortSignal;
  /** `send-agent-message`'s host-path inputs, as the executor passed them. */
  readonly hostPaths: SendHostPaths | undefined;
  error?: unknown;
  pathOutputs?: Record<string, string>;
  /** A send record the boundary refuses; the executor reports it as invalid. */
  invalidChatSend?: PipelineChatSendRecord;
}

const calls = new Map<string, InProcessHostCall>();

const desktopHosts = new WeakMap<object, PipelineHostActions>();

/** Registers the desktop host behind an executor runtime's host port (CAN-5771). */
export function registerDesktopPipelineHostActions(
  runtime: object,
  host: PipelineHostActions,
): void {
  desktopHosts.set(runtime, host);
}

/** The desktop host a daemon run's host steps are applied with: the one its start's runtime holds. */
export function desktopPipelineHostActionsOf(
  runtime: object,
): PipelineHostActions | undefined {
  return desktopHosts.get(runtime);
}

/**
 * The executor's host port on the local worker: raise the request for core
 * and return its settlement. Without a core settling requests the step fails
 * as it does without a desktop.
 */
export function createWorkerPipelineHostActions(
  host: PipelineHostActions,
): PipelineHostActions {
  return {
    support: {
      hostName: 'the desktop app',
      actions: EVERY_PIPELINE_HOST_ACTION,
    },
    async run(
      request,
      caller,
      signal,
      controls,
    ): Promise<PipelineHostActionResult> {
      const portable = portableHostActionRequest(request);
      if (portable === null) return UNPORTABLE_HOST_RESULT;
      const broker = peekDesktopCanopyRuntime()?.pipelineHostRequests;
      if (!broker?.settled)
        return {
          status: 'failure',
          failureReason: 'needs_desktop',
          error: PIPELINE_NEEDS_DESKTOP_MESSAGE,
          outputs: {},
        };
      const requestId = caller.idempotencyKey;
      const call: InProcessHostCall = {
        host,
        caller,
        controls,
        signal,
        hostPaths: hostPathsOf(request),
      };
      calls.set(requestId, call);
      try {
        const result = await broker.raise(
          hostRequestEnvelope(portable, caller, controls),
          signal,
        );
        return fromPortableHostResult(result, {
          pathOutputs: call.pathOutputs ?? {},
          ...(call.invalidChatSend && {
            invalidChatSend: call.invalidChatSend,
          }),
          error: call.error,
        });
      } finally {
        if (calls.get(requestId) === call) calls.delete(requestId);
      }
    },
  };
}

const NOT_WAITING: WorkerPipelineHostResult = {
  status: 'failure',
  failureReason: 'not_found',
  message: 'This host request is no longer waiting.',
  outputs: {},
};

/**
 * Core's settlement of one host request: the desktop host applies its
 * policy for the call this request belongs to.
 */
export async function applyPipelineHostRequest(
  request: WorkerPipelineHostRequest,
  signal: AbortSignal,
): Promise<WorkerPipelineHostResult> {
  const call = calls.get(request.requestId);
  if (
    call?.caller.executionId !== request.executionId ||
    portableOwner(call.caller.executionContext) !== request.owner
  )
    return NOT_WAITING;
  const hostRequest = fromPortableHostActionRequest(
    request.request,
    call.hostPaths,
  );
  if (hostRequest === null) return NOT_WAITING;
  try {
    const { portable, pathOutputs, invalidChatSend } = toPortableHostResult(
      await call.host.run(
        hostRequest,
        call.caller,
        AbortSignal.any([signal, call.signal]),
        call.controls,
      ),
    );
    call.pathOutputs = pathOutputs;
    if (invalidChatSend !== undefined) call.invalidChatSend = invalidChatSend;
    return portable;
  } catch (error) {
    call.error = error;
    throw error;
  }
}
