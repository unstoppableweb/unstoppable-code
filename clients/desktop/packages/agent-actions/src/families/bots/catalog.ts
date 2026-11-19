import { ORCHESTRATOR_AGENT_NAME } from '@canopy/protocol/ui-labels';
import type {
  AgentActionCatalogEntry,
  AgentActionField,
} from '../../catalog/types';
import { field } from '../projects/catalog';
import {
  botsGetLastAgentResponseActionSchema,
  botsGetLastUserMessageActionSchema,
  botsListActionSchema,
  botsListTaskChatsActionSchema,
  botsListTasksActionSchema,
  botsReadHistoryActionSchema,
  botWriteActionSchema,
  type BotAction,
  type BotActionType,
} from './actions';

const BOT_ID_FIELD = field(
  'botId',
  'string',
  true,
  'Canonical bot ID returned by bots.list.',
);
const BOT_LIST_PAGE_FIELDS: readonly AgentActionField[] = [
  field(
    'query',
    'string',
    false,
    'Metadata substring search, up to 500 characters.',
  ),
  field(
    'name',
    'string',
    false,
    'Exact case-insensitive name/title match, up to 500 characters; combined with query.',
  ),
  field('pageSize', 'integer', false, 'Page size 1–200; defaults to 50.'),
  field(
    'cursor',
    'string',
    false,
    'Opaque continuation cursor; retain the same filters and sort.',
  ),
  field('sort', 'string', false, 'name; defaults to name.'),
  field(
    'order',
    'asc | desc',
    false,
    'Defaults to asc. Canonical bot IDs break ties.',
  ),
];
const BOT_DISCOVERY_PAGE_FIELDS: readonly AgentActionField[] = [
  ...BOT_LIST_PAGE_FIELDS.slice(0, 4),
  field(
    'sort',
    'string',
    false,
    'title, created_at, or last_activity; defaults to last_activity.',
  ),
  field(
    'order',
    'asc | desc',
    false,
    'Defaults to desc. Canonical task/chat IDs break ties.',
  ),
];
const BOT_READ_ADDRESS_FIELDS: readonly AgentActionField[] = [
  BOT_ID_FIELD,
  field(
    'taskId',
    'string',
    true,
    'Canonical retained task ID returned by bots.list_tasks.',
  ),
  field(
    'chatId',
    'string',
    true,
    'Canonical retained chat ID returned by bots.list_task_chats for that task.',
  ),
];
const BOT_DISCOVERY_NOTES: readonly string[] = [
  'Read-only bot task and chat discovery. Use the canonical botId returned by bots.list; only Orchestrator is implemented on this surface today.',
  'Archived retention filters are unsupported and return unsupported_filter. Discovery lists retained active and done tasks and retained chats only.',
  'cursor_expired and cursor_context_changed require restarting from the first page without a cursor. Keep the bot, target, filters, sort, and order unchanged during continuation.',
];
const BOT_LIST_NOTES: readonly string[] = [
  `Read-only bot catalog. Only ${ORCHESTRATOR_AGENT_NAME} is implemented on this surface today; use its canonical botId for task and chat discovery.`,
  'cursor_expired and cursor_context_changed require restarting from the first page without a cursor. Keep filters, sort, and order unchanged during continuation.',
];
const BOT_REGISTRY_LIST_FIELDS: readonly AgentActionField[] = [
  field(
    'pinnedToProjectId',
    'string',
    false,
    'Filter to bots pinned to this canonical project ID.',
  ),
];
const BOT_REGISTRY_LIST_NOTES: readonly string[] = [
  "With the registry capability enabled, every row includes kind ('default' for the Orchestrator or 'custom' for a user-created Bot), description (a string or null), scope ('default' for the default Bot, 'global' for a custom Bot with no caller-visible pins, otherwise 'pinned'), ordered pins ({ projectId, name } for only projects this caller may discover), and the raw showInSidebar preference.",
  'The list labels the default Bot Default, a custom Bot with no caller-visible pins Global, and a custom Bot with visible pins Pinned to projects. Pinning is placement, not authority: it may add project context but never grants access.',
  'The `capabilities` object reports `listTasks`, `readChats`, `sendMessages`, `createTasks`, `createChats`, and `watchChats`. Custom Bots currently report only `listTasks` and `readChats` as available; `sendMessages`, `createTasks`, `createChats`, and `watchChats` remain unavailable until custom workspace execution is available. `taskCount` is a count when available and `null` when it cannot be provided; `null` is not zero.',
  'cursor_expired and cursor_context_changed require restarting from the first page without a cursor. Keep filters, sort, and order unchanged during continuation.',
];
const BOT_READ_NOTES: readonly string[] = [
  'Read-only explicit address from bots.list, bots.list_tasks, and bots.list_task_chats. No UI fields or expectedUiRevision; archived or unknown task/chat targets return not_found.',
  'Visible user/assistant text and basename-only file references only; no tool calls, tool results, thinking, hidden context, system/hook/info blocks, or child agents. Empty visible projections are excluded. Each message is capped at 8,000 characters with truncation marked.',
];

/** The bot actions' catalog rows: discovery, reads and writes. */
export const BOT_ACTION_CATALOG: readonly AgentActionCatalogEntry<
  BotActionType,
  BotAction
>[] = [
  {
    type: 'bots.list',
    category: 'bots',
    summary: 'List available bots for read-only task and chat discovery.',
    fields: [
      ...BOT_LIST_PAGE_FIELDS,
      field(
        'botIds',
        'string[]',
        false,
        'Non-empty unique canonical bot ID filter.',
      ),
      field(
        'availability',
        'Array<available | unavailable>',
        false,
        'Non-empty unique bot availability filter.',
      ),
    ],
    example: botsListActionSchema.parse({ type: 'bots.list' }),
    keywords: ['bots', 'catalog', 'available', 'advisor', 'read-only'],
    notes: BOT_LIST_NOTES,
  },
  {
    type: 'bots.list_tasks',
    category: 'bots',
    summary:
      'List retained active or done tasks for an explicit bot, with compact chat counts.',
    fields: [
      BOT_ID_FIELD,
      ...BOT_DISCOVERY_PAGE_FIELDS,
      field(
        'statuses',
        'Array<active | done>',
        false,
        'Non-empty unique task status filter.',
      ),
      field(
        'retentionStates',
        'Array<retained | archived>',
        false,
        'Defaults to retained; archived is unsupported and returns unsupported_filter.',
      ),
      field(
        'hasRunningChats',
        'boolean',
        false,
        'Filter observed running chats, not queued-only tasks.',
      ),
      field(
        'pinned',
        'boolean',
        false,
        'Filter pinned Orchestrator Work Entries.',
      ),
    ],
    example: botsListTasksActionSchema.parse({
      type: 'bots.list_tasks',
      botId: 'app_advisor',
    }),
    keywords: ['bots', 'tasks', 'work entries', 'active', 'done', 'advisor'],
    notes: BOT_DISCOVERY_NOTES,
  },
  {
    type: 'bots.list_task_chats',
    category: 'bots',
    summary:
      'List retained chat metadata for an explicit bot, optionally narrowed to one task.',
    fields: [
      BOT_ID_FIELD,
      field(
        'taskId',
        'string',
        false,
        'Canonical task ID returned by bots.list_tasks; omit to list chats across the bot.',
      ),
      ...BOT_DISCOVERY_PAGE_FIELDS,
      field(
        'runtimeStates',
        'Array<idle | running | queued | interrupted | error | unknown>',
        false,
        'Non-empty unique observed runtime state filter.',
      ),
      field(
        'retentionStates',
        'Array<retained | archived>',
        false,
        'Defaults to retained; archived is unsupported and returns unsupported_filter.',
      ),
      field(
        'providerTypes',
        'AgentProviderType[]',
        false,
        'Non-empty unique canonical provider type filter.',
      ),
      field(
        'executionHarnesses',
        'ModelHarness[]',
        false,
        'Non-empty unique registered execution harness filter; independent of provider type.',
      ),
      field(
        'hasQueuedMessages',
        'boolean',
        false,
        'Filter by observed queued-message presence.',
      ),
      field(
        'includeLastUserMessage',
        'boolean',
        false,
        'Opt in to an indexed last-user preview. Unavailable previews are omitted; defaults to false.',
      ),
    ],
    example: botsListTaskChatsActionSchema.parse({
      type: 'bots.list_task_chats',
      botId: 'app_advisor',
      taskId: 'advisor-task',
    }),
    keywords: ['bots', 'tasks', 'chats', 'runtime', 'queue', 'metadata'],
    notes: [
      ...BOT_DISCOVERY_NOTES,
      'List previews are omitted in this slice, including when includeLastUserMessage is true. Use bots.get_last_user_message for the canonical visible message.',
    ],
  },
  {
    type: 'bots.get_last_user_message',
    category: 'bots',
    summary:
      'Read the latest visible user message in an explicitly addressed bot chat.',
    fields: BOT_READ_ADDRESS_FIELDS,
    example: botsGetLastUserMessageActionSchema.parse({
      type: 'bots.get_last_user_message',
      botId: 'app_advisor',
      taskId: 'advisor-task',
      chatId: 'advisor-chat',
    }),
    keywords: ['bots', 'tasks', 'chats', 'last', 'user', 'message', 'read'],
    notes: [
      ...BOT_READ_NOTES,
      'Returns message:null when no visible user message exists, distinct from execution_failed on a read failure.',
    ],
  },
  {
    type: 'bots.get_last_agent_response',
    category: 'bots',
    summary:
      'Read the latest completed top-level assistant response in an explicitly addressed bot chat.',
    fields: BOT_READ_ADDRESS_FIELDS,
    example: botsGetLastAgentResponseActionSchema.parse({
      type: 'bots.get_last_agent_response',
      botId: 'app_advisor',
      taskId: 'advisor-task',
      chatId: 'advisor-chat',
    }),
    keywords: [
      'bots',
      'tasks',
      'chats',
      'last',
      'agent',
      'assistant',
      'response',
      'read',
    ],
    notes: [
      ...BOT_READ_NOTES,
      'Selects the newest completed turn with a nonempty visible final assistant message. A newer streaming, paused, or failed turn does not hide an older completed response. Returns message:null when none exists, not on read failure.',
    ],
  },
  {
    type: 'bots.read_history',
    category: 'bots',
    summary:
      'Page visible messages in an explicitly addressed bot chat, with optional role and text filters.',
    fields: [
      ...BOT_READ_ADDRESS_FIELDS,
      field(
        'query',
        'string',
        false,
        'Trimmed literal case-insensitive substring of visible text before truncation; 1–500 characters.',
      ),
      field(
        'roles',
        'Array<user | assistant>',
        false,
        'Optional nonempty unique role filter.',
      ),
      field('pageSize', 'integer', false, 'Page size 1–100; defaults to 20.'),
      field(
        'cursor',
        'string',
        false,
        'Opaque continuation cursor; keep bot/task/chat address, query, roles, and order unchanged.',
      ),
      field(
        'order',
        'asc | desc',
        false,
        'Defaults to desc (newest first); asc is oldest first.',
      ),
    ],
    example: botsReadHistoryActionSchema.parse({
      type: 'bots.read_history',
      botId: 'app_advisor',
      taskId: 'advisor-task',
      chatId: 'advisor-chat',
    }),
    keywords: [
      'bots',
      'tasks',
      'chats',
      'history',
      'messages',
      'transcript',
      'read',
      'search',
    ],
    notes: [
      ...BOT_READ_NOTES,
      'Bounded scan: at most 20 raw transcript pages per request. In desc order a partial or empty result with nextCursor means continue paging, not no match. asc returns scan_budget_exceeded when the oldest row is beyond the budget; narrow filters or use desc.',
      'totalMessages and totalMatches are nullable. countsExact is true only when the whole history was scanned; otherwise both counts are null.',
      'Cursors bind caller, bot and task/chat address, filters, and transcript revision. Transcript changes return cursor_context_changed. Restart without a cursor on cursor_context_changed or cursor_expired.',
    ],
  },
  {
    type: 'bots.create_task',
    category: 'bots',
    summary: 'Create a new bot task with its first chat without navigating.',
    fields: [
      field('botId', 'string', true, 'Explicit public bot ID from discovery.'),
      field(
        'title',
        'string',
        false,
        'Optional task title, at most 200 characters; blank titles are omitted.',
      ),
      field(
        'initialMessage',
        'string',
        false,
        'Optional nonblank first message; original whitespace is preserved. Omit it to create the task with an empty founding chat.',
      ),
    ],
    example: botWriteActionSchema.parse({
      type: 'bots.create_task',
      botId: 'app_advisor',
      initialMessage: 'Review the latest changes.',
    }),
    keywords: ['create', 'new task', 'new chat', 'initial message'],
    notes: [
      'Returns CreatedTaskChatReceipt: address, taskCreated, chatCreated and input only when an initial message was accepted. Input proves acceptance, not completion.',
      'Initial messages use the trusted agent sender. No sender overrides, navigation or managed-delegate access.',
      'Always creates a new task and founding chat; taskCreated and chatCreated are true. Repeated calls are new creations, not retries.',
      'initialMessage is optional; without it no provider session starts. Use the public botId app_advisor; project agents require the Orchestrator access setting to allow their saved project owner.',
      'After an error, discover any created task or chat before retrying: creation and initial-message acceptance are separate commits.',
    ],
  },
  {
    type: 'bots.create_task_chat',
    category: 'bots',
    summary:
      'Create or reuse an empty chat in an existing bot task without navigating.',
    fields: [
      field('botId', 'string', true, 'Explicit public bot ID from discovery.'),
      field('taskId', 'string', true, 'Canonical task ID from discovery.'),
      field(
        'initialMessage',
        'string',
        true,
        'Nonblank first message; original whitespace is preserved.',
      ),
    ],
    example: botWriteActionSchema.parse({
      type: 'bots.create_task_chat',
      botId: 'app_advisor',
      taskId: 'task-id',
      initialMessage: 'Review the latest changes.',
    }),
    keywords: ['create', 'new task', 'new chat', 'initial message'],
    notes: [
      'Returns CreatedTaskChatReceipt: address, taskCreated, chatCreated and input only when an initial message was accepted. Input proves acceptance, not completion.',
      'Initial messages use the trusted agent sender. No sender overrides, navigation or managed-delegate access.',
      'May reuse the first eligible empty non-terminal chat, excluding file, read-only, stale-session and caller chats. Reuse keeps its settings and returns chatCreated:false; otherwise chatCreated:true. taskCreated is always false.',
      'initialMessage is required. Use the public botId app_advisor; project agents require the Orchestrator access setting to allow their saved project owner.',
      'After an error, discover any created task or chat before retrying: creation and initial-message acceptance are separate commits.',
    ],
  },
  {
    type: 'bots.send_message',
    category: 'bots',
    summary:
      'Send to an explicit bot chat without changing the visible selection or target settings.',
    fields: [
      field(
        'botId',
        'string',
        true,
        'Explicit target ID from discovery; never replaced by caller scope.',
      ),
      field('taskId', 'string', true, 'Canonical task ID from discovery.'),
      field('chatId', 'string', true, 'Canonical chat ID from discovery.'),
      field(
        'text',
        'string',
        true,
        'Nonblank message; original whitespace is preserved without truncation.',
      ),

      field(
        'watchers',
        'NewInlineWatcher[]',
        false,
        'Optional, up to 10 completion watchers: label, followUpInstruction, allowDuplicate only. Reserved before sending; notify the calling chat.',
      ),
    ],
    example: botWriteActionSchema.parse({
      type: 'bots.send_message',
      botId: 'app_advisor',
      taskId: 'entry-id',
      chatId: 'chat-id',
      text: 'Please review the latest changes.',
    }),
    keywords: ['send', 'message', 'chat', 'receipt', 'watchers'],
    notes: [
      'Sending starts or queues an input under shared tool approval and the target session policy; discovery is not permission to mutate.',
      'Returns AcceptedInputReceipt: canonical address, started with messageId or queued with queuedMessageId, acceptedAt, optional turnId, and watcherReceipts (created or deduplicated). Acceptance is not completion.',
      'No navigation or UI revision is required. Self-send is rejected. Sender context is captured by the host; do not supply sender or target settings.',
      'Watchers are optional; sending alone creates none. Root chats and Orchestrator only; managed delegates cannot discover or dispatch sends.',
      'Caller Orchestrator access is checked on every call; disabled access refuses the send.',
    ],
  },
];

/** The registry-enabled catalog; the legacy constant above stays unchanged. */
export const BOT_REGISTRY_ACTION_CATALOG: readonly AgentActionCatalogEntry<
  BotActionType,
  BotAction
>[] = BOT_ACTION_CATALOG.map((entry) =>
  entry.type === 'bots.list'
    ? {
        ...entry,
        fields: [...entry.fields, ...BOT_REGISTRY_LIST_FIELDS],
        notes: BOT_REGISTRY_LIST_NOTES,
      }
    : entry,
);
