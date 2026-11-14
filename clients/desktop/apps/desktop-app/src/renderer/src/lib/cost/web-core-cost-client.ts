import type { CostClient } from '@canopy/app-core';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import {
  CORE_QUERY_DEFINITIONS,
  type CanopyErrorPayload,
} from '@canopy/protocol/canopy-core';
import type {
  CostChatView,
  CostScopeRef,
  CostScopeView,
  CostViewResult,
} from '@canopy/protocol/cost-view';
import type { CanopyCoreRelayApi } from '../../../../shared/canopy-core-relay';
import { webCoreLocalId, webCoreScopeId } from '../chat-authority';

/*
 * The cost client for a cloud task (CAN-6180): `core.cost.scope.get` and
 * `core.cost.chat.get` over the renderer relay with the web core authority,
 * so a cloud id never reaches main's cost index. Scope and chat ids cross
 * the relay without their `web-core:` prefix and come back with it, as the
 * cloud task's other surfaces name them. The web core keeps no refresh or
 * update stream for cost: the views read again when they open.
 */

const READ_FAILED = "Couldn't read cost.";

const noop = (): void => undefined;

/** The web core form of a desktop cloud scope, or null for any other scope. */
function webCoreScope(scope: CostScopeRef): CostScopeRef | null {
  const projectId = webCoreLocalId(scope.projectId);
  if (projectId === null) return null;
  if (scope.kind === 'retained')
    return { kind: 'retained', projectId, containerId: scope.containerId };
  const worktreeId = webCoreLocalId(scope.worktreeId);
  return worktreeId === null ? null : { kind: 'entry', projectId, worktreeId };
}

function failure<Value>(error: CanopyErrorPayload): CostViewResult<Value> {
  if (error.kind === 'capability_unavailable')
    return { status: 'unavailable', reason: 'runtime_unavailable' };
  return {
    status: 'error',
    reason: error.kind === 'not_found' ? 'NOT_FOUND' : 'UNKNOWN',
    message: error.message.length > 0 ? error.message : READ_FAILED,
  };
}

const NO_SCOPE: CostViewResult<never> = {
  status: 'unavailable',
  reason: 'no_scope',
};

const RUNTIME_UNAVAILABLE: CostViewResult<never> = {
  status: 'unavailable',
  reason: 'runtime_unavailable',
};

function malformed<Value>(): CostViewResult<Value> {
  return { status: 'error', reason: 'UNKNOWN', message: READ_FAILED };
}

/** The view with its ids named as this desktop names a cloud task's. */
function desktopScopeView(
  view: CostScopeView,
  scope: CostScopeRef,
): CostScopeView {
  return {
    ...view,
    scope,
    chats: view.chats.map((chat) => ({
      ...chat,
      chatId: webCoreScopeId(chat.chatId),
    })),
  };
}

function desktopChatView(view: CostChatView): CostChatView {
  return view.kind === 'full'
    ? {
        ...view,
        breakdown: {
          ...view.breakdown,
          chat: {
            ...view.breakdown.chat,
            chatId: webCoreScopeId(view.breakdown.chat.chatId),
          },
        },
      }
    : {
        ...view,
        chat: { ...view.chat, chatId: webCoreScopeId(view.chat.chatId) },
      };
}

export function createWebCoreCostClient(
  relay: () => CanopyCoreRelayApi | undefined,
): CostClient {
  const request = async <Value>(
    method: 'core.cost.scope.get' | 'core.cost.chat.get',
    params: Record<string, unknown>,
    parse: (value: unknown) => Value | null,
  ): Promise<CostViewResult<Value>> => {
    const api = relay();
    if (api === undefined) return RUNTIME_UNAVAILABLE;
    try {
      const reply = await api.invoke({
        kind: 'request',
        method,
        params,
        authority: 'web-core',
      });
      if (!reply.ok) return failure(reply.error);
      const value = parse(reply.value);
      return value === null ? malformed() : { status: 'ok', value };
    } catch (error) {
      // The relay answers a refusal as a reply, so a rejection is a defect.
      reportClientAppError(error);
      return malformed();
    }
  };
  return {
    getScope: async ({ scope }) => {
      const remote = webCoreScope(scope);
      if (remote === null) return NO_SCOPE;
      return request('core.cost.scope.get', { scope: remote }, (value) => {
        const parsed =
          CORE_QUERY_DEFINITIONS['core.cost.scope.get'].result.safeParse(value);
        return parsed.success ? desktopScopeView(parsed.data, scope) : null;
      });
    },
    getChat: async ({ scope, chatId, detail, subagentId }) => {
      const remote = webCoreScope(scope);
      const remoteChat = webCoreLocalId(chatId);
      if (remote === null || remoteChat === null) return NO_SCOPE;
      return request(
        'core.cost.chat.get',
        {
          scope: remote,
          chatId: remoteChat,
          ...(detail ? { detail } : {}),
          ...(subagentId ? { subagentId } : {}),
        },
        (value) => {
          const parsed =
            CORE_QUERY_DEFINITIONS['core.cost.chat.get'].result.safeParse(
              value,
            );
          return parsed.success ? desktopChatView(parsed.data) : null;
        },
      );
    },
    // Cloud workflow runs are billed separately and have no cost view yet.
    getPipelineRun: () => Promise.resolve(RUNTIME_UNAVAILABLE),
    // The web core reads the ledger on each request; there is no index to refresh.
    refresh: () =>
      Promise.resolve({
        status: 'ok',
        value: { ran: false, updatedAt: null, revision: 0 },
      }),
    watchScope: () => noop,
    subscribeUpdates: () => noop,
  };
}
