/*
 * The item store port (CAN-4098; CAN-4358 map §2 "Item store"): purge and
 * relocate the items a worktree or workspace keeps beside its records. Callers
 * name targets by scope only; the host resolves where each scope's items live,
 * so nothing here derives a path.
 *
 * A store whose writer moves elsewhere, such as a daemon-owned store after its
 * flip (map §7 D1), plugs in as a participant: its purge and relocation run
 * before the host's, and the host's removal is told to keep that store's
 * entries. With no participants the composed store is the host's behaviour.
 */

export interface CoreItemStoreWorktreeScope {
  readonly workspaceId: string;
  readonly worktreeId: string;
}

/**
 * What a purge removes:
 * - `worktree`: one worktree's items.
 * - `workspace` at `items`: the workspace's own items; its records stay.
 * - `workspace` at `folder`, once its records are gone: the named worktrees'
 *   items, then the workspace's folder when nothing else is left in it.
 */
export type CoreItemStorePurgeTarget =
  | ({ readonly scope: 'worktree' } & CoreItemStoreWorktreeScope)
  | {
      readonly scope: 'workspace';
      readonly workspaceId: string;
      readonly stage: 'items';
    }
  | {
      readonly scope: 'workspace';
      readonly workspaceId: string;
      readonly stage: 'folder';
      readonly worktreeIds: readonly string[];
    };

/** A purge as the host runs it, after every participant has purged. */
export interface CoreItemStoreHostPurge {
  readonly target: CoreItemStorePurgeTarget;
  /** Participants' stores, whose entries the host's removal must keep. */
  readonly keepStores: readonly string[];
}

export type CoreItemStoreRelocationSource =
  | ({ readonly kind: 'worktree' } & CoreItemStoreWorktreeScope)
  | {
      readonly kind: 'archived-container';
      readonly workspaceId: string;
      readonly containerId: string;
    };

export interface CoreItemStoreRelocationDestination extends CoreItemStoreWorktreeScope {
  /** The repository whose items go here, for a multi-repository source. */
  readonly repoId?: string;
}

/** The portable part of a relocation: what moves from where to where. */
export interface CoreItemStoreRelocationScope {
  /** A `copy` leaves the source as it was; a `move` takes the items from it. */
  readonly mode: 'move' | 'copy';
  readonly source: CoreItemStoreRelocationSource;
  readonly destinations: readonly CoreItemStoreRelocationDestination[];
}

export interface CoreItemStoreRelocateRequest<
  Plan,
> extends CoreItemStoreRelocationScope {
  /** The host's own record of which items go where; core never reads it. */
  readonly plan: Plan;
}

/** A relocation that can still be taken back. */
export interface CoreItemStoreRelocation {
  /** Keep the relocation and release what taking it back needed. */
  commit(): Promise<void>;
  /** Return the source to its state before the relocation. */
  revert(): Promise<void>;
  /** Return to the source what went to one destination. */
  revertDestination(
    destination: CoreItemStoreRelocationDestination,
  ): Promise<void>;
}

/** What `relocate` returns when the source is untouched, as after a copy. */
export const CORE_ITEM_STORE_SOURCE_UNCHANGED: CoreItemStoreRelocation =
  Object.freeze({
    commit: (): Promise<void> => Promise.resolve(),
    revert: (): Promise<void> => Promise.resolve(),
    revertDestination: (): Promise<void> => Promise.resolve(),
  });

export interface CoreItemStore<Plan> {
  purge(target: CoreItemStorePurgeTarget): Promise<void>;
  relocate(
    request: CoreItemStoreRelocateRequest<Plan>,
  ): Promise<CoreItemStoreRelocation>;
}

/** The host's items: every store no participant owns. */
export interface CoreItemStoreHost<Plan> {
  purge(purge: CoreItemStoreHostPurge): Promise<void>;
  relocate(
    request: CoreItemStoreRelocateRequest<Plan>,
  ): Promise<CoreItemStoreRelocation>;
}

/** One store whose purge and relocation run outside the host. */
export interface CoreItemStoreParticipant {
  /** The storage-ownership id of the store, such as `file_annotations`. */
  readonly store: string;
  purge(target: CoreItemStorePurgeTarget): Promise<void>;
  /** Absent when the store's items never relocate. */
  relocate?(
    scope: CoreItemStoreRelocationScope,
  ): Promise<CoreItemStoreRelocation>;
}

/** Several failures from one item store step, in the order they occurred. */
export class CoreItemStoreErrors extends Error {
  readonly errors: readonly unknown[];
  constructor(errors: readonly unknown[], message: string) {
    super(message);
    this.name = 'CoreItemStoreErrors';
    this.errors = errors;
  }
}

/**
 * A relocation failed and the participants' relocations could not all be taken
 * back, so the source may be partly moved. Callers treat it like the host's
 * own failed-rollback error.
 */
export class CoreItemStoreRelocationRollbackError extends CoreItemStoreErrors {
  constructor(errors: readonly unknown[]) {
    super(errors, 'Item store relocation failed and could not be taken back');
    this.name = 'CoreItemStoreRelocationRollbackError';
  }
}

/** Runs every step, then rethrows: one failure as is, several together. */
async function runEvery(
  steps: readonly (() => Promise<void>)[],
  message: string,
): Promise<void> {
  const errors: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new CoreItemStoreErrors(errors, message);
}

function composeRelocations(
  host: CoreItemStoreRelocation,
  participants: readonly CoreItemStoreRelocation[],
): CoreItemStoreRelocation {
  // Take back in reverse of the order the relocations ran.
  const reverted = [host, ...[...participants].reverse()];
  return {
    commit: () =>
      runEvery(
        [host, ...participants].map((relocation) => () => relocation.commit()),
        'Item store relocation commit failed',
      ),
    revert: () =>
      runEvery(
        reverted.map((relocation) => () => relocation.revert()),
        'Item store relocation revert failed',
      ),
    revertDestination: (destination) =>
      runEvery(
        reverted.map(
          (relocation) => () => relocation.revertDestination(destination),
        ),
        'Item store relocation revert failed',
      ),
  };
}

/**
 * The item store over `host`, with `participants` run first in order. A
 * participant's failed purge stops the purge before the host removes
 * anything. A failed relocation takes back the participants' relocations that
 * ran, then rethrows its error, or a `CoreItemStoreRelocationRollbackError`
 * when taking one back fails too.
 */
export function composeCoreItemStore<Plan>(
  host: CoreItemStoreHost<Plan>,
  participants: readonly CoreItemStoreParticipant[],
): CoreItemStore<Plan> {
  const keepStores = participants.map((participant) => participant.store);
  return {
    purge: async (target) => {
      for (const participant of participants) await participant.purge(target);
      await host.purge({ target, keepStores });
    },
    relocate: async (request) => {
      const relocated: CoreItemStoreRelocation[] = [];
      const scope: CoreItemStoreRelocationScope = {
        mode: request.mode,
        source: request.source,
        destinations: request.destinations,
      };
      try {
        for (const participant of participants)
          if (participant.relocate)
            relocated.push(await participant.relocate(scope));
        const hostRelocation = await host.relocate(request);
        return relocated.length === 0
          ? hostRelocation
          : composeRelocations(hostRelocation, relocated);
      } catch (error) {
        const rollbackErrors: unknown[] = [];
        for (const relocation of [...relocated].reverse())
          await relocation.revert().catch((rollbackError: unknown) => {
            rollbackErrors.push(rollbackError);
          });
        if (rollbackErrors.length > 0)
          throw new CoreItemStoreRelocationRollbackError([
            error,
            ...rollbackErrors,
          ]);
        throw error;
      }
    },
  };
}
