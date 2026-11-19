import { create } from 'zustand';
import { useShallow } from 'zustand/shallow';
import {
  PERSONAL_WORKSPACE_CONTEXT,
  type SetWorkspaceContextRequest,
  type WorkspaceContext,
  type WorkspaceContextBroadcast,
  type WorkspaceContextChangeReason,
  type WorkspaceContextState,
} from '@canopy/desktop-shared/types';
import { reportRendererConsoleError } from '../lib/renderer-error-logging';

/**
 * Renderer-side mirror of the main-owned Personal/organization context
 * (CAN-2952). Main is the source of truth: the renderer hydrates once through
 * `window.api.workspaceContext.get()` and then applies every
 * `workspace-context:changed` broadcast, so all windows agree. `setContext`
 * round-trips through main and never updates local state optimistically,
 * because the switch may be rejected (stale revision, lost membership).
 */
interface WorkspaceContextStoreState {
  state: WorkspaceContextState;
  hydrated: boolean;
  /** Reason of the last applied broadcast; `null` until the first one. */
  lastChangeReason: WorkspaceContextChangeReason | null;
  /**
   * Bumped by every account-change broadcast. An IPC reply that started
   * under an earlier epoch belongs to another account's revision space and
   * is dropped instead of overwriting the newer broadcast.
   */
  accountEpoch: number;
  /**
   * Last worktree selection per serialized context (`personal`, `org:<id>`),
   * so switching back restores where the user was (CAN-2954). Renderer-only
   * and per window; never persisted.
   */
  lastSelectionByContext: Readonly<
    Record<string, { projectId: string; worktreeId: string } | null>
  >;
  rememberSelection: (
    contextKey: string,
    selection: { projectId: string; worktreeId: string } | null,
  ) => void;
  /** Bumped by every applied broadcast, including membership-only updates. */
  appliedGeneration: number;
  hydrate: () => Promise<void>;
  applyBroadcast: (broadcast: WorkspaceContextBroadcast) => void;
  setContext: (context: WorkspaceContext) => Promise<WorkspaceContextState>;
}

function sameWorkspaceContext(
  left: WorkspaceContext,
  right: WorkspaceContext,
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  return (
    left.kind !== 'organization' ||
    right.kind !== 'organization' ||
    left.organizationId === right.organizationId
  );
}

class WorkspaceContextSwitchError extends Error {
  constructor(
    readonly code: 'account-changed' | 'stale-revision',
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceContextSwitchError';
  }
}

const INITIAL_STATE: WorkspaceContextState = {
  context: PERSONAL_WORKSPACE_CONTEXT,
  revision: 0,
  organizations: [],
};

// Initial hydration and Home recovery share outstanding reads per account. A
// timeout never releases an IPC call; only settlement permits another read.
const hydrationInFlight = new Map<number, Promise<void>>();

export const useWorkspaceContextStore = create<WorkspaceContextStoreState>(
  (set, get) => ({
    state: INITIAL_STATE,
    hydrated: false,
    lastChangeReason: null,
    accountEpoch: 0,
    lastSelectionByContext: {},
    rememberSelection: (contextKey, selection): void => {
      set((current) => ({
        lastSelectionByContext: {
          ...current.lastSelectionByContext,
          [contextKey]: selection,
        },
      }));
    },
    appliedGeneration: 0,
    hydrate: (): Promise<void> => {
      const epoch = get().accountEpoch;
      const outstanding = hydrationInFlight.get(epoch);
      if (outstanding) return outstanding;
      const generation = get().appliedGeneration;
      const attempt = (async (): Promise<void> => {
        try {
          const state = await window.api.workspaceContext.get();
          // A broadcast that arrived while the reply was in flight is newer
          // than the reply; never let the late reply roll it back.
          if (
            get().accountEpoch !== epoch ||
            get().appliedGeneration !== generation ||
            state.revision < get().state.revision
          ) {
            set({ hydrated: true });
            return;
          }
          set({ state, hydrated: true });
        } catch (error) {
          reportRendererConsoleError('Failed to hydrate workspace context', {
            error,
          });
          // Keep the unresolved state so Home can offer recovery.
        }
      })().finally(() => {
        if (hydrationInFlight.get(epoch) === attempt)
          hydrationInFlight.delete(epoch);
      });
      hydrationInFlight.set(epoch, attempt);
      return attempt;
    },
    applyBroadcast: (broadcast): void => {
      const current = get().state;
      // Broadcasts carry a monotonic revision per account; an account change
      // legitimately resets it, so only same-account regressions are dropped.
      if (
        broadcast.reason !== 'account-change' &&
        broadcast.revision < current.revision
      ) {
        return;
      }
      const { reason, ...state } = broadcast;
      set((current) => ({
        state,
        hydrated: true,
        lastChangeReason: reason,
        appliedGeneration: current.appliedGeneration + 1,
        accountEpoch:
          reason === 'account-change'
            ? current.accountEpoch + 1
            : current.accountEpoch,
      }));
    },
    setContext: async (context): Promise<WorkspaceContextState> => {
      const request: SetWorkspaceContextRequest = {
        context,
        expectedRevision: get().state.revision,
      };
      const epoch = get().accountEpoch;
      const generation = get().appliedGeneration;
      const state = await window.api.workspaceContext.set(request);
      if (get().accountEpoch !== epoch) {
        throw new WorkspaceContextSwitchError(
          'account-changed',
          'The account changed while switching the workspace context.',
        );
      }
      const current = get();
      if (
        current.appliedGeneration !== generation ||
        state.revision < current.state.revision
      ) {
        // A broadcast landed while the reply was in flight. Main broadcasts a
        // switch to every window before answering the requester, so when the
        // newer state already carries the requested context this switch
        // succeeded: keep the newer broadcast (never roll it back to the
        // reply) and resolve. Only a broadcast that moved the context
        // elsewhere makes this switch stale.
        if (sameWorkspaceContext(current.state.context, context)) {
          return current.state;
        }
        throw new WorkspaceContextSwitchError(
          'stale-revision',
          'The workspace context changed while the switch was in flight.',
        );
      }
      set({ state, hydrated: true });
      return state;
    },
  }),
);

/** The active navigation context; Personal until main has been asked. */
export function useWorkspaceContext(): WorkspaceContext {
  return useWorkspaceContextStore(useShallow((store) => store.state.context));
}
