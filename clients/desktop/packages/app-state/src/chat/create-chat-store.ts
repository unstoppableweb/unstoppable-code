import { retainPortalToolPartMetadata } from '@canopy/protocol/portal';
import { createContext, useContext, useEffect, useRef } from 'react';
import { create } from 'zustand';
import type {
  CanopyClient,
  ChatMessageEvent,
  ChatTabSettings,
  PersistChatTabSettingsArgs,
} from '@canopy/app-core';
import type {
  ChatInputDeliveryView,
  ChatSteeringCapabilities,
  PortalChatMessage,
  PortalChatMessageAttachment,
  PortalQueuedMessage,
  PortalChatThinkingLevel,
  PortalChatTurnGroup,
} from '@canopy/protocol/portal';
import type { ModelCatalogThinkingLevel } from '@canopy/protocol/models';
import {
  advanceThinkingLevel,
  providerFallbackThinkingLevels,
} from '@canopy/protocol/thinking';
import {
  CLIENT_STORE_ACTIVATE,
  CLIENT_STORE_DISPOSE,
  type ClientStore,
} from '../create-client-store';
import { useCanopyClientStore } from '../CanopyClientProvider';
import {
  computeIncrementalTurnGroups,
  createEmptyTurnGroupCache,
  type TurnGroupCache,
} from './turn-groups';
import {
  hasAuthoritativeMatch,
  isOptimisticMessage,
  makeOptimisticUserMessage,
  OPTIMISTIC_ID_PREFIX,
  reconcileOptimistic,
  RECONCILE_SKEW_MS,
} from './optimistic';
import {
  CHAT_SEMANTIC_STALE_MS,
  hasChatRepairRequester,
  requestChatRepair,
} from './chat-repair';

/** Coarse streaming state of a single chat thread. */
export type ChatThreadStatus = 'idle' | 'streaming' | 'error';

/** Default composer thinking level (matches the desktop default). */
const DEFAULT_THINKING_LEVEL: PortalChatThinkingLevel = 'high';

const EMPTY_WAITING_DELEGATION_IDS: readonly string[] = Object.freeze([]);

/** Debounce window for settings persistence, mirroring the desktop 500ms save. */
const PERSIST_DEBOUNCE_MS = 500;

/** Unretained, eligible threads kept resident, most recently released first. */
export const CHAT_THREAD_RELEASED_ALLOWANCE = 8;

// Whether a transcript still holds a send awaiting its echo. A later send
// replaces the per-chat binding, so the rows themselves are the record.
// Cached per array: idle threads keep theirs, streaming ones are never checked.
const optimisticPresence = new WeakMap<readonly PortalChatMessage[], boolean>();
const hasOptimisticMessage = (
  messages: readonly PortalChatMessage[],
): boolean => {
  let present = optimisticPresence.get(messages);
  if (present === undefined) {
    present = messages.some(isOptimisticMessage);
    optimisticPresence.set(messages, present);
  }
  return present;
};

const normalizeOptimisticLocalId = (localId: string): string =>
  localId.startsWith(OPTIMISTIC_ID_PREFIX)
    ? localId
    : `${OPTIMISTIC_ID_PREFIX}${localId}`;

/** Routing context for a chat, captured from `chat.message` events. */
export interface ChatRoute {
  readonly scope: 'worktree' | 'standalone' | 'app_advisor';
  readonly workspaceLocalId?: string;
  readonly worktreeLocalId?: string;
}

/** Optional authoritative host state supplied with a transcript snapshot. */
export interface ChatHydrationOptions {
  /** Generation the host captured when it started the hydration request. */
  readonly residencyGeneration?: number;
  /** Replace the transcript exactly instead of merging a late history page. */
  readonly replaceMessages?: boolean;
  readonly status?: ChatThreadStatus;
  readonly error?: string | null;
  readonly turnActive?: boolean;
  readonly route?: ChatRoute;
  readonly settings?: ChatTabSettings;
  readonly queuedMessages?: readonly PortalQueuedMessage[];
  readonly waitingDelegationIds?: readonly string[];
  readonly inputDelivery?: readonly ChatInputDeliveryView[];
  readonly steeringCapabilities?: ChatSteeringCapabilities;
  /**
   * The claim this hydrate writes under. While a chat's transcript is
   * claimed, only its claimant's hydrates write messages; others still apply
   * their runtime state and settings.
   */
  readonly transcriptOwner?: object;
}

/** Live state for one chat thread, keyed by `chatId`. */
export interface ChatThreadState {
  readonly chatId: string;
  /** Set when the thread's transcript was evicted; absent when complete. */
  readonly historyIncomplete?: true;
  /** Mirrors `getResidencyGeneration(chatId)` once nonzero. */
  readonly residencyGeneration?: number;
  /** Messages ordered by `createdAtMs` ascending. */
  readonly messages: readonly PortalChatMessage[];
  /** Turn groups with completed-group object identity preserved across frames. */
  readonly turnGroups: readonly PortalChatTurnGroup[];
  readonly status: ChatThreadStatus;
  /** Failure text when `status === 'error'`, else `null`. */
  readonly error: string | null;
  /**
   * Whether the relay's turn timer is currently streaming (a turn is in flight).
   * The authoritative turn-active signal on the portal path, where content
   * frames arrive already `complete` and so cannot drive the working indicator
   * (CAN-1006). Independent of assistant-frame streaming.
   */
  readonly turnActive: boolean;
  /** Host-authoritative queue mirror. */
  readonly queuedMessages: readonly PortalQueuedMessage[];
  /** Delegations whose request to this chat waits in its queue (ids only). */
  readonly waitingDelegationIds: readonly string[];
  readonly inputDelivery?: readonly ChatInputDeliveryView[];
  readonly steeringCapabilities?: ChatSteeringCapabilities;
  /** Epoch-ms of the most recent message frame, for "last activity" derivations. */
  readonly lastEventAt?: number;
  // ---- Persisted composer settings (CAN-739) ----
  readonly planMode: boolean;
  readonly proposalMode: 'optional' | 'required';
  readonly thinkingLevel: PortalChatThinkingLevel;
  /** Opaque provider tool-input for a pending plan exit, carried across restart. */
  readonly pendingPlanExit?: Readonly<Record<string, unknown>>;
  /** Routing context captured from events, needed to address persistence. */
  readonly route?: ChatRoute;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function partToolUseId(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  return typeof data.toolUseId === 'string' && data.toolUseId.length > 0
    ? data.toolUseId
    : undefined;
}

/** Stable description of repairable semantic staleness in the latest turn. */
export function semanticStalenessSignature(
  thread: ChatThreadState,
): string | null {
  let latestTurnStart = 0;
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    if (thread.messages[index]?.role === 'user') {
      latestTurnStart = index;
      break;
    }
  }

  const completedToolUseIds = new Set<string>();
  const pendingToolUseIds = new Set<string>();
  let anonymousPendingToolUses = 0;
  let openTimer = false;
  for (
    let index = latestTurnStart;
    index < thread.messages.length;
    index += 1
  ) {
    const message = thread.messages[index];
    if (!message) continue;
    for (const part of message.parts ?? []) {
      const toolUseId = partToolUseId(part.data);
      if (part.kind === 'tool_result' && toolUseId) {
        completedToolUseIds.add(toolUseId);
      }
      if (part.kind === 'tool_use') {
        if (
          isRecord(part.data) &&
          Object.prototype.hasOwnProperty.call(part.data, 'result')
        ) {
          if (toolUseId) completedToolUseIds.add(toolUseId);
        } else if (toolUseId) {
          pendingToolUseIds.add(toolUseId);
        } else {
          anonymousPendingToolUses += 1;
        }
      }
      if (part.kind === 'turn_timer' && message.status === 'streaming') {
        openTimer = true;
      }
    }
  }

  const unmatchedToolUses =
    anonymousPendingToolUses +
    Array.from(pendingToolUseIds).filter(
      (toolUseId) => !completedToolUseIds.has(toolUseId),
    ).length;
  if (!openTimer && unmatchedToolUses === 0) return null;
  const lastMessage = thread.messages[thread.messages.length - 1];
  return [
    thread.messages.length,
    lastMessage?.messageId ?? '',
    lastMessage?.updatedAtMs ?? '',
    unmatchedToolUses,
    openTimer ? 1 : 0,
  ].join(':');
}

/**
 * The shared chat store. Ingests {@link ChatMessageEvent}s into per-thread
 * transcript state (CAN-738) and owns the persisted composer settings —
 * plan-mode, thinking-level — plus the optimistic user echo (CAN-739). Settings
 * mutations are persisted through `client.command('chat.persistTabSettings')` on
 * a 500ms debounce.
 */
export interface ChatStoreState {
  /** Per-chat thread state, keyed by `chatId`. */
  readonly threads: Readonly<Record<string, ChatThreadState>>;
  /** Chats whose composer settings have received at least one seed. */
  readonly seededSettingsChatIds?: Readonly<Record<string, true>>;
  /** Retain transcript residency until the returned idempotent release is called. */
  retainThread(chatId: string): () => void;
  /** Monotonic per-chat residency generation; zero until first eviction/reset. */
  getResidencyGeneration(chatId: string): number;
  /**
   * Merge authoritative snapshot/history messages into a thread. Existing live
   * and optimistic frames are retained so a late full-history response can
   * fill the older transcript without rewinding an in-flight turn.
   */
  hydrate(
    chatId: string,
    messages: readonly PortalChatMessage[],
    options?: ChatHydrationOptions,
  ): void;
  /** Drop a thread's state, its turn-group cache, and any pending persist. */
  reset(chatId: string): void;
  /**
   * Make `owner` the only writer of `chatId`'s messages: transport message
   * frames are dropped and other hydrates keep only their runtime state. The
   * web core claims a cloud chat it serves (CAN-6092).
   */
  claimTranscript(chatId: string, owner: object): void;
  /** Ends `owner`'s claim; another owner's claim stays. */
  releaseTranscript(chatId: string, owner: object): void;
  /**
   * Apply one transport-delivered message frame. Public so the
   * {@link createChatStore} subscription can route events in; not intended to
   * be called by feature components, which only read state via selectors.
   */
  ingestMessageEvent(event: ChatMessageEvent): void;
  /** Insert an optimistic user echo for immediate display (reconciled on ingest). */
  addOptimisticUserMessage(
    chatId: string,
    args: {
      text: string;
      createdAtMs: number;
      localId?: string;
      attachments?: readonly PortalChatMessageAttachment[];
    },
  ): void;
  /**
   * Bind an in-flight send's optimistic echo to the host user-message identity
   * it will echo back under. Hosts call this right after dispatching a send,
   * pairing the panel-minted `optimisticLocalId` with the `userMessageId` they
   * put on the wire. When an authoritative user frame with that exact
   * `messageId` is later ingested for `chatId`, the bound optimistic row is
   * removed by identity — regardless of the `RECONCILE_SKEW_MS` window the
   * text-based reconcile is limited to. That window is deliberately narrow (it
   * keeps genuinely repeated identical sends apart), but slow host round trips
   * (e.g. the App Advisor waited send: window ensure + provider session
   * spin-up) stamp the echo's `createdAtMs` well past it, which stranded the
   * optimistic bubble next to the authoritative one.
   *
   * Semantics: latest binding per chat wins; a binding is consumed on the
   * matching ingest, cleared by {@link rollbackOptimisticSend} of the same
   * `localId`, and carried to the target chat by {@link adoptThread} (the App
   * Advisor first-send adoption). The text+skew reconcile stays in place as
   * the fallback for unbound sends.
   */
  bindOptimisticSend(
    chatId: string,
    args: {
      readonly optimisticLocalId: string;
      readonly userMessageId: string;
    },
  ): void;
  /**
   * Roll a pre-host optimistic send back on a portal transport rejection
   * (CAN-1429). The UI supplies the exact `localId` it minted via
   * {@link addOptimisticUserMessage} for the send it is abandoning.
   *
   * - Removes a **pre-host** optimistic send **only if** the supplied `localId`
   *   still owns the optimistic working-state raise for `chatId`.
   * - On a valid rollback: removes only that exact optimistic bubble, recomputes
   *   turn groups, and restores the `status`/`error`/`turnActive` baseline
   *   captured when the raise was applied (e.g. a prior error banner comes
   *   back instead of landing on `idle`), while preserving authoritative
   *   messages, queue state, route, settings, and activity timestamps.
   * - Otherwise (stale ID, replaced owner, already-reconciled bubble,
   *   authoritative or newer turn took over, disposed store): a **no-op** that
   *   returns the existing state object unchanged (referentially equal — must
   *   not trigger a render).
   * - Never lowers an authoritative or newer turn. Never deletes an
   *   authoritative message.
   */
  rollbackOptimisticSend(
    chatId: string,
    args: { readonly localId: string },
  ): void;
  /**
   * Move a provisional browser thread onto the canonical host chat id.
   * Canonical frames that won the response race are merged rather than
   * replaced, and the optimistic working-state owner follows the move.
   */
  adoptThread(sourceChatId: string, targetChatId: string): void;
  /**
   * Seed a chat's composer settings from host persistence (the
   * `chat.getTabSettings` restore path) WITHOUT scheduling a persist. When
   * `ifAbsent` is true, preserve whichever settings source seeded first.
   */
  seedTabSettings(
    chatId: string,
    settings: ChatTabSettings,
    options?: { ifAbsent?: boolean },
  ): void;
  /** Toggle plan mode for a chat (debounced-persisted). */
  setPlanMode(chatId: string, planMode: boolean): void;
  /** Set whether a produced plan requires approval (debounced-persisted). */
  setProposalMode(chatId: string, proposalMode: 'optional' | 'required'): void;
  /** Set the composer thinking level directly (debounced-persisted). */
  setThinkingLevel(chatId: string, level: PortalChatThinkingLevel): void;
  /**
   * Advance the thinking level by one step (debounced-persisted).
   *
   * `supportedLevels` are the efforts the connected desktop projected for the
   * active model (CAN-2441); when omitted the provider-level cycle applies.
   */
  cycleThinkingLevel(
    chatId: string,
    providerType?: string,
    supportedLevels?: readonly ModelCatalogThinkingLevel[],
  ): void;
  /** Set or clear the pending plan-exit payload (debounced-persisted). */
  setPendingPlanExit(
    chatId: string,
    pendingPlanExit: Readonly<Record<string, unknown>> | undefined,
  ): void;
  /** Cancel a chat's pending debounce and persist its settings immediately. */
  flushPersist(chatId: string): void;
}

interface UnrefableTimer {
  unref(): void;
}

function isUnrefableTimer(value: unknown): value is UnrefableTimer {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'unref') === 'function'
  );
}

function emptyThread(chatId: string): ChatThreadState {
  return {
    chatId,
    messages: [],
    turnGroups: [],
    status: 'idle',
    error: null,
    turnActive: false,
    queuedMessages: [],
    waitingDelegationIds: EMPTY_WAITING_DELEGATION_IDS,
    lastEventAt: undefined,
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: DEFAULT_THINKING_LEVEL,
    pendingPlanExit: undefined,
    route: undefined,
  };
}

function sameStringArray(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left === right ||
    (left.length === right.length &&
      left.every((value, index) => value === right[index]))
  );
}

/** Replacement frames retain known user files and matching tool read metadata. */
function retainMessageMetadata(
  incoming: PortalChatMessage,
  existing: PortalChatMessage | undefined,
): PortalChatMessage {
  const withAttachments =
    incoming.role === 'user' &&
    existing?.role === 'user' &&
    incoming.attachments === undefined &&
    existing.attachments !== undefined
      ? { ...incoming, attachments: existing.attachments }
      : incoming;
  if (!existing?.parts || !withAttachments.parts) return withAttachments;
  const parts = retainPortalToolPartMetadata(
    existing.parts,
    withAttachments.parts,
  );
  return parts.every((part, index) => part === withAttachments.parts?.[index])
    ? withAttachments
    : { ...withAttachments, parts };
}

function refreshPresentationOrder(
  existing: PortalChatMessage,
  incoming: PortalChatMessage,
): PortalChatMessage {
  return incoming.presentationOrder === undefined ||
    incoming.presentationOrder === existing.presentationOrder
    ? existing
    : { ...existing, presentationOrder: incoming.presentationOrder };
}

const messageIndexes = new WeakMap<
  readonly PortalChatMessage[],
  ReadonlyMap<string, number>
>();

function indexMessages(
  messages: readonly PortalChatMessage[],
): ReadonlyMap<string, number> {
  let index = messageIndexes.get(messages);
  if (!index) {
    index = new Map(messages.map((message, i) => [message.messageId, i]));
    messageIndexes.set(messages, index);
  }
  return index;
}

let chatBatchDepth = 0;
const pendingChatCommits = new Set<() => void>();

export function batchChatStoreUpdates(callback: () => void): void {
  chatBatchDepth++;
  try {
    callback();
  } finally {
    if (--chatBatchDepth === 0) {
      const commits = Array.from(pendingChatCommits);
      pendingChatCommits.clear();
      for (const commit of commits) commit();
    }
  }
}

function orderMessages(
  messages: readonly PortalChatMessage[],
): PortalChatMessage[] {
  const chronological = messages
    .slice()
    .sort((a, b) => a.createdAtMs - b.createdAtMs);
  const presentationOrdered = messages
    .filter((message) => message.presentationOrder !== undefined)
    .sort(
      (a, b) =>
        (a.presentationOrder ?? 0) - (b.presentationOrder ?? 0) ||
        a.createdAtMs - b.createdAtMs,
    );
  let presentationIndex = 0;
  for (let index = 0; index < chronological.length; index++) {
    if (chronological[index]?.presentationOrder === undefined) continue;
    const orderedMessage = presentationOrdered[presentationIndex++];
    if (orderedMessage !== undefined) chronological[index] = orderedMessage;
  }
  return chronological;
}

/** Upsert by `messageId`, retaining any authoritative presentation order. */
function upsertMessage(
  messages: readonly PortalChatMessage[],
  incoming: PortalChatMessage,
  knownIndex?: number,
): PortalChatMessage[] {
  const indexes = indexMessages(messages);
  const index = knownIndex ?? indexes.get(incoming.messageId) ?? -1;
  if (
    index >= 0 &&
    messages[index].createdAtMs === incoming.createdAtMs &&
    messages[index].presentationOrder === incoming.presentationOrder
  ) {
    const next = messages.slice();
    next[index] = retainMessageMetadata(incoming, messages[index]);
    messageIndexes.set(next, indexes);
    return next;
  }
  const next = messages.slice();
  if (index >= 0)
    next[index] = retainMessageMetadata(incoming, messages[index]);
  else next.push(incoming);
  const ordered = orderMessages(next);
  indexMessages(ordered);
  return ordered;
}

/** A row's revision as the store compares it: a timer's completion counts. */
export function messageRevision(message: PortalChatMessage): number {
  const frameRevision = message.updatedAtMs ?? message.createdAtMs;
  // Persisted timer messages retain their start timestamp; completion advances
  // only the embedded timer block.
  const timerData = message.parts?.find(
    (part) => part.kind === 'turn_timer',
  )?.data;
  const completedAt =
    typeof timerData === 'object' &&
    timerData !== null &&
    'completedAt' in timerData
      ? timerData.completedAt
      : undefined;
  return typeof completedAt === 'number'
    ? Math.max(frameRevision, completedAt)
    : frameRevision;
}

function supersedesCachedMessage(
  cached: PortalChatMessage,
  incoming: PortalChatMessage,
): boolean {
  const revisionDelta = messageRevision(incoming) - messageRevision(cached);
  return (
    revisionDelta > 0 ||
    (revisionDelta === 0 &&
      cached.status === 'streaming' &&
      incoming.status !== 'streaming')
  );
}

/**
 * A `turn_timer` frame: the system message the relay bookends every turn with
 * (a `streaming` start frame and a `complete`/`cancelled` end frame). It is the
 * authoritative turn-active signal for relayed chats — over the portal, content
 * frames arrive already `complete` (the non-delta path finalizes each block),
 * so they cannot drive the working indicator; the timer can.
 */
function isTurnTimerFrame(message: PortalChatMessage): boolean {
  return (
    message.role === 'system' &&
    (message.parts?.some((part) => part.kind === 'turn_timer') ?? false)
  );
}

const TURN_TIMER_ID_SUFFIX = ':turn-timer';

/**
 * Return the user-message identity a turn-timer frame belongs to. A canonical
 * timer (`${T}:timer`) names its execution and anchor in its data, since
 * several executions can share one anchor; a legacy one carries it in its id.
 */
function turnTimerUserMessageId(
  message: PortalChatMessage,
): string | undefined {
  if (!isTurnTimerFrame(message)) return undefined;
  const data = message.parts?.find((part) => part.kind === 'turn_timer')?.data;
  if (isRecord(data) && typeof data.turnId === 'string') {
    return typeof data.userMessageId === 'string' &&
      data.userMessageId.length > 0
      ? data.userMessageId
      : undefined;
  }
  if (!message.messageId.endsWith(TURN_TIMER_ID_SUFFIX)) {
    return undefined;
  }
  const userMessageId = message.messageId.slice(
    0,
    -TURN_TIMER_ID_SUFFIX.length,
  );
  return userMessageId.length > 0 ? userMessageId : undefined;
}

/**
 * Whether an authoritative frame proves that the host owns the turn lifecycle.
 * Content-only terminal assistant frames are deliberately excluded: a delayed
 * completed block from an older turn must not defeat a pending rollback.
 */
function isAuthoritativeTurnLifecycleFrame(
  message: PortalChatMessage,
): boolean {
  return (
    isTurnTimerFrame(message) ||
    (message.role === 'assistant' &&
      (message.status === 'streaming' || message.status === 'failed'))
  );
}

function isTerminalTurnTimerFrame(message: PortalChatMessage): boolean {
  return (
    isTurnTimerFrame(message) &&
    (message.status === 'complete' ||
      message.status === 'cancelled' ||
      message.status === 'failed')
  );
}

/** A frame advances transcript identity when it is new or supersedes its row. */
function isNewOrSupersedingMessage(
  existing: PortalChatMessage | undefined,
  incoming: PortalChatMessage,
): boolean {
  return existing === undefined || supersedesCachedMessage(existing, incoming);
}

/**
 * Derive thread status/error/turn-active from an incoming message frame.
 *
 * Two independent signals raise the working indicator, and `status` is
 * `streaming` while EITHER holds:
 *  - `turnActive` — the relay's turn timer (a `system` `turn_timer` frame):
 *    a `streaming` start frame marks the turn active, a terminal frame ends it.
 *    This is what surfaces the indicator on the portal path, where content
 *    frames arrive already `complete` and cannot drive it (CAN-1006).
 *  - assistant-frame streaming — the delta path (desktop, when wired), where an
 *    assistant message streams and then completes.
 */
function deriveStatus(
  prev: ChatThreadState,
  message: PortalChatMessage,
): { status: ChatThreadStatus; error: string | null; turnActive: boolean } {
  if (isTurnTimerFrame(message)) {
    switch (message.status) {
      case 'streaming':
        return { status: 'streaming', error: null, turnActive: true };
      case 'failed':
        return {
          status: 'error',
          error: prev.error ?? 'Agent run failed',
          turnActive: false,
        };
      case 'complete':
      case 'cancelled':
        // The turn ended: clear turn-active. But do NOT stomp an error the turn
        // already surfaced — on the portal path a failed turn emits an assistant
        // `failed` frame (→ error) immediately before the timer's terminal frame,
        // which the projector always hardcodes to `complete`. Preserving the
        // error keeps the transcript's error banner visible (CAN-1006 review).
        return prev.status === 'error'
          ? { status: 'error', error: prev.error, turnActive: false }
          : { status: 'idle', error: null, turnActive: false };
      default:
        // Exhaustiveness guard (mirrors the assistant switch): the four cases
        // cover `PortalChatMessage['status']`; a new status fails to compile.
        message.status satisfies never;
        return {
          status: prev.status,
          error: prev.error,
          turnActive: prev.turnActive,
        };
    }
  }
  // Non-assistant, non-timer frames (e.g. user echoes) leave the indicator as is.
  if (message.role !== 'assistant') {
    return {
      status: prev.status,
      error: prev.error,
      turnActive: prev.turnActive,
    };
  }
  switch (message.status) {
    case 'streaming':
      return { status: 'streaming', error: null, turnActive: prev.turnActive };
    case 'failed':
      return {
        status: 'error',
        error: message.text.trim() || 'Agent run failed',
        turnActive: prev.turnActive,
      };
    case 'complete':
    case 'cancelled':
      // This assistant message's own stream ended. Keep the indicator up only
      // if the relay turn timer is still active (portal path, where content is
      // always `complete`); otherwise go idle (delta path: streaming → complete).
      return {
        status: prev.turnActive ? 'streaming' : 'idle',
        error: null,
        turnActive: prev.turnActive,
      };
    default: {
      // Exhaustiveness guard: `message.status` is `never` here only while the
      // four cases above cover the union. A new protocol status would make this
      // fail to compile rather than silently return undefined.
      message.status satisfies never;
      return {
        status: prev.status,
        error: prev.error,
        turnActive: prev.turnActive,
      };
    }
  }
}

/**
 * Create a chat store bound to a single {@link CanopyClient}. Wrapped by
 * the provider store registry so each client gets exactly one lazily-created
 * store. The store subscribes to `chat.message` for its provider/client
 * lifecycle; `CanopyClientProvider` disposes that subscription on a client swap
 * or unmount.
 */
export function createChatStore(
  client: CanopyClient,
): ClientStore<ChatStoreState> {
  interface ThreadHandle {
    chatId: string;
    live: boolean;
  }

  const interestHandlesByChatId = new Map<string, Set<ThreadHandle>>();
  const residencyGenerations = new Map<string, number>();
  const releasedMru: string[] = [];
  const releasedMruIds = new Set<string>();
  const partialResidents = new Set<string>();
  const protectedResidents = new Set<string>();
  const inFlightPersistCounts = new Map<string, number>();
  const persistEpochs = new Map<string, number>();
  const externallyReferencedMessageIds = new Map<string, number>();
  /** Chats whose messages only their claimant writes. */
  const transcriptOwners = new Map<string, object>();
  /**
   * Host echoes of sends that just left the host's queue while another writer
   * claims the transcript. The claim fences the host's rows, and the echo is
   * then the only copy of the message, so it stays until the claimant shows it.
   */
  const heldEchoes = new Map<string, readonly PortalChatMessage[]>();
  let disposed = false;
  let storeLifetime = 0;
  let triggerCleanup: ((chatId: string) => void) | null = null;

  const bumpResidencyGeneration = (chatId: string): number => {
    const generation = (residencyGenerations.get(chatId) ?? 0) + 1;
    residencyGenerations.set(chatId, generation);
    return generation;
  };

  const threadHasTranscript = (thread: ChatThreadState): boolean =>
    thread.messages.length > 0 || thread.turnGroups.length > 0;

  const addReleasedMru = (chatId: string, front = true): void => {
    partialResidents.delete(chatId);
    protectedResidents.delete(chatId);
    if (releasedMruIds.has(chatId)) {
      const index = releasedMru.indexOf(chatId);
      if (index >= 0) releasedMru.splice(index, 1);
    } else {
      releasedMruIds.add(chatId);
    }
    if (front) releasedMru.unshift(chatId);
    else releasedMru.push(chatId);
  };

  const removeResidencyCandidate = (chatId: string): void => {
    if (releasedMruIds.delete(chatId)) {
      const index = releasedMru.indexOf(chatId);
      if (index >= 0) releasedMru.splice(index, 1);
    }
    partialResidents.delete(chatId);
    protectedResidents.delete(chatId);
  };

  const addExternalReference = (messageId: string): void => {
    externallyReferencedMessageIds.set(
      messageId,
      (externallyReferencedMessageIds.get(messageId) ?? 0) + 1,
    );
  };

  const removeExternalReference = (messageId: string): void => {
    const count = externallyReferencedMessageIds.get(messageId) ?? 0;
    if (count <= 1) externallyReferencedMessageIds.delete(messageId);
    else externallyReferencedMessageIds.set(messageId, count - 1);
  };

  // Turn-group caches are mutable and live outside Zustand state, one per chat
  // — the same role `useRef` plays in the desktop renderer.
  const caches = new Map<string, TurnGroupCache>();
  const cacheFor = (chatId: string): TurnGroupCache => {
    let cache = caches.get(chatId);
    if (!cache) {
      cache = createEmptyTurnGroupCache();
      caches.set(chatId, cache);
    }
    return cache;
  };

  // Per-chat debounce timers for settings persistence.
  const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const semanticTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let pending: ChatStoreState | undefined;
  const pendingTouchedChatIds = new Set<string>();
  const repairedSemanticSignatures = new Map<string, string>();
  const lastAuthoritativeArrivalAt = new Map<string, number>();

  const scheduleSemanticCheck = (chatId: string): void => {
    const existing = semanticTimers.get(chatId);
    if (existing !== undefined) clearTimeout(existing);
    const current = (pending ?? holder.store?.getState())?.threads[chatId];
    if (!current || semanticStalenessSignature(current) === null) {
      semanticTimers.delete(chatId);
      return;
    }
    const timer = setTimeout(() => {
      semanticTimers.delete(chatId);
      const thread = holder.store?.getState().threads[chatId];
      if (!thread) return;
      const signature = semanticStalenessSignature(thread);
      if (
        signature === null ||
        repairedSemanticSignatures.get(chatId) === signature
      ) {
        return;
      }
      if (!hasChatRepairRequester(client)) {
        scheduleSemanticCheck(chatId);
        return;
      }
      const silentFor =
        Date.now() - (lastAuthoritativeArrivalAt.get(chatId) ?? Date.now());
      if (silentFor < CHAT_SEMANTIC_STALE_MS) {
        scheduleSemanticCheck(chatId);
        return;
      }
      repairedSemanticSignatures.set(chatId, signature);
      const accepted = requestChatRepair(client, {
        chatId,
        scope: thread.route?.scope ?? 'worktree',
        workspaceLocalId: thread.route?.workspaceLocalId,
        worktreeLocalId: thread.route?.worktreeLocalId,
        trigger: 'semantic',
        onDispatchFailure: (): void => {
          if (repairedSemanticSignatures.get(chatId) === signature) {
            repairedSemanticSignatures.delete(chatId);
            scheduleSemanticCheck(chatId);
          }
        },
      });
      if (!accepted) repairedSemanticSignatures.delete(chatId);
    }, CHAT_SEMANTIC_STALE_MS);
    // Node/Jest timers should not keep an otherwise-idle process alive. Browser
    // timers are numeric and simply skip this optional lifecycle hook.
    if (isUnrefableTimer(timer)) timer.unref();
    semanticTimers.set(chatId, timer);
  };
  // Counts authoritative arrivals applied by this store. This store-local
  // generation is deliberately unrelated to host/client wall clocks.
  let authoritativeSeq = 0;
  // The exact optimistic echo that currently owns each chat's temporary
  // working-state raise, plus the turn identity allowed to advance it. The turn
  // identity starts as the optimistic id, rebinds to the authoritative user echo,
  // and remains live until a matching lifecycle frame or explicit host state
  // takes over. The pre-raise runtime fields are restored on a pre-host rollback.
  const optimisticRaiseOwners = new Map<
    string,
    {
      localId: string;
      turnUserMessageId: string;
      baselineSeq: number;
      baseline: Pick<ChatThreadState, 'status' | 'error' | 'turnActive'>;
    }
  >();
  // Identity bindings from `bindOptimisticSend`: the optimistic echo each chat's
  // latest dispatched send inserted, paired with the wire `userMessageId` its
  // authoritative echo will carry. Lets ingest/hydrate reconcile by id when the
  // host round trip outlives the text-skew window. Latest-per-chat wins;
  // consumed on the matching echo, cleared on rollback/reset, carried on adopt.
  const optimisticSendBindings = new Map<
    string,
    { optimisticLocalId: string; userMessageId: string }
  >();
  const putOptimisticOwner = (
    chatId: string,
    owner: {
      localId: string;
      turnUserMessageId: string;
      baselineSeq: number;
      baseline: Pick<ChatThreadState, 'status' | 'error' | 'turnActive'>;
    },
  ): void => {
    const previous = optimisticRaiseOwners.get(chatId);
    if (previous) removeExternalReference(previous.turnUserMessageId);
    optimisticRaiseOwners.set(chatId, owner);
    addExternalReference(owner.turnUserMessageId);
  };
  const updateOptimisticOwnerTurnId = (
    owner: { turnUserMessageId: string },
    messageId: string,
  ): void => {
    if (owner.turnUserMessageId === messageId) return;
    removeExternalReference(owner.turnUserMessageId);
    owner.turnUserMessageId = messageId;
    addExternalReference(messageId);
  };
  const removeOptimisticOwner = (chatId: string): void => {
    const previous = optimisticRaiseOwners.get(chatId);
    if (!previous) return;
    optimisticRaiseOwners.delete(chatId);
    removeExternalReference(previous.turnUserMessageId);
  };
  const putOptimisticBinding = (
    chatId: string,
    binding: { optimisticLocalId: string; userMessageId: string },
  ): void => {
    const previous = optimisticSendBindings.get(chatId);
    if (previous) removeExternalReference(previous.userMessageId);
    optimisticSendBindings.set(chatId, binding);
    addExternalReference(binding.userMessageId);
  };
  const removeOptimisticBinding = (chatId: string): void => {
    const previous = optimisticSendBindings.get(chatId);
    if (!previous) return;
    optimisticSendBindings.delete(chatId);
    removeExternalReference(previous.userMessageId);
  };
  // Echoes whose identity bindings were already consumed, per chat. A
  // consumed echo stays in the transcript, so no text-skew match site may
  // mistake it for the authoritative counterpart of a NEW same-text send.
  // Entries are pruned by time rather than count: an echo can only collide
  // while an optimistic row within RECONCILE_SKEW_MS of it exists, so
  // anything older than 10x the skew window relative to the newest entry is
  // provably irrelevant (no burst size can evict a still-relevant id).
  const consumedBindingEchoes = new Map<
    string,
    Array<{ echoId: string; createdAtMs: number }>
  >();
  // Cutoff derives from the NEWEST entry (not the just-received echo, which
  // may arrive out of timestamp order), so the invariant holds regardless of
  // arrival order or merge source.
  const pruneConsumedEchoes = (
    entries: Array<{ echoId: string; createdAtMs: number }>,
  ): Array<{ echoId: string; createdAtMs: number }> => {
    const newest = entries.reduce(
      (max, entry) => Math.max(max, entry.createdAtMs),
      0,
    );
    const cutoff = newest - RECONCILE_SKEW_MS * 10;
    return entries.filter((entry) => entry.createdAtMs >= cutoff);
  };
  const rememberConsumedEcho = (
    chatId: string,
    echo: { messageId: string; createdAtMs: number },
  ): void => {
    const entries = consumedBindingEchoes.get(chatId) ?? [];
    entries.push({ echoId: echo.messageId, createdAtMs: echo.createdAtMs });
    consumedBindingEchoes.set(chatId, pruneConsumedEchoes(entries));
  };
  const consumedEchoIdsFor = (chatId: string): ReadonlySet<string> | null => {
    const entries = consumedBindingEchoes.get(chatId);
    if (!entries?.length) return null;
    return new Set(entries.map((entry) => entry.echoId));
  };
  // Shared exclusion for every text-skew match site: consumed echoes never
  // participate, whether consumed in this operation or a previous one.
  const withoutConsumedEchoes = (
    chatId: string,
    messages: readonly PortalChatMessage[],
    alsoExclude?: PortalChatMessage,
  ): readonly PortalChatMessage[] => {
    const consumed = consumedEchoIdsFor(chatId);
    if (!consumed && alsoExclude === undefined) return messages;
    return messages.filter(
      (message) => message !== alsoExclude && !consumed?.has(message.messageId),
    );
  };
  // Holder so the debounce helpers can read the store lazily (at timer-fire
  // time) without a forward `let` binding: the store is assigned once, below.
  const holder: { store: ClientStore<ChatStoreState> | null } = {
    store: null,
  };
  const doPersist = (chatId: string): void => {
    if (disposed) return;
    const thread = holder.store?.getState().threads[chatId];
    if (!thread) {
      return;
    }
    const args: PersistChatTabSettingsArgs = {
      chatId,
      scope: thread.route?.scope,
      workspaceLocalId: thread.route?.workspaceLocalId,
      worktreeLocalId: thread.route?.worktreeLocalId,
      settings: {
        planMode: thread.planMode,
        proposalMode: thread.proposalMode,
        thinkingLevel: thread.thinkingLevel,
        pendingPlanExit: thread.pendingPlanExit,
      },
    };
    // Best-effort: a failed persist must not crash the store. The adopt ticket
    // wires real error surfacing; until then the adapters are inert.
    const lifetime = storeLifetime;
    const persistEpoch = persistEpochs.get(chatId) ?? 0;
    inFlightPersistCounts.set(
      chatId,
      (inFlightPersistCounts.get(chatId) ?? 0) + 1,
    );
    const settled = (): void => {
      if (
        disposed ||
        lifetime !== storeLifetime ||
        persistEpoch !== (persistEpochs.get(chatId) ?? 0)
      ) {
        return;
      }
      const count = inFlightPersistCounts.get(chatId) ?? 0;
      if (count <= 1) inFlightPersistCounts.delete(chatId);
      else inFlightPersistCounts.set(chatId, count - 1);
      triggerCleanup?.(chatId);
    };
    try {
      const persist = client.command('chat.persistTabSettings', args);
      void Promise.resolve(persist).then(settled, settled);
    } catch {
      settled();
    }
  };

  const cancelPersist = (chatId: string): void => {
    const timer = persistTimers.get(chatId);
    if (timer !== undefined) {
      clearTimeout(timer);
      persistTimers.delete(chatId);
    }
  };

  const schedulePersist = (chatId: string): void => {
    cancelPersist(chatId);
    const timer = setTimeout(() => {
      persistTimers.delete(chatId);
      doPersist(chatId);
    }, PERSIST_DEBOUNCE_MS);
    persistTimers.set(chatId, timer);
  };

  const store: ClientStore<ChatStoreState> = create<ChatStoreState>(
    (rawSet, get) => {
      const isRetained = (chatId: string): boolean =>
        (interestHandlesByChatId.get(chatId)?.size ?? 0) > 0;

      const isEligibleForEviction = (
        state: ChatStoreState,
        chatId: string,
      ): boolean => {
        const thread = state.threads[chatId];
        if (
          !thread ||
          isRetained(chatId) ||
          thread.status === 'streaming' ||
          thread.turnActive ||
          thread.queuedMessages.length > 0 ||
          optimisticRaiseOwners.has(chatId) ||
          optimisticSendBindings.has(chatId) ||
          hasOptimisticMessage(thread.messages) ||
          persistTimers.has(chatId) ||
          (inFlightPersistCounts.get(chatId) ?? 0) > 0
        ) {
          return false;
        }
        // Few ids are referenced at a time; look them up in the cached index
        // instead of walking the transcript on every streaming frame.
        if (externallyReferencedMessageIds.size === 0) return true;
        const index = indexMessages(thread.messages);
        for (const messageId of Array.from(
          externallyReferencedMessageIds.keys(),
        )) {
          if (index.has(messageId)) return false;
        }
        return true;
      };

      const applyThreadGenerations = (
        state: ChatStoreState,
        chatIds: readonly string[],
      ): ChatStoreState => {
        let threads: Record<string, ChatThreadState> | null = null;
        for (const chatId of chatIds) {
          const generation = residencyGenerations.get(chatId) ?? 0;
          const thread = (threads ?? state.threads)[chatId];
          if (
            thread &&
            generation > 0 &&
            thread.residencyGeneration !== generation
          ) {
            threads ??= { ...state.threads };
            threads[chatId] = { ...thread, residencyGeneration: generation };
          }
        }
        return threads ? { ...state, threads } : state;
      };

      const noteResidencyMutation = (
        previous: ChatStoreState,
        next: ChatStoreState,
        chatIds: readonly string[],
      ): void => {
        for (const chatId of chatIds) {
          const thread = next.threads[chatId];
          if (!thread) {
            removeResidencyCandidate(chatId);
          } else if (isRetained(chatId)) {
            removeResidencyCandidate(chatId);
          } else if (!previous.threads[chatId]) {
            addReleasedMru(chatId);
          } else if (
            !releasedMruIds.has(chatId) &&
            threadHasTranscript(thread)
          ) {
            partialResidents.add(chatId);
          }
        }
      };

      const cleanupEvictedThreads = (state: ChatStoreState): ChatStoreState => {
        if (disposed) return state;
        if (
          releasedMru.length <= CHAT_THREAD_RELEASED_ALLOWANCE &&
          partialResidents.size === 0 &&
          protectedResidents.size === 0
        ) {
          return state;
        }

        let nextState = state;
        let threads: Record<string, ChatThreadState> | null = null;
        const stateThread = (chatId: string): ChatThreadState | undefined =>
          (threads ?? nextState.threads)[chatId];
        const evict = (chatId: string): void => {
          const thread = stateThread(chatId);
          if (!thread || !threadHasTranscript(thread)) return;
          const generation = bumpResidencyGeneration(chatId);
          const semanticTimer = semanticTimers.get(chatId);
          if (semanticTimer !== undefined) clearTimeout(semanticTimer);
          semanticTimers.delete(chatId);
          repairedSemanticSignatures.delete(chatId);
          lastAuthoritativeArrivalAt.delete(chatId);
          consumedBindingEchoes.delete(chatId);
          caches.delete(chatId);
          threads ??= { ...nextState.threads };
          threads[chatId] = {
            ...thread,
            messages: [],
            turnGroups: [],
            historyIncomplete: true,
            residencyGeneration: generation,
          };
        };

        const priorMru = releasedMru.slice();
        releasedMru.length = 0;
        releasedMruIds.clear();
        let eligibleResidents = 0;
        for (const chatId of priorMru) {
          const thread = stateThread(chatId);
          if (!thread || isRetained(chatId) || !threadHasTranscript(thread)) {
            protectedResidents.delete(chatId);
            continue;
          }
          if (!isEligibleForEviction(nextState, chatId)) {
            releasedMru.push(chatId);
            releasedMruIds.add(chatId);
            protectedResidents.add(chatId);
            continue;
          }
          if (eligibleResidents < CHAT_THREAD_RELEASED_ALLOWANCE) {
            eligibleResidents += 1;
            releasedMru.push(chatId);
            releasedMruIds.add(chatId);
            protectedResidents.delete(chatId);
            continue;
          }
          evict(chatId);
          protectedResidents.delete(chatId);
          partialResidents.delete(chatId);
        }

        for (const chatId of Array.from(partialResidents)) {
          const thread = stateThread(chatId);
          if (!thread || isRetained(chatId) || !threadHasTranscript(thread)) {
            partialResidents.delete(chatId);
            protectedResidents.delete(chatId);
            continue;
          }
          if (!isEligibleForEviction(nextState, chatId)) {
            protectedResidents.add(chatId);
            continue;
          }
          evict(chatId);
          partialResidents.delete(chatId);
          protectedResidents.delete(chatId);
        }

        if (threads) nextState = { ...nextState, threads };
        return nextState;
      };

      const processUpdate = (
        previous: ChatStoreState,
        next: ChatStoreState,
        touchedChatIds: readonly string[],
      ): ChatStoreState => {
        if (disposed) return next;
        const withGenerations = applyThreadGenerations(next, touchedChatIds);
        noteResidencyMutation(previous, withGenerations, touchedChatIds);
        for (const chatId of touchedChatIds) {
          if (!releasedMruIds.has(chatId) && !partialResidents.has(chatId)) {
            continue;
          }
          if (isEligibleForEviction(withGenerations, chatId)) {
            protectedResidents.delete(chatId);
          } else {
            protectedResidents.add(chatId);
          }
        }
        return cleanupEvictedThreads(withGenerations);
      };

      const commit = (): void => {
        const next = pending;
        pending = undefined;
        if (next) {
          const touched = Array.from(pendingTouchedChatIds).reverse();
          pendingTouchedChatIds.clear();
          rawSet(processUpdate(get(), next, touched));
        }
      };
      const set = (
        update: (state: ChatStoreState) => Partial<ChatStoreState>,
        touchedChatIds: readonly string[] = [],
      ): void => {
        if (chatBatchDepth === 0) {
          const previous = get();
          const patch = update(previous);
          const next =
            patch === previous ? previous : { ...previous, ...patch };
          rawSet(processUpdate(previous, next, touchedChatIds));
          return;
        }
        const previous = pending ?? get();
        const patch = update(previous);
        pending = patch === previous ? previous : { ...previous, ...patch };
        for (const chatId of touchedChatIds) pendingTouchedChatIds.add(chatId);
        pendingChatCommits.add(commit);
      };
      const patchThread = (
        chatId: string,
        patch: Partial<ChatThreadState>,
        markSettingsSeeded = false,
      ): void => {
        set(
          (state) => {
            const prev = state.threads[chatId] ?? emptyThread(chatId);
            return {
              threads: { ...state.threads, [chatId]: { ...prev, ...patch } },
              ...(markSettingsSeeded
                ? {
                    seededSettingsChatIds: {
                      ...(state.seededSettingsChatIds ?? {}),
                      [chatId]: true as const,
                    },
                  }
                : {}),
            };
          },
          [chatId],
        );
      };

      triggerCleanup = (chatId): void => {
        set((state) => state, [chatId]);
      };

      return {
        threads: {},
        seededSettingsChatIds: {},

        retainThread(chatId): () => void {
          if (disposed) return (): void => {};
          const handle: ThreadHandle = { chatId, live: true };
          const handles =
            interestHandlesByChatId.get(chatId) ?? new Set<ThreadHandle>();
          handles.add(handle);
          interestHandlesByChatId.set(chatId, handles);
          removeResidencyCandidate(chatId);
          return (): void => {
            if (!handle.live) return;
            handle.live = false;
            if (disposed) return;
            const currentHandles = interestHandlesByChatId.get(handle.chatId);
            currentHandles?.delete(handle);
            if (currentHandles?.size === 0) {
              interestHandlesByChatId.delete(handle.chatId);
              const current = pending ?? holder.store?.getState() ?? get();
              const thread = current.threads[handle.chatId];
              if (thread && threadHasTranscript(thread)) {
                addReleasedMru(handle.chatId);
              }
            }
            set((state) => state, [handle.chatId]);
          };
        },

        getResidencyGeneration(chatId): number {
          return residencyGenerations.get(chatId) ?? 0;
        },

        hydrate(chatId, messages, options): void {
          const arrivalSeq = ++authoritativeSeq;
          let authoritativeContentChanged = false;
          const hasStaleGeneration =
            options?.residencyGeneration !== undefined &&
            options.residencyGeneration !==
              (residencyGenerations.get(chatId) ?? 0);
          const claim = transcriptOwners.get(chatId);
          const claimedElsewhere =
            claim !== undefined && claim !== options?.transcriptOwner;
          const fenceTranscript =
            claimedElsewhere || (hasStaleGeneration && !isRetained(chatId));
          const hydrationMessages = fenceTranscript ? [] : messages;
          const replaceMessages = fenceTranscript
            ? false
            : options?.replaceMessages;
          const clearsIncompleteHistory =
            !hasStaleGeneration &&
            !claimedElsewhere &&
            (messages.length > 0 || options?.replaceMessages === true);
          set(
            (state) => {
              // Dedupe by messageId (last-wins) before ordering: snapshot inputs can
              // legitimately carry the same logical message twice (e.g. a cached
              // live frame plus its history re-push), and rendering both would
              // duplicate transcript rows. Live ingest already upserts by id;
              // hydrate must apply the same identity rule.
              const byId = new Map<string, PortalChatMessage>();
              for (const message of hydrationMessages) {
                byId.set(
                  message.messageId,
                  retainMessageMetadata(message, byId.get(message.messageId)),
                );
              }
              const prev = state.threads[chatId] ?? emptyThread(chatId);
              const previousById = new Map(
                prev.messages.map((message) => [message.messageId, message]),
              );
              const owner = optimisticRaiseOwners.get(chatId);
              const ownedOptimistic = owner
                ? prev.messages.find(
                    (message) =>
                      message.messageId === owner.localId &&
                      isOptimisticMessage(message),
                  )
                : undefined;
              const binding = optimisticSendBindings.get(chatId);
              const incoming = Array.from(byId.values()).map((message) => {
                const previous =
                  previousById.get(message.messageId) ??
                  (message.role === 'user' &&
                  binding?.userMessageId === message.messageId
                    ? previousById.get(binding.optimisticLocalId)
                    : message.role === 'user' &&
                        message.attachments === undefined
                      ? prev.messages.find(
                          (candidate) =>
                            isOptimisticMessage(candidate) &&
                            hasAuthoritativeMatch(
                              withoutConsumedEchoes(chatId, [message]),
                              candidate,
                            ),
                        )
                      : undefined);
                return retainMessageMetadata(message, previous);
              });
              const authoritativeIncoming = incoming.filter(
                (message) => !isOptimisticMessage(message),
              );
              // Identity-bound reconcile (bindOptimisticSend): a snapshot carrying
              // the bound authoritative echo supersedes the bound optimistic row
              // regardless of the text-skew window, consuming the binding.
              const boundEcho = binding
                ? authoritativeIncoming.find(
                    (message) =>
                      message.role === 'user' &&
                      message.messageId === binding.userMessageId,
                  )
                : undefined;
              if (binding && boundEcho) {
                removeOptimisticBinding(chatId);
                rememberConsumedEcho(chatId, boundEcho);
              }
              // A consumed bound echo is excluded from EVERY text-skew match —
              // including the raise-owner reconciliation below: when the bound
              // row is not the owner (two same-text in-flight sends), letting the
              // consumed echo text-match the surviving send would rebind its turn
              // lifecycle onto the wrong turn. The bound-is-owner case is handled
              // explicitly by the first branch.
              const textMatchCandidates = withoutConsumedEchoes(
                chatId,
                authoritativeIncoming,
                boundEcho,
              );
              const reconcilesOwnedOptimistic =
                ownedOptimistic !== undefined &&
                hasAuthoritativeMatch(textMatchCandidates, ownedOptimistic);
              const authoritativeEcho = reconcilesOwnedOptimistic
                ? textMatchCandidates.find((message) =>
                    hasAuthoritativeMatch([message], ownedOptimistic),
                  )
                : undefined;
              if (
                owner &&
                boundEcho &&
                binding?.optimisticLocalId === owner.localId
              ) {
                updateOptimisticOwnerTurnId(owner, boundEcho.messageId);
              } else if (owner && authoritativeEcho) {
                updateOptimisticOwnerTurnId(owner, authoritativeEcho.messageId);
              }
              if (owner?.turnUserMessageId.startsWith(OPTIMISTIC_ID_PREFIX)) {
                const streamingTimers = authoritativeIncoming
                  .filter(
                    (message) =>
                      message.status === 'streaming' &&
                      turnTimerUserMessageId(message) !== undefined &&
                      isNewOrSupersedingMessage(
                        previousById.get(message.messageId),
                        message,
                      ),
                  )
                  .sort((a, b) => messageRevision(a) - messageRevision(b));
                const newestStreamingTimer =
                  streamingTimers[streamingTimers.length - 1];
                const timerUserMessageId = newestStreamingTimer
                  ? turnTimerUserMessageId(newestStreamingTimer)
                  : undefined;
                if (timerUserMessageId) {
                  updateOptimisticOwnerTurnId(owner, timerUserMessageId);
                }
              }
              const endsOwnedTurn = authoritativeIncoming.some(
                (message) =>
                  isNewOrSupersedingMessage(
                    previousById.get(message.messageId),
                    message,
                  ) &&
                  ((isTerminalTurnTimerFrame(message) &&
                    turnTimerUserMessageId(message) ===
                      owner?.turnUserMessageId) ||
                    (message.role === 'assistant' &&
                      message.status === 'failed')),
              );
              const suppliesAuthoritativeRuntimeState =
                options?.status !== undefined ||
                options?.error !== undefined ||
                options?.turnActive !== undefined;
              // Preserve optimistic rows until history confirms them. Same-id live
              // rows stay below unless history carries a newer revision, so a late
              // prefix cannot rewind the live tail. The identity-bound row is
              // confirmed by its bound echo regardless of skew; other optimistic
              // rows match against `textMatchCandidates` (bound echo excluded,
              // see above).
              const retained = prev.messages.filter(
                (message) =>
                  !isOptimisticMessage(message) ||
                  (!hasAuthoritativeMatch(textMatchCandidates, message) &&
                    !(
                      boundEcho !== undefined &&
                      message.messageId === binding?.optimisticLocalId
                    )),
              );
              const mergedById = new Map(
                retained.map((message) => [message.messageId, message]),
              );
              // Same clientRequestId = same user message: the cloud send path
              // echoes it under a client-minted id while a later hydrate carries
              // the canonical uuid. Unify onto the incoming (canonical) identity
              // so future refetches keep matching one row instead of duplicating.
              const retainedUserIdByClientRequestId = new Map<string, string>();
              for (const message of retained) {
                if (
                  message.role === 'user' &&
                  !isOptimisticMessage(message) &&
                  message.clientRequestId !== undefined
                ) {
                  retainedUserIdByClientRequestId.set(
                    message.clientRequestId,
                    message.messageId,
                  );
                }
              }
              const replacements: PortalChatMessage[] = [];
              for (const message of incoming) {
                const existing = mergedById.get(message.messageId);
                if (!existing) {
                  const echoId =
                    message.role === 'user' &&
                    !isOptimisticMessage(message) &&
                    message.clientRequestId !== undefined
                      ? retainedUserIdByClientRequestId.get(
                          message.clientRequestId,
                        )
                      : undefined;
                  const withAttachments = retainMessageMetadata(
                    message,
                    echoId === undefined ? undefined : mergedById.get(echoId),
                  );
                  if (echoId !== undefined && echoId !== message.messageId) {
                    mergedById.delete(echoId);
                  }
                  mergedById.set(message.messageId, withAttachments);
                } else if (supersedesCachedMessage(existing, message)) {
                  mergedById.set(
                    message.messageId,
                    retainMessageMetadata(message, existing),
                  );
                  if (
                    messageRevision(message) >=
                    (prev.lastEventAt ?? Number.NEGATIVE_INFINITY)
                  ) {
                    replacements.push(message);
                  }
                } else if (
                  messageRevision(message) === messageRevision(existing)
                ) {
                  mergedById.set(
                    message.messageId,
                    refreshPresentationOrder(
                      retainMessageMetadata(existing, message),
                      message,
                    ),
                  );
                }
              }
              const merged = replaceMessages
                ? incoming.map((message) =>
                    retainMessageMetadata(
                      message,
                      mergedById.get(message.messageId),
                    ),
                  )
                : Array.from(mergedById.values());
              // REG-2981: an accepted queue row names the host user-message id it
              // stands for. When this tab bound an optimistic bubble to that id,
              // the row supersedes the bubble — drop it so a queued send has
              // exactly one representation instead of bubble plus queue entry.
              // The match is on that exact id, so an in-flight outbox row (which
              // supersedes nothing) keeps rendering normally.
              const supersededOptimisticId =
                binding !== undefined &&
                (options?.queuedMessages ?? []).some(
                  (message) =>
                    message.supersedesUserMessageId === binding.userMessageId,
                )
                  ? binding.optimisticLocalId
                  : undefined;
              if (supersededOptimisticId !== undefined) {
                removeOptimisticBinding(chatId);
              }
              const shown =
                supersededOptimisticId === undefined
                  ? merged
                  : merged.filter(
                      (message) => message.messageId !== supersededOptimisticId,
                    );
              // Only while another writer claims the transcript or echoes are held.
              const withHeldEchoes = (): PortalChatMessage[] => {
                const announced = new Set(
                  prev.queuedMessages.flatMap(
                    (message) => message.supersedesUserMessageId ?? [],
                  ),
                );
                const stillQueued = new Set(
                  (options?.queuedMessages ?? prev.queuedMessages).flatMap(
                    (message) => message.supersedesUserMessageId ?? [],
                  ),
                );
                const echoes = claimedElsewhere
                  ? messages.filter(
                      (message) =>
                        message.role === 'user' &&
                        announced.has(message.messageId) &&
                        !stillQueued.has(message.messageId),
                    )
                  : [];
                // shortcut: an echo lands on a user row with its text written from
                // the send on, since a queued send's row is written when it runs; a
                // repeated identical prompt can match early. Upgrade when the
                // claimant's row names the send.
                const ownerIds = new Set(
                  hydrationMessages.map((message) => message.messageId),
                );
                const wasHeld = heldEchoes.get(chatId) ?? [];
                const echoIds = new Set(
                  [...wasHeld, ...echoes].map((echo) => echo.messageId),
                );
                // REST joins a prompt's text parts with blank lines, Core's
                // transcript with none: compare without whitespace.
                const words = (text: string): string =>
                  text.replace(/\s+/g, '');
                // Only the claimant's rows land an echo, never another echo.
                const landed = (echo: PortalChatMessage): boolean =>
                  ownerIds.has(echo.messageId) ||
                  shown.some(
                    (message) =>
                      !echoIds.has(message.messageId) &&
                      message.role === 'user' &&
                      !isOptimisticMessage(message) &&
                      words(message.text) === words(echo.text) &&
                      message.createdAtMs >=
                        echo.createdAtMs - RECONCILE_SKEW_MS,
                  );
                const held = [...echoes, ...wasHeld].filter(
                  (echo, index, all) =>
                    all.findIndex(
                      (each) => each.messageId === echo.messageId,
                    ) === index && !landed(echo),
                );
                if (held.length > 0) heldEchoes.set(chatId, held);
                else heldEchoes.delete(chatId);
                // A held echo stands for its send, so a bubble it matches goes.
                return [
                  ...held.reduce(
                    (rows, echo) => reconcileOptimistic(rows, echo),
                    shown.filter(
                      (message) =>
                        !echoIds.has(message.messageId) ||
                        ownerIds.has(message.messageId),
                    ),
                  ),
                  ...held,
                ];
              };
              const ordered = orderMessages(
                claimedElsewhere || heldEchoes.has(chatId)
                  ? withHeldEchoes()
                  : shown,
              );
              const messagesUnchanged =
                ordered.length === prev.messages.length &&
                ordered.every(
                  (message, index) => message === prev.messages[index],
                );
              authoritativeContentChanged =
                state.threads[chatId] === undefined || !messagesUnchanged;
              let hydratedState = prev;
              const lifecycleAdditions = owner
                ? authoritativeIncoming.filter(
                    (message) =>
                      ((isTurnTimerFrame(message) &&
                        turnTimerUserMessageId(message) ===
                          owner.turnUserMessageId) ||
                        (message.role === 'assistant' &&
                          message.status === 'failed')) &&
                      isNewOrSupersedingMessage(
                        previousById.get(message.messageId),
                        message,
                      ) &&
                      !replacements.includes(message),
                  )
                : [];
              const runtimeFrames = [...replacements, ...lifecycleAdditions]
                .filter(
                  (message) =>
                    !owner ||
                    !isTurnTimerFrame(message) ||
                    turnTimerUserMessageId(message) === owner.turnUserMessageId,
                )
                .sort((a, b) => messageRevision(a) - messageRevision(b));
              for (const message of runtimeFrames) {
                hydratedState = {
                  ...hydratedState,
                  ...deriveStatus(hydratedState, message),
                };
              }
              // Host activity starts and settles a turn independently of rows:
              // the final assistant revision may arrive after the host settles.
              // Transcript-only hydration leaves the live status unchanged.
              // Explicit host status and existing failures still take priority.
              let hostActivityStatus = hydratedState.status;
              if (
                options?.turnActive !== undefined &&
                hydratedState.status !== 'error'
              ) {
                hostActivityStatus = options.turnActive ? 'streaming' : 'idle';
              }
              const status = options?.status ?? hostActivityStatus;
              const error =
                options?.status !== undefined
                  ? (options.error ?? null)
                  : (options?.error ?? hydratedState.error);
              const turnActive =
                options?.turnActive ?? hydratedState.turnActive;
              if (
                owner &&
                arrivalSeq > owner.baselineSeq &&
                (endsOwnedTurn || suppliesAuthoritativeRuntimeState)
              ) {
                removeOptimisticOwner(chatId);
              }
              // The superseded bubble also held this thread's optimistic runtime
              // raise (status/turnActive), which is what shows Stop in the
              // composer. Release it with the bubble: the later ACK rollback
              // returns early once the bubble is gone, and the authoritative
              // RUNNING/terminal frames carry the canonical id, so neither would
              // ever clear a stale owner. Read after the authoritative-state
              // branch above, so this only fires when nothing else cleared it.
              const supersededOwner =
                supersededOptimisticId === undefined
                  ? undefined
                  : optimisticRaiseOwners.get(chatId);
              const supersededBaseline =
                supersededOwner !== undefined &&
                supersededOwner.localId === supersededOptimisticId
                  ? supersededOwner.baseline
                  : undefined;
              if (supersededBaseline !== undefined) {
                removeOptimisticOwner(chatId);
              }
              const queuedMessages =
                options?.queuedMessages ?? prev.queuedMessages;
              const requestedWaitingDelegationIds =
                options?.waitingDelegationIds;
              const waitingDelegationIds =
                requestedWaitingDelegationIds === undefined ||
                sameStringArray(
                  prev.waitingDelegationIds,
                  requestedWaitingDelegationIds,
                )
                  ? prev.waitingDelegationIds
                  : requestedWaitingDelegationIds;
              const inputDelivery =
                options?.inputDelivery ?? prev.inputDelivery;
              const steeringCapabilities =
                options !== undefined &&
                Object.prototype.hasOwnProperty.call(
                  options,
                  'steeringCapabilities',
                )
                  ? options.steeringCapabilities
                  : prev.steeringCapabilities;
              const route = options?.route
                ? prev.route &&
                  prev.route.scope === options.route.scope &&
                  prev.route.workspaceLocalId ===
                    options.route.workspaceLocalId &&
                  prev.route.worktreeLocalId === options.route.worktreeLocalId
                  ? prev.route
                  : options.route
                : prev.route;
              const planMode = options?.settings?.planMode ?? prev.planMode;
              const proposalMode =
                options?.settings?.proposalMode ?? prev.proposalMode;
              const thinkingLevel =
                options?.settings?.thinkingLevel ?? prev.thinkingLevel;
              const pendingPlanExit = options?.settings
                ? options.settings.pendingPlanExit
                : prev.pendingPlanExit;

              // Snapshot arrays are rebuilt whenever the portal projection changes,
              // including unrelated chats. If neither the transcript nor explicit
              // host state changed, retain every existing reference so a frame for
              // another chat cannot defeat incremental rendering.
              if (
                messagesUnchanged &&
                status === prev.status &&
                error === prev.error &&
                turnActive === prev.turnActive &&
                queuedMessages === prev.queuedMessages &&
                waitingDelegationIds === prev.waitingDelegationIds &&
                inputDelivery === prev.inputDelivery &&
                steeringCapabilities === prev.steeringCapabilities &&
                route === prev.route &&
                planMode === prev.planMode &&
                proposalMode === prev.proposalMode &&
                thinkingLevel === prev.thinkingLevel &&
                pendingPlanExit === prev.pendingPlanExit &&
                (!clearsIncompleteHistory || prev.historyIncomplete !== true)
              ) {
                return state;
              }

              let turnGroups = prev.turnGroups;
              if (!messagesUnchanged || turnActive !== prev.turnActive) {
                // Older history can be inserted before completed groups, so a
                // transcript change resets the cache. An activity-only change
                // reuses it while recomputing the latest group's fold state.
                const cache = cacheFor(chatId);
                if (!messagesUnchanged) {
                  cache.chatId = '';
                  cache.completedGroups = new Map();
                }
                turnGroups = computeIncrementalTurnGroups(
                  chatId,
                  messagesUnchanged ? prev.messages : ordered,
                  cache,
                  turnActive,
                );
              }
              const {
                historyIncomplete: previousHistoryIncomplete,
                ...completeHistoryPrev
              } = prev;
              const threadBase = clearsIncompleteHistory
                ? completeHistoryPrev
                : prev;
              const thread: ChatThreadState = {
                ...threadBase,
                messages: messagesUnchanged ? prev.messages : ordered,
                turnGroups,
                status,
                error,
                turnActive,
                queuedMessages,
                waitingDelegationIds,
                inputDelivery,
                steeringCapabilities,
                route,
                planMode,
                proposalMode,
                thinkingLevel,
                pendingPlanExit,
                ...(!clearsIncompleteHistory &&
                previousHistoryIncomplete === true
                  ? { historyIncomplete: true as const }
                  : {}),
                ...(supersededBaseline ?? {}),
              };
              return { threads: { ...state.threads, [chatId]: thread } };
            },
            [chatId],
          );
          if (authoritativeContentChanged) {
            const currentThread = holder.store?.getState().threads[chatId];
            if (
              currentThread?.historyIncomplete === true &&
              !threadHasTranscript(currentThread)
            ) {
              lastAuthoritativeArrivalAt.delete(chatId);
            } else {
              lastAuthoritativeArrivalAt.set(chatId, Date.now());
            }
            scheduleSemanticCheck(chatId);
          }
        },

        claimTranscript(chatId, owner): void {
          transcriptOwners.set(chatId, owner);
        },

        releaseTranscript(chatId, owner): void {
          if (transcriptOwners.get(chatId) !== owner) return;
          transcriptOwners.delete(chatId);
          // The host's own rows, held echoes included, flow again.
          heldEchoes.delete(chatId);
        },

        reset(chatId): void {
          consumedBindingEchoes.delete(chatId);
          heldEchoes.delete(chatId);
          cancelPersist(chatId);
          persistEpochs.set(chatId, (persistEpochs.get(chatId) ?? 0) + 1);
          inFlightPersistCounts.delete(chatId);
          bumpResidencyGeneration(chatId);
          removeResidencyCandidate(chatId);
          caches.delete(chatId);
          removeOptimisticOwner(chatId);
          removeOptimisticBinding(chatId);
          const semanticTimer = semanticTimers.get(chatId);
          if (semanticTimer !== undefined) clearTimeout(semanticTimer);
          semanticTimers.delete(chatId);
          repairedSemanticSignatures.delete(chatId);
          lastAuthoritativeArrivalAt.delete(chatId);
          set(
            (state) => {
              const hasThread = chatId in state.threads;
              const hasSeededSettings =
                state.seededSettingsChatIds?.[chatId] === true;
              if (!hasThread && !hasSeededSettings) {
                return state;
              }
              const threads = { ...state.threads };
              delete threads[chatId];
              const seededSettingsChatIds = {
                ...(state.seededSettingsChatIds ?? {}),
              };
              delete seededSettingsChatIds[chatId];
              return { threads, seededSettingsChatIds };
            },
            [chatId],
          );
        },

        ingestMessageEvent(event): void {
          if (transcriptOwners.has(event.chatId)) return;
          const isAuthoritative = !isOptimisticMessage(event.message);
          if (isAuthoritative) {
            lastAuthoritativeArrivalAt.set(event.chatId, Date.now());
          }
          const arrivalSeq = isAuthoritative
            ? ++authoritativeSeq
            : authoritativeSeq;
          set(
            (state) => {
              const { chatId } = event;
              const prev = state.threads[chatId] ?? emptyThread(chatId);
              const attachmentBinding = optimisticSendBindings.get(chatId);
              const attachmentSource =
                event.message.role === 'user' &&
                event.message.attachments === undefined
                  ? prev.messages.find(
                      (candidate) =>
                        candidate.messageId === event.message.messageId ||
                        (attachmentBinding?.userMessageId ===
                        event.message.messageId
                          ? candidate.messageId ===
                            attachmentBinding.optimisticLocalId
                          : isOptimisticMessage(candidate) &&
                            hasAuthoritativeMatch(
                              withoutConsumedEchoes(chatId, [event.message]),
                              candidate,
                            )),
                    )
                  : undefined;
              const message = retainMessageMetadata(
                event.message,
                attachmentSource,
              );
              const existingMessageIndex =
                indexMessages(prev.messages).get(message.messageId) ?? -1;
              const existingMessage =
                existingMessageIndex >= 0
                  ? prev.messages[existingMessageIndex]
                  : undefined;
              const owner = optimisticRaiseOwners.get(chatId);
              const ownedIndex = owner
                ? indexMessages(prev.messages).get(owner.localId)
                : undefined;
              const ownedMessage =
                ownedIndex === undefined
                  ? undefined
                  : prev.messages[ownedIndex];
              const ownedOptimistic =
                ownedMessage && isOptimisticMessage(ownedMessage)
                  ? ownedMessage
                  : undefined;
              if (
                owner?.turnUserMessageId.startsWith(OPTIMISTIC_ID_PREFIX) &&
                message.status === 'streaming' &&
                isNewOrSupersedingMessage(existingMessage, message)
              ) {
                const timerUserMessageId = turnTimerUserMessageId(message);
                if (timerUserMessageId) {
                  updateOptimisticOwnerTurnId(owner, timerUserMessageId);
                }
              }
              const advancesTurnLifecycle =
                isAuthoritative &&
                isAuthoritativeTurnLifecycleFrame(message) &&
                isNewOrSupersedingMessage(existingMessage, message) &&
                (!isTurnTimerFrame(message) ||
                  owner === undefined ||
                  turnTimerUserMessageId(message) === owner.turnUserMessageId);
              // Same clientRequestId = same user message: when a late echo arrives
              // after the canonical row already hydrated (under the server uuid),
              // keep that authoritative row instead of adding a second copy. The
              // canonical data and id survive so future refetches keep matching it.
              const requestDuplicateIndex =
                message.role === 'user' &&
                !isOptimisticMessage(message) &&
                message.clientRequestId !== undefined &&
                existingMessageIndex < 0
                  ? prev.messages.findIndex(
                      (candidate) =>
                        candidate.role === 'user' &&
                        !isOptimisticMessage(candidate) &&
                        candidate.clientRequestId === message.clientRequestId,
                    )
                  : -1;
              let messages =
                requestDuplicateIndex >= 0
                  ? upsertMessage(
                      prev.messages,
                      retainMessageMetadata(
                        prev.messages[requestDuplicateIndex],
                        message,
                      ),
                      requestDuplicateIndex,
                    )
                  : upsertMessage(prev.messages, message, existingMessageIndex);
              // An authoritative frame supersedes any matching optimistic echo.
              if (isAuthoritative && message.role === 'user') {
                // Identity-bound reconcile first (bindOptimisticSend): the frame
                // carrying the bound `userMessageId` removes the bound optimistic
                // row regardless of the text-skew window, consuming the binding.
                // The owner rebinding below then observes the removal exactly as
                // it does for a text-skew reconcile.
                const binding = optimisticSendBindings.get(chatId);
                const consumesBinding =
                  binding !== undefined &&
                  message.role === 'user' &&
                  message.messageId === binding.userMessageId;
                if (consumesBinding) {
                  removeOptimisticBinding(chatId);
                  rememberConsumedEcho(chatId, message);
                  messages = messages.filter(
                    (candidate) =>
                      candidate.messageId !== binding.optimisticLocalId ||
                      !isOptimisticMessage(candidate),
                  );
                } else {
                  // Text-skew fallback ONLY for frames that did not consume an
                  // identity binding: a bound echo has exactly one optimistic
                  // counterpart, and letting it also text-match would collapse a
                  // genuinely repeated identical send into it.
                  messages = reconcileOptimistic(messages, message);
                }
                const reconciledOwnedOptimistic =
                  ownedOptimistic !== undefined &&
                  !messages.some(
                    (candidate) => candidate.messageId === owner?.localId,
                  );
                if (owner && reconciledOwnedOptimistic) {
                  updateOptimisticOwnerTurnId(owner, message.messageId);
                }
              }
              const runtimeState =
                owner &&
                isTurnTimerFrame(message) &&
                turnTimerUserMessageId(message) !== owner.turnUserMessageId
                  ? {
                      status: prev.status,
                      error: prev.error,
                      turnActive: prev.turnActive,
                    }
                  : deriveStatus(prev, message);
              const { status, error, turnActive } = runtimeState;
              const turnGroups = computeIncrementalTurnGroups(
                chatId,
                messages,
                cacheFor(chatId),
                turnActive,
              );
              if (
                owner &&
                arrivalSeq > owner.baselineSeq &&
                advancesTurnLifecycle &&
                (isTerminalTurnTimerFrame(message) ||
                  (message.role === 'assistant' && message.status === 'failed'))
              ) {
                removeOptimisticOwner(chatId);
              }
              // Reuse the previous route object when the scope/ids are unchanged so
              // `thread.route` keeps referential identity across the streaming
              // frames of a turn (a downstream `React.memo` can then skip on it).
              const nextRoute: ChatRoute = {
                scope: event.scope,
                workspaceLocalId: event.workspaceLocalId,
                worktreeLocalId: event.worktreeLocalId,
              };
              const route =
                prev.route &&
                prev.route.scope === nextRoute.scope &&
                prev.route.workspaceLocalId === nextRoute.workspaceLocalId &&
                prev.route.worktreeLocalId === nextRoute.worktreeLocalId
                  ? prev.route
                  : nextRoute;
              const thread: ChatThreadState = {
                ...prev,
                chatId,
                messages,
                turnGroups,
                status,
                error,
                turnActive,
                lastEventAt: message.updatedAtMs ?? message.createdAtMs,
                route,
              };
              return { threads: { ...state.threads, [chatId]: thread } };
            },
            [event.chatId],
          );
          if (
            event.message.status !== 'streaming' ||
            isAuthoritativeTurnLifecycleFrame(event.message)
          )
            scheduleSemanticCheck(event.chatId);
        },

        addOptimisticUserMessage(chatId, args): void {
          set(
            (state) => {
              const prev = state.threads[chatId] ?? emptyThread(chatId);
              const optimistic = makeOptimisticUserMessage({ chatId, ...args });
              // Raise the working indicator at send time. The authoritative
              // `turn_timer` streaming frame only arrives after the full host
              // round trip (send command → desktop turn start → relay), and until
              // then the transcript showed no progress and the composer offered
              // Send instead of Stop — so follow-up sends silently queued behind
              // an invisible active turn. Terminal timer frames (or a failed
              // assistant frame) lower/replace this exactly as they do for an
              // authoritative raise.
              //
              // The inserted optimistic ID owns this temporary raise until a
              // post-baseline authoritative ingest/hydration takes over, or the
              // matching pre-host send rejection rolls it back. Ownership uses a
              // store-local arrival generation, never host/client timestamps.
              const raised: Pick<
                ChatThreadState,
                'status' | 'error' | 'turnActive'
              > = { status: 'streaming', error: null, turnActive: true };
              // Late-echo guard: if the authoritative frame already arrived (server
              // faster than the UI), inserting the echo now would strand it — its
              // reconciliation pass already ran against an empty optimistic set.
              // The turn is in flight either way, so the indicator still raises.
              // No `computeIncrementalTurnGroups` here: messages are unchanged on
              // this path, so only the runtime status fields are patched.
              const lateEchoCandidates = withoutConsumedEchoes(
                chatId,
                prev.messages,
              );
              if (hasAuthoritativeMatch(lateEchoCandidates, optimistic)) {
                const authoritativeEcho = lateEchoCandidates.find((message) =>
                  hasAuthoritativeMatch([message], optimistic),
                );
                putOptimisticOwner(chatId, {
                  localId: optimistic.messageId,
                  turnUserMessageId:
                    authoritativeEcho?.messageId ?? optimistic.messageId,
                  baselineSeq: authoritativeSeq,
                  baseline: {
                    status: prev.status,
                    error: prev.error,
                    turnActive: prev.turnActive,
                  },
                });
                return {
                  threads: {
                    ...state.threads,
                    [chatId]: { ...prev, ...raised },
                  },
                };
              }
              putOptimisticOwner(chatId, {
                localId: optimistic.messageId,
                turnUserMessageId: optimistic.messageId,
                baselineSeq: authoritativeSeq,
                baseline: {
                  status: prev.status,
                  error: prev.error,
                  turnActive: prev.turnActive,
                },
              });
              const messages = upsertMessage(prev.messages, optimistic);
              const turnGroups = computeIncrementalTurnGroups(
                chatId,
                messages,
                cacheFor(chatId),
                raised.turnActive,
              );
              return {
                threads: {
                  ...state.threads,
                  [chatId]: { ...prev, messages, turnGroups, ...raised },
                },
              };
            },
            [chatId],
          );
        },

        bindOptimisticSend(chatId, args): void {
          // Normalize exactly like `makeOptimisticUserMessage` so the binding
          // always names the inserted row's id, whatever form the host passed.
          const optimisticLocalId = normalizeOptimisticLocalId(
            args.optimisticLocalId,
          );
          // Latest binding per chat wins: a newer send's identity supersedes an
          // unconsumed older one (whose echo, if it ever lands, still reconciles
          // through the text-skew fallback or stays as authoritative history).
          putOptimisticBinding(chatId, {
            optimisticLocalId,
            userMessageId: args.userMessageId,
          });
          set((state) => state, [chatId]);
        },

        rollbackOptimisticSend(chatId, args): void {
          const optimisticLocalId = normalizeOptimisticLocalId(args.localId);
          // The abandoned send's identity binding dies with it — a late echo of
          // a rolled-back send must not delete a future send's optimistic row.
          // Scoped to the exact localId so a newer send's binding survives.
          const binding = optimisticSendBindings.get(chatId);
          if (binding?.optimisticLocalId === optimisticLocalId) {
            removeOptimisticBinding(chatId);
          }
          set(
            (state) => {
              const prev = state.threads[chatId];
              if (!prev) {
                return state;
              }
              const owner = optimisticRaiseOwners.get(chatId);
              if (owner?.localId !== optimisticLocalId) {
                return state;
              }
              const ownedOptimistic = prev.messages.find(
                (message) =>
                  message.messageId === optimisticLocalId &&
                  isOptimisticMessage(message),
              );
              if (!ownedOptimistic) {
                return state;
              }

              removeOptimisticOwner(chatId);
              const messages = prev.messages.filter(
                (message) => message.messageId !== optimisticLocalId,
              );
              const turnGroups = computeIncrementalTurnGroups(
                chatId,
                messages,
                cacheFor(chatId),
                owner.baseline.turnActive,
              );
              return {
                threads: {
                  ...state.threads,
                  [chatId]: {
                    ...prev,
                    messages,
                    turnGroups,
                    ...owner.baseline,
                  },
                },
              };
            },
            [chatId],
          );
        },

        adoptThread(sourceChatId, targetChatId): void {
          if (sourceChatId === targetChatId) {
            return;
          }
          const hadPendingPersist = persistTimers.has(sourceChatId);
          cancelPersist(sourceChatId);
          caches.delete(sourceChatId);
          removeResidencyCandidate(sourceChatId);
          const sourceHandles = interestHandlesByChatId.get(sourceChatId);
          if (sourceHandles?.size) {
            const targetHandles =
              interestHandlesByChatId.get(targetChatId) ??
              new Set<ThreadHandle>();
            for (const handle of Array.from(sourceHandles)) {
              handle.chatId = targetChatId;
              targetHandles.add(handle);
            }
            interestHandlesByChatId.set(targetChatId, targetHandles);
            interestHandlesByChatId.delete(sourceChatId);
          }
          if (isRetained(targetChatId)) removeResidencyCandidate(targetChatId);
          else addReleasedMru(targetChatId);
          // The send identity binding follows the thread (the App Advisor
          // first-send adoption): the echo will arrive under the canonical chat
          // id, so the binding must be waiting there. Latest-per-chat still
          // wins if the target already carried one.
          const carriedBinding = optimisticSendBindings.get(sourceChatId);
          if (carriedBinding) {
            removeOptimisticBinding(sourceChatId);
            putOptimisticBinding(targetChatId, carriedBinding);
          }
          const carriedConsumed = consumedBindingEchoes.get(sourceChatId);
          if (carriedConsumed?.length) {
            consumedBindingEchoes.delete(sourceChatId);
            const existing = consumedBindingEchoes.get(targetChatId) ?? [];
            consumedBindingEchoes.set(
              targetChatId,
              pruneConsumedEchoes([...existing, ...carriedConsumed]),
            );
          }
          set(
            (state) => {
              const source = state.threads[sourceChatId];
              if (!source) {
                return state;
              }
              const target =
                state.threads[targetChatId] ?? emptyThread(targetChatId);
              const sourceMessages = source.messages.map((message) =>
                message.chatId === targetChatId
                  ? message
                  : { ...message, chatId: targetChatId },
              );
              // Identify the bound echo FIRST: like ingest and hydrate, a
              // consumed bound echo is excluded from every text-skew match in
              // this merge — both the per-message reconcile and the owner
              // fallback below — so it can never collapse a second same-text
              // in-flight send during adoption.
              const binding = optimisticSendBindings.get(targetChatId);
              const boundEcho = binding
                ? target.messages.find(
                    (message) =>
                      !isOptimisticMessage(message) &&
                      message.role === 'user' &&
                      message.messageId === binding.userMessageId,
                  )
                : undefined;
              const targetConsumed = consumedEchoIdsFor(targetChatId);
              let messages = sourceMessages;
              for (const message of target.messages) {
                messages = upsertMessage(messages, message);
                if (
                  !isOptimisticMessage(message) &&
                  message !== boundEcho &&
                  !targetConsumed?.has(message.messageId)
                ) {
                  messages = reconcileOptimistic(messages, message);
                }
              }
              messages = orderMessages(messages);

              // Identity-bound reconcile against frames the target already holds:
              // when the canonical echo won the race and landed before adoption,
              // the bound optimistic row is superseded here regardless of skew.
              if (binding && boundEcho) {
                removeOptimisticBinding(targetChatId);
                rememberConsumedEcho(targetChatId, boundEcho);
                messages = messages.filter(
                  (message) =>
                    message.messageId !== binding.optimisticLocalId ||
                    !isOptimisticMessage(message),
                );
              }

              const owner = optimisticRaiseOwners.get(sourceChatId);
              if (owner) {
                const ownedOptimistic = sourceMessages.find(
                  (message) =>
                    message.messageId === owner.localId &&
                    isOptimisticMessage(message),
                );
                const authoritativeEcho =
                  (binding?.optimisticLocalId === owner.localId
                    ? boundEcho
                    : undefined) ??
                  (ownedOptimistic
                    ? target.messages.find(
                        (message) =>
                          message !== boundEcho &&
                          !targetConsumed?.has(message.messageId) &&
                          hasAuthoritativeMatch([message], ownedOptimistic),
                      )
                    : undefined);
                if (authoritativeEcho) {
                  updateOptimisticOwnerTurnId(
                    owner,
                    authoritativeEcho.messageId,
                  );
                } else if (
                  owner.turnUserMessageId.startsWith(OPTIMISTIC_ID_PREFIX)
                ) {
                  const streamingTimers = target.messages
                    .filter(
                      (message) =>
                        message.status === 'streaming' &&
                        turnTimerUserMessageId(message) !== undefined,
                    )
                    .sort((a, b) => messageRevision(a) - messageRevision(b));
                  const streamingTimer =
                    streamingTimers[streamingTimers.length - 1];
                  const timerUserMessageId = streamingTimer
                    ? turnTimerUserMessageId(streamingTimer)
                    : undefined;
                  if (timerUserMessageId) {
                    updateOptimisticOwnerTurnId(owner, timerUserMessageId);
                  }
                }
                removeOptimisticOwner(sourceChatId);
                const ownedTurnEnded = target.messages.some(
                  (message) =>
                    (isTerminalTurnTimerFrame(message) &&
                      turnTimerUserMessageId(message) ===
                        owner.turnUserMessageId) ||
                    (message.role === 'assistant' &&
                      message.status === 'failed'),
                );
                if (!ownedTurnEnded) {
                  putOptimisticOwner(targetChatId, owner);
                }
              }

              let runtimeState: Pick<
                ChatThreadState,
                'status' | 'error' | 'turnActive'
              > = {
                status: source.status,
                error: source.error,
                turnActive: source.turnActive,
              };
              for (const message of target.messages
                .slice()
                .sort((a, b) => messageRevision(a) - messageRevision(b))) {
                if (
                  owner &&
                  isTurnTimerFrame(message) &&
                  turnTimerUserMessageId(message) !== owner.turnUserMessageId
                ) {
                  continue;
                }
                runtimeState = deriveStatus(
                  { ...source, ...runtimeState },
                  message,
                );
              }

              const targetCache = cacheFor(targetChatId);
              targetCache.chatId = '';
              targetCache.completedGroups = new Map();
              const turnGroups = computeIncrementalTurnGroups(
                targetChatId,
                messages,
                targetCache,
                runtimeState.turnActive,
              );
              const thread: ChatThreadState = {
                ...target,
                chatId: targetChatId,
                messages,
                turnGroups,
                ...runtimeState,
                queuedMessages: target.queuedMessages,
                waitingDelegationIds: target.waitingDelegationIds,
                inputDelivery: target.inputDelivery,
                steeringCapabilities: target.steeringCapabilities,
                lastEventAt:
                  target.lastEventAt === undefined
                    ? source.lastEventAt
                    : source.lastEventAt === undefined
                      ? target.lastEventAt
                      : Math.max(target.lastEventAt, source.lastEventAt),
                planMode: source.planMode,
                proposalMode: source.proposalMode,
                thinkingLevel: source.thinkingLevel,
                pendingPlanExit: source.pendingPlanExit,
                route: target.route ?? source.route,
              };
              const threads = { ...state.threads, [targetChatId]: thread };
              delete threads[sourceChatId];
              const seededSettingsChatIds = {
                ...(state.seededSettingsChatIds ?? {}),
              };
              if (seededSettingsChatIds[sourceChatId]) {
                seededSettingsChatIds[targetChatId] = true;
              }
              delete seededSettingsChatIds[sourceChatId];
              return { threads, seededSettingsChatIds };
            },
            [sourceChatId, targetChatId],
          );
          if (hadPendingPersist) schedulePersist(targetChatId);
        },

        seedTabSettings(chatId, settings, options): void {
          if (
            options?.ifAbsent === true &&
            holder.store?.getState().seededSettingsChatIds?.[chatId]
          ) {
            return;
          }
          set((state) => ({
            seededSettingsChatIds: {
              ...(state.seededSettingsChatIds ?? {}),
              [chatId]: true,
            },
          }));
          // Restore path: apply persisted settings WITHOUT scheduling a persist —
          // echoing freshly-read values back through `chat.persistTabSettings`
          // would be a pointless round-trip (and on slow hosts could clobber a
          // newer edit made between read and echo).
          patchThread(chatId, {
            planMode: settings.planMode,
            proposalMode: settings.proposalMode,
            thinkingLevel: settings.thinkingLevel,
            ...(settings.pendingPlanExit !== undefined
              ? { pendingPlanExit: settings.pendingPlanExit }
              : {}),
          });
        },

        setPlanMode(chatId, planMode): void {
          patchThread(chatId, { planMode }, true);
          schedulePersist(chatId);
        },

        setProposalMode(chatId, proposalMode): void {
          patchThread(chatId, { proposalMode }, true);
          schedulePersist(chatId);
        },

        setThinkingLevel(chatId, thinkingLevel): void {
          patchThread(chatId, { thinkingLevel }, true);
          schedulePersist(chatId);
        },

        cycleThinkingLevel(chatId, providerType, supportedLevels): void {
          set(
            (state) => {
              const prev = state.threads[chatId] ?? emptyThread(chatId);
              const thinkingLevel = advanceThinkingLevel(
                prev.thinkingLevel,
                supportedLevels ?? providerFallbackThinkingLevels(providerType),
              );
              return {
                threads: {
                  ...state.threads,
                  [chatId]: { ...prev, thinkingLevel },
                },
                seededSettingsChatIds: {
                  ...(state.seededSettingsChatIds ?? {}),
                  [chatId]: true,
                },
              };
            },
            [chatId],
          );
          schedulePersist(chatId);
        },

        setPendingPlanExit(chatId, pendingPlanExit): void {
          patchThread(chatId, { pendingPlanExit }, true);
          schedulePersist(chatId);
        },

        flushPersist(chatId): void {
          cancelPersist(chatId);
          doPersist(chatId);
        },
      };
    },
  );
  holder.store = store;

  let unsubscribe: (() => void) | null = null;
  store[CLIENT_STORE_ACTIVATE] = (): void => {
    disposed = false;
    if (unsubscribe) return;
    unsubscribe = client.subscribe('chat.message', (event) => {
      store.getState().ingestMessageEvent(event);
    });
  };
  store[CLIENT_STORE_DISPOSE] = (): void => {
    disposed = true;
    storeLifetime += 1;
    unsubscribe?.();
    unsubscribe = null;
    persistTimers.forEach((timer) => clearTimeout(timer));
    persistTimers.clear();
    semanticTimers.forEach((timer) => clearTimeout(timer));
    semanticTimers.clear();
    repairedSemanticSignatures.clear();
    lastAuthoritativeArrivalAt.clear();
    optimisticRaiseOwners.clear();
    optimisticSendBindings.clear();
    consumedBindingEchoes.clear();
    transcriptOwners.clear();
    heldEchoes.clear();
    caches.clear();
    for (const handles of Array.from(interestHandlesByChatId.values())) {
      for (const handle of Array.from(handles)) handle.live = false;
    }
    interestHandlesByChatId.clear();
    releasedMru.length = 0;
    releasedMruIds.clear();
    partialResidents.clear();
    protectedResidents.clear();
    inFlightPersistCounts.clear();
    persistEpochs.clear();
    externallyReferencedMessageIds.clear();
  };

  return store;
}

/**
 * Selector hook for the shared chat store, bound to the ambient
 * {@link CanopyClient} from `CanopyClientProvider`.
 *
 * @example
 *   const thread = useChatStore((s) => s.threads[chatId]);
 */
const chatStoreKey = Symbol('chat-store');

export function useChatStoreApi(): ClientStore<ChatStoreState> {
  return useCanopyClientStore<ChatStoreState>(chatStoreKey, createChatStore);
}

export function useChatStore<TSelected>(
  selector: (state: ChatStoreState) => TSelected,
): TSelected {
  return useChatStoreApi()(selector);
}

/**
 * Whether the enclosing chat view is shown. Hosts that keep hidden panes
 * mounted provide `false` for them, so those panes stop retaining threads.
 */
export const ChatThreadVisibleContext = createContext(true);

/** Retain one chat transcript while the calling component is mounted and shown. */
export function useRetainChatThread(chatId: string | null | undefined): void {
  const store = useChatStoreApi();
  const visible = useContext(ChatThreadVisibleContext);
  useEffect(() => {
    if (!visible || chatId === null || chatId === undefined) return;
    return store.getState().retainThread(chatId);
  }, [chatId, store, visible]);
}

/** Retain a stable set of chat transcripts while enabled and shown. */
export function useRetainChatThreads(
  chatIds: readonly string[],
  enabled = true,
): void {
  const store = useChatStoreApi();
  const visible = useContext(ChatThreadVisibleContext);
  // Chat ids never contain NUL, so the joined key round-trips the stable set.
  const chatIdsKey =
    enabled && visible
      ? Array.from(new Set(chatIds)).sort().join('\u0000')
      : '';
  const heldRef = useRef(new Map<string, () => void>());
  useEffect(() => {
    const held = heldRef.current;
    const next = new Set(chatIdsKey === '' ? [] : chatIdsKey.split('\u0000'));
    // Retain additions before releasing departures, so a set change never
    // leaves a chat that is still shown unretained and evictable.
    for (const chatId of Array.from(next)) {
      if (!held.has(chatId))
        held.set(chatId, store.getState().retainThread(chatId));
    }
    for (const [chatId, release] of Array.from(held)) {
      if (next.has(chatId)) continue;
      held.delete(chatId);
      release();
    }
  }, [chatIdsKey, store]);
  useEffect(() => {
    const held = heldRef.current;
    return (): void => {
      for (const release of Array.from(held.values())) release();
      held.clear();
    };
  }, [store]);
}
