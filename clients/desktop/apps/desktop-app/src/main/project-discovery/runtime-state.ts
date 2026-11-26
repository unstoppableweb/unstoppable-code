import type {
  ChatRuntimeState,
  ChatStateSnapshot,
  ClaudeTerminalTurnState,
} from '@canopy/desktop-shared/types';
import type { RuntimeState } from '@canopy/desktop-shared/lib/project-discovery';
import { claudeTerminalTurnStates } from '../lib/terminal-driven-chat';
import { DiscoveryError } from './errors';
import { readTaskSnapshot } from './sources';

/**
 * Live managed-terminal turn states for snapshots read here. A terminal turn
 * never reports to the host runtime record, so the record alone can say a
 * chat is done while its terminal is still running.
 */
const terminalTurnStateBySnapshot = new WeakMap<
  ChatStateSnapshot,
  (chatId: string) => ClaudeTerminalTurnState | undefined
>();

export type ProjectedRuntimeEvidence = {
  runtimeState: RuntimeState;
  runtimeObservedAt: string;
  queuedMessageCount: number;
  canSteerQueuedMessage: boolean;
  lastActivityAt?: string;
};

/**
 * Project only canonical runtime facts. The chat-state service may synthesize
 * a bare idle record when no runtime has ever been persisted; that record is
 * not evidence that the runtime was observed idle.
 */
export function runtimeStateFromEvidence(
  runtime: ChatRuntimeState | undefined,
): RuntimeState {
  if (!runtime) return 'unknown';

  switch (runtime.status) {
    case 'idle':
      return hasIdleEvidence(runtime) ? 'idle' : 'unknown';
    case 'queued':
      return 'queued';
    case 'starting':
    case 'streaming':
    case 'completing':
      return 'running';
    case 'interrupted':
      return 'interrupted';
    case 'failed':
      return runtime.error?.code === 'interrupted' ? 'interrupted' : 'error';
    case 'awaiting_input':
      return runtime.error?.code === 'interrupted' ? 'interrupted' : 'unknown';
    case 'completed':
      return 'idle';
    case 'cancelled':
      return runtime.error?.code === 'interrupted' ? 'interrupted' : 'idle';
  }
}

export function projectRuntimeEvidence(
  snapshot: ChatStateSnapshot,
  chatId: string,
): ProjectedRuntimeEvidence {
  const runtime = snapshot.runtimeByChatId[chatId];
  const terminalTurnState = terminalTurnStateBySnapshot.get(snapshot)?.(chatId);
  const observedState =
    terminalTurnState === 'starting' ||
    terminalTurnState === 'running' ||
    terminalTurnState === 'cleaning_up'
      ? 'running'
      : runtimeStateFromEvidence(runtime);
  const queuedMessageCount = snapshot.queue
    .filter((event) => event.chatId === chatId)
    .reduce((count, event) => count + event.queue.length, 0);
  const runtimeState =
    queuedMessageCount > 0 &&
    (observedState === 'unknown' || observedState === 'idle')
      ? 'queued'
      : observedState;
  const activityAt = validActivityAt(runtime);
  return {
    runtimeState,
    runtimeObservedAt: new Date().toISOString(),
    queuedMessageCount,
    canSteerQueuedMessage: runtime?.steeringCapabilities?.steer === true,
    ...(activityAt ? { lastActivityAt: activityAt } : {}),
  };
}

/** Reject incomplete or mis-scoped snapshots instead of projecting them empty. */
export async function readTaskRuntimeSnapshot(
  projectId: string,
  taskId: string,
): Promise<ChatStateSnapshot> {
  const snapshot = await readTaskSnapshot(projectId, taskId);
  if (
    snapshot.projectId !== projectId ||
    snapshot.worktreeId !== taskId ||
    snapshot.recoveryError !== undefined
  ) {
    throw new DiscoveryError(
      'execution_failed',
      'Chat state could not be read.',
    );
  }
  const turnState = await claudeTerminalTurnStates();
  terminalTurnStateBySnapshot.set(snapshot, (chatId) =>
    turnState({ projectId: snapshot.projectId, worktreeId: taskId, chatId }),
  );
  return snapshot;
}

/**
 * Returns true/false only when all chat runtime facts can answer the question.
 * A queued chat is known not to be running; a missing/defaulted idle record is
 * unknown and therefore keeps the aggregate nullable.
 */
export function hasRunningChats(
  snapshot: ChatStateSnapshot,
  chatIds: string[],
): boolean | null {
  if (chatIds.length === 0) return false;

  let unknown = false;
  for (const chatId of chatIds) {
    const state = projectRuntimeEvidence(snapshot, chatId).runtimeState;
    if (state === 'running') return true;
    if (state === 'unknown') unknown = true;
  }

  return unknown ? null : false;
}

function hasIdleEvidence(runtime: ChatRuntimeState): boolean {
  return (
    (runtime.lastActivityAt !== undefined &&
      Number.isFinite(runtime.lastActivityAt)) ||
    runtime.activeTurn !== undefined ||
    runtime.error !== undefined
  );
}

function validActivityAt(
  runtime: ChatRuntimeState | undefined,
): string | undefined {
  const timestamp = runtime?.lastActivityAt;
  if (timestamp !== undefined && Number.isFinite(timestamp)) {
    const date = new Date(timestamp);
    if (!Number.isNaN(date.valueOf())) return date.toISOString();
  }
  return undefined;
}
