/**
 * Shared store derivations for per-tab worktree chat surfaces.
 *
 * This module is the single implementation of the selection/transcript/
 * composer/interface-mode derivations behind the panel-grid chat surfaces.
 * Consumers:
 *
 * - `WorktreeChatSurface` renders ONE chat tab's surface (transcript +
 *   composer + interface-mode handling) from
 *   {@link useWorktreeChatTabSurfaceState}, parameterized by the bound
 *   `chatTabId` — the panel registry's `chat` wrapper mounts one surface per
 *   bound panel.
 * - The panel registry (`lib/panels/registry.tsx`) and `WorktreeManager` use
 *   {@link useWorktreeChatSelection} / {@link getWorktreeChatSelection}.
 * - `AppAdvisorPanel` reuses the explicit-target scheduling projection and
 *   queued/scheduled edit handlers for its synthetic persisted chat scope.
 *
 * Because several tab surfaces can be mounted at once (panels stay mounted
 * while hidden), the App Advisor `chat.activeTab` slice is NOT reported from
 * this hook directly: the hook builds the sanitized report object and flags
 * whether this tab IS the chat store's active tab; `WorktreeChatSurface`
 * mounts a reporter component only for the active tab, so exactly one owner
 * writes the slice (unmount cleanups run before mount effects within a React
 * commit, so ownership handoff cannot clobber the new owner's write).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  type AppAdvisorJson,
  type ChatAttachmentPromptContext,
  type ChatInterfaceMode,
  type FileReference,
  type ScheduledActivity,
  type WorktreeSelection,
} from '@canopy/desktop-shared/types';
import {
  useChatStore,
  useChatTabRenderState,
  useWorktreeChatRenderState,
  type ChatRenderTarget,
  type QueuedChatMessage,
} from '@/stores/chatStore';
import {
  resolveChatInterfaceSurface,
  useClaudeTerminalStore,
  type ClaudeTerminalClientState,
} from '@/stores/claudeTerminalStore';
import {
  getEffectiveClaudeChatInterfaceMode,
  useClaudeTuiChatsEnabled,
} from '@/lib/claude-tui-chats';
import { useAutomationsStore } from '@/stores/automationsStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useTransientRetryState } from '@/stores/transientRetryBannerStore';
import {
  getScheduledMessagesForChat,
  type ScheduledQueuedMessage,
} from '@/lib/worktreeSessionPromptAutomations';
import { isClaudeTerminalEligibleChatTab } from '@/lib/chat-provider';
import { isCoworkChatTarget } from '@/lib/cowork';
import { getWorkspaceDisplayName } from '@/lib/workspaceDisplayName';
import { hasPendingUsageLimitResume } from '@/lib/scheduledUsageLimitResume';
import {
  liveReplyKey,
  presentLiveReplies,
  selectLiveChat,
  useWebCoreLiveReplyStore,
  type LiveChatState,
} from '@/stores/chat/web-core/live-replies';
import type { ActiveComposerView, ActiveTranscriptView } from './types';
import { toActiveComposerView, toActiveTranscriptView } from './types';

/**
 * Filters the GLOBAL selection for worktree-only chrome: the cowork chat
 * pseudo-selection is not a Code worktree, so worktree surfaces reading the
 * global `selectedWorktree` (WorktreeManager, tab-display fallbacks) treat it
 * as "nothing selected". Explicit per-panel bindings intentionally bypass
 * this filter — the Cowork page's grid binds its chat panels to
 * `(coworkWorkspaceId, 'home')` and renders the shared chat surface there.
 */
export function getWorktreeChatSelection(
  selection: WorktreeSelection | null,
): WorktreeSelection | null {
  if (!selection || isCoworkChatTarget(selection.projectId)) {
    return null;
  }
  return selection;
}

/** The currently selected worktree (excluding standalone-chat), or null. */
export function useWorktreeChatSelection(): WorktreeSelection | null {
  return useChatStore(
    useShallow((s): WorktreeSelection | null =>
      getWorktreeChatSelection(s.selectedWorktree),
    ),
  );
}

/** Interface-mode context for one (non-file) chat tab. */
export interface WorktreeChatInterfaceContext {
  chatId: string;
  interfaceMode: ChatInterfaceMode;
  providerIsClaude: boolean;
}

/** Everything `WorktreeChatSurface` needs to render ONE chat tab's surface. */
export interface WorktreeChatTabSurfaceState {
  /** The selected worktree (excluding standalone-chat), or null. */
  selectedWorktree: WorktreeSelection | null;
  /** Whether the bound tab currently exists in the selected worktree. */
  tabExists: boolean;
  /** Whether the bound tab is the chat store's ACTIVE tab (reporter owner). */
  isActiveTab: boolean;
  transcript: ActiveTranscriptView | null;
  composerTab: ActiveComposerView | null;
  interfaceContext: WorktreeChatInterfaceContext | null;
  claudeTerminalRuntime: ClaudeTerminalClientState | undefined;
  claudeTerminalTurnState: ClaudeTerminalClientState['turnState'] | undefined;
  /** A Claude terminal turn that is genuinely in flight (gates the watcher button). */
  claudeTerminalActiveTurn: boolean;
  /** Managed Claude terminal busy (running/starting/cleaning-up/live error). */
  terminalBusy: boolean;
  /** Whether the Claude Code terminal surface should render instead of ChatContent. */
  isClaudeCodeChatMode: boolean;
  /**
   * Sanitized App Advisor `chat.activeTab` slice for this tab, or null when
   * the tab has no composer view. Only the ACTIVE tab's surface reports it.
   */
  chatActiveTabReport: AppAdvisorJson | null;
  scheduledMessages: ScheduledQueuedMessage[];
  editingScheduledId: string | null;
  setEditingScheduledId: (automationId: string | null) => void;
  runningScheduledId: string | null;
  scheduledMessageError: string | null;
  handleResetToPoint: ((userMessageId: string) => Promise<void>) | undefined;
  handleClearQueuedMessage: (index: number) => void;
  handleForceQueuedMessage: (index: number) => void;
  handleEditQueuedMessage: (index: number | null) => void;
  handleSaveQueuedMessage: (
    index: number,
    text: string,
    fileReferences: FileReference[],
    attachmentPaths: string[],
    attachmentPromptContexts: ChatAttachmentPromptContext[] | undefined,
    inputMode: 'typed' | 'voice',
    scheduledSendDraft: { runAt: string } | undefined,
  ) => void;
  handleSaveScheduledMessage: (
    automationId: string,
    text: string,
    fileReferences: FileReference[],
    attachmentPaths: string[],
    attachmentPromptContexts: ChatAttachmentPromptContext[] | undefined,
    inputMode: 'typed' | 'voice',
    scheduledSendDraft: { runAt: string } | undefined,
  ) => void;
  handleClearScheduledMessage: (automationId: string) => void;
  handleInterruptScheduledMessage: (automationId: string) => void;
}

function liveChatKey(
  target: { projectId: string; worktreeId: string; chatId: string } | null,
): string | null {
  return target === null ? null : liveReplyKey(target);
}

/** The transcript with a web core chat's live reply after its committed rows. */
function withLiveReplies(
  transcript: ActiveTranscriptView | null,
  live: LiveChatState,
): ActiveTranscriptView | null {
  if (transcript === null || live.replies.length === 0) return transcript;
  const provisional = presentLiveReplies(
    live.replies,
    transcript.messages,
    live.turnRuns,
  );
  return provisional.length === 0
    ? transcript
    : { ...transcript, messages: [...transcript.messages, ...provisional] };
}

/**
 * The full store derivation for ONE worktree chat tab's surface: transcript,
 * composer, interface-mode/Claude-terminal state, and the scheduled/queued
 * message handlers — every derivation that used to read the store's ACTIVE
 * tab now reads the explicit `chatTabId`, and every dispatched action targets
 * `{ projectId, worktreeId, chatId: chatTabId }` so a non-focused visible
 * chat panel routes sends/edits to its OWN tab, never the store-active one.
 *
 * Mount one instance per chat panel surface; `WorktreeChatSurface` is its
 * only intended consumer.
 */
export function useWorktreeChatTabSurfaceState(
  chatTabId: string | null | undefined,
  worktreeSelection?: WorktreeSelection | null,
): WorktreeChatTabSurfaceState {
  const claudeTuiChatsEnabled = useClaudeTuiChatsEnabled();
  const resolvedChatTabId = chatTabId ?? '';
  const hasWorktreeOverride = worktreeSelection !== undefined;
  const selectedWorktree = useChatStore(
    useShallow((s) => getWorktreeChatSelection(s.selectedWorktree)),
  );
  // Explicit bindings (panel owner selections, incl. cowork targets) are
  // honored as-is; only the global fallback filters cowork out.
  const resolvedWorktree = hasWorktreeOverride
    ? worktreeSelection
    : selectedWorktree;
  // The bound tab in the resolved worktree. Its selectors below run only when
  // this chat's tab or runtime changes, never for another chat's commit.
  const chatTarget = useMemo(
    (): ChatRenderTarget | null =>
      resolvedWorktree
        ? {
            projectId: resolvedWorktree.projectId,
            worktreeId: resolvedWorktree.worktreeId,
            chatId: resolvedChatTabId,
          }
        : null,
    [resolvedWorktree, resolvedChatTabId],
  );
  const tabExists = useChatTabRenderState(
    chatTarget,
    (entry) => entry.tab !== undefined,
  );
  const isActiveTab = useWorktreeChatRenderState(
    resolvedWorktree
      ? `${resolvedWorktree.projectId}/${resolvedWorktree.worktreeId}`
      : null,
    (chatState) => chatState?.activeTabId === resolvedChatTabId,
  );
  const stagedSelectionCount = useChatStore(
    (s) => s.pendingEditorSelections[resolvedChatTabId]?.length ?? 0,
  );
  const committedTranscript = useChatTabRenderState(
    chatTarget,
    useShallow(({ tab, runtime }): ActiveTranscriptView | null => {
      if (!tab || tab.kind === 'file') return null;
      return toActiveTranscriptView(tab, runtime);
    }),
  );
  // A web core chat's reply while its turn runs; none for any other chat.
  const liveChat = useWebCoreLiveReplyStore((state) =>
    selectLiveChat(state, liveChatKey(chatTarget)),
  );
  const transcript = useMemo(
    () => withLiveReplies(committedTranscript, liveChat),
    [committedTranscript, liveChat],
  );
  const composerTab = useChatTabRenderState(
    chatTarget,
    useShallow(({ tab, runtime }): ActiveComposerView | null => {
      if (!tab || tab.kind === 'file') return null;
      return {
        ...toActiveComposerView(tab, {
          includeActiveAgentStep: true,
          lastActivityAt: runtime?.lastActivityAt,
        }),
        interfaceMode: getEffectiveClaudeChatInterfaceMode(
          tab.interfaceMode,
          claudeTuiChatsEnabled,
        ),
      };
    }),
  );
  // Capture the tab's interface mode and the runtime turn state. The
  // selector returns a shallow object so render-cycle stability is preserved
  // and consumers can compare on individual fields.
  const interfaceContext = useChatTabRenderState(
    chatTarget,
    useShallow(({ tab }): WorktreeChatInterfaceContext | null => {
      if (!tab || tab.kind === 'file') return null;
      return {
        chatId: tab.id,
        interfaceMode: claudeTuiChatsEnabled
          ? getEffectiveClaudeChatInterfaceMode(tab.interfaceMode)
          : 'canopy',
        providerIsClaude: isClaudeTerminalEligibleChatTab(tab),
      };
    }),
  );
  const claudeTerminalRuntime = useClaudeTerminalStore((s) => {
    if (!resolvedWorktree || !interfaceContext || !claudeTuiChatsEnabled) {
      return undefined;
    }
    return s.byChat[
      `${resolvedWorktree.projectId}/${resolvedWorktree.worktreeId}/${resolvedChatTabId}`
    ];
  });
  const claudeTerminalTurnState = claudeTerminalRuntime?.turnState;
  // Compute the toggle-disabled status the App Advisor needs. The renderer
  // also enforces idle-gating directly inside the toggle component; this
  // slice lets the assistant reason about *why* a switch is disabled without
  // re-deriving the rules.
  const interfaceMode = interfaceContext?.interfaceMode ?? 'canopy';
  // The rendered surface is derived: `'claude-code'` always mounts the
  // terminal; `'auto'` mounts it only while a terminal turn is executing and
  // falls back to the Canopy transcript between turns.
  const interfaceSurface = resolveChatInterfaceSurface(
    interfaceMode,
    claudeTerminalRuntime,
  );
  const isClaudeCodeChatMode =
    interfaceContext?.providerIsClaude === true &&
    interfaceSurface === 'terminal';
  const canopyNativeBusy = composerTab?.status === 'streaming';
  const terminalBusy =
    claudeTerminalTurnState === 'starting' ||
    claudeTerminalTurnState === 'running' ||
    claudeTerminalTurnState === 'cleaning_up' ||
    (claudeTerminalTurnState === 'error' &&
      claudeTerminalRuntime?.terminalId !== undefined);
  // Narrower than `terminalBusy`: a Claude terminal turn that is genuinely in
  // flight, used to gate the watcher (eye) button (a chat-completion watcher can
  // only be created against an active turn).
  const claudeTerminalActiveTurn =
    claudeTerminalTurnState === 'starting' ||
    claudeTerminalTurnState === 'running' ||
    claudeTerminalTurnState === 'cleaning_up';
  const interfaceToggleDisabled =
    interfaceContext && interfaceContext.providerIsClaude
      ? terminalBusy
        ? ('terminal-running' as const)
        : canopyNativeBusy
          ? ('canopy-native-busy' as const)
          : ('none' as const)
      : ('hidden' as const);

  // Per-tab action target — every dispatched store action routes to THIS
  // tab, independent of the chat store's active tab.
  const tabTarget = useMemo(
    () =>
      resolvedWorktree && resolvedChatTabId
        ? {
            projectId: resolvedWorktree.projectId,
            worktreeId: resolvedWorktree.worktreeId,
            chatId: resolvedChatTabId,
          }
        : null,
    [resolvedChatTabId, resolvedWorktree],
  );
  const transientRetry = useTransientRetryState(tabTarget);

  // -------------------------------------------------------------------------
  // Scheduled `worktree_session_prompt` messages derived from the automations
  // store (kept in sync via the chat surface's hydrate/subscribe in ChatInput).
  // -------------------------------------------------------------------------
  const automationsActivities = useAutomationsStore((s) => s.activities);
  const createAutomationActivity = useAutomationsStore((s) => s.createActivity);
  const updateAutomationActivity = useAutomationsStore((s) => s.updateActivity);
  const runAutomationNow = useAutomationsStore((s) => s.runNow);
  const projects = useProjectsStore((s) => s.projects);
  const scheduleModalOpen = useChatStore((s) => s.scheduledSendModalOpen);
  const [editingScheduledId, setEditingScheduledId] = useState<string | null>(
    null,
  );
  const [runningScheduledId, setRunningScheduledId] = useState<string | null>(
    null,
  );
  const [scheduledMessageError, setScheduledMessageError] = useState<
    string | null
  >(null);
  const isChatKindTab = composerTab !== null;

  const scheduledMessages = useMemo<ScheduledQueuedMessage[]>(() => {
    if (!resolvedWorktree || !isChatKindTab) return [];
    return getScheduledMessagesForChat({
      activities: automationsActivities,
      workspaceId: resolvedWorktree.projectId,
      worktreeId: resolvedWorktree.worktreeId,
      chatId: resolvedChatTabId,
    });
  }, [
    resolvedChatTabId,
    isChatKindTab,
    automationsActivities,
    resolvedWorktree,
  ]);
  // A scheduled message that fires or is deleted while its editor is open
  // takes the editor with it; drop its id so the queue's Edit comes back.
  const editingScheduledGone =
    editingScheduledId !== null &&
    !scheduledMessages.some(
      (scheduled) => scheduled.automationId === editingScheduledId,
    );
  useEffect(() => {
    if (editingScheduledGone) setEditingScheduledId(null);
  }, [editingScheduledGone]);

  // Sanitized App Advisor snapshot flags (counts/booleans/ids only — never
  // prompt text or transcripts).
  const usageLimitBannerVisible =
    composerTab?.llmProviderUsageLimitBanner !== undefined &&
    composerTab.dismissedLlmProviderUsageLimitBannerKey !==
      composerTab.llmProviderUsageLimitBanner.dismissKey;
  const usageResumeScheduled = useMemo(() => {
    if (!resolvedWorktree || !isChatKindTab) return false;
    return hasPendingUsageLimitResume(
      automationsActivities,
      {
        workspaceId: resolvedWorktree.projectId,
        worktreeId: resolvedWorktree.worktreeId,
        chatId: resolvedChatTabId,
      },
      Date.now(),
    );
  }, [
    automationsActivities,
    resolvedChatTabId,
    isChatKindTab,
    resolvedWorktree,
  ]);

  // The `chat.activeTab` slice value; reported by the ACTIVE tab's surface
  // only (see the module JSDoc for the single-owner handoff rationale).
  const chatActiveTabReport = useMemo<AppAdvisorJson | null>(
    () =>
      composerTab
        ? {
            chatId: composerTab.id,
            title: composerTab.title,
            status: composerTab.status,
            stagedSelectionCount,
            ...(composerTab.providerType
              ? { providerType: composerTab.providerType }
              : {}),
            ...(composerTab.executionHarness
              ? { executionHarness: composerTab.executionHarness }
              : {}),
            ...(composerTab.model ? { model: composerTab.model } : {}),
            // Phase F6: surface the chat-interface surface (Canopy-native vs
            // managed Claude Code terminal) and the live toggle-disabled
            // reason so App Advisor can answer "what mode is the user in?"
            // questions and avoid offering switches that the UI would block.
            // `interfaceSurface` reports what is actually rendered — in auto
            // mode the surface flips between canopy and terminal per turn.
            interfaceMode,
            interfaceSurface,
            ...(claudeTerminalTurnState ? { claudeTerminalTurnState } : {}),
            interfaceToggleDisabled,
            // Worktree-session scheduled-send / usage-limit awareness. Sanitized:
            // flags + counts + ids only, never prompt text or transcripts.
            ...(usageLimitBannerVisible
              ? { usageLimitBannerVisible: true }
              : {}),
            ...(usageResumeScheduled ? { usageResumeScheduled: true } : {}),
            ...(transientRetry
              ? {
                  transientRetry: {
                    provider: transientRetry.provider,
                    attempt: transientRetry.attempt,
                    maxAttempts: transientRetry.maxAttempts,
                    nextRetryAt: transientRetry.nextRetryAt,
                    exhausted: transientRetry.exhausted,
                  },
                }
              : {}),
            ...(scheduledMessages.length > 0
              ? { scheduledMessageCount: scheduledMessages.length }
              : {}),
            ...(scheduleModalOpen ? { scheduleModalOpen: true } : {}),
            ...(editingScheduledId
              ? {
                  scheduledMessageInlineEditOpen: true,
                  scheduledMessageEditId: editingScheduledId,
                }
              : {}),
          }
        : null,
    [
      claudeTerminalTurnState,
      composerTab,
      editingScheduledId,
      interfaceMode,
      interfaceSurface,
      interfaceToggleDisabled,
      scheduleModalOpen,
      scheduledMessages.length,
      stagedSelectionCount,
      transientRetry,
      usageLimitBannerVisible,
      usageResumeScheduled,
    ],
  );

  const clearQueuedMessage = useChatStore((s) => s.clearQueuedMessage);
  const forceQueuedMessage = useChatStore((s) => s.forceQueuedMessage);
  const setEditingQueuedMessage = useChatStore(
    (s) => s.setEditingQueuedMessage,
  );
  const sendMessage = useChatStore((s) => s.sendMessage);
  const saveEditedQueuedMessage = useChatStore(
    (s) => s.saveEditedQueuedMessage,
  );
  const resetToPoint = useChatStore((s) => s.resetToPoint);
  const composerStatus = composerTab?.status ?? null;

  const worktreeSessionDisplayFields = useMemo(() => {
    if (!resolvedWorktree) return {};
    const project = projects.find(
      (entry) => entry.id === resolvedWorktree.projectId,
    );
    const worktree =
      project && project.type !== 'cowork'
        ? project.worktrees.find(
            (entry) => entry.id === resolvedWorktree.worktreeId,
          )
        : undefined;
    return {
      ...(project ? { workspaceName: getWorkspaceDisplayName(project) } : {}),
      ...(worktree?.branchName ? { worktreeName: worktree.branchName } : {}),
      ...(composerTab?.title ? { chatTitle: composerTab.title } : {}),
    };
  }, [composerTab?.title, projects, resolvedWorktree]);

  const buildSessionPromptAction = useCallback(
    (
      activity: ScheduledActivity | null,
      text: string,
      fileReferences: FileReference[],
      attachmentPaths: string[],
      attachmentPromptContexts: ChatAttachmentPromptContext[] | undefined,
      inputMode: 'typed' | 'voice',
    ) => {
      const existingAction = activity?.action;
      if (existingAction && existingAction.type !== 'worktree_session_prompt') {
        return null;
      }
      if (!tabTarget) return null;
      const target = existingAction ?? {
        type: 'worktree_session_prompt' as const,
        workspaceId: tabTarget.projectId,
        worktreeId: tabTarget.worktreeId,
        chatId: tabTarget.chatId,
        prompt: text,
        purpose: 'scheduled_send' as const,
        ...worktreeSessionDisplayFields,
      };
      return {
        type: 'worktree_session_prompt' as const,
        workspaceId: target.workspaceId,
        worktreeId: target.worktreeId,
        chatId: target.chatId,
        prompt: text,
        ...(fileReferences.length > 0 ? { fileReferences } : {}),
        ...(attachmentPaths.length > 0 ? { attachmentPaths } : {}),
        ...(attachmentPromptContexts && attachmentPromptContexts.length > 0
          ? { attachmentPromptContexts }
          : {}),
        inputMode,
        ...(target.purpose ? { purpose: target.purpose } : {}),
        ...(target.workspaceName
          ? { workspaceName: target.workspaceName }
          : {}),
        ...(target.worktreeName ? { worktreeName: target.worktreeName } : {}),
        ...(target.chatTitle ? { chatTitle: target.chatTitle } : {}),
      };
    },
    [tabTarget, worktreeSessionDisplayFields],
  );

  const handleResetToPoint = useMemo<
    ((userMessageId: string) => Promise<void>) | undefined
  >(() => {
    if (!tabTarget || !isChatKindTab) return undefined;
    if (composerStatus === 'streaming') return undefined;
    return (userMessageId: string): Promise<void> =>
      resetToPoint(userMessageId, tabTarget);
  }, [composerStatus, isChatKindTab, resetToPoint, tabTarget]);

  const handleClearQueuedMessage = useCallback(
    (index: number): void => {
      clearQueuedMessage(index, tabTarget ?? undefined);
    },
    [clearQueuedMessage, tabTarget],
  );

  const handleForceQueuedMessage = useCallback(
    (index: number): void => {
      forceQueuedMessage(index, tabTarget ?? undefined);
    },
    [forceQueuedMessage, tabTarget],
  );

  const handleEditQueuedMessage = useCallback(
    (index: number | null, message?: QueuedChatMessage): void => {
      void setEditingQueuedMessage(index, tabTarget ?? undefined, message);
    },
    [setEditingQueuedMessage, tabTarget],
  );

  const handleClearScheduledMessage = useCallback(
    (automationId: string): void => {
      // Disable (not delete) — preserves the automation for management UX.
      void updateAutomationActivity({ id: automationId, enabled: false });
    },
    [updateAutomationActivity],
  );

  const handleInterruptScheduledMessage = useCallback(
    (automationId: string): void => {
      const activity = automationsActivities.find(
        (entry) => entry.id === automationId,
      );
      setRunningScheduledId(automationId);
      setScheduledMessageError(null);
      void (async (): Promise<void> => {
        try {
          // Send now, then consume the one-time occurrence so it does not also
          // fire at its scheduled time (a bare runNow leaves nextRunAt intact).
          const runResponse = await runAutomationNow(automationId);
          if (!runResponse.ok) {
            setScheduledMessageError(
              runResponse.error || 'Could not send scheduled message now.',
            );
            return;
          }
          if (activity && activity.schedule.kind === 'one_time') {
            const updateResponse = await updateAutomationActivity({
              id: automationId,
              enabled: false,
            });
            if (!updateResponse.ok) {
              setScheduledMessageError(
                updateResponse.error || 'Could not consume scheduled message.',
              );
            }
          }
        } finally {
          setRunningScheduledId((current) =>
            current === automationId ? null : current,
          );
        }
      })();
    },
    [automationsActivities, runAutomationNow, updateAutomationActivity],
  );

  const handleSaveQueuedMessage = useCallback(
    (
      index: number,
      text: string,
      fileReferences: FileReference[],
      attachmentPaths: string[],
      attachmentPromptContexts: ChatAttachmentPromptContext[] | undefined,
      inputMode: 'typed' | 'voice',
      scheduledSendDraft: { runAt: string } | undefined,
      expected?: QueuedChatMessage,
    ): void => {
      if (!scheduledSendDraft) {
        setScheduledMessageError(null);
        saveEditedQueuedMessage(
          index,
          text,
          fileReferences,
          attachmentPaths,
          attachmentPromptContexts,
          inputMode,
          undefined,
          tabTarget ?? undefined,
          expected,
        );
        return;
      }
      const action = buildSessionPromptAction(
        null,
        text,
        fileReferences,
        attachmentPaths,
        attachmentPromptContexts,
        inputMode,
      );
      if (!action) {
        setScheduledMessageError('Could not schedule message.');
        return;
      }
      setScheduledMessageError(null);
      void createAutomationActivity({
        name: 'Scheduled message',
        schedule: {
          kind: 'one_time',
          runAt: scheduledSendDraft.runAt,
          timezone: 'local',
        },
        action,
      }).then((response) => {
        if (response.ok) {
          setScheduledMessageError(null);
          handleClearQueuedMessage(index);
          return;
        }
        setScheduledMessageError(
          response.error || 'Could not schedule message.',
        );
      });
    },
    [
      buildSessionPromptAction,
      createAutomationActivity,
      handleClearQueuedMessage,
      saveEditedQueuedMessage,
      tabTarget,
    ],
  );

  const handleSaveScheduledMessage = useCallback(
    (
      automationId: string,
      text: string,
      fileReferences: FileReference[],
      attachmentPaths: string[],
      attachmentPromptContexts: ChatAttachmentPromptContext[] | undefined,
      inputMode: 'typed' | 'voice',
      scheduledSendDraft: { runAt: string } | undefined,
    ): void => {
      const activity = automationsActivities.find(
        (entry) => entry.id === automationId,
      );
      if (!activity || activity.action.type !== 'worktree_session_prompt') {
        return;
      }
      const targetAction = activity.action;
      const action = buildSessionPromptAction(
        activity,
        text,
        fileReferences,
        attachmentPaths,
        attachmentPromptContexts,
        inputMode,
      );
      if (!action) return;

      if (!scheduledSendDraft) {
        void updateAutomationActivity({
          id: automationId,
          enabled: false,
        }).then((response) => {
          if (!response.ok) return;
          setEditingScheduledId(null);
          void sendMessage(
            text,
            fileReferences.length > 0 ? fileReferences : undefined,
            {
              projectId: targetAction.workspaceId,
              worktreeId: targetAction.worktreeId,
              chatId: targetAction.chatId,
            },
            inputMode,
            attachmentPaths.length > 0 || attachmentPromptContexts
              ? {
                  ...(attachmentPaths.length > 0 ? { attachmentPaths } : {}),
                  ...(attachmentPromptContexts
                    ? { attachmentPromptContexts }
                    : {}),
                }
              : undefined,
          );
        });
        return;
      }

      void updateAutomationActivity({
        id: automationId,
        schedule: {
          kind: 'one_time',
          runAt: scheduledSendDraft.runAt,
          timezone: 'local',
        },
        action,
      }).then((response) => {
        if (response.ok) {
          setEditingScheduledId(null);
        }
      });
    },
    [
      automationsActivities,
      buildSessionPromptAction,
      sendMessage,
      updateAutomationActivity,
    ],
  );

  return {
    selectedWorktree: resolvedWorktree,
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
  };
}
