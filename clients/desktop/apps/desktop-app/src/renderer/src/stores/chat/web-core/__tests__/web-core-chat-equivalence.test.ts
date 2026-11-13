/**
 * One recorded `core.chat.*` sequence through the two consumers of the web
 * core's chat protocol (CAN-6175 R3): the web's thread fold
 * (`bindCloudChatThread` over the shared chat store) and the desktop chat
 * store's path (the web core backend under the store's own revisioned sync
 * and reducers). Both must show the same rows, in the same order, with the
 * same running state. When they differ, the desktop translation is wrong.
 */
import { createChatStore, isOptimisticMessage } from '@canopy/app-state';
import {
  bindCloudChatThread,
  type CanopyCoreRelayLikeReply,
  type CoreCoworkInvoker,
  type CoreCoworkStream,
} from '@canopy/app-state/core-cowork';
import { CoreChatMessageSendParamsSchema } from '@canopy/protocol/canopy-core';
import type { ModelCatalogOption } from '@canopy/protocol/models';
import type {
  ChatCommandRequest,
  ChatStateSnapshot,
  CloudChatAttachmentUploadFile,
  PersistedChatMessage,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import { cloudChatCanopyClient } from '@/cloud-chats/cloud-chat-client';
import { chatTabStripLabel } from '@/lib/chatTabLabel';
import { projectCloudChatMessages } from '@/cloud-chats/cloud-chat-threads';
import {
  applyCanonicalChanges,
  applyRuntimeStatusesToTabs,
  preserveRendererOnlyTabFields,
  retireFinishedPendingTurn,
  type CanonicalScopeProjection,
} from '../../canonical-changes';
import { hydratePendingQuestionsFromFile } from '../../pending-questions';
import { fromPersistedTabs } from '../../persisted-tabs';
import { RevisionedChatSync } from '../../revisioned-sync';
import {
  installTranscriptPage,
  needsNewestTranscriptPage,
} from '../../transcript-pages';
import { createLiveFollower } from '../live-follower';
import {
  liveReplyKey,
  presentLiveReplies,
  type LiveChatState,
} from '../live-replies';
import { isPersistedChatMessage } from '../translate';
import { createWebCoreChatBackendCore } from '../web-core-chat-backend';
import {
  cloudAttachmentPath,
  cloudAttachmentPreview,
} from '@/cloud-chats/cloud-chat-attachments';
import { trackSelectionSave } from '../selection-saves';

const WORKSPACE = 'ws-1';
const TASK = 'wt-1';
const CHAT = 'chat-1';
const SCOPE = {
  projectId: `web-core:${WORKSPACE}`,
  worktreeId: `web-core:${TASK}`,
};
const CHAT_KEY = `web-core:${CHAT}`;

const text = (
  id: string,
  role: 'user' | 'assistant',
  body: string,
  timestamp: number,
): Record<string, unknown> => ({
  id,
  role,
  blocks: [{ type: 'text', text: body }],
  timestamp,
});

const U1 = text('u1', 'user', 'hi', 1);
const A1 = text('a1', 'assistant', 'hello', 2);
const U2 = text('u2', 'user', 'next', 3);
const A2 = text('a2', 'assistant', 'Working', 4);
const U3 = text('u3', 'user', 'again', 5);
const A3 = text('a3', 'assistant', 'Done', 6);

/** The web core mints its own message id for each send, by text. */
const SENDS: Record<
  string,
  { turnId: string; messageId: string; revision: number }
> = {
  next: { turnId: 't2', messageId: 'u2', revision: 5 },
  again: { turnId: 't3', messageId: 'u3', revision: 8 },
  same: { turnId: 't4', messageId: 'mine-u', revision: 34 },
  paged: { turnId: 't5', messageId: 'paged-u', revision: 35 },
  deep: { turnId: 't6', messageId: 'deep-u', revision: 61 },
  unlisted: { turnId: 't7', messageId: 'unlisted-u', revision: 62 },
  'after-save': { turnId: 't8', messageId: 'after-save-u', revision: 71 },
  quick: { turnId: 't9', messageId: 'quick-u', revision: 81 },
  slow: { turnId: 't10', messageId: 'slow-u', revision: 82 },
};

/** What the web core holds at each point of the recording. */
const core = {
  revision: 4,
  status: 'idle',
  activeTurnId: undefined as string | undefined,
  messages: [U1, A1],
  /** Holds send replies until released, to let events overtake them. */
  sendGate: null as Promise<void> | null,
  /** Holds snapshot replies until released, to let events land meanwhile. */
  snapshotGate: null as Promise<void> | null,
  /** Holds transcript page replies until released, to let choices land meanwhile. */
  pageGate: null as Promise<void> | null,
  /** Holds `core.chat.update` replies until released; each answers at the revision then. */
  updateGate: null as Promise<void> | null,
  /** Set to make the web core refuse a model change with this reason. */
  setModelRefusal: null as string | null,
  /** The model the snapshot names for the task's chat. */
  model: undefined as string | undefined,
  /** The task's chats, as core.chat.list names them. */
  chats: [{ chatId: CHAT, title: 'Plan', state: 'idle' }] as {
    chatId: string;
    title: string;
    state: string;
  }[],
  /** The running turn of each other chat, which only its own snapshot names. */
  turns: {} as Record<string, string>,
  /** Rows per transcript page. */
  pageSize: 100,
  /** Set to make the web core refuse an archive with this reason. */
  archiveRefusal: null as string | null,
  /** Set to lose every send reply with a retryable failure. */
  sendFailure: false,
  /** Every live chat's unanswered questions, as the task's snapshot carries them. */
  questions: [] as Record<string, unknown>[],
  /** Chats whose questions the snapshot could not read. */
  unreadQuestionChatIds: [] as string[],
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The action fields each web core lifecycle command serves. */
const SERVED_ACTION_FIELDS: Record<string, readonly string[]> = {
  'chat.create_tab': ['type', 'tabId', 'title'],
  'chat.fork_tab': ['type', 'sourceTabId', 'targetTabId'],
  'chat.archive_tab': ['type', 'tabId'],
  'chat.restore_archive': ['type', 'archiveEntryId'],
  'chat.set_model': ['type', 'tabId', 'model', 'providerType'],
  'chat.patch_tab_settings': ['type', 'tabId', 'patch'],
};

const refused = (message: string): CanopyCoreRelayLikeReply => ({
  ok: false,
  error: {
    kind: 'capability_unavailable',
    message,
    retry: { kind: 'never' },
  },
});

/** As the web core's lifecycle handlers check a command before applying it. */
function lifecycle(
  method: string,
  params: Record<string, unknown>,
): CanopyCoreRelayLikeReply {
  const action = isRecord(params.action) ? params.action : null;
  if (
    params.expectedRevision !== undefined ||
    params.expectedTabRevision !== undefined ||
    action === null
  )
    return refused('Revision guards are not served.');
  const fields = Object.keys(action);
  const type = String(action.type);
  const served = SERVED_ACTION_FIELDS[type] ?? [];
  if (fields.some((field) => !served.includes(field)))
    return refused(`${method} does not serve ${fields.join(', ')}.`);
  if (
    action.patch !== undefined &&
    (!isRecord(action.patch) || Object.keys(action.patch).length !== 1)
  )
    return refused('One setting per update.');
  const minted = type === 'chat.create_tab' ? action.tabId : action.targetTabId;
  if (
    minted !== undefined &&
    (typeof minted !== 'string' || !UUID.test(minted))
  )
    return refused('A cloud chat tab id must be a UUID.');
  const entityId = [
    action.tabId,
    action.archiveEntryId,
    action.targetTabId,
  ].find((each): each is string => typeof each === 'string');
  if (type === 'chat.restore_archive')
    core.chats = core.chats.map((chat) =>
      chat.chatId === entityId ? { ...chat, state: 'idle' } : chat,
    );
  // As the web core refuses a model the caller cannot pick: an error reply.
  if (type === 'chat.set_model' && core.setModelRefusal !== null)
    return {
      ok: false,
      error: {
        kind: 'permission_denied',
        message: core.setModelRefusal,
        retry: { kind: 'never' },
      },
    };
  // As the web core refuses an archive it cannot apply: an error reply.
  if (type === 'chat.archive_tab' && core.archiveRefusal !== null)
    return {
      ok: false,
      error: {
        kind: 'failed_precondition',
        message: core.archiveRefusal,
        code: 'core.chat.invalidState',
        details: { reason: 'lifecycle_conflict' },
        retry: { kind: 'after_refresh', resource: 'core.chat.snapshot.get' },
      },
    };
  if (type === 'chat.archive_tab')
    core.chats = core.chats.map((chat) =>
      chat.chatId === entityId ? { ...chat, state: 'archived' } : chat,
    );
  // As the web core's lifecycle handlers answer: a model change or a rename
  // names the revision of the task feed batch it appended (CAN-6346), here
  // the revision it applies at; every other change answers revision 0 and
  // reaches the task's revision through its event.
  const patch = isRecord(action.patch) ? action.patch : {};
  const appended =
    type === 'chat.set_model' ||
    (type === 'chat.patch_tab_settings' && patch.customTitle !== undefined);
  return {
    ok: true,
    value: {
      commandId: params.commandId,
      revision: appended ? core.revision : 0,
      outcome: 'applied',
      ...(entityId === undefined ? {} : { entityId }),
    },
  };
}

/** The ids the desktop sends under, and the ids the web core mints for them. */
const STORE_TO_CORE: Record<string, string> = {
  'desktop-next': 'u2',
  'desktop-again': 'u3',
};

/** As the web core refuses what its transcript page does not serve. */
const UNSERVED_PAGE_PARAMS = ['cursor', 'view', 'turnId'];

function snapshot(chatId?: unknown): Record<string, unknown> {
  if (typeof chatId === 'string' && chatId !== CHAT)
    return {
      ...snapshot(),
      runtimeByChatId: {
        [chatId]: {
          status: 'streaming',
          queuedMessageIds: [],
          ...(core.turns[chatId] === undefined
            ? {}
            : { activeTurnId: core.turns[chatId] }),
        },
      },
    };
  return {
    workspaceId: WORKSPACE,
    worktreeId: TASK,
    revision: core.revision,
    eventsCursor: { daemonEpoch: 'e1', sequence: core.revision },
    tabs: {
      activeTabId: CHAT,
      items: [
        {
          chatId: CHAT,
          title: 'Plan',
          kind: 'chat',
          createdAt: '2026-11-10T00:00:00.000Z',
          ...(core.model === undefined ? {} : { modelId: core.model }),
        },
      ],
    },
    archives: [],
    ...(core.questions.length === 0
      ? {}
      : { pendingQuestions: core.questions }),
    ...(core.unreadQuestionChatIds.length === 0
      ? {}
      : { unreadQuestionChatIds: core.unreadQuestionChatIds }),
    runtimeByChatId: {
      [CHAT]: {
        status: core.status,
        queuedMessageIds: [],
        ...(core.activeTurnId === undefined
          ? {}
          : { activeTurnId: core.activeTurnId }),
      },
    },
    queue: [],
  };
}

function batch(
  baseRevision: number,
  revision: number,
  changes: Record<string, unknown>[],
): Record<string, unknown> {
  return {
    kind: 'item',
    cursor: { daemonEpoch: 'e1', sequence: revision },
    item: {
      schemaVersion: 1,
      eventId: `ev-${revision}`,
      occurredAt: '2026-11-10T00:00:00.000Z',
      projectId: WORKSPACE,
      worktreeId: TASK,
      baseRevision,
      revision,
      changes,
    },
  };
}

const liveFrame = (item: Record<string, unknown>): Record<string, unknown> => ({
  kind: 'item',
  cursor: null,
  item: { chatId: CHAT, ...item },
});

type StreamRead = { done: true } | { done: false; value: unknown };

function controlledStream(): CoreCoworkStream & { push(frame: unknown): void } {
  const reads: StreamRead[] = [];
  let waiting: ((read: StreamRead) => void) | null = null;
  let closed = false;
  return {
    push(frame: unknown): void {
      const read: StreamRead = { done: false, value: frame };
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve(read);
      } else reads.push(read);
    },
    next(): Promise<StreamRead> {
      if (closed) return Promise.resolve({ done: true });
      const read = reads.shift();
      if (read) return Promise.resolve(read);
      return new Promise((resolve) => {
        waiting = resolve;
      });
    },
    close(): Promise<void> {
      closed = true;
      waiting?.({ done: true });
      waiting = null;
      return Promise.resolve();
    },
  };
}

interface Side {
  readonly invoker: CoreCoworkInvoker;
  readonly calls: { method: string; params: Record<string, unknown> }[];
  /** The newest open stream of each method. */
  readonly latest: Map<string, ReturnType<typeof controlledStream>>;
}

function side(): Side {
  const calls: Side['calls'] = [];
  const latest: Side['latest'] = new Map();
  const ok = (value: unknown): CanopyCoreRelayLikeReply => ({
    ok: true,
    value,
  });
  return {
    calls,
    latest,
    invoker: {
      request: (method, params) => {
        calls.push({ method, params });
        switch (method) {
          case 'core.chat.snapshot.get': {
            const reply = ok(snapshot(params.chatId));
            return (core.snapshotGate ?? Promise.resolve()).then(() => reply);
          }
          case 'core.chat.transcript.page':
            if (UNSERVED_PAGE_PARAMS.some((name) => params[name] !== undefined))
              return Promise.resolve({
                ok: false,
                error: {
                  kind: 'capability_unavailable',
                  message: 'Not served here.',
                  retry: { kind: 'never' },
                },
              });
            {
              const end =
                typeof params.before === 'number'
                  ? params.before
                  : core.messages.length;
              const start = Math.max(0, end - core.pageSize);
              const reply = ok({
                messages: core.messages.slice(start, end),
                totalMessages: core.messages.length,
                transcriptRevision: core.revision,
                ...(start > 0 ? { before: start } : {}),
              });
              return (core.pageGate ?? Promise.resolve()).then(() => reply);
            }
          case 'core.chat.message.send': {
            if (core.sendFailure)
              return Promise.resolve({
                ok: false,
                error: {
                  kind: 'unavailable',
                  message: 'The reply was lost.',
                  retry: { kind: 'same_idempotency_key' },
                },
              });
            const sent = SENDS[String(params.text)];
            if (sent === undefined) throw new Error('unexpected send');
            const reply = ok({
              commandId: params.commandId,
              revision: sent.revision,
              outcome: 'applied',
              entityId: sent.turnId,
              messageId: sent.messageId,
            });
            return (core.sendGate ?? Promise.resolve()).then(() => reply);
          }
          case 'core.chat.turn.cancel':
            return Promise.resolve(ok({}));
          case 'core.chat.send.receipt':
            return Promise.resolve(ok({ outcome: 'missing' }));
          case 'core.chat.list':
            return Promise.resolve(
              ok({
                items: core.chats.map((chat) => ({
                  ...chat,
                  workspaceId: WORKSPACE,
                  worktreeId: TASK,
                  revision: core.revision,
                  createdAt: '2026-11-10T00:00:00.000Z',
                })),
                nextCursor: null,
              }),
            );
          case 'core.chat.update':
            return (core.updateGate ?? Promise.resolve()).then(() =>
              lifecycle(method, params),
            );
          case 'core.chat.create':
          case 'core.chat.archive':
          case 'core.chat.fork':
            return Promise.resolve(lifecycle(method, params));
          default:
            throw new Error(`unexpected ${method}`);
        }
      },
      openStream: (method) => {
        const stream = controlledStream();
        latest.set(method, stream);
        return Promise.resolve(stream);
      },
    },
  };
}

/** Each path's teardown, so no stream outlives its test. */
const closers: (() => void)[] = [];

afterEach(() => {
  for (const close of closers.splice(0)) close();
  core.updateGate = null;
  core.setModelRefusal = null;
  core.model = undefined;
});

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

interface Row {
  readonly id: string;
  readonly role: string;
  readonly text: string;
  readonly provisional: boolean;
}

interface Shown {
  readonly rows: Row[];
  readonly running: boolean;
}

function persistedText(message: PersistedChatMessage): string {
  return message.blocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('');
}

/** The web: the thread fold writing the shared chat store. */
function webPath(io: Side): {
  readonly shown: () => Shown;
  readonly send: (text: string) => Promise<void>;
  readonly stop: () => Promise<void>;
} {
  const store = createChatStore(cloudChatCanopyClient);
  let ids = 0;
  const thread = bindCloudChatThread({
    invoker: io.invoker,
    target: {
      key: CHAT_KEY,
      workspaceId: WORKSPACE,
      worktreeId: TASK,
      chatId: CHAT,
    },
    chatStore: store,
    project: projectCloudChatMessages,
    newId: () => `web-${(ids += 1)}`,
    reopenDelayMs: 0,
    liveReopenDelayMs: 0,
    liveHoldMs: 60_000,
  });
  thread.setLive(true);
  closers.push(() => thread.close());
  const live = `${CHAT_KEY}:live:`;
  return {
    shown: () => {
      const thread = store.getState().threads[CHAT_KEY];
      return {
        rows: (thread?.messages ?? []).map((message) => ({
          id: message.messageId.startsWith(live)
            ? `live:${message.messageId.slice(live.length)}`
            : message.messageId,
          role: message.role,
          text: message.text,
          provisional:
            message.messageId.startsWith(live) || isOptimisticMessage(message),
        })),
        running: thread?.turnActive === true,
      };
    },
    send: async (body) => {
      store.getState().addOptimisticUserMessage(CHAT_KEY, {
        text: body,
        createdAtMs: Date.now(),
        localId: `optimistic-${body}`,
      });
      await thread.send({
        text: body,
        optimisticLocalId: `optimistic-${body}`,
      });
    },
    stop: () => thread.stop(),
  };
}

/**
 * The desktop: the web core backend under the store's own revisioned sync,
 * snapshot install, change reducer and transcript page install.
 */
function desktopPath(
  io: Side,
  options: { readonly liveHoldMs?: number; readonly echoWaitMs?: number } = {},
): {
  readonly backend: ReturnType<typeof createWebCoreChatBackendCore>;
  /** The task's tabs and archive rows as the store holds them. */
  readonly tabs: () => { id: string; status?: string }[];
  readonly activeTabId: () => string | undefined;
  /** A tab's model as the store holds it. */
  readonly model: (id: string) => string | undefined;
  /** A tab's read state as the store holds it. */
  readonly read: (id: string) => { unread: boolean; manual: boolean };
  /** A tab's label as the tab strip shows it. */
  readonly label: (id: string) => string | undefined;
  /** Whether the store holds the chat's transcript as stale. */
  readonly stale: () => boolean;
  readonly archives: () => string[];
  readonly shown: () => Shown;
  /** The ids the store holds, before mapping them to the web core's. */
  readonly storeIds: () => string[];
  /** The questions the store holds for the composer's question card. */
  readonly questions: () => {
    requestId: string;
    chatId: string;
    questions: unknown[];
    toolUseId?: string;
  }[];
  readonly send: (text: string) => Promise<void>;
  readonly stop: () => Promise<void>;
} {
  let live: LiveChatState = { replies: [], turnRuns: false };
  const backend = createWebCoreChatBackendCore({
    invoker: () => io.invoker,
    newId: () => crypto.randomUUID(),
    reopenDelayMs: 0,
    liveReopenDelayMs: 0,
    liveHoldMs: options.liveHoldMs ?? 60_000,
    ...(options.echoWaitMs === undefined
      ? {}
      : { echoWaitMs: options.echoWaitMs }),
    publishLive: (_key, chat) => {
      live = chat;
    },
  });
  let projection: CanonicalScopeProjection | null = null;

  async function loadPages(): Promise<void> {
    if (projection === null) return;
    const tabs = await Promise.all(
      projection.chatState.tabs.map(async (tab) =>
        tab.transcriptLoaded === false
          ? installTranscriptPage(
              tab,
              // The store's loader asks for the turn view.
              await backend.getTranscriptPage({
                ...SCOPE,
                chatId: tab.id,
                view: 'turns',
              }),
              false,
            )
          : tab,
      ),
    );
    projection = {
      ...projection,
      chatState: { ...projection.chatState, tabs },
    };
  }

  const sync = new RevisionedChatSync(
    { getState: backend.getState },
    {
      installSnapshot: (state: ChatStateSnapshot, context): void => {
        const chatState = fromPersistedTabs(
          state.tabsFile,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          true,
          undefined,
          undefined,
          false,
        );
        chatState.tabs = applyRuntimeStatusesToTabs(
          chatState.tabs,
          state.runtimeByChatId,
        );
        // As the store installs a refresh: a body-less tab keeps its rows.
        const previous = projection?.chatState.tabs ?? [];
        if (context.reason === 'refresh')
          chatState.tabs = applyRuntimeStatusesToTabs(
            chatState.tabs.map((tab) =>
              preserveRendererOnlyTabFields(
                previous.find((each) => each.id === tab.id),
                tab,
              ),
            ),
            state.runtimeByChatId,
          );
        projection = {
          chatState,
          archives: state.archives,
          runtimeByChatId: state.runtimeByChatId,
          pendingQuestions: hydratePendingQuestionsFromFile(
            state.tabsFile,
            SCOPE.projectId,
            SCOPE.worktreeId,
            chatState,
          ),
        };
        void loadPages();
      },
      applyCommittedEvent: (event): void => {
        if (projection === null) return;
        projection = applyCanonicalChanges(projection, event.changes, SCOPE);
        if (
          event.changes.some(
            (change) => change.type === 'transcript.updated' && change.reset,
          )
        )
          void loadPages();
      },
      onTrackedScopesChanged: (scopes): void => {
        void backend.setStateScopes({ kind: 'scopes', scopes });
      },
    },
  );
  backend.onStateChanged((event) => sync.handleEvent(event));
  closers.push(() => backend.closeAll());
  void sync.hydrate(SCOPE.projectId, SCOPE.worktreeId);
  backend.setLiveChats([{ ...SCOPE, chatId: CHAT_KEY }]);

  return {
    backend,
    tabs: () =>
      (projection?.chatState.tabs ?? []).map((tab) => ({
        id: tab.id,
        status: tab.status,
      })),
    activeTabId: () => projection?.chatState.activeTabId,
    model: (id) =>
      projection?.chatState.tabs.find((each) => each.id === id)?.model,
    read: (id) => {
      const tab = projection?.chatState.tabs.find((each) => each.id === id);
      return {
        unread: tab?.unread === true,
        manual: tab?.unreadMarkedManually === true,
      };
    },
    label: (id) => {
      const tab = projection?.chatState.tabs.find((each) => each.id === id);
      return tab === undefined ? undefined : chatTabStripLabel(tab);
    },
    stale: () =>
      projection?.chatState.tabs.find((each) => each.id === CHAT_KEY)
        ?.transcriptStale === true,
    archives: () => (projection?.archives ?? []).map((entry) => entry.chatId),
    storeIds: () =>
      (
        projection?.chatState.tabs.find((each) => each.id === CHAT_KEY)
          ?.messages ?? []
      ).map((message) => message.id),
    questions: () =>
      Object.values(projection?.pendingQuestions ?? {}).map((pending) => ({
        requestId: pending.requestId,
        chatId: pending.chatId,
        questions: pending.questions,
        ...(pending.toolUseId === undefined
          ? {}
          : { toolUseId: pending.toolUseId }),
      })),
    shown: () => {
      const tab = projection?.chatState.tabs.find(
        (each) => each.id === CHAT_KEY,
      );
      const committed = tab?.messages ?? [];
      const provisional = presentLiveReplies(
        live.replies,
        committed,
        live.turnRuns,
      );
      return {
        rows: [...committed, ...provisional].map((message) => ({
          id: STORE_TO_CORE[message.id] ?? message.id,
          role: message.role,
          text: persistedText(message),
          provisional: message.id.startsWith('live:'),
        })),
        running: tab?.status === 'streaming',
      };
    },
    send: async (body) => {
      await backend.sendMessage({
        ...SCOPE,
        chatId: CHAT_KEY,
        userMessageId: `desktop-${body}`,
        text: body,
      });
    },
    stop: async () => {
      await backend.cancel({ ...SCOPE, chatId: CHAT_KEY });
    },
  };
}

it('the web fold and the desktop store show one recorded cloud chat the same way', async () => {
  const webIo = side();
  const desktopIo = side();
  const web = webPath(webIo);
  const desktop = desktopPath(desktopIo);
  const both = (frame: unknown, method = 'core.chat.events'): void => {
    for (const io of [webIo, desktopIo]) io.latest.get(method)?.push(frame);
  };
  await settle();

  // The snapshot and the newest transcript page.
  expect(desktop.shown()).toEqual(web.shown());
  expect(web.shown().rows.map((row) => row.id)).toEqual(['u1', 'a1']);

  // An optimistic send the receipt reconciles: its turn can be stopped
  // before the web core reports it, and the user row shows once.
  await web.send('next');
  await desktop.send('next');
  await web.stop();
  await desktop.stop();
  for (const io of [webIo, desktopIo])
    expect(
      io.calls
        .filter((call) => call.method === 'core.chat.turn.cancel')
        .map((call) => call.params.turnId),
    ).toEqual(['t2']);
  core.revision = 5;
  core.status = 'streaming';
  core.activeTurnId = 't2';
  core.messages = [U1, A1, U2];
  both(
    batch(4, 5, [
      { type: 'message.upserted', chatId: CHAT, message: U2 },
      {
        type: 'runtime.patched',
        chatId: CHAT,
        runtime: {
          status: 'streaming',
          queuedMessageIds: [],
          activeTurnId: 't2',
        },
      },
    ]),
  );
  await settle();
  expect(desktop.shown()).toEqual(web.shown());
  expect(web.shown()).toEqual({
    rows: [
      { id: 'u1', role: 'user', text: 'hi', provisional: false },
      { id: 'a1', role: 'assistant', text: 'hello', provisional: false },
      { id: 'u2', role: 'user', text: 'next', provisional: false },
    ],
    running: true,
  });
  // The store keeps the id it sent under, so its optimistic row retires.
  expect(desktop.storeIds()).toEqual(['u1', 'a1', 'desktop-next']);

  // The live reply, as a whole turn and an append, shows after the transcript.
  both(
    liveFrame({
      kind: 'turn',
      turnId: 't2',
      promptMessageId: 'u2',
      text: 'Wor',
      reasoning: '',
      state: 'streaming',
    }),
    'core.chat.live.events',
  );
  both(
    liveFrame({
      kind: 'append',
      turnId: 't2',
      textOffset: 3,
      text: 'king',
      reasoningOffset: 0,
      reasoning: '',
    }),
    'core.chat.live.events',
  );
  await settle();
  expect(desktop.shown()).toEqual(web.shown());
  expect(web.shown().rows.at(-1)).toEqual({
    id: 'live:t2',
    role: 'assistant',
    text: 'Working',
    provisional: true,
  });

  // The reply finishes under its committed id, then a batch that skips a
  // revision makes both read the snapshot and transcript again. The web
  // core parks the idle session as awaiting input, with no turn.
  both(
    liveFrame({
      kind: 'turn',
      turnId: 't2',
      promptMessageId: 'u2',
      text: 'Working',
      reasoning: '',
      state: 'finished',
      messageId: 'a2',
    }),
    'core.chat.live.events',
  );
  await settle();
  expect(desktop.shown()).toEqual(web.shown());
  core.revision = 7;
  core.status = 'awaiting_input';
  core.activeTurnId = undefined;
  core.messages = [U1, A1, U2, A2];
  both(
    batch(6, 7, [
      {
        type: 'runtime.patched',
        chatId: CHAT,
        runtime: { status: 'awaiting_input', queuedMessageIds: [] },
      },
    ]),
  );
  await settle();
  expect(desktop.shown()).toEqual(web.shown());
  expect(web.shown()).toEqual({
    rows: [
      { id: 'u1', role: 'user', text: 'hi', provisional: false },
      { id: 'a1', role: 'assistant', text: 'hello', provisional: false },
      { id: 'u2', role: 'user', text: 'next', provisional: false },
      { id: 'a2', role: 'assistant', text: 'Working', provisional: false },
    ],
    running: false,
  });

  // A send whose message and whole turn reach the events before its reply:
  // the turn has ended, so neither shows it running once the reply lands.
  let release = (): void => undefined;
  core.sendGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sends = [web.send('again'), desktop.send('again')];
  await settle();
  core.revision = 9;
  core.messages = [U1, A1, U2, A2, U3];
  both(
    batch(7, 8, [
      { type: 'message.upserted', chatId: CHAT, message: U3 },
      {
        type: 'runtime.patched',
        chatId: CHAT,
        runtime: {
          status: 'streaming',
          queuedMessageIds: [],
          activeTurnId: 't3',
        },
      },
    ]),
  );
  both(
    batch(8, 9, [
      {
        type: 'runtime.patched',
        chatId: CHAT,
        runtime: { status: 'awaiting_input', queuedMessageIds: [] },
      },
    ]),
  );
  await settle();
  release();
  core.sendGate = null;
  await Promise.all(sends);
  await settle();
  expect(desktop.shown()).toEqual(web.shown());
  expect(web.shown().running).toBe(false);
  expect(desktop.storeIds().at(-1)).toBe('desktop-again');

  // The events cursor outlived what the web core keeps: both read the
  // snapshot again and show what changed meanwhile.
  core.revision = 11;
  core.messages = [U1, A1, U2, A2, U3, A3];
  both({
    kind: 'end',
    cursor: null,
    outcome: 'error',
    error: {
      kind: 'failed_precondition',
      code: 'core.chat.snapshotRequired',
      message: 'Read the snapshot again.',
      retry: { kind: 'never' },
    },
  });
  await settle();
  expect(desktop.shown()).toEqual(web.shown());
  expect(web.shown()).toEqual({
    rows: [
      { id: 'u1', role: 'user', text: 'hi', provisional: false },
      { id: 'a1', role: 'assistant', text: 'hello', provisional: false },
      { id: 'u2', role: 'user', text: 'next', provisional: false },
      { id: 'a2', role: 'assistant', text: 'Working', provisional: false },
      { id: 'u3', role: 'user', text: 'again', provisional: false },
      { id: 'a3', role: 'assistant', text: 'Done', provisional: false },
    ],
    running: false,
  });
});

it("the desktop store runs a cloud task's tabs through what the web core serves", async () => {
  core.revision = 20;
  core.status = 'idle';
  core.activeTurnId = undefined;
  core.messages = [U1];
  core.chats = [
    { chatId: CHAT, title: 'Plan', state: 'idle' },
    { chatId: 'chat-2', title: 'Notes', state: 'running' },
    { chatId: 'chat-3', title: 'Old', state: 'archived' },
  ];
  const io = side();
  const desktop = desktopPath(io);
  await settle();

  // Every chat of the task, not only the one the snapshot opens.
  expect(desktop.tabs()).toEqual([
    { id: CHAT_KEY, status: 'idle' },
    { id: 'web-core:chat-2', status: 'streaming' },
  ]);
  expect(desktop.archives()).toEqual(['web-core:chat-3']);

  const envelope = (
    command: ChatCommandRequest['command'],
  ): ChatCommandRequest => ({
    schemaVersion: 1,
    commandId: `cmd-${command.type}`,
    ...SCOPE,
    expectedRevision: core.revision,
    command,
  });
  const sent = (): { method: string; action: unknown }[] =>
    io.calls
      .filter((call) => call.params.action !== undefined)
      .map((call) => ({ method: call.method, action: call.params.action }));

  // Switching tabs stays in the window: the web core holds no active tab.
  await expect(
    desktop.backend.command(
      envelope({ type: 'chat.activate_tab', tabId: 'web-core:chat-2' }),
    ),
  ).resolves.toMatchObject({ outcome: 'applied' });
  expect(sent()).toEqual([]);

  // Rename and a store-minted new tab carry only what the web core serves.
  await desktop.backend.command(
    envelope({
      type: 'chat.patch_tab_settings',
      tabId: 'web-core:chat-2',
      patch: { customTitle: 'Renamed' },
    }),
  );
  const created = await desktop.backend.command(
    envelope({
      type: 'chat.create_tab',
      tabId: 'chat-7-123',
      title: 'New',
      model: 'claude-sonnet',
      providerType: 'claude',
    }),
  );
  expect(created).toMatchObject({ outcome: 'applied', entityId: 'chat-7-123' });
  const minted = sent()[1]?.action;
  const mintedId = isRecord(minted) ? String(minted.tabId) : '';
  expect(mintedId).toMatch(UUID);
  expect(sent()).toEqual([
    {
      method: 'core.chat.update',
      action: {
        type: 'chat.patch_tab_settings',
        tabId: 'chat-2',
        patch: { customTitle: 'Renamed' },
      },
    },
    {
      method: 'core.chat.create',
      action: {
        type: 'chat.create_tab',
        tabId: mintedId,
        title: 'New',
      },
    },
  ]);
  // The new chat comes back under the store's own id.
  io.latest.get('core.chat.events')?.push(
    batch(20, 21, [
      {
        type: 'tab.upserted',
        tab: {
          id: mintedId,
          title: 'New',
          messages: [],
          createdAt: '2026-11-10T00:00:00.000Z',
        },
      },
    ]),
  );
  await settle();
  expect(desktop.tabs().map((tab) => tab.id)).toEqual([
    CHAT_KEY,
    'web-core:chat-2',
    'chat-7-123',
  ]);

  // Closing archives; a hard delete is refused before any request.
  await desktop.backend.command(
    envelope({ type: 'chat.close_tab', tabId: 'chat-7-123', mode: 'archive' }),
  );
  expect(sent().at(-1)).toEqual({
    method: 'core.chat.archive',
    action: { type: 'chat.archive_tab', tabId: mintedId },
  });
  const before = sent().length;
  await expect(
    desktop.backend.command(
      envelope({
        type: 'chat.close_tab',
        tabId: 'web-core:chat-2',
        mode: 'discard',
      }),
    ),
  ).rejects.toMatchObject({ code: 'capability_unavailable' });
  expect(sent()).toHaveLength(before);

  // A cloud fork starts a new task, and closing the task's own chat would
  // archive the whole task: both are refused before any request.
  const beforeRefusals = sent().length;
  await expect(
    desktop.backend.command(
      envelope({
        type: 'chat.fork_tab',
        sourceTabId: 'web-core:chat-2',
        targetTabId: 'chat-8-456',
      }),
    ),
  ).rejects.toMatchObject({ code: 'capability_unavailable' });
  await expect(
    desktop.backend.command(
      envelope({
        type: 'chat.close_tab',
        tabId: `web-core:${TASK}`,
        mode: 'archive',
      }),
    ),
  ).rejects.toMatchObject({ code: 'capability_unavailable' });
  expect(sent()).toHaveLength(beforeRefusals);

  // Only the task's own chat restores alone; a tab comes back with its task.
  await expect(desktop.backend.loadArchives(SCOPE)).resolves.toEqual([
    expect.objectContaining({ chatId: 'web-core:chat-3', restorable: false }),
  ]);

  // ...and restoring it alone is refused before any request.
  const beforeRestore = sent().length;
  await expect(
    desktop.backend.restoreArchive({ ...SCOPE, chatId: 'web-core:chat-3' }),
  ).rejects.toMatchObject({ code: 'capability_unavailable' });
  expect(sent()).toHaveLength(beforeRestore);
});

it('the desktop store stops a running sibling chat and clears a dropped live reply', async () => {
  core.revision = 30;
  core.status = 'streaming';
  core.activeTurnId = 't9';
  core.messages = [U1];
  core.chats = [
    { chatId: CHAT, title: 'Plan', state: 'running' },
    { chatId: 'chat-2', title: 'Notes', state: 'running' },
    { chatId: 'chat-4', title: 'Draft', state: 'running' },
  ];
  core.turns = { 'chat-2': 't7', 'chat-4': 'old-4' };
  const io = side();
  const desktop = desktopPath(io, { liveHoldMs: 20 });
  await settle();

  // The list names no turn for the sibling: Stop reads it from its snapshot.
  await expect(
    desktop.backend.cancel({ ...SCOPE, chatId: 'web-core:chat-2' }),
  ).resolves.toEqual({ outcome: 'stop_requested' });
  expect(
    io.calls
      .filter((call) => call.method === 'core.chat.turn.cancel')
      .map((call) => call.params),
  ).toEqual([{ chatId: 'chat-2', turnId: 't7', reason: 'user' }]);

  // A turn that starts while a snapshot is read keeps its newer state.
  let releaseSnapshot = (): void => undefined;
  core.snapshotGate = new Promise<void>((resolve) => {
    releaseSnapshot = resolve;
  });
  const reading = desktop.backend.getState(SCOPE);
  await settle();
  io.latest.get('core.chat.events')?.push(
    batch(30, 31, [
      {
        type: 'runtime.patched',
        chatId: 'chat-2',
        runtime: {
          status: 'streaming',
          queuedMessageIds: [],
          activeTurnId: 't11',
        },
      },
    ]),
  );
  await settle();
  releaseSnapshot();
  core.snapshotGate = null;
  await reading;
  await desktop.backend.cancel({ ...SCOPE, chatId: 'web-core:chat-2' });
  expect(
    io.calls
      .filter((call) => call.method === 'core.chat.turn.cancel')
      .map((call) => call.params.turnId),
  ).toEqual(['t7', 't11']);

  // A partial reply whose stream ends before its finish frame clears once
  // its turn stops.
  io.latest.get('core.chat.live.events')?.push(
    liveFrame({
      kind: 'turn',
      turnId: 't9',
      promptMessageId: 'u1',
      text: 'Half',
      reasoning: '',
      state: 'streaming',
    }),
  );
  await settle();
  expect(desktop.shown().rows.at(-1)).toMatchObject({
    id: 'live:t9',
    provisional: true,
  });
  io.latest.get('core.chat.live.events')?.push({
    kind: 'end',
    cursor: null,
    outcome: 'error',
    error: { kind: 'unavailable', message: 'Gone.', retry: { kind: 'never' } },
  });
  core.revision = 32;
  core.status = 'idle';
  core.activeTurnId = undefined;
  io.latest.get('core.chat.events')?.push(
    batch(31, 32, [
      {
        type: 'runtime.patched',
        chatId: CHAT,
        runtime: { status: 'idle', queuedMessageIds: [] },
      },
    ]),
  );
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 40));
  await settle();
  expect(desktop.shown()).toEqual({
    rows: [{ id: 'u1', role: 'user', text: 'hi', provisional: false }],
    running: false,
  });

  // Another client's identical message keeps its own id; this send's message
  // takes the store's id from its receipt, not from its text.
  let release = (): void => undefined;
  core.sendGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  core.revision = 34;
  const sending = desktop.backend.sendMessage({
    ...SCOPE,
    chatId: CHAT_KEY,
    userMessageId: 'desktop-same',
    text: 'same',
  });
  await settle();
  io.latest.get('core.chat.events')?.push(
    batch(32, 33, [
      {
        type: 'message.upserted',
        chatId: CHAT,
        message: text('other-u', 'user', 'same', 7),
      },
    ]),
  );
  io.latest.get('core.chat.events')?.push(
    batch(33, 34, [
      {
        type: 'message.upserted',
        chatId: CHAT,
        message: text('mine-u', 'user', 'same', 8),
      },
    ]),
  );
  await settle();
  release();
  core.sendGate = null;
  await sending;
  await settle();
  expect(desktop.storeIds()).toEqual(['u1', 'other-u', 'desktop-same']);

  // Stop's own turn read keeps a turn an event reported while it read.
  let releaseTurnRead = (): void => undefined;
  core.snapshotGate = new Promise<void>((resolve) => {
    releaseTurnRead = resolve;
  });
  const stopping = desktop.backend.cancel({
    ...SCOPE,
    chatId: 'web-core:chat-4',
  });
  await settle();
  io.latest.get('core.chat.events')?.push(
    batch(34, 35, [
      {
        type: 'runtime.patched',
        chatId: 'chat-4',
        runtime: {
          status: 'streaming',
          queuedMessageIds: [],
          activeTurnId: 'new-4',
        },
      },
    ]),
  );
  await settle();
  releaseTurnRead();
  core.snapshotGate = null;
  await stopping;
  expect(
    io.calls
      .filter((call) => call.method === 'core.chat.turn.cancel')
      .map((call) => call.params.turnId)
      .at(-1),
  ).toBe('new-4');

  // A transcript page read while a send is in flight names its message by
  // the store's id, so the optimistic row never sits beside it.
  let releaseSend = (): void => undefined;
  core.sendGate = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  const pending = desktop.backend.sendMessage({
    ...SCOPE,
    chatId: CHAT_KEY,
    userMessageId: 'desktop-paged',
    text: 'paged',
  });
  core.messages = [U1, text('paged-u', 'user', 'paged', 9)];
  const paging = desktop.backend.getTranscriptPage({
    ...SCOPE,
    chatId: CHAT_KEY,
  });
  await settle();
  releaseSend();
  core.sendGate = null;
  await pending;
  expect((await paging).messages.map((message) => message.id)).toEqual([
    'u1',
    'desktop-paged',
  ]);
});

it('the desktop store retires a cloud turn that ends with its prompt committed', () => {
  const prompt = text('desktop-p', 'user', 'go', 1);
  const timer = { id: 'timer-p', role: 'system', blocks: [], timestamp: 1 };
  const chatState = fromPersistedTabs(
    {
      version: 1,
      activeTabId: CHAT_KEY,
      tabs: [
        {
          id: CHAT_KEY,
          title: 'Plan',
          createdAt: '2026-11-10T00:00:00.000Z',
          messages: [],
        },
      ],
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    true,
    undefined,
    undefined,
    false,
  );
  const [tab] = chatState.tabs;
  if (
    tab === undefined ||
    !isPersistedChatMessage(timer) ||
    !isPersistedChatMessage(prompt)
  )
    throw new Error('no tab');
  // As a send leaves the tab: the optimistic prompt and its timer.
  chatState.tabs = [
    {
      ...tab,
      messages: [prompt, timer],
      pendingUserMessages: [prompt],
      pendingTurn: { userMessageId: 'desktop-p', timerMessage: timer },
    },
  ];
  const idle = {
    type: 'runtime.patched' as const,
    chatId: CHAT_KEY,
    runtime: { status: 'idle' as const, queuedMessageIds: [] },
  };
  // A stale idle before the prompt's echo keeps the pending turn and timer.
  const early = applyCanonicalChanges(
    { chatState, archives: [], runtimeByChatId: {}, pendingQuestions: {} },
    [idle],
    SCOPE,
  ).chatState.tabs[0];
  expect(early?.pendingTurn?.userMessageId).toBe('desktop-p');
  expect(early?.messages.map((message) => message.id)).toEqual([
    'desktop-p',
    'timer-p',
  ]);
  const next = applyCanonicalChanges(
    { chatState, archives: [], runtimeByChatId: {}, pendingQuestions: {} },
    [
      ...(isPersistedChatMessage(prompt)
        ? [
            {
              type: 'message.upserted' as const,
              chatId: CHAT_KEY,
              message: prompt,
            },
          ]
        : []),
      {
        type: 'runtime.patched',
        chatId: CHAT_KEY,
        runtime: { status: 'idle', queuedMessageIds: [] },
      },
    ],
    SCOPE,
  );
  const settled = next.chatState.tabs[0];
  expect(settled?.pendingTurn).toBeUndefined();
  expect(settled?.messages.map((message) => message.id)).toEqual(['desktop-p']);

  // A snapshot that holds the committed prompt and answer with an idle
  // runtime retires the pending turn too, as a refresh installs it.
  const answer = text('answer-p', 'assistant', 'done', 2);
  if (!isPersistedChatMessage(answer)) throw new Error('no answer');
  const [canonical] = fromPersistedTabs(
    {
      version: 1,
      activeTabId: CHAT_KEY,
      tabs: [
        {
          id: CHAT_KEY,
          title: 'Plan',
          createdAt: '2026-11-10T00:00:00.000Z',
          messages: [prompt, answer],
        },
      ],
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    true,
    undefined,
    undefined,
    false,
  ).tabs;
  const [sent] = chatState.tabs;
  if (canonical === undefined || sent === undefined) throw new Error('no tab');
  const [refreshed] = applyRuntimeStatusesToTabs(
    [preserveRendererOnlyTabFields(sent, canonical)],
    { [CHAT_KEY]: { status: 'idle', queuedMessageIds: [] } },
  );
  expect(refreshed?.pendingTurn).toBeUndefined();
  expect(refreshed?.messages.map((message) => message.id)).toEqual([
    'desktop-p',
    'answer-p',
  ]);

  // So does a transcript page that brings the prompt's echo after its turn
  // went idle, as the store's loader installs it.
  const paged = retireFinishedPendingTurn(
    installTranscriptPage(
      sent,
      {
        messages: [prompt, answer],
        totalMessages: 2,
        transcriptRevision: 9,
      },
      false,
    ),
    { status: 'idle', queuedMessageIds: [] },
  );
  expect(paged.pendingTurn).toBeUndefined();
  expect(paged.messages.map((message) => message.id)).toEqual([
    'desktop-p',
    'answer-p',
  ]);
});

it('the desktop store recovers missed cloud messages, keeps tab choices and a refused archive, and pages back', async () => {
  core.revision = 40;
  core.status = 'idle';
  core.activeTurnId = undefined;
  core.messages = [U1, A1];
  core.chats = [
    { chatId: CHAT, title: 'Plan', state: 'idle' },
    { chatId: 'chat-2', title: 'Notes', state: 'idle' },
  ];
  const io = side();
  const desktop = desktopPath(io);
  await settle();
  expect(desktop.storeIds()).toEqual(['u1', 'a1']);

  // The window's own tab choices outlive the next snapshot.
  const local = (
    command: ChatCommandRequest['command'],
  ): ChatCommandRequest => ({
    schemaVersion: 1,
    commandId: crypto.randomUUID(),
    ...SCOPE,
    command,
  });
  await desktop.backend.command(
    local({ type: 'chat.activate_tab', tabId: 'web-core:chat-2' }),
  );
  await desktop.backend.command(
    local({ type: 'chat.reorder_tabs', tabIds: ['web-core:chat-2', CHAT_KEY] }),
  );

  // Two messages commit while their events are lost; the next batch skips
  // their revisions, so the store refreshes.
  core.messages = [U1, A1, U2, A2];
  core.revision = 42;
  io.latest.get('core.chat.events')?.push(
    batch(41, 42, [
      {
        type: 'runtime.patched',
        chatId: CHAT,
        runtime: { status: 'idle', queuedMessageIds: [] },
      },
    ]),
  );
  await settle();
  expect(desktop.storeIds()).toEqual(['u1', 'a1', 'u2', 'a2']);
  expect(desktop.activeTabId()).toBe('web-core:chat-2');
  expect(desktop.tabs().map((tab) => tab.id)).toEqual([
    'web-core:chat-2',
    CHAT_KEY,
  ]);

  // A tab this window creates becomes its active tab, as a local create
  // does, and stays so through the next snapshot.
  await desktop.backend.command(
    local({ type: 'chat.create_tab', tabId: 'chat-9-1', title: 'Fresh' }),
  );
  const create = io.calls.findLast((call) => call.method === 'core.chat.create')
    ?.params.action;
  const minted = isRecord(create) ? String(create.tabId) : '';
  core.chats = [
    ...core.chats,
    { chatId: minted, title: 'Fresh', state: 'idle' },
  ];
  core.revision = 44;
  io.latest.get('core.chat.events')?.push(
    batch(43, 44, [
      {
        type: 'runtime.patched',
        chatId: CHAT,
        runtime: { status: 'idle', queuedMessageIds: [] },
      },
    ]),
  );
  await settle();
  expect(desktop.activeTabId()).toBe('chat-9-1');
  core.chats = core.chats.filter((chat) => chat.chatId !== minted);

  // A cloud rename after a desktop one names the tab: the earlier custom
  // title no longer shadows it.
  const renamed = (
    baseRevision: number,
    patch: Record<string, unknown>,
  ): Record<string, unknown> =>
    batch(baseRevision, baseRevision + 1, [
      { type: 'tab.metadata_patched', tabId: 'chat-2', patch },
    ]);
  io.latest.get('core.chat.events')?.push(renamed(44, { customTitle: 'Mine' }));
  await settle();
  expect(desktop.label('web-core:chat-2')).toBe('Mine');
  io.latest.get('core.chat.events')?.push(renamed(45, { title: 'Theirs' }));
  await settle();
  expect(desktop.label('web-core:chat-2')).toBe('Theirs');
  core.revision = 46;

  // A manual unread mark lives in the window and outlives a refresh, until
  // the web core reports the tab's read state itself.
  await desktop.backend.command(
    local({
      type: 'chat.mark_unread',
      chatId: 'web-core:chat-2',
      manual: true,
    }),
  );
  const gap = async (): Promise<void> => {
    core.revision += 2;
    io.latest.get('core.chat.events')?.push(
      batch(core.revision - 1, core.revision, [
        {
          type: 'runtime.patched',
          chatId: CHAT,
          runtime: { status: 'idle', queuedMessageIds: [] },
        },
      ]),
    );
    await settle();
  };
  await gap();
  expect(desktop.read('web-core:chat-2')).toEqual({
    unread: true,
    manual: true,
  });
  core.revision += 1;
  io.latest.get('core.chat.events')?.push(
    batch(core.revision - 1, core.revision, [
      {
        type: 'tab.metadata_patched',
        tabId: 'chat-2',
        patch: { unread: false },
      },
    ]),
  );
  await settle();
  await gap();
  expect(desktop.read('web-core:chat-2')).toEqual({
    unread: false,
    manual: false,
  });

  // A refused archive fails, so the store keeps the tab open.
  core.archiveRefusal = 'This chat is running.';
  await expect(
    desktop.backend.archiveTab({ ...SCOPE, tabId: 'web-core:chat-2' }),
  ).rejects.toThrow('This chat is running.');
  core.archiveRefusal = null;
  expect(core.chats.map((chat) => chat.state)).toEqual(['idle', 'idle']);

  // A message window longer than a page pages back by `before`: the web
  // core serves no turn view to upgrade to first.
  core.pageSize = 2;
  const newest = await desktop.backend.getTranscriptPage({
    ...SCOPE,
    chatId: CHAT_KEY,
    view: 'turns',
  });
  const unloaded: Pick<
    PersistedChatTab,
    'messages' | 'transcriptLoaded' | 'transcriptWindow'
  > = { messages: [], transcriptLoaded: false };
  const tab = installTranscriptPage(unloaded, newest, false);
  expect(tab.transcriptWindow?.before).toBe(2);
  expect(needsNewestTranscriptPage(tab, SCOPE)).toBe(false);
  expect(needsNewestTranscriptPage(tab, { projectId: 'local-project' })).toBe(
    true,
  );
  const older = installTranscriptPage(
    tab,
    await desktop.backend.getTranscriptPage({
      ...SCOPE,
      chatId: CHAT_KEY,
      view: 'turns',
      before: tab.transcriptWindow?.before,
    }),
    true,
  );
  expect(older.messages.map((message) => message.id)).toEqual([
    'u1',
    'a1',
    'u2',
    'a2',
  ]);
  core.pageSize = 100;
});

it('the desktop store refuses a cloud plan request and stops a starting turn by its receipt', async () => {
  core.revision = 50;
  core.status = 'idle';
  core.activeTurnId = undefined;
  core.messages = [U1];
  core.chats = [{ chatId: CHAT, title: 'Plan', state: 'idle' }];
  const io = side();
  const desktop = desktopPath(io);
  await settle();

  // The web core's send has no planning restriction: refused before any send.
  await expect(
    desktop.backend.sendMessage({
      ...SCOPE,
      chatId: CHAT_KEY,
      userMessageId: 'desktop-plan',
      text: 'next',
      planMode: true,
    }),
  ).rejects.toThrow('Plan mode');
  expect(
    io.calls.filter((call) => call.method === 'core.chat.message.send'),
  ).toEqual([]);

  // A starting turn names no id yet; Stop still cancels the receipt's turn.
  await desktop.send('paged');
  core.revision = 51;
  io.latest.get('core.chat.events')?.push(
    batch(50, 51, [
      {
        type: 'runtime.patched',
        chatId: CHAT,
        runtime: { status: 'starting', queuedMessageIds: [] },
      },
    ]),
  );
  await settle();
  await desktop.stop();
  expect(
    io.calls
      .filter((call) => call.method === 'core.chat.turn.cancel')
      .map((call) => call.params),
  ).toEqual([{ chatId: CHAT, turnId: 't5', reason: 'user' }]);

  // A snapshot read while the next turn starts names no turn either: Stop
  // still cancels the receipt's turn.
  await desktop.send('again');
  core.status = 'starting';
  core.activeTurnId = undefined;
  core.revision = 53;
  io.latest.get('core.chat.events')?.push(
    batch(52, 53, [
      {
        type: 'runtime.patched',
        chatId: CHAT,
        runtime: { status: 'starting', queuedMessageIds: [] },
      },
    ]),
  );
  await settle();
  await desktop.stop();
  expect(
    io.calls
      .filter((call) => call.method === 'core.chat.turn.cancel')
      .map((call) => call.params),
  ).toEqual([
    { chatId: CHAT, turnId: 't5', reason: 'user' },
    { chatId: CHAT, turnId: 't3', reason: 'user' },
  ]);

  // A snapshot read while the send is still in flight reports an unnamed
  // starting turn: the receipt that follows still names the turn Stop
  // cancels.
  let release = (): void => undefined;
  core.sendGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sending = desktop.send('next');
  await settle();
  core.revision = 56;
  io.latest.get('core.chat.events')?.push(
    batch(55, 56, [
      {
        type: 'runtime.patched',
        chatId: CHAT,
        runtime: { status: 'starting', queuedMessageIds: [] },
      },
    ]),
  );
  await settle();
  release();
  await sending;
  core.sendGate = null;
  await desktop.stop();
  expect(
    io.calls
      .filter((call) => call.method === 'core.chat.turn.cancel')
      .map((call) => call.params)
      .at(-1),
  ).toEqual({ chatId: CHAT, turnId: 't2', reason: 'user' });

  // A lost send whose receipt is missing fails; it is never resent under the
  // same key, which could run the turn twice (CAN-6273).
  const sends = (): number =>
    io.calls.filter((call) => call.method === 'core.chat.message.send').length;
  const before = sends();
  core.sendFailure = true;
  await expect(
    desktop.backend.sendMessage({
      ...SCOPE,
      chatId: CHAT_KEY,
      userMessageId: 'desktop-lost',
      text: 'next',
    }),
  ).rejects.toThrow('The reply was lost.');
  core.sendFailure = false;
  expect(sends()).toBe(before + 1);
});

it('the live follower expires a stopped reply by its turn and stops retrying a chat it no longer follows', async () => {
  let runs = true;
  let gated = false;
  let rejectOpen: (error: Error) => void = () => undefined;
  const opens: unknown[] = [];
  const streams: ReturnType<typeof controlledStream>[] = [];
  const published = new Map<string, LiveChatState>();
  const invoker: CoreCoworkInvoker = {
    request: () => Promise.reject(new Error('unexpected request')),
    openStream: (_method, params) => {
      opens.push(params);
      if (gated)
        return new Promise((_resolve, reject) => {
          rejectOpen = reject;
        });
      const stream = controlledStream();
      streams.push(stream);
      return Promise.resolve(stream);
    },
  };
  const follower = createLiveFollower({
    invoker: () => invoker,
    turnRuns: () => runs,
    publish: (key, chat) => {
      published.set(key, chat);
    },
    holdMs: 20,
    reopenDelayMs: 0,
  });
  closers.push(() => follower.closeAll());
  const chat = { ...SCOPE, chatId: CHAT_KEY };
  const turnsShown = (): string[] =>
    (published.get(liveReplyKey(chat))?.replies ?? []).map(
      (reply) => reply.turnId,
    );
  follower.setFocused([chat]);
  await settle();
  streams[0]?.push(
    liveFrame({
      kind: 'turn',
      turnId: 't1',
      promptMessageId: 'u1',
      text: 'Half',
      reasoning: '',
      state: 'streaming',
    }),
  );
  await settle();
  expect(turnsShown()).toEqual(['t1']);

  // t1 stops with no committed reply and the next turn starts at once: the
  // stopped reply still expires by its own turn.
  runs = false;
  follower.refresh();
  runs = true;
  follower.refresh();
  await new Promise((resolve) => setTimeout(resolve, 40));
  await settle();
  expect(turnsShown()).toEqual([]);

  // Back-to-back turns with no idle between them: t2 loses its finish
  // frame and t3 starts, so t2's reply expires and t3's stays.
  const stream = streams.at(-1);
  for (const turnId of ['t2', 't3'])
    stream?.push(
      liveFrame({
        kind: 'turn',
        turnId,
        promptMessageId: 'u1',
        text: 'Partial',
        reasoning: '',
        state: 'streaming',
      }),
    );
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 40));
  await settle();
  expect(turnsShown()).toEqual(['t3']);

  // A chat dropped while its stream opens is never opened again.
  gated = true;
  const other = { ...SCOPE, chatId: 'web-core:chat-2' };
  follower.setFocused([chat, other]);
  await settle();
  const opened = opens.length;
  follower.setFocused([chat]);
  rejectOpen(new Error('offline'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await settle();
  expect(opens).toHaveLength(opened);
});

it('the desktop store re-reads a cloud transcript whose send receipt outlasted the echo wait', async () => {
  core.revision = 60;
  core.status = 'idle';
  core.activeTurnId = undefined;
  core.messages = [U1];
  core.chats = [{ chatId: CHAT, title: 'Plan', state: 'idle' }];
  const io = side();
  const desktop = desktopPath(io, { echoWaitMs: 20 });
  await settle();

  // The prompt's echo arrives while its send waits on a slow receipt; the
  // echo wait runs out, so it is published under the web core's id.
  let release = (): void => undefined;
  core.sendGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sending = desktop.backend.sendMessage({
    ...SCOPE,
    chatId: CHAT_KEY,
    userMessageId: 'desktop-same',
    text: 'same',
  });
  await settle();
  const echo = text('mine-u', 'user', 'same', 7);
  core.messages = [U1, echo];
  core.revision = 61;
  io.latest
    .get('core.chat.events')
    ?.push(
      batch(60, 61, [
        { type: 'message.upserted', chatId: CHAT, message: echo },
      ]),
    );
  await new Promise((resolve) => setTimeout(resolve, 40));
  await settle();
  expect(desktop.storeIds()).toEqual(['u1', 'mine-u']);
  expect(desktop.stale()).toBe(false);

  // The receipt lands late, after the turn and with the stream quiet: the
  // transcript is marked stale at once, and the re-read names the prompt by
  // the store's id.
  release();
  await sending;
  core.sendGate = null;
  await settle();
  expect(desktop.stale()).toBe(true);
  // The web core's next event still follows the store's revision.
  core.revision = 62;
  io.latest.get('core.chat.events')?.push(
    batch(61, 62, [
      {
        type: 'runtime.patched',
        chatId: CHAT,
        runtime: { status: 'streaming', queuedMessageIds: [] },
      },
    ]),
  );
  await settle();
  expect(desktop.tabs()).toEqual([{ id: CHAT_KEY, status: 'streaming' }]);
  const page = await desktop.backend.getTranscriptPage({
    ...SCOPE,
    chatId: CHAT_KEY,
    view: 'turns',
  });
  expect(page.messages.map((message) => message.id)).toEqual([
    'u1',
    'desktop-same',
  ]);
});

it("the desktop store shows a cloud chat's questions as the web core raises and settles them", async () => {
  core.revision = 50;
  core.status = 'awaiting_input';
  core.activeTurnId = 'turn-q';
  core.messages = [U1];
  core.chats = [
    { chatId: CHAT, title: 'Plan', state: 'awaiting_user' },
    { chatId: 'chat-2', title: 'Notes', state: 'awaiting_user' },
  ];
  const pick = {
    id: 'q-a',
    header: 'Plan',
    question: 'Which plan?',
    options: ['Small', 'Large'],
    optionDescriptions: ['One file', 'Every file'],
    multiSelect: false,
    allowOther: true,
    control: 'select',
  };
  // The snapshot carries the opened chat's questions in the event's shape; a
  // question the card cannot show (no options) is left out, not invented.
  core.questions = [
    {
      requestId: 'request-1',
      chatId: CHAT,
      questions: [pick],
      toolUseId: 'call-1',
    },
    {
      requestId: 'request-bad',
      chatId: CHAT,
      questions: [{ question: 'No options' }],
    },
  ];
  const io = side();
  const desktop = desktopPath(io);
  await settle();
  expect(desktop.questions()).toEqual([
    {
      requestId: 'request-1',
      chatId: CHAT_KEY,
      questions: [pick],
      toolUseId: 'call-1',
    },
  ]);

  // Another chat's question arrives by its event, under the store's ids...
  const free = { id: '0', question: 'Name it', options: [] };
  io.latest.get('core.chat.events')?.push(
    batch(50, 51, [
      {
        type: 'pending_question.upserted',
        question: {
          requestId: 'request-2',
          chatId: 'chat-2',
          questions: [free],
        },
      },
    ]),
  );
  await settle();
  expect(desktop.questions()).toEqual([
    expect.objectContaining({ requestId: 'request-1' }),
    { requestId: 'request-2', chatId: 'web-core:chat-2', questions: [free] },
  ]);

  // ...and a settled question leaves by its event.
  io.latest.get('core.chat.events')?.push(
    batch(51, 52, [
      {
        type: 'pending_question.removed',
        requestId: 'request-1',
        chatId: CHAT,
      },
    ]),
  );
  await settle();
  expect(desktop.questions()).toEqual([
    expect.objectContaining({ requestId: 'request-2' }),
  ]);

  // A refresh re-reads every chat's questions, so the other chat's stays...
  const second = {
    requestId: 'request-2',
    chatId: 'chat-2',
    questions: [free],
  };
  const refresh = async (revision: number): Promise<void> => {
    core.revision = revision;
    io.latest.get('core.chat.events')?.push(
      batch(revision - 1, revision, [
        {
          type: 'runtime.patched',
          chatId: CHAT,
          runtime: { status: 'awaiting_input', queuedMessageIds: [] },
        },
      ]),
    );
    await settle();
  };
  core.questions = [second];
  await refresh(54);
  expect(desktop.questions()).toEqual([
    { requestId: 'request-2', chatId: 'web-core:chat-2', questions: [free] },
  ]);

  // ...and when the web core cannot read that chat's questions, the desktop
  // keeps what it shows instead of dropping a question the agent waits on.
  core.questions = [];
  core.unreadQuestionChatIds = ['chat-2'];
  await refresh(56);
  expect(desktop.questions()).toEqual([
    { requestId: 'request-2', chatId: 'web-core:chat-2', questions: [free] },
  ]);

  // A read that finds it answered elsewhere drops it.
  core.unreadQuestionChatIds = [];
  await refresh(58);
  expect(desktop.questions()).toEqual([]);

  // A question raised while a snapshot is read is newer than that snapshot,
  // so a later read that cannot reach its chat still keeps it.
  let releaseSnapshot = (): void => undefined;
  core.snapshotGate = new Promise<void>((resolve) => {
    releaseSnapshot = resolve;
  });
  const reading = desktop.backend.getState(SCOPE);
  await settle();
  const third = {
    requestId: 'request-3',
    chatId: 'chat-2',
    questions: [free],
  };
  core.revision = 59;
  io.latest
    .get('core.chat.events')
    ?.push(
      batch(58, 59, [{ type: 'pending_question.upserted', question: third }]),
    );
  await settle();
  releaseSnapshot();
  core.snapshotGate = null;
  await reading;
  core.unreadQuestionChatIds = ['chat-2'];
  await refresh(61);
  expect(desktop.questions()).toEqual([
    { requestId: 'request-3', chatId: 'web-core:chat-2', questions: [free] },
  ]);

  // Once a snapshot finds it answered, a late event from before that
  // snapshot does not bring it back on a read that cannot reach its chat.
  core.unreadQuestionChatIds = [];
  await refresh(63);
  expect(desktop.questions()).toEqual([]);
  io.latest
    .get('core.chat.events')
    ?.push(
      batch(61, 62, [{ type: 'pending_question.upserted', question: third }]),
    );
  await settle();
  core.unreadQuestionChatIds = ['chat-2'];
  await refresh(65);
  expect(desktop.questions()).toEqual([]);
  core.unreadQuestionChatIds = [];
  core.questions = [];
});

it("a cloud send carries the composer's thinking level within the model's catalog, and the web core never sees one it refuses", async () => {
  core.revision = 60;
  core.status = 'idle';
  core.activeTurnId = undefined;
  core.messages = [U1];
  core.chats = [{ chatId: CHAT, title: 'Plan', state: 'idle' }];
  const io = side();
  const backend = createWebCoreChatBackendCore({
    invoker: () => io.invoker,
    newId: () => crypto.randomUUID(),
    reopenDelayMs: 0,
    liveReopenDelayMs: 0,
    publishLive: () => undefined,
    modelOption: (projectId, model) =>
      projectId === SCOPE.projectId && model === 'cloud-model'
        ? {
            id: 'cloud-model',
            label: 'Cloud model',
            provider: 'claude',
            kind: 'model',
            available: true,
            supportedThinkingLevels: ['low', 'medium', 'high'],
            supportsFastMode: true,
          }
        : undefined,
  });
  closers.push(() => backend.closeAll());
  const target = { ...SCOPE, chatId: CHAT_KEY };
  const requests = (): number => io.calls.length;

  // A level the web core refuses is refused before any request.
  const before = requests();
  await expect(
    backend.toggleThinkingLevel({ ...target, level: 'ultra' }),
  ).rejects.toMatchObject({ code: 'capability_unavailable' });
  expect(requests()).toBe(before);

  // A served choice stays on the tab across a snapshot the web core sends
  // without it.
  await backend.toggleThinkingLevel({ ...target, level: 'high' });
  const state = await backend.getState(SCOPE);
  expect(state.tabsFile.tabs.find((tab) => tab.id === CHAT_KEY)).toMatchObject({
    thinkingLevel: 'high',
    modelConfig: { thinkingLevel: 'high' },
  });

  const sent = (): Record<string, unknown>[] =>
    io.calls
      .filter((call) => call.method === 'core.chat.message.send')
      .map((call) => call.params);
  // The model's catalog clamps the level the composer shows (Max runs as
  // High here), as the composer clamps it. Fast mode is not served in cloud
  // chats yet, so a tab's speed never rides the send.
  await backend.sendMessage({
    ...target,
    userMessageId: 'desktop-deep',
    text: 'deep',
    model: 'cloud-model',
    modelConfig: { thinkingLevel: 'max', fastMode: true },
  });
  // A model the catalog does not list sends no settings: the chat keeps its own.
  await backend.sendMessage({
    ...target,
    userMessageId: 'desktop-unlisted',
    text: 'unlisted',
    model: 'other-model',
    modelConfig: { thinkingLevel: 'ultra', fastMode: true },
  });
  expect(sent().map((params) => params.modelConfig)).toEqual([
    { thinkingLevel: 'high' },
    undefined,
  ]);
  for (const params of sent())
    expect(CoreChatMessageSendParamsSchema.safeParse(params).success).toBe(
      true,
    );
});

it("the desktop store attaches a cloud chat's files through the web core and sends their ids", async () => {
  const sends: Record<string, unknown>[] = [];
  const uploads: { target: unknown; file: CloudChatAttachmentUploadFile }[] =
    [];
  let refuseUpload: 'too_large' | null = null;
  const backend = createWebCoreChatBackendCore({
    invoker: () => ({
      request: (method, params): Promise<CanopyCoreRelayLikeReply> => {
        // The web core's copy of the sent message, with no attachments: its
        // transcript does not carry them yet (CAN-6116).
        if (method === 'core.chat.transcript.page')
          return Promise.resolve({
            ok: true,
            value: {
              messages: [text('u-attach', 'user', 'See the brief', 7)],
              totalMessages: 1,
              transcriptRevision: 2,
            },
          });
        if (method !== 'core.chat.message.send')
          throw new Error(`unexpected ${method}`);
        sends.push(params);
        return Promise.resolve({
          ok: true,
          value: {
            commandId: params.commandId,
            revision: 2,
            outcome: 'applied',
          },
        });
      },
      openStream: (): Promise<never> =>
        Promise.reject(new Error('no streams here')),
    }),
    newId: () => crypto.randomUUID(),
    uploadAttachment: (target, file) => {
      uploads.push({ target, file });
      return Promise.resolve(
        refuseUpload !== null
          ? { ok: false, reason: refuseUpload }
          : {
              ok: true,
              attachmentId: 'att-1',
              attachment: {
                attachmentId: 'att-1',
                filename: file.name,
                mediaType: file.mimeType,
                size: file.bytes.byteLength,
                contentSha256: '0'.repeat(64),
                storageKind: 'blob',
                source: 'upload',
              },
            },
      );
    },
  });
  const bytes = new TextEncoder().encode('# Brief');
  const target = { ...SCOPE, chatId: CHAT_KEY };

  // The bytes go to main's upload for the chat under its web core ids, and
  // come back as a pending attachment naming the upload, never a local file.
  const uploaded = await backend.uploadAttachment(target, {
    name: 'brief.md',
    mediaType: 'text/markdown',
    bytes,
  });
  expect(uploads).toEqual([
    {
      target: { key: CHAT_KEY, workspaceId: WORKSPACE, worktreeId: TASK },
      file: { name: 'brief.md', mimeType: 'text/markdown', bytes },
    },
  ]);
  if (!uploaded.ok) throw new Error('the upload was refused');
  expect(uploaded.attachment).toEqual({
    filename: 'brief.md',
    absolutePath: cloudAttachmentPath('att-1', 'brief.md'),
    sizeBytes: bytes.byteLength,
  });
  // Its preview comes from the bytes already read, not from main.
  expect(cloudAttachmentPreview(uploaded.attachment.absolutePath)).toEqual(
    expect.objectContaining({ kind: 'markdown', content: '# Brief' }),
  );

  // The send carries the upload's id, as the catalog takes it.
  await backend.sendMessage({
    ...target,
    userMessageId: 'u-attach',
    text: 'See the brief',
    attachmentPaths: [uploaded.attachment.absolutePath],
  });
  expect(sends).toHaveLength(1);
  expect(sends[0]?.attachments).toEqual([{ attachmentId: 'att-1' }]);
  expect(CoreChatMessageSendParamsSchema.safeParse(sends[0]).success).toBe(
    true,
  );
  // The web core's copy of that message keeps the attachments it was sent with.
  const page = await backend.getTranscriptPage({
    ...target,
    chatId: CHAT_KEY,
    view: 'turns',
  });
  expect(page.messages[0]?.attachmentPaths).toEqual([
    uploaded.attachment.absolutePath,
  ]);

  // A file from this computer, or more than a message takes, is refused
  // before any request.
  await expect(
    backend.sendMessage({
      ...target,
      userMessageId: 'u-local',
      text: 'Local',
      attachmentPaths: ['/Users/me/brief.md'],
    }),
  ).rejects.toThrow('not available in cloud chats');
  await expect(
    backend.sendMessage({
      ...target,
      userMessageId: 'u-many',
      text: 'Many',
      attachmentPaths: Array.from({ length: 9 }, (_, index) =>
        cloudAttachmentPath(`att-${index}`, `file-${index}.md`),
      ),
    }),
  ).rejects.toThrow('Attach up to eight files per message');
  expect(sends).toHaveLength(1);

  // An upload the web core refuses answers its reason and attaches nothing.
  refuseUpload = 'too_large';
  expect(
    await backend.uploadAttachment(target, {
      name: 'big.pdf',
      mediaType: 'application/pdf',
      bytes,
    }),
  ).toEqual({ ok: false, reason: 'too_large' });
});

it("a cloud send waits for the chat's selection save, so its turn runs with what the user just chose", async () => {
  core.revision = 70;
  core.status = 'idle';
  core.activeTurnId = undefined;
  core.messages = [U1];
  core.chats = [{ chatId: CHAT, title: 'Plan', state: 'idle' }];
  const io = side();
  const backend = createWebCoreChatBackendCore({
    invoker: () => io.invoker,
    newId: () => crypto.randomUUID(),
    reopenDelayMs: 0,
    liveReopenDelayMs: 0,
    publishLive: () => undefined,
  });
  closers.push(() => backend.closeAll());
  const sends = (): number =>
    io.calls.filter((call) => call.method === 'core.chat.message.send').length;

  let saved = (): void => undefined;
  trackSelectionSave(
    CHAT_KEY,
    new Promise<void>((resolve) => {
      saved = resolve;
    }),
  );
  const send = backend.sendMessage({
    ...SCOPE,
    chatId: CHAT_KEY,
    userMessageId: 'desktop-after-save',
    text: 'after-save',
  });
  await settle();
  // Nothing goes to the web core while the selection is still saving.
  expect(sends()).toBe(0);
  saved();
  await send;
  expect(sends()).toBe(1);
});

it("a cloud send carries the window's fast mode for a model that runs it, and never Ultra fast", async () => {
  core.revision = 80;
  core.status = 'idle';
  core.activeTurnId = undefined;
  core.messages = [U1];
  core.chats = [{ chatId: CHAT, title: 'Plan', state: 'idle' }];
  const io = side();
  const option = (id: string, fast: boolean): ModelCatalogOption => ({
    id,
    label: id,
    provider: 'claude',
    kind: 'model',
    available: true,
    supportedThinkingLevels: ['low', 'high'],
    supportsFastMode: fast,
  });
  const backend = createWebCoreChatBackendCore({
    invoker: () => io.invoker,
    newId: () => crypto.randomUUID(),
    reopenDelayMs: 0,
    liveReopenDelayMs: 0,
    publishLive: () => undefined,
    modelOption: (projectId, model) =>
      projectId !== SCOPE.projectId || model === undefined
        ? undefined
        : option(model, model === 'fast-model'),
  });
  closers.push(() => backend.closeAll());
  const target = { ...SCOPE, chatId: CHAT_KEY };

  // Ultra fast is refused before any request.
  const before = io.calls.length;
  await expect(
    backend.toggleCodexFastMode({
      ...target,
      enabled: false,
      speed: 'ultrafast',
    }),
  ).rejects.toMatchObject({ code: 'capability_unavailable' });
  expect(io.calls.length).toBe(before);

  await backend.toggleCodexFastMode({
    ...target,
    enabled: true,
    speed: 'fast',
  });
  await backend.sendMessage({
    ...target,
    userMessageId: 'desktop-quick',
    text: 'quick',
    model: 'fast-model',
    modelConfig: { thinkingLevel: 'high' },
  });
  // A model without fast mode sends none, whatever the window chose.
  await backend.sendMessage({
    ...target,
    userMessageId: 'desktop-slow',
    text: 'slow',
    model: 'plain-model',
    modelConfig: { thinkingLevel: 'high' },
  });
  const sent = io.calls
    .filter((call) => call.method === 'core.chat.message.send')
    .map((call) => call.params);
  expect(sent.map((params) => params.modelConfig)).toEqual([
    { thinkingLevel: 'high', fastMode: true },
    { thinkingLevel: 'high' },
  ]);
  for (const params of sent)
    expect(CoreChatMessageSendParamsSchema.safeParse(params).success).toBe(
      true,
    );
});

it('a tab choice made while a cloud snapshot refreshes outlives the refresh and rides the next send (CAN-6324)', async () => {
  core.revision = 90;
  core.status = 'idle';
  core.activeTurnId = undefined;
  core.messages = [U1];
  core.chats = [{ chatId: CHAT, title: 'Plan', state: 'idle' }];
  const io = side();
  const backend = createWebCoreChatBackendCore({
    invoker: () => io.invoker,
    newId: () => crypto.randomUUID(),
    reopenDelayMs: 0,
    liveReopenDelayMs: 0,
    publishLive: () => undefined,
    modelOption: (projectId, model) =>
      projectId === SCOPE.projectId && model === 'cloud-model'
        ? {
            id: 'cloud-model',
            label: 'Cloud model',
            provider: 'claude',
            kind: 'model',
            available: true,
            supportedThinkingLevels: ['low', 'medium', 'high'],
          }
        : undefined,
  });
  closers.push(() => backend.closeAll());
  const target = { ...SCOPE, chatId: CHAT_KEY };
  // The store has read the chat, so each refresh reads its newest page.
  await backend.getTranscriptPage(target);
  await backend.toggleThinkingLevel({ ...target, level: 'low' });

  let pageServed = (): void => undefined;
  core.pageGate = new Promise<void>((resolve) => {
    pageServed = resolve;
  });
  const refresh = backend.getState(SCOPE);
  await settle();
  // Choices made while the refresh waits for the chat's page.
  await backend.toggleThinkingLevel({ ...target, level: 'high' });
  await backend.command({
    schemaVersion: 1,
    commandId: crypto.randomUUID(),
    ...SCOPE,
    command: { type: 'chat.mark_unread', chatId: CHAT_KEY, manual: true },
  });
  pageServed();
  core.pageGate = null;
  const refreshed = (await refresh).tabsFile.tabs.find(
    (tab) => tab.id === CHAT_KEY,
  );
  expect(refreshed).toMatchObject({
    thinkingLevel: 'high',
    modelConfig: { thinkingLevel: 'high' },
    unread: true,
    unreadMarkedManually: true,
  });

  await backend.sendMessage({
    ...target,
    userMessageId: 'desktop-after-refresh',
    text: 'deep',
    model: 'cloud-model',
    // The store sends the level of the tab the refresh installed.
    ...(refreshed?.modelConfig === undefined
      ? {}
      : { modelConfig: refreshed.modelConfig }),
  });
  expect(
    io.calls
      .filter((call) => call.method === 'core.chat.message.send')
      .map((call) => call.params.modelConfig),
  ).toEqual([{ thinkingLevel: 'high' }]);
});

it("a cloud tab's model follows the web core's revisions, whichever of a pick's reply, a snapshot or an event lands first (CAN-6345)", async () => {
  core.revision = 100;
  core.status = 'idle';
  core.activeTurnId = undefined;
  core.messages = [U1];
  core.chats = [{ chatId: CHAT, title: 'Plan', state: 'idle' }];
  const io = side();
  const desktop = desktopPath(io);
  await settle();
  let applied = 100;
  const modelEvent = (revision: number, modelId: string): void => {
    io.latest
      .get('core.chat.events')
      ?.push(
        batch(applied, revision, [
          { type: 'tab.metadata_patched', tabId: CHAT, patch: { modelId } },
        ]),
      );
    applied = revision;
  };
  const hold = (): (() => void) => {
    let release = (): void => undefined;
    core.updateGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => {
      core.updateGate = null;
      release();
    };
  };
  const pick = (model: string): Promise<unknown> =>
    desktop.backend.command({
      schemaVersion: 1,
      commandId: crypto.randomUUID(),
      ...SCOPE,
      command: {
        type: 'chat.set_model',
        tabId: CHAT_KEY,
        model,
        providerType: 'claude',
      },
    });
  const runs = (): string | undefined =>
    desktop.backend.webCoreTabModel({ ...SCOPE, chatId: CHAT_KEY })?.model;

  // A pick in flight shows over an event the web core sent before applying
  // it; the receipt names the revision the pick applied at (CAN-6346).
  let release = hold();
  let reply = pick('model-b');
  await settle();
  modelEvent(101, 'model-a');
  await settle();
  expect(desktop.model(CHAT_KEY)).toBe('model-b');
  core.revision = 102;
  release();
  await reply;
  expect(runs()).toBe('model-b');

  // A snapshot read before the pick applied lands after its reply: it keeps
  // the pick. An event after it, another client's change, shows.
  core.model = 'model-a';
  core.revision = 101;
  let snapshotServed = (): void => undefined;
  core.snapshotGate = new Promise<void>((resolve) => {
    snapshotServed = resolve;
  });
  const older = desktop.backend.getState(SCOPE);
  await settle();
  core.snapshotGate = null;
  snapshotServed();
  expect(
    (await older).tabsFile.tabs.find((tab) => tab.id === CHAT_KEY)?.model,
  ).toBe('model-b');
  modelEvent(103, 'model-c');
  await settle();
  expect(desktop.model(CHAT_KEY)).toBe('model-c');
  expect(runs()).toBe('model-c');

  // Another client changes the model right after this window's pick applies:
  // the pick masks both events while in flight, and the reply, at the
  // pick's own revision, names the newer one.
  release = hold();
  reply = pick('model-d');
  await settle();
  modelEvent(104, 'model-d');
  modelEvent(105, 'model-e');
  await settle();
  expect(desktop.model(CHAT_KEY)).toBe('model-d');
  core.revision = 104;
  release();
  await reply;
  expect(runs()).toBe('model-e');

  // A refused pick, which the web core answers with an error, leaves the
  // newest model it reported.
  core.setModelRefusal = 'Not served.';
  release = hold();
  reply = pick('model-f');
  await settle();
  release();
  await expect(reply).rejects.toThrow('Not served.');
  expect(runs()).toBe('model-e');
});

it('a refused cloud model pick never stays on a refresh that read another model at its revision (CAN-6345)', async () => {
  core.revision = 120;
  core.status = 'idle';
  core.activeTurnId = undefined;
  core.messages = [U1];
  core.chats = [{ chatId: CHAT, title: 'Plan', state: 'idle' }];
  const io = side();
  const backend = createWebCoreChatBackendCore({
    invoker: () => io.invoker,
    newId: () => crypto.randomUUID(),
    reopenDelayMs: 0,
    liveReopenDelayMs: 0,
    publishLive: () => undefined,
  });
  closers.push(() => backend.closeAll());
  // The store has read the chat, so a refresh waits for its newest page.
  await backend.getTranscriptPage({ ...SCOPE, chatId: CHAT_KEY });
  let refuse = (): void => undefined;
  core.updateGate = new Promise<void>((resolve) => {
    refuse = resolve;
  });
  core.setModelRefusal = 'Not served.';
  const pick = backend.command({
    schemaVersion: 1,
    commandId: crypto.randomUUID(),
    ...SCOPE,
    command: {
      type: 'chat.set_model',
      tabId: CHAT_KEY,
      model: 'model-b',
      providerType: 'claude',
    },
  });
  await settle();
  // Another client's model, read while the pick is in flight.
  core.model = 'model-c';
  let pageServed = (): void => undefined;
  core.pageGate = new Promise<void>((resolve) => {
    pageServed = resolve;
  });
  const refresh = backend.getState(SCOPE);
  await settle();
  core.updateGate = null;
  refuse();
  await expect(pick).rejects.toThrow('Not served.');
  core.pageGate = null;
  pageServed();
  expect(
    (await refresh).tabsFile.tabs.find((tab) => tab.id === CHAT_KEY)?.model,
  ).toBe('model-c');
});

it("a cloud tab's model keeps the web core's order after a late receipt's repair shifts the store's revisions (CAN-6345)", async () => {
  core.revision = 60;
  core.status = 'idle';
  core.activeTurnId = undefined;
  core.messages = [U1];
  core.chats = [{ chatId: CHAT, title: 'Plan', state: 'idle' }];
  const io = side();
  const desktop = desktopPath(io, { echoWaitMs: 20 });
  await settle();
  // Another client's model, reported at revision 61.
  io.latest.get('core.chat.events')?.push(
    batch(60, 61, [
      {
        type: 'tab.metadata_patched',
        tabId: CHAT,
        patch: { modelId: 'model-c' },
      },
    ]),
  );
  await settle();
  // A send's receipt outlasts its echo: the repair adds a store revision.
  let release = (): void => undefined;
  core.sendGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sending = desktop.backend.sendMessage({
    ...SCOPE,
    chatId: CHAT_KEY,
    userMessageId: 'desktop-same',
    text: 'same',
  });
  await settle();
  const echo = text('mine-u', 'user', 'same', 7);
  core.messages = [U1, echo];
  io.latest
    .get('core.chat.events')
    ?.push(
      batch(61, 62, [
        { type: 'message.upserted', chatId: CHAT, message: echo },
      ]),
    );
  await new Promise((resolve) => setTimeout(resolve, 40));
  await settle();
  release();
  await sending;
  core.sendGate = null;
  await settle();
  expect(desktop.stale()).toBe(true);
  // A snapshot from before the model change, at web core revision 60.
  core.model = 'model-a';
  core.revision = 60;
  const older = await desktop.backend.getState(SCOPE);
  expect(older.tabsFile.tabs.find((tab) => tab.id === CHAT_KEY)?.model).toBe(
    'model-c',
  );
  expect(
    desktop.backend.webCoreTabModel({ ...SCOPE, chatId: CHAT_KEY })?.model,
  ).toBe('model-c');
});
