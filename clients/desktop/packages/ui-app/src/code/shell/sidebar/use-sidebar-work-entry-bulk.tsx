import { useEffect, useRef } from 'react';
import { CHAT_UNIT_LABEL } from '@canopy/protocol';
import { DEFAULT_ARCHIVE_RETENTION_DAYS } from '@canopy/protocol/archive-retention';
import {
  spaceNotificationMenuUnavailable,
  type SpaceNotificationMenuChoice,
  type SpaceNotificationMenuState,
  type WorkEntryRowMultiSelect,
} from '@canopy/ui-shared/components';
import {
  batchActionAvailability,
  type SidebarBulkStateAction,
} from '../sidebar-selection-menu-items';
import {
  getWorkEntryBatchCopy,
  WORK_ENTRY_BATCH_UNIT,
} from '../work-entry-removal-labels';
import type {
  SidebarBatchRemovalOptions,
  SidebarBatchRemovalMode,
  SidebarBatchRemovalUiState,
} from './use-sidebar-batch-removal';
import type {
  SidebarBulkBinding,
  SidebarBulkTarget,
  SidebarRowMultiSelect,
} from './use-sidebar-bulk';
import type {
  SidebarSelectionRow,
  SidebarSelectionRows,
} from './sidebar-row-selection';

/** Why the runner skips an entry that is no longer there. */
const CHAT_NOT_FOUND = `${CHAT_UNIT_LABEL} was not found`;

/**
 * Bulk selection of Work Entry rows (chats and App Advisor entries): the
 * binding the rail's bulk core runs them through. Hosts supply one awaitable
 * per-entry removal; where a host has none, no Work Entry row selects.
 */

const WORK_ENTRY_KEY_PREFIX = 'work-entry:';

/** A Work Entry row's selection key: `work-entry:<workspace>/<entry>`. */
export function workEntryRowKey(
  workspaceLocalId: string,
  workEntryId: string,
): string {
  return `${WORK_ENTRY_KEY_PREFIX}${workspaceLocalId}/${workEntryId}`;
}

function parseWorkEntryRowKey(
  key: string,
): { workspaceLocalId: string; workEntryId: string } | undefined {
  if (!key.startsWith(WORK_ENTRY_KEY_PREFIX)) return undefined;
  const rest = key.slice(WORK_ENTRY_KEY_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) return undefined;
  return {
    workspaceLocalId: rest.slice(0, slash),
    workEntryId: rest.slice(slash + 1),
  };
}

export interface WorkEntryBatchTarget extends SidebarBulkTarget {
  readonly workspaceLocalId: string;
  readonly workEntryId: string;
}

/** The host's awaitable removal of one Work Entry; rejects on failure. */
export type RemoveWorkEntryInBatch = (
  workspaceLocalId: string,
  workEntryId: string,
  options: { readonly mode: SidebarBatchRemovalMode },
) => Promise<void>;

/** Host facts for one Work Entry of a batch. */
export interface WorkEntryBatchRemovalFacts {
  /** Why the host can't remove this entry right now, if it can't. */
  readonly blockedReason?: string;
}

/**
 * `undefined` means the entry no longer exists; `{}` means it exists and
 * nothing blocks its removal.
 */
export type GetWorkEntryBatchRemovalFacts = (
  workspaceLocalId: string,
  workEntryId: string,
) => WorkEntryBatchRemovalFacts | undefined;

/** A Work Entry's pin and done state; `undefined` when it no longer exists. */
export type GetWorkEntryBulkState = (
  workspaceLocalId: string,
  workEntryId: string,
) => { readonly pinned?: boolean; readonly done?: boolean } | undefined;

export interface UseSidebarWorkEntryBulkInput {
  /** Bulk is offered: the host wired a removal. */
  readonly enabled: boolean;
  readonly remove: RemoveWorkEntryInBatch | undefined;
  /**
   * Hosts that wire `remove` wire this too, so an entry removed by another
   * path mid-batch is skipped rather than removed twice.
   */
  readonly getFacts?: GetWorkEntryBatchRemovalFacts;
  /** The rail's reported rows: a confirm reads each entry's names from them. */
  readonly rows: SidebarSelectionRows;
  /** The open Work Entry's key: a batch removes it last. */
  readonly activeKey?: string;
  /**
   * Reads the open Work Entry's key when a batch starts, for hosts that know
   * it only from their rows' latest report. Wins over `activeKey`.
   */
  readonly readActiveKey?: () => string | undefined;
  readonly isWorkspaceCommandDisabled?: (workspaceLocalId: string) => boolean;
  readonly retentionDaysFor?: (workspaceLocalId: string) => number | undefined;
  /** Defaults to `work-entry-batch-removal-dialog`. */
  readonly dialogTestId?: string;
  readonly onStateChange?: (state: SidebarBatchRemovalUiState | null) => void;
  /** Read on render for the selection's Pin and Mark items. */
  readonly getEntryState?: GetWorkEntryBulkState;
  /** The row's own Pin to top; absent: entries offer no Pin. */
  readonly setPinned?: (
    workspaceLocalId: string,
    workEntryId: string,
    pinned: boolean,
  ) => Promise<void>;
  /** The row's own Mark done / Mark active; absent: entries offer neither. */
  readonly setStatus?: (
    workspaceLocalId: string,
    workEntryId: string,
    status: 'active' | 'done',
  ) => Promise<void>;
  /** A Work Entry's saved notification choice, keyed like a worktree's. */
  readonly getNotificationState?: (
    workspaceLocalId: string,
    workEntryId: string,
  ) => SpaceNotificationMenuState | undefined;
  readonly setNotificationChoice?: (
    workspaceLocalId: string,
    workEntryId: string,
    choice: SpaceNotificationMenuChoice,
  ) => void;
  /** Loads an entry's saved choice; the single row does this when its menu opens. */
  readonly requestNotificationState?: (
    workspaceLocalId: string,
    workEntryId: string,
  ) => void;
}

export interface SidebarWorkEntryBulk {
  readonly binding: SidebarBulkBinding<WorkEntryBatchTarget>;
  /** Whether a workspace's Work Entry rows can join the selection. */
  readonly isSelectable: (workspaceLocalId: string) => boolean;
}

/** What a Work Entry list binds to its rows. */
export interface WorkEntryMultiSelectBinding extends SidebarRowMultiSelect {
  readonly isSelectable: (workspaceLocalId: string) => boolean;
}

export function useSidebarWorkEntryBulk(
  input: UseSidebarWorkEntryBulkInput,
): SidebarWorkEntryBulk {
  const {
    enabled,
    remove,
    getFacts,
    rows,
    isWorkspaceCommandDisabled,
    retentionDaysFor,
  } = input;

  const isSelectable = (workspaceLocalId: string): boolean =>
    enabled && isWorkspaceCommandDisabled?.(workspaceLocalId) !== true;

  const binding: SidebarBulkBinding<WorkEntryBatchTarget> = {
    kinds: ['work-entry'],
    enabled,
    ...(enabled && remove !== undefined
      ? {
          remove: (
            target: WorkEntryBatchTarget,
            options: SidebarBatchRemovalOptions,
          ): Promise<void> =>
            remove(target.workspaceLocalId, target.workEntryId, {
              mode: options.mode,
            }),
        }
      : {}),
    // Consulted at confirm only: the names come from the rows on screen.
    targetFor: (key) => {
      const parsed = parseWorkEntryRowKey(key);
      if (parsed === undefined) return undefined;
      for (const listRows of rows.values()) {
        const row = listRows.find((candidate) => candidate.key === key);
        if (row !== undefined) {
          return {
            key,
            ...parsed,
            label: row.label ?? '',
            projectName: row.projectName ?? '',
          };
        }
      }
      return undefined;
    },
    // Re-checked per item while a batch runs, so it reads host facts only:
    // a list that collapses mid-batch reports no rows, and its entries must
    // still be removed.
    blockedReasonFor: (key) => {
      const parsed = parseWorkEntryRowKey(key);
      if (parsed === undefined) return CHAT_NOT_FOUND;
      if (getFacts === undefined) return undefined;
      const facts = getFacts(parsed.workspaceLocalId, parsed.workEntryId);
      if (facts === undefined) return CHAT_NOT_FOUND;
      return facts.blockedReason;
    },
    availabilityFor: (keys) =>
      batchActionAvailability(
        keys.map((key) => {
          const workspaceLocalId = parseWorkEntryRowKey(key)?.workspaceLocalId;
          return {
            removal: 'archive',
            retention: 'archive-or-delete',
            commandsDisabled:
              workspaceLocalId !== undefined &&
              isWorkspaceCommandDisabled?.(workspaceLocalId) === true,
          };
        }),
        WORK_ENTRY_BATCH_UNIT,
      ),
    unitLabelFor: () => WORK_ENTRY_BATCH_UNIT,
    copyFor: (mode, included) => {
      const windows = [
        ...new Set(included.map((target) => target.workspaceLocalId)),
      ].map(
        (workspaceLocalId) =>
          retentionDaysFor?.(workspaceLocalId) ??
          DEFAULT_ARCHIVE_RETENTION_DAYS,
      );
      return getWorkEntryBatchCopy(
        mode,
        windows.length > 0 ? windows : [DEFAULT_ARCHIVE_RETENTION_DAYS],
      );
    },
    rowStateFor: (key) => {
      const parsed = parseWorkEntryRowKey(key);
      if (parsed === undefined) return undefined;
      const { workspaceLocalId, workEntryId } = parsed;
      const entry = input.getEntryState?.(workspaceLocalId, workEntryId);
      if (input.getEntryState !== undefined && entry === undefined) {
        return undefined;
      }
      // Pin and Mark are host commands: a workspace that can't take
      // commands offers neither, as on the single row.
      const commands = isWorkspaceCommandDisabled?.(workspaceLocalId) !== true;
      const notifications =
        input.setNotificationChoice === undefined
          ? undefined
          : input.getNotificationState?.(workspaceLocalId, workEntryId);
      return {
        ...(commands && input.setPinned !== undefined && entry !== undefined
          ? { pinned: entry.pinned === true }
          : {}),
        ...(commands && input.setStatus !== undefined && entry !== undefined
          ? { done: entry.done === true }
          : {}),
        ...(notifications !== undefined &&
        !spaceNotificationMenuUnavailable(notifications)
          ? { notifications }
          : {}),
      };
    },
    applyStateAction: (
      target,
      action: SidebarBulkStateAction,
    ): Promise<void> | undefined => {
      const { workspaceLocalId, workEntryId } = target;
      switch (action.kind) {
        case 'pin':
          return input.setPinned?.(
            workspaceLocalId,
            workEntryId,
            action.pinned,
          );
        case 'done':
          return input.setStatus?.(
            workspaceLocalId,
            workEntryId,
            action.done ? 'done' : 'active',
          );
        case 'notifications':
          input.setNotificationChoice?.(
            workspaceLocalId,
            workEntryId,
            action.choice,
          );
          return undefined;
        case 'hide':
        case 'stop-scripts':
          // Work Entries have no Hide and run no scripts.
          return undefined;
      }
    },
    requestRowState: (key) => {
      const parsed = parseWorkEntryRowKey(key);
      if (parsed === undefined) return;
      const state = input.getNotificationState?.(
        parsed.workspaceLocalId,
        parsed.workEntryId,
      );
      // Only a choice not known yet: never read, or read with none to show (a
      // space the server doesn't know). The host's refresh skips a read
      // already in flight.
      if (state?.selectionKnown === false) {
        input.requestNotificationState?.(
          parsed.workspaceLocalId,
          parsed.workEntryId,
        );
      }
    },
    branchChoice: false,
    get activeKey(): string | undefined {
      return input.readActiveKey === undefined
        ? input.activeKey
        : input.readActiveKey();
    },
    dialogTestId: input.dialogTestId ?? 'work-entry-batch-removal-dialog',
    onStateChange: input.onStateChange,
  };

  return { binding, isSelectable };
}

/** The shared row's selection props for one Work Entry row. */
export function workEntryRowMultiSelectProps(
  binding: WorkEntryMultiSelectBinding,
  listId: string,
  key: string,
  selectable: boolean,
): WorkEntryRowMultiSelect {
  const { selection } = binding;
  return {
    selected: selection.isSelected(key),
    selectMode: binding.selectMode,
    onSelectItem: binding.onSelectItem
      ? () => binding.onSelectItem?.(key)
      : undefined,
    selectable,
    rowKey: key,
    active: selection.active,
    escapeClears: binding.escapeClears,
    onToggle: () => selection.toggle(listId, key),
    onSelectRange: () => selection.selectRange(listId, key),
    onSelectAll: () => selection.selectAllInList(listId),
    onAnchor: () => selection.anchor(listId, key),
    onExtend: (step) => selection.extend(listId, key, step),
    onClear: selection.clear,
  };
}

/**
 * Reports the rows a list renders to the rail's bulk selection, and no rows
 * once it unmounts. Keyed on the rows' content, so a re-render with the same
 * rows reports nothing new. A component rather than a hook so a list can
 * mount it below its early returns.
 */
export function SidebarSelectionRowsReporter({
  listId,
  rows,
  onRowsChange,
}: {
  readonly listId: string;
  readonly rows: readonly SidebarSelectionRow[];
  readonly onRowsChange: (rows: SidebarSelectionRows) => void;
}): null {
  const latestRef = useRef({ listId, rows, onRowsChange });
  latestRef.current = { listId, rows, onRowsChange };
  const rowsKey = JSON.stringify([listId, rows]);
  useEffect(() => {
    const latest = latestRef.current;
    latest.onRowsChange(new Map([[latest.listId, latest.rows]]));
  }, [rowsKey]);
  useEffect(
    () => (): void => {
      latestRef.current.onRowsChange(new Map());
    },
    [],
  );
  return null;
}
