import {
  WORKER_PIPELINE_HOST_PATH_OUTPUTS,
  WorkerPipelineChatSendRecordSchema,
  WorkerPipelineHostActionRequestSchema,
  WorkerPipelineHostResultSchema,
  type WorkerPipelineHostActionRequest,
  type WorkerPipelineHostRequest,
  type WorkerPipelineHostResult,
} from '@canopy/protocol/canopy-core';
import { parseWorkspaceContext } from '@canopy/protocol/workspace-context';
import type { ResolvedSendAgentMessageInputs } from '@canopy/execution-engine/pipelines/host-send-agent-message';
import type { PipelineChatSendRecord } from '@canopy/execution-engine/types/pipeline';
import type {
  PipelineHostActionCaller,
  PipelineHostActionControls,
  PipelineHostActionRequest,
  PipelineHostActionResult,
} from './executor/types';

/*
 * The portable shape of a host step, shared by Electron main's in-process
 * port and the daemon's pipeline host (CAN-5771): what crosses
 * `worker.pipeline.hostRequests`, and how a settlement becomes the executor's
 * result again. Host-path inputs and outputs never cross.
 */

/**
 * `send-agent-message`'s inputs that hold host paths: its contained
 * attachments, and a converted chat automation's composer payload (CAN-5479).
 */
export type SendHostPaths = Pick<
  ResolvedSendAgentMessageInputs,
  | 'attachments'
  | 'attachmentPaths'
  | 'attachmentPromptContexts'
  | 'fileReferences'
>;

/** Each host-path input and the count that crosses in its place. */
export const SEND_HOST_PATH_COUNTS = [
  ['attachments', 'attachmentCount'],
  ['attachmentPaths', 'attachmentPathCount'],
  ['attachmentPromptContexts', 'attachmentPromptContextCount'],
  ['fileReferences', 'fileReferenceCount'],
] as const satisfies readonly (readonly [keyof SendHostPaths, string])[];

export type SendHostPathCounts = Partial<
  Record<(typeof SEND_HOST_PATH_COUNTS)[number][1], number>
>;

export const UNPORTABLE_HOST_RESULT: PipelineHostActionResult = {
  status: 'failure',
  failureReason: 'validation_failed',
  error: 'This host step has an input the pipeline host doesn’t accept.',
  outputs: {},
};

export function isPathOutput(key: string): boolean {
  return WORKER_PIPELINE_HOST_PATH_OUTPUTS.some((pathKey) => pathKey === key);
}

/** Split a host result into its portable form and what stays on this host. */
export function toPortableHostResult(result: PipelineHostActionResult): {
  portable: WorkerPipelineHostResult;
  pathOutputs: Record<string, string>;
  invalidChatSend?: PipelineChatSendRecord;
} {
  const outputs: Record<string, string> = {};
  const pathOutputs: Record<string, string> = {};
  for (const [key, value] of Object.entries(result.outputs))
    (isPathOutput(key) ? pathOutputs : outputs)[key] = value;
  const chatSend =
    result.chatSend === undefined
      ? undefined
      : WorkerPipelineChatSendRecordSchema.safeParse(result.chatSend);
  const sent = chatSend?.success ? { chatSend: chatSend.data } : {};
  const portable = WorkerPipelineHostResultSchema.parse(
    result.status === 'success'
      ? { status: 'success', outputs, ...sent }
      : {
          status: 'failure',
          failureReason: result.failureReason,
          message: result.error || 'The host step failed.',
          outputs,
          ...sent,
        },
  );
  return chatSend === undefined || chatSend.success
    ? { portable, pathOutputs }
    : { portable, pathOutputs, invalidChatSend: result.chatSend };
}

/**
 * The run's owner as it crosses, resolved as the host's owner policy
 * resolves it: a run without one is Personal, and an owner that isn't a
 * workspace context is `null`, whose project targets core refuses.
 */
export function portableOwner(
  executionContext: string | undefined,
): string | null {
  const owner = executionContext ?? 'personal';
  return parseWorkspaceContext(owner) !== null ? owner : null;
}

/** A send's host-path inputs, only those it sets; an empty list stays. */
function sendHostPaths(inputs: ResolvedSendAgentMessageInputs): SendHostPaths {
  const paths: SendHostPaths = {};
  if (inputs.attachments !== undefined) paths.attachments = inputs.attachments;
  if (inputs.attachmentPaths !== undefined)
    paths.attachmentPaths = inputs.attachmentPaths;
  if (inputs.attachmentPromptContexts !== undefined)
    paths.attachmentPromptContexts = inputs.attachmentPromptContexts;
  if (inputs.fileReferences !== undefined)
    paths.fileReferences = inputs.fileReferences;
  return paths;
}

export function sendHostPathCounts(paths: SendHostPaths): SendHostPathCounts {
  const counts: SendHostPathCounts = {};
  for (const [input, count] of SEND_HOST_PATH_COUNTS) {
    const length = paths[input]?.length ?? 0;
    if (length > 0) counts[count] = length;
  }
  return counts;
}

/** The request's portable inputs; host paths stay on this host. */
function portableInputs(request: PipelineHostActionRequest): object {
  if (request.action !== 'send-agent-message') return request.inputs;
  const inputs = Object.entries(request.inputs).filter(
    ([key]) => !SEND_HOST_PATH_COUNTS.some(([input]) => input === key),
  );
  return {
    ...Object.fromEntries(inputs),
    ...sendHostPathCounts(sendHostPaths(request.inputs)),
  };
}

export function hostPathsOf(
  request: PipelineHostActionRequest,
): SendHostPaths | undefined {
  return request.action === 'send-agent-message'
    ? sendHostPaths(request.inputs)
    : undefined;
}

/** The portable action request, or null when the boundary refuses it. */
export function portableHostActionRequest(
  request: PipelineHostActionRequest,
): WorkerPipelineHostActionRequest | null {
  const portable = WorkerPipelineHostActionRequestSchema.safeParse({
    action: request.action,
    ...portableInputs(request),
  });
  return portable.success ? portable.data : null;
}

/** The executor's portable host request for one call (`createWorkerPipelineHostActions`' envelope). */
export function hostRequestEnvelope(
  request: WorkerPipelineHostActionRequest,
  caller: PipelineHostActionCaller,
  controls: PipelineHostActionControls | undefined,
): WorkerPipelineHostRequest {
  return {
    requestId: caller.idempotencyKey,
    executionId: caller.executionId,
    jobId: caller.jobId,
    stepId: caller.stepId,
    childExecutionId: caller.childId ?? null,
    attempt: caller.attempt,
    iteration: caller.iteration,
    owner: portableOwner(caller.executionContext),
    deadlineAt: new Date(controls?.deadlineAt ?? Date.now()).toISOString(),
    request,
  };
}

/**
 * A settlement as the executor receives it: outputs with the kept path
 * outputs, the send record, and a thrown error for an unexpected host error
 * (`failureReason: null`), whose message is `errorMessage` when given.
 */
export function fromPortableHostResult(
  result: Exclude<WorkerPipelineHostResult, { status: 'owner' }>,
  extras: {
    readonly pathOutputs: Readonly<Record<string, string>>;
    readonly invalidChatSend?: PipelineChatSendRecord;
    readonly error?: unknown;
    readonly errorMessage?: string;
  },
): PipelineHostActionResult {
  const outputs = { ...result.outputs, ...extras.pathOutputs };
  // A record the boundary refused reaches the executor, which reports it as
  // an invalid receipt, as before.
  const chatSend = result.chatSend ?? extras.invalidChatSend;
  const sent = chatSend === undefined ? {} : { chatSend };
  if (result.status === 'success')
    return { status: 'success', outputs, ...sent };
  // An unexpected host error keeps its own message.
  if (result.failureReason === null)
    throw extras.error instanceof Error
      ? extras.error
      : new Error(extras.errorMessage ?? result.message);
  return {
    status: 'failure',
    failureReason: result.failureReason,
    error: result.message,
    outputs,
    ...sent,
  };
}

/** The desktop host's request for a portable one; null when the counts disagree. */
export function fromPortableHostActionRequest(
  request: WorkerPipelineHostActionRequest,
  hostPaths: SendHostPaths | undefined,
): PipelineHostActionRequest | null {
  switch (request.action) {
    case 'move-to-group': {
      const { action, ...inputs } = request;
      return { action, inputs };
    }
    case 'create-worktree': {
      const { action, ...inputs } = request;
      return { action, inputs };
    }
    case 'create-project-entry': {
      const { action, ...inputs } = request;
      return { action, inputs };
    }
    case 'create-bot-entry': {
      const { action, ...inputs } = request;
      return { action, inputs };
    }
    case 'send-agent-message': {
      const {
        action,
        attachmentCount,
        attachmentPathCount,
        attachmentPromptContextCount,
        fileReferenceCount,
        ...inputs
      } = request;
      const counts: SendHostPathCounts = {
        attachmentCount,
        attachmentPathCount,
        attachmentPromptContextCount,
        fileReferenceCount,
      };
      // The paths the worker kept, for the counts the request names.
      const kept = sendHostPathCounts(hostPaths ?? {});
      if (
        SEND_HOST_PATH_COUNTS.some(([, count]) => kept[count] !== counts[count])
      )
        return null;
      // An explicit empty list stays: the host fingerprints it.
      return { action, inputs: { ...inputs, ...(hostPaths ?? {}) } };
    }
    case 'wait-for-agent-reply': {
      const { action, ...inputs } = request;
      return { action, inputs };
    }
    default:
      // Pipeline owner requests (CAN-5095) are not host steps.
      return null;
  }
}
