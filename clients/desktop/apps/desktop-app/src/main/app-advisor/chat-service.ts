import { assertOpenCodeSelectionAvailable } from '../opencode/selection';
import {
  recordPresentationTurn,
  resolvePresentationSource,
  clearPresentationTurn,
  capturePresentationTurn,
  presentationChatKey,
} from '../canopy-tools/presentation-state';
import { browserHandoffs } from '../browser/browser-handoffs';
import { chatAgentSent } from '@canopy/protocol/portal/external-agent-sender';
import { assertCopilotModelAvailable } from '../copilot/connection';
import { isCopilotRuntimeAvailable } from '../copilot/runtime-availability';
import { getChatQueueService } from '../services/chat-queue-service';
import type { ChatQueueRevivalLease } from '../services/chat-queue-service';
import {
  activatePendingTurnRoute,
  getLiveRoutedSession,
  getOrCreateRoutedSession,
  getTurnRootAcceptance,
  isOwnedDelegationEvent,
  parkBehindWake,
} from '../agents/session-event-router';
import {
  beginChatTurnRun,
  deferredReloadEventNamespace,
  type ChatTurnRunHandle,
} from '../agent-runs/turn-runs';
import type { BrowserWindow } from 'electron';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  GLOBAL_INSTRUCTIONS_SNAPSHOT_EVENT_TYPE,
  IPC_CHANNELS,
  getExecutionHarnessForModel,
  getModelSource,
  getProviderForModel,
  resolveModelAlias,
  resolveProviderModelConfig,
  type AgentProviderType,
  type ApprovalMode,
  type ChatModel,
  type ChatSendMessageRequest,
  type ChatSendMessageDisposition,
  type DeferredToolsReloadEvent,
  type AgentTranscriptInjectedPrompt,
  type PersistedChatMessage,
  type PortalChatMessage,
} from '@canopy/desktop-shared/types';
import { codexServiceTierForModelConfig } from '@canopy/execution-engine/lib/codex-model-config';
import { applyAgentSessionCodexSpeed } from '@canopy/execution-engine/lib/codex-speed';
import { turnSessionApprovalRules } from '@canopy/desktop-shared/lib/send-approval-narrowing';
import {
  appendUserOverallPreferencesBlock,
  buildUserOverallPreferencesBlock,
} from '@canopy/execution-engine/lib/global-instructions';
import { validateId } from '../lib/validation';
import { buildSubmittedMessageText } from '../lib/chat-submitted-message';
import { recordChatEventDropped } from '../lib/chat-event-drop-diagnostics';
import { getAppAdvisorHomeDir } from '../lib/paths';
import { readPreferencesFile } from '../lib/preferences-store';
import { isCursorRuntimeAvailable } from '../cursor/runtime-availability';
import { resolveLaneSubstitutedProviderType } from '../lib/lane-substituted-provider';
import { claudeContinuationSession } from '../lib/claude-fork-continuation';
import { scheduleChatSummary } from '../lib/worktree-chat-turn';
import {
  destroySession,
  restrictSessionApprovalRules,
  getActiveSessionInfos,
  getSessionGlobalInstructionsSnapshot,
  shouldRecreateSessionOnNextTurn,
  isSessionAccountProxyRouted,
  isSessionAiCreditsRouted,
} from '../agents/session-manager';
import { sendToWindowDetailed } from '../lib/window-send';
import { getExecutionObservabilityIngest } from '../observability/ingest';
import {
  getChatTurnAuditStatus,
  isRootTerminalChatEventData,
  isRecord,
  isTerminalChatEventData,
  readCodexRootThreadId,
} from '../lib/chat-turn-audit';
import { describeChatEventData } from '../lib/chat-event-description';
import { getResourceMonitorService } from '../resource-monitor';
import { createAppAdvisorToolRuntime } from './runtime';
import type { AppAdvisorToolRuntimeSurfaces } from './runtime';
import { APP_ADVISOR_SYSTEM_PROMPT } from './system-prompt';
import { APP_ADVISOR_TOOL_REGISTRY } from '@canopy/desktop-shared/lib/app-advisor-tools';
import { stableHash } from '@canopy/desktop-shared/lib/stable-hash';
import { resolveAgentModelRuntime } from '../agents/agent-model-runtime';
import { deferredToolsReloadCoordinator } from '../deferred-tools/reload-coordinator';
import {
  listWorkEntryIds,
  resolveWorkEntryForChat,
} from '../lib/cowork-work-entries';
import {
  createPortalEvent,
  enqueuePortalEvent,
  isCanopyPortalActive,
} from '../portal/portal-event-bus';
import {
  isTerminalRuntimeChatEvent,
  runtimeChatEventToPortalMessage,
} from '../services/chat-transcript-projector';
import { resolveAgentAttachmentsDir } from '../lib/agent-attachments';
import { ensureAppAdvisorHomeScaffold } from '../lib/app-advisor-workspace';
import { getChatStateService } from '../services/chat-state-service';
import type {
  CanonicalChatAddress,
  ChatWatcherEvidence,
} from '@canopy/desktop-shared/lib/chat-watcher-contracts';
import {
  captureChatWatcherEvidence,
  getCanonicalChatTerminalDisposition,
  getCanonicalInputAcceptedAt,
  hasCanonicalTurnVisibleOutput,
  resolveCanonicalChatAddress,
} from '../services/active-chat-input';
import { getAppAdvisorWatcherService } from './watchers';
import {
  consumeDispatchAuthorization,
  wakeParkingOutcome,
  type AuthorizedChatDispatch,
} from '../services/chat-dispatch-authorization';
import { reservePromptBindingSlot } from '../services/chat-turn-binding-slots';
import {
  classifyProviderRunEvent,
  copyProviderRunProvenance,
  getProviderRunDescriptor,
} from '../lib/provider-run-reconciliation';
import {
  claudeForkSessionIdFromInit,
  consumePersistedClaudeForkSessionMarker,
} from '../lib/claude-fork-session-marker';
import { logMainProcessError } from '../lib/main-process-logging';
import { setLiveApprovalMode } from '../approvals/live-approval-modes';
import { resolveChatTurnApprovalAuthority } from '../lib/chat-turn-approval-authority';
import {
  readPersistedChatDispatchMetadata,
  type PersistedChatDispatchMetadata,
} from '../lib/chat-tabs-reader';

/**
 * Last assistant frame the portal seam emitted per chat (CAN-2565), keyed by
 * chatId. Entries are cleared on every terminal runtime event; a surviving
 * entry therefore always describes the still-open turn a cancel needs to
 * close on the portal side.
 */
const lastAssistantPortalMessages = new Map<string, PortalChatMessage>();

/**
 * Visible turns started per chat (sends and starting pickups), so a delayed
 * synthetic cancel can tell a newer turn began before it projected a frame.
 */
const portalTurnEpochs = new Map<string, number>();

type AdvisorChatObservation = {
  address: CanonicalChatAddress;
  evidence: ChatWatcherEvidence;
  sourceInputId: string;
  sourceInputAcceptedAt: string;
};

// A deferred reload shares the accepted input's evidence, not the account
// state at continuation dispatch. This is runtime correlation, not start state;
// the durable Pending/FiredAt metadata remains the sole first-start authority.
const advisorChatObservations = new Map<string, AdvisorChatObservation>();

async function captureAdvisorChatObservation(
  request: ChatSendMessageRequest,
  sourceInputId: string,
  originalAcceptedAt?: string,
): Promise<AdvisorChatObservation | undefined> {
  try {
    const address = await resolveCanonicalChatAddress(request);
    if (!address) return undefined;
    const evidence = await captureChatWatcherEvidence(address);
    const sourceInputAcceptedAt =
      (await getCanonicalInputAcceptedAt(request, sourceInputId)) ??
      originalAcceptedAt;
    if (!sourceInputAcceptedAt) return undefined;
    return {
      address,
      evidence,
      sourceInputId,
      sourceInputAcceptedAt,
    };
  } catch (error) {
    logMainProcessError(
      'Failed to capture App Advisor lifecycle evidence',
      error,
    );
    return undefined;
  }
}

function bumpPortalTurnEpoch(chatId: string): void {
  portalTurnEpochs.set(chatId, (portalTurnEpochs.get(chatId) ?? 0) + 1);
}

function clearPortalFrameForReloadOutcome(
  event: DeferredToolsReloadEvent,
): void {
  if (
    event.scope.projectId !== APP_ADVISOR_PROJECT_ID ||
    event.lifecycle.kind !== 'outcome'
  ) {
    return;
  }
  lastAssistantPortalMessages.delete(event.scope.chatId);
}

deferredToolsReloadCoordinator.subscribe(clearPortalFrameForReloadOutcome);

type AppAdvisorChatDispatchRequest = ChatSendMessageRequest & {
  /**
   * Host-owned namespace for the provider events emitted by a deferred-tools
   * continuation. The continuation intentionally reuses the visible turn's
   * user-message id, so its provider events need another idempotency segment.
   */
  deferredToolsReloadRequestId?: string;
};

/**
 * A projected assistant frame that would render as an empty transcript row: no
 * text and no parts. Some providers close a turn with a content-less assistant
 * record (own UUID, status `complete`); mirroring it left a stray dots bubble
 * at the end of the portal transcript. Guarded here in the App Advisor seam —
 * the narrowest placement — rather than in the shared
 * `runtimeChatEventToPortalMessage`, whose other consumer (the worktree portal
 * path) also persists projected frames and is out of scope for this fix.
 * Restricted to `complete` frames so a failed/cancelled status transition can
 * never be swallowed on text-less frames.
 */
function isEmptyCompleteAssistantFrame(message: PortalChatMessage): boolean {
  return (
    message.role === 'assistant' &&
    message.status === 'complete' &&
    message.text.trim().length === 0 &&
    (message.parts === undefined || message.parts.length === 0)
  );
}

function sendAppAdvisorChatEvent(
  getMainWindow: () => BrowserWindow | null,
  getAppAdvisorWindow: () => BrowserWindow | null,
  projectId: string,
  worktreeId: string,
  chatId: string,
  data: unknown,
  context?: {
    providerType?: AgentProviderType;
    model?: ChatModel;
    fallbackMessageId?: string;
  },
): void {
  const payload = {
    projectId,
    worktreeId,
    chatId,
    data,
  };
  const mainDelivery = sendToWindowDetailed(
    getMainWindow(),
    IPC_CHANNELS.chatEvent,
    payload,
  );
  const appAdvisorDelivery = sendToWindowDetailed(
    getAppAdvisorWindow(),
    IPC_CHANNELS.chatEvent,
    payload,
  );
  const isTerminalEvent = isTerminalRuntimeChatEvent(data);

  // Mirror the turn onto a connected portal session (CAN-2565). The payload
  // deliberately carries no scope/workspace routing — the server pins the
  // `app_advisor` scope from the event type, so a desktop cannot mislabel it.
  if (isCanopyPortalActive()) {
    const emitPortalMessage = (message: PortalChatMessage): void => {
      enqueuePortalEvent(
        createPortalEvent('portal.app_advisor.event', { chatId, message }),
      );
    };
    const message = runtimeChatEventToPortalMessage({
      scope: 'app_advisor',
      chatId,
      data,
      fallbackMessageId: context?.fallbackMessageId,
    });
    // Content-less complete assistant frames are dropped entirely: not
    // mirrored (they render as an empty trailing bubble) and not remembered —
    // a cancel must never re-key 'cancelled' onto an empty frame either.
    if (message && !isEmptyCompleteAssistantFrame(message)) {
      if (message.role === 'assistant') {
        // Remember the last assistant frame per chat: a successful terminal
        // `result` maps to NO portal message, so a later cancel must re-key
        // its 'cancelled' status onto this frame or the portal transcript's
        // last message stays 'streaming' forever.
        lastAssistantPortalMessages.set(chatId, message);
      }
      emitPortalMessage(message);
    }
  }
  if (isTerminalEvent) {
    // The turn is over; a cancel arriving later must not resurrect this
    // frame with a bogus 'cancelled' status. Cleared unconditionally — a
    // portal that disconnects mid-turn and reconnects later must not see a
    // prior turn's frame re-emitted, and cancelling while disconnected must
    // not strand the entry.
    lastAssistantPortalMessages.delete(chatId);
  }

  if (!mainDelivery.delivered && !appAdvisorDelivery.delivered) {
    getExecutionObservabilityIngest().recordSessionDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind: 'chat_event_undelivered',
      sessionKey: `${projectId}/${worktreeId}/${chatId}`,
      projectId,
      worktreeId,
      chatId,
      providerType: context?.providerType ?? 'unknown',
      ...(context?.model ? { model: context.model } : {}),
      eventType: describeChatEventData(data, { includePhaseEvents: true }),
      terminal: isTerminalChatEventData(data),
      sendFailureReason: mainDelivery.reason,
    });
  }
}

async function resolveAppAdvisorCwd(): Promise<string> {
  // App Advisor is a global assistant that operates the app through tools and
  // actions (each scoped by explicit projectId/worktreeId), not through its
  // process cwd. Pointing the agent's cwd at whatever worktree happens to be
  // selected in the main window leaked that worktree's files/CLAUDE.md/git
  // context into every global session and made sessions non-deterministic.
  // Always run from the dedicated App Advisor home directory.
  await ensureAppAdvisorHomeScaffold();
  return getAppAdvisorHomeDir();
}

type DeferredToolsReloadMetadata = NonNullable<
  AgentTranscriptInjectedPrompt['deferredToolsReload']
>;

function buildDeferredToolsReloadMetadata(
  enabledResources: NonNullable<
    ChatSendMessageRequest['deferredToolsReloadEnabledResources']
  >,
): DeferredToolsReloadMetadata {
  return {
    enabledResources: enabledResources.map((resource) => ({
      ref: resource.ref,
      kind: resource.kind,
      name: resource.name,
      ...(resource.sourceLabel ? { sourceLabel: resource.sourceLabel } : {}),
    })),
  };
}

/** Mirrors the worktree builder in services/chat-service.ts. */
function buildPersistedAppAdvisorUserMessage(
  request: ChatSendMessageRequest,
  timestamp: number,
): PersistedChatMessage {
  return {
    id: request.userMessageId,
    role: 'user',
    timestamp,
    blocks: [
      ...(request.fileReferences?.length
        ? [
            {
              type: 'file_references' as const,
              references: request.fileReferences,
            },
          ]
        : []),
      { type: 'text', text: request.text },
    ],
    attachmentPaths: request.attachmentPaths,
    ...(request.attachmentPromptContexts?.length
      ? { attachmentPromptContexts: request.attachmentPromptContexts }
      : {}),
    inputMode: request.inputMode ?? 'typed',
    ...(request.watcherFired ? { watcherFired: request.watcherFired } : {}),
    // A message an external MCP agent sent stays the person's own.
    ...(chatAgentSent(request.agentSent)
      ? { userMessageSource: 'agent' as const }
      : {}),
    ...(request.agentSent ? { agentSent: request.agentSent } : {}),
  };
}

export async function dispatchAppAdvisorChatMessage(
  request: AppAdvisorChatDispatchRequest,
  options: {
    getMainWindow: () => BrowserWindow | null;
    getAppAdvisorWindow: () => BrowserWindow | null;
    toolSurfaces: AppAdvisorToolRuntimeSurfaces;
    /** Trusted host signal; never part of the portable request. */
    onTurnAccepted?: () => void;
    /** Host-only queue admission capability, consumed before any start effect. */
    authorization?: AuthorizedChatDispatch;
    admissionSignal?: AbortSignal;
  },
): Promise<ChatSendMessageDisposition> {
  if (request.projectId !== APP_ADVISOR_PROJECT_ID) {
    throw new Error('App Advisor chat must use the App Advisor project id.');
  }
  if (request.worktreeId === APP_ADVISOR_WORKTREE_ID) {
    throw new Error('App Advisor legacy global chats are read-only.');
  }

  validateId(request.worktreeId, 'worktreeId');
  validateId(request.chatId, 'chatId');
  validateId(request.userMessageId, 'userMessageId');

  const presentationOrigin = {
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    chatTabId: request.chatId,
  };
  const handoffsAtSend = browserHandoffs.captureOrigin(presentationOrigin);
  const continuingTurn = capturePresentationTurn(presentationOrigin);
  const presentationSource = request.deferredToolsReloadRequestId
    ? continuingTurn?.turnId === request.userMessageId
      ? continuingTurn.source
      : undefined
    : resolvePresentationSource(request, 'user');
  const entryIds = await listWorkEntryIds(APP_ADVISOR_PROJECT_ID);
  if (!entryIds.includes(request.worktreeId)) {
    throw new Error(`Unknown App Advisor Work Entry ${request.worktreeId}.`);
  }
  // A Stop or newer dispatch since admission makes this attempt stale.
  consumeDispatchAuthorization(options.authorization, {
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    chatId: request.chatId,
    userMessageId: request.userMessageId,
  });
  const resourceGuard =
    await getResourceMonitorService().reserveChatTurnStart();
  let advisorTurnRun: ChatTurnRunHandle | undefined;
  try {
    const deferredToolsReloadEnabledResources =
      request.deferredToolsReloadEnabledResources;
    const preferences = await readPreferencesFile();
    const persistedDispatchMetadata = await readPersistedChatDispatchMetadata(
      request.projectId,
      request.worktreeId,
      request.chatId,
    ).catch(
      (): PersistedChatDispatchMetadata =>
        ({}) satisfies PersistedChatDispatchMetadata,
    );
    const persistedModel =
      request.model === undefined &&
      request.providerType === undefined &&
      persistedDispatchMetadata.model !== undefined
        ? persistedDispatchMetadata.model
        : undefined;
    const selectedModel =
      request.model ?? persistedModel ?? preferences.appAdvisorModel;
    const laneSubstitutedProviderType = resolveLaneSubstitutedProviderType({
      explicitModel: request.model ?? persistedModel,
      requestedProviderType: request.providerType,
      selectedModel,
    });
    const selectedProviderType =
      laneSubstitutedProviderType ??
      (persistedModel !== undefined
        ? (persistedDispatchMetadata.providerType ??
          getProviderForModel(persistedModel))
        : undefined) ??
      request.providerType ??
      getProviderForModel(selectedModel);

    const thinkingLevel =
      request.thinkingLevel ??
      (persistedModel !== undefined
        ? persistedDispatchMetadata.thinkingLevel
        : undefined) ??
      preferences.appAdvisorThinkingLevel;
    const selectedPluginSelections =
      request.pluginSelections ?? preferences.appAdvisorPluginSelections;
    let activeSession = getActiveSessionInfos(
      request.projectId,
      request.worktreeId,
    ).find(({ chatId }) => chatId === request.chatId);
    const switchesActiveSessionProvider =
      activeSession !== undefined &&
      selectedProviderType !== undefined &&
      activeSession.providerType !== selectedProviderType;
    // A Cursor turn runs on the managed runtime; fail before any chat state
    // is written or a live session of another provider is torn down,
    // matching the worktree chat IPC and Home composer guards.
    if (
      selectedProviderType === 'cursor' &&
      !(await isCursorRuntimeAvailable())
    ) {
      throw new Error(
        'Connect Cursor in Settings to send with Cursor, or choose another model.',
      );
    }
    if (
      selectedProviderType === 'copilot' &&
      !(await isCopilotRuntimeAvailable())
    )
      throw new Error('Connect Copilot in Settings.');
    if (selectedProviderType === 'opencode')
      await assertOpenCodeSelectionAvailable({
        model: selectedModel,
        session: request,
      });
    if (selectedProviderType === 'copilot')
      await assertCopilotModelAvailable(selectedModel);
    if (switchesActiveSessionProvider) {
      await destroySession(
        request.projectId,
        request.worktreeId,
        request.chatId,
      );
      activeSession = undefined;
    }
    // Hydration may replace a cold default before the first turn. Its old
    // persisted harness is not a conversation lock or an explicit user choice.
    const freshModelHarness =
      request.model !== undefined &&
      !activeSession &&
      persistedDispatchMetadata.hasConversation === false &&
      persistedDispatchMetadata.executionHarnessExplicitlyChosen !== true
        ? getExecutionHarnessForModel(selectedModel)
        : undefined;
    const authoritativeExecutionHarness =
      freshModelHarness ??
      // A cross-lane substitution invalidates every remembered harness: the
      // model that will actually run is the substituted one.
      (laneSubstitutedProviderType
        ? getExecutionHarnessForModel(selectedModel)
        : undefined) ??
      (persistedModel !== undefined
        ? (persistedDispatchMetadata.executionHarness ??
          getExecutionHarnessForModel(persistedModel))
        : undefined) ??
      activeSession?.executionHarness ??
      persistedDispatchMetadata.executionHarness ??
      (persistedDispatchMetadata.model
        ? getExecutionHarnessForModel(persistedDispatchMetadata.model)
        : undefined) ??
      getExecutionHarnessForModel(selectedModel) ??
      (selectedProviderType === 'codex' ? 'codex' : 'claude');
    if (
      request.executionHarness !== undefined &&
      request.executionHarness !== authoritativeExecutionHarness &&
      // Callers forward the tab's persisted harness, so a substituted turn
      // arrives holding the OLD lane's harness.
      laneSubstitutedProviderType === undefined
    ) {
      throw new Error(
        'App Advisor execution harness does not match host-owned routing',
      );
    }
    const runtime = await resolveAgentModelRuntime({
      projectId: APP_ADVISOR_PROJECT_ID,
      model: selectedModel,
      systemPromptAppend: APP_ADVISOR_SYSTEM_PROMPT,
      pluginSelections: selectedPluginSelections,
      providerType: selectedProviderType,
    });
    const model = runtime.runtimeModel;
    const providerType = runtime.providerType;
    const executionHarness = authoritativeExecutionHarness;
    // Copilot and OpenCode reload after a native tool-result receipt.
    // Cursor does not yet provide that boundary.
    const deferredToolsAllowed =
      executionHarness !== 'cursor' &&
      (request.deferredToolsAllowed ??
        persistedDispatchMetadata.deferredToolsAllowed) !== false;
    const pluginSelections =
      runtime.pluginSelections ?? selectedPluginSelections;
    // Global Instructions (Instructions settings) — resolved per session context
    // into a "User Overall Preferences" block appended after the App Advisor
    // system prompt (and any Agent instructions). Reaches the provider only
    // when a session is created, never an already-live one.
    const chatGlobalInstructions = preferences.globalInstructions?.chats;
    const currentGlobalInstructionsBlock = chatGlobalInstructions
      ? buildUserOverallPreferencesBlock(chatGlobalInstructions, {
          harness: providerType,
          model: resolveModelAlias(model ?? ''),
          workspaceType: 'app-advisor',
        })
      : '';
    const resumingProviderSession =
      request.sdkSessionId !== undefined &&
      laneSubstitutedProviderType === undefined &&
      !switchesActiveSessionProvider;
    const globalInstructionsBlock = resumingProviderSession
      ? (request.globalInstructionsSnapshot ??
        getSessionGlobalInstructionsSnapshot(
          request.projectId,
          request.worktreeId,
          request.chatId,
        ) ??
        '')
      : currentGlobalInstructionsBlock;
    const systemPromptAppend =
      appendUserOverallPreferencesBlock(
        runtime.systemPromptAppend ?? APP_ADVISOR_SYSTEM_PROMPT,
        globalInstructionsBlock,
      ) ?? APP_ADVISOR_SYSTEM_PROMPT;
    const observedSystemPromptAppend = systemPromptAppend;
    const cwd = await resolveAppAdvisorCwd();
    const attachmentBaseDir = resolveAgentAttachmentsDir(
      request.projectId,
      request.worktreeId,
    );
    const visibleSubmittedText = buildSubmittedMessageText({
      text: request.text,
      fileReferences: request.fileReferences,
      attachmentPaths: request.attachmentPaths,
      attachmentPromptContexts: request.attachmentPromptContexts,
      attachmentBaseDir,
      cwd,
      inputMode: request.inputMode,
      pendingSystemInstructions: request.pendingSystemInstructions,
    });
    const providerSubmittedText = request.hiddenContext?.text
      ? [request.hiddenContext.text, '', visibleSubmittedText].join('\n')
      : visibleSubmittedText;

    if (
      shouldRecreateSessionOnNextTurn(
        request.projectId,
        request.worktreeId,
        request.chatId,
      )
    ) {
      await destroySession(
        request.projectId,
        request.worktreeId,
        request.chatId,
      );
    }

    const turnApproval = await resolveChatTurnApprovalAuthority(request);
    let toolApprovalMode = turnApproval.approvalMode;
    const toolApprovalContext = {
      providerType,
      get approvalMode(): ApprovalMode {
        // Warm sessions retain this runtime, not the next dispatch's context.
        return (
          toolApprovalSession?.getAppliedApprovalMode?.() ?? toolApprovalMode
        );
      },
      sessionApprovalRules: turnApproval.sessionApprovalRules,
      pluginSelections,
      deferredToolsAllowed,
    };
    const appAdvisorRuntime = createAppAdvisorToolRuntime(
      options.toolSurfaces,
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: request.worktreeId,
        chatId: request.chatId,
      },
      toolApprovalContext,
    );
    const toolProfileHash = stableHash({
      mode: 'app-advisor',
      approvalMode: turnApproval.approvalMode,
      providerType,
      model,
      thinkingLevel,
      pluginSelections,
      deferredToolsAllowed,
      codexMultiAgentEnabled: preferences.codexMultiAgentAppAdvisorEnabled,
      codexMaxConcurrentSubagents: preferences.codexMaxConcurrentSubagents,
      tools: Object.values(APP_ADVISOR_TOOL_REGISTRY).map((tool) => ({
        key: tool.canonicalKey,
        claude: tool.claudeToolName,
        codex: tool.codexToolName,
      })),
    });
    const modelConfig = resolveProviderModelConfig(
      executionHarness,
      {
        thinkingLevel,
        modelConfig:
          request.modelConfig ??
          (persistedModel !== undefined
            ? persistedDispatchMetadata.modelConfig
            : undefined),
      },
      preferences.providerModelConfigDefaults,
    );
    const chatStateService = getChatStateService();
    // Trusted send's atomic compare-and-create has no chat command equivalent in Phase 0A.
    await chatStateService.ensureChatForTrustedSend({
      ...request,
      approvalMode: turnApproval.chatApprovalMode,
      providerType,
      model: selectedModel,
      executionHarness,
      modelConfig,
      pluginSelections,
      deferredToolsAllowed,
    });
    const isDeferredToolsReloadContinuation =
      request.deferredToolsReloadEnabledResources !== undefined;
    if (!isDeferredToolsReloadContinuation) {
      const promptTimestamp = Date.now();
      const promptCommitted = await chatStateService.ingestProviderEvent({
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        chatId: request.chatId,
        data: {
          type: 'canopy_user_prompt',
          original_text: request.text,
          canopy_turn_user_message_id: request.userMessageId,
          provider: providerType,
          canopy_persisted_messages: [
            buildPersistedAppAdvisorUserMessage(request, promptTimestamp),
          ],
        },
        mutationId: `${request.chatId}:${request.userMessageId}:user-prompt`,
        providerType,
        turnUserMessageId: request.userMessageId,
      });
      if (!promptCommitted) {
        const accepted = await chatStateService.hasMutation(
          { projectId: request.projectId, worktreeId: request.worktreeId },
          `${request.chatId}:${request.userMessageId}:accepted`,
        );
        if (accepted) {
          options.onTurnAccepted?.();
          return 'already_accepted';
        }
      }
    }
    if (!isDeferredToolsReloadContinuation) {
      scheduleChatSummary({
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        chatId: request.chatId,
        cwd,
        getWindow: options.getMainWindow,
        getAdditionalWindows: () => [options.getAppAdvisorWindow()],
        linkTarget: {
          page: 'main',
          kind: 'app-advisor',
          chatId: request.chatId,
        },
      });
    }
    let executionUserMessageId = request.userMessageId;
    const rejectedTurnRoots = new Map<
      string,
      ChatQueueRevivalLease | undefined
    >();
    let codexRootThreadId = request.sdkSessionId;
    let eventCommitTail = Promise.resolve();
    const retainedObservation = advisorChatObservations.get(request.chatId);
    let observation =
      isDeferredToolsReloadContinuation &&
      retainedObservation?.sourceInputId === request.userMessageId
        ? retainedObservation
        : undefined;
    const settledInputs = new Set<string>();
    const inputObservations = new Map<
      string,
      Promise<AdvisorChatObservation | undefined>
    >();
    if (observation) {
      inputObservations.set(
        observation.sourceInputId,
        Promise.resolve(observation),
      );
    }
    // A continuation revives the settled turn only until it settles again;
    // later frames (such as Claude's command lifecycle) must not reopen it.
    let continuationSettled = false;
    let eventSequence = 0;
    const sessionBeforeDispatch = getLiveRoutedSession(request);
    setLiveApprovalMode(
      request.projectId,
      request.worktreeId,
      request.chatId,
      turnApproval.chatApprovalMode,
    );
    const turnRun = await beginChatTurnRun({
      scope: {
        workspaceId: request.projectId,
        worktreeId: request.worktreeId,
        chatId: request.chatId,
      },
      turnId: executionUserMessageId,
      eventNamespace: request.deferredToolsReloadRequestId
        ? deferredReloadEventNamespace(request.deferredToolsReloadRequestId)
        : 'initial',
      providerId: providerType,
      model: model ?? null,
      initiationSource: request.initiationSource ?? 'user',
      settleOn: 'root-terminal',
      codexRootThreadId,
    });
    advisorTurnRun = turnRun;
    const session = await turnRun.execute(() =>
      getOrCreateRoutedSession(
        {
          cwd,
          projectId: request.projectId,
          worktreeId: request.worktreeId,
          chatId: request.chatId,
          planMode: false,
          approvalMode: turnApproval.approvalMode,
          sessionApprovalRules: turnApproval.sessionApprovalRules,
          thinkingLevel: modelConfig.thinkingLevel,
          modelConfig,
          model,
          selectedModel,
          // A provider's session id is meaningless to the other one, and
          // `getOrCreateSession` has no provider-change guard — see
          // `worktree-chat-turn.ts`.
          ...(laneSubstitutedProviderType || switchesActiveSessionProvider
            ? {}
            : {
                sdkSessionId: request.sdkSessionId,
                // An independent fork (StartForkedAgent) must branch the source
                // Claude session rather than resume it, as on the worktree path.
                ...(request.claudeForkSession
                  ? { claudeForkSession: true }
                  : {}),
                ...(request.claudeForkSession && request.claudeForkResumeAt
                  ? { claudeForkResumeAt: request.claudeForkResumeAt }
                  : {}),
                ...(request.claudeForkSession &&
                request.claudeForkResumeAt &&
                request.claudeForkToolResults?.length
                  ? { claudeForkToolResults: request.claudeForkToolResults }
                  : {}),
              }),
          ...(request.claudeForkStartsFresh
            ? { claudeForkStartsFresh: true }
            : {}),
          pluginSelections,
          deferredToolsAllowed,
          systemPromptAppend:
            runtime.systemPromptAppend ?? APP_ADVISOR_SYSTEM_PROMPT,
          globalInstructionsBlock,
          globalInstructionsSnapshot: resumingProviderSession
            ? globalInstructionsBlock
            : undefined,
          providerType,
          executionHarness,
          codexAppServerIdleTimeoutMinutes:
            preferences.codexAppServerIdleTimeoutMinutes,
          codexMultiAgentEnabled: preferences.codexMultiAgentAppAdvisorEnabled,
          codexMaxConcurrentSubagents: preferences.codexMaxConcurrentSubagents,
          // Claude and Cursor both rewrite shell commands through the bundled
          // RTK hook; Codex has no rewrite seam.
          rtkEnabled:
            executionHarness === 'claude' ||
            executionHarness === 'cursor' ||
            executionHarness === 'copilot' ||
            executionHarness === 'opencode'
              ? preferences.rtkEnabled
              : false,
          assistantMode: 'app-advisor',
          toolProfileHash,
          appAdvisorRuntime,
        },
        turnRun.observe(
          (
            data: unknown,
            markPersistenceSettled?: () => void,
          ): Promise<void> => {
            const receiptClassification = classifyProviderRunEvent(data, {
              projectId: request.projectId,
              worktreeId: request.worktreeId,
              chatId: request.chatId,
            });
            const isLateAtReceipt = receiptClassification.kind !== 'ordinary';
            // Router acceptance metadata is held against the original routed event.
            // A deferred-tools continuation clone below cannot carry that metadata.
            const turnRootAcceptance = getTurnRootAcceptance(data);
            if (!isLateAtReceipt) {
              codexRootThreadId =
                readCodexRootThreadId(data) ?? codexRootThreadId;
            }
            const occurredAt = new Date(Date.now()).toISOString();
            let pickupObservation:
              | Promise<AdvisorChatObservation | undefined>
              | undefined;
            if (
              isRecord(data) &&
              data.type === 'canopy_input_delivery' &&
              data.phase === 'picked-up' &&
              data.startsTurn === true &&
              data.turnRootAccepted !== false &&
              typeof data.userMessageId === 'string'
            ) {
              pickupObservation =
                inputObservations.get(data.userMessageId) ??
                captureAdvisorChatObservation(request, data.userMessageId);
              inputObservations.set(data.userMessageId, pickupObservation);
            }
            const forkSessionId =
              !isLateAtReceipt && request.claudeForkSession
                ? claudeForkSessionIdFromInit(data)
                : null;
            if (forkSessionId) {
              void consumePersistedClaudeForkSessionMarker({
                workspaceId: request.projectId,
                worktreeId: request.worktreeId,
                chatId: request.chatId,
                sessionId: forkSessionId,
              }).catch(() => undefined);
            }
            // Capture the terminal's role before queued persistence. The reload
            // coordinator can finish starting the continuation while this event
            // waits for disk, but the old terminal must still keep its timer open.
            const preservePortalTimerForDeferredReload =
              !isLateAtReceipt &&
              isTerminalRuntimeChatEvent(data) &&
              deferredToolsReloadCoordinator.hasActiveReload({
                projectId: request.projectId,
                worktreeId: request.worktreeId,
                chatId: request.chatId,
              });
            const providerEvent =
              isDeferredToolsReloadContinuation &&
              !continuationSettled &&
              isRecord(data) &&
              !isLateAtReceipt
                ? copyProviderRunProvenance(data, {
                    ...data,
                    canopy_turn_revival: true,
                  })
                : data;
            if (
              !isLateAtReceipt &&
              isDeferredToolsReloadContinuation &&
              isRootTerminalChatEventData(data, codexRootThreadId)
            ) {
              continuationSettled = true;
            }
            const eventData = isRecord(providerEvent) ? providerEvent : null;
            const isStartingPickup = Boolean(
              eventData &&
              eventData.type === 'canopy_input_delivery' &&
              eventData.phase === 'picked-up' &&
              eventData.startsTurn === true &&
              typeof eventData.userMessageId === 'string',
            );
            // At receipt, before the commit tail: a cancel still awaiting its
            // lookup must already see that a newer turn began.
            if (isStartingPickup) bumpPortalTurnEpoch(request.chatId);
            const sequence = eventSequence;
            eventSequence += 1;
            eventCommitTail = eventCommitTail
              .then(async () => {
                const providerRunClassification = classifyProviderRunEvent(
                  providerEvent,
                  {
                    projectId: request.projectId,
                    worktreeId: request.worktreeId,
                    chatId: request.chatId,
                  },
                );
                if (providerRunClassification.kind === 'reject') {
                  const descriptor = getProviderRunDescriptor(providerEvent);
                  recordChatEventDropped({
                    projectId: request.projectId,
                    worktreeId: request.worktreeId,
                    chatId: request.chatId,
                    providerType,
                    gate: 'canonical_admission_rejected',
                    reason: providerRunClassification.reason,
                    data: providerEvent,
                    turnUserMessageId:
                      descriptor?.executionUserMessageId ??
                      executionUserMessageId,
                  });
                  markPersistenceSettled?.();
                  return;
                }
                if (providerRunClassification.kind === 'transcript_only') {
                  await chatStateService.ingestProviderEventWithResult({
                    projectId: request.projectId,
                    worktreeId: request.worktreeId,
                    chatId: request.chatId,
                    data: providerEvent,
                    mutationId: request.deferredToolsReloadRequestId
                      ? `${request.chatId}:${request.userMessageId}:deferred-reload:${request.deferredToolsReloadRequestId}:provider:${sequence}`
                      : `${request.chatId}:${request.userMessageId}:provider:${sequence}`,
                    providerType,
                    turnUserMessageId:
                      providerRunClassification.run.executionUserMessageId,
                  });
                  markPersistenceSettled?.();
                  return;
                }
                const taggedRootId =
                  eventData &&
                  typeof eventData.canopy_turn_user_message_id === 'string'
                    ? eventData.canopy_turn_user_message_id
                    : undefined;
                const isIdleStatusEvent =
                  eventData?.type === 'system' &&
                  eventData.subtype === 'status' &&
                  eventData.status === 'idle';
                // A delegate's snapshot keeps the tag of the turn that started
                // it, so it is delivered even when that root was rejected.
                if (
                  taggedRootId &&
                  rejectedTurnRoots.has(taggedRootId) &&
                  !isStartingPickup &&
                  !isOwnedDelegationEvent(eventData)
                ) {
                  const rejectedLease = rejectedTurnRoots.get(taggedRootId);
                  if (
                    rejectedLease &&
                    isRootTerminalChatEventData(eventData, codexRootThreadId)
                  ) {
                    // Retry cleanup only with the exact rejected lease. A newer
                    // same-id acceptance has a different epoch and is untouched.
                    getChatQueueService().rollbackTurnRevival(
                      request,
                      rejectedLease,
                    );
                  }
                  if (isIdleStatusEvent) {
                    // Idle is lifecycle-only for a rejected root. Session activity
                    // listeners also reconcile, but wake reconciliation here when
                    // this tagged provider frame is the only idle signal.
                    getChatQueueService().reconcileSessionActivity();
                  }
                  markPersistenceSettled?.();
                  return;
                }

                const ingestResult =
                  await chatStateService.ingestProviderEventWithResult({
                    projectId: request.projectId,
                    worktreeId: request.worktreeId,
                    chatId: request.chatId,
                    data: providerEvent,
                    mutationId: request.deferredToolsReloadRequestId
                      ? `${request.chatId}:${request.userMessageId}:deferred-reload:${request.deferredToolsReloadRequestId}:provider:${sequence}`
                      : `${request.chatId}:${request.userMessageId}:provider:${sequence}`,
                    providerType,
                    turnUserMessageId: executionUserMessageId,
                  });
                markPersistenceSettled?.();
                if (
                  isStartingPickup &&
                  eventData &&
                  typeof eventData.userMessageId === 'string' &&
                  turnRootAcceptance?.accepted === true &&
                  turnRootAcceptance.lease
                ) {
                  const pickupRootId = eventData.userMessageId;
                  const isCurrentExecutionRoot =
                    pickupRootId === executionUserMessageId;
                  if (
                    ingestResult.pickup === 'accepted' ||
                    ingestResult.pickup === 'already-accepted'
                  ) {
                    const confirmed = getChatQueueService().confirmTurnRevival(
                      request,
                      turnRootAcceptance.lease,
                    );
                    if (confirmed) {
                      if (!isCurrentExecutionRoot) {
                        executionUserMessageId = pickupRootId;
                      }
                      rejectedTurnRoots.delete(pickupRootId);
                      observation = await pickupObservation;
                      if (observation)
                        advisorChatObservations.set(
                          request.chatId,
                          observation,
                        );
                    } else if (!isCurrentExecutionRoot) {
                      getChatQueueService().rollbackTurnRevival(
                        request,
                        turnRootAcceptance.lease,
                      );
                      if (!rejectedTurnRoots.has(pickupRootId)) {
                        rejectedTurnRoots.set(
                          pickupRootId,
                          turnRootAcceptance.lease,
                        );
                      }
                    } else {
                      getChatQueueService().rollbackTurnRevival(
                        request,
                        turnRootAcceptance.lease,
                      );
                    }
                  } else if (!isCurrentExecutionRoot) {
                    getChatQueueService().rollbackTurnRevival(
                      request,
                      turnRootAcceptance.lease,
                    );
                    if (!rejectedTurnRoots.has(pickupRootId)) {
                      rejectedTurnRoots.set(
                        pickupRootId,
                        turnRootAcceptance.lease,
                      );
                    }
                  }
                }
                // A router refusal remains a false-stamped presentation event even
                // when canonical pickup observation rejects it. Other rejected
                // provider events must not be observed or delivered.
                const routerRefusal =
                  isStartingPickup && turnRootAcceptance?.accepted === false;
                if (ingestResult.outcome === 'not-applied' && !routerRefusal) {
                  return;
                }
                getExecutionObservabilityIngest().observeChatEvent(
                  request.projectId,
                  request.worktreeId,
                  request.chatId,
                  providerEvent,
                );
                sendAppAdvisorChatEvent(
                  options.getMainWindow,
                  options.getAppAdvisorWindow,
                  request.projectId,
                  request.worktreeId,
                  request.chatId,
                  providerEvent,
                  {
                    providerType,
                    model,
                    // Same synthetic-id convention as the worktree portal path
                    // so provider events without their own message id still land
                    // on a stable per-turn assistant row.
                    fallbackMessageId: `${executionUserMessageId}:assistant`,
                  },
                );
                if (
                  eventData &&
                  isRootTerminalChatEventData(eventData, codexRootThreadId)
                ) {
                  if (preservePortalTimerForDeferredReload) {
                    return;
                  }
                  const status = getChatTurnAuditStatus(eventData);
                  getChatQueueService().onTurnTerminal(
                    request,
                    status === 'success'
                      ? 'complete'
                      : status === 'failure'
                        ? 'error'
                        : 'cancelled',
                    executionUserMessageId,
                  );
                  const error =
                    eventData.type === 'error'
                      ? typeof eventData.error === 'string'
                        ? eventData.error
                        : 'Unknown error'
                      : eventData.is_error === true &&
                          typeof eventData.result === 'string'
                        ? eventData.result
                        : undefined;
                  clearPresentationTurn(
                    presentationChatKey(presentationOrigin),
                    executionUserMessageId,
                  );
                  getExecutionObservabilityIngest().completeChatTurn(
                    request.projectId,
                    request.worktreeId,
                    request.chatId,
                    status,
                    error,
                  );
                  // Resolve the root here, inside the ordered commit stream. A
                  // pickup queued before this terminal must win, but a later
                  // pickup must not steal this terminal while disk is blocked.
                  const terminalObservation = observation;
                  if (
                    ingestResult.outcome === 'applied' &&
                    terminalObservation &&
                    terminalObservation.sourceInputId ===
                      executionUserMessageId &&
                    !settledInputs.has(executionUserMessageId)
                  ) {
                    settledInputs.add(executionUserMessageId);
                    const hasVisibleOutput =
                      await hasCanonicalTurnVisibleOutput(
                        request,
                        executionUserMessageId,
                      );
                    await getAppAdvisorWatcherService().handleCanonicalChatTerminalEvent(
                      {
                        kind: 'terminal',
                        eventId: `canonical-chat:${stableHash(terminalObservation.address)}:${executionUserMessageId}:terminal`,
                        ...terminalObservation,
                        occurredAt,
                        observedAt: new Date(Date.now()).toISOString(),
                        disposition: getCanonicalChatTerminalDisposition(
                          eventData,
                          status,
                          hasVisibleOutput,
                        ),
                      },
                    );
                    if (
                      advisorChatObservations.get(request.chatId) ===
                      terminalObservation
                    ) {
                      advisorChatObservations.delete(request.chatId);
                    }
                  }
                }
              })
              .catch((error: unknown) => {
                markPersistenceSettled?.();
                logMainProcessError(
                  `Failed to durably commit App Advisor event for ${request.worktreeId}/${request.chatId}`,
                  error,
                );
              });
            return eventCommitTail;
          },
        ),
        () => options.getAppAdvisorWindow() ?? options.getMainWindow(),
        {
          turnUserMessageId: executionUserMessageId,
          // An admitted dispatch is a pending destination, so a wake already
          // running keeps its output (as on the worktree path).
          ...(options.authorization
            ? {
                dispatchOwner: options.authorization.dispatchOwner,
                operationEpoch: options.authorization.operationEpoch,
              }
            : {}),
          acceptTurnRoot: async (turnUserMessageId) => {
            await eventCommitTail;
            return getChatQueueService().acceptTurnRevival(
              request,
              turnUserMessageId,
            );
          },
          drainEventsBeforeRemoval: () => eventCommitTail,
        },
      ),
    );
    const toolApprovalSession = session;
    const authoritativeGlobalInstructionsSnapshot =
      getSessionGlobalInstructionsSnapshot(
        request.projectId,
        request.worktreeId,
        request.chatId,
      ) ?? globalInstructionsBlock;
    if (
      request.globalInstructionsSnapshot !==
      authoritativeGlobalInstructionsSnapshot
    ) {
      sendAppAdvisorChatEvent(
        options.getMainWindow,
        options.getAppAdvisorWindow,
        request.projectId,
        request.worktreeId,
        request.chatId,
        {
          type: GLOBAL_INSTRUCTIONS_SNAPSHOT_EVENT_TYPE,
          globalInstructionsSnapshot: authoritativeGlobalInstructionsSnapshot,
        },
      );
    }

    deferredToolsReloadCoordinator.registerResumeHandler(
      {
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        chatId: request.chatId,
      },
      async (reloadRequest) => {
        reloadRequest.signal.throwIfAborted();
        const continuationOrigin = capturePresentationTurn(presentationOrigin);
        // This turn consumed its capability. The continuation is admitted
        // through the hold the reload took at its interruption, once its
        // predecessor's end commits.
        const admission =
          await getChatQueueService().admitDirectDispatchWhenAllowed(
            {
              projectId: request.projectId,
              worktreeId: request.worktreeId,
              chatId: request.chatId,
            },
            reloadRequest.userMessageId,
            reloadRequest.signal,
            reloadRequest.requestId,
          );
        reloadRequest.signal.throwIfAborted();
        if (!admission)
          throw new Error('The reload could not continue this chat.');
        const {
          authorization: _consumedAuthorization,
          ...continuationOptions
        } = options;
        void _consumedAuthorization;
        try {
          await getChatStateService().runWithScopeActivity(
            {
              projectId: request.projectId,
              worktreeId: request.worktreeId,
            },
            () =>
              dispatchAppAdvisorChatMessage(
                {
                  ...request,
                  userMessageId: reloadRequest.userMessageId,
                  text: reloadRequest.continuationText,
                  ...claudeContinuationSession(request, {
                    requestedSessionId: reloadRequest.sdkSessionId,
                    providerSessionId: session.getProviderSessionId?.(),
                  }),
                  providerType: reloadRequest.providerType ?? providerType,
                  pluginSelections:
                    reloadRequest.pluginSelections ?? pluginSelections,
                  hiddenContext: undefined,
                  agentSent: undefined,
                  agentSenderProvenance: undefined,
                  fileReferences: undefined,
                  attachmentPaths: undefined,
                  attachmentPromptContexts: undefined,
                  deferredToolsReloadEnabledResources:
                    reloadRequest.enabledResources,
                  deferredToolsReloadRequestId: reloadRequest.requestId,
                  initiationSource:
                    continuationOrigin?.turnId === reloadRequest.userMessageId
                      ? continuationOrigin.source
                      : undefined,
                },
                {
                  ...continuationOptions,
                  ...(admission.authorization
                    ? { authorization: admission.authorization }
                    : {}),
                },
              ),
          );
        } catch (error) {
          admission.release();
          throw error;
        }
        if (reloadRequest.signal.aborted) {
          await destroySession(
            request.projectId,
            request.worktreeId,
            request.chatId,
          );
          reloadRequest.signal.throwIfAborted();
        }
      },
    );

    // Apply the exact requested Codex speed before any turn effect (audit
    // turn, portal frames, acceptance, provider send). A session that cannot
    // receive Ultra fast rejects the send here instead of running at another
    // speed; the in-session admission runs again right before `turn/start`.
    await applyAgentSessionCodexSpeed(session, modelConfig.speed);
    await session.setContextWindow?.(modelConfig.contextWindow);
    // A wake that started while the prompt was prepared keeps the foreground,
    // and the prompt parks behind it (contracts §3), before its audit turn.
    // A wake needs an earlier turn on this session, as on the worktree path.
    const parkingOwner =
      executionHarness === 'codex' || session === sessionBeforeDispatch
        ? options.authorization
        : undefined;
    const parkedEarly = parkingOwner && wakeParkingOutcome(parkingOwner);
    if (parkedEarly) await parkBehindWake(request, parkedEarly);

    if (deferredToolsReloadEnabledResources) {
      getExecutionObservabilityIngest().recordInjectedPromptForOpenChatTurn(
        request.projectId,
        request.worktreeId,
        request.chatId,
        {
          kind: 'system_prompt_append',
          provider: providerType,
          applicationCondition: 'deferred_tools_reload_continuation',
          text: request.text,
          deferredToolsReload: buildDeferredToolsReloadMetadata(
            deferredToolsReloadEnabledResources,
          ),
        },
      );
    } else {
      getExecutionObservabilityIngest().startChatTurn({
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        chatId: request.chatId,
        provider: providerType,
        model,
        modelSource: getModelSource(model),
        executionHarness,
        serviceTier:
          executionHarness === 'codex'
            ? codexServiceTierForModelConfig(modelConfig)
            : undefined,
        aiCreditsRouted: isSessionAiCreditsRouted(
          request.projectId,
          request.worktreeId,
          request.chatId,
        ),
        accountProxyRouted: isSessionAccountProxyRouted(
          request.projectId,
          request.worktreeId,
          request.chatId,
        ),
        originalUserText: request.text,
        submittedText: visibleSubmittedText,
        fileReferences: request.fileReferences,
        planMode: false,
        systemPromptAppend: observedSystemPromptAppend,
        userMessageId: request.userMessageId,
        isStandalone: false,
        assistantMode: 'app-advisor',
        initiationSource: request.initiationSource ?? 'app_advisor',
      });
    }

    await session.setPlanMode(false);
    if (
      (providerType === 'claude' ||
        providerType === 'cursor' ||
        providerType === 'copilot' ||
        providerType === 'opencode') &&
      session.setRtkEnabled
    ) {
      await session.setRtkEnabled(preferences.rtkEnabled);
    }
    if (session.setCodexAppServerIdleTimeoutMinutes) {
      await session.setCodexAppServerIdleTimeoutMinutes(
        preferences.codexAppServerIdleTimeoutMinutes,
      );
    }
    // The last check comes before the Portal frames and the accepted record:
    // a re-dispatch of an accepted prompt would not send it again.
    const parked = parkingOwner && wakeParkingOutcome(parkingOwner);
    if (parked) {
      if (!deferredToolsReloadEnabledResources)
        getExecutionObservabilityIngest().completeChatTurn(
          request.projectId,
          request.worktreeId,
          request.chatId,
          'interrupted',
        );
      await parkBehindWake(request, parked);
    }
    // Single choke point for renderer- and portal-originated sends, so the
    // user message reaches a connected portal exactly once regardless of
    // origin (CAN-2565). Emitted only once every validation/session step has
    // succeeded — the same optimistic point the worktree path uses — so a
    // failed dispatch cannot leave a completed-looking user message with no
    // failure transition. Deferred-tools reload continuations are excluded:
    // their continuation text is an injected prompt the desktop transcript
    // never renders as a user bubble, so the portal must not either.
    if (isCanopyPortalActive() && !isDeferredToolsReloadContinuation) {
      enqueuePortalEvent(
        createPortalEvent('portal.app_advisor.event', {
          chatId: request.chatId,
          message: {
            messageId: request.userMessageId,
            chatId: request.chatId,
            role: 'user',
            status: 'complete',
            text: request.text,
            createdAtMs: Date.now(),
            ...(request.agentSent ? { agentSent: request.agentSent } : {}),
          },
        }),
      );
      // Canonical turn state publishes committed timer rows to the portal.
    }
    // A new visible turn supersedes any prior turn's remembered assistant
    // frame — a cancel racing this dispatch must not re-key 'cancelled' onto
    // the previous turn's content.
    lastAssistantPortalMessages.delete(request.chatId);
    if (!isDeferredToolsReloadContinuation) {
      bumpPortalTurnEpoch(request.chatId);
      const occurredAt = new Date(Date.now()).toISOString();
      observation = await captureAdvisorChatObservation(
        request,
        request.userMessageId,
        occurredAt,
      );
      const accepted = await chatStateService.ingestProviderEvent({
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        chatId: request.chatId,
        data: {
          type: 'canopy_user_prompt_accepted',
          canopy_turn_user_message_id: request.userMessageId,
        },
        mutationId: `${request.chatId}:${request.userMessageId}:accepted`,
        providerType,
        turnUserMessageId: request.userMessageId,
      });
      if (accepted && observation) {
        inputObservations.set(
          observation.sourceInputId,
          Promise.resolve(observation),
        );
        advisorChatObservations.set(request.chatId, observation);
        try {
          if (
            await chatStateService.claimNewChatStarted({
              projectId: request.projectId,
              worktreeId: request.worktreeId,
              chatId: request.chatId,
              sourceInputId: request.userMessageId,
              occurredAt: observation.sourceInputAcceptedAt,
            })
          ) {
            await getAppAdvisorWatcherService().handleCanonicalChatStartedEvent(
              {
                kind: 'started',
                eventId: `canonical-chat:${stableHash(observation.address)}:${request.userMessageId}:started`,
                address: observation.address,
                evidence: observation.evidence,
                sourceInputId: observation.sourceInputId,
                occurredAt: observation.sourceInputAcceptedAt,
                observedAt: new Date(Date.now()).toISOString(),
              },
            );
          }
        } catch (error) {
          logMainProcessError(
            'Failed to publish App Advisor chat start',
            error,
          );
        }
      }
    }
    const liveApprovalAuthority = await resolveChatTurnApprovalAuthority(
      request,
      { checkAdmission: false },
    );
    restrictSessionApprovalRules(
      request.projectId,
      request.worktreeId,
      request.chatId,
      liveApprovalAuthority.sessionApprovalRules,
    );
    // Provider sessions and retained Advisor runtimes share this array.
    const narrowedToolRules = turnSessionApprovalRules(
      toolApprovalContext.sessionApprovalRules,
      undefined,
      liveApprovalAuthority.sessionApprovalRules,
    );
    toolApprovalContext.sessionApprovalRules.splice(
      0,
      toolApprovalContext.sessionApprovalRules.length,
      ...narrowedToolRules,
    );
    toolApprovalMode = liveApprovalAuthority.approvalMode;
    setLiveApprovalMode(
      request.projectId,
      request.worktreeId,
      request.chatId,
      liveApprovalAuthority.chatApprovalMode,
    );
    await session.setApprovalMode(liveApprovalAuthority.approvalMode);
    options.admissionSignal?.throwIfAborted();
    turnRun.signal.throwIfAborted();
    // The destination activates at the send for every provider: a Claude
    // start carries no binding receipt, and a Codex start forks from it.
    if (options.authorization)
      activatePendingTurnRoute(
        request,
        options.authorization.dispatchOwner,
        options.authorization.operationEpoch,
      );
    reservePromptBindingSlot(request, request.userMessageId);
    recordPresentationTurn(
      presentationChatKey(presentationOrigin),
      request.userMessageId,
      presentationSource,
    );
    try {
      turnRun.executeSync(() =>
        session.sendMessage(providerSubmittedText, {
          userMessageId: request.userMessageId,
          ...(executionHarness === 'opencode' && request.attachmentPaths?.length
            ? {
                attachments: {
                  baseDir: attachmentBaseDir,
                  paths: [...request.attachmentPaths],
                },
              }
            : {}),
        }),
      );
      turnRun.accepted();
    } catch (error) {
      clearPresentationTurn(
        presentationChatKey(presentationOrigin),
        request.userMessageId,
      );
      throw error;
    }
    if (
      !isDeferredToolsReloadContinuation &&
      session.isDisposed?.() !== true &&
      (presentationSource === 'user' || presentationSource === 'portal')
    ) {
      for (const id of handoffsAtSend) browserHandoffs.release(id);
    }
    options.onTurnAccepted?.();
    return 'dispatched';
  } catch (error) {
    advisorTurnRun?.abandon(error);
    throw error;
  } finally {
    resourceGuard.release();
  }
}

/** Whether the turn a Stop captured still owns this chat's portal frame and timer. */
export interface AppAdvisorSyntheticResultFence {
  readonly isCurrent: () => boolean;
}

export interface AppAdvisorSyntheticResultOptions {
  readonly fence: AppAdvisorSyntheticResultFence;
  /** The stopped turn; tags the synthetic result so it cannot settle a newer turn. */
  readonly userMessageId?: string;
  /** Caller's session check, for a newer send or wake that projected nothing yet. */
  readonly isCurrent?: () => boolean;
}

/**
 * Capture synchronously, before any await. A newer turn, or any newer frame,
 * counts as a replacement of the stopped turn.
 */
export function captureAppAdvisorSyntheticResultFence(
  chatId: string,
): AppAdvisorSyntheticResultFence {
  const frame = lastAssistantPortalMessages.get(chatId);
  const epoch = portalTurnEpochs.get(chatId);
  return {
    isCurrent: (): boolean =>
      portalTurnEpochs.get(chatId) === epoch &&
      lastAssistantPortalMessages.get(chatId) === frame,
  };
}

/**
 * Fan out the synthetic un-stream event a cancel needs (CAN-2565). Provider
 * cancellation is authoritative in the session manager, but the renderer's
 * visible turn only closes on a terminal chat event — the same ordered
 * `result` record `emitHostQueueForcedCancellation` sends for worktree chats.
 * Routed through {@link sendAppAdvisorChatEvent} so both desktop windows
 * observe it on the same path as live provider events.
 *
 * The portal needs its own closing frame: a non-error terminal `result`
 * deliberately projects to NO portal message, so the seam alone would leave
 * the portal transcript's last assistant message 'streaming' forever. Re-emit
 * the last streamed assistant frame with status 'cancelled' — same messageId
 * and content, so the server's merge cannot clobber streamed text — then
 * re-project the entry's summaries so `turnActive` clears immediately. A chat
 * that never streamed an assistant frame just gets the summary re-projection.
 *
 * The live portal turn timer is terminalized on this same path: the synthetic
 * `result` is a terminal runtime event, so {@link sendAppAdvisorChatEvent}
 * emits the timer's completion frame and clears its map entry while fanning
 * the cancel out — the browser's turn lifecycle ends alongside the
 * 'cancelled' re-key below.
 */
export async function emitAppAdvisorSyntheticResultEvent(
  chatId: string,
  surfaces: AppAdvisorToolRuntimeSurfaces,
  options?: AppAdvisorSyntheticResultOptions,
): Promise<void> {
  const fence = options?.fence ?? captureAppAdvisorSyntheticResultFence(chatId);
  const { entryId } = await resolveWorkEntryForChat(
    APP_ADVISOR_PROJECT_ID,
    chatId,
  );
  if (!entryId) {
    return;
  }
  // A real terminal or a newer turn replaced the stopped turn while the lookup
  // awaited; its frame and timer are no longer this cancel's to close. Nothing
  // async runs between this check and the fan-out below.
  if (!fence.isCurrent() || options?.isCurrent?.() === false) {
    return;
  }
  // Captured BEFORE the fan-out: the synthetic result is a terminal event,
  // so the seam clears this chat's frame while delivering it.
  const lastAssistantFrame = lastAssistantPortalMessages.get(chatId);
  sendAppAdvisorChatEvent(
    surfaces.getMainWindow,
    surfaces.getAppAdvisorWindow,
    APP_ADVISOR_PROJECT_ID,
    entryId,
    chatId,
    {
      type: 'result',
      is_error: false,
      result: 'Cancelled',
      ...(options?.userMessageId
        ? { canopy_turn_user_message_id: options.userMessageId }
        : {}),
    },
  );
  if (!isCanopyPortalActive()) {
    return;
  }
  if (lastAssistantFrame) {
    enqueuePortalEvent(
      createPortalEvent('portal.app_advisor.event', {
        chatId,
        message: {
          ...lastAssistantFrame,
          status: 'cancelled',
          updatedAtMs: Date.now(),
        },
      }),
    );
  }
  const { projectAppAdvisorChatSummaries } =
    await import('../services/chat-service');
  await projectAppAdvisorChatSummaries(entryId).catch(() => undefined);
}
