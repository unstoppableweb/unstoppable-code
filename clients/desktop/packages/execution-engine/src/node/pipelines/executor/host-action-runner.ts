/**
 * Runs a host step (`runs.using: host`) by raising one typed worker-to-core
 * request through `ExecutionRuntime.pipelineHostActions`.
 *
 * The executor owns input validation, the idempotency key and the step's
 * deadline; the host owns policy and the work. A typed failure still returns
 * the action's outputs plus `failure_reason`, so `continue_on_error` and later
 * expressions can branch on it. Input values are user text and never logged.
 */
import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { DEFAULT_TIMEOUT_MINUTES } from '@canopy/pipeline-interop/normalize-pipeline';
import {
  buildPipelineHostIdempotencyKey,
  emptyMoveToGroupOutputs,
  isPipelineHostActionId,
  parseMoveToGroupInputs,
  PIPELINE_HOST_FAILURE_REASON_OUTPUT,
  PIPELINE_NEEDS_DESKTOP_MESSAGE,
  pipelineNeedsHostMessage,
  type PipelineHostActionId,
  type PipelineHostFailureReason,
} from '@canopy/execution-engine/pipelines/host-actions';
import {
  emptyCreateBotEntryOutputs,
  emptyCreateProjectEntryOutputs,
  parseCreateBotEntryInputs,
  parseCreateProjectEntryInputs,
} from '@canopy/execution-engine/pipelines/host-create-entry';
import {
  emptyCreateWorktreeOutputs,
  parseCreateWorktreeInputs,
} from '@canopy/execution-engine/pipelines/host-create-worktree';
import {
  checkSendAgentMessageReferences,
  emptySendAgentMessageOutputs,
  parsePipelineChatSendRecord,
  parseSendAgentMessageInputs,
  SEND_AGENT_MESSAGE_TEXT_FILE_MAX_BYTES,
  type ResolvedSendAgentMessageInputs,
} from '@canopy/execution-engine/pipelines/host-send-agent-message';
import {
  emptyWaitForAgentReplyOutputs,
  parseWaitForAgentReplyInputs,
} from '@canopy/execution-engine/pipelines/host-wait-for-agent-reply';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import type { ChatTabPluginSelections } from '@canopy/execution-engine/execution-types';
import type { UsageInitiationSource } from '@canopy/execution-engine/types/observability';
import type {
  PipelineAgentChatAddress,
  PipelineChatSendRecord,
  PipelineExecutionInitiator,
} from '@canopy/execution-engine/types/pipeline';
import type { ResolvedActionRuntime } from '../action-resolver';
import {
  createSetupWithdrawal,
  SETUP_WITHDRAWN,
  stepTimedOutMessage,
} from '@canopy/execution-engine/node/pipelines/step-timeout';
import type { RunStepOptions, StepLogMetadata } from './step-runner';
import type {
  ExecutionRuntime,
  PipelineHostActionCaller,
  PipelineHostActionControls,
  PipelineHostActionRequest,
  PipelineHostActionResult,
  PipelineHostActions,
  StepResult,
} from './types';

export interface HostActionStepOptions {
  step: RunStepOptions['step'];
  runtime: ExecutionRuntime;
  signal: AbortSignal;
  executionId: string;
  jobId: string;
  /** The step id the executor tracks (a composite's child step is `<parent>/<child>`). */
  stepId: string;
  attempt: number;
  iteration: number;
  childId?: string;
  pipelineId?: string;
  pipelineName?: string;
  executionContext?: string;
  initiationSource?: UsageInitiationSource;
  /** The execution's `agent_origin`, for an agent-originated run. */
  agentOrigin?: PipelineAgentChatAddress;
  /** The execution's trusted initiator; never taken from step inputs. */
  initiator?: PipelineExecutionInitiator;
  /** The step's effective working directory; `text_file` and `attachments` stay inside it. */
  cwd?: string;
  /** Resolves a step's `model` input (pipeline, `$` and global aliases); throws to refuse. */
  resolveModel?: (value: string) => Promise<string>;
  /** A plugin collection the run resolved, as a chat takes it; `undefined` when it didn't. */
  pluginCollectionSelections?: (
    id: string,
  ) => ChatTabPluginSelections | undefined;
  /** `rawInputValues` from `runStepBody` (already resolved against the manifest defaults). */
  inputValues: Record<string, string>;
  logFile: string;
  logMetadata: StepLogMetadata;
}

type HostCallOutcome =
  | { kind: 'result'; result: PipelineHostActionResult }
  | { kind: 'threw'; error: unknown }
  | {
      kind: 'timeout';
      /** The host's finalizer result; absent without a finalizer or when it failed. */
      finalized?: PipelineHostActionResult;
    }
  | { kind: 'cancelled' };

type HostRequestBuild =
  | {
      ok: true;
      request: PipelineHostActionRequest;
      emptyOutputs: Record<string, string>;
    }
  | { ok: false; message: string; emptyOutputs: Record<string, string> };

interface HostRequestOptions {
  cwd?: string;
  resolveModel?: (value: string) => Promise<string>;
  pluginCollectionSelections?: (
    id: string,
  ) => ChatTabPluginSelections | undefined;
}

/** Selections that set anything; a collection that sets nothing sends none. */
function choosesAny(selections: ChatTabPluginSelections): boolean {
  return (
    selections.collectionIds.length > 0 ||
    selections.skillRefs.length > 0 ||
    selections.pluginRefs.length > 0 ||
    (selections.mcpServerRefs?.length ?? 0) > 0 ||
    (selections.mcpHttpAuthPreferences?.length ?? 0) > 0 ||
    (selections.unresolvedCapabilities?.length ?? 0) > 0
  );
}

type ContainedPath =
  | { ok: true; realPath: string }
  | { ok: false; message: string };

/**
 * Realpath containment inside the working folder: refuses `..`, absolute
 * paths that land outside, symlinks out, and the folder itself. Messages name
 * the input, never the path.
 */
async function containedPath(
  realCwd: string,
  cwd: string,
  value: string,
  input: string,
): Promise<ContainedPath> {
  let realPath: string;
  try {
    realPath = await fsp.realpath(path.resolve(cwd, value));
  } catch {
    return {
      ok: false,
      message: `send-agent-message "${input}" names a file that can't be found in the step's working folder`,
    };
  }
  const relative = path.relative(realCwd, realPath);
  if (
    relative === '' ||
    path.isAbsolute(relative) ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`)
  ) {
    return {
      ok: false,
      message: `send-agent-message "${input}" must name a file inside the step's working folder`,
    };
  }
  let isFile = false;
  try {
    isFile = (await fsp.stat(realPath)).isFile();
  } catch {
    // Treated as not a file below.
  }
  return isFile
    ? { ok: true, realPath }
    : {
        ok: false,
        message: `send-agent-message "${input}" must name a file, not a folder`,
      };
}

type WorkingFolder =
  | { ok: true; realCwd: string; cwd: string }
  | { ok: false; message: string };

async function realWorkingFolder(
  cwd: string | undefined,
  input: string,
): Promise<WorkingFolder> {
  const missing: WorkingFolder = {
    ok: false,
    message: `send-agent-message "${input}" needs a working directory`,
  };
  if (cwd === undefined) return missing;
  try {
    return { ok: true, realCwd: await fsp.realpath(cwd), cwd };
  } catch {
    return missing;
  }
}

/** Reads at most one byte over the cap, so the cap holds on the bytes read and not only on `stat`. */
async function readCappedFile(realPath: string): Promise<Buffer | 'too_large'> {
  const handle = await fsp.open(realPath, 'r');
  try {
    if ((await handle.stat()).size > SEND_AGENT_MESSAGE_TEXT_FILE_MAX_BYTES) {
      return 'too_large';
    }
    const buffer = Buffer.alloc(SEND_AGENT_MESSAGE_TEXT_FILE_MAX_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        total,
        buffer.length - total,
        total,
      );
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    return total > SEND_AGENT_MESSAGE_TEXT_FILE_MAX_BYTES
      ? 'too_large'
      : buffer.subarray(0, total);
  } finally {
    await handle.close();
  }
}

async function readTextFile(
  cwd: string | undefined,
  value: string,
): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  const folder = await realWorkingFolder(cwd, 'text_file');
  if (!folder.ok) return folder;
  const contained = await containedPath(
    folder.realCwd,
    folder.cwd,
    value,
    'text_file',
  );
  if (!contained.ok) return contained;
  let bytes: Buffer | 'too_large';
  try {
    bytes = await readCappedFile(contained.realPath);
  } catch {
    return {
      ok: false,
      message: 'send-agent-message "text_file" could not be read',
    };
  }
  if (bytes === 'too_large') {
    return {
      ok: false,
      message: `send-agent-message "text_file" must be at most ${SEND_AGENT_MESSAGE_TEXT_FILE_MAX_BYTES} bytes`,
    };
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return {
      ok: false,
      message: 'send-agent-message "text_file" must be UTF-8 text',
    };
  }
  return /\S/.test(text)
    ? { ok: true, text }
    : {
        ok: false,
        message:
          'send-agent-message "text_file" must contain a non-space character',
      };
}

async function containAttachments(
  cwd: string | undefined,
  values: readonly string[],
): Promise<{ ok: true; paths: string[] } | { ok: false; message: string }> {
  const folder = await realWorkingFolder(cwd, 'attachments');
  if (!folder.ok) return folder;
  const paths: string[] = [];
  for (const value of values) {
    const contained = await containedPath(
      folder.realCwd,
      folder.cwd,
      value,
      'attachments',
    );
    if (!contained.ok) return contained;
    paths.push(contained.realPath);
  }
  return { ok: true, paths };
}

/**
 * Reads `text_file`, contains `attachments` and resolves `model` before the
 * request is raised, so the request (and the host's replay fingerprint)
 * carries what was actually sent.
 */
async function buildSendAgentMessageRequest(
  inputValues: Record<string, string>,
  options: HostRequestOptions,
): Promise<HostRequestBuild> {
  const emptyOutputs = emptySendAgentMessageOutputs();
  const refuse = (message: string): HostRequestBuild => ({
    ok: false,
    message,
    emptyOutputs,
  });
  const parsed = parseSendAgentMessageInputs(inputValues);
  if (!parsed.ok) return refuse(parsed.message);
  const {
    text: source,
    attachments,
    pluginCollectionId,
    ...rest
  } = parsed.value;

  let text: string;
  if (source.kind === 'inline') {
    text = source.text;
  } else {
    const read = await readTextFile(options.cwd, source.path);
    if (!read.ok) return refuse(read.message);
    const referenceError = checkSendAgentMessageReferences(
      read.text,
      rest.textReferences,
    );
    if (referenceError !== null) return refuse(referenceError);
    text = read.text;
  }

  let attachmentPaths: string[] | undefined;
  if (attachments !== undefined) {
    const contained = await containAttachments(options.cwd, attachments);
    if (!contained.ok) return refuse(contained.message);
    attachmentPaths = contained.paths;
  }

  let settings = rest.settings;
  if (pluginCollectionId !== undefined) {
    const collection = options.pluginCollectionSelections?.(pluginCollectionId);
    if (collection === undefined)
      return refuse(
        'send-agent-message "plugin_collection_id" names a plugin collection this run didn\'t resolve',
      );
    const pluginSelections = normalizePluginSelections(collection);
    if (choosesAny(pluginSelections))
      settings = { ...settings, pluginSelections };
  }
  if (settings.model !== undefined && options.resolveModel) {
    try {
      settings = {
        ...settings,
        model: await options.resolveModel(settings.model),
      };
    } catch (error) {
      return refuse(errorMessage(error));
    }
  }

  const inputs: ResolvedSendAgentMessageInputs = {
    ...rest,
    settings,
    text,
    ...(attachmentPaths !== undefined ? { attachments: attachmentPaths } : {}),
  };
  return {
    ok: true,
    request: { action: 'send-agent-message', inputs },
    emptyOutputs,
  };
}

async function buildHostRequest(
  actionId: PipelineHostActionId,
  inputValues: Record<string, string>,
  options: HostRequestOptions,
): Promise<HostRequestBuild> {
  switch (actionId) {
    case 'move-to-group': {
      const parsed = parseMoveToGroupInputs(inputValues);
      const emptyOutputs = emptyMoveToGroupOutputs();
      return parsed.ok
        ? {
            ok: true,
            request: { action: actionId, inputs: parsed.value },
            emptyOutputs,
          }
        : { ok: false, message: parsed.message, emptyOutputs };
    }
    case 'create-worktree': {
      const parsed = parseCreateWorktreeInputs(inputValues);
      const emptyOutputs = emptyCreateWorktreeOutputs();
      return parsed.ok
        ? {
            ok: true,
            request: { action: actionId, inputs: parsed.value },
            emptyOutputs,
          }
        : { ok: false, message: parsed.message, emptyOutputs };
    }
    case 'create-project-entry': {
      const parsed = parseCreateProjectEntryInputs(inputValues);
      const emptyOutputs = emptyCreateProjectEntryOutputs();
      return parsed.ok
        ? {
            ok: true,
            request: { action: actionId, inputs: parsed.value },
            emptyOutputs,
          }
        : { ok: false, message: parsed.message, emptyOutputs };
    }
    case 'create-bot-entry': {
      const parsed = parseCreateBotEntryInputs(inputValues);
      const emptyOutputs = emptyCreateBotEntryOutputs();
      return parsed.ok
        ? {
            ok: true,
            request: { action: actionId, inputs: parsed.value },
            emptyOutputs,
          }
        : { ok: false, message: parsed.message, emptyOutputs };
    }
    case 'send-agent-message':
      return buildSendAgentMessageRequest(inputValues, options);
    case 'wait-for-agent-reply': {
      const parsed = parseWaitForAgentReplyInputs(inputValues);
      const emptyOutputs = emptyWaitForAgentReplyOutputs();
      return parsed.ok
        ? {
            ok: true,
            request: { action: actionId, inputs: parsed.value },
            emptyOutputs,
          }
        : { ok: false, message: parsed.message, emptyOutputs };
    }
  }
}

const INVALID_SEND_RECEIPT_MESSAGE =
  'The desktop app returned an invalid send receipt.';

/** `undefined` without a record; `'invalid'` for one that fails the shared schema. */
function readChatSend(
  result: PipelineHostActionResult,
): PipelineChatSendRecord | 'invalid' | undefined {
  if (result.chatSend === undefined) return undefined;
  return parsePipelineChatSendRecord(result.chatSend) ?? 'invalid';
}

/** Minutes a reply wait keeps past its own timeout for the final read. */
export const REPLY_READ_MARGIN_MINUTES = 2;

/**
 * The step's deadline. A reply wait raises the default deadline to fit its
 * own `reply_timeout_minutes`; a `timeout_minutes` the author chose (on the
 * step or its job) stays a hard limit, which the host finalizes as
 * `reply_timed_out`.
 */
function hostStepTimeoutMs(
  step: Pick<RunStepOptions['step'], 'timeout_minutes'>,
  request: PipelineHostActionRequest,
): number {
  const stepMs = step.timeout_minutes * 60_000;
  if (request.action !== 'wait-for-agent-reply') return stepMs;
  // Normalization resolves an unset deadline to exactly the default.
  if (step.timeout_minutes !== DEFAULT_TIMEOUT_MINUTES) return stepMs;
  return Math.max(
    stepMs,
    (request.inputs.replyTimeoutMinutes + REPLY_READ_MARGIN_MINUTES) * 60_000,
  );
}

/** `<executionsDir>/<executionId>/host/<sha256(idempotencyKey)>`: no user text in the path. */
export function hostArtifactsDir(
  executionsDir: string,
  executionId: string,
  idempotencyKey: string,
): string {
  const digest = createHash('sha256').update(idempotencyKey).digest('hex');
  return path.join(executionsDir, executionId, 'host', digest);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function appendHostLog(logFile: string, line: string): Promise<void> {
  await fsp.mkdir(path.dirname(logFile), { recursive: true });
  await fsp.appendFile(logFile, `${line}\n`, 'utf-8');
}

/** A finalizer that throws falls back to the generic timeout; the error is logged, never the request. */
async function runTimeoutFinalizer(
  finalize: (() => Promise<PipelineHostActionResult | undefined>) | undefined,
  logFile: string,
  label: string,
): Promise<PipelineHostActionResult | undefined> {
  if (!finalize) return undefined;
  try {
    return await finalize();
  } catch (error) {
    await appendHostLog(
      logFile,
      `${label} timeout finalizer failed: ${errorMessage(error)}`,
    );
    return undefined;
  }
}

/** Bounds the host call by the step's deadline and its caller's cancellation. */
async function callHostWithDeadline(
  port: PipelineHostActions,
  request: PipelineHostActionRequest,
  caller: PipelineHostActionCaller,
  signal: AbortSignal,
  timeoutMs: number,
  artifactsDir: string,
  logFile: string,
  label: string,
): Promise<HostCallOutcome> {
  let finalizer:
    | (() => Promise<PipelineHostActionResult | undefined>)
    | undefined;
  // The deadline and the withdrawal timer start together, so the host's
  // `deadlineAt` is the instant the executor withdraws.
  const controls: PipelineHostActionControls = {
    deadlineAt: Date.now() + timeoutMs,
    artifactsDir,
    registerTimeoutFinalizer(finalize) {
      finalizer = finalize;
    },
  };
  const withdrawal = createSetupWithdrawal(signal, timeoutMs);
  try {
    // The call runs on the withdrawal's signal, so a stop or timeout aborts it;
    // a result that settles after withdrawal can no longer change the step.
    const work = (async (): Promise<PipelineHostActionResult> =>
      port.run(request, caller, withdrawal.signal, controls))();
    const result = await withdrawal.race(work);
    if (result === SETUP_WITHDRAWN) {
      if (withdrawal.reason !== 'timeout') return { kind: 'cancelled' };
      const finalized = await runTimeoutFinalizer(finalizer, logFile, label);
      return finalized ? { kind: 'timeout', finalized } : { kind: 'timeout' };
    }
    return { kind: 'result', result };
  } catch (error) {
    return { kind: 'threw', error };
  } finally {
    withdrawal.release();
  }
}

/**
 * A host action is bundled-only, so its directory sits directly under the
 * bundled actions root; its name there is the resolver's parsed ref.
 */
function hostActionIdOf(
  action: ResolvedActionRuntime,
  bundledActionsDir: string,
): string {
  return path.relative(bundledActionsDir, action.actionDir);
}

/**
 * Whether the runtime's host port takes this host step (CAN-6082): a port
 * takes every action it declares, every action when it declares none, and
 * an action this app doesn't know, which it then refuses as unsupported.
 */
export function hostPortTakesAction(
  action: ResolvedActionRuntime,
  runtime: Pick<ExecutionRuntime, 'pipelineHostActions' | 'bundledActionsDir'>,
): boolean {
  const port = runtime.pipelineHostActions;
  if (port === undefined) return false;
  const { support } = port;
  if (support === undefined) return true;
  const actionId = hostActionIdOf(action, runtime.bundledActionsDir);
  return !isPipelineHostActionId(actionId) || support.actions.has(actionId);
}

type HostPortTake =
  | { ok: true; port: PipelineHostActions }
  | {
      ok: false;
      failureReason: Extract<
        PipelineHostFailureReason,
        'needs_desktop' | 'needs_host'
      >;
      message: string;
    };

/** The port that answers a host step, or why none does. */
function takeHostPort(
  port: PipelineHostActions | undefined,
  actionId: PipelineHostActionId,
): HostPortTake {
  if (port === undefined) {
    return {
      ok: false,
      failureReason: 'needs_desktop',
      message: PIPELINE_NEEDS_DESKTOP_MESSAGE,
    };
  }
  const { support } = port;
  if (support !== undefined && !support.actions.has(actionId)) {
    return {
      ok: false,
      failureReason: 'needs_host',
      message: pipelineNeedsHostMessage(actionId, support.hostName),
    };
  }
  return { ok: true, port };
}

export async function runHostAction(
  action: ResolvedActionRuntime,
  options: HostActionStepOptions,
): Promise<StepResult> {
  const startedAt = new Date().toISOString();
  const actionId = hostActionIdOf(action, options.runtime.bundledActionsDir);
  const label = `[host:${actionId}]`;

  const finish = (partial: {
    status: 'success' | 'failure' | 'cancelled';
    outputs: Record<string, string>;
    error?: string;
    chatSend?: PipelineChatSendRecord;
  }): StepResult => {
    return {
      ...options.logMetadata,
      status: partial.status,
      conclusion: partial.status,
      outcome: partial.status,
      outputs: partial.outputs,
      dynamic_env: {},
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      ...(partial.error !== undefined ? { error: partial.error } : {}),
      log_file: options.logFile,
      ...(partial.chatSend !== undefined
        ? { chat_send: partial.chatSend }
        : {}),
    };
  };

  const typedFailure = async (
    failureReason: PipelineHostFailureReason,
    error: string,
    outputs: Record<string, string>,
    chatSend?: PipelineChatSendRecord,
  ): Promise<StepResult> => {
    await appendHostLog(
      options.logFile,
      `${label} failed (${failureReason}): ${error}`,
    );
    return finish({
      status: 'failure',
      error,
      outputs: {
        ...outputs,
        [PIPELINE_HOST_FAILURE_REASON_OUTPUT]: failureReason,
      },
      ...(chatSend !== undefined ? { chatSend } : {}),
    });
  };

  /** A host result, success or typed failure, with its send record (decision E). */
  const fromHostResult = async (
    result: PipelineHostActionResult,
  ): Promise<StepResult> => {
    const chatSend = readChatSend(result);
    if (chatSend === 'invalid') {
      await appendHostLog(
        options.logFile,
        `${label} failed: ${INVALID_SEND_RECEIPT_MESSAGE}`,
      );
      return finish({
        status: 'failure',
        error: INVALID_SEND_RECEIPT_MESSAGE,
        outputs: {},
      });
    }
    if (result.status === 'failure') {
      return typedFailure(
        result.failureReason,
        result.error,
        result.outputs,
        chatSend,
      );
    }
    await appendHostLog(options.logFile, `${label} success`);
    return finish({
      status: 'success',
      outputs: {
        ...result.outputs,
        [PIPELINE_HOST_FAILURE_REASON_OUTPUT]: '',
      },
      ...(chatSend !== undefined ? { chatSend } : {}),
    });
  };

  if (options.signal.aborted) {
    await appendHostLog(options.logFile, `${label} cancelled`);
    return finish({ status: 'cancelled', outputs: {} });
  }

  if (!isPipelineHostActionId(actionId)) {
    return typedFailure(
      'unsupported_action',
      `Action "${options.step.uses ?? actionId}" is not a host action this app knows.`,
      {},
    );
  }

  const build = await buildHostRequest(actionId, options.inputValues, {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.resolveModel !== undefined
      ? { resolveModel: options.resolveModel }
      : {}),
    ...(options.pluginCollectionSelections !== undefined
      ? { pluginCollectionSelections: options.pluginCollectionSelections }
      : {}),
  });
  if (!build.ok) {
    return typedFailure('validation_failed', build.message, build.emptyOutputs);
  }

  const caller: PipelineHostActionCaller = {
    executionId: options.executionId,
    jobId: options.jobId,
    stepId: options.stepId,
    attempt: options.attempt,
    iteration: options.iteration,
    idempotencyKey: buildPipelineHostIdempotencyKey({
      executionId: options.executionId,
      jobId: options.jobId,
      ...(options.childId !== undefined ? { childId: options.childId } : {}),
      stepId: options.stepId,
      attempt: options.attempt,
      iteration: options.iteration,
    }),
    ...(options.childId !== undefined ? { childId: options.childId } : {}),
    ...(options.pipelineId !== undefined
      ? { pipelineId: options.pipelineId }
      : {}),
    ...(options.pipelineName !== undefined
      ? { pipelineName: options.pipelineName }
      : {}),
    ...(options.executionContext !== undefined
      ? { executionContext: options.executionContext }
      : {}),
    ...(options.initiationSource !== undefined
      ? { initiationSource: options.initiationSource }
      : {}),
    ...(options.agentOrigin !== undefined
      ? { agentOrigin: options.agentOrigin }
      : {}),
    ...(options.initiator !== undefined
      ? { initiator: options.initiator }
      : {}),
  };

  const taken = takeHostPort(options.runtime.pipelineHostActions, actionId);
  if (!taken.ok) {
    return typedFailure(taken.failureReason, taken.message, build.emptyOutputs);
  }
  const { port } = taken;

  const timeoutMs = hostStepTimeoutMs(options.step, build.request);
  const outcome = await callHostWithDeadline(
    port,
    build.request,
    caller,
    options.signal,
    timeoutMs,
    hostArtifactsDir(
      options.runtime.executionsDir,
      options.executionId,
      caller.idempotencyKey,
    ),
    options.logFile,
    label,
  );
  switch (outcome.kind) {
    case 'cancelled':
      await appendHostLog(options.logFile, `${label} cancelled`);
      return finish({ status: 'cancelled', outputs: {} });
    case 'timeout': {
      const { finalized } = outcome;
      if (finalized === undefined) {
        await appendHostLog(options.logFile, `${label} timed out`);
        return finish({
          status: 'failure',
          error: stepTimedOutMessage(timeoutMs),
          outputs: {},
        });
      }
      if (finalized.status === 'failure') {
        await appendHostLog(
          options.logFile,
          `${label} timed out (${finalized.failureReason})`,
        );
      }
      // A success here means the work finished in the same turn the deadline
      // fired, or the host had already accepted it.
      return fromHostResult(finalized);
    }
    case 'threw': {
      const message = errorMessage(outcome.error);
      await appendHostLog(options.logFile, `${label} failed: ${message}`);
      return finish({ status: 'failure', error: message, outputs: {} });
    }
    case 'result':
      return fromHostResult(outcome.result);
  }
}
