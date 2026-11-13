import {
  CANOPY_STREAM_DEFINITIONS,
  CoreChatLifecycleResultSchema,
  CoreChatListResultSchema,
  CoreChatSnapshotGetResultSchema,
  CoreChatTranscriptPageResultSchema,
} from '@canopy/protocol/canopy-core';
import type {
  AgentProviderType,
  ArchivedChatSummary,
  ChatCommand,
  ChatCommandEnvelope,
  ChatCommandResult,
  ChatRuntimeState,
  ChatRuntimeStatus,
  ChatStateChange,
  ChatStateChangedEvent,
  ChatStateSnapshot,
  ChatTabMetadataPatch,
  McpQuestion,
  McpQuestionAnswer,
  PersistedChatMessage,
  PersistedChatTab,
  PersistedPendingQuestion,
} from '@canopy/desktop-shared/types';
import type {
  TranscriptDescriptor,
  TranscriptPage,
} from '@canopy/agent-transcript/transcript-storage';
import {
  clampModelThinkingLevel,
  type ThinkingLevel,
} from '@canopy/protocol/thinking';
import type { ModelCatalogOption } from '@canopy/protocol/models';
import { webCoreLocalId, webCoreScopeId } from '@/lib/chat-authority';

/**
 * Translation between the web core's `core.chat.*` protocol and the desktop
 * chat store's own shapes (CAN-6175 D3). The protocol was projected from those
 * shapes, so most of it passes through; what changes is identity: every
 * workspace, worktree, chat and archive entry id the store sees carries the
 * `web-core:` authority (D1), and every id sent to the web core is bare.
 *
 * Fields the web core does not project are left absent, never invented, and
 * nothing here is ever sent back to it.
 */

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export class WebCoreTranslationError extends Error {
  constructor(what: string) {
    super(`The web core returned an invalid ${what}.`);
    this.name = 'WebCoreTranslationError';
  }
}

/** The bare web core id behind a qualified store id. */
export function bareId(qualified: string): string {
  const id = webCoreLocalId(qualified);
  if (id === null) throw new WebCoreTranslationError('chat identity');
  return id;
}

export const qualifiedId = webCoreScopeId;

/** A store scope's ids as the web core names them. */
export function bareScope(scope: {
  readonly projectId: string;
  readonly worktreeId: string;
}): { readonly workspaceId: string; readonly worktreeId: string } {
  return {
    workspaceId: bareId(scope.projectId),
    worktreeId: bareId(scope.worktreeId),
  };
}

const ROLES: ReadonlySet<unknown> = new Set(['user', 'assistant', 'system']);

/** The persisted message shape both cores serve; anything else is dropped. */
export function isPersistedChatMessage(
  value: unknown,
): value is PersistedChatMessage {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    ROLES.has(value.role) &&
    typeof value.timestamp === 'number' &&
    Array.isArray(value.blocks) &&
    value.blocks.every(
      (block) => isRecord(block) && typeof block.type === 'string',
    )
  );
}

/**
 * How a chat or message id reads on each side. A chat the web core holds
 * reads as `web-core:<id>` in the store, except one the store created: it
 * keeps the id the store minted, and the web core keeps the UUID minted for
 * it. The web core also mints its own id for a sent message, so the store
 * keeps the id it sent under (its optimistic row retires only on that exact
 * id).
 */
export interface WebCoreIds {
  readonly chatToStore: (id: string) => string;
  /** Refuses a store id the web core cannot know. */
  readonly chatToCore: (id: string) => string;
  /** A tab the store is creating: its web core id, minted when it has none. */
  readonly newChatToCore: (id: string) => string;
  readonly messageToStore: (id: string) => string;
  readonly messageToCore: (id: string) => string;
}

function messages(
  values: readonly unknown[],
  ids: WebCoreIds,
): PersistedChatMessage[] {
  return values.filter(isPersistedChatMessage).map((message) => {
    const id = ids.messageToStore(message.id);
    return id === message.id ? message : { ...message, id };
  });
}

const RUNTIME_STATUSES: ReadonlySet<string> = new Set<ChatRuntimeStatus>([
  'idle',
  'queued',
  'starting',
  'streaming',
  'awaiting_input',
  'completing',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

function isRuntimeStatus(value: unknown): value is ChatRuntimeStatus {
  return typeof value === 'string' && RUNTIME_STATUSES.has(value);
}

const PROVIDERS: ReadonlySet<string> = new Set<AgentProviderType>([
  'claude',
  'codex',
  'ollama',
  'cursor',
  'opencode',
  'copilot',
]);

function isProvider(value: unknown): value is AgentProviderType {
  return typeof value === 'string' && PROVIDERS.has(value);
}

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/** The tab fields a web core tab or tab summary carries, by store name. */
function tabFields(source: JsonRecord): Partial<PersistedChatTab> {
  const settings = isRecord(source.settings) ? source.settings : {};
  const model =
    optionalString(source.modelId) ?? optionalString(settings.model);
  const provider = source.providerId ?? settings.providerId;
  const customTitle = optionalString(settings.customTitle);
  return {
    ...(source.kind === 'chat' || source.kind === 'file'
      ? { kind: source.kind }
      : {}),
    ...(model === undefined ? {} : { model }),
    ...(isProvider(provider) ? { providerType: provider } : {}),
    ...(customTitle === undefined ? {} : { customTitle }),
    ...(typeof source.unread === 'boolean' ? { unread: source.unread } : {}),
  };
}

/**
 * A tab whose transcript the store has not read: it pages it in through
 * `getTranscriptPage` once the tab shows.
 */
function unloadedTab(input: {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly fields: Partial<PersistedChatTab>;
  readonly messages?: PersistedChatMessage[];
}): PersistedChatTab {
  const loaded = input.messages !== undefined && input.messages.length > 0;
  return {
    ...input.fields,
    id: input.id,
    title: input.title,
    createdAt: input.createdAt,
    messages: loaded ? (input.messages ?? []) : [],
    ...(loaded ? {} : { transcriptLoaded: false }),
  };
}

/**
 * The runtime as the store shows it. The web core also parks an idle session
 * as awaiting input: only a reported turn makes it one that runs.
 */
function runtime(value: unknown): ChatRuntimeState | null {
  if (!isRecord(value) || !isRuntimeStatus(value.status)) return null;
  const parked =
    value.status === 'awaiting_input' && typeof value.activeTurnId !== 'string';
  const queued = Array.isArray(value.queuedMessageIds)
    ? value.queuedMessageIds.filter(
        (id): id is string => typeof id === 'string',
      )
    : [];
  return {
    status: parked ? 'idle' : value.status,
    queuedMessageIds: queued,
    ...(typeof value.lastActivityAt === 'number'
      ? { lastActivityAt: value.lastActivityAt }
      : {}),
  };
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((each) => typeof each === 'string');

const isQuestionControl = (
  value: unknown,
): value is NonNullable<McpQuestion['control']> =>
  value === 'buttons' ||
  value === 'select' ||
  value === 'text' ||
  value === 'textarea' ||
  value === 'number' ||
  value === 'date';

/** One question as the desktop's question card takes it, or null. */
function mcpQuestion(value: unknown): McpQuestion | null {
  if (
    !isRecord(value) ||
    typeof value.question !== 'string' ||
    !isStringArray(value.options)
  )
    return null;
  return {
    question: value.question,
    options: value.options,
    ...(typeof value.id === 'string' ? { id: value.id } : {}),
    ...(typeof value.header === 'string' ? { header: value.header } : {}),
    ...(isStringArray(value.optionDescriptions)
      ? { optionDescriptions: value.optionDescriptions }
      : {}),
    ...(typeof value.multiSelect === 'boolean'
      ? { multiSelect: value.multiSelect }
      : {}),
    ...(typeof value.allowOther === 'boolean'
      ? { allowOther: value.allowOther }
      : {}),
    ...(typeof value.secret === 'boolean' ? { secret: value.secret } : {}),
    ...(typeof value.keepTextOnPick === 'boolean'
      ? { keepTextOnPick: value.keepTextOnPick }
      : {}),
    ...(isQuestionControl(value.control) ? { control: value.control } : {}),
    ...(typeof value.required === 'boolean'
      ? { required: value.required }
      : {}),
    ...(typeof value.placeholder === 'string'
      ? { placeholder: value.placeholder }
      : {}),
  };
}

/**
 * A question the web core raised, as the store keeps an unanswered one: the
 * composer's question card shows it, and its tool call's block matches it by
 * `toolUseId`. Null when any question is not one the card can show.
 */
function pendingQuestion(
  value: {
    readonly requestId: string;
    readonly chatId: string;
    readonly questions: readonly unknown[];
    readonly toolUseId?: unknown;
  },
  ids: WebCoreIds,
): PersistedPendingQuestion | null {
  const questions = value.questions.map(mcpQuestion);
  if (questions.length === 0 || questions.some((question) => question === null))
    return null;
  return {
    requestId: value.requestId,
    chatId: ids.chatToStore(value.chatId),
    questions: questions.filter(
      (question): question is McpQuestion => question !== null,
    ),
    ...(typeof value.toolUseId === 'string'
      ? { toolUseId: value.toolUseId }
      : {}),
  };
}

function archive(
  value: JsonRecord,
  ids: WebCoreIds,
): ArchivedChatSummary | null {
  if (
    typeof value.chatId !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.archivedAt !== 'string' ||
    typeof value.createdAt !== 'string' ||
    typeof value.turnCount !== 'number' ||
    typeof value.restorable !== 'boolean' ||
    typeof value.unread !== 'boolean'
  )
    return null;
  return {
    chatId: ids.chatToStore(value.chatId),
    title: value.title,
    archivedAt: value.archivedAt,
    createdAt: value.createdAt,
    turnCount: value.turnCount,
    restorable: value.restorable,
    unread: value.unread,
  };
}

/** The running turn the web core reports for each chat, by web core chat id. */
export type ActiveTurns = ReadonlyMap<string, string>;

export interface TranslatedSnapshot {
  readonly snapshot: ChatStateSnapshot;
  readonly activeTurns: ActiveTurns;
  /** Each chat's runtime status, by web core chat id. */
  readonly statuses: ReadonlyMap<string, string>;
  /** Where `core.chat.events` resumes right after this snapshot. */
  readonly eventsCursor: unknown;
  /**
   * Chats, by store id, whose questions the web core could not read: the
   * snapshot leaves them out, and the questions shown for them stand.
   */
  readonly unreadQuestionChatIds: ReadonlySet<string>;
}

type ListItem = ReturnType<
  typeof CoreChatListResultSchema.parse
>['items'][number];

export function parseChatList(value: unknown): {
  readonly items: readonly ListItem[];
  readonly nextCursor: string | null;
} {
  const parsed = CoreChatListResultSchema.safeParse(value);
  if (!parsed.success) throw new WebCoreTranslationError('chat list');
  return parsed.data;
}

/** A listed chat's state as the runtime the store shows. */
const LISTED_STATUSES: Readonly<Record<ListItem['state'], ChatRuntimeStatus>> =
  {
    idle: 'idle',
    queued: 'queued',
    running: 'streaming',
    // A question without a reported turn: the session is parked.
    awaiting_user: 'idle',
    completed: 'completed',
    failed: 'failed',
    archived: 'idle',
  };

/**
 * `chat.getState` for a task: `core.chat.snapshot.get` names the revision,
 * the events cursor and the opened chat's runtime; `core.chat.list` names
 * every chat of the task, which the snapshot does not.
 */
export function translateSnapshot(
  value: unknown,
  listed: readonly ListItem[],
  scope: { readonly projectId: string; readonly worktreeId: string },
  ids: WebCoreIds,
): TranslatedSnapshot {
  const parsed = CoreChatSnapshotGetResultSchema.safeParse(value);
  if (!parsed.success) throw new WebCoreTranslationError('chat snapshot');
  const data = parsed.data;
  const runtimeByChatId: Record<string, ChatRuntimeState> = {};
  const statuses = new Map<string, string>();
  const activeTurns = new Map<string, string>();
  for (const item of listed) {
    if (item.state === 'archived') continue;
    const status = LISTED_STATUSES[item.state];
    runtimeByChatId[ids.chatToStore(item.chatId)] = {
      status,
      queuedMessageIds: [],
    };
    statuses.set(item.chatId, status);
  }
  // The opened chat's own runtime is exact: it wins over its list state.
  for (const [chatId, summary] of Object.entries(data.runtimeByChatId)) {
    const state = runtime(summary);
    if (state === null) continue;
    runtimeByChatId[ids.chatToStore(chatId)] = state;
    statuses.set(chatId, summary.status);
    if (summary.activeTurnId !== undefined)
      activeTurns.set(chatId, summary.activeTurnId);
  }
  const opened = new Map(data.tabs.items.map((item) => [item.chatId, item]));
  const live = listed.filter((item) => item.state !== 'archived');
  const tabs = [
    ...live.map((item) => opened.get(item.chatId) ?? item),
    ...data.tabs.items.filter(
      (item) => !live.some((each) => each.chatId === item.chatId),
    ),
  ].map((item) =>
    unloadedTab({
      id: ids.chatToStore(item.chatId),
      title: item.title,
      createdAt: item.createdAt,
      fields: tabFields(item),
    }),
  );
  const archives = [
    ...data.archives.flatMap((entry) => archive(entry, ids) ?? []),
    ...listed
      .filter((item) => item.state === 'archived')
      .map(
        (item): ArchivedChatSummary => ({
          chatId: ids.chatToStore(item.chatId),
          title: item.title,
          // The list names no archive time or turn count: shown only.
          archivedAt: item.updatedAt ?? item.createdAt,
          createdAt: item.createdAt,
          turnCount: 0,
          // The web core restores only the task's own chat; a tab comes
          // back with its task.
          restorable: item.chatId === webCoreLocalId(scope.worktreeId),
          unread: false,
        }),
      ),
  ];
  const activeTabId = data.tabs.activeTabId;
  const pendingQuestions = (data.pendingQuestions ?? []).flatMap(
    (question) => pendingQuestion(question, ids) ?? [],
  );
  return {
    snapshot: {
      schemaVersion: 1,
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
      revision: data.revision,
      tabsFile: {
        version: 1,
        revision: data.revision,
        tabs,
        activeTabId: activeTabId.length > 0 ? ids.chatToStore(activeTabId) : '',
        ...(pendingQuestions.length === 0 ? {} : { pendingQuestions }),
      },
      archives,
      runtimeByChatId,
      // Queued text is not served yet (CAN-6106): the queue shows nothing.
      queue: [],
    },
    activeTurns,
    statuses,
    eventsCursor: data.eventsCursor ?? null,
    unreadQuestionChatIds: new Set(
      (data.unreadQuestionChatIds ?? []).map((chatId) =>
        ids.chatToStore(chatId),
      ),
    ),
  };
}

/** The window's own tab choices, which the web core does not hold (R11). */
export interface TabChoices {
  readonly activeTabId?: string;
  readonly order?: readonly string[];
  /** Each tab's read state and attention as this window last set them. */
  readonly read?: ReadonlyMap<string, TabReadChoice>;
  /** Each tab's thinking level as this window last set it. */
  readonly settings?: ReadonlyMap<string, TabSettingsChoice>;
}

/**
 * A tab's thinking level. The web core does not project it; it rides each
 * send as its `modelConfig` (CAN-6175 R5).
 */
export interface TabSettingsChoice {
  readonly thinkingLevel: ThinkingLevel;
}

/** The tab with the window's thinking level laid over it. */
export function withTabSettings(
  tab: PersistedChatTab,
  choice: TabSettingsChoice | undefined,
): PersistedChatTab {
  if (choice === undefined) return tab;
  const { thinkingLevel } = choice;
  return {
    ...tab,
    thinkingLevel,
    modelConfig: { ...tab.modelConfig, thinkingLevel },
  };
}

/** The thinking levels the web core runs: every level but Ultra. */
export function isServedThinkingLevel(level: ThinkingLevel): boolean {
  return level !== 'ultra';
}

/**
 * A send's `modelConfig`: the thinking level the composer shows for the
 * chat's model, clamped to its catalog levels as the composer clamps it.
 * Absent keeps the chat's own: a model the catalog does not list, or one
 * without levels.
 */
export function sendModelConfig(
  thinkingLevel: ThinkingLevel | undefined,
  option: ModelCatalogOption | undefined,
  fastMode?: boolean,
): { thinkingLevel?: ThinkingLevel; fastMode?: boolean } | undefined {
  const levels = option?.supportedThinkingLevels?.filter(isServedThinkingLevel);
  const level =
    thinkingLevel === undefined || levels === undefined || levels.length === 0
      ? undefined
      : clampModelThinkingLevel(thinkingLevel, levels);
  // Fast mode only for a model that runs it (CAN-6322).
  const fast = option?.supportsFastMode === true ? fastMode : undefined;
  if (level === undefined && fast === undefined) return undefined;
  return {
    ...(level === undefined ? {} : { thinkingLevel: level }),
    ...(fast === undefined ? {} : { fastMode: fast }),
  };
}

/** A tab's read fields as the local core's mark and dismiss commands set them. */
export interface TabReadChoice {
  readonly unread: boolean;
  readonly unreadMarkedManually: boolean;
  readonly attentionDismissedAt?: number;
}

/**
 * A snapshot with the window's active tab and tab order laid over the web
 * core's. A tab the order does not name keeps its place after the named ones.
 */
export function withTabChoices(
  snapshot: ChatStateSnapshot,
  choices: TabChoices | undefined,
): ChatStateSnapshot {
  if (choices === undefined) return snapshot;
  const { tabs } = snapshot.tabsFile;
  const order = choices.order ?? [];
  const rank = (id: string): number => {
    const index = order.indexOf(id);
    return index === -1 ? order.length : index;
  };
  const ordered = tabs
    .map((tab, index) => ({ tab, index }))
    .sort((a, b) => rank(a.tab.id) - rank(b.tab.id) || a.index - b.index)
    .map(({ tab }) => tab);
  const active = choices.activeTabId;
  const withRead = ordered.map((each) => {
    const tab = withTabSettings(each, choices.settings?.get(each.id));
    const read = choices.read?.get(tab.id);
    if (read === undefined) return tab;
    const next: PersistedChatTab = { ...tab, unread: read.unread };
    if (read.unreadMarkedManually) next.unreadMarkedManually = true;
    else delete next.unreadMarkedManually;
    if (read.attentionDismissedAt !== undefined)
      next.attentionDismissedAt = read.attentionDismissedAt;
    return next;
  });
  return {
    ...snapshot,
    tabsFile: {
      ...snapshot.tabsFile,
      tabs: withRead,
      activeTabId:
        active !== undefined && tabs.some((tab) => tab.id === active)
          ? active
          : snapshot.tabsFile.activeTabId,
    },
  };
}

/**
 * A snapshot whose listed chats carry their newest page. The store keeps a
 * body-less tab's rows, so a refresh after missed events sends the bodies of
 * the chats it shows, as the local core sends its active chat's.
 */
export function withTranscriptPages(
  snapshot: ChatStateSnapshot,
  pages: ReadonlyMap<string, TranscriptPage>,
): ChatStateSnapshot {
  if (pages.size === 0) return snapshot;
  return {
    ...snapshot,
    tabsFile: {
      ...snapshot.tabsFile,
      tabs: snapshot.tabsFile.tabs.map((tab) => {
        const page = pages.get(tab.id);
        if (page === undefined) return tab;
        const { messages: rows, ...window } = page;
        return {
          ...tab,
          messages: rows,
          transcriptLoaded: true,
          transcriptWindow: window,
        };
      }),
    },
  };
}

/** A transcript page as `chat.getTranscriptPage` returns it. */
export function translateTranscriptPage(
  value: unknown,
  ids: WebCoreIds,
): TranscriptPage {
  const parsed = CoreChatTranscriptPageResultSchema.safeParse(value);
  if (!parsed.success) throw new WebCoreTranslationError('transcript page');
  const page = parsed.data;
  return {
    messages: messages(page.messages, ids),
    totalMessages: page.totalMessages,
    transcriptRevision: page.transcriptRevision,
    ...(page.before === undefined ? {} : { before: page.before }),
    ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
    ...(page.runTruncated === undefined
      ? {}
      : { runTruncated: page.runTruncated }),
  };
}

/**
 * The descriptor a reread transcript carries. The web core names no counts
 * in `transcript.updated`, so they come from the page read just after it.
 */
export function transcriptDescriptor(
  page: TranscriptPage,
): TranscriptDescriptor {
  return {
    format: 'complete-message-jsonl-v1',
    committedMessageCount: page.totalMessages,
    committedByteLength: 0,
    transcriptRevision: page.transcriptRevision,
    hasActiveSidecar: false,
  };
}

type EventItem = ReturnType<
  (typeof CANOPY_STREAM_DEFINITIONS)['core.chat.events']['item']['parse']
>;
type EventChange = EventItem['changes'][number];

export function parseEventItem(value: unknown): EventItem {
  const parsed =
    CANOPY_STREAM_DEFINITIONS['core.chat.events'].item.safeParse(value);
  if (!parsed.success) throw new WebCoreTranslationError('chat event');
  return parsed.data;
}

function metadataPatch(patch: JsonRecord): ChatTabMetadataPatch {
  return {
    ...(typeof patch.title === 'string' ? { title: patch.title } : {}),
    // A cloud rename names the chat: a custom title an earlier rename left
    // would otherwise keep shadowing it in the tab label.
    ...(typeof patch.title === 'string' && patch.customTitle === undefined
      ? { customTitle: null }
      : {}),
    ...(typeof patch.modelId === 'string' ? { model: patch.modelId } : {}),
    ...(patch.modelId === null ? { model: null } : {}),
    ...(typeof patch.customTitle === 'string'
      ? { customTitle: patch.customTitle }
      : {}),
    ...(typeof patch.unread === 'boolean' ? { unread: patch.unread } : {}),
  };
}

/**
 * One protocol change as the store's change, or null for one the store has
 * no use for yet: agent tasks (CAN-6107) and delegation cards, which other
 * rows bring.
 */
export function translateChange(
  change: EventChange,
  transcripts: ReadonlyMap<string, TranscriptDescriptor>,
  ids: WebCoreIds,
): ChatStateChange | null {
  switch (change.type) {
    case 'tab.upserted':
      return {
        type: 'tab.upserted',
        tab: unloadedTab({
          id: ids.chatToStore(change.tab.id),
          title: change.tab.title,
          createdAt: change.tab.createdAt,
          fields: tabFields(change.tab),
          messages: messages(change.tab.messages, ids),
        }),
      };
    case 'tab.removed':
      return { type: 'tab.removed', tabId: ids.chatToStore(change.tabId) };
    case 'tab.metadata_patched':
      return {
        type: 'tab.metadata_patched',
        tabId: ids.chatToStore(change.tabId),
        patch: metadataPatch(change.patch),
      };
    case 'tab.order_changed':
      return {
        type: 'tab.order_changed',
        tabIds: change.tabIds.map(ids.chatToStore),
      };
    case 'tab.active_changed':
      return {
        type: 'tab.active_changed',
        activeTabId:
          change.activeTabId.length > 0
            ? ids.chatToStore(change.activeTabId)
            : '',
      };
    case 'message.upserted': {
      const [message] = messages([change.message], ids);
      return message === undefined
        ? null
        : {
            type: 'message.upserted',
            chatId: ids.chatToStore(change.chatId),
            message,
          };
    }
    case 'message.removed':
      return {
        type: 'message.removed',
        chatId: ids.chatToStore(change.chatId),
        messageId: ids.messageToStore(change.messageId),
      };
    case 'messages.replaced':
      return {
        type: 'messages.replaced',
        chatId: ids.chatToStore(change.chatId),
        messages: messages(change.messages, ids),
        removedMessageIds: change.removedMessageIds.map(ids.messageToStore),
      };
    case 'transcript.updated': {
      const transcript = transcripts.get(change.chatId);
      return transcript === undefined
        ? null
        : {
            type: 'transcript.updated',
            chatId: ids.chatToStore(change.chatId),
            transcript,
            reset: change.reset,
          };
    }
    case 'runtime.patched': {
      const state = runtime(change.runtime);
      return state === null
        ? null
        : {
            type: 'runtime.patched',
            chatId: ids.chatToStore(change.chatId),
            runtime: state,
          };
    }
    case 'archive.upserted': {
      const entry = archive(change.archive, ids);
      return entry === null
        ? null
        : { type: 'archive.upserted', archive: entry };
    }
    case 'archive.removed':
      return {
        type: 'archive.removed',
        archiveEntryId: ids.chatToStore(change.archiveEntryId),
        chatId: ids.chatToStore(change.chatId),
      };
    case 'archive.read_state_changed':
      return {
        type: 'archive.read_state_changed',
        archiveEntryId: ids.chatToStore(change.archiveEntryId),
        chatId: ids.chatToStore(change.chatId),
        unread: change.unread,
      };
    case 'pending_question.upserted': {
      const question = pendingQuestion(change.question, ids);
      return question === null
        ? null
        : { type: 'pending_question.upserted', question };
    }
    case 'pending_question.removed':
      return {
        type: 'pending_question.removed',
        requestId: change.requestId,
        chatId: ids.chatToStore(change.chatId),
      };
    default:
      return null;
  }
}

/** The chats whose `transcript.updated` needs a page read before it applies. */
export function rereadChatIds(item: EventItem): string[] {
  return item.changes.flatMap((change) =>
    change.type === 'transcript.updated' ? [change.chatId] : [],
  );
}

/** One `core.chat.events` item as the store's committed state change. */
export function translateEvent(
  item: EventItem,
  scope: { readonly projectId: string; readonly worktreeId: string },
  transcripts: ReadonlyMap<string, TranscriptDescriptor>,
  ids: WebCoreIds,
): ChatStateChangedEvent {
  return {
    schemaVersion: 1,
    eventId: item.eventId,
    occurredAt: item.occurredAt,
    projectId: scope.projectId,
    worktreeId: scope.worktreeId,
    baseRevision: item.baseRevision,
    revision: item.revision,
    changes: item.changes.flatMap(
      (change) => translateChange(change, transcripts, ids) ?? [],
    ),
  };
}

/** Runtime statuses of a turn that has not ended. */
const TURN_RUNNING_STATUSES: ReadonlySet<string> = new Set([
  'queued',
  'starting',
  'streaming',
  'completing',
]);

/** Whether a runtime status is a turn that has not ended. */
export function isTurnRunningStatus(status: string | undefined): boolean {
  return status !== undefined && TURN_RUNNING_STATUSES.has(status);
}

/** The running turn each `runtime.patched` in an item reports, by bare chat id. */
export function activeTurnChanges(
  item: EventItem,
): ReadonlyMap<string, string | null> {
  const turns = new Map<string, string | null>();
  for (const change of item.changes) {
    if (change.type !== 'runtime.patched') continue;
    const turnId = change.runtime.activeTurnId;
    if (typeof turnId === 'string') turns.set(change.chatId, turnId);
    // A starting or running turn may not name its id yet: the receipt's
    // turn stays the one Stop cancels. Only a turn that ended clears it.
    else if (!isTurnRunningStatus(change.runtime.status))
      turns.set(change.chatId, null);
  }
  return turns;
}

/** One `core.chat.*` request a store command becomes. */
export interface CommandRequest {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/**
 * How a store command reaches the web core: answered here (window-local
 * state the web core does not hold), refused before any effect, or sent as
 * one or more requests carrying only the fields the web core serves.
 */
export type CommandPlan =
  | { readonly kind: 'local' }
  | { readonly kind: 'unavailable'; readonly what: string }
  | { readonly kind: 'requests'; readonly requests: readonly CommandRequest[] }
  | { readonly kind: 'question'; readonly request: CommandRequest };

/** Window-local in a cloud chat: the active tab, tab order and read state (R11). */
const LOCAL_COMMANDS: ReadonlySet<string> = new Set([
  'chat.activate_tab',
  'chat.reorder_tabs',
  'chat.mark_read',
  'chat.mark_unread',
  'chat.dismiss_attention',
]);

/** The tab settings `core.chat.update` changes, one per request. */
const SERVED_SETTINGS: ReadonlySet<string> = new Set([
  'customTitle',
  'modelSelectionMode',
  'pluginSelections',
]);

type CloseTarget = {
  readonly tabId: string;
  readonly mode: 'archive' | 'discard_empty' | 'discard';
};

/** Archiving a task's own chat archives the whole task and every tab in it. */
const ROOT_ARCHIVE = "Closing the task's own chat";

function closePlan(
  targets: readonly CloseTarget[],
  replacement: { readonly tabId?: string; readonly title?: string },
  ids: WebCoreIds,
  rootChatId: string,
): readonly Record<string, unknown>[] | string {
  // A contentful chat is never deleted here: the web core only archives.
  if (targets.some((target) => target.mode === 'discard'))
    return 'Deleting a chat';
  if (targets.some((target) => ids.chatToCore(target.tabId) === rootChatId))
    return ROOT_ARCHIVE;
  return [
    ...targets.map((target) => ({
      method: 'core.chat.archive',
      action: { type: 'chat.archive_tab', tabId: ids.chatToCore(target.tabId) },
    })),
    ...(replacement.tabId === undefined
      ? []
      : [
          {
            method: 'core.chat.create',
            action: {
              type: 'chat.create_tab',
              tabId: ids.newChatToCore(replacement.tabId),
              ...(replacement.title === undefined
                ? {}
                : { title: replacement.title }),
            },
          },
        ]),
  ];
}

/** The web core actions one store command becomes, or why it cannot. */
function commandActions(
  command: ChatCommand,
  ids: WebCoreIds,
  rootChatId: string,
): readonly Record<string, unknown>[] | string {
  switch (command.type) {
    case 'chat.create_tab':
      if (command.seedTab !== undefined) return 'Seeding a new chat';
      return [
        {
          method: 'core.chat.create',
          action: {
            type: 'chat.create_tab',
            tabId: ids.newChatToCore(command.tabId),
            ...(command.title === undefined ? {} : { title: command.title }),
          },
        },
      ];
    case 'chat.fork_tab':
      // A cloud fork starts a new task, not a tab of this one (CAN-6106).
      return 'Forking a cloud chat';
    case 'chat.archive_tab':
      if (ids.chatToCore(command.tabId) === rootChatId) return ROOT_ARCHIVE;
      return [
        {
          method: 'core.chat.archive',
          action: {
            type: 'chat.archive_tab',
            tabId: ids.chatToCore(command.tabId),
          },
        },
      ];
    case 'chat.restore_archive':
      if (ids.chatToCore(command.archiveEntryId) !== rootChatId)
        return 'Restoring a tab without its task';
      return [
        {
          method: 'core.chat.archive',
          action: {
            type: 'chat.restore_archive',
            archiveEntryId: ids.chatToCore(command.archiveEntryId),
          },
        },
      ];
    case 'chat.close_tab':
      return closePlan(
        [{ tabId: command.tabId, mode: command.mode }],
        {
          tabId: command.replacementTab?.tabId ?? command.replacementTabId,
          title: command.replacementTab?.title,
        },
        ids,
        rootChatId,
      );
    case 'chat.close_tabs':
      return closePlan(
        command.targets,
        {
          tabId: command.replacementTab?.tabId ?? command.replacementTabId,
          title: command.replacementTab?.title,
        },
        ids,
        rootChatId,
      );
    case 'chat.set_model':
      return [
        {
          method: 'core.chat.update',
          action: {
            type: 'chat.set_model',
            tabId: ids.chatToCore(command.tabId),
            model: command.model,
            providerType: command.providerType,
          },
        },
      ];
    case 'chat.patch_tab_settings': {
      const keys = Object.keys(command.patch);
      if (keys.some((key) => !SERVED_SETTINGS.has(key)))
        return 'These chat settings';
      const patch: Record<string, unknown> = { ...command.patch };
      return keys.map((key) => ({
        method: 'core.chat.update',
        action: {
          type: 'chat.patch_tab_settings',
          tabId: ids.chatToCore(command.tabId),
          patch: { [key]: patch[key] },
        },
      }));
    }
    default:
      return command.type;
  }
}

/**
 * Answers keyed by question id, as `core.chat.question.respond` takes them,
 * or null when an answer names no question.
 */
function keyedAnswers(
  answers: readonly McpQuestionAnswer[],
): Record<string, Record<string, unknown>> | null {
  const keyed: Record<string, Record<string, unknown>> = {};
  for (const answer of answers) {
    if (answer.questionId === undefined || answer.questionId in keyed)
      return null;
    keyed[answer.questionId] = {
      selectedOptions: answer.selectedOptions,
      ...(answer.freeformText === undefined
        ? {}
        : { freeformText: answer.freeformText }),
    };
  }
  return keyed;
}

/**
 * An answer or dismissal of a question the web core raised. A question
 * settles once (the operation is idempotent by itself), so it takes no
 * command id; the question's removal arrives as an event.
 */
function questionResponse(
  command: ChatCommand,
  ids: WebCoreIds,
): CommandPlan | null {
  if (
    command.type !== 'chat.answer_question' &&
    command.type !== 'chat.dismiss_question'
  )
    return null;
  const base = {
    chatId: ids.chatToCore(command.chatId),
    questionId: command.questionId,
  };
  if (command.type === 'chat.dismiss_question')
    return {
      kind: 'question',
      request: {
        method: 'core.chat.question.respond',
        params: { ...base, dismissed: true },
      },
    };
  const answers = keyedAnswers(command.answers);
  if (answers === null || Object.keys(answers).length === 0)
    return { kind: 'unavailable', what: 'Answering without question ids' };
  return {
    kind: 'question',
    request: {
      method: 'core.chat.question.respond',
      params: { ...base, answers },
    },
  };
}

/**
 * A store command as the web core serves it. The web core keeps no
 * revision guards on these commands, so none is sent; each extra request
 * of one command takes a suffixed command id, stable across the store's
 * retries.
 */
export function planCommand(
  envelope: ChatCommandEnvelope,
  ids: WebCoreIds,
): CommandPlan {
  if (LOCAL_COMMANDS.has(envelope.command.type)) return { kind: 'local' };
  const question = questionResponse(envelope.command, ids);
  if (question !== null) return question;
  // A task's own chat has the task's id.
  const actions = commandActions(
    envelope.command,
    ids,
    bareId(envelope.worktreeId),
  );
  if (typeof actions === 'string')
    return { kind: 'unavailable', what: actions };
  const scope = {
    projectId: bareId(envelope.projectId),
    worktreeId: bareId(envelope.worktreeId),
  };
  return {
    kind: 'requests',
    requests: actions.map((each, index) => {
      const commandId =
        index === 0 ? envelope.commandId : `${envelope.commandId}:${index}`;
      return {
        method: String(each.method),
        params: {
          ...scope,
          commandId,
          action: each.action,
          _meta: { idempotencyKey: commandId },
        },
      };
    }),
  };
}

/** A lifecycle receipt as `chat.command` returns it. */
export function translateCommandResult(
  value: unknown,
  ids: WebCoreIds,
): ChatCommandResult {
  const parsed = CoreChatLifecycleResultSchema.safeParse(value);
  if (!parsed.success) throw new WebCoreTranslationError('command receipt');
  const receipt = parsed.data;
  return {
    commandId: receipt.commandId,
    revision: receipt.revision,
    outcome: receipt.outcome,
    ...(receipt.reason === undefined ? {} : { reason: receipt.reason }),
    ...(receipt.entityId === undefined
      ? {}
      : { entityId: ids.chatToStore(receipt.entityId) }),
    ...(receipt.messageId === undefined
      ? {}
      : { messageId: ids.messageToStore(receipt.messageId) }),
    ...(receipt.archivedAt === undefined
      ? {}
      : { archivedAt: receipt.archivedAt }),
  };
}
