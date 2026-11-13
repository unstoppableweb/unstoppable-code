import { useCallback, useEffect, useMemo, useRef, type JSX } from 'react';
import {
  ContinueSection,
  useContinueAttentionPaging,
  buildContinueSectionModel,
  countContinueAttentionByKind,
  resolveLastViewedNames,
  sameContinueAttentionItems,
  type ContinueAttentionItem,
  type ContinueInterruptedSession,
  type ContinueLastViewed,
} from '@canopy/ui-app';
import type { SidebarItem } from '@canopy/desktop-shared/types';
import { chatDisplayLabel, chatTabLabel } from '@canopy/protocol';
import { isDefaultWorktreeBranchName } from '@canopy/desktop-shared/lib/default-worktree-branch';
import { useInterruptedSessions } from '@/hooks/useInterruptedSessions';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import {
  shouldShowInterruptedSessionsBanner,
  type InterruptedSessionEntry,
  type InterruptedSessionsSummary,
} from '@/lib/interruptedSessions';
import {
  interruptedSessionHomeCopy,
  interruptedSessionsHomeCopy,
} from '@/lib/usage-limit/resume-readiness-copy';
import { usageLimitedChatDestination } from '@/lib/usage-limit/open-resumed-session';
import { openAutomationRunDestination } from '@/components/automations/resolveAutomationRunDestination';
import { dispatchAppAction } from '@/lib/app-actions/dispatcher';
import { useHomeInterruptedSessionsBannerStore } from '@/stores/homeInterruptedSessionsBannerStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useChatStore, useWorktreeChatRenderState } from '@/stores/chatStore';
import { useChatSidebarStore } from '@/stores/chatSidebarStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useStartupResumeStore } from '@/stores/startupResumeStore';
import { useBranchDisplayStore } from '@/stores/branchDisplayStore';
import { getWorkspaceDisplayName } from '@/lib/workspaceDisplayName';
import { getWorktreeBranchDisplayName } from '@/lib/worktreeDisplayName';
import type { StartupResumeTarget } from '@/lib/startup-resume';
import { useContextScopedWorkspaces } from '@/hooks/useContextScopedWorkspaces';
import { createDesktopContinueAttentionSelector } from '@/lib/continue-attention';
import { requestChatPanelReveal } from '@/lib/chatPanelReveal';
import { openInWorkspaceContextAsync } from '@/lib/contextScope';
import { trackResume } from '@/lib/resume-lifecycle';
import { dismissPageLikeViewers } from '@/lib/dismissPageLikeViewers';
import type { ChatState } from '@/stores/chat/state';

export interface HomeContinueSectionProps {
  onVisibilityChange?: (visible: boolean) => void;
  /** Page-variant Home only polls the interrupted-session registry. */
  interruptedActive: boolean;
  /**
   * Only the page-variant instance reports the `home.interruptedSessionsBanner`
   * App Advisor slice. The slice is a single key-addressed entry, so an
   * embedded HomeSurface (the always-mounted MainPage keeps one alive) would
   * otherwise overwrite it with `visible: false` or clear it on unmount while
   * the row is still on screen.
   */
  isPageVariant?: boolean;
}

interface ResumeDetails {
  workspaceName: string;
  /** Cowork descriptor, or the worktree's branch display name. */
  targetName: string;
  /** The worktree's explicit label. */
  worktreeLabel?: string;
  /** Branch display name, omitted for generated default branches. */
  branchName?: string;
  /** Active chat tab's strip label, when it has already hydrated. */
  activeChatTitle?: string;
}

/**
 * Performs the navigation the old startup auto-restore used to do. Worktree
 * targets select immediately and await their tabs; cowork targets tolerate
 * failure (e.g. the workspace was deleted mid-session) and still land on the chat page, where
 * StandaloneChatPage initializes a default cowork workspace on mount.
 */
function resumeTarget(offer: StartupResumeTarget): void {
  trackResume(async (): Promise<void> => {
    if (offer.kind === 'worktree') {
      useNavigationStore.getState().navigate('main');
      useChatStore
        .getState()
        .selectWorktree(offer.projectId, offer.worktreeId, {
          deferTabLoad: true,
        });
      await useChatStore.getState().loadTabs();
      return;
    }
    try {
      const standaloneChatStore = useStandaloneChatStore.getState();
      if (!standaloneChatStore.chatProjectsLoaded) {
        await standaloneChatStore.loadChatProjects();
      }
      await useStandaloneChatStore
        .getState()
        .switchChatProject(offer.workspaceId, offer.workEntryId);
    } catch {
      // StandaloneChatPage initializes a default cowork workspace on failure.
    }
    useNavigationStore.getState().navigate('chat');
  });
}

/**
 * Opens a Continue attention row through the Overview sequence: enter the
 * workspace's navigation context, dismiss page-like viewers, select the exact
 * tab, go to the main page, select the worktree, and reveal the chat panel.
 * The target is revalidated when the open runs (context switches can be
 * asynchronous): a chat that no longer exists opens nothing rather than an
 * unrelated tab, and a worktree that disappeared is skipped. Opening never
 * resolves pending attention; selecting the worktree applies the chat store's
 * existing read semantics. The open stays pending (see resume-lifecycle.ts)
 * until the context switch and selection finish.
 */
function openAttentionTarget(item: ContinueAttentionItem): void {
  const { target } = item;
  trackResume(() =>
    openInWorkspaceContextAsync(target.workspaceId, async (): Promise<void> => {
      const project = useProjectsStore
        .getState()
        .projects.find((candidate) => candidate.id === target.workspaceId);
      if (
        !project ||
        project.type === 'cowork' ||
        !project.worktrees.some(
          (worktree) =>
            worktree.id === target.worktreeId && worktree.hidden !== true,
        )
      ) {
        return;
      }
      const chatStore = useChatStore.getState();
      const worktreeChat =
        chatStore.worktreeChats[`${target.workspaceId}/${target.worktreeId}`];
      if (
        target.kind === 'chat' &&
        !worktreeChat?.tabs.some((tab) => tab.id === target.chatId)
      ) {
        return;
      }
      dismissPageLikeViewers();
      // Worktree selection acknowledges its active tab. Select the requested
      // chat first so an unseen restored tab keeps its unread state.
      if (target.kind === 'chat') {
        chatStore.switchTab(target.chatId, {
          projectId: target.workspaceId,
          worktreeId: target.worktreeId,
        });
      }
      useNavigationStore.getState().navigate('main');
      useChatStore
        .getState()
        .selectWorktree(target.workspaceId, target.worktreeId, {
          deferTabLoad: true,
        });
      if (target.kind === 'chat') {
        requestChatPanelReveal(
          target.workspaceId,
          target.worktreeId,
          target.chatId,
        );
      }
      await useChatStore.getState().loadTabs();
    }),
  );
}

/**
 * Opens an interrupted chat without resuming it: a worktree chat in its
 * workspace's navigation context, and App Advisor chats directly. The
 * opener revalidates the chat, so a stale destination opens nothing.
 */
function openInterruptedChat(
  entry: Extract<InterruptedSessionEntry, { kind: 'chat' }>,
): void {
  const destination = usageLimitedChatDestination(entry.target);
  const open = (): Promise<void> =>
    openAutomationRunDestination(destination)
      .then((result) => {
        if (result.ok && destination.kind === 'worktree-chat') {
          requestChatPanelReveal(
            destination.projectId,
            destination.worktreeId,
            destination.chatId,
          );
        }
      })
      .catch(() => undefined);
  if (destination.kind === 'worktree-chat') {
    trackResume(() => openInWorkspaceContextAsync(destination.projectId, open));
    return;
  }
  if (destination.kind === 'cowork-chat') {
    trackResume(() =>
      openInWorkspaceContextAsync(destination.workspaceId, open),
    );
    return;
  }
  trackResume(open);
}

type WorktreeNameOf = (worktree: {
  id: string;
  branchName: string;
  label?: string;
}) => string;

type WorktreeWorkspace = Exclude<SidebarItem, { type: 'cowork' }>;

/** The workspace and worktree a chat entry belongs to, when both still exist. */
function interruptedChatWorktree(
  entry: Extract<InterruptedSessionEntry, { kind: 'chat' }>,
  projects: readonly SidebarItem[],
): {
  project: WorktreeWorkspace;
  worktree: WorktreeWorkspace['worktrees'][number];
} | null {
  const project = projects.find(
    (candidate) => candidate.id === entry.target.projectId,
  );
  if (
    !entry.target.projectId.trim() ||
    !entry.target.worktreeId.trim() ||
    !entry.target.chatId.trim() ||
    !project ||
    project.type === 'cowork'
  )
    return null;
  const worktree = project.worktrees.find(
    (candidate) => candidate.id === entry.target.worktreeId,
  );
  return worktree ? { project, worktree } : null;
}

/**
 * Names the single interrupted entry on the Continue row, or null to keep the
 * count copy for several entries. Only a worktree chat that still exists
 * merges with Last viewed; Open
 * is offered only for chats with a destination the opener can resolve.
 */
function interruptedSessionPresentation(
  summary: InterruptedSessionsSummary,
  projects: readonly SidebarItem[],
  worktreeName: WorktreeNameOf,
): ContinueInterruptedSession | null {
  const [entry] = summary.sessions;
  if (summary.sessions.length !== 1 || !entry) return null;
  const title = interruptedSessionTitle(entry);
  const copy = interruptedSessionHomeCopy(summary.readiness);
  if (entry.kind === 'pipeline') {
    return {
      title,
      ...copy,
      kindLabel: 'Workflow',
      workspaceName: entry.workspaceName,
    };
  }
  const location = interruptedChatWorktree(entry, projects);
  const destination = usageLimitedChatDestination(entry.target);
  // Current cowork entries use their workspace id and a Work Entry id. The
  // existing opener normalizes that triple; it is never a worktree merge.
  const coworkWorkspaceId =
    destination.kind === 'cowork-chat'
      ? destination.workspaceId
      : entry.target.projectId;
  const cowork = projects.find(
    (project) => project.id === coworkWorkspaceId && project.type === 'cowork',
  );
  const registryWorktreeName = entry.worktreeName.trim();
  return {
    title,
    ...copy,
    worktreeName: location
      ? worktreeName(location.worktree)
      : registryWorktreeName && registryWorktreeName !== entry.target.worktreeId
        ? registryWorktreeName
        : undefined,
    workspaceName: location
      ? getWorkspaceDisplayName(location.project)
      : cowork
        ? getWorkspaceDisplayName(cowork)
        : entry.workspaceName,
    ...(location
      ? {
          mergeTarget: {
            workspaceId: location.project.id,
            worktreeId: location.worktree.id,
          },
        }
      : {}),
    ...(destination.kind !== 'none' &&
    (location !== null ||
      cowork !== undefined ||
      destination.kind === 'app-advisor-chat')
      ? { onOpen: (): void => openInterruptedChat(entry) }
      : {}),
  };
}

function interruptedSessionTitle(entry: InterruptedSessionEntry): string {
  return entry.kind === 'chat'
    ? chatDisplayLabel({ title: entry.title, fallback: 'Untitled chat' })
    : entry.title.trim() || 'Untitled workflow';
}

/**
 * The title of the one interrupted chat in a worktree, or undefined when
 * none or several match, so Last viewed never picks among them arbitrarily.
 * A blank title is undefined rather than a display fallback, so it never
 * hides a usable active-tab title.
 */
function soleInterruptedChatTitle(
  summary: InterruptedSessionsSummary,
  workspaceId: string,
  worktreeId: string,
): string | undefined {
  const matches = summary.sessions.filter(
    (entry) =>
      entry.kind === 'chat' &&
      entry.target.projectId === workspaceId &&
      entry.target.worktreeId === worktreeId,
  );
  const [match] = matches;
  return matches.length === 1 && match
    ? chatDisplayLabel({ title: match.title, fallback: '' }).trim() || undefined
    : undefined;
}

const NO_ATTENTION: readonly ContinueAttentionItem[] = [];

/**
 * Continue attention rows, derived inside the chat store selector so streamed
 * tokens (which change no attention field) keep the previous reference and
 * re-render nothing; genuine attention transitions publish a new array.
 */
function useDesktopContinueAttention(
  isInContext: (workspaceId: string) => boolean,
): readonly ContinueAttentionItem[] {
  const projects = useProjectsStore((s) => s.projects);
  const getBranchDisplayName = useBranchDisplayStore((s) => s.getDisplayName);
  const branchMappingsVersion = useBranchDisplayStore((s) => s.mappingsVersion);
  const lastRef = useRef<readonly ContinueAttentionItem[]>(NO_ATTENTION);
  const selector = useMemo(() => {
    void branchMappingsVersion;
    const context = {
      projects,
      isInContext,
      worktreeName: (worktree: {
        id: string;
        branchName: string;
        label?: string;
      }): string => {
        const branchName = getWorktreeBranchDisplayName({
          rawBranch: worktree.branchName,
          worktreeId: worktree.id,
          hasMultipleBranches: false,
          getBranchDisplayName,
        });
        return worktree.label?.trim() || branchName;
      },
    };
    const selectAttention = createDesktopContinueAttentionSelector(context);
    return (state: ChatState): readonly ContinueAttentionItem[] => {
      const next = selectAttention(state);
      if (sameContinueAttentionItems(lastRef.current, next)) {
        return lastRef.current;
      }
      lastRef.current = next;
      return next;
    };
  }, [projects, isInContext, getBranchDisplayName, branchMappingsVersion]);
  return useChatStore(selector);
}

function InterruptedSessionsUiStateReporter({
  visible,
  count,
  readyCount,
  waitingCount,
}: {
  readonly visible: boolean;
  readonly count: number;
  readonly readyCount: number;
  readonly waitingCount: number;
}): null {
  useCurrentUiStateReporter('home.interruptedSessionsBanner', {
    visible,
    count,
    readyCount,
    waitingCount,
  });
  return null;
}

/** Page Home's App Advisor view of the Continue attention rows, by kind. */
function ContinueAttentionUiStateReporter({
  attention,
  lastViewedVisible,
}: {
  readonly attention: readonly ContinueAttentionItem[];
  readonly lastViewedVisible: boolean;
}): null {
  const counts = countContinueAttentionByKind(attention);
  useCurrentUiStateReporter('home.continueAttention', {
    questionCount: counts.question,
    toolApprovalCount: counts['tool-approval'],
    planReviewCount: counts['plan-review'],
    unreadCount: counts.unread,
    lastViewedVisible,
  });
  return null;
}

/**
 * Desktop host for the shared {@link ContinueSection} below the Home
 * composer: the interrupted-sessions row, attention rows (CAN-4958), and the
 * startup Last viewed destination.
 */
export function HomeContinueSection({
  onVisibilityChange,
  interruptedActive,
  isPageVariant = false,
}: HomeContinueSectionProps): JSX.Element | null {
  const { isInContext } = useContextScopedWorkspaces();
  const summary = useInterruptedSessions(interruptedActive, isInContext);
  const dismissedSignature = useHomeInterruptedSessionsBannerStore(
    (s) => s.dismissedSignature,
  );
  const dismissInterrupted = useHomeInterruptedSessionsBannerStore(
    (s) => s.dismiss,
  );
  const interruptedVisible = shouldShowInterruptedSessionsBanner(
    summary,
    dismissedSignature,
  );
  const attention = useDesktopContinueAttention(isInContext);

  const offer = useStartupResumeStore((s) => s.offer);
  const clearOffer = useStartupResumeStore((s) => s.clearOffer);
  const projects = useProjectsStore((s) => s.projects);
  const getBranchDisplayName = useBranchDisplayStore((s) => s.getDisplayName);
  const branchMappingsVersion = useBranchDisplayStore((s) => s.mappingsVersion);
  const offerWorktreeKey =
    offer?.kind === 'worktree'
      ? `${offer.projectId}/${offer.worktreeId}`
      : null;
  const chatState = useWorktreeChatRenderState(
    offerWorktreeKey,
    (worktreeChat) => worktreeChat,
  );
  useEffect(() => {
    if (
      !isPageVariant ||
      !interruptedActive ||
      offer?.kind !== 'worktree' ||
      chatState !== undefined ||
      !isInContext(offer.projectId)
    )
      return;
    const workspace = projects.find(
      (project) => project.id === offer.projectId,
    );
    if (
      !workspace ||
      workspace.type === 'cowork' ||
      !workspace.worktrees.some((worktree) => worktree.id === offer.worktreeId)
    )
      return;
    // Startup may load only badges for an idle scope. Prefetch its canonical
    // tabs for Last viewed's title, without selecting, creating or archiving.
    void useChatStore
      .getState()
      .hydrateChatScopeRevisioned(offer.projectId, offer.worktreeId, {
        speculative: true,
      })
      .catch(() => undefined);
  }, [
    isPageVariant,
    interruptedActive,
    offer,
    chatState,
    projects,
    isInContext,
  ]);
  // Only what the stores already know: a running chat, else unread activity.
  // Unread is not proof a turn finished, so no completion or reply count.
  const offerActivity = useChatSidebarStore((s): string | null => {
    if (offerWorktreeKey === null) return null;
    if (s.badgeKeys.streaming.split(',').includes(offerWorktreeKey)) {
      return 'Agent working';
    }
    return s.unreadWorktreeKeys.has(offerWorktreeKey) ? 'New activity' : null;
  });

  const worktreeName = useCallback<WorktreeNameOf>(
    (worktree) => {
      // branchMappingsVersion invalidates the display-name cache.
      void branchMappingsVersion;
      const branchName = getWorktreeBranchDisplayName({
        rawBranch: worktree.branchName,
        worktreeId: worktree.id,
        hasMultipleBranches: false,
        getBranchDisplayName,
      });
      return worktree.label?.trim() || branchName;
    },
    [getBranchDisplayName, branchMappingsVersion],
  );

  const resumeDetails = useMemo((): ResumeDetails | null => {
    if (!offer) {
      return null;
    }
    const offerWorkspaceId =
      offer.kind === 'worktree' ? offer.projectId : offer.workspaceId;
    if (!isInContext(offerWorkspaceId)) return null;
    if (offer.kind === 'cowork') {
      const workspace = projects.find(
        (project) =>
          project.id === offer.workspaceId && project.type === 'cowork',
      );
      if (!workspace) {
        return null;
      }
      return {
        workspaceName: getWorkspaceDisplayName(workspace),
        targetName: 'Cowork chat',
      };
    }

    const workspace = projects.find(
      (project) => project.id === offer.projectId,
    );
    if (!workspace || workspace.type === 'cowork') {
      return null;
    }
    const worktree = workspace.worktrees.find(
      (candidate) => candidate.id === offer.worktreeId,
    );
    if (!worktree) {
      return null;
    }
    const activeTab = chatState?.tabs.find(
      (tab) => tab.id === chatState.activeTabId,
    );
    // branchMappingsVersion invalidates the display-name cache.
    void branchMappingsVersion;
    const branchName = getWorktreeBranchDisplayName({
      rawBranch: worktree.branchName,
      worktreeId: worktree.id,
      hasMultipleBranches: false,
      getBranchDisplayName,
    });
    return {
      workspaceName: getWorkspaceDisplayName(workspace),
      targetName: branchName,
      worktreeLabel: worktree.label,
      branchName: isDefaultWorktreeBranchName(worktree.branchName, worktree.id)
        ? undefined
        : branchName,
      // Name the chat as its tab strip does: rename, then generated name.
      ...(activeTab ? { activeChatTitle: chatTabLabel(activeTab) } : {}),
    };
  }, [
    offer,
    projects,
    chatState,
    getBranchDisplayName,
    branchMappingsVersion,
    isInContext,
  ]);

  // An interrupted chat in the destination names it; otherwise the active tab.
  const lastViewedChatTitle =
    offer?.kind === 'worktree'
      ? (soleInterruptedChatTitle(summary, offer.projectId, offer.worktreeId) ??
        resumeDetails?.activeChatTitle)
      : undefined;
  const lastViewed = useMemo((): ContinueLastViewed | null => {
    if (!offer || !resumeDetails) return null;
    if (offer.kind !== 'worktree') {
      return {
        workspaceId: offer.workspaceId,
        destinationName: resumeDetails.targetName,
        workspaceName: resumeDetails.workspaceName,
      };
    }
    // Label, then the associated chat title, then the branch display name.
    const names = resolveLastViewedNames({
      worktreeLabel: resumeDetails.worktreeLabel,
      chatTitle: lastViewedChatTitle,
      branchName: resumeDetails.branchName,
      fallbackName: resumeDetails.targetName,
    });
    if (!names.destinationName) return null;
    return {
      workspaceId: offer.projectId,
      worktreeId: offer.worktreeId,
      ...names,
      workspaceName: resumeDetails.workspaceName,
      activity: offerActivity,
    };
  }, [offer, resumeDetails, offerActivity, lastViewedChatTitle]);
  const openLastViewed = useCallback((): void => {
    if (!offer) return;
    clearOffer();
    resumeTarget(offer);
  }, [offer, clearOffer]);

  const interruptedSession = useMemo(
    () =>
      interruptedVisible
        ? interruptedSessionPresentation(summary, projects, worktreeName)
        : null,
    [interruptedVisible, summary, projects, worktreeName],
  );

  // Shared with the section so App Advisor sees the rows on screen.
  const attentionPaging = useContinueAttentionPaging();
  const model = buildContinueSectionModel({
    attention,
    lastViewed,
    interruptedVisible,
    interruptedTarget: interruptedSession?.mergeTarget ?? null,
    shownAttentionRows: attentionPaging.shownRows,
  });

  return (
    <>
      <ContinueSection
        onVisibilityChange={onVisibilityChange}
        attention={attention}
        onOpenAttention={openAttentionTarget}
        lastViewed={lastViewed}
        onOpenLastViewed={openLastViewed}
        attentionPaging={attentionPaging}
        interrupted={
          interruptedVisible
            ? {
                count: summary.count,
                ...interruptedSessionsHomeCopy(summary.readiness),
                session: interruptedSession,
                onResume: (): void => {
                  void dispatchAppAction({
                    requestId: `ui-usage.open_resume_modal-${Date.now()}`,
                    source: 'ui',
                    action: { type: 'usage.open_resume_modal' },
                  });
                },
                onDismiss: (): void => dismissInterrupted(summary.signature),
              }
            : null
        }
      >
        {isPageVariant ? (
          <>
            <InterruptedSessionsUiStateReporter
              visible={interruptedVisible}
              count={summary.count}
              readyCount={summary.readiness.readyCount}
              waitingCount={summary.readiness.waitingCount}
            />
            <ContinueAttentionUiStateReporter
              attention={attention}
              lastViewedVisible={model.lastViewedVisible}
            />
          </>
        ) : null}
      </ContinueSection>
    </>
  );
}
