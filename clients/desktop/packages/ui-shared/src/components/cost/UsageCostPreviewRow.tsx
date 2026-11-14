'use client';

import { useId, useState, type JSX } from 'react';
import type { CostSource } from '@canopy/protocol/cost-view';
import { UsageExpandableRow } from '../UsageIndicator';
import { CostCurrencyContext } from './CostCurrencyContext';
import { CostLegend } from './CostLegend';
import { CostSplitBar } from './CostSplitBar';
import {
  costSourceSegments,
  formatCostTotal,
  USD_COST_CURRENCY,
} from './cost-format';

/** The chat's stored cost row (`core.cost.chat.get`, detail `summary`). */
export interface UsageCostPreview {
  readonly usd: number;
  readonly notPricedCount: number;
  readonly bySource: Readonly<Record<CostSource, number>>;
}

/**
 * The chat's cost in the Usage popover: a disclosure like the Context row,
 * its source bar drawn closed and its list shown when opened. A host with a
 * cost read path passes it as the popover's `costPreview`; the popover itself
 * imports no cost code. It stays in USD, whatever the host's cost currency,
 * until CAN-6634 moves it to credits, so its total and breakdown never mix.
 */
export function UsageCostPreviewRow({
  preview,
}: {
  readonly preview: UsageCostPreview;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const segments = costSourceSegments(preview.bySource);
  return (
    <CostCurrencyContext.Provider value={USD_COST_CURRENCY}>
      <div className="flex flex-col gap-1.5">
        <UsageExpandableRow
          label="Cost"
          value={formatCostTotal(preview)}
          open={open}
          onToggle={(): void => setOpen((value) => !value)}
          bodyId={detailsId}
          testId="usage-indicator-cost"
        />
        <CostSplitBar
          segments={segments}
          label="Cost by source"
          size="summary"
        />
        {open ? (
          <div id={detailsId}>
            <CostLegend
              layout="list"
              showShare
              segments={segments}
              testId="usage-indicator-cost-breakdown"
            />
          </div>
        ) : null}
      </div>
    </CostCurrencyContext.Provider>
  );
}
