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
  type ProjectCloudChatMessages,
} from '@canopy/app-state/core-cowork';
import {
  CoreChatMessageSendParamsSchema,
  CoreChatSnapshotGetResultSchema,
  type CoreChatMessageMeter,
} from '@canopy/protocol/canopy-core';
import {
  foldChatUsage,
  type ChatUsageAnswer,
} from '@canopy/protocol/cloud-session';
import { toUsageIndicatorUsage } from '@canopy/ui-app';
import type { ModelCatalogOption } from '@canopy/protocol/models';
import type {
  ChatCommandRequest,
  ChatQueueUpdatedEvent,
  ChatStateSnapshot,
  CloudChatAttachmentUploadFile,
  PersistedChatMessage,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import { cloudChatCanopyClient } from '@/cloud-chats/cloud-chat-client';
import { chatTabStripLabel } from '@/lib/chatTabLabel';
import { projectAgentTaskTranscript } from '@canopy/agent-transcript/agent-tasks';
import {
  persistedMessageToPortalMessage,
  projectPersistedChatTranscript,
} from '@canopy/desktop-shared/portal/persisted-chat-projection';
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
import { runtimeRunsTurn } from '../../runtime-runs-turn';
import { createLiveFollower } from '../live-follower';
import {
  clearCloudTaskDeletions,
  forgetCloudTaskMark,
  markCloudTaskDeleted,
} from '../task-deletions';
import {
  liveReplyKey,
  presentLiveReplies,
  type LiveChatState,
} from '../live-replies';
import {
  isPersistedChatMessage,
  parseEventItem,
  translateChange,
  translateCommandResult,
} from '../translate';

/**
 * The web path's projection: the shared thread binding with subagent rows
 * nested into their spawn call (CAN-5976), as the cloud chat page projected
 * them before R2b deleted it.
 */
const projectCloudChatMessages: ProjectCloudChatMessages = ({
  chatKey,
  messages,
  tasks,
}) =>
  projectAgentTaskTranscript({
    messages: messages.filter(isPersistedChatMessage),
    tasks,
    project: (rows) =>
      projectPersistedChatTranscript({
        scope: 'worktree',
        chatId: chatKey,
        messages: [...rows],
        fidelity: 'local',
      }),
  });
import {
  chooseStopTarget,
  createWebCoreChatBackendCore,
  type StopTargetInput,
} from '../web-core-chat-backend';
import { createWebCoreChatBackend } from '..';
import {
  cloudAttachmentPath,
  cloudAttachmentPreview,
} from '@/cloud-chats/cloud-chat-attachments';
import { trackSelectionSave } from '../selection-saves';
import { WebCoreSendRefusedError } from '../send-refusal';
import {
  clearWebCoreModelCatalog,
  useWebCoreModelCatalogStore,
} from '../model-catalog';
import type { AgentTaskRow } from '@canopy/protocol/cloud-session';

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
  stopped: { turnId: 't11', messageId: 'stopped-u', revision: 91 },
  'stop-queued': { turnId: 't12', messageId: 'stop-queued-u', revision: 101 },
  'stop-after-end': {
    turnId: 't13',
    messageId: 'stop-after-end-u',
    revision: 102,
  },
  'stop-quiet': { turnId: 't14', messageId: 'stop-quiet-u', revision: 101 },
  'stop-saving': { turnId: 't15', messageId: 'stop-saving-u', revision: 101 },
  'stop-stale': { turnId: 't16', messageId: 'stop-stale-u', revision: 101 },
  'queued-follow': {
    turnId: 't18',
    messageId: 'queued-follow-u',
    revision: 104,
  },
  'stop-after-stale': {
    turnId: 't17',
    messageId: 'stop-after-stale-u',
    revision: 103,
  },
  second: { turnId: 't12', messageId: 'second-u', revision: 96 },
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
  /** Holds one chat's own snapshot read until released (CAN-6777). */
  chatSnapshotGate: null as { chatId: string; gate: Promise<void> } | null,
  /** Holds transcript page replies until released, to let choices land meanwhile. */
  pageGate: null as Promise<void> | null,
  /** Holds `core.chat.update` replies until released; each answers at the revision then. */
  updateGate: null as Promise<void> | null,
  /** Set to make the web core refuse a model change with this reason. */
  setModelRefusal: null as string | null,
  /** The model the snapshot names for the task's chat. */
  model: undefined as string | undefined,
  /**
   * The harness the snapshot's settings name for the task's chat (CAN-6761);
   * undefined serves no settings, as a web core from before it does.
   */
  harness: undefined as 'claude' | 'codex' | null | undefined,
  /**
   * The harness another chat's own snapshot names for it (CAN-6761): the web
   * core opens only the chat a snapshot is read for.
   */
  chatHarness: {} as Record<string, 'claude' | 'codex'>,
  /** The task's chats, as core.chat.list names them. */
  chats: [{ chatId: CHAT, title: 'Plan', state: 'idle' }] as {
    chatId: string;
    title: string;
    state: string;
  }[],
  /** The running turn of each other chat, which only its own snapshot names. */
  turns: {} as Record<string, string>,
  /** Each chat's queued prompts, as its own snapshot serves them (CAN-6509). */
  queues: {} as Record<string, Record<string, unknown>[]>,
  /** Set to make one chat's own snapshot read fail, as a lost read does. */
  snapshotFailsFor: null as string | null,
  /** Set to make one chat's transcript page read fail, as a lost read does. */
  pageFailsFor: null as string | null,
  /** How the web core answers a queued prompt's cancel. */
  cancelOutcome: 'applied' as 'applied' | 'conflict',
  /** Turn cancels the web core refuses as not found, as one from before CAN-6393 did. */
  turnCancelNotFound: 0,
  /** How the web core answers a queued prompt's edit, hold or run now (CAN-6651). */
  queueOutcome: 'applied' as 'applied' | 'conflict',
  /** Set to refuse a queue mutation whose entryRevision is not the entry's own. */
  checksEntryRevision: false,
  /** Holds edit replies until released, to let the editor reopen meanwhile. */
  queueEditGate: null as Promise<void> | null,
  /** Holds run now replies until released, to let a turn start meanwhile. */
  forceGate: null as Promise<void> | null,
  /** Whether the task's chat says Core holds its queued entries for editing. */
  queuedEditHold: false,
  /** Holds granted so far, to name each one. */
  holds: 0,
  /** Each chat's agent task rows, as its snapshot carries them. */
  tasks: {} as Record<string, unknown[]>,
  /** The opened chat's sandbox, as its snapshot carries it (CAN-6766). */
  sandbox: undefined as { state: string } | undefined,
  /** Rows per transcript page. */
  pageSize: 100,
  /** Set to make the web core refuse an archive with this reason. */
  archiveRefusal: null as string | null,
  /** Set to lose every send reply with a retryable failure. */
  sendFailure: false,
  /** How many next sends the web core refuses while the worktree rebuilds. */
  sendsDuringRebuild: 0,
  /** The Retry-After those refusals carry. */
  rebuildRetryMs: 1,
  /** Every live chat's unanswered questions, as the task's snapshot carries them. */
  questions: [] as Record<string, unknown>[],
  /** Chats whose questions the snapshot could not read. */
  unreadQuestionChatIds: [] as string[],
  /** The opened chat's prompts Core holds queued, as its snapshot names them. */
  queued: [] as string[],
  /** Holds turn cancel replies until released. */
  cancelGate: null as Promise<void> | null,
  /** Set to answer sends with a receipt that names no turn, as before turn ids. */
  legacyReceipt: false,
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
  const opened = typeof chatId === 'string' ? chatId : CHAT;
  const tasks = core.tasks[opened];
  return {
    ...openedSnapshot(chatId),
    tasks,
    ...(core.sandbox === undefined ? {} : { sandbox: core.sandbox }),
  };
}

function openedSnapshot(chatId?: unknown): Record<string, unknown> {
  if (typeof chatId === 'string' && chatId !== CHAT)
    return {
      ...openedSnapshot(),
      ...(core.chatHarness[chatId] === undefined
        ? {}
        : {
            tabs: {
              activeTabId: chatId,
              items: [
                {
                  chatId,
                  title: 'Notes',
                  kind: 'chat',
                  createdAt: '2026-11-10T00:00:00.000Z',
                  settings: {
                    model: null,
                    providerId: null,
                    executionHarness: core.chatHarness[chatId],
                    modelSelectionMode: 'manual',
                    thinkingLevel: null,
                    speed: null,
                    planMode: false,
                    approvalMode: null,
                    interfaceMode: null,
                    customTitle: null,
                  },
                },
              ],
            },
          }),
      runtimeByChatId: {
        [chatId]: {
          status: 'streaming',
          queuedMessageIds: queuedIdsOf(chatId),
          ...(core.turns[chatId] === undefined
            ? {}
            : { activeTurnId: core.turns[chatId] }),
        },
      },
      queue: queueOf(chatId),
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
          ...(core.harness === undefined
            ? {}
            : {
                settings: {
                  model: core.model ?? null,
                  providerId: null,
                  executionHarness: core.harness,
                  modelSelectionMode: 'manual',
                  thinkingLevel: null,
                  speed: null,
                  planMode: false,
                  approvalMode: null,
                  interfaceMode: null,
                  customTitle: null,
                },
              }),
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
        queuedMessageIds: [...core.queued, ...queuedIdsOf(CHAT)],
        ...(core.activeTurnId === undefined
          ? {}
          : { activeTurnId: core.activeTurnId }),
        ...(core.queuedEditHold ? { queuedEditHold: true } : {}),
      },
    },
    queue: queueOf(CHAT),
  };
}

/** A chat's queue as its own snapshot serves it: the web core serves one chat's. */
function queueOf(chatId: string): Record<string, unknown>[] {
  const entries = core.queues[chatId] ?? [];
  return entries.length === 0
    ? []
    : [
        {
          chatId,
          stateVersion: String(core.revision),
          sessionId: 'session-1',
          entries,
        },
      ];
}

/** The prompt ids a chat's runtime names queued. */
function queuedIdsOf(chatId: string): string[] {
  return (core.queues[chatId] ?? []).map((entry) => String(entry.messageId));
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
            if (
              core.snapshotFailsFor !== null &&
              params.chatId === core.snapshotFailsFor
            )
              return Promise.resolve({
                ok: false,
                error: {
                  kind: 'unavailable',
                  message: 'The read was lost.',
                  retry: { kind: 'same_request' },
                },
              });
            const reply = ok(snapshot(params.chatId));
            const gate =
              core.chatSnapshotGate !== null &&
              params.chatId === core.chatSnapshotGate.chatId
                ? core.chatSnapshotGate.gate
                : core.snapshotGate;
            return (gate ?? Promise.resolve()).then(() => reply);
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
            if (
              core.pageFailsFor !== null &&
              isRecord(params.scope) &&
              params.scope.chatId === core.pageFailsFor
            )
              return Promise.resolve({
                ok: false,
                error: {
                  kind: 'unavailable',
                  message: 'The read was lost.',
                  retry: { kind: 'same_request' },
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
            if (core.sendFailure) {
              const lost: CanopyCoreRelayLikeReply = {
                ok: false,
                error: {
                  kind: 'unavailable',
                  message: 'The reply was lost.',
                  retry: { kind: 'same_idempotency_key' },
                },
              };
              return (core.sendGate ?? Promise.resolve()).then(() => lost);
            }
            if (core.sendsDuringRebuild > 0) {
              core.sendsDuringRebuild -= 1;
              // As the web core answers a send its admission refused.
              return Promise.resolve({
                ok: false,
                error: {
                  kind: 'unavailable',
                  message:
                    'This worktree is being rebuilt. Check again in a moment.',
                  retry: {
                    kind: 'same_idempotency_key',
                    delayMs: core.rebuildRetryMs,
                  },
                  details: {
                    reason: 'cloud_refused',
                    cloudCode: 'cloud-worktree-recovery-in-progress',
                  },
                },
              });
            }
            const sent = SENDS[String(params.text)];
            if (sent === undefined) throw new Error('unexpected send');
            const reply = ok({
              commandId: params.commandId,
              revision: sent.revision,
              outcome: 'applied',
              ...(core.legacyReceipt ? {} : { entityId: sent.turnId }),
              messageId: sent.messageId,
            });
            return (core.sendGate ?? Promise.resolve()).then(() => reply);
          }
          case 'core.chat.turn.cancel': {
            if (core.turnCancelNotFound > 0) {
              core.turnCancelNotFound -= 1;
              return Promise.resolve({
                ok: false,
                error: {
                  kind: 'not_found',
                  message:
                    'agentic-core request failed with 404: Agent session turn not found',
                  retry: { kind: 'never' },
                },
              });
            }
            const reply = ok({});
            return (core.cancelGate ?? Promise.resolve()).then(() => reply);
          }
          case 'core.chat.queue.entry.cancel':
            return Promise.resolve(
              ok({
                commandId: String(Reflect.get(Object(params), 'commandId')),
                revision: core.revision,
                outcome: core.cancelOutcome,
                ...(core.cancelOutcome === 'conflict'
                  ? { reason: 'The queued message changed.' }
                  : {}),
              }),
            );
          case 'core.chat.queue.entry.update':
          case 'core.chat.queue.entry.force': {
            const commandId = String(Reflect.get(Object(params), 'commandId'));
            const held = (core.queues[String(params.chatId)] ?? []).find(
              (each) => each.id === params.entryId,
            );
            if (
              core.queueOutcome === 'conflict' ||
              (core.checksEntryRevision &&
                params.entryRevision !== undefined &&
                held?.revision !== params.entryRevision)
            )
              return Promise.resolve(
                ok({
                  commandId,
                  revision: core.revision,
                  outcome: 'conflict',
                  reason: 'The queued message changed.',
                }),
              );
            const mutation: unknown = Reflect.get(Object(params), 'mutation');
            // As the web core refuses an input mode it doesn't serve.
            if (Reflect.get(Object(mutation), 'inputMode') !== undefined)
              return Promise.resolve({
                ok: false,
                error: {
                  kind: 'invalid_argument',
                  message: 'The web core does not serve mutation.inputMode.',
                  retry: { kind: 'never' },
                },
              });
            const lock =
              Reflect.get(Object(mutation), 'kind') === 'lock' &&
              Reflect.get(Object(mutation), 'locked') === true;
            const acquisitionId: unknown = Reflect.get(
              Object(mutation),
              'acquisitionId',
            );
            const gate =
              method === 'core.chat.queue.entry.force'
                ? (core.forceGate ?? Promise.resolve())
                : Reflect.get(Object(mutation), 'kind') === 'edit'
                  ? (core.queueEditGate ?? Promise.resolve())
                  : Promise.resolve();
            return gate.then(() =>
              ok({
                commandId,
                revision: core.revision,
                outcome: 'applied',
                // A hold: a new one, or the one a renew names.
                ...(lock
                  ? {
                      acquisitionId:
                        typeof acquisitionId === 'string'
                          ? acquisitionId
                          : `hold-${(core.holds += 1)}`,
                      serverTime: '2026-11-13T09:00:00.000Z',
                      expiresAt: '2026-11-13T09:00:30.000Z',
                    }
                  : {}),
              }),
            );
          }
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
  core.sendsDuringRebuild = 0;
  core.rebuildRetryMs = 1;
  core.setModelRefusal = null;
  core.model = undefined;
  core.harness = undefined;
  core.chatHarness = {};
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
  /** Labelled Cancelled, as the shared transcript shows the row (CAN-6689). */
  readonly cancelled?: true;
  /** The chips a prompt shows, as each names its attachment (CAN-6771). */
  readonly attachments?: string[];
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
  /** The opened chat's queued rows as the web's thread reads them. */
  readonly queue: () => { id: string; text: string | undefined }[];
  /** Reads the opened chat's queue again, as the web's thread does. */
  readonly refreshQueue: () => void;
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
          ...(message.status === 'cancelled' ? { cancelled: true } : {}),
          ...(message.attachments !== undefined &&
          message.attachments.length > 0
            ? {
                attachments: message.attachments.map((file) =>
                  cloudAttachmentPath(file.attachmentId, file.filename),
                ),
              }
            : {}),
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
    queue: () =>
      (thread.getQueue()?.entries ?? []).map((entry) => ({
        id: entry.id,
        text: entry.text,
      })),
    refreshQueue: () => thread.refreshQueue(),
  };
}

/**
 * The desktop: the web core backend under the store's own revisioned sync,
 * snapshot install, change reducer and transcript page install.
 */
function desktopPath(
  io: Side,
  options: {
    readonly liveHoldMs?: number;
    readonly echoWaitMs?: number;
    readonly publishAgentTasks?: (
      scope: { readonly projectId: string; readonly worktreeId: string },
      chatId: string,
      tasks: readonly AgentTaskRow[],
    ) => void;
    readonly onWorkspaceFilesChanged?: (scope: {
      readonly projectId: string;
      readonly worktreeId: string;
    }) => void;
    /** Whether the task's events carry sandbox.changed (CAN-6841). */
    readonly sandboxStatesServed?: () => boolean;
  } = {},
): {
  readonly backend: ReturnType<typeof createWebCoreChatBackendCore>;
  /** The task's tabs and archive rows as the store holds them. */
  readonly tabs: () => { id: string; status?: string }[];
  readonly activeTabId: () => string | undefined;
  /** A tab's model as the store holds it. */
  readonly model: (id: string) => string | undefined;
  /** The harness a tab's chat runs on, as the store holds it (CAN-6761). */
  readonly harness: (id: string) => string | undefined;
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
  /** The turn ends the store records for the chat, by its prompt's id. */
  readonly turnEnds: () => PersistedChatTab['turnEnds'];
  /** The chat's usage meter as the store holds it (CAN-6755). */
  readonly usage: () => PersistedChatTab['usage'];
  /** Whether the backend publishes the chat's sent turn as maybe starting. */
  readonly starting: () => boolean;
  /** The chat's sandbox state as the backend publishes it (CAN-6766). */
  readonly sandbox: () => string | undefined;
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
  const startingChats = new Set<string>();
  const sandboxes = new Map<string, string>();
  let projection: CanonicalScopeProjection | null = null;
  const backend = createWebCoreChatBackendCore({
    invoker: () => io.invoker,
    newId: () => crypto.randomUUID(),
    reopenDelayMs: 0,
    liveReopenDelayMs: 0,
    liveHoldMs: options.liveHoldMs ?? 60_000,
    ...(options.echoWaitMs === undefined
      ? {}
      : { echoWaitMs: options.echoWaitMs }),
    ...(options.publishAgentTasks === undefined
      ? {}
      : { publishAgentTasks: options.publishAgentTasks }),
    ...(options.onWorkspaceFilesChanged === undefined
      ? {}
      : { onWorkspaceFilesChanged: options.onWorkspaceFilesChanged }),
    ...(options.sandboxStatesServed === undefined
      ? {}
      : { sandboxStatesServed: options.sandboxStatesServed }),
    publishLive: (_key, chat) => {
      live = chat;
    },
    publishTurnStarting: (key, starting) => {
      if (starting) startingChats.add(key);
      else startingChats.delete(key);
    },
    publishSandbox: (key, sandbox) => {
      sandboxes.set(key, sandbox.state);
    },
    // As the store answers: whether its own runtime runs the chat's turn.
    storeRunsTurn: (target) =>
      runtimeRunsTurn(projection?.runtimeByChatId[target.chatId]),
  });

  async function loadPages(): Promise<void> {
    if (projection === null) return;
    const pages = new Map(
      await Promise.all(
        projection.chatState.tabs
          .filter((tab) => tab.transcriptLoaded === false)
          .map(
            async (tab) =>
              [
                tab.id,
                // The store's loader asks for the turn view.
                await backend.getTranscriptPage({
                  ...SCOPE,
                  chatId: tab.id,
                  view: 'turns',
                }),
              ] as const,
          ),
      ),
    );
    if (projection === null) return;
    // As the store installs a page: into the tab as it holds it then, so a
    // change applied while the page loaded stays.
    projection = {
      ...projection,
      chatState: {
        ...projection.chatState,
        tabs: projection.chatState.tabs.map((tab) => {
          const page = pages.get(tab.id);
          return page === undefined || tab.transcriptLoaded !== false
            ? tab
            : installTranscriptPage(tab, page, false);
        }),
      },
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
        backend.storeRuntimesChanged();
        void loadPages();
      },
      applyCommittedEvent: (event): void => {
        if (projection === null) return;
        projection = applyCanonicalChanges(projection, event.changes, SCOPE);
        backend.storeRuntimesChanged();
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
    harness: (id) =>
      projection?.chatState.tabs.find((each) => each.id === id)
        ?.capturedHarness,
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
    turnEnds: () =>
      projection?.chatState.tabs.find((each) => each.id === CHAT_KEY)?.turnEnds,
    usage: () =>
      projection?.chatState.tabs.find((each) => each.id === CHAT_KEY)?.usage,
    starting: () =>
      startingChats.has(`${SCOPE.projectId}/${SCOPE.worktreeId}/${CHAT_KEY}`),
    sandbox: () =>
      sandboxes.get(`${SCOPE.projectId}/${SCOPE.worktreeId}/${CHAT_KEY}`),
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
          // As the shared transcript labels the row.
          ...(persistedMessageToPortalMessage({
            scope: 'worktree',
            chatId: CHAT_KEY,
            message,
          }).status === 'cancelled'
            ? { cancelled: true }
            : {}),
          ...((message.attachmentPaths?.length ?? 0) > 0
            ? { attachments: message.attachmentPaths }
            : {}),
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

it("a cloud chat's file tab stays in the window through the next snapshot and never reaches the web core (CAN-6587)", async () => {
  core.revision = 40;
  core.status = 'idle';
  core.activeTurnId = undefined;
  core.messages = [U1, A1];
  core.chats = [{ chatId: CHAT, title: 'Plan', state: 'idle' }];
  const io = side();
  const desktop = desktopPath(io);
  await settle();
  const local = (
    command: ChatCommandRequest['command'],
  ): ChatCommandRequest => ({
    schemaVersion: 1,
    commandId: crypto.randomUUID(),
    ...SCOPE,
    command,
  });
  const calls = io.calls.length;

  // The web core holds no file tabs and refuses one: a file the viewer opens
  // is kept by the window, as the web keeps its own viewers.
  await expect(
    desktop.backend.command(
      local({
        type: 'chat.create_file_tab',
        tabId: 'file-1',
        filePath: 'web-core:chat/root/notes/checklist.md',
        title: 'checklist.md',
      }),
    ),
  ).resolves.toMatchObject({ outcome: 'applied' });
  await desktop.backend.command(
    local({
      type: 'chat.patch_tab_settings',
      tabId: 'file-1',
      patch: { filePath: 'web-core:chat/root/LAUNCH.md', title: 'LAUNCH.md' },
    }),
  );
  expect(io.calls.slice(calls).map((call) => call.method)).toEqual([]);

  // A refresh keeps it beside the cloud chat, still the active tab.
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
  expect(desktop.tabs().map((tab) => tab.id)).toEqual([CHAT_KEY, 'file-1']);
  expect(desktop.activeTabId()).toBe('file-1');

  // Closing it closes it here: no tab change ever reached the web core.
  await desktop.backend.command(
    local({ type: 'chat.close_tab', tabId: 'file-1', mode: 'discard_empty' }),
  );
  const writes = new Set([
    'core.chat.create',
    'core.chat.update',
    'core.chat.delete',
    'core.chat.archive',
  ]);
  expect(
    io.calls
      .slice(calls)
      .filter((call) => writes.has(call.method))
      .map((call) => call.method),
  ).toEqual([]);
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

  // A queued turn names no id yet (the web core reports Core's session as
  // awaiting input, with the turn's prompt queued); Stop still cancels the
  // receipt's turn.
  await desktop.send('paged');
  core.revision = 51;
  io.latest.get('core.chat.events')?.push(
    batch(50, 51, [
      {
        type: 'runtime.patched',
        chatId: CHAT,
        runtime: {
          status: 'awaiting_input',
          queuedMessageIds: ['paged-u'],
        },
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
        runtime: {
          status: 'awaiting_input',
          queuedMessageIds: ['u3'],
        },
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
        runtime: {
          status: 'awaiting_input',
          queuedMessageIds: ['u2'],
        },
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

it('holds a send made during a worktree rebuild and resends it under its command, never refused (REG-3119)', async () => {
  const io = side();
  const desktop = desktopPath(io);
  await settle();
  // Refused at admission, before any Core post: the same command is safe.
  core.sendsDuringRebuild = 2;
  const result = await desktop.backend.sendMessage({
    ...SCOPE,
    chatId: CHAT_KEY,
    userMessageId: 'desktop-rebuild',
    text: 'next',
  });
  expect(result).toBeDefined();
  const sends = io.calls.filter(
    (call) => call.method === 'core.chat.message.send',
  );
  expect(sends).toHaveLength(3);
  expect(new Set(sends.map((call) => call.params.commandId)).size).toBe(1);
  // Never treated as a lost send: no receipt read.
  expect(
    io.calls.filter((call) => call.method === 'core.chat.send.receipt'),
  ).toEqual([]);

  // The connection ends while the send waits: the send fails unsent, and the
  // connection that replaces it never posts it outside its claim.
  core.sendsDuringRebuild = 1;
  core.rebuildRetryMs = 60_000;
  const held = desktop.backend.sendMessage({
    ...SCOPE,
    chatId: CHAT_KEY,
    userMessageId: 'desktop-rebuild-closed',
    text: 'next',
  });
  await settle();
  const sentBeforeClose = io.calls.filter(
    (call) => call.method === 'core.chat.message.send',
  ).length;
  desktop.backend.closeAll();
  await expect(held).rejects.toMatchObject({ code: 'capability_unavailable' });
  expect(
    io.calls.filter((call) => call.method === 'core.chat.message.send'),
  ).toHaveLength(sentBeforeClose);
});

it('drops a send whose worktree rebuild outlasts the wait unsent, never posting it after the deadline (REG-3119)', async () => {
  const io = side();
  const desktop = desktopPath(io);
  await settle();
  const sends = (): number =>
    io.calls.filter((call) => call.method === 'core.chat.message.send').length;
  const before = sends();
  // Posts at 0, 4 and 8 minutes; the last wait ends at the 10-minute
  // deadline, not at the Retry-After's 12.
  core.sendsDuringRebuild = 100;
  core.rebuildRetryMs = 4 * 60_000;
  jest.useFakeTimers();
  try {
    let settled = false;
    const outcome = desktop.backend
      .sendMessage({
        ...SCOPE,
        chatId: CHAT_KEY,
        userMessageId: 'desktop-rebuild-expired',
        text: 'next',
      })
      .then(
        () => null,
        (error: unknown) => error,
      )
      .finally(() => {
        settled = true;
      });
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(settled).toBe(true);
    expect(sends()).toBe(before + 3);
    await jest.advanceTimersByTimeAsync(3 * 60_000);
    const error = await outcome;
    expect(sends()).toBe(before + 3);
    // Refused before any post: the composer takes it back, with no receipt
    // read as for a send that may have landed.
    expect(error).toBeInstanceOf(WebCoreSendRefusedError);
    expect(
      io.calls.filter((call) => call.method === 'core.chat.send.receipt'),
    ).toEqual([]);
  } finally {
    jest.useRealTimers();
  }
});

it('drops a send stopped while a worktree rebuild holds it unsent, never posting it again (REG-3119)', async () => {
  const io = side();
  const desktop = desktopPath(io);
  await settle();
  const sends = (): number =>
    io.calls.filter((call) => call.method === 'core.chat.message.send').length;
  const before = sends();
  core.sendsDuringRebuild = 100;
  core.rebuildRetryMs = 60_000;
  jest.useFakeTimers();
  try {
    const outcome = desktop.backend
      .sendMessage({
        ...SCOPE,
        chatId: CHAT_KEY,
        userMessageId: 'desktop-rebuild-stopped',
        text: 'next',
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    await jest.advanceTimersByTimeAsync(1_000);
    expect(sends()).toBe(before + 1);
    // Stop during the Retry-After wait ends it: nothing more is posted.
    const stopped = desktop.backend.cancel({ ...SCOPE, chatId: CHAT_KEY });
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    expect(sends()).toBe(before + 1);
    const error = await outcome;
    // Never posted past the refusal: the composer takes it back, with no
    // receipt read and no turn to cancel.
    expect(error).toBeInstanceOf(WebCoreSendRefusedError);
    await expect(stopped).resolves.toEqual({ outcome: 'turn_not_active' });
    expect(
      io.calls.filter(
        (call) =>
          call.method === 'core.chat.send.receipt' ||
          call.method === 'core.chat.turn.cancel',
      ),
    ).toEqual([]);
  } finally {
    jest.useRealTimers();
  }
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
        runtime: {
          status: 'streaming',
          queuedMessageIds: [],
          activeTurnId: 't4',
        },
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
  const filesChanged: unknown[] = [];
  const backend = createWebCoreChatBackendCore({
    invoker: () => ({
      request: (method, params): Promise<CanopyCoreRelayLikeReply> => {
        // The web core's copy of the sent message names its attachment, as
        // its transcript carries it (CAN-6771).
        if (method === 'core.chat.transcript.page')
          return Promise.resolve({
            ok: true,
            value: {
              messages: [
                {
                  ...text('u-attach', 'user', 'See the brief', 7),
                  attachments: [
                    {
                      attachmentId: 'att-1',
                      filename: 'brief.md',
                      mediaType: 'text/markdown',
                      size: 7,
                    },
                  ],
                },
              ],
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
    onWorkspaceFilesChanged: (scope) => filesChanged.push(scope),
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

  // The send carries the upload's id, as the catalog takes it. Once it
  // lands, the project's workspace files are read again, as the web's are,
  // so the attachment shows in Workspace files at once (CAN-6645).
  expect(filesChanged).toEqual([]);
  await backend.sendMessage({
    ...target,
    userMessageId: 'u-attach',
    text: 'See the brief',
    attachmentPaths: [uploaded.attachment.absolutePath],
  });
  expect(sends).toHaveLength(1);
  expect(sends[0]?.attachments).toEqual([{ attachmentId: 'att-1' }]);
  expect(filesChanged).toEqual([SCOPE]);
  expect(CoreChatMessageSendParamsSchema.safeParse(sends[0]).success).toBe(
    true,
  );
  // The web core's copy of that message names the attachment it was sent
  // with, once: the chip the send showed is the one its transcript names.
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

it('a cloud send waits for a model pick in flight, so its turn runs with the model just chosen', async () => {
  core.revision = 75;
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

  let applied = (): void => undefined;
  core.updateGate = new Promise<void>((resolve) => {
    applied = resolve;
  });
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
  const send = backend.sendMessage({
    ...SCOPE,
    chatId: CHAT_KEY,
    userMessageId: 'desktop-after-pick',
    text: 'after-save',
  });
  await settle();
  // Nothing goes to the web core while the model is still saving.
  expect(sends()).toBe(0);
  core.updateGate = null;
  applied();
  await pick;
  await send;
  expect(sends()).toBe(1);
});

it('a cloud send waits for a plugins save still running after a quicker model pick lands', async () => {
  core.revision = 76;
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
  await backend.command({
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
  const send = backend.sendMessage({
    ...SCOPE,
    chatId: CHAT_KEY,
    userMessageId: 'desktop-after-both',
    text: 'after-save',
  });
  await settle();
  // The model pick landed; the plugins save it joined still runs.
  expect(sends()).toBe(0);
  saved();
  await send;
  expect(sends()).toBe(1);
});

it("a cloud chat's task rows follow the web core's events, and a snapshot read before a newer task event never brings its older state back", async () => {
  core.revision = 140;
  core.status = 'idle';
  core.activeTurnId = undefined;
  core.messages = [U1];
  core.chats = [{ chatId: CHAT, title: 'Plan', state: 'idle' }];
  const task = (status: string): Record<string, unknown> => ({
    stateVersion: status === 'running' ? '1' : '2',
    taskId: 'task-sub',
    kind: 'subagent',
    harness: 'CLAUDE_CODE',
    status,
    stopReason: null,
    native: {},
    parentTaskId: null,
    spawnTurnId: null,
    spawnToolCallId: 'toolu_spawn',
    title: null,
    description: 'Survey the repo',
    prompt: null,
    subagentType: null,
    thinkingEffort: null,
    costUsd: null,
    summary: null,
    outputTail: null,
    model: null,
    usage: null,
    error: null,
    createdAtMs: 1_000,
    startedAtMs: 1_000,
    updatedAtMs: 1_000,
    completedAtMs: status === 'running' ? null : 2_000,
    approvalPending: false,
    background: true,
  });
  core.tasks = { [CHAT]: [task('running')] };
  const published: string[][] = [];
  const io = side();
  const desktop = desktopPath(io, {
    publishAgentTasks: (_scope, chatId, tasks) => {
      if (chatId === CHAT_KEY) published.push(tasks.map((each) => each.status));
    },
  });
  await settle();
  expect(published.at(-1)).toEqual(['running']);

  // A refresh reads the snapshot while the task completes.
  let served = (): void => undefined;
  core.snapshotGate = new Promise<void>((resolve) => {
    served = resolve;
  });
  const refresh = desktop.backend.getState(SCOPE);
  await settle();
  io.latest.get('core.chat.events')?.push(
    batch(140, 141, [
      {
        type: 'agent_tasks.replaced',
        chatId: CHAT,
        tasks: [task('completed')],
      },
    ]),
  );
  await settle();
  expect(published.at(-1)).toEqual(['completed']);
  core.snapshotGate = null;
  served();
  await refresh;
  await settle();
  expect(published.at(-1)).toEqual(['completed']);
  core.tasks = {};
});

it("publishes the chat's sandbox state under its live key, from its snapshot and each sandbox.changed; a snapshot without one leaves it (CAN-6766)", async () => {
  core.revision = 160;
  core.status = 'idle';
  core.activeTurnId = undefined;
  core.messages = [U1];
  core.sandbox = { state: 'asleep' };
  const io = side();
  const desktop = desktopPath(io);
  await settle();
  expect(desktop.sandbox()).toBe('asleep');

  io.latest
    .get('core.chat.events')
    ?.push(
      batch(160, 161, [
        { type: 'sandbox.changed', chatId: CHAT, sandbox: { state: 'waking' } },
      ]),
    );
  await settle();
  expect(desktop.sandbox()).toBe('waking');

  io.latest
    .get('core.chat.events')
    ?.push(
      batch(161, 162, [
        { type: 'sandbox.changed', chatId: CHAT, sandbox: { state: 'ready' } },
      ]),
    );
  await settle();
  expect(desktop.sandbox()).toBe('ready');

  // A snapshot that does not report one (the desktop core) leaves it.
  core.sandbox = undefined;
  await desktop.backend.getState(SCOPE);
  await settle();
  expect(desktop.sandbox()).toBe('ready');
});

it("holds a snapshot's sandbox state, unknown, while the task's events carry no sandbox.changed, and publishes it once they do; sandbox.changed then keeps it current (CAN-6841)", async () => {
  core.revision = 180;
  core.status = 'idle';
  core.activeTurnId = undefined;
  core.messages = [U1];
  core.sandbox = { state: 'asleep' };
  // The web core is described as advertising events below revision 3, or
  // not described yet: nothing would keep the state current.
  let served = false;
  const io = side();
  const desktop = desktopPath(io, { sandboxStatesServed: () => served });
  await settle();
  expect(desktop.sandbox()).toBeUndefined();
  // A newer snapshot is held in its place, still unpublished.
  core.sandbox = { state: 'waking' };
  core.revision = 181;
  await desktop.backend.getState(SCOPE);
  await settle();
  expect(desktop.sandbox()).toBeUndefined();

  // Described as serving them: the newest held state publishes.
  served = true;
  desktop.backend.releaseSandboxStates();
  await settle();
  expect(desktop.sandbox()).toBe('waking');

  // sandbox.changed keeps it current.
  io.latest
    .get('core.chat.events')
    ?.push(
      batch(181, 182, [
        { type: 'sandbox.changed', chatId: CHAT, sandbox: { state: 'ready' } },
      ]),
    );
  await settle();
  expect(desktop.sandbox()).toBe('ready');
});

it('keeps a newer sandbox.changed over a snapshot read before it that lands after it (CAN-6766)', async () => {
  core.revision = 170;
  core.status = 'idle';
  core.activeTurnId = undefined;
  core.messages = [U1];
  core.sandbox = { state: 'ready' };
  const io = side();
  const desktop = desktopPath(io);
  await settle();
  expect(desktop.sandbox()).toBe('ready');

  // A refresh reads the snapshot at revision 170, which still says asleep,
  // and the web core then reports waking at revision 171 before it lands.
  core.sandbox = { state: 'asleep' };
  let served = (): void => undefined;
  core.snapshotGate = new Promise<void>((resolve) => {
    served = resolve;
  });
  const refresh = desktop.backend.getState(SCOPE);
  await settle();
  io.latest
    .get('core.chat.events')
    ?.push(
      batch(170, 171, [
        { type: 'sandbox.changed', chatId: CHAT, sandbox: { state: 'waking' } },
      ]),
    );
  await settle();
  expect(desktop.sandbox()).toBe('waking');
  core.snapshotGate = null;
  served();
  await refresh;
  await settle();
  expect(desktop.sandbox()).toBe('waking');
  core.sandbox = undefined;
});

it('drops the meter an events revision 3 message carries, so the store keeps messages as its revision 1 transcript pages give them (CAN-6766)', () => {
  const item = parseEventItem(
    batch(1, 2, [
      {
        type: 'message.upserted',
        chatId: CHAT,
        message: { ...A1, meter: { usage: { outputTokens: 12 } } },
      },
    ]).item,
  );
  const same = (id: string): string => id;
  const change = translateChange(item.changes[0], new Map(), {
    chatToStore: same,
    chatToCore: same,
    newChatToCore: same,
    messageToStore: same,
    messageToCore: same,
  });
  expect(change).toMatchObject({ type: 'message.upserted' });
  expect(
    change !== null && 'message' in change ? change.message : null,
  ).toEqual(A1);
});

it("after a resync, every chat this window read shows its tasks' current state, not only the opened chat's (CAN-6475)", async () => {
  core.revision = 150;
  core.status = 'idle';
  core.activeTurnId = undefined;
  core.messages = [U1];
  core.chats = [
    { chatId: CHAT, title: 'Plan', state: 'idle' },
    { chatId: 'chat-2', title: 'Notes', state: 'idle' },
  ];
  const task = (status: string): Record<string, unknown> => ({
    stateVersion: status === 'running' ? '1' : '2',
    taskId: 'task-sibling',
    kind: 'subagent',
    harness: 'CLAUDE_CODE',
    status,
    stopReason: null,
    native: {},
    parentTaskId: null,
    spawnTurnId: null,
    spawnToolCallId: 'toolu_sibling',
    title: null,
    description: 'Check the notes',
    prompt: null,
    subagentType: null,
    thinkingEffort: null,
    costUsd: null,
    summary: null,
    outputTail: null,
    model: null,
    usage: null,
    error: null,
    createdAtMs: 1_000,
    startedAtMs: 1_000,
    updatedAtMs: 1_000,
    completedAtMs: status === 'running' ? null : 2_000,
    approvalPending: false,
    background: true,
  });
  core.tasks = { 'chat-2': [task('running')] };
  const published: string[][] = [];
  const io = side();
  const desktop = desktopPath(io, {
    publishAgentTasks: (_scope, chatId, tasks) => {
      if (chatId === 'web-core:chat-2')
        published.push(tasks.map((each) => each.status));
    },
  });
  await settle();
  // The sibling chat is shown: its own snapshot brings its task.
  await desktop.backend.getTranscriptPage({
    ...SCOPE,
    chatId: 'web-core:chat-2',
    view: 'turns',
  });
  await settle();
  expect(published.at(-1)).toEqual(['running']);

  // Its task completes while the events are missed, and the stream resyncs.
  core.tasks = { 'chat-2': [task('completed')] };
  core.revision = 152;
  io.latest.get('core.chat.events')?.push({
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
  expect(published.at(-1)).toEqual(['completed']);
  core.tasks = {};
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

it("a finished reply keeps REST's steps on desktop, and a later step takes its row's update (CAN-6116)", async () => {
  const saved = {
    messages: core.messages,
    revision: core.revision,
    status: core.status,
    activeTurnId: core.activeTurnId,
  };
  const reply = (output?: string): Record<string, unknown> => ({
    id: 'a9',
    role: 'assistant',
    timestamp: 2,
    blocks: [
      { type: 'text', text: 'Starting.' },
      { type: 'tool_use', toolUseId: 'c1', toolName: 'Bash', input: 'echo' },
      ...(output === undefined
        ? []
        : [
            {
              type: 'tool_result',
              toolUseId: 'c1',
              toolName: 'Bash',
              output,
              isError: false,
            },
          ]),
      { type: 'text', text: output === undefined ? 'Waiting.' : 'All done.' },
    ],
  });
  core.messages = [U1, reply()];
  core.revision = 4;
  core.status = 'idle';
  core.activeTurnId = undefined;
  try {
    const io = side();
    const web = webPath(io);
    await settle();
    expect(web.shown().rows.map((row) => row.id)).toEqual([
      'u1',
      'a9',
      'a9:step-1',
      'a9:step-2',
    ]);
    core.revision = 5;
    core.messages = [U1, reply('one')];
    io.latest
      .get('core.chat.events')
      ?.push(
        batch(4, 5, [
          { type: 'message.upserted', chatId: CHAT, message: reply('one') },
        ]),
      );
    await settle();
    expect(web.shown().rows.at(-1)).toMatchObject({
      id: 'a9:step-2',
      text: 'All done.',
    });
  } finally {
    Object.assign(core, saved);
  }
});

/** A turn's timer row, as the web core's transcript sends it after the turn. */
const turnTimer = (
  userMessageId: string,
  turnId: string,
  outcome: 'completed' | 'failed' | 'cancelled',
  startedAt: number,
  completedAt: number,
): Record<string, unknown> => ({
  id: `${userMessageId}:turn-timer`,
  role: 'system',
  blocks: [
    {
      type: 'turn_timer',
      turnId,
      userMessageId,
      startedAt,
      pausedAt: null,
      resumedAt: null,
      accumulatedPausedDurationMs: 0,
      completedAt,
      outcome,
    },
  ],
  timestamp: startedAt,
});

it("a cloud turn's end reads the project's workspace files again, as the web's does, so a file its agent wrote shows at once (CAN-6645)", async () => {
  core.revision = 40;
  core.status = 'streaming';
  core.activeTurnId = 't-write';
  core.messages = [U1];
  core.chats = [
    { chatId: CHAT, title: 'Plan', state: 'running' },
    { chatId: 'chat-2', title: 'Notes', state: 'running' },
  ];
  const io = side();
  const filesChanged: unknown[] = [];
  desktopPath(io, {
    onWorkspaceFilesChanged: (scope) => filesChanged.push(scope),
  });
  await settle();
  expect(filesChanged).toEqual([]);

  // The turn still runs: nothing new to read yet.
  io.latest.get('core.chat.events')?.push(
    batch(40, 41, [
      {
        type: 'runtime.patched',
        chatId: CHAT,
        runtime: {
          status: 'streaming',
          queuedMessageIds: [],
          activeTurnId: 't-write',
        },
      },
    ]),
  );
  await settle();
  expect(filesChanged).toEqual([]);

  // It ends: the project's files are read again, once.
  io.latest.get('core.chat.events')?.push(
    batch(41, 42, [
      {
        type: 'runtime.patched',
        chatId: CHAT,
        runtime: { status: 'idle', queuedMessageIds: [], activeTurnId: null },
      },
    ]),
  );
  await settle();
  expect(filesChanged).toEqual([SCOPE]);

  // An idle chat reported idle again is no new turn end.
  io.latest.get('core.chat.events')?.push(
    batch(42, 43, [
      {
        type: 'runtime.patched',
        chatId: CHAT,
        runtime: { status: 'idle', queuedMessageIds: [], activeTurnId: null },
      },
    ]),
  );
  await settle();
  expect(filesChanged).toEqual([SCOPE]);

  // A sibling the snapshot listed as running, with no turn named, ends too.
  io.latest.get('core.chat.events')?.push(
    batch(43, 44, [
      {
        type: 'runtime.patched',
        chatId: 'chat-2',
        runtime: { status: 'idle', queuedMessageIds: [], activeTurnId: null },
      },
    ]),
  );
  await settle();
  expect(filesChanged).toEqual([SCOPE, SCOPE]);

  // A new turn starts: nothing ended. A queued prompt's turn then replaces
  // it with no idle report between them, which ends the first.
  const running = (turnId: string): Record<string, unknown> => ({
    type: 'runtime.patched',
    chatId: CHAT,
    runtime: {
      status: 'streaming',
      queuedMessageIds: [],
      activeTurnId: turnId,
    },
  });
  io.latest.get('core.chat.events')?.push(batch(44, 45, [running('t-a')]));
  await settle();
  expect(filesChanged).toEqual([SCOPE, SCOPE]);
  io.latest.get('core.chat.events')?.push(batch(45, 46, [running('t-b')]));
  await settle();
  expect(filesChanged).toEqual([SCOPE, SCOPE, SCOPE]);
});

it("a cloud turn that ends while its events were missed reads the project's workspace files again once a snapshot shows it over (CAN-6645)", async () => {
  core.revision = 50;
  core.status = 'streaming';
  core.activeTurnId = 't-missed';
  core.messages = [U1];
  const io = side();
  const filesChanged: unknown[] = [];
  const desktop = desktopPath(io, {
    onWorkspaceFilesChanged: (scope) => filesChanged.push(scope),
  });
  await settle();
  expect(filesChanged).toEqual([]);

  // A snapshot read while it still runs ends nothing.
  await desktop.backend.getState(SCOPE);
  expect(filesChanged).toEqual([]);

  // The turn ends, but its events are missed: the resync's snapshot shows
  // it over, and the project's files are read again, once.
  core.revision = 52;
  core.status = 'idle';
  core.activeTurnId = undefined;
  await desktop.backend.getState(SCOPE);
  expect(filesChanged).toEqual([SCOPE]);
  await desktop.backend.getState(SCOPE);
  expect(filesChanged).toEqual([SCOPE]);
});

it("a cloud chat's queued prompts show on desktop as the web shows them, in every tab, and Remove cancels one in Core (CAN-6644)", async () => {
  const saved = { ...core };
  const entry = (
    id: string,
    text: string,
    messageId: string,
  ): Record<string, unknown> => ({
    id,
    origin: 'portal',
    enqueuedAtMs: 4_000,
    revision: 1,
    text,
    clientRequestId: `desktop-${text}`,
    messageId,
    queueOrder: '2',
    promptSource: 'human',
  });
  try {
    core.revision = 95;
    core.status = 'streaming';
    core.activeTurnId = 't1';
    core.chats = [
      { chatId: CHAT, title: 'Plan', state: 'running' },
      { chatId: 'chat-2', title: 'Notes', state: 'running' },
    ];
    core.turns = { 'chat-2': 't20' };
    // A prompt already waits behind the task's running turn.
    core.queues = { [CHAT]: [entry('t12', 'second', 'second-u')] };
    const io = side();
    const desktop = desktopPath(io);
    const web = webPath(side());
    await settle();
    const updates: ChatQueueUpdatedEvent[] = [];
    closers.push(
      desktop.backend.onQueueUpdated((event) => updates.push(event)),
    );

    // The desktop's queued rows are the web's, read from the same snapshot.
    const desktopRows = (await desktop.backend.getState(SCOPE)).queue
      .find((summary) => summary.chatId === CHAT_KEY)
      ?.queue.map((row) => ({ id: row.id, text: row.text }));
    expect(desktopRows).toEqual(web.queue());
    expect(desktopRows).toEqual([{ id: 't12', text: 'second' }]);

    // Opening another tab takes its queue from that chat's own snapshot.
    core.queues = {
      ...core.queues,
      'chat-2': [entry('t21', 'third', 'third-u')],
    };
    await desktop.backend.getTranscriptPage({
      ...SCOPE,
      chatId: 'web-core:chat-2',
    });
    await settle();
    expect(updates.at(-1)).toMatchObject({
      ...SCOPE,
      chatId: 'web-core:chat-2',
      queue: [{ id: 't21', text: 'third', revision: 1, promptSource: 'human' }],
    });
    expect(
      io.calls.some(
        (call) =>
          call.method === 'core.chat.snapshot.get' &&
          call.params.chatId === 'chat-2',
      ),
    ).toBe(true);

    // A prompt queued there shows at once, but a read older than the queue
    // since taken never replaces it.
    let release = (): void => undefined;
    core.snapshotGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    core.queues = {
      ...core.queues,
      'chat-2': [
        entry('t21', 'third', 'third-u'),
        entry('t22', 'fourth', 'fourth-u'),
      ],
    };
    core.revision = 96;
    io.latest.get('core.chat.events')?.push(
      batch(95, 96, [
        {
          type: 'runtime.patched',
          chatId: 'chat-2',
          runtime: {
            status: 'streaming',
            activeTurnId: 't20',
            queuedMessageIds: ['third-u', 'fourth-u'],
          },
        },
      ]),
    );
    await settle();
    core.snapshotGate = null;
    core.queues = {
      ...core.queues,
      'chat-2': [entry('t21', 'third', 'third-u')],
    };
    core.revision = 97;
    expect(
      (await desktop.backend.getQueue(SCOPE)).find(
        (summary) => summary.chatId === 'web-core:chat-2',
      )?.queue,
    ).toMatchObject([{ id: 't21' }]);
    release();
    await settle();
    expect(
      updates.flatMap((update) => update.queue.map((row) => row.id)),
    ).not.toContain('t22');

    // A prompt queued while its chat's queue read fails shows once the next
    // event names the same prompts: the failed read used nothing up.
    core.snapshotFailsFor = 'chat-2';
    core.queues = {
      ...core.queues,
      'chat-2': [
        entry('t21', 'third', 'third-u'),
        entry('t23', 'fifth', 'fifth-u'),
      ],
    };
    core.revision = 98;
    const named = {
      type: 'runtime.patched',
      chatId: 'chat-2',
      runtime: {
        status: 'streaming',
        activeTurnId: 't20',
        queuedMessageIds: ['third-u', 'fifth-u'],
      },
    };
    io.latest.get('core.chat.events')?.push(batch(97, 98, [named]));
    await settle();
    core.snapshotFailsFor = null;
    core.revision = 99;
    io.latest.get('core.chat.events')?.push(batch(98, 99, [named]));
    await settle();
    expect(updates.at(-1)).toMatchObject({
      chatId: 'web-core:chat-2',
      queue: [{ id: 't21' }, { id: 't23' }],
    });

    // A queue change an internal snapshot read picks up reaches the store.
    core.queues = {
      ...core.queues,
      [CHAT]: [
        entry('t12', 'second', 'second-u'),
        entry('t30', 'sixth', 'sixth-u'),
      ],
    };
    core.revision = 100;
    await desktop.backend.loadArchives(SCOPE);
    await settle();
    expect(updates.at(-1)).toMatchObject({
      chatId: CHAT_KEY,
      queue: [{ id: 't12' }, { id: 't30' }],
    });
    core.queues = {
      ...core.queues,
      [CHAT]: [entry('t12', 'second', 'second-u')],
      'chat-2': [entry('t21', 'third', 'third-u')],
    };
    core.revision = 101;

    // Remove sends the entry's revision; a stale one is refused, not applied.
    core.cancelOutcome = 'conflict';
    await expect(
      desktop.backend.cancelQueued({
        ...SCOPE,
        chatId: 'web-core:chat-2',
        entryId: 't21',
      }),
    ).rejects.toThrow('The queued message changed.');
    core.cancelOutcome = 'applied';
    await desktop.backend.cancelQueued({
      ...SCOPE,
      chatId: 'web-core:chat-2',
      entryId: 't21',
    });
    expect(
      io.calls
        .filter((call) => call.method === 'core.chat.queue.entry.cancel')
        .map((call) => call.params),
    ).toMatchObject([
      { chatId: 'chat-2', entryId: 't21', entryRevision: 1 },
      { chatId: 'chat-2', entryId: 't21', entryRevision: 1 },
    ]);

    // After a resync, which reads only the task chat's exact runtime, both
    // chats' rows leave once their prompts start.
    await desktop.backend.getState(SCOPE);
    core.queues = {};
    core.revision = 102;
    io.latest.get('core.chat.events')?.push(
      batch(101, 102, [
        {
          type: 'runtime.patched',
          chatId: CHAT,
          runtime: {
            status: 'streaming',
            activeTurnId: 't12',
            queuedMessageIds: [],
          },
        },
        {
          type: 'runtime.patched',
          chatId: 'chat-2',
          runtime: {
            status: 'streaming',
            activeTurnId: 't21',
            queuedMessageIds: [],
          },
        },
      ]),
    );
    await settle();
    expect(
      updates
        .filter((update) => update.queue.length === 0)
        .map((update) => update.chatId),
    ).toEqual(expect.arrayContaining([CHAT_KEY, 'web-core:chat-2']));
  } finally {
    Object.assign(core, saved);
  }
});

it('a queued cloud prompt shows on desktop as on web: queued, then cancelled or started (CAN-6689)', async () => {
  const saved = { ...core };
  const entry = (id: string, body: string): Record<string, unknown> => ({
    id,
    origin: 'portal',
    enqueuedAtMs: 4_000,
    revision: 1,
    text: body,
    clientRequestId: `desktop-${body}`,
    messageId: `${id}-u`,
    queueOrder: '2',
    promptSource: 'human',
  });
  try {
    core.revision = 95;
    core.status = 'streaming';
    core.activeTurnId = 't1';
    core.chats = [{ chatId: CHAT, title: 'Plan', state: 'running' }];
    core.messages = [U1, A1];
    const webIo = side();
    const desktopIo = side();
    const web = webPath(webIo);
    const desktop = desktopPath(desktopIo);
    const both = (frame: unknown): void => {
      for (const io of [webIo, desktopIo])
        io.latest.get('core.chat.events')?.push(frame);
    };
    const runtime = (
      queued: string[],
      activeTurnId = 't1',
    ): Record<string, unknown> => ({
      type: 'runtime.patched',
      chatId: CHAT,
      runtime: { status: 'streaming', activeTurnId, queuedMessageIds: queued },
    });
    await settle();

    // Queued behind the running turn: a queue row on both, in neither
    // transcript, so the running reply stays under its own prompt.
    core.queues = { [CHAT]: [entry('t12', 'later'), entry('t13', 'after')] };
    core.revision = 96;
    both(batch(95, 96, [runtime(['t12-u', 't13-u'])]));
    await settle();
    expect(desktop.shown()).toEqual(web.shown());
    expect(web.shown().rows.map((row) => row.id)).toEqual(['u1', 'a1']);

    // Deleted from the queue: the web core keeps the prompt, marked
    // cancelled, and both read it Cancelled.
    const cancelled = { ...text('t12-u', 'user', 'later', 4), cancelled: true };
    core.queues = { [CHAT]: [entry('t13', 'after')] };
    core.messages = [U1, A1, cancelled];
    core.revision = 97;
    both(
      batch(96, 97, [
        { type: 'message.upserted', chatId: CHAT, message: cancelled },
        runtime(['t13-u']),
      ]),
    );
    await settle();
    expect(desktop.shown()).toEqual(web.shown());
    expect(web.shown().rows.at(-1)).toEqual({
      id: 't12-u',
      role: 'user',
      text: 'later',
      provisional: false,
      cancelled: true,
    });

    // Started: the prompt joins the transcript as Core starts its turn, with
    // no label.
    const started = text('t13-u', 'user', 'after', 5);
    core.queues = {};
    core.messages = [U1, A1, cancelled, started];
    core.revision = 98;
    both(
      batch(97, 98, [
        { type: 'message.upserted', chatId: CHAT, message: started },
        runtime([], 't13'),
      ]),
    );
    await settle();
    expect(desktop.shown()).toEqual(web.shown());
    expect(web.shown().rows.at(-1)).toEqual({
      id: 't13-u',
      role: 'user',
      text: 'after',
      provisional: false,
    });
  } finally {
    Object.assign(core, saved);
  }
});

it("Edit and Run now on a cloud chat's queued prompt reach Core at its revision, holding it while edited, and a stale revision is refused (CAN-6651)", async () => {
  const saved = { ...core };
  const entry = (
    id: string,
    text: string,
    revision = 1,
  ): Record<string, unknown> => ({
    id,
    origin: 'portal',
    enqueuedAtMs: 4_000,
    revision,
    text,
    clientRequestId: `desktop-${id}`,
    messageId: `${id}-u`,
    queueOrder: '2',
    promptSource: 'human',
  });
  try {
    core.revision = 95;
    core.status = 'streaming';
    core.activeTurnId = 't1';
    core.chats = [{ chatId: CHAT, title: 'Plan', state: 'running' }];
    core.queuedEditHold = true;
    core.holds = 0;
    core.queues = {
      [CHAT]: [entry('t12', 'second'), entry('t13', 'third')],
    };
    const io = side();
    const desktop = desktopPath(io);
    const web = webPath(side());
    await settle();
    const chat = createWebCoreChatBackend(desktop.backend).chat;
    await desktop.backend.getQueue(SCOPE);
    const second = { ...SCOPE, chatId: CHAT_KEY, entryId: 't12' };
    const third = { ...SCOPE, chatId: CHAT_KEY, entryId: 't13' };
    const queueCalls = (): Record<string, unknown>[] =>
      io.calls
        .filter(
          (call) =>
            call.method === 'core.chat.queue.entry.update' ||
            call.method === 'core.chat.queue.entry.force',
        )
        .map((call) => ({ method: call.method, ...call.params }));

    // Edit holds the entry while it is edited, then saves the new text under
    // that hold, at the revision the queue was read at.
    await chat.setQueuedMessageEditLock({ ...second, locked: true });
    core.revision = 96;
    core.queues = {
      [CHAT]: [entry('t12', 'second, edited', 2), entry('t13', 'third')],
    };
    // As the queued-message editor saves it, with its input mode.
    await chat.editQueuedMessage({
      ...second,
      text: 'second, edited',
      inputMode: 'typed',
    });
    await settle();
    expect(queueCalls()).toMatchObject([
      {
        method: 'core.chat.queue.entry.update',
        chatId: CHAT,
        entryId: 't12',
        entryRevision: 1,
        mutation: { kind: 'lock', locked: true },
      },
      {
        method: 'core.chat.queue.entry.update',
        chatId: CHAT,
        entryId: 't12',
        entryRevision: 1,
        mutation: {
          kind: 'edit',
          text: 'second, edited',
          acquisitionId: 'hold-1',
        },
      },
    ]);

    // Desktop and web show the same queued rows after the edit.
    web.refreshQueue();
    await settle();
    const desktopRows = (await desktop.backend.getQueue(SCOPE))
      .find((summary) => summary.chatId === CHAT_KEY)
      ?.queue.map((row) => ({ id: row.id, text: row.text }));
    expect(desktopRows).toEqual([
      { id: 't12', text: 'second, edited' },
      { id: 't13', text: 'third' },
    ]);
    expect(desktopRows).toEqual(web.queue());

    // An editor closed without saving releases the hold it took.
    await chat.setQueuedMessageEditLock({ ...third, locked: true });
    await chat.setQueuedMessageEditLock({ ...third, locked: false });
    expect(queueCalls().slice(2)).toMatchObject([
      { entryId: 't13', mutation: { kind: 'lock', locked: true } },
      {
        entryId: 't13',
        mutation: { kind: 'lock', locked: false, acquisitionId: 'hold-2' },
      },
    ]);

    // Forcing the entry while a turn runs is Interrupt, as on a local
    // chat: the web core's force moves the entry to the front at its
    // revision, and the running turn is stopped so the entry runs now.
    await chat.forceQueuedMessage(third);
    await settle();
    expect(queueCalls().at(-1)).toMatchObject({
      method: 'core.chat.queue.entry.force',
      chatId: CHAT,
      entryId: 't13',
      entryRevision: 1,
    });
    expect(
      io.calls
        .filter((call) => call.method === 'core.chat.turn.cancel')
        .map((call) => call.params),
    ).toMatchObject([{ chatId: CHAT, turnId: 't1' }]);

    // Run now stops only the turn that ran when it was pressed: once the
    // forced entry's own turn runs before the force's reply lands, that turn
    // is left running (review round 3).
    let releaseForce = (): void => undefined;
    core.forceGate = new Promise<void>((resolve) => {
      releaseForce = resolve;
    });
    const forcing = chat.forceQueuedMessage(second);
    await settle();
    core.revision = 97;
    core.activeTurnId = 't12';
    io.latest.get('core.chat.events')?.push(
      batch(96, 97, [
        {
          type: 'runtime.patched',
          chatId: CHAT,
          runtime: {
            status: 'streaming',
            queuedMessageIds: [],
            activeTurnId: 't12',
          },
        },
      ]),
    );
    await settle();
    releaseForce();
    core.forceGate = null;
    await forcing;
    await settle();
    expect(
      io.calls
        .filter((call) => call.method === 'core.chat.turn.cancel')
        .map((call) => call.params.turnId),
    ).toEqual(['t1']);

    // A stale revision is refused, not applied to the entry as it is now,
    // and the queue is read again so the row shows its current state.
    core.queueOutcome = 'conflict';
    const reads = io.calls.filter(
      (call) => call.method === 'core.chat.snapshot.get',
    ).length;
    await expect(
      chat.editQueuedMessage({ ...third, text: 'stale' }),
    ).rejects.toThrow('The queued message changed.');
    await expect(chat.forceQueuedMessage(third)).rejects.toThrow(
      'The queued message changed.',
    );
    await settle();
    expect(
      io.calls.filter((call) => call.method === 'core.chat.snapshot.get')
        .length,
    ).toBeGreaterThan(reads);

    core.queueOutcome = 'applied';

    // An edit goes at the revision its editor opened at, so a draft another
    // client's edit made stale is refused, not saved over that edit: here
    // with no hold, as once a hold is lost (review round 4).
    core.queuedEditHold = false;
    await desktop.backend.getQueue(SCOPE);
    await chat.setQueuedMessageEditLock({ ...third, locked: true });
    core.revision = 98;
    core.queues = {
      [CHAT]: [
        entry('t12', 'second, edited', 2),
        entry('t13', 'third, from the web', 2),
      ],
    };
    await desktop.backend.getQueue(SCOPE);
    core.checksEntryRevision = true;
    await expect(
      chat.editQueuedMessage({ ...third, text: 'third, stale draft' }),
    ).rejects.toThrow('The queued message changed.');
    expect(queueCalls().at(-1)).toMatchObject({
      method: 'core.chat.queue.entry.update',
      entryId: 't13',
      entryRevision: 1,
      mutation: { kind: 'edit', text: 'third, stale draft' },
    });
    expect(queueCalls().at(-1)).not.toHaveProperty('mutation.acquisitionId');
    await chat.setQueuedMessageEditLock({ ...third, locked: false });
    core.checksEntryRevision = false;
    core.queuedEditHold = true;
    await desktop.backend.getQueue(SCOPE);

    // An editor reopened while its last save is in flight takes a hold and
    // an opening revision of its own once that save lands, so its later
    // stale draft is refused rather than saved over another client's edit
    // (review round 5).
    await chat.setQueuedMessageEditLock({ ...second, locked: true });
    let releaseEdit = (): void => undefined;
    core.queueEditGate = new Promise<void>((resolve) => {
      releaseEdit = resolve;
    });
    const saving = chat.editQueuedMessage({ ...second, text: 'second, mine' });
    await settle();
    const reopening = chat.setQueuedMessageEditLock({
      ...second,
      locked: true,
    });
    await settle();
    core.revision = 99;
    core.queues = {
      [CHAT]: [
        entry('t12', 'second, mine', 3),
        entry('t13', 'third, from the web', 2),
      ],
    };
    releaseEdit();
    core.queueEditGate = null;
    await saving;
    await reopening;
    await settle();
    expect(queueCalls().at(-1)).toMatchObject({
      method: 'core.chat.queue.entry.update',
      entryId: 't12',
      entryRevision: 3,
      mutation: { kind: 'lock', locked: true },
    });
    core.revision = 100;
    core.queues = {
      [CHAT]: [
        entry('t12', 'second, from the web', 4),
        entry('t13', 'third, from the web', 2),
      ],
    };
    await desktop.backend.getQueue(SCOPE);
    core.checksEntryRevision = true;
    await expect(
      chat.editQueuedMessage({ ...second, text: 'second, stale draft' }),
    ).rejects.toThrow('The queued message changed.');
    expect(queueCalls().at(-1)).toMatchObject({
      method: 'core.chat.queue.entry.update',
      entryId: 't12',
      entryRevision: 3,
      mutation: { kind: 'edit', text: 'second, stale draft' },
    });
    core.checksEntryRevision = false;
    await chat.setQueuedMessageEditLock({ ...second, locked: false });

    // Run now on a chat listed as running, whose turn no event named yet,
    // stops the turn its snapshot names (review round 4).
    core.chats = [
      { chatId: CHAT, title: 'Plan', state: 'running' },
      { chatId: 'chat-2', title: 'Notes', state: 'running' },
    ];
    core.turns = { 'chat-2': 't7' };
    await desktop.backend.getState(SCOPE);
    const cancels = io.calls.filter(
      (call) => call.method === 'core.chat.turn.cancel',
    ).length;
    await chat.forceQueuedMessage({
      ...SCOPE,
      chatId: 'web-core:chat-2',
      entryId: 't21',
    });
    await settle();
    expect(
      io.calls
        .filter((call) => call.method === 'core.chat.turn.cancel')
        .slice(cancels)
        .map((call) => call.params),
    ).toMatchObject([{ chatId: 'chat-2', turnId: 't7' }]);

    // Two locks of one entry at once keep one hold and hand the other back,
    // so none is left renewing unseen (review round 6).
    const beforeBoth = queueCalls().length;
    await Promise.all([
      chat.setQueuedMessageEditLock({ ...third, locked: true }),
      chat.setQueuedMessageEditLock({ ...third, locked: true }),
    ]);
    await settle();
    expect(queueCalls().slice(beforeBoth)).toMatchObject([
      { entryId: 't13', mutation: { kind: 'lock', locked: true } },
      { entryId: 't13', mutation: { kind: 'lock', locked: true } },
      {
        entryId: 't13',
        mutation: { kind: 'lock', locked: false, acquisitionId: 'hold-6' },
      },
    ]);
    await chat.setQueuedMessageEditLock({ ...third, locked: false });
    expect(queueCalls().at(-1)).toMatchObject({
      entryId: 't13',
      mutation: { kind: 'lock', locked: false, acquisitionId: 'hold-5' },
    });

    // An editor reopened while its save is in flight takes no hold when
    // the window's cloud chats close before that save lands (review round 6).
    await chat.setQueuedMessageEditLock({ ...second, locked: true });
    let releaseClosedEdit = (): void => undefined;
    core.queueEditGate = new Promise<void>((resolve) => {
      releaseClosedEdit = resolve;
    });
    const savingAtClose = chat.editQueuedMessage({
      ...second,
      text: 'second, at close',
    });
    await settle();
    const reopeningAtClose = chat.setQueuedMessageEditLock({
      ...second,
      locked: true,
    });
    await settle();
    desktop.backend.closeAll();
    await settle();
    const atClose = queueCalls().length;
    releaseClosedEdit();
    core.queueEditGate = null;
    await savingAtClose;
    await reopeningAtClose;
    await settle();
    expect(
      queueCalls()
        .slice(atClose)
        .filter(
          (call) =>
            Reflect.get(Object(call.mutation), 'kind') === 'lock' &&
            Reflect.get(Object(call.mutation), 'locked') === true,
        ),
    ).toEqual([]);

    // An editor still open when the window's cloud chats close hands its
    // hold back, and keeps none to renew: closing it later sends nothing.
    await chat.setQueuedMessageEditLock({ ...second, locked: true });
    desktop.backend.closeAll();
    await settle();
    const afterClose = queueCalls();
    expect(afterClose.at(-1)).toMatchObject({
      entryId: 't12',
      mutation: { kind: 'lock', locked: false, acquisitionId: 'hold-8' },
    });
    await chat.setQueuedMessageEditLock({ ...second, locked: false });
    expect(queueCalls()).toHaveLength(afterClose.length);
  } finally {
    Object.assign(core, saved);
  }
});

it('Run now stops the turn running when it was pressed, not a send of this window still in flight (CAN-6651)', async () => {
  const saved = { ...core };
  try {
    core.revision = 95;
    core.status = 'streaming';
    core.activeTurnId = 't1';
    core.chats = [{ chatId: CHAT, title: 'Plan', state: 'running' }];
    core.queues = {
      [CHAT]: [
        {
          id: 't13',
          origin: 'portal',
          enqueuedAtMs: 4_000,
          revision: 1,
          text: 'third',
          clientRequestId: 'desktop-t13',
          messageId: 't13-u',
          queueOrder: '2',
          promptSource: 'human',
        },
      ],
    };
    const io = side();
    const desktop = desktopPath(io);
    await settle();
    const chat = createWebCoreChatBackend(desktop.backend).chat;
    await desktop.backend.getQueue(SCOPE);
    // A send of this window still in flight, whose receipt will name a turn
    // of its own: Stop's precedence ranks it above a turn only a snapshot
    // named (CAN-6733), but Run now interrupts the running turn.
    let releaseSend = (): void => undefined;
    core.sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const sending = desktop.send('stop-queued');
    await settle();
    const forcing = chat.forceQueuedMessage({
      ...SCOPE,
      chatId: CHAT_KEY,
      entryId: 't13',
    });
    await settle();
    core.sendGate = null;
    releaseSend();
    await sending;
    await forcing;
    await settle();
    expect(
      io.calls
        .filter((call) => call.method === 'core.chat.turn.cancel')
        .map((call) => call.params.turnId),
    ).toEqual(['t1']);
  } finally {
    Object.assign(core, saved);
  }
});

it("a stopped cloud turn's end reaches the desktop store from its timer, so it reads as stopped (CAN-6560)", async () => {
  const saved = { ...core };
  try {
    core.revision = 90;
    core.status = 'idle';
    core.activeTurnId = undefined;
    core.chats = [{ chatId: CHAT, title: 'Plan', state: 'idle' }];
    core.messages = [U1, turnTimer('u1', 't1', 'cancelled', 1, 1_500)];
    const io = side();
    const desktop = desktopPath(io);
    await settle();

    // The page the store reads names the stopped turn's end.
    expect(desktop.turnEnds()).toEqual({
      u1: { outcome: 'cancelled', endedAt: 1_500 },
    });

    // A turn stopped while the chat is open ends by event, under the web
    // core's prompt id: the store records it under the id it sent.
    await desktop.send('stopped');
    const prompt = text('stopped-u', 'user', 'stopped', 3);
    const timer = turnTimer('stopped-u', 't11', 'cancelled', 3, 3_200);
    core.revision = 91;
    core.messages = [...core.messages, prompt, timer];
    io.latest.get('core.chat.events')?.push(
      batch(90, 91, [
        { type: 'message.upserted', chatId: CHAT, message: prompt },
        { type: 'message.upserted', chatId: CHAT, message: timer },
        {
          type: 'runtime.patched',
          chatId: CHAT,
          runtime: { status: 'idle', queuedMessageIds: [] },
        },
      ]),
    );
    await settle();
    expect(desktop.storeIds()).toContain('desktop-stopped');
    expect(desktop.turnEnds()).toEqual({
      u1: { outcome: 'cancelled', endedAt: 1_500 },
      'desktop-stopped': { outcome: 'cancelled', endedAt: 3_200 },
    });
  } finally {
    Object.assign(core, saved);
  }
});

it("a cloud prompt's attachments show the same on web and desktop, read back, after a reload and live, once each (CAN-6771)", async () => {
  const saved = { ...core };
  try {
    core.revision = 97;
    core.status = 'idle';
    core.activeTurnId = undefined;
    core.chats = [{ chatId: CHAT, title: 'Plan', state: 'idle' }];
    const files = [
      {
        attachmentId: 'att-1',
        filename: 'brief.md',
        mediaType: 'text/markdown',
        size: 7,
      },
      {
        attachmentId: 'att-2',
        filename: 'chart.png',
        mediaType: 'image/png',
        size: 9,
      },
    ];
    const chips = files.map((file) =>
      cloudAttachmentPath(file.attachmentId, file.filename),
    );
    // Sent from the web: this window never sent it, so only the transcript
    // can name its files.
    core.messages = [
      { ...text('u-files', 'user', 'See these', 1), attachments: files },
      text('a-files', 'assistant', 'Read them', 2),
    ];
    const webIo = side();
    const desktopIo = side();
    const web = webPath(webIo);
    const desktop = desktopPath(desktopIo);
    await settle();
    expect(desktop.shown()).toEqual(web.shown());
    expect(desktop.shown().rows[0]?.attachments).toEqual(chips);

    // A window opened later, as after a reload, reads them back the same.
    const reloaded = desktopPath(side());
    await settle();
    expect(reloaded.shown().rows[0]?.attachments).toEqual(chips);

    // A prompt that arrives live shows its chip once.
    const prompt = {
      ...text('u-live', 'user', 'One more', 3),
      attachments: [files[0]],
    };
    core.revision = 98;
    core.messages = [...core.messages, prompt];
    for (const io of [webIo, desktopIo])
      io.latest
        .get('core.chat.events')
        ?.push(
          batch(97, 98, [
            { type: 'message.upserted', chatId: CHAT, message: prompt },
          ]),
        );
    await settle();
    expect(desktop.shown()).toEqual(web.shown());
    expect(desktop.shown().rows.at(-1)?.attachments).toEqual([chips[0]]);
  } finally {
    Object.assign(core, saved);
  }
});

it('a cloud turn stopped before it wrote anything shows no empty reply row on web or desktop (CAN-6564)', async () => {
  const saved = { ...core };
  try {
    core.revision = 95;
    core.status = 'idle';
    core.activeTurnId = undefined;
    core.chats = [{ chatId: CHAT, title: 'Plan', state: 'idle' }];
    // As the web core serves it once Core stores no reply for such a turn:
    // the prompt and its cancelled timer, nothing else.
    core.messages = [U1, A1, U2, turnTimer('u2', 't2', 'cancelled', 3, 3_400)];
    const webIo = side();
    const desktopIo = side();
    const web = webPath(webIo);
    const desktop = desktopPath(desktopIo);
    await settle();

    expect(desktop.shown()).toEqual(web.shown());
    expect(
      desktop.shown().rows.filter((row) => row.role === 'assistant'),
    ).toEqual([
      { id: 'a1', role: 'assistant', text: 'hello', provisional: false },
    ]);
    expect(desktop.turnEnds()).toEqual({
      u2: { outcome: 'cancelled', endedAt: 3_400 },
    });

    // The same turn stopped while the chat is open: its prompt and timer
    // arrive with no reply.
    const prompt = text('u3', 'user', 'again', 5);
    const timer = turnTimer('u3', 't3', 'cancelled', 5, 5_200);
    core.revision = 96;
    core.messages = [...core.messages, prompt, timer];
    for (const io of [webIo, desktopIo])
      io.latest.get('core.chat.events')?.push(
        batch(95, 96, [
          { type: 'message.upserted', chatId: CHAT, message: prompt },
          { type: 'message.upserted', chatId: CHAT, message: timer },
        ]),
      );
    await settle();

    expect(desktop.shown()).toEqual(web.shown());
    expect(
      desktop.shown().rows.filter((row) => row.role === 'assistant'),
    ).toHaveLength(1);
    expect(desktop.turnEnds()).toMatchObject({
      u3: { outcome: 'cancelled', endedAt: 5_200 },
    });
  } finally {
    Object.assign(core, saved);
  }
});

describe('Stop on a cloud turn that is still starting (CAN-6592)', () => {
  const initial = { ...core };

  beforeEach(() => {
    core.revision = 100;
    core.status = 'idle';
    core.activeTurnId = undefined;
    core.messages = [U1];
    core.chats = [{ chatId: CHAT, title: 'Plan', state: 'idle' }];
    core.turns = {};
  });

  afterEach(() => {
    Object.assign(core, initial);
  });

  const cancels = (io: Side): unknown[] =>
    io.calls
      .filter((call) => call.method === 'core.chat.turn.cancel')
      .map((call) => call.params);

  /** Stop's own turn read: the chat's snapshot, which names no starting turn. */
  const turnReads = (io: Side, from = 0): number =>
    io.calls
      .slice(from)
      .filter(
        (call) =>
          call.method === 'core.chat.snapshot.get' &&
          call.params.chatId !== undefined,
      ).length;

  /** Holds the send's reply until the returned release. */
  function holdSend(): () => void {
    let release = (): void => undefined;
    core.sendGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => {
      core.sendGate = null;
      release();
    };
  }

  /** A Stop press whose outcome is read without waiting for it. */
  function press(desktop: ReturnType<typeof desktopPath>): {
    readonly outcome: () => unknown;
    readonly settled: Promise<unknown>;
  } {
    let outcome: unknown = 'pending';
    const settled = desktop.backend
      .cancel({ ...SCOPE, chatId: CHAT_KEY })
      .then((result) => {
        outcome = result;
        return result;
      });
    return { outcome: () => outcome, settled };
  }

  it("cancels a queued starting turn by its receipt's id as the receipt lands, with no turn read (a)", async () => {
    const io = side();
    const desktop = desktopPath(io);
    await settle();
    const release = holdSend();
    const sending = desktop.send('stop-queued');
    await settle();
    // The web core queues the turn's prompt: a report that names no turn.
    core.revision = 101;
    io.latest.get('core.chat.events')?.push(
      batch(100, 101, [
        {
          type: 'runtime.patched',
          chatId: CHAT,
          runtime: {
            status: 'awaiting_input',
            queuedMessageIds: ['stop-queued-u'],
          },
        },
      ]),
    );
    await settle();
    const pressedAt = io.calls.length;
    const stop = press(desktop);
    await settle();
    // Stopping, not stopped: nothing is claimed before the web core accepts
    // a cancel, and Stop reads no snapshot that can't name the turn.
    expect(stop.outcome()).toBe('pending');
    expect(turnReads(io, pressedAt)).toBe(0);
    expect(cancels(io)).toEqual([]);
    core.status = 'starting';
    const receivedAt = io.calls.length;
    release();
    await sending;
    await expect(stop.settled).resolves.toEqual({ outcome: 'stop_requested' });
    expect(io.calls[receivedAt]).toEqual({
      method: 'core.chat.turn.cancel',
      params: { chatId: CHAT, turnId: 't12', reason: 'user' },
    });
    expect(cancels(io)).toHaveLength(1);
    expect(turnReads(io, pressedAt)).toBe(0);
    // The turn starts running after the cancel: its report names it, and
    // nothing sends the cancel again. One press, one cancel.
    core.revision = 102;
    core.status = 'streaming';
    core.activeTurnId = 't12';
    io.latest.get('core.chat.events')?.push(
      batch(101, 102, [
        {
          type: 'runtime.patched',
          chatId: CHAT,
          runtime: {
            status: 'streaming',
            queuedMessageIds: [],
            activeTurnId: 't12',
          },
        },
      ]),
    );
    await settle();
    expect(cancels(io)).toHaveLength(1);
    expect(turnReads(io, pressedAt)).toBe(0);
  });

  it("cancels the receipt's turn when a previous turn's end arrives during the send (b)", async () => {
    core.status = 'streaming';
    core.activeTurnId = 't-prev';
    core.chats = [{ chatId: CHAT, title: 'Plan', state: 'running' }];
    const io = side();
    const desktop = desktopPath(io);
    await settle();
    const release = holdSend();
    const sending = desktop.send('stop-after-end');
    await settle();
    // The previous turn ends while the send is in flight: no turn, none queued.
    core.revision = 101;
    core.status = 'idle';
    core.activeTurnId = undefined;
    io.latest.get('core.chat.events')?.push(
      batch(100, 101, [
        {
          type: 'runtime.patched',
          chatId: CHAT,
          runtime: { status: 'idle', queuedMessageIds: [] },
        },
      ]),
    );
    await settle();
    core.status = 'starting';
    release();
    await sending;
    await settle();
    const pressedAt = io.calls.length;
    await expect(
      desktop.backend.cancel({ ...SCOPE, chatId: CHAT_KEY }),
    ).resolves.toEqual({ outcome: 'stop_requested' });
    expect(cancels(io)).toEqual([
      { chatId: CHAT, turnId: 't13', reason: 'user' },
    ]);
    expect(turnReads(io, pressedAt)).toBe(0);
  });

  it('cancels a turn stopped while its send is in flight, once its receipt lands (c)', async () => {
    const io = side();
    const desktop = desktopPath(io);
    await settle();
    const release = holdSend();
    const sending = desktop.send('stop-quiet');
    await settle();
    const pressedAt = io.calls.length;
    const stop = press(desktop);
    await settle();
    expect(stop.outcome()).toBe('pending');
    expect(cancels(io)).toEqual([]);
    core.status = 'starting';
    release();
    await sending;
    await expect(stop.settled).resolves.toEqual({ outcome: 'stop_requested' });
    expect(cancels(io)).toEqual([
      { chatId: CHAT, turnId: 't14', reason: 'user' },
    ]);
    expect(turnReads(io, pressedAt)).toBe(0);
    // A report naming the turn after its cancel sends nothing more.
    core.revision = 101;
    core.status = 'streaming';
    core.activeTurnId = 't14';
    io.latest.get('core.chat.events')?.push(
      batch(100, 101, [
        {
          type: 'runtime.patched',
          chatId: CHAT,
          runtime: {
            status: 'streaming',
            queuedMessageIds: [],
            activeTurnId: 't14',
          },
        },
      ]),
    );
    await settle();
    expect(cancels(io)).toHaveLength(1);
  });

  it("fails closed when a stopped send's reply is lost and its receipt can't name the turn (d)", async () => {
    const io = side();
    const desktop = desktopPath(io);
    await settle();
    const sends = (): number =>
      io.calls.filter((call) => call.method === 'core.chat.message.send')
        .length;
    core.sendFailure = true;
    const release = holdSend();
    const failed = expect(
      desktop.backend.sendMessage({
        ...SCOPE,
        chatId: CHAT_KEY,
        userMessageId: 'desktop-stop-lost',
        text: 'stop-lost',
      }),
    ).rejects.toThrow('The reply was lost.');
    await settle();
    const stop = press(desktop);
    await settle();
    expect(stop.outcome()).toBe('pending');
    release();
    await failed;
    // Not stopped: Stop stays to try again, and nothing reads as stopped.
    await expect(stop.settled).resolves.toEqual({ outcome: 'not_stopped' });
    expect(cancels(io)).toEqual([]);
    expect(desktop.turnEnds()?.['desktop-stop-lost']).toBeUndefined();
    // The send is never resent under its key (CAN-6273).
    expect(sends()).toBe(1);
    expect(
      io.calls.filter((call) => call.method === 'core.chat.send.receipt'),
    ).toHaveLength(1);
  });

  it('cancels a turn stopped before its send leaves once, by its receipt, and it never shows running (e)', async () => {
    const io = side();
    const desktop = desktopPath(io);
    await settle();
    let saved = (): void => undefined;
    trackSelectionSave(
      CHAT_KEY,
      new Promise<void>((resolve) => {
        saved = resolve;
      }),
    );
    const sending = desktop.send('stop-saving');
    await settle();
    expect(
      io.calls.filter((call) => call.method === 'core.chat.message.send'),
    ).toEqual([]);
    const pressedAt = io.calls.length;
    const first = press(desktop);
    // A second press (Stop again, or Esc) is the same stop, never another.
    const second = press(desktop);
    await settle();
    expect(first.outcome()).toBe('pending');
    expect(cancels(io)).toEqual([]);
    expect(turnReads(io, pressedAt)).toBe(0);
    saved();
    await sending;
    await expect(first.settled).resolves.toEqual({
      outcome: 'stop_requested',
    });
    await expect(second.settled).resolves.toEqual({
      outcome: 'stop_requested',
    });
    expect(cancels(io)).toEqual([
      { chatId: CHAT, turnId: 't15', reason: 'user' },
    ]);
    expect(desktop.shown().running).toBe(false);
    // The web core ends the turn it cancelled: it never ran in the chat.
    core.revision = 101;
    core.status = 'idle';
    io.latest.get('core.chat.events')?.push(
      batch(100, 101, [
        {
          type: 'runtime.patched',
          chatId: CHAT,
          runtime: { status: 'idle', queuedMessageIds: [] },
        },
      ]),
    );
    await settle();
    expect(desktop.shown().running).toBe(false);
    expect(desktop.shown().rows.some((row) => row.provisional)).toBe(false);
  });

  it("cancels the receipt's turn once when Core reports it starting with no id, and not again when it names it (g)", async () => {
    const io = side();
    const desktop = desktopPath(io);
    await settle();
    await desktop.send('stop-quiet');
    // Core takes the prompt off its queue to start the turn: the session is
    // starting, and no turn is running or queued yet.
    core.revision = 101;
    core.status = 'starting';
    io.latest.get('core.chat.events')?.push(
      batch(100, 101, [
        {
          type: 'runtime.patched',
          chatId: CHAT,
          runtime: { status: 'starting', queuedMessageIds: [] },
        },
      ]),
    );
    await settle();
    const pressedAt = io.calls.length;
    await expect(
      desktop.backend.cancel({ ...SCOPE, chatId: CHAT_KEY }),
    ).resolves.toEqual({ outcome: 'stop_requested' });
    expect(cancels(io)).toEqual([
      { chatId: CHAT, turnId: 't14', reason: 'user' },
    ]);
    expect(turnReads(io, pressedAt)).toBe(0);
    // The turn runs at last, named: nothing sends the cancel again.
    core.revision = 102;
    core.status = 'streaming';
    core.activeTurnId = 't14';
    io.latest.get('core.chat.events')?.push(
      batch(101, 102, [
        {
          type: 'runtime.patched',
          chatId: CHAT,
          runtime: {
            status: 'streaming',
            queuedMessageIds: [],
            activeTurnId: 't14',
          },
        },
      ]),
    );
    await settle();
    expect(cancels(io)).toHaveLength(1);
  });

  it("keeps the receipt's turn through a snapshot read while Core holds its prompt queued (h)", async () => {
    const io = side();
    const desktop = desktopPath(io);
    await settle();
    await desktop.send('stop-quiet');
    // Core holds the prompt queued, waiting for input, and names no turn.
    core.revision = 101;
    core.status = 'awaiting_input';
    core.queued = ['stop-quiet-u'];
    io.latest.get('core.chat.events')?.push(
      batch(100, 101, [
        {
          type: 'runtime.patched',
          chatId: CHAT,
          runtime: {
            status: 'awaiting_input',
            queuedMessageIds: ['stop-quiet-u'],
          },
        },
      ]),
    );
    await settle();
    // A snapshot read meanwhile reports the same: the turn still starts.
    const snapshot = await desktop.backend.getState(SCOPE);
    expect(snapshot.runtimeByChatId[CHAT_KEY]?.status).toBe('queued');
    await expect(
      desktop.backend.cancel({ ...SCOPE, chatId: CHAT_KEY }),
    ).resolves.toEqual({ outcome: 'stop_requested' });
    expect(cancels(io)).toEqual([
      { chatId: CHAT, turnId: 't14', reason: 'user' },
    ]);
  });

  /** A runtime report for the opened chat. */
  function report(io: Side, runtime: Record<string, unknown>): void {
    const base = core.revision;
    core.revision += 1;
    io.latest
      .get('core.chat.events')
      ?.push(
        batch(base, core.revision, [
          { type: 'runtime.patched', chatId: CHAT, runtime },
        ]),
      );
  }

  it("sends Stop on the next turn its own cancel while the ended turn's cancel still waits (i)", async () => {
    const io = side();
    const desktop = desktopPath(io);
    await settle();
    // Turn A runs; its cancel goes out and the web core holds the reply.
    await desktop.send('stop-quiet');
    report(io, {
      status: 'streaming',
      queuedMessageIds: [],
      activeTurnId: 't14',
    });
    await settle();
    let releaseCancel = (): void => undefined;
    core.cancelGate = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    const stopA = press(desktop);
    await settle();
    expect(cancels(io)).toEqual([
      { chatId: CHAT, turnId: 't14', reason: 'user' },
    ]);
    // A ends before its cancel answers, and turn B starts.
    report(io, { status: 'idle', queuedMessageIds: [] });
    await settle();
    await desktop.send('stop-saving');
    await settle();
    // Stop on B names B: it never joins A's cancel.
    const stopB = press(desktop);
    await settle();
    expect(cancels(io)).toEqual([
      { chatId: CHAT, turnId: 't14', reason: 'user' },
      { chatId: CHAT, turnId: 't15', reason: 'user' },
    ]);
    core.cancelGate = null;
    releaseCancel();
    await expect(stopA.settled).resolves.toEqual({
      outcome: 'stop_requested',
    });
    await expect(stopB.settled).resolves.toEqual({
      outcome: 'stop_requested',
    });
  });

  it('keeps Stop for an accepted send whose receipt names no turn, reading the snapshot on each press (l)', async () => {
    core.legacyReceipt = true;
    const io = side();
    const desktop = desktopPath(io);
    await settle();
    await desktop.send('stop-quiet');
    // Core starts the turn and names none: neither the receipt nor the
    // snapshot can name it yet.
    core.status = 'starting';
    await settle();
    expect(desktop.starting()).toBe(true);
    const firstPress = io.calls.length;
    await expect(
      desktop.backend.cancel({ ...SCOPE, chatId: CHAT_KEY }),
    ).resolves.toEqual({ outcome: 'not_stopped' });
    expect(turnReads(io, firstPress)).toBe(1);
    expect(desktop.starting()).toBe(true);
    // A second press reads the snapshot again rather than answering
    // turn_not_active.
    const secondPress = io.calls.length;
    await expect(
      desktop.backend.cancel({ ...SCOPE, chatId: CHAT_KEY }),
    ).resolves.toEqual({ outcome: 'not_stopped' });
    expect(turnReads(io, secondPress)).toBe(1);
    expect(cancels(io)).toEqual([]);
    // The runtime names the turn: Stop cancels it.
    report(io, {
      status: 'streaming',
      queuedMessageIds: [],
      activeTurnId: 'legacy-turn',
    });
    await settle();
    await expect(
      desktop.backend.cancel({ ...SCOPE, chatId: CHAT_KEY }),
    ).resolves.toEqual({ outcome: 'stop_requested' });
    expect(cancels(io)).toEqual([
      { chatId: CHAT, turnId: 'legacy-turn', reason: 'user' },
    ]);
    report(io, { status: 'idle', queuedMessageIds: [] });
    await settle();
    expect(desktop.starting()).toBe(false);
    // Another such send, settled by a report that names no turn.
    await desktop.send('stop-saving');
    await settle();
    expect(desktop.starting()).toBe(true);
    report(io, { status: 'idle', queuedMessageIds: [] });
    await settle();
    expect(desktop.starting()).toBe(false);
    await expect(
      desktop.backend.cancel({ ...SCOPE, chatId: CHAT_KEY }),
    ).resolves.toEqual({ outcome: 'turn_not_active' });
    // Never resent (CAN-6273).
    expect(
      io.calls.filter((call) => call.method === 'core.chat.message.send'),
    ).toHaveLength(2);
  });

  it('keeps Stop and its failure for a send whose reply and receipt were both lost, until the runtime says what ran (j)', async () => {
    const io = side();
    const desktop = desktopPath(io);
    await settle();
    const lostSend = (userMessageId: string): Promise<void> => {
      core.sendFailure = true;
      return expect(
        desktop.backend.sendMessage({
          ...SCOPE,
          chatId: CHAT_KEY,
          userMessageId,
          text: 'stop-lost',
        }),
      )
        .rejects.toThrow('The reply was lost.')
        .finally(() => {
          core.sendFailure = false;
        });
    };
    await lostSend('desktop-lost-1');
    await settle();
    // The send may have landed: Stop stays, and a press says it couldn't
    // stop yet rather than that nothing runs.
    expect(desktop.starting()).toBe(true);
    await expect(
      desktop.backend.cancel({ ...SCOPE, chatId: CHAT_KEY }),
    ).resolves.toEqual({ outcome: 'not_stopped' });
    expect(cancels(io)).toEqual([]);
    expect(desktop.starting()).toBe(true);
    // The runtime names the turn the send started: Stop cancels it.
    report(io, {
      status: 'streaming',
      queuedMessageIds: [],
      activeTurnId: 'lost-turn',
    });
    await settle();
    await expect(
      desktop.backend.cancel({ ...SCOPE, chatId: CHAT_KEY }),
    ).resolves.toEqual({ outcome: 'stop_requested' });
    expect(cancels(io)).toEqual([
      { chatId: CHAT, turnId: 'lost-turn', reason: 'user' },
    ]);
    report(io, { status: 'idle', queuedMessageIds: [] });
    await settle();
    expect(desktop.starting()).toBe(false);
    // Another lost send, settled by a report that names no turn.
    await lostSend('desktop-lost-2');
    await settle();
    expect(desktop.starting()).toBe(true);
    report(io, { status: 'idle', queuedMessageIds: [] });
    await settle();
    expect(desktop.starting()).toBe(false);
    await expect(
      desktop.backend.cancel({ ...SCOPE, chatId: CHAT_KEY }),
    ).resolves.toEqual({ outcome: 'turn_not_active' });
    // Never resent under its key (CAN-6273).
    expect(
      io.calls.filter((call) => call.method === 'core.chat.message.send'),
    ).toHaveLength(2);
  });

  it("keeps a lost send's Stop through a snapshot requested before the send (k)", async () => {
    const io = side();
    const desktop = desktopPath(io);
    await settle();
    // A snapshot read starts and the web core holds its reply: the chat is
    // idle as it reads.
    let releaseSnapshot = (): void => undefined;
    core.snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const reading = desktop.backend.getState(SCOPE);
    await settle();
    // A send then loses its reply and its receipt.
    core.sendFailure = true;
    await expect(
      desktop.backend.sendMessage({
        ...SCOPE,
        chatId: CHAT_KEY,
        userMessageId: 'desktop-lost-held',
        text: 'stop-lost',
      }),
    ).rejects.toThrow('The reply was lost.');
    core.sendFailure = false;
    await settle();
    expect(desktop.starting()).toBe(true);
    // The older idle snapshot lands after the send: it can't say the send's
    // turn never started.
    core.snapshotGate = null;
    releaseSnapshot();
    await reading;
    await settle();
    expect(desktop.starting()).toBe(true);
    await expect(
      desktop.backend.cancel({ ...SCOPE, chatId: CHAT_KEY }),
    ).resolves.toEqual({ outcome: 'not_stopped' });
  });

  it("cancels the receipt's turn in the receipt's own tick, and keeps it Stop's through an idle snapshot read before the receipt (CAN-6733)", async () => {
    const io = side();
    const desktop = desktopPath(io);
    await settle();
    // A snapshot read starts before the send, and the web core holds its
    // reply: the chat reads idle.
    let releaseSnapshot = (): void => undefined;
    core.snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const reading = desktop.backend.getState(SCOPE);
    await settle();
    const release = holdSend();
    const sending = desktop.send('stop-stale');
    await settle();
    // Stop while the send is in flight: nothing names the turn yet.
    const pressedAt = io.calls.length;
    const stop = press(desktop);
    await settle();
    expect(stop.outcome()).toBe('pending');
    expect(cancels(io)).toEqual([]);
    // The receipt lands: its turn's cancel is the very next call, before
    // any read, in the receipt's own tick.
    core.status = 'starting';
    const receivedAt = io.calls.length;
    release();
    await sending;
    expect(io.calls[receivedAt]).toEqual({
      method: 'core.chat.turn.cancel',
      params: { chatId: CHAT, turnId: 't16', reason: 'user' },
    });
    await expect(stop.settled).resolves.toEqual({ outcome: 'stop_requested' });
    expect(cancels(io)).toHaveLength(1);
    // The older idle snapshot lands after the receipt. It was read before
    // the turn was queued, so it can't say the turn never started: the turn
    // still reads starting, and stays the one Stop cancels.
    core.snapshotGate = null;
    releaseSnapshot();
    await reading;
    await settle();
    expect(desktop.starting()).toBe(true);
    // A retry press, once the first has waited, cancels the same turn again
    // by its receipt's id, with no turn read.
    await expect(
      desktop.backend.cancel({ ...SCOPE, chatId: CHAT_KEY, attempt: 2 }),
    ).resolves.toEqual({ outcome: 'stop_requested' });
    expect(cancels(io)).toEqual([
      { chatId: CHAT, turnId: 't16', reason: 'user' },
      { chatId: CHAT, turnId: 't16', reason: 'user' },
    ]);
    expect(turnReads(io, pressedAt)).toBe(0);
    // Core reports the turn's end: only then does it stop reading starting.
    report(io, { status: 'idle', queuedMessageIds: [] });
    await settle();
    expect(desktop.starting()).toBe(false);
  });

  it('leaves a turn whose cancel the web core refused as not found to the snapshot, so the next Stop cancels it while it still runs (CAN-6393)', async () => {
    const io = side();
    const desktop = desktopPath(io);
    await settle();
    await desktop.send('stop-quiet');
    report(io, {
      status: 'streaming',
      queuedMessageIds: [],
      activeTurnId: 't14',
    });
    await settle();
    // The web core can't find the turn by its id, though Core still runs
    // it: the snapshot read after the refusal names it running.
    core.turnCancelNotFound = 1;
    core.status = 'streaming';
    core.activeTurnId = 't14';
    await expect(
      desktop.backend.cancel({ ...SCOPE, chatId: CHAT_KEY }),
    ).resolves.toEqual({ outcome: 'turn_not_active' });
    await settle();
    // A refusal is no report of the turn's end: the next Stop cancels it.
    await expect(
      desktop.backend.cancel({ ...SCOPE, chatId: CHAT_KEY, attempt: 1 }),
    ).resolves.toEqual({ outcome: 'stop_requested' });
    expect(cancels(io)).toEqual([
      { chatId: CHAT, turnId: 't14', reason: 'user' },
      { chatId: CHAT, turnId: 't14', reason: 'user' },
    ]);
  });

  it("marks a turn ended when its end arrives after its cancel was refused as not found, so a stale snapshot never makes it Stop's again (CAN-6770)", async () => {
    const io = side();
    const desktop = desktopPath(io);
    await settle();
    await desktop.send('stop-quiet');
    report(io, {
      status: 'streaming',
      queuedMessageIds: [],
      activeTurnId: 't14',
    });
    await settle();
    core.turnCancelNotFound = 1;
    // The refusal's own snapshot read is held, so the turn's end lands first.
    let releaseSnapshot = (): void => undefined;
    core.snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    await expect(
      desktop.backend.cancel({ ...SCOPE, chatId: CHAT_KEY }),
    ).resolves.toEqual({ outcome: 'turn_not_active' });
    report(io, { status: 'idle', queuedMessageIds: [] });
    await settle();
    core.snapshotGate = null;
    releaseSnapshot();
    await settle();
    // A later snapshot still names the ended turn, running.
    core.status = 'streaming';
    core.activeTurnId = 't14';
    await desktop.backend.getState(SCOPE);
    await settle();
    const before = cancels(io).length;
    await expect(
      desktop.backend.cancel({ ...SCOPE, chatId: CHAT_KEY, attempt: 1 }),
    ).resolves.toEqual({ outcome: 'turn_not_active' });
    expect(cancels(io)).toHaveLength(before);
  });

  it('keeps a refused turn through a starting report that names no turn, so its end still marks it ended (CAN-6770)', async () => {
    const io = side();
    const desktop = desktopPath(io);
    await settle();
    await desktop.send('stop-quiet');
    report(io, {
      status: 'streaming',
      queuedMessageIds: [],
      activeTurnId: 't14',
    });
    await settle();
    core.turnCancelNotFound = 1;
    let releaseSnapshot = (): void => undefined;
    core.snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    await expect(
      desktop.backend.cancel({ ...SCOPE, chatId: CHAT_KEY }),
    ).resolves.toEqual({ outcome: 'turn_not_active' });
    // Core reports a session starting with no turn named, then the end.
    report(io, { status: 'starting', queuedMessageIds: [] });
    await settle();
    report(io, { status: 'idle', queuedMessageIds: [] });
    await settle();
    core.snapshotGate = null;
    releaseSnapshot();
    await settle();
    core.status = 'streaming';
    core.activeTurnId = 't14';
    await desktop.backend.getState(SCOPE);
    await settle();
    const before = cancels(io).length;
    await expect(
      desktop.backend.cancel({ ...SCOPE, chatId: CHAT_KEY, attempt: 1 }),
    ).resolves.toEqual({ outcome: 'turn_not_active' });
    expect(cancels(io)).toHaveLength(before);
  });

  it("never cancels an ended turn a stale snapshot still names: Stop during the next send cancels that send's turn by its receipt (CAN-6733)", async () => {
    const io = side();
    const desktop = desktopPath(io);
    await settle();
    // The previous turn runs; Stop cancels it, and Core reports its end.
    await desktop.send('stop-quiet');
    report(io, {
      status: 'streaming',
      queuedMessageIds: [],
      activeTurnId: 't14',
    });
    await settle();
    await expect(
      desktop.backend.cancel({ ...SCOPE, chatId: CHAT_KEY }),
    ).resolves.toEqual({ outcome: 'stop_requested' });
    expect(cancels(io)).toEqual([
      { chatId: CHAT, turnId: 't14', reason: 'user' },
    ]);
    report(io, { status: 'idle', queuedMessageIds: [] });
    await settle();
    expect(desktop.starting()).toBe(false);
    // A later snapshot still names the ended turn, running: the web core's
    // runtime lags Core's end.
    core.status = 'streaming';
    core.activeTurnId = 't14';
    await desktop.backend.getState(SCOPE);
    await settle();
    // The next send, and Stop before its receipt: the ended turn is never
    // Stop's target, so nothing goes out until the receipt names the turn.
    const release = holdSend();
    const sending = desktop.send('stop-after-stale');
    await settle();
    const pressedAt = io.calls.length;
    const stop = press(desktop);
    await settle();
    expect(stop.outcome()).toBe('pending');
    expect(cancels(io)).toEqual([
      { chatId: CHAT, turnId: 't14', reason: 'user' },
    ]);
    core.status = 'starting';
    core.activeTurnId = undefined;
    release();
    await sending;
    await expect(stop.settled).resolves.toEqual({ outcome: 'stop_requested' });
    expect(cancels(io)).toEqual([
      { chatId: CHAT, turnId: 't14', reason: 'user' },
      { chatId: CHAT, turnId: 't17', reason: 'user' },
    ]);
    expect(turnReads(io, pressedAt)).toBe(0);
    // The new turn is Stop's from here on: a retry cancels it, never the
    // ended one.
    expect(desktop.starting()).toBe(true);
    await expect(
      desktop.backend.cancel({ ...SCOPE, chatId: CHAT_KEY, attempt: 2 }),
    ).resolves.toEqual({ outcome: 'stop_requested' });
    expect(cancels(io)).toEqual([
      { chatId: CHAT, turnId: 't14', reason: 'user' },
      { chatId: CHAT, turnId: 't17', reason: 'user' },
      { chatId: CHAT, turnId: 't17', reason: 'user' },
    ]);
    report(io, { status: 'idle', queuedMessageIds: [] });
    await settle();
  });

  it('cancels the running turn its events name at once, not a follow-up still being sent behind it (CAN-6733)', async () => {
    const io = side();
    const desktop = desktopPath(io);
    await settle();
    // A turn runs, as the chat's events report it.
    await desktop.send('stop-quiet');
    report(io, {
      status: 'streaming',
      queuedMessageIds: [],
      activeTurnId: 't14',
    });
    await settle();
    // A follow-up is sent behind it, and the web core holds its reply.
    const release = holdSend();
    const sending = desktop.send('queued-follow');
    await settle();
    // Stop cancels the running turn at once: it never waits on the
    // follow-up's receipt.
    const pressedAt = io.calls.length;
    const stop = press(desktop);
    await settle();
    expect(cancels(io)).toEqual([
      { chatId: CHAT, turnId: 't14', reason: 'user' },
    ]);
    expect(stop.outcome()).toEqual({ outcome: 'stop_requested' });
    expect(turnReads(io, pressedAt)).toBe(0);
    // The follow-up's receipt lands while the turn still runs: it stays
    // queued, and nothing cancels it.
    release();
    await sending;
    report(io, {
      status: 'streaming',
      queuedMessageIds: ['queued-follow-u'],
      activeTurnId: 't14',
    });
    await settle();
    expect(cancels(io)).toEqual([
      { chatId: CHAT, turnId: 't14', reason: 'user' },
    ]);
    await stop.settled;
    report(io, { status: 'idle', queuedMessageIds: [] });
    await settle();
  });

  it("keeps a running turn its events reported as Stop's target through an idle snapshot read before the report (CAN-6733)", async () => {
    const io = side();
    const desktop = desktopPath(io);
    await settle();
    await desktop.send('stop-quiet');
    await settle();
    // A snapshot read starts while the chat still reads idle, and the web
    // core holds its reply.
    let releaseSnapshot = (): void => undefined;
    core.snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const reading = desktop.backend.getState(SCOPE);
    await settle();
    // The turn's events then report it running, and the older idle
    // snapshot lands after them.
    report(io, {
      status: 'streaming',
      queuedMessageIds: [],
      activeTurnId: 't14',
    });
    await settle();
    core.snapshotGate = null;
    releaseSnapshot();
    await reading;
    await settle();
    // A follow-up's send is in flight: Stop still cancels the running turn
    // at once.
    const release = holdSend();
    const sending = desktop.send('queued-follow');
    await settle();
    const stop = press(desktop);
    await settle();
    expect(cancels(io)).toEqual([
      { chatId: CHAT, turnId: 't14', reason: 'user' },
    ]);
    expect(stop.outcome()).toEqual({ outcome: 'stop_requested' });
    release();
    await sending;
    await settle();
    expect(cancels(io)).toHaveLength(1);
    report(io, { status: 'idle', queuedMessageIds: [] });
    await settle();
  });

  it("keeps the next turn Stop's through a snapshot read after its receipt that still names the ended turn running (CAN-6733)", async () => {
    const io = side();
    const desktop = desktopPath(io);
    await settle();
    // Turn A runs, then Core reports its end.
    await desktop.send('stop-quiet');
    report(io, {
      status: 'streaming',
      queuedMessageIds: [],
      activeTurnId: 't14',
    });
    await settle();
    report(io, { status: 'idle', queuedMessageIds: [] });
    await settle();
    // Turn B's send is accepted: its receipt names it, and it starts.
    await desktop.send('stop-after-stale');
    await settle();
    expect(desktop.starting()).toBe(true);
    // A snapshot read after B's receipt still names A running: the web
    // core's runtime lags A's end, so it says nothing about B.
    core.status = 'streaming';
    core.activeTurnId = 't14';
    await desktop.backend.getState(SCOPE);
    await settle();
    expect(desktop.starting()).toBe(true);
    // Stop cancels B by its receipt's id, never A, with no turn read.
    const pressedAt = io.calls.length;
    await expect(
      desktop.backend.cancel({ ...SCOPE, chatId: CHAT_KEY }),
    ).resolves.toEqual({ outcome: 'stop_requested' });
    expect(cancels(io)).toEqual([
      { chatId: CHAT, turnId: 't17', reason: 'user' },
    ]);
    expect(turnReads(io, pressedAt)).toBe(0);
    expect(desktop.starting()).toBe(true);
    // Only Core's report of B's end ends it.
    report(io, { status: 'idle', queuedMessageIds: [] });
    await settle();
    expect(desktop.starting()).toBe(false);
  });

  it('cancels a turn its receipt named, before any report, at once, not a follow-up still being sent behind it (CAN-6733)', async () => {
    const io = side();
    const desktop = desktopPath(io);
    await settle();
    // Turn A's send is accepted: its receipt names A, and no report has
    // named it yet.
    await desktop.send('stop-quiet');
    await settle();
    expect(desktop.starting()).toBe(true);
    // A follow-up is sent behind it, and the web core holds its reply.
    const release = holdSend();
    const sending = desktop.send('queued-follow');
    await settle();
    // Stop cancels A at once, by its receipt's id: the receipt is Core's
    // acknowledgement, and it outranks the follow-up's open send.
    const pressedAt = io.calls.length;
    const stop = press(desktop);
    await settle();
    expect(cancels(io)).toEqual([
      { chatId: CHAT, turnId: 't14', reason: 'user' },
    ]);
    expect(stop.outcome()).toEqual({ outcome: 'stop_requested' });
    expect(turnReads(io, pressedAt)).toBe(0);
    expect(desktop.starting()).toBe(true);
    // Core reports A's end: A is no longer anyone's target. A Stop now goes
    // to the follow-up's send, and cancels its turn once its receipt lands.
    report(io, { status: 'idle', queuedMessageIds: [] });
    await settle();
    expect(desktop.starting()).toBe(true);
    const next = desktop.backend.cancel({
      ...SCOPE,
      chatId: CHAT_KEY,
      attempt: 2,
    });
    await settle();
    expect(cancels(io)).toHaveLength(1);
    release();
    await sending;
    await expect(next).resolves.toEqual({ outcome: 'stop_requested' });
    expect(cancels(io)).toEqual([
      { chatId: CHAT, turnId: 't14', reason: 'user' },
      { chatId: CHAT, turnId: 't18', reason: 'user' },
    ]);
    report(io, { status: 'idle', queuedMessageIds: [] });
    await settle();
    expect(desktop.starting()).toBe(false);
  });

  it('reports a chat listed running whose snapshot names no turn as not active, not as a stop that failed (f)', async () => {
    core.chats = [
      { chatId: CHAT, title: 'Plan', state: 'idle' },
      { chatId: 'chat-2', title: 'Notes', state: 'running' },
    ];
    const io = side();
    const desktop = desktopPath(io);
    await settle();
    // No send is in flight: Stop reads the chat's snapshot, which names no
    // turn. The turn has ended; nothing says Stop failed.
    await expect(
      desktop.backend.cancel({ ...SCOPE, chatId: 'web-core:chat-2' }),
    ).resolves.toEqual({ outcome: 'turn_not_active' });
    expect(cancels(io)).toEqual([]);
  });

  it('keeps an accepted send starting through a snapshot that names its turn until the store installs it (CAN-6677)', async () => {
    const io = side();
    const desktop = desktopPath(io);
    await settle();
    await desktop.send('stop-quiet');
    await settle();
    // The receipt named the turn; no report has said it runs yet.
    expect(desktop.starting()).toBe(true);
    expect(desktop.shown().running).toBe(false);
    // Core runs the turn, and the store reads it from a snapshot: a revision
    // gap refreshes the scope, and the chat's transcript page is slow.
    core.revision = 103;
    core.status = 'streaming';
    core.activeTurnId = 't14';
    let pageServed = (): void => undefined;
    core.pageGate = new Promise<void>((resolve) => {
      pageServed = resolve;
    });
    // Another chat's report, after revisions the store missed.
    io.latest.get('core.chat.events')?.push(
      batch(102, 103, [
        {
          type: 'runtime.patched',
          chatId: 'chat-2',
          runtime: { status: 'idle', queuedMessageIds: [] },
        },
      ]),
    );
    await settle();
    // The snapshot names the turn, but the store holds no runtime for it
    // until the page lands: the turn still reads starting, so the composer
    // keeps Stop, and Stop cancels it by the id the snapshot named.
    expect(desktop.shown().running).toBe(false);
    expect(desktop.starting()).toBe(true);
    await expect(
      desktop.backend.cancel({ ...SCOPE, chatId: CHAT_KEY }),
    ).resolves.toEqual({ outcome: 'stop_requested' });
    expect(cancels(io)).toEqual([
      { chatId: CHAT, turnId: 't14', reason: 'user' },
    ]);
    // The page lands and the store installs the runtime: its turn takes
    // over, with no moment where neither says the turn runs, and the turn
    // no longer reads starting while it replies.
    pageServed();
    core.pageGate = null;
    await settle();
    expect(desktop.shown().running).toBe(true);
    expect(desktop.starting()).toBe(false);
    // Stop works while it runs too: a new press cancels the same turn.
    await expect(
      desktop.backend.cancel({ ...SCOPE, chatId: CHAT_KEY }),
    ).resolves.toEqual({ outcome: 'stop_requested' });
    expect(cancels(io)).toEqual([
      { chatId: CHAT, turnId: 't14', reason: 'user' },
      { chatId: CHAT, turnId: 't14', reason: 'user' },
    ]);
    // The turn ends: neither says it runs.
    report(io, { status: 'idle', queuedMessageIds: [] });
    await settle();
    expect(desktop.shown().running).toBe(false);
    expect(desktop.starting()).toBe(false);
    // Never resent (CAN-6273).
    expect(
      io.calls.filter((call) => call.method === 'core.chat.message.send'),
    ).toHaveLength(1);
  });
});

describe("a cloud Stop's target, by one precedence (CAN-6733)", () => {
  const CLAIM = { claim: 'send-in-flight' } as const;
  type Input = StopTargetInput<typeof CLAIM>;
  /** Each candidate's states: whether it may be the target, and why not. */
  const lives: readonly (readonly [string, Input['live'], boolean])[] = [
    ['no live turn', undefined, false],
    ['live', { turnId: 'live', current: true, runs: true, ended: false }, true],
    [
      'live, reported ended',
      { turnId: 'live', current: true, runs: true, ended: true },
      false,
    ],
    [
      'live, no longer active',
      { turnId: 'live', current: false, runs: true, ended: false },
      false,
    ],
    [
      'live, nothing runs',
      { turnId: 'live', current: true, runs: false, ended: false },
      false,
    ],
  ];
  const pendings: readonly (readonly [string, Input['pending'], boolean])[] = [
    ['no receipt turn', undefined, false],
    [
      'receipt turn',
      { turnId: 'pending', ended: false, replaced: false },
      true,
    ],
    [
      'receipt turn, reported ended',
      { turnId: 'pending', ended: true, replaced: false },
      false,
    ],
    [
      'receipt turn, replaced',
      { turnId: 'pending', ended: false, replaced: true },
      false,
    ],
  ];
  const claimsInFlight: readonly (readonly [
    string,
    Input['claim'],
    boolean,
  ])[] = [
    ['no send in flight', undefined, false],
    ['send in flight', CLAIM, true],
  ];
  const snapshots: readonly (readonly [
    string,
    Input['snapshotOnly'],
    boolean,
  ])[] = [
    ['no snapshot turn', undefined, false],
    ['snapshot turn', { turnId: 'snapshot', runs: true, ended: false }, true],
    [
      'snapshot turn, reported ended',
      { turnId: 'snapshot', runs: true, ended: true },
      false,
    ],
    [
      'snapshot turn, nothing runs',
      { turnId: 'snapshot', runs: false, ended: false },
      false,
    ],
  ];
  // Live, then the receipt's turn, then the send in flight, then the
  // snapshot's turn: the first that may be the target is.
  const rows = lives.flatMap(([liveName, live, liveOk]) =>
    pendings.flatMap(([pendingName, pending, pendingOk]) =>
      claimsInFlight.flatMap(([claimName, claim, claimOk]) =>
        snapshots.map(([snapshotName, snapshotOnly, snapshotOk]) => {
          const input: Input = {
            ...(live === undefined ? {} : { live }),
            ...(pending === undefined ? {} : { pending }),
            ...(claim === undefined ? {} : { claim }),
            ...(snapshotOnly === undefined ? {} : { snapshotOnly }),
          };
          const expected = liveOk
            ? { kind: 'live', turnId: 'live' }
            : pendingOk
              ? { kind: 'pending', turnId: 'pending' }
              : claimOk
                ? { kind: 'claim', claim: CLAIM }
                : snapshotOk
                  ? { kind: 'fallback', turnId: 'snapshot' }
                  : { kind: 'none' };
          return [
            `${liveName}; ${pendingName}; ${claimName}; ${snapshotName}`,
            input,
            expected,
          ] as const;
        }),
      ),
    ),
  );

  it('covers every combination of the candidates', () => {
    expect(rows).toHaveLength(5 * 4 * 2 * 4);
  });

  it.each(rows)('%s', (_name, input, expected) => {
    expect(chooseStopTarget(input)).toEqual(expected);
  });
});

describe("a plugin-selection save's receipt on the desktop's web core path (CAN-6092)", () => {
  it('translates a receipt whose capability state exceeds the 32 KiB JSON detail bound', () => {
    const same = (id: string): string => id;
    const ids = {
      chatToStore: same,
      chatToCore: same,
      newChatToCore: same,
      messageToStore: same,
      messageToCore: same,
    };
    const pruned = Array.from({ length: 400 }, (_, index) => ({
      kind: 'plugin',
      marketplaceId: `marketplace-${index}`,
      pluginName: `a-plugin-with-a-long-name-${index}`,
    }));
    expect(JSON.stringify(pruned).length).toBeGreaterThan(32_768);
    expect(
      translateCommandResult(
        {
          commandId: 'save-1',
          revision: 0,
          outcome: 'applied',
          entityId: 'chat-1',
          capabilities: {
            capabilityBundles: {},
            capabilityBundleStateVersion: 3,
            outcome: 'staged',
            capabilityPruned: pruned,
            warnings: [],
          },
        },
        ids,
      ),
    ).toMatchObject({ commandId: 'save-1', outcome: 'applied' });
  });
});

describe("a cloud chat's usage meter, equal to the web fold (CAN-6755)", () => {
  const MODEL = {
    id: 'core-model-1',
    name: 'Core model',
    contextWindow: 200_000,
  };
  const answered = (
    id: string,
    body: string,
    timestamp: number,
    meter?: CoreChatMessageMeter,
  ): Record<string, unknown> => ({
    ...text(id, 'assistant', body, timestamp),
    ...(meter === undefined ? {} : { meter }),
  });
  /** Each answer's meter, as revision 2 serves it (CAN-6509). */
  const FIRST: CoreChatMessageMeter = {
    model: MODEL,
    usage: {
      inputTokens: 1_200,
      outputTokens: 300,
      cacheReadTokens: 100,
      contextTokens: 1_600,
    },
    costUsd: '0.25',
    sourceKey: 'turn-1',
  };
  const SECOND: CoreChatMessageMeter = {
    model: MODEL,
    usage: {
      inputTokens: 800,
      outputTokens: 200,
      cacheWriteTokens: 50,
      contextTokens: 2_400,
      contextWindow: 200_000,
    },
    // A split row bills its incurred cost (REST's classifyCost).
    costUsd: '0.6',
    incurredCostUsd: '0.5',
    sourceKey: 'turn-2',
  };
  const THIRD: CoreChatMessageMeter = {
    model: MODEL,
    usage: { inputTokens: 400, outputTokens: 100, contextTokens: 3_100 },
    costUsd: '0.1',
    sourceKey: 'turn-3',
  };

  /**
   * The web's fold of the same answers as REST's conversation rows carry
   * them (`hydrateChatUsage`): usage and model as the meter names them, and
   * the incurred cost, else the cost, as each answer's price.
   */
  const webAnswer = (
    meter: CoreChatMessageMeter | undefined,
    createdAtMs: number,
  ): ChatUsageAnswer => {
    const price = meter?.incurredCostUsd ?? meter?.costUsd;
    return {
      ...(meter?.usage === undefined ? {} : { usage: meter.usage }),
      ...(meter?.model === undefined
        ? {}
        : {
            model: {
              id: meter.model.id,
              ...(meter.model.contextWindow === undefined
                ? {}
                : { contextWindow: meter.model.contextWindow }),
            },
          }),
      ...(price === undefined ? {} : { costUsd: Number(price) }),
      createdAtMs,
    };
  };

  /** What the web's composer meter shows for those answers. */
  const webMeter = (
    answers: readonly ChatUsageAnswer[],
    /** The model catalog's context window, as the web's picker lists it. */
    catalogContextWindow?: (modelId: string) => number | undefined,
  ): Record<string, unknown> | undefined => {
    const shown = toUsageIndicatorUsage(
      foldChatUsage(
        answers,
        catalogContextWindow === undefined ? {} : { catalogContextWindow },
      ),
      undefined,
      undefined,
    );
    return shown === undefined
      ? undefined
      : {
          contextTokens: shown.contextTokens,
          contextWindow: shown.contextWindow,
          totalCostUsd: shown.totalCostUsd,
          inputTokens: shown.inputTokens,
          outputTokens: shown.outputTokens,
          cacheReadInputTokens: shown.cacheReadInputTokens,
          numTurns: shown.numTurns,
          model: shown.model,
        };
  };

  /** The same figures from the desktop store's tab. */
  const desktopMeter = (
    usage: PersistedChatTab['usage'],
  ): Record<string, unknown> | undefined =>
    usage === undefined
      ? undefined
      : {
          contextTokens: usage.contextTokens,
          contextWindow: usage.contextWindow,
          totalCostUsd: usage.totalCostUsd,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadInputTokens: usage.cacheReadInputTokens,
          numTurns: usage.numTurns,
          model: usage.model,
        };

  const saved = { messages: core.messages, revision: core.revision };
  afterEach(() => {
    core.messages = saved.messages;
    core.revision = saved.revision;
    core.status = 'idle';
    core.activeTurnId = undefined;
  });

  it("shows a metered cloud chat's context, window and spend as the web's composer does, also after a live answer", async () => {
    core.revision = 4;
    core.status = 'idle';
    core.activeTurnId = undefined;
    core.messages = [
      text('mu1', 'user', 'hi', 1),
      answered('ma1', 'hello', 2, FIRST),
      text('mu2', 'user', 'more', 3),
      answered('ma2', 'sure', 4, SECOND),
    ];
    const io = side();
    const desktop = desktopPath(io);
    await settle();

    const web = webMeter([webAnswer(FIRST, 2), webAnswer(SECOND, 4)]);
    expect(web).toEqual({
      contextTokens: 2_400,
      contextWindow: 200_000,
      totalCostUsd: 0.75,
      inputTokens: 2_000,
      outputTokens: 500,
      cacheReadInputTokens: 100,
      numTurns: 2,
      model: 'core-model-1',
    });
    expect(desktopMeter(desktop.usage())).toEqual(web);

    // A live answer's meter arrives on its event (revision 2) and moves the
    // meter as the web's fold of all three answers does.
    const third = answered('ma3', 'done', 6, THIRD);
    core.revision = 5;
    core.messages = [...core.messages, text('mu3', 'user', 'last', 5), third];
    io.latest.get('core.chat.events')?.push(
      batch(4, 5, [
        {
          type: 'message.upserted',
          chatId: CHAT,
          message: text('mu3', 'user', 'last', 5),
        },
        { type: 'message.upserted', chatId: CHAT, message: third },
      ]),
    );
    await settle();
    const after = webMeter([
      webAnswer(FIRST, 2),
      webAnswer(SECOND, 4),
      webAnswer(THIRD, 6),
    ]);
    expect(after).toMatchObject({
      contextTokens: 3_100,
      totalCostUsd: 0.85,
      numTurns: 3,
    });
    expect(desktopMeter(desktop.usage())).toEqual(after);
  });

  it('keeps no usage for a cloud chat whose answers carry no meter, as revision 1 serves them', async () => {
    core.revision = 4;
    core.status = 'idle';
    core.activeTurnId = undefined;
    core.messages = [
      text('mu1', 'user', 'hi', 1),
      answered('ma1', 'hello', 2),
      text('mu2', 'user', 'more', 3),
      answered('ma2', 'sure', 4),
    ];
    const desktop = desktopPath(side());
    await settle();

    // The web's fold of answers with no usage, model or price is none, so
    // its meter shows nothing; the store holds none, never a zero.
    expect(webMeter([webAnswer(undefined, 2), webAnswer(undefined, 4)])).toBe(
      undefined,
    );
    expect(desktop.storeIds()).toEqual(['mu1', 'ma1', 'mu2', 'ma2']);
    expect(desktop.usage()).toBeUndefined();
  });

  it("keeps a metered chat's usage when the web core sends its tab again", async () => {
    core.revision = 4;
    core.status = 'idle';
    core.activeTurnId = undefined;
    const rows = [
      text('mu1', 'user', 'hi', 1),
      answered('ma1', 'hello', 2, FIRST),
      text('mu2', 'user', 'more', 3),
      answered('ma2', 'sure', 4, SECOND),
    ];
    core.messages = rows;
    const io = side();
    const desktop = desktopPath(io);
    await settle();
    const shown = webMeter([webAnswer(FIRST, 2), webAnswer(SECOND, 4)]);
    expect(desktopMeter(desktop.usage())).toEqual(shown);

    // The web core sends the chat's tab again, with its rows, as it does
    // for a rename or a restore: the meter it already showed stays.
    core.revision = 5;
    io.latest.get('core.chat.events')?.push(
      batch(4, 5, [
        {
          type: 'tab.upserted',
          tab: {
            id: CHAT,
            title: 'Plan',
            messages: rows,
            createdAt: '2026-11-10T00:00:00.000Z',
          },
        },
      ]),
    );
    await settle();
    expect(desktop.label(CHAT_KEY)).toBe('Plan');
    expect(desktopMeter(desktop.usage())).toEqual(shown);
  });

  it("shows an answer's meter that a refresh after the live turn's end finds, though the refresh publishes only the chat's runtime", async () => {
    core.revision = 4;
    core.status = 'idle';
    core.activeTurnId = undefined;
    core.messages = [
      text('mu1', 'user', 'hi', 1),
      answered('ma1', 'hello', 2, FIRST),
    ];
    const io = side();
    const desktop = desktopPath(io);
    await settle();
    expect(desktopMeter(desktop.usage())).toEqual(
      webMeter([webAnswer(FIRST, 2)]),
    );

    // A turn runs; its committed answer's event is lost.
    const prompt = text('mu2', 'user', 'more', 3);
    core.revision = 5;
    core.status = 'streaming';
    core.activeTurnId = 't2';
    core.messages = [...core.messages, prompt];
    io.latest.get('core.chat.events')?.push(
      batch(4, 5, [
        { type: 'message.upserted', chatId: CHAT, message: prompt },
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
    core.status = 'idle';
    core.activeTurnId = undefined;
    core.messages = [...core.messages, answered('ma2', 'sure', 4, SECOND)];
    // The live stream says the turn ended: the backend reads the snapshot
    // and the chat's page, which holds the answer and its meter.
    io.latest.get('core.chat.live.events')?.push(liveFrame({ kind: 'idle' }));
    await settle();
    expect(desktop.shown().running).toBe(false);
    expect(desktopMeter(desktop.usage())).toEqual(
      webMeter([webAnswer(FIRST, 2), webAnswer(SECOND, 4)]),
    );
  });

  it("shows an answer's meter that a refresh after the live turn's end read before another chat's page read failed", async () => {
    core.revision = 4;
    core.status = 'idle';
    core.activeTurnId = undefined;
    core.chats = [
      { chatId: CHAT, title: 'Plan', state: 'idle' },
      { chatId: 'chat-2', title: 'Notes', state: 'idle' },
    ];
    core.messages = [
      text('mu1', 'user', 'hi', 1),
      answered('ma1', 'hello', 2, FIRST),
    ];
    try {
      const io = side();
      const desktop = desktopPath(io);
      await settle();
      expect(desktopMeter(desktop.usage())).toEqual(
        webMeter([webAnswer(FIRST, 2)]),
      );

      const prompt = text('mu2', 'user', 'more', 3);
      core.revision = 5;
      core.status = 'streaming';
      core.activeTurnId = 't2';
      core.messages = [...core.messages, prompt];
      io.latest.get('core.chat.events')?.push(
        batch(4, 5, [
          { type: 'message.upserted', chatId: CHAT, message: prompt },
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
      core.status = 'idle';
      core.activeTurnId = undefined;
      core.messages = [...core.messages, answered('ma2', 'sure', 4, SECOND)];
      // The refresh reads this chat's page, then the other chat's fails.
      core.pageFailsFor = 'chat-2';
      io.latest.get('core.chat.live.events')?.push(liveFrame({ kind: 'idle' }));
      await settle();
      expect(desktopMeter(desktop.usage())).toEqual(
        webMeter([webAnswer(FIRST, 2), webAnswer(SECOND, 4)]),
      );
    } finally {
      core.pageFailsFor = null;
      core.chats = [{ chatId: CHAT, title: 'Plan', state: 'idle' }];
    }
  });

  it("keeps an answer's newer meter from an event when a transcript page read before it lands after it", async () => {
    // Core prices an answer once its turn ends: the page read first saw it
    // pending.
    const PENDING: CoreChatMessageMeter = {
      model: MODEL,
      usage: FIRST.usage,
      sourceKey: 'turn-1',
    };
    core.revision = 4;
    core.status = 'idle';
    core.activeTurnId = undefined;
    core.messages = [
      text('mu1', 'user', 'hi', 1),
      answered('ma1', 'hello', 2, PENDING),
    ];
    const io = side();
    const desktop = desktopPath(io);
    await settle();
    expect(desktop.usage()?.totalCostUsd).toBe(0);

    let release = (): void => undefined;
    core.pageGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      // A page read answered now, with the pending price, held in flight.
      const held = desktop.backend.getTranscriptPage({
        ...SCOPE,
        chatId: CHAT_KEY,
      });
      const priced = answered('ma1', 'hello', 2, FIRST);
      const prompt = text('mu2', 'user', 'more', 3);
      const next = answered('ma2', 'sure', 4, SECOND);
      core.revision = 5;
      core.messages = [core.messages[0], priced, prompt, next];
      io.latest.get('core.chat.events')?.push(
        batch(4, 5, [
          { type: 'message.upserted', chatId: CHAT, message: priced },
          { type: 'message.upserted', chatId: CHAT, message: prompt },
          { type: 'message.upserted', chatId: CHAT, message: next },
        ]),
      );
      await settle();
      const newer = webMeter([webAnswer(FIRST, 2), webAnswer(SECOND, 4)]);
      expect(desktopMeter(desktop.usage())).toEqual(newer);

      release();
      await held;
      await settle();
      expect(desktopMeter(desktop.usage())).toEqual(newer);
    } finally {
      core.pageGate = null;
    }
  });

  /**
   * Two overlapping reads of the chat's newest page with no event between
   * them: the older is held, the server's answers change, and the newer one
   * lands first (CAN-6830).
   */
  async function overlappingReads(
    before: readonly Record<string, unknown>[],
    after: readonly Record<string, unknown>[],
  ): Promise<ReturnType<typeof desktopPath>> {
    core.revision = 4;
    core.status = 'idle';
    core.activeTurnId = undefined;
    core.messages = [...before];
    const desktop = desktopPath(side());
    await settle();
    let release = (): void => undefined;
    core.pageGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const older = desktop.backend.getTranscriptPage({
      ...SCOPE,
      chatId: CHAT_KEY,
    });
    await settle();
    core.pageGate = null;
    core.messages = [...after];
    await desktop.backend.getTranscriptPage({ ...SCOPE, chatId: CHAT_KEY });
    await settle();
    release();
    await older;
    await settle();
    return desktop;
  }

  it('keeps the newer of two overlapping transcript reads when the older one lands last, so the meter never rolls back (CAN-6830)', async () => {
    const desktop = await overlappingReads(
      [text('mu1', 'user', 'hi', 1), answered('ma1', 'hello', 2, FIRST)],
      [
        text('mu1', 'user', 'hi', 1),
        answered('ma1', 'hello', 2, FIRST),
        text('mu2', 'user', 'more', 3),
        answered('ma2', 'sure', 4, SECOND),
      ],
    );
    expect(desktopMeter(desktop.usage())).toEqual(
      webMeter([webAnswer(FIRST, 2), webAnswer(SECOND, 4)]),
    );
  });

  it('keeps an answer the newer of two overlapping reads no longer holds out of the meter when the older one lands last (CAN-6830)', async () => {
    const desktop = await overlappingReads(
      [
        text('mu1', 'user', 'hi', 1),
        answered('ma1', 'hello', 2, FIRST),
        text('mu2', 'user', 'more', 3),
        answered('ma2', 'sure', 4, SECOND),
      ],
      [text('mu1', 'user', 'hi', 1), answered('ma1', 'hello', 2, FIRST)],
    );
    expect(desktopMeter(desktop.usage())).toEqual(
      webMeter([webAnswer(FIRST, 2)]),
    );
  });

  it("keeps an answer an event brings while the chat's first transcript page is read", async () => {
    core.revision = 4;
    core.status = 'idle';
    core.activeTurnId = undefined;
    core.messages = [
      text('mu1', 'user', 'hi', 1),
      answered('ma1', 'hello', 2, FIRST),
    ];
    let release = (): void => undefined;
    core.pageGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const io = side();
      const desktop = desktopPath(io);
      await settle();
      // The first page was answered before this answer and is held.
      const prompt = text('mu2', 'user', 'more', 3);
      const next = answered('ma2', 'sure', 4, SECOND);
      core.revision = 5;
      core.messages = [...core.messages, prompt, next];
      io.latest.get('core.chat.events')?.push(
        batch(4, 5, [
          { type: 'message.upserted', chatId: CHAT, message: prompt },
          { type: 'message.upserted', chatId: CHAT, message: next },
        ]),
      );
      await settle();
      release();
      await settle();
      expect(desktopMeter(desktop.usage())).toEqual(
        webMeter([webAnswer(FIRST, 2), webAnswer(SECOND, 4)]),
      );
    } finally {
      core.pageGate = null;
    }
  });

  it("sizes the meter to the model catalog's context window once the catalog loads after the transcript", async () => {
    clearWebCoreModelCatalog();
    core.revision = 4;
    core.status = 'idle';
    core.activeTurnId = undefined;
    // The meter names its model but no context window: the web core
    // catalog knows it.
    const UNSIZED: CoreChatMessageMeter = {
      model: { id: 'core-model-2' },
      usage: { inputTokens: 900, outputTokens: 100, contextTokens: 1_000 },
      costUsd: '0.05',
      sourceKey: 'turn-1',
    };
    core.messages = [
      text('mu1', 'user', 'hi', 1),
      answered('ma1', 'hello', 2, UNSIZED),
    ];
    try {
      const desktop = desktopPath(side());
      await settle();
      // No catalog yet: the meter's window is unknown, as on the web.
      expect(desktopMeter(desktop.usage())).toEqual(
        webMeter([webAnswer(UNSIZED, 2)]),
      );
      expect(desktop.usage()?.contextWindow).toBe(0);

      useWebCoreModelCatalogStore.setState((before) => ({
        byProject: {
          ...before.byProject,
          [SCOPE.projectId]: new Map([
            [
              'core-model-2',
              {
                id: 'core-model-2',
                label: 'Core model 2',
                provider: 'claude',
                kind: 'model',
                available: true,
                contextWindow: 128_000,
              },
            ],
          ]),
        },
      }));
      await settle();
      const sized = webMeter([webAnswer(UNSIZED, 2)], (modelId) =>
        modelId === 'core-model-2' ? 128_000 : undefined,
      );
      expect(sized).toMatchObject({
        contextTokens: 1_000,
        contextWindow: 128_000,
      });
      expect(desktopMeter(desktop.usage())).toEqual(sized);
    } finally {
      clearWebCoreModelCatalog();
    }
  });
});

it("a cloud tab holds the harness the web core's snapshot names for its chat, the one the web's picker keeps it to, and none from a web core that names none (CAN-6761)", async () => {
  core.revision = 300;
  core.status = 'idle';
  core.activeTurnId = undefined;
  core.messages = [U1, A1];
  core.chats = [{ chatId: CHAT, title: 'Plan', state: 'idle' }];
  core.model = 'model-b';
  core.harness = 'codex';
  const io = side();
  const desktop = desktopPath(io);
  await settle();
  // The web reads the same snapshot: its chat's settings name the harness.
  const served = (): string | undefined =>
    CoreChatSnapshotGetResultSchema.parse(snapshot(CHAT)).tabs.items.find(
      (item) => item.chatId === CHAT,
    )?.settings?.executionHarness ?? undefined;
  expect(served()).toBe('codex');
  expect(desktop.harness(CHAT_KEY)).toBe(served());
  expect(desktop.model(CHAT_KEY)).toBe('model-b');

  // The next snapshot names none, as for a chat with no answer yet, or a
  // web core from before CAN-6761: the tab holds none, so no model is
  // kept from it.
  const reread = (revision: number): void => {
    core.revision = revision;
    io.latest.get('core.chat.events')?.push({
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
  };
  core.harness = null;
  reread(302);
  await settle();
  expect(served()).toBeUndefined();
  expect(desktop.harness(CHAT_KEY)).toBeUndefined();
  core.harness = 'claude';
  reread(304);
  await settle();
  expect(desktop.harness(CHAT_KEY)).toBe('claude');
  core.harness = undefined;
  reread(306);
  await settle();
  expect(desktop.harness(CHAT_KEY)).toBeUndefined();
});

it("a cloud tab takes the harness a turn's answer names on its tab patch with no snapshot read; an event only adds or confirms one, never clears it, and a tab sent again keeps it (CAN-6777)", async () => {
  core.revision = 320;
  core.status = 'idle';
  core.activeTurnId = undefined;
  core.messages = [U1, A1];
  core.chats = [{ chatId: CHAT, title: 'Plan', state: 'idle' }];
  const io = side();
  const desktop = desktopPath(io);
  await settle();
  // No answer named a harness yet: nothing is restricted.
  expect(desktop.harness(CHAT_KEY)).toBeUndefined();
  const reads = (): number =>
    io.calls.filter((call) => call.method === 'core.chat.snapshot.get').length;
  const readsBefore = reads();
  const events = io.latest.get('core.chat.events');
  const patch = (
    base: number,
    value: Record<string, unknown>,
  ): Record<string, unknown> =>
    batch(base, base + 1, [
      { type: 'tab.metadata_patched', tabId: CHAT, patch: value },
    ]);

  // The first answer's batch names its model's harness, as the web's
  // picker learns it after the turn: the tab takes it with no snapshot read.
  events?.push(patch(320, { executionHarness: 'claude' }));
  await settle();
  expect(desktop.harness(CHAT_KEY)).toBe('claude');
  expect(reads()).toBe(readsBefore);

  // An event never clears it: a null, an unknown value or a patch that names
  // none leaves the tab's harness as it is.
  events?.push(patch(321, { executionHarness: null }));
  events?.push(patch(322, { executionHarness: 'not-a-harness' }));
  events?.push(patch(323, { title: 'Renamed' }));
  await settle();
  expect(desktop.harness(CHAT_KEY)).toBe('claude');

  // A tab the web core sends again names no harness: it keeps the one held.
  events?.push(
    batch(324, 325, [
      {
        type: 'tab.upserted',
        tab: {
          id: CHAT,
          title: 'Plan',
          messages: [U1, A1],
          createdAt: '2026-11-10T00:00:00.000Z',
        },
      },
    ]),
  );
  await settle();
  expect(desktop.harness(CHAT_KEY)).toBe('claude');

  // A later answer on another harness's model names that one.
  events?.push(patch(325, { executionHarness: 'codex' }));
  await settle();
  expect(desktop.harness(CHAT_KEY)).toBe('codex');
  expect(reads()).toBe(readsBefore);
});

it("keeps a harness an event named while an older snapshot of that chat was read, so the chat's own snapshot never lifts it either (CAN-6777)", async () => {
  core.revision = 350;
  core.status = 'idle';
  core.activeTurnId = undefined;
  core.messages = [U1, A1];
  core.chats = [
    { chatId: CHAT, title: 'Plan', state: 'idle' },
    { chatId: 'chat-2', title: 'Notes', state: 'idle' },
  ];
  // chat-2's own snapshot, read when the window reads its page, names no
  // harness and is slow to answer.
  let release = (): void => undefined;
  core.chatSnapshotGate = {
    chatId: 'chat-2',
    gate: new Promise<void>((resolve) => {
      release = resolve;
    }),
  };
  try {
    const io = side();
    const desktop = desktopPath(io);
    await settle();
    const events = io.latest.get('core.chat.events');
    // Meanwhile chat-2's answer names its harness.
    events?.push(
      batch(350, 351, [
        {
          type: 'tab.metadata_patched',
          tabId: 'chat-2',
          patch: { executionHarness: 'claude' },
        },
      ]),
    );
    await settle();
    expect(desktop.harness('web-core:chat-2')).toBe('claude');
    release();
    await settle();
    // The older read's silence lifts nothing.
    expect(desktop.harness('web-core:chat-2')).toBe('claude');
    events?.push(
      batch(351, 352, [
        {
          type: 'tab.upserted',
          tab: {
            id: 'chat-2',
            title: 'Notes',
            messages: [],
            createdAt: '2026-11-10T00:00:00.000Z',
          },
        },
      ]),
    );
    await settle();
    expect(desktop.harness('web-core:chat-2')).toBe('claude');
  } finally {
    core.chatSnapshotGate = null;
  }
});

it("keeps a harness an event named while an older task snapshot was read, so that snapshot's silence never lifts it (CAN-6777)", async () => {
  core.revision = 340;
  core.status = 'idle';
  core.activeTurnId = undefined;
  core.messages = [U1, A1];
  core.chats = [{ chatId: CHAT, title: 'Plan', state: 'idle' }];
  const io = side();
  const desktop = desktopPath(io);
  await settle();
  const events = io.latest.get('core.chat.events');

  // A snapshot read starts before the answer: it names no harness, and is
  // slow to answer.
  let release = (): void => undefined;
  core.snapshotGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const older = desktop.backend.getState(SCOPE);
    await settle();
    // Meanwhile the answer's batch names the harness.
    events?.push(
      batch(340, 341, [
        {
          type: 'tab.metadata_patched',
          tabId: CHAT,
          patch: { executionHarness: 'claude' },
        },
      ]),
    );
    await settle();
    expect(desktop.harness(CHAT_KEY)).toBe('claude');
    release();
    // The older snapshot itself carries the newer harness for its chat, so
    // a store that installs it shows the harness the event named.
    expect(
      (await older).tabsFile.tabs.find((tab) => tab.id === CHAT_KEY)
        ?.capturedHarness,
    ).toBe('claude');
    await settle();
  } finally {
    core.snapshotGate = null;
  }

  // The tab sent again names none: it keeps the harness the newer event named.
  events?.push(
    batch(341, 342, [
      {
        type: 'tab.upserted',
        tab: {
          id: CHAT,
          title: 'Plan',
          messages: [U1, A1],
          createdAt: '2026-11-10T00:00:00.000Z',
        },
      },
    ]),
  );
  await settle();
  expect(desktop.harness(CHAT_KEY)).toBe('claude');
});

it("a cloud tab the task's snapshot doesn't open holds the harness its own snapshot names once the window reads it, and keeps it through the task's next snapshot (CAN-6761)", async () => {
  core.revision = 310;
  core.status = 'idle';
  core.activeTurnId = undefined;
  core.messages = [U1, A1];
  core.chats = [
    { chatId: CHAT, title: 'Plan', state: 'idle' },
    { chatId: 'chat-2', title: 'Notes', state: 'idle' },
  ];
  core.chatHarness = { 'chat-2': 'claude' };
  const io = side();
  const desktop = desktopPath(io);
  await settle();
  // The task's snapshot opens only the task's chat and names chat-2's
  // harness nowhere; reading chat-2's page reads its own snapshot, which
  // names it, and the tab takes it as the store's change.
  const served = CoreChatSnapshotGetResultSchema.parse(
    snapshot('chat-2'),
  ).tabs.items.find((item) => item.chatId === 'chat-2')?.settings
    ?.executionHarness;
  expect(served).toBe('claude');
  expect(
    CoreChatSnapshotGetResultSchema.parse(snapshot()).tabs.items.some(
      (item) => item.chatId === 'chat-2',
    ),
  ).toBe(false);
  expect(desktop.harness('web-core:chat-2')).toBe(served);

  // The task's next snapshot names chat-2's harness nowhere: the tab keeps
  // the one its own snapshot named.
  core.revision = 311;
  io.latest.get('core.chat.events')?.push({
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
  expect(desktop.harness('web-core:chat-2')).toBe('claude');
  expect(desktop.harness(CHAT_KEY)).toBeUndefined();
});

describe('a task restored from the archive follows its event stream again (CAN-6511)', () => {
  const RESTORED = { projectId: 'web-core:ws-1', worktreeId: 'web-core:wt-1' };
  afterEach(() => clearCloudTaskDeletions());

  /** A backend whose task streams stay open, or end not found when told. */
  function streams(): {
    backend: ReturnType<typeof createWebCoreChatBackendCore>;
    opens: () => number;
    endNotFound: () => void;
  } {
    let opened = 0;
    let end: (() => void) | null = null;
    const backend = createWebCoreChatBackendCore({
      invoker: () => ({
        request: (): Promise<never> => Promise.reject(new Error('unused')),
        openStream: (method): Promise<CoreCoworkStream> => {
          if (method === 'core.chat.events') opened += 1;
          return Promise.resolve({
            next: () =>
              new Promise((resolve) => {
                end = (): void =>
                  resolve({
                    done: false,
                    value: {
                      kind: 'end',
                      outcome: 'error',
                      error: {
                        kind: 'not_found',
                        message: 'The task was not found.',
                        retry: { kind: 'never' },
                      },
                    },
                  });
              }),
            close: () => Promise.resolve(),
          });
        },
      }),
      newId: () => crypto.randomUUID(),
      reopenDelayMs: 0,
      publishLive: () => undefined,
    });
    return {
      backend,
      opens: () => opened,
      endNotFound: () => end?.(),
    };
  }
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  };

  it('opens the stream of a task declared while it was deleted, once', async () => {
    const { backend, opens } = streams();
    markCloudTaskDeleted(RESTORED);
    await backend.setStateScopes({ kind: 'scopes', scopes: [RESTORED] });
    await settle();
    // Deleted: nothing is asked about it, so its stream never opened.
    expect(opens()).toBe(0);

    forgetCloudTaskMark(RESTORED);
    backend.taskRestored(RESTORED);
    await settle();
    expect(opens()).toBe(1);
    // Restored again, or declared again: never a second stream.
    backend.taskRestored(RESTORED);
    await backend.setStateScopes({ kind: 'scopes', scopes: [RESTORED] });
    await settle();
    expect(opens()).toBe(1);
    backend.closeAll();
  });

  it('reopens the closed stream of a task deleted while it was followed, once', async () => {
    const { backend, opens, endNotFound } = streams();
    await backend.setStateScopes({ kind: 'scopes', scopes: [RESTORED] });
    await settle();
    expect(opens()).toBe(1);
    // Deleted elsewhere: the stream ends not found and stays closed.
    endNotFound();
    await settle();
    expect(opens()).toBe(1);

    forgetCloudTaskMark(RESTORED);
    backend.taskRestored(RESTORED);
    await settle();
    expect(opens()).toBe(2);
    backend.taskRestored(RESTORED);
    await settle();
    expect(opens()).toBe(2);
    backend.closeAll();
  });
});
