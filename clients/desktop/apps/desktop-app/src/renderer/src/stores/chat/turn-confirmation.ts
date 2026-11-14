import type {
  ChatGetStateRequest,
  ChatRuntimeState,
  ChatStateSnapshot,
} from '@canopy/desktop-shared/types';
import { chatScopeKey } from './revisioned-sync';
import { chatStoreApi } from './store-ref';
import { chatBackendFor } from './backend';
import { runtimeRunsTurn } from './runtime-runs-turn';

export type CanonicalTurnState = 'active' | 'inactive' | 'unknown';

export interface CanonicalTurnConfirmation {
  state: CanonicalTurnState;
  /** The active turn's user-message id when `state` is 'active'. */
  userMessageId?: string;
  /** Snapshot revision the answer was read at; absent for 'unknown'. */
  revision?: number;
}

/** Whether one chat's canonical runtime holds a running turn. */
export function canonicalTurnStateFor(
  runtime: ChatRuntimeState | undefined,
): Exclude<CanonicalTurnState, 'unknown'> {
  return runtimeRunsTurn(runtime) ? 'active' : 'inactive';
}

export interface ConfirmCanonicalTurnDeps {
  getState: (request: ChatGetStateRequest) => Promise<ChatStateSnapshot>;
  /** Revision the renderer has applied for the scope, if any. */
  appliedRevision: (projectId: string, worktreeId: string) => number | null;
  timeoutMs: number;
  /** The runtime the renderer holds for the chat. */
  cachedRuntime?: (chatId: string) => ChatRuntimeState | undefined;
  /** Revision-guarded snapshot refresh of a live scope. */
  refresh?: (projectId: string, worktreeId: string) => void;
}

const defaultDeps = (): ConfirmCanonicalTurnDeps => ({
  getState: (request) => chatBackendFor(request).chat.getState(request),
  appliedRevision: (projectId, worktreeId) =>
    chatStoreApi().getState().chatStateSync[chatScopeKey(projectId, worktreeId)]
      ?.revision ?? null,
  timeoutMs: 5_000,
  cachedRuntime: (chatId) => chatStoreApi().getState().runtimeByChatId[chatId],
  refresh: (projectId, worktreeId) =>
    chatStoreApi().getState().refreshChatScopeRevisioned(projectId, worktreeId),
});

// One read per scope at a time; concurrent callers share it.
const readsInFlight = new Map<string, Promise<ChatStateSnapshot | null>>();

function readScope(
  projectId: string,
  worktreeId: string,
  deps: ConfirmCanonicalTurnDeps,
): Promise<ChatStateSnapshot | null> {
  const key = chatScopeKey(projectId, worktreeId);
  const pending = readsInFlight.get(key);
  if (pending) return pending;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = Promise.race([
    deps.getState({ projectId, worktreeId }),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), deps.timeoutMs);
    }),
  ])
    .catch(() => null)
    .finally(() => {
      clearTimeout(timer);
      readsInFlight.delete(key);
    });
  readsInFlight.set(key, read);
  return read;
}

/**
 * An awaited read of one chat's canonical runtime from main. A failed or
 * timed-out read, or one older than what the renderer already applied, is
 * 'unknown' rather than a guess.
 */
export async function confirmCanonicalTurn(
  target: { projectId: string; worktreeId: string; chatId: string },
  deps: ConfirmCanonicalTurnDeps = defaultDeps(),
): Promise<CanonicalTurnConfirmation> {
  const snapshot = await readScope(target.projectId, target.worktreeId, deps);
  if (!snapshot) return { state: 'unknown' };
  const applied = deps.appliedRevision(target.projectId, target.worktreeId);
  if (applied !== null && snapshot.revision < applied) {
    return { state: 'unknown' };
  }
  const runtime = snapshot.runtimeByChatId[target.chatId];
  const state = canonicalTurnStateFor(runtime);
  // Main moved past a runtime the renderer still shows (missed revisions):
  // catch the projection up instead of letting each caller patch around it.
  if (
    applied !== null &&
    snapshot.revision > applied &&
    deps.cachedRuntime &&
    canonicalTurnStateFor(deps.cachedRuntime(target.chatId)) !== state
  ) {
    deps.refresh?.(target.projectId, target.worktreeId);
  }
  return {
    state,
    revision: snapshot.revision,
    ...(state === 'active' && runtime?.activeTurn
      ? { userMessageId: runtime.activeTurn.userMessageId }
      : {}),
  };
}
