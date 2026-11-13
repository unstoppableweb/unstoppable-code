import {
  CoreChatCommandReceiptSchema,
  CoreChatSnapshotGetResultSchema,
  CoreChatSendReceiptResultSchema,
  type CanopyErrorPayload,
} from '@canopy/protocol/canopy-core';
import {
  CoreCoworkRequestError,
  type CanopyCoreRelayLikeReply,
  type CoreCoworkInvoker,
  type CoreCoworkStream,
} from '@canopy/app-state/core-cowork';
import { sendFailure } from './send-refusal';
import type {
  AgentProviderType,
  ArchivedChatSummary,
  AttachmentMeta,
  ChatArchiveTabRequest,
  ChatCancelRequest,
  ChatCancelResult,
  ChatCommandRequest,
  ChatCommandResult,
  ChatGetStateRequest,
  ChatSendMessageRequest,
  ChatSendMessageResult,
  ChatStateChangedEvent,
  ChatStateScopesDeclaration,
  ChatStateSnapshot,
  ChatRestoreArchiveRequest,
  ChatRestoreArchiveResponse,
  ChatModel,
  ChatTranscriptPageRequest,
  CloudChatAttachmentUploadFile,
  CloudChatAttachmentUploadResult,
  CloudChatUploadTarget,
  CodexFastModeToggleRequest,
  PersistedChatMessage,
  PersistedChatTab,
  ThinkingLevelToggleRequest,
} from '@canopy/desktop-shared/types';
import type { ModelCatalogOption } from '@canopy/protocol/models';
import {
  CLOUD_ATTACHMENTS_MAX_PER_MESSAGE,
  type CloudAttachmentMediaType,
} from '@canopy/protocol/cloud-attachments';
import {
  CLOUD_ATTACHMENT_LIMIT_MESSAGE,
  cloudAttachmentIdOfPath,
  cloudAttachmentPath,
  rememberCloudAttachmentPreview,
} from '@/cloud-chats/cloud-chat-attachments';
import type {
  TranscriptDescriptor,
  TranscriptPage,
} from '@canopy/agent-transcript/transcript-storage';
import { isWebCoreScope, webCoreLocalId } from '@/lib/chat-authority';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import {
  createLiveFollower,
  isTerminalEnd,
  type LiveChat,
} from './live-follower';
import type { LiveChatState } from './live-replies';
import { selectionSaveSettled } from './selection-saves';
import {
  isTaskBeingCreated,
  taskCreated,
  taskCreationSettled,
} from './task-creations';
import { setWebCoreFastMode, useWebCoreFastModeStore } from './fast-mode';
import {
  activeTurnChanges,
  bareId,
  bareScope,
  qualifiedId,
  parseEventItem,
  rereadChatIds,
  transcriptDescriptor,
  parseChatList,
  planCommand,
  translateCommandResult,
  translateEvent,
  translateSnapshot,
  translateTranscriptPage,
  isTurnRunningStatus,
  isServedThinkingLevel,
  sendModelConfig,
  withTabChoices,
  withTabSettings,
  withTranscriptPages,
  type CommandRequest,
  type TabChoices,
  type TabReadChoice,
  type TabSettingsChoice,
  type WebCoreIds,
} from './translate';

/**
 * The chat store's I/O for chats the web core serves (CAN-6175 R3), over the
 * renderer relay. Reads, commands and the committed event stream go through
 * the same `core.chat.*` operations the web uses; the store folds them
 * exactly as it folds the local core's.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A store request the web core cannot serve, refused before any effect. */
export function webCoreUnavailable(member: string): Error {
  return Object.assign(
    new Error(`${member} is not available in cloud chats yet.`),
    { code: 'capability_unavailable' },
  );
}

const TERMINAL_KINDS: ReadonlySet<CanopyErrorPayload['kind']> = new Set([
  'unauthenticated',
  'permission_denied',
  'capability_unavailable',
  'not_found',
]);

/** Statuses during which a turn runs and Stop applies. */
const ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  'queued',
  'starting',
  'streaming',
  'awaiting_input',
  'completing',
]);

function unwrap(reply: CanopyCoreRelayLikeReply): unknown {
  if (!reply.ok) throw new CoreCoworkRequestError(reply.error);
  return reply.value;
}

function defaultId(): string {
  return crypto.randomUUID();
}

type Scope = { readonly projectId: string; readonly worktreeId: string };

type PendingQuestion = NonNullable<
  ChatStateSnapshot['tabsFile']['pendingQuestions']
>[number];

type QuestionChange = Extract<
  ChatStateChangedEvent['changes'][number],
  { type: 'pending_question.upserted' | 'pending_question.removed' }
>;

/** A question change an event applied, at the store revision it reached. */
interface AppliedQuestionChange {
  readonly revision: number;
  readonly change: QuestionChange;
}

function applyQuestionChange(
  shown: Map<string, PendingQuestion>,
  change: QuestionChange,
): void {
  if (change.type === 'pending_question.upserted')
    shown.set(change.question.requestId, change.question);
  else shown.delete(change.requestId);
}

const scopeKey = (scope: Scope): string =>
  `${scope.projectId}/${scope.worktreeId}`;

/** A cloud tab's model and the provider that runs it. */
export interface CloudTabModel {
  readonly model: ChatModel | undefined;
  readonly providerType: AgentProviderType | undefined;
}

/** A cloud tab's model as this window knows it, ordered by revision. */
interface TabModelState {
  /**
   * The newest model the web core reported, at its own revision: the store's
   * revisions shift after a late echo's repair, so they cannot order these.
   */
  reported?: { readonly choice: CloudTabModel; readonly revision: number };
  /** This window's pick while its `chat.set_model` is in flight. */
  pending?: CloudTabModel;
  /**
   * The window's newest pick, from the moment the composer shows it until
   * it settles: a pick can wait behind an older one still in flight.
   */
  picked?: CloudTabModel;
}

/** The tab with the model a change shows for it. */
function withTabModel(
  tab: PersistedChatTab,
  shown: CloudTabModel,
): PersistedChatTab {
  if (tab.model === shown.model && tab.providerType === shown.providerType)
    return tab;
  const next = { ...tab };
  if (shown.model === undefined) delete next.model;
  else next.model = shown.model;
  if (shown.providerType === undefined) delete next.providerType;
  else next.providerType = shown.providerType;
  return next;
}

interface ChatTurns {
  /** The running turn as the web core reports it, by bare chat id. */
  readonly active: Map<string, string>;
  /** Turns this client started and the web core has not reported yet. */
  readonly pending: Map<string, string>;
  /** Status the web core last reported, by bare chat id. */
  readonly status: Map<string, string>;
  /** Runtime reports seen per chat, so a send can tell whether one came since. */
  readonly reports: Map<string, number>;
}

/** Chat and message ids remembered across the two sides, newest last. */
const MESSAGE_ID_LIMIT = 500;

/** How long a user message waits for the send that may have written it. */
const ECHO_WAIT_MS = 10_000;

/** Pages of `core.chat.list` read for one task. */
const CHAT_LIST_PAGE_LIMIT = 10;

const isSnapshotRequired = (error: unknown): boolean =>
  isRecord(error) && error.code === 'core.chat.snapshotRequired';

interface ScopeStream {
  readonly scope: Scope;
  epoch: number;
  stream: CoreCoworkStream | null;
  cursor: unknown;
  reopenTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
}

export interface WebCoreChatBackendOptions {
  readonly invoker: () => CoreCoworkInvoker | null;
  readonly newId?: () => string;
  /** Delay before reopening a scope's event stream after it ends. */
  readonly reopenDelayMs?: number;
  /** Publishes a shown chat's live replies; an empty list clears them. */
  readonly publishLive?: (key: string, chat: LiveChatState) => void;
  readonly liveReopenDelayMs?: number;
  readonly liveHoldMs?: number;
  /** How long a user message waits for its send's receipt. */
  readonly echoWaitMs?: number;
  /** A chat's model as its web core workspace's catalog lists it. */
  readonly modelOption?: (
    projectId: string,
    model: string | undefined,
  ) => ModelCatalogOption | undefined;
  /**
   * Main's upload of one file to a cloud chat over its own web core
   * connection (CAN-5988). The renderer relay's request cap is too small for
   * an attachment's bytes.
   */
  readonly uploadAttachment?: (
    target: CloudChatUploadTarget,
    file: CloudChatAttachmentUploadFile,
  ) => Promise<CloudChatAttachmentUploadResult>;
}

/** A file the composer attaches to a web core chat, read in the renderer. */
export interface WebCoreAttachmentFile {
  readonly name: string;
  readonly mediaType: CloudAttachmentMediaType;
  readonly bytes: Uint8Array;
}

export interface WebCoreChatBackendCore {
  readonly getState: (req: ChatGetStateRequest) => Promise<ChatStateSnapshot>;
  readonly setStateScopes: (
    declaration: ChatStateScopesDeclaration,
  ) => Promise<void>;
  readonly onStateChanged: (
    cb: (event: ChatStateChangedEvent) => void,
  ) => () => void;
  readonly getTranscriptPage: (
    req: ChatTranscriptPageRequest,
  ) => Promise<TranscriptPage>;
  readonly command: (req: ChatCommandRequest) => Promise<ChatCommandResult>;
  readonly archiveTab: (
    req: ChatArchiveTabRequest,
  ) => Promise<ArchivedChatSummary[]>;
  readonly restoreArchive: (
    req: ChatRestoreArchiveRequest,
  ) => Promise<ChatRestoreArchiveResponse>;
  readonly loadArchives: (
    req: ChatGetStateRequest,
  ) => Promise<ArchivedChatSummary[]>;
  readonly sendMessage: (
    req: ChatSendMessageRequest,
  ) => Promise<ChatSendMessageResult>;
  readonly cancel: (req: ChatCancelRequest) => Promise<ChatCancelResult>;
  /** Keeps a tab's fast mode for its sends; Ultra fast is refused. */
  readonly toggleCodexFastMode: (
    req: CodexFastModeToggleRequest,
  ) => Promise<void>;
  /** Keeps a tab's thinking level for its sends; Ultra is refused. */
  readonly toggleThinkingLevel: (
    req: ThinkingLevelToggleRequest,
  ) => Promise<void>;
  /**
   * A store chat id as the web core names it: the id minted for a tab the
   * store created, or the bare id of a web core one; null for neither.
   */
  readonly webCoreChatId: (chatId: string) => string | null;
  /**
   * The model the web core runs for a tab, as the newest revision this
   * window has seen names it (CAN-6345).
   */
  readonly webCoreTabModel: (
    req: Scope & { readonly chatId: string },
  ) => CloudTabModel | undefined;
  /**
   * Notes the window's newest model pick for a tab as the composer shows
   * it, or null once it settles: it shows over every model-bearing change
   * meanwhile, also while an older pick is still in flight.
   */
  readonly pickWebCoreTabModel: (
    req: Scope & { readonly chatId: string },
    choice: CloudTabModel | null,
  ) => void;
  /** The web core chats on screen, which follow their live reply. */
  readonly setLiveChats: (chats: readonly LiveChat[]) => void;
  /** Ends every stream: the web core went offline or the window closes. */
  readonly closeAll: () => void;
  /**
   * Uploads a file to a chat and answers the pending attachment that names
   * it, which its send carries; a refused upload answers its reason.
   */
  readonly uploadAttachment: (
    target: ChatTarget,
    file: WebCoreAttachmentFile,
  ) => Promise<
    | { readonly ok: true; readonly attachment: AttachmentMeta }
    | {
        readonly ok: false;
        readonly reason: Extract<
          CloudChatAttachmentUploadResult,
          { ok: false }
        >['reason'];
      }
  >;
}

type ChatTarget = {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
};

export function createWebCoreChatBackendCore(
  options: WebCoreChatBackendOptions,
): WebCoreChatBackendCore {
  const newId = options.newId ?? defaultId;
  const reopenDelayMs = options.reopenDelayMs ?? 1_000;
  const echoWaitMs = options.echoWaitMs ?? ECHO_WAIT_MS;
  const listeners = new Set<(event: ChatStateChangedEvent) => void>();
  const streams = new Map<string, ScopeStream>();
  const cursors = new Map<string, unknown>();
  /** The last revision the store was given per scope, for answers it gives itself. */
  const revisions = new Map<string, number>();
  /**
   * Revisions this backend added per scope on its own (a late receipt's
   * repair): every web core revision the store sees is shifted by them, so
   * the next real event still follows the store's revision.
   */
  const offsets = new Map<string, number>();
  const toStoreRevision = (scope: Scope, revision: number): number =>
    revision + (offsets.get(scopeKey(scope)) ?? 0);
  const turnsByScope = new Map<string, ChatTurns>();
  /** The window's active tab and tab order per scope, kept across snapshots. */
  const tabChoices = new Map<string, TabChoices>();
  /**
   * Each cloud tab's model per scope and store tab id, ordered by the web
   * core's revisions (CAN-6345). A pick's reply, a snapshot and an event can
   * land in any order: a pick in flight shows over every model-bearing
   * change, and no change shows a model older than the newest known.
   */
  const tabModels = new Map<string, Map<string, TabModelState>>();
  /** The newest web core revision each scope reported, unshifted. */
  const coreHeads = new Map<string, number>();
  /** The web core revision of each snapshot `readState` returned, unshifted. */
  const coreRevisionOf = new WeakMap<ChatStateSnapshot, number>();

  function sawCoreRevision(scope: Scope, revision: number): void {
    const key = scopeKey(scope);
    coreHeads.set(key, Math.max(coreHeads.get(key) ?? 0, revision));
  }

  function tabModelState(scope: Scope, tabId: string): TabModelState {
    const key = scopeKey(scope);
    const byTab = tabModels.get(key) ?? new Map<string, TabModelState>();
    tabModels.set(key, byTab);
    const state = byTab.get(tabId) ?? {};
    byTab.set(tabId, state);
    return state;
  }

  /**
   * The model a change at web core `revision` shows for a tab. With
   * `record`, what the web core reported there becomes the newest known
   * when it is.
   */
  function shownTabModel(
    scope: Scope,
    tabId: string,
    revision: number,
    reported: CloudTabModel,
    record: boolean,
  ): CloudTabModel {
    const state = tabModelState(scope, tabId);
    if (
      record &&
      (state.reported === undefined || revision >= state.reported.revision)
    )
      state.reported = { choice: reported, revision };
    const pick = state.picked ?? state.pending;
    if (pick !== undefined) return pick;
    const newest = state.reported;
    // Without `record`, the tab already carries an earlier overlay: what the
    // web core reported at its revision is the newest known there.
    const newer =
      newest !== undefined &&
      (record ? newest.revision > revision : newest.revision >= revision);
    return newer ? newest.choice : reported;
  }

  function withTabModels(
    scope: Scope,
    snapshot: ChatStateSnapshot,
    coreRevision: number,
    record: boolean,
  ): ChatStateSnapshot {
    return {
      ...snapshot,
      tabsFile: {
        ...snapshot.tabsFile,
        tabs: snapshot.tabsFile.tabs.map((tab) =>
          tab.kind === 'file'
            ? tab
            : withTabModel(
                tab,
                shownTabModel(
                  scope,
                  tab.id,
                  coreRevision,
                  { model: tab.model, providerType: tab.providerType },
                  record,
                ),
              ),
        ),
      },
    };
  }
  /**
   * Each scope's unanswered questions as the store was last given them, by
   * request id. A snapshot that could not read a chat's questions keeps
   * that chat's from here.
   */
  const questions = new Map<string, Map<string, PendingQuestion>>();
  /**
   * Question changes events applied per scope while a snapshot read was in
   * flight: those newer than the snapshot are replayed onto what it read.
   */
  const questionReads = new Map<string, Set<AppliedQuestionChange[]>>();
  /**
   * The store revision of the snapshot each scope's questions were last read
   * at: an event at or below it is one that snapshot already covers.
   */
  const questionsReadAt = new Map<string, number>();
  /**
   * Chats per scope whose transcript the store has read, by store id. Kept
   * across `closeAll`: the store keeps their rows through a reconnect.
   */
  const readChats = new Map<string, Set<string>>();
  /** The store's id for each message the web core minted its own id for. */
  const storeIds = new Map<string, string>();
  const coreIds = new Map<string, string>();
  /** Chats the store created: its own id, by the UUID minted for the web core. */
  const storeChatIds = new Map<string, string>();
  const coreChatIds = new Map<string, string>();
  /**
   * User messages published under the web core's id because their send's
   * receipt outlasted the echo wait, by that id.
   */
  const released = new Map<
    string,
    { readonly scope: Scope; readonly chatId: string }
  >();
  /** Sends in flight per bare chat id, settled once their message id is known. */
  const sending = new Map<string, Set<Promise<void>>>();
  const ids: WebCoreIds = {
    chatToStore: (id) => storeChatIds.get(id) ?? qualifiedId(id),
    chatToCore: (id) => coreChatIds.get(id) ?? bareId(id),
    newChatToCore: (id) => {
      const known = coreChatIds.get(id) ?? webCoreLocalId(id);
      if (known !== null && known !== undefined) return known;
      const minted = newId();
      storeChatIds.set(minted, id);
      coreChatIds.set(id, minted);
      return minted;
    },
    messageToStore: (id) => storeIds.get(id) ?? id,
    messageToCore: (id) => coreIds.get(id) ?? id,
  };

  /**
   * The attachments each sent message carried, by store message id. The web
   * core's transcript does not carry a message's attachments yet (CAN-6116),
   * so its copy of a sent message keeps them from here.
   */
  const sentAttachments = new Map<string, string[]>();

  function withSentAttachments(
    message: PersistedChatMessage,
  ): PersistedChatMessage {
    const paths = sentAttachments.get(message.id);
    return paths === undefined || (message.attachmentPaths?.length ?? 0) > 0
      ? message
      : { ...message, attachmentPaths: paths };
  }

  function remember(coreId: string, storeId: string): void {
    if (coreId === storeId) return;
    storeIds.set(coreId, storeId);
    coreIds.set(storeId, coreId);
    const late = released.get(coreId);
    if (late !== undefined) {
      released.delete(coreId);
      repairLateEcho(late.scope, late.chatId);
    }
    for (const [oldest, storeIdOfOldest] of storeIds) {
      if (storeIds.size <= MESSAGE_ID_LIMIT) break;
      storeIds.delete(oldest);
      coreIds.delete(storeIdOfOldest);
    }
  }

  /**
   * A message published under the web core's id before its receipt named
   * the store's: mark the chat's transcript stale at once, so the store
   * re-reads it under the store's id instead of keeping both rows. The
   * change follows the store's revision as one revision of this backend's
   * own; later web core revisions shift past it.
   */
  function repairLateEcho(scope: Scope, chatId: string): void {
    const key = scopeKey(scope);
    const base = revisions.get(key);
    // No state given for the scope yet: its first snapshot reads it fresh.
    if (base === undefined) return;
    offsets.set(key, (offsets.get(key) ?? 0) + 1);
    revisions.set(key, base + 1);
    emit({
      schemaVersion: 1,
      eventId: `web-core-repair:${key}:${base + 1}:${newId()}`,
      occurredAt: new Date().toISOString(),
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
      baseRevision: base,
      revision: base + 1,
      changes: [{ type: 'messages.omitted', chatId: ids.chatToStore(chatId) }],
    });
  }

  /**
   * A user message a send in flight may have written waits for that send's
   * receipt, which names its id, so the store keeps the id it sent under.
   */
  async function sendsSettled(
    scope: Scope,
    messages: readonly { readonly chatId: string; readonly message: unknown }[],
  ): Promise<void> {
    const unknown = messages.flatMap(({ chatId, message }) =>
      isRecord(message) &&
      message.role === 'user' &&
      typeof message.id === 'string' &&
      !storeIds.has(message.id) &&
      (sending.get(chatId)?.size ?? 0) > 0
        ? [{ chatId, id: message.id }]
        : [],
    );
    if (unknown.length === 0) return;
    const waits = unknown.flatMap(({ chatId }) => [
      ...(sending.get(chatId) ?? []),
    ]);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    await Promise.race([
      Promise.all(waits),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, echoWaitMs);
      }),
    ]);
    if (timer !== null) clearTimeout(timer);
    if (!timedOut) return;
    for (const { chatId, id } of unknown)
      if (!storeIds.has(id)) released.set(id, { scope, chatId });
    for (const oldest of released.keys()) {
      if (released.size <= MESSAGE_ID_LIMIT) break;
      released.delete(oldest);
    }
  }

  function invoker(): CoreCoworkInvoker {
    const current = options.invoker();
    if (current === null) throw webCoreUnavailable('The web core');
    return current;
  }

  function turnsFor(scope: Scope): ChatTurns {
    const key = scopeKey(scope);
    const known = turnsByScope.get(key);
    if (known !== undefined) return known;
    const created: ChatTurns = {
      active: new Map(),
      pending: new Map(),
      status: new Map(),
      reports: new Map(),
    };
    turnsByScope.set(key, created);
    return created;
  }

  /** Core also parks an idle session as awaiting input: only a known turn runs. */
  function turnRuns(scope: Scope, chatId: string): boolean {
    const turns = turnsFor(scope);
    const status = turns.status.get(chatId) ?? 'idle';
    return (
      turns.pending.has(chatId) ||
      (ACTIVE_STATUSES.has(status) &&
        (status !== 'awaiting_input' || turns.active.has(chatId)))
    );
  }

  const live = createLiveFollower({
    invoker,
    messageIds: ids,
    chatToCore: ids.chatToCore,
    turnRuns: (chat) => turnRuns(chat, ids.chatToCore(chat.chatId)),
    publish: options.publishLive ?? ((): void => undefined),
    ...(options.liveReopenDelayMs === undefined
      ? {}
      : { reopenDelayMs: options.liveReopenDelayMs }),
    ...(options.liveHoldMs === undefined ? {} : { holdMs: options.liveHoldMs }),
  });

  async function request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    return unwrap(await invoker().request(method, params));
  }

  async function readPage(
    scope: Scope,
    chatId: string,
    paging: Record<string, unknown> = {},
  ): Promise<TranscriptPage> {
    const page = await request('core.chat.transcript.page', {
      scope: { ...bareScope(scope), chatId },
      ...paging,
    });
    if (isRecord(page) && Array.isArray(page.messages))
      await sendsSettled(
        scope,
        page.messages.map((message: unknown) => ({ chatId, message })),
      );
    const translated = translateTranscriptPage(page, ids);
    return {
      ...translated,
      messages: translated.messages.map(withSentAttachments),
    };
  }

  /** Every chat of a task, a page at a time. */
  async function listChats(
    scope: Scope,
  ): Promise<ReturnType<typeof parseChatList>['items']> {
    const items: ReturnType<typeof parseChatList>['items'][number][] = [];
    let cursor: string | null = null;
    for (let page = 0; page < CHAT_LIST_PAGE_LIMIT; page += 1) {
      const listed = parseChatList(
        await request('core.chat.list', {
          scope: bareScope(scope),
          ...(cursor === null ? {} : { cursor }),
        }),
      );
      items.push(...listed.items);
      cursor = listed.nextCursor;
      if (cursor === null) break;
    }
    return items;
  }

  /**
   * `chat.getState`. Chats the store has read come with their newest page:
   * a refresh replaces events this window missed, and the store keeps a
   * body-less tab's rows as they were.
   */
  /**
   * A task this window opened before the web core created it (CAN-6098): its
   * own chat, empty and idle, at revision 0, as the web core's snapshot of a
   * new task names it. Nothing is asked of the web core until it exists.
   */
  function taskInCreation(req: Scope): ChatStateSnapshot {
    const chatId = bareId(req.worktreeId);
    const { snapshot } = translateSnapshot(
      {
        workspaceId: bareId(req.projectId),
        worktreeId: chatId,
        revision: 0,
        eventsCursor: { daemonEpoch: 'web-core-task-in-creation', sequence: 0 },
        tabs: {
          activeTabId: chatId,
          items: [
            {
              chatId,
              title: '',
              kind: 'chat',
              createdAt: new Date().toISOString(),
            },
          ],
        },
        archives: [],
        runtimeByChatId: { [chatId]: { status: 'idle', queuedMessageIds: [] } },
        queue: [],
      },
      [],
      req,
      ids,
    );
    return withTabChoices(snapshot, tabChoices.get(scopeKey(req)));
  }

  async function getState(
    req: ChatGetStateRequest,
  ): Promise<ChatStateSnapshot> {
    if (isTaskBeingCreated(req)) return taskInCreation(req);
    const snapshot = await readState(req);
    const shown = snapshot.tabsFile.tabs
      .map((tab) => tab.id)
      .filter((id) => readChats.get(scopeKey(req))?.has(id) === true);
    const pages = await Promise.all(
      shown.map(
        async (id) => [id, await readPage(req, ids.chatToCore(id))] as const,
      ),
    );
    // A choice made while the pages loaded is newer than the snapshot's
    // overlay, so the window's choices are laid over it again (CAN-6324),
    // and so is a model pick made meanwhile (CAN-6345).
    return withTabModels(
      req,
      withTabChoices(
        withTranscriptPages(snapshot, new Map(pages)),
        tabChoices.get(scopeKey(req)),
      ),
      coreRevisionOf.get(snapshot) ?? 0,
      false,
    );
  }

  async function readState(req: Scope): Promise<ChatStateSnapshot> {
    if (isTaskBeingCreated(req)) return taskInCreation(req);
    const during: AppliedQuestionChange[] = [];
    const reads = questionReads.get(scopeKey(req)) ?? new Set();
    questionReads.set(scopeKey(req), reads.add(during));
    try {
      return await readStateFrom(req, during);
    } finally {
      reads.delete(during);
      if (reads.size === 0) questionReads.delete(scopeKey(req));
    }
  }

  async function readStateFrom(
    req: Scope,
    during: readonly AppliedQuestionChange[],
  ): Promise<ChatStateSnapshot> {
    const turns = turnsFor(req);
    const reportsAtRead = new Map(turns.reports);
    // The snapshot first: its revision and cursor cover every later change.
    const opened = await request('core.chat.snapshot.get', {
      scope: bareScope(req),
    });
    const translated = translateSnapshot(
      opened,
      await listChats(req),
      req,
      ids,
    );
    cursors.set(scopeKey(req), translated.eventsCursor);
    const revision = toStoreRevision(req, translated.snapshot.revision);
    revisions.set(scopeKey(req), revision);
    // A chat whose runtime an event reported while the snapshot was read
    // keeps that newer state.
    const moved = (chatId: string): boolean =>
      (turns.reports.get(chatId) ?? 0) !== (reportsAtRead.get(chatId) ?? 0);
    // A queued or starting turn names no id yet: the receipt's turn stays
    // the one Stop cancels until a reported turn replaces it or it ends.
    const startsUnnamed = (chatId: string): boolean =>
      isTurnRunningStatus(translated.statuses.get(chatId)) &&
      !translated.activeTurns.has(chatId);
    for (const map of [turns.active, turns.pending, turns.status])
      for (const chatId of [...map.keys()])
        if (!moved(chatId) && !(map === turns.pending && startsUnnamed(chatId)))
          map.delete(chatId);
    for (const [chatId, turnId] of translated.activeTurns)
      if (!moved(chatId)) turns.active.set(chatId, turnId);
    for (const [chatId, status] of translated.statuses) {
      if (moved(chatId)) continue;
      turns.status.set(chatId, status);
      // An unnamed starting turn names no turn and ends none: a send in
      // flight still keeps its receipt's turn.
      if (!startsUnnamed(chatId))
        turns.reports.set(chatId, (turns.reports.get(chatId) ?? 0) + 1);
    }
    const read = translated.snapshot.tabsFile.pendingQuestions ?? [];
    const kept = [...(questions.get(scopeKey(req))?.values() ?? [])].filter(
      (question) =>
        translated.unreadQuestionChatIds.has(question.chatId) &&
        !read.some((each) => each.requestId === question.requestId),
    );
    const pendingQuestions = [...read, ...kept];
    const shown = new Map(
      pendingQuestions.map((question) => [question.requestId, question]),
    );
    // The store applies these events after the snapshot; so does this record.
    for (const applied of during)
      if (applied.revision > revision)
        applyQuestionChange(shown, applied.change);
    // A read that a newer one overtook leaves that one's record.
    if (revision >= (questionsReadAt.get(scopeKey(req)) ?? 0)) {
      questions.set(scopeKey(req), shown);
      questionsReadAt.set(scopeKey(req), revision);
    }
    live.refresh();
    sawCoreRevision(req, translated.snapshot.revision);
    const state = withTabChoices(
      withTabModels(
        req,
        {
          ...translated.snapshot,
          revision,
          tabsFile: {
            ...translated.snapshot.tabsFile,
            revision,
            ...(pendingQuestions.length === 0 ? {} : { pendingQuestions }),
          },
        },
        translated.snapshot.revision,
        true,
      ),
      tabChoices.get(scopeKey(req)),
    );
    coreRevisionOf.set(state, translated.snapshot.revision);
    return state;
  }

  function emit(event: ChatStateChangedEvent): void {
    for (const listener of listeners) listener(event);
  }

  async function apply(entry: ScopeStream, item: unknown): Promise<void> {
    const parsed = parseEventItem(item);
    const transcripts = new Map<string, TranscriptDescriptor>();
    for (const chatId of rereadChatIds(parsed))
      transcripts.set(
        chatId,
        transcriptDescriptor(await readPage(entry.scope, chatId)),
      );
    const turns = turnsFor(entry.scope);
    for (const [chatId, turnId] of activeTurnChanges(parsed)) {
      turns.pending.delete(chatId);
      turns.reports.set(chatId, (turns.reports.get(chatId) ?? 0) + 1);
      if (turnId === null) turns.active.delete(chatId);
      else turns.active.set(chatId, turnId);
    }
    for (const change of parsed.changes)
      if (change.type === 'runtime.patched')
        turns.status.set(change.chatId, change.runtime.status);
      // The web core's newer read state replaces the window's choice.
      else if (
        change.type === 'tab.metadata_patched' &&
        typeof change.patch.unread === 'boolean'
      )
        setReadChoice(
          scopeKey(entry.scope),
          ids.chatToStore(change.tabId),
          null,
        );
    await sendsSettled(
      entry.scope,
      parsed.changes.flatMap((change) =>
        change.type === 'message.upserted'
          ? [{ chatId: change.chatId, message: change.message }]
          : [],
      ),
    );
    const translated = translateEvent(parsed, entry.scope, transcripts, ids);
    const settings = tabChoices.get(scopeKey(entry.scope))?.settings;
    // Shifted as it is emitted, after any repair this event waited behind.
    const revision = toStoreRevision(entry.scope, translated.revision);
    sawCoreRevision(entry.scope, translated.revision);
    const event: ChatStateChangedEvent = {
      ...translated,
      changes: translated.changes.map((change) => {
        // A tab the web core sends again keeps the window's settings, and
        // shows its model in revision order (CAN-6345).
        if (change.type === 'tab.upserted') {
          const tab = withTabSettings(change.tab, settings?.get(change.tab.id));
          return {
            ...change,
            tab: withTabModel(
              tab,
              shownTabModel(
                entry.scope,
                tab.id,
                translated.revision,
                { model: tab.model, providerType: tab.providerType },
                true,
              ),
            ),
          };
        }
        if (change.type === 'message.upserted')
          return { ...change, message: withSentAttachments(change.message) };
        if (
          change.type !== 'tab.metadata_patched' ||
          change.patch.model === undefined
        )
          return change;
        // A model patch names no provider: the tab's provider stays.
        const shown = shownTabModel(
          entry.scope,
          change.tabId,
          translated.revision,
          {
            model: change.patch.model ?? undefined,
            providerType: tabModelState(entry.scope, change.tabId).reported
              ?.choice.providerType,
          },
          true,
        );
        return {
          ...change,
          patch: {
            ...change.patch,
            model: shown.model ?? null,
            ...(shown.providerType === undefined
              ? {}
              : { providerType: shown.providerType }),
          },
        };
      }),
      baseRevision: toStoreRevision(entry.scope, translated.baseRevision),
      revision,
    };
    revisions.set(
      scopeKey(entry.scope),
      Math.max(revisions.get(scopeKey(entry.scope)) ?? 0, event.revision),
    );
    const shown =
      questions.get(scopeKey(entry.scope)) ??
      new Map<string, PendingQuestion>();
    for (const change of event.changes)
      if (
        (change.type === 'pending_question.upserted' ||
          change.type === 'pending_question.removed') &&
        event.revision > (questionsReadAt.get(scopeKey(entry.scope)) ?? 0)
      ) {
        applyQuestionChange(shown, change);
        for (const during of questionReads.get(scopeKey(entry.scope)) ?? [])
          during.push({ revision: event.revision, change });
      }
    questions.set(scopeKey(entry.scope), shown);
    if (event.changes.length > 0 || event.revision > event.baseRevision)
      emit(event);
    live.refresh();
  }

  function scheduleReopen(entry: ScopeStream, epoch: number): void {
    if (entry.closed || entry.epoch !== epoch || entry.reopenTimer !== null)
      return;
    entry.reopenTimer = setTimeout(() => {
      entry.reopenTimer = null;
      if (!entry.closed && entry.epoch === epoch) void open(entry);
    }, reopenDelayMs);
  }

  async function applyFrame(
    entry: ScopeStream,
    frame: unknown,
  ): Promise<boolean> {
    if (!isRecord(frame) || frame.kind !== 'item') return false;
    await apply(entry, frame.item);
    if (frame.cursor !== undefined) {
      entry.cursor = frame.cursor;
      cursors.set(scopeKey(entry.scope), frame.cursor);
    }
    return true;
  }

  async function pump(
    entry: ScopeStream,
    opened: CoreCoworkStream,
    epoch: number,
  ): Promise<void> {
    let after: 'reopen' | 'resync' | 'stop' = 'reopen';
    try {
      for (;;) {
        const next = await opened.next();
        if (entry.closed || entry.epoch !== epoch || next.done) break;
        if (await applyFrame(entry, next.value)) continue;
        const frame = next.value;
        if (isRecord(frame) && isSnapshotRequired(frame.error))
          after = 'resync';
        else if (isTerminalEnd(frame)) after = 'stop';
        break;
      }
    } finally {
      void opened.close();
      if (entry.stream === opened) entry.stream = null;
      if (after === 'resync') void resync(entry, epoch);
      else if (after === 'reopen') scheduleReopen(entry, epoch);
    }
  }

  /**
   * The cursor outlived the events the web core keeps: read a fresh snapshot
   * for its cursor, then tell the store with a marker at that snapshot's
   * revision that follows no revision. The store treats it as a gap and
   * re-reads its snapshot, which covers the marker, so it never applies.
   */
  async function resync(entry: ScopeStream, epoch: number): Promise<void> {
    const key = scopeKey(entry.scope);
    entry.cursor = null;
    cursors.delete(key);
    try {
      const snapshot = await getState(entry.scope);
      if (entry.closed || entry.epoch !== epoch) return;
      entry.cursor = cursors.get(key) ?? null;
      emit({
        schemaVersion: 1,
        eventId: `web-core-resync:${key}:${snapshot.revision}:${newId()}`,
        occurredAt: new Date().toISOString(),
        projectId: entry.scope.projectId,
        worktreeId: entry.scope.worktreeId,
        baseRevision: -1,
        revision: snapshot.revision,
        changes: [],
      });
    } catch (error) {
      reportClientAppError(error);
    }
    scheduleReopen(entry, epoch);
  }

  async function open(entry: ScopeStream): Promise<void> {
    // A task still being created has no events yet: follow it once it exists.
    if (isTaskBeingCreated(entry.scope)) {
      void taskCreated(entry.scope).then(() => {
        if (!entry.closed && streams.get(scopeKey(entry.scope)) === entry)
          void open(entry);
      });
      return;
    }
    entry.epoch += 1;
    const epoch = entry.epoch;
    const previous = entry.stream;
    entry.stream = null;
    if (previous !== null) void previous.close();
    try {
      const opened = await invoker().openStream('core.chat.events', {
        scope: {
          projectId: bareId(entry.scope.projectId),
          worktreeId: bareId(entry.scope.worktreeId),
        },
        cursor: entry.cursor ?? null,
      });
      if (entry.closed || entry.epoch !== epoch) {
        void opened.close();
        return;
      }
      entry.stream = opened;
      void pump(entry, opened, epoch).catch((error: unknown) => {
        reportClientAppError(error);
        scheduleReopen(entry, epoch);
      });
    } catch (error) {
      reportClientAppError(error);
      if (
        error instanceof CoreCoworkRequestError &&
        isSnapshotRequired(error.payload)
      )
        void resync(entry, epoch);
      else if (
        !(error instanceof CoreCoworkRequestError) ||
        !TERMINAL_KINDS.has(error.payload.kind)
      )
        scheduleReopen(entry, epoch);
    }
  }

  function closeStream(entry: ScopeStream): void {
    entry.closed = true;
    entry.epoch += 1;
    if (entry.reopenTimer !== null) clearTimeout(entry.reopenTimer);
    entry.reopenTimer = null;
    const open = entry.stream;
    entry.stream = null;
    if (open !== null) void open.close();
  }

  function setStateScopes(
    declaration: ChatStateScopesDeclaration,
  ): Promise<void> {
    // The web core has no store-wide stream: only named scopes are followed.
    const wanted =
      declaration.kind === 'scopes'
        ? declaration.scopes.filter(
            (scope) =>
              isWebCoreScope(scope.projectId) &&
              isWebCoreScope(scope.worktreeId),
          )
        : [];
    const keys = new Set(wanted.map(scopeKey));
    for (const [key, entry] of streams) {
      if (keys.has(key)) continue;
      closeStream(entry);
      streams.delete(key);
    }
    for (const scope of wanted) {
      const key = scopeKey(scope);
      if (streams.has(key)) continue;
      const entry: ScopeStream = {
        scope: { projectId: scope.projectId, worktreeId: scope.worktreeId },
        epoch: 0,
        stream: null,
        cursor: cursors.get(key) ?? null,
        reopenTimer: null,
        closed: false,
      };
      streams.set(key, entry);
      void open(entry);
    }
    return Promise.resolve();
  }

  async function getTranscriptPage(
    req: ChatTranscriptPageRequest,
  ): Promise<TranscriptPage> {
    if (
      req.target?.kind === 'delegation' ||
      req.archivedContainerId !== undefined ||
      req.standaloneHistory === true ||
      req.turnId !== undefined
    )
      throw webCoreUnavailable('This transcript view');
    const key = scopeKey(req);
    readChats.set(key, (readChats.get(key) ?? new Set()).add(req.chatId));
    // A task still being created has no messages yet (CAN-6098).
    if (isTaskBeingCreated(req))
      return translateTranscriptPage(
        { messages: [], totalMessages: 0, transcriptRevision: 0 },
        ids,
      );
    // The web core serves the plain transcript only: no turn view.
    return readPage(req, ids.chatToCore(req.chatId), {
      ...(req.before === undefined ? {} : { before: req.before }),
      ...(req.transcriptRevision === undefined
        ? {}
        : { transcriptRevision: req.transcriptRevision }),
    });
  }

  function setSettingsChoice(
    req: Scope & { readonly chatId: string },
    choice: TabSettingsChoice,
  ): void {
    const key = scopeKey(req);
    const choices = tabChoices.get(key) ?? {};
    const next = new Map(choices.settings);
    next.set(req.chatId, choice);
    tabChoices.set(key, { ...choices, settings: next });
  }

  // Refused before any effect: the web core rejects a send that carries it.
  function toggleThinkingLevel(req: ThinkingLevelToggleRequest): Promise<void> {
    if (!isServedThinkingLevel(req.level))
      return Promise.reject(webCoreUnavailable('This thinking level'));
    setSettingsChoice(req, { thinkingLevel: req.level });
    return Promise.resolve();
  }

  // The web core runs Regular and Fast: Ultra fast is refused before any
  // effect (CAN-6322).
  function toggleCodexFastMode(req: CodexFastModeToggleRequest): Promise<void> {
    if (req.speed === 'ultrafast')
      return Promise.reject(webCoreUnavailable('Ultra fast'));
    setWebCoreFastMode(
      req.chatId,
      req.speed === undefined ? req.enabled : req.speed === 'fast',
    );
    return Promise.resolve();
  }

  function setReadChoice(
    key: string,
    tabId: string,
    read: TabReadChoice | null,
  ): void {
    const choices = tabChoices.get(key) ?? {};
    const next = new Map(choices.read);
    if (read === null) next.delete(tabId);
    else next.set(tabId, read);
    tabChoices.set(key, { ...choices, read: next });
  }

  /**
   * The web core holds no active tab, tab order or read state: the window
   * keeps them, and a read state the web core reports later replaces the
   * window's.
   */
  function rememberTabChoice(req: ChatCommandRequest): void {
    const key = scopeKey(req);
    const choices = tabChoices.get(key) ?? {};
    switch (req.command.type) {
      case 'chat.activate_tab':
        tabChoices.set(key, { ...choices, activeTabId: req.command.tabId });
        return;
      case 'chat.reorder_tabs':
        tabChoices.set(key, { ...choices, order: [...req.command.tabIds] });
        return;
      case 'chat.mark_read':
        setReadChoice(key, req.command.chatId, {
          unread: false,
          unreadMarkedManually: false,
        });
        return;
      case 'chat.mark_unread':
        setReadChoice(key, req.command.chatId, {
          unread: true,
          unreadMarkedManually: req.command.manual === true,
        });
        return;
      case 'chat.dismiss_attention': {
        const read = choices.read?.get(req.command.chatId);
        setReadChoice(key, req.command.chatId, {
          unread: read?.unread ?? false,
          unreadMarkedManually: read?.unreadMarkedManually ?? false,
          attentionDismissedAt: Date.now(),
        });
        return;
      }
      default:
        return;
    }
  }

  /** A command that changes the web core, which throws unless it applied. */
  async function applyCommand(
    scope: Scope,
    change: ChatCommandRequest['command'],
  ): Promise<void> {
    const result = await command({
      schemaVersion: 1,
      commandId: newId(),
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
      command: change,
    });
    if (result.outcome !== 'applied' && result.outcome !== 'already_applied')
      throw new Error(
        result.reason ?? `The web core did not apply ${change.type}.`,
      );
  }

  async function command(req: ChatCommandRequest): Promise<ChatCommandResult> {
    const plan = planCommand(req, ids);
    if (plan.kind === 'unavailable') throw webCoreUnavailable(plan.what);
    if (plan.kind === 'local') {
      rememberTabChoice(req);
      return {
        commandId: req.commandId,
        revision: revisions.get(scopeKey(req)) ?? 0,
        outcome: 'applied',
      };
    }
    // A refused answer throws, so the question stays open to answer again;
    // one that settled leaves with its `pending_question.removed` event.
    if (plan.kind === 'question') {
      await request(plan.request.method, plan.request.params);
      return {
        commandId: req.commandId,
        revision: revisions.get(scopeKey(req)) ?? 0,
        outcome: 'applied',
      };
    }
    // A model pick shows over every model-bearing change while it is in
    // flight, and is the newest known model once accepted: from its
    // receipt's revision, or, when the receipt names none (the web core
    // answers revision 0 today), from just after every revision seen
    // before the reply, since the change advanced the task's revision.
    const pick =
      req.command.type === 'chat.set_model'
        ? {
            state: tabModelState(req, req.command.tabId),
            choice: {
              model: req.command.model,
              providerType: req.command.providerType,
            },
          }
        : null;
    if (pick !== null) pick.state.pending = pick.choice;
    try {
      const { result, coreRevision } = await runPlan(req, plan.requests);
      const { reported } = pick?.state ?? {};
      const at =
        coreRevision > 0
          ? coreRevision
          : (coreHeads.get(scopeKey(req)) ?? 0) + 0.5;
      if (
        pick !== null &&
        (result.outcome === 'applied' ||
          result.outcome === 'already_applied') &&
        (reported === undefined || reported.revision <= at)
      )
        pick.state.reported = { choice: pick.choice, revision: at };
      return result;
    } finally {
      if (pick !== null && pick.state.pending === pick.choice)
        pick.state.pending = undefined;
    }
  }

  /** The command's result, and the newest web core revision it named. */
  async function runPlan(
    req: ChatCommandRequest,
    requests: readonly CommandRequest[],
  ): Promise<{ result: ChatCommandResult; coreRevision: number }> {
    let result: ChatCommandResult | null = null;
    let revision = 0;
    let coreRevision = 0;
    for (const { method, params } of requests) {
      const next = translateCommandResult(await request(method, params), ids);
      // A later request of the same command runs only once the one before applied.
      if (next.outcome !== 'applied' && next.outcome !== 'already_applied')
        return {
          result: {
            ...next,
            commandId: req.commandId,
            revision: toStoreRevision(req, next.revision),
          },
          coreRevision: next.revision,
        };
      revision = Math.max(revision, toStoreRevision(req, next.revision));
      coreRevision = Math.max(coreRevision, next.revision);
      result = { ...next, commandId: req.commandId, revision };
    }
    if (result === null) throw webCoreUnavailable(req.command.type);
    // The local core activates a tab it creates; the window keeps that
    // choice here, since the web core holds no active tab.
    if (req.command.type === 'chat.create_tab') {
      const key = scopeKey(req);
      tabChoices.set(key, {
        ...tabChoices.get(key),
        activeTabId: req.command.tabId,
      });
    }
    return { result, coreRevision };
  }

  async function archivesOf(scope: Scope): Promise<ArchivedChatSummary[]> {
    return (await readState(scope)).archives;
  }

  /** A refused archive throws, so the store keeps the tab open. */
  async function archiveTab(
    req: ChatArchiveTabRequest,
  ): Promise<ArchivedChatSummary[]> {
    await applyCommand(req, { type: 'chat.archive_tab', tabId: req.tabId });
    return archivesOf(req);
  }

  async function restoreArchive(
    req: ChatRestoreArchiveRequest,
  ): Promise<ChatRestoreArchiveResponse> {
    await applyCommand(req, {
      type: 'chat.restore_archive',
      archiveEntryId: req.chatId,
    });
    const restored = (await readState(req)).tabsFile.tabs.find(
      (tab) => tab.id === req.chatId,
    );
    if (restored === undefined)
      throw new Error('The restored chat is not in its task.');
    return { tab: restored };
  }

  async function sendOnce(
    target: {
      readonly scope: {
        readonly workspaceId: string;
        readonly worktreeId: string;
      };
      readonly chatId: string;
      readonly commandId: string;
    },
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const reply = await invoker().request('core.chat.message.send', params);
    if (reply.ok) return reply.value;
    const { retry } = reply.error;
    if (retry.kind !== 'same_idempotency_key' && retry.kind !== 'same_request')
      throw sendFailure(reply.error);
    // The send may have landed: its receipt settles it. Otherwise the send
    // fails and is never resent under the same key: the web core releases a
    // failed key's claim, so a resend could run the turn twice (CAN-6273).
    const receipt = CoreChatSendReceiptResultSchema.safeParse(
      await request('core.chat.send.receipt', {
        scope: { ...target.scope, chatId: target.chatId },
        commandId: target.commandId,
      }),
    );
    if (!receipt.success)
      throw new Error('The web core returned an invalid send receipt.');
    if (receipt.data.outcome === 'matched') return receipt.data.receipt;
    if (receipt.data.outcome === 'conflict')
      throw new Error('This send conflicts with an earlier one.');
    throw new CoreCoworkRequestError(reply.error);
  }

  async function uploadAttachment(
    target: ChatTarget,
    file: WebCoreAttachmentFile,
  ): ReturnType<WebCoreChatBackendCore['uploadAttachment']> {
    if (options.uploadAttachment === undefined)
      return { ok: false, reason: 'disabled' };
    // A file picked while this window's new task is created uploads once the
    // web core holds its chat; one whose create failed is refused (CAN-6098).
    const created = await taskCreationSettled(target).then(
      () => true,
      () => false,
    );
    if (!created) return { ok: false, reason: 'rejected' };
    const result = await options.uploadAttachment(
      {
        key: qualifiedId(ids.chatToCore(target.chatId)),
        ...bareScope(target),
      },
      { name: file.name, mimeType: file.mediaType, bytes: file.bytes },
    );
    if (!result.ok) return { ok: false, reason: result.reason };
    const filename = result.attachment.filename;
    const absolutePath = cloudAttachmentPath(result.attachmentId, filename);
    rememberCloudAttachmentPreview(absolutePath, {
      filename,
      mediaType: file.mediaType,
      bytes: file.bytes,
    });
    return {
      ok: true,
      attachment: {
        filename,
        absolutePath,
        sizeBytes: file.bytes.byteLength,
      },
    };
  }

  /**
   * The attachments a send carries: each pending attachment the web core
   * holds by id. A local file, or more than a message takes, is refused
   * before any request.
   */
  function sendAttachments(
    req: ChatSendMessageRequest,
  ): { attachmentId: string }[] | undefined {
    const paths = req.attachmentPaths ?? [];
    if (paths.length === 0) return undefined;
    if ((req.attachmentPromptContexts?.length ?? 0) > 0)
      throw webCoreUnavailable('This kind of attachment');
    const ids = paths.map(cloudAttachmentIdOfPath);
    if (ids.some((id) => id === null))
      throw webCoreUnavailable('Attaching a file from this computer');
    if (ids.length > CLOUD_ATTACHMENTS_MAX_PER_MESSAGE)
      throw new Error(CLOUD_ATTACHMENT_LIMIT_MESSAGE);
    return ids.flatMap((attachmentId) =>
      attachmentId === null ? [] : [{ attachmentId }],
    );
  }

  async function sendMessage(
    req: ChatSendMessageRequest,
  ): Promise<ChatSendMessageResult> {
    if ((req.fileReferences?.length ?? 0) > 0)
      throw webCoreUnavailable('File mentions');
    const attachments = sendAttachments(req);
    if (attachments !== undefined) {
      sentAttachments.set(req.userMessageId, [...(req.attachmentPaths ?? [])]);
      for (const oldest of sentAttachments.keys()) {
        if (sentAttachments.size <= MESSAGE_ID_LIMIT) break;
        sentAttachments.delete(oldest);
      }
    }
    // The web core's send carries no planning restriction: a plan request
    // must not start a turn that executes.
    if (req.planMode === true) throw webCoreUnavailable('Plan mode');
    const chatId = ids.chatToCore(req.chatId);
    // A selection the user just saved applies to this turn.
    await selectionSaveSettled(req.chatId);
    const modelConfig = sendModelConfig(
      req.modelConfig?.thinkingLevel ?? req.thinkingLevel,
      options.modelOption?.(req.projectId, req.model),
      useWebCoreFastModeStore.getState().byChat[req.chatId],
    );
    const commandId = newId();
    const scope = bareScope(req);
    const turns = turnsFor(req);
    const reportsAtSend = turns.reports.get(chatId) ?? 0;
    let settle = (): void => undefined;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const inFlight = sending.get(chatId) ?? new Set<Promise<void>>();
    sending.set(chatId, inFlight.add(settled));
    let receipt: ReturnType<typeof CoreChatCommandReceiptSchema.parse>;
    try {
      const parsed = CoreChatCommandReceiptSchema.safeParse(
        await sendOnce(
          { scope, chatId, commandId },
          {
            scope,
            commandId,
            chatId,
            messageId: req.userMessageId,
            text: req.text,
            ...(attachments === undefined ? {} : { attachments }),
            // No model: the chat's model reaches the web core through
            // chat.set_model. The thinking level the composer shows rides
            // the send, within the levels the model's catalog lists.
            ...(modelConfig === undefined ? {} : { modelConfig }),
            _meta: { idempotencyKey: commandId },
          },
        ),
      );
      if (!parsed.success)
        throw new Error('The web core returned an invalid send receipt.');
      receipt = parsed.data;
      if (receipt.messageId !== undefined)
        remember(receipt.messageId, req.userMessageId);
    } finally {
      inFlight.delete(settled);
      if (inFlight.size === 0) sending.delete(chatId);
      settle();
    }
    const { outcome, reason, entityId } = receipt;
    if (outcome !== 'applied' && outcome !== 'already_applied')
      throw new Error(reason ?? 'The web core did not accept the message.');
    // Stop works before the web core reports the turn it just accepted, unless
    // a runtime report arrived while the send was in flight.
    if (
      entityId !== undefined &&
      !turns.active.has(chatId) &&
      (turns.reports.get(chatId) ?? 0) === reportsAtSend
    ) {
      turns.pending.set(chatId, entityId);
      live.refresh();
    }
    return {};
  }

  /**
   * The running turn of a chat the task listed as running: the list names
   * no turn, so the chat's own snapshot does.
   */
  async function readActiveTurn(
    scope: Scope,
    chatId: string,
  ): Promise<string | null> {
    const turns = turnsFor(scope);
    const reportsAtRead = turns.reports.get(chatId) ?? 0;
    const parsed = CoreChatSnapshotGetResultSchema.safeParse(
      await request('core.chat.snapshot.get', {
        scope: bareScope(scope),
        chatId,
      }),
    );
    if (!parsed.success)
      throw new Error('The web core returned an invalid chat snapshot.');
    // An event that reported this chat's runtime meanwhile is newer.
    if ((turns.reports.get(chatId) ?? 0) !== reportsAtRead)
      return turns.active.get(chatId) ?? null;
    const turnId = parsed.data.runtimeByChatId[chatId]?.activeTurnId ?? null;
    if (turnId !== null) turns.active.set(chatId, turnId);
    return turnId;
  }

  async function cancel(req: ChatCancelRequest): Promise<ChatCancelResult> {
    const chatId = ids.chatToCore(req.chatId);
    const turns = turnsFor(req);
    if (!turnRuns(req, chatId)) return { outcome: 'turn_not_active' };
    const turnId =
      turns.active.get(chatId) ??
      turns.pending.get(chatId) ??
      (await readActiveTurn(req, chatId));
    if (turnId === null) return { outcome: 'turn_not_active' };
    await request('core.chat.turn.cancel', {
      chatId,
      turnId,
      reason: 'user',
    });
    return { outcome: 'stop_requested' };
  }

  function closeAll(): void {
    live.closeAll();
    for (const entry of streams.values()) closeStream(entry);
    streams.clear();
    cursors.clear();
    turnsByScope.clear();
    sending.clear();
    // The store drops cloud tabs with the connection; the next snapshot
    // reports their models afresh.
    tabModels.clear();
    coreHeads.clear();
  }

  return {
    getState,
    setStateScopes,
    onStateChanged: (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    getTranscriptPage,
    command,
    archiveTab,
    restoreArchive,
    loadArchives: archivesOf,
    sendMessage,
    cancel,
    toggleThinkingLevel,
    toggleCodexFastMode,
    webCoreTabModel: (req) =>
      tabModels.get(scopeKey(req))?.get(req.chatId)?.reported?.choice,
    pickWebCoreTabModel: (req, choice) => {
      const state = tabModelState(req, req.chatId);
      if (choice === null) delete state.picked;
      else state.picked = choice;
    },
    webCoreChatId: (chatId) =>
      coreChatIds.get(chatId) ?? webCoreLocalId(chatId),
    setLiveChats: live.setFocused,
    closeAll,
    uploadAttachment,
  };
}
