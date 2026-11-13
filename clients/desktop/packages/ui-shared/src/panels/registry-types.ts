/**
 * Shared panel-contract vocabulary for the VS Code-style panel system.
 *
 * This module is the seam between three layers:
 *
 * 1. **App registries** (e.g. the desktop renderer's panel registry) produce
 *    {@link PanelDefinition} entries describing how each panel kind behaves
 *    and renders.
 * 2. **Layout controllers/stores** (e.g. the desktop panel layout store)
 *    derive {@link PanelLayoutViewModel} view-models from live grid state and
 *    implement {@link PanelIntentCallbacks}.
 * 3. **Display components** (`@canopy/ui-shared/components/panels`) consume
 *    the view-models and definitions, and invoke the intent callbacks in
 *    response to user gestures. They never mutate the grid directly.
 *
 * Boundary + purity notes:
 * - This file stays React-free like the rest of the panels engine subtree.
 *   {@link PanelDefinition} is generic over its content type (`TContent`);
 *   React-based consumers instantiate `PanelDefinition<ReactNode>` in the
 *   component layer.
 * - `@canopy/protocol` imports here are **type-only** (erased at compile
 *   time), so the engine subtree's "no runtime dependencies" invariant holds.
 *   `PanelSplitDirection` / `PanelDropEdge` are reused from the protocol wire
 *   contract so intent directions stay in lockstep with the persisted schema
 *   and desktop IPC.
 * - `kind` is deliberately an **open `string`** at this layer (matching the
 *   protocol test projection's open-string posture): the display layer is
 *   registry-driven and structural. Apps bind it to the closed
 *   `PanelKind` union from `@canopy/protocol` at their own boundary.
 */

import type {
  PanelCollapseEdge,
  PanelDropEdge,
  PanelSplitDirection,
} from '@canopy/protocol';
import type { PanelCollapseAffordance } from './collapse-eligibility';
import { Direction } from './grid';

export type {
  PanelCollapseEdge,
  PanelCollapseAffordance,
  PanelDropEdge,
  PanelSplitDirection,
};

/**
 * A ROOT-level drop edge: the outer edges of the whole grid (VS Code's
 * window-edge drops). Same vocabulary as {@link PanelDropEdge} minus
 * `center` — there is no root-level merge target.
 */
export type PanelRootDropEdge = Exclude<PanelDropEdge, 'center'>;

/**
 * Props passed to every panel content render.
 *
 * Produced by the grid-host display component for each mounted panel;
 * consumed by {@link PanelDefinition.render} implementations in app
 * registries.
 */
export interface PanelContentProps {
  /** Stable identity of this panel instance (tab), unique across the grid. */
  readonly panelId: string;
  /** The panel's registered kind (registry lookup key). */
  readonly kind: string;
  /**
   * Optional per-instance entity binding for kinds that render ONE concrete
   * entity (chat → `{ chatTabId }`, file-diff → `{ fileTabId, filePath }`,
   * activity-card → `{ sectionId }`). Singleton kinds receive no instance.
   * Mirrors the persisted `ISerializedPanelEntry.instance` contract in
   * `@canopy/protocol`.
   */
  readonly instance?: Readonly<Record<string, string>>;
  /**
   * Whether this panel is the active tab of the active group. At most one
   * panel in the whole layout is active.
   */
  readonly isActive: boolean;
  /**
   * Whether this panel is currently shown: it is the selected tab of its
   * group AND the group itself is visible (not hidden by a maximized
   * sibling). Inactive-but-visible panels exist (active tab of a non-focused
   * group); active-but-invisible do not.
   */
  readonly isVisible: boolean;
}

/**
 * Registry entry describing one panel kind's behavior and rendering.
 *
 * Produced by app registries (desktop renderer instantiates
 * `PanelDefinition<ReactNode>`); consumed by display components, which call
 * {@link render} through a portal into a stable per-panel container so
 * content never remounts across relayouts (same pattern as the SplitView
 * component).
 *
 * @typeParam TContent - The framework-level content/icon representation.
 *   React consumers use `ReactNode`; this module never names React types.
 */
export interface PanelDefinition<TContent> {
  /** The kind this definition registers (registry lookup key). */
  readonly kind: string;
  /** Default human-readable title for tabs of this kind. */
  readonly title: string;
  /** Optional tab icon, in the consumer's content representation. */
  readonly icon?: TContent;
  /**
   * Whether panels of this kind may be pulled out into an auxiliary window.
   */
  readonly canPopOut: boolean;
  /**
   * Whether panels of this kind are bound to the OS window they were created
   * in (e.g. content backed by window-scoped runtime state) and therefore
   * must not travel across windows.
   */
  readonly isWindowBound: boolean;
  /** Renders the panel's content for the given instance props. */
  render(props: PanelContentProps): TContent;
}

/**
 * One tab inside a panel group.
 *
 * Produced by the layout controller/store from live grid + registry state
 * (NOT from the persisted schema); consumed by tab-bar display components.
 */
export interface PanelTabModel {
  /** Stable identity of the panel instance. */
  readonly panelId: string;
  /** The panel's registered kind. */
  readonly kind: string;
  /** Resolved display title (instance title or the definition default). */
  readonly title: string;
  /**
   * Optional per-instance entity binding (see
   * {@link PanelContentProps.instance}); exposed on the view-model so tab
   * display layers can resolve live per-entity state (titles, status).
   */
  readonly instance?: Readonly<Record<string, string>>;
  /**
   * Whether this tab is pinned. Pinned tabs render in their own scroll area
   * (left-anchored, bounded) ahead of the unpinned tabs, and sort before
   * unpinned tabs within the group. Absent means unpinned.
   */
  readonly pinned?: boolean;
}

/**
 * One grid leaf: a tabbed panel group.
 *
 * Produced by the layout controller/store; consumed by group chrome display
 * components (tab bar, group toolbar).
 */
export interface PanelGroupModel {
  /** Stable group id — the addressing unit for all group-scoped intents. */
  readonly groupId: string;
  /** Tabs in display order. */
  readonly tabs: readonly PanelTabModel[];
  /**
   * Tabs that belong to a chat other than the selected one. The tab strip
   * never shows them; their content stays mounted (hidden) so switching back
   * to their chat keeps its state. Absent means none.
   */
  readonly hiddenTabs?: readonly PanelTabModel[];
  /** Selected tab of this group, or `null` for an empty group. */
  readonly activePanelId: string | null;
  /**
   * Present iff this group is collapsed toward `edge` (icon-bar rendering).
   */
  readonly collapsed?: { readonly edge: PanelCollapseEdge };
  /**
   * Collapse affordance for the group chrome. Absent means `'none'` —
   * layout owners without collapse support simply omit it.
   */
  readonly collapseAffordance?: PanelCollapseAffordance;
}

/**
 * The full derived view-model of the panel layout for one window.
 *
 * Produced by the layout controller/store from live grid state; consumed by
 * the grid-host display component. This is a render projection — group
 * geometry (sizes/positions) intentionally stays in the imperative grid
 * engine and never passes through this model.
 */
export interface PanelLayoutViewModel {
  /** All groups, in stable (serialization) order. */
  readonly groups: readonly PanelGroupModel[];
  /** The focused group, or `null` when the layout is empty. */
  readonly activeGroupId: string | null;
  /** The maximized group, or `null` when no group is maximized. */
  readonly maximizedGroupId: string | null;
}

/**
 * Why a collapsed group is being expanded.
 *
 * `reveal` (the default) means the expand IS the gesture — the expand
 * control, the collapsed-bar toggle, the overflow "Full screen" item. `move`
 * means the expand is incidental to a different gesture: dropping a dragged
 * tab onto a collapsed bar expands the target group so the tab has somewhere
 * to land, but the user pointed at the drop, not at whatever the group
 * already happened to contain.
 *
 * Layout owners that attach reveal side effects (the desktop host starts an
 * unbound terminal panel that a reveal exposes) must treat `move` as passive.
 * Owners with no such side effects can ignore it entirely.
 */
export interface PanelExpandGroupOptions {
  readonly gesture?: 'reveal' | 'move';
}

/**
 * The single intent-callback contract between display components and the
 * layout controller/store.
 *
 * Implemented by the layout controller/store (which owns all grid
 * mutations); invoked by display components in response to user gestures.
 * Display components never call grid methods themselves.
 */
export interface PanelIntentCallbacks {
  /** Select (activate) a tab within its group. */
  onSelectTab(groupId: string, panelId: string): void;
  /** Close one tab; closing the last tab implies closing the group. */
  onCloseTab(groupId: string, panelId: string): void;
  /** Close a whole group and all of its tabs. */
  onCloseGroup(groupId: string): void;
  /** Split a group, creating a new group next to it. */
  onSplitGroup(groupId: string, direction: PanelSplitDirection): void;
  /** Maximize (`true`) or restore (`false`) a group. */
  onMaximizeGroup(groupId: string, maximized: boolean): void;
  /**
   * Collapse (`true`) or expand (`false`) a border group. Optional: layout
   * owners without collapse support omit it and the chrome renders no
   * collapse affordance.
   *
   * `options.gesture` tells the layout owner whether the expand was the point
   * of the gesture; see {@link PanelExpandGroupOptions}.
   */
  onCollapseGroup?(
    groupId: string,
    collapsed: boolean,
    options?: PanelExpandGroupOptions,
  ): void;
  /**
   * Expand a collapsed group and activate the clicked tab (collapsed-bar
   * icon click). Optional alongside {@link onCollapseGroup}.
   */
  onExpandGroupToTab?(groupId: string, panelId: string): void;
  /** Focus a group (make it the active group). */
  onFocusGroup(groupId: string): void;
  /**
   * Move a panel onto a target group: `center` docks it as a tab, edge
   * values split the target group and move the panel into the new group.
   * `targetIndex` is the requested final index for a cross-group center
   * dock; omitted center docks append within the tab's pinned partition.
   */
  onMovePanel(
    panelId: string,
    targetGroupId: string,
    edge: PanelDropEdge,
    targetIndex?: number,
  ): void;
  /**
   * Whether {@link onMovePanel} would accept moving `panelId` onto
   * `targetGroupId` at `edge`. Optional refinement: while a panel-tab drag
   * is armed, the group body shows no drop highlight, the tab strip no
   * insertion indicator, and a collapsed bar takes no drop for moves
   * reported `false`, so the UI never advertises a move the layout owner
   * would refuse. Omitted, every move is offered.
   */
  canDropPanel?(
    panelId: string,
    targetGroupId: string,
    edge: PanelDropEdge,
  ): boolean;
  /**
   * Move a panel to a ROOT edge of the grid: creates a new group as a
   * direct root-level sibling at that edge, spanning the grid's full
   * orthogonal extent (VS Code's window-edge drop). Optional: hosts whose
   * layout owner does not implement root-edge insertion omit it, and the
   * grid host then renders no root-edge drop zones.
   */
  onMovePanelToRootEdge?(panelId: string, edge: PanelRootDropEdge): void;
  /**
   * Whether a root-edge drop of `panelId` at `edge` would actually change
   * the layout. Optional refinement over {@link onMovePanelToRootEdge}:
   * while a panel-tab drag is armed, the grid host suppresses the drop
   * strip (and therefore its full-edge highlight) for edges reported
   * `false`, so the UI never advertises a drop the layout owner would
   * refuse as a no-op (e.g. dragging the sole tab of the rightmost
   * root-level group to the right edge). Omitted, every edge renders its
   * strip.
   */
  canDropPanelAtRootEdge?(panelId: string, edge: PanelRootDropEdge): boolean;
  /**
   * Reorder a tab within its own group. `toIndex` is the tab's final index
   * in the group's tab array (i.e. after the tab's removal from its current
   * position). Optional: layouts without tab reordering simply omit it.
   */
  onReorderTab?(groupId: string, panelId: string, toIndex: number): void;
  /** Pull a group out into an auxiliary window. Optional until Phase 9. */
  onPopOutGroup?(groupId: string): void;
}

/**
 * Maps an intent-level split direction (protocol string union) to the grid
 * engine's {@link Direction} enum. Every layout controller needs this
 * translation when servicing {@link PanelIntentCallbacks.onSplitGroup}.
 */
export function splitDirectionToGridDirection(
  direction: PanelSplitDirection,
): Direction {
  switch (direction) {
    case 'up':
      return Direction.Up;
    case 'down':
      return Direction.Down;
    case 'left':
      return Direction.Left;
    case 'right':
      return Direction.Right;
  }
}
