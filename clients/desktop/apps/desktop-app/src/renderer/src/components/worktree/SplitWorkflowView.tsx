import { Stack, Divider, Heading, Surface } from '@canopy/ui-shared/components';
import { Button } from '@canopy/ui-shared/components';
import { useEffect, useMemo, type JSX } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useGitHubStore, worktreeKey } from '@/stores/githubStore';
import { LoadingSpinner } from '../shared/loading/spinners/LoadingSpinner';
import { Notice } from '@canopy/ui-shared/components';
import { SplitPlanReviewPanel } from '../activity/SplitPlanReviewPanel';
import { SplitProgressChecklist } from '../activity/SplitProgressChecklist';
import { SplitResultSummary } from '../activity/SplitResultSummary';
import { buildSplitProgressView } from '@/lib/split-progress';
import type {
  SplitPlan,
  SplitPrProgressEvent,
} from '@canopy/desktop-shared/types/github';

export interface SplitWorkflowViewProps {
  projectId: string;
  worktreeId: string;
}

type WorkflowStep = 'plan' | 'review' | 'execute' | 'finalize';

const STEP_ORDER: WorkflowStep[] = ['plan', 'review', 'execute', 'finalize'];
const STEP_LABELS: Record<WorkflowStep, string> = {
  plan: 'Plan',
  review: 'Review',
  execute: 'Execute',
  finalize: 'Done',
};

function StepRail({ active }: { active: WorkflowStep }): JSX.Element {
  const activeIndex = STEP_ORDER.indexOf(active);
  return (
    <ol className="flex shrink-0 items-center gap-3 border-b px-5 py-3">
      {STEP_ORDER.map((step, index) => {
        const isActive = step === active;
        const isDone = index < activeIndex;
        return (
          <li
            key={step}
            data-testid={`split-workflow-step-${step}`}
            data-active={isActive ? 'true' : 'false'}
            className="flex items-center gap-3"
          >
            <span className="inline-flex items-center gap-2">
              <span
                className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-3xs font-semibold ${
                  isActive
                    ? 'bg-accent-subtle fg-accent-strong ring-1 ring-line-accent/40'
                    : isDone
                      ? 'bg-success-subtle fg-success-strong'
                      : 'bg-fg-primary/[0.06] fg-secondary'
                }`}
              >
                {isDone ? '✓' : index + 1}
              </span>
              <span
                className={`text-xs font-medium ${
                  isActive ? 'fg-primary' : 'fg-secondary'
                }`}
              >
                {STEP_LABELS[step]}
              </span>
            </span>
            {index < STEP_ORDER.length - 1 && (
              <Divider className=" w-6" aria-hidden />
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Full-panel Split PR workflow shown while the selected worktree is under
 * lockdown OR has an open renderer-side workflow session
 * (`splitLockedWorktrees` OR `splitWorkflowSessions` has the key — the
 * WorktreeManager swap keys on the same union). It replaces the normal worktree
 * central panel and drives its step from store state:
 *
 *  - plan: `planningSplitPr` in flight, or a plan-time refusal landed while
 *    locked (surface the refusal, then auto-exit so the lock releases and the
 *    normal UX + PullRequestSection refusal notice takes over).
 *  - review: a proposed `splitPrPlans[key]` exists and execution hasn't
 *    started — renders the embedded `SplitPlanReviewPanel`.
 *  - execute: `splittingPr` in flight — renders the shared per-child checklist.
 *  - finalize: a completed `splitPrResults[key]` landed — a real finished page
 *    (success headline + shared `SplitResultSummary` + explicit Done button).
 *    The presentation session OUTLIVES the lock (which releases on the
 *    completed settle), so this page stays mounted until the user clicks Done,
 *    which closes the session and drops back to normal worktree UX (where the
 *    PR panel's result view remains available).
 */
export function SplitWorkflowView({
  projectId,
  worktreeId,
}: SplitWorkflowViewProps): JSX.Element {
  const key = worktreeKey(projectId, worktreeId);

  const {
    isPlanningSplit,
    isSplitting,
    splitPlan,
    splitProgress,
    splitResult,
    splitRefusal,
  } = useGitHubStore(
    useShallow((state) => ({
      isPlanningSplit: state.planningSplitPr.has(key),
      isSplitting: state.splittingPr.has(key),
      splitPlan: state.splitPrPlans[key],
      splitProgress: state.splitPrProgress[key],
      splitResult: state.splitPrResults[key],
      splitRefusal: state.splitPrRefusals[key],
    })),
  );

  const planSplitPr = useGitHubStore((state) => state.planSplitPr);
  const approveSplitWorkflow = useGitHubStore(
    (state) => state.approveSplitWorkflow,
  );
  const exitSplitWorkflow = useGitHubStore((state) => state.exitSplitWorkflow);
  const closeSplitWorkflowSession = useGitHubStore(
    (state) => state.closeSplitWorkflowSession,
  );
  const cancelSplitPr = useGitHubStore((state) => state.cancelSplitPr);
  const commitApprovedSplitPlan = useGitHubStore(
    (state) => state.commitApprovedSplitPlan,
  );

  const splitEvents = useMemo(
    (): SplitPrProgressEvent[] => splitProgress ?? [],
    [splitProgress],
  );
  const splitProgressView = useMemo(
    () => buildSplitProgressView(splitEvents, isSplitting),
    [splitEvents, isSplitting],
  );

  const completed =
    splitResult !== undefined && splitResult.status === 'completed';

  // A plan-time refusal that lands while locked must not strand the worktree
  // in the workflow view: release the lock so the user drops back to the
  // normal UX, where PullRequestSection's own refusal notice (keyed off the
  // still-present `splitPrRefusals[key]`) is what they land on. `exitSplitPr`
  // only releases the lock and cancels any in-flight execute — it does NOT
  // clear `splitPrRefusals`, so the refusal survives the exit.
  const refusalWhileLocked = !isPlanningSplit && splitRefusal !== undefined;
  useEffect(() => {
    if (refusalWhileLocked) {
      void exitSplitWorkflow(projectId, worktreeId);
    }
  }, [refusalWhileLocked, exitSplitWorkflow, projectId, worktreeId]);

  // Precedence: splitting > completed > planning > plan-present > plan. A
  // Regenerate re-plan sets `isPlanningSplit` while the previous
  // `splitPrPlans[key]` is still populated (planSplitPr preserves the stale
  // plan until the new one lands), so planning must win over an existing
  // plan or the user would see a stale, editable Review step mid-replan.
  // Planning cannot co-occur with splitting/completed, so those still take
  // priority.
  const activeStep: WorkflowStep = isSplitting
    ? 'execute'
    : completed
      ? 'finalize'
      : isPlanningSplit
        ? 'plan'
        : splitPlan !== undefined
          ? 'review'
          : 'plan';

  function handleApprove(edited: SplitPlan): void {
    if (splitPlan === undefined) return;
    // Commit the approved (possibly edited) plan to the store BEFORE executing
    // so the store — not component-local state — is the single source of truth
    // for Retry / Edit-plan even if this view unmounts before the run settles.
    commitApprovedSplitPlan(projectId, worktreeId, edited);
    void approveSplitWorkflow(
      projectId,
      worktreeId,
      edited,
      splitPlan.snapshot,
    );
  }

  return (
    <section
      data-testid="split-workflow-view"
      className="flex h-full min-h-0 flex-1 flex-col bg-base"
    >
      <div className="electron-drag flex max-h-10.75 shrink-0 items-center gap-2 border-b px-5 py-2">
        <span className="text-s font-semibold fg-primary">Split PR</span>
        <span className="text-xs fg-secondary">
          This worktree is locked while the split runs.
        </span>
      </div>

      <StepRail active={activeStep} />

      {activeStep === 'plan' && (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-5 py-6 text-center">
          {refusalWhileLocked ? (
            <div className="w-full max-w-md text-left">
              <Notice
                intent="attention"
                data-testid="split-workflow-refusal"
                detail="Returning to the worktree…"
              >
                <span className="whitespace-pre-wrap break-words">
                  {splitRefusal?.message}
                </span>
              </Notice>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 text-xs fg-secondary">
                <LoadingSpinner />
                <span>Analyzing PR diff…</span>
              </div>
              {/* Planning itself is not abortable (planPrSplit has no abort
                  signal), but the user can leave the locked workflow: exit
                  releases the lock immediately, dropping them back to normal
                  UX. Any plan that later resolves ok is dropped by the store
                  (see startSplitWorkflow's splitLockedWorktrees guard) since
                  the lock is no longer held. */}
              <Button
                size="compact"
                onClick={() => void exitSplitWorkflow(projectId, worktreeId)}
                data-testid="split-workflow-plan-cancel"
              >
                Cancel
              </Button>
            </>
          )}
        </div>
      )}

      {activeStep === 'review' && splitPlan !== undefined && (
        <SplitPlanReviewPanel
          projectId={projectId}
          worktreeId={worktreeId}
          planResponse={splitPlan}
          onApprove={handleApprove}
          onRegenerate={() => void planSplitPr(projectId, worktreeId)}
          onCancel={() => void exitSplitWorkflow(projectId, worktreeId)}
        />
      )}

      {activeStep === 'execute' && (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
          <SplitProgressChecklist view={splitProgressView} />
          <div className="flex flex-wrap gap-2">
            <Button
              size="compact"
              onClick={() => void cancelSplitPr(projectId, worktreeId)}
              data-testid="split-workflow-cancel"
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {activeStep === 'finalize' && (
        <div
          data-testid="split-workflow-finalize"
          className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-6"
        >
          <div className="flex flex-col mx-auto w-full min-w-0 max-w-5xl gap-4">
            <Stack gap="tight">
              <Heading level={2} variant="section" tone="success">
                Split complete
              </Heading>
              <p className="text-xs fg-secondary">
                The PR was split into an integration PR and its child PRs. The
                worktree now tracks the integration branch
                {splitResult !== undefined
                  ? ` (${splitResult.integrationBranch})`
                  : ''}
                .
              </p>
            </Stack>

            {splitResult !== undefined && (
              <Surface
                variant="group"
                size="small"
                padding="compact"
                className="min-w-0"
              >
                <SplitResultSummary map={splitResult} />
              </Surface>
            )}

            {splitResult !== undefined && splitResult.children.length > 0 && (
              <p className="text-2xs fg-secondary">
                Child worktrees were created for the carved branches and appear
                in the sidebar.
              </p>
            )}

            <div className="flex justify-end">
              <Button
                variant="primary"
                size="compact"
                onClick={() => closeSplitWorkflowSession(projectId, worktreeId)}
                data-testid="split-workflow-done"
              >
                Done
              </Button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
