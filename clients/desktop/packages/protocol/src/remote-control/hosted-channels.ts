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
 * (delete, archive, discard, remove, force push, merge), with one reviewed
 * exception (CAN-7446): a locked, restorable archive of a task or chat that
 * keeps the task's branch ({@link HOSTED_ARCHIVE_CHANNELS} and
 * `chat.archive_tab`). No hosted call may
 * name a Bot project such as the Orchestrator (CAN-7604). Generic or
 * argument-sensitive channels also have an argument policy on the host
 * ({@link hostedInvocationAllowed}): `chat:command` may only start chats,
 * send messages, answer ordinary questions, set a chat's model, change the
 * reviewed chat settings and steer a queued message; `chat:cancel` must name
 * the exact turn it stops; `work-entries:create` takes only its project;
 * `file:read-content` reads only inside one worktree's roots; and every
 * channel in {@link HOSTED_DIRECT_CHANNELS} added by CAN-7445 or CAN-7446
 * takes exactly its reviewed argument shape.
 */
import { SIDEBAR_ITEM_GROUP_COLORS } from '../canopy-core/sidebar-values';
import { APP_ADVISOR_PROJECT_ID, isBotProjectId } from '../chat-targets';
import type { HostedFirstPartyClient } from './security';
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
 * A Slack session's read of one Orchestrator message's turn (CAN-7604),
 * served by the computer itself for Slack sessions only: whether the turn
 * started by `userMessageId` is queued, running, waiting on the person, or
 * settled. Takes exactly `{ chatId, userMessageId }`.
 */
export const HOSTED_SLACK_TURN_STATUS_CHANNEL = 'app-advisor:slack-turn-status';

/**
 * Channels the hosted Tasks tools reach for CAN-7445, each with an exact
 * argument policy in {@link hostedInvocationAllowed}. `workEntriesUpdate` and
 * `worktreeSetTrackedBaseBranch` are not in the protocol's
 * `REMOTE_IPC_CHANNELS`; the desktop's `IPC_CHANNELS` holds the same values,
 * and the host authorization golden keeps them equal.
 */
export const HOSTED_TASK_CHANNELS = {
  pluginCatalogList: 'plugin-catalog:list',
  homeListBranchTargets: 'home:list-branch-targets',
  worktreeActivityEntities: 'worktree:activity-entities',
  hookChangePause: 'hook:change-pause',
  chatQueueCancel: 'chat:queue-cancel',
  chatQueueEdit: 'chat:queue-edit',
  chatQueueForce: 'chat:queue-force',
  worktreeSetLabel: 'worktree:set-label',
  worktreeSetHidden: 'worktree:set-hidden',
  worktreeSetTrackedBaseBranch: 'worktree:set-tracked-base-branch',
  workEntriesUpdate: 'work-entries:update',
  sidebarItemGroupsCreate: 'sidebar-item-groups:create',
  sidebarItemGroupsMoveItem: 'sidebar-item-groups:move-item',
} as const;

/**
 * Channels the hosted `task_delete` tool reaches for CAN-7446, each with an
 * exact argument policy in {@link hostedInvocationAllowed}: only a locked,
 * restorable archive that keeps the task's branch. The Delete path
 * (`lockAfterArchive` absent or false), branch deletion, host paths and the
 * remaining-order keys are refused. The desktop's `IPC_CHANNELS` holds the
 * same values, and the host authorization golden keeps them equal.
 */
export const HOSTED_ARCHIVE_CHANNELS = {
  worktreeArchive: 'worktree:archive',
  workspaceArchiveWorktree: 'workspace:archive-worktree',
  workEntriesDelete: 'work-entries:delete',
} as const;

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
 *
 * CAN-7445 (Tasks tools on a connected computer; every one argument checked):
 *
 * - `plugin-catalog:list`: read the computer's plugin, skill, collection and
 *   MCP server catalog (`task_chat_plugins_list`, plugin resolution).
 * - `home:list-branch-targets`: read a workspace's branches
 *   (`task_create_ref_list`). The read may contact the remote once to resolve
 *   the default branch.
 * - `worktree:activity-entities`: read a worktree's hooks and other activity
 *   entities (`task_hook_list`).
 * - `hook:change-pause`: pause or resume one named hook, or all of a
 *   worktree's hooks (`task_hook_pause_set`).
 * - `chat:queue-cancel`: remove one queued message the agent names; the
 *   message is not sent (`task_chat_queue_update`).
 * - `chat:queue-edit`: replace one queued message's text. The hosted edit
 *   carries no attachment or file reference fields, and the computer clears
 *   them when they are omitted, so the tool refuses an entry that has any.
 * - `chat:queue-force`: send one queued message now, interrupting the running
 *   turn. Unlike hosted `chat:cancel`, it names no turn, so it interrupts
 *   whichever turn runs, and the entry may be one the person queued; it
 *   deletes and pushes nothing. Reviewed exemption from `/force/` in
 *   {@link HOSTED_FORBIDDEN_PATTERN_EXEMPTIONS}.
 * - `worktree:set-label`, `worktree:set-hidden`: rename or hide a task's
 *   worktree in the sidebar (`task_update`).
 * - `worktree:set-tracked-base-branch`: change the branch a task's diff and
 *   pull request compare against; no checkout or git write.
 * - `work-entries:update`: rename a no-repository task; nothing else.
 * - `sidebar-item-groups:create`: add a named sidebar group holding one
 *   sidebar item.
 * - `sidebar-item-groups:move-item`: move one sidebar item into an existing
 *   group, or out of its group.
 *
 * The group channels check the item ID's shape only, not that it names a
 * task in the scope; the web sends the authorized task's own item.
 *
 * CAN-7446 (archive on a connected computer; every one argument checked):
 *
 * - `worktree:archive`, `workspace:archive-worktree`: archive a single-repo or
 *   multi-repo task's worktree as locked, keeping its branch. No `repoPath`,
 *   typed refusal or remaining-order keys; `deleteBranch` must be `false`.
 * - `work-entries:delete`: archive a no-repository task as locked
 *   (`lockAfterArchive: true`); the unlocked Delete path is refused.
 *
 * Each is a reviewed exemption from `/archive/` or `/delete/` in
 * {@link HOSTED_FORBIDDEN_PATTERN_EXEMPTIONS}.
 *
 * CAN-7604: `app-advisor:slack-turn-status` reads where one Slack message's
 * Orchestrator turn stands. Only a Slack session may use it; the computer
 * serves it itself, never through the bridge.
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
  ...Object.values(HOSTED_TASK_CHANNELS),
  ...Object.values(HOSTED_ARCHIVE_CHANNELS),
  HOSTED_SLACK_TURN_STATUS_CHANNEL,
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
 * carry. Anything else (approval mode, seeded tabs, attachments, plan review
 * approval, agent-send provenance, close, discard, reset, dismissals) is
 * refused by the host. `chat.answer_question` answers an ordinary agent
 * question only: tool approvals, permissions and plan review are other
 * commands and channels, and the host also refuses an answer to a
 * secret-input question.
 *
 * CAN-7445 adds plugin selections on a new chat, `chat.set_model`,
 * `chat.patch_tab_settings` limited to {@link HOSTED_TAB_PATCH_FIELDS}
 * (auto model selection, thinking level, speed, plan mode and plugin
 * selections) and `chat.steer_queued_message`. A hosted patch carries no
 * `expectedPluginSelections`, so it has no compare-and-set and overwrites a
 * concurrent edit by the person.
 *
 * CAN-7446 adds `chat.archive_tab` naming only the tab: no `keepSession` or
 * `unread`. The computer refuses it for a busy chat and for any chat in a
 * Work Entry project, whose main chat closes only with its task.
 */
export const HOSTED_CHAT_COMMAND_FIELDS: ReadonlyMap<
  string,
  ReadonlySet<string>
> = new Map([
  [
    'chat.create_tab',
    new Set(['type', 'tabId', 'model', 'planMode', 'pluginSelections']),
  ],
  [
    'chat.send_message',
    new Set(['type', 'chatId', 'userMessageId', 'text', 'model', 'planMode']),
  ],
  [
    'chat.answer_question',
    new Set(['type', 'chatId', 'questionId', 'answers']),
  ],
  [
    'chat.set_model',
    new Set(['type', 'tabId', 'model', 'providerType', 'executionHarness']),
  ],
  ['chat.patch_tab_settings', new Set(['type', 'tabId', 'patch'])],
  [
    'chat.steer_queued_message',
    new Set(['type', 'chatId', 'queuedMessageId', 'queuedMessageRevision']),
  ],
  ['chat.archive_tab', new Set(['type', 'tabId'])],
]);

/** `chat.patch_tab_settings` patch keys a hosted controller may set. */
export const HOSTED_TAB_PATCH_FIELDS: ReadonlySet<string> = new Set([
  'modelSelectionMode',
  'modelConfig',
  'planMode',
  'pluginSelections',
]);

/** `modelConfig` keys a hosted patch may set. */
const HOSTED_MODEL_CONFIG_FIELDS: ReadonlySet<string> = new Set([
  'thinkingLevel',
  'fastMode',
]);

/** Keys of a hosted chat's plugin selections. */
const HOSTED_PLUGIN_SELECTION_FIELDS: ReadonlySet<string> = new Set([
  'collectionIds',
  'skillRefs',
  'pluginRefs',
  'mcpServerRefs',
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
const MAX_SELECTION_ENTRIES = 100;
/** Worktree labels, work entry titles and group names. */
const MAX_NAME_LENGTH = 512;
const MAX_BRANCH_LENGTH = 256;
/** A worktree's `createdAt` as the computer reports it (an ISO timestamp). */
const MAX_TIMESTAMP_LENGTH = 64;
// eslint-disable-next-line no-control-regex -- matching control characters is the point.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

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
  switch (command.type) {
    case 'chat.create_tab':
      return (
        isId(command.tabId) &&
        optionalId(command.model) &&
        optionalBoolean(command.planMode) &&
        (command.pluginSelections === undefined ||
          hostedPluginSelectionsAllowed(command.pluginSelections))
      );
    case 'chat.send_message':
      return (
        isId(command.chatId) &&
        isId(command.userMessageId) &&
        isBoundedText(command.text, 1) &&
        optionalId(command.model) &&
        optionalBoolean(command.planMode)
      );
    case 'chat.answer_question':
      return (
        isId(command.chatId) &&
        isId(command.questionId) &&
        hostedAnswersAllowed(command.answers)
      );
    // These cases check shape only. The values of `providerType`,
    // `executionHarness` and `thinkingLevel` are enforced by the desktop's
    // chat command validation, which the hosted dispatcher runs before
    // dispatch (`createHostedChatDispatcher` calls `validate` first).
    case 'chat.set_model':
      return (
        isId(command.tabId) &&
        isId(command.model) &&
        isId(command.providerType) &&
        optionalId(command.executionHarness)
      );
    case 'chat.patch_tab_settings':
      return isId(command.tabId) && hostedTabPatchAllowed(command.patch);
    case 'chat.steer_queued_message':
      return (
        isId(command.chatId) &&
        isId(command.queuedMessageId) &&
        (command.queuedMessageRevision === undefined ||
          isNonNegativeInteger(command.queuedMessageRevision))
      );
    case 'chat.archive_tab':
      return isId(command.tabId);
    default:
      return false;
  }
}

function optionalId(value: unknown): boolean {
  return value === undefined || isId(value);
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** A non-empty string of at most `maxLength` with no control characters. */
function isBoundedName(value: unknown, maxLength: number): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    !CONTROL_CHARACTERS.test(value)
  );
}

/**
 * A label, title or group name the hosted task channels accept. The web
 * checks `task_update` input with it before the first write.
 */
export function isHostedName(value: unknown): boolean {
  return isBoundedName(value, MAX_NAME_LENGTH);
}

/**
 * An ID the hosted task channels accept, such as a hook key. The web checks
 * a listed ID with it before the first write, since a computer may list IDs
 * longer than a hosted call may carry.
 */
export function isHostedId(value: unknown): boolean {
  return isId(value);
}

/**
 * A plain object with every required key present (not `undefined`) and no
 * key outside `required` and `optional`.
 */
function hasShape(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  return (
    isPlainRecord(value) &&
    onlyFields(value, new Set([...required, ...optional])) &&
    required.every((key) => value[key] !== undefined)
  );
}

function isIdList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= MAX_SELECTION_ENTRIES &&
    value.every((entry) => isId(entry))
  );
}

function isRefList(value: unknown, first: string, second: string): boolean {
  return (
    Array.isArray(value) &&
    value.length <= MAX_SELECTION_ENTRIES &&
    value.every(
      (entry) =>
        hasShape(entry, [first, second]) &&
        isId(entry[first]) &&
        isId(entry[second]),
    )
  );
}

/**
 * A chat's plugin selections: collection IDs plus skill, plugin and MCP
 * server references, at most 100 of each, with no other key. Never looser
 * than the desktop's own `isChatTabPluginSelections`.
 */
function hostedPluginSelectionsAllowed(value: unknown): boolean {
  return (
    hasShape(
      value,
      ['collectionIds', 'skillRefs', 'pluginRefs'],
      ['mcpServerRefs'],
    ) &&
    onlyFields(value, HOSTED_PLUGIN_SELECTION_FIELDS) &&
    isIdList(value.collectionIds) &&
    isRefList(value.skillRefs, 'sourceId', 'skillName') &&
    isRefList(value.pluginRefs, 'marketplaceId', 'pluginName') &&
    (value.mcpServerRefs === undefined ||
      isRefList(value.mcpServerRefs, 'serverId', 'configId'))
  );
}

/**
 * Whether the hosted policy admits these plugin selections. The web checks
 * resolved selections with it before the first write, since the computer's
 * catalog allows longer IDs than a hosted command may carry.
 */
export function isHostedPluginSelections(value: unknown): boolean {
  return hostedPluginSelectionsAllowed(value);
}

/**
 * A hosted settings patch: at least one key, every key in
 * {@link HOSTED_TAB_PATCH_FIELDS}. One other key refuses the whole patch, so
 * plan review, pending plan exits, titles, proposal mode, auto archive and
 * deferred tools stay out of reach.
 */
function hostedTabPatchAllowed(patch: unknown): boolean {
  if (
    !isPlainRecord(patch) ||
    Object.keys(patch).length === 0 ||
    !onlyFields(patch, HOSTED_TAB_PATCH_FIELDS)
  )
    return false;
  if (
    patch.modelSelectionMode !== undefined &&
    patch.modelSelectionMode !== 'auto'
  )
    return false;
  if (patch.modelConfig !== undefined) {
    const config = patch.modelConfig;
    if (
      !isPlainRecord(config) ||
      Object.keys(config).length === 0 ||
      !onlyFields(config, HOSTED_MODEL_CONFIG_FIELDS) ||
      !optionalId(config.thinkingLevel) ||
      !optionalBoolean(config.fastMode)
    )
      return false;
  }
  return (
    optionalBoolean(patch.planMode) &&
    (patch.pluginSelections === undefined ||
      hostedPluginSelectionsAllowed(patch.pluginSelections))
  );
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
 * The one-worktree file read every restricted controller is held to. Browser
 * and mobile reads use it directly; they are not held to the hosted Bot
 * project refusal, since the browser's Orchestrator panel reads its own files.
 */
export function scopedFileReadAllowed(args: readonly unknown[]): boolean {
  return args.length === 1 && hostedFileReadAllowed(args[0]);
}

/** `{projectId, worktreeId, chatId, entryId}`: one queued message. */
function hostedQueueEntryAllowed(
  value: unknown,
  extra: readonly string[] = [],
): boolean {
  return (
    hasShape(value, [
      'projectId',
      'worktreeId',
      'chatId',
      'entryId',
      ...extra,
    ]) &&
    isId(value.projectId) &&
    isId(value.worktreeId) &&
    isId(value.chatId) &&
    isId(value.entryId)
  );
}

/**
 * Pause or resume exactly one named hook, or all of a worktree's hooks.
 * `all: false` is refused rather than read as "no target".
 */
function hostedHookPauseAllowed(value: unknown): boolean {
  if (
    !hasShape(value, ['projectId', 'worktreeId', 'kind'], ['hookKey', 'all']) ||
    !isId(value.projectId) ||
    !isId(value.worktreeId) ||
    (value.kind !== 'pause' && value.kind !== 'resume')
  )
    return false;
  if (value.hookKey !== undefined)
    return value.all === undefined && isId(value.hookKey);
  return value.all === true;
}

/**
 * A branch name Git accepts as a ref (`git check-ref-format --branch`), with
 * no option-like `-` prefix. The desktop stores `baseBranch` as metadata
 * without checking it as a ref, and later Git reads use it, so the hosted
 * policy holds it to the ref rules: no whitespace or control characters, no
 * `~ ^ : ? * [ \\`, no `..`, `@{` or `//`, no component starting with `.` or
 * ending with `.lock`, no trailing `/` or `.`, and not `@` or `HEAD`. The web
 * checks `task_update` input with it before the first write.
 */
export function isHostedBranchName(value: unknown): boolean {
  if (!isBoundedName(value, MAX_BRANCH_LENGTH) || typeof value !== 'string')
    return false;
  return (
    !value.startsWith('-') &&
    value !== '@' &&
    value !== 'HEAD' &&
    !/[\s~^:?*[\\]/.test(value) &&
    !value.includes('..') &&
    !value.includes('@{') &&
    !value.includes('//') &&
    !value.startsWith('/') &&
    !value.endsWith('/') &&
    !value.endsWith('.') &&
    value
      .split('/')
      .every((part) => !part.startsWith('.') && !part.endsWith('.lock'))
  );
}

/** A sidebar scope addressing one workspace, never App Advisor. */
function isWorkspaceScope(value: unknown): boolean {
  return hasShape(value, ['workspaceLocalId']) && isId(value.workspaceLocalId);
}

function isGroupColor(value: unknown): boolean {
  return SIDEBAR_ITEM_GROUP_COLORS.some((color) => color === value);
}

const HOSTED_TASK_CHANNEL_NAMES: ReadonlySet<string> = new Set([
  ...Object.values(HOSTED_TASK_CHANNELS),
  ...Object.values(HOSTED_ARCHIVE_CHANNELS),
]);

/**
 * The computer's own `createdAt` string for a worktree, as the web passes it
 * through unchanged: a bounded string with no control characters, so an ISO
 * timestamp's `:`, `.` and `+` are accepted.
 */
function isHostedTimestamp(value: unknown): boolean {
  return isBoundedName(value, MAX_TIMESTAMP_LENGTH);
}

/**
 * Whether the hosted policy admits this `expectedCreatedAt`. The web omits a
 * snapshot value it refuses rather than fail the archive locally.
 */
export function isHostedExpectedCreatedAt(value: unknown): boolean {
  return isHostedTimestamp(value);
}

/**
 * A locked worktree archive that keeps the branch: `projectId` or
 * `workspaceId` (by channel) and `worktreeId`, `lockAfterArchive: true`,
 * `deleteBranch: false` and an optional `expectedCreatedAt`. Both flags are
 * compared strictly. No `repoPath`, typed refusal, remaining-order or other
 * key.
 */
function hostedWorktreeArchiveAllowed(
  value: unknown,
  scopeKey: 'projectId' | 'workspaceId',
): boolean {
  return (
    hasShape(
      value,
      [scopeKey, 'worktreeId', 'lockAfterArchive', 'deleteBranch'],
      ['expectedCreatedAt'],
    ) &&
    isId(value[scopeKey]) &&
    isId(value.worktreeId) &&
    value.lockAfterArchive === true &&
    value.deleteBranch === false &&
    (value.expectedCreatedAt === undefined ||
      isHostedTimestamp(value.expectedCreatedAt))
  );
}

/**
 * Undefined for a channel that isn't a task channel. A task channel is
 * refused unless it has a case below, so one added without its policy fails
 * closed.
 */
function hostedTaskChannelAllowed(
  channel: string,
  args: readonly unknown[],
): boolean | undefined {
  const isTaskChannel = HOSTED_TASK_CHANNEL_NAMES.has(channel);
  if (args.length !== 1) return isTaskChannel ? false : undefined;
  const value = args[0];
  switch (channel) {
    case HOSTED_TASK_CHANNELS.pluginCatalogList:
      return hasShape(value, ['projectId']) && isId(value.projectId);
    case HOSTED_TASK_CHANNELS.homeListBranchTargets:
      return hasShape(value, ['workspaceId']) && isId(value.workspaceId);
    case HOSTED_TASK_CHANNELS.worktreeActivityEntities:
      return (
        hasShape(value, ['projectId', 'worktreeId']) &&
        isId(value.projectId) &&
        isId(value.worktreeId)
      );
    case HOSTED_TASK_CHANNELS.hookChangePause:
      return hostedHookPauseAllowed(value);
    case HOSTED_TASK_CHANNELS.chatQueueCancel:
    case HOSTED_TASK_CHANNELS.chatQueueForce:
      return hostedQueueEntryAllowed(value);
    case HOSTED_TASK_CHANNELS.chatQueueEdit:
      return (
        hostedQueueEntryAllowed(value, ['text']) &&
        isPlainRecord(value) &&
        isBoundedText(value.text, 1)
      );
    case HOSTED_TASK_CHANNELS.worktreeSetLabel:
      return (
        hasShape(value, ['projectId', 'worktreeId'], ['label']) &&
        isId(value.projectId) &&
        isId(value.worktreeId) &&
        (value.label === undefined ||
          isBoundedName(value.label, MAX_NAME_LENGTH))
      );
    case HOSTED_TASK_CHANNELS.worktreeSetHidden:
      return (
        hasShape(value, ['projectId', 'worktreeId', 'hidden']) &&
        isId(value.projectId) &&
        isId(value.worktreeId) &&
        typeof value.hidden === 'boolean'
      );
    case HOSTED_TASK_CHANNELS.worktreeSetTrackedBaseBranch:
      return (
        hasShape(value, ['workspaceId', 'worktreeId', 'baseBranch']) &&
        isId(value.workspaceId) &&
        isId(value.worktreeId) &&
        isHostedBranchName(value.baseBranch)
      );
    case HOSTED_TASK_CHANNELS.workEntriesUpdate:
      return (
        isPlainRecord(value) &&
        onlyFields(value, new Set(['projectId', 'entryId', 'title'])) &&
        'title' in value &&
        isId(value.projectId) &&
        isId(value.entryId) &&
        (value.title === null || isBoundedName(value.title, MAX_NAME_LENGTH))
      );
    case HOSTED_TASK_CHANNELS.sidebarItemGroupsCreate:
      return (
        hasShape(value, ['scope', 'itemId', 'name'], ['color']) &&
        isWorkspaceScope(value.scope) &&
        isId(value.itemId) &&
        isBoundedName(value.name, MAX_NAME_LENGTH) &&
        typeof value.name === 'string' &&
        value.name.trim().length > 0 &&
        (value.color === undefined || isGroupColor(value.color))
      );
    case HOSTED_TASK_CHANNELS.sidebarItemGroupsMoveItem:
      return (
        isPlainRecord(value) &&
        onlyFields(value, new Set(['scope', 'itemId', 'groupId'])) &&
        'groupId' in value &&
        isWorkspaceScope(value.scope) &&
        isId(value.itemId) &&
        (value.groupId === null ||
          (isId(value.groupId) &&
            typeof value.groupId === 'string' &&
            value.groupId.startsWith('grp-')))
      );
    case HOSTED_ARCHIVE_CHANNELS.worktreeArchive:
      return hostedWorktreeArchiveAllowed(value, 'projectId');
    case HOSTED_ARCHIVE_CHANNELS.workspaceArchiveWorktree:
      return hostedWorktreeArchiveAllowed(value, 'workspaceId');
    case HOSTED_ARCHIVE_CHANNELS.workEntriesDelete:
      return (
        hasShape(value, ['projectId', 'entryId', 'lockAfterArchive']) &&
        isId(value.projectId) &&
        isId(value.entryId) &&
        value.lockAfterArchive === true
      );
    default:
      return isTaskChannel ? false : undefined;
  }
}

/** Argument keys a hosted call names a project or workspace with. */
const PROJECT_ARGUMENT_KEYS: ReadonlySet<string> = new Set([
  'projectId',
  'workspaceId',
  'workspaceLocalId',
]);

/**
 * Deeper than any reviewed hosted argument (a plugin reference on a new chat
 * sits at depth 5). Anything nested further counts as naming a Bot project.
 */
const MAX_PROJECT_SCAN_DEPTH = 8;

/**
 * Whether a hosted call names a Bot project (the Orchestrator or another Bot)
 * anywhere in its arguments, at the top level or in a nested scope such as a
 * file read's `workspaceTarget` or a group's `scope` (CAN-7604). Fails
 * closed: a value too deep to scan counts as naming one.
 *
 * It reads only the `PROJECT_ARGUMENT_KEYS` names. Every reviewed hosted channel names
 * its project under one of them; a channel that takes a project under
 * another key or as a bare positional argument must add that key here, or
 * its Bot refusal is lost.
 */
function namesBotProject(value: unknown, depth: number): boolean {
  if (typeof value !== 'object' || value === null) return false;
  if (depth > MAX_PROJECT_SCAN_DEPTH) return true;
  const entries = Array.isArray(value)
    ? value.map((item): [string, unknown] => ['', item])
    : Object.entries(value);
  return entries.some(
    ([key, item]) =>
      (PROJECT_ARGUMENT_KEYS.has(key) &&
        typeof item === 'string' &&
        isBotProjectId(item)) ||
      namesBotProject(item, depth + 1),
  );
}

/** The transcript read a hosted session's `chat.history` sends. */
export const HOSTED_TRANSCRIPT_PAGE_CHANNEL = 'chat:get-transcript-page';

/**
 * The reserved `worktreeId` a Slack session's Orchestrator send names
 * (CAN-7604). It is not a Work Entry ID: the computer resolves it to its own
 * Slack conversations entry, creating or recreating that entry as needed, so
 * the caller never names one.
 */
export const HOSTED_SLACK_CONVERSATIONS_TARGET = 'slack-conversations';

/** Where the turn a Slack message started stands. */
export const HOSTED_SLACK_TURN_STATES = [
  'not_found',
  'queued',
  'running',
  'waiting_on_user',
  'completed',
  'failed',
  'cancelled',
] as const;
export type HostedSlackTurnState = (typeof HOSTED_SLACK_TURN_STATES)[number];

export interface HostedSlackTurnStatus {
  readonly state: HostedSlackTurnState;
  /** The Work Entry holding the message's tab, when there is one. */
  readonly worktreeId?: string;
  /** The tab has closed; its transcript stays readable. */
  readonly closed?: true;
}

/** Parses the computer's turn status reply, or null when unreadable. */
export function parseHostedSlackTurnStatus(
  value: unknown,
): HostedSlackTurnStatus | null {
  if (!isPlainRecord(value)) return null;
  const state = HOSTED_SLACK_TURN_STATES.find(
    (candidate) => candidate === value.state,
  );
  if (state === undefined) return null;
  if (value.worktreeId !== undefined && !isId(value.worktreeId)) return null;
  if (value.closed !== undefined && value.closed !== true) return null;
  return {
    state,
    ...(typeof value.worktreeId === 'string'
      ? { worktreeId: value.worktreeId }
      : {}),
    ...(value.closed === true ? { closed: true } : {}),
  };
}

/**
 * What the session is, beyond its hosted kind. Only a session whose verified
 * delegation names a first-party client carries one; the hosted MCP tools
 * never do.
 */
export interface HostedInvocationProfile {
  readonly firstPartyClient?: HostedFirstPartyClient;
}

/**
 * Everything a Slack session may do (CAN-7604): a plain message to the
 * Orchestrator through the reserved Slack conversations target (no model,
 * plan mode, approval mode or attachment, so the computer's own Orchestrator
 * settings apply), a transcript read in the Orchestrator project, and one
 * message's turn status. The computer also holds those reads to its Slack
 * conversations entries and refuses the send while its Slack gate is off.
 */
function slackOrchestratorCallAllowed(
  channel: string,
  args: readonly unknown[],
): boolean {
  if (args.length !== 1) return false;
  const value = args[0];
  switch (channel) {
    case HOSTED_CHAT_COMMAND_CHANNEL: {
      if (
        !hasShape(value, [
          'schemaVersion',
          'commandId',
          'projectId',
          'worktreeId',
          'command',
        ]) ||
        value.schemaVersion !== 1 ||
        !isId(value.commandId) ||
        value.projectId !== APP_ADVISOR_PROJECT_ID ||
        value.worktreeId !== HOSTED_SLACK_CONVERSATIONS_TARGET
      )
        return false;
      const command = value.command;
      return (
        hasShape(command, ['type', 'chatId', 'userMessageId', 'text']) &&
        command.type === 'chat.send_message' &&
        isId(command.chatId) &&
        isId(command.userMessageId) &&
        isBoundedText(command.text, 1)
      );
    }
    case HOSTED_TRANSCRIPT_PAGE_CHANNEL:
      return (
        hasShape(
          value,
          ['projectId', 'worktreeId', 'chatId'],
          ['before', 'transcriptRevision'],
        ) &&
        value.projectId === APP_ADVISOR_PROJECT_ID &&
        value.worktreeId !== HOSTED_SLACK_CONVERSATIONS_TARGET &&
        isId(value.worktreeId) &&
        isId(value.chatId) &&
        (value.before === undefined || isNonNegativeInteger(value.before)) &&
        (value.transcriptRevision === undefined ||
          isNonNegativeInteger(value.transcriptRevision))
      );
    case HOSTED_SLACK_TURN_STATUS_CHANNEL:
      return (
        hasShape(value, ['chatId', 'userMessageId']) &&
        isId(value.chatId) &&
        isId(value.userMessageId)
      );
    default:
      return false;
  }
}

/** The calls one first-party client's session may make. */
function firstPartyCallAllowed(
  client: HostedFirstPartyClient,
  channel: string,
  args: readonly unknown[],
): boolean {
  switch (client) {
    case 'slack':
      return slackOrchestratorCallAllowed(channel, args);
    default: {
      // A new client fails to compile here until it has a reviewed profile,
      // and makes no calls if one ever arrives unchecked.
      const unreviewed: never = client;
      void unreviewed;
      return false;
    }
  }
}

/**
 * Argument-level policy for a hosted controller's invoke or send on a channel
 * its allowlist already admits. No hosted call may name a Bot project: the
 * Orchestrator and other Bots are never an ordinary hosted target (CAN-7604).
 * A first-party session is held to its client's reviewed calls alone
 * ({@link slackOrchestratorCallAllowed} for Slack); any other client gets none.
 * Generic or argument-sensitive channels have
 * one: `chat:command` (new chats, messages, ordinary answers, a chat's model,
 * the reviewed settings patch keys, steering a queued message and archiving
 * one chat), `chat:cancel` (one exact turn), `work-entries:create` (its
 * project only), `file:read-content` (one worktree's roots only) and each
 * channel in {@link HOSTED_TASK_CHANNELS} and {@link HOSTED_ARCHIVE_CHANNELS}
 * (exactly its reviewed argument). Every other hosted channel has a single
 * effect.
 */
export function hostedInvocationAllowed(
  channel: string,
  args: readonly unknown[],
  profile: HostedInvocationProfile = {},
): boolean {
  // A first-party session makes only its own reviewed calls, nothing else; a
  // client without a reviewed profile makes none.
  if (profile.firstPartyClient !== undefined)
    return firstPartyCallAllowed(profile.firstPartyClient, channel, args);
  if (namesBotProject(args, 0)) return false;
  switch (channel) {
    case HOSTED_SLACK_TURN_STATUS_CHANNEL:
      return false;
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
      return hostedTaskChannelAllowed(channel, args) ?? true;
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

/**
 * Hosted channels that match a {@link HOSTED_FORBIDDEN_CHANNEL_PATTERNS} entry
 * after an explicit effect review, with the reason. The patterns themselves
 * are never loosened; the wire golden holds the matches equal to this map.
 */
export const HOSTED_FORBIDDEN_PATTERN_EXEMPTIONS: ReadonlyMap<string, string> =
  new Map([
    [
      HOSTED_TASK_CHANNELS.chatQueueForce,
      'Sends one named queued message now, interrupting whichever turn is running: unlike hosted chat:cancel it names no turn, and the entry may be one the person queued. It deletes and force-pushes nothing, and the sign-off on task_chat_queue_update accepts the interrupt (CAN-7445).',
    ],
    [
      HOSTED_ARCHIVE_CHANNELS.workEntriesDelete,
      'Archives one no-repository task as locked and restorable: the argument policy requires lockAfterArchive: true, so the unlocked Delete path is refused, and the task_delete sign-off confirms the archive (CAN-7446).',
    ],
    [
      HOSTED_ARCHIVE_CHANNELS.workspaceArchiveWorktree,
      "Archives one multi-repo task's worktree as locked and restorable: lockAfterArchive must be true and deleteBranch false, so no branch is deleted and the Delete path is refused; no host path or remaining-order key is accepted (CAN-7446).",
    ],
    [
      HOSTED_ARCHIVE_CHANNELS.worktreeArchive,
      "Archives one single-repo task's worktree as locked and restorable: lockAfterArchive must be true and deleteBranch false, so no branch is deleted and the Delete path is refused; no repoPath, typed refusal or remaining-order key is accepted (CAN-7446).",
    ],
  ]);

/*
 * Refusal reasons a paired computer returns for a Slack send (CAN-7604). The
 * web's Slack dispatch worker (CAN-7607) compares a `rejected` send's reason
 * with these values to pick what it tells the sender, so the text is a
 * contract between desktop and web: never edit a string, only add new ones.
 * An older computer keeps sending the text it shipped with.
 */

/** The computer's Slack gate is off. */
export const HOSTED_SLACK_REQUESTS_OFF_REFUSAL =
  "This computer isn't listening for Slack mentions. Turn it on in Settings → Integrations on this computer.";

/** The gate is unavailable. No setting to point at: the flag hides it there. */
export const HOSTED_SLACK_REQUESTS_UNAVAILABLE_REFUSAL =
  "This computer isn't listening for Slack mentions yet.";

/** The Slack thread's chat is gone from the computer. */
export const SLACK_THREAD_REMOVED_REFUSAL =
  "This Slack thread's chat was removed from this computer.";

/** The Slack thread's chat closed while the send was checked; retry. */
export const SLACK_THREAD_JUST_CLOSED_REFUSAL =
  "This Slack thread's chat just closed. Send the message again.";

/** The Slack thread's chat is too long to check for a repeated message. */
export const SLACK_THREAD_TOO_LONG_REFUSAL =
  "This Slack thread's chat is too long to check for a repeated message.";

/*
 * The whole final answer an Orchestrator gives to a Slack thread follow-up
 * that isn't meant for it (CAN-7832). The web's reply worker posts nothing
 * when a follow-up's answer is exactly this marker; desktop guidance names it
 * in the Slack turn prompt. A contract between desktop and web: never edit it.
 */
export const SLACK_NO_REPLY_MARKER = '[[no-reply-needed]]';
