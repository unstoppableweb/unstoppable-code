import { type JSX } from 'react';
import { CreditCard } from '../icons/AppIcons';
import { AI_CREDITS_LABEL } from './aiCreditsLabel';
import { AI_CREDITS_PURCHASE_LABEL } from './creditsPromptCopy';
import {
  MenuItem,
  MenuItemIcon,
  MenuItemTrailing,
} from '../primitives/MenuItem';

export { AI_CREDITS_LABEL } from './aiCreditsLabel';

const WHOLE_FORMAT = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 0,
});

const COMPACT_FORMAT = new Intl.NumberFormat(undefined, {
  notation: 'compact',
});

/** The smallest magnitude that rounds to a four-digit whole number. */
const COMPACT_THRESHOLD = 999.5;

function normalizeBalance(balanceCredits: number | null): number | null {
  if (balanceCredits === null || !Number.isFinite(balanceCredits)) {
    return null;
  }
  // Avoid "-0" for a balance that only rounds to zero.
  return Math.abs(balanceCredits) < 0.5 ? 0 : balanceCredits;
}

function formatHumanizedBalance(balance: number): string {
  return Math.abs(balance) < COMPACT_THRESHOLD
    ? WHOLE_FORMAT.format(balance)
    : COMPACT_FORMAT.format(balance);
}

/**
 * Format an AI Credits balance for the account menu: rounded to a whole
 * number, and humanized once it reaches four digits (`689`, `1.2K`, `3.4M`).
 *
 * `null` means the balance is unknown and formats to `null`, so the row shows
 * no number at all. A non-finite value is treated the same way: it can only
 * come from a broken read, and painting `0` there would dress a transport
 * failure up as an empty wallet. A real zero formats to `0`, and a negative
 * balance keeps its sign rather than being clamped to a zero the ledger does
 * not hold.
 */
export function formatAiCreditsBalance(
  balanceCredits: number | null,
): string | null {
  const balance = normalizeBalance(balanceCredits);
  return balance === null ? null : formatHumanizedBalance(balance);
}

export type AiCreditsBalanceTone = 'healthy' | 'low' | 'critical';

/**
 * How much headroom a balance leaves: healthy above 10 credits, low above 5,
 * and critical at 5 or below, including an empty or negative wallet. The
 * tone reads the exact balance, not the rounded display value.
 */
export function aiCreditsBalanceTone(
  balanceCredits: number,
): AiCreditsBalanceTone {
  if (balanceCredits > 10) return 'healthy';
  if (balanceCredits > 5) return 'low';
  return 'critical';
}

const TONE_CLASSES: Record<AiCreditsBalanceTone, string> = {
  healthy: 'bg-success-subtle fg-success-strong',
  low: 'bg-warning-subtle fg-warning-strong',
  critical: 'bg-destructive-subtle fg-destructive-strong',
};

interface AiCreditsBalancePillProps {
  /** A finite balance already normalized by `normalizeBalance`. */
  balance: number;
  'data-testid': string;
}

function AiCreditsBalancePill({
  balance,
  'data-testid': dataTestId,
}: AiCreditsBalancePillProps): JSX.Element {
  const tone = aiCreditsBalanceTone(balance);
  const display = formatHumanizedBalance(balance);
  const whole = WHOLE_FORMAT.format(balance);
  return (
    <span
      className={`ml-auto inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium tabular-nums ${TONE_CLASSES[tone]}`}
      // Name the full whole number that a humanized `1.2K` rounds away.
      title={display === whole ? undefined : whole}
      data-tone={tone}
      data-testid={dataTestId}
    >
      {display}
    </span>
  );
}

export interface SidebarAiCreditsMenuItemProps {
  /** Balance in credits, or null while it is unknown (loading or failed). */
  balanceCredits: number | null;
  onSelect: () => void;
  selected?: boolean;
  /**
   * A billing source other than AI Credits can carry the viewer's work now.
   * At a zero balance the row is then left out: nothing needs buying.
   * Defaults to `false`.
   */
  otherBillingSourceReady?: boolean;
  /**
   * The viewer may buy credits for this wallet. At a zero balance, with no
   * other billing source ready, the row then offers the purchase in place of
   * the balance pill. Defaults to `false`: an organization member who can't
   * fund the pool keeps the pill.
   */
  canPurchase?: boolean;
  'data-testid'?: string;
}

/**
 * Account-menu row that names the AI Credits destination and, when the host
 * knows it, the balance in a pill tinted by how much headroom it leaves.
 * Display-only: the host loads the balance and decides where selecting the
 * row goes. Hosts render it as `BalanceSurface`'s menu row
 * (`@canopy/ui-app/credits`), never directly.
 *
 * At a zero balance (one that rounds to 0) the row is hidden when another
 * billing source is ready, and otherwise names the purchase in a neutral
 * trailing label when the viewer can buy. Selecting it still opens the
 * wallet's billing, and its accessible name still states the balance. An
 * unknown, negative or positive balance renders as before.
 */
export function SidebarAiCreditsMenuItem({
  balanceCredits,
  onSelect,
  selected = false,
  otherBillingSourceReady = false,
  canPurchase = false,
  'data-testid': dataTestId = 'sidebar-account-menu-item-ai-credits',
}: SidebarAiCreditsMenuItemProps): JSX.Element | null {
  const balance = normalizeBalance(balanceCredits);
  const label = AI_CREDITS_LABEL;
  const zero = balance === 0;
  if (zero && otherBillingSourceReady) return null;
  const offerPurchase = zero && canPurchase;
  return (
    <MenuItem
      onClick={onSelect}
      selected={selected}
      aria-label={
        balance === null
          ? label
          : `${label}, ${WHOLE_FORMAT.format(balance)} available`
      }
      data-testid={dataTestId}
    >
      <MenuItemIcon>
        <CreditCard size="xl" aria-hidden="true" />
      </MenuItemIcon>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {offerPurchase ? (
        <MenuItemTrailing data-testid={`${dataTestId}-buy`}>
          {AI_CREDITS_PURCHASE_LABEL}
        </MenuItemTrailing>
      ) : (
        balance !== null && (
          <AiCreditsBalancePill
            balance={balance}
            data-testid={`${dataTestId}-balance`}
          />
        )
      )}
    </MenuItem>
  );
}
