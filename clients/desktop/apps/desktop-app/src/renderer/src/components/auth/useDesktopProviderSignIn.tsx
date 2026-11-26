import { useCallback, useMemo, useState, type ReactNode } from 'react';
import type { AgentProviderAuthStatus } from '@canopy/desktop-shared/types';
import type { ProviderConnection } from '@canopy/app-state/provider-choice';
import {
  providerPlanDetail,
  signedInProviderLine,
} from '@canopy/ui-app/harness-setup';
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

/** The signed-in line is the shared rows' own (`@canopy/ui-app/harness-setup`). */
export { signedInProviderLine };
