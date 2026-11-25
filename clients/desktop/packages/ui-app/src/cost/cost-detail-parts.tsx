import type { JSX, ReactNode } from 'react';
import type { CostTotals } from '@canopy/protocol/cost-view';
import {
  CostLegend,
  CostSplitBar,
  costBillingSegments,
} from '@canopy/ui-shared/components/cost';
import {
  ValueRow,
  ValueRows,
} from '@canopy/ui-shared/components/settings/ValueRows';
import { Heading } from '@canopy/ui-shared/components';

export interface CostDetailSectionProps {
  readonly title: string;
  readonly aside?: ReactNode;
  readonly children: ReactNode;
  readonly testId?: string;
}

/** A sentence-case section heading with an optional tabular value. */
export function CostDetailSection({
  title,
  aside,
  children,
  testId,
}: CostDetailSectionProps): JSX.Element {
  return (
    <section data-testid={testId} className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <Heading level={3} variant="label">
          {title}
        </Heading>
        {aside !== undefined ? (
          <span className="shrink-0 text-right text-xs tabular-nums fg-secondary">
            {aside}
          </span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/** The list cost and usage figures sit in: Settings rows with no box. */
export const CostValueRows = ValueRows;

export interface CostValueRowProps {
  readonly label: string;
  readonly value: string;
  readonly note?: string;
}

/**
 * One labeled cost or usage figure: a Settings row in a `ValueRows` list,
 * its note under the label (design call 1C).
 */
export function CostValueRow({
  label,
  value,
  note,
}: CostValueRowProps): JSX.Element {
  return <ValueRow label={label} value={value} note={note} />;
}

/**
 * The shared estimate qualification for plan-covered and AI Credits usage,
 * and account proxy usage when there is some.
 */
export function CostEstimateNote({
  includesAccountProxy = false,
}: {
  readonly includesAccountProxy?: boolean;
} = {}): JSX.Element {
  return (
    <p className="text-xs fg-tertiary">
      {includesAccountProxy
        ? 'Subscription, AI Credits and account proxy amounts are estimates at API prices, not charges.'
        : 'Subscription and AI Credits amounts are estimates at API prices, not charges.'}
    </p>
  );
}

type CostBillingSectionProps =
  | {
      readonly totals: Pick<CostTotals, 'byBilling' | 'notPricedByBilling'>;
      readonly label: string;
    }
  | {
      readonly byBilling: CostTotals['byBilling'];
      readonly label: string;
    };

/** The shared billing split and its API-price estimate note. */
export function CostBillingSection(
  props: CostBillingSectionProps,
): JSX.Element {
  const byBilling =
    'totals' in props ? props.totals.byBilling : props.byBilling;
  // A basis paid with no dollars (an organization gateway) still gets a row.
  const segments = costBillingSegments(
    byBilling,
    'totals' in props ? props.totals.notPricedByBilling : undefined,
  );

  return (
    <CostDetailSection title="How it was paid">
      <CostSplitBar segments={segments} label={props.label} size="summary" />
      <CostLegend segments={segments} showShare />
      <CostEstimateNote includesAccountProxy={byBilling.account_proxy > 0} />
    </CostDetailSection>
  );
}
