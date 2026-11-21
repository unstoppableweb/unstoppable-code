// ---------------------------------------------------------------------------
// The invoice document itself — the shareable page body, rendered identically
// by the personal (`/account/billing/invoices/[invoiceId]`) and org
// (`/organization/[orgId]/billing/invoices/[invoiceId]`) routes. The org
// invoice route kept its URL when billing moved to
// `/organization/[orgId]/settings?tab=billing`.
//
// Presentation-only, NO hooks and NO `'use client'`, so it renders as a React
// Server Component inside both routes (precedent: `app/invite/[code]/page.tsx`,
// `app/share/skills/[shareId]/page.tsx`; `transpilePackages` already includes
// `@canopy/ui-shared`).
//
// Invoice-LEVEL dates (issue date, period bounds) format in UTC via
// `invoice-display`. The injected `formatDate` is used ONLY for per-line-item
// `chargedAt`, which is an ordinary wall-clock timestamp — matching the
// Transactions list on the same surfaces.
//
// AI CREDITS ARE NEVER MONEY HERE. The credits section is prepaid and
// credits-denominated: it renders in credits, sits visually apart from the USD
// totals, states in copy why it is not part of the total, and shows no USD
// equivalent — a dollar sign next to it would invite someone to add it in.
// ---------------------------------------------------------------------------

import { Stack } from './Stack';
import { Surface } from './Surface';
import type { JSX, ReactNode } from 'react';
import { formatUsd } from '../lib/money-format';
import { formatCardLabel } from '../lib/card-display';
import { formatCredits } from '../lib/billing-format';
import { humanizeBillingChargeKind } from '../lib/billing-charge-display';
import {
  CURRENT_INVOICE_LABEL,
  formatUtcDate,
  formatUtcDateRange,
  humanizeInvoiceStatus,
  invoiceStatusTone,
  isUnpaidCurrentInvoice,
} from '../lib/invoice-display';
import { BADGE_BASE_CLASS, BADGE_TONE_CLASS } from '../lib/badge';
import { BILLING_STATUS_TONE_CLASSES } from '../lib/billing-status-tone';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';
import { Heading } from './Heading';

/** One charge rendered as an invoice line item. Enums widened to `string`. */
export interface InvoiceDetailLineItem {
  id: string;
  kind: string;
  status: string;
  description: string | null;
  quantity: number | null;
  unitPriceUsd: number | null;
  amountUsd: number;
  /**
   * Total reversed on this charge by refunds/chargebacks. Optional so callers
   * predating the refund webhook still satisfy the shape; absent means `0`.
   *
   * `amountUsd` stays the GROSS line amount so the line items keep summing to
   * `subtotalUsd`; the reversal is disclosed per line and settled in the
   * document totals ("Paid" / "Refunded"), never by quietly shrinking a line.
   */
  amountRefundedUsd?: number;
  servicePeriodStart: string | null;
  servicePeriodEnd: string | null;
  chargedAt: string;
  cardBrand: string | null;
  cardLast4: string | null;
}

export interface InvoiceDetailCreditUsageGroup {
  key: string;
  label: string;
  reason: string;
  modelVersion: string | null;
  entryCount: number;
  creditsUsed: number;
}

export interface InvoiceDetailCreditAddedGroup {
  transactionType: string;
  label: string;
  entryCount: number;
  creditsAdded: number;
}

export interface InvoiceDetailCreditActivity {
  usageGroups: InvoiceDetailCreditUsageGroup[];
  totalUsedCredits: number;
  addedGroups: InvoiceDetailCreditAddedGroup[];
  totalAddedCredits: number;
}

export interface InvoiceDetailBillTo {
  kind: string;
  name: string;
  email: string | null;
}

/**
 * Browser-safe invoice document shape. Mirrors the service `InvoiceDetail`
 * (`invoice-service.ts`) with discriminants widened to `string` — the same
 * trick `BillingHistoryCharge` uses so both the Prisma-enum-typed service shape
 * and a plain contract shape satisfy it.
 */
export interface InvoiceDetailViewInvoice {
  id: string;
  number: string;
  issuedAt: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  status: string;
  isCurrent: boolean;
  billTo: InvoiceDetailBillTo;
  lineItems: InvoiceDetailLineItem[];
  subtotalUsd: number;
  taxUsd: number;
  totalUsd: number;
  amountPaidUsd: number;
  amountRefundedUsd: number;
  credits: InvoiceDetailCreditActivity;
}

export interface InvoiceDetailViewProps {
  invoice: InvoiceDetailViewInvoice;
  /**
   * Per-surface local date formatter, used ONLY for line-item `chargedAt`.
   * Invoice-level dates format in UTC internally and are not injectable.
   */
  formatDate: (iso: string) => string;
  /** Optional "Back to billing" affordance rendered above the document. */
  backLink?: ReactNode;
  /**
   * Heading level for the invoice number.
   *
   * Defaults to `h1` (the org route renders this document under a layout with no
   * page heading of its own). The account route nests inside a layout that
   * already emits an `h1`, so it passes `h2` to avoid shipping two `h1`s and
   * breaking the document outline.
   */
  headingLevel?: 'h1' | 'h2';
  /**
   * Block the bill-to name and email from session replay (hosts that record
   * replay). Defaults to `false`, which leaves the markup unchanged.
   */
  blockBillToFromReplay?: boolean;
}

const BADGE_BASE = BADGE_BASE_CLASS;

function cardLabelFor(item: InvoiceDetailLineItem): string {
  if (item.cardBrand && item.cardLast4) {
    return formatCardLabel(item.cardBrand, item.cardLast4);
  }
  if (item.cardLast4) {
    return `····${item.cardLast4}`;
  }
  return '';
}

function descriptionFor(item: InvoiceDetailLineItem): string {
  return item.description ?? humanizeBillingChargeKind(item.kind);
}

/** `Mar 7 – Apr 7` service period for a line item, when the charge carries one. */
function servicePeriodFor(item: InvoiceDetailLineItem): string | null {
  if (!item.servicePeriodStart || !item.servicePeriodEnd) {
    return null;
  }
  return formatUtcDateRange(item.servicePeriodStart, item.servicePeriodEnd);
}

/**
 * Per-line reversal disclosure, or `null` when nothing came back.
 *
 * Reads as "Refunded $10.00" / "Fully refunded" rather than a bare number: on a
 * financial document a lone negative figure next to a line is ambiguous about
 * whether the line above it already accounts for it. Clamped to the line amount
 * so an over-refund cannot claim more came back than went out.
 */
function refundedNoteFor(item: InvoiceDetailLineItem): string | null {
  const refunded = item.amountRefundedUsd ?? 0;
  if (!Number.isFinite(refunded) || refunded <= 0) {
    return null;
  }
  if (Number.isFinite(item.amountUsd) && refunded >= item.amountUsd) {
    return 'Fully refunded';
  }
  return `Refunded ${formatUsd(refunded)}`;
}

function TotalsRow({
  label,
  value,
  emphasis = false,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-6 py-1">
      <span
        className={
          emphasis ? 'text-s font-semibold fg-primary' : 'text-s fg-secondary'
        }
      >
        {label}
      </span>
      <span
        className={
          emphasis
            ? 'whitespace-nowrap text-s font-semibold tabular-nums fg-primary'
            : 'whitespace-nowrap text-s tabular-nums fg-primary'
        }
      >
        {value}
      </span>
    </div>
  );
}

/** The AI-credit activity block. Credits-denominated, never in the USD totals. */
function CreditsSection({
  credits,
}: {
  credits: InvoiceDetailCreditActivity;
}): JSX.Element {
  const hasActivity =
    credits.usageGroups.length > 0 || credits.addedGroups.length > 0;

  return (
    // A well inside the invoice card: `inset` nests its corners in the card's.
    <Surface
      as="section"
      variant="inset"
      padding="default"
      data-testid="invoice-credits"
    >
      <div className="flex flex-col gap-3">
        <div>
          <Heading level={2} variant="title">
            AI Credits activity
          </Heading>
          {/*
        Says WHY the credits are not in the total, not just THAT they aren't.
        A reader looking at `Credit purchases · 12 credits` here while
        `Credit purchase · $5.00` and `· $7.00` sit in the line items above will
        otherwise read "not included in the invoice total" as a second, unbilled
        charge, when those are the same two payments counted in the other unit.

        Both qualifiers are load-bearing. "Credits you bought" scopes the
        reconciliation to purchased credits: granted and dripped credits are
        free, and `Credits used` is spend against a balance that may have been
        bought in an earlier period, so a blanket "these are covered by your
        payments above" would claim a payment that need not exist. And the
        closing clause has to point OUT of the total, not into it, so someone
        adding up the page knows these figures are not part of the arithmetic.
      */}
          <p className="mt-0.5 text-xs fg-tertiary">
            How your AI Credits balance moved during this period. AI Credits you
            bought are already billed above, so nothing here adds to the invoice
            total.
          </p>
        </div>
        {!hasActivity ? (
          <p
            className="text-s fg-secondary"
            data-testid="invoice-credits-empty"
          >
            No AI Credits activity in this period.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {credits.usageGroups.length > 0 && (
              <Stack gap="tight">
                <p className="text-xs font-medium fg-secondary">Credits used</p>
                <ul className="flex flex-col divide-y">
                  {credits.usageGroups.map((group) => (
                    <li
                      key={group.key}
                      data-testid={`invoice-credit-usage-${group.key}`}
                      className="flex items-baseline justify-between gap-4 py-2"
                    >
                      <span className="min-w-0">
                        <span className="block break-words text-s fg-primary">
                          {group.label}
                        </span>
                        <span className="block text-xs fg-tertiary">
                          {`${group.entryCount} ${group.entryCount === 1 ? 'entry' : 'entries'}`}
                        </span>
                      </span>
                      <span className="whitespace-nowrap text-s tabular-nums fg-primary">
                        {`${formatCredits(group.creditsUsed)} credits`}
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="flex items-baseline justify-between gap-4 border-t pt-2">
                  <span className="text-s font-medium fg-primary">
                    Total used
                  </span>
                  <span
                    className="whitespace-nowrap text-s font-medium tabular-nums fg-primary"
                    data-testid="invoice-credits-total-used"
                  >
                    {`${formatCredits(credits.totalUsedCredits)} credits`}
                  </span>
                </div>
              </Stack>
            )}

            {credits.addedGroups.length > 0 && (
              <Stack gap="tight">
                <p className="text-xs font-medium fg-secondary">
                  Credits added
                </p>
                <ul className="flex flex-col divide-y">
                  {credits.addedGroups.map((group) => (
                    <li
                      key={group.transactionType}
                      data-testid={`invoice-credit-added-${group.transactionType}`}
                      className="flex items-baseline justify-between gap-4 py-2"
                    >
                      <span className="min-w-0">
                        <span className="block break-words text-s fg-primary">
                          {group.label}
                        </span>
                        <span className="block text-xs fg-tertiary">
                          {`${group.entryCount} ${group.entryCount === 1 ? 'entry' : 'entries'}`}
                        </span>
                      </span>
                      <span className="whitespace-nowrap text-s tabular-nums fg-primary">
                        {`${formatCredits(group.creditsAdded)} credits`}
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="flex items-baseline justify-between gap-4 border-t pt-2">
                  <span className="text-s font-medium fg-primary">
                    Total added
                  </span>
                  <span
                    className="whitespace-nowrap text-s font-medium tabular-nums fg-primary"
                    data-testid="invoice-credits-total-added"
                  >
                    {`${formatCredits(credits.totalAddedCredits)} credits`}
                  </span>
                </div>
              </Stack>
            )}
          </div>
        )}
      </div>
    </Surface>
  );
}

/**
 * The full invoice document: header + status, bill-to, line items, USD totals,
 * and the credits section.
 */
export function InvoiceDetailView({
  invoice,
  formatDate,
  backLink,
  headingLevel = 'h1',
  blockBillToFromReplay = false,
}: InvoiceDetailViewProps): JSX.Element {
  const numberLevel = headingLevel === 'h1' ? 1 : 2;
  return (
    <Stack gap="group" data-testid="invoice-detail">
      {backLink ? <div>{backLink}</div> : null}

      <Surface variant="card">
        <div className="flex flex-col gap-6 p-4 sm:p-6">
          <Stack gap="group">
            <Stack gap="item">
              <header className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <Heading
                    level={numberLevel}
                    variant="page"
                    data-testid="invoice-detail-number"
                  >
                    {invoice.number}
                  </Heading>
                  <p className="mt-0.5 text-s fg-secondary">
                    {formatUtcDateRange(invoice.periodStart, invoice.periodEnd)}
                  </p>
                  <p className="mt-0.5 text-xs fg-tertiary">
                    {`Issued ${formatUtcDate(invoice.issuedAt)}`}
                  </p>
                </div>
                {isUnpaidCurrentInvoice(invoice) ? (
                  <span className="flex flex-wrap gap-1">
                    <span
                      className={`${BADGE_BASE} ${BADGE_TONE_CLASS.info}`}
                      data-testid="invoice-detail-status"
                    >
                      {CURRENT_INVOICE_LABEL}
                    </span>
                    <span
                      className={`${BADGE_BASE} ${BILLING_STATUS_TONE_CLASSES[invoiceStatusTone(invoice.status)]}`}
                      data-testid="invoice-detail-due-status"
                    >
                      {humanizeInvoiceStatus(invoice.status)}
                    </span>
                  </span>
                ) : invoice.isCurrent ? (
                  <span
                    className={`${BADGE_BASE} ${BADGE_TONE_CLASS.info}`}
                    data-testid="invoice-detail-status"
                  >
                    {CURRENT_INVOICE_LABEL}
                  </span>
                ) : (
                  <span
                    className={`${BADGE_BASE} bg-muted fg-secondary`}
                    data-testid="invoice-detail-status"
                  >
                    {humanizeInvoiceStatus(invoice.status)}
                  </span>
                )}
              </header>

              {invoice.isCurrent && (
                <Stack gap="tight">
                  <p
                    className="text-xs fg-tertiary"
                    data-testid="invoice-detail-current-note"
                  >
                    This billing period is still in progress. Totals shown are
                    to date and will keep updating until the period closes.
                  </p>
                  {isUnpaidCurrentInvoice(invoice) && (
                    <p
                      className="text-xs fg-tertiary"
                      data-testid="invoice-detail-due-note"
                    >
                      Payment for this period hasn&apos;t been collected yet.
                    </p>
                  )}
                </Stack>
              )}
            </Stack>

            <Stack as="section" gap="tight">
              <Heading level={2} variant="label">
                Billed to
              </Heading>
              <div>
                <p
                  className={
                    blockBillToFromReplay
                      ? `text-s fg-primary ${REPLAY_BLOCK_CLASS}`
                      : 'text-s fg-primary'
                  }
                >
                  {invoice.billTo.name}
                </p>
                {invoice.billTo.email ? (
                  <p
                    className={
                      blockBillToFromReplay
                        ? `text-xs fg-tertiary ${REPLAY_BLOCK_CLASS}`
                        : 'text-xs fg-tertiary'
                    }
                  >
                    {invoice.billTo.email}
                  </p>
                ) : null}
              </div>
            </Stack>
          </Stack>

          <Stack as="section" gap="inline">
            <Heading level={2} variant="title">
              Line items
            </Heading>
            {invoice.lineItems.length === 0 ? (
              <p
                className="text-s fg-secondary"
                data-testid="invoice-line-items-empty"
              >
                No charges in this period.
              </p>
            ) : (
              <ul className="flex flex-col divide-y">
                {invoice.lineItems.map((item) => {
                  const card = cardLabelFor(item);
                  const servicePeriod = servicePeriodFor(item);
                  const refundedNote = refundedNoteFor(item);
                  return (
                    <li
                      key={item.id}
                      data-testid={`invoice-line-item-${item.id}`}
                      className="flex flex-col gap-1 py-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6"
                    >
                      <div className="min-w-0">
                        <p className="break-words text-s font-medium fg-primary">
                          {descriptionFor(item)}
                        </p>
                        {servicePeriod ? (
                          <p className="text-xs fg-tertiary">{servicePeriod}</p>
                        ) : null}
                        <p className="text-xs fg-tertiary">
                          {formatDate(item.chargedAt)}
                          {card ? ` · ${card}` : ''}
                        </p>
                      </div>
                      <div className="shrink-0 sm:text-right">
                        <p className="whitespace-nowrap text-s font-medium tabular-nums fg-primary">
                          {formatUsd(item.amountUsd)}
                        </p>
                        {item.quantity !== null &&
                        item.unitPriceUsd !== null ? (
                          <p className="whitespace-nowrap text-xs fg-tertiary">
                            {`${item.quantity} × ${formatUsd(item.unitPriceUsd)}`}
                          </p>
                        ) : null}
                        {refundedNote ? (
                          <p
                            className="whitespace-nowrap text-xs fg-tertiary"
                            data-testid={`invoice-line-item-refunded-${item.id}`}
                          >
                            {refundedNote}
                          </p>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Stack>

          <section
            className="flex flex-col gap-1 border-t pt-3"
            data-testid="invoice-totals"
          >
            <div>
              <TotalsRow
                label="Subtotal"
                value={formatUsd(invoice.subtotalUsd)}
              />
              {/* Literal 0 from the service — Canopy collects no tax today. */}
              <TotalsRow label="Tax" value={formatUsd(invoice.taxUsd)} />
            </div>
            <div className="border-t pt-2">
              <TotalsRow
                label="Total"
                value={formatUsd(invoice.totalUsd)}
                emphasis
              />
              <TotalsRow
                label="Paid"
                value={formatUsd(invoice.amountPaidUsd)}
              />
              {invoice.amountRefundedUsd > 0 ? (
                <TotalsRow
                  label="Refunded"
                  value={formatUsd(invoice.amountRefundedUsd)}
                />
              ) : null}
            </div>
          </section>

          <CreditsSection credits={invoice.credits} />
        </div>
      </Surface>
    </Stack>
  );
}
