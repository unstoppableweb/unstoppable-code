import { useCallback, useMemo, useRef, useState } from 'react';
import { navigateToRestoredContainerDestination } from '@/lib/archivedContainerNavigation';
import { useArchivedContainersStore } from '@/stores/archivedContainersStore';
import { useGitHubStore } from '@/stores/githubStore';
import {
  ARCHIVED_ITEM_DELETE_FAILED,
  offerRetainedArchiveDiscard,
} from './offerRetainedArchiveDiscard';

export interface ArchivedContainerActions {
  /** True while a Deleted ⇄ Archived state change is in flight. */
  changingState: boolean;
  restoring: boolean;
  deleting: boolean;
  /**
   * Move the container between its two retained states: `true` archives it
   * (locked, kept until the user deletes it), `false` deletes it (unlocked,
   * removed after the retention window restarts from now).
   */
  setArchived: (archived: boolean) => Promise<void>;
  restore: () => Promise<void>;
  deletePermanently: () => Promise<void>;
}

/** The lifecycle change in flight for a container. */
export type ArchivedContainerChange = 'state' | 'restore' | 'delete';

export interface ArchivedContainerBatchActions {
  /** Containers with a change in flight, and which change. */
  readonly busy: ReadonlyMap<string, ArchivedContainerChange>;
  readonly setArchived: (
    containerId: string,
    archived: boolean,
  ) => Promise<void>;
  readonly restore: (containerId: string) => Promise<void>;
  readonly deletePermanently: (containerId: string) => Promise<void>;
}

/**
 * One behavior source for archive actions, keyed by container: the More page
 * lists every container of a workspace and acts on each. One change at a time
 * per container.
 */
export function useArchivedContainerBatchActions(
  workspaceId: string,
): ArchivedContainerBatchActions {
  const setLocked = useArchivedContainersStore((state) => state.setLocked);
  const restoreContainer = useArchivedContainersStore((state) => state.restore);
  const deleteContainer = useArchivedContainersStore(
    (state) => state.deletePermanently,
  );
  const addToast = useGitHubStore((state) => state.addToast);
  const inFlight = useRef(new Map<string, ArchivedContainerChange>());
  const [busy, setBusy] = useState<
    ReadonlyMap<string, ArchivedContainerChange>
  >(() => new Map());

  const track = useCallback(
    async (
      containerId: string,
      change: ArchivedContainerChange,
      run: () => Promise<void>,
    ): Promise<void> => {
      if (inFlight.current.has(containerId)) return;
      inFlight.current.set(containerId, change);
      setBusy(new Map(inFlight.current));
      try {
        await run();
      } finally {
        inFlight.current.delete(containerId);
        setBusy(new Map(inFlight.current));
      }
    },
    [],
  );

  const setArchived = useCallback(
    (containerId: string, nextArchived: boolean): Promise<void> =>
      track(containerId, 'state', async () => {
        const result = await setLocked(workspaceId, containerId, nextArchived);
        if (result === null) {
          addToast(
            nextArchived
              ? "Couldn't archive this item"
              : "Couldn't move this item to deleted",
            'error',
          );
        }
      }),
    [addToast, setLocked, track, workspaceId],
  );

  const restore = useCallback(
    (containerId: string): Promise<void> =>
      track(containerId, 'restore', async () => {
        const result = await restoreContainer(workspaceId, containerId);
        if (result === null) {
          addToast("Couldn't restore this item", 'error');
          return;
        }
        if (result.warnings.length > 0) {
          addToast(result.warnings.join(' — '), 'warning', undefined, {
            category: result.kind === 'worktree' ? 'Worktree' : 'Chat',
          });
        }
        const stillPresent =
          useArchivedContainersStore
            .getState()
            .byWorkspace[
              workspaceId
            ]?.some((entry) => entry.id === containerId) ?? false;
        if (!stillPresent) {
          await navigateToRestoredContainerDestination(workspaceId, result);
        }
      }),
    [addToast, restoreContainer, track, workspaceId],
  );

  const deletePermanently = useCallback(
    (containerId: string): Promise<void> => {
      const run = (): Promise<void> =>
        track(containerId, 'delete', async () => {
          const ok = await deleteContainer(workspaceId, containerId);
          // CAN-5338: a retained worktree whose deletion can't finish offers
          // its discard, whose Retry runs this again; anything else keeps the
          // toast.
          if (
            !ok &&
            !(await offerRetainedArchiveDiscard(
              workspaceId,
              containerId,
              () => {
                void run();
              },
            ))
          ) {
            addToast(ARCHIVED_ITEM_DELETE_FAILED, 'error');
          }
        });
      return run();
    },
    [addToast, deleteContainer, track, workspaceId],
  );

  return useMemo(
    () => ({ busy, setArchived, restore, deletePermanently }),
    [busy, setArchived, restore, deletePermanently],
  );
}

/**
 * One behavior source for archive actions used by the full viewer, the
 * overview page rows, and every archived-container menu.
 */
export function useArchivedContainerActions(
  workspaceId: string,
  containerId: string,
  archived: boolean,
): ArchivedContainerActions {
  const batch = useArchivedContainerBatchActions(workspaceId);
  const change = batch.busy.get(containerId);
  return useMemo(
    () => ({
      changingState: change === 'state',
      restoring: change === 'restore',
      deleting: change === 'delete',
      setArchived: (nextArchived: boolean): Promise<void> =>
        nextArchived === archived
          ? Promise.resolve()
          : batch.setArchived(containerId, nextArchived),
      restore: (): Promise<void> => batch.restore(containerId),
      deletePermanently: (): Promise<void> =>
        batch.deletePermanently(containerId),
    }),
    [archived, batch, change, containerId],
  );
}
