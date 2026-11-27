import { useEffect } from 'react';
import { create } from 'zustand';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import type { OrganizationLayerView } from '@canopy/desktop-shared/lib/organization-capabilities';
import { isPairedComputerId } from '@canopy/protocol/authority-qualified-id';
import { isWebCoreScope } from '@/lib/chat-authority';
import { useProjectsStore } from './projectsStore';
import { connectorScopeWorkspaceId } from './chat/tab-utils';

/**
 * Renderer mirror of each chat workspace's organization layer (CAN-6237):
 * the organization's shared skills and plugins its chats inherit, read from
 * main, which owns and resolves it. Display-only: the composer and pickers
 * use it to show the set a turn loads and to keep owners on saved picks.
 */
interface OrganizationLayerState {
  /** By `projectId/worktreeId`; null when the workspace has none. */
  views: Record<string, OrganizationLayerView | null>;
  /** Reads the target's layer; settles once the newest answer is stored. */
  load: (projectId: string, worktreeId: string) => Promise<void>;
  /** Drops what any read in flight answers and reads again. */
  reload: (projectId: string, worktreeId: string) => Promise<void>;
}

const targetKey = (projectId: string, worktreeId: string): string =>
  `${projectId}/${worktreeId}`;

const inFlight = new Map<string, Promise<void>>();
/**
 * Bumped when a target's layer may have changed: a read stores its answer
 * only when no bump came while it ran, else it reads again.
 */
const generations = new Map<string, number>();
let changeSubscribed = false;

function invalidate(key: string): void {
  generations.set(key, (generations.get(key) ?? 0) + 1);
}

export const useOrganizationLayerStore = create<OrganizationLayerState>(
  (set, get) => ({
    views: {},
    load: (projectId, worktreeId): Promise<void> => {
      const api = window.api?.organizationCapabilities;
      // Partial window.api mocks in app-shell tests have no bridge.
      if (!api) return Promise.resolve();
      if (!changeSubscribed) {
        changeSubscribed = true;
        // Main serves a layer only to the account that read it, and a
        // sign-out or account switch sends no layer change: drop every view
        // at once, so no other account's items show, and read them again.
        window.addEventListener?.(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, () => {
          const keys = new Set([
            ...Object.keys(get().views),
            ...inFlight.keys(),
          ]);
          set({ views: {} });
          for (const key of keys) {
            invalidate(key);
            const slash = key.indexOf('/');
            void get().load(key.slice(0, slash), key.slice(slash + 1));
          }
        });
        // App-lifetime subscription. A change names the layer's workspace,
        // which several chat targets can share, so every known target reads
        // again; a read already running reads once more when it settles.
        api.onLayerChanged(() => {
          const keys = new Set([
            ...Object.keys(get().views),
            ...inFlight.keys(),
          ]);
          for (const key of keys) {
            invalidate(key);
            const slash = key.indexOf('/');
            void get().load(key.slice(0, slash), key.slice(slash + 1));
          }
        });
      }
      const key = targetKey(projectId, worktreeId);
      // A cloud chat's ids never reach main's local IPC; its organization
      // items come with its cloud workspace, not from this desktop.
      if (
        isWebCoreScope(projectId) ||
        isWebCoreScope(worktreeId) ||
        isPairedComputerId(projectId) ||
        isPairedComputerId(worktreeId)
      ) {
        if (get().views[key] !== null)
          set((state) => ({ views: { ...state.views, [key]: null } }));
        return Promise.resolve();
      }
      const running = inFlight.get(key);
      if (running) return running;
      const read = (async (): Promise<void> => {
        for (;;) {
          const started = generations.get(key) ?? 0;
          let view: OrganizationLayerView | null;
          try {
            view = await api.getLayer(projectId, worktreeId);
          } catch (error: unknown) {
            // Keep what was shown; the next change or open reads again.
            reportClientAppError(error);
            return;
          }
          if ((generations.get(key) ?? 0) !== started) continue;
          set((state) => ({ views: { ...state.views, [key]: view } }));
          return;
        }
      })().finally(() => inFlight.delete(key));
      inFlight.set(key, read);
      return read;
    },
    reload: (projectId, worktreeId): Promise<void> => {
      invalidate(targetKey(projectId, worktreeId));
      return get().load(projectId, worktreeId);
    },
  }),
);

/**
 * The organization layer of a chat's workspace, read on first use and again
 * when the workspace's owner changes (a move between an organization and
 * Personal sends no layer change); undefined while unread or for no target,
 * null when the workspace has none.
 */
export function useOrganizationLayer(
  projectId: string | null | undefined,
  worktreeId: string | null | undefined,
): OrganizationLayerView | null | undefined {
  const key =
    projectId && worktreeId ? targetKey(projectId, worktreeId) : undefined;
  const view = useOrganizationLayerStore((state) =>
    key === undefined ? undefined : state.views[key],
  );
  const ownerWorkspaceId =
    projectId && worktreeId
      ? connectorScopeWorkspaceId(projectId, worktreeId)
      : undefined;
  const ownerKey = useProjectsStore((state) => {
    if (ownerWorkspaceId === undefined) return '';
    const owner = state.projects.find(
      (project) => project.id === ownerWorkspaceId,
    )?.owner;
    return owner ? JSON.stringify(owner) : '';
  });
  const reload = useOrganizationLayerStore((state) => state.reload);
  useEffect(() => {
    if (projectId && worktreeId) void reload(projectId, worktreeId);
  }, [reload, projectId, worktreeId, ownerKey]);
  return view;
}
