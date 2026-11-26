// ---------------------------------------------------------------------------
// Responsive billing-history display shared by the personal account panel
// (`billing-section.tsx`) and the org billing tab (`team-billing-section.tsx`).
//
// Presentation-only: the section heading, empty-state, and "Load more" button
// stay in each app wrapper — this component takes already-loaded rows and
// renders the two responsive layouts. On `sm`+ it renders the familiar table;
// below `sm` it renders a stacked labeled card per charge so five columns never
// squash into ~50px each on a phone.
//
// The layout swap is pure CSS (`hidden sm:block` / `sm:hidden`) rather than a
// JS media-query hook, so it hydrates identically server- and client-side.
// ---------------------------------------------------------------------------

import type { JSX } from 'react';
import { formatUsd } from '../lib/money-format';
import { formatCardLabel } from '../lib/card-display';
import {
  billingChargeStatusTone,
  humanizeBillingChargeKind,
  humanizeBillingChargeStatus,
  resolveBillingChargeDisplayStatus,
} from '../lib/billing-charge-display';
import { BillingStatusPill } from './BillingStatusPill';
import { DataTable } from '../primitives/DataTable';

/**
 * Browser-safe charge row shape. Mirrors the fields this component renders from
 * the web `ChargeHistoryItem` wire contract (`billing-api-contracts.ts`) with
 * all discriminants widened to `string`, so both the account contract shape and
 * the org `charge-history-service` shape (Prisma enums) satisfy it.
 */
export interface BillingHistoryCharge {
  id: string;
  kind: string;
  status: string;
  amountUsd: number;
  /**
   * Total reversed by refunds/chargebacks (`refund-service.ts` keeps this as the
   * Σ of the charge's SUCCEEDED reversals).
   *
   * Optional so older callers and fixtures that predate the refund webhook
   * still satisfy the shape; absent is treated exactly like `0`. When it is
   * present and non-zero the row reports the derived status
   * (`Refunded` / `Partially refunded`) and shows the reversed amount, so a
   * half-refunded charge never reads as a plain "Succeeded" for its gross.
   */
  amountRefundedUsd?: number | null;
  description: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
  createdAt: string;
}

export interface BillingHistoryTableProps {
  /** Already-loaded charge rows (the wrapper owns fetching + pagination). */
  charges: BillingHistoryCharge[];
  /**
   * Per-surface date formatter — personal (`toLocaleDateString`) and org
   * (`formatPlanDate`) genuinely differ, including their unparseable-value
   * fallbacks, so the formatter is injected rather than unified.
   */
  formatDate: (iso: string) => string;
}

/**
 * `Visa ····4242`-style label. Falls back to a brand-less `····4242` when only
 * `cardLast4` is present (older/partial charge records), so the last4 still
 * shows instead of a blank cell; empty only when there is no card at all.
 */
function cardLabelFor(charge: BillingHistoryCharge): string {
  if (charge.cardBrand && charge.cardLast4) {
    return formatCardLabel(charge.cardBrand, charge.cardLast4);
  }
  if (charge.cardLast4) {
    return `····${charge.cardLast4}`;
  }
  return '';
}

/**
 * Human-readable description for a charge. Prefers the server-provided
 * `description` (already human, e.g. "Pro plan"); when absent, falls back to the
 * humanized `kind` so the cell never shows a raw `SCREAMING_SNAKE` enum token
 * like `CREDIT_TOP_UP`.
 */
function descriptionFor(charge: BillingHistoryCharge): string {
  return charge.description ?? humanizeBillingChargeKind(charge.kind);
}

/** The status the row renders, folding the reversed total into the label. */
function displayStatusFor(charge: BillingHistoryCharge): string {
  return resolveBillingChargeDisplayStatus(
    charge.status,
    charge.amountUsd,
    charge.amountRefundedUsd,
  );
}

/**
 * Secondary "$5.00 refunded" note, or `null` when nothing was reversed.
 *
 * The primary amount stays the GROSS charge (that is what hit the card and what
 * reconciles against a statement); the reversal is a secondary fact underneath
 * it rather than a silently reduced headline number. Clamped to the charge so an
 * over-refund cannot claim more came back than went out.
 *
 * Gated on `displayStatus` so the note and the pill can never disagree: a
 * reversed amount on a `PENDING`/`FAILED` charge is a server-side anomaly that
 * leaves the pill alone, and annotating money onto a charge the row says never
 * collected would read as a contradiction.
 */
function refundedNoteFor(
  charge: BillingHistoryCharge,
  displayStatus: string,
): string | null {
  if (displayStatus !== 'REFUNDED' && displayStatus !== 'PARTIALLY_REFUNDED') {
    return null;
  }
  const refunded = charge.amountRefundedUsd ?? 0;
  if (!Number.isFinite(refunded) || refunded <= 0) {
    return null;
  }
  const clamped = Number.isFinite(charge.amountUsd)
    ? Math.min(refunded, charge.amountUsd)
    : refunded;
  return `${formatUsd(clamped)} refunded`;
}

/**
 * Responsive charge-history layout. Renders a `sm`+ table plus a below-`sm`
 * stacked list of the same rows; renders nothing meaningful for an empty
 * `charges` array (the wrapper is responsible for the empty state).
 */
export function BillingHistoryTable({
  charges,
  formatDate,
}: BillingHistoryTableProps): JSX.Element {
  return (
    <div>
      <DataTable
        className="hidden sm:block"
        caption="Billing history"
        rows={charges}
        rowKey={(charge) => charge.id}
        rowAttributes={(charge) => ({
          'data-testid': `billing-history-row-${charge.id}`,
        })}
        columns={[
          {
            key: 'date',
            header: 'Date',
            tone: 'secondary',
            render: (charge) => formatDate(charge.createdAt),
          },
          {
            key: 'description',
            header: 'Description',
            tone: 'primary',
            overflow: 'wrap',
            render: (charge) => descriptionFor(charge),
          },
          // Tertiary: the same card repeats on nearly every row, so it is
          // reference detail rather than something to scan for.
          {
            key: 'card',
            header: 'Card',
            tone: 'tertiary',
            render: (charge) => cardLabelFor(charge),
          },
          {
            key: 'status',
            header: 'Status',
            render: (charge) => {
              const displayStatus = displayStatusFor(charge);
              return (
                <BillingStatusPill
                  label={humanizeBillingChargeStatus(displayStatus)}
                  tone={billingChargeStatusTone(displayStatus)}
                />
              );
            },
          },
          {
            key: 'amount',
            header: 'Amount',
            align: 'right',
            tone: 'primary',
            render: (charge) => {
              const refundedNote = refundedNoteFor(
                charge,
                displayStatusFor(charge),
              );
              return (
                <>
                  {formatUsd(charge.amountUsd)}
                  {refundedNote ? (
                    <span
                      className="block text-xs fg-tertiary"
                      data-testid={`billing-history-refunded-${charge.id}`}
                    >
                      {refundedNote}
                    </span>
                  ) : null}
                </>
              );
            },
          },
        ]}
      />

      <ul className="flex flex-col divide-y sm:hidden">
        {charges.map((charge) => {
          const card = cardLabelFor(charge);
          const displayStatus = displayStatusFor(charge);
          const refundedNote = refundedNoteFor(charge, displayStatus);
          return (
            <li
              key={charge.id}
              data-testid={`billing-history-card-${charge.id}`}
              className="flex flex-col gap-1 px-2 py-3"
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 break-words text-s font-medium fg-primary">
                  {descriptionFor(charge)}
                </span>
                <span className="flex flex-col items-end">
                  <span className="whitespace-nowrap text-s font-medium tabular-nums fg-primary">
                    {formatUsd(charge.amountUsd)}
                  </span>
                  {refundedNote ? (
                    <span
                      className="whitespace-nowrap text-xs tabular-nums fg-tertiary"
                      data-testid={`billing-history-card-refunded-${charge.id}`}
                    >
                      {refundedNote}
                    </span>
                  ) : null}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <BillingStatusPill
                  label={humanizeBillingChargeStatus(displayStatus)}
                  tone={billingChargeStatusTone(displayStatus)}
                />
                <span className="text-xs fg-tertiary">
                  {formatDate(charge.createdAt)}
                  {card ? ` · ${card}` : ''}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
