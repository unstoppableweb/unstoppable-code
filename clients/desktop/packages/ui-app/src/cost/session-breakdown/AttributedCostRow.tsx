import { useId, type JSX } from 'react';
import {
  costTokenCount,
  type CostAttributedItem,
} from '@canopy/protocol/cost-view';
import {
  COST_BILLING_LABELS,
  COST_NOT_PRICED_LABEL,
  formatCostAmountIn,
  type CostCurrency,
  useCostCurrency,
  formatCostShare,
  unpricedCostItemLabel,
} from '@canopy/ui-shared/components/cost';
import { formatTokenCount } from '@canopy/ui-shared/lib/format-usage';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

export interface AttributedCostRowProps {
  readonly item: CostAttributedItem;
  readonly parentCost?: number;
  readonly onOpen?: () => void;
  readonly testId: string;
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function includedCostLabel(
  item: CostAttributedItem,
  parentCost: number | undefined,
): string {
  if (item.usd === undefined || item.costStatus === 'not_priced') {
    return unpricedCostItemLabel(item);
  }
  if (parentCost === undefined) return 'Included in workflow step cost';
  return `${formatCostShare(item.usd, parentCost)} of chat turns`;
}

function itemCostLabel(
  item: CostAttributedItem,
  parentCost: number | undefined,
  currency: CostCurrency,
): string {
  if (item.inclusion === 'included') {
    return includedCostLabel(item, parentCost);
  }
  if (item.usd === undefined || item.costStatus === 'not_priced') {
    return COST_NOT_PRICED_LABEL;
  }
  return formatCostAmountIn(
    item.usd,
    currency,
    item.billingBasis === 'ai_credits',
  );
}

function itemMetadata(item: CostAttributedItem): string {
  const metadata: string[] = [];
  if (item.kind === 'delegation') {
    if (item.model !== undefined) metadata.push(item.model);
    if (item.harness !== undefined) metadata.push(item.harness);
    metadata.push(COST_BILLING_LABELS[item.billingBasis]);
    if (item.status !== undefined) {
      metadata.push(item.status.charAt(0).toUpperCase() + item.status.slice(1));
    }
    if (item.runCount !== undefined) {
      metadata.push(plural(item.runCount, 'run', 'runs'));
    }
    return metadata.join(' · ');
  }

  metadata.push(item.kind === 'claude_task' ? 'Task' : 'Agent');
  if (item.model !== undefined) metadata.push(item.model);
  metadata.push(
    `${formatTokenCount(item.totalTokens ?? costTokenCount(item.tokens))} tokens`,
  );
  return metadata.join(' · ');
}

/** A subagent or delegation row, interactive only when its host can open it. */
export function AttributedCostRow({
  item,
  parentCost,
  onOpen,
  testId,
}: AttributedCostRowProps): JSX.Element {
  const metadata = itemMetadata(item);
  const currency = useCostCurrency();
  const amount = itemCostLabel(item, parentCost, currency);
  const idPrefix = useId();
  const labelId = `${idPrefix}-label`;
  const metadataId = `${idPrefix}-metadata`;
  const amountId = `${idPrefix}-amount`;
  // A subagent's or delegation's name comes from the conversation. Session
  // replay masks it, and the row is named by its parts so the name is in no
  // recorded attribute.
  const content = (
    <>
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          id={labelId}
          className={`${REPLAY_MASK_CLASS} truncate fg-primary`}
        >
          {item.label}
        </span>
        <span id={metadataId} className="truncate tabular-nums fg-tertiary">
          {metadata}
        </span>
      </span>
      <span
        id={amountId}
        className="ml-auto shrink-0 text-right tabular-nums fg-secondary"
      >
        {amount}
      </span>
    </>
  );
  const className =
    'flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-xs pointer-coarse:min-h-11';
  const labelledBy = `${labelId} ${metadataId} ${amountId}`;

  if (onOpen !== undefined) {
    return (
      <button
        type="button"
        data-testid={testId}
        aria-labelledby={labelledBy}
        onClick={onOpen}
        className={`${className} focus-ring transition-colors hover:bg-subtle`}
      >
        {content}
      </button>
    );
  }

  return (
    <div
      role="group"
      data-testid={testId}
      aria-labelledby={labelledBy}
      className={className}
    >
      {content}
    </div>
  );
}
