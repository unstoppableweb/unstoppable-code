import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  SidebarBatchCleanupFailureNotice,
  SidebarBatchRemovalNotice,
  type SidebarBatchRemovalDialogExcludedRow,
  type SidebarBatchRemovalDialogLocalWork,
  type SidebarBatchRemovalDialogRow,
  type SidebarBatchRemovalVerb,
  type SidebarBatchUnitLabel,
  type WorktreeMenuItem,
} from '@canopy/ui-shared/components';
import {
  bulkStateActions,
  deriveSelectionMenuItems,
  rowNeedsStateAction,
  type SidebarBatchActionAvailability,
  type SidebarBulkRowState,
  type SidebarBulkStateAction,
  type SidebarBulkStateActions,
  type SidebarSelectionMenuTestIds,
} from '../sidebar-selection-menu-items';
import {
  isSidebarBatchItemOpen,
  useSidebarBatchRemoval,
  type SidebarBatchItem,
  type SidebarBatchRemovalMode,
  type SidebarBatchRemovalOptions,
  type SidebarBatchRemovalUiState,
  type SidebarBatchTarget,
} from './use-sidebar-batch-removal';
import {
  SIDEBAR_SELECTION_KEEPER_SELECTOR,
  SIDEBAR_SELECTION_ROW_ATTR,
  useSidebarRowSelection,
  type SidebarRowKind,
  type SidebarRowSelection,
  type SidebarSelectionRow,
  type SidebarSelectionRows,
} from './sidebar-row-selection';

// The batch confirm opens only from a selection, never on first paint: keep
// it out of every route that mounts the rail. Selecting a row starts the load,
// so the dialog is usually ready before an action is picked.
const SidebarBatchRemovalDialog = lazy(() =>
  import('@canopy/ui-shared/components/SidebarBatchRemovalDialog').then(
    (module) => ({ default: module.SidebarBatchRemovalDialog }),
  ),
);

function preloadSidebarBatchRemovalDialog(): void {
  void import('@canopy/ui-shared/components/SidebarBatchRemovalDialog');
}

/**
 * A confirmed target with the names the confirm showed. A removed row leaves
 * the list mid-batch (desktop removes it optimistically), so the results
 * can't look it up live.
 */
export interface SidebarBulkTarget extends SidebarBatchTarget {
  readonly projectName: string;
  readonly label: string;
}

/**
 * One kind of selectable row: how the core resolves, checks, names, and
 * removes it. Hosts wire the removal; nothing here branches on host.
 *
 * Method syntax on purpose: methods are bivariant, so a binding over a
 * narrower target is assignable to `SidebarBulkBinding<SidebarBulkTarget>`
 * without a cast.
 */
export interface SidebarBulkBinding<
  T extends SidebarBulkTarget = SidebarBulkTarget,
> {
  /** The row kinds this binding covers. */
  readonly kinds: readonly SidebarRowKind[];
  /** The host wired a removal; `false` keeps these rows out of the selection. */
  readonly enabled: boolean;
  remove?(target: T, options: SidebarBatchRemovalOptions): Promise<void>;
  /** Resolves a selected key to its target and names; `undefined` when the row is gone. */
  targetFor(key: string): T | undefined;
  /** Re-checked per item while running. Reads host facts, never reported rows. */
  blockedReasonFor(key: string): string | undefined;
  availabilityFor(keys: readonly string[]): SidebarBatchActionAvailability;
  unitLabelFor(targets: readonly T[]): SidebarBatchUnitLabel;
  copyFor(
    mode: SidebarBatchRemovalMode,
    included: readonly T[],
  ): {
    readonly retentionSummary: string;
    readonly retentionDetail: string;
    readonly warning?: string;
  };
  /** The confirm row's local-work badge; absent for kinds without local work. */
  localWorkFor?(target: T): SidebarBatchRemovalDialogLocalWork | undefined;
  /**
   * One row's state actions as its own menu offers them (pin, done, hide,
   * notifications); `undefined` when the row is gone. Absent: the kind offers
   * none in bulk.
   */
  rowStateFor?(key: string): SidebarBulkRowState | undefined;
  /**
   * Runs one state action on one row through the single row's own command.
   * A failure is that command's to report, as on the single row.
   */
  applyStateAction?(
    target: T,
    action: SidebarBulkStateAction,
  ): Promise<void> | void;
  /** Asks the host to load a row's state it doesn't know yet. */
  requestRowState?(key: string): void;
  readonly branchChoice: boolean;
  /** The navigated row's key: a batch removes it last. */
  readonly activeKey: string | undefined;
  readonly dialogTestId?: string;
  readonly onStateChange?: (state: SidebarBatchRemovalUiState | null) => void;
}

/** One row's selection menu state, for hosts that build their own menu. */
export type SidebarSelectionSection = 'projects' | 'chats';

export interface SidebarRowSelectionMenu {
  readonly onSelectItem?: () => void;
  readonly multiSelected: boolean;
  readonly toggle: () => void;
  /**
   * Present when the row is in a selection of 2 or more: the row's menu is
   * then the selection's (its state actions, Archive N, Delete N, Clear
   * selection).
   */
  readonly bulk?: {
    readonly count: number;
    readonly availability: SidebarBatchActionAvailability;
    readonly unitLabel: SidebarBatchUnitLabel;
    /** What every selected row's menu offers; empty while a batch runs. */
    readonly stateActions: SidebarBulkStateActions;
    readonly onStateAction: (action: SidebarBulkStateAction) => void;
    readonly onBulkRemoval: (mode: SidebarBatchRemovalMode) => void;
    readonly onClear: () => void;
  };
}

/** What a list binds to its rows. */
export interface SidebarRowMultiSelect {
  readonly selectMode: boolean;
  readonly selectModeFor: (listId: string) => boolean;
  readonly onSelectItem?: (key: string) => void;
  readonly selection: SidebarRowSelection;
  /** Stable per list; an unmounting list reports no rows. */
  readonly onRowsChange: (rows: SidebarSelectionRows) => void;
  /** Esc clears the selection. */
  readonly escapeClears: boolean;
  /** The row is queued or running while the removal queue drains. */
  readonly isRemoving: (key: string) => boolean;
  /** The row's selection menu state; `undefined` for a row that can't be selected. */
  readonly rowMenuFor: (key: string) => SidebarRowSelectionMenu | undefined;
  /**
   * One row's selection menu items: Select/Deselect, or the selection's
   * items (`replacesMenu`) when 2 or more are selected and this row is one.
   */
  readonly menuItemsFor: (
    key: string,
    testIds?: SidebarSelectionMenuTestIds,
  ) => { readonly items: WorktreeMenuItem[]; readonly replacesMenu: boolean };
}

export interface SidebarBulk {
  readonly selectionMode: SidebarSelectionSection | undefined;
  readonly selectionCount: number;
  readonly toolbarItems: readonly WorktreeMenuItem[];
  readonly enterSection: (section: SidebarSelectionSection) => void;
  readonly exitSelection: () => void;
  readonly toggleSection: (section: SidebarSelectionSection) => void;
  readonly allInSectionSelected: (section: SidebarSelectionSection) => boolean;
  /** Memoized per list id while the selection and batch are unchanged. */
  readonly bindingFor: (listId: string) => SidebarRowMultiSelect;
  /**
   * True while the queue drains and the row is queued or running in it: the
   * row is muted, inert, and can't be selected.
   */
  readonly isQueuedForRemoval: (key: string) => boolean;
  /**
   * The removal a row still waits for while the queue drains; undefined once
   * its own removal starts, so the host's status takes over.
   */
  readonly queuedRemovalFor: (
    key: string,
  ) => SidebarBatchRemovalMode | undefined;
  /**
   * Opens the batch confirm for rows the user did not select, such as every
   * hidden worktree in a project. The rows go through the same checks,
   * confirm, and background queue as a selection.
   */
  readonly removeRows: (
    kind: SidebarRowKind,
    keys: readonly string[],
    mode: SidebarBatchRemovalMode,
  ) => void;
  readonly dialog: ReactNode;
  /** The background progress/outcome notice; null when idle with nothing to report. */
  readonly notice: ReactNode;
}

/** Names the rows of a queue that mixes kinds. */
const MIXED_BATCH_UNIT: SidebarBatchUnitLabel = {
  singular: 'item',
  plural: 'items',
};

/** A queued target with the binding and unit that confirmed it. */
interface QueuedBulkTarget extends SidebarBulkTarget {
  /** The binding's first kind: the queue removes it through that binding. */
  readonly bindingKind: SidebarRowKind;
  readonly unit: SidebarBatchUnitLabel;
}

type QueuedBulkItem = SidebarBatchItem<QueuedBulkTarget>;

const NO_ROWS: SidebarSelectionRows = new Map();

function sameRows(a: SidebarSelectionRows, b: SidebarSelectionRows): boolean {
  if (a.size !== b.size) return false;
  for (const [listId, rows] of a) {
    const other = b.get(listId);
    if (other?.length !== rows.length) return false;
    for (const [index, row] of rows.entries()) {
      const match = other[index];
      if (
        match?.key !== row.key ||
        match.kind !== row.kind ||
        match.selectable !== row.selectable ||
        match.label !== row.label ||
        match.projectName !== row.projectName ||
        match.open !== row.open
      ) {
        return false;
      }
    }
  }
  return true;
}

/**
 * The rows every list in a rail reports, merged by list id. Mounted once per
 * rail, before the bindings that read the rows.
 */
export function useSidebarSelectionRows(): {
  readonly rows: SidebarSelectionRows;
  readonly chatsListId?: string;
  readonly enableSelectMode?: boolean;
  readonly reporterFor: (
    listId: string,
  ) => (rows: SidebarSelectionRows) => void;
} {
  const [rowsByReporter, setRowsByReporter] = useState<
    ReadonlyMap<string, SidebarSelectionRows>
  >(new Map());
  const rows = useMemo((): SidebarSelectionRows => {
    const merged = new Map<string, readonly SidebarSelectionRow[]>();
    for (const reported of rowsByReporter.values()) {
      for (const [listId, listRows] of reported) {
        merged.set(listId, [...(merged.get(listId) ?? []), ...listRows]);
      }
    }
    return merged;
  }, [rowsByReporter]);
  const reportersRef = useRef(
    new Map<string, (next: SidebarSelectionRows) => void>(),
  );
  const reporterFor = useCallback(
    (reporterId: string): ((next: SidebarSelectionRows) => void) => {
      const existing = reportersRef.current.get(reporterId);
      if (existing !== undefined) return existing;
      const report = (next: SidebarSelectionRows): void =>
        setRowsByReporter((current) => {
          const previous = current.get(reporterId) ?? NO_ROWS;
          if (sameRows(previous, next)) return current;
          const updated = new Map(current);
          if (next.size === 0) updated.delete(reporterId);
          else updated.set(reporterId, next);
          return updated;
        });
      reportersRef.current.set(reporterId, report);
      return report;
    },
    [],
  );
  return useMemo(() => ({ rows, reporterFor }), [rows, reporterFor]);
}

/**
 * A row being removed is inert, so a press on it lands on its container
 * instead. It is still a press on a row, not elsewhere.
 */
function pressesInertSelectionRow(
  target: Element,
  x: number,
  y: number,
): boolean {
  for (const row of target.querySelectorAll(
    `[${SIDEBAR_SELECTION_ROW_ATTR}][inert]`,
  )) {
    const rect = row.getBoundingClientRect();
    if (x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom) {
      return true;
    }
  }
  return false;
}

interface BulkDialogState {
  readonly mode: SidebarBatchRemovalMode;
  readonly phase: 'confirm' | 'results';
  /**
   * The binding's first kind, captured at open: the confirm keeps resolving
   * its live binding by it after the selection clears or changes kind.
   */
  readonly bindingKind: SidebarRowKind;
  readonly unit: SidebarBatchUnitLabel;
  readonly included: readonly SidebarBulkTarget[];
  readonly excluded: readonly SidebarBatchRemovalDialogExcludedRow[];
  /** Results of a closed batch reporting a late cleanup failure. */
  readonly retiredBatchId?: string;
}

function bindingCovering(
  bindings: readonly SidebarBulkBinding[],
  kind: SidebarRowKind | undefined,
): SidebarBulkBinding | undefined {
  if (kind === undefined) return undefined;
  return bindings.find((binding) => binding.kinds.includes(kind));
}

/**
 * Bulk selection and removal for one rail (CAN-3975), over any row kinds:
 * the selection, each row's selection menu, its state actions, the batch
 * confirm, and the background removal queue with its notice. One selection
 * holds one kind; the binding for that kind resolves, checks, and removes its
 * rows.
 */
export function useSidebarBulk(input: {
  readonly rows: SidebarSelectionRows;
  readonly chatsListId?: string;
  readonly enableSelectMode?: boolean;
  readonly reporterFor: (
    listId: string,
  ) => (rows: SidebarSelectionRows) => void;
  readonly bindings: readonly SidebarBulkBinding[];
}): SidebarBulk {
  const { rows, reporterFor, bindings } = input;
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;

  // One serial queue for every kind: each item re-checks and removes through
  // the live binding that confirmed it, never the selection's.
  const canRemove = bindings.some(
    (binding) => binding.enabled && binding.remove !== undefined,
  );
  const batch = useSidebarBatchRemoval<QueuedBulkTarget>({
    canRemove,
    removeFor: (target) => {
      const live = bindingCovering(bindingsRef.current, target.bindingKind);
      if (live?.enabled !== true || live.remove === undefined) return undefined;
      return (row, options): Promise<void> =>
        live.remove?.(row, options) ?? Promise.reject(new Error(''));
    },
    blockedReasonFor: (target) =>
      bindingCovering(
        bindingsRef.current,
        target.bindingKind,
      )?.blockedReasonFor(target.key),
  });

  // Muted, inert, and unselectable only while the queue drains: after Stop or
  // a host withdrawal, rows left pending return to normal at once, and stay
  // normal while a later batch runs.
  const queuedKeys = useMemo(
    (): ReadonlySet<string> =>
      batch.running
        ? new Set(
            batch.items
              .filter(isSidebarBatchItemOpen)
              .map((item) => item.target.key),
          )
        : new Set<string>(),
    [batch.running, batch.items],
  );
  const isQueuedForRemoval = useCallback(
    (key: string): boolean => queuedKeys.has(key),
    [queuedKeys],
  );
  const waitingModes = useMemo(
    (): ReadonlyMap<string, SidebarBatchRemovalMode> =>
      new Map(
        batch.running
          ? batch.items
              .filter(
                (item) => item.status === 'pending' && item.dropped !== true,
              )
              .map((item) => [item.target.key, item.mode])
          : [],
      ),
    [batch.running, batch.items],
  );
  const queuedRemovalFor = useCallback(
    (key: string): SidebarBatchRemovalMode | undefined => waitingModes.get(key),
    [waitingModes],
  );

  // Only rows whose binding the host wired can be selected.
  const enabledKinds = bindings
    .filter((binding) => binding.enabled)
    .flatMap((binding) => binding.kinds)
    .join(' ');
  const selectableRows = useMemo((): SidebarSelectionRows => {
    if (enabledKinds === '') return NO_ROWS;
    const kinds = new Set(enabledKinds.split(' '));
    const filtered = new Map<string, readonly SidebarSelectionRow[]>();
    for (const [listId, listRows] of rows) {
      const kept = listRows
        .filter((row) => kinds.has(row.kind))
        .map((row) =>
          row.selectable && queuedKeys.has(row.key)
            ? { ...row, selectable: false }
            : row,
        );
      if (kept.length > 0) filtered.set(listId, kept);
    }
    return filtered;
  }, [rows, enabledKinds, queuedKeys]);
  const [dialog, setDialog] = useState<BulkDialogState | null>(null);
  const rawSelection = useSidebarRowSelection(selectableRows);
  const [selectionMode, setSelectionMode] = useState<SidebarSelectionSection>();
  const clearRows = rawSelection.clear;
  const exitSelection = useCallback((): void => {
    setSelectionMode(undefined);
    clearRows();
  }, [clearRows]);
  const selection = useMemo(
    () => ({
      ...rawSelection,
      clear: exitSelection,
      anchor: (listId: string, key: string): void => {
        if (
          selectionMode !== undefined &&
          selectionMode !==
            (listId === input.chatsListId ? 'chats' : 'projects')
        )
          setSelectionMode(undefined);
        rawSelection.anchor(listId, key);
      },
      toggle: (listId: string, key: string): void => {
        if (selectionMode !== undefined)
          setSelectionMode(listId === input.chatsListId ? 'chats' : 'projects');
        rawSelection.toggle(listId, key);
      },
      selectRange: (listId: string, key: string): void => {
        if (selectionMode !== undefined)
          setSelectionMode(listId === input.chatsListId ? 'chats' : 'projects');
        rawSelection.selectRange(listId, key);
      },
    }),
    [rawSelection, exitSelection, selectionMode, input.chatsListId],
  );
  const sectionForList = (listId: string): SidebarSelectionSection =>
    listId === input.chatsListId ? 'chats' : 'projects';
  const enterSection = (section: SidebarSelectionSection): void => {
    rawSelection.clear();
    setSelectionMode(section);
  };
  const enterItem = (listId: string, key: string): void => {
    // Replace, rather than toggle: the open row must not seed a second pick.
    const owner =
      [...selectableRows].find(([, rows]) =>
        rows.some((row) => row.key === key),
      )?.[0] ?? listId;
    rawSelection.anchor(owner, key);
    rawSelection.replace([key]);
    setSelectionMode(sectionForList(owner));
  };
  useEffect(() => {
    if (selectionMode === undefined || typeof document === 'undefined') return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || dialog !== null)
        return;
      if (
        event.target instanceof Element &&
        event.target.closest(
          '[role="menu"], [role="dialog"], [role="alertdialog"]',
        )
      )
        return;
      exitSelection();
    };
    document.addEventListener('keydown', onKeyDown);
    return (): void => document.removeEventListener('keydown', onKeyDown);
  }, [selectionMode, exitSelection, dialog]);
  const sectionRows = (
    section: SidebarSelectionSection,
  ): SidebarSelectionRow[] =>
    [...selectableRows].flatMap(([id, rows]) =>
      sectionForList(id) === section
        ? rows.filter((row) => row.selectable)
        : [],
    );
  const rowsForSectionSelection = (
    section: SidebarSelectionSection,
  ): SidebarSelectionRow[] => {
    const rows = sectionRows(section);
    const kind = selection.kind ?? rows[0]?.kind;
    return rows.filter((row) => row.kind === kind);
  };
  const allInSectionSelected = (section: SidebarSelectionSection): boolean => {
    const rows = rowsForSectionSelection(section);
    return (
      rows.length > 0 && rows.every((row) => selection.isSelected(row.key))
    );
  };
  const toggleSection = (section: SidebarSelectionSection): void => {
    if (allInSectionSelected(section)) rawSelection.clear();
    else
      rawSelection.replace(
        rowsForSectionSelection(section).map((row) => row.key),
      );
  };

  /** The live binding a dialog captured, by the kind it captured. */
  const dialogBindingFor = (
    state: BulkDialogState | null,
  ): SidebarBulkBinding | undefined =>
    state === null
      ? undefined
      : bindingCovering(bindingsRef.current, state.bindingKind);
  const dialogBinding = dialogBindingFor(dialog);
  const selectionBinding = bindingCovering(bindings, selection.kind);

  const preloadDialog = selection.active && selectionBinding?.enabled === true;
  useEffect(() => {
    if (preloadDialog) preloadSidebarBatchRemovalDialog();
  }, [preloadDialog]);

  // Selected keys in rendered order, so the confirm lists what the rail shows.
  const orderedSelectedKeys = useMemo((): string[] => {
    const keys: string[] = [];
    for (const listRows of selectableRows.values()) {
      for (const row of listRows) {
        if (selection.isSelected(row.key)) keys.push(row.key);
      }
    }
    return keys;
  }, [selectableRows, selection]);

  // State actions run row by row through the single row's own command, on
  // the rows captured now. Unlike removal they need no confirm.
  const runStateAction = (action: SidebarBulkStateAction): void => {
    const binding = selectionBinding;
    if (binding?.applyStateAction === undefined) return;
    if (batch.running) return;
    const apply = binding.applyStateAction.bind(binding);
    const targets = orderedSelectedKeys.flatMap((key) => {
      const state = binding.rowStateFor?.(key);
      const target = binding.targetFor(key);
      return state !== undefined &&
        target !== undefined &&
        rowNeedsStateAction(state, action)
        ? [target]
        : [];
    });
    void (async (): Promise<void> => {
      for (const target of targets) {
        try {
          await apply(target, action);
        } catch {
          // The row's own command reports its failure.
        }
      }
    })();
  };

  // A selection's menu reads each row's state; ask the host for any it
  // hasn't loaded, once each time the selection changes.
  const requestKeys =
    selection.count >= 1 && selectionBinding?.requestRowState !== undefined
      ? orderedSelectedKeys.join('\n')
      : '';
  const selectionBindingRef = useRef(selectionBinding);
  selectionBindingRef.current = selectionBinding;
  useEffect(() => {
    if (requestKeys === '') return;
    for (const key of requestKeys.split('\n')) {
      selectionBindingRef.current?.requestRowState?.(key);
    }
  }, [requestKeys]);

  const openBatchFor = (
    binding: SidebarBulkBinding | undefined,
    keys: readonly string[],
    mode: SidebarBatchRemovalMode,
  ): void => {
    const bindingKind = binding?.kinds[0];
    if (binding === undefined || bindingKind === undefined) return;
    if (!binding.enabled || keys.length === 0) return;
    // A running queue takes more batches; a pending Stop briefly does not, so
    // a new confirm is never dropped as not started.
    if (batch.stopRequested) return;
    if (!binding.availabilityFor(keys)[mode].enabled) return;
    const included: SidebarBulkTarget[] = [];
    const excluded: SidebarBatchRemovalDialogExcludedRow[] = [];
    const resolved: SidebarBulkTarget[] = [];
    for (const key of keys) {
      const target = binding.targetFor(key);
      if (target === undefined) continue;
      resolved.push(target);
      const reason = binding.blockedReasonFor(key);
      if (reason === undefined) {
        included.push(target);
      } else {
        excluded.push({
          key,
          projectName: target.projectName,
          label: target.label,
          branchName: target.branchName,
          reason,
        });
      }
    }
    setDialog({
      mode,
      phase: 'confirm',
      bindingKind,
      unit: binding.unitLabelFor(resolved),
      included,
      excluded,
    });
  };
  const openBatch = (mode: SidebarBatchRemovalMode): void =>
    openBatchFor(selectionBinding, orderedSelectedKeys, mode);
  const removeRows = (
    kind: SidebarRowKind,
    keys: readonly string[],
    mode: SidebarBatchRemovalMode,
  ): void => {
    preloadSidebarBatchRemovalDialog();
    openBatchFor(bindingCovering(bindingsRef.current, kind), keys, mode);
  };

  const batchSeqRef = useRef(0);
  const confirm = (deleteBranch?: boolean): void => {
    if (dialog === null || dialog.phase !== 'confirm') return;
    // Like `openBatch`: the ending drain would drop it as not started.
    if (batch.stopRequested) return;
    const binding = dialogBindingFor(dialog);
    if (binding === undefined) return;
    const { mode, included, unit, bindingKind } = dialog;
    if (included.length === 0) return;
    // The confirm is the last modal moment: the queue runs in the background
    // and the rows leave the rail as they finish, like a single removal. A
    // confirm that fires twice is deduped by the queue.
    setDialog(null);
    selection.clear();
    batchSeqRef.current += 1;
    void batch.enqueue({
      batchId: `batch-${batchSeqRef.current}`,
      targets: included.map(
        (target): QueuedBulkTarget => ({ ...target, bindingKind, unit }),
      ),
      options: binding.branchChoice
        ? { mode, deleteBranch: deleteBranch === true }
        : { mode },
      activeKey: binding.activeKey,
      unit,
    });
  };

  // Counts use the latest attempt per key, so a successful retry clears the
  // outcome; the results still list every attempt.
  // Retired items belong to batches already closed while their cleanup ran:
  // they report under their own batch, never in the current counts.
  const currentItems = useMemo(
    () => batch.items.filter((item) => item.retired !== true),
    [batch.items],
  );
  const retiredBatches = useMemo(() => {
    const byBatch = new Map<string, QueuedBulkItem[]>();
    for (const item of batch.items) {
      if (item.retired !== true) continue;
      byBatch.set(item.batchId, [...(byBatch.get(item.batchId) ?? []), item]);
    }
    return [...byBatch].flatMap(([batchId, items]) => {
      const failed = items.filter((item) => item.status === 'failed');
      const [first] = items;
      if (failed.length === 0 || first === undefined) return [];
      return [
        {
          batchId,
          items,
          verb: first.mode,
          unit: first.target.unit,
          bindingKind: first.target.bindingKind,
          failedLabels: failed.map((item) => item.target.label),
          cleanupRunning: items.filter((item) => item.cleanup === 'running')
            .length,
        },
      ];
    });
  }, [batch.items]);

  const counts = useMemo(() => {
    const latest = new Map<string, QueuedBulkItem>();
    for (const item of currentItems) latest.set(item.target.key, item);
    const latestItems = [...latest.values()];
    const count = (status: QueuedBulkItem['status']): number =>
      latestItems.filter((item) => item.status === status).length;
    const queuedByKind = new Map<SidebarRowKind, number>();
    for (const item of latestItems) {
      if (!isSidebarBatchItemOpen(item)) continue;
      const kind = item.target.bindingKind;
      queuedByKind.set(kind, (queuedByKind.get(kind) ?? 0) + 1);
    }
    const units = new Set(latestItems.map((item) => item.target.unit.plural));
    const [onlyItem] = latestItems;
    return {
      total: latest.size,
      done: count('done'),
      failed: count('failed'),
      skipped: count('skipped'),
      notStarted: count('pending'),
      cleanupRunning: latestItems.filter((item) => item.cleanup === 'running')
        .length,
      lateFailed: latestItems.filter((item) => item.cleanup === 'failed')
        .length,
      queuedByKind,
      // Stable across renders with the same counts, for the report effect.
      queuedByKindKey: JSON.stringify([...queuedByKind]),
      unit:
        units.size === 1 && onlyItem !== undefined
          ? onlyItem.target.unit
          : MIXED_BATCH_UNIT,
      lastKind: currentItems[currentItems.length - 1]?.target.bindingKind,
    };
  }, [currentItems]);
  const verb = useMemo((): SidebarBatchRemovalVerb => {
    const hasArchive = currentItems.some((item) => item.mode === 'archive');
    const hasDelete = currentItems.some((item) => item.mode === 'delete');
    if (hasArchive && hasDelete) return 'remove';
    return hasArchive ? 'archive' : 'delete';
  }, [currentItems]);
  const verbMode: SidebarBatchRemovalMode =
    verb === 'archive' ? 'archive' : 'delete';

  // Everything removed and nothing to report: forget the queue so the notice
  // goes away on its own. `reset` is a stable queue method.
  const { reset: resetBatch, running: batchRunning } = batch;
  useEffect(() => {
    if (!batchRunning && counts.total > 0 && counts.done === counts.total) {
      resetBatch();
    }
  }, [batchRunning, counts.total, counts.done, resetBatch]);

  const showResults = (): void => {
    const bindingKind = counts.lastKind;
    if (bindingKind === undefined) return;
    setDialog({
      mode: verbMode,
      phase: 'results',
      bindingKind,
      unit: counts.unit,
      included: [],
      excluded: [],
    });
  };
  const dismissOutcome = (): void => {
    setDialog(null);
    resetBatch();
  };
  const showRetiredResults = (
    retired: (typeof retiredBatches)[number],
  ): void => {
    setDialog({
      mode: retired.verb,
      phase: 'results',
      bindingKind: retired.bindingKind,
      unit: retired.unit,
      included: [],
      excluded: [],
      retiredBatchId: retired.batchId,
    });
  };
  const { dismissRetired } = batch;
  const dismissRetiredOutcome = (batchId: string): void => {
    setDialog((current) =>
      current?.retiredBatchId === batchId ? null : current,
    );
    dismissRetired(batchId);
  };

  const dialogRowsFor = (
    state: BulkDialogState,
    binding: SidebarBulkBinding | undefined,
  ): SidebarBatchRemovalDialogRow[] => {
    if (state.phase === 'results') {
      // One row per attempt: a retried key appears once per batch.
      const resultItems =
        state.retiredBatchId === undefined
          ? currentItems
          : batch.items.filter(
              (item) =>
                item.retired === true && item.batchId === state.retiredBatchId,
            );
      return resultItems.map(
        (item): SidebarBatchRemovalDialogRow => ({
          key: `${item.batchId}:${item.target.key}`,
          projectName: item.target.projectName,
          label: item.target.label,
          branchName: item.target.branchName,
          status: item.status,
          reason: item.reason,
        }),
      );
    }
    return state.included.map((target): SidebarBatchRemovalDialogRow => {
      const localWork = binding?.localWorkFor?.(target);
      return {
        key: target.key,
        projectName: target.projectName,
        label: target.label,
        branchName: target.branchName,
        ...(localWork !== undefined ? { localWork } : {}),
      };
    });
  };

  // Report each kind's state through its own binding: the dialog it opened,
  // else its rows draining in the background (`open: false`, `phase:
  // 'running'`, `count` still queued), and `null` once it has neither.
  const reportedKindsRef = useRef<ReadonlySet<SidebarRowKind>>(new Set());
  const queuedByKindRef = useRef(counts.queuedByKind);
  queuedByKindRef.current = counts.queuedByKind;
  useEffect(() => {
    const next = new Map<SidebarRowKind, SidebarBatchRemovalUiState>();
    if (dialog !== null) {
      next.set(dialog.bindingKind, {
        open: true,
        mode: dialog.mode,
        count:
          dialog.phase === 'confirm' ? dialog.included.length : counts.total,
        phase: dialog.phase,
      });
    }
    if (batchRunning) {
      for (const [kind, count] of queuedByKindRef.current) {
        if (next.has(kind)) continue;
        next.set(kind, {
          open: false,
          mode: verbMode,
          count,
          phase: 'running',
        });
      }
    }
    for (const kind of reportedKindsRef.current) {
      if (!next.has(kind)) {
        bindingCovering(bindingsRef.current, kind)?.onStateChange?.(null);
      }
    }
    for (const [kind, state] of next) {
      bindingCovering(bindingsRef.current, kind)?.onStateChange?.(state);
    }
    reportedKindsRef.current = new Set(next.keys());
  }, [dialog, batchRunning, verbMode, counts.total, counts.queuedByKindKey]);

  // A click anywhere but the selection's rows, menus, and dialogs ends it, the
  // way a plain row click does. Captured, so a surface that stops the click
  // (a chat tab, an editor) still counts.
  const clearSelection = selection.clear;
  const listensOutside =
    (selectionMode !== undefined ||
      (selectionBinding?.enabled === true && selection.active)) &&
    dialog === null;
  useEffect(() => {
    if (!listensOutside || typeof document === 'undefined') return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) return;
      const target = event.target;
      if (
        target instanceof Element &&
        (target.closest(SIDEBAR_SELECTION_KEEPER_SELECTOR) !== null ||
          pressesInertSelectionRow(target, event.clientX, event.clientY))
      ) {
        return;
      }
      clearSelection();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return (): void => {
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [listensOutside, clearSelection]);

  // An unconfirmed batch can't run once its host withdraws the removal, so
  // it is dropped rather than shown again, stale, when the host returns.
  const dialogBindingEnabled = dialogBinding?.enabled === true;
  useEffect(() => {
    if (!dialogBindingEnabled) {
      setDialog((current) => (current?.phase === 'confirm' ? null : current));
    }
  }, [dialogBindingEnabled]);

  const dialogNode =
    dialog !== null &&
    // A queue's results stay viewable; the queue starts nothing further
    // without the host's removal.
    (dialogBindingEnabled || dialog.phase !== 'confirm') ? (
      <Suspense fallback={null}>
        <SidebarBatchRemovalDialog
          mode={dialog.mode}
          phase={dialog.phase}
          rows={dialogRowsFor(dialog, dialogBinding)}
          excluded={dialog.excluded}
          {...(dialog.phase === 'confirm'
            ? (dialogBinding?.copyFor(dialog.mode, dialog.included) ?? {
                retentionSummary: '',
                retentionDetail: '',
              })
            : { retentionSummary: '', retentionDetail: '' })}
          branchChoice={dialogBinding?.branchChoice === true}
          unitLabel={dialog.unit}
          testId={dialogBinding?.dialogTestId}
          onCancel={(): void => setDialog(null)}
          onConfirm={confirm}
          onDone={(): void => {
            const { retiredBatchId } = dialog;
            if (retiredBatchId === undefined) dismissOutcome();
            else dismissRetiredOutcome(retiredBatchId);
          }}
        />
      </Suspense>
    ) : null;

  // Null, not a notice that renders nothing, once everything succeeded: the
  // rail sizes its footer callout on this before the reset effect runs.
  const currentNotice =
    !batch.running && counts.done === counts.total ? null : (
      <SidebarBatchRemovalNotice
        verb={verb}
        unitLabel={counts.unit}
        running={batch.running}
        stopRequested={batch.stopRequested}
        total={counts.total}
        done={counts.done}
        failed={counts.failed}
        skipped={counts.skipped}
        notStarted={counts.notStarted}
        cleanupRunning={counts.cleanupRunning}
        lateFailed={counts.lateFailed}
        onStop={batch.stop}
        onShowDetails={showResults}
        onDismiss={dismissOutcome}
      />
    );
  // A closed batch whose background cleanup failed reports on its own
  // notice, so it never changes a later batch's counts.
  const noticeNode =
    currentNotice === null && retiredBatches.length === 0 ? null : (
      <>
        {retiredBatches.map((retired) => (
          <SidebarBatchCleanupFailureNotice
            key={retired.batchId}
            verb={retired.verb}
            unitLabel={retired.unit}
            failedLabels={retired.failedLabels}
            cleanupRunning={retired.cleanupRunning}
            onShowDetails={(): void => showRetiredResults(retired)}
            onDismiss={(): void => dismissRetiredOutcome(retired.batchId)}
          />
        ))}
        {currentNotice}
      </>
    );

  // One row's selection menu. The selection's availability and unit are
  // computed once per render, on the first selected row's menu that asks.
  let selectionMenuCache:
    | {
        readonly availability: SidebarBatchActionAvailability;
        readonly unitLabel: SidebarBatchUnitLabel;
        readonly stateActions: SidebarBulkStateActions;
      }
    | undefined;
  const selectionMenuFor = (
    binding: SidebarBulkBinding,
  ): {
    readonly availability: SidebarBatchActionAvailability;
    readonly unitLabel: SidebarBatchUnitLabel;
    readonly stateActions: SidebarBulkStateActions;
  } => {
    selectionMenuCache ??= {
      availability: binding.availabilityFor(orderedSelectedKeys),
      unitLabel: binding.unitLabelFor(
        orderedSelectedKeys.flatMap((key) => {
          const target = binding.targetFor(key);
          return target === undefined ? [] : [target];
        }),
      ),
      // Nothing to offer while a batch removes these rows, or when the kind
      // has no runner for state actions. A gone row (`undefined`) maps to
      // `{}`, which makes the whole selection offer nothing.
      stateActions:
        batch.running ||
        binding.rowStateFor === undefined ||
        binding.applyStateAction === undefined
          ? {}
          : bulkStateActions(
              orderedSelectedKeys.map(
                (key) => binding.rowStateFor?.(key) ?? {},
              ),
            ),
    };
    return selectionMenuCache;
  };
  const rowByKey = new Map<string, SidebarSelectionRow>();
  for (const listRows of selectableRows.values()) {
    for (const row of listRows) rowByKey.set(row.key, row);
  }
  const rowMenuFor = (
    listId: string,
    key: string,
  ): SidebarRowSelectionMenu | undefined => {
    const row = rowByKey.get(key);
    if (row === undefined || !row.selectable) return undefined;
    const binding = bindingCovering(bindings, row.kind);
    if (binding?.enabled !== true) return undefined;
    const multiSelected = selection.isSelected(key);
    const toggle = (): void => selection.toggle(listId, key);
    if (
      !multiSelected ||
      selection.count < (selectionMode === undefined ? 2 : 1) ||
      binding !== selectionBinding
    ) {
      return {
        multiSelected,
        toggle,
        onSelectItem: input.enableSelectMode
          ? () => enterItem(listId, key)
          : undefined,
      };
    }
    return {
      multiSelected,
      toggle,
      onSelectItem: input.enableSelectMode
        ? () => enterItem(listId, key)
        : undefined,
      bulk: {
        count: selection.count,
        ...selectionMenuFor(binding),
        onStateAction: runStateAction,
        onBulkRemoval: openBatch,
        onClear: selection.clear,
      },
    };
  };

  const queuedKeysKey = [...queuedKeys].join('\n');
  // A list's binding keeps its identity until the selection, its rows, or
  // the batch change, so memoized rows skip unrelated rail renders. Its menus
  // read the latest render's availability and actions when they are built.
  const rowMenuForRef = useRef(rowMenuFor);
  rowMenuForRef.current = rowMenuFor;
  const cacheDeps: readonly unknown[] = [
    selection,
    selectionMode,
    input.chatsListId,
    input.enableSelectMode,
    selectableRows,
    queuedKeysKey,
    reporterFor,
  ];
  const bindingCacheRef = useRef<{
    readonly deps: readonly unknown[];
    readonly bindings: Map<string, SidebarRowMultiSelect>;
  } | null>(null);
  const cached = bindingCacheRef.current;
  if (
    cached === null ||
    cached.deps.some((dep, index) => !Object.is(dep, cacheDeps[index]))
  ) {
    bindingCacheRef.current = { deps: cacheDeps, bindings: new Map() };
  }
  const bindingCache =
    bindingCacheRef.current?.bindings ??
    new Map<string, SidebarRowMultiSelect>();
  const bindingFor = (listId: string): SidebarRowMultiSelect => {
    const cached = bindingCache.get(listId);
    if (cached !== undefined) return cached;
    const removing = queuedKeys;
    const menuFor = (key: string): SidebarRowSelectionMenu | undefined =>
      rowMenuForRef.current(listId, key);
    const built: SidebarRowMultiSelect = {
      selection,
      selectMode: selectionMode === sectionForList(listId),
      selectModeFor: (id) => selectionMode === sectionForList(id),
      onSelectItem: input.enableSelectMode
        ? (key) => menuFor(key)?.onSelectItem?.()
        : undefined,
      onRowsChange: reporterFor(listId),
      escapeClears: true,
      isRemoving: (key) => removing.has(key),
      rowMenuFor: menuFor,
      menuItemsFor: (key, testIds) => {
        const menu = menuFor(key);
        if (menu === undefined) return { items: [], replacesMenu: false };
        if (menu.bulk !== undefined) {
          return {
            items: deriveSelectionMenuItems({
              availability: menu.bulk.availability,
              onBulkRemoval: menu.bulk.onBulkRemoval,
              stateActions: menu.bulk.stateActions,
              onStateAction: menu.bulk.onStateAction,
              testIds,
            }),
            replacesMenu: true,
          };
        }
        return {
          items: [],
          replacesMenu: false,
        };
      },
    };
    bindingCache.set(listId, built);
    return built;
  };

  return {
    selectionMode,
    selectionCount: selection.count,
    toolbarItems:
      selectionBinding === undefined
        ? []
        : deriveSelectionMenuItems({
            ...selectionMenuFor(selectionBinding),
            onStateAction: runStateAction,
            onBulkRemoval: openBatch,
          }),
    enterSection,
    exitSelection,
    toggleSection,
    allInSectionSelected,
    bindingFor,
    isQueuedForRemoval,
    queuedRemovalFor,
    removeRows,
    dialog: dialogNode,
    notice: noticeNode,
  };
}
