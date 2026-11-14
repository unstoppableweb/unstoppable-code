'use client';

import type { JSX } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { CostScopeStore } from '@canopy/app-state/cost';
import {
  CostFreshness,
  formatCostTotalIn,
  useCostCurrency,
} from '@canopy/ui-shared/components/cost';
import { withCostCoverage } from './cost-coverage';

/** The entry total for the rail section's inline subtitle (`$21.66`); nothing until the first read. */
export function CostScopeTotalLabel({
  store,
}: {
  readonly store: CostScopeStore;
}): JSX.Element | null {
  const currency = useCostCurrency();
  const total = store(
    useShallow((state) =>
      state.value === null
        ? null
        : withCostCoverage(
            formatCostTotalIn(state.value.totals, currency),
            state.value.coverageStart,
          ),
    ),
  );
  if (total === null) return null;
  return (
    <span data-testid="cost-section-total" className="tabular-nums">
      {total}
    </span>
  );
}

/** The rail section's header Refresh (`Refresh cost`), with the polite `Cost updated` status. */
export function CostScopeRefreshAction({
  store,
}: {
  readonly store: CostScopeStore;
}): JSX.Element {
  const { refresh, completedManual, requestRefresh } = store(
    useShallow((state) => ({
      refresh: state.refresh,
      completedManual: state.refresh.completedManual,
      requestRefresh: state.requestRefresh,
    })),
  );
  return (
    <CostFreshness
      updatedAt={null}
      refreshing={refresh.status === 'refreshing'}
      completedRefreshes={completedManual}
      onRefresh={() => void requestRefresh('manual')}
      testId="cost-section-freshness"
    />
  );
}
