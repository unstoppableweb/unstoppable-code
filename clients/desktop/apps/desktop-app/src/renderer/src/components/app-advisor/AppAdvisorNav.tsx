import { useDesktopAutoDeleteAttention } from '@/components/worktree/useDesktopAutoDeleteAttention';
import { DesktopAutoDeleteAttention } from '@/components/worktree/DesktopAutoDeleteAttention';
import {
  useSidebarAutoDelete,
  SidebarAutoDeleteProvider,
  SidebarAutoDeleteNotice,
} from '@canopy/ui-app';
import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
/**
 * Collapsible App Advisor-only navigation rail for the popout workspace.
 *
 * Contents (expanded): a drag-region header row that reserves height under
 * the persistent {@link AppAdvisorTitlebarCorner} overlay (which owns the
 * toggle/settings/new-entry controls at constant window coordinates — this
 * nav renders no control buttons of its own), then a scrollable Work Entry
 * list (shared `WorkEntryRow` rows with select / pin / rename / archive /
 * delete through the same dialogs as the Chats section; pinned entries
 * lead), and the read-only legacy "Archived" subgroup sourced
 * from `loadLegacyArchivedChats('app-advisor')` (`global` pre-entry
 * archives).
 *
 * Collapsed: the nav animates to ZERO width and unmounts its contents; the
 * corner overlay stays put, and {@link AppAdvisorTopBar}'s corner spacer
 * provides the background beneath it — the main window's collapsed-sidebar
 * pattern. The main column is a sibling and never unmounts. The collapsed
 * state persists via `PreferencesData.appAdvisorNavCollapsed`; after the
 * width transition the nav dispatches
 * `dispatchBrowserViewBoundsInvalidated()` so hosted browser content
 * (native WebContentsViews) is resized to the new grid bounds.
 */
import {
  memo,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
  useEffect,
  useRef,
  useState,
  type JSX,
} from 'react';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import { resolveArchiveRetentionDays } from '@canopy/desktop-shared/lib/archive-retention';
import {
  getSidebarProjectEntries,
  useStandaloneChatStore,
} from '@/stores/standaloneChatStore';
import { useChatSidebarStore } from '@/stores/chatSidebarStore';
import { useGitHubStore } from '@/stores/githubStore';
import { orderWorkEntryRows } from '@/lib/sidebar-ordering';
import {
  EMPTY_ARCHIVED_CONTAINERS,
  EMPTY_PENDING_ARCHIVED_CONTAINERS,
  useArchivedContainersStore,
} from '@/stores/archivedContainersStore';
import { WorkEntryRemovalConfirmDialog } from '@/components/standalone-chat/WorkEntryRemovalConfirmDialog';
import {
  ARCHIVE_TOOLTIP,
  CodeSidebarItemGroups,
  SidebarSelectionRowsReporter,
  WorktreeSortableStateContext,
  buildSidebarItemGroupBlocks,
  deleteRetentionTooltip,
  useSidebarBulk,
  useSidebarSelectionRows,
  useSidebarWorkEntryBulk,
  workEntryRowKey,
  workEntryRowMultiSelectProps,
  type CodeSidebarItemGroupCommands,
  type SidebarBatchRemovalUiState,
  type SidebarSelectionRow,
  type WorkEntryMultiSelectBinding,
  type WorkEntryRemovalMode,
} from '@canopy/ui-app/sidebar';
import { withSelectionGroupItems } from '@canopy/ui-app';
import {
  ActionMenuRowStyle,
  RenameDialog,
  WorkEntryRow,
  WorkEntryRowMenuItems,
  WorktreeActionMenuItems,
  type WorkEntryRowMenuContext,
  type WorktreeMenuItem,
  EmptyStateRow,
} from '@canopy/ui-shared/components';
import { CHAT_UNIT_LABEL } from '@canopy/protocol';
import type { CoworkWorkEntryMeta } from '@canopy/desktop-shared/types';
import { useSidebarItemGroupsStore } from '@/stores/sidebarItemGroupsStore';
import type {
  SidebarItemGroup,
  SidebarItemGroupScope,
} from '@canopy/protocol/sidebar';
import {
  AgentStateGlyph,
  ArchivedContainersNavLink,
  Dot,
  ThinkingSpinner,
} from '@canopy/ui-shared';
import { useBackgroundTaskCounts } from '@/hooks/useBackgroundTaskCounts';
import { openArchivedOverviewSurface } from '@/lib/archivedContainerNavigation';
import { dismissPageLikeViewers } from '@/lib/dismissPageLikeViewers';
import { dispatchBrowserViewBoundsInvalidated } from '@/lib/browserViewBounds';
import type { StandaloneChatMeta } from '@canopy/desktop-shared/types';
import { APP_ADVISOR_SETTINGS_SAVED_EVENT } from '@/lib/appAdvisorSettingsEvents';

interface AppAdvisorSettingsSavedDetail {
  archiveRetentionDays?: number | null;
  autoArchiveDays?: number | null;
}

export function isAppAdvisorSettingsSavedDetail(
  value: unknown,
): value is AppAdvisorSettingsSavedDetail {
  if (typeof value !== 'object' || value === null) return false;
  const archiveRetentionDays =
    'archiveRetentionDays' in value ? value.archiveRetentionDays : undefined;
  const autoArchiveDays =
    'autoArchiveDays' in value ? value.autoArchiveDays : undefined;
  return (
    (archiveRetentionDays === undefined ||
      archiveRetentionDays === null ||
      typeof archiveRetentionDays === 'number') &&
    (autoArchiveDays === undefined ||
      autoArchiveDays === null ||
      typeof autoArchiveDays === 'number')
  );
}

const ADVISOR_SCOPE: SidebarItemGroupScope = { appAdvisor: true };
const EMPTY_GROUPS: SidebarItemGroup[] = [];

const EMPTY_LEGACY_ARCHIVED: StandaloneChatMeta[] = [];

const NAV_ROW_TEST_ID_PREFIX = 'app-advisor-nav-entry';

interface AppAdvisorNavEntryRowProps {
  readonly entry: CoworkWorkEntryMeta;
  readonly selected: boolean;
  /** An agent question in the entry waits for an answer. */
  readonly hasPendingQuestion: boolean;
  /** Live background tasks in the entry's chats. */
  readonly backgroundTasks: number;
  readonly removing: boolean;
  readonly groupMenu: readonly WorktreeMenuItem[];
  readonly deleteTitle: string;
  readonly onOpen: (entryId: string) => void;
  readonly onSetPinned: (entryId: string, pinned: boolean) => void;
  readonly onRename: (entryId: string) => void;
  readonly onRemove: (entryId: string, mode: WorkEntryRemovalMode) => void;
  /** The nav's bulk selection (CAN-3975). */
  readonly selectionBinding?: WorkEntryMultiSelectBinding;
}

/**
 * One App Advisor entry: the shared Work Entry row the Chats section uses,
 * with its menu (Pin, the group organizer, Rename, Archive, Delete). Rename
 * and the removal confirm are the nav's dialogs, outside the list.
 */
function AppAdvisorNavEntryRow({
  entry,
  selected,
  hasPendingQuestion,
  backgroundTasks,
  removing,
  groupMenu,
  deleteTitle,
  onOpen,
  onSetPinned,
  onRename,
  onRemove,
  selectionBinding,
}: AppAdvisorNavEntryRowProps): JSX.Element {
  const autoDelete = useSidebarAutoDelete({
    workspaceId: APP_ADVISOR_PROJECT_ID,
    targetId: entry.id,
    name: entry.title,
  });
  const rowTestId = `${NAV_ROW_TEST_ID_PREFIX}-${entry.id}`;
  const selectionKey = workEntryRowKey(APP_ADVISOR_PROJECT_ID, entry.id);
  const batchRemoving = selectionBinding?.isRemoving(selectionKey) === true;
  const multiSelect = useMemo(
    () =>
      selectionBinding === undefined
        ? undefined
        : workEntryRowMultiSelectProps(
            selectionBinding,
            APP_ADVISOR_PROJECT_ID,
            selectionKey,
            !removing,
          ),
    [selectionBinding, selectionKey, removing],
  );
  // The group list's drag wrapper owns the pointer sensor; the row only
  // carries the sortable attributes, as the Chats rows do.
  const sortable = useContext(WorktreeSortableStateContext);
  const drag = useMemo(
    () =>
      sortable === null
        ? undefined
        : { attributes: sortable.attributes, isDragging: sortable.isDragging },
    [sortable],
  );
  const pinned = entry.pinned === true;
  const renderMenuItems = useCallback(
    (menu: WorkEntryRowMenuContext): ReactNode => {
      // Rendered only while the menu is open.
      const selectionMenu = selectionBinding?.menuItemsFor(selectionKey, {
        bulkPin: `${rowTestId}-bulk-pin`,
        bulkArchive: `${rowTestId}-bulk-archive`,
        bulkDelete: `${rowTestId}-bulk-delete`,
      });
      const selectionItems = selectionMenu?.items ?? [];
      const runSelectionItem = (item: WorktreeMenuItem): void => {
        if (item.role !== 'menuitemradio') menu.close();
        item.onSelect?.();
      };
      if (selectionMenu?.replacesMenu === true) {
        return (
          <ActionMenuRowStyle>
            <WorktreeActionMenuItems
              items={withSelectionGroupItems(selectionItems, groupMenu)}
              onSelect={runSelectionItem}
            />
          </ActionMenuRowStyle>
        );
      }
      return (
        <WorkEntryRowMenuItems
          autoDelete={autoDelete.autoDelete}
          onAutoDeleteDisarm={autoDelete.onAutoDeleteDisarm}
          menu={menu}
          pinned={pinned}
          onTogglePin={(next): void => onSetPinned(entry.id, next)}
          afterPin={
            groupMenu.length > 0 ? (
              <WorktreeActionMenuItems
                items={groupMenu}
                onSelect={(item): void => {
                  menu.close();
                  item.onSelect?.();
                }}
              />
            ) : undefined
          }
          onRename={(): void => onRename(entry.id)}
          onArchive={(): void => onRemove(entry.id, 'archive')}
          archiveTitle={ARCHIVE_TOOLTIP}
          onDelete={(): void => onRemove(entry.id, 'delete')}
          deleteTitle={deleteTitle}
          beforeRemoval={
            selectionItems.length > 0 ? (
              <WorktreeActionMenuItems
                items={selectionItems}
                onSelect={runSelectionItem}
              />
            ) : undefined
          }
        />
      );
    },
    [
      autoDelete.autoDelete,
      autoDelete.onAutoDeleteDisarm,
      pinned,
      onSetPinned,
      entry.id,
      groupMenu,
      onRename,
      onRemove,
      deleteTitle,
      selectionBinding,
      selectionKey,
      rowTestId,
    ],
  );
  return (
    <WorkEntryRow
      {...autoDelete}
      title={entry.title}
      testId={rowTestId}
      entryId={entry.id}
      multiSelect={multiSelect}
      status={entry.status === 'done' ? 'done' : 'active'}
      selected={selected}
      working={entry.hasActiveChat === true}
      backgroundTasks={backgroundTasks}
      hasPendingQuestion={hasPendingQuestion}
      hasUnread={(entry.unreadChats?.length ?? 0) > 0}
      pinnedToTop={pinned}
      removing={removing || batchRemoving}
      drag={drag}
      onOpen={(): void => onOpen(entry.id)}
      renderMenuItems={renderMenuItems}
      menuLabel={entry.title}
    />
  );
}

export interface AppAdvisorNavProps {
  /** Persisted collapsed state. */
  collapsed: boolean;
}

export const AppAdvisorNav = memo(function AppAdvisorNav(
  props: AppAdvisorNavProps,
): JSX.Element {
  return (
    <SidebarAutoDeleteProvider>
      <AppAdvisorNavContent {...props} />
    </SidebarAutoDeleteProvider>
  );
});

function AppAdvisorNavContent({ collapsed }: AppAdvisorNavProps): JSX.Element {
  const attention = useDesktopAutoDeleteAttention();
  const workEntries = useStandaloneChatStore((s) => s.workEntries);
  // Advisor chats key as `(app-advisor, <workEntryId>)`, so a waiting
  // question's worktreeId is its entry. Joined to keep the selection stable.
  const questionEntryIdList = useChatSidebarStore((s) =>
    Object.values(s.pendingQuestions)
      .filter(
        (question) =>
          question.answeredAt === undefined &&
          question.projectId === APP_ADVISOR_PROJECT_ID,
      )
      .map((question) => question.worktreeId)
      .sort()
      .join('\n'),
  );
  const questionEntryIds = useMemo(
    () => new Set(questionEntryIdList.split('\n')),
    [questionEntryIdList],
  );
  const backgroundCounts = useBackgroundTaskCounts(
    APP_ADVISOR_PROJECT_ID,
    workEntries.map((entry) => entry.id),
  );
  const activeWorkEntryId = useStandaloneChatStore((s) => s.activeWorkEntryId);
  const archiveOverlayChatId = useStandaloneChatStore(
    (s) => s.archiveOverlayChatId,
  );
  const selectWorkEntry = useStandaloneChatStore((s) => s.selectWorkEntry);
  const renameWorkEntry = useStandaloneChatStore((s) => s.renameWorkEntry);
  const deleteWorkEntry = useStandaloneChatStore((s) => s.deleteWorkEntry);
  const setWorkEntryPinned = useStandaloneChatStore(
    (s) => s.setWorkEntryPinned,
  );
  // Pinned entries lead, as on the main sidebar; the rest keep the registry
  // order this list has always shown.
  const orderedWorkEntries = useMemo(
    () => orderWorkEntryRows(workEntries, 'manual'),
    [workEntries],
  );
  const loadLegacyArchivedChats = useStandaloneChatStore(
    (s) => s.loadLegacyArchivedChats,
  );
  const legacyArchivedLoaded = useStandaloneChatStore(
    (s) => s.legacyArchivedByProject[APP_ADVISOR_PROJECT_ID] !== undefined,
  );
  const legacyArchivedChats = useStandaloneChatStore(
    (s) =>
      s.legacyArchivedByProject[APP_ADVISOR_PROJECT_ID] ??
      EMPTY_LEGACY_ARCHIVED,
  );

  // Retained ("Archived" / "Deleted") work-entry containers, counted into
  // the "Archived and deleted" nav link alongside the legacy archived chats.
  const archivedEntries = useArchivedContainersStore(
    (s) => s.byWorkspace[APP_ADVISOR_PROJECT_ID] ?? EMPTY_ARCHIVED_CONTAINERS,
  );
  // Removals still being captured count immediately so the link reacts the
  // moment the entry leaves the list, not when main finishes cleanup.
  const pendingArchivedEntries = useArchivedContainersStore(
    (s) =>
      s.pendingByWorkspace[APP_ADVISOR_PROJECT_ID] ??
      EMPTY_PENDING_ARCHIVED_CONTAINERS,
  );
  const archivedContainersLoaded = useArchivedContainersStore(
    (s) => s.loadedWorkspaces[APP_ADVISOR_PROJECT_ID] === true,
  );
  // The archived container currently open in the viewer for this workspace
  // (primitive selector so unrelated viewer changes don't re-render the nav).
  const openContainerId = useArchivedContainersStore((s) =>
    s.viewer !== null && s.viewer.workspaceId === APP_ADVISOR_PROJECT_ID
      ? s.viewer.containerId
      : null,
  );
  const archivedOverviewOpen = useArchivedContainersStore(
    (s) => s.overview?.workspaceId === APP_ADVISOR_PROJECT_ID,
  );

  const [groupEditorId, setGroupEditorId] = useState<string | null>(null);
  useCurrentUiStateReporter('sidebar.itemGroupEditor.app-advisor', {
    groupId: groupEditorId,
  });
  const groups = useSidebarItemGroupsStore(
    (state) => state.byScope['app-advisor'] ?? EMPTY_GROUPS,
  );
  useEffect(() => {
    if (collapsed || !window.api?.sidebarItemGroups) return;
    const refresh = (): void => {
      void useSidebarItemGroupsStore
        .getState()
        .hydrate(ADVISOR_SCOPE)
        .catch(() => undefined);
    };
    refresh();
    return window.api.sidebarItemGroups.onChanged?.((scope) => {
      if (scope.appAdvisor) refresh();
    });
  }, [collapsed]);
  const blocks = useMemo(
    () =>
      buildSidebarItemGroupBlocks(
        orderedWorkEntries.map((entry) => ({
          rootId: entry.id,
          itemIds: [entry.id],
          pinned: entry.pinned === true,
        })),
        groups,
        'manual',
        activeWorkEntryId ?? undefined,
      ),
    [orderedWorkEntries, groups, activeWorkEntryId],
  );
  const reportGroupError = (error: unknown): void =>
    useGitHubStore
      .getState()
      .addToast(
        error instanceof Error
          ? error.message
          : 'Group changes could not be saved. Try again.',
        'error',
      );
  const groupStore = useSidebarItemGroupsStore.getState();
  const commands: CodeSidebarItemGroupCommands = {
    create: (itemId) => groupStore.create({ scope: ADVISOR_SCOPE, itemId }),
    update: (groupId, patch): Promise<void> =>
      groupStore
        .update({ scope: ADVISOR_SCOPE, groupId, ...patch })
        .catch(reportGroupError),
    ungroup: (groupId): void => {
      void groupStore
        .ungroup({ scope: ADVISOR_SCOPE, groupId })
        .catch(reportGroupError);
    },
    moveItem: (itemId, drop): void => {
      void groupStore
        .moveItem({
          scope: ADVISOR_SCOPE,
          itemId,
          groupId: drop.groupId,
          ...(drop.before
            ? { before: drop.before }
            : drop.after
              ? { after: drop.after }
              : {}),
        })
        .catch(reportGroupError);
    },
    moveGroup: (groupId, drop): void => {
      void groupStore
        .moveGroup({
          scope: ADVISOR_SCOPE,
          groupId,
          ...(drop.before
            ? { before: drop.before }
            : drop.after
              ? { after: drop.after }
              : {}),
        })
        .catch(reportGroupError);
    },
  };

  const [removingEntryIds, setRemovingEntryIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [renamingEntryId, setRenamingEntryId] = useState<string | null>(null);
  const [confirmingRemoval, setConfirmingRemoval] = useState<{
    readonly entryId: string;
    readonly mode: WorkEntryRemovalMode;
  } | null>(null);

  // Effective deletion-retention window drives the Delete tooltip copy. App
  // Advisor retention lives in its workspace settings file (no store holds
  // it), so load it best-effort once; the surface default (7 days) applies
  // while loading or when the bridge is unavailable.
  const [effectiveRetentionDays, setEffectiveRetentionDays] = useState<number>(
    () => resolveArchiveRetentionDays('app-advisor', undefined),
  );
  const applySettings = useCallback((settings: unknown): void => {
    if (!isAppAdvisorSettingsSavedDetail(settings)) return;
    setEffectiveRetentionDays(
      resolveArchiveRetentionDays('app-advisor', settings.archiveRetentionDays),
    );
  }, []);
  useEffect(() => {
    const handleSaved = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return;
      applySettings(event.detail);
    };
    window.addEventListener(APP_ADVISOR_SETTINGS_SAVED_EVENT, handleSaved);
    return (): void =>
      window.removeEventListener(APP_ADVISOR_SETTINGS_SAVED_EVENT, handleSaved);
  }, [applySettings]);
  useEffect(() => {
    if (typeof window.api?.appAdvisor?.onSettingsChanged !== 'function') {
      return;
    }
    return window.api.appAdvisor.onSettingsChanged(applySettings);
  }, [applySettings]);
  useEffect(() => {
    if (typeof window.api?.appAdvisor?.settingsLoad !== 'function') {
      return;
    }
    let cancelled = false;
    void window.api.appAdvisor
      .settingsLoad()
      .then((settings) => {
        if (!cancelled) {
          setEffectiveRetentionDays(
            resolveArchiveRetentionDays(
              'app-advisor',
              settings.archiveRetentionDays,
            ),
          );
        }
      })
      .catch(() => {
        // Best-effort: keep the surface default.
      });
    return (): void => {
      cancelled = true;
    };
  }, []);

  // Lazily load the legacy (`global`) archived subgroup once expanded.
  useEffect(() => {
    if (!collapsed && !legacyArchivedLoaded) {
      void loadLegacyArchivedChats(APP_ADVISOR_PROJECT_ID).catch(() => {
        // Legacy archive loads are best-effort; the subgroup stays hidden.
      });
    }
  }, [collapsed, legacyArchivedLoaded, loadLegacyArchivedChats]);

  // Lazily load archived containers once expanded (best-effort; errors are
  // swallowed in the store and the subgroup shows its empty state).
  useEffect(() => {
    if (!collapsed && !archivedContainersLoaded) {
      void useArchivedContainersStore
        .getState()
        .loadForWorkspace(APP_ADVISOR_PROJECT_ID);
    }
  }, [collapsed, archivedContainersLoaded]);

  // Browser bounds contract: native WebContentsViews do not track CSS width
  // transitions, so invalidate once the nav's width transition settles.
  const navRef = useRef<HTMLElement | null>(null);
  const handleTransitionEnd = useCallback(
    (event: React.TransitionEvent<HTMLElement>): void => {
      if (event.target === navRef.current && event.propertyName === 'width') {
        dispatchBrowserViewBoundsInvalidated();
      }
    },
    [],
  );

  const handleSelectEntry = useCallback(
    (entryId: string): void => {
      // Explicit navigation to a live entry dismisses the page-like archived
      // viewer (programmatic activations must not).
      dismissPageLikeViewers();
      void selectWorkEntry(entryId);
    },
    [selectWorkEntry],
  );

  const handleRenameEntry = useCallback(
    (entryId: string, title: string | null): void => {
      void renameWorkEntry(entryId, title).catch(() => {
        // Rename failures should not break the nav.
      });
    },
    [renameWorkEntry],
  );

  const handleDeleteEntry = useCallback(
    (entryId: string, options: { mode: WorkEntryRemovalMode }): void => {
      setRemovingEntryIds((current) => new Set(current).add(entryId));
      void deleteWorkEntry(entryId, undefined, {
        lockAfterArchive: options.mode === 'archive',
      })
        .catch(() => {
          // Delete failures should not break the nav.
        })
        .finally(() => {
          setRemovingEntryIds((current) => {
            const next = new Set(current);
            next.delete(entryId);
            return next;
          });
        });
    },
    [deleteWorkEntry],
  );

  const handleRequestRemoval = useCallback(
    (entryId: string, mode: WorkEntryRemovalMode): void =>
      setConfirmingRemoval({ entryId, mode }),
    [],
  );
  const deleteTitle = deleteRetentionTooltip(effectiveRetentionDays);

  // Bulk selection (CAN-3975): the nav keeps its own selection over its
  // entries, with the rail's gestures, menu, confirm, and runner.
  const selectionRows = useSidebarSelectionRows();
  const [batchState, setBatchState] =
    useState<SidebarBatchRemovalUiState | null>(null);
  // Its own key, so this nav closing never clears the main rail's dialog.
  useCurrentUiStateReporter(
    'appAdvisor.batchRemovalDialog',
    batchState === null ? null : { ...batchState },
  );
  const workEntryBulk = useSidebarWorkEntryBulk({
    enabled: true,
    // The single-row confirm's store call, with the target's own project so
    // a batch does not follow the active project while it runs.
    remove: (workspaceId, entryId, { mode }) =>
      deleteWorkEntry(entryId, workspaceId, {
        lockAfterArchive: mode === 'archive',
      }),
    // Read live, so an entry removed elsewhere mid-batch is skipped. App
    // Advisor entries have no delegates block.
    getFacts: (workspaceId, entryId) =>
      getSidebarProjectEntries(
        useStandaloneChatStore.getState(),
        workspaceId,
      ).some((candidate) => candidate.id === entryId)
        ? {}
        : undefined,
    rows: selectionRows.rows,
    activeKey:
      activeWorkEntryId === null
        ? undefined
        : workEntryRowKey(APP_ADVISOR_PROJECT_ID, activeWorkEntryId),
    retentionDaysFor: () => effectiveRetentionDays,
    dialogTestId: 'app-advisor-batch-removal-dialog',
    onStateChange: setBatchState,
    // Pin from the selection menu: the single row's store call and toast.
    // App Advisor rows offer no Mark done or notification choices.
    getEntryState: (workspaceId, entryId) => {
      const entry = getSidebarProjectEntries(
        useStandaloneChatStore.getState(),
        workspaceId,
      ).find((candidate) => candidate.id === entryId);
      return entry === undefined
        ? undefined
        : { pinned: entry.pinned === true };
    },
    setPinned: (workspaceId, entryId, pinned) =>
      setWorkEntryPinned(entryId, pinned, workspaceId).catch(() => {
        useGitHubStore
          .getState()
          .addToast(pinned ? 'Failed to pin' : 'Failed to unpin', 'error');
      }),
  });
  const bulk = useSidebarBulk({
    ...selectionRows,
    bindings: [workEntryBulk.binding],
  });
  const listBinding = bulk.bindingFor(APP_ADVISOR_PROJECT_ID);
  const selectionBinding = useMemo(
    (): WorkEntryMultiSelectBinding => ({
      ...listBinding,
      isSelectable: () => true,
    }),
    [listBinding],
  );
  const navSelectionRows: SidebarSelectionRow[] = blocks
    .flatMap((block) => block.visibleItemIds)
    .flatMap((id): SidebarSelectionRow[] => {
      const entry = workEntries.find((candidate) => candidate.id === id);
      return entry === undefined
        ? []
        : [
            {
              key: workEntryRowKey(APP_ADVISOR_PROJECT_ID, id),
              kind: 'work-entry',
              selectable: !removingEntryIds.has(id),
              label: entry.title,
              projectName: 'App Advisor',
              open: id === activeWorkEntryId,
            },
          ];
    });

  const renamingEntry =
    renamingEntryId === null
      ? undefined
      : workEntries.find((entry) => entry.id === renamingEntryId);
  const removingEntry =
    confirmingRemoval === null
      ? undefined
      : workEntries.find((entry) => entry.id === confirmingRemoval.entryId);

  const handleSetEntryPinned = useCallback(
    (entryId: string, pinned: boolean): void => {
      void setWorkEntryPinned(entryId, pinned, APP_ADVISOR_PROJECT_ID).catch(
        () => {
          useGitHubStore
            .getState()
            .addToast(pinned ? 'Failed to pin' : 'Failed to unpin', 'error');
        },
      );
    },
    [setWorkEntryPinned],
  );

  const handleOpenArchivedOverview = useCallback((): void => {
    openArchivedOverviewSurface(APP_ADVISOR_PROJECT_ID);
  }, []);

  return (
    <nav
      ref={navRef}
      data-testid="app-advisor-nav"
      data-collapsed={collapsed ? 'true' : 'false'}
      aria-label={`${ORCHESTRATOR_LABEL} navigation`}
      onTransitionEnd={handleTransitionEnd}
      // No divider: like the main window's sidebar in the inset layout, the
      // nav sits on the window material and the cards beside it draw the edge.
      className={`flex h-full shrink-0 flex-col overflow-hidden transition-[width] duration-150 ease-out ${
        collapsed ? 'w-0' : 'w-60'
      }`}
    >
      {/* Header: a drag-region row reserving height beneath the persistent
          AppAdvisorTitlebarCorner overlay (which owns the control buttons at
          constant window coordinates). */}
      {!collapsed && <div className="electron-drag h-10.75 shrink-0" />}

      {/* Entry list + legacy archives — unmounted while collapsed (the nav
          is zero-width; the corner overlay stays put above the top bar). */}
      {!collapsed && (
        // Unmounted while collapsed, so a collapsed nav reports no rows.
        <SidebarSelectionRowsReporter
          listId={APP_ADVISOR_PROJECT_ID}
          rows={navSelectionRows}
          onRowsChange={selectionBinding.onRowsChange}
        />
      )}
      {!collapsed && (
        <div className="min-h-0 flex-1 overflow-y-auto pr-1.5 pb-2">
          {workEntries.length === 0 &&
          blocks.length === 0 &&
          legacyArchivedChats.length === 0 &&
          archivedEntries.length === 0 ? (
            <div className="px-2">
              <EmptyStateRow title="No work entries yet" />
            </div>
          ) : (
            <>
              <div className="pl-1.5">
                <CodeSidebarItemGroups
                  onEditorChange={setGroupEditorId}
                  blocks={blocks}
                  groups={groups}
                  mode="manual"
                  commands={commands}
                  unitLabel={{ singular: 'chat', plural: 'chats' }}
                  rowGap="hairline"
                  itemGap="hairline"
                  canDragRow={(): boolean => true}
                  // A drag of a selected entry carries the whole selection.
                  selectionCount={selectionBinding.selection.count}
                  isItemSelected={
                    selectionBinding.selection.active
                      ? (id): boolean =>
                          selectionBinding.selection.isSelected(
                            workEntryRowKey(APP_ADVISOR_PROJECT_ID, id),
                          )
                      : undefined
                  }
                  onCreate={(groupId): void => {
                    void useStandaloneChatStore
                      .getState()
                      .createWorkEntry({ sidebarItemGroupId: groupId })
                      .catch(reportGroupError);
                  }}
                  onError={reportGroupError}
                  renderStatus={(block): ReactNode =>
                    block.units.some(
                      (unit) =>
                        workEntries.find((entry) => entry.id === unit.rootId)
                          ?.hasActiveChat,
                    ) ? (
                      <span aria-label="Active work in group">
                        <ThinkingSpinner tone="active" />
                      </span>
                    ) : block.units.some(
                        (unit) =>
                          (workEntries.find((entry) => entry.id === unit.rootId)
                            ?.unreadChats?.length ?? 0) > 0,
                      ) ? (
                      <Dot tone="unread" label="Unread work in group" />
                    ) : block.units.some(
                        (unit) => (backgroundCounts[unit.rootId] ?? 0) > 0,
                      ) ? (
                      <AgentStateGlyph
                        state="background"
                        backgroundTasks={block.units.reduce(
                          (total, unit) =>
                            total + (backgroundCounts[unit.rootId] ?? 0),
                          0,
                        )}
                      />
                    ) : null
                  }
                  renderPreview={(id): ReactNode => (
                    <div className="flex h-8 items-center px-1.5 text-s fg-primary">
                      {workEntries.find((entry) => entry.id === id)?.title}
                    </div>
                  )}
                  renderRow={(id, menu): ReactNode => {
                    const entry = workEntries.find((entry) => entry.id === id);
                    return entry ? (
                      <AppAdvisorNavEntryRow
                        entry={entry}
                        groupMenu={menu}
                        selected={
                          entry.id === activeWorkEntryId &&
                          archiveOverlayChatId === null &&
                          openContainerId === null
                        }
                        removing={
                          removingEntryIds.has(entry.id) ||
                          bulk.isQueuedForRemoval(
                            workEntryRowKey(APP_ADVISOR_PROJECT_ID, entry.id),
                          )
                        }
                        deleteTitle={deleteTitle}
                        onOpen={handleSelectEntry}
                        onSetPinned={handleSetEntryPinned}
                        onRename={setRenamingEntryId}
                        onRemove={handleRequestRemoval}
                        selectionBinding={selectionBinding}
                        hasPendingQuestion={questionEntryIds.has(entry.id)}
                        backgroundTasks={backgroundCounts[entry.id] ?? 0}
                      />
                    ) : null;
                  }}
                />
              </div>
              <ArchivedContainersNavLink
                count={
                  legacyArchivedChats.length +
                  archivedEntries.length +
                  pendingArchivedEntries.length
                }
                selected={
                  archivedOverviewOpen ||
                  openContainerId !== null ||
                  archiveOverlayChatId !== null
                }
                onOpen={handleOpenArchivedOverview}
                testId="app-advisor-nav-archived-link"
              />
            </>
          )}
        </div>
      )}
      {/* The bulk removal's progress and outcome, below the scrolling list so
          it stays on screen; the queue keeps running while the nav collapses. */}
      {!collapsed && bulk.notice !== null && (
        <div
          className="flex shrink-0 flex-col px-1.5 pb-1.5 pt-2"
          data-testid="app-advisor-nav-footer-callout"
        >
          {bulk.notice}
        </div>
      )}
      {!collapsed && (
        <DesktopAutoDeleteAttention attention={attention} announce={false} />
      )}
      {/* Outside the collapsed-unmount block: results stay viewable while the
          nav collapses. */}
      {bulk.dialog}
      {renamingEntry !== undefined && (
        <RenameDialog
          title={`Rename ${CHAT_UNIT_LABEL.toLowerCase()}`}
          label="Name"
          initialValue={renamingEntry.title}
          submitLabel="Rename"
          onSubmit={(value): void => {
            const trimmed = value.trim();
            setRenamingEntryId(null);
            if (trimmed === renamingEntry.title) return;
            // An emptied title clears the rename override (falls back to
            // the chat-derived title).
            handleRenameEntry(
              renamingEntry.id,
              trimmed.length > 0 ? trimmed : null,
            );
          }}
          onClose={(): void => setRenamingEntryId(null)}
          titleId={`rename-work-entry-${renamingEntry.id}-title`}
          inputId={`rename-work-entry-${renamingEntry.id}`}
          dataTestId={`${NAV_ROW_TEST_ID_PREFIX}-${renamingEntry.id}-rename-dialog`}
          inputTestId={`${NAV_ROW_TEST_ID_PREFIX}-${renamingEntry.id}-rename-input`}
        />
      )}
      {confirmingRemoval !== null && (
        <WorkEntryRemovalConfirmDialog
          mode={confirmingRemoval.mode}
          entryTitle={removingEntry?.title ?? ''}
          retentionDays={effectiveRetentionDays}
          rowTestId={`${NAV_ROW_TEST_ID_PREFIX}-${confirmingRemoval.entryId}`}
          busy={removingEntryIds.has(confirmingRemoval.entryId)}
          onCancel={(): void => setConfirmingRemoval(null)}
          onConfirm={(): void => {
            const { entryId, mode } = confirmingRemoval;
            setConfirmingRemoval(null);
            handleDeleteEntry(entryId, { mode });
          }}
        />
      )}
      <SidebarAutoDeleteNotice />
    </nav>
  );
}
