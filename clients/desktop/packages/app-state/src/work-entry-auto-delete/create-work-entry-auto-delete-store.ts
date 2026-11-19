import { create } from 'zustand';
import type { CanopyClient } from '@canopy/app-core';
import type {
  WorkEntryAutoDeleteMode,
  WorkEntryAutoDeleteRowState,
  WorkEntryAutoDeleteBranchAnswer,
} from '@canopy/protocol';
import {
  createClientStore,
  CLIENT_STORE_ACTIVATE,
  CLIENT_STORE_DISPOSE,
  type ClientStore,
} from '../create-client-store';

export interface AutoDeleteTarget {
  readonly workspaceId: string;
  readonly targetId: string;
  readonly name: string;
}

export interface WorkEntryAutoDeleteState {
  readonly workspaces: Readonly<
    Record<string, Readonly<Record<string, WorkEntryAutoDeleteRowState>>>
  >;
  readonly question:
    | (AutoDeleteTarget & { readonly confirmationId?: string })
    | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly notice:
    | {
        readonly kind: 'disarmed';
        readonly mode: WorkEntryAutoDeleteMode;
        readonly name: string;
      }
    | { readonly kind: 'error'; readonly message: string }
    | null;
  readonly activate: (target: AutoDeleteTarget) => void;
  readonly disarm: (target: AutoDeleteTarget) => Promise<void>;
  readonly resolve: (answer: WorkEntryAutoDeleteBranchAnswer) => Promise<void>;
  readonly closeQuestion: () => void;
  readonly dismissNotice: () => void;
}

/** One subscription per client lifecycle; late list results cannot replace live events. */
export function createWorkEntryAutoDeleteStore(
  client: CanopyClient,
): ClientStore<WorkEntryAutoDeleteState> {
  let disposed = false;
  let started = false;
  let unsubscribe: (() => void) | undefined;
  const changed = new Set<string>();
  const canManage = (target: AutoDeleteTarget): boolean =>
    (client.capabilitiesFor?.(target.targetId) ?? client.capabilities)
      .workEntryAutoDelete === 'manage';
  const store: ClientStore<WorkEntryAutoDeleteState> =
    create<WorkEntryAutoDeleteState>()((set, get) => ({
      workspaces: {},
      question: null,
      busy: false,
      error: null,
      notice: null,
      activate(target) {
        if (!canManage(target)) return;
        const row = get().workspaces[target.workspaceId]?.[target.targetId];
        if (row?.state === 'awaiting-branch-confirmation') {
          set({
            question: { ...target, confirmationId: row.confirmationId },
            error: null,
          });
        } else if (row) {
          void get().disarm(target);
        }
      },
      async disarm(target) {
        if (!canManage(target) || !client.disarmWorkEntryAutoDelete) return;
        const row = get().workspaces[target.workspaceId]?.[target.targetId];
        if (!row) return;
        try {
          const disarmed = await client.disarmWorkEntryAutoDelete({
            workspaceId: target.workspaceId,
            targetId: target.targetId,
          });
          if (disposed) return;
          const targets = { ...get().workspaces[target.workspaceId] };
          // Do not erase a new arm that arrived while this command ran.
          if (targets[target.targetId] === row) delete targets[target.targetId];
          set({
            workspaces: { ...get().workspaces, [target.workspaceId]: targets },
            // A removal that finished first leaves nothing to turn off; its
            // own result toast already told the user what happened.
            notice: disarmed
              ? { kind: 'disarmed', mode: row.mode, name: target.name }
              : get().notice,
            question:
              get().question?.workspaceId === target.workspaceId &&
              get().question?.targetId === target.targetId
                ? null
                : get().question,
          });
        } catch {
          if (!disposed)
            set({
              notice: {
                kind: 'error',
                message: 'Could not turn off automatic removal. Try again.',
              },
            });
        }
      },
      async resolve(answer) {
        const target = get().question;
        if (
          !target ||
          get().busy ||
          !canManage(target) ||
          !client.resolveWorkEntryAutoDeleteBranch
        )
          return;
        set({ busy: true, error: null });
        try {
          await client.resolveWorkEntryAutoDeleteBranch({
            workspaceId: target.workspaceId,
            targetId: target.targetId,
            answer,
            confirmationId: target.confirmationId,
          });
          if (!disposed) set({ question: null, busy: false });
        } catch {
          if (!disposed)
            set({
              busy: false,
              error: 'Could not save your branch choice. Try again.',
            });
        }
      },
      closeQuestion() {
        if (!get().busy) set({ question: null, error: null });
      },
      dismissNotice() {
        set({ notice: null });
      },
    }));
  store[CLIENT_STORE_ACTIVATE] = (): void => {
    if (started || disposed || !client.listWorkEntryAutoDelete) return;
    started = true;
    unsubscribe = client.subscribeWorkEntryAutoDelete?.((snapshot) => {
      if (disposed) return;
      changed.add(snapshot.workspaceId);
      store.setState((state) => ({
        workspaces: {
          ...state.workspaces,
          [snapshot.workspaceId]: snapshot.targets,
        },
        question:
          state.question?.workspaceId === snapshot.workspaceId &&
          (snapshot.targets[state.question.targetId]?.state !==
            'awaiting-branch-confirmation' ||
            snapshot.targets[state.question.targetId]?.confirmationId !==
              state.question.confirmationId)
            ? null
            : state.question,
      }));
    });
    void client
      .listWorkEntryAutoDelete()
      .then((snapshots) => {
        if (disposed) return;
        store.setState((state) => ({
          workspaces: {
            ...state.workspaces,
            ...Object.fromEntries(
              snapshots
                .filter((snapshot) => !changed.has(snapshot.workspaceId))
                .map((snapshot) => [snapshot.workspaceId, snapshot.targets]),
            ),
          },
        }));
      })
      .catch(() => {
        // Unsupported/older remote hosts have no arms. Listing metadata is
        // optional and must not raise an error notice in their sidebar.
      });
  };
  store[CLIENT_STORE_DISPOSE] = (): void => {
    disposed = true;
    unsubscribe?.();
  };
  return store;
}

export const useWorkEntryAutoDeleteStore = createClientStore(
  createWorkEntryAutoDeleteStore,
);
