'use client';

import { useState, type JSX } from 'react';
import { useCanopyClient, useWorkspaceCapabilities } from '@canopy/app-state';
import type {
  PortalProviderUsageAccount,
  PortalProviderUsageEntry,
  PortalProviderUsageProjection,
} from '@canopy/protocol/portal';
import {
  AntigravityAccountCard,
  getModelCatalogProviderLabel,
  newestUsageUpdate,
  OpenCodeAccountCard,
  ProviderAccountUsage,
  ProviderUsageAccountRow,
  UsageGroup,
  UsageProviderGroup,
  UsageRow,
  usagePlanLabel,
  UsageUpdatedLine,
  useMinuteClock,
  type UsageLimitCard,
} from '@canopy/ui-shared';

interface ProviderQuotaPanelProps {
  workspaceLocalId: string;
  projection?: PortalProviderUsageProjection;
  disabled?: boolean;
  isVisible: boolean;
}

/** A short state beside a proxy account that cannot serve now. */
function accountState(account: PortalProviderUsageAccount): string | null {
  if (account.signInRequired) return 'Needs sign-in';
  switch (account.status) {
    case 'disabled':
      return 'Turned off';
    case 'cooling':
      return 'Usage limit reached';
    case 'error':
      return "Can't be used right now";
    case 'pending':
      return 'Finishing sign-in';
    case 'refreshing':
    case 'active':
      return account.planLabel ?? null;
  }
}

/**
 * The desktop's multi-account proxy accounts for a provider, in place of
 * its native sign-in while the proxy serves the provider's work.
 */
function AccountProxyAccounts({
  accounts,
  providerLabel,
  nowMs,
}: {
  accounts: PortalProviderUsageAccount[];
  providerLabel: string;
  nowMs: number;
}): JSX.Element {
  if (accounts.length === 0) {
    return (
      <p className="px-0.5 text-s fg-secondary">
        {`Add a ${providerLabel} account to the account proxy.`}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {accounts.map((account) => {
        const state = accountState(account);
        return (
          <ProviderAccountUsage
            key={account.id}
            account={account}
            providerLabel={providerLabel}
            nowMs={nowMs}
          >
            {state === null ? null : (
              <span className="shrink-0 text-xs fg-secondary">{state}</span>
            )}
          </ProviderAccountUsage>
        );
      })}
    </div>
  );
}

function entryWindows(entry: PortalProviderUsageEntry): UsageLimitCard[] {
  return entry.windows.map((window) => ({
    key: window.id,
    title: window.label,
    unlimited: window.unlimited,
    usedPercent: window.usedPercent,
    resetsAt: window.resetsAt,
    windowDurationMs: window.windowDurationMs,
    spend: window.spend,
    creditsAreCount: window.credits?.unit === 'credits',
    credits: window.credits
      ? {
          usedUsd: window.credits.spent,
          remainingUsd: window.credits.remaining,
          totalUsd: window.credits.total,
        }
      : undefined,
  }));
}

function QuotaGroup({
  entry,
  nowMs,
}: {
  entry: PortalProviderUsageEntry;
  nowMs: number;
}): JSX.Element {
  const authenticated = entry.authState === 'authenticated';
  const label = getModelCatalogProviderLabel(entry.provider);
  const testId = `usage-provider-card-${entry.provider}`;
  if (entry.accounts !== undefined) {
    return (
      <UsageGroup
        title={label}
        provider={entry.provider}
        plan="Account proxy"
        testId={testId}
      >
        <AccountProxyAccounts
          accounts={entry.accounts}
          providerLabel={label}
          nowMs={nowMs}
        />
      </UsageGroup>
    );
  }
  const windows = authenticated ? entryWindows(entry) : [];
  return (
    <UsageProviderGroup
      title={label}
      provider={entry.provider}
      plan={authenticated ? usagePlanLabel(label, entry.planLabel) : null}
      testId={testId}
      windows={windows}
      nowMs={nowMs}
      rows={
        <>
          {authenticated && windows.length === 0 ? (
            <UsageRow title="Limits" detail="Usage unavailable" />
          ) : null}
          <ProviderUsageAccountRow
            accountLabel={
              authenticated
                ? (entry.accountLabel ?? entry.accountEmail ?? null)
                : null
            }
            statusLabel={
              authenticated
                ? 'Account name unavailable'
                : entry.authState === 'unknown'
                  ? 'Account status unavailable'
                  : 'Connect in the desktop app'
            }
          >
            {null}
          </ProviderUsageAccountRow>
        </>
      }
      separateFooter
      footer={
        entry.error ? (
          <p role="status" className="px-0.5 text-xs fg-secondary">
            {entry.error.message}
          </p>
        ) : null
      }
    />
  );
}

/** The newest read across the groups the panel shows. */
function projectionUpdatedAt(
  projection: PortalProviderUsageProjection,
): number | null {
  return newestUsageUpdate([
    ...projection.providers.flatMap((entry) =>
      entry.accounts === undefined
        ? [entry.lastUpdatedAt]
        : entry.accounts.map((account) => account.lastUpdatedAt),
    ),
    projection.openCodeAccounts?.updatedAt,
  ]);
}

/**
 * Which accounts the panel shows. A refresh started for one set of accounts
 * neither blocks nor reports a failure for the next.
 */
function accountsSignature(
  projection: PortalProviderUsageProjection | undefined,
): string {
  return (projection?.providers ?? [])
    .map(
      (entry) =>
        `${entry.provider}:${entry.authState}:${entry.accountLabel ?? entry.accountEmail ?? ''}`,
    )
    .join('|');
}

interface RefreshState {
  readonly signature: string;
  readonly refreshing: boolean;
  readonly failed: boolean;
}

function QuotaCards({
  projection,
  workspaceLocalId,
  disabled,
}: Omit<ProviderQuotaPanelProps, 'isVisible'>): JSX.Element {
  const nowMs = useMinuteClock();
  const client = useCanopyClient();
  const signature = accountsSignature(projection);
  const [refreshState, setRefreshState] = useState<RefreshState | null>(null);
  const current = refreshState?.signature === signature ? refreshState : null;
  const refreshing = current?.refreshing === true;
  const refreshFailed = current?.failed === true;
  if (!projection)
    return (
      <p className="p-4 text-s fg-secondary">
        Usage is not available from this desktop yet.
      </p>
    );
  if (
    projection.providers.length === 0 &&
    !projection.openCodeAccounts &&
    !projection.antigravityAccount
  )
    return <p className="p-4 text-s fg-secondary">Usage unavailable</p>;
  // One refresh reads every group again: each provider, then OpenCode.
  const refresh = async (): Promise<void> => {
    if (disabled === true || refreshing) return;
    setRefreshState({ signature, refreshing: true, failed: false });
    const providers: Array<PortalProviderUsageEntry['provider'] | 'opencode'> =
      projection.providers.map((entry) => entry.provider);
    if (projection.openCodeAccounts) providers.push('opencode');
    const results = await Promise.allSettled(
      providers.map((provider) =>
        client.command('providerUsage.refresh', {
          workspaceLocalId,
          provider,
        }),
      ),
    );
    const failed = results.some((result) => result.status === 'rejected');
    setRefreshState((state) =>
      state?.signature === signature
        ? { signature, refreshing: false, failed }
        : state,
    );
  };
  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-6 overflow-auto p-4"
      data-testid="provider-quota-panel"
    >
      <div>
        <UsageUpdatedLine
          updatedAt={projectionUpdatedAt(projection)}
          nowMs={nowMs}
          refreshing={refreshing}
          disabled={disabled}
          onRefresh={() => {
            void refresh();
          }}
        />
        {refreshFailed && (
          <p role="status" className="text-xs fg-secondary">
            Could not refresh usage. Try again.
          </p>
        )}
      </div>
      {projection.providers.map((entry) => (
        <QuotaGroup
          key={`${workspaceLocalId}:${entry.provider}:${entry.authState}:${entry.accountLabel ?? entry.accountEmail ?? ''}`}
          entry={entry}
          nowMs={nowMs}
        />
      ))}
      {projection.openCodeAccounts && (
        <OpenCodeAccountCard
          key={workspaceLocalId}
          snapshot={projection.openCodeAccounts}
        />
      )}
      {projection.antigravityAccount && (
        <AntigravityAccountCard snapshot={projection.antigravityAccount} />
      )}
    </div>
  );
}

/** Host-independent presentation; the selected workspace's client owns refresh. */
export function ProviderQuotaPanel(
  props: ProviderQuotaPanelProps,
): JSX.Element | null {
  const capabilities = useWorkspaceCapabilities(props.workspaceLocalId);
  if (!props.isVisible) return null;
  if (capabilities.providerQuotas !== true)
    return (
      <p className="p-4 text-s fg-secondary">
        Usage is unavailable for this project.
      </p>
    );
  return (
    <QuotaCards
      key={props.workspaceLocalId}
      projection={props.projection}
      workspaceLocalId={props.workspaceLocalId}
      disabled={props.disabled}
    />
  );
}
