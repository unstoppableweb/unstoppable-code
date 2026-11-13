import {
  agentActionError,
  agentActionIdempotencyKey,
  agentActionResult,
  agentActionToolResult,
  lineageOf,
  missingScopeResponse,
  portErrorResponse,
  runIdempotentWrite,
} from '../../action-support';
import type { AgentActionLimitsPort } from '../../limits';
import {
  AgentPortError,
  isUnknownWriteOutcome,
  type AgentChatDetail,
  type AgentEnvironmentPort,
  type AgentPostMessageReceipt,
  type AgentStartChatInput,
  type AgentStartChatReceipt,
} from '../../port/environment-port';
import type { AgentChatWatcherPort } from '../../port/watcher-port';
import type { AgentActionReceiptStore } from '../../receipts';
import type { AgentActionToolResult } from '../../tools/definition';
import type { AgentActionResponse } from '../../response';
import type { AgentActionHostCapabilities } from '../../surface/capabilities';
import {
  defineAgentActionFamily,
  type AgentActionCall,
  type AgentActionCallScope,
  type AgentActionDispatchOutput,
  type AgentActionFamily,
} from '../../surface/family';
import {
  ENVIRONMENT_ACTION_TYPES,
  environmentActionSchema,
  type EnvironmentAction,
  type EnvironmentActionOf,
  type EnvironmentActionType,
  type EnvironmentInlineWatcher,
} from './actions';
import {
  environmentActionCatalog,
  environmentDispatchJsonSchema,
} from './catalog';
import {
  chatGetResult,
  chatListResult,
  modelListResult,
  modelThinkingLevels,
  workspaceResult,
  worktreeListResult,
  type AgentChatCreateResult,
  type AgentChatSendMessageResult,
  type AgentInlineWatcherResult,
} from './results';

export interface EnvironmentActionFamilyOptions<H> {
  /** The same capabilities the host passes to its surface. */
  capabilities: AgentActionHostCapabilities;
  port: AgentEnvironmentPort<H>;
  /** Required exactly when `capabilities.limits` is true. */
  limits: AgentActionLimitsPort | null;
  /** Required exactly when the capabilities offer chat-completion watchers. */
  watchers: AgentChatWatcherPort<H> | null;
  /** Committed write results; a replay returns its recorded result. */
  receipts: AgentActionReceiptStore<H>;
}

const DEFAULT_PAGE_SIZE = 50;

/** Whether these capabilities offer inline chat-completion watchers. */
export function offersInlineChatWatchers(
  capabilities: AgentActionHostCapabilities,
): boolean {
  return capabilities.watcherTriggers.includes('worktree_chat_completion');
}

export function environmentSupportedTypes(
  capabilities: AgentActionHostCapabilities,
): readonly EnvironmentActionType[] {
  return ENVIRONMENT_ACTION_TYPES.filter(
    (type) =>
      type !== 'chat.create' || capabilities.chatCreatePlacements.length > 0,
  );
}

/** The error a host without a chat.create placement returns, on every host. */
export function unavailablePlacementMessage(
  placement: string,
  capabilities: AgentActionHostCapabilities,
): string {
  return `chat.create placement ${placement} is not available here. Available placements: ${capabilities.chatCreatePlacements.join(', ')}.`;
}

export const INLINE_WATCHERS_UNAVAILABLE_MESSAGE =
  'Inline watchers are not available here.';

const UNMESSAGEABLE = (chatId: string): string =>
  `Chat ${chatId} cannot receive messages from agents.`;
const NOT_IN_WORKSPACE = (chatId: string): string =>
  `Chat ${chatId} is not in the current workspace.`;

type Dispatcher<H, T extends EnvironmentActionType> = (
  action: EnvironmentActionOf<T>,
  scope: AgentActionCallScope,
  call: AgentActionCall<H>,
) => Promise<AgentActionDispatchOutput>;

/**
 * The environment actions: reads of the current workspace, its worktrees,
 * chats, and models, and starting or messaging other chats in it.
 */
export function createEnvironmentActionFamily<H>(
  options: EnvironmentActionFamilyOptions<H>,
): AgentActionFamily<H> {
  const { capabilities, port, limits, watchers, receipts } = options;
  if (capabilities.limits !== (limits !== null)) {
    throw new Error(
      'Environment actions need a limits port exactly when the capabilities enforce limits.',
    );
  }
  const inlineWatchers = offersInlineChatWatchers(capabilities);
  if (inlineWatchers !== (watchers !== null)) {
    throw new Error(
      'Environment actions need a watcher port exactly when the capabilities offer chat-completion watchers.',
    );
  }

  function inlineWatchersUnavailable(
    requested: readonly EnvironmentInlineWatcher[] | undefined,
    call: AgentActionCall<H>,
  ): AgentActionResponse | null {
    if (!requested || (inlineWatchers && watchers)) return null;
    return agentActionError(
      call,
      'missing_capability',
      INLINE_WATCHERS_UNAVAILABLE_MESSAGE,
    );
  }

  /**
   * Arms the inline watchers. They are private to this write: each is armed
   * as its own watcher, never deduped onto one another call holds, so a
   * rollback removes only watchers no other call depends on. `createdIds`
   * are the watchers this call created, the only ones a rollback removes.
   */
  async function armWatchers(
    requested: readonly EnvironmentInlineWatcher[],
    target: { workspaceId: string; worktreeId: string; chatId: string },
    armForNextCompletion: boolean,
    keyBase: string,
    call: AgentActionCall<H>,
  ): Promise<{ results: AgentInlineWatcherResult[]; createdIds: string[] }> {
    const results: AgentInlineWatcherResult[] = [];
    const createdIds: string[] = [];
    if (!watchers) return { results, createdIds };
    let index = 0;
    for (const watcher of requested) {
      try {
        const armed = await watchers.armChatCompletion(
          {
            target,
            ...(watcher.label ? { label: watcher.label } : {}),
            ...(watcher.followUpInstruction
              ? { followUpInstruction: watcher.followUpInstruction }
              : {}),
            armForNextCompletion,
            allowDuplicate: true,
            forWrite: { idempotencyKey: keyBase },
            idempotencyKey: `${keyBase}:watcher-${index}`,
          },
          call,
        );
        results.push({ ok: true, watcherId: armed.watcherId });
        if (armed.created) createdIds.push(armed.watcherId);
      } catch (error) {
        const response = portErrorResponse(call, 'watcher', error);
        results.push({
          ok: false,
          error: {
            code: response.error?.code ?? 'execution_failed',
            message: response.error?.message ?? 'Watcher failed.',
          },
        });
      }
      index += 1;
    }
    return { results, createdIds };
  }

  async function chatInWorkspace(
    chatId: string,
    scope: AgentActionCallScope,
    call: AgentActionCall<H>,
  ): Promise<
    | { ok: true; chat: AgentChatDetail }
    | { ok: false; response: AgentActionResponse }
  > {
    const chat = await port.getChat(
      { scope: { workspaceId: scope.workspaceId }, chatId },
      call,
    );
    if (!chat) {
      return {
        ok: false,
        response: agentActionError(
          call,
          'not_found',
          `Chat ${chatId} was not found.`,
        ),
      };
    }
    if (chat.workspaceId !== scope.workspaceId) {
      return {
        ok: false,
        response: agentActionError(
          call,
          'invalid_target',
          NOT_IN_WORKSPACE(chatId),
        ),
      };
    }
    return { ok: true, chat };
  }

  const workspaceGet: Dispatcher<H, 'workspace.get'> = async (
    action,
    scope,
    call,
  ) => {
    const workspace = await port.query(
      'core.workspace.get',
      {
        scope: { workspaceId: scope.workspaceId },
        workspaceId: scope.workspaceId,
      },
      call,
    );
    return agentActionResult(call, action.type, workspaceResult(workspace));
  };

  const worktreeList: Dispatcher<H, 'worktree.list'> = async (
    action,
    scope,
    call,
  ) => {
    const page = await port.query(
      'core.worktree.list',
      {
        scope: { workspaceId: scope.workspaceId },
        pageSize: action.limit ?? DEFAULT_PAGE_SIZE,
        ...(action.cursor ? { cursor: action.cursor } : {}),
      },
      call,
    );
    return agentActionResult(
      call,
      action.type,
      worktreeListResult(page, scope.workspaceId, scope.worktreeId),
    );
  };

  const chatList: Dispatcher<H, 'chat.list'> = async (action, scope, call) => {
    const worktreeId = action.inWorktreeId ?? scope.worktreeId;
    if (worktreeId !== scope.worktreeId) {
      const notInWorkspace = agentActionError(
        call,
        'invalid_target',
        `Worktree ${worktreeId} is not in the current workspace.`,
      );
      try {
        const worktree = await port.query(
          'core.worktree.get',
          { scope: { workspaceId: scope.workspaceId }, worktreeId },
          call,
        );
        if (worktree.workspaceId !== scope.workspaceId) return notInWorkspace;
      } catch (error) {
        if (error instanceof AgentPortError && error.code === 'not_found') {
          return notInWorkspace;
        }
        throw error;
      }
    }
    const page = await port.query(
      'core.chat.list',
      {
        scope: { workspaceId: scope.workspaceId, worktreeId },
        pageSize: action.limit ?? DEFAULT_PAGE_SIZE,
        ...(action.cursor ? { cursor: action.cursor } : {}),
      },
      call,
    );
    const unmessageableChatIds = port.unmessageableChatIds
      ? await port.unmessageableChatIds(
          {
            scope: { workspaceId: scope.workspaceId, worktreeId },
            chatIds: page.items.map((chat) => chat.chatId),
          },
          call,
        )
      : [];
    return agentActionResult(
      call,
      action.type,
      chatListResult(page, {
        workspaceId: scope.workspaceId,
        currentChatId: scope.chatId,
        includeArchived: action.includeArchived === true,
        unmessageableChatIds,
      }),
    );
  };

  const chatGet: Dispatcher<H, 'chat.get'> = async (action, scope, call) => {
    const found = await chatInWorkspace(action.chatId, scope, call);
    if (!found.ok) return found.response;
    return agentActionResult(call, action.type, chatGetResult(found.chat));
  };

  const modelsList: Dispatcher<H, 'models.list'> = async (
    action,
    scope,
    call,
  ) => {
    const list = await port.listModels({ scope }, call);
    return agentActionResult(call, action.type, modelListResult(list));
  };

  /** The model selection a chat.create carries, validated against models.list. */
  async function resolveModel(
    action: EnvironmentActionOf<'chat.create'>,
    scope: AgentActionCallScope,
    call: AgentActionCall<H>,
  ): Promise<
    | { ok: true; model: AgentStartChatInput['model'] }
    | { ok: false; response: AgentActionResponse }
  > {
    if (action.model === undefined && action.thinkingLevel === undefined) {
      return { ok: true, model: undefined };
    }
    const list = await port.listModels({ scope }, call);
    const modelId = action.model ?? list.defaultModelId;
    const model = list.models.find(
      (entry) => entry.id === modelId && entry.available,
    );
    if (!model) {
      return {
        ok: false,
        response: agentActionError(
          call,
          'not_found',
          action.model !== undefined
            ? `Model ${action.model} is not available. Use models.list to choose a model.`
            : 'There is no default model to apply thinkingLevel to. Choose a model from models.list.',
        ),
      };
    }
    const levels = modelThinkingLevels(model);
    if (
      action.thinkingLevel !== undefined &&
      levels !== null &&
      !levels.includes(action.thinkingLevel)
    ) {
      return {
        ok: false,
        response: agentActionError(
          call,
          'validation_failed',
          levels.length === 0
            ? `Model ${model.id} does not support thinking levels.`
            : `Model ${model.id} does not support thinking level ${action.thinkingLevel}. Supported levels: ${levels.join(', ')}.`,
        ),
      };
    }
    return {
      ok: true,
      model: {
        id: model.id,
        ...(action.thinkingLevel
          ? { thinkingLevel: action.thinkingLevel }
          : {}),
      },
    };
  }

  const chatCreate: Dispatcher<H, 'chat.create'> = async (
    action,
    scope,
    call,
  ) => {
    if (!capabilities.chatCreatePlacements.includes(action.placement)) {
      return agentActionError(
        call,
        'missing_capability',
        unavailablePlacementMessage(action.placement, capabilities),
      );
    }
    const watchersUnavailable = inlineWatchersUnavailable(
      action.watchers,
      call,
    );
    if (watchersUnavailable) return watchersUnavailable;
    const idempotencyKey = agentActionIdempotencyKey(action.type, call, action);
    const requested = action.watchers;
    return runIdempotentWrite({
      receipts,
      limits,
      kind: 'chat.create',
      call,
      idempotencyKey,
      payload: action,
      prepare: async () => {
        const selection = await resolveModel(action, scope, call);
        if (!selection.ok) return selection;
        const depth = await port.callerDepth(call);
        return {
          ok: true,
          parentDepth: depth,
          write: async (attempt): Promise<AgentActionToolResult> => {
            const armedBeforeSend: {
              armed: {
                results: AgentInlineWatcherResult[];
                createdIds: string[];
              } | null;
            } = { armed: null };
            let receipt: AgentStartChatReceipt;
            try {
              receipt = await port.startChat(
                {
                  scope: {
                    workspaceId: scope.workspaceId,
                    worktreeId: scope.worktreeId,
                  },
                  placement: action.placement,
                  ...(selection.model ? { model: selection.model } : {}),
                  ...(action.title ? { title: action.title } : {}),
                  message: { text: action.message },
                  lineage: lineageOf(scope, depth),
                  idempotencyKey,
                  ...(requested
                    ? {
                        beforeFirstMessage: async (target): Promise<void> => {
                          armedBeforeSend.armed = await armWatchers(
                            requested,
                            {
                              workspaceId: scope.workspaceId,
                              worktreeId: target.worktreeId,
                              chatId: target.chatId,
                            },
                            true,
                            idempotencyKey,
                            call,
                          );
                        },
                      }
                    : {}),
                },
                call,
              );
            } catch (error) {
              const createdIds = armedBeforeSend.armed?.createdIds ?? [];
              if (
                watchers &&
                createdIds.length > 0 &&
                !attempt.uncertain &&
                !isUnknownWriteOutcome(error)
              ) {
                await watchers.delete(createdIds, call);
              }
              throw error;
            }
            const result: AgentChatCreateResult = {
              chatId: receipt.chatId,
              worktreeId: receipt.worktreeId,
              placement: action.placement,
              delivery: receipt.delivery,
              independent: true,
              watchers: requested
                ? (armedBeforeSend.armed?.results ??
                  (await armWatchers(
                    requested,
                    {
                      workspaceId: scope.workspaceId,
                      worktreeId: receipt.worktreeId,
                      chatId: receipt.chatId,
                    },
                    false,
                    idempotencyKey,
                    call,
                  ).then((armed) => armed.results)))
                : null,
            };
            return agentActionToolResult(
              agentActionResult(call, action.type, result),
            );
          },
        };
      },
    });
  };

  const chatSendMessage: Dispatcher<H, 'chat.send_message'> = async (
    action,
    scope,
    call,
  ) => {
    if (action.chatId === scope.chatId) {
      return agentActionError(
        call,
        'invalid_target',
        'A chat cannot send a message to itself.',
      );
    }
    const watchersUnavailable = inlineWatchersUnavailable(
      action.watchers,
      call,
    );
    if (watchersUnavailable) return watchersUnavailable;
    const found = await chatInWorkspace(action.chatId, scope, call);
    if (!found.ok) return found.response;
    const worktreeId = found.chat.worktreeId ?? scope.worktreeId;
    const idempotencyKey = agentActionIdempotencyKey(action.type, call, action);
    return runIdempotentWrite({
      receipts,
      limits,
      kind: 'chat.send_message',
      call,
      idempotencyKey,
      payload: action,
      prepare: async () => {
        if (found.chat.state === 'archived') {
          return {
            ok: false,
            response: agentActionError(
              call,
              'invalid_target',
              `Chat ${action.chatId} is archived.`,
            ),
          };
        }
        if (found.chat.messageable === false) {
          return {
            ok: false,
            response: agentActionError(
              call,
              'invalid_target',
              found.chat.unmessageableReason ?? UNMESSAGEABLE(action.chatId),
            ),
          };
        }
        return {
          ok: true,
          parentDepth: await port.callerDepth(call),
          write: async (attempt): Promise<AgentActionToolResult> => {
            const armed = action.watchers
              ? await armWatchers(
                  action.watchers,
                  {
                    workspaceId: scope.workspaceId,
                    worktreeId,
                    chatId: action.chatId,
                  },
                  true,
                  idempotencyKey,
                  call,
                )
              : null;
            let receipt: AgentPostMessageReceipt;
            try {
              receipt = await port.postMessage(
                {
                  scope: { workspaceId: scope.workspaceId, worktreeId },
                  chatId: action.chatId,
                  text: action.message,
                  idempotencyKey,
                },
                call,
              );
            } catch (error) {
              const createdIds = armed?.createdIds ?? [];
              if (
                watchers &&
                createdIds.length > 0 &&
                !attempt.uncertain &&
                !isUnknownWriteOutcome(error)
              ) {
                await watchers.delete(createdIds, call);
              }
              throw error;
            }
            const result: AgentChatSendMessageResult = {
              chatId: receipt.chatId,
              delivery: receipt.delivery,
              watchers: armed?.results ?? null,
            };
            return agentActionToolResult(
              agentActionResult(call, action.type, result),
            );
          },
        };
      },
    });
  };

  function dispatch(
    action: EnvironmentAction,
    scope: AgentActionCallScope,
    call: AgentActionCall<H>,
  ): Promise<AgentActionDispatchOutput> {
    switch (action.type) {
      case 'workspace.get':
        return workspaceGet(action, scope, call);
      case 'worktree.list':
        return worktreeList(action, scope, call);
      case 'chat.list':
        return chatList(action, scope, call);
      case 'chat.get':
        return chatGet(action, scope, call);
      case 'chat.create':
        return chatCreate(action, scope, call);
      case 'chat.send_message':
        return chatSendMessage(action, scope, call);
      case 'models.list':
        return modelsList(action, scope, call);
    }
  }

  return defineAgentActionFamily<H, EnvironmentAction>({
    id: 'environment',
    types: ENVIRONMENT_ACTION_TYPES,
    catalog: (brand) => environmentActionCatalog(brand),
    supportedTypes: environmentSupportedTypes,
    actionSchema: environmentActionSchema,
    dispatchJsonSchema: environmentDispatchJsonSchema(
      capabilities.chatCreatePlacements,
    ),
    dispatch: async (action, call): Promise<AgentActionDispatchOutput> => {
      const scope = call.scope;
      if (!scope) return missingScopeResponse(call, action.type);
      try {
        return await dispatch(action, scope, call);
      } catch (error) {
        return portErrorResponse(call, action.type, error);
      }
    },
  });
}
