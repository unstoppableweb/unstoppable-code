'use client';

import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import type { HarnessSetupClient } from '@canopy/app-core';
import type { HarnessAntigravityRuntimeStatus } from '@canopy/protocol/remote-control/harness-setup';
import { Button, GoogleSubscriptionRow } from '@canopy/ui-shared/components';
import { useHarnessSetupHost } from './host';

/** The managed Antigravity CLI's status and the install this row started. */
export interface AntigravityRuntimeState {
  readonly runtime: HarnessAntigravityRuntimeStatus | undefined;
  readonly installing: boolean;
  readonly runtimeError: string | undefined;
  readonly install: () => Promise<void>;
  readonly cancelInstall: () => void;
  /**
   * Reads the status again while an install this row isn't waiting on runs
   * (another surface started it, or this row joined it and then cancelled).
   */
  readonly checkInstall: () => Promise<void>;
}

/**
 * Reads the Antigravity CLI's status and runs its managed install.
 * `onInstalled` runs once an install this row started finishes installed, or
 * Check again finds the managed CLI installed.
 */
export function useAntigravityRuntime(
  client: HarnessSetupClient['antigravity'],
  options: {
    readonly onInstalled?: () => Promise<void> | void;
    /** Mints the install's operation id; a UUID. */
    readonly newOperationId?: () => string;
  } = {},
): AntigravityRuntimeState {
  const host = useHarnessSetupHost();
  const hostRef = useRef(host);
  hostRef.current = host;
  const onInstalled = useRef(options.onInstalled);
  onInstalled.current = options.onInstalled;
  const newOperationId = useRef(
    options.newOperationId ?? ((): string => crypto.randomUUID()),
  );
  const [runtime, setRuntime] = useState<HarnessAntigravityRuntimeStatus>();
  const [installing, setInstalling] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string>();
  const mounted = useRef(true);
  // The install this row started; only it can cancel the download.
  const operation = useRef<string | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    const off = client.onProgress((status) => {
      if (mounted.current && operation.current) setRuntime(status);
    });
    void client
      .status()
      .then((status) => {
        if (mounted.current && !operation.current) setRuntime(status);
      })
      .catch((reason: unknown) => {
        hostRef.current.reportError(reason);
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
        void client.cancel(pending).catch((reason: unknown) => {
          hostRef.current.reportError(reason);
        });
    };
  }, [client]);
  const install = async (): Promise<void> => {
    if (operation.current) return;
    const operationId = newOperationId.current();
    operation.current = operationId;
    setInstalling(true);
    setRuntimeError(undefined);
    let final: HarnessAntigravityRuntimeStatus | undefined;
    try {
      final = await client.install(operationId);
    } catch (reason) {
      hostRef.current.reportError(reason);
      if (mounted.current)
        setRuntimeError("Couldn't install the Antigravity CLI. Try again.");
    } finally {
      if (operation.current === operationId) operation.current = undefined;
      if (mounted.current) setInstalling(false);
    }
    if (!final || !mounted.current) return;
    setRuntime(final);
    if (final.phase === 'installed') await onInstalled.current?.();
  };
  // Reads the status again while another surface's install runs; the row
  // gets no progress for an install it isn't waiting on.
  const checkInstall = async (): Promise<void> => {
    setRuntimeError(undefined);
    let status: HarnessAntigravityRuntimeStatus;
    try {
      status = await client.status();
    } catch (reason) {
      hostRef.current.reportError(reason);
      if (mounted.current)
        setRuntimeError("Couldn't check the Antigravity CLI. Try again.");
      return;
    }
    if (!mounted.current || operation.current) return;
    setRuntime(status);
    if (status.phase === 'installed' && status.managed)
      await onInstalled.current?.();
  };
  const cancelInstall = (): void => {
    const pending = operation.current;
    if (!pending) return;
    void client.cancel(pending).catch((reason: unknown) => {
      hostRef.current.reportError(reason);
      if (mounted.current)
        setRuntimeError("Couldn't cancel the Antigravity CLI download.");
    });
  };
  return {
    runtime,
    installing,
    runtimeError,
    install,
    cancelInstall,
    checkInstall,
  };
}

/**
 * The Antigravity CLI line under the Antigravity row: its version and state,
 * Install, Cancel or Check again, and a failed check or install. Progress
 * reaches only the surface that started or joined an install.
 */
export function AntigravityRuntimeLine({
  state,
}: {
  readonly state: AntigravityRuntimeState;
}): JSX.Element | null {
  const host = useHarnessSetupHost();
  const { runtime, installing, runtimeError } = state;
  // An install this row isn't waiting on (another window started it, or this
  // row joined it and then cancelled, which only detaches) shows as such,
  // with Check again to read its status.
  const installingElsewhere =
    !installing &&
    (runtime?.phase === 'downloading' || runtime?.phase === 'verifying');
  const inProgress = installing || installingElsewhere;
  // A browser never receives the path of the person's own copy, and its
  // wording names none.
  const ownCopyName =
    runtime?.executable ?? host.wording.antigravityOwnCopyFallback;
  const ownCopy = ownCopyName === undefined ? '' : ` at ${ownCopyName}`;
  const runtimeLabel = !runtime
    ? undefined
    : installingElsewhere
      ? 'Another window is installing the Antigravity CLI.'
      : inProgress
        ? runtime.phase === 'verifying'
          ? 'Verifying…'
          : 'Downloading…'
        : runtime.installed && runtime.managed
          ? `Antigravity CLI ${runtime.version}: installed (managed)`
          : runtime.installed
            ? `Antigravity CLI: your own copy${ownCopy} (version checked at launch)`
            : `Antigravity CLI ${runtime.version}: not installed`;
  const runtimeFailure =
    runtimeError ?? (inProgress ? undefined : runtime?.error);
  if (!runtimeLabel && !runtimeFailure) return null;
  return (
    <div data-testid="antigravity-runtime" className="flex flex-col gap-2">
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
              onClick={state.cancelInstall}
            >
              Cancel
            </Button>
          ) : installingElsewhere ? (
            <Button
              variant="secondary"
              size="sm"
              data-testid="antigravity-runtime-check"
              onClick={(): void => {
                void state.checkInstall();
              }}
            >
              Check again
            </Button>
          ) : runtime?.supported && !runtime.managed && !inProgress ? (
            <Button
              variant="secondary"
              size="sm"
              data-testid="antigravity-runtime-install"
              onClick={(): void => {
                void state.install();
              }}
            >
              {`Install managed ${runtime.version}`}
            </Button>
          ) : null}
        </div>
      ) : null}
      {runtimeFailure
        ? host.renderFailure({
            source: 'antigravity-runtime-install',
            failure: { error: runtimeFailure },
          })
        : null}
    </div>
  );
}

export interface AntigravityConnectionRowProps {
  readonly runtime: AntigravityRuntimeState;
  /** Gemini models are available to this app. */
  readonly connected: boolean;
  /** The person disconnected Antigravity from this app. */
  readonly disconnected: boolean;
  readonly busy: boolean;
  /** Re-checks Antigravity and reloads its models. */
  readonly onRefresh: () => void;
  /** Absent where the host can't change the connection setting. */
  readonly onDisconnect?: () => void;
  readonly onReconnect?: () => void;
  /** Whether the sign-in is open; the host decides when it opens itself. */
  readonly signInOpen: boolean;
  readonly onSignInOpenChange: (open: boolean) => void;
  readonly error?: ReactNode;
}

/**
 * The Antigravity provider row: the Google sign-in, the managed CLI and the
 * connection setting. The sign-in runs Antigravity's own sign-in through the
 * host's sign-in surface; closing it re-checks the models.
 */
export function AntigravityConnectionRow({
  runtime,
  connected,
  disconnected,
  busy,
  onRefresh,
  onDisconnect,
  onReconnect,
  signInOpen,
  onSignInOpenChange,
  error,
}: AntigravityConnectionRowProps): JSX.Element {
  const host = useHarnessSetupHost();
  return (
    <>
      <GoogleSubscriptionRow
        connected={connected && !disconnected}
        disconnected={disconnected}
        appName={host.appName}
        busy={busy}
        {...(onDisconnect ? { onDisconnect } : {})}
        {...(onReconnect ? { onReconnect } : {})}
        onSignIn={(): void => onSignInOpenChange(true)}
        onRefresh={onRefresh}
        runtime={<AntigravityRuntimeLine state={runtime} />}
        error={error}
      />
      {signInOpen
        ? host.renderSignIn({
            provider: 'antigravity',
            onClose: (): void => {
              onSignInOpenChange(false);
              onRefresh();
            },
          })
        : null}
    </>
  );
}
