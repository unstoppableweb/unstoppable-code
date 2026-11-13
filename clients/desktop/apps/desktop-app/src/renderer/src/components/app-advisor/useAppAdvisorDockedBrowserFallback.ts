/**
 * Docked in the main window, the Orchestrator's grid lands browser panels,
 * but their native views live in its separate window. So a browser the
 * person asks to see moves the Orchestrator there: an agent's request for
 * attention, the person selecting an existing browser tab or revealing one
 * (restoring a maximized group, expanding a collapsed one), and a browser
 * tab the entry's layout restores as shown when the docked page opens. An
 * agent's background open (`focus: false`) stays a tab for later
 * (CAN-1993).
 */
import { useEffect } from 'react';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import { subscribeBrowserPanelActivation } from '@/lib/browserPanelActivation';
import { subscribeBoundBrowserPanelSelection } from '@/lib/panels/browser-panel-activation';
import { useAppAdvisorStore } from '@/stores/appAdvisorStore';
import {
  makeWorktreePanelKey,
  usePanelLayoutStore,
  type WorktreePanelLayout,
} from '@/stores/panelLayoutStore';

function showInSeparateWindow(): void {
  const advisor = useAppAdvisorStore.getState();
  if (advisor.open) advisor.openSeparateWindow();
}

/** Whether the layout shows this group: not collapsed, not behind a maximized one. */
function groupShows(layout: WorktreePanelLayout, groupId: string): boolean {
  const group = layout.groups[groupId];
  return (
    group !== undefined &&
    group.collapsed === undefined &&
    (layout.maximizedGroupId === null || layout.maximizedGroupId === groupId)
  );
}

function groupShowsBrowser(
  layout: WorktreePanelLayout,
  groupId: string,
): boolean {
  const group = layout.groups[groupId];
  return (
    group !== undefined &&
    groupShows(layout, groupId) &&
    group.tabs.find((tab) => tab.panelId === group.activePanelId)?.kind ===
      'browser'
  );
}

/** Whether a group the layout shows has a Browser panel as its active tab. */
function layoutShowsBrowserPanel(layout: WorktreePanelLayout): boolean {
  return Object.keys(layout.groups).some((groupId) =>
    groupShowsBrowser(layout, groupId),
  );
}

/**
 * Whether the person revealed a browser tab that was already there: a
 * group restored from behind a maximized one or expanded from collapsed,
 * its active tab a browser. A new group or tab (an agent's open) is not a
 * reveal.
 */
function revealsBrowserPanel(
  previous: WorktreePanelLayout,
  next: WorktreePanelLayout,
): boolean {
  return Object.keys(next.groups).some(
    (groupId) =>
      previous.groups[groupId] !== undefined &&
      previous.groups[groupId].activePanelId ===
        next.groups[groupId]?.activePanelId &&
      !groupShows(previous, groupId) &&
      groupShowsBrowser(next, groupId),
  );
}

export function useAppAdvisorDockedBrowserFallback(
  docked: boolean,
  activeWorkEntryId: string | null,
): void {
  useEffect(() => {
    if (!docked) return undefined;
    const unsubscribeActivation = subscribeBrowserPanelActivation(
      (target): void => {
        if (target.projectId !== APP_ADVISOR_PROJECT_ID) return;
        if (target.focus !== false) showInSeparateWindow();
      },
    );
    const unsubscribeSelection = subscribeBoundBrowserPanelSelection(
      (selection): void => {
        if (selection.projectId === APP_ADVISOR_PROJECT_ID) {
          showInSeparateWindow();
        }
      },
    );
    return (): void => {
      unsubscribeActivation();
      unsubscribeSelection();
    };
  }, [docked]);

  // The entry's layout as the docked page first shows it, once it loads,
  // and later a browser tab the person reveals by restoring a maximized
  // group or expanding a collapsed one. Other changes are selections or
  // agent opens, handled above.
  useEffect(() => {
    if (!docked || activeWorkEntryId === null) return undefined;
    const key = makeWorktreePanelKey(APP_ADVISOR_PROJECT_ID, activeWorkEntryId);
    let previous: WorktreePanelLayout | undefined;
    const check = (
      layouts: Readonly<Record<string, WorktreePanelLayout>>,
    ): void => {
      const layout = layouts[key];
      if (layout === undefined || layout === previous) return;
      const shown =
        previous === undefined
          ? layoutShowsBrowserPanel(layout)
          : revealsBrowserPanel(previous, layout);
      previous = layout;
      if (shown) showInSeparateWindow();
    };
    const unsubscribe = usePanelLayoutStore.subscribe((state): void => {
      check(state.layouts);
    });
    check(usePanelLayoutStore.getState().layouts);
    return unsubscribe;
  }, [docked, activeWorkEntryId]);
}
