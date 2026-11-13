'use client';

import type { CanopyClient } from '@canopy/app-core';
import {
  foldToolResultsIntoToolUses,
  omitRecoveredCreditHoldArtifacts,
} from '@canopy/ui-shared/lib';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import type {
  PortalChatMessage,
  PortalChatTurnGroup,
  PortalAskUserQuestionState,
} from '@canopy/protocol/portal';
import {
  ChatToolStepGroup,
  ThinkingSpinner,
  TurnWorkHeader,
  TurnFooterRow,
  useCleanChatLook,
  isAskUserQuestionToolName,
  portalAskUserQuestionRecordState,
  parseAskUserQuestionTexts,
  readToolCallResult,
  resolveTurnStartingStatus,
  ErrorBanner,
} from '@canopy/ui-shared/components';
import {
  detectSentPrompt,
  hasLiveTurnTimer,
  useOptionalCanopyClient,
  type ChatThreadStatus,
  type SentPromptSummary,
} from '@canopy/app-state';
import { ChatMessageView, normalizeChatMessageParts } from './ChatMessageView';
import {
  TurnGroupView,
  isFirstTurnHeldForSetup,
  isTurnAwaitingFirstOutput,
} from './TurnGroupView';
import { useChatAgentActivityPlacement } from './agent-activity/chat-agent-activity-placement';
import { useChatVisualHost } from './chat-visual-host';
import {
  collectChatVisualOwners,
  useChatVisualsPublisher,
} from './chat-visuals-source';
import {
  useAskUserQuestionInteraction,
  useTurnWorkingStatus,
} from './ChatPartView';
import { summarizeTranscriptPrompts } from './sent-prompt-summary';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

/**
 * Presentational chat transcript: renders the turn groups (via
 * {@link TurnGroupView}) plus empty / streaming / error states, and keeps the
 * view scrolled to the newest message. It takes the thread's neutral data as
 * props; the store read happens one level up in `ChatPanel`, keeping this
 * component pure and directly `renderToString`-testable.
 */
export interface ChatTranscriptProps {
  /** Continuation and context maintenance keep their existing work status. */
  readonly firstSendStartingEnabled?: boolean;
  /**
   * The chat this transcript shows. A prompt the person sends re-arms
   * bottom-follow only within the same chat.
   */
  readonly chatId?: string;
  /** False while the host is hydrating history, including an empty history. */
  readonly initialized?: boolean;
  /** Affirmative host evidence that the snapshot contains every tool result. */
  readonly resultsComplete?: boolean;
  readonly messages: readonly PortalChatMessage[];
  readonly turnGroups: readonly PortalChatTurnGroup[];
  /**
   * Dedupe keys of the runs the host lists live elsewhere (the composer's
   * background drawer): no turn lists them until they finish (CAN-4690).
   */
  readonly liveRunKeys?: ReadonlySet<string>;
  readonly status: ChatThreadStatus;
  readonly error?: string | null;
  readonly appIcon?: ReactNode;
  /** Overrides the default empty-state placeholder. */
  readonly emptyState?: ReactNode;
  /**
   * Renders the turn-level thumbs up/down control (CAN-1521) for one turn,
   * keyed by the turn's `localMessageId` (the desktop renderer's per-turn
   * `userMessageId`, which `PortalChatMessage.localMessageId` already
   * persists). Omitted by hosts without the `turnFeedback` capability.
   */
  readonly renderTurnFeedback?: (localMessageId: string) => ReactNode;
  /** Host-owned action rendered beside the latest turn only. */
  readonly renderLatestTurnAction?: (context: {
    readonly disabled: boolean;
  }) => ReactNode;
  /**
   * Rendered as the last content inside the scroll container, above the
   * autoscroll sentinel. Queued messages belong here: they are the tail of the
   * conversation, so they must scroll WITH the transcript. Rendering them as a
   * sibling below the scroll container (as the panel used to) let them grow as
   * an unbounded flex item, squeezing the `flex-1` transcript until scroll-back
   * was unreachable (CAN-2524).
   */
  readonly footerSlot?: ReactNode;
  /**
   * Host status that belongs under the queue tail (a first send that has not
   * produced a turn yet). Independent of `status`: a queued first send is not
   * streaming, so the transcript's own working row does not cover it.
   */
  readonly footerStatus?: ReactNode;
  /**
   * Messages the host is delivering to an idle agent now. They render as sent
   * prompts after the transcript, with the working row under them, until the
   * transcript itself carries them.
   */
  readonly deliveringMessages?: readonly PortalChatMessage[];
  /**
   * Prompts the person has queued in `footerSlot`, excluding host entries.
   * Queuing a prompt is a send, so it re-arms bottom-follow.
   */
  readonly queuedPromptCount?: number;
  readonly queuedPromptIds?: readonly string[];
  /** Canonical user-message identities of those queued sends. */
  readonly queuedPromptMessageIds?: readonly string[];
  readonly onLoadOlder?: () => Promise<void>;
  /**
   * The chat's worktree, while the host knows it: a first turn starting
   * while its Git setup is pending reads as that setup, with its clock.
   */
  readonly worktreeSetup?: ChatTranscriptWorktreeSetup;
}

/** What a transcript needs to show a starting turn's worktree setup. */
export interface ChatTranscriptWorktreeSetup {
  /** The worktree's setup phase; only `git-pending` reads as setup. */
  readonly phase?: string;
  /** ISO string on desktop and Portal rows, epoch ms on cloud worktrees. */
  readonly createdAt?: string | number;
  readonly projectName?: string;
}

const EMPTY_DELIVERING_MESSAGES: readonly PortalChatMessage[] = [];

// Presentation memory follows the injected client, including keyed panel
// remounts. It carries no transcript or execution state and is never persisted.
const pendingFirstSendPresentations = new WeakMap<CanopyClient, Set<string>>();

export function getLatestMessageSignal(
  messages: readonly PortalChatMessage[],
): string {
  const latestMessage = messages[messages.length - 1];
  return latestMessage
    ? [
        latestMessage.messageId,
        latestMessage.updatedAtMs ?? latestMessage.createdAtMs,
        latestMessage.text.length,
        latestMessage.parts?.length ?? 0,
      ].join(':')
    : '';
}

/** How long a wake's link keeps the row it brought into view highlighted. */
const CALL_FOCUS_HIGHLIGHT_MS = 2400;
/** Frames a wake's link waits for its row to mount before giving up. */
const CALL_FOCUS_MAX_FRAMES = 30;

/** Use the same legacy Claude correlation as the interactive card itself. */
function pendingQuestionToolUseId(
  messages: readonly PortalChatMessage[],
  question: PortalAskUserQuestionState,
): string | undefined {
  if (question.toolUseId !== undefined) return question.toolUseId;
  for (const message of messages) {
    for (const part of normalizeChatMessageParts(message.parts ?? [])) {
      const data = part.data;
      if (
        part.kind !== 'tool_use' ||
        typeof data !== 'object' ||
        data === null ||
        !('toolName' in data) ||
        typeof data.toolName !== 'string' ||
        !isAskUserQuestionToolName(data.toolName)
      )
        continue;
      if ('result' in data && readToolCallResult(data.result) !== null)
        continue;
      const toolUseId =
        'toolUseId' in data && typeof data.toolUseId === 'string'
          ? data.toolUseId
          : undefined;
      const input =
        'input' in data && typeof data.input === 'string'
          ? data.input
          : undefined;
      if (
        toolUseId !== undefined &&
        portalAskUserQuestionRecordState([question], {
          toolName: data.toolName,
          toolUseId,
          questionTexts: parseAskUserQuestionTexts(input),
        }).kind === 'unanswered'
      )
        return toolUseId;
    }
  }
  return undefined;
}

/** Whether a turn holds the tool call (or Agent call) with this id. */
function turnHoldsToolCall(
  turnGroup: PortalChatTurnGroup,
  messagesById: Readonly<Record<string, PortalChatMessage | undefined>>,
  toolUseId: string,
): boolean {
  return [
    ...turnGroup.intermediateMessageIds,
    ...turnGroup.finalMessageIds,
  ].some((id) =>
    messagesById[id]?.parts?.some(
      (part) =>
        (part.kind === 'tool_use' || part.kind === 'agent') &&
        typeof part.data === 'object' &&
        part.data !== null &&
        'toolUseId' in part.data &&
        part.data.toolUseId === toolUseId,
    ),
  );
}

/** Virtualized transcript geometry before turns are measured. */
const ESTIMATED_TURN_HEIGHT_PX = 200;
const TURN_GAP_PX = 8;
const INITIAL_VIEWPORT_HEIGHT_PX = 600;

/**
 * Whether the latest turn already shows `error` in one of its final messages.
 * A failed provider frame is both a failed message and the thread error, so
 * the error line under the transcript would repeat the same text.
 *
 * Only final messages count: they always render, while a completed turn can
 * fold its intermediate messages away. Any status counts: persisted Portal
 * messages project as `complete`, and a message with the same text already
 * shows the error. Anything else keeps the error line.
 */
function latestTurnShowsError(
  turnGroups: readonly PortalChatTurnGroup[],
  messagesById: Readonly<Record<string, PortalChatMessage | undefined>>,
  error: string,
): boolean {
  const latest = turnGroups[turnGroups.length - 1];
  if (!latest) return false;
  const text = error.trim();
  return latest.finalMessageIds.some((id) => {
    const message = messagesById[id];
    return (
      message !== undefined &&
      message.role !== 'user' &&
      message.text.trim() === text
    );
  });
}

export function ChatTranscript({
  chatId,
  firstSendStartingEnabled = true,
  initialized = true,
  messages: inputMessages,
  turnGroups,
  liveRunKeys,
  status,
  error,
  appIcon,
  emptyState,
  renderTurnFeedback,
  renderLatestTurnAction,
  footerSlot,
  footerStatus,
  deliveringMessages,
  queuedPromptCount = 0,
  queuedPromptIds,
  queuedPromptMessageIds,
  onLoadOlder,
  resultsComplete = false,
  worktreeSetup,
}: ChatTranscriptProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const readerScrollTop = useRef(0);
  const scheduledScroll = useRef<number | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const touchY = useRef<number | null>(null);
  const loadingOlder = useRef(false);
  // Live turns deliver a call and its result as separate messages; fold them
  // as the shell and the persisted projection do, so the call card completes.
  const messages = useMemo(
    () =>
      foldToolResultsIntoToolUses(
        omitRecoveredCreditHoldArtifacts(inputMessages),
      ),
    [inputMessages],
  );
  // The Chat visuals panel lists what this transcript holds, so it needs no
  // transcript of its own. Nothing is collected where the host has no panel.
  const visualHost = useChatVisualHost();
  const visualsSourceKey = visualHost?.sourceKey ?? null;
  const visualOwners = useMemo(
    () => (visualsSourceKey === null ? [] : collectChatVisualOwners(messages)),
    [visualsSourceKey, messages],
  );
  useChatVisualsPublisher(visualsSourceKey, visualOwners, visualHost);
  const hasMessages = messages.length > 0;
  const virtualized = turnGroups.length > 50;
  const virtualizer = useVirtualizer({
    count: turnGroups.length,
    enabled: virtualized,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_TURN_HEIGHT_PX,
    // Matches the non-virtualized column's gap-2, which TurnGroupView's
    // footer spacing relies on.
    gap: TURN_GAP_PX,
    getItemKey: (index) => turnGroups[index].userMessageId,
    overscan: 5,
    initialRect: { width: 800, height: INITIAL_VIEWPORT_HEIGHT_PX },
    initialOffset: () =>
      Math.max(
        0,
        turnGroups.length * (ESTIMATED_TURN_HEIGHT_PX + TURN_GAP_PX) -
          TURN_GAP_PX -
          INITIAL_VIEWPORT_HEIGHT_PX,
      ),
  });
  const virtualHeight = virtualizer.getTotalSize();
  const messagesById = useMemo(() => {
    const byId: Record<string, PortalChatMessage> = {};
    for (const message of messages) {
      byId[message.messageId] = message;
    }
    return byId;
  }, [messages]);
  const client = useOptionalCanopyClient();
  const pendingPresentations = useMemo(() => {
    if (!client) return new Set<string>();
    const existing = pendingFirstSendPresentations.get(client);
    if (existing) return existing;
    const pending = new Set<string>();
    pendingFirstSendPresentations.set(client, pending);
    return pending;
  }, [client]);
  const pendingInThisChat =
    chatId !== undefined && pendingPresentations.has(chatId);
  // A first turn held for its worktree's setup starts with no timer frame,
  // so this view shows it starting even when another host sent it.
  const heldForSetup = isFirstTurnHeldForSetup(
    turnGroups,
    messagesById,
    worktreeSetup?.phase,
  );
  const startingFirstTurn =
    firstSendStartingEnabled &&
    status !== 'error' &&
    turnGroups.length === 1 &&
    isTurnAwaitingFirstOutput(
      turnGroups[0],
      messagesById,
      pendingInThisChat || heldForSetup,
    ) &&
    (status === 'streaming' || pendingInThisChat || heldForSetup);
  // A user acknowledgement can precede the timer's streaming event. Once
  // shown, retain this chat's presentation until output or a terminal state.
  useLayoutEffect(() => {
    const active =
      firstSendStartingEnabled &&
      status !== 'error' &&
      (footerStatus != null || startingFirstTurn);
    if (chatId === undefined) return;
    if (active) pendingPresentations.add(chatId);
    else pendingPresentations.delete(chatId);
  }, [
    chatId,
    firstSendStartingEnabled,
    footerStatus,
    pendingPresentations,
    startingFirstTurn,
    status,
  ]);
  // Resolved once for the first turn, whose starting status this transcript
  // renders in its footer slot (the turn itself shows none).
  const startingStatus = resolveTurnStartingStatus({
    starting: startingFirstTurn,
    worktreeSetupPhase: worktreeSetup?.phase,
    worktreeCreatedAt: worktreeSetup?.createdAt,
    fallbackStartedAtMs:
      turnGroups.length > 0
        ? messagesById[turnGroups[0].userMessageId]?.createdAtMs
        : undefined,
    projectName: worktreeSetup?.projectName,
    // Only clamps a clock-skewed future origin, so the result stays stable
    // across renders. A mount time would overstate a later origin.
    nowMs: Date.now(),
  });
  // Keep the same live-region slot when an optimistic host footer becomes
  // an acknowledged first turn. The turn suppresses its duplicate status.
  const transcriptStatus =
    footerStatus ??
    (startingStatus !== null ? (
      <TurnWorkHeader
        starting
        {...(startingStatus.kind === 'setup' ? { setup: startingStatus } : {})}
        dataTestId="turn-starting-status"
      />
    ) : undefined);
  const hasFooter = footerSlot != null || transcriptStatus != null;
  // Each run renders once across the chat (CAN-4690): in its home turn,
  // or, while live, where the host lists it.
  const agentArtifactsByTurn = useChatAgentActivityPlacement(
    turnGroups,
    messagesById,
    liveRunKeys,
  );
  const latestMessageSignal = getLatestMessageSignal(messages);
  // Shared predicate from @canopy/app-state (same shape rule as the turn-group
  // float, aligned with the store's liveness rule): scoped to the current turn
  // so an orphaned timer from an interrupted earlier turn cannot suppress the
  // fallback spinner. The real cost win is the predicate's early break at the
  // last user message; the useMemo only skips recomputes for renders that keep
  // the same messages array (e.g. status/error changes).
  const liveTurnTimer = useMemo(() => hasLiveTurnTimer(messages), [messages]);
  const cleanChatLook = useCleanChatLook();
  const workingStatus = useTurnWorkingStatus();
  const delivering = deliveringMessages ?? EMPTY_DELIVERING_MESSAGES;
  // Fallback feedback for the send→timer gap and for hosts that never emit turn
  // timers; once a live timer row is on screen it owns the spinner (CAN-2342).
  //
  // Rendered INSIDE the last turn group (see `workingSlot`) so it occupies the
  // same slot the turn's own `turn_timer` row will, rather than below the
  // turn's action row — otherwise the indicator jumps up past the fork control
  // the moment the real timer frame arrives. `px-3` is `ChatMessageView`'s
  // bubble-text inset, which every in-group row including the timer sits on.
  //
  // `role="status"` ONLY when a host supplied a working label. The label is the
  // sole announceable content: the spinner's `aria-label` sits on a roleless
  // `<span>` that Chromium drops, so a region without a label announces nothing
  // it should — while `role="status"` implies `aria-atomic="true"`, so any AT
  // that DOES expose that name would read "Thinking" on every turn. Gating
  // keeps the announcement on the one surface that populates it
  // (`TurnWorkingStatusProvider`, mounted by the web portal's chat panel) and
  // leaves every other caller's DOM unchanged. Chromium fires a live-region
  // change when a populated `status` node is inserted, which is how this row
  // always appears. It does NOT make every working label announceable: on a
  // host that emits turn timers the `liveTurnTimer` guard hides this row
  // mid-turn, and the `TurnTimer` row that then owns the label has no live
  // region.
  // Clean chat look: shimmering words in place of the spinner. A delivering
  // prompt is the start of a turn, so it shows the same row under itself.
  const working =
    transcriptStatus == null &&
    (status === 'streaming' || delivering.length > 0) &&
    !liveTurnTimer;
  const workingRow =
    working && cleanChatLook ? (
      // The same row, line and height as the turn's live timer row that
      // takes over from it, so nothing moves when the timer arrives.
      <TurnFooterRow
        hostTurnGap
        {...(workingStatus === null ? {} : { role: 'status' })}
        data-testid="chat-transcript-streaming"
      >
        <ChatToolStepGroup
          summary=""
          live={{
            label: workingStatus ?? 'Thinking',
            icon: null,
          }}
        />
      </TurnFooterRow>
    ) : working ? (
      <div
        {...(workingStatus === null ? {} : { role: 'status' })}
        className="flex items-center gap-2 px-3 py-1 text-xs fg-secondary"
        data-testid="chat-transcript-streaming"
      >
        <ThinkingSpinner />
        {workingStatus !== null && <span>{workingStatus}</span>}
      </div>
    ) : null;
  const turnWorkingRow = delivering.length === 0 ? workingRow : null;

  const leaveBottom = (): void => {
    pinned.current = false;
    readerScrollTop.current = scrollRef.current?.scrollTop ?? 0;
  };

  // A wake's boundary row brings the tool call that started its task into
  // view, opening the turn that folds it away. Without the call loaded, it
  // brings the prompt's bubble instead. Either way only that row highlights.
  const [revealedCall, setRevealedCall] = useState<{
    turnId: string;
    request: { toolUseId: string };
  } | null>(null);
  const callFocusFrame = useRef<number | null>(null);
  const callHighlight = useRef<{
    element: HTMLElement;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const clearCallFocus = useCallback((): void => {
    const active = callHighlight.current;
    if (active) {
      clearTimeout(active.timer);
      delete active.element.dataset.chatCallFocus;
      callHighlight.current = null;
    }
    if (callFocusFrame.current !== null) {
      cancelAnimationFrame(callFocusFrame.current);
      callFocusFrame.current = null;
    }
  }, []);
  useEffect(() => clearCallFocus, [clearCallFocus]);

  const showSpawningCall = ({
    toolUseId,
    userMessageId,
    onReveal,
  }: {
    readonly toolUseId?: string;
    readonly userMessageId?: string;
    readonly onReveal?: () => void;
  }): void => {
    const callIndex =
      toolUseId === undefined
        ? -1
        : turnGroups.findIndex((group) =>
            turnHoldsToolCall(group, messagesById, toolUseId),
          );
    const showsCall = callIndex >= 0 && toolUseId !== undefined;
    const index = showsCall
      ? callIndex
      : turnGroups.findIndex((group) => group.userMessageId === userMessageId);
    const turnGroup = turnGroups[index];
    if (!turnGroup) return;
    leaveBottom();
    clearCallFocus();
    if (showsCall)
      setRevealedCall({
        turnId: turnGroup.userMessageId,
        request: { toolUseId },
      });
    const findRow = (): HTMLElement | null | undefined => {
      const turn = Array.from(
        scrollRef.current?.querySelectorAll<HTMLElement>('[data-turn-id]') ??
          [],
      ).find((element) => element.dataset.turnId === turnGroup.userMessageId);
      if (!showsCall)
        return turn?.querySelector<HTMLElement>('[data-role="user"]');
      return Array.from(
        turn?.querySelectorAll<HTMLElement>('[data-tool-use-id]') ?? [],
      ).find((element) => element.dataset.toolUseId === toolUseId);
    };
    let framesLeft = CALL_FOCUS_MAX_FRAMES;
    const reveal = (): void => {
      callFocusFrame.current = null;
      const row = findRow();
      if (row) {
        row.scrollIntoView({ block: showsCall ? 'center' : 'start' });
        onReveal?.();
        row.dataset.chatCallFocus = 'true';
        const timer = setTimeout(() => {
          delete row.dataset.chatCallFocus;
          callHighlight.current = null;
        }, CALL_FOCUS_HIGHLIGHT_MS);
        callHighlight.current = { element: row, timer };
        return;
      }
      if (virtualized) virtualizer.scrollToIndex(index, { align: 'start' });
      framesLeft -= 1;
      if (framesLeft > 0)
        callFocusFrame.current = requestAnimationFrame(reveal);
      else if (showsCall) showSpawningCall({ userMessageId });
    };
    // The call's turn renders it only after it opens.
    if (showsCall) callFocusFrame.current = requestAnimationFrame(reveal);
    else reveal();
  };

  // A pending question may live in an older, collapsed/virtualized turn.
  // Reuse the transcript's tool-call reveal path when this chat opens, waiting
  // for hydration to supply its call instead of merely exposing the panel.
  // Once revealed, streaming and question-state updates do not steal scroll.
  const questionInteraction = useAskUserQuestionInteraction();
  const revealedQuestionRef = useRef<string | undefined>(undefined);
  const showPendingQuestionRef = useRef(showSpawningCall);
  showPendingQuestionRef.current = showSpawningCall;
  useEffect(() => {
    // Cached tails can precede authoritative history. Revealing the cached
    // call early lets the later history load move the reader back to the tail.
    if (!initialized) return;
    const question = questionInteraction?.states.find(
      (state) => !state.answered,
    );
    if (question === undefined) return;
    const identity = JSON.stringify([chatId, question.requestId]);
    if (revealedQuestionRef.current === identity) return;
    const toolUseId = pendingQuestionToolUseId(messages, question);
    if (toolUseId === undefined) return;
    if (
      !turnGroups.some((group) =>
        turnHoldsToolCall(group, messagesById, toolUseId),
      )
    )
      return;
    // Record success after the row is shown. StrictMode can cancel a queued
    // frame during its effect cleanup, so scheduling alone cannot consume it.
    showPendingQuestionRef.current({
      toolUseId,
      onReveal: (): void => {
        revealedQuestionRef.current = identity;
      },
    });
  }, [
    initialized,
    chatId,
    questionInteraction?.states,
    turnGroups,
    messagesById,
    messages,
  ]);

  const followBottom = useCallback(() => {
    if (!pinned.current || scheduledScroll.current !== null) return;
    scheduledScroll.current = requestAnimationFrame(() => {
      scheduledScroll.current = null;
      const viewport = scrollRef.current;
      if (pinned.current && viewport)
        viewport.scrollTop = viewport.scrollHeight;
    });
  }, []);

  useEffect(followBottom, [
    followBottom,
    latestMessageSignal,
    messages.length,
    delivering.length,
    status,
  ]);

  // Sending is a request to be at the tail: a prompt the person sends or
  // queues re-arms bottom-follow even when they had scrolled up, and the
  // follow effects keep the reply in view until they scroll up again. Watcher
  // and steering prompts arrive on their own and leave the reader in place.
  const transcriptPrompts = useMemo(
    () => summarizeTranscriptPrompts(messages),
    [messages],
  );
  const sentPromptTracker = useRef<
    | (SentPromptSummary & {
        chatId: string | undefined;
        initialized: boolean;
        seenQueuedIds: Set<string>;
        seenQueuedPromptIds: Set<string>;
      })
    | null
  >(null);
  useLayoutEffect(() => {
    const previous = sentPromptTracker.current;
    const seenQueuedIds =
      previous !== null && previous.chatId === chatId
        ? previous.seenQueuedIds
        : new Set<string>();
    const seenQueuedPromptIds =
      previous !== null && previous.chatId === chatId
        ? previous.seenQueuedPromptIds
        : new Set<string>();
    for (const id of queuedPromptMessageIds ?? []) seenQueuedPromptIds.add(id);
    const next: SentPromptSummary = {
      ...transcriptPrompts,
      queuedCount: queuedPromptCount,
      queuedIds: queuedPromptIds,
      seenQueuedPromptIds,
    };
    const sentNewPrompt = previous !== null && detectSentPrompt(previous, next);
    for (const id of queuedPromptIds ?? []) seenQueuedIds.add(id);
    sentPromptTracker.current = {
      ...next,
      chatId,
      initialized,
      seenQueuedIds,
      seenQueuedPromptIds,
    };
    // A chat switch or a transcript that loads after mount adopts its
    // prompts as already seen: they were sent before this visit.
    if (
      previous === null ||
      previous.chatId !== chatId ||
      !previous.initialized ||
      !initialized
    )
      return;
    if (!sentNewPrompt) return;
    pinned.current = true;
    const viewport = scrollRef.current;
    if (!viewport) return;
    viewport.scrollTop = viewport.scrollHeight;
    readerScrollTop.current = viewport.scrollTop;
  }, [
    chatId,
    initialized,
    queuedPromptCount,
    queuedPromptIds,
    queuedPromptMessageIds,
    transcriptPrompts,
  ]);

  useLayoutEffect(() => {
    const viewport = scrollRef.current;
    if (pinned.current && viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [virtualHeight, messages.length]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const viewport = scrollRef.current;
      if (pinned.current && viewport)
        viewport.scrollTop = viewport.scrollHeight;
    });
    observer.observe(content);
    // The column also holds the footer, so a growing queue tail keeps a
    // pinned reader at the bottom.
    if (columnRef.current) observer.observe(columnRef.current);
    if (scrollRef.current) observer.observe(scrollRef.current);
    return (): void => observer.disconnect();
  }, [hasMessages, hasFooter]);

  useEffect(
    () => (): void => {
      if (scheduledScroll.current !== null) {
        cancelAnimationFrame(scheduledScroll.current);
        scheduledScroll.current = null;
      }
    },
    [],
  );

  // A queued first send has no messages yet but is not an empty chat: desktop
  // parity keeps the real transcript so the queue sits in the reading column.
  if (
    messages.length === 0 &&
    delivering.length === 0 &&
    footerSlot == null &&
    transcriptStatus == null
  ) {
    return (
      <div
        className="flex h-full items-center justify-center p-6 text-center text-s fg-secondary"
        data-testid="chat-transcript-empty"
      >
        {emptyState ?? <span>Send a message to start working</span>}
      </div>
    );
  }

  return (
    <div
      // `overscroll-contain` keeps a momentum scroll that reaches the top or
      // bottom of the transcript from chaining to the page/body behind it on
      // touch devices (CAN-1206). It has no effect on non-overscrolling
      // desktop scroll, so the desktop transcript is unchanged.
      className="flex h-full min-h-0 flex-col overflow-y-auto overscroll-contain p-3 [&_[data-chat-call-focus]]:rounded-lg [&_[data-chat-call-focus]]:ring-2 [&_[data-chat-call-focus]]:ring-line-accent"
      data-testid="chat-transcript"
      data-turn-count={turnGroups.length}
      ref={scrollRef}
      style={{ overflowAnchor: 'none' }}
      tabIndex={0}
      onClickCapture={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest('[data-step-row][aria-expanded]')
        )
          leaveBottom();
      }}
      onWheel={(event) => {
        if (event.deltaY < 0) leaveBottom();
      }}
      onKeyDown={(event) => {
        if (
          event.defaultPrevented ||
          (event.target instanceof Element &&
            event.target.closest(
              'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]',
            ))
        )
          return;
        if (
          ['ArrowUp', 'PageUp', 'Home'].includes(event.key) ||
          (event.key === ' ' && event.shiftKey)
        )
          leaveBottom();
      }}
      onPointerDown={(event) => {
        const viewport = event.currentTarget;
        const rect = viewport.getBoundingClientRect();
        if (event.clientX >= rect.left + viewport.clientWidth) leaveBottom();
      }}
      onTouchStart={(event) => {
        touchY.current = event.touches[0]?.clientY ?? null;
      }}
      onTouchMove={(event) => {
        const nextY = event.touches[0]?.clientY;
        if (
          nextY !== undefined &&
          touchY.current !== null &&
          nextY > touchY.current
        )
          leaveBottom();
        touchY.current = nextY ?? null;
      }}
      onScroll={() => {
        const viewport = scrollRef.current;
        if (!viewport) return;
        const nearBottom =
          viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <
          64;
        if (viewport.scrollTop > readerScrollTop.current && nearBottom)
          pinned.current = true;
        // A scroll up and away from the bottom without a gesture (find
        // revealing an earlier match) also releases bottom-follow; layout
        // growth never moves the reader up, and a shrink stays near bottom.
        else if (viewport.scrollTop < readerScrollTop.current && !nearBottom)
          pinned.current = false;
        readerScrollTop.current = viewport.scrollTop;
        if (
          !pinned.current &&
          viewport.scrollTop < 64 &&
          onLoadOlder &&
          !loadingOlder.current
        ) {
          loadingOlder.current = true;
          const height = viewport.scrollHeight;
          const top = viewport.scrollTop;
          void onLoadOlder()
            .then(() => {
              requestAnimationFrame(() => {
                viewport.scrollTop = top + viewport.scrollHeight - height;
              });
            })
            .catch(() => {})
            .finally(() => {
              loadingOlder.current = false;
            });
        }
      }}
    >
      {/* Desktop parity: the desktop message list centers its content on the
          shared `--chat-reading-width` token; the same column here keeps a
          web chat at the desktop's measure instead of running edge to edge. */}
      <div
        ref={columnRef}
        className="mx-auto flex w-full max-w-[var(--chat-reading-width)] chat-width-transition shrink-0 flex-col gap-2"
      >
        <div
          ref={contentRef}
          className={virtualized ? 'relative shrink-0' : 'flex flex-col gap-2'}
          style={
            virtualized ? { height: virtualizer.getTotalSize() } : undefined
          }
        >
          {(virtualized
            ? virtualizer.getVirtualItems()
            : turnGroups.map((_, index) => ({
                index,
                key: turnGroups[index].userMessageId,
                start: 0,
              }))
          ).map((item) => {
            const index = item.index;
            const turnGroup = turnGroups[index];
            return (
              <div
                key={turnGroup.userMessageId}
                data-testid={
                  virtualized ? 'chat-transcript-virtual-turn' : undefined
                }
                data-turn-id={turnGroup.userMessageId}
                data-index={index}
                ref={virtualized ? virtualizer.measureElement : undefined}
                className={virtualized ? 'absolute top-0 w-full' : undefined}
                style={
                  virtualized
                    ? { transform: `translateY(${item.start}px)` }
                    : undefined
                }
              >
                <TurnGroupView
                  key={turnGroup.userMessageId}
                  turnGroup={turnGroup}
                  resultsComplete={resultsComplete}
                  messagesById={messagesById}
                  agentArtifacts={agentArtifactsByTurn[turnGroup.userMessageId]}
                  appIcon={appIcon}
                  onShowSpawningCall={showSpawningCall}
                  {...(revealedCall?.turnId === turnGroup.userMessageId
                    ? { revealRequest: revealedCall.request }
                    : {})}
                  latest={index === turnGroups.length - 1}
                  starting={startingFirstTurn && index === 0}
                  startingStatusSlot={false}
                  {...(index === turnGroups.length - 1 && renderLatestTurnAction
                    ? {
                        actionSlot: renderLatestTurnAction({
                          disabled: status === 'streaming',
                        }),
                      }
                    : {})}
                  {...(index === turnGroups.length - 1 &&
                  turnWorkingRow !== null
                    ? { workingSlot: turnWorkingRow }
                    : {})}
                  // `userMessageId` IS the renderer's per-turn `msg-{n}-{epochMs}`:
                  // the persisted-chat projection maps `messageId: message.id`, so no
                  // extra lookup is needed to reach the correlation key.
                  // A host can rate every response independently, including
                  // a background reply headed by a wake boundary.
                  {...(renderTurnFeedback
                    ? {
                        feedbackSlot: renderTurnFeedback(
                          turnGroup.userMessageId,
                        ),
                      }
                    : {})}
                />
              </div>
            );
          })}
        </div>

        {/* Before the first turn group exists there is no slot to sit in, so
            the row renders here instead. `-mt-1` trims the column's `gap-2`
            back to the `space-y-1` rhythm the in-group placement gets. */}
        {turnGroups.length === 0 && turnWorkingRow !== null && (
          <div className="-mt-1">{turnWorkingRow}</div>
        )}

        {/* A prompt on its way to an idle agent reads as the next turn's
            prompt, as `TurnGroupView` lays one out; a host status replaces the
            working row (a first send's own status). */}
        {delivering.length > 0 && (
          <div
            className={
              cleanChatLook ? 'flex flex-col gap-2' : 'flex flex-col gap-1'
            }
            data-testid="chat-transcript-delivering"
          >
            {delivering.map((message) => (
              <ChatMessageView
                key={message.messageId}
                message={message}
                appIcon={appIcon}
              />
            ))}
            {cleanChatLook ? (
              <div aria-hidden="true" className="h-2.5" />
            ) : null}
            {transcriptStatus == null ? workingRow : null}
          </div>
        )}

        {status === 'error' &&
          error &&
          !latestTurnShowsError(turnGroups, messagesById, error) && (
            // An agent or server error can quote the conversation.
            <div className={REPLAY_BLOCK_CLASS}>
              <ErrorBanner
                className=""
                error={error}
                testId="chat-transcript-error"
              />
            </div>
          )}

        {footerSlot}

        {transcriptStatus}

        <div />
      </div>
    </div>
  );
}
