'use client';

import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import type { HarnessSetupClient } from '@canopy/app-core';
import type { HarnessCopilotStatus } from '@canopy/protocol/remote-control/harness-setup';
import {
  Button,
  CopyButton,
  ProviderStatusDot,
  SettingsRowsRow,
  Surface,
} from '@canopy/ui-shared/components';
import { GitHubIcon } from '@canopy/ui-shared/icons/AppIcons';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { useHarnessSetupHost, type HarnessSetupFailure } from './host';

const ACTION_FAILED: Readonly<
  Record<'connect' | 'disconnect' | 'changeAccount', string>
> = {
  connect: "Couldn't connect Copilot.",
  disconnect: "Couldn't disconnect Copilot.",
  changeAccount: "Couldn't change the Copilot account.",
};

/**
 * The GitHub Copilot provider row. Connect downloads the runtime and runs
 * GitHub's device flow: the code and the GitHub page show here, so the
 * person enters the code wherever they are. While Copilot is unsupported on
 * the computer, a Linux computer shows the row as not available yet, and
 * other computers render nothing.
 */
export function CopilotConnectionRow({
  client,
  frame = (row): ReactNode => row,
}: {
  readonly client: HarnessSetupClient['copilot'];
  /**
   * Wraps the row when it renders, such as in its own section; nothing is
   * framed while nothing renders.
   */
  readonly frame?: (row: JSX.Element) => ReactNode;
}): ReactNode {
  const host = useHarnessSetupHost();
  const hostRef = useRef(host);
  hostRef.current = host;
  const [status, setStatus] = useState<HarnessCopilotStatus>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<HarnessSetupFailure | null>(null);
  const mounted = useRef(true);
  const operation = useRef(false);
  // A cancelled setup rejects with an abort; that is the person's choice, not
  // a failure to report.
  const cancelRequested = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const off = client.onProgress((value) => {
      if (mounted.current) setStatus(value);
    });
    void client
      .status()
      .then(async (value) => {
        if (mounted.current) setStatus(value);
        if (value.enabled && value.installed) {
          const account = await client.account();
          if (
            mounted.current &&
            !operation.current &&
            (!account ||
              account.host !== value.account?.host ||
              account.login !== value.account?.login)
          ) {
            setStatus({
              ...value,
              enabled: false,
              account: null,
              phase: 'idle',
            });
            setFailure({
              error:
                'Copilot sign-in changed. Reconnect the account you want to use.',
            });
          }
        }
      })
      .catch((reason: unknown) => {
        const shown = hostRef.current.failure(
          reason,
          "Couldn't check Copilot setup. Reopen this page to check again.",
          'fallback',
        );
        if (shown && mounted.current && !operation.current) setFailure(shown);
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

  const act = async (
    kind: 'connect' | 'disconnect' | 'changeAccount',
  ): Promise<void> => {
    if (operation.current) return;
    operation.current = true;
    cancelRequested.current = false;
    setBusy(true);
    setFailure(null);
    try {
      await client[kind]();
      const next = await client.status();
      await hostRef.current.afterConnectionChange?.();
      if (mounted.current) setStatus(next);
    } catch (reason) {
      // The computer writes its own sentences (a declined sign-in, a blocking
      // policy), which lead; raw text leaves ours leading.
      const shown = hostRef.current.failure(
        reason,
        ACTION_FAILED[kind],
        'host-leads',
      );
      if (shown && mounted.current && !cancelRequested.current)
        setFailure(shown);
    } finally {
      operation.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  if (status && !status.supported) {
    // A Linux computer without a Copilot pin says so rather than hide the
    // provider. Other computers without a pin keep hiding it, as before.
    if (host.computerPlatform !== 'linux') return null;
    return frame(
      <SettingsRowsRow
        dataTestId="copilot-connection"
        label={
          <span className="inline-flex items-center gap-2">
            <GitHubIcon size="md" className="shrink-0 fg-primary" aria-hidden />
            GitHub Copilot
          </span>
        }
        description={
          <span
            role="status"
            data-testid="copilot-connection-status"
            className="block"
          >
            Not available on Linux yet
          </span>
        }
        control={
          <Button size="compact" disabled data-testid="copilot-connect">
            Connect Copilot
          </Button>
        }
      />,
    );
  }
  const connected = status?.enabled && status.installed;
  const progress =
    busy && status?.phase !== 'connected' && status?.phase !== 'idle';
  const label = !status
    ? 'Checking setup…'
    : !busy
      ? connected
        ? 'Copilot connected'
        : 'Ready to connect'
      : status.phase === 'downloading'
        ? `Downloading Copilot${status.percent === undefined ? '…' : `… ${status.percent}%`}`
        : status.phase === 'authorizing'
          ? 'Enter this code on GitHub to connect Copilot'
          : status.phase === 'checking'
            ? 'Checking Copilot access…'
            : status.phase === 'verifying'
              ? 'Verifying download…'
              : 'Preparing Copilot…';
  // Mark, name and status dot as the label, as on the Claude, Codex and
  // Cursor rows; the account actions sit on the row's trailing edge.
  return frame(
    <SettingsRowsRow
      dataTestId="copilot-connection"
      label={
        <span className="inline-flex items-center gap-2">
          <GitHubIcon size="md" className="shrink-0 fg-primary" aria-hidden />
          GitHub Copilot
          {/* No dot until the first status read answers: "Checking setup…"
              is neither connected nor disconnected. */}
          {status && (
            <ProviderStatusDot
              data-testid="copilot-connection-status-dot"
              tone={connected ? 'connected' : 'failed'}
            />
          )}
        </span>
      }
      description={
        <>
          <span
            role="status"
            data-testid="copilot-connection-status"
            className="block"
          >
            {label}
          </span>
          {connected && status?.account && !busy && (
            <span data-testid="copilot-connection-account" className="block">
              Signed in as{' '}
              <span className={REPLAY_BLOCK_CLASS}>{status.account.login}</span>
            </span>
          )}
        </>
      }
      control={
        <>
          {busy && (
            <Button
              size="compact"
              variant="secondary"
              data-testid="copilot-cancel"
              onClick={() => {
                cancelRequested.current = true;
                void client.cancel().catch((reason: unknown) => {
                  const shown = hostRef.current.failure(
                    reason,
                    "Couldn't stop Copilot setup.",
                    'fallback',
                  );
                  if (shown && mounted.current) setFailure(shown);
                });
              }}
            >
              Cancel
            </Button>
          )}
          {connected && !busy && (
            <Button
              size="compact"
              variant="secondary"
              data-testid="copilot-change-account"
              onClick={() => {
                void act('changeAccount');
              }}
            >
              Change account
            </Button>
          )}
          <Button
            size="compact"
            variant={connected ? 'secondary' : 'primary'}
            disabled={busy || !status}
            data-testid="copilot-connect"
            onClick={() => {
              void act(connected ? 'disconnect' : 'connect');
            }}
          >
            {connected ? 'Disconnect Copilot' : 'Connect Copilot'}
          </Button>
        </>
      }
    >
      {/* The pitch answers what Connect does, so it is spent once Copilot is
          connected and stays through setup. */}
      {!connected && (
        <div className="flex flex-col text-xs text-pretty fg-secondary gap-1">
          <p>
            Connect your GitHub account to use Copilot models, tools, and
            skills.
          </p>
          <p>
            {status?.archiveBytes
              ? `${Math.round(status.archiveBytes / 1_000_000)}MB download · `
              : ''}
            Your Copilot plan and usage limits apply
          </p>
        </div>
      )}
      {busy && status?.phase === 'authorizing' && status.userCode && (
        <div className="flex flex-wrap items-center gap-2">
          {/* The device code is a live sign-in secret. */}
          <Surface
            as="span"
            variant="outline"
            size="small"
            replay="block"
            data-testid="copilot-device-code"
            aria-label={`Device code ${status.userCode}`}
          >
            <span className="block px-3 py-1 font-mono text-m fg-primary">
              {status.userCode}
            </span>
          </Surface>
          <CopyButton
            variant="secondary"
            size="compact"
            label="Copy code"
            value={status.userCode}
            dataTestId="copilot-copy-code"
          />
          <Button
            size="compact"
            variant="secondary"
            data-testid="copilot-open-github"
            onClick={() => {
              if (status.verificationUri)
                host.openSignInLink(status.verificationUri, 'github-device');
            }}
          >
            Open GitHub
          </Button>
        </div>
      )}
      {connected && !progress && (
        <p className="text-xs fg-secondary">
          {host.wording.copilotSignOutNote}
        </p>
      )}
      {host.renderFailure({
        source: 'copilot-connection-error',
        testId: 'copilot-connection-error',
        failure,
        onDismiss: (): void => setFailure(null),
        flush: true,
      })}
    </SettingsRowsRow>,
  );
}
