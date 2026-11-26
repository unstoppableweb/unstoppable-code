import { Stack } from '../primitives/Stack';
import type { JSX, ReactNode } from 'react';
import type {
  RemoteControlProviderUsageAccount,
  RemoteControlProviderUsageWindow,
} from '@canopy/protocol/remote-control/shell';
import {
  UsageRow,
  UsageRowList,
  UsageWindowRow,
  type UsageLimitCard,
} from './UsageGroup';
import { ProviderUsageAccountRow } from './ProviderUsageAccountRow';
import type { UsageIndicatorAccountSummaryProps } from './UsageIndicator';
import { Disclosure } from '../primitives/Disclosure';

const PASSIVE_SOURCE_LABEL = 'Reported by the account proxy';

/** A time of day for today, otherwise with its date. */
function when(at: string | number, nowMs: number): string | null {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toDateString() === new Date(nowMs).toDateString()
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
}

function fullTime(at: string): string | undefined {
  const date = new Date(at);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : undefined;
}

function windowCard(window: RemoteControlProviderUsageWindow): UsageLimitCard {
  return {
    key: window.id,
    title: window.label,
    unlimited: window.unlimited,
    usedPercent: window.usedPercent,
    resetsAt: window.resetsAt,
    windowDurationMs: window.windowDurationMs,
    creditsAreCount: window.credits?.unit === 'credits',
    spend: window.spend,
    credits: window.credits
      ? {
          usedUsd: window.credits.spent,
          remainingUsd: window.credits.remaining,
          totalUsd: window.credits.total,
        }
      : undefined,
  };
}

/** How fresh an account's limits are, or undefined when nothing was read. */
function freshnessText(
  account: RemoteControlProviderUsageAccount,
  nowMs: number,
): string | undefined {
  if (account.usageSource === 'passive') return PASSIVE_SOURCE_LABEL;
  if (account.usageSource === 'live' && account.lastUpdatedAt) {
    const time = when(account.lastUpdatedAt, nowMs);
    return time ? `Updated ${time}` : undefined;
  }
  return undefined;
}

/**
 * The failed read, whether older limits stay shown, and when asking again
 * is allowed. Nothing retries on its own, so the copy does not promise it.
 */
function errorText(
  account: RemoteControlProviderUsageAccount,
  nowMs: number,
): string | undefined {
  if (!account.error) return undefined;
  let text = account.error.message;
  if (account.windows.length > 0) text += ' Showing last known usage.';
  if (account.retryAt) {
    const retryMs = new Date(account.retryAt).getTime();
    const time = when(account.retryAt, nowMs);
    if (Number.isFinite(retryMs) && retryMs > nowMs && time) {
      text += ` Try again after ${time}.`;
    }
  }
  return text;
}

/**
 * One line about an account's usage for compact surfaces: the failed read
 * first, otherwise how fresh the limits are.
 */
export function providerAccountUsageStatusText(
  account: RemoteControlProviderUsageAccount,
  nowMs: number,
): string | undefined {
  return errorText(account, nowMs) ?? freshnessText(account, nowMs);
}

const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The window a folded account shows: its first 7-day window, which leads the
 * provider's scoped 7-day windows (`7-day Opus`), or its first window.
 */
export function providerAccountUsageLeadWindowId(
  account: RemoteControlProviderUsageAccount,
): string | undefined {
  return (
    account.windows.find((window) => window.windowDurationMs === SEVEN_DAY_MS)
      ?.id ?? account.windows[0]?.id
  );
}

/** An account's windows as the composer popover's limit rows. */
export function providerAccountUsageSummaryLimits(
  account: RemoteControlProviderUsageAccount,
): UsageIndicatorAccountSummaryProps['limits'] {
  return account.windows.map((window) => {
    const credits = window.credits;
    return {
      id: window.id,
      label: window.label,
      ...(window.unlimited ? { unlimited: true } : {}),
      ...(window.usedPercent === undefined
        ? {}
        : { usedPercent: window.usedPercent }),
      ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
      ...(credits?.unit === 'credits'
        ? credits.remaining === undefined
          ? {}
          : { remainingCredits: credits.remaining }
        : credits
          ? {
              ...(credits.spent === undefined
                ? {}
                : { usedUsd: credits.spent }),
              ...(credits.remaining === undefined
                ? {}
                : { remainingUsd: credits.remaining }),
              ...(credits.total === undefined
                ? {}
                : { totalUsd: credits.total }),
            }
          : {}),
    };
  });
}

/** How fresh an account's limits are, with the full time on hover. */
function AccountUsageFreshness({
  account,
  nowMs,
}: {
  account: RemoteControlProviderUsageAccount;
  nowMs: number;
}): JSX.Element | null {
  const freshness = freshnessText(account, nowMs);
  if (!freshness) return null;
  const freshnessTitle =
    account.usageSource === 'live' && account.lastUpdatedAt
      ? fullTime(account.lastUpdatedAt)
      : undefined;
  return (
    <p className="text-xs fg-tertiary" title={freshnessTitle}>
      {freshness}
    </p>
  );
}

/** The last failed read, outside any disclosure so it stays visible. */
function AccountUsageError({
  account,
  nowMs,
}: {
  account: RemoteControlProviderUsageAccount;
  nowMs: number;
}): JSX.Element | null {
  const error = errorText(account, nowMs);
  if (!error) return null;
  return (
    <p role="status" className="text-xs text-pretty fg-secondary">
      {error}
    </p>
  );
}

/** An account's windows as rows. */
function accountWindowRows(
  account: RemoteControlProviderUsageAccount,
  nowMs: number,
): JSX.Element[] {
  return account.windows.map((window) => (
    <UsageWindowRow key={window.id} window={windowCard(window)} nowMs={nowMs} />
  ));
}

/** No windows and no failed read: usage is unknown, never 0%. */
function usageUnavailable(
  account: RemoteControlProviderUsageAccount,
  nowMs: number,
): boolean {
  return account.windows.length === 0 && !errorText(account, nowMs);
}

/**
 * An account's limit windows, how fresh they are, and the last failed read,
 * for use inside another surface's row (Settings). Cached windows stay
 * beside the error; no windows reads as unavailable, never as 0%.
 */
export function ProviderAccountUsageDetails({
  account,
  nowMs,
  collapsible = false,
}: {
  account: RemoteControlProviderUsageAccount;
  nowMs: number;
  /** Settings keeps quota details behind a closed disclosure. */
  collapsible?: boolean;
}): JSX.Element {
  const usage = (
    <>
      {usageUnavailable(account, nowMs) ? (
        <p className="text-xs fg-secondary">Usage unavailable</p>
      ) : (
        <UsageRowList plain>{accountWindowRows(account, nowMs)}</UsageRowList>
      )}
      <AccountUsageFreshness account={account} nowMs={nowMs} />
    </>
  );
  return (
    <div className="pt-2 empty:hidden">
      <Stack gap="tight">
        {collapsible ? (
          <Disclosure label="Usage" dataTestId="provider-account-usage">
            <div>{usage}</div>
          </Disclosure>
        ) : (
          usage
        )}
        <AccountUsageError account={account} nowMs={nowMs} />
      </Stack>
    </div>
  );
}

/**
 * One multi-account proxy account with its usage: a row per limit window,
 * then the account (blocked from session replay) with a host-supplied state
 * or action, then how fresh the limits are and any failed read. Shared by
 * every host's usage surface.
 */
export function ProviderAccountUsage({
  account,
  providerLabel,
  nowMs,
  children,
}: {
  account: RemoteControlProviderUsageAccount;
  providerLabel: string;
  nowMs: number;
  children?: ReactNode;
}): JSX.Element {
  return (
    <section
      data-testid="provider-account-usage"
      className="min-w-0 flex flex-col gap-1.5"
    >
      <UsageRowList>
        {accountWindowRows(account, nowMs)}
        {usageUnavailable(account, nowMs) ? (
          <UsageRow title="Limits" detail="Usage unavailable" />
        ) : null}
        <ProviderUsageAccountRow
          accountLabel={account.label ?? null}
          statusLabel={`${providerLabel} account`}
        >
          {children ?? null}
        </ProviderUsageAccountRow>
      </UsageRowList>
      {errorText(account, nowMs) || freshnessText(account, nowMs) ? (
        <div className="flex flex-col gap-0.5 px-0.5">
          <AccountUsageError account={account} nowMs={nowMs} />
          <AccountUsageFreshness account={account} nowMs={nowMs} />
        </div>
      ) : null}
    </section>
  );
}
