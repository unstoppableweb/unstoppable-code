'use client';

import type { JSX } from 'react';
import type { AntigravityAccountSnapshot } from '@canopy/protocol/portal';
import { UsageGroup, UsageRow, UsageRowList } from './UsageGroup';

interface AntigravityAccountCardProps {
  readonly snapshot: AntigravityAccountSnapshot;
}

/**
 * The Google plan label that Antigravity reports, shared by the desktop
 * Usage page and the Portal usage panel. The runtime reports no limits,
 * usage period or account identity, so none are shown. A failed read is
 * "couldn't check", never a sign-out, and offers no sign-out action.
 */
export function AntigravityAccountCard({
  snapshot,
}: AntigravityAccountCardProps): JSX.Element {
  const ready = snapshot.status === 'ready';
  return (
    <UsageGroup
      title="Antigravity"
      provider="antigravity"
      plan={ready ? (snapshot.planLabel ?? null) : null}
      planTestId="usage-provider-antigravity-plan-chip"
      testId="antigravity-account-card"
    >
      <UsageRowList>
        {ready ? (
          <>
            {snapshot.planLabel ? null : (
              <UsageRow title="Plan" detail="Google didn't report a plan" />
            )}
            <UsageRow
              title="Limits"
              detail="Google doesn't report usage limits here"
            />
            <UsageRow title="Account" detail="Account name unavailable" />
          </>
        ) : (
          <UsageRow
            title="Account"
            detail={
              <span role="status">
                Couldn&apos;t check the Antigravity account. Use Refresh models
                in the desktop app&apos;s Antigravity settings to try again.
              </span>
            }
          />
        )}
      </UsageRowList>
    </UsageGroup>
  );
}
