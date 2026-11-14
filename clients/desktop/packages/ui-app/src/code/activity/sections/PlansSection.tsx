'use client';

import { Badge } from '@canopy/ui-shared/components/Badge';
import type { JSX } from 'react';
import type { PortalPlan } from '@canopy/protocol/portal';
import { isCursorPlanExecutionUnavailable } from '@canopy/app-core/client';
import {
  Stack,
  Button,
  Markdown,
  PlanActionButtonRow,
  PlanCopyAction,
  PlanReviewStatusBadge,
  planCopyStateFromMarkdown,
  PlanProvenance,
  hasPlanProvenance,
  type PlanActionButtonRowItem,
} from '@canopy/ui-shared/components';
import { ChatIcon, DocumentIcon, PipelineIcon } from '@canopy/ui-shared/icons';
import { resolvePlanDisplayStatus } from '@canopy/ui-shared/lib';
import { PlansEmptyMessage } from '../plans/PlansEmptyMessage';
import { SkippedPlansNotice } from '../plans/SkippedPlansNotice';
import {
  INLINE_PLAN_MARKDOWN_OPTIONS,
  PLAN_MARKDOWN_OPTIONS,
  stripPlanTitleLine,
} from '../plans/plan-markdown';
import { Surface } from '@canopy/ui-shared/components';

export interface PlansSectionProps {
  readonly plans: readonly PortalPlan[];
  readonly onGetPlan?: (plan: PortalPlan) => void;
  readonly onImplementPlan?: (plan: PortalPlan) => void;
  /**
   * Hand the finished plan to a `plan_ready` pipeline (CAN-3019). Desktop
   * overrides this section body entirely, so this action is web-only today.
   */
  readonly onRunPlanPipeline?: (plan: PortalPlan) => void;
  /**
   * Open the host's plan import. Without it the empty state only explains
   * where plans come from; no web host can import yet.
   */
  readonly onImportPlan?: () => void;
  /**
   * Stored plans the host's read left out because they couldn't be read
   * (CAN-6695). The Portal's plan list carries no count yet, so web hosts
   * leave it out until the Plans view reads core.plan.list.
   */
  readonly skippedPlans?: number;
}

function PlanCard({
  plan,
  onGetPlan,
  onImplementPlan,
  onRunPlanPipeline,
}: PlansSectionProps & { readonly plan: PortalPlan }): JSX.Element {
  const body = stripPlanTitleLine(plan.content);
  const revision = plan.revisionNumber ?? plan.latestRevisionNumber;
  // List summaries carry the stored review in `status`; loaded details also
  // supply `reviewStatus`. Both are projections of the same review enum.
  const reviewStatus =
    plan.reviewStatus ??
    (plan.status === 'pending' ||
    plan.status === 'approved' ||
    plan.status === 'dismissed'
      ? plan.status
      : undefined);
  const executionUnavailable = isCursorPlanExecutionUnavailable(plan);
  const actions: PlanActionButtonRowItem[] = [];
  if (plan.content && onImplementPlan && !executionUnavailable) {
    actions.push({
      label: 'Implement',
      icon: <ChatIcon size="sm" aria-hidden="true" />,
      onClick: (): void => onImplementPlan(plan),
      dataTestId: `activity-plan-send-${plan.localId ?? plan.title}`,
    });
  }
  // After Implement, behind the same `plan.content` gate Implement
  // uses: a pipeline receives the plan body, so an unloaded plan has nothing
  // to dispatch. The label must stay unique — `PlanActionButtonRow` keys on it.
  if (plan.content && onRunPlanPipeline && !executionUnavailable) {
    actions.push({
      label: 'Workflow',
      icon: <PipelineIcon size="sm" aria-hidden="true" />,
      onClick: (): void => onRunPlanPipeline(plan),
      dataTestId: `activity-plan-pipeline-${plan.localId ?? plan.title}`,
    });
  }
  // Copy plan is the shared action desktop's plan header and card use too
  // (CAN-5354); an unloaded plan keeps Copy visible beside Load.
  const copyAction = (
    <PlanCopyAction
      state={planCopyStateFromMarkdown(plan.content)}
      appearance="card"
      dataTestId={`activity-plan-copy-${plan.localId ?? plan.title}`}
    />
  );
  if (!plan.content && onGetPlan) {
    actions.push({
      label: 'Load',
      icon: <DocumentIcon size="sm" aria-hidden="true" />,
      onClick: (): void => onGetPlan(plan),
    });
  }
  return (
    <Surface
      variant="group"
      interactive
      padding="compact"
      className="group/plan relative w-full"
      data-testid={`activity-plan-row-${plan.localId ?? plan.title}`}
    >
      <div className="text-left">
        <div className="truncate text-s font-semibold fg-primary">
          <Markdown options={INLINE_PLAN_MARKDOWN_OPTIONS}>
            {plan.title}
          </Markdown>
        </div>
        {body && (
          <div
            className="prose prose-sm mt-1 line-clamp-3 max-w-none text-xs leading-5 fg-secondary"
            data-testid={`activity-plan-body-${plan.localId ?? plan.title}`}
          >
            <Markdown options={PLAN_MARKDOWN_OPTIONS}>{body}</Markdown>
          </div>
        )}
        <div className="mt-2 flex items-center gap-3 text-2xs fg-secondary">
          {typeof revision === 'number' && (
            <Badge
              data-testid={`activity-plan-revision-${plan.localId ?? plan.title}`}
            >
              Rev {revision}
            </Badge>
          )}
          {plan.status && plan.status !== reviewStatus && (
            <span className="shrink-0">{plan.status}</span>
          )}
          {/* The Portal projection carries no execution evidence, so web shows
            the stored review status only (never Implementing/Implemented). */}
          <PlanReviewStatusBadge
            className="shrink-0"
            status={resolvePlanDisplayStatus({ reviewStatus })}
            data-testid={`activity-plan-status-${plan.localId ?? plan.title}`}
          />
          {hasPlanProvenance(plan.source, plan.sourceFilePath) ? (
            <PlanProvenance
              source={plan.source}
              sourceFilePath={plan.sourceFilePath}
            />
          ) : (
            plan.source && (
              <span className="fg-secondary/60">{plan.source}</span>
            )
          )}
        </div>
        {(actions.length > 0 || copyAction) && (
          <PlanActionButtonRow items={actions} trailing={copyAction} />
        )}
      </div>
    </Surface>
  );
}

export function PlansSection(props: PlansSectionProps): JSX.Element {
  if (props.plans.length === 0) {
    const { onImportPlan } = props;
    return (
      <Stack gap="inline" data-testid="activity-plans-empty">
        <SkippedPlansNotice count={props.skippedPlans} />
        <PlansEmptyMessage canImport={onImportPlan !== undefined} />
        {onImportPlan && (
          <Button
            className="self-start"
            variant="secondary"
            size="compact"
            data-testid="activity-plans-empty-import"
            onClick={onImportPlan}
          >
            Import plan
          </Button>
        )}
      </Stack>
    );
  }
  return (
    <div
      className="grid grid-cols-1 content-start max-h-76 overflow-y-auto gap-2"
      data-testid="activity-plans"
    >
      <SkippedPlansNotice count={props.skippedPlans} />
      {props.plans.map((plan) => (
        <PlanCard key={plan.localId ?? plan.title} {...props} plan={plan} />
      ))}
    </div>
  );
}
