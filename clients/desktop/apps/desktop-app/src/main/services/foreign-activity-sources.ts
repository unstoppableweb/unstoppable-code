import {
  listTrackedShellScripts,
  subscribeTrackedScriptsChanged,
} from '../lib/script-runner';
import type {
  ChatRuntimeState,
  PersistedChatTab,
  UsageLimitedChatTarget,
} from '@canopy/desktop-shared/types';
import type { RemoteControlScriptRun } from '@canopy/protocol/remote-control/shell';
import type { ExecutionEvent } from '@canopy/execution-engine/types/pipeline';
import type { ForeignActivityOperation } from './foreign-activity-ledger';

export type ForeignActivitySourceOperation = Omit<
  ForeignActivityOperation,
  'context'
>;
export interface ForeignActivitySourceUpdate {
  sequence: number;
  operation: ForeignActivitySourceOperation;
  removed?: boolean;
}
const operations = new Map<string, ForeignActivitySourceOperation>();
interface ChatRetryObservation {
  active: boolean;
  retryUserMessageId?: string;
  operation: ForeignActivitySourceOperation;
}
const chatRetries = new Map<string, ChatRetryObservation>();
// Queued identities cease to be removable once their turn dispatches.
const queuedChatKeys = new Set<string>();
const terminalKeys = new Set<string>();
const MAX_TERMINAL_OPERATIONS = 500;
const listeners = new Set<(event: ForeignActivitySourceUpdate) => void>();
let sequence = 0;
let unsubscribeTrackedScripts: (() => void) | undefined;

/** Covers automatic setup as well as runs published more richly by ScriptsService. */
function reconcileTrackedScripts(): void {
  const trackedIds = new Set<string>();
  const scriptIds = new Set(
    Array.from(operations.values())
      .filter((operation): boolean => operation.source === 'script')
      .map((operation): string => operation.operationId),
  );
  for (const tracking of listTrackedShellScripts()) {
    if (tracking.kind === 'hook' || tracking.logRef === undefined) continue;
    const runId = tracking.logRef.runId;
    trackedIds.add(runId);
    // Never reopen a terminal operation or replace ScriptsService's result token.
    if (scriptIds.has(runId)) continue;
    publish({
      source: 'script',
      operationId: runId,
      workspaceId: tracking.projectId,
      worktreeId: tracking.worktreeId,
      active: true,
      resultToken: null,
      unreadToken: null,
    });
    scriptIds.add(runId);
  }
  for (const operation of Array.from(operations.values())) {
    if (
      operation.source === 'script' &&
      operation.active &&
      !trackedIds.has(operation.operationId)
    )
      publish({
        ...operation,
        active: false,
        resultToken: `${operation.operationId}:exited`,
      });
  }
}
function key(operation: ForeignActivitySourceOperation): string {
  return JSON.stringify([
    operation.source,
    operation.workspaceId,
    operation.worktreeId,
    ...(operation.source === 'chat' ? [operation.chatId] : []),
    operation.operationId,
  ]);
}
function publish(
  operation: ForeignActivitySourceOperation,
  removed = false,
): void {
  const operationKey = key(operation);
  const previous = operations.get(operationKey);
  if (
    !removed &&
    previous !== undefined &&
    previous.source === operation.source &&
    previous.workspaceId === operation.workspaceId &&
    previous.worktreeId === operation.worktreeId &&
    previous.chatId === operation.chatId &&
    previous.operationId === operation.operationId &&
    previous.active === operation.active &&
    previous.resultToken === operation.resultToken &&
    previous.unreadToken === operation.unreadToken
  )
    return;
  if (removed) {
    operations.delete(operationKey);
    queuedChatKeys.delete(operationKey);
    chatRetries.delete(operationKey);
  } else operations.set(operationKey, operation);
  if (removed || operation.active) terminalKeys.delete(operationKey);
  else terminalKeys.add(operationKey);
  while (terminalKeys.size > MAX_TERMINAL_OPERATIONS) {
    const oldest = terminalKeys.values().next().value;
    if (oldest === undefined) break;
    terminalKeys.delete(oldest);
    const evicted = operations.get(oldest);
    // Evicted results must also leave carryover; seen handling needs this row.
    if (evicted !== undefined) publish(evicted, true);
  }
  const event = { sequence: ++sequence, operation, removed };
  for (const listener of Array.from(listeners)) listener(event);
}
/** Drop account-owned observations; sequence numbers never go backwards. */
export function resetForeignActivitySources(): void {
  operations.clear();
  chatRetries.clear();
  queuedChatKeys.clear();
  terminalKeys.clear();
  if (unsubscribeTrackedScripts !== undefined) reconcileTrackedScripts();
}

export function subscribeForeignActivitySources(
  listener: (event: ForeignActivitySourceUpdate) => void,
): () => void {
  listeners.add(listener);
  if (unsubscribeTrackedScripts === undefined) {
    unsubscribeTrackedScripts = subscribeTrackedScriptsChanged(
      reconcileTrackedScripts,
    );
    reconcileTrackedScripts();
  }
  return (): void => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      unsubscribeTrackedScripts?.();
      unsubscribeTrackedScripts = undefined;
    }
  };
}
export function foreignActivitySourceSnapshot(): {
  sequence: number;
  operations: ForeignActivitySourceOperation[];
} {
  return { sequence, operations: Array.from(operations.values()) };
}
/** Retry events bypass chat commits, so observe their main-owned lifecycle directly. */
export function publishForeignChatRetryActivity(
  target: UsageLimitedChatTarget,
  active: boolean,
  retryUserMessageId?: string,
): void {
  const tracked = chatOperations(
    target.projectId,
    target.worktreeId,
    target.chatId,
  );
  const previous = tracked[tracked.length - 1];
  if (previous === undefined) return;
  const operationKey = key(previous);
  const retry = chatRetries.get(operationKey) ?? {
    active,
    operation: previous,
  };
  retry.active = active;
  if (retryUserMessageId !== undefined)
    retry.retryUserMessageId = retryUserMessageId;
  chatRetries.set(operationKey, retry);
  publish(active ? { ...previous, active: true } : retry.operation);
}

function chatOperations(
  workspaceId: string,
  worktreeId: string,
  chatId: string,
): ForeignActivitySourceOperation[] {
  return Array.from(operations.values()).filter(
    (operation): boolean =>
      operation.source === 'chat' &&
      operation.workspaceId === workspaceId &&
      operation.worktreeId === worktreeId &&
      operation.chatId === chatId,
  );
}

/** Observe committed metadata only, never transcript bodies or renderer badges. */
export function publishForeignChatActivity(input: {
  projectId: string;
  worktreeId: string;
  tabs: readonly PersistedChatTab[];
  runtimeByChatId: Readonly<Record<string, ChatRuntimeState>>;
  removedTabIds: readonly string[];
}): void {
  for (const tab of input.tabs) {
    const identity: ForeignActivitySourceOperation = {
      source: 'chat',
      workspaceId: input.projectId,
      worktreeId: input.worktreeId,
      chatId: tab.id,
      operationId: '',
      active: false,
      resultToken: null,
      unreadToken: null,
    };
    let tracked = chatOperations(input.projectId, input.worktreeId, tab.id);
    const runtime = input.runtimeByChatId[tab.id];
    if (runtime !== undefined) {
      tracked = tracked.filter((operation): boolean => {
        const operationKey = key(operation);
        if (runtime.activeTurn?.userMessageId === operation.operationId) {
          queuedChatKeys.delete(operationKey);
        } else if (
          queuedChatKeys.has(operationKey) &&
          !runtime.queuedMessageIds.includes(operation.operationId)
        ) {
          publish(operation, true);
          return false;
        }
        return true;
      });
    }
    const previous = tracked[tracked.length - 1];
    let operationId =
      runtime?.activeTurn?.userMessageId ??
      (runtime?.status === 'queued'
        ? runtime.queuedMessageIds[0]
        : previous?.operationId);
    if (operationId === undefined) continue;
    let retry =
      previous === undefined ? undefined : chatRetries.get(key(previous));
    if (retry !== undefined) {
      if (
        operationId === retry.retryUserMessageId ||
        operationId === retry.operation.operationId
      ) {
        operationId = retry.operation.operationId;
      } else {
        chatRetries.delete(key(retry.operation));
        retry = undefined;
      }
    }
    const runtimeActive =
      runtime !== undefined &&
      [
        'queued',
        'starting',
        'streaming',
        'awaiting_input',
        'completing',
      ].includes(runtime.status);
    const resultToken = runtimeActive
      ? (previous?.resultToken ?? null)
      : tab.transcript === undefined
        ? (previous?.resultToken ?? null)
        : `${operationId}:${tab.transcript.transcriptRevision}`;
    const operation = {
      ...identity,
      operationId,
      active: runtimeActive,
      resultToken,
      unreadToken: tab.unread === true ? resultToken : null,
    };
    if (
      runtime?.status === 'queued' &&
      runtime.activeTurn === undefined &&
      !operations.has(key(operation))
    )
      queuedChatKeys.add(key(operation));
    if (retry !== undefined) retry.operation = operation;
    // Unread belongs to the tab, so reading it also clears older turn results.
    if (tab.unread !== true) {
      for (const earlier of tracked) {
        if (!earlier.active && earlier.operationId !== operationId)
          publish({ ...earlier, unreadToken: null });
      }
    }
    publish(
      retry?.active === true
        ? {
            ...operation,
            active: true,
            resultToken: previous?.resultToken ?? null,
            unreadToken: previous?.unreadToken ?? null,
          }
        : operation,
    );
  }
  for (const operation of Array.from(operations.values())) {
    if (
      operation.source === 'chat' &&
      operation.workspaceId === input.projectId &&
      operation.worktreeId === input.worktreeId &&
      operation.chatId !== undefined &&
      input.removedTabIds.includes(operation.chatId)
    )
      publish(operation, true);
  }
}
/** The hook queue reserves an execution id before ExecutionEvents begin. */
export function publishForeignPipelineQueueActivity(event: {
  type: 'queued' | 'started' | 'cancelled' | 'failed' | 'removed';
  executionId: string;
  projectId: string;
  worktreeId: string;
}): void {
  // Admission already emits ExecutionEvents, possibly including completion.
  if (event.type === 'started') return;
  const identity: ForeignActivitySourceOperation = {
    source: 'pipeline',
    operationId: event.executionId,
    workspaceId: event.projectId,
    worktreeId: event.worktreeId,
    active: event.type === 'queued',
    resultToken: null,
    unreadToken: null,
  };
  const previous = operations.get(key(identity));
  if (event.type === 'removed') {
    if (previous !== undefined) publish(previous, true);
    return;
  }
  const resultToken = identity.active
    ? null
    : `${event.executionId}:${event.type}`;
  publish({
    ...identity,
    resultToken,
    unreadToken:
      previous?.resultToken === resultToken
        ? previous.unreadToken
        : resultToken,
  });
}

export function publishForeignPipelineActivity(event: ExecutionEvent): void {
  const state = event.state;
  if (state.project_id === undefined || state.worktree_id === undefined) return;
  const active = ['pending', 'running', 'paused'].includes(state.status);
  const resultToken = active
    ? null
    : `${state.id}:${state.completed_at ?? state.status}`;
  const previous = operations.get(
    JSON.stringify(['pipeline', state.project_id, state.worktree_id, state.id]),
  );
  publish({
    source: 'pipeline',
    operationId: state.id,
    workspaceId: state.project_id,
    worktreeId: state.worktree_id,
    active,
    resultToken,
    unreadToken:
      previous?.resultToken === resultToken
        ? previous.unreadToken
        : resultToken,
  });
}
export function publishForeignScriptActivity(
  run: RemoteControlScriptRun,
): void {
  const active = run.status === 'running';
  const resultToken = active
    ? null
    : `${run.localId}:${run.finishedAt ?? run.status}:${run.exitCode ?? ''}`;
  publish({
    source: 'script',
    operationId: run.localId,
    workspaceId: run.workspaceLocalId,
    worktreeId: run.worktreeLocalId,
    active,
    resultToken,
    unreadToken: null,
  });
}
export function markForeignPipelineResultsSeen(
  workspaceId: string,
  worktreeId: string,
  executionIds: readonly string[],
): void {
  for (const operation of Array.from(operations.values())) {
    if (
      operation.source === 'pipeline' &&
      operation.workspaceId === workspaceId &&
      operation.worktreeId === worktreeId &&
      executionIds.includes(operation.operationId) &&
      operation.unreadToken !== null
    )
      publish({ ...operation, unreadToken: null });
  }
}
