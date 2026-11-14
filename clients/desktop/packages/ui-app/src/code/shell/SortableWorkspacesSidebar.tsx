'use client';

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
  type CSSProperties,
  type JSX,
  type ReactNode,
} from 'react';
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type Modifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  type SortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { createPortal } from 'react-dom';
import type { CanopyCapabilities } from '@canopy/app-core';
import {
  SidebarDragPreview,
  SidebarDropLine,
  WorkspaceSectionHeader,
  WorktreeRowDragCursorProvider,
} from '@canopy/ui-shared/components';
import {
  WorkspacesSidebarSections,
  type WorkspacesSidebarSectionsProps,
  type WorkspaceDndWrapperContext,
  type WorkspaceSectionSlotContext,
  type WorktreeDndWrapperContext,
  type WorktreeRowSlotContext,
} from './WorkspacesSidebarSections';
import { partitionWorkspaces } from './workspace-sections-model';
import {
  WorkspaceDropIndicatorContext,
  WorkspaceSortableStateContext,
  type WorkspaceDropIndicatorState,
  WorktreeSortableStateContext,
} from './sortable-state-context';
import { sidebarRowLabel, worktreesForWorkspace } from './worktree-status';
import { workspaceColor, workspaceKind } from './sidebar-model';

type DndSlot =
  | 'renderWorkspaceDragHandle'
  | 'renderWorktreeDragHandle'
  | 'wrapWorkspaceSection'
  | 'wrapWorktreeList'
  | 'wrapWorktreeRow';

export interface SortableWorkspacesSidebarProps extends Omit<
  WorkspacesSidebarSectionsProps,
  DndSlot
> {
  readonly onReorderWorkspace?: (activeId: string, overId: string) => void;
  readonly onReorderWorktree?: (
    workspaceId: string,
    activeId: string,
    overId: string,
  ) => void;
  readonly renderWorkspaceDragHandleContent?: (
    context: WorkspaceSectionSlotContext,
  ) => ReactNode;
}

const WorktreeDropIndicatorContext = createContext<{
  readonly id: string;
  readonly position: 'before' | 'after';
} | null>(null);

export const SORTABLE_SIDEBAR_POINTER_CONSTRAINT = {
  activationConstraint: { distance: 6 },
} as const;
export const SORTABLE_SIDEBAR_TOUCH_CONSTRAINT = {
  activationConstraint: { delay: 250, tolerance: 8 },
} as const;
export const SORTABLE_SIDEBAR_FINE_POINTER_SENSOR = PointerSensor;
export const SORTABLE_SIDEBAR_COARSE_POINTER_SENSOR = TouchSensor;
export const SORTABLE_SIDEBAR_KEYBOARD_COORDINATE_GETTER =
  sortableKeyboardCoordinates;
export const SORTABLE_SIDEBAR_COLLISION_DETECTION = closestCenter;

// `@dnd-kit/modifiers` is not a repo dependency, and its
// `restrictToVerticalAxis` is a one-line transform clamp, so it is
// reimplemented locally rather than adding a package for a single helper.
// Without it, a worktree or workspace row's drag transform followed the raw
// pointer delta on both axes, so a diagonal drag visibly carried the row off
// to the side ("into the void") instead of only reordering it vertically
// (CAN-3053 regression). Keyboard drag is unaffected: its coordinate getter
// only ever produces vertical deltas for this list.
export const restrictToVerticalAxis: Modifier = ({ transform }) => ({
  ...transform,
  x: 0,
});

function useSortableSidebarSensors(): ReturnType<typeof useSensors> {
  return useSensors(
    useSensor(
      SORTABLE_SIDEBAR_FINE_POINTER_SENSOR,
      SORTABLE_SIDEBAR_POINTER_CONSTRAINT,
    ),
    useSensor(
      SORTABLE_SIDEBAR_COARSE_POINTER_SENSOR,
      SORTABLE_SIDEBAR_TOUCH_CONSTRAINT,
    ),
    useSensor(KeyboardSensor, {
      coordinateGetter: SORTABLE_SIDEBAR_KEYBOARD_COORDINATE_GETTER,
    }),
  );
}

export function resolveSortableDrop(
  activeId: string,
  overId: string | null,
  itemIds: ReadonlySet<string>,
  containerByItemId?: ReadonlyMap<string, string>,
): readonly [activeId: string, overId: string] | null {
  if (
    overId === null ||
    activeId === overId ||
    !itemIds.has(activeId) ||
    !itemIds.has(overId)
  ) {
    return null;
  }
  if (
    containerByItemId &&
    containerByItemId.get(activeId) !== containerByItemId.get(overId)
  ) {
    return null;
  }
  return [activeId, overId];
}

function sortableStyle(
  transform: ReturnType<typeof useSortable>['transform'],
  transition: ReturnType<typeof useSortable>['transition'],
): CSSProperties {
  return {
    transform: CSS.Transform.toString(transform),
    transition,
  };
}

/**
 * Projects hold still while one is dragged, as on the desktop rail: the drop
 * indicator previews the landing edge instead of the list reflowing. A
 * reflowing list moved the project under the pointer, which is what the
 * indicator is supposed to mark.
 */
const staticListSortingStrategy: SortingStrategy = () => null;

function isWorkspaceLabelDragActivator(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target
      .closest('[data-workspace-drag-activator]')
      ?.getAttribute('data-workspace-drag-activator') === 'label'
  );
}

interface PostDragClickGuardHandlers {
  readonly onPointerDownCapture: (
    event: ReactPointerEvent<HTMLElement>,
  ) => void;
  readonly onClickCapture: (event: ReactMouseEvent<HTMLElement>) => void;
  readonly onKeyDownCapture: (event: ReactKeyboardEvent<HTMLElement>) => void;
}

interface PostDragClickGuardState {
  armed: boolean;
  wasDragging: boolean;
  pointerHeld: boolean;
  disarmOnRelease: boolean;
  disarmTimer: ReturnType<typeof setTimeout> | null;
  stopWatchingRelease: (() => void) | null;
}

function cancelPostDragDisarm(guard: PostDragClickGuardState): void {
  guard.disarmOnRelease = false;
  if (guard.disarmTimer !== null) {
    clearTimeout(guard.disarmTimer);
    guard.disarmTimer = null;
  }
}

function disarmPostDragGuardNextTask(guard: PostDragClickGuardState): void {
  cancelPostDragDisarm(guard);
  guard.disarmTimer = setTimeout(() => {
    guard.disarmTimer = null;
    guard.armed = false;
  }, 0);
}

function watchPostDragPointerRelease(
  guard: PostDragClickGuardState,
  view: Window,
): void {
  guard.pointerHeld = true;
  if (guard.stopWatchingRelease) return;
  const handleRelease = (): void => {
    stop();
    guard.pointerHeld = false;
    if (guard.disarmOnRelease) disarmPostDragGuardNextTask(guard);
  };
  const stop = (): void => {
    view.removeEventListener('pointerup', handleRelease, true);
    view.removeEventListener('pointercancel', handleRelease, true);
    guard.stopWatchingRelease = null;
  };
  view.addEventListener('pointerup', handleRelease, true);
  view.addEventListener('pointercancel', handleRelease, true);
  guard.stopWatchingRelease = stop;
}

/**
 * Swallows the one click a pointer drag of this wrapper produces, so the drop
 * (or an Escape cancel) does not also toggle the section the user just moved.
 *
 * The guard is armed for the whole drag and lives until that click consumes
 * it, but never past the gesture: once the drag has ended AND its pointer is
 * released, it is dropped on the next task. The click a release produces is
 * dispatched with that release, ahead of the task, and a release outside the
 * wrapper delivers none here, so a later unrelated click is never eaten.
 *
 * Waiting for the release matters for an Escape-cancelled drag: it ends while
 * the pointer is still held, and its click only arrives with the eventual
 * release, arbitrarily later. A guard dropped one task after the cancel let
 * that click collapse the project whose drag was just cancelled. dnd-kit's
 * own post-drag click blocker cannot cover it: it lapses 50 ms after the
 * drag ends, and a drag that starts within 50 ms of the previous one never
 * gets one (the blocker is one shared listener, so the earlier drag's delayed
 * cleanup removes it).
 */
function usePostDragClickGuard(
  isDragging: boolean,
): PostDragClickGuardHandlers {
  const guardRef = useRef<PostDragClickGuardState>({
    armed: false,
    wasDragging: false,
    pointerHeld: false,
    disarmOnRelease: false,
    disarmTimer: null,
    stopWatchingRelease: null,
  });

  useEffect(() => {
    const guard = guardRef.current;
    if (isDragging) {
      guard.wasDragging = true;
      cancelPostDragDisarm(guard);
      guard.armed = true;
      return;
    }
    if (!guard.wasDragging) return;
    guard.wasDragging = false;
    if (guard.pointerHeld) {
      guard.disarmOnRelease = true;
    } else {
      disarmPostDragGuardNextTask(guard);
    }
  }, [isDragging]);

  useEffect(() => {
    const guard = guardRef.current;
    return (): void => {
      guard.stopWatchingRelease?.();
      cancelPostDragDisarm(guard);
    };
  }, []);

  return {
    onPointerDownCapture: (event): void => {
      // A fresh gesture drops any guard left armed by a drag whose click
      // never reached this wrapper.
      const guard = guardRef.current;
      cancelPostDragDisarm(guard);
      guard.armed = false;
      const view = event.currentTarget.ownerDocument.defaultView;
      if (view) watchPostDragPointerRelease(guard, view);
    },
    onClickCapture: (event): void => {
      const guard = guardRef.current;
      if (!guard.armed) return;
      guard.armed = false;
      event.preventDefault();
      event.stopPropagation();
    },
    onKeyDownCapture: (event): void => {
      // Keyboard activations synthesize their own click; a keyboard
      // reorder's terminating key never produces one to consume the guard.
      if (event.key === 'Enter' || event.key === ' ') {
        guardRef.current.armed = false;
      }
    },
  };
}

function SortableWorkspaceSection({
  context,
  children,
}: {
  readonly context: WorkspaceDndWrapperContext;
  readonly children: ReactNode;
}): JSX.Element {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: context.workspace.localId });
  // The header's name button doubles as a drag activator, as on desktop: a
  // press that travels past the sensor's distance threshold reorders the
  // workspace, while a plain click still toggles the section. dnd-kit only
  // listens on the handle, so the wrapper forwards the label's pointer-down.
  const clickGuard = usePostDragClickGuard(isDragging);
  const forwardLabelPointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    // Touch stays with the long-press sensor, as on worktree rows, so a
    // scroll that starts on a name never begins a reorder.
    if (event.pointerType === 'touch') return;
    if (!isWorkspaceLabelDragActivator(event.target)) return;
    listeners?.onPointerDown?.(event);
  };
  return (
    <WorkspaceSortableStateContext.Provider
      value={{ attributes, listeners, isDragging }}
    >
      <div
        ref={setNodeRef}
        role="listitem"
        style={sortableStyle(transform, transition)}
        data-workspace-sortable-wrapper={context.workspace.localId}
        data-dragging={isDragging || undefined}
        className={isDragging ? 'min-w-0 opacity-50' : 'min-w-0'}
        onPointerDownCapture={clickGuard.onPointerDownCapture}
        onPointerDown={forwardLabelPointerDown}
        onClickCapture={clickGuard.onClickCapture}
        onKeyDownCapture={clickGuard.onKeyDownCapture}
      >
        {children}
      </div>
    </WorkspaceSortableStateContext.Provider>
  );
}

function SortableWorktreeRow({
  context,
  children,
}: {
  readonly context: WorktreeRowSlotContext;
  readonly children: ReactNode;
}): JSX.Element {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: context.worktree.localId });
  const dropIndicator = useContext(WorktreeDropIndicatorContext);
  const isInteractiveTarget = (target: HTMLElement): boolean =>
    target.closest(
      'button, input, textarea, select, a, [contenteditable="true"], [tabindex]:not([data-sidebar-variant]), [role="button"]',
    ) !== null;
  const handlePointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    if (
      event.pointerType === 'touch' ||
      !(event.target instanceof HTMLElement) ||
      isInteractiveTarget(event.target)
    ) {
      return;
    }
    listeners?.onPointerDown?.(event);
  };
  const handleTouchStart = (event: ReactTouchEvent<HTMLDivElement>): void => {
    if (
      !(event.target instanceof HTMLElement) ||
      isInteractiveTarget(event.target)
    ) {
      return;
    }
    listeners?.onTouchStart?.(event);
  };
  return (
    <WorktreeSortableStateContext.Provider
      value={{ attributes, listeners, isDragging }}
    >
      <div
        ref={setNodeRef}
        role="listitem"
        style={sortableStyle(transform, transition)}
        data-worktree-sortable-wrapper={context.worktree.localId}
        data-dragging={isDragging || undefined}
        onPointerDown={handlePointerDown}
        onTouchStart={handleTouchStart}
        className={`relative min-w-0 select-none ${isDragging ? 'touch-none opacity-60' : 'touch-pan-y pointer-fine:touch-none'}`}
      >
        {dropIndicator?.id === context.worktree.localId && (
          <SidebarDropLine
            variant="worktree"
            position={dropIndicator.position}
            data-testid="worktree-drop-indicator"
            data-drop-position={dropIndicator.position}
          />
        )}
        <WorktreeRowDragCursorProvider isDragging={isDragging}>
          {children}
        </WorktreeRowDragCursorProvider>
      </div>
    </WorktreeSortableStateContext.Provider>
  );
}

function WorkspaceDragHandle({
  context,
  children,
}: {
  readonly context: WorkspaceSectionSlotContext;
  readonly children: ReactNode;
}): JSX.Element {
  const sortable = useContext(WorkspaceSortableStateContext);
  return (
    <button
      type="button"
      aria-label={`Reorder ${context.workspace.name}`}
      aria-roledescription="sortable"
      // The icon reads as the workspace glyph, not a grip: desktop keeps the
      // default cursor on both activators and lets the drag itself signal.
      className="focus-ring relative inline-flex h-5 w-5 shrink-0 cursor-default items-center justify-center rounded-md"
      data-workspace-drag-activator="icon"
      // No click swallowing here: a pointer click that never became a drag
      // must bubble to the header's row-background handler, which is what
      // makes the hover-revealed chevron toggle collapse (desktop's rule).
      // A post-drag click is already suppressed by the sortable header's
      // click-capture, and keyboard activation is filtered by the header.
      {...sortable?.attributes}
      {...sortable?.listeners}
    >
      {children}
    </button>
  );
}

function WorktreeDragHandle({
  context,
  children,
}: {
  readonly context: WorktreeRowSlotContext;
  readonly children: ReactNode;
}): JSX.Element {
  const sortable = useContext(WorktreeSortableStateContext);
  return (
    <button
      type="button"
      // "Move", not "Reorder": desktop names only its workspace handles
      // "Reorder …", and its automation finds a workspace's handle by that
      // prefix inside the workspace root — where these rows also live.
      aria-label={`Move ${sidebarRowLabel(context.workspace, context.worktree)}`}
      aria-roledescription="sortable"
      className="focus-ring h-4 w-4 cursor-grab rounded active:cursor-grabbing"
      onClick={(event) => event.stopPropagation()}
      {...sortable?.attributes}
      {...sortable?.listeners}
    >
      {children}
    </button>
  );
}

function WorktreeSortableContext({
  context,
  onReorder,
  children,
}: {
  readonly context: WorktreeDndWrapperContext;
  readonly onReorder: (
    workspaceId: string,
    activeId: string,
    overId: string,
  ) => void;
  readonly children: ReactNode;
}): JSX.Element {
  const sensors = useSortableSidebarSensors();
  const [dropIndicator, setDropIndicator] = useState<{
    readonly id: string;
    readonly position: 'before' | 'after';
  } | null>(null);
  // The dragged row, for the floating preview (desktop's worktree overlay).
  const [activeWorktreeId, setActiveWorktreeId] = useState<string | null>(null);
  // Only rows whose own capabilities allow reordering are registered, so a
  // non-reorderable row in a mixed list is neither draggable nor a drop target.
  const itemIds = [...context.sortableWorktreeIds];
  const itemIdSet = new Set(itemIds);
  const handleDragEnd = ({ active, over }: DragEndEvent): void => {
    setDropIndicator(null);
    setActiveWorktreeId(null);
    const activeId = String(active.id);
    const overId = over ? String(over.id) : null;
    const intent = resolveSortableDrop(
      activeId,
      overId,
      itemIdSet,
      context.containerByWorktreeId,
    );
    if (intent) onReorder(context.workspace.localId, ...intent);
  };
  const handleDragOver = ({ active, over }: DragOverEvent): void => {
    const activeId = String(active.id);
    const overId = over ? String(over.id) : null;
    if (
      !resolveSortableDrop(
        activeId,
        overId,
        itemIdSet,
        context.containerByWorktreeId,
      ) ||
      !overId
    ) {
      setDropIndicator(null);
      return;
    }
    const ids =
      context.containerByWorktreeId === undefined
        ? itemIds
        : itemIds.filter(
            (id) =>
              context.containerByWorktreeId?.get(id) ===
              context.containerByWorktreeId?.get(activeId),
          );
    const position =
      ids.indexOf(activeId) < ids.indexOf(overId) ? 'after' : 'before';
    setDropIndicator((current) => {
      if (current?.id === overId && current.position === position) {
        return current;
      }
      return { id: overId, position };
    });
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={SORTABLE_SIDEBAR_COLLISION_DETECTION}
      onDragStart={({ active }): void => setActiveWorktreeId(String(active.id))}
      modifiers={[restrictToVerticalAxis]}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={(): void => {
        setDropIndicator(null);
        setActiveWorktreeId(null);
      }}
    >
      {/* Portaled like the workspace preview, so the copy escapes the rail's
          hard-clipped rows wrapper; the in-flow row only dims. */}
      {typeof document === 'undefined' || !context.renderDragPreview
        ? null
        : createPortal(
            <DragOverlay dropAnimation={null}>
              {activeWorktreeId ? (
                <SidebarDragPreview
                  aria-hidden="true"
                  className="translate-x-1"
                  data-testid="worktree-drag-overlay"
                >
                  {context.renderDragPreview(activeWorktreeId)}
                </SidebarDragPreview>
              ) : null}
            </DragOverlay>,
            document.body,
          )}
      <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
        <WorktreeDropIndicatorContext.Provider value={dropIndicator}>
          {children}
        </WorktreeDropIndicatorContext.Provider>
      </SortableContext>
    </DndContext>
  );
}

function EnabledSortableWorkspacesSidebar({
  onReorderWorkspace,
  onReorderWorktree,
  renderWorkspaceDragHandleContent,
  ...sectionsProps
}: SortableWorkspacesSidebarProps & {
  readonly onReorderWorkspace: (activeId: string, overId: string) => void;
  readonly onReorderWorktree: (
    workspaceId: string,
    activeId: string,
    overId: string,
  ) => void;
}): JSX.Element | null {
  const sensors = useSortableSidebarSensors();
  // Mounting this wrapper IS a host's opt-in to reordering, so without a
  // per-row resolver the flat capability is raised to match (unchanged
  // behavior). A host that supplies `capabilitiesFor` is the authority on
  // which rows reorder, and raising the fallback there would widen its answer.
  const hasRowResolver = sectionsProps.capabilitiesFor !== undefined;
  const fallbackCapabilities = hasRowResolver
    ? sectionsProps.capabilities
    : {
        ...sectionsProps.capabilities,
        workspaceReordering: true,
        worktreeReordering: true,
      };
  const resolveCapabilities = (localId: string): CanopyCapabilities =>
    sectionsProps.capabilitiesFor?.(localId) ?? fallbackCapabilities;
  const itemIds = partitionWorkspaces(
    sectionsProps.state.workspaces,
    sectionsProps.state.worktrees,
    {
      includeFlat: sectionsProps.renderCoworkWorkspace !== undefined,
      visibleWorkspaceIds: sectionsProps.visibleWorkspaceIds,
      context: sectionsProps.context,
      linkedPersonalWorkspaceIds: sectionsProps.linkedPersonalWorkspaceIds,
      standaloneChats: sectionsProps.state.standaloneChats,
    },
  )
    .visible.filter(
      (workspace) =>
        resolveCapabilities(workspace.localId).workspaceReordering === true &&
        // Same per-row split on the transient axis: a row whose host cannot
        // accept commands right now must be neither draggable nor a drop
        // target, without withdrawing reorder from the rest of a mixed list.
        sectionsProps.isWorkspaceCommandDisabled?.(workspace.localId) !== true,
    )
    .map((workspace) => workspace.localId);
  const itemIdSet = new Set(itemIds);
  // The dragged workspace, for the document-level preview. dnd-kit's
  // DragOverlay is portaled to the body, so the preview escapes the rail's
  // hard-clipped rows wrapper the way the desktop's overlay does; the flow
  // section keeps its footprint (it only dims) while the copy follows the
  // pointer.
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(
    null,
  );
  const activeWorkspace =
    activeWorkspaceId === null
      ? undefined
      : sectionsProps.state.workspaces.find(
          (workspace) => workspace.localId === activeWorkspaceId,
        );
  const [dropIndicator, setDropIndicator] =
    useState<WorkspaceDropIndicatorState | null>(null);
  const handleDragOver = ({ active, over }: DragOverEvent): void => {
    const activeId = String(active.id);
    const overId = over ? String(over.id) : null;
    if (!overId || !resolveSortableDrop(activeId, overId, itemIdSet)) {
      setDropIndicator(null);
      return;
    }
    const position =
      itemIds.indexOf(activeId) < itemIds.indexOf(overId) ? 'after' : 'before';
    setDropIndicator((current) =>
      current?.workspaceLocalId === overId && current.position === position
        ? current
        : { workspaceLocalId: overId, position },
    );
  };
  const handleDragEnd = ({ active, over }: DragEndEvent): void => {
    setActiveWorkspaceId(null);
    setDropIndicator(null);
    const activeId = String(active.id);
    const overId = over ? String(over.id) : null;
    const intent = resolveSortableDrop(activeId, overId, itemIdSet);
    if (intent) onReorderWorkspace(...intent);
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={SORTABLE_SIDEBAR_COLLISION_DETECTION}
      modifiers={[restrictToVerticalAxis]}
      onDragStart={({ active }): void =>
        setActiveWorkspaceId(String(active.id))
      }
      onDragOver={handleDragOver}
      onDragCancel={(): void => {
        setActiveWorkspaceId(null);
        setDropIndicator(null);
      }}
      onDragEnd={handleDragEnd}
    >
      {/* dnd-kit renders the overlay where it is declared; portal it to the
          document so it escapes the rail's hard-clipped rows wrapper, as the
          desktop section's preview does. A server render has no document to
          portal into, and never has a drag to preview. */}
      {typeof document === 'undefined'
        ? null
        : createPortal(
            <DragOverlay dropAnimation={null}>
              {activeWorkspace ? (
                <SidebarDragPreview
                  aria-hidden="true"
                  variant="workspace"
                  className="translate-x-1"
                  data-sidebar-workspace-drag-overlay-id={
                    activeWorkspace.localId
                  }
                  data-testid="workspace-drag-overlay"
                >
                  <WorkspaceSectionHeader
                    name={activeWorkspace.name}
                    colorHex={workspaceColor(activeWorkspace)}
                    workspaceType={workspaceKind(activeWorkspace)}
                    temporary={activeWorkspace.temporary === true}
                    worktreeCount={
                      worktreesForWorkspace(
                        sectionsProps.state,
                        activeWorkspace.localId,
                      ).length
                    }
                    pinnedToTop={
                      sectionsProps.isWorkspacePinned?.(
                        activeWorkspace.localId,
                      ) === true
                    }
                    textScale="sidebar"
                    // A fifth copy of the header while dragging; suffix its fixed
                    // ids so the bare ones still resolve to the in-flow header.
                    testIdSuffix="-drag-overlay"
                    collapsed={activeWorkspace.collapsed === true}
                    canToggleCollapse={false}
                    disableDrag
                    showCollapseChevron={false}
                    onToggleCollapse={(): void => undefined}
                    dragHandleSlot={
                      <span className="relative inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full">
                        {renderWorkspaceDragHandleContent?.({
                          workspace: activeWorkspace,
                          selected: false,
                          hidden: false,
                          sortable: true,
                          collapsed: activeWorkspace.collapsed === true,
                          testIdSuffix: '-drag-overlay',
                        })}
                      </span>
                    }
                  />
                </SidebarDragPreview>
              ) : null}
            </DragOverlay>,
            document.body,
          )}
      <SortableContext items={itemIds} strategy={staticListSortingStrategy}>
        <WorkspaceDropIndicatorContext.Provider value={dropIndicator}>
          <WorkspacesSidebarSections
            {...sectionsProps}
            capabilities={fallbackCapabilities}
            onReorderGroupedChild={onReorderWorktree}
            renderWorkspaceDragHandle={(context) => (
              <WorkspaceDragHandle context={context}>
                {renderWorkspaceDragHandleContent?.(context)}
              </WorkspaceDragHandle>
            )}
            wrapWorkspaceSection={(context, section) => (
              <SortableWorkspaceSection
                key={context.workspace.localId}
                context={context}
              >
                {section}
              </SortableWorkspaceSection>
            )}
            renderWorktreeDragHandle={(context) =>
              context.sortable ? (
                <WorktreeDragHandle context={context}>
                  {null}
                </WorktreeDragHandle>
              ) : null
            }
            wrapWorktreeList={(context, list) =>
              context.sortableWorktreeIds.length === 0 ? (
                list
              ) : (
                <WorktreeSortableContext
                  context={context}
                  onReorder={onReorderWorktree}
                >
                  {list}
                </WorktreeSortableContext>
              )
            }
            wrapWorktreeRow={(context, row) => (
              <SortableWorktreeRow
                key={context.worktree.localId}
                context={context}
              >
                {row}
              </SortableWorktreeRow>
            )}
          />
        </WorkspaceDropIndicatorContext.Provider>
      </SortableContext>
    </DndContext>
  );
}

export function SortableWorkspacesSidebar(
  props: SortableWorkspacesSidebarProps,
): JSX.Element | null {
  if (
    props.onReorderWorkspace === undefined ||
    props.onReorderWorktree === undefined
  ) {
    const {
      onReorderWorkspace,
      onReorderWorktree,
      renderWorkspaceDragHandleContent,
      ...sectionProps
    } = props;
    void onReorderWorkspace;
    void onReorderWorktree;
    void renderWorkspaceDragHandleContent;
    // No DnD wrapper is mounted, so no row can be sortable regardless of what
    // its own client reports — the narrowing rides along the resolver too.
    const rowCapabilities = props.capabilitiesFor;
    return (
      <WorkspacesSidebarSections
        {...sectionProps}
        capabilities={{
          ...props.capabilities,
          workspaceReordering: false,
          worktreeReordering: false,
        }}
        capabilitiesFor={
          rowCapabilities
            ? (localId): CanopyCapabilities => ({
                ...rowCapabilities(localId),
                workspaceReordering: false,
                worktreeReordering: false,
              })
            : undefined
        }
      />
    );
  }
  return (
    <EnabledSortableWorkspacesSidebar
      {...props}
      onReorderWorkspace={props.onReorderWorkspace}
      onReorderWorktree={props.onReorderWorktree}
    />
  );
}
