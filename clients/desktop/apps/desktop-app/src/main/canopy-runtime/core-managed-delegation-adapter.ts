import {
  CanopyOperationError,
  canopyCapabilityUnavailableError,
  type CanopyHandlerContext,
} from '@canopy/core-runtime';
import { KeyedOutcomes } from '@canopy/core-runtime/node/operations';
import {
  MANAGED_DELEGATION_LIST_PAGE_MAX,
  managedDelegationErrorPayload,
} from '@canopy/protocol/canopy-core';
import type {
  AgentDelegationError,
  AgentDelegationResult,
  AgentDelegationSnapshot,
  ManagedDelegationLifetimeStatus,
  ManagedDelegationTreeEntry,
} from '@canopy/protocol/delegation';
import type {
  ManagedDelegationMessageRequest,
  ManagedDelegationMessageResult,
} from '@canopy/desktop-shared/types';
import type { ManagedDelegationChatTarget } from '../agents/delegation/service';
import { validateId } from '../lib/validation';
import type { DesktopDomainAdapter } from './desktop-runtime';

/**
 * The delegation broker's user reads and controls behind
 * `core.managedDelegation.*`; Electron main's delegation service by default,
 * tests inject one. The same functions back the delegation viewer's IPC.
 */
export interface CoreManagedDelegationHost {
  inspect(
    target: ManagedDelegationChatTarget,
    delegationId: string,
  ): Promise<AgentDelegationResult<AgentDelegationSnapshot | null>>;
  tree(
    target: ManagedDelegationChatTarget,
  ): Promise<readonly ManagedDelegationTreeEntry[]>;
  stop(
    target: ManagedDelegationChatTarget,
    delegationId: string,
  ): Promise<AgentDelegationResult<AgentDelegationSnapshot>>;
  stopAll(
    target: ManagedDelegationChatTarget,
  ): Promise<AgentDelegationResult<{ readonly stopped: number }>>;
  message(
    request: ManagedDelegationMessageRequest,
  ): Promise<ManagedDelegationMessageResult>;
  lifetime(scope: {
    readonly projectId: string;
    readonly worktreeId: string;
  }): Promise<ManagedDelegationLifetimeStatus>;
}

// Lazy: keeps the delegation service's graph off startup.
const desktopManagedDelegationHost: CoreManagedDelegationHost = {
  inspect: async (target, delegationId) =>
    (
      await import('../agents/delegation/service')
    ).inspectManagedDelegationForUser(target, delegationId),
  tree: async (target) =>
    (
      await import('../agents/delegation/service')
    ).readManagedDelegationTreeForUser(target),
  stop: async (target, delegationId) =>
    (await import('../agents/delegation/service')).stopManagedDelegationForUser(
      target,
      delegationId,
    ),
  stopAll: async (target) =>
    (
      await import('../agents/delegation/service')
    ).stopAllManagedDelegationsForUser(target),
  message: async (request) =>
    (
      await import('../agents/delegation/service')
    ).messageManagedDelegationForUser(request),
  lifetime: async (scope) =>
    (
      await import('../agents/delegation/service')
    ).getManagedDelegationLifetimeStatus(scope),
};

function failure(
  error: AgentDelegationError,
  kind: 'query' | 'instruction',
): CanopyOperationError {
  return new CanopyOperationError(managedDelegationErrorPayload(error, kind));
}

function notFound(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'not_found',
    code: 'core.managedDelegation.notFound',
    message: 'The delegation was not found in this chat.',
    retry: { kind: 'never' },
  });
}

function invalidArgument(message: string): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'invalid_argument',
    code: 'core.managedDelegation.invalidRequest',
    message,
    retry: { kind: 'never' },
  });
}

/**
 * The user's authority over a chat's whole delegation tree, as the
 * delegation viewer has it. Agents get none of it here: their delegation
 * tools scope them to their own subtree.
 */
function chatTarget(
  params: {
    readonly scope: {
      readonly workspaceId: string;
      readonly worktreeId: string;
    };
    readonly chatId: string;
  },
  context: CanopyHandlerContext,
): ManagedDelegationChatTarget {
  if (context.caller.interfaceKind === 'mcp')
    throw canopyCapabilityUnavailableError(
      'Agents manage their delegates with their delegation tools.',
    );
  try {
    validateId(params.scope.workspaceId, 'workspaceId');
    validateId(params.scope.worktreeId, 'worktreeId');
    validateId(params.chatId, 'chatId');
  } catch {
    throw invalidArgument('Invalid chat.');
  }
  return {
    projectId: params.scope.workspaceId,
    worktreeId: params.scope.worktreeId,
    chatId: params.chatId,
  };
}

function snapshotOf(
  result: AgentDelegationResult<AgentDelegationSnapshot | null>,
  kind: 'query' | 'instruction',
): AgentDelegationSnapshot {
  if (!result.ok) throw failure(result.error, kind);
  if (result.value === null) throw notFound();
  return result.value;
}

/** Whether `snapshot` sits below `ancestorId`, by its recorded parents. */
function descends(
  snapshot: AgentDelegationSnapshot,
  ancestorId: string,
  byId: ReadonlyMap<string, AgentDelegationSnapshot>,
): boolean {
  const seen = new Set<string>();
  let parentId = snapshot.parentDelegationId;
  while (parentId !== undefined && !seen.has(parentId)) {
    if (parentId === ancestorId) return true;
    seen.add(parentId);
    parentId = byId.get(parentId)?.parentDelegationId;
  }
  return false;
}

function pageStart(cursor: string | undefined, total: number): number {
  if (cursor === undefined) return 0;
  const start = /^(0|[1-9]\d{0,8})$/.test(cursor) ? Number(cursor) : -1;
  if (start < 0 || start > total)
    throw invalidArgument('The cursor is not one this list returned.');
  return start;
}

function lifetimeOf(status: ManagedDelegationLifetimeStatus): {
  used: number;
  limit: number;
} {
  switch (status.kind) {
    case 'available':
      return { used: status.occupied, limit: status.limit };
    case 'unsupported':
      throw canopyCapabilityUnavailableError(
        'This worktree has no delegation limit.',
      );
    case 'error':
      if (status.reason === 'invalid_request')
        throw invalidArgument('Invalid worktree.');
      if (status.reason === 'scope_unavailable')
        throw new CanopyOperationError({
          kind: 'not_found',
          message: 'The worktree is not available.',
          retry: { kind: 'never' },
        });
      break;
    case 'unavailable':
      break;
  }
  throw new CanopyOperationError({
    kind: 'unavailable',
    message: 'The delegation limit cannot be read right now.',
    retry: { kind: 'same_request', delayMs: 1000 },
  });
}

function messageFailure(
  result: Extract<ManagedDelegationMessageResult, { ok: false }>,
): CanopyOperationError {
  switch (result.code) {
    case 'invalid_request':
      return invalidArgument(result.error);
    case 'not_found':
      return notFound();
    case 'parent_unavailable':
      return failure(
        { code: 'parent_unavailable', message: result.error, retryable: false },
        'instruction',
      );
    // The broker records a busy or failed outcome as this operation's
    // receipt and answers it to every retry, so none is offered: sending the
    // message again takes a new operationId.
    case 'busy':
      return new CanopyOperationError({
        kind: 'failed_precondition',
        message: result.error,
        retry: { kind: 'never' },
      });
    case 'discarded':
      return new CanopyOperationError({
        kind: 'failed_precondition',
        message: result.error,
        retry: { kind: 'never' },
      });
    case 'failed':
      return new CanopyOperationError({
        kind: 'unavailable',
        message: result.error,
        retry: { kind: 'never' },
      });
  }
}

/**
 * What a keyed replay compares: the params without their request metadata,
 * so a retry with a fresh deadline or trace still replays its outcome.
 */
function replayed(params: { readonly _meta: unknown }): unknown {
  const { _meta: metadata, ...rest } = params;
  void metadata;
  return rest;
}

const agentTurnOnly = (what: string) => (): Promise<never> =>
  Promise.reject(
    canopyCapabilityUnavailableError(
      `${what} is made from an agent's own turn; desktop agents use their delegation tools.`,
    ),
  );

/**
 * `core.managedDelegation.*` on the desktop dispatcher (CAN-6291). The user
 * reads and controls map onto the delegation broker's user functions, which
 * apply their own policy; the operations only a calling agent's turn can
 * make answer `capability_unavailable`, since the dispatcher's binding
 * carries no agent turn, tool call or delegation record.
 */
export function createCoreManagedDelegationAdapter(
  host: CoreManagedDelegationHost = desktopManagedDelegationHost,
): DesktopDomainAdapter {
  const reusedError = (): CanopyOperationError =>
    invalidArgument('This idempotency key was used with other parameters.');
  // A failure that offers a retry is not kept, so the retry reaches the
  // broker; the broker's own receipts keep a control from running twice.
  const forget = (error: unknown): boolean =>
    error instanceof CanopyOperationError &&
    error.payload.retry.kind !== 'never';
  const messages = new KeyedOutcomes<{
    runGeneration: number;
    phase?: AgentDelegationSnapshot['phase'];
  }>({ reusedError, forget });
  const stops = new KeyedOutcomes<{ accepted: boolean }>({
    reusedError,
    forget,
  });
  const stopAlls = new KeyedOutcomes<{ stopped: number }>({
    reusedError,
    forget,
  });
  return {
    queries: {
      'core.managedDelegation.get': async (params, context) =>
        snapshotOf(
          await host.inspect(chatTarget(params, context), params.delegationId),
          'query',
        ),
      'core.managedDelegation.list': async (params, context) => {
        // The tree has a row per run; a delegation lists once, as its
        // latest run.
        const latest = new Map<string, ManagedDelegationTreeEntry>();
        for (const entry of await host.tree(chatTarget(params, context))) {
          const id = entry.snapshot.delegationId;
          const kept = latest.get(id);
          if (!kept || entry.runGeneration > kept.runGeneration)
            latest.set(id, entry);
        }
        const entries = [...latest.values()]
          .sort(
            (left, right) =>
              left.createdAt - right.createdAt ||
              left.snapshot.delegationId.localeCompare(
                right.snapshot.delegationId,
              ),
          )
          .map((entry) => entry.snapshot);
        const under = params.underDelegationId;
        const byId = new Map(
          entries.map((snapshot) => [snapshot.delegationId, snapshot]),
        );
        const reached =
          under === undefined
            ? entries
            : entries.filter((snapshot) => descends(snapshot, under, byId));
        const start = pageStart(params.cursor, reached.length);
        const end = start + MANAGED_DELEGATION_LIST_PAGE_MAX;
        return {
          items: reached.slice(start, end),
          nextCursor: end < reached.length ? String(end) : null,
        };
      },
      'core.managedDelegation.lifetime.get': async (params, context) => {
        const target = chatTarget(params, context);
        return lifetimeOf(
          await host.lifetime({
            projectId: target.projectId,
            worktreeId: target.worktreeId,
          }),
        );
      },
      'core.managedDelegation.models.list': agentTurnOnly('Model discovery'),
      'core.managedDelegation.output.read': agentTurnOnly('A result read'),
    },
    instructions: {
      'core.managedDelegation.message': (params, context) =>
        messages.run(context, replayed(params), async () => {
          const target = chatTarget(params, context);
          // A user message queues behind a busy delegate; it cannot be
          // refused instead.
          if (params.ifBusy === 'reject')
            throw canopyCapabilityUnavailableError(
              'A delegate message on this desktop waits for a free slot; it cannot be refused instead.',
            );
          const result = await host.message({
            ...target,
            delegationId: params.delegationId,
            operation: params.operation,
            ...(params.message !== undefined
              ? { message: params.message }
              : {}),
            operationId: params.operationId,
          });
          if (!result.ok) throw messageFailure(result);
          const { runGeneration, phase } = result.snapshot;
          if (runGeneration === undefined)
            throw new CanopyOperationError({
              kind: 'internal',
              message: 'The delegate reported no run.',
              retry: { kind: 'never' },
            });
          return { runGeneration, ...(phase ? { phase } : {}) };
        }),
      'core.managedDelegation.stop': (params, context) =>
        stops.run(context, replayed(params), async () => {
          const result = await host.stop(
            chatTarget(params, context),
            params.delegationId,
          );
          if (!result.ok) throw failure(result.error, 'instruction');
          return { accepted: true };
        }),
      'core.managedDelegation.stopAll': (params, context) =>
        stopAlls.run(context, replayed(params), async () => {
          const result = await host.stopAll(chatTarget(params, context));
          if (!result.ok) throw failure(result.error, 'instruction');
          return { stopped: result.value.stopped };
        }),
      'core.managedDelegation.spawn': agentTurnOnly('A spawn'),
      'core.managedDelegation.steering.request':
        agentTurnOnly('A steering request'),
      'core.managedDelegation.workspace.manage': agentTurnOnly(
        'An apply or discard',
      ),
    },
  };
}
