// Renderer mirror of the account proxy status (CAN-4019). Main owns the
// connection and the server reads; this store hydrates once per window,
// follows main's `accountProxyChanged` push, and asks for a server refresh
// only when a surface that shows accounts is open.

import { useEffect } from 'react';
import { create } from 'zustand';
import {
  resolveChatAccountSource,
  resolveProviderAccountSource,
  type AccountProxyHarness,
  type ChatAccountRoute,
  type ProviderAccountSource,
} from '@canopy/desktop-shared/lib/account-proxy';
import type { AccountProxyStatus } from '@canopy/desktop-shared/types/account-proxy';
import { useAiCreditsUsage } from '@/hooks/useAiCreditsUsage';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';

/** How often an open accounts list asks the server for fresh limits. */
export const ACCOUNT_PROXY_REFRESH_INTERVAL_MS = 60_000;

interface AccountProxyState {
  /** Null until the first read returns (or on a surface without the API). */
  status: AccountProxyStatus | null;
  /** True while a server refresh is in flight. */
  refreshing: boolean;
  setStatus: (status: AccountProxyStatus) => void;
}

export const useAccountProxyStore = create<AccountProxyState>((set) => ({
  status: null,
  refreshing: false,
  setStatus: (status): void => set({ status }),
}));

let unsubscribe: (() => void) | null = null;
let refreshInFlight: Promise<void> | null = null;
let refreshingUsage = false;
let usageRefreshQueued = false;

function ensureSubscription(): void {
  if (unsubscribe !== null) return;
  const api = typeof window !== 'undefined' ? window.api : undefined;
  const accountProxy = api?.accountProxy;
  if (!accountProxy) {
    unsubscribe = (): void => undefined;
    return;
  }
  unsubscribe = accountProxy.onChanged((status) => {
    useAccountProxyStore.getState().setStatus(status);
  });
  void Promise.resolve()
    .then(() => accountProxy.status())
    .then((status) => {
      if (useAccountProxyStore.getState().status === null) {
        useAccountProxyStore.getState().setStatus(status);
      }
      // After a restart main has the saved connection but has not read its
      // accounts yet; read them once so proxy-only models are pickable.
      if (status.connection && status.refreshedAt === null) {
        void refreshAccountProxyStatus({ refreshUsage: false });
      }
    })
    .catch(() => undefined);
}

/** Ask the server for fresh accounts and limits. */
export async function refreshAccountProxyStatus(
  options: { readonly refreshUsage?: boolean } = {},
): Promise<void> {
  const accountProxy = window.api?.accountProxy;
  if (!accountProxy) return;
  const refreshUsage = options.refreshUsage !== false;
  if (refreshInFlight) {
    if (refreshUsage && !refreshingUsage) usageRefreshQueued = true;
    return refreshInFlight;
  }
  useAccountProxyStore.setState({ refreshing: true });
  refreshingUsage = refreshUsage;
  usageRefreshQueued = false;
  refreshInFlight = Promise.resolve().then(async (): Promise<void> => {
    try {
      do {
        try {
          useAccountProxyStore.getState().setStatus(
            await accountProxy.status({
              refresh: true,
              refreshUsage: refreshingUsage,
            }),
          );
        } catch {
          // The status keeps its last value; the next refresh tries again.
        }
        refreshingUsage = usageRefreshQueued;
        usageRefreshQueued = false;
      } while (refreshingUsage);
    } finally {
      refreshInFlight = null;
      refreshingUsage = false;
      useAccountProxyStore.setState({ refreshing: false });
    }
  });
  return refreshInFlight;
}

/** The current status; null until it loads. */
export function useAccountProxyStatus(): AccountProxyStatus | null {
  const status = useAccountProxyStore((state) => state.status);
  useEffect(() => {
    ensureSubscription();
  }, []);
  return status;
}

/**
 * Whether Settings > Multi-account proxy is offered: whenever the flag is on,
 * including while the user has the proxy turned off.
 */
export function useAccountProxyPageAvailable(): boolean {
  return useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopAccountProxy.key),
  );
}

/**
 * Whose limits apply to new `harness` work on this device; `native` for no
 * harness. Reads the AI Credits mode main weighs before the proxy, and
 * re-renders only when the answer changes.
 */
export function useProviderAccountSource(
  harness: AccountProxyHarness | undefined,
): ProviderAccountSource {
  const { routingMode } = useAiCreditsUsage();
  const source = useAccountProxyStore((state) =>
    harness === undefined
      ? 'native'
      : resolveProviderAccountSource({
          status: state.status,
          harness,
          aiCreditsRoutingMode: routingMode,
        }),
  );
  useEffect(() => {
    ensureSubscription();
  }, []);
  return source;
}

/**
 * Whose limits apply to one chat: the route main reported for its session,
 * or the route main would give the chat before the session exists.
 */
export function useChatAccountSource(
  chat: ChatAccountRoute,
): ProviderAccountSource {
  const { routingMode } = useAiCreditsUsage();
  const {
    providerType,
    model,
    sessionAccountProxyRouted,
    chatChoseAiCredits,
    subscriptionBillingOverride,
  } = chat;
  const source = useAccountProxyStore((state) =>
    resolveChatAccountSource({
      status: state.status,
      providerType,
      model,
      sessionAccountProxyRouted,
      chatChoseAiCredits,
      subscriptionBillingOverride,
      aiCreditsRoutingMode: routingMode,
    }),
  );
  useEffect(() => {
    ensureSubscription();
  }, []);
  return source;
}

/**
 * Keeps the accounts fresh while the calling surface is mounted: refreshes
 * on mount and every minute after.
 */
export function useAccountProxyLiveRefresh(enabled: boolean): void {
  useEffect(() => {
    ensureSubscription();
    if (!enabled) return undefined;
    void refreshAccountProxyStatus();
    const timer = window.setInterval(() => {
      void refreshAccountProxyStatus({ refreshUsage: false });
    }, ACCOUNT_PROXY_REFRESH_INTERVAL_MS);
    return (): void => window.clearInterval(timer);
  }, [enabled]);
}
