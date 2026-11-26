'use client';

import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import type { HarnessSetupClient } from '@canopy/app-core';
import type { HarnessOpenCodeStatus } from '@canopy/protocol/remote-control/harness-setup';
import { Button, SettingsRowsRow } from '@canopy/ui-shared/components';
import { ModelProviderIcon } from '@canopy/ui-shared';
import { useHarnessSetupHost, type HarnessSetupFailure } from './host';

/**
 * The OpenCode provider row: Connect downloads OpenCode, and "Sign in to a
 * provider" runs OpenCode's own sign-in through the host's sign-in surface.
 * `onSignInClosed` runs when that sign-in closes, so the host can load the
 * provider's models again. Nothing renders while OpenCode is unsupported on
 * the computer.
 */
export function OpenCodeConnectionRow({
  client,
  onSignInClosed,
  frame = (row): ReactNode => row,
}: {
  readonly client: HarnessSetupClient['opencode'];
  readonly onSignInClosed?: () => void;
  /**
   * Wraps the row when it renders, such as in its own section; nothing is
   * framed while OpenCode is unsupported.
   */
  readonly frame?: (row: JSX.Element) => ReactNode;
}): ReactNode {
  const host = useHarnessSetupHost();
  const hostRef = useRef(host);
  hostRef.current = host;
  const [status, setStatus] = useState<HarnessOpenCodeStatus>();
  const [login, setLogin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<HarnessSetupFailure | null>(null);
  const mounted = useRef(true);
  const operation = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const off = client.onProgress((value) => {
      if (mounted.current) setStatus(value);
    });
    void client
      .status()
      .then((value) => {
        if (mounted.current && !operation.current) setStatus(value);
      })
      .catch((reason: unknown) => {
        const shown = hostRef.current.failure(
          reason,
          "Couldn't check OpenCode setup. Reopen this page to check again.",
          'fallback',
        );
        if (shown && mounted.current) setFailure(shown);
      });
    return (): void => {
      mounted.current = false;
      off();
      if (operation.current)
        void client.cancel().catch((reason: unknown) => {
          hostRef.current.reportError(reason);
        });
    };
  }, [client]);
  const act = async (kind: 'connect' | 'disconnect'): Promise<void> => {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setFailure(null);
    try {
      await client[kind]();
      const next = await client.status();
      await hostRef.current.afterConnectionChange?.();
      if (mounted.current) setStatus(next);
    } catch (reason) {
      const shown = hostRef.current.failure(
        reason,
        kind === 'connect'
          ? "Couldn't connect OpenCode."
          : "Couldn't disconnect OpenCode.",
        'host-leads',
      );
      if (shown && mounted.current) setFailure(shown);
    } finally {
      operation.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  if (status && !status.supported) return null;
  const connected = status?.enabled && status.installed;
  const label = !status
    ? 'Checking setup…'
    : !busy
      ? connected
        ? 'OpenCode connected'
        : 'Ready to connect'
      : status.phase === 'downloading'
        ? `Downloading OpenCode${status.percent === undefined ? '…' : `… ${status.percent}%`}`
        : status.phase === 'discovering'
          ? 'Loading your OpenCode models…'
          : status.phase === 'verifying'
            ? 'Verifying download…'
            : 'Preparing OpenCode…';
  return (
    <>
      {frame(
        <SettingsRowsRow
          dataTestId="opencode-connection"
          label={
            <span className="inline-flex items-center gap-2">
              <ModelProviderIcon
                provider="opencode"
                size={16}
                className="shrink-0 fg-primary"
                aria-hidden
              />
              OpenCode
            </span>
          }
          description="Connect your configured OpenCode providers. Their billing and usage limits apply."
          control={
            <>
              <Button
                size="compact"
                variant={connected ? 'secondary' : 'primary'}
                disabled={busy || !status}
                data-testid="opencode-connect"
                onClick={() => {
                  void act(connected ? 'disconnect' : 'connect');
                }}
              >
                {connected ? 'Disconnect' : 'Connect OpenCode'}
              </Button>
              {status?.installed && (
                <Button
                  size="compact"
                  variant="secondary"
                  disabled={busy}
                  data-testid="opencode-provider-login"
                  onClick={() => setLogin(true)}
                >
                  {connected ? 'Manage providers' : 'Sign in to a provider'}
                </Button>
              )}
              {busy && (
                <Button
                  size="compact"
                  variant="secondary"
                  data-testid="opencode-cancel"
                  onClick={() => {
                    void client.cancel().catch((reason: unknown) => {
                      const shown = hostRef.current.failure(
                        reason,
                        "Couldn't cancel OpenCode setup.",
                        'fallback',
                      );
                      if (shown && mounted.current) setFailure(shown);
                    });
                  }}
                >
                  Cancel
                </Button>
              )}
            </>
          }
        >
          <p
            role="status"
            className="text-xs fg-secondary"
            data-testid="opencode-connection-status"
          >
            {label}
          </p>
          {!connected && (
            <p className="text-xs fg-secondary">
              Connect to download OpenCode, then sign in to a provider. Existing
              OpenCode accounts and provider settings are reused. Download size
              {status?.archiveBytes
                ? ` (${Math.round(status.archiveBytes / 1_000_000)} MB)`
                : ''}
              .
            </p>
          )}
          {host.renderFailure({
            source: 'opencode-connection-error',
            testId: 'opencode-connection-error',
            failure,
            onDismiss: (): void => setFailure(null),
            flush: true,
          })}
        </SettingsRowsRow>,
      )}
      {login
        ? host.renderSignIn({
            provider: 'opencode',
            onClose: () => {
              setLogin(false);
              onSignInClosed?.();
            },
          })
        : null}
    </>
  );
}
