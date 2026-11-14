'use client';

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type JSX,
  type ReactNode,
} from 'react';
import {
  countSubagentsByFilter,
  countsAsSubagent,
  isSubagentChatKind,
  isLiveSubagentStatus,
  projectSubagentSkipEdges,
  subagentAncestors,
  windowSubagentTree,
  type SubagentNode,
  type SubagentSkipEdgeProjection,
  type SubagentStatusFilter,
  type SubagentTree,
  type SubagentTreeWindow,
  type SubagentWindowItem,
} from '@canopy/ui-shared';
import type {
  DiagramCanvasNode,
  DiagramCanvasProps,
  DiagramCanvasViewportSize,
} from '@canopy/ui-rich/diagram';
import { ErrorState, Surface } from '@canopy/ui-shared/components';
import { ChatIcon } from '@canopy/ui-shared/icons/AppIcons';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  FloatingPickerMenu,
  PickerTrigger,
  PickerTriggerChevron,
  SegmentedControl,
  type SegmentedControlOption,
  SUBAGENTS_FILTER_GROUP_LABEL,
  SUBAGENTS_LEVELS_LABEL,
  SUBAGENTS_LEVELS_MENU_LABEL,
  SUBAGENTS_LOAD_FAILED_LABEL,
  SUBAGENTS_LOADING_LABEL,
  SUBAGENTS_PARTIAL_TREE_NOTICE,
  SUBAGENTS_ROOT_PICKER_LABEL,
  SUBAGENTS_TREE_LABEL,
  SUBAGENTS_VIEW_GROUP_LABEL,
  SUBAGENTS_VIEW_LIST_LABEL,
  SUBAGENTS_VIEW_TREE_LABEL,
  SubagentFoldedParentsCard,
  SubagentMoreBelowCard,
  SubagentNodeCard,
  SubagentRootCard,
  SubagentWorkflowPhaseCard,
  SubagentWorkflowRunCard,
  SubagentsDrawer,
  SubagentsEmptyState,
  SubagentsFocusBar,
  SubagentsInspector,
  SubagentsLevelsMenu,
  SubagentsRootPickerMenu,
  subagentsFilterLabelWithCount,
  subagentsLevelsValueLabel,
  subagentsMoreBelowAccessibleLabel,
  subagentsFoldedParentsAccessibleLabel,
  subagentsWorkflowPhaseAccessibleLabel,
} from '@canopy/ui-shared';
import {
  hydrateSubagentViewState,
  useSubagentRootViewState,
  useSubagentScopeHydrated,
  useSubagentScopeViewState,
  useSubagentViewStateStore,
  type SubagentViewStatePersistence,
} from './subagent-view-state-store';
import {
  autoLevelsForCanvasWidth,
  layoutSubagentTree,
  type SubagentCanvasTarget,
} from './subagent-tree-layout';
import {
  SubagentsList as SharedSubagentsList,
  type SubagentsListColumns,
  type SubagentsRootPickerItem,
} from '@canopy/ui-shared';
import type {
  SubagentChangeTotalsLookup,
  SubagentCommandResult,
  SubagentRootChatSummary,
  SubagentTreeLoadState,
  SubagentViewerCapabilities,
} from '../types';
import { subagentHasIsolatedChanges } from '../types';

const LazyDiagramCanvas = lazy(() => import('@canopy/ui-rich/diagram'));
const WIDE_PANEL_MINIMUM = 760;
/** Below this list width the status column is dropped (`minimal`). */
const MINIMAL_LIST_MAXIMUM = 480;
const INSPECTOR_WIDTH = 320;
const DEFAULT_MAX_DEPTH = 10;
/** Props for the host-neutral Subagents panel. */
export interface SubagentsPanelProps {
  /** Stable view-state scope for one worktree, Work Entry, or App Advisor. */
  readonly scopeKey: string;
  /** Open, non-archived chats with subagents, already filtered by the host. */
  readonly rootChats: readonly SubagentRootChatSummary[];
  /** Optional host-owned notice, independent of root/tree availability. */
  readonly lifetimeNotice?: ReactNode;
  /** Root chat selected by the host; null requests panel auto-selection. */
  readonly selectedRootId: string | null;
  /** Tree data for the selected root chat, or null while it is unavailable. */
  readonly tree: SubagentTree | null;
  /** Optional tree read status; omitted means ready. */
  readonly treeState?: SubagentTreeLoadState;
  /** Host-derived capabilities; the panel never checks host identity. */
  readonly capabilities: SubagentViewerCapabilities;
  /** Hide workspace and change details for Cowork/App Advisor roots. */
  readonly showWorkspaceDetails?: boolean;
  /** Optional host-authorized per-node change totals. */
  readonly changeTotals?: SubagentChangeTotalsLookup;
  /** Maximum numbered Levels choice; defaults to ten. */
  readonly maxDepth?: number;
  /** Optional host-owned adapter for the panel's remembered view state. */
  readonly persistence?: SubagentViewStatePersistence;
  /** Fixed epoch time for tests or captures; omitted values use a 30s clock. */
  readonly now?: number;
  /** Selects a root chat in the host. */
  readonly onSelectRoot: (rootId: string) => void;
  /** Opens the selected subagent's chat. */
  readonly onOpenChat: (node: SubagentNode) => void;
  /** Opens a Claude Code workflow run in the host's workflow view. */
  readonly onOpenWorkflow?: (run: SubagentNode) => void;
  /** Stops a live Claude Code workflow run. */
  readonly onStopWorkflow?: (
    run: SubagentNode,
  ) => Promise<SubagentCommandResult>;
  /** Stops a live managed task and anything it started. */
  readonly onStop: (node: SubagentNode) => Promise<SubagentCommandResult>;
  /** Opens the host's changes view for a selected subagent. */
  readonly onShowChanges?: (node: SubagentNode) => void;
  /** Reports the inspector's selected node, or null when it is cleared. */
  readonly onSelectedNodeChange?: (node: SubagentNode | null) => void;
  /** Optional lightweight canvas substitute for tests. */
  readonly CanvasComponent?: ComponentType<DiagramCanvasProps>;
}

function rootChatOrder(
  rootChats: readonly SubagentRootChatSummary[],
): readonly SubagentRootChatSummary[] {
  return rootChats
    .map((root, index) => ({ root, index }))
    .sort((left, right) => {
      const liveOrder =
        Number(right.root.live > 0) - Number(left.root.live > 0);
      if (liveOrder !== 0) return liveOrder;
      const activityOrder =
        (right.root.lastActivityAt ?? 0) - (left.root.lastActivityAt ?? 0);
      return activityOrder === 0 ? left.index - right.index : activityOrder;
    })
    .map(({ root }) => root);
}

function projectedNodeIds(
  tree: SubagentTree,
  projection: SubagentSkipEdgeProjection | undefined,
): ReadonlySet<string> {
  if (!projection) return new Set(tree.nodes.keys());
  const ids = new Set<string>();
  const stack = [...projection.items].reverse();
  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry) continue;
    ids.add(entry.node.id);
    for (let index = entry.children.length - 1; index >= 0; index -= 1) {
      const child = entry.children[index];
      if (child) stack.push(child);
    }
  }
  return ids;
}

function maxTreeDepth(tree: SubagentTree): number {
  let maxDepth = 0;
  for (const node of tree.nodes.values()) {
    maxDepth = Math.max(maxDepth, node.depth);
  }
  return maxDepth;
}

function liveCount(tree: SubagentTree): number {
  let count = 0;
  for (const node of tree.nodes.values()) {
    if (countsAsSubagent(node) && isLiveSubagentStatus(node.status)) count += 1;
  }
  return count;
}

function layoutTargetAriaLabel(
  target: SubagentCanvasTarget,
  tree: SubagentTree,
  window: SubagentTreeWindow,
  stubsByParentId: ReadonlyMap<
    string,
    Extract<SubagentWindowItem, { readonly kind: 'stub' }>
  >,
): string {
  if (target.kind === 'root') return tree.root.title;
  if (target.kind === 'ancestors') {
    return subagentsFoldedParentsAccessibleLabel(window.foldedAncestors.length);
  }
  if (target.kind === 'stub') {
    const item = stubsByParentId.get(target.parentId);
    return subagentsMoreBelowAccessibleLabel(item?.hiddenCount ?? 0);
  }
  const node = tree.nodes.get(target.id);
  if (node?.kind === 'workflow-phase') {
    const runName =
      node.workflow?.runName ??
      (node.parentId ? tree.nodes.get(node.parentId)?.title : undefined) ??
      node.title;
    return subagentsWorkflowPhaseAccessibleLabel(node.title, runName);
  }
  return node?.title ?? target.id;
}

function collectWindowStubs(
  items: readonly SubagentWindowItem[],
): ReadonlyMap<string, Extract<SubagentWindowItem, { readonly kind: 'stub' }>> {
  const stubs = new Map<
    string,
    Extract<SubagentWindowItem, { readonly kind: 'stub' }>
  >();
  const stack = [...items].reverse();
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item) continue;
    if (item.kind === 'stub') {
      stubs.set(item.parentId, item);
    } else {
      for (let index = item.children.length - 1; index >= 0; index -= 1) {
        const child = item.children[index];
        if (child) stack.push(child);
      }
    }
  }
  return stubs;
}

function canvasNodeTestId(target: SubagentCanvasTarget): string {
  if (target.kind === 'root') return 'subagents-tree-root';
  if (target.kind === 'ancestors') return 'subagents-tree-ancestors';
  if (target.kind === 'stub') return `subagents-tree-stub-${target.parentId}`;
  return `subagents-tree-node-${target.id}`;
}

function canvasContent(
  target: SubagentCanvasTarget,
  window: SubagentTreeWindow,
  tree: SubagentTree,
  stubsByParentId: ReadonlyMap<
    string,
    Extract<SubagentWindowItem, { readonly kind: 'stub' }>
  >,
  selectedNodeId: string | null,
  activeCount: number,
  showWorkspaceDetails: boolean,
  changeTotals: SubagentChangeTotalsLookup | undefined,
): JSX.Element | null {
  if (target.kind === 'root') {
    return (
      <SubagentRootCard
        title={tree.root.title}
        activeCount={activeCount}
        selected={selectedNodeId === null}
      />
    );
  }
  if (target.kind === 'ancestors') {
    return (
      <SubagentFoldedParentsCard
        rootTitle={tree.root.title}
        ancestors={window.foldedAncestors}
      />
    );
  }
  if (target.kind === 'stub') {
    const stub = stubsByParentId.get(target.parentId);
    return stub ? (
      <SubagentMoreBelowCard
        hiddenCount={stub.hiddenCount}
        hiddenLiveCount={stub.hiddenLiveCount}
      />
    ) : null;
  }
  const node = tree.nodes.get(target.id);
  if (node?.kind === 'workflow-run') {
    return (
      <SubagentWorkflowRunCard
        tree={tree}
        run={node}
        selected={node.id === selectedNodeId}
      />
    );
  }
  if (node?.kind === 'workflow-phase') {
    return <SubagentWorkflowPhaseCard tree={tree} phase={node} />;
  }
  return node ? (
    <SubagentNodeCard
      node={node}
      selected={node.id === selectedNodeId}
      showWorkspaceDetails={showWorkspaceDetails}
      changeTotals={changeTotals?.(node)}
    />
  ) : null;
}

/** Interactive feature panel for browsing one root chat's subagent tree. */
export function SubagentsPanel({
  scopeKey,
  rootChats,
  lifetimeNotice,
  selectedRootId,
  tree,
  treeState = { status: 'ready' },
  capabilities,
  showWorkspaceDetails = true,
  changeTotals,
  maxDepth = DEFAULT_MAX_DEPTH,
  persistence,
  now,
  onSelectRoot,
  onOpenChat,
  onOpenWorkflow,
  onStopWorkflow,
  onStop,
  onShowChanges,
  onSelectedNodeChange,
  CanvasComponent,
}: SubagentsPanelProps): JSX.Element {
  const panelRef = useRef<HTMLElement>(null);
  const rootTriggerRef = useRef<HTMLButtonElement>(null);
  const levelsTriggerRef = useRef<HTMLButtonElement>(null);
  const lastAutoSelection = useRef('');
  const [panelWidth, setPanelWidth] = useState(0);
  const [reportedCanvasWidth, setReportedCanvasWidth] = useState<number | null>(
    null,
  );
  const [rootPickerOpen, setRootPickerOpen] = useState(false);
  const [levelsMenuOpen, setLevelsMenuOpen] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [stoppingNodeId, setStoppingNodeId] = useState<string | null>(null);
  const [stopError, setStopError] = useState<string | undefined>();
  const [stoppingWorkflowNodeId, setStoppingWorkflowNodeId] = useState<
    string | null
  >(null);
  const [stopWorkflowError, setStopWorkflowError] = useState<
    { readonly nodeId: string; readonly error: string } | undefined
  >();
  const [clockNow, setClockNow] = useState(() => now ?? Date.now());
  // List rows whose children are hidden, per root chat.
  const [collapsedByRoot, setCollapsedByRoot] = useState<
    ReadonlyMap<string, ReadonlySet<string>>
  >(() => new Map());
  const seenWorkflowRunsByRoot = useRef<Map<string, Set<string>>>(new Map());
  const scopeState = useSubagentScopeViewState(scopeKey);
  const scopeHydrated = useSubagentScopeHydrated(scopeKey);
  const rootState = useSubagentRootViewState(scopeKey, selectedRootId);
  const setFilter = useSubagentViewStateStore((state) => state.setFilter);
  const setView = useSubagentViewStateStore((state) => state.setView);
  const setSelectedRoot = useSubagentViewStateStore(
    (state) => state.setSelectedRoot,
  );
  const setLevels = useSubagentViewStateStore((state) => state.setLevels);
  const setFocus = useSubagentViewStateStore((state) => state.setFocus);

  const orderedRootChats = useMemo(() => rootChatOrder(rootChats), [rootChats]);
  const selectedRootSummary = orderedRootChats.find(
    (root) => root.id === selectedRootId,
  );
  const selectedRootIdFromState = scopeState.selectedRootId;
  const filter = scopeState.filter;
  const view = scopeState.view;
  const storedFocusId = rootState.focusId;
  const levelSetting = rootState.levels;
  const normalizedMaxDepth = Number.isFinite(maxDepth)
    ? Math.max(3, Math.floor(maxDepth))
    : DEFAULT_MAX_DEPTH;
  const treeRootId = tree?.root.id ?? selectedRootId;
  const collapsedIds = useMemo(
    (): ReadonlySet<string> =>
      (treeRootId === null ? undefined : collapsedByRoot.get(treeRootId)) ??
      new Set<string>(),
    [collapsedByRoot, treeRootId],
  );

  useEffect(() => {
    void hydrateSubagentViewState(scopeKey, persistence);
  }, [persistence, scopeKey]);

  useLayoutEffect(() => {
    if (!tree) return;
    const rootId = tree.root.id;
    const seenRuns = seenWorkflowRunsByRoot.current.get(rootId) ?? new Set();
    seenWorkflowRunsByRoot.current.set(rootId, seenRuns);
    const newlyFinishedRunIds: string[] = [];
    for (const runId of tree.rootChildIds) {
      const run = tree.nodes.get(runId);
      if (!run || run.kind !== 'workflow-run' || seenRuns.has(run.id)) continue;
      seenRuns.add(run.id);
      if (run.status !== 'running') newlyFinishedRunIds.push(run.id);
    }
    if (newlyFinishedRunIds.length === 0) return;
    setCollapsedByRoot((current) => {
      const next = new Set(current.get(rootId));
      let changed = false;
      for (const runId of newlyFinishedRunIds) {
        if (!next.has(runId)) {
          next.add(runId);
          changed = true;
        }
      }
      return changed ? new Map(current).set(rootId, next) : current;
    });
  }, [tree]);

  useEffect(() => {
    if (selectedRootId !== null && selectedRootId !== selectedRootIdFromState) {
      setSelectedRoot(scopeKey, selectedRootId);
    }
  }, [scopeKey, selectedRootId, selectedRootIdFromState, setSelectedRoot]);

  const selectRoot = useCallback(
    (rootId: string): void => {
      setSelectedRoot(scopeKey, rootId);
      onSelectRoot(rootId);
      setRootPickerOpen(false);
      setSelectedNodeId(null);
      setStopError(undefined);
      setStopWorkflowError(undefined);
      setStoppingWorkflowNodeId(null);
    },
    [onSelectRoot, scopeKey, setSelectedRoot],
  );

  useEffect(() => {
    if (
      selectedRootId !== null ||
      orderedRootChats.length === 0 ||
      !scopeHydrated
    ) {
      lastAutoSelection.current = '';
      return;
    }
    const key = scopeKey;
    if (lastAutoSelection.current === key) return;
    lastAutoSelection.current = key;
    const remembered = orderedRootChats.find(
      (root) => root.id === selectedRootIdFromState,
    );
    const rootToSelect = remembered?.id ?? orderedRootChats[0]?.id;
    if (rootToSelect) selectRoot(rootToSelect);
  }, [
    orderedRootChats,
    scopeHydrated,
    scopeKey,
    selectRoot,
    selectedRootId,
    selectedRootIdFromState,
  ]);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return undefined;
    const measure = (): void => {
      setPanelWidth(panel.getBoundingClientRect().width);
    };
    measure();
    const ResizeObserverClass = panel.ownerDocument.defaultView?.ResizeObserver;
    if (!ResizeObserverClass) return undefined;
    const observer = new ResizeObserverClass((entries) => {
      const entry = entries[0];
      if (entry) setPanelWidth(entry.contentRect.width);
    });
    observer.observe(panel);
    return (): void => observer.disconnect();
  }, []);

  useEffect(() => {
    if (now !== undefined) {
      setClockNow(now);
      return undefined;
    }
    setClockNow(Date.now());
    const interval = setInterval(() => setClockNow(Date.now()), 30_000);
    return (): void => clearInterval(interval);
  }, [now]);

  const previousSelectedRootId = useRef(selectedRootId);
  useEffect(() => {
    if (previousSelectedRootId.current !== selectedRootId) {
      previousSelectedRootId.current = selectedRootId;
      setSelectedNodeId(null);
      setStopError(undefined);
      setStoppingNodeId(null);
      setStopWorkflowError(undefined);
      setStoppingWorkflowNodeId(null);
      setReportedCanvasWidth(null);
    }
  }, [selectedRootId]);

  // A loading tree may not hold the focused node yet (a workflow run is read
  // after the rest), so only a ready tree can show that it is gone.
  const treeReady = treeState.status === 'ready';
  useEffect(() => {
    if (
      tree &&
      treeReady &&
      selectedRootId &&
      storedFocusId &&
      !tree.nodes.has(storedFocusId)
    ) {
      setFocus(scopeKey, selectedRootId, null);
    }
  }, [scopeKey, selectedRootId, setFocus, storedFocusId, tree, treeReady]);

  useEffect(() => {
    if (selectedNodeId && tree && !tree.nodes.has(selectedNodeId)) {
      setSelectedNodeId(null);
      setStopError(undefined);
      setStopWorkflowError(undefined);
      setStoppingWorkflowNodeId(null);
    }
  }, [selectedNodeId, tree]);

  useEffect(() => {
    if (!selectedNodeId) return undefined;
    const document = panelRef.current?.ownerDocument;
    if (!document) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setSelectedNodeId(null);
        setStopError(undefined);
        setStopWorkflowError(undefined);
        setStoppingWorkflowNodeId(null);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return (): void => document.removeEventListener('keydown', onKeyDown);
  }, [selectedNodeId]);

  const selectedNode = selectedNodeId
    ? tree?.nodes.get(selectedNodeId)
    : undefined;
  const guardedOpenChat = useCallback(
    (node: SubagentNode): void => {
      if (isSubagentChatKind(node.kind)) onOpenChat(node);
    },
    [onOpenChat],
  );
  const clearSelection = useCallback((): void => {
    setSelectedNodeId(null);
    setStopError(undefined);
    setStopWorkflowError(undefined);
    setStoppingWorkflowNodeId(null);
  }, []);
  const selectNode = useCallback((nodeId: string): void => {
    setSelectedNodeId(nodeId);
    setStopError(undefined);
    setStopWorkflowError(undefined);
  }, []);

  useEffect(() => {
    onSelectedNodeChange?.(selectedNode ?? null);
  }, [onSelectedNodeChange, selectedNode]);

  const isWidePanel = panelWidth >= WIDE_PANEL_MINIMUM;
  const counts = useMemo(
    () => (tree?.complete ? countSubagentsByFilter(tree) : null),
    [tree],
  );
  const projection = useMemo(
    () =>
      tree && filter !== 'all'
        ? projectSubagentSkipEdges(tree, filter)
        : undefined,
    [filter, tree],
  );
  const visibleProjectionNodeIds = useMemo(
    () => (tree ? projectedNodeIds(tree, projection) : new Set<string>()),
    [projection, tree],
  );
  const activeFocusId =
    storedFocusId && visibleProjectionNodeIds.has(storedFocusId)
      ? storedFocusId
      : null;
  const fallbackCanvasWidth = Math.max(
    0,
    panelWidth - (isWidePanel && selectedNode ? INSPECTOR_WIDTH : 0),
  );
  const canvasWidth = reportedCanvasWidth ?? fallbackCanvasWidth;
  const autoLevels = autoLevelsForCanvasWidth(canvasWidth, normalizedMaxDepth);
  const levels =
    levelSetting === 'all'
      ? 'all'
      : levelSetting === 'auto'
        ? autoLevels
        : levelSetting;
  const treeWindow = useMemo<SubagentTreeWindow>(() => {
    if (!tree) return { items: [], foldedAncestors: [] };
    return windowSubagentTree(projection ?? tree, {
      focusId: activeFocusId,
      levels,
      ...(filter === 'all' ? { collapsedIds } : {}),
    });
  }, [activeFocusId, collapsedIds, filter, levels, projection, tree]);
  const layout = useMemo(
    () => (tree ? layoutSubagentTree(treeWindow, tree) : null),
    [tree, treeWindow],
  );
  const stubsByParentId = useMemo(
    () => collectWindowStubs(treeWindow.items),
    [treeWindow.items],
  );
  const treeDepth = useMemo(() => (tree ? maxTreeDepth(tree) : 0), [tree]);
  const treeLiveCount = useMemo(() => (tree ? liveCount(tree) : 0), [tree]);

  const updateCanvasWidth = useCallback(
    (size: DiagramCanvasViewportSize): void => {
      setReportedCanvasWidth((current) =>
        current === size.width ? current : Math.max(0, size.width),
      );
    },
    [],
  );

  const handleCanvasClick = useCallback(
    (canvasId: string): void => {
      const target = layout?.targetByCanvasId.get(canvasId);
      if (!target) return;
      if (target.kind === 'root') {
        clearSelection();
      } else if (target.kind === 'ancestors') {
        if (selectedRootId) setFocus(scopeKey, selectedRootId, null);
      } else if (target.kind === 'stub') {
        if (selectedRootId) setFocus(scopeKey, selectedRootId, target.parentId);
        clearSelection();
      } else {
        const node = tree?.nodes.get(target.id);
        if (node && node.kind !== 'workflow-phase') selectNode(node.id);
      }
    },
    [
      clearSelection,
      layout,
      scopeKey,
      selectNode,
      selectedRootId,
      setFocus,
      tree,
    ],
  );

  const handleCanvasDoubleClick = useCallback(
    (canvasId: string): void => {
      const target = layout?.targetByCanvasId.get(canvasId);
      if (target?.kind !== 'node' || !selectedRootId || !tree) return;
      const node = tree.nodes.get(target.id);
      if (node && node.childIds.length > 0) {
        setFocus(scopeKey, selectedRootId, node.id);
      }
    },
    [layout, scopeKey, selectedRootId, setFocus, tree],
  );

  const focusUp = useCallback((): void => {
    if (!tree || !treeWindow.focusedNode || !selectedRootId) return;
    const ancestors = subagentAncestors(tree, treeWindow.focusedNode.id);
    const visibleAncestor = ancestors.find((ancestor) =>
      visibleProjectionNodeIds.has(ancestor.id),
    );
    setFocus(scopeKey, selectedRootId, visibleAncestor?.id ?? null);
  }, [
    scopeKey,
    selectedRootId,
    setFocus,
    tree,
    treeWindow.focusedNode,
    visibleProjectionNodeIds,
  ]);

  const showAll = useCallback((): void => {
    if (selectedRootId) setFocus(scopeKey, selectedRootId, null);
  }, [scopeKey, selectedRootId, setFocus]);

  const stopSelectedNode = useCallback(
    async (node: SubagentNode): Promise<void> => {
      setStoppingNodeId(node.id);
      setStopError(undefined);
      try {
        const result = await onStop(node);
        if (!result.ok) setStopError(result.error);
      } catch (error) {
        setStopError(error instanceof Error ? error.message : '');
      } finally {
        setStoppingNodeId(null);
      }
    },
    [onStop],
  );
  const requestStop = useCallback(
    (node: SubagentNode): void => {
      void stopSelectedNode(node);
    },
    [stopSelectedNode],
  );

  const stopSelectedWorkflow = useCallback(
    async (run: SubagentNode): Promise<void> => {
      if (!onStopWorkflow) return;
      setStoppingWorkflowNodeId(run.id);
      setStopWorkflowError(undefined);
      try {
        const result = await onStopWorkflow(run);
        if (!result.ok) {
          setStopWorkflowError({ nodeId: run.id, error: result.error });
        }
      } catch (error) {
        setStopWorkflowError({
          nodeId: run.id,
          error: error instanceof Error ? error.message : '',
        });
      } finally {
        setStoppingWorkflowNodeId(null);
      }
    },
    [onStopWorkflow],
  );
  const requestStopWorkflow = useCallback(
    (run: SubagentNode): void => {
      void stopSelectedWorkflow(run);
    },
    [stopSelectedWorkflow],
  );

  const handleSelectNode = useCallback(
    (node: SubagentNode): void => {
      selectNode(node.id);
    },
    [selectNode],
  );

  const toggleCollapsed = useCallback(
    (node: SubagentNode): void => {
      if (treeRootId === null) return;
      setCollapsedByRoot((current) => {
        const ids = new Set(current.get(treeRootId));
        if (ids.has(node.id)) ids.delete(node.id);
        else ids.add(node.id);
        return new Map(current).set(treeRootId, ids);
      });
    },
    [treeRootId],
  );
  const handleFilterChange = useCallback(
    (nextFilter: SubagentStatusFilter): void => setFilter(scopeKey, nextFilter),
    [scopeKey, setFilter],
  );

  const showControls =
    tree !== null &&
    tree.nodes.size > 0 &&
    selectedRootId !== null &&
    treeState.status === 'ready';
  const listWidth = Math.max(
    0,
    panelWidth - (isWidePanel && selectedNode ? INSPECTOR_WIDTH : 0),
  );
  const listColumns: SubagentsListColumns =
    panelWidth > 0 && listWidth < MINIMAL_LIST_MAXIMUM
      ? 'minimal'
      : !isWidePanel || selectedNode
        ? 'compact'
        : showWorkspaceDetails
          ? 'full'
          : 'no-workspace';
  const currentRoot = orderedRootChats.find(
    (root) => root.id === selectedRootId,
  );
  const rootPickerItems: readonly SubagentsRootPickerItem[] = orderedRootChats;
  const activeCount = selectedRootSummary?.live ?? treeLiveCount;
  const availableChangeTotals = capabilities.worktreeDetails
    ? changeTotals
    : undefined;

  const canvasNodes = useMemo<readonly DiagramCanvasNode[]>(() => {
    if (!tree || !layout) return [];
    return layout.nodes.flatMap((layoutNode) => {
      const content = canvasContent(
        layoutNode.target,
        treeWindow,
        tree,
        stubsByParentId,
        selectedNodeId,
        activeCount,
        showWorkspaceDetails,
        availableChangeTotals,
      );
      if (!content) return [];
      const node =
        layoutNode.target.kind === 'node'
          ? tree.nodes.get(layoutNode.target.id)
          : undefined;
      return [
        {
          id: layoutNode.id,
          x: layoutNode.x,
          y: layoutNode.y,
          width: layoutNode.width,
          height: layoutNode.height,
          content,
          selected:
            node?.kind !== 'workflow-phase' && node?.id === selectedNodeId,
          ariaLabel: layoutTargetAriaLabel(
            layoutNode.target,
            tree,
            treeWindow,
            stubsByParentId,
          ),
          testId: canvasNodeTestId(layoutNode.target),
        },
      ];
    });
  }, [
    activeCount,
    availableChangeTotals,
    layout,
    selectedNodeId,
    showWorkspaceDetails,
    stubsByParentId,
    tree,
    treeWindow,
  ]);

  const fitViewKey = `${scopeKey}:${selectedRootId ?? ''}:${filter}:${levels}:${activeFocusId ?? ''}`;
  const diagramProps: DiagramCanvasProps = {
    nodes: canvasNodes,
    edges: layout?.edges ?? [],
    ariaLabel: SUBAGENTS_TREE_LABEL,
    fitViewKey,
    onNodeClick: handleCanvasClick,
    onNodeDoubleClick: handleCanvasDoubleClick,
    onPaneClick: clearSelection,
    onViewportSize: updateCanvasWidth,
    testId: 'subagents-canvas',
    ...(levelSetting === 'all' ? { minZoom: 0.05 } : {}),
  };

  const closeRootPicker = useCallback(
    (open: boolean): void => setRootPickerOpen(open),
    [],
  );
  const closeLevelsMenu = useCallback(
    (open: boolean): void => setLevelsMenuOpen(open),
    [],
  );

  const rootPicker =
    orderedRootChats.length > 0 ? (
      <div className="relative shrink-0">
        <PickerTrigger
          ref={rootTriggerRef}
          data-testid="subagents-root-picker"
          aria-label={SUBAGENTS_ROOT_PICKER_LABEL}
          aria-expanded={rootPickerOpen}
          aria-haspopup="menu"
          onClick={(): void => setRootPickerOpen((open) => !open)}
          className="max-w-72"
        >
          <ChatIcon size={14} aria-hidden />
          {currentRoot ? (
            <span className={`${REPLAY_MASK_CLASS} min-w-0 truncate`}>
              {currentRoot.title}
            </span>
          ) : (
            <span className="min-w-0 truncate">
              {SUBAGENTS_ROOT_PICKER_LABEL}
            </span>
          )}
          <PickerTriggerChevron open={rootPickerOpen} />
        </PickerTrigger>
        <FloatingPickerMenu
          open={rootPickerOpen}
          onOpenChange={closeRootPicker}
          anchorRef={rootTriggerRef}
          placement="bottom-left"
          interaction="menu"
          data-testid="subagents-root-menu"
        >
          <SubagentsRootPickerMenu
            roots={rootPickerItems}
            selectedRootId={selectedRootId}
            onSelectRoot={selectRoot}
          />
        </FloatingPickerMenu>
      </div>
    ) : null;

  const levelsControl =
    showControls && view === 'tree' && selectedRootId ? (
      <div className="relative shrink-0">
        <PickerTrigger
          ref={levelsTriggerRef}
          // 28px, level with the filter and view controls beside it.
          size="compact"
          data-testid="subagents-levels"
          aria-label={SUBAGENTS_LEVELS_MENU_LABEL}
          aria-expanded={levelsMenuOpen}
          aria-haspopup="menu"
          onClick={(): void => setLevelsMenuOpen((open) => !open)}
        >
          <span>{SUBAGENTS_LEVELS_LABEL}</span>
          <span className="fg-tertiary">
            {subagentsLevelsValueLabel(levelSetting, autoLevels)}
          </span>
          <PickerTriggerChevron open={levelsMenuOpen} />
        </PickerTrigger>
        <FloatingPickerMenu
          open={levelsMenuOpen}
          onOpenChange={closeLevelsMenu}
          anchorRef={levelsTriggerRef}
          placement="bottom-left"
          interaction="menu"
          data-testid="subagents-levels-menu"
        >
          <SubagentsLevelsMenu
            value={levelSetting}
            autoLevels={autoLevels}
            maxDepth={normalizedMaxDepth}
            treeDepth={treeDepth}
            onChange={(nextLevel): void => {
              setLevels(scopeKey, selectedRootId, nextLevel);
              setLevelsMenuOpen(false);
            }}
          />
        </FloatingPickerMenu>
      </div>
    ) : null;

  const filterOption = (
    value: SubagentStatusFilter,
    count: number | null,
  ): SegmentedControlOption<SubagentStatusFilter> => ({
    value,
    label: subagentsFilterLabelWithCount(value, count),
    dataTestId: `subagents-filter-${value}`,
  });

  const filterControl = showControls ? (
    <SegmentedControl<SubagentStatusFilter>
      label={SUBAGENTS_FILTER_GROUP_LABEL}
      value={filter}
      width="control"
      dataTestId="subagents-filter"
      options={[
        filterOption('all', counts?.all ?? null),
        filterOption('active', counts?.active ?? null),
        filterOption('attention', counts?.attention ?? null),
      ]}
      onChange={handleFilterChange}
    />
  ) : null;

  const viewControl = showControls ? (
    <SegmentedControl<'tree' | 'list'>
      label={SUBAGENTS_VIEW_GROUP_LABEL}
      value={view}
      width="control"
      dataTestId="subagents-view"
      options={[
        {
          value: 'tree',
          label: SUBAGENTS_VIEW_TREE_LABEL,
          dataTestId: 'subagents-view-tree',
        },
        {
          value: 'list',
          label: SUBAGENTS_VIEW_LIST_LABEL,
          dataTestId: 'subagents-view-list',
        },
      ]}
      onChange={(nextView): void => setView(scopeKey, nextView)}
    />
  ) : null;

  let content: JSX.Element;
  if (orderedRootChats.length === 0) {
    content = <SubagentsEmptyState kind="no-roots" />;
  } else if (
    treeState.status === 'loading' ||
    (tree === null && treeState.status === 'ready')
  ) {
    content = (
      <div
        role="status"
        data-testid="subagents-loading"
        className="flex flex-1 items-center justify-center gap-2 text-xs fg-tertiary"
      >
        {SUBAGENTS_LOADING_LABEL}
      </div>
    );
  } else if (treeState.status === 'error') {
    content = (
      <div className="flex flex-1 flex-col items-center justify-center">
        <ErrorState
          space="panel"
          testId="subagents-load-error"
          message={SUBAGENTS_LOAD_FAILED_LABEL}
          onRetry={treeState.onRetry}
        />
      </div>
    );
  } else if (tree && tree.nodes.size === 0) {
    content = <SubagentsEmptyState kind="root-empty" />;
  } else if (tree && projection && projection.items.length === 0) {
    content = (
      <SubagentsEmptyState
        kind={filter === 'active' ? 'filter-active' : 'filter-attention'}
      />
    );
  } else if (tree && view === 'list') {
    content = (
      <SharedSubagentsList
        tree={tree}
        projection={projection}
        selectedId={selectedNodeId}
        columns={listColumns}
        availableWidth={listWidth}
        collapsedIds={collapsedIds}
        onToggleCollapsed={toggleCollapsed}
        showWorkspaceDetails={showWorkspaceDetails}
        changeTotals={availableChangeTotals}
        now={clockNow}
        onSelectNode={handleSelectNode}
        onOpenChat={guardedOpenChat}
        {...(capabilities.openWorkflow && onOpenWorkflow
          ? { onOpenWorkflow }
          : {})}
      />
    );
  } else if (tree && layout) {
    const canvas = CanvasComponent ? (
      <CanvasComponent {...diagramProps} />
    ) : (
      <Suspense
        fallback={
          <div
            role="status"
            className="flex h-full min-h-32 items-center justify-center text-xs fg-tertiary"
          >
            {SUBAGENTS_LOADING_LABEL}
          </div>
        }
      >
        <LazyDiagramCanvas {...diagramProps} />
      </Suspense>
    );
    const focusedNode = treeWindow.focusedNode;
    content = (
      <div
        data-testid="subagents-tree"
        className="relative flex min-h-0 flex-1 flex-col"
      >
        {focusedNode ? (
          <SubagentsFocusBar
            tree={tree}
            focusedNode={focusedNode}
            onFocusUp={focusUp}
            onShowAll={showAll}
          />
        ) : null}
        <div className="relative min-h-0 flex-1">{canvas}</div>
      </div>
    );
  } else {
    content = <SubagentsEmptyState kind="no-roots" />;
  }

  const detailsProps =
    tree && selectedNode
      ? {
          tree,
          node: selectedNode,
          showWorkspaceDetails,
          changeTotals: availableChangeTotals?.(selectedNode),
          onOpenChat: guardedOpenChat,
          onClose: clearSelection,
          ...(onShowChanges &&
          capabilities.worktreeDetails &&
          showWorkspaceDetails &&
          subagentHasIsolatedChanges(selectedNode)
            ? {
                onShowChanges: (node: SubagentNode): void =>
                  onShowChanges(node),
              }
            : {}),
          ...(view === 'tree' &&
          selectedNode.childIds.length > 0 &&
          selectedRootId
            ? {
                onFocus: (node: SubagentNode): void =>
                  setFocus(scopeKey, selectedRootId, node.id),
              }
            : {}),
          ...(capabilities.stop &&
          selectedNode.kind === 'managed' &&
          isLiveSubagentStatus(selectedNode.status)
            ? { onStop: requestStop }
            : {}),
          ...(selectedNode.kind === 'workflow-run' &&
          capabilities.openWorkflow &&
          onOpenWorkflow
            ? { onOpenWorkflow }
            : {}),
          ...(selectedNode.kind === 'workflow-run' &&
          capabilities.stopWorkflow &&
          onStopWorkflow &&
          selectedNode.status === 'running'
            ? { onStopWorkflow: requestStopWorkflow }
            : {}),
          stopping: stoppingNodeId === selectedNode.id,
          stopError,
          stoppingWorkflow: stoppingWorkflowNodeId === selectedNode.id,
          stopWorkflowError:
            stopWorkflowError?.nodeId === selectedNode.id
              ? stopWorkflowError.error
              : undefined,
          now: clockNow,
        }
      : null;

  return (
    <Surface
      as="section"
      variant="pane"
      extent="parent"
      ref={panelRef}
      data-testid="subagents-panel"
      className="relative flex min-h-0 w-full flex-col overflow-hidden"
    >
      {lifetimeNotice}
      {orderedRootChats.length > 0 ? (
        <>
          {
            <header
              data-testid="subagents-toolbar"
              className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2"
            >
              {rootPicker}
              {filterControl}
              {levelsControl}
              {viewControl}
            </header>
          }
          {tree?.complete === false ? (
            <p
              role="status"
              data-testid="subagents-partial-tree"
              className="shrink-0 px-3 py-1 text-2xs fg-tertiary"
            >
              {SUBAGENTS_PARTIAL_TREE_NOTICE}
            </p>
          ) : null}
          <div className="relative flex min-h-0 flex-1">
            <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
              {content}
              {detailsProps && !isWidePanel ? (
                <SubagentsDrawer
                  {...detailsProps}
                  over={view === 'tree' ? 'canvas' : 'list'}
                />
              ) : null}
            </div>
            {detailsProps && isWidePanel ? (
              <SubagentsInspector {...detailsProps} />
            ) : null}
          </div>
        </>
      ) : (
        <SubagentsEmptyState kind="no-roots" />
      )}
    </Surface>
  );
}
