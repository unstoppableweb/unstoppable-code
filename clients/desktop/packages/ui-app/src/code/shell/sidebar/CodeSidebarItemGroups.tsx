'use client';

import {
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type KeyboardEvent,
  type RefObject,
  type ComponentProps,
} from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { createPortal } from 'react-dom';
import type {
  SidebarItemGroup as GroupData,
  SidebarItemGroupUpdateRequest,
} from '@canopy/protocol/sidebar';
import {
  SidebarDragPreview,
  SidebarDropLine,
  SidebarNestingRail,
  SidebarItemGroup,
  SidebarItemGroupEditor,
  SidebarItemGroupHeader,
  SIDEBAR_ROW_TEXT_INSET_CLASSNAME,
  sidebarItemGroupBulkMenu,
  sidebarItemGroupColor,
  sidebarItemGroupRowMenu,
  WorktreeRowDragCursorProvider,
  type WorktreeMenuItem,
  type SidebarItemGroupUnitLabel,
} from '@canopy/ui-shared/components';
import { WorktreeSortableStateContext } from '../sortable-state-context';
import {
  resolveSidebarItemGroupDrop,
  sidebarItemGroupMultiMoves,
  stepSidebarItemGroupKeyboardDrag,
  type SidebarItemGroupBlock,
  type SidebarItemGroupDrop,
  type SidebarItemGroupDropTarget,
  type SidebarItemGroupKeyboardDragState,
} from './sidebar-item-groups-model';
import type { SidebarSortMode } from './sidebar-ordering';
import { findSelectedPinHosts } from './sticky-selected-item';
import {
  SIDEBAR_ROW_GAP_CLASS_NAMES,
  type SidebarListRowGap,
} from './SidebarList';

/** Desktop supplies existing owner commands; shared rendering holds no authority. */
export interface CodeSidebarItemGroupCommands {
  create: (itemId: string) => Promise<GroupData>;
  update: (
    groupId: string,
    patch: Pick<
      SidebarItemGroupUpdateRequest,
      'name' | 'color' | 'collapsed' | 'labelHidden' | 'keepWhenEmpty'
    >,
  ) => void | Promise<unknown>;
  ungroup: (groupId: string) => void;
  moveItem: (itemId: string, drop: SidebarItemGroupDrop) => void;
  moveGroup: (groupId: string, drop: SidebarItemGroupDrop) => void;
}
type Source =
  | { kind: 'item' | 'group'; id: string }
  | { kind: 'child'; id: string; rootId: string };
interface Zone {
  id: string;
  target:
    | SidebarItemGroupDropTarget
    | { kind: 'child'; id: string; rootId: string; half: 'before' | 'after' };
}

/** A multi-row drag previews this many rows, then counts the rest. */
const CARRIED_PREVIEW_LIMIT = 3;

/** `inside` fills its whole group beneath the row zones; the group highlight marks it. */
function DropZone({
  zone,
  position,
  active,
  selected,
}: {
  zone: Zone;
  position: 'before' | 'after' | 'inside';
  active: boolean;
  selected: boolean;
}): JSX.Element {
  const { setNodeRef } = useDroppable({ id: zone.id, disabled: !active });
  return (
    <span
      ref={setNodeRef}
      aria-hidden="true"
      data-testid="sidebar-item-group-drop-zone"
      data-drop-zone={zone.id}
      className={`absolute inset-x-0 ${active ? 'pointer-events-auto' : 'pointer-events-none'} ${position === 'inside' ? 'inset-y-0 z-10' : position === 'before' ? 'top-0 z-20 h-1/2' : 'bottom-0 z-20 h-1/2'}`}
    >
      {selected && position !== 'inside' && (
        <SidebarDropLine
          variant="group"
          position={position}
          data-testid="sidebar-item-group-drop-indicator"
        />
      )}
    </span>
  );
}

function DraggableItem({
  source,
  disabled,
  moving,
  carried = false,
  children,
  onKeyboard,
  editorAnchorRef,
  editorReturnFocusRef,
}: {
  editorAnchorRef?: RefObject<HTMLElement | null>;
  editorReturnFocusRef?: RefObject<HTMLElement | null>;
  source: Source;
  disabled: boolean;
  /** This row is the active move, pointer or keyboard. */
  moving: boolean;
  /** A selected row the active move carries along (CAN-3975). */
  carried?: boolean;
  children: ReactNode;
  onKeyboard: (source: Source, event: KeyboardEvent<HTMLDivElement>) => void;
}): JSX.Element {
  const drag = useDraggable({ id: `${source.kind}:${source.id}`, disabled });
  return (
    <WorktreeSortableStateContext.Provider
      value={{
        attributes: {
          ...drag.attributes,
          'aria-roledescription': 'sortable',
          // A keyboard move is ours, not dnd-kit's, so its handle reports the
          // pressed state the sortable rail's keyboard sensor did.
          'aria-pressed': drag.isDragging || moving ? true : undefined,
        },
        listeners: drag.listeners,
        isDragging: drag.isDragging,
      }}
    >
      <div
        ref={(element): void => {
          drag.setNodeRef(element);
          if (editorAnchorRef) {
            editorAnchorRef.current =
              element
                ?.closest('[data-sidebar-item-group-id]')
                ?.querySelector<HTMLElement>(
                  '[data-sidebar-item-group-header]',
                ) ?? element;
          }
          if (editorReturnFocusRef)
            editorReturnFocusRef.current =
              element?.querySelector<HTMLElement>(
                'button[aria-haspopup="menu"]',
              ) ?? element;
        }}
        tabIndex={-1}
        className={`relative min-w-0 ${drag.isDragging || carried ? 'opacity-60' : ''}`}
        data-sidebar-group-drag-source={`${source.kind}:${source.id}`}
        data-dragging={drag.isDragging || undefined}
        data-drag-carried={carried || undefined}
        data-drag-disabled={disabled || undefined}
        data-testid={
          source.kind === 'child' ? 'worktree-branch-group-child' : undefined
        }
        data-child-worktree-id={source.kind === 'child' ? source.id : undefined}
        onKeyDownCapture={(event): void => {
          if (
            !disabled &&
            event.target instanceof HTMLElement &&
            event.target.closest('[aria-roledescription="sortable"]')
          )
            onKeyboard(source, event);
        }}
        onPointerDown={(event): void => {
          if (
            disabled ||
            !(event.target instanceof HTMLElement) ||
            event.target.closest(
              'button,input,textarea,select,a,[contenteditable]',
            )
          )
            return;
          drag.listeners?.onPointerDown?.(event);
        }}
        onTouchStart={(event): void => {
          if (
            disabled ||
            !(event.target instanceof HTMLElement) ||
            event.target.closest(
              'button,input,textarea,select,a,[contenteditable]',
            )
          )
            return;
          drag.listeners?.onTouchStart?.(event);
        }}
      >
        <WorktreeRowDragCursorProvider isDragging={drag.isDragging}>
          {children}
        </WorktreeRowDragCursorProvider>
      </div>
    </WorktreeSortableStateContext.Provider>
  );
}

interface GroupBlockProps {
  mode: SidebarSortMode;
  status?: ReactNode;
  unitLabel: SidebarItemGroupUnitLabel;
  groups: readonly GroupData[];
  block: SidebarItemGroupBlock;
  onEditorChange?: (groupId: string | null) => void;
  commands?: CodeSidebarItemGroupCommands;
  children: ReactNode;
  onCreate: (groupId: string) => void;
  canCreate: boolean;
  onReadOnlyToggle?: (groupId: string) => void;
  onKeyboard: (source: Source, event: KeyboardEvent<HTMLDivElement>) => void;
  activatorProps?: ComponentProps<typeof SidebarItemGroup>['activatorProps'];
}

function GroupBlock({
  block,
  onEditorChange,
  commands,
  groups,
  children,
  onCreate,
  canCreate,
  status,
  unitLabel,
  activatorProps,
  onReadOnlyToggle,
}: GroupBlockProps): JSX.Element | null {
  const fallback = useRef<HTMLDivElement | null>(null);
  const group = block.group;
  if (!group) return null;
  return (
    <div ref={fallback} tabIndex={-1}>
      <SidebarItemGroup
        readOnly={commands === undefined}
        canCreate={canCreate}
        onEditorChange={onEditorChange}
        group={group}
        groups={groups}
        count={block.units.length}
        unitLabel={unitLabel}
        returnFocusRef={fallback}
        status={status}
        activatorProps={activatorProps}
        actions={{
          onToggle: (): void => {
            if (commands)
              void commands.update(group.id, { collapsed: !group.collapsed });
            else onReadOnlyToggle?.(group.id);
          },
          onCreate: (): void => onCreate(group.id),
          onUngroup: (): void => commands?.ungroup(group.id),
          onLabelCommit: ({ name, labelHidden }): void | Promise<unknown> =>
            commands?.update(
              group.id,
              labelHidden === undefined ? { name } : { name, labelHidden },
            ),
          onColorChange: (color): void => {
            void commands?.update(group.id, { color });
          },
          onKeepWhenEmptyChange: (keepWhenEmpty): void => {
            void commands?.update(group.id, { keepWhenEmpty });
          },
        }}
      >
        {children}
      </SidebarItemGroup>
    </div>
  );
}

/** What a whole-group drag carries: its header, then its rows unless collapsed. */
function GroupDragPreview({
  block,
  unitLabel,
  renderPreview,
}: {
  block: SidebarItemGroupBlock;
  unitLabel: SidebarItemGroupUnitLabel;
  renderPreview: (id: string) => ReactNode;
}): JSX.Element | null {
  const group = block.group;
  if (!group) return null;
  const ids = block.units.flatMap((unit) => [...unit.itemIds]);
  const noop = (): void => undefined;
  return (
    <div
      className="relative py-1 pl-2"
      inert
      data-testid="sidebar-item-group-drag-preview"
    >
      <span
        aria-hidden="true"
        className="absolute left-1 inset-y-2 w-0.5 rounded-full"
        style={{ backgroundColor: sidebarItemGroupColor(group.color) }}
      />
      <SidebarItemGroupHeader
        readOnly
        // A hidden label still shows as a count rather than vanishing.
        group={
          group.labelHidden && ids.length
            ? { ...group, collapsed: true }
            : group
        }
        count={block.units.length}
        unitLabel={unitLabel}
        contentId={`${group.id}-drag-preview`}
        onToggle={noop}
        onCreate={noop}
        onMenu={noop}
        testIdSuffix="-drag-preview"
      />
      {!group.collapsed &&
        ids.map((id) => <div key={id}>{renderPreview(id)}</div>)}
    </div>
  );
}

function DraggableGroupBlock(props: GroupBlockProps): JSX.Element {
  const { block, mode, onKeyboard } = props;
  const drag = useDraggable({
    id: `group:${block.id}`,
    disabled: block.group === undefined || mode !== 'manual',
  });
  const group = block.group;
  return (
    <div
      ref={drag.setNodeRef}
      className={drag.isDragging ? 'opacity-60' : undefined}
      onKeyDown={(event): void => {
        if (
          group &&
          mode === 'manual' &&
          event.target instanceof HTMLElement &&
          event.target.closest(
            '[data-testid="sidebar-item-group-toggle"], [data-testid="sidebar-item-group-rail"]',
          )
        )
          onKeyboard({ kind: 'group', id: group.id }, event);
      }}
    >
      <GroupBlock
        {...props}
        activatorProps={
          mode === 'manual'
            ? {
                ...drag.listeners,
                'aria-roledescription': 'sortable',
                ...(group?.labelHidden && !group.collapsed
                  ? { tabIndex: 0 }
                  : {}),
              }
            : undefined
        }
      />
    </div>
  );
}

/** Opens a list's group editor from outside it, such as a pinned row copy. */
export interface CodeSidebarItemGroupEditorHandle {
  current:
    | ((
        groupId: string,
        itemId: string,
        pinSurface?: 'pin-top' | 'pin-bottom',
      ) => void)
    | null;
}

/** What a row's group menu reads; `onEdit` opens the list's one editor. */
export interface CodeSidebarItemGroupMenuInput {
  readonly blocks: readonly SidebarItemGroupBlock[];
  readonly groups: readonly GroupData[];
  readonly mode: SidebarSortMode;
  readonly commands: CodeSidebarItemGroupCommands;
  readonly unitLabel: SidebarItemGroupUnitLabel;
  readonly canDragRow: (id: string) => boolean;
  readonly isItemSelected?: (id: string) => boolean;
  readonly selectionCount?: number;
  readonly onError: (error: unknown) => void;
  readonly onEdit: (groupId: string, itemId: string) => void;
}

/**
 * A row's group entries. Exported so a pinned copy of the selected row offers
 * the same entries as its flow row, built from the same render's blocks.
 */
export function codeSidebarItemGroupRowMenu(
  {
    blocks,
    groups,
    mode,
    commands,
    unitLabel,
    canDragRow,
    isItemSelected,
    selectionCount,
    onError,
    onEdit: edit,
  }: CodeSidebarItemGroupMenuInput,
  block: SidebarItemGroupBlock,
  id: string,
): WorktreeMenuItem[] {
  // Row menus list groups where the nav shows them; unrendered groups go last.
  const navIndex = (id: string): number => {
    const index = blocks.findIndex((block) => block.group?.id === id);
    return index < 0 ? blocks.length : index;
  };
  const navGroups = [...groups].sort(
    (left, right) => navIndex(left.id) - navIndex(right.id),
  );
  if (isItemSelected?.(id) === true && (selectionCount ?? 0) >= 2) {
    // Every selected row in this list, movable or not.
    const selectedUnits = blocks.flatMap((block) =>
      block.units
        .filter((unit) => isItemSelected(unit.rootId))
        .map((unit) => ({ unit, block })),
    );
    // Groups belong to one project: a selection reaching past this list
    // has no group every row can join, so it offers none.
    if (selectedUnits.length !== selectionCount) return [];
    // Pinned rows keep their own order and never join groups, and a row its
    // host holds back from drag stays put, as for drag.
    const movable = selectedUnits.filter(
      ({ unit }) =>
        unit.pinned !== true && unit.hidden !== true && canDragRow(unit.rootId),
    );
    const movableIds = movable.map(({ unit }) => unit.rootId);
    const membershipOnly = mode !== 'manual';
    // Rows already in the target stay where they are.
    const moveAll = (groupId: string | null): void => {
      const moving = movable
        .filter(({ block }) => (block.group?.id ?? null) !== groupId)
        .map(({ unit }) => unit.rootId);
      for (const move of sidebarItemGroupMultiMoves(blocks, moving, {
        groupId,
        membershipOnly,
      }))
        commands.moveItem(move.itemId, move.drop);
    };
    return sidebarItemGroupBulkMenu({
      groups: navGroups,
      currentGroupIds: movable.map(({ block }) => block.group?.id),
      onNewGroup: (): void => {
        const [first, ...rest] = movableIds;
        if (first === undefined) return;
        void commands
          .create(first)
          .then((group): void => {
            // The rest follow the first row into the new group, in order.
            for (const move of sidebarItemGroupMultiMoves(blocks, rest, {
              groupId: group.id,
              ...(membershipOnly ? {} : { after: first }),
              membershipOnly,
            }))
              commands.moveItem(move.itemId, move.drop);
            // On a row in the new group: the right-clicked one may be pinned.
            edit(group.id, first);
          })
          .catch(onError);
      },
      onMove: moveAll,
      onRemove: (): void => moveAll(null),
    });
  }
  return sidebarItemGroupRowMenu({
    groups: navGroups,
    currentGroupId: block.group?.id,
    unitLabel,
    eligible: block.units.find((unit) => unit.rootId === id)?.pinned !== true,
    onNewGroup: (): void => {
      void commands
        .create(id)
        .then((group): void => edit(group.id, id))
        .catch(onError);
    },
    onMove: (groupId): void =>
      commands.moveItem(id, {
        groupId,
        membershipOnly: mode !== 'manual',
      }),
    onEdit: (groupId): void => edit(groupId, id),
    onToggle: (groupId): void => {
      const group = groups.find((group) => group.id === groupId);
      if (group) void commands.update(groupId, { collapsed: !group.collapsed });
    },
    onRemove: (): void =>
      commands.moveItem(id, {
        groupId: null,
        membershipOnly: mode !== 'manual',
      }),
  });
}

export function CodeSidebarItemGroups({
  blocks: ownerBlocks,
  selectedItemId,
  groups,
  onEditorChange,
  mode,
  commands,
  editorHandle,
  renderRow,
  renderPreview,
  onCreate,
  canCreate = true,
  onReorderChild,
  pendingGroupId,
  placeholder,
  onError,
  canDragRow,
  isItemSelected,
  selectionCount,
  renderStatus,
  rowGap = 'none',
  itemGap = 'none',
  dragEnabled: requestedDragEnabled = true,
  unitLabel = { singular: 'worktree', plural: 'worktrees' },
}: {
  /** Collapsed workspace projections retain menus and selection without drag registrations. */
  onEditorChange?: (groupId: string | null) => void;
  dragEnabled?: boolean;
  /** Space between blocks (groups and runs of ungrouped rows). */
  rowGap?: SidebarListRowGap;
  /**
   * Space between the rows inside one block. Any gap here also spaces a
   * stack's child rows 1px apart; they are otherwise flush.
   */
  itemGap?: SidebarListRowGap;
  unitLabel?: SidebarItemGroupUnitLabel;
  blocks: readonly SidebarItemGroupBlock[];
  selectedItemId?: string;
  groups: readonly GroupData[];
  mode: SidebarSortMode;
  commands?: CodeSidebarItemGroupCommands;
  /** Receives this list's editor opener while it is mounted. */
  editorHandle?: CodeSidebarItemGroupEditorHandle;
  renderRow: (
    id: string,
    menu: WorktreeMenuItem[],
    nested: boolean,
  ) => ReactNode;
  renderPreview: (id: string) => ReactNode;
  onCreate: (groupId: string) => void;
  /**
   * Offer the create affordances on each group (header `+`, menu and editor
   * "New … in group"). Default `true`; a host whose target cannot create
   * withholds them.
   */
  canCreate?: boolean;
  onReorderChild?: (activeId: string, overId: string) => void;
  pendingGroupId?: string | null;
  placeholder?: ReactNode;
  onError: (error: unknown) => void;
  canDragRow: (id: string) => boolean;
  /**
   * The row is in the rail's bulk selection (CAN-3975). Dragging a selected
   * row carries every selected row that can move with it.
   */
  isItemSelected?: (id: string) => boolean;
  /**
   * How many rows the rail's whole selection holds, across every list. A
   * selected row's menu moves the selection only when all of it is here.
   */
  selectionCount?: number;
  renderStatus: (block: SidebarItemGroupBlock) => ReactNode;
}): JSX.Element {
  const [localCollapse, setLocalCollapse] = useState<
    ReadonlyMap<string, { base: GroupData; collapsed: boolean }>
  >(new Map());
  const validCollapse = new Map(
    [...localCollapse].filter(
      ([id, value]) =>
        commands === undefined &&
        ownerBlocks.some(
          (block) => block.id === id && block.group === value.base,
        ),
    ),
  );
  if (validCollapse.size !== localCollapse.size)
    setLocalCollapse(validCollapse);
  const blocks = ownerBlocks.map((block) => {
    const local = validCollapse.get(block.id);
    if (!block.group || !local) return block;
    const ids = block.units.flatMap((unit) => [...unit.itemIds]);
    return {
      ...block,
      group: { ...block.group, collapsed: local.collapsed },
      visibleItemIds: local.collapsed
        ? ids.filter((id) => id === selectedItemId)
        : ids,
    };
  });
  const toggleReadOnly = (id: string): void => {
    const base = ownerBlocks.find((block) => block.id === id)?.group;
    if (!base || commands !== undefined) return;
    setLocalCollapse(
      new Map(validCollapse).set(id, {
        base,
        collapsed: !(validCollapse.get(id)?.collapsed ?? base.collapsed),
      }),
    );
  };
  const dragEnabled = requestedDragEnabled && commands !== undefined;
  const GroupContainer = dragEnabled ? DraggableGroupBlock : GroupBlock;
  // A stack's child rows keep 1px between them whenever the rows are spaced;
  // the nesting rail's segments reach up across that gap to stay one line.
  const stackGap = itemGap !== 'none';
  const rootRef = useRef<HTMLDivElement | null>(null);
  const focusRef = useRef<HTMLElement | null>(null);
  const editorReturnFocusRef = useRef<HTMLElement | null>(null);
  const [editorId, setEditorId] = useState<string | null>(null);
  const [editorItemId, setEditorItemId] = useState<string | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [overZone, setOverZone] = useState<Zone | null>(null);
  const over = overZone?.id ?? null;
  // A group lands only beside whole blocks, never among another group's rows.
  const groupDrag = source?.kind === 'group';
  const rowDrop = source !== null && !groupDrag;
  if (!commands && (editorId !== null || source !== null)) {
    setEditorId(null);
    setEditorItemId(null);
    setSource(null);
    setOverZone(null);
  }
  const childTarget = useRef<string | null>(null);
  const keyboardState = useRef<SidebarItemGroupKeyboardDragState | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 5 },
    }),
  );
  const zones = new Map<string, Zone>();
  const sources = new Map<string, Source>();
  const register = (target: Zone['target']): Zone => {
    const id = JSON.stringify(target);
    const zone = { id, target };
    zones.set(id, zone);
    return zone;
  };
  // The selection's movable roots, in rail order: a drag of any of them
  // carries the rest. Pinned rows keep their own order and never join groups.
  const selectedRoots =
    isItemSelected === undefined
      ? []
      : blocks
          .flatMap((block) => [...block.units])
          .filter(
            (unit) =>
              unit.pinned !== true &&
              unit.hidden !== true &&
              canDragRow(unit.rootId) &&
              isItemSelected(unit.rootId),
          )
          .map((unit) => unit.rootId);
  const carriedBy = (active: Source | null): readonly string[] | null =>
    active?.kind === 'item' &&
    selectedRoots.length >= 2 &&
    selectedRoots.includes(active.id)
      ? selectedRoots
      : null;
  const moveItem = (itemId: string, drop: SidebarItemGroupDrop): void => {
    const carried = carriedBy({ kind: 'item', id: itemId });
    if (carried === null) {
      commands?.moveItem(itemId, drop);
      return;
    }
    // Owners apply a project's moves in order, so each row can anchor on the
    // one placed before it.
    for (const move of sidebarItemGroupMultiMoves(blocks, carried, drop))
      commands?.moveItem(move.itemId, move.drop);
  };
  const carriedCount = carriedBy(source)?.length ?? 0;
  const movingLabel =
    carriedCount > 0
      ? `${carriedCount} ${unitLabel.plural}`
      : unitLabel.singular;
  const apply = (active: Source, target: Zone): void => {
    if (active.kind === 'child') {
      if (
        target.target.kind === 'child' &&
        target.target.rootId === active.rootId &&
        target.target.id !== active.id
      ) {
        const unit = blocks
          .flatMap((block) => [...block.units])
          .find((unit) => unit.rootId === active.rootId);
        const siblings = unit?.itemIds.slice(1) ?? [];
        const remainder = siblings.filter((id) => id !== active.id);
        const targetIndex = remainder.indexOf(target.target.id);
        if (targetIndex < 0) return;
        const index = targetIndex + (target.target.half === 'after' ? 1 : 0);
        const destination = siblings[index];
        if (destination && destination !== active.id)
          onReorderChild?.(active.id, destination);
      }
      return;
    }
    const dropTarget = target.target;
    if (dropTarget.kind === 'child') return;
    const carried = carriedBy(active);
    const drop =
      resolveSidebarItemGroupDrop(blocks, active, dropTarget, mode) ??
      // Outside manual order a row dropped on its own group goes nowhere, but
      // the rest of its selection still joins that group.
      (carried !== null && mode !== 'manual'
        ? (carried
            .map((id) =>
              resolveSidebarItemGroupDrop(
                blocks,
                { kind: 'item', id },
                dropTarget,
                mode,
              ),
            )
            .find((candidate) => candidate !== null) ?? null)
        : null);
    if (!drop) return;
    if (active.kind === 'item') moveItem(active.id, drop);
    else commands?.moveGroup(active.id, drop);
  };
  const keyboard = (
    active: Source,
    event: KeyboardEvent<HTMLDivElement>,
  ): void => {
    if (active.kind === 'child') {
      const block = blocks.find((block) =>
        block.units.some((unit) => unit.rootId === active.rootId),
      );
      const unit = block?.units.find((unit) => unit.rootId === active.rootId);
      const siblings =
        unit?.itemIds
          .slice(1)
          .filter((id) => block?.visibleItemIds.includes(id)) ?? [];
      if (event.key === 'Escape' && source) {
        event.preventDefault();
        event.stopPropagation();
        setSource(null);
        setOverZone(null);
        childTarget.current = null;
        return;
      }
      if (event.key === ' ') {
        event.preventDefault();
        event.stopPropagation();
        if (source?.kind === 'child') {
          if (childTarget.current && childTarget.current !== active.id)
            onReorderChild?.(active.id, childTarget.current);
          setSource(null);
          setOverZone(null);
          childTarget.current = null;
        } else {
          setSource(active);
          childTarget.current = active.id;
        }
        return;
      }
      if (
        source?.kind === 'child' &&
        ['ArrowUp', 'ArrowDown'].includes(event.key)
      ) {
        event.preventDefault();
        event.stopPropagation();
        const target =
          siblings[
            siblings.indexOf(childTarget.current ?? active.id) +
              (event.key === 'ArrowUp' ? -1 : 1)
          ];
        if (target) {
          childTarget.current = target;
          const zone: Zone['target'] = {
            kind: 'child',
            id: target,
            rootId: active.rootId,
            half: event.key === 'ArrowUp' ? 'before' : 'after',
          };
          setOverZone({ id: JSON.stringify(zone), target: zone });
        }
      }
      return;
    }
    const next = stepSidebarItemGroupKeyboardDrag(
      blocks,
      active,
      mode,
      keyboardState.current,
      event.key,
    );
    if (!next.handled) return;
    event.preventDefault();
    event.stopPropagation();
    keyboardState.current = next.state;
    setSource(next.state ? active : null);
    const preview = next.state
      ? stepSidebarItemGroupKeyboardDrag(blocks, active, mode, next.state, ' ')
          .drop
      : null;
    setOverZone(
      preview
        ? ([...zones.values()].find(
            (zone) =>
              zone.target.kind !== 'child' &&
              (active.kind !== 'group' || zone.target.kind === 'block') &&
              JSON.stringify(
                resolveSidebarItemGroupDrop(blocks, active, zone.target, mode),
              ) === JSON.stringify(preview),
          ) ?? null)
        : null,
    );
    if (next.drop) {
      if (active.kind === 'item') moveItem(active.id, next.drop);
      else commands?.moveGroup(active.id, next.drop);
    }
  };
  // The pinned copy that opened the editor, if any: its flow row is inert
  // while covered, so focus returns to the copy's menu button instead.
  const editorPinSurface = useRef<'pin-top' | 'pin-bottom' | null>(null);
  const edit = (id: string, itemId: string): void => {
    editorPinSurface.current = null;
    setEditorItemId(itemId);
    setEditorId(id);
  };
  // `edit` only calls state setters, so one registration per handle holds.
  useLayoutEffect(() => {
    if (!editorHandle) return undefined;
    editorHandle.current = (id, itemId, pinSurface): void => {
      editorPinSurface.current = pinSurface ?? null;
      setEditorItemId(itemId);
      setEditorId(id);
    };
    return (): void => {
      editorHandle.current = null;
    };
  }, [editorHandle]);
  // After every commit, so it wins over the flow row's ref callback.
  useLayoutEffect(() => {
    const surface = editorPinSurface.current;
    if (editorId === null || surface === null) return;
    const hosts = findSelectedPinHosts(rootRef.current);
    const trigger = (
      surface === 'pin-top' ? hosts?.topRow : hosts?.bottomRow
    )?.querySelector<HTMLElement>('button[aria-haspopup="menu"]');
    if (trigger) editorReturnFocusRef.current = trigger;
  });
  const editorGroup = groups.find((group) => group.id === editorId);
  const menuFor = (
    block: SidebarItemGroupBlock,
    id: string,
  ): WorktreeMenuItem[] =>
    commands === undefined
      ? []
      : codeSidebarItemGroupRowMenu(
          {
            blocks,
            groups,
            mode,
            commands,
            unitLabel,
            isItemSelected,
            selectionCount,
            canDragRow,
            onError,
            onEdit: edit,
          },
          block,
          id,
        );
  const renderUnit = (
    block: SidebarItemGroupBlock,
    unit: SidebarItemGroupBlock['units'][number],
  ): ReactNode => {
    const visibleIds = unit.itemIds.filter((id) =>
      block.visibleItemIds.includes(id),
    );
    const childIds = visibleIds.filter((id) => id !== unit.rootId);
    const renderItem = (id: string): ReactNode => {
      const child = id !== unit.rootId;
      const active: Source = child
        ? { kind: 'child', id, rootId: unit.rootId }
        : { kind: 'item', id };
      if (!dragEnabled)
        return (
          <WorktreeSortableStateContext.Provider key={id} value={null}>
            <div
              className="relative min-w-0"
              ref={(element): void => {
                if (id !== editorItemId) return;
                focusRef.current =
                  element
                    ?.closest('[data-sidebar-item-group-id]')
                    ?.querySelector<HTMLElement>(
                      '[data-sidebar-item-group-header]',
                    ) ?? element;
                editorReturnFocusRef.current =
                  element?.querySelector<HTMLElement>(
                    'button[aria-haspopup="menu"]',
                  ) ?? element;
              }}
            >
              {renderRow(id, child ? [] : menuFor(block, id), child)}
            </div>
          </WorktreeSortableStateContext.Provider>
        );
      sources.set(`${active.kind}:${id}`, active);
      const before = register(
        child
          ? { kind: 'child', id, rootId: unit.rootId, half: 'before' }
          : { kind: 'row', rootId: id, half: 'before' },
      );
      const after = register(
        child
          ? { kind: 'child', id, rootId: unit.rootId, half: 'after' }
          : { kind: 'row', rootId: id, half: 'after' },
      );
      return (
        <DraggableItem
          key={id}
          source={active}
          editorAnchorRef={id === editorItemId ? focusRef : undefined}
          editorReturnFocusRef={
            id === editorItemId ? editorReturnFocusRef : undefined
          }
          disabled={
            !canDragRow(id) || (child && (mode !== 'manual' || !onReorderChild))
          }
          moving={source?.kind === active.kind && source.id === active.id}
          carried={
            !child &&
            source?.id !== id &&
            carriedBy(source)?.includes(id) === true
          }
          onKeyboard={keyboard}
        >
          {child && (
            <SidebarNestingRail
              first={id === childIds[0]}
              last={id === childIds[childIds.length - 1]}
              bridgeGap={stackGap}
              rounded={false}
              data-testid="worktree-nesting-rail"
            />
          )}
          {renderRow(id, child ? [] : menuFor(block, id), child)}
          <DropZone
            zone={before}
            position="before"
            active={rowDrop && canDragRow(id)}
            selected={over === before.id}
          />
          <DropZone
            zone={after}
            position="after"
            active={rowDrop && canDragRow(id)}
            selected={over === after.id}
          />
        </DraggableItem>
      );
    };
    return (
      <div key={unit.rootId} className="flex flex-col gap-px">
        {visibleIds.includes(unit.rootId) && renderItem(unit.rootId)}
        {childIds.length > 0 && (
          <div
            className={stackGap ? 'flex flex-col gap-px' : undefined}
            data-testid="worktree-branch-group-children"
            data-parent-worktree-id={unit.rootId}
          >
            {childIds.map(renderItem)}
          </div>
        )}
      </div>
    );
  };
  /**
   * Block edges. A row drag gets thin edges just outside a group; a group drag
   * splits every block in half so its upper half drops before it, lower after.
   */
  const edgeZones = (block: SidebarItemGroupBlock): ReactNode =>
    (['before', 'after'] as const).map((edge) => {
      const target: SidebarItemGroupDropTarget = {
        kind: 'block',
        blockId: block.id,
        edge,
      };
      const zone = register(target);
      if (!dragEnabled || (!block.group && !groupDrag)) return null;
      return (
        <span
          key={edge}
          className={`absolute inset-x-0 ${groupDrag ? 'inset-y-0' : edge === 'before' ? '-top-1 h-2' : '-bottom-1 h-2'}`}
        >
          <DropZone
            zone={zone}
            position={edge}
            active={
              source?.kind === 'group'
                ? resolveSidebarItemGroupDrop(blocks, source, target, mode) !==
                  null
                : source !== null
            }
            selected={over === zone.id}
          />
        </span>
      );
    });
  // Every drop that lands in a group highlights the whole group in its color.
  const overTarget = overZone?.target;
  const dropGroupId =
    source &&
    source.kind !== 'child' &&
    overTarget &&
    overTarget.kind !== 'child'
      ? (resolveSidebarItemGroupDrop(blocks, source, overTarget, mode)
          ?.groupId ?? null)
      : null;
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={({ active }): void => {
        setSource(sources.get(String(active.id)) ?? null);
      }}
      onDragOver={({ over }): void =>
        setOverZone((over && zones.get(String(over.id))) ?? null)
      }
      onDragCancel={(): void => {
        setSource(null);
        setOverZone(null);
      }}
      onDragEnd={({ over }): void => {
        const zone = over ? zones.get(String(over.id)) : undefined;
        if (source && zone) apply(source, zone);
        setSource(null);
        setOverZone(null);
      }}
    >
      <div
        ref={rootRef}
        className={`flex min-w-0 flex-col ${SIDEBAR_ROW_GAP_CLASS_NAMES[rowGap]}`}
        data-testid="sidebar-code-item-groups"
      >
        {blocks.map((block, blockIndex): ReactNode => {
          const rows = (
            <>
              {block.group?.id === pendingGroupId && placeholder}
              {block.units.map((unit) => renderUnit(block, unit))}
              {block.group &&
                !block.group.collapsed &&
                block.units.length === 0 &&
                block.group.id !== pendingGroupId && (
                  <div
                    className={`py-1 ${SIDEBAR_ROW_TEXT_INSET_CLASSNAME} pr-2 text-s fg-quaternary`}
                    data-testid="sidebar-item-group-empty"
                  >
                    Nothing in this group
                  </div>
                )}
            </>
          );
          const children =
            itemGap === 'none' ? (
              rows
            ) : (
              <div
                className={`flex flex-col ${SIDEBAR_ROW_GAP_CLASS_NAMES[itemGap]}`}
              >
                {rows}
              </div>
            );
          const ungroupedPlaceholder =
            pendingGroupId === null &&
            block.units[0]?.pinned !== true &&
            blocks
              .slice(0, blockIndex)
              .every((previous) => previous.units[0]?.pinned === true)
              ? placeholder
              : null;
          if (!block.group)
            return (
              <div key={block.id} className="relative">
                {ungroupedPlaceholder}
                {children}
                {edgeZones(block)}
              </div>
            );
          sources.set(`group:${block.id}`, { kind: 'group', id: block.id });
          const inside = register({
            kind: 'collapsed-group',
            groupId: block.id,
            third: 'inside',
          });
          const color = sidebarItemGroupColor(block.group.color);
          const highlighted = dropGroupId === block.id;
          return (
            <div
              key={block.id}
              className="relative rounded-md"
              data-sidebar-group-block={block.id}
              data-drop-target={highlighted || undefined}
              style={
                highlighted
                  ? {
                      backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)`,
                    }
                  : undefined
              }
            >
              {ungroupedPlaceholder}
              <GroupContainer
                block={block}
                groups={groups}
                unitLabel={unitLabel}
                commands={commands}
                onReadOnlyToggle={toggleReadOnly}
                onEditorChange={onEditorChange}
                onCreate={onCreate}
                canCreate={canCreate}
                onKeyboard={keyboard}
                mode={mode}
                status={renderStatus(block)}
              >
                {children}
              </GroupContainer>
              {dragEnabled && (
                // The header and any space between rows add to the group's end;
                // only the thin edges outside it place a row beside the group.
                <DropZone
                  zone={inside}
                  position="inside"
                  active={rowDrop}
                  selected={over === inside.id}
                />
              )}
              {block.units.length > 0 && edgeZones(block)}
            </div>
          );
        })}
        {blocks.every((block) => block.units[0]?.pinned === true) &&
          pendingGroupId === null &&
          placeholder}
        <div className="sr-only" role="status" aria-live="polite">
          {source
            ? `Moving ${source.kind === 'group' ? 'group' : movingLabel}. Use arrows to choose a destination, Space to drop, Escape to cancel.`
            : ''}
        </div>
        {commands && editorGroup && (
          <SidebarItemGroupEditor
            onEditorChange={onEditorChange}
            group={editorGroup}
            groups={groups}
            unitLabel={unitLabel}
            anchorRef={focusRef}
            returnFocusRef={editorReturnFocusRef}
            onClose={(): void => setEditorId(null)}
            onLabelCommit={({ name, labelHidden }): void | Promise<unknown> =>
              commands?.update(
                editorGroup.id,
                labelHidden === undefined ? { name } : { name, labelHidden },
              )
            }
            onColorChange={(color): void => {
              void commands?.update(editorGroup.id, { color });
            }}
            onKeepWhenEmptyChange={(keepWhenEmpty): void => {
              void commands?.update(editorGroup.id, { keepWhenEmpty });
            }}
            onCreate={(): void => onCreate(editorGroup.id)}
            canCreate={canCreate}
            onUngroup={(): void => commands?.ungroup(editorGroup.id)}
          />
        )}
      </div>
      {source &&
        createPortal(
          <DragOverlay style={{ pointerEvents: 'none' }}>
            <SidebarDragPreview
              variant="group"
              className="w-64"
              data-testid="sidebar-item-group-drag-overlay"
            >
              {source.kind === 'group'
                ? blocks
                    .filter((block) => block.id === source.id)
                    .map((block) => (
                      <GroupDragPreview
                        key={block.id}
                        block={block}
                        unitLabel={unitLabel}
                        renderPreview={renderPreview}
                      />
                    ))
                : source.kind === 'item'
                  ? (carriedBy(source) ?? [source.id])
                      .slice(0, CARRIED_PREVIEW_LIMIT)
                      .flatMap(
                        (rootId) =>
                          blocks
                            .flatMap((block) => [...block.units])
                            .find((unit) => unit.rootId === rootId)
                            ?.itemIds ?? [rootId],
                      )
                      .map((id) => <div key={id}>{renderPreview(id)}</div>)
                  : renderPreview(source.id)}
              {carriedCount > CARRIED_PREVIEW_LIMIT && (
                <div
                  className={`py-1 ${SIDEBAR_ROW_TEXT_INSET_CLASSNAME} pr-2 text-s fg-tertiary`}
                  data-testid="sidebar-item-group-drag-overlay-more"
                >
                  {`+${carriedCount - CARRIED_PREVIEW_LIMIT} more`}
                </div>
              )}
            </SidebarDragPreview>
          </DragOverlay>,
          document.body,
        )}
    </DndContext>
  );
}
