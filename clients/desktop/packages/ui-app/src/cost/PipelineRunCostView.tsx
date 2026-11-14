'use client';

import { useStore } from 'zustand';
import type { CostClient, CostNavigator } from '@canopy/app-core';
import type { PipelineRunCostStore } from '@canopy/app-state/cost';
import { costTokenCount } from '@canopy/protocol/cost-view';
import type {
  CostAttributedItem,
  CostModelRow,
  CostScopeRef,
  PipelineRunCostView as PipelineRunCostViewValue,
  PipelineRunStepCost,
} from '@canopy/protocol/cost-view';
import type { JSX } from 'react';
import {
  CostFreshness,
  CostLegend,
  CostObservedTotal,
  CostSplitBar,
  COST_NOT_PRICED_LABEL,
  ProxyAccountCostList,
  ProxyAccountNames,
  COST_SOURCE_COLORS,
  costBarScale,
  costSourceSegments,
  formatCostAmountIn,
  formatCostTotalIn,
  useCostCurrency,
} from '@canopy/ui-shared/components/cost';
import { formatTokenCount } from '@canopy/ui-shared/lib/format-usage';
import {
  CostDetailSection,
  CostBillingSection,
  CostValueRow,
  CostValueRows,
} from './cost-detail-parts';
import {
  CostUnavailableState,
  useCostInsightsEnabled,
} from './CostInsightsGate';
import { CostViewFrame, costRefreshFailureReason } from './CostViewFrame';
import { PIPELINE_RUN_COST_VIEW_SAMPLE } from './cost-view-samples';
import { usePipelineRunCostStore } from './use-cost-view-store';
import { AttributedCostRow } from './session-breakdown/AttributedCostRow';

const RUN_SOURCES = [
  'pipeline',
  'subagents',
  'delegations',
  'background',
] as const;

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function stepTokenCount(step: PipelineRunStepCost): number {
  return costTokenCount(step.totals.tokens);
}

function stepMetadata(step: PipelineRunStepCost): string {
  const parts: string[] = [];
  if (step.model !== undefined) parts.push(step.model);
  if (step.harness !== undefined) parts.push(step.harness);
  parts.push(`${formatTokenCount(stepTokenCount(step))} tokens`);
  if (step.attemptCount > 1) {
    parts.push(plural(step.attemptCount, 'attempt', 'attempts'));
  }
  return parts.join(' · ');
}

function StepCostRow({
  step,
  maxTotal,
  scope,
  navigator,
}: {
  readonly step: PipelineRunStepCost;
  readonly maxTotal: number;
  readonly scope: CostScopeRef;
  readonly navigator: CostNavigator;
}): JSX.Element {
  const currency = useCostCurrency();
  const segments = costSourceSegments(step.totals.bySource, RUN_SOURCES);
  const total = step.totals.usd;
  const metadata = stepMetadata(step);
  const amount = formatCostTotalIn(step.totals, currency);
  const proxyAccounts = step.proxyAccounts ?? [];
  const open = (): void => {
    navigator.openPipelineJob?.(scope, step.executionId, step.jobId);
  };
  const content = (
    <>
      <span className="flex w-full min-w-0 items-baseline gap-3">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate fg-primary">{step.label}</span>
          <span className="truncate tabular-nums fg-tertiary">{metadata}</span>
          {proxyAccounts.length > 0 ? (
            <span className="flex min-w-0 fg-secondary">
              <ProxyAccountNames
                accounts={proxyAccounts}
                testId={`pipeline-run-cost-step-${step.jobId}-account`}
              />
            </span>
          ) : null}
        </span>
        <span className="ml-auto shrink-0 tabular-nums fg-secondary">
          {amount}
        </span>
      </span>
      <CostSplitBar
        segments={segments}
        label={`${step.label} cost`}
        scale={costBarScale(total, maxTotal)}
      />
    </>
  );
  const className =
    'flex w-full flex-col gap-1.5 rounded-md px-2 py-2 text-left text-xs pointer-coarse:min-h-11';
  // Account names stay out of the accessible name: session replay records
  // attributes, and the visible names are blocked from it.
  const accountsLabel =
    proxyAccounts.length === 0
      ? undefined
      : proxyAccounts.length === 1
        ? 'via account proxy'
        : `via account proxy, ${String(proxyAccounts.length)} accounts`;
  const ariaLabel = [step.label, metadata, accountsLabel, amount]
    .filter(Boolean)
    .join(', ');

  if (navigator.openPipelineJob !== undefined) {
    return (
      <button
        type="button"
        data-testid={`pipeline-run-cost-step-${step.jobId}`}
        aria-label={ariaLabel}
        onClick={open}
        className={`${className} focus-ring transition-colors hover:bg-subtle`}
      >
        {content}
      </button>
    );
  }
  return (
    <div
      data-testid={`pipeline-run-cost-step-${step.jobId}`}
      className={className}
    >
      {content}
    </div>
  );
}

function AdvisorCostRow({
  view,
  maxTotal,
}: {
  readonly view: PipelineRunCostViewValue;
  readonly maxTotal: number;
}): JSX.Element | null {
  const currency = useCostCurrency();
  const advisor = view.advisor;
  if (advisor === undefined) return null;
  const amount =
    advisor.usd === 0 && advisor.notPricedCount > 0
      ? COST_NOT_PRICED_LABEL
      : formatCostAmountIn(advisor.usd, currency);
  const details =
    advisor.reportCount === 1
      ? 'Run report'
      : `${advisor.reportCount} run reports`;
  const segments = [
    {
      key: 'background',
      label: 'Workflow Advisor',
      value: advisor.usd,
      color: COST_SOURCE_COLORS.background,
    },
  ];
  return (
    <div
      data-testid="pipeline-run-cost-advisor"
      className="flex w-full flex-col gap-1.5 px-2 py-2 text-xs"
    >
      <span className="flex min-w-0 items-baseline gap-3">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate fg-primary">Workflow Advisor</span>
          <span className="truncate tabular-nums fg-tertiary">{details}</span>
        </span>
        <span className="ml-auto shrink-0 tabular-nums fg-secondary">
          {amount}
        </span>
      </span>
      <CostSplitBar
        segments={segments}
        label="Workflow Advisor cost"
        scale={costBarScale(advisor.usd, maxTotal)}
      />
    </div>
  );
}

function ChildRunCostRow({
  child,
  maxTotal,
  scope,
  navigator,
}: {
  readonly child: PipelineRunCostViewValue['childRuns'][number];
  readonly maxTotal: number;
  readonly scope: CostScopeRef;
  readonly navigator: CostNavigator;
}): JSX.Element {
  const currency = useCostCurrency();
  const amount = formatCostTotalIn(
    {
      usd: child.usd,
      notPricedCount: child.notPricedCount ?? 0,
    },
    currency,
  );
  const metadata = plural(child.agentStepCount, 'agent step', 'agent steps');
  const content = (
    <>
      <span className="flex w-full min-w-0 items-baseline gap-3">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate fg-primary">{child.pipelineName}</span>
          <span className="truncate tabular-nums fg-tertiary">{metadata}</span>
        </span>
        <span className="ml-auto shrink-0 tabular-nums fg-secondary">
          {amount}
        </span>
      </span>
      <CostSplitBar
        segments={[
          {
            key: 'pipeline',
            label: 'Workflow steps',
            value: child.usd,
            color: COST_SOURCE_COLORS.pipeline,
          },
        ]}
        label={`${child.pipelineName} cost`}
        scale={costBarScale(child.usd, maxTotal)}
      />
    </>
  );
  const className =
    'flex w-full flex-col gap-1.5 rounded-md px-2 py-2 text-left text-xs pointer-coarse:min-h-11';
  const open = (): void => {
    navigator.openPipelineRun?.(scope, child.executionId);
  };

  if (navigator.openPipelineRun !== undefined) {
    return (
      <button
        type="button"
        data-testid={`pipeline-run-cost-child-${child.executionId}`}
        aria-label={`${child.pipelineName}, ${metadata}, ${amount}`}
        onClick={open}
        className={`${className} focus-ring transition-colors hover:bg-subtle`}
      >
        {content}
      </button>
    );
  }
  return (
    <div
      data-testid={`pipeline-run-cost-child-${child.executionId}`}
      className={className}
    >
      {content}
    </div>
  );
}

function AttributedItems({
  title,
  items,
  testIdPrefix,
}: {
  readonly title: string;
  readonly items: readonly CostAttributedItem[];
  readonly testIdPrefix: string;
}): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <CostDetailSection
      title={title}
      testId={`pipeline-run-cost-${testIdPrefix}`}
    >
      <ul className="flex flex-col">
        {items.map((item) => (
          <li key={item.id}>
            <AttributedCostRow
              item={item}
              testId={`pipeline-run-cost-item-${item.id}`}
            />
          </li>
        ))}
      </ul>
    </CostDetailSection>
  );
}

function ModelRows({
  rows,
}: {
  readonly rows: readonly CostModelRow[];
}): JSX.Element {
  const currency = useCostCurrency();
  return (
    <CostValueRows>
      {rows.map((row) => (
        <CostValueRow
          key={row.model}
          label={row.model}
          value={formatCostTotalIn(row, currency)}
        />
      ))}
    </CostValueRows>
  );
}

function NonAgentSteps({
  count,
}: {
  readonly count: number;
}): JSX.Element | null {
  if (count <= 0) return null;
  return (
    <p
      data-testid="pipeline-run-cost-non-agent"
      className="text-xs tabular-nums fg-tertiary"
    >
      {`${plural(count, 'other step', 'other steps')} ran no agent and cost nothing.`}
    </p>
  );
}

function PipelineRunCostContent({
  view,
  navigator,
  scope,
  sealed,
  updatedAt,
  refreshing,
  refreshProblemMessage,
  completedRefreshes,
  onRefresh,
  now,
}: {
  readonly view: PipelineRunCostViewValue;
  readonly navigator: CostNavigator;
  readonly scope: CostScopeRef;
  readonly sealed: boolean;
  readonly updatedAt: string | null;
  readonly refreshing: boolean;
  readonly refreshProblemMessage: string | null;
  readonly completedRefreshes: number;
  readonly onRefresh: () => void;
  readonly now?: number;
}): JSX.Element {
  const currency = useCostCurrency();
  // A nested run's steps are represented by its child run row.
  const runSteps = view.steps.filter(
    (step) => step.executionId === view.run.executionId,
  );
  const maxTotal = Math.max(
    0,
    ...runSteps.map((step) => step.totals.usd),
    view.advisor?.usd ?? 0,
    ...view.childRuns.map((child) => child.usd),
  );
  const sourceSegments = costSourceSegments(
    view.run.totals.bySource,
    RUN_SOURCES,
  );
  const sealedAt = view.sealedAt ?? updatedAt ?? view.updatedAt;
  const runStepCount = view.run.agentStepCount;

  return (
    <div
      data-testid="pipeline-run-cost-view"
      className="flex max-w-2xl flex-col gap-6"
    >
      <div className="flex items-center gap-2">
        <div
          data-testid="pipeline-run-cost-total"
          className="flex min-w-0 flex-1 items-baseline gap-1.5"
        >
          <CostObservedTotal
            amountLabel={formatCostTotalIn(view.run.totals, currency)}
            size="inline"
            testId="pipeline-run-cost-observed-total"
          />
          <span className="truncate text-xs fg-tertiary">
            · {plural(runStepCount, 'agent step', 'agent steps')}
          </span>
        </div>
        <CostFreshness
          updatedAt={sealed ? null : updatedAt}
          now={now}
          refreshing={!sealed && refreshing}
          failureReason={sealed ? null : refreshProblemMessage}
          sealedAt={sealed ? (sealedAt ?? undefined) : undefined}
          onRefresh={sealed ? undefined : onRefresh}
          completedRefreshes={completedRefreshes}
        />
      </div>
      <div className="flex flex-col gap-2">
        <CostSplitBar
          segments={sourceSegments}
          label="Run cost by source"
          size="summary"
        />
        <CostLegend segments={sourceSegments} showShare />
      </div>
      <div className="-mx-2 flex flex-col">
        {runSteps.map((step) => (
          <StepCostRow
            key={`${step.executionId}-${step.jobId}-${step.stepId}`}
            step={step}
            maxTotal={maxTotal}
            scope={scope}
            navigator={navigator}
          />
        ))}
        <AdvisorCostRow view={view} maxTotal={maxTotal} />
        {view.childRuns.map((child) => (
          <ChildRunCostRow
            key={child.executionId}
            child={child}
            maxTotal={maxTotal}
            scope={scope}
            navigator={navigator}
          />
        ))}
      </div>
      <AttributedItems
        title="Subagents"
        items={view.subagents}
        testIdPrefix="subagents"
      />
      <AttributedItems
        title="Delegations"
        items={view.delegations}
        testIdPrefix="delegations"
      />
      {view.nonAgentStepCount !== undefined ? (
        <NonAgentSteps count={view.nonAgentStepCount} />
      ) : null}
      <CostBillingSection
        totals={view.run.totals}
        label="Run cost by billing"
      />
      {view.byProxyAccount !== undefined && view.byProxyAccount.length > 0 ? (
        <CostDetailSection
          title="By account"
          testId="pipeline-run-cost-by-account"
        >
          <ProxyAccountCostList
            accounts={view.byProxyAccount}
            total={view.byProxyAccount.reduce(
              (total, account) => total + account.turnShare,
              0,
            )}
            noun="attempts"
            testId="pipeline-run-cost-account"
          />
        </CostDetailSection>
      ) : null}
      <CostDetailSection title="By model" testId="pipeline-run-cost-by-model">
        <ModelRows rows={view.byModel} />
      </CostDetailSection>
    </div>
  );
}

export interface PipelineRunCostViewProps {
  readonly client: CostClient;
  readonly navigator: CostNavigator;
  readonly scope: CostScopeRef;
  readonly executionId: string;
  readonly sealed?: boolean;
  readonly store?: PipelineRunCostStore;
  readonly now?: number;
}

/** A cost details view for an agent-bearing pipeline run. */
export function PipelineRunCostView(
  props: PipelineRunCostViewProps,
): JSX.Element {
  const enabled = useCostInsightsEnabled();
  if (!enabled) return <CostUnavailableState />;
  return <PipelineRunCostStoreView {...props} />;
}

function PipelineRunCostStoreView(
  props: PipelineRunCostViewProps,
): JSX.Element {
  const sealed = props.sealed ?? props.scope.kind === 'retained';
  if (props.store !== undefined) {
    return (
      <PipelineRunCostWithStore
        {...props}
        sealed={sealed}
        store={props.store}
      />
    );
  }
  return <PipelineRunCostWithManagedStore {...props} sealed={sealed} />;
}

interface PipelineStoreViewProps extends PipelineRunCostViewProps {
  readonly sealed: boolean;
  readonly store: PipelineRunCostStore;
}

function PipelineRunCostWithManagedStore(
  props: PipelineRunCostViewProps & { readonly sealed: boolean },
): JSX.Element {
  const store = usePipelineRunCostStore(
    props.client,
    props.scope,
    props.executionId,
  );
  return <PipelineRunCostWithStore {...props} store={store} />;
}

function PipelineRunCostWithStore({
  navigator,
  scope,
  sealed,
  now,
  store,
}: PipelineStoreViewProps): JSX.Element {
  const state = useStore(store, (current) => current);
  const retry = (): void => {
    void store.getState().load();
  };
  const onRefresh = (): void => {
    void store.getState().requestRefresh('manual');
  };

  return (
    <CostViewFrame
      value={state.value}
      status={state.status}
      problem={state.problem}
      onRetry={retry}
      loadingSample={PIPELINE_RUN_COST_VIEW_SAMPLE}
      testId="pipeline-run-cost-view"
    >
      {(view) => (
        <PipelineRunCostContent
          view={view}
          navigator={navigator}
          scope={scope}
          sealed={sealed}
          updatedAt={state.updatedAt}
          refreshing={state.refresh.status === 'refreshing'}
          refreshProblemMessage={costRefreshFailureReason(
            state.refresh.problem,
          )}
          completedRefreshes={state.refresh.completedManual}
          onRefresh={onRefresh}
          now={now}
        />
      )}
    </CostViewFrame>
  );
}
