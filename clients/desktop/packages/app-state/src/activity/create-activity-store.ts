import { create } from 'zustand';
import type { StoreApi, UseBoundStore } from 'zustand';
import type { CanopyClient, SessionViewModel } from '@canopy/app-core';
import type {
  RemoteControlChangedFiles,
  RemoteControlPrStatus,
} from '@canopy/protocol/remote-control/shell';
import { createClientStore } from '../create-client-store';
import { resolveActivitySectionOrder } from './section-order';

/**
 * The shared activity store. The Code-tab activity sections (changed files,
 * summary, PR, plans, scripts, hooks, pipeline runs, terminals) all ride on the
 * neutral {@link SessionViewModel} shell snapshot, so this store is a snapshot
 * holder + section-order state; per-section data is read through the pure
 * selectors below. Section reorders persist via `activity.setSectionOrder`.
 *
 * Interactive dispatch (run a script, revert a file, cancel a run) lives in the
 * consuming section components, gated by `isActivitySectionInteractive`; the
 * store is view-model only.
 */
export interface ActivityState {
  /** The last-hydrated shell snapshot, or `null` before first load. */
  readonly snapshot: SessionViewModel | null;
  /** Optimistic per-workspace section-order overrides (keyed by workspaceLocalId). */
  readonly sectionOrderOverrides: Readonly<Record<string, readonly string[]>>;
  /** Replace the shell snapshot (e.g. on first load or resync). */
  hydrate(snapshot: SessionViewModel | null): void;
  /** Shallow-merge a transport delta into the neutral shell snapshot. */
  patch(patch: Partial<SessionViewModel>): void;
  /** Reorder a workspace's activity sections (optimistic + persisted). */
  setSectionOrder(workspaceLocalId: string, order: readonly string[]): void;
}

/** Order equality for two normalized section-id lists. */
function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/** Resolve the effective section order for a workspace (override → snapshot → default). */
export function selectSectionOrder(
  state: ActivityState,
  workspaceLocalId: string,
): string[] {
  const override = state.sectionOrderOverrides[workspaceLocalId];
  if (override) {
    return [...override];
  }
  const workspace = state.snapshot?.workspaces.find(
    (w) => w.localId === workspaceLocalId,
  );
  return resolveActivitySectionOrder(workspace?.activitySectionOrder);
}

/** Changed files for a worktree (uncommitted + committed), or undefined. */
export function selectChangedFiles(
  state: ActivityState,
  worktreeLocalId: string,
): RemoteControlChangedFiles | undefined {
  return state.snapshot?.changedFiles[worktreeLocalId];
}

/** Pull-request status for a worktree, or undefined. */
export function selectPrStatus(
  state: ActivityState,
  worktreeLocalId: string,
): RemoteControlPrStatus | undefined {
  return state.snapshot?.prStatuses[worktreeLocalId];
}

/** Filter a worktree-scoped entity list (script/hook/plan/pipeline runs) to one worktree. */
export function selectWorktreeItems<T extends { worktreeLocalId?: string }>(
  items: readonly T[] | undefined,
  worktreeLocalId: string,
): T[] {
  return (items ?? []).filter(
    (item) => item.worktreeLocalId === worktreeLocalId,
  );
}

/**
 * Create an activity store bound to a single {@link CanopyClient}. Section
 * reorders persist through `client.command('activity.setSectionOrder')`. Wrapped
 * by {@link createClientStore} for per-client memoization.
 */
export function createActivityStore(
  client: CanopyClient,
): UseBoundStore<StoreApi<ActivityState>> {
  return create<ActivityState>((set) => ({
    snapshot: null,
    sectionOrderOverrides: {},

    hydrate(snapshot): void {
      set((state) => {
        if (!snapshot) {
          return { snapshot };
        }
        // Reconcile optimistic overrides against the authoritative snapshot:
        // once a workspace's snapshot order matches its override, the server has
        // confirmed the reorder, so drop the override. Otherwise a later
        // externally-changed order would stay masked by a stale local override
        // for the store's lifetime.
        const overrides = { ...state.sectionOrderOverrides };
        let changed = false;
        for (const [wsId, override] of Object.entries(overrides)) {
          const workspace = snapshot.workspaces.find((w) => w.localId === wsId);
          const confirmed = resolveActivitySectionOrder(
            workspace?.activitySectionOrder,
          );
          if (sameOrder(confirmed, override)) {
            delete overrides[wsId];
            changed = true;
          }
        }
        return changed
          ? { snapshot, sectionOrderOverrides: overrides }
          : { snapshot };
      });
    },

    patch(patch): void {
      set((state) => ({
        snapshot: state.snapshot ? { ...state.snapshot, ...patch } : null,
      }));
    },

    setSectionOrder(workspaceLocalId, order): void {
      // Normalize so a partial/empty list can never hide sections, and both the
      // override and snapshot paths of `selectSectionOrder` stay symmetric.
      const next = resolveActivitySectionOrder(order);
      set((state) => ({
        sectionOrderOverrides: {
          ...state.sectionOrderOverrides,
          [workspaceLocalId]: next,
        },
      }));
      // Best-effort persist; the adapters are inert until the adopt tickets.
      void client
        .command('activity.setSectionOrder', {
          workspaceLocalId,
          order: next,
        })
        .catch((): void => {});
    },
  }));
}

/**
 * Selector hook for the shared activity store, bound to the ambient
 * {@link CanopyClient} from `CanopyClientProvider`.
 */
export const useActivityStore = createClientStore(createActivityStore);
