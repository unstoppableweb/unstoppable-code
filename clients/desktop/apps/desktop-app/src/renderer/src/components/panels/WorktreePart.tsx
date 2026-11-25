/**
 * WorktreePart — the worktree content region of WorktreeManager, backed by
 * the VS Code-style panel grid (Phase 3 cutover). Replaces the old fixed
 * ChatPanel + ActivityPanel + splitter stack: the default layout reproduces
 * that arrangement (chat center, terminal below, activity right) and every
 * further arrangement is a user-driven grid operation.
 *
 * The grid machinery itself lives in `PanelGridSurface` (shared with the
 * Cowork page); this component owns the worktree-specific chrome around it —
 * the top bar, the Home empty state, and the auxiliary (popped-out) window
 * hosts. WorktreePart stays mounted while MainPage is hidden, so it is the
 * single owner of aux windows (and their panel content portals) for ALL
 * worktree keys.
 *
 * Layout lifetime: layouts are keyed per worktree and are intentionally NOT
 * disposed on unmount or worktree switch — switching back restores the exact
 * arrangement. `disposeLayout` runs from WorktreeManager's archive path when
 * a worktree is deleted.
 */
import { Surface } from '@canopy/ui-shared/components';
import { lazy, Suspense, useMemo, type JSX } from 'react';
import {
  localPlatform,
  needsPageTitlebarDragRegion,
} from '@/lib/local-platform';
import type { WorktreeViewMode } from '@/lib/worktree-layout-prefs';
import type { PanelHostState } from '@/lib/panels/panel-host-context';
import { usePanelWindowsStore } from '@/stores/panelWindowsStore';
import { WorktreeTopBar } from '@/components/panels/WorktreeTopBar';
import { AuxPanelWindow } from '@/components/panels/AuxPanelWindow';
import { PanelContentRoot } from '@/components/panels/PanelContentRoot';
import { PanelGridSurface } from '@/components/panels/PanelGridSurface';
import { ForkedContainerNotice } from '@/components/shared-containers/ForkedContainerNotice';
import { WorktreeGitActionError } from '@/components/github/WorktreeGitActionError';
import { useWorktreeScriptActions } from '@/components/panels/useWorktreeScriptActions';

/** Where a forked worktree's focus request lands (CAN-4782). */
const WORKTREE_FORK_FOCUS_TARGET = {
  page: 'main',
  headerTestId: 'worktree-top-bar',
} as const;

const HomeSurface = lazy(async () => {
  const mod = await import('@/components/home/HomeSurface');
  return { default: mod.HomeSurface };
});

export interface WorktreePartProps {
  /** Selected worktree, or nulls for the no-selection empty state. */
  projectId: string | null;
  worktreeId: string | null;
  viewMode: WorktreeViewMode;
  viewModeReady: boolean;
  /** Whether the page-level worktree surface is actually on screen. */
  visible?: boolean;
  /**
   * Whether the page this part belongs to is the one showing. The part stays
   * mounted under other pages; its Home empty state mounts only while its
   * own page shows. Unlike `visible`, an overlay over the page (Settings, an
   * archive view) leaves this on, so the draft composer under it stays put.
   */
  pageShown?: boolean;
  /** Opens the workspace settings modal (threaded to the activity panel). */
  onOpenSettingsTab?: (tab: 'scripts' | 'hooks') => void;
}

export function WorktreePart({
  projectId,
  worktreeId,
  viewMode,
  viewModeReady,
  visible = true,
  pageShown = true,
  onOpenSettingsTab,
}: WorktreePartProps): JSX.Element {
  // The one script-shortcut dispatcher and pin source for the selected
  // worktree, live only while this part is on screen.
  const pinnedActions = useWorktreeScriptActions({
    projectId,
    worktreeId,
    active: visible,
  });
  const hostState = useMemo<PanelHostState>(
    () => ({ viewMode, viewModeReady, visible, onOpenSettingsTab }),
    [viewMode, viewModeReady, visible, onOpenSettingsTab],
  );

  // Auxiliary (pulled-out) window hosts — one per open aux record, across
  // ALL worktrees (WorktreePart stays mounted while MainPage is hidden, so
  // pulled-out windows survive page navigation and worktree switches). Each
  // host portals its grid into its own child window; nothing renders in the
  // main window's DOM.
  const auxWindows = usePanelWindowsStore((s) => s.auxWindows);
  const auxWindowHosts = Object.values(auxWindows).map((record) => (
    <AuxPanelWindow
      key={record.auxWindowId}
      record={record}
      hostState={hostState}
    />
  ));

  if (projectId === null || worktreeId === null) {
    // No worktree selected and no pending Home send: render the Home surface
    // (embedded) in place of the old static "select a worktree" message card,
    // so this region stays a live draft composer instead of a dead end.
    // HomeSurface owns its own background tint + gradient treatment, so this
    // shell stays plain (no bg-card/50 — that would double up with
    // HomeSurface's own tint). The null-key PanelContentRoot keeps aux-window
    // content mounted while nothing is selected.
    return (
      <section
        data-testid="worktree-part"
        data-view-mode={viewMode}
        className="relative flex min-h-55 min-w-0 flex-1 flex-col overflow-hidden"
      >
        {needsPageTitlebarDragRegion(localPlatform()) && (
          <div className="electron-drag absolute inset-x-0 top-0 h-10" />
        )}
        {/* Selecting a Cowork entry clears the worktree selection while
            another page shows. Mounting Home here then, unseen, rendered a
            whole composer on every such switch and re-rendered it as its
            data arrived. Its draft lives in the Home composer store, so it
            is the same draft when this page shows again. */}
        {pageShown && (
          <Suspense fallback={null}>
            <HomeSurface variant="embedded" />
          </Suspense>
        )}
        <PanelContentRoot worktreeKey={null} hostState={hostState} />
        {auxWindowHosts}
      </section>
    );
  }

  return (
    <Surface
      data-testid="worktree-part"
      data-view-mode={viewMode}
      as="section"
      variant="workspace-panel"
      className="relative flex min-w-0 flex-1 flex-col overflow-hidden"
    >
      {/* Persistent worktree chrome: PR/branch status + worktree-level
          controls (archived chats, launch, layout), full content-region
          width, always visible while a worktree is selected — independent of
          the grid's arrangement below. */}
      <WorktreeTopBar
        projectId={projectId}
        worktreeId={worktreeId}
        viewMode={viewMode}
        viewModeReady={viewModeReady}
        pinnedActions={pinnedActions}
      />
      {/* A failed git or PR action sits under the bar, never inside its
          46px frame. */}
      <WorktreeGitActionError projectId={projectId} worktreeId={worktreeId} />
      <ForkedContainerNotice
        projectId={projectId}
        worktreeId={worktreeId}
        focusTarget={WORKTREE_FORK_FOCUS_TARGET}
      />
      <PanelGridSurface
        projectId={projectId}
        worktreeId={worktreeId}
        hostState={hostState}
      />
      {auxWindowHosts}
    </Surface>
  );
}
