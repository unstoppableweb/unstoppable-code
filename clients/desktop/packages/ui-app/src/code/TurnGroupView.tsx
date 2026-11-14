'use client';

import { memo, useEffect, useMemo, type JSX, type ReactNode } from 'react';
import {
  computePortalTurnOutcomes,
  getPortalTurnOutcomeSteps,
} from '@canopy/app-state';
import type { AgentArtifactReceiptV1 } from '@canopy/protocol/agent-artifacts';
import type {
  PortalChatMessage,
  PortalChatTurnGroup,
} from '@canopy/protocol/portal';
import {
  ChatCopyAction,
  ChatToolStepGroup,
  PlanCopyAction,
  CollapsedTurnSummary,
  getElapsedSecond,
  getToolDisplayFamily,
  isAskUserQuestionToolName,
  isToolDenial,
  portalAskUserQuestionRecordState,
  parseAskUserQuestionTexts,
  TurnFooterReveal,
  TurnFooterRow,
  WakeTurnBoundary,
  TurnWorkHeader,
  ToolApprovalWaitProvider,
  isStartingTurnOutput,
  orderTurnOutcomeSteps,
  resolveTurnCompletionStatus,
  STEP_GROUP_BODY_CLASS,
  useChatDetail,
  useTurnCollapse,
  useGroupToolCalls,
  type TurnSummary,
} from '@canopy/ui-shared/components';
import { ChatMessageView, normalizeChatMessageParts } from './ChatMessageView';
import {
  ToolTurnSettledContext,
  useAskUserQuestionInteraction,
  useTurnWorkingStatus,
} from './ChatPartView';
import {
  cleanLiveActivity,
  describeCleanTurnSteps,
  recentStepWindow,
  stepParts,
  segmentCleanTurn,
} from './clean-turn-steps';
import { ChatVisualBlock } from './ChatVisualBlock';
import { readChatToolResultVisual } from './ChatToolResultPart';
import { useChatVisualHost } from './chat-visual-host';
import { TurnAgentArtifacts } from './agent-activity/TurnAgentArtifacts';
import { TurnFiles } from './TurnFiles';
import { portalTurnApprovalWait } from './turn-approval-wait';
import { usePortalTurnPlanCopy } from './plan-turn-tool-calls';

export function isTurnAwaitingFirstOutput(
  turnGroup: PortalChatTurnGroup,
  messagesById: Readonly<Record<string, PortalChatMessage>>,
  awaitingTimer = false,
): boolean {
  return (
    (turnGroup.complete !== true ||
      // A complete user row alone is not a terminal turn acknowledgement.
      (awaitingTimer &&
        turnGroup.intermediateMessageIds.length === 0 &&
        turnGroup.finalMessageIds.length === 0)) &&
    messagesById[turnGroup.userMessageId] !== undefined &&
    !lookup(
      [...turnGroup.intermediateMessageIds, ...turnGroup.finalMessageIds],
      messagesById,
    ).some(
      (message) =>
        message.status === 'failed' ||
        message.status === 'cancelled' ||
        (message.role === 'assistant' &&
          (message.text.trim().length > 0 ||
            message.parts?.some((part) =>
              isStartingTurnOutput(part.kind, part.data),
            ))) ||
        message.parts?.some(
          (part) =>
            part.kind === 'turn_timer' &&
            isRecord(part.data) &&
            typeof part.data.completedAt === 'number',
        ),
    )
  );
}

/**
 * Whether a chat's only turn is the one its host holds while the chat's
 * worktree finishes its Git setup. Nothing else runs in a `git-pending`
 * worktree, so an unanswered first turn there is that held turn, which has
 * no timer until it dispatches: a host that did not send it still shows it
 * starting.
 */
export function isFirstTurnHeldForSetup(
  turnGroups: readonly PortalChatTurnGroup[],
  messagesById: Readonly<Record<string, PortalChatMessage>>,
  worktreeSetupPhase: string | undefined,
): boolean {
  return (
    worktreeSetupPhase === 'git-pending' &&
    turnGroups.length === 1 &&
    isTurnAwaitingFirstOutput(turnGroups[0], messagesById, true)
  );
}

/**
 * Renders one {@link PortalChatTurnGroup}: the user prompt, the collapsed
 * "intermediate" tool/thinking steps behind a {@link CollapsedTurnSummary} chip
 * (expandable), then the inline "final" assistant messages. Mirrors the desktop
 * `TurnGroupRenderer` / web collapsed-turn UX over the neutral store types.
 *
 * Messages are looked up by id from `messagesById` (the transcript owns the
 * flat message map); ids that are not present are skipped.
 */
export interface TurnGroupViewProps {
  /** First send is accepted locally and is waiting for its first visible output. */
  readonly starting?: boolean;
  /** A transcript can own the stable live region outside this turn. */
  readonly startingStatusSlot?: ReactNode;
  /** The host confirms no results were omitted from this transcript snapshot. */
  readonly resultsComplete?: boolean;
  readonly turnGroup: PortalChatTurnGroup;
  readonly messagesById: Readonly<Record<string, PortalChatMessage>>;
  readonly appIcon?: ReactNode;
  /**
   * Turn-level thumbs up/down control (CAN-1521), rendered at the foot of the
   * turn beside its completion stamp. Omitted when the host does not report
   * the `turnFeedback` capability, so an unwired host renders nothing rather
   * than throwing on dispatch.
   */
  readonly feedbackSlot?: ReactNode;
  /** Optional host-owned action rendered at the foot of this turn. */
  readonly actionSlot?: ReactNode;
  /**
   * The transcript's fallback working indicator, for the send→timer gap on the
   * last turn only. It renders exactly where this turn's `turn_timer` row would
   * (after the finals, before {@link actionSlot}) so the indicator does not move
   * when the real timer frame arrives and takes over.
   */
  readonly workingSlot?: ReactNode;
  /** Brings a wake's spawning tool call (or its prompt) into view. */
  readonly onShowSpawningCall?: (target: {
    readonly toolUseId?: string;
    readonly userMessageId?: string;
  }) => void;
  /**
   * Opens this turn so the host can bring the call into view. A new object
   * for each request.
   */
  readonly revealRequest?: { readonly toolUseId: string };
  /**
   * Whether this is the newest turn. Under the clean chat look its reply row
   * stays in view, as ChatGPT does; older rows show on hover or focus.
   */
  readonly latest?: boolean;
  /**
   * The turn's Agent activity receipts after the transcript placed each run
   * once across the chat (CAN-4690). Omitted, the turn collects its own.
   */
  readonly agentArtifacts?: readonly AgentArtifactReceiptV1[];
}

/**
 * Map the `*Count` wire summary onto the ui-shared camelCase {@link TurnSummary}.
 * Note: `TurnSummary.appAdvisor` / `pipelineEditor` are intentionally unset —
 * the shared protocol summary folds those tool families into `otherCount`, so
 * they render in the generic "other" chip. Add mappings here if the wire summary
 * grows dedicated count fields.
 */
function toTurnSummary(
  summary: NonNullable<PortalChatTurnGroup['summary']>,
  intermediates: readonly PortalChatMessage[],
): TurnSummary {
  const displaySummary: TurnSummary = {
    thinking: summary.thinkingCount,
    messages: summary.messageCount,
    bash: summary.bashCount,
    read: summary.readCount,
    edit: summary.editCount,
    write: summary.writeCount,
    plan: summary.planCount,
    grep: summary.grepCount,
    glob: summary.globCount,
    todo: summary.todoCount,
    web: summary.webCount,
    agent: summary.agentCount,
    askUser: summary.askUserCount,
    scriptOutput: summary.scriptOutputCount,
    claude: summary.claudeCount,
    watcher: summary.watcherCount,
    canopy: summary.canopyCount,
    graph: summary.graphCount,
    computerUse: summary.computerUseCount,
    other: summary.otherCount,
  };
  if (!summary.bashCount) return displaySummary;
  for (const message of intermediates) {
    for (const part of normalizeChatMessageParts(message.parts ?? [])) {
      if (part.kind !== 'tool_use' || part.toolFamily !== 'bash') continue;
      const data = isRecord(part.data) ? part.data : {};
      const toolName = typeof data.toolName === 'string' ? data.toolName : '';
      const input =
        typeof data.input === 'string'
          ? data.input
          : JSON.stringify(data.input ?? '');
      const family = getToolDisplayFamily(toolName, input, part.toolFamily);
      if (family !== 'read' && family !== 'skill') continue;
      displaySummary.bash = Math.max(0, (displaySummary.bash ?? 0) - 1);
      const key = family === 'read' ? 'read' : 'other';
      displaySummary[key] = (displaySummary[key] ?? 0) + 1;
    }
  }
  return displaySummary;
}

function lookup(
  ids: readonly string[],
  messagesById: Readonly<Record<string, PortalChatMessage>>,
): PortalChatMessage[] {
  return ids
    .map((id) => messagesById[id])
    .filter((message): message is PortalChatMessage => message !== undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readAskUserMatch(message: PortalChatMessage): {
  toolName: string;
  toolUseId?: string;
  questionTexts?: string[];
} | null {
  for (const part of normalizeChatMessageParts(message.parts ?? [])) {
    if (part.kind !== 'tool_use') continue;
    const data = isRecord(part.data) ? part.data : {};
    const toolName =
      typeof data.toolName === 'string'
        ? data.toolName
        : typeof data.name === 'string'
          ? data.name
          : '';
    if (!isAskUserQuestionToolName(toolName)) continue;
    const rawInput = data.input;
    const input =
      typeof rawInput === 'string'
        ? rawInput
        : rawInput === undefined
          ? undefined
          : JSON.stringify(rawInput);
    const toolUseId =
      typeof data.toolUseId === 'string'
        ? data.toolUseId
        : typeof data.tool_use_id === 'string'
          ? data.tool_use_id
          : undefined;
    const questionTexts = input ? parseAskUserQuestionTexts(input) : undefined;
    return {
      toolName,
      ...(toolUseId ? { toolUseId } : {}),
      ...(questionTexts ? { questionTexts } : {}),
    };
  }
  return null;
}

/** A message that only carries the turn's completion stamp. */
function isTimerOnly(message: PortalChatMessage): boolean {
  const parts = message.parts ?? [];
  return (
    message.text.trim().length === 0 &&
    parts.length > 0 &&
    parts.every((part) => part.kind === 'turn_timer')
  );
}

/**
 * Whether a timer-only message renders a timer row. A settled message whose
 * timer never completed is an interrupted turn, and ChatPartView renders
 * nothing for it.
 */
function rendersTimerRow(message: PortalChatMessage): boolean {
  return (
    message.status === 'streaming' ||
    (message.parts ?? []).some(
      (part) =>
        part.kind === 'turn_timer' &&
        isRecord(part.data) &&
        typeof part.data.completedAt === 'number',
    )
  );
}

function hasFoldableContent(message: PortalChatMessage): boolean {
  return (
    message.text.trim().length > 0 ||
    (message.parts ?? []).some((part) => part.kind !== 'turn_timer')
  );
}

function TurnGroupViewImpl({
  turnGroup,
  messagesById,
  appIcon,
  feedbackSlot,
  actionSlot,
  workingSlot,
  onShowSpawningCall,
  revealRequest,
  latest = false,
  starting = false,
  startingStatusSlot,
  agentArtifacts,
  resultsComplete: hostResultsComplete = false,
}: TurnGroupViewProps): JSX.Element {
  const complete = turnGroup.complete === true;
  const askUserInteraction = useAskUserQuestionInteraction();
  const visualHost = useChatVisualHost();
  // Clean chat look: the turn opens with "Working for 28s" and, once done,
  // its folded steps' header reads "Worked for 3m 24s". Every step between
  // two replies is one line; the running turn's tail shimmers what it does.

  const groupToolCalls = useGroupToolCalls();
  // Chat detail `recent`: the run the turn is still adding to keeps its
  // newest steps in view under its line.
  const chatDetail = useChatDetail();
  const recentSteps = chatDetail === 'recent';
  const [collapsed, setCollapsed] = useTurnCollapse(complete, chatDetail);
  const workingStatus = useTurnWorkingStatus();

  const user = messagesById[turnGroup.userMessageId];
  const spawningUserMessageId = turnGroup.wake?.spawningUserMessageId;
  const spawningToolUseId = turnGroup.wake?.spawningToolUseId;
  const intermediates = lookup(turnGroup.intermediateMessageIds, messagesById);
  const finals = lookup(turnGroup.finalMessageIds, messagesById);
  const expandedMessages = lookup(
    turnGroup.expandedMessageIds ?? [
      ...turnGroup.intermediateMessageIds,
      ...turnGroup.finalMessageIds,
    ],
    messagesById,
  );
  // Receipts may sit on any assistant row of the turn, folded or not, so the
  // tiles read every intermediate and final message in order.
  const assistantMessages = useMemo(
    () =>
      lookup(
        [...turnGroup.intermediateMessageIds, ...turnGroup.finalMessageIds],
        messagesById,
      ),
    [turnGroup.intermediateMessageIds, turnGroup.finalMessageIds, messagesById],
  );
  const showStarting =
    starting && isTurnAwaitingFirstOutput(turnGroup, messagesById);
  // The completion stamp closes the turn, so the capability tiles sit above
  // it, as they do on desktop.
  const lastFinal = finals[finals.length - 1];
  const trailingTimer =
    lastFinal !== undefined && isTimerOnly(lastFinal) ? lastFinal : undefined;
  const summary: TurnSummary = turnGroup.summary
    ? toTurnSummary(turnGroup.summary, intermediates)
    : {};
  const timerMessages = [...intermediates, ...finals].filter((message) =>
    message.parts?.some((part) => part.kind === 'turn_timer'),
  );
  const timerMessage =
    timerMessages[timerMessages.length - 1] ?? finals[finals.length - 1];
  const timerData = timerMessage?.parts?.find(
    (part) => part.kind === 'turn_timer',
  )?.data;
  // Only a completion stamp settles the turn; its unresolved calls then
  // render interrupted rather than pending.
  const turnSettled =
    isRecord(timerData) && typeof timerData.completedAt === 'number';
  // A missing result is evidence of an interruption only when the turn has
  // settled and the host confirms all results are available. Loading every
  // known id in a bounded snapshot does not prove result completeness.
  const resultsComplete =
    hostResultsComplete &&
    assistantMessages.length ===
      turnGroup.intermediateMessageIds.length +
        turnGroup.finalMessageIds.length;
  const outcomeEvidence = useMemo(
    () => ({ settled: complete && turnSettled, resultsComplete }),
    [complete, turnSettled, resultsComplete],
  );
  const approvalWait = useMemo(
    () =>
      portalTurnApprovalWait({
        complete: complete || turnSettled,
        timer: timerData,
        messages: assistantMessages,
      }),
    [complete, turnSettled, timerData, assistantMessages],
  );
  // Outcomes among the folded steps, matched with results anywhere in the
  // turn. The Portal carries no safety receipt, so a denial is recognized by
  // its text, as the step line does.
  const outcomes = useMemo(
    () =>
      computePortalTurnOutcomes(
        lookup(turnGroup.intermediateMessageIds, messagesById),
        assistantMessages,
        outcomeEvidence,
        isToolDenial,
      ),
    [
      turnGroup.intermediateMessageIds,
      messagesById,
      assistantMessages,
      outcomeEvidence,
    ],
  );
  // The blocked, errored and interrupted steps behind `outcomes`, for the
  // outcome tooltip; most turns have none, so nothing is collected for them.
  const outcomeSteps = useMemo(
    () =>
      outcomes.blocked === 0 &&
      outcomes.failed === 0 &&
      outcomes.interrupted === 0
        ? []
        : orderTurnOutcomeSteps(
            getPortalTurnOutcomeSteps(
              lookup(turnGroup.intermediateMessageIds, messagesById),
              assistantMessages,
              outcomeEvidence,
              isToolDenial,
            ),
          ),
    [
      outcomes.blocked,
      outcomes.failed,
      outcomes.interrupted,
      turnGroup.intermediateMessageIds,
      messagesById,
      assistantMessages,
      outcomeEvidence,
    ],
  );
  const endReason = isRecord(timerData) ? timerData.endReason : undefined;
  // One resolved end for the summary, header and footer: a recorded failure
  // or cancellation, then the projected restart evidence, then any
  // interrupted step. Nothing terminal while the turn runs.
  const recordedEnd =
    timerMessage?.status === 'failed' || timerMessage?.status === 'cancelled'
      ? timerMessage.status
      : endReason === 'failed' ||
          endReason === 'cancelled' ||
          endReason === 'interrupted'
        ? endReason
        : undefined;
  const completionStatus = resolveTurnCompletionStatus({
    // A failed or cancelled row has ended even before its group says so.
    settled:
      complete ||
      turnSettled ||
      recordedEnd === 'failed' ||
      recordedEnd === 'cancelled',
    recorded: recordedEnd,
    outcomes,
  });
  const outcome =
    completionStatus === 'complete' ? undefined : completionStatus;
  // Clicking the outcome, or a tooltip entry, reveals that call the way a
  // wake's spawning call is revealed: the turn and its step group open, and
  // the row scrolls into view with the call-focus ring.
  const firstOutcomeStep = outcomeSteps[0];
  const onJumpToOutcome =
    onShowSpawningCall && firstOutcomeStep
      ? (toolUseId?: string): void =>
          onShowSpawningCall({
            toolUseId: toolUseId ?? firstOutcomeStep.toolUseId,
          })
      : undefined;
  const foldable = complete && intermediates.some(hasFoldableContent);
  // Opened as saved state, so the person can collapse the turn again.
  useEffect(() => {
    if (revealRequest) setCollapsed(false);
  }, [revealRequest, setCollapsed]);
  // A pending projected question must remain visible without asking the user
  // to discover it inside the collapsed agent-steps row. Match the
  // intermediate transcript block using the same Claude/Codex rules as the
  // card renderer.
  // Only an UNANSWERED projection forces the turn open — that is the card the
  // user must not miss. Answered projections exist to converge the tool row
  // to its read-only answered state (CAN-2608 retains them indefinitely for
  // App Advisor), and pinning those turns expanded forever would make every
  // historical question turn non-collapsible.
  const hasProjectedAskUser =
    askUserInteraction !== null &&
    intermediates.some((message) => {
      const match = readAskUserMatch(message);
      return (
        match !== null &&
        portalAskUserQuestionRecordState(askUserInteraction.states, match)
          .kind === 'unanswered'
      );
    });
  const isExpanded = !collapsed || hasProjectedAskUser;
  const showTrailingTimer =
    trailingTimer !== undefined &&
    (!foldable || !isExpanded || expandedMessages.includes(trailingTimer));
  // The actions and thumbs ride in the timer row only when it renders.
  const inTimerRow =
    showTrailingTimer &&
    trailingTimer !== undefined &&
    rendersTimerRow(trailingTimer);
  const feedback = feedbackSlot ? (
    <span
      data-testid="chat-turn-feedback"
      className="flex items-center gap-0.5"
    >
      {feedbackSlot}
    </span>
  ) : undefined;
  const timer = readTurnHeaderTimer(timerData);
  // The reply's Copy button copies the answer, or every reply text when the
  // turn has no final message, under either chat look (CAN-4704).
  const textOf = (messages: readonly PortalChatMessage[]): string =>
    messages
      .map(replyTextOf)
      .filter((text) => text.trim() !== '')
      .join('\n\n');
  const replyCopyText = textOf(finals) || textOf(intermediates);
  // A finished plan turn copies its plan instead of its prose, and keeps the
  // action while the plan's Markdown is unavailable (CAN-5354).
  const planCopy = usePortalTurnPlanCopy(assistantMessages, complete);
  const collapsedVisuals = intermediates.flatMap((message) =>
    (message.parts ?? []).flatMap((part, index) => {
      const owner =
        part.kind === 'tool_result'
          ? readChatToolResultVisual(part.data, message.messageId)
          : undefined;
      return owner
        ? [
            <ChatVisualBlock
              key={`${message.messageId}-${index}`}
              owner={owner}
              variant="visual-only"
            />,
          ]
        : [];
    }),
  );
  // Segment every clean turn so step spacing does not depend on provider
  // message boundaries. Detail controls folding, not the step container.
  const cleanSegments = segmentCleanTurn(
    (foldable && !isExpanded
      ? finals
      : foldable
        ? expandedMessages
        : [...intermediates, ...finals]
    ).filter((message) => message !== trailingTimer),
  );
  const lastCleanSegment = cleanSegments[cleanSegments.length - 1];
  const liveRun =
    !complete && lastCleanSegment?.kind === 'steps'
      ? lastCleanSegment
      : undefined;
  // Without grouping, the step still running on screen shimmers itself.
  const shownMessages = [...intermediates, ...finals].filter(
    (message) => message !== trailingTimer,
  );
  const lastParts = shownMessages[shownMessages.length - 1]?.parts ?? [];
  const lastPart = lastParts[lastParts.length - 1];
  const stepShimmersOnScreen =
    lastPart !== undefined &&
    ((lastPart.kind === 'tool_use' &&
      !(isRecord(lastPart.data) && lastPart.data.result != null)) ||
      lastPart.kind === 'thinking');
  // The timer row is the live line's slot while the turn runs; empty while
  // a step line above already says what the turn does.
  const liveLineInSteps =
    (!groupToolCalls || recentSteps) && lastCleanSegment?.kind === 'steps';
  const liveLine =
    !complete &&
    (groupToolCalls && !recentSteps
      ? liveRun === undefined
      : !stepShimmersOnScreen) ? (
      // The timer row sits inside its message's text inset already.
      <ChatToolStepGroup
        summary=""
        inset={liveLineInSteps}
        live={cleanLiveActivity(undefined, workingStatus)}
      />
    ) : null;
  const fallbackCopy =
    planCopy !== undefined ? (
      <PlanCopyAction
        key={turnGroup.userMessageId}
        state={planCopy}
        appearance="footer"
        dataTestId="turn-copy-plan"
      />
    ) : complete && replyCopyText.trim() !== '' ? (
      <ChatCopyAction
        key={turnGroup.userMessageId}
        text={replyCopyText}
        dataTestId="turn-copy-message"
      />
    ) : undefined;
  const actions = actionSlot ? (
    <TurnFooterReveal
      completed={complete}
      completionStatus={outcome}
      // Clean chat look: the reply row is always in view.
      alwaysVisible={true}
      data-testid="chat-turn-action-slot"
    >
      {actionSlot}
    </TurnFooterReveal>
  ) : undefined;

  return (
    // `group/turn` scopes the hover/focus reveal of this turn's footer
    // (CAN-4278) and feedback control (CAN-1521), matching the desktop
    // per-turn wrapper.
    // Clean chat look: the desktop turn's 8px rhythm, with more room under
    // the prompt than between steps.
    <ToolTurnSettledContext.Provider
      value={outcomeEvidence.settled && outcomeEvidence.resultsComplete}
    >
      <ToolApprovalWaitProvider value={approvalWait}>
        <div
          className="group/turn flex flex-col gap-2"
          data-testid="chat-turn-group"
        >
          {turnGroup.wake ? (
            <WakeTurnBoundary
              taskLabel={turnGroup.wake.taskLabel}
              event={turnGroup.wake.event === true}
              scheduled={turnGroup.wake.scheduled === true}
              toolsLoaded={turnGroup.wake.toolsLoaded === true}
              onShowSpawningTurn={
                (spawningToolUseId !== undefined ||
                  spawningUserMessageId !== undefined) &&
                onShowSpawningCall
                  ? (): void =>
                      onShowSpawningCall({
                        toolUseId: spawningToolUseId,
                        userMessageId: spawningUserMessageId,
                      })
                  : undefined
              }
            />
          ) : (
            user && <ChatMessageView message={user} appIcon={appIcon} />
          )}

          {showStarting ? (
            startingStatusSlot === undefined ? (
              <TurnWorkHeader starting dataTestId="turn-starting-status" />
            ) : (
              startingStatusSlot
            )
          ) : (
            !complete && (
              <TurnWorkHeader
                startedAt={timer.startedAt}
                finishedAt={null}
                pausedAt={timer.pausedAt}
                resumedAt={timer.resumedAt}
                accumulatedPausedDurationMs={timer.accumulatedPausedDurationMs}
                live
                trailing={actionSlot}
                dataTestId="turn-work-header"
              />
            )
          )}

          <>
            {foldable && (
              <CollapsedTurnSummary
                summary={summary}
                isExpanded={isExpanded}
                onToggle={() => setCollapsed((value) => !value)}
                appIcon={appIcon}
                completionStatus={outcome}
                outcomes={outcomes}
                outcomeSteps={outcomeSteps}
                onJumpToOutcome={onJumpToOutcome}
                {...(timer.elapsedMs === undefined
                  ? {}
                  : { elapsedMs: timer.elapsedMs })}
              />
            )}
            {cleanSegments.map((segment) => {
              if (segment.kind === 'message') {
                return (
                  <ChatMessageView
                    key={segment.key}
                    message={segment.message}
                    appIcon={appIcon}
                  />
                );
              }
              const recent =
                recentSteps && segment === liveRun
                  ? recentStepWindow(segment)
                  : undefined;
              const renderSteps = (
                messages: typeof segment.messages,
              ): JSX.Element[] =>
                messages.map(({ key, message }) => (
                  <ChatMessageView
                    key={key}
                    message={message}
                    appIcon={appIcon}
                  />
                ));
              if (!groupToolCalls) {
                return (
                  <div
                    key={`clean-steps-${segment.key}`}
                    className={STEP_GROUP_BODY_CLASS}
                    data-testid="chat-tool-step-detailed"
                  >
                    {renderSteps(segment.messages)}
                    {segment === lastCleanSegment &&
                      liveLineInSteps &&
                      liveLine}
                  </div>
                );
              }
              // The line counts only the steps the window hides, so the
              // running step is said once, in its own row.
              const done = describeCleanTurnSteps(
                recent?.hidden ?? segment,
                outcomeEvidence,
              );
              // A call reveal opens the folded line that holds the call.
              const holdsRevealedCall =
                revealRequest !== undefined &&
                segment.messages.some(({ message }) =>
                  (message.parts ?? []).some(
                    (part) =>
                      (part.kind === 'tool_use' || part.kind === 'agent') &&
                      isRecord(part.data) &&
                      part.data.toolUseId === revealRequest.toolUseId,
                  ),
                );
              return (
                <ChatToolStepGroup
                  key={`clean-steps-${segment.key}`}
                  summary={done.label}
                  trailingActivity={recent !== undefined ? liveLine : undefined}
                  failedCount={done.failed}
                  blockedCount={done.blocked}
                  collapsedStepCount={
                    recent !== undefined && recent.hidden === undefined
                      ? 0
                      : stepParts(recent?.hidden ?? segment).filter(
                          (part) => part.kind !== 'thinking',
                        ).length
                  }
                  hiddenSteps={
                    recent?.hidden
                      ? renderSteps(recent.hidden.messages)
                      : undefined
                  }
                  interruptedCount={done.interrupted}
                  icon={done.icon}
                  openRequest={holdsRevealedCall ? revealRequest : undefined}
                  {...(recent !== undefined
                    ? { liveSteps: renderSteps(recent.shown) }
                    : segment === liveRun
                      ? {
                          live: cleanLiveActivity(
                            segment,
                            workingStatus,
                            approvalWait,
                          ),
                        }
                      : {})}
                >
                  {renderSteps(segment.messages)}
                </ChatToolStepGroup>
              );
            })}
            {foldable && !isExpanded && visualHost && collapsedVisuals}
          </>

          <TurnAgentArtifacts
            messages={assistantMessages}
            receipts={agentArtifacts}
          />

          <TurnFiles
            messages={assistantMessages}
            retained={turnGroup.files}
            complete={complete}
            latest={latest}
            turnId={turnGroup.userMessageId}
          />

          {!showStarting && showTrailingTimer && (
            <ChatMessageView
              key={trailingTimer.messageId}
              message={trailingTimer}
              appIcon={appIcon}
              {...(inTimerRow
                ? {
                    turnTimerStampAccessory: feedback,
                    // Like desktop, the turn actions follow the elapsed label.
                    turnTimerTrailing: actions,
                  }
                : {})}
              // ChatTranscript separates turns with an 8px column gap. Only the
              // turn's last row borders that gap; a row below keeps the full margin.
              turnTimerHostTurnGap={workingSlot == null}
              turnTimerLiveLine={liveLineInSteps ? null : liveLine}
              // Copy rides in the timer row only when it renders; otherwise the
              // actions row below carries it, so a reply never shows two.
              {...(inTimerRow && complete
                ? planCopy !== undefined
                  ? { turnTimerPlanCopy: planCopy }
                  : { turnTimerCopyText: replyCopyText }
                : {})}
              {...(outcome === undefined
                ? {}
                : { turnTimerCompletionStatus: outcome })}
            />
          )}

          {!showStarting && workingSlot}

          {/* Without a timer row, Copy, the actions and thumbs get a row of
          their own. */}
          {!inTimerRow &&
            (actions || feedback || fallbackCopy) &&
            !!complete && (
              <TurnFooterRow variant="actions" data-testid="chat-turn-actions">
                <>
                  {fallbackCopy}
                  <TurnFooterReveal
                    completed={complete}
                    completionStatus={outcome}
                    alwaysVisible
                  >
                    <span className="flex items-center gap-0.5 pointer-coarse:gap-4">
                      {feedback}
                      {actions}
                    </span>
                  </TurnFooterReveal>
                </>
              </TurnFooterRow>
            )}
        </div>
      </ToolApprovalWaitProvider>
    </ToolTurnSettledContext.Provider>
  );
}

/** A reply's text: its whole-message text, or else its text parts. */
function replyTextOf(message: PortalChatMessage): string {
  if (message.text.trim() !== '') return message.text;
  return (message.parts ?? [])
    .flatMap((part) => {
      const data: unknown = part.data;
      return part.kind === 'text' &&
        typeof data === 'object' &&
        data !== null &&
        'text' in data &&
        typeof data.text === 'string'
        ? [data.text]
        : [];
    })
    .join('\n\n');
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

/** A turn timer part's times, as the clean chat look's header reads them. */
function readTurnHeaderTimer(data: unknown): {
  startedAt?: number;
  pausedAt?: number;
  resumedAt?: number;
  accumulatedPausedDurationMs?: number;
  elapsedMs?: number;
} {
  if (!isRecord(data)) return {};
  const startedAt = readNumber(data.startedAt);
  const completedAt = readNumber(data.completedAt);
  const pausedAt = readNumber(data.pausedAt);
  const resumedAt = readNumber(data.resumedAt);
  const pausedMs = readNumber(data.accumulatedPausedDurationMs);
  // Keep timer pause accounting, including a saved pause without a total.
  const elapsedSecond =
    completedAt === undefined
      ? null
      : getElapsedSecond(startedAt, completedAt, pausedAt, resumedAt, pausedMs);
  return {
    startedAt,
    pausedAt,
    resumedAt,
    accumulatedPausedDurationMs: pausedMs,
    elapsedMs: elapsedSecond === null ? undefined : elapsedSecond * 1000,
  };
}

/** Memoized so settled turn groups skip re-render during streaming (CLAUDE.md). */
export const TurnGroupView = memo(TurnGroupViewImpl);
