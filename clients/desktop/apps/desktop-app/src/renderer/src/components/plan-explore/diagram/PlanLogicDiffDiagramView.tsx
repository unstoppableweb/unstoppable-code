import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type NodeMouseHandler,
  type NodeProps,
  type NodeTypes,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Surface,
  Stack,
  Badge,
  type BadgeTone,
  Button,
  Divider,
  EmptyState,
  ErrorState,
  Heading,
  PaneSheet,
  SegmentedControl,
  TextArea,
  ThinkingSpinner,
} from '@canopy/ui-shared/components';
import { DiagramCenteredMessage } from './DiagramCenteredMessage';
import type {
  LogicChangeType,
  LogicDiffDiagram,
  PlanDiagramArtifact,
} from '@canopy/desktop-shared/types/plan-diagrams';
import {
  buildChangeMaps,
  buildUnifiedLogicFlow,
  computeLogicFlowLayout,
  LOGIC_NODE_HEIGHT,
  LOGIC_NODE_WIDTH,
  type LogicFlowEdge,
  type LogicFlowNode,
  type LogicFlowNodeData,
} from './logicFlowLayout';
import type { DiagramSearchHandle } from '@canopy/ui-app/find';
import type { AddNodeCommentInput } from '../usePlanComments';
import { CloseIcon as AppCatalogCloseIcon } from '@canopy/ui-shared/icons/AppIcons';

type LogicFlowInstance = ReactFlowInstance<LogicFlowNode, LogicFlowEdge>;

export interface PlanLogicDiffDiagramProps {
  artifact: PlanDiagramArtifact<LogicDiffDiagram> | undefined;
  /** Trigger on-demand generation/refresh of the diagrams. */
  onGenerate?: () => void;
  /** True while a generation run is in flight. */
  isGenerating?: boolean;
  /** Stage a comment anchored to the selected node. */
  onAddNodeComment?: (input: AddNodeCommentInput) => void;
  /** Override the current/planned view labels (defaults preserve plan-mode copy). */
  viewLabels?: { current: string; planned: string };
  /** Host-owned actions aligned at the end of the view picker row. */
  toolbarActions?: ReactNode;
}

type PrimaryView = 'current' | 'planned' | 'diff';
type DiffPresentation = 'unified' | 'split';

interface SelectedNode {
  id: string;
  data: LogicFlowNodeData;
}

const CHANGE_STYLES: Record<
  LogicChangeType,
  { border: string; tone: BadgeTone; label: string }
> = {
  added: {
    border: 'border-l-line-positive',
    tone: 'success',
    label: 'Added',
  },
  removed: {
    border: 'border-l-line-destructive',
    tone: 'danger',
    label: 'Removed',
  },
  changed: {
    border: 'border-l-line-attention',
    tone: 'warning',
    label: 'Changed',
  },
};

/** Custom React Flow node: bold label + optional detail, diff annotations. */
function LogicFlowNodeView({ data }: NodeProps<LogicFlowNode>): JSX.Element {
  const change = data.changeType;
  const style = change ? CHANGE_STYLES[change] : undefined;
  const searchRing =
    data.searchState === 'active'
      ? 'ring-2 ring-line-attention'
      : data.searchState === 'match'
        ? 'ring-1 ring-line-attention/60'
        : '';
  return (
    <div
      className={`flex h-full w-full flex-col justify-center gap-0.5 rounded-md border bg-card px-3 py-2 text-left ${
        style ? `border-l-4 ${style.border}` : ''
      } ${searchRing}`}
      style={{ width: LOGIC_NODE_WIDTH, height: LOGIC_NODE_HEIGHT }}
    >
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <div className="flex items-center gap-1.5">
        {style && (
          <Badge size="compact" tone={style.tone}>
            {style.label}
          </Badge>
        )}
        <span className="min-w-0 truncate text-xs font-semibold fg-primary">
          {data.label}
        </span>
      </div>
      {data.detail && (
        <p className="line-clamp-2 text-2xs leading-tight fg-secondary">
          {data.detail}
        </p>
      )}
      {!data.detail && data.changeNote && (
        <p className="line-clamp-2 text-2xs leading-tight fg-secondary">
          {data.changeNote}
        </p>
      )}
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
}

const NODE_TYPES: NodeTypes = { logic: LogicFlowNodeView };

function SelectedNodeDetail({
  node,
  onClose,
  onAddNodeComment,
}: {
  node: SelectedNode;
  onClose: () => void;
  onAddNodeComment?: (input: AddNodeCommentInput) => void;
}): JSX.Element {
  const { data } = node;
  const style = data.changeType ? CHANGE_STYLES[data.changeType] : undefined;
  const [composing, setComposing] = useState(false);
  const [body, setBody] = useState('');

  const handleSave = (): void => {
    const trimmed = body.trim();
    if (trimmed.length === 0 || !onAddNodeComment) {
      return;
    }
    onAddNodeComment({
      diagramKind: 'logicDiff',
      nodeId: node.id,
      // Logic nodes carry `label` instead of `title`.
      title: data.label,
      detail: data.detail,
      files: data.files,
      planNodeIds: data.planNodeIds,
      body: trimmed,
    });
    setBody('');
    setComposing(false);
  };

  return (
    <PaneSheet placement="bottom" aria-label="Node detail">
      <Stack gap="item">
        <Stack gap="tight">
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              {style && (
                <Badge size="compact" tone={style.tone}>
                  {style.label}
                </Badge>
              )}
              <Heading level={4} variant="title" truncate className="min-w-0">
                {data.label}
              </Heading>
            </div>
            <Button
              variant="ghost"
              size="compact"
              iconOnly
              onClick={onClose}
              aria-label="Close node detail"
            >
              <AppCatalogCloseIcon size="sm" />
            </Button>
          </div>
          <div
            className={
              Boolean(
                data.detail ||
                data.changeNote ||
                data.files?.length ||
                data.planNodeIds?.length,
              ) && !Boolean(data.planNodeIds?.length)
                ? 'flex flex-col gap-2 pb-2'
                : 'flex flex-col gap-2'
            }
          >
            {data.detail && (
              <p className="whitespace-pre-wrap text-xs fg-primary">
                {data.detail}
              </p>
            )}
            {data.changeNote && (
              <p className="text-xs italic fg-secondary">{data.changeNote}</p>
            )}
            {data.files && data.files.length > 0 && (
              <div className="flex flex-col gap-1">
                <p className="text-3xs font-medium fg-secondary">Files</p>
                <ul className="flex flex-col gap-0.5">
                  {data.files.map((file) => (
                    <li
                      key={file}
                      className="truncate font-mono text-2xs fg-primary"
                    >
                      {file}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {data.planNodeIds && data.planNodeIds.length > 0 && (
              <Stack gap="tight">
                <p className="text-3xs font-medium fg-secondary">Plan nodes</p>
                <ul className="flex flex-wrap gap-1">
                  {data.planNodeIds.map((id) => (
                    <li key={id} className="font-mono text-3xs fg-secondary">
                      {id}
                    </li>
                  ))}
                </ul>
              </Stack>
            )}
          </div>
        </Stack>
        {onAddNodeComment && (
          <div className="">
            <Divider />
            <div className="pt-2">
              {composing ? (
                <div className="flex flex-col gap-1.5">
                  <TextArea
                    aria-label="Comment"
                    value={body}
                    onChange={(e): void => setBody(e.target.value)}
                    placeholder="Comment on this node…"
                    rows={3}
                    autoFocus
                    data-testid="plan-node-comment-input"
                  />
                  <div className="flex items-center justify-end gap-1.5">
                    <Button
                      size="compact"
                      onClick={(): void => {
                        setComposing(false);
                        setBody('');
                      }}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="primary"
                      size="compact"
                      onClick={handleSave}
                      disabled={body.trim().length === 0}
                      data-testid="plan-node-comment-save"
                    >
                      Save comment
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  size="compact"
                  onClick={(): void => setComposing(true)}
                  data-testid="plan-node-add-comment"
                >
                  + Add comment
                </Button>
              )}
            </div>
          </div>
        )}
      </Stack>
    </PaneSheet>
  );
}

function LogicFlowGraph({
  nodes,
  edges,
  onNodeClick,
  onPaneClick,
  onInstance,
}: {
  nodes: LogicFlowNode[];
  edges: LogicFlowEdge[];
  onNodeClick: NodeMouseHandler<LogicFlowNode>;
  onPaneClick: () => void;
  onInstance?: (instance: LogicFlowInstance | null) => void;
}): JSX.Element {
  return (
    <ReactFlow<LogicFlowNode>
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      onInit={(instance): void => onInstance?.(instance)}
      onNodeClick={onNodeClick}
      onPaneClick={onPaneClick}
      fitView
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      proOptions={{ hideAttribution: true }}
    >
      <Background />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

/** Lowercased searchable text for a logic node. */
function nodeSearchText(data: LogicFlowNodeData): string {
  return `${data.label} ${data.detail ?? ''} ${data.changeNote ?? ''}`.toLowerCase();
}

/** Merge the search outline state into a layout's nodes for rendering. */
function withSearchState(
  nodes: LogicFlowNode[],
  matchIds: Set<string>,
  activeId: string | null,
): LogicFlowNode[] {
  return nodes.map((node) => {
    const searchState: 'match' | 'active' | undefined =
      node.id === activeId
        ? 'active'
        : matchIds.has(node.id)
          ? 'match'
          : undefined;
    if (searchState === undefined && node.data.searchState === undefined) {
      return node;
    }
    return { ...node, data: { ...node.data, searchState } };
  });
}

/**
 * Renders the persisted Current/Planned/Diff logic diagram. A primary toggle
 * picks Current, Planned, or Diff; in Diff a secondary toggle switches between a
 * single annotated Unified graph and stacked Current/Planned Split graphs.
 * Surfaces the same loading / updating / error states as the sequence diagram.
 * Exposes a `DiagramSearchHandle` so the Explore modal search can highlight and
 * reveal matching nodes in the currently-visible view.
 */
export const PlanLogicDiffDiagram = forwardRef<
  DiagramSearchHandle,
  PlanLogicDiffDiagramProps
>(function PlanLogicDiffDiagram(
  {
    artifact,
    onGenerate,
    isGenerating = false,
    onAddNodeComment,
    viewLabels,
    toolbarActions,
  },
  ref,
): JSX.Element {
  const currentLabel = viewLabels?.current ?? 'Current';
  const plannedLabel = viewLabels?.planned ?? 'Planned';
  const [primaryView, setPrimaryView] = useState<PrimaryView>('diff');
  const [presentation, setPresentation] = useState<DiffPresentation>('unified');
  const [selected, setSelected] = useState<SelectedNode | null>(null);
  const [matchIds, setMatchIds] = useState<Set<string>>(() => new Set());
  const [activeId, setActiveId] = useState<string | null>(null);

  const data = artifact?.data ?? null;
  const status = artifact?.status;

  const currentLayout = useMemo(
    () => computeLogicFlowLayout(data?.current),
    [data],
  );
  const plannedLayout = useMemo(
    () => computeLogicFlowLayout(data?.planned),
    [data],
  );

  const unifiedLayout = useMemo(() => {
    if (!data) {
      return { nodes: [], edges: [] };
    }
    const unified = buildUnifiedLogicFlow(data.current, data.planned);
    const { changeByNodeId, noteByNodeId } = buildChangeMaps(
      data.current,
      data.planned,
      data.changes,
    );
    return computeLogicFlowLayout(unified, changeByNodeId, noteByNodeId);
  }, [data]);

  // Base nodes for the currently-visible view, fed to the search handle.
  const visibleNodes = useMemo<LogicFlowNode[]>(() => {
    if (primaryView === 'current') {
      return currentLayout.nodes;
    }
    if (primaryView === 'planned') {
      return plannedLayout.nodes;
    }
    if (presentation === 'unified') {
      return unifiedLayout.nodes;
    }
    return [...currentLayout.nodes, ...plannedLayout.nodes];
  }, [
    primaryView,
    presentation,
    currentLayout.nodes,
    plannedLayout.nodes,
    unifiedLayout.nodes,
  ]);

  // Keep the latest visible nodes and live React Flow instances in refs so the
  // imperative search handle (deps `[]`) always reads fresh values. The split
  // view mounts two graphs, so instances are tracked as a set scoped to the
  // current view mode — the scope-key reset (mirroring
  // `PlanDataModelDiffDiagram`) prunes instances from unmounted views, so
  // `reveal()`'s centering never lands on a stale instance after view
  // switches.
  const nodesRef = useRef<LogicFlowNode[]>(visibleNodes);
  nodesRef.current = visibleNodes;
  const instanceScopeKey = `${primaryView}:${presentation}`;
  const instancesRef = useRef<{
    key: string;
    instances: Set<LogicFlowInstance>;
  }>({
    key: instanceScopeKey,
    instances: new Set(),
  });
  if (instancesRef.current.key !== instanceScopeKey) {
    instancesRef.current = {
      key: instanceScopeKey,
      instances: new Set(),
    };
  }

  const registerInstance = useCallback(
    (instance: LogicFlowInstance | null): void => {
      if (instancesRef.current.key !== instanceScopeKey) {
        instancesRef.current = {
          key: instanceScopeKey,
          instances: new Set(),
        };
      }
      if (instance) {
        instancesRef.current.instances.add(instance);
      }
    },
    [instanceScopeKey],
  );

  useImperativeHandle(
    ref,
    (): DiagramSearchHandle => ({
      search: (query: string): string[] => {
        const trimmed = query.trim().toLowerCase();
        if (trimmed.length === 0) {
          setMatchIds(new Set());
          setActiveId(null);
          return [];
        }
        const ordered = nodesRef.current
          .filter((node) => nodeSearchText(node.data).includes(trimmed))
          .sort(
            (a, b) =>
              a.position.y - b.position.y || a.position.x - b.position.x,
          );
        setMatchIds(new Set(ordered.map((node) => node.id)));
        setActiveId(null);
        return ordered.map((node) => node.id);
      },
      reveal: (nodeId: string): void => {
        if (nodeId === '') {
          setActiveId(null);
          return;
        }
        setActiveId(nodeId);
        const centerOnNode = (): void => {
          const node = nodesRef.current.find(
            (candidate) => candidate.id === nodeId,
          );
          if (!node) {
            return;
          }
          for (const instance of Array.from(instancesRef.current.instances)) {
            if (instance.getNode(nodeId)) {
              void instance.setCenter(
                node.position.x + LOGIC_NODE_WIDTH / 2,
                node.position.y + LOGIC_NODE_HEIGHT / 2,
                { zoom: instance.getZoom(), duration: 300 },
              );
              break;
            }
          }
        };
        // The node may not exist in whichever primary view/presentation this
        // diagram is currently showing (e.g. an added node revealed while
        // "Current" is the active view — it only exists in "Planned"). The
        // Diff/Unified presentation is the only one guaranteed to contain
        // every current+planned node (`buildUnifiedLogicFlow` unions both by
        // id), so switch to it first and defer centering a frame so the
        // freshly-mounted graph has registered its React Flow instance —
        // mirrors the tab-switch reveal deferral in
        // `CodeReviewDiagramsPanel`'s `revealNodeRequest` effect.
        const visibleInCurrentView = nodesRef.current.some(
          (candidate) => candidate.id === nodeId,
        );
        if (!visibleInCurrentView) {
          setPrimaryView('diff');
          setPresentation('unified');
          window.requestAnimationFrame(centerOnNode);
          return;
        }
        centerOnNode();
      },
      clear: (): void => {
        setMatchIds(new Set());
        setActiveId(null);
      },
    }),
    [],
  );

  const currentNodes = useMemo(
    () => withSearchState(currentLayout.nodes, matchIds, activeId),
    [currentLayout.nodes, matchIds, activeId],
  );
  const plannedNodes = useMemo(
    () => withSearchState(plannedLayout.nodes, matchIds, activeId),
    [plannedLayout.nodes, matchIds, activeId],
  );
  const unifiedNodes = useMemo(
    () => withSearchState(unifiedLayout.nodes, matchIds, activeId),
    [unifiedLayout.nodes, matchIds, activeId],
  );

  const handleNodeClick = useCallback<NodeMouseHandler<LogicFlowNode>>(
    (_event, node) => {
      setSelected({ id: node.id, data: node.data });
    },
    [],
  );

  const handlePaneClick = useCallback((): void => {
    setSelected(null);
  }, []);

  // Idle: no artifact has ever been generated for this plan, and nothing is in
  // flight. Offer an explicit Generate action instead of a misleading spinner.
  if (artifact === undefined && !isGenerating) {
    return (
      <div
        data-testid="plan-logic-diff-diagram"
        className="flex min-h-0 flex-1 flex-col"
      >
        <DiagramCenteredMessage>
          <EmptyState
            inset="none"
            title="No current/planned diagram yet."
            action={
              onGenerate ? (
                <Button
                  size="compact"
                  data-testid="plan-logic-diff-generate"
                  onClick={onGenerate}
                  disabled={isGenerating}
                >
                  {isGenerating ? 'Generating…' : 'Generate diagram'}
                </Button>
              ) : undefined
            }
          />
        </DiagramCenteredMessage>
      </div>
    );
  }

  // Loading: actively generating (or optimistically requested) with no prior
  // data to show.
  if (
    !data &&
    (isGenerating || status === 'pending' || status === 'generating')
  ) {
    return (
      <div
        data-testid="plan-logic-diff-diagram"
        className="flex min-h-0 flex-1 flex-col"
      >
        <DiagramCenteredMessage>
          <ThinkingSpinner />
          <p className="text-s fg-secondary">Generating diagram…</p>
        </DiagramCenteredMessage>
      </div>
    );
  }

  // Error with no usable prior data.
  if (status === 'error' && !data) {
    return (
      <div
        data-testid="plan-logic-diff-diagram"
        className="flex min-h-0 flex-1 flex-col"
      >
        <DiagramCenteredMessage>
          <ErrorState
            space="panel"
            message={
              <Stack as="span" gap="tight">
                Couldn’t generate the diagram.
                {artifact?.error && (
                  <span className="block max-w-sm text-xs fg-secondary">
                    {artifact.error}
                  </span>
                )}
              </Stack>
            }
            onRetry={onGenerate}
            retrying={isGenerating}
            retryTestId="plan-logic-diff-retry"
          />
        </DiagramCenteredMessage>
      </div>
    );
  }

  const hasContent =
    currentLayout.nodes.length > 0 || plannedLayout.nodes.length > 0;
  if (!hasContent) {
    return (
      <div
        data-testid="plan-logic-diff-diagram"
        className="flex min-h-0 flex-1 flex-col"
      >
        <DiagramCenteredMessage>
          <p className="text-s fg-secondary">No diagram content available.</p>
        </DiagramCenteredMessage>
      </div>
    );
  }

  const isUpdating = status === 'stale' || status === 'generating';
  const hasErrorOverlay = status === 'error';

  return (
    <div
      data-testid="plan-logic-diff-diagram"
      className="relative flex min-h-0 flex-1 flex-col"
    >
      <div
        data-testid="logic-diff-toolbar"
        className="flex shrink-0 flex-wrap items-center gap-2 border-b px-2 py-1.5"
      >
        <div
          data-testid="logic-diff-view-toggle"
          className="flex items-center gap-1"
        >
          <SegmentedControl
            label="Diagram view"
            shape="capsule"
            width="content"
            value={primaryView}
            onChange={setPrimaryView}
            options={[
              { value: 'current', label: currentLabel },
              { value: 'planned', label: plannedLabel },
              { value: 'diff', label: 'Diff' },
            ]}
          />
        </div>
        {primaryView === 'diff' && (
          <div
            data-testid="logic-diff-presentation-toggle"
            className="flex items-center gap-1 border-l pl-2"
          >
            <SegmentedControl
              label="Diff layout"
              shape="capsule"
              width="content"
              value={presentation}
              onChange={setPresentation}
              options={[
                { value: 'unified', label: 'Unified' },
                { value: 'split', label: 'Split' },
              ]}
            />
          </div>
        )}
        {toolbarActions && <div className="ml-auto">{toolbarActions}</div>}
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col">
        {isUpdating && (
          <Badge className="pointer-events-none absolute right-3 top-3 z-10">
            <ThinkingSpinner />
            Updating…
          </Badge>
        )}
        {hasErrorOverlay && (
          <Badge
            tone="danger"
            className="pointer-events-none absolute right-3 top-3 z-10"
          >
            Update failed
          </Badge>
        )}

        {primaryView === 'current' && (
          <LogicFlowGraph
            nodes={currentNodes}
            edges={currentLayout.edges}
            onNodeClick={handleNodeClick}
            onPaneClick={handlePaneClick}
            onInstance={registerInstance}
          />
        )}

        {primaryView === 'planned' && (
          <LogicFlowGraph
            nodes={plannedNodes}
            edges={plannedLayout.edges}
            onNodeClick={handleNodeClick}
            onPaneClick={handlePaneClick}
            onInstance={registerInstance}
          />
        )}

        {primaryView === 'diff' && presentation === 'unified' && (
          <LogicFlowGraph
            nodes={unifiedNodes}
            edges={unifiedLayout.edges}
            onNodeClick={handleNodeClick}
            onPaneClick={handlePaneClick}
            onInstance={registerInstance}
          />
        )}

        {primaryView === 'diff' && presentation === 'split' && (
          <div className="flex min-h-0 flex-1 flex-col">
            <Surface
              variant="section"
              boundary="bottom"
              className="relative flex min-h-0 flex-1 flex-col"
            >
              <Badge
                size="compact"
                className="pointer-events-none absolute left-3 top-2 z-10"
              >
                {currentLabel}
              </Badge>
              <LogicFlowGraph
                nodes={currentNodes}
                edges={currentLayout.edges}
                onNodeClick={handleNodeClick}
                onPaneClick={handlePaneClick}
                onInstance={registerInstance}
              />
            </Surface>
            <div className="relative flex min-h-0 flex-1 flex-col">
              <Badge
                size="compact"
                className="pointer-events-none absolute left-3 top-2 z-10"
              >
                {plannedLabel}
              </Badge>
              <LogicFlowGraph
                nodes={plannedNodes}
                edges={plannedLayout.edges}
                onNodeClick={handleNodeClick}
                onPaneClick={handlePaneClick}
                onInstance={registerInstance}
              />
            </div>
          </div>
        )}

        {selected && (
          <SelectedNodeDetail
            key={selected.id}
            node={selected}
            onClose={(): void => setSelected(null)}
            onAddNodeComment={onAddNodeComment}
          />
        )}
      </div>
    </div>
  );
});

PlanLogicDiffDiagram.displayName = 'PlanLogicDiffDiagram';
