import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { CanopyClient } from '@canopy/app-core';
import type {
  WorktreeDiscardDescription,
  WorktreeDiscardRefusal,
  WorktreeDiscardResult,
} from '@canopy/protocol/portal/worktree-discard';
import type { WorktreeDiscardOffer } from './discard-offer';

/**
 * Why the last discard attempt didn't finish. Reason codes only: the shared
 * UI owns the copy. `failed` carries the transport's own message.
 */
export type WorktreeDiscardAttemptError =
  | { readonly kind: 'refused'; readonly reason: WorktreeDiscardRefusal }
  | { readonly kind: 'changed' }
  | { readonly kind: 'failed'; readonly message: string | null };

/** A finished discard's report for the host's own cleanup. */
interface WorktreeDiscardFinished {
  readonly warnings: string[];
  /** CAN-5338: a retained archive was discarded; no row was listed. */
  readonly retainedArchive?: true;
  /** The temporary project the discard left empty and removed. */
  readonly removedTemporaryWorkspaceId?: string;
}

/** CAN-5336: the discard confirmation one client shows at a time. */
export type WorktreeDiscardView =
  | { readonly phase: 'closed' }
  | { readonly phase: 'describing'; readonly offer: WorktreeDiscardOffer }
  | {
      readonly phase: 'open';
      readonly offer: WorktreeDiscardOffer;
      readonly description: WorktreeDiscardDescription;
      readonly busy: boolean;
      readonly error: WorktreeDiscardAttemptError | null;
    };

export interface WorktreeDiscardState {
  readonly view: WorktreeDiscardView;
  /**
   * Opens `offer`, describing it first when it came without a description.
   * Resolves `false`, and stays closed, when nothing can be discarded: the
   * host then shows the refusal's own message.
   */
  readonly open: (offer: WorktreeDiscardOffer) => Promise<boolean>;
  /** Resolves with what a finished discard reports to its host, or `null`. */
  readonly discard: () => Promise<WorktreeDiscardFinished | null>;
  /**
   * Closes the dialog and runs the ordinary removal again, unless
   * `worktreeRemovalRetryable` says that removal isn't the way back.
   */
  readonly retry: () => void;
  readonly close: () => void;
}

export type WorktreeDiscardStore = UseBoundStore<
  StoreApi<WorktreeDiscardState>
>;

/**
 * Whether Retry may run the offer's ordinary removal again. Not when the
 * refusal points at the project's deletion: that, not this removal, is the
 * way back (CAN-4995 E).
 */
export function worktreeRemovalRetryable(view: WorktreeDiscardView): boolean {
  if (view.phase === 'closed') return false;
  if (view.phase === 'describing') return true;
  const refusal = view.description.refusal;
  return (
    refusal?.retry !== 'delete-project' &&
    refusal?.reason !== 'project-deletion-pending'
  );
}

/**
 * CAN-5338: a description of a retained archive, which only a host that
 * received `retainedArchives` returns. Its discard sends the opt-in too, so no
 * caller has to remember it.
 */
export function describesRetainedArchive(
  description: WorktreeDiscardDescription,
): boolean {
  return description.targets.some(
    (target) => target.kind === 'retained-archive',
  );
}

/** Electron wraps IPC rejections as `Error invoking remote method '…': Class: text`. */
export function failureText(error: unknown): string | null {
  const raw = error instanceof Error ? error.message : '';
  const text = raw
    .replace(/^error invoking remote method '[^']*':\s*/i, '')
    .replace(/^(?:error|[a-z][a-z0-9_]*error):\s*/i, '')
    .trim();
  return text || null;
}

function createWorktreeDiscardStore(
  client: CanopyClient,
): WorktreeDiscardStore {
  // Each opening owns its answers; a late answer to an older one is dropped.
  let generation = 0;
  return create<WorktreeDiscardState>()((set, get) => ({
    view: { phase: 'closed' },
    open: async (offer): Promise<boolean> => {
      // A running discard keeps its dialog; the later refusal shows its message.
      const showing = get().view;
      if (showing.phase === 'open' && showing.busy) return false;
      generation += 1;
      const current = generation;
      let description = offer.description;
      if (!description) {
        set({ view: { phase: 'describing', offer } });
        description = await client
          .command('worktree.discard.describe', {
            workspaceId: offer.workspaceId,
            worktreeId: offer.worktreeId,
            ...(offer.retainedArchives === true
              ? { retainedArchives: true }
              : {}),
          })
          .catch(() => undefined);
        if (current !== generation) return false;
      }
      if (description?.status !== 'discardable') {
        set({ view: { phase: 'closed' } });
        return false;
      }
      set({
        view: { phase: 'open', offer, description, busy: false, error: null },
      });
      return true;
    },
    discard: async (): Promise<WorktreeDiscardFinished | null> => {
      const view = get().view;
      if (view.phase !== 'open' || view.busy) return null;
      if (view.description.status !== 'discardable') return null;
      const current = generation;
      set({ view: { ...view, busy: true, error: null } });
      const retainedArchive = describesRetainedArchive(view.description);
      let result: WorktreeDiscardResult;
      try {
        result = await client.command('worktree.discard', {
          workspaceId: view.offer.workspaceId,
          worktreeId: view.offer.worktreeId,
          confirmation: view.description.confirmation,
          ...(retainedArchive ? { retainedArchives: true } : {}),
        });
      } catch (error) {
        if (current === generation)
          set({
            view: {
              ...view,
              busy: false,
              error: { kind: 'failed', message: failureText(error) },
            },
          });
        return null;
      }
      if (result.status === 'discarded') {
        // Reported even after a newer opening: the host must drop the row.
        if (current === generation) {
          generation += 1;
          set({ view: { phase: 'closed' } });
        }
        return {
          warnings: result.warnings,
          ...(retainedArchive ? { retainedArchive: true } : {}),
          ...(result.removedTemporaryWorkspaceId
            ? {
                removedTemporaryWorkspaceId: result.removedTemporaryWorkspaceId,
              }
            : {}),
        };
      }
      if (current !== generation) return null;
      // The new description replaces the reviewed one; confirming again is
      // the user's choice, never automatic.
      set({
        view: {
          ...view,
          description: result.description,
          busy: false,
          error:
            result.reason === 'changed'
              ? { kind: 'changed' }
              : { kind: 'refused', reason: result.reason },
        },
      });
      return null;
    },
    retry: (): void => {
      const view = get().view;
      if (view.phase === 'closed' || (view.phase === 'open' && view.busy))
        return;
      if (!worktreeRemovalRetryable(view)) return;
      generation += 1;
      set({ view: { phase: 'closed' } });
      view.offer.retry();
    },
    close: (): void => {
      const view = get().view;
      if (view.phase === 'open' && view.busy) return;
      generation += 1;
      set({ view: { phase: 'closed' } });
    },
  }));
}

const storesByClient = new WeakMap<CanopyClient, WorktreeDiscardStore>();

/** One discard confirmation per client. */
export function worktreeDiscardStoreFor(
  client: CanopyClient,
): WorktreeDiscardStore {
  const existing = storesByClient.get(client);
  if (existing) return existing;
  const store = createWorktreeDiscardStore(client);
  storesByClient.set(client, store);
  return store;
}
