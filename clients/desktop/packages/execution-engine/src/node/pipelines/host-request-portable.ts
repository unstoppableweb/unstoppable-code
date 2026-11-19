import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import {
  WORKER_PIPELINE_HOST_ATTACHMENTS_MAX,
  WORKER_PIPELINE_HOST_ATTACHMENTS_MAX_BYTES,
  WORKER_PIPELINE_HOST_PATH_OUTPUTS,
  WORKER_PIPELINE_HOST_PATH_OUTPUTS_BY_ACTION,
  WorkerPipelineChatSendRecordSchema,
  WorkerPipelineHostActionRequestSchema,
  WorkerPipelineHostResultSchema,
  type WorkerPipelineHostActionRequest,
  type WorkerPipelineHostAttachment,
  type WorkerPipelineHostFile,
  type WorkerPipelineHostRequest,
  type WorkerPipelineHostResult,
} from '@canopy/protocol/canopy-core';
import {
  isCloudAttachmentFilename,
  mediaTypeForAttachmentFilename,
  truncateCloudAttachmentFilename,
} from '@canopy/protocol/cloud-attachments';
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

/**
 * The host-path outputs of a step whose owner can't name host paths (the
 * cloud, CAN-6780), derived on this host: each file the result carries is
 * written into the step's host folder `dir`, and the output it names is set
 * to its path. Every other host-path output the action declares is `''`, as
 * a host that reports no file sets it; `path` is always `''`, since the
 * checkout such an owner creates is never on this host. A file that can't
 * be written leaves its output `''`, as desktop does with a log it can't
 * copy.
 */
export async function deriveHostPathOutputs(
  action: string,
  files: readonly WorkerPipelineHostFile[] | undefined,
  dir: string | null,
): Promise<Record<string, string>> {
  const outputs: Record<string, string> = {};
  const declared = Object.entries(
    WORKER_PIPELINE_HOST_PATH_OUTPUTS_BY_ACTION,
  ).find(([name]) => name === action)?.[1];
  for (const output of declared ?? []) outputs[output] = '';
  if (files === undefined || dir === null) return outputs;
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch {
    return outputs;
  }
  for (const file of files) {
    // The schema already bounds the name to one segment; this keeps it so.
    const target = path.join(dir, file.name);
    if (path.dirname(target) !== dir) continue;
    try {
      const temporary = `${target}.${process.pid}.tmp`;
      await fsp.writeFile(temporary, file.text, 'utf-8');
      await fsp.rename(temporary, target);
    } catch {
      continue;
    }
    if (file.output !== undefined && declared?.includes(file.output))
      outputs[file.output] = target;
  }
  return outputs;
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
        attachmentFiles,
        attachmentPathCount,
        attachmentPromptContextCount,
        fileReferenceCount,
        ...inputs
      } = request;
      // A host that reads its own paths never sends copies: a request that
      // carries them isn't one this host raised.
      if (attachmentFiles !== undefined) return null;
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
    case 'github-publish-review': {
      // No host paths: the review crosses as the executor fitted it.
      const { action, ...inputs } = request;
      return { action, inputs };
    }
    default:
      // Pipeline owner requests (CAN-5095) are not host steps.
      return null;
  }
}

/**
 * Why a step's attachments can't be copied for an owner that can't read
 * its host paths. Never names a file: its name is the author's data.
 */
export type HostAttachmentRefusal = {
  readonly ok: false;
  readonly message: string;
};

/**
 * A copy of each file a `send-agent-message` step attaches, for an owner
 * that can't read the step's host paths (the cloud, CAN-6857, G6). The
 * executor already contained each path in the step's working folder; this
 * reads each one once, by its name and allowlisted media type, within the
 * bounds one request may carry. A file that can't be sent refuses the whole
 * step before anything crosses.
 */
export async function hostAttachmentCopies(
  paths: readonly string[],
): Promise<
  | { readonly ok: true; readonly files: WorkerPipelineHostAttachment[] }
  | HostAttachmentRefusal
> {
  if (paths.length > WORKER_PIPELINE_HOST_ATTACHMENTS_MAX)
    return {
      ok: false,
      message: `Cloud runs attach at most ${WORKER_PIPELINE_HOST_ATTACHMENTS_MAX} files to a message`,
    };
  const files: WorkerPipelineHostAttachment[] = [];
  let total = 0;
  for (const [index, file] of paths.entries()) {
    const which = `Attachment ${index + 1}`;
    const filename = truncateCloudAttachmentFilename(path.basename(file));
    const mediaType = mediaTypeForAttachmentFilename(filename);
    if (mediaType === null || !isCloudAttachmentFilename(filename))
      return {
        ok: false,
        message: `${which} can't be sent from a cloud run: its file type isn't one a cloud chat takes`,
      };
    let bytes: Buffer;
    try {
      const stats = await fsp.stat(file);
      if (!stats.isFile())
        return { ok: false, message: `${which} isn't a file` };
      if (total + stats.size > WORKER_PIPELINE_HOST_ATTACHMENTS_MAX_BYTES)
        return {
          ok: false,
          message: `A cloud run attaches at most ${WORKER_PIPELINE_HOST_ATTACHMENTS_MAX_BYTES / (1024 * 1024)} MB of files to a message`,
        };
      bytes = await fsp.readFile(file);
    } catch {
      return { ok: false, message: `${which} couldn't be read` };
    }
    total += bytes.byteLength;
    if (total > WORKER_PIPELINE_HOST_ATTACHMENTS_MAX_BYTES)
      return {
        ok: false,
        message: `A cloud run attaches at most ${WORKER_PIPELINE_HOST_ATTACHMENTS_MAX_BYTES / (1024 * 1024)} MB of files to a message`,
      };
    files.push({
      filename,
      mediaType,
      size: bytes.byteLength,
      contentSha256: createHash('sha256').update(bytes).digest('hex'),
      data: bytes.toString('base64'),
    });
  }
  return { ok: true, files };
}

/**
 * The portable request with copies of the files it attaches, or null when
 * the boundary refuses them.
 */
export function withHostAttachmentCopies(
  request: WorkerPipelineHostActionRequest,
  files: readonly WorkerPipelineHostAttachment[],
): WorkerPipelineHostActionRequest | null {
  if (request.action !== 'send-agent-message') return null;
  const parsed = WorkerPipelineHostActionRequestSchema.safeParse({
    ...request,
    attachmentFiles: files,
  });
  return parsed.success ? parsed.data : null;
}
