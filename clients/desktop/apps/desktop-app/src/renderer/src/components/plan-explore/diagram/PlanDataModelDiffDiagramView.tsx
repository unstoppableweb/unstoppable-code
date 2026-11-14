import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type JSX,
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
  DataModelCardinality,
  DataModelChangeType,
  DataModelDiffDiagram,
  DataModelField,
  DataModelFieldKind,
  DataModelRelationship,
  PlanDiagramArtifact,
} from '@canopy/desktop-shared/types/plan-diagrams';
import {
  buildDataModelChangeMaps,
  buildUnifiedDataModelGraph,
  computeDataModelLayout,
  dataModelEntityHeightForFieldCount,
  DATA_MODEL_ENTITY_MAX_LAYOUT_HEIGHT,
  DATA_MODEL_ENTITY_WIDTH,
  type DataModelEntityNodeData,
  type DataModelFlowEdge,
  type DataModelFlowNode,
} from './dataModelLayout';
import type { DiagramSearchHandle } from '@canopy/ui-app/find';
import type { AddNodeCommentInput } from '../usePlanComments';
import { CloseIcon as AppCatalogCloseIcon } from '@canopy/ui-shared/icons/AppIcons';

type DataModelFlowInstance = ReactFlowInstance<
  DataModelFlowNode,
  DataModelFlowEdge
>;

export interface PlanDataModelDiffDiagramProps {
  artifact: PlanDiagramArtifact<DataModelDiffDiagram> | undefined;
  /** Trigger on-demand generation/refresh of the diagrams. */
  onGenerate?: () => void;
  /** True while a generation run is in flight. */
  isGenerating?: boolean;
  /** Stage a comment anchored to the selected entity. */
  onAddNodeComment?: (input: AddNodeCommentInput) => void;
}

type PrimaryView = 'current' | 'planned' | 'diff';
type DiffPresentation = 'unified' | 'split';

/** A relationship touching the selected entity, summarized for the detail panel. */
interface RelationshipSummary {
  id: string;
  label?: string;
  cardinality?: DataModelCardinality;
  direction: 'out' | 'in';
  otherName: string;
}

interface SelectedEntity {
  id: string;
  data: DataModelEntityNodeData;
  relationships: RelationshipSummary[];
}

const CHANGE_STYLES: Record<
  DataModelChangeType,
  { border: string; tone: BadgeTone; row: string; label: string }
> = {
  added: {
    border: 'border-l-line-positive',
    tone: 'success',
    row: 'bg-success-subtle',
    label: 'Added',
  },
  removed: {
    border: 'border-l-line-destructive',
    tone: 'danger',
    row: 'bg-destructive-subtle line-through decoration-destructive/50',
    label: 'Removed',
  },
  changed: {
    border: 'border-l-line-attention',
    tone: 'warning',
    row: 'bg-warning-subtle',
    label: 'Changed',
  },
};

const FIELD_KIND_CHIP: Record<DataModelFieldKind, string | null> = {
  primary: 'PK',
  foreign: 'FK',
  unique: 'UQ',
  indexed: 'IX',
  regular: null,
};

const CARDINALITY_LABELS: Record<DataModelCardinality, string> = {
  'one-to-one': '1:1',
  'one-to-many': '1:N',
  'many-to-one': 'N:1',
  'many-to-many': 'N:N',
  unknown: '',
};

/** A single field row inside an entity node, with its entity-scoped diff tone. */
function FieldRow({
  field,
  change,
}: {
  field: DataModelField;
  change?: DataModelChangeType;
}): JSX.Element {
  const style = change ? CHANGE_STYLES[change] : undefined;
  const keyChip = field.kind ? FIELD_KIND_CHIP[field.kind] : null;
  return (
    <div
      className={`flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 ${
        style ? style.row : ''
      }`}
      style={{ minHeight: 20 }}
    >
      {keyChip && <Badge size="compact">{keyChip}</Badge>}
      <span className="min-w-0 truncate text-2xs font-medium fg-primary">
        {field.name}
      </span>
      {field.type && (
        <span className="min-w-0 truncate font-mono text-3xs fg-secondary">
          {field.type}
        </span>
      )}
      {field.nullable === true && (
        <span className="shrink-0 text-3xs fg-secondary">?</span>
      )}
    </div>
  );
}

/** Custom React Flow node: entity header + scrollable field rows, diff tones. */
function DataModelEntityNodeView({
  data,
}: NodeProps<DataModelFlowNode>): JSX.Element {
  const change = data.changeType;
  const style = change ? CHANGE_STYLES[change] : undefined;
  const searchRing =
    data.searchState === 'active'
      ? 'ring-2 ring-line-attention'
      : data.searchState === 'match'
        ? 'ring-1 ring-line-attention/60'
        : '';
  const height = dataModelEntityHeightForFieldCount(data.fields.length);
  return (
    <div
      className={`flex flex-col overflow-hidden rounded-md border bg-card text-left ${
        style ? `border-l-4 ${style.border}` : ''
      } ${searchRing}`}
      style={{
        width: DATA_MODEL_ENTITY_WIDTH,
        height,
        maxHeight: DATA_MODEL_ENTITY_MAX_LAYOUT_HEIGHT,
      }}
    >
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <div className="flex shrink-0 items-center gap-1.5 border-b px-2.5 py-1.5">
        {style && (
          <Badge size="compact" tone={style.tone}>
            {style.label}
          </Badge>
        )}
        <span className="min-w-0 truncate text-xs font-semibold fg-primary">
          {data.name}
        </span>
        {data.kind && <Badge size="compact">{data.kind}</Badge>}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-px overflow-auto px-1.5 py-1">
        {data.fields.length === 0 ? (
          <p className="px-1.5 py-0.5 text-3xs italic fg-secondary">
            No fields
          </p>
        ) : (
          data.fields.map((field) => (
            <FieldRow
              key={field.id}
              field={field}
              change={data.fieldChanges?.[field.id]}
            />
          ))
        )}
      </div>
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
}

const NODE_TYPES: NodeTypes = { dataModelEntity: DataModelEntityNodeView };

function cardinalityText(cardinality?: DataModelCardinality): string {
  if (!cardinality) {
    return '';
  }
  return CARDINALITY_LABELS[cardinality];
}

function SelectedEntityDetail({
  entity,
  onClose,
  onAddNodeComment,
}: {
  entity: SelectedEntity;
  onClose: () => void;
  onAddNodeComment?: (input: AddNodeCommentInput) => void;
}): JSX.Element {
  const { data } = entity;
  const style = data.changeType ? CHANGE_STYLES[data.changeType] : undefined;
  const [composing, setComposing] = useState(false);
  const [body, setBody] = useState('');

  const handleSave = (): void => {
    const trimmed = body.trim();
    if (trimmed.length === 0 || !onAddNodeComment) {
      return;
    }
    onAddNodeComment({
      diagramKind: 'dataModelDiff',
      nodeId: entity.id,
      title: data.name,
      detail: data.detail,
      files: data.files,
      planNodeIds: data.planNodeIds,
      body: trimmed,
    });
    setBody('');
    setComposing(false);
  };

  return (
    <PaneSheet
      placement="bottom"
      aria-label="Entity detail"
      data-testid="data-model-selected-entity-detail"
    >
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
                {data.name}
              </Heading>
              {data.kind && <Badge size="compact">{data.kind}</Badge>}
            </div>
            <Button
              variant="ghost"
              size="compact"
              iconOnly
              onClick={onClose}
              aria-label="Close entity detail"
            >
              <AppCatalogCloseIcon size="sm" />
            </Button>
          </div>
          <div
            className={
              Boolean(
                data.detail ||
                data.changeNote ||
                data.fields.length ||
                entity.relationships.length ||
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
            {data.fields.length > 0 && (
              <div className="flex flex-col gap-1">
                <p className="text-3xs font-medium fg-secondary">Fields</p>
                <ul className="flex flex-col gap-0.5">
                  {data.fields.map((field) => {
                    const fieldChange = data.fieldChanges?.[field.id];
                    const fieldStyle = fieldChange
                      ? CHANGE_STYLES[fieldChange]
                      : undefined;
                    const keyChip = field.kind
                      ? FIELD_KIND_CHIP[field.kind]
                      : null;
                    return (
                      <li
                        key={field.id}
                        className="flex items-center gap-1.5 text-2xs"
                      >
                        {fieldStyle && (
                          <Badge size="compact" tone={fieldStyle.tone}>
                            {fieldStyle.label}
                          </Badge>
                        )}
                        {keyChip && <Badge size="compact">{keyChip}</Badge>}
                        <span className="font-medium fg-primary">
                          {field.name}
                        </span>
                        {field.type && (
                          <span className="font-mono text-3xs fg-secondary">
                            {field.type}
                          </span>
                        )}
                        {field.nullable === true && (
                          <span className="text-3xs fg-secondary">
                            nullable
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            {entity.relationships.length > 0 && (
              <div className="flex flex-col gap-1">
                <p className="text-3xs font-medium fg-secondary">
                  Relationships
                </p>
                <ul className="flex flex-col gap-0.5">
                  {entity.relationships.map((relationship) => {
                    const cardinality = cardinalityText(
                      relationship.cardinality,
                    );
                    return (
                      <li
                        key={relationship.id}
                        className="flex items-center gap-1 text-2xs fg-primary"
                      >
                        <span className="fg-secondary">
                          {relationship.direction === 'out' ? '→' : '←'}
                        </span>
                        <span className="font-medium">
                          {relationship.otherName}
                        </span>
                        {relationship.label && (
                          <span className="fg-secondary">
                            {relationship.label}
                          </span>
                        )}
                        {cardinality && (
                          <span className="font-mono text-3xs fg-secondary">
                            {cardinality}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
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
                    placeholder="Comment on this entity…"
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

function DataModelFlowGraph({
  nodes,
  edges,
  onNodeClick,
  onPaneClick,
  onInstance,
}: {
  nodes: DataModelFlowNode[];
  edges: DataModelFlowEdge[];
  onNodeClick: NodeMouseHandler<DataModelFlowNode>;
  onPaneClick: () => void;
  onInstance?: (instance: DataModelFlowInstance | null) => void;
}): JSX.Element {
  return (
    <ReactFlow<DataModelFlowNode>
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

/** Lowercased searchable text for an entity node. */
function nodeSearchText(data: DataModelEntityNodeData): string {
  const fieldText = data.fields
    .map((field) => `${field.name} ${field.type ?? ''}`)
    .join(' ');
  const fileText = data.files?.join(' ') ?? '';
  return `${data.name} ${data.kind ?? ''} ${data.detail ?? ''} ${fieldText} ${
    data.changeNote ?? ''
  } ${fileText}`.toLowerCase();
}

/** Merge the search outline state into a layout's nodes for rendering. */
function withSearchState(
  nodes: DataModelFlowNode[],
  matchIds: Set<string>,
  activeId: string | null,
): DataModelFlowNode[] {
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
 * Builds entityId -> display name across both current and planned graphs, so the
 * selected-entity detail can resolve the other end of each relationship even
 * when one side only exists in one graph.
 */
function buildEntityNameMap(data: DataModelDiffDiagram): Map<string, string> {
  const byId = new Map<string, string>();
  for (const entity of data.current.entities) {
    byId.set(entity.id, entity.name);
  }
  for (const entity of data.planned.entities) {
    byId.set(entity.id, entity.name);
  }
  return byId;
}

/** All relationships (union of current+planned) deduped by id. */
function unionRelationships(
  data: DataModelDiffDiagram,
): DataModelRelationship[] {
  const byId = new Map<string, DataModelRelationship>();
  for (const relationship of data.current.relationships) {
    byId.set(relationship.id, relationship);
  }
  for (const relationship of data.planned.relationships) {
    byId.set(relationship.id, relationship);
  }
  return Array.from(byId.values());
}

function relationshipSummariesFor(
  entityId: string,
  relationships: DataModelRelationship[],
  entityNameById: Map<string, string>,
): RelationshipSummary[] {
  const summaries: RelationshipSummary[] = [];
  for (const relationship of relationships) {
    if (relationship.from !== entityId && relationship.to !== entityId) {
      continue;
    }
    const outgoing = relationship.from === entityId;
    const otherId = outgoing ? relationship.to : relationship.from;
    summaries.push({
      id: relationship.id,
      label: relationship.label,
      cardinality: relationship.cardinality,
      direction: outgoing ? 'out' : 'in',
      otherName: entityNameById.get(otherId) ?? otherId,
    });
  }
  return summaries;
}

/**
 * Renders the persisted Current/Planned/Diff data model (ERD) diagram. A primary
 * toggle picks Current, Planned, or Diff; in Diff a secondary toggle switches
 * between a single annotated Unified graph and stacked Current/Planned Split
 * graphs. Entity nodes show field rows with key/type metadata and entity-scoped
 * field-level diff tones; relationship edges carry labels/cardinality. Surfaces
 * the same loading / updating / error states as the logic diagram, and exposes a
 * `DiagramSearchHandle` so the Explore modal search can highlight/reveal nodes.
 */
export const PlanDataModelDiffDiagram = forwardRef<
  DiagramSearchHandle,
  PlanDataModelDiffDiagramProps
>(function PlanDataModelDiffDiagram(
  { artifact, onGenerate, isGenerating = false, onAddNodeComment },
  ref,
): JSX.Element {
  const [primaryView, setPrimaryView] = useState<PrimaryView>('diff');
  const [presentation, setPresentation] = useState<DiffPresentation>('unified');
  const [selected, setSelected] = useState<SelectedEntity | null>(null);
  const [matchIds, setMatchIds] = useState<Set<string>>(() => new Set());
  const [activeId, setActiveId] = useState<string | null>(null);

  const data = artifact?.data ?? null;
  const status = artifact?.status;

  useEffect(() => {
    setSelected(null);
  }, [data, presentation, primaryView]);

  const currentLayout = useMemo(
    () => computeDataModelLayout(data?.current),
    [data],
  );
  const plannedLayout = useMemo(
    () => computeDataModelLayout(data?.planned),
    [data],
  );

  const unifiedLayout = useMemo(() => {
    if (!data) {
      return { nodes: [], edges: [] };
    }
    const unified = buildUnifiedDataModelGraph(data.current, data.planned);
    const changeMaps = buildDataModelChangeMaps(
      data.current,
      data.planned,
      data.changes,
    );
    return computeDataModelLayout(unified, changeMaps);
  }, [data]);

  // Relationship lookup for the selected-entity detail panel, derived once.
  const entityNameById = useMemo(
    () => (data ? buildEntityNameMap(data) : new Map<string, string>()),
    [data],
  );
  const currentRelationships = useMemo(
    () => data?.current.relationships ?? [],
    [data],
  );
  const plannedRelationships = useMemo(
    () => data?.planned.relationships ?? [],
    [data],
  );
  const unifiedRelationships = useMemo(
    () => (data ? unionRelationships(data) : []),
    [data],
  );

  // Base nodes for the currently-visible view, fed to the search handle.
  const visibleNodes = useMemo<DataModelFlowNode[]>(() => {
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
  // current view mode.
  const nodesRef = useRef<DataModelFlowNode[]>(visibleNodes);
  nodesRef.current = visibleNodes;
  const instanceScopeKey = `${primaryView}:${presentation}`;
  const instancesRef = useRef<{
    key: string;
    instances: Set<DataModelFlowInstance>;
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
    (instance: DataModelFlowInstance | null): void => {
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
          const height = dataModelEntityHeightForFieldCount(
            node.data.fields.length,
          );
          for (const instance of Array.from(instancesRef.current.instances)) {
            if (instance.getNode(nodeId)) {
              void instance.setCenter(
                node.position.x + DATA_MODEL_ENTITY_WIDTH / 2,
                node.position.y + height / 2,
                { zoom: instance.getZoom(), duration: 300 },
              );
              break;
            }
          }
        };
        // The entity may not exist in whichever primary view/presentation
        // this diagram is currently showing (e.g. an added entity revealed
        // while "Current" is the active view — it only exists in "Planned").
        // The Diff/Unified presentation is the only one guaranteed to
        // contain every current+planned entity
        // (`buildUnifiedDataModelGraph` unions both by id), so switch to it
        // first and defer centering a frame so the freshly-mounted graph has
        // registered its (scope-reset) React Flow instance — mirrors the
        // tab-switch reveal deferral in `CodeReviewDiagramsPanel`'s
        // `revealNodeRequest` effect.
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

  const selectNode = useCallback(
    (node: DataModelFlowNode, relationships: DataModelRelationship[]): void => {
      setSelected({
        id: node.id,
        data: node.data,
        relationships: relationshipSummariesFor(
          node.id,
          relationships,
          entityNameById,
        ),
      });
    },
    [entityNameById],
  );

  const handleCurrentNodeClick = useCallback<
    NodeMouseHandler<DataModelFlowNode>
  >(
    (_event, node) => selectNode(node, currentRelationships),
    [currentRelationships, selectNode],
  );
  const handlePlannedNodeClick = useCallback<
    NodeMouseHandler<DataModelFlowNode>
  >(
    (_event, node) => selectNode(node, plannedRelationships),
    [plannedRelationships, selectNode],
  );
  const handleUnifiedNodeClick = useCallback<
    NodeMouseHandler<DataModelFlowNode>
  >(
    (_event, node) => selectNode(node, unifiedRelationships),
    [selectNode, unifiedRelationships],
  );

  const handlePaneClick = useCallback((): void => {
    setSelected(null);
  }, []);

  // Idle: no artifact has ever been generated for this plan, and nothing is in
  // flight. Offer an explicit Generate action instead of a misleading spinner.
  if (artifact === undefined && !isGenerating) {
    return (
      <div
        data-testid="plan-data-model-diff-diagram"
        className="flex min-h-0 flex-1 flex-col"
      >
        <DiagramCenteredMessage>
          <EmptyState
            inset="none"
            title="No data model diagram yet."
            action={
              onGenerate ? (
                <Button
                  size="compact"
                  data-testid="plan-data-model-diff-generate"
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
        data-testid="plan-data-model-diff-diagram"
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
        data-testid="plan-data-model-diff-diagram"
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
            retryTestId="plan-data-model-diff-retry"
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
        data-testid="plan-data-model-diff-diagram"
        className="flex min-h-0 flex-1 flex-col"
      >
        <DiagramCenteredMessage>
          <p className="text-s fg-secondary">
            No data model content available.
          </p>
        </DiagramCenteredMessage>
      </div>
    );
  }

  const isUpdating = status === 'stale' || status === 'generating';
  const hasErrorOverlay = status === 'error';

  return (
    <div
      data-testid="plan-data-model-diff-diagram"
      className="relative flex min-h-0 flex-1 flex-col"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-2 py-1.5">
        <div
          data-testid="data-model-diff-view-toggle"
          className="flex items-center gap-1"
        >
          <SegmentedControl
            label="Diagram view"
            shape="capsule"
            width="content"
            value={primaryView}
            onChange={setPrimaryView}
            options={[
              { value: 'current', label: 'Current' },
              { value: 'planned', label: 'Planned' },
              { value: 'diff', label: 'Diff' },
            ]}
          />
        </div>
        {primaryView === 'diff' && (
          <div
            data-testid="data-model-diff-presentation-toggle"
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
          <DataModelFlowGraph
            nodes={currentNodes}
            edges={currentLayout.edges}
            onNodeClick={handleCurrentNodeClick}
            onPaneClick={handlePaneClick}
            onInstance={registerInstance}
          />
        )}

        {primaryView === 'planned' && (
          <DataModelFlowGraph
            nodes={plannedNodes}
            edges={plannedLayout.edges}
            onNodeClick={handlePlannedNodeClick}
            onPaneClick={handlePaneClick}
            onInstance={registerInstance}
          />
        )}

        {primaryView === 'diff' && presentation === 'unified' && (
          <DataModelFlowGraph
            nodes={unifiedNodes}
            edges={unifiedLayout.edges}
            onNodeClick={handleUnifiedNodeClick}
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
                Current
              </Badge>
              <DataModelFlowGraph
                nodes={currentNodes}
                edges={currentLayout.edges}
                onNodeClick={handleCurrentNodeClick}
                onPaneClick={handlePaneClick}
                onInstance={registerInstance}
              />
            </Surface>
            <div className="relative flex min-h-0 flex-1 flex-col">
              <Badge
                size="compact"
                className="pointer-events-none absolute left-3 top-2 z-10"
              >
                Planned
              </Badge>
              <DataModelFlowGraph
                nodes={plannedNodes}
                edges={plannedLayout.edges}
                onNodeClick={handlePlannedNodeClick}
                onPaneClick={handlePaneClick}
                onInstance={registerInstance}
              />
            </div>
          </div>
        )}

        {selected && (
          <SelectedEntityDetail
            key={selected.id}
            entity={selected}
            onClose={(): void => setSelected(null)}
            onAddNodeComment={onAddNodeComment}
          />
        )}
      </div>
    </div>
  );
});

PlanDataModelDiffDiagram.displayName = 'PlanDataModelDiffDiagram';
