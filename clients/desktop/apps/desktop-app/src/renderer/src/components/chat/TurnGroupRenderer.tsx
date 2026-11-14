import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import { useScopeCapabilities } from '@/hooks/useScopeCapabilities';
import { BrandLogo } from '@/components/BrandLogo';
import { WorkflowIcon } from '@/components/activity/WorkflowIcon';
import { ShareSessionControl } from '@/components/shared/ShareSessionControl';
import { ChatWatcherButton } from '@/components/watchers/ChatWatcherButton';
import { useTurnFileLocations } from '@/hooks/useTurnFileLocations';
import { isCoworkChatTarget } from '@/lib/cowork';
import type { FilePathMentionIndex } from '@/lib/filePathMentionIndex';
import type { InvocableMentionIndex } from '@/lib/invocableMentionIndex';
import { canTransferChatSession } from '@/lib/session-transfer-eligibility';
import { useWorkspaceIsReadOnly } from '@/lib/workspace-access';
import type { AppliedOrgMemoryTurn, PendingQuestion } from '@/stores/chatStore';
import {
  useChatStore,
  useChatTabRenderState,
  type ChatRenderTarget,
} from '@/stores/chatStore';
import type { TranscriptTurnSummary } from '@canopy/agent-transcript/transcript-storage';
import {
  displayMessageHasVisual,
  visualOnlyDisplayMessage,
} from '@canopy/desktop-shared/lib/display-message-visual';
import { collectTurnFiles } from '@canopy/desktop-shared/lib/turn-files';
import { displayMessageHasSafetyDenial } from './safety-denial-placement';
import {
  computeTurnOutcomes,
  computeTurnSummary,
  getTurnOutcomeStepDetails,
  getTurnOutcomeSteps,
  getTurnSafetyDeniedToolUseIds,
  splitFinalMessages,
} from '@canopy/desktop-shared/lib/turn-utils';
import type {
  TurnOutcomeCounts,
  TurnOutcomeStepDetail,
} from '@canopy/protocol/portal';
import { ringChatCallFocus } from './chat-call-focus';
import { desktopTurnApprovalWait } from './tool-approval-matching';
import type {
  AgentArtifactReceiptV1,
  ApprovalRequestEvent,
} from '@canopy/desktop-shared/types';
import {
  APP_ADVISOR_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  type TurnDiffData,
} from '@canopy/desktop-shared/types';
import {
  ChatCopyAction,
  PlanCopyAction,
  planCopyStateFromResolution,
  resolvePlanTurn,
  type PlanCopyState,
  type PlanTurnToolCall,
  describeStepCounts,
  formatTurnSummaryAriaLabel,
  hasTurnOutcomes,
  resolveTurnCompletionStatus,
  TranscriptPagingControls,
  TURN_OUTCOME_ORDER,
  type TurnTerminalStatus,
  TurnFooterRow,
  TurnOutcomeControl,
  TurnWorkHeader,
  STEP_GROUP_BODY_CLASS,
  type TurnStartingSetup,
  ToolApprovalWaitProvider,
  NO_TOOL_APPROVAL_WAIT,
  isStartingTurnOutput,
  extractExitPlanModePlan,
  useChatDetail,
  useTurnCollapse,
  type TurnSummaryChip,
} from '@canopy/ui-shared/components';
import {
  AgentIcon,
  AppAdvisorIcon,
  AppAdvisorWatcherIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClaudeLogo,
  CodeBracketsIcon,
  DocumentIcon,
  DocumentSearchIcon,
  GlobeIcon,
  GraphIcon,
  MagnifyingGlassIcon,
  McpIcon,
  MessageIcon,
  MonitorIcon,
  PipelineIcon,
  PlanModeIcon,
  QuestionMarkIcon,
  SkillIcon,
  StopIcon,
  ScheduleIcon,
  TaskIcon,
  TerminalBorderedIcon,
  TerminalIcon,
  TrashIcon,
  WrenchIcon,
} from '@canopy/ui-shared/icons';
import {
  DocumentPencilIcon,
  LightbulbIcon,
  PickIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { useShallow } from 'zustand/react/shallow';
import { AutoArchiveToggleButton } from './AutoArchiveToggleButton';
import { ChatMessageItem, type SpawningCallTarget } from './ChatMessageItem';
import { ForkChatButton } from './ForkChatButton';
import { ResetToPointDialog } from './ResetToPointDialog';
import { TurnMoreActions } from './TurnMoreActions';
import { DesktopAgentActivitySection } from './DesktopAgentActivitySection';
import { RunCommentsButton } from './RunCommentsButton';
import { StickyTurnSummary } from './StickyTurnSummary';
import { CleanToolStepGroup } from './ToolStepGroup';
import { TurnDiffSummary } from './TurnDiffSummary';
import { continuationPromptId } from './continuation-transcript-turns';
import { hasForkableAssistantContent } from './incremental-turn-groups';
import { TurnFeedbackSlot } from './TurnFeedbackHosts';
import { TurnTimer } from './TurnTimer';
import { readStickyUserHeight } from './sticky-user-height';
import {
  liveStepWindow,
  segmentCleanSteps,
  stepPieceOf,
  stepsBeforeLiveWindow,
  turnStepCounts,
} from './tool-step-groups';
import type { DisplayMessage, TurnGroup, TurnSummaryCounts } from './types';
import { TASK_MGMT_TOOLS, toActiveComposerView } from './types';

const PROGRESSIVE_TURN_MESSAGE_THRESHOLD = 100;
const PROGRESSIVE_TURN_MESSAGE_BATCH = 16;

// ---------------------------------------------------------------------------
// Collapsed turn summary
// ---------------------------------------------------------------------------

/**
 * Travel time when expanding a turn scrolls its section head to the top of the
 * transcript. Long enough to read as a movement between two places rather than
 * a cut, short enough not to hold up the reader.
 */
const SECTION_SCROLL_DURATION_MS = 320;

/**
 * How long a landing keeps looking for its step's row after the turn's last
 * lifecycle change (opened, loaded, more rows mounted), before leaving the
 * reader at the section head.
 */
const LANDING_RETRY_MS = 2000;

/** A turn no approval holds. */
const NO_APPROVALS: readonly ApprovalRequestEvent[] = [];

/** A turn's timer, as the clean chat look's header reads it. */
interface TurnHeaderTimer {
  startedAt?: number;
  completedAt?: number | null;
  pausedAt?: number | null;
  resumedAt?: number | null;
  accumulatedPausedDurationMs?: number;
}

/**
 * The scroll travel running in each transcript scroller. Starting another
 * (expanding a turn, then landing on its blocked step) replaces it instead
 * of fighting it frame by frame.
 */
const activeScrollTravel = new WeakMap<HTMLElement, () => void>();

/**
 * Drives `scroller` to the offset `measure` returns, re-measured every frame
 * so a destination that moves while expanded rows are measured is followed.
 *
 * Hand-animated rather than `scrollTo({behavior: 'smooth'})`, because a
 * native smooth scroll is cancelled outright by the first competing
 * `scrollTop` write — and there are two of those here:
 *
 *  - the transcript re-pins to the bottom whenever content grows while the
 *    reader was near the bottom, which is exactly the case here;
 *  - under virtualization the expanded rows are re-measured and every later
 *    row is repositioned, so the destination itself moves.
 *
 * Driving the scroll frame by frame wins against both, and also keeps the
 * transcript out of its near-bottom state so nothing pulls back once the
 * travel finishes. Reduced motion gets the destination, not the journey:
 * still applied over several frames, without easing. A wheel scroll of the
 * reader's own outranks the travel. Returns a cancel function.
 */
function startScrollTravel(
  scroller: HTMLElement,
  measure: () => number,
): () => void {
  activeScrollTravel.get(scroller)?.();
  let cancelled = false;
  const cancel = (): void => {
    cancelled = true;
    scroller.removeEventListener('wheel', cancel);
    document.removeEventListener('pointerdown', cancel, true);
    document.removeEventListener('keydown', cancel, true);
    if (activeScrollTravel.get(scroller) === cancel) {
      activeScrollTravel.delete(scroller);
    }
  };
  activeScrollTravel.set(scroller, cancel);
  scroller.addEventListener('wheel', cancel, { passive: true, once: true });
  document.addEventListener('pointerdown', cancel, true);
  document.addEventListener('keydown', cancel, true);

  if (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ) {
    let settleFrame = 0;
    const settle = (): void => {
      if (cancelled) return;
      scroller.scrollTop = measure();
      settleFrame += 1;
      if (settleFrame < 4) requestAnimationFrame(settle);
      else cancel();
    };
    requestAnimationFrame(settle);
    return cancel;
  }

  const from = scroller.scrollTop;
  const startedAt = performance.now();
  const step = (now: number): void => {
    if (cancelled) return;
    const to = measure();
    const progress = Math.min(
      1,
      (now - startedAt) / SECTION_SCROLL_DURATION_MS,
    );
    // easeOutCubic: leaves quickly, settles gently.
    const eased = 1 - (1 - progress) ** 3;
    scroller.scrollTop = from + (to - from) * eased;
    if (progress < 1) {
      requestAnimationFrame(step);
      return;
    }
    cancel();
  };
  requestAnimationFrame(step);
  return cancel;
}

/** `element`'s offset in `scroller`'s content, stable while it scrolls. */
function contentOffsetTop(element: HTMLElement, scroller: HTMLElement): number {
  return (
    element.getBoundingClientRect().top -
    scroller.getBoundingClientRect().top +
    scroller.scrollTop
  );
}

/**
 * Brings a turn's tool row into view below the pinned prompt and summary
 * (`origin`, the summary banner), and focuses its toggle without a second
 * scroll. Leaves focus alone when the reader has moved it elsewhere than the
 * banner or the `control` they used.
 */
function landOnToolRow(
  row: HTMLElement,
  origin: HTMLElement | null,
  control: HTMLElement | null = null,
): (() => void) | undefined {
  const scroller = row.closest('[data-testid="chat-message-list-scroll"]');
  const toggle =
    row.querySelector<HTMLElement>('button[aria-expanded]') ??
    row.querySelector<HTMLElement>('button');
  let cancelTravel: (() => void) | undefined;
  if (scroller instanceof HTMLElement) {
    const section = row.closest('[data-chat-sticky-section]');
    const scrollerInset =
      Number.parseFloat(window.getComputedStyle(scroller).paddingTop) || 0;
    const pinnedHead =
      section instanceof HTMLElement ? readStickyUserHeight(section) : 0;
    const pinnedSummary = origin?.isConnected
      ? origin.getBoundingClientRect().height
      : 0;
    const overlayInset = scrollerInset + pinnedHead + pinnedSummary + 8;
    cancelTravel = startScrollTravel(scroller, () => {
      // A third of the way down, never under the pinned prompt and summary.
      const room = scroller.clientHeight - row.getBoundingClientRect().height;
      return contentOffsetTop(row, scroller) - Math.max(overlayInset, room / 3);
    });
  }
  const active = document.activeElement;
  const focusIsOurs =
    active === null ||
    active === document.body ||
    active === origin ||
    (control !== null && active === control);
  if (toggle && focusIsOurs) toggle.focus({ preventScroll: true });
  return cancelTravel;
}

/**
 * A summary banner action's elements: `origin` is the banner (the pinned
 * summary a landing scrolls below), `control` the element the reader used,
 * for focus handoff on landing.
 */
type SummaryActionHandler = (
  origin: HTMLElement,
  control: HTMLElement | null,
) => void;

function DesktopCollapsedTurnSummary({
  counts,
  outcomes,
  outcomeSteps,
  isExpanded,
  onToggle,
  onJumpToOutcome,
  isCodeReviewChat = false,
  userMessageId,
  timer,
  outcome,
}: {
  counts: TurnSummaryCounts;
  /** Blocked, errored and interrupted steps; omitted without metadata. */
  outcomes?: TurnOutcomeCounts;
  /** The steps behind `outcomes`, when the turn's rows are loaded. */
  outcomeSteps?: readonly TurnOutcomeStepDetail[];
  isExpanded: boolean;
  onToggle: SummaryActionHandler;
  /** Lands on an outcome step: the given one, else the first. */
  onJumpToOutcome?: (
    origin: HTMLElement,
    control: HTMLElement | null,
    toolUseId?: string,
  ) => void;
  /** True inside a Code Review sidecar chat — every call bucketed into
   * `counts.plan` there is `RespondToComment`/`GetReviewComments`, so the
   * whole chip swaps to the code-flavored icon instead of the Plan Explore
   * map glyph. */
  isCodeReviewChat?: boolean;
  /** The turn's user message, used to scope scroll cleanup. */
  userMessageId?: string;
  /** Clean chat look: the turn's time, for "Worked for 3m 24s". */
  timer?: TurnHeaderTimer;
  /** Clean chat look: how the turn ended, when not plainly complete. */
  outcome?: TurnTerminalStatus;
}): JSX.Element {
  // The work header owns the disclosure toggle.

  const headerRef = useRef<HTMLButtonElement>(null);
  const banner = (): HTMLElement | null => headerRef.current;
  useEffect(() => {
    const scroller = headerRef.current?.closest(
      '[data-testid="chat-message-list-scroll"]',
    );
    return (): void => {
      if (scroller instanceof HTMLElement) activeScrollTravel.get(scroller)?.();
    };
  }, [userMessageId]);

  // Clean chat look: the turn's header, "Worked for 3m 24s", opens the
  // steps; what they did reads as words on hover.

  const stepCounts = turnStepCounts(counts);

  // The desktop vocabulary: more families than the shared summary, and the
  // host's own brand and workflow glyphs.
  const chips: TurnSummaryChip[] = [];
  const chip = (
    key: keyof TurnSummaryCounts,
    icon: JSX.Element,
    label: string,
  ): void => {
    const count = counts[key];
    if (count > 0) chips.push({ key, icon, label, count });
  };
  chip('messages', <MessageIcon />, 'messages');
  chip('thinking', <LightbulbIcon />, 'thinking');
  chip('bash', <TerminalIcon />, 'bash');
  chip('read', <DocumentIcon />, 'read');
  chip('readLines', <DocumentIcon />, 'read lines');
  chip('writeEdit', <DocumentPencilIcon />, 'write/edit');
  chip(
    'plan',
    isCodeReviewChat ? <CodeBracketsIcon /> : <PlanModeIcon />,
    isCodeReviewChat ? 'review comments' : 'plan',
  );
  chip('fileEdit', <DocumentPencilIcon />, 'edit');
  chip('fileAdd', <DocumentPencilIcon />, 'write');
  chip('fileDelete', <TrashIcon />, 'delete');
  chip('search', <MagnifyingGlassIcon />, 'search');
  chip('grep', <DocumentSearchIcon />, 'grep');
  chip('web', <GlobeIcon />, 'web');
  chip('agent', <AgentIcon />, 'agents');
  chip('workflow', <WorkflowIcon />, 'workflows');
  chip('tasks', <TaskIcon />, 'tasks');
  chip('taskStop', <StopIcon />, 'stop');
  chip('skills', <SkillIcon />, 'skills');
  chip('monitor', <MonitorIcon />, 'monitor');
  chip('claude', <ClaudeLogo width={14} height={14} />, 'claude');
  // Wakeups and Claude's scheduled prompts (CronCreate and friends).
  chip('scheduleWakeup', <ScheduleIcon />, 'scheduled');
  chip('askUser', <QuestionMarkIcon />, 'questions');
  chip('scriptOutput', <TerminalBorderedIcon />, 'script output');
  chip('watcher', <AppAdvisorWatcherIcon />, 'watcher');
  chip('canopy', <BrandLogo width={14} height={14} aria-hidden />, 'app');
  chip('graph', <GraphIcon />, 'code graph');
  chip('appAdvisor', <AppAdvisorIcon />, ORCHESTRATOR_LABEL.toLowerCase());
  chip('pipelineEditor', <PipelineIcon />, 'workflow');
  chip('computerUse', <PickIcon />, 'computer use');
  chip('mcp', <McpIcon />, 'mcp');
  chip('other', <WrenchIcon />, 'other');

  const ariaLabel = formatTurnSummaryAriaLabel(chips, outcomes);

  const handleToggle = (event: MouseEvent<HTMLButtonElement>): void => {
    const wasExpanded = isExpanded;
    const section = event.currentTarget.closest('[data-chat-sticky-section]');
    const turnGroup = event.currentTarget.closest('[data-chat-turn-group]');
    const scroller = event.currentTarget.closest(
      '[data-testid="chat-message-list-scroll"]',
    );
    onToggle(banner() ?? event.currentTarget, event.currentTarget);
    if (wasExpanded) return;
    if (!(section instanceof HTMLElement)) return;
    if (!(scroller instanceof HTMLElement)) return;

    // Expanding inserts the turn's steps above whatever the reader was
    // looking at, so without this the prompt they just opened scrolls out
    // of view. Travel to its section head at the top of the scrollport
    // (where it also becomes the pinned header). When the turn has a
    // blocked or failed step, landing on it takes over from here.
    //
    // The offset is computed explicitly rather than via `scrollIntoView` —
    // the section's head is `position: sticky`, so scrollIntoView targets
    // the pinned box instead of the section's real top and lands short.
    // The scrollport's own top padding is the resting gap above the first
    // item. Landing on the section's raw offset scrolls that padding away,
    // which pins the banners one notch higher than they sit at rest and
    // closes the gap between the last banner and the content under it —
    // the same turn then reads tighter after the travel than it does
    // anywhere else. Stopping the padding short of the edge reproduces the
    // resting layout exactly.
    const scrollerInset =
      Number.parseFloat(window.getComputedStyle(scroller).paddingTop) || 0;

    // A turn that does not head its section (a watcher-fired follow-up,
    // or any turn in a virtualized continuation) sits below a section head
    // that belongs to an earlier prompt. Travelling to the section top
    // would leave the opened turn far below the viewport, so land the
    // turn itself just under the pinned head and its 8px gap, the way
    // `jumpToUserMessage` lands in-flow bubbles.
    const headsSection =
      turnGroup instanceof HTMLElement &&
      section.querySelector(
        `[data-sticky-user-message-id="${CSS.escape(turnGroup.dataset.chatTurnGroup ?? '')}"]`,
      ) !== null;
    const target =
      turnGroup instanceof HTMLElement && !headsSection ? turnGroup : section;
    const pinnedHeadHeight =
      target === section ? 0 : readStickyUserHeight(section);
    const pinnedHeadInset = pinnedHeadHeight > 0 ? pinnedHeadHeight + 8 : 0;
    const restingInset = scrollerInset + pinnedHeadInset;
    startScrollTravel(
      scroller,
      () => contentOffsetTop(target, scroller) - restingInset,
    );
  };

  const jumpToOutcome = onJumpToOutcome
    ? (toolUseId?: string): void => {
        const origin = banner();
        if (!origin) return;
        // Read before the tooltip closes: a tooltip entry then leaves
        // focus on the document, the outcome button keeps it.
        const active = document.activeElement;
        onJumpToOutcome(
          origin,
          active instanceof HTMLElement ? active : null,
          toolUseId,
        );
      }
    : undefined;
  const outcomeControl = hasTurnOutcomes(outcomes) ? (
    <TurnOutcomeControl
      outcomes={outcomes}
      outcomeSteps={outcomeSteps}
      onJumpToOutcome={jumpToOutcome}
    />
  ) : undefined;

  return (
    <TurnWorkHeader
      ref={headerRef}
      startedAt={timer?.startedAt}
      finishedAt={timer?.completedAt ?? null}
      pausedAt={timer?.pausedAt}
      resumedAt={timer?.resumedAt}
      accumulatedPausedDurationMs={timer?.accumulatedPausedDurationMs}
      live={false}
      completionStatus={outcome ?? 'complete'}
      expandable
      isOpen={isExpanded}
      onToggle={handleToggle}
      ariaLabel={ariaLabel}
      title={describeStepCounts(stepCounts) || undefined}
      stepCount={chips.reduce((total, chip) => total + chip.count, 0)}
      outcome={outcomeControl}
      dataTestId="turn-work-header"
    />
  );
}

// ---------------------------------------------------------------------------
// Reverted-turn wrapper — module-level so its component identity is stable
// across re-renders (an inline definition would create a new component type
// per render, forcing React to unmount/remount its children — see
// CLAUDE.md "Performance Patterns").
// ---------------------------------------------------------------------------

function RevertedTurnWrapper({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  return (
    <div
      className="flex flex-col -ml-3 border-l-2 border-line-attention/40 pl-3 opacity-60 gap-2"
      aria-label="Reverted turn"
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Turn group renderer
// ---------------------------------------------------------------------------

export const TurnGroupRenderer = memo(function TurnGroupRenderer({
  transcriptTurn,
  historyTurn,
  hideTurnDiffSummary = false,
  resetTurnId,
  continuationActive = false,
  onLoadHistory,
  searchMessageId,
  historyLoading = false,
  historyError = null,
  historySuspended = false,
  chatId,
  group,
  pendingTimer = false,
  starting = false,
  startingSetup,
  waitingForApproval = false,
  chatPendingQuestions,
  turnDiff,
  appliedMemory,
  isLastTurnGroup,
  isLastForkableTurnGroup,
  onResetToPoint,
  isReverted = false,
  targetOverride,
  hideBranchActions = false,
  sourceSdkSessionId,
  suppressActiveForkAction = false,
  invocableMentionIndex,
  filePathMentionIndex,
  completedAgentArtifacts = [],
  hideUserMessage = false,
  stickyTurnSummary = false,
  forceExpandedUserMessage = false,
  onJumpToMessage,
  onShowSpawningCall,
  revealRequest,
}: {
  transcriptTurn?: TranscriptTurnSummary;
  /**
   * The indexed turn whose span holds this group when it has none of its own
   * (a tools-loaded continuation, in its prompt's span). Pages only.
   */
  historyTurn?: TranscriptTurnSummary;
  /** The diff shows on a later group of the prompt (its continuation). */
  hideTurnDiffSummary?: boolean;
  /** The prompt a continuation's diff and Undo belong to. */
  resetTurnId?: string;
  /** This prompt's tools-loaded continuation still runs in its session. */
  continuationActive?: boolean;
  /**
   * Loads the owning turn's missing history page. Receives the turn's user
   * message id so the list can hand every row the same stable callback
   * instead of a per-row closure that would defeat this component's memo.
   */
  onLoadHistory?: (userMessageId: string) => void | Promise<void>;
  searchMessageId?: string;
  historyLoading?: boolean;
  historyError?: string | null;
  historySuspended?: boolean;
  chatId?: string;
  group: TurnGroup;
  pendingTimer?: boolean;
  /**
   * The turn is a just-submitted first send: until its first visible output
   * or a finished timer it shows the shared "Starting…" status instead of the
   * working header and timer.
   */
  starting?: boolean;
  /**
   * With `starting`: the chat's worktree is still being set up, so the status
   * reads "Setting up this chat's copy of <project>" with its clock.
   */
  startingSetup?: TurnStartingSetup;
  /**
   * The owning chat has a pending tool approval. The list sets it only on
   * the latest turn, so historical turns keep a stable prop; it pauses this
   * turn's timer only while the turn is unfinished.
   */
  waitingForApproval?: boolean;
  chatPendingQuestions: PendingQuestion[];
  turnDiff?: TurnDiffData;
  appliedMemory?: AppliedOrgMemoryTurn;
  /** Still drives turn-diff summary placement even when another turn owns fork actions. */
  isLastTurnGroup: boolean;
  isLastForkableTurnGroup: boolean;
  onResetToPoint?: (userMessageId: string) => Promise<void>;
  /**
   * True when this turn's code changes have been rolled back by a later
   * `revert_info` marker in the transcript. Renders the whole turn with a
   * faded + bordered treatment so the reverted attempt is visually
   * distinguishable from active history.
   */
  isReverted?: boolean;
  targetOverride?: { projectId: string; worktreeId: string; chatId: string };
  hideBranchActions?: boolean;
  sourceSdkSessionId?: string;
  suppressActiveForkAction?: boolean;
  invocableMentionIndex?: InvocableMentionIndex | null;
  filePathMentionIndex?: FilePathMentionIndex | null;
  /**
   * What the completed turn's box lists: its capability tiles and the runs
   * placed in it. Runs the composer's background drawer lists are placed in
   * no turn, and each other run in one (`placeAgentActivity`, CAN-4690).
   */
  completedAgentArtifacts?: readonly AgentArtifactReceiptV1[];
  /**
   * True when the transcript list hoisted this turn's user message into a
   * sticky section header and renders it there itself. The group then skips
   * its own user bubble so the message appears exactly once. Never combined
   * with `isReverted` — reverted turns keep their internal collapsed
   * rendering and are not hoisted.
   */
  hideUserMessage?: boolean;
  /**
   * True when this turn renders inside a sticky transcript section: its
   * completed-turn summary chip pins just below the sticky user message
   * (`top: var(--chat-sticky-user-height)`), bounded to this turn's own
   * wrapper — so in a section with watcher-fired turns, each turn's summary
   * scrolls into the pinned slot as its content reaches the top.
   */
  stickyTurnSummary?: boolean;
  forceExpandedUserMessage?: boolean;
  /** Transcript-supplied click-to-jump handler for this turn's user bubble. */
  onJumpToMessage?: (element: HTMLElement) => void;
  /** Brings a wake's spawning tool call (or its prompt) into view. */
  onShowSpawningCall?: (target: SpawningCallTarget) => void;
  /**
   * Opens this turn and the step row holding `messageId` so the host can
   * bring that message into view. A new object for each request.
   */
  revealRequest?: { messageId: string };
}): JSX.Element {
  // Live runs are removed by placement. Their completed records can become
  // available before the parent turn ends; capability tiles remain pinned.
  const recordArtifacts = useMemo(
    () =>
      group.isComplete
        ? completedAgentArtifacts
        : completedAgentArtifacts.filter(
            (receipt) =>
              receipt.kind === 'pipeline_run' ||
              receipt.kind === 'github_workflow_run',
          ),
    [completedAgentArtifacts, group.isComplete],
  );
  const forkTab = useChatStore((s) => s.forkTab);
  const turnFiles = useMemo(
    () =>
      transcriptTurn?.files && transcriptTurn.complete && group.isComplete
        ? transcriptTurn.files
        : collectTurnFiles(group.assistantMessages, transcriptTurn?.files),
    [
      transcriptTurn?.files,
      transcriptTurn?.complete,
      group.isComplete,
      group.assistantMessages,
    ],
  );
  const branchTab = useChatStore((s) => s.branchTab);
  const setAutoArchiveForActiveTurn = useChatStore(
    (s) => s.setAutoArchiveForActiveTurn,
  );
  const selectedWorktreeProjectId = useChatStore(
    (s) => targetOverride?.projectId ?? s.selectedWorktree?.projectId,
  );
  const selectedWorktreeWorktreeId = useChatStore(
    (s) => targetOverride?.worktreeId ?? s.selectedWorktree?.worktreeId,
  );
  const { chatTabFork } = useScopeCapabilities({
    projectId: selectedWorktreeProjectId ?? '',
  });
  // This turn's chat. Its selectors run only when this chat's tab changes,
  // never for another chat's commit.
  const chatTarget = useMemo(
    (): ChatRenderTarget | null =>
      chatId !== undefined &&
      selectedWorktreeProjectId !== undefined &&
      selectedWorktreeWorktreeId !== undefined
        ? {
            projectId: selectedWorktreeProjectId,
            worktreeId: selectedWorktreeWorktreeId,
            chatId,
          }
        : null,
    [chatId, selectedWorktreeProjectId, selectedWorktreeWorktreeId],
  );
  const hasRoutingTarget =
    !!chatId && !!selectedWorktreeProjectId && !!selectedWorktreeWorktreeId;
  const routedChatTarget =
    hasRoutingTarget && chatTarget !== null ? chatTarget : undefined;
  const {
    pending: pendingTurnFiles,
    pendingPathAliases,
    located: locatedTurnFiles,
  } = useTurnFileLocations(routedChatTarget, turnFiles, group.isComplete);
  const modelRoutingStartedAt = useChatTabRenderState(chatTarget, ({ tab }) =>
    hasRoutingTarget ? tab?.modelRoutingStartedAt : undefined,
  );
  // The model Auto picked for this turn, recorded by main per user message.
  const autoRoutedModel = useChatTabRenderState(chatTarget, ({ tab }) =>
    hasRoutingTarget
      ? tab?.autoRoutedModels?.[group.userMessage.id]
      : undefined,
  );
  const turnOutcome = useChatTabRenderState(
    chatTarget,
    ({ tab }) =>
      tab?.turnEnds?.[group.userMessage.id]?.outcome ??
      tab?.unacceptedTurnEnds?.[group.userMessage.id],
  );
  // Main records each turn a restart cut off, keyed by its own prompt, so a
  // turn that resumed or started afterwards never inherits it.
  const turnInterrupted = useChatTabRenderState(
    chatTarget,
    ({ tab }) => tab?.interruptedTurns?.[group.userMessage.id] !== undefined,
  );
  const [showChoosingModel, setShowChoosingModel] = useState(false);

  const chatDetail = useChatDetail();
  useEffect(() => {
    if (modelRoutingStartedAt === undefined) {
      setShowChoosingModel(false);
      return;
    }
    const remaining = Math.max(0, 250 - (Date.now() - modelRoutingStartedAt));
    const timeout = window.setTimeout(
      () => setShowChoosingModel(true),
      remaining,
    );
    return (): void => window.clearTimeout(timeout);
  }, [modelRoutingStartedAt]);
  // Threaded down to `ChatMessageItem` → `ChatBlockRenderer` → `ToolCallBlock`
  // and used locally for the collapsed-turn summary chip so the shared
  // plan/review comment tools (`RespondToComment`, `GetReviewComments`) get
  // the code-flavored icon in a Code Review sidecar chat instead of the Plan
  // Explore map glyph (see `ToolDisplayScope`).
  const isCodeReviewChat =
    selectedWorktreeProjectId === CODE_REVIEW_CHAT_PROJECT_ID;
  const forkTarget = targetOverride
    ? {
        projectId: targetOverride.projectId,
        worktreeId: targetOverride.worktreeId,
      }
    : undefined;
  const autoArchiveTurnState = useChatTabRenderState(
    chatTarget,
    useShallow(({ tab }) => {
      if (!tab || tab.kind === 'file') {
        return null;
      }
      return {
        enabled: tab.autoArchive === true,
        visible:
          tab.autoArchive === true || tab.autoArchiveToggleVisible === true,
      };
    }),
  );
  // Share-session state for the completed-turn Share button. Reuse the
  // composer view's idle/session fields so the guard stays consistent across
  // both surfaces.
  const shareTabState = useChatTabRenderState(
    chatTarget,
    useShallow(({ tab }) => {
      if (!tab || tab.kind === 'file') {
        return null;
      }
      const composerView = toActiveComposerView(tab);
      return {
        title: composerView.title,
        hasMessages: composerView.hasStartedSession,
        busy: composerView.shareSessionBusy,
        sharedRun: composerView.sharedRun,
      };
    }),
  );
  // Read-only scopes (a shared-container recipient) keep the transcript and
  // drop every footer control that forks, branches, shares, rates, comments
  // on, watches or rewinds a turn.
  const readOnly = useWorkspaceIsReadOnly();
  const canBranch =
    !readOnly &&
    !hideBranchActions &&
    selectedWorktreeProjectId !== undefined &&
    !isCoworkChatTarget(selectedWorktreeProjectId);
  const [collapsed, setIsCollapsed] = useTurnCollapse(
    group.isComplete,
    chatDetail,
  );
  const isCollapsed = searchMessageId ? false : collapsed;
  const [progressiveMessageTick, setProgressiveMessageTick] = useState(0);
  const userMessageId = group.userMessage.id;
  // A tools-loaded continuation runs under its prompt; its receipts name it.
  const receiptOwnerId =
    continuationPromptId(group.userMessage) ?? userMessageId;
  const progressivelyMountedMessageIdsRef = useRef<Set<string>>(new Set());
  const progressiveTurnIdRef = useRef(userMessageId);
  if (progressiveTurnIdRef.current !== userMessageId) {
    progressiveTurnIdRef.current = userMessageId;
    progressivelyMountedMessageIdsRef.current.clear();
  }
  // Latest-ref so the refresh effect below keys on transcript state only. A
  // parent re-rendering during a streaming turn may hand this row a new
  // callback identity; that must not re-request the same history page.
  const onLoadHistoryRef = useRef(onLoadHistory);
  onLoadHistoryRef.current = onLoadHistory;
  // The turn this group pages through: its own, or the span that holds it.
  const pagingTurn = transcriptTurn ?? historyTurn;
  const pagingTurnId = pagingTurn?.id ?? userMessageId;
  const loadHistory = useCallback(
    (): void | Promise<void> => onLoadHistoryRef.current?.(pagingTurnId),
    [pagingTurnId],
  );
  useEffect(() => {
    // A resumed, partially loaded turn can finish while this view is open.
    // Refresh its completed preview/counts once; keep already inspected rows.
    if (
      group.isComplete &&
      transcriptTurn?.complete === false &&
      transcriptTurn.before !== undefined &&
      !historySuspended &&
      !historyError
    )
      void loadHistory();
  }, [
    group.isComplete,
    transcriptTurn,
    historySuspended,
    historyError,
    loadHistory,
  ]);
  // Landing (CAN-4810, CAN-5056): an explicit expand of a turn with a
  // blocked or errored step, or a click on its outcome or a tooltip entry,
  // reveals that step's row, focuses its toggle and rings it. The request
  // outlives the history load and the expanded rows' mount; collapsing,
  // another request, the reader acting elsewhere, or its deadline ends it.
  // Each request is a fresh object, so a repeated jump lands again.
  const [landing, setLanding] = useState<{
    origin: HTMLElement;
    control: HTMLElement | null;
    toolUseId?: string;
  } | null>(null);
  const expansionRequest = useRef(0);
  const expansionPending = useRef(false);
  const landingTravel = useRef<(() => void) | undefined>(undefined);
  useEffect(
    () => (): void => {
      expansionRequest.current += 1;
      expansionPending.current = false;
      landingTravel.current?.();
    },
    [userMessageId],
  );
  useEffect(() => {
    if (isCollapsed) landingTravel.current?.();
  }, [isCollapsed]);
  // The step a landing revealed; its folded step group stays open until the
  // turn collapses, since a forced open would otherwise close again.
  const [revealMessageId, setRevealMessageId] = useState<string | undefined>();
  const toggleCollapsed = (): void => {
    const request = ++expansionRequest.current;
    setLanding(null);
    landingTravel.current?.();
    if (expansionPending.current) {
      expansionPending.current = false;
      return;
    }
    if (!isCollapsed) setRevealMessageId(undefined);
    progressivelyMountedMessageIdsRef.current.clear();
    if (isCollapsed && pagingTurn?.before !== undefined && onLoadHistory) {
      // Install the initial lazy page while the turn is still collapsed. The
      // subsequent expansion then uses the existing section-head scroll; it
      // must not be mistaken for an infinite-scroll prepend above the viewport.
      expansionPending.current = true;
      const finish = (): void => {
        if (expansionRequest.current !== request) return;
        expansionPending.current = false;
        setProgressiveMessageTick((current) => current + 1);
        setIsCollapsed(false);
      };
      void Promise.resolve()
        .then(loadHistory)
        .then(finish, (): void => {
          // The existing history error control owns retry. Open the section
          // without landing rather than leaving an unhandled rejection.
          if (expansionRequest.current !== request) return;
          setLanding(null);
          finish();
        });
    } else if (isCollapsed) {
      setProgressiveMessageTick((current) => current + 1);
      setIsCollapsed(false);
    } else {
      setProgressiveMessageTick((current) => current + 1);
      setIsCollapsed(true);
    }
  };
  const [isRevertedCollapsed, setIsRevertedCollapsed] = useState(isReverted);
  const prevRevertedRef = useRef(isReverted);

  // When a turn newly transitions to reverted (a later marker covered it),
  // collapse it. Doesn't auto-expand if the turn becomes un-reverted, which
  // shouldn't happen in normal flow but is a defensive default.
  useEffect(() => {
    if (!prevRevertedRef.current && isReverted) {
      setIsRevertedCollapsed(true);
    }
    prevRevertedRef.current = isReverted;
  }, [isReverted]);

  // Opened as saved state, so the person can collapse the turn again.
  useLayoutEffect(() => {
    if (revealRequest) setIsCollapsed(false);
  }, [revealRequest, setIsCollapsed]);

  const { intermediateMessages, finalMessages, trailingToolMessages } =
    useMemo(() => {
      if (transcriptTurn?.before === undefined)
        return splitFinalMessages(group.assistantMessages);
      // A sparse preview can omit the tool row separating a question from the
      // final response. Keep the selection computed from the complete turn.
      const finalIds = new Set(transcriptTurn.finalMessageIds);
      return {
        finalMessages: group.assistantMessages.filter((message) =>
          finalIds.has(message.id),
        ),
        intermediateMessages: group.assistantMessages.filter(
          (message) => !finalIds.has(message.id),
        ),
        trailingToolMessages: [],
      };
    }, [group.assistantMessages, transcriptTurn]);

  // Summary counts include both intermediate and trailing tool messages
  // since both are hidden when collapsed.
  const computedSummary = useMemo(
    () =>
      computeTurnSummary([...intermediateMessages, ...trailingToolMessages]),
    [intermediateMessages, trailingToolMessages],
  );

  const summary =
    transcriptTurn?.before !== undefined
      ? transcriptTurn.summary
      : computedSummary;

  // Outcomes count the same steps as the summary; receipts may sit on any
  // message of the turn, including a system notice beside the final answer.
  // A complete turn's own rows can be loaded while its delayed receipt is
  // omitted elsewhere. Merge projected denial IDs with loaded receipts so
  // newer live denials still apply. Without those IDs, retain the projection;
  // a sparse page also needs its full-turn counts. Missing metadata is unknown.
  const projectedDeniedToolUseIds = transcriptTurn?.deniedToolUseIds;
  const cleanDeniedToolUseIds = useMemo(
    () =>
      new Set([
        ...getTurnSafetyDeniedToolUseIds(
          group.assistantMessages,
          receiptOwnerId,
        ),
        ...(projectedDeniedToolUseIds ?? []),
      ]),
    [group.assistantMessages, receiptOwnerId, projectedDeniedToolUseIds],
  );
  // Settled only on an authoritative completion stamp; a turn that merely
  // went quiet keeps its unresolved calls pending.
  const turnSettled =
    group.isComplete &&
    group.timerMessage.blocks.some(
      (block) =>
        block.type === 'turn_timer' && typeof block.completedAt === 'number',
    );
  // The tooltip's steps, from fully loaded rows only: a paged turn's
  // tooltip says its counts instead. A paged turn's missing results may be
  // on another page, so they are no evidence of an interruption.
  const pagedTurn = transcriptTurn?.before !== undefined;
  const outcomeEvidence = useMemo(
    () => ({ settled: turnSettled, resultsComplete: !pagedTurn }),
    [turnSettled, pagedTurn],
  );
  const usesProjectedOutcomes =
    transcriptTurn?.before !== undefined ||
    (transcriptTurn?.complete === true &&
      projectedDeniedToolUseIds === undefined);
  const computedOutcomes = useMemo(
    () =>
      computeTurnOutcomes(
        [...intermediateMessages, ...trailingToolMessages],
        group.assistantMessages,
        receiptOwnerId,
        projectedDeniedToolUseIds,
        outcomeEvidence,
      ),
    [
      intermediateMessages,
      trailingToolMessages,
      group.assistantMessages,
      receiptOwnerId,
      projectedDeniedToolUseIds,
      outcomeEvidence,
    ],
  );
  const outcomes = usesProjectedOutcomes
    ? transcriptTurn?.outcomes
    : computedOutcomes;
  // Most turns have no outcome to list.
  const hasOutcomes = hasTurnOutcomes(outcomes);
  const outcomeSteps = useMemo(
    () =>
      pagedTurn || !hasOutcomes
        ? undefined
        : getTurnOutcomeStepDetails(
            [...intermediateMessages, ...trailingToolMessages],
            group.assistantMessages,
            receiptOwnerId,
            projectedDeniedToolUseIds,
            outcomeEvidence,
          ),
    [
      pagedTurn,
      hasOutcomes,
      intermediateMessages,
      trailingToolMessages,
      group.assistantMessages,
      receiptOwnerId,
      projectedDeniedToolUseIds,
      outcomeEvidence,
    ],
  );
  // The step a landing aims at: the requested one when it is loaded, else
  // the first blocked one in transcript order, else the first errored one,
  // else the first interrupted one, among the rows loaded so far.
  const landingStep = useMemo(() => {
    if (landing === null) return undefined;
    const steps = getTurnOutcomeSteps(
      [...intermediateMessages, ...trailingToolMessages],
      group.assistantMessages,
      receiptOwnerId,
      projectedDeniedToolUseIds,
      outcomeEvidence,
    );
    const requested =
      landing.toolUseId === undefined
        ? undefined
        : steps.find((candidate) => candidate.toolUseId === landing.toolUseId);
    if (requested === undefined && usesProjectedOutcomes) {
      // A sparse tail cannot establish the first affected step unless all
      // outcomes of the preferred kind are present. Keep section-head focus
      // rather than landing on a later failure or a later blocked row.
      const kind = outcomes?.blocked
        ? 'blocked'
        : outcomes?.failed
          ? 'failed'
          : 'interrupted';
      if (
        !outcomes ||
        steps.filter((step) => step.outcome === kind).length !== outcomes[kind]
      )
        return undefined;
    }
    const step =
      requested ??
      TURN_OUTCOME_ORDER.map((kind) =>
        steps.find((candidate) => candidate.outcome === kind),
      ).find((candidate) => candidate !== undefined);
    if (!step) return undefined;
    const message = group.assistantMessages.find((candidate) =>
      candidate.blocks.some(
        (block) =>
          (block.type === 'tool_use' ||
            block.type === 'workflow' ||
            block.type === 'agent') &&
          block.toolUseId === step.toolUseId,
      ),
    );
    return message
      ? { toolUseId: step.toolUseId, messageId: message.id }
      : undefined;
  }, [
    landing,
    intermediateMessages,
    trailingToolMessages,
    group.assistantMessages,
    outcomes,
    receiptOwnerId,
    usesProjectedOutcomes,
    projectedDeniedToolUseIds,
    outcomeEvidence,
  ]);
  const landingMessageId = landingStep?.messageId;
  useEffect(() => {
    if (landingMessageId !== undefined) setRevealMessageId(landingMessageId);
  }, [landingMessageId]);
  useEffect(() => {
    // A row reused for another turn starts without its predecessor's landing.
    setLanding(null);
    setRevealMessageId(undefined);
  }, [userMessageId]);
  useEffect(() => {
    if (landing === null) return;
    // The reader acting anywhere outranks a landing still waiting for its row.
    const cancel = (): void => setLanding(null);
    document.addEventListener('pointerdown', cancel, true);
    document.addEventListener('keydown', cancel, true);
    document.addEventListener('wheel', cancel, {
      capture: true,
      passive: true,
    });
    return (): void => {
      document.removeEventListener('pointerdown', cancel, true);
      document.removeEventListener('keydown', cancel, true);
      document.removeEventListener('wheel', cancel, true);
    };
  }, [landing]);
  const toggleSummary: SummaryActionHandler = (origin, control): void => {
    const expanding = isCollapsed && !expansionPending.current;
    toggleCollapsed();
    if (expanding && hasTurnOutcomes(outcomes)) {
      setLanding({ origin, control });
    }
  };
  // Clicking the outcome or a tooltip entry: a collapsed turn expands (and
  // loads) first; an open one keeps its state and lands again.
  const jumpToOutcome = (
    origin: HTMLElement,
    control: HTMLElement | null,
    toolUseId?: string,
  ): void => {
    if (isCollapsed && !expansionPending.current) toggleCollapsed();
    setLanding({ origin, control, toolUseId });
  };

  const hasIntermediateContent =
    pagingTurn?.before !== undefined ||
    intermediateMessages.length > 0 ||
    trailingToolMessages.length > 0;

  // Pre-compute whether any final message has visible (non-task-mgmt) content,
  // so we don't recompute inside the .map() on every render.
  const hasVisibleFinalContent = useMemo(
    () =>
      finalMessages.some(
        (m) =>
          !m.blocks.every(
            (b) =>
              (b.type === 'tool_use' && TASK_MGMT_TOOLS.has(b.toolName)) ||
              b.type === 'turn_timer',
          ),
      ),
    [finalMessages],
  );

  const needsCollapsedMessages =
    group.isComplete &&
    (isCollapsed ||
      (searchMessageId === undefined &&
        group.assistantMessages.length >= PROGRESSIVE_TURN_MESSAGE_THRESHOLD));
  const collapsedMessages = useMemo(() => {
    if (!needsCollapsedMessages) return [];
    const retainedFinalMessages = finalMessages.filter((message) => {
      const isTaskMgmtOnly =
        message.blocks.length > 0 &&
        message.blocks.every(
          (block) =>
            (block.type === 'tool_use' &&
              TASK_MGMT_TOOLS.has(block.toolName)) ||
            block.type === 'turn_timer',
        );
      return (
        !isTaskMgmtOnly || !(hasIntermediateContent || hasVisibleFinalContent)
      );
    });
    const retainedQuestionIds = new Set(
      chatPendingQuestions
        // Answer reservation is optimistic. Keep its component mounted until
        // the card finishes submission, so rollback retains input and errors.
        // Settled answered cards render nothing themselves.
        .filter((question) => question.dismissedAt === undefined)
        .map((question) => question.requestId),
    );
    // Keep the narrow final-message path when there are neither questions,
    // visuals, nor safety notices. The WeakMap predicate avoids rescanning
    // hidden blocks on updates.
    if (
      retainedQuestionIds.size === 0 &&
      !group.assistantMessages.some(displayMessageHasVisual) &&
      !group.assistantMessages.some(displayMessageHasSafetyDenial)
    ) {
      return retainedFinalMessages;
    }
    const finalIds = new Set(
      retainedFinalMessages.map((message) => message.id),
    );
    return group.assistantMessages.flatMap((message) => {
      if (finalIds.has(message.id)) return [message];
      if (displayMessageHasVisual(message)) {
        const visual = visualOnlyDisplayMessage(message);
        if (!displayMessageHasSafetyDenial(message)) return [visual];
        return [
          {
            ...message,
            blocks: message.blocks.filter(
              (block) =>
                block.type === 'approval_safety_denied_info' ||
                visual.blocks.includes(block),
            ),
          },
        ];
      }
      // A safety notice explains why the turn went the way it did, so it
      // stays visible when its denied tool row collapses away.
      const blocks = message.blocks.filter(
        (block) =>
          block.type === 'approval_safety_denied_info' ||
          (block.type === 'text' &&
            block.asyncQuestion &&
            retainedQuestionIds.has(block.asyncQuestion.requestId)),
      );
      if (blocks.length === 0) return [];
      return [
        blocks.length === message.blocks.length
          ? message
          : { ...message, blocks },
      ];
    });
  }, [
    needsCollapsedMessages,
    group.assistantMessages,
    finalMessages,
    chatPendingQuestions,
    hasIntermediateContent,
    hasVisibleFinalContent,
  ]);
  const visibleMessages =
    !group.isComplete || !isCollapsed
      ? group.assistantMessages
      : collapsedMessages;
  const progressiveMountEligible =
    group.isComplete &&
    !isCollapsed &&
    searchMessageId === undefined &&
    revealRequest === undefined &&
    group.assistantMessages.length >= PROGRESSIVE_TURN_MESSAGE_THRESHOLD;

  const renderedVisibleMessages = useMemo(() => {
    // Mounted IDs live in a ref so admitting a batch does not itself force an
    // extra commit. The revision invalidates this memo on the next animation
    // frame after that ref has been populated.
    void progressiveMessageTick;
    if (!progressiveMountEligible) return visibleMessages;
    const retainedIds = new Set(
      collapsedMessages
        .filter((message) => !displayMessageHasVisual(message))
        .map((message) => message.id),
    );
    let unmountedAllowance = PROGRESSIVE_TURN_MESSAGE_BATCH;
    return visibleMessages.filter((message) => {
      if (
        retainedIds.has(message.id) ||
        progressivelyMountedMessageIdsRef.current.has(message.id)
      ) {
        return true;
      }
      if (unmountedAllowance === 0) return false;
      unmountedAllowance -= 1;
      return true;
    });
  }, [
    collapsedMessages,
    progressiveMessageTick,
    progressiveMountEligible,
    visibleMessages,
  ]);
  // Chat detail: `compact` folds back-to-back tool calls into one row ("Ran
  // 3 commands"); `recent` (CAN-4274) also keeps the newest steps of the run
  // a turn is still adding to in view; `detailed` keeps every step its own
  // row.
  const groupToolCalls = chatDetail === 'compact';
  const liveStepWindowEnabled = chatDetail === 'recent';
  // Clean chat look with grouping on: every step between two replies is one
  // closed line, and the running turn's tail is a live line that shimmers
  // what it does. "Show only recent steps" also keeps the work on one line.
  const cleanGrouping = groupToolCalls || liveStepWindowEnabled;
  const cleanSegments = useMemo(
    () => segmentCleanSteps(renderedVisibleMessages),
    [renderedVisibleMessages],
  );
  const renderMessageItem = (msg: DisplayMessage): JSX.Element => {
    // With the live step window a row can be part of a message, or a trimmed
    // copy of one; key, settle and place it by the message it came from.
    const piece = stepPieceOf(msg);
    return (
      <ChatMessageItem
        key={piece.key}
        message={msg}
        blockKeyOffset={piece.blockOffset}
        visualOnly={
          isCollapsed &&
          displayMessageHasVisual(msg) &&
          !finalMessages.includes(piece.source)
        }
        turnExpanded={!isCollapsed}
        forceSearchExpanded={searchMessageId === msg.id}
        streaming={!group.isComplete}
        settled={
          group.isComplete ||
          !piece.endsSource ||
          piece.source !== visibleMessages[visibleMessages.length - 1]
        }
        turnSettled={turnSettled}
        chatPendingQuestions={chatPendingQuestions}
        invocableMentionIndex={invocableMentionIndex}
        filePathMentionIndex={filePathMentionIndex}
        originChatTabId={chatId}
        isCodeReviewChat={isCodeReviewChat}
      />
    );
  };
  useEffect(() => {
    // Wait for the existing lifecycle: the expansion committed, the turn's
    // history page installed and the expanded rows mounted, progressively
    // and in order for a large turn, so rows above the target are already in
    // place when it appears. Each of those re-runs this effect; between them
    // a bounded frame retry covers rows that mount a frame late, and a turn
    // that stops making progress gives up. A failed load keeps the
    // section-head landing.
    if (landing === null || isCollapsed || historyLoading) return;
    if (historyError) {
      setLanding(null);
      return;
    }
    if (landingStep === undefined && transcriptTurn?.before === undefined) {
      setLanding(null);
      return;
    }
    const deadline = performance.now() + LANDING_RETRY_MS;
    let frame = 0;
    const attempt = (): void => {
      const turnSelector = `[data-chat-turn-group="${CSS.escape(userMessageId)}"]`;
      const scroller = landing.origin.closest(
        '[data-testid="chat-message-list-scroll"]',
      );
      const scope =
        landing.origin.closest(turnSelector) ??
        (scroller ?? document).querySelector(turnSelector);
      const row =
        landingStep && scope
          ? scope.querySelector<HTMLElement>(
              `[data-tool-use-id="${CSS.escape(landingStep.toolUseId)}"]`,
            )
          : null;
      if (row) {
        landingTravel.current?.();
        const cancelTravel = landOnToolRow(
          row,
          landing.origin,
          landing.control,
        );
        const cancelRing = ringChatCallFocus(row);
        landingTravel.current = (): void => {
          cancelTravel?.();
          cancelRing();
        };
        setLanding(null);
        return;
      }
      if (performance.now() >= deadline) {
        setLanding(null);
        return;
      }
      frame = requestAnimationFrame(attempt);
    };
    frame = requestAnimationFrame(attempt);
    return (): void => cancelAnimationFrame(frame);
  }, [
    landing,
    landingStep,
    isCollapsed,
    historyLoading,
    historyError,
    transcriptTurn,
    renderedVisibleMessages,
    userMessageId,
  ]);
  useLayoutEffect(() => {
    if (isCollapsed) {
      progressivelyMountedMessageIdsRef.current.clear();
      return;
    }
    for (const message of renderedVisibleMessages) {
      progressivelyMountedMessageIdsRef.current.add(message.id);
    }
  }, [isCollapsed, renderedVisibleMessages]);
  useEffect(() => {
    if (
      !progressiveMountEligible ||
      renderedVisibleMessages.length >= visibleMessages.length
    ) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      setProgressiveMessageTick((current) => current + 1);
    });
    return (): void => window.cancelAnimationFrame(frame);
  }, [
    progressiveMountEligible,
    renderedVisibleMessages.length,
    visibleMessages.length,
  ]);

  // Reset is eligible only on turns whose snapshot was captured, that
  // produced visible file changes, AND that haven't already been rolled
  // back by a later marker — there's nothing to undo on a turn with no
  // diff stats or on an already-reverted turn (its snapshot is what's
  // currently checked out), and the action would be confusing.
  const turnEligibleForReset =
    (turnDiff?.treeRefs?.length ?? 0) > 0 &&
    (turnDiff?.files.length ?? 0) > 0 &&
    !isReverted;
  const userResetHandler =
    !readOnly && onResetToPoint && turnEligibleForReset
      ? onResetToPoint
      : undefined;
  // The clean changes card's Undo asks first, like the prompt's Revert.
  const [undoConfirmOpen, setUndoConfirmOpen] = useState(false);
  // The reply's Copy button copies the turn's answer, the final messages'
  // text, or every reply text when there is no final one (CAN-4704).
  const replyCopyText = useMemo((): string => {
    const textOf = (messages: readonly DisplayMessage[]): string =>
      messages
        .flatMap((message) =>
          message.blocks.flatMap((block) =>
            block.type === 'text' && block.text.trim() !== ''
              ? [block.text]
              : [],
          ),
        )
        .join('\n\n');
    return textOf(finalMessages) || textOf(group.assistantMessages);
  }, [finalMessages, group.assistantMessages]);
  // A finished plan turn copies its plan, not its prose, through the same
  // policy as the web transcript; only reading these blocks is desktop's
  // (CAN-5354). Each call counts once, in the order the agent made it.
  const planCopy = useMemo((): PlanCopyState | undefined => {
    if (!group.isComplete) return undefined;
    const calls: PlanTurnToolCall[] = [];
    const seen = new Set<string>();
    for (const message of group.assistantMessages) {
      for (const block of message.blocks) {
        if (
          block.type !== 'tool_use' ||
          (block.toolName !== 'ExitPlanMode' && block.toolName !== 'Write') ||
          seen.has(block.toolUseId)
        ) {
          continue;
        }
        seen.add(block.toolUseId);
        calls.push({
          toolName: block.toolName,
          input: block.input,
          ...(block.result
            ? { outcome: block.result.isError ? 'error' : 'success' }
            : {}),
        });
      }
    }
    const resolution = resolvePlanTurn(calls);
    return resolution.kind === 'none'
      ? undefined
      : planCopyStateFromResolution(resolution);
  }, [group.isComplete, group.assistantMessages]);
  const fallbackCopyAction =
    planCopy !== undefined ? (
      <PlanCopyAction
        key={group.userMessage.id}
        state={planCopy}
        appearance="footer"
        dataTestId="turn-copy-plan"
      />
    ) : group.isComplete && replyCopyText.trim() !== '' ? (
      <ChatCopyAction
        key={group.userMessage.id}
        text={replyCopyText}
        dataTestId="turn-copy-message"
      />
    ) : undefined;
  const timerBlock =
    group.timerMessage.blocks.length === 1 &&
    group.timerMessage.blocks[0].type === 'turn_timer'
      ? group.timerMessage.blocks[0]
      : null;
  const isActiveTimer =
    timerBlock !== null &&
    (timerBlock.completedAt === null || timerBlock.completedAt === undefined);
  // The dock's pending approval pauses only this chat's unfinished turn.
  const waitingForUser = waitingForApproval && isActiveTimer;
  // Which of this turn's unresolved calls those approvals hold. Only the
  // waiting turn subscribes; every other turn keeps the empty signal.
  const turnApprovals = useChatStore(
    useShallow((s): readonly ApprovalRequestEvent[] =>
      waitingForUser && !group.isComplete && chatTarget !== null
        ? Object.values(s.pendingApprovals).filter(
            (approval) =>
              approval.projectId === chatTarget.projectId &&
              approval.worktreeId === chatTarget.worktreeId &&
              approval.chatId === chatTarget.chatId,
          )
        : NO_APPROVALS,
    ),
  );
  const approvalWait = useMemo(
    () =>
      turnApprovals.length === 0
        ? NO_TOOL_APPROVAL_WAIT
        : desktopTurnApprovalWait(
            turnApprovals,
            group.assistantMessages,
            turnFiles,
            pendingPathAliases,
          ),
    [turnApprovals, group.assistantMessages, turnFiles, pendingPathAliases],
  );
  // One pending status from submission to the first visible reply or step.
  // Auto routing names its own wait, so "Choosing a model…" replaces it.
  const showStarting =
    starting &&
    isActiveTimer &&
    !showChoosingModel &&
    !group.assistantMessages.some(
      (message) =>
        message.role === 'assistant' &&
        message.blocks.some((block) =>
          block.type === 'tool_use' && block.toolName === 'ExitPlanMode'
            ? extractExitPlanModePlan(block.input) !== null
            : isStartingTurnOutput(block.type, block),
        ),
    );
  // Running prompt actions retain their live-session rules; every completed
  // reply, including a background wake, gets its own snapshot actions.
  const promptHead = group.userMessage.role === 'user';
  // One resolved end for the summary, header and footer, so none of them
  // says "Completed" for a turn the others call interrupted.
  const completionStatus = resolveTurnCompletionStatus({
    settled: turnSettled,
    recorded:
      turnOutcome === 'failed' || turnOutcome === 'cancelled'
        ? turnOutcome
        : turnInterrupted
          ? 'interrupted'
          : undefined,
    outcomes,
  });
  const headerOutcome =
    completionStatus === undefined || completionStatus === 'complete'
      ? undefined
      : completionStatus;
  const forksActiveTurn =
    !group.isComplete && (isActiveTimer || continuationActive);
  const showForkAction =
    !readOnly &&
    chatTabFork === true &&
    Boolean(chatId) &&
    (forksActiveTurn
      ? promptHead &&
        sourceSdkSessionId !== undefined &&
        !suppressActiveForkAction
      : group.isComplete &&
        (isLastForkableTurnGroup || hasForkableAssistantContent(group)));
  // Note: in raw `source.messages` the turn timer is appended right after
  // the user message (before any assistant content arrives) — only
  // `reorderMessagesForDisplay` floats it to the end for rendering. So we
  // identify the turn for fork/branch truncation by the user message id;
  // the store cuts up to the next reply boundary.
  // Wake heads are display-only. Their persisted timer anchors the selected
  // execution; the store stops before the next prompt or autonomous execution.
  const forkAfterUserMessageId = promptHead
    ? group.userMessage.id
    : group.timerMessage.id;

  // Watcher (eye) button next to the active-turn fork action. Only shown for a
  // real worktree chat while its turn is active — a chat-completion watcher can
  // only be created against a turn that is still running (or held open).
  const canWatch =
    !readOnly &&
    isActiveTimer &&
    Boolean(chatId) &&
    selectedWorktreeProjectId !== undefined &&
    selectedWorktreeWorktreeId !== undefined &&
    !isCoworkChatTarget(selectedWorktreeProjectId) &&
    selectedWorktreeProjectId !== APP_ADVISOR_PROJECT_ID &&
    selectedWorktreeProjectId !== PIPELINE_EDITOR_PROJECT_ID &&
    selectedWorktreeProjectId !== PLAN_EXPLORE_CHAT_PROJECT_ID;
  const watcherButton =
    canWatch &&
    chatId &&
    selectedWorktreeProjectId &&
    selectedWorktreeWorktreeId ? (
      <ChatWatcherButton
        projectId={selectedWorktreeProjectId}
        worktreeId={selectedWorktreeWorktreeId}
        chatId={chatId}
      />
    ) : undefined;
  const archiveToggleButton =
    !readOnly &&
    isActiveTimer &&
    autoArchiveTurnState?.visible === true &&
    chatId &&
    selectedWorktreeProjectId &&
    selectedWorktreeWorktreeId ? (
      <AutoArchiveToggleButton
        enabled={autoArchiveTurnState.enabled}
        target={{
          projectId: selectedWorktreeProjectId,
          worktreeId: selectedWorktreeWorktreeId,
          chatId,
        }}
        onToggle={(): void => {
          setAutoArchiveForActiveTurn(
            {
              projectId: selectedWorktreeProjectId,
              worktreeId: selectedWorktreeWorktreeId,
              chatId,
            },
            !autoArchiveTurnState.enabled,
          );
        }}
      />
    ) : undefined;
  // Share affordance sits with the fork/branch actions on each substantive
  // completed reply (its natural "share this finished session" home now that it
  // has moved out of the composer). Only rendered for a real, non-file chat tab
  // resolved from the store; enablement (busy/empty) is handled by the control.
  // Turn-level thumbs up/down (CAN-1521). The `chatId === undefined` check is
  // the ENTIRE read-only gate: `TranscriptViewer` passes no `chatId` and is the
  // only consumer behind the audit trail, pipeline step detail, and workflow
  // run views, so those surfaces are excluded by construction.
  //
  // Reverted turns intentionally keep the control — a reverted turn is the
  // highest-signal thumbs-down there is.
  const feedbackControl =
    !readOnly &&
    group.isComplete &&
    !isActiveTimer &&
    chatId !== undefined &&
    selectedWorktreeProjectId !== undefined &&
    selectedWorktreeWorktreeId !== undefined ? (
      <TurnFeedbackSlot
        target={{
          projectId: selectedWorktreeProjectId,
          worktreeId: selectedWorktreeWorktreeId,
          chatId,
        }}
        userMessageId={group.userMessage.id}
      />
    ) : undefined;
  const shareButton =
    !isActiveTimer &&
    showForkAction &&
    chatId &&
    selectedWorktreeProjectId &&
    selectedWorktreeWorktreeId &&
    canTransferChatSession(selectedWorktreeProjectId) &&
    shareTabState ? (
      <ShareSessionControl
        variant="icon-button"
        projectId={selectedWorktreeProjectId}
        worktreeId={selectedWorktreeWorktreeId}
        chatId={chatId}
        title={shareTabState.title}
        hasMessages={shareTabState.hasMessages}
        busy={shareTabState.busy}
        sharedRun={shareTabState.sharedRun}
        testId="turn-share-session"
      />
    ) : undefined;

  // Comments affordance rides next to the share control, but only once the
  // session is actually shared as a run (CAN-397) — an unshared session has no
  // comment surface, so the footer stays exactly as it was.
  const commentsButton =
    !isActiveTimer &&
    showForkAction &&
    chatId &&
    selectedWorktreeProjectId &&
    selectedWorktreeWorktreeId &&
    shareTabState?.sharedRun ? (
      <RunCommentsButton
        projectId={selectedWorktreeProjectId}
        worktreeId={selectedWorktreeWorktreeId}
        chatId={chatId}
        title={shareTabState.title}
        unreadCount={shareTabState.sharedRun.unreadCommentCount ?? 0}
      />
    ) : undefined;

  // Clean chat look: the reply row is Copy, Fork, then "•••" with Branch,
  // Share (and Run comments) and Good / Bad response, then the time.
  const branchHandler =
    showForkAction && canBranch && !isActiveTimer && chatId
      ? (): void => {
          void branchTab(chatId, forkTarget, { forkAfterUserMessageId });
        }
      : undefined;
  const moreMenu =
    chatId &&
    selectedWorktreeProjectId &&
    selectedWorktreeWorktreeId &&
    (branchHandler !== undefined ||
      shareButton !== undefined ||
      feedbackControl !== undefined) ? (
      <TurnMoreActions
        projectId={selectedWorktreeProjectId}
        worktreeId={selectedWorktreeWorktreeId}
        chatId={chatId}
        {...(branchHandler !== undefined ? { onBranch: branchHandler } : {})}
        {...(shareButton !== undefined && shareTabState
          ? { share: shareTabState }
          : {})}
        {...(feedbackControl !== undefined
          ? {
              feedback: {
                target: {
                  projectId: selectedWorktreeProjectId,
                  worktreeId: selectedWorktreeWorktreeId,
                  chatId,
                },
                userMessageId: group.userMessage.id,
              },
            }
          : {})}
      />
    ) : undefined;

  const forkHandler =
    showForkAction && chatId
      ? (): void => {
          if (forksActiveTurn) {
            forkTab(chatId, forkTarget, {
              includeActiveTurn: true,
              ...(sourceSdkSessionId ? { sourceSdkSessionId } : {}),
            });
            return;
          }
          forkTab(chatId, forkTarget, { forkAfterUserMessageId });
        }
      : undefined;
  // Clean chat look: while the turn runs, its watch, fork and auto-archive
  // actions sit at the end of the "Working for" header, and the row under
  // the reply holds the live line, so that row keeps one height from the
  // first frame to the last.
  const cleanLiveActions =
    isActiveTimer &&
    (watcherButton !== undefined ||
      forkHandler !== undefined ||
      archiveToggleButton !== undefined) ? (
      <>
        {watcherButton}
        {forkHandler ? <ForkChatButton onClick={forkHandler} /> : null}
        {archiveToggleButton}
      </>
    ) : undefined;
  // Without grouping, the step still running on screen shimmers itself; the
  // live line only says "Thinking" while none does.
  const lastShownBlocks =
    renderedVisibleMessages[renderedVisibleMessages.length - 1]?.blocks ?? [];
  const lastShownBlock = lastShownBlocks[lastShownBlocks.length - 1];
  const stepShimmersOnScreen =
    lastShownBlock !== undefined &&
    (((lastShownBlock.type === 'tool_use' || lastShownBlock.type === 'agent') &&
      lastShownBlock.result === undefined) ||
      lastShownBlock.type === 'thinking');
  const lastCleanSegment = cleanSegments[cleanSegments.length - 1];
  const liveLineInSteps =
    (!cleanGrouping || liveStepWindowEnabled) &&
    lastCleanSegment?.kind === 'steps';
  const cleanLiveLine =
    !showStarting &&
    !group.isComplete &&
    (cleanGrouping && !liveStepWindowEnabled
      ? cleanSegments[cleanSegments.length - 1]?.kind !== 'steps'
      : !stepShimmersOnScreen) ? (
      <CleanToolStepGroup
        live
        workingLabel={showChoosingModel ? 'Choosing a model…' : undefined}
        isCodeReviewChat={isCodeReviewChat}
      />
    ) : null;

  // When this turn was rolled back by a later revert_info marker, wrap the
  // whole turn output in a faded + bordered container so the discarded
  // attempt reads as inactive without altering the data model. Plain
  // function so the wrapper component identity is stable across renders.
  const wrapReverted = (children: ReactNode): JSX.Element =>
    isReverted ? (
      <RevertedTurnWrapper>{children}</RevertedTurnWrapper>
    ) : (
      <>{children}</>
    );

  // Reverted turns collapse to a single bar by default — the bad attempt
  // shouldn't dominate the transcript. The bar shows a preview of the
  // user's prompt so it's still scannable; click expands the full content.
  const userPromptPreview = useMemo(() => {
    const text = group.userMessage.blocks
      .flatMap((b) => (b.type === 'text' ? [b.text.trim()] : []))
      .filter((t) => t.length > 0)
      .join(' ')
      .replace(/\s+/g, ' ');
    if (text.length <= 80) return text;
    return text.slice(0, 80).trimEnd() + '…';
  }, [group.userMessage.blocks]);

  const liveHeader = (
    <TurnWorkHeader
      startedAt={timerBlock?.startedAt}
      finishedAt={null}
      pausedAt={timerBlock?.pausedAt}
      resumedAt={timerBlock?.resumedAt}
      accumulatedPausedDurationMs={timerBlock?.accumulatedPausedDurationMs}
      waitingForUser={waitingForUser}
      live
      trailing={cleanLiveActions}
      dataTestId="turn-work-header"
    />
  );

  if (isReverted && isRevertedCollapsed) {
    return wrapReverted(
      <button
        type="button"
        onClick={(): void => setIsRevertedCollapsed(false)}
        aria-expanded={false}
        aria-label="Expand reverted turn"
        className="focus-ring flex w-full items-center gap-2 rounded-md border bg-fg-primary/[0.02] px-3 py-1.5 text-left text-xs fg-secondary transition-colors hover:bg-fg-primary/[0.04]"
      >
        <span className="flex-shrink-0">
          <ChevronRightIcon />
        </span>
        <span className="font-medium fg-primary/80">Reverted</span>
        {userPromptPreview ? (
          <span className="truncate">— {userPromptPreview}</span>
        ) : null}
      </button>,
    );
  }

  return wrapReverted(
    <ToolApprovalWaitProvider value={approvalWait}>
      {isReverted && (
        <button
          type="button"
          onClick={(): void => setIsRevertedCollapsed(true)}
          aria-expanded={true}
          aria-label="Collapse reverted turn"
          className="focus-ring flex w-full items-center gap-2 rounded-md border bg-fg-primary/[0.02] px-3 py-1.5 text-left text-xs fg-secondary transition-colors hover:bg-fg-primary/[0.04]"
        >
          <span className="flex-shrink-0">
            <ChevronDownIcon />
          </span>
          <span className="font-medium fg-primary/80">Reverted</span>
          {userPromptPreview ? (
            <span className="truncate">— {userPromptPreview}</span>
          ) : null}
        </button>
      )}
      {!hideUserMessage && (
        <ChatMessageItem
          message={group.userMessage}
          appliedMemory={appliedMemory}
          chatPendingQuestions={chatPendingQuestions}
          onResetToPoint={userResetHandler}
          invocableMentionIndex={invocableMentionIndex}
          filePathMentionIndex={filePathMentionIndex}
          originChatTabId={chatId}
          forceExpandedUserMessage={forceExpandedUserMessage}
          onJumpToMessage={onJumpToMessage}
          onShowSpawningCall={onShowSpawningCall}
        />
      )}
      {/* Clean chat look: the running turn opens with "Working for 28s"; once
          it is done the folded steps' header reads "Worked for 3m 24s". The
          header opens a just-submitted first send with "Starting…" instead. */}
      {showStarting ? (
        <TurnWorkHeader
          starting
          setup={startingSetup}
          dataTestId="turn-starting-status"
        />
      ) : !group.isComplete ? (
        stickyTurnSummary && !isReverted ? (
          // Pinned like the finished turn's header, in the same wrapper, so
          // finishing only changes its words.
          <StickyTurnSummary>
            <div className="relative bg-base before:absolute before:inset-x-0 before:-top-2 before:h-2 before:bg-base">
              {liveHeader}
            </div>
          </StickyTurnSummary>
        ) : (
          liveHeader
        )
      ) : null}

      {hasIntermediateContent && group.isComplete ? (
        <>
          {stickyTurnSummary && !isReverted ? (
            // Pins below the sticky user message. The containing block is
            // this turn's own wrapper, so the summary unsticks at the turn's
            // end and the next turn's summary (e.g. a watcher-fired
            // follow-up's) scrolls into the pinned slot in its place. The
            // fade band mirrors the sticky header's: sized to the inter-item
            // gap, invisible in normal flow, softening content that slides
            // under the pinned row.
            <StickyTurnSummary>
              {/* Opaque backdrop behind the flat summary row plus a `before`
                  strip filling the gap above it, so the pinned bubble and this
                  row read as one covered stack with no content showing between
                  them. It deliberately stops at the row's bottom edge: a band
                  running past the last banner is what read as a black bar
                  sitting on the transcript. */}
              <div className="relative bg-base before:absolute before:inset-x-0 before:-top-2 before:h-2 before:bg-base">
                <DesktopCollapsedTurnSummary
                  counts={summary}
                  outcomes={outcomes}
                  outcomeSteps={outcomeSteps}
                  isExpanded={!isCollapsed}
                  onToggle={toggleSummary}
                  onJumpToOutcome={jumpToOutcome}
                  isCodeReviewChat={isCodeReviewChat}
                  userMessageId={group.userMessage.id}
                  timer={timerBlock ?? undefined}
                  outcome={headerOutcome}
                />
              </div>
            </StickyTurnSummary>
          ) : (
            <DesktopCollapsedTurnSummary
              counts={summary}
              outcomes={outcomes}
              outcomeSteps={outcomeSteps}
              isExpanded={!isCollapsed}
              onToggle={toggleSummary}
              onJumpToOutcome={jumpToOutcome}
              isCodeReviewChat={isCodeReviewChat}
              userMessageId={group.userMessage.id}
              timer={timerBlock ?? undefined}
              outcome={headerOutcome}
            />
          )}
        </>
      ) : null}

      {(historyLoading || !isCollapsed || !group.isComplete) &&
        pagingTurn?.before !== undefined &&
        onLoadHistory && (
          <TranscriptPagingControls
            key={pagingTurn.before}
            loading={historyLoading}
            suspended={historySuspended}
            error={historyError}
            hasEarlier
            onLoadEarlier={loadHistory}
            onReload={loadHistory}
          />
        )}

      {/* One keyed list keeps question input mounted through turn completion
          and expand/collapse, while preserving the original message order.
          Questions never fold into a tool-step group, so they stay keyed at
          this level. */}
      <>
        {cleanSegments.map((segment, index) =>
          segment.kind === 'message' ? (
            renderMessageItem(segment.message)
          ) : !cleanGrouping ? (
            <div
              key={`clean-steps-${segment.key}`}
              className={STEP_GROUP_BODY_CLASS}
              data-testid="chat-tool-step-detailed"
            >
              {segment.messages.map(renderMessageItem)}
              {segment === lastCleanSegment && liveLineInSteps && cleanLiveLine}
            </div>
          ) : (
            <CleanToolStepGroup
              key={`clean-steps-${segment.key}`}
              segment={segment}
              trailingActivity={
                liveStepWindowEnabled && segment === lastCleanSegment
                  ? cleanLiveLine
                  : undefined
              }
              live={!group.isComplete && index === cleanSegments.length - 1}
              outcomeEvidence={outcomeEvidence}
              deniedToolUseIds={cleanDeniedToolUseIds}
              workingLabel={showChoosingModel ? 'Choosing a model…' : undefined}
              forceExpanded={segment.messages.some((message) => {
                const id = stepPieceOf(message).source.id;
                return (
                  (searchMessageId !== undefined && id === searchMessageId) ||
                  (revealMessageId !== undefined && id === revealMessageId)
                );
              })}
              openRequest={
                revealRequest !== undefined &&
                segment.messages.some(
                  (message) => message.id === revealRequest.messageId,
                )
                  ? revealRequest
                  : undefined
              }
              isCodeReviewChat={isCodeReviewChat}
              liveSteps={
                liveStepWindowEnabled &&
                !group.isComplete &&
                index === cleanSegments.length - 1
                  ? liveStepWindow(segment.messages).map(renderMessageItem)
                  : undefined
              }
              hiddenSteps={
                liveStepWindowEnabled &&
                !group.isComplete &&
                index === cleanSegments.length - 1
                  ? stepsBeforeLiveWindow(segment.messages).map(
                      renderMessageItem,
                    )
                  : undefined
              }
            >
              {segment.messages.map(renderMessageItem)}
            </CleanToolStepGroup>
          ),
        )}
      </>

      {/* Live runs stay in the drawer; finished runs remain discoverable
          even when the parent turn is paused or still working. */}
      {recordArtifacts.length > 0 ? (
        <DesktopAgentActivitySection
          key={group.userMessage.id}
          artifacts={recordArtifacts}
          variant="completed"
          defaultExpanded={isLastTurnGroup}
          ownerUserMessageId={group.userMessage.id}
          chatTarget={routedChatTarget}
        />
      ) : null}

      {(group.isComplete &&
        !hideTurnDiffSummary &&
        turnDiff &&
        turnDiff.files.length > 0) ||
      locatedTurnFiles.length > 0 ||
      pendingTurnFiles.length > 0 ? (
        <TurnDiffSummary
          turnDiff={
            group.isComplete && !hideTurnDiffSummary ? turnDiff : undefined
          }
          files={locatedTurnFiles}
          pendingFiles={pendingTurnFiles}
          fileTarget={routedChatTarget}
          turnId={group.userMessage.id}
          isLastTurnGroup={isLastTurnGroup}
          originChatTabId={chatId}
          {...(userResetHandler && group.isComplete
            ? {
                onUndo: (): void => {
                  setUndoConfirmOpen(true);
                },
              }
            : {})}
        />
      ) : null}
      {undoConfirmOpen && userResetHandler ? (
        <ResetToPointDialog
          onConfirm={async (): Promise<void> => {
            await userResetHandler(resetTurnId ?? group.userMessage.id);
            setUndoConfirmOpen(false);
          }}
          onCancel={(): void => {
            setUndoConfirmOpen(false);
          }}
        />
      ) : null}

      {showStarting ? null : timerBlock ? (
        <TurnTimer
          key={`timer-${group.userMessage.id}`}
          pending={pendingTimer}
          startedAt={timerBlock.startedAt}
          pausedAt={timerBlock.pausedAt}
          resumedAt={timerBlock.resumedAt}
          accumulatedPausedDurationMs={timerBlock.accumulatedPausedDurationMs}
          waitingForUser={waitingForUser}
          completedAt={timerBlock.completedAt ?? null}
          completionStatus={completionStatus}
          workingLabel={showChoosingModel ? 'Choosing a model…' : undefined}
          liveLine={liveLineInSteps ? null : cleanLiveLine}
          autoRoutedModel={autoRoutedModel}
          watcherButton={watcherButton}
          archiveToggleButton={archiveToggleButton}
          shareButton={moreMenu ? undefined : shareButton}
          moreMenu={moreMenu}
          feedbackControl={moreMenu ? undefined : feedbackControl}
          {...(planCopy !== undefined
            ? { planCopy }
            : group.isComplete
              ? { copyText: replyCopyText }
              : {})}
          commentsButton={moreMenu ? undefined : commentsButton}
          showForkAction={showForkAction}
          onFork={forkHandler}
          showBranchAction={
            !moreMenu && showForkAction && canBranch && !isActiveTimer
          }
          onBranch={
            showForkAction && canBranch && chatId
              ? (): void => {
                  void branchTab(chatId, forkTarget, {
                    forkAfterUserMessageId,
                  });
                }
              : undefined
          }
        />
      ) : (
        <>
          <ChatMessageItem
            message={group.timerMessage}
            chatPendingQuestions={chatPendingQuestions}
            invocableMentionIndex={null}
            filePathMentionIndex={null}
            originChatTabId={chatId}
          />
          {/*
            `timerBlock` is null whenever the timer message carries anything
            other than exactly one `turn_timer` block, and the feedback control
            normally rides beside `TurnTimer`'s completion stamp. Without
            this branch a completed turn in that shape would render no thumbs at
            all, so the control is pinned to its own right-aligned row here and
            the affordance stays available for every completed turn. The
            reply's Copy joins it there for the same reason (CAN-4704). Like
            the timer row's, both stay visible at rest.
          */}
          {(fallbackCopyAction !== undefined ||
            forkHandler !== undefined ||
            moreMenu !== undefined ||
            feedbackControl !== undefined) && (
            <TurnFooterRow variant="actions" data-testid="turn-feedback-row">
              {fallbackCopyAction}
              {forkHandler ? <ForkChatButton onClick={forkHandler} /> : null}
              {moreMenu ?? (
                <>
                  {shareButton}
                  {commentsButton}
                  {feedbackControl}
                </>
              )}
            </TurnFooterRow>
          )}
        </>
      )}
    </ToolApprovalWaitProvider>,
  );
});
