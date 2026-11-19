/**
 * What hosted agents (the web MCP Remote Control tools, CAN-5985) may do on a
 * paired computer, reviewed by effect.
 *
 * {@link HOSTED_CONTROLLER_CHANNELS} in `./channels` is the host's allowlist.
 * It is exactly the channels reachable from the operations below (derived with
 * `deriveRemoteIpcChannels`), the hosted chat dispatch, the channels the
 * hosted tools call directly ({@link HOSTED_DIRECT_CHANNELS}) and the
 * post-pairing identity read; the hosted allowlist golden holds them equal.
 * Adding a hosted tool operation therefore means reviewing its channels here
 * first.
 *
 * Effects the hosted profile must never reach: terminals, approval answers
 * (tool approval, permission, plan review, secret input), and destructive work
 * (delete, archive, discard, remove, force push, merge). Generic or
 * argument-sensitive channels also have an argument policy on the host
 * ({@link hostedInvocationAllowed}): `chat:command` may only start chats, send
 * messages and answer ordinary questions; `chat:cancel` must name the exact
 * turn it stops; `work-entries:create` takes only its project;
 * `file:read-content` reads only inside one worktree's roots.
 */
import type {
  RemoteCapabilityValues,
  RemoteOperationSelection,
} from './operation-channels';

/** `CanopyClient` operations the hosted tools call over a direct session. */
export const HOSTED_TOOL_OPERATIONS = {
  queries: [
    'session.snapshot',
    'chat.history',
    'file.roots',
    'file.directory',
    'file.read',
    'plan.get',
    // One file's diff (`activity:file-diff`); `task_diff_get` composes the
    // worktree diff from these.
    'diff.read',
  ],
  commands: ['worktree.create'],
  events: ['chat.message', 'session.snapshot-stale'],
} as const satisfies RemoteOperationSelection;

/**
 * The capabilities the hosted client reports. Every other capability is off,
 * so gated branches (branching a worktree with its open tabs, file writes,
 * terminals) stay unreachable.
 */
export const HOSTED_TOOL_CAPABILITIES: RemoteCapabilityValues = {
  worktreeCreation: true,
};

/**
 * Hosted chat operations outside the CanopyClient manifest: starting a chat,
 * sending it a message and answering its ordinary question. All travel on
 * `chat:command`, whose arguments the host checks with
 * {@link hostedInvocationAllowed}. The host serves a hosted session's
 * `chat:command` itself and stamps the agent attribution on sends and answers;
 * the controller never supplies it.
 */
export const HOSTED_CHAT_COMMAND_CHANNEL = 'chat:command';

/** The post-pairing identity read (`remote-control:install-id`). */
export const HOSTED_IDENTITY_CHANNEL = 'remote-control:install-id';

/**
 * Read-only desktop channels added for hosted controllers (CAN-5985). Each
 * serves the read the Portal command of the same purpose runs, addressed by
 * project and worktree IDs only (never a host path). The desktop catalogs
 * (`IPC_CHANNELS`, `PIPELINE_CHANNELS`) hold the same values; the host
 * authorization golden keeps them equal.
 */
export const HOSTED_IPC_CHANNELS = {
  /** One worktree's pull request status (`portal.pr` state refresh). */
  githubGetPrState: 'github:get-pr-state',
  /** Cached provider-usage limits; accepts only one empty object. */
  providerUsageLimitsGet: 'provider-usage:limits-get',
  /** One worktree's pipelines (`portal.pipeline.list`). */
  pipelinesListForWorktree: 'pipelines:list-for-worktree',
  /** One worktree's pipeline runs (`portal.pipeline.execution_list`). */
  pipelinesListWorktreeExecutions: 'pipelines:list-worktree-executions',
  /** One run, held to its worktree (`portal.pipeline.execution.get`). */
  pipelinesGetWorktreeExecution: 'pipelines:get-worktree-execution',
} as const;

/** `chat:cancel`, which a hosted controller may use only for one exact turn. */
export const HOSTED_CHAT_CANCEL_CHANNEL = 'chat:cancel';

/** `work-entries:create`, the first half of a no-repository task. */
export const HOSTED_WORK_ENTRY_CREATE_CHANNEL = 'work-entries:create';

/** A file read, held to one worktree's roots by {@link hostedInvocationAllowed}. */
export const HOSTED_FILE_READ_CHANNEL = 'file:read-content';

/**
 * Channels the hosted tools call directly, outside the CanopyClient manifest,
 * each with one reviewed effect:
 *
 * - `activity:changed-files`: read a worktree's changed files (`task_diff_get`).
 * - `tracked-plans:list`: read a worktree's plans (`plan_list`).
 * - {@link HOSTED_IPC_CHANNELS}: read pull request status, pipelines and runs.
 * - `provider-usage:limits-get`: read the cached provider limits snapshot.
 * - `chat:cancel`: stop one exact turn the agent names, never another
 *   (`task_cancel`); argument checked on the host.
 * - `work-entries:create`: add an empty work entry for a no-repository task,
 *   the additive create `task_create` already confirms; argument checked.
 */
export const HOSTED_DIRECT_CHANNELS: readonly string[] = [
  'activity:changed-files',
  HOSTED_CHAT_CANCEL_CHANNEL,
  HOSTED_IPC_CHANNELS.githubGetPrState,
  HOSTED_IPC_CHANNELS.providerUsageLimitsGet,
  HOSTED_IPC_CHANNELS.pipelinesGetWorktreeExecution,
  HOSTED_IPC_CHANNELS.pipelinesListForWorktree,
  HOSTED_IPC_CHANNELS.pipelinesListWorktreeExecutions,
  'tracked-plans:list',
  HOSTED_WORK_ENTRY_CREATE_CHANNEL,
];

/** `chat:command` envelope fields a hosted controller may set. */
const HOSTED_CHAT_ENVELOPE_FIELDS: ReadonlySet<string> = new Set([
  'schemaVersion',
  'commandId',
  'projectId',
  'worktreeId',
  'command',
]);

/**
 * The chat commands a hosted controller may send, and the fields each may
 * carry. Anything else (approval mode, plugin selections, seeded tabs,
 * attachments, plan review approval, agent-send provenance, archive, close,
 * reset, dismissals) is refused by the host. `chat.answer_question` answers an
 * ordinary agent question only: tool approvals, permissions and plan review
 * are other commands and channels, and the host also refuses an answer to a
 * secret-input question.
 */
export const HOSTED_CHAT_COMMAND_FIELDS: ReadonlyMap<
  string,
  ReadonlySet<string>
> = new Map([
  ['chat.create_tab', new Set(['type', 'tabId', 'model', 'planMode'])],
  [
    'chat.send_message',
    new Set(['type', 'chatId', 'userMessageId', 'text', 'model', 'planMode']),
  ],
  [
    'chat.answer_question',
    new Set(['type', 'chatId', 'questionId', 'answers']),
  ],
]);

/** Fields of one answer in a hosted `chat.answer_question`. */
const HOSTED_ANSWER_FIELDS: ReadonlySet<string> = new Set([
  'questionId',
  'question',
  'selectedOptions',
  'freeformText',
]);

/** A hosted `chat:cancel` names its scope, chat and the exact running turn. */
const HOSTED_CANCEL_FIELDS: ReadonlySet<string> = new Set([
  'projectId',
  'worktreeId',
  'chatId',
  'expectedUserMessageId',
]);

const MAX_ID_LENGTH = 256;
const MAX_TEXT_LENGTH = 200_000;
const MAX_ANSWERS = 16;
const MAX_SELECTED_OPTIONS = 64;

/**
 * A deserialized object. Its prototype is not compared: structured clones are
 * created in the deserializing realm, which need not be this module's.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === '[object Object]'
  );
}

function isId(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH
  );
}

function onlyFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function hostedChatCommandAllowed(value: unknown): boolean {
  if (!isPlainRecord(value) || !onlyFields(value, HOSTED_CHAT_ENVELOPE_FIELDS))
    return false;
  if (
    value.schemaVersion !== 1 ||
    !isId(value.commandId) ||
    !isId(value.projectId) ||
    !isId(value.worktreeId)
  )
    return false;
  const command = value.command;
  if (!isPlainRecord(command) || typeof command.type !== 'string') return false;
  const fields = HOSTED_CHAT_COMMAND_FIELDS.get(command.type);
  if (fields === undefined || !onlyFields(command, fields)) return false;
  if (command.model !== undefined && !isId(command.model)) return false;
  if (command.planMode !== undefined && typeof command.planMode !== 'boolean')
    return false;
  switch (command.type) {
    case 'chat.create_tab':
      return isId(command.tabId);
    case 'chat.answer_question':
      return (
        isId(command.chatId) &&
        isId(command.questionId) &&
        hostedAnswersAllowed(command.answers)
      );
    default:
      return (
        isId(command.chatId) &&
        isId(command.userMessageId) &&
        isBoundedText(command.text, 1)
      );
  }
}

function isBoundedText(value: unknown, minLength: number): boolean {
  return (
    typeof value === 'string' &&
    value.length >= minLength &&
    value.length <= MAX_TEXT_LENGTH
  );
}

/** Plain question answers: chosen option labels and an optional free text. */
function hostedAnswersAllowed(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ANSWERS)
    return false;
  return value.every(
    (answer) =>
      isPlainRecord(answer) &&
      onlyFields(answer, HOSTED_ANSWER_FIELDS) &&
      (answer.questionId === undefined || isId(answer.questionId)) &&
      isBoundedText(answer.question, 1) &&
      Array.isArray(answer.selectedOptions) &&
      answer.selectedOptions.length <= MAX_SELECTED_OPTIONS &&
      answer.selectedOptions.every((option) => isBoundedText(option, 1)) &&
      (answer.freeformText === undefined ||
        isBoundedText(answer.freeformText, 0)),
  );
}

/** A hosted stop must name the exact turn; it never stops whatever runs. */
function hostedChatCancelAllowed(value: unknown): boolean {
  return (
    isPlainRecord(value) &&
    onlyFields(value, HOSTED_CANCEL_FIELDS) &&
    isId(value.projectId) &&
    isId(value.worktreeId) &&
    isId(value.chatId) &&
    isId(value.expectedUserMessageId)
  );
}

/** A new work entry in one project: no title, group or other field. */
function hostedWorkEntryCreateAllowed(value: unknown): boolean {
  return (
    isPlainRecord(value) &&
    onlyFields(value, new Set(['projectId'])) &&
    isId(value.projectId)
  );
}

/** `file:read-content` fields a hosted read may carry. */
const HOSTED_FILE_READ_FIELDS: ReadonlySet<string> = new Set([
  'absolutePath',
  'workspaceTarget',
  'file',
]);

/**
 * A hosted file read is always held to one worktree's roots: the host reads
 * an unscoped `file:read-content` (no `workspaceTarget`) straight from disk,
 * and `allowedRoot` opens another root.
 */
function hostedFileReadAllowed(value: unknown): boolean {
  if (
    !isPlainRecord(value) ||
    !onlyFields(value, HOSTED_FILE_READ_FIELDS) ||
    typeof value.absolutePath !== 'string'
  )
    return false;
  const target = value.workspaceTarget;
  if (
    !isPlainRecord(target) ||
    !onlyFields(target, new Set(['projectId', 'worktreeId'])) ||
    !isId(target.projectId) ||
    !isId(target.worktreeId)
  )
    return false;
  const file = value.file;
  return (
    file === undefined ||
    (isPlainRecord(file) &&
      onlyFields(file, new Set(['fileRootId', 'relativePath'])) &&
      isId(file.fileRootId) &&
      typeof file.relativePath === 'string')
  );
}

/**
 * Argument-level policy for a hosted controller's invoke or send on a channel
 * its allowlist already admits. Generic or argument-sensitive channels have
 * one: `chat:command` (new chats, messages and ordinary answers only),
 * `chat:cancel` (one exact turn), `work-entries:create` (its project only)
 * and `file:read-content` (one worktree's roots only). Every other hosted
 * channel has a single effect.
 */
export function hostedInvocationAllowed(
  channel: string,
  args: readonly unknown[],
): boolean {
  switch (channel) {
    case HOSTED_IPC_CHANNELS.providerUsageLimitsGet:
      return (
        args.length === 1 &&
        isPlainRecord(args[0]) &&
        Object.keys(args[0]).length === 0
      );
    case HOSTED_CHAT_COMMAND_CHANNEL:
      return args.length === 1 && hostedChatCommandAllowed(args[0]);
    case HOSTED_CHAT_CANCEL_CHANNEL:
      return args.length === 1 && hostedChatCancelAllowed(args[0]);
    case HOSTED_WORK_ENTRY_CREATE_CHANNEL:
      return args.length === 1 && hostedWorkEntryCreateAllowed(args[0]);
    case HOSTED_FILE_READ_CHANNEL:
      return args.length === 1 && hostedFileReadAllowed(args[0]);
    default:
      return true;
  }
}

/**
 * Patterns for effects the hosted profile must never reach. The wire golden
 * checks the allowlist against them; a match needs an explicit effect review.
 */
export const HOSTED_FORBIDDEN_CHANNEL_PATTERNS: readonly RegExp[] = [
  /^terminal:/,
  /respond-to-approval/,
  /approval/,
  /secret/,
  /permission/,
  /delete/,
  /archive/,
  /discard/,
  /remove/,
  /force/,
  /merge/,
  /push/,
  /uninstall/,
  /:stop/,
  /kill/,
];
