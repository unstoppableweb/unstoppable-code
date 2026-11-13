import { create } from 'zustand';
import type { WorkspaceLayoutMode } from '@canopy/desktop-shared/types';
import { isWebCoreScope } from '@/lib/chat-authority';
import { webCorePanelLayouts } from '@/lib/panels/panel-layout-storage';
import { setPanelLayoutFixedTopology } from '@/stores/panelLayoutStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { whenExperimentalFeaturesHydrated } from '@/stores/experimentalFeaturesStore';

export type WorkspaceLayoutModeStatus =
  | 'unloaded'
  | 'loading'
  | 'ready'
  | 'error';
export interface WorkspaceLayoutModeEntry {
  mode: WorkspaceLayoutMode;
  status: WorkspaceLayoutModeStatus;
  error?: string;
  requestId: number;
}
interface WorkspaceLayoutModeState {
  entries: Record<string, WorkspaceLayoutModeEntry>;
  load(worktreeKey: string): Promise<WorkspaceLayoutMode>;
  /** Persists a mode change as the worktree's own mode. */
  save(worktreeKey: string, mode: WorkspaceLayoutMode): Promise<void>;
  dispose(worktreeKey: string): void;
}

let failNextSaveForE2e = false;

export function failNextWorkspaceLayoutModeSaveForE2e(): void {
  if (__CANOPY_E2E__) failNextSaveForE2e = true;
}

function splitKey(worktreeKey: string): {
  projectId: string;
  worktreeId: string;
} {
  const separator = worktreeKey.indexOf('/');
  return {
    projectId: worktreeKey.slice(0, separator),
    worktreeId: worktreeKey.slice(separator + 1),
  };
}

/** Reads the worktree's own saved mode; a missing file means Advanced. */
export async function loadOwnWorktreeLayoutMode(
  worktreeKey: string,
): Promise<WorkspaceLayoutMode> {
  const scope = splitKey(worktreeKey);
  const response = isWebCoreScope(scope.projectId)
    ? webCorePanelLayouts.loadMode(scope)
    : await window.api.panelLayout.loadWorktreeMode(scope);
  return response.mode === 'minimal' ? 'minimal' : 'advanced';
}

async function saveOwnWorktreeLayoutMode(
  worktreeKey: string,
  mode: WorkspaceLayoutMode,
): Promise<void> {
  const { projectId, worktreeId } = splitKey(worktreeKey);
  const request = { projectId, worktreeId, mode };
  if (isWebCoreScope(projectId)) webCorePanelLayouts.saveMode(request);
  else await window.api.panelLayout.saveWorktreeMode(request);
  useStandaloneChatStore
    .getState()
    .markWorkEntryCustomized(projectId, worktreeId);
}

export const useWorkspaceLayoutModeStore = create<WorkspaceLayoutModeState>(
  (set, get) => ({
    entries: {},
    load: async (worktreeKey): Promise<WorkspaceLayoutMode> => {
      const existing = get().entries[worktreeKey];
      if (existing?.status === 'ready') return existing.mode;
      const requestId = (existing?.requestId ?? 0) + 1;
      set((state) => ({
        entries: {
          ...state.entries,
          [worktreeKey]: { mode: 'advanced', status: 'loading', requestId },
        },
      }));
      try {
        // Each worktree opens in its own saved mode. Early access never
        // picks one for it, but the Minimal layout repair reads the setting,
        // so it has to be known before the layout loads.
        await whenExperimentalFeaturesHydrated();
        const mode = await loadOwnWorktreeLayoutMode(worktreeKey);
        if (get().entries[worktreeKey]?.requestId === requestId) {
          setPanelLayoutFixedTopology(worktreeKey, mode === 'minimal');
          set((state) => ({
            entries: {
              ...state.entries,
              [worktreeKey]: { mode, status: 'ready', requestId },
            },
          }));
        }
        return mode;
      } catch (error) {
        if (get().entries[worktreeKey]?.requestId === requestId) {
          setPanelLayoutFixedTopology(worktreeKey, false);
          set((state) => ({
            entries: {
              ...state.entries,
              [worktreeKey]: {
                mode: 'advanced',
                status: 'error',
                requestId,
                error: error instanceof Error ? error.message : String(error),
              },
            },
          }));
        }
        return 'advanced';
      }
    },
    save: async (worktreeKey, mode): Promise<void> => {
      const existing = get().entries[worktreeKey];
      const requestId = (existing?.requestId ?? 0) + 1;
      set((state) => ({
        entries: {
          ...state.entries,
          [worktreeKey]: {
            mode: existing?.mode ?? 'advanced',
            status: existing?.status ?? 'loading',
            requestId,
          },
        },
      }));
      if (__CANOPY_E2E__ && failNextSaveForE2e) {
        failNextSaveForE2e = false;
        throw new Error('E2E forced project layout mode save failure');
      }
      await saveOwnWorktreeLayoutMode(worktreeKey, mode);
      if (get().entries[worktreeKey]?.requestId !== requestId) return;
      setPanelLayoutFixedTopology(worktreeKey, mode === 'minimal');
      set((state) => ({
        entries: {
          ...state.entries,
          [worktreeKey]: { mode, status: 'ready', requestId },
        },
      }));
    },
    dispose: (worktreeKey): void => {
      setPanelLayoutFixedTopology(worktreeKey, false);
      set((state) => {
        const entries = { ...state.entries };
        delete entries[worktreeKey];
        return { entries };
      });
    },
  }),
);

export function getWorkspaceLayoutMode(
  worktreeKey: string,
): WorkspaceLayoutMode {
  return (
    useWorkspaceLayoutModeStore.getState().entries[worktreeKey]?.mode ??
    'advanced'
  );
}
