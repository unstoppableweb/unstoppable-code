import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { useEffect, useRef, useState, type JSX } from 'react';
import { emitPreferencesUpdated } from '@/lib/preferences-events';
import {
  SettingsRowsGroup,
  SettingsRowsSection,
} from '@canopy/ui-shared/components';
import type { HarnessSetupClient } from '@canopy/app-core';
import { useOptionalCanopyClient } from '@canopy/app-state/CanopyClientProvider';
import {
  AntigravityConnectionRow,
  useAntigravityRuntime,
} from '@canopy/ui-app/harness-setup';
import { useModelCatalogStore } from '@/stores/modelCatalogStore';
import { DesktopErrorBanner } from '@/components/shared/DesktopErrorBanner';
import { type InlineFailure } from '@/lib/inline-app-error';
import { DesktopHarnessSetupHost } from './DesktopHarnessSetupHost';

interface GoogleSubscriptionConnectionProps {
  readonly placement?: 'section' | 'row';
}

/**
 * The shared Antigravity row (`@canopy/ui-app/harness-setup`) with the
 * desktop's connection setting (`googleSubscriptionDisconnected`) and model
 * catalog. The managed CLI line comes from the shared row.
 */
export function GoogleSubscriptionConnection({
  placement = 'section',
}: GoogleSubscriptionConnectionProps = {}): JSX.Element | null {
  const client = useOptionalCanopyClient()?.harnessSetup?.antigravity;
  if (!client) return null;
  return (
    <DesktopHarnessSetupHost>
      <DesktopGoogleSubscriptionConnection
        client={client}
        placement={placement}
      />
    </DesktopHarnessSetupHost>
  );
}

function DesktopGoogleSubscriptionConnection({
  client,
  placement,
}: {
  readonly client: HarnessSetupClient['antigravity'];
  readonly placement: 'section' | 'row';
}): JSX.Element {
  const connected = useModelCatalogStore((state) =>
    Boolean(state.snapshot?.antigravity?.length),
  );
  const [signIn, setSignIn] = useState(false);
  const [disconnected, setDisconnected] = useState(false);
  const disconnectedRef = useRef(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<InlineFailure | null>(null);
  useEffect(() => {
    let current = true;
    let synced = false;
    const unsubscribe = window.api.onPreferencesSynced((preferences) => {
      synced = true;
      disconnectedRef.current =
        preferences.googleSubscriptionDisconnected === true;
      setDisconnected(preferences.googleSubscriptionDisconnected === true);
    });
    void window.api
      .loadPreferences()
      .then((preferences) => {
        if (current && !synced) {
          disconnectedRef.current =
            preferences.googleSubscriptionDisconnected === true;
          setDisconnected(preferences.googleSubscriptionDisconnected === true);
        }
      })
      .catch((reason: unknown) => {
        reportClientAppError(reason);
        if (current)
          setError({
            error:
              "Couldn't read the Antigravity connection setting. Reopen Settings to try again.",
          });
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return (): void => {
      current = false;
      unsubscribe();
    };
  }, []);
  const refresh = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const snapshot = await window.api.getModelRegistry({ probe: true });
      useModelCatalogStore.getState().hydrate(snapshot);
      if (!disconnectedRef.current && !snapshot.antigravity?.length)
        setError({
          error:
            'No Gemini models are available. Check that Antigravity CLI is installed, then sign in with your personal Google account.',
        });
    } catch (reason) {
      reportClientAppError(reason);
      setError({ error: "Couldn't refresh Antigravity models. Try again." });
    } finally {
      setBusy(false);
    }
  };
  const changeConnection = async (disconnect: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const preferences = await window.api.savePreferences({
        googleSubscriptionDisconnected: disconnect,
      });
      disconnectedRef.current =
        preferences.googleSubscriptionDisconnected === true;
      setDisconnected(preferences.googleSubscriptionDisconnected === true);
      emitPreferencesUpdated(preferences);
      const snapshot = await window.api.getModelRegistry({
        probe: !disconnect,
      });
      useModelCatalogStore.getState().hydrate(snapshot);
      if (
        !disconnect &&
        !disconnectedRef.current &&
        !snapshot.antigravity?.length
      )
        setSignIn(true);
    } catch (reason) {
      reportClientAppError(reason);
      setError({
        error: disconnect
          ? "Couldn't disconnect Antigravity. Try again."
          : "Couldn't reconnect Antigravity. Try again.",
      });
    } finally {
      setBusy(false);
    }
  };
  const runtime = useAntigravityRuntime(client, { onInstalled: refresh });
  const row = (
    <AntigravityConnectionRow
      runtime={runtime}
      connected={connected}
      disconnected={disconnected}
      busy={busy || loading}
      onDisconnect={(): void => {
        void changeConnection(true);
      }}
      onReconnect={(): void => {
        void changeConnection(false);
      }}
      onRefresh={(): void => {
        void refresh();
      }}
      signInOpen={signIn}
      onSignInOpenChange={setSignIn}
      error={
        error ? (
          <DesktopErrorBanner
            errorSource="google-subscription-connection"
            error={error.error}
          />
        ) : undefined
      }
    />
  );
  return placement === 'row' ? (
    row
  ) : (
    <SettingsRowsSection>
      <SettingsRowsGroup>{row}</SettingsRowsGroup>
    </SettingsRowsSection>
  );
}
