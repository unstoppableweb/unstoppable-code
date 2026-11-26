import {
  memo,
  useId,
  useMemo,
  type JSX,
  type MouseEvent,
  type ReactNode,
} from 'react';
import type {
  SubagentNode,
  SubagentSkipEdgeNode,
  SubagentSkipEdgeProjection,
  SubagentTree,
} from '@canopy/agent-transcript';
import { isSubagentChatKind } from '@canopy/agent-transcript';
import { ArrowUpRightIcon } from '../../../../icons/AppIcons';
import {
  DataTableBody,
  DataTableCell,
  DataTableFrame,
  DataTableHead,
  DataTableHeaderCell,
  DataTableRow,
} from '../../../../primitives/DataTable';
import { ControlButton, Button } from '../../../../primitives/Button';
import {
  DisclosureChevron,
  DisclosureToggle,
} from '../../../../primitives/Disclosure';
import { formatSubagentElapsed } from '../common/subagent-format';
import { SubagentChangesLabel } from '../common/SubagentChangesLabel';
import { SubagentHarnessMark } from '../common/SubagentHarnessMark';
import {
  SubagentWorkflowMark,
  SubagentWorkflowPhaseCountText,
  SubagentWorkflowRunStatusText,
  subagentWorkflowRunProgressNote,
  subagentWorkflowPhases,
  subagentWorkflowRunOf,
} from '../common/SubagentWorkflow';
import {
  SubagentStatusGlyph,
  subagentStatusInk,
} from '../common/SubagentStatusGlyph';
import {
  SUBAGENT_OPEN_CHAT_LABEL,
  SUBAGENTS_COLUMN_CHANGES,
  SUBAGENTS_COLUMN_MODEL,
  SUBAGENTS_COLUMN_STATUS,
  SUBAGENTS_COLUMN_TASK,
  SUBAGENTS_COLUMN_TIME,
  SUBAGENTS_COLUMN_WORKSPACE,
  SUBAGENTS_LIST_LABEL,
  subagentStatusDetail,
  subagentViaLabel,
  subagentWorkspaceShortLabel,
  subagentsDepthAccessibleLabel,
  subagentsToggleRowLabel,
  SUBAGENTS_OPEN_ROW_LABEL,
  SUBAGENT_OPEN_WORKFLOW_LABEL,
  subagentFilesCountLabel,
  subagentWorkflowPhasePositionLabel,
} from '../subagent-copy';
import type { SubagentChangeTotals } from '../types';
import { REPLAY_MASK_CLASS } from '../../../../lib/replay-privacy';

/**
 * Supported list layouts, chosen from the list's own available width.
 * `minimal` drops the status column for very narrow panels; each row still
 * shows its status glyph and announces the status to assistive technology.
 */
export type SubagentsListColumns =
  | 'full'
  | 'no-workspace'
  | 'compact'
  | 'minimal';

/** Whether a column set has the Model column. */
function hasModelColumn(columns: SubagentsListColumns): boolean {
  return columns === 'full' || columns === 'no-workspace';
}

/**
 * Column widths for `layout="fixed"`, including each cell's 24px side
 * inset. Task takes the remaining width.
 */
const COLUMN_WIDTH = {
  status: '9rem',
  compactStatus: '8rem',
  model: '8.5rem',
  workspace: '6rem',
  changes: '7rem',
  time: '4.75rem',
  open: '3.25rem',
} as const;

/** Props for the header row that names the visible list columns. */
export interface SubagentsListHeaderProps {
  /** The column set that applies to the rows below. */
  readonly columns: SubagentsListColumns;
  /** Whether a listed task has changes, which adds the Changes column. */
  readonly showChanges: boolean;
}

/** Pure, column-set-aware heading row. */
export function SubagentsListHeader({
  columns,
  showChanges,
}: SubagentsListHeaderProps): JSX.Element {
  return (
    <DataTableHead sticky>
      <DataTableHeaderCell>{SUBAGENTS_COLUMN_TASK}</DataTableHeaderCell>
      {columns !== 'minimal' ? (
        <DataTableHeaderCell
          width={
            columns === 'compact'
              ? COLUMN_WIDTH.compactStatus
              : COLUMN_WIDTH.status
          }
        >
          {SUBAGENTS_COLUMN_STATUS}
        </DataTableHeaderCell>
      ) : null}
      {hasModelColumn(columns) ? (
        <DataTableHeaderCell width={COLUMN_WIDTH.model}>
          {SUBAGENTS_COLUMN_MODEL}
        </DataTableHeaderCell>
      ) : null}
      {columns === 'full' ? (
        <DataTableHeaderCell width={COLUMN_WIDTH.workspace}>
          {SUBAGENTS_COLUMN_WORKSPACE}
        </DataTableHeaderCell>
      ) : null}
      {columns === 'full' && showChanges ? (
        <DataTableHeaderCell width={COLUMN_WIDTH.changes}>
          {SUBAGENTS_COLUMN_CHANGES}
        </DataTableHeaderCell>
      ) : null}
      <DataTableHeaderCell align="right" width={COLUMN_WIDTH.time}>
        {SUBAGENTS_COLUMN_TIME}
      </DataTableHeaderCell>
      <DataTableHeaderCell width={COLUMN_WIDTH.open} labelHidden>
        {SUBAGENT_OPEN_CHAT_LABEL}
      </DataTableHeaderCell>
    </DataTableHead>
  );
}

/** One pre-order item for the subagent list. */
export interface SubagentsListEntry {
  /** The task shown by this row. */
  readonly node: SubagentNode;
  /** Indentation relative to the visible list root. */
  readonly depth: number;
  /** Hidden ancestors skipped by an Active or Attention projection. */
  readonly via?: readonly SubagentNode[];
  /** Whether this visible row has visible child rows. */
  readonly hasChildren: boolean;
}

/** Props for a selectable row and its separate Open chat action. */
export interface SubagentsListRowProps {
  /** The subagent represented by this row. */
  readonly node: SubagentNode;
  /** Visual indentation from the list top. */
  readonly depth: number;
  /** Absolute tree depth reported after indentation is capped. */
  readonly absoluteDepth: number;
  /** Whether this row has children in the current list projection. */
  readonly hasChildren: boolean;
  /** Whether the inspector or drawer is showing this task. */
  readonly selected: boolean;
  /** Optional hidden ancestors to announce after the title. */
  readonly via?: readonly SubagentNode[];
  /** Visible list column set. */
  readonly columns: SubagentsListColumns;
  /** Whether the list shows the Changes column. */
  readonly showChanges: boolean;
  /** Whether this row's children are hidden. */
  readonly collapsed?: boolean;
  /** Shows or hides this row's children. */
  readonly onToggleCollapsed?: (node: SubagentNode) => void;
  /** Whether worktree and change details are available. */
  readonly showWorkspaceDetails: boolean;
  /** Optional authorized totals for this node. */
  readonly changeTotals?: SubagentChangeTotals;
  /** Clock value used to keep elapsed labels deterministic. */
  readonly now: number;
  /** Selects the inspector/drawer subject. */
  readonly onSelect: (node: SubagentNode) => void;
  /** Opens this subagent's chat directly. */
  readonly onOpenChat: (node: SubagentNode) => void;
}

function Indent({
  depth,
  absoluteDepth,
}: {
  readonly depth: number;
  readonly absoluteDepth: number;
}): JSX.Element | null {
  if (depth === 0) return null;
  const isCapped = depth > 4;
  return (
    <span
      className="flex shrink-0 items-center justify-end pr-1 text-3xs tabular-nums fg-tertiary"
      style={{ width: Math.min(depth, 4) * 16 }}
      aria-label={
        isCapped ? subagentsDepthAccessibleLabel(absoluteDepth) : undefined
      }
    >
      {isCapped ? absoluteDepth : null}
    </span>
  );
}

/** The Task cell: its indent, toggle, mark and title on one line. */
function TaskCell({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <DataTableCell overflow="truncate" tone="primary">
      <span className="flex min-w-0 items-center gap-1.5">{children}</span>
    </DataTableCell>
  );
}

/** Memoized list row, with capped indentation and a direct-open action. */
export const SubagentsListRow = memo(function SubagentsListRow({
  node,
  depth,
  absoluteDepth,
  hasChildren,
  selected,
  via,
  columns,
  showChanges,
  collapsed = false,
  onToggleCollapsed,
  showWorkspaceDetails,
  changeTotals,
  now,
  onSelect,
  onOpenChat,
}: SubagentsListRowProps): JSX.Element {
  const titleId = useId();
  const toggleLabelId = useId();
  const openLabelId = useId();
  const workspace = subagentWorkspaceShortLabel(node);
  const showWorkspace = showWorkspaceDetails;
  const openChat = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    onOpenChat(node);
  };

  return (
    <DataTableRow
      data-testid={`subagents-list-row-${node.id}`}
      selected={selected}
      onActivate={(): void => onSelect(node)}
    >
      <TaskCell>
        <Indent depth={depth} absoluteDepth={absoluteDepth} />
        {hasChildren && onToggleCollapsed ? (
          <DisclosureToggle
            variant="tree"
            open={!collapsed}
            aria-labelledby={`${toggleLabelId} ${titleId}`}
            data-testid={`subagents-list-toggle-${node.id}`}
            onClick={(event): void => {
              event.stopPropagation();
              onToggleCollapsed(node);
            }}
          >
            <DisclosureChevron
              direction={collapsed ? 'right' : 'down'}
              size="sm"
              animated
            />
            <span id={toggleLabelId} className="sr-only">
              {subagentsToggleRowLabel(collapsed)}
            </span>
          </DisclosureToggle>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <SubagentStatusGlyph status={node.status} />
        <ControlButton
          type="button"
          aria-pressed={selected}
          data-testid={`subagents-list-select-${node.id}`}
          onClick={(event): void => {
            event.stopPropagation();
            onSelect(node);
          }}
          presentation="subagent-chat-row"
        >
          <span id={titleId} className={REPLAY_MASK_CLASS}>
            {node.title}
          </span>
          {columns === 'minimal' ? (
            <span className="sr-only">, {subagentStatusDetail(node)}</span>
          ) : null}
        </ControlButton>
        {via && via.length > 0 ? (
          <span className="min-w-0 w-1/3 shrink-0 truncate text-2xs fg-tertiary">
            {subagentViaLabel(via)}
          </span>
        ) : null}
      </TaskCell>
      {columns !== 'minimal' ? (
        <DataTableCell overflow="truncate">
          <span className={subagentStatusInk(node.status)}>
            {subagentStatusDetail(node)}
          </span>
        </DataTableCell>
      ) : null}
      {hasModelColumn(columns) ? (
        <DataTableCell overflow="truncate">
          <span className="flex min-w-0 items-center gap-1.5">
            <SubagentHarnessMark harnessId={node.harnessId} />
            <span className="truncate">{node.modelLabel ?? ''}</span>
          </span>
        </DataTableCell>
      ) : null}
      {columns === 'full' ? (
        <DataTableCell overflow="truncate">
          {showWorkspace ? (workspace ?? '') : ''}
        </DataTableCell>
      ) : null}
      {columns === 'full' && showChanges ? (
        <DataTableCell overflow="truncate">
          {showWorkspaceDetails && changeTotals ? (
            <span className="inline-flex items-center gap-1 text-2xs">
              <SubagentChangesLabel
                additions={changeTotals.additions}
                deletions={changeTotals.deletions}
              />
              <span className="fg-tertiary">
                {subagentFilesCountLabel(changeTotals.filesChanged)}
              </span>
            </span>
          ) : null}
        </DataTableCell>
      ) : null}
      <DataTableCell align="right" tone="tertiary">
        {formatSubagentElapsed(node, now)}
      </DataTableCell>
      <DataTableCell align="right">
        {isSubagentChatKind(node.kind) ? (
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            touchArea="contained"
            // The 28px button overhangs the cell's 4px block inset so the
            // row keeps its 36px height.
            className="-my-1"
            // The labelled-by pair names the row ("Open chat, <title>"); the
            // plain label is the fallback the icon-only type asks for.
            aria-label={SUBAGENTS_OPEN_ROW_LABEL}
            aria-labelledby={`${openLabelId} ${titleId}`}
            data-testid={`subagents-list-open-${node.id}`}
            onClick={openChat}
          >
            <ArrowUpRightIcon size={14} aria-hidden />
            <span id={openLabelId} className="sr-only">
              {SUBAGENTS_OPEN_ROW_LABEL}
            </span>
          </Button>
        ) : null}
      </DataTableCell>
    </DataTableRow>
  );
});

SubagentsListRow.displayName = 'SubagentsListRow';

interface WorkflowGroupRowProps {
  readonly node: SubagentNode;
  readonly depth: number;
  readonly absoluteDepth: number;
  readonly hasChildren: boolean;
  readonly collapsed: boolean;
  readonly columns: SubagentsListColumns;
  readonly showChanges: boolean;
  readonly onToggleCollapsed?: (node: SubagentNode) => void;
}

function WorkflowGroupToggle({
  node,
  titleId,
  collapsed,
  onToggleCollapsed,
}: {
  readonly node: SubagentNode;
  /** Id of the row's masked title, which names the toggle with its verb. */
  readonly titleId: string;
  readonly collapsed: boolean;
  readonly onToggleCollapsed?: (node: SubagentNode) => void;
}): JSX.Element {
  const labelId = useId();
  return onToggleCollapsed ? (
    <DisclosureToggle
      variant="tree"
      open={!collapsed}
      aria-labelledby={`${labelId} ${titleId}`}
      data-testid={`subagents-list-toggle-${node.id}`}
      onClick={(event): void => {
        event.stopPropagation();
        onToggleCollapsed(node);
      }}
    >
      <DisclosureChevron
        direction={collapsed ? 'right' : 'down'}
        size="sm"
        animated
      />
      <span id={labelId} className="sr-only">
        {subagentsToggleRowLabel(collapsed)}
      </span>
    </DisclosureToggle>
  ) : (
    <span className="w-4 shrink-0" />
  );
}

function workflowPhasePositionLabel(
  tree: SubagentTree,
  phase: SubagentNode,
): string {
  const run = subagentWorkflowRunOf(tree, phase);
  const phaseCount =
    phase.workflow?.phaseCount ??
    run?.workflow?.phaseCount ??
    (run ? subagentWorkflowPhases(tree, run).length : 0);
  return subagentWorkflowPhasePositionLabel(
    phase.workflow?.phaseIndex ?? 0,
    phaseCount,
  );
}

function SubagentWorkflowRunListRow({
  tree,
  node,
  depth,
  absoluteDepth,
  hasChildren,
  collapsed,
  columns,
  showChanges,
  onToggleCollapsed,
  selected,
  now,
  onSelect,
  onOpenWorkflow,
}: WorkflowGroupRowProps & {
  readonly tree: SubagentTree;
  readonly selected: boolean;
  readonly now: number;
  readonly onSelect: (node: SubagentNode) => void;
  readonly onOpenWorkflow?: (run: SubagentNode) => void;
}): JSX.Element {
  const titleId = useId();
  const openLabelId = useId();
  const openWorkflow = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    onOpenWorkflow?.(node);
  };
  return (
    <DataTableRow
      data-testid={`subagents-list-row-${node.id}`}
      selected={selected}
      onActivate={(): void => onSelect(node)}
    >
      <TaskCell>
        <Indent depth={depth} absoluteDepth={absoluteDepth} />
        {hasChildren && onToggleCollapsed ? (
          <WorkflowGroupToggle
            node={node}
            titleId={titleId}
            collapsed={collapsed}
            onToggleCollapsed={onToggleCollapsed}
          />
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <SubagentWorkflowMark size={12} />
        <ControlButton
          type="button"
          aria-pressed={selected}
          data-testid={`subagents-list-select-${node.id}`}
          onClick={(event): void => {
            event.stopPropagation();
            onSelect(node);
          }}
          presentation="subagent-workflow-row"
        >
          <span id={titleId} className={REPLAY_MASK_CLASS}>
            {node.title}
          </span>
          {columns === 'minimal' ? (
            <span className="sr-only">
              , <SubagentWorkflowRunStatusText tree={tree} run={node} short />
            </span>
          ) : null}
        </ControlButton>
        <span
          className={`min-w-0 truncate text-2xs fg-tertiary ${
            columns === 'minimal' || columns === 'compact'
              ? 'flex-1'
              : 'shrink-0'
          }`}
        >
          {subagentWorkflowRunProgressNote(tree, node)}
        </span>
      </TaskCell>
      {columns !== 'minimal' ? (
        <DataTableCell overflow="truncate">
          <SubagentWorkflowRunStatusText tree={tree} run={node} short />
        </DataTableCell>
      ) : null}
      {hasModelColumn(columns) ? <DataTableCell /> : null}
      {columns === 'full' ? <DataTableCell /> : null}
      {columns === 'full' && showChanges ? <DataTableCell /> : null}
      <DataTableCell align="right" tone="tertiary">
        {formatSubagentElapsed(node, now)}
      </DataTableCell>
      <DataTableCell align="right">
        {onOpenWorkflow ? (
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            touchArea="contained"
            // The 28px button overhangs the cell's 4px block inset so the
            // row keeps its 36px height.
            className="-my-1"
            // The labelled-by pair names the row ("Open chat, <title>"); the
            // plain label is the fallback the icon-only type asks for.
            aria-label={SUBAGENT_OPEN_WORKFLOW_LABEL}
            aria-labelledby={`${openLabelId} ${titleId}`}
            data-testid={`subagents-list-open-${node.id}`}
            onClick={openWorkflow}
          >
            <ArrowUpRightIcon size={14} aria-hidden />
            <span id={openLabelId} className="sr-only">
              {SUBAGENT_OPEN_WORKFLOW_LABEL}
            </span>
          </Button>
        ) : null}
      </DataTableCell>
    </DataTableRow>
  );
}

function SubagentWorkflowPhaseListRow({
  tree,
  node,
  depth,
  absoluteDepth,
  hasChildren,
  collapsed,
  columns,
  showChanges,
  onToggleCollapsed,
}: WorkflowGroupRowProps & { readonly tree: SubagentTree }): JSX.Element {
  const titleId = useId();
  return (
    <DataTableRow data-testid={`subagents-list-row-${node.id}`}>
      <TaskCell>
        <Indent depth={depth} absoluteDepth={absoluteDepth} />
        {hasChildren && onToggleCollapsed ? (
          <WorkflowGroupToggle
            node={node}
            titleId={titleId}
            collapsed={collapsed}
            onToggleCollapsed={onToggleCollapsed}
          />
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <span
          id={titleId}
          className={`${REPLAY_MASK_CLASS} min-w-0 truncate fg-secondary`}
        >
          {node.title}
        </span>
        <span className="shrink-0 text-2xs tabular-nums fg-tertiary">
          {workflowPhasePositionLabel(tree, node)}
        </span>
        {columns === 'minimal' ? (
          <span className="sr-only">
            , <SubagentWorkflowPhaseCountText tree={tree} phase={node} />
          </span>
        ) : null}
      </TaskCell>
      {columns !== 'minimal' ? (
        <DataTableCell overflow="truncate">
          <SubagentWorkflowPhaseCountText tree={tree} phase={node} />
        </DataTableCell>
      ) : null}
      {hasModelColumn(columns) ? <DataTableCell /> : null}
      {columns === 'full' ? <DataTableCell /> : null}
      {columns === 'full' && showChanges ? <DataTableCell /> : null}
      <DataTableCell />
      <DataTableCell />
    </DataTableRow>
  );
}

/** Props for the pure pre-order list body. */
export interface SubagentsListProps {
  /** Complete tree whose nodes are rendered. */
  readonly tree: SubagentTree;
  /** Skip-edge projection for a non-All filter, if any. */
  readonly projection?: SubagentSkipEdgeProjection;
  /** Currently selected task id. */
  readonly selectedId: string | null;
  /** Which columns are available at this width. */
  readonly columns: SubagentsListColumns;
  /** Measured list width, including the wrapper inset, when available. */
  readonly availableWidth?: number;
  /** Tasks whose children are hidden. */
  readonly collapsedIds?: ReadonlySet<string>;
  /** Shows or hides a task's children; parents get a toggle when set. */
  readonly onToggleCollapsed?: (node: SubagentNode) => void;
  /** Whether workspace and change metadata is available on this surface. */
  readonly showWorkspaceDetails: boolean;
  /** Optional host-authorized change lookup. */
  readonly changeTotals?: (
    node: SubagentNode,
  ) => SubagentChangeTotals | undefined;
  /** Current clock for elapsed time. */
  readonly now: number;
  /** Selects a task row. */
  readonly onSelectNode: (node: SubagentNode) => void;
  /** Opens a subagent chat directly. */
  readonly onOpenChat: (node: SubagentNode) => void;
  /** Opens the workflow inspector for a workflow run. */
  readonly onOpenWorkflow?: (run: SubagentNode) => void;
}

function flattenEntries(
  tree: SubagentTree,
  projection: SubagentSkipEdgeProjection | undefined,
  collapsedIds: ReadonlySet<string>,
): readonly SubagentsListEntry[] {
  const entries: SubagentsListEntry[] = [];
  if (projection) {
    const stack: {
      readonly item: SubagentSkipEdgeNode;
      readonly depth: number;
    }[] = [];
    for (let index = projection.items.length - 1; index >= 0; index -= 1) {
      const item = projection.items[index];
      if (item) stack.push({ item, depth: 0 });
    }
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) continue;
      entries.push({
        node: current.item.node,
        depth: current.depth,
        via: current.item.via,
        hasChildren: current.item.children.length > 0,
      });
      if (
        collapsedIds.has(current.item.node.id) &&
        isSubagentChatKind(current.item.node.kind)
      )
        continue;
      for (
        let index = current.item.children.length - 1;
        index >= 0;
        index -= 1
      ) {
        const child = current.item.children[index];
        if (child) stack.push({ item: child, depth: current.depth + 1 });
      }
    }
    return entries;
  }

  const stack: { readonly node: SubagentNode; readonly depth: number }[] = [];
  for (let index = tree.rootChildIds.length - 1; index >= 0; index -= 1) {
    const id = tree.rootChildIds[index];
    const node = id === undefined ? undefined : tree.nodes.get(id);
    if (node) stack.push({ node, depth: 0 });
  }
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const children = current.node.childIds.flatMap((id) => {
      const child = tree.nodes.get(id);
      return child ? [child] : [];
    });
    entries.push({
      node: current.node,
      depth: current.depth,
      hasChildren: children.length > 0,
    });
    if (collapsedIds.has(current.node.id)) continue;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child) stack.push({ node: child, depth: current.depth + 1 });
    }
  }
  return entries;
}

const NO_COLLAPSED_IDS: ReadonlySet<string> = new Set();

/** Memoized task rows in pre-order, for Tree/List parity. */
export function SubagentsList({
  tree,
  projection,
  selectedId,
  columns: requestedColumns,
  availableWidth,
  collapsedIds = NO_COLLAPSED_IDS,
  onToggleCollapsed,
  showWorkspaceDetails,
  changeTotals,
  now,
  onSelectNode,
  onOpenChat,
  onOpenWorkflow,
}: SubagentsListProps): JSX.Element {
  const entries = useMemo(
    () => flattenEntries(tree, projection, collapsedIds),
    [collapsedIds, projection, tree],
  );
  const changeTotalsById = useMemo(
    () =>
      new Map(
        entries.map(
          (entry) => [entry.node.id, changeTotals?.(entry.node)] as const,
        ),
      ),
    [changeTotals, entries],
  );
  const showChanges =
    showWorkspaceDetails &&
    Array.from(changeTotalsById.values()).some(
      (totals) => totals !== undefined,
    );
  // Changes adds 112px of fixed cells. Delay the full layout by that much
  // beyond the 760px no-Changes breakpoint so nested titles and workflow
  // progress retain the same room. Keep Workspace when Changes is absent.
  const columns =
    requestedColumns === 'full' &&
    showChanges &&
    availableWidth !== undefined &&
    availableWidth < 872
      ? 'no-workspace'
      : requestedColumns;
  return (
    <div className="flex min-h-0 flex-1 flex-col p-1.5">
      <DataTableFrame
        caption={SUBAGENTS_LIST_LABEL}
        layout="fixed"
        fill
        testId="subagents-list"
      >
        <SubagentsListHeader columns={columns} showChanges={showChanges} />
        <DataTableBody>
          {entries.map((entry) => {
            const node = entry.node;
            const groupToggle = projection ? undefined : onToggleCollapsed;
            if (node.kind === 'workflow-run') {
              return (
                <SubagentWorkflowRunListRow
                  key={node.id}
                  tree={tree}
                  node={node}
                  depth={entry.depth}
                  absoluteDepth={node.depth}
                  hasChildren={entry.hasChildren}
                  selected={node.id === selectedId}
                  columns={columns}
                  showChanges={showChanges}
                  collapsed={!projection && collapsedIds.has(node.id)}
                  onToggleCollapsed={groupToggle}
                  now={now}
                  onSelect={onSelectNode}
                  onOpenWorkflow={onOpenWorkflow}
                />
              );
            }
            if (node.kind === 'workflow-phase') {
              return (
                <SubagentWorkflowPhaseListRow
                  key={node.id}
                  tree={tree}
                  node={node}
                  depth={entry.depth}
                  absoluteDepth={node.depth}
                  hasChildren={entry.hasChildren}
                  columns={columns}
                  showChanges={showChanges}
                  collapsed={!projection && collapsedIds.has(node.id)}
                  onToggleCollapsed={groupToggle}
                />
              );
            }
            return (
              <SubagentsListRow
                key={node.id}
                node={node}
                depth={entry.depth}
                absoluteDepth={node.depth}
                hasChildren={entry.hasChildren}
                selected={node.id === selectedId}
                via={entry.via}
                columns={columns}
                showChanges={showChanges}
                collapsed={collapsedIds.has(node.id)}
                onToggleCollapsed={onToggleCollapsed}
                showWorkspaceDetails={showWorkspaceDetails}
                changeTotals={changeTotalsById.get(node.id)}
                now={now}
                onSelect={onSelectNode}
                onOpenChat={onOpenChat}
              />
            );
          })}
        </DataTableBody>
      </DataTableFrame>
    </div>
  );
}
