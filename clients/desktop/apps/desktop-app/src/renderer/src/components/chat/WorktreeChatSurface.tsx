import { ComposerWorkDrawerProvider } from './composer-work-drawer-context';
import { useScopeCapabilities } from '@/hooks/useScopeCapabilities';
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  type JSX,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  ChatPanel as SharedChatPanel,
  type ChatComposerHostControls,
  type ChatTranscriptHostControls,
} from '@canopy/ui-app/chat-panel';
import { useChatStore as useSharedChatStore } from '@canopy/app-state';
import { projectPersistedChatTranscript } from '@canopy/desktop-shared/portal/persisted-chat-projection';
import {
  APP_ADVISOR_PROJECT_ID,
  type AppAdvisorJson,
  type WorktreeSelection,
} from '@canopy/desktop-shared/types';
import { useChatStore } from '@/stores/chatStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { usePanelOwnerDocument } from '@/lib/panels/panel-owner-document';
import { useCanopyDesktopSuggestedPromptsEnabled } from '@/hooks/useCanopyDesktopSuggestedPromptsEnabled';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { createEmptySelections } from '@/lib/pluginSelections';
import { useResolvedChatPluginSelections } from '@/hooks/useResolvedChatPluginSelections';
import {
  INSERT_CHAT_TEXT_EVENT,
  type InsertChatTextDetail,
} from '@/lib/editorSelectionContext';
import { SuggestedPromptChips } from '@/components/suggestions/SuggestedPromptChips';
import { useSuggestedPrompts } from '@/components/suggestions/useSuggestedPrompts';
import { isCoworkChatTarget } from '@/lib/cowork';
import { isWebCoreScope } from '@/lib/chat-authority';
import { useWorkspaceIsReadOnly } from '@/lib/workspace-access';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useBlueprintCatalog } from '@/hooks/useBlueprintCatalog';
import { ChatInterfaceModeToggle } from './ChatInterfaceModeToggle';
import type { ChatInterfaceModeControl } from './chatInterfaceModes';
import { ClaudeTerminalForkButton } from './ClaudeTerminalForkButton';
import { ChatWatcherButton } from '@/components/watchers/ChatWatcherButton';
import { ClaudeCodeTerminalExperience } from './ClaudeCodeTerminalExperience';
import { ClaudeTerminalApprovalDock } from './ClaudeTerminalApprovalDock';
import { ChatContent } from './ChatContent';
import { ChatInput } from './ChatInput';
import { TryItSetupPaneHost } from './TryItSetupPaneHost';
import { extractUserMessageHistory } from './message-history';
import type { ActiveComposerView, ActiveTranscriptView } from './types';
import { useWorktreeChatTabSurfaceState } from './useWorktreeChatSurfaceState';
import { useQueuedMessageComposerEditor } from './useQueuedMessageComposerEditor';
import { SHARED_CHAT_TRANSCRIPT_PROJECTION_ENABLED } from './shared-chat-projection-gate';
import { markSuggestedPromptInserted } from '@/lib/chatMessageSendTelemetry';

const NO_PROJECTED_MESSAGES: ReturnType<typeof projectPersistedChatTranscript> =
  [];

interface WorktreeChatSurfaceProps {
  /** The chatStore tab this surface renders (the panel's instance binding). */
  chatTabId: string;
  /** Owning worktree for popped-out panels; falls back to global selection. */
  worktreeSelection?: WorktreeSelection | null;
  /**
   * Whether the hosting panel is currently shown (selected tab of a visible
   * group). Gates the managed Claude Code terminal mount: mounting it spawns
   * a terminal via `ensureClaudeTerminal`, which must not happen for hidden
   * panels (parity with the old active-tab-only surface).
   */
  visible: boolean;
  /**
   * Whether the hosting panel is the active panel of the active group (at most
   * one in the whole layout). Forwarded to `ChatContent` so the Cmd/Ctrl+F
   * search shortcut only opens the search tray on the focused chat panel.
   */
  isActivePanel: boolean;
  /**
   * Whether the hosting panel is on screen (the selected tab of a visible
   * group), active or not. Forwarded to `ChatContent` so a shown chat beside
   * the active browser group still registers with the floating find bar.
   * Defaults to `isActivePanel`.
   */
  isVisiblePanel?: boolean;
  /**
   * Host content for a chat with no messages, at the bottom of the empty
   * transcript above the composer (the floating App Advisor's recent chats).
   */
  emptyStateCenter?: ReactNode;
}

/**
 * ONE chat tab's surface: (ClaudeCodeTerminalExperience | ChatContent) for
 * the bound tab, with the interface-mode toggle. No PrStatusBar (lives in
 * `WorktreeTopBar`), no ChatTabBar (panel tabs replace it), no
 * FileViewerPanelHost (file tabs are their own `file-diff` panels).
 *
 * Every derivation and dispatched action is parameterized by `chatTabId` via
 * {@link useWorktreeChatTabSurfaceState}: the composer routes sends through
 * `targetOverride`, so a visible-but-non-focused chat panel still sends to
 * its OWN tab. (The chat ⇄ panel sync bridge makes the focused panel's tab
 * the chat store's active tab, so residual active-tab store paths agree with
 * the focused panel.)
 *
 * Renders a fragment (no wrapper element) so the panel registry's `chat`
 * wrapper owns the containing flex-column. Renders null when no worktree is
 * selected or the bound tab is gone — the registry wrapper provides the
 * empty states.
 */
export const WorktreeChatSurface = memo(function WorktreeChatSurface({
  chatTabId,
  worktreeSelection,
  visible,
  isActivePanel,
  isVisiblePanel = isActivePanel,
  emptyStateCenter: hostEmptyStateCenter,
}: WorktreeChatSurfaceProps): JSX.Element | null {
  const {
    selectedWorktree,
    tabExists,
    isActiveTab,
    transcript,
    composerTab,
    interfaceContext,
    claudeTerminalRuntime,
    claudeTerminalTurnState,
    claudeTerminalActiveTurn,
    terminalBusy,
    isClaudeCodeChatMode,
    chatActiveTabReport,
    scheduledMessages,
    editingScheduledId,
    setEditingScheduledId,
    runningScheduledId,
    scheduledMessageError,
    handleResetToPoint,
    handleClearQueuedMessage,
    handleForceQueuedMessage,
    handleEditQueuedMessage,
    handleSaveQueuedMessage,
    handleSaveScheduledMessage,
    handleClearScheduledMessage,
    handleInterruptScheduledMessage,
  } = useWorktreeChatTabSurfaceState(chatTabId, worktreeSelection);
  // Read-only scopes (a shared-container recipient) render the same transcript
  // with nothing that sends or acts on a turn: no composer, no interface-mode
  // toggle, and no managed Claude Code terminal (mounting one spawns a PTY).
  const readOnly = useWorkspaceIsReadOnly();
  const terminalMode = isClaudeCodeChatMode && !readOnly;
  // This renderer is reused for synthetic assistant scopes and Cowork entries.
  // A real Code worktree, a Cowork Work Entry, and the App Advisor may opt
  // into the Cursor harness; every other scope keeps Cursor out of its picker.
  const selectedProjectId = selectedWorktree?.projectId;
  const { chatInterfaceModes, chatQueueEdits, chatResetToPoint, chatTabFork } =
    useScopeCapabilities({
      projectId: selectedProjectId ?? '',
    });
  const allowCursor = useProjectsStore(
    (state) =>
      selectedProjectId === APP_ADVISOR_PROJECT_ID ||
      (selectedProjectId !== undefined &&
        isCoworkChatTarget(selectedProjectId)) ||
      state.projects.some(
        (project) =>
          project.id === selectedProjectId &&
          project.type !== 'cowork' &&
          project.worktrees.some(
            (worktree) => worktree.id === selectedWorktree?.worktreeId,
          ),
      ),
  );
  const setChatInterfaceMode = useChatStore((s) => s.setChatInterfaceMode);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const cancelSession = useChatStore((s) => s.cancelSession);
  const cancelShortcutTargetRootRef = useRef<HTMLDivElement | null>(null);
  const cancelShortcutOwnerDocument = usePanelOwnerDocument();
  const userMessageHistory = useMemo(
    () => extractUserMessageHistory(transcript?.messages ?? []),
    [transcript?.messages],
  );
  // The queued or scheduled message being edited takes the composer's place
  // in the shared panel (CAN-3607).
  const queuedMessageEditor = useQueuedMessageComposerEditor({
    queuedMessages: transcript?.queuedMessages,
    editingQueuedMessageIndex: transcript?.editingQueuedMessageIndex,
    autoFocus: transcript?.editingQueuedMessageFocusAllowed,
    ...(readOnly
      ? {}
      : {
          onCancelEditQueuedMessage: (): void => handleEditQueuedMessage(null),
          onSaveEditQueuedMessage: handleSaveQueuedMessage,
          onCancelEditScheduledMessage: (): void => setEditingScheduledId(null),
          onSaveEditScheduledMessage: handleSaveScheduledMessage,
        }),
    scheduledMessages,
    editingScheduledMessageId: editingScheduledId,
    composerTab,
    scheduleEnabled: true,
  });

  // Recurring automations surface as a composer notice, not transcript
  // content, so only one-time sends keep the chat out of its empty state
  // (same rule as ChatContent).
  const transcriptEmpty =
    !transcript ||
    (transcript.messages.length === 0 &&
      transcript.queuedMessages.length === 0 &&
      !scheduledMessages.some(
        (scheduled) => scheduled.scheduleKind === 'one_time',
      ));
  const suggestedPromptsFlagEnabled = useCanopyDesktopSuggestedPromptsEnabled();
  // Live draft gate: suggestions are an empty-state affordance and must not
  // stay clickable (appending to the draft) while the user is typing.
  const composerHasText = useChatStore(
    (s) => s.composerTextPresent[chatTabId] === true,
  );
  const isCoworkChat = isCoworkChatTarget(selectedWorktree?.projectId ?? '');
  const resolvedSelections = useResolvedChatPluginSelections(
    selectedWorktree?.projectId ?? null,
    selectedWorktree?.worktreeId ?? null,
    chatTabId,
  );
  // Cowork projects are not git-backed, so the code-flavored `chat` pool is
  // wrong for them (CAN-2964 §8). The `cowork` surface carries an
  // outcome-flavored pool instead, and a project that owns starter prompts
  // (seeded from a Blueprint, or edited in its settings) tops up from those.
  const coworkProjectId = isCoworkChatTarget(selectedWorktree?.projectId ?? '')
    ? (selectedWorktree?.projectId ?? null)
    : null;
  const coworkProject = useStandaloneChatStore((state) =>
    coworkProjectId === null
      ? undefined
      : state.chatProjects.find((project) => project.id === coworkProjectId),
  );
  const projectStarterPrompts = coworkProject?.starterPrompts;
  const seededFromBlueprintExternalId =
    coworkProject?.seededFromBlueprintExternalId;
  // Read the cached template's starter prompts when the project owns none.
  const blueprintCatalog = useBlueprintCatalog(
    coworkProjectId !== null && seededFromBlueprintExternalId !== undefined,
  );
  const seedingBlueprint =
    seededFromBlueprintExternalId === undefined
      ? undefined
      : blueprintCatalog.blueprints.find(
          (blueprint) => blueprint.externalId === seededFromBlueprintExternalId,
        );
  const seedingBlueprintStarterPrompts =
    seedingBlueprint?.document.starterPrompts;
  const suggestionsEnabled =
    suggestedPromptsFlagEnabled &&
    !readOnly &&
    isCoworkChat &&
    !composerHasText &&
    Boolean(selectedWorktree) &&
    selectedWorktree?.projectId !== APP_ADVISOR_PROJECT_ID &&
    !isClaudeCodeChatMode &&
    transcriptEmpty &&
    // Hidden panels must not fetch inventory or record impressions; the
    // hidden -> visible flip also refetches so eligibility picks up MCP
    // auth changes made elsewhere.
    visible;
  // `null` is reserved for excluded/hidden surfaces; enabled chats without
  // any configured selections still get the generic fallback prompts.
  const { prompts: suggestedPrompts } = useSuggestedPrompts(
    suggestionsEnabled ? (resolvedSelections ?? createEmptySelections()) : null,
    {
      surface: coworkProjectId === null ? 'chat' : 'cowork',
      seedKey: chatTabId,
      // A cloud chat's MCP servers are its cloud account's, not this
      // computer's: it takes the cowork pool (CAN-6175 R5).
      localInventory: !isWebCoreScope(selectedWorktree?.projectId ?? ''),
      ...(coworkProjectId === null
        ? {}
        : {
            starterPrompts: projectStarterPrompts,
            seedingBlueprintStarterPrompts,
          }),
    },
  );

  // The composer is memoized, and the surface re-renders on every update of
  // its chat, so both objects keep their identity while their values hold.
  const targetProjectId = selectedWorktree?.projectId;
  const targetWorktreeId = selectedWorktree?.worktreeId;
  const targetOverride = useMemo(
    () =>
      targetProjectId === undefined || targetWorktreeId === undefined
        ? undefined
        : {
            projectId: targetProjectId,
            worktreeId: targetWorktreeId,
            chatId: chatTabId,
          },
    [targetProjectId, targetWorktreeId, chatTabId],
  );
  const canopyNativeBusy = composerTab?.status === 'streaming';
  // The chat's interface modes: the composer offers them in its + menu, and
  // the terminal surface floats a toggle to switch back.
  const interfaceModeControl = useMemo(
    (): ChatInterfaceModeControl | undefined =>
      !readOnly &&
      chatInterfaceModes === true &&
      interfaceContext?.providerIsClaude &&
      targetProjectId !== undefined &&
      targetWorktreeId !== undefined
        ? {
            mode: interfaceContext.interfaceMode,
            onChange: (next): void => {
              void setChatInterfaceMode(interfaceContext.chatId, next, {
                projectId: targetProjectId,
                worktreeId: targetWorktreeId,
              });
            },
            providerIsClaude: interfaceContext.providerIsClaude,
            canopyNativeBusy,
            claudeTerminalTurnState,
            claudeTerminalBusy: terminalBusy,
          }
        : undefined,
    [
      chatInterfaceModes,
      readOnly,
      interfaceContext,
      targetProjectId,
      targetWorktreeId,
      setChatInterfaceMode,
      canopyNativeBusy,
      claudeTerminalTurnState,
      terminalBusy,
    ],
  );

  if (!selectedWorktree || !tabExists) {
    return null;
  }

  return (
    <>
      {isActiveTab && chatActiveTabReport !== null && (
        <ActiveChatTabUiStateReporter value={chatActiveTabReport} />
      )}
      {/* A row so a Try it authorization pane can sit beside the chat column
          in either layout without touching the composer stack. It is also the
          size container the pane measures to cover the column when narrow. */}
      <div className="@container/try-it relative flex min-h-0 min-w-0 flex-1">
        {terminalMode &&
        composerTab?.queuedHookPlaceholder !== true &&
        interfaceContext ? (
          <div
            ref={cancelShortcutTargetRootRef}
            className="relative flex min-h-0 min-w-0 flex-1 flex-col"
          >
            {/* The terminal's own box, so the floating toggle stays over the
                terminal rather than the approval card below it. */}
            <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
              {/* Floating mode toggle stays pinned to the lower-right corner of
                the terminal surface (the Canopy display surface instead docks it
                into the composer next to the send button). */}
              <div className="pointer-events-none absolute right-3 bottom-2 z-20 flex items-center gap-2">
                {claudeTerminalRuntime?.sdkSessionId ? (
                  <div className="pointer-events-auto flex items-center gap-1 rounded-lg bg-card/95 p-1 shadow-sm backdrop-blur pointer-coarse:gap-4">
                    {claudeTerminalActiveTurn && (
                      <ChatWatcherButton
                        projectId={selectedWorktree.projectId}
                        worktreeId={selectedWorktree.worktreeId}
                        chatId={interfaceContext.chatId}
                      />
                    )}
                    {chatTabFork === true && (
                      <ClaudeTerminalForkButton
                        projectId={selectedWorktree.projectId}
                        worktreeId={selectedWorktree.worktreeId}
                        chatId={interfaceContext.chatId}
                        sdkSessionId={claudeTerminalRuntime.sdkSessionId}
                      />
                    )}
                  </div>
                ) : null}
                <div className="pointer-events-auto">
                  <ChatInterfaceModeToggle
                    mode={interfaceContext.interfaceMode}
                    onChange={(next): void => {
                      void setChatInterfaceMode(interfaceContext.chatId, next, {
                        projectId: selectedWorktree.projectId,
                        worktreeId: selectedWorktree.worktreeId,
                      });
                    }}
                    providerIsClaude={interfaceContext.providerIsClaude}
                    canopyNativeBusy={composerTab?.status === 'streaming'}
                    claudeTerminalTurnState={claudeTerminalTurnState}
                    claudeTerminalBusy={terminalBusy}
                    floating
                  />
                </div>
              </div>
              {visible ? (
                <ClaudeCodeTerminalExperience
                  projectId={selectedWorktree.projectId}
                  worktreeId={selectedWorktree.worktreeId}
                  chatId={interfaceContext.chatId}
                  isActivePanel={isActivePanel}
                  cancelShortcutOwnerDocument={cancelShortcutOwnerDocument}
                  cancelShortcutTargetRootRef={cancelShortcutTargetRootRef}
                  // App Advisor entry chats keep App Advisor assistant mode in
                  // the managed-terminal runtime, matching the native send path.
                  assistantMode={
                    selectedWorktree.projectId === APP_ADVISOR_PROJECT_ID
                      ? 'app-advisor'
                      : undefined
                  }
                />
              ) : null}
            </div>
            <ClaudeTerminalApprovalDock
              projectId={selectedWorktree.projectId}
              worktreeId={selectedWorktree.worktreeId}
              chatId={interfaceContext.chatId}
              terminalId={claudeTerminalRuntime?.terminalId}
              ownerDocument={cancelShortcutOwnerDocument}
            />
          </div>
        ) : (
          <div
            ref={cancelShortcutTargetRootRef}
            // The whole chat takes dropped files (see ChatDropOverlay).
            data-chat-drop-zone
            className="relative flex min-h-0 min-w-0 flex-1 flex-col"
          >
            {/* The Claude interface modes live in the composer's + menu (via
              ChatContent's interfaceModeControl) rather than floating over
              the transcript. */}
            <ComposerWorkDrawerProvider>
              <DesktopSharedChatPanelBridge
                chatId={chatTabId}
                selectedWorktree={selectedWorktree}
                transcript={transcript}
                composerTab={composerTab}
                onSend={(text): void => {
                  void sendMessage(text, undefined, targetOverride);
                }}
                onStop={(): void => {
                  void cancelSession(targetOverride);
                }}
                hostQueuedMessageEditor={queuedMessageEditor}
                renderTranscript={() => (
                  <ChatContent
                    allowCursor={allowCursor}
                    transcript={transcript}
                    composerTab={composerTab}
                    targetOverride={targetOverride}
                    nativeSessionComposer
                    hideComposer
                    hideBranchActions={readOnly}
                    searchShortcutActive={isActivePanel}
                    findSurfaceVisible={isVisiblePanel}
                    interfaceModeControl={interfaceModeControl}
                    // A projected published chat carries no queue; the required
                    // clear handler stays wired, every other turn action is off.
                    onClearQueuedMessage={handleClearQueuedMessage}
                    {...(readOnly || chatQueueEdits !== true
                      ? {}
                      : {
                          onForceQueuedMessage: handleForceQueuedMessage,
                          onEditQueuedMessage: handleEditQueuedMessage,
                        })}
                    {...(readOnly || chatResetToPoint !== true
                      ? {}
                      : { onResetToPoint: handleResetToPoint })}
                    scheduledMessages={scheduledMessages}
                    onEditScheduledMessage={setEditingScheduledId}
                    onClearScheduledMessage={handleClearScheduledMessage}
                    onInterruptScheduledMessage={
                      handleInterruptScheduledMessage
                    }
                    editingScheduledMessageId={editingScheduledId}
                    runningScheduledMessageId={runningScheduledId}
                    scheduledMessageError={scheduledMessageError}
                    emptyStateCenter={hostEmptyStateCenter}
                    emptyStateSuggestions={
                      suggestionsEnabled && suggestedPrompts.length > 0 ? (
                        <SuggestedPromptChips
                          prompts={suggestedPrompts}
                          surface={coworkProjectId === null ? 'chat' : 'cowork'}
                          onSelect={(prompt): void => {
                            const detail: InsertChatTextDetail = {
                              text: prompt.text,
                              targetTabId: chatTabId,
                            };
                            document.dispatchEvent(
                              new CustomEvent(INSERT_CHAT_TEXT_EVENT, {
                                detail,
                              }),
                            );
                            markSuggestedPromptInserted(chatTabId);
                          }}
                        />
                      ) : undefined
                    }
                  />
                )}
                renderComposer={() =>
                  readOnly ? null : (
                    <ChatInput
                      allowCursor={allowCursor}
                      tab={composerTab}
                      userMessageHistory={userMessageHistory}
                      interfaceModeControl={interfaceModeControl}
                      targetOverride={targetOverride}
                      nativeSessionComposer
                      composerShortcutsEnabled={isActivePanel}
                      cancelShortcutOwnerDocument={cancelShortcutOwnerDocument}
                      cancelShortcutTargetRootRef={cancelShortcutTargetRootRef}
                    />
                  )
                }
              />
            </ComposerWorkDrawerProvider>
          </div>
        )}
        <TryItSetupPaneHost
          projectId={selectedWorktree.projectId}
          worktreeId={selectedWorktree.worktreeId}
          chatId={chatTabId}
          visible={visible}
        />
      </div>
    </>
  );
});

interface DesktopSharedChatPanelBridgeProps {
  chatId: string;
  selectedWorktree: WorktreeSelection;
  transcript: ActiveTranscriptView | null;
  composerTab: ActiveComposerView | null;
  onSend: (text: string) => void;
  onStop: () => void;
  hostQueuedMessageEditor: ReactElement | null;
  renderTranscript: (controls: ChatTranscriptHostControls) => ReactNode;
  renderComposer: (controls: ChatComposerHostControls) => ReactNode;
}

/**
 * Desktop host adapter for the shared store-backed panel shell. Kept as a
 * child so terminal-mode and empty surfaces do not instantiate a shared store
 * unnecessarily; the app-level provider owns this component in production.
 */
export function DesktopSharedChatPanelBridge({
  chatId,
  selectedWorktree,
  transcript,
  composerTab,
  onSend,
  onStop,
  hostQueuedMessageEditor,
  renderTranscript,
  renderComposer,
}: DesktopSharedChatPanelBridgeProps): JSX.Element {
  // Zustand actions are closure-based and never use `this`; selecting the
  // stable action reference avoids re-running the hydration effect per render.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const hydrateSharedThread = useSharedChatStore((s) => s.hydrate);
  // Gated off (see `shared-chat-projection-gate.ts`): nothing on this host
  // renders the shared transcript, so a transcript change must not re-project
  // or re-hydrate it. `projectionSource` is undefined while gated, which also
  // keeps the hydration effect below from re-running per transcript change.
  const projectionSource = SHARED_CHAT_TRANSCRIPT_PROJECTION_ENABLED
    ? transcript?.messages
    : undefined;
  const projectedMessages = useMemo(
    () =>
      !SHARED_CHAT_TRANSCRIPT_PROJECTION_ENABLED
        ? NO_PROJECTED_MESSAGES
        : projectPersistedChatTranscript({
            scope: 'worktree',
            workspaceLocalId: selectedWorktree.projectId,
            worktreeLocalId: selectedWorktree.worktreeId,
            chatId,
            messages: projectionSource ?? [],
            // Deliberately the wire-fidelity projection for now: `fidelity:
            // 'local'` (the whole transcript, untruncated) is what the shared
            // transcript will render from, but this bridge re-projects the
            // entire transcript on every change and nothing on this host
            // renders the shared transcript yet. A matched perf run showed the
            // local projection alone costing +50% on large-transcript chat
            // switches and +85MB working set, so it lands with incremental
            // hydration in the transcript slice's final PR, not before.
          }),
    [
      chatId,
      selectedWorktree.projectId,
      selectedWorktree.worktreeId,
      projectionSource,
    ],
  );
  const sharedThinkingLevel = composerTab?.thinkingLevel ?? 'high';

  useEffect(() => {
    hydrateSharedThread(chatId, projectedMessages, {
      // While gated, hydrate only status, route and settings: an empty,
      // non-replacing message list leaves the thread's messages untouched.
      replaceMessages: SHARED_CHAT_TRANSCRIPT_PROJECTION_ENABLED,
      status: composerTab?.status ?? 'idle',
      error: composerTab?.error ?? null,
      turnActive: composerTab?.status === 'streaming',
      route: {
        scope: 'worktree',
        workspaceLocalId: selectedWorktree.projectId,
        worktreeLocalId: selectedWorktree.worktreeId,
      },
      settings: {
        planMode: composerTab?.planMode ?? false,
        proposalMode: composerTab?.proposalMode ?? 'optional',
        thinkingLevel: sharedThinkingLevel,
        pendingPlanExit: composerTab?.pendingPlanExit,
      },
    });
  }, [
    chatId,
    composerTab?.error,
    composerTab?.pendingPlanExit,
    composerTab?.planMode,
    composerTab?.proposalMode,
    composerTab?.status,
    hydrateSharedThread,
    projectedMessages,
    selectedWorktree.projectId,
    selectedWorktree.worktreeId,
    sharedThinkingLevel,
  ]);

  return (
    <SharedChatPanel
      chatId={chatId}
      providerType={composerTab?.providerType}
      // Desktop keeps its text-only `onSend`: deliberately discard the shared
      // panel's `ChatPanelSendContext` (CAN-1429) so desktop send state, native
      // optimistic user/timer insertion, and error handling are unchanged and
      // never depend on portal rollback semantics.
      onSend={(text): void => {
        onSend(text);
      }}
      onStop={onStop}
      hostQueuedMessageEditor={hostQueuedMessageEditor}
      renderTranscript={renderTranscript}
      renderComposer={renderComposer}
    />
  );
}

/**
 * Single-owner `chat.activeTab` slice reporter: mounted ONLY by the surface
 * whose bound tab is the chat store's active tab. Ownership handoff on tab
 * switches is safe because within one React commit the outgoing instance's
 * unmount cleanup (which clears the slice) runs before the incoming
 * instance's mount effect (which writes it).
 */
function ActiveChatTabUiStateReporter({
  value,
}: {
  value: AppAdvisorJson;
}): null {
  useCurrentUiStateReporter('chat.activeTab', value);
  return null;
}
