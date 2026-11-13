import {
  Surface,
  ComposerTrayProvider,
  TranscriptPagingControls,
  ErrorBanner,
} from '@canopy/ui-shared/components';
import { estimateTranscriptWindowBytes } from '@canopy/agent-transcript/transcript-storage';
import {
  loadChatTranscriptPage,
  needsNewestTranscriptPage,
  TRANSCRIPT_PAGE_LOAD_ERROR,
} from '@/stores/chat/transcript-pages';
import { useChatTranscriptResidency } from '@/stores/chat/transcript-residency-host';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import type {
  ChatAttachmentPromptContext,
  FileReference,
} from '@canopy/desktop-shared/types';
import { useChatStore, type QueuedChatMessage } from '@/stores/chatStore';
import { hasPendingApprovalForChat } from '@/stores/chat/pending-approvals';
import { useShallow } from 'zustand/react/shallow';
import { QueuedEditComposerSlot } from '@canopy/ui-app/chat-panel';
import { ChatInput } from './ChatInput';
import { ChatStateRecoveryBanner } from './ChatStateRecoveryBanner';
import { ComposerWorkDrawerProvider } from './composer-work-drawer-context';
import { StaleTranscriptCatchUpControls } from './StaleTranscriptCatchUpControls';
import { LoadingSpinner } from '../shared/loading/spinners/LoadingSpinner';
import { useTranscriptSearch } from '@/hooks/useTranscriptSearch';
import { useScopeCapabilities } from '@/hooks/useScopeCapabilities';
import { useContentSearch } from '@/hooks/useContentSearch';
import { createDomSearchExecutor } from '@/lib/dom-search-highlight';
import { getSavedChatScrollPosition } from '@/lib/tab-scroll-positions';
import {
  useSurfaceFindStore,
  type FindController,
} from '@/stores/surfaceFindStore';
import { usePanelHostState } from '@/lib/panels/panel-host-context';
import type { SearchExecutor } from '@/components/shared/search/search-types';
import type { ActiveComposerView, ActiveTranscriptView } from './types';
import type { ScheduledQueuedMessage } from '@/lib/worktreeSessionPromptAutomations';
import { extractUserMessageHistory } from './message-history';
import { useQueuedMessageComposerEditor } from './useQueuedMessageComposerEditor';
import { useWorkspaceIsReadOnly } from '@/lib/workspace-access';
import type { ChatInterfaceModeControl } from './chatInterfaceModes';
import {
  loadChatMessageListModule,
  loadedChatMessageListModule,
} from './chatMessageListChunk';

const LazyChatMessageList = lazy(() =>
  loadChatMessageListModule().then((m) => ({ default: m.ChatMessageList })),
);

// ---------------------------------------------------------------------------
// Chat content area (reused by ChatPanel/WorktreeChatSurface and
// StandaloneChatPage)
// ---------------------------------------------------------------------------

interface ChatContentProps {
  transcript: ActiveTranscriptView | null;
  composerTab: ActiveComposerView | null;
  onClearQueuedMessage: (index: number) => void;
  onForceQueuedMessage?: (index: number) => void;
  onEditQueuedMessage?: (index: number, message?: QueuedChatMessage) => void;
  onCancelEditQueuedMessage?: () => void;
  onSaveEditQueuedMessage?: (
    index: number,
    text: string,
    fileReferences: FileReference[],
    attachmentPaths: string[],
    attachmentPromptContexts: ChatAttachmentPromptContext[] | undefined,
    inputMode: 'typed' | 'voice',
    scheduledSendDraft: { runAt: string } | undefined,
    expected?: QueuedChatMessage,
  ) => void;
  onResetToPoint?: (userMessageId: string) => Promise<void>;
  beforeComposer?: ReactNode;
  /**
   * A Claude chat's interface modes, which the composer offers in its + menu
   * for the Canopy display surface. Worktree chat panels supply this;
   * standalone chats omit it.
   */
  interfaceModeControl?: ChatInterfaceModeControl;
  extraFileReferences?: FileReference[];
  targetOverride?: { projectId: string; worktreeId: string; chatId: string };
  /**
   * Marks the `targetOverride` composer as a live persisted chat session
   * rather than a mirror/embedded surface. Forwarded to `ChatInput`, which
   * enables existing-session scheduled sends and usage-limit resume.
   */
  nativeSessionComposer?: boolean;
  /** Opt in only for the ordinary Code/worktree chat surface. */
  allowCursor?: boolean;
  hideBranchActions?: boolean;
  hidePlanMode?: boolean;
  hideDirectoryPicker?: boolean;
  disableTerminalMode?: boolean;
  disableFileTypeahead?: boolean;
  /**
   * Skills forced on for this surface that the user cannot remove. Forwarded to
   * the composer's plugins modal so matching rows render as locked. Used by the
   * embedded pipeline-editor chat drawer for its required skill.
   */
  lockedSkillRefs?: { sourceId: string; skillName: string }[];
  onSendMessage?: (
    text: string,
    fileReferences?: FileReference[],
    inputMode?: 'typed' | 'voice',
    attachmentPaths?: string[],
    attachmentPromptContexts?: ChatAttachmentPromptContext[],
  ) => Promise<void>;
  /** Scheduled `worktree_session_prompt` rows to render in chat history. */
  scheduledMessages?: ScheduledQueuedMessage[];
  onEditScheduledMessage?: (automationId: string) => void;
  onCancelEditScheduledMessage?: () => void;
  onSaveEditScheduledMessage?: (
    automationId: string,
    text: string,
    fileReferences: FileReference[],
    attachmentPaths: string[],
    attachmentPromptContexts: ChatAttachmentPromptContext[] | undefined,
    inputMode: 'typed' | 'voice',
    scheduledSendDraft: { runAt: string } | undefined,
    expected?: QueuedChatMessage,
  ) => void;
  onClearScheduledMessage?: (automationId: string) => void;
  onInterruptScheduledMessage?: (automationId: string) => void;
  editingScheduledMessageId?: string | null;
  runningScheduledMessageId?: string | null;
  scheduledMessageError?: string | null;
  queuedMessageSchedulingEnabled?: boolean;
  /**
   * Host renders the native composer through shared ChatPanel.renderComposer
   * and the queued-message editor through its hostQueuedMessageEditor.
   */
  hideComposer?: boolean;
  /**
   * Optional suggested-prompt chips (CAN-1809) rendered inside the
   * message-free empty state, under the "Send a message" copy. Hosts that
   * should not show suggestions (App Advisor, pipeline drawer, modals)
   * simply omit the prop. Rendered even when `hideComposer` is set — the
   * chips insert into the externally hosted composer via the
   * `canopy:insert-chat-text` event.
   */
  emptyStateSuggestions?: ReactNode;
  /** Centered content replacing the default empty-chat hint. */
  emptyStateCenter?: ReactNode;
  /**
   * Where `emptyStateCenter` sits in the empty transcript: `bottom` (the
   * default) rests it on the composer; `center` centers it vertically, for
   * a shared `EmptyState`. Both scroll from the top when the pane is short.
   */
  emptyStateCenterPlacement?: 'bottom' | 'center';
  /**
   * Whether this surface is the focused one for Cmd/Ctrl+F (CAN-3048):
   * worktree panels pass the hosting panel's `isActive` bit. Defaults to
   * `true` for single-instance contexts (standalone chat, pipeline drawer)
   * where exactly one surface is mounted.
   */
  searchShortcutActive?: boolean;
  /**
   * Whether this surface is on screen and may register with the floating
   * find bar, so a chat beside the active browser group still offers its
   * toggle. Worktree panels pass the hosting panel's `isVisible` bit;
   * defaults to `searchShortcutActive`.
   */
  findSurfaceVisible?: boolean;
}

export function ChatContent({
  transcript,
  composerTab,
  onClearQueuedMessage,
  onForceQueuedMessage,
  onEditQueuedMessage,
  onCancelEditQueuedMessage,
  onSaveEditQueuedMessage,
  onResetToPoint,
  beforeComposer,
  interfaceModeControl,
  extraFileReferences,
  targetOverride,
  nativeSessionComposer,
  allowCursor,
  hideBranchActions: hideBranchActionsProp,
  hidePlanMode,
  hideDirectoryPicker,
  disableTerminalMode,
  disableFileTypeahead,
  lockedSkillRefs,
  onSendMessage,
  scheduledMessages = [],
  onEditScheduledMessage,
  onCancelEditScheduledMessage,
  onSaveEditScheduledMessage,
  onClearScheduledMessage,
  onInterruptScheduledMessage,
  editingScheduledMessageId = null,
  runningScheduledMessageId = null,
  scheduledMessageError = null,
  queuedMessageSchedulingEnabled = false,
  hideComposer: hideComposerProp = false,
  emptyStateSuggestions,
  emptyStateCenter,
  emptyStateCenterPlacement = 'bottom',
  searchShortcutActive = true,
  findSurfaceVisible = searchShortcutActive,
}: ChatContentProps): JSX.Element {
  // A read-only scope never renders the composer (and with it the plan
  // approval bar, tool-approval dock and queue actions) or branch actions.
  const readOnly = useWorkspaceIsReadOnly();
  const hideComposer = hideComposerProp || readOnly;
  const hideBranchActions = hideBranchActionsProp === true || readOnly;
  const searchHostRef = useRef<HTMLDivElement>(null);
  const messageContainerRef = useRef<HTMLDivElement>(null);
  const cancelShortcutFallbackRootRef = useRef<HTMLDivElement>(null);
  const searchExecutor = useMemo(
    (): SearchExecutor =>
      createDomSearchExecutor(() => messageContainerRef.current),
    [],
  );
  const searchExecutorRef = useRef<SearchExecutor>(searchExecutor);
  searchExecutorRef.current = searchExecutor;
  const domSearch = useContentSearch(searchExecutorRef);
  const queuedMessageEditor = useQueuedMessageComposerEditor({
    queuedMessages: transcript?.queuedMessages,
    editingQueuedMessageIndex: transcript?.editingQueuedMessageIndex,
    autoFocus: transcript?.editingQueuedMessageFocusAllowed,
    onCancelEditQueuedMessage,
    onSaveEditQueuedMessage,
    scheduledMessages,
    editingScheduledMessageId,
    onCancelEditScheduledMessage,
    onSaveEditScheduledMessage,
    composerTab,
    scheduleEnabled: queuedMessageSchedulingEnabled,
  });
  const userMessageHistory = useMemo(
    (): string[] =>
      hideComposer ? [] : extractUserMessageHistory(transcript?.messages ?? []),
    [hideComposer, transcript?.messages],
  );
  // Scope for the revisioned chat-state recovery treatments (refresh toast,
  // inline refresh-error, conflict/command-failure notices).
  const recoveryScope = useChatStore(
    useShallow((s) => {
      const target = targetOverride ?? s.selectedWorktree;
      return target
        ? { projectId: target.projectId, worktreeId: target.worktreeId }
        : null;
    }),
  );

  // The dock's pending approvals pause this chat's running turn timer in the
  // same render that shows the card (CAN-4996).
  const approvalChatId = targetOverride?.chatId ?? transcript?.id;
  const waitingForApproval = useChatStore(
    (s): boolean =>
      recoveryScope !== null &&
      approvalChatId !== undefined &&
      hasPendingApprovalForChat(
        s.pendingApprovals,
        recoveryScope.projectId,
        recoveryScope.worktreeId,
        approvalChatId,
      ),
  );

  const canonicalSearchEnabled = Boolean(
    transcript?.transcript && recoveryScope,
  );
  const transcriptSearch = useTranscriptSearch(
    canonicalSearchEnabled && recoveryScope && transcript
      ? { ...recoveryScope, chatId: transcript.id }
      : null,
    transcript?.transcript?.transcriptRevision,
    messageContainerRef,
  );
  const search = canonicalSearchEnabled ? transcriptSearch : domSearch;

  // A chunk loaded ahead of this mount (a Home first send waits for it) renders
  // without suspending, so the first frame shows the transcript. Chosen once
  // per mount: swapping component types later would remount the list.
  const [ChatMessageList] = useState(
    () => loadedChatMessageListModule()?.ChatMessageList ?? LazyChatMessageList,
  );
  const [pageLoading, setPageLoading] = useState(false);
  const [turnPageId, setTurnPageId] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const pageRequest = useRef(0);
  const pageInFlight = useRef(false);
  const pageProjectId = recoveryScope?.projectId;
  const pageWorktreeId = recoveryScope?.worktreeId;
  const pageChatId = transcript?.id;
  const pageScrollTarget = useMemo(
    () =>
      pageProjectId && pageWorktreeId && pageChatId
        ? {
            projectId: pageProjectId,
            worktreeId: pageWorktreeId,
            chatId: pageChatId,
          }
        : undefined,
    [pageChatId, pageProjectId, pageWorktreeId],
  );
  useChatTranscriptResidency(pageScrollTarget ?? null);
  const loadPage = useCallback(
    async (older = false, turnId?: string): Promise<void> => {
      if (!pageProjectId || !pageWorktreeId || !pageChatId) return;
      if (pageInFlight.current) return;
      pageInFlight.current = true;
      const request = ++pageRequest.current;
      setTurnPageId(turnId ?? null);
      setPageLoading(true);
      setPageError(null);
      try {
        await loadChatTranscriptPage(
          {
            projectId: pageProjectId,
            worktreeId: pageWorktreeId,
            chatId: pageChatId,
          },
          older,
          turnId,
          {
            retainOlderWindow:
              pageScrollTarget === undefined ||
              getSavedChatScrollPosition(pageScrollTarget)?.atBottom === false,
          },
        );
      } catch {
        if (pageRequest.current === request)
          setPageError(TRANSCRIPT_PAGE_LOAD_ERROR);
      } finally {
        if (pageRequest.current === request) {
          pageInFlight.current = false;
          setPageLoading(false);
        }
      }
    },
    [pageProjectId, pageScrollTarget, pageWorktreeId, pageChatId],
  );
  const needsTurnPage = needsNewestTranscriptPage(
    transcript,
    pageProjectId === undefined ? undefined : { projectId: pageProjectId },
  );
  useEffect(() => {
    setTurnPageId(null);
    if (!pageInFlight.current) setPageLoading(false);
    setPageError(null);
    return (): void => {
      pageRequest.current += 1;
      pageInFlight.current = false;
    };
  }, [loadPage]);
  useEffect(() => {
    // Keep an older read or the paging sentinel on the same in-flight slot.
    // The store loader retries a reset itself; changing needsTurnPage must not
    // clear this guard and issue a duplicate reload.
    if (needsTurnPage) void loadPage();
  }, [loadPage, needsTurnPage]);
  const loadTurn = useCallback(
    (id: string): Promise<void> => loadPage(true, id),
    [loadPage],
  );
  const pageControls = (
    <StaleTranscriptCatchUpControls
      target={
        recoveryScope && pageChatId
          ? { ...recoveryScope, chatId: pageChatId }
          : null
      }
    >
      <TranscriptPagingControls
        key={transcript?.transcriptWindow?.before ?? 'initial'}
        loading={pageLoading && turnPageId === null}
        suspended={pageLoading}
        error={turnPageId === null ? pageError : null}
        hasEarlier={transcript?.transcriptWindow?.before !== undefined}
        needsLoad={transcript?.transcriptLoaded === false}
        onReload={() => {
          void loadPage();
        }}
        onLoadEarlier={() => {
          void loadPage(!needsTurnPage);
        }}
      />
    </StaleTranscriptCatchUpControls>
  );

  const showsTranscript = !(
    !transcript ||
    (transcript.transcriptLoaded !== false &&
      transcript.messages.length === 0 &&
      transcript.queuedMessages.length === 0 &&
      !scheduledMessages.some(
        (scheduled) => scheduled.scheduleKind === 'one_time',
      ))
  );
  const transcriptId = transcript?.id ?? null;
  const searchOpen = useSurfaceFindStore(
    (s) =>
      transcriptId !== null &&
      s.open &&
      s.mode === 'chat' &&
      s.activeScope.chat === transcriptId,
  );
  const searchRef = useRef(search);
  searchRef.current = search;

  // Cmd/Ctrl+F opens the shared floating find bar (CAN-3048). While this
  // surface is active it registers a controller that delegates to its own
  // transcript search. Methods read the latest search through a ref so a
  // re-render never re-registers (which would close an open bar).
  // A hidden page host (MainPage while Home or Settings is shown) keeps this
  // chat mounted; it must not stay searchable, or the bar would outlive it.
  const hostVisible = usePanelHostState().visible !== false;
  const findSearchable =
    findSurfaceVisible &&
    hostVisible &&
    showsTranscript &&
    transcriptId !== null;
  // Names this chat in the bar's scope menu beside other chats.
  const findTitle = composerTab?.title.trim() || 'Chat';
  const findTitleRef = useRef(findTitle);
  findTitleRef.current = findTitle;
  useEffect(() => {
    const anchor = searchHostRef.current;
    if (!findSearchable || transcriptId === null || !anchor) return undefined;
    const controller: FindController = {
      mode: 'chat',
      scopeKey: transcriptId,
      title: findTitleRef.current,
      anchor,
      setQuery: (query) => searchRef.current.setQuery(query),
      next: () => searchRef.current.goToNext(),
      previous: () => searchRef.current.goToPrevious(),
      close: () => searchRef.current.close(),
      retry: () => searchRef.current.refresh(),
    };
    useSurfaceFindStore.getState().registerController(controller);
    return (): void => {
      useSurfaceFindStore.getState().unregisterController(controller);
    };
  }, [findSearchable, transcriptId]);

  useEffect(() => {
    if (!findSearchable || transcriptId === null) return;
    useSurfaceFindStore
      .getState()
      .setControllerTitle('chat', transcriptId, findTitle);
  }, [findSearchable, findTitle, transcriptId]);

  const searchError = canonicalSearchEnabled ? transcriptSearch.error : null;
  useEffect(() => {
    if (!findSearchable || transcriptId === null) return;
    useSurfaceFindStore.getState().updateControllerState('chat', transcriptId, {
      currentIndex: search.currentIndex,
      totalCount: search.totalCount,
      error: searchError ?? null,
    });
  }, [
    findSearchable,
    transcriptId,
    search.currentIndex,
    search.totalCount,
    searchError,
  ]);

  // Rehydrate turn ratings recorded elsewhere (CAN-1521). The tab's own
  // `turnFeedback` map already survives a restart on this machine; this pulls
  // the server rows (plus anything still queued in the main-process outbox) so
  // a rating made on another device shows up here too. The store fetches once
  // per chat per renderer session and a local pending/failed entry always wins
  // the merge, so a remount costs nothing and never clobbers newer intent.
  const loadTurnFeedback = useChatStore((s) => s.loadTurnFeedback);
  const selectedProjectId = useChatStore((s) => s.selectedWorktree?.projectId);
  const selectedWorktreeId = useChatStore(
    (s) => s.selectedWorktree?.worktreeId,
  );
  const feedbackProjectId = targetOverride?.projectId ?? selectedProjectId;
  const feedbackWorktreeId = targetOverride?.worktreeId ?? selectedWorktreeId;
  const feedbackChatId = targetOverride?.chatId ?? transcript?.id;
  const { turnFeedback } = useScopeCapabilities({
    projectId: feedbackProjectId ?? '',
  });
  useEffect(() => {
    if (turnFeedback !== true) return;
    if (!feedbackProjectId || !feedbackWorktreeId || !feedbackChatId) return;
    void loadTurnFeedback({
      projectId: feedbackProjectId,
      worktreeId: feedbackWorktreeId,
      chatId: feedbackChatId,
    });
  }, [
    feedbackChatId,
    feedbackProjectId,
    feedbackWorktreeId,
    loadTurnFeedback,
    turnFeedback,
  ]);

  // Restore highlights when this panel regains focus. The CSS Custom Highlight
  // registry is document-global and single-keyed, so a sibling chat panel's
  // search clobbers this panel's highlights while it is inactive. Re-run the
  // query on the inactive→active transition so the returning panel's matches
  // (and active match) re-appear without the user re-interacting.
  const wasSearchActiveRef = useRef(searchShortcutActive);
  useEffect(() => {
    const becameActive = searchShortcutActive && !wasSearchActiveRef.current;
    wasSearchActiveRef.current = searchShortcutActive;
    if (becameActive && searchOpen) {
      searchRef.current.refresh();
    }
  }, [searchShortcutActive, searchOpen]);

  if (!transcript || !showsTranscript) {
    return (
      <div ref={cancelShortcutFallbackRootRef} className="contents">
        <div
          className={`flex min-h-0 flex-1 flex-col ${emptyStateCenter ? 'px-4 pt-6' : 'p-6'}`}
        >
          <div
            className={`flex min-h-0 flex-1 ${emptyStateCenter ? 'overflow-y-auto' : 'items-center justify-center'}`}
          >
            {emptyStateCenter ? (
              <div
                className={`${emptyStateCenterPlacement === 'center' ? 'my-auto' : 'mt-auto'} w-full py-4`}
              >
                {emptyStateCenter}
              </div>
            ) : (
              <div className="text-center text-s fg-secondary">
                Send a message to start working
              </div>
            )}
          </div>
          {/* Suggestions anchor to the bottom of the empty transcript area,
              directly above the composer. */}
          <div className="mx-auto w-full max-w-[var(--chat-reading-width)] chat-width-transition">
            {emptyStateSuggestions}
          </div>
        </div>
        {recoveryScope && (
          <ChatStateRecoveryBanner
            projectId={recoveryScope.projectId}
            worktreeId={recoveryScope.worktreeId}
          />
        )}
        {!hideComposer && (
          <ChatInput
            allowCursor={allowCursor}
            cancelShortcutTargetRootRef={cancelShortcutFallbackRootRef}
            tab={composerTab}
            userMessageHistory={userMessageHistory}
            beforeComposer={beforeComposer}
            interfaceModeControl={interfaceModeControl}
            extraFileReferences={extraFileReferences}
            targetOverride={targetOverride}
            nativeSessionComposer={nativeSessionComposer}
            hidePlanMode={hidePlanMode}
            hideDirectoryPicker={hideDirectoryPicker}
            disableTerminalMode={disableTerminalMode}
            disableFileTypeahead={disableFileTypeahead}
            lockedSkillRefs={lockedSkillRefs}
            onSendMessage={onSendMessage}
          />
        )}
      </div>
    );
  }

  return (
    <ComposerWorkDrawerProvider>
      {/* A host that draws the composer owns the tray around this view. */}
      <ComposerTrayProvider enabled={!hideComposer}>
        <div
          ref={cancelShortcutFallbackRootRef}
          className="contents"
          data-find-surface="chat"
          data-find-scope={transcript.id}
        >
          <div
            ref={searchHostRef}
            // The find bar returns focus here when it closes without an opener.
            tabIndex={-1}
            className="relative flex min-h-0 flex-1 flex-col outline-none"
          >
            <Suspense
              fallback={
                <div className="flex min-h-0 flex-1 items-center justify-center">
                  <LoadingSpinner tone="secondary" />
                </div>
              }
            >
              <ChatMessageList
                canonicalSearch={canonicalSearchEnabled}
                searchSelection={transcriptSearch.selection}
                pagingControls={pageControls}
                transcriptTurns={transcript.transcriptWindow?.turns}
                onLoadTurn={loadTurn}
                turnPageId={turnPageId}
                turnLoading={pageLoading}
                turnError={pageError}
                messages={transcript.messages}
                loadedBytesEstimate={estimateTranscriptWindowBytes(
                  transcript.transcript ?? {
                    committedByteLength: 0,
                    committedMessageCount: 0,
                  },
                  transcript.messages.length,
                )}
                pendingTurnTimerId={transcript.pendingTurnTimerId}
                startingTurnUserMessageId={transcript.startingTurnUserMessageId}
                startingTurnPresentationKey={
                  transcript.startingTurnPresentationKey
                }
                waitingForApproval={waitingForApproval}
                queuedMessages={transcript.queuedMessages}
                chatId={transcript.id}
                agentUsage={transcript.agentUsage}
                turnDiffs={transcript.turnDiffs}
                memoryByMessageId={transcript.memoryByMessageId}
                onClearQueuedMessage={onClearQueuedMessage}
                onForceQueuedMessage={onForceQueuedMessage}
                onEditQueuedMessage={onEditQueuedMessage}
                pendingQueuedMessageEditId={
                  transcript.pendingQueuedMessageEditId
                }
                editingQueuedMessageIndex={transcript.editingQueuedMessageIndex}
                onResetToPoint={readOnly ? undefined : onResetToPoint}
                targetOverride={targetOverride}
                hideBranchActions={hideBranchActions}
                containerRef={messageContainerRef}
                searchActive={searchOpen}
                suppressAutoScroll={searchOpen && search.totalCount > 0}
                scheduledMessages={scheduledMessages}
                onEditScheduledMessage={onEditScheduledMessage}
                onClearScheduledMessage={onClearScheduledMessage}
                onInterruptScheduledMessage={onInterruptScheduledMessage}
                editingScheduledMessageId={editingScheduledMessageId}
                runningScheduledMessageId={runningScheduledMessageId}
                enableForkedFromLink
              />
            </Suspense>
            {scheduledMessageError && (
              <Surface variant="section" boundary="top">
                <div className="px-4 py-2">
                  <ErrorBanner
                    error={scheduledMessageError}
                    className=""
                    testId="chat-scheduled-message-error"
                  />
                </div>
              </Surface>
            )}
          </div>
          {recoveryScope && (
            <ChatStateRecoveryBanner
              projectId={recoveryScope.projectId}
              worktreeId={recoveryScope.worktreeId}
            />
          )}
          {!hideComposer && (
            <QueuedEditComposerSlot editor={queuedMessageEditor}>
              <ChatInput
                allowCursor={allowCursor}
                cancelShortcutTargetRootRef={cancelShortcutFallbackRootRef}
                tab={composerTab}
                userMessageHistory={userMessageHistory}
                beforeComposer={beforeComposer}
                interfaceModeControl={interfaceModeControl}
                extraFileReferences={extraFileReferences}
                targetOverride={targetOverride}
                nativeSessionComposer={nativeSessionComposer}
                hidePlanMode={hidePlanMode}
                hideDirectoryPicker={hideDirectoryPicker}
                disableTerminalMode={disableTerminalMode}
                disableFileTypeahead={disableFileTypeahead}
                lockedSkillRefs={lockedSkillRefs}
                onSendMessage={onSendMessage}
              />
            </QueuedEditComposerSlot>
          )}
        </div>
      </ComposerTrayProvider>
    </ComposerWorkDrawerProvider>
  );
}
