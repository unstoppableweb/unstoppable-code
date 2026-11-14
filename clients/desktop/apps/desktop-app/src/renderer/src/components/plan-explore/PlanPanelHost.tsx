/**
 * Plan workspace panel hosts: the `plan` (document) and `plan-diagram`
 * panel kinds. The panel registry loads this module lazily, so the plan
 * viewer (Markdown, comments, follow-up dialogs) never joins the startup
 * path, and each view loads the diagram modules only when it shows one.
 *
 * A host resolves its plan by id in the owning worktree (the panel's
 * worktree context, never the globally selected worktree), shows a loading
 * state until the plan is known, a neutral state once the plan is gone
 * (the plan panel reconciler closes such panels after the worktree's plan
 * inventory loads), and a load error with Try again when fetching the plan
 * failed.
 *
 * A loaded, editable plan panel leases its plan's working file while it is
 * visible (so main notices an agent's edits to that file) and registers as a
 * view of the plan for the worktree's active plan: it becomes the active plan
 * when it becomes the visible active tab, or on pointer or focus inside it.
 * Read-only recipients do neither.
 */
import type { JSX } from 'react';
import { SHARED_CONTAINER_VIEWER_PROJECT_ID } from '@canopy/desktop-shared/types';
import { Notice, NoticeButton } from '@canopy/ui-shared';
import { PlanDiagramPanelView } from '@/components/plan-explore/PlanDiagramPanelView';
import { PlanPanelView } from '@/components/plan-explore/PlanPanelView';
import { useActivePlanRegistration } from '@/components/plan-explore/useActivePlanRegistration';
import {
  usePlanFileVisibilityLease,
  type PlanFileVisibilityRef,
} from '@/components/plan-explore/usePlanFileVisibilityLease';
import { usePlanViewData } from '@/components/plan-explore/usePlanViewData';
import {
  CenteredLoadingSpinner,
  DelayedLoadingPlaceholder,
  EmptyState,
} from '@canopy/ui-shared/components';
import type { PlanPanelKind } from '@/lib/panels/plan-panel-identity';
import { useWorkspaceIsReadOnly } from '@/lib/workspace-access';

/** Props the panel registry passes to both plan panel hosts. */
export interface PlanPanelHostProps {
  readonly projectId: string;
  readonly worktreeId: string;
  /** Tracked plan id bound to the panel (`instance.planId`, trimmed, non-empty). */
  readonly planId: string;
  readonly panelId: string;
  /** Whether the panel is its group's active tab. */
  readonly isActive: boolean;
  /** Whether the panel is visible (its group's active tab and the host is shown). */
  readonly isVisible: boolean;
}

interface PlanPanelStatusProps {
  readonly kind: PlanPanelKind;
  readonly testId: string;
  readonly label: string;
  readonly loading?: boolean;
}

function PlanPanelStatus({
  kind,
  testId,
  label,
  loading = false,
}: PlanPanelStatusProps): JSX.Element {
  return (
    <div
      data-testid={testId}
      data-plan-panel-kind={kind}
      className="flex min-h-0 flex-1"
    >
      {loading ? (
        // Neither the plan document nor its diagram is available to measure yet.
        <DelayedLoadingPlaceholder slowNote="Still loading the plan…">
          <CenteredLoadingSpinner />
        </DelayedLoadingPlaceholder>
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState title={label} tone="quiet" titleWeight="normal" />
        </div>
      )}
    </div>
  );
}

interface PlanPanelLoadErrorProps {
  readonly kind: PlanPanelKind;
  readonly onRetry: () => void;
}

/** A failed plan fetch, which may succeed when tried again. */
function PlanPanelLoadError({
  kind,
  onRetry,
}: PlanPanelLoadErrorProps): JSX.Element {
  return (
    <div
      data-testid="plan-panel-load-error"
      data-plan-panel-kind={kind}
      className="flex min-h-0 flex-1 flex-col p-3"
    >
      <Notice
        errorSource="plan-panel-load"
        intent="destructive"
        actions={
          <NoticeButton
            variant="primary"
            data-testid="plan-panel-retry"
            onClick={onRetry}
          >
            Try again
          </NoticeButton>
        }
      >
        Couldn't load this plan.
      </Notice>
    </div>
  );
}

/**
 * A shared-container recipient's plan panel scope is read-only.
 */
function usePlanPanelReadOnly(projectId: string): boolean {
  const workspaceReadOnly = useWorkspaceIsReadOnly();
  return workspaceReadOnly || projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID;
}

function PlanPanelHostContent({
  kind,
  host,
}: {
  readonly kind: PlanPanelKind;
  readonly host: PlanPanelHostProps;
}): JSX.Element {
  const data = usePlanViewData(host, host.planId);
  const readOnly = usePlanPanelReadOnly(host.projectId);
  const { projectId, worktreeId, planId } = host;
  const editable = data.status === 'ready' && !readOnly;
  const planRef: PlanFileVisibilityRef | null = editable
    ? { projectId, worktreeId, planId }
    : null;
  usePlanFileVisibilityLease(planRef, host.isVisible);
  const markActive = useActivePlanRegistration(
    planRef,
    host.isActive && host.isVisible,
  );
  if (data.status === 'loading') {
    return (
      <PlanPanelStatus
        kind={kind}
        testId="plan-panel-loading"
        loading
        label="Plan"
      />
    );
  }
  if (data.status === 'missing') {
    return (
      <PlanPanelStatus
        kind={kind}
        testId="plan-panel-missing"
        label="This plan is no longer available"
      />
    );
  }
  if (data.status === 'error') {
    return <PlanPanelLoadError kind={kind} onRetry={data.retry} />;
  }
  return kind === 'plan' ? (
    <PlanPanelView
      plan={data.plan}
      readOnly={readOnly}
      isActive={host.isActive}
      isVisible={host.isVisible}
      onActivate={markActive}
    />
  ) : (
    <PlanDiagramPanelView
      plan={data.plan}
      readOnly={readOnly}
      isActive={host.isActive}
      isVisible={host.isVisible}
      onActivate={markActive}
    />
  );
}

/** Host for a `plan` panel (the plan document view). */
export function PlanPanelHost(props: PlanPanelHostProps): JSX.Element {
  return <PlanPanelHostContent kind="plan" host={props} />;
}

/** Host for a `plan-diagram` panel (the plan's diagram in its own panel). */
export function PlanDiagramPanelHost(props: PlanPanelHostProps): JSX.Element {
  return <PlanPanelHostContent kind="plan-diagram" host={props} />;
}
