import { BaseBranchOptions } from '../worktree/BaseBranchOptions';
import { ControlButton } from '@canopy/ui-shared/components';
import { Surface } from '@canopy/ui-shared/components';
import { toAppError } from '@canopy/protocol/app-errors';
import {
  reportClientAppError,
  resolveClientAppError,
} from '@canopy/desktop-instrumentation/client';
import {
  inlineFailure,
  inputFailure,
  type InlineFailure,
} from '@/lib/inline-app-error';
import { branchRenameRefusalText } from '@/lib/branch-rename-refusal';
import { branchNameProblem } from '@canopy/protocol/worktree-branch-names';
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactElement,
  type RefObject,
} from 'react';
import { useShallow } from 'zustand/shallow';
import {
  gitActionFailureRaiser,
  useGitHubStore,
  worktreeKey,
} from '@/stores/githubStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useActivityStore } from '@/stores/activityStore';
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  saveActivityPanelExpanded,
  type WorktreeViewMode,
} from '@/lib/worktree-layout-prefs';
import { BranchNotRenamedWarning } from './BranchNotRenamedWarning';
import { GitActionProgressTooltip } from './GitActionProgressTooltip';
import { shouldWarnBranchNotRenamed } from '@/lib/branchRenameWarning';
import {
  repoCanMergeLocalBranch,
  repoRequiresCommitOnly,
} from '@/lib/githubBranchActions';
import {
  AlignBaseBranchConfirmation,
  BaseBranchDriftWarning,
  HEADER_PRIORITY,
  PullRequestActions,
  PullRequestCreateAction,
  planPullRequestActions,
  type PullRequestActionRequest,
  type PullRequestActionsActivity,
  type PullRequestActionsFacts,
  type PullRequestActionsPr,
  type PullRequestActionsRepo,
  type PullRequestBranchFacts,
  type PullRequestProgressRenderer,
  type PullRequestProgressTarget,
} from '@canopy/ui-app/pull-requests';
import type {
  AppAdvisorJson,
  BranchEntry,
  RepoBranchInfo,
} from '@canopy/desktop-shared/types';
import { isDefaultWorktreeBranchName } from '@canopy/desktop-shared/lib/default-worktree-branch';
import type { MergePrVerifiedRepo } from '@canopy/desktop-shared/types/github';
import {
  SPLIT_PR_BLOCKER_COPY,
  hasUnresolvedReviewThreads,
  isPrInMergeQueue,
  type PrStatusData,
  type WorktreePrStatus,
} from '@canopy/desktop-shared/types/github';
import { isPrReadyToMerge } from '@/lib/pr-mergeability';
import {
  buildHookEntries,
  isPrHookActiveForRepo,
} from '@/components/activity/hook-utils';
import { useMergeQueueAgentHandling } from '@/hooks/useMergeQueueAgentHandling';
import { resolvePrMergeRoute, type PrMergeRoute } from './mergeButtonRoute';
import {
  Stack,
  ActionMenuRowStyle,
  Button,
  ConfirmDialog,
  MenuItem,
  MenuItemIcon,
  Menu,
  InlineTextInput,
  Tooltip,
  type WorktreeRowPrStatus,
} from '@canopy/ui-shared/components';
import {
  BranchIcon,
  CheckIcon,
  ChevronRightMediumIcon,
  CopyIcon,
  InfoIcon,
  PencilIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { OpenDropdown } from '@/components/worktree/OpenDropdown';
import { mergeQueueBadgeFields } from '@/components/worktree/worktreePrBadge';
import { MergeQueueStatusControl } from './MergeQueueStatusControl';
import type { QueuedPullRequest } from './mergeQueueStatusModel';
import { ArchivedChatsControl } from '@/components/chat/ArchivedChatsControl';

import { ProjectIcon } from '@/components/shared/ProjectIcon';
import { useTopBarLeadingInsetClassName } from '@/components/panels/useTopBarLeadingInsetClassName';
import { useClipboardCopy } from '@/hooks/useClipboardCopy';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import {
  useBaseBranchAlignmentStore,
  type BaseBranchAlignmentDrift,
} from '@/stores/baseBranchAlignmentStore';
import { useCanopyDesktopPrSplitEnabled } from '@/hooks/useCanopyDesktopPrSplitEnabled';
import {
  collapseBranchDuplicates,
  findBranchPresence,
  preserveBranchOption,
} from '@/components/worktree/branch-options';
import { Picker } from '@canopy/ui-shared';
import {
  HoverCard,
  type HoverCardTriggerProps,
} from '@canopy/ui-shared/components';
import { setWorktreeBaseBranch } from '@/lib/setWorktreeBaseBranch';
import { ipcCanopyClient } from '@/client/ipc-canopy-client';
import {
  isWorktreeSurfaceVisible,
  useIsWorktreeSurfaceVisible,
} from '@/lib/worktreeSurfaceVisibility';
import type { BaseBranchChangeChoice } from '@/stores/baseBranchChangeStore';
import { useSplitPrReadiness } from '@/hooks/useSplitPrReadiness';
import { WorktreeBranchTargetPicker } from '@/components/home/HomeBranchPicker';
import { useWorktreeBranchChange } from './useWorktreeBranchChange';
import { LocalOnlyMergeConfirmationModal } from './LocalOnlyMergeConfirmationModal';
import { PrMergeWarningModal } from './PrMergeWarningModal';
import { PrMergeMultiRepoModal } from './PrMergeMultiRepoModal';
import { POSTHOG_REPLAY_MASK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { useWorktreeEffective } from '@/hooks/useWorktreeEffective';

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

function resolveBaseBranchLabel(
  isMultiRepo: boolean,
  baseBranch: string | null | undefined,
  repoBranches: RepoBranchInfo[] | undefined,
): string | null {
  if (isMultiRepo && repoBranches && repoBranches.length > 0) {
    const bases = Array.from(
      new Set(
        repoBranches
          .map((rb) => rb.baseBranch)
          .filter((b): b is string => Boolean(b)),
      ),
    );
    if (bases.length === 1) return bases[0];
    if (bases.length > 1) return 'Multiple bases';
    return null;
  }
  return baseBranch ?? null;
}

type BaseBranchDrift = BaseBranchAlignmentDrift;

function areBaseBranchDriftsEqual(
  left: BaseBranchDrift[],
  right: BaseBranchDrift[],
): boolean {
  if (left.length !== right.length) return false;
  const rightByRepo = new Map(right.map((drift) => [drift.repoId, drift]));
  return left.every((drift) => {
    const candidate = rightByRepo.get(drift.repoId);
    return (
      candidate?.repoName === drift.repoName &&
      candidate.localBaseBranch === drift.localBaseBranch &&
      candidate.prBaseBranch === drift.prBaseBranch &&
      candidate.prNumber === drift.prNumber
    );
  });
}

interface PendingPrBaseUpdate {
  projectId: string;
  worktreeId: string;
  prNumber: number;
  previousBaseBranch: string;
  targetBaseBranch: string;
}

/**
 * A base-branch mismatch split by whether the worktree has an *explicitly
 * persisted* tracked base branch.
 *
 * `conflicting` drifts are the ones the user chose (or a main-process
 * retarget wrote) and that now disagree with the PR — those keep the warning
 * and the confirmation modal, because silently overwriting a deliberate
 * choice is not ours to make.
 *
 * `adoptable` drifts have no persisted tracked value at all: the displayed
 * base is a derived guess (repo default / `main` fallback). The PR itself is
 * the better answer, so the bar adopts it automatically instead of nagging.
 */
interface BaseBranchDriftPartition {
  conflicting: BaseBranchDrift[];
  adoptable: BaseBranchDrift[];
}

const EMPTY_BASE_BRANCH_DRIFT_PARTITION: BaseBranchDriftPartition = {
  conflicting: [],
  adoptable: [],
};

function hasExplicitTrackedBase(
  isMultiRepo: boolean,
  repoId: string,
  trackedBaseBranch: string | null | undefined,
  trackedRepoBaseBranches: Record<string, string> | undefined,
): boolean {
  const tracked = isMultiRepo
    ? trackedRepoBaseBranches?.[repoId]
    : trackedBaseBranch;
  return typeof tracked === 'string' && tracked.trim().length > 0;
}

/**
 * False while a user-approved PR-base update is still settling: the local base
 * already moved to the new target and GitHub has not caught up yet, so the
 * "mismatch" is the update in flight, not real drift.
 */
function isBaseBranchDriftLive(
  drift: BaseBranchDrift,
  pendingPrBaseUpdate: PendingPrBaseUpdate | null,
  projectId: string,
  worktreeId: string,
): boolean {
  return (
    !pendingPrBaseUpdate ||
    pendingPrBaseUpdate.projectId !== projectId ||
    pendingPrBaseUpdate.worktreeId !== worktreeId ||
    drift.prNumber !== pendingPrBaseUpdate.prNumber ||
    drift.localBaseBranch !== pendingPrBaseUpdate.targetBaseBranch ||
    drift.prBaseBranch !== pendingPrBaseUpdate.previousBaseBranch
  );
}

function resolveBaseBranchDrifts({
  prStatus,
  isMultiRepo,
  baseBranch,
  repoBranches,
  trackedBaseBranch,
  trackedRepoBaseBranches,
}: {
  prStatus: WorktreePrStatus | null | undefined;
  isMultiRepo: boolean;
  baseBranch: string | null | undefined;
  repoBranches: RepoBranchInfo[] | undefined;
  // The *raw persisted* values, not the derived `baseBranches[key]` the bar
  // displays. The derived value already folded in the repo-default/`main`
  // fallback, so it cannot tell "never set" from "explicitly set to main".
  trackedBaseBranch: string | null | undefined;
  trackedRepoBaseBranches: Record<string, string> | undefined;
}): BaseBranchDriftPartition {
  if (!prStatus) return EMPTY_BASE_BRANCH_DRIFT_PARTITION;

  const conflicting: BaseBranchDrift[] = [];
  const adoptable: BaseBranchDrift[] = [];

  for (const repo of prStatus.repos) {
    const status = repo.status;
    if (
      !status ||
      (status.state !== 'open' && status.state !== 'draft') ||
      !status.baseRefName
    ) {
      continue;
    }

    const repoBranch = repoBranches?.find(
      (candidate) => candidate.repoId === repo.repoId,
    );
    const localBaseBranch = (
      isMultiRepo
        ? repoBranch?.baseBranch
        : (baseBranch ?? repoBranch?.baseBranch)
    )?.trim();
    const prBaseBranch = status.baseRefName.trim();
    if (!localBaseBranch || !prBaseBranch || localBaseBranch === prBaseBranch) {
      continue;
    }

    const drift: BaseBranchDrift = {
      repoId: repo.repoId,
      repoName: repo.repoName,
      localBaseBranch,
      prBaseBranch,
      prNumber: status.prNumber,
    };
    if (
      hasExplicitTrackedBase(
        isMultiRepo,
        repo.repoId,
        trackedBaseBranch,
        trackedRepoBaseBranches,
      )
    ) {
      conflicting.push(drift);
    } else {
      adoptable.push(drift);
    }
  }

  return { conflicting, adoptable };
}

/** Header pill name for a worktree still on its generated default branch. */
const NEW_BRANCH_DISPLAY_NAME = 'New branch';

function resolveBranchLabel(
  isMultiRepo: boolean,
  worktreeId: string,
  worktreeBranchName: string,
  repoBranches: RepoBranchInfo[] | undefined,
): { label: string; rawLabel: string; hasMultiple: boolean } {
  const toLabel = (branchName: string): string =>
    isDefaultWorktreeBranchName(branchName, worktreeId)
      ? NEW_BRANCH_DISPLAY_NAME
      : branchName;

  if (isMultiRepo && repoBranches && repoBranches.length > 0) {
    const unique = new Set(repoBranches.map((rb) => rb.branch));
    if (unique.size === 1) {
      const branchName = repoBranches[0].branch;
      return {
        label: toLabel(branchName),
        rawLabel: branchName,
        hasMultiple: false,
      };
    }
    return {
      label: 'Multiple branches',
      rawLabel: 'Multiple branches',
      hasMultiple: true,
    };
  }
  return {
    label: toLabel(worktreeBranchName),
    rawLabel: worktreeBranchName,
    hasMultiple: false,
  };
}

// ---------------------------------------------------------------------------
// Hover card – shows branch → base per repo (multi-repo)
// ---------------------------------------------------------------------------

function RepoBranchesCard({
  repoBranches,
}: {
  repoBranches: RepoBranchInfo[];
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5 min-w-60 max-w-120">
      <div className="text-3xs font-semibold fg-secondary">Repo branches</div>
      <Stack gap="tight">
        {repoBranches.map((rb) => (
          <div
            key={rb.repoId}
            className="grid items-center gap-1.5 text-xs"
            style={{ gridTemplateColumns: '2fr auto 2fr auto 2fr' }}
          >
            <span className="min-w-0 truncate fg-primary">{rb.repoName}</span>
            <span className="shrink-0 fg-secondary/50">{'\u2192'}</span>
            <span
              className={`${POSTHOG_REPLAY_MASK_CLASS} min-w-0 truncate fg-secondary`}
            >
              {rb.branch}
            </span>
            <span className="shrink-0 fg-secondary/50">{'\u2192'}</span>
            <span className="min-w-0 truncate fg-secondary">
              {rb.baseBranch ?? '\u2014'}
            </span>
          </div>
        ))}
      </Stack>
    </div>
  );
}

/** The `contents` trigger wrapper has no box, so the card follows the label. */
function branchLabelInsideTrigger(trigger: HTMLElement): Element | null {
  return trigger.firstElementChild;
}

/**
 * The multi-repo branch label's hover card: each repo's branch and base.
 * `contents` keeps the label's own box, so it still truncates in the bar.
 */
function RepoBranchesHoverCard({
  repoBranches,
  children,
}: {
  repoBranches: RepoBranchInfo[];
  children: ReactElement<HoverCardTriggerProps>;
}): JSX.Element {
  return (
    <HoverCard
      triggerDisplay="contents"
      getPlacementAnchor={branchLabelInsideTrigger}
      elevation="menu"
      surfacePadding="card"
      surfaceClassName="w-max max-w-120"
      dataTestId="pr-status-bar-repo-branches"
      content={<RepoBranchesCard repoBranches={repoBranches} />}
    >
      {children}
    </HoverCard>
  );
}

// ---------------------------------------------------------------------------
// Popover – shows per-repo PR link + check status (multi-repo "X PRs" hover)
// ---------------------------------------------------------------------------

function toPrBadgeTooltipStatus(status: PrStatusData): WorktreeRowPrStatus {
  return {
    state: status.state,
    checkStatus: status.checkStatus,
    reviewStatus: status.reviewStatus,
    isMergeReady: isPrReadyToMerge(status),
    url: status.prUrl,
    label: `PR #${status.prNumber}`,
    title: status.title,
    ...(status.body ? { description: status.body } : {}),
    ciStatus: status.checkStatus,
    unresolvedCommentCount: status.unresolvedReviewThreadCount ?? 0,
    hasConflicts: status.hasConflicts,
    ...mergeQueueBadgeFields(status),
  };
}

/**
 * Fix, Resolve conflicts and Triage start agent chats on desktop: read from
 * the host's capabilities like other renderer gates outside the provider.
 */
const DESKTOP_PR_AGENT_HELPERS =
  ipcCanopyClient.capabilities.worktreePrAgentHelpers === true;

/** One PR as the shared header actions read it (REG-3025). */
function toHeaderPr(
  status: PrStatusData,
  mergeRoute: PrMergeRoute,
): PullRequestActionsPr {
  const position = status.mergeQueue?.position;
  return {
    number: status.prNumber,
    url: status.prUrl,
    state: status.state,
    checkStatus: status.checkStatus,
    checkDetails: status.checkDetails,
    readyToMerge: isPrReadyToMerge(status),
    inMergeQueue: isPrInMergeQueue(status),
    ...(typeof position === 'number' ? { mergeQueuePosition: position } : {}),
    hasConflicts: status.hasConflicts === true,
    reviewThreadsWarning:
      status.unresolvedReviewThreadCount === undefined ||
      hasUnresolvedReviewThreads(status),
    mergeRoute,
    reviewStatus: status.reviewStatus,
    tooltip: toPrBadgeTooltipStatus(status),
  };
}

// ---------------------------------------------------------------------------
// Base branch dropdown (portal-based, for single-repo)
// ---------------------------------------------------------------------------

/**
 * Stale-while-revalidate cache for the base-branch picker: reopening the
 * dropdown paints the previous list instantly while a fresh fetch replaces
 * it in the background, so the "Loading..." state only appears on the very
 * first open per worktree.
 */
const branchListCache = new Map<string, BranchEntry[]>();

function BaseBranchDropdownPortal({
  anchorRef,
  projectId,
  worktreeId,
  currentValue,
  onSelect,
  onClose,
}: {
  anchorRef: RefObject<HTMLButtonElement | null>;
  projectId: string;
  worktreeId: string;
  currentValue: string | null;
  onSelect: (
    branchName: string,
    presence: { existsLocally: boolean; existsInRemote: boolean },
  ) => void;
  onClose: () => void;
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const menuId = useId();
  const [branches, setBranches] = useState<BranchEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect((): void => {
    const cacheKey = `${projectId}/${worktreeId}`;
    const cached = branchListCache.get(cacheKey);
    if (cached) {
      setBranches(cached);
      setLoading(false);
    } else {
      setLoading(true);
    }
    void window.api
      .listBranches({ projectId, worktreeId })
      .then((resp) => {
        if (resp.branches) {
          branchListCache.set(cacheKey, resp.branches);
          setBranches(resp.branches);
        }
      })
      .finally(() => setLoading(false));
  }, [projectId, worktreeId]);

  const collapsed = useMemo(
    () =>
      preserveBranchOption(collapseBranchDuplicates(branches), currentValue),
    [branches, currentValue],
  );
  const handleSelect = (branchName: string): void => {
    const presence = findBranchPresence(branches, branchName);
    onSelect(branchName, {
      existsLocally: presence.hasLocalRef,
      existsInRemote: presence.hasRemoteRef,
    });
  };

  return (
    <Picker
      id={menuId}
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      anchorRef={anchorRef}
      placement="bottom-left"
      minimumWidth="260px"
      heightLimit={280}
      interaction="manual"
      initialFocusRef={inputRef}
      role="dialog"
      aria-modal="false"
      aria-label="Base branch selector"
      data-testid="pr-status-base-branch-menu"
    >
      <BaseBranchOptions
        branches={collapsed}
        currentValue={currentValue}
        inputRef={inputRef}
        loading={loading}
        onPick={handleSelect}
        onEscape={() => {
          onClose();
          anchorRef.current?.focus();
        }}
      />
    </Picker>
  );
}

// ---------------------------------------------------------------------------
// PR base branch update confirmation dialog
// ---------------------------------------------------------------------------

function UpdatePrBaseConfirmation({
  newBaseBranch,
  onConfirm,
  onDecline,
  onClose,
}: {
  newBaseBranch: string;
  onConfirm: () => void;
  onDecline: () => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <ConfirmDialog
      title="Update PR base branch?"
      message={
        <>
          This worktree has an open PR. Would you also like to update the PR
          base branch to <strong>{newBaseBranch}</strong>?
        </>
      }
      confirmLabel="Yes, update PR"
      onConfirm={onConfirm}
      secondaryAction={{ label: 'No, just locally', onSelect: onDecline }}
      onCancel={onClose}
      dataTestId="pr-status-update-pr-base-confirmation"
    />
  );
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

interface PrStatusBarProps {
  projectId: string;
  worktreeId: string;
  viewMode: WorktreeViewMode;
  viewModeReady: boolean;
}

const EMPTY_PAUSED_HOOK_KEYS: readonly string[] = [];

function repoHasOpenPr(repo: WorktreePrStatus['repos'][number]): boolean {
  return repo.status?.state === 'open' || repo.status?.state === 'draft';
}

/**
 * Breadcrumb label sizing.
 *
 * These were capped at a fixed FRACTION of the bar (`max-w-[25cqw]`, or
 * `50cqw` without PR actions), so a label truncated whether or not the room
 * was needed: measured at a 1600px window, the branch name was cut 4px short
 * while 533px of the row sat unused. The cap is gone — labels now take their
 * natural width and truncate only under real pressure, because `min-w-0`
 * lets them shrink below content.
 *
 * The breadcrumb must NOT be `flex-1`: it carries the row's `mr-auto`, and
 * auto margins absorb positive free space BEFORE `flex-grow` is distributed,
 * so a `flex-basis: 0` breadcrumb would collapse to nothing. Natural width
 * plus `min-w-0` gives the wanted behavior on both sides.
 */
const BRANCH_LABEL = 'min-w-0 truncate';

/**
 * The base branch yields space several times faster than the branch itself:
 * under pressure the worktree's own branch is the identifier worth keeping
 * legible.
 *
 * It keeps a small FLOOR so it degrades to an ellipsis instead of vanishing:
 * with `min-w-0` it collapsed to its 16px padding — zero characters — while
 * the chevron separator stayed, leaving an arrow pointing at nothing. The
 * branch pill itself still carries no min-width (a floor padded a short name
 * like `work` out past its label).
 */
const BASE_BRANCH_ITEM = 'min-w-14';

/**
 * Chevron + base branch travel together: hiding the label alone would strand
 * the separator. Below this width the pair drops entirely, one tier before
 * `Open in` goes.
 */
const BASE_BRANCH_GROUP =
  // The floor lives on the WRAPPER, not just the inner button: with
  // `min-w-0` here the wrapper collapsed to zero width and its content —
  // chevron plus the button's own 3.5rem floor — overflowed the wrapper and
  // painted over the action cluster. Chevron (1rem) + button floor.
  'hidden @[420px]/topbar:inline-flex min-w-18 items-center gap-1.5 shrink-6';

// ---------------------------------------------------------------------------
// SVG icon helpers
// ---------------------------------------------------------------------------

function isPrMergeWarningSurfaceVisible(
  projectId: string,
  worktreeId: string,
  isMounted: boolean,
): boolean {
  return isMounted && isWorktreeSurfaceVisible(projectId, worktreeId);
}

// ---------------------------------------------------------------------------
// PrStatusBar – main component
// ---------------------------------------------------------------------------

export const PrStatusBar = memo(function PrStatusBar({
  projectId,
  worktreeId,
  viewMode,
  viewModeReady,
}: PrStatusBarProps): JSX.Element {
  useWorktreeEffective(projectId, worktreeId);
  const key = `${projectId}/${worktreeId}`;
  const leadingInsetClassName = useTopBarLeadingInsetClassName();
  const activePage = useNavigationStore((state) => state.activePage);
  const settingsOpen = useNavigationStore((state) => state.settingsOpen);
  const selectedProjectId = useChatStore(
    (state) => state.selectedWorktree?.projectId,
  );
  const selectedWorktreeId = useChatStore(
    (state) => state.selectedWorktree?.worktreeId,
  );

  // ---- GitHub store ----
  const {
    prStatus,
    creatingPr,
    createPr,
    committingAndPushing,
    mergingLocalBranches,
    mergingPr,
    mergePr,
    gitStatsRefreshing,
    gitActionCancellationRequested,
    mergePrRefreshing,
    activeBranchSyncAction,
    commitReviewPending,
    prMergeWarning,
    openPrMergeWarning,
    clearPrMergeWarning,
  } = useGitHubStore(
    useShallow((state) => ({
      prStatus: state.prStatuses[key],
      creatingPr: state.creatingPr.has(key),
      createPr: state.createPr,
      committingAndPushing: state.committingAndPushing.has(key),
      mergingLocalBranches: state.mergingLocalBranches.has(key),
      mergingPr: state.mergingPr.has(key),
      mergePr: state.mergePr,
      gitStatsRefreshing: state.gitStatsRefreshing.has(key),
      gitActionCancellationRequested:
        state.gitActionCancellationRequested.has(key),
      mergePrRefreshing:
        state.mergePrProgress[key]?.currentPhase === 'refreshing_pr_status',
      activeBranchSyncAction: state.activeBranchSyncAction[key],
      commitReviewPending: Boolean(state.commitReviewPending[key]),
      prMergeWarning: state.prMergeWarnings[key] ?? null,
      openPrMergeWarning: state.openPrMergeWarning,
      clearPrMergeWarning: state.clearPrMergeWarning,
    })),
  );

  // ---- Projects store ----
  const {
    projectName,
    projectType,
    projectColor,
    projectTemporary,
    projectRepoPath,
    hasCommitsAhead,
    baseBranch,
    repoBranches,
    uncommittedChanges,
    hasRemoteTracking,
    hasOriginRemote,
    hasUnpushedCommits,
    hasUnpulledCommits,
    hasBranchBeenPushed,
    baseBranchExistsLocally,
    baseBranchExistsInRemote,
    trackedBaseBranch,
    trackedRepoBaseBranches,
  } = useProjectsStore(
    useShallow((state) => {
      const project = state.projects.find((p) => p.id === projectId);
      const trackedWorktree =
        project && project.type !== 'cowork'
          ? project.worktrees.find((w) => w.id === worktreeId)
          : undefined;
      return {
        projectName: project?.name ?? projectId,
        projectType: project?.type,
        projectColor: project?.color,
        projectTemporary:
          project?.type === 'multi-repo' && project.temporary === true,
        projectRepoPath:
          project?.type === 'single-repo' ? project.repoPath : undefined,
        hasCommitsAhead: state.commitsAhead[key] ?? false,
        baseBranch: state.baseBranches[key],
        repoBranches: state.repoBranches[key],
        uncommittedChanges: state.uncommittedChanges[key] ?? false,
        hasRemoteTracking: state.hasRemoteTracking[key] ?? false,
        // Default to true so unknown/legacy entries keep the existing
        // remote-backed behavior. The backend stamps `false` only when origin
        // is missing.
        hasOriginRemote: state.hasOriginRemote[key] ?? true,
        hasUnpushedCommits: state.hasUnpushedCommits[key] ?? false,
        hasUnpulledCommits: state.hasUnpulledCommits[key] ?? false,
        hasBranchBeenPushed: state.hasBranchBeenPushed[key] ?? false,
        baseBranchExistsLocally: state.baseBranchExistsLocally[key] ?? false,
        baseBranchExistsInRemote: state.baseBranchExistsInRemote[key] ?? false,
        // Raw persisted tracked values. Used only to tell an explicit user
        // choice apart from a never-set base, which decides whether a PR
        // mismatch warns or is adopted silently.
        trackedBaseBranch: trackedWorktree?.trackedBaseBranch,
        trackedRepoBaseBranches: trackedWorktree?.trackedRepoBaseBranches,
      };
    }),
  );
  const worktreeBranchName = useProjectsStore((state) => {
    const project = state.projects.find((p) => p.id === projectId);
    const wt =
      project && project.type !== 'cowork'
        ? project.worktrees.find((w) => w.id === worktreeId)
        : undefined;
    return wt?.branchName ?? '';
  });
  const requestBranchRename = useProjectsStore(
    (state) => state.requestBranchRename,
  );
  const requestBranchInfo = useProjectsStore(
    (state) => state.requestBranchInfo,
  );
  const setTrackedBaseBranch = useProjectsStore(
    (state) => state.setTrackedBaseBranch,
  );
  const isSingleRepoWorkspace = useProjectsStore(
    (state) =>
      state.projects.find((project) => project.id === projectId)?.type ===
      'single-repo',
  );
  // Blocker-only readiness (uncommitted changes / unpushed commits / merge
  // conflicts / active pipelines / active chats) plus overall eligibility
  // (threshold/toggle/open-PR/single-repo), shared with the worktree-row menu
  // item and PR activity panel button via `useSplitPrReadiness`. An eligible
  // but blocked worktree shows Split disabled with its blockers, as the PR
  // card's Split does.
  const splitPrReadiness = useSplitPrReadiness(
    projectId,
    worktreeId,
    isSingleRepoWorkspace,
  );
  const canopyDesktopPrSplitEnabled = useCanopyDesktopPrSplitEnabled();
  const headerSplitPr = useMemo(
    (): PullRequestActionsFacts['splitPr'] =>
      !canopyDesktopPrSplitEnabled || !splitPrReadiness.eligible
        ? null
        : splitPrReadiness.blockers.length === 0
          ? {}
          : {
              blockedReason: splitPrReadiness.blockers
                .map((blocker) => SPLIT_PR_BLOCKER_COPY[blocker])
                .join('\n'),
            },
    [canopyDesktopPrSplitEnabled, splitPrReadiness],
  );

  // ---- Activity store ----
  const openSplitPreflight = useActivityStore(
    (state) => state.openSplitPreflight,
  );
  const { panelExpanded, setPanelExpanded } = useActivityStore(
    useShallow((state) => ({
      panelExpanded: state.panelExpanded,
      setPanelExpanded: state.setPanelExpanded,
    })),
  );

  // ---- Derived state ----
  // Multi-repo detection
  const isMultiRepo =
    projectType === 'multi-repo' ||
    (prStatus
      ? prStatus.repos.length > 1
      : repoBranches
        ? repoBranches.length > 1
        : false);

  // Settings > Git decides whether Merge on a merge queue PR starts an agent
  // chat. By default that depends on whether a "PR Removed From Merge Queue"
  // hook would run for the PR's repository, so read the worktree's hooks.
  const mergeQueueAgentHandling = useMergeQueueAgentHandling();
  const { hookProject, appliedProjectWorktreeHooks, pausedHookKeys } =
    useProjectsStore(
      useShallow((state) => {
        const project = state.projects.find((p) => p.id === projectId);
        const worktree =
          project && project.type !== 'cowork'
            ? project.worktrees.find((w) => w.id === worktreeId)
            : undefined;
        return {
          hookProject: project,
          appliedProjectWorktreeHooks: state.appliedProjectWorktreeHooks,
          pausedHookKeys: worktree?.pausedHookKeys ?? EMPTY_PAUSED_HOOK_KEYS,
        };
      }),
    );
  const hookEntries = useMemo(
    () =>
      hookProject
        ? buildHookEntries(hookProject, worktreeId, appliedProjectWorktreeHooks)
        : [],
    [hookProject, worktreeId, appliedProjectWorktreeHooks],
  );
  const prMergeRoute = useCallback(
    (repo: WorktreePrStatus['repos'][number]): PrMergeRoute =>
      repo.status
        ? resolvePrMergeRoute({
            status: repo.status,
            handling: mergeQueueAgentHandling,
            queueRemovedHookActive: isPrHookActiveForRepo({
              entries: hookEntries,
              pausedHookKeys,
              isMultiRepo,
              repoId: repo.repoId,
              triggerName: 'pr:queue:removed',
            }),
          })
        : 'direct',
    [mergeQueueAgentHandling, hookEntries, pausedHookKeys, isMultiRepo],
  );

  // Synthetic single-repo `RepoBranchInfo` built from the worktree-level
  // aggregate fields. The plan requires populating every field consumed by
  // the helpers (`repoIsLocalOnly`, `repoRequiresCommitOnly`,
  // `repoCanMergeLocalBranch`, …) so the single-repo and multi-repo decision
  // paths can share the same logic.
  const singleRepoSyntheticBranch = useMemo<RepoBranchInfo | undefined>(() => {
    if (isMultiRepo) return undefined;
    const resolvedRepo = prStatus?.repos[0];
    return {
      repoId: resolvedRepo?.repoId ?? projectId,
      repoName: resolvedRepo?.repoName ?? projectName,
      branch: worktreeBranchName,
      baseBranch,
      hasUncommittedChanges: uncommittedChanges,
      hasUnpushedCommits,
      hasUnpulledCommits,
      commitsAhead: hasCommitsAhead,
      hasRemoteTrackingBranch: hasRemoteTracking,
      hasOriginRemote,
      hasBranchBeenPushed,
      baseBranchExistsLocally,
      baseBranchExistsInRemote,
    };
  }, [
    isMultiRepo,
    prStatus,
    projectId,
    projectName,
    worktreeBranchName,
    baseBranch,
    uncommittedChanges,
    hasUnpushedCommits,
    hasUnpulledCommits,
    hasCommitsAhead,
    hasRemoteTracking,
    hasOriginRemote,
    hasBranchBeenPushed,
    baseBranchExistsLocally,
    baseBranchExistsInRemote,
  ]);

  // Branch display
  const branchInfo = useMemo(
    () =>
      resolveBranchLabel(
        isMultiRepo,
        worktreeId,
        worktreeBranchName,
        repoBranches,
      ),
    [isMultiRepo, worktreeId, worktreeBranchName, repoBranches],
  );
  const currentBranchDisplay = branchInfo.label;
  const currentBranchRawLabel = branchInfo.rawLabel;
  const hasMultipleBranches = branchInfo.hasMultiple;

  // Base branch display
  const baseBranchDisplay = useMemo(
    () => resolveBaseBranchLabel(isMultiRepo, baseBranch, repoBranches),
    [isMultiRepo, baseBranch, repoBranches],
  );
  const hasMultipleBases = baseBranchDisplay === 'Multiple bases';

  // PR aggregation
  const openPrRepos = useMemo(
    () => (prStatus ? prStatus.repos.filter(repoHasOpenPr) : []),
    [prStatus],
  );
  // The queued PRs the merge queue status describes (its estimate and the
  // popover listing the queue), in place of Merge.
  const queuedPullRequests = useMemo(
    (): QueuedPullRequest[] =>
      openPrRepos.flatMap((repo) =>
        repo.status != null && isPrInMergeQueue(repo.status)
          ? [
              {
                repoId: repo.repoId,
                repoName: repo.repoName,
                status: repo.status,
              },
            ]
          : [],
      ),
    [openPrRepos],
  );
  const renderMergeQueueStatus = useCallback(
    (): JSX.Element => (
      <MergeQueueStatusControl pullRequests={queuedPullRequests} />
    ),
    [queuedPullRequests],
  );
  const baseBranchDriftPartition = useMemo(
    () =>
      resolveBaseBranchDrifts({
        prStatus,
        isMultiRepo,
        baseBranch,
        repoBranches,
        trackedBaseBranch,
        trackedRepoBaseBranches,
      }),
    [
      prStatus,
      isMultiRepo,
      baseBranch,
      repoBranches,
      trackedBaseBranch,
      trackedRepoBaseBranches,
    ],
  );
  const baseBranchDrifts = baseBranchDriftPartition.conflicting;
  const adoptableBaseBranchDrifts = baseBranchDriftPartition.adoptable;
  // Open PRs that GitHub currently considers mergeable. Drafts are excluded
  // because `isPrReadyToMerge` requires an `open` state. Declared here (rather
  // than with the other merge-button derivations below) so the merge click
  // handler can depend on it.
  const mergeableOpenPrRepos = useMemo(
    () =>
      openPrRepos.filter(
        (repo) => repo.status != null && isPrReadyToMerge(repo.status),
      ),
    [openPrRepos],
  );
  // Open PRs GitHub reports as conflicting. Declared here (alongside
  // mergeableOpenPrRepos) so the conflict-resolution click handler can depend
  // on it without a use-before-declaration error.
  const conflictingOpenPrRepos = useMemo(
    () => openPrRepos.filter((repo) => repo.status?.hasConflicts === true),
    [openPrRepos],
  );
  // The first open-PR repo with a failing CI check, used as the CI-fix target.
  // Declared here so the CI-fix click handler can depend on it.
  const ciFailingRepo = useMemo(
    () =>
      openPrRepos.find((repo) =>
        repo.status?.checkDetails.some((detail) => detail.status === 'failing'),
      ),
    [openPrRepos],
  );
  // Local-only commit/merge candidates.
  // - `localOnlyCommitRepoIds`: repos that need a local commit (no push).
  // - `localOnlyMergeCandidates`: repos eligible to merge into their default branch.
  // For single-repo worktrees these derive from the synthetic branch info; for
  // multi-repo workspaces they iterate `repoBranches`.
  const localOnlyCommitRepoIds = useMemo<string[]>(() => {
    if (isMultiRepo) {
      return (
        repoBranches
          ?.filter((branch) => repoRequiresCommitOnly(branch))
          .map((branch) => branch.repoId) ?? []
      );
    }
    return repoRequiresCommitOnly(singleRepoSyntheticBranch)
      ? [singleRepoSyntheticBranch?.repoId ?? projectId]
      : [];
  }, [isMultiRepo, repoBranches, singleRepoSyntheticBranch, projectId]);

  const localOnlyMergeCandidates = useMemo<RepoBranchInfo[]>(() => {
    if (isMultiRepo) {
      return (
        repoBranches?.filter((branch) => repoCanMergeLocalBranch(branch)) ?? []
      );
    }
    return repoCanMergeLocalBranch(singleRepoSyntheticBranch) &&
      singleRepoSyntheticBranch
      ? [singleRepoSyntheticBranch]
      : [];
  }, [isMultiRepo, repoBranches, singleRepoSyntheticBranch]);

  // ---- UI state ----
  const { copied: copiedBranch, copy: copyBranch } = useClipboardCopy();
  const [baseBranchDropdownOpen, setBaseBranchDropdownOpen] = useState(false);
  const baseBranchTriggerRef = useRef<HTMLButtonElement>(null);
  // ••• branch-actions menu (rename / change / copy / branch info) after the branch
  // name in the breadcrumb.
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const branchMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const branchChange = useWorktreeBranchChange({
    projectId,
    worktreeId,
    currentBranch: worktreeBranchName,
    baseBranch,
  });
  // The menu anchors to a zero-size marker positioned at the click's x
  // offset inside the branch pill, so it opens under the cursor.
  const branchMenuAnchorRef = useRef<HTMLSpanElement>(null);
  const [branchMenuAnchorX, setBranchMenuAnchorX] = useState(0);
  const branchMenuId = useId();
  // Inline branch rename (double-click on the branch pill). `null` = at rest.
  const [branchEditValue, setBranchEditValue] = useState<string | null>(null);
  /** Trimmed new name awaiting the pushed-branch confirmation, or null. */
  const [branchRenameRemoteConfirm, setBranchRenameRemoteConfirm] = useState<
    string | null
  >(null);

  // Pill width captured when the edit begins — the input's FLOOR, so
  // flipping into rename causes no jump; from there the input grows with the
  // typed name up to the 40cqw cap.
  const [branchEditWidth, setBranchEditWidth] = useState<number | null>(null);
  // Navigation resets the editor, but Git keeps running for its worktree.
  // The ref guards submissions synchronously; state publishes its snapshot.
  const pendingBranchRenamesRef = useRef(new Set<string>());
  const [pendingBranchRenames, setPendingBranchRenames] = useState<
    ReadonlySet<string>
  >(new Set());
  const branchRenameKey = worktreeKey(projectId, worktreeId);
  const branchRenamePending = pendingBranchRenames.has(branchRenameKey);
  // Set by the input's commit so the blur that follows keeps the edit open.
  const branchEditCommittedRef = useRef(false);
  const branchEditInputRef = useRef<HTMLInputElement | null>(null);
  // A refused name (CAN-7293) keeps the edit open with the typed text, marks
  // the field, and says why in the git action banner under the top bar. The
  // banner's `seq` lets the next attempt, or Escape, take that reason down.
  // The bar has no room for a field error, so the field's description repeats
  // the banner's sentence for screen readers that read the focused field.
  const [branchRenameRefusal, setBranchRenameRefusal] = useState<string | null>(
    null,
  );
  const branchRenameRefusalId = useId();
  const branchRenameRefusalSeqRef = useRef<number | null>(null);
  // Navigation invalidates pending replies, even if the person returns to
  // the same worktree before Git settles.
  const branchRenameScopeRef = useRef({});

  // PR base branch update confirmation
  const [pendingBaseChange, setPendingBaseChange] = useState<{
    projectId: string;
    worktreeId: string;
    branchName: string;
    resolve: (choice: BaseBranchChangeChoice | null) => void;
  } | null>(null);
  // This bar is reused across worktrees, so the question only shows while its
  // own worktree is selected and on screen.
  const baseChangeConfirmationVisible =
    useIsWorktreeSurfaceVisible(pendingBaseChange);
  useEffect(() => {
    if (pendingBaseChange && !baseChangeConfirmationVisible) {
      pendingBaseChange.resolve('local-only');
      setPendingBaseChange(null);
    }
  }, [pendingBaseChange, baseChangeConfirmationVisible]);
  const [pendingPrBaseUpdate, setPendingPrBaseUpdate] =
    useState<PendingPrBaseUpdate | null>(null);
  const pendingBaseBranchAlignment = useBaseBranchAlignmentStore(
    (state) => state.pending,
  );
  const requestBaseBranchAlignment = useBaseBranchAlignmentStore(
    (state) => state.requestConfirmation,
  );
  const resolveBaseBranchAlignment = useBaseBranchAlignmentStore(
    (state) => state.resolveConfirmation,
  );
  const baseBranchDriftConfirmationOpen =
    pendingBaseBranchAlignment?.projectId === projectId &&
    pendingBaseBranchAlignment.worktreeId === worktreeId;

  useEffect(() => {
    setPendingPrBaseUpdate(null);
    const pending = useBaseBranchAlignmentStore.getState().pending;
    if (
      pending &&
      (pending.projectId !== projectId || pending.worktreeId !== worktreeId)
    ) {
      useBaseBranchAlignmentStore.getState().resolveConfirmation(false);
    }
    return (): void => {
      const current = useBaseBranchAlignmentStore.getState().pending;
      if (
        current?.projectId === projectId &&
        current.worktreeId === worktreeId
      ) {
        useBaseBranchAlignmentStore.getState().resolveConfirmation(false);
      }
    };
  }, [projectId, worktreeId]);

  useEffect((): void => {
    if (isWorktreeSurfaceVisible(projectId, worktreeId)) return;
    const pending = useBaseBranchAlignmentStore.getState().pending;
    if (pending?.projectId === projectId && pending.worktreeId === worktreeId) {
      useBaseBranchAlignmentStore.getState().resolveConfirmation(false);
    }
  }, [
    activePage,
    projectId,
    selectedProjectId,
    selectedWorktreeId,
    settingsOpen,
    worktreeId,
  ]);

  const visibleBaseBranchDrifts = useMemo(
    () =>
      baseBranchDrifts.filter((drift) =>
        isBaseBranchDriftLive(
          drift,
          pendingPrBaseUpdate,
          projectId,
          worktreeId,
        ),
      ),
    [baseBranchDrifts, pendingPrBaseUpdate, projectId, worktreeId],
  );
  const visibleBaseBranchDriftsRef = useRef(visibleBaseBranchDrifts);
  visibleBaseBranchDriftsRef.current = visibleBaseBranchDrifts;

  // Auto-adopt the PR's base when nothing was ever explicitly tracked. The
  // displayed base in that case is a derived guess, and the PR is the better
  // source of truth, so there is nothing for the user to decide.
  const autoAdoptedBaseBranchesRef = useRef<Set<string>>(new Set<string>());
  useEffect((): void => {
    for (const drift of adoptableBaseBranchDrifts) {
      if (
        !isBaseBranchDriftLive(
          drift,
          pendingPrBaseUpdate,
          projectId,
          worktreeId,
        )
      ) {
        continue;
      }
      // One attempt per (repo, PR, target) so the effect cannot re-fire while
      // the write and the following stats refresh are still in flight.
      const token = `${projectId}/${worktreeId}/${drift.repoId}/${drift.prNumber}/${drift.prBaseBranch}`;
      if (autoAdoptedBaseBranchesRef.current.has(token)) continue;
      autoAdoptedBaseBranchesRef.current.add(token);
      void setTrackedBaseBranch(
        projectId,
        worktreeId,
        drift.prBaseBranch,
        isMultiRepo ? drift.repoId : undefined,
      ).catch((error: unknown) => {
        // Silent by design: the user never asked for this write, so a failure
        // must not show. Record it; clearing the token lets the next poll retry.
        reportClientAppError(error);
        autoAdoptedBaseBranchesRef.current.delete(token);
      });
    }
  }, [
    adoptableBaseBranchDrifts,
    isMultiRepo,
    pendingPrBaseUpdate,
    projectId,
    setTrackedBaseBranch,
    worktreeId,
  ]);

  useEffect((): void => {
    if (!pendingPrBaseUpdate || !prStatus) return;
    if (
      pendingPrBaseUpdate.projectId !== projectId ||
      pendingPrBaseUpdate.worktreeId !== worktreeId
    ) {
      setPendingPrBaseUpdate(null);
      return;
    }
    const refreshedStatus = prStatus.repos
      .map((repo) => repo.status)
      .find((status) => status?.prNumber === pendingPrBaseUpdate.prNumber);
    if (!refreshedStatus) return;
    if (
      (refreshedStatus.state !== 'open' && refreshedStatus.state !== 'draft') ||
      refreshedStatus.baseRefName?.trim() !==
        pendingPrBaseUpdate.previousBaseBranch
    ) {
      setPendingPrBaseUpdate(null);
    }
  }, [pendingPrBaseUpdate, prStatus, projectId, worktreeId]);

  useEffect((): void => {
    if (
      pendingBaseBranchAlignment?.projectId === projectId &&
      pendingBaseBranchAlignment.worktreeId === worktreeId &&
      !areBaseBranchDriftsEqual(
        pendingBaseBranchAlignment.drifts,
        visibleBaseBranchDrifts,
      )
    ) {
      useBaseBranchAlignmentStore.getState().resolveConfirmation(false);
    }
  }, [
    pendingBaseBranchAlignment,
    projectId,
    visibleBaseBranchDrifts,
    worktreeId,
  ]);

  // Branch not renamed warning
  const [pendingPushAction, setPendingPushAction] = useState<
    (() => void) | null
  >(null);

  // Local-only merge confirmation modal state. The actual list of candidates
  // is captured at open time so a refresh mid-flow can't shift the dialog.
  const [mergeModalCandidates, setMergeModalCandidates] = useState<
    RepoBranchInfo[] | null
  >(null);

  // PR merge (GitHub API) modal state. The single-PR unresolved-comments
  // warning lives in the store so a toast can safely hand it to the original
  // worktree after this reused top bar has navigated elsewhere.
  // `prMergeMultiRepo` is the per-repo picker for worktrees with >1 PR.
  const [prMergeMultiRepo, setPrMergeMultiRepo] = useState<{
    repos: MergePrVerifiedRepo[];
    isChecking: boolean;
    checkFailed: boolean;
  } | null>(null);
  // Invalidates a pending dry run when the modal closes or a newer retry starts.
  const prMergeCheckRequestRef = useRef(0);
  const prMergeWarningSurfaceMountedRef = useRef(true);

  // Once a warning is actually presented, leaving its worktree dismisses it.
  // A later return should require another Merge click unless the user follows
  // the warning toast, which opens a fresh store entry after navigation.
  useEffect(() => {
    prMergeWarningSurfaceMountedRef.current = true;
    return (): void => {
      prMergeWarningSurfaceMountedRef.current = false;
      clearPrMergeWarning(projectId, worktreeId);
    };
  }, [clearPrMergeWarning, projectId, worktreeId]);

  useEffect(() => {
    if (
      !isPrMergeWarningSurfaceVisible(
        projectId,
        worktreeId,
        prMergeWarningSurfaceMountedRef.current,
      )
    ) {
      clearPrMergeWarning(projectId, worktreeId);
    }
  }, [
    activePage,
    clearPrMergeWarning,
    projectId,
    selectedProjectId,
    selectedWorktreeId,
    settingsOpen,
    worktreeId,
  ]);

  // In-flight flag for the "Resolve, Commit & Push" conflict-resolution chat.
  const [startingConflictResolution, setStartingConflictResolution] =
    useState(false);
  // In-flight flag for the warning modal's "Triage review comments" chat.
  const [startingTriage, setStartingTriage] = useState(false);
  // In-flight flag for the CI badge's "Fix" chat.
  const [startingCiFix, setStartingCiFix] = useState(false);

  const warnResult = shouldWarnBranchNotRenamed({
    worktreeId,
    worktreeBranchName,
    isMultiRepo: prStatus ? prStatus.repos.length > 1 : false,
    hasBranchBeenPushed,
    repoBranches,
  });
  const warningBranchNames =
    warnResult.unrenamedRepos.length > 0
      ? warnResult.unrenamedRepos.map((repo) => repo.branchName)
      : [worktreeBranchName];

  // ---- Callbacks ----
  const expandActivityPanel = useCallback((): void => {
    if (!panelExpanded) {
      setPanelExpanded(true);
      if (viewModeReady) {
        saveActivityPanelExpanded(viewMode, true);
      }
    }
  }, [panelExpanded, setPanelExpanded, viewMode, viewModeReady]);

  const checkBranchWarning = useCallback(
    (action: () => void): boolean => {
      if (warnResult.shouldWarn) {
        setPendingPushAction(() => action);
        return true;
      }
      return false;
    },
    [warnResult.shouldWarn],
  );

  const handleWarningContinue = useCallback((): void => {
    const action = pendingPushAction;
    setPendingPushAction(null);
    action?.();
  }, [pendingPushAction]);

  const handleWarningRename = useCallback((): void => {
    setPendingPushAction(null);
    requestBranchRename(projectId, worktreeId);
  }, [requestBranchRename, projectId, worktreeId]);

  const handleWarningClose = useCallback((): void => {
    setPendingPushAction(null);
  }, []);

  const handleOpenBranchInfo = useCallback((): void => {
    requestBranchInfo(projectId, worktreeId);
  }, [requestBranchInfo, projectId, worktreeId]);

  const handleEditBranch = useCallback((): void => {
    requestBranchRename(projectId, worktreeId);
  }, [requestBranchRename, projectId, worktreeId]);

  // Quick-copy reveal: the pill's rest width, captured on mouse enter and
  // LOCKED for the duration of the hover, so revealing the in-flow copy
  // button cannot grow the pill — the label shrinks instead and `truncate`
  // renders a real ellipsis. Driven from React state rather than CSS
  // group-hover because the measurement must happen while the button is
  // still unmounted; a CSS reveal applies :hover before the handler runs,
  // so the width read would already include the button.
  const [branchPillLockedWidth, setBranchPillLockedWidth] = useState<
    number | null
  >(null);

  // Inline branch rename, entered ONLY through the branch menu's explicit
  // "Rename branch" item (single-repo). The double-click shortcut that used
  // to open this was cut on review: renaming a git branch is consequential
  // enough that the entry must be deliberate and labelled, not a gesture you
  // can hit while aiming for the menu.
  const dismissBranchRenameRefusal = useCallback((): void => {
    setBranchRenameRefusal(null);
    const seq = branchRenameRefusalSeqRef.current;
    branchRenameRefusalSeqRef.current = null;
    if (seq !== null)
      useGitHubStore
        .getState()
        .dismissGitActionFailure(projectId, worktreeId, seq);
  }, [projectId, worktreeId]);

  // The bar stays mounted across worktree selection. Cleanup owns the old
  // scope's ids, so it dismisses only that rename's banner before resetting
  // the editor. A newer Git failure is protected by its distinct sequence.
  useEffect(() => {
    setBranchEditValue(null);
    setBranchRenameRemoteConfirm(null);
    setBranchRenameRefusal(null);
    return (): void => {
      branchRenameScopeRef.current = {};
      dismissBranchRenameRefusal();
    };
  }, [dismissBranchRenameRefusal]);

  const showBranchRenameRefusal = useCallback(
    (
      reason: string,
      raiseFailure: (failure: InlineFailure) => number | null,
    ): void => {
      branchRenameRefusalSeqRef.current = raiseFailure(inputFailure(reason));
      setBranchRenameRefusal(reason);
      // Enter left the field; put the person back in it to fix the name.
      requestAnimationFrame(() => branchEditInputRef.current?.focus());
    },
    [],
  );

  const beginInlineBranchRename = useCallback((): void => {
    setBranchMenuOpen(false);
    branchEditCommittedRef.current = false;
    setBranchRenameRemoteConfirm(null);
    setBranchRenameRefusal(null);
    setBranchEditWidth(branchMenuTriggerRef.current?.offsetWidth ?? null);
    setBranchEditValue(currentBranchRawLabel);
  }, [currentBranchRawLabel]);

  const performBranchRename = useCallback(
    async (trimmed: string): Promise<void> => {
      if (pendingBranchRenamesRef.current.has(branchRenameKey)) return;
      pendingBranchRenamesRef.current.add(branchRenameKey);
      setPendingBranchRenames(new Set(pendingBranchRenamesRef.current));
      setBranchRenameRemoteConfirm(null);
      const scope = branchRenameScopeRef.current;
      const raiseFailure = gitActionFailureRaiser(projectId, worktreeId);
      let keepEditing = false;
      try {
        await window.api.renameBranch({
          projectId,
          worktreeId,
          newBranchName: trimmed,
        });
        useProjectsStore
          .getState()
          .updateBranchName(projectId, worktreeId, trimmed);
        void useProjectsStore.getState().refreshDiffStats();
      } catch (err: unknown) {
        if (branchRenameScopeRef.current !== scope) return;
        const refusal = branchRenameRefusalText(err, trimmed);
        if (refusal !== null) {
          keepEditing = true;
          showBranchRenameRefusal(refusal, raiseFailure);
        } else {
          const appError = toAppError(resolveClientAppError(err));
          if (appError) {
            raiseFailure(
              inlineFailure(appError, "Couldn't rename the branch."),
            );
          }
        }
      } finally {
        pendingBranchRenamesRef.current.delete(branchRenameKey);
        setPendingBranchRenames(new Set(pendingBranchRenamesRef.current));
        if (branchRenameScopeRef.current === scope) {
          if (!keepEditing) setBranchEditValue(null);
        }
      }
    },
    [branchRenameKey, projectId, worktreeId, showBranchRenameRefusal],
  );

  const commitBranchRename = useCallback(
    async (value: string): Promise<void> => {
      if (
        pendingBranchRenamesRef.current.has(branchRenameKey) ||
        branchRenameRemoteConfirm !== null
      )
        return;
      const trimmed = value.trim();
      dismissBranchRenameRefusal();
      if (trimmed === '' || trimmed === currentBranchRawLabel) {
        setBranchEditValue(null);
        return;
      }
      // The input shows the committed name while it renames or asks.
      setBranchEditValue(value);
      const problem = branchNameProblem(trimmed);
      if (problem !== null) {
        showBranchRenameRefusal(
          problem,
          gitActionFailureRaiser(projectId, worktreeId),
        );
        return;
      }
      // Same gate as the branch dialog's rename: a pushed branch only renames
      // after an explicit confirmation, since the old remote branch and any
      // associated PRs survive a local rename.
      if (hasBranchBeenPushed) {
        setBranchRenameRemoteConfirm(trimmed);
        return;
      }
      await performBranchRename(trimmed);
    },
    [
      branchRenameKey,
      branchRenameRemoteConfirm,
      currentBranchRawLabel,
      dismissBranchRenameRefusal,
      hasBranchBeenPushed,
      performBranchRename,
      projectId,
      showBranchRenameRefusal,
      worktreeId,
    ],
  );

  const handleCopyBranch = useCallback((): void => {
    void copyBranch(currentBranchRawLabel);
  }, [copyBranch, currentBranchRawLabel]);

  const handleBaseBranchClick = useCallback((): void => {
    if (isMultiRepo) return;
    setBaseBranchDropdownOpen((open) => !open);
  }, [isMultiRepo]);

  const handleBaseBranchClose = useCallback((): void => {
    setBaseBranchDropdownOpen(false);
    baseBranchTriggerRef.current?.focus();
  }, []);

  const handleBaseBranchSelect = useCallback(
    (branchName: string): void => {
      handleBaseBranchClose();
      const raiseFailure = gitActionFailureRaiser(projectId, worktreeId);
      void setWorktreeBaseBranch(
        { projectId, worktreeId, baseBranch: branchName },
        {
          confirmUpdatePullRequest: () =>
            new Promise<BaseBranchChangeChoice | null>((resolve) => {
              setPendingBaseChange({
                projectId,
                worktreeId,
                branchName,
                resolve,
              });
            }),
          onBeforePullRequestUpdate: (pendingUpdate) => {
            if (pendingUpdate.previousBaseBranch) {
              setPendingPrBaseUpdate(pendingUpdate);
            }
          },
          onPullRequestUpdateError: () => {
            setPendingPrBaseUpdate(null);
          },
          onLocalOnlyPullRequestMismatch: ({ baseBranch }) => {
            const wsName = useProjectsStore
              .getState()
              .projects.find((p) => p.id === projectId)?.name;
            useGitHubStore
              .getState()
              .addToast(
                `Updated the tracked base branch locally. "${baseBranch}" is not available on the remote, so the PR base branch was left unchanged.`,
                'info',
                undefined,
                {
                  category: 'PR Create',
                  workspaceName: wsName,
                  projectId,
                  worktreeId,
                },
              );
          },
        },
      ).catch((error: unknown) => {
        setPendingPrBaseUpdate(null);
        const appError = toAppError(resolveClientAppError(error));
        if (appError) {
          raiseFailure(
            inlineFailure(appError, "Couldn't update the tracked base branch."),
          );
        }
      });
    },
    [handleBaseBranchClose, projectId, worktreeId],
  );

  const handleConfirmPrBaseUpdate = useCallback((): void => {
    if (!pendingBaseChange) return;
    pendingBaseChange.resolve('update-pr');
    setPendingBaseChange(null);
  }, [pendingBaseChange]);

  const handleDeclinePrBaseUpdate = useCallback((): void => {
    if (!pendingBaseChange) return;
    pendingBaseChange.resolve('local-only');
    setPendingBaseChange(null);
  }, [pendingBaseChange]);

  const handleClosePrBaseUpdate = useCallback((): void => {
    pendingBaseChange?.resolve(null);
    setPendingBaseChange(null);
  }, [pendingBaseChange]);

  const handleOpenBaseBranchAlignment = useCallback((): void => {
    const driftsToApply = [...visibleBaseBranchDrifts];
    void requestBaseBranchAlignment(projectId, worktreeId, driftsToApply).then(
      (confirmed) => {
        if (!confirmed) return;
        if (
          !areBaseBranchDriftsEqual(
            driftsToApply,
            visibleBaseBranchDriftsRef.current,
          )
        ) {
          useGitHubStore
            .getState()
            .addToast(
              'The PR base branch changed. Review the latest drift before aligning.',
              'warning',
            );
          return;
        }
        const raiseFailure = gitActionFailureRaiser(projectId, worktreeId);
        for (const drift of driftsToApply) {
          void setTrackedBaseBranch(
            projectId,
            worktreeId,
            drift.prBaseBranch,
            projectType === 'multi-repo' ? drift.repoId : undefined,
          ).catch((error: unknown) => {
            const appError = toAppError(resolveClientAppError(error));
            if (appError) {
              raiseFailure(
                inlineFailure(
                  appError,
                  "Couldn't update the tracked base branch.",
                ),
              );
            }
          });
        }
      },
    );
  }, [
    visibleBaseBranchDrifts,
    requestBaseBranchAlignment,
    projectId,
    worktreeId,
    setTrackedBaseBranch,
    projectType,
  ]);

  // Local-only Commit / Merge handlers.
  // A running header action cancels itself: its icon slot swaps the spinner
  // for an ✕ on hover, and the button's own click is what that ✕ promises.
  const handleCancelGitAction = useCallback((): void => {
    void useGitHubStore.getState().cancelGitAction(projectId, worktreeId);
  }, [projectId, worktreeId]);

  const handleLocalOnlyCommit = useCallback((): void => {
    if (localOnlyCommitRepoIds.length === 0) return;
    // Single-repo worktrees pass `undefined` for repoIds; multi-repo passes the
    // explicit local-only subset. The push-rename warning is push-specific and
    // is intentionally not surfaced here.
    const repoIdsArg = isMultiRepo ? localOnlyCommitRepoIds : undefined;
    void useGitHubStore
      .getState()
      .commitOnly(projectId, worktreeId, repoIdsArg);
  }, [isMultiRepo, localOnlyCommitRepoIds, projectId, worktreeId]);

  const handleLocalOnlyMergeOpen = useCallback((): void => {
    if (localOnlyMergeCandidates.length === 0) {
      useGitHubStore
        .getState()
        .addToast(
          'No local-only repos are ready to merge.',
          'info',
          undefined,
          {
            category: 'Git Merge',
            workspaceName: projectName,
            projectId,
            worktreeId,
          },
        );
      return;
    }
    setMergeModalCandidates(localOnlyMergeCandidates);
  }, [localOnlyMergeCandidates, projectId, projectName, worktreeId]);

  const handleLocalOnlyMergeClose = useCallback((): void => {
    setMergeModalCandidates(null);
  }, []);

  const handleLocalOnlyMergeConfirm = useCallback((): void => {
    if (!mergeModalCandidates) return;
    const repoIdsArg = isMultiRepo
      ? mergeModalCandidates.map((b) => b.repoId)
      : undefined;
    setMergeModalCandidates(null);
    void useGitHubStore
      .getState()
      .mergeLocalBranches(projectId, worktreeId, repoIdsArg);
  }, [isMultiRepo, mergeModalCandidates, projectId, worktreeId]);

  // PR merge (GitHub API) handlers.
  const handleMergePrClick = useCallback((): void => {
    if (prMergeMultiRepo?.isChecking) return;
    void (async (): Promise<void> => {
      // More than one open PR → always open the per-repo modal. A fresh dry-run
      // re-verifies state against GitHub. Open the modal first so the user gets
      // immediate feedback while that network work is in flight.
      if (openPrRepos.length > 1) {
        const requestId = ++prMergeCheckRequestRef.current;
        setPrMergeMultiRepo({
          repos: [],
          isChecking: true,
          checkFailed: false,
        });
        const response = await mergePr(projectId, worktreeId, {
          dryRun: true,
        });
        if (prMergeCheckRequestRef.current !== requestId) return;
        if (response?.cancelled) {
          setPrMergeMultiRepo(null);
          return;
        }
        if (response === null) {
          setPrMergeMultiRepo({
            repos: [],
            isChecking: false,
            checkFailed: true,
          });
        } else {
          setPrMergeMultiRepo({
            repos: response.verifiedRepos,
            isChecking: false,
            checkFailed:
              response.verifiedRepos.length === 0 &&
              response.failedRepos.length > 0,
          });
        }
        return;
      }
      // Exactly one open PR (single-repo, or multi-repo with a single PR).
      const target = mergeableOpenPrRepos[0] ?? openPrRepos[0];
      const repoIds =
        isMultiRepo && target?.repoId !== undefined
          ? [target.repoId]
          : undefined;
      const response = await mergePr(projectId, worktreeId, {
        repoIds,
        confirmUnresolvedComments: false,
      });
      if (!response) return;
      const pending = response.requiresUnresolvedConfirmation[0];
      if (pending) {
        const warning = {
          projectId,
          worktreeId,
          repoIds,
          prUrl: pending.prUrl,
          unresolvedReviewThreadCount: pending.unresolvedReviewThreadCount,
          repoId: pending.repoId,
          repoName: pending.repoName,
        };

        const addWarningToast = (onActivate: () => void): void => {
          useGitHubStore
            .getState()
            .addToast(
              'This merge needs confirmation because the pull request has unresolved comments. Click to return to the worktree and review it.',
              'warning',
              onActivate,
              {
                category: 'Git Merge',
                workspaceName: projectName,
                projectId,
                worktreeId,
              },
            );
        };

        const refreshWarningFromToast = async (): Promise<void> => {
          const navigation = useNavigationStore.getState();
          navigation.closeSettings();
          navigation.navigate('main');
          useChatStore.getState().selectWorktree(projectId, worktreeId);

          const refreshedResponse = await mergePr(projectId, worktreeId, {
            repoIds,
            confirmUnresolvedComments: false,
            dryRun: true,
          });
          const refreshedPending =
            refreshedResponse?.requiresUnresolvedConfirmation[0];
          if (!refreshedPending) return;

          const refreshedWarning = {
            projectId,
            worktreeId,
            repoIds,
            prUrl: refreshedPending.prUrl,
            unresolvedReviewThreadCount:
              refreshedPending.unresolvedReviewThreadCount,
            repoId: refreshedPending.repoId,
            repoName: refreshedPending.repoName,
          };
          // The toast may belong to an unmounted PrStatusBar instance, so its
          // mounted ref cannot represent the surface created by the navigation
          // handoff above. Re-check the shared navigation context instead to
          // discard a result when the user navigates away during the dry run.
          if (!isWorktreeSurfaceVisible(projectId, worktreeId)) {
            return;
          }
          useGitHubStore.getState().openPrMergeWarning(refreshedWarning);
        };

        if (
          isPrMergeWarningSurfaceVisible(
            projectId,
            worktreeId,
            prMergeWarningSurfaceMountedRef.current,
          )
        ) {
          openPrMergeWarning(warning);
          return;
        }

        addWarningToast(() => {
          void refreshWarningFromToast();
        });
      }
    })();
  }, [
    openPrRepos,
    mergeableOpenPrRepos,
    isMultiRepo,
    mergePr,
    openPrMergeWarning,
    projectId,
    projectName,
    prMergeMultiRepo?.isChecking,
    worktreeId,
  ]);

  const handleMergePrWarningConfirm = useCallback((): void => {
    const warning = prMergeWarning;
    if (!warning) return;
    clearPrMergeWarning(warning.projectId, warning.worktreeId);
    void mergePr(warning.projectId, warning.worktreeId, {
      repoIds: warning.repoIds,
      confirmUnresolvedComments: true,
    });
  }, [clearPrMergeWarning, prMergeWarning, mergePr]);

  const handleMergePrWarningClose = useCallback((): void => {
    clearPrMergeWarning(projectId, worktreeId);
  }, [clearPrMergeWarning, projectId, worktreeId]);

  const handleTriageReviewComments = useCallback((): void => {
    if (startingTriage) return;
    const warning = prMergeWarning;
    if (!warning) return;
    setStartingTriage(true);
    const raiseFailure = gitActionFailureRaiser(projectId, worktreeId);
    void window.api.github
      .startPrCommentTriage({
        projectId: warning.projectId,
        worktreeId: warning.worktreeId,
        repoId: isMultiRepo ? warning.repoId : undefined,
        repoName: warning.repoName,
        branchName: worktreeBranchName || undefined,
      })
      .then(() => {
        clearPrMergeWarning(warning.projectId, warning.worktreeId);
      })
      .catch((error: unknown) => {
        const appError = toAppError(resolveClientAppError(error));
        if (appError) {
          raiseFailure(
            inlineFailure(appError, "Couldn't start review comment triage."),
          );
        }
      })
      .finally(() => {
        setStartingTriage(false);
      });
  }, [
    startingTriage,
    prMergeWarning,
    clearPrMergeWarning,
    isMultiRepo,
    projectId,
    worktreeId,
    worktreeBranchName,
  ]);

  const handleMergePrMultiConfirm = useCallback(
    (repoIds: string[]): void => {
      prMergeCheckRequestRef.current += 1;
      setPrMergeMultiRepo(null);
      if (repoIds.length === 0) return;
      void mergePr(projectId, worktreeId, {
        repoIds,
        confirmUnresolvedComments: true,
      });
    },
    [mergePr, projectId, worktreeId],
  );

  const handleMergePrMultiClose = useCallback((): void => {
    prMergeCheckRequestRef.current += 1;
    setPrMergeMultiRepo(null);
  }, []);

  const handleResolveConflictsClick = useCallback((): void => {
    if (startingConflictResolution) return;
    setStartingConflictResolution(true);
    const raiseFailure = gitActionFailureRaiser(projectId, worktreeId);
    const target = conflictingOpenPrRepos[0];
    void window.api.github
      .startMergeConflictResolution({
        projectId,
        worktreeId,
        repoId: isMultiRepo ? target?.repoId : undefined,
        repoName: target?.repoName,
        branchName: worktreeBranchName || undefined,
      })
      .catch((error: unknown) => {
        const appError = toAppError(resolveClientAppError(error));
        if (appError) {
          raiseFailure(
            inlineFailure(
              appError,
              "Couldn't start resolving merge conflicts.",
            ),
          );
        }
      })
      .finally(() => {
        setStartingConflictResolution(false);
      });
  }, [
    startingConflictResolution,
    conflictingOpenPrRepos,
    isMultiRepo,
    projectId,
    worktreeId,
    worktreeBranchName,
  ]);

  const handleFixCiChecksClick = useCallback((): void => {
    if (startingCiFix) return;
    setStartingCiFix(true);
    const raiseFailure = gitActionFailureRaiser(projectId, worktreeId);
    void window.api.github
      .startCiCheckFix({
        projectId,
        worktreeId,
        repoId: isMultiRepo ? ciFailingRepo?.repoId : undefined,
        repoName: ciFailingRepo?.repoName,
        branchName: worktreeBranchName || undefined,
      })
      .catch((error: unknown) => {
        const appError = toAppError(resolveClientAppError(error));
        if (appError) {
          raiseFailure(
            inlineFailure(appError, "Couldn't start fixing CI checks."),
          );
        }
      })
      .finally(() => {
        setStartingCiFix(false);
      });
  }, [
    startingCiFix,
    ciFailingRepo,
    isMultiRepo,
    projectId,
    worktreeId,
    worktreeBranchName,
  ]);

  // Multi-repo PR badge data
  // ---- Header PR actions ----
  // The status run and Create PR are the shared `PullRequestActions`
  // (REG-3025): this bar samples its stores into facts and runs what the
  // user asks for; the shared plan decides which controls apply.
  const headerRepos = useMemo(
    (): readonly PullRequestActionsRepo[] | null =>
      prStatus
        ? prStatus.repos.map((repo) => ({
            repoId: repo.repoId,
            repoName: repo.repoName,
            pr: repo.status
              ? toHeaderPr(repo.status, prMergeRoute(repo))
              : null,
          }))
        : null,
    [prStatus, prMergeRoute],
  );
  const headerWorktree = useMemo(
    (): PullRequestBranchFacts => ({
      repoId: prStatus?.repos[0]?.repoId ?? projectId,
      commitsAhead: hasCommitsAhead,
      hasUncommittedChanges: uncommittedChanges,
      hasUnpushedCommits,
      hasUnpulledCommits,
      hasRemoteTrackingBranch: hasRemoteTracking,
      hasOriginRemote,
      baseBranchExistsLocally,
    }),
    [
      prStatus,
      projectId,
      hasCommitsAhead,
      uncommittedChanges,
      hasUnpushedCommits,
      hasUnpulledCommits,
      hasRemoteTracking,
      hasOriginRemote,
      baseBranchExistsLocally,
    ],
  );
  const headerFacts = useMemo(
    (): PullRequestActionsFacts => ({
      isMultiRepo,
      repos: headerRepos,
      worktree: headerWorktree,
      ...(repoBranches === undefined ? {} : { repoBranches }),
      splitPr: headerSplitPr,
      agentHelpers: DESKTOP_PR_AGENT_HELPERS,
    }),
    [isMultiRepo, headerRepos, headerWorktree, repoBranches, headerSplitPr],
  );
  const headerActivity = useMemo(
    (): PullRequestActionsActivity => ({
      committingAndPushing,
      activeBranchSyncAction: activeBranchSyncAction ?? null,
      commitReviewPending,
      creatingPr,
      mergingLocalBranches,
      mergingPr,
      mergeChecking: prMergeMultiRepo?.isChecking === true,
      refreshing: gitStatsRefreshing,
      mergeRefreshing: mergePrRefreshing,
      cancellationRequested: gitActionCancellationRequested,
      startingCiFix,
      startingConflictResolution,
    }),
    [
      committingAndPushing,
      activeBranchSyncAction,
      commitReviewPending,
      creatingPr,
      mergingLocalBranches,
      mergingPr,
      prMergeMultiRepo?.isChecking,
      gitStatsRefreshing,
      mergePrRefreshing,
      gitActionCancellationRequested,
      startingCiFix,
      startingConflictResolution,
    ],
  );
  const headerPlan = useMemo(
    () => planPullRequestActions(headerFacts, headerActivity),
    [headerFacts, headerActivity],
  );

  const handleHeaderAction = useCallback(
    (request: PullRequestActionRequest): void => {
      switch (request.kind) {
        case 'branch-sync': {
          const store = useGitHubStore.getState();
          const run = (): void => {
            if (request.action === 'push') {
              void store.pushOnly(projectId, worktreeId);
            } else if (request.action === 'pull') {
              void store.pull(projectId, worktreeId);
            } else if (request.action === 'pull-commit-and-push') {
              void store.commitAndPush(projectId, worktreeId, {
                pullFirst: true,
              });
            } else {
              void store.commitAndPush(projectId, worktreeId);
            }
          };
          // Pull never pushes, so it skips the push-rename warning.
          if (request.action !== 'pull' && checkBranchWarning(run)) return;
          run();
          return;
        }
        case 'create-pr': {
          const repoIds =
            request.repoIds === undefined ? undefined : [...request.repoIds];
          const action = (): void => {
            expandActivityPanel();
            void createPr(projectId, worktreeId, repoIds);
          };
          if (!checkBranchWarning(action)) action();
          return;
        }
        case 'local-commit':
          handleLocalOnlyCommit();
          return;
        case 'local-merge':
          handleLocalOnlyMergeOpen();
          return;
        case 'merge':
          handleMergePrClick();
          return;
        case 'resolve-conflicts':
          handleResolveConflictsClick();
          return;
        case 'fix-ci':
          handleFixCiChecksClick();
          return;
        case 'split-pr':
          openSplitPreflight(projectId, worktreeId);
          return;
        case 'open-pr-details':
          expandActivityPanel();
          return;
      }
    },
    [
      checkBranchWarning,
      createPr,
      expandActivityPanel,
      handleFixCiChecksClick,
      handleLocalOnlyCommit,
      handleLocalOnlyMergeOpen,
      handleMergePrClick,
      handleResolveConflictsClick,
      openSplitPreflight,
      projectId,
      worktreeId,
    ],
  );
  const renderHeaderProgress: PullRequestProgressRenderer = useCallback(
    (
      target: PullRequestProgressTarget,
      trigger: ReactElement<HoverCardTriggerProps>,
      options: Parameters<PullRequestProgressRenderer>[2],
    ): ReactElement => (
      <GitActionProgressTooltip
        projectId={projectId}
        worktreeId={worktreeId}
        action={target}
        {...(options.dataTestId === undefined
          ? {}
          : { dataTestId: options.dataTestId })}
        {...(options.suppressed === undefined
          ? {}
          : { suppressed: options.suppressed })}
      >
        {trigger}
      </GitActionProgressTooltip>
    ),
    [projectId, worktreeId],
  );

  const prMergeModalUiState = useMemo((): AppAdvisorJson | null => {
    if (prMergeWarning !== null) {
      const state: Record<string, AppAdvisorJson> = {
        open: true,
        mode: 'unresolved-warning',
        prUrl: prMergeWarning.prUrl,
        unknownReviewThreadState:
          prMergeWarning.unresolvedReviewThreadCount === undefined,
        submitting: mergingPr,
      };
      if (prMergeWarning.unresolvedReviewThreadCount !== undefined) {
        state.unresolvedReviewThreadCount =
          prMergeWarning.unresolvedReviewThreadCount;
      }
      return state;
    }
    if (prMergeMultiRepo !== null) {
      const repos: AppAdvisorJson[] = prMergeMultiRepo.repos.map((repo) => {
        const state: Record<string, AppAdvisorJson> = {
          repoName: repo.repoName,
          prNumber: repo.prNumber,
          prUrl: repo.prUrl,
          mergeable: repo.mergeable,
          unknownReviewThreadState:
            repo.unresolvedReviewThreadCount === undefined,
        };
        if (repo.repoId) state.repoId = repo.repoId;
        if (repo.blockedReason) state.blockedReason = repo.blockedReason;
        if (repo.unresolvedReviewThreadCount !== undefined) {
          state.unresolvedReviewThreadCount = repo.unresolvedReviewThreadCount;
        }
        return state;
      });
      return {
        open: true,
        mode: 'multi-repo',
        checking: prMergeMultiRepo.isChecking,
        checkFailed: prMergeMultiRepo.checkFailed,
        submitting: mergingPr,
        repoCount: prMergeMultiRepo.repos.length,
        mergeableRepoCount: prMergeMultiRepo.repos.filter(
          (repo) => repo.mergeable,
        ).length,
        blockedRepoCount: prMergeMultiRepo.repos.filter(
          (repo) => repo.blockedReason !== undefined,
        ).length,
        unresolvedRepoCount: prMergeMultiRepo.repos.filter(
          (repo) =>
            repo.unresolvedReviewThreadCount === undefined ||
            repo.unresolvedReviewThreadCount > 0,
        ).length,
        repos,
      };
    }
    return null;
  }, [mergingPr, prMergeMultiRepo, prMergeWarning]);

  useCurrentUiStateReporter('github.prMergeModal', prMergeModalUiState);
  useCurrentUiStateReporter(
    'github.baseBranchAlignmentModal',
    baseBranchDriftConfirmationOpen && pendingBaseBranchAlignment
      ? {
          open: true,
          confirmationId: pendingBaseBranchAlignment.confirmationId,
          projectId,
          worktreeId,
          driftCount: pendingBaseBranchAlignment.drifts.length,
          repositoryNames: pendingBaseBranchAlignment.drifts.map(
            (drift) => drift.repoName,
          ),
        }
      : null,
  );

  // ---- Render ----
  return (
    <div
      data-testid="pr-status-bar"
      // 9px on every edge. The right edge used to be `pr-2` (8px) while the
      // panel tab strip below inset its trailing controls by 9px, so each
      // header control sat exactly 1px off from the one stacked beneath it.
      // The left edge lines up with the first tab in the inset layout (see
      // `useTopBarLeadingInsetClassName`).
      className={`@container/prbar electron-drag min-h-11.5 cursor-default py-2.25 pr-2.25 ${leadingInsetClassName}`}
    >
      {/* Two rhythms, by weight. The ghost status controls (CI, the PR badge,
          Merge / Commit & Push / Fix) sit on 4px — they read as one run of
          status, so tighter spacing groups them. The solid action cluster
          then stands off by the outer row's 8px gap, which
          is what Create PR keeps from `Open in` inside the cluster, so the gap
          before the buttons is ONE value in every state regardless of which
          controls that state happens to show. */}
      <div className="flex min-h-6.5 items-center gap-2 text-xs">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {/* ---- Breadcrumb: [icon + project] > [branch] > [base branch] ----
            Sidebar-matched typography (text-s font-normal fg-primary), 16px
            medium chevrons, and every segment is a clickable 28px hover-pill:
            project opens project settings, branch opens the branch actions
            menu, base branch opens the base-branch selector. The bar's
            `pl-[5px]` plus the project pill's own 4px padding keeps the
            at-rest icon at the 9px edge inset. */}
          {/* `min-w-0` lets the breadcrumb shrink below its content so the
            labels truncate under pressure; without it a flex item's
            `min-width: auto` floor would push the overflow onto the action
            cluster instead. */}
          {/* `mr-auto` here — NOT `ml-auto` on the action cluster — is what
            right-aligns the row. All the slack is taken immediately after the
            breadcrumb, so every status item packs against the buttons on the
            row's own 8px gap. With the slack sitting at the cluster instead,
            the status items stayed pinned to the breadcrumb and their distance
            from the buttons changed with whatever copy the state happened to
            have (measured 8px to 66px across states). */}
          <div className="group/branch electron-no-drag mr-auto flex min-w-0 items-center gap-1.5 text-s font-normal fg-primary">
            {/* Icon-only project segment: the workspace name lives in the
              tooltip; clicking opens workspace settings. */}
            <Tooltip
              label={
                <span className={POSTHOG_REPLAY_MASK_CLASS}>{projectName}</span>
              }
            >
              <Button
                variant="ghost"
                size="compact"
                iconOnly
                data-testid="pr-status-bar-project-button"
                onClick={(): void => {
                  useNavigationStore
                    .getState()
                    // The worktree context seeds the settings modal's
                    // source-worktree picker, so "Default branch" starts on
                    // the branch this header is showing (review ask: match
                    // the scripts/hooks gear behavior).
                    .openWorkspaceSettings({
                      workspaceId: projectId,
                      worktreeId,
                    });
                }}
                aria-label={`${projectName} project settings`}
              >
                <ProjectIcon
                  kind={projectType ?? 'single-repo'}
                  color={projectColor}
                  temporary={projectTemporary}
                  repoPath={projectRepoPath}
                />
              </Button>
            </Tooltip>

            {/* Current branch: click opens the branch actions menu;
              double-click flips into inline rename (single-repo). */}
            {branchEditValue !== null ? (
              // 40cqw of the bar is the ceiling: past that the text scrolls,
              // mirroring how the read-only label truncates rather than
              // starving its neighbours.
              <span className="electron-no-drag relative inline-flex max-w-[40cqw]">
                <InlineTextInput
                  ref={branchEditInputRef}
                  data-testid="pr-status-bar-branch-rename-input"
                  aria-invalid={branchRenameRefusal !== null ? true : undefined}
                  aria-describedby={
                    branchRenameRefusal !== null
                      ? branchRenameRefusalId
                      : undefined
                  }
                  onDraftChange={(): void => setBranchRenameRefusal(null)}
                  // Grows with what is typed. The pill's width is the floor, so
                  // entering edit mode causes no jump, and its 8px inset keeps
                  // the text where the read-only label had it.
                  grow
                  // The pill's 13px type, not the 14px row edit, so the name
                  // keeps its size when editing starts.
                  size="inherit"
                  className="-ml-1.5"
                  style={
                    branchEditWidth !== null
                      ? { minWidth: `${branchEditWidth}px` }
                      : undefined
                  }
                  value={branchEditValue}
                  disabled={branchRenamePending}
                  // Frozen while the remote confirmation is up: an edit after
                  // arming it would let "Rename anyway" commit the stale
                  // snapshot while the input shows a different name.
                  readOnly={branchRenameRemoteConfirm !== null}
                  autoFocus
                  spellCheck={false}
                  aria-label="Rename branch"
                  onFocus={(e): void => e.currentTarget.select()}
                  onCommit={(next): void => {
                    branchEditCommittedRef.current = true;
                    void commitBranchRename(next);
                  }}
                  onCancel={(): void => {
                    // Abandon any pending remote confirmation too: leaving it
                    // set would make the `commitBranchRename` guard swallow
                    // every later rename, and re-arming would seed the popover
                    // with this abandoned name.
                    setBranchRenameRemoteConfirm(null);
                    setBranchEditValue(null);
                    dismissBranchRenameRefusal();
                  }}
                  onBlur={(): void => {
                    // Leaving with the name unchanged ends the edit; a changed
                    // name went through `onCommit` (which may hold the edit open
                    // for the pushed-branch confirmation).
                    if (branchEditCommittedRef.current) {
                      branchEditCommittedRef.current = false;
                      return;
                    }
                    if (branchRenameRemoteConfirm === null) {
                      setBranchEditValue(null);
                      dismissBranchRenameRefusal();
                    }
                  }}
                />
                {branchRenameRefusal !== null && (
                  <span id={branchRenameRefusalId} className="sr-only">
                    {branchRenameRefusal}
                  </span>
                )}
                {branchRenameRemoteConfirm !== null && (
                  <ConfirmDialog
                    title="Rename pushed branch?"
                    message="This branch has already been pushed to remote. Renaming will only change the local branch name — the old remote branch and any associated PRs will still exist."
                    confirmLabel="Rename anyway"
                    dataTestId="pr-status-bar-branch-rename-remote-confirm"
                    // The input this opened from leaves with the edit, so focus
                    // returns to the branch pill that replaces it.
                    restoreFocusRef={branchMenuTriggerRef}
                    onCancel={(): void => {
                      setBranchRenameRemoteConfirm(null);
                      setBranchEditValue(null);
                    }}
                    onConfirm={(): void => {
                      // Belt and braces with the input's readOnly freeze:
                      // commit whatever the input SHOWS, never a stale
                      // snapshot.
                      void performBranchRename(
                        branchEditValue?.trim() !== ''
                          ? (branchEditValue?.trim() ??
                              branchRenameRemoteConfirm)
                          : branchRenameRemoteConfirm,
                      );
                    }}
                  />
                )}
              </span>
            ) : (
              // Wrapper so the hover copy button can overlay the pill's right
              // end as a SIBLING (a button inside the trigger <button> would be
              // invalid markup). `min-w-0` keeps the truncation shrink chain.
              <Surface
                as="span"
                variant="branch-control"
                className="group/branchpill relative -ml-1.5 inline-flex min-w-0 items-center"
                onMouseEnter={(e): void =>
                  setBranchPillLockedWidth(e.currentTarget.offsetWidth)
                }
                onMouseLeave={(): void => setBranchPillLockedWidth(null)}
                paneWidth={branchPillLockedWidth ?? undefined}
              >
                <ControlButton
                  ref={branchMenuTriggerRef}
                  type="button"
                  data-testid="pr-status-bar-branch-menu-trigger"
                  onClick={(e): void => {
                    setBranchMenuAnchorX(
                      e.clientX - e.currentTarget.getBoundingClientRect().left,
                    );
                    setBranchMenuOpen((prev) => !prev);
                  }}
                  aria-haspopup="menu"
                  aria-expanded={branchMenuOpen}
                  aria-controls={branchMenuOpen ? branchMenuId : undefined}
                  // While the copy is revealed, the trigger's right padding
                  // drops from 8px to 4px: that 4px IS the text-to-copy gap,
                  // and the label gets the reclaimed 4px back, so it truncates
                  // less.
                  presentation="branch-picker"
                  appearance={branchPillLockedWidth !== null}
                >
                  <span
                    ref={branchMenuAnchorRef}
                    aria-hidden="true"
                    className="pointer-events-none absolute bottom-0 h-0 w-0"
                    style={{ left: branchMenuAnchorX }}
                  />
                  {hasMultipleBranches && repoBranches ? (
                    <RepoBranchesHoverCard repoBranches={repoBranches}>
                      <span
                        className={`${POSTHOG_REPLAY_MASK_CLASS} ${BRANCH_LABEL}`}
                      >
                        {currentBranchDisplay}
                      </span>
                    </RepoBranchesHoverCard>
                  ) : (
                    <span
                      className={`${POSTHOG_REPLAY_MASK_CLASS} ${BRANCH_LABEL}`}
                      title={currentBranchRawLabel}
                    >
                      {currentBranchDisplay}
                    </span>
                  )}
                </ControlButton>
                {/* Quick copy, revealed on pill hover INSIDE the pill, in-flow
                  after the label. The wrapper's width is locked to its rest
                  measurement for the whole hover (see onMouseEnter), so the
                  pill NEVER grows: the label yields exactly the button's
                  width and `truncate` renders a real ellipsis — no overlap,
                  no fade. Insets are an equal 2px (24px in a 28px pill; the
                  trailing pr matches), and the radius follows the
                  nested-radius rule: wrapper 8px − 2px inset = 6px, same as
                  the running-action ✕. Copy is ALSO in the branch menu. */}
                {!hasMultipleBranches && branchPillLockedWidth !== null && (
                  <span className="inline-flex shrink-0 pr-0.5">
                    <Tooltip
                      label={copiedBranch ? 'Copied' : 'Copy branch name'}
                    >
                      <ControlButton
                        type="button"
                        onClick={handleCopyBranch}
                        data-testid="pr-status-bar-branch-copy"
                        aria-label={
                          copiedBranch ? 'Copied' : 'Copy branch name'
                        }
                        // Nested corner: the 24px control sits 2px inside the
                        // 28px rounded-md branch pill, so its radius is the 8px
                        // of that pill less the inset, keeping the arcs
                        // concentric.
                        presentation="branch-copy"
                      >
                        {copiedBranch ? (
                          <CheckIcon size={16} />
                        ) : (
                          <CopyIcon size={16} />
                        )}
                      </ControlButton>
                    </Tooltip>
                  </span>
                )}
              </Surface>
            )}
            <Menu
              id={branchMenuId}
              open={branchMenuOpen}
              onOpenChange={setBranchMenuOpen}
              anchorRef={branchMenuAnchorRef}
              // The anchor is a zero-size cursor-positioning marker; focus must
              // return to the actual branch button on Escape/selection, not the
              // aria-hidden span.
              returnFocusRef={branchMenuTriggerRef}
              placement="bottom-center"
              aria-label="Branch actions"
              data-testid="pr-status-bar-branch-menu"
              className="w-max max-w-[calc(100vw-16px)]"
            >
              <ActionMenuRowStyle>
                <MenuItem
                  data-testid="branch-menu-rename"
                  // Single-repo flips the pill into the inline input; multi-repo
                  // (several branches, no single inline target) opens the branch
                  // dialog's seeded rename. Both are the deliberate, labelled
                  // path — the double-click shortcut was cut on review.
                  onClick={
                    hasMultipleBranches
                      ? handleEditBranch
                      : beginInlineBranchRename
                  }
                >
                  <MenuItemIcon>
                    <PencilIcon />
                  </MenuItemIcon>
                  Rename branch
                </MenuItem>
                {isSingleRepoWorkspace && (
                  <MenuItem
                    data-testid="branch-menu-change"
                    onClick={branchChange.openPicker}
                  >
                    <MenuItemIcon>
                      <BranchIcon size="md" />
                    </MenuItemIcon>
                    Change branch
                  </MenuItem>
                )}
                {!hasMultipleBranches && (
                  <MenuItem
                    data-testid="branch-menu-copy"
                    onClick={(event): void => {
                      // preventDefault suppresses Menu's close-on-select
                      // so the row stays mounted to show the Copied confirmation
                      // (the pre-redesign inline copy button behaved this way).
                      event.preventDefault();
                      handleCopyBranch();
                    }}
                  >
                    <MenuItemIcon>
                      {copiedBranch ? (
                        <CheckIcon size={16} />
                      ) : (
                        <CopyIcon size={16} />
                      )}
                    </MenuItemIcon>
                    {/* Stacked-label trick: an invisible copy of the LONGER
                    label always occupies the cell, so the visible swap to
                    "Copied" cannot narrow the `w-max` menu. */}
                    <span className="grid">
                      <span
                        aria-hidden="true"
                        className="invisible col-start-1 row-start-1 whitespace-nowrap"
                      >
                        Copy branch name
                      </span>
                      <span className="col-start-1 row-start-1 whitespace-nowrap">
                        {copiedBranch ? 'Copied' : 'Copy branch name'}
                      </span>
                    </span>
                  </MenuItem>
                )}
                <MenuItem
                  data-testid="branch-menu-info"
                  onClick={(): void => {
                    setBranchMenuOpen(false);
                    handleOpenBranchInfo();
                  }}
                >
                  <MenuItemIcon>
                    <InfoIcon />
                  </MenuItemIcon>
                  Branch info
                </MenuItem>
              </ActionMenuRowStyle>
            </Menu>
            {branchChange.open && (
              <WorktreeBranchTargetPicker
                workspaceId={projectId}
                currentBranch={worktreeBranchName}
                branchTargets={branchChange.targets}
                onSelect={branchChange.selectTarget}
                open={branchChange.open}
                onOpenChange={branchChange.setOpen}
                anchorRef={branchMenuTriggerRef}
                data-testid="pr-status-bar-change-branch-menu"
              />
            )}

            {/* Chevron separator */}
            {baseBranchDisplay && (
              <span
                className={BASE_BRANCH_GROUP}
                style={
                  visibleBaseBranchDrifts.length > 0
                    ? { minWidth: '6.375rem' }
                    : undefined
                }
              >
                {/* `-mx-[7px]` against the container's 6px gap pulls each
                  neighbouring control 1px PAST the chevron, so the visible
                  text-to-glyph gap is the buttons' own 8px padding less 1px.
                  Tightening here rather than on the container's gap keeps the
                  project icon → branch pill spacing untouched. */}
                <span className="-mx-1.75 shrink-0 fg-quaternary">
                  <ChevronRightMediumIcon size={16} />
                </span>

                {/* Base branch */}
                {isMultiRepo ? (
                  // Multi-repo: readonly text with hover popover
                  hasMultipleBases && repoBranches ? (
                    <RepoBranchesHoverCard repoBranches={repoBranches}>
                      <span
                        className={`${BRANCH_LABEL} ${BASE_BRANCH_ITEM} cursor-default fg-secondary`}
                      >
                        {baseBranchDisplay}
                      </span>
                    </RepoBranchesHoverCard>
                  ) : (
                    <span
                      className={`${BRANCH_LABEL} ${BASE_BRANCH_ITEM} fg-secondary`}
                      title={baseBranchDisplay ?? undefined}
                    >
                      {baseBranchDisplay}
                    </span>
                  )
                ) : (
                  // Single-repo: clickable dropdown trigger. HoverCard
                  // (not Tooltip): its wrapper carries no `shrink-0`, so with
                  // the button's floor moved onto it the trigger still yields
                  // space and the label truncates instead of overflowing the
                  // bar. The full branch name lives in the tooltip.
                  <HoverCard
                    triggerWrapperClassName={BASE_BRANCH_ITEM}
                    surfaceClassName="w-max max-w-72"
                    surfacePadding="compact"
                    content={
                      <span className="text-xs fg-primary">
                        {baseBranchDisplay}
                      </span>
                    }
                  >
                    <ControlButton
                      ref={baseBranchTriggerRef}
                      type="button"
                      onClick={handleBaseBranchClick}
                      data-testid="pr-status-bar-base-branch"
                      aria-haspopup="dialog"
                      aria-expanded={baseBranchDropdownOpen}
                      presentation="base-branch-picker"
                    >
                      <span className={BRANCH_LABEL}>{baseBranchDisplay}</span>
                    </ControlButton>
                  </HoverCard>
                )}
                {visibleBaseBranchDrifts.length > 0 &&
                  !baseBranchDriftConfirmationOpen && (
                    <BaseBranchDriftWarning
                      drifts={visibleBaseBranchDrifts}
                      onAlign={handleOpenBaseBranchAlignment}
                    />
                  )}
              </span>
            )}
          </div>

          {/* ---- Base branch dropdown (single-repo) ---- */}
          {baseBranchDropdownOpen && (
            <BaseBranchDropdownPortal
              anchorRef={baseBranchTriggerRef}
              projectId={projectId}
              worktreeId={worktreeId}
              currentValue={baseBranchDisplay}
              onSelect={handleBaseBranchSelect}
              onClose={handleBaseBranchClose}
            />
          )}

          {/* ---- PR badges and git/PR actions (shared, REG-3025) ---- */}
          <PullRequestActions
            plan={headerPlan}
            activity={headerActivity}
            onAction={handleHeaderAction}
            onCancel={handleCancelGitAction}
            renderProgress={renderHeaderProgress}
            renderMergeQueueStatus={renderMergeQueueStatus}
          />
        </div>
        {/* ---- Right-aligned actions ---- */}
        {/* Create PR sits with `Open in` rather than in the status flow: both
            are header-level actions on this worktree, and the shared cluster
            keeps them on one 8px rhythm. */}
        {/* `shrink-0` is load-bearing: every control inside is itself rigid
            (`shrink-0`), so a shrinkable cluster would be squeezed narrower
            than its contents and they would SPILL out of it — the `Open in`
            pill measured 912px inside an 882px wrapper and painted over the
            Launch button. Keeping the cluster rigid puts all the pressure on
            the breadcrumb, which truncates, and then on the priority tiers,
            which drop controls outright. */}
        <div className="flex shrink-0 items-center gap-2 electron-no-drag">
          {/* Archived chats: a worktree-level action, so it rides the header
              cluster rather than a single panel group's tab strip (which
              also made it move around as groups were split or popped out).
              This is the app's PRIMARY archive surface — one PrStatusBar is
              mounted at a time, for the selected worktree. */}
          {/* The tier class goes ON the control, not on a wrapper: it renders
              nothing when the worktree has no archived chats, and an empty
              wrapper still consumes one of the cluster's 8px gaps. */}
          <ArchivedChatsControl
            scope={{ projectId, worktreeId }}
            primarySurface
            className={HEADER_PRIORITY.archive}
          />
          {/* ---- Create PR button ---- */}
          <PullRequestCreateAction
            plan={headerPlan}
            activity={headerActivity}
            onAction={handleHeaderAction}
            onCancel={handleCancelGitAction}
            renderProgress={renderHeaderProgress}
          />
          <div className={HEADER_PRIORITY.openIn}>
            <OpenDropdown projectId={projectId} worktreeId={worktreeId} />
          </div>
        </div>
      </div>

      {/* ---- Modals ---- */}
      {pendingPushAction !== null && (
        <BranchNotRenamedWarning
          isMultiRepo={prStatus ? prStatus.repos.length > 1 : false}
          branchNames={warningBranchNames}
          unrenamedRepos={warnResult.unrenamedRepos}
          onContinue={handleWarningContinue}
          onRename={handleWarningRename}
          onClose={handleWarningClose}
        />
      )}
      {pendingBaseChange !== null && baseChangeConfirmationVisible && (
        <UpdatePrBaseConfirmation
          newBaseBranch={pendingBaseChange.branchName}
          onConfirm={handleConfirmPrBaseUpdate}
          onDecline={handleDeclinePrBaseUpdate}
          onClose={handleClosePrBaseUpdate}
        />
      )}
      {baseBranchDriftConfirmationOpen &&
        pendingBaseBranchAlignment !== null && (
          <AlignBaseBranchConfirmation
            drifts={pendingBaseBranchAlignment.drifts}
            onConfirm={(): void => resolveBaseBranchAlignment(true)}
            onClose={(): void => resolveBaseBranchAlignment(false)}
          />
        )}
      {mergeModalCandidates !== null && (
        <LocalOnlyMergeConfirmationModal
          candidates={mergeModalCandidates}
          isSubmitting={mergingLocalBranches}
          onConfirm={handleLocalOnlyMergeConfirm}
          onClose={handleLocalOnlyMergeClose}
        />
      )}
      {prMergeWarning !== null && (
        <PrMergeWarningModal
          unresolvedReviewThreadCount={
            prMergeWarning.unresolvedReviewThreadCount
          }
          prUrl={prMergeWarning.prUrl}
          isSubmitting={mergingPr}
          isTriaging={startingTriage}
          onConfirm={handleMergePrWarningConfirm}
          onTriageReviewComments={handleTriageReviewComments}
          onClose={handleMergePrWarningClose}
        />
      )}
      {prMergeMultiRepo !== null && (
        <PrMergeMultiRepoModal
          repos={prMergeMultiRepo.repos}
          isChecking={prMergeMultiRepo.isChecking}
          checkFailed={prMergeMultiRepo.checkFailed}
          isSubmitting={mergingPr}
          onConfirm={handleMergePrMultiConfirm}
          onRetry={handleMergePrClick}
          onClose={handleMergePrMultiClose}
        />
      )}
    </div>
  );
});
