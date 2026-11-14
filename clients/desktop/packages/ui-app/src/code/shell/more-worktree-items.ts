import { useMemo } from 'react';
import type {
  MoreWorktreeItem,
  MoreWorktreeMenuAction,
} from '@canopy/ui-shared/components';
import {
  requestSidebarHiddenWorktreeAction,
  useSidebarHiddenWorktreeRemovalAvailable,
  useSidebarHiddenWorktrees,
  type SidebarHiddenWorktreeEntry,
} from './sidebar-more-bridge';

const DAY_MS = 24 * 60 * 60 * 1000;

/** `Nov 10`, or `Nov 10, 2025` outside the current year; empty when unknown. */
export function formatMoreWorktreeDate(
  timestamp: number | string | null | undefined,
  now: number = Date.now(),
): string {
  if (timestamp === null || timestamp === undefined) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** `26 days to restore`, from a deleted item's expiry. */
export function formatRestoreNote(
  expiresAt: number | string | null | undefined,
  now: number = Date.now(),
): string | undefined {
  if (expiresAt === null || expiresAt === undefined) return undefined;
  const expiry = new Date(expiresAt).getTime();
  if (Number.isNaN(expiry)) return undefined;
  const days = Math.ceil((expiry - now) / DAY_MS);
  if (days <= 0) return 'Less than a day to restore';
  return `${days} ${days === 1 ? 'day' : 'days'} to restore`;
}

export interface ArchivedMoreWorktreeItemInput {
  readonly id: string;
  readonly state: 'archived' | 'deleted';
  readonly title: string;
  readonly branch?: string;
  readonly insertions?: number;
  readonly deletions?: number;
  /** When it reached its state. */
  readonly date: string;
  readonly expiresAt?: number | string | null;
  readonly note?: string;
  /** A lifecycle change is in flight: actions are disabled. */
  readonly busy?: boolean;
  /** Set when Restore is unavailable, saying why. */
  readonly restoreBlockedReason?: string;
  readonly onOpen?: () => void;
  readonly onRestore: () => void;
  /** Archived items move to Deleted and back. */
  readonly onToggleState: () => void;
  /** Hosts confirm before purging. */
  readonly onDeletePermanently: () => void;
  readonly testIdPrefix?: string;
}

/** An archived or deleted worktree as a More page item, with the actions every host offers. */
export function archivedMoreWorktreeItem(
  input: ArchivedMoreWorktreeItemInput,
): MoreWorktreeItem {
  const prefix = input.testIdPrefix ?? 'more-worktrees';
  const busy = input.busy === true;
  const menuActions: MoreWorktreeMenuAction[] = [];
  if (input.onOpen !== undefined) {
    menuActions.push({
      id: 'open',
      label: 'Open',
      icon: 'open',
      disabled: busy,
      onSelect: input.onOpen,
      testId: `${prefix}-open-action-${input.id}`,
    });
  }
  menuActions.push(
    input.state === 'archived'
      ? {
          id: 'delete',
          label: 'Delete',
          icon: 'delete',
          disabled: busy,
          separated: menuActions.length > 0,
          onSelect: input.onToggleState,
          testId: `${prefix}-delete-action-${input.id}`,
        }
      : {
          id: 'archive',
          label: 'Archive',
          icon: 'archive',
          disabled: busy,
          separated: menuActions.length > 0,
          onSelect: input.onToggleState,
          testId: `${prefix}-archive-action-${input.id}`,
        },
    {
      id: 'delete-permanently',
      label: 'Delete permanently',
      icon: 'delete-permanently',
      tone: 'destructive',
      disabled: busy,
      onSelect: input.onDeletePermanently,
      testId: `${prefix}-purge-action-${input.id}`,
    },
  );
  const restoreNote =
    input.state === 'deleted' ? formatRestoreNote(input.expiresAt) : undefined;
  return {
    id: input.id,
    state: input.state,
    title: input.title,
    date: input.date,
    menuActions,
    primaryAction: {
      label: 'Restore',
      onClick: input.onRestore,
      disabled: busy || input.restoreBlockedReason !== undefined,
      ...(input.restoreBlockedReason === undefined
        ? {}
        : { unavailableReason: input.restoreBlockedReason }),
      testId: `${prefix}-restore-${input.id}`,
    },
    ...(input.branch === undefined ? {} : { branch: input.branch }),
    ...(input.insertions === undefined ? {} : { insertions: input.insertions }),
    ...(input.deletions === undefined ? {} : { deletions: input.deletions }),
    ...(restoreNote === undefined ? {} : { restoreNote }),
    ...(input.note === undefined ? {} : { note: input.note }),
  };
}

function hiddenItem(
  entry: SidebarHiddenWorktreeEntry,
  options: HiddenItemOptions,
): MoreWorktreeItem {
  const { worktree, label, abilities } = entry;
  const prefix = options.testIdPrefix ?? 'more-worktrees';
  const address = {
    workspaceLocalId: worktree.workspaceLocalId,
    worktreeLocalId: worktree.localId,
  };
  const menuActions: MoreWorktreeMenuAction[] = [
    {
      id: 'open',
      label: 'Open',
      icon: 'open',
      onSelect: (): void => {
        options.onBeforeOpen?.();
        requestSidebarHiddenWorktreeAction({ kind: 'open', ...address });
      },
      testId: `${prefix}-open-action-${worktree.localId}`,
    },
  ];
  if (abilities.archive) {
    menuActions.push({
      id: 'archive',
      label: 'Archive',
      icon: 'archive',
      separated: true,
      disabled: abilities.removalLocked || !options.removalAvailable,
      onSelect: (): void => {
        requestSidebarHiddenWorktreeAction({
          kind: 'remove',
          mode: 'archive',
          ...address,
        });
      },
      testId: `${prefix}-archive-action-${worktree.localId}`,
    });
  }
  if (abilities.delete) {
    menuActions.push({
      id: 'delete',
      label: 'Delete',
      icon: 'delete',
      separated: !abilities.archive,
      disabled: abilities.removalLocked || !options.removalAvailable,
      onSelect: (): void => {
        requestSidebarHiddenWorktreeAction({
          kind: 'remove',
          mode: 'delete',
          ...address,
        });
      },
      testId: `${prefix}-delete-action-${worktree.localId}`,
    });
  }
  const running =
    worktree.isStreaming === true ||
    worktree.isRunningRun === true ||
    worktree.busy === true;
  return {
    id: worktree.localId,
    state: 'hidden',
    title: label,
    branch: worktree.branch,
    date: formatMoreWorktreeDate(worktree.lastActivityAt ?? worktree.createdAt),
    running,
    menuActions,
    ...(abilities.unhide
      ? {
          primaryAction: {
            label: 'Unhide',
            disabled: !options.removalAvailable,
            onClick: (): void => {
              requestSidebarHiddenWorktreeAction({
                kind: 'unhide',
                ...address,
              });
            },
            testId: `${prefix}-unhide-${worktree.localId}`,
          },
        }
      : {}),
    ...(worktree.diffStats === undefined
      ? {}
      : {
          insertions: worktree.diffStats.insertions,
          deletions: worktree.diffStats.deletions,
        }),
  };
}

interface HiddenItemOptions extends MoreHiddenWorktreeOptions {
  /** The sidebar is mounted to serve Unhide, Archive and Delete. */
  readonly removalAvailable: boolean;
}

export interface MoreHiddenWorktreeOptions {
  /** Leaves the page before the sidebar opens the worktree. */
  readonly onBeforeOpen?: () => void;
  readonly testIdPrefix?: string;
}

/** A workspace's hidden worktrees as More page items, wired to the sidebar. */
export function useHiddenMoreWorktreeItems(
  workspaceLocalId: string,
  options: MoreHiddenWorktreeOptions = {},
): readonly MoreWorktreeItem[] {
  const entries = useSidebarHiddenWorktrees(workspaceLocalId);
  const removalAvailable = useSidebarHiddenWorktreeRemovalAvailable();
  const { onBeforeOpen, testIdPrefix } = options;
  return useMemo(
    () =>
      entries.map((entry) =>
        hiddenItem(entry, {
          removalAvailable,
          ...(onBeforeOpen === undefined ? {} : { onBeforeOpen }),
          ...(testIdPrefix === undefined ? {} : { testIdPrefix }),
        }),
      ),
    [entries, onBeforeOpen, removalAvailable, testIdPrefix],
  );
}
