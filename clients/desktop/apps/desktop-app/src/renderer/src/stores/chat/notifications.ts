// Unread-chat toasts, OS notifications, and delayed Claude unread
// notification scheduling. Owns the delayed-notification timer registry.
import { CHAT_LABEL, ORCHESTRATOR_LABEL, chatTabLabel } from '@canopy/protocol';
import {
  getUnreadChatFallbackMessage,
  getUnreadChatLabel,
  type UnreadChatToastReason,
} from '@canopy/ui-shared/lib';
import {
  CODE_REVIEW_CHAT_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  type AgentProviderType,
  type WorktreeSelection,
} from '@canopy/desktop-shared/types';
import { canNavigateToWorktreeFromSidebarItems } from '@/lib/worktreeNavigation';
import { isCoworkChatTarget } from '@/lib/cowork';
import { getCurrentChatPanelVisible } from '@/lib/worktree-layout-prefs';
import {
  maybeFireOsNotification,
  shouldShowInAppNotification,
} from '@/lib/osNotifications';
import { requestChatPanelReveal } from '@/lib/chatPanelReveal';
import { dismissPageLikeViewers } from '@/lib/dismissPageLikeViewers';
import { useCodeReviewStore } from '../codeReviewStore';
import { useGitHubStore } from '../githubStore';
import type { ToastMeta } from '../toastStore';
import {
  isScopedNotificationDeliverable,
  type ScopedNotificationDescriptor,
} from '../spaceNotificationStore';
import { useNavigationStore } from '../navigationStore';
import { useProjectsStore } from '../projectsStore';
import { isStandaloneChatArchiveOverlayOpen } from '../standaloneChatVisibility';
import { isMainContentCoveredByAppAdvisorDock } from '../appAdvisorDockCover';
import { CLAUDE_UNREAD_CHAT_NOTIFICATION_DELAY_MS } from './constants';
import {
  WORKTREE_CHAT_OPEN_ARCHIVE_TRANSCRIPT_EVENT,
  type ChatTab,
  type WorktreeChatOpenArchiveTranscriptDetail,
} from './types';
import { worktreeKey } from './utils';
import {
  canReceiveWorktreeChatActivity,
  isAppAdvisorChatTarget,
  isAppAdvisorWindowFocused,
} from './surface';
import { isChatAgentResponseEvent } from './unread-previews';
import { isNewResponseTurnEventData } from './turn-events';
import { tagStatusWrite } from './runtime-divergence';
import {
  findPlanExploreTarget,
  isVisiblePlanExploreChat,
} from './plan-explore-registry';
import {
  findCodeReviewTarget,
  isVisibleCodeReviewChat,
} from './code-review-registry';
import { waitForWorktreeHydration } from './hydration';
import { chatStoreApi } from './store-ref';

export type { UnreadChatToastReason };

export interface UnreadChatToastOptions {
  projectId: string;
  worktreeId: string;
  chatId: string;
  chatTitle?: string;
  reason: UnreadChatToastReason;
  agentResponsePreview?: string;
  providerType?: AgentProviderType;
  requireUnreadBeforeDelivery?: boolean;
  /**
   * The chat auto-archives once its turn finishes, so by the time the user
   * clicks the toast it is no longer a live tab. Route the click to the archive
   * transcript viewer in the owning worktree instead of `switchTab`.
   */
  openArchivedTranscript?: boolean;
  /** The turn ended in an error rather than completing (activity only). */
  failed?: boolean;
  /**
   * Local time the triggering occurrence happened. Stamped when delivery is
   * first requested, so a delayed delivery is judged against the space's
   * notification choice at the time the work happened, not when it fires.
   */
  occurredAt?: number;
}

/**
 * The originating space and typed meaning of a chat notification (CAN-3615).
 * Questions and plans awaiting review need the user; a finished turn is
 * routine unless it failed. App Advisor chats belong to no space.
 * Plan-explore and code-review chats count toward their real worktree.
 */
export function chatNotificationScope(
  options: UnreadChatToastOptions,
): ScopedNotificationDescriptor | undefined {
  if (isAppAdvisorChatTarget(options.projectId, options.worktreeId))
    return undefined;
  const target =
    options.projectId === PLAN_EXPLORE_CHAT_PROJECT_ID
      ? findPlanExploreTarget(options.worktreeId)
      : options.projectId === CODE_REVIEW_CHAT_PROJECT_ID
        ? findCodeReviewTarget(options.worktreeId)
        : { projectId: options.projectId, worktreeId: options.worktreeId };
  // A synthetic scope whose real worktree is gone has no space to consult.
  if (!target) return undefined;
  return {
    projectId: target.projectId,
    worktreeId: target.worktreeId,
    eventClass:
      options.reason === 'activity'
        ? options.failed === true
          ? 'failure'
          : 'routine'
        : 'attention',
    ...(options.occurredAt === undefined
      ? {}
      : { occurredAt: options.occurredAt }),
  };
}

function withOccurrenceTime(
  options: UnreadChatToastOptions,
): UnreadChatToastOptions {
  return options.occurredAt === undefined
    ? { ...options, occurredAt: Date.now() }
    : options;
}

const delayedClaudeUnreadChatNotificationTimers = new Map<
  string,
  ReturnType<typeof setTimeout>
>();

export function getDelayedClaudeUnreadChatNotificationKey(
  kind: 'toast' | 'os',
  options: UnreadChatToastOptions,
): string {
  return `${kind}:${options.projectId}/${options.worktreeId}/${options.chatId}:${options.reason}`;
}

export function isClaudeTerminalBusyForUnreadNotification(
  tab: ChatTab,
): boolean {
  return (
    tab.claudeTerminal?.turnState === 'starting' ||
    tab.claudeTerminal?.turnState === 'running' ||
    tab.claudeTerminal?.turnState === 'cleaning_up'
  );
}

export function isUnreadChatActivityStillStoppedAndUnread(
  options: UnreadChatToastOptions,
): boolean {
  const key = `${options.projectId}/${options.worktreeId}`;
  const state = chatStoreApi().getState();
  const tab = state.worktreeChats[key]?.tabs.find(
    (entry) => entry.id === options.chatId,
  );

  if (tab) {
    return (
      tab.unread === true &&
      tab.status !== 'streaming' &&
      tab.queuedMessages.length === 0 &&
      tab.forceQueuedMessageCancelPending !== true &&
      !isClaudeTerminalBusyForUnreadNotification(tab)
    );
  }

  return (
    state.archivedChats[key]?.some(
      (summary) => summary.chatId === options.chatId && summary.unread === true,
    ) === true
  );
}

export function shouldDelayClaudeUnreadChatNotification(
  options: UnreadChatToastOptions,
): boolean {
  return (
    options.providerType === 'claude' &&
    options.reason === 'activity' &&
    options.requireUnreadBeforeDelivery === true
  );
}

export function scheduleDelayedClaudeUnreadChatNotification(
  kind: 'toast' | 'os',
  options: UnreadChatToastOptions,
  deliver: () => void,
): void {
  const key = getDelayedClaudeUnreadChatNotificationKey(kind, options);
  const existing = delayedClaudeUnreadChatNotificationTimers.get(key);
  if (existing) {
    clearTimeout(existing);
  }

  const timer = setTimeout(() => {
    delayedClaudeUnreadChatNotificationTimers.delete(key);
    if (isUnreadChatActivityStillStoppedAndUnread(options)) {
      deliver();
    }
  }, CLAUDE_UNREAD_CHAT_NOTIFICATION_DELAY_MS);
  delayedClaudeUnreadChatNotificationTimers.set(key, timer);
}

export function cancelDelayedUnreadChatNotificationsForWorktree(
  projectId: string,
  worktreeId: string,
): void {
  const prefixes = [
    `toast:${projectId}/${worktreeId}/`,
    `os:${projectId}/${worktreeId}/`,
  ];
  delayedClaudeUnreadChatNotificationTimers.forEach((timer, key) => {
    if (prefixes.some((prefix) => key.startsWith(prefix))) {
      clearTimeout(timer);
      delayedClaudeUnreadChatNotificationTimers.delete(key);
    }
  });
}

/**
 * An agent response proves a session the renderer marked stale is alive.
 * `canonicalStatus` is set for revisioned scopes, where canonical runtime
 * already projects the tab's status and error; only legacy scopes write them.
 */
export function reinstateStaleSessionOnAgentResponse(
  tab: ChatTab,
  data: Record<string, unknown>,
  options?: { canonicalStatus?: boolean },
): ChatTab {
  if (!tab.staleSessionDetected || !isChatAgentResponseEvent(data)) {
    return tab;
  }

  const sdkSessionId = tab.sdkSessionId ?? tab.staleSessionResumeId;
  if (options?.canonicalStatus !== true) {
    tagStatusWrite(tab.id, 'stale-session');
  }

  return {
    ...tab,
    ...(options?.canonicalStatus === true
      ? {}
      : { status: 'streaming' as const, error: null }),
    readOnly: undefined,
    staleSessionDetected: undefined,
    staleSessionResumeId: undefined,
    lastTurnWasResumeAttempt: undefined,
    cancelRequestedByUser: undefined,
    ...(sdkSessionId ? { sdkSessionId } : {}),
  };
}

export function clearUnreadOnResumedTurn(
  tab: ChatTab,
  data: Record<string, unknown>,
): ChatTab {
  if (tab.unread !== true || !isNewResponseTurnEventData(data)) {
    return tab;
  }

  return { ...tab, unread: false };
}

export function getVisibleWorktreeKey(
  selection: WorktreeSelection | null,
): string | null {
  // The docked Orchestrator page covers whichever page is open; the chat
  // under it stays mounted but is out of view.
  if (!selection || isMainContentCoveredByAppAdvisorDock()) {
    return null;
  }

  // Cowork chats render on the 'chat' page: the selected work entry's chats
  // are the on-screen set there. The Code-page chat-panel visibility pref
  // below does not apply to the cowork panel grid.
  if (isCoworkChatTarget(selection.projectId)) {
    return useNavigationStore.getState().activePage === 'chat' &&
      !isStandaloneChatArchiveOverlayOpen()
      ? worktreeKey(selection)
      : null;
  }

  if (
    useNavigationStore.getState().activePage !== 'main' ||
    !getCurrentChatPanelVisible()
  ) {
    return null;
  }

  return worktreeKey(selection);
}

export function tabHasReviewAttention(tab: ChatTab): boolean {
  return (
    tab.pendingPlanExit !== undefined ||
    (tab.trackedPlanId !== undefined &&
      tab.trackedPlanReviewStatus === 'pending')
  );
}

export function tabNeedsVisibleAcknowledgement(tab: ChatTab): boolean {
  return (
    tab.unread === true ||
    (tab.attentionDismissedAt === undefined && tabHasReviewAttention(tab))
  );
}

export function tabsStillNeedAttention(tabs: ChatTab[]): boolean {
  return tabs.some(
    (tab) =>
      tab.unread === true ||
      (tab.attentionDismissedAt === undefined && tabHasReviewAttention(tab)),
  );
}

export function getUnreadChatToastContext(
  options: UnreadChatToastOptions,
  {
    // The in-app toast's headline already names the worktree; an OS
    // notification has no such headline, so its body keeps the branch.
    includeWorktreeName = true,
  }: { includeWorktreeName?: boolean } = {},
): {
  project:
    | ReturnType<typeof useProjectsStore.getState>['projects'][number]
    | undefined;
  worktreeName: string;
  message: string;
} {
  const tab = chatStoreApi()
    .getState()
    .worktreeChats[
      worktreeKey({
        projectId: options.projectId,
        worktreeId: options.worktreeId,
      })
    ]?.tabs.find((entry) => entry.id === options.chatId);
  // Name the chat as its tab does: a rename, then the generated description,
  // then the raw title callers pass.
  const chatTitle = tab ? chatTabLabel(tab) : options.chatTitle;
  if (isAppAdvisorChatTarget(options.projectId, options.worktreeId)) {
    const chatLabel = getUnreadChatLabel(chatTitle);
    const message = options.agentResponsePreview
      ? `${ORCHESTRATOR_LABEL}${chatLabel}: ${options.agentResponsePreview}`
      : getUnreadChatFallbackMessage({
          reason: options.reason,
          chatLabel,
          worktreeName: ORCHESTRATOR_LABEL,
          isAppAdvisor: true,
        });
    return { project: undefined, worktreeName: ORCHESTRATOR_LABEL, message };
  }

  if (options.projectId === PLAN_EXPLORE_CHAT_PROJECT_ID) {
    const target = findPlanExploreTarget(options.worktreeId);
    const planProject = target
      ? useProjectsStore
          .getState()
          .projects.find((entry) => entry.id === target.projectId)
      : undefined;
    const planWorktree =
      planProject && planProject.type !== 'cowork'
        ? planProject.worktrees.find((entry) => entry.id === target?.worktreeId)
        : undefined;
    const worktreeName =
      planWorktree?.branchName ?? target?.worktreeId ?? options.worktreeId;
    const lead = includeWorktreeName
      ? `${worktreeName} · Plan chat`
      : 'Plan chat';
    const message = options.agentResponsePreview
      ? `${lead}: ${options.agentResponsePreview}`
      : `${lead} finished`;
    return { project: planProject, worktreeName, message };
  }

  if (options.projectId === CODE_REVIEW_CHAT_PROJECT_ID) {
    const target = findCodeReviewTarget(options.worktreeId);
    const reviewProject = target
      ? useProjectsStore
          .getState()
          .projects.find((entry) => entry.id === target.projectId)
      : undefined;
    const reviewWorktree =
      reviewProject && reviewProject.type !== 'cowork'
        ? reviewProject.worktrees.find(
            (entry) => entry.id === target?.worktreeId,
          )
        : undefined;
    const worktreeName =
      reviewWorktree?.branchName ?? target?.worktreeId ?? options.worktreeId;
    const lead = includeWorktreeName
      ? `${worktreeName} · Review chat`
      : 'Review chat';
    const message = options.agentResponsePreview
      ? `${lead}: ${options.agentResponsePreview}`
      : `${lead} finished`;
    return { project: reviewProject, worktreeName, message };
  }

  if (isCoworkChatTarget(options.projectId)) {
    const coworkProject = useProjectsStore
      .getState()
      .projects.find((entry) => entry.id === options.projectId);
    // Approximate the work-entry row title (derived main-side from the
    // latest chat's label) without importing the standalone store — the
    // completing chat is that "latest chat" in practice. Skip the chat label
    // when it would just repeat the entry name.
    const trimmedTitle = chatTitle?.trim();
    const entryName = trimmedTitle || coworkProject?.name || CHAT_LABEL;
    const coworkChatLabel =
      trimmedTitle && trimmedTitle !== entryName
        ? getUnreadChatLabel(chatTitle)
        : '';
    // The in-app headline names the entry, as it names a worktree.
    const lead = includeWorktreeName
      ? `${entryName}${coworkChatLabel}`
      : coworkChatLabel.slice(2);
    const message = options.agentResponsePreview
      ? lead
        ? `${lead}: ${options.agentResponsePreview}`
        : options.agentResponsePreview
      : getUnreadChatFallbackMessage({
          reason: options.reason,
          chatLabel: coworkChatLabel,
          worktreeName: includeWorktreeName ? entryName : undefined,
          isAppAdvisor: false,
        });
    return { project: coworkProject, worktreeName: entryName, message };
  }

  const project = useProjectsStore
    .getState()
    .projects.find((entry) => entry.id === options.projectId);
  const worktree =
    project && project.type !== 'cowork'
      ? project.worktrees.find((entry) => entry.id === options.worktreeId)
      : undefined;
  const worktreeName = worktree?.branchName ?? options.worktreeId;
  const chatLabel = getUnreadChatLabel(chatTitle);
  // Without the branch, the chat title leads (dropping the label's `: `).
  const lead = includeWorktreeName
    ? `${worktreeName}${chatLabel}`
    : chatLabel.slice(2);
  const message = options.agentResponsePreview
    ? lead
      ? `${lead}: ${options.agentResponsePreview}`
      : options.agentResponsePreview
    : getUnreadChatFallbackMessage({
        reason: options.reason,
        chatLabel,
        worktreeName: includeWorktreeName ? worktreeName : undefined,
        isAppAdvisor: false,
      });

  return { project, worktreeName, message };
}

/** Target for {@link navigateToWorktreeChat}. */
export interface WorktreeChatNavigationTarget {
  projectId: string;
  worktreeId: string;
  chatId: string;
  /**
   * The chat is archived — open the read-only archive transcript viewer for it
   * instead of switching to a (nonexistent) live tab.
   */
  openArchivedTranscript?: boolean;
}

/**
 * Navigate to a worktree chat: select its worktree on the main page, then
 * either switch to the live tab (revealing its panel) or dispatch the archive
 * transcript request for an archived chat. Guarded against non-existent /
 * unhydrated worktrees. Shared by the unread-chat toast and the unified command
 * palette so both stay behaviorally identical.
 */
export async function navigateToWorktreeChat(
  target: WorktreeChatNavigationTarget,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  if (
    !isCurrent() ||
    !canNavigateToWorktreeFromSidebarItems(
      useProjectsStore.getState().projects,
      target.projectId,
      target.worktreeId,
      useProjectsStore.getState().hasHydratedProjects,
    )
  ) {
    return;
  }

  // Explicit navigation to a live worktree chat dismisses the page-like
  // archived viewer (programmatic activations must not, so this lives on the
  // navigation helpers rather than the selectWorktree funnel).
  dismissPageLikeViewers();
  useNavigationStore.getState().navigate('main');
  await chatStoreApi()
    .getState()
    .loadTabsForTarget(target.projectId, target.worktreeId);
  await waitForWorktreeHydration(
    worktreeKey({ projectId: target.projectId, worktreeId: target.worktreeId }),
  );
  if (!isCurrent()) return;
  chatStoreApi().getState().selectWorktree(target.projectId, target.worktreeId);
  if (target.openArchivedTranscript) {
    // Auto-archived chat: it is no longer a live tab, so ask the tab bar to
    // open the archive transcript viewer for it. A frame's delay lets the
    // worktree selection settle so the tab bar is mounted for the target.
    const detail: WorktreeChatOpenArchiveTranscriptDetail = {
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      chatId: target.chatId,
    };
    requestAnimationFrame(() => {
      window.dispatchEvent(
        new CustomEvent(WORKTREE_CHAT_OPEN_ARCHIVE_TRANSCRIPT_EVENT, {
          detail,
        }),
      );
    });
    return;
  }
  chatStoreApi().getState().switchTab(target.chatId);
  // Reveal the chat's panel: switchTab clears unread but, when the chat is
  // already this worktree's active tab (it went unread while collapsed), does
  // not change activeTabId, so the panel bridge would not expand it.
  requestChatPanelReveal(target.projectId, target.worktreeId, target.chatId);
}

export async function navigateToUnreadChat(
  options: WorktreeChatNavigationTarget,
): Promise<void> {
  if (isAppAdvisorChatTarget(options.projectId, options.worktreeId)) {
    await window.api.appAdvisor.openWindow({
      chatId: options.chatId,
      focus: true,
      focusComposer: true,
    });
    return;
  }

  // A legacy plan chat has no surface of its own: open its plan's Plan panel
  // in the owning worktree instead (the opener navigates there first). The
  // dynamic import breaks the module cycle (the opener reads the chat store).
  if (options.projectId === PLAN_EXPLORE_CHAT_PROJECT_ID) {
    const target = findPlanExploreTarget(options.worktreeId);
    if (!target) {
      return;
    }
    const { openTrackedPlan } = await import('@/lib/plans/open-tracked-plan');
    await openTrackedPlan({ ...target, planId: options.worktreeId });
    return;
  }

  // Code-review chats live in the takeover modal, not the worktree chat view.
  // Navigate to the owning worktree, then open the review modal. `worktreeId`
  // here is the composite scope key, so recover the real target from the registry.
  if (options.projectId === CODE_REVIEW_CHAT_PROJECT_ID) {
    const target = findCodeReviewTarget(options.worktreeId);
    if (!target) {
      return;
    }
    useNavigationStore.getState().navigate('main');
    chatStoreApi()
      .getState()
      .selectWorktree(target.projectId, target.worktreeId);
    void useCodeReviewStore.getState().openCodeReview({
      projectId: target.projectId,
      worktreeId: target.worktreeId,
    });
    return;
  }

  // Cowork chats live on the 'chat' page under a work entry, not the
  // worktree view. The dynamic import breaks the module cycle
  // (standaloneChatStore statically imports the chat store), matching how
  // projectsStore reaches it. Mirrors the command palette's cowork open
  // path.
  if (isCoworkChatTarget(options.projectId)) {
    const { useStandaloneChatStore } = await import('../standaloneChatStore');
    await useStandaloneChatStore
      .getState()
      .openWorkEntryFromSidebar(options.projectId, options.worktreeId);
    useNavigationStore.getState().navigate('chat');
    if (options.openArchivedTranscript) {
      // Auto-archived chat: no live tab to switch to — ask the (shared) tab
      // bar to open the archive transcript viewer once selection settles.
      const detail: WorktreeChatOpenArchiveTranscriptDetail = {
        projectId: options.projectId,
        worktreeId: options.worktreeId,
        chatId: options.chatId,
      };
      requestAnimationFrame(() => {
        window.dispatchEvent(
          new CustomEvent(WORKTREE_CHAT_OPEN_ARCHIVE_TRANSCRIPT_EVENT, {
            detail,
          }),
        );
      });
      return;
    }
    chatStoreApi().getState().switchTab(options.chatId, {
      projectId: options.projectId,
      worktreeId: options.worktreeId,
    });
    requestChatPanelReveal(
      options.projectId,
      options.worktreeId,
      options.chatId,
    );
    return;
  }

  await navigateToWorktreeChat(options);
}

/**
 * While App Advisor sits in the main window's floating panel or docked page,
 * the main window mirrors its turns and owns their notifications; its own renderer
 * must stay quiet or every toast shows twice. The full App Advisor window, or
 * any App Advisor once the main window has closed (macOS keeps the app
 * running), raises its own.
 */
function isMainWindowHostedAppAdvisorRenderer(): boolean {
  if (typeof document === 'undefined') return false;
  const { body } = document;
  return (
    body.dataset.rendererSurface === 'app-advisor' &&
    (body.hasAttribute('data-app-advisor-floating') ||
      body.hasAttribute('data-app-advisor-docked')) &&
    useNavigationStore.getState().appAdvisorMainWindowOpen
  );
}

/** Whether the hosted App Advisor page defers, and the main page's outages so far. */
interface AppAdvisorDeferral {
  deferred: boolean;
  mainWindowDownCount: number;
}

function captureAppAdvisorDeferral(): AppAdvisorDeferral {
  return {
    deferred: isMainWindowHostedAppAdvisorRenderer(),
    mainWindowDownCount:
      useNavigationStore.getState().appAdvisorMainWindowDownCount,
  };
}

/**
 * A delayed notification the hosted App Advisor page deferred when it was
 * scheduled is the main window's only while its page stays up until it is
 * due. A reply that finished while the page was down never reached it, and a
 * page that goes down mid-delay, even briefly, takes its own pending timer
 * with it; App Advisor delivers in both cases.
 */
function mainWindowDeliversDeferred(scheduled: AppAdvisorDeferral): boolean {
  return (
    scheduled.deferred &&
    isMainWindowHostedAppAdvisorRenderer() &&
    useNavigationStore.getState().appAdvisorMainWindowDownCount ===
      scheduled.mainWindowDownCount
  );
}

export function showUnreadChatToast(options: UnreadChatToastOptions): void {
  if (isMainWindowHostedAppAdvisorRenderer()) return;
  deliverUnreadChatToast(options);
}

function deliverUnreadChatToast(options: UnreadChatToastOptions): void {
  if (!canReceiveWorktreeChatActivity(options.projectId, options.worktreeId)) {
    return;
  }

  if (
    isVisiblePlanExploreChat(options.projectId, options.worktreeId) ||
    isVisibleCodeReviewChat(options.projectId, options.worktreeId)
  ) {
    return;
  }

  if (!shouldShowInAppNotification('Chat')) {
    deliverChatActivityNotification(options);
    return;
  }

  const { message } = getUnreadChatToastContext(options, {
    includeWorktreeName: false,
  });
  const { message: osNotificationBody } = getUnreadChatToastContext(options);
  const { meta, onClick } = getChatToastAttribution(options);
  const notificationScope = chatNotificationScope(options);
  useGitHubStore.getState().addToast(message, 'info', onClick, {
    category: 'Chat',
    ...meta,
    ...(osNotificationBody === message ? {} : { osNotificationBody }),
    ...(notificationScope ? { notificationScope } : {}),
    ...(isChatTurnCompletion(options) ? { agentCompletion: true } : {}),
  });
}

/**
 * A finished turn (successful or failed) in a worktree, Cowork, automation,
 * plan-explore, or code-review chat. Plans and questions wait on the user, and
 * App Advisor is excluded from the notification offer (CAN-4005).
 */
function isChatTurnCompletion(options: UnreadChatToastOptions): boolean {
  return (
    options.reason === 'activity' &&
    !isAppAdvisorChatTarget(options.projectId, options.worktreeId)
  );
}

/**
 * Attributes a toast to one chat: the toast header names the chat's workspace
 * and links its worktree, and clicking the toast opens the chat. The caller
 * picks the category, which also routes the toast through notification
 * preferences.
 */
export function getChatToastAttribution(target: WorktreeChatNavigationTarget): {
  meta: ToastMeta;
  onClick: () => void;
} {
  const onClick = (): void => {
    void navigateToUnreadChat(target);
  };
  if (isAppAdvisorChatTarget(target.projectId, target.worktreeId)) {
    // No projectId: githubStore titles the OS notification "Orchestrator" only
    // for chat toasts without one.
    return { meta: { workspaceName: ORCHESTRATOR_LABEL }, onClick };
  }
  // Plan-explore and code-review chats live under synthetic scopes, so point
  // the toast's worktree target at the real worktree. This makes the toast
  // navigable (the navigation guard validates against the sidebar) and shows
  // the real worktree branch instead of the raw synthetic id.
  const planExploreTarget =
    target.projectId === PLAN_EXPLORE_CHAT_PROJECT_ID
      ? findPlanExploreTarget(target.worktreeId)
      : null;
  const codeReviewTarget =
    target.projectId === CODE_REVIEW_CHAT_PROJECT_ID
      ? findCodeReviewTarget(target.worktreeId)
      : null;
  const projectId =
    planExploreTarget?.projectId ??
    codeReviewTarget?.projectId ??
    target.projectId;
  const project = useProjectsStore
    .getState()
    .projects.find((entry) => entry.id === projectId);
  return {
    meta: {
      workspaceName: project?.name,
      projectId,
      worktreeId:
        planExploreTarget?.worktreeId ??
        codeReviewTarget?.worktreeId ??
        target.worktreeId,
      chatId: target.chatId,
    },
    onClick,
  };
}

export function maybeShowUnreadChatToast(
  requested: UnreadChatToastOptions,
): void {
  const options = withOccurrenceTime(requested);
  const deferral = captureAppAdvisorDeferral();
  if (shouldDelayClaudeUnreadChatNotification(options)) {
    scheduleDelayedClaudeUnreadChatNotification('toast', options, () => {
      if (!mainWindowDeliversDeferred(deferral))
        deliverUnreadChatToast(options);
    });
    return;
  }

  if (!deferral.deferred) deliverUnreadChatToast(options);
}

/**
 * OS notification path for chat turn-completion / plan-ready events. This is
 * used both for standalone OS-notification-only flows and as the fallback when
 * the in-app banner is suppressed. Deliberately does NOT insert a toast:
 * `showUnreadChatToast` remains responsible for that. The central helper
 * suppresses this when the Canopy window is focused AND the user is already
 * looking at the exact chat (same worktreeKey + chatId).
 */
export function fireChatActivityNotification(
  options: UnreadChatToastOptions,
): void {
  if (isMainWindowHostedAppAdvisorRenderer()) return;
  deliverChatActivityNotification(options);
}

function deliverChatActivityNotification(
  options: UnreadChatToastOptions,
): void {
  // Mirror active-chat behavior: when a synthetic-scope chat is on screen and
  // the window is focused, suppress the OS ping. When the window is
  // unfocused the user is away, so still notify (as any active chat would).
  // Neither predicate holds today: no surface shows these chats any more.
  if (
    (isVisiblePlanExploreChat(options.projectId, options.worktreeId) ||
      isVisibleCodeReviewChat(options.projectId, options.worktreeId)) &&
    typeof document !== 'undefined' &&
    document.hasFocus()
  ) {
    return;
  }

  const notificationScope = chatNotificationScope(options);
  if (notificationScope && !isScopedNotificationDeliverable(notificationScope))
    return;

  const isAppAdvisorToast = isAppAdvisorChatTarget(
    options.projectId,
    options.worktreeId,
  );
  const { message: body } = getUnreadChatToastContext(options);

  maybeFireOsNotification({
    title: isAppAdvisorToast ? ORCHESTRATOR_LABEL : CHAT_LABEL,
    body,
    category: 'Chat',
    ...(isAppAdvisorToast
      ? { visible: isAppAdvisorWindowFocused() }
      : {
          projectId: options.projectId,
          worktreeId: options.worktreeId,
          chatId: options.chatId,
        }),
    onClick: (): void => {
      void navigateToUnreadChat(options);
    },
    ...(isChatTurnCompletion(options) ? { agentCompletion: true } : {}),
  });
}

export function maybeFireChatActivityNotification(
  requested: UnreadChatToastOptions,
): void {
  const options = withOccurrenceTime(requested);
  const deferral = captureAppAdvisorDeferral();
  if (shouldDelayClaudeUnreadChatNotification(options)) {
    scheduleDelayedClaudeUnreadChatNotification('os', options, () => {
      if (!mainWindowDeliversDeferred(deferral)) {
        deliverChatActivityNotification(options);
      }
    });
    return;
  }

  if (!deferral.deferred) deliverChatActivityNotification(options);
}
