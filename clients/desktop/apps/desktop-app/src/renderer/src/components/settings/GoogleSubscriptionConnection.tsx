import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { useEffect, useRef, useState, type JSX } from 'react';
import { brand } from '@/lib/brand';
import { emitPreferencesUpdated } from '@/lib/preferences-events';
import { Button, GoogleSubscriptionRow } from '@canopy/ui-shared/components';
import type { AntigravityRuntimeStatus } from '@canopy/desktop-shared/types/antigravity-runtime';
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
  const [runtime, setRuntime] = useState<AntigravityRuntimeStatus>();
  const [installing, setInstalling] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string>();
  const mounted = useRef(true);
  // The install this card started; only it can cancel the download.
  const operation = useRef<string | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    const api = window.api.antigravityRuntime;
    if (!api) return;
    const off = api.onProgress((status) => {
      if (mounted.current && operation.current) setRuntime(status);
    });
    void api
      .status()
      .then((status) => {
        if (mounted.current && !operation.current) setRuntime(status);
      })
      .catch((reason: unknown) => {
        reportClientAppError(reason);
        if (mounted.current)
          setRuntimeError(
            "Couldn't check the Antigravity CLI. Reopen Settings to check again.",
          );
      });
    return (): void => {
      mounted.current = false;
      off();
      const pending = operation.current;
      if (pending)
        void api.cancel(pending).catch((reason: unknown) => {
          reportClientAppError(reason);
        });
    };
  }, []);
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
  const installRuntime = async (): Promise<void> => {
    const api = window.api.antigravityRuntime;
    if (!api || operation.current) return;
    const operationId = crypto.randomUUID();
    operation.current = operationId;
    setInstalling(true);
    setRuntimeError(undefined);
    let final: AntigravityRuntimeStatus | undefined;
    try {
      final = await api.install(operationId);
    } catch (reason) {
      reportClientAppError(reason);
      if (mounted.current)
        setRuntimeError("Couldn't install the Antigravity CLI. Try again.");
    } finally {
      if (operation.current === operationId) operation.current = undefined;
      if (mounted.current) setInstalling(false);
    }
    if (!final || !mounted.current) return;
    setRuntime(final);
    if (final.phase === 'installed') await refresh();
  };
  const cancelInstall = (): void => {
    const pending = operation.current;
    if (!pending) return;
    void window.api.antigravityRuntime
      ?.cancel(pending)
      .catch((reason: unknown) => {
        reportClientAppError(reason);
        if (mounted.current)
          setRuntimeError("Couldn't cancel the Antigravity CLI download.");
      });
  };
  // Progress events reach only the window that started or joined an install.
  // An install running in another window shows here only as the phase read
  // when this card loaded status, without a Cancel button, and can stay stale
  // until Settings is reopened.
  const inProgress =
    installing ||
    runtime?.phase === 'downloading' ||
    runtime?.phase === 'verifying';
  const runtimeLabel = !runtime
    ? undefined
    : inProgress
      ? runtime.phase === 'verifying'
        ? 'Verifying…'
        : 'Downloading…'
      : runtime.installed && runtime.managed
        ? `Antigravity CLI ${runtime.version}: installed (managed)`
        : runtime.installed
          ? `Antigravity CLI: your own copy at ${runtime.executable ?? 'agy'} (version checked at launch)`
          : `Antigravity CLI ${runtime.version}: not installed`;
  const runtimeFailure =
    runtimeError ?? (inProgress ? undefined : runtime?.error);
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
        runtime={
          runtimeLabel || runtimeFailure ? (
            <div
              data-testid="antigravity-runtime"
              className="flex flex-col gap-2"
            >
              {runtimeLabel ? (
                <div className="flex flex-wrap items-center gap-2">
                  <p role="status" className="text-xs fg-secondary">
                    {runtimeLabel}
                  </p>
                  {installing ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      data-testid="antigravity-runtime-cancel"
                      onClick={cancelInstall}
                    >
                      Cancel
                    </Button>
                  ) : runtime?.supported && !runtime.managed && !inProgress ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      data-testid="antigravity-runtime-install"
                      onClick={(): void => {
                        void installRuntime();
                      }}
                    >
                      {`Install managed ${runtime.version}`}
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {runtimeFailure ? (
                <DesktopErrorBanner
                  errorSource="antigravity-runtime-install"
                  error={runtimeFailure}
                />
              ) : null}
            </div>
          ) : undefined
        }
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
