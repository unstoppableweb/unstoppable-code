'use client';

import {
  useEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEventHandler,
  type PointerEventHandler,
  type ReactNode,
} from 'react';
import {
  closestCenter,
  DndContext,
  DragOverlay,
  defaultDropAnimationSideEffects,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  defaultAnimateLayoutChanges,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  QUEUED_MESSAGE_TRAY_CLASS,
  type QueuedMessageReorderProps,
  ErrorBanner,
} from '@canopy/ui-shared/components';

export const QUEUED_MESSAGE_REORDER_ERROR =
  "Couldn't reorder queued messages. Try again.";

export interface QueuedMessageStackProps {
  /** Queue entry ids, in queue order. */
  readonly ids: readonly string[];
  /**
   * Moves `id` before `beforeId` (`null` for the end). Omit only where the
   * host can't reorder this queue at all; the rows then have no handle. A
   * row that can't move for now says why through `moveUnavailableReason`.
   */
  readonly onMove?: (id: string, beforeId: string | null) => Promise<void>;
  /**
   * Why a row can't move right now (not queued yet, an edit is open). It
   * keeps its handle, disabled, with the reason; the other rows still move,
   * and a move never anchors on it.
   */
  readonly moveUnavailableReason?: (id: string) => string | undefined;
  /** Renders one row; `reorder` is set only while it can be reordered. */
  readonly renderRow: (
    id: string,
    reorder: QueuedMessageReorderProps | undefined,
  ) => ReactNode;
  /** Shown under the list, outside the tray: the editor of a queued row. */
  readonly children?: ReactNode;
  /**
   * `tray` (default): its own card behind the composer. `drawer`: the
   * Queued tab of `ComposerWorkDrawer`, which draws the surface; rows render
   * with `surface="drawer"`, and the lifted row glides into its slot.
   */
  readonly surface?: 'tray' | 'drawer';
  readonly 'data-testid'?: string;
}

function isPointerListener(
  listener: unknown,
): listener is PointerEventHandler<HTMLElement> {
  return typeof listener === 'function';
}

function isKeyboardListener(
  listener: unknown,
): listener is KeyboardEventHandler<HTMLElement> {
  return typeof listener === 'function';
}

/** Decelerating into place (DESIGN.md: entering motion decelerates). */
const DROP_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';

/**
 * Release, in the drawer: the lifted row glides from the pointer into its
 * new slot over 200ms (transform only); its slot fades back in under it.
 */
const DROP_ANIMATION = {
  duration: 200,
  easing: DROP_EASING,
  sideEffects: defaultDropAnimationSideEffects({
    styles: { active: { opacity: '0' } },
  }),
};

function SortableQueuedRow({
  id,
  renderRow,
  overlay,
  unavailableReason,
}: {
  readonly id: string;
  readonly renderRow: QueuedMessageStackProps['renderRow'];
  /** A `DragOverlay` draws the lifted row; this one keeps its slot open. */
  readonly overlay: boolean;
  readonly unavailableReason: string | undefined;
}): JSX.Element {
  const sortable = useSortable({
    id,
    disabled: unavailableReason !== undefined,
    // Siblings slide while dragging; the released row lands without a second
    // animation when the committed order arrives.
    animateLayoutChanges: (args): boolean =>
      args.isSorting && defaultAnimateLayoutChanges(args),
    transition: overlay ? { duration: 200, easing: DROP_EASING } : undefined,
  });
  const onPointerDown = sortable.listeners?.onPointerDown;
  const onKeyDown = sortable.listeners?.onKeyDown;
  return (
    <div
      ref={sortable.setNodeRef}
      className="relative motion-reduce:!transition-none"
      style={{
        transform: CSS.Translate.toString(sortable.transform),
        transition: sortable.transition,
        zIndex: sortable.isDragging ? 1 : undefined,
        opacity: overlay && sortable.isDragging ? 0 : undefined,
      }}
    >
      {renderRow(id, {
        handleProps: {
          'aria-describedby': sortable.attributes['aria-describedby'],
          'aria-roledescription': sortable.attributes['aria-roledescription'],
          'aria-pressed': sortable.attributes['aria-pressed'],
          onPointerDown: isPointerListener(onPointerDown)
            ? onPointerDown
            : undefined,
          onKeyDown: isKeyboardListener(onKeyDown) ? onKeyDown : undefined,
        },
        dragging: sortable.isDragging,
        ...(unavailableReason === undefined ? {} : { unavailableReason }),
      })}
    </div>
  );
}

/**
 * The compact queue behind the composer (Compact queue Labs experiment): one
 * card of one-line rows that tucks under the composer box's top edge. A row
 * reorders by its drag handle, with the pointer or, focused, the keyboard;
 * the new order shows at once and holds until the host's committed order
 * replaces it, or falls back with a short error when the move fails.
 */
export function QueuedMessageStack({
  ids,
  onMove,
  moveUnavailableReason,
  renderRow,
  children,
  surface = 'tray',
  'data-testid': testId = 'queued-message-stack',
}: QueuedMessageStackProps): JSX.Element {
  const drawer = surface === 'drawer';
  const [lifted, setLifted] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const [error, setError] = useState(false);
  const [pending, setPending] = useState<{
    readonly source: readonly string[];
    readonly next: readonly string[];
  } | null>(null);
  const saving = useRef(false);
  // Show the dragged order only over the snapshot it was made from; any other
  // host change (the committed order, a drained row) supersedes it.
  const projected =
    pending !== null &&
    pending.source.length === ids.length &&
    pending.source.every((id, index) => ids[index] === id);
  const order = projected ? pending.next : ids;
  useEffect(() => {
    if (pending !== null && !projected) setPending(null);
  }, [pending, projected]);
  const reorderable = onMove !== undefined && ids.length > 1;
  // One move at a time, from the order on screen.
  const move = (from: number, to: number): void => {
    if (!onMove || saving.current || from === to || to < 0) return;
    const id = order[from];
    if (id === undefined || to >= order.length) return;
    const next = arrayMove([...order], from, to);
    // Anchor on the next row that can move: one that can't (not queued yet)
    // isn't in the host's queue to move before.
    const before =
      next
        .slice(to + 1)
        .find(
          (candidate) => moveUnavailableReason?.(candidate) === undefined,
        ) ?? null;
    setError(false);
    setPending({ source: ids, next });
    saving.current = true;
    onMove(id, before)
      .catch((): void => {
        setPending(null);
        setError(true);
      })
      .finally((): void => {
        saving.current = false;
      });
  };
  return (
    <div className="flex flex-col gap-2 empty:hidden" data-testid={testId}>
      {ids.length > 0 ? (
        <div
          role="list"
          aria-label="Queued messages"
          // In the drawer the tab's own list scrolls; the tray caps itself.
          className={
            drawer
              ? 'flex flex-col'
              : `${QUEUED_MESSAGE_TRAY_CLASS} max-h-[min(40vh,20rem)] overflow-y-auto`
          }
        >
          {error ? (
            <div className="px-3 py-2">
              <ErrorBanner
                errorSource="queued-message-stack-reorder"
                className=""
                error={QUEUED_MESSAGE_REORDER_ERROR}
              />
            </div>
          ) : null}
          {reorderable ? (
            <DndContext
              sensors={projected ? [] : sensors}
              collisionDetection={closestCenter}
              onDragStart={({ active }): void => {
                setError(false);
                setLifted(String(active.id));
              }}
              onDragCancel={(): void => setLifted(null)}
              onDragEnd={({ active, over }): void => {
                setLifted(null);
                if (!over || active.id === over.id) return;
                move(
                  order.indexOf(String(active.id)),
                  order.indexOf(String(over.id)),
                );
              }}
            >
              <SortableContext
                items={[...order]}
                strategy={verticalListSortingStrategy}
              >
                {order.map((id) => (
                  <SortableQueuedRow
                    key={id}
                    id={id}
                    renderRow={renderRow}
                    overlay={drawer}
                    unavailableReason={moveUnavailableReason?.(id)}
                  />
                ))}
              </SortableContext>
              {drawer && (
                // The lifted row follows the pointer with the same actions
                // as the row in its slot, so lifting changes only the fill.
                <DragOverlay dropAnimation={DROP_ANIMATION}>
                  {lifted !== null
                    ? renderRow(lifted, { handleProps: {}, dragging: true })
                    : null}
                </DragOverlay>
              )}
            </DndContext>
          ) : (
            order.map((id) => (
              <div key={id} className="relative">
                {renderRow(id, undefined)}
              </div>
            ))
          )}
        </div>
      ) : null}
      {children}
    </div>
  );
}
