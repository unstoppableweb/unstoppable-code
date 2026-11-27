import { ControlButton } from '@canopy/ui-shared/components';
import { WorkspaceIconSlot } from '@canopy/ui-shared/components';
import {
  memo,
  useCallback,
  useRef,
  useState,
  type JSX,
  type MouseEvent,
} from 'react';
import type {
  DraggableAttributes,
  DraggableSyntheticListeners,
} from '@dnd-kit/core';
import {
  MenuItem,
  MenuItemIcon,
  Menu,
  MenuPointAnchor,
  WorkspaceIconDisclosureSwap,
  WorkspaceSectionHeader,
} from '@canopy/ui-shared/components';
import {
  AssignmentAddIcon,
  DownloadIcon,
  SettingsIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { useProjectsStore } from '@/stores/projectsStore';
import {
  SidebarPinMenuItem,
  SidebarSortMenuItems,
} from '../sidebar/SidebarSortMenuItems';
import { useCloudConnectGateStore } from '@/stores/cloudConnectGateStore';
import { openImportSessionModal } from '@/stores/importSessionModalStore';
import { ProjectIcon } from '../shared/ProjectIcon';
import { useLabsExperimentEnabled } from '@/stores/labsExperimentsStore';

interface ProjectHeaderProps {
  projectId: string;
  name: string;
  color: string;
  worktreeCount: number;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onCreateWorktree: () => void;
  /** Absent on pinned selected-item copies, which are never drag sources. */
  dragHandleAttributes?: DraggableAttributes;
  dragHandleListeners?: DraggableSyntheticListeners;
  disableDrag?: boolean;
  isMultiRepo?: boolean;
  /** Local repository used to resolve an optional GitHub owner avatar. */
  repoPath?: string;
  /**
   * Marks the section as a transient adhoc multi-repo workspace so the badge
   * uses the temporary-flavored icon and a neutral gray background instead of
   * the workspace's assigned color. Ignored when `isMultiRepo` is false.
   */
  temporary?: boolean;
  onOpenSettings?: () => void;
  repoCount?: number;
  /**
   * Optional repo name list for the multi-repo sub-label tooltip. Forwarded
   * to `WorkspaceSectionHeader`; ignored for single-repo workspaces.
   */
  repoNames?: string[];
  createWorktreeDisabled?: boolean;
  hasSettingsWarning?: boolean;
  /** Distinguishes the dedicated pinned copies from the in-flow row. */
  surface?: 'flow' | 'sticky-slot' | 'pin-top' | 'pin-bottom';
}

/**
 * Desktop wrapper around the shared {@link WorkspaceSectionHeader}. Owns the
 * dnd-kit drag handle markup (which carries Draggable attributes/listeners
 * that the shared component cannot define on its own) and forwards display
 * data to the shared row chrome.
 */
export const ProjectHeader = memo(function ProjectHeader({
  projectId,
  name,
  color,
  worktreeCount,
  collapsed,
  onToggleCollapsed,
  onCreateWorktree,
  dragHandleAttributes,
  dragHandleListeners,
  disableDrag,
  isMultiRepo,
  repoPath,
  temporary,
  onOpenSettings,
  repoCount,
  repoNames,
  createWorktreeDisabled,
  hasSettingsWarning,
  surface = 'flow',
}: ProjectHeaderProps): JSX.Element {
  const hideCount = useLabsExperimentEnabled('sidebar');
  const headerRef = useRef<HTMLDivElement | null>(null);
  const contextMenuAnchorRef = useRef<HTMLSpanElement | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const closeContextMenu = useCallback((): void => setContextMenu(null), []);

  // CAN-1074: pin + ordering state is read straight from the projects store so
  // the header does not need extra prop plumbing through ProjectSection.
  const workspacePinned = useProjectsStore(
    (state) =>
      state.projects.find((project) => project.id === projectId)?.pinned ===
      true,
  );
  const workspaceItemSortMode = useProjectsStore(
    (state) =>
      state.projects.find((project) => project.id === projectId)?.itemSortMode,
  );
  const setWorkspacePinned = useProjectsStore(
    (state) => state.setWorkspacePinned,
  );
  const setWorkspaceItemSortMode = useProjectsStore(
    (state) => state.setWorkspaceItemSortMode,
  );
  const handleContextMenu = useCallback(
    (event: MouseEvent<HTMLDivElement>): void => {
      event.preventDefault();
      headerRef.current?.focus({ preventScroll: true });
      setContextMenu({ x: event.clientX, y: event.clientY });
    },
    [],
  );
  const handleOptions = useCallback(
    (event: MouseEvent<HTMLButtonElement>): void => {
      const rect = event.currentTarget.getBoundingClientRect();
      setContextMenu({ x: rect.left, y: rect.bottom });
    },
    [],
  );
  const displayName =
    typeof name === 'string' && name.trim().length > 0
      ? name
      : 'Untitled project';
  // Every non-flow copy (slot or selected-item pin) suffixes its automation
  // ids so flow selectors stay unique.
  const testIdSuffix = surface === 'flow' ? '' : `-${surface}`;

  // Pointer-activated header controls retain DOM focus after their action.
  // Once a workspace collapses or settings close, that stale focus keeps the
  // focus-within action state visible instead of restoring the counter. Clear
  // only non-focus-visible focus so keyboard activation keeps its expected
  // focus location and accessible action reveal.
  const clearPointerFocus = useCallback((): void => {
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      headerRef.current?.contains(active) &&
      !active.matches(':focus-visible')
    ) {
      active.blur();
    }
  }, []);
  const handleToggleCollapsed = useCallback((): void => {
    onToggleCollapsed();
    clearPointerFocus();
  }, [clearPointerFocus, onToggleCollapsed]);
  const handleCreateWorktree = useCallback((): void => {
    onCreateWorktree();
    clearPointerFocus();
  }, [clearPointerFocus, onCreateWorktree]);
  const handleOpenSettings = useCallback((): void => {
    onOpenSettings?.();
    clearPointerFocus();
  }, [clearPointerFocus, onOpenSettings]);

  const projectIcon = (
    <ProjectIcon
      kind={isMultiRepo ? 'multi-repo' : 'single-repo'}
      temporary={temporary}
      color={color}
      repoPath={repoPath}
      testIdSuffix={surface === 'flow' ? '' : `-${surface}`}
    />
  );
  // The icon doubles as the disclosure affordance: at rest only the icon is
  // visible (no chevron in the default state), and hovering or focusing the
  // row swaps it for the collapse chevron in place. A plain click on the
  // handle therefore toggles collapse; dragging (≥6px) still reorders, and a
  // post-drag click is suppressed by the sortable header's click-capture.
  // Always toggleable, matching cowork rows: an empty workspace expands to
  // its "No worktrees" empty-state row instead of an inert header.
  // The icon button stays a pure reorder control so its accessible name
  // matches its keyboard behavior (Enter/Space pick up dnd-kit's sortable).
  // Pointer clicks that never become a drag toggle collapse through the
  // shared header's row-background handler, which deliberately lets clicks on
  // this drag activator fall through; keyboard/AT users toggle via the
  // adjacent name button, which carries the collapse label and aria-expanded.
  const isPinnedSurface = surface === 'pin-top' || surface === 'pin-bottom';
  const dragHandleSlot = isPinnedSurface ? (
    // Pinned copies are never drag sources (no reorder button), but they keep
    // the icon→chevron disclosure swap: the pinned header still toggles
    // collapse (label button + background fallthrough), and hiding the
    // affordance while keeping the action lets clicks silently flip the
    // collapse state. Mirrors the cowork header's disableDrag branch.
    <WorkspaceIconSlot aria-hidden="true">
      <WorkspaceIconDisclosureSwap
        collapsed={collapsed}
        testIdSuffix={testIdSuffix}
      >
        {projectIcon}
      </WorkspaceIconDisclosureSwap>
    </WorkspaceIconSlot>
  ) : (
    <ControlButton
      type="button"
      presentation="project-header-drag-handle"
      aria-label={`Reorder ${displayName}`}
      data-workspace-drag-activator="icon"
      {...dragHandleAttributes}
      {...dragHandleListeners}
    >
      <WorkspaceIconDisclosureSwap
        collapsed={collapsed}
        testIdSuffix={testIdSuffix}
      >
        {projectIcon}
      </WorkspaceIconDisclosureSwap>
    </ControlButton>
  );

  return (
    <div
      ref={headerRef}
      className="w-full"
      tabIndex={-1}
      data-testid={`sidebar-project-header-${projectId}${testIdSuffix}`}
      onContextMenu={handleContextMenu}
    >
      <WorkspaceSectionHeader
        testIdSuffix={testIdSuffix}
        name={displayName}
        colorHex={color}
        workspaceType={isMultiRepo ? 'multi-repo' : 'single-repo'}
        temporary={temporary}
        worktreeCount={worktreeCount}
        pinnedToTop={workspacePinned}
        // Early access drops the project counters.
        countPresentation={hideCount ? 'hidden' : undefined}
        textScale="sidebar"
        repoCount={repoCount}
        repoNames={repoNames}
        collapsed={collapsed}
        canToggleCollapse
        warning={hasSettingsWarning ? 'settings-warning' : null}
        disableDrag={disableDrag}
        showCollapseChevron={false}
        inlineCollapseChevron
        addDisabled={createWorktreeDisabled}
        addDisabledTitle={
          createWorktreeDisabled ? 'Add repos first' : undefined
        }
        onToggleCollapse={handleToggleCollapsed}
        onAdd={handleCreateWorktree}
        primaryButtonDataAttrs={{
          'data-workspace-drag-activator': 'label',
        }}
        deferHoverActions
        onSettings={onOpenSettings ? handleOpenSettings : undefined}
        onOptions={handleOptions}
        optionsButtonDataAttrs={{
          'data-testid': `workspace-project-options-button${testIdSuffix}`,
        }}
        dragHandleSlot={dragHandleSlot}
      />
      {contextMenu && headerRef.current?.ownerDocument.body && (
        <>
          <MenuPointAnchor
            ref={contextMenuAnchorRef}
            x={contextMenu.x}
            y={contextMenu.y}
            ownerDocument={headerRef.current.ownerDocument}
          />
          <Menu
            open
            onOpenChange={(open): void => {
              if (!open) closeContextMenu();
            }}
            anchorRef={contextMenuAnchorRef}
            returnFocusRef={headerRef}
            placement="bottom-left"
            motion="none"
            className="w-max min-w-40 max-w-[calc(100vw-1rem)]"
            aria-label="Project actions"
            data-testid={`workspace-session-context-menu${testIdSuffix}`}
            onContextMenu={(event): void => event.preventDefault()}
          >
            {/* The right-click menu carries the workspace's actions —
                  the same ones the header's hover controls expose. */}
            <SidebarPinMenuItem
              testId="workspace-toggle-pin-menu-item"
              pinned={workspacePinned}
              onToggle={(pinned): void => {
                closeContextMenu();
                void setWorkspacePinned(projectId, pinned);
              }}
            />
            <MenuItem
              data-testid="workspace-new-task-menu-item"
              disabled={createWorktreeDisabled}
              title={createWorktreeDisabled ? 'Add repos first' : undefined}
              onClick={(): void => {
                if (createWorktreeDisabled) {
                  return;
                }
                closeContextMenu();
                handleCreateWorktree();
              }}
            >
              <MenuItemIcon>
                <AssignmentAddIcon />
              </MenuItemIcon>
              <span className="truncate">New task</span>
            </MenuItem>
            {onOpenSettings !== undefined && (
              <MenuItem
                data-testid="workspace-settings-menu-item"
                onClick={(): void => {
                  closeContextMenu();
                  handleOpenSettings();
                }}
              >
                <MenuItemIcon>
                  <SettingsIcon />
                </MenuItemIcon>
                <span className="truncate">Project settings</span>
              </MenuItem>
            )}
            <MenuItem
              data-testid="workspace-import-session-menu-item"
              onClick={(): void => {
                useCloudConnectGateStore.getState().requestConnect({}, () => {
                  openImportSessionModal(projectId);
                });
              }}
            >
              <MenuItemIcon>
                <DownloadIcon />
              </MenuItemIcon>
              <span className="truncate">Import session…</span>
            </MenuItem>
            <SidebarSortMenuItems
              mode={workspaceItemSortMode}
              testIdPrefix="workspace-item-sort"
              label="Sort tasks by"
              onSelect={(mode): void => {
                closeContextMenu();
                void setWorkspaceItemSortMode(projectId, mode);
              }}
            />
          </Menu>
        </>
      )}
    </div>
  );
});
