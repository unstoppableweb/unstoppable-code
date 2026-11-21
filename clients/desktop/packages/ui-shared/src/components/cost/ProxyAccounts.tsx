import type { JSX } from 'react';
import type {
  CostProxyAccountRef,
  CostProxyAccountRow,
} from '@canopy/protocol/cost-view';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';
import { COST_NOT_PRICED_LABEL, formatCostAmount } from './cost-format';
import { ValueRow, ValueRows } from '../settings/ValueRows';
import { Tooltip } from '../Tooltip';

// Account-proxy accounts on cost surfaces (CAN-4021). Labels are often
// emails, so session replay blocks them.

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  claude: 'Claude',
  codex: 'Codex',
};

/** The account's label, or a name for it when the account list lacks it. */
export function proxyAccountName(account: CostProxyAccountRef): string {
  const label = account.label.trim();
  if (label) return label;
  const provider =
    account.provider === undefined
      ? undefined
      : PROVIDER_NAMES[account.provider];
  return provider ? `${provider} account` : 'Proxy account';
}

/** An API-price estimate: `≈ $0.31`, or `Not priced`. */
export function formatProxyAccountEstimate(account: {
  readonly usd: number;
  readonly notPricedCount: number;
}): string {
  if (account.usd === 0 && account.notPricedCount > 0) {
    return COST_NOT_PRICED_LABEL;
  }
  return `≈ ${formatCostAmount(account.usd)}`;
}

/**
 * The account's share of the work, as a whole percent of `total` turns:
 * `93% of turns`. A share under one percent reads `<1% of turns`.
 */
export function formatProxyAccountShare(
  turnShare: number,
  total: number,
  noun: 'turns' | 'attempts' = 'turns',
): string {
  if (total <= 0 || turnShare <= 0) return `0% of ${noun}`;
  const percent = Math.min(100, (turnShare / total) * 100);
  return percent < 1 ? `<1% of ${noun}` : `${Math.round(percent)}% of ${noun}`;
}

export interface ProxyAccountNamesProps {
  readonly accounts: readonly CostProxyAccountRef[];
  readonly testId?: string;
}

/**
 * Which accounts served some work: the account's name, or a count when the
 * proxy moved the work between accounts. The full list is in the tooltip.
 */
export function ProxyAccountNames({
  accounts,
  testId = 'proxy-account-names',
}: ProxyAccountNamesProps): JSX.Element | null {
  const [first] = accounts;
  if (first === undefined) return null;
  if (accounts.length === 1) {
    const name = proxyAccountName(first);
    return (
      <span data-testid={testId} className="min-w-0 truncate">
        <span className={REPLAY_BLOCK_CLASS} title={name}>
          {name}
        </span>
        <span className="fg-tertiary"> via account proxy</span>
      </span>
    );
  }
  const names = accounts.map(proxyAccountName).join(', ');
  return (
    <span data-testid={testId} className="min-w-0 truncate">
      {/* The names show on hover and are read with the row; no tab stop,
          since callers render this inside a row button. */}
      <Tooltip label={names} replayBlock>
        <span className={REPLAY_BLOCK_CLASS}>
          {`${accounts.length} accounts`}
          <span className="sr-only">{`: ${names}`}</span>
        </span>
      </Tooltip>
      <span className="fg-tertiary">
        {' '}
        via account proxy · switched accounts
      </span>
    </span>
  );
}

export interface ProxyAccountCostListProps {
  readonly accounts: readonly CostProxyAccountRow[];
  /** Turns or attempts the shares are of. */
  readonly total: number;
  readonly noun?: 'turns' | 'attempts';
  readonly testId?: string;
}

/** Each account's share of the work and its estimate, most work first. */
export function ProxyAccountCostList({
  accounts,
  total,
  noun = 'turns',
  testId = 'proxy-account-cost',
}: ProxyAccountCostListProps): JSX.Element | null {
  if (accounts.length === 0) return null;
  return (
    <ValueRows dataTestId={testId}>
      {accounts.map((account) => {
        const name = proxyAccountName(account);
        return (
          <ValueRow
            key={account.accountKey}
            dataTestId={`${testId}-row`}
            label={
              <span className={REPLAY_BLOCK_CLASS} title={name}>
                {name}
              </span>
            }
            note={formatProxyAccountShare(account.turnShare, total, noun)}
            value={formatProxyAccountEstimate(account)}
          />
        );
      })}
    </ValueRows>
  );
}
