import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { useEffect, useRef, useState, type JSX } from 'react';
import { brand } from '@/lib/brand';
import { emitPreferencesUpdated } from '@/lib/preferences-events';
import { GoogleSubscriptionRow } from '@canopy/ui-shared/components';
import { useModelCatalogStore } from '@/stores/modelCatalogStore';
import { DesktopErrorBanner } from '@/components/shared/DesktopErrorBanner';
import { type InlineFailure } from '@/lib/inline-app-error';
import { AuthLoginModal } from './AuthLoginModal';

export function GoogleSubscriptionConnection(): JSX.Element {
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
            'No Gemini models are available. Check that Antigravity CLI 1.5.1 is installed, then sign in with your personal Google account.',
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
  return (
    <>
      <GoogleSubscriptionRow
        connected={connected && !disconnected}
        disconnected={disconnected}
        appName={brand.displayName}
        busy={busy || loading}
        onDisconnect={(): void => {
          void changeConnection(true);
        }}
        onReconnect={(): void => {
          void changeConnection(false);
        }}
        onSignIn={(): void => setSignIn(true)}
        onRefresh={(): void => {
          void refresh();
        }}
        error={
          error ? (
            <DesktopErrorBanner
              errorSource="google-subscription-connection"
              error={error.error}
            />
          ) : undefined
        }
      />
      {signIn ? (
        <AuthLoginModal
          provider="antigravity"
          onClose={(): void => {
            setSignIn(false);
            void refresh();
          }}
        />
      ) : null}
    </>
  );
}
