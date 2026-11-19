/**
 * AuxPanelWindow — the React host for ONE pulled-out panel window (Phase 8,
 * doc 05 §8 Approach A / doc 13 spike patterns).
 *
 * Everything renders from the MAIN React root: a `createPortal` targets a
 * container that was created in the OPENER realm (`document.createElement`,
 * the doc 13 cross-realm rule) and then adopted into the child
 * `about:blank` document's body. The child document runs no scripts of its
 * own — all React/event code executes in the opener; the aux grid is just
 * another `PanelGridHost` bound to the record's aux layout key, so further
 * split/stack inside the window reuses the exact same engine + store ops.
 *
 * DOM/window lifecycle owned here (see `panelWindowsStore` for the layout
 * side):
 * - open-time setup: window registry registration, stylesheet + `<html>`
 *   attribute mirroring, a `script-src 'none'` CSP meta (defense in depth:
 *   the child document itself must never execute script; opener-realm
 *   listeners are unaffected), document title, and the portal container;
 * - close detection: `pagehide` on the child window plus a 500ms
 *   `childWindow.closed` poll as the backstop (the spike's close-poll —
 *   `pagehide` alone is not guaranteed to fire for every OS teardown
 *   order). Both funnel into `handleChildWindowClosed`, which runs
 *   merge-back semantics;
 * - unmount cleanup: dispose the registry/mirror registrations, remove the
 *   container, and close the child window (a no-op when the OS already
 *   closed it).
 */
import { Surface } from '@canopy/ui-shared/components';
import { useChatTabRename } from '@/components/chat/ChatTabRenameDialog';
import { useTerminalRename } from '@canopy/ui-app/terminal-core';
import { acquirePanelContentElement } from '@/components/panels/PanelContentRoot';
import {
  PanelTabContextMenu,
  type PanelTabContextMenuTarget,
} from '@/components/panels/PanelTabContextMenu';
import {
  handleAuxPanelFindShortcut,
  handleAuxPanelNewTabShortcut,
} from '@/lib/auxPanelShortcuts';
import { brandText } from '@/lib/brand';
import { localPlatform } from '@/lib/local-platform';
import { usesNativeWindowFrame } from '@canopy/desktop-shared/platform-capabilities';
import { copyTextToClipboard } from '@/lib/clipboard';
import { formatFileReferencePath } from '@/lib/file-reference-paths';
import { useBusyChatCanCloseTab } from '@/lib/panels/busy-chat-panels';
import { chatReadStateServices } from '@/lib/panels/chat-read-state';
import {
  closePanelGroup,
  closePanelTab,
  closePanelTabs,
} from '@/lib/panels/chat-panel-sync';
import {
  mirrorHtmlAttributesInto,
  mirrorStylesheetsInto,
} from '@/lib/panels/child-window-styles';
import { focusPanelGroupElement } from '@/lib/panels/panel-focus';
import {
  auxPanelHostState,
  PanelHostContext,
  type PanelHostState,
} from '@/lib/panels/panel-host-context';
import {
  PanelWorktreeContext,
  worktreeSelectionFromPanelOwnerKey,
} from '@/lib/panels/panel-worktree-context';
import { createAuxWindowBoundsWatcher } from '@/lib/panels/persistence-bridge';
import { renderPanelContent } from '@/lib/panels/registry';
import { splitGroupMovingActiveTab } from '@/lib/panels/split-active-tab';
import {
  renderPanelTabAccessibleStatus,
  renderPanelTabAttention,
  renderPanelCollapsedTabIcon,
  renderPanelTabIcon,
  renderPanelTabLabel,
  renderPanelTabTrailing,
  usePanelTabTitleResolvers,
} from '@/lib/panels/tab-display';
import {
  requestRevealedTerminalPanelSpawn,
  requestSelectedTerminalPanelFocus,
} from '@/lib/panels/terminal-panel-activation';
import { useWorkspaceIsReadOnly } from '@/lib/workspace-access';
import { useScopeCapabilities } from '@/hooks/useScopeCapabilities';
import { useChatStore } from '@/stores/chatStore';
import { useNavigationMode } from '@/stores/navigationModeStore';
import { isLocalFileActionAvailable } from '@/lib/file-reveal';
import {
  getPanelLayoutViewModel,
  readPanelGroupRevealState,
  usePanelGridController,
  usePanelLayoutStore,
  usePanelLayoutViewModel,
} from '@/stores/panelLayoutStore';
import {
  getAuxWindowSourceLabel,
  usePanelWindowsStore,
  type PanelAuxWindowRecord,
} from '@/stores/panelWindowsStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { Tooltip } from '@canopy/ui-shared';
import { Button } from '@canopy/ui-shared/components';
import { PanelGridHost } from '@canopy/ui-shared/components/panels';
import { RevertIcon as AppCatalogRevertIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  DisposableStore,
  registerWindow,
  toDisposable,
  type PanelIntentCallbacks,
} from '@canopy/ui-shared/panels';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import { createPortal } from 'react-dom';

export interface AuxPanelWindowProps {
  record: PanelAuxWindowRecord;
  /**
   * Page-shell state of the main grid. The aux window presents it through
   * `auxPanelHostState`, so the main page's `visible` never hides it.
   */
  hostState: PanelHostState;
}

const CLOSE_POLL_INTERVAL_MS = 500;

/**
 * Left inset of the aux window's custom top bar: 78 logical px clear of the
 * macOS traffic lights (`trafficLightPosition: {x:15,y:12}` in
 * `main/panels/aux-window-service.ts`). The lights never move, so the inset
 * is kept in physical units by dividing by the interface-scale zoom.
 */
const AUX_WINDOW_TRAFFIC_LIGHT_INSET_CSS = 'calc(78px / var(--ui-zoom, 1))';

/**
 * Marks an element as a native window drag region (or carves an interactive
 * child back out of one). Applied as INLINE styles via callback refs because
 * the aux top bar lives in the child `about:blank` document: inline styles
 * need no stylesheet at all, so the drag region works even before the
 * mirrored stylesheets (see `mirrorStylesheetsInto`) finish resolving —
 * the child window is `titleBarStyle: 'hidden'`, so this row IS its title
 * bar.
 */
function setAppRegion(
  element: HTMLElement | null,
  region: 'drag' | 'no-drag',
): void {
  element?.style.setProperty('-webkit-app-region', region);
}

export function AuxPanelWindow({
  record,
  hostState,
}: AuxPanelWindowProps): JSX.Element | null {
  const nativeWindowFrame = usesNativeWindowFrame(localPlatform());
  const {
    auxWindowId,
    worktreeKey,
    layoutKey,
    sourceGroupId,
    childWindow,
    focusOnOpen,
  } = record;

  const [container, setContainer] = useState<HTMLElement | null>(null);
  // Early access shows the `fill` tabs here too, matching the main window.
  const tabStyle = 'fill';
  // Work navigation leads file tab menus with reveal, as in the main window.
  const fileActionsFirst = useNavigationMode() === 'work';
  const [tabContextMenu, setTabContextMenu] =
    useState<PanelTabContextMenuTarget | null>(null);
  const viewModel = usePanelLayoutViewModel(layoutKey);
  const controller = usePanelGridController(layoutKey);
  const didFocusContentRef = useRef(false);
  const ownerSelection = useMemo(
    () => worktreeSelectionFromPanelOwnerKey(worktreeKey),
    [worktreeKey],
  );
  // Busy chats (active turn or live delegates) keep their panel: no tab ×,
  // and the context menu's Close is disabled.
  const canCloseTab = useBusyChatCanCloseTab(
    ownerSelection?.projectId ?? null,
    ownerSelection?.worktreeId ?? null,
  );
  const openFileInFileManager = useCallback(
    (absolutePath: string): void => {
      if (!ownerSelection) return;
      void window.api.showInFinder({
        absolutePath,
        projectId: ownerSelection.projectId,
        worktreeId: ownerSelection.worktreeId,
      });
    },
    [ownerSelection],
  );
  const copyFilePath = useCallback((absolutePath: string): void => {
    void copyTextToClipboard(absolutePath);
  }, []);
  const copyRelativeFilePath = useCallback(
    (absolutePath: string): void => {
      if (!ownerSelection) return;
      void (async (): Promise<void> => {
        let worktreePath: string | undefined;
        try {
          worktreePath = await window.api.getWorktreePath(ownerSelection);
        } catch {
          worktreePath = undefined;
        }
        await copyTextToClipboard(
          formatFileReferencePath(absolutePath, worktreePath),
        );
      })();
    },
    [ownerSelection],
  );
  const resolveFileTabPath = useCallback(
    (fileTabId: string): string | undefined => {
      const worktreeChat = useChatStore.getState().worktreeChats[worktreeKey];
      const tab = worktreeChat?.tabs.find(
        (candidate) => candidate.id === fileTabId,
      );
      return tab?.kind === 'file' ? tab.filePath : undefined;
    },
    [worktreeKey],
  );

  // Source indicator for the top bar: which worktree/branch these panels
  // came from (project name + worktree label/branch, live from the projects
  // store; raw ids when the worktree is unknown).
  const sourceLabel = useProjectsStore((s) =>
    getAuxWindowSourceLabel(worktreeKey, s.projects),
  );

  useEffect(() => {
    const notifyClosed = (): void => {
      usePanelWindowsStore.getState().handleChildWindowClosed(auxWindowId);
    };

    if (childWindow.closed) {
      notifyClosed();
      return undefined;
    }

    const childDocument = childWindow.document;
    const disposables = new DisposableStore();

    // Registry first: window-aware helpers (ResizeObserver realms, menus,
    // scheduling) must resolve this window as soon as anything renders into
    // it. Dispose on unmount — the registry attaches no unload listeners of
    // its own (Phase 7 contract).
    disposables.add(registerWindow(childWindow));

    // Defense in depth: the child document runs NO scripts of its own (all
    // code executes in the opener realm, and opener-attached DOM listeners
    // are not governed by the child's CSP), so forbid script execution in
    // the child document entirely — VS Code's aux-window posture.
    const csp = childDocument.createElement('meta');
    csp.httpEquiv = 'Content-Security-Policy';
    csp.content = "script-src 'none'";
    childDocument.head.appendChild(csp);

    disposables.add(mirrorStylesheetsInto(childDocument));
    disposables.add(mirrorHtmlAttributesInto(childDocument));

    childDocument.title = `${brandText.appName} Panels`;

    // The portal container MUST be created in the opener realm and adopted
    // (doc 13: adopted nodes keep opener-realm prototypes; child-realm nodes
    // break `instanceof` checks in React/libraries).
    const root = document.createElement('div');
    childDocument.body.setAttribute('data-app-selection', '');
    root.style.position = 'fixed';
    root.style.inset = '0';
    root.style.display = 'flex';
    root.style.flexDirection = 'column';
    childDocument.body.appendChild(root);
    setContainer(root);
    disposables.add(
      toDisposable(() => {
        setContainer(null);
        root.remove();
      }),
    );

    // Focus the fresh window (doc 13 open item: only effective in a SHOWN
    // window; headless/E2E windows are never OS-focused). Gated on
    // `focusOnOpen`: a user-initiated pop-out takes focus, a relaunch
    // restore must not steal startup focus from the main window.
    if (focusOnOpen) {
      try {
        childWindow.focus();
      } catch {
        // A closing window can throw on cross-window access; close detection
        // below handles it.
      }
    }

    // Bounds watch (persistence): moving/resizing the aux OS window commits
    // nothing in the layout store, so a bounds-only change would otherwise
    // persist only with the NEXT committed layout mutation. The watcher
    // piggybacks on the close-poll tick below (catches window moves) plus
    // the child's `resize` event (prompt size changes) and dirties the
    // owning worktree's debounced save; no extra timers are introduced.
    const boundsWatcher = createAuxWindowBoundsWatcher(
      childWindow,
      worktreeKey,
    );
    const checkBounds = (): void => {
      boundsWatcher.check();
    };
    childWindow.addEventListener('resize', checkBounds);

    // Close detection: `pagehide` fires when the child document unloads
    // (OS close button, Cmd+W); the `closed` poll is the backstop for
    // teardown orders where the event is not delivered to opener-attached
    // listeners. `handleChildWindowClosed` is idempotent.
    childWindow.addEventListener('pagehide', notifyClosed);
    const pollHandle = window.setInterval(() => {
      if (childWindow.closed) {
        notifyClosed();
        return;
      }
      boundsWatcher.check();
    }, CLOSE_POLL_INTERVAL_MS);

    return (): void => {
      window.clearInterval(pollHandle);
      try {
        childWindow.removeEventListener('pagehide', notifyClosed);
        childWindow.removeEventListener('resize', checkBounds);
      } catch {
        // Already closed; nothing to remove.
      }
      disposables.dispose();
      if (!childWindow.closed) {
        childWindow.close();
      }
    };
  }, [auxWindowId, childWindow, focusOnOpen, worktreeKey]);

  // The child document belongs to a separate Window, so the main renderer's
  // global keydown listener cannot see its events. Handle new-tab locally and
  // bind dispatch to this auxiliary layout rather than the owner's main grid.
  useEffect(() => {
    if (ownerSelection === null || childWindow.closed) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      handleAuxPanelNewTabShortcut({
        event,
        projectId: ownerSelection.projectId,
        worktreeId: ownerSelection.worktreeId,
        layoutKey,
        createChatTab: (): void => {
          useChatStore.getState().createTab(ownerSelection);
        },
      });
    };
    childWindow.addEventListener('keydown', handleKeyDown);
    return (): void => {
      try {
        childWindow.removeEventListener('keydown', handleKeyDown);
      } catch {
        // The OS window closed before React cleanup.
      }
    };
  }, [childWindow, layoutKey, ownerSelection]);

  // Cmd/Ctrl+F in this window opens the floating find bar for the focused
  // chat or file panel here (CAN-3048); the bar portals into this document.
  useEffect(() => {
    if (childWindow.closed) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      handleAuxPanelFindShortcut({
        event,
        childDocument: childWindow.document,
        readActiveGroupId: () =>
          getPanelLayoutViewModel(layoutKey)?.activeGroupId ?? null,
      });
    };
    childWindow.addEventListener('keydown', handleKeyDown);
    return (): void => {
      try {
        childWindow.removeEventListener('keydown', handleKeyDown);
      } catch {
        // The OS window closed before React cleanup.
      }
    };
  }, [childWindow, layoutKey]);

  // Focus sequencing (Phase 9, doc 12 §2): once the aux grid has actually
  // rendered into the child document (portal committed — effects run after
  // the DOM mutation), move DOM focus to the active group's roving tab so
  // keyboard/screen-reader context lands inside the new window. Runs once
  // per mount, only for user-initiated pop-outs (see `focusOnOpen`). DOM
  // focus works headlessly too (activeElement updates without OS focus).
  useEffect(() => {
    if (
      !focusOnOpen ||
      didFocusContentRef.current ||
      container === null ||
      viewModel === null ||
      childWindow.closed
    ) {
      return;
    }
    didFocusContentRef.current = true;
    const activeGroupId = viewModel.activeGroupId;
    if (
      activeGroupId === null ||
      !focusPanelGroupElement(childWindow.document, activeGroupId)
    ) {
      // Fallback: the merge-back button is always present in the aux chrome.
      try {
        const mergeBack = childWindow.document.querySelector(
          '[data-testid="panel-aux-window-merge-back"]',
        );
        if (mergeBack instanceof HTMLElement) {
          mergeBack.focus();
        }
      } catch {
        // Closing window; close detection handles it.
      }
    }
  }, [focusOnOpen, container, viewModel, childWindow]);

  // Intent callbacks bound to the AUX layout key — the same store API the
  // main grid dispatches through. `onPopOutGroup` is intentionally absent:
  // pop-out from inside an aux window is out of Phase 8 scope, so the
  // chrome's pop-out affordance never renders here. Add-tab is also omitted
  // (the add menu includes window-bound kinds like `browser`, which must not
  // mount in a child document).
  const callbacks = useMemo<PanelIntentCallbacks>(() => {
    const store = usePanelLayoutStore.getState;
    // A popped-out window routes none of its gestures through the shared
    // surface's `onSelectPanel`/`onExpandGroup` host seams, so every reveal
    // gesture wires the auto-start explicitly. A no-op without an owner
    // selection, and for non-terminal or already-bound tabs.
    const revealTerminal = (groupId: string, panelId?: string): void => {
      if (ownerSelection === null) return;
      requestRevealedTerminalPanelSpawn(
        ownerSelection.projectId,
        ownerSelection.worktreeId,
        layoutKey,
        groupId,
        panelId,
      );
    };
    return {
      onSelectTab: (groupId, panelId): void => {
        store().selectTab(layoutKey, groupId, panelId);
        requestSelectedTerminalPanelFocus(
          layoutKey,
          groupId,
          panelId,
          childWindow.document,
        );
        revealTerminal(groupId, panelId);
      },
      onCloseTab: (groupId, panelId): void => {
        closePanelTab(layoutKey, groupId, panelId);
      },
      onCloseGroup: (groupId): void => {
        // Busy chats (active turn or live delegates) keep their group open.
        closePanelGroup(layoutKey, groupId);
      },
      onSplitGroup: (groupId, direction): void => {
        splitGroupMovingActiveTab(layoutKey, groupId, direction);
      },
      onMaximizeGroup: (groupId, maximized): void => {
        // Maximizing a COLLAPSED group expands it in the same transaction,
        // which reveals it exactly as the expand control does. Sampled
        // before the mutation, through the same shared helper the main
        // grid surface uses, so the two hosts cannot drift.
        const before = readPanelGroupRevealState(layoutKey, groupId);
        store().maximizeGroup(layoutKey, groupId, maximized);
        if (maximized && before.collapsed) {
          revealTerminal(groupId, before.activePanelId);
        }
      },
      onCollapseGroup: (groupId, collapsed, options): void => {
        if (collapsed) {
          store().collapseGroup(layoutKey, groupId);
          return;
        }
        const before = readPanelGroupRevealState(layoutKey, groupId);
        store().expandGroup(layoutKey, groupId);
        // A tab drop expands through this callback too, but the drop — not
        // the expand — is the gesture, and the dropped tab becomes active.
        if (before.collapsed && options?.gesture !== 'move') {
          revealTerminal(groupId, before.activePanelId);
        }
      },
      onExpandGroupToTab: (groupId, panelId): void => {
        store().expandGroup(layoutKey, groupId, { activatePanelId: panelId });
        requestSelectedTerminalPanelFocus(
          layoutKey,
          groupId,
          panelId,
          childWindow.document,
        );
        revealTerminal(groupId, panelId);
      },
      onFocusGroup: (groupId): void => {
        store().focusGroup(layoutKey, groupId);
      },
      onMovePanel: (panelId, targetGroupId, edge, targetIndex): void => {
        store().movePanel(layoutKey, panelId, targetGroupId, edge, targetIndex);
      },
      onReorderTab: (groupId, panelId, toIndex): void => {
        store().reorderTab(layoutKey, groupId, panelId, toIndex);
      },
    };
  }, [childWindow, layoutKey, ownerSelection]);

  // Content adoption (no-remount handoff): the aux grid's groups adopt the
  // SAME per-panel containers the main grid used before the pull-out —
  // containers are keyed by the OWNING worktree, so the DOM node created in
  // the main window is re-parented into this child document (cross-document
  // appendChild adopts it) and merge-back re-parents it home again. Content
  // itself is rendered once by WorktreePart's <PanelContentRoot>, which
  // covers every open aux window's layout.
  const getPanelContentElement = useCallback(
    (panelId: string): HTMLElement | null =>
      acquirePanelContentElement(worktreeKey, panelId),
    [worktreeKey],
  );

  const handleLayoutGrid = useCallback(
    (width: number, height: number): void => {
      usePanelLayoutStore.getState().layoutContainer(layoutKey, width, height);
    },
    [layoutKey],
  );

  // Tab right-click context menu, addressed by the aux layout key so its ops
  // mutate this window's grid. The menu portals into the CHILD document (see
  // ownerDocument below) so it opens in this window, not the main one.
  const handleTabContextMenu = useCallback(
    (
      groupId: string,
      panelId: string,
      clientX: number,
      clientY: number,
    ): void => {
      setTabContextMenu({ groupId, panelId, x: clientX, y: clientY });
    },
    [],
  );
  const handleCloseTabContextMenu = useCallback((): void => {
    setTabContextMenu(null);
  }, []);
  const handleFullScreen = useCallback(
    (groupId: string, panelId: string): void => {
      callbacks.onSelectTab(groupId, panelId);
      callbacks.onMaximizeGroup(groupId, true);
    },
    [callbacks],
  );
  const readOnly = useWorkspaceIsReadOnly();
  const chatReadState = useMemo(
    () =>
      ownerSelection
        ? chatReadStateServices(
            ownerSelection.projectId,
            ownerSelection.worktreeId,
          )
        : undefined,
    [ownerSelection],
  );
  const chatTabRename = useChatTabRename();
  const openChatTabRename = chatTabRename.open;
  const handleRenameChat = useCallback(
    (chatTabId: string, ownerDocument?: Document): void => {
      if (!ownerSelection) return;
      openChatTabRename({
        projectId: ownerSelection.projectId,
        worktreeId: ownerSelection.worktreeId,
        tabId: chatTabId,
        ...(ownerDocument ? { ownerDocument } : {}),
      });
    },
    [openChatTabRename, ownerSelection],
  );
  // Only offered with an owner selection, so the empty ids are never saved.
  const terminalRename = useTerminalRename(
    ownerSelection?.projectId ?? '',
    ownerSelection?.worktreeId ?? '',
  );
  const tabTitles = usePanelTabTitleResolvers();
  const terminalRenameAllowed =
    useScopeCapabilities({ projectId: ownerSelection?.projectId ?? '' })
      .terminalRename === true;

  if (container === null || viewModel === null || controller === null) {
    return null;
  }

  return createPortal(
    // The aux window is its own page: its grid never reads the main page's
    // `visible` (panel content gets the same derivation from
    // PanelContentRoot).
    <PanelHostContext.Provider value={auxPanelHostState(hostState)}>
      <Surface
        data-testid="panel-aux-window-root"
        data-window="aux"
        data-aux-window-id={auxWindowId}
        data-source-group-id={sourceGroupId}
        role="application"
        aria-label={`${brandText.appName} panels`}
        variant="app-pane"
        extent="parent"
        className="flex min-h-0 flex-1 flex-col"
      >
        {/* This row supplies window dragging and the traffic-light inset
            where the native frame is hidden. With a native frame it remains
            an ordinary source/merge header. App-region styles
            are inline via callback refs (see `setAppRegion`). */}
        <Surface
          as="header"
          variant="tinted-panel"
          boundary="bottom"
          extent="aux-toolbar"
          padding="titlebar-trailing"
          direction="row"
          gap="inline"
          ref={(el): void => {
            setAppRegion(el, nativeWindowFrame ? 'no-drag' : 'drag');
          }}
          data-testid="panel-aux-window-top-bar"
          className="shrink-0 items-center"
          // The traffic lights sit at a fixed on-screen position
          // (`trafficLightPosition: {x:15,y:12}`), so their 78px reservation
          // is divided by the interface-scale zoom (`--ui-zoom`, mirrored from
          // the opener's <html> inline style) instead of zooming with the bar.
          nativeLeadingInset={
            nativeWindowFrame ? 8 : AUX_WINDOW_TRAFFIC_LIGHT_INSET_CSS
          }
        >
          <div
            data-testid="panel-aux-window-source"
            className="min-w-0 flex-1 truncate text-xs fg-secondary"
            title={sourceLabel}
          >
            {sourceLabel}
          </div>
          {/* Tooltip mounted in THIS window's realm: the shared Tooltip
              portals into the trigger's ownerDocument, not the main window. */}
          <Tooltip label="Move back to main window">
            <Button
              size="compact"
              ref={(el): void => {
                setAppRegion(el, 'no-drag');
              }}
              data-testid="panel-aux-window-merge-back"
              aria-label="Move back to main window"
              onClick={(): void => {
                usePanelWindowsStore.getState().mergeBack(auxWindowId);
              }}
            >
              <AppCatalogRevertIcon size="sm" aria-hidden="true" />
              Move back
            </Button>
          </Tooltip>
        </Surface>
        <PanelWorktreeContext.Provider value={ownerSelection}>
          <PanelGridHost
            layout={viewModel}
            gridController={controller}
            callbacks={callbacks}
            renderPanelContent={renderPanelContent}
            getPanelContentElement={getPanelContentElement}
            renderTabIcon={renderPanelTabIcon}
            renderCollapsedTabIcon={renderPanelCollapsedTabIcon}
            renderTabLabel={renderPanelTabLabel}
            {...tabTitles}
            renderTabAccessibleStatus={renderPanelTabAccessibleStatus}
            renderTabAttention={renderPanelTabAttention}
            renderTabTrailing={renderPanelTabTrailing}
            canCloseTab={canCloseTab}
            tabStyle={tabStyle}
            onLayoutGrid={handleLayoutGrid}
            onTabContextMenu={handleTabContextMenu}
            windowLabel="aux"
            className="min-h-0 flex-1"
          />
        </PanelWorktreeContext.Provider>
        {tabContextMenu !== null && (
          <PanelTabContextMenu
            layoutKey={layoutKey}
            target={tabContextMenu}
            onClose={handleCloseTabContextMenu}
            onCloseTab={closePanelTab}
            onCloseTabs={closePanelTabs}
            canCloseTab={canCloseTab}
            onCopyFilePath={copyFilePath}
            onCopyRelativeFilePath={copyRelativeFilePath}
            onOpenFileInFileManager={
              !readOnly &&
              ownerSelection &&
              isLocalFileActionAvailable('showInFinder')
                ? openFileInFileManager
                : undefined
            }
            resolveFileTabPath={resolveFileTabPath}
            fileActionsFirst={fileActionsFirst}
            onFullScreen={handleFullScreen}
            onRenameChat={
              ownerSelection && !readOnly ? handleRenameChat : undefined
            }
            onRenameTerminal={
              ownerSelection && !readOnly && terminalRenameAllowed
                ? terminalRename.open
                : undefined
            }
            getChatReadState={chatReadState?.getChatReadState}
            onSetChatUnread={chatReadState?.onSetChatUnread}
            ownerDocument={childWindow.document}
            tabStyle={tabStyle}
          />
        )}
        {chatTabRename.dialog}
        {terminalRename.dialog}
      </Surface>
    </PanelHostContext.Provider>,
    container,
  );
}
