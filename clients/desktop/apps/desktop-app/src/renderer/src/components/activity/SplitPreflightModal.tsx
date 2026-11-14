import { type JSX } from 'react';
import { Stack, Button, Notice } from '@canopy/ui-shared/components';
import { DialogModal } from '@/components/shared/DialogModal';
import { useActivityStore } from '@/stores/activityStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { useBrowserStore } from '@/stores/browserStore';
import { useScriptsStore, isScriptRunActive } from '@/stores/scriptsStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useSplitPrReadiness } from '@/hooks/useSplitPrReadiness';
import { useProjectsStore } from '@/stores/projectsStore';
import {
  SPLIT_PR_BLOCKER_COPY,
  type SplitPrReadiness,
} from '@/lib/splitPrEligibilityInputs';

/** Live counts of worktree resources that will be terminated by the split. */
export interface SplitPreflightRunningResources {
  terminals: number;
  browsers: number;
  scripts: number;
}

/**
 * Ordered high-level phases of the split-PR workflow, shown so the user knows
 * what they're about to kick off before the worktree gets locked.
 */
const SPLIT_PREFLIGHT_STEPS: readonly string[] = [
  'Plan — analyze the PR diff',
  'Review — approve or edit the proposed split',
  'Create the integration branch',
  'Carve, verify, and open a PR for each child',
  'Finalize — close the original PR',
];

export interface SplitPreflightModalProps {
  projectId: string;
  worktreeId: string;
  runningResources: SplitPreflightRunningResources;
  readiness: SplitPrReadiness;
  onStart: () => void;
  onCancel: () => void;
}

/**
 * Pre-flight gate rendered between clicking any of the four split-PR launch
 * surfaces (worktree-row menu item, PR activity panel primary button, PR
 * status bar button, post-failure "Plan new split" button) and actually
 * starting the workflow. Always shows the lock notice; shows the termination
 * warning only when a resource of that kind is currently running; and
 * re-checks `readiness` live so blockers that appear while the modal is open
 * disable Start with the same copy the launch surfaces already use.
 */

/** "2 terminals, 1 browser tab, and 3 running scripts" for the close warning. */
function describeRunningResources(resources: {
  terminals: number;
  browsers: number;
  scripts: number;
}): string {
  const parts: string[] = [];
  if (resources.terminals > 0) {
    parts.push(
      `${String(resources.terminals)} ${resources.terminals === 1 ? 'terminal' : 'terminals'}`,
    );
  }
  if (resources.browsers > 0) {
    parts.push(
      `${String(resources.browsers)} ${resources.browsers === 1 ? 'browser tab' : 'browser tabs'}`,
    );
  }
  if (resources.scripts > 0) {
    parts.push(
      `${String(resources.scripts)} ${resources.scripts === 1 ? 'running script' : 'running scripts'}`,
    );
  }
  if (parts.length <= 1) return parts.join('');
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

export function SplitPreflightModal({
  worktreeId,
  runningResources,
  readiness,
  onStart,
  onCancel,
}: SplitPreflightModalProps): JSX.Element {
  const hasRunningResources =
    runningResources.terminals > 0 ||
    runningResources.browsers > 0 ||
    runningResources.scripts > 0;
  const blocked = readiness.blockers.length > 0;

  return (
    <DialogModal
      inset="flush"
      onClose={onCancel}
      title="Start Split PR"
      subtitle={`Worktree ${worktreeId}`}
      maxWidth="lg"
      dataTestId="split-preflight-modal"
    >
      <div className="flex flex-col px-6 py-4 gap-4">
        <Stack gap="inline">
          <p className="text-xs font-semibold fg-secondary">
            What happens next
          </p>
          <ol
            className="flex flex-col list-decimal pl-6 text-s fg-primary/90 gap-1"
            data-testid="split-preflight-steps"
          >
            {SPLIT_PREFLIGHT_STEPS.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </Stack>

        <Notice
          role="none"
          intent="neutral"
          data-testid="split-preflight-lock-notice"
        >
          This worktree will be locked while the split runs to keep it clean —
          no chats, workflows, scripts, terminals, or hooks until it finishes.
        </Notice>

        {hasRunningResources && (
          <Notice
            role="none"
            intent="attention"
            data-testid="split-preflight-termination-warning"
            title="Running work will be closed"
          >
            {/* Prose, not bullets: one sentence naming what starting closes. */}
            Starting closes {describeRunningResources(runningResources)}.
          </Notice>
        )}

        {blocked && (
          <Notice
            errorSource="split-preflight-blockers"
            role="none"
            intent="destructive"
            data-testid="split-preflight-blockers"
            title="Not ready to start"
          >
            {/* The blockers read as prose after the title instead of a
                bulleted list: one sentence each, so each gets its own full
                stop. */}
            {readiness.blockers
              .map((blocker) => `${SPLIT_PR_BLOCKER_COPY[blocker]}.`)
              .join(' ')}
          </Notice>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t px-6 py-3">
        <Button
          size="compact"
          onClick={onCancel}
          data-testid="split-preflight-cancel"
        >
          Cancel
        </Button>
        <Button
          variant="primary"
          size="compact"
          disabled={blocked}
          onClick={onStart}
          data-testid="split-preflight-start"
        >
          Start
        </Button>
      </div>
    </DialogModal>
  );
}

/**
 * Subscribed (not one-shot) count of live terminal sessions for a worktree,
 * so a terminal starting or stopping while the pre-flight modal is open
 * updates the termination warning without requiring a re-open. Mirrors the
 * `${projectId}/${worktreeId}` key format `useSplitPrReadiness` already
 * subscribes with.
 */
function useLiveTerminalCount(projectId: string, worktreeId: string): number {
  const key = `${projectId}/${worktreeId}`;
  return useTerminalStore((state) => {
    const bucket = state.worktrees[key];
    if (!bucket) return 0;
    return Object.values(bucket.sessions).filter((session) => session.live)
      .length;
  });
}

/** Subscribed count of live browser tabs for a worktree. See {@link useLiveTerminalCount}. */
function useLiveBrowserCount(projectId: string, worktreeId: string): number {
  const key = `${projectId}/${worktreeId}`;
  return useBrowserStore((state) => {
    const bucket = state.worktrees[key];
    if (!bucket) return 0;
    return bucket.live.size;
  });
}

/** Subscribed count of running/stopping scripts for a worktree. See {@link useLiveTerminalCount}. */
function useRunningScriptCount(projectId: string, worktreeId: string): number {
  const key = `${projectId}/${worktreeId}`;
  return useScriptsStore((state) => {
    const runs = state.runs[key];
    if (!runs) return 0;
    return Object.values(runs).filter((run) => isScriptRunActive(run.status))
      .length;
  });
}

/**
 * App-root host that renders {@link SplitPreflightModal} for whichever
 * worktree `activityStore.splitPreflight` currently targets. Mounted once
 * (mirrors `ImportPlanModalHost`) so all four launch surfaces — which only
 * ever call `openSplitPreflight` — share one modal instance instead of each
 * surface owning its own. Running-resource counts are subscribed selectors
 * (`useLiveTerminalCount` / `useLiveBrowserCount` / `useRunningScriptCount`)
 * on the terminal/browser/scripts stores, all keyed the same
 * `${projectId}/${worktreeId}` way `useSplitPrReadiness` already reads its
 * own store slices, so the warning stays live and updates while the modal is
 * open if a terminal/browser/script starts or stops — not just at the moment
 * the modal first opens.
 *
 * `onStart` below calls the lockdown-aware `startSplitWorkflow` (A5).
 *
 * Complete map of Split PR fresh-launch / re-plan call sites in the renderer
 * (i.e. everywhere that is NOT routed through `openSplitPreflight`):
 *  1. THIS call site (`onStart` below) — the sole fresh-launch entry, now
 *     wired to `startSplitWorkflow` (terminate resources -> acquire lock ->
 *     plan). Every UI launch surface funnels here via `openSplitPreflight`.
 *  2. `SplitWorkflowView.tsx`'s embedded review-step `onRegenerate` — an
 *     intra-flow re-plan (discard the current proposed plan, ask for a new
 *     one) that only exists once the user is already inside a flow the
 *     pre-flight modal already gated on entry. Deliberately exempt: routing
 *     it back through the pre-flight modal would re-show the lock/blocker
 *     gate for a worktree that is already locked and mid-review.
 * The only remaining exempt call site is (2). `dispatcher.ts`'s
 * `github.split_pr` App Advisor action is NOT exempt: it routes through
 * `openSplitPreflight` like the four UI surfaces (it derives the same
 * eligibility/gating pre-checks first, then opens the pre-flight modal), so the
 * human still reviews the resource-termination gate and clicks Start. This is
 * required because the panel's Approve now calls the lockdown-aware
 * `approveSplitWorkflow`, which rejects unless the pre-flight modal's Start has
 * acquired the split lock.
 * All four UI click-launch surfaces (worktree-row menu item, PR activity
 * panel primary button, PR status bar button, and the post-failure "Plan new
 * split" button) AND the App Advisor `github.split_pr` dispatch call
 * `openSplitPreflight` and terminate at call site 1.
 */
export function SplitPreflightModalHost(): JSX.Element {
  const splitPreflight = useActivityStore((state) => state.splitPreflight);
  const closeSplitPreflight = useActivityStore(
    (state) => state.closeSplitPreflight,
  );
  const startSplitWorkflow = useGitHubStore(
    (state) => state.startSplitWorkflow,
  );
  const isSingleRepoWorkspace = useProjectsStore((state) =>
    splitPreflight
      ? state.projects.find((item) => item.id === splitPreflight.projectId)
          ?.type === 'single-repo'
      : false,
  );
  const readiness = useSplitPrReadiness(
    splitPreflight?.projectId ?? '',
    splitPreflight?.worktreeId ?? '',
    isSingleRepoWorkspace,
  );
  // Hooks must run unconditionally regardless of whether a target is set —
  // '' is the same no-target sentinel key `useSplitPrReadiness` above uses,
  // and every counter returns 0 for a bucket that doesn't exist.
  const terminals = useLiveTerminalCount(
    splitPreflight?.projectId ?? '',
    splitPreflight?.worktreeId ?? '',
  );
  const browsers = useLiveBrowserCount(
    splitPreflight?.projectId ?? '',
    splitPreflight?.worktreeId ?? '',
  );
  const scripts = useRunningScriptCount(
    splitPreflight?.projectId ?? '',
    splitPreflight?.worktreeId ?? '',
  );

  if (!splitPreflight) {
    return <></>;
  }

  const { projectId, worktreeId } = splitPreflight;
  const runningResources: SplitPreflightRunningResources = {
    terminals,
    browsers,
    scripts,
  };

  return (
    <SplitPreflightModal
      projectId={projectId}
      worktreeId={worktreeId}
      runningResources={runningResources}
      readiness={readiness}
      onStart={(): void => {
        closeSplitPreflight();
        // A5: the shared launch path is now the lockdown-aware
        // `startSplitWorkflow` (terminate resources -> acquire lock -> plan).
        // The store action clears stale per-key split state for every launch
        // surface, so no per-surface reset is needed here.
        void startSplitWorkflow(projectId, worktreeId);
      }}
      onCancel={closeSplitPreflight}
    />
  );
}
