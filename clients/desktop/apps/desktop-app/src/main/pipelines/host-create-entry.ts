/**
 * Desktop main's `create-project-entry` and `create-bot-entry` host steps.
 *
 * Both create a task (a Work Entry and its founding chat) through the
 * explicit-target `projects.create_task` / `bots.create_task` actions, bound
 * to a trusted pipeline caller: the same creation path agents use, with its
 * owner, readiness and Orchestrator access checks. Neither writes a Work
 * Entry itself.
 *
 * No double effects. The task ID is chosen and journaled before dispatch, and
 * a created task's founding chat shares its ID, so a resumed attempt can tell
 * whether its task exists and return it instead of creating another.
 * Concurrent calls with one idempotency key share a live operation; the
 * in-process receipt store answers a repeated dispatch with its first result.
 * A job retry is a new attempt (a new key) and creates again.
 *
 * Group problems never fail the step (D12). Titles and group names are user
 * text: never logged, never echoed in errors and never journaled.
 */
import { randomUUID } from 'node:crypto';
import {
  AgentPortError,
  runIdempotentWrite,
  type AgentActionCall,
  type AgentActionReceiptStore,
  type AgentActionToolResult,
  type AgentProjectBotPort,
} from '@canopy/agent-actions';
import type {
  PipelineHostActionCaller,
  PipelineHostActionControls,
  PipelineHostActionResult,
} from '@canopy/execution-engine/node/pipelines/executor/types';
import {
  PipelineHostRefusal,
  type PipelineHostFailureReason,
} from '@canopy/execution-engine/pipelines/host-actions';
import {
  emptyCreateBotEntryOutputs,
  emptyCreateProjectEntryOutputs,
  type CreateBotEntryInputs,
  type CreateProjectEntryInputs,
} from '@canopy/execution-engine/pipelines/host-create-entry';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import type { SidebarItemGroupScope } from '@canopy/protocol/sidebar';
import { z } from 'zod';
import {
  createDesktopPipelineProjectBotPort,
  unattendedDeliveryHost,
} from '../agent-actions/desktop-project-bot-port';
import { desktopAgentActionReceipts } from '../agent-actions/desktop-limits-port';
import {
  pipelineTrustedCaller,
  type PipelineTrustedCaller,
} from '../agent-messaging/pipeline-caller';
import type { CanopyInjectedToolRuntime } from '../canopy-tools/core';
import { ADVISOR_ACCESS_DISABLED_MESSAGE } from '../lib/app-advisor-project-agent-access';
import { readChatTabsFile } from '../lib/chat-tabs-reader';
import {
  logMainProcessError,
  logMainProcessWarn,
} from '../lib/main-process-logging';
import {
  createEntryFingerprint,
  readEntryAttempt,
  writeEntryAttempt,
  type EntryAttemptRecord,
} from './host-create-entry-state';
import { assignToNamedGroup } from './host-group-assignment';
import {
  hasWorkEntry,
  projectUnavailable,
  resolveHostProject,
  type PipelineHostOwnerCheck,
} from './host-task-resolution';

export interface CreateEntryHostDeps {
  assertTargetOwner: PipelineHostOwnerCheck;
  /** Injected in tests; production builds a pipeline-bound port per call. */
  projectBotPortFor?: (
    caller: PipelineTrustedCaller,
    plannedTaskId: string,
  ) => AgentProjectBotPort<CanopyInjectedToolRuntime>;
  receipts?: AgentActionReceiptStore<CanopyInjectedToolRuntime>;
}

type EntryRequest =
  | { action: 'create-project-entry'; inputs: CreateProjectEntryInputs }
  | { action: 'create-bot-entry'; inputs: CreateBotEntryInputs };

type CreateTaskAction =
  | { type: 'projects.create_task'; projectId: string; title?: string }
  | { type: 'bots.create_task'; botId: string; title?: string };

/** The resolved target: where its entry and tabs live, and how it is named. */
interface EntryTarget {
  label: EntryRequest['action'];
  entryWorkspaceId: string;
  tabsProjectId: string;
  scope: SidebarItemGroupScope;
  /** Empty outputs with `project_id` or `bot_id` set. */
  baseOutputs: Record<string, string>;
  /** `project_id` or `bot_id`, and its value. */
  idOutput: 'project_id' | 'bot_id';
  id: string;
  /** `Project \`x\`` or `Bot \`x\``, for error text. */
  subject: string;
  action: CreateTaskAction;
  group?: string;
}

interface CreatedTask {
  taskId: string;
  chatId: string;
  taskCreated: boolean;
  chatCreated: boolean;
}

export const DIFFERENT_INPUTS_MESSAGE =
  'This step already ran with different inputs';

export function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

export function errorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export function waitOrAbort<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

const receiptSchema = z.object({
  address: z.object({
    projectId: z.string().optional(),
    botId: z.string().optional(),
    taskId: z.string(),
    chatId: z.string(),
  }),
  taskCreated: z.boolean(),
  chatCreated: z.boolean(),
});

const creationResponseSchema = z.union([
  z.object({ ok: z.literal(true), result: receiptSchema }),
  z.object({
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
]);

type CreationResponse = z.infer<typeof creationResponseSchema>;

/**
 * Step 4 of the flow: the target and the owner check, before any project-type
 * refusal, journal read or dispatch. A cross-owner project reads like a
 * missing one.
 */
async function resolveEntryTarget(
  request: EntryRequest,
  caller: PipelineHostActionCaller,
  deps: CreateEntryHostDeps,
): Promise<EntryTarget> {
  const { title, group } = request.inputs;
  const titled = title !== undefined ? { title } : {};
  if (request.action === 'create-project-entry') {
    const { projectId } = request.inputs;
    const project = await resolveHostProject(projectId);
    await deps.assertTargetOwner(caller, {
      kind: 'project',
      projectId,
      workspaceType: project.workspaceType,
    });
    if (project.workspaceType !== 'cowork') {
      throw new PipelineHostRefusal(
        'unsupported_action',
        `Project \`${projectId}\` uses worktrees. Use create-worktree.`,
      );
    }
    return {
      label: request.action,
      entryWorkspaceId: project.workspaceId,
      tabsProjectId: projectId,
      // The sidebar service maps cowork ids in its own scope resolution.
      scope: { workspaceLocalId: projectId },
      baseOutputs: {
        ...emptyCreateProjectEntryOutputs(),
        project_id: projectId,
      },
      idOutput: 'project_id',
      id: projectId,
      subject: `Project \`${projectId}\``,
      action: { type: 'projects.create_task', projectId, ...titled },
      ...(group !== undefined ? { group } : {}),
    };
  }
  const { botId } = request.inputs;
  // App Advisor isn't owner-limited. An agent-originated run's Orchestrator
  // access setting is checked at dispatch; other runs aren't gated.
  if (botId !== 'app_advisor') {
    throw new PipelineHostRefusal(
      'not_found',
      `Bot \`${botId}\` isn't available to this pipeline`,
    );
  }
  return {
    label: request.action,
    entryWorkspaceId: APP_ADVISOR_PROJECT_ID,
    tabsProjectId: APP_ADVISOR_PROJECT_ID,
    scope: { appAdvisor: true },
    baseOutputs: { ...emptyCreateBotEntryOutputs(), bot_id: botId },
    idOutput: 'bot_id',
    id: botId,
    subject: `Bot \`${botId}\``,
    action: { type: 'bots.create_task', botId, ...titled },
    ...(group !== undefined ? { group } : {}),
  };
}

function failure(
  target: EntryTarget,
  failureReason: PipelineHostFailureReason,
  error: string,
  outputs: Record<string, string> = {},
): PipelineHostActionResult {
  return {
    status: 'failure',
    failureReason,
    error,
    outputs: { ...target.baseOutputs, ...outputs },
  };
}

/** A port or receipt refusal as a typed failure; anything unmapped throws. */
function mapRefusal(
  target: EntryTarget,
  error: { code: string; message: string },
): PipelineHostActionResult {
  switch (error.code) {
    case 'not_found':
      return failure(
        target,
        'not_found',
        target.idOutput === 'project_id'
          ? projectUnavailable(target.id)
          : `${target.subject} isn't available to this pipeline`,
      );
    case 'advisor_access_disabled':
      // The orchestration replaces the port's text with a generic one.
      return failure(
        target,
        'advisor_access_disabled',
        ADVISOR_ACCESS_DISABLED_MESSAGE,
      );
    case 'owner_context_unavailable':
      return failure(
        target,
        'owner_context_unavailable',
        `${target.subject} can't be checked right now. Try again.`,
      );
    case 'validation_failed':
    case 'invalid_payload':
      return failure(target, 'validation_failed', error.message);
    case 'invalid_target':
    case 'stale_ui_state':
      return failure(target, 'target_not_ready', error.message);
    case 'in_progress':
      return failure(
        target,
        'target_not_ready',
        'An earlier attempt of this step is still running.',
      );
    case 'unsupported_action':
      return failure(target, 'unsupported_action', error.message);
    case 'authorization_conflict':
      return failure(target, 'authorization_conflict', error.message);
    case 'idempotency_conflict':
      return failure(
        target,
        'authorization_conflict',
        DIFFERENT_INPUTS_MESSAGE,
      );
    default:
      throw new Error(
        `${target.label} creation failed with an unexpected ${error.code} refusal`,
      );
  }
}

/** Dispatches the canonical action; a thrown port error reads like a response. */
async function dispatchCreation(
  target: EntryTarget,
  trusted: PipelineTrustedCaller,
  caller: PipelineHostActionCaller,
  deps: CreateEntryHostDeps,
  taskId: string,
): Promise<CreationResponse> {
  const port =
    deps.projectBotPortFor?.(trusted, taskId) ??
    createDesktopPipelineProjectBotPort(trusted, undefined, taskId);
  const call: AgentActionCall<CanopyInjectedToolRuntime> = {
    actorKey: `pipeline:${trusted.executionId}`,
    host: unattendedDeliveryHost,
  };
  const action = target.action;
  const toolResult = await runIdempotentWrite({
    receipts: deps.receipts ?? desktopAgentActionReceipts,
    limits: null,
    kind: 'chat.create',
    call,
    idempotencyKey: caller.idempotencyKey,
    payload: action,
    prepare: () =>
      Promise.resolve({
        ok: true,
        parentDepth: 0,
        write: async (): Promise<AgentActionToolResult> => {
          try {
            const response = await port.dispatch(action, call);
            return {
              text: JSON.stringify(response),
              isError: response.ok !== true,
            };
          } catch (error) {
            if (!(error instanceof AgentPortError)) throw error;
            return {
              text: JSON.stringify({
                ok: false,
                error: { code: error.code, message: error.message },
              }),
              isError: true,
            };
          }
        },
      }),
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolResult.text);
  } catch {
    throw new Error(`${target.label} got an unreadable creation result`);
  }
  const response = creationResponseSchema.safeParse(parsed);
  if (!response.success) {
    throw new Error(`${target.label} got an unreadable creation result`);
  }
  return response.data;
}

/**
 * Whether a journaled `creating` attempt created its task. Unreadable tabs
 * are never proof that the chat is missing, nor that it exists.
 */
async function recoverCreating(
  target: EntryTarget,
  taskId: string,
): Promise<'created' | 'unconfirmed' | 'absent'> {
  if (!(await hasWorkEntry(target.entryWorkspaceId, taskId))) return 'absent';
  try {
    const { tabs } = await readChatTabsFile(target.tabsProjectId, taskId);
    return tabs.some((tab) => tab.id === taskId && tab.kind !== 'file')
      ? 'created'
      : 'unconfirmed';
  } catch {
    return 'unconfirmed';
  }
}

/** The planned task's Work Entry exists, but its founding chat isn't confirmed. */
function unconfirmedFailure(
  target: EntryTarget,
  taskId: string,
): PipelineHostActionResult {
  return failure(
    target,
    'target_not_ready',
    `Task \`${taskId}\` was created but its first chat isn't confirmed. Check the project.`,
    { task_id: taskId },
  );
}

/** A recovered task; its founding chat shares its id. */
function recoveredTask(taskId: string): CreatedTask {
  return { taskId, chatId: taskId, taskCreated: true, chatCreated: true };
}

/** Records the terminal result; a failed write is logged and changes nothing. */
async function finalize(
  artifactsDir: string,
  record: EntryAttemptRecord,
  target: EntryTarget,
  result: PipelineHostActionResult,
): Promise<PipelineHostActionResult> {
  record.phase = 'finalized';
  record.result = result;
  try {
    await writeEntryAttempt(artifactsDir, record);
  } catch (error) {
    logMainProcessWarn(
      `[pipeline-host] ${target.label} could not record its result`,
      { errorType: errorType(error) },
    );
  }
  return result;
}

/**
 * Records the created task; a failed write is logged and changes nothing, as
 * the `creating` record a resume reads already recovers the task.
 */
async function recordCreated(
  artifactsDir: string,
  record: EntryAttemptRecord,
  target: EntryTarget,
  chatId: string,
): Promise<void> {
  record.phase = 'created';
  record.chatId = chatId;
  try {
    await writeEntryAttempt(artifactsDir, record);
  } catch (error) {
    logMainProcessWarn(
      `[pipeline-host] ${target.label} could not record its task`,
      { errorType: errorType(error) },
    );
  }
}

async function runOperation(
  request: EntryRequest,
  caller: PipelineHostActionCaller,
  deps: CreateEntryHostDeps,
  signal: AbortSignal,
  artifactsDir: string,
  fingerprint: string,
): Promise<PipelineHostActionResult> {
  const trusted = pipelineTrustedCaller(caller);
  const target = await resolveEntryTarget(request, caller, deps);

  const read = await readEntryAttempt(artifactsDir, caller.idempotencyKey);
  if (read.kind === 'corrupt') {
    throw new PipelineHostRefusal(
      'target_not_ready',
      "This step's earlier attempt couldn't be read. Check the project before retrying.",
    );
  }
  let record: EntryAttemptRecord;
  let created: CreatedTask | undefined;
  if (read.kind === 'present') {
    record = read.record;
    if (record.fingerprint !== fingerprint) {
      throw new PipelineHostRefusal(
        'authorization_conflict',
        DIFFERENT_INPUTS_MESSAGE,
      );
    }
    if (record.phase === 'finalized') {
      if (record.result) return record.result;
      throw new PipelineHostRefusal(
        'target_not_ready',
        "This step's earlier attempt couldn't be read. Check the project before retrying.",
      );
    }
    if (record.phase === 'created') {
      created = {
        taskId: record.taskId,
        chatId: record.chatId ?? record.taskId,
        taskCreated: true,
        chatCreated: true,
      };
    } else {
      // `creating`: dispatch may have started before the app stopped.
      const recovered = await recoverCreating(target, record.taskId);
      if (recovered === 'unconfirmed') {
        return finalize(
          artifactsDir,
          record,
          target,
          unconfirmedFailure(target, record.taskId),
        );
      }
      if (recovered === 'created') {
        created = recoveredTask(record.taskId);
        await recordCreated(artifactsDir, record, target, record.taskId);
      }
    }
  } else {
    record = {
      version: 1,
      idempotencyKey: caller.idempotencyKey,
      fingerprint,
      phase: 'creating',
      taskId: randomUUID(),
    };
    // The last signal check, against the caller that started the operation;
    // a caller that joins it shares that outcome. Once `creating` is on disk,
    // dispatch may start and the operation runs to completion whatever its
    // callers do.
    signal.throwIfAborted();
    await writeEntryAttempt(artifactsDir, record);
  }

  if (!created) {
    const response = await dispatchCreation(
      target,
      trusted,
      caller,
      deps,
      record.taskId,
    );
    if (!response.ok) {
      // The orchestration reports a creation it couldn't confirm, which may
      // follow a commit, as `invalid_target`: settle it against the planned
      // task like a resumed `creating` attempt.
      const recovered =
        response.error.code === 'invalid_target'
          ? await recoverCreating(target, record.taskId)
          : 'absent';
      if (recovered === 'absent') {
        return finalize(
          artifactsDir,
          record,
          target,
          mapRefusal(target, response.error),
        );
      }
      if (recovered === 'unconfirmed') {
        return finalize(
          artifactsDir,
          record,
          target,
          unconfirmedFailure(target, record.taskId),
        );
      }
      created = recoveredTask(record.taskId);
      await recordCreated(artifactsDir, record, target, record.taskId);
    } else {
      const { address, taskCreated, chatCreated } = response.result;
      const addressed =
        target.idOutput === 'project_id' ? address.projectId : address.botId;
      if (addressed !== target.id || address.taskId !== record.taskId) {
        logMainProcessError(
          `[pipeline-host] ${target.label} created elsewhere`,
          {
            expected: { id: target.id, taskId: record.taskId },
            actual: {
              projectId: address.projectId,
              botId: address.botId,
              taskId: address.taskId,
            },
          },
        );
        throw new Error(
          `${target.label} created a task other than the one it planned`,
        );
      }
      created = {
        taskId: address.taskId,
        chatId: address.chatId,
        taskCreated,
        chatCreated,
      };
      await recordCreated(artifactsDir, record, target, address.chatId);
    }
  }

  let groupOutputs: Record<string, string> = {};
  if (target.group !== undefined) {
    if (record.group) {
      groupOutputs = record.group;
    } else {
      groupOutputs = await assignToNamedGroup(
        target.scope,
        created.taskId,
        target.group,
        target.label,
      );
      record.group = groupOutputs;
      try {
        await writeEntryAttempt(artifactsDir, record);
      } catch (error) {
        logMainProcessWarn(
          `[pipeline-host] ${target.label} could not record its group`,
          { errorType: errorType(error) },
        );
      }
    }
  }

  return finalize(artifactsDir, record, target, {
    status: 'success',
    outputs: {
      ...target.baseOutputs,
      task_id: created.taskId,
      chat_id: created.chatId,
      task_created: String(created.taskCreated),
      chat_created: String(created.chatCreated),
      ...groupOutputs,
    },
  });
}

interface LiveOperation {
  fingerprint: string;
  result: Promise<PipelineHostActionResult>;
}

/** One live operation per idempotency key: concurrent callers share it. */
const liveOperations = new Map<string, LiveOperation>();

async function runCreateEntry(
  request: EntryRequest,
  caller: PipelineHostActionCaller,
  deps: CreateEntryHostDeps,
  signal: AbortSignal,
  controls: PipelineHostActionControls | undefined,
): Promise<PipelineHostActionResult> {
  // Internal contract errors: no effects, not typed refusals.
  if (!controls) throw new Error(`${request.action} needs host controls`);
  if (!caller.idempotencyKey) {
    throw new Error(`${request.action} needs an idempotency key`);
  }
  if (signal.aborted) throw abortError();
  const key = caller.idempotencyKey;
  const fingerprint = createEntryFingerprint(request);
  let operation = liveOperations.get(key);
  if (operation && operation.fingerprint !== fingerprint) {
    throw new PipelineHostRefusal(
      'authorization_conflict',
      DIFFERENT_INPUTS_MESSAGE,
    );
  }
  if (!operation) {
    const created: LiveOperation = {
      fingerprint,
      result: runOperation(
        request,
        caller,
        deps,
        signal,
        controls.artifactsDir,
        fingerprint,
      ),
    };
    liveOperations.set(key, created);
    void created.result
      .catch(() => undefined)
      .finally(() => {
        if (liveOperations.get(key) === created) liveOperations.delete(key);
      });
    operation = created;
  }
  return waitOrAbort(operation.result, signal);
}

export function runCreateProjectEntryHostAction(
  inputs: CreateProjectEntryInputs,
  caller: PipelineHostActionCaller,
  deps: CreateEntryHostDeps,
  signal: AbortSignal,
  controls: PipelineHostActionControls | undefined,
): Promise<PipelineHostActionResult> {
  return runCreateEntry(
    { action: 'create-project-entry', inputs },
    caller,
    deps,
    signal,
    controls,
  );
}

export function runCreateBotEntryHostAction(
  inputs: CreateBotEntryInputs,
  caller: PipelineHostActionCaller,
  deps: CreateEntryHostDeps,
  signal: AbortSignal,
  controls: PipelineHostActionControls | undefined,
): Promise<PipelineHostActionResult> {
  return runCreateEntry(
    { action: 'create-bot-entry', inputs },
    caller,
    deps,
    signal,
    controls,
  );
}
