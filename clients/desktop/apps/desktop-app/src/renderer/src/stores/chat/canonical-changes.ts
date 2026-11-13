// Canonical committed-delta application (frontend plan, Phase 3).
//
// Applies materialized `ChatStateChange` values from a committed
// `ChatStateChangedEvent` to the renderer's per-scope projection. The
// changes carry canonical persisted shapes (tabs, messages, questions,
// runtime, archive summaries); the renderer converts them for display with
// the same converters hydration uses and derives only transient display data
// (todo lists, file-tab labels). No provider-event reduction, no synthetic
// lifecycle inference, and no persistence side effects happen here.

import type {
  ArchivedChatSummary,
  ChatRuntimeState,
  ChatStateChange,
  ChatTabMetadataPatch,
  PersistedChatMessage,
  PersistedPendingQuestion,
} from '@canopy/desktop-shared/types';
import { resolveProviderModelConfig } from '@canopy/desktop-shared/types';
import {
  overlayStreamBackedDelegationCard,
  type DelegatedAgentCallBlock,
} from '@canopy/agent-transcript';
import { stableStringify } from '@canopy/desktop-shared/lib/stable-hash';
import {
  mergeAgentModelConfig,
  readCodexSpeedRecord,
} from '@canopy/execution-engine/lib/codex-speed';
import {
  defineChatTabMetadataProperty,
  isSafeChatTabMetadataKey,
} from '@canopy/desktop-shared/chat-tab-metadata';
import {
  deriveCurrentTaskTodosFromMessages,
  deriveCurrentTodosFromMessages,
} from '@/lib/transcript-parser';
import { sanitizePersistedChatMessages } from '@/lib/chatMessageSanitization';
import { normalizePersistedUsage } from '@/lib/chatUsageNormalization';
import {
  beginTranscriptPerformanceStage,
  recordTranscriptPerformanceCounter,
} from '@/lib/transcript-performance';
import {
  preservePendingUserMessages,
  reconcilePendingTurn,
  reconcileQueueDispatch,
  presentDequeuedMessage,
  retireRemovedPendingTurn,
} from './optimistic-presentation';
import {
  codexSpeedFields,
  hasPendingLocalCodexSpeedWrite,
  recordCanonicalCodexSpeedWhilePending,
  tabRequestedCodexSpeed,
} from './codex-speed';
import {
  canKeepTranscriptWindowAfterReset,
  rebaseTranscriptWindow,
} from './transcript-reset';
import { fromPersistedTab, relabelFileTabs } from './persisted-tabs';
import { resolveTabProviderType } from './tab-utils';
import {
  preserveProvisionalFirstSendTitle,
  reconcileProvisionalTerminalFirstSend,
  cancelProvisionalFirstSendQueue,
  withdrawProvisionalFirstSendFromTab,
} from './provisional-first-send';
import {
  SENDING_LEASE_MS,
  type ChatTab,
  type DelegationStreamScopeHints,
  delegationStreamRunKey,
  type PendingQuestion,
  type SendingLease,
  type WorktreeChatState,
} from './types';

/** The per-scope projection pieces committed deltas may modify. */
export interface CanonicalScopeProjection {
  delegationStreamHints?: DelegationStreamScopeHints;
  chatState: WorktreeChatState;
  archives: ArchivedChatSummary[];
  runtimeByChatId: Record<string, ChatRuntimeState>;
  /** Global pending-question record (keyed by requestId). */
  pendingQuestions: Record<string, PendingQuestion>;
}

export interface CanonicalChangeContext {
  projectId: string;
  worktreeId: string;
}

/**
 * Map canonical runtime state onto the renderer tab status. A
 * completed/interrupted/cancelled/failed-terminal turn can never present a
 * stale Stop button; a live turn keeps streaming controls.
 */
export function chatRuntimeStatusToTabStatus(
  runtime: ChatRuntimeState,
): ChatTab['status'] {
  switch (runtime.status) {
    case 'starting':
    case 'streaming':
    case 'completing':
    case 'awaiting_input':
      return 'streaming';
    case 'failed':
      return 'error';
    case 'idle':
    case 'queued':
    case 'completed':
    case 'cancelled':
    case 'interrupted':
      return 'idle';
  }
}

/**
 * Main owns the empty-completion verdict end to end: it is set when a provider
 * reports success with no visible turn output, and cleared when late output
 * reconciles the same turn or a new turn starts. The renderer mirrors it and
 * never invents or expires it locally (CAN-2307).
 *
 * Shared by BOTH runtime→tab projections — the incremental `runtime.patched`
 * change and the snapshot install's `applyRuntimeStatusesToTabs`. They must agree:
 * a hydrate that skipped this would drop a live recovery notice on restart, and
 * a refresh that skipped it would keep a stale one after main reconciled the
 * turn, because `preserveRendererOnlyTabFields` carries the old value forward.
 *
 * Read only while the runtime is still `failed`, exactly as `error` is. Several
 * of main's reducer branches — the Codex non-terminal ones in particular —
 * return `{ ...base, status: 'streaming' }` and carry the settled turn's
 * `error`/`emptyCompletionRecovery` forward with it. That was always invisible
 * for `error`; without the same gate here the notice would offer Resume and Try
 * again on top of a chat that is visibly streaming.
 */
export function emptyCompletionRecoveryForRuntime(
  runtime: ChatRuntimeState,
): ChatTab['emptyCompletionRecovery'] {
  return runtime.status === 'failed' &&
    runtime.error?.code === 'empty_completion'
    ? runtime.emptyCompletionRecovery
    : undefined;
}

/**
 * A lease for a send, resume or hook start the renderer shows as starting
 * before canonical runtime reports it. It writes no tab status.
 */
export function createSendingLease(
  userMessageId: string,
  kind: SendingLease['kind'],
  now: number,
): SendingLease {
  return {
    userMessageId,
    kind,
    issuedAt: now,
    deadline: now + SENDING_LEASE_MS,
    state: 'pending',
  };
}

export function hasPendingSendingLease(
  tab: Pick<ChatTab, 'sendingLease'>,
  now: number,
): boolean {
  const lease = tab.sendingLease;
  return lease?.state === 'pending' && now < lease.deadline;
}

/**
 * Whether canonical runtime ends a lease: it shows the leased turn running
 * (acknowledged), or the chat failed or was cancelled after the lease was
 * issued. A settled status from before the send (the stopped turn a new
 * message follows) does not end it. A hook has no correlated user message, so
 * any running turn counts.
 */
function runtimeEndsSendingLease(
  lease: SendingLease,
  runtime: ChatRuntimeState,
): boolean {
  if (chatRuntimeStatusToTabStatus(runtime) === 'streaming') {
    const activeUserMessageId = runtime.activeTurn?.userMessageId;
    return (
      activeUserMessageId === undefined ||
      activeUserMessageId === lease.userMessageId ||
      lease.kind === 'hook'
    );
  }
  return (
    (runtime.status === 'failed' ||
      runtime.status === 'cancelled' ||
      runtime.status === 'interrupted') &&
    (runtime.lastActivityAt ?? 0) >= lease.issuedAt
  );
}

/** Drop the tab's lease when canonical runtime acknowledges or ends it. */
export function settleSendingLease(
  tab: ChatTab,
  runtime: ChatRuntimeState | undefined,
): ChatTab {
  if (
    !tab.sendingLease ||
    !runtime ||
    !runtimeEndsSendingLease(tab.sendingLease, runtime)
  ) {
    return tab;
  }
  const next = { ...tab };
  delete next.sendingLease;
  return next;
}

/** Drop one lease, if it is still the tab's lease. */
export function withoutSendingLease(
  tab: ChatTab,
  userMessageId: string,
): ChatTab {
  if (tab.sendingLease?.userMessageId !== userMessageId) return tab;
  const next = { ...tab };
  delete next.sendingLease;
  return next;
}

/**
 * Mark a lease that reached its deadline without an acknowledgement expired.
 * It stays on the tab as evidence of uncertain delivery until canonical
 * runtime or the command reply settles it, or a newer send replaces it.
 * Returns the same `worktreeChats` object when nothing changed.
 */
export function expireSendingLease(
  worktreeChats: Record<string, WorktreeChatState>,
  key: string,
  chatId: string,
  userMessageId: string,
  now: number,
): Record<string, WorktreeChatState> {
  const wc = worktreeChats[key];
  const tab = wc?.tabs.find((candidate) => candidate.id === chatId);
  const lease = tab?.sendingLease;
  if (
    !wc ||
    !lease ||
    lease.userMessageId !== userMessageId ||
    lease.state !== 'pending' ||
    now < lease.deadline
  ) {
    return worktreeChats;
  }
  const expired: SendingLease = { ...lease, state: 'expired' };
  return {
    ...worktreeChats,
    [key]: {
      ...wc,
      tabs: wc.tabs.map((candidate) =>
        candidate.id === chatId
          ? { ...candidate, sendingLease: expired }
          : candidate,
      ),
    },
  };
}

/**
 * Project canonical runtime state onto a batch of tabs, for the snapshot
 * install path (hydrate and refresh). The incremental `runtime.patched` change
 * below does the same thing one tab at a time; both live here so the two
 * cannot drift — a field mirrored in only one of them either never reaches a
 * freshly hydrated scope or never leaves a refreshed one.
 */
/**
 * Whether a runtime status ends a tab's pending turn. A turn that ended with
 * its prompt committed needs no provisional timer, even when no committed
 * timer row follows (cloud chats). The optimistic prompt sits in `messages`
 * from the send, so only its canonical echo (which leaves
 * `pendingUserMessages`) commits it; a stale idle before that keeps the
 * pending turn. A snapshot and a runtime patch apply the same rule.
 */
function pendingTurnStopped(
  tab: ChatTab,
  status: ReturnType<typeof chatRuntimeStatusToTabStatus>,
): boolean {
  const promptId = tab.pendingTurn?.userMessageId;
  if (promptId === undefined) return false;
  const promptCommitted =
    tab.messages.some((message) => message.id === promptId) &&
    !tab.pendingUserMessages?.some((message) => message.id === promptId);
  return (
    status === 'error' ||
    (status === 'idle' &&
      (tab.cancelRequestedByUser === true || promptCommitted))
  );
}

/** The tab without its pending turn and that turn's provisional timer. */
function withoutPendingTurn(tab: ChatTab): ChatTab {
  const timerId = tab.pendingTurn?.timerMessage.id;
  return {
    ...tab,
    pendingTurn: undefined,
    messages: tab.messages.filter((message) => message.id !== timerId),
  };
}

/**
 * The tab with its pending turn retired when its committed runtime has
 * ended it. Every path that can commit the prompt applies it: a runtime
 * patch, a snapshot, and a transcript page that carries the prompt's echo.
 */
export function retireFinishedPendingTurn(
  tab: ChatTab,
  runtime: ChatRuntimeState | undefined,
): ChatTab {
  return runtime !== undefined &&
    pendingTurnStopped(tab, chatRuntimeStatusToTabStatus(runtime))
    ? withoutPendingTurn(tab)
    : tab;
}

export function applyRuntimeStatusesToTabs(
  tabs: ChatTab[],
  runtimeByChatId: Record<string, ChatRuntimeState>,
): ChatTab[] {
  return tabs.map((current) => {
    const runtime = runtimeByChatId[current.id];
    if (!runtime) return current;
    const status = chatRuntimeStatusToTabStatus(runtime);
    const tab = retireFinishedPendingTurn(
      settleSendingLease(current, runtime),
      runtime,
    );
    const error = status === 'error' ? (runtime.error?.message ?? null) : null;
    const lastEventAt = latestChatActivityAt(
      tab.lastEventAt,
      runtime.lastActivityAt,
    );
    // A snapshot is the only way a scope learns about an empty-completion
    // verdict raised while it was unhydrated, and — because
    // `preserveRendererOnlyTabFields` carries the previous value forward on a
    // refresh — the only way a reconciled one gets retired (CAN-2307).
    const emptyCompletionRecovery = emptyCompletionRecoveryForRuntime(runtime);
    if (
      tab.status === status &&
      tab.error === error &&
      tab.lastEventAt === lastEventAt &&
      tab.emptyCompletionRecovery?.turnUserMessageId ===
        emptyCompletionRecovery?.turnUserMessageId
    ) {
      return tab;
    }
    const next: ChatTab = {
      ...tab,
      status,
      error,
      lastEventAt,
      ...(emptyCompletionRecovery ? { emptyCompletionRecovery } : {}),
    };
    if (!emptyCompletionRecovery) delete next.emptyCompletionRecovery;
    return next;
  });
}

/**
 * Activity timestamps are monotonic within a chat. A delayed canonical patch
 * or refresh may describe an earlier point in the same live turn than the
 * renderer has already observed; applying it verbatim can briefly resurrect
 * stale elapsed-time UI such as the stuck-agent warning.
 */
export function latestChatActivityAt(
  current: number | undefined,
  incoming: number | undefined,
): number | undefined {
  if (current === undefined) return incoming;
  if (incoming === undefined) return current;
  return Math.max(current, incoming);
}

/**
 * Renderer-only presentation fields carried over when a canonical tab payload
 * replaces an existing runtime tab. Canonical values always win for durable
 * fields; these are the transient fields the renderer legitimately owns
 * (composer attachments, local queue rows, live editing state).
 */
export function preserveRendererOnlyTabFields(
  previous: ChatTab | undefined,
  next: ChatTab,
): ChatTab {
  if (!previous) return next;
  const authoritativeMessages =
    next.transcriptLoaded === false ? [] : next.messages;

  if (next.transcriptLoaded === false) {
    // A body-less canonical tab (`messages: []`, not loaded) is metadata
    // only. The rows and the window stay authoritative in the renderer:
    // `message.upserted` keeps them current and `transcript.updated` moves
    // the revision. Dropping the window here would strip the turn frames from
    // rows that keep rendering, then discard every older page once the
    // reload replaced them. Carry the descriptor's revision onto the window
    // so an earlier-page request keeps matching main's expected revision.
    const nextRevision = next.transcript?.transcriptRevision;
    const window = previous.transcriptWindow;
    next = {
      ...next,
      messages: previous.messages,
      transcriptLoaded: previous.transcriptLoaded,
      transcriptWindow:
        window && nextRevision !== undefined
          ? {
              ...window,
              ...(previous.transcriptLoaded !== false
                ? { transcriptRevision: nextRevision }
                : {}),
              totalMessages:
                next.transcript?.messageCount ??
                next.transcript?.committedMessageCount ??
                window.totalMessages,
            }
          : window,
    };
  } else if (
    previous.transcriptWindow?.view === 'turns' &&
    previous.transcript?.transcriptRevision !== undefined &&
    previous.transcript.transcriptRevision ===
      next.transcript?.transcriptRevision
  ) {
    next = {
      ...next,
      messages: previous.messages,
      transcriptLoaded: previous.transcriptLoaded,
      transcriptWindow: previous.transcriptWindow,
    };
  }

  const preserved: ChatTab = {
    ...next,
    ...(previous.transcriptStale ? { transcriptStale: true } : {}),
    pendingUserMessages: previous.pendingUserMessages,
    pendingTurn: previous.pendingTurn,
    pendingQueueDispatch: previous.pendingQueueDispatch,
    pendingQueueMessages: previous.pendingQueueMessages,
    status: previous.status,
    error: previous.error,
    queuedMessages: previous.queuedMessages,
    ...(previous.queuedHookPlaceholder === true
      ? { queuedHookPlaceholder: true }
      : {}),
    ...(previous.queuedHookPlaceholder === true && previous.queuedHookInfo
      ? { queuedHookInfo: previous.queuedHookInfo }
      : {}),
    messages:
      previous.queuedHookPlaceholder === true
        ? previous.messages
        : next.messages,
    ...(previous.pendingAttachments
      ? { pendingAttachments: previous.pendingAttachments }
      : {}),
    ...(previous.editingQueuedMessageIndex !== undefined
      ? { editingQueuedMessageIndex: previous.editingQueuedMessageIndex }
      : {}),
    ...(previous.editingQueuedMessageFocusAllowed !== undefined
      ? {
          editingQueuedMessageFocusAllowed:
            previous.editingQueuedMessageFocusAllowed,
        }
      : {}),
    ...(previous.pendingQueuedMessageEditId !== undefined
      ? { pendingQueuedMessageEditId: previous.pendingQueuedMessageEditId }
      : {}),
    ...(previous.lastEventAt !== undefined
      ? { lastEventAt: previous.lastEventAt }
      : {}),
    ...(previous.deferredToolsReload
      ? { deferredToolsReload: previous.deferredToolsReload }
      : {}),
    ...(previous.recheckAfterWorktreeSetup !== undefined
      ? { recheckAfterWorktreeSetup: previous.recheckAfterWorktreeSetup }
      : {}),
    ...(previous.staleSessionResumeId !== undefined
      ? { staleSessionResumeId: previous.staleSessionResumeId }
      : {}),
    // Projected from canonical RUNTIME state, which a tab payload does not
    // carry. Dropping it here would silently retire the empty-completion
    // recovery notice on the next unrelated tab upsert (CAN-2307), leaving the
    // user back at a completed turn with nothing in it.
    ...(previous.emptyCompletionRecovery !== undefined
      ? { emptyCompletionRecovery: previous.emptyCompletionRecovery }
      : {}),
    ...(previous.cancelRequestedByUser !== undefined
      ? { cancelRequestedByUser: previous.cancelRequestedByUser }
      : {}),
    ...(previous.stoppedTurnResume !== undefined
      ? { stoppedTurnResume: previous.stoppedTurnResume }
      : {}),
    // Renderer-only: a refused cloud send never reaches canonical state.
    ...(previous.sendRefusal !== undefined
      ? { sendRefusal: previous.sendRefusal }
      : {}),
    // Renderer-only optimistic send state; canonical runtime settles it.
    ...(previous.sendingLease !== undefined
      ? { sendingLease: previous.sendingLease }
      : {}),
    // The route main reported for the live session. Main never commits it,
    // so a canonical tab cannot carry it and must not drop it.
    ...(previous.accountProxyRouted !== undefined
      ? { accountProxyRouted: previous.accountProxyRouted }
      : {}),
    // The Subagents picker's summary of an evicted transcript, kept until
    // the transcript loads again.
    ...(previous.evictedSubagentRoot !== undefined &&
    next.transcriptLoaded === false
      ? { evictedSubagentRoot: previous.evictedSubagentRoot }
      : {}),
  };
  return reconcileProvisionalTerminalFirstSend(
    preservePendingUserMessages(
      preserveProvisionalFirstSendTitle(previous, preserved),
      preserved.messages,
      authoritativeMessages,
    ),
    authoritativeMessages,
  );
}

function sanitizeOneMessage(
  message: PersistedChatMessage,
): PersistedChatMessage | undefined {
  return sanitizePersistedChatMessages([message])[0];
}

function withDerivedTodos(tab: ChatTab): ChatTab {
  const finishPerformanceStage = beginTranscriptPerformanceStage(
    'todo_projection',
    { messages: tab.messages.length },
  );
  const currentTodos = deriveCurrentTodosFromMessages(tab.messages);
  const currentTaskTodos = deriveCurrentTaskTodosFromMessages(tab.messages);
  const next = { ...tab };
  if (currentTodos && currentTodos.length > 0) {
    next.currentTodos = currentTodos;
  } else {
    delete next.currentTodos;
  }
  if (currentTaskTodos && currentTaskTodos.length > 0) {
    next.currentTaskTodos = currentTaskTodos;
  } else {
    delete next.currentTaskTodos;
  }
  finishPerformanceStage();
  return next;
}

/**
 * How a message change projects the chat's TODO lists. `transcript` means a
 * later `transcript.updated` change for the same chat in the same committed
 * change list carries main's TODOs (`TranscriptDescriptor.todos`/`taskTodos`,
 * folded over the whole transcript) and overwrites both fields, so deriving
 * them here would be discarded work. `derive` keeps the renderer derivation
 * for change lists main sent without a descriptor update.
 */
type TodoProjection = 'derive' | 'transcript';

function updateTabMessages(
  chatState: WorktreeChatState,
  chatId: string,
  update: (messages: PersistedChatMessage[]) => PersistedChatMessage[],
  todoProjection: TodoProjection,
): WorktreeChatState {
  const index = chatState.tabs.findIndex((tab) => tab.id === chatId);
  if (index === -1) return chatState;
  const tab = chatState.tabs[index];
  const nextMessages = update(tab.messages);
  if (nextMessages === tab.messages) return chatState;
  const tabs = chatState.tabs.slice();
  const nextTab: ChatTab = { ...tab, messages: nextMessages };
  tabs[index] =
    todoProjection === 'derive' ? withDerivedTodos(nextTab) : nextTab;
  return { ...chatState, tabs };
}

function applySettingsPatchToTab(
  tab: ChatTab,
  patch: ChatTabMetadataPatch,
  ctx: CanonicalChangeContext,
): ChatTab {
  const next: ChatTab = { ...tab };
  const {
    modelConfig,
    planMode,
    proposalMode,
    thinkingLevel,
    usage,
    ...metadata
  } = patch;
  let patchedFilePath: string | undefined;
  for (const [key, value] of Object.entries(metadata)) {
    if (!isSafeChatTabMetadataKey(key)) continue;
    if (value === undefined) continue;
    if (key === 'filePath' && typeof value === 'string') {
      patchedFilePath = value;
    }
    if (value === null) Reflect.deleteProperty(next, key);
    else defineChatTabMetadataProperty(next, key, value);
  }
  // Mirrors main's reducer: only `chat.mark_unread` sets the manual flag, so
  // any other unread write replaces the user's mark.
  if (metadata.unread !== undefined) delete next.unreadMarkedManually;
  if (planMode !== undefined) next.planMode = planMode ?? false;
  if (proposalMode !== undefined) {
    next.proposalMode = proposalMode ?? 'optional';
  }
  if (thinkingLevel !== undefined) {
    next.thinkingLevel = thinkingLevel ?? 'high';
  }
  // File viewers use description as the canonical full-path label.
  if (tab.kind === 'file' && patchedFilePath !== undefined) {
    next.description = patchedFilePath;
  }
  if (modelConfig === null) {
    const providerType =
      patch.providerType ?? resolveTabProviderType(next) ?? 'claude';
    // A cleared record falls back to the legacy tab alias, if main kept one.
    const resolved = resolveProviderModelConfig(
      providerType,
      {
        thinkingLevel: next.thinkingLevel,
        codexFastModeEnabled: next.codexFastModeEnabled,
      },
      undefined,
    );
    next.modelConfig = resolved;
    next.thinkingLevel = resolved.thinkingLevel;
    next.fastModeExplicit = typeof next.codexFastModeEnabled === 'boolean';
  } else if (modelConfig !== undefined) {
    const providerType =
      patch.providerType ?? resolveTabProviderType(next) ?? 'claude';
    // THE shared explicit-command merge: an exact speed wins, a legacy
    // boolean without a speed replaces it (so `false` moves Ultra fast to
    // Regular), and a thinking-only patch keeps the current speed.
    const mergedInput = mergeAgentModelConfig(tab.modelConfig, modelConfig);
    const resolved = resolveProviderModelConfig(
      providerType,
      {
        thinkingLevel: modelConfig.thinkingLevel ?? tab.thinkingLevel,
        modelConfig: mergedInput,
      },
      undefined,
    );
    next.modelConfig = resolved;
    next.thinkingLevel = resolved.thinkingLevel;
    const patchedSpeed = readCodexSpeedRecord({
      speed: modelConfig.speed,
      fastMode: modelConfig.fastMode,
    });
    if (
      patchedSpeed !== undefined &&
      hasPendingLocalCodexSpeedWrite(ctx.projectId, ctx.worktreeId, tab.id)
    ) {
      // An echo of an earlier write must not undo a newer local speed; keep
      // it as the fallback if the newest write is refused.
      recordCanonicalCodexSpeedWhilePending(
        ctx.projectId,
        ctx.worktreeId,
        tab.id,
        patchedSpeed,
      );
      next.modelConfig = {
        ...resolved,
        ...codexSpeedFields(tabRequestedCodexSpeed(tab)),
      };
    } else if (patchedSpeed !== undefined) {
      next.fastModeExplicit = true;
      if (providerType === 'codex') {
        next.codexFastModeEnabled = resolved.fastMode;
      }
    }
  }
  if (usage === null) {
    delete next.usage;
  } else if (usage !== undefined) {
    next.usage = normalizePersistedUsage(
      usage,
      next.model,
      next.aiCreditsRouted,
      next.executionHarness ??
        (next.providerType === 'opencode' ? 'opencode' : undefined),
    );
  }
  return next;
}

function toPendingQuestion(
  question: PersistedPendingQuestion,
  ctx: CanonicalChangeContext,
): PendingQuestion {
  return {
    requestId: question.requestId,
    projectId: ctx.projectId,
    worktreeId: ctx.worktreeId,
    chatId: question.chatId,
    questions: question.questions,
    ...(question.answers ? { answers: question.answers } : {}),
    ...(question.answeredAt !== undefined
      ? { answeredAt: question.answeredAt }
      : {}),
    ...(question.toolUseId ? { toolUseId: question.toolUseId } : {}),
    ...(question.delivery ? { delivery: question.delivery } : {}),
    ...(question.dismissedAt !== undefined
      ? { dismissedAt: question.dismissedAt }
      : {}),
  };
}

function resolveActiveTabId(tabs: ChatTab[], preferredId: string): string {
  return tabs.some((tab) => tab.id === preferredId)
    ? preferredId
    : (tabs[0]?.id ?? '');
}

function sameCardExceptStreamRevision(
  current: DelegatedAgentCallBlock,
  next: DelegatedAgentCallBlock,
): boolean {
  const { streamRevision: currentRevision, ...currentCard } = current;
  const { streamRevision: nextRevision, ...nextCard } = next;
  void currentRevision;
  void nextRevision;
  return stableStringify(currentCard) === stableStringify(nextCard);
}

function applyOneChange(
  projection: CanonicalScopeProjection,
  change: ChatStateChange,
  ctx: CanonicalChangeContext,
  todoProjection: TodoProjection,
): CanonicalScopeProjection {
  switch (change.type) {
    case 'delegation.card_state_updated':
      // Card state is descriptor metadata: it overlays a loaded stream card
      // and never inserts a row. An unloaded card arrives merged when it loads.
      return {
        ...projection,
        chatState: updateTabMessages(
          projection.chatState,
          change.chatId,
          (messages) => {
            let changed = false;
            const next = messages.map((message) => {
              let blocksChanged = false;
              const blocks = message.blocks.map((block) => {
                if (
                  block.type !== 'delegated_agent_call' ||
                  block.transcriptStore !== 'chat-stream-v2' ||
                  block.delegationId !== change.delegationId ||
                  block.runGeneration !== change.runGeneration
                )
                  return block;
                const overlaid = overlayStreamBackedDelegationCard(
                  block,
                  change.cardState,
                  change.streamRevision,
                );
                // Desktop's child pages read stream revisions from the stream
                // hints, so an update that only advances the stream keeps the
                // block, and the tab, as they are.
                if (sameCardExceptStreamRevision(block, overlaid)) return block;
                blocksChanged = true;
                return overlaid;
              });
              if (!blocksChanged) return message;
              changed = true;
              return { ...message, blocks };
            });
            return changed ? next : messages;
          },
          todoProjection,
        ),
      };
    case 'tab.upserted': {
      const converted = fromPersistedTab(change.tab);
      const tabs = projection.chatState.tabs.slice();
      const index = tabs.findIndex((tab) => tab.id === converted.id);
      if (index === -1) {
        tabs.push(converted);
      } else {
        tabs[index] = preserveRendererOnlyTabFields(tabs[index], converted);
      }
      return {
        ...projection,
        chatState: {
          ...projection.chatState,
          tabs: relabelFileTabs(tabs),
          activeTabId: resolveActiveTabId(
            tabs,
            projection.chatState.activeTabId,
          ),
        },
      };
    }
    case 'tab.removed': {
      const tabs = projection.chatState.tabs.filter(
        (tab) => tab.id !== change.tabId,
      );
      if (tabs.length === projection.chatState.tabs.length) return projection;
      const chatState: WorktreeChatState = {
        ...projection.chatState,
        tabs: relabelFileTabs(tabs),
        activeTabId: resolveActiveTabId(tabs, projection.chatState.activeTabId),
      };
      if (chatState.lastActiveEditableChatId === change.tabId) {
        delete chatState.lastActiveEditableChatId;
      }
      const runtimeByChatId = { ...projection.runtimeByChatId };
      delete runtimeByChatId[change.tabId];
      const pendingQuestions = Object.fromEntries(
        Object.entries(projection.pendingQuestions).filter(
          ([, question]) => question.chatId !== change.tabId,
        ),
      );
      return { ...projection, chatState, runtimeByChatId, pendingQuestions };
    }
    case 'tab.metadata_patched': {
      const index = projection.chatState.tabs.findIndex(
        (tab) => tab.id === change.tabId,
      );
      if (index === -1) return projection;
      const tabs = projection.chatState.tabs.slice();
      tabs[index] = applySettingsPatchToTab(tabs[index], change.patch, ctx);
      return {
        ...projection,
        chatState: { ...projection.chatState, tabs: relabelFileTabs(tabs) },
      };
    }
    case 'tab.order_changed': {
      const byId = new Map(
        projection.chatState.tabs.map((tab) => [tab.id, tab]),
      );
      const ordered: ChatTab[] = [];
      for (const tabId of change.tabIds) {
        const tab = byId.get(tabId);
        if (tab) {
          ordered.push(tab);
          byId.delete(tabId);
        }
      }
      // Tabs the canonical order does not mention keep their relative order.
      for (const tab of projection.chatState.tabs) {
        if (byId.has(tab.id)) ordered.push(tab);
      }
      return {
        ...projection,
        chatState: { ...projection.chatState, tabs: ordered },
      };
    }
    case 'tab.active_changed': {
      const chatState: WorktreeChatState = {
        ...projection.chatState,
        activeTabId: resolveActiveTabId(
          projection.chatState.tabs,
          change.activeTabId,
        ),
      };
      if (change.lastActiveEditableChatId !== undefined) {
        chatState.lastActiveEditableChatId = change.lastActiveEditableChatId;
      }
      if (change.lastActiveChatProvider !== undefined) {
        chatState.lastActiveChatProvider = change.lastActiveChatProvider;
      }
      return { ...projection, chatState };
    }
    case 'message.upserted': {
      const sanitized = sanitizeOneMessage(change.message);
      if (!sanitized) return projection;
      return {
        ...projection,
        chatState: updateTabMessages(
          projection.chatState,
          change.chatId,
          (messages) => {
            const index = messages.findIndex(
              (message) => message.id === sanitized.id,
            );
            if (index === -1) {
              const anchor = change.afterMessageId
                ? messages.findIndex(
                    (message) => message.id === change.afterMessageId,
                  )
                : -1;
              if (change.afterMessageId && anchor < 0) return messages;
              const next = messages.slice();
              let insertAt = anchor < 0 ? next.length : anchor + 1;
              while (
                insertAt < next.length &&
                next[insertAt]?.parentBlockId === change.afterMessageId
              )
                insertAt += 1;
              next.splice(insertAt, 0, sanitized);
              return next;
            }
            const next = messages.slice();
            next[index] = sanitized;
            return next;
          },
          todoProjection,
        ),
      };
    }
    case 'message.removed': {
      const chatState = updateTabMessages(
        projection.chatState,
        change.chatId,
        (messages) => {
          const next = messages.filter(
            (message) => message.id !== change.messageId,
          );
          return next.length === messages.length ? messages : next;
        },
        todoProjection,
      );
      // Host queue cancellation names the original submission, even though
      // its prompt never entered the transcript. Retire that ownership and
      // the send's pending turn, whose open timer would otherwise close
      // whichever turn is newest and show it as running.
      const tabs = chatState.tabs.map((tab) => {
        if (tab.id !== change.chatId) return tab;
        const withdrawn =
          tab.provisionalFirstSend?.userMessageId === change.messageId
            ? withdrawProvisionalFirstSendFromTab(
                cancelProvisionalFirstSendQueue(tab, change.messageId),
                change.messageId,
              )
            : tab;
        return retireRemovedPendingTurn(withdrawn, change.messageId);
      });
      return {
        ...projection,
        chatState: tabs.every((tab, index) => tab === chatState.tabs[index])
          ? chatState
          : { ...chatState, tabs },
      };
    }
    case 'transcript.updated': {
      return {
        ...projection,
        chatState: {
          ...projection.chatState,
          tabs: projection.chatState.tabs.map((tab) =>
            tab.id !== change.chatId
              ? tab
              : {
                  ...tab,
                  transcript: change.transcript,
                  currentTodos: change.transcript.todos,
                  currentTaskTodos: change.transcript.taskTodos,
                  ...(change.reset
                    ? {
                        transcriptLoaded: false,
                        transcriptWindow: tab.transcriptWindow
                          ? {
                              ...tab.transcriptWindow,
                              transcriptRevision:
                                change.transcript.transcriptRevision,
                              totalMessages:
                                change.transcript.messageCount ??
                                change.transcript.committedMessageCount ??
                                tab.transcriptWindow.totalMessages,
                            }
                          : {
                              view: 'turns',
                              turns: [],
                              messageOrdinals: {},
                              totalMessages:
                                change.transcript.messageCount ??
                                change.transcript.committedMessageCount ??
                                0,
                              transcriptRevision:
                                change.transcript.transcriptRevision,
                            },
                      }
                    : tab.transcriptWindow && tab.transcriptLoaded !== false
                      ? {
                          transcriptWindow: {
                            ...tab.transcriptWindow,
                            transcriptRevision:
                              change.transcript.transcriptRevision,
                            totalMessages:
                              change.transcript.messageCount ??
                              change.transcript.committedMessageCount,
                          },
                        }
                      : {}),
                },
          ),
        },
      };
    }
    case 'messages.replaced': {
      const sanitized = sanitizePersistedChatMessages(change.messages);
      return {
        ...projection,
        chatState: updateTabMessages(
          projection.chatState,
          change.chatId,
          () => sanitized,
          todoProjection,
        ),
      };
    }
    case 'pending_question.upserted': {
      return {
        ...projection,
        pendingQuestions: {
          ...projection.pendingQuestions,
          [change.question.requestId]: toPendingQuestion(change.question, ctx),
        },
      };
    }
    case 'pending_question.removed': {
      if (!(change.requestId in projection.pendingQuestions)) {
        return projection;
      }
      const pendingQuestions = { ...projection.pendingQuestions };
      delete pendingQuestions[change.requestId];
      return { ...projection, pendingQuestions };
    }
    case 'runtime.patched': {
      const runtimeByChatId = {
        ...projection.runtimeByChatId,
        [change.chatId]: change.runtime,
      };
      const index = projection.chatState.tabs.findIndex(
        (tab) => tab.id === change.chatId,
      );
      let chatState = projection.chatState;
      if (index !== -1) {
        const currentTab = chatState.tabs[index];
        const tab = settleSendingLease(currentTab, change.runtime);
        const status = chatRuntimeStatusToTabStatus(change.runtime);
        const error =
          status === 'error' ? (change.runtime.error?.message ?? null) : null;
        const lastEventAt = latestChatActivityAt(
          tab.lastEventAt,
          change.runtime.lastActivityAt,
        );
        const stopped = pendingTurnStopped(tab, status);
        const emptyCompletionRecovery = emptyCompletionRecoveryForRuntime(
          change.runtime,
        );
        if (
          stopped ||
          tab !== currentTab ||
          tab.status !== status ||
          tab.error !== error ||
          tab.lastEventAt !== lastEventAt ||
          tab.emptyCompletionRecovery?.turnUserMessageId !==
            emptyCompletionRecovery?.turnUserMessageId
        ) {
          const tabs = chatState.tabs.slice();
          const nextTab: ChatTab = {
            ...(stopped ? withoutPendingTurn(tab) : tab),
            status,
            error,
            lastEventAt,
            ...(emptyCompletionRecovery ? { emptyCompletionRecovery } : {}),
          };
          if (!emptyCompletionRecovery) delete nextTab.emptyCompletionRecovery;
          tabs[index] = nextTab;
          chatState = { ...chatState, tabs };
        }
      }
      return { ...projection, chatState, runtimeByChatId };
    }
    case 'archive.upserted': {
      const index = projection.archives.findIndex(
        (entry) => entry.chatId === change.archive.chatId,
      );
      const archives = projection.archives.slice();
      if (index === -1) archives.unshift(change.archive);
      else archives[index] = change.archive;
      return { ...projection, archives };
    }
    case 'archive.removed': {
      const archives = projection.archives.filter(
        (entry) => entry.chatId !== change.chatId,
      );
      if (archives.length === projection.archives.length) return projection;
      return { ...projection, archives };
    }
    case 'archive.read_state_changed': {
      const index = projection.archives.findIndex(
        (entry) => entry.chatId === change.chatId,
      );
      if (index === -1) return projection;
      if (projection.archives[index].unread === change.unread) {
        return projection;
      }
      const archives = projection.archives.slice();
      archives[index] = { ...archives[index], unread: change.unread };
      return { ...projection, archives };
    }
    case 'messages.omitted': {
      const tab = projection.chatState.tabs.find(
        (tab) => tab.id === change.chatId,
      );
      if (!tab || tab.transcriptStale) return projection;
      return {
        ...projection,
        chatState: {
          ...projection.chatState,
          tabs: projection.chatState.tabs.map((tab) =>
            tab.id === change.chatId ? { ...tab, transcriptStale: true } : tab,
          ),
        },
      };
    }
  }
}

/** Collect invalidation even when the card's message is not loaded. */
function applyDelegationHintChange(
  projection: CanonicalScopeProjection,
  change: ChatStateChange,
): CanonicalScopeProjection {
  const hints = projection.delegationStreamHints;
  if (change.type === 'tab.removed') {
    if (!hints) return projection;
    const prefix = `${change.tabId}:`;
    const entries = Object.entries(hints.runs);
    const kept = entries.filter(([key]) => !key.startsWith(prefix));
    return kept.length === entries.length
      ? projection
      : {
          ...projection,
          delegationStreamHints: { ...hints, runs: Object.fromEntries(kept) },
        };
  }
  if (change.type !== 'delegation.card_state_updated') return projection;
  const current: DelegationStreamScopeHints = hints ?? { epoch: 0, runs: {} };
  const prefix = `${change.chatId}:${change.delegationId}:`;
  const key = delegationStreamRunKey(
    change.chatId,
    change.delegationId,
    change.runGeneration,
  );
  const entries = Object.entries(current.runs);
  const generations = entries.filter(([run]) => run.startsWith(prefix));
  // An event for an older run must not resurrect its retired generation.
  if (
    generations.some(
      ([run]) => Number(run.slice(prefix.length)) > change.runGeneration,
    )
  ) {
    return projection;
  }
  const previous = current.runs[key];
  const streamRevision = Math.max(
    previous?.streamRevision ?? 0,
    change.streamRevision,
  );
  const cardRevision = Math.max(
    previous?.cardRevision ?? 0,
    change.cardRevision,
  );
  if (
    previous?.streamRevision === streamRevision &&
    previous.cardRevision === cardRevision
  ) {
    return projection;
  }
  const runs = Object.fromEntries(
    entries.filter(([run]) => !run.startsWith(prefix)),
  );
  runs[key] = { streamRevision, cardRevision };
  return { ...projection, delegationStreamHints: { ...current, runs } };
}

/**
 * Apply an ordered list of committed canonical changes to a scope projection.
 * Pure: returns new objects, never mutates inputs, and performs no I/O.
 */
export function applyCanonicalChanges(
  projection: CanonicalScopeProjection,
  changes: readonly ChatStateChange[],
  ctx: CanonicalChangeContext,
): CanonicalScopeProjection {
  const finishPerformanceStage = beginTranscriptPerformanceStage(
    'canonical_apply',
    { changes: changes.length },
  );
  recordTranscriptPerformanceCounter('canonical_changes', changes.length);
  // Main appends one `transcript.updated` per changed chat after the
  // mutation changes of a commit. Index of each chat's last one:
  const lastTranscriptUpdateByChat = new Map<string, number>();
  changes.forEach((change, index) => {
    if (change.type === 'transcript.updated') {
      lastTranscriptUpdateByChat.set(change.chatId, index);
    }
  });
  let next = projection;
  for (let changeIndex = 0; changeIndex < changes.length; changeIndex += 1) {
    const change = changes[changeIndex];
    next = applyDelegationHintChange(next, change);
    recordTranscriptPerformanceCounter(
      `canonical_change_${change.type.replace(/\./g, '_')}`,
    );
    if (change.type === 'runtime.patched') {
      const previousIds =
        next.runtimeByChatId[change.chatId]?.queuedMessageIds ?? [];
      const removedIds = previousIds.filter(
        (id) => !change.runtime.queuedMessageIds.includes(id),
      );
      if (removedIds.length) {
        // Cancellation commits a message removal in the same transaction.
        // Queue snapshots alone cannot distinguish cancellation from dispatch.
        const cancelled = changes.some(
          (candidate) =>
            candidate.type === 'message.removed' &&
            candidate.chatId === change.chatId,
        );
        const tabs = next.chatState.tabs.map((tab) => {
          if (tab.id !== change.chatId) return tab;
          const row =
            removedIds.length === 1
              ? tab.queuedMessages.find(
                  (row) => row.hostQueueEntryId === removedIds[0],
                )
              : undefined;
          const updated = {
            ...tab,
            queuedMessages: tab.queuedMessages.filter(
              (row) =>
                !row.hostQueueEntryId ||
                !removedIds.includes(row.hostQueueEntryId),
            ),
          };
          const ownedByInputDelivery =
            row !== undefined &&
            tab.inputDelivery?.rows.some(
              (delivery) =>
                delivery.text === row.text &&
                (delivery.origin ?? 'desktop') === (row.origin ?? 'desktop'),
            );
          // Portal prompts are persisted before entering this queue. Watcher
          // and input-delivery prompts own their own transcript identity and
          // lifecycle; a queue removal can mean steering, not a new root turn.
          // Watcher delivery also owns its own transcript coalescing.
          return row?.origin === 'desktop' &&
            !row.watcherFired &&
            !cancelled &&
            !ownedByInputDelivery
            ? presentDequeuedMessage(
                updated,
                row,
                change.runtime.lastActivityAt ?? row.enqueuedAtMs ?? 0,
              )
            : updated;
        });
        next = { ...next, chatState: { ...next.chatState, tabs } };
      }
    }
    const todoProjection: TodoProjection =
      'chatId' in change &&
      (lastTranscriptUpdateByChat.get(change.chatId) ?? -1) > changeIndex
        ? 'transcript'
        : 'derive';
    if (change.type === 'transcript.updated' && change.reset) {
      const previous = projection.chatState.tabs.find(
        (tab) => tab.id === change.chatId,
      );
      if (previous && canKeepTranscriptWindowAfterReset(previous, changes)) {
        // The rank-safe window stays loaded, but adopts canonical descriptor metadata.
        next = applyOneChange(
          next,
          { ...change, reset: false },
          ctx,
          todoProjection,
        );
        next = {
          ...next,
          chatState: {
            ...next.chatState,
            tabs: next.chatState.tabs.map((tab) =>
              tab.id === change.chatId
                ? {
                    ...tab,
                    transcriptWindow: rebaseTranscriptWindow(
                      { ...previous, transcriptWindow: tab.transcriptWindow },
                      tab.messages,
                    ),
                  }
                : tab,
            ),
          },
        };
      } else {
        next = applyOneChange(next, change, ctx, todoProjection);
      }
    } else {
      next = applyOneChange(next, change, ctx, todoProjection);
    }
    if (change.type === 'message.upserted') {
      const messageId = change.message.id;
      const tabs = next.chatState.tabs.map((tab) => {
        if (
          tab.id !== change.chatId ||
          (!tab.pendingUserMessages?.length &&
            !tab.pendingQueueMessages?.length &&
            !tab.pendingTurn &&
            !tab.pendingQueueDispatch)
        )
          return tab;
        tab = reconcileProvisionalTerminalFirstSend(
          reconcileQueueDispatch(tab, [change.message]),
          [change.message],
        );
        const users = tab.pendingUserMessages?.filter(
          (message) => message.id !== messageId,
        );
        const queue = tab.pendingQueueMessages?.filter(
          (entry) => entry.userMessageId !== messageId,
        );
        return reconcilePendingTurn({
          ...tab,
          pendingUserMessages: users?.length ? users : undefined,
          pendingQueueMessages: queue?.length ? queue : undefined,
        });
      });
      next = { ...next, chatState: { ...next.chatState, tabs } };
    }
  }
  finishPerformanceStage();
  return next;
}
