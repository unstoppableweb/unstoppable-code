import { Stack } from '@canopy/ui-shared/components';
/**
 * Read-only viewer for an archived container (a deleted-but-retained worktree
 * or cowork/App Advisor work entry).
 *
 * All reads and mutations go through `window.api.archivedContainers` /
 * `useArchivedContainersStore` — never the live pipeline store or chat
 * surfaces. The one network-touching exception is the header's pull-request
 * badge, which schedules a TTL-bounded live refresh when this archive is
 * selected and otherwise renders the immutable archive-time capture.
 *
 * Worktree containers expose `Changes (N) | Chats | Pipelines | Attachments |
 * Plans` tabs — Changes appears first but only for version-2 archives whose
 * captured Git statistics are nonzero or unavailable; Chats remains the
 * default tab. Work entries show chats only. A partially
 * restored container (`restoredTo` present) hides Chats. Its retry copy names
 * the remaining pipeline import or Git cleanup work precisely.
 *
 * Layout contract: the host mounts this inside an explicit-height container
 * (an `absolute inset-0` overlay). The transcript pane keeps `ChatMessageList`
 * inside a resolved-height flex column — its scroller is `absolute inset-0`
 * and collapses to 0px inside an unconstrained `min-h` block (see
 * `StandaloneArchiveViewer`). No composer is ever rendered here.
 */
import { Badge } from '@canopy/ui-shared/components/Badge';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import type {
  ArchivedChatSummary,
  ArchivedContainerPullRequestRepoStatus,
  ArchivedContainerSummary,
  ArchivedContainerViewerTab,
  TrackedPlanData,
  WorkspaceAttachmentItem,
} from '@canopy/desktop-shared/types';
import type { ExecutionSummary } from '@canopy/execution-engine/types/pipeline';
import { toPipelineRunRowState } from '@/lib/pipelineRunRowState';
import type { PipelineRunRowState } from '@/lib/pipelineRunRowState';
import type { ChatTab } from '@/stores/chatStore';
import type { CostScopeRef } from '@canopy/protocol/cost-view';
import { RetainedCostView, type CostScopeRowTarget } from '@canopy/ui-app/cost';
import {
  archivedPullRequestStatusKey,
  useArchivedContainersStore,
} from '@/stores/archivedContainersStore';
import { hydratePersistedChatTab } from '@/lib/chatTabPersistence';
import { brandText } from '@/lib/brand';
import { desktopCostClient } from '@/lib/cost/ipc-cost-client';
import { DESKTOP_COST_NAVIGATOR } from '@/lib/cost/cost-navigator';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { InlineDeleteConfirm } from '@/components/activity/workspace-items-shared';
import { LoadingSpinner } from '@/components/shared/loading/spinners/LoadingSpinner';
import { AttachmentPreviewPopover } from '@/components/shared/AttachmentPreviewPopover';
import { ArchivedAttachmentViewer } from './ArchivedAttachmentViewer';
import { useAttachmentHover } from '@/hooks/useAttachmentHover';
import {
  DelayedLoadingPlaceholder,
  Disclosure,
  ListRow,
  Markdown,
  Surface,
  TabBar,
  TranscriptPagingControls,
} from '@canopy/ui-shared/components';
import {
  installTranscriptPage,
  TRANSCRIPT_PAGE_LOAD_ERROR,
} from '@/stores/chat/transcript-pages';
import {
  INLINE_PLAN_MARKDOWN_OPTIONS,
  PLAN_MARKDOWN_OPTIONS,
  stripPlanTitleLine,
} from '@canopy/ui-app/plan-markdown';
import { PlanSourceMark } from '@/components/activity/PlanSourceMark';
import { ArchivedExecutionRow } from './ArchivedExecutionRow';
import { ArchivedAttachmentRow } from './ArchivedAttachmentRow';
import {
  ArchivedAttachmentListSkeleton,
  ArchivedExecutionListSkeleton,
  ArchivedNavListSkeleton,
} from './ArchivedContainerViewSkeletons';
import { PipelineExecutionDetailModal } from '@/components/activity/PipelineExecutionDetailModal';
import { DiffCounts } from '@/components/worktree/DiffCounts';
import { ChatIcon } from '@canopy/ui-shared/icons';
import {
  ArchiveIcon,
  BackIcon,
  BranchIcon,
  RefreshIcon,
  TrashIcon,
  TrashPermanentlyIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { RunningActionIcon } from '@/components/shared/CancelableActionButton';
import { formatByteSize } from '@canopy/ui-shared/lib';
import { formatDateOrEmpty } from '@/lib/format';
import {
  HeaderActionButton,
  Notice,
  PrBadgeTooltipContent,
  RichHoverTooltip,
  type WorktreeRowPrStatus,
} from '@canopy/ui-shared/components';
import { PrStateBadge } from '@/components/github/PrStatusBadge';
import { isPrReadyToMerge } from '@/lib/pr-mergeability';
import {
  getArchivedContainerDiskUsageBytes,
  isArchivedContainerDiskUsageComplete,
  getArchivedContainerDisplayName,
  getArchivedContainerState,
  getArchivedContainerStateDescription,
  getArchivedContainerStateLabel,
  getArchivedGitChangesBadge,
  getArchivedGitChangesTooltip,
  getArchivedPullRequestDisplayEntries,
  getArchivedPullRequestRowDescription,
  shouldRefreshArchivedPullRequests,
} from '@/lib/archivedContainerDisplay';
import { useBranchDisplayStore } from '@/stores/branchDisplayStore';
import { getArchivedChatDisplayLabel } from '@/components/standalone-chat/chat-label';
import {
  STANDALONE_CLAUDE_PROVIDER_ICON,
  STANDALONE_CODEX_PROVIDER_ICON,
  toStandaloneRowProvider,
} from '@/components/standalone-chat/standaloneChatRowHelpers';
import { useArchivedContainerActions } from './useArchivedContainerActions';
import { POSTHOG_REPLAY_MASK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';

/**
 * Stable empty fallback for the live pull-request selector. Never allocate
 * `[]` inside a Zustand selector — a fresh array each snapshot loops
 * `useSyncExternalStore` (React #185) and blank-pages the app.
 */
const EMPTY_LIVE_PULL_REQUEST_REPOS: readonly ArchivedContainerPullRequestRepoStatus[] =
  Object.freeze<ArchivedContainerPullRequestRepoStatus[]>([]);

/**
 * Selecting an archive schedules the live pull-request refresh rather than
 * firing it immediately, so clicking through several archives in a row costs
 * one lookup instead of one per row. The store then applies its own TTL.
 */
const PULL_REQUEST_REFRESH_DEBOUNCE_MS = 300;

type ArchivedViewerTab = ArchivedContainerViewerTab | 'cost';

const ChatMessageList = lazy(() =>
  import('@/components/chat/ChatMessageList').then((module) => ({
    default: module.ChatMessageList,
  })),
);

const ArchivedChangesView = lazy(() =>
  import('./ArchivedChangesView').then((module) => ({
    default: module.ArchivedChangesView,
  })),
);

export interface ArchivedContainerViewProps {
  workspaceId: string;
  containerId: string;
  onClose: () => void;
}

export function ArchivedContainerView({
  workspaceId,
  containerId,
  onClose,
}: ArchivedContainerViewProps): JSX.Element {
  const liveSummary = useArchivedContainersStore(
    (s): ArchivedContainerSummary | undefined =>
      s.byWorkspace[workspaceId]?.find((entry) => entry.id === containerId),
  );
  // Hold the last known summary: during a restore the container disappears
  // from the workspace list while this viewer intentionally stays mounted
  // until the destination is selected — the header must not degrade to
  // placeholder content for that beat.
  const lastSummaryRef = useRef<ArchivedContainerSummary | undefined>(
    undefined,
  );
  if (liveSummary !== undefined) {
    lastSummaryRef.current = liveSummary;
  }
  const summary = liveSummary ?? lastSummaryRef.current;
  const containerCount = useArchivedContainersStore(
    (s) => s.byWorkspace[workspaceId]?.length ?? 0,
  );
  const viewerTab = useArchivedContainersStore((s) =>
    s.viewer?.workspaceId === workspaceId &&
    s.viewer.containerId === containerId
      ? s.viewer.tab
      : 'chats',
  );
  const selectedChatId = useArchivedContainersStore((s) =>
    s.viewer?.workspaceId === workspaceId &&
    s.viewer.containerId === containerId
      ? s.viewer.selectedChatId
      : undefined,
  );
  const selectedPlanId = useArchivedContainersStore((s) =>
    s.viewer?.workspaceId === workspaceId &&
    s.viewer.containerId === containerId
      ? s.viewer.selectedPlanId
      : undefined,
  );
  const selectTab = useArchivedContainersStore((s) => s.selectTab);
  const selectChat = useArchivedContainersStore((s) => s.selectChat);
  const selectPlan = useArchivedContainersStore((s) => s.selectPlan);
  const [costTabScopeKey, setCostTabScopeKey] = useState<string | null>(null);
  const [retainedCostSelection, setRetainedCostSelection] = useState<{
    readonly scopeKey: string;
    readonly target: CostScopeRowTarget;
  } | null>(null);
  const retainedCostScopeKey = JSON.stringify([workspaceId, containerId]);
  const selectedRetainedCostRow =
    retainedCostSelection?.scopeKey === retainedCostScopeKey
      ? retainedCostSelection.target
      : null;
  const retainedCostScope = useMemo<CostScopeRef>(
    () => ({ kind: 'retained', projectId: workspaceId, containerId }),
    [containerId, workspaceId],
  );
  const kind = summary?.kind ?? 'worktree';
  const hasRestoreTarget = summary?.restoredTo !== undefined;
  const gitCleanupOnly =
    hasRestoreTarget &&
    summary?.version === 3 &&
    summary.recovery.gitCleanupPending === true &&
    summary.executionRestorePending !== true;
  const partiallyRestored = hasRestoreTarget && !gitCleanupOnly;
  // "Archived" (locked, kept until deleted) vs "Deleted" (removed once the
  // retention window lapses). Both live in the same retained-container store;
  // the lock timestamp is the only persisted difference.
  const archivedState = getArchivedContainerState(summary ?? {});
  const locked = archivedState === 'archived';
  const diskUsageBytes =
    summary !== undefined ? getArchivedContainerDiskUsageBytes(summary) : null;
  const diskUsageComplete =
    summary !== undefined && isArchivedContainerDiskUsageComplete(summary);
  const archiveActions = useArchivedContainerActions(
    workspaceId,
    containerId,
    locked,
  );
  const showExistingTabBar = kind === 'worktree' && !hasRestoreTarget;
  const showCostTab = !hasRestoreTarget;
  const showTabBar = showExistingTabBar || showCostTab;
  const costTabSelected =
    showCostTab && costTabScopeKey === retainedCostScopeKey;
  useEffect(() => {
    setCostTabScopeKey(null);
  }, [hasRestoreTarget, retainedCostScopeKey]);
  // Archived Git statistics are only present on version-2 worktree
  // summaries; everything here reads the immutable manifest aggregate.
  const gitChanges =
    summary !== undefined && summary.version === 2
      ? summary.gitChanges
      : undefined;
  const changesBadge =
    summary !== undefined ? getArchivedGitChangesBadge(summary) : null;
  const baseBranches =
    summary !== undefined && summary.version === 2 ? summary.baseBranches : [];
  const showBaseRepositoryNames = summary?.workspaceType === 'multi-repo';
  // Pull requests shown in the header: the immutable archive-time capture,
  // overlaid with the on-demand live refresh below when one has resolved.
  // Still strictly read-only — no merge/review/close/reopen control exists
  // here, only the captured link out to GitHub.
  const livePullRequestRepos = useArchivedContainersStore(
    (s) =>
      s.pullRequestStatusByContainer[
        archivedPullRequestStatusKey(workspaceId, containerId)
      ]?.repos ?? EMPTY_LIVE_PULL_REQUEST_REPOS,
  );
  const pullRequestEntries = useMemo(
    () =>
      summary !== undefined
        ? getArchivedPullRequestDisplayEntries(summary, livePullRequestRepos)
        : [],
    [summary, livePullRequestRepos],
  );
  const pullRequestCapturedAt =
    summary !== undefined && summary.version === 2
      ? summary.pullRequestMetadata.capturedAt
      : undefined;
  const showPullRequestRepositoryNames =
    summary?.workspaceType === 'multi-repo';

  // On-demand live refresh: selecting this archive is the only trigger. The
  // debounce absorbs click-throughs and the store's TTL absorbs re-opens, so
  // the header never turns into a background GitHub poller.
  const ensurePullRequestStatus = useArchivedContainersStore(
    (s) => s.ensurePullRequestStatus,
  );
  const pullRequestRefreshEligible =
    summary !== undefined && shouldRefreshArchivedPullRequests(summary);
  useEffect(() => {
    if (!pullRequestRefreshEligible) {
      return;
    }
    const timer = setTimeout(() => {
      ensurePullRequestStatus(workspaceId, containerId);
    }, PULL_REQUEST_REFRESH_DEBOUNCE_MS);
    return (): void => clearTimeout(timer);
  }, [
    pullRequestRefreshEligible,
    workspaceId,
    containerId,
    ensurePullRequestStatus,
  ]);
  // Changes tab: complete stats with files shows `Changes (N)`; unavailable
  // version-2 stats still expose the explorer as plain `Changes`; a clean
  // capture, legacy (v1), work-entry, or partially restored archive hides it.
  const changesTabAvailable =
    showTabBar &&
    gitChanges !== undefined &&
    (gitChanges.status === 'unavailable' || gitChanges.fileCount > 0);
  const changesTabLabel =
    gitChanges?.status === 'complete'
      ? `Changes (${gitChanges.fileCount})`
      : 'Changes';
  // Work entries have only the chats tab; a partially restored container
  // hides everything but Pipelines (its other payloads were already consumed
  // by the restore). A persisted/requested Changes selection that is not
  // currently available falls back to Chats so hidden content never mounts.
  const effectiveTab: ArchivedContainerViewerTab = hasRestoreTarget
    ? 'pipelines'
    : kind === 'work-entry'
      ? 'chats'
      : viewerTab === 'changes' && !changesTabAvailable
        ? 'chats'
        : viewerTab;

  // ----- Chats -----
  const chatListKey = `${workspaceId}\0${containerId}`;
  const [loadedChats, setLoadedChats] = useState<{
    key: string;
    chats: ArchivedChatSummary[];
  } | null>(null);
  const chats = loadedChats?.key === chatListKey ? loadedChats.chats : null;
  const activeChats = useMemo(
    () => chats?.filter((chat) => chat.archived !== true) ?? [],
    [chats],
  );
  const archivedInnerChats = useMemo(
    () => chats?.filter((chat) => chat.archived === true) ?? [],
    [chats],
  );
  const [archivedChatsExpanded, setArchivedChatsExpanded] = useState(false);
  useEffect(() => {
    setArchivedChatsExpanded(false);
  }, [chatListKey]);
  useEffect(() => {
    if (hasRestoreTarget) {
      return;
    }
    let cancelled = false;
    void window.api.archivedContainers
      .listChats({ projectId: workspaceId, containerId })
      .then((response) => {
        if (!cancelled) {
          setLoadedChats({ key: chatListKey, chats: response.chats });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoadedChats({ key: chatListKey, chats: [] });
        }
      });
    return (): void => {
      cancelled = true;
    };
  }, [workspaceId, containerId, hasRestoreTarget, chatListKey]);

  const [transcriptTab, setTranscriptTab] = useState<ChatTab | null>(null);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  useEffect(() => {
    const selectedChatExists =
      selectedChatId !== undefined &&
      chats?.some((chat) => chat.chatId === selectedChatId) === true;
    if (!selectedChatExists) {
      setTranscriptTab(null);
      setTranscriptLoading(false);
      return;
    }
    let cancelled = false;
    setTranscriptLoading(true);
    setTranscriptTab(null);
    void window.api.archivedContainers
      .readChat({ projectId: workspaceId, containerId, chatId: selectedChatId })
      .then((response) => {
        if (cancelled) return;
        setTranscriptTab(hydratePersistedChatTab(response.tab));
        setTranscriptLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setTranscriptTab(null);
        setTranscriptLoading(false);
      });
    return (): void => {
      cancelled = true;
    };
  }, [workspaceId, containerId, selectedChatId, chats]);

  const [pagingLoading, setPagingLoading] = useState(false);
  const pageInFlight = useRef(false);
  const [turnPageId, setTurnPageId] = useState<string | null>(null);
  const [pagingError, setPagingError] = useState<string | null>(null);
  const pagingRequest = useRef(0);
  useEffect(() => {
    pagingRequest.current++;
    pageInFlight.current = false;
    setTurnPageId(null);
    setPagingLoading(false);
    setPagingError(null);
  }, [workspaceId, containerId, selectedChatId]);
  // Memoized so the transcript rows (memoized on their `onLoadHistory` prop)
  // keep a stable callback across unrelated view re-renders.
  const loadTranscriptPage = useCallback(
    async (older: boolean, turnId?: string): Promise<void> => {
      if (!transcriptTab) return;
      const initial = transcriptTab;
      // A turn outside the loaded window walks the global history cursor.
      const knownTurn = turnId
        ? initial.transcriptWindow?.turns?.find((turn) => turn.id === turnId)
        : undefined;
      const before = knownTurn
        ? knownTurn.before
        : initial.transcriptWindow?.before;
      if (older && before === undefined) return;
      if (pageInFlight.current) return;
      pageInFlight.current = true;
      const request = ++pagingRequest.current;
      setTurnPageId(turnId ?? null);
      setPagingLoading(true);
      setPagingError(null);
      try {
        const page = await window.api.chat.getTranscriptPage({
          view: 'turns',
          ...(knownTurn ? { turnId } : {}),
          projectId: workspaceId,
          worktreeId: containerId,
          archivedContainerId: containerId,
          chatId: initial.id,
          ...(older
            ? {
                before,
                transcriptRevision:
                  initial.transcriptWindow?.transcriptRevision,
              }
            : {}),
        });
        if (pagingRequest.current !== request) return;
        setTranscriptTab((current) =>
          current === initial
            ? installTranscriptPage(current, page, older)
            : current,
        );
      } catch {
        if (pagingRequest.current === request)
          setPagingError(TRANSCRIPT_PAGE_LOAD_ERROR);
      } finally {
        if (pagingRequest.current === request) {
          pageInFlight.current = false;
          setPagingLoading(false);
        }
      }
    },
    [transcriptTab, workspaceId, containerId],
  );
  const loadTranscriptTurn = useCallback(
    (id: string): Promise<void> => loadTranscriptPage(true, id),
    [loadTranscriptPage],
  );

  // ----- Pipelines -----
  const [executions, setExecutions] = useState<ExecutionSummary[] | null>(null);
  const [executionRowsById, setExecutionRowsById] = useState<
    Record<string, PipelineRunRowState>
  >({});
  useEffect(() => {
    if (kind !== 'worktree') {
      return;
    }
    let cancelled = false;
    void window.api.archivedContainers
      .listExecutions({ projectId: workspaceId, containerId })
      .then((response) => {
        if (!cancelled) {
          setExecutions(response.executions);
          const rowsById: Record<string, PipelineRunRowState> = {};
          for (const [executionId, state] of Object.entries(
            response.statesById,
          )) {
            rowsById[executionId] = toPipelineRunRowState(state);
          }
          setExecutionRowsById(rowsById);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setExecutions([]);
          setExecutionRowsById({});
        }
      });
    return (): void => {
      cancelled = true;
    };
  }, [workspaceId, containerId, kind]);
  const topLevelExecutions = useMemo(
    () =>
      (executions ?? []).filter(
        (execution) => execution.parent_execution_id === undefined,
      ),
    [executions],
  );

  // ----- Attachments & tracked plans -----
  const [attachments, setAttachments] = useState<
    WorkspaceAttachmentItem[] | null
  >(null);
  const plansScopeKey = `${workspaceId}/${containerId}`;
  const [plansState, setPlansState] = useState<{
    scopeKey: string;
    plans: TrackedPlanData[];
  } | null>(null);
  const plans =
    plansState?.scopeKey === plansScopeKey ? plansState.plans : null;
  useEffect(() => {
    if (kind !== 'worktree') {
      return;
    }
    let cancelled = false;
    setAttachments(null);
    setPlansState(null);
    void window.api.archivedContainers
      .listAttachments({ projectId: workspaceId, containerId })
      .then((response) => {
        if (!cancelled) {
          setAttachments(response.attachments);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAttachments([]);
        }
      });
    void window.api.archivedContainers
      .listPlans({ projectId: workspaceId, containerId })
      .then((response) => {
        if (!cancelled) {
          setPlansState({ scopeKey: plansScopeKey, plans: response.plans });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPlansState({ scopeKey: plansScopeKey, plans: [] });
        }
      });
    return (): void => {
      cancelled = true;
    };
  }, [workspaceId, containerId, kind, plansScopeKey]);

  const viewerTabs = useMemo(() => {
    const tabs: Array<{ id: ArchivedViewerTab; label: string }> = [];
    if (showCostTab) {
      tabs.push({ id: 'cost', label: 'Cost' });
    }
    if (showExistingTabBar && changesTabAvailable) {
      tabs.push({ id: 'changes', label: changesTabLabel });
    }
    const chatCount =
      chats?.length ??
      (summary?.chatCount ?? 0) + (summary?.archivedChatCount ?? 0);
    if (showExistingTabBar || showCostTab) {
      tabs.push({ id: 'chats', label: `Chats (${chatCount})` });
    }
    if (showExistingTabBar) {
      const pipelineCount =
        executions === null
          ? (summary?.executionCount ?? 0)
          : topLevelExecutions.length;
      tabs.push(
        { id: 'pipelines', label: `Workflows (${pipelineCount})` },
        {
          id: 'attachments',
          label:
            attachments === null
              ? 'Attachments'
              : `Attachments (${attachments.length})`,
        },
        {
          id: 'plans',
          label: plans === null ? 'Plans' : `Plans (${plans.length})`,
        },
      );
    }
    return tabs;
  }, [
    attachments,
    changesTabAvailable,
    changesTabLabel,
    chats,
    executions,
    plans,
    showCostTab,
    showExistingTabBar,
    summary?.archivedChatCount,
    summary?.chatCount,
    summary?.executionCount,
    topLevelExecutions.length,
  ]);

  // Like the chat list: land on the first plan when the list loads without a
  // selection (or when the selection no longer exists).
  useEffect(() => {
    if (effectiveTab !== 'plans' || plans === null || plans.length === 0) {
      return;
    }
    if (
      selectedPlanId !== undefined &&
      plans.some((plan) => plan.id === selectedPlanId)
    ) {
      return;
    }
    selectPlan(plans[0].id);
  }, [effectiveTab, plans, selectPlan, selectedPlanId]);
  const selectedPlan =
    selectedPlanId !== undefined
      ? (plans?.find((plan) => plan.id === selectedPlanId) ?? null)
      : null;

  const {
    hoveredPath,
    anchorRef,
    handleMouseEnter: attachmentMouseEnter,
    handleMouseLeave: attachmentMouseLeave,
    popoverMouseEnter,
    popoverMouseLeave,
  } = useAttachmentHover();
  const hoveredAttachment = hoveredPath
    ? attachments?.find((attachment) => attachment.absolutePath === hoveredPath)
    : undefined;
  const [openedAttachmentPath, setOpenedAttachmentPath] = useState<
    string | null
  >(null);
  const openedAttachment =
    openedAttachmentPath !== null
      ? (attachments?.find(
          (attachment) => attachment.absolutePath === openedAttachmentPath,
        ) ?? null)
      : null;
  useEffect(() => {
    setOpenedAttachmentPath(null);
  }, [workspaceId, containerId, effectiveTab]);
  const [openExecutionId, setOpenExecutionId] = useState<string | null>(null);
  const archivedSource = useMemo(
    () => ({ projectId: workspaceId, containerId }),
    [workspaceId, containerId],
  );

  // ----- App Advisor UI-state reporting -----
  const uiStateSlice = useMemo(
    () => ({
      count: containerCount,
      viewerOpen: true,
      // The overview list always sits beneath an open viewer (Back lands on
      // it), so it is reported as open alongside the viewer.
      overviewOpen: true,
      workspaceId,
      viewerKind: kind,
      viewerTab: effectiveTab,
      viewerLocked: locked,
      ...(selectedChatId !== undefined ? { selectedChatId } : {}),
      ...(selectedPlanId !== undefined ? { selectedPlanId } : {}),
    }),
    [
      containerCount,
      kind,
      effectiveTab,
      locked,
      selectedChatId,
      selectedPlanId,
      workspaceId,
    ],
  );
  useCurrentUiStateReporter('archivedContainers', uiStateSlice);

  const deleteTarget = `${workspaceId}:${containerId}`;
  const [confirmingDeleteTarget, setConfirmingDeleteTarget] = useState<
    string | null
  >(null);
  const confirmingDelete = confirmingDeleteTarget === deleteTarget;

  const selectedChatSummary =
    selectedChatId !== undefined
      ? chats?.find((chat) => chat.chatId === selectedChatId)
      : undefined;

  // The chat list is a persistent left nav: land on the first non-archived
  // chat when possible. Pre-archived inner chats remain collapsed by default,
  // so never auto-select one that is hidden behind that disclosure.
  useEffect(() => {
    if (
      hasRestoreTarget ||
      effectiveTab !== 'chats' ||
      activeChats.length === 0
    ) {
      return;
    }
    if (
      selectedChatId !== undefined &&
      chats?.some((chat) => chat.chatId === selectedChatId)
    ) {
      return;
    }
    selectChat(activeChats[0].chatId);
  }, [
    hasRestoreTarget,
    effectiveTab,
    activeChats,
    chats,
    selectedChatId,
    selectChat,
  ]);

  // Display rule matches live worktree rows: explicit label wins, otherwise
  // the recorded branch runs through the branch display-name mapper.
  const getBranchDisplayName = useBranchDisplayStore((s) => s.getDisplayName);
  const mappingsVersion = useBranchDisplayStore((s) => s.mappingsVersion);
  const displayName = useMemo(
    () =>
      summary !== undefined
        ? getArchivedContainerDisplayName(summary, getBranchDisplayName)
        : 'Archived item',
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mappingsVersion invalidates the mapper cache
    [summary, getBranchDisplayName, mappingsVersion],
  );

  return (
    <Surface
      variant="pane"
      extent="parent"
      data-testid="archived-container-view"
      className="flex min-h-0 flex-col"
    >
      {/* Header */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2">
        {kind === 'worktree' ? (
          <BranchIcon size="sm" className="shrink-0 fg-secondary" />
        ) : (
          <ChatIcon size="sm" className="shrink-0 fg-secondary" />
        )}
        <span
          className={`${POSTHOG_REPLAY_MASK_CLASS} min-w-0 truncate text-s font-medium fg-primary`}
        >
          {displayName}
        </span>
        {summary?.branchName !== undefined &&
          summary.branchName !== '' &&
          summary.branchName !== displayName && (
            <span className="text-xs fg-secondary">
              <span className={`${POSTHOG_REPLAY_MASK_CLASS} font-mono`}>
                {summary.branchName}
              </span>
            </span>
          )}
        {baseBranches.map((baseBranch) => {
          const branchLabel = baseBranch.branchName ?? 'unavailable';
          const repositoryLabel = showBaseRepositoryNames
            ? `${baseBranch.repoName}: `
            : '';
          const title =
            baseBranch.status === 'complete'
              ? `${repositoryLabel}base branch ${baseBranch.branchName} at ${baseBranch.commit}`
              : `${repositoryLabel}base branch ${branchLabel}; archive-time commit unavailable`;
          return (
            <span
              className="text-xs fg-secondary"
              key={baseBranch.repoId}
              data-testid={`archived-base-branch-${baseBranch.repoId}`}
              title={title}
            >
              <span className="font-mono">
                {repositoryLabel}Base {branchLabel}
                {baseBranch.status === 'complete'
                  ? ` @ ${baseBranch.commit.slice(0, 8)}`
                  : ' @ unavailable'}
              </span>
            </span>
          );
        })}
        {/* Immutable archive-time pull requests, refreshed on demand. Read
            only: the badge links out to the captured URL through the shared
            external-open path and renders the same state colors and rich
            tooltip as the live worktree top bar. */}
        {pullRequestEntries.map((entry) => {
          const number = entry.live?.prNumber ?? entry.captured?.number;
          const url = entry.live?.prUrl ?? entry.captured?.url;
          const state = entry.live?.state ?? entry.captured?.state;
          if (
            number === undefined ||
            url === undefined ||
            state === undefined
          ) {
            return null;
          }
          const live = entry.live;
          // Live status carries the CI/review/merge-readiness the shared
          // tooltip renders; a capture-only entry says so explicitly instead
          // of implying "no checks, no reviews".
          const tooltipPr: WorktreeRowPrStatus | null =
            live !== null
              ? {
                  state: live.state,
                  checkStatus: live.checkStatus,
                  reviewStatus: live.reviewStatus,
                  isMergeReady: isPrReadyToMerge(live),
                  url: live.prUrl,
                  label: `PR #${live.prNumber}`,
                  title: live.title,
                  ...(live.body ? { description: live.body } : {}),
                  ciStatus: live.checkStatus,
                  unresolvedCommentCount: live.unresolvedReviewThreadCount ?? 0,
                  hasConflicts: live.hasConflicts,
                }
              : null;
          const capturedDescription = getArchivedPullRequestRowDescription(
            state,
            formatDateOrEmpty(pullRequestCapturedAt),
          );
          return (
            <span
              key={entry.repoId}
              data-testid={`archived-pr-${entry.repoId}`}
              className="flex shrink-0 items-center gap-1.5"
            >
              {showPullRequestRepositoryNames && (
                <span className="text-2xs fg-secondary">{entry.repoName}</span>
              )}
              <RichHoverTooltip
                dataTestId={`archived-pr-tooltip-${entry.repoId}`}
                surfaceClassName="min-w-65 max-w-85"
                surfacePadding="card"
                content={
                  tooltipPr !== null ? (
                    <PrBadgeTooltipContent pr={tooltipPr} />
                  ) : (
                    <Stack gap="tight">
                      {entry.captured !== null && (
                        <div className="font-medium fg-primary">
                          {entry.captured.title}
                        </div>
                      )}
                      <span className="fg-secondary">
                        {capturedDescription}
                      </span>
                    </Stack>
                  )
                }
              >
                <PrStateBadge state={state} prNumber={number} prUrl={url} />
              </RichHoverTooltip>
            </span>
          );
        })}
        {changesBadge !== null && (
          <span
            data-testid="archived-header-diff-badge"
            title={getArchivedGitChangesTooltip(changesBadge)}
            aria-label={getArchivedGitChangesTooltip(changesBadge)}
            className="shrink-0"
          >
            <DiffCounts
              stats={{
                insertions: changesBadge.insertions,
                deletions: changesBadge.deletions,
              }}
            />
          </span>
        )}
        {/* Retained state: "Archived" (kept until deleted) or "Deleted"
            (removed at expiry). Same icon vocabulary as the overview list
            and the row menus, with the rich tooltip spelling out what each
            state means for the retained data. */}
        <RichHoverTooltip
          dataTestId="archived-state-tooltip"
          surfaceClassName="min-w-55 max-w-80"
          surfacePadding="card"
          content={
            <Stack gap="tight">
              <div className="font-medium fg-primary">
                {getArchivedContainerStateLabel(archivedState)}
              </div>
              <span className="fg-secondary">
                {getArchivedContainerStateDescription(
                  archivedState,
                  formatDateOrEmpty(summary?.expiresAt),
                )}
              </span>
            </Stack>
          }
        >
          <span
            data-testid="archived-state-badge"
            data-state={archivedState}
            className="flex shrink-0"
          >
            <Badge
              tone={locked ? 'info' : 'danger'}
              icon={locked ? ArchiveIcon : TrashIcon}
            >
              {locked
                ? `Archived ${formatDateOrEmpty(summary?.lockedAt)}`
                : `Deleted ${formatDateOrEmpty(summary?.archivedAt)}`}
            </Badge>
          </span>
        </RichHoverTooltip>
        {!locked && summary?.expiresAt !== undefined && (
          <span className="shrink-0 text-2xs fg-secondary">
            · Removed {formatDateOrEmpty(summary.expiresAt)}
          </span>
        )}
        <span
          data-testid="archived-disk-usage"
          className="shrink-0 text-2xs fg-secondary"
          title="Measured archive footprint; retained Git objects may be shared"
        >
          {diskUsageBytes !== null
            ? `· ${diskUsageComplete ? '' : 'At least '}${formatByteSize(diskUsageBytes, { precision: 'adaptive' })} on disk`
            : '· Measuring size…'}
        </span>
        {/* Same shell as the worktree top bar's git actions
            (`HeaderActionButton`): 28px pill, ghost tone, icon + label. */}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <HeaderActionButton
            tone="neutral"
            data-testid="archived-state-toggle"
            onClick={() => void archiveActions.setArchived(!locked)}
            disabled={archiveActions.changingState}
            title={
              locked
                ? 'Delete — kept for the retention window, then removed unless restored'
                : 'Archive — kept until you delete it'
            }
          >
            {archiveActions.changingState ? (
              <RunningActionIcon
                cancellationRequested
                spinnerTone="secondary"
              />
            ) : locked ? (
              <TrashIcon size="sm" aria-hidden="true" />
            ) : (
              <ArchiveIcon size="sm" aria-hidden="true" />
            )}
            {locked ? 'Delete' : 'Archive'}
          </HeaderActionButton>
          <HeaderActionButton
            tone="accent"
            data-testid="archived-restore"
            onClick={() => void archiveActions.restore()}
            disabled={archiveActions.restoring}
            title={
              gitCleanupOnly
                ? 'Try cleaning up the archived Git worktree registration again'
                : partiallyRestored
                  ? 'Try importing the workflow runs into the restored worktree again'
                  : 'Bring this item back as a live worktree or chat'
            }
          >
            {archiveActions.restoring ? (
              <RunningActionIcon cancellationRequested spinnerTone="accent" />
            ) : (
              <RefreshIcon size="sm" aria-hidden="true" />
            )}
            {archiveActions.restoring
              ? 'Restoring…'
              : gitCleanupOnly
                ? 'Try Git cleanup again'
                : partiallyRestored
                  ? 'Try workflow import again'
                  : 'Restore'}
          </HeaderActionButton>
          {confirmingDelete ? (
            <InlineDeleteConfirm
              onConfirm={() => void archiveActions.deletePermanently()}
              onCancel={() => setConfirmingDeleteTarget(null)}
              deleting={archiveActions.deleting}
            />
          ) : (
            <HeaderActionButton
              tone="destructive"
              data-testid="archived-delete-permanently"
              onClick={() => setConfirmingDeleteTarget(deleteTarget)}
              title="Delete permanently: remove this item and its retained history for good"
            >
              <TrashPermanentlyIcon size="sm" aria-hidden="true" />
              Permanent
            </HeaderActionButton>
          )}
          <HeaderActionButton
            tone="neutral"
            data-testid="archived-container-view-close"
            onClick={onClose}
            title="Back to Archived and deleted"
          >
            <BackIcon size="sm" aria-hidden="true" />
            Back
          </HeaderActionButton>
        </div>
      </div>

      {(summary?.version === 3 || partiallyRestored) && (
        <div className="flex shrink-0 flex-col gap-4 px-4 py-2">
          {summary?.version === 3 && (
            <Notice
              intent="attention"
              data-testid="archived-file-recovery-banner"
            >
              {summary.recovery.source === 'absent'
                ? 'Restore brings back the remaining chats and saved artifacts. The original checkout is unavailable.'
                : 'Restore brings back the remaining files. Git history and staging require separate recovery.'}
              {summary.recovery.gitCleanupPending &&
                ' Git registration cleanup is still pending.'}
            </Notice>
          )}

          {partiallyRestored && (
            <Notice
              intent="attention"
              data-testid="archived-partial-restore-banner"
            >
              Partially restored — workflow runs pending
            </Notice>
          )}
        </div>
      )}

      {showTabBar && (
        // The Cost tab overlays the stored tab without replacing it.
        <TabBar
          items={viewerTabs.map((tab) => ({
            id: tab.id,
            label: tab.label,
            dataTestId: `archived-container-tab-${tab.id}`,
          }))}
          value={costTabSelected ? 'cost' : effectiveTab}
          onChange={(next): void => {
            if (next === 'cost') {
              setCostTabScopeKey(retainedCostScopeKey);
              return;
            }
            setCostTabScopeKey(null);
            selectTab(next);
          }}
          label="Archive contents"
          density="compact"
          inset="dialog"
        />
      )}

      {/* Body */}
      {costTabSelected ? (
        <div
          data-testid="archived-container-cost-view"
          className="flex min-h-0 flex-1"
        >
          <RetainedCostView
            client={desktopCostClient}
            navigator={DESKTOP_COST_NAVIGATOR}
            scope={retainedCostScope}
            selectedRow={selectedRetainedCostRow}
            onSelectRow={(target) =>
              setRetainedCostSelection({
                scopeKey: retainedCostScopeKey,
                target,
              })
            }
            appName={brandText.shortName}
          />
        </div>
      ) : effectiveTab === 'attachments' &&
        openedAttachment !== null &&
        attachments !== null ? (
        <ArchivedAttachmentViewer
          workspaceId={workspaceId}
          containerId={containerId}
          attachment={openedAttachment}
          attachments={attachments}
          onSelectAttachment={(attachment) =>
            setOpenedAttachmentPath(attachment.absolutePath)
          }
          onClose={() => setOpenedAttachmentPath(null)}
        />
      ) : effectiveTab === 'changes' ? (
        <Suspense
          fallback={
            <div className="flex min-h-30 flex-1 items-center justify-center">
              <LoadingSpinner tone="secondary" />
            </div>
          }
        >
          <ArchivedChangesView
            workspaceId={workspaceId}
            containerId={containerId}
            gitChanges={gitChanges}
          />
        </Suspense>
      ) : effectiveTab === 'chats' ? (
        chats === null ? (
          <DelayedLoadingPlaceholder slowNote="Still loading chats…">
            <ArchivedNavListSkeleton
              label="Loading chats"
              testId="archived-chats-loading"
            />
          </DelayedLoadingPlaceholder>
        ) : chats.length === 0 ? (
          <div className="flex min-h-30 flex-1 items-center justify-center text-s fg-secondary">
            No chats were retained with this archive.
          </div>
        ) : (
          <div className="flex min-h-0 flex-1">
            {/* Chat left nav: persistent list for quick transcript switching. */}
            <Surface
              variant="section"
              boundary="right"
              padding="tight"
              gap="tight"
              data-testid="archived-chat-nav"
              className="w-64 shrink-0 overflow-y-auto [&>*]:shrink-0"
            >
              {activeChats.length > 0 && (
                <div>
                  {activeChats.map((chat) => {
                    const provider = toStandaloneRowProvider(chat.providerType);
                    const providerIcon =
                      provider === 'codex'
                        ? STANDALONE_CODEX_PROVIDER_ICON
                        : provider === 'claude'
                          ? STANDALONE_CLAUDE_PROVIDER_ICON
                          : null;
                    const isSelected = chat.chatId === selectedChatId;
                    return (
                      <ListRow
                        key={chat.chatId}
                        data-testid={`archived-chat-row-${chat.chatId}`}
                        onClick={() => selectChat(chat.chatId)}
                        selected={isSelected}
                        aria-current={isSelected ? 'true' : undefined}
                        icon={providerIcon ?? undefined}
                      >
                        {getArchivedChatDisplayLabel(chat)}
                      </ListRow>
                    );
                  })}
                </div>
              )}
              {archivedInnerChats.length > 0 && (
                <div className="pl-2">
                  <Disclosure
                    open={archivedChatsExpanded}
                    onOpenChange={setArchivedChatsExpanded}
                    label={`Archived (${archivedInnerChats.length})`}
                    dataTestId="archived-inner-chats"
                    toggleTestId="archived-inner-chats-toggle"
                  >
                    <div className="flex flex-col">
                      {archivedInnerChats.map((chat) => {
                        const provider = toStandaloneRowProvider(
                          chat.providerType,
                        );
                        const providerIcon =
                          provider === 'codex'
                            ? STANDALONE_CODEX_PROVIDER_ICON
                            : provider === 'claude'
                              ? STANDALONE_CLAUDE_PROVIDER_ICON
                              : null;
                        const isSelected = chat.chatId === selectedChatId;
                        return (
                          <ListRow
                            key={chat.chatId}
                            data-testid={`archived-chat-row-${chat.chatId}`}
                            onClick={() => selectChat(chat.chatId)}
                            selected={isSelected}
                            aria-current={isSelected ? 'true' : undefined}
                            icon={providerIcon ?? undefined}
                          >
                            {getArchivedChatDisplayLabel(chat)}
                          </ListRow>
                        );
                      })}
                    </div>
                  </Disclosure>
                </div>
              )}
            </Surface>

            {/* Transcript pane owns the viewport and title insets. */}
            <div className="flex min-h-0 flex-1 flex-col px-4 pb-4">
              <div className="flex shrink-0 items-center gap-2 py-2">
                <span className="min-w-0 truncate text-xs font-medium fg-primary/85">
                  {selectedChatSummary !== undefined
                    ? getArchivedChatDisplayLabel(selectedChatSummary)
                    : (transcriptTab?.title ?? '')}
                </span>
                {selectedChatSummary !== undefined && (
                  <span className="ml-auto shrink-0 text-2xs fg-secondary">
                    Archived {formatDateOrEmpty(selectedChatSummary.archivedAt)}
                  </span>
                )}
              </div>
              {/* Explicit-height flex column: ChatMessageList's scroller is
                  `absolute inset-0` and needs a resolved height. */}
              <Surface
                variant="group"
                className="flex flex-col min-h-0 flex-1 overflow-hidden"
              >
                {transcriptLoading ? (
                  <div className="flex flex-1 items-center justify-center">
                    <LoadingSpinner tone="secondary" />
                  </div>
                ) : transcriptTab !== null ? (
                  <Suspense
                    fallback={
                      <div className="flex flex-1 items-center justify-center">
                        <LoadingSpinner tone="secondary" />
                      </div>
                    }
                  >
                    <ChatMessageList
                      pagingControls={
                        <TranscriptPagingControls
                          needsLoad={Boolean(
                            transcriptTab?.transcript &&
                            transcriptTab.transcriptWindow?.view !== 'turns',
                          )}
                          loading={pagingLoading && turnPageId === null}
                          suspended={pagingLoading}
                          error={turnPageId === null ? pagingError : null}
                          hasEarlier={
                            transcriptTab.transcriptWindow?.before !== undefined
                          }
                          onLoadEarlier={() => void loadTranscriptPage(true)}
                          onReload={() => void loadTranscriptPage(false)}
                        />
                      }
                      transcriptTurns={transcriptTab?.transcriptWindow?.turns}
                      onLoadTurn={loadTranscriptTurn}
                      turnPageId={turnPageId}
                      turnLoading={pagingLoading}
                      turnError={pagingError}
                      targetOverride={{
                        projectId: workspaceId,
                        worktreeId: containerId,
                        chatId: transcriptTab.id,
                      }}
                      archivedContainerId={containerId}
                      messages={transcriptTab.messages}
                      queuedMessages={[]}
                      chatId={transcriptTab.id}
                      agentUsage={transcriptTab.agentUsage}
                      turnDiffs={transcriptTab.turnDiffs}
                      onClearQueuedMessage={() => undefined}
                    />
                  </Suspense>
                ) : (
                  <div className="flex flex-1 items-center justify-center text-s fg-secondary">
                    {selectedChatId !== undefined
                      ? 'Archived chat is unavailable.'
                      : 'Select a chat to view its transcript.'}
                  </div>
                )}
              </Surface>
            </div>
          </div>
        )
      ) : effectiveTab === 'pipelines' ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {executions === null ? (
            <DelayedLoadingPlaceholder slowNote="Still loading workflow runs…">
              <ArchivedExecutionListSkeleton />
            </DelayedLoadingPlaceholder>
          ) : topLevelExecutions.length === 0 ? (
            <div className="flex min-h-30 items-center justify-center text-s fg-secondary">
              No workflow runs were retained with this archive.
            </div>
          ) : (
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-1.5">
              {topLevelExecutions.map((execution) => (
                <ArchivedExecutionRow
                  key={execution.id}
                  summary={execution}
                  executionState={executionRowsById[execution.id]}
                  onOpen={setOpenExecutionId}
                />
              ))}
            </div>
          )}
        </div>
      ) : effectiveTab === 'attachments' ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {attachments === null ? (
            <DelayedLoadingPlaceholder slowNote="Still loading attachments…">
              <ArchivedAttachmentListSkeleton />
            </DelayedLoadingPlaceholder>
          ) : attachments.length === 0 ? (
            <div className="flex min-h-30 items-center justify-center text-s fg-secondary">
              No attachments were retained with this archive.
            </div>
          ) : (
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-1.5">
              {attachments.map((attachment) => (
                <ArchivedAttachmentRow
                  key={attachment.filename}
                  filename={attachment.filename}
                  createdAt={attachment.createdAt}
                  onMouseEnter={(event): void =>
                    attachmentMouseEnter(
                      attachment.absolutePath,
                      event.currentTarget,
                    )
                  }
                  onMouseLeave={attachmentMouseLeave}
                  onReveal={() =>
                    void window.api.showInFinder({
                      absolutePath: attachment.absolutePath,
                    })
                  }
                />
              ))}
              {hoveredPath && (
                <AttachmentPreviewPopover
                  absolutePath={hoveredPath}
                  filename={hoveredAttachment?.filename}
                  sizeBytes={hoveredAttachment?.sizeBytes}
                  createdAt={hoveredAttachment?.createdAt}
                  anchorRef={anchorRef}
                  onOpen={() => {
                    if (hoveredAttachment) {
                      setOpenedAttachmentPath(hoveredAttachment.absolutePath);
                    }
                  }}
                  onMouseEnter={popoverMouseEnter}
                  onMouseLeave={popoverMouseLeave}
                />
              )}
            </div>
          )}
        </div>
      ) : plans === null ? (
        <DelayedLoadingPlaceholder slowNote="Still loading plans…">
          <ArchivedNavListSkeleton
            label="Loading plans"
            testId="archived-plans-loading"
          />
        </DelayedLoadingPlaceholder>
      ) : plans.length === 0 ? (
        <div className="flex min-h-30 flex-1 items-center justify-center text-s fg-secondary">
          No plans were retained with this archive.
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* Plan left nav: persistent list for quick plan switching. */}
          <Surface
            variant="section"
            boundary="right"
            padding="tight"
            gap="tight"
            data-testid="archived-plan-nav"
            className="w-64 shrink-0 overflow-y-auto [&>*]:shrink-0"
          >
            {plans.map((plan) => {
              const isSelected = plan.id === selectedPlanId;
              return (
                <ListRow
                  key={plan.id}
                  data-testid={`archived-plan-row-${plan.id}`}
                  onClick={() => selectPlan(plan.id)}
                  selected={isSelected}
                  icon={<PlanSourceMark source={plan.source} />}
                >
                  <Markdown options={INLINE_PLAN_MARKDOWN_OPTIONS}>
                    {plan.title}
                  </Markdown>
                </ListRow>
              );
            })}
          </Surface>

          {/* Document pane for the selected plan. */}
          <div
            className={`flex min-h-0 flex-1 flex-col ${selectedPlan !== null ? 'px-4 pb-4' : ''}`}
          >
            {selectedPlan !== null ? (
              <>
                <div className="flex shrink-0 items-center gap-2 py-2">
                  <span className="min-w-0 truncate text-xs font-medium fg-primary/85">
                    <Markdown options={INLINE_PLAN_MARKDOWN_OPTIONS}>
                      {selectedPlan.title}
                    </Markdown>
                  </span>
                  <span className="ml-auto flex shrink-0 items-center gap-3 text-2xs fg-secondary">
                    <span>Rev {selectedPlan.latestRevisionNumber}</span>
                    <span>{selectedPlan.reviewStatus}</span>
                    <span>
                      Updated {formatDateOrEmpty(selectedPlan.updatedAt)}
                    </span>
                  </span>
                </div>
                <Surface
                  variant="group"
                  className="min-h-0 flex-1 flex flex-col overflow-hidden"
                  data-testid="archived-plan-content"
                >
                  <div
                    className={`overflow-y-auto p-4 min-h-0 flex-1 ${POSTHOG_REPLAY_BLOCK_CLASS}`}
                  >
                    <div className="prose prose-sm [--tw-prose-body:var(--fg-primary)] dark:prose-invert max-w-none text-xs leading-5 fg-secondary prose-code:fg-success prose-code:before:content-none prose-code:after:content-none prose-headings:fg-primary/80 prose-strong:fg-primary/80">
                      <Markdown options={PLAN_MARKDOWN_OPTIONS}>
                        {stripPlanTitleLine(selectedPlan.content)}
                      </Markdown>
                    </div>
                  </div>
                </Surface>
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center text-s fg-secondary">
                Select a plan to view its contents.
              </div>
            )}
          </div>
        </div>
      )}

      {openExecutionId !== null && (
        <PipelineExecutionDetailModal
          executionId={openExecutionId}
          onClose={() => setOpenExecutionId(null)}
          archivedSource={archivedSource}
        />
      )}
    </Surface>
  );
}
