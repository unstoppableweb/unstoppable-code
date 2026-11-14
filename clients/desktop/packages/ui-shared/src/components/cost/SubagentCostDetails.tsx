import type { JSX } from 'react';
import type { CostAttributedItem } from '@canopy/protocol/cost-view';
import { formatTokenCount } from '../../lib/format-usage';
import { HeaderActionButton } from '../HeaderActionButton';
import { CostObservedTotal } from './CostObservedTotal';
import { ProxyAccountNames } from './ProxyAccounts';
import {
  COST_BILLING_LABELS,
  formatCostAmountIn,
  isCostItemPending,
  unpricedCostItemLabel,
} from './cost-format';
import { useCostCurrency } from './CostCurrencyContext';
import { Fact, FactList } from '../FactList';

export interface SubagentCostDetailsProps {
  /** The subagent's or delegate's cost row (`core.cost.chat.get` with a `subagentId`). */
  readonly item: CostAttributedItem;
  /** Opens the root chat's Session breakdown; omit to hide the action. */
  readonly onOpenSessionBreakdown?: () => void;
  readonly testId?: string;
}

function paidByLabel(item: CostAttributedItem): string {
  const label = COST_BILLING_LABELS[item.billingBasis];
  if (isCostItemPending(item)) return label;
  if (item.costStatus === 'not_priced') return `${label}, not priced`;
  // The proxy reports no price, so its amount is always an estimate.
  if (
    item.costStatus === 'estimated' ||
    item.costStatus === 'partial' ||
    item.billingBasis === 'account_proxy'
  ) {
    return `${label}, estimated at API prices`;
  }
  return label;
}

/** Pure display details for one subagent or managed delegation cost row. */
export function SubagentCostDetails({
  item,
  onOpenSessionBreakdown,
  testId = 'subagent-cost-details',
}: SubagentCostDetailsProps): JSX.Element {
  const currency = useCostCurrency();
  const totalTokens = item.totalTokens;
  const amountLabel =
    item.usd === undefined
      ? unpricedCostItemLabel(item)
      : formatCostAmountIn(
          item.usd,
          currency,
          item.billingBasis === 'ai_credits',
        );

  return (
    <div data-testid={testId} className="flex min-w-0 flex-col gap-2">
      <CostObservedTotal
        size="inline"
        amountLabel={amountLabel}
        testId={`${testId}-total`}
      />
      {item.inclusion === 'included' ? (
        <p data-testid={`${testId}-included`} className="text-xs fg-tertiary">
          Part of the cost of the chat turn that started it.
        </p>
      ) : null}
      <FactList>
        {totalTokens === undefined ? (
          <>
            <Fact numeric label="Input">
              {formatTokenCount(item.tokens.input)}
            </Fact>
            <Fact numeric label="Output">
              {formatTokenCount(item.tokens.output)}
            </Fact>
            <Fact numeric label="Cache read">
              {formatTokenCount(item.tokens.cacheReadInputTokens)}
            </Fact>
          </>
        ) : (
          <Fact numeric label="Tokens">
            {formatTokenCount(totalTokens)}
          </Fact>
        )}
        <Fact numeric label="Paid by">
          {paidByLabel(item)}
        </Fact>
        {item.proxyAccounts !== undefined && item.proxyAccounts.length > 0 ? (
          <>
            <Fact label="Account" fit="inline">
              <ProxyAccountNames
                accounts={item.proxyAccounts}
                testId={`${testId}-account`}
              />
            </Fact>
          </>
        ) : null}
        {item.kind === 'delegation' && item.runCount !== undefined ? (
          <Fact
            numeric
            label="Runs"
          >{`${item.runCount} ${item.runCount === 1 ? 'run' : 'runs'}`}</Fact>
        ) : null}
      </FactList>
      {onOpenSessionBreakdown ? (
        <div>
          <HeaderActionButton
            type="button"
            tone="neutral"
            data-testid={`${testId}-open-breakdown`}
            onClick={onOpenSessionBreakdown}
          >
            Session breakdown
          </HeaderActionButton>
        </div>
      ) : null}
    </div>
  );
}
