import {
  parseChatAgentSentInfo,
  parseChatWatcherFiredInfo,
} from '@canopy/protocol/remote-control/shell';
import type {
  ChatInputDeliveryView,
  ChatSteeringCapabilities,
} from '@canopy/protocol/remote-control/shell';
import {
  getExecutionHarnessForModel,
  resolveModelAlias,
  type ApprovalMode,
  type ApprovalRule,
  type ChatSendMessageRequest,
  type PersistedChatTab,
} from './types';
import {
  DEFAULT_CODEX_SPEED,
  readCodexSpeedRecord,
} from '@canopy/execution-engine/lib/codex-speed';
import {
  sessionApprovalWithinTurn,
  type TurnApproval,
} from './lib/send-approval-narrowing';
import type { ChatInputDeliveryLedger } from '@canopy/protocol/remote-control/shell';
import { isInternalChatRequest } from './lib/internal-chat-row';
import { isGeneratedInputRequest } from './lib/input-request-kind';

export type InputLedger = ChatInputDeliveryLedger<ChatSendMessageRequest>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function optionalStrings(
  value: Record<string, unknown>,
  keys: string[],
): boolean {
  return keys.every(
    (key) => value[key] === undefined || typeof value[key] === 'string',
  );
}

/** Stored provenance is evidence, not authority; unsupported facts stay inert. */
function isAgentSenderProvenance(value: unknown): boolean {
  if (
    !record(value) ||
    value.version !== 1 ||
    typeof value.capturedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.capturedAt)) ||
    typeof value.acceptedInputId !== 'string' ||
    !value.acceptedInputId.trim() ||
    !record(value.owner)
  )
    return false;
  const sender = parseChatAgentSentInfo({
    sender: value.sender,
    chatTitle: 'Sender',
    projectLabel: 'Project',
  })?.sender;
  if (sender?.kind === 'bot') return value.owner.kind === 'none';
  if (sender?.kind === 'pipeline') {
    // A run's owner, and the agent chat that started it when one did.
    const origin = value.agentOrigin;
    if (
      origin !== undefined &&
      !(
        record(origin) &&
        ['projectId', 'worktreeId', 'chatId'].every(
          (key) => typeof origin[key] === 'string' && origin[key].trim(),
        )
      )
    )
      return false;
  } else if (sender?.kind !== 'project') return false;
  return (
    value.owner.kind === 'personal' ||
    (value.owner.kind === 'organization' &&
      typeof value.owner.organizationId === 'string' &&
      value.owner.organizationId.trim().length > 0)
  );
}

function isChatSendMessagePayload(
  value: unknown,
): value is Record<string, unknown> {
  if (!record(value)) return false;
  return (
    ['projectId', 'worktreeId', 'chatId', 'userMessageId', 'text'].every(
      (key) => typeof value[key] === 'string',
    ) &&
    (value.nativeAutomationRunInputId === undefined ||
      value.nativeAutomationRunInputId === value.userMessageId) &&
    (value.agentSenderProvenance === undefined ||
      isAgentSenderProvenance(value.agentSenderProvenance)) &&
    (!record(value.hiddenContext) ||
      value.hiddenContext.kind !== 'agent-sender-context' ||
      typeof value.hiddenContext.text === 'string') &&
    (value.inputMode === undefined ||
      value.inputMode === 'typed' ||
      value.inputMode === 'voice') &&
    (value.attachmentPaths === undefined ||
      (Array.isArray(value.attachmentPaths) &&
        value.attachmentPaths.every(
          (path: unknown) => typeof path === 'string',
        ))) &&
    (value.fileReferences === undefined ||
      (Array.isArray(value.fileReferences) &&
        value.fileReferences.every(
          (file: unknown) =>
            record(file) &&
            typeof file.absolutePath === 'string' &&
            typeof file.displayPath === 'string',
        ))) &&
    (value.attachmentPromptContexts === undefined ||
      (Array.isArray(value.attachmentPromptContexts) &&
        value.attachmentPromptContexts.every(
          (context: unknown) =>
            record(context) &&
            typeof context.attachmentPath === 'string' &&
            ['in-app-browser-resource', 'linear-ticket'].includes(
              String(context.promptKind),
            ),
        )))
  );
}

/** Unknown versions and malformed identities survive storage but remain inert. */
export function isInputLedger(value: unknown): value is InputLedger {
  if (
    !record(value) ||
    value.version !== 1 ||
    !nonnegativeInteger(value.epoch) ||
    !Array.isArray(value.rows)
  )
    return false;
  const rowIds = new Set<string>();
  const attemptIds = new Set<string>();
  return value.rows.every((row: unknown) => {
    if (
      !record(row) ||
      typeof row.id !== 'string' ||
      !row.id ||
      rowIds.has(row.id) ||
      !nonnegativeInteger(row.revision) ||
      row.revision === 0 ||
      !nonnegativeInteger(row.createdAt) ||
      typeof row.text !== 'string' ||
      typeof row.settingsKey !== 'string' ||
      ![
        'sending',
        'pending',
        'cancelling',
        'editing',
        'cancelled',
        'picked-up',
        'uncertain',
        'queued',
      ].includes(String(row.state)) ||
      !optionalStrings(row, ['currentAttemptId', 'draft', 'reason']) ||
      (row.dismissedAt !== undefined && !nonnegativeInteger(row.dismissedAt)) ||
      (row.editResubmits !== undefined &&
        typeof row.editResubmits !== 'boolean') ||
      (row.queueIntent !== undefined &&
        (!record(row.queueIntent) ||
          typeof row.queueIntent.commandId !== 'string' ||
          !row.queueIntent.commandId ||
          (row.queueIntent.epoch !== undefined &&
            !nonnegativeInteger(row.queueIntent.epoch)))) ||
      (row.origin !== undefined &&
        row.origin !== 'desktop' &&
        row.origin !== 'portal') ||
      (row.ordinaryContinuation !== undefined &&
        (!record(row.ordinaryContinuation) ||
          typeof row.ordinaryContinuation.attemptId !== 'string' ||
          !row.ordinaryContinuation.attemptId ||
          !nonnegativeInteger(row.ordinaryContinuation.epoch))) ||
      (row.ordinaryOnly !== undefined && row.ordinaryOnly !== true) ||
      (row.notDelivered !== undefined &&
        (!record(row.notDelivered) ||
          typeof row.notDelivered.attemptId !== 'string' ||
          !row.notDelivered.attemptId ||
          !nonnegativeInteger(row.notDelivered.at))) ||
      !record(row.payload) ||
      !Array.isArray(row.attempts)
    )
      return false;
    rowIds.add(row.id);
    if (!isChatSendMessagePayload(row.payload)) return false;
    const ownAttemptIds = new Set<string>();
    if (
      !row.attempts.every((attempt: unknown) => {
        if (
          !record(attempt) ||
          typeof attempt.id !== 'string' ||
          !attempt.id ||
          attemptIds.has(attempt.id) ||
          typeof attempt.generation !== 'string' ||
          !attempt.generation ||
          (attempt.provider !== 'claude' && attempt.provider !== 'codex') ||
          !nonnegativeInteger(attempt.createdAt) ||
          !optionalStrings(attempt, [
            'submittedText',
            'displayText',
            'providerTurnId',
            'itemId',
            'rootUserMessageId',
          ]) ||
          ![
            'admittedAt',
            'pickedUpAt',
            'withdrawnAt',
            'completedAt',
            'uncertainAt',
            'turnSettledAt',
          ].every(
            (key) =>
              attempt[key] === undefined || nonnegativeInteger(attempt[key]),
          ) ||
          (attempt.turnOutcome !== undefined &&
            (typeof attempt.turnOutcome !== 'string' ||
              !['completed', 'failed', 'cancelled', 'interrupted'].includes(
                attempt.turnOutcome,
              ))) ||
          (attempt.payloadSnapshot !== undefined &&
            !isChatSendMessagePayload(attempt.payloadSnapshot)) ||
          (attempt.target !== undefined &&
            (!record(attempt.target) ||
              typeof attempt.target.sessionId !== 'string' ||
              !attempt.target.sessionId ||
              (attempt.target.turnId !== undefined &&
                (typeof attempt.target.turnId !== 'string' ||
                  !attempt.target.turnId))))
        )
          return false;
        attemptIds.add(attempt.id);
        ownAttemptIds.add(attempt.id);
        return true;
      })
    )
      return false;
    const currentAttemptId = row.currentAttemptId;
    if (currentAttemptId !== undefined && typeof currentAttemptId !== 'string')
      return false;
    return (
      currentAttemptId === undefined || ownAttemptIds.has(currentAttemptId)
    );
  });
}

/**
 * The return to the queue a generated row still owes after its ordinary
 * fallback, or undefined once anything superseded it: a newer attempt, an
 * edit (including an unsaved draft left by closing the editor), a pickup,
 * another state, or a new epoch (Stop, Interrupt, a copy).
 */
export function validOrdinaryContinuation(
  ledger: InputLedger,
  row: InputLedger['rows'][number],
): { attemptId: string; epoch: number } | undefined {
  const continuation = row.ordinaryContinuation;
  if (
    !continuation ||
    row.state !== 'cancelled' ||
    row.draft !== undefined ||
    ledger.epoch !== continuation.epoch ||
    row.currentAttemptId !== continuation.attemptId ||
    row.attempts.some((attempt) => attempt.pickedUpAt !== undefined)
  )
    return undefined;
  const attempt = row.attempts.find(
    (candidate) => candidate.id === continuation.attemptId,
  );
  const attemptText = attempt?.displayText ?? attempt?.submittedText;
  return attemptText !== undefined && attemptText === row.text
    ? continuation
    : undefined;
}

// Order is part of the persisted key format.
const INPUT_SETTINGS_FIELDS = [
  'model',
  'providerType',
  'planMode',
  'approvalMode',
  'sessionApprovalRules',
  'thinkingLevel',
  'modelConfig',
  'pluginSelections',
  'deferredToolsAllowed',
  'interfaceMode',
  'subscriptionBillingOverride',
  'aiCreditsRouted',
  'aiCreditsRouting',
  'executionHarness',
  'selectedRepoId',
  'globalInstructionsSnapshot',
  'disabledGlobalPluginSelections',
  'codexFastModeEnabled',
  'proposalMode',
] as const satisfies readonly (keyof PersistedChatTab)[];

/** Explicit settings that can change which session consumes a message. */
export function inputSettingsKey(tab: PersistedChatTab): string {
  return JSON.stringify(
    INPUT_SETTINGS_FIELDS.map((field) => {
      if (field === 'model')
        return tab.model ? resolveModelAlias(tab.model) : tab.model;
      if (field === 'sessionApprovalRules')
        return tab.sessionApprovalRules ?? [];
      return tab[field];
    }),
  );
}

/** Compare the persisted settings key exactly, except for approval authority. */
export function inputSettingsKeyMatchesNonApproval(
  tab: PersistedChatTab,
  settingsKey: string,
): boolean {
  let stored: unknown;
  try {
    stored = JSON.parse(settingsKey);
  } catch {
    return false;
  }
  if (!Array.isArray(stored)) return false;
  const storedSettings: unknown[] = stored;
  INPUT_SETTINGS_FIELDS.forEach((field, index) => {
    if (field === 'approvalMode')
      storedSettings[index] = tab.approvalMode ?? null;
    if (field === 'sessionApprovalRules')
      storedSettings[index] = tab.sessionApprovalRules ?? [];
  });
  return JSON.stringify(storedSettings) === inputSettingsKey(tab);
}

/** UI projections never expose provider payloads or session identities. */
export function inputDeliveryViews(
  value: unknown,
  capabilities?: ChatSteeringCapabilities,
): ChatInputDeliveryView[] {
  if (!isInputLedger(value)) return [];
  return value.rows
    .filter(
      (row) =>
        row.dismissedAt === undefined &&
        !isInternalChatRequest(row.payload) &&
        !row.attempts.some(
          (attempt) =>
            attempt.payloadSnapshot !== undefined &&
            isInternalChatRequest(attempt.payloadSnapshot),
        ),
    )
    .map((row) => {
      const agentSent = parseChatAgentSentInfo(row.payload.agentSent);
      return {
        id: row.id,
        revision: row.revision,
        state: row.state,
        text: row.text,
        draft: row.draft,
        editResubmits: row.editResubmits,
        reason: row.reason,
        watcherFired: parseChatWatcherFiredInfo(row.payload.watcherFired),
        ...(agentSent !== undefined ? { agentSent } : {}),
        attachmentCount: row.payload.attachmentPaths?.length ?? 0,
        canWithdraw:
          capabilities?.withdraw === true &&
          capabilities.generation ===
            row.attempts.find((a) => a.id === row.currentAttemptId)?.generation,
        ...(row.state === 'cancelled' &&
        row.notDelivered !== undefined &&
        row.notDelivered.attemptId === row.currentAttemptId
          ? { notDelivered: true }
          : {}),
        ...(isGeneratedInputRequest(row.payload) ? { generated: true } : {}),
      };
    });
}

/**
 * Whether `request` may steer into a session that applied
 * `sessionApprovalMode` and `sessionApprovalRules`: its other settings match
 * the chat's exactly, and the session holds no more approval authority than
 * the request's own turn would start with (`turn`, computed as at turn start).
 * A request narrower than the session therefore gets its own turn, and a
 * wider one gains nothing by steering (see `sessionApprovalWithinTurn`).
 */
export function inputRequestMatchesSettings(
  request: ChatSendMessageRequest,
  tab: PersistedChatTab,
  turn: TurnApproval,
  sessionApprovalMode: ApprovalMode | undefined,
  sessionApprovalRules: readonly ApprovalRule[] | undefined,
): boolean {
  return (
    inputRequestMatchesNonApprovalSettings(request, tab) &&
    sessionApprovalWithinTurn(
      sessionApprovalMode,
      sessionApprovalRules,
      turn,
      tab.sessionApprovalRules ?? [],
    )
  );
}

/** The per-message settings other than approval match the chat's exactly. */
export function inputRequestMatchesNonApprovalSettings(
  request: ChatSendMessageRequest,
  tab: PersistedChatTab,
): boolean {
  const requestExecutionHarness =
    request.executionHarness ??
    (request.model ? getExecutionHarnessForModel(request.model) : undefined) ??
    (request.providerType === 'codex' ? 'codex' : 'claude');
  const requestSignature = [
    request.model ? resolveModelAlias(request.model) : undefined,
    request.providerType,
    requestExecutionHarness,
    request.planMode ?? false,
    request.modelConfig?.thinkingLevel ?? request.thinkingLevel ?? 'high',
    // The exact requested speed, not its `fastMode` projection: Ultra fast
    // and Regular both project `false` but run different service tiers.
    readCodexSpeedRecord(request.modelConfig, request.codexFastModeEnabled) ??
      DEFAULT_CODEX_SPEED,
    request.pluginSelections,
    request.deferredToolsAllowed ?? true,
    // Native Codex tabs omit this renderer-only preference even when their
    // canonical record explicitly says 'canopy'. Both mean the native UI.
    request.interfaceMode ?? 'canopy',
    request.selectedRepoId,
    request.globalInstructionsSnapshot ?? '',
    request.subscriptionBillingOverride ?? false,
    request.aiCreditsRouting,
    request.codexProposalMode ?? 'optional',
  ];
  const tabSignature = [
    tab.model ? resolveModelAlias(tab.model) : undefined,
    tab.providerType,
    tab.executionHarness ??
      (tab.model ? getExecutionHarnessForModel(tab.model) : undefined) ??
      (tab.providerType === 'codex' ? 'codex' : 'claude'),
    tab.planMode ?? false,
    tab.modelConfig?.thinkingLevel ?? tab.thinkingLevel ?? 'high',
    readCodexSpeedRecord(tab.modelConfig, tab.codexFastModeEnabled) ??
      DEFAULT_CODEX_SPEED,
    tab.pluginSelections,
    tab.deferredToolsAllowed ?? true,
    tab.interfaceMode ?? 'canopy',
    tab.selectedRepoId,
    tab.globalInstructionsSnapshot ?? '',
    tab.subscriptionBillingOverride ?? false,
    tab.aiCreditsRouting,
    tab.proposalMode ?? 'optional',
  ];
  return JSON.stringify(requestSignature) === JSON.stringify(tabSignature);
}

/** Detach destination identities and runtime grants while keeping source evidence. */
export function detachInputDelivery(
  tab: PersistedChatTab,
  target: { projectId: string; worktreeId: string; chatId: string },
  createId: () => string,
): PersistedChatTab['inputDelivery'] {
  if (!isInputLedger(tab.inputDelivery)) return tab.inputDelivery;
  // The source chat owns its watchers, delegates, questions and automations.
  // Their undelivered input would otherwise surface in the copy as a message
  // its user sent (the copy strips the markers that identify it).
  const rows = tab.inputDelivery.rows.filter(
    (row) => row.state === 'picked-up' || !isGeneratedInputRequest(row.payload),
  );
  return {
    ...tab.inputDelivery,
    epoch: tab.inputDelivery.epoch + 1,
    rows: rows.map((row) => {
      const id = createId();
      const payload: ChatSendMessageRequest = {
        ...row.payload,
        ...target,
        userMessageId: id,
      };
      delete payload.clientUserMessageId;
      delete payload.sdkSessionId;
      delete payload.claudeForkSession;
      delete payload.codexReconstructionSeedId;
      delete payload.sessionApprovalRules;
      delete payload.approvalMode;
      // What the source chat admitted an agent send against.
      delete payload.admittedApproval;
      delete payload.pluginSelections;
      // A pipeline's per-turn settings, approvals and plugins included.
      delete payload.turnOverride;
      delete payload.nativeAutomationRunInputId;
      delete payload.pendingSystemInstructions;
      // Plan ids are scoped to the source worktree.
      delete payload.activePlan;
      delete payload.aiCreditsRouting;
      delete payload.appAdvisorContext;
      delete payload.hiddenContext;
      // Only unconsumed inputs become new user resubmissions. Picked-up rows
      // and the tab's historical transcript retain their captured attribution.
      if (row.state !== 'picked-up') {
        delete payload.agentSent;
        delete payload.agentSenderProvenance;
      }
      delete payload.asyncQuestionId;
      delete payload.watcherFired;
      delete payload.consolidatedWatcherUserMessageIds;
      delete payload.watcherPartSnapshots;
      delete payload.deferredToolsReloadEnabledResources;
      delete payload.startsNewTrackedChat;
      const state = ['pending', 'sending', 'cancelling', 'uncertain'].includes(
        row.state,
      )
        ? ('uncertain' as const)
        : row.state === 'picked-up'
          ? ('picked-up' as const)
          : ('cancelled' as const);
      const attempts = row.attempts.map((attempt) => {
        const detached = { ...attempt };
        delete detached.submittedText;
        delete detached.payloadSnapshot;
        return detached;
      });
      return {
        ...row,
        id,
        revision: 1,
        state,
        payload,
        attempts,
        currentAttemptId: undefined,
        editResubmits: false,
        queueIntent: undefined,
        ordinaryContinuation: undefined,
        ordinaryOnly: undefined,
        notDelivered: undefined,
        reason:
          state === 'uncertain'
            ? 'Copied message history. Delivery in the source chat was not confirmed.'
            : row.reason,
      };
    }),
  };
}
