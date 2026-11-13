import { create } from 'zustand';
import {
  createDefaultSidebarNavLayout,
  reconcileSidebarNavLayout,
} from '@canopy/desktop-shared/lib/sidebar-nav-layout';
import {
  DEFAULT_SIDEBAR_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from '@canopy/desktop-shared/constants/preferences';
import type {
  PreferencesData,
  SidebarNavLayout,
  SidebarSortMode,
} from '@canopy/desktop-shared/types';
import {
  DEFAULT_SIDEBAR_SORT_MODE,
  resolveSidebarSortMode,
} from '@/lib/sidebar-ordering';
import {
  shouldReserveSidebarTrafficLightRegion,
  sidebarMinWidthPx,
} from '@/components/sidebar-layout';
import { readUiZoomFactor } from '@/lib/ui-zoom-factor';
import { localPlatform } from '@/lib/local-platform';

/**
 * Width bounds live in `@canopy/desktop-shared` because the main-process
 * preference normalizer owns the effective default: a renderer-only constant
 * would be decorative, since `DEFAULT_PREFERENCES.sidebarWidth` is what a new
 * install actually receives over IPC.
 */
export {
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  // Aliased to keep this module's long-standing renderer-facing name.
  DEFAULT_SIDEBAR_WIDTH as SIDEBAR_DEFAULT_WIDTH,
};

/** Debounce interval for persisting `sidebarWidth` while dragging. */
const WIDTH_SAVE_DEBOUNCE_MS = 300;

/**
 * Match the rendered floor: history, Resources and Activity must all fit
 * beside the physical traffic-light reserve at the current interface scale.
 */
function currentMinWidth(): number {
  const platform: NodeJS.Platform = localPlatform();
  return sidebarMinWidthPx(
    shouldReserveSidebarTrafficLightRegion(platform),
    readUiZoomFactor(),
  );
}

function clampWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(currentMinWidth(), width));
}

// Module-scoped debounce timer for width persistence. Only one sidebar
// exists per renderer, so a single module-level timer is sufficient.
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function persistPreferences(partial: Partial<PreferencesData>): void {
  void window.api.savePreferences(partial).catch(() => {});
}

function scheduleWidthSave(width: number): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
  }
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persistPreferences({ sidebarWidth: width });
  }, WIDTH_SAVE_DEBOUNCE_MS);
}

interface SidebarStore {
  /** True when the unified sidebar is fully hidden. */
  hidden: boolean;
  /**
   * The user's last explicitly-persisted hidden intent (via `setHidden` /
   * `toggleHidden` / hydration). Transient visibility changes never touch
   * this value, so the user's preference can be restored when needed.
   */
  persistedHidden: boolean;
  /**
   * True while the hidden sidebar is temporarily revealed as an overlay
   * (hover/focus preview from the titlebar toggle). Only ever true while
   * `hidden` is true; never persisted.
   */
  previewing: boolean;
  /**
   * True while the preview panel is rendered on screen, which outlasts
   * `previewing` by the length of the slide-OUT. The titlebar corner reads it
   * to stay stacked above the floating panel for the whole time it is visible.
   */
  previewPresented: boolean;
  /**
   * True only while the preview panel is fully slid in. `previewPresented`
   * outlasts it by the slide-out, so anything that means "a visible preview is
   * being handed over" (the pin handover) must key on THIS, or it fires during
   * the tail when nothing is on screen.
   */
  previewSlidIn: boolean;
  /** Sidebar width in px, clamped to [SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH]. */
  width: number;
  /** True once `hydrateFromPreferences` has applied persisted preferences. */
  hydrated: boolean;
  /**
   * True when the unified workspace-list section (git workspaces + blended
   * Cowork workspace rows) is collapsed.
   */
  codeSectionCollapsed: boolean;
  /**
   * True when the top-level Chats section (the default cowork workspace's
   * project-less Work Entries) is collapsed. Persisted as
   * `sidebarCoworkSectionCollapsed`.
   */
  chatsSectionCollapsed: boolean;
  /**
   * Whether the Orchestrator's chat list under its row is collapsed.
   * Persisted as `sidebarOrchestratorCollapsed`.
   */
  orchestratorCollapsed: boolean;
  /** Ordered nav layout + main-nav/More split. */
  sidebarNavLayout: SidebarNavLayout;
  /**
   * Ordering mode for the top-level Projects section (CAN-1074). Persisted as
   * `sidebarProjectSortMode`; `'manual'` (drag-and-drop) is the default and
   * `'last-updated'` orders unpinned rows most-recent-first.
   */
  projectSortMode: SidebarSortMode;
  /** Applies persisted preference values on startup. Does not persist. */
  hydrateFromPreferences: (prefs: PreferencesData) => void;
  /**
   * Applies a live preference broadcast (from Settings changes) to the
   * persisted-mirror fields without clobbering a transient `hidden` override.
   * Unlike `hydrateFromPreferences`, when `hidden` diverges from
   * `persistedHidden`, this preserves the current `hidden` and only updates
   * `persistedHidden`. Does not persist.
   */
  syncFromPreferences: (prefs: PreferencesData) => void;
  /** Sets hidden state and fire-and-forget persists it. */
  setHidden: (hidden: boolean) => void;
  /**
   * Opens/closes the temporary hover/focus preview of the hidden sidebar.
   * A no-op when the sidebar is not hidden; does not persist anything.
   */
  setPreviewing: (previewing: boolean) => void;
  /** Marks whether the sliding preview panel is currently rendered. */
  setPreviewPresented: (presented: boolean) => void;
  /** Marks whether the preview panel is fully slid in. */
  setPreviewSlidIn: (slidIn: boolean) => void;
  /** Toggles hidden state and fire-and-forget persists the result. */
  toggleHidden: () => void;
  /**
   * Sets `hidden` only for transient overrides. Does not persist and does not
   * touch `persistedHidden`.
   */
  setHiddenTransient: (hidden: boolean) => void;
  /**
   * Restores `hidden` to the last persisted intent (`persistedHidden`).
   * Does not persist. Used when leaving a page that transiently overrode
   * the sidebar's visibility.
   */
  restorePersistedHidden: () => void;
  /** Sets clamped width and debounced-persists it. */
  setWidth: (width: number) => void;
  /** Sets the Code Workspaces collapsed flag and fire-and-forget persists it. */
  setCodeSectionCollapsed: (collapsed: boolean) => void;
  /** Sets the Chats section collapsed flag and fire-and-forget persists it. */
  setChatsSectionCollapsed: (collapsed: boolean) => void;
  /** Sets the Orchestrator chat list's collapsed flag and persists it. */
  setOrchestratorCollapsed: (collapsed: boolean) => void;
  /** Sets the nav layout and fire-and-forget persists it. */
  setSidebarNavLayout: (layout: SidebarNavLayout) => void;
  /** Persist the top-level Projects section's ordering mode. */
  setProjectSortMode: (mode: SidebarSortMode) => Promise<void>;
  /**
   * Number of mounted `PageTitlebar` hosts (via `CollapsedTitlebarToggle`).
   * When zero, the active page has NOT adopted the `PageTitlebar` layout
   * helper, so `App.tsx` renders a fallback collapsed toggle bar so the user
   * can always re-expand the sidebar. Pages that adopt the helper render the
   * toggle inline in their own top bar instead (no fallback).
   */
  titlebarHostCount: number;
  /** Registers a mounted `PageTitlebar` host. */
  registerTitlebarHost: () => void;
  /** Unregisters an unmounted `PageTitlebar` host. */
  unregisterTitlebarHost: () => void;
}

export const useSidebarStore = create<SidebarStore>((set, get) => ({
  hidden: false,
  persistedHidden: false,
  previewing: false,
  previewPresented: false,
  previewSlidIn: false,
  width: DEFAULT_SIDEBAR_WIDTH,
  hydrated: false,
  codeSectionCollapsed: false,
  chatsSectionCollapsed: false,
  orchestratorCollapsed: false,
  sidebarNavLayout: createDefaultSidebarNavLayout(),
  projectSortMode: DEFAULT_SIDEBAR_SORT_MODE,
  titlebarHostCount: 0,

  hydrateFromPreferences: (prefs): void => {
    set({
      hidden: prefs.sidebarCollapsed,
      persistedHidden: prefs.sidebarCollapsed,
      previewing: false,
      width: clampWidth(prefs.sidebarWidth),
      codeSectionCollapsed: prefs.sidebarCodeSectionCollapsed,
      chatsSectionCollapsed: prefs.sidebarCoworkSectionCollapsed,
      orchestratorCollapsed: prefs.sidebarOrchestratorCollapsed,
      sidebarNavLayout: reconcileSidebarNavLayout(prefs.sidebarNavLayout),
      projectSortMode: resolveSidebarSortMode(prefs.sidebarProjectSortMode),
      hydrated: true,
    });
  },

  syncFromPreferences: (prefs): void => {
    // A transient override sets `hidden` without touching `persistedHidden`,
    // so the two diverge. In that state, keep the transient `hidden` and only
    // refresh the persisted mirror; otherwise `hidden` follows the broadcast.
    const { hidden, persistedHidden, previewing } = get();
    const transientOverrideActive = hidden !== persistedHidden;
    const nextHidden = transientOverrideActive
      ? hidden
      : prefs.sidebarCollapsed;
    set({
      hidden: nextHidden,
      persistedHidden: prefs.sidebarCollapsed,
      previewing: nextHidden ? previewing : false,
      width: clampWidth(prefs.sidebarWidth),
      codeSectionCollapsed: prefs.sidebarCodeSectionCollapsed,
      chatsSectionCollapsed: prefs.sidebarCoworkSectionCollapsed,
      orchestratorCollapsed: prefs.sidebarOrchestratorCollapsed,
      sidebarNavLayout: reconcileSidebarNavLayout(prefs.sidebarNavLayout),
      projectSortMode: resolveSidebarSortMode(prefs.sidebarProjectSortMode),
    });
  },

  setHidden: (hidden): void => {
    set({ hidden, persistedHidden: hidden, previewing: false });
    persistPreferences({ sidebarCollapsed: hidden });
  },

  toggleHidden: (): void => {
    get().setHidden(!get().hidden);
  },

  setPreviewing: (previewing): void => {
    if (previewing && !get().hidden) return;
    set({ previewing });
  },

  setPreviewPresented: (presented): void => {
    set({
      previewPresented: presented,
      ...(presented ? {} : { previewSlidIn: false }),
    });
  },

  setPreviewSlidIn: (slidIn): void => {
    set({ previewSlidIn: slidIn });
  },

  setHiddenTransient: (hidden): void => {
    set({ hidden, previewing: hidden ? get().previewing : false });
  },

  restorePersistedHidden: (): void => {
    const hidden = get().persistedHidden;
    set({ hidden, previewing: hidden ? get().previewing : false });
  },

  setWidth: (width): void => {
    const clamped = clampWidth(width);
    set({ width: clamped });
    scheduleWidthSave(clamped);
  },

  setCodeSectionCollapsed: (collapsed): void => {
    set({ codeSectionCollapsed: collapsed });
    persistPreferences({ sidebarCodeSectionCollapsed: collapsed });
  },

  setChatsSectionCollapsed: (collapsed): void => {
    set({ chatsSectionCollapsed: collapsed });
    persistPreferences({ sidebarCoworkSectionCollapsed: collapsed });
  },
  setOrchestratorCollapsed: (collapsed): void => {
    set({ orchestratorCollapsed: collapsed });
    persistPreferences({ sidebarOrchestratorCollapsed: collapsed });
  },

  setSidebarNavLayout: (layout): void => {
    set({ sidebarNavLayout: layout });
    persistPreferences({ sidebarNavLayout: layout });
  },

  setProjectSortMode: async (mode): Promise<void> => {
    const previous = get().projectSortMode;
    if (previous === mode) return;
    set({ projectSortMode: mode });
    try {
      await window.api.savePreferences({ sidebarProjectSortMode: mode });
    } catch (error) {
      // Do not undo a newer choice if an older overlapping write rejects.
      if (get().projectSortMode === mode) {
        set({ projectSortMode: previous });
      }
      throw error;
    }
  },

  registerTitlebarHost: (): void => {
    set({ titlebarHostCount: get().titlebarHostCount + 1 });
  },

  unregisterTitlebarHost: (): void => {
    set({ titlebarHostCount: Math.max(0, get().titlebarHostCount - 1) });
  },
}));
