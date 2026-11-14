import {
  CoreChatCommandReceiptSchema,
  CoreChatSnapshotGetResultSchema,
  CoreChatSendReceiptResultSchema,
  CoreChatTranscriptSearchResultSchema,
  type CanopyErrorPayload,
} from '@canopy/protocol/canopy-core';
import {
  CoreCoworkRequestError,
  type CanopyCoreRelayLikeReply,
  type CoreCoworkInvoker,
  type CoreCoworkStream,
} from '@canopy/app-state/core-cowork';
import { formatAskUserAnswers } from '@canopy/desktop-shared/lib/ask-user-answers';
import { createPersistedFileTab } from '@canopy/desktop-shared/persisted-chat-state';
import { sendFailure } from './send-refusal';
import type {
  AgentProviderType,
  ArchivedChatSummary,
  AttachmentMeta,
  ChatArchiveTabRequest,
  ChatCancelRequest,
  ChatCommandRequest,
  ChatCommandResult,
  ChatGetStateRequest,
  ChatQueueEditRequest,
  ChatQueueEntryRequest,
  ChatQueueSetEditLockRequest,
  ChatQueueSnapshotRequest,
  ChatQueueUpdatedEvent,
  ChatSendMessageRequest,
  ChatSendMessageResult,
  ChatStateChange,
  ChatStateChangedEvent,
  ChatStateScopesDeclaration,
  ChatStateSnapshot,
  ChatRestoreArchiveRequest,
  ChatRestoreArchiveResponse,
  ChatModel,
  ChatTranscriptPageRequest,
  ChatTranscriptSearchRequest,
  ChatTranscriptSearchResult,
  CloudChatAttachmentUploadFile,
  CloudChatAttachmentUploadResult,
  CloudChatUploadTarget,
  CodexFastModeToggleRequest,
  PersistedChatMessage,
  ChatTabSettingsPatch,
  PersistedChatTab,
  ThinkingLevelToggleRequest,
} from '@canopy/desktop-shared/types';
import type {
  ChatBackendCancelRequest,
  ChatBackendCancelResult,
} from '../backend';
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
import {
  parseAgentTaskRows,
  type AgentTaskRow,
} from '@canopy/protocol/cloud-session';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import {
  createLiveFollower,
  isTerminalEnd,
  type LiveChat,
} from './live-follower';
import {
  createApprovalFollower,
  type ApprovalFollower,
} from './approval-follower';
import { liveReplyKey, type LiveChatState } from './live-replies';
import { selectionSaveSettled, trackSelectionSave } from './selection-saves';
import { redactMcpAnswersForDisplay } from '../messages';
import {
  isTaskBeingCreated,
  taskCreated,
  taskCreationSettled,
} from './task-creations';
import {
  isCloudChatDeleted,
  isCloudTaskDeleted,
  markCloudChatDeleted,
  markCloudTaskDeleted,
} from './task-deletions';
import { setWebCoreFastMode, useWebCoreFastModeStore } from './fast-mode';
import {
  activeTurnChanges,
  bareId,
  bareScope,
  qualifiedId,
  WebCoreTranslationError,
  translateQueue,
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
  turnRuntimeStatus,
  sendModelConfig,
  withTabChoices,
  withTabSettings,
  withTranscriptPages,
  timerTurnEnds,
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

/** The web core no longer holds what was asked about. */
const isNotFound = (error: unknown): boolean =>
  error instanceof CoreCoworkRequestError && error.payload.kind === 'not_found';

/** A task deleted on another device, refused here without asking (CAN-6614). */
const taskGone = (): CoreCoworkRequestError =>
  new CoreCoworkRequestError({
    kind: 'not_found',
    message: 'The task was not found.',
    retry: { kind: 'never' },
  });

/** A stream end frame whose error says what it followed is gone. */
const endedNotFound = (frame: unknown): boolean =>
  isRecord(frame) && isRecord(frame.error) && frame.error.kind === 'not_found';

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

/** What a send learned about its turn by the time it settled (CAN-6592). */
type ClaimedTurn =
  | { readonly kind: 'named'; readonly turnId: string }
  /** Accepted, but its receipt names no turn: a chat from before turn ids. */
  | { readonly kind: 'unnamed' }
  /** No turn runs: the send was refused, or its turn ended before the receipt. */
  | { readonly kind: 'none' }
  /** The send may have landed, and nothing could name its turn. */
  | { readonly kind: 'unknown' };

/** A Stop in flight and what it stops. */
interface StopInFlight {
  /** The turn it cancels, once known. */
  turnId: string | undefined;
  /** The send in flight whose receipt names the turn. */
  readonly claim: SendClaim | undefined;
  /** The Stop attempt that started it: a later attempt is a retry. */
  readonly attempt: number;
  /** Whether its core.chat.turn.cancel has gone out. */
  sent: boolean;
  promise: Promise<ChatBackendCancelResult>;
}

/**
 * A send in flight, claimed before its request leaves: until its receipt
 * names the turn, a Stop waits on the claim instead of reading a snapshot
 * that can't name a starting turn.
 */
interface SendClaim {
  /** Turn ids the chat's runtime reported while the send was in flight. */
  readonly reported: Set<string>;
  /** Called once, as the send settles; a Stop sets it. */
  onTurn: ((turn: ClaimedTurn) => void) | null;
  closed: boolean;
}

/** The Core state a chat's queue was read at, as queue commands compare it. */
interface QueueVersion {
  readonly sessionId: string | undefined;
  readonly stateVersion: string | undefined;
}

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
  /**
   * The send sequence when each pending turn's receipt named it, so a
   * snapshot requested before the receipt keeps it (CAN-6733).
   */
  readonly pendingAt: Map<string, number>;
  /**
   * Turns the web core reported ended, by bare chat id. A snapshot whose
   * runtime still names one lags that end: it never makes the turn the
   * chat's running turn, or Stop's target, again (CAN-6733).
   */
  readonly ended: Map<string, Set<string>>;
  /**
   * The running turn the chat's events reported, by bare chat id, with the
   * send sequence when they did. It outranks a send in flight as Stop's
   * target; a snapshot clears it only if its read began after the report
   * (CAN-6733).
   */
  readonly live: Map<string, { readonly turnId: string; readonly at: number }>;
  /** Status the web core last reported, by bare chat id. */
  readonly status: Map<string, string>;
  /** Runtime reports seen per chat, so a send can tell whether one came since. */
  readonly reports: Map<string, number>;
  /**
   * Chats with a send that may have landed though neither its reply nor its
   * receipt said so (CAN-6592), by the send sequence when it was marked: its
   * turn may run unnamed until a runtime report, or a snapshot requested
   * after the mark, names it or shows none.
   */
  readonly uncertain: Map<string, number>;
}

/** Drops a chat's pending turn, with the send sequence its receipt named it at. */
function dropPending(turns: ChatTurns, chatId: string): void {
  turns.pending.delete(chatId);
  turns.pendingAt.delete(chatId);
}

/** Whether the web core reported `turnId` ended in `chatId`. */
function reportedEnded(
  turns: ChatTurns,
  chatId: string,
  turnId: string,
): boolean {
  return turns.ended.get(chatId)?.has(turnId) === true;
}

/** Records a turn the web core reported ended (CAN-6733). */
function markTurnEnded(
  turns: ChatTurns,
  chatId: string,
  turnId: string | undefined,
): void {
  if (turnId === undefined) return;
  const ended = turns.ended.get(chatId) ?? new Set<string>();
  turns.ended.set(chatId, ended.add(turnId));
}

/** What a cloud Stop could cancel in one chat, as the backend knows it. */
export interface StopTargetInput<Claim> {
  /** The running turn the chat's events reported (CAN-6733). */
  readonly live?: {
    readonly turnId: string;
    /** Whether it is still the chat's active turn. */
    readonly current: boolean;
    /** Whether the chat's runtime still runs a turn. */
    readonly runs: boolean;
    /** Whether the web core has since reported it ended. */
    readonly ended: boolean;
  };
  /** The turn an accepted receipt named, which no report has named yet. */
  readonly pending?: {
    readonly turnId: string;
    readonly ended: boolean;
    /** Whether the chat's events reported another turn since the receipt. */
    readonly replaced: boolean;
  };
  /** The oldest send in flight, whose receipt will name its turn. */
  readonly claim?: Claim;
  /** The chat's active turn when only a snapshot named it. */
  readonly snapshotOnly?: {
    readonly turnId: string;
    readonly runs: boolean;
    readonly ended: boolean;
  };
}

/** The one a cloud Stop cancels, and why. */
export type StopTargetChoice<Claim> =
  | { readonly kind: 'live' | 'pending' | 'fallback'; readonly turnId: string }
  | { readonly kind: 'claim'; readonly claim: Claim }
  | { readonly kind: 'none' };

/**
 * Stop's target, by one precedence (CAN-6733): a running turn the chat's
 * events reported, then a turn an accepted receipt named, then a send in
 * flight, then a turn only a snapshot named. A receipt is Core's
 * acknowledgement, so it outranks a later send that has none yet; a
 * snapshot may lag an end, so its turn ranks last. A turn reported ended
 * or replaced is never the target.
 */
export function chooseStopTarget<Claim>(
  input: StopTargetInput<Claim>,
): StopTargetChoice<Claim> {
  const { live, pending, claim, snapshotOnly } = input;
  if (live !== undefined && live.current && live.runs && !live.ended)
    return { kind: 'live', turnId: live.turnId };
  if (pending !== undefined && !pending.ended && !pending.replaced)
    return { kind: 'pending', turnId: pending.turnId };
  if (claim !== undefined) return { kind: 'claim', claim };
  if (snapshotOnly !== undefined && snapshotOnly.runs && !snapshotOnly.ended)
    return { kind: 'fallback', turnId: snapshotOnly.turnId };
  return { kind: 'none' };
}

/** Chat and message ids remembered across the two sides, newest last. */
const MESSAGE_ID_LIMIT = 500;

/** How long a user message waits for the send that may have written it. */
const ECHO_WAIT_MS = 10_000;

/** Pages of `core.chat.list` read for one task. */
const CHAT_LIST_PAGE_LIMIT = 10;

const isSnapshotRequired = (error: unknown): boolean =>
  isRecord(error) && error.code === 'core.chat.snapshotRequired';

/** How often a queued edit's hold is renewed, within Core's lease (CAN-6651). */
const EDIT_HOLD_RENEW_MS = 20_000;

/** A queued entry this window holds while its editor is open (CAN-6651). */
interface QueuedEditHold {
  readonly entry: ChatQueueEntryRequest;
  readonly acquisitionId: string;
  renewTimer: ReturnType<typeof setTimeout> | undefined;
}

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
  /**
   * Publishes whether a chat's sent turn may still be starting, by
   * `liveReplyKey`: Stop applies to it before Core names it (CAN-6592).
   */
  readonly publishTurnStarting?: (key: string, starting: boolean) => void;
  /**
   * Whether the store holds a runtime that runs the chat's turn, by the
   * store's ids. A sent turn reads starting until it does (CAN-6677); with
   * no answer, until the turn ends.
   */
  readonly storeRunsTurn?: (
    target: Scope & { readonly chatId: string },
  ) => boolean;
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
  /**
   * A chat's agent tasks, as the web core last reported them: the rows of
   * its snapshot and of each `agent_tasks.replaced`, for the chat's
   * background work (the old cloud chat page's tray, CAN-5976).
   */
  readonly publishAgentTasks?: (
    scope: Scope,
    chatId: string,
    tasks: readonly AgentTaskRow[],
  ) => void;
  /**
   * The web core said the task is gone, deleted on another device
   * (CAN-6614). Called once per task; the store keeps its own chat.
   */
  readonly onTaskDeleted?: (scope: Scope) => void;
  /**
   * Whether a store chat holds unsent work (a draft or attachments): such a
   * chat of a deleted task is kept when the web core removes it (CAN-6614).
   */
  readonly holdsUnsentWork?: (scope: Scope, chatId: string) => boolean;
  /**
   * The scope's project may hold new shared workspace files: a send landed
   * (its attachments join them) or a turn ended (its agent may have written
   * some), as the web's thread reports (CAN-6645).
   */
  readonly onWorkspaceFilesChanged?: (scope: Scope) => void;
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
  /** Find in chat over the whole transcript (CAN-6175 R12). */
  readonly searchTranscript: (
    req: ChatTranscriptSearchRequest,
  ) => Promise<ChatTranscriptSearchResult>;
  readonly command: (req: ChatCommandRequest) => Promise<ChatCommandResult>;
  /** The scope's queued prompts, as the web core serves them (CAN-6644). */
  readonly getQueue: (
    req: ChatQueueSnapshotRequest,
  ) => Promise<ChatQueueUpdatedEvent[]>;
  /** A chat's queued prompts each time they change (CAN-6644). */
  readonly onQueueUpdated: (
    cb: (event: ChatQueueUpdatedEvent) => void,
  ) => () => void;
  /** Removes a queued prompt: Core cancels its queued turn (CAN-6644). */
  readonly cancelQueued: (req: ChatQueueEntryRequest) => Promise<void>;
  /** Saves a queued prompt's new text, under the hold its editor took (CAN-6651). */
  readonly editQueued: (req: ChatQueueEditRequest) => Promise<void>;
  /** Runs a queued prompt now (CAN-6651). */
  readonly forceQueued: (req: ChatQueueEntryRequest) => Promise<void>;
  /** Holds a queued prompt while its editor is open, or releases it (CAN-6651). */
  readonly setQueuedEditLock: (
    req: ChatQueueSetEditLockRequest,
  ) => Promise<void>;
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
  readonly cancel: (
    req: ChatBackendCancelRequest,
  ) => Promise<ChatBackendCancelResult>;
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
  /** The shown cloud chats' tool approvals (CAN-6515). */
  readonly approvals: ApprovalFollower;
  /** Ends every stream: the web core went offline or the window closes. */
  readonly closeAll: () => void;
  /**
   * The store's chat runtimes changed: a sent turn whose runtime the store
   * now runs stops reading starting (CAN-6677).
   */
  readonly storeRuntimesChanged: () => void;
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
        /** The web core's own words for a refusal it explained. */
        readonly message?: string;
      }
  >;
}

type ChatTarget = {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
};

/** A file tab with a settings patch applied, as main applies one. */
function patchFileTab(
  tab: PersistedChatTab,
  patch: ChatTabSettingsPatch,
): PersistedChatTab {
  const next: PersistedChatTab = { ...tab };
  if (patch.filePath !== undefined) next.filePath = patch.filePath;
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.fileViewMode === null) delete next.fileViewMode;
  else if (patch.fileViewMode !== undefined)
    next.fileViewMode = patch.fileViewMode;
  if (patch.fileDiffContext !== undefined)
    next.fileDiffContext = patch.fileDiffContext;
  if (patch.pinned === true) next.pinned = true;
  else if (patch.pinned === false) delete next.pinned;
  return next;
}

export function createWebCoreChatBackendCore(
  options: WebCoreChatBackendOptions,
): WebCoreChatBackendCore {
  const newId = options.newId ?? defaultId;
  const reopenDelayMs = options.reopenDelayMs ?? 1_000;
  const echoWaitMs = options.echoWaitMs ?? ECHO_WAIT_MS;
  const listeners = new Set<(event: ChatStateChangedEvent) => void>();
  const queueListeners = new Set<(event: ChatQueueUpdatedEvent) => void>();
  /** Each chat's queued entries as last read, with the revision Remove sends. */
  const queuedEntries = new Map<
    string,
    ReadonlyMap<string, number | undefined>
  >();
  /** Each chat's queued prompt ids as its runtime last named them. */
  const queuedIds = new Map<string, string>();
  /** Each chat's queue read in flight, and whether another must follow it. */
  const queueReads = new Map<
    string,
    { again: boolean; readonly done: Promise<void> }
  >();
  /** Each chat's queued rows as last taken, for the store's queue reads. */
  const queueRows = new Map<string, ChatQueueUpdatedEvent>();
  /** The Core state each chat's held queue was read at. */
  const queueVersions = new Map<string, QueueVersion>();
  /** The chats whose snapshot says Core holds their queued entries for editing. */
  const editHoldChats = new Set<string>();
  /** The queued entries this window holds for editing, by chat and entry. */
  const editHolds = new Map<string, QueuedEditHold>();
  /**
   * The revision each open editor read its entry at, by chat and entry. The
   * edit goes at it, so a draft another client's edit made stale is refused
   * rather than saved over that edit, with or without a hold.
   */
  const editRevisions = new Map<string, number>();
  /** Each entry's edit in flight, which a reopened editor waits out. */
  const editSaves = new Map<string, Promise<void>>();
  /** Moves on each closeAll, so a hold granted after it is never kept. */
  let editHoldGeneration = 0;
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
   * Questions this window answered, with their answers, by scope. The web
   * core removes an answered question, and a cloud harness's turn may record
   * no result for it (CAN-6394): the store keeps the answered record, as
   * main keeps a local chat's, so its card reads as answered.
   */
  const answered = new Map<string, Map<string, PendingQuestion>>();
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
  /** Chats whose agent tasks this window has read, by scope. */
  const taskReads = new Map<string, Set<string>>();
  /** Task changes the events reported, by scope and chat. */
  const taskEvents = new Map<string, number>();
  const taskEventKey = (scope: Scope, chatId: string): string =>
    `${scopeKey(scope)}/${chatId}`;

  function publishTasks(scope: Scope, chatId: string, tasks: unknown): void {
    options.publishAgentTasks?.(
      scope,
      ids.chatToStore(chatId),
      parseAgentTaskRows(tasks),
    );
  }

  /** The chat's own snapshot, for its tasks: a task snapshot holds one chat's. */
  async function readChatTasks(scope: Scope, chatId: string): Promise<void> {
    const reads = taskReads.get(scopeKey(scope)) ?? new Set<string>();
    if (reads.has(chatId)) return;
    taskReads.set(scopeKey(scope), reads.add(chatId));
    const eventsAtRead = taskEvents.get(taskEventKey(scope, chatId)) ?? 0;
    try {
      const snapshot = await request('core.chat.snapshot.get', {
        scope: bareScope(scope),
        chatId,
      });
      // A task change reported while the snapshot was read is newer.
      if (
        isRecord(snapshot) &&
        (taskEvents.get(taskEventKey(scope, chatId)) ?? 0) === eventsAtRead
      )
        publishTasks(scope, chatId, snapshot.tasks);
      // The tab's own snapshot carries its queue (CAN-6644).
      for (const event of takeSnapshotQueues(scope, snapshot))
        for (const listener of queueListeners) listener(event);
    } catch (error) {
      reads.delete(chatId);
      reportClientAppError(error);
    }
  }
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
  /**
   * Bumped as a send's outcome becomes uncertain, so a snapshot can tell
   * whether it was requested before or after (CAN-6592).
   */
  let sendSequence = 0;
  /** Each chat's claimed sends in flight, oldest first, by scope and bare chat id. */
  const claims = new Map<string, SendClaim[]>();
  /**
   * Each chat's Stops in flight, by what they stop: a press at the same turn
   * or the same send joins one, never adds a cancel; a press at another turn
   * (the last one ended while its cancel waited) sends its own (CAN-6592).
   */
  const stops = new Map<string, StopInFlight[]>();

  function claimKey(scope: Scope, chatId: string): string {
    return `${scopeKey(scope)}\u0000${chatId}`;
  }

  function openClaim(scope: Scope, chatId: string): SendClaim {
    const claim: SendClaim = {
      reported: new Set(),
      onTurn: null,
      closed: false,
    };
    const key = claimKey(scope, chatId);
    claims.set(key, [...(claims.get(key) ?? []), claim]);
    refreshStarting(scope);
    return claim;
  }

  /** Chats published as starting, by scope key, with their bare chat ids. */
  const startingByScope = new Map<
    string,
    { readonly scope: Scope; readonly chatIds: ReadonlySet<string> }
  >();

  function publishStarting(
    scope: Scope,
    chatId: string,
    starting: boolean,
  ): void {
    options.publishTurnStarting?.(
      liveReplyKey({
        projectId: scope.projectId,
        worktreeId: scope.worktreeId,
        chatId: ids.chatToStore(chatId),
      }),
      starting,
    );
  }

  /**
   * Each chat's sent turn that a report or snapshot named after it started,
   * by scope key and bare chat id: the turn id it was handed to, while the
   * store holds no runtime that runs it yet (CAN-6677).
   */
  const handoffsByScope = new Map<string, Map<string, string>>();

  function storeRuns(scope: Scope, chatId: string): boolean {
    return (
      options.storeRunsTurn?.({
        projectId: scope.projectId,
        worktreeId: scope.worktreeId,
        chatId: ids.chatToStore(chatId),
      }) === true
    );
  }

  /**
   * Keeps a sent turn starting until the store runs it. The backend names
   * the turn before the store holds its runtime: a snapshot's runtime
   * installs only once the chat's transcript pages load, and the store holds
   * a report back while a refresh runs. A turn that was starting stays so,
   * handed off to the turn id that named it, until the store's runtime runs
   * it ({@link storeRuntimesChanged}), or the turn ends or another replaces
   * it. Once the store runs it, the turn reads running, not starting
   * (CAN-6677).
   */
  function keepHandoffs(
    scope: Scope,
    before: ReadonlySet<string>,
    starting: Set<string>,
  ): void {
    const turns = turnsFor(scope);
    const handed =
      handoffsByScope.get(scopeKey(scope)) ?? new Map<string, string>();
    const wasHanded = new Set(handed.keys());
    for (const [chatId, turnId] of [...handed])
      if (
        turns.active.get(chatId) !== turnId ||
        !turnRuns(scope, chatId) ||
        storeRuns(scope, chatId)
      )
        handed.delete(chatId);
    // Only a turn that was starting hands off: never another turn that
    // follows a handed-off one.
    for (const chatId of before) {
      const turnId = turns.active.get(chatId);
      if (
        !starting.has(chatId) &&
        !wasHanded.has(chatId) &&
        turnId !== undefined &&
        turnRuns(scope, chatId) &&
        !storeRuns(scope, chatId)
      )
        handed.set(chatId, turnId);
    }
    for (const chatId of handed.keys()) starting.add(chatId);
    if (handed.size === 0) handoffsByScope.delete(scopeKey(scope));
    else handoffsByScope.set(scopeKey(scope), handed);
  }

  function storeRuntimesChanged(): void {
    for (const { scope } of [...startingByScope.values()])
      if (handoffsByScope.has(scopeKey(scope))) refreshStarting(scope);
  }

  /**
   * Publishes each chat of the scope whose sent turn may still be starting:
   * a send in flight, or a receipt's turn no report has named or ended yet.
   * Exactly the turns Stop cancels by a receipt's id. A turn a report or
   * snapshot names stays published until the store's runtime runs it
   * ({@link keepHandoffs}).
   */
  function refreshStarting(scope: Scope): void {
    const turns = turnsFor(scope);
    const starting = new Set<string>();
    for (const chatId of turns.pending.keys())
      if (!turns.active.has(chatId)) starting.add(chatId);
    for (const chatId of turns.uncertain.keys())
      if (!turns.active.has(chatId)) starting.add(chatId);
    const prefix = `${scopeKey(scope)}\u0000`;
    for (const key of claims.keys())
      if (key.startsWith(prefix)) starting.add(key.slice(prefix.length));
    const before =
      startingByScope.get(scopeKey(scope))?.chatIds ?? new Set<string>();
    keepHandoffs(scope, before, starting);
    for (const chatId of before)
      if (!starting.has(chatId)) publishStarting(scope, chatId, false);
    for (const chatId of starting)
      if (!before.has(chatId)) publishStarting(scope, chatId, true);
    if (starting.size === 0) startingByScope.delete(scopeKey(scope));
    else startingByScope.set(scopeKey(scope), { scope, chatIds: starting });
  }

  function closeClaim(
    scope: Scope,
    chatId: string,
    claim: SendClaim,
    turn: ClaimedTurn,
  ): void {
    if (claim.closed) return;
    claim.closed = true;
    const key = claimKey(scope, chatId);
    const left = (claims.get(key) ?? []).filter((each) => each !== claim);
    if (left.length === 0) claims.delete(key);
    else claims.set(key, left);
    claim.onTurn?.(turn);
    refreshStarting(scope);
  }

  /** A turn the chat's runtime reported while its sends were in flight. */
  function noteReportedTurn(
    scope: Scope,
    chatId: string,
    turnId: string,
  ): void {
    for (const claim of claims.get(claimKey(scope, chatId)) ?? [])
      claim.reported.add(turnId);
  }
  /**
   * The turn ends each chat's timers have named, by scope and store chat id
   * (CAN-6560). A timer that arrives by event patches the chat's whole
   * record, as main's turn end does, so the ends its pages named stay.
   */
  const timerEnds = new Map<
    string,
    NonNullable<PersistedChatTab['turnEnds']>
  >();

  function recordTimerEnds(
    scope: Scope,
    chatId: string,
    ends: NonNullable<PersistedChatTab['turnEnds']>,
  ): NonNullable<PersistedChatTab['turnEnds']> {
    const key = `${scopeKey(scope)}\u0000${chatId}`;
    const merged = { ...timerEnds.get(key), ...ends };
    timerEnds.set(key, merged);
    return merged;
  }

  /** The turn-end patch each chat whose timer an event brings takes. */
  function timerEndPatches(
    scope: Scope,
    changes: readonly ChatStateChange[],
  ): ChatStateChange[] {
    const patches: ChatStateChange[] = [];
    for (const change of changes) {
      if (
        change.type !== 'message.upserted' &&
        change.type !== 'messages.replaced'
      )
        continue;
      const ends = timerTurnEnds(
        change.type === 'message.upserted' ? [change.message] : change.messages,
      );
      if (ends === undefined) continue;
      patches.push({
        type: 'tab.metadata_patched',
        tabId: change.chatId,
        patch: { turnEnds: recordTimerEnds(scope, change.chatId, ends) },
      });
    }
    return patches;
  }
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

  /**
   * The result of each question call this window answered, by tool call id,
   * and the call of each question it answered, by question id. Core records
   * no result for its question tool's call, so the web core's transcript
   * ends at the call and the store would close it as interrupted; the call
   * shows the answer as a local chat's does instead (CAN-6394).
   */
  const questionResults = new Map<string, string>();
  const answeredCalls = new Map<string, string>();

  /**
   * Remembers an answer as it is sent, since the web core may report the
   * question settled before it replies: its record, which the store keeps
   * answered, and its call's result. Returns the undo for a refused answer.
   */
  function rememberAnswer(
    scope: Scope,
    command: Extract<
      ChatCommandRequest['command'],
      { type: 'chat.answer_question' }
    >,
  ): () => void {
    const asked = questions.get(scopeKey(scope))?.get(command.questionId);
    if (asked === undefined) return (): void => undefined;
    const shown = redactMcpAnswersForDisplay(asked.questions, [
      ...command.answers,
    ]);
    const records =
      answered.get(scopeKey(scope)) ?? new Map<string, PendingQuestion>();
    records.set(command.questionId, {
      ...asked,
      answers: shown,
      answeredAt: Date.now(),
    });
    answered.set(scopeKey(scope), records);
    const toolUseId = asked.toolUseId;
    if (toolUseId !== undefined) {
      questionResults.set(toolUseId, formatAskUserAnswers(shown));
      answeredCalls.set(command.questionId, toolUseId);
    }
    for (const oldest of questionResults.keys()) {
      if (questionResults.size <= MESSAGE_ID_LIMIT) break;
      questionResults.delete(oldest);
    }
    for (const oldest of answeredCalls.keys()) {
      if (answeredCalls.size <= MESSAGE_ID_LIMIT) break;
      answeredCalls.delete(oldest);
    }
    return () => {
      records.delete(command.questionId);
      if (toolUseId === undefined) return;
      questionResults.delete(toolUseId);
      answeredCalls.delete(command.questionId);
    };
  }

  /** A message with the result of each question call this window answered. */
  function withQuestionResults(
    message: PersistedChatMessage,
  ): PersistedChatMessage {
    if (message.role !== 'assistant' || questionResults.size === 0)
      return message;
    const settled = new Set(
      message.blocks.flatMap((block) =>
        block.type === 'tool_result' ? [block.toolUseId] : [],
      ),
    );
    let changed = false;
    const blocks = message.blocks.flatMap((block) => {
      if (block.type !== 'tool_use' || settled.has(block.toolUseId))
        return [block];
      const output = questionResults.get(block.toolUseId);
      if (output === undefined) return [block];
      changed = true;
      return [
        block,
        {
          type: 'tool_result' as const,
          toolUseId: block.toolUseId,
          toolName: block.toolName,
          output,
          isError: false,
        },
      ];
    });
    return changed ? { ...message, blocks } : message;
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
      pendingAt: new Map(),
      ended: new Map(),
      live: new Map(),
      uncertain: new Map(),
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
    onIdle: (chat) => {
      if (turnRuns(chat, ids.chatToCore(chat.chatId)))
        void refreshEndedTurn(
          { projectId: chat.projectId, worktreeId: chat.worktreeId },
          chat.chatId,
        );
    },
    ...(options.liveReopenDelayMs === undefined
      ? {}
      : { reopenDelayMs: options.liveReopenDelayMs }),
    ...(options.liveHoldMs === undefined ? {} : { holdMs: options.liveHoldMs }),
  });

  const approvals = createApprovalFollower({
    invoker,
    chatToCore: ids.chatToCore,
    providerOf: (chat) =>
      tabModels.get(scopeKey(chat))?.get(chat.chatId)?.reported?.choice
        .providerType,
    turnRuns: (chat) => turnRuns(chat, ids.chatToCore(chat.chatId)),
  });

  /** The followed chats' streams, after the committed runtime changed. */
  function refreshFollowers(): void {
    live.refresh();
    approvals.refresh();
  }

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
    if (translated.turnEnds !== undefined)
      recordTimerEnds(scope, ids.chatToStore(chatId), translated.turnEnds);
    return {
      ...translated,
      messages: translated.messages.map((message) =>
        withQuestionResults(withSentAttachments(message)),
      ),
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
    if (isCloudTaskDeleted(req)) throw taskGone();
    const snapshot = await readState(req).catch((error: unknown) => {
      if (isNotFound(error)) taskDeleted(req);
      throw error;
    });
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
    if (isCloudTaskDeleted(req)) throw taskGone();
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
    // A snapshot requested before a send's uncertainty was marked can't
    // settle that send (CAN-6592).
    const sendsAtRead = sendSequence;
    // The snapshot first: its revision and cursor cover every later change.
    const taskEventsAtRead = new Map(taskEvents);
    const opened = await request('core.chat.snapshot.get', {
      scope: bareScope(req),
    });
    // The task snapshot carries its opened chat's tasks; another chat's are
    // read when it is shown.
    const openedChatId =
      isRecord(opened) &&
      isRecord(opened.tabs) &&
      typeof opened.tabs.activeTabId === 'string'
        ? opened.tabs.activeTabId
        : null;
    taskReads.set(
      scopeKey(req),
      new Set(openedChatId === null ? [] : [openedChatId]),
    );
    // A task change reported while the snapshot was read is newer.
    if (
      openedChatId !== null &&
      isRecord(opened) &&
      taskEvents.get(taskEventKey(req, openedChatId)) ===
        taskEventsAtRead.get(taskEventKey(req, openedChatId))
    )
      publishTasks(req, openedChatId, opened.tasks);
    const translated = translateSnapshot(
      opened,
      await listChats(req),
      req,
      ids,
    );
    cursors.set(scopeKey(req), translated.eventsCursor);
    // The snapshot's exact runtimes name their chats' queued prompts, so the
    // next event compares against what it read; a newer queue held wins.
    // Every reader of this snapshot, not only the store's install, may change
    // a chat's rows: the store hears each change.
    for (const event of takeSnapshotQueues(req, opened))
      for (const listener of queueListeners) listener(event);
    translated.snapshot.queue = heldQueue(req);
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
    // A chat that ran before this read, and the turn it ran: a turn that
    // ended or was replaced while its events were missed ends here
    // (CAN-6645).
    const runs = (chatId: string): boolean => {
      const status = turns.status.get(chatId);
      return (
        turns.active.has(chatId) ||
        turns.pending.has(chatId) ||
        isTurnRunningStatus(status) ||
        status === 'awaiting_input'
      );
    };
    // A runtime that still names a turn the web core reported ended lags
    // that end, so it says nothing about the chat: not its running turn or
    // status, and not a later receipt's turn, which stays Stop's. The chat
    // keeps what it held, as one an event moved does (CAN-6733).
    const namesEnded = (chatId: string): boolean => {
      const turnId = translated.activeTurns.get(chatId);
      return turnId !== undefined && reportedEnded(turns, chatId, turnId);
    };
    const lags = (chatId: string): boolean =>
      moved(chatId) || namesEnded(chatId);
    const ranBefore = new Map(
      [
        ...new Set([
          ...turns.active.keys(),
          ...turns.pending.keys(),
          ...turns.status.keys(),
        ]),
      ]
        .filter((chatId) => !lags(chatId) && runs(chatId))
        .map((chatId) => [chatId, turns.active.get(chatId)] as const),
    );
    // A receipt that named its turn after this read began: the read can't
    // say that turn never started, so it stays Stop's (CAN-6733).
    const namedSince = (chatId: string): boolean =>
      (turns.pendingAt.get(chatId) ?? 0) > sendsAtRead;
    for (const map of [turns.active, turns.pending, turns.status])
      for (const chatId of [...map.keys()])
        if (
          !lags(chatId) &&
          !(
            map === turns.pending &&
            (startsUnnamed(chatId) || namedSince(chatId))
          )
        )
          map.delete(chatId);
    for (const chatId of [...turns.pendingAt.keys()])
      if (!turns.pending.has(chatId)) turns.pendingAt.delete(chatId);
    // A snapshot that names the chat's turn, or shows none starting, settles
    // an uncertain send.
    for (const [chatId, markedAt] of [...turns.uncertain])
      if (markedAt <= sendsAtRead && !lags(chatId) && !startsUnnamed(chatId))
        turns.uncertain.delete(chatId);
    for (const [chatId, turnId] of translated.activeTurns)
      if (!lags(chatId)) {
        turns.active.set(chatId, turnId);
        noteReportedTurn(req, chatId, turnId);
      }
    // A read that began after the live report and names another turn, or
    // none, ended or replaced it.
    for (const [chatId, live] of [...turns.live])
      if (
        live.at <= sendsAtRead &&
        !lags(chatId) &&
        turns.active.get(chatId) !== live.turnId
      )
        turns.live.delete(chatId);
    for (const [chatId, status] of translated.statuses) {
      if (lags(chatId)) continue;
      turns.status.set(chatId, status);
      // An unnamed starting turn names no turn and ends none: a send in
      // flight still keeps its receipt's turn.
      if (!startsUnnamed(chatId))
        turns.reports.set(chatId, (turns.reports.get(chatId) ?? 0) + 1);
    }
    if (
      [...ranBefore].some(
        ([chatId, turnId]) =>
          !runs(chatId) ||
          (turnId !== undefined &&
            turns.active.has(chatId) &&
            turns.active.get(chatId) !== turnId),
      )
    )
      options.onWorkspaceFilesChanged?.({
        projectId: req.projectId,
        worktreeId: req.worktreeId,
      });
    refreshStarting(req);
    const read = translated.snapshot.tabsFile.pendingQuestions ?? [];
    const kept = [...(questions.get(scopeKey(req))?.values() ?? [])].filter(
      (question) =>
        translated.unreadQuestionChatIds.has(question.chatId) &&
        !read.some((each) => each.requestId === question.requestId),
    );
    const answeredRecords = [
      ...(answered.get(scopeKey(req))?.values() ?? []),
    ].filter(
      (record) => !read.some((each) => each.requestId === record.requestId),
    );
    const pendingQuestions = [...read, ...kept, ...answeredRecords];
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
    refreshFollowers();
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

  /**
   * The web core said the task is gone (CAN-6614): nothing about it is asked
   * again, and its stream stops for good. The store keeps its own chat.
   */
  function taskDeleted(scope: Scope): void {
    if (!markCloudTaskDeleted(scope)) return;
    const entry = streams.get(scopeKey(scope));
    if (entry !== undefined) closeStream(entry);
    options.onTaskDeleted?.(scope);
  }

  /** Whether a change removes the task's own chat, whose id is the task's. */
  function removesOwnChat(
    scope: Scope,
    change: { readonly type: string; readonly tabId?: unknown },
  ): boolean {
    return (
      change.type === 'tab.removed' &&
      typeof change.tabId === 'string' &&
      change.tabId.toLowerCase() === bareId(scope.worktreeId).toLowerCase()
    );
  }

  /**
   * The messages whose question call this window answered, when the event
   * settles the question: the call shows its answer at once, not only once
   * Core commits the turn's reply. A failed read waits for that commit.
   */
  async function answeredQuestionMessages(
    scope: Scope,
    item: ReturnType<typeof parseEventItem>,
  ): Promise<ChatStateChangedEvent['changes']> {
    const callsByChat = new Map<string, Set<string>>();
    for (const change of item.changes) {
      if (change.type !== 'pending_question.removed') continue;
      const toolUseId = answeredCalls.get(change.requestId);
      if (toolUseId === undefined) continue;
      callsByChat.set(
        change.chatId,
        (callsByChat.get(change.chatId) ?? new Set()).add(toolUseId),
      );
    }
    const pages = await Promise.all(
      [...callsByChat].map(async ([chatId, calls]) => {
        const page = await readPage(scope, chatId).catch((error: unknown) => {
          reportClientAppError(error);
          return null;
        });
        return (page?.messages ?? [])
          .filter((message) =>
            message.blocks.some(
              (block) =>
                block.type === 'tool_use' && calls.has(block.toolUseId),
            ),
          )
          .map((message) => ({
            type: 'message.upserted' as const,
            chatId: ids.chatToStore(chatId),
            message,
          }));
      }),
    );
    return pages.flat();
  }

  /**
   * A turn the live stream says has ended, or one Stop found gone, while the
   * committed runtime still runs it (CAN-6393, CAN-6396): read the snapshot,
   * and when it shows the turn over, publish the chat's runtime from it as a
   * revision of this backend's own, as a late echo's repair does. A snapshot
   * that still runs the turn changes nothing the store shows, and one an
   * event overtook is older than the store: neither is published, or a
   * finished turn would show running again.
   */
  async function refreshEndedTurn(
    scope: Scope,
    storeChatId: string,
  ): Promise<void> {
    try {
      const chatId = ids.chatToCore(storeChatId);
      // A send still settling marks the turn its own: read after it.
      await Promise.all([...(sending.get(chatId) ?? [])]);
      const reports = turnsFor(scope).reports;
      const reportsAtRead = reports.get(chatId) ?? 0;
      const snapshot = await getState(scope);
      // The read reports the chat once; any other report came from an event.
      if ((reports.get(chatId) ?? 0) !== reportsAtRead + 1) return;
      const runtime = snapshot.runtimeByChatId[storeChatId];
      const key = scopeKey(scope);
      const base = revisions.get(key);
      if (
        runtime === undefined ||
        base === undefined ||
        isTurnRunningStatus(runtime.status) ||
        runtime.status === 'awaiting_input'
      )
        return;
      offsets.set(key, (offsets.get(key) ?? 0) + 1);
      revisions.set(key, base + 1);
      emit({
        schemaVersion: 1,
        eventId: `web-core-turn-ended:${key}:${base + 1}:${newId()}`,
        occurredAt: new Date().toISOString(),
        projectId: scope.projectId,
        worktreeId: scope.worktreeId,
        baseRevision: base,
        revision: base + 1,
        changes: [{ type: 'runtime.patched', chatId: storeChatId, runtime }],
      });
      options.onWorkspaceFilesChanged?.(scope);
    } catch (error) {
      reportClientAppError(error);
    }
  }

  async function apply(entry: ScopeStream, item: unknown): Promise<void> {
    const parsed = parseEventItem(item);
    // The task's own chat is gone, and the task with it: the store keeps
    // that tab and hears nothing more. Any other chat removed while holding
    // a draft or attachments is kept too, read-only, whatever the order of
    // the web core's items; on its own it leaves the task live.
    const kept = (change: {
      readonly type: string;
      readonly tabId?: unknown;
    }): boolean =>
      removesOwnChat(entry.scope, change) ||
      (change.type === 'tab.removed' &&
        typeof change.tabId === 'string' &&
        options.holdsUnsentWork?.(
          entry.scope,
          ids.chatToStore(change.tabId),
        ) === true);
    const keepsRemovals = parsed.changes.some(kept);
    if (parsed.changes.some((change) => removesOwnChat(entry.scope, change)))
      taskDeleted(entry.scope);
    for (const change of parsed.changes)
      if (
        change.type === 'tab.removed' &&
        !removesOwnChat(entry.scope, change) &&
        kept(change)
      )
        markCloudChatDeleted(entry.scope, ids.chatToStore(change.tabId));
    const transcripts = new Map<string, TranscriptDescriptor>();
    for (const chatId of rereadChatIds(parsed))
      transcripts.set(
        chatId,
        transcriptDescriptor(await readPage(entry.scope, chatId)),
      );
    const answeredMessages = await answeredQuestionMessages(
      entry.scope,
      parsed,
    );
    const turns = turnsFor(entry.scope);
    // Core takes a prompt off its queue before it names the turn: a session
    // reported starting with no turn hasn't ended the receipt's turn, which
    // Stop still cancels (CAN-6592).
    const startingUnnamed = new Map<string, boolean>();
    for (const change of parsed.changes)
      if (change.type === 'runtime.patched')
        startingUnnamed.set(
          change.chatId,
          change.runtime.status === 'starting' &&
            typeof change.runtime.activeTurnId !== 'string',
        );
    // A turn that ends, or that a queued turn replaces, may have written
    // the project's workspace files (CAN-6645). A sibling the snapshot lists
    // as running names no turn: its status says it ran.
    let turnEnded = false;
    for (const [chatId, turnId] of activeTurnChanges(parsed)) {
      const previous = turns.active.get(chatId);
      const ran =
        previous !== undefined ||
        turns.pending.has(chatId) ||
        isTurnRunningStatus(turns.status.get(chatId));
      const ends = turnId === null && startingUnnamed.get(chatId) !== true;
      // A turn the report ends, or replaces, ended: a lagging snapshot
      // never names it running again (CAN-6733).
      if (ends) {
        markTurnEnded(turns, chatId, previous);
        markTurnEnded(turns, chatId, turns.pending.get(chatId));
      } else if (
        turnId !== null &&
        previous !== undefined &&
        previous !== turnId
      )
        markTurnEnded(turns, chatId, previous);
      if (turnId !== null || startingUnnamed.get(chatId) !== true) {
        dropPending(turns, chatId);
        turns.uncertain.delete(chatId);
      }
      turns.reports.set(chatId, (turns.reports.get(chatId) ?? 0) + 1);
      if (turnId === null) {
        turns.active.delete(chatId);
        turns.live.delete(chatId);
        if (startingUnnamed.get(chatId) !== true) turnEnded ||= ran;
      } else {
        if (previous !== undefined && previous !== turnId) turnEnded = true;
        // A report is newer than any end it follows: the turn runs.
        turns.ended.get(chatId)?.delete(turnId);
        turns.active.set(chatId, turnId);
        sendSequence += 1;
        turns.live.set(chatId, { turnId, at: sendSequence });
        noteReportedTurn(entry.scope, chatId, turnId);
      }
    }
    if (turnEnded) options.onWorkspaceFilesChanged?.(entry.scope);
    for (const chatId of queueMoves(entry.scope, parsed.changes))
      void refreshQueue(entry.scope, chatId);
    for (const change of parsed.changes)
      if (change.type === 'runtime.patched')
        turns.status.set(change.chatId, turnRuntimeStatus(change.runtime));
      else if (change.type === 'agent_tasks.replaced') {
        const key = taskEventKey(entry.scope, change.chatId);
        taskEvents.set(key, (taskEvents.get(key) ?? 0) + 1);
        publishTasks(entry.scope, change.chatId, change.tasks);
      }
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
    const translated = translateEvent(
      keepsRemovals
        ? {
            ...parsed,
            changes: parsed.changes.filter((change) => !kept(change)),
          }
        : parsed,
      entry.scope,
      transcripts,
      ids,
    );
    const settings = tabChoices.get(scopeKey(entry.scope))?.settings;
    // Shifted as it is emitted, after any repair this event waited behind.
    const revision = toStoreRevision(entry.scope, translated.revision);
    sawCoreRevision(entry.scope, translated.revision);
    const answers = answered.get(scopeKey(entry.scope));
    const event: ChatStateChangedEvent = {
      ...translated,
      changes: [
        ...translated.changes,
        ...answeredMessages,
        ...timerEndPatches(entry.scope, translated.changes),
      ].map((change) => {
        const record =
          change.type === 'pending_question.removed'
            ? answers?.get(change.requestId)
            : undefined;
        if (record !== undefined)
          return { type: 'pending_question.upserted', question: record };
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
          return {
            ...change,
            message: withQuestionResults(withSentAttachments(change.message)),
          };
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
    // After the store took the report, so Stop never drops out between a
    // starting turn and the runtime that names it.
    refreshStarting(entry.scope);
    refreshFollowers();
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
        else if (isTerminalEnd(frame)) {
          after = 'stop';
          // A task whose stream ends not found was deleted (CAN-6614).
          if (endedNotFound(frame)) taskDeleted(entry.scope);
        }
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
      // The snapshot holds only its opened chat's tasks; every other chat
      // this window read may have missed task changes too (CAN-6475).
      for (const storeChatId of readChats.get(key) ?? [])
        void readChatTasks(entry.scope, ids.chatToCore(storeChatId));
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
    if (isCloudTaskDeleted(entry.scope)) return;
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
      if (isNotFound(error)) taskDeleted(entry.scope);
      else if (
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

  async function searchTranscript(
    req: ChatTranscriptSearchRequest,
  ): Promise<ChatTranscriptSearchResult> {
    if (req.target?.kind === 'delegation')
      throw webCoreUnavailable('Searching a delegation');
    const found = CoreChatTranscriptSearchResultSchema.safeParse(
      await request('core.chat.transcript.search', {
        scope: { ...bareScope(req), chatId: ids.chatToCore(req.chatId) },
        query: req.query,
      }),
    );
    if (!found.success) throw new WebCoreTranslationError('transcript search');
    return {
      totalCount: found.data.totalCount,
      matches: found.data.matches.map((match) => ({
        messageId: ids.messageToStore(match.messageId),
        turnId: ids.messageToStore(match.turnId),
        count: match.count,
        ...(match.renderMessageId === undefined
          ? {}
          : { renderMessageId: ids.messageToStore(match.renderMessageId) }),
      })),
    };
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
    // A task still being created has no messages yet (CAN-6098), and one
    // deleted on another device has none to read (CAN-6614).
    if (isTaskBeingCreated(req) || isCloudChatDeleted(req, req.chatId))
      return translateTranscriptPage(
        { messages: [], totalMessages: 0, transcriptRevision: 0 },
        ids,
      );
    if (req.before === undefined)
      void readChatTasks(req, ids.chatToCore(req.chatId));
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

  /**
   * A cloud chat's file tabs are this window's viewers, as the web keeps its
   * own: the web core holds no file tabs and refuses one (CAN-6587). They are
   * kept here and laid over each snapshot; a chat tab's change goes on.
   */
  function keepFileTab(
    req: ChatCommandRequest,
  ): Promise<ChatCommandResult> | undefined {
    const key = scopeKey(req);
    const choices = tabChoices.get(key) ?? {};
    const fileTabs = choices.fileTabs ?? [];
    const isFileTab = (tabId: string): boolean =>
      fileTabs.some((tab) => tab.id === tabId);
    const keep = (
      next: readonly PersistedChatTab[],
      activeTabId?: string,
    ): Promise<ChatCommandResult> => {
      tabChoices.set(key, {
        ...choices,
        fileTabs: next,
        ...(activeTabId === undefined ? {} : { activeTabId }),
      });
      return Promise.resolve({
        commandId: req.commandId,
        revision: revisions.get(key) ?? 0,
        outcome: 'applied',
      });
    };
    const change = req.command;
    switch (change.type) {
      case 'chat.create_file_tab':
        return keep(
          [
            ...fileTabs.filter((tab) => tab.id !== change.tabId),
            createPersistedFileTab({
              id: change.tabId,
              filePath: change.filePath,
              createdAt: new Date().toISOString(),
              ...(change.title === undefined ? {} : { title: change.title }),
              ...(change.viewMode === undefined
                ? {}
                : { viewMode: change.viewMode }),
              ...(change.pinned === true ? { pinned: true } : {}),
            }),
          ],
          change.activate === false ? undefined : change.tabId,
        );
      case 'chat.patch_tab_settings':
        return isFileTab(change.tabId)
          ? keep(
              fileTabs.map((tab) =>
                tab.id === change.tabId ? patchFileTab(tab, change.patch) : tab,
              ),
            )
          : undefined;
      case 'chat.close_tab':
        return isFileTab(change.tabId)
          ? keep(fileTabs.filter((tab) => tab.id !== change.tabId))
          : undefined;
      case 'chat.close_tabs': {
        const closing = change.targets.filter((target) =>
          isFileTab(target.tabId),
        );
        if (closing.length === 0) return undefined;
        const kept = keep(
          fileTabs.filter(
            (tab) => !closing.some((target) => target.tabId === tab.id),
          ),
        );
        const rest = change.targets.filter(
          (target) => !isFileTab(target.tabId),
        );
        return rest.length === 0
          ? kept
          : command({ ...req, command: { ...change, targets: rest } });
      }
      default:
        return undefined;
    }
  }

  async function command(req: ChatCommandRequest): Promise<ChatCommandResult> {
    const fileTab = keepFileTab(req);
    if (fileTab !== undefined) return fileTab;
    // A patch's thinking level is the window's choice for the chat's sends,
    // as the composer's own toggle sets it (CAN-6646).
    if (req.command.type === 'chat.patch_tab_settings') {
      const level = req.command.patch.thinkingLevel;
      if (level !== undefined && isServedThinkingLevel(level))
        setSettingsChoice(
          { ...req, chatId: req.command.tabId },
          { thinkingLevel: level },
        );
    }
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
      const forget =
        req.command.type === 'chat.answer_question'
          ? rememberAnswer(req, req.command)
          : (): void => undefined;
      await request(plan.request.method, plan.request.params).catch(
        (error: unknown) => {
          forget();
          throw error;
        },
      );
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
    const running = runPlan(req, plan.requests).catch((error: unknown) => {
      if (!isNotFound(error)) throw error;
      // What the command names is gone: an outcome, never a transport
      // failure, so it is never sent again. A new chat in a task the web
      // core no longer holds means the task was deleted (CAN-6614).
      if (req.command.type === 'chat.create_tab') taskDeleted(req);
      const result: ChatCommandResult = {
        commandId: req.commandId,
        revision: revisions.get(scopeKey(req)) ?? 0,
        outcome: 'not_found',
        ...(error instanceof Error ? { reason: error.message } : {}),
      };
      return { result, coreRevision: 0 };
    });
    // A message sent meanwhile runs with the model just picked.
    if (req.command.type === 'chat.set_model')
      trackSelectionSave(req.command.tabId, running);
    try {
      const { result, coreRevision } = await running;
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
    /** Whether the send may have landed though no receipt says so. */
    uncertain: { landed: boolean },
  ): Promise<unknown> {
    uncertain.landed = true;
    const reply = await invoker().request('core.chat.message.send', params);
    if (reply.ok) {
      uncertain.landed = false;
      return reply.value;
    }
    const { retry } = reply.error;
    if (
      retry.kind !== 'same_idempotency_key' &&
      retry.kind !== 'same_request'
    ) {
      uncertain.landed = false;
      throw sendFailure(reply.error);
    }
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
    if (receipt.data.outcome === 'matched') {
      uncertain.landed = false;
      return receipt.data.receipt;
    }
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
    // A chat deleted on another device, or its task, takes no file: nothing
    // about it reaches the web core (CAN-6614).
    if (isCloudChatDeleted(target, target.chatId))
      return { ok: false, reason: 'rejected' };
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
    if (!result.ok)
      return result.message === undefined
        ? { ok: false, reason: result.reason }
        : { ok: false, reason: result.reason, message: result.message };
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
    const turns = turnsFor(req);
    // Claimed before any wait, so a Stop from here on cancels this send's
    // turn by its receipt (CAN-6592).
    const claim = openClaim(req, chatId);
    const uncertain = { landed: false };
    let claimed: ClaimedTurn = { kind: 'none' };
    try {
      // A selection the user just saved applies to this turn.
      await selectionSaveSettled(req.chatId);
      const modelConfig = sendModelConfig(
        req.modelConfig?.thinkingLevel ?? req.thinkingLevel,
        options.modelOption?.(req.projectId, req.model),
        useWebCoreFastModeStore.getState().byChat[req.chatId],
      );
      const commandId = newId();
      const scope = bareScope(req);
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
            uncertain,
          ),
        );
        if (!parsed.success) {
          uncertain.landed = true;
          throw new Error('The web core returned an invalid send receipt.');
        }
        receipt = parsed.data;
        if (receipt.messageId !== undefined) {
          remember(receipt.messageId, req.userMessageId);
          renameQueuedPrompt(req, receipt.messageId, req.userMessageId);
        }
      } finally {
        inFlight.delete(settled);
        if (inFlight.size === 0) sending.delete(chatId);
        settle();
      }
      const { outcome, reason, entityId } = receipt;
      if (outcome !== 'applied' && outcome !== 'already_applied')
        throw new Error(reason ?? 'The web core did not accept the message.');
      options.onWorkspaceFilesChanged?.({
        projectId: req.projectId,
        worktreeId: req.worktreeId,
      });
      // A turn the runtime reported during the send and no longer runs has
      // ended. Any other report, one that names no turn included, leaves
      // the receipt's turn the one Stop cancels.
      claimed =
        entityId === undefined
          ? { kind: 'unnamed' }
          : claim.reported.has(entityId) &&
              turns.active.get(chatId) !== entityId
            ? { kind: 'none' }
            : { kind: 'named', turnId: entityId };
      const startsPending =
        claimed.kind === 'named' && !turns.active.has(chatId);
      if (claimed.kind === 'named' && startsPending) {
        turns.pending.set(chatId, claimed.turnId);
        // A snapshot requested before now can't drop it (CAN-6733).
        sendSequence += 1;
        turns.pendingAt.set(chatId, sendSequence);
      }
      // A receipt from before turn ids names no turn: the turn starts, and
      // Stop reads the chat's snapshot for it until a report or a newer
      // snapshot settles it (CAN-6592).
      if (claimed.kind === 'unnamed') markUncertain(turns, chatId);
      // A Stop pressed while the send was in flight sends its cancel now,
      // before anything else this receipt starts.
      closeClaim(req, chatId, claim, claimed);
      if (startsPending) refreshFollowers();
      return {};
    } catch (error) {
      if (uncertain.landed) {
        claimed = { kind: 'unknown' };
        // Stop stays, failing closed, until the turn's fate is known; the
        // send is never resent (CAN-6273).
        markUncertain(turns, chatId);
      }
      throw error;
    } finally {
      closeClaim(req, chatId, claim, claimed);
    }
  }

  /**
   * The running turn of a chat the task listed as running: the list names
   * no turn, so the chat's own snapshot does.
   */
  /**
   * Marks a chat whose sent turn may run with nothing naming it: a lost
   * reply and receipt, or a receipt that names no turn.
   */
  function markUncertain(turns: ChatTurns, chatId: string): void {
    if (turns.active.has(chatId)) return;
    sendSequence += 1;
    turns.uncertain.set(chatId, sendSequence);
  }

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
    const named = parsed.data.runtimeByChatId[chatId]?.activeTurnId ?? null;
    // A turn the web core reported ended is never Stop's again (CAN-6733).
    const turnId =
      named !== null && reportedEnded(turns, chatId, named) ? null : named;
    if (turnId !== null) turns.active.set(chatId, turnId);
    return turnId;
  }

  /** What a press would stop now, by {@link chooseStopTarget}. */
  function stopTarget(
    req: ChatCancelRequest,
    chatId: string,
  ): Pick<StopInFlight, 'turnId' | 'claim'> {
    const turns = turnsFor(req);
    const runs = turnRuns(req, chatId);
    const active = turns.active.get(chatId);
    const live = turns.live.get(chatId);
    const pending = turns.pending.get(chatId);
    const claim = claims.get(claimKey(req, chatId))?.[0];
    const choice = chooseStopTarget({
      ...(live === undefined
        ? {}
        : {
            live: {
              turnId: live.turnId,
              current: active === live.turnId,
              runs,
              ended: reportedEnded(turns, chatId, live.turnId),
            },
          }),
      ...(pending === undefined
        ? {}
        : {
            pending: {
              turnId: pending,
              ended: reportedEnded(turns, chatId, pending),
              replaced:
                live !== undefined &&
                live.turnId !== pending &&
                live.at > (turns.pendingAt.get(chatId) ?? 0),
            },
          }),
      ...(claim === undefined ? {} : { claim }),
      ...(active === undefined || active === live?.turnId
        ? {}
        : {
            snapshotOnly: {
              turnId: active,
              runs,
              ended: reportedEnded(turns, chatId, active),
            },
          }),
    });
    switch (choice.kind) {
      case 'claim':
        return { turnId: undefined, claim: choice.claim };
      case 'none':
        return { turnId: undefined, claim: undefined };
      default:
        return { turnId: choice.turnId, claim: undefined };
    }
  }

  function cancel(
    req: ChatBackendCancelRequest,
  ): Promise<ChatBackendCancelResult> {
    return stopAt(req, stopTarget(req, ids.chatToCore(req.chatId)));
  }

  /** A Stop at the given target, joined with any Stop already at it. */
  async function stopAt(
    req: ChatBackendCancelRequest,
    target: Pick<StopInFlight, 'turnId' | 'claim'>,
  ): Promise<ChatBackendCancelResult> {
    const chatId = ids.chatToCore(req.chatId);
    const key = claimKey(req, chatId);
    const attempt = req.attempt ?? 0;
    const inFlight = stops.get(key) ?? [];
    // A press at the same target joins a Stop of its own attempt, or one
    // whose cancel hasn't gone out yet; a retry once a cancel went out sends
    // its own, and never waits on the first.
    const joined = inFlight.find(
      (each) =>
        (each.attempt === attempt || !each.sent) &&
        (target.turnId !== undefined
          ? each.turnId === target.turnId
          : target.claim !== undefined
            ? each.claim === target.claim
            : each.turnId === undefined && each.claim === undefined),
    );
    if (joined !== undefined) return joined.promise;
    const entry: StopInFlight = {
      ...target,
      attempt,
      sent: false,
      promise: Promise.resolve({}),
    };
    entry.promise = stopTurn(req, chatId, entry);
    stops.set(key, [...inFlight, entry]);
    try {
      return await entry.promise;
    } finally {
      const left = (stops.get(key) ?? []).filter((each) => each !== entry);
      if (left.length === 0) stops.delete(key);
      else stops.set(key, left);
    }
  }

  /**
   * Stop's turn: the one the chat's events or a send's receipt named, else
   * the send in flight's, cancelled as its receipt lands. Only with no send
   * in flight does Stop read the chat's snapshot, for a turn the task listed
   * as running. Nothing reports the stop before the web core accepts the
   * cancel. `not_stopped` is only for what this backend can tell apart: a
   * send whose turn may run but nothing names (a lost reply and receipt,
   * until a report or snapshot settles it, or a receipt from before turn
   * ids whose snapshot names none), and a refused cancel.
   */
  async function stopTurn(
    req: ChatCancelRequest,
    chatId: string,
    entry: StopInFlight,
  ): Promise<ChatBackendCancelResult> {
    const runs = turnRuns(req, chatId);
    if (entry.turnId !== undefined)
      return cancelTurn(req, chatId, entry.turnId, entry);
    const claim = entry.claim;
    if (claim !== undefined)
      return new Promise<ChatBackendCancelResult>((resolve) => {
        claim.onTurn = (turn): void => {
          // A later press at the turn the receipt names joins this Stop.
          if (turn.kind === 'named') entry.turnId = turn.turnId;
          resolve(stopClaimedTurn(req, chatId, turn, entry));
        };
      });
    // A send that may run with no turn named yet: the chat's snapshot may
    // name it; if not, nothing says it ended, so Stop stays to try again.
    if (turnsFor(req).uncertain.has(chatId)) {
      const named = await readActiveTurn(req, chatId);
      return named === null
        ? { outcome: 'not_stopped' }
        : cancelTurn(req, chatId, named, entry);
    }
    if (!runs) return { outcome: 'turn_not_active' };
    // With no send in flight, a snapshot that names no running turn says
    // the turn has ended: not a stop that failed.
    const turnId = await readActiveTurn(req, chatId);
    return turnId === null
      ? { outcome: 'turn_not_active' }
      : cancelTurn(req, chatId, turnId, entry);
  }

  async function stopClaimedTurn(
    req: ChatCancelRequest,
    chatId: string,
    turn: ClaimedTurn,
    entry: StopInFlight,
  ): Promise<ChatBackendCancelResult> {
    switch (turn.kind) {
      case 'named':
        return cancelTurn(req, chatId, turn.turnId, entry);
      case 'none':
        return { outcome: 'turn_not_active' };
      case 'unknown':
        return { outcome: 'not_stopped' };
      case 'unnamed': {
        // A chat from before turn ids: its snapshot names the turn, or the
        // stop fails closed.
        const turnId = await readActiveTurn(req, chatId);
        return turnId === null
          ? { outcome: 'not_stopped' }
          : cancelTurn(req, chatId, turnId, entry);
      }
    }
  }

  async function cancelTurn(
    req: ChatCancelRequest,
    chatId: string,
    turnId: string,
    entry: StopInFlight,
  ): Promise<ChatBackendCancelResult> {
    const turns = turnsFor(req);
    entry.sent = true;
    try {
      await request('core.chat.turn.cancel', {
        chatId,
        turnId,
        reason: 'user',
      });
    } catch (error) {
      // The web core no longer knows the turn: it is over, or a web core
      // from before CAN-6393 could not find it by its conversation turn id.
      // The snapshot is read again, so the chat shows whichever is true.
      if (
        error instanceof CoreCoworkRequestError &&
        error.payload.kind === 'not_found'
      ) {
        if (turns.active.get(chatId) === turnId) turns.active.delete(chatId);
        if (turns.live.get(chatId)?.turnId === turnId)
          turns.live.delete(chatId);
        if (turns.pending.get(chatId) === turnId) dropPending(turns, chatId);
        markTurnEnded(turns, chatId, turnId);
        refreshStarting(req);
        void refreshEndedTurn(
          { projectId: req.projectId, worktreeId: req.worktreeId },
          req.chatId,
        );
        return { outcome: 'turn_not_active' };
      }
      // Any other failure leaves the turn as the chat's events report it:
      // Stop stays to try again. It is reported, never left unhandled.
      reportClientAppError(error);
      return { outcome: 'not_stopped' };
    }
    return { outcome: 'stop_requested' };
  }

  function closeAll(): void {
    live.closeAll();
    approvals.closeAll();
    for (const entry of streams.values()) closeStream(entry);
    streams.clear();
    cursors.clear();
    turnsByScope.clear();
    sending.clear();
    // A Stop waiting on a send the connection drops can't name its turn.
    for (const open of claims.values())
      for (const claim of open) {
        claim.closed = true;
        claim.onTurn?.({ kind: 'unknown' });
      }
    claims.clear();
    stops.clear();
    for (const { scope, chatIds } of startingByScope.values())
      for (const chatId of chatIds) publishStarting(scope, chatId, false);
    startingByScope.clear();
    handoffsByScope.clear();
    // The store drops cloud tabs with the connection; the next snapshot
    // reports their models afresh.
    tabModels.clear();
    coreHeads.clear();
    // No hold outlives the window's cloud chats: each stops renewing and is
    // handed back where the connection still allows (CAN-6651).
    editHoldGeneration += 1;
    editRevisions.clear();
    editSaves.clear();
    for (const [key, hold] of editHolds) {
      clearTimeout(hold.renewTimer);
      releaseEditHold(hold.entry, hold.acquisitionId);
      editHolds.delete(key);
    }
  }

  const queueKey = (scope: Scope, storeChatId: string): string =>
    `${scopeKey(scope)}|${storeChatId}`;

  /**
   * Keeps the queued entries of each chat a read covered, and says which of
   * those chats' rows changed. A chat the read did not cover keeps its rows.
   */
  function rememberQueue(
    scope: Scope,
    covered: readonly string[],
    queue: readonly ChatQueueUpdatedEvent[],
  ): ChatQueueUpdatedEvent[] {
    const read = new Map(queue.map((entry) => [entry.chatId, entry]));
    const changed: ChatQueueUpdatedEvent[] = [];
    for (const chatId of new Set([...covered, ...read.keys()])) {
      const entry = read.get(chatId) ?? {
        projectId: scope.projectId,
        worktreeId: scope.worktreeId,
        chatId,
        queue: [],
      };
      const key = queueKey(scope, chatId);
      const before = queuedEntries.get(key);
      const after = new Map(
        entry.queue.map((row) => [row.id, row.revision] as const),
      );
      if (after.size === 0) {
        queuedEntries.delete(key);
        queueRows.delete(key);
      } else {
        queuedEntries.set(key, after);
        queueRows.set(key, entry);
      }
      if (
        before === undefined
          ? after.size > 0
          : before.size !== after.size ||
            [...after].some(([id, revision]) => before.get(id) !== revision)
      )
        changed.push(entry);
    }
    return changed;
  }

  /** Records a chat's queued prompt ids; true when they differ from before. */
  function noteQueuedIds(
    scope: Scope,
    storeChatId: string,
    queued: readonly unknown[],
  ): boolean {
    const key = queueKey(scope, storeChatId);
    const named = queued.map(String).join('\n');
    const moved = (queuedIds.get(key) ?? '') !== named;
    if (named === '') queuedIds.delete(key);
    else queuedIds.set(key, named);
    return moved;
  }

  /**
   * The store chats an event names other queued prompts for than last read,
   * or whose rows disagree with it: rows held for a chat that names none
   * queued, or none held for one that names some.
   */
  function queueMoves(
    scope: Scope,
    changes: ReturnType<typeof parseEventItem>['changes'],
  ): string[] {
    const moved: string[] = [];
    for (const change of changes) {
      if (change.type !== 'runtime.patched') continue;
      const chatId = ids.chatToStore(change.chatId);
      const queued = change.runtime.queuedMessageIds;
      const differs = noteQueuedIds(scope, chatId, queued);
      const held = queuedEntries.has(queueKey(scope, chatId));
      if (differs || held !== queued.length > 0) moved.push(chatId);
    }
    return moved;
  }

  /** Whether a queue read is at least as new as the one held for its chat. */
  function newerQueue(key: string, version: QueueVersion): boolean {
    const held = queueVersions.get(key);
    if (
      held === undefined ||
      held.sessionId !== version.sessionId ||
      held.stateVersion === undefined ||
      version.stateVersion === undefined
    )
      return true;
    return BigInt(version.stateVersion) >= BigInt(held.stateVersion);
  }

  /**
   * Takes the queue of each chat a snapshot read exactly: the chats its
   * runtime summary covers, whose queued prompts it names. A chat the read
   * only lists carries a placeholder runtime, so its tracking stays. A read
   * older than the queue held for a chat is dropped. Returns the chats whose
   * rows changed.
   */
  function takeSnapshotQueues(
    scope: Scope,
    value: unknown,
  ): ChatQueueUpdatedEvent[] {
    const parsed = CoreChatSnapshotGetResultSchema.safeParse(value);
    if (!parsed.success) return [];
    const changed: ChatQueueUpdatedEvent[] = [];
    for (const [coreChatId, runtime] of Object.entries(
      parsed.data.runtimeByChatId,
    )) {
      const chatId = ids.chatToStore(coreChatId);
      const key = queueKey(scope, chatId);
      const summary = parsed.data.queue.find(
        (each) => each.chatId === coreChatId,
      );
      const version: QueueVersion = {
        sessionId: summary?.sessionId ?? parsed.data.sessionId,
        stateVersion: summary?.stateVersion,
      };
      if (!newerQueue(key, version)) continue;
      queueVersions.set(key, version);
      changed.push(
        ...rememberQueue(
          scope,
          [chatId],
          translateQueue(summary === undefined ? [] : [summary], scope, ids),
        ),
      );
      noteQueuedIds(scope, chatId, runtime.queuedMessageIds);
      if (runtime.queuedEditHold === true) editHoldChats.add(key);
      else editHoldChats.delete(key);
    }
    return changed;
  }

  /**
   * A queue read that landed before its send's receipt names the prompt by
   * Core's id: once the receipt maps it, the store gets the row again under
   * the id it sent the prompt with, so it can take the prompt out of the
   * transcript (CAN-6689).
   */
  function renameQueuedPrompt(
    scope: Scope & { readonly chatId: string },
    coreMessageId: string,
    storeMessageId: string,
  ): void {
    const key = queueKey(scope, scope.chatId);
    const held = queueRows.get(key);
    if (
      held === undefined ||
      !held.queue.some((row) => row.supersedesUserMessageId === coreMessageId)
    )
      return;
    const renamed: ChatQueueUpdatedEvent = {
      ...held,
      queue: held.queue.map((row) =>
        row.supersedesUserMessageId === coreMessageId
          ? { ...row, supersedesUserMessageId: storeMessageId }
          : row,
      ),
    };
    queueRows.set(key, renamed);
    for (const listener of queueListeners) listener(renamed);
  }

  /** The scope's queued rows as held: each chat with prompts queued. */
  function heldQueue(scope: Scope): ChatQueueUpdatedEvent[] {
    const prefix = `${scopeKey(scope)}|`;
    return [...queueRows].flatMap(([key, entry]) =>
      key.startsWith(prefix) ? [entry] : [],
    );
  }

  /** One chat's own snapshot: the web core serves one chat's queue per read. */
  function readChatSnapshot(
    scope: Scope,
    storeChatId: string,
  ): Promise<unknown> {
    return request('core.chat.snapshot.get', {
      scope: bareScope(scope),
      chatId: ids.chatToCore(storeChatId),
    });
  }

  /**
   * Reads a chat's queue again and tells the store when its rows changed
   * (CAN-6644). Reads of one chat in a row coalesce into one more after the
   * one in flight.
   */
  async function refreshQueue(
    scope: Scope,
    storeChatId: string,
  ): Promise<void> {
    const key = queueKey(scope, storeChatId);
    const inFlight = queueReads.get(key);
    if (inFlight !== undefined) {
      inFlight.again = true;
      return inFlight.done;
    }
    let settled = (): void => undefined;
    const state = {
      again: true,
      done: new Promise<void>((resolve) => {
        settled = resolve;
      }),
    };
    queueReads.set(key, state);
    try {
      while (state.again) {
        state.again = false;
        const value = await readChatSnapshot(scope, storeChatId);
        for (const event of takeSnapshotQueues(scope, value))
          for (const listener of queueListeners) listener(event);
      }
    } catch (error) {
      // Forget the prompts the event named, so the next event that names
      // them reads the queue again.
      queuedIds.delete(key);
      reportClientAppError(error);
    } finally {
      queueReads.delete(key);
      settled();
    }
  }

  /**
   * The scope's queued prompts: read for the task's own chat and every chat
   * whose runtime last named queued prompts, then as held.
   */
  async function getQueue(
    req: ChatQueueSnapshotRequest,
  ): Promise<ChatQueueUpdatedEvent[]> {
    const prefix = `${scopeKey(req)}|`;
    const chats = new Set([
      ids.chatToStore(webCoreLocalId(req.worktreeId) ?? req.worktreeId),
    ]);
    for (const key of [...queuedIds.keys(), ...queuedEntries.keys()])
      if (key.startsWith(prefix)) chats.add(key.slice(prefix.length));
    const reads = await Promise.all(
      [...chats].map((chatId) => readChatSnapshot(req, chatId)),
    );
    for (const value of reads) takeSnapshotQueues(req, value);
    return heldQueue(req);
  }

  /**
   * A queued entry's command: the entry's revision as last read goes with
   * it, so a stale one is refused rather than applied to the entry as it is
   * now (CAN-5841).
   */
  function queueEntryCommand(
    req: ChatQueueEntryRequest,
  ): Record<string, unknown> {
    const revision = queuedEntries
      .get(queueKey(req, req.chatId))
      ?.get(req.entryId);
    const commandId = newId();
    return {
      scope: bareScope(req),
      commandId,
      chatId: ids.chatToCore(req.chatId),
      entryId: req.entryId,
      ...(revision === undefined ? {} : { entryRevision: revision }),
      _meta: { idempotencyKey: commandId },
    };
  }

  /** A queue command's receipt, once Core applied it; any other outcome throws. */
  function appliedQueueReceipt(
    value: unknown,
    action: string,
  ): Record<string, unknown> {
    const receipt = CoreChatCommandReceiptSchema.safeParse(value);
    if (!receipt.success)
      throw new WebCoreTranslationError(`queue ${action} receipt`);
    if (
      receipt.data.outcome !== 'applied' &&
      receipt.data.outcome !== 'already_applied'
    )
      throw new Error(
        receipt.data.reason ??
          `The web core did not ${action} the queued message (${receipt.data.outcome}).`,
      );
    return receipt.data;
  }

  /**
   * Sends a queued entry's command, and reads the chat's queue again so its
   * row shows the entry as it is now: after any change, and after any
   * refusal. A hold changes no row, so only its refusal reads again.
   */
  async function queueCommand(
    req: ChatQueueEntryRequest,
    method: string,
    action: string,
    extra: Record<string, unknown> = {},
    changesRow = true,
  ): Promise<Record<string, unknown>> {
    let refused = true;
    try {
      const receipt = appliedQueueReceipt(
        await request(method, { ...queueEntryCommand(req), ...extra }),
        action,
      );
      refused = false;
      return receipt;
    } finally {
      if (changesRow || refused) void refreshQueue(req, req.chatId);
    }
  }

  async function cancelQueued(req: ChatQueueEntryRequest): Promise<void> {
    await queueCommand(req, 'core.chat.queue.entry.cancel', 'cancel');
  }

  /**
   * Runs a queued prompt now. The web core's force moves it to the front of
   * the queue; with a turn running, that is Interrupt, as a local chat's
   * force is, so the running turn is stopped and the prompt runs next.
   * Only the turn that ran when Run now was pressed is stopped: if it ended
   * while the force was answered, or another turn (the forced prompt's own)
   * runs by then, nothing is. A chat listed as running whose turn no event
   * named yet reads it from its snapshot first.
   */
  async function forceQueued(req: ChatQueueEntryRequest): Promise<void> {
    const chatId = ids.chatToCore(req.chatId);
    const running =
      turnsFor(req).active.get(chatId) ??
      (turnRuns(req, chatId)
        ? ((await readActiveTurn(req, chatId)) ?? undefined)
        : undefined);
    await queueCommand(req, 'core.chat.queue.entry.force', 'run');
    if (running === undefined || turnsFor(req).active.get(chatId) !== running)
      return;
    // That turn exactly: Stop's own precedence may name a send in flight.
    await stopAt(
      {
        projectId: req.projectId,
        worktreeId: req.worktreeId,
        chatId: req.chatId,
      },
      { turnId: running, claim: undefined },
    );
  }

  const editHoldKey = (req: ChatQueueEntryRequest): string =>
    `${queueKey(req, req.chatId)}|${req.entryId}`;

  /** Forgets a hold this window took, and stops renewing it. */
  function dropEditHold(key: string): QueuedEditHold | undefined {
    const hold = editHolds.get(key);
    if (hold === undefined) return undefined;
    clearTimeout(hold.renewTimer);
    editHolds.delete(key);
    return hold;
  }

  /**
   * Hands a hold back to Core. A release that fails is recorded: Core's
   * lease ends the hold anyway.
   */
  function releaseEditHold(
    req: ChatQueueEntryRequest,
    acquisitionId: string,
  ): void {
    void Promise.resolve()
      .then(() =>
        request('core.chat.queue.entry.update', {
          ...queueEntryCommand(req),
          mutation: { kind: 'lock', locked: false, acquisitionId },
        }),
      )
      .catch(reportClientAppError);
  }

  /**
   * A hold's lease as Core granted it, timed by Core's clock from its
   * receipt, less a second to cover the trip back.
   */
  function holdLeaseMs(receipt: Record<string, unknown>): number | null {
    const { expiresAt, serverTime } = receipt;
    if (typeof expiresAt !== 'string' || typeof serverTime !== 'string')
      return null;
    const lease = Date.parse(expiresAt) - Date.parse(serverTime) - 1_000;
    return Number.isFinite(lease) && lease > 0 ? lease : null;
  }

  /**
   * Renews a hold before its lease ends, as the web's editor does. A hold
   * Core no longer grants is dropped: the edit still carries the entry's
   * revision, which Core checks.
   */
  function renewEditHoldLater(
    req: ChatQueueEntryRequest,
    key: string,
    leaseMs: number,
  ): void {
    const hold = editHolds.get(key);
    if (hold === undefined) return;
    hold.renewTimer = setTimeout(
      () => {
        if (editHolds.get(key) !== hold) return;
        queueCommand(
          req,
          'core.chat.queue.entry.update',
          'hold',
          {
            mutation: {
              kind: 'lock',
              locked: true,
              acquisitionId: hold.acquisitionId,
            },
          },
          false,
        ).then(
          (receipt) => {
            const lease = holdLeaseMs(receipt);
            if (editHolds.get(key) !== hold) return;
            if (lease === null) dropEditHold(key);
            else renewEditHoldLater(req, key, lease);
          },
          (error: unknown) => {
            if (editHolds.get(key) === hold) dropEditHold(key);
            reportClientAppError(error);
          },
        );
      },
      Math.min(EDIT_HOLD_RENEW_MS, leaseMs),
    );
  }

  /**
   * Holds a queued prompt while its editor is open, so it neither runs nor
   * changes under the edit, or releases the hold when the editor closes
   * unsaved. A chat whose core holds no queued entries edits without one:
   * the edit's revision still guards it, as on the web.
   */
  async function setQueuedEditLock(
    req: ChatQueueSetEditLockRequest,
  ): Promise<void> {
    const key = editHoldKey(req);
    if (!req.locked) {
      editRevisions.delete(key);
      const hold = dropEditHold(key);
      if (hold === undefined) return;
      await queueCommand(
        req,
        'core.chat.queue.entry.update',
        'release',
        {
          mutation: {
            kind: 'lock',
            locked: false,
            acquisitionId: hold.acquisitionId,
          },
        },
        false,
      );
      return;
    }
    // Read before any wait: a close meanwhile leaves this editor no hold.
    const generation = editHoldGeneration;
    // An editor reopened while its last save is in flight opens on the entry
    // as that save left it: the save's hold and revision end with it.
    const saving = editSaves.get(key);
    if (saving !== undefined) {
      // The save's own caller hears how it ended; this only waits it out.
      await Promise.allSettled([saving]);
      await refreshQueue(req, req.chatId);
      if (generation !== editHoldGeneration) return;
    }
    if (editHolds.has(key)) return;
    const revision = queuedEntries
      .get(queueKey(req, req.chatId))
      ?.get(req.entryId);
    if (revision === undefined) editRevisions.delete(key);
    else editRevisions.set(key, revision);
    if (!editHoldChats.has(queueKey(req, req.chatId))) return;
    const receipt = await queueCommand(
      req,
      'core.chat.queue.entry.update',
      'hold',
      { mutation: { kind: 'lock', locked: true } },
      false,
    );
    const { acquisitionId } = receipt;
    // Closed meanwhile: hand the hold back rather than renew it unseen.
    if (generation !== editHoldGeneration) {
      if (typeof acquisitionId === 'string')
        releaseEditHold(req, acquisitionId);
      throw webCoreUnavailable('The web core');
    }
    const lease = holdLeaseMs(receipt);
    if (typeof acquisitionId !== 'string' || lease === null)
      throw new WebCoreTranslationError('queued edit hold');
    // Another lock of the entry was granted first: keep that one.
    if (editHolds.has(key)) {
      releaseEditHold(req, acquisitionId);
      return;
    }
    editHolds.set(key, {
      entry: {
        projectId: req.projectId,
        worktreeId: req.worktreeId,
        chatId: req.chatId,
        entryId: req.entryId,
      },
      acquisitionId,
      renewTimer: undefined,
    });
    renewEditHoldLater(req, key, lease);
  }

  /**
   * Saves a queued prompt's new text under the hold its editor took, which
   * the edit releases, at the revision the editor opened at. The web core edits text only: Core keeps the entry's
   * attachments, and a change to them or a file mention is refused before
   * any request. A failed edit keeps the hold for the editor to release.
   */
  async function editQueued(req: ChatQueueEditRequest): Promise<void> {
    if ((req.fileReferences?.length ?? 0) > 0)
      throw webCoreUnavailable('File mentions');
    if (
      (req.attachmentPaths?.length ?? 0) > 0 ||
      (req.attachmentPromptContexts?.length ?? 0) > 0
    )
      throw webCoreUnavailable("Changing a queued message's attachments");
    const key = editHoldKey(req);
    const hold = editHolds.get(key);
    const revision = editRevisions.get(key);
    const generation = editHoldGeneration;
    const saved = (async (): Promise<void> => {
      await queueCommand(req, 'core.chat.queue.entry.update', 'edit', {
        // At the revision the editor opened at, not one a later read brought.
        ...(revision === undefined ? {} : { entryRevision: revision }),
        // No input mode: the web core refuses one, as the web's route never
        // sends it.
        mutation: {
          kind: 'edit',
          text: req.text,
          ...(hold === undefined ? {} : { acquisitionId: hold.acquisitionId }),
        },
      });
      // A close meanwhile already dropped them, and a later editor's are its own.
      if (generation !== editHoldGeneration) return;
      if (editRevisions.get(key) === revision) editRevisions.delete(key);
      if (editHolds.get(key) === hold) dropEditHold(key);
    })();
    editSaves.set(key, saved);
    try {
      await saved;
    } finally {
      if (editSaves.get(key) === saved) editSaves.delete(key);
    }
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
    searchTranscript,
    command,
    getQueue,
    onQueueUpdated: (cb) => {
      queueListeners.add(cb);
      return () => {
        queueListeners.delete(cb);
      };
    },
    cancelQueued,
    editQueued,
    forceQueued,
    setQueuedEditLock,
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
    setLiveChats: (chats) => {
      live.setFocused(chats);
      approvals.setFocused(chats);
    },
    approvals,
    closeAll,
    storeRuntimesChanged,
    uploadAttachment,
  };
}
