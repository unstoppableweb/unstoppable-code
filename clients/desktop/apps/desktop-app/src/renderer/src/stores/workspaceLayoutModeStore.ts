import { create } from 'zustand';
import type { WorkspaceLayoutMode } from '@canopy/desktop-shared/types';
import { isPairedComputerId } from '@canopy/protocol/authority-qualified-id';
import { isWebCoreScope } from '@/lib/chat-authority';
import { webCorePanelLayouts } from '@/lib/panels/panel-layout-storage';
import {
  dropWorktreeLayoutReadAhead,
  worktreeModeReadAhead,
} from '@/lib/panels/layout-read-ahead';
import {
  setPanelLayoutFixedTopology,
  usePanelLayoutStore,
} from '@/stores/panelLayoutStore';
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
  /**
   * The mode each worktree last loaded or saved here. It outlives the
   * worktree's entry, which is dropped whenever its panel grid leaves the
   * screen, so coming back to the worktree shows its grid at once.
   */
  lastKnownModes: Record<string, WorkspaceLayoutMode>;
  load(worktreeKey: string): Promise<WorkspaceLayoutMode>;
  /** Persists a mode change as the worktree's own mode. */
  save(worktreeKey: string, mode: WorkspaceLayoutMode): Promise<void>;
  dispose(worktreeKey: string): void;
}

let failNextSaveForE2e = false;

// One counter for every worktree: an entry dropped and created again never
// reuses the id of a read that is still out.
let lastRequestId = 0;

/**
 * Whether a worktree can be shown in the mode it had on its last visit while
 * the saved mode is read again. Only a worktree whose layout is still in
 * memory qualifies: its mode can only have changed through `save`, which
 * updates the remembered mode. One whose layout was dropped (deleted, reset,
 * a shared copy reopened) hydrates from disk, and must know the saved mode
 * before it does.
 */
function canShowRememberedMode(worktreeKey: string): boolean {
  return usePanelLayoutStore.getState().layouts[worktreeKey] !== undefined;
}

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
  const response =
    isWebCoreScope(scope.projectId) || isPairedComputerId(scope.projectId)
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
  // A mode read ahead before this save no longer says what is saved. Dropped
  // again once the save lands, for a read that went out while it was under
  // way.
  dropWorktreeLayoutReadAhead(worktreeKey);
  try {
    if (isWebCoreScope(projectId) || isPairedComputerId(projectId))
      webCorePanelLayouts.saveMode(request);
    else await window.api.panelLayout.saveWorktreeMode(request);
  } finally {
    dropWorktreeLayoutReadAhead(worktreeKey);
  }
  useStandaloneChatStore
    .getState()
    .markWorkEntryCustomized(projectId, worktreeId);
}

export const useWorkspaceLayoutModeStore = create<WorkspaceLayoutModeState>(
  (set, get) => ({
    entries: {},
    lastKnownModes: {},
    load: async (worktreeKey): Promise<WorkspaceLayoutMode> => {
      const existing = get().entries[worktreeKey];
      if (existing?.status === 'ready') return existing.mode;
      lastRequestId += 1;
      const requestId = lastRequestId;
      const remembered = get().lastKnownModes[worktreeKey];
      const shownFromMemory =
        remembered !== undefined && canShowRememberedMode(worktreeKey);
      if (shownFromMemory) {
        // A worktree the user comes back to: its grid shows in the mode it
        // had, without waiting on the read below. Waiting cost every switch
        // a frame with the grid taken down and a round trip to main before
        // it was built again.
        setPanelLayoutFixedTopology(worktreeKey, remembered === 'minimal');
      }
      // A first visit whose row the user pointed at or pressed: the saved
      // mode was read then, and is used while it is still current (see
      // `layout-read-ahead.ts`). The entry is ready before this returns, so
      // the grid's host never renders a wait for it.
      const readAhead = shownFromMemory
        ? undefined
        : worktreeModeReadAhead(worktreeKey);
      if (readAhead !== undefined) {
        const mode: WorkspaceLayoutMode =
          readAhead.mode === 'minimal' ? 'minimal' : 'advanced';
        setPanelLayoutFixedTopology(worktreeKey, mode === 'minimal');
        set((state) => ({
          entries: {
            ...state.entries,
            [worktreeKey]: { mode, status: 'ready', requestId },
          },
          lastKnownModes: { ...state.lastKnownModes, [worktreeKey]: mode },
        }));
        return mode;
      }
      set((state) => ({
        entries: {
          ...state.entries,
          [worktreeKey]: shownFromMemory
            ? { mode: remembered, status: 'ready', requestId }
            : { mode: 'advanced', status: 'loading', requestId },
        },
      }));
      const read = (async (): Promise<WorkspaceLayoutMode> => {
        try {
          // Each worktree opens in its own saved mode. Early access never
          // picks one for it, but the Minimal layout repair reads the setting,
          // so it has to be known before the layout loads.
          await whenExperimentalFeaturesHydrated();
          const mode = await loadOwnWorktreeLayoutMode(worktreeKey);
          const current = get().entries[worktreeKey];
          if (current?.requestId === requestId) {
            setPanelLayoutFixedTopology(worktreeKey, mode === 'minimal');
            // A remembered mode the read confirms changes nothing: writing
            // it again would only wake every subscriber of this store.
            if (current.status !== 'ready' || current.mode !== mode) {
              set((state) => ({
                entries: {
                  ...state.entries,
                  [worktreeKey]: { mode, status: 'ready', requestId },
                },
                lastKnownModes: {
                  ...state.lastKnownModes,
                  [worktreeKey]: mode,
                },
              }));
            }
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
      })();
      if (shownFromMemory) {
        // Callers get the shown mode at once, as they do for a loaded entry.
        // The read still runs: a saved mode that differs replaces it.
        void read;
        return remembered;
      }
      return read;
    },
    save: async (worktreeKey, mode): Promise<void> => {
      const existing = get().entries[worktreeKey];
      lastRequestId += 1;
      const requestId = lastRequestId;
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
        lastKnownModes: { ...state.lastKnownModes, [worktreeKey]: mode },
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

/**
 * The mode a worktree's panel grid renders in, or `null` while its first
 * read is out. A worktree shown before, whose layout is still in memory,
 * answers with the mode it had from its first render, before `load` runs.
 *
 * One selector on purpose: `load` then fills the entry with that same mode,
 * the answer does not change, and the grid it gates is not rendered twice.
 */
export function useShownWorkspaceLayoutMode(
  worktreeKey: string,
): WorkspaceLayoutMode | null {
  const layoutInMemory = usePanelLayoutStore(
    (state) => state.layouts[worktreeKey] !== undefined,
  );
  return useWorkspaceLayoutModeStore((state): WorkspaceLayoutMode | null => {
    const entry = state.entries[worktreeKey];
    if (entry?.status === 'ready' || entry?.status === 'error') {
      return entry.mode;
    }
    return layoutInMemory ? (state.lastKnownModes[worktreeKey] ?? null) : null;
  });
}

export function getWorkspaceLayoutMode(
  worktreeKey: string,
): WorkspaceLayoutMode {
  return (
    useWorkspaceLayoutModeStore.getState().entries[worktreeKey]?.mode ??
    'advanced'
  );
}
