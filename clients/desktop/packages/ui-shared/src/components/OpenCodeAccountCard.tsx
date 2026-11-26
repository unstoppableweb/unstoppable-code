'use client';

import { Fragment, type JSX } from 'react';
import type {
  OpenCodeAccountMethod,
  OpenCodeAccountSnapshot,
  OpenCodeAccountUsage,
} from '@canopy/protocol/remote-control/shell';
import { useMinuteClock } from '../lib/useMinuteClock';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';
import { Button } from '../primitives/Button';
import { StatusLabel } from '../primitives/StatusLabel';
import {
  UsageGroup,
  UsageRow,
  UsageRowList,
  UsageWindowRow,
} from './UsageGroup';

const METHOD_LABELS: Record<OpenCodeAccountMethod, string> = {
  key: 'API key',
  oauth: 'Browser sign-in',
  external: 'External credentials',
  env: 'Environment variable',
};

function usageDescription(usage: OpenCodeAccountUsage | undefined): string {
  switch (usage?.status) {
    case 'ready':
      return usage.plan ?? 'Usage';
    case 'not-selected':
      return 'Select this account in OpenCode to view usage';
    case 'sign-in-required':
      return 'Sign in again to view usage';
    case 'unavailable':
      return 'Usage is unavailable. Refresh to try again.';
    default:
      return 'This provider does not report plan or usage limits here';
  }
}

const WINDOW_LABELS = {
  rolling: 'Rolling usage',
  weekly: 'Weekly usage',
  monthly: 'Monthly usage',
};

interface OpenCodeAccountCardProps {
  readonly snapshot: OpenCodeAccountSnapshot;
  /** Omit when the host cannot open native provider settings. */
  readonly onManageProviders?: () => void;
}

/**
 * Provider names distinguish accounts with the same native label. Selection
 * applies to each provider, not to one global OpenCode account, and does not
 * prove successful authentication. The host owns refresh and management.
 */
export function OpenCodeAccountCard({
  snapshot,
  onManageProviders,
}: OpenCodeAccountCardProps): JSX.Element {
  const nowMs = useMinuteClock();
  const rows = snapshot.providers.flatMap((provider) =>
    provider.accounts.length === 0
      ? [
          <UsageRow
            key={provider.id}
            testId="opencode-account-row"
            title={
              <span className={REPLAY_BLOCK_CLASS}>
                {provider.name || 'Provider name unavailable'}
              </span>
            }
            detail="No account information reported"
          />,
        ]
      : provider.accounts.map((account, index) => (
          <Fragment
            key={`${provider.id}:${account.method}:${account.label}:${index}`}
          >
            <UsageRow
              testId="opencode-account-row"
              title={
                <span className={REPLAY_BLOCK_CLASS}>
                  {provider.name || 'Provider name unavailable'}
                </span>
              }
              detail={
                <>
                  <span className={`block truncate ${REPLAY_BLOCK_CLASS}`}>
                    {account.label || 'Account name unavailable'}
                  </span>
                  {METHOD_LABELS[account.method]}
                  {account.selected && ' · Selected for this provider'}
                  {account.needsSignIn && (
                    <>
                      {' · '}
                      <StatusLabel>Sign in again</StatusLabel>
                    </>
                  )}
                  <span className="block">
                    {usageDescription(account.usage)}
                  </span>
                </>
              }
            />
            {account.usage?.status === 'ready' &&
              (account.usage.windows ?? []).map((window) => (
                <UsageWindowRow
                  key={window.id}
                  nowMs={nowMs}
                  window={{
                    key: `${provider.id}-${index}-${window.id}`,
                    title: WINDOW_LABELS[window.id],
                    usedPercent: window.percent,
                    resetsAt: window.resetsAt,
                  }}
                />
              ))}
          </Fragment>
        )),
  );
  return (
    <UsageGroup
      title="OpenCode"
      provider="opencode"
      testId="opencode-account-card"
    >
      <UsageRowList>
        {snapshot.status === 'unavailable' ? (
          <UsageRow
            title="Accounts"
            detail={
              <span role="status">
                Account information is unavailable. Refresh to try again.
              </span>
            }
          />
        ) : snapshot.providers.length === 0 ? (
          <UsageRow
            title="Accounts"
            detail="No providers reported by OpenCode"
          />
        ) : (
          rows
        )}
        <UsageRow
          title="Account settings"
          detail={
            onManageProviders
              ? 'Add or update provider sign-ins'
              : 'Open OpenCode settings in the desktop app to manage provider sign-ins'
          }
          trailingKind="action"
          trailing={
            onManageProviders && (
              <Button
                variant="secondary"
                size="compact"
                onClick={onManageProviders}
                data-testid="usage-provider-opencode-manage"
              >
                Manage OpenCode
              </Button>
            )
          }
        />
      </UsageRowList>
    </UsageGroup>
  );
}
