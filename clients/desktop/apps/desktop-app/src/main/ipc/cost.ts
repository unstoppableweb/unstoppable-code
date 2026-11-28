import { randomUUID } from 'node:crypto';
import {
  BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron';
import {
  COST_GRANTS,
  CostChatGetResultSchema,
  CostChatRequestSchema,
  CostIndexRefreshParamsSchema,
  CostIndexRefreshResultSchema,
  CostPipelineRunGetResultSchema,
  CostPipelineRunRequestSchema,
  CostOperationErrorDetailsSchema,
  CostScopeGetResultSchema,
  CostScopeRefSchema,
  CostScopeRequestSchema,
  CostUpdatedEventSchema,
  CostRefreshRequestSchema,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import {
  type CostChatView,
  type CostRefreshReceipt,
  type CostScopeRef,
  type CostScopeView,
  type CostViewResult,
  type CostUpdatedEvent,
  type PipelineRunCostView,
  costScopeKey,
} from '@canopy/protocol/cost-view';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import { CanopyOperationError } from '@canopy/core-runtime';
import { validateId } from '../lib/validation';
import { safeOpaqueId } from '../cost-index/classifier';
import { sendToWebContents } from '../lib/web-contents-send';
import {
  dropCostScopeWatches,
  isCostScopeWatched,
  onCostUpdated,
  unwatchCostScope,
  watchCostScope,
} from '../cost-index/events';
import type { DesktopIpcCallerResolver } from './file-tree';
import { onIpcMessage, registerIpcHandler } from './register';

type CostDispatcher = Pick<DesktopCanopyDispatcher, 'query' | 'instruction'>;

function invalidInput(message: string): CostViewResult<never> {
  return { status: 'error', reason: 'INVALID_INPUT', message };
}

function callerWithCostReadGrant(
  caller: CanopyCallerDescriptor,
): CanopyCallerDescriptor {
  return { ...caller, grants: [COST_GRANTS.read] };
}

function costViewError(
  error: unknown,
  fallbackMessage: string,
): CostViewResult<never> {
  if (!(error instanceof CanopyOperationError)) {
    return { status: 'error', reason: 'UNKNOWN', message: fallbackMessage };
  }
  const details = CostOperationErrorDetailsSchema.safeParse(
    error.payload.details,
  );
  if (!details.success) {
    return { status: 'error', reason: 'UNKNOWN', message: fallbackMessage };
  }
  switch (details.data.reason) {
    case 'no_scope':
    case 'runtime_unavailable':
      return { status: 'unavailable', reason: details.data.reason };
    case 'NOT_FOUND':
      return {
        status: 'error',
        reason: 'NOT_FOUND',
        message: error.payload.message,
      };
    case 'SCOPE_SEALED':
      return {
        status: 'error',
        reason: 'SCOPE_SEALED',
        message: error.payload.message,
      };
    case 'UNKNOWN':
      return {
        status: 'error',
        reason: 'UNKNOWN',
        message: error.payload.message,
      };
    default:
      return { status: 'error', reason: 'UNKNOWN', message: fallbackMessage };
  }
}

function scopeIdsAreValid(scope: CostScopeRef): boolean {
  try {
    validateId(scope.projectId, 'project ID');
    if (scope.kind === 'entry') {
      validateId(scope.worktreeId, 'worktree ID');
    } else {
      validateId(scope.containerId, 'container ID');
    }
    return true;
  } catch {
    return false;
  }
}

// Provider subagent ids are not repository ids (Claude keeps its native
// `toolu_…` id), so they follow the store's own opaque-id rule.
function subagentIdIsValid(subagentId: string | undefined): boolean {
  return subagentId === undefined || safeOpaqueId(subagentId) === subagentId;
}

function idsAreValid(scope: CostScopeRef, ids: readonly string[]): boolean {
  if (!scopeIdsAreValid(scope)) return false;
  try {
    for (const id of ids) validateId(id, 'cost ID');
    return true;
  } catch {
    return false;
  }
}

export async function getCostScopeForView(
  dispatcher: Pick<CostDispatcher, 'query'>,
  caller: CanopyCallerDescriptor,
  request: unknown,
): Promise<CostViewResult<CostScopeView>> {
  const params = CostScopeRequestSchema.safeParse(request);
  if (!params.success || !scopeIdsAreValid(params.data.scope)) {
    return invalidInput('Invalid cost scope.');
  }
  try {
    const result = await dispatcher.query('core.cost.scope.get', params.data, {
      caller: callerWithCostReadGrant(caller),
    });
    return { status: 'ok', value: CostScopeGetResultSchema.parse(result) };
  } catch (error) {
    return costViewError(error, 'The cost scope could not be read.');
  }
}

export async function getCostChatForView(
  dispatcher: Pick<CostDispatcher, 'query'>,
  caller: CanopyCallerDescriptor,
  request: unknown,
): Promise<CostViewResult<CostChatView>> {
  const params = CostChatRequestSchema.safeParse(request);
  if (
    !params.success ||
    !idsAreValid(params.data.scope, [params.data.chatId]) ||
    !subagentIdIsValid(params.data.subagentId)
  ) {
    return invalidInput('Invalid chat cost request.');
  }
  try {
    const result = await dispatcher.query('core.cost.chat.get', params.data, {
      caller: callerWithCostReadGrant(caller),
    });
    return { status: 'ok', value: CostChatGetResultSchema.parse(result) };
  } catch (error) {
    return costViewError(error, 'The chat cost could not be read.');
  }
}

export async function getCostPipelineRunForView(
  dispatcher: Pick<CostDispatcher, 'query'>,
  caller: CanopyCallerDescriptor,
  request: unknown,
): Promise<CostViewResult<PipelineRunCostView>> {
  const params = CostPipelineRunRequestSchema.safeParse(request);
  if (
    !params.success ||
    !idsAreValid(params.data.scope, [params.data.executionId])
  ) {
    return invalidInput('Invalid workflow run cost request.');
  }
  try {
    const result = await dispatcher.query(
      'core.cost.pipelineRun.get',
      params.data,
      { caller: callerWithCostReadGrant(caller) },
    );
    return {
      status: 'ok',
      value: CostPipelineRunGetResultSchema.parse(result),
    };
  } catch (error) {
    return costViewError(error, 'The workflow run cost could not be read.');
  }
}

export async function refreshCostForView(
  dispatcher: Pick<CostDispatcher, 'instruction'>,
  caller: CanopyCallerDescriptor,
  request: unknown,
): Promise<CostViewResult<CostRefreshReceipt>> {
  const params = CostRefreshRequestSchema.safeParse(request);
  if (!params.success || !scopeIdsAreValid(params.data.scope)) {
    return invalidInput('Invalid cost refresh request.');
  }
  const requestKey = randomUUID();
  const keyedParams = CostIndexRefreshParamsSchema.parse({
    ...params.data,
    _meta: { idempotencyKey: requestKey },
  });
  try {
    const result = await dispatcher.instruction(
      'core.cost.index.refresh',
      keyedParams,
      {
        caller: callerWithCostReadGrant(caller),
        metadata: { idempotencyKey: requestKey },
      },
    );
    return { status: 'ok', value: CostIndexRefreshResultSchema.parse(result) };
  } catch (error) {
    return costViewError(error, 'The cost index could not be refreshed.');
  }
}

export interface CostScopeWatchTarget {
  readonly id: number;
  isDestroyed(): boolean;
  once(event: 'destroyed', listener: () => void): unknown;
  removeListener(event: 'destroyed', listener: () => void): unknown;
  send(channel: string, ...args: unknown[]): void;
}

export interface CostScopeWatchEvents {
  watchCostScope(windowId: number, scope: CostScopeRef): void;
  unwatchCostScope(windowId: number, scope: CostScopeRef): void;
  dropCostScopeWatches(windowId: number): void;
  isCostScopeWatched(scope: CostScopeRef): boolean;
  onCostUpdated(listener: (event: CostUpdatedEvent) => void): () => void;
}

export interface CostScopeWatchManager {
  watch(target: CostScopeWatchTarget, scope: CostScopeRef): void;
  unwatch(target: CostScopeWatchTarget, scope: CostScopeRef): void;
  dispose(): void;
}

interface CostScopeWatchEntry {
  readonly scopes: Map<string, { scope: CostScopeRef; count: number }>;
  readonly onDestroyed: () => void;
}

const DEFAULT_COST_SCOPE_WATCH_EVENTS: CostScopeWatchEvents = {
  watchCostScope,
  unwatchCostScope,
  dropCostScopeWatches,
  isCostScopeWatched,
  onCostUpdated,
};

function validCostUpdatedEvent(
  value: CostUpdatedEvent,
): CostUpdatedEvent | null {
  const parsed = CostUpdatedEventSchema.safeParse(value);
  if (!parsed.success) return null;
  if (!parsed.data.scopes.every(scopeIdsAreValid)) return null;
  return parsed.data;
}

export function createCostScopeWatchManager(
  events: CostScopeWatchEvents = DEFAULT_COST_SCOPE_WATCH_EVENTS,
  getTargets: () => readonly CostScopeWatchTarget[] = () =>
    BrowserWindow.getAllWindows().map((window) => window.webContents),
): CostScopeWatchManager {
  const watchers = new Map<CostScopeWatchTarget, CostScopeWatchEntry>();

  const removeTarget = (target: CostScopeWatchTarget): void => {
    const entry = watchers.get(target);
    if (entry === undefined) return;
    watchers.delete(target);
    target.removeListener('destroyed', entry.onDestroyed);
    events.dropCostScopeWatches(target.id);
  };

  const broadcast = (rawEvent: CostUpdatedEvent): void => {
    const event = validCostUpdatedEvent(rawEvent);
    if (event === null) return;
    watchers.forEach((_entry, target) => {
      if (target.isDestroyed()) {
        removeTarget(target);
      }
    });
    getTargets().forEach((target) => {
      if (target.isDestroyed()) return;
      sendToWebContents(target, IPC_CHANNELS.costUpdated, event);
    });
  };
  const unsubscribe = events.onCostUpdated(broadcast);

  return {
    watch(target, scope): void {
      if (target.isDestroyed()) return;
      let entry = watchers.get(target);
      if (entry === undefined) {
        const onDestroyed = (): void => removeTarget(target);
        entry = { scopes: new Map(), onDestroyed };
        watchers.set(target, entry);
        target.once('destroyed', onDestroyed);
      }
      const key = costScopeKey(scope);
      const watchedScope = entry.scopes.get(key);
      if (watchedScope !== undefined) {
        watchedScope.count += 1;
        return;
      }
      entry.scopes.set(key, { scope, count: 1 });
      events.watchCostScope(target.id, scope);
    },
    unwatch(target, scope): void {
      const entry = watchers.get(target);
      const key = costScopeKey(scope);
      const watchedScope = entry?.scopes.get(key);
      if (entry === undefined || watchedScope === undefined) return;
      watchedScope.count -= 1;
      if (watchedScope.count > 0) return;
      entry.scopes.delete(key);
      events.unwatchCostScope(target.id, watchedScope.scope);
      if (entry.scopes.size === 0) removeTarget(target);
    },
    dispose(): void {
      unsubscribe();
      Array.from(watchers.keys()).forEach(removeTarget);
    },
  };
}

function validateWatchEvent(
  event: IpcMainEvent,
  resolveCaller: DesktopIpcCallerResolver,
  scopeValue: unknown,
): CostScopeRef | null {
  const scope = CostScopeRefSchema.safeParse(scopeValue);
  if (!scope.success || !scopeIdsAreValid(scope.data)) return null;
  try {
    resolveCaller(event);
    return scope.data;
  } catch {
    return null;
  }
}

let disposeActiveCostScopeWatchHandlers: (() => void) | undefined;

export function registerCostHandlers(
  dispatcher: DesktopCanopyDispatcher,
  resolveCaller: DesktopIpcCallerResolver,
): () => void {
  disposeActiveCostScopeWatchHandlers?.();

  registerIpcHandler<[unknown], CostViewResult<CostScopeView>>(
    IPC_CHANNELS.costGetScope,
    (event: IpcMainInvokeEvent, request) =>
      getCostScopeForView(dispatcher, resolveCaller(event), request),
  );
  registerIpcHandler<[unknown], CostViewResult<CostChatView>>(
    IPC_CHANNELS.costGetChat,
    (event: IpcMainInvokeEvent, request) =>
      getCostChatForView(dispatcher, resolveCaller(event), request),
  );
  registerIpcHandler<[unknown], CostViewResult<PipelineRunCostView>>(
    IPC_CHANNELS.costGetPipelineRun,
    (event: IpcMainInvokeEvent, request) =>
      getCostPipelineRunForView(dispatcher, resolveCaller(event), request),
  );
  registerIpcHandler<[unknown], CostViewResult<CostRefreshReceipt>>(
    IPC_CHANNELS.costRefresh,
    (event: IpcMainInvokeEvent, request) =>
      refreshCostForView(dispatcher, resolveCaller(event), request),
  );

  const watchManager = createCostScopeWatchManager();
  const onWatch = (event: IpcMainEvent, scopeValue: unknown): void => {
    const scope = validateWatchEvent(event, resolveCaller, scopeValue);
    if (scope !== null) watchManager.watch(event.sender, scope);
  };
  const onUnwatch = (event: IpcMainEvent, scopeValue: unknown): void => {
    const scope = validateWatchEvent(event, resolveCaller, scopeValue);
    if (scope !== null) watchManager.unwatch(event.sender, scope);
  };
  const stopListening: Array<() => void> = [];
  stopListening.push(onIpcMessage(IPC_CHANNELS.costWatchScope, onWatch));
  stopListening.push(onIpcMessage(IPC_CHANNELS.costUnwatchScope, onUnwatch));

  const dispose = (): void => {
    for (const stop of stopListening) stop();
    watchManager.dispose();
    if (disposeActiveCostScopeWatchHandlers === dispose) {
      disposeActiveCostScopeWatchHandlers = undefined;
    }
  };
  disposeActiveCostScopeWatchHandlers = dispose;
  return dispose;
}
