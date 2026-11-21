import { useEffect } from 'react';
import {
  PIPELINE_EDITOR_PROJECT_ID,
  PIPELINE_EDITOR_WORKTREE_ID,
} from '@canopy/desktop-shared/types';
import type { NavigationPage } from '@/stores/navigationStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useNavigationHistoryStore } from '@/stores/navigationHistoryStore';
import { useAppAdvisorStore } from '@/stores/appAdvisorStore';
import { useChatStore } from '@/stores/chatStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useBrowserStore } from '@/stores/browserStore';
import { useSidebarStore } from '@/stores/sidebarStore';
import { useHomeComposerStore } from '@/stores/homeComposerStore';
import { desktopFileSessionController } from '@/lib/file-viewer/desktop-file-session-controller';
import { openCurrentWorktreePr } from '@/components/pr-picker/openCurrentPr';
import { isCoworkChatTarget } from '@/lib/cowork';
import {
  isAltCodeShortcutEvent,
  isDictationShortcutEvent,
  isBrowserSurfaceTarget,
  isBrowserHistoryShortcutEvent,
  isDialogTarget,
  isEditableTarget,
  isShortcutEvent,
  isTerminalTarget,
  type ShortcutEventLike,
} from '@/lib/keyboardShortcuts';
import { runNewTabShortcut } from '@/lib/newTabShortcut';
import { runCloseTabShortcut } from '@/lib/closeTabShortcut';
import { requestBrowserUrlFocus } from '@/lib/browserUrlFocus';
import { requestTerminalSpawn } from '@/lib/terminalSpawnRequests';
import { ensureTerminalPanelVisible } from '@/lib/panels/terminal-panel-activation';
import {
  findEditableSafePanelShortcut,
  matchesPanelShortcutBinding,
  PANEL_SHORTCUT_BINDINGS,
  runPanelCommand,
} from '@/lib/panels/commands';
import {
  getPanelLayoutViewModel,
  makeWorktreePanelKey,
} from '@/stores/panelLayoutStore';
import {
  resolveFallbackFindTarget,
  runFindShortcut,
  type FindTarget,
} from '@/lib/find/findShortcut';
import { requestPipelineAssistantOpen } from '@/lib/pipelineAssistantEvents';
import {
  OPEN_CHAT_ATTACHMENTS_EVENT,
  type ChatAttachmentShortcutTarget,
} from '@/lib/chatAttachmentShortcut';
import {
  requestEffortLevelCycle,
  requestDictationPress,
  requestDictationRelease,
  requestModelPickerOpen,
  requestWorkspacePickerOpen,
  type ComposerShortcutScope,
} from '@/lib/composerShortcutRequests';

export { OPEN_CHAT_ATTACHMENTS_EVENT } from '@/lib/chatAttachmentShortcut';

interface PageShortcut {
  key: string;
  page: NavigationPage;
}

const PAGE_SHORTCUTS: PageShortcut[] = [
  { key: '1', page: 'overview' },
  { key: '2', page: 'main' },
  { key: '3', page: 'chat' },
  { key: '4', page: 'workflows-library' },
  { key: '5', page: 'plugins' },
  { key: '6', page: 'audit' },
  { key: '7', page: 'usage' },
  { key: '8', page: 'workflows' },
  { key: '9', page: 'statistics' },
];

function getNormalSelectedWorktree(): {
  projectId: string;
  worktreeId: string;
} | null {
  const selection = useChatStore.getState().selectedWorktree;
  if (!selection || isCoworkChatTarget(selection.projectId)) {
    return null;
  }

  return selection;
}

/**
 * The selection whose panel grid is actually visible: the normal worktree on
 * the main page, or the cowork work entry on the chat page. Null anywhere
 * else — surface-scoped chords (terminal/browser routing) no-op there.
 */
function getVisibleGridSelection(): {
  projectId: string;
  worktreeId: string;
} | null {
  const selection = useChatStore.getState().selectedWorktree;
  if (!selection) {
    return null;
  }
  const activePage = useNavigationStore.getState().activePage;
  const isCowork = isCoworkChatTarget(selection.projectId);
  if (activePage === 'main' && !isCowork) {
    return selection;
  }
  if (activePage === 'chat' && isCowork) {
    return selection;
  }
  return null;
}

/**
 * The focused browser id of the visible grid's browser surface, or null when
 * no browser context is active. Used by the browser-chrome chord handlers.
 */
function getActiveBrowserId(): string | null {
  const selection = getVisibleGridSelection();
  if (!selection) {
    return null;
  }
  const bucket =
    useBrowserStore.getState().worktrees[
      `${selection.projectId}/${selection.worktreeId}`
    ];
  return bucket?.activeBrowserId ?? null;
}

/**
 * Cmd/Ctrl+F target when no surface owns the keydown: the searchable surface
 * in the visible grid's active panel group, else the document's only one.
 */
function resolveMainWindowFindFallback(): FindTarget | null {
  const selection = getVisibleGridSelection();
  const activeGroupId = selection
    ? (getPanelLayoutViewModel(
        makeWorktreePanelKey(selection.projectId, selection.worktreeId),
      )?.activeGroupId ?? null)
    : null;
  return resolveFallbackFindTarget(document, activeGroupId);
}

/**
 * Context-aware ⌘/Ctrl+T (ECW-7984): create a new tab of the focused
 * surface's own type instead of always a chat tab. Panel-grid surfaces route
 * through `runNewTabShortcut`; the Pipelines page creates a Pipeline
 * Assistant chat tab; every other page falls back to the command palette
 * seeded with "new" — never a silent navigation or chat tab.
 */
function handleNewTabChord(target: EventTarget | null): void {
  const navigation = useNavigationStore.getState();
  const selection = useChatStore.getState().selectedWorktree;
  const isCowork =
    selection !== null && isCoworkChatTarget(selection.projectId);

  if (navigation.activePage === 'chat' && selection && isCowork) {
    runNewTabShortcut({
      projectId: selection.projectId,
      worktreeId: selection.worktreeId,
      target,
      createChatTab: (): void => {
        void useStandaloneChatStore.getState().startNewChat();
      },
    });
    return;
  }

  const normal = getNormalSelectedWorktree();
  if (navigation.activePage === 'main' && normal) {
    runNewTabShortcut({
      projectId: normal.projectId,
      worktreeId: normal.worktreeId,
      target,
      createChatTab: (): void => {
        useChatStore.getState().createTab();
      },
    });
    return;
  }

  if (navigation.activePage === 'workflows-library') {
    // The Pipeline Assistant drawer is the Pipelines page's tabbed surface.
    // The open event mirrors the App Advisor dispatcher's
    // `openPipelineAssistantSurface` (the page persists the visibility
    // preference itself when handling it).
    requestPipelineAssistantOpen();
    useChatStore.getState().createTab({
      projectId: PIPELINE_EDITOR_PROJECT_ID,
      worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
    });
    return;
  }

  // Documented fallback for surfaces without a new-tab concept (Overview,
  // Audit, Usage, ...): offer the "new ..." commands instead of silently
  // navigating away or creating a tab somewhere invisible.
  navigation.openCommandPalette('new');
}

/**
 * The composer the ⌥ chords address, or null when no composer is on screen.
 *
 * Resolution mirrors the ⌘U attachment path (Pipelines uses the assistant
 * sentinel, main/chat use the selected worktree's active tab) and adds the
 * Home composer, which is a singleton and therefore needs no identity.
 * Returning null leaves the chord UNCLAIMED so macOS still composes the
 * Option character (⌥M → `µ`) into whatever field has focus.
 */
function resolveComposerShortcutScope(): ComposerShortcutScope | null {
  const navigation = useNavigationStore.getState();
  const chatState = useChatStore.getState();

  if (navigation.activePage === 'home') {
    return useHomeComposerStore.getState().mode === 'chat'
      ? { scope: 'home' }
      : null;
  }

  if (navigation.activePage === 'workflows-library') {
    const assistantChat =
      chatState.worktreeChats[
        `${PIPELINE_EDITOR_PROJECT_ID}/${PIPELINE_EDITOR_WORKTREE_ID}`
      ];
    const assistantPanel = document.querySelector(
      '[data-testid="pipeline-chat-panel"]',
    );
    const assistantDrawerVisible =
      assistantPanel !== null && assistantPanel.getClientRects().length > 0;
    if (!assistantChat?.activeTabId || !assistantDrawerVisible) {
      return null;
    }
    return {
      scope: 'chat',
      projectId: PIPELINE_EDITOR_PROJECT_ID,
      worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
      chatId: assistantChat.activeTabId,
    };
  }

  if (navigation.activePage !== 'main' && navigation.activePage !== 'chat') {
    return null;
  }

  const selection = getVisibleGridSelection();
  if (!selection) {
    return null;
  }
  const worktreeChat =
    chatState.worktreeChats[`${selection.projectId}/${selection.worktreeId}`];
  if (!worktreeChat?.activeTabId) {
    return null;
  }
  return {
    scope: 'chat',
    projectId: selection.projectId,
    worktreeId: selection.worktreeId,
    chatId: worktreeChat.activeTabId,
  };
}

export interface GlobalShortcutKeyEvent extends ShortcutEventLike {
  preventDefault: () => void;
  target: EventTarget | null;
  /** Auto-repeat while a key is held (hold-to-dictate swallows these). */
  repeat?: boolean;
  /** A focused component already consumed the chord. */
  defaultPrevented?: boolean;
}

export function handleGlobalShortcutKeyDown(
  event: GlobalShortcutKeyEvent,
): void {
  if (event.isComposing) {
    return;
  }

  // A terminal with a registered find controller takes Cmd/Ctrl+F (the one
  // CAN-338 exception; its xterm lets the chord through only then). An
  // unmarked terminal opens nothing and never resolves to a sibling surface,
  // on every platform.
  if (isTerminalTarget(event.target) && isShortcutEvent(event, 'f')) {
    runFindShortcut(event, () => null);
    return;
  }

  // CAN-338: a focused terminal owns Ctrl-combos so readline shortcuts
  // (Ctrl+R reverse-i-search, Ctrl+A/E/W/U/L, ...) reach the shell instead
  // of triggering app shortcuts. On Windows/Linux this also means app
  // shortcuts such as Ctrl+S, Ctrl+P, Ctrl+T, Ctrl+W, Ctrl+N, Ctrl+, and
  // numbered worktree navigation require moving focus out of the terminal
  // first. Only the command palette (Ctrl+K), the shortcuts settings page
  // (Ctrl+Shift+K), a searchable terminal's own find bar (Ctrl+F, above),
  // and the panel tab-cycle chords (CAN-4616: Ctrl+Tab / Ctrl+Shift+Tab,
  // Ctrl+PageDown / Ctrl+PageUp, which a cycle landing on a terminal tab
  // needs to leave it) stay global; readline's forward-char yields to the
  // Right arrow. On macOS app shortcuts are Cmd-based (`isShortcutEvent`
  // never matches Ctrl there), so this early return changes nothing on that
  // platform.
  const editableSafeBinding = findEditableSafePanelShortcut(event);
  if (
    event.ctrlKey &&
    !event.metaKey &&
    isTerminalTarget(event.target) &&
    !isShortcutEvent(event, 'k') &&
    !isShortcutEvent(event, 'k', { shift: true }) &&
    editableSafeBinding === undefined
  ) {
    return;
  }

  // ⌘/Ctrl+W is always app-owned. The application menu deliberately binds no
  // accelerator to Close Window (see main/menu.ts), so the chord reaches the
  // renderer everywhere; swallow it unconditionally so it can never fall
  // through to a window-closing default. Whether it actually closes a tab is
  // decided below: it closes the active tab of the visible panel grid (the
  // Code worktree on the main page, the Cowork work entry on the chat page)
  // when no overlay, dialog or quick prompt is open and the close is not
  // refused (for example a busy chat) — otherwise it is a safe no-op.
  const isCloseTabChord = isShortcutEvent(event, 'w');
  if (isCloseTabChord) {
    event.preventDefault();
  }

  const navigation = useNavigationStore.getState();

  if (isShortcutEvent(event, 'k', { shift: true })) {
    event.preventDefault();
    navigation.openSettings('shortcuts');
    return;
  }

  if (isShortcutEvent(event, 'g', { shift: true })) {
    event.preventDefault();
    if (navigation.prPickerOpen) {
      navigation.closePrPicker();
      return;
    }
    openCurrentWorktreePr();
    return;
  }

  if (isShortcutEvent(event, 'k')) {
    event.preventDefault();
    if (navigation.commandPaletteOpen) {
      navigation.closeCommandPalette();
      return;
    }
    navigation.openCommandPalette();
    return;
  }

  if (isShortcutEvent(event, 'p')) {
    event.preventDefault();
    if (navigation.fileSearchPaletteOpen) {
      navigation.closeFileSearchPalette();
      return;
    }
    // The palette works for both surfaces: code worktrees (main page) and
    // cowork work entries (chat page) — the file index and openFileTab are
    // keyed by the same (projectId, worktreeId) selection either way.
    const selection = useChatStore.getState().selectedWorktree;
    if (!selection) {
      return;
    }
    navigation.navigate(
      isCoworkChatTarget(selection.projectId) ? 'chat' : 'main',
    );
    navigation.openFileSearchPalette();
    return;
  }

  if (isShortcutEvent(event, ',')) {
    event.preventDefault();
    navigation.openSettings();
    return;
  }

  // While the command palette is open, defer all other shortcuts to it
  // so navigation/chat shortcuts don't fire underneath the modal.
  if (navigation.commandPaletteOpen) {
    return;
  }

  // Same for the file search palette: don't fire navigation/chat shortcuts
  // while it's open.
  if (navigation.fileSearchPaletteOpen) {
    return;
  }

  // Same for the PR picker.
  if (navigation.prPickerOpen) {
    return;
  }

  // Suppress navigation/chat shortcuts while the Settings overlay is open
  // so ⌘1–9, ⌘T, ⌘N, ⌘W don't invisibly mutate state behind the overlay.
  if (navigation.settingsOpen) {
    return;
  }

  // Same for the App Advisor quick prompt — it is a modal with a focused
  // Slate editor; navigation/chat chords must not fire behind it.
  if (navigation.appAdvisorQuickPromptOpen) {
    return;
  }

  // ⌘/Ctrl+F — open the floating find bar for the focused chat, browser
  // chrome, or previewed file (CAN-3048). Runs before the editable-target
  // guard so it works from the composer; dialogs and handlers that already
  // claimed the chord keep it.
  if (runFindShortcut(event, resolveMainWindowFindFallback)) {
    return;
  }

  if (isShortcutEvent(event, 'l', { shift: true })) {
    event.preventDefault();
    navigation.openAppAdvisorQuickPrompt();
    return;
  }

  if (isShortcutEvent(event, 'l')) {
    event.preventDefault();
    // Browser convention wins while browser chrome owns focus: ⌘/Ctrl+L
    // focuses the address bar of the active browser tab (ECW-7984). The
    // native-page equivalent is routed by the main process
    // (`main/browser/browser-shortcuts.ts`). Everywhere else the chord keeps
    // its App Advisor binding.
    if (isBrowserSurfaceTarget(event.target)) {
      const browserId = getActiveBrowserId();
      if (browserId !== null) {
        requestBrowserUrlFocus(browserId);
        return;
      }
    }
    useAppAdvisorStore.getState().openDialog();
    return;
  }

  // ⌘←/⌘→ — history navigation. While browser CHROME owns focus (tab strip,
  // inspector, ...) the chord drives the active browser tab's own history;
  // everywhere else it drives APP navigation history, mirroring the titlebar
  // back/forward arrows (ECW-7984 follow-up).
  //
  // Editable targets keep their native cursor-jump behavior (⌘← is
  // move-to-line-start on macOS) and a focused terminal keeps its own
  // Alt+Arrow word motion — on Windows/Linux this chord also matches bare
  // Alt+Arrow, which the CAN-338 Ctrl-only terminal guard above does not
  // catch. Keydowns inside the NATIVE browser page are routed by the main
  // process instead. Unavailable directions are safe, unclaimed no-ops.
  const isBackChord = isBrowserHistoryShortcutEvent(event, 'ArrowLeft');
  const isForwardChord = isBrowserHistoryShortcutEvent(event, 'ArrowRight');
  if (
    (isBackChord || isForwardChord) &&
    !isEditableTarget(event.target) &&
    !isTerminalTarget(event.target)
  ) {
    // A merely visible browser panel never steals the chord — `event.target`
    // must sit inside the browser surface for the browser to win.
    if (isBrowserSurfaceTarget(event.target)) {
      const browserId = getActiveBrowserId();
      if (browserId !== null) {
        event.preventDefault();
        const store = useBrowserStore.getState();
        void (
          isBackChord
            ? window.api.browser.back({ browserId })
            : window.api.browser.forward({ browserId })
        )
          .then((snapshot) => {
            store.applySnapshot(snapshot);
          })
          .catch(() => {
            // Errors surface through browser events; the chord stays consumed.
          });
      }
      // Browser chrome owns this chord even while its active session is
      // hydrating or stale. Never fall through to app navigation history and
      // route a browser-owned keypress through another surface.
      return;
    }

    const history = useNavigationHistoryStore.getState();
    const didNavigate = isBackChord ? history.goBack() : history.goForward();
    if (didNavigate) {
      event.preventDefault();
    }
    return;
  }

  // Cmd+S / Ctrl+S — save the active file tab. We intercept this BEFORE
  // the `isEditableTarget` early-return because Monaco renders inside an
  // editable element and would otherwise bail out here. If the active
  // tab isn't a file tab we don't `preventDefault` so the browser /
  // editor's own Save handling (e.g. the Slate composer) is preserved.
  if (isShortcutEvent(event, 's') && navigation.activePage === 'main') {
    const selection = getNormalSelectedWorktree();
    if (selection) {
      const worktreeKey = `${selection.projectId}/${selection.worktreeId}`;
      const worktreeChat = useChatStore.getState().worktreeChats[worktreeKey];
      const activeTab = worktreeChat?.tabs.find(
        (tab) => tab.id === worktreeChat.activeTabId,
      );
      if (activeTab && activeTab.kind === 'file') {
        // No shared registration/session for this tab → leave the keystroke
        // unclaimed (don't preventDefault) so we never swallow Save silently.
        if (!desktopFileSessionController.hasSession(activeTab.id)) {
          return;
        }
        event.preventDefault();
        void desktopFileSessionController.saveTab(activeTab.id);
        return;
      }
    }
  }

  // A dialog's editor is the exception to the pre-editable-guard chords
  // below: typing in a modal (review/plan search, task forms, ...) must not
  // navigate or mutate the page hidden behind the overlay. Non-dialog
  // overlays with store flags are handled by the early returns above.
  if (isEditableTarget(event.target) && isDialogTarget(event.target)) {
    return;
  }

  // ⌘1–9 page navigation, ⌘T new tab, ⌘N new task, ⌘U attachments, Ctrl+`
  // terminal, and ⌘W close tab are modifier chords that no text field
  // legitimately owns, so they run BEFORE the editable-target guard: they
  // must keep working while the focus sits in the Slate composer, Monaco, or
  // any input (previously the blanket guard made them silently dead there,
  // and the unhandled ⌘W fell through to the menu's Close Window).
  const pageShortcut = PAGE_SHORTCUTS.find((shortcut) =>
    isShortcutEvent(event, shortcut.key),
  );
  if (pageShortcut) {
    event.preventDefault();
    navigation.navigate(pageShortcut.page);
    return;
  }

  if (isShortcutEvent(event, 't')) {
    event.preventDefault();
    handleNewTabChord(event.target);
    return;
  }

  if (isShortcutEvent(event, 'n')) {
    event.preventDefault();
    // ECW-7984: ⌘/Ctrl+N opens the new-task Home surface instead of assuming
    // a new worktree — describing the task there is what creates one. "New
    // Worktree" remains available from the command palette.
    navigation.navigate('home');
    return;
  }

  // ⌘/Ctrl+U — open the visible chat composer's attachment picker. Runs
  // before the editable guard so it works while typing in the composer. Left
  // unclaimed (no preventDefault) when no chat surface is visible.
  if (isShortcutEvent(event, 'u')) {
    const chatState = useChatStore.getState();
    if (navigation.activePage === 'workflows-library') {
      // The Pipelines page's composer is the Pipeline Assistant drawer,
      // bound to the pipeline-editor sentinel target rather than the
      // selected worktree. The page conditionally mounts the drawer and its
      // responsive classes can still hide a mounted panel, so rendered layout
      // presence gates dispatch and leaves the chord unclaimed when hidden.
      const assistantChat =
        chatState.worktreeChats[
          `${PIPELINE_EDITOR_PROJECT_ID}/${PIPELINE_EDITOR_WORKTREE_ID}`
        ];
      const assistantPanel = document.querySelector(
        '[data-testid="pipeline-chat-panel"]',
      );
      const assistantDrawerVisible =
        assistantPanel !== null && assistantPanel.getClientRects().length > 0;
      if (assistantChat?.activeTabId && assistantDrawerVisible) {
        const detail: ChatAttachmentShortcutTarget = {
          projectId: PIPELINE_EDITOR_PROJECT_ID,
          worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
          chatId: assistantChat.activeTabId,
        };
        event.preventDefault();
        document.dispatchEvent(
          new CustomEvent(OPEN_CHAT_ATTACHMENTS_EVENT, { detail }),
        );
      }
      return;
    }
    const selection = chatState.selectedWorktree;
    if (
      selection &&
      (navigation.activePage === 'main' || navigation.activePage === 'chat')
    ) {
      const worktreeChat =
        chatState.worktreeChats[
          `${selection.projectId}/${selection.worktreeId}`
        ];
      if (worktreeChat?.activeTabId) {
        const detail: ChatAttachmentShortcutTarget = {
          projectId: selection.projectId,
          worktreeId: selection.worktreeId,
          chatId: worktreeChat.activeTabId,
        };
        event.preventDefault();
        document.dispatchEvent(
          new CustomEvent(OPEN_CHAT_ATTACHMENTS_EVENT, { detail }),
        );
      }
    }
    return;
  }

  // Bare ⌥ composer chords (ECW-7984 follow-up). Matched by physical `code`
  // because macOS composes Option+<letter> into `∑`/`µ`/`†`. Each stays
  // UNCLAIMED when its surface isn't on screen, so the Option character still
  // types normally in that case.
  const isComposerOptionChord =
    isAltCodeShortcutEvent(event, 'KeyW') ||
    isAltCodeShortcutEvent(event, 'KeyM') ||
    isAltCodeShortcutEvent(event, 'KeyT');
  if (isComposerOptionChord && isTerminalTarget(event.target)) {
    return;
  }

  if (isAltCodeShortcutEvent(event, 'KeyW')) {
    // ⌥W is Home-only: the workspace picker belongs to the new-task empty
    // state, and no other surface has one to open.
    if (
      navigation.activePage === 'home' &&
      useHomeComposerStore.getState().mode === 'chat'
    ) {
      if (requestWorkspacePickerOpen()) {
        event.preventDefault();
      }
    }
    return;
  }

  if (isAltCodeShortcutEvent(event, 'KeyM')) {
    const scope = resolveComposerShortcutScope();
    if (scope && requestModelPickerOpen(scope)) {
      event.preventDefault();
    }
    return;
  }

  if (isAltCodeShortcutEvent(event, 'KeyT')) {
    const scope = resolveComposerShortcutScope();
    if (scope && requestEffortLevelCycle(scope)) {
      event.preventDefault();
    }
    return;
  }

  // ⌃M — hold to dictate into the composer on screen (the release is
  // handled by the keyup listener below). Unclaimed, and passed on, when no
  // composer takes it, such as one without voice dictation. Auto-repeat
  // while held is swallowed.
  if (isDictationShortcutEvent(event) && !isTerminalTarget(event.target)) {
    if (event.repeat === true) {
      if (heldDictation) event.preventDefault();
      return;
    }
    const scope = resolveComposerShortcutScope();
    if (scope && requestDictationPress(scope)) {
      event.preventDefault();
      heldDictation = { scope, pressedAt: Date.now() };
    }
    return;
  }

  // ⌘/Ctrl+B — show/hide the left navigation sidebar (ECW-7984 follow-up).
  // Runs before the editable-target guard so it works while typing, matching
  // the VS Code convention users expect from a ⌘B sidebar toggle.
  //
  // NOTE: the companion ⌘⌥B "hide the right side panel" chord from the same
  // follow-up is deliberately NOT bound yet. The obvious target,
  // `useActivityStore.panelExpanded`, is legacy state with no JSX consumer —
  // it only persists the `activityPanelExpanded` preference and is read by a
  // WorktreeManager effect and `PrStatusBar`, so toggling it hides nothing.
  // The real right-hand panel is a panel-grid GROUP
  // (`DEFAULT_ACTIVITY_GROUP_ID`), and a reversible hide/restore for a group
  // needs layout-subtree preservation that the panel store does not expose
  // today. Binding the chord to the legacy flag would ship a shortcut that
  // silently does nothing.
  if (isShortcutEvent(event, 'b')) {
    event.preventDefault();
    useSidebarStore.getState().toggleHidden();
    return;
  }

  // Ctrl+` — open/focus the integrated terminal (VS Code convention; the
  // chord is Ctrl-based on every platform, including macOS). A focused
  // terminal keeps all Ctrl combos for the shell (CAN-338 guard above), so
  // this only fires from outside the terminal. No-op (unclaimed) when no
  // panel grid is visible.
  if (
    event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    (event.code === 'Backquote' || (!event.code && event.key === '`'))
  ) {
    const selection = getVisibleGridSelection();
    if (selection) {
      event.preventDefault();
      const layoutKey = makeWorktreePanelKey(
        selection.projectId,
        selection.worktreeId,
      );
      const location = ensureTerminalPanelVisible(layoutKey);
      requestTerminalSpawn({
        projectId: selection.projectId,
        worktreeId: selection.worktreeId,
        layoutKey: location?.layoutKey ?? layoutKey,
        mode: 'ensure',
      });
    }
    return;
  }

  if (isCloseTabChord) {
    // Already preventDefault-ed at the top; only the action is gated here.
    // Context-aware (ECW-7984): close the FOCUSED surface's active panel the
    // same way its tab-strip "X" button does, not always the chat tab. Acts on
    // whichever panel grid is visible: the normal worktree on the main page or
    // the cowork work entry on the chat page.
    // Not behind a modal (the media viewer, a confirm): focus sits on one of
    // its buttons, or falls to the page once its picture is clicked.
    const selection = getVisibleGridSelection();
    if (
      !selection ||
      isDialogTarget(event.target) ||
      document.querySelector('[aria-modal="true"]') !== null
    ) {
      return;
    }

    runCloseTabShortcut({
      projectId: selection.projectId,
      worktreeId: selection.worktreeId,
    });
    return;
  }

  // Editable-safe panel chords (CAN-4616 tab cycling: ⌘⇧] / ⌘⇧[ on macOS,
  // Ctrl+Tab / Ctrl+Shift+Tab and Ctrl+PageDown / Ctrl+PageUp elsewhere)
  // never move a cursor or edit text, so like ⌘W they run before the
  // editable-target guard and keep working from the composer, an editor, or
  // a terminal (the CAN-338 guard above lets them through). They act on the
  // visible grid (Cowork entries included) and stay unclaimed off it, and
  // inside any dialog, editable or not: a focused confirm button must not
  // switch the tab behind the modal it belongs to.
  if (editableSafeBinding) {
    const selection = getVisibleGridSelection();
    if (
      !selection ||
      event.defaultPrevented === true ||
      isDialogTarget(event.target)
    ) {
      return;
    }
    event.preventDefault();
    runPanelCommand(
      editableSafeBinding.id,
      makeWorktreePanelKey(selection.projectId, selection.worktreeId),
    );
    return;
  }

  if (isEditableTarget(event.target)) {
    return;
  }

  // Panel-grid operations (doc 12 §1). Behind the editable-target guard so
  // the Slate composer, Monaco, and the terminal's hidden textarea keep their
  // own keys (⌘[ / ⌘] are indent chords in editors). No-op (without
  // swallowing the event) when off the main page or no normal worktree is
  // selected.
  const panelBinding = PANEL_SHORTCUT_BINDINGS.find(
    (binding) =>
      binding.editableSafe !== true &&
      matchesPanelShortcutBinding(event, binding),
  );
  if (panelBinding) {
    const selection = getNormalSelectedWorktree();
    if (!selection || navigation.activePage !== 'main') {
      return;
    }
    event.preventDefault();
    runPanelCommand(
      panelBinding.id,
      makeWorktreePanelKey(selection.projectId, selection.worktreeId),
    );
    return;
  }
}

/** The composer ⌃M is held over, and when the press began. */
let heldDictation: { scope: ComposerShortcutScope; pressedAt: number } | null =
  null;

/** Ends a ⌃M press: letting go of M or Control, or the window losing focus. */
function releaseHeldDictation(): void {
  if (!heldDictation) return;
  const { scope, pressedAt } = heldDictation;
  heldDictation = null;
  requestDictationRelease(scope, Date.now() - pressedAt);
}

export function useGlobalShortcuts(): void {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      handleGlobalShortcutKeyDown(event);
    }
    function handleKeyUp(event: KeyboardEvent): void {
      if (event.code === 'KeyM' || event.key === 'Control') {
        releaseHeldDictation();
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', releaseHeldDictation);
    return (): void => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', releaseHeldDictation);
    };
  }, []);
}
