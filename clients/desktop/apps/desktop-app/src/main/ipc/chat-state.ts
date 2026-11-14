import { classifyError } from '@canopy/protocol/app-errors/classification';
import {
  TrackedPlanImplementationInputSchema,
  ChatPlanReviewApprovalSchema,
} from '@canopy/protocol/portal';
import { parseChatAgentSentInfo } from '@canopy/protocol/portal';
import { parseAgentSenderProvenance } from '../agent-messaging/sender-context';
import { CHAT_CUSTOM_TITLE_MAX_LENGTH } from '@canopy/protocol';
import { rendererContentsOf } from '../lib/renderer-surface';
import { isFileDiffContext } from '@canopy/desktop-shared/types/code-review';
import type { ChatTranscriptSearchResult } from '@canopy/desktop-shared/types';
import { assertUntrustedChatInput } from '../agent-messaging/untrusted-input';
import type { BrowserWindow } from 'electron';
import { CanopyOperationError } from '@canopy/core-runtime';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import type { DesktopIpcCallerResolver } from './file-tree';
import type { ChatScopeKey } from '../services/chat-state-contracts';
import { isChatScopeDeletingError } from '../services/chat-scope-lifecycle';
import { isDeepStrictEqual } from 'node:util';
import {
  IPC_CHANNELS,
  isChatAttachmentPromptKind,
  isThinkingLevel,
  type ChatCommand,
  type ChatCommandRequest,
  type ChatCommandResult,
  type ChatGetStateRequest,
  type ChatInterestChatRef,
  type ChatInterestDeclaration,
  type ChatInterestRunRef,
  type ChatStateChangedEvent,
  type ChatStateCommandPort,
  type ChatStateLoadError,
  type ChatStateScopesDeclaration,
  type ChatStateSnapshot,
  type ChatTranscriptPageRequest,
  type ChatVisualReadRequest,
  type ChatVisualReadResult,
  type ChatToolOutputCancelRequest,
  type ChatToolOutputRequest,
  type ChatToolOutputResponse,
  type AgentProviderType,
} from '@canopy/desktop-shared/types';
import type { TranscriptPage } from '@canopy/agent-transcript/transcript-storage';
import {
  isVisualId,
  VISUAL_HEIGHTS_MAX_ENTRIES,
  VISUAL_MAX_HEIGHT,
  VISUAL_MIN_HEIGHT,
  VISUAL_PREPARED_MAX_BYTES,
  VISUAL_TITLE_MAX_LENGTH,
} from '@canopy/agent-transcript/lib/visual-ref';
import { serializeAgentArtifactReceipt } from '@canopy/desktop-shared/lib/agent-artifacts';
import { isApprovalMode } from '@canopy/desktop-shared/lib/approval-engine';
import { isModelHarness } from '@canopy/execution-engine/model-harnesses';
import {
  codexSpeedFastMode,
  isCodexSpeed,
} from '@canopy/execution-engine/lib/codex-speed';
import { isCodexContextWindowSetting } from '@canopy/execution-engine/lib/codex-context-window';
import { isChatTabPluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import { registerIpcHandler } from './register';
import {
  createChatCommandDispatchOptions,
  dispatchChatCommandForLegacyIpc,
} from '../canopy-runtime/core-chat-command-adapter';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import { isPersistedChatTab } from '../lib/chat-tabs-reader';
import { validateId, validateMessageAnchorId } from '../lib/validation';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import {
  addRendererDeliveryBarrier,
  sendToWebContents,
  setRendererDeliveryFilter,
} from '../lib/web-contents-send';
import {
  ChatEventInterestFilter,
  runsEnteringInterest,
} from './chat-event-interest';
import { shouldDropObservabilityEvent } from './observability-event-interest';
import { filterChatStateBodies } from './chat-state-body-filter';
import { MAX_DECLARED_CHAT_STATE_SCOPES } from '@canopy/desktop-shared/lib/chat-state-cadence';
import {
  ChatStateDelivery,
  ChatStateSubscriptions,
} from './chat-state-delivery';
import { installChatInterestE2eHook } from './chat-interest-e2e';
import {
  installChatInterestLookup,
  notifyRunsEnteringInterest,
} from './chat-interest-registry';

const MAX_ID_LENGTH = 256;
const MAX_OPAQUE_INSTRUCTION_ID_LENGTH = 4_096;
const MAX_COMMAND_BYTES = 1024 * 1024;
// Branching carries a complete persisted transcript in seedTab. Keep that
// trusted command bounded without applying the much smaller ordinary-command
// envelope to routine long-running chats.
const MAX_SEEDED_CHAT_COMMAND_BYTES = 32 * 1024 * 1024;
const MAX_TEXT_LENGTH = 512 * 1024;
const MAX_ARRAY_ENTRIES = 1_000;

type JsonRecord = Record<string, unknown>;

let installedChatStatePort: ChatStateCommandPort | null = null;

export function getChatStateCommandPort(): ChatStateCommandPort | null {
  return installedChatStatePort;
}

export function setChatStateCommandPort(
  port: ChatStateCommandPort | null,
): void {
  installedChatStatePort = port;
}

export { recordedChatInterest } from './chat-interest-registry';

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInterestSubscriber(
  value: object,
): value is Pick<BrowserWindow['webContents'], 'id' | 'isDestroyed'> {
  return (
    'id' in value &&
    typeof value.id === 'number' &&
    'isDestroyed' in value &&
    typeof value.isDestroyed === 'function'
  );
}

class InvalidChatStateRequestError extends Error implements ChatStateLoadError {
  public override readonly name = 'ChatStateLoadError';
  public readonly code = 'invalid_request' as const;
  public readonly retryable = false;
}

function failInvalidRequest(message: string): never {
  throw new InvalidChatStateRequestError(message);
}

function assertExactKeys(
  value: JsonRecord,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) {
    failInvalidRequest(`${label} contains unexpected field "${unexpected}".`);
  }
}

function readId(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_ID_LENGTH
  ) {
    failInvalidRequest(
      `${label} must be a nonempty string of at most ${String(MAX_ID_LENGTH)} characters.`,
    );
  }
  try {
    validateId(value, label);
  } catch {
    failInvalidRequest(`invalid ${label}: unsafe id.`);
  }
  return value;
}

function readScopeId(value: unknown, label: string): string {
  return readId(value, label);
}

function readMessageAnchorId(value: unknown, label: string): string {
  try {
    validateMessageAnchorId(value, label);
  } catch (error) {
    failInvalidRequest(
      error instanceof Error ? error.message : `invalid ${label}.`,
    );
  }
  return value;
}

function readBoundedString(
  value: unknown,
  label: string,
  options: { allowEmpty?: boolean; maxLength?: number } = {},
): string {
  const maxLength = options.maxLength ?? MAX_TEXT_LENGTH;
  if (
    typeof value !== 'string' ||
    (!options.allowEmpty && value.length === 0) ||
    value.length > maxLength
  ) {
    failInvalidRequest(`${label} must be a bounded string.`);
  }
  return value;
}

function readOptionalBoolean(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== 'boolean') {
    failInvalidRequest(`${label} must be a boolean.`);
  }
}

/** Every command model-config shape: thinking plus the Codex fields. */
const MODEL_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'thinkingLevel',
  'speed',
  'fastMode',
  'contextWindow',
]);

/**
 * `speed` must be a supported Codex speed, and a legacy `fastMode` sent
 * beside it must equal its derived projection (`speed === 'fast'`). A
 * boolean-only legacy command stays valid; applying it replaces the speed.
 */
function validateCodexSpeedFields(
  modelConfig: JsonRecord,
  label: string,
): void {
  const { speed, fastMode, contextWindow } = modelConfig;
  if (
    contextWindow !== undefined &&
    !isCodexContextWindowSetting(contextWindow)
  ) {
    failInvalidRequest(`${label}.contextWindow is unsupported.`);
  }
  if (speed === undefined) return;
  if (!isCodexSpeed(speed)) {
    failInvalidRequest(`${label}.speed is unsupported.`);
  }
  if (typeof fastMode === 'boolean' && fastMode !== codexSpeedFastMode(speed)) {
    failInvalidRequest(`${label}.fastMode contradicts ${label}.speed.`);
  }
}

function readRevision(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    failInvalidRequest(`${label} must be a nonnegative safe integer.`);
  }
  return value;
}

function assertJsonValue(
  value: unknown,
  path: string,
  seen: Set<object>,
): void {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      failInvalidRequest(`${path} must not contain a non-finite number.`);
    }
    return;
  }
  if (typeof value !== 'object') {
    failInvalidRequest(`${path} must contain only JSON-serializable values.`);
  }
  if (seen.has(value)) {
    failInvalidRequest(`${path} must not contain a circular value.`);
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertJsonValue(entry, `${path}[${String(index)}]`, seen),
    );
  } else {
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) {
        failInvalidRequest(`${path}.${key} must not be undefined.`);
      }
      assertJsonValue(entry, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function readIdArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    failInvalidRequest(`${label} must be an array.`);
  }
  if (value.length > MAX_ARRAY_ENTRIES) {
    failInvalidRequest(`${label} contains too many entries.`);
  }
  return value.map((entry, index) =>
    readId(entry, `${label}[${String(index)}]`),
  );
}

function readBoundedStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    failInvalidRequest(`${label} must be an array.`);
  }
  if (value.length > MAX_ARRAY_ENTRIES) {
    failInvalidRequest(`${label} contains too many entries.`);
  }
  return value.map((entry, index) =>
    readBoundedString(entry, `${label}[${String(index)}]`),
  );
}

function readOpaqueInstructionId(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_OPAQUE_INSTRUCTION_ID_LENGTH
  ) {
    failInvalidRequest(
      `${label} must be a nonempty string of at most ${String(MAX_OPAQUE_INSTRUCTION_ID_LENGTH)} characters.`,
    );
  }
  if (
    value.split('').some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    failInvalidRequest(`invalid ${label}: control characters are not allowed.`);
  }
  return value;
}

function readOpaqueInstructionIdArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    failInvalidRequest(`${label} must be an array.`);
  }
  if (value.length > MAX_ARRAY_ENTRIES) {
    failInvalidRequest(`${label} contains too many entries.`);
  }
  return value.map((entry, index) =>
    readOpaqueInstructionId(entry, `${label}[${String(index)}]`),
  );
}

function validateAiCreditsRouting(value: unknown, label: string): void {
  if (!isRecord(value)) {
    failInvalidRequest(`${label} must be an object.`);
  }
  assertExactKeys(
    value,
    new Set(['active', 'scope', 'activatedAt', 'resetsAt', 'modelId']),
    label,
  );
  if (typeof value.active !== 'boolean') {
    failInvalidRequest(`${label}.active must be boolean.`);
  }
  if (value.scope !== 'session' && value.scope !== 'persistent') {
    failInvalidRequest(`${label}.scope is unsupported.`);
  }
  if (
    typeof value.activatedAt !== 'number' ||
    !Number.isFinite(value.activatedAt) ||
    value.activatedAt < 0
  ) {
    failInvalidRequest(`${label}.activatedAt is invalid.`);
  }
  if (
    value.resetsAt !== undefined &&
    (typeof value.resetsAt !== 'number' ||
      !Number.isFinite(value.resetsAt) ||
      value.resetsAt < 0)
  ) {
    failInvalidRequest(`${label}.resetsAt is invalid.`);
  }
  if (value.modelId !== undefined) {
    readBoundedString(value.modelId, `${label}.modelId`);
  }
}

function validatePluginSelectionTombstones(
  value: unknown,
  label: string,
): void {
  if (!isRecord(value)) {
    failInvalidRequest(`${label} must be an object.`);
  }
  assertExactKeys(
    value,
    new Set(['collectionIds', 'skillRefs', 'pluginRefs', 'mcpServerRefs']),
    label,
  );
  if (value.collectionIds !== undefined) {
    readBoundedStringArray(value.collectionIds, `${label}.collectionIds`);
  }
  for (const [field, keys] of [
    ['skillRefs', ['sourceId', 'skillName']],
    ['pluginRefs', ['marketplaceId', 'pluginName']],
    ['mcpServerRefs', ['serverId', 'configId']],
  ] as const) {
    const entries = value[field];
    if (entries === undefined) continue;
    if (!Array.isArray(entries) || entries.length > MAX_ARRAY_ENTRIES) {
      failInvalidRequest(`${label}.${field} must be a bounded array.`);
    }
    entries.forEach((entry, index) => {
      const entryLabel = `${label}.${field}[${String(index)}]`;
      if (!isRecord(entry)) {
        failInvalidRequest(`${entryLabel} must be an object.`);
      }
      assertExactKeys(entry, new Set(keys), entryLabel);
      for (const key of keys) {
        readBoundedString(entry[key], `${entryLabel}.${key}`);
      }
    });
  }
}

function validateAttachmentMetadata(command: JsonRecord): void {
  if (command.fileReferences !== undefined) {
    if (!Array.isArray(command.fileReferences)) {
      failInvalidRequest('command.fileReferences must be an array.');
    }
    if (command.fileReferences.length > MAX_ARRAY_ENTRIES) {
      failInvalidRequest('command.fileReferences contains too many entries.');
    }
    command.fileReferences.forEach((reference, index) => {
      const label = `command.fileReferences[${String(index)}]`;
      if (!isRecord(reference)) {
        failInvalidRequest(`${label} must be an object.`);
      }
      assertExactKeys(
        reference,
        new Set([
          'displayPath',
          'absolutePath',
          'repoName',
          'kind',
          'textStart',
        ]),
        label,
      );
      readBoundedString(reference.displayPath, `${label}.displayPath`);
      readBoundedString(reference.absolutePath, `${label}.absolutePath`);
      for (const field of ['repoName', 'kind']) {
        if (reference[field] !== undefined) {
          readBoundedString(reference[field], `${label}.${field}`);
        }
      }
      if (
        reference.textStart !== undefined &&
        (typeof reference.textStart !== 'number' ||
          !Number.isSafeInteger(reference.textStart) ||
          reference.textStart < 0)
      ) {
        failInvalidRequest(`${label}.textStart is invalid.`);
      }
    });
  }
  if (command.attachmentPaths !== undefined) {
    readBoundedStringArray(command.attachmentPaths, 'command.attachmentPaths');
  }
  if (command.attachmentPromptContexts !== undefined) {
    if (!Array.isArray(command.attachmentPromptContexts)) {
      failInvalidRequest('command.attachmentPromptContexts must be an array.');
    }
    if (command.attachmentPromptContexts.length > MAX_ARRAY_ENTRIES) {
      failInvalidRequest(
        'command.attachmentPromptContexts contains too many entries.',
      );
    }
    command.attachmentPromptContexts.forEach((context, index) => {
      const label = `command.attachmentPromptContexts[${String(index)}]`;
      if (!isRecord(context)) {
        failInvalidRequest(`${label} must be an object.`);
      }
      assertExactKeys(
        context,
        new Set(['attachmentPath', 'promptKind']),
        label,
      );
      readBoundedString(context.attachmentPath, `${label}.attachmentPath`);
      if (!isChatAttachmentPromptKind(context.promptKind)) {
        failInvalidRequest(`${label}.promptKind is unsupported.`);
      }
    });
  }
}

const PATCH_KEYS = new Set([
  'customTitle',
  'unread',
  'filePath',
  'title',
  'providerType',
  'model',
  'modelSelectionMode',
  'modelExplicitlyChosen',
  'billingExplicitlyChosen',
  'sdkSessionId',
  'globalInstructionsSnapshot',
  'modelConfig',
  'thinkingLevel',
  'codexFastModeEnabled',
  'planMode',
  'proposalMode',
  'pluginSelections',
  'deferredToolsAllowed',
  'interfaceMode',
  'selectedRepoId',
  'attentionDismissedAt',
  'aiCreditsRouting',
  'subscriptionBillingOverride',
  'sharedRun',
  'scheduledSendDraft',
  'autoArchive',
  'pendingPlanExit',
  'pendingPlanExitRequestId',
  'trackedPlanImplementation',
  'trackedPlanId',
  'trackedPlanSource',
  'trackedPlanReviewStatus',
  'hasOutstandingProposal',
  'latestRevisionNumber',
  'pendingSystemInstructions',
  'agentArtifactCarryByTurn',
  'pinned',
  'fileViewMode',
  'fileDiffContext',
]);
const MAIN_PATCH_KEYS = new Set([
  ...Array.from(PATCH_KEYS),
  'description',
  'pendingRevertAttachmentPath',
  'newChatStartedWatcherPending',
  'newChatStartedWatcherFiredAt',
]);

const COMMAND_KEYS: Record<ChatCommand['type'], ReadonlySet<string>> = {
  'chat.create_tab': new Set([
    'type',
    'tabId',
    'title',
    'providerType',
    'model',
    'defaultStampModel',
    'modelConfig',
    'planMode',
    'proposalMode',
    'pluginSelections',
    'deferredToolsAllowed',
    'interfaceMode',
    'selectedRepoId',
    'approvalMode',
    'aiCreditsRouting',
    'subscriptionBillingOverride',
    'seedTab',
    'starter',
  ]),
  'chat.create_file_tab': new Set([
    'type',
    'tabId',
    'filePath',
    'title',
    'viewMode',
    'pinned',
    'activate',
  ]),
  'chat.activate_tab': new Set(['type', 'tabId']),
  'chat.reorder_tabs': new Set(['type', 'tabIds']),
  'chat.close_tab': new Set([
    'type',
    'tabId',
    'mode',
    'replacementTabId',
    'replacementTab',
  ]),
  'chat.close_tabs': new Set([
    'type',
    'targets',
    'replacementTabId',
    'replacementTab',
  ]),
  'chat.patch_tab_settings': new Set([
    'type',
    'tabId',
    'patch',
    'expectedPendingPlanExitRequestId',
  ]),
  'chat.set_model': new Set([
    'executionHarness',
    'type',
    'tabId',
    'model',
    'providerType',
    'settings',
    'notice',
  ]),
  'chat.set_approval_mode': new Set(['type', 'tabId', 'approvalMode']),
  'chat.mark_read': new Set(['type', 'chatId']),
  'chat.mark_unread': new Set(['type', 'chatId', 'manual']),
  'chat.dismiss_attention': new Set(['type', 'chatId', 'attentionVersion']),
  'chat.send_message': new Set([
    'type',
    'chatId',
    'userMessageId',
    'text',
    'selectedRepoId',
    'modelConfig',
    'planReviewApproval',
    'trackedPlanImplementation',
    'planMode',
    'codexProposalMode',
    'inputMode',
    'fileReferences',
    'attachmentPaths',
    'attachmentPromptContexts',
  ]),
  'chat.reject_plan_implementation_delivery': new Set([
    'type',
    'chatId',
    'userMessageId',
  ]),
  'chat.commit_terminal_initial_prompt': new Set([
    'type',
    'chatId',
    'userMessageId',
    'turnTimerMessageId',
    'text',
    'inputMode',
    'fileReferences',
    'attachmentPaths',
    'attachmentPromptContexts',
    'pendingSystemInstructionIds',
    'watcherFired',
  ]),
  'chat.edit_queued_message': new Set([
    'type',
    'chatId',
    'queuedMessageId',
    'text',
    'inputMode',
    'fileReferences',
    'attachmentPaths',
    'attachmentPromptContexts',
    'queuedMessageRevision',
  ]),
  'chat.move_queued_message': new Set([
    'type',
    'chatId',
    'queuedMessageId',
    'beforeQueuedMessageId',
    'queuedMessageRevision',
  ]),
  'chat.cancel_queued_message': new Set([
    'type',
    'chatId',
    'queuedMessageId',
    'queuedMessageRevision',
  ]),
  'chat.force_queued_message': new Set([
    'type',
    'chatId',
    'queuedMessageId',
    'queuedMessageRevision',
  ]),
  'chat.steer_queued_message': new Set([
    'type',
    'chatId',
    'queuedMessageId',
    'queuedMessageRevision',
  ]),
  'chat.set_queued_message_edit_lock': new Set([
    'type',
    'chatId',
    'queuedMessageId',
    'locked',
    'acquisitionId',
    'queuedMessageRevision',
  ]),
  'chat.input_delivery_action': new Set([
    'type',
    'chatId',
    'rowId',
    'rowRevision',
    'action',
    'text',
  ]),
  'chat.answer_question': new Set(['type', 'chatId', 'questionId', 'answers']),
  'chat.dismiss_question': new Set(['type', 'chatId', 'questionId']),
  'chat.archive_tab': new Set(['type', 'tabId', 'unread', 'keepSession']),
  'chat.restore_archive': new Set(['type', 'archiveEntryId', 'targetTabId']),
  'chat.mark_archive_read': new Set(['type', 'archiveEntryId', 'unread']),
  'chat.mark_all_archives_read': new Set(['type']),
  'chat.fork_tab': new Set([
    'type',
    'sourceTabId',
    'targetTabId',
    'atMessageId',
    'sourceSdkSessionId',
    'syncWarning',
    'cloneMode',
    'destinationTab',
  ]),
  'chat.reset_to_point': new Set([
    'type',
    'chatId',
    'userMessageId',
    'blockId',
  ]),
  'chat.import_session': new Set(['type', 'targetChatId', 'source']),
  'chat.set_scheduled_send_draft': new Set([
    'type',
    'chatId',
    'draft',
    'clearPendingRevertAttachment',
  ]),
};

const SEEDED_CHAT_TAB_KEYS = new Set([
  'id',
  'title',
  'messages',
  'agentArtifactCarryByTurn',
  'createdAt',
  'planMode',
  'thinkingLevel',
  'modelConfig',
  'codexFastModeEnabled',
  'retainedCodexSpeed',
  'model',
  'providerType',
  'executionHarness',
  'executionHarnessExplicitlyChosen',
  'pendingPlanExit',
  'trackedPlanId',
  'trackedPlanSource',
  'trackedPlanReviewStatus',
  'pendingSystemInstructions',
  'hasOutstandingProposal',
  'proposalMode',
  'sdkSessionId',
  'globalInstructionsSnapshot',
  'claudeForkSessionOnNextSend',
  'newChatStartedWatcherPending',
  'pluginSelections',
  'disabledGlobalPluginSelections',
  'inheritedPluginDefaultsVersion',
  'deferredToolsAllowed',
  'aiCreditsRouting',
  'subscriptionBillingOverride',
  'discovery',
  'usage',
  'agentUsage',
  'turnDiffs',
  'selectedRepoId',
  'forkedFrom',
]);

function validateSeededChatTab(
  value: unknown,
  expectedId: string,
  allowMainOnlyFields: boolean,
): void {
  if (!isRecord(value) || !isPersistedChatTab(value)) {
    failInvalidRequest('command.seedTab must be a valid persisted chat tab.');
  }
  const seed: JsonRecord = value;
  assertExactKeys(
    seed,
    allowMainOnlyFields
      ? new Set([...Array.from(SEEDED_CHAT_TAB_KEYS), 'filePath'])
      : SEEDED_CHAT_TAB_KEYS,
    'command.seedTab',
  );
  if (seed.filePath !== undefined)
    readBoundedString(seed.filePath, 'command.seedTab.filePath');
  readId(seed.id, 'command.seedTab.id');
  if (seed.id !== expectedId) {
    failInvalidRequest('command.seedTab.id must match command.tabId.');
  }
  readBoundedString(seed.title, 'command.seedTab.title', {
    allowEmpty: true,
  });
  readBoundedString(seed.createdAt, 'command.seedTab.createdAt');

  for (const field of [
    'model',
    'sdkSessionId',
    'globalInstructionsSnapshot',
    'trackedPlanId',
  ] as const) {
    if (seed[field] !== undefined) {
      readBoundedString(seed[field], `command.seedTab.${field}`, {
        allowEmpty: field === 'globalInstructionsSnapshot',
      });
    }
  }
  if (
    seed.providerType !== undefined &&
    seed.providerType !== 'claude' &&
    seed.providerType !== 'codex' &&
    seed.providerType !== 'ollama' &&
    seed.providerType !== 'cursor' &&
    seed.providerType !== 'copilot' &&
    seed.providerType !== 'antigravity' &&
    seed.providerType !== 'opencode'
  ) {
    failInvalidRequest('command.seedTab.providerType is unsupported.');
  }
  if (
    seed.executionHarness !== undefined &&
    seed.executionHarness !== 'claude' &&
    seed.executionHarness !== 'codex' &&
    seed.executionHarness !== 'cursor' &&
    seed.executionHarness !== 'copilot' &&
    seed.executionHarness !== 'antigravity' &&
    seed.executionHarness !== 'opencode'
  ) {
    failInvalidRequest('command.seedTab.executionHarness is unsupported.');
  }
  if (
    seed.executionHarnessExplicitlyChosen !== undefined &&
    typeof seed.executionHarnessExplicitlyChosen !== 'boolean'
  ) {
    failInvalidRequest(
      'command.seedTab.executionHarnessExplicitlyChosen must be a boolean.',
    );
  }
  if (
    seed.thinkingLevel !== undefined &&
    (typeof seed.thinkingLevel !== 'string' ||
      !isThinkingLevel(seed.thinkingLevel))
  ) {
    failInvalidRequest('command.seedTab.thinkingLevel is unsupported.');
  }
  if (seed.modelConfig !== undefined) {
    if (!isRecord(seed.modelConfig)) {
      failInvalidRequest('command.seedTab.modelConfig must be an object.');
    }
    assertExactKeys(
      seed.modelConfig,
      MODEL_CONFIG_KEYS,
      'command.seedTab.modelConfig',
    );
    if (
      seed.modelConfig.thinkingLevel !== undefined &&
      (typeof seed.modelConfig.thinkingLevel !== 'string' ||
        !isThinkingLevel(seed.modelConfig.thinkingLevel))
    ) {
      failInvalidRequest(
        'command.seedTab.modelConfig.thinkingLevel is unsupported.',
      );
    }
    readOptionalBoolean(
      seed.modelConfig.fastMode,
      'command.seedTab.modelConfig.fastMode',
    );
    validateCodexSpeedFields(seed.modelConfig, 'command.seedTab.modelConfig');
  }
  if (
    seed.retainedCodexSpeed !== undefined &&
    !isCodexSpeed(seed.retainedCodexSpeed)
  ) {
    failInvalidRequest('command.seedTab.retainedCodexSpeed is unsupported.');
  }
  for (const field of [
    'planMode',
    'codexFastModeEnabled',
    'hasOutstandingProposal',
    'claudeForkSessionOnNextSend',
    'newChatStartedWatcherPending',
  ] as const) {
    readOptionalBoolean(seed[field], `command.seedTab.${field}`);
  }
  if (
    seed.proposalMode !== undefined &&
    seed.proposalMode !== 'optional' &&
    seed.proposalMode !== 'required'
  ) {
    failInvalidRequest('command.seedTab.proposalMode is unsupported.');
  }
  if (
    seed.pluginSelections !== undefined &&
    !isChatTabPluginSelections(seed.pluginSelections)
  ) {
    failInvalidRequest('command.seedTab.pluginSelections is malformed.');
  }
  if (seed.disabledGlobalPluginSelections !== undefined) {
    validatePluginSelectionTombstones(
      seed.disabledGlobalPluginSelections,
      'command.seedTab.disabledGlobalPluginSelections',
    );
  }
  if (
    seed.inheritedPluginDefaultsVersion !== undefined &&
    (typeof seed.inheritedPluginDefaultsVersion !== 'number' ||
      !Number.isSafeInteger(seed.inheritedPluginDefaultsVersion) ||
      seed.inheritedPluginDefaultsVersion < 1)
  ) {
    failInvalidRequest(
      'command.seedTab.inheritedPluginDefaultsVersion must be a positive integer.',
    );
  }
  readOptionalBoolean(
    seed.deferredToolsAllowed,
    'command.seedTab.deferredToolsAllowed',
  );
  readOptionalBoolean(
    seed.subscriptionBillingOverride,
    'command.seedTab.subscriptionBillingOverride',
  );
  if (seed.aiCreditsRouting !== undefined) {
    validateAiCreditsRouting(
      seed.aiCreditsRouting,
      'command.seedTab.aiCreditsRouting',
    );
  }
  if (seed.selectedRepoId !== undefined) {
    readId(seed.selectedRepoId, 'command.seedTab.selectedRepoId');
  }
  if (seed.pendingPlanExit !== undefined) {
    if (!isRecord(seed.pendingPlanExit)) {
      failInvalidRequest('command.seedTab.pendingPlanExit must be an object.');
    }
    assertJsonValue(
      seed.pendingPlanExit,
      'command.seedTab.pendingPlanExit',
      new Set(),
    );
  }
  if (
    seed.trackedPlanSource !== undefined &&
    (typeof seed.trackedPlanSource !== 'string' ||
      ![
        'claude',
        'codex',
        'ollama',
        'cursor',
        'copilot',
        'antigravity',
        'opencode',
        'pipeline',
        'imported',
        'detected',
      ].includes(seed.trackedPlanSource))
  ) {
    failInvalidRequest('command.seedTab.trackedPlanSource is unsupported.');
  }
  if (
    seed.trackedPlanReviewStatus !== undefined &&
    (typeof seed.trackedPlanReviewStatus !== 'string' ||
      !['pending', 'approved', 'dismissed'].includes(
        seed.trackedPlanReviewStatus,
      ))
  ) {
    failInvalidRequest(
      'command.seedTab.trackedPlanReviewStatus is unsupported.',
    );
  }
  if (
    seed.pendingSystemInstructions !== undefined &&
    (!Array.isArray(seed.pendingSystemInstructions) ||
      seed.pendingSystemInstructions.length > MAX_ARRAY_ENTRIES ||
      seed.pendingSystemInstructions.some(
        (instruction) =>
          !isRecord(instruction) ||
          Object.keys(instruction).some(
            (key) => key !== 'id' && key !== 'text',
          ) ||
          typeof instruction.id !== 'string' ||
          instruction.id.length === 0 ||
          instruction.id.length > MAX_ID_LENGTH ||
          typeof instruction.text !== 'string' ||
          instruction.text.length > MAX_TEXT_LENGTH,
      ))
  ) {
    failInvalidRequest('command.seedTab.pendingSystemInstructions is invalid.');
  }
  if (seed.forkedFrom !== undefined) {
    if (!isRecord(seed.forkedFrom)) {
      failInvalidRequest('command.seedTab.forkedFrom must be an object.');
    }
    assertExactKeys(
      seed.forkedFrom,
      new Set([
        'projectId',
        'worktreeId',
        'chatId',
        'continuedFromProvider',
        'atMessageId',
        'modelContext',
        'resumePointRequired',
      ]),
      'command.seedTab.forkedFrom',
    );
    for (const field of ['projectId', 'worktreeId', 'chatId'] as const) {
      readId(seed.forkedFrom[field], `command.seedTab.forkedFrom.${field}`);
    }
    if (seed.forkedFrom.atMessageId !== undefined) {
      readMessageAnchorId(
        seed.forkedFrom.atMessageId,
        'command.seedTab.forkedFrom.atMessageId',
      );
    }
    if (
      seed.forkedFrom.modelContext !== undefined &&
      seed.forkedFrom.modelContext !== 'fresh' &&
      seed.forkedFrom.modelContext !== 'visible-transcript'
    ) {
      failInvalidRequest(
        'command.seedTab.forkedFrom.modelContext is unsupported.',
      );
    }
    if (
      seed.forkedFrom.resumePointRequired !== undefined &&
      seed.forkedFrom.resumePointRequired !== true
    ) {
      failInvalidRequest(
        'command.seedTab.forkedFrom.resumePointRequired is unsupported.',
      );
    }
    if (
      seed.forkedFrom.continuedFromProvider !== undefined &&
      seed.forkedFrom.continuedFromProvider !== 'claude' &&
      seed.forkedFrom.continuedFromProvider !== 'codex' &&
      seed.forkedFrom.continuedFromProvider !== 'ollama' &&
      seed.forkedFrom.continuedFromProvider !== 'cursor' &&
      seed.forkedFrom.continuedFromProvider !== 'copilot' &&
      seed.forkedFrom.continuedFromProvider !== 'antigravity' &&
      seed.forkedFrom.continuedFromProvider !== 'opencode'
    ) {
      failInvalidRequest(
        'command.seedTab.forkedFrom.continuedFromProvider is unsupported.',
      );
    }
  }
  for (const field of [
    'agentArtifactCarryByTurn',
    'discovery',
    'usage',
    'agentUsage',
    'turnDiffs',
  ] as const) {
    if (seed[field] !== undefined) {
      if (!isRecord(seed[field])) {
        failInvalidRequest(`command.seedTab.${field} must be an object.`);
      }
      assertJsonValue(seed[field], `command.seedTab.${field}`, new Set());
    }
  }
}

function isChatCommandType(value: string): value is ChatCommand['type'] {
  return Object.prototype.hasOwnProperty.call(COMMAND_KEYS, value);
}

function isValidatedChatCommand(value: unknown): value is ChatCommand {
  return (
    isRecord(value) &&
    typeof value.type === 'string' &&
    isChatCommandType(value.type)
  );
}

const TURN_OVERRIDE_KEYS: ReadonlySet<string> = new Set([
  'version',
  'model',
  'providerType',
  'executionHarness',
  'resetRuntime',
  'modelConfig',
  'planMode',
  'approvalMode',
  'pluginSelections',
]);

// Keyed by the union, so adding a provider fails to compile until it is listed.
const PROVIDER_TYPE_KEYS: Record<AgentProviderType, true> = {
  claude: true,
  codex: true,
  ollama: true,
  cursor: true,
  copilot: true,
  antigravity: true,
  opencode: true,
};
const PROVIDER_TYPES: ReadonlySet<unknown> = new Set(
  Object.keys(PROVIDER_TYPE_KEYS),
);

/** The main-only per-turn override's exact shape; main resolved its values. */
function validateTurnOverride(value: unknown): void {
  if (!isRecord(value) || value.version !== 1)
    failInvalidRequest('command.turnOverride is malformed.');
  assertExactKeys(value, TURN_OVERRIDE_KEYS, 'command.turnOverride');
  if (value.model !== undefined)
    readBoundedString(value.model, 'command.turnOverride.model');
  if (
    value.providerType !== undefined &&
    !PROVIDER_TYPES.has(value.providerType)
  )
    failInvalidRequest('command.turnOverride.providerType is unsupported.');
  if (
    value.executionHarness !== undefined &&
    !isModelHarness(value.executionHarness)
  )
    failInvalidRequest('command.turnOverride.executionHarness is unsupported.');
  if (value.resetRuntime !== undefined && value.resetRuntime !== true)
    failInvalidRequest('command.turnOverride.resetRuntime is unsupported.');
  if (value.modelConfig !== undefined) {
    if (!isRecord(value.modelConfig))
      failInvalidRequest('command.turnOverride.modelConfig must be an object.');
    assertExactKeys(
      value.modelConfig,
      MODEL_CONFIG_KEYS,
      'command.turnOverride.modelConfig',
    );
    if (
      value.modelConfig.thinkingLevel !== undefined &&
      (typeof value.modelConfig.thinkingLevel !== 'string' ||
        !isThinkingLevel(value.modelConfig.thinkingLevel))
    )
      failInvalidRequest(
        'command.turnOverride.modelConfig.thinkingLevel is unsupported.',
      );
    readOptionalBoolean(
      value.modelConfig.fastMode,
      'command.turnOverride.modelConfig.fastMode',
    );
    validateCodexSpeedFields(
      value.modelConfig,
      'command.turnOverride.modelConfig',
    );
  }
  readOptionalBoolean(value.planMode, 'command.turnOverride.planMode');
  if (value.approvalMode !== undefined && !isApprovalMode(value.approvalMode))
    failInvalidRequest('command.turnOverride.approvalMode is unsupported.');
  if (
    value.pluginSelections !== undefined &&
    !isChatTabPluginSelections(value.pluginSelections)
  )
    failInvalidRequest('command.turnOverride.pluginSelections is malformed.');
}

const AUTOMATION_DISPATCH_KEYS: ReadonlySet<string> = new Set([
  'version',
  'automationName',
  'executionContext',
  'presentation',
  'packageOverlay',
]);

/** The main-only automation send block's exact shape (CAN-4549). */
function validateAutomationDispatch(value: unknown): void {
  if (!isRecord(value) || value.version !== 1)
    failInvalidRequest('command.automationDispatch is malformed.');
  assertExactKeys(
    value,
    AUTOMATION_DISPATCH_KEYS,
    'command.automationDispatch',
  );
  readBoundedString(
    value.automationName,
    'command.automationDispatch.automationName',
    { allowEmpty: true },
  );
  if (value.executionContext !== undefined)
    readBoundedString(
      value.executionContext,
      'command.automationDispatch.executionContext',
    );
  if (
    value.presentation !== 'foreground' &&
    value.presentation !== 'background'
  )
    failInvalidRequest(
      'command.automationDispatch.presentation is unsupported.',
    );
  if (
    value.packageOverlay !== undefined &&
    (!isRecord(value.packageOverlay) ||
      typeof value.packageOverlay.packageDigest !== 'string' ||
      !Array.isArray(value.packageOverlay.resources))
  )
    failInvalidRequest(
      'command.automationDispatch.packageOverlay is malformed.',
    );
}

function validateCommand(
  command: JsonRecord,
  allowMainOnlyFields: boolean,
): ChatCommand {
  const type = command.type;
  if (typeof type !== 'string' || !isChatCommandType(type)) {
    failInvalidRequest('command.type is unsupported.');
  }
  const commandType = type;
  // Only main may order a durable approval-mode change against live runtimes.
  if (commandType === 'chat.set_approval_mode' && !allowMainOnlyFields) {
    failInvalidRequest('command.type chat.set_approval_mode is main-only.');
  }
  assertExactKeys(
    command,
    commandType === 'chat.send_message' && allowMainOnlyFields
      ? new Set([
          ...Array.from(COMMAND_KEYS[commandType]),
          'agentSent',
          'agentSenderProvenance',
          'hiddenContext',
          'agentSendSetup',
          'turnOverride',
          'automationDispatch',
        ])
      : commandType === 'chat.set_model' && allowMainOnlyFields
        ? new Set([
            ...Array.from(COMMAND_KEYS[commandType]),
            'preserveModelSelectionMode',
            'autoRoutedMessageId',
          ])
        : COMMAND_KEYS[commandType],
    'command',
  );

  const idFieldsByType: Partial<Record<ChatCommand['type'], string[]>> = {
    'chat.create_tab': ['tabId'],
    'chat.create_file_tab': ['tabId'],
    'chat.activate_tab': ['tabId'],
    'chat.close_tab': ['tabId'],
    'chat.patch_tab_settings': ['tabId'],
    'chat.set_model': ['tabId'],
    'chat.set_approval_mode': ['tabId'],
    'chat.mark_read': ['chatId'],
    'chat.mark_unread': ['chatId'],
    'chat.dismiss_attention': ['chatId'],
    'chat.send_message': ['chatId', 'userMessageId'],
    'chat.reject_plan_implementation_delivery': ['chatId', 'userMessageId'],
    'chat.commit_terminal_initial_prompt': [
      'chatId',
      'userMessageId',
      'turnTimerMessageId',
    ],
    'chat.edit_queued_message': ['chatId', 'queuedMessageId'],
    'chat.move_queued_message': ['chatId', 'queuedMessageId'],
    'chat.cancel_queued_message': ['chatId', 'queuedMessageId'],
    'chat.force_queued_message': ['chatId', 'queuedMessageId'],
    'chat.steer_queued_message': ['chatId', 'queuedMessageId'],
    'chat.set_queued_message_edit_lock': ['chatId', 'queuedMessageId'],
    'chat.input_delivery_action': ['chatId', 'rowId', 'action'],
    'chat.answer_question': ['chatId', 'questionId'],
    'chat.dismiss_question': ['chatId', 'questionId'],
    'chat.archive_tab': ['tabId'],
    'chat.restore_archive': ['archiveEntryId'],
    'chat.mark_archive_read': ['archiveEntryId'],
    'chat.fork_tab': ['sourceTabId', 'targetTabId'],
    'chat.reset_to_point': ['chatId', 'userMessageId'],
    'chat.import_session': ['targetChatId'],
    'chat.set_scheduled_send_draft': ['chatId'],
  };
  for (const field of idFieldsByType[commandType] ?? []) {
    readId(command[field], `command.${field}`);
  }
  for (const optionalId of [
    'targetTabId',
    'replacementTabId',
    'selectedRepoId',
  ]) {
    if (command[optionalId] !== undefined) {
      readId(command[optionalId], `command.${optionalId}`);
    }
  }
  for (const anchorId of ['atMessageId', 'blockId']) {
    if (command[anchorId] !== undefined) {
      readMessageAnchorId(command[anchorId], `command.${anchorId}`);
    }
  }
  if (commandType === 'chat.reorder_tabs') {
    readIdArray(command.tabIds, 'command.tabIds');
  }
  // A null anchor moves the entry to the tail; absence is not a tail move.
  if (
    commandType === 'chat.move_queued_message' &&
    command.beforeQueuedMessageId !== null
  ) {
    readId(command.beforeQueuedMessageId, 'command.beforeQueuedMessageId');
  }
  if (
    command.queuedMessageRevision !== undefined &&
    (!Number.isSafeInteger(command.queuedMessageRevision) ||
      Number(command.queuedMessageRevision) < 1)
  )
    failInvalidRequest(
      'command.queuedMessageRevision must be a positive integer.',
    );
  if (commandType === 'chat.set_queued_message_edit_lock') {
    if (typeof command.locked !== 'boolean')
      failInvalidRequest('command.locked must be a boolean.');
    if (command.acquisitionId !== undefined)
      readId(command.acquisitionId, 'command.acquisitionId');
  }
  if (
    commandType === 'chat.set_approval_mode' &&
    !isApprovalMode(command.approvalMode)
  ) {
    failInvalidRequest('command.approvalMode is unsupported.');
  }
  if (commandType === 'chat.input_delivery_action') {
    if (
      !Number.isSafeInteger(command.rowRevision) ||
      Number(command.rowRevision) < 1
    )
      failInvalidRequest('command.rowRevision must be a positive integer.');
    if (
      ![
        'cancel',
        'queue',
        'edit',
        'save-draft',
        'save',
        'resend',
        'resend-original',
        'dismiss',
        'close-editor',
      ].includes(String(command.action))
    )
      failInvalidRequest('Unknown input delivery action.');
    if (command.text !== undefined && typeof command.text !== 'string')
      failInvalidRequest('command.text must be text.');
  }
  if (commandType === 'chat.close_tabs') {
    if (!Array.isArray(command.targets) || command.targets.length === 0) {
      failInvalidRequest('command.targets must be a nonempty array.');
    }
    if (command.targets.length > 1_000) {
      failInvalidRequest('command.targets contains too many entries.');
    }
    command.targets.forEach((target, index) => {
      if (!isRecord(target)) {
        failInvalidRequest(
          `command.targets[${String(index)}] must be an object.`,
        );
      }
      assertExactKeys(
        target,
        new Set(['tabId', 'mode']),
        `command.targets[${String(index)}]`,
      );
      readId(target.tabId, `command.targets[${String(index)}].tabId`);
      if (
        target.mode !== 'archive' &&
        target.mode !== 'discard_empty' &&
        target.mode !== 'discard'
      ) {
        failInvalidRequest(
          `command.targets[${String(index)}].mode is unsupported.`,
        );
      }
    });
  }
  if (
    (commandType === 'chat.close_tab' || commandType === 'chat.close_tabs') &&
    command.replacementTab !== undefined
  ) {
    if (!isRecord(command.replacementTab)) {
      failInvalidRequest('command.replacementTab must be an object.');
    }
    const replacementTab = validateCommand(
      command.replacementTab,
      allowMainOnlyFields,
    );
    if (replacementTab.type !== 'chat.create_tab') {
      failInvalidRequest(
        'command.replacementTab must be a chat.create_tab command.',
      );
    }
    if (
      command.replacementTabId !== undefined &&
      command.replacementTabId !== replacementTab.tabId
    ) {
      failInvalidRequest(
        'command.replacementTabId must match command.replacementTab.tabId.',
      );
    }
  }
  if (commandType === 'chat.create_tab') {
    if (command.seedTab !== undefined) {
      validateSeededChatTab(
        command.seedTab,
        readId(command.tabId, 'command.tabId'),
        allowMainOnlyFields,
      );
    }
    if (command.title !== undefined) {
      readBoundedString(command.title, 'command.title', { allowEmpty: true });
    }
    if (
      command.providerType !== undefined &&
      command.providerType !== 'claude' &&
      command.providerType !== 'codex' &&
      command.providerType !== 'ollama' &&
      command.providerType !== 'cursor' &&
      command.providerType !== 'copilot' &&
      command.providerType !== 'antigravity' &&
      command.providerType !== 'opencode'
    ) {
      failInvalidRequest('command.providerType is unsupported.');
    }
    if (command.model !== undefined) {
      readBoundedString(command.model, 'command.model');
    }
    if (command.defaultStampModel !== undefined) {
      readBoundedString(command.defaultStampModel, 'command.defaultStampModel');
    }
    if (command.modelConfig !== undefined) {
      if (!isRecord(command.modelConfig)) {
        failInvalidRequest('command.modelConfig must be an object.');
      }
      assertExactKeys(
        command.modelConfig,
        MODEL_CONFIG_KEYS,
        'command.modelConfig',
      );
      if (
        command.modelConfig.thinkingLevel !== undefined &&
        (typeof command.modelConfig.thinkingLevel !== 'string' ||
          !isThinkingLevel(command.modelConfig.thinkingLevel))
      ) {
        failInvalidRequest('command.modelConfig.thinkingLevel is unsupported.');
      }
      readOptionalBoolean(
        command.modelConfig.fastMode,
        'command.modelConfig.fastMode',
      );
      validateCodexSpeedFields(command.modelConfig, 'command.modelConfig');
    }
    readOptionalBoolean(command.planMode, 'command.planMode');
    readOptionalBoolean(command.starter, 'command.starter');
    if (
      command.proposalMode !== undefined &&
      command.proposalMode !== 'optional' &&
      command.proposalMode !== 'required'
    ) {
      failInvalidRequest('command.proposalMode is unsupported.');
    }
    if (
      command.pluginSelections !== undefined &&
      !isChatTabPluginSelections(command.pluginSelections)
    ) {
      failInvalidRequest('command.pluginSelections is malformed.');
    }
    readOptionalBoolean(
      command.deferredToolsAllowed,
      'command.deferredToolsAllowed',
    );
    readOptionalBoolean(
      command.subscriptionBillingOverride,
      'command.subscriptionBillingOverride',
    );
    if (command.aiCreditsRouting !== undefined) {
      validateAiCreditsRouting(
        command.aiCreditsRouting,
        'command.aiCreditsRouting',
      );
    }
    if (
      command.interfaceMode !== undefined &&
      command.interfaceMode !== 'canopy' &&
      command.interfaceMode !== 'claude-code' &&
      command.interfaceMode !== 'auto'
    ) {
      failInvalidRequest('command.interfaceMode is unsupported.');
    }
    if (
      command.approvalMode !== undefined &&
      !isApprovalMode(command.approvalMode)
    ) {
      failInvalidRequest('command.approvalMode is unsupported.');
    }
  }
  if (
    commandType === 'chat.send_message' ||
    commandType === 'chat.edit_queued_message' ||
    commandType === 'chat.commit_terminal_initial_prompt'
  ) {
    readBoundedString(command.text, 'command.text', { allowEmpty: true });
    if (
      command.inputMode !== undefined &&
      command.inputMode !== 'typed' &&
      command.inputMode !== 'voice'
    ) {
      failInvalidRequest('command.inputMode is unsupported.');
    }
    validateAttachmentMetadata(command);
  }
  if (commandType === 'chat.commit_terminal_initial_prompt') {
    if (command.pendingSystemInstructionIds !== undefined) {
      readOpaqueInstructionIdArray(
        command.pendingSystemInstructionIds,
        'command.pendingSystemInstructionIds',
      );
    }
    if (command.watcherFired !== undefined) {
      if (!isRecord(command.watcherFired)) {
        failInvalidRequest('command.watcherFired must be an object.');
      }
      assertExactKeys(
        command.watcherFired,
        new Set(['kind']),
        'command.watcherFired',
      );
      readBoundedString(command.watcherFired.kind, 'command.watcherFired.kind');
    }
  }
  if (commandType === 'chat.send_message') {
    if (command.trackedPlanImplementation !== undefined) {
      const parsed = TrackedPlanImplementationInputSchema.safeParse(
        command.trackedPlanImplementation,
      );
      if (
        !parsed.success ||
        parsed.data.userMessageId !== command.userMessageId
      )
        failInvalidRequest(
          'command.trackedPlanImplementation must identify the sent message.',
        );
    }
    if (
      command.planReviewApproval !== undefined &&
      !ChatPlanReviewApprovalSchema.safeParse(command.planReviewApproval)
        .success
    ) {
      failInvalidRequest(
        'command.planReviewApproval must identify a current plan revision.',
      );
    }

    if (allowMainOnlyFields) {
      const hasMetadata =
        command.agentSent !== undefined ||
        command.agentSenderProvenance !== undefined ||
        command.hiddenContext !== undefined;
      if (hasMetadata) {
        const sent = parseChatAgentSentInfo(command.agentSent);
        const evidence = parseAgentSenderProvenance(
          command.agentSenderProvenance,
        );
        if (
          !sent ||
          !evidence ||
          evidence.acceptedInputId !== command.userMessageId ||
          !isRecord(command.hiddenContext) ||
          command.hiddenContext.kind !== 'agent-sender-context' ||
          typeof command.hiddenContext.text !== 'string' ||
          !command.hiddenContext.text.trim()
        )
          failInvalidRequest(
            'Main send attribution must contain the complete trusted metadata trio.',
          );
        assertExactKeys(
          command.hiddenContext,
          new Set(['kind', 'text']),
          'command.hiddenContext',
        );
      }
      if (command.turnOverride !== undefined) {
        // Only a pipeline send may carry per-turn settings (D2).
        if (
          !hasMetadata ||
          parseChatAgentSentInfo(command.agentSent)?.sender.kind !==
            'pipeline' ||
          parseAgentSenderProvenance(command.agentSenderProvenance)?.sender
            .kind !== 'pipeline'
        )
          failInvalidRequest(
            'A turn override needs pipeline send attribution.',
          );
        validateTurnOverride(command.turnOverride);
      }
      if (command.automationDispatch !== undefined) {
        // An automation's own send (CAN-4549), or a step in a run an
        // automation started (CAN-4551): the sender names the automation.
        const sent = parseChatAgentSentInfo(command.agentSent)?.sender;
        const evidence = parseAgentSenderProvenance(
          command.agentSenderProvenance,
        )?.sender;
        if (
          !hasMetadata ||
          sent?.kind !== 'pipeline' ||
          sent.automationId === undefined ||
          evidence?.kind !== 'pipeline' ||
          evidence.automationId !== sent.automationId ||
          evidence.executionId !== sent.executionId
        )
          failInvalidRequest(
            'An automation dispatch needs automation send attribution.',
          );
        validateAutomationDispatch(command.automationDispatch);
      }
      if (command.agentSendSetup !== undefined) {
        if (
          !hasMetadata ||
          !isRecord(command.agentSendSetup) ||
          command.agentSendSetup.version !== 1 ||
          (command.agentSendSetup.startedChat !== undefined &&
            command.agentSendSetup.startedChat !== true)
        )
          failInvalidRequest('Invalid main setup queue marker.');
        assertExactKeys(
          command.agentSendSetup,
          new Set(['version', 'startedChat']),
          'command.agentSendSetup',
        );
      }
    }
    readOptionalBoolean(command.planMode, 'command.planMode');
    if (
      command.codexProposalMode !== undefined &&
      command.codexProposalMode !== 'optional' &&
      command.codexProposalMode !== 'required'
    ) {
      failInvalidRequest('command.codexProposalMode is unsupported.');
    }
    if (command.modelConfig !== undefined) {
      if (!isRecord(command.modelConfig)) {
        failInvalidRequest('command.modelConfig must be an object.');
      }
      assertExactKeys(
        command.modelConfig,
        MODEL_CONFIG_KEYS,
        'command.modelConfig',
      );
      if (
        command.modelConfig.thinkingLevel !== undefined &&
        (typeof command.modelConfig.thinkingLevel !== 'string' ||
          !isThinkingLevel(command.modelConfig.thinkingLevel))
      ) {
        failInvalidRequest('command.modelConfig.thinkingLevel is unsupported.');
      }
      readOptionalBoolean(
        command.modelConfig.fastMode,
        'command.modelConfig.fastMode',
      );
      validateCodexSpeedFields(command.modelConfig, 'command.modelConfig');
    }
  }
  if (commandType === 'chat.create_file_tab') {
    // Empty is a deliberate state: an empty file tab created from the add-panel
    // menu persists with `filePath: ''` until a file is assigned via
    // chat.patch_tab_settings.
    readBoundedString(command.filePath, 'command.filePath', {
      allowEmpty: true,
    });
    if (
      command.viewMode !== undefined &&
      command.viewMode !== 'raw' &&
      command.viewMode !== 'preview' &&
      command.viewMode !== 'table' &&
      command.viewMode !== 'diff'
    ) {
      failInvalidRequest('command.viewMode is unsupported.');
    }
    readOptionalBoolean(command.pinned, 'command.pinned');
    readOptionalBoolean(command.activate, 'command.activate');
  }
  if (commandType === 'chat.patch_tab_settings') {
    if (command.expectedPendingPlanExitRequestId !== undefined) {
      readId(
        command.expectedPendingPlanExitRequestId,
        'command.expectedPendingPlanExitRequestId',
      );
    }
    if (!isRecord(command.patch)) {
      failInvalidRequest('command.patch must be an object.');
    }
    assertExactKeys(
      command.patch,
      allowMainOnlyFields ? MAIN_PATCH_KEYS : PATCH_KEYS,
      'command.patch',
    );
    if (
      command.patch.customTitle !== undefined &&
      command.patch.customTitle !== null
    ) {
      const customTitle = readBoundedString(
        command.patch.customTitle,
        'command.patch.customTitle',
        {
          maxLength: CHAT_CUSTOM_TITLE_MAX_LENGTH,
        },
      );
      if (customTitle.trim() !== customTitle) {
        failInvalidRequest(
          'command.patch.customTitle must already be trimmed.',
        );
      }
    }
    if (allowMainOnlyFields) {
      if (
        command.patch.description !== undefined &&
        typeof command.patch.description !== 'string'
      ) {
        failInvalidRequest('command.patch.description must be a string.');
      }
      if (
        command.patch.pendingRevertAttachmentPath !== undefined &&
        command.patch.pendingRevertAttachmentPath !== null
      ) {
        failInvalidRequest(
          'command.patch.pendingRevertAttachmentPath must be null.',
        );
      }
      if (
        command.patch.newChatStartedWatcherPending !== undefined &&
        command.patch.newChatStartedWatcherPending !== null
      ) {
        readOptionalBoolean(
          command.patch.newChatStartedWatcherPending,
          'command.patch.newChatStartedWatcherPending',
        );
      }
      if (
        command.patch.newChatStartedWatcherFiredAt !== undefined &&
        command.patch.newChatStartedWatcherFiredAt !== null &&
        typeof command.patch.newChatStartedWatcherFiredAt !== 'string'
      ) {
        failInvalidRequest(
          'command.patch.newChatStartedWatcherFiredAt must be a string or null.',
        );
      }
    }
    // Auto is a selection MODE, not a model: `'auto'` enters it and an
    // explicit `null` returns the chat to manual. Any other value would
    // otherwise be written verbatim onto the canonical tab.
    if (
      command.patch.modelSelectionMode !== undefined &&
      command.patch.modelSelectionMode !== null &&
      command.patch.modelSelectionMode !== 'auto'
    ) {
      failInvalidRequest('command.patch.modelSelectionMode is unsupported.');
    }
    if (
      command.patch.providerType !== undefined &&
      command.patch.providerType !== 'claude' &&
      command.patch.providerType !== 'codex' &&
      command.patch.providerType !== 'ollama' &&
      command.patch.providerType !== 'cursor' &&
      command.patch.providerType !== 'copilot' &&
      command.patch.providerType !== 'antigravity' &&
      command.patch.providerType !== 'opencode'
    ) {
      failInvalidRequest('command.patch.providerType is unsupported.');
    }
    if (command.patch.model !== undefined) {
      readBoundedString(command.patch.model, 'command.patch.model');
    }
    readOptionalBoolean(
      command.patch.modelExplicitlyChosen,
      'command.patch.modelExplicitlyChosen',
    );
    readOptionalBoolean(
      command.patch.billingExplicitlyChosen,
      'command.patch.billingExplicitlyChosen',
    );
    if (
      command.patch.autoArchive !== undefined &&
      command.patch.autoArchive !== null
    ) {
      readOptionalBoolean(
        command.patch.autoArchive,
        'command.patch.autoArchive',
      );
    }
    if (
      command.patch.sdkSessionId !== undefined &&
      command.patch.sdkSessionId !== null
    ) {
      readBoundedString(
        command.patch.sdkSessionId,
        'command.patch.sdkSessionId',
      );
    }
    if (command.patch.globalInstructionsSnapshot !== undefined) {
      readBoundedString(
        command.patch.globalInstructionsSnapshot,
        'command.patch.globalInstructionsSnapshot',
        { allowEmpty: true },
      );
    }
    if (
      command.patch.pluginSelections !== undefined &&
      !isChatTabPluginSelections(command.patch.pluginSelections)
    ) {
      failInvalidRequest('command.patch.pluginSelections is malformed.');
    }
    if (
      command.patch.selectedRepoId !== undefined &&
      command.patch.selectedRepoId !== null
    ) {
      readId(command.patch.selectedRepoId, 'command.patch.selectedRepoId');
    }
    if (
      command.patch.aiCreditsRouting !== undefined &&
      command.patch.aiCreditsRouting !== null
    ) {
      validateAiCreditsRouting(
        command.patch.aiCreditsRouting,
        'command.patch.aiCreditsRouting',
      );
    }
    if (
      command.patch.scheduledSendDraft !== undefined &&
      command.patch.scheduledSendDraft !== null
    ) {
      if (!isRecord(command.patch.scheduledSendDraft)) {
        failInvalidRequest(
          'command.patch.scheduledSendDraft must be an object or null.',
        );
      }
      assertExactKeys(
        command.patch.scheduledSendDraft,
        new Set(['runAt']),
        'command.patch.scheduledSendDraft',
      );
      readBoundedString(
        command.patch.scheduledSendDraft.runAt,
        'command.patch.scheduledSendDraft.runAt',
      );
    }
    for (const field of [
      'unread',
      'planMode',
      'deferredToolsAllowed',
      'subscriptionBillingOverride',
      'codexFastModeEnabled',
      'hasOutstandingProposal',
      'pinned',
    ]) {
      if (field === 'codexFastModeEnabled' && command.patch[field] === null)
        continue;
      readOptionalBoolean(command.patch[field], `command.patch.${field}`);
    }
    if (
      command.patch.fileViewMode !== undefined &&
      command.patch.fileViewMode !== null &&
      command.patch.fileViewMode !== 'raw' &&
      command.patch.fileViewMode !== 'preview' &&
      command.patch.fileViewMode !== 'table' &&
      command.patch.fileViewMode !== 'diff'
    ) {
      failInvalidRequest('command.patch.fileViewMode is unsupported.');
    }
    if (
      command.patch.fileDiffContext !== undefined &&
      !isFileDiffContext(command.patch.fileDiffContext)
    ) {
      failInvalidRequest('command.patch.fileDiffContext is invalid.');
    }
    if (command.patch.filePath !== undefined) {
      readBoundedString(command.patch.filePath, 'command.patch.filePath');
    }
    if (command.patch.title !== undefined) {
      readBoundedString(command.patch.title, 'command.patch.title');
    }
    if (
      command.patch.proposalMode !== undefined &&
      command.patch.proposalMode !== 'optional' &&
      command.patch.proposalMode !== 'required'
    ) {
      failInvalidRequest('command.patch.proposalMode is unsupported.');
    }
    if (command.patch.modelConfig !== undefined) {
      if (!isRecord(command.patch.modelConfig)) {
        failInvalidRequest('command.patch.modelConfig must be an object.');
      }
      assertExactKeys(
        command.patch.modelConfig,
        MODEL_CONFIG_KEYS,
        'command.patch.modelConfig',
      );
      readOptionalBoolean(
        command.patch.modelConfig.fastMode,
        'command.patch.modelConfig.fastMode',
      );
      validateCodexSpeedFields(
        command.patch.modelConfig,
        'command.patch.modelConfig',
      );
      if (
        command.patch.modelConfig.thinkingLevel !== undefined &&
        (typeof command.patch.modelConfig.thinkingLevel !== 'string' ||
          !isThinkingLevel(command.patch.modelConfig.thinkingLevel))
      ) {
        failInvalidRequest(
          'command.patch.modelConfig.thinkingLevel is unsupported.',
        );
      }
    }
    if (
      command.patch.thinkingLevel !== undefined &&
      (typeof command.patch.thinkingLevel !== 'string' ||
        !isThinkingLevel(command.patch.thinkingLevel))
    ) {
      failInvalidRequest('command.patch.thinkingLevel is unsupported.');
    }
    if (
      command.patch.interfaceMode !== undefined &&
      command.patch.interfaceMode !== null &&
      command.patch.interfaceMode !== 'canopy' &&
      command.patch.interfaceMode !== 'claude-code' &&
      command.patch.interfaceMode !== 'auto'
    ) {
      failInvalidRequest('command.patch.interfaceMode is unsupported.');
    }
    if (
      command.patch.pendingPlanExit !== undefined &&
      command.patch.pendingPlanExit !== null &&
      !isRecord(command.patch.pendingPlanExit)
    ) {
      failInvalidRequest(
        'command.patch.pendingPlanExit must be an object or null.',
      );
    }
    if (isRecord(command.patch.pendingPlanExit)) {
      assertJsonValue(
        command.patch.pendingPlanExit,
        'command.patch.pendingPlanExit',
        new Set(),
      );
    }
    if (
      command.patch.pendingPlanExitRequestId !== undefined &&
      command.patch.pendingPlanExitRequestId !== null
    ) {
      readId(
        command.patch.pendingPlanExitRequestId,
        'command.patch.pendingPlanExitRequestId',
      );
    }
    if (
      command.patch.trackedPlanImplementation !== undefined &&
      command.patch.trackedPlanImplementation !== null &&
      !TrackedPlanImplementationInputSchema.safeParse(
        command.patch.trackedPlanImplementation,
      ).success
    )
      failInvalidRequest(
        'command.patch.trackedPlanImplementation must contain only attempt identity.',
      );
    const trackedPlanId = command.patch.trackedPlanId;
    if (trackedPlanId !== undefined && trackedPlanId !== null) {
      readBoundedString(trackedPlanId, 'command.patch.trackedPlanId');
    }
    const trackedPlanSource = command.patch.trackedPlanSource;
    if (
      trackedPlanSource !== undefined &&
      trackedPlanSource !== null &&
      (typeof trackedPlanSource !== 'string' ||
        ![
          'claude',
          'codex',
          'ollama',
          'cursor',
          'copilot',
          'antigravity',
          'opencode',
          'pipeline',
          'imported',
          'detected',
        ].includes(trackedPlanSource))
    ) {
      failInvalidRequest('command.patch.trackedPlanSource is unsupported.');
    }
    const trackedPlanReviewStatus = command.patch.trackedPlanReviewStatus;
    if (
      trackedPlanReviewStatus !== undefined &&
      trackedPlanReviewStatus !== null &&
      (typeof trackedPlanReviewStatus !== 'string' ||
        !['pending', 'approved', 'dismissed'].includes(trackedPlanReviewStatus))
    ) {
      failInvalidRequest(
        'command.patch.trackedPlanReviewStatus is unsupported.',
      );
    }
    const latestRevisionNumber = command.patch.latestRevisionNumber;
    if (
      latestRevisionNumber !== undefined &&
      latestRevisionNumber !== null &&
      (typeof latestRevisionNumber !== 'number' ||
        !Number.isInteger(latestRevisionNumber) ||
        latestRevisionNumber < 0)
    ) {
      failInvalidRequest(
        'command.patch.latestRevisionNumber must be a non-negative integer or null.',
      );
    }
    const attentionDismissedAt = command.patch.attentionDismissedAt;
    if (
      attentionDismissedAt !== undefined &&
      attentionDismissedAt !== null &&
      (typeof attentionDismissedAt !== 'number' ||
        !Number.isFinite(attentionDismissedAt) ||
        attentionDismissedAt < 0)
    ) {
      failInvalidRequest(
        'command.patch.attentionDismissedAt must be a non-negative number or null.',
      );
    }
    if (
      command.patch.pendingSystemInstructions !== undefined &&
      command.patch.pendingSystemInstructions !== null &&
      (!Array.isArray(command.patch.pendingSystemInstructions) ||
        command.patch.pendingSystemInstructions.some(
          (instruction) =>
            !isRecord(instruction) ||
            Object.keys(instruction).some(
              (key) => key !== 'id' && key !== 'text',
            ) ||
            typeof instruction.id !== 'string' ||
            instruction.id.length === 0 ||
            instruction.id.length > MAX_ID_LENGTH ||
            typeof instruction.text !== 'string' ||
            instruction.text.length > MAX_TEXT_LENGTH,
        ))
    ) {
      failInvalidRequest('command.patch.pendingSystemInstructions is invalid.');
    }
    if (command.patch.sharedRun !== undefined) {
      if (command.patch.sharedRun !== null) {
        if (!isRecord(command.patch.sharedRun)) {
          failInvalidRequest(
            'command.patch.sharedRun must be an object or null.',
          );
        }
        assertExactKeys(
          command.patch.sharedRun,
          new Set([
            'externalId',
            'teamId',
            'teamName',
            'organizationId',
            'organizationName',
            'shareScope',
            'sharedAt',
            'commentRevision',
            'unreadCommentCount',
          ]),
          'command.patch.sharedRun',
        );
        readBoundedString(
          command.patch.sharedRun.externalId,
          'command.patch.sharedRun.externalId',
        );
        readBoundedString(
          command.patch.sharedRun.sharedAt,
          'command.patch.sharedRun.sharedAt',
        );
        if (
          command.patch.sharedRun.shareScope !== 'private' &&
          command.patch.sharedRun.shareScope !== 'team' &&
          command.patch.sharedRun.shareScope !== 'organization'
        ) {
          failInvalidRequest(
            'command.patch.sharedRun.shareScope is unsupported.',
          );
        }
        const optionalStringFields: Array<readonly [string, unknown]> = [
          ['teamId', command.patch.sharedRun.teamId],
          ['teamName', command.patch.sharedRun.teamName],
          ['organizationId', command.patch.sharedRun.organizationId],
          ['organizationName', command.patch.sharedRun.organizationName],
        ];
        for (const [field, value] of optionalStringFields) {
          if (value !== undefined) {
            readBoundedString(value, `command.patch.sharedRun.${field}`);
          }
        }
        for (const field of [
          'commentRevision',
          'unreadCommentCount',
        ] as const) {
          const value = command.patch.sharedRun[field];
          if (
            value !== undefined &&
            (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
          ) {
            failInvalidRequest(
              `command.patch.sharedRun.${field} must be a non-negative integer.`,
            );
          }
        }
      }
    }
    if (command.patch.agentArtifactCarryByTurn !== undefined) {
      if (
        command.patch.agentArtifactCarryByTurn !== null &&
        !isRecord(command.patch.agentArtifactCarryByTurn)
      ) {
        failInvalidRequest(
          'command.patch.agentArtifactCarryByTurn must be an object or null.',
        );
      }
      assertJsonValue(
        command.patch.agentArtifactCarryByTurn,
        'command.patch.agentArtifactCarryByTurn',
        new Set(),
      );
      if (isRecord(command.patch.agentArtifactCarryByTurn)) {
        for (const [turnId, receipts] of Object.entries(
          command.patch.agentArtifactCarryByTurn,
        )) {
          readMessageAnchorId(
            turnId,
            'command.patch.agentArtifactCarryByTurn turn id',
          );
          if (
            !Array.isArray(receipts) ||
            receipts.length > MAX_ARRAY_ENTRIES ||
            receipts.some((receipt) => {
              const serialized = serializeAgentArtifactReceipt(receipt);
              return (
                serialized === null ||
                (serialized.kind !== 'pipeline_run' &&
                  serialized.kind !== 'github_workflow_run') ||
                !isDeepStrictEqual(serialized, receipt)
              );
            })
          ) {
            failInvalidRequest(
              'command.patch.agentArtifactCarryByTurn is malformed.',
            );
          }
        }
      }
    }
  }
  if (commandType === 'chat.set_model') {
    readBoundedString(command.model, 'command.model');
    if (
      command.preserveModelSelectionMode !== undefined &&
      command.preserveModelSelectionMode !== true
    ) {
      failInvalidRequest('command.preserveModelSelectionMode must be true.');
    }
    if (command.autoRoutedMessageId !== undefined) {
      readId(command.autoRoutedMessageId, 'command.autoRoutedMessageId');
    }
    if (
      command.providerType !== 'claude' &&
      command.providerType !== 'codex' &&
      command.providerType !== 'ollama' &&
      command.providerType !== 'cursor' &&
      command.providerType !== 'copilot' &&
      command.providerType !== 'antigravity' &&
      command.providerType !== 'opencode'
    ) {
      failInvalidRequest('command.providerType is unsupported.');
    }
    if (
      command.executionHarness !== undefined &&
      command.executionHarness !== 'claude' &&
      command.executionHarness !== 'codex' &&
      command.executionHarness !== 'cursor' &&
      command.executionHarness !== 'copilot' &&
      command.executionHarness !== 'antigravity' &&
      command.executionHarness !== 'opencode'
    ) {
      failInvalidRequest('command.executionHarness is unsupported.');
    }
    if (command.settings !== undefined) {
      if (!isRecord(command.settings)) {
        failInvalidRequest('command.settings must be an object.');
      }
      assertExactKeys(
        command.settings,
        new Set([
          'thinkingLevel',
          'modelConfig',
          'codexFastModeEnabled',
          'interfaceMode',
        ]),
        'command.settings',
      );
      if (
        typeof command.settings.thinkingLevel !== 'string' ||
        !isThinkingLevel(command.settings.thinkingLevel)
      ) {
        failInvalidRequest('command.settings.thinkingLevel is unsupported.');
      }
      if (!isRecord(command.settings.modelConfig)) {
        failInvalidRequest('command.settings.modelConfig must be an object.');
      }
      assertExactKeys(
        command.settings.modelConfig,
        MODEL_CONFIG_KEYS,
        'command.settings.modelConfig',
      );
      if (
        typeof command.settings.modelConfig.thinkingLevel !== 'string' ||
        !isThinkingLevel(command.settings.modelConfig.thinkingLevel)
      ) {
        failInvalidRequest(
          'command.settings.modelConfig.thinkingLevel is unsupported.',
        );
      }
      if (typeof command.settings.modelConfig.fastMode !== 'boolean') {
        failInvalidRequest(
          'command.settings.modelConfig.fastMode must be a boolean.',
        );
      }
      if (typeof command.settings.codexFastModeEnabled !== 'boolean') {
        failInvalidRequest(
          'command.settings.codexFastModeEnabled must be a boolean.',
        );
      }
      validateCodexSpeedFields(
        command.settings.modelConfig,
        'command.settings.modelConfig',
      );
      const settingsSpeed = command.settings.modelConfig.speed;
      if (
        isCodexSpeed(settingsSpeed) &&
        command.settings.codexFastModeEnabled !==
          codexSpeedFastMode(settingsSpeed)
      ) {
        failInvalidRequest(
          'command.settings.codexFastModeEnabled contradicts command.settings.modelConfig.speed.',
        );
      }
      if (
        command.settings.interfaceMode !== null &&
        command.settings.interfaceMode !== 'canopy' &&
        command.settings.interfaceMode !== 'claude-code' &&
        command.settings.interfaceMode !== 'auto'
      ) {
        failInvalidRequest('command.settings.interfaceMode is unsupported.');
      }
    }
    if (command.notice !== undefined) {
      if (!isRecord(command.notice)) {
        failInvalidRequest('command.notice must be an object.');
      }
      assertExactKeys(
        command.notice,
        new Set(['id', 'timestamp', 'text']),
        'command.notice',
      );
      readId(command.notice.id, 'command.notice.id');
      if (
        typeof command.notice.timestamp !== 'number' ||
        !Number.isFinite(command.notice.timestamp)
      ) {
        failInvalidRequest('command.notice.timestamp must be finite.');
      }
      readBoundedString(command.notice.text, 'command.notice.text');
    }
  }
  if (commandType === 'chat.close_tab') {
    if (
      command.mode !== 'archive' &&
      command.mode !== 'discard_empty' &&
      command.mode !== 'discard'
    ) {
      failInvalidRequest('command.mode is unsupported.');
    }
  }
  if (commandType === 'chat.mark_unread') {
    if (command.manual !== undefined && command.manual !== true) {
      failInvalidRequest('command.manual must be true when present.');
    }
  }
  if (commandType === 'chat.dismiss_attention') {
    if (command.attentionVersion !== undefined) {
      readRevision(command.attentionVersion, 'command.attentionVersion');
    }
  }
  if (commandType === 'chat.answer_question') {
    if (!Array.isArray(command.answers)) {
      failInvalidRequest('command.answers must be an array.');
    }
    command.answers.forEach((answer, index) => {
      if (!isRecord(answer)) {
        failInvalidRequest(`command.answers[${String(index)}] is invalid.`);
      }
      assertExactKeys(
        answer,
        new Set(['questionId', 'question', 'selectedOptions', 'freeformText']),
        `command.answers[${String(index)}]`,
      );
      readBoundedString(
        answer.question,
        `command.answers[${String(index)}].question`,
      );
      if (answer.questionId !== undefined) {
        readBoundedString(
          answer.questionId,
          `command.answers[${String(index)}].questionId`,
        );
      }
      readBoundedStringArray(
        answer.selectedOptions,
        `command.answers[${String(index)}].selectedOptions`,
      );
      if (answer.freeformText !== undefined) {
        readBoundedString(
          answer.freeformText,
          `command.answers[${String(index)}].freeformText`,
          { allowEmpty: true },
        );
      }
    });
  }
  if (commandType === 'chat.archive_tab') {
    readOptionalBoolean(command.unread, 'command.unread');
    readOptionalBoolean(command.keepSession, 'command.keepSession');
  }
  if (commandType === 'chat.fork_tab') {
    if (
      command.cloneMode !== undefined &&
      command.cloneMode !== 'continuation'
    ) {
      failInvalidRequest('command.cloneMode is unsupported.');
    }
    if (command.destinationTab !== undefined) {
      const destinationTab = command.destinationTab;
      if (!isPersistedChatTab(destinationTab))
        failInvalidRequest(
          'command.destinationTab must be a valid persisted chat tab.',
        );
      validateSeededChatTab(
        destinationTab,
        String(command.targetTabId),
        allowMainOnlyFields,
      );
      if (destinationTab.messages.length !== 0)
        failInvalidRequest('command.destinationTab.messages must be empty.');
    }
    if (command.sourceSdkSessionId !== undefined) {
      readBoundedString(
        command.sourceSdkSessionId,
        'command.sourceSdkSessionId',
      );
    }
    if (command.syncWarning !== undefined) {
      readBoundedString(command.syncWarning, 'command.syncWarning');
    }
  }
  if (commandType === 'chat.mark_archive_read') {
    if (typeof command.unread !== 'boolean') {
      failInvalidRequest('command.unread must be a boolean.');
    }
  }
  if (commandType === 'chat.import_session') {
    if (!isRecord(command.source)) {
      failInvalidRequest('command.source must be an object.');
    }
    if (command.source.kind === 'session_export') {
      assertExactKeys(
        command.source,
        new Set(['kind', 'exportId']),
        'command.source',
      );
      readId(command.source.exportId, 'command.source.exportId');
    } else if (command.source.kind === 'transcript') {
      assertExactKeys(
        command.source,
        new Set(['kind', 'providerType', 'content']),
        'command.source',
      );
      readBoundedString(command.source.content, 'command.source.content', {
        allowEmpty: true,
      });
      if (
        command.source.providerType !== 'claude' &&
        command.source.providerType !== 'codex' &&
        command.source.providerType !== 'ollama' &&
        command.source.providerType !== 'cursor' &&
        command.source.providerType !== 'copilot' &&
        command.source.providerType !== 'antigravity' &&
        command.source.providerType !== 'opencode'
      ) {
        failInvalidRequest('command.source.providerType is unsupported.');
      }
    } else {
      failInvalidRequest('command.source.kind is unsupported.');
    }
  }
  if (commandType === 'chat.set_scheduled_send_draft') {
    readOptionalBoolean(
      command.clearPendingRevertAttachment,
      'command.clearPendingRevertAttachment',
    );
    if (command.draft !== null) {
      if (!isRecord(command.draft)) {
        failInvalidRequest('command.draft must be an object or null.');
      }
      assertExactKeys(command.draft, new Set(['runAt']), 'command.draft');
      readBoundedString(command.draft.runAt, 'command.draft.runAt');
    }
  }
  // Every variant-specific field has been checked above; re-run the
  // discriminator guard as a type predicate so the validated record can be
  // returned without asserting through `unknown`.
  if (!isValidatedChatCommand(command)) {
    failInvalidRequest('command.type is unsupported.');
  }
  return command;
}

export function validateChatGetStateRequest(
  value: unknown,
): ChatGetStateRequest {
  if (!isRecord(value)) {
    failInvalidRequest('Chat state request must be an object.');
  }
  assertExactKeys(value, new Set(['projectId', 'worktreeId']), 'request');
  return {
    projectId: readScopeId(value.projectId, 'projectId'),
    worktreeId: readScopeId(value.worktreeId, 'worktreeId'),
  };
}

/** Validate a window's declaration of the chat scopes it tracks. */
export function validateChatStateScopesDeclaration(
  value: unknown,
): ChatStateScopesDeclaration {
  if (!isRecord(value)) {
    failInvalidRequest('Chat state scope declaration must be an object.');
  }
  if (value.kind === 'all') {
    assertExactKeys(value, new Set(['kind']), 'declaration');
    return { kind: 'all' };
  }
  if (value.kind !== 'scopes') {
    failInvalidRequest('Unsupported chat state scope declaration.');
  }
  assertExactKeys(value, new Set(['kind', 'scopes']), 'declaration');
  if (!Array.isArray(value.scopes)) {
    failInvalidRequest('Declared chat state scopes must be an array.');
  }
  if (value.scopes.length > MAX_DECLARED_CHAT_STATE_SCOPES) {
    failInvalidRequest('Too many declared chat state scopes.');
  }
  return {
    kind: 'scopes',
    scopes: value.scopes.map((scope: unknown) =>
      validateChatGetStateRequest(scope),
    ),
  };
}

function validateInterestChatRef(value: unknown): ChatInterestChatRef {
  if (!isRecord(value))
    failInvalidRequest('Chat interest ref must be an object.');
  assertExactKeys(
    value,
    new Set(['projectId', 'worktreeId', 'chatId']),
    'chat ref',
  );
  return {
    projectId: readScopeId(value.projectId, 'projectId'),
    worktreeId: readScopeId(value.worktreeId, 'worktreeId'),
    chatId: readId(value.chatId, 'chatId'),
  };
}

function validateInterestRunRef(value: unknown): ChatInterestRunRef {
  if (!isRecord(value))
    failInvalidRequest('Chat interest run ref must be an object.');
  assertExactKeys(
    value,
    new Set([
      'projectId',
      'worktreeId',
      'chatId',
      'delegationId',
      'runGeneration',
    ]),
    'run ref',
  );
  const chat = validateInterestChatRef({
    projectId: value.projectId,
    worktreeId: value.worktreeId,
    chatId: value.chatId,
  });
  if (
    typeof value.runGeneration !== 'number' ||
    !Number.isSafeInteger(value.runGeneration) ||
    value.runGeneration < 0
  )
    failInvalidRequest('runGeneration must be a nonnegative safe integer.');
  return {
    ...chat,
    delegationId: readId(value.delegationId, 'delegationId'),
    runGeneration: value.runGeneration,
  };
}

function uniqueByKey<Ref>(refs: Ref[], keyOf: (ref: Ref) => string): Ref[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = keyOf(ref);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function interestChatKey(ref: ChatInterestChatRef): string {
  return JSON.stringify([ref.projectId, ref.worktreeId, ref.chatId]);
}

/** Validate and normalize a window's inert interest declaration. */
export function validateChatInterestDeclaration(
  value: unknown,
): ChatInterestDeclaration {
  if (!isRecord(value))
    failInvalidRequest('Chat interest declaration must be an object.');
  assertExactKeys(
    value,
    new Set([
      'focused',
      'warm',
      'focusedRuns',
      'acceptsMessagesOmitted',
      'observabilityEntries',
    ]),
    'declaration',
  );
  if (
    value.acceptsMessagesOmitted !== undefined &&
    value.acceptsMessagesOmitted !== true
  )
    failInvalidRequest('acceptsMessagesOmitted must be true when present.');
  if (
    value.observabilityEntries !== undefined &&
    typeof value.observabilityEntries !== 'boolean'
  )
    failInvalidRequest('observabilityEntries must be a boolean when present.');
  if (!Array.isArray(value.focused) || value.focused.length > 32)
    failInvalidRequest('focused must be an array of at most 32 chats.');
  if (!Array.isArray(value.warm) || value.warm.length > 16)
    failInvalidRequest('warm must be an array of at most 16 chats.');
  if (
    value.focusedRuns !== undefined &&
    (!Array.isArray(value.focusedRuns) || value.focusedRuns.length > 64)
  )
    failInvalidRequest('focusedRuns must be an array of at most 64 runs.');
  const focused = uniqueByKey(
    value.focused.map(validateInterestChatRef),
    interestChatKey,
  );
  const focusedKeys = new Set(focused.map(interestChatKey));
  const warm = uniqueByKey(
    value.warm.map(validateInterestChatRef),
    interestChatKey,
  ).filter((ref) => !focusedKeys.has(interestChatKey(ref)));
  const focusedRuns = value.focusedRuns?.map(validateInterestRunRef);
  return {
    focused,
    warm,
    ...(value.acceptsMessagesOmitted === true
      ? { acceptsMessagesOmitted: true }
      : {}),
    ...(value.observabilityEntries === undefined
      ? {}
      : { observabilityEntries: value.observabilityEntries }),
    ...(focusedRuns === undefined
      ? {}
      : {
          focusedRuns: uniqueByKey(focusedRuns, (ref) =>
            JSON.stringify([
              ref.projectId,
              ref.worktreeId,
              ref.chatId,
              ref.delegationId,
              ref.runGeneration,
            ]),
          ),
        }),
  };
}

function readTranscriptOrdinal(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    failInvalidRequest(`${label} must be a nonnegative safe integer.`);
  return value;
}

export function validateChatTranscriptPageRequest(
  value: unknown,
): ChatTranscriptPageRequest {
  if (!isRecord(value))
    failInvalidRequest('Transcript request must be an object.');
  assertExactKeys(
    value,
    new Set([
      'projectId',
      'worktreeId',
      'archivedContainerId',
      'standaloneHistory',
      'chatId',
      'before',
      'view',
      'turnId',
      'transcriptRevision',
    ]),
    'request',
  );
  if (
    value.standaloneHistory !== undefined &&
    (value.standaloneHistory !== true ||
      value.archivedContainerId !== undefined)
  )
    failInvalidRequest('Invalid standalone archive scope.');
  if (
    value.archivedContainerId !== undefined &&
    value.archivedContainerId !== value.worktreeId
  )
    failInvalidRequest('Archived container must match the transcript scope.');
  if (value.view !== undefined && value.view !== 'turns')
    failInvalidRequest('Invalid transcript view.');
  if (value.turnId !== undefined && value.view !== 'turns')
    failInvalidRequest('Turn paging requires the turn view.');
  return {
    ...(value.view === 'turns' ? { view: 'turns' as const } : {}),
    ...(value.turnId !== undefined
      ? { turnId: readMessageAnchorId(value.turnId, 'turnId') }
      : {}),
    ...(value.standaloneHistory === true ? { standaloneHistory: true } : {}),
    ...(value.archivedContainerId !== undefined
      ? {
          archivedContainerId: readId(
            value.archivedContainerId,
            'archivedContainerId',
          ),
        }
      : {}),
    projectId: readScopeId(value.projectId, 'projectId'),
    worktreeId: readScopeId(value.worktreeId, 'worktreeId'),
    chatId: readId(value.chatId, 'chatId'),
    ...(value.before !== undefined
      ? { before: readTranscriptOrdinal(value.before, 'before') }
      : {}),
    ...(value.transcriptRevision !== undefined
      ? {
          transcriptRevision: readTranscriptOrdinal(
            value.transcriptRevision,
            'transcriptRevision',
          ),
        }
      : {}),
  };
}

export function validateChatToolOutputRequest(
  value: unknown,
): ChatToolOutputRequest {
  if (!isRecord(value))
    failInvalidRequest('Tool output request must be an object.');
  assertExactKeys(
    value,
    new Set([
      'projectId',
      'worktreeId',
      'archivedContainerId',
      'standaloneHistory',
      'chatId',
      'messageId',
      'toolUseId',
      'requestId',
      'reference',
      'offset',
      'limit',
    ]),
    'request',
  );
  const reference = value.reference;
  if (!isRecord(reference))
    failInvalidRequest('Tool output reference must be an object.');
  assertExactKeys(
    reference,
    new Set([
      'version',
      'artifactId',
      'byteLength',
      'sha256',
      'encoding',
      'mediaType',
    ]),
    'reference',
  );
  if (
    reference.version !== 1 ||
    typeof reference.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(reference.sha256) ||
    reference.artifactId !== `sha256-v1-${reference.sha256}` ||
    (reference.encoding !== 'utf-8' && reference.encoding !== 'utf-16le') ||
    reference.mediaType !== 'text/plain'
  )
    failInvalidRequest('Invalid tool output reference.');
  const byteLength = readTranscriptOrdinal(reference.byteLength, 'byteLength');
  const offset = readTranscriptOrdinal(value.offset, 'offset');
  const limit = readTranscriptOrdinal(value.limit, 'limit');
  if (offset > byteLength || limit < 4 || limit > 65_536)
    failInvalidRequest('Invalid tool output range.');
  const archiveScope = readArchiveScope(value);
  return {
    ...archiveScope,
    projectId: readScopeId(value.projectId, 'projectId'),
    worktreeId: readScopeId(value.worktreeId, 'worktreeId'),
    chatId: readId(value.chatId, 'chatId'),
    messageId: readMessageAnchorId(value.messageId, 'messageId'),
    toolUseId: readMessageAnchorId(value.toolUseId, 'toolUseId'),
    requestId: readId(value.requestId, 'requestId'),
    offset,
    limit,
    reference: {
      version: 1,
      artifactId: `sha256-v1-${reference.sha256}`,
      byteLength,
      sha256: reference.sha256,
      encoding: reference.encoding,
      mediaType: 'text/plain',
    },
  };
}

function readArchiveScope(value: JsonRecord): {
  archivedContainerId?: string;
  standaloneHistory?: true;
} {
  if (
    value.standaloneHistory !== undefined &&
    (value.standaloneHistory !== true ||
      value.archivedContainerId !== undefined)
  )
    failInvalidRequest('Invalid standalone archive scope.');
  if (
    value.archivedContainerId !== undefined &&
    value.archivedContainerId !== value.worktreeId
  )
    failInvalidRequest('Archived container must match the transcript scope.');
  return {
    ...(value.standaloneHistory === true ? { standaloneHistory: true } : {}),
    ...(value.archivedContainerId !== undefined
      ? {
          archivedContainerId: readId(
            value.archivedContainerId,
            'archivedContainerId',
          ),
        }
      : {}),
  };
}

export function validateChatVisualReadRequest(
  value: unknown,
): ChatVisualReadRequest {
  if (!isRecord(value))
    failInvalidRequest('Visual read request must be an object.');
  assertExactKeys(
    value,
    new Set([
      'projectId',
      'worktreeId',
      'archivedContainerId',
      'standaloneHistory',
      'chatId',
      'messageId',
      'toolUseId',
      'reference',
      'offset',
      'limit',
    ]),
    'request',
  );
  const reference = value.reference;
  if (!isRecord(reference))
    failInvalidRequest('Visual reference must be an object.');
  assertExactKeys(
    reference,
    new Set([
      'version',
      'visualId',
      'artifactId',
      'byteLength',
      'sha256',
      'mediaType',
      'title',
      'maxHeight',
      'heights',
    ]),
    'reference',
  );
  if (
    reference.version !== 1 ||
    typeof reference.visualId !== 'string' ||
    !isVisualId(reference.visualId) ||
    typeof reference.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(reference.sha256) ||
    reference.artifactId !== `sha256-v1-${reference.sha256}` ||
    reference.mediaType !== 'text/html' ||
    typeof reference.title !== 'string' ||
    reference.title.length < 1 ||
    reference.title.length > VISUAL_TITLE_MAX_LENGTH ||
    typeof reference.maxHeight !== 'number' ||
    !Number.isInteger(reference.maxHeight) ||
    reference.maxHeight < VISUAL_MIN_HEIGHT ||
    reference.maxHeight > VISUAL_MAX_HEIGHT
  )
    failInvalidRequest('Invalid visual reference.');
  const byteLength = readTranscriptOrdinal(reference.byteLength, 'byteLength');
  if (byteLength > VISUAL_PREPARED_MAX_BYTES)
    failInvalidRequest('Visual reference exceeds the maximum byte length.');
  const heights = reference.heights;
  if (
    heights !== undefined &&
    (!Array.isArray(heights) ||
      heights.length > VISUAL_HEIGHTS_MAX_ENTRIES ||
      heights.some(
        (pair: unknown) =>
          !Array.isArray(pair) ||
          pair.length !== 2 ||
          pair.some(
            (number: unknown) =>
              typeof number !== 'number' ||
              !Number.isFinite(number) ||
              number <= 0,
          ),
      ))
  )
    failInvalidRequest('Invalid visual heights.');
  const offset = readTranscriptOrdinal(value.offset, 'offset');
  const limit = readTranscriptOrdinal(value.limit, 'limit');
  if (offset > byteLength || limit < 1 || limit > 1_048_576)
    failInvalidRequest('Invalid visual range.');
  return {
    ...readArchiveScope(value),
    projectId: readScopeId(value.projectId, 'projectId'),
    worktreeId: readScopeId(value.worktreeId, 'worktreeId'),
    chatId: readId(value.chatId, 'chatId'),
    messageId: readMessageAnchorId(value.messageId, 'messageId'),
    toolUseId: readMessageAnchorId(value.toolUseId, 'toolUseId'),
    reference: {
      version: 1,
      visualId: reference.visualId,
      artifactId: `sha256-v1-${reference.sha256}`,
      byteLength,
      sha256: reference.sha256,
      mediaType: 'text/html',
      title: reference.title,
      maxHeight: reference.maxHeight,
      ...(heights !== undefined ? { heights } : {}),
    },
    offset,
    limit,
  };
}

export function validateChatToolOutputCancelRequest(
  value: unknown,
): ChatToolOutputCancelRequest {
  if (!isRecord(value))
    failInvalidRequest('Tool output cancellation must be an object.');
  assertExactKeys(value, new Set(['requestId']), 'request');
  return { requestId: readId(value.requestId, 'requestId') };
}

export function validateChatCommandRequest(
  value: unknown,
  options: { allowMainOnlyFields?: boolean } = {},
): ChatCommandRequest {
  if (!isRecord(value)) {
    failInvalidRequest('Chat command request must be an object.');
  }
  if (options.allowMainOnlyFields !== true) {
    try {
      assertUntrustedChatInput(value);
    } catch (error) {
      failInvalidRequest(
        error instanceof Error
          ? error.message
          : 'Chat command request contains main-only attribution.',
      );
    }
  }
  assertJsonValue(value, 'request', new Set());
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    failInvalidRequest('Chat command request must be JSON serializable.');
  }
  const command = value.command;
  const maxCommandBytes =
    isRecord(command) &&
    command.type === 'chat.create_tab' &&
    command.seedTab !== undefined
      ? MAX_SEEDED_CHAT_COMMAND_BYTES
      : MAX_COMMAND_BYTES;
  if (bytes > maxCommandBytes) {
    failInvalidRequest('Chat command request exceeds the payload-size limit.');
  }
  assertExactKeys(
    value,
    new Set([
      'schemaVersion',
      'commandId',
      'projectId',
      'worktreeId',
      'expectedRevision',
      'expectedTabRevision',
      'command',
    ]),
    'request',
  );
  if (value.schemaVersion !== 1) {
    failInvalidRequest('schemaVersion must equal 1.');
  }
  if (!isRecord(value.command)) {
    failInvalidRequest('command must be an object.');
  }
  const expectedRevision =
    value.expectedRevision === undefined
      ? undefined
      : readRevision(value.expectedRevision, 'expectedRevision');
  const expectedTabRevision =
    value.expectedTabRevision === undefined
      ? undefined
      : readRevision(value.expectedTabRevision, 'expectedTabRevision');
  return {
    schemaVersion: 1,
    commandId: readId(value.commandId, 'commandId'),
    projectId: readScopeId(value.projectId, 'projectId'),
    worktreeId: readScopeId(value.worktreeId, 'worktreeId'),
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    ...(expectedTabRevision === undefined ? {} : { expectedTabRevision }),
    command: validateCommand(
      value.command,
      options.allowMainOnlyFields === true,
    ),
  };
}

function assertCommittedEvent(event: ChatStateChangedEvent): void {
  if (
    event.schemaVersion !== 1 ||
    !Number.isSafeInteger(event.baseRevision) ||
    !Number.isSafeInteger(event.revision) ||
    event.baseRevision < 0 ||
    event.revision <= event.baseRevision ||
    event.changes.length === 0 ||
    event.eventId.length === 0 ||
    event.projectId.length === 0 ||
    event.worktreeId.length === 0
  ) {
    throw new Error('Chat state service emitted an invalid committed event.');
  }
}

function canSend(window: BrowserWindow): boolean {
  return !window.isDestroyed() && !window.webContents.isDestroyed();
}

/** The part of a window's `WebContents` the chat state push uses. */
type ChatStatePushTarget = Pick<
  BrowserWindow['webContents'],
  'isDestroyed' | 'send'
>;

/**
 * Register pure transport adapters around a structurally injected service.
 * Returns cleanup for tests/application shutdown; delivery never affects commit.
 */
export function registerChatStateHandlers(
  port: ChatStateCommandPort,
  getWindows: () => Array<BrowserWindow | null>,
  runtime: {
    dispatcher: DesktopCanopyDispatcher;
    resolveCaller: DesktopIpcCallerResolver;
    installScopePinProvider?: (
      provider: (scope: ChatScopeKey) => boolean,
    ) => () => void;
  },
): () => void {
  const rethrowLegacyError = (error: unknown): never => {
    if (error instanceof CanopyOperationError) {
      if (error.runtimeCause instanceof Error) throw error.runtimeCause;
      if (error.payload.kind === 'cancelled')
        throw new DOMException('This operation was aborted', 'AbortError');
      throw new Error(error.payload.message);
    }
    throw error;
  };
  const searches = new Map<string, AbortController>();
  registerIpcHandler<[unknown], ChatTranscriptSearchResult>(
    IPC_CHANNELS.chatSearchTranscript,
    async (event, value) => {
      if (!isRecord(value)) failInvalidRequest('Invalid transcript search.');
      assertExactKeys(
        value,
        new Set(['projectId', 'worktreeId', 'chatId', 'query', 'requestId']),
        'request',
      );
      if (
        typeof value.query !== 'string' ||
        value.query.length < 2 ||
        value.query.length > 256
      )
        failInvalidRequest('Search query must contain 2 to 256 characters.');
      const request = {
        projectId: readScopeId(value.projectId, 'projectId'),
        worktreeId: readScopeId(value.worktreeId, 'worktreeId'),
        chatId: readId(value.chatId, 'chatId'),
        query: value.query,
        requestId: readId(value.requestId, 'requestId'),
      };
      const key = `${event.sender.id}:${request.requestId}`;
      if (searches.has(key)) failInvalidRequest('Duplicate search request.');
      const controller = new AbortController();
      searches.set(key, controller);
      try {
        try {
          const { legacyResult } =
            await runtime.dispatcher.queryChatTranscriptSearchForLegacyIpc(
              {
                scope: {
                  workspaceId: request.projectId,
                  worktreeId: request.worktreeId,
                  chatId: request.chatId,
                },
                query: request.query,
              },
              {
                caller: runtime.resolveCaller(event),
                signal: controller.signal,
              },
              request.requestId,
            );
          return legacyResult;
        } catch (error) {
          return rethrowLegacyError(error);
        }
      } finally {
        searches.delete(key);
      }
    },
  );
  registerIpcHandler<[unknown], void>(
    IPC_CHANNELS.chatCancelTranscriptSearch,
    (event, value) => {
      searches.get(`${event.sender.id}:${readId(value, 'requestId')}`)?.abort();
    },
  );
  const activeToolOutputReads = new Map<string, AbortController>();
  const requestKey = (senderId: number, requestId: string): string =>
    `${senderId}:${requestId}`;
  setChatStateCommandPort(port);
  registerIpcHandler<[unknown], TranscriptPage>(
    IPC_CHANNELS.chatGetTranscriptPage,
    (event, value) => {
      const request = validateChatTranscriptPageRequest(value);
      return runtime.dispatcher
        .queryChatTranscriptPageForLegacyIpc(
          {
            scope: {
              workspaceId: request.projectId,
              worktreeId: request.worktreeId,
              chatId: request.chatId,
            },
            archivedContainerId: request.archivedContainerId,
            standaloneHistory:
              request.standaloneHistory === true ? true : undefined,
            before: request.before,
            view: request.view,
            turnId: request.turnId,
            transcriptRevision: request.transcriptRevision,
          },
          { caller: runtime.resolveCaller(event) },
        )
        .then(({ legacyResult }) => legacyResult)
        .catch(rethrowLegacyError);
    },
  );
  registerIpcHandler<[unknown], ChatToolOutputResponse>(
    IPC_CHANNELS.chatReadToolOutput,
    async (event, value) => {
      const request = validateChatToolOutputRequest(value);
      const key = requestKey(event.sender.id, request.requestId);
      if (activeToolOutputReads.has(key))
        throw new Error('Duplicate tool output request');
      const controller = new AbortController();
      activeToolOutputReads.set(key, controller);
      try {
        try {
          const { legacyResult } =
            await runtime.dispatcher.queryChatToolOutputForLegacyIpc(
              {
                scope: {
                  workspaceId: request.projectId,
                  worktreeId: request.worktreeId,
                  chatId: request.chatId,
                },
                archivedContainerId: request.archivedContainerId,
                standaloneHistory:
                  request.standaloneHistory === true ? true : undefined,
                messageId: request.messageId,
                toolUseId: request.toolUseId,
                reference: request.reference,
                offset: request.offset,
                limit: request.limit,
              },
              {
                caller: runtime.resolveCaller(event),
                signal: controller.signal,
              },
              request.requestId,
            );
          return legacyResult;
        } catch (error) {
          return rethrowLegacyError(error);
        }
      } finally {
        activeToolOutputReads.delete(key);
      }
    },
  );
  registerIpcHandler<[unknown], void>(
    IPC_CHANNELS.chatCancelToolOutput,
    (event, value) => {
      const request = validateChatToolOutputCancelRequest(value);
      activeToolOutputReads
        .get(requestKey(event.sender.id, request.requestId))
        ?.abort();
    },
  );
  // Unlike `rethrowLegacyError`, never surface the runtime cause: it can
  // carry a host path that the adapter's fixed message deliberately hides.
  const rethrowVisualError = (error: unknown): never => {
    if (error instanceof CanopyOperationError) {
      if (error.payload.kind === 'cancelled')
        throw new DOMException('This operation was aborted', 'AbortError');
      throw new Error(error.payload.message);
    }
    throw new Error('Chat visual read failed.');
  };
  const activeVisualReads = new Set<AbortController>();
  registerIpcHandler<[unknown], ChatVisualReadResult>(
    IPC_CHANNELS.chatReadVisual,
    async (event, value) => {
      const request = validateChatVisualReadRequest(value);
      const { heights, ...reference } = request.reference;
      const controller = new AbortController();
      activeVisualReads.add(controller);
      try {
        return await runtime.dispatcher.query(
          'core.chat.visual.read',
          {
            scope: {
              workspaceId: request.projectId,
              worktreeId: request.worktreeId,
              chatId: request.chatId,
            },
            archivedContainerId: request.archivedContainerId,
            standaloneHistory:
              request.standaloneHistory === true ? true : undefined,
            messageId: request.messageId,
            toolUseId: request.toolUseId,
            reference: {
              ...reference,
              // The protocol takes mutable pairs; the stored type is readonly.
              ...(heights
                ? {
                    heights: heights.map(
                      ([width, height]): [number, number] => [width, height],
                    ),
                  }
                : {}),
            },
            offset: request.offset,
            limit: request.limit,
          },
          { caller: runtime.resolveCaller(event), signal: controller.signal },
        );
      } catch (error) {
        return rethrowVisualError(error);
      } finally {
        activeVisualReads.delete(controller);
      }
    },
  );
  // Interface projection policy (cadence and per-window routing) for this
  // legacy push only; the stream and its other clients are unchanged.
  const subscriptions = new ChatStateSubscriptions<
    Pick<BrowserWindow['webContents'], 'id' | 'isDestroyed'>
  >();
  const uninstallScopePinProvider =
    runtime.installScopePinProvider?.((scope): boolean =>
      getWindows().some((window): boolean => {
        if (!window || !canSend(window)) return false;
        const renderer = rendererContentsOf(window.webContents);
        const interest = subscriptions.interestOf(renderer);
        const matchesScope = (chat: ChatInterestChatRef): boolean =>
          chat.projectId === scope.projectId &&
          chat.worktreeId === scope.worktreeId;
        return (
          interest?.focused.some(matchesScope) === true ||
          interest?.warm.some(matchesScope) === true
        );
      }),
    ) ?? ((): void => undefined);
  const removeInterestE2eHook = installChatInterestE2eHook(subscriptions);
  const removeInterestLookup = installChatInterestLookup((contents) =>
    subscriptions.interestOf(contents),
  );
  const eventInterestFilter = new ChatEventInterestFilter();
  const removeEventFilter = setRendererDeliveryFilter(
    IPC_CHANNELS.chatEvent,
    (target, args) =>
      isInterestSubscriber(target) &&
      eventInterestFilter.shouldDrop(
        target,
        subscriptions.interestOf(target),
        args[0],
      ),
  );
  const removeObservabilityEventFilter = setRendererDeliveryFilter(
    IPC_CHANNELS.observabilityEvent,
    (target, args) =>
      isInterestSubscriber(target) &&
      shouldDropObservabilityEvent(subscriptions.interestOf(target), args[0]),
  );
  const delivery = new ChatStateDelivery<ChatStatePushTarget>({
    transform: (target, event): ChatStateChangedEvent =>
      filterChatStateBodies(
        isInterestSubscriber(target)
          ? subscriptions.interestOf(target)
          : undefined,
        event,
      ),
    deliver: (contents, event): void => {
      if (contents.isDestroyed()) return;
      try {
        sendToWebContents(contents, IPC_CHANNELS.chatStateChanged, event);
      } catch {
        // A suspended/destroying renderer cannot roll back a committed change
        // and must not prevent delivery to other authorized windows.
      }
    },
    setTimer: (callback, delayMs): (() => void) => {
      const timer = setTimeout(callback, delayMs);
      return (): void => {
        clearTimeout(timer);
      };
    },
    now: (): number => performance.now(),
  });
  // Any other message, and any invoke reply, to a window first delivers the
  // chat state held back for it, preserving the order it observes.
  const removeDeliveryBarrier = addRendererDeliveryBarrier(
    (target, channel): void => {
      if (channel !== IPC_CHANNELS.chatStateChanged)
        delivery.flushTarget(target);
    },
  );
  // Every renderer the projection holds state for (a push target, a snapshot
  // reader or a declaring window) is released when its contents are
  // destroyed, whether or not it ever declared.
  const watchedSubscribers = new WeakSet<object>();
  const watchSubscriber = (subscriber: BrowserWindow['webContents']): void => {
    if (watchedSubscribers.has(subscriber)) return;
    watchedSubscribers.add(subscriber);
    subscriber.once?.('destroyed', () => {
      subscriptions.reset(subscriber);
      delivery.forgetTarget(subscriber);
    });
  };
  registerIpcHandler<[unknown], ChatStateSnapshot>(
    IPC_CHANNELS.chatGetState,
    async (event, value) => {
      const request = validateChatGetStateRequest(value);
      // No message to this window spans the snapshot's revision; the
      // boundary is set before the reply barrier delivers held messages.
      watchSubscriber(event.sender);
      const endSnapshot = delivery.beginSnapshot(
        event.sender,
        request.projectId,
        request.worktreeId,
      );
      let revision: number | undefined;
      try {
        const { legacyResult } =
          await runtime.dispatcher.queryChatStateForLegacyIpc(
            {
              scope: {
                workspaceId: request.projectId,
                worktreeId: request.worktreeId,
              },
            },
            { caller: runtime.resolveCaller(event) },
          );
        revision = legacyResult.revision;
        return legacyResult;
      } catch (error) {
        if (
          error instanceof CanopyOperationError &&
          error.runtimeCause !== undefined
        ) {
          // Legacy IPC preserves the service's structured rejection unchanged.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          return Promise.reject(error.runtimeCause);
        }
        throw error;
      } finally {
        endSnapshot(revision);
      }
    },
  );
  registerIpcHandler<[unknown], ChatCommandResult>(
    IPC_CHANNELS.chatCommand,
    async (event, value) => {
      try {
        return await dispatchChatCommandForLegacyIpc(
          value,
          createChatCommandDispatchOptions(
            port,
            runtime.dispatcher,
            runtime.resolveCaller(event),
          ),
        );
      } catch (error) {
        if (error instanceof InvalidChatStateRequestError)
          throw classifyError(error, 'input.not_accepted');
        if (isChatScopeDeletingError(error))
          throw classifyError(error, 'external.state_changed');
        throw error;
      }
    },
  );
  registerIpcHandler<[unknown], void>(
    IPC_CHANNELS.chatSetStateScopes,
    (event, value) => {
      const subscriber = event.sender;
      if (
        event.senderFrame !== null &&
        event.senderFrame !== subscriber.mainFrame
      ) {
        failInvalidRequest('Only a window can declare its chat state scopes.');
      }
      // Deliver what was held back under the previous declaration first.
      delivery.flushTarget(subscriber);
      watchSubscriber(subscriber);
      let declaration: ChatStateScopesDeclaration;
      try {
        declaration = validateChatStateScopesDeclaration(value);
      } catch (error) {
        // Fail open: an invalid declaration must not hide a scope.
        subscriptions.resetScopes(subscriber);
        throw error;
      }
      subscriptions.declare(
        subscriber,
        declaration.kind === 'all' ? 'all' : declaration.scopes,
      );
    },
  );
  registerIpcHandler<[unknown], void>(
    IPC_CHANNELS.chatSetInterest,
    (event, value) => {
      const subscriber = event.sender;
      if (
        event.senderFrame !== null &&
        event.senderFrame !== subscriber.mainFrame
      ) {
        subscriptions.resetInterest(subscriber);
        failInvalidRequest('Only a window can declare its chat interest.');
      }
      watchSubscriber(subscriber);
      const previous = subscriptions.interestOf(subscriber);
      let declaration: ChatInterestDeclaration;
      try {
        declaration = validateChatInterestDeclaration(value);
      } catch (error) {
        subscriptions.resetInterest(subscriber);
        throw error;
      }
      subscriptions.declareInterest(subscriber, declaration);
      const enteringRuns = runsEnteringInterest(previous, declaration);
      if (enteringRuns.length > 0) {
        notifyRunsEnteringInterest(enteringRuns);
      }
    },
  );
  let closed = false;
  let streamHandle:
    | Awaited<
        ReturnType<DesktopCanopyDispatcher['openChatEventsForLegacyIpc']>
      >['handle']
    | undefined;
  const caller: CanopyCallerDescriptor = {
    principalId: 'local-desktop-user',
    clientInstanceId: 'electron-main-chat-push',
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    interfaceKind: 'desktop',
    grants: ['core.chat.read'],
  };
  void (async (): Promise<void> => {
    // Report an outage once. An outage is a run of ended streams with no
    // delivered item between them; without this, each reopen would log.
    let reportedEnd = false;
    while (!closed) {
      let sawItem = false;
      let resolveEnded: () => void = () => undefined;
      const ended = new Promise<void>((resolve) => {
        resolveEnded = resolve;
      });
      // Attached at open, so the push stays synchronous with the port event
      // from the first emit, as before routing.
      const { handle } = await runtime.dispatcher.openChatEventsForLegacyIpc(
        { scope: 'all' },
        {
          caller,
          onFrame: (frame) => {
            if (frame.kind === 'end') {
              if (!closed && frame.outcome !== 'cancelled' && !reportedEnd) {
                reportedEnd = true;
                process.stderr.write('Chat event stream ended; reopening.\n');
              }
              delivery.resetClassification();
              resolveEnded();
              return;
            }
            sawItem = true;
            reportedEnd = false;
            const event = runtime.dispatcher.takeChatEventForLegacyIpc(
              frame.cursor,
            );
            try {
              assertCommittedEvent(event);
            } catch {
              process.stderr.write(
                'Skipped an invalid committed chat event.\n',
              );
              delivery.resetClassification();
              return;
            }
            const targets: ChatStatePushTarget[] = [];
            for (const window of getWindows()) {
              if (!window || !canSend(window)) continue;
              // The renderer the window stands for (the early access App
              // Advisor's lives in a view its window hosts).
              const renderer = rendererContentsOf(window.webContents);
              if (
                subscriptions.wants(renderer, event.projectId, event.worktreeId)
              ) {
                watchSubscriber(renderer);
                targets.push(renderer);
              }
            }
            delivery.publish(event, targets);
          },
        },
      );
      streamHandle = handle;
      if (closed) {
        handle.close();
        return;
      }
      await ended;
      streamHandle = undefined;
      if (!closed && !sawItem)
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })().catch(() => {
    process.stderr.write('Chat event stream stopped.\n');
  });
  return (): void => {
    searches.forEach((controller) => controller.abort());
    searches.clear();
    activeToolOutputReads.forEach((controller) => controller.abort());
    activeToolOutputReads.clear();
    activeVisualReads.forEach((controller) => controller.abort());
    activeVisualReads.clear();
    closed = true;
    streamHandle?.close();
    runtime.dispatcher.closeChatEventsForLegacyIpc();
    // Teardown delivers what is held back; later events go out at once.
    delivery.dispose();
    uninstallScopePinProvider();
    removeInterestE2eHook();
    removeInterestLookup();
    removeEventFilter();
    removeObservabilityEventFilter();
    removeDeliveryBarrier();
    if (installedChatStatePort === port) setChatStateCommandPort(null);
  };
}
