'use client';

import type { JSX, ReactNode } from 'react';
import {
  resolveCreditsPrompt,
  type CreditsPromptOwner,
} from '@canopy/app-state/billing/credits';
import type { CreditsSummary } from '@canopy/protocol/settings/billing';
import {
  AI_CREDITS_LABEL,
  Button,
  EmptyState,
  SidebarAiCreditsMenuItem,
  UsageRow,
} from '@canopy/ui-shared/components';
import { formatCredits } from '@canopy/ui-shared/lib';
import { CreditsUsedThisPeriod } from '../settings/billing/credits-used-this-period';
import { useCreditsPurchase } from './CreditsPurchaseProvider';

/**
 * The one AI Credits balance (Card E). Every surface that shows how many
 * credits a wallet holds renders it, in one of two densities:
 *
 * - `row`: one line naming AI Credits. In a menu (`frame: 'menu'`, the
 *   default) it is the account menu's and the organization switcher's row,
 *   with the balance in a pill tinted by its headroom; selecting it opens the
 *   wallet's billing. At a zero balance it is left out when another billing
 *   source is ready, and otherwise offers the purchase to a viewer who can
 *   buy. In a list (`frame: 'list'`) it is the Usage page's row,
 *   with the host's balance line and Manage.
 * - `card`: the wallet's headline balance with its purchase control, the
 *   credits used this period, then the automatic top-up and activity the
 *   host places under it. The account wallet and organization pool cards on
 *   the billing pages render it.
 *
 * The host reads the balance and owns where selecting or Manage goes. On a
 * card the host places its purchase control, which starts through the shared
 * purchase action (`useCreditsPurchase`), and the card asks
 * {@link resolveCreditsPrompt} (reason `top_up`) whether the viewer may buy for
 * this wallet. Nothing here branches on which host renders it.
 */

/** A menu row: the account menu's or the organization switcher's. */
export interface BalanceSurfaceMenuRowProps {
  readonly density: 'row';
  readonly frame?: 'menu';
  /** Balance in credits, or `null` while it is unknown (loading or failed). */
  readonly balanceCredits: number | null;
  /** Opens the wallet's billing. */
  readonly onSelect: () => void;
  readonly selected?: boolean;
  /**
   * A billing source other than AI Credits can carry the viewer's work now,
   * so a zero balance needs no purchase and the row is left out. The host
   * derives it from its own connection facts (`isOtherBillingSourceReady`).
   * Defaults to `false`.
   */
  readonly otherBillingSourceReady?: boolean;
  /**
   * The viewer may buy credits for this wallet: a zero balance then offers
   * the purchase in place of the pill. Defaults to `false`.
   */
  readonly canPurchase?: boolean;
  readonly 'data-testid'?: string;
}

/** A list row: the Usage page's AI Credits row. */
export interface BalanceSurfaceListRowProps {
  readonly density: 'row';
  readonly frame: 'list';
  /** The host's balance line: how much is left, or who covers the work. */
  readonly detail: ReactNode;
  /** Opens the wallet's billing. `null` offers no Manage. */
  readonly onManage: (() => void) | null;
  readonly manageTestId?: string;
}

/** Whose wallet a card shows. */
export type BalanceSurfaceOwner =
  | { readonly kind: 'personal' }
  /** An organization's credit pool; only its owner funds it. */
  | { readonly kind: 'organization'; readonly canFund: boolean };

/** What a never-funded wallet shows in place of its balance. */
export interface BalanceSurfaceEmpty {
  readonly title: string;
  readonly subtitle: string;
}

export interface BalanceSurfaceCardProps {
  readonly density: 'card';
  readonly summary: CreditsSummary;
  readonly owner: BalanceSurfaceOwner;
  /**
   * The wallet's purchase control: the host's inline checkout trigger or the
   * payment hand-off. Shown only when the viewer may buy for this wallet.
   */
  readonly purchase: ReactNode;
  /** `''` for the personal wallet, `'team-'` for an organization pool. */
  readonly testIdPrefix: '' | 'team-';
  /** Shown in place of the balance; omit once the wallet has activity. */
  readonly empty?: BalanceSurfaceEmpty;
  /** The automatic top-up panel, under the period's usage. */
  readonly autoTopUp?: ReactNode;
  /** The wallet's activity, last. */
  readonly children?: ReactNode;
}

export type BalanceSurfaceProps =
  | BalanceSurfaceMenuRowProps
  | BalanceSurfaceListRowProps
  | BalanceSurfaceCardProps;

export function BalanceSurface(props: BalanceSurfaceProps): JSX.Element | null {
  switch (props.density) {
    case 'card':
      return <BalanceCard {...props} />;
    case 'row':
      return props.frame === 'list' ? (
        <BalanceListRow {...props} />
      ) : (
        <SidebarAiCreditsMenuItem
          balanceCredits={props.balanceCredits}
          onSelect={props.onSelect}
          selected={props.selected}
          otherBillingSourceReady={props.otherBillingSourceReady}
          canPurchase={props.canPurchase}
          data-testid={props['data-testid']}
        />
      );
  }
}

function BalanceListRow({
  detail,
  onManage,
  manageTestId,
}: BalanceSurfaceListRowProps): JSX.Element {
  return (
    <UsageRow
      title={AI_CREDITS_LABEL}
      detail={detail}
      trailing={
        onManage ? (
          <Button
            variant="secondary"
            size="compact"
            onClick={onManage}
            data-testid={manageTestId}
          >
            Manage
          </Button>
        ) : null
      }
    />
  );
}

function promptOwner(owner: BalanceSurfaceOwner): CreditsPromptOwner {
  return owner.kind === 'personal'
    ? owner
    : // A pool is what the card shows, so the organization has one.
      { kind: 'organization', canFund: owner.canFund, creditPool: true };
}

function BalanceCard({
  summary,
  owner,
  purchase,
  testIdPrefix,
  empty,
  autoTopUp,
  children,
}: BalanceSurfaceCardProps): JSX.Element {
  const { mode } = useCreditsPurchase(null);
  // Billing pages render only while billing is on, for a signed-in viewer.
  // A hand-off still being checked, or unavailable, keeps its disabled
  // control: the payment area's notice says why.
  const prompt = resolveCreditsPrompt({
    billingEnabled: true,
    viewer: 'signed-in',
    owner: promptOwner(owner),
    condition: 'top_up',
    purchaseMode: mode === 'inline' ? 'inline' : 'handoff',
    pending: false,
  });
  const action = prompt.primary === 'buy' ? purchase : null;
  if (empty !== undefined) {
    return (
      <EmptyState
        title={empty.title}
        subtitle={empty.subtitle}
        action={action ?? undefined}
      />
    );
  }
  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {/* Only this wallet's balance. Which pool covers a turn depends on
              the organization that owns the work (CAN-3463), so there is no
              single payer to name here. */}
          <p className="text-lg font-semibold fg-primary">
            {`${formatCredits(summary.balanceCredits)} credits`}
          </p>
        </div>
        {action}
      </div>

      <CreditsUsedThisPeriod
        summary={summary}
        testId={`${testIdPrefix}billing-ai-credits-used`}
      />

      {autoTopUp}

      {children}
    </>
  );
}
