/**
 * Desktop main's `wait-for-agent-reply` host step: the core-side policy point
 * for waiting on a chat turn and exposing its final reply.
 *
 * Resolves the task and applies the run's owner check, then authorizes the
 * chat through the #5721 read path as a `pipeline` discovery caller. Waits on
 * the chat-state owner's settlement of the watched turn, then reads that
 * turn's final assistant message by turn ID. The read is host-internal, not an
 * agent action. Access is checked when the chat binds and again at the read,
 * which fails closed with `reply_state` and `turn_id` still written.
 *
 * `binding.json` (the turn this attempt bound, reused after a restart) and
 * `reply.md` (the full reply behind `reply_file`) live under the execution's
 * host artifacts folder, never in a checkout. Message text is never logged.
 */
import { mkdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { BotChatAddress } from '@canopy/desktop-shared/lib/bot-discovery';
import type { ProjectChatAddress } from '@canopy/desktop-shared/lib/project-discovery';
import { REPLY_READ_MARGIN_MINUTES } from '@canopy/execution-engine/node/pipelines/executor/host-action-runner';
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
  emptyWaitForAgentReplyOutputs,
  type HostChatAddress,
  type WaitForAgentReplyInputs,
} from '@canopy/execution-engine/pipelines/host-wait-for-agent-reply';
import {
  parseWorkspaceContext,
  PERSONAL_WORKSPACE_CONTEXT,
  type WorkspaceContext,
} from '@canopy/protocol/workspace-context';
import { writeFileAtomically } from '../lib/atomic-file';
import { ADVISOR_ACCESS_DISABLED } from '../lib/app-advisor-project-agent-access';
import type { ProjectDiscoveryCaller } from '../project-discovery';
import { resolveBotReadBinding } from '../project-discovery/bots/target';
import {
  resolveAuthorizedChat,
  type ChatReadContext,
} from '../project-discovery/chat-target';
import { DiscoveryError } from '../project-discovery/errors';
import { readTurnReply } from '../project-discovery/reads/turn-reply';
import {
  abortReasonError,
  waitForAgentReplyTurn,
  type AgentReplyWaitDeps,
} from './agent-reply-wait';
import {
  createChatReplyWaitDeps,
  desktopChatReplyWaitServices,
} from './agent-reply-wait-chat';
import {
  botUnavailable,
  chatNotInTask,
  messageNotInChat,
  projectUnavailable,
  resolveTask,
  taskNotInBot,
  taskNotInProject,
  type PipelineHostOwnerCheck,
} from './host-task-resolution';

export interface WaitForAgentReplyHostDeps {
  assertTargetOwner: PipelineHostOwnerCheck;
  /** Injectable for tests; production uses the turn-reply read and the chat-state deps. */
  readTurnReply?: typeof readTurnReply;
  resolveChatContext?: (
    address: ProjectChatAddress | BotChatAddress,
    caller: ProjectDiscoveryCaller,
  ) => Promise<ChatReadContext>;
  waitDeps?: (context: ChatReadContext) => Promise<AgentReplyWaitDeps>;
  wait?: typeof waitForAgentReplyTurn;
  /** Pause between reads while the transcript catches up. Default 1 s. */
  readRetryMs?: number;
}

const BINDING_FILE = 'binding.json';
const REPLY_FILE = 'reply.md';
const DEFAULT_READ_RETRY_MS = 1_000;
/** The wait's own commit coalescing, so a busy chat can't drive back-to-back reads. */
const READ_COALESCE_MS = 250;
/**
 * The executor raises a default step deadline to the reply timeout plus the
 * read margin, measured before the chat binds, so the step bound lands just
 * short of the reply deadline. Within this slack the reply timeout is the
 * limit that ended the wait.
 */
const STEP_BOUND_SLACK_MS = 60_000;

type Failure = Extract<PipelineHostActionResult, { status: 'failure' }>;

function chatAddress(
  chat: HostChatAddress,
): ProjectChatAddress | BotChatAddress {
  return chat.kind === 'project'
    ? { projectId: chat.projectId, taskId: chat.taskId, chatId: chat.chatId }
    : { botId: chat.botId, taskId: chat.taskId, chatId: chat.chatId };
}

function ownerName(chat: HostChatAddress): string {
  return chat.kind === 'project'
    ? `Project \`${chat.projectId}\``
    : `Bot \`${chat.botId}\``;
}

function failure(
  failureReason: PipelineHostFailureReason,
  error: string,
  outputs: Record<string, string>,
): Failure {
  return { status: 'failure', failureReason, error, outputs: { ...outputs } };
}

function timedOut(outputs: Record<string, string>, error: string): Failure {
  return failure('reply_timed_out', error, {
    ...outputs,
    reply_state: 'timed_out',
  });
}

function stepDeadlineMessage(chatId: string): string {
  return `No reply from chat \`${chatId}\` before the step deadline`;
}

function replyTimeoutMessage(chatId: string, minutes: number): string {
  return `No reply from chat \`${chatId}\` within ${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/**
 * The typed refusal for a discovery error, or null for one that isn't a
 * refusal. Distinguishes project, task and chat misses by #5721's messages.
 */
function hostRefusalFrom(
  error: unknown,
  chat: HostChatAddress,
): { failureReason: PipelineHostFailureReason; message: string } | null {
  if (!(error instanceof DiscoveryError)) return null;
  switch (error.code) {
    case 'not_found': {
      if (error.message === 'Project was not found.')
        return {
          failureReason: 'not_found',
          message:
            chat.kind === 'project'
              ? projectUnavailable(chat.projectId)
              : botUnavailable(chat.botId),
        };
      if (error.message === 'Task was not found.')
        return {
          failureReason: 'not_found',
          message:
            chat.kind === 'project'
              ? taskNotInProject(chat.taskId, chat.projectId)
              : taskNotInBot(chat.taskId, chat.botId),
        };
      return {
        failureReason: 'not_found',
        message: chatNotInTask(chat.chatId, chat.taskId),
      };
    }
    case 'owner_context_unavailable':
      return {
        failureReason: 'owner_context_unavailable',
        message: `${ownerName(chat)} can't be checked right now. Try again.`,
      };
    case ADVISOR_ACCESS_DISABLED:
      return {
        failureReason: 'advisor_access_disabled',
        message: `${ownerName(chat)} isn't available to the agent that started this pipeline`,
      };
    default:
      return null;
  }
}

/**
 * The owner a project chat reads as. A Personal project linked to the run's
 * organization runs in that organization, so the host owner check lets the run
 * target it; the discovery read then reads it as Personal.
 */
async function projectReadOwner(
  runOwner: WorkspaceContext,
  chat: HostChatAddress,
): Promise<WorkspaceContext> {
  if (chat.kind !== 'project' || runOwner.kind !== 'organization')
    return runOwner;
  const { resolveBackgroundTargetContext } =
    await import('../services/background-execution-context');
  let resolved: Awaited<ReturnType<typeof resolveBackgroundTargetContext>>;
  try {
    resolved = await resolveBackgroundTargetContext(
      // The target the host owner check resolves.
      { projectId: chat.projectId, worktreeId: chat.taskId },
      runOwner,
    );
  } catch {
    // An unresolvable target is unchecked, not missing.
    throw new PipelineHostRefusal(
      'owner_context_unavailable',
      `${ownerName(chat)} can't be checked right now. Try again.`,
    );
  }
  return resolved.matches && resolved.targetOwner.kind === 'personal'
    ? PERSONAL_WORKSPACE_CONTEXT
    : runOwner;
}

/** The run's recorded owner, as the host owner check reads it. */
async function pipelineDiscoveryCaller(
  caller: PipelineHostActionCaller,
  chat: HostChatAddress,
): Promise<ProjectDiscoveryCaller> {
  const runOwner = parseWorkspaceContext(caller.executionContext ?? 'personal');
  if (runOwner === null)
    throw new PipelineHostRefusal(
      'owner_context_unavailable',
      `${ownerName(chat)} can't be checked right now. Try again.`,
    );
  const owner = await projectReadOwner(runOwner, chat);
  return {
    kind: 'pipeline',
    owner,
    ...(caller.agentOrigin !== undefined
      ? { agentOrigin: caller.agentOrigin }
      : {}),
  };
}

async function defaultResolveChatContext(
  address: ProjectChatAddress | BotChatAddress,
  caller: ProjectDiscoveryCaller,
): Promise<ChatReadContext> {
  if ('botId' in address)
    return (
      await resolveBotReadBinding(
        { type: 'bots.get_last_agent_response', ...address },
        caller,
      )
    ).context;
  return resolveAuthorizedChat(address, caller);
}

async function defaultWaitDeps(
  context: ChatReadContext,
): Promise<AgentReplyWaitDeps> {
  return createChatReplyWaitDeps(
    context,
    await desktopChatReplyWaitServices(context),
  );
}

/** The turn an earlier run of this attempt bound, when the pin matches this request. */
async function readPin(
  artifactsDir: string,
  inputs: WaitForAgentReplyInputs,
): Promise<string | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      await readFile(path.join(artifactsDir, BINDING_FILE), 'utf8'),
    );
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const turnId: unknown = Reflect.get(parsed, 'turnId');
  const chatId: unknown = Reflect.get(parsed, 'chatId');
  const messageId: unknown = Reflect.get(parsed, 'messageId');
  if (typeof turnId !== 'string' || !turnId) return undefined;
  if (chatId !== inputs.chat.chatId || messageId !== inputs.messageId)
    return undefined;
  return turnId;
}

/**
 * Resolves shortly after the next chat change (a burst of commits coalesces
 * into one read) or after `ms`; rejects on abort.
 */
function nextChange(
  deps: AgentReplyWaitDeps,
  ms: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReasonError(signal));
      return;
    }
    let unsubscribe = (): void => undefined;
    let coalescing = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (): void => {
      clearTimeout(timer);
      unsubscribe();
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      done();
      reject(abortReasonError(signal));
    };
    const settle = (): void => {
      done();
      resolve();
    };
    // Subscribe first, so a throwing subscribe arms no timer or listener.
    unsubscribe = deps.onChange(() => {
      if (coalescing) return;
      coalescing = true;
      clearTimeout(timer);
      timer = setTimeout(settle, Math.min(ms, READ_COALESCE_MS));
    });
    if (!coalescing) timer = setTimeout(settle, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function runWaitForAgentReplyHostAction(
  inputs: WaitForAgentReplyInputs,
  caller: PipelineHostActionCaller,
  deps: WaitForAgentReplyHostDeps,
  signal: AbortSignal,
  controls: PipelineHostActionControls | undefined,
): Promise<PipelineHostActionResult> {
  if (!controls)
    throw new Error('wait-for-agent-reply needs execution controls');
  const { chat } = inputs;
  const outputs = emptyWaitForAgentReplyOutputs();
  // Registered before the first await. It wins over a settled state when the
  // final read never completed, keeping the turn bound so far.
  controls.registerTimeoutFinalizer(() =>
    Promise.resolve(timedOut(outputs, stepDeadlineMessage(chat.chatId))),
  );

  try {
    const { target } = await resolveTask(
      chat.kind === 'project'
        ? { kind: 'project', projectId: chat.projectId, taskId: chat.taskId }
        : { kind: 'bot', botId: chat.botId, taskId: chat.taskId },
    );
    await deps.assertTargetOwner(caller, target);
    signal.throwIfAborted();

    const discoveryCaller = await pipelineDiscoveryCaller(caller, chat);
    const address = chatAddress(chat);
    let context: ChatReadContext;
    try {
      context = await (deps.resolveChatContext ?? defaultResolveChatContext)(
        address,
        discoveryCaller,
      );
    } catch (error) {
      const refusal = hostRefusalFrom(error, chat);
      if (!refusal) throw error;
      return failure(refusal.failureReason, refusal.message, outputs);
    }
    signal.throwIfAborted();

    const waitDeps = await (deps.waitDeps ?? defaultWaitDeps)(context);
    const pinnedTurnId = await readPin(controls.artifactsDir, inputs);
    // A replayed attempt's turn is already bound; the finalizer reports it.
    if (pinnedTurnId !== undefined) outputs.turn_id = pinnedTurnId;
    const now = Date.now();
    const replyDeadline = now + inputs.replyTimeoutMinutes * 60_000;
    const stepBound = controls.deadlineAt - REPLY_READ_MARGIN_MINUTES * 60_000;
    // With less than the read margin left, the step deadline and its
    // finalizer answer instead of a wait that ends before it starts.
    const deadlineAt = Math.min(
      replyDeadline,
      stepBound > now ? stepBound : controls.deadlineAt,
    );
    const result = await (deps.wait ?? waitForAgentReplyTurn)(waitDeps, {
      ...(inputs.messageId !== undefined
        ? { messageId: inputs.messageId }
        : {}),
      ...(pinnedTurnId !== undefined ? { pinnedTurnId } : {}),
      deadlineAt,
      signal,
      onPinned: async (turnId) => {
        signal.throwIfAborted();
        // Before the write, so a deadline that fires mid-pin still reports it.
        outputs.turn_id = turnId;
        await mkdir(controls.artifactsDir, { recursive: true });
        await writeFileAtomically(
          path.join(controls.artifactsDir, BINDING_FILE),
          JSON.stringify({
            chatId: chat.chatId,
            ...(inputs.messageId !== undefined
              ? { messageId: inputs.messageId }
              : {}),
            turnId,
          }),
          { encoding: 'utf8' },
        );
      },
    });

    switch (result.kind) {
      case 'unknown_message':
        return failure(
          'not_found',
          `${messageNotInChat(inputs.messageId ?? '', chat.chatId)}. Pass message_id from send-agent-message.`,
          outputs,
        );
      case 'never_ran':
        outputs.reply_state = 'cancelled';
        return { status: 'success', outputs: { ...outputs } };
      case 'none':
        outputs.reply_state = 'none';
        return { status: 'success', outputs: { ...outputs } };
      case 'timed_out':
        // A turn pinned as the deadline fired is still the bound turn.
        outputs.turn_id = result.turnId ?? outputs.turn_id;
        return timedOut(
          outputs,
          deadlineAt >= replyDeadline - STEP_BOUND_SLACK_MS
            ? replyTimeoutMessage(chat.chatId, inputs.replyTimeoutMinutes)
            : stepDeadlineMessage(chat.chatId),
        );
      case 'settled':
        outputs.reply_state = result.state;
        outputs.turn_id = result.turnId;
        break;
    }

    const read = deps.readTurnReply ?? readTurnReply;
    const retryMs = deps.readRetryMs ?? DEFAULT_READ_RETRY_MS;
    // The read keeps the margin past the reply timeout that the executor
    // reserved for it, never the rest of a longer step deadline.
    const readReplyBound = replyDeadline + REPLY_READ_MARGIN_MINUTES * 60_000;
    for (;;) {
      signal.throwIfAborted();
      if (Date.now() >= controls.deadlineAt)
        return timedOut(outputs, stepDeadlineMessage(chat.chatId));
      if (Date.now() >= readReplyBound)
        return timedOut(
          outputs,
          replyTimeoutMessage(chat.chatId, inputs.replyTimeoutMinutes),
        );
      let turnReply: Awaited<ReturnType<typeof readTurnReply>> | null = null;
      try {
        // Rebuilt per read, so a project unlinked mid-wait fails closed.
        turnReply = await read(
          address,
          result.endedTurnId,
          await pipelineDiscoveryCaller(caller, chat),
        );
      } catch (error) {
        if (
          !(error instanceof DiscoveryError) ||
          error.code !== 'cursor_context_changed'
        ) {
          const refusal = hostRefusalFrom(error, chat);
          if (!refusal) throw error;
          return failure(refusal.failureReason, refusal.message, outputs);
        }
      }
      signal.throwIfAborted();
      switch (turnReply?.kind) {
        case 'reply': {
          const file = path.join(controls.artifactsDir, REPLY_FILE);
          await mkdir(controls.artifactsDir, { recursive: true });
          await writeFileAtomically(file, turnReply.reply.fullText, {
            encoding: 'utf8',
          });
          outputs.reply_message_id = turnReply.reply.messageId;
          outputs.reply_text = turnReply.reply.text;
          outputs.reply_truncated = String(turnReply.reply.truncated);
          outputs.reply_file = file;
          return { status: 'success', outputs: { ...outputs } };
        }
        case 'no_reply':
          return { status: 'success', outputs: { ...outputs } };
        case 'not_settled':
        case undefined:
          // The transcript hasn't caught up with the settlement, or the read
          // context moved; read again on the next change.
          await nextChange(waitDeps, retryMs, signal);
      }
    }
  } catch (error) {
    if (error instanceof PipelineHostRefusal)
      return failure(error.failureReason, error.message, outputs);
    throw error;
  }
}
