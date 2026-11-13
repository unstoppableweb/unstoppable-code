import { saveCurrentLayoutAsDefault } from '@/lib/panels/default-layout-save';
import { useScopeCapabilities } from '@/hooks/useScopeCapabilities';
import {
  DEFAULT_EXTRAS_GROUP_ID,
  DEFAULT_TERMINAL_GROUP_ID,
} from '@/lib/panels/panel-group-ids';
import { panelSurfaceForWorktreeKey } from '@/lib/panels/panel-surface';
import {
  ensureTerminalPanelVisible,
  requestRevealedTerminalPanelSpawn,
} from '@/lib/panels/terminal-panel-activation';
import { setWorkspacePanelLayoutMode } from '@/lib/panels/workspace-layout-mode-actions';
import {
  emitPreferencesUpdated,
  subscribePreferencesUpdated,
} from '@/lib/preferences-events';
import { requestTerminalSpawn } from '@/lib/terminalSpawnRequests';
import { applyChatWidth } from '@/lib/theme';
import { useGitHubStore } from '@/stores/githubStore';
import {
  makeWorktreePanelKey,
  usePanelLayoutStore,
} from '@/stores/panelLayoutStore';
import { useTerminalDrawerAttentionStore } from '@/stores/terminalDrawerAttentionStore';
import { useWorkspaceLayoutModeStore } from '@/stores/workspaceLayoutModeStore';
import {
  FloatingMenu,
  TitlebarIconButton,
  WorkspaceLayoutPicker,
} from '@canopy/ui-shared';
import {
  BottombarHiddenBottomWideIcon,
  MoreHorizontalIcon,
  SidebarHiddenRightWideIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
} from 'react';
import { useShallow } from 'zustand/react/shallow';

interface WorkspaceLayoutControlsProps {
  projectId: string;
  worktreeId: string;
}

export function WorkspaceLayoutControls({
  projectId,
  worktreeId,
}: WorkspaceLayoutControlsProps): JSX.Element {
  const worktreeKey = makeWorktreePanelKey(projectId, worktreeId);
  const modeEntry = useWorkspaceLayoutModeStore(
    useShallow((state) => state.entries[worktreeKey]),
  );
  const mode = modeEntry?.mode ?? 'advanced';
  const layout = usePanelLayoutStore(
    useShallow((state) => state.layouts[worktreeKey]),
  );
  // The drawer's toggle starts a terminal, which a scope without one hides.
  const { terminalPty } = useScopeCapabilities({ projectId });
  const [menuOpen, setMenuOpen] = useState(false);
  const [conversionBusy, setConversionBusy] = useState(false);
  const [chatWidth, setChatWidth] = useState<'default' | 'full'>('default');
  const [widthBusy, setWidthBusy] = useState(false);
  useEffect(() => {
    let active = true;
    let version = 0;
    const refresh = (): void => {
      const request = ++version;
      void window.api
        .loadPreferences()
        .then((prefs) => {
          if (active && request === version)
            setChatWidth(prefs.chatWidth === 'full' ? 'full' : 'default');
        })
        .catch(() => {
          /* Keep the last confirmed preference on read failure. */
        });
    };
    refresh();
    const unsubscribe = window.api.onPreferencesSynced(refresh);
    const unsubscribeLocal = subscribePreferencesUpdated(refresh);
    return (): void => {
      active = false;
      unsubscribe();
      unsubscribeLocal();
    };
  }, []);
  const selectChatWidth = async (next: 'default' | 'full'): Promise<void> => {
    if (widthBusy || next === chatWidth) return;
    setWidthBusy(true);
    try {
      const prefs = await window.api.savePreferences({ chatWidth: next });
      setChatWidth(prefs.chatWidth === 'full' ? 'full' : 'default');
      applyChatWidth(prefs.chatWidth);
      emitPreferencesUpdated(prefs);
    } catch {
      useGitHubStore.getState().addToast("Couldn't change chat width", 'error');
    } finally {
      setWidthBusy(false);
    }
  };

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();
  const terminal = layout?.groups[DEFAULT_TERMINAL_GROUP_ID];
  const terminalHasTab = terminal?.tabs.some((tab) => tab.kind === 'terminal');
  const sidePanel = layout?.groups[DEFAULT_EXTRAS_GROUP_ID];
  // Early access presses (and highlights) the toggle of each visible panel;
  // off keeps the original pressed-while-collapsed state and no highlight.

  // Early access is also the inset window layout (see App.tsx).

  const sidePanelVisible = sidePanel !== undefined && !sidePanel.collapsed;
  const terminalVisible =
    terminal !== undefined && terminalHasTab === true && !terminal.collapsed;
  // With the pressed highlight carrying the state, early access names each
  // toggle for its panel instead of the next action.
  const sidePanelLabel = 'Toggle side panel';
  const terminalLabel = 'Toggle bottom drawer';
  const terminalNeedsAttention = useTerminalDrawerAttentionStore((state) => {
    const entry = state.worktrees[worktreeKey];
    const boundTerminalIds = new Set(
      terminal?.tabs
        .map((tab) => tab.instance?.terminalId)
        .filter((id): id is string => typeof id === 'string') ?? [],
    );
    return Boolean(
      entry?.collapsed &&
      Object.entries(entry.terminals).some(
        ([terminalId, item]) =>
          boundTerminalIds.has(terminalId) && (item.running || item.unread),
      ),
    );
  });
  useEffect(() => {
    useTerminalDrawerAttentionStore
      .getState()
      .setCollapsed(worktreeKey, Boolean(terminal?.collapsed));
  }, [terminal?.collapsed, worktreeKey]);

  const reportFailure = useCallback(() => {
    useGitHubStore.getState().addToast("Couldn't switch layout mode", 'error');
  }, []);

  // Early access: the mode picked here is also what new worktrees start in
  // (Settings → Display → Project layout), so the last choice carries over.
  // A failed save keeps the worktree's switch; the setting just stays as it
  // was.
  const rememberDefaultMode = useCallback(
    (next: 'minimal' | 'advanced'): void => {
      void window.api
        .savePreferences({ workspaceDefaultLayoutMode: next })
        .then(emitPreferencesUpdated)
        .catch(() => {
          /* The default keeps its last saved value. */
        });
    },
    [],
  );

  const selectMode = useCallback(
    (next: 'minimal' | 'advanced'): void => {
      if (conversionBusy || next === mode) return;
      const settle = (changed: boolean): void => {
        if (changed) rememberDefaultMode(next);
        else reportFailure();
      };
      if (next === 'advanced') {
        void setWorkspacePanelLayoutMode(worktreeKey, 'advanced').then(settle);
        return;
      }
      setConversionBusy(true);
      void setWorkspacePanelLayoutMode(worktreeKey, 'minimal')
        .then(settle)
        .finally(() => setConversionBusy(false));
    },
    [conversionBusy, mode, rememberDefaultMode, reportFailure, worktreeKey],
  );

  const restoreMaximizedGroup = (): void => {
    const store = usePanelLayoutStore.getState();
    const current = store.layouts[worktreeKey];
    if (current?.maximizedGroupId !== null && current?.maximizedGroupId) {
      store.maximizeGroup(worktreeKey, current.maximizedGroupId, false);
    }
  };

  const setGroupCollapsed = (groupId: string, collapsed: boolean): void => {
    restoreMaximizedGroup();
    const store = usePanelLayoutStore.getState();
    const group = store.layouts[worktreeKey]?.groups[groupId];
    if (!group) return;
    if (collapsed && group.collapsed === undefined) {
      store.collapseGroup(worktreeKey, groupId);
    } else if (!collapsed && group.collapsed !== undefined) {
      store.expandGroup(worktreeKey, groupId);
      // Explicit toggle gesture: the minimal-mode Bottom Drawer button and
      // the advanced-mode group toggles. A no-op for non-terminal and
      // already-bound tabs.
      requestRevealedTerminalPanelSpawn(
        projectId,
        worktreeId,
        worktreeKey,
        groupId,
      );
    }
    if (groupId === DEFAULT_TERMINAL_GROUP_ID) {
      useTerminalDrawerAttentionStore
        .getState()
        .setCollapsed(
          worktreeKey,
          Boolean(store.layouts[worktreeKey]?.groups[groupId]?.collapsed),
        );
    }
  };

  const toggleTerminal = (): void => {
    if (terminal && terminalHasTab) {
      setGroupCollapsed(
        DEFAULT_TERMINAL_GROUP_ID,
        terminal.collapsed === undefined,
      );
      return;
    }
    restoreMaximizedGroup();
    const location = ensureTerminalPanelVisible(worktreeKey);
    if (location === null) return;
    // Target and stamp it like every other panel-shaped gesture: an
    // untargeted request is claimable by any terminal surface in the layout
    // and is retained forever, so one left unclaimed here would fire on a
    // later PASSIVE activation (CAN-2309).
    requestTerminalSpawn({
      projectId,
      worktreeId,
      layoutKey: location.layoutKey,
      panelId: location.panelId,
      mode: 'ensure',
      requestedAt: Date.now(),
    });
  };

  const saveDefault = (): void => {
    // The menu opts out of closeOnSelect for its layout choices, so this
    // closing action returns focus to the trigger itself.
    setMenuOpen(false);
    triggerRef.current?.focus();
    void saveCurrentLayoutAsDefault(worktreeKey).then((ok) => {
      const success =
        panelSurfaceForWorktreeKey(worktreeKey) === 'cowork'
          ? 'Saved current layout as the default for Cowork projects'
          : 'Saved current layout as the default for new worktrees';
      useGitHubStore
        .getState()
        .addToast(
          ok ? success : 'Could not save the default layout',
          ok ? 'success' : 'error',
        );
    });
  };

  if (modeEntry === undefined || modeEntry.status === 'loading') {
    return <div data-testid="workspace-layout-controls-loading" />;
  }

  // Early access puts the Side Panel toggle after the terminal toggle, at the
  // end nearest the Side Panel; off keeps the original order.
  const sidePanelToggle = (
    <TitlebarIconButton
      data-testid="workspace-layout-side-panel-toggle"
      icon={SidebarHiddenRightWideIcon}
      onClick={() =>
        setGroupCollapsed(
          DEFAULT_EXTRAS_GROUP_ID,
          sidePanel?.collapsed === undefined,
        )
      }
      aria-label={sidePanelLabel}
      aria-pressed={sidePanelVisible}
      title={sidePanelLabel}
    />
  );

  return (
    <div
      // Early access (the inset layout): 1px further out than the bar's 9px
      // end padding, so the last control sits 8px from the window edge.
      className={`electron-no-drag inline-flex items-center${' -mr-px'}`}
    >
      <span
        className="workspace-layout-toggle-reveal"
        data-open={mode === 'minimal'}
        data-testid="workspace-layout-toggle-reveal"
        aria-hidden={mode !== 'minimal'}
        inert={mode !== 'minimal'}
      >
        <span
          className="workspace-layout-toggle-reveal-content"
          data-highlight-pressed={true}
        >
          {null}
          {terminalPty === true && (
            <span className="relative inline-flex">
              <TitlebarIconButton
                data-testid="workspace-layout-terminal-toggle"
                icon={BottombarHiddenBottomWideIcon}
                onClick={toggleTerminal}
                aria-label={terminalLabel}
                aria-pressed={terminalVisible}
                title={terminalLabel}
              />
              {terminal && terminal.collapsed && terminalNeedsAttention && (
                <span
                  data-testid="workspace-layout-terminal-attention"
                  className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-warning"
                  role="status"
                  title="Terminal running or has unread output"
                  aria-label="Terminal running or has unread output"
                >
                  <span className="sr-only">
                    Terminal running or has unread output
                  </span>
                </span>
              )}
            </span>
          )}
          {sidePanelToggle}
        </span>
      </span>
      <TitlebarIconButton
        ref={triggerRef}
        data-testid="worktree-top-save-layout-default"
        onClick={() => setMenuOpen((open) => !open)}
        icon={MoreHorizontalIcon}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? menuId : undefined}
        aria-label="Layout options"
        title="Layout options"
      />
      <FloatingMenu
        id={menuId}
        open={menuOpen}
        closeOnSelect={false}
        onOpenChange={setMenuOpen}
        anchorRef={triggerRef}
        placement="bottom-right"
        aria-label="Layout options"
        data-testid="save-layout-default-menu"
        className="w-64"
      >
        <WorkspaceLayoutPicker
          mode={mode}
          chatWidth={chatWidth}
          disabled={conversionBusy || widthBusy}
          onModeChange={selectMode}
          onChatWidthChange={(next) => {
            void selectChatWidth(next);
          }}
          onSaveDefault={saveDefault}
        />
      </FloatingMenu>
    </div>
  );
}
