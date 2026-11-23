import { useCallback, useMemo, useState, type ReactNode } from 'react';
import type { AgentProviderAuthStatus } from '@canopy/desktop-shared/types';
import type { ProviderConnection } from '@canopy/app-state/provider-choice';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { subscriptionLabelForPlanType } from '@canopy/protocol/telemetry';
import {
  invalidateClaudeAuthStatusCache,
  useClaudeAuthStatus,
} from '@/hooks/useClaudeAuthStatus';
import {
  invalidateCodexAuthStatusCache,
  useCodexAuthStatus,
} from '@/hooks/useCodexAuthStatus';
import { AuthLoginModal } from '@/components/settings/AuthLoginModal';
import { useObservabilityStore } from '@/stores/observabilityStore';

/** A provider that signs in through its command-line tool. */
export type DesktopSignInProvider = 'claude' | 'codex';

/** Sign-in to Claude or Codex through its command-line tool. */
export interface DesktopProviderSignIn {
  /** The provider's sign-in status; `null` while it is read. */
  readonly status: AgentProviderAuthStatus | null;
  /** The status as a provider-choice connection. */
  readonly connection: ProviderConnection;
  /** The plan, and the Codex workspace, once signed in. */
  readonly detail: ReactNode;
  /**
   * Bumped by every sign-in, so what carried over from the provider's own
   * setup is read again for the account that just connected.
   */
  readonly refreshKey: number;
  /** Opens the terminal sign-in. */
  readonly openSignIn: () => void;
  /** The sign-in modal while it is open; render it anywhere. */
  readonly signInModal: ReactNode;
}

/**
 * Reads Claude's or Codex's sign-in status and runs its terminal sign-in.
 * Closing the sign-in reads the status and the provider's usage again. Hosts
 * draw the row: Settings › Account through `ProviderAuthPanel`, first run
 * through the shared provider chooser.
 */
export function useDesktopProviderSignIn(
  provider: DesktopSignInProvider,
): DesktopProviderSignIn {
  const [claudeRefreshKey, setClaudeRefreshKey] = useState(0);
  const [codexRefreshKey, setCodexRefreshKey] = useState(0);
  const [signInOpen, setSignInOpen] = useState(false);
  const refreshProviderUsageDetails = useObservabilityStore(
    (s) => s.refreshProviderUsageDetails,
  );

  // Both reads run so the hook order never depends on the provider.
  const claudeStatus = useClaudeAuthStatus(claudeRefreshKey, {
    forceRefreshOnMount: provider === 'claude',
  });
  const codexStatus = useCodexAuthStatus(codexRefreshKey);
  const status = provider === 'claude' ? claudeStatus : codexStatus;
  const refreshKey = provider === 'claude' ? claudeRefreshKey : codexRefreshKey;
  const connection = useMemo(() => providerConnection(status), [status]);

  const openSignIn = useCallback((): void => setSignInOpen(true), []);
  const closeSignIn = useCallback((): void => {
    setSignInOpen(false);
    if (provider === 'claude') {
      invalidateClaudeAuthStatusCache();
      setClaudeRefreshKey((k) => k + 1);
    } else {
      invalidateCodexAuthStatusCache();
      setCodexRefreshKey((k) => k + 1);
    }
    void refreshProviderUsageDetails(provider);
  }, [provider, refreshProviderUsageDetails]);

  return {
    status,
    connection,
    detail: providerPlanDetail(provider, status),
    refreshKey,
    openSignIn,
    signInModal: signInOpen ? (
      <AuthLoginModal provider={provider} onClose={closeSignIn} />
    ) : null,
  };
}

function providerConnection(
  status: AgentProviderAuthStatus | null,
): ProviderConnection {
  if (status === null) return { kind: 'checking' };
  return status.authenticated ? { kind: 'ready' } : { kind: 'not-connected' };
}

function providerPlanDetail(
  provider: DesktopSignInProvider,
  status: AgentProviderAuthStatus | null,
): ReactNode {
  const authenticated = status?.authenticated === true;
  // Prefer the friendly full subscription label from the shared plan catalog
  // (e.g. `Claude Max 20x`, `ChatGPT Business`) over the raw provider `detail`
  // string (`claude.ai (max)`, `team`), matching the provider Usage cards. For
  // Claude, `status.planType` is already the tier-enriched plan type. Falls
  // back to `status.detail` for API-key/Bedrock logins with no subscription
  // plan.
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
      {planText} ·{' '}
      <span className={POSTHOG_REPLAY_BLOCK_CLASS}>{workspaceName}</span>
    </>
  ) : (
    planText
  );
}

/** A signed-in row's one status line: the account, then the plan. */
export function signedInProviderLine(
  status: AgentProviderAuthStatus,
  detail: ReactNode,
): ReactNode {
  // Session replay blocks the account label, not the copy around it.
  const account: ReactNode = status.accountLabel ? (
    <span className={POSTHOG_REPLAY_BLOCK_CLASS}>{status.accountLabel}</span>
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
