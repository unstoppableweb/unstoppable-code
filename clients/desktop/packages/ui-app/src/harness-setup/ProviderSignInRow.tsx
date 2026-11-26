'use client';

import type { JSX, ReactNode } from 'react';
import type { HarnessProviderAuthStatus } from '@canopy/protocol/remote-control/harness-setup';
import { subscriptionLabelForPlanType } from '@canopy/protocol/telemetry';
import {
  Button,
  StatusLabel,
  type ProviderStatusDotTone,
} from '@canopy/ui-shared/components';
import { ClaudeLogo, CodexLogo } from '@canopy/ui-shared/icons';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { ProviderSourceRow } from '../providers/ProviderSourceRow';

/** A provider that signs in through its own command-line sign-in. */
export type ProviderSignInRowProvider = 'claude' | 'codex';

/**
 * The plan, and the Codex workspace, once signed in. Prefers the friendly
 * subscription label from the shared plan catalog (`Claude Max 20x`,
 * `ChatGPT Business`) over the raw provider `detail` (`claude.ai (max)`),
 * matching the provider Usage cards; falls back to `detail` for API-key and
 * Bedrock sign-ins with no subscription plan.
 */
export function providerPlanDetail(
  provider: ProviderSignInRowProvider,
  status: HarnessProviderAuthStatus | null,
): ReactNode {
  const authenticated = status?.authenticated === true;
  const subscriptionLabel =
    authenticated && status?.planType
      ? subscriptionLabelForPlanType(provider, status.planType)
      : null;
  const planText = subscriptionLabel ?? status?.detail ?? null;
  // Codex reports which ChatGPT workspace the account uses (Codex 0.165+).
  const workspaceName = authenticated ? status?.workspaceName : null;
  // Workspace names can name a person, so replay blocks that part only.
  return planText && workspaceName ? (
    <>
      {planText} · <span className={REPLAY_BLOCK_CLASS}>{workspaceName}</span>
    </>
  ) : (
    planText
  );
}

/** A signed-in row's one status line: the account, then the plan. */
export function signedInProviderLine(
  status: Pick<HarnessProviderAuthStatus, 'accountLabel'>,
  detail: ReactNode,
): ReactNode {
  // Session replay blocks the account label, not the copy around it.
  const account: ReactNode = status.accountLabel ? (
    <span className={REPLAY_BLOCK_CLASS}>{status.accountLabel}</span>
  ) : (
    'Signed in'
  );
  return detail ? (
    <>
      {account} · {detail}
    </>
  ) : (
    account
  );
}

export interface ProviderSignInRowProps {
  readonly provider: ProviderSignInRowProvider;
  /** The sign-in status; `null` while it is read. */
  readonly status: HarnessProviderAuthStatus | null;
  /** The plan detail, usually {@link providerPlanDetail}. */
  readonly detail: ReactNode;
  readonly onSignIn: () => void;
  /** Detail under the row and the sign-in surface while it is open. */
  readonly children?: ReactNode;
}

/**
 * Claude's or Codex's provider row: mark, name and status dot, one status
 * line (the account and plan when signed in, the provider's own error
 * otherwise) and Sign in or Change account.
 */
export function ProviderSignInRow({
  provider,
  status,
  detail,
  onSignIn,
  children,
}: ProviderSignInRowProps): JSX.Element {
  const name = provider === 'claude' ? 'Claude' : 'Codex';
  const logo =
    provider === 'claude' ? (
      <ClaudeLogo className="h-4 w-4 shrink-0 fg-primary" aria-hidden />
    ) : (
      <CodexLogo className="h-4 w-4 shrink-0 fg-primary" aria-hidden />
    );
  const rowStatus: ProviderStatusDotTone | undefined = status
    ? status.authenticated
      ? 'connected'
      : 'failed'
    : undefined;
  const statusLine: ReactNode = !status ? (
    'Checking sign-in…'
  ) : status.authenticated ? (
    signedInProviderLine(status, detail)
  ) : (
    <StatusLabel>{status.error || `${name} is not authenticated.`}</StatusLabel>
  );
  return (
    <ProviderSourceRow
      dataTestId={`auth-panel-${provider}`}
      icon={logo}
      name={name}
      {...(rowStatus !== undefined ? { status: rowStatus } : {})}
      description={statusLine}
      control={
        <Button
          onClick={onSignIn}
          disabled={status === null}
          data-testid={`auth-panel-${provider}-connect`}
          size="compact"
        >
          {status?.authenticated ? 'Change account' : 'Sign in'}
        </Button>
      }
    >
      {children}
    </ProviderSourceRow>
  );
}
