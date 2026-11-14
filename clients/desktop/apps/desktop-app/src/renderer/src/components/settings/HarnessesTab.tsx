import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  isCursorHarnessReleased,
  getCursorSettingsSection,
} from '@/lib/cursor-settings';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import type {
  ModelHarness,
  ModelHarnessAssignment,
} from '@canopy/desktop-shared/types';
import {
  getModelDisplayName,
  isModelHarness,
} from '@canopy/desktop-shared/types';
import { useCursorChatAvailable } from '@/hooks/useCursorChatAvailable';
import { useCursorModels } from '@/hooks/useCursorModels';
import {
  Button,
  ErrorState,
  FLOATING_MENU_GAP,
  FloatingMenu,
  ModelGroupHeader,
} from '@canopy/ui-shared';
import {
  ActionMenuItems,
  ActionMenuRowStyle,
  type ActionMenuItem,
  Heading,
} from '@canopy/ui-shared/components';
import {
  ForwardIcon,
  Lock,
  MoreHorizontalIcon,
  RevertIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { ModelProviderIcon } from '@canopy/ui-shared/components';
import { getProviderLabel } from '@/lib/providerLabels';
import { BrandLogo } from '@/components/BrandLogo';
import { DesktopErrorBanner } from '@/components/shared/DesktopErrorBanner';
import { brandText } from '@/lib/brand';
import { useModelCatalogStore } from '@/stores/modelCatalogStore';
import {
  SettingsLoading,
  SettingsPage,
  SettingsSection,
} from './SettingsLayout';

function destinations(row: ModelHarnessAssignment): ModelHarness[] {
  return (
    row.availableHarnesses ??
    (row.configurable ? ['claude', 'codex'] : [row.harness])
  );
}

const ARROW_CODES = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
]);

function harnessLabel(harness: ModelHarness): string {
  return getProviderLabel(harness);
}

interface HarnessGroup {
  key: string;
  /**
   * Accessible name for the group. Managed groups render no visible heading,
   * so for them this reaches the user only through the wrapper's
   * `role="group"`/`aria-label` — which is where `ModelGroupHeader` announces
   * every group's name anyway, so suppressing the heading costs nothing to
   * screen readers.
   */
  label: string;
  /** Omitted for managed groups, which render no heading to put it in. */
  icon?: JSX.Element;
  /** Source headings are optional when the model labels identify the source. */
  showHeader: boolean;
  rows: ModelHarnessAssignment[];
}

/** Keep native models first, then gateway and local models, within each harness. */
function buildGroups(
  assignments: readonly ModelHarnessAssignment[],
  harness: ModelHarness,
): HarnessGroup[] {
  const inColumn = assignments.filter(
    (assignment) => assignment.harness === harness,
  );
  const bySource = (
    source: ModelHarnessAssignment['source'],
  ): ModelHarnessAssignment[] =>
    inColumn.filter((assignment) => assignment.source === source);
  const gatewayRows = bySource('ai-gateway')
    .slice()
    .sort((a, b) =>
      getModelDisplayName(a.modelId).localeCompare(
        getModelDisplayName(b.modelId),
      ),
    );
  const groups: HarnessGroup[] = [
    {
      key: 'claude-managed',
      label: getProviderLabel('claude'),
      showHeader: false,
      rows: bySource('claude-managed'),
    },
    {
      key: 'codex-managed',
      label: getProviderLabel('codex'),
      showHeader: false,
      rows: bySource('codex-managed'),
    },
    {
      key: 'cursor-managed',
      label: getProviderLabel('cursor'),
      showHeader: false,
      rows: bySource('cursor-managed'),
    },
    {
      key: 'ai-gateway',
      label: brandText.appName,
      icon: <BrandLogo size={10} aria-hidden />,
      showHeader: true,
      rows: gatewayRows,
    },
    {
      key: 'ollama',
      label: getProviderLabel('ollama'),
      icon: (
        <ModelProviderIcon provider="ollama" central width={10} height={10} />
      ),
      showHeader: true,
      rows: bySource('ollama'),
    },
  ];
  return groups.filter((group) => group.rows.length > 0);
}

export function HarnessesTab(): JSX.Element {
  const modelGatewayEnforced = useModelCatalogStore(
    (state) => state.modelGatewayEnforced,
  );
  const cursorReleased = useFeatureFlagsStore(isCursorHarnessReleased);
  const cursorRuntimeAvailable = useCursorChatAvailable(true);
  const cursorAvailable = cursorRuntimeAvailable && !modelGatewayEnforced;
  useCursorModels(cursorAvailable, true);
  const showCursor =
    cursorAvailable || (cursorReleased && !modelGatewayEnforced);
  const columns: readonly ModelHarness[] = showCursor
    ? ['claude', 'codex', 'cursor']
    : ['claude', 'codex'];
  const assignments = useModelCatalogStore((s) => s.harnessAssignments);
  const loadState = useModelCatalogStore((s) => s.harnessAssignmentsLoadState);
  const saveFailed = useModelCatalogStore((s) => s.harnessSaveFailed);
  const loadHarnessAssignments = useModelCatalogStore(
    (s) => s.loadHarnessAssignments,
  );
  const setModelHarness = useModelCatalogStore((s) => s.setModelHarness);
  const resetModelHarness = useModelCatalogStore((s) => s.resetModelHarness);

  useEffect(() => {
    void loadHarnessAssignments();
  }, [loadHarnessAssignments]);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [keyboardActiveId, setKeyboardActiveId] = useState<string | null>(null);
  const [keyboardDestination, setKeyboardDestination] =
    useState<ModelHarness | null>(null);
  const [keyboardAnnouncement, setKeyboardAnnouncement] = useState('');

  const sensors = useSensors(
    // The activation distance lets clicks (the row's ellipsis menu) resolve
    // without beginning a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const rows = useMemo(() => {
    const entries = assignments?.assignments ?? [];
    if (cursorAvailable) return entries;
    return entries
      .filter((row) => row.source !== 'cursor-managed')
      .map((row) => {
        const availableHarnesses = destinations(row).filter(
          (harness) => harness !== 'cursor',
        );
        return {
          ...row,
          availableHarnesses,
          configurable: availableHarnesses.length > 1,
          harness: row.harness === 'cursor' ? row.defaultHarness : row.harness,
        };
      });
  }, [assignments, cursorAvailable]);

  const rowById = useCallback(
    (id: UniqueIdentifier): ModelHarnessAssignment | undefined =>
      rows.find((assignment) => assignment.modelId === String(id)),
    [rows],
  );

  const handleBoardKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      if (!keyboardActiveId) {
        return;
      }
      const row = rowById(keyboardActiveId);
      if (!row?.configurable) {
        return;
      }
      const label = getModelDisplayName(row.modelId);
      if (ARROW_CODES.has(event.code)) {
        const choices = destinations(row);
        const position = choices.indexOf(keyboardDestination ?? row.harness);
        const direction =
          event.code === 'ArrowLeft' || event.code === 'ArrowUp' ? -1 : 1;
        const destination =
          choices[(position + direction + choices.length) % choices.length];
        setKeyboardDestination(destination);
        setKeyboardAnnouncement(
          `${label} is over the ${harnessLabel(destination)} column.`,
        );
      } else if (event.code === 'Enter' || event.code === 'Space') {
        if (keyboardDestination && keyboardDestination !== row.harness) {
          void setModelHarness(row.modelId, keyboardDestination);
          setKeyboardAnnouncement(
            `${label} was moved to the ${harnessLabel(keyboardDestination)} column.`,
          );
        } else {
          setKeyboardAnnouncement(
            `${label} was dropped. No changes were made.`,
          );
        }
        setKeyboardActiveId(null);
        setKeyboardDestination(null);
      } else if (event.code === 'Escape') {
        setKeyboardActiveId(null);
        setKeyboardDestination(null);
        setKeyboardAnnouncement(
          `Dragging was cancelled. ${label} stayed in the ${harnessLabel(row.harness)} column.`,
        );
      } else {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    },
    [keyboardActiveId, keyboardDestination, rowById, setModelHarness],
  );

  const handleKeyboardDragStart = useCallback(
    (assignment: ModelHarnessAssignment): void => {
      setKeyboardActiveId(assignment.modelId);
      setKeyboardDestination(null);
      setKeyboardAnnouncement(
        `Picked up ${getModelDisplayName(assignment.modelId)}. It is currently in the ${harnessLabel(assignment.harness)} column.`,
      );
    },
    [],
  );

  const columnName = useCallback((id: UniqueIdentifier | undefined): string => {
    return isModelHarness(id) ? harnessLabel(id) : 'no';
  }, []);

  const announcements: Announcements = useMemo(
    () => ({
      onDragStart({ active }): string {
        const row = rowById(active.id);
        const label = getModelDisplayName(String(active.id));
        return row
          ? `Picked up ${label}. It is currently in the ${harnessLabel(row.harness)} column.`
          : `Picked up ${label}.`;
      },
      onDragOver({ active, over }): string {
        const label = getModelDisplayName(String(active.id));
        return over
          ? `${label} is over the ${columnName(over.id)} column.`
          : `${label} is not over a column.`;
      },
      onDragEnd({ active, over }): string {
        const row = rowById(active.id);
        const label = getModelDisplayName(String(active.id));
        if (
          over &&
          isModelHarness(over.id) &&
          row &&
          destinations(row).includes(over.id) &&
          over.id !== row.harness
        ) {
          return `${label} was moved to the ${columnName(over.id)} column.`;
        }
        return `${label} was dropped. No changes were made.`;
      },
      onDragCancel({ active }): string {
        const row = rowById(active.id);
        const label = getModelDisplayName(String(active.id));
        return row
          ? `Dragging was cancelled. ${label} stayed in the ${harnessLabel(row.harness)} column.`
          : `Dragging was cancelled.`;
      },
    }),
    [columnName, rowById],
  );

  const handleDragStart = useCallback((event: DragStartEvent): void => {
    setKeyboardActiveId(null);
    setKeyboardDestination(null);
    setActiveId(String(event.active.id));
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent): void => {
      setActiveId(null);
      const { active, over } = event;
      const destination = isModelHarness(over?.id) ? over.id : null;
      if (!destination) {
        return;
      }
      const row = rowById(active.id);
      // Same-column drops are deliberate no-ops.
      if (
        !row ||
        !row.configurable ||
        row.harness === destination ||
        !destinations(row).includes(destination)
      ) {
        return;
      }
      void setModelHarness(row.modelId, destination);
    },
    [rowById, setModelHarness],
  );

  const handleDragCancel = useCallback((): void => {
    setActiveId(null);
  }, []);

  const handleMove = useCallback(
    (assignment: ModelHarnessAssignment, harness: ModelHarness): void => {
      void setModelHarness(assignment.modelId, harness);
    },
    [setModelHarness],
  );

  const handleReset = useCallback(
    (assignment: ModelHarnessAssignment): void => {
      void resetModelHarness(assignment.modelId);
    },
    [resetModelHarness],
  );

  const loading =
    assignments === null && (loadState === 'idle' || loadState === 'loading');
  const fatal = assignments === null && loadState === 'error';

  return (
    <SettingsPage
      title="Default harness"
      description="Choose the default harness for each model. Only supported harnesses are available."
      dataTestId="settings-tab-harnesses"
    >
      {/*
        The board is the section body, not a settings group: its harness
        columns are drop targets side by side, so each column is its own box
        on the group surface instead of a row inside one.
      */}
      <SettingsSection description="You can change the harness when starting a new chat. Active chats keep the harness they started with.">
        <DesktopErrorBanner
          errorSource="harness-save-error"
          className=""
          error={
            saveFailed
              ? 'Couldn’t save that harness change. The previous assignment was restored.'
              : null
          }
          testId="harness-save-error"
        />

        {loading && <SettingsLoading dataTestId="harness-loading" />}

        {fatal && (
          <ErrorState
            message="Couldn't load harness assignments."
            onRetry={(): void => {
              void loadHarnessAssignments();
            }}
            testId="harness-load-error"
            retryTestId="harness-retry"
          />
        )}

        {assignments !== null && (
          <DndContext
            sensors={sensors}
            collisionDetection={rectIntersection}
            accessibility={{
              announcements,
              screenReaderInstructions: {
                draggable:
                  'To pick up a configurable model, press Space or Enter. While dragging, press any arrow key to move between supported harness columns, press Space or Enter again to drop it, or press Escape to cancel.',
              },
            }}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}
          >
            {/*
            Narrow widths keep the harness columns side by side: the grid has a
            minimum inner width and this focusable region scrolls horizontally
            instead of stacking the columns.

            The scroll container clips the columns' drop-highlight ring, which
            paints outside their border box: top/left overflow is unreachable
            in a scroll container, and a box-shadow never extends the
            scrollable width, so the right edge is clipped too. Inset padding
            gives the ring room; matching negative margins keep the columns
            aligned with the surrounding copy.
          */}
            <div
              role="region"
              aria-label="Harness assignments"
              tabIndex={0}
              data-testid="harness-columns-scroller"
              onKeyDownCapture={handleBoardKeyDown}
              className="focus-ring -mx-1 -mt-1 overflow-x-auto px-1 pb-2 pt-1"
            >
              <div
                className={`grid gap-4 ${showCursor ? 'min-w-180 grid-cols-3' : 'min-w-140 grid-cols-2'}`}
              >
                {columns.map((harness) => (
                  <HarnessColumn
                    key={harness}
                    harness={harness}
                    onConnect={
                      harness === 'cursor' && !cursorAvailable
                        ? (): void =>
                            useNavigationStore
                              .getState()
                              .openSettings(getCursorSettingsSection())
                        : undefined
                    }
                    groups={buildGroups(rows, harness)}
                    forceHighlight={keyboardDestination === harness}
                    onKeyboardDragStart={handleKeyboardDragStart}
                    onMove={handleMove}
                    onReset={handleReset}
                  />
                ))}
              </div>
            </div>
            <DragOverlay dropAnimation={null}>
              {activeId ? (
                <div
                  data-testid="harness-drag-overlay"
                  className="flex h-8 cursor-grabbing items-center rounded-md bg-card px-2 text-s fg-primary shadow-lg"
                >
                  {getModelDisplayName(activeId)}
                </div>
              ) : null}
            </DragOverlay>
            {keyboardActiveId && (
              // Decorative: the live region below announces the move.
              <div
                aria-hidden="true"
                data-testid="harness-drag-overlay"
                className="pointer-events-none fixed left-1/2 top-6 z-toast flex h-8 -translate-x-1/2 items-center rounded-md bg-card px-2 text-s fg-primary shadow-lg"
              >
                {getModelDisplayName(keyboardActiveId)}
              </div>
            )}
            <div className="sr-only" aria-live="assertive" aria-atomic="true">
              {keyboardAnnouncement}
            </div>
          </DndContext>
        )}
      </SettingsSection>
    </SettingsPage>
  );
}

interface HarnessColumnProps {
  harness: ModelHarness;
  groups: HarnessGroup[];
  onConnect?: () => void;
  forceHighlight: boolean;
  onKeyboardDragStart: (assignment: ModelHarnessAssignment) => void;
  onMove: (assignment: ModelHarnessAssignment, harness: ModelHarness) => void;
  onReset: (assignment: ModelHarnessAssignment) => void;
}

function HarnessColumn({
  harness,
  groups,
  onConnect,
  forceHighlight,
  onKeyboardDragStart,
  onMove,
  onReset,
}: HarnessColumnProps): JSX.Element {
  const { setNodeRef, isOver } = useDroppable({
    id: harness,
    disabled: Boolean(onConnect),
  });
  const headingId = `harness-column-heading-${harness}`;
  const highlighted = !onConnect && (isOver || forceHighlight);

  // Each column sits on the settings group surface (secondary fill, hairline
  // edge) so the board reads like the rest of the grouped page. Rings, not
  // border colors: `border-<color>` is inert in this app, so the resting
  // outline and the drop highlight are rings.
  return (
    <section
      ref={setNodeRef}
      aria-labelledby={headingId}
      data-testid={`harness-column-${harness}`}
      data-drop-highlight={highlighted ? 'true' : undefined}
      className={`flex flex-col gap-2 rounded-lg bg-secondary p-3 transition-colors ${
        highlighted
          ? 'ring-1 ring-line-accent'
          : 'ring-[length:var(--border-hairline)] ring-line-base'
      }`}
    >
      <div className="flex items-center gap-2 px-2">
        <ModelProviderIcon provider={harness} central size="sm" />
        <Heading level={2} variant="title" id={headingId}>
          {harnessLabel(harness)}
        </Heading>
      </div>
      {onConnect ? (
        <div className="px-2 py-4">
          <Button
            size="compact"
            variant="secondary"
            data-testid={`harness-connect-${harness}`}
            onClick={onConnect}
          >
            Connect {harnessLabel(harness)}
          </Button>
        </div>
      ) : groups.length === 0 ? (
        <p
          className="px-2 py-4 text-s fg-secondary"
          data-testid={`harness-column-empty-${harness}`}
        >
          No models assigned to this harness.
        </p>
      ) : (
        groups.map((group) => (
          <div
            key={group.key}
            role="group"
            aria-label={group.label}
            data-testid={`harness-group-${group.key}-${harness}`}
          >
            {group.showHeader && (
              <ModelGroupHeader
                label={group.label}
                icon={group.icon}
                iconTestId={`harness-group-icon-${group.key}-${harness}`}
                labelTestId={`harness-group-label-${group.key}-${harness}`}
              />
            )}
            <div>
              {group.rows.map((assignment) =>
                assignment.configurable ? (
                  <ConfigurableHarnessRow
                    key={assignment.modelId}
                    assignment={assignment}
                    onKeyboardDragStart={onKeyboardDragStart}
                    onMove={onMove}
                    onReset={onReset}
                  />
                ) : (
                  <ManagedHarnessRow
                    key={assignment.modelId}
                    assignment={assignment}
                  />
                ),
              )}
            </div>
          </div>
        ))
      )}
    </section>
  );
}

/**
 * Row for a model supported by a single harness: no drag listeners, no actions
 * menu. The lock is conveyed by icon, tooltip, and screen-reader text so the
 * status never relies on the icon alone.
 */
interface ManagedHarnessRowProps {
  assignment: ModelHarnessAssignment;
}

function ManagedHarnessRow({
  assignment,
}: ManagedHarnessRowProps): JSX.Element {
  const label = getModelDisplayName(assignment.modelId);
  const managedBy = `Managed by ${getProviderLabel(assignment.harness)}`;
  return (
    <div
      data-testid={`harness-row-${assignment.modelId}`}
      data-harness-row-kind="managed"
      className="flex h-8 items-center gap-2 px-2 text-s fg-primary/80"
      title={managedBy}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="flex h-6 w-6 shrink-0 items-center justify-center fg-tertiary">
        <Lock size="sm" aria-hidden="true" />
        <span className="sr-only">{managedBy}</span>
      </span>
    </div>
  );
}

/**
 * Draggable row for a model supported by multiple harnesses. The whole row is the pointer
 * drag handle and participates in the board's explicit keyboard lift/drop
 * flow; the ellipsis button stays keyboard-focusable while visually hidden
 * and offers equivalent menu-driven move/reset actions.
 */
interface ConfigurableHarnessRowProps {
  assignment: ModelHarnessAssignment;
  onKeyboardDragStart: (assignment: ModelHarnessAssignment) => void;
  onMove: (assignment: ModelHarnessAssignment, harness: ModelHarness) => void;
  onReset: (assignment: ModelHarnessAssignment) => void;
}

function ConfigurableHarnessRow({
  assignment,
  onKeyboardDragStart,
  onMove,
  onReset,
}: ConfigurableHarnessRowProps): JSX.Element {
  const label = getModelDisplayName(assignment.modelId);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: assignment.modelId,
    data: { harness: assignment.harness },
  });

  const targets = destinations(assignment).filter(
    (harness) => harness !== assignment.harness,
  );
  // Reset appears only when the effective harness differs from the CURRENT
  // recommendation. A stored-but-redundant backend override shows no reset.
  const showReset = assignment.harness !== assignment.defaultHarness;
  // Every move is one action with a different destination, so the move rows
  // share one icon; Reset sits in its own last group.
  const menuItems: readonly ActionMenuItem[] = [
    ...targets.map(
      (target): ActionMenuItem => ({
        key: `move-${target}`,
        label: `Move to ${harnessLabel(target)}`,
        icon: <ForwardIcon />,
        testId: 'harness-menu-move',
        onSelect: (): void => onMove(assignment, target),
      }),
    ),
    ...(showReset
      ? [
          {
            key: 'reset',
            label: 'Reset to recommended',
            icon: <RevertIcon />,
            testId: 'harness-menu-reset',
            separatorBefore: targets.length > 0,
            onSelect: (): void => onReset(assignment),
          },
        ]
      : []),
  ];

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onKeyDown={(event): void => {
        const target = event.target;
        if (
          (target instanceof Element &&
            target.closest('[data-harness-row-menu]')) ||
          (event.code !== 'Enter' && event.code !== 'Space')
        ) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        onKeyboardDragStart(assignment);
      }}
      aria-keyshortcuts="Enter Space ArrowLeft ArrowRight ArrowUp ArrowDown Escape"
      data-testid={`harness-row-${assignment.modelId}`}
      data-harness-row-kind="configurable"
      className={`group relative flex h-8 cursor-grab items-center gap-2 rounded-md px-2 text-s fg-primary/80 transition-colors focus-within:bg-subtle hover:bg-subtle ${
        isDragging ? 'opacity-40' : ''
      }`}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {/* Revealed with the row, like the other row actions on this board. */}
      <span className="flex shrink-0 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
        <Button
          ref={menuButtonRef}
          size="compact"
          variant="ghost"
          iconOnly
          data-harness-row-menu
          data-testid={`harness-row-menu-${assignment.modelId}`}
          aria-label={`Actions for ${label}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onPointerDown={(event): void => event.stopPropagation()}
          onKeyDown={(event): void => event.stopPropagation()}
          onClick={(event): void => {
            event.stopPropagation();
            setMenuOpen((open) => !open);
          }}
        >
          <MoreHorizontalIcon size="sm" aria-hidden="true" />
        </Button>
      </span>
      <FloatingMenu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        anchorRef={menuButtonRef}
        placement="bottom-right"
        gap={FLOATING_MENU_GAP}
        aria-label={`Actions for ${label}`}
        data-testid={`harness-row-menu-surface-${assignment.modelId}`}
        className="w-48"
      >
        <ActionMenuRowStyle>
          <ActionMenuItems
            items={menuItems}
            onSelect={(item): void => {
              if (item.disabled || !item.onSelect) return;
              setMenuOpen(false);
              menuButtonRef.current?.focus({ preventScroll: true });
              item.onSelect();
            }}
          />
        </ActionMenuRowStyle>
      </FloatingMenu>
    </div>
  );
}
