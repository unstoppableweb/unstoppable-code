import { randomUUID } from 'node:crypto';
import {
  isUuid,
  webCoreRequestSchema,
} from '../../../src/main/canopy-runtime/renderer-relay/__tests__/web-core-wire.ts';

/**
 * A seeded cloud chat world for the desktop E2E harness (CAN-6280): the web
 * core operations a desktop cloud chat page uses, answered from memory with
 * no network. `startCloudChatsWebCore` serves it over the real POST + SSE
 * binding; the golden in `src/main/canopy-cloud/__tests__` parses every
 * answer with the protocol's own schemas, so the fake can't drift from the
 * web core it stands in for.
 *
 * It refuses what the real web core refuses (CAN-6342): every request is
 * parsed with the relay's own protocol definitions, then checked against the
 * web core's rules for the operations served here, so a desktop request the
 * real web core would refuse fails in the harness too.
 *
 * The seed is one cowork project with one task. The task's root chat and a
 * second chat are its tabs, each with a few turns; the root chat has a
 * pending question; the task's folder serves two files. A send appends the
 * message and a seeded reply and pushes them as one `core.chat.events` batch.
 * `core.chat.create` adds a task, or a chat to a task, as the web core does
 * (CAN-6098): a spec can delay it with `state.createDelayMs` or have it
 * refused with `state.createRefusals`.
 */

/** Stable ids a spec, a capture or another seeder can rely on. */
export const SEEDED_CLOUD_CHATS = Object.freeze({
  workspaceId: '7e2c1f4a-3b5d-4c8e-9a1f-0d2e4b6c8a10',
  workspaceName: 'Launch plan',
  /** Cloud ids are lowercase UUIDs; the web core finds no chat by any other. */
  /** The task: its root chat, whose id is the task's worktree id. */
  taskId: '7e2c1f4a-3b5d-4c8e-9a1f-0d2e4b6c8a20',
  taskTitle: 'Plan the launch',
  rootChatId: '7e2c1f4a-3b5d-4c8e-9a1f-0d2e4b6c8a20',
  secondChatId: '7e2c1f4a-3b5d-4c8e-9a1f-0d2e4b6c8a30',
  secondChatTitle: 'Draft the announcement',
  questionId: '7e2c1f4a-3b5d-4c8e-9a1f-0d2e4b6c8a40',
  /** The `AskUserQuestion` call in the transcript the question card binds to. */
  questionToolUseId: 'e2e-cloud-ask',
  /** Ids of seeded messages, for a host seeder that keys notes by message. */
  messageIds: Object.freeze({
    firstUser: 'e2e-cloud-msg-1',
    firstReply: 'e2e-cloud-msg-2',
    secondUser: 'e2e-cloud-msg-3',
    secondReply: 'e2e-cloud-msg-4',
    otherChatUser: 'e2e-cloud-msg-5',
    otherChatReply: 'e2e-cloud-msg-6',
  }),
  files: Object.freeze({
    'README.md': '# Launch plan\n\nShip the cloud chats beta on Friday.\n',
    'notes/checklist.md': '- [x] Write the announcement\n- [ ] Book the demo\n',
  }),
});

const EPOCH = 'web-core-e2e';
const AT = '2026-11-11T09:00:00.000Z';
const AT_MS = Date.parse(AT);
/** The task folder's one file root. */
const FILE_ROOT_ID = 'e2e-cloud-root';

/** The pending question, as the agent asked it. */
const ROOM_QUESTION = Object.freeze({
  id: 'room',
  question: 'Which room should I book for the demo?',
  header: 'Room',
  options: ['Main hall', 'Studio B'],
  multiSelect: false,
});

const text = (id, role, body, offset) => ({
  id,
  role,
  blocks: [{ type: 'text', text: body }],
  timestamp: AT_MS + offset * 1000,
});

function seedTranscripts() {
  const ids = SEEDED_CLOUD_CHATS.messageIds;
  return {
    [SEEDED_CLOUD_CHATS.rootChatId]: [
      text(
        ids.firstUser,
        'user',
        'What do we still need before the launch?',
        0,
      ),
      text(
        ids.firstReply,
        'assistant',
        'Two things are open: the announcement draft and the demo booking. The checklist in notes/checklist.md tracks both.',
        5,
      ),
      text(ids.secondUser, 'user', 'Book the demo for Thursday afternoon.', 60),
      {
        ...text(
          ids.secondReply,
          'assistant',
          'Before I book it, which room should I use?',
          65,
        ),
        blocks: [
          { type: 'text', text: 'Before I book it, which room should I use?' },
          {
            type: 'tool_use',
            toolUseId: SEEDED_CLOUD_CHATS.questionToolUseId,
            toolName: 'AskUserQuestion',
            input: JSON.stringify({ questions: [ROOM_QUESTION] }),
          },
        ],
      },
    ],
    [SEEDED_CLOUD_CHATS.secondChatId]: [
      text(ids.otherChatUser, 'user', 'Draft a short announcement.', 120),
      text(
        ids.otherChatReply,
        'assistant',
        'Cloud chats are in beta: start a task here and pick it up anywhere.',
        125,
      ),
    ],
  };
}

/**
 * A Core agent task row as the web core serves it in a chat snapshot's
 * `tasks` and in `agent_tasks.replaced` (CAN-5976).
 */
export function agentTaskRow(fields) {
  return {
    stateVersion: '1',
    kind: 'subagent',
    harness: 'CLAUDE_CODE',
    status: 'running',
    stopReason: null,
    native: {},
    parentTaskId: null,
    spawnTurnId: null,
    spawnToolCallId: null,
    title: null,
    description: null,
    prompt: null,
    subagentType: null,
    thinkingEffort: null,
    costUsd: null,
    summary: null,
    outputTail: null,
    model: null,
    usage: null,
    error: null,
    createdAtMs: Date.parse(AT),
    startedAtMs: Date.parse(AT),
    updatedAtMs: Date.parse(AT),
    completedAtMs: null,
    approvalPending: false,
    background: false,
    ...fields,
  };
}

/** The spawn call of the background subagent `startBackgroundAgent` gives a chat. */
export const BACKGROUND_AGENT = {
  spawnToolCallId: 'toolu_e2e_survey',
  description: 'Survey the repo',
  shellDescription: 'Watch the build',
};

const ok = (result) => ({ result });
const refuse = (kind, message, code) => ({
  error: {
    kind,
    message,
    ...(code ? { code } : {}),
    retry: { kind: 'never' },
  },
});
/** A refusal with the web core's `details` or `retry`, as its `refuse` takes them. */
const refuseWith = (kind, message, extra) => ({
  error: { kind, message, retry: { kind: 'never' }, ...extra },
});

/** The `chat.create_tab` fields the web core serves. */
const CREATE_FIELDS = ['type', 'tabId', 'title'];
/** As the web core's `MAX_CLOUD_CHAT_TITLE_LENGTH`. */
const MAX_TITLE_LENGTH = 256;
/** As the web core's `DEFAULT_CHAT_TITLE`, for a chat created untitled. */
const DEFAULT_CHAT_TITLE = 'New chat';

/** The authority this fake web core names in `core.runtime.initialize`. */
export const WEB_CORE_AUTHORITY_ID = 'web-core-e2e';

/**
 * The scope fields each served operation reads, and those it needs, as the
 * web core's `unservedScope` and its chat lookups check them.
 */
const SCOPES = {
  'core.workspace.list': { served: ['organizationId', 'workspaceId'] },
  'core.chat.snapshot.get': {
    served: ['workspaceId', 'worktreeId'],
    needs: ['workspaceId', 'worktreeId'],
  },
  'core.chat.transcript.page': {
    served: ['workspaceId', 'worktreeId', 'chatId'],
    needs: ['workspaceId', 'worktreeId', 'chatId'],
  },
  'core.chat.message.send': {
    served: ['workspaceId', 'worktreeId'],
    needs: ['workspaceId', 'worktreeId'],
  },
  'core.chat.send.receipt': {
    served: ['workspaceId', 'worktreeId', 'chatId'],
    needs: ['workspaceId', 'worktreeId', 'chatId'],
  },
  'worker.filesystem.roots.list': { served: ['chatId'], needs: ['chatId'] },
  'worker.filesystem.directory.list': { served: ['chatId'], needs: ['chatId'] },
  'worker.filesystem.search': { served: ['chatId'], needs: ['chatId'] },
  'worker.filesystem.file.read': { served: ['chatId'], needs: ['chatId'] },
};

/** The catalog kinds a workspace scopes; an organization alone offers none. */
const CAPABILITY_KINDS = ['skill', 'plugin', 'mcp_server', 'collection'];

const unservedScope = (method, scope) => {
  const rule = SCOPES[method];
  if (rule === undefined || scope === undefined || scope === null) return null;
  const fields = Object.keys(scope).filter((field) => field !== 'authorityId');
  if (
    (scope.authorityId !== undefined &&
      scope.authorityId !== WEB_CORE_AUTHORITY_ID) ||
    fields.some((field) => !rule.served.includes(field))
  )
    return refuse(
      'capability_unavailable',
      'The selected scope is not served by this core.',
    );
  const missing = (rule.needs ?? []).filter((field) => !fields.includes(field));
  return missing.length === 0
    ? null
    : refuse('invalid_argument', `The scope needs ${missing.join(', ')}.`);
};

/**
 * The web core's own refusals of a request whose params parse, for the
 * operations this fake serves. Null when the web core would serve it.
 */
function webCoreRefusal(method, params) {
  const scoped = unservedScope(method, params.scope);
  if (scoped !== null) return scoped;
  switch (method) {
    case 'core.catalog.snapshot.get': {
      const { workspaceId, organizationId, ...rest } = params.scope ?? {};
      if (Object.keys(rest).length > 0)
        return refuse(
          'invalid_argument',
          'Scope a catalog read by a workspace or an organization.',
        );
      const kinds = params.kinds ?? [];
      const wantsCapabilities =
        kinds.length === 0 ||
        kinds.some((kind) => CAPABILITY_KINDS.includes(kind));
      if (
        wantsCapabilities &&
        organizationId !== undefined &&
        workspaceId === undefined
      )
        return refuse(
          'invalid_argument',
          'Capabilities are scoped by a workspace.',
        );
      return null;
    }
    case 'core.catalog.selection.get': {
      if (params.targetId !== undefined && params.targetId !== null)
        return refuse('invalid_argument', 'Selections have no target here.');
      const { chatId, workspaceId, ...rest } = params.scope;
      return Object.keys(rest).length > 0 ||
        (chatId === undefined) === (workspaceId === undefined)
        ? refuse(
            'invalid_argument',
            'Scope a selection by a chat or a workspace.',
          )
        : null;
    }
    case 'core.chat.message.send':
      return isUuid(params.commandId)
        ? null
        : refuse('invalid_argument', 'A cloud chat commandId must be a UUID.');
    case 'core.chat.create': {
      const { action } = params;
      const unserved = (fields, details = {}) =>
        refuseWith(
          'capability_unavailable',
          'Cloud chats do not serve these fields.',
          {
            details: { unsupported: fields, ...details },
            retry: {
              kind: 'after_refresh',
              resource: 'core.runtime.manifest.get',
            },
          },
        );
      if (action.type !== 'chat.create_tab')
        return unserved(['action.type'], { reason: 'file_tabs_unsupported' });
      const unsupported = [
        ...Object.keys(action).filter(
          (field) => !CREATE_FIELDS.includes(field),
        ),
        ...(params.expectedRevision === undefined ? [] : ['expectedRevision']),
        ...(params.expectedTabRevision === undefined
          ? []
          : ['expectedTabRevision']),
      ];
      if (unsupported.length > 0) return unserved(unsupported);
      if (!isUuid(action.tabId))
        return refuseWith(
          'invalid_argument',
          'A cloud chat tabId must be a UUID.',
          { details: { field: 'action.tabId', format: 'uuid' } },
        );
      if (action.title !== undefined && action.title.length > MAX_TITLE_LENGTH)
        return refuseWith('invalid_argument', 'The chat title is too long.', {
          details: { field: 'action.title', maxLength: MAX_TITLE_LENGTH },
        });
      return null;
    }
    case 'core.chat.events':
      return params.scope === 'all'
        ? refuse(
            'capability_unavailable',
            'This core streams one task at a time.',
          )
        : null;
    default:
      return null;
  }
}

/**
 * One world per test. `accountId` must be the signed-in account's id: main
 * closes a connection whose initialize names another principal.
 */
export function createCloudChatsWorld({ accountId }) {
  const seeded = SEEDED_CLOUD_CHATS;
  const state = {
    revision: 4,
    transcripts: seedTranscripts(),
    runtime: { [seeded.rootChatId]: 'idle', [seeded.secondChatId]: 'idle' },
    questions: [
      {
        requestId: seeded.questionId,
        chatId: seeded.rootChatId,
        toolUseId: seeded.questionToolUseId,
        questions: [ROOM_QUESTION],
      },
    ],
    /** Every `core.chat.message.send` the desktop made, in order. */
    sends: [],
    /** Every `core.chat.question.respond` the desktop made, in order. */
    answers: [],
    /**
     * The chats the web core holds, by id: each one's task (a task's own
     * chat is the task) and title. `core.chat.create` adds to it.
     */
    chats: new Map([
      [
        seeded.rootChatId,
        { worktreeId: seeded.taskId, title: seeded.taskTitle, createdAt: AT },
      ],
      [
        seeded.secondChatId,
        {
          worktreeId: seeded.taskId,
          title: seeded.secondChatTitle,
          createdAt: AT,
        },
      ],
    ]),
    /** Every `core.chat.create` the desktop made, in order. */
    creates: [],
    /** How long each `core.chat.create` takes before it lands, in ms. */
    createDelayMs: 0,
    /** Errors the next creates answer with, as the web core's handler throws them. */
    createRefusals: [],
    /** Operations a spec adds or overrides: method → (params) => answer. */
    extraAnswers: new Map(),
    /** Each chat's agent task rows, as its snapshot carries them. */
    tasks: {},
    /** Each chat's running turn, by chat id: its conversation turn id. */
    activeTurns: {},
    /** How long a sent turn runs before its reply commits, in ms. */
    replyDelayMs: 100,
    /** Every `core.chat.turn.cancel` the desktop made, in order. */
    cancels: [],
    /** How many `core.chat.snapshot.get` the desktop made. */
    snapshotReads: 0,
    /**
     * A running turn's live reply, by chat id, which `core.chat.live.events`
     * opens on: its turn item and its tool calls (live revision 2).
     */
    liveTurns: {},
  };
  /** Each running turn's reply, committed when its timer fires or Stop lands. */
  const finishers = new Map();
  /** @type {Map<string, { method: string, params: object }>} */
  const subscriptions = new Map();
  /** @type {Set<(notification: object) => void>} */
  const listeners = new Set();
  let sequence = 0;

  const cursor = () => ({ daemonEpoch: EPOCH, sequence });

  /** Sends `item` to every open subscription of `stream` that `matches`. */
  const emit = (stream, item, matches = () => true) => {
    sequence += 1;
    for (const [subscriptionId, subscription] of subscriptions) {
      if (subscription.method !== stream || !matches(subscription.params))
        continue;
      const notification = {
        jsonrpc: '2.0',
        method: `${stream}.item`,
        params: {
          subscriptionId,
          cursor: cursor(),
          itemId: randomUUID(),
          occurredAt: new Date().toISOString(),
          item,
        },
      };
      for (const listener of listeners) listener(notification);
    }
  };

  /** The chats of a task, its own chat first, as the web core lists them. */
  const chatsOf = (worktreeId) =>
    [...state.chats.entries()]
      .filter(([, chat]) => chat.worktreeId === worktreeId)
      .map(([chatId, chat]) => ({ chatId, ...chat }))
      .sort(
        (a, b) =>
          Number(b.chatId === worktreeId) - Number(a.chatId === worktreeId),
      );
  /** Every task, newest first: each is the chat whose task is itself. */
  const tasks = () =>
    [...state.chats.entries()]
      .filter(([chatId, chat]) => chat.worktreeId === chatId)
      .map(([chatId, chat]) => ({ worktreeId: chatId, ...chat }))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const isTask = (worktreeId) =>
    typeof worktreeId === 'string' &&
    state.chats.get(worktreeId.toLowerCase())?.worktreeId ===
      worktreeId.toLowerCase();
  const filesOf = (chatId) =>
    chatId === seeded.rootChatId || chatId === seeded.secondChatId
      ? seeded.files
      : {};

  /**
   * The runtime of the batch that commits a turn's reply: Core's session
   * status still reads `streaming` though no turn runs (staging, 11 Nov
   * 2026); a turn that still runs names itself.
   */
  const committedRuntime = (chatId) =>
    activeTurnOf(chatId) === undefined
      ? { status: 'streaming', queuedMessageIds: [] }
      : runtimeOf(chatId);

  /** The turn that asked a pending question runs until it is answered. */
  const QUESTION_TURN = 'e2e-question-turn';
  const activeTurnOf = (chatId) =>
    state.activeTurns[chatId] ??
    (state.questions.some((question) => question.chatId === chatId)
      ? QUESTION_TURN
      : undefined);

  const tab = (chat) => ({
    chatId: chat.chatId,
    title: chat.title,
    kind: 'chat',
    createdAt: chat.createdAt,
    transcriptRevision: state.transcripts[chat.chatId].length,
  });

  /**
   * A chat's runtime as the web core's `runtimeOf` reads it from Core
   * (apps/web/src/lib/web-core/chat.ts): the running turn's id beside Core's
   * session status, which waits on a pending question as `awaiting_input`.
   */
  const runtimeOf = (chatId) => {
    const turnId = activeTurnOf(chatId);
    return {
      status:
        turnId === undefined
          ? (state.runtime[chatId] ?? 'idle')
          : state.questions.some((question) => question.chatId === chatId)
            ? 'awaiting_input'
            : 'streaming',
      queuedMessageIds: [],
      ...(turnId === undefined ? {} : { activeTurnId: turnId }),
    };
  };

  /**
   * Tells each live stream following `chatId` that no turn runs, as the web
   * core's live stream does once a turn's reply commits (chat-live.ts).
   */
  const liveIdle = (chatId) =>
    emit(
      'core.chat.live.events',
      { kind: 'idle', chatId },
      (each) => each.scope?.chatId?.toLowerCase() === chatId,
    );

  const chatBatch = (worktreeId, changes) => {
    const baseRevision = state.revision;
    state.revision += 1;
    emit(
      'core.chat.events',
      {
        schemaVersion: 1,
        eventId: randomUUID(),
        occurredAt: new Date().toISOString(),
        projectId: seeded.workspaceId,
        worktreeId,
        baseRevision,
        revision: state.revision,
        changes,
      },
      (params) => params.scope?.worktreeId?.toLowerCase() === worktreeId,
    );
    // Every committed batch also names its task on the sidebar's stream
    // (apps/web/src/lib/web-core/chat-task-events.ts), which re-reads it.
    emit(
      'core.chat.task.events',
      {
        kind: 'task',
        workspaceId: seeded.workspaceId,
        worktreeId,
        batchId: String(state.revision),
      },
      (each) =>
        each.scope === 'all' || each.scope?.workspaceId === seeded.workspaceId,
    );
  };

  /**
   * Core settles an answered question and its turn runs on to the reply.
   * Core records no result for its question call (staging, 11 Nov 2026): the
   * batch that commits the reply upserts the asking message as it was, the
   * call with nothing after it, and reports Core's session still running
   * with no turn, as the web core's `runtimeOf` reads them
   * (apps/web/src/lib/web-core/chat.ts, chat-events.ts).
   */
  const finishAnsweredTurn = (question) => {
    const messages = state.transcripts[question.chatId];
    const asking = messages.find((message) =>
      message.blocks.some(
        (block) =>
          block.type === 'tool_use' && block.toolUseId === question.toolUseId,
      ),
    );
    const reply = text(
      `${question.requestId}-reply`,
      'assistant',
      'Studio B it is.',
      0,
    );
    reply.timestamp = Date.now();
    messages.push(reply);
    chatBatch(state.chats.get(question.chatId).worktreeId, [
      ...(asking === undefined
        ? []
        : [
            {
              type: 'message.upserted',
              chatId: question.chatId,
              message: asking,
            },
          ]),
      { type: 'message.upserted', chatId: question.chatId, message: reply },
      {
        type: 'runtime.patched',
        chatId: question.chatId,
        runtime: committedRuntime(question.chatId),
      },
    ]);
    liveIdle(question.chatId);
  };

  /**
   * A sent turn as the web core reports Core's: queued while Core's session
   * still reads `awaiting_input`, then running under its conversation turn
   * id, then its reply committed in a batch whose runtime names no turn
   * while Core's session status still reads `streaming`. No runtime change
   * follows (staging, 11 Nov 2026). Stop ends it early with what it wrote.
   */
  const runTurn = (chatId, user, turnId, replyText) => {
    const worktreeId = state.chats.get(chatId).worktreeId;
    const messages = state.transcripts[chatId];
    setTimeout(() => {
      chatBatch(worktreeId, [
        {
          type: 'runtime.patched',
          chatId,
          runtime: { status: 'awaiting_input', queuedMessageIds: [user.id] },
        },
      ]);
      setTimeout(() => {
        messages.push(user);
        state.activeTurns[chatId] = turnId;
        chatBatch(worktreeId, [
          { type: 'message.upserted', chatId, message: user },
          { type: 'runtime.patched', chatId, runtime: runtimeOf(chatId) },
        ]);
        const finish = (body) => {
          clearTimeout(timer);
          finishers.delete(turnId);
          const reply = text(`${user.id}-reply`, 'assistant', body, 0);
          reply.timestamp = Date.now();
          messages.push(reply);
          delete state.activeTurns[chatId];
          chatBatch(worktreeId, [
            { type: 'message.upserted', chatId, message: user },
            { type: 'message.upserted', chatId, message: reply },
            {
              type: 'runtime.patched',
              chatId,
              runtime: committedRuntime(chatId),
            },
          ]);
          liveIdle(chatId);
        };
        const timer = setTimeout(() => finish(replyText), state.replyDelayMs);
        finishers.set(turnId, finish);
      }, 20);
    }, 0);
  };

  /** The task folder's entries directly under `directory` ('' is the root). */
  const filesUnder = (files, directory) => {
    const prefix = directory === '' ? '' : `${directory}/`;
    const entries = new Map();
    for (const path of Object.keys(files)) {
      if (!path.startsWith(prefix)) continue;
      const [name, ...more] = path.slice(prefix.length).split('/');
      const kind = more.length > 0 ? 'directory' : 'file';
      entries.set(name, {
        name,
        relativePath: `${prefix}${name}`,
        kind,
        isIgnored: false,
        isIndexExcluded: false,
        isSymlink: false,
        hasChildren: kind === 'directory',
      });
    }
    return [...entries.values()];
  };

  const answer = (method, params) => {
    const extra = state.extraAnswers.get(method);
    if (extra) return extra(params);
    switch (method) {
      case 'core.workspace.list':
        return ok({
          items: [
            {
              workspaceId: seeded.workspaceId,
              name: seeded.workspaceName,
              kind: 'cowork',
              ownerOrganizationId: null,
              revision: 1,
              repositorySources: [],
              settings: {},
            },
          ],
          nextCursor: null,
        });
      case 'core.chat.task.list':
        if (params.scope?.workspaceId !== seeded.workspaceId)
          return ok({ items: [], nextCursor: null });
        return ok({
          items: tasks().map((task) => ({
            workspaceId: seeded.workspaceId,
            worktreeId: task.worktreeId,
            title: task.title,
            state: state.questions.some(
              (question) =>
                state.chats.get(question.chatId)?.worktreeId ===
                task.worktreeId,
            )
              ? 'awaiting_user'
              : 'idle',
            updatedAt: task.createdAt,
            revision: state.revision,
          })),
          nextCursor: null,
        });
      case 'core.chat.snapshot.get': {
        state.snapshotReads += 1;
        const worktreeId = params.scope.worktreeId.toLowerCase();
        const chats = chatsOf(worktreeId);
        // A task snapshot opens the task's own chat; a chat snapshot, its chat.
        const opened = (params.chatId ?? worktreeId).toLowerCase();
        return ok({
          workspaceId: seeded.workspaceId,
          worktreeId,
          revision: state.revision,
          eventsCursor: cursor(),
          tabs: { activeTabId: opened, items: chats.map(tab) },
          ...(state.tasks[opened] === undefined
            ? {}
            : { tasks: state.tasks[opened] }),
          archives: [],
          runtimeByChatId: Object.fromEntries(
            chats.map((chat) => [chat.chatId, runtimeOf(chat.chatId)]),
          ),
          queue: [],
          pendingQuestions: state.questions.filter(
            (question) =>
              state.chats.get(question.chatId)?.worktreeId === worktreeId,
          ),
        });
      }
      case 'core.chat.list':
        if (
          params.scope?.workspaceId !== seeded.workspaceId ||
          !isTask(params.scope?.worktreeId)
        )
          return ok({ items: [], nextCursor: null });
        return ok({
          items: chatsOf(params.scope.worktreeId.toLowerCase()).map(
            ({ chatId, worktreeId, title, createdAt }) => ({
              chatId,
              workspaceId: seeded.workspaceId,
              worktreeId,
              title,
              state:
                state.activeTurns[chatId] !== undefined
                  ? 'running'
                  : state.questions.some(
                        (question) => question.chatId === chatId,
                      )
                    ? 'awaiting_user'
                    : 'idle',
              revision: state.revision,
              createdAt,
            }),
          ),
          nextCursor: null,
        });
      case 'core.chat.transcript.page': {
        const chatId = params.scope?.chatId ?? seeded.rootChatId;
        const messages = state.transcripts[chatId];
        if (messages === undefined)
          return refuse('not_found', 'No such chat.', 'core.chat.notFound');
        return ok({
          messages,
          totalMessages: messages.length,
          transcriptRevision: messages.length,
        });
      }
      case 'core.chat.message.send': {
        const chatId = params.chatId;
        const messages = state.transcripts[chatId];
        if (messages === undefined)
          return refuse('not_found', 'No such chat.', 'core.chat.notFound');
        state.sends.push(params);
        const user = text(params.messageId, 'user', params.text, 0);
        user.timestamp = Date.now();
        const turnId = `turn-${params.commandId}`;
        runTurn(chatId, user, turnId, `Seeded reply: ${params.text}`);
        // The receipt names the conversation turn, the id Stop cancels.
        return ok({
          commandId: params.commandId,
          revision: state.revision,
          outcome: 'applied',
          entityId: turnId,
          messageId: params.messageId,
        });
      }
      case 'core.chat.turn.cancel': {
        state.cancels.push(params);
        const chatId = params.chatId.toLowerCase();
        const chat = state.chats.get(chatId);
        if (chat === undefined) return chatNotFound();
        const running = activeTurnOf(chatId) === params.turnId;
        // The run winds down and its reply commits with what it wrote; a
        // turn already over is not an error (the catalog page, #8885).
        if (running)
          setTimeout(() => finishers.get(params.turnId)?.('Stopped.'), 20);
        return ok({
          chatId,
          workspaceId: seeded.workspaceId,
          worktreeId: chat.worktreeId,
          title: chat.title,
          state: running ? 'running' : 'idle',
          revision: 0,
          createdAt: chat.createdAt,
          updatedAt: new Date().toISOString(),
        });
      }
      case 'core.chat.send.receipt': {
        const sent = state.sends.find(
          (each) => each.commandId === params.commandId,
        );
        if (sent === undefined) return ok({ outcome: 'missing' });
        return ok({
          outcome: 'matched',
          receipt: {
            commandId: sent.commandId,
            revision: state.revision,
            outcome: 'applied',
          },
        });
      }
      case 'core.chat.question.respond': {
        const question = state.questions.find(
          (each) => each.requestId === params.questionId,
        );
        if (question === undefined)
          return refuse(
            'not_found',
            'No such question.',
            'core.chat.question.notFound',
          );
        state.answers.push(params);
        state.questions = state.questions.filter((each) => each !== question);
        // An answered interaction leaves Core's pending list, so the web core
        // sends `pending_question.removed` (apps/web/src/lib/web-core/chat-events.ts).
        chatBatch(state.chats.get(question.chatId).worktreeId, [
          {
            type: 'pending_question.removed',
            chatId: question.chatId,
            requestId: question.requestId,
          },
        ]);
        // Core then runs the turn on to its reply.
        setTimeout(() => finishAnsweredTurn(question), 50);
        // The web core answers with the chat, as `core.chat.turn.cancel` does.
        return ok({
          chatId: question.chatId,
          workspaceId: seeded.workspaceId,
          worktreeId: seeded.taskId,
          title: seeded.taskTitle,
          state: 'idle',
          revision: state.revision,
          createdAt: AT,
          updatedAt: new Date().toISOString(),
        });
      }
      case 'core.catalog.snapshot.get':
        return ok({
          revision: 1,
          entries: [],
          generatedAt: AT,
        });
      case 'core.catalog.selection.get':
        return ok({ revision: 1, selectedItemIds: [], unavailableItemIds: [] });
      case 'worker.filesystem.roots.list':
        return ok({
          roots: [
            {
              fileRootId: FILE_ROOT_ID,
              name: seeded.taskTitle,
              kind: 'workspace-root',
            },
          ],
        });
      case 'worker.filesystem.directory.list':
        return ok({
          entries: filesUnder(
            filesOf(params.scope.chatId.toLowerCase()),
            params.relativePath,
          ),
        });
      case 'worker.filesystem.search':
        return ok({
          matches: Object.keys(filesOf(params.scope.chatId.toLowerCase())).map(
            (path) => ({
              fileRootId: FILE_ROOT_ID,
              path,
              kind: 'file',
              name: path.split('/').pop(),
              isIgnored: false,
            }),
          ),
          nextCursor: null,
          truncated: false,
        });
      case 'worker.filesystem.file.read': {
        const content = filesOf(params.scope.chatId.toLowerCase())[
          params.relativePath
        ];
        if (content === undefined)
          return refuse(
            'not_found',
            'No such file.',
            'worker.filesystem.file.notFound',
          );
        const sizeBytes = Buffer.byteLength(content);
        return ok({
          fileRootId: FILE_ROOT_ID,
          relativePath: params.relativePath,
          name: params.relativePath.split('/').pop(),
          contentKind: 'markdown',
          encoding: 'utf8',
          content,
          sizeBytes,
          returnedBytes: sizeBytes,
          truncated: false,
          modifiedAt: AT,
          version: `v-${sizeBytes}`,
        });
      }
      case 'core.client.lease.acquire':
      case 'core.client.lease.renew':
        return ok({
          leaseId: 'e2e-lease',
          clientInstanceId: params.clientInstanceId ?? 'e2e-client',
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
          renewAfterMs: 30_000,
          revision: (params.expectedRevision ?? 0) + 1,
        });
      case 'core.client.lease.release':
        return ok({
          released: true,
          releasedRegistrationCount: 0,
          failedRequestIds: [],
        });
      case 'core.events.ack':
        return ok({ acknowledgedCursor: params.cursor });
      case 'core.events.unsubscribe':
        return ok({
          unsubscribed: subscriptions.delete(params.subscriptionId),
        });
      case 'core.chat.create':
        return createChat(params);
      default:
        return undefined;
    }
  };

  /** Creates of a tab id in flight: another create of it meanwhile is refused. */
  const creating = new Set();

  /**
   * `core.chat.create`, as the web core's handler answers it: the tab id is
   * the chat's external id, so a repeated create replays the chat it made,
   * and one held under another task is a conflict. It settles after
   * `state.createDelayMs`, or with the next of `state.createRefusals`.
   */
  const createChat = async (params) => {
    state.creates.push(params);
    const tabId = params.action.tabId.toLowerCase();
    const projectId = params.projectId.toLowerCase();
    const worktreeId = params.worktreeId.toLowerCase();
    const receipt = {
      commandId: params.commandId,
      revision: 0,
      entityId: tabId,
    };
    const held = state.chats.get(tabId);
    if (
      held !== undefined &&
      (projectId !== seeded.workspaceId || held.worktreeId !== worktreeId)
    )
      return ok({
        ...receipt,
        outcome: 'conflict',
        reason: 'Another chat already uses this tab id.',
      });
    // Another create inserted this tab id first: the retry replays its claim.
    if (held === undefined && creating.has(tabId))
      return refuseWith(
        'unavailable',
        'Another create of this tab is in progress.',
        { retry: { kind: 'same_idempotency_key' } },
      );
    creating.add(tabId);
    try {
      if (state.createDelayMs > 0)
        await new Promise((resolve) =>
          setTimeout(resolve, state.createDelayMs),
        );
      const refusal = state.createRefusals.shift();
      if (refusal !== undefined) return { error: refusal };
      if (projectId !== seeded.workspaceId)
        return refuse('not_found', 'The project was not found.');
      if (held !== undefined)
        return ok({ ...receipt, outcome: 'already_applied' });
      if (worktreeId !== tabId && !isTask(worktreeId))
        return refuse('not_found', 'The task was not found.');
      state.chats.set(tabId, {
        worktreeId,
        title: params.action.title ?? DEFAULT_CHAT_TITLE,
        createdAt: new Date().toISOString(),
      });
      state.transcripts[tabId] = [];
      emit(
        'core.chat.task.events',
        {
          kind: 'task',
          workspaceId: seeded.workspaceId,
          worktreeId,
          batchId: randomUUID(),
        },
        (each) =>
          each.scope === 'all' ||
          each.scope?.workspaceId === seeded.workspaceId,
      );
      return ok({ ...receipt, outcome: 'applied' });
    } finally {
      creating.delete(tabId);
    }
  };

  /** The live stream's minor revision, which adds tool items (CAN-6116). */
  const LIVE_EVENTS_REVISION = 2;

  /** Streams the page opens; each answers `{ subscriptionId, acceptedCursor }`. */
  const STREAMS = new Set([
    'core.chat.task.events',
    'core.chat.events',
    'core.chat.live.events',
  ]);

  const open = (method, params) => {
    if (!STREAMS.has(method)) return undefined;
    const subscriptionId = randomUUID();
    subscriptions.set(subscriptionId, { method, params });
    if (method === 'core.chat.live.events') {
      // The live stream opens on its current state: the running turn's reply
      // and its tool calls, or idle when no turn runs. A turn that runs with
      // no reply yet opens with nothing. Tool calls are revision 2 items: as
      // the web core does (chat-live.ts), a stream opened without
      // `revision: 2` gets none.
      const chatId = params.scope?.chatId ?? seeded.rootChatId;
      const revised = params.revision === LIVE_EVENTS_REVISION;
      const live = (
        state.liveTurns[chatId.toLowerCase()] ??
        (activeTurnOf(chatId.toLowerCase()) === undefined
          ? [{ kind: 'idle', chatId }]
          : [])
      ).filter((item) => revised || item.kind !== 'tool');
      // After the open's reply, once the server has bound the subscription.
      setTimeout(() => {
        for (const item of live)
          emit('core.chat.live.events', item, (each) => each === params);
      }, 0);
    }
    return ok({ subscriptionId, acceptedCursor: params.cursor ?? null });
  };

  const same = (value, id) =>
    typeof value === 'string' && value.toLowerCase() === id;
  const heldChat = (chatId) =>
    typeof chatId === 'string' && state.chats.has(chatId.toLowerCase());
  /** The web core finds a chat only inside its own project and task. */
  const chatInTask = (scope, chatId) =>
    same(scope?.workspaceId, seeded.workspaceId) &&
    heldChat(chatId) &&
    same(scope?.worktreeId, state.chats.get(chatId.toLowerCase()).worktreeId);
  const chatNotFound = () => refuse('not_found', 'The chat was not found.');

  /** Not found for a chat or task the seed doesn't hold, as the web core answers. */
  const missing = (method, params) => {
    switch (method) {
      case 'core.chat.snapshot.get':
        return chatInTask(
          params.scope,
          params.chatId ?? params.scope.worktreeId,
        )
          ? null
          : chatNotFound();
      case 'core.chat.transcript.page':
      case 'core.chat.send.receipt':
      case 'core.chat.live.events':
        return chatInTask(params.scope, params.scope.chatId)
          ? null
          : chatNotFound();
      case 'core.chat.message.send':
        return chatInTask(params.scope, params.chatId) ? null : chatNotFound();
      case 'core.chat.events':
        return same(params.scope.projectId, seeded.workspaceId) &&
          isTask(params.scope.worktreeId)
          ? null
          : refuse('not_found', 'The task was not found.');
      case 'worker.filesystem.roots.list':
      case 'worker.filesystem.directory.list':
      case 'worker.filesystem.search':
      case 'worker.filesystem.file.read':
        return heldChat(params.scope.chatId) ? null : chatNotFound();
      default:
        return null;
    }
  };

  /**
   * Served operations answer only requests the web core would serve: params
   * its definition parses, then its own rules. A method with no definition
   * is answered only by `extraAnswers`.
   */
  const call = (method, params = {}) => {
    const request = webCoreRequestSchema(method);
    if (request === undefined) {
      const extra = state.extraAnswers.get(method);
      return extra ? extra(params) : undefined;
    }
    if (!STREAMS.has(method) && !servedMethods().includes(method))
      return undefined;
    const parsed = request.safeParse({
      jsonrpc: '2.0',
      id: 'request',
      method,
      params,
    });
    if (!parsed.success)
      return refuse(
        'invalid_argument',
        `The ${method} params are not valid: ${parsed.error.issues
          .map(
            (issue) => `${issue.path.join('.') || 'params'} ${issue.message}`,
          )
          .join('; ')}`,
      );
    return (
      webCoreRefusal(method, params) ??
      missing(method, params) ??
      open(method, params) ??
      answer(method, params)
    );
  };

  /**
   * The methods the fake serves, as `core.runtime.initialize` reports them:
   * each once, as the web core lists its handler map's keys, also when a spec
   * overrides a served method.
   */
  const servedMethods = () => [
    ...new Set([
      'core.workspace.list',
      'core.chat.task.list',
      'core.chat.snapshot.get',
      'core.chat.list',
      'core.chat.transcript.page',
      'core.chat.message.send',
      'core.chat.send.receipt',
      'core.chat.question.respond',
      'core.chat.turn.cancel',
      'core.chat.create',
      'core.catalog.snapshot.get',
      'core.catalog.selection.get',
      'worker.filesystem.roots.list',
      'worker.filesystem.directory.list',
      'worker.filesystem.search',
      'worker.filesystem.file.read',
      'core.client.lease.acquire',
      'core.client.lease.renew',
      'core.client.lease.release',
      'core.events.ack',
      'core.events.unsubscribe',
      ...state.extraAnswers.keys(),
    ]),
  ];

  /** Replaces a chat's task rows and sends them, as the web core does with each Core batch. */
  const replaceAgentTasks = (chatId, tasks) => {
    state.tasks[chatId] = tasks;
    chatBatch(state.chats.get(chatId).worktreeId, [
      { type: 'agent_tasks.replaced', chatId, tasks },
    ]);
  };

  /**
   * Gives `chatId` a background subagent and a background shell, as Core
   * reports them: the spawn call and the subagent's own row (marked with the
   * call's `parentToolUseId`) in the transcript, both tasks running.
   */
  const startBackgroundAgent = (chatId, { replyCommitted = true } = {}) => {
    const { spawnToolCallId, description, shellDescription } = BACKGROUND_AGENT;
    const at = Date.parse(AT) + 200_000;
    const spawnInput = JSON.stringify({
      description,
      prompt: 'List the config files.',
      subagent_type: 'Explore',
      run_in_background: true,
    });
    const childRow = {
      id: 'e2e-subagent-row',
      role: 'assistant',
      timestamp: at + 1_000,
      parentToolUseId: spawnToolCallId,
      blocks: [{ type: 'text', text: 'I see three config files.' }],
    };
    state.tasks[chatId] = [
      agentTaskRow({
        taskId: 'e2e-task-survey',
        spawnToolCallId,
        description,
        background: true,
      }),
      agentTaskRow({
        taskId: 'e2e-task-shell',
        kind: 'background_shell',
        description: shellDescription,
        native: { toolName: 'Bash' },
        background: true,
      }),
    ];
    if (!replyCommitted) {
      // The subagent writes before its parent's reply commits: its row is
      // in the transcript while the spawn call is only in the running
      // turn's live reply (55ea4e2123a).
      const turnId = 'e2e-spawn-turn';
      const prompt = state.transcripts[chatId].findLast(
        (message) => message.role === 'user',
      );
      state.transcripts[chatId].push(childRow);
      state.activeTurns[chatId] = turnId;
      state.liveTurns[chatId] = [
        {
          kind: 'turn',
          chatId,
          turnId,
          promptMessageId: prompt?.id ?? null,
          text: 'Asking a subagent.',
          reasoning: '',
          state: 'streaming',
        },
        {
          kind: 'tool',
          chatId,
          turnId,
          toolUseId: spawnToolCallId,
          toolName: 'Task',
          input: spawnInput,
          textOffset: 'Asking a subagent.'.length,
        },
      ];
      return;
    }
    state.transcripts[chatId].push(
      {
        id: 'e2e-spawn-row',
        role: 'assistant',
        timestamp: at,
        blocks: [
          { type: 'text', text: 'Asking a subagent.' },
          {
            type: 'tool_use',
            toolUseId: spawnToolCallId,
            toolName: 'Task',
            input: spawnInput,
          },
          {
            type: 'tool_result',
            toolUseId: spawnToolCallId,
            toolName: 'Task',
            output: 'Started in the background.',
            isError: false,
          },
        ],
      },
      childRow,
    );
  };

  return {
    state,
    accountId,
    replaceAgentTasks,
    startBackgroundAgent,
    /** The operation's answer, `{ result }` or `{ error }`; undefined when not served. */
    call,
    /** Delivers every stream item notification to `listener`; returns the unsubscribe. */
    onNotification: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** The methods the fake serves, as `core.runtime.initialize` reports them. */
    served: servedMethods,
    streams: () => [...STREAMS],
    /** The minor revisions `core.runtime.initialize` advertises, as the web core's manifest does. */
    schemaRevisions: () => ({ 'core.chat.live.events': LIVE_EVENTS_REVISION }),
  };
}
