import {
  parseAuthorityQualifiedId,
  qualifyId,
} from '@canopy/protocol/authority-qualified-id';
import { isHostedId } from '@canopy/protocol/remote-control/channels';
import { isWorkflowLaunchReceipt } from '@canopy/desktop-shared/lib/workflow-receipt';
import type {
  ApprovalAutoResolvedEvent,
  ApprovalFileChange,
  ApprovalRequestDetails,
  ApprovalRequestEvent,
  ApprovalRuleTarget,
  ArchivedChatSummary,
  ChatActiveSessionInfo,
  ChatActiveSessions,
  ChatCommandEnvelope,
  ChatCommandResult,
  ChatEvent,
  ChatQueueUpdatedEvent,
  ChatRuntimeState,
  ChatSendMessageRequest,
  ChatSendMessageResult,
  ChatStateChange,
  ChatStateChangedEvent,
  ChatStateSnapshot,
  ChatTabMetadataPatch,
  ChatTabsFile,
  ChatTranscriptPageRequest,
  HostQueuedMessageView,
  PersistedChatMessage,
  PersistedChatTab,
  PersistedHostQueuedMessage,
  ChatApi,
  PersistedPendingApproval,
  PersistedPendingQuestion,
} from '@canopy/desktop-shared/types';

type SecretInputApprovalPrompt = NonNullable<
  ApprovalRequestEvent['secretInput']
>;
type TranscriptDescriptor = NonNullable<PersistedChatTab['transcript']>;
type TranscriptPage = Awaited<ReturnType<ChatApi['getTranscriptPage']>>;
import { pairedComputerAddress } from '@/stores/remoteControlStore';

export interface PairedDeviceProject {
  readonly deviceId: string;
  readonly projectId: string;
}

export interface PairedDeviceScope extends PairedDeviceProject {
  readonly worktreeId: string;
}

export interface PairedDeviceTarget extends PairedDeviceScope {
  readonly chatId: string;
}

export type PairedSendCommandEnvelope = ChatCommandEnvelope<{
  type: 'chat.send_message';
  chatId: string;
  userMessageId: string;
  text: string;
}>;

export interface PairedExactCancelRequest {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
  readonly expectedUserMessageId: string;
}

const MAX_ONE_WINDOW_SEND_TEXT_LENGTH = 200_000;

/**
 * Typed refusal matching `isCapabilityUnavailable`: the paired-computer
 * one-window boundary does not serve this member yet.
 */
export function pairedComputerUnavailable(
  member: string,
): Error & { readonly code: 'capability_unavailable' } {
  return Object.assign(
    new Error(`${member} isn't available for paired computer chats yet.`),
    { code: 'capability_unavailable' as const },
  );
}

/**
 * Qualifies a plain local ID arriving from `deviceId`. Rejects any value that
 * is already authority-qualified so a paired computer can never inject IDs
 * targeting another computer or authority.
 */
export function qualifyPairedId(deviceId: string, localId: string): string {
  if (localId === '') return '';
  if (parseAuthorityQualifiedId(localId) !== null) {
    throw new Error('Paired computer returned an authority-qualified id.');
  }
  return qualifyId({ kind: 'paired-computer', deviceId }, localId);
}

function qualifyPairedTimerPauseOwnerId(
  deviceId: string,
  ownerId: string,
): string {
  if (ownerId.startsWith('question:')) {
    return `question:${qualifyPairedId(deviceId, ownerId.slice('question:'.length))}`;
  }
  if (ownerId.startsWith('approval:')) {
    return `approval:${qualifyPairedId(deviceId, ownerId.slice('approval:'.length))}`;
  }
  return qualifyPairedId(deviceId, ownerId);
}

export function parsePairedDeviceProject(
  projectId: string,
): PairedDeviceProject {
  const project = pairedComputerAddress(projectId);
  if (project === null) {
    throw new Error('Expected a paired-computer project id.');
  }
  return { deviceId: project.deviceId, projectId: project.localId };
}

export function parsePairedDeviceScope(scope: {
  readonly projectId: string;
  readonly worktreeId: string;
}): PairedDeviceScope {
  const project = pairedComputerAddress(scope.projectId);
  const worktree = pairedComputerAddress(scope.worktreeId);
  if (
    project === null ||
    worktree === null ||
    project.deviceId !== worktree.deviceId
  ) {
    throw new Error('Expected paired-computer scope ids for the same device.');
  }
  return {
    deviceId: project.deviceId,
    projectId: project.localId,
    worktreeId: worktree.localId,
  };
}

export function parsePairedDeviceTarget(target: {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
}): PairedDeviceTarget {
  const scope = parsePairedDeviceScope(target);
  const chat = pairedComputerAddress(target.chatId);
  if (chat === null || chat.deviceId !== scope.deviceId) {
    throw new Error('Expected a paired-computer chat id for the same device.');
  }
  return { ...scope, chatId: chat.localId };
}

const PAIRED_WORKFLOW_RECEIPT_PLACEHOLDER = 'Workflow ran on paired computer.';
const PAIRED_UNSUPPORTED_BLOCK_PLACEHOLDER =
  'Open this on the paired computer to see it.';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function copyOwnField<T extends object, K extends keyof T>(
  source: T,
  target: T,
  key: K,
): void {
  if (
    Object.prototype.hasOwnProperty.call(source, key) &&
    source[key] !== undefined
  ) {
    target[key] = source[key];
  }
}

function pickRecordFields(
  source: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (
      Object.prototype.hasOwnProperty.call(source, key) &&
      source[key] !== undefined
    ) {
      out[key] = source[key];
    }
  }
  return out;
}

function sanitizePairedWorkflowReceiptText(text: string): string {
  return isWorkflowLaunchReceipt(text)
    ? PAIRED_WORKFLOW_RECEIPT_PLACEHOLDER
    : text;
}

function flattenTextContentForReceiptCheck(items: readonly unknown[]): string {
  return items
    .map((entry) => {
      if (isPlainRecord(entry) && typeof entry.text === 'string') {
        return entry.text;
      }
      return JSON.stringify(entry);
    })
    .join('\n');
}

function sanitizePairedToolResultContent(
  deviceId: string,
  content: unknown,
): unknown {
  if (typeof content === 'string') {
    return sanitizePairedWorkflowReceiptText(content);
  }
  if (Array.isArray(content)) {
    if (isWorkflowLaunchReceipt(flattenTextContentForReceiptCheck(content))) {
      return PAIRED_WORKFLOW_RECEIPT_PLACEHOLDER;
    }
    return content.map((entry: unknown) => {
      if (typeof entry === 'string') {
        return sanitizePairedWorkflowReceiptText(entry);
      }
      if (isPlainRecord(entry)) {
        if (
          (entry.type === undefined || entry.type === 'text') &&
          typeof entry.text === 'string'
        ) {
          return {
            ...(entry.type === 'text' ? { type: 'text' } : {}),
            text: sanitizePairedWorkflowReceiptText(entry.text),
          };
        }
        return sanitizePairedRecordBlock(deviceId, entry);
      }
      return makeUnsupportedPairedBlock();
    });
  }
  if (isPlainRecord(content)) {
    if (isWorkflowLaunchReceipt(JSON.stringify(content))) {
      return PAIRED_WORKFLOW_RECEIPT_PLACEHOLDER;
    }
    if (typeof content.type === 'string') {
      return sanitizePairedRecordBlock(deviceId, content);
    }
    if (typeof content.text === 'string') {
      return { text: sanitizePairedWorkflowReceiptText(content.text) };
    }
    return {};
  }
  return '';
}

type PersistedMessageBlock = PersistedChatMessage['blocks'][number];

function makeUnsupportedPairedBlock(): PersistedMessageBlock {
  return {
    type: 'text',
    text: PAIRED_UNSUPPORTED_BLOCK_PLACEHOLDER,
    verbatim: true,
  };
}

function sanitizePairedApprovalMode(
  mode: unknown,
): 'ask' | 'auto' | 'full-access' | undefined {
  return mode === 'ask' || mode === 'auto' || mode === 'full-access'
    ? mode
    : undefined;
}

/**
 * Rebuilds every incoming persisted message block from a per-type allowlist.
 * Drops `path` on image blocks, external output/text/input refs, visual/artifact
 * refs, unsupported block kinds, and any unknown peer-supplied keys.
 */
function sanitizePairedBlock(
  deviceId: string,
  block: PersistedMessageBlock,
): PersistedMessageBlock {
  switch (block.type) {
    case 'image':
      return {
        type: 'image',
        path: '',
        alt: block.alt,
        ...(block.dataUrl !== undefined ? { dataUrl: block.dataUrl } : {}),
      };
    case 'text': {
      const sanitized: Extract<PersistedMessageBlock, { type: 'text' }> = {
        type: 'text',
        text: block.text,
      };
      if (block.verbatim !== undefined) sanitized.verbatim = block.verbatim;
      if (block.steering !== undefined) {
        sanitized.steering = {
          startsTurn: block.steering.startsTurn,
          ...(block.steering.rootUserMessageId !== undefined
            ? { rootUserMessageId: block.steering.rootUserMessageId }
            : {}),
        };
      }
      if (block.asyncQuestion !== undefined) {
        sanitized.asyncQuestion = {
          requestId: qualifyPairedId(deviceId, block.asyncQuestion.requestId),
          questions: block.asyncQuestion.questions.map((item) => ({
            title: item.title,
            options: Array.isArray(item.options) ? [...item.options] : null,
          })),
        };
      }
      if (block.asyncQuestionAnswer !== undefined) {
        sanitized.asyncQuestionAnswer = {
          requestId: qualifyPairedId(
            deviceId,
            block.asyncQuestionAnswer.requestId,
          ),
          startsTurn: block.asyncQuestionAnswer.startsTurn,
          answers: block.asyncQuestionAnswer.answers.map((answer) => ({
            question: answer.question,
            selectedOptions: [...answer.selectedOptions],
            ...(answer.freeformText !== undefined
              ? { freeformText: answer.freeformText }
              : {}),
          })),
        };
      }
      if (block.providerErrorDetails !== undefined) {
        sanitized.providerErrorDetails = block.providerErrorDetails;
      }
      return sanitized;
    }
    case 'thinking':
      return {
        type: 'thinking',
        text: block.text,
      };
    case 'tool_use':
      return {
        type: 'tool_use',
        toolUseId: block.toolUseId,
        toolName: block.toolName,
        input: block.input,
        ...(block.display !== undefined
          ? {
              display: {
                toolName: block.display.toolName,
                input: block.display.input,
              },
            }
          : {}),
      };
    case 'tool_result': {
      const sanitized: Extract<PersistedMessageBlock, { type: 'tool_result' }> =
        {
          type: 'tool_result',
          toolUseId: block.toolUseId,
          toolName: block.toolName,
          output: sanitizePairedWorkflowReceiptText(block.output),
          isError: block.isError,
        };
      if (block.interruption !== undefined) {
        sanitized.interruption = block.interruption;
      }
      if (block.outputTruncated === true) {
        sanitized.outputTruncated = true;
      }
      return sanitized;
    }
    case 'turn_timer': {
      const sanitized: Extract<PersistedMessageBlock, { type: 'turn_timer' }> =
        {
          type: 'turn_timer',
          completedAt: block.completedAt,
        };
      if (block.turnId !== undefined) sanitized.turnId = block.turnId;
      if (block.userMessageId !== undefined) {
        sanitized.userMessageId = block.userMessageId;
      }
      if (block.spawnedBy !== undefined) {
        const spawnedBy: NonNullable<typeof sanitized.spawnedBy> = {};
        if (block.spawnedBy.taskId !== undefined) {
          spawnedBy.taskId = block.spawnedBy.taskId;
        }
        if (block.spawnedBy.toolUseId !== undefined) {
          spawnedBy.toolUseId = block.spawnedBy.toolUseId;
        }
        if (block.spawnedBy.event === true) spawnedBy.event = true;
        if (block.spawnedBy.scheduled === true) spawnedBy.scheduled = true;
        if (block.spawnedBy.toolsLoaded === true) spawnedBy.toolsLoaded = true;
        sanitized.spawnedBy = spawnedBy;
      }
      if (block.startedAt !== undefined) sanitized.startedAt = block.startedAt;
      if (block.pausedAt !== undefined) sanitized.pausedAt = block.pausedAt;
      if (block.resumedAt !== undefined) sanitized.resumedAt = block.resumedAt;
      if (Array.isArray(block.pauseOwnerIds)) {
        sanitized.pauseOwnerIds = block.pauseOwnerIds.map((id) =>
          qualifyPairedTimerPauseOwnerId(deviceId, id),
        );
      }
      if (block.accumulatedPausedDurationMs !== undefined) {
        sanitized.accumulatedPausedDurationMs =
          block.accumulatedPausedDurationMs;
      }
      if (block.outcome !== undefined) sanitized.outcome = block.outcome;
      return sanitized;
    }
    case 'approval_resolution_info': {
      const mode = sanitizePairedApprovalMode(block.mode);
      if (mode === undefined || block.resolvedBy !== 'mode-change') {
        return makeUnsupportedPairedBlock();
      }
      const previousMode = sanitizePairedApprovalMode(block.previousMode);
      return {
        type: 'approval_resolution_info',
        timestamp: block.timestamp,
        resolvedBy: 'mode-change',
        mode,
        ...(previousMode !== undefined ? { previousMode } : {}),
        titles: Array.isArray(block.titles)
          ? block.titles.filter(
              (title): title is string => typeof title === 'string',
            )
          : [],
      };
    }
    default:
      return makeUnsupportedPairedBlock();
  }
}

const PAIRED_MESSAGE_OPTIONAL_KEYS = [
  'hidden',
  'cancelled',
  'userMessageSource',
  'autoResume',
  'agentSent',
  'parentToolUseId',
  'parentBlockId',
  'delegationSequence',
  'delegationAuthor',
  'delegationDelivery',
  'delegationSegment',
  'codexThreadId',
  'codexTurnId',
  'inputMode',
  'watcherFired',
  'claudeUuid',
] as const satisfies readonly (keyof PersistedChatMessage)[];

/**
 * Rebuilds a peer-supplied chat message from an explicit allowlist.
 * Drops `attachmentPaths`, `attachmentPromptContexts`, `blocksRef`, and any
 * unknown peer-supplied fields so local preview handlers never read a path
 * supplied by another computer.
 */
export function sanitizePairedMessage(
  deviceId: string,
  message: PersistedChatMessage,
): PersistedChatMessage {
  const sanitized: PersistedChatMessage = {
    id: message.id,
    role: message.role,
    blocks: message.blocks.map((block) => sanitizePairedBlock(deviceId, block)),
    timestamp: message.timestamp,
  };
  for (const key of PAIRED_MESSAGE_OPTIONAL_KEYS) {
    copyOwnField(message, sanitized, key);
  }
  return sanitized;
}

const PAIRED_QUEUED_MESSAGE_OPTIONAL_KEYS = [
  'supersedesUserMessageId',
  'promptSource',
  'autoResume',
  'inputMode',
  'revision',
  'turnPhase',
  'editLocked',
  'forceLocked',
  'canSteer',
  'steerBlockedByCapabilityChange',
  'waitingReason',
  'retryBlockedReason',
  'retryable',
  'blockedByBackgroundWork',
  'restartHeldChanges',
  'watcherFired',
  'agentSent',
] as const satisfies readonly (keyof HostQueuedMessageView)[];

function sanitizePairedQueuedMessage(
  entry: HostQueuedMessageView,
): HostQueuedMessageView {
  const sanitized: HostQueuedMessageView = {
    id: entry.id,
    text: entry.text,
    origin: entry.origin,
    enqueuedAtMs: entry.enqueuedAtMs,
  };
  for (const key of PAIRED_QUEUED_MESSAGE_OPTIONAL_KEYS) {
    copyOwnField(entry, sanitized, key);
  }
  return sanitized;
}

const PAIRED_QUEUED_REQUEST_OPTIONAL_KEYS = [
  'resumesInterruptedTurn',
  'autoResume',
  'modelSelectionMode',
  'title',
  'planMode',
  'approvalMode',
  'thinkingLevel',
  'model',
  'inputMode',
  'watcherFired',
  'agentSent',
] as const satisfies readonly (keyof ChatSendMessageRequest)[];

function sanitizePairedQueuedRequest(
  deviceId: string | undefined,
  request: ChatSendMessageRequest,
): ChatSendMessageRequest {
  const sanitized: ChatSendMessageRequest = {
    projectId:
      deviceId !== undefined
        ? qualifyPairedId(deviceId, request.projectId)
        : request.projectId,
    worktreeId:
      deviceId !== undefined
        ? qualifyPairedId(deviceId, request.worktreeId)
        : request.worktreeId,
    chatId:
      deviceId !== undefined
        ? qualifyPairedId(deviceId, request.chatId)
        : request.chatId,
    userMessageId: request.userMessageId,
    text: request.text,
  };
  for (const key of PAIRED_QUEUED_REQUEST_OPTIONAL_KEYS) {
    copyOwnField(request, sanitized, key);
  }
  return sanitized;
}

function sanitizePairedHostQueuedMessage(
  deviceId: string | undefined,
  entry: PersistedHostQueuedMessage,
): PersistedHostQueuedMessage {
  const sanitized: PersistedHostQueuedMessage = {
    id: entry.id,
    request: sanitizePairedQueuedRequest(deviceId, entry.request),
    origin: entry.origin,
    enqueuedAtMs: entry.enqueuedAtMs,
  };
  if (entry.dispatching === true) sanitized.dispatching = true;
  if (entry.admitting === true) sanitized.admitting = true;
  if (entry.revision !== undefined) sanitized.revision = entry.revision;
  return sanitized;
}

export function sanitizePairedRuntimeState(
  runtime: ChatRuntimeState,
  deviceId?: string,
): ChatRuntimeState {
  const sanitized: ChatRuntimeState = {
    status: runtime.status,
    queuedMessageIds: Array.isArray(runtime.queuedMessageIds)
      ? [...runtime.queuedMessageIds]
      : [],
  };
  if (runtime.steeringCapabilities !== undefined) {
    sanitized.steeringCapabilities = runtime.steeringCapabilities;
  }
  if (runtime.turn !== undefined) {
    sanitized.turn = runtime.turn;
  }
  if (runtime.activeTurn !== undefined) {
    sanitized.activeTurn = {
      userMessageId: runtime.activeTurn.userMessageId,
      startedAt: runtime.activeTurn.startedAt,
      ...(runtime.activeTurn.sessionId !== undefined
        ? { sessionId: runtime.activeTurn.sessionId }
        : {}),
    };
  }
  if (Array.isArray(runtime.queuedMessages)) {
    sanitized.queuedMessages = runtime.queuedMessages.map((entry) =>
      sanitizePairedHostQueuedMessage(deviceId, entry),
    );
  }
  if (runtime.error !== undefined) {
    sanitized.error = {
      code: runtime.error.code,
      message: runtime.error.message,
      retryable: runtime.error.retryable,
      occurredAt: runtime.error.occurredAt,
    };
  }

  if (runtime.lastActivityAt !== undefined) {
    sanitized.lastActivityAt = runtime.lastActivityAt;
  }
  return sanitized;
}

const PAIRED_TRANSCRIPT_PAGE_OPTIONAL_KEYS = [
  'runTruncated',
  'view',
  'turnId',
  'messageOrdinals',
  'turns',
  'before',
  'cursor',
  'turnEnds',
] as const satisfies readonly (keyof Omit<
  TranscriptPage,
  'messages' | 'latestHumanMessage'
>)[];

function sanitizePairedTranscriptWindow(
  deviceId: string,
  transcriptWindow: PersistedChatTab['transcriptWindow'],
): PersistedChatTab['transcriptWindow'] {
  if (transcriptWindow === undefined) {
    return undefined;
  }
  const sanitized: NonNullable<PersistedChatTab['transcriptWindow']> = {
    totalMessages: transcriptWindow.totalMessages,
    transcriptRevision: transcriptWindow.transcriptRevision,
  };
  for (const key of PAIRED_TRANSCRIPT_PAGE_OPTIONAL_KEYS) {
    copyOwnField(transcriptWindow, sanitized, key);
  }
  if (transcriptWindow.latestHumanMessage !== undefined) {
    sanitized.latestHumanMessage = sanitizePairedMessage(
      deviceId,
      transcriptWindow.latestHumanMessage,
    );
  }
  return sanitized;
}

export function sanitizePairedTranscriptPage(
  deviceId: string,
  page: TranscriptPage,
): TranscriptPage {
  const sanitized: TranscriptPage = {
    messages: page.messages.map((message) =>
      sanitizePairedMessage(deviceId, message),
    ),
    totalMessages: page.totalMessages,
    transcriptRevision: page.transcriptRevision,
  };
  for (const key of PAIRED_TRANSCRIPT_PAGE_OPTIONAL_KEYS) {
    copyOwnField(page, sanitized, key);
  }
  if (page.latestHumanMessage !== undefined) {
    sanitized.latestHumanMessage = sanitizePairedMessage(
      deviceId,
      page.latestHumanMessage,
    );
  }
  return sanitized;
}

const PAIRED_TRANSCRIPT_DESCRIPTOR_OPTIONAL_KEYS = [
  'hasOrdinaryActiveRows',
  'committedDigest',
  'messageCount',
  'userMessageCount',
  'firstMessageAt',
  'lastMessageAt',
  'lastMessageId',
  'lastMessageRole',
  'lastAssistantPreview',
] as const satisfies readonly (keyof TranscriptDescriptor)[];

function sanitizePairedTranscriptDescriptor(
  transcript: TranscriptDescriptor,
): TranscriptDescriptor {
  const sanitized: TranscriptDescriptor = {
    format: transcript.format,
    committedMessageCount: transcript.committedMessageCount,
    committedByteLength: transcript.committedByteLength,
    transcriptRevision: transcript.transcriptRevision,
    hasActiveSidecar: transcript.hasActiveSidecar,
  };
  for (const key of PAIRED_TRANSCRIPT_DESCRIPTOR_OPTIONAL_KEYS) {
    copyOwnField(transcript, sanitized, key);
  }
  return sanitized;
}

function sanitizePairedQuestionItem(
  item: PersistedPendingQuestion['questions'][number],
): PersistedPendingQuestion['questions'][number] {
  const out: PersistedPendingQuestion['questions'][number] = {
    question: item.question,
    options: Array.isArray(item.options) ? [...item.options] : [],
  };
  if (item.id !== undefined) out.id = item.id;
  if (item.header !== undefined) out.header = item.header;
  if (item.multiSelect !== undefined) out.multiSelect = item.multiSelect;
  if (Array.isArray(item.optionDescriptions)) {
    out.optionDescriptions = [...item.optionDescriptions];
  }
  if (item.allowOther !== undefined) out.allowOther = item.allowOther;
  if (item.secret !== undefined) out.secret = item.secret;
  if (item.keepTextOnPick !== undefined)
    out.keepTextOnPick = item.keepTextOnPick;
  if (item.control !== undefined) out.control = item.control;
  if (item.required !== undefined) out.required = item.required;
  if (item.placeholder !== undefined) out.placeholder = item.placeholder;
  if (item.secretRequest !== undefined) {
    out.secretRequest = {
      reason: item.secretRequest.reason,
      agentName: item.secretRequest.agentName,
      accessMode: item.secretRequest.accessMode,
      storage: item.secretRequest.storage,
      secrets: item.secretRequest.secrets.map((secret) => ({
        name: secret.name,
        ...(secret.label !== undefined ? { label: secret.label } : {}),
        ...(secret.description !== undefined
          ? { description: secret.description }
          : {}),
        ...(secret.kind !== undefined ? { kind: secret.kind } : {}),
        ...(secret.required !== undefined ? { required: secret.required } : {}),
        ...(secret.hint !== undefined ? { hint: secret.hint } : {}),
        ...(secret.held !== undefined ? { held: secret.held } : {}),
      })),
    };
  }
  return out;
}

function qualifyPendingQuestion(
  deviceId: string,
  question: PersistedPendingQuestion,
): PersistedPendingQuestion {
  const qualified: PersistedPendingQuestion = {
    requestId: qualifyPairedId(deviceId, question.requestId),
    chatId: qualifyPairedId(deviceId, question.chatId),
    questions: question.questions.map(sanitizePairedQuestionItem),
  };
  if (question.delivery !== undefined) qualified.delivery = question.delivery;
  if (question.dismissedAt !== undefined) {
    qualified.dismissedAt = question.dismissedAt;
  }
  if (question.answeredAt !== undefined) {
    qualified.answeredAt = question.answeredAt;
  }
  if (question.toolUseId !== undefined)
    qualified.toolUseId = question.toolUseId;
  if (Array.isArray(question.answers)) {
    qualified.answers = question.answers.map((answer) => ({
      question: answer.question,
      selectedOptions: [...answer.selectedOptions],
      ...(answer.freeformText !== undefined
        ? { freeformText: answer.freeformText }
        : {}),
    }));
  }
  return qualified;
}

function sanitizePairedApprovalFileChange(
  change: ApprovalFileChange,
): ApprovalFileChange {
  if (change.kind === 'edit') {
    return {
      kind: 'edit',
      oldText: change.oldText,
      newText: change.newText,
      ...(change.replaceAll !== undefined
        ? { replaceAll: change.replaceAll }
        : {}),
      ...(change.truncated !== undefined
        ? { truncated: change.truncated }
        : {}),
    };
  }
  return {
    kind: 'write',
    content: change.content,
    ...(change.truncated !== undefined ? { truncated: change.truncated } : {}),
  };
}

function sanitizePairedApprovalDetails(
  details: ApprovalRequestDetails,
): ApprovalRequestDetails {
  switch (details.kind) {
    case 'command':
      return {
        kind: 'command',
        command: details.command,
        ...(details.cwd !== undefined ? { cwd: details.cwd } : {}),
        ...(details.reason !== undefined ? { reason: details.reason } : {}),
      };
    case 'file-write':
      return {
        kind: 'file-write',
        ...(details.path !== undefined ? { path: details.path } : {}),
        ...(details.displayPath !== undefined
          ? { displayPath: details.displayPath }
          : {}),
        ...(details.change !== undefined
          ? { change: sanitizePairedApprovalFileChange(details.change) }
          : {}),
        ...(details.reason !== undefined ? { reason: details.reason } : {}),
        ...(details.itemId !== undefined ? { itemId: details.itemId } : {}),
      };
    case 'mcp':
      return {
        kind: 'mcp',
        server: details.server,
        tool: details.tool,
        ...(details.paramsDisplay !== undefined
          ? { paramsDisplay: details.paramsDisplay }
          : {}),
        ...(details.reason !== undefined ? { reason: details.reason } : {}),
        ...(details.connector !== undefined
          ? { connector: details.connector }
          : {}),
        ...(details.account !== undefined ? { account: details.account } : {}),
      };
    case 'network':
      return {
        kind: 'network',
        host: details.host,
        ...(details.reason !== undefined ? { reason: details.reason } : {}),
      };
    case 'tool':
      return {
        kind: 'tool',
        toolName: details.toolName,
        ...(details.path !== undefined ? { path: details.path } : {}),
        ...(details.displayPath !== undefined
          ? { displayPath: details.displayPath }
          : {}),
        ...(details.inputSummary !== undefined
          ? { inputSummary: details.inputSummary }
          : {}),
        ...(details.reason !== undefined ? { reason: details.reason } : {}),
      };
    case 'browser-upload':
      return {
        kind: 'browser-upload',
        origin: details.origin,
        ...(details.topOrigin !== undefined
          ? { topOrigin: details.topOrigin }
          : {}),
        files: Array.isArray(details.files)
          ? details.files.map((file) => ({
              displayPath: file.displayPath,
              sizeBytes: file.sizeBytes,
            }))
          : [],
        ...(details.reason !== undefined ? { reason: details.reason } : {}),
      };
    case 'browser-file-request':
      return {
        kind: 'browser-file-request',
        origin: details.origin,
        ...(details.topOrigin !== undefined
          ? { topOrigin: details.topOrigin }
          : {}),
        ...(details.purpose !== undefined ? { purpose: details.purpose } : {}),
        multiple: details.multiple,
      };
    case 'agent-secret-use':
      return {
        kind: 'agent-secret-use',
        tool: details.tool,
        ...(details.command !== undefined ? { command: details.command } : {}),
        ...(details.cwd !== undefined ? { cwd: details.cwd } : {}),
        ...(details.path !== undefined ? { path: details.path } : {}),
        secretNames: Array.isArray(details.secretNames)
          ? [...details.secretNames]
          : [],
      };
  }
}

function sanitizePairedApprovalRuleTarget(
  target: ApprovalRuleTarget,
): ApprovalRuleTarget {
  switch (target.kind) {
    case 'command':
      return { kind: 'command', pattern: target.pattern };
    case 'file-write':
      return { kind: 'file-write', path: target.path };
    case 'mcp':
      return {
        kind: 'mcp',
        server: target.server,
        ...(target.tool !== undefined ? { tool: target.tool } : {}),
      };
    case 'network':
      return { kind: 'network', host: target.host };
    case 'tool':
      return { kind: 'tool', toolName: target.toolName };
    case 'browser-upload':
      return {
        kind: 'browser-upload',
        origin: target.origin,
        ...(target.path !== undefined ? { path: target.path } : {}),
      };
  }
}

function sanitizePairedSecretInputPrompt(
  prompt: SecretInputApprovalPrompt,
): SecretInputApprovalPrompt {
  return {
    kind: prompt.kind,
    bindingId: prompt.bindingId,
    label: prompt.label,
  };
}

function qualifyPendingApproval(
  deviceId: string,
  approval: PersistedPendingApproval,
): PersistedPendingApproval {
  return {
    requestId: qualifyPairedId(deviceId, approval.requestId),
    chatId: qualifyPairedId(deviceId, approval.chatId),
    event: qualifyApprovalRequestEvent(deviceId, approval.event),
  };
}

function copyOwnTabField<K extends keyof PersistedChatTab>(
  source: PersistedChatTab,
  target: PersistedChatTab,
  key: K,
): void {
  if (Object.prototype.hasOwnProperty.call(source, key)) {
    target[key] = source[key];
  }
}

function copyOwnPatchField<K extends keyof ChatTabMetadataPatch>(
  source: ChatTabMetadataPatch,
  target: ChatTabMetadataPatch,
  key: K,
): void {
  if (Object.prototype.hasOwnProperty.call(source, key)) {
    target[key] = source[key];
  }
}

/**
 * Rebuilds a peer-supplied tab.metadata_patched payload from an explicit
 * allowlist of mutable tab fields so identity keys like `id` and host-only
 * fields can never overwrite local tab state.
 */
function sanitizePairedTabMetadataPatch(
  deviceId: string,
  patch: ChatTabMetadataPatch,
): ChatTabMetadataPatch {
  const sanitized: ChatTabMetadataPatch = {};
  copyOwnPatchField(patch, sanitized, 'title');
  copyOwnPatchField(patch, sanitized, 'customTitle');
  copyOwnPatchField(patch, sanitized, 'automaticTitleState');
  copyOwnPatchField(patch, sanitized, 'description');
  copyOwnPatchField(patch, sanitized, 'pinned');
  copyOwnPatchField(patch, sanitized, 'unread');
  copyOwnPatchField(patch, sanitized, 'unreadMarkedManually');
  copyOwnPatchField(patch, sanitized, 'planMode');
  copyOwnPatchField(patch, sanitized, 'approvalMode');
  copyOwnPatchField(patch, sanitized, 'thinkingLevel');
  copyOwnPatchField(patch, sanitized, 'modelConfig');
  copyOwnPatchField(patch, sanitized, 'codexFastModeEnabled');
  copyOwnPatchField(patch, sanitized, 'model');
  copyOwnPatchField(patch, sanitized, 'modelSelectionMode');
  copyOwnPatchField(patch, sanitized, 'providerType');
  copyOwnPatchField(patch, sanitized, 'executionHarness');
  copyOwnPatchField(patch, sanitized, 'capturedHarness');
  copyOwnPatchField(patch, sanitized, 'autoRoutedModels');
  copyOwnPatchField(patch, sanitized, 'usage');
  if (patch.transcript !== undefined && patch.transcript !== null) {
    sanitized.transcript = sanitizePairedTranscriptDescriptor(patch.transcript);
  } else {
    copyOwnPatchField(patch, sanitized, 'transcript');
  }
  copyOwnPatchField(patch, sanitized, 'transcriptLoaded');
  copyOwnPatchField(patch, sanitized, 'transcriptWindow');
  if (
    sanitized.transcriptWindow !== undefined &&
    sanitized.transcriptWindow !== null
  ) {
    sanitized.transcriptWindow = sanitizePairedTranscriptWindow(
      deviceId,
      sanitized.transcriptWindow,
    );
  }
  copyOwnPatchField(patch, sanitized, 'turnEnds');
  copyOwnPatchField(patch, sanitized, 'unacceptedTurnEnds');
  copyOwnPatchField(patch, sanitized, 'interruptedTurns');
  copyOwnPatchField(patch, sanitized, 'lastAcceptedUserMessageId');
  copyOwnPatchField(patch, sanitized, 'latestRevisionNumber');
  return sanitized;
}

/**
 * Rebuilds a peer-supplied tab from an explicit allowlist of keys rendered by
 * the paired view. Host-only metadata (turnDiffs, filePath, plan recovery,
 * workflow carry, drafts) and any unknown peer fields are dropped by default.
 */
const PAIRED_TAB_PASSTHROUGH_KEYS = [
  'customTitle',
  'automaticTitleState',
  'description',
  'pinned',
  'unread',
  'unreadMarkedManually',
  'readOnly',
  'planMode',
  'approvalMode',
  'thinkingLevel',
  'modelConfig',
  'codexFastModeEnabled',
  'model',
  'modelSelectionMode',
  'providerType',
  'executionHarness',
  'capturedHarness',
  'autoRoutedModels',
  'usage',
  'agentUsage',
  'transcriptLoaded',
  'turnEnds',
  'unacceptedTurnEnds',
  'interruptedTurns',
  'lastAcceptedUserMessageId',
  'latestRevisionNumber',
] as const satisfies readonly (keyof PersistedChatTab)[];

export function qualifyPersistedTab(
  deviceId: string,
  tab: PersistedChatTab,
): PersistedChatTab {
  const transcriptWindow = sanitizePairedTranscriptWindow(
    deviceId,
    tab.transcriptWindow,
  );
  const qualified: PersistedChatTab = {
    id: qualifyPairedId(deviceId, tab.id),
    title: tab.title,
    messages: tab.messages.map((message) =>
      sanitizePairedMessage(deviceId, message),
    ),
    createdAt: tab.createdAt,
  };
  if (tab.kind === 'chat') {
    qualified.kind = 'chat';
  }
  if (tab.transcript !== undefined) {
    qualified.transcript = sanitizePairedTranscriptDescriptor(tab.transcript);
  }
  if (transcriptWindow !== undefined) {
    qualified.transcriptWindow = transcriptWindow;
  }
  for (const key of PAIRED_TAB_PASSTHROUGH_KEYS) {
    copyOwnTabField(tab, qualified, key);
  }
  return qualified;
}

function isPairedChatTab(tab: PersistedChatTab): boolean {
  return tab.kind === undefined || tab.kind === 'chat';
}

export function qualifyTabsFile(
  deviceId: string,
  tabsFile: ChatTabsFile,
): ChatTabsFile {
  const tabs = tabsFile.tabs
    .filter(isPairedChatTab)
    .map((tab) => qualifyPersistedTab(deviceId, tab));
  const keptTabIds = new Set(tabs.map((tab) => tab.id));
  const qualifiedActive = qualifyPairedId(deviceId, tabsFile.activeTabId);
  const activeTabId = keptTabIds.has(qualifiedActive)
    ? qualifiedActive
    : (tabs[0]?.id ?? '');
  const qualifiedEditable =
    tabsFile.lastActiveEditableChatId !== undefined
      ? qualifyPairedId(deviceId, tabsFile.lastActiveEditableChatId)
      : undefined;
  const lastActiveEditableChatId =
    qualifiedEditable !== undefined
      ? keptTabIds.has(qualifiedEditable)
        ? qualifiedEditable
        : tabs[0]?.id
      : undefined;
  const qualified: ChatTabsFile = {
    version: tabsFile.version,
    tabs,
    activeTabId,
  };
  if (tabsFile.revision !== undefined) qualified.revision = tabsFile.revision;
  if (lastActiveEditableChatId !== undefined) {
    qualified.lastActiveEditableChatId = lastActiveEditableChatId;
  }
  if (tabsFile.lastActiveChatProvider !== undefined) {
    qualified.lastActiveChatProvider = tabsFile.lastActiveChatProvider;
  }
  if (tabsFile.pendingQuestions !== undefined) {
    qualified.pendingQuestions = tabsFile.pendingQuestions.map((question) =>
      qualifyPendingQuestion(deviceId, question),
    );
  }
  if (tabsFile.pendingApprovals !== undefined) {
    qualified.pendingApprovals = tabsFile.pendingApprovals.map((approval) =>
      qualifyPendingApproval(deviceId, approval),
    );
  }
  return qualified;
}

export function qualifyQueueUpdatedEvent(
  deviceId: string,
  event: ChatQueueUpdatedEvent,
): ChatQueueUpdatedEvent {
  const qualified: ChatQueueUpdatedEvent = {
    projectId: qualifyPairedId(deviceId, event.projectId),
    worktreeId: qualifyPairedId(deviceId, event.worktreeId),
    chatId: qualifyPairedId(deviceId, event.chatId),
    queue: event.queue.map(sanitizePairedQueuedMessage),
  };
  if (Array.isArray(event.waitingDelegationIds)) {
    qualified.waitingDelegationIds = event.waitingDelegationIds
      .filter((id): id is string => typeof id === 'string')
      .map((id) => qualifyPairedId(deviceId, id));
  }
  if (event.restartHeldByBackgroundWork === true) {
    qualified.restartHeldByBackgroundWork = true;
  }
  return qualified;
}

const PAIRED_ARCHIVE_SUMMARY_OPTIONAL_KEYS = [
  'customTitle',
  'description',
  'providerType',
  'model',
  'archived',
] as const satisfies readonly (keyof ArchivedChatSummary)[];

function qualifyArchivedChatSummary(
  deviceId: string,
  archive: ArchivedChatSummary,
): ArchivedChatSummary {
  const qualified: ArchivedChatSummary = {
    chatId: qualifyPairedId(deviceId, archive.chatId),
    title: archive.title,
    turnCount: archive.turnCount,
    archivedAt: archive.archivedAt,
    createdAt: archive.createdAt,
    restorable: archive.restorable,
    unread: archive.unread,
  };
  for (const key of PAIRED_ARCHIVE_SUMMARY_OPTIONAL_KEYS) {
    copyOwnField(archive, qualified, key);
  }
  return qualified;
}

export function qualifyChatStateSnapshot(
  deviceId: string,
  snapshot: ChatStateSnapshot,
): ChatStateSnapshot {
  const runtimeByChatId: Record<string, ChatRuntimeState> = {};
  for (const [chatId, runtime] of Object.entries(snapshot.runtimeByChatId)) {
    runtimeByChatId[qualifyPairedId(deviceId, chatId)] =
      sanitizePairedRuntimeState(runtime, deviceId);
  }
  const qualified: ChatStateSnapshot = {
    schemaVersion: snapshot.schemaVersion,
    projectId: qualifyPairedId(deviceId, snapshot.projectId),
    worktreeId: qualifyPairedId(deviceId, snapshot.worktreeId),
    revision: snapshot.revision,
    tabsFile: qualifyTabsFile(deviceId, snapshot.tabsFile),
    archives: Array.isArray(snapshot.archives)
      ? snapshot.archives.map((archive) =>
          qualifyArchivedChatSummary(deviceId, archive),
        )
      : [],
    runtimeByChatId,
    queue: snapshot.queue.map((entry) =>
      qualifyQueueUpdatedEvent(deviceId, entry),
    ),
  };
  if (snapshot.recoveryError !== undefined) {
    qualified.recoveryError = snapshot.recoveryError;
  }
  return qualified;
}

export function qualifyChatStateChange(
  deviceId: string,
  change: ChatStateChange,
): ChatStateChange {
  switch (change.type) {
    case 'message.upserted':
      return {
        type: 'message.upserted',
        chatId: qualifyPairedId(deviceId, change.chatId),
        message: sanitizePairedMessage(deviceId, change.message),
        ...(change.afterMessageId !== undefined
          ? { afterMessageId: change.afterMessageId }
          : {}),
      };
    case 'messages.replaced':
      return {
        type: 'messages.replaced',
        chatId: qualifyPairedId(deviceId, change.chatId),
        messages: change.messages.map((message) =>
          sanitizePairedMessage(deviceId, message),
        ),
        removedMessageIds: Array.isArray(change.removedMessageIds)
          ? [...change.removedMessageIds]
          : [],
      };
    case 'runtime.patched':
      return {
        type: 'runtime.patched',
        chatId: qualifyPairedId(deviceId, change.chatId),
        runtime: sanitizePairedRuntimeState(change.runtime, deviceId),
      };
    case 'delegation.card_state_updated':
      return {
        type: 'delegation.card_state_updated',
        chatId: qualifyPairedId(deviceId, change.chatId),
        delegationId: qualifyPairedId(deviceId, change.delegationId),
        runGeneration: change.runGeneration,
        cardRevision: change.cardRevision,
        streamRevision: change.streamRevision,
        cardState: change.cardState,
      };
    case 'transcript.updated':
      return {
        type: 'transcript.updated',
        chatId: qualifyPairedId(deviceId, change.chatId),
        transcript: sanitizePairedTranscriptDescriptor(change.transcript),
        reset: change.reset,
      };
    case 'message.removed':
      return {
        type: 'message.removed',
        chatId: qualifyPairedId(deviceId, change.chatId),
        messageId: change.messageId,
      };
    case 'messages.omitted':
      return {
        type: 'messages.omitted',
        chatId: qualifyPairedId(deviceId, change.chatId),
      };
    case 'chat.initiated':
      return {
        type: 'chat.initiated',
        chatId: qualifyPairedId(deviceId, change.chatId),
        userMessageId: change.userMessageId,
        origin: change.origin,
        presentation: change.presentation,
        acceptedAt: change.acceptedAt,
      };
    case 'tab.upserted':
      return {
        type: 'tab.upserted',
        tab: qualifyPersistedTab(deviceId, change.tab),
      };
    case 'tab.removed':
      return {
        type: 'tab.removed',
        tabId: qualifyPairedId(deviceId, change.tabId),
      };
    case 'tab.metadata_patched':
      return {
        type: 'tab.metadata_patched',
        tabId: qualifyPairedId(deviceId, change.tabId),
        patch: sanitizePairedTabMetadataPatch(deviceId, change.patch),
      };
    case 'tab.order_changed':
      return {
        type: 'tab.order_changed',
        tabIds: change.tabIds.map((id) => qualifyPairedId(deviceId, id)),
      };
    case 'tab.active_changed':
      return {
        type: 'tab.active_changed',
        activeTabId: qualifyPairedId(deviceId, change.activeTabId),
        ...(change.lastActiveEditableChatId !== undefined
          ? {
              lastActiveEditableChatId: qualifyPairedId(
                deviceId,
                change.lastActiveEditableChatId,
              ),
            }
          : {}),
        ...(change.lastActiveChatProvider !== undefined
          ? { lastActiveChatProvider: change.lastActiveChatProvider }
          : {}),
      };
    case 'pending_question.upserted':
      return {
        type: 'pending_question.upserted',
        question: qualifyPendingQuestion(deviceId, change.question),
      };
    case 'pending_question.removed':
      return {
        type: 'pending_question.removed',
        requestId: qualifyPairedId(deviceId, change.requestId),
        chatId: qualifyPairedId(deviceId, change.chatId),
      };
    case 'archive.upserted':
      return {
        type: 'archive.upserted',
        archive: qualifyArchivedChatSummary(deviceId, change.archive),
      };
    case 'archive.removed':
      return {
        type: 'archive.removed',
        archiveEntryId: qualifyPairedId(deviceId, change.archiveEntryId),
        chatId: qualifyPairedId(deviceId, change.chatId),
      };
    case 'archive.read_state_changed':
      return {
        type: 'archive.read_state_changed',
        archiveEntryId: qualifyPairedId(deviceId, change.archiveEntryId),
        chatId: qualifyPairedId(deviceId, change.chatId),
        unread: change.unread,
      };
  }
}

const PAIRED_RECORD_TEXT_FIELDS = ['type', 'text', 'verbatim'] as const;
const PAIRED_RECORD_THINKING_FIELDS = ['type', 'text', 'thinking'] as const;
const PAIRED_RECORD_TOOL_USE_FIELDS = [
  'type',
  'id',
  'name',
  'input',
  'toolUseId',
  'toolName',
] as const;
const PAIRED_RECORD_TOOL_RESULT_FIELDS = [
  'type',
  'tool_use_id',
  'toolUseId',
  'toolName',
  'is_error',
  'isError',
  'outputTruncated',
  'interruption',
] as const;
const PAIRED_RECORD_TURN_TIMER_FIELDS = [
  'type',
  'turnId',
  'userMessageId',
  'startedAt',
  'pausedAt',
  'resumedAt',
  'accumulatedPausedDurationMs',
  'completedAt',
  'outcome',
] as const;

function sanitizePairedRecordBlock(deviceId: string, value: unknown): unknown {
  if (!isPlainRecord(value)) return makeUnsupportedPairedBlock();
  const blockType = typeof value.type === 'string' ? value.type : '';
  switch (blockType) {
    case 'text':
      return pickRecordFields(value, PAIRED_RECORD_TEXT_FIELDS);
    case 'thinking':
      return pickRecordFields(value, PAIRED_RECORD_THINKING_FIELDS);
    case 'image': {
      const out: Record<string, unknown> = { type: 'image', path: '' };
      if (typeof value.alt === 'string') out.alt = value.alt;
      if (typeof value.dataUrl === 'string') out.dataUrl = value.dataUrl;
      if (
        isPlainRecord(value.source) &&
        value.source.type === 'base64' &&
        typeof value.source.media_type === 'string' &&
        typeof value.source.data === 'string'
      ) {
        out.source = {
          type: 'base64',
          media_type: value.source.media_type,
          data: value.source.data,
        };
      }
      return out;
    }
    case 'tool_use': {
      const out = pickRecordFields(value, PAIRED_RECORD_TOOL_USE_FIELDS);
      if (
        isPlainRecord(value.display) &&
        typeof value.display.toolName === 'string' &&
        typeof value.display.input === 'string'
      ) {
        out.display = {
          toolName: value.display.toolName,
          input: value.display.input,
        };
      }
      return out;
    }
    case 'tool_result': {
      const out = pickRecordFields(value, PAIRED_RECORD_TOOL_RESULT_FIELDS);
      if (typeof value.output === 'string') {
        out.output = sanitizePairedWorkflowReceiptText(value.output);
      }
      if (value.content !== undefined) {
        out.content = sanitizePairedToolResultContent(deviceId, value.content);
      }
      return out;
    }
    case 'turn_timer': {
      const out = pickRecordFields(value, PAIRED_RECORD_TURN_TIMER_FIELDS);
      if (Array.isArray(value.pauseOwnerIds)) {
        out.pauseOwnerIds = value.pauseOwnerIds
          .filter((id): id is string => typeof id === 'string')
          .map((id) => qualifyPairedTimerPauseOwnerId(deviceId, id));
      }
      if (isPlainRecord(value.spawnedBy)) {
        out.spawnedBy = pickRecordFields(value.spawnedBy, [
          'taskId',
          'toolUseId',
          'event',
          'scheduled',
          'toolsLoaded',
        ]);
      }
      return out;
    }
    case 'approval_resolution_info': {
      const mode = sanitizePairedApprovalMode(value.mode);
      if (
        mode === undefined ||
        value.resolvedBy !== 'mode-change' ||
        typeof value.timestamp !== 'number'
      ) {
        return makeUnsupportedPairedBlock();
      }
      const previousMode = sanitizePairedApprovalMode(value.previousMode);
      return {
        type: 'approval_resolution_info',
        timestamp: value.timestamp,
        resolvedBy: 'mode-change',
        mode,
        ...(previousMode !== undefined ? { previousMode } : {}),
        titles: Array.isArray(value.titles)
          ? value.titles.filter(
              (title): title is string => typeof title === 'string',
            )
          : [],
      };
    }
    default:
      return makeUnsupportedPairedBlock();
  }
}

const PAIRED_EVENT_MESSAGE_RECORD_FIELDS = [
  'id',
  'role',
  'timestamp',
  'inputMode',
  'hidden',
  'cancelled',
  'userMessageSource',
  'parentToolUseId',
  'parentBlockId',
  'codexThreadId',
  'codexTurnId',
  'claudeUuid',
  'text',
] as const;

function sanitizePairedEventMessageRecord(
  deviceId: string,
  value: Record<string, unknown>,
): Record<string, unknown> {
  const out = pickRecordFields(value, PAIRED_EVENT_MESSAGE_RECORD_FIELDS);
  if (Array.isArray(value.blocks)) {
    out.blocks = value.blocks.map((block) =>
      sanitizePairedRecordBlock(deviceId, block),
    );
  }
  if (Array.isArray(value.content)) {
    out.content = value.content.map((block) =>
      sanitizePairedRecordBlock(deviceId, block),
    );
  } else if (typeof value.content === 'string') {
    out.content = sanitizePairedWorkflowReceiptText(value.content);
  }
  return out;
}

const PAIRED_CODEX_ITEM_FIELDS = [
  'id',
  'type',
  'status',
  'text',
  'command',
  'exit_code',
  'server',
  'tool',
  'arguments',
  'error',
  'success',
  'changes',
] as const;

function sanitizePairedCodexItem(
  deviceId: string,
  item: Record<string, unknown>,
): Record<string, unknown> {
  const out = pickRecordFields(item, PAIRED_CODEX_ITEM_FIELDS);
  if (typeof item.aggregated_output === 'string') {
    out.aggregated_output = sanitizePairedWorkflowReceiptText(
      item.aggregated_output,
    );
  } else if (isWorkflowLaunchReceipt(JSON.stringify(item))) {
    out.aggregated_output = PAIRED_WORKFLOW_RECEIPT_PLACEHOLDER;
  }
  if (isPlainRecord(item.result)) {
    if (isWorkflowLaunchReceipt(JSON.stringify(item.result))) {
      out.result = {
        content: [{ type: 'text', text: PAIRED_WORKFLOW_RECEIPT_PLACEHOLDER }],
      };
    } else if (item.result.content !== undefined) {
      out.result = {
        content: sanitizePairedToolResultContent(deviceId, item.result.content),
      };
    }
  } else if (item.result !== undefined) {
    out.result = sanitizePairedToolResultContent(deviceId, item.result);
  }
  if (item.content_items !== undefined) {
    out.content_items = sanitizePairedToolResultContent(
      deviceId,
      item.content_items,
    );
  }
  return out;
}

const PAIRED_SDK_MESSAGE_FIELDS = [
  'id',
  'role',
  'model',
  'stop_reason',
  'usage',
  'timestamp',
] as const;

function sanitizePairedSdkMessage(
  deviceId: string,
  message: Record<string, unknown>,
): Record<string, unknown> {
  const out = pickRecordFields(message, PAIRED_SDK_MESSAGE_FIELDS);
  if (Array.isArray(message.content)) {
    out.content = message.content.map((block) =>
      sanitizePairedRecordBlock(deviceId, block),
    );
  }
  if (Array.isArray(message.blocks)) {
    out.blocks = message.blocks.map((block) =>
      sanitizePairedRecordBlock(deviceId, block),
    );
  }
  return out;
}

const PAIRED_CODEX_EVENT_FIELDS = [
  'type',
  'thread_id',
  'turn_id',
  'status',
  'usage',
  'error',
  'message',
  'delta',
] as const;

const PAIRED_STREAM_EVENT_FIELDS = ['type', 'index', 'delta', 'usage'] as const;

/**
 * Rebuilds live paired ChatEvent payloads from a per-event-type allowlist.
 * Drops turn_diff, claude_terminal_transcript_sync turnDiffs/transcriptPath,
 * peer filesystem paths, and any unknown event types or extra fields.
 */
function sanitizePairedEventData(deviceId: string, data: unknown): unknown {
  if (!isPlainRecord(data)) {
    return {};
  }
  const eventType = typeof data.type === 'string' ? data.type : '';
  switch (eventType) {
    case 'assistant':
    case 'user': {
      const out = pickRecordFields(data, [
        'type',
        'uuid',
        'parent_tool_use_id',
        'session_id',
        'isSynthetic',
      ]);
      if (isPlainRecord(data.message)) {
        out.message = sanitizePairedSdkMessage(deviceId, data.message);
      }
      return out;
    }
    case 'stream_event': {
      const out = pickRecordFields(data, ['type', 'parent_tool_use_id']);
      if (isPlainRecord(data.event)) {
        const inner = pickRecordFields(data.event, PAIRED_STREAM_EVENT_FIELDS);
        if (isPlainRecord(data.event.content_block)) {
          inner.content_block = sanitizePairedRecordBlock(
            deviceId,
            data.event.content_block,
          );
        }
        if (isPlainRecord(data.event.message)) {
          inner.message = sanitizePairedSdkMessage(
            deviceId,
            data.event.message,
          );
        }
        out.event = inner;
      }
      return out;
    }
    case 'codex': {
      const out: Record<string, unknown> = { type: 'codex' };
      if (isPlainRecord(data.event)) {
        const inner = pickRecordFields(data.event, PAIRED_CODEX_EVENT_FIELDS);
        if (isPlainRecord(data.event.item)) {
          inner.item = sanitizePairedCodexItem(deviceId, data.event.item);
        }
        out.event = inner;
      }
      return out;
    }
    case 'result':
      return pickRecordFields(data, [
        'type',
        'subtype',
        'is_error',
        'result',
        'errors',
        'duration_ms',
        'num_turns',
        'total_cost_usd',
        'usage',
        'modelUsage',
        'canopy_session_continues',
        'canopy_cancelled',
        'stop_reason',
        'terminal_reason',
      ]);
    case 'error':
      return pickRecordFields(data, [
        'type',
        'error',
        'message',
        'code',
        'canopy_cancelled',
      ]);
    case 'system':
      return pickRecordFields(data, [
        'type',
        'subtype',
        'session_id',
        'task_id',
        'tool_use_id',
        'status',
        'description',
        'summary',
        'is_backgrounded',
        'ambient',
        'task_type',
        'last_tool_name',
        'usage',
      ]);
    case 'claude_terminal_transcript_sync': {
      const out = pickRecordFields(data, [
        'type',
        'importedEventCount',
        'replayedFromStart',
        'title',
        'model',
        'thinkingLevel',
        'modelConfig',
        'approvalMode',
        'planMode',
      ]);
      if (Array.isArray(data.messages)) {
        out.messages = data.messages.map((item: unknown) =>
          isPlainRecord(item)
            ? sanitizePairedEventMessageRecord(deviceId, item)
            : makeUnsupportedPairedBlock(),
        );
      }
      return out;
    }
    case 'canopy_user_prompt':
    case 'canopy_user_prompt_accepted':
    case 'canopy_injected_prompt': {
      const out = pickRecordFields(data, [
        'type',
        'userMessageId',
        'text',
        'timestamp',
      ]);
      if (Array.isArray(data.messages)) {
        out.messages = data.messages.map((item: unknown) =>
          isPlainRecord(item)
            ? sanitizePairedEventMessageRecord(deviceId, item)
            : makeUnsupportedPairedBlock(),
        );
      }
      if (isPlainRecord(data.message)) {
        out.message = sanitizePairedEventMessageRecord(deviceId, data.message);
      }
      return out;
    }
    case 'text_delta':
    case 'thinking_delta':
      return pickRecordFields(data, ['type', 'text', 'delta', 'index']);
    case '':
      return pickRecordFields(data, ['delta', 'text']);
    default:
      return { type: 'paired_dropped_event' };
  }
}

export function qualifyChatStateChangedEvent(
  deviceId: string,
  event: ChatStateChangedEvent,
): ChatStateChangedEvent {
  const changes: ChatStateChange[] = [];
  for (const change of event.changes) {
    if (change.type === 'tab.upserted' && !isPairedChatTab(change.tab)) {
      continue;
    }
    // Paired computers do not expose local delegation transcript/card IPC, so
    // delegated_agent_call blocks are replaced with placeholders and live card
    // state deltas are dropped while keeping the commit revision continuous.
    if (change.type === 'delegation.card_state_updated') {
      continue;
    }
    const qualified = qualifyChatStateChange(deviceId, change);
    // Active tab selection on paired computers is window-local; keep the
    // commit revision continuous without letting the paired host steal this
    // controller window's selected chat or panel focus.
    if (qualified.type === 'tab.active_changed') continue;
    changes.push(qualified);
  }
  return {
    schemaVersion: event.schemaVersion,
    eventId: `computer-${deviceId}:${event.eventId}`,
    occurredAt: event.occurredAt,
    projectId: qualifyPairedId(deviceId, event.projectId),
    worktreeId: qualifyPairedId(deviceId, event.worktreeId),
    baseRevision: event.baseRevision,
    revision: event.revision,
    changes,
  };
}

export function qualifyChatEvent(
  deviceId: string,
  event: ChatEvent,
): ChatEvent {
  return {
    projectId: qualifyPairedId(deviceId, event.projectId),
    worktreeId: qualifyPairedId(deviceId, event.worktreeId),
    chatId: qualifyPairedId(deviceId, event.chatId),
    data: sanitizePairedEventData(deviceId, event.data),
  };
}

export function qualifyApprovalRequestEvent(
  deviceId: string,
  event: ApprovalRequestEvent,
): ApprovalRequestEvent {
  const qualified: ApprovalRequestEvent = {
    requestId: qualifyPairedId(deviceId, event.requestId),
    projectId: qualifyPairedId(deviceId, event.projectId),
    worktreeId: qualifyPairedId(deviceId, event.worktreeId),
    chatId: qualifyPairedId(deviceId, event.chatId),
    provider: event.provider,
    title: event.title,
    details: sanitizePairedApprovalDetails(event.details),
  };
  if (event.secretInput !== undefined) {
    qualified.secretInput = sanitizePairedSecretInputPrompt(event.secretInput);
  }
  if (event.surface !== undefined) qualified.surface = event.surface;
  if (event.description !== undefined) {
    qualified.description = event.description;
  }
  if (event.suggestedTarget !== undefined) {
    qualified.suggestedTarget = sanitizePairedApprovalRuleTarget(
      event.suggestedTarget,
    );
  }
  if (event.toolUseId !== undefined) qualified.toolUseId = event.toolUseId;
  if (event.subagentId !== undefined) qualified.subagentId = event.subagentId;
  if (event.timerPauseOwnerId !== undefined) {
    qualified.timerPauseOwnerId = qualifyPairedTimerPauseOwnerId(
      deviceId,
      event.timerPauseOwnerId,
    );
  }
  if (event.policyRevision !== undefined) {
    qualified.policyRevision = event.policyRevision;
  }
  return qualified;
}

function sanitizePairedApprovalResolutionMessage(
  deviceId: string,
  message: PersistedChatMessage | undefined,
): PersistedChatMessage | undefined {
  if (
    !isPlainRecord(message) ||
    typeof message.id !== 'string' ||
    message.id.length === 0 ||
    message.role !== 'system' ||
    typeof message.timestamp !== 'number' ||
    !Array.isArray(message.blocks)
  ) {
    return undefined;
  }
  return sanitizePairedMessage(deviceId, message);
}

export function qualifyApprovalAutoResolvedEvent(
  deviceId: string,
  event: ApprovalAutoResolvedEvent,
): ApprovalAutoResolvedEvent {
  const resolutionMessage = sanitizePairedApprovalResolutionMessage(
    deviceId,
    event.resolutionMessage,
  );
  const qualified: ApprovalAutoResolvedEvent = {
    requestId: qualifyPairedId(deviceId, event.requestId),
    projectId: qualifyPairedId(deviceId, event.projectId),
    worktreeId: qualifyPairedId(deviceId, event.worktreeId),
    chatId: qualifyPairedId(deviceId, event.chatId),
    reason: event.reason,
    mode: event.mode,
  };
  if (event.previousMode !== undefined) {
    qualified.previousMode = event.previousMode;
  }
  if (resolutionMessage !== undefined) {
    qualified.resolutionMessage = resolutionMessage;
  }
  return qualified;
}

export function qualifyApprovalCancelledEvent(
  deviceId: string,
  event: { requestId: string },
): { requestId: string } {
  return { requestId: qualifyPairedId(deviceId, event.requestId) };
}

const PAIRED_ACTIVE_SESSION_OPTIONAL_KEYS = [
  'executionHarness',
  'model',
  'turnStartedAt',
  'turnElapsedMs',
  'activeBackgroundTaskCount',
  'lastEventType',
  'settingApplication',
  'turnSettings',
] as const satisfies readonly (keyof ChatActiveSessionInfo)[];

export function qualifyActiveSessions(
  deviceId: string,
  raw: ChatActiveSessions,
): ChatActiveSessions {
  const qualified: ChatActiveSessions = {
    activeChatIds: raw.activeChatIds.map((chatId) =>
      qualifyPairedId(deviceId, chatId),
    ),
  };
  if (Array.isArray(raw.sessions)) {
    qualified.sessions = raw.sessions.map((session) => {
      const sanitized: ChatActiveSessionInfo = {
        chatId: qualifyPairedId(deviceId, session.chatId),
        projectId: qualifyPairedId(deviceId, session.projectId),
        worktreeId: qualifyPairedId(deviceId, session.worktreeId),
        providerType: session.providerType,
        turnActive: session.turnActive,
        createdAt: session.createdAt,
        lastActivityAt: session.lastActivityAt,
        turnCount: session.turnCount,
        pendingMessageCount: session.pendingMessageCount,
      };
      for (const key of PAIRED_ACTIVE_SESSION_OPTIONAL_KEYS) {
        copyOwnField(session, sanitized, key);
      }
      return sanitized;
    });
  }
  return qualified;
}

const PAIRED_TRANSCRIPT_PAGE_REQUEST_OPTIONAL_KEYS = [
  'before',
  'transcriptRevision',
  'view',
  'turnId',
  'cursor',
] as const satisfies readonly (keyof ChatTranscriptPageRequest)[];

export function buildPairedTranscriptPageRequest(
  target: PairedDeviceTarget,
  req: ChatTranscriptPageRequest,
): ChatTranscriptPageRequest {
  const stripped: ChatTranscriptPageRequest = {
    projectId: target.projectId,
    worktreeId: target.worktreeId,
    chatId: target.chatId,
  };
  for (const key of PAIRED_TRANSCRIPT_PAGE_REQUEST_OPTIONAL_KEYS) {
    copyOwnField(req, stripped, key);
  }
  return stripped;
}

function generateOneWindowId(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }
  return `ow-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Builds the exact `chat:command` envelope allowed by `ONE_WINDOW_CHAT_COMMAND_FIELDS`
 * (`chat.send_message` with text only; no origin, no revision guards, no settings).
 */
export function buildOneWindowSendCommandEnvelope(input: {
  readonly target: PairedDeviceTarget;
  readonly text: string;
  readonly userMessageId?: string;
  readonly commandId?: string;
}): PairedSendCommandEnvelope {
  const { target, text } = input;
  if (text.length === 0 || text.length > MAX_ONE_WINDOW_SEND_TEXT_LENGTH) {
    throw new Error('Message text must be between 1 and 200,000 characters.');
  }
  const userMessageId =
    input.userMessageId !== undefined && isHostedId(input.userMessageId)
      ? input.userMessageId
      : generateOneWindowId();
  const commandId =
    input.commandId !== undefined && isHostedId(input.commandId)
      ? input.commandId
      : generateOneWindowId();
  return {
    schemaVersion: 1,
    commandId,
    projectId: target.projectId,
    worktreeId: target.worktreeId,
    command: {
      type: 'chat.send_message',
      chatId: target.chatId,
      userMessageId,
      text,
    },
  };
}

/**
 * Builds the exact `chat:cancel` request allowed by `ONE_WINDOW_REQUEST_FIELDS`
 * (every field required, naming the running turn by `expectedUserMessageId`).
 */
export function buildOneWindowCancelRequest(input: {
  readonly target: PairedDeviceTarget;
  readonly expectedUserMessageId: string;
}): PairedExactCancelRequest {
  if (!isHostedId(input.expectedUserMessageId)) {
    throw new Error('Expected a valid user message id to stop this turn.');
  }
  return {
    projectId: input.target.projectId,
    worktreeId: input.target.worktreeId,
    chatId: input.target.chatId,
    expectedUserMessageId: input.expectedUserMessageId,
  };
}

export function translateSendCommandResult(
  result: ChatCommandResult,
): ChatSendMessageResult {
  if (result.outcome === 'applied') return {};
  if (result.outcome === 'already_applied') {
    return { disposition: 'already_accepted' };
  }
  throw new Error(
    result.reason ?? 'The paired computer could not accept this message.',
  );
}
