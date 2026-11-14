'use client';

import { useStore } from 'zustand';
import type { CostClient } from '@canopy/app-core';
import type { PipelineRunCostStore } from '@canopy/app-state/cost';
import type { CostScopeRef } from '@canopy/protocol/cost-view';
import type { JSX } from 'react';
import {
  CostLegend,
  CostObservedTotal,
  CostSplitBar,
  costSourceSegments,
  formatCostTotalIn,
  useCostCurrency,
} from '@canopy/ui-shared/components/cost';
import { ChevronRightMediumIcon } from '@canopy/ui-shared/icons/AppIcons';
import { useCostInsightsEnabled } from './CostInsightsGate';
import { usePipelineRunCostStore } from './use-cost-view-store';

const RUN_SOURCES = [
  'pipeline',
  'subagents',
  'delegations',
  'background',
] as const;

export interface PipelineRunCostPreviewCardProps {
  readonly client: CostClient;
  readonly scope: CostScopeRef;
  readonly executionId: string;
  /** Opens the job list's Cost entry. */
  readonly onOpen: () => void;
  readonly store?: PipelineRunCostStore;
}

/** A compact, single-action summary preview of a pipeline run's cost. */
export function PipelineRunCostPreviewCard(
  props: PipelineRunCostPreviewCardProps,
): JSX.Element | null {
  const enabled = useCostInsightsEnabled();
  if (!enabled) return null;
  return <PipelineCostPreviewStoreView {...props} />;
}

function PipelineCostPreviewStoreView(
  props: PipelineRunCostPreviewCardProps,
): JSX.Element | null {
  if (props.store !== undefined) {
    return <PipelineCostPreviewWithStore {...props} store={props.store} />;
  }
  return <PipelineCostPreviewWithManagedStore {...props} />;
}

function PipelineCostPreviewWithManagedStore(
  props: PipelineRunCostPreviewCardProps,
): JSX.Element | null {
  const store = usePipelineRunCostStore(
    props.client,
    props.scope,
    props.executionId,
  );
  return <PipelineCostPreviewWithStore {...props} store={store} />;
}

function PipelineCostPreviewWithStore(
  props: PipelineRunCostPreviewCardProps & {
    readonly store: PipelineRunCostStore;
  },
): JSX.Element | null {
  const currency = useCostCurrency();
  const state = useStore(props.store, (current) => current);
  const view = state.value;
  if (view === null || view.run.agentStepCount === 0) return null;

  const amount = formatCostTotalIn(view.run.totals, currency);
  const sourceSegments = costSourceSegments(
    view.run.totals.bySource,
    RUN_SOURCES,
  );
  const stepCount = view.run.agentStepCount;

  return (
    <button
      type="button"
      onClick={props.onOpen}
      aria-label={`Cost, ${amount} observed. Open cost`}
      className="focus-ring group flex w-full flex-col gap-3 rounded-xl border bg-base p-4 text-left transition-colors hover:bg-subtle"
      data-testid="pipeline-run-cost-preview"
    >
      <span className="flex w-full items-center gap-2">
        <span className="text-xs font-medium fg-secondary">Cost</span>
        <ChevronRightMediumIcon
          size={16}
          aria-hidden="true"
          className="ml-auto fg-tertiary transition-colors group-hover:fg-primary"
        />
      </span>
      <span className="flex min-w-0 items-baseline gap-1.5">
        <CostObservedTotal amountLabel={amount} size="inline" />
        <span className="truncate text-xs tabular-nums fg-tertiary">
          · {`${stepCount} ${stepCount === 1 ? 'agent step' : 'agent steps'}`}
        </span>
      </span>
      <span className="flex w-full flex-col gap-2">
        <CostSplitBar
          segments={sourceSegments}
          label="Run cost by source"
          size="summary"
        />
        <CostLegend segments={sourceSegments} showShare />
      </span>
    </button>
  );
}
