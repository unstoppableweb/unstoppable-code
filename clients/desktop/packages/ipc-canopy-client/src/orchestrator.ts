/**
 * The paired computer's Orchestrator (App Advisor) over desktop IPC
 * (CAN-5985), following mobile's Computer Connect Orchestrator:
 *
 * - Chats live in the computer's Orchestrator Work Entries
 *   (`APP_ADVISOR_PROJECT_ID`, one Work Entry per nav row). `appAdvisor.chats`
 *   reads `work-entries:list` and each entry's `chat:get-state`; sends use
 *   `chat:send-message` (the composer path that records this controller as
 *   the chat's driver, so the computer routes its renderer tools here), and
 *   stops use `chat:cancel`.
 * - Ask-user questions arrive on the controller's App Advisor surface (a
 *   second transport, the `appAdvisorTransport` port). Subscribing to
 *   `appAdvisor.changed` declares that surface ready, so the computer
 *   delivers the questions already waiting, and keeps them per chat. Answers
 *   and dismissals go back on that surface (`app-advisor:tool-response`) with
 *   the question's chat. Any other renderer request (file panels, browser
 *   tools) is refused at once, as mobile refuses them, rather than left to
 *   time out.
 *
 * Without the surface port the client reports no `appAdvisorChats` and every
 * operation here refuses before the transport.
 */
import type {
  CommandMap,
  DomainEventMap,
  QueryMap,
  ShellCommandReceipt,
  SubscriptionFilter,
  Unsubscribe,
} from '@canopy/app-core';
import type {
  RemoteControlAppAdvisorChatSummary,
  RemoteControlAskUserQuestion,
  RemoteControlAskUserQuestionState,
  RemoteControlChatFileReference,
} from '@canopy/protocol/remote-control/shell';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/protocol/chat-targets';
import { REMOTE_IPC_CHANNELS as C } from '@canopy/protocol/remote-control/channels';
import {
  UnsupportedOperationError,
  type ChannelClient,
} from './channel-client';
import { isRecord, recordWith, recordWithArray, reply } from './decoders';
import type {
  WireAppAdvisorToolCancellation,
  WireAppAdvisorToolRequest,
  WireChatCommandResult,
  WireChatSendResult,
  WireChatState,
  WireCreatedWorkEntry,
  WireWorkEntry,
  WireWorkEntryList,
} from './wire';

type OrchestratorCommandName =
  | 'appAdvisor.send'
  | 'appAdvisor.cancel'
  | 'appAdvisor.setModel'
  | 'appAdvisor.createTab'
  | 'appAdvisor.answerQuestion'
  | 'appAdvisor.dismissQuestion';

export type OrchestratorCommandHandlers = {
  [K in OrchestratorCommandName]: (
    args: CommandMap[K]['args'],
  ) => Promise<CommandMap[K]['result']>;
};

export interface OrchestratorDeps {
  readonly channels: ChannelClient;
  /** The controller's App Advisor surface; null when the host has none. */
  readonly surface: ChannelClient | null;
  readonly randomId: () => string;
  readonly now: () => string;
  /** A concrete model's provider from the computer's registry, or null. */
  readonly modelProvider: (
    model: string,
    projectId?: string,
  ) => Promise<string | null>;
  /** This client's `@` references as computer paths; null when one is unknown. */
  readonly resolveReferences: (
    refs: readonly RemoteControlChatFileReference[] | undefined,
  ) => Record<string, unknown>[] | null | undefined;
}

export const ORCHESTRATOR_UNAVAILABLE =
  "The Orchestrator isn't available on this connection.";
const CHAT_NOT_FOUND = 'This Orchestrator chat is no longer available.';
const QUESTION_GONE = 'This question is no longer waiting for an answer.';
const UNKNOWN_MODEL = "This model isn't available on this computer.";
const FILE_REFERENCE_UNKNOWN = 'Pick the file again, then send.';
const UNSUPPORTED_VIEW =
  'This view is unavailable in the browser. Open it on your computer.';

/** At most this many Work Entries are read for one chat list. */
const MAX_ENTRIES = 100;

const ACTIVE_RUNTIME_STATUSES: ReadonlySet<string> = new Set([
  'queued',
  'starting',
  'streaming',
  'awaiting_input',
  'completing',
]);

const isWorkEntryList = recordWithArray<WireWorkEntryList>('entries');
const isChatState = reply<WireChatState>(
  (value) =>
    isRecord(value) &&
    isRecord(value.tabsFile) &&
    Array.isArray(value.tabsFile.tabs),
);
const isCreatedWorkEntry = reply<WireCreatedWorkEntry>(
  (value) =>
    isRecord(value) &&
    isRecord(value.entry) &&
    typeof value.entry.id === 'string',
);
const isChatCommandResult = recordWith<WireChatCommandResult>('outcome');
const isChatSendResult = reply<WireChatSendResult>(
  (value) => value === undefined || value === null || isRecord(value),
);
const isAnyReply = reply<unknown>(() => true);
const isToolRequest = reply<WireAppAdvisorToolRequest>(
  (value) =>
    isRecord(value) &&
    typeof value.requestId === 'string' &&
    typeof value.kind === 'string',
);
const isToolCancellation = reply<WireAppAdvisorToolCancellation>(
  (value) => isRecord(value) && typeof value.requestId === 'string',
);

function isAskUserQuestion(
  value: unknown,
): value is RemoteControlAskUserQuestion {
  return (
    isRecord(value) &&
    typeof value.question === 'string' &&
    Array.isArray(value.options) &&
    value.options.every((option: unknown) => typeof option === 'string')
  );
}

function unsupported(operation: string, message: string): Promise<never> {
  return Promise.reject(new UnsupportedOperationError(operation, message));
}

function accepted(
  commandId: string,
  result: Record<string, unknown> = {},
  chatId?: string,
): ShellCommandReceipt {
  return {
    commandId,
    queuedWhileReconnecting: false,
    ok: true,
    ...(chatId === undefined ? {} : { chatId }),
    result: { ok: true, ...result },
  };
}

function refused(commandId: string, error: string): ShellCommandReceipt {
  return { commandId, queuedWhileReconnecting: false, ok: false, error };
}

function isApplied(result: WireChatCommandResult): boolean {
  return result.outcome === 'applied' || result.outcome === 'already_applied';
}

type ChatTab = WireChatState['tabsFile']['tabs'][number];

function isChatTab(tab: ChatTab): boolean {
  return (tab.kind ?? 'chat') === 'chat' && tab.archivedAt === undefined;
}

function messageCountOf(tab: ChatTab): number {
  return (
    tab.transcript?.messageCount ??
    tab.transcript?.committedMessageCount ??
    tab.messages?.length ??
    0
  );
}

/** One pending question, keyed by its chat and request. */
interface PendingQuestion {
  readonly chatId: string;
  readonly state: RemoteControlAskUserQuestionState;
}

export interface OrchestratorHandlers {
  readonly query: (
    args: QueryMap['appAdvisor.chats']['args'],
  ) => Promise<QueryMap['appAdvisor.chats']['result']>;
  readonly commands: OrchestratorCommandHandlers;
  readonly subscribe: (
    handler: (event: DomainEventMap['appAdvisor.changed']) => void,
    filter?: SubscriptionFilter,
  ) => Unsubscribe;
}

export function createOrchestratorHandlers(
  deps: OrchestratorDeps,
): OrchestratorHandlers {
  const { channels, surface, randomId } = deps;
  const pending = new Map<string, PendingQuestion>();
  const questionKey = (chatId: string, requestId: string): string =>
    `${chatId}\u0000${requestId}`;

  // One surface listener however many subscribers; dropped with the last.
  const subscribers = new Set<
    (event: DomainEventMap['appAdvisor.changed']) => void
  >();
  let stopListening: Unsubscribe | null = null;
  const notify = (): void => {
    const event: DomainEventMap['appAdvisor.changed'] = {
      reason: 'question',
      occurredAt: deps.now(),
    };
    for (const subscriber of [...subscribers]) subscriber(event);
  };
  const refuseRequest = (
    on: ChannelClient,
    request: WireAppAdvisorToolRequest,
  ): void => {
    const payload = request.payload;
    const payloadOrigin =
      isRecord(payload) && isRecord(payload.origin)
        ? payload.origin.chatTabId
        : undefined;
    const origin =
      request.originChatTabId ??
      (typeof payloadOrigin === 'string' ? payloadOrigin : undefined);
    void on
      .invokeVoid(C.appAdvisorToolResponse, {
        requestId: request.requestId,
        ...(origin === undefined ? {} : { originChatId: origin }),
        ok: false,
        error: { code: 'unsupported_action', message: UNSUPPORTED_VIEW },
      })
      .catch(() => undefined);
  };
  const startListening = (on: ChannelClient): Unsubscribe => {
    const stopRequests = on.listen(
      C.appAdvisorToolRequest,
      isToolRequest,
      (request) => {
        if (
          request.kind === 'ask_user_question' &&
          request.chatId !== undefined &&
          isAskUserQuestion(request.question)
        ) {
          const key = questionKey(request.chatId, request.requestId);
          if (pending.has(key)) return;
          pending.set(key, {
            chatId: request.chatId,
            state: {
              requestId: request.requestId,
              questions: [request.question],
              answered: false,
            },
          });
          notify();
          return;
        }
        refuseRequest(on, request);
      },
    );
    const stopCancellations = on.listen(
      C.appAdvisorToolRequestCancelled,
      isToolCancellation,
      (cancellation) => {
        let changed = false;
        for (const [key, question] of pending) {
          if (
            question.state.requestId === cancellation.requestId &&
            (cancellation.originChatId === undefined ||
              cancellation.originChatId === question.chatId)
          ) {
            pending.delete(key);
            changed = true;
          }
        }
        if (changed) notify();
      },
    );
    // After the listeners: the computer delivers waiting questions again.
    void on.invokeVoid(C.appAdvisorWindowRendererReady).catch(() => undefined);
    return (): void => {
      stopRequests();
      stopCancellations();
    };
  };

  const subscribe = (
    handler: (event: DomainEventMap['appAdvisor.changed']) => void,
  ): Unsubscribe => {
    // Without the surface no question can arrive: nothing to report.
    if (surface === null) return (): void => undefined;
    subscribers.add(handler);
    stopListening ??= startListening(surface);
    let active = true;
    return (): void => {
      if (!active) return;
      active = false;
      subscribers.delete(handler);
      if (subscribers.size === 0 && stopListening !== null) {
        stopListening();
        stopListening = null;
        pending.clear();
      }
    };
  };

  const listEntries = async (): Promise<readonly WireWorkEntry[]> =>
    (
      await channels.invoke(C.workEntriesList, isWorkEntryList, {
        projectId: APP_ADVISOR_PROJECT_ID,
      })
    ).entries.slice(0, MAX_ENTRIES);

  const readEntry = (entryId: string): Promise<WireChatState> =>
    channels.invoke(C.chatGetState, isChatState, {
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: entryId,
    });

  /** The Work Entry that holds `chatId`, or null. */
  const findEntry = async (chatId: string): Promise<string | null> => {
    for (const entry of await listEntries()) {
      const state = await readEntry(entry.id);
      if (
        state.tabsFile.tabs.some((tab) => tab.id === chatId && isChatTab(tab))
      )
        return entry.id;
    }
    return null;
  };

  const chatCommand = async (
    entryId: string,
    command: Record<string, unknown>,
  ): Promise<{ commandId: string; reply: WireChatCommandResult }> => {
    const commandId = randomId();
    const reply = await channels.invoke(C.chatCommand, isChatCommandResult, {
      schemaVersion: 1,
      commandId,
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: entryId,
      command,
    });
    return { commandId, reply };
  };

  const createEntry = async (
    sidebarItemGroupId: string | undefined,
  ): Promise<string> =>
    (
      await channels.invoke(C.workEntriesCreate, isCreatedWorkEntry, {
        projectId: APP_ADVISOR_PROJECT_ID,
        ...(sidebarItemGroupId === undefined ? {} : { sidebarItemGroupId }),
      })
    ).entry.id;

  const query = async (): Promise<QueryMap['appAdvisor.chats']['result']> => {
    if (surface === null) {
      return unsupported('appAdvisor.chats', ORCHESTRATOR_UNAVAILABLE);
    }
    const entries = await listEntries();
    const chats: RemoteControlAppAdvisorChatSummary[] = [];
    for (const [entryOrder, entry] of entries.entries()) {
      const state = await readEntry(entry.id);
      const unread = new Set(
        (entry.unreadChats ?? []).map((chat) => chat.chatId),
      );
      const tabs = state.tabsFile.tabs.filter(isChatTab);
      for (const [order, tab] of tabs.entries()) {
        const runtime = state.runtimeByChatId?.[tab.id];
        const questions = [...pending.values()]
          .filter((question) => question.chatId === tab.id)
          .map((question) => question.state);
        chats.push({
          localId: tab.id,
          chatId: tab.id,
          title: tab.customTitle?.trim() || tab.title || 'New chat',
          ...(tab.customTitle === undefined
            ? {}
            : { customTitle: tab.customTitle }),
          ...(tab.createdAt === undefined ? {} : { createdAt: tab.createdAt }),
          order,
          active: state.tabsFile.activeTabId === tab.id,
          messageCount: messageCountOf(tab),
          ...(tab.model === undefined ? {} : { model: tab.model }),
          ...(tab.providerType === undefined
            ? {}
            : { providerType: tab.providerType }),
          turnActive:
            runtime?.status !== undefined &&
            ACTIVE_RUNTIME_STATUSES.has(runtime.status),
          hasUnread: unread.has(tab.id),
          ...(questions.length === 0 ? {} : { pendingQuestions: questions }),
          workEntryId: entry.id,
          workEntryTitle: entry.title,
          workEntryCreatedAt: entry.createdAt,
          ...(entry.lastMessageAt === undefined
            ? {}
            : { workEntryLastMessageAt: entry.lastMessageAt }),
          workEntryOrder: entryOrder,
        });
      }
    }
    return { chats };
  };

  const answer = async (
    operation: 'appAdvisor.answerQuestion' | 'appAdvisor.dismissQuestion',
    chatId: string,
    requestId: string,
    response: Record<string, unknown>,
  ): Promise<ShellCommandReceipt> => {
    const on = surface;
    if (on === null) return unsupported(operation, ORCHESTRATOR_UNAVAILABLE);
    const commandId = randomId();
    const key = questionKey(chatId, requestId);
    const question = pending.get(key);
    if (question === undefined) return refused(commandId, QUESTION_GONE);
    await on.invoke(C.appAdvisorToolResponse, isAnyReply, {
      requestId,
      originChatId: chatId,
      ...response,
    });
    if (pending.get(key) === question) {
      pending.delete(key);
      notify();
    }
    return accepted(commandId);
  };

  const commands: OrchestratorCommandHandlers = {
    'appAdvisor.send': async ({ payload }) => {
      if (surface === null) {
        return unsupported('appAdvisor.send', ORCHESTRATOR_UNAVAILABLE);
      }
      const fileReferences = deps.resolveReferences(payload.fileReferences);
      if (fileReferences === null) {
        return unsupported('appAdvisor.send', FILE_REFERENCE_UNKNOWN);
      }
      const commandId = randomId();
      let providerType: string | undefined;
      if (payload.model !== undefined) {
        const provider =
          payload.providerType ??
          (await deps.modelProvider(payload.model, APP_ADVISOR_PROJECT_ID));
        if (provider === null) return refused(commandId, UNKNOWN_MODEL);
        providerType = provider;
      }
      let entryId: string | null = payload.workEntryId ?? null;
      let chatId = payload.chatId;
      if (chatId !== undefined && entryId === null) {
        entryId = await findEntry(chatId);
        if (entryId === null) return refused(commandId, CHAT_NOT_FOUND);
      }
      entryId ??= await createEntry(undefined);
      if (chatId === undefined) {
        // Portal's computer mints the tab; here the client does, first.
        const minted = randomId();
        const created = await chatCommand(entryId, {
          type: 'chat.create_tab',
          tabId: minted,
        });
        if (!isApplied(created.reply)) {
          return refused(
            created.commandId,
            created.reply.reason ?? CHAT_NOT_FOUND,
          );
        }
        chatId = created.reply.entityId ?? minted;
      }
      const userMessageId = payload.userMessageId ?? randomId();
      const result = await channels.invoke(
        C.chatSendMessage,
        isChatSendResult,
        {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: entryId,
          chatId,
          userMessageId,
          text: payload.text,
          ...(fileReferences === undefined ? {} : { fileReferences }),
          ...(payload.attachmentPaths === undefined ||
          payload.attachmentPaths.length === 0
            ? {}
            : { attachmentPaths: payload.attachmentPaths }),
          ...(payload.model === undefined ? {} : { model: payload.model }),
          ...(providerType === undefined ? {} : { providerType }),
          ...(payload.modelConfig === undefined
            ? {}
            : { modelConfig: payload.modelConfig }),
          ...(payload.pluginSelections === undefined
            ? {}
            : { pluginSelections: payload.pluginSelections }),
          ...(payload.inputMode === undefined
            ? {}
            : { inputMode: payload.inputMode }),
        },
      );
      if (
        isRecord(result) &&
        result.refusedAuthDependencies !== undefined &&
        result.refusedAuthDependencies !== null
      ) {
        return refused(
          commandId,
          'Sign in to the required provider on your computer, then try again.',
        );
      }
      // Refused before anything was saved (CAN-6701); the host's sentence
      // names the organization and its gateway.
      if (
        isRecord(result) &&
        isRecord(result.refusedSend) &&
        typeof result.refusedSend.message === 'string'
      ) {
        return refused(commandId, result.refusedSend.message);
      }
      return accepted(commandId, { userMessageId }, chatId);
    },
    'appAdvisor.cancel': async ({ payload }) => {
      if (surface === null) {
        return unsupported('appAdvisor.cancel', ORCHESTRATOR_UNAVAILABLE);
      }
      const commandId = randomId();
      const entryId = await findEntry(payload.chatId);
      if (entryId === null) return refused(commandId, CHAT_NOT_FOUND);
      await channels.invoke(C.chatCancel, isAnyReply, {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: entryId,
        chatId: payload.chatId,
      });
      return accepted(commandId);
    },
    'appAdvisor.setModel': async ({ payload }) => {
      if (surface === null) {
        return unsupported('appAdvisor.setModel', ORCHESTRATOR_UNAVAILABLE);
      }
      const commandId = randomId();
      const entryId = await findEntry(payload.chatId);
      if (entryId === null) return refused(commandId, CHAT_NOT_FOUND);
      const providerType = await deps.modelProvider(
        payload.model,
        APP_ADVISOR_PROJECT_ID,
      );
      if (providerType === null) return refused(commandId, UNKNOWN_MODEL);
      const changed = await chatCommand(entryId, {
        type: 'chat.set_model',
        tabId: payload.chatId,
        model: payload.model,
        providerType,
        ...(payload.executionHarness === undefined
          ? {}
          : { executionHarness: payload.executionHarness }),
      });
      return isApplied(changed.reply)
        ? accepted(changed.commandId)
        : refused(
            changed.commandId,
            changed.reply.reason ??
              'The selected model is unavailable for this chat.',
          );
    },
    'appAdvisor.createTab': async ({ payload }) => {
      if (surface === null) {
        return unsupported('appAdvisor.createTab', ORCHESTRATOR_UNAVAILABLE);
      }
      const entryId =
        payload.workEntryId ?? (await createEntry(payload.sidebarItemGroupId));
      const created = await chatCommand(entryId, {
        type: 'chat.create_tab',
        tabId: payload.chatId,
      });
      return isApplied(created.reply)
        ? accepted(created.commandId, { workEntryId: entryId })
        : refused(created.commandId, created.reply.reason ?? CHAT_NOT_FOUND);
    },
    'appAdvisor.answerQuestion': ({ payload }) => {
      const first = payload.answers[0];
      if (first === undefined || payload.answers.length !== 1) {
        return Promise.resolve(
          refused(randomId(), 'Answer the question before continuing.'),
        );
      }
      return answer(
        'appAdvisor.answerQuestion',
        payload.chatId,
        payload.requestId,
        {
          ok: true,
          answer: {
            ...(first.questionId === undefined
              ? {}
              : { questionId: first.questionId }),
            question: first.question,
            selectedOptions: first.selectedOptions,
            ...(first.freeformText === undefined
              ? {}
              : { freeformText: first.freeformText }),
          },
        },
      );
    },
    'appAdvisor.dismissQuestion': ({ payload }) =>
      answer('appAdvisor.dismissQuestion', payload.chatId, payload.requestId, {
        ok: false,
        error: { code: 'cancelled', message: 'User dismissed the question.' },
      }),
  };

  return { query, commands, subscribe };
}
