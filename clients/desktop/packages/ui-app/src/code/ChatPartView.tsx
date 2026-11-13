'use client';
import { isClaudeAiCreditsFallbackErrorCode } from '@canopy/protocol/llm-gateway';
import {
  readCodexAccountModelAccessFailure,
  type CodexAccountModelAccessFailure,
} from '@canopy/protocol/auth-recovery';

import {
  isAgentDelegationCardData,
  type AgentDelegationCardData,
} from '@canopy/protocol/delegation';

import {
  createContext,
  memo,
  useCallback,
  useContext,
  type ComponentProps,
  type JSX,
  type ReactNode,
} from 'react';
import {
  readTurnTimerAutoRoutedModelLabel,
  type PortalAskUserQuestionAnswer,
  type PortalAskUserQuestionState,
  type PortalChatPart,
  type PortalChatToolFamily,
} from '@canopy/protocol/portal';
import type { TranscriptContentField } from '@canopy/protocol/canopy-core/core';
import {
  Markdown,
  ErrorBanner,
  ClaudeAiCreditsFallbackErrorNotice,
  CodexAccountModelNotice,
  TRANSCRIPT_MARKDOWN_OPTIONS,
  AgentBlockCard,
  AutoRoutedModelPill,
  AnsweredQuestionsBlock,
  AskUserQuestionCard,
  CollapsibleBlock,
  CompactionInfoBlock,
  DeferredAccountProxySwitchPart,
  compactionHeadline,
  FileDeliverableCard,
  ThinkingSpinner,
  ToolCallCard,
  TurnTimer,
  askUserQuestionCount,
  askUserQuestionResultEvidence,
  askUserQuestionRowLabel,
  extractExitPlanModePlan,
  getToolDisplayInfo,
  getToolRowInput,
  getToolDisplayFamily,
  isAskUserQuestionToolName,
  markdownOptions,
  parseAskUserQuestionTexts,
  portalAskUserQuestionRecordState,
  readToolCallResult,
  interruptedToolCallResult,
  ToolCallResultSection,
  resolveAskUserQuestionPresentation,
  SUBAGENT_UNTITLED_LABEL,
  type AgentBlockUsage,
  type AskUserQuestionDraft,
  type ToolCallResult,
  type TurnTerminalStatus,
  resolveTurnCompletionStatus,
  useCleanChatLook,
  useSmoothStreaming,
  type PlanCopyState,
  TRANSCRIPT_PROSE_CLASS,
} from '@canopy/ui-shared/components';
import { stripOpaqueAgentCitationMarkers } from '@canopy/ui-shared/lib';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { DotIcon, WrenchIcon } from '@canopy/ui-shared/icons';
import { ChatAssetImage } from './ChatMessageAttachments';
import { ManagedDelegationCard } from './ManagedDelegationCard';
import { useSubagentChatActions } from './subagents/SubagentChatActionsContext';
import {
  DeferredToolOutput,
  ToolOutputReaderContext,
  type ToolOutputIdentity,
} from './DeferredToolOutput';
import { TranscriptReadHostContext } from './transcript-read-host-context';
import {
  AgentCardTaskStopAction,
  agentPartTaskStoppable,
} from './agent-card-task-stop';
import {
  ChatToolResultPart,
  readChatToolResultVisual,
} from './ChatToolResultPart';
import { useClaudeModsSkippedHost } from '../capability/claude-mods/ClaudeModsSkippedHost';
import { DeferredClaudeModsSkippedPart } from '../capability/claude-mods/DeferredClaudeModsSkippedPart';
import { Notice } from '@canopy/ui-shared/components/Notice';

/**
 * Renders one neutral {@link PortalChatPart} by dispatching on its typed `kind`
 * and reusing the write-once `@canopy/ui-shared` chat primitives. The part's
 * free-form `data` is narrowed with type-guard predicates (never `as`). This is
 * the transport-neutral counterpart to the web portal's `PartRenderer` and the
 * desktop `ChatBlockRenderer` — the single place the shared chat transcript
 * turns a part into UI.
 *
 * `appIcon` is injected (not sourced from a brand module) because `@canopy/ui-app`
 * is brand-agnostic; hosts thread their brand logo down for app-action tools.
 */
/**
 * Whether the owning turn is authoritatively settled (its timer carries a
 * completion stamp). A tool call with no result in such a turn renders
 * interrupted; inactivity, a disconnect or `live === false` never sets it.
 */
export const ToolTurnSettledContext = createContext(false);

/**
 * The host brand's tool namespace. App tools under a non-default brand's
 * namespace (and the namespace-gated ones) map to their app rows only when
 * the host supplies it, as it supplies `appIcon`.
 */
export const ToolNamespaceContext = createContext<string | undefined>(
  undefined,
);

export interface ChatPartViewProps {
  readonly part: PortalChatPart;
  readonly messageId?: string;
  /**
   * Whether the owning message is still streaming. Gates the `turn_timer`
   * ticking branch (web renderer parity): a settled message whose timer never
   * received `completedAt` is an interrupted turn, not "working", so it
   * renders nothing rather than a perpetually ticking row. `undefined` (e.g.
   * agent sub-blocks, which never carry timers) preserves the ticking default.
   */
  readonly live?: boolean;
  /**
   * Another part follows this one in its message, so it is done even while
   * the message streams. The clean look's thinking row settles on it.
   */
  readonly settled?: boolean;
  /**
   * How the turn ended when not plainly complete, so a failed, cancelled or
   * interrupted turn never renders a successful completion label. The
   * timer's projected `endReason` applies when this is omitted.
   */
  readonly terminalStatus?: TurnTerminalStatus;
  /** Optional branded app icon for app-action tool calls / agent cards. */
  readonly appIcon?: ReactNode;
  /**
   * Keeps a completed `turn_timer` row visible at rest. Set by hosts that
   * render parts outside a per-turn `group/turn` scope, where the row's
   * hover reveal could never fire (CAN-4278).
   */
  readonly turnTimerAlwaysVisible?: boolean;
  /** Always-visible control beside the owning turn's completion stamp. */
  readonly turnTimerStampAccessory?: ReactNode;
  /** The host column adds the gap between turns; see `TurnTimer`. */
  readonly turnTimerHostTurnGap?: boolean;
  /** Turn actions after the elapsed label, revealed like it on hover/focus. */
  readonly turnTimerTrailing?: ReactNode;
  /** The finished reply's text, for the timer row's Copy button. */
  readonly turnTimerCopyText?: string;
  /** The turn's plan, whose Copy plan replaces the reply's Copy (CAN-5354). */
  readonly turnTimerPlanCopy?: PlanCopyState;
  /** Clean chat look: the running turn's live line, in the timer row's slot. */
  readonly turnTimerLiveLine?: ReactNode;
}

/** Per-request in-flight/error status for an interactive AskUserQuestion. */
export interface AskUserQuestionRequestStatus {
  /** The in-flight action (drives button labels + `aria-busy`). */
  busy?: 'answer' | 'dismiss' | null;
  /** Which action last failed, so the matching retry copy renders. */
  errorKind?: 'submit' | 'dismiss' | null;
}

/**
 * Optional, browser-safe interaction surface for AskUserQuestion tool_use
 * blocks. A host (the web portal) provides the projected question states plus
 * answer/dismiss callbacks; the transcript then renders the interactive card /
 * read-only answer bubbles instead of raw tool JSON. The default is `null`,
 * which preserves every non-portal host (desktop transcript, shared-run viewer)
 * — those keep the generic tool-call rendering. This type carries NO web,
 * desktop, store, IPC, or fetch dependencies.
 */
export interface AskUserQuestionInteraction {
  /** Projected question states for the chat currently being rendered. */
  readonly states: readonly PortalAskUserQuestionState[];
  /** Render read-only with the reconnect helper (relay disconnected). */
  readonly disconnected?: boolean;
  /** Hard-disable the controls (e.g. commands unavailable). */
  readonly disabled?: boolean;
  /** Per-request in-flight/error state. */
  readonly getRequestStatus?: (
    requestId: string,
  ) => AskUserQuestionRequestStatus | undefined;
  /** Host markdown renderer for question/header text. */
  readonly renderMarkdown?: (markdown: string) => ReactNode;
  /** Submit the structured answers for a request. */
  readonly onAnswer: (
    requestId: string,
    answers: PortalAskUserQuestionAnswer[],
  ) => void;
  /** Dismiss a request without answering. */
  readonly onDismiss: (requestId: string) => void;
  /**
   * In-progress answers the host kept for a request, restored when its card
   * mounts (for example after a panel switch). Hosts keep drafts in memory
   * only, because they can hold secret answers.
   */
  readonly getDraft?: (requestId: string) => AskUserQuestionDraft | undefined;
  /** Keep a request's in-progress answers each time the person changes them. */
  readonly onDraftChange?: (
    requestId: string,
    draft: AskUserQuestionDraft,
  ) => void;
}

const AskUserQuestionInteractionContext =
  createContext<AskUserQuestionInteraction | null>(null);

const NO_COMPOSER_QUESTIONS: readonly PortalAskUserQuestionState[] = [];
const ComposerAskUserQuestionsContext = createContext(NO_COMPOSER_QUESTIONS);
/** The host's composer asks every pending question, one at a time. */
const ComposerAsksQuestionsContext = createContext(false);

const EMPTY_WAITING_DELEGATION_IDS: ReadonlySet<string> = new Set();

/** Parent chats identify delegates whose internal request is waiting in queue. */
export const ChatWaitingDelegationsContext = createContext<ReadonlySet<string>>(
  EMPTY_WAITING_DELEGATION_IDS,
);

/**
 * Provide interactive AskUserQuestion behavior to the shared transcript. The
 * value flows to every {@link ChatPartView} below it — including nested agent
 * sub-blocks — so Codex/agent-nested ask-user calls stay interactive. Absent
 * (or `null`) leaves the transcript on the generic tool-call fallback.
 */
export function AskUserQuestionInteractionProvider({
  value,
  composerQuestions = NO_COMPOSER_QUESTIONS,
  composerAsks = false,
  children,
}: {
  value: AskUserQuestionInteraction | null;
  /**
   * Unanswered questions the host's composer asks. The transcript row one of
   * them matches renders nothing, as desktop's does while its composer asks.
   */
  composerQuestions?: readonly PortalAskUserQuestionState[];
  /**
   * The host's composer asks every pending question, one after another, so
   * the transcript shows none of them (the question card is retired where
   * the composer asks). A host whose composer can't ask leaves it off and
   * keeps the card.
   */
  composerAsks?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <AskUserQuestionInteractionContext.Provider value={value}>
      <ComposerAskUserQuestionsContext.Provider value={composerQuestions}>
        <ComposerAsksQuestionsContext.Provider value={composerAsks}>
          {children}
        </ComposerAsksQuestionsContext.Provider>
      </ComposerAskUserQuestionsContext.Provider>
    </AskUserQuestionInteractionContext.Provider>
  );
}

/** Read the optional ask-user interaction surface (null when unprovided). */
export function useAskUserQuestionInteraction(): AskUserQuestionInteraction | null {
  return useContext(AskUserQuestionInteractionContext);
}

/**
 * Host behaviour behind a Codex account model notice's "Use <model>" action
 * (CAN-4716). The host switches the chat's model and resends the failed turn;
 * the shared transcript only asks whether a message's notice may act.
 */
export interface ModelAccessRecoveryInteraction {
  /** True only while that failed row is the chat's live, idle failure. */
  readonly canAct: (messageId: string) => boolean;
  readonly busyMessageId: string | null;
  readonly onUseFallback: (
    messageId: string,
    fallbackModel: string,
  ) => Promise<void>;
}

const ModelAccessRecoveryInteractionContext =
  createContext<ModelAccessRecoveryInteraction | null>(null);

/**
 * Provide the model access recovery action to the shared transcript. Absent
 * (or `null`) renders every notice read-only, as on cloud chats and shared
 * views.
 */
export function ModelAccessRecoveryInteractionProvider({
  value,
  children,
}: {
  value: ModelAccessRecoveryInteraction | null;
  children: ReactNode;
}): JSX.Element {
  return (
    <ModelAccessRecoveryInteractionContext.Provider value={value}>
      {children}
    </ModelAccessRecoveryInteractionContext.Provider>
  );
}

/** Read the optional model access recovery surface (null when unprovided). */
export function useModelAccessRecoveryInteraction(): ModelAccessRecoveryInteraction | null {
  return useContext(ModelAccessRecoveryInteractionContext);
}

function ModelAccessFailurePart({
  failure,
  messageId,
}: {
  failure: CodexAccountModelAccessFailure;
  messageId: string | undefined;
}): JSX.Element {
  const interaction = useModelAccessRecoveryInteraction();
  const fallbackModel = failure.fallbackModel;
  const actionable =
    interaction !== null &&
    messageId !== undefined &&
    fallbackModel !== undefined;
  return (
    <CodexAccountModelNotice
      failure={failure}
      dataTestId="portal-chat-codex-account-model-notice"
      {...(actionable
        ? {
            onUseFallback: (): void => {
              void interaction.onUseFallback(messageId, fallbackModel);
            },
            busy: interaction.busyMessageId === messageId,
            disabled: !interaction.canAct(messageId),
          }
        : {})}
    />
  );
}

export interface DeliverableRef {
  readonly deliverableId: string;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly mediaType: string;
  readonly contentSha256: string;
}

export interface DeliverableInteraction {
  readonly onDownload: (deliverable: DeliverableRef) => void;
  readonly onOpen: (deliverable: DeliverableRef) => void;
}

const DeliverableInteractionContext =
  createContext<DeliverableInteraction | null>(null);

export function DeliverableInteractionProvider({
  value,
  children,
}: {
  value: DeliverableInteraction | null;
  children: ReactNode;
}): JSX.Element {
  return (
    <DeliverableInteractionContext.Provider value={value}>
      {children}
    </DeliverableInteractionContext.Provider>
  );
}

const TurnWorkingStatusContext = createContext<string | null>(null);

/**
 * Provide the label the live turn timer shows in place of `Working...` while
 * the host knows what the in-flight turn is doing (e.g. `Compacting
 * context…`). `null` keeps the default label.
 */
export function TurnWorkingStatusProvider({
  value,
  children,
}: {
  value: string | null;
  children: ReactNode;
}): JSX.Element {
  return (
    <TurnWorkingStatusContext.Provider value={value}>
      {children}
    </TurnWorkingStatusContext.Provider>
  );
}

/** Read the optional working-status label (null when unprovided). */
export function useTurnWorkingStatus(): string | null {
  return useContext(TurnWorkingStatusContext);
}

function readDeliverable(data: Record<string, unknown>): DeliverableRef | null {
  const raw = data['deliverable'];
  if (!isRecord(raw)) return null;
  const deliverableId = readString(raw, 'deliverableId');
  const filename = readString(raw, 'filename');
  const sizeBytes = readNumber(raw, 'sizeBytes');
  const mediaType = readString(raw, 'mediaType');
  const contentSha256 = readString(raw, 'contentSha256');
  if (
    deliverableId === undefined ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      deliverableId,
    ) ||
    filename === undefined ||
    filename.length === 0 ||
    sizeBytes === undefined ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 0 ||
    mediaType === undefined ||
    mediaType.length === 0 ||
    contentSha256 === undefined ||
    !/^[a-f0-9]{64}$/.test(contentSha256)
  ) {
    return null;
  }
  return { deliverableId, filename, sizeBytes, mediaType, contentSha256 };
}

// A Record over the union forces every `PortalChatPart` kind to be listed —
// adding a new kind to the protocol fails to compile here (rather than silently
// dropping coerced sub-blocks of the new kind). The Set is derived from it.
/**
 * How session replay treats each part kind (CAN-5975). `blocked`: the whole
 * part is blocked. `content-blocked`: the part's components block their own
 * content, so its toggles and buttons stay recorded. Every kind must be
 * listed, so a new kind fails to compile until someone decides, and the
 * replay privacy golden renders each one to check nothing it shows escapes.
 */
export const CHAT_PART_REPLAY_POLICY = {
  mcp_activation: 'blocked',
  text: 'blocked',
  tool_use: 'content-blocked',
  tool_result: 'content-blocked',
  thinking: 'content-blocked',
  attachment: 'content-blocked',
  image: 'content-blocked',
  agent: 'content-blocked',
  turn_timer: 'content-blocked',
  steering: 'blocked',
  prompt_source: 'blocked',
  compaction: 'content-blocked',
  account_switch: 'blocked',
  mods_skipped: 'blocked',
} as const satisfies Record<
  PortalChatPart['kind'],
  'blocked' | 'content-blocked'
>;
const PART_KINDS: ReadonlySet<string> = new Set(
  Object.keys(CHAT_PART_REPLAY_POLICY),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
}

function partData(part: PortalChatPart): Record<string, unknown> {
  return isRecord(part.data) ? part.data : {};
}

/** First non-empty string among the common text-carrying fields. */
function readPartText(data: Record<string, unknown>): string {
  return (
    readString(data, 'text') ??
    readString(data, 'content') ??
    readString(data, 'output') ??
    readString(data, 'summary') ??
    ''
  );
}

/** Fold a `{ output|content|text, isError }` result into the shared card shape. */
function readToolResult(data: Record<string, unknown>): ToolCallResult | null {
  return readToolCallResult(data['result']);
}

function rowFieldIdentity(
  value: unknown,
): Extract<ToolOutputIdentity, { kind: 'row' }> | undefined {
  if (
    !isRecord(value) ||
    typeof value.messageId !== 'string' ||
    typeof value.blockOrdinal !== 'number' ||
    !Number.isSafeInteger(value.blockOrdinal) ||
    value.blockOrdinal < 0 ||
    !isTranscriptContentField(value.field)
  )
    return undefined;
  return {
    kind: 'row',
    messageId: value.messageId,
    blockOrdinal: value.blockOrdinal,
    field: value.field,
  };
}

function isTranscriptContentField(
  value: unknown,
): value is TranscriptContentField {
  return (
    value === 'output' ||
    value === 'input' ||
    value === 'text' ||
    value === 'partialText' ||
    value === 'finalText'
  );
}

/** expandedSlot replaces the default input/result chrome, not just its body. */
function ToolOutputSlot({
  identity,
  input,
  result,
}: {
  readonly identity: ToolOutputIdentity;
  readonly input: string;
  readonly result: ToolCallResult;
}): JSX.Element {
  return (
    <>
      {input.length > 0 && (
        <pre
          className={`${REPLAY_BLOCK_CLASS} max-h-50 overflow-auto whitespace-pre-wrap break-all px-2.5 py-2 text-xs fg-secondary`}
        >
          {input}
        </pre>
      )}
      <ToolCallResultSection result={result}>
        <DeferredToolOutput
          identity={identity}
          preview={result.content}
          isError={result.kind === 'error'}
        />
      </ToolCallResultSection>
    </>
  );
}

const PLAN_PROSE_CLASSES = TRANSCRIPT_PROSE_CLASS;
const PLAN_MARKDOWN_OPTIONS = markdownOptions();

/**
 * Read a tool's `input`. Runtime frames carry a stringified input, but the
 * persisted-transcript projector keeps it as a (truncated) object — stringify
 * that so the input panel and the rich `getToolDisplayInfo` label are not empty.
 */
function readToolInput(data: Record<string, unknown>): string {
  const raw = data['input'];
  if (typeof raw === 'string') {
    return raw;
  }
  if (raw === undefined || raw === null) {
    return '';
  }
  try {
    return JSON.stringify(raw);
  } catch {
    return '';
  }
}

function readAgentUsage(
  data: Record<string, unknown>,
): AgentBlockUsage | undefined {
  const raw = data['usage'];
  if (!isRecord(raw)) {
    return undefined;
  }
  const usage: AgentBlockUsage = {
    inputTokens: readNumber(raw, 'inputTokens'),
    outputTokens: readNumber(raw, 'outputTokens'),
    cacheReadInputTokens: readNumber(raw, 'cacheReadInputTokens'),
    cacheCreationInputTokens: readNumber(raw, 'cacheCreationInputTokens'),
    toolUses: readNumber(raw, 'toolUses'),
    apiCalls: readNumber(raw, 'apiCalls'),
    durationMs: readNumber(raw, 'durationMs'),
    contextTokens: readNumber(raw, 'contextTokens'),
    contextWindow: readNumber(raw, 'contextWindow'),
    totalCostUsd: readNumber(raw, 'totalCostUsd'),
    model: readString(raw, 'model'),
  };
  return Object.values(usage).some((value) => value !== undefined)
    ? usage
    : undefined;
}

function isPartKind(kind: string): kind is PortalChatPart['kind'] {
  return PART_KINDS.has(kind);
}

/** Narrow an untyped sub-block into a {@link PortalChatPart}, or `null`. */
function coercePart(value: unknown): PortalChatPart | null {
  if (!isRecord(value)) {
    return null;
  }
  const kind = value['kind'];
  if (typeof kind !== 'string' || !isPartKind(kind)) {
    return null;
  }
  const toolFamily = value['toolFamily'];
  const locator =
    kind === 'tool_result'
      ? rowFieldIdentity(value['outputLocator'])
      : undefined;
  const outputLocator: PortalChatPart['outputLocator'] =
    locator?.field === 'output'
      ? {
          messageId: locator.messageId,
          blockOrdinal: locator.blockOrdinal,
          field: 'output',
        }
      : undefined;
  return {
    kind,
    data: value['data'],
    ...(outputLocator ? { outputLocator } : {}),
    ...(typeof toolFamily === 'string' && isToolFamily(toolFamily)
      ? { toolFamily }
      : {}),
  };
}

// Record over the union → every tool family must be listed (a new family fails
// to compile here). The Set is derived from it.
const TOOL_FAMILY_FLAGS: Record<PortalChatToolFamily, true> = {
  read: true,
  edit: true,
  write: true,
  plan: true,
  bash: true,
  grep: true,
  glob: true,
  todo: true,
  web: true,
  agent: true,
  'ask-user': true,
  'script-output': true,
  skill: true,
  monitor: true,
  claude: true,
  watcher: true,
  canopy: true,
  graph: true,
  'app-advisor': true,
  'pipeline-editor': true,
  'computer-use': true,
  unknown: true,
};
const TOOL_FAMILIES: ReadonlySet<string> = new Set(
  Object.keys(TOOL_FAMILY_FLAGS),
);

function isToolFamily(value: string): value is PortalChatToolFamily {
  return TOOL_FAMILIES.has(value);
}

function ManagedAgentPart({
  delegation,
  children,
}: {
  readonly delegation: AgentDelegationCardData;
  readonly children?: ReactNode;
}): JSX.Element {
  const { onOpenSubagentChat } = useSubagentChatActions();
  const transcriptHost = useContext(TranscriptReadHostContext);
  const waitingDelegations = useContext(ChatWaitingDelegationsContext);
  const onOpenChat = useCallback((): void => {
    onOpenSubagentChat?.({
      kind: 'managed',
      id: delegation.delegationId,
      title: delegation.description || SUBAGENT_UNTITLED_LABEL,
    });
  }, [delegation.delegationId, delegation.description, onOpenSubagentChat]);

  return (
    <ManagedDelegationCard
      delegation={delegation}
      runGeneration={delegation.runGeneration ?? 1}
      waitingOnParent={waitingDelegations.has(delegation.delegationId)}
      {...(onOpenSubagentChat ? { onOpenChat } : {})}
      source={transcriptHost?.source}
      renderRows={transcriptHost?.renderRows}
      hint={
        transcriptHost
          ? {
              epoch: transcriptHost.epoch,
              streamRevision: delegation.streamRevision,
            }
          : undefined
      }
    >
      {children}
    </ManagedDelegationCard>
  );
}

type NativeAgentPartProps = Omit<
  ComponentProps<typeof AgentBlockCard>,
  'onOpenChat' | 'toolUseId' | 'headerAction'
> & {
  readonly toolUseId: string | undefined;
  /** The spawning call's id, anchoring the card for a transcript reveal. */
  readonly callId?: string;
  /** A live Claude agent's task the host may stop from the card header. */
  readonly stoppableTaskId?: string;
};

/**
 * A provider-native agent card. A Claude agent with a spawn tool-use id
 * offers Open chat when the host supplies the action.
 */
function NativeAgentPart({
  toolUseId,
  callId,
  stoppableTaskId,
  ...cardProps
}: NativeAgentPartProps): JSX.Element {
  const { onOpenSubagentChat } = useSubagentChatActions();
  const title = cardProps.description || SUBAGENT_UNTITLED_LABEL;
  const onOpenChat = useCallback((): void => {
    if (toolUseId === undefined) return;
    onOpenSubagentChat?.({ kind: 'claude-native', id: toolUseId, title });
  }, [onOpenSubagentChat, title, toolUseId]);

  return (
    <AgentBlockCard
      {...cardProps}
      toolUseId={callId}
      {...(stoppableTaskId === undefined
        ? {}
        : {
            headerAction: <AgentCardTaskStopAction taskId={stoppableTaskId} />,
          })}
      {...(onOpenSubagentChat && toolUseId !== undefined ? { onOpenChat } : {})}
    />
  );
}

function ChatPartViewImpl(props: ChatPartViewProps): JSX.Element {
  const content = <ChatPartContent {...props} />;
  // A real box, not `display: contents`: replay sizes a blocked element's
  // placeholder from its box, so the recorded layout keeps the part's size.
  // `empty:hidden` keeps a part that renders nothing out of the layout's gaps.
  return CHAT_PART_REPLAY_POLICY[props.part.kind] === 'blocked' ? (
    <div className={`${REPLAY_BLOCK_CLASS} empty:hidden`}>{content}</div>
  ) : (
    content
  );
}

function ChatPartContent({
  part,
  messageId,
  appIcon,
  live,
  settled = false,
  terminalStatus,
  turnTimerAlwaysVisible = false,
  turnTimerStampAccessory,
  turnTimerHostTurnGap = false,
  turnTimerTrailing,
  turnTimerLiveLine,
  turnTimerCopyText,
  turnTimerPlanCopy,
}: ChatPartViewProps): JSX.Element | null {
  const deliverableInteraction = useContext(DeliverableInteractionContext);
  const workingStatus = useContext(TurnWorkingStatusContext);
  const data = partData(part);
  const askUserInteraction = useAskUserQuestionInteraction();
  const composerQuestions = useContext(ComposerAskUserQuestionsContext);
  const composerAsks = useContext(ComposerAsksQuestionsContext);
  const outputReader = useContext(ToolOutputReaderContext);
  const turnSettled = useContext(ToolTurnSettledContext);
  const trustedMcpNamespace = useContext(ToolNamespaceContext);
  const toolScope =
    trustedMcpNamespace === undefined ? undefined : { trustedMcpNamespace };
  const modsSkippedHost = useClaudeModsSkippedHost();
  const clean = useCleanChatLook();
  // Smooth streaming (Labs) paces live text; without it, text parts render
  // as before (Mermaid diagrams draw as soon as they arrive).
  const smoothStreaming = useSmoothStreaming();

  switch (part.kind) {
    case 'mcp_activation':
      return null;
    case 'thinking':
      return (
        <CollapsibleBlock
          label="Thinking"
          doneLabel="Thought"
          // Clean chat look: only the message's last part can still be
          // thinking; the classic row never shows it running.
          running={clean && live === true && !settled}
          content={readPartText(data)}
        />
      );

    case 'tool_use': {
      const toolName =
        readString(data, 'toolName') ?? readString(data, 'name') ?? 'tool';
      const input = readToolInput(data);
      const family = getToolDisplayFamily(
        toolName,
        input,
        part.toolFamily,
        toolScope,
      );
      const { label } = getToolDisplayInfo(toolName, input, toolScope);
      const result = readToolResult(data);
      const rawResult = data['result'];
      const identity = isRecord(rawResult)
        ? rowFieldIdentity(rawResult.outputLocator)
        : undefined;
      const outputSlot =
        outputReader && identity && result ? (
          <ToolOutputSlot
            identity={identity}
            input={getToolRowInput(toolName, input, toolScope)}
            result={result}
          />
        ) : undefined;

      // Plan mode (CAN-3019). Canopy answers `ExitPlanMode` with `behavior:
      // 'deny'` on purpose so the plan routes into its own review UI, so the
      // transcript renders the plan and drops the result entirely — exactly
      // what desktop's `ChatBlockRenderer` does. Without this the turn reads as
      // a rejected tool call and the user is told they refused a plan they
      // wrote.
      //
      // The body may already end in a `[truncated N chars]` marker: the portal
      // wire caps tool input at 4,000 characters. Render what arrived; the
      // Plans card beside the transcript holds the full text.
      if (toolName === 'EnterPlanMode') return null;
      if (toolName === 'ExitPlanMode') {
        const plan = extractExitPlanModePlan(input);
        // Unlike desktop (which returns null), fall through to the tool card
        // when the input carries no plan: an unreadable plan block beats a
        // silently missing turn, and the card no longer implies a rejection now
        // that the tool resolves to the `plan` family.
        if (plan) {
          return (
            <div
              className={`${REPLAY_BLOCK_CLASS} ${PLAN_PROSE_CLASSES}`}
              data-testid="chat-part-plan"
            >
              <Markdown options={PLAN_MARKDOWN_OPTIONS} streaming={live}>
                {plan}
              </Markdown>
            </div>
          );
        }
      }

      // All ask-user rows share result precedence. Hosts with a projection
      // additionally render pending prompts and restored answers.
      if (family === 'ask-user' && isAskUserQuestionToolName(toolName)) {
        const toolUseId =
          readString(data, 'toolUseId') ?? readString(data, 'tool_use_id');
        // The Portal transcript may project the tool_use and tool_result as
        // separate messages, so a part without an embedded `result` can still
        // be answered; the shared resolver settles it from the projection.
        const presentation = resolveAskUserQuestionPresentation(
          askUserQuestionResultEvidence(result, input),
          portalAskUserQuestionRecordState(
            [...(askUserInteraction?.states ?? []), ...composerQuestions],
            {
              toolName,
              toolUseId,
              questionTexts: parseAskUserQuestionTexts(input),
            },
          ),
          live,
        );
        switch (presentation.kind) {
          case 'awaiting': {
            const pending = presentation.record;
            // The composer asks it, so the row stays hidden, as on desktop.
            if (
              !askUserInteraction ||
              composerAsks ||
              composerQuestions.includes(pending)
            ) {
              return null;
            }
            const status = askUserInteraction.getRequestStatus?.(
              pending.requestId,
            );
            const { onDraftChange } = askUserInteraction;
            return (
              <div data-tool-use-id={toolUseId}>
                <AskUserQuestionCard
                  state={pending}
                  draft={askUserInteraction.getDraft?.(pending.requestId)}
                  onDraftChange={
                    onDraftChange
                      ? (draft): void => onDraftChange(pending.requestId, draft)
                      : undefined
                  }
                  renderMarkdown={askUserInteraction.renderMarkdown}
                  disconnected={askUserInteraction.disconnected}
                  disabled={askUserInteraction.disabled}
                  busy={status?.busy ?? null}
                  errorKind={status?.errorKind ?? null}
                  onSubmit={(answers): void =>
                    askUserInteraction.onAnswer(pending.requestId, answers)
                  }
                  onDismiss={(): void =>
                    askUserInteraction.onDismiss(pending.requestId)
                  }
                />
              </div>
            );
          }
          case 'preparing':
            return (
              <Notice
                intent="neutral"
                icon={null}
                role="none"
                data-testid="ask-user-question-preparing"
              >
                Preparing question…
              </Notice>
            );
          case 'answered':
            return (
              <>
                <ToolCallCard
                  toolFamily={family}
                  toolName={toolName}
                  appIcon={appIcon}
                  label={askUserQuestionRowLabel({
                    count: askUserQuestionCount(input),
                    answers: presentation.answers,
                  })}
                  input={input}
                  result={result}
                  expandedSlot={outputSlot}
                  // Set when `result` is null; without it the card would infer
                  // `pending` and spin next to an already-answered question.
                  status={presentation.status}
                  pendingSpinner={<ThinkingSpinner />}
                  dataTestId="chat-tool-call"
                />
                <AnsweredQuestionsBlock answers={presentation.answers} />
              </>
            );
          case 'settled':
            return (
              <ToolCallCard
                toolFamily={family}
                toolName={toolName}
                appIcon={appIcon}
                label={label}
                input={input}
                result={result}
                expandedSlot={outputSlot}
                status={presentation.status}
                pendingSpinner={<ThinkingSpinner />}
                dataTestId="chat-tool-call"
              />
            );
          case 'result':
            // Errors and other results use the generic tool row below.
            break;
        }
      }

      return (
        <ToolCallCard
          toolFamily={family}
          toolName={toolName}
          appIcon={appIcon}
          label={label}
          input={getToolRowInput(toolName, input, toolScope)}
          result={result ?? (turnSettled ? interruptedToolCallResult() : null)}
          expandedSlot={outputSlot}
          pendingSpinner={<ThinkingSpinner />}
          dataTestId="chat-tool-call"
          toolUseId={
            readString(data, 'toolUseId') ?? readString(data, 'tool_use_id')
          }
        />
      );
    }

    case 'tool_result': {
      const identity = rowFieldIdentity(part.outputLocator);
      const visual = readChatToolResultVisual(part.data, messageId);
      if (identity && outputReader) {
        const result: ToolCallResult = {
          kind: data['isError'] === true ? 'error' : 'text',
          content: readPartText(data),
        };
        return (
          <>
            <ToolCallCard
              toolName={readString(data, 'toolName') ?? 'Tool'}
              label="Tool result"
              icon={<WrenchIcon />}
              result={result}
              expandedSlot={
                <ToolOutputSlot identity={identity} input="" result={result} />
              }
              dataTestId="chat-tool-call"
            />
            {visual && <ChatToolResultPart content="" visual={visual} />}
          </>
        );
      }
      return (
        <ChatToolResultPart content={readPartText(data)} visual={visual} />
      );
    }

    case 'text': {
      if (typeof data.providerErrorDetails === 'string') {
        return (
          <div data-chat-notice>
            <ErrorBanner
              error={readPartText(data)}
              details={data.providerErrorDetails}
              testId="chat-provider-error"
            />
          </div>
        );
      }
      if (isClaudeAiCreditsFallbackErrorCode(data.errorCode)) {
        return <ClaudeAiCreditsFallbackErrorNotice />;
      }
      // A Codex turn the ChatGPT account was refused for its model
      // (CAN-4716): the notice replaces the raw error text.
      const modelAccessFailure = readCodexAccountModelAccessFailure(
        data.modelAccessFailure,
      );
      if (modelAccessFailure) {
        return (
          <ModelAccessFailurePart
            failure={modelAccessFailure}
            messageId={messageId}
          />
        );
      }
      return (
        <div
          className={`${REPLAY_BLOCK_CLASS} prose prose-sm dark:prose-invert max-w-none`}
        >
          <Markdown
            options={TRANSCRIPT_MARKDOWN_OPTIONS}
            streaming={smoothStreaming && live === true}
          >
            {stripOpaqueAgentCitationMarkers(readPartText(data))}
          </Markdown>
        </div>
      );
    }
    case 'agent': {
      const rawSubBlocks = Array.isArray(data['subBlocks'])
        ? data['subBlocks']
        : [];
      const subParts = rawSubBlocks
        .map((sub) => coercePart(sub))
        .filter((sub): sub is PortalChatPart => sub !== null);
      const subBlocks =
        subParts.length > 0
          ? subParts
              .filter(
                (part) =>
                  !(
                    isAgentDelegationCardData(data.delegation) &&
                    part.kind === 'text' &&
                    typeof part.data === 'object' &&
                    part.data !== null &&
                    'text' in part.data &&
                    typeof part.data.text === 'string' &&
                    part.data.text.trim() === data.delegation.finalText?.trim()
                  ),
              )
              .map((sub, i) => (
                <ChatPartViewImpl
                  key={`${sub.kind}-${i}`}
                  part={sub}
                  appIcon={appIcon}
                  turnTimerAlwaysVisible={turnTimerAlwaysVisible}
                />
              ))
          : undefined;
      if (isAgentDelegationCardData(data.delegation)) {
        return (
          <ToolTurnSettledContext.Provider value={false}>
            <ManagedAgentPart delegation={data.delegation}>
              {subBlocks}
            </ManagedAgentPart>
          </ToolTurnSettledContext.Provider>
        );
      }
      const omittedSubBlocks = readNumber(data, 'omittedSubBlocks') ?? 0;
      const truncatedNotice =
        data['subBlocksTruncated'] === true ? (
          <div
            key="subblocks-truncated"
            className="text-3xs fg-secondary"
            data-testid="chat-agent-subblocks-truncated"
          >
            {omittedSubBlocks === 0
              ? "Earlier items aren't available here"
              : omittedSubBlocks === 1
                ? "1 earlier item isn't available here"
                : `${omittedSubBlocks} earlier items aren't available here`}
          </div>
        ) : null;
      const provider = data['provider'];
      const toolUseId = readString(data, 'toolUseId');
      const claude = provider === undefined || provider === 'claude';
      // Root completion does not settle the agent's independently owned turn.
      return (
        <ToolTurnSettledContext.Provider value={false}>
          <NativeAgentPart
            toolUseId={claude && toolUseId ? toolUseId : undefined}
            // Codex child agents have no Stop, as on desktop (D2).
            {...(claude &&
            data['isRunning'] === true &&
            agentPartTaskStoppable(data)
              ? { stoppableTaskId: data.taskId }
              : {})}
            subagentType={readString(data, 'subagentType') ?? 'agent'}
            description={readString(data, 'description')}
            runInBackground={data['runInBackground'] === true}
            prompt={readString(data, 'prompt')}
            result={readString(data, 'result')}
            usage={readAgentUsage(data)}
            subBlocks={
              truncatedNotice === null
                ? subBlocks
                : [truncatedNotice, ...(subBlocks ?? [])]
            }
            isRunning={data['isRunning'] === true}
            isError={data['isError'] === true}
            model={readString(data, 'model')}
            reasoningEffort={readString(data, 'reasoningEffort')}
            pendingSpinner={<ThinkingSpinner />}
            dataTestId="chat-agent-block"
            callId={toolUseId}
          />
        </ToolTurnSettledContext.Provider>
      );
    }

    case 'turn_timer': {
      const startedAt = readNumber(data, 'startedAt');
      const completedAt = readNumber(data, 'completedAt') ?? null;
      const pausedAt = readNumber(data, 'pausedAt') ?? null;
      const resumedAt = readNumber(data, 'resumedAt') ?? null;
      const accumulatedPausedDurationMs = readNumber(
        data,
        'accumulatedPausedDurationMs',
      );
      const autoRoutedModelLabel = readTurnTimerAutoRoutedModelLabel(data);
      const endReason = readString(data, 'endReason');
      const timerStatus = resolveTurnCompletionStatus({
        settled: completedAt != null,
        recorded:
          terminalStatus === 'failed' || terminalStatus === 'cancelled'
            ? terminalStatus
            : endReason === 'failed' || endReason === 'cancelled'
              ? endReason
              : terminalStatus === 'interrupted' || endReason === 'interrupted'
                ? 'interrupted'
                : undefined,
      });
      // The clean look names the model in the time's tooltip instead.
      const autoRoutedModelPill =
        autoRoutedModelLabel === undefined || clean ? undefined : (
          <AutoRoutedModelPill label={autoRoutedModelLabel} />
        );
      const timerTrailing =
        autoRoutedModelPill === undefined &&
        turnTimerTrailing == null ? undefined : (
          <>
            {autoRoutedModelPill}
            {turnTimerTrailing}
          </>
        );
      if (completedAt == null && live === false) {
        // A settled message with an uncompleted timer is an interrupted turn,
        // not "working" (web renderer parity): render nothing. This keeps the
        // ticking branch the exact complement of `hasLiveTurnTimer`, so the
        // transcript fallback spinner and this row can never show together.
        return null;
      }
      return completedAt == null ? (
        <TurnTimer
          startedAt={startedAt}
          pausedAt={pausedAt}
          resumedAt={resumedAt}
          accumulatedPausedDurationMs={accumulatedPausedDurationMs}
          spinner={<ThinkingSpinner tone="accent" />}
          isStreaming={true}
          hostTurnGap={turnTimerHostTurnGap}
          trailing={timerTrailing}
          liveLine={turnTimerLiveLine}
          {...(workingStatus === null ? {} : { workingLabel: workingStatus })}
        />
      ) : (
        <TurnTimer
          startedAt={startedAt}
          pausedAt={pausedAt}
          resumedAt={resumedAt}
          accumulatedPausedDurationMs={accumulatedPausedDurationMs}
          finishedAt={completedAt}
          stampAccessory={turnTimerStampAccessory}
          {...(turnTimerCopyText !== undefined
            ? { copyText: turnTimerCopyText }
            : {})}
          {...(turnTimerPlanCopy !== undefined
            ? { planCopy: turnTimerPlanCopy }
            : {})}
          {...(clean && autoRoutedModelLabel !== undefined
            ? { modelLabel: autoRoutedModelLabel }
            : {})}
          hostTurnGap={turnTimerHostTurnGap}
          completionStatus={timerStatus}
          isStreaming={false}
          alwaysVisible={
            turnTimerAlwaysVisible ||
            (timerStatus !== undefined && timerStatus !== 'complete')
          }
          trailing={timerTrailing}
        />
      );
    }

    // Presentation-only marker consumed by the user bubble's title row.
    case 'steering':
    case 'prompt_source':
      return null;

    case 'attachment': {
      const deliverable = readDeliverable(data);
      if (deliverable !== null && deliverableInteraction !== null) {
        return (
          <FileDeliverableCard
            filename={deliverable.filename}
            sizeBytes={deliverable.sizeBytes}
            onDownload={(): void =>
              deliverableInteraction.onDownload(deliverable)
            }
            onOpen={(): void => deliverableInteraction.onOpen(deliverable)}
          />
        );
      }
      const text = readPartText(data);
      return text ? (
        <CollapsibleBlock label={part.kind} content={text} icon={<DotIcon />} />
      ) : null;
    }
    case 'image': {
      const assetId = readString(data, 'assetId');
      if (assetId) {
        return (
          <ChatAssetImage
            reference={{
              assetId,
              mediaType: readString(data, 'mediaType'),
              filename: readString(data, 'filename'),
            }}
          />
        );
      }
      const text = readPartText(data);
      return text ? (
        <CollapsibleBlock label={part.kind} content={text} icon={<DotIcon />} />
      ) : null;
    }

    case 'compaction': {
      const occurredAt = readNumber(data, 'occurredAt');
      if (occurredAt === undefined) return null;
      return (
        <CompactionInfoBlock
          // Same rule as the desktop transcript: the projection carries the
          // provider and interface mode, so a Codex or Claude Code compaction
          // is named as such instead of every banner reading as Claude's. A
          // part with no provider is a cloud chat, which runs on the Claude
          // harness, so it keeps the Claude headline.
          headline={compactionHeadline(
            readString(data, 'provider') ?? 'claude',
            readString(data, 'interfaceMode'),
          )}
          timestamp={occurredAt}
          summary={readString(data, 'summary')}
        />
      );
    }

    case 'account_switch':
      return <DeferredAccountProxySwitchPart data={data} />;

    case 'mods_skipped':
      // The host supplies the chat and the details navigation, when it has
      // them; the notice leaves out the controls that need what is missing.
      return (
        <DeferredClaudeModsSkippedPart
          data={data}
          {...(modsSkippedHost?.context !== undefined
            ? { context: modsSkippedHost.context }
            : {})}
          {...(modsSkippedHost?.onOpenDetails !== undefined
            ? { onOpenDetails: modsSkippedHost.onOpenDetails }
            : {})}
        />
      );

    default: {
      // Exhaustiveness guard: a new part kind must be handled explicitly here
      // AND added to `CHAT_PART_REPLAY_POLICY` (which `coercePart` uses for
      // sub-blocks).
      part.kind satisfies never;
      return null;
    }
  }
}

/**
 * Memoized so a streaming frame that appends a new part does not re-render the
 * already-settled parts (CLAUDE.md message-list `React.memo` requirement).
 */
export const ChatPartView = memo(ChatPartViewImpl);
