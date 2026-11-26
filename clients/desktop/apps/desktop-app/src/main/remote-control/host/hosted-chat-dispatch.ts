import type { HostedFirstPartyClient } from '@canopy/protocol/remote-control';
import {
  HOSTED_SLACK_CONVERSATIONS_TARGET,
  HOSTED_SLACK_REQUESTS_OFF_REFUSAL,
  HOSTED_SLACK_REQUESTS_UNAVAILABLE_REFUSAL,
} from '@canopy/protocol/remote-control/channels';
import {
  APP_ADVISOR_PROJECT_ID,
  isBotProjectId,
} from '@canopy/protocol/chat-targets';
import type { ExternalAgentSender } from '@canopy/protocol/remote-control/shell';
import { RpcPublicError } from '../transport/rpc-peer';
import type {
  ChatCommand,
  ChatCommandExecutionOptions,
  ChatCommandRequest,
  ChatCommandResult,
  ChatTabSettingsPatch,
  McpQuestionAnswer,
  PersistedPendingQuestion,
} from '@canopy/desktop-shared/types';
import type { ChatQuestionRespondOutcome } from '../../chat-questions/respond';

/**
 * A hosted agent session's `chat:command`, served by this computer itself
 * rather than replayed through the bridge window (CAN-5985). The session's
 * argument policy (`hostedInvocationAllowed`) has already admitted the call:
 * a new chat, a message, an answer to an ordinary question, a chat's model,
 * the reviewed settings patch keys, steering a queued message (CAN-7445), or
 * archiving one chat (CAN-7446). Here the host
 *
 * - stamps the agent attribution it derived from the authenticated session on
 *   every message and answer, as Portal stamps an external agent's command
 *   origin, so the person sees who sent it;
 * - starts a new chat on the same default model Portal's create resolves, so
 *   the first prompt runs, with the agent's plugin selections over the seed's;
 * - runs the create preflight before a model change and refuses a provider
 *   that does not serve the model, since `chat.set_model` itself accepts any
 *   provider;
 * - rebuilds a settings patch from the reviewed keys only, so no other key
 *   reaches the chat even if the policy check is bypassed. The values of
 *   those keys are checked by `validate` (the chat command validation), not
 *   here. Turning plan mode off
 *   while a plan waits for review neither approves nor discards it, as on
 *   Portal; the review only stays hidden until plan mode is back on;
 * - refuses an answer to a secret-input question, which only the person may
 *   give;
 * - archives a chat with only its tab ID, so `keepSession` and `unread` never
 *   reach the chat, and refuses it for any chat in a Work Entry project, whose
 *   main chat closes only with its task (CAN-7446). A busy chat is refused by
 *   the archive itself.
 */

type CreateTabCommand = Extract<ChatCommand, { type: 'chat.create_tab' }>;

/**
 * What Portal's create resolves for a new chat (`resolveRemoteCreateTabSeed`):
 * the starting model and settings, or why no model can run one.
 */
export type HostedCreateTabSeed =
  | { readonly refusal: string }
  | Omit<CreateTabCommand, 'type' | 'tabId'>;

/** Who a hosted session's chat commands are attributed to. */
export interface HostedChatAttribution {
  readonly sender: ExternalAgentSender;
  /** The pinned hosted root the session acts for. */
  readonly rootDeviceId: string;
  /** The delegated session's own device. */
  readonly sessionDeviceId: string;
  /** The first-party caller the session's verified delegation names. */
  readonly firstPartyClient?: HostedFirstPartyClient;
  /**
   * Whether the session still holds its pairing: a send or new chat commits
   * only while it does, so one in flight when it is removed never goes out
   * (CAN-7872). Host-only; never serialized.
   */
  readonly canCommit?: () => boolean;
}

export interface HostedQuestionAnswerRequest {
  readonly scope: { readonly projectId: string; readonly worktreeId: string };
  readonly chatId: string;
  readonly questionId: string;
  readonly answers: McpQuestionAnswer[];
  readonly commandId: string;
  readonly attribution: HostedChatAttribution;
}

/** Where a Slack message's tab stands once it has been opened (CAN-7604). */
export type HostedSlackTabOutcome =
  /** The message was sent in its tab; the send's own result. */
  | { readonly status: 'dispatched'; readonly result: ChatCommandResult }
  /** The message was already sent: queued, running or in the transcript. */
  | { readonly status: 'sent' }
  | { readonly status: 'refused'; readonly reason: string };

/**
 * Whether this computer takes Slack requests: `unavailable` while the
 * feature flag is off (the setting isn't shown), else its Slack gate.
 */
export type HostedSlackRequestsState = 'on' | 'off' | 'unavailable';

/**
 * A Slack session's Orchestrator send (CAN-7604), served on this computer:
 * the gate, the Slack conversations entry and the caller's tab (one per
 * person per Slack thread).
 */
export interface HostedOrchestratorDeps {
  /** This computer's Slack flag and gate, read for every send. */
  slackRequests(): Promise<HostedSlackRequestsState>;
  /** The Slack conversations entry, created or recreated when missing. */
  slackConversationsEntry(): Promise<string>;
  /**
   * Readies the caller's tab in `entryId` for a new message: reuses it,
   * restores it from the entry's history under the same ID, or creates it on
   * the Orchestrator's own model, then marks it to close once the next turn
   * completes, and runs `send` there. Never adds a second tab for a thread.
   * The check that the message isn't already sent and the send run under one
   * per-chat lock, so two deliveries of one message start one turn.
   *
   * The tab ID is the caller's `chatId`, which the web's Slack worker derives
   * from the thread and the sender. This computer can't check that
   * derivation: the root-signed Slack delegation is the trust boundary, and
   * the ID only ever names a tab in the Slack conversations entry.
   */
  openSlackTab(
    target: {
      readonly entryId: string;
      readonly chatId: string;
      readonly userMessageId: string;
      readonly commandId: string;
    },
    attribution: HostedChatAttribution,
    send: () => Promise<ChatCommandResult>,
  ): Promise<HostedSlackTabOutcome>;
}

export interface HostedChatDispatchDeps {
  /** The chat command validation renderer IPC applies (no main-only fields). */
  validate(request: unknown): ChatCommandRequest;
  /** Main's trusted chat dispatch, as Portal's commands use it. */
  dispatch(
    request: ChatCommandRequest,
    attribution: HostedChatAttribution,
    options?: ChatCommandExecutionOptions,
  ): Promise<ChatCommandResult>;
  /** Portal's create seed for a new chat in `projectId`. */
  createSeed(projectId: string, model?: string): Promise<HostedCreateTabSeed>;
  /**
   * Portal's create preflight for an explicitly chosen model. `change` is a
   * model change on an existing chat: the preflight then checks the harness
   * and provider that change will apply to the chat.
   */
  modelRefusal(
    target: { projectId: string; worktreeId: string; chatId: string },
    model: string,
    change?: { executionHarness?: string; providerType: string },
  ): Promise<string | null>;
  /** The provider this computer knows serves `model`, if it knows one. */
  modelProvider(model: string): string | undefined;
  /** The persisted question a request ID names, if any. */
  pendingQuestion(
    scope: { projectId: string; worktreeId: string },
    chatId: string,
    questionId: string,
  ): Promise<PersistedPendingQuestion | undefined>;
  /** Portal's question settlement (`respondToChatQuestion`). */
  answerQuestion(
    request: HostedQuestionAnswerRequest,
  ): Promise<ChatQuestionRespondOutcome>;
  /**
   * Whether `projectId` is a Work Entry (Cowork) project, whose chats a
   * hosted archive never closes (CAN-7446).
   */
  isWorkEntryScope(projectId: string): boolean;
  /** A Slack session's Orchestrator send; without it every Bot is refused. */
  orchestrator?: HostedOrchestratorDeps;
  /** Whether an accepted send started its turn or waits in the queue. */
  sendDelivery?(
    target: { projectId: string; worktreeId: string; chatId: string },
    userMessageId: string,
  ): Promise<{ delivery?: 'accepted' | 'queued' }>;
}

/** A send's reply also says whether it started or was queued, as Portal's does. */
export type HostedChatCommandResult = ChatCommandResult & {
  delivery?: 'accepted' | 'queued';
  /**
   * The Work Entry an Orchestrator send landed in (CAN-7604), so the caller
   * can read the thread's transcript; the send itself names a reserved target.
   */
  worktreeId?: string;
};

export const HOSTED_SECRET_ANSWER_REFUSAL =
  "Agents can't answer a secret question. Answer it on this computer.";

export const HOSTED_MODEL_PROVIDER_REFUSAL =
  "That provider doesn't serve this model. Choose the model's own provider.";

export const HOSTED_CHAT_COMMAND_REFUSAL =
  "Agents can't make this chat change.";

export const HOSTED_WORK_ENTRY_CHAT_ARCHIVE_REFUSAL =
  'Archive the task to close its main chat.';

type TabSettingsPatchCommand = Extract<
  ChatCommand,
  { type: 'chat.patch_tab_settings' }
>;

/**
 * The reviewed patch keys of an already validated patch (CAN-7445): auto
 * model selection, thinking level and speed, plan mode and plugin selections.
 * Every other key is dropped. Null when nothing reviewed is left.
 */
function hostedTabPatch(
  patch: TabSettingsPatchCommand['patch'],
): ChatTabSettingsPatch | null {
  const next: ChatTabSettingsPatch = {};
  if (patch.modelSelectionMode === 'auto') next.modelSelectionMode = 'auto';
  const config = patch.modelConfig;
  if (config !== undefined && config !== null) {
    const modelConfig: NonNullable<ChatTabSettingsPatch['modelConfig']> = {};
    if (config.thinkingLevel !== undefined)
      modelConfig.thinkingLevel = config.thinkingLevel;
    if (config.fastMode !== undefined) modelConfig.fastMode = config.fastMode;
    if (Object.keys(modelConfig).length > 0) next.modelConfig = modelConfig;
  }
  if (typeof patch.planMode === 'boolean') next.planMode = patch.planMode;
  if (patch.pluginSelections !== undefined && patch.pluginSelections !== null)
    next.pluginSelections = patch.pluginSelections;
  return Object.keys(next).length === 0 ? null : next;
}

function refused(
  request: ChatCommandRequest,
  outcome: 'rejected' | 'not_found' | 'conflict',
  reason?: string,
): ChatCommandResult {
  // Refused before anything changed, so no revision was written.
  return {
    commandId: request.commandId,
    revision: 0,
    outcome,
    ...(reason === undefined ? {} : { reason }),
  };
}

export function createHostedChatDispatcher(
  deps: HostedChatDispatchDeps,
): (
  request: unknown,
  attribution: HostedChatAttribution,
) => Promise<HostedChatCommandResult> {
  return async (value, attribution) => {
    const request = deps.validate(value);
    // A Bot is never an ordinary hosted chat (CAN-7604).
    if (isBotProjectId(request.projectId))
      return sendToOrchestrator(deps, request, attribution);
    // A first-party session only ever reaches the Orchestrator.
    if (attribution.firstPartyClient !== undefined)
      return refused(request, 'rejected', HOSTED_CHAT_COMMAND_REFUSAL);
    const command = request.command;
    switch (command.type) {
      case 'chat.create_tab': {
        const target = {
          projectId: request.projectId,
          worktreeId: request.worktreeId,
          chatId: command.tabId,
        };
        if (command.model !== undefined) {
          const refusal = await deps.modelRefusal(target, command.model);
          if (refusal !== null) return refused(request, 'rejected', refusal);
        }
        const seed = await deps.createSeed(request.projectId, command.model);
        // Never a modelless chat, whose first prompt could not run.
        if ('refusal' in seed)
          return refused(request, 'rejected', seed.refusal);
        return deps.dispatch(
          {
            ...request,
            origin: 'portal',
            command: {
              ...seed,
              type: 'chat.create_tab',
              tabId: command.tabId,
              ...(command.planMode === undefined
                ? {}
                : { planMode: command.planMode }),
              // The agent's selection replaces the seed's.
              ...(command.pluginSelections === undefined
                ? {}
                : { pluginSelections: command.pluginSelections }),
            },
          },
          attribution,
        );
      }
      case 'chat.send_message': {
        if (command.model !== undefined) {
          const refusal = await deps.modelRefusal(
            {
              projectId: request.projectId,
              worktreeId: request.worktreeId,
              chatId: command.chatId,
            },
            command.model,
          );
          if (refusal !== null) return refused(request, 'rejected', refusal);
        }
        const sent = await deps.dispatch(
          {
            ...request,
            origin: 'portal',
            command: { ...command, agentSent: attribution.sender },
          },
          attribution,
        );
        if (
          deps.sendDelivery === undefined ||
          (sent.outcome !== 'applied' && sent.outcome !== 'already_applied')
        )
          return sent;
        return {
          ...sent,
          ...(await deps.sendDelivery(
            {
              projectId: request.projectId,
              worktreeId: request.worktreeId,
              chatId: command.chatId,
            },
            sent.messageId ?? command.userMessageId,
          )),
        };
      }
      case 'chat.answer_question': {
        const scope = {
          projectId: request.projectId,
          worktreeId: request.worktreeId,
        };
        const record = await deps.pendingQuestion(
          scope,
          command.chatId,
          command.questionId,
        );
        if (record?.questions.some((question) => question.secret === true)) {
          return refused(request, 'rejected', HOSTED_SECRET_ANSWER_REFUSAL);
        }
        const outcome = await deps.answerQuestion({
          scope,
          chatId: command.chatId,
          questionId: command.questionId,
          answers: command.answers,
          commandId: request.commandId,
          attribution,
        });
        switch (outcome.status) {
          case 'applied':
          case 'already_settled':
            return outcome.result;
          case 'not_found':
            return refused(request, 'not_found');
          case 'conflict':
            return refused(request, 'conflict');
          case 'cancelled':
            return refused(
              request,
              'rejected',
              'The question is no longer awaiting a response.',
            );
          case 'invalid':
            return refused(request, 'rejected', outcome.message);
          case 'unavailable':
            // The answer may or may not have been taken: never a refusal.
            throw new RpcPublicError(
              'The chat state service is temporarily unavailable.',
            );
        }
        break;
      }
      case 'chat.set_model': {
        const target = {
          projectId: request.projectId,
          worktreeId: request.worktreeId,
          chatId: command.tabId,
        };
        const refusal = await deps.modelRefusal(target, command.model, {
          providerType: command.providerType,
          ...(command.executionHarness === undefined
            ? {}
            : { executionHarness: command.executionHarness }),
        });
        if (refusal !== null) return refused(request, 'rejected', refusal);
        const provider = deps.modelProvider(command.model);
        if (provider !== undefined && provider !== command.providerType)
          return refused(request, 'rejected', HOSTED_MODEL_PROVIDER_REFUSAL);
        return deps.dispatch(
          {
            ...request,
            origin: 'portal',
            command: {
              type: 'chat.set_model',
              tabId: command.tabId,
              model: command.model,
              providerType: command.providerType,
              ...(command.executionHarness === undefined
                ? {}
                : { executionHarness: command.executionHarness }),
            },
          },
          attribution,
        );
      }
      case 'chat.patch_tab_settings': {
        const patch = hostedTabPatch(command.patch);
        if (patch === null)
          return refused(request, 'rejected', HOSTED_CHAT_COMMAND_REFUSAL);
        return deps.dispatch(
          {
            ...request,
            origin: 'portal',
            command: {
              type: 'chat.patch_tab_settings',
              tabId: command.tabId,
              patch,
            },
          },
          attribution,
        );
      }
      case 'chat.steer_queued_message':
        return deps.dispatch(
          {
            ...request,
            origin: 'portal',
            command: {
              type: 'chat.steer_queued_message',
              chatId: command.chatId,
              queuedMessageId: command.queuedMessageId,
              ...(command.queuedMessageRevision === undefined
                ? {}
                : { queuedMessageRevision: command.queuedMessageRevision }),
            },
          },
          attribution,
        );
      case 'chat.archive_tab':
        if (deps.isWorkEntryScope(request.projectId))
          return refused(
            request,
            'rejected',
            HOSTED_WORK_ENTRY_CHAT_ARCHIVE_REFUSAL,
          );
        return deps.dispatch(
          {
            ...request,
            origin: 'portal',
            command: { type: 'chat.archive_tab', tabId: command.tabId },
          },
          attribution,
        );
      default:
        break;
    }
    return refused(request, 'rejected', HOSTED_CHAT_COMMAND_REFUSAL);
  };
}

/**
 * A Slack session's message to the Orchestrator (CAN-7604). Only the plain
 * send to the reserved Slack conversations target is served, and only while
 * this computer's Slack gate is on. It lands in the caller's tab of the Slack
 * conversations entry, on the Orchestrator's own model and approval mode,
 * attributed to the verified Slack sender. Anything else naming a Bot is
 * refused before anything changes.
 */
async function sendToOrchestrator(
  deps: HostedChatDispatchDeps,
  request: ChatCommandRequest,
  attribution: HostedChatAttribution,
): Promise<HostedChatCommandResult> {
  const command = request.command;
  const orchestrator = deps.orchestrator;
  if (
    orchestrator === undefined ||
    attribution.firstPartyClient !== 'slack' ||
    request.projectId !== APP_ADVISOR_PROJECT_ID ||
    request.worktreeId !== HOSTED_SLACK_CONVERSATIONS_TARGET ||
    command.type !== 'chat.send_message' ||
    command.model !== undefined ||
    command.planMode !== undefined
  )
    return refused(request, 'rejected', HOSTED_CHAT_COMMAND_REFUSAL);
  const slackRequests = await orchestrator.slackRequests();
  if (slackRequests === 'unavailable')
    return refused(
      request,
      'rejected',
      HOSTED_SLACK_REQUESTS_UNAVAILABLE_REFUSAL,
    );
  if (slackRequests === 'off')
    return refused(request, 'rejected', HOSTED_SLACK_REQUESTS_OFF_REFUSAL);
  const entryId = await orchestrator.slackConversationsEntry();
  const tab = await orchestrator.openSlackTab(
    {
      entryId,
      chatId: command.chatId,
      userMessageId: command.userMessageId,
      commandId: request.commandId,
    },
    attribution,
    () =>
      deps.dispatch(
        {
          schemaVersion: request.schemaVersion,
          commandId: request.commandId,
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: entryId,
          origin: 'portal',
          command: {
            type: 'chat.send_message',
            chatId: command.chatId,
            userMessageId: command.userMessageId,
            text: command.text,
            agentSent: attribution.sender,
          },
        },
        attribution,
      ),
  );
  if (tab.status === 'refused') return refused(request, 'rejected', tab.reason);
  if (tab.status === 'sent') {
    return {
      commandId: request.commandId,
      // Placeholder: nothing was committed, and the tab's revision isn't
      // read. Callers use the outcome, never the revision.
      revision: 0,
      outcome: 'already_applied',
      entityId: command.chatId,
      messageId: command.userMessageId,
      worktreeId: entryId,
    };
  }
  const sent = tab.result;
  if (sent.outcome !== 'applied' && sent.outcome !== 'already_applied')
    return { ...sent, worktreeId: entryId };
  return {
    ...sent,
    worktreeId: entryId,
    ...(deps.sendDelivery === undefined
      ? {}
      : await deps.sendDelivery(
          {
            projectId: APP_ADVISOR_PROJECT_ID,
            worktreeId: entryId,
            chatId: command.chatId,
          },
          sent.messageId ?? command.userMessageId,
        )),
  };
}
