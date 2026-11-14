import { MutedUserBubblesContext } from '@/components/chat/muted-user-bubbles-context';
import { ResumeQueueModal } from '@/components/usage-limit/ResumeQueueModal';
/**
 * Root renderer mounted inside the standalone App Advisor `BrowserWindow`
 * (mounted by `app-advisor-entry.tsx`, the `app-advisor.html` page).
 *
 * Layout: the full cowork-style App Advisor workspace —
 * {@link AppAdvisorWorkspaceSurface} (collapsible nav + top bar + panel grid
 * + archive overlay + ask-user dock) with the in-popout
 * {@link AppAdvisorSettingsModal}. None of the main window's shell —
 * sidebar, pages, settings overlay, command palette, portal modal — is
 * mounted here.
 *
 * Chat state: entry-keyed `(app-advisor, <workEntryId>)` chats owned by the
 * standard chat store; the standalone chat store runs in SCOPED mode
 * (`initializeScoped('app-advisor')`) so it never lists projects or writes
 * main-window MRU preferences.
 *
 * Theme/UI-scale loading: this renderer reads preferences once on mount and
 * applies them, then stays in immediate lockstep with the main window by
 * subscribing to the cross-window `preferences:synced` broadcast the main
 * process emits on every save (`onPreferencesSynced`). The same-renderer
 * `canopy:preferences-updated` browser event is NOT visible across renderer
 * processes, so it cannot be used here — the IPC broadcast is what keeps the
 * App Advisor window's theme/color-mode/UI-scale updating live instead of only
 * on the next show/reload.
 */
import { AppAdvisorWindowRuntimeBridge } from '@/components/app-advisor/AppAdvisorRuntimeBridge';
import { AppAdvisorSettingsModal } from '@/components/app-advisor/AppAdvisorSettingsModal';
import { AppAdvisorWorkspaceSurface } from '@/components/app-advisor/AppAdvisorWorkspaceSurface';
import { startAppAdvisorNewEntry } from '@/components/app-advisor/appAdvisorNewEntry';
import { OverlayLayerSlot } from '@/components/overlay-layer/OverlayLayerSlot';
import { ToastContainer } from '@/components/shared/ToastContainer';
import {
  selectArchivedOverviewWorkspaceForSurface,
  selectArchivedViewerForSurface,
} from '@/components/standalone-chat/coworkArchiveOverlayState';
import { UsageLimitResumeModal } from '@/components/usage-limit/UsageLimitResumeModal';
import { useAutoArchiveNotifications } from '@/hooks/useAutoArchiveNotifications';
import { useBillingLaneRuntimeSync } from '@/hooks/useBillingLaneRuntimeSync';
import { useChatEventSubscriptions } from '@/hooks/useChatEventSubscriptions';
import { usePipelineRunsBridge } from '@/hooks/usePipelineRunsBridge';
import { appAdvisorWindowSenderOpener } from '@/lib/agent-sent-sender-opener';
import { APP_ADVISOR_AI_CREDITS_SCOPE } from '@/lib/aiCreditsScope';
import { requestBrowserUrlFocus } from '@/lib/browserUrlFocus';
import {
  flushChatInterest,
  getChatInterest,
  subscribeChatInterest,
  useChatInterestDeclaration,
} from '@/lib/chat-interest';
import { requestChatPanelReveal } from '@/lib/chatPanelReveal';
import {
  hasCloseableTabForShortcut,
  runCloseTabShortcut,
} from '@/lib/closeTabShortcut';
import {
  resolveFallbackFindTarget,
  runFindShortcut,
  type FindTarget,
} from '@/lib/find/findShortcut';
import {
  isBrowserHistoryShortcutEvent,
  isBrowserSurfaceTarget,
  isEditableTarget,
  isShortcutEvent,
  isTerminalTarget,
} from '@/lib/keyboardShortcuts';
import { runNewTabShortcut } from '@/lib/newTabShortcut';
import {
  refreshInAppNotificationPrefs,
  refreshOsNotificationPrefs,
} from '@/lib/osNotifications';
import { openSubagentChatPanel } from '@/lib/panels/subagent-panel-open';
import { useRendererDiagnostics } from '@/lib/renderer-diagnostics';
import { applyDisplayPreferences } from '@/lib/theme';
import { useInAppNotificationPlacement } from '@/lib/useInAppNotificationPlacement';
import { useAppAdvisorStore } from '@/stores/appAdvisorStore';
import { useLabsExperimentEnabled } from '@/stores/labsExperimentsStore';
import { ORCHESTRATOR_PAGE_EXPERIMENT_ID } from '@/lib/orchestratorPageExperiment';
import {
  ensureArchivedContainersSubscription,
  useArchivedContainersStore,
} from '@/stores/archivedContainersStore';
import { ensureBrowserEventSubscription } from '@/stores/browserEventSubscription';
import { useBrowserStore } from '@/stores/browserStore';
import { invalidateApprovalDefaults } from '@/stores/chat/approval-defaults';
import {
  useStaleChatCatchUp,
  type StaleChatCatchUpHost,
} from '@/stores/chat/stale-catch-up';
import {
  initializeClaudeTerminalChatSync,
  useChatStore,
} from '@/stores/chatStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  getPanelLayoutViewModel,
  makeWorktreePanelKey,
} from '@/stores/panelLayoutStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import { SurfaceFindHost } from '@canopy/ui-app/find';
import {
  AgentSentSenderOpenerProvider,
  getInAppNotificationContainerClasses,
} from '@canopy/ui-shared';
import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react';

const staleChatCatchUpHost: StaleChatCatchUpHost = {
  current: getChatInterest,
  subscribe: subscribeChatInterest,
  flush: flushChatInterest,
};

function getActiveBrowserId(entryId: string): string | null {
  const bucket =
    useBrowserStore.getState().worktrees[
      `${APP_ADVISOR_PROJECT_ID}/${entryId}`
    ];
  return bucket?.activeBrowserId ?? null;
}

/**
 * Cmd/Ctrl+F target when no surface owns the keydown (the composer sits
 * outside its transcript's find marker): the searchable surface in the active
 * Work Entry's active panel group, as in the main window. The chats-only
 * floating panel has no panel grid, so it keeps the document's only surface.
 */
function resolveAppAdvisorFindFallback(): FindTarget | null {
  const standalone = useStandaloneChatStore.getState();
  const entryId =
    standalone.activeChatProjectId === APP_ADVISOR_PROJECT_ID &&
    useAppAdvisorStore.getState().layout !== 'floating'
      ? standalone.activeWorkEntryId
      : null;
  const activeGroupId =
    entryId === null
      ? null
      : (getPanelLayoutViewModel(
          makeWorktreePanelKey(APP_ADVISOR_PROJECT_ID, entryId),
        )?.activeGroupId ?? null);
  return resolveFallbackFindTarget(document, activeGroupId);
}

export function AppAdvisorWindowApp(): JSX.Element {
  const commandQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Floating (early access), the page sits in a transparent view and the
  // panel rounds its own corners, so nothing behind it may paint.
  const floating = useAppAdvisorStore((s) => s.layout === 'floating');
  // Docked in the main window's content area, the page draws only its panel
  // cards; the window material around them is the main window's.
  const docked = useAppAdvisorStore((s) => s.layout === 'docked');
  // Subscribes this window to main's Labs snapshot early, so the floating
  // panel's Open full window knows whether the Orchestrator page is on.
  useLabsExperimentEnabled(ORCHESTRATOR_PAGE_EXPERIMENT_ID);
  // Before paint, so no frame shows the body's background behind the panel.
  useLayoutEffect(() => {
    document.body.toggleAttribute('data-app-advisor-floating', floating);
    document.body.toggleAttribute('data-app-advisor-docked', docked);
  }, [floating, docked]);
  const notificationPlacement = useInAppNotificationPlacement();

  // Keep the App Advisor renderer's chat-store slices updated from the same
  // ChatEvent stream the main renderer consumes. Mount exactly once: the
  // main window keeps its own subscription and does not unsubscribe when
  // this surface mounts.
  useChatEventSubscriptions();
  // App Advisor's renderer receives its own chat events, so it declares the
  // chats it shows itself.
  useChatInterestDeclaration('app-advisor');
  useStaleChatCatchUp(staleChatCatchUpHost);
  // Local-only frame and delivery diagnostics for this renderer.
  useRendererDiagnostics();
  useAutoArchiveNotifications();
  // This isolated renderer has its own pipeline stores, so it installs its
  // own pipeline bridge: run cards and its Activity panel stay live. Global
  // worktree status (sidebar, overview) belongs to the main window.
  usePipelineRunsBridge({ trackGlobalStatus: false });

  // Required here as well as in `App.tsx`, not just there.
  // `setRendererBillingLaneAvailability` has exactly one call site — this hook
  // — so without it THIS renderer's `billingLaneRuntime` stays at
  // `UNKNOWN_AVAILABILITY` for the whole process lifetime. That is not inert:
  // this window still runs full lane resolution and re-stamping (catalog
  // hydration and `standaloneChatStore` both call
  // `syncActiveEmptyTabToDefaults`), and with every axis `undefined` no lane is
  // ever CONFIRMED unavailable — so `no-dispatchable-model` is unreachable, the
  // dead-end banner never renders, and a tab the main window correctly moved
  // off a dead lane gets seeded straight back onto it in the shared chat file.
  // App Advisor is Personal work, so its credits read never follows the main
  // window's organization context (CAN-3463).
  useBillingLaneRuntimeSync(APP_ADVISOR_AI_CREDITS_SCOPE);

  // Hydrate every App Advisor Work Entry in this authoritative renderer, not
  // only the most recently selected entry initialized by the scoped workspace.
  // `hydrateForNavigation` re-checks focus after loading, so unread clears are
  // persisted even when the focus broadcast arrives before hydration finishes.
  useEffect(() => {
    void useAppAdvisorStore.getState().hydrateForNavigation();
  }, []);

  // Bridge managed Claude Code terminal runtime transitions into chat-tab
  // status for this window's stores. Without it, terminal/auto-mode turns
  // set a tab to `streaming` on send but never flip it back to `idle` on
  // completion (terminal turns are not broadcast as `result` ChatEvents), so
  // the chat-interface-mode toggle stays disabled until the 30s
  // `verifyStreamingTabs` safety net fires. The main window mounts the same
  // sync in `App.tsx`; each renderer context needs its own (the underlying
  // initializer is idempotent per context).
  useEffect(() => {
    const dispose = initializeClaudeTerminalChatSync();
    return dispose;
  }, []);

  // This BrowserWindow has an isolated renderer/store instance, so it must
  // hydrate and subscribe to feature flags independently of the main window.
  // Without this bridge the store keeps its LaunchDarkly-disabled defaults,
  // which makes fail-open UI such as the Claude terminal-mode toggle appear
  // even when the authoritative snapshot has disabled it.
  useEffect(() => {
    void useFeatureFlagsStore.getState().hydrate();
    const unsubscribe = window.api.featureFlags.onSnapshotChanged(
      (snapshot) => {
        useFeatureFlagsStore.getState().setSnapshot(snapshot);
      },
    );
    return unsubscribe;
  }, []);

  // Archived-containers changed subscription — this popout is a separate
  // renderer with its own store instances, so background archive expiry must
  // be wired here as well as in the main window's App.tsx (the subscription
  // helper is idempotent per renderer context).
  useEffect(() => {
    ensureArchivedContainersSubscription();
  }, []);

  // App-link requests are sent back to the renderer that originated the
  // navigation. This isolated window therefore needs its own browser-event
  // subscription just like the main renderer.
  useEffect(() => {
    ensureBrowserEventSubscription();
  }, []);

  // Apply theme/color-mode/UI-scale on mount, then keep this separate renderer
  // in immediate lockstep with the main window by re-applying on every
  // cross-window preferences broadcast. See file header for why the
  // same-renderer preference event cannot be used here. App Advisor defaults
  // (model/thinking/plugins) ride the same broadcast so quick settings
  // changes in either window stay in sync.
  useLayoutEffect(() => {
    void window.api.loadPreferences().then((prefs) => {
      applyDisplayPreferences(prefs);
      refreshInAppNotificationPrefs(prefs.inAppNotifications);
      refreshOsNotificationPrefs(prefs.osNotifications);
      useBrowserStore
        .getState()
        .setLocalServersOnly(prefs.inAppBrowserLocalServersOnly === true);
      useBrowserStore
        .getState()
        .setOpenAppLinksInBuiltInBrowser(
          prefs.openAppLinksInBuiltInBrowser === true,
        );
      useBrowserStore.getState().applySearchPreferences(prefs);
      useChatStore.getState().applyDeferredToolsDefaults(prefs);
      useChatStore.getState().applyModelDefaults(prefs);
      useAppAdvisorStore.getState().applyPreferences(prefs);
      useStandaloneChatStore.getState().applyScopedPreferences(prefs);
    });
    return window.api.onPreferencesSynced((prefs) => {
      refreshInAppNotificationPrefs(prefs.inAppNotifications);
      refreshOsNotificationPrefs(prefs.osNotifications);
      applyDisplayPreferences(prefs);
      // This BrowserWindow owns a separate renderer/store instance. Drop any
      // send-time approval defaults cached before another window changed the
      // preferences so a stale privileged mode cannot survive the broadcast.
      invalidateApprovalDefaults();
      useChatStore.setState({ approvalDefaultsCache: {} });
      useBrowserStore
        .getState()
        .setLocalServersOnly(prefs.inAppBrowserLocalServersOnly === true);
      useBrowserStore
        .getState()
        .setOpenAppLinksInBuiltInBrowser(
          prefs.openAppLinksInBuiltInBrowser === true,
        );
      useBrowserStore.getState().applySearchPreferences(prefs);
      useChatStore.getState().applyDeferredToolsDefaults(prefs);
      useChatStore.getState().applyModelDefaults(prefs);
      useAppAdvisorStore.getState().applyPreferences(prefs);
      useStandaloneChatStore.getState().applyScopedPreferences(prefs);
    });
  }, []);

  // ⌘/Ctrl+W closes the focused surface's active tab when there is one to
  // close, exactly like that tab's "X" (CAN-3952); otherwise — the layout's
  // only chat, no active panel, an archive view over the grid, the chats-only
  // floating panel, or before the scoped bootstrap — it hides App Advisor,
  // like a browser closing its window with the last tab. The application
  // menu deliberately binds no accelerator to Close Window (the main window
  // owns that chord for close-tab — see main/menu.ts), so this surface
  // handles the chord itself and hides through the same main-process path
  // as its close button.
  // Not `window.close()`: under early access this page lives in a
  // `WebContentsView` (the floating panel or the full window), where
  // `window.close()` destroys the page instead of closing a window.
  //
  // ⌘/Ctrl+T is context-aware here too (ECW-7984): this window renders the
  // same panel grid as worktrees, so the chord creates the focused surface's
  // own tab type — a new App Advisor chat by default, a terminal/browser tab
  // when that surface is focused — resolved by the shared `runNewTabShortcut`
  // against this window's active Work Entry.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      // CAN-338: on Windows/Linux, a focused terminal owns Ctrl chords such
      // as Ctrl+T. App shortcuts remain Cmd-based on macOS. As in the main
      // window, a terminal with a registered find controller takes Cmd/Ctrl+F
      // and never resolves to a sibling surface's bar.
      if (isTerminalTarget(event.target)) {
        if (isShortcutEvent(event, 'f')) {
          runFindShortcut(event, () => null);
          return;
        }
        if (event.ctrlKey && !event.metaKey) return;
      }

      // ⌘/Ctrl+F opens the floating find bar for the focused chat or browser
      // (CAN-3048). This renderer has no `useGlobalShortcuts`, so route it here.
      if (runFindShortcut(event, resolveAppAdvisorFindFallback)) {
        return;
      }

      if (isShortcutEvent(event, 'w')) {
        event.preventDefault();
        const standalone = useStandaloneChatStore.getState();
        const entryId =
          standalone.activeChatProjectId === APP_ADVISOR_PROJECT_ID
            ? standalone.activeWorkEntryId
            : null;
        // An archive view covers the grid; closing its hidden tab would
        // archive a chat the user cannot see.
        const archived = useArchivedContainersStore.getState();
        const archiveOverlayOpen =
          standalone.archiveOverlayChatId !== null ||
          selectArchivedViewerForSurface(archived.viewer, 'app-advisor') !==
            null ||
          selectArchivedOverviewWorkspaceForSurface(
            archived.overview,
            'app-advisor',
          ) !== null;
        if (
          entryId !== null &&
          !archiveOverlayOpen &&
          useAppAdvisorStore.getState().layout !== 'floating'
        ) {
          const target = {
            projectId: APP_ADVISOR_PROJECT_ID,
            worktreeId: entryId,
          };
          if (hasCloseableTabForShortcut(target)) {
            // Same path as the tab's "X": a busy chat refuses with its notice
            // and App Advisor stays visible. Do not consult the return value.
            runCloseTabShortcut(target);
            return;
          }
        }
        useAppAdvisorStore.getState().closeDialog();
        return;
      }
      if (isShortcutEvent(event, 't')) {
        event.preventDefault();
        const standalone = useStandaloneChatStore.getState();
        if (standalone.activeChatProjectId !== APP_ADVISOR_PROJECT_ID) {
          // Scoped bootstrap has not completed yet — safe no-op (the chord
          // stays consumed so it cannot fall through to anything else).
          return;
        }
        const entryId = standalone.activeWorkEntryId;
        if (entryId === null) {
          void standalone.createWorkEntry();
          return;
        }
        // Early access floating panel: it shows chats only, so the chord
        // starts a chat rather than following the panel the full layout
        // left active (a terminal, say).
        if (useAppAdvisorStore.getState().layout === 'floating') {
          void standalone.startNewChat();
          return;
        }
        runNewTabShortcut({
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: entryId,
          target: event.target,
          createChatTab: (): void => {
            void useStandaloneChatStore.getState().startNewChat();
          },
        });
        return;
      }

      const standalone = useStandaloneChatStore.getState();
      if (standalone.activeChatProjectId !== APP_ADVISOR_PROJECT_ID) {
        return;
      }
      const entryId = standalone.activeWorkEntryId;
      if (entryId === null) {
        return;
      }

      if (isShortcutEvent(event, 'l') && isBrowserSurfaceTarget(event.target)) {
        const browserId = getActiveBrowserId(entryId);
        if (browserId !== null) {
          event.preventDefault();
          requestBrowserUrlFocus(browserId);
        }
        return;
      }

      const isBrowserBackChord = isBrowserHistoryShortcutEvent(
        event,
        'ArrowLeft',
      );
      const isBrowserForwardChord = isBrowserHistoryShortcutEvent(
        event,
        'ArrowRight',
      );
      if (
        (isBrowserBackChord || isBrowserForwardChord) &&
        isBrowserSurfaceTarget(event.target) &&
        !isEditableTarget(event.target)
      ) {
        const browserId = getActiveBrowserId(entryId);
        if (browserId !== null) {
          event.preventDefault();
          const browserStore = useBrowserStore.getState();
          void (
            isBrowserBackChord
              ? window.api.browser.back({ browserId })
              : window.api.browser.forward({ browserId })
          )
            .then((snapshot) => {
              browserStore.applySnapshot(snapshot);
            })
            .catch(() => {
              // Errors surface through browser events; keep the chord claimed.
            });
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return (): void => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  // Subscribe to the authoritative window-state broadcast from the main
  // process. Do NOT assume `open: true` at mount time — `ensureWindow`
  // creates this BrowserWindow hidden, so visibility must come from
  // `getWindowState()` + `onWindowStateChanged`. Unread clearing keys on
  // focus, so a visible-but-blurred window still accrues unread activity.
  useEffect(() => {
    void window.api.appAdvisor.getWindowState().then((state) => {
      useAppAdvisorStore.getState().syncWindowState(state);
    });
    const off = window.api.appAdvisor.onWindowStateChanged((state) => {
      useAppAdvisorStore.getState().syncWindowState(state);
    });
    return off;
  }, []);

  // Handle one-way commands from the main process (audit transcript
  // follow-through and quick prompt send). A fired watcher is not one of
  // them: main delivers it straight into the chat queue. Quick prompts are
  // intentionally non-idempotent. Distinct commands preserve their delivery
  // order through a single in-renderer promise queue. `initializeScoped` is
  // the first step of every command: it is idempotent, so commands queued
  // during initialization still execute exactly once and in order after the
  // scoped workspace is ready.
  useEffect(() => {
    const off = window.api.appAdvisor.onWindowCommand((command) => {
      commandQueueRef.current = commandQueueRef.current
        .catch(() => undefined)
        .then(async (): Promise<void> => {
          const standaloneStore = useStandaloneChatStore.getState();
          await standaloneStore.initializeScoped(APP_ADVISOR_PROJECT_ID);
          if (command.type === 'select_chat') {
            // Resolves the owning Work Entry through the Work Entries IPC and
            // selects entry + tab (archived chats open their transcript).
            const selected = await useStandaloneChatStore
              .getState()
              .selectChat(command.chatId);
            if (!selected) return;
            const entryId = useStandaloneChatStore.getState().activeWorkEntryId;
            if (entryId !== null) {
              if (command.delegationId !== undefined) {
                const opened = await openSubagentChatPanel(
                  { projectId: APP_ADVISOR_PROJECT_ID, worktreeId: entryId },
                  {
                    rootChatId: command.chatId,
                    subagentId: command.delegationId,
                    subagentKind: 'managed',
                    title: '',
                  },
                );
                if (
                  opened.status !== 'placed' &&
                  opened.status !== 'revealed'
                ) {
                  requestChatPanelReveal(
                    APP_ADVISOR_PROJECT_ID,
                    entryId,
                    command.chatId,
                  );
                }
              } else {
                requestChatPanelReveal(
                  APP_ADVISOR_PROJECT_ID,
                  entryId,
                  command.chatId,
                );
              }
            }
            if (command.userMessageId) {
              // A renderer store value cannot cross the window boundary, so
              // the turn target arrives on the IPC command and is re-raised
              // here for this window's `ChatMessageList` to consume.
              useNavigationStore.getState().openChatTurn({
                projectId: APP_ADVISOR_PROJECT_ID,
                chatId: command.chatId,
                userMessageId: command.userMessageId,
              });
            }
            return;
          }
          if (command.type === 'select_entry') {
            await useStandaloneChatStore
              .getState()
              .selectWorkEntry(command.entryId);
            // Selection landed — dismiss the archived viewer last so a
            // restore reads as one transition (no flash of the grid behind).
            useArchivedContainersStore.getState().closeViewer();
            return;
          }
          if (command.type === 'open_archived_container') {
            // The viewer's state lives in THIS window's store — cross-window
            // entry points (Cmd+K, archived.* actions) route here via the
            // window-open request instead of mutating their own instance.
            useStandaloneChatStore.getState().closeArchiveOverlay();
            useArchivedContainersStore
              .getState()
              .openViewer(APP_ADVISOR_PROJECT_ID, command.containerId, {
                ...(command.tab !== undefined ? { tab: command.tab } : {}),
                ...(command.chatId !== undefined
                  ? { chatId: command.chatId }
                  : {}),
                ...(command.planId !== undefined
                  ? { planId: command.planId }
                  : {}),
              });
            return;
          }
          if (command.type === 'open_archived_overview') {
            // Archive state is renderer-local. Cross-window requests must land
            // in this popout before opening either the overview or its
            // user-owned destructive confirmation.
            useStandaloneChatStore.getState().closeArchiveOverlay();
            const archivedStore = useArchivedContainersStore.getState();
            archivedStore.closeViewer();
            archivedStore.openOverview(APP_ADVISOR_PROJECT_ID);
            let confirmationOpened = false;
            if (command.openEmptyTrashConfirmation === true) {
              await archivedStore.loadForWorkspace(APP_ADVISOR_PROJECT_ID, {
                trailing: true,
                strict: true,
              });
              const refreshedArchiveState =
                useArchivedContainersStore.getState();
              const hasDeletedItems = (
                refreshedArchiveState.byWorkspace[APP_ADVISOR_PROJECT_ID] ?? []
              ).some((entry) => entry.lockedAt === undefined);
              if (
                refreshedArchiveState.emptyTrashRun === null &&
                hasDeletedItems
              ) {
                useArchivedContainersStore
                  .getState()
                  .requestEmptyTrashConfirmation(APP_ADVISOR_PROJECT_ID);
                confirmationOpened = true;
              }
            }
            if (command.requestId !== undefined) {
              useArchivedContainersStore
                .getState()
                .recordArchivedOverviewRequest({
                  requestId: command.requestId,
                  confirmationOpened,
                });
            }
            return;
          }
          if (command.type === 'new_entry') {
            await startAppAdvisorNewEntry();
            return;
          }
          if (command.type === 'open_settings') {
            setSettingsOpen(true);
            return;
          }
          if (command.type === 'focus_composer') {
            requestAnimationFrame(() => {
              document.dispatchEvent(
                new CustomEvent('canopy:focus-chat-input'),
              );
            });
            return;
          }
          if (command.type === 'send_quick_prompt') {
            // A quick prompt opens a new chat in the Work Entry main chose
            // for it: one created for the prompt (the main-side create
            // dedupes truly empty entries) or an existing entry an automation
            // targeted. The pre-assigned chat id is preserved so follow-up UI
            // state can link to it.
            await useStandaloneChatStore
              .getState()
              .createWorkEntryChatWithMessage({
                chatId: command.chatId,
                entryId: command.entryId,
                removeEntryOnFailure: command.removeEntryOnFailure,
                replaceActiveEmpty: command.replaceActiveEmpty,
                title: command.title,
                message: command.text,
                config: {
                  model: command.model,
                  planMode: command.planMode,
                  fileReferences: command.fileReferences,
                  modelConfig: command.modelConfig,
                  thinkingLevel: command.thinkingLevel,
                  providerType: command.providerType,
                  pluginSelections: command.pluginSelections,
                  ...(command.approvalMode
                    ? { approvalMode: command.approvalMode }
                    : {}),
                },
                sendOptions: {
                  initiationSource: command.initiationSource,
                  automationName: command.automationName,
                  userMessageId: command.userMessageId,
                  planMode: command.planMode,
                  ...(command.packageOverlay
                    ? { packageOverlay: command.packageOverlay }
                    : {}),
                },
              });
            return;
          }
        });
    });
    void window.api.appAdvisor
      .markWindowRendererReady()
      .then((state) => {
        useAppAdvisorStore.getState().syncWindowState(state);
      })
      .catch(() => undefined);
    return off;
  }, []);

  return (
    <div
      className={`flex h-screen w-screen flex-col overflow-hidden fg-primary ${floating || docked ? 'bg-transparent' : 'bg-base'}`}
    >
      <AppAdvisorWindowRuntimeBridge />
      {/* App Advisor's chat sits on its own raised panel, so its user
          bubbles are flat and muted; docked, it is a normal chat page. */}
      <MutedUserBubblesContext.Provider value={!docked}>
        <AgentSentSenderOpenerProvider opener={appAdvisorWindowSenderOpener}>
          <AppAdvisorWorkspaceSurface
            settingsModalOpen={settingsOpen}
            onOpenSettings={(): void => setSettingsOpen(true)}
          />
        </AgentSentSenderOpenerProvider>
      </MutedUserBubblesContext.Provider>
      <UsageLimitResumeModal />
      <SurfaceFindHost />
      {/* No-drag like the main window's corner (CAN-5711): a drag region
          under a notification would take its clicks. */}
      <div
        className={`electron-no-drag ${getInAppNotificationContainerClasses(
          notificationPlacement,
          {
            // The notification stack starts top corners below the header.
            clearHeader: true,
          },
        )}`}
        // The corner's own `z-toast` class must not freeze a Browser page
        // under it: the slot below decides for its toasts.
        data-canopy-browser-native-overlay="false"
      >
        {/* Over a live Browser page the toasts move into a native overlay
            layer above it, so the page keeps running under them. */}
        <OverlayLayerSlot
          slot="notifications"
          placement={notificationPlacement}
        >
          <ToastContainer placement={notificationPlacement} />
        </OverlayLayerSlot>
      </div>
      <ResumeQueueModal />
      {settingsOpen && (
        <AppAdvisorSettingsModal onClose={(): void => setSettingsOpen(false)} />
      )}
    </div>
  );
}
