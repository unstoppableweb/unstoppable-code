import {
  assertCoworkChatRootPresent,
  CoworkFolderMissingError,
} from '../lib/cowork-folder-guard';
import { randomUUID } from 'node:crypto';
import {
  parseChatSendAction,
  type AgentSendAcceptanceFacts,
  type InlineChatWatcherReservation,
} from '@canopy/desktop-shared/lib/chat-send-actions';
import {
  STANDALONE_CHAT_PROJECT_ID,
  type ChatCommandEnvelope,
  type ChatCreateTabCommand,
  type ChatSendAutomationDispatch,
  type ChatSendMessageRequest,
  type ChatSendTurnOverride,
} from '@canopy/desktop-shared/types';
import {
  botIdForProjectId,
  isBotProjectId,
} from '@canopy/protocol/chat-targets';
import {
  buildAgentSenderRequest,
  buildPipelineSenderRequest,
  changesAuthority,
  revalidateAgentSenderRequest,
  isAgentSenderContextError,
  type PipelineSenderSource,
} from './sender-context';
import { isAutomationRunSource } from './automation-run-source';
import { resolveAuthorizedChat } from '../project-discovery/chat-target';
import type { BotChatAddress } from '@canopy/desktop-shared/lib/bot-discovery';
import { mergeAgentModelConfig } from '@canopy/execution-engine/lib/codex-speed';
import type { ChatReadScope } from '../project-discovery/chat-target';
import type { PersistedChatTab } from '@canopy/desktop-shared/types';
import type { ProjectDiscoveryCaller } from '../project-discovery';
import { DiscoveryError } from '../project-discovery/errors';
import {
  ensureBotRegistryLoaded,
  requireBotWorkspace,
} from '../project-discovery/bots/registry';
import { getActiveDesktopRuntime } from '../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import {
  createChatCommandDispatchOptions,
  dispatchTrustedChatCommand,
} from '../canopy-runtime/core-chat-command-adapter';
import { withLegacyChatMessageCommand } from '../canopy-runtime/core-chat-message-command-adapter';
import {
  automationDispatchRequestFields,
  isCreationSeed,
  withAutomationInitiation,
} from './automation-dispatch';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { getChatStateCommandPort } from '../ipc/chat-state';
import {
  withChatSendAdmission,
  type ChatSendAdmissionCheck,
} from '../services/chat-send-admission';
import { resolveCoworkWorkspaceId } from '../lib/cowork-migration-map';
import type {
  AcceptedInputReceipt,
  AgentSendRefusalCode,
  ChatSendAction,
  InlineChatWatcherReservationPort,
} from '@canopy/desktop-shared/lib/chat-send-actions';
import type {
  AppAdvisorWatcherDestination,
  ApprovalMode,
} from '@canopy/desktop-shared/types';
import type { AppAdvisorToolRuntimeSurfaces } from '../app-advisor/runtime';
import type { AgentSenderRuntimeSource } from './sender-context';
import { BackgroundExecutionRefusedError } from '../services/background-execution-refusal';

/** The calling session, resolved only from a trusted main-process runtime. */
export type TrustedSendCaller =
  | { kind: 'project_root'; source: AgentSenderRuntimeSource }
  | { kind: 'app_advisor'; source: AgentSenderRuntimeSource }
  | { kind: 'pipeline'; source: PipelineSenderSource };

async function requireBotWorkspaceForProjectId(
  projectId: string,
): Promise<void> {
  const botId = botIdForProjectId(projectId);
  if (botId) {
    await ensureBotRegistryLoaded?.();
    requireBotWorkspace(botId);
  }
}

async function requireSendBotWorkspaces(
  action: ChatSendAction,
  caller: TrustedSendCaller,
): Promise<void> {
  if (action.type === 'bots.send_message') {
    await ensureBotRegistryLoaded?.();
    requireBotWorkspace(action.botId);
  } else await requireBotWorkspaceForProjectId(action.projectId);

  const sourceProjectId =
    caller.kind === 'pipeline'
      ? caller.source.agentOrigin?.projectId
      : caller.source.projectId;
  if (sourceProjectId) await requireBotWorkspaceForProjectId(sourceProjectId);
}

/**
 * A pipeline creation's new-chat seed. Any field present forces a new chat,
 * as an explicit model does.
 */
export type PipelineNewChatSeed = Pick<
  ChatCreateTabCommand,
  | 'model'
  | 'providerType'
  | 'modelConfig'
  | 'planMode'
  | 'approvalMode'
  | 'pluginSelections'
  | 'interfaceMode'
>;

/**
 * The seed settings a native grant covers (CAN-5479): what D11 refuses an
 * agent-originated run's new chat. `model` only for an Orchestrator chat.
 */
export type PipelineNativeGrantSeed = Pick<
  PipelineNewChatSeed,
  'approvalMode' | 'pluginSelections' | 'model'
>;

/**
 * Host-step replays: fixed IDs, so a resend finds the original receipt.
 * `create_task` actions cannot replay: their task ID is not pinned here, so
 * the host step refuses them. Pin it before routing one through fixed IDs.
 */
export interface AgentSendFixedIds {
  commandId: string;
  userMessageId: string;
  /**
   * A creation's chat: the tab it creates, or, on a replay, the chat it chose
   * before (`reusedTab` when that was an empty chat it reused). A host step
   * allocates it before the first attempt, so a creation whose
   * `onChatResolved` failed is found again on replay, never created twice.
   */
  tabId?: string;
  reusedTab?: true;
  createTabCommandId?: string;
  /** A replayed steer reports the replay's time; the host journal keeps the first. */
  steerCommandId?: string;
}

/**
 * A message's approval admission: the check the chat state owner runs as the
 * message commits, and, after it refused, the typed refusal.
 */
export interface AgentSendAdmission {
  check: ChatSendAdmissionCheck;
  refusal(): AgentChatSendError | undefined;
}

export interface AgentChatSendContext {
  caller: TrustedSendCaller;
  /**
   * Root project sends: reads the target chat's approval admission before the
   * send, throwing a typed refusal, and checks it again as the message commits.
   */
  admission?: (target: ChatReadScope) => Promise<AgentSendAdmission>;
  /**
   * Root project creations: the approval mode a chat the agent creates in
   * this task starts in. With a first message, refuses before anything is
   * created a chat whose approvals that message's admission would refuse.
   */
  startAdmission?: (
    task: { workspaceId: string; worktreeId: string },
    firstMessage: boolean,
    /** The task is a worktree this creation just made beside the caller's. */
    newWorktree?: boolean,
  ) => Promise<{ approvalMode: ApprovalMode; selectedRepoId?: string }>;
  /**
   * Root project creations: refuses a first message the caller could not
   * start a chat with, before the creation writes anything.
   */
  startPrecheck?: (targetWorkspaceId: string) => Promise<void>;
  /**
   * The originating root chat; inline watchers notify it, never the target.
   * A pipeline has none, so its sends cannot register watchers.
   */
  watcherDestination?: AppAdvisorWatcherDestination;
  /** Main-only per-turn settings (D2). Never set for agent actions. */
  turnOverride?: ChatSendTurnOverride;
  /**
   * Pipeline text references and attachments, on the public command fields.
   * Passed through unchecked: the caller must contain every path to the run's
   * workspace by realpath before dispatch, as an agent-originated run's paths
   * come from that agent.
   */
  composition?: Pick<
    ChatSendMessageRequest,
    | 'fileReferences'
    | 'attachmentPaths'
    | 'attachmentPromptContexts'
    | 'inputMode'
  >;
  fixedIds?: AgentSendFixedIds;
  /**
   * Main-only: the first message of a chat this creation started in a new
   * worktree. The creation's start admission, against the root carried into
   * that worktree, stands in for the send admission, and the queued delivery
   * is readmitted as a started chat's first message, as chat.create's was.
   */
  startedChat?: true;
  newChatSeed?: PipelineNewChatSeed;
  /**
   * Trusted, main-only (CAN-5479): the seed settings a converted agent
   * automation's native grant covers, which the send step verified against
   * the run. A creation keeps them where D11 would refuse them, only for a
   * step in a run an automation started, and only while the seed carries
   * exactly these. Never set for agent actions.
   */
  nativeGrant?: PipelineNativeGrantSeed;
  /**
   * Host-step creations: called with the chosen chat before its first message
   * is sent, so a replay can pass it back as `fixedIds.tabId`.
   */
  onChatResolved?: (chat: {
    chatId: string;
    created: boolean;
  }) => Promise<void>;
  /**
   * Trusted: a pipeline host step's journaled task ID for `*.create_task`.
   * Ignored for chat callers; never taken from the action payload.
   */
  plannedTaskId?: string;
  toolUseId?: string;
  /** Window access for sends through the retained App Advisor path. */
  surfaces?: AppAdvisorToolRuntimeSurfaces;
  /**
   * Main-only (CAN-4549): an automation's own send facts. Only with an
   * automation sender; never for agent actions or pipeline steps.
   */
  automationDispatch?: ChatSendAutomationDispatch;
  /**
   * Trusted, automation only (CAN-5379): the task was created by this run, so
   * its one blank starter chat, if the renderer added one, is replaced by the
   * seeded chat in the same commit, leaving the task one chat as the native
   * send did. Ignored for any other caller.
   */
  reuseStarterChat?: true;
  /**
   * Trusted (CAN-4551): always a new chat, never the task's empty one, which
   * may be a person's draft, as a native automation send into an existing
   * worktree did.
   */
  newChat?: true;
  /** Injected in tests; defaults to the App Advisor watcher service. */
  watchers?: InlineChatWatcherReservationPort;
}

/** A typed refusal at acceptance; never a success receipt without identity. */
export class AgentChatSendError extends Error {
  constructor(
    readonly code: AgentSendRefusalCode,
    message: string,
    cause?: Error,
  ) {
    super(message);
    if (cause) Object.defineProperty(this, 'cause', { value: cause });
    this.name = 'AgentChatSendError';
  }
}

export function isAgentChatSendError(
  error: unknown,
): error is AgentChatSendError {
  return error instanceof AgentChatSendError;
}

/**
 * Sends one agent message to a project or bot chat with trusted sender
 * context, reserving inline completion watchers bound to the accepted input.
 * Project sends cross `core.chat.message.send`; bot sends use the retained
 * App Advisor trusted-send path. Never navigates, except that a foreground
 * automation send (a user's Run now) brings its target chat forward.
 */
export async function dispatchAgentChatSend(
  action: ChatSendAction,
  context: AgentChatSendContext,
): Promise<AcceptedInputReceipt> {
  try {
    return await send(action, context);
  } catch (error) {
    if (error instanceof CoworkFolderMissingError)
      throw new AgentChatSendError(error.code, error.message, error);
    if (isAgentSenderContextError(error)) {
      const hidden =
        error.code === 'owner_boundary' ||
        error.code === 'authorization_conflict';
      throw new AgentChatSendError(
        hidden ? 'not_found' : error.code,
        hidden ? 'The target chat is not available.' : error.message,
      );
    }
    if (error instanceof DiscoveryError)
      throw new AgentChatSendError(
        error.code === 'advisor_access_disabled'
          ? 'advisor_access_disabled'
          : error.code === 'unsupported_action'
            ? 'unsupported_action'
            : 'not_found',
        error.code === 'unsupported_action'
          ? error.message
          : 'The target chat is not available.',
      );
    throw error;
  }
}

async function send(
  input: ChatSendAction,
  context: AgentChatSendContext,
): Promise<AcceptedInputReceipt> {
  const parsed = parseChatSendAction(input);
  if (!parsed.ok)
    throw new AgentChatSendError('validation_failed', parsed.message);
  const action = parsed.action;
  const trusted = context.caller;
  await requireSendBotWorkspaces(action, trusted);
  const pipeline = trusted.kind === 'pipeline' ? trusted.source : undefined;
  let source: AgentSenderRuntimeSource | undefined;
  let caller: ProjectDiscoveryCaller;
  if (trusted.kind === 'pipeline') {
    if (action.watchers?.length)
      throw new AgentChatSendError(
        'unsupported_action',
        'A pipeline send cannot register completion watchers.',
      );
    caller = pipelineDiscoveryCaller(trusted.source);
  } else {
    source = await canonicalSource(trusted.source);
    if ((trusted.kind === 'app_advisor') !== isBotProjectId(source.projectId))
      throw new AgentChatSendError(
        'validation_failed',
        'The trusted sender runtime is inconsistent.',
      );
    caller =
      trusted.kind === 'app_advisor'
        ? { kind: 'app_advisor', chatId: source.chatId }
        : { kind: 'project_agent', ...source };
  }
  const override = context.turnOverride;
  // D11: an agent-originated run never changes the target's authority.
  if (pipeline?.agentOrigin && override && changesAuthority(override))
    throw new AgentChatSendError(
      'authorization_conflict',
      'An agent-originated run cannot change the target chat’s model, plan mode, plugins or approvals.',
    );
  if (override && !pipeline)
    throw new AgentChatSendError(
      'validation_failed',
      'Only a pipeline send carries per-turn settings.',
    );
  // A step in a run an automation started carries them too (CAN-4551).
  if (
    context.automationDispatch &&
    (pipeline === undefined || !isAutomationRunSource(pipeline))
  )
    throw new AgentChatSendError(
      'validation_failed',
      'Only an automation’s own send carries automation dispatch facts.',
    );
  const automationDispatch =
    context.automationDispatch && pipeline
      ? withAutomationInitiation(
          context.automationDispatch,
          pipeline,
          action.type === 'bots.send_message' ? 'bot' : 'project',
          // Only a creation's first message carries its new chat's seed.
          isCreationSeed(context.newChatSeed),
        )
      : context.automationDispatch;
  // An automation's own session prompt kept its model, runtime and plugins
  // on an Orchestrator chat before CAN-4549, and so does a step in a run an
  // automation started (CAN-4551); an agent-originated one never.
  const automationBotSettings =
    pipeline !== undefined &&
    isAutomationRunSource(pipeline) &&
    !pipeline.agentOrigin;
  if (
    override &&
    action.type === 'bots.send_message' &&
    !automationBotSettings &&
    !appliesToBotChat(override)
  )
    throw new AgentChatSendError(
      'unsupported_action',
      'Orchestrator chats accept only thinking effort, fast mode, plan mode and approval mode.',
    );
  const target =
    action.type === 'projects.send_message'
      ? await resolveAuthorizedChat(
          {
            projectId: action.projectId,
            taskId: action.taskId,
            chatId: action.chatId,
          },
          caller,
        )
      : await resolveBotTarget(action, caller);
  // Matches discovery: an expired session is read-only (canSend: false).
  if (
    target.tab.readOnly ||
    target.tab.staleSessionDetected !== undefined ||
    target.tab.kind === 'file'
  )
    throw new AgentChatSendError(
      'not_found',
      'The target chat is not available.',
    );
  if (
    action.type === 'projects.send_message' &&
    target.projectType === 'cowork' &&
    action.queueForSetup !== undefined
  )
    throw new AgentChatSendError(
      'unsupported_action',
      'Setup queuing is only supported for code targets.',
    );
  await assertCoworkChatRootPresent(
    target.scope.workspaceId,
    target.scope.worktreeId,
  );
  // A pipeline is not a chat: it may report back to the chat that started it.
  if (
    source &&
    source.projectId === target.scope.workspaceId &&
    source.worktreeId === target.scope.worktreeId &&
    source.chatId === target.scope.chatId
  )
    throw new AgentChatSendError(
      'unsupported_action',
      'A chat cannot send a message to itself.',
    );
  const userMessageId = context.fixedIds?.userMessageId ?? randomUUID();
  const commandId = context.fixedIds?.commandId ?? randomUUID();
  const port = getChatStateCommandPort();
  if (!port)
    throw new AgentChatSendError(
      'target_not_ready',
      'Chat command dispatch is unavailable.',
    );
  // A host-step replay returns the original acceptance without a second commit.
  const replayed = context.fixedIds
    ? (
        await port.getCommandReceipt?.({
          projectId: target.scope.workspaceId,
          worktreeId: target.scope.worktreeId,
          commandId,
        })
      )?.agentSendAcceptance
    : undefined;
  if (replayed) {
    // The stored receipt must be this input's, not another send's.
    if (replayed.acceptedInputId !== userMessageId)
      throw new AgentChatSendError(
        'validation_failed',
        'The replayed command belongs to another message.',
      );
    return acceptedReceipt(target.address, replayed, []);
  }
  const admission =
    action.type === 'projects.send_message' &&
    context.admission &&
    !context.startedChat
      ? await context.admission(target.scope)
      : undefined;
  const fields = pipeline
    ? await buildPipelineSenderRequest(
        pipeline,
        userMessageId,
        target.scope.workspaceId,
      )
    : source
      ? await buildAgentSenderRequest(
          source,
          userMessageId,
          target.scope.workspaceId,
        )
      : {};
  const composition = {
    ...(context.composition?.fileReferences
      ? { fileReferences: context.composition.fileReferences }
      : {}),
    ...(context.composition?.attachmentPaths
      ? { attachmentPaths: context.composition.attachmentPaths }
      : {}),
    ...(context.composition?.attachmentPromptContexts
      ? {
          attachmentPromptContexts:
            context.composition.attachmentPromptContexts,
        }
      : {}),
    ...(context.composition?.inputMode
      ? { inputMode: context.composition.inputMode }
      : {}),
  };
  const request: ChatSendMessageRequest = {
    projectId: target.scope.workspaceId,
    worktreeId: target.scope.worktreeId,
    chatId: target.scope.chatId,
    userMessageId,
    text: action.text,
    ...fields,
    ...composition,
    ...(action.type === 'projects.send_message' && action.queueForSetup
      ? {
          agentSendSetup: {
            version: 1 as const,
            ...(context.startedChat ? { startedChat: true as const } : {}),
          },
        }
      : {}),
  };
  await revalidateAgentSenderRequest(request);
  const envelope: ChatCommandEnvelope = {
    schemaVersion: 1,
    commandId,
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    command: {
      type: 'chat.send_message',
      chatId: request.chatId,
      userMessageId,
      text: request.text,
      ...fields,
      ...composition,
      ...(request.agentSendSetup
        ? { agentSendSetup: request.agentSendSetup }
        : {}),
      ...(override ? { turnOverride: override } : {}),
      ...(automationDispatch ? { automationDispatch } : {}),
    },
  };
  let acceptance: AgentSendAcceptanceFacts | undefined;
  const executionOptions = {
    onAgentSendAccepted: (facts: AgentSendAcceptanceFacts): void => {
      acceptance = facts;
    },
  };
  const watchers = action.watchers?.length
    ? (context.watchers ??
      (await import('../app-advisor/watchers')).getAppAdvisorWatcherService())
    : undefined;
  let reservation: InlineChatWatcherReservation | undefined;
  if (watchers) {
    const destination = context.watcherDestination;
    if (!destination)
      throw new AgentChatSendError(
        'validation_failed',
        'Completion watchers need the calling chat.',
      );
    let reserved: Awaited<
      ReturnType<typeof watchers.reserveInlineChatWatchers>
    >;
    try {
      reserved = await watchers.reserveInlineChatWatchers({
        destination,
        recipient: { kind: 'root' },
        createdByToolUseId: context.toolUseId,
        target: target.address,
        entries: action.watchers ?? [],
        acceptedInputId: userMessageId,
        commandId,
      });
    } catch (error) {
      // Watchers are reserved before the send, so a refused one stops it
      // (CAN-6900): the caller is told it wasn't sent, and why.
      if (error instanceof BackgroundExecutionRefusedError)
        throw new AgentChatSendError(
          'policy_blocked',
          `Not sent. ${error.message}`,
          error,
        );
      throw error;
    }
    if (!reserved.ok)
      throw new AgentChatSendError(reserved.code, reserved.error);
    reservation = reserved.reservation;
  }
  let definitelyRefused = false;
  try {
    if (action.type === 'projects.send_message') {
      const dispatch = (): ReturnType<typeof dispatchTrustedChatCommand> =>
        dispatchTrustedChatCommand(envelope, {
          ...createChatCommandDispatchOptions(port, getActiveDesktopRuntime(), {
            principalId: 'local-desktop-user',
            clientInstanceId: 'agent-chat-send',
            authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
            interfaceKind: 'mcp',
            grants: ['core.chat.write'],
          }),
          executionOptions,
        });
      const result = admission
        ? await withChatSendAdmission(
            {
              projectId: request.projectId,
              worktreeId: request.worktreeId,
              chatId: request.chatId,
              userMessageId,
            },
            admission.check,
            dispatch,
          )
        : await dispatch();
      if (
        result.outcome !== 'applied' &&
        result.outcome !== 'already_applied'
      ) {
        definitelyRefused = true;
        throw (
          admission?.refusal() ??
          new AgentChatSendError(
            result.outcome === 'not_found' ? 'not_found' : 'target_not_ready',
            result.reason ?? 'The target refused this input.',
          )
        );
      }
    } else {
      const {
        buildExistingTabDispatchOptions,
        getRegisteredAppAdvisorSurfaces,
        sendWorktreeChatMessage,
      } = await import('../services/chat-service');
      // Root project callers have no Advisor window access of their own.
      const surfaces = context.surfaces ?? getRegisteredAppAdvisorSurfaces();
      const settings = await buildExistingTabDispatchOptions(
        request.projectId,
        request.worktreeId,
        request.chatId,
      );
      await withLegacyChatMessageCommand(
        envelope,
        () =>
          sendWorktreeChatMessage(
            // The retained Advisor path skips the command-to-request mapping,
            // so the override's turn settings and automation facts apply here.
            {
              ...request,
              ...settings,
              ...botTurnSettings(override, settings, automationBotSettings),
              ...automationDispatchRequestFields(automationDispatch),
            },
            {
              getWindow: surfaces?.getMainWindow,
              appAdvisorSurfaces: surfaces,
              ...(automationDispatch?.executionContext !== undefined
                ? { executionContext: automationDispatch.executionContext }
                : {}),
              // A user's Run now comes forward, as the native send did.
              preserveActiveTab: automationDispatch
                ? automationDispatch.presentation === 'background'
                : true,
            },
          ),
        undefined,
        executionOptions,
      );
    }
    if (!acceptance)
      acceptance = (await port.getCommandReceipt?.(envelope))
        ?.agentSendAcceptance;
    if (!acceptance)
      throw new Error(
        'Agent send acceptance could not be confirmed; do not resend this input.',
      );
  } catch (error) {
    if (!acceptance) {
      try {
        acceptance = (await port.getCommandReceipt?.(envelope))
          ?.agentSendAcceptance;
      } catch {
        /* Ambiguous acceptance keeps the reservation inert for recovery. */
      }
    }
    // An unexpected failure after the commit: the target's own state says
    // whether it holds this input, so an accepted send is not reported as
    // unknown.
    if (
      !acceptance &&
      !definitelyRefused &&
      !(error instanceof AgentChatSendError) &&
      !isAgentSenderContextError(error)
    ) {
      logMainProcessWarn(
        `[agent-send] Send ${commandId} to chat ${request.chatId} failed after dispatch; confirming from chat state:`,
        error,
      );
      acceptance = await acceptanceFromChatState(port, request).catch(
        () => undefined,
      );
    }
    if (!acceptance) {
      if (
        reservation &&
        watchers &&
        (definitelyRefused || isAgentSenderContextError(error))
      )
        await watchers.cancelInlineChatWatchers(reservation.reservationId);
      throw error;
    }
  }
  if (
    action.type === 'projects.send_message' &&
    automationDispatch?.presentation === 'foreground'
  )
    await activateAutomationTarget(port, request);
  const watcherReceipts =
    reservation && watchers
      ? await watchers.confirmInlineChatWatchers(
          reservation.reservationId,
          acceptance,
        )
      : [];
  return acceptedReceipt(target.address, acceptance, watcherReceipts);
}

/**
 * This input as the target chat holds it: a queued row carrying its message
 * id, or the message itself in the chat's transcript. Undefined when neither
 * is there, which leaves the outcome unknown.
 */
async function acceptanceFromChatState(
  port: NonNullable<ReturnType<typeof getChatStateCommandPort>>,
  request: Pick<
    ChatSendMessageRequest,
    'projectId' | 'worktreeId' | 'chatId' | 'userMessageId'
  >,
): Promise<AgentSendAcceptanceFacts | undefined> {
  const state = await port.getState({
    projectId: request.projectId,
    worktreeId: request.worktreeId,
  });
  const acceptedAt = new Date().toISOString();
  const queued = state.runtimeByChatId[request.chatId]?.queuedMessages?.find(
    (row) => row.request.userMessageId === request.userMessageId,
  );
  if (queued)
    return {
      acceptedInputId: request.userMessageId,
      disposition: 'queued',
      queuedMessageId: queued.id,
      acceptedAt,
    };
  const tab = state.tabsFile.tabs.find((entry) => entry.id === request.chatId);
  return tab?.messages.some((message) => message.id === request.userMessageId)
    ? {
        acceptedInputId: request.userMessageId,
        disposition: 'started',
        acceptedAt,
      }
    : undefined;
}

function acceptedReceipt(
  address: AcceptedInputReceipt['address'],
  acceptance: AgentSendAcceptanceFacts,
  watcherReceipts: AcceptedInputReceipt['watcherReceipts'],
): AcceptedInputReceipt {
  const base = {
    address,
    acceptedAt: acceptance.acceptedAt,
    watcherReceipts,
  };
  if (acceptance.disposition === 'queued') {
    if (!acceptance.queuedMessageId)
      throw new Error('Queued acceptance is missing its host queue identity.');
    return {
      ...base,
      disposition: 'queued',
      queuedMessageId: acceptance.queuedMessageId,
      messageId: acceptance.acceptedInputId,
    };
  }
  return {
    ...base,
    disposition: 'started',
    messageId: acceptance.acceptedInputId,
  };
}

/**
 * A user's Run now brings its existing target chat forward, as the native
 * send did. Presentation only: the input is already accepted, so a failure
 * is logged with IDs and never fails the send.
 */
async function activateAutomationTarget(
  port: NonNullable<ReturnType<typeof getChatStateCommandPort>>,
  request: Pick<ChatSendMessageRequest, 'projectId' | 'worktreeId' | 'chatId'>,
): Promise<void> {
  try {
    await dispatchTrustedChatCommand(
      {
        schemaVersion: 1,
        commandId: randomUUID(),
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        command: { type: 'chat.activate_tab', tabId: request.chatId },
      },
      createChatCommandDispatchOptions(port, getActiveDesktopRuntime(), {
        principalId: 'local-desktop-user',
        clientInstanceId: 'agent-chat-send',
        authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
        interfaceKind: 'mcp',
        grants: ['core.chat.write'],
      }),
    );
  } catch (error) {
    logMainProcessWarn(
      `[agent-send] Could not bring automation chat ${request.chatId} forward:`,
      error,
    );
  }
}

/** The discovery caller a pipeline's sends, steers and creations authorize as. */
export function pipelineDiscoveryCaller(
  source: PipelineSenderSource,
): Extract<ProjectDiscoveryCaller, { kind: 'pipeline' }> {
  return {
    kind: 'pipeline',
    owner: source.owner,
    ...(source.agentOrigin ? { agentOrigin: source.agentOrigin } : {}),
  };
}

/** Orchestrator chats keep their own runtime: only these settings apply. */
function appliesToBotChat(override: ChatSendTurnOverride): boolean {
  return (
    override.model === undefined &&
    override.providerType === undefined &&
    override.executionHarness === undefined &&
    override.resetRuntime === undefined &&
    override.pluginSelections === undefined
  );
}

function botTurnSettings(
  override: ChatSendTurnOverride | undefined,
  settings: Pick<ChatSendMessageRequest, 'modelConfig'>,
  /** An automation's own send: the override applies as its native send did. */
  automation: boolean,
): Partial<ChatSendMessageRequest> {
  if (!override) return {};
  if (automation)
    return {
      turnOverride: override,
      // A changed runtime cannot resume the chat's session.
      ...(override.resetRuntime
        ? {
            sdkSessionId: undefined,
            globalInstructionsSnapshot: undefined,
            codexReconstructionSeedId: undefined,
            claudeForkSession: undefined,
            claudeForkResumeAt: undefined,
            claudeForkStartsFresh: undefined,
            providerType: override.providerType,
            executionHarness: override.executionHarness,
          }
        : {}),
      ...(override.model ? { model: override.model } : {}),
      ...(override.modelConfig ? { modelConfig: override.modelConfig } : {}),
      ...(override.planMode !== undefined
        ? { planMode: override.planMode }
        : {}),
      ...(override.approvalMode ? { approvalMode: override.approvalMode } : {}),
      ...(override.pluginSelections
        ? { pluginSelections: override.pluginSelections }
        : {}),
    };
  return {
    turnOverride: override,
    ...(override.modelConfig
      ? {
          modelConfig: mergeAgentModelConfig(
            settings.modelConfig,
            override.modelConfig,
          ),
        }
      : {}),
    ...(override.planMode !== undefined ? { planMode: override.planMode } : {}),
    ...(override.approvalMode ? { approvalMode: override.approvalMode } : {}),
  };
}

export async function canonicalSource(
  source: AgentSenderRuntimeSource,
): Promise<AgentSenderRuntimeSource> {
  const projectId = resolveCoworkWorkspaceId(
    source.projectId === STANDALONE_CHAT_PROJECT_ID
      ? source.worktreeId
      : source.projectId,
  );
  if (projectId === source.projectId) return source;
  const { resolveWorkEntryForChat } =
    await import('../lib/cowork-work-entries');
  const owner = await resolveWorkEntryForChat(projectId, source.chatId);
  if (!owner.entryId || owner.archivedInEntryId)
    throw new AgentChatSendError(
      'not_found',
      'The sender chat is not available.',
    );
  return { projectId, worktreeId: owner.entryId, chatId: source.chatId };
}

async function resolveBotTarget(
  action: Extract<ChatSendAction, { type: 'bots.send_message' }>,
  caller: ProjectDiscoveryCaller,
): Promise<{
  address: BotChatAddress;
  projectType: 'cowork';
  scope: ChatReadScope;
  tab: PersistedChatTab;
}> {
  const { requireBotAccess, readBotEntries } =
    await import('../project-discovery/bots/target');
  const bot = requireBotWorkspace(action.botId);
  await requireBotAccess(caller);
  if (
    !(await readBotEntries(bot.botId)).some(
      (entry) => entry.id === action.taskId,
    )
  )
    throw new AgentChatSendError(
      'not_found',
      'The target chat is not available.',
    );
  const { readTaskRuntimeSnapshot } =
    await import('../project-discovery/runtime-state');
  const snapshot = await readTaskRuntimeSnapshot(bot.projectId, action.taskId);
  const tab = snapshot.tabsFile.tabs.find(
    (candidate) => candidate.id === action.chatId && candidate.kind !== 'file',
  );
  if (!tab)
    throw new AgentChatSendError(
      'not_found',
      'The target chat is not available.',
    );
  return {
    address: { botId: bot.botId, taskId: action.taskId, chatId: tab.id },
    projectType: 'cowork' as const,
    scope: {
      workspaceId: bot.projectId,
      worktreeId: action.taskId,
      chatId: tab.id,
    },
    tab,
  };
}
