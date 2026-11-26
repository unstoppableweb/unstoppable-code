import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  Stack,
  Button,
  EmptyStateText,
  Notice,
  NoticeButton,
  Surface,
} from '@canopy/ui-shared/components';
import {
  GitPullRequestIcon,
  SplitPrIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { ActivitySection } from './ActivitySection';
import { LoadingSpinner } from '../shared/loading/spinners/LoadingSpinner';
import { Tooltip } from '@canopy/ui-shared/components';
import {
  isSplitPrEligible,
  useGitHubStore,
  worktreeKey,
} from '@/stores/githubStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { createDiffStatsKey } from '@/stores/projectsStore.diffStats';
import { useActivityStore } from '@/stores/activityStore';
import { useSplitPrGatingPreferences } from '@/hooks/useSplitPrPreferences';
import { useSplitPrReadiness } from '@/hooks/useSplitPrReadiness';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useCanopyDesktopPrSplitEnabled } from '@/hooks/useCanopyDesktopPrSplitEnabled';
import {
  deriveSplitPrEligibilityInputs,
  splitPrLineCount,
  SPLIT_PR_BLOCKER_COPY,
} from '@/lib/splitPrEligibilityInputs';
import type {
  PrStatusData,
  RepoPrStatus,
  SplitPrDiscardResponse,
  SplitPrMap,
  SplitPrExecutionErrorCode,
  SplitPrPlanRefusalCode,
  SplitPrProgressEvent,
} from '@canopy/desktop-shared/types/github';
import type { SplitPlanIssue } from '@canopy/desktop-shared/types/pr-split-plan';
import {
  PullRequestRepoDetail,
  PullRequestSectionBody,
  type PullRequestSectionPrStatus,
  type PullRequestSectionRepo,
} from '@canopy/ui-app/pull-request-section-body';
import { PullRequestReviewApprovalNotice } from '@canopy/ui-app/review-approval-link';
import { brandText } from '@/lib/brand';
import { useProjectReviewApprovalRunOwner } from '@/lib/review-approval-run-owner';
import { isPrReadyToMerge } from '@/lib/pr-mergeability';
import {
  useActivitySectionChrome,
  type CollapsedIconColor,
} from '@/components/shared/panel-section';
import { SplitProgressChecklist } from './SplitProgressChecklist';
import { SplitFailureModal } from './SplitFailureModal';
import { SplitInterruptedModal } from './SplitInterruptedModal';
import { SplitResultSummary } from './SplitResultSummary';
import {
  buildSplitProgressView,
  type SplitProgressView,
} from '@/lib/split-progress';

interface PullRequestSectionProps {
  projectId: string;
  worktreeId: string;
}

/**
 * Map the desktop `PrStatusData` onto the shared presentational status: the
 * shapes are structurally aligned (CAN-1528 extraction), with merge readiness
 * — whose inputs (`mergeable`/`mergeableState`) are desktop-only — computed
 * here so the shared card can pick the approved-badge tone without importing
 * `@canopy/desktop-shared`.
 */
function toBodyStatus(
  status: PrStatusData | null,
): PullRequestSectionPrStatus | null {
  if (!status) {
    return null;
  }
  return { ...status, isMergeReady: isPrReadyToMerge(status) };
}

function toBodyRepo(repo: RepoPrStatus): PullRequestSectionRepo {
  return {
    repoId: repo.repoId,
    repoName: repo.repoName,
    status: toBodyStatus(repo.status),
  };
}

/**
 * Desktop-compat wrapper over the shared {@link PullRequestRepoDetail}: keeps
 * the pre-extraction `RepoPrStatus` signature and the section-chrome context
 * read for existing desktop call sites and tests.
 */
export function SingleRepoDetail({
  repo,
  hideGitHubLink,
}: {
  repo: RepoPrStatus;
  hideGitHubLink?: boolean;
}): JSX.Element {
  const chrome = useActivitySectionChrome();
  return (
    <PullRequestRepoDetail
      status={toBodyStatus(repo.status)}
      hideGitHubLink={hideGitHubLink}
      framelessChecks={chrome === 'frameless'}
    />
  );
}

/**
 * User-facing copy per planner refusal code. `null` means the backend's own
 * message is the best copy we have (e.g. `invalid_plan` explains what was
 * wrong with the generated plan).
 */
const SPLIT_PR_REFUSAL_COPY: Record<SplitPrPlanRefusalCode, string | null> = {
  head_out_of_sync:
    'Local branch is out of sync with the PR — push or pull first.',
  base_not_ancestor: 'Rebase or merge the base branch first.',
  fork_pr_unsupported: 'Splitting a PR opened from a fork is not supported.',
  no_open_pr: 'There is no open pull request to split.',
  multi_repo_unsupported:
    'Splitting is only supported in single-repo projects.',
  invalid_plan: null,
};

function getSplitRefusalCopy(refusal: {
  code: SplitPrPlanRefusalCode;
  message: string;
}): string {
  return SPLIT_PR_REFUSAL_COPY[refusal.code] ?? refusal.message;
}

/** One line per issue: "childN: message" when the issue names a child, else just the message. */
function formatSplitPlanIssue(issue: SplitPlanIssue): string {
  return issue.childIndex !== undefined
    ? `Child ${issue.childIndex}: ${issue.message}`
    : issue.message;
}

/**
 * Display cap for the refusal issues list: the planner can emit one error
 * per failing hunk, and an unbounded list would blow out the compact notice.
 * The full validation detail is still available in the plan review modal, so
 * this list only needs to stay skimmable.
 */
const SPLIT_PR_REFUSAL_ISSUES_DISPLAY_CAP = 8;

function SplitProgressOverlay({
  view,
  isSplitting,
  canRetry,
  canEditPlan,
  onCancel,
  onRetry,
  onEditPlan,
  onDismiss,
}: {
  view: SplitProgressView;
  isSplitting: boolean;
  canRetry: boolean;
  canEditPlan: boolean;
  onCancel: () => void;
  onRetry: () => void;
  onEditPlan: () => void;
  onDismiss: () => void;
}): JSX.Element {
  return (
    <Surface
      variant="group"
      size="small"
      padding="compact"
      data-testid="split-progress"
    >
      <div className="flex flex-col gap-2">
        <SplitProgressChecklist view={view} />
        <div className="flex flex-wrap gap-2">
          {isSplitting && (
            <Button
              size="compact"
              onClick={onCancel}
              data-testid="split-progress-cancel"
            >
              Cancel
            </Button>
          )}
          {view.terminal === 'error' && canRetry && (
            <Button
              size="compact"
              onClick={onRetry}
              data-testid="split-progress-retry"
            >
              Try again
            </Button>
          )}
          {view.terminal === 'error' && canEditPlan && (
            <Button
              size="compact"
              onClick={onEditPlan}
              data-testid="split-progress-edit-plan"
            >
              Edit plan
            </Button>
          )}
          {(view.terminal === 'error' || view.terminal === 'cancelled') && (
            <Button
              size="compact"
              onClick={onDismiss}
              data-testid="split-progress-dismiss"
            >
              Dismiss
            </Button>
          )}
        </div>
      </div>
    </Surface>
  );
}

function SplitResultView({
  map,
  canResume,
  onResume,
  onPlanNewSplit,
  onDiscard,
}: {
  map: SplitPrMap;
  canResume: boolean;
  onResume: () => void;
  onPlanNewSplit: () => void;
  onDiscard: () => void;
}): JSX.Element {
  return (
    <Surface
      variant="group"
      size="small"
      padding="compact"
      data-testid="split-result"
    >
      <div className="flex flex-col gap-2">
        <SplitResultSummary map={map} />
        {(map.status === 'failed' || map.status === 'cancelled') && (
          <div className="flex flex-col gap-1.5">
            {canResume ? (
              <Button
                className="self-start"
                size="compact"
                onClick={onResume}
                data-testid="split-result-resume"
              >
                Resume split
              </Button>
            ) : (
              <>
                <p className="text-2xs fg-secondary">
                  Resuming needs the reviewed plan, which is no longer
                  available. Plan a new split to continue.
                </p>
                <Button
                  className="self-start"
                  size="compact"
                  onClick={onPlanNewSplit}
                  data-testid="split-result-replan"
                >
                  Plan new split
                </Button>
              </>
            )}
            <Button
              className="self-start"
              variant="ghost-destructive"
              size="compact"
              onClick={onDiscard}
              data-testid="split-pr-discard"
            >
              Discard split state
            </Button>
          </div>
        )}
      </div>
    </Surface>
  );
}

/**
 * Post-discard notice listing the branches and PR numbers the discarded split
 * left behind. v1 performs no destructive cleanup, so this is purely
 * informational so the user can clean them up manually if they wish.
 */
function SplitDiscardArtifacts({
  artifacts,
}: {
  artifacts: SplitPrDiscardResponse;
}): JSX.Element {
  const hasArtifacts =
    artifacts.branches.length > 0 || artifacts.prNumbers.length > 0;
  return (
    <Surface
      variant="group"
      size="small"
      padding="tight"
      data-testid="split-pr-discard-artifacts"
    >
      <div className="flex flex-col text-2xs fg-secondary gap-1">
        <p className="fg-primary/80">Split state discarded.</p>
        {hasArtifacts ? (
          <>
            <p>
              These artifacts were left behind and can be cleaned up manually:
            </p>
            {artifacts.branches.length > 0 && (
              <p className="break-words">
                Branches: {artifacts.branches.join(', ')}
              </p>
            )}
            {artifacts.prNumbers.length > 0 && (
              <p className="break-words">
                PRs: {artifacts.prNumbers.map((n) => `#${n}`).join(', ')}
              </p>
            )}
          </>
        ) : (
          <EmptyStateText
            title="No branches or PRs were created yet — nothing to clean up."
            tone="inherit"
          />
        )}
      </div>
    </Surface>
  );
}

/**
 * Refusal-style notice for a classified `executeSplitPr` `status: 'failed'`
 * envelope. Rendered as a SIBLING of (and takes precedence over)
 * `SplitResultView`/`SplitProgressOverlay`: `plan_mismatch` in particular
 * throws before the backend ever transitions the persisted map to
 * `status: 'failed'`, so `SplitResultView`'s own Discard affordance (gated on
 * `map.status === 'failed' | 'cancelled'`) would otherwise never appear and
 * the user would be stuck behind only a transient toast. Showing Discard
 * directly here — keyed off the structured failure, not the map — fixes
 * that gap for `plan_mismatch` and gives every other classified execute
 * failure the same direct recovery path.
 */
function SplitExecuteFailureNotice({
  failure,
  onDiscard,
  onDismiss,
}: {
  failure: {
    code?: SplitPrExecutionErrorCode;
    message: string;
    childIndex?: number;
    verifyTail?: string;
  };
  onDiscard: () => void;
  onDismiss: () => void;
}): JSX.Element {
  return (
    <Notice
      intent="attention"
      data-testid="split-pr-execute-failure"
      onDismiss={onDismiss}
      dismissLabel="Dismiss split failure notice"
      dismissTestId="split-pr-execute-failure-dismiss"
      {...(failure.code === 'plan_mismatch'
        ? {
            actions: (
              <NoticeButton
                variant="secondary"
                onClick={onDiscard}
                data-testid="split-pr-execute-failure-discard"
              >
                Discard split state
              </NoticeButton>
            ),
          }
        : {})}
    >
      <span className="whitespace-pre-wrap break-words">{failure.message}</span>
    </Notice>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function usePullRequestHeaderChrome({
  projectId,
  worktreeId,
}: PullRequestSectionProps): {
  subtitle: string;
  collapsedIconColor: CollapsedIconColor;
  hasContent: boolean;
} {
  const key = worktreeKey(projectId, worktreeId);
  const {
    status,
    creating,
    splitting,
    creationProgress,
    planningSplit,
    splitProgress,
    splitResult,
    splitRefusal,
    splitExecuteFailure,
    discardedArtifacts,
  } = useGitHubStore(
    useShallow((state) => ({
      status: state.prStatuses[key],
      creating: state.creatingPr.has(key),
      splitting: state.splittingPr.has(key),
      creationProgress: state.creationProgress[key],
      planningSplit: state.planningSplitPr.has(key),
      splitProgress: state.splitPrProgress[key],
      splitResult: state.splitPrResults[key],
      splitRefusal: state.splitPrRefusals[key],
      splitExecuteFailure: state.splitPrExecuteFailures[key],
      discardedArtifacts: state.splitPrDiscardedArtifacts[key],
    })),
  );
  const count =
    status?.repos.filter((repo) => repo.status !== null).length ?? 0;
  return {
    subtitle: creating
      ? 'Creating pull request…'
      : splitting
        ? 'Splitting pull request…'
        : count > 0
          ? `${count} pull request${count === 1 ? '' : 's'}`
          : 'No pull request',
    collapsedIconColor: creating || splitting || count > 0 ? 'amber' : 'muted',
    hasContent:
      count > 0 ||
      creating ||
      creationProgress !== undefined ||
      planningSplit ||
      splitting ||
      (splitProgress?.length ?? 0) > 0 ||
      splitResult !== undefined ||
      splitRefusal !== undefined ||
      splitExecuteFailure !== undefined ||
      discardedArtifacts !== undefined,
  };
}

export function PullRequestSection({
  projectId,
  worktreeId,
}: PullRequestSectionProps): JSX.Element {
  const headerChrome = usePullRequestHeaderChrome({ projectId, worktreeId });
  const chrome = useActivitySectionChrome();
  const key = worktreeKey(projectId, worktreeId);
  const prStatus = useGitHubStore((state) => state.prStatuses[key]);
  const isCreating = useGitHubStore((state) => state.creatingPr.has(key));
  const creationProgress = useGitHubStore(
    (state) => state.creationProgress[key],
  );
  const discardedArtifacts = useGitHubStore(
    (state) => state.splitPrDiscardedArtifacts[key] ?? null,
  );

  const {
    isPlanningSplit,
    isSplitting,
    splitPlan,
    splitProgress,
    splitResult,
    splitRefusal,
    splitExecuteFailure,
    splitLocked,
    splitWorkflowSession,
    gitActionInProgress,
    gitActionCancellationRequested,
  } = useGitHubStore(
    useShallow((state) => ({
      isPlanningSplit: state.planningSplitPr.has(key),
      isSplitting: state.splittingPr.has(key),
      splitPlan: state.splitPrPlans[key],
      splitProgress: state.splitPrProgress[key],
      splitResult: state.splitPrResults[key],
      splitRefusal: state.splitPrRefusals[key],
      splitExecuteFailure: state.splitPrExecuteFailures[key],
      splitLocked: state.splitLockedWorktrees.has(key),
      splitWorkflowSession: state.splitWorkflowSessions.has(key),
      gitActionInProgress: state.gitActionOperationIds[key] !== undefined,
      gitActionCancellationRequested:
        state.gitActionCancellationRequested.has(key),
    })),
  );
  const startSplitWorkflow = useGitHubStore(
    (state) => state.startSplitWorkflow,
  );
  const cancelSplitPr = useGitHubStore((state) => state.cancelSplitPr);
  const discardSplitPr = useGitHubStore((state) => state.discardSplitPr);
  const clearSplitPrDiscardedArtifacts = useGitHubStore(
    (state) => state.clearSplitPrDiscardedArtifacts,
  );
  const activeDiscardKeyRef = useRef<string | null>(key);
  const clearSplitPlan = useGitHubStore((state) => state.clearSplitPlan);
  const clearSplitExecuteFailure = useGitHubStore(
    (state) => state.clearSplitExecuteFailure,
  );
  const loadSplitPrMap = useGitHubStore((state) => state.loadSplitPrMap);
  // Both the primary Split PR button and the post-failure "Plan new split"
  // button open the pre-flight modal instead of calling `planSplitPr`
  // directly, so they go through the same gate as the worktree menu item and
  // status bar button (see `SplitPreflightModalHost`).
  const openSplitPreflight = useActivityStore(
    (state) => state.openSplitPreflight,
  );

  const { splitPrEnabled, splitPrThresholdLines } =
    useSplitPrGatingPreferences();
  const canopyDesktopPrSplitEnabled = useCanopyDesktopPrSplitEnabled();
  const reviewApprovalRunOwner = useProjectReviewApprovalRunOwner(projectId);
  const isSingleRepoWorkspace = useProjectsStore(
    (state) =>
      state.projects.find((item) => item.id === projectId)?.type ===
      'single-repo',
  );
  const diffStats = useProjectsStore(
    (state) => state.diffStats[createDiffStatsKey(projectId, worktreeId)],
  );

  // Hydrate a persisted split map (if any) so the result view survives
  // renderer reloads.
  useEffect(() => {
    void loadSplitPrMap(projectId, worktreeId);
  }, [loadSplitPrMap, projectId, worktreeId]);

  const [splitOverlayDismissed, setSplitOverlayDismissed] = useState(false);
  // Session-scoped dismissal of the failure/interrupted modals. The failure
  // modal is the immediate surface over the normal UX; once the user leaves it,
  // the persistent inline `SplitExecuteFailureNotice` remains and the modal
  // stays dismissed for the rest of this session. The interrupted modal is a
  // one-time-per-open prompt for a crash-interrupted (stale) executing map.
  const [failureModalDismissed, setFailureModalDismissed] = useState(false);
  const [interruptedModalDismissed, setInterruptedModalDismissed] =
    useState(false);

  // Reset per-worktree local split UI state when the section switches target.
  // The modal dismissals reset so a new worktree gets a fresh prompt. The
  // discarded-artifact notice is store-keyed, so it cannot leak between keys.
  useEffect(() => {
    setSplitOverlayDismissed(false);
    setFailureModalDismissed(false);
    setInterruptedModalDismissed(false);
  }, [key]);

  // Post-discard artifacts are useful only while the user remains on this
  // worktree. Drop the keyed notice when the section switches target or
  // unmounts so returning later cannot resurrect stale cleanup guidance.
  useEffect(() => {
    activeDiscardKeyRef.current = key;
    return (): void => {
      if (activeDiscardKeyRef.current === key) {
        activeDiscardKeyRef.current = null;
      }
      clearSplitPrDiscardedArtifacts(projectId, worktreeId);
    };
  }, [clearSplitPrDiscardedArtifacts, key, projectId, worktreeId]);

  // A newly-arriving failure envelope re-shows the modal (a stale prior
  // dismissal must not suppress a fresh failure).
  useEffect(() => {
    if (splitExecuteFailure !== undefined) {
      setFailureModalDismissed(false);
    }
  }, [splitExecuteFailure]);

  // A4 leftover: a fresh launch from ANY surface (menu item, status-bar
  // button, PR-panel button, post-failure button) funnels through
  // `startSplitWorkflow`, which sets `planningSplitPr` for the key. Clearing
  // the stale post-discard notice here — rather than only inside the PR-panel
  // button's `handlePlanSplit` — means every launch surface drops the notice.
  useEffect(() => {
    if (isPlanningSplit) {
      clearSplitPrDiscardedArtifacts(projectId, worktreeId);
    }
  }, [clearSplitPrDiscardedArtifacts, isPlanningSplit, projectId, worktreeId]);

  // A fresh execution always re-shows the overlay.
  useEffect(() => {
    if (isSplitting) {
      setSplitOverlayDismissed(false);
    }
  }, [isSplitting]);

  // Derivation shared with the App Advisor `github.split_pr` dispatcher via
  // `deriveSplitPrEligibilityInputs`, fed from this component's own reactive
  // `prStatus`/`diffStats`/gating-preference subscriptions above, so both
  // callers derive eligibility from identical logic instead of two
  // independently maintained blocks.
  const splitEligibilityInputs = deriveSplitPrEligibilityInputs({
    prStatus,
    diffStats:
      diffStats !== undefined
        ? { insertions: diffStats.insertions, deletions: diffStats.deletions }
        : undefined,
    splitPrEnabled,
    thresholdLines: splitPrThresholdLines,
    isSingleRepo: isSingleRepoWorkspace,
  });
  const splitEligible = isSplitPrEligible(splitEligibilityInputs);
  const splitLineCount = splitPrLineCount(splitEligibilityInputs);
  // Blocker-only readiness (uncommitted changes / unpushed commits / merge
  // conflicts / active pipelines / active chats), used to render the button
  // disabled-with-tooltip instead of hidden once `splitEligible` is true.
  const splitReadiness = useSplitPrReadiness(
    projectId,
    worktreeId,
    isSingleRepoWorkspace,
  );
  const splitBlocked = splitEligible && splitReadiness.blockers.length > 0;

  const splitEvents = useMemo(
    (): SplitPrProgressEvent[] => splitProgress ?? [],
    [splitProgress],
  );
  const splitProgressView = useMemo(
    () => buildSplitProgressView(splitEvents, isSplitting),
    [splitEvents, isSplitting],
  );

  // The overlay covers the in-flight run plus non-success terminal states;
  // once the run reaches `done`, the persisted-map result view takes over.
  const showSplitProgress =
    !splitOverlayDismissed &&
    (isSplitting ||
      (splitEvents.length > 0 && splitProgressView.terminal !== 'done'));
  // `splitExecuteFailure` takes precedence over the persisted-map result
  // view: a `plan_mismatch` failure in particular is thrown before the
  // backend ever transitions the persisted map to `status: 'failed'`, so
  // without this guard `SplitResultView` would still render the STALE
  // `status: 'executing'` map with no actions at all while
  // `SplitExecuteFailureNotice` renders alongside it.
  const showSplitResult =
    splitResult !== undefined &&
    !isSplitting &&
    !showSplitProgress &&
    splitExecuteFailure === undefined;
  // Rendered even when `splitBlocked` — the button itself becomes
  // disabled-with-tooltip in that case rather than being hidden, so a
  // blocked-but-eligible worktree still surfaces the entry point.
  const showSplitButton =
    canopyDesktopPrSplitEnabled &&
    splitEligible &&
    !isPlanningSplit &&
    !isSplitting &&
    !showSplitProgress &&
    splitPlan === undefined &&
    splitResult === undefined;

  // Failure modal: shown over the normal UX whenever a structured execute
  // failure exists AND the user has not dismissed it this session. The worktree
  // must NOT be locked AND must NOT have an open workflow session (either shows
  // the SplitWorkflowView instead; the failure is only surfaced once the lock
  // releases and the session ends so normal UX returns). The session close on
  // failure settle happens BEFORE the failure state is recorded, so the two
  // surfaces never double-stack.
  const showFailureModal =
    splitExecuteFailure !== undefined &&
    !failureModalDismissed &&
    !splitLocked &&
    !splitWorkflowSession &&
    !isSplitting;
  // Retry/Edit are only offered when a stored plan+snapshot survive (post-reload
  // they are dropped from the in-memory store); otherwise the modal offers
  // Discard + a re-plan note routed through the pre-flight modal.
  const failureCanRecover = splitPlan !== undefined;

  // Interrupted-split (stale executing map) detection. A persisted map still in
  // `status: 'executing'` with NO live lock for the key is a crash/reload
  // remnant (A5's reload-release drops the lock, so a genuinely in-flight run
  // would still hold it). Guarded against false-positives during a REAL run by
  // also requiring `!splitLocked && !isSplitting`, and suppressed while a
  // structured failure is being surfaced (the failure modal owns that case).
  const staleExecutingMap =
    splitResult !== undefined &&
    splitResult.status === 'executing' &&
    !splitLocked &&
    !splitWorkflowSession &&
    !isSplitting &&
    !isPlanningSplit &&
    splitExecuteFailure === undefined;
  const showInterruptedModal =
    staleExecutingMap && !interruptedModalDismissed && !showFailureModal;

  function handleInterruptedResume(): void {
    setInterruptedModalDismissed(true);
    clearSplitPrDiscardedArtifacts(projectId, worktreeId);
    // The renderer cannot reproduce the original reviewed plan+snapshot after a
    // restart, so Resume routes through the pre-flight modal (fresh re-plan).
    // The engine's fingerprint gate resumes cleanly when the re-plan matches.
    openSplitPreflight(projectId, worktreeId);
  }

  // Surface Split PR gating/progress state to App Advisor's current-UI-state
  // snapshot so the assistant can see whether the github.split_pr action is
  // currently available or already running for the visible worktree.
  // `splitWorkflowActive` mirrors the SplitWorkflowView swap condition
  // (`splitLocked || splitWorkflowSession`) — the full-panel workflow (which
  // hides normal worktree UX) is up while EITHER the lock is held OR the
  // presentation session persists (e.g. the Finalize finished page after a
  // completed settle releases the lock). The lock alone still blocks
  // worktree-mutating dispatcher actions; the session is presentation-only, so
  // the assistant should treat this flag as "the workflow panel is showing"
  // rather than "actions are locked". `splitPrBlockers` is only ever non-empty
  // when `splitEligible` is true (see `deriveSplitPrReadiness`), so it doubles
  // as "why can't I start yet" even though the worktree qualifies.
  useCurrentUiStateReporter('worktree.pullRequest', {
    gitActionInProgress,
    gitActionCancellationRequested,
    splitPrEligible: splitEligible,
    splitPrInProgress: isPlanningSplit || isSplitting,
    splitPrCompleted: splitResult !== undefined,
    splitWorkflowActive: splitLocked || splitWorkflowSession,
    splitPrFailureModalOpen: showFailureModal,
    splitPrInterruptedModalOpen: showInterruptedModal,
    splitPrBlockers: splitReadiness.blockers,
  });

  // Retry / "Resume split" from the inline progress overlay and the result
  // view. This must re-enter the LOCKED workflow (mode 'resume') — exactly like
  // the failure modal's Retry — so the retry terminates lingering resources,
  // acquires the split lock, swaps in the locked SplitWorkflowView at the
  // Execute step, and resumes from the checkpointed engine map. The old
  // `executeSplitPr` path ran UNLOCKED (no termination, no lock, no workflow
  // view), so it is intentionally gone.
  function handleSplitRetry(): void {
    if (splitPlan === undefined) return;
    setSplitOverlayDismissed(false);
    clearSplitPrDiscardedArtifacts(projectId, worktreeId);
    void startSplitWorkflow(projectId, worktreeId, {
      mode: 'resume',
      plan: splitPlan.plan,
      snapshot: splitPlan.snapshot,
    });
  }

  // Failure-modal Retry: re-enter the LOCKED workflow via mode 'resume', which
  // resumes from the checkpointed engine map using the stored plan+snapshot.
  // The locked SplitWorkflowView swaps in with the Execute step active.
  function handleFailureModalRetry(): void {
    if (splitPlan === undefined) return;
    setFailureModalDismissed(true);
    setSplitOverlayDismissed(false);
    clearSplitPrDiscardedArtifacts(projectId, worktreeId);
    void startSplitWorkflow(projectId, worktreeId, {
      mode: 'resume',
      plan: splitPlan.plan,
      snapshot: splitPlan.snapshot,
    });
  }

  // Failure-modal Edit plan: re-enter the LOCKED workflow via mode 'review',
  // landing on the Review step with the STORED plan (no LLM re-plan).
  function handleFailureModalEditPlan(): void {
    if (splitPlan === undefined) return;
    setFailureModalDismissed(true);
    setSplitOverlayDismissed(false);
    clearSplitPrDiscardedArtifacts(projectId, worktreeId);
    void startSplitWorkflow(projectId, worktreeId, { mode: 'review' });
  }

  function handlePlanSplit(): void {
    // Dismiss the failure modal BEFORE opening the pre-flight so the two do not
    // stack. This handler is shared by the failure modal's "Plan new split"
    // (where the failure modal is open) and the result view's onPlanNewSplit
    // (where it is not) — dismissing is a harmless no-op in the latter case.
    setFailureModalDismissed(true);
    setSplitOverlayDismissed(false);
    clearSplitPrDiscardedArtifacts(projectId, worktreeId);
    // A fresh launch surface (shown after a failed/cancelled split with no
    // resumable plan) — routes through the shared pre-flight modal like the
    // other three launch surfaces instead of calling `planSplitPr` directly.
    openSplitPreflight(projectId, worktreeId);
  }

  // Post-failure "Edit plan" from the inline overlay: the editable review UI
  // now lives only in the locked SplitWorkflowView. When a stored plan exists,
  // re-enter the workflow at Review (mode 'review'); otherwise route through
  // the pre-flight modal for a fresh re-plan.
  function handleEditPlan(): void {
    setSplitOverlayDismissed(false);
    clearSplitPrDiscardedArtifacts(projectId, worktreeId);
    if (splitPlan !== undefined) {
      void startSplitWorkflow(projectId, worktreeId, { mode: 'review' });
      return;
    }
    openSplitPreflight(projectId, worktreeId);
  }

  function handleDiscardSplit(): void {
    const requestKey = key;
    void discardSplitPr(projectId, worktreeId).then((result) => {
      if (result !== null && activeDiscardKeyRef.current !== requestKey) {
        clearSplitPrDiscardedArtifacts(projectId, worktreeId);
      }
    });
  }

  const bodyRepos = useMemo(() => prStatus?.repos.map(toBodyRepo), [prStatus]);

  const creationProgressPresent = creationProgress != null;
  const hasSplitUi =
    isPlanningSplit ||
    showSplitProgress ||
    showSplitResult ||
    splitRefusal !== undefined ||
    // Keep the section mounted while a structured execute failure is surfaced
    // (inline notice + failure modal both need this host mounted).
    splitExecuteFailure !== undefined ||
    // Keep the section mounted after a discard deletes the result so the
    // post-discard artifacts notice (a sibling of SplitResultView) can render.
    discardedArtifacts !== null;

  if (!isCreating && !creationProgressPresent && !prStatus && !hasSplitUi) {
    return <></>;
  }

  return (
    <ActivitySection
      icon={<GitPullRequestIcon />}
      title="Pull requests"
      subtitle={headerChrome.subtitle}
      collapsedIconColor={headerChrome.collapsedIconColor}
    >
      <PullRequestSectionBody
        extensionGap="item"
        repos={bodyRepos}
        isCreating={isCreating}
        creationProgress={creationProgress}
        framelessChecks={chrome === 'frameless'}
        renderReviewNotice={(repo) =>
          repo.status === null ? null : (
            <PullRequestReviewApprovalNotice
              runOwner={reviewApprovalRunOwner}
              prUrl={repo.status.prUrl}
              prState={repo.status.state}
              brandName={brandText.appName}
            />
          )
        }
      >
        {splitRefusal !== undefined && (
          <Notice
            intent="attention"
            data-testid="split-pr-refusal"
            onDismiss={() => clearSplitPlan(projectId, worktreeId)}
            dismissLabel="Dismiss split refusal notice"
            dismissTestId="split-pr-refusal-dismiss"
          >
            <Stack gap="tight">
              <span className="whitespace-pre-wrap break-words">
                {getSplitRefusalCopy(splitRefusal)}
              </span>
              {splitRefusal.issues !== undefined &&
                splitRefusal.issues.length > 0 && (
                  <ul
                    data-testid="split-pr-refusal-issues"
                    className="flex flex-col list-disc pl-4 gap-0.5"
                  >
                    {splitRefusal.issues
                      .slice(0, SPLIT_PR_REFUSAL_ISSUES_DISPLAY_CAP)
                      .map((issue, index) => (
                        <li
                          key={`${issue.code}-${issue.childIndex ?? ''}-${issue.file ?? ''}-${issue.hunkIndex ?? ''}-${index}`}
                          className="whitespace-pre-wrap break-words"
                        >
                          {formatSplitPlanIssue(issue)}
                        </li>
                      ))}
                    {splitRefusal.issues.length >
                      SPLIT_PR_REFUSAL_ISSUES_DISPLAY_CAP && (
                      <li
                        data-testid="split-pr-refusal-issues-more"
                        className="fg-secondary"
                      >
                        +
                        {splitRefusal.issues.length -
                          SPLIT_PR_REFUSAL_ISSUES_DISPLAY_CAP}{' '}
                        more
                      </li>
                    )}
                  </ul>
                )}
            </Stack>
          </Notice>
        )}
        {splitExecuteFailure !== undefined && (
          <SplitExecuteFailureNotice
            failure={splitExecuteFailure}
            onDiscard={handleDiscardSplit}
            onDismiss={() => clearSplitExecuteFailure(projectId, worktreeId)}
          />
        )}
        {isPlanningSplit && (
          <div
            data-testid="split-pr-planning"
            className="flex items-center gap-2 text-xs fg-secondary"
          >
            <LoadingSpinner />
            <span>Analyzing PR diff…</span>
          </div>
        )}
        {showSplitProgress && (
          <SplitProgressOverlay
            view={splitProgressView}
            isSplitting={isSplitting}
            canRetry={splitPlan !== undefined}
            canEditPlan={splitPlan !== undefined}
            onCancel={() => void cancelSplitPr(projectId, worktreeId)}
            onRetry={handleSplitRetry}
            onEditPlan={handleEditPlan}
            onDismiss={() => setSplitOverlayDismissed(true)}
          />
        )}
        {showSplitResult && splitResult !== undefined && (
          <SplitResultView
            map={splitResult}
            canResume={splitPlan !== undefined}
            onResume={handleSplitRetry}
            onPlanNewSplit={handlePlanSplit}
            onDiscard={handleDiscardSplit}
          />
        )}
        {/* Rendered as a SIBLING of SplitResultView, not nested inside it: a
            successful discard deletes `splitPrResults[key]` in the same store
            update, so `splitResult` (and thus SplitResultView) is gone by the
            time this notice should appear. Gate solely on `discardedArtifacts`. */}
        {discardedArtifacts !== null && (
          <SplitDiscardArtifacts artifacts={discardedArtifacts} />
        )}
        {showSplitButton && (
          <div>
            {splitBlocked ? (
              <Tooltip
                label="Split PR"
                description={splitReadiness.blockers
                  .map((blocker) => SPLIT_PR_BLOCKER_COPY[blocker])
                  .join('\n')}
              >
                <Button size="compact" disabled data-testid="split-pr-button">
                  <SplitPrIcon size="sm" />
                  Split PR
                  {splitLineCount !== undefined
                    ? ` (${splitLineCount.toLocaleString()} changed lines)`
                    : ''}
                </Button>
              </Tooltip>
            ) : (
              <Button
                size="compact"
                onClick={() => openSplitPreflight(projectId, worktreeId)}
                data-testid="split-pr-button"
              >
                <SplitPrIcon size="sm" />
                Split PR
                {splitLineCount !== undefined
                  ? ` (${splitLineCount.toLocaleString()} changed lines)`
                  : ''}
              </Button>
            )}
          </div>
        )}
        {showFailureModal && splitExecuteFailure !== undefined && (
          <SplitFailureModal
            worktreeId={worktreeId}
            failure={splitExecuteFailure}
            canRecover={failureCanRecover}
            onLeave={() => setFailureModalDismissed(true)}
            onRetry={handleFailureModalRetry}
            onEditPlan={handleFailureModalEditPlan}
            onDiscard={handleDiscardSplit}
            onPlanNew={handlePlanSplit}
          />
        )}
        {showInterruptedModal && splitResult !== undefined && (
          <SplitInterruptedModal
            worktreeId={worktreeId}
            childTotal={splitResult.children.length}
            onResume={handleInterruptedResume}
            onDiscard={handleDiscardSplit}
            onDismiss={() => setInterruptedModalDismissed(true)}
          />
        )}
      </PullRequestSectionBody>
    </ActivitySection>
  );
}
