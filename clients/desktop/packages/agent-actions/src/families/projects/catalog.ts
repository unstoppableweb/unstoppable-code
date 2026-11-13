import type {
  AgentActionCatalogEntry,
  AgentActionField,
} from '../../catalog/types';
import {
  projectsGetLastAgentResponseActionSchema,
  projectsGetLastUserMessageActionSchema,
  projectsListActionSchema,
  projectsListTaskChatsActionSchema,
  projectsListTasksActionSchema,
  projectsReadHistoryActionSchema,
  projectWriteActionSchema,
  type ProjectAction,
  type ProjectActionType,
} from './actions';

/** One catalog field row. */
export function field(
  name: string,
  type: string,
  required: boolean,
  description: string,
): AgentActionField {
  return { name, type, required, description };
}

const PROJECT_DISCOVERY_PAGE_FIELDS: readonly AgentActionField[] = [
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
  field(
    'sort',
    'string',
    false,
    'name (projects) or title (tasks/chats), created_at, or last_activity. Projects default to name; tasks/chats to last_activity.',
  ),
  field(
    'order',
    'asc | desc',
    false,
    'Projects default to asc; tasks/chats to desc. Canonical IDs break ties.',
  ),
];
const PROJECT_DISCOVERY_NOTES: readonly string[] = [
  'Read-only explicit-target discovery; no UI fields or expectedUiRevision. Supply projectId for task/chat lists; optional taskId narrows the chat list.',
  'Code and cowork root agents may discover only projects with the same saved owner as their origin. Orchestrator can discover all authorized owners; owner filters only narrow access.',
  'Archived retention filters are currently unavailable and return unsupported_filter. Retained active and done tasks remain discoverable.',
  'cursor_expired and cursor_context_changed require restarting from the first page without a cursor. Keep target, filters, sort, and order unchanged during continuation.',
];

const PROJECT_READ_ADDRESS_FIELDS: readonly AgentActionField[] = [
  field(
    'projectId',
    'string',
    true,
    'Canonical project ID from projects.list.',
  ),
  field(
    'taskId',
    'string',
    true,
    'Canonical task ID from projects.list_tasks.',
  ),
  field(
    'chatId',
    'string',
    true,
    'Canonical chat ID from projects.list_task_chats in that task.',
  ),
];
const PROJECT_READ_NOTES: readonly string[] = [
  'Read-only explicit address from discovery: supply projectId, taskId, and chatId. No UI fields or expectedUiRevision; retained discoverable targets only, not archives.',
  'Code and cowork root agents may read only projects with the same saved owner as their origin. Orchestrator may read all authorized owners. Self-history reads are allowed; unknown or unauthorized targets return not_found.',
  'Visible user/assistant text and basename-only file references only; no tool calls, tool results, thinking, hidden context, system/hook/info blocks, or child agents. Empty visible projections are excluded. Each message is capped at 8,000 characters with truncation marked.',
];

/** The explicit-target project actions' catalog rows: discovery, reads and writes. */
export const PROJECT_ACTION_CATALOG: readonly AgentActionCatalogEntry<
  ProjectActionType,
  ProjectAction
>[] = [
  {
    type: 'projects.list',
    category: 'projects',
    summary:
      'Discover authorized Code and Cowork projects, including Personal and organization Chats, with readiness and available task counts.',
    fields: [
      ...PROJECT_DISCOVERY_PAGE_FIELDS,
      field(
        'types',
        'Array<code | cowork>',
        false,
        'Non-empty unique project type filter.',
      ),
      field(
        'purposes',
        'Array<project | chats>',
        false,
        'Non-empty unique purpose filter.',
      ),
      field(
        'readiness',
        'Array<ready | pending | unavailable>',
        false,
        'Non-empty unique readiness filter.',
      ),
      field(
        'owner',
        'ProjectOwnerContext',
        false,
        'personal, or organization with organizationId; narrows authorized results.',
      ),
      field(
        'includeDefault',
        'boolean',
        false,
        'Include default Chats projects; defaults to true.',
      ),
    ],
    example: projectsListActionSchema.parse({ type: 'projects.list' }),
    keywords: ['projects', 'discovery', 'code', 'cowork', 'chats', 'owner'],
    notes: PROJECT_DISCOVERY_NOTES,
  },
  {
    type: 'projects.list_tasks',
    category: 'projects',
    summary:
      'List retained active or done tasks in an explicit project: Code worktrees or Cowork Work Entries, with compact chat counts.',
    fields: [
      field(
        'projectId',
        'string',
        true,
        'Canonical target project ID from projects.list.',
      ),
      ...PROJECT_DISCOVERY_PAGE_FIELDS,
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
        'Defaults to retained; archived is unsupported for now.',
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
        'Cowork Work Entries only; incompatible with Code projects.',
      ),
      field(
        'branchName',
        'string',
        false,
        'Code worktrees only; incompatible with Cowork projects.',
      ),
    ],
    example: projectsListTasksActionSchema.parse({
      type: 'projects.list_tasks',
      projectId: 'my-project',
    }),
    keywords: [
      'projects',
      'tasks',
      'worktrees',
      'work entries',
      'active',
      'done',
    ],
    notes: PROJECT_DISCOVERY_NOTES,
  },
  {
    type: 'projects.list_task_chats',
    category: 'projects',
    summary:
      'List compact chat metadata in an explicit project, optionally narrowed to one task; runtime observations are timestamped.',
    fields: [
      field(
        'projectId',
        'string',
        true,
        'Canonical target project ID from projects.list.',
      ),
      field(
        'taskId',
        'string',
        false,
        'Canonical task ID from projects.list_tasks; omit to list chats across the project.',
      ),
      ...PROJECT_DISCOVERY_PAGE_FIELDS,
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
        'Defaults to retained; archived is unsupported for now.',
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
        'Opt in to an indexed last-user preview, up to 1,000 characters; unavailable previews are omitted. Defaults to false.',
      ),
    ],
    example: projectsListTaskChatsActionSchema.parse({
      type: 'projects.list_task_chats',
      projectId: 'my-project',
      taskId: 'my-task',
    }),
    keywords: ['projects', 'tasks', 'chats', 'runtime', 'queue', 'metadata'],
    notes: PROJECT_DISCOVERY_NOTES,
  },
  {
    type: 'projects.get_last_user_message',
    category: 'projects',
    summary:
      'Read the latest visible user message in an explicitly addressed project chat.',
    fields: PROJECT_READ_ADDRESS_FIELDS,
    example: projectsGetLastUserMessageActionSchema.parse({
      type: 'projects.get_last_user_message',
      projectId: 'my-project',
      taskId: 'my-task',
      chatId: 'my-chat',
    }),
    keywords: ['projects', 'tasks', 'chats', 'last', 'user', 'message', 'read'],
    notes: [
      ...PROJECT_READ_NOTES,
      'Returns message:null when no visible user message exists, distinct from execution_failed on a read failure.',
    ],
  },
  {
    type: 'projects.get_last_agent_response',
    category: 'projects',
    summary:
      'Read the latest completed top-level assistant response in an explicitly addressed project chat.',
    fields: PROJECT_READ_ADDRESS_FIELDS,
    example: projectsGetLastAgentResponseActionSchema.parse({
      type: 'projects.get_last_agent_response',
      projectId: 'my-project',
      taskId: 'my-task',
      chatId: 'my-chat',
    }),
    keywords: [
      'projects',
      'tasks',
      'chats',
      'last',
      'agent',
      'assistant',
      'response',
      'read',
    ],
    notes: [
      ...PROJECT_READ_NOTES,
      'Selects the newest completed turn with a nonempty visible final assistant message. A newer streaming, paused, or failed turn does not hide an older completed response. Returns message:null when none exists, not on read failure. terminalDisposition is included only when proven by a correlated recorded turn outcome, never inferred from current status.',
    ],
  },
  {
    type: 'projects.read_history',
    category: 'projects',
    summary:
      'Page visible messages in an explicitly addressed project chat, with optional role and text filters.',
    fields: [
      ...PROJECT_READ_ADDRESS_FIELDS,
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
        'Opaque continuation cursor; keep address, query, roles, and order unchanged.',
      ),
      field(
        'order',
        'asc | desc',
        false,
        'Defaults to desc (newest first); asc is oldest first.',
      ),
    ],
    example: projectsReadHistoryActionSchema.parse({
      type: 'projects.read_history',
      projectId: 'my-project',
      taskId: 'my-task',
      chatId: 'my-chat',
    }),
    keywords: [
      'projects',
      'tasks',
      'chats',
      'history',
      'messages',
      'transcript',
      'read',
      'search',
    ],
    notes: [
      ...PROJECT_READ_NOTES,
      'Bounded scan: at most 20 raw transcript pages per request. In desc order a partial or empty result with nextCursor means continue paging, not no match. asc returns scan_budget_exceeded when the oldest row is beyond the budget; narrow filters or use desc.',
      'totalMessages and totalMatches are nullable. countsExact is true only when the whole history was scanned; otherwise both counts are null.',
      'Cursors bind caller, owner, address, filters, and transcript revision. Transcript changes return cursor_context_changed. Restart without a cursor on cursor_context_changed or cursor_expired.',
    ],
  },
  {
    type: 'projects.create_task',
    category: 'projects',
    summary: 'Create a new cowork task with its first chat without navigating.',
    fields: [
      field('projectId', 'string', true, 'Explicit project ID from discovery.'),
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
        'Nonblank first message; original whitespace is preserved.',
      ),
      field(
        'model',
        'string',
        false,
        'Model id from models.list, including an installed custom Agent. Omit for the project default.',
      ),
    ],
    example: projectWriteActionSchema.parse({
      type: 'projects.create_task',
      projectId: 'project-id',
    }),
    keywords: ['create', 'new task', 'new chat', 'initial message'],
    notes: [
      'Returns CreatedTaskChatReceipt: address, taskCreated, chatCreated and input only when an initial message was accepted. Input proves acceptance, not completion.',
      'With model, the model or Agent is checked against the target project (availability, policy, gateway, runtime) before anything is created. An Agent on the default model is pinned to the target default. The receipt adds model (the stored id) and, for an Agent, agentId; projects.list_task_chats model is the durable re-check.',
      'Initial messages use the trusted agent sender. No sender overrides, navigation or managed-delegate access.',
      'Always creates a new task and founding chat; taskCreated and chatCreated are true. Repeated calls are new creations, not retries.',
      'Cowork projects only. Code projects must use the existing worktree-creation workflow; this action returns unsupported_action there.',
      'After an error, discover any created task or chat before retrying: creation and initial-message acceptance are separate commits.',
    ],
  },
  {
    type: 'projects.create_task_chat',
    category: 'projects',
    summary:
      'Create or reuse an empty chat in an existing project task without navigating.',
    fields: [
      field('projectId', 'string', true, 'Explicit project ID from discovery.'),
      field('taskId', 'string', true, 'Canonical task ID from discovery.'),
      field(
        'initialMessage',
        'string',
        false,
        'Nonblank first message; original whitespace is preserved.',
      ),
      field(
        'model',
        'string',
        false,
        'Model id from models.list, including an installed custom Agent. Always creates a new chat. Omit for the project default or a reused empty chat.',
      ),
    ],
    example: projectWriteActionSchema.parse({
      type: 'projects.create_task_chat',
      projectId: 'project-id',
      taskId: 'task-id',
    }),
    keywords: ['create', 'new task', 'new chat', 'initial message'],
    notes: [
      'Returns CreatedTaskChatReceipt: address, taskCreated, chatCreated and input only when an initial message was accepted. Input proves acceptance, not completion.',
      'With model, the model or Agent is checked against the target project (availability, policy, gateway, runtime) before anything is created. An Agent on the default model is pinned to the target default. The receipt adds model (the stored id) and, for an Agent, agentId; projects.list_task_chats model is the durable re-check.',
      'Initial messages use the trusted agent sender. No sender overrides, navigation or managed-delegate access.',
      'Without model, may reuse the first eligible empty non-terminal chat, excluding file, read-only, stale-session and caller chats. Reuse keeps its settings and returns chatCreated:false; otherwise chatCreated:true. With model, always creates a new chat. taskCreated is always false.',
      'Supports code and cowork tasks. Omit initialMessage to create or reuse an empty chat without starting a provider session.',
      'After an error, discover any created task or chat before retrying: creation and initial-message acceptance are separate commits.',
    ],
  },
  {
    type: 'projects.steer_queued_message',
    category: 'projects',
    summary:
      'Steer an existing queued input into its active turn without changing its sender or navigating.',
    fields: [
      field('projectId', 'string', true, 'Explicit project ID from discovery.'),
      field('taskId', 'string', true, 'Canonical task ID from discovery.'),
      field('chatId', 'string', true, 'Canonical chat ID from discovery.'),
      field(
        'queuedMessageId',
        'string',
        true,
        'Host queue row ID from a queued send receipt or chat projection.',
      ),
    ],
    example: projectWriteActionSchema.parse({
      type: 'projects.steer_queued_message',
      projectId: 'project-id',
      taskId: 'task-id',
      chatId: 'chat-id',
      queuedMessageId: 'queued-id',
    }),
    keywords: ['steer', 'queue', 'queued message', 'active turn'],
    notes: [
      'Returns SteeredInputReceipt: address, queuedMessageId, disposition steered and steeredAt. No compare-and-set is promised.',
      'Keeps the original input sender and provenance; records the steering actor separately. Self-steer is allowed because it creates no input.',
      'An ineligible input stays queued with missing_capability. Root chats and Orchestrator only; managed delegates cannot discover or dispatch this action.',
    ],
  },
  {
    type: 'projects.schedule_message',
    category: 'projects',
    summary:
      'Save a one-time message to an existing project chat without navigating or changing target settings.',
    fields: [
      field('projectId', 'string', true, 'Explicit project ID from discovery.'),
      field('taskId', 'string', true, 'Canonical task ID from discovery.'),
      field('chatId', 'string', true, 'Canonical chat ID from discovery.'),
      field(
        'text',
        'string',
        true,
        'Nonblank message; original whitespace is preserved.',
      ),
      field(
        'runAt',
        'string',
        true,
        'Future ISO instant with Z or an explicit offset.',
      ),
      field(
        'timezone',
        "'local'",
        false,
        'Omit or use local; runAt supplies the instant.',
      ),
      field(
        'name',
        'string',
        false,
        'Optional activity name; defaults to Scheduled message.',
      ),
      field(
        'attachments',
        'ScheduledMessageAttachments',
        false,
        'Typed fileReferences (displayPath, absolutePath, optional repoName), attachmentPaths and attachmentPromptContexts (attachmentPath, promptKind). No other fields.',
      ),
      field(
        'inputMode',
        "'typed' | 'voice'",
        false,
        'Original input mode; defaults to typed.',
      ),
    ],
    example: projectWriteActionSchema.parse({
      type: 'projects.schedule_message',
      projectId: 'project-id',
      taskId: 'task-id',
      chatId: 'chat-id',
      text: 'Continue',
      runAt: '2099-06-01T15:00:00.000Z',
    }),
    keywords: [
      'schedule',
      'message',
      'scheduled send',
      'continue',
      'worktree_session_prompt',
    ],
    notes: [
      'Returns ScheduledMessageReceipt: address, automationId, name, resolved runAt, timezone and createdAt. Saving is not delivery.',
      'Captures the sender in main and rechecks the saved owner rule at delivery. User edits keep attribution. Agents cannot edit the action of an agent-scheduled send; cancel and schedule a new one instead.',
      'Use this action rather than generic automation.create with worktree_session_prompt. Self-scheduling is refused. Root chats and Orchestrator only; managed delegates cannot discover or dispatch it.',
    ],
  },
  {
    type: 'projects.send_message',
    category: 'projects',
    summary:
      'Send to an explicit project chat without changing the visible selection or target settings.',
    fields: [
      field(
        'projectId',
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
        'queueForSetup',
        'boolean',
        false,
        'Code targets only: queue until setup completes; unsupported for Cowork targets.',
      ),
      field(
        'watchers',
        'NewInlineWatcher[]',
        false,
        'Optional, up to 10 completion watchers: label, followUpInstruction, allowDuplicate only. Reserved before sending; notify the calling chat.',
      ),
    ],
    example: projectWriteActionSchema.parse({
      type: 'projects.send_message',
      projectId: 'project-id',
      taskId: 'task-id',
      chatId: 'chat-id',
      text: 'Please review the latest changes.',
    }),
    keywords: ['send', 'message', 'chat', 'receipt', 'watchers'],
    notes: [
      'Sending starts or queues an input under shared tool approval and the target session policy; discovery is not permission to mutate.',
      'Returns AcceptedInputReceipt: canonical address, started with messageId or queued with queuedMessageId, acceptedAt, optional turnId, and watcherReceipts (created or deduplicated). Acceptance is not completion.',
      'No navigation or UI revision is required. Self-send is rejected. Sender context is captured by the host; do not supply sender or target settings.',
      'Watchers are optional; sending alone creates none. Root chats and Orchestrator only; managed delegates cannot discover or dispatch sends.',
      'Project roots may send only within their saved owner boundary.',
    ],
  },
];
