import { useCallback, useRef, useState, type JSX } from 'react';
import {
  DownloadIcon,
  MoreHorizontalIcon,
  PlusMediumIcon,
  SettingsIcon,
  ShareIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  MenuItem,
  MenuItemIcon,
  Menu,
  RailIconButton,
  SidebarFadePresence,
  SidebarSectionToggle,
} from '@canopy/ui-shared/components';
import { CHAT_UNIT_LABEL_PLURAL } from '@canopy/protocol';
import { isDefaultCoworkWorkspaceName } from '@/lib/defaultCoworkWorkspaceName';
import { type CoworkSidebarItem } from '@canopy/desktop-shared/types';
import { useProjectsStore } from '@/stores/projectsStore';
import { useSidebarStore } from '@/stores/sidebarStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useCloudConnectGateStore } from '@/stores/cloudConnectGateStore';
import { openImportSessionModal } from '@/stores/importSessionModalStore';
import { openNewCoworkTaskFromSidebar } from '@/lib/openNewCoworkTaskFromSidebar';
import { CHATS_SECTION_VISIBLE_ENTRIES } from '@canopy/ui-app';
import {
  CHATS_HEADER_SELECTOR,
  CHATS_HEADER_STUCK_ATTR,
  ChatsSelectedPinSeat,
  revealOccludedChats,
} from '@canopy/ui-app/sidebar';
import { SidebarCoworkWorkspaceRow } from './SidebarCoworkWorkspaceRow';
import { useSidebarScopingContext } from './useSidebarScopingContext';
import { SidebarSortMenuItems } from './SidebarSortMenuItems';
import { useOrgDefaultChatsWorkspace } from './useOrgDefaultChatsWorkspace';
import { useSelectedCoworkEntryId } from './useSelectedCoworkEntryId';

/**
 * How many project-less chats the section shows before "Show all". Chats sits
 * ABOVE the project list, so it stays short by default rather than pushing
 * every project below the fold.
 *
 * Re-exported from the shared surface rather than declared again: the shared
 * Chats section and this one must cap at the same number, and two constants
 * with a comment asserting they match is how that stops being true.
 */
export { CHATS_SECTION_VISIBLE_ENTRIES };

/**
 * The top-level Chats section (CAN-2363): the default Cowork workspace's Work
 * Entries, rendered flat above the Projects list.
 *
 * The default workspace is the catch-all for chats that belong to no project,
 * so it is not a project row — it has no workspace header here, and the
 * affordances that lived on that header (settings, share, import) are on this
 * section header instead. It renders inside the sidebar's masked scrolling
 * navigation block, so it fades correctly as it scrolls beneath the sticky
 * Projects controls.
 */
export function SidebarChatsSection(): JSX.Element | null {
  const scopingContext = useSidebarScopingContext();
  const chatsWorkspaceState = useOrgDefaultChatsWorkspace(scopingContext);
  const setWorkspaceItemSortMode = useProjectsStore(
    (state) => state.setWorkspaceItemSortMode,
  );
  const collapsed = useSidebarStore((s) => s.chatsSectionCollapsed);
  const setCollapsed = useSidebarStore((s) => s.setChatsSectionCollapsed);
  const openWorkspaceSettingsModal = useNavigationStore(
    (s) => s.openWorkspaceSettingsModal,
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  // Mirrors the mark the rail's scroll sync publishes on the header. The sync
  // owns the measurement — this only reflects it, so the label the assistive
  // technology announces and the chevron the eye reads come from the one
  // source rather than a second implementation of the same geometry.
  const [stuck, setStuck] = useState(false);
  const stuckObserverRef = useRef<MutationObserver | null>(null);
  // A callback ref, not an effect: this component returns null until the
  // catch-all workspace exists, and `projectsStore` starts empty with
  // `isLoading: false` — a silent refresh can introduce the workspace without
  // the component ever unmounting. An effect keyed on mount would stay
  // attached to nothing through exactly that transition, and because the click
  // path measures live the only symptom would be assistive technology hearing
  // the stale disclosure promise.
  const attachHeader = useCallback((header: HTMLDivElement | null): void => {
    stuckObserverRef.current?.disconnect();
    stuckObserverRef.current = null;
    if (!header) {
      setStuck(false);
      return;
    }
    const read = (): void => {
      setStuck(header.getAttribute(CHATS_HEADER_STUCK_ATTR) === 'true');
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(header, {
      attributes: true,
      attributeFilter: [CHATS_HEADER_STUCK_ATTR],
    });
    stuckObserverRef.current = observer;
  }, []);

  // Resolved from every workspace, never the visible partition: the workspace
  // filter must not be able to take the catch-all bucket away. Each scoping
  // context has its own catch-all: an organization's Chats workspace in org
  // scope, Personal's everywhere else.
  const defaultCowork: CoworkSidebarItem | null =
    chatsWorkspaceState.workspace ?? null;
  // A collapse keeps the selected chat, as a collapsed project keeps its
  // selected row; with nothing selected here it hides every row.
  const hasSelectedChat = useSelectedCoworkEntryId(defaultCowork?.id) !== null;
  // Rendered even while empty: the header carries the "+" that creates the
  // first chat, which on a fresh install is the only entry point to this
  // bucket besides the New task page.
  if (defaultCowork === null) {
    return null;
  }

  // The section is named by the workspace it renders, not by the shared
  // constant. The catch-all is an ordinary cowork project and may be renamed
  // like any other (see defaultCoworkWorkspaceIdForContext); pinning the header to
  // the constant meant one rename put this section back out of step with the
  // New task composer, the chat switcher and App Advisor — the exact
  // disagreement the stored-name migration exists to remove.
  const sectionLabel = isDefaultCoworkWorkspaceName(defaultCowork.name)
    ? CHAT_UNIT_LABEL_PLURAL
    : defaultCowork.name;

  return (
    <>
      <div
        ref={attachHeader}
        className="group/section group/chats group/sidebar-item sticky z-40 flex min-w-0 items-center gap-1 px-1 pt-3"
        // `top` is seated by AppSidebar's layout pass, directly beneath the
        // pinned More row; this is the pre-measurement fallback.
        style={{ top: '1px' }}
        data-sidebar-chats-header=""
        data-testid="sidebar-section-chats"
      >
        <SidebarSectionToggle
          section="chats"
          label={sectionLabel}
          open={!collapsed}
          testId="sidebar-section-chats-toggle"
          chevronTestId="sidebar-chats-chevron"
          // Stuck, this control is not a disclosure: activating it returns to
          // the rows rather than changing whether they are shown, so the
          // toggle drops the disclosure role and says what it actually does
          // instead.
          stuck={stuck}
          ariaLabel={stuck ? `Back to ${sectionLabel}` : undefined}
          onClick={(event): void => {
            // While the header is stuck over its own occluded rows it is the
            // way back to them, not a collapse — the inverse of the Projects
            // stand-in at the foot of the rail.
            const header = event.currentTarget.closest<HTMLElement>(
              CHATS_HEADER_SELECTOR,
            );
            if (header !== null && revealOccludedChats(header)) return;
            setCollapsed(!collapsed);
          }}
        />
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <RailIconButton
            icon={SettingsIcon}
            onClick={(): void =>
              openWorkspaceSettingsModal({ workspaceId: defaultCowork.id })
            }
            aria-label={`${sectionLabel} settings`}
            title="Settings"
            data-testid="sidebar-section-chats-settings"
            hoverSurface
            revealOnItemHover
            disabled={chatsWorkspaceState.pending}
          />
          <RailIconButton
            ref={menuButtonRef}
            icon={MoreHorizontalIcon}
            aria-label={`More actions for ${sectionLabel}`}
            title="More actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            data-testid="sidebar-section-chats-more"
            disabled={chatsWorkspaceState.pending}
            hoverSurface
            revealOnItemHover
            onClick={(): void => {
              if (!chatsWorkspaceState.pending) {
                setMenuOpen((open) => !open);
              }
            }}
          />
          <RailIconButton
            icon={PlusMediumIcon}
            onClick={(): void => {
              // The same path as a cowork row's "+": create the Work Entry and
              // open its grid rather than routing through the New task page.
              openNewCoworkTaskFromSidebar(defaultCowork.id, {
                pending: chatsWorkspaceState.pending,
              });
            }}
            aria-label="New chat"
            title="New chat"
            data-testid="sidebar-section-chats-new-chat"
            hoverSurface
            revealOnItemHover
          />
          <Menu
            open={!chatsWorkspaceState.pending && menuOpen}
            onOpenChange={setMenuOpen}
            anchorRef={menuButtonRef}
            placement="bottom-left"
            className="w-max min-w-40 max-w-[calc(100vw-1rem)]"
            aria-label={`${sectionLabel} actions`}
            data-testid="workspace-session-context-menu"
          >
            <MenuItem
              data-testid="workspace-share-template-menu-item"
              onClick={(): void => {
                setMenuOpen(false);
                openWorkspaceSettingsModal({
                  workspaceId: defaultCowork.id,
                  initialTab: 'share',
                });
              }}
            >
              <MenuItemIcon>
                <ShareIcon />
              </MenuItemIcon>
              <span className="truncate">Share template</span>
            </MenuItem>
            <MenuItem
              data-testid="workspace-import-session-menu-item"
              onClick={(): void => {
                setMenuOpen(false);
                useCloudConnectGateStore.getState().requestConnect({}, () => {
                  openImportSessionModal(defaultCowork.id);
                });
              }}
            >
              <MenuItemIcon>
                <DownloadIcon />
              </MenuItemIcon>
              <span className="truncate">Import session…</span>
            </MenuItem>
            <SidebarSortMenuItems
              mode={defaultCowork.itemSortMode}
              testIdPrefix="workspace-item-sort"
              label={`Sort ${sectionLabel.toLowerCase()} by`}
              onSelect={(mode): void => {
                setMenuOpen(false);
                void setWorkspaceItemSortMode(defaultCowork.id, mode);
              }}
            />
          </Menu>
        </div>
      </div>

      {/* The selected chat's pinned copy seats here while the rail scrolls
          it away (see sticky-selected-item.ts). */}
      <ChatsSelectedPinSeat />

      <SidebarFadePresence
        open={!collapsed || hasSelectedChat}
        className="sidebar-chats-scroll-mask pb-1"
        data-sidebar-chats-mask=""
        data-testid="sidebar-section-chats-content"
      >
        <SidebarCoworkWorkspaceRow
          item={defaultCowork}
          hideWorkspaceHeader
          sectionCollapsed={collapsed}
          disableDrag
          selectedPinSeat="chats"
          maxEntries={CHATS_SECTION_VISIBLE_ENTRIES}
          excludeFromWorkspaceList
          isTourAnchor
          // An organization's empty Chats reads like its empty Projects list
          // (CAN-3550).
          listsNoneFoundWhenEmpty={scopingContext?.kind === 'organization'}
        />
      </SidebarFadePresence>
    </>
  );
}
