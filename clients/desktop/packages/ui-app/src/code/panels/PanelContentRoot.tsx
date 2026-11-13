'use client';

/**
 * PanelContentRoot — the single owner of panel CONTENT React subtrees (the
 * no-remount portal-target handoff that closes doc 10 A5/A6).
 *
 * Before this component, each grid host rendered `renderPanelContent` inline
 * per tab, so moving a panel to a different host (another group after an
 * edge split, an auxiliary window after pull-out, back again after
 * merge-back) built a fresh React subtree — remounting Slate editors, xterm
 * terminals, and every other stateful surface. Now content identity is
 * anchored here, mirroring VS Code's "the editor owns its DOM; groups adopt
 * it" model:
 *
 * - **Stable containers.** A module-level map holds one container element per
 *   panel, keyed by `${ownerWorktreeKey}::${panelId}` (panel ids are unique
 *   within a worktree's main + aux layouts, but the default layout reuses
 *   stable panel ids across worktrees, so the owner key disambiguates).
 *   Containers are created lazily in the OPENER realm (`document
 *   .createElement`, the doc 13 cross-realm rule) so adoption into an aux
 *   window's child document preserves prototypes and React events.
 * - **Content renders here, once.** For every tab of the selected worktree's
 *   main layout AND every open aux window's layout (aux windows survive
 *   worktree switches, matching the desktop `WorktreePart`'s aux hosts),
 *   this component portals the host-injected `renderPanelContent(...)` into
 *   the panel's container. The grid hosts adopt the containers via
 *   `getPanelContentElement` (see `PanelGroup`'s adoption mode) and never
 *   render content themselves.
 * - **Moves never destroy.** A container is removed from the map (and its
 *   portal unmounted) only when its panel id no longer exists in ANY layout
 *   of its owning worktree — i.e. the tab was closed or the layout disposed.
 *   Moving a panel within a grid, across layouts (pull-out/merge-back), or
 *   across OS windows re-parents the same DOM node.
 * - **isActive/isVisible** are computed per tab from the OWNING layout's
 *   view-model with the same semantics the grid host used: active = active
 *   tab of the layout's active group; visible = active tab of a group that
 *   is not hidden by a maximized sibling. Each layout (main window, every
 *   aux window) has its own active group, exactly as before.
 * - **Host state is per layout.** The main layout's content reads the
 *   injected `hostState`; an aux layout's content reads
 *   `auxPanelHostState(hostState)`, because an aux window is its own page
 *   and stays on screen while the main page navigates away.
 *
 * Host seams (shared-package posture): the content renderer is injected via
 * `renderPanelContent` (desktop passes its registry's renderer; `kind` stays
 * an open `string` at this layer, matching the registry contract, so hosts
 * keep their own unknown-kind fallback rendering), and aux-window layout
 * keys are injected via `auxLayoutKeys` (desktop derives them from its
 * panel-windows store; web passes none).
 *
 * This module deliberately exports the container-lookup helpers
 * (`acquirePanelContentElement`, the test-reset hook) alongside the
 * component — they are one API surface over the same module-level container
 * map, so fast-refresh granularity is intentionally traded away here (same
 * posture as the desktop registry.tsx).
 *
 * Zustand posture: this component subscribes to the whole `layouts` map —
 * it genuinely depends on every layout (portal set + the destroy sweep), and
 * layout commits are low-frequency topology/focus events (never per drag
 * pixel). Per-panel re-render cost is bounded by the host registry wrappers'
 * `memo` (their `{panelId, kind, isActive, isVisible}` props are primitives).
 */
import { useEffect, type JSX, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { isPanelKind } from '@canopy/protocol';
import { PANEL_CONTENT_HOST_ATTRIBUTE } from '@canopy/ui-shared/panels';
import {
  AppErrorBoundary,
  type AppErrorBoundaryHost,
} from '../../feedback/AppErrorBoundary';
import {
  getAuxPanelLayoutOwnerKey,
  usePanelLayoutStore,
  type WorktreePanelLayout,
} from './panel-layout-store';
import {
  auxPanelHostState,
  PanelHostContext,
  PanelPlacementContext,
  PanelVisibilityContext,
  PanelWorktreeContext,
  worktreeSelectionFromPanelOwnerKey,
  type PanelHostState,
} from './panel-contexts';

export interface RenderPanelContentArgs {
  readonly panelId: string;
  /**
   * Open `string` on purpose (registry-layer contract): unknown kinds flow
   * through to the host renderer, which owns the fallback UI — the shared
   * root must never silently drop a tab's content portal.
   */
  readonly kind: string;
  readonly instance?: Readonly<Record<string, string>>;
  readonly isActive: boolean;
  readonly isVisible: boolean;
}

export interface PanelContentRootProps {
  worktreeKey: string | null;
  hostState: PanelHostState;
  renderPanelContent: (args: RenderPanelContentArgs) => ReactNode;
  auxLayoutKeys?: readonly string[];
  includeAuxWindows?: boolean;
  /**
   * Kinds whose hidden content mounts only once the tab has been shown.
   * Showing a worktree otherwise mounts, styles and lays out every hidden
   * tab of it; a tab that has been shown stays mounted, so switching back
   * keeps its state. Hosts opt in per kind: content that must run while
   * hidden (a browser page, a terminal) keeps mounting up front.
   */
  deferHiddenContent?: (kind: string) => boolean;
  /** Records a panel's failure and offers its report. Containment doesn't need it. */
  errorHost?: AppErrorBoundaryHost;
}

function ownerKeyOf(layoutKey: string): string {
  return getAuxPanelLayoutOwnerKey(layoutKey) ?? layoutKey;
}

function containerKey(ownerKey: string, panelId: string): string {
  return `${ownerKey}::${panelId}`;
}

const panelContentContainers = new Map<string, HTMLElement>();
// Container keys whose content has been on screen (see `deferHiddenContent`).
const shownPanelContent = new Set<string>();

/**
 * Lazily creates containers in the opener realm (doc-13). Document access
 * intentionally stays inside this function rather than at module scope.
 */
export function acquirePanelContentElement(
  ownerWorktreeKey: string,
  panelId: string,
): HTMLElement {
  const key = containerKey(ownerWorktreeKey, panelId);
  const existing = panelContentContainers.get(key);
  if (existing) return existing;

  const element = document.createElement('div');
  element.className = 'canopy-panel-content-host';
  element.setAttribute(PANEL_CONTENT_HOST_ATTRIBUTE, panelId);
  element.style.display = 'flex';
  element.style.flexDirection = 'column';
  element.style.flex = '1 1 auto';
  element.style.width = '100%';
  element.style.minWidth = '0';
  element.style.minHeight = '0';
  element.style.overflow = 'hidden';
  panelContentContainers.set(key, element);
  return element;
}

export function resetPanelContentContainersForTests(): void {
  panelContentContainers.forEach((element) => {
    element.remove();
  });
  panelContentContainers.clear();
  shownPanelContent.clear();
}

function collectLivePanelKeys(
  layouts: Record<string, WorktreePanelLayout>,
): Set<string> {
  const live = new Set<string>();
  for (const [layoutKey, layout] of Object.entries(layouts)) {
    const ownerKey = ownerKeyOf(layoutKey);
    for (const group of Object.values(layout.groups)) {
      for (const tab of group.tabs) {
        live.add(containerKey(ownerKey, tab.panelId));
      }
    }
  }
  return live;
}

/**
 * Runs the renderer beneath the boundary, so a throw from the renderer itself
 * is contained too, not only a throw from what it returns. Not memoized: web
 * renderers close over live context.
 */
function PanelContentSlot({
  render,
  args,
}: {
  readonly render: PanelContentRootProps['renderPanelContent'];
  readonly args: RenderPanelContentArgs;
}): ReactNode {
  return render(args);
}

export function PanelContentRoot({
  worktreeKey,
  hostState,
  renderPanelContent,
  auxLayoutKeys = [],
  includeAuxWindows = true,
  deferHiddenContent,
  errorHost,
}: PanelContentRootProps): JSX.Element {
  const layouts = usePanelLayoutStore((state) => state.layouts);

  useEffect(() => {
    const live = collectLivePanelKeys(layouts);
    const stale: string[] = [];
    panelContentContainers.forEach((element, key) => {
      if (!live.has(key)) {
        element.remove();
        stale.push(key);
      }
    });
    for (const key of stale) panelContentContainers.delete(key);
    shownPanelContent.forEach((key) => {
      if (!live.has(key)) shownPanelContent.delete(key);
    });
  }, [layouts]);

  const mountedLayoutKeys: string[] = [];
  if (worktreeKey !== null && layouts[worktreeKey] !== undefined) {
    mountedLayoutKeys.push(worktreeKey);
  }
  if (includeAuxWindows) {
    for (const layoutKey of auxLayoutKeys) {
      if (layouts[layoutKey] !== undefined) mountedLayoutKeys.push(layoutKey);
    }
  }

  const portals: ReactNode[] = [];
  for (const layoutKey of mountedLayoutKeys) {
    const ownerKey = ownerKeyOf(layoutKey);
    const ownerSelection = worktreeSelectionFromPanelOwnerKey(ownerKey);
    // Host state is per layout: an auxiliary window is its own page, so its
    // content never inherits the main page's `visible`.
    const layoutHostState =
      getAuxPanelLayoutOwnerKey(layoutKey) === null
        ? hostState
        : auxPanelHostState(hostState);
    const { viewModel } = layouts[layoutKey];
    for (const group of viewModel.groups) {
      const isActiveGroup = group.groupId === viewModel.activeGroupId;
      const isGroupVisible =
        viewModel.maximizedGroupId === null ||
        group.groupId === viewModel.maximizedGroupId;
      const isGroupExpanded = group.collapsed === undefined;
      // Another chat's tabs stay mounted while hidden, so their state
      // survives a switch to another chat and back.
      for (const tab of [...group.tabs, ...(group.hiddenTabs ?? [])]) {
        const isActiveTab = tab.panelId === group.activePanelId;
        const isVisible = isActiveTab && isGroupVisible && isGroupExpanded;
        const key = containerKey(ownerKey, tab.panelId);
        if (isVisible) shownPanelContent.add(key);
        else if (
          deferHiddenContent?.(tab.kind) === true &&
          !shownPanelContent.has(key)
        )
          continue;
        portals.push(
          createPortal(
            <PanelHostContext.Provider value={layoutHostState}>
              <PanelWorktreeContext.Provider value={ownerSelection}>
                <PanelPlacementContext.Provider
                  value={{ layoutKey, groupId: group.groupId }}
                >
                  <PanelVisibilityContext.Provider value={isVisible}>
                    {/* The portal's key holds this boundary to one panel across
                        tab switches, moves and pop-outs. A panel bound to new
                        content has nothing left to do with the old failure. */}
                    <AppErrorBoundary
                      layout="fill"
                      message="Couldn't show this panel."
                      recoveryLabel="Reload panel"
                      testId="panel-error-fallback"
                      host={errorHost}
                      resetKey={
                        tab.instance !== undefined
                          ? JSON.stringify(tab.instance)
                          : undefined
                      }
                      context={{
                        panelKind: isPanelKind(tab.kind) ? tab.kind : 'unknown',
                      }}
                    >
                      <PanelContentSlot
                        render={renderPanelContent}
                        args={{
                          panelId: tab.panelId,
                          kind: tab.kind,
                          ...(tab.instance !== undefined
                            ? { instance: tab.instance }
                            : {}),
                          isActive: isActiveGroup && isActiveTab,
                          isVisible,
                        }}
                      />
                    </AppErrorBoundary>
                  </PanelVisibilityContext.Provider>
                </PanelPlacementContext.Provider>
              </PanelWorktreeContext.Provider>
            </PanelHostContext.Provider>,
            acquirePanelContentElement(ownerKey, tab.panelId),
            key,
          ),
        );
      }
    }
  }

  return <>{portals}</>;
}
