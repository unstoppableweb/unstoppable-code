import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { CanopyClient } from '@canopy/app-core';
import type { ProjectDeletionDiscardDescription } from '@canopy/protocol/remote-control/shell/project-deletion-discard';
import type {
  WorktreeDiscardDescription,
  WorktreeDiscardRefusal,
  WorktreeDiscardResult,
} from '@canopy/protocol/remote-control/shell/worktree-discard';
import { describesRetainedArchive, failedAttempt } from './discard-store';
import type { ProjectDeletionDiscardOffer } from './project-deletion-offer';

/**
 * CAN-5337 (CAN-4995 E): one confirmation for every item that keeps a
 * project's deletion from finishing. After the person confirms, it supersedes
 * the interrupted deletion when one is listed (every discard refuses while it
 * is in place), discards each item through the worktree discard with its own
 * token, then runs the ordinary deletion again. Earlier discards are final: a
 * stop keeps them, and confirming again continues with what remains. Nothing
 * is discarded without a confirmation.
 */

/** How far one item got in the current run. */
export type ProjectDeletionDiscardProgress =
  | 'pending'
  | 'discarding'
  | 'discarded'
  /** The ordinary deletion removes it after all, or it is already gone. */
  | 'skipped'
  /** The run stopped on it; confirming again retries it. */
  | 'stopped';

export interface ProjectDeletionDiscardRow {
  readonly worktreeId: string;
  readonly worktreeName?: string;
  readonly description: WorktreeDiscardDescription;
  readonly progress: ProjectDeletionDiscardProgress;
}

/** Why the run stopped. Reason codes only: the shared UI owns the copy. */
export type ProjectDeletionDiscardError =
  | {
      readonly kind: 'refused';
      readonly worktreeName?: string;
      readonly reason: WorktreeDiscardRefusal;
    }
  | { readonly kind: 'changed'; readonly worktreeName?: string }
  | {
      readonly kind: 'failed';
      readonly message: string | null;
      /** The host already recorded this failure. */
      readonly recorded?: true;
    };

export type ProjectDeletionDiscardView =
  | { readonly phase: 'closed' }
  | {
      readonly phase: 'describing';
      readonly offer: ProjectDeletionDiscardOffer;
    }
  | {
      readonly phase: 'open';
      readonly offer: ProjectDeletionDiscardOffer;
      readonly description: ProjectDeletionDiscardDescription;
      readonly rows: readonly ProjectDeletionDiscardRow[];
      /** The interrupted deletion was superseded in this confirmation. */
      readonly superseded: boolean;
      /** Names discarded in an earlier confirmation of this deletion. */
      readonly earlierDiscarded: readonly string[];
      readonly busy: boolean;
      readonly error: ProjectDeletionDiscardError | null;
    };

/** A finished item's report for the host's own list and panel cleanup. */
export interface ProjectDeletionItemDiscarded {
  readonly workspaceId: string;
  readonly worktreeId: string;
  readonly warnings: readonly string[];
  /** CAN-5338: a retained archive, not a listed row. */
  readonly retainedArchive?: true;
  readonly removedTemporaryWorkspaceId?: string;
}

export interface ProjectDeletionDiscardState {
  readonly view: ProjectDeletionDiscardView;
  /**
   * Opens `offer`, describing it first when it came without a description.
   * Resolves `false`, and stays closed, when nothing can be discarded.
   */
  readonly open: (offer: ProjectDeletionDiscardOffer) => Promise<boolean>;
  /**
   * Runs the confirmed sequence. `onItemDiscarded` runs after each finished
   * discard, before the next one and before the deletion runs again, so the
   * host's state never lists a discarded worktree.
   */
  readonly confirm: (
    onItemDiscarded: (discarded: ProjectDeletionItemDiscarded) => void,
  ) => Promise<void>;
  /**
   * Discards only `worktreeId`, under the same confirmation. The rest stay
   * listed; once none is left, the deletion runs again as `confirm` does.
   */
  readonly discardItem: (
    worktreeId: string,
    onItemDiscarded: (discarded: ProjectDeletionItemDiscarded) => void,
  ) => Promise<void>;
  readonly close: () => void;
}

export type ProjectDeletionDiscardStore = UseBoundStore<
  StoreApi<ProjectDeletionDiscardState>
>;

/** An ordinary deletion finishes these itself; the run goes on. */
const SKIPPED: ReadonlySet<WorktreeDiscardRefusal> = new Set([
  'retry-available',
  'no-broken-removal',
  'not-found',
]);

type OpenView = Extract<ProjectDeletionDiscardView, { phase: 'open' }>;

function nameOf(row: ProjectDeletionDiscardRow): string {
  return row.worktreeName ?? row.worktreeId;
}

function openView(
  offer: ProjectDeletionDiscardOffer,
  description: ProjectDeletionDiscardDescription,
  earlierDiscarded: readonly string[],
): OpenView {
  return {
    phase: 'open',
    offer,
    description,
    rows: description.items.map((item) => ({
      worktreeId: item.description.worktreeId,
      ...(item.worktreeName ? { worktreeName: item.worktreeName } : {}),
      description: item.description,
      progress: 'pending',
    })),
    superseded: false,
    earlierDiscarded,
    busy: false,
    error: null,
  };
}

function createProjectDeletionDiscardStore(
  client: CanopyClient,
): ProjectDeletionDiscardStore {
  let generation = 0;
  // Discarded in a confirmation that then ran the deletion again; shown by
  // the next confirmation of the same project.
  let earlier: { workspaceId: string; names: string[] } | null = null;
  return create<ProjectDeletionDiscardState>()((set, get) => {
    const update = (
      current: number,
      change: (view: OpenView) => ProjectDeletionDiscardView,
    ): boolean => {
      const view = get().view;
      if (current !== generation || view.phase !== 'open') return false;
      set({ view: change(view) });
      return true;
    };
    const setRow = (
      current: number,
      worktreeId: string,
      row: Partial<Pick<ProjectDeletionDiscardRow, 'description' | 'progress'>>,
    ): boolean =>
      update(current, (view) => ({
        ...view,
        rows: view.rows.map((candidate) =>
          candidate.worktreeId === worktreeId
            ? { ...candidate, ...row }
            : candidate,
        ),
      }));
    const stop = (
      current: number,
      error: ProjectDeletionDiscardError,
    ): void => {
      update(current, (view) => ({ ...view, busy: false, error }));
    };
    const finished = (row: ProjectDeletionDiscardRow): boolean =>
      row.progress === 'discarded' || row.progress === 'skipped';
    const refreshDescription = (
      current: number,
      description: ProjectDeletionDiscardDescription,
      error: ProjectDeletionDiscardError,
    ): void => {
      update(current, (view) => {
        if (
          description.status === 'refused' &&
          view.rows.some((row) => !finished(row))
        ) {
          // A refusal omits removal bindings still needed to retry.
          // Keep those reviewed bindings, not cancelled recovery permission.
          return {
            ...view,
            description: {
              ...view.description,
              pendingRecovery: description.pendingRecovery,
            },
            superseded: false,
            rows: view.rows.map((row) =>
              row.progress === 'discarding'
                ? { ...row, progress: 'stopped' }
                : row,
            ),
            busy: false,
            error,
          };
        }
        return {
          ...openView(view.offer, description, [
            ...view.earlierDiscarded,
            ...view.rows
              .filter((row) => row.progress === 'discarded')
              .map(nameOf),
          ]),
          error,
        };
      });
    };
    /**
     * Every discard refuses while the interrupted deletion is in place, so it
     * is superseded first. The deletion it runs refuses again while items
     * remain; with none, it deletes the project.
     */
    const supersedeFirst = async (
      current: number,
      opened: OpenView,
    ): Promise<'continue' | 'done'> => {
      const operationId = opened.description.interruptedDeletion?.operationId;
      if (
        !operationId ||
        opened.superseded ||
        (opened.description.pendingRecovery?.length && opened.rows.length === 0)
      )
        return 'continue';
      const { offer } = opened;
      try {
        await client.command('workspace.delete', {
          workspaceId: offer.workspaceId,
          supersedeInterruptedDeletion: operationId,
          ...(opened.description.pendingRecovery?.length
            ? { discardPendingRecovery: opened.description.pendingRecovery }
            : {}),
        });
      } catch (error) {
        if (opened.rows.length > 0)
          return update(current, (view) => ({ ...view, superseded: true }))
            ? 'continue'
            : 'done';
        // With nothing listed, this was the deletion run again: its refusal
        // is described again, and anything new needs a new confirmation.
        const fresh = await client
          .command('workspace.delete.discard.describe', {
            workspaceId: offer.workspaceId,
            retainedArchives: true,
          })
          .catch(() => undefined);
        if (fresh) refreshDescription(current, fresh, failedAttempt(error));
        else stop(current, failedAttempt(error));
        return 'done';
      }
      if (current === generation) {
        generation += 1;
        earlier = null;
        set({ view: { phase: 'closed' } });
      }
      offer.onDeleted?.();
      return 'done';
    };
    /** Discards one row unless it already finished; `stop` ends the run. */
    const discardRow = async (
      current: number,
      row: ProjectDeletionDiscardRow,
      onItemDiscarded: (discarded: ProjectDeletionItemDiscarded) => void,
    ): Promise<'next' | 'stop'> => {
      const view = get().view;
      if (current !== generation || view.phase !== 'open') return 'stop';
      const latest = view.rows.find(
        (candidate) => candidate.worktreeId === row.worktreeId,
      );
      if (!latest || finished(latest)) return 'next';
      const { workspaceId } = view.offer;
      setRow(current, latest.worktreeId, { progress: 'discarding' });
      const retainedArchive = describesRetainedArchive(latest.description);
      let result: WorktreeDiscardResult;
      try {
        result = await client.command('worktree.discard', {
          workspaceId,
          worktreeId: latest.worktreeId,
          confirmation: latest.description.confirmation,
          ...(retainedArchive ? { retainedArchives: true } : {}),
        });
      } catch (error) {
        setRow(current, latest.worktreeId, { progress: 'stopped' });
        if (
          view.description.pendingRecovery?.length ||
          view.description.interruptedDeletion
        ) {
          const fresh = await client
            .command('workspace.delete.discard.describe', {
              workspaceId,
              retainedArchives: true,
            })
            .catch(() => undefined);
          if (fresh) {
            refreshDescription(current, fresh, failedAttempt(error));
            return 'stop';
          }
        }
        stop(current, failedAttempt(error));
        return 'stop';
      }
      if (result.status === 'discarded') {
        // Reported even after a newer opening: the host must drop the row.
        onItemDiscarded({
          workspaceId,
          worktreeId: latest.worktreeId,
          warnings: result.warnings,
          ...(retainedArchive ? { retainedArchive: true } : {}),
          ...(result.removedTemporaryWorkspaceId
            ? {
                removedTemporaryWorkspaceId: result.removedTemporaryWorkspaceId,
              }
            : {}),
        });
        return setRow(current, latest.worktreeId, { progress: 'discarded' })
          ? 'next'
          : 'stop';
      }
      if (result.reason !== 'changed' && SKIPPED.has(result.reason))
        return setRow(current, latest.worktreeId, { progress: 'skipped' })
          ? 'next'
          : 'stop';
      const error: ProjectDeletionDiscardError =
        result.reason === 'changed'
          ? { kind: 'changed', worktreeName: nameOf(latest) }
          : {
              kind: 'refused',
              worktreeName: nameOf(latest),
              reason: result.reason,
            };
      if (
        result.reason === 'project-deletion-pending' ||
        view.description.pendingRecovery?.length ||
        view.description.interruptedDeletion
      ) {
        // Supersession may have cancelled receipts even when this row's
        // failure is unrelated to the interrupted deletion.
        const fresh = await client
          .command('workspace.delete.discard.describe', {
            workspaceId,
            retainedArchives: true,
          })
          .catch(() => undefined);
        if (fresh) {
          refreshDescription(current, fresh, error);
          return 'stop';
        }
      }
      if (result.reason === 'project-deletion-pending') {
        // The interrupted deletion is still in place, so the supersede didn't
        // reach the host: confirming again supersedes it again. The listed
        // description still binds, as it was made as if it were superseded.
        update(current, (view) => ({
          ...view,
          superseded: false,
          rows: view.rows.map((candidate) =>
            candidate.worktreeId === latest.worktreeId
              ? { ...candidate, progress: 'stopped' }
              : candidate,
          ),
        }));
      }
      // Otherwise the fresh description replaces the confirmed one; confirming
      // again is the person's choice, never automatic.
      else
        setRow(current, latest.worktreeId, {
          progress: 'stopped',
          description: result.description,
        });
      stop(current, error);
      return 'stop';
    };
    /** Nothing listed is left: the ordinary deletion runs again. */
    const retryDeletion = (finishedView: OpenView): void => {
      earlier = {
        workspaceId: finishedView.offer.workspaceId,
        names: [
          ...finishedView.earlierDiscarded,
          ...finishedView.rows
            .filter((row) => row.progress === 'discarded')
            .map(nameOf),
        ],
      };
      generation += 1;
      set({ view: { phase: 'closed' } });
      finishedView.offer.retry();
    };
    return {
      view: { phase: 'closed' },
      open: async (offer): Promise<boolean> => {
        const showing = get().view;
        if (showing.phase === 'open' && showing.busy) return false;
        generation += 1;
        const current = generation;
        if (earlier && earlier.workspaceId !== offer.workspaceId)
          earlier = null;
        let description = offer.description;
        if (!description) {
          set({ view: { phase: 'describing', offer } });
          // CAN-5338: an older host ignores the opt-in and refuses as before.
          description = await client
            .command('workspace.delete.discard.describe', {
              workspaceId: offer.workspaceId,
              retainedArchives: true,
            })
            .catch(() => undefined);
          if (current !== generation) return false;
        }
        if (
          description?.status !== 'discardable' ||
          (description.pendingRecovery?.length &&
            client.capabilities.worktreeRecoveryResolution !== true) ||
          (description.items.length === 0 &&
            !description.interruptedDeletion &&
            !description.pendingRecovery?.length)
        ) {
          set({ view: { phase: 'closed' } });
          return false;
        }
        set({ view: openView(offer, description, earlier?.names ?? []) });
        offer.onOpen?.();
        return true;
      },
      confirm: async (onItemDiscarded): Promise<void> => {
        const opened = get().view;
        if (opened.phase !== 'open' || opened.busy) return;
        const current = generation;
        if (
          opened.description.pendingRecovery?.length &&
          client.capabilities.worktreeRecoveryResolution !== true
        ) {
          stop(current, {
            kind: 'failed',
            message: "This desktop can't discard pending archive recovery.",
          });
          return;
        }
        set({ view: { ...opened, busy: true, error: null } });
        if ((await supersedeFirst(current, opened)) !== 'continue') return;
        for (const row of opened.rows) {
          const step = await discardRow(current, row, onItemDiscarded);
          if (step === 'stop') return;
        }
        const after = get().view;
        if (current !== generation || after.phase !== 'open') return;
        if (after.description.pendingRecovery?.length) {
          try {
            // Supersession can cancel effect-free receipts before refusing on
            // sibling rows. Only unchanged members of the confirmed set remain
            // authorized after those separate requests.
            const fresh = await client.command(
              'workspace.delete.discard.describe',
              { workspaceId: opened.offer.workspaceId, retainedArchives: true },
            );
            if (current !== generation) return;
            if (client.capabilities.worktreeRecoveryResolution !== true) {
              stop(current, {
                kind: 'failed',
                message: "This desktop can't discard pending archive recovery.",
              });
              return;
            }
            // A refused discard description can leave only ordinary archive
            // retry to do. The deletion still runs its own admission checks.
            if (
              fresh.items.length > 0 ||
              fresh.pendingRecovery?.some(
                (member) =>
                  !after.description.pendingRecovery?.some(
                    (confirmed) =>
                      confirmed.operationId === member.operationId &&
                      confirmed.confirmation === member.confirmation,
                  ),
              ) ||
              (fresh.interruptedDeletion &&
                fresh.interruptedDeletion.operationId !==
                  after.description.interruptedDeletion?.operationId)
            ) {
              refreshDescription(current, fresh, {
                kind: 'failed',
                message: null,
              });
              return;
            }
            await client.command('workspace.delete', {
              workspaceId: opened.offer.workspaceId,
              ...(fresh.pendingRecovery?.length
                ? { discardPendingRecovery: fresh.pendingRecovery }
                : {}),
              ...(fresh.interruptedDeletion
                ? {
                    supersedeInterruptedDeletion:
                      fresh.interruptedDeletion.operationId,
                  }
                : {}),
            });
          } catch (error) {
            const fresh = await client
              .command('workspace.delete.discard.describe', {
                workspaceId: opened.offer.workspaceId,
                retainedArchives: true,
              })
              .catch(() => undefined);
            if (fresh) refreshDescription(current, fresh, failedAttempt(error));
            else stop(current, failedAttempt(error));
            return;
          }
          if (current === generation) {
            generation += 1;
            earlier = null;
            set({ view: { phase: 'closed' } });
          }
          opened.offer.onDeleted?.();
          return;
        }
        retryDeletion(after);
      },
      discardItem: async (worktreeId, onItemDiscarded): Promise<void> => {
        const opened = get().view;
        if (opened.phase !== 'open' || opened.busy) return;
        if (opened.description.pendingRecovery?.length) return;
        const row = opened.rows.find(
          (candidate) => candidate.worktreeId === worktreeId,
        );
        if (!row || finished(row)) return;
        const current = generation;
        set({ view: { ...opened, busy: true, error: null } });
        if ((await supersedeFirst(current, opened)) !== 'continue') return;
        if ((await discardRow(current, row, onItemDiscarded)) === 'stop')
          return;
        const after = get().view;
        if (current !== generation || after.phase !== 'open') return;
        if (
          after.rows.every(finished) &&
          !after.description.pendingRecovery?.length
        )
          retryDeletion(after);
        else set({ view: { ...after, busy: false } });
      },
      close: (): void => {
        const view = get().view;
        if (view.phase === 'open' && view.busy) return;
        generation += 1;
        earlier = null;
        set({ view: { phase: 'closed' } });
      },
    };
  });
}

const storesByClient = new WeakMap<CanopyClient, ProjectDeletionDiscardStore>();

/** One project deletion discard confirmation per client. */
export function projectDeletionDiscardStoreFor(
  client: CanopyClient,
): ProjectDeletionDiscardStore {
  const existing = storesByClient.get(client);
  if (existing) return existing;
  const store = createProjectDeletionDiscardStore(client);
  storesByClient.set(client, store);
  return store;
}
