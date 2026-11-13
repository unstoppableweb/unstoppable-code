'use client';

/**
 * Shared panel-layout store — the single imperative op API for the VS
 * Code-style panel system (Phase 2), hosted in `@canopy/ui-app` so desktop
 * and web surfaces drive the same layout-state core.
 *
 * Every caller — the panel UI (`PanelGridHost` + chrome), the command
 * palette, keyboard shortcuts, App Advisor actions, and the
 * `__canopyPanelTestApi` e2e hook — dispatches panel operations through the
 * actions on this store. Nothing else mutates the grid
 * (doc 12 §1: one imperative API, four callers).
 *
 * Core model decisions:
 *
 * - **A group is the grid leaf.** Each grid leaf is one {@link PanelLeafView}
 *   whose id IS the `groupId`. A group holds ordered tabs (panels); tabs are
 *   store metadata, never grid nodes. Splitting creates a new group (new
 *   leaf); moving a panel between groups edits tab arrays (plus creates or
 *   removes leaves for edge drops); the grid only changes when groups are
 *   created, destroyed, or moved.
 * - **The store owns the Grid instance** (model-only; leaf elements are
 *   created via `createPanelLeafElement`). The display layer receives a
 *   {@link PanelGridController} and never mutates the grid.
 * - **State is keyed per worktree** by `${projectId}/${worktreeId}` (the same
 *   convention as `chatStore`'s `worktreeChats` keys —
 *   {@link makeWorktreePanelKey}).
 * - **View-models are derived eagerly.** Every mutation commits a fresh
 *   {@link PanelLayoutViewModel} snapshot (a plain serializable object) into
 *   state so components subscribe to it and never touch the Grid. `revision`
 *   increments on every topology mutation (add/remove/move/maximize/restore/
 *   rebuild); the grid's identity only changes on wholesale rebuild
 *   (restore/deserialize).
 * - **Panels are per-entity units.** A tab descriptor may carry an
 *   `instance` binding tying it to one concrete entity (chat tab, file tab,
 *   activity section); {@link getPanelInstanceKey} derives the identity key
 *   and the store enforces that no two tabs across a worktree's layout
 *   FAMILY (main layout + every `#aux:` layout) share an instance key —
 *   `addTab` and `adoptLayoutTabs` skip duplicates; `movePanel`/
 *   `movePanelToRootEdge`/`extractGroupToLayout` are exempt because they
 *   relocate the one existing instance.
 * - **Split without a seed creates an EMPTY group.** Since panels are
 *   per-entity, cloning the active tab would duplicate an entity binding;
 *   an unseeded split therefore creates an empty group (`tabs: []`,
 *   `activePanelId: null` — empty groups already render the add-tab
 *   affordance). An explicit {@link SplitGroupSeed} still seeds one fresh
 *   tab deterministically (default-layout builder).
 * - **MRU focus.** `mruGroupIds` (most recent first) is updated on
 *   focus/split/close; closing the active group focuses the most-recently-
 *   active surviving group (doc 04 pattern).
 * - **No persistence yet** (Phase 5) — `serializeLayout`/`restoreLayout` are
 *   the seams and round-trip through the `@canopy/protocol` schema now.
 */

import { create } from 'zustand';
import {
  buildCollapseSnapshotFromGrid,
  collapseEdgeAxis,
  createPanelLeafElement,
  DEFAULT_PANEL_LEAF_MINIMUM_HEIGHT,
  DEFAULT_PANEL_LEAF_MINIMUM_WIDTH,
  Direction,
  type Grid,
  getCollapseAffordance,
  getCollapseAffordances,
  getInnerCollapseSibling,
  isGridBranchNode,
  isPanelLeafViewJson,
  Orientation,
  PANEL_COLLAPSED_BAR_SIZE,
  PanelLeafView,
  planRestoredCollapses,
  SerializableGrid,
  Sizing,
  splitDirectionToGridDirection,
  type CollapseSnapshot,
  type GridNodeDescriptor,
  type GridNode,
  type ISerializedGrid,
  type ISerializedNode,
  type IViewDeserializer,
  type IViewSize,
  type PanelCollapseAffordance,
  type PanelDropEdge,
  type PanelGroupModel,
  type PanelLayoutViewModel,
  type PanelRootDropEdge,
  type PanelSplitDirection,
  type PanelTabModel,
} from '@canopy/ui-shared/panels';
import {
  clampPanelTitle,
  isAutomationsPanelVariant,
  isPipelineExecutionPanelInstance,
  isSessionBreakdownPanelInstance,
  isSubagentChatPanelInstance,
  isUsagePanelVariant,
  migratePanelLayout,
  PANEL_LAYOUT_FILE_VERSION,
  SINGLETON_PANEL_KINDS,
  type ISerializedPanelEntry,
  type ISerializedPanelLeafNode,
  type ISerializedPanelNode,
  type PanelCollapseEdge,
  type PanelCollapsedState,
  type PanelKind,
  type SerializablePanelLayoutFile,
  type SerializedPoppedPanelWindow,
} from '@canopy/protocol';

import {
  applyChatScopeToGroups,
  collectChatTabIds,
  groupHiddenTabPredicate,
  isChatScopedPanelKind,
  resolveChatScope,
  shownIndexToTabIndex,
  type PanelChatScope,
  type PanelChatScopeMemory,
} from './panel-chat-scope';

// Pre-migration raw plan sanitization lives in the protocol package so the
// main-process default-layout loader and the renderer share it.
export { sanitizeRawPlanPanelBindings } from '@canopy/protocol';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One tab (panel instance) stored as group metadata — never a grid node. */
export interface PanelTabDescriptor {
  readonly panelId: string;
  /** Closed protocol union: the desktop app binds tab kinds at this layer. */
  readonly kind: PanelKind;
  /** Optional instance title; display falls back to the registry default. */
  readonly title?: string;
  /**
   * Optional per-instance entity binding (chat → `{ chatTabId }`,
   * file-diff → `{ fileTabId, filePath }`, activity-card → `{ sectionId }`;
   * singleton kinds carry none). Persisted through
   * `ISerializedPanelEntry.instance` and enforced unique per worktree
   * layout family via {@link getPanelInstanceKey}.
   */
  readonly instance?: Readonly<Record<string, string>>;
  /**
   * Whether this tab is pinned. Persisted through
   * `ISerializedPanelEntry.pinned`. Ordering invariant: within a group,
   * pinned tabs sort before unpinned tabs, preserving relative order within
   * each partition (see {@link partitionTabsByPinned}). Every tab-order
   * mutation keeps this prefix invariant intact.
   */
  readonly pinned?: boolean;
  /**
   * The chat tab this content tab belongs to; hidden while another chat is
   * selected. Persisted through `ISerializedPanelEntry.chatScope`. See
   * `panel-chat-scope.ts`.
   */
  readonly chatScope?: string;
}

export interface AdoptLayoutTabsOptions {
  /** Prefer returning tabs to this existing group. */
  readonly preferredGroupId?: string;
  /** Recreate the preferred group beside this group when it no longer exists. */
  readonly fallbackAnchorGroupId?: string;
  /** Position of the recreated group relative to its anchor. */
  readonly fallbackDirection?: PanelSplitDirection;
  /** Original size of the recreated group on the split axis. */
  readonly fallbackSize?: number;
}

/** Per-group tab state (the leaf's store-side metadata). */
export interface PanelGroupState {
  readonly tabs: readonly PanelTabDescriptor[];
  readonly activePanelId: string | null;
  /** Present iff this group is collapsed (edge + pre-collapse size). */
  readonly collapsed?: PanelCollapsedState;
}

/**
 * Explicit seed for the group created by a split. When provided, the new
 * group receives a single fresh tab of `kind` instead of the default
 * empty-group behavior, with optionally stable group/panel ids. Used by the
 * default-layout builder to create the nested chat/terminal arrangement
 * deterministically.
 */
export interface SplitGroupSeed {
  readonly kind: PanelKind;
  /** Stable group id; generated when omitted. */
  readonly groupId?: string;
  /** Stable seed panel id; generated when omitted. */
  readonly panelId?: string;
  /** Optional instance title for the seeded tab. */
  readonly title?: string;
  /** Optional per-instance entity binding for the seeded tab. */
  readonly instance?: Readonly<Record<string, string>>;
  /**
   * The chat a seeded content tab belongs to. Omitted, it follows the source
   * group's tab for the same entity (a plan's diagram follows its plan),
   * else that group's active tab, else the selected chat.
   */
  readonly chatScope?: string;
}

/** One group seed of a {@link DefaultLayoutDescriptor}. */
export interface DefaultLayoutGroupSeed {
  /**
   * Kind of the group's single seeded tab. Omitted → the group is created
   * EMPTY (`tabs: []`, `activePanelId: null`); used by the default layout
   * when the chat store has not hydrated yet, so the sync bridge can
   * materialize instance-bound tabs into the group later.
   */
  readonly kind?: PanelKind;
  /** Stable group id; generated when omitted. */
  readonly groupId?: string;
  /** Stable seed panel id; generated when omitted. */
  readonly panelId?: string;
  /** Optional instance title for the seeded tab. */
  readonly title?: string;
  /** Optional per-instance entity binding for the seeded tab. */
  readonly instance?: Readonly<Record<string, string>>;
  /** Proportional size along the descriptor orientation. */
  readonly size?: number;
}

/**
 * Minimal declarative default layout: one row (`'horizontal'`, groups laid
 * out left→right) or one column (`'vertical'`, top→bottom) of single-tab
 * groups. Nested defaults can be produced later by splitting.
 */
export interface DefaultLayoutDescriptor {
  readonly orientation: 'horizontal' | 'vertical';
  readonly groups: readonly DefaultLayoutGroupSeed[];
  /** Initial container size; the host re-layouts with the real size. */
  readonly containerSize?: { readonly width: number; readonly height: number };
}

import type { PanelGridController } from '@canopy/ui-shared/components/panels';

export type { PanelGridController } from '@canopy/ui-shared/components/panels';

/** The full per-worktree layout record held in store state. */
export interface WorktreePanelLayout {
  /** Mutable engine instance, held by reference. Rebuilt only on restore. */
  readonly grid: SerializableGrid<PanelLeafView>;
  /** groupId → live leaf view (mutated in place across commits). */
  readonly leafViews: Map<string, PanelLeafView>;
  /** groupId → tab metadata (immutably updated). */
  readonly groups: Record<string, PanelGroupState>;
  readonly activeGroupId: string | null;
  /** Most-recently-active group ids, most recent first. */
  readonly mruGroupIds: readonly string[];
  readonly maximizedGroupId: string | null;
  readonly revision: number;
  /** Eagerly derived render projection — subscribe to this, not the grid. */
  readonly viewModel: PanelLayoutViewModel;
  readonly controller: PanelGridController;
  /**
   * The selected chat and the chats of the layout family; `null` for an
   * auxiliary layout or one without chats, where every tab shows.
   */
  readonly chatScope: PanelChatScope | null;
  /** Each group's last active tab per chat (in memory only). */
  readonly chatScopeMemory: PanelChatScopeMemory;
}

export interface PanelLayoutState {
  layouts: Record<string, WorktreePanelLayout>;
  /**
   * Monotonic signal for size-only grid mutations. These operations mutate the
   * Grid in place and intentionally do not rebuild the render view-model, but
   * persistence still needs a store-visible dirty signal.
   */
  layoutSizeRevisions: Record<string, number>;

  /** Builds the layout for a worktree. No-op when one already exists. */
  initializeLayout(
    worktreeKey: string,
    descriptor: DefaultLayoutDescriptor,
  ): void;
  /**
   * Splits a group; returns the new group's id (focused), or `null`. By
   * default the new group is EMPTY (`tabs: []`, `activePanelId: null` —
   * panels are per-entity units, so cloning the active tab would duplicate
   * an entity binding); pass `seed` to seed it with a fresh tab of an
   * explicit kind (and optionally stable ids / an instance binding) instead.
   * `activate: false` preserves focus, MRU and maximized/collapsed presentation.
   */
  splitGroup(
    worktreeKey: string,
    groupId: string,
    direction: PanelSplitDirection,
    seed?: SplitGroupSeed,
    options?: { readonly activate?: boolean },
  ): string | null;
  /**
   * Appends a fresh tab of `kind` to an existing group, activates it, and
   * focuses the group. Returns the new tab's panel id, or `null` when the
   * layout/group is unknown, a seeded `opts.panelId` already exists anywhere
   * in the worktree's layout family, the tab violates its kind's instance
   * contract, or a tab with the same instance key ({@link getPanelInstanceKey})
   * is already open anywhere in the family.
   * Pure tab-metadata mutation: no topology change, so `revision` (and the
   * controller) stay put while the view-model updates.
   */
  addTab(
    worktreeKey: string,
    groupId: string,
    kind: PanelKind,
    opts?: {
      readonly panelId?: string;
      readonly title?: string;
      readonly instance?: Readonly<Record<string, string>>;
      /** Set to `false` to add without selecting, focusing, or revealing. */
      readonly activate?: boolean;
      /**
       * The chat this content tab opens for (an agent's own chat). Omitted,
       * a chat-scoped kind belongs to the layout's selected chat; `null`
       * gives it no owner, so it shows for every chat.
       */
      readonly chatScope?: string | null;
    },
  ): string | null;
  /**
   * Updates one tab's instance title (display + persistence metadata). The
   * panel is looked up across the worktree's layout family. No-op when the
   * layout/panel is unknown or the title is unchanged.
   */
  updateTabInstanceTitle(
    worktreeKey: string,
    panelId: string,
    title: string,
  ): void;
  /**
   * Closes a group and its tabs. Returns false when the mutation is rejected.
   * Other chats' hidden tabs move to a remaining group with their owners kept.
   * Tabs the host's {@link PanelTabCloseGuard} protects stay open: the other
   * tabs close, the group remains, and the call returns false.
   */
  closeGroup(worktreeKey: string, groupId: string): boolean;
  /**
   * Selects a tab within its group and focuses that group. Pass
   * `{ focus: false }` to activate the tab WITHOUT making its group the
   * layout's active group (used by the chat ⇄ panel sync bridge's hydration
   * sweep, which must not clobber a restored active group).
   */
  selectTab(
    worktreeKey: string,
    groupId: string,
    panelId: string,
    options?: { focus?: boolean },
  ): void;
  /**
   * Reorders a tab within its group. `toIndex` is the tab's final index in
   * the group's FULL tab array (i.e. after removal from its current
   * position), clamped to the valid range. It counts tabs hidden for another
   * chat too; a tab strip, which shows only the selected chat's tabs,
   * converts its drop index with {@link panelTabIndexForShownIndex}. Pure tab-metadata mutation like `addTab`:
   * no topology change, so `revision` (and the controller) stay put while
   * the view-model updates. Also focuses the group (a drop is interaction).
   */
  reorderTab(
    worktreeKey: string,
    groupId: string,
    panelId: string,
    toIndex: number,
  ): void;
  /**
   * Replaces one tab descriptor in place without changing group topology,
   * ordering, pinning, collapse, maximize, or focus state. The replacement
   * panel id and instance key must remain unique within the layout family.
   */
  replaceTab(
    worktreeKey: string,
    groupId: string,
    panelId: string,
    replacement: PanelTabDescriptor,
  ): boolean;
  /** Closes one tab; closing a group's last tab closes the group. */
  closeTab(worktreeKey: string, groupId: string, panelId: string): void;
  /**
   * Closes a batch of tabs within one group (reusing {@link closeTab}
   * semantics: closing every tab of a group removes it, except the last
   * remaining group, which is left empty). Ids not present in the group are
   * skipped; an empty/all-skipped batch is a no-op. Removals are processed in
   * array order so `activePanelId` falls back to a surviving neighbor. Drives
   * the tab context menu's "Close Others / Right / Left / All" actions.
   */
  closeTabs(worktreeKey: string, groupId: string, panelIds: string[]): void;
  /**
   * Toggles a tab's pinned state and re-partitions the group so pinned tabs
   * stay a prefix (pinning moves the tab to the END of the pinned partition,
   * unpinning to the START of the unpinned partition). Pure tab-metadata
   * mutation: no topology change and no active-tab change, so `revision` (and
   * the controller) stay put while the view-model updates. A no-op (already in
   * the requested state, or unknown layout/group/panel) returns without
   * committing.
   */
  setTabPinned(
    worktreeKey: string,
    groupId: string,
    panelId: string,
    pinned: boolean,
  ): void;
  /**
   * Moves a panel onto a target group: `center` docks it as a tab; edge
   * values split the target group and move the panel into the new group. A
   * source group left empty is closed. `targetIndex` requests the final index
   * for a cross-group center dock and is clamped to the moved tab's pinned
   * partition; omitted docks append within that partition.
   * `activate: false` moves an inactive tab between groups with a center dock
   * while preserving selection, focus and collapsed state in one commit.
   * Moving a selected tab or creating a split with that option is refused.
   * Returns whether the layout changed.
   */
  movePanel(
    worktreeKey: string,
    panelId: string,
    targetGroupId: string,
    edge: PanelDropEdge,
    targetIndex?: number,
    options?: {
      readonly activate?: boolean;
    },
  ): boolean;
  /**
   * Whether {@link movePanel} would accept this move (pure query; same
   * guards, no mutation). Drives the group drop overlay, the tab-strip
   * insertion indicator, and the split menu items, so none of them offers a
   * move the store would refuse (e.g. a chat leaving the chat group).
   */
  canMovePanel(
    worktreeKey: string,
    panelId: string,
    targetGroupId: string,
    edge: PanelDropEdge,
  ): boolean;
  /**
   * Moves a panel to a ROOT edge of the grid (VS Code's window-edge drop):
   * removes the panel from its group (an emptied source group closes, as in
   * {@link movePanel}) and creates a new single-tab group as a DIRECT child
   * of the grid root at that edge, spanning the grid's full orthogonal
   * extent — full height for `left`/`right`, full width for `top`/`bottom` —
   * at ~20% of the grid's size along the insertion axis (clamped by leaf
   * minimums). The new group is focused (MRU head).
   *
   * Engine seam: the public `Grid` API is view-relative and cannot express a
   * root-level insert (an edge drop relative to a nested leaf would split
   * that leaf), so this action rebuilds the grid through
   * `serialize()` → pure-tree transform → `SerializableGrid.deserialize()`
   * with a deserializer that REUSES the live {@link PanelLeafView} instances.
   * Leaf views — and therefore leaf container elements, group portals, and
   * adopted panel content DOM — keep their identity; only the Grid instance
   * is new (the host re-attaches it exactly like a restore). When the edge's
   * axis matches the root orientation the new leaf is spliced into the root
   * branch at index 0 / end; when it is orthogonal the old root is wrapped
   * as the single sibling of the new leaf under a new, flipped root branch.
   *
   * Returns `false` (no mutation) when the layout/panel is unknown, the
   * panel is already the sole content of a root-level group at that edge
   * (including the sole tab of a single-group layout), or the grid is too
   * small to host a new edge group.
   */
  movePanelToRootEdge(
    worktreeKey: string,
    panelId: string,
    edge: PanelRootDropEdge,
  ): boolean;
  /**
   * Whether {@link movePanelToRootEdge} would actually mutate the layout for
   * this panel/edge (pure query; same guards, no mutation). Drives the
   * root-edge drop affordance: the grid host suppresses the drop strip (and
   * its full-edge highlight) for edges whose drop would silently no-op —
   * e.g. dragging the sole tab of the rightmost root-level group to the
   * right edge.
   */
  canMovePanelToRootEdge(
    worktreeKey: string,
    panelId: string,
    edge: PanelRootDropEdge,
  ): boolean;
  /** Makes a group the active group and promotes it in the MRU list. */
  focusGroup(worktreeKey: string, groupId: string): void;
  /**
   * Focuses the neighboring group in the given direction from the active
   * group, resolved against live grid geometry (`getNeighborViews`). When
   * several groups touch the boundary, the most-recently-active one wins
   * (MRU tiebreak, mirroring close-focus behavior). Returns the focused
   * group id, or `null` when the layout is unknown, a group is maximized
   * (only one group is visible), or no neighbor exists in that direction.
   */
  focusGroupInDirection(
    worktreeKey: string,
    direction: PanelSplitDirection,
  ): string | null;
  /** Maximizes (`true`) or restores (`false`) a group. No-op with <2 groups. */
  maximizeGroup(worktreeKey: string, groupId: string, maximized: boolean): void;
  /**
   * Collapses a border-adjacent group to a `PANEL_COLLAPSED_BAR_SIZE` icon
   * bar along its eligible edge. Returns `false` (no mutation) when the
   * layout/group is unknown, a group is maximized, the group is already
   * collapsed, or the group's collapse affordance is not `'enabled'`.
   *
   * `auto: true` marks the collapse as Canopy's own default rather than the
   * user's, recording on the persisted descriptor that the group may be
   * reopened automatically once it gains content. Omit it for every user
   * action: an unflagged collapse is never undone.
   */
  collapseGroup(
    worktreeKey: string,
    groupId: string,
    options?: { readonly auto?: boolean },
  ): boolean;
  /**
   * Expands a collapsed group back to its pre-collapse size and constraints,
   * focuses it unless `focus` is `false`, and optionally activates one of its
   * tabs. Returns `false` (no mutation) when the layout/group is unknown or the
   * group is not collapsed.
   */
  expandGroup(
    worktreeKey: string,
    groupId: string,
    options?: {
      readonly activatePanelId?: string;
      readonly focus?: boolean;
    },
  ): boolean;
  /**
   * Expands `groupId` iff it is currently collapsed; otherwise a no-op.
   * Focuses the expanded group unless `focus` is `false`.
   */
  ensureGroupExpanded(
    worktreeKey: string,
    groupId: string,
    options?: { readonly focus?: boolean },
  ): void;
  /** `'even'` distributes sizes across all groups (exits maximize). */
  arrangeGroups(worktreeKey: string, arrangement: 'even'): void;
  /** Lays the grid out at the given container size (host/tests). */
  layoutContainer(worktreeKey: string, width: number, height: number): void;
  /** Resizes one group to the given size (drag-end commit path). */
  resizeGroup(worktreeKey: string, groupId: string, size: IViewSize): void;
  /** Serializes the layout into the protocol schema, or `null`. */
  serializeLayout(worktreeKey: string): SerializablePanelLayoutFile | null;
  /**
   * Validates (`migratePanelLayout`) and wholesale-rebuilds the layout from
   * a persisted file. Returns `false` (no-op) for corrupt input, for files
   * whose tabs violate the per-kind instance contract (chat / file-diff /
   * activity-card entries WITHOUT their required instance keys — this is
   * the legacy-layout fallback trigger: old kind-only files fail and the
   * caller builds the new default), and for duplicate instance keys within
   * the file. Singleton kinds with unexpected instance data are accepted
   * with the instance dropped. `pipeline-execution`, `subagent-chat` and
   * `session-breakdown` tabs
   * are the exceptions to rejection: an unbound tab, or a run/subagent already
   * bound earlier in the file or in another live layout of the worktree's
   * family, is dropped and the rest of the file restores. A tab whose kind the
   * layout's scope can't serve ({@link setPanelLayoutScopeExcludedKinds}) is
   * dropped too. Accepts `unknown` because Phase 5 reads this straight from
   * disk.
   */
  restoreLayout(
    worktreeKey: string,
    file: unknown,
    containerSize?: { readonly width: number; readonly height: number },
  ): boolean;
  /** Disposes the grid/views and drops all state for a worktree. */
  disposeLayout(worktreeKey: string): void;
  /**
   * Phase 8 pull-out: moves one group (its leaf plus ALL of its tabs,
   * preserving panel ids/titles and the active tab) out of `worktreeKey`'s
   * layout into a brand-new single-group layout under `targetLayoutKey` (the
   * auxiliary window's layout key). The source group is closed in the source
   * layout. Returns `false` (no mutation) when the source layout/group is
   * unknown, the target key is already taken, or the group is the source
   * layout's last remaining group (the grid must always hold one view).
   */
  extractGroupToLayout(
    worktreeKey: string,
    groupId: string,
    targetLayoutKey: string,
  ): boolean;
  /** Moves one tab into a new single-group auxiliary layout. */
  extractPanelToLayout(
    worktreeKey: string,
    groupId: string,
    panelId: string,
    targetLayoutKey: string,
  ): boolean;
  /**
   * Phase 8 merge-back: moves every tab of `sourceLayoutKey` (leaf DFS
   * order) into a preferred target group when supplied, otherwise the
   * target layout's most-recently-active group. A missing preferred group
   * may be recreated beside a saved anchor. Activates the source layout's
   * active tab, focuses the receiving group, and disposes the source layout. Tabs whose
   * panel id OR instance key already exists in the target's layout family
   * (excluding the source layout itself, which is being consumed) are
   * dropped defensively. Returns `false` (no mutation) when either layout is
   * unknown or the keys match.
   */
  adoptLayoutTabs(
    sourceLayoutKey: string,
    targetLayoutKey: string,
    options?: AdoptLayoutTabsOptions,
  ): boolean;
  /**
   * Moves every chat tab that sits outside the {@link setPanelLayoutChatGroup}
   * group into it (keeping their order, after its own tabs). A group the
   * moves empty is kept (empty) under a fixed topology and closed otherwise,
   * as closing its last tab would. A main layout without the group gets it
   * back first; auxiliary layouts are exempt. The focused chat stays
   * selected and focused. Returns whether anything moved.
   */
  relocateChatTabsToChatGroup(worktreeKey: string): boolean;
  /**
   * Closes every tab whose kind {@link setPanelLayoutExcludedKinds} excludes.
   * A group the removal empties is kept (empty) under a fixed topology and
   * closed otherwise. Returns whether anything was removed.
   */
  removeExcludedKindTabs(worktreeKey: string): boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const DEFAULT_CONTAINER_WIDTH = 1200;
const DEFAULT_CONTAINER_HEIGHT = 800;

const fixedTopologyLayoutKeys = new Set<string>();

/** Host policy seam: Minimal locks topology; Advanced remains unrestricted. */
export function setPanelLayoutFixedTopology(
  worktreeKey: string,
  fixed: boolean,
): void {
  const wasFixed = fixedTopologyLayoutKeys.has(worktreeKey);
  if (fixed) fixedTopologyLayoutKeys.add(worktreeKey);
  else fixedTopologyLayoutKeys.delete(worktreeKey);
  if (wasFixed === fixed) return;

  const layout = usePanelLayoutStore.getState().layouts[worktreeKey];
  if (!layout) return;

  if (fixed)
    layout.grid.setCollapsedViews(
      new Set<PanelLeafView>(),
      PANEL_COLLAPSED_BAR_SIZE,
    );

  let visibilityChanged = false;
  for (const [groupId, group] of Object.entries(layout.groups)) {
    if (group.collapsed === undefined) continue;
    const view = layout.leafViews.get(groupId);
    if (!view || layout.grid.isViewVisible(view) === !fixed) continue;
    layout.grid.setViewVisible(view, !fixed);
    visibilityChanged = true;
  }
  if (!fixed)
    syncCollapsedBranches(layout.grid, layout.groups, layout.leafViews);
  if (!visibilityChanged) return;

  const revision = layout.revision + 1;
  usePanelLayoutStore.setState((state) => {
    if (state.layouts[worktreeKey] !== layout) return state;
    return {
      layouts: {
        ...state.layouts,
        [worktreeKey]: {
          ...layout,
          revision,
          controller: buildController(layout.grid, revision, layout.leafViews),
        },
      },
    };
  });
}

function hasFixedTopology(worktreeKey: string): boolean {
  return fixedTopologyLayoutKeys.has(worktreeKey);
}

let chatPanelGroupId: string | null = null;

/**
 * Host policy seam: when set, chat tabs live only in this group of any
 * layout that has it. Adding a chat elsewhere lands it here, moving or
 * splitting a chat out of it is refused, and merged-back chats return to it.
 * Layouts without the group (auxiliary windows) are unaffected. `null`
 * lifts the restriction.
 */
export function setPanelLayoutChatGroup(groupId: string | null): void {
  chatPanelGroupId = groupId;
}

let excludedPanelKinds: ReadonlySet<PanelKind> = new Set();
let excludedKindsExempt: ((worktreeKey: string) => boolean) | null = null;

/**
 * Host policy seam: panel kinds no layout may hold. Adding one is refused;
 * {@link PanelLayoutState.removeExcludedKindTabs} closes existing ones
 * (including tabs a fixed topology otherwise protects). Empty lifts it.
 * `exempt` names layouts the rule skips (one with no replacement for the
 * excluded kinds).
 */
export function setPanelLayoutExcludedKinds(
  kinds: readonly PanelKind[],
  exempt?: (worktreeKey: string) => boolean,
): void {
  excludedPanelKinds = new Set(kinds);
  excludedKindsExempt = exempt ?? null;
}

let scopeExcludedKinds:
  | ((worktreeKey: string) => ReadonlySet<PanelKind>)
  | null = null;

/**
 * Host policy seam: panel kinds one layout may not hold because its scope
 * can't serve them (a cloud chat scope has no local terminal, for one).
 * Enforced like {@link setPanelLayoutExcludedKinds}, per layout, and
 * `restoreLayout` also drops those tabs. `null` lifts it.
 */
export function setPanelLayoutScopeExcludedKinds(
  resolve: ((worktreeKey: string) => ReadonlySet<PanelKind>) | null,
): void {
  scopeExcludedKinds = resolve;
}

/** Whether `worktreeKey`'s layout may not hold `kind`. */
export function isPanelKindExcluded(
  worktreeKey: string,
  kind: PanelKind,
): boolean {
  return (
    (excludedPanelKinds.has(kind) &&
      excludedKindsExempt?.(worktreeKey) !== true) ||
    scopeExcludedKinds?.(worktreeKey).has(kind) === true
  );
}

/** The chat group a chat must use in `layout`, or `null` when unrestricted. */
export function restrictedChatGroupId(
  layout: Pick<WorktreePanelLayout, 'groups'> | undefined,
): string | null {
  return chatPanelGroupId !== null &&
    layout?.groups[chatPanelGroupId] !== undefined
    ? chatPanelGroupId
    : null;
}

/** Where a tab would go: a group (`center` docks, an edge splits it), a
 * root edge of the grid, or a brand-new group. */
type TabDestination =
  | { readonly groupId: string; readonly edge: PanelDropEdge }
  | 'root-edge'
  | 'new-group';

/**
 * The chat-routing rule's one refusal predicate: whether putting `tab` at
 * `destination` would take a restricted chat out of the chat group (another
 * group, a split, a root edge, a new group). Every store path that moves,
 * splits, or places an existing tab asks this, and so do the drag and menu
 * affordances (through {@link PanelLayoutState.canMovePanel} and
 * `canMovePanelToRootEdge`), so what the UI offers and what the store does
 * always agree.
 */
function refusesChatDestination(
  layout: Pick<WorktreePanelLayout, 'groups'>,
  tab: Pick<PanelTabDescriptor, 'kind'>,
  destination: TabDestination,
): boolean {
  const chatGroupId =
    tab.kind === 'chat' ? restrictedChatGroupId(layout) : null;
  if (chatGroupId === null) {
    return false;
  }
  return (
    typeof destination === 'string' ||
    destination.groupId !== chatGroupId ||
    destination.edge !== 'center'
  );
}

/**
 * Whether the fixed layout's Side Panel may be emptied: its Activity and File
 * explorer tabs close like any other, and the empty Side Panel and Bottom
 * Drawer still collapse and expand. Off, Activity and File explorer always
 * lead the Side Panel; the desktop turns it on under early access, where an
 * empty Side Panel lists what to open.
 */
let fixedSidePanelTabsClosable = false;

/** The fixed layout's optional groups: the Side Panel and Bottom Drawer. */
const FIXED_OPTIONAL_GROUP_IDS: ReadonlySet<string> = new Set([
  'group-extras',
  'group-terminal',
]);

export function setFixedSidePanelTabsClosable(closable: boolean): void {
  fixedSidePanelTabsClosable = closable;
}

/** The fixed layout's Activity and File explorer, unless they are closable. */
function isFixedSidePanelTab(
  worktreeKey: string,
  tab: Pick<PanelTabDescriptor, 'kind'>,
): boolean {
  return (
    hasFixedTopology(worktreeKey) &&
    !fixedSidePanelTabsClosable &&
    (tab.kind === 'activity-section' || tab.kind === 'file-explorer')
  );
}

/**
 * Whether a group emptied by closing or moving its last tab stays (empty)
 * instead of closing: only a fixed topology whose Side Panel may be emptied
 * (early access), so the empty Side Panel and Bottom Drawer can still be
 * shown, hidden, and filled.
 */
function keepsEmptyGroups(worktreeKey: string): boolean {
  return hasFixedTopology(worktreeKey) && fixedSidePanelTabsClosable;
}

/**
 * Host policy seam: whether a tab must stay open right now. The desktop keeps
 * a chat open while its turn runs or its delegates are live; the shared store
 * cannot see chat state, so the host injects the answer. Consulted by
 * {@link PanelLayoutState.closeGroup}, which closes the other tabs and keeps
 * the group (with the protected tabs) instead of removing it.
 */
export type PanelTabCloseGuard = (
  layoutKey: string,
  tab: PanelTabDescriptor,
) => boolean;

let panelTabCloseGuard: PanelTabCloseGuard | undefined;

/** Installs (or clears, with `undefined`) the {@link PanelTabCloseGuard}. */
export function setPanelTabCloseGuard(
  guard: PanelTabCloseGuard | undefined,
): void {
  panelTabCloseGuard = guard;
}

function isCloseProtectedTab(
  layoutKey: string,
  tab: PanelTabDescriptor,
): boolean {
  return panelTabCloseGuard?.(layoutKey, tab) === true;
}

/**
 * Optional per-group document resolver — the Phase 8 aux-window seam.
 *
 * Leaf container elements default to the renderer's global `document` (the
 * opener realm, per the doc 13 rule: leaves destined for pulled-out windows
 * are still CREATED in the opener realm and then adopted into the child
 * document). Phase 8 installs a resolver via
 * {@link setPanelLeafDocumentResolver} only if a per-group creation document
 * ever needs to diverge from the opener's (e.g. a web wrapper without the
 * shared-realm guarantee); returning `undefined` for a group keeps the
 * default.
 */
export type PanelLeafDocumentResolver = (
  groupId: string,
) => Document | undefined;

let panelLeafDocumentResolver: PanelLeafDocumentResolver | undefined;

/**
 * Installs (or clears, with `undefined`) the per-group document resolver
 * used when creating panel leaf container elements. Phase 8 aux-window
 * plumbing owns this; nothing sets it in the single-window app.
 */
export function setPanelLeafDocumentResolver(
  resolver: PanelLeafDocumentResolver | undefined,
): void {
  panelLeafDocumentResolver = resolver;
}

/** The document a group's leaf element is created in (see resolver docs). */
function getOwnerDocument(groupId: string): Document {
  return panelLeafDocumentResolver?.(groupId) ?? document;
}

/** Whether a panel kind is a worktree singleton (no instance binding). */
export function isSingletonPanelKind(kind: PanelKind): boolean {
  return SINGLETON_PANEL_KINDS.has(kind);
}

/**
 * Derives a tab's IDENTITY key — the unit of per-worktree uniqueness:
 * - singleton kinds (activity-section, file-explorer) key on the kind alone,
 * - `terminal` keys on `instance.terminalId` (an unbound placeholder uses
 *   the bare `terminal:` key),
 * - `chat` keys on `instance.chatTabId`,
 * - `file-diff` keys on `instance.fileTabId` (falling back to
 *   `instance.filePath`),
 * - `activity-card` keys on `instance.sectionId`,
 * - `usage` keys on `instance.variant`,
 * - `automations` keys on `instance.variant`,
 * - `browser` keys on `instance.browserId` (one panel per persisted browser
 *   session; multiple Browser panels coexist when their ids differ),
 * - `pipeline-execution` keys on `instance.executionId` (one panel per run;
 *   job selection and breadcrumb state never enter the key).
 * - `subagent-chat` keys on `instance.rootChatId` + `instance.subagentId`
 *   (each URI-encoded, joined by `/`, so ids containing `/` cannot collide);
 *   `subagentKind` never enters the key.
 * - `session-breakdown` keys on `instance.chatId` (one panel per chat).
 * - `plan` and `plan-diagram` key on the trimmed `instance.planId` with
 *   their own kind prefix, so one plan's document and diagram panels coexist
 *   while each stays unique per plan (a hand-edited padded id is the same
 *   plan, as the panel hosts resolve it).
 *
 * Entity-bound kinds missing their binding produce the bare `${kind}:` key,
 * so at most one legacy (instance-less) tab of such a kind can exist per
 * family. The store enforces key uniqueness across a worktree's layout
 * family in `addTab` / `adoptLayoutTabs` (moves are exempt — they relocate
 * the one instance).
 */
export function getPanelInstanceKey(
  descriptor: Pick<PanelTabDescriptor, 'kind' | 'instance'>,
): string {
  switch (descriptor.kind) {
    case 'terminal':
      return `terminal:${descriptor.instance?.terminalId ?? ''}`;
    case 'chat':
      return `chat:${descriptor.instance?.chatTabId ?? ''}`;
    case 'file-diff':
      return `file-diff:${
        descriptor.instance?.fileTabId ?? descriptor.instance?.filePath ?? ''
      }`;
    case 'activity-card':
      return `activity-card:${descriptor.instance?.sectionId ?? ''}`;
    case 'usage':
      return `usage:${descriptor.instance?.variant ?? ''}`;
    case 'automations':
      return `automations:${descriptor.instance?.variant ?? ''}`;
    case 'browser':
      return `browser:${descriptor.instance?.browserId ?? ''}`;
    case 'pipeline-execution':
      return `pipeline-execution:${descriptor.instance?.executionId ?? ''}`;
    case 'subagent-chat':
      return `subagent-chat:${encodeURIComponent(
        descriptor.instance?.rootChatId ?? '',
      )}/${encodeURIComponent(descriptor.instance?.subagentId ?? '')}`;
    case 'session-breakdown':
      return `session-breakdown:${descriptor.instance?.chatId ?? ''}`;
    case 'plan':
      return `plan:${descriptor.instance?.planId?.trim() ?? ''}`;
    case 'plan-diagram':
      return `plan-diagram:${descriptor.instance?.planId?.trim() ?? ''}`;
    case 'new-tab':
      return `new-tab:${descriptor.instance?.newTabId ?? ''}`;
    default:
      return descriptor.kind;
  }
}

/**
 * Whether a persisted panel entry satisfies its kind's instance contract:
 * chat needs `chatTabId`, file-diff needs `fileTabId` or `filePath`,
 * activity-card needs `sectionId`, usage and automations need a known
 * `variant`, browser needs a trimmed non-empty `browserId` (unbound Browser
 * panels may never be created or restored), pipeline-execution needs exactly
 * one trimmed, bounded `executionId` (the protocol's
 * `isPipelineExecutionPanelInstance`), subagent-chat needs exactly
 * `rootChatId`, `subagentId`, and `subagentKind` (the protocol's
 * `isSubagentChatPanelInstance`), session-breakdown needs exactly one
 * trimmed, bounded `chatId` (the protocol's
 * `isSessionBreakdownPanelInstance`), and `plan`/`plan-diagram` need a
 * trimmed non-empty `planId`. Singleton kinds always pass (unexpected
 * instance data on them is dropped by the caller, not rejected).
 */
function satisfiesInstanceContract(
  kind: PanelKind,
  instance: Readonly<Record<string, string>> | undefined,
): boolean {
  switch (kind) {
    case 'pipeline-execution':
      return isPipelineExecutionPanelInstance(instance);
    case 'subagent-chat':
      return isSubagentChatPanelInstance(instance);
    case 'session-breakdown':
      return isSessionBreakdownPanelInstance(instance);
    case 'chat':
      return isNonEmpty(instance?.chatTabId);
    case 'file-diff':
      return isNonEmpty(instance?.fileTabId) || isNonEmpty(instance?.filePath);
    case 'activity-card':
      return isNonEmpty(instance?.sectionId);
    case 'usage':
      return isUsagePanelVariant(instance?.variant);
    case 'automations':
      return isAutomationsPanelVariant(instance?.variant);
    case 'browser':
      return isNonEmpty(instance?.browserId?.trim());
    case 'plan':
    case 'plan-diagram':
      return isNonEmpty(instance?.planId?.trim());
    default:
      return true;
  }
}

function isNonEmpty(value: string | undefined): boolean {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Instance-bound kinds whose invalid or duplicate persisted entries are
 * PRUNED before a restore instead of rejecting the whole file. Plan panels
 * reference worktree data that can disappear or be hand-edited independently
 * of the layout, so one bad plan entry must never cost the user their
 * layout. Every other kind keeps `restoreLayout`'s all-or-nothing rejection
 * (the legacy-layout fallback depends on it).
 */
export const PRUNABLE_BOUND_PANEL_KINDS: ReadonlySet<PanelKind> =
  new Set<PanelKind>(['plan', 'plan-diagram']);

/** Whether one persisted entry must be pruned; records kept keys in `seen`. */
function shouldPruneBoundPanelEntry(
  entry: ISerializedPanelEntry,
  seen: Set<string>,
): boolean {
  if (!PRUNABLE_BOUND_PANEL_KINDS.has(entry.kind)) {
    return false;
  }
  if (!satisfiesInstanceContract(entry.kind, entry.instance)) {
    return true;
  }
  const instanceKey = getPanelInstanceKey(entry);
  if (seen.has(instanceKey)) {
    return true;
  }
  seen.add(instanceKey);
  return false;
}

function pruneBoundPanelNode(
  node: ISerializedPanelNode,
  seen: Set<string>,
): ISerializedPanelNode {
  if (node.type === 'leaf') {
    const panels = node.panels.filter(
      (entry) => !shouldPruneBoundPanelEntry(entry, seen),
    );
    if (panels.length === node.panels.length) {
      return node;
    }
    const activePanelId =
      node.activePanelId !== null &&
      panels.some((entry) => entry.panelId === node.activePanelId)
        ? node.activePanelId
        : (panels[0]?.panelId ?? null);
    return { ...node, panels, activePanelId };
  }
  let changed = false;
  const children = node.children.map((child) => {
    const next = pruneBoundPanelNode(child, seen);
    changed ||= next !== child;
    return next;
  });
  return changed ? { ...node, children } : node;
}

function serializedNodeHasPanels(node: ISerializedPanelNode): boolean {
  return node.type === 'leaf'
    ? node.panels.length > 0
    : node.children.some(serializedNodeHasPanels);
}

/**
 * Drops invalid or duplicate entries of the {@link PRUNABLE_BOUND_PANEL_KINDS}
 * from a validated layout file so the rest of the layout restores intact.
 * Walks the main grid's leaves first, then each `poppedOut` window grid in
 * order, so the first occurrence of an instance key wins family-wide. An entry
 * is dropped when it fails its kind's instance contract (no `planId`) or
 * repeats an instance key already kept. Each touched leaf re-normalizes its
 * `activePanelId`; a popped-out window left with no panels is dropped. Other
 * kinds are never touched. Returns the SAME object when nothing was pruned.
 */
export function pruneInvalidBoundPanelEntries(
  file: SerializablePanelLayoutFile,
): SerializablePanelLayoutFile {
  const seen = new Set<string>();
  const root = pruneBoundPanelNode(file.grid.root, seen);
  let poppedChanged = false;
  const poppedOut: SerializedPoppedPanelWindow[] = [];
  for (const entry of file.poppedOut ?? []) {
    const popRoot = pruneBoundPanelNode(entry.grid.root, seen);
    if (popRoot === entry.grid.root) {
      poppedOut.push(entry);
      continue;
    }
    poppedChanged = true;
    if (serializedNodeHasPanels(popRoot)) {
      poppedOut.push({ ...entry, grid: { ...entry.grid, root: popRoot } });
    }
  }
  const grid = root === file.grid.root ? file.grid : { ...file.grid, root };
  if (!poppedChanged) {
    return grid === file.grid ? file : { ...file, grid };
  }
  const next: SerializablePanelLayoutFile = {
    version: file.version,
    grid,
    activeGroupId: file.activeGroupId,
    mostRecentActiveGroupIds: file.mostRecentActiveGroupIds,
  };
  return poppedOut.length > 0 ? { ...next, poppedOut } : next;
}

/**
 * All live layout keys belonging to a worktree's layout FAMILY: the main
 * worktree layout plus every auxiliary-window layout it owns. Accepts either
 * the worktree key or one of its aux keys.
 */
function collectFamilyLayoutKeys(
  layouts: Record<string, WorktreePanelLayout>,
  layoutKey: string,
): string[] {
  const ownerKey = getAuxPanelLayoutOwnerKey(layoutKey) ?? layoutKey;
  return Object.keys(layouts).filter(
    (key) => key === ownerKey || getAuxPanelLayoutOwnerKey(key) === ownerKey,
  );
}

/** Whether any tab across the given layouts already uses `instanceKey`. */
function familyHasInstanceKey(
  layouts: Record<string, WorktreePanelLayout>,
  familyKeys: readonly string[],
  instanceKey: string,
): boolean {
  return familyKeys.some((key) =>
    Object.values(layouts[key]?.groups ?? {}).some((groupState) =>
      groupState.tabs.some((tab) => getPanelInstanceKey(tab) === instanceKey),
    ),
  );
}

/**
 * Kinds whose invalid or already-bound persisted tabs `restoreLayout` DROPS
 * instead of rejecting the whole file: each binds one live entity (a pipeline
 * run, a subagent, a chat's Session breakdown) that has no live store to
 * reconcile against, so one stale tab must never cost the user's layout.
 */
const DROPPABLE_BOUND_PANEL_KINDS: ReadonlySet<PanelKind> = new Set<PanelKind>([
  'pipeline-execution',
  'subagent-chat',
  'session-breakdown',
]);

/**
 * {@link DROPPABLE_BOUND_PANEL_KINDS} instance keys already bound anywhere in
 * `layoutKey`'s family EXCEPT `layoutKey` itself — the layout a restore is
 * about to replace wholesale, whose own tabs therefore never count as a
 * conflict.
 */
function collectOtherFamilyDroppableBoundKeys(
  layouts: Record<string, WorktreePanelLayout>,
  layoutKey: string,
): Set<string> {
  const keys = new Set<string>();
  for (const key of collectFamilyLayoutKeys(layouts, layoutKey)) {
    if (key === layoutKey) continue;
    for (const groupState of Object.values(layouts[key]?.groups ?? {})) {
      for (const tab of groupState.tabs) {
        if (DROPPABLE_BOUND_PANEL_KINDS.has(tab.kind)) {
          keys.add(getPanelInstanceKey(tab));
        }
      }
    }
  }
  return keys;
}

/** Whether any tab across the given layouts already uses `panelId`. */
function familyHasPanelId(
  layouts: Record<string, WorktreePanelLayout>,
  familyKeys: readonly string[],
  panelId: string,
): boolean {
  return familyKeys.some((key) =>
    Object.values(layouts[key]?.groups ?? {}).some((groupState) =>
      groupState.tabs.some((tab) => tab.panelId === panelId),
    ),
  );
}

/** Where a panel lives within a worktree's layout family. */
export interface PanelInstanceLocation {
  readonly layoutKey: string;
  readonly groupId: string;
  readonly panelId: string;
}

/**
 * Finds the panel bound to `instanceKey` (see {@link getPanelInstanceKey})
 * anywhere in `worktreeKey`'s layout family (main layout first, then aux
 * layouts). Returns `null` when no such panel is open. Used by the chat sync
 * bridge and the add-menu catalog.
 */
export function findPanelByInstanceKey(
  worktreeKey: string,
  instanceKey: string,
): PanelInstanceLocation | null {
  const layouts = usePanelLayoutStore.getState().layouts;
  const familyKeys = collectFamilyLayoutKeys(layouts, worktreeKey).sort(
    // Main layout first (it never contains the separator), then aux keys.
    (a, b) => Number(isAuxPanelLayoutKey(a)) - Number(isAuxPanelLayoutKey(b)),
  );
  for (const layoutKey of familyKeys) {
    const layout = layouts[layoutKey];
    if (!layout) continue;
    for (const [groupId, groupState] of Object.entries(layout.groups)) {
      for (const tab of groupState.tabs) {
        if (getPanelInstanceKey(tab) === instanceKey) {
          return { layoutKey, groupId, panelId: tab.panelId };
        }
      }
    }
  }
  return null;
}

function generateId(prefix: 'group' | 'panel'): string {
  const uuid =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `${prefix}-${uuid}`;
}

function createLeafView(groupId: string): PanelLeafView {
  return new PanelLeafView({
    id: groupId,
    element: createPanelLeafElement(getOwnerDocument(groupId)),
    minimumWidth: DEFAULT_PANEL_LEAF_MINIMUM_WIDTH,
  });
}

function dropEdgeToDirection(
  edge: Exclude<PanelDropEdge, 'center'>,
): Direction {
  switch (edge) {
    case 'top':
      return Direction.Up;
    case 'bottom':
      return Direction.Down;
    case 'left':
      return Direction.Left;
    case 'right':
      return Direction.Right;
  }
}

/** Leaf group ids in stable (serialization/DFS) order. */
function collectLeafOrder(grid: Grid<PanelLeafView>): string[] {
  const order: string[] = [];
  const visit = (node: GridNode<PanelLeafView>): void => {
    if (isGridBranchNode(node)) {
      for (const child of node.children) {
        visit(child);
      }
      return;
    }
    order.push(node.view.id);
  };
  visit(grid.getViews());
  return order;
}

function focusMru(mru: readonly string[], groupId: string): string[] {
  return [groupId, ...mru.filter((id) => id !== groupId)];
}

/**
 * Builds a {@link CollapseSnapshot} of the live grid for affordance/eligibility
 * queries. Returns `null` before the grid's first real layout (degenerate
 * zero-sized root box) — `buildCollapseSnapshotFromGrid` reports this by
 * returning `null` rather than throwing.
 */
function buildLayoutCollapseSnapshot(
  grid: Grid<PanelLeafView>,
  groups: Record<string, PanelGroupState>,
): CollapseSnapshot | null {
  return buildCollapseSnapshotFromGrid(grid, (groupId) => ({
    collapsedEdge: groups[groupId]?.collapsed?.edge ?? null,
    // An empty group cannot collapse, except the fixed layout's Side Panel
    // and Bottom Drawer once they may be emptied: they still show and hide.
    tabCount:
      groups[groupId]?.tabs.length ||
      (fixedSidePanelTabsClosable && FIXED_OPTIONAL_GROUP_IDS.has(groupId)
        ? 1
        : 0),
  }));
}

/**
 * Enforces the pinned-prefix ordering invariant: pinned tabs first (in their
 * existing relative order), then unpinned tabs (in theirs). Applied wherever a
 * group's tab array is rebuilt from a source that could interleave partitions
 * (center-dock merges, merge-back adoption, restore). Returns a fresh array;
 * an already-partitioned input is returned copied but unchanged in order.
 */
function partitionTabsByPinned(
  tabs: readonly PanelTabDescriptor[],
): PanelTabDescriptor[] {
  const pinned = tabs.filter((tab) => tab.pinned === true);
  if (pinned.length === 0 || pinned.length === tabs.length) {
    return [...tabs];
  }
  return [...pinned, ...tabs.filter((tab) => tab.pinned !== true)];
}

function deriveViewModel(
  grid: Grid<PanelLeafView>,
  groups: Record<string, PanelGroupState>,
  activeGroupId: string | null,
  maximizedGroupId: string | null,
  chatScope: PanelChatScope | null,
): PanelLayoutViewModel {
  // Affordances are meaningless (and geometry degenerate) while maximized —
  // only one leaf is visible/sized, so skip the snapshot entirely.
  const snapshot =
    maximizedGroupId === null
      ? buildLayoutCollapseSnapshot(grid, groups)
      : null;
  const collapseAffordances =
    snapshot === null ? null : getCollapseAffordances(snapshot);
  const groupModels: PanelGroupModel[] = collectLeafOrder(grid).map(
    (groupId) => {
      const groupState = groups[groupId];
      const tabs: PanelTabModel[] = [];
      const hiddenTabs: PanelTabModel[] = [];
      const isHidden =
        groupState === undefined
          ? (): boolean => false
          : groupHiddenTabPredicate(groupState, chatScope);
      for (const tab of groupState?.tabs ?? []) {
        (isHidden(tab) ? hiddenTabs : tabs).push({
          panelId: tab.panelId,
          kind: tab.kind,
          title: tab.title ?? tab.kind,
          ...(tab.instance !== undefined ? { instance: tab.instance } : {}),
          ...(tab.pinned === true ? { pinned: true } : {}),
        });
      }
      const collapsed = groupState?.collapsed;
      const collapseAffordance: PanelCollapseAffordance =
        collapseAffordances?.get(groupId) ?? { state: 'none' };
      return {
        groupId,
        tabs,
        ...(hiddenTabs.length > 0 ? { hiddenTabs } : {}),
        // A collapsed group shows no "active" state — the remembered active
        // panel is kept in the raw store state (and restored on expand) but
        // the view model reports null so no tab reads as active/selected
        // (content `isActive`, the collapsed-bar icon highlight) and its chat
        // can enter an unread state while collapsed.
        activePanelId:
          collapsed !== undefined ? null : (groupState?.activePanelId ?? null),
        ...(collapsed !== undefined
          ? { collapsed: { edge: collapsed.edge } }
          : {}),
        collapseAffordance,
      };
    },
  );

  return { groups: groupModels, activeGroupId, maximizedGroupId };
}

function buildController(
  grid: Grid<PanelLeafView>,
  revision: number,
  leafViews: Map<string, PanelLeafView>,
): PanelGridController {
  return {
    grid,
    revision,
    getCollapsedBranches: (): ReturnType<
      NonNullable<PanelGridController['getCollapsedBranches']>
    > => {
      const branches: {
        groupIds: string[];
        element: HTMLElement;
        edge: PanelCollapseEdge;
      }[] = [];
      const collect = (
        node: ReturnType<typeof grid.getViews>['children'][number],
      ): string[] =>
        isGridBranchNode(node)
          ? node.children.flatMap(collect)
          : [node.view.id];
      const visit = (
        node: ReturnType<typeof grid.getViews>,
        parentOrientation: Orientation,
      ): void => {
        if (node.collapsedElement !== undefined) {
          branches.push({
            groupIds: collect(node),
            element: node.collapsedElement,
            edge:
              parentOrientation === Orientation.HORIZONTAL
                ? node.collapsedAtEnd
                  ? 'right'
                  : 'left'
                : node.collapsedAtEnd
                  ? 'bottom'
                  : 'top',
          });
          return;
        }
        for (const child of node.children)
          if (isGridBranchNode(child))
            visit(
              child,
              parentOrientation === Orientation.HORIZONTAL
                ? Orientation.VERTICAL
                : Orientation.HORIZONTAL,
            );
      };
      const tree = grid.getViews();
      for (const child of tree.children)
        if (isGridBranchNode(child)) visit(child, grid.orientation);
      return branches;
    },
    getLeafElement: (groupId: string): HTMLElement | null =>
      leafViews.get(groupId)?.element ?? null,
  };
}

/** Mutable working copy of a layout record used while servicing one action. */
interface LayoutWork {
  grid: SerializableGrid<PanelLeafView>;
  leafViews: Map<string, PanelLeafView>;
  groups: Record<string, PanelGroupState>;
  activeGroupId: string | null;
  mruGroupIds: string[];
  maximizedGroupId: string | null;
  revision: number;
}

function startWork(layout: WorktreePanelLayout): LayoutWork {
  return {
    grid: layout.grid,
    leafViews: layout.leafViews,
    groups: { ...layout.groups },
    activeGroupId: layout.activeGroupId,
    mruGroupIds: [...layout.mruGroupIds],
    maximizedGroupId: layout.maximizedGroupId,
    revision: layout.revision,
  };
}

function scaleCollapsedExpandedSize(
  collapsed: PanelCollapsedState,
  widthScale: number,
  heightScale: number,
): PanelCollapsedState {
  const horizontal = collapseEdgeAxis(collapsed.edge) === 'horizontal';
  const scale = horizontal ? widthScale : heightScale;
  if (!Number.isFinite(scale) || scale === 1) {
    return collapsed;
  }
  const expandedSize = collapsed.expandedSize * scale;
  return expandedSize === collapsed.expandedSize
    ? collapsed
    : { ...collapsed, expandedSize };
}

function scaleCollapsedGroupRestoreSizes(
  groups: Record<string, PanelGroupState>,
  widthScale: number,
  heightScale: number,
): Record<string, PanelGroupState> {
  let scaledGroups = groups;
  for (const [groupId, group] of Object.entries(groups)) {
    const collapsed = group.collapsed;
    if (collapsed === undefined) continue;
    const scaled = scaleCollapsedExpandedSize(
      collapsed,
      widthScale,
      heightScale,
    );
    if (scaled === collapsed) continue;
    if (scaledGroups === groups) {
      scaledGroups = { ...groups };
    }
    scaledGroups[groupId] = { ...group, collapsed: scaled };
  }
  return scaledGroups;
}

function hasSerializedGridChanged(
  before: ISerializedGrid,
  after: ISerializedGrid,
): boolean {
  return (
    before.width !== after.width ||
    before.height !== after.height ||
    before.orientation !== after.orientation ||
    JSON.stringify(before.root) !== JSON.stringify(after.root)
  );
}

function workFocusGroup(work: LayoutWork, groupId: string): void {
  work.activeGroupId = groupId;
  work.mruGroupIds = focusMru(work.mruGroupIds, groupId);
}

/**
 * Use the existing SplitView priority contract to transfer the size delta to
 * a direct sibling. Relax first, resize explicitly, then pin: pinning first
 * lets the constraint-change event redistribute to the last child before
 * resize priorities are considered. No topology rebuild or content remount.
 */
function resizeInnerCollapsedGroup(
  grid: Grid<PanelLeafView>,
  view: PanelLeafView,
  sibling: PanelLeafView,
  edge: PanelCollapseEdge,
  size: number,
  collapsed: boolean,
): void {
  const horizontal = collapseEdgeAxis(edge) === 'horizontal';
  const expandedMinimum = horizontal
    ? DEFAULT_PANEL_LEAF_MINIMUM_WIDTH
    : DEFAULT_PANEL_LEAF_MINIMUM_HEIGHT;
  sibling.withHighLayoutPriority(() => {
    view.setConstraints(
      horizontal
        ? {
            minimumWidth: PANEL_COLLAPSED_BAR_SIZE,
            maximumWidth: Number.POSITIVE_INFINITY,
          }
        : {
            minimumHeight: PANEL_COLLAPSED_BAR_SIZE,
            maximumHeight: Number.POSITIVE_INFINITY,
          },
    );
    const targetSize = collapsed
      ? PANEL_COLLAPSED_BAR_SIZE
      : Math.max(expandedMinimum, size);
    // Passing only the affected axis avoids a redundant grandparent resize.
    grid.resizeView(
      view,
      horizontal ? { width: targetSize } : { height: targetSize },
    );
    const minimum = collapsed ? PANEL_COLLAPSED_BAR_SIZE : expandedMinimum;
    const maximum = collapsed
      ? PANEL_COLLAPSED_BAR_SIZE
      : Number.POSITIVE_INFINITY;
    view.setConstraints(
      horizontal
        ? { minimumWidth: minimum, maximumWidth: maximum }
        : { minimumHeight: minimum, maximumHeight: maximum },
    );
  });
}

/** Synchronize compact branches and the constraints of their collapsed leaves. */
function syncCollapsedBranches(
  grid: Grid<PanelLeafView>,
  groups: Record<string, PanelGroupState>,
  leafViews: Map<string, PanelLeafView>,
  pinLeaves = true,
  captureExpandedSizes = false,
): void {
  const collapsed = new Set<PanelLeafView>();
  for (const [id, group] of Object.entries(groups)) {
    const view = leafViews.get(id);
    if (
      group.collapsed !== undefined &&
      view !== undefined &&
      grid.isViewVisible(view)
    )
      collapsed.add(view);
  }
  grid.setCollapsedViews(
    collapsed,
    PANEL_COLLAPSED_BAR_SIZE,
    captureExpandedSizes,
  );
  if (!pinLeaves) return;
  for (const [id, group] of Object.entries(groups)) {
    const view = leafViews.get(id);
    if (group.collapsed === undefined || view === undefined) continue;
    const horizontal = collapseEdgeAxis(group.collapsed.edge) === 'horizontal';
    view.setConstraints(
      horizontal
        ? {
            minimumWidth: PANEL_COLLAPSED_BAR_SIZE,
            maximumWidth: PANEL_COLLAPSED_BAR_SIZE,
          }
        : {
            minimumHeight: PANEL_COLLAPSED_BAR_SIZE,
            maximumHeight: PANEL_COLLAPSED_BAR_SIZE,
          },
    );
  }
}

/**
 * Restores a collapsed group's constraints/size and clears its `collapsed`
 * state within `work`. Mutates the engine (constraints + resize) and the
 * work-copy group map in one step so auto-expand call sites (e.g. dropping a
 * panel onto a collapsed group) can compose it with other work mutations
 * before a single {@link commitWork}. Returns `false` (no mutation) when the
 * group is unknown or not currently collapsed.
 */
function expandGroupInWork(
  grid: Grid<PanelLeafView>,
  work: LayoutWork,
  groupId: string,
): boolean {
  const group = work.groups[groupId];
  const view = work.leafViews.get(groupId);
  const collapsed = group?.collapsed;
  if (group === undefined || view === undefined || collapsed === undefined) {
    return false;
  }
  // Release leaf constraints while its ancestor is still compact, then open
  // the ancestor chain. Other collapsed children retain their constraints.
  if (grid.isViewInCollapsedBranch(view))
    view.setConstraints({
      minimumWidth: DEFAULT_PANEL_LEAF_MINIMUM_WIDTH,
      maximumWidth: Number.POSITIVE_INFINITY,
      minimumHeight: DEFAULT_PANEL_LEAF_MINIMUM_HEIGHT,
      maximumHeight: Number.POSITIVE_INFINITY,
    });
  work.groups[groupId] = {
    tabs: group.tabs,
    activePanelId: group.activePanelId,
  };
  syncCollapsedBranches(grid, work.groups, work.leafViews);
  grid.setViewVisible(view, true);
  const axis = collapseEdgeAxis(collapsed.edge);
  const snapshot = buildLayoutCollapseSnapshot(grid, work.groups);
  const siblingId =
    snapshot === null
      ? null
      : getInnerCollapseSibling(snapshot, groupId, collapsed.edge);
  const sibling =
    siblingId === null ? undefined : work.leafViews.get(siblingId);
  if (sibling !== undefined) {
    resizeInnerCollapsedGroup(
      grid,
      view,
      sibling,
      collapsed.edge,
      collapsed.expandedSize,
      false,
    );
  } else {
    if (axis === 'horizontal') {
      view.setConstraints({
        minimumWidth: DEFAULT_PANEL_LEAF_MINIMUM_WIDTH,
        maximumWidth: Number.POSITIVE_INFINITY,
      });
    } else {
      view.setConstraints({
        minimumHeight: DEFAULT_PANEL_LEAF_MINIMUM_HEIGHT,
        maximumHeight: Number.POSITIVE_INFINITY,
      });
    }
    const current = grid.getViewSize(view);
    grid.resizeView(view, {
      width: axis === 'horizontal' ? collapsed.expandedSize : current.width,
      height: axis === 'vertical' ? collapsed.expandedSize : current.height,
    });
  }
  work.groups[groupId] = {
    tabs: group.tabs,
    activePanelId: group.activePanelId,
  };
  grid.restoreExpandedSizes();
  return true;
}

/**
 * Re-validates every currently-collapsed group in `work.groups` against
 * `work.grid`'s CURRENT geometry, expanding (via {@link expandGroupInWork})
 * any whose claimed edge is no longer accepted by the derived-eligibility
 * algorithm. Live structural mutations (leaf removal, promotion of a
 * single-child branch, root-edge insertion shifting adjacency) never
 * re-validate surviving collapsed groups on their own — a naive affordance
 * lookup for an already-collapsed leaf always reports `enabled` toward its
 * own edge (see `affordanceWithOverrides`'s "a collapsed leaf can always
 * expand back toward its own edge" short-circuit), so staleness can only be
 * caught by provisionally treating every collapsed leaf as expanded and
 * replaying its claim — exactly the restore-time contract implemented by
 * {@link planRestoredCollapses}.
 *
 * Call this within the same work transaction AFTER the structural mutation
 * and BEFORE `commitWork`, passing `work.grid` (not a stale `layout.grid`
 * reference) so a wholesale grid rebuild — e.g. `movePanelToRootEdge` — is
 * evaluated against the NEW grid. Returns whether anything expanded.
 */
function expandStaleCollapsesInWork(work: LayoutWork): boolean {
  const snapshot = buildLayoutCollapseSnapshot(work.grid, work.groups);
  if (snapshot === null) {
    return false;
  }
  const requestedEdges = new Map<string, PanelCollapseEdge>();
  for (const groupId of collectLeafOrder(work.grid)) {
    const collapsed = work.groups[groupId]?.collapsed;
    if (collapsed !== undefined) {
      requestedEdges.set(groupId, collapsed.edge);
    }
  }
  if (requestedEdges.size === 0) {
    return false;
  }
  const acceptedEdges = planRestoredCollapses(snapshot, requestedEdges);
  let expanded = false;
  // `Array.from` (not a bare `for...of` over the Map iterator, which needs
  // `--downlevelIteration`/ES2015+ target) to stay consistent with this
  // project's default compilation target.
  for (const groupId of Array.from(requestedEdges.keys())) {
    if (
      !acceptedEdges.has(groupId) &&
      expandGroupInWork(work.grid, work, groupId)
    ) {
      expanded = true;
    }
  }
  return expanded;
}

/**
 * Removes a group's leaf from the grid and its metadata from the work state.
 * Returns `false` (no mutation) when the group is unknown or is the last
 * remaining group — the grid must always hold at least one view.
 */
function workRemoveGroup(work: LayoutWork, groupId: string): boolean {
  if (work.leafViews.size <= 1) {
    return false;
  }
  const view = work.leafViews.get(groupId);
  if (!view) {
    return false;
  }

  // removeView exits any maximized state itself; the commit recomputes
  // `maximizedGroupId` against grid.hasMaximizedView().
  work.grid.removeView(view, Sizing.Auto);
  view.dispose();
  work.leafViews.delete(groupId);
  delete work.groups[groupId];
  work.mruGroupIds = work.mruGroupIds.filter((id) => id !== groupId);

  if (work.activeGroupId === groupId) {
    // MRU focus: land on the most-recently-active surviving group.
    const next = work.mruGroupIds[0] ?? collectLeafOrder(work.grid)[0] ?? null;
    work.activeGroupId = next;
    if (next !== null) {
      work.mruGroupIds = focusMru(work.mruGroupIds, next);
    }
  }

  work.revision += 1;
  return true;
}

/**
 * Removes one tab from its group, fixing up the group's active tab. A group
 * left empty is closed; if it is the last remaining group, or
 * `keepEmptyGroup` is set (a fixed topology whose Side Panel may be emptied:
 * the Side Panel and Bottom Drawer stay even with no tabs, so they can still
 * be shown, hidden, and filled), it stays as an empty group (tabs `[]`,
 * `activePanelId: null`) instead. Returns whether the
 * group was actually REMOVED (a leaf-topology change) — callers use this to
 * decide whether a stale-collapse sweep ({@link expandStaleCollapsesInWork})
 * is needed.
 */
function workDetachTab(
  work: LayoutWork,
  groupId: string,
  panelId: string,
  keepEmptyGroup = false,
  preferredChatTabId?: string,
): boolean {
  const group = work.groups[groupId];
  if (!group) {
    return false;
  }

  const remaining = group.tabs.filter((tab) => tab.panelId !== panelId);
  if (remaining.length === group.tabs.length) {
    return false;
  }

  if (remaining.length === 0) {
    if (!keepEmptyGroup && workRemoveGroup(work, groupId)) {
      return true;
    }
    // A kept group keeps its metadata (a collapsed Side Panel stays collapsed
    // and expandable); a last remaining group starts over.
    work.groups[groupId] = keepEmptyGroup
      ? { ...group, tabs: [], activePanelId: null }
      : { tabs: [], activePanelId: null };
    return false;
  }

  let activePanelId = group.activePanelId;
  if (activePanelId === panelId) {
    const index = group.tabs.findIndex((tab) => tab.panelId === panelId);
    // A move of the active content tab must not incidentally switch chats.
    // Closing a tab still uses its neighboring tab, as before.
    const selectedChat = remaining.find(
      (tab) =>
        preferredChatTabId !== undefined &&
        tab.kind === 'chat' &&
        tab.instance?.chatTabId === preferredChatTabId,
    );
    const neighbor =
      selectedChat ?? group.tabs[index + 1] ?? group.tabs[index - 1];
    activePanelId = neighbor ? neighbor.panelId : null;
  }
  work.groups[groupId] = { ...group, tabs: remaining, activePanelId };
  return false;
}

/**
 * Focuses `groupId` and makes sure it shows: another group's maximized view
 * is exited and a collapsed group expands. Focus alone would leave the group
 * hidden behind either.
 */
function workRevealAndFocusGroup(
  work: LayoutWork,
  groupId: string,
  fixedTopology: boolean,
): void {
  if (work.grid.hasMaximizedView() && work.maximizedGroupId !== groupId) {
    work.grid.exitMaximizedView();
    if (fixedTopology) {
      // Exiting maximize shows every leaf; fixed-topology collapsed groups
      // stay hidden, as restoring a maximized group leaves them.
      for (const [collapsedGroupId, group] of Object.entries(work.groups)) {
        if (group.collapsed === undefined) continue;
        const collapsedView = work.leafViews.get(collapsedGroupId);
        if (collapsedView !== undefined) {
          work.grid.setViewVisible(collapsedView, false);
        }
      }
    }
    work.maximizedGroupId = null;
    work.revision += 1;
  }
  if (work.groups[groupId]?.collapsed !== undefined) {
    expandGroupInWork(work.grid, work, groupId);
  }
  workFocusGroup(work, groupId);
}

/**
 * The one place a chat redirected by the chat-routing rule lands: appends
 * `chats` to the chat group (pinned prefix kept). When `activePanelId` is
 * one of them, the user is meant to see it: it becomes the group's active
 * tab and the group is revealed and focused ({@link workRevealAndFocusGroup}
 * exits another group's maximize and expands a collapse). Otherwise the
 * group's selection, collapse, and focus are left alone. Every redirect
 * (new chats, merged-back chats, relocated chats) goes through here, so none
 * can leave a chat the user opened hidden.
 */
function workRouteChatsToChatGroup(
  work: LayoutWork,
  chatGroupId: string,
  chats: readonly PanelTabDescriptor[],
  activePanelId: string | null,
  fixedTopology: boolean,
): void {
  const chatGroup = work.groups[chatGroupId];
  if (chatGroup === undefined || chats.length === 0) {
    return;
  }
  const activate =
    activePanelId !== null &&
    chats.some((tab) => tab.panelId === activePanelId);
  work.groups[chatGroupId] = {
    ...chatGroup,
    tabs: partitionTabsByPinned([...chatGroup.tabs, ...chats]),
    activePanelId: activate
      ? activePanelId
      : (chatGroup.activePanelId ?? chats[0].panelId),
  };
  if (activate) {
    workRevealAndFocusGroup(work, chatGroupId, fixedTopology);
  }
}

/**
 * Takes every tab `matches` selects out of its group (in group, then tab
 * order) and returns them. A group left empty is kept (empty) when the
 * topology is fixed and closed otherwise, unless it is the last group.
 */
function workTakeTabs(
  work: LayoutWork,
  fixedTopology: boolean,
  matches: (groupId: string, tab: PanelTabDescriptor) => boolean,
): PanelTabDescriptor[] {
  const taken: PanelTabDescriptor[] = [];
  let removedGroup = false;
  for (const [groupId, group] of Object.entries(work.groups)) {
    const picked = group.tabs.filter((tab) => matches(groupId, tab));
    if (picked.length === 0) continue;
    taken.push(...picked);
    const remaining = group.tabs.filter((tab) => !picked.includes(tab));
    if (remaining.length === 0 && !fixedTopology) {
      if (workRemoveGroup(work, groupId)) {
        removedGroup = true;
        continue;
      }
    }
    work.groups[groupId] = {
      ...group,
      tabs: remaining,
      activePanelId: remaining.some(
        (tab) => tab.panelId === group.activePanelId,
      )
        ? group.activePanelId
        : (remaining[0]?.panelId ?? null),
    };
  }
  if (removedGroup) {
    expandStaleCollapsesInWork(work);
  }
  return taken;
}

/**
 * A content tab another chat owns, moved to the selected chat. Ownership
 * decides, not visibility: a tab can show beside the chats yet still belong
 * to another chat, and would hide once it leaves their group.
 */
function adoptTabIntoSelectedChat(
  tab: PanelTabDescriptor,
  scope: PanelChatScope | null,
): PanelTabDescriptor {
  return scope !== null &&
    isChatScopedPanelKind(tab.kind) &&
    tab.chatScope !== undefined &&
    tab.chatScope !== scope.activeChatTabId
    ? { ...tab, chatScope: scope.activeChatTabId }
    : tab;
}

/**
 * Selecting a tab that belongs to another chat (a reveal of an already open
 * file or browser) moves it to the selected chat, so the selection shows.
 */
function adoptIntoSelectedChat(
  layout: WorktreePanelLayout,
  group: PanelGroupState,
  panelId: string,
): PanelGroupState {
  const tab = group.tabs.find((candidate) => candidate.panelId === panelId);
  if (tab === undefined) return group;
  const adopted = adoptTabIntoSelectedChat(tab, layout.chatScope);
  if (adopted === tab) return group;
  return {
    ...group,
    tabs: group.tabs.map((candidate) =>
      candidate === tab ? adopted : candidate,
    ),
  };
}

/**
 * The chat a split's seeded content tab belongs to: the seed's own, else the
 * source group's tab for the same entity (a plan's diagram follows its
 * plan), else the source group's active content tab, else the selected chat.
 */
function splitSeedChatScope(
  layout: WorktreePanelLayout,
  layoutKey: string,
  sourceGroup: PanelGroupState,
  seed: SplitGroupSeed,
): string | undefined {
  if (!isChatScopedPanelKind(seed.kind)) return undefined;
  if (seed.chatScope !== undefined) return seed.chatScope;
  const seedInstance = Object.entries(seed.instance ?? {});
  const scoped = (tab: PanelTabDescriptor | undefined): string | undefined =>
    tab !== undefined && isChatScopedPanelKind(tab.kind)
      ? tab.chatScope
      : undefined;
  const sameEntity = sourceGroup.tabs.find((tab) =>
    seedInstance.some(([key, value]) => tab.instance?.[key] === value),
  );
  const active = sourceGroup.tabs.find(
    (tab) => tab.panelId === sourceGroup.activePanelId,
  );
  return (
    scoped(sameEntity) ??
    scoped(active) ??
    (isAuxPanelLayoutKey(layoutKey)
      ? undefined
      : layout.chatScope?.activeChatTabId)
  );
}

function buildLayoutRecord(
  work: LayoutWork,
  previousController: PanelGridController | undefined,
  chatScope: PanelChatScope | null,
  chatScopeMemory: PanelChatScopeMemory,
): WorktreePanelLayout {
  // The engine can exit maximize as a side effect of add/remove/resize;
  // always reconcile the tracked id against the grid's own state.
  const maximizedGroupId = work.grid.hasMaximizedView()
    ? work.maximizedGroupId
    : null;
  const controller =
    previousController !== undefined &&
    previousController.grid === work.grid &&
    previousController.revision === work.revision
      ? previousController
      : buildController(work.grid, work.revision, work.leafViews);

  return {
    grid: work.grid,
    leafViews: work.leafViews,
    groups: work.groups,
    activeGroupId: work.activeGroupId,
    mruGroupIds: work.mruGroupIds,
    maximizedGroupId,
    revision: work.revision,
    viewModel: deriveViewModel(
      work.grid,
      work.groups,
      work.activeGroupId,
      maximizedGroupId,
      chatScope,
    ),
    controller,
    chatScope,
    chatScopeMemory,
  };
}

function disposeLayoutRecord(layout: WorktreePanelLayout): void {
  layout.leafViews.forEach((view) => view.dispose());
  layout.grid.dispose();
}

// --- serialize/restore mapping (engine tree ↔ protocol schema) -------------

/**
 * Zips one engine-serialized node with store group metadata into the
 * protocol node shape. Engine leaves carry only `{ id }` (the groupId);
 * panels + active tab come from the store. Returns `null` when the trees
 * disagree (unknown leaf payload or missing group metadata).
 */
function engineNodeToProtocolNode(
  node: ISerializedNode,
  groups: Record<string, PanelGroupState>,
): ISerializedPanelNode | null {
  if (node.type === 'leaf') {
    if (!isPanelLeafViewJson(node.data)) {
      return null;
    }
    const group = groups[node.data.id];
    if (!group) {
      return null;
    }
    return {
      type: 'leaf',
      groupId: node.data.id,
      panels: group.tabs.map((tab) => ({
        panelId: tab.panelId,
        kind: tab.kind,
        // Additive optional field; clamped at write time (protocol contract:
        // length is normalized, never a validation failure).
        ...(tab.title !== undefined
          ? { title: clampPanelTitle(tab.title) }
          : {}),
        // Instance bindings persist verbatim — identity values are never
        // clamped (protocol contract: over-length rejects on read instead).
        ...(tab.instance !== undefined ? { instance: tab.instance } : {}),
        // Pinned state persists only when true (additive optional field).
        ...(tab.pinned === true ? { pinned: true } : {}),
        ...(tab.chatScope !== undefined ? { chatScope: tab.chatScope } : {}),
      })),
      activePanelId: group.activePanelId,
      ...(group.collapsed !== undefined ? { collapsed: group.collapsed } : {}),
      size: node.size,
      ...(node.visible !== undefined ? { visible: node.visible } : {}),
      ...(node.maximized !== undefined ? { maximized: node.maximized } : {}),
    };
  }

  const children: ISerializedPanelNode[] = [];
  for (const child of node.data) {
    const converted = engineNodeToProtocolNode(child, groups);
    if (!converted) {
      return null;
    }
    children.push(converted);
  }
  return {
    type: 'branch',
    children,
    size: node.size,
    ...(node.expandedSize !== undefined
      ? { expandedSize: node.expandedSize }
      : {}),
    ...(node.expandedSizes !== undefined
      ? { expandedSizes: node.expandedSizes }
      : {}),
    ...(node.visible !== undefined ? { visible: node.visible } : {}),
  };
}

function protocolNodeToEngineNode(
  node: ISerializedPanelNode,
  orientation: 0 | 1,
): ISerializedNode {
  if (node.type === 'leaf') {
    return {
      type: 'leaf',
      data: { id: node.groupId },
      size: node.size,
      ...(node.visible !== undefined ? { visible: node.visible } : {}),
      ...(node.maximized !== undefined ? { maximized: node.maximized } : {}),
    };
  }
  let expandedSizes = node.expandedSizes;
  // Older files saved only each collapsed leaf's extent. With one expanded
  // sibling its original share is unambiguous: subtract the saved collapsed
  // shares from the split total. Do not infer missing preferences otherwise.
  if (expandedSizes === undefined) {
    const leaves = node.children.filter((child) => child.type === 'leaf');
    const expanded = leaves.filter((leaf) => leaf.collapsed === undefined);
    const axis = orientation === 1 ? 'horizontal' : 'vertical';
    if (
      leaves.length === node.children.length &&
      leaves.length > 1 &&
      expanded.length === 1 &&
      leaves.every(
        (leaf) =>
          leaf.visible !== false &&
          (leaf.collapsed === undefined ||
            collapseEdgeAxis(leaf.collapsed.edge) === axis),
      )
    ) {
      const total = leaves.reduce((sum, leaf) => sum + leaf.size, 0);
      const reserved = leaves.reduce(
        (sum, leaf) => sum + (leaf.collapsed?.expandedSize ?? 0),
        0,
      );
      if (total > reserved)
        expandedSizes = leaves.map(
          (leaf) => leaf.collapsed?.expandedSize ?? total - reserved,
        );
    }
  }
  return {
    type: 'branch',
    data: node.children.map((child) =>
      protocolNodeToEngineNode(child, orientation === 1 ? 0 : 1),
    ),
    size: node.size,
    ...(node.expandedSize !== undefined
      ? { expandedSize: node.expandedSize }
      : {}),
    ...(expandedSizes !== undefined ? { expandedSizes } : {}),
    ...(node.visible !== undefined ? { visible: node.visible } : {}),
  };
}

function collectProtocolLeaves(
  node: ISerializedPanelNode,
  out: ISerializedPanelLeafNode[],
): void {
  if (node.type === 'leaf') {
    out.push(node);
    return;
  }
  for (const child of node.children) {
    collectProtocolLeaves(child, out);
  }
}

/**
 * Deserializer for {@link SerializableGrid.deserialize} that recreates one
 * {@link PanelLeafView} per persisted leaf and rejects unknown or duplicate
 * group ids (throwing here fails the whole restore, which the caller maps to
 * `restoreLayout` returning `false`).
 */
class RestoredPanelLeafDeserializer implements IViewDeserializer<PanelLeafView> {
  readonly views = new Map<string, PanelLeafView>();

  constructor(private readonly validGroupIds: ReadonlySet<string>) {}

  fromJSON(json: unknown): PanelLeafView {
    if (!isPanelLeafViewJson(json)) {
      throw new Error('Invalid serialized panel leaf payload');
    }
    if (!this.validGroupIds.has(json.id) || this.views.has(json.id)) {
      throw new Error(`Invalid serialized panel leaf id: ${json.id}`);
    }
    const view = createLeafView(json.id);
    this.views.set(json.id, view);
    return view;
  }

  disposeAll(): void {
    this.views.forEach((view) => view.dispose());
    this.views.clear();
  }
}

// --- root-edge insertion (movePanelToRootEdge) ------------------------------

/**
 * Fraction of the grid's size (along the insertion axis) given to a new
 * root-edge group. Clamped between the leaf minimum and what the rest of the
 * grid can give up.
 */
const ROOT_EDGE_GROUP_FRACTION = 0.2;

/**
 * Deserializer for the root-edge rebuild: resolves each serialized leaf to
 * the LIVE {@link PanelLeafView} already owned by the layout (identity
 * preservation — leaf elements, group portals, and adopted content DOM all
 * survive the rebuild). Rejects unknown and duplicate ids; a throw aborts
 * `SerializableGrid.deserialize`, which the caller maps to a `false` no-op.
 */
class LivePanelLeafDeserializer implements IViewDeserializer<PanelLeafView> {
  private readonly seen = new Set<string>();

  constructor(private readonly views: ReadonlyMap<string, PanelLeafView>) {}

  fromJSON(json: unknown): PanelLeafView {
    if (!isPanelLeafViewJson(json)) {
      throw new Error('Invalid serialized panel leaf payload');
    }
    const view = this.views.get(json.id);
    if (!view || this.seen.has(json.id)) {
      throw new Error(`Invalid serialized panel leaf id: ${json.id}`);
    }
    this.seen.add(json.id);
    return view;
  }
}

/**
 * The root orientation a full-extent group at `edge` requires: `left`/`right`
 * edge columns are children of a HORIZONTAL root (child sizes are widths),
 * `top`/`bottom` edge rows are children of a VERTICAL root (child sizes are
 * heights).
 */
function rootEdgeOrientation(edge: PanelRootDropEdge): Orientation {
  return edge === 'top' || edge === 'bottom'
    ? Orientation.VERTICAL
    : Orientation.HORIZONTAL;
}

/** Everything `movePanelToRootEdge` needs once the no-op guards pass. */
interface RootEdgeMovePlan {
  readonly sourceGroupId: string;
  readonly movedTab: PanelTabDescriptor;
  /**
   * Structure probe, serialized while any maximized view may still be
   * active — node structure and ids are unaffected by maximize, so the
   * guards stay valid and a no-op leaves the maximized state untouched.
   */
  readonly probe: ISerializedGrid;
  readonly requiredOrientation: Orientation;
  readonly insertAtStart: boolean;
  /** Whether the root branch already stacks along the edge's axis. */
  readonly matched: boolean;
  readonly axisTotal: number;
  readonly newSize: number;
}

interface PanelMovePlan {
  readonly sourceGroupId: string;
  readonly movedTab: PanelTabDescriptor;
  readonly targetGroup: PanelGroupState;
  readonly targetView: PanelLeafView;
}

/**
 * Validates moving `panelId` onto `targetGroupId` at `edge`, returning what
 * the move needs, or `null` when it is refused: unknown panel or target, a
 * restricted chat leaving the chat group ({@link refusesChatDestination}).
 * Shared by `movePanel` and
 * `canMovePanel` (the drag and menu predicate), so an offered move is never
 * refused.
 */
function planPanelMove(
  layout: WorktreePanelLayout,
  panelId: string,
  targetGroupId: string,
  edge: PanelDropEdge,
): PanelMovePlan | null {
  const targetGroup = layout.groups[targetGroupId];
  const targetView = layout.leafViews.get(targetGroupId);
  if (!targetGroup || !targetView) {
    return null;
  }
  const sourceGroupId = Object.keys(layout.groups).find((gid) =>
    layout.groups[gid].tabs.some((tab) => tab.panelId === panelId),
  );
  if (sourceGroupId === undefined) {
    return null;
  }
  const movedTab = layout.groups[sourceGroupId].tabs.find(
    (tab) => tab.panelId === panelId,
  );
  if (!movedTab) {
    return null;
  }
  if (
    refusesChatDestination(layout, movedTab, { groupId: targetGroupId, edge })
  ) {
    return null; // A restricted chat stays in the chat group.
  }
  return { sourceGroupId, movedTab, targetGroup, targetView };
}

/**
 * Evaluates whether moving `panelId` to root `edge` would actually change
 * the layout, returning the computed insertion plan, or `null` when the move
 * would be a no-op or refused: unknown panel, a restricted chat (it never
 * leaves the chat group, {@link refusesChatDestination}), the panel already
 * being the sole content of a root-level group at that edge (including the
 * sole tab of a single-group layout), or a grid too small to host a new edge
 * group.
 *
 * Shared by `movePanelToRootEdge` (the mutation) and
 * `canMovePanelToRootEdge` (the drag-feedback predicate), so the root-edge
 * drop AFFORDANCE and the drop's actual effect can never disagree — the grid
 * host must never highlight an edge whose release would silently no-op.
 */
function planRootEdgeMove(
  layout: WorktreePanelLayout,
  panelId: string,
  edge: PanelRootDropEdge,
): RootEdgeMovePlan | null {
  const sourceGroupId = Object.keys(layout.groups).find((gid) =>
    layout.groups[gid].tabs.some((tab) => tab.panelId === panelId),
  );
  if (sourceGroupId === undefined) {
    return null;
  }
  const sourceGroup = layout.groups[sourceGroupId];
  const movedTab = sourceGroup.tabs.find((tab) => tab.panelId === panelId);
  if (!movedTab) {
    return null;
  }
  if (refusesChatDestination(layout, movedTab, 'root-edge')) {
    return null;
  }
  // The sole tab of a single-group layout already spans every edge; the
  // move could only recreate the current layout.
  if (sourceGroup.tabs.length === 1 && layout.leafViews.size === 1) {
    return null;
  }

  const probe = layout.grid.serialize();
  if (probe.root.type !== 'branch') {
    return null; // Engine invariant: a serialized root is a branch.
  }
  const requiredOrientation = rootEdgeOrientation(edge);
  const insertAtStart = edge === 'top' || edge === 'left';
  const matched = probe.orientation === requiredOrientation;

  // No-op: the panel already IS the sole content of a root-level group
  // at that edge.
  if (matched && sourceGroup.tabs.length === 1) {
    const rootIndex = probe.root.data.findIndex(
      (child) =>
        child.type === 'leaf' &&
        isPanelLeafViewJson(child.data) &&
        child.data.id === sourceGroupId,
    );
    if (
      rootIndex !== -1 &&
      (insertAtStart
        ? rootIndex === 0
        : rootIndex === probe.root.data.length - 1)
    ) {
      return null;
    }
  }

  const axisTotal =
    requiredOrientation === Orientation.VERTICAL ? probe.height : probe.width;
  const minimumSize =
    requiredOrientation === Orientation.VERTICAL
      ? DEFAULT_PANEL_LEAF_MINIMUM_HEIGHT
      : DEFAULT_PANEL_LEAF_MINIMUM_WIDTH;
  // The new group and the rest of the grid each need at least one leaf
  // minimum along the insertion axis.
  if (axisTotal < minimumSize * 2) {
    return null;
  }
  const newSize = Math.min(
    Math.max(Math.round(axisTotal * ROOT_EDGE_GROUP_FRACTION), minimumSize),
    axisTotal - minimumSize,
  );

  return {
    sourceGroupId,
    movedTab,
    probe,
    requiredOrientation,
    insertAtStart,
    matched,
    axisTotal,
    newSize,
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const usePanelLayoutStore = create<PanelLayoutState>((set, get) => {
  const gridSashChangeSubscriptions = new Map<
    string,
    {
      readonly grid: SerializableGrid<PanelLeafView>;
      readonly subscription: { dispose(): void };
    }
  >();

  const bumpLayoutSizeRevision = (layoutKey: string): void => {
    set((state) => ({
      layoutSizeRevisions: {
        ...state.layoutSizeRevisions,
        [layoutKey]: (state.layoutSizeRevisions[layoutKey] ?? 0) + 1,
      },
    }));
  };

  const ensureGridSashChangeSubscription = (
    layoutKey: string,
    grid: SerializableGrid<PanelLeafView>,
  ): void => {
    const current = gridSashChangeSubscriptions.get(layoutKey);
    if (current?.grid === grid) {
      return;
    }
    current?.subscription.dispose();
    gridSashChangeSubscriptions.set(layoutKey, {
      grid,
      subscription: grid.onDidSashChange(() =>
        bumpLayoutSizeRevision(layoutKey),
      ),
    });
  };

  const removeGridSashChangeSubscription = (layoutKey: string): void => {
    gridSashChangeSubscriptions.get(layoutKey)?.subscription.dispose();
    gridSashChangeSubscriptions.delete(layoutKey);
  };

  /**
   * Resolves the selected chat for a main layout and settles each group's
   * active tab for it (see `panel-chat-scope.ts`). Auxiliary layouts are
   * windows of their own and show every tab.
   */
  const settleChatScope = (
    worktreeKey: string,
    work: LayoutWork,
    previous: WorktreePanelLayout | undefined,
    pendingAuxGroups?: Readonly<Record<string, PanelGroupState>>,
  ): { scope: PanelChatScope | null; memory: PanelChatScopeMemory } => {
    if (isAuxPanelLayoutKey(worktreeKey)) return { scope: null, memory: {} };
    // Only chats selectable in this window may hide its content. Keep each
    // tab's owner: tabs of a popped-out chat show here while it is away and
    // become scoped again when that chat returns.
    const present = collectChatTabIds([work.groups]);
    // A chat in another window cannot hide content here, but still owns its
    // remembered selection for when it returns.
    const layouts = get().layouts;
    const liveChats = collectChatTabIds([
      work.groups,
      ...(pendingAuxGroups === undefined ? [] : [pendingAuxGroups]),
      ...collectFamilyLayoutKeys(layouts, worktreeKey)
        .filter((key) => key !== worktreeKey)
        .map((key) => layouts[key].groups),
    ]);
    const previousActive = previous?.chatScope?.activeChatTabId ?? null;
    const scope = resolveChatScope(
      work.groups,
      work.mruGroupIds,
      present,
      previousActive,
    );
    const settled = applyChatScopeToGroups(
      work.groups,
      scope,
      previousActive,
      previous?.chatScopeMemory ?? {},
      liveChats,
    );
    work.groups = { ...settled.groups };
    return { scope, memory: settled.memory };
  };

  const commitWork = (
    worktreeKey: string,
    work: LayoutWork,
    pendingAuxGroups?: Readonly<Record<string, PanelGroupState>>,
  ): void => {
    const previous = get().layouts[worktreeKey];
    const { scope, memory } = settleChatScope(
      worktreeKey,
      work,
      previous,
      pendingAuxGroups,
    );
    if (!hasFixedTopology(worktreeKey) && !work.grid.hasMaximizedView())
      syncCollapsedBranches(work.grid, work.groups, work.leafViews);
    const record = buildLayoutRecord(work, previous?.controller, scope, memory);
    ensureGridSashChangeSubscription(worktreeKey, work.grid);
    set((state) => ({
      layouts: { ...state.layouts, [worktreeKey]: record },
    }));
  };

  return {
    layouts: {},
    layoutSizeRevisions: {},

    initializeLayout: (worktreeKey, descriptor): void => {
      if (get().layouts[worktreeKey] || descriptor.groups.length === 0) {
        return;
      }

      const leafViews = new Map<string, PanelLeafView>();
      const groups: Record<string, PanelGroupState> = {};
      const orderedGroupIds: string[] = [];
      const descriptorGroups: GridNodeDescriptor<PanelLeafView>[] = [];

      for (const seed of descriptor.groups) {
        const groupId = seed.groupId ?? generateId('group');
        if (leafViews.has(groupId)) {
          continue; // Ignore duplicate seed group ids.
        }
        const view = createLeafView(groupId);
        leafViews.set(groupId, view);
        if (seed.kind === undefined) {
          // Kind-less seed: an EMPTY group (see DefaultLayoutGroupSeed).
          groups[groupId] = { tabs: [], activePanelId: null };
        } else {
          const panelId = seed.panelId ?? generateId('panel');
          groups[groupId] = {
            tabs: [
              {
                panelId,
                kind: seed.kind,
                ...(seed.title !== undefined ? { title: seed.title } : {}),
                ...(seed.instance !== undefined
                  ? { instance: seed.instance }
                  : {}),
              },
            ],
            activePanelId: panelId,
          };
        }
        orderedGroupIds.push(groupId);
        descriptorGroups.push(
          seed.size !== undefined
            ? { data: view, size: seed.size }
            : { data: view },
        );
      }

      const grid = SerializableGrid.from<PanelLeafView>({
        orientation:
          descriptor.orientation === 'vertical'
            ? Orientation.VERTICAL
            : Orientation.HORIZONTAL,
        groups: descriptorGroups,
      });
      grid.layout(
        descriptor.containerSize?.width ?? DEFAULT_CONTAINER_WIDTH,
        descriptor.containerSize?.height ?? DEFAULT_CONTAINER_HEIGHT,
      );

      const activeGroupId = orderedGroupIds[0];
      commitWork(worktreeKey, {
        grid,
        leafViews,
        groups,
        activeGroupId,
        mruGroupIds: focusMru(orderedGroupIds, activeGroupId),
        maximizedGroupId: null,
        revision: 1,
      });
    },

    splitGroup: (
      worktreeKey,
      groupId,
      direction,
      seed,
      options,
    ): string | null => {
      if (hasFixedTopology(worktreeKey)) return null;
      const layout = get().layouts[worktreeKey];
      if (!layout) {
        return null;
      }
      const referenceView = layout.leafViews.get(groupId);
      const sourceGroup = layout.groups[groupId];
      if (!referenceView || !sourceGroup) {
        return null;
      }
      const newGroupId = seed?.groupId ?? generateId('group');
      if (layout.leafViews.has(newGroupId)) {
        return null; // Seeded group ids must be unique within the layout.
      }
      if (
        seed !== undefined &&
        refusesChatDestination(layout, seed, 'new-group')
      ) {
        return null; // A restricted chat never seeds a split.
      }
      if (seed !== undefined && isPanelKindExcluded(worktreeKey, seed.kind)) {
        return null;
      }

      const activate = options?.activate !== false;
      const work = startWork(layout);
      if (activate && sourceGroup.collapsed !== undefined) {
        expandGroupInWork(work.grid, work, groupId);
      }
      const newView = createLeafView(newGroupId);
      // addView exits any maximized state itself (engine behavior); the
      // commit reconciles maximizedGroupId.
      work.grid.addView(
        newView,
        Sizing.Split,
        referenceView,
        splitDirectionToGridDirection(direction),
      );
      work.leafViews.set(newGroupId, newView);
      if (!activate && layout.maximizedGroupId !== null) {
        const maximized = work.leafViews.get(layout.maximizedGroupId);
        if (maximized !== undefined) work.grid.maximizeView(maximized);
      }

      // Per-entity split decision: an unseeded split creates an EMPTY group
      // (cloning the active tab would duplicate an entity binding); an
      // explicit seed creates one fresh tab of its kind. Seeded splits do
      // NOT enforce family instance-key uniqueness — deterministic builders
      // (default layout) own their seeds; interactive creation goes through
      // `addTab`, which does enforce it.
      const seedChatScope =
        seed === undefined
          ? undefined
          : splitSeedChatScope(layout, worktreeKey, sourceGroup, seed);
      const tabs: PanelTabDescriptor[] = seed
        ? [
            {
              panelId: seed.panelId ?? generateId('panel'),
              kind: seed.kind,
              ...(seed.title !== undefined ? { title: seed.title } : {}),
              ...(seed.instance !== undefined
                ? { instance: seed.instance }
                : {}),
              ...(seedChatScope !== undefined
                ? { chatScope: seedChatScope }
                : {}),
            },
          ]
        : [];
      work.groups[newGroupId] = {
        tabs,
        activePanelId: tabs.length > 0 ? tabs[0].panelId : null,
      };
      work.revision += 1;
      if (activate) workFocusGroup(work, newGroupId);

      commitWork(worktreeKey, work);
      return newGroupId;
    },

    addTab: (worktreeKey, requestedGroupId, kind, opts): string | null => {
      // Browser WebContentsViews are positioned relative to the main window
      // and therefore may never be hosted by an auxiliary-window layout.
      if (kind === 'browser' && isAuxPanelLayoutKey(worktreeKey)) {
        return null;
      }
      if (isPanelKindExcluded(worktreeKey, kind)) {
        return null;
      }
      // A restricted chat lands in the chat group, whichever group asked.
      const chatGroupId =
        kind === 'chat'
          ? restrictedChatGroupId(get().layouts[worktreeKey])
          : null;
      const groupId = chatGroupId ?? requestedGroupId;
      if (hasFixedTopology(worktreeKey)) {
        const isFlexibleMinimalGroup =
          groupId === 'group-extras' || groupId === 'group-terminal';
        const isChatInChatGroup = groupId === 'group-chat' && kind === 'chat';
        if (!isFlexibleMinimalGroup && !isChatInChatGroup) {
          return null;
        }
      }
      const layouts = get().layouts;
      const layout = layouts[worktreeKey];
      const group = layout?.groups[groupId];
      if (!layout || !group) {
        return null;
      }
      if (!satisfiesInstanceContract(kind, opts?.instance)) {
        return null;
      }
      const familyKeys = collectFamilyLayoutKeys(layouts, worktreeKey);
      const panelId = opts?.panelId ?? generateId('panel');
      if (familyHasPanelId(layouts, familyKeys, panelId)) {
        return null; // Seeded panel ids must be unique within the family.
      }

      const chatScope =
        !isChatScopedPanelKind(kind) || opts?.chatScope === null
          ? undefined
          : (opts?.chatScope ?? layout.chatScope?.activeChatTabId);
      const newTab: PanelTabDescriptor = {
        panelId,
        kind,
        ...(opts?.title !== undefined ? { title: opts.title } : {}),
        ...(opts?.instance !== undefined ? { instance: opts.instance } : {}),
        ...(chatScope !== undefined ? { chatScope } : {}),
      };
      // Per-entity uniqueness: a tab bound to the same entity (or a second
      // singleton of the same kind) must not open twice anywhere in the
      // worktree's layout family.
      if (
        familyHasInstanceKey(layouts, familyKeys, getPanelInstanceKey(newTab))
      ) {
        return null;
      }

      const work = startWork(layout);
      const activate = opts?.activate !== false;
      if (chatGroupId !== null) {
        workRouteChatsToChatGroup(
          work,
          chatGroupId,
          [newTab],
          activate ? panelId : null,
          hasFixedTopology(worktreeKey),
        );
        commitWork(worktreeKey, work);
        return panelId;
      }
      if (activate && group.collapsed !== undefined) {
        expandGroupInWork(work.grid, work, groupId);
      }
      const targetGroup = work.groups[groupId] ?? group;
      work.groups[groupId] = {
        ...targetGroup,
        tabs: [...group.tabs, newTab],
        activePanelId:
          activate || group.activePanelId === null
            ? panelId
            : group.activePanelId,
      };
      if (activate) {
        workFocusGroup(work, groupId);
      }
      commitWork(worktreeKey, work);
      return panelId;
    },

    updateTabInstanceTitle: (worktreeKey, panelId, title): void => {
      const layouts = get().layouts;
      // The panel may live in an aux layout of the worktree's family (the
      // sync bridge addresses panels by worktree, not by layout).
      for (const layoutKey of collectFamilyLayoutKeys(layouts, worktreeKey)) {
        const layout = layouts[layoutKey];
        if (!layout) continue;
        for (const [groupId, groupState] of Object.entries(layout.groups)) {
          const tab = groupState.tabs.find(
            (candidate) => candidate.panelId === panelId,
          );
          if (!tab) continue;
          if (tab.title === title) {
            return; // No-op when unchanged.
          }
          const work = startWork(layout);
          work.groups[groupId] = {
            ...groupState,
            tabs: groupState.tabs.map((candidate) =>
              candidate.panelId === panelId
                ? { ...candidate, title }
                : candidate,
            ),
          };
          commitWork(layoutKey, work);
          return;
        }
      }
    },

    closeGroup: (worktreeKey, groupId): boolean => {
      if (hasFixedTopology(worktreeKey)) return false;
      const layout = get().layouts[worktreeKey];
      if (!layout) {
        return false;
      }
      const group = layout.groups[groupId];
      const isHidden =
        group === undefined
          ? (): boolean => false
          : groupHiddenTabPredicate(group, layout.chatScope);
      const protectedTabs =
        group?.tabs.filter((tab) => isCloseProtectedTab(worktreeKey, tab)) ??
        [];
      if (group && protectedTabs.length > 0) {
        // A busy chat keeps its group. Other chats' hidden content stays too;
        // close only the unprotected, shown tabs.
        const protectedIds = new Set(protectedTabs.map((tab) => tab.panelId));
        const closeIds = group.tabs
          .filter((tab) => !protectedIds.has(tab.panelId) && !isHidden(tab))
          .map((tab) => tab.panelId);
        if (closeIds.length > 0) {
          const work = startWork(layout);
          for (const panelId of closeIds) {
            workDetachTab(
              work,
              groupId,
              panelId,
              keepsEmptyGroups(worktreeKey),
            );
          }
          commitWork(worktreeKey, work);
        }
        return false;
      }
      const work = startWork(layout);
      const hiddenTabs = group?.tabs.filter(isHidden) ?? [];
      const remainingGroupIds = collectLeafOrder(work.grid).filter(
        (id) => id !== groupId,
      );
      const receivingGroupId =
        remainingGroupIds.find(
          (id) => !work.groups[id].tabs.some((tab) => tab.kind === 'chat'),
        ) ?? remainingGroupIds[0];
      if (hiddenTabs.length > 0 && receivingGroupId !== undefined) {
        // Closing a group closes this chat's tabs, not another chat's work.
        // Prefer a content group so the retained tabs stay hidden; keep their
        // ownership and the receiving group's selection unchanged.
        const receiving = work.groups[receivingGroupId];
        work.groups[receivingGroupId] = {
          ...receiving,
          tabs: partitionTabsByPinned([...receiving.tabs, ...hiddenTabs]),
        };
      }
      if (!workRemoveGroup(work, groupId)) {
        return false;
      }
      expandStaleCollapsesInWork(work);
      commitWork(worktreeKey, work);
      return true;
    },

    selectTab: (worktreeKey, groupId, panelId, options): void => {
      const layout = get().layouts[worktreeKey];
      const group = layout?.groups[groupId];
      if (!layout || !group) {
        return;
      }
      if (!group.tabs.some((tab) => tab.panelId === panelId)) {
        return;
      }

      const work = startWork(layout);
      work.groups[groupId] = {
        ...adoptIntoSelectedChat(layout, group, panelId),
        activePanelId: panelId,
      };
      if (options?.focus !== false) {
        workFocusGroup(work, groupId);
      }
      commitWork(worktreeKey, work);
    },

    reorderTab: (worktreeKey, groupId, panelId, toIndex): void => {
      const layout = get().layouts[worktreeKey];
      const group = layout?.groups[groupId];
      if (!layout || !group) {
        return;
      }
      const fromIndex = group.tabs.findIndex((tab) => tab.panelId === panelId);
      if (fromIndex === -1) {
        return;
      }

      const tabs = [...group.tabs];
      const [movedTab] = tabs.splice(fromIndex, 1);
      // Clamp the target index to the dragged tab's OWN partition so a reorder
      // can never cross the pinned/unpinned boundary in the array (pinned tabs
      // occupy `[0, pinnedCount)`, unpinned `[pinnedCount, end]`). A tab
      // dragged over the other partition's strip therefore lands at the
      // boundary of its own partition instead of repinning/unpinning it.
      const pinnedCount = tabs.filter((tab) => tab.pinned === true).length;
      const [lowerBound, upperBound] =
        movedTab.pinned === true
          ? [0, pinnedCount]
          : [pinnedCount, tabs.length];
      const clampedIndex = Math.max(
        lowerBound,
        Math.min(Math.trunc(toIndex), upperBound),
      );
      if (clampedIndex === fromIndex) {
        return;
      }
      tabs.splice(clampedIndex, 0, movedTab);

      const work = startWork(layout);
      work.groups[groupId] = { ...group, tabs };
      workFocusGroup(work, groupId);
      commitWork(worktreeKey, work);
    },

    replaceTab: (worktreeKey, groupId, panelId, replacement): boolean => {
      const layouts = get().layouts;
      const layout = layouts[worktreeKey];
      const group = layout?.groups[groupId];
      if (!layout || !group) {
        return false;
      }
      const tabIndex = group.tabs.findIndex((tab) => tab.panelId === panelId);
      if (tabIndex === -1) {
        return false;
      }
      if (
        refusesChatDestination(layout, replacement, {
          groupId,
          edge: 'center',
        })
      ) {
        return false; // A restricted chat only lands in the chat group.
      }

      const familyKeys = collectFamilyLayoutKeys(layouts, worktreeKey);
      if (
        replacement.panelId !== panelId &&
        familyHasPanelId(layouts, familyKeys, replacement.panelId)
      ) {
        return false;
      }
      const replacementInstanceKey = getPanelInstanceKey(replacement);
      for (const familyKey of familyKeys) {
        const familyLayout = layouts[familyKey];
        if (!familyLayout) continue;
        for (const familyGroup of Object.values(familyLayout.groups)) {
          for (const familyTab of familyGroup.tabs) {
            if (familyTab.panelId === panelId) continue;
            if (getPanelInstanceKey(familyTab) === replacementInstanceKey) {
              return false;
            }
          }
        }
      }

      const previous = group.tabs[tabIndex];
      const tabs = [...group.tabs];
      // A replacement opens for the same chat as the tab it replaces.
      const chatScope = isChatScopedPanelKind(replacement.kind)
        ? (replacement.chatScope ?? previous.chatScope)
        : undefined;
      tabs[tabIndex] = {
        ...replacement,
        ...(previous.pinned === true ? { pinned: true } : {}),
        ...(chatScope !== undefined ? { chatScope } : {}),
      };
      const work = startWork(layout);
      work.groups[groupId] = {
        ...group,
        tabs,
        activePanelId:
          group.activePanelId === panelId
            ? replacement.panelId
            : group.activePanelId,
      };
      commitWork(worktreeKey, work);
      return true;
    },

    closeTab: (worktreeKey, groupId, panelId): void => {
      const layout = get().layouts[worktreeKey];
      const group = layout?.groups[groupId];
      if (!layout || !group) {
        return;
      }
      if (
        group.tabs.some(
          (tab) =>
            tab.panelId === panelId && isFixedSidePanelTab(worktreeKey, tab),
        )
      ) {
        return;
      }
      if (
        hasFixedTopology(worktreeKey) &&
        groupId !== 'group-extras' &&
        groupId !== 'group-terminal' &&
        group.tabs.length === 1
      ) {
        return;
      }
      if (!group.tabs.some((tab) => tab.panelId === panelId)) {
        return;
      }

      const work = startWork(layout);
      if (
        workDetachTab(work, groupId, panelId, keepsEmptyGroups(worktreeKey))
      ) {
        expandStaleCollapsesInWork(work);
      }
      commitWork(worktreeKey, work);
    },

    closeTabs: (worktreeKey, groupId, panelIds): void => {
      const layout = get().layouts[worktreeKey];
      const group = layout?.groups[groupId];
      if (!layout || !group) {
        return;
      }
      const present = new Set(group.tabs.map((tab) => tab.panelId));
      const protectedIds = new Set(
        group.tabs
          .filter((tab) => isFixedSidePanelTab(worktreeKey, tab))
          .map((tab) => tab.panelId),
      );
      if (
        hasFixedTopology(worktreeKey) &&
        groupId !== 'group-extras' &&
        groupId !== 'group-terminal' &&
        panelIds.filter((id) => present.has(id) && !protectedIds.has(id))
          .length >=
          group.tabs.length - protectedIds.size
      ) {
        return;
      }
      const targetIds = panelIds.filter(
        (id) => present.has(id) && !protectedIds.has(id),
      );
      if (targetIds.length === 0) {
        return;
      }
      const work = startWork(layout);
      let removedGroup = false;
      for (const id of targetIds) {
        // Each detach re-reads work.groups and fixes up the active tab; once
        // the group is emptied/removed, later detaches for it no-op.
        if (workDetachTab(work, groupId, id, keepsEmptyGroups(worktreeKey))) {
          removedGroup = true;
        }
      }
      if (removedGroup) {
        expandStaleCollapsesInWork(work);
      }
      commitWork(worktreeKey, work);
    },

    setTabPinned: (worktreeKey, groupId, panelId, pinned): void => {
      // Pinning only reorders tabs within their group, so a fixed topology
      // (Minimal mode) allows it too.
      const layout = get().layouts[worktreeKey];
      const group = layout?.groups[groupId];
      if (!layout || !group) {
        return;
      }
      const current = group.tabs.find((tab) => tab.panelId === panelId);
      if (!current) {
        return;
      }
      if ((current.pinned === true) === pinned) {
        return; // Already in the requested state: no commit.
      }

      const updatedTab: PanelTabDescriptor = pinned
        ? { ...current, pinned: true }
        : {
            panelId: current.panelId,
            kind: current.kind,
            ...(current.title !== undefined ? { title: current.title } : {}),
            ...(current.instance !== undefined
              ? { instance: current.instance }
              : {}),
            ...(current.chatScope !== undefined
              ? { chatScope: current.chatScope }
              : {}),
          };
      const remaining = group.tabs.filter((tab) => tab.panelId !== panelId);
      // Boundary between the pinned prefix and unpinned suffix. Pinning lands
      // at the end of the pinned partition; unpinning lands at the start of the
      // unpinned partition. Both resolve to this same index.
      const insertIndex = remaining.filter((tab) => tab.pinned === true).length;
      const tabs = [...remaining];
      tabs.splice(insertIndex, 0, updatedTab);

      const work = startWork(layout);
      work.groups[groupId] = { ...group, tabs };
      commitWork(worktreeKey, work);
    },

    movePanel: (
      worktreeKey,
      panelId,
      targetGroupId,
      edge,
      targetIndex,
      options,
    ): boolean => {
      if (hasFixedTopology(worktreeKey)) return false;
      const layout = get().layouts[worktreeKey];
      if (!layout) {
        return false;
      }
      const plan = planPanelMove(layout, panelId, targetGroupId, edge);
      if (plan === null) {
        return false;
      }
      const { sourceGroupId, targetGroup, targetView } = plan;
      const activate = options?.activate !== false;
      // A drop the user sees lands in the selected chat, so it stays shown.
      const movedTab = activate
        ? adoptTabIntoSelectedChat(plan.movedTab, layout.chatScope)
        : plan.movedTab;
      if (
        !activate &&
        (edge !== 'center' ||
          sourceGroupId === targetGroupId ||
          layout.groups[sourceGroupId]?.activePanelId === panelId)
      ) {
        return false;
      }

      const work = startWork(layout);
      if (activate && targetGroup.collapsed !== undefined) {
        expandGroupInWork(work.grid, work, targetGroupId);
      }

      if (edge === 'center') {
        if (sourceGroupId === targetGroupId) {
          // Dropping onto its own group just activates the tab.
          work.groups[targetGroupId] = {
            ...adoptIntoSelectedChat(
              layout,
              work.groups[targetGroupId],
              panelId,
            ),
            activePanelId: panelId,
          };
          workFocusGroup(work, targetGroupId);
        } else {
          const tabs = [...targetGroup.tabs];
          const pinnedCount = tabs.filter((tab) => tab.pinned === true).length;
          const [lowerBound, upperBound] =
            movedTab.pinned === true
              ? [0, pinnedCount]
              : [pinnedCount, tabs.length];
          const defaultIndex =
            movedTab.pinned === true ? pinnedCount : tabs.length;
          const requestedIndex =
            targetIndex === undefined || !Number.isFinite(targetIndex)
              ? defaultIndex
              : Math.trunc(targetIndex);
          const clampedIndex = Math.max(
            lowerBound,
            Math.min(requestedIndex, upperBound),
          );
          tabs.splice(clampedIndex, 0, movedTab);

          work.groups[targetGroupId] = activate
            ? { tabs, activePanelId: movedTab.panelId }
            : { ...targetGroup, tabs };
          if (
            workDetachTab(
              work,
              sourceGroupId,
              panelId,
              keepsEmptyGroups(worktreeKey),
              layout.chatScope?.activeChatTabId,
            )
          ) {
            expandStaleCollapsesInWork(work);
          }
          if (activate) workFocusGroup(work, targetGroupId);
        }
        commitWork(worktreeKey, work);
        return true;
      }

      const newGroupId = generateId('group');
      const newView = createLeafView(newGroupId);
      work.grid.addView(
        newView,
        Sizing.Split,
        targetView,
        dropEdgeToDirection(edge),
      );
      work.leafViews.set(newGroupId, newView);
      work.groups[newGroupId] = {
        tabs: [movedTab],
        activePanelId: movedTab.panelId,
      };
      work.revision += 1;
      // With the new group added first, an emptied source group can always
      // be removed (the grid holds >= 2 views) — including source === target.
      if (
        workDetachTab(
          work,
          sourceGroupId,
          panelId,
          keepsEmptyGroups(worktreeKey),
          layout.chatScope?.activeChatTabId,
        )
      ) {
        expandStaleCollapsesInWork(work);
      }
      workFocusGroup(work, newGroupId);
      commitWork(worktreeKey, work);
      return true;
    },

    movePanelToRootEdge: (worktreeKey, panelId, edge): boolean => {
      if (hasFixedTopology(worktreeKey)) return false;
      const layout = get().layouts[worktreeKey];
      if (!layout) {
        return false;
      }
      const plan = planRootEdgeMove(layout, panelId, edge);
      if (!plan) {
        return false;
      }
      const {
        sourceGroupId,
        probe,
        requiredOrientation,
        insertAtStart,
        matched,
        axisTotal,
        newSize,
      } = plan;
      // The new edge group shows the moved tab, so it joins the selected chat.
      const movedTab = adoptTabIntoSelectedChat(
        plan.movedTab,
        layout.chatScope,
      );

      // Mirror movePanel/addView semantics: topology mutations exit any
      // maximized state — and the rebuild must serialize WITHOUT hidden/
      // maximized leaves so the transformed tree is canonical.
      const hadMaximized = layout.grid.hasMaximizedView();
      if (hadMaximized) {
        layout.grid.exitMaximizedView();
      }
      const engine = hadMaximized ? layout.grid.serialize() : probe;
      if (engine.root.type !== 'branch') {
        return false; // Unreachable: re-serialize preserves the branch root.
      }

      const newGroupId = generateId('group');
      const newLeaf: ISerializedNode = {
        type: 'leaf',
        data: { id: newGroupId },
        size: newSize,
      };

      let serialized: ISerializedGrid;
      if (matched) {
        // Same axis: splice the new leaf into the root branch at the edge
        // index, scaling the existing children into the remaining extent so
        // the new group lands at exactly `newSize`.
        const scale = (axisTotal - newSize) / axisTotal;
        const scaled: ISerializedNode[] = engine.root.data.map((child) => ({
          ...child,
          size: Math.max(1, Math.round(child.size * scale)),
        }));
        serialized = {
          root: {
            ...engine.root,
            expandedSizes: undefined,
            data: insertAtStart ? [newLeaf, ...scaled] : [...scaled, newLeaf],
          },
          orientation: engine.orientation,
          width: engine.width,
          height: engine.height,
        };
      } else {
        // Orthogonal axis: wrap — the old root becomes a branch child of a
        // new, flipped root whose only other child is the new leaf. A
        // single-child old root (always a lone leaf: the engine promotes a
        // single-BRANCH-child root's child to be the root) is inlined
        // directly to avoid creating a non-root single-child branch.
        const remainder = axisTotal - newSize;
        const wrapped: ISerializedNode =
          engine.root.data.length === 1
            ? { ...engine.root.data[0], size: remainder }
            : {
                type: 'branch',
                data: engine.root.data,
                size: remainder,
                ...(engine.root.expandedSizes !== undefined
                  ? { expandedSizes: engine.root.expandedSizes }
                  : {}),
              };
        serialized = {
          root: {
            type: 'branch',
            data: insertAtStart ? [newLeaf, wrapped] : [wrapped, newLeaf],
            // A root branch's `size` is its extent ORTHOGONAL to its own
            // stacking axis (engine serialization convention).
            size:
              requiredOrientation === Orientation.VERTICAL
                ? engine.width
                : engine.height,
          },
          orientation: requiredOrientation,
          width: engine.width,
          height: engine.height,
        };
      }

      const newView = createLeafView(newGroupId);
      const liveViews = new Map(layout.leafViews);
      liveViews.set(newGroupId, newView);
      let newGrid: SerializableGrid<PanelLeafView>;
      try {
        newGrid = SerializableGrid.deserialize(
          serialized,
          new LivePanelLeafDeserializer(liveViews),
        );
      } catch {
        // Unreachable by construction (every id in the transformed tree maps
        // to a live view); defensively drop the new view and bail.
        newView.dispose();
        return false;
      }
      // Same dimensions as the serialized tree, so recorded sizes apply
      // verbatim (no proportional rescale) and the new group gets `newSize`.
      newGrid.layout(engine.width, engine.height);

      const oldGrid = layout.grid;
      const work = startWork(layout);
      work.grid = newGrid;
      work.leafViews.set(newGroupId, newView);
      work.groups[newGroupId] = {
        tabs: [movedTab],
        activePanelId: movedTab.panelId,
      };
      work.maximizedGroupId = null;
      work.revision += 1;
      // With the new group added first, an emptied source group can always
      // be removed (the new grid holds >= 2 views).
      workDetachTab(
        work,
        sourceGroupId,
        panelId,
        keepsEmptyGroups(worktreeKey),
        layout.chatScope?.activeChatTabId,
      );
      // The grid was rebuilt (a root-edge insertion can shift adjacency for
      // OTHER already-collapsed leaves, not just the source group), so the
      // sweep always runs here — against `work.grid`, the NEW grid — rather
      // than only when the source group was removed.
      expandStaleCollapsesInWork(work);
      workFocusGroup(work, newGroupId);
      // Dispose the old grid only AFTER the new grid adopted the live leaf
      // elements (same ordering as restoreLayout). Leaf views are shared
      // with the new grid and intentionally NOT disposed.
      oldGrid.dispose();
      commitWork(worktreeKey, work);
      return true;
    },

    canMovePanel: (worktreeKey, panelId, targetGroupId, edge): boolean => {
      if (hasFixedTopology(worktreeKey)) return false;
      const layout = get().layouts[worktreeKey];
      return layout !== undefined
        ? planPanelMove(layout, panelId, targetGroupId, edge) !== null
        : false;
    },

    canMovePanelToRootEdge: (worktreeKey, panelId, edge): boolean => {
      const layout = get().layouts[worktreeKey];
      return layout !== undefined
        ? planRootEdgeMove(layout, panelId, edge) !== null
        : false;
    },

    focusGroup: (worktreeKey, groupId): void => {
      const layout = get().layouts[worktreeKey];
      if (!layout || !layout.groups[groupId]) {
        return;
      }
      if (
        layout.activeGroupId === groupId &&
        layout.mruGroupIds[0] === groupId
      ) {
        return;
      }
      const work = startWork(layout);
      workFocusGroup(work, groupId);
      commitWork(worktreeKey, work);
    },

    focusGroupInDirection: (worktreeKey, direction): string | null => {
      const layout = get().layouts[worktreeKey];
      if (!layout || layout.activeGroupId === null) {
        return null;
      }
      // With a maximized group only one group is visible; directional focus
      // has no spatial meaning until the layout is restored.
      if (layout.maximizedGroupId !== null) {
        return null;
      }
      const activeView = layout.leafViews.get(layout.activeGroupId);
      if (!activeView) {
        return null;
      }

      let neighbors: PanelLeafView[];
      try {
        neighbors = layout.grid.getNeighborViews(
          activeView,
          splitDirectionToGridDirection(direction),
        );
      } catch {
        // getNeighborViews throws before the grid's first layout.
        return null;
      }

      const candidateIds = neighbors
        .map((view) => view.id)
        .filter(
          (id) =>
            id !== layout.activeGroupId && layout.groups[id] !== undefined,
        );
      if (candidateIds.length === 0) {
        return null;
      }

      // MRU tiebreak among boundary neighbors (doc 04 focus pattern).
      let target = candidateIds[0];
      let bestRank = Number.POSITIVE_INFINITY;
      for (const id of candidateIds) {
        const rank = layout.mruGroupIds.indexOf(id);
        if (rank !== -1 && rank < bestRank) {
          bestRank = rank;
          target = id;
        }
      }

      get().focusGroup(worktreeKey, target);
      return target;
    },

    maximizeGroup: (worktreeKey, groupId, maximized): void => {
      const layout = get().layouts[worktreeKey];
      const view = layout?.leafViews.get(groupId);
      if (!layout || !view) {
        return;
      }

      if (maximized) {
        // The engine throws when maximizing with fewer than two views.
        if (layout.leafViews.size < 2) {
          return;
        }
        if (
          layout.maximizedGroupId === groupId &&
          layout.grid.hasMaximizedView()
        ) {
          return;
        }
        const work = startWork(layout);
        // A collapsed group is pinned to the bar size and cannot be
        // maximized as-is; expand it first (same transaction) so "Full
        // screen" from a collapsed group's overflow menu reads as
        // expand-then-maximize. Every overflow action except "Close all"
        // expands a collapsed group.
        if (layout.groups[groupId]?.collapsed !== undefined) {
          expandGroupInWork(work.grid, work, groupId);
        }
        layout.grid.setCollapsedViews(
          new Set<PanelLeafView>(),
          PANEL_COLLAPSED_BAR_SIZE,
        );
        layout.grid.maximizeView(view);
        work.maximizedGroupId = groupId;
        work.revision += 1;
        workFocusGroup(work, groupId);
        commitWork(worktreeKey, work);
        return;
      }

      if (
        layout.maximizedGroupId !== groupId ||
        !layout.grid.hasMaximizedView()
      ) {
        return;
      }
      layout.grid.exitMaximizedView();
      if (hasFixedTopology(worktreeKey)) {
        for (const [collapsedGroupId, group] of Object.entries(layout.groups)) {
          if (group.collapsed === undefined) continue;
          const collapsedView = layout.leafViews.get(collapsedGroupId);
          if (collapsedView !== undefined) {
            layout.grid.setViewVisible(collapsedView, false);
          }
        }
      }
      const work = startWork(layout);
      work.maximizedGroupId = null;
      work.revision += 1;
      commitWork(worktreeKey, work);
    },

    collapseGroup: (worktreeKey, groupId, options): boolean => {
      const layout = get().layouts[worktreeKey];
      const view = layout?.leafViews.get(groupId);
      const group = layout?.groups[groupId];
      if (!layout || !view || group === undefined) {
        return false;
      }
      if (layout.maximizedGroupId !== null || group.collapsed !== undefined) {
        return false;
      }
      const snapshot = buildLayoutCollapseSnapshot(layout.grid, layout.groups);
      if (snapshot === null) {
        return false;
      }
      const affordance = getCollapseAffordance(snapshot, groupId);
      if (affordance.state !== 'enabled') {
        return false;
      }
      const edge = affordance.edge;
      const axis = collapseEdgeAxis(edge);
      const current = layout.grid.getViewSize(view);
      const expandedSize =
        axis === 'horizontal' ? current.width : current.height;
      const work = startWork(layout);
      work.groups[groupId] = {
        ...group,
        collapsed: {
          edge,
          expandedSize,
          ...(options?.auto === true ? { auto: true } : {}),
        },
      };
      if (!hasFixedTopology(worktreeKey))
        // Capture the containing splits before any leaf gives its space away.
        syncCollapsedBranches(
          layout.grid,
          work.groups,
          work.leafViews,
          affordance.branchEdge !== undefined,
          true,
        );
      const siblingId = getInnerCollapseSibling(snapshot, groupId, edge);
      const sibling =
        siblingId === null ? undefined : layout.leafViews.get(siblingId);
      if (affordance.branchEdge !== undefined) {
        // The containing branch now owns sizing; keep the descendant state only.
      } else if (sibling !== undefined) {
        resizeInnerCollapsedGroup(
          layout.grid,
          view,
          sibling,
          edge,
          PANEL_COLLAPSED_BAR_SIZE,
          true,
        );
      } else {
        if (axis === 'horizontal') {
          view.setConstraints({
            minimumWidth: PANEL_COLLAPSED_BAR_SIZE,
            maximumWidth: PANEL_COLLAPSED_BAR_SIZE,
          });
        } else {
          view.setConstraints({
            minimumHeight: PANEL_COLLAPSED_BAR_SIZE,
            maximumHeight: PANEL_COLLAPSED_BAR_SIZE,
          });
        }
        layout.grid.resizeView(view, {
          width:
            axis === 'horizontal' ? PANEL_COLLAPSED_BAR_SIZE : current.width,
          height:
            axis === 'vertical' ? PANEL_COLLAPSED_BAR_SIZE : current.height,
        });
      }
      if (hasFixedTopology(worktreeKey)) {
        layout.grid.setViewVisible(view, false);
      }
      work.revision += 1;
      commitWork(worktreeKey, work);
      return true;
    },

    expandGroup: (worktreeKey, groupId, options): boolean => {
      const layout = get().layouts[worktreeKey];
      if (!layout || layout.groups[groupId]?.collapsed === undefined) {
        return false;
      }
      const work = startWork(layout);
      if (!expandGroupInWork(work.grid, work, groupId)) {
        return false;
      }
      const activatePanelId = options?.activatePanelId;
      if (activatePanelId !== undefined) {
        const group = work.groups[groupId];
        if (group.tabs.some((tab) => tab.panelId === activatePanelId)) {
          work.groups[groupId] = {
            ...adoptIntoSelectedChat(layout, group, activatePanelId),
            activePanelId: activatePanelId,
          };
        }
      }
      work.revision += 1;
      if (options?.focus !== false) {
        workFocusGroup(work, groupId);
      }
      commitWork(worktreeKey, work);
      return true;
    },

    ensureGroupExpanded: (worktreeKey, groupId, options): void => {
      const layout = get().layouts[worktreeKey];
      if (layout?.groups[groupId]?.collapsed !== undefined) {
        get().expandGroup(worktreeKey, groupId, options);
      }
    },

    arrangeGroups: (worktreeKey, arrangement): void => {
      if (arrangement !== 'even') {
        return;
      }
      const layout = get().layouts[worktreeKey];
      if (!layout) {
        return;
      }
      const work = startWork(layout);
      // Collapsed groups have no meaningful "even" share of the grid; expand
      // them all first, within this same work transaction, before computing
      // the even distribution.
      let expanded = false;
      for (const groupId of Object.keys(work.groups)) {
        if (
          work.groups[groupId]?.collapsed !== undefined &&
          expandGroupInWork(work.grid, work, groupId)
        ) {
          expanded = true;
        }
      }
      const hadMaximized = layout.grid.hasMaximizedView();
      const before = layout.grid.serialize();
      layout.grid.distributeViewSizes();
      const sizeChanged = hasSerializedGridChanged(
        before,
        layout.grid.serialize(),
      );
      if (hadMaximized) {
        // distributeViewSizes exits maximize; that is a visibility topology
        // change the host must re-render for.
        work.maximizedGroupId = null;
      }
      if (hadMaximized || expanded) {
        work.revision += 1;
        commitWork(worktreeKey, work);
      } else if (sizeChanged) {
        bumpLayoutSizeRevision(worktreeKey);
      }
    },

    layoutContainer: (worktreeKey, width, height): void => {
      const layout = get().layouts[worktreeKey];
      if (!layout || width <= 0 || height <= 0) {
        return;
      }
      const previousWidth = layout.grid.width;
      const previousHeight = layout.grid.height;
      const widthScale = previousWidth > 0 ? width / previousWidth : 1;
      const heightScale = previousHeight > 0 ? height / previousHeight : 1;
      // Expanded-size metadata does not affect the render projection. Prepare
      // a fresh groups record so selectors observe the metadata update while
      // resize frames keep the existing layout record and view-model identities.
      const scaledGroups = scaleCollapsedGroupRestoreSizes(
        layout.groups,
        widthScale,
        heightScale,
      );
      const collapsedSizeChanged = scaledGroups !== layout.groups;
      const before = layout.grid.serialize();
      layout.grid.layout(width, height);
      if (
        collapsedSizeChanged ||
        hasSerializedGridChanged(before, layout.grid.serialize())
      ) {
        set((state) => {
          const currentLayout = state.layouts[worktreeKey];
          if (collapsedSizeChanged && currentLayout === layout) {
            Object.assign(currentLayout, { groups: scaledGroups });
          }
          return {
            layoutSizeRevisions: {
              ...state.layoutSizeRevisions,
              [worktreeKey]: (state.layoutSizeRevisions[worktreeKey] ?? 0) + 1,
            },
          };
        });
      }
    },

    resizeGroup: (worktreeKey, groupId, size): void => {
      const layout = get().layouts[worktreeKey];
      const view = layout?.leafViews.get(groupId);
      if (!layout || !view) {
        return;
      }
      const hadMaximized = layout.grid.hasMaximizedView();
      const before = layout.grid.serialize();
      layout.grid.resizeView(view, size, true);
      const sizeChanged = hasSerializedGridChanged(
        before,
        layout.grid.serialize(),
      );
      if (hadMaximized && !layout.grid.hasMaximizedView()) {
        const work = startWork(layout);
        work.maximizedGroupId = null;
        work.revision += 1;
        commitWork(worktreeKey, work);
      } else if (sizeChanged) {
        bumpLayoutSizeRevision(worktreeKey);
      }
    },

    serializeLayout: (worktreeKey): SerializablePanelLayoutFile | null => {
      const layout = get().layouts[worktreeKey];
      if (!layout || layout.activeGroupId === null) {
        return null;
      }

      const engine = layout.grid.serialize();
      const root = engineNodeToProtocolNode(engine.root, layout.groups);
      if (!root) {
        return null;
      }
      // Orientation passes through numerically for engine serialized-grid
      // parity (engine Orientation.VERTICAL = 0, HORIZONTAL = 1).
      const orientation: 0 | 1 =
        engine.orientation === Orientation.VERTICAL ? 0 : 1;

      return {
        version: PANEL_LAYOUT_FILE_VERSION,
        grid: {
          root,
          orientation,
          width: engine.width,
          height: engine.height,
        },
        activeGroupId: layout.activeGroupId,
        mostRecentActiveGroupIds: [...layout.mruGroupIds],
      };
    },

    restoreLayout: (worktreeKey, file, containerSize): boolean => {
      const migrated = migratePanelLayout(file);
      if (!migrated) {
        return false;
      }

      const restoredWidth = containerSize?.width ?? migrated.grid.width;
      const restoredHeight = containerSize?.height ?? migrated.grid.height;
      const widthScale =
        migrated.grid.width > 0 && restoredWidth > 0
          ? restoredWidth / migrated.grid.width
          : 1;
      const heightScale =
        migrated.grid.height > 0 && restoredHeight > 0
          ? restoredHeight / migrated.grid.height
          : 1;

      // Rebuild group metadata from the persisted leaves, rejecting
      // duplicate group/panel ids — and duplicate instance keys — anywhere
      // in the tree, plus entity-bound tabs missing their required instance
      // binding (the legacy-layout fallback trigger: pre-instance kind-only
      // files fail here and the caller builds the new default layout).
      const leaves: ISerializedPanelLeafNode[] = [];
      collectProtocolLeaves(migrated.grid.root, leaves);
      if (leaves.length === 0) {
        return false;
      }
      const groups: Record<string, PanelGroupState> = {};
      // Collected but not yet trusted: a persisted `collapsed` claim is only
      // applied after `planRestoredCollapses` re-derives eligibility against
      // the restored geometry (a claim whose tree no longer supports it
      // silently drops — degrade to expanded, never break the layout).
      const requestedCollapses = new Map<string, PanelCollapsedState>();
      const seenPanelIds = new Set<string>();
      const seenInstanceKeys = new Set<string>();
      // `pipeline-execution` / `subagent-chat` restore rules, scoped to those
      // kinds (every other kind keeps the reject-the-file checks below): a
      // tab that fails its binding contract, or whose run/subagent is already
      // bound earlier in this file or in ANOTHER live layout of this
      // worktree's family, is dropped and the rest of the file restores.
      //
      // Why the family check lives here rather than in the protocol or the
      // persistence bridge: main and popped-out layouts restore separately.
      // The bridge (`ensureWorktreePanelLayout`) restores the main grid first
      // and only then hands each `poppedOut` entry, in file order, to
      // `panelWindowsStore.restorePoppedWindow`, which rebuilds that window
      // through this same action under its own `#aux:` key. This is the only
      // point that sees both sides, and that ordering makes "keep the first"
      // mean "main layout first, then windows in file order". (The protocol's
      // `migratePanelLayout` above already drops malformed bindings; the
      // contract check below restates that rule as defense in depth.)
      const otherFamilyBoundKeys = collectOtherFamilyDroppableBoundKeys(
        get().layouts,
        worktreeKey,
      );
      // Kinds this layout's scope can't serve are dropped, so no restore,
      // default or layout conversion brings one back.
      const scopeExcluded = scopeExcludedKinds?.(worktreeKey);
      for (const leaf of leaves) {
        if (groups[leaf.groupId] !== undefined) {
          return false;
        }
        const tabs: PanelTabDescriptor[] = [];
        for (const panel of leaf.panels) {
          if (scopeExcluded?.has(panel.kind) === true) {
            continue;
          }
          if (DROPPABLE_BOUND_PANEL_KINDS.has(panel.kind)) {
            const boundKey = getPanelInstanceKey(panel);
            if (
              !satisfiesInstanceContract(panel.kind, panel.instance) ||
              seenInstanceKeys.has(boundKey) ||
              otherFamilyBoundKeys.has(boundKey)
            ) {
              continue;
            }
          }
          if (seenPanelIds.has(panel.panelId)) {
            return false;
          }
          seenPanelIds.add(panel.panelId);
          if (!satisfiesInstanceContract(panel.kind, panel.instance)) {
            return false;
          }
          // Singleton kinds take no binding: accept the file, drop the data.
          const instance = isSingletonPanelKind(panel.kind)
            ? undefined
            : panel.instance;
          const descriptor: PanelTabDescriptor = {
            panelId: panel.panelId,
            kind: panel.kind,
            // Rehydrate the persisted instance title; clamp defensively (a
            // hand-edited file may exceed the cap — validation accepts it).
            ...(panel.title !== undefined
              ? { title: clampPanelTitle(panel.title) }
              : {}),
            ...(instance !== undefined ? { instance } : {}),
            ...(panel.pinned === true ? { pinned: true } : {}),
            ...(panel.chatScope !== undefined &&
            panel.chatScope.length > 0 &&
            isChatScopedPanelKind(panel.kind)
              ? { chatScope: panel.chatScope }
              : {}),
          };
          const instanceKey = getPanelInstanceKey(descriptor);
          if (seenInstanceKeys.has(instanceKey)) {
            return false;
          }
          seenInstanceKeys.add(instanceKey);
          tabs.push(descriptor);
        }
        // Normalize referential integrity: activePanelId must be a tab.
        const activePanelId =
          leaf.activePanelId !== null &&
          tabs.some((tab) => tab.panelId === leaf.activePanelId)
            ? leaf.activePanelId
            : (tabs[0]?.panelId ?? null);
        // Enforce the pinned-prefix invariant on read, so a hand-edited file
        // whose tabs interleave partitions still restores to a canonical order.
        groups[leaf.groupId] = {
          tabs: partitionTabsByPinned(tabs),
          activePanelId,
        };
        if (leaf.collapsed !== undefined) {
          requestedCollapses.set(
            leaf.groupId,
            scaleCollapsedExpandedSize(leaf.collapsed, widthScale, heightScale),
          );
        }
      }

      const orientation =
        migrated.grid.orientation === 0
          ? Orientation.VERTICAL
          : Orientation.HORIZONTAL;
      const engineRoot = protocolNodeToEngineNode(
        migrated.grid.root,
        migrated.grid.orientation,
      );
      // The engine requires a branch root; wrap a bare-leaf root file.
      const root: ISerializedNode =
        engineRoot.type === 'branch'
          ? engineRoot
          : {
              type: 'branch',
              data: [engineRoot],
              size:
                orientation === Orientation.VERTICAL
                  ? migrated.grid.width
                  : migrated.grid.height,
            };
      const serialized: ISerializedGrid = {
        root,
        orientation,
        width: migrated.grid.width,
        height: migrated.grid.height,
      };

      const deserializer = new RestoredPanelLeafDeserializer(
        new Set(Object.keys(groups)),
      );
      let grid: SerializableGrid<PanelLeafView>;
      try {
        grid = SerializableGrid.deserialize(serialized, deserializer);
      } catch {
        deserializer.disposeAll();
        return false;
      }
      if (deserializer.views.size !== leaves.length) {
        grid.dispose();
        deserializer.disposeAll();
        return false;
      }

      grid.layout(restoredWidth, restoredHeight);

      // Wholesale rebuild: dispose the previous grid only after the new one
      // is fully built, so a corrupt file never destroys live state.
      const previous = get().layouts[worktreeKey];
      if (previous) {
        disposeLayoutRecord(previous);
      }

      const leafOrder = collectLeafOrder(grid);

      // Replay persisted collapse claims against the RESTORED geometry, in
      // leaf order, via the same eligibility algorithm live collapse uses.
      // Structurally stale claims (e.g. two leaves both claiming collapsed,
      // or a claim whose parent/adjacency no longer qualifies) silently drop
      // — degrade to expanded, never break the layout. Skipped entirely
      // under maximize: geometry is degenerate (only one leaf visible/sized)
      // so eligibility cannot be evaluated meaningfully.
      if (!grid.hasMaximizedView()) {
        const requestedEdges = new Map<string, PanelCollapseEdge>();
        for (const groupId of leafOrder) {
          const claim = requestedCollapses.get(groupId);
          if (claim !== undefined) {
            requestedEdges.set(groupId, claim.edge);
          }
        }
        const collapseSnapshot = buildLayoutCollapseSnapshot(grid, groups);
        const acceptedEdges =
          collapseSnapshot !== null
            ? planRestoredCollapses(collapseSnapshot, requestedEdges)
            : new Map<string, PanelCollapseEdge>();
        acceptedEdges.forEach((_edge, groupId) => {
          const claim = requestedCollapses.get(groupId);
          if (claim !== undefined)
            groups[groupId] = { ...groups[groupId], collapsed: claim };
        });
        if (!hasFixedTopology(worktreeKey))
          syncCollapsedBranches(grid, groups, deserializer.views);
        acceptedEdges.forEach((edge, groupId) => {
          const claim = requestedCollapses.get(groupId);
          const view = deserializer.views.get(groupId);
          const group = groups[groupId];
          if (
            claim === undefined ||
            view === undefined ||
            group === undefined
          ) {
            return;
          }
          groups[groupId] = { ...group, collapsed: claim };
          grid.setViewVisible(view, !hasFixedTopology(worktreeKey));
          if (collapseEdgeAxis(edge) === 'horizontal') {
            view.setConstraints({
              minimumWidth: PANEL_COLLAPSED_BAR_SIZE,
              maximumWidth: PANEL_COLLAPSED_BAR_SIZE,
            });
          } else {
            view.setConstraints({
              minimumHeight: PANEL_COLLAPSED_BAR_SIZE,
              maximumHeight: PANEL_COLLAPSED_BAR_SIZE,
            });
          }
        });
      }

      const activeGroupId =
        groups[migrated.activeGroupId] !== undefined
          ? migrated.activeGroupId
          : (leafOrder[0] ?? null);
      let mruGroupIds = migrated.mostRecentActiveGroupIds.filter(
        (id, index, all) =>
          groups[id] !== undefined && all.indexOf(id) === index,
      );
      for (const id of leafOrder) {
        if (!mruGroupIds.includes(id)) {
          mruGroupIds.push(id);
        }
      }
      if (activeGroupId !== null) {
        mruGroupIds = focusMru(mruGroupIds, activeGroupId);
      }
      const maximizedGroupId = grid.hasMaximizedView()
        ? (leaves.find((leaf) => leaf.maximized === true)?.groupId ?? null)
        : null;

      commitWork(worktreeKey, {
        grid,
        leafViews: deserializer.views,
        groups,
        activeGroupId,
        mruGroupIds,
        maximizedGroupId,
        revision: (previous?.revision ?? 0) + 1,
      });
      return true;
    },

    disposeLayout: (worktreeKey): void => {
      const layout = get().layouts[worktreeKey];
      if (!layout) {
        return;
      }
      disposeLayoutRecord(layout);
      removeGridSashChangeSubscription(worktreeKey);
      set((state) => {
        const layouts = { ...state.layouts };
        const layoutSizeRevisions = { ...state.layoutSizeRevisions };
        delete layouts[worktreeKey];
        delete layoutSizeRevisions[worktreeKey];
        return { layouts, layoutSizeRevisions };
      });
    },

    extractGroupToLayout: (worktreeKey, groupId, targetLayoutKey): boolean => {
      if (hasFixedTopology(worktreeKey)) return false;
      const source = get().layouts[worktreeKey];
      if (
        !source ||
        worktreeKey === targetLayoutKey ||
        get().layouts[targetLayoutKey] !== undefined
      ) {
        return false;
      }
      const group = source.groups[groupId];
      if (!group || !source.leafViews.get(groupId)) {
        return false;
      }
      // The source grid must keep at least one view (engine invariant), so
      // the last remaining group cannot be extracted.
      if (source.leafViews.size < 2) {
        return false;
      }

      // Remove the group from the SOURCE first (this is the only step that
      // can fail), then build the target layout around the moved tabs. The
      // target leaf reuses the same groupId, so chrome/test ids stay stable
      // across the pull-out.
      const sourceWork = startWork(source);
      if (!workRemoveGroup(sourceWork, groupId)) {
        return false;
      }
      // The extracted leaf's removal can promote/re-adjacent surviving
      // source-layout leaves (same staleness as closeGroup).
      expandStaleCollapsesInWork(sourceWork);

      const targetView = createLeafView(groupId);
      const targetLeafViews = new Map<string, PanelLeafView>([
        [groupId, targetView],
      ]);
      const targetGrid = SerializableGrid.from<PanelLeafView>({
        orientation: Orientation.HORIZONTAL,
        groups: [{ data: targetView }],
      });
      targetGrid.layout(DEFAULT_CONTAINER_WIDTH, DEFAULT_CONTAINER_HEIGHT);

      // The auxiliary record is committed next; include its chats now so
      // extracting them never drops their remembered content selection.
      commitWork(worktreeKey, sourceWork, { [groupId]: group });
      commitWork(targetLayoutKey, {
        grid: targetGrid,
        leafViews: targetLeafViews,
        groups: {
          [groupId]: {
            tabs: [...group.tabs],
            activePanelId: group.activePanelId,
          },
        },
        activeGroupId: groupId,
        mruGroupIds: [groupId],
        maximizedGroupId: null,
        revision: 1,
      });
      return true;
    },

    extractPanelToLayout: (
      worktreeKey,
      groupId,
      panelId,
      targetLayoutKey,
    ): boolean => {
      if (hasFixedTopology(worktreeKey)) return false;
      const source = get().layouts[worktreeKey];
      if (
        !source ||
        worktreeKey === targetLayoutKey ||
        get().layouts[targetLayoutKey] !== undefined
      ) {
        return false;
      }
      const group = source.groups[groupId];
      const tab = group?.tabs.find((entry) => entry.panelId === panelId);
      if (!group || !tab) {
        return false;
      }

      const sourceWork = startWork(source);
      // A single-tab pop-out leaves its source leaf as an empty panel group.
      // This preserves the exact grid slot so merge-back can restore the tab
      // without guessing at topology or attaching it to an unrelated group.
      if (group.tabs.length === 1) {
        if (group.collapsed !== undefined) {
          expandGroupInWork(sourceWork.grid, sourceWork, groupId);
        }
        sourceWork.groups[groupId] = { tabs: [], activePanelId: null };
      } else {
        workDetachTab(sourceWork, groupId, panelId);
      }

      const auxGroupId = generateId('group');
      const targetView = createLeafView(auxGroupId);
      const targetGrid = SerializableGrid.from<PanelLeafView>({
        orientation: Orientation.HORIZONTAL,
        groups: [{ data: targetView }],
      });
      targetGrid.layout(DEFAULT_CONTAINER_WIDTH, DEFAULT_CONTAINER_HEIGHT);

      commitWork(worktreeKey, sourceWork, {
        [auxGroupId]: { tabs: [tab], activePanelId: panelId },
      });
      commitWork(targetLayoutKey, {
        grid: targetGrid,
        leafViews: new Map([[auxGroupId, targetView]]),
        groups: {
          [auxGroupId]: { tabs: [tab], activePanelId: panelId },
        },
        activeGroupId: auxGroupId,
        mruGroupIds: [auxGroupId],
        maximizedGroupId: null,
        revision: 1,
      });
      return true;
    },

    adoptLayoutTabs: (sourceLayoutKey, targetLayoutKey, options): boolean => {
      if (sourceLayoutKey === targetLayoutKey) {
        return false;
      }
      const source = get().layouts[sourceLayoutKey];
      const target = get().layouts[targetLayoutKey];
      if (!source || !target) {
        return false;
      }

      // Receiving group: most-recently-active (matching close-focus
      // semantics), falling back to leaf order.
      let targetGroupId =
        options?.preferredGroupId !== undefined &&
        target.groups[options.preferredGroupId] !== undefined
          ? options.preferredGroupId
          : (target.mruGroupIds.find((id) => target.groups[id] !== undefined) ??
            collectLeafOrder(target.grid).find(
              (id) => target.groups[id] !== undefined,
            ));
      if (targetGroupId === undefined) {
        return false;
      }

      // Collision scope: the TARGET's whole layout family minus the source
      // layout itself (the source is being consumed, so its own tabs must
      // not count as "already open" — during merge-back the aux source is
      // part of the same family as the target main layout).
      const layouts = get().layouts;
      const collisionScopeKeys = collectFamilyLayoutKeys(
        layouts,
        targetLayoutKey,
      ).filter((key) => key !== sourceLayoutKey);
      const existingPanelIds = new Set(
        collisionScopeKeys.flatMap((key) =>
          Object.values(layouts[key]?.groups ?? {}).flatMap((groupState) =>
            groupState.tabs.map((tab) => tab.panelId),
          ),
        ),
      );
      const existingInstanceKeys = new Set(
        collisionScopeKeys.flatMap((key) =>
          Object.values(layouts[key]?.groups ?? {}).flatMap((groupState) =>
            groupState.tabs.map((tab) => getPanelInstanceKey(tab)),
          ),
        ),
      );
      const adopted: PanelTabDescriptor[] = [];
      for (const sourceGroupId of collectLeafOrder(source.grid)) {
        for (const tab of source.groups[sourceGroupId]?.tabs ?? []) {
          const instanceKey = getPanelInstanceKey(tab);
          if (
            !existingPanelIds.has(tab.panelId) &&
            !existingInstanceKeys.has(instanceKey)
          ) {
            existingPanelIds.add(tab.panelId);
            existingInstanceKeys.add(instanceKey);
            adopted.push(tab);
          }
        }
      }
      const sourceActivePanelId =
        source.activeGroupId !== null
          ? (source.groups[source.activeGroupId]?.activePanelId ?? null)
          : null;

      const work = startWork(target);
      const preferredGroupId = options?.preferredGroupId;
      const anchorGroupId = options?.fallbackAnchorGroupId;
      const fallbackDirection = options?.fallbackDirection;
      const fallbackSize = options?.fallbackSize;
      // Restricted chats return to the chat group, not the receiving one.
      const chatGroupId = restrictedChatGroupId(work);
      // A group recreated only to receive chats that go to the chat group
      // would stay behind empty, so it is not recreated.
      const onlyRoutedChats =
        chatGroupId !== null &&
        adopted.length > 0 &&
        adopted.every((tab) => tab.kind === 'chat');
      if (
        !onlyRoutedChats &&
        preferredGroupId !== undefined &&
        work.groups[preferredGroupId] === undefined &&
        anchorGroupId !== undefined &&
        fallbackDirection !== undefined
      ) {
        const anchorView = work.leafViews.get(anchorGroupId);
        if (anchorView !== undefined) {
          const restoredView = createLeafView(preferredGroupId);
          work.grid.addView(
            restoredView,
            fallbackSize !== undefined && fallbackSize > 0
              ? fallbackSize
              : Sizing.Split,
            anchorView,
            splitDirectionToGridDirection(fallbackDirection),
          );
          work.leafViews.set(preferredGroupId, restoredView);
          work.groups[preferredGroupId] = {
            tabs: [],
            activePanelId: null,
          };
          work.revision += 1;
          targetGroupId = preferredGroupId;
        }
      }
      // A collapsed receiving group must expand before adopting tabs —
      // merging via a fresh group object would drop the `collapsed` metadata
      // while the live view stayed pinned at the collapsed bar size
      // (metadata/engine divergence). Same pattern as addTab/movePanel/
      // splitGroup.
      if (work.groups[targetGroupId]?.collapsed !== undefined) {
        expandGroupInWork(work.grid, work, targetGroupId);
      }
      const adoptedChats =
        chatGroupId !== null
          ? adopted.filter((tab) => tab.kind === 'chat')
          : [];
      const adoptedHere = adopted.filter((tab) => !adoptedChats.includes(tab));
      const targetGroup = work.groups[targetGroupId];
      const activePanelId = adoptedHere.some(
        (tab) => tab.panelId === sourceActivePanelId,
      )
        ? sourceActivePanelId
        : (adoptedHere[0]?.panelId ?? targetGroup.activePanelId);
      work.groups[targetGroupId] = {
        // Keep the pinned prefix intact after adopting the source's tabs.
        tabs: partitionTabsByPinned([...targetGroup.tabs, ...adoptedHere]),
        activePanelId,
      };
      workFocusGroup(work, targetGroupId);
      if (chatGroupId !== null) {
        // The merged-back conversation the user was on shows (and keeps
        // focus) in the main layout.
        workRouteChatsToChatGroup(
          work,
          chatGroupId,
          adoptedChats,
          sourceActivePanelId,
          hasFixedTopology(targetLayoutKey),
        );
      }

      disposeLayoutRecord(source);
      removeGridSashChangeSubscription(sourceLayoutKey);
      set((state) => {
        const layouts = { ...state.layouts };
        delete layouts[sourceLayoutKey];
        return { layouts };
      });
      commitWork(targetLayoutKey, work);
      return true;
    },

    removeExcludedKindTabs: (worktreeKey): boolean => {
      const layout = get().layouts[worktreeKey];
      if (
        !layout ||
        (excludedPanelKinds.size === 0 && scopeExcludedKinds === null)
      ) {
        return false;
      }
      const work = startWork(layout);
      const removed = workTakeTabs(
        work,
        hasFixedTopology(worktreeKey),
        (_groupId, tab) => isPanelKindExcluded(worktreeKey, tab.kind),
      );
      if (removed.length === 0) {
        return false;
      }
      commitWork(worktreeKey, work);
      return true;
    },

    relocateChatTabsToChatGroup: (worktreeKey): boolean => {
      const layout = get().layouts[worktreeKey];
      if (!layout || chatPanelGroupId === null) {
        return false;
      }
      const chatGroupId = chatPanelGroupId;
      const work = startWork(layout);
      if (work.groups[chatGroupId] === undefined) {
        // Auxiliary windows are exempt, and a fixed topology never grows a
        // group. Any other layout that lost its chat group (its last chat
        // moved out before the rule applied) gets it back beside the first
        // group that still holds a chat.
        if (isAuxPanelLayoutKey(worktreeKey) || hasFixedTopology(worktreeKey)) {
          return false;
        }
        const anchorGroupId = collectLeafOrder(work.grid).find((groupId) =>
          work.groups[groupId]?.tabs.some((tab) => tab.kind === 'chat'),
        );
        const anchorView =
          anchorGroupId !== undefined
            ? work.leafViews.get(anchorGroupId)
            : undefined;
        if (anchorView === undefined) {
          return false;
        }
        const chatView = createLeafView(chatGroupId);
        work.grid.addView(
          chatView,
          Sizing.Split,
          anchorView,
          splitDirectionToGridDirection('left'),
        );
        work.leafViews.set(chatGroupId, chatView);
        work.groups[chatGroupId] = { tabs: [], activePanelId: null };
        work.revision += 1;
      }
      // The chat the user is looking at stays selected and focused.
      const focusedPanelId =
        work.activeGroupId !== null
          ? (work.groups[work.activeGroupId]?.activePanelId ?? null)
          : null;
      const moved = workTakeTabs(
        work,
        hasFixedTopology(worktreeKey),
        (groupId, tab) => groupId !== chatGroupId && tab.kind === 'chat',
      );
      if (moved.length === 0) {
        return false;
      }
      workRouteChatsToChatGroup(
        work,
        chatGroupId,
        moved,
        focusedPanelId,
        hasFixedTopology(worktreeKey),
      );
      commitWork(worktreeKey, work);
      return true;
    },
  };
});

// ---------------------------------------------------------------------------
// Keys, getters, and selector helpers
// ---------------------------------------------------------------------------

/**
 * Builds the per-worktree layout key. Matches the `chatStore` convention of
 * keying worktree-scoped state by `${projectId}/${worktreeId}`.
 */
export function makeWorktreePanelKey(
  projectId: string,
  worktreeId: string,
): string {
  return `${projectId}/${worktreeId}`;
}

/**
 * Separator between a worktree key and an auxiliary-window suffix. `#` can
 * never appear in a worktree key (project/worktree ids match
 * `/^[a-z0-9][a-z0-9-]*$/`), so aux keys are unambiguous.
 */
const AUX_LAYOUT_KEY_SEPARATOR = '#aux:';

/**
 * Converts a tab strip's drop index, which counts only the tabs shown for
 * the selected chat, to the full-array index `reorderTab` and `movePanel`
 * take. `panelId` is the dragged tab; it is left out of the count, as both
 * take the index after its removal.
 */
export function panelTabIndexForShownIndex(
  layoutKey: string,
  groupId: string,
  panelId: string,
  shownIndex: number,
): number {
  const layout = usePanelLayoutStore.getState().layouts[layoutKey];
  const group = layout?.groups[groupId];
  if (layout === undefined || group === undefined) return shownIndex;
  return shownIndexToTabIndex(
    group.tabs.filter((tab) => tab.panelId !== panelId),
    Math.trunc(shownIndex),
    groupHiddenTabPredicate(group, layout.chatScope),
  );
}

/**
 * Builds the layout key for a pulled-out (auxiliary window) layout of a
 * worktree: `${worktreeKey}#aux:${auxWindowId}`. Aux layouts live in the same
 * store as worktree layouts and never get their own file: the persistence
 * bridge folds them into the OWNING worktree's `panel-layout.json` as
 * `poppedOut` entries (Phase 9).
 */
export function makeAuxPanelLayoutKey(
  worktreeKey: string,
  auxWindowId: string,
): string {
  return `${worktreeKey}${AUX_LAYOUT_KEY_SEPARATOR}${auxWindowId}`;
}

/** Whether a layout key addresses an auxiliary-window layout. */
export function isAuxPanelLayoutKey(layoutKey: string): boolean {
  return layoutKey.includes(AUX_LAYOUT_KEY_SEPARATOR);
}

/**
 * The owning worktree key of an auxiliary-window layout key, or `null` when
 * the key is not an aux key. The `#` separator can never appear in a
 * worktree key, so the first occurrence is unambiguous.
 */
export function getAuxPanelLayoutOwnerKey(layoutKey: string): string | null {
  const separator = layoutKey.indexOf(AUX_LAYOUT_KEY_SEPARATOR);
  return separator === -1 ? null : layoutKey.slice(0, separator);
}

/** Non-reactive controller lookup for imperative callers (host effects, tests). */
export function getPanelGridController(
  worktreeKey: string,
): PanelGridController | null {
  return (
    usePanelLayoutStore.getState().layouts[worktreeKey]?.controller ?? null
  );
}

/** Non-reactive view-model lookup for one-shot reads. */
export function getPanelLayoutViewModel(
  worktreeKey: string,
): PanelLayoutViewModel | null {
  return usePanelLayoutStore.getState().layouts[worktreeKey]?.viewModel ?? null;
}

/**
 * Reactive view-model selector. The view-model is an eagerly derived stable
 * snapshot, so a plain selector suffices — a commit for another worktree
 * returns the same object reference and skips the re-render.
 */
export function usePanelLayoutViewModel(
  worktreeKey: string | null,
): PanelLayoutViewModel | null {
  return usePanelLayoutStore((state) =>
    worktreeKey !== null
      ? (state.layouts[worktreeKey]?.viewModel ?? null)
      : null,
  );
}

/**
 * Reactive controller selector for the grid host. The controller object is
 * stable across non-topology commits and changes when `revision` bumps or
 * the grid is rebuilt wholesale.
 */
export function usePanelGridController(
  worktreeKey: string | null,
): PanelGridController | null {
  return usePanelLayoutStore((state) =>
    worktreeKey !== null
      ? (state.layouts[worktreeKey]?.controller ?? null)
      : null,
  );
}

/**
 * The reveal-relevant state of one group, sampled BEFORE a mutation runs.
 *
 * Both "Full screen" on a collapsed group's overflow menu and a tab drop on a
 * collapsed bar expand the group inside the same transaction that performs
 * them, so a host that needs to know whether its gesture *revealed* the group
 * has to read the collapsed flag first. Two hosts need that ordering — the
 * shared grid surface and the desktop's auxiliary window, which routes none
 * of its gestures through the shared surface — and restating the read at each
 * call site made the subtle part (read-before-mutate, and that `collapsed` is
 * an optional descriptor rather than a boolean) something two files had to
 * keep in lockstep by hand.
 */
export interface PanelGroupRevealState {
  /** Whether the group is collapsed right now. */
  readonly collapsed: boolean;
  /** The group's active tab, which a group-level reveal exposes. */
  readonly activePanelId?: string;
}

/** Sample {@link PanelGroupRevealState} for a group. */
export function readPanelGroupRevealState(
  layoutKey: string,
  groupId: string,
): PanelGroupRevealState {
  const group =
    usePanelLayoutStore.getState().layouts[layoutKey]?.groups[groupId];
  return {
    collapsed: group?.collapsed !== undefined,
    ...(group?.activePanelId ? { activePanelId: group.activePanelId } : {}),
  };
}
