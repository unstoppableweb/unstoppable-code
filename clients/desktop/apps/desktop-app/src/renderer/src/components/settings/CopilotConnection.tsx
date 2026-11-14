import { useEffect, useRef, useState, type JSX } from 'react';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import {
  Button,
  CopyButton,
  ProviderStatusDot,
  Surface,
} from '@canopy/ui-shared/components';
import type { CopilotConnectionStatus } from '@canopy/desktop-shared/types';
import {
  reportClientAppError,
  resolveClientAppError,
} from '@canopy/desktop-instrumentation/client';
import { toAppError } from '@canopy/protocol/app-errors';
import { DesktopErrorBanner } from '@/components/shared/DesktopErrorBanner';
import {
  inlineFailure,
  inlineFailureWithMainSentence,
  type InlineFailure,
} from '@/lib/inline-app-error';
import { emitPreferencesUpdated } from '@/lib/preferences-events';
import { GitHubIcon } from '@canopy/ui-shared/icons/AppIcons';
import { SettingsGroup, SettingsRow, SettingsSection } from './SettingsLayout';

interface CopilotConnectionProps {
  /**
   * `row`: one provider row inside the caller's group, as on Accounts beside
   * Claude and Codex. `section` (default): its own untitled section and box,
   * as on Labs.
   */
  readonly placement?: 'row' | 'section';
}

const ACTION_FAILED: Readonly<
  Record<'connect' | 'disconnect' | 'changeAccount', string>
> = {
  connect: "Couldn't connect Copilot.",
  disconnect: "Couldn't disconnect Copilot.",
  changeAccount: "Couldn't change the Copilot account.",
};

export function CopilotConnection({
  placement = 'section',
}: CopilotConnectionProps = {}): JSX.Element | null {
  const [status, setStatus] = useState<CopilotConnectionStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<InlineFailure | null>(null);
  const mounted = useRef(true);
  const operation = useRef(false);
  // A cancelled setup rejects with an abort; that is the user's choice, not a
  // failure to report.
  const cancelRequested = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const api = window.api.copilotConnection;
    if (!api) return;
    const off = api.onProgress((value) => {
      if (mounted.current) setStatus(value);
    });
    void api
      .status()
      .then(async (value) => {
        if (mounted.current) setStatus(value);
        if (value.enabled && value.installed) {
          const account = await api.account();
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
            setError({
              error:
                'Copilot sign-in changed. Reconnect the account you want to use.',
            });
          }
        }
      })
      .catch((reason: unknown) => {
        const appError = toAppError(resolveClientAppError(reason));
        if (appError && mounted.current && !operation.current)
          setError(
            inlineFailure(
              appError,
              "Couldn't check Copilot setup. Reopen this page to check again.",
            ),
          );
      });
    return (): void => {
      mounted.current = false;
      off();
      if (operation.current)
        void api.cancel().catch((reason: unknown) => {
          reportClientAppError(reason);
        });
    };
  }, []);

  const act = async (
    kind: 'connect' | 'disconnect' | 'changeAccount',
  ): Promise<void> => {
    const api = window.api.copilotConnection;
    if (!api || operation.current) return;
    operation.current = true;
    cancelRequested.current = false;
    setBusy(true);
    setError(null);
    try {
      await api[kind]();
      const next = await api.status();
      const preferences = await window.api.loadPreferences();
      emitPreferencesUpdated(preferences);
      if (mounted.current) setStatus(next);
    } catch (reason) {
      // Main writes its own sentences (a declined sign-in, a blocking
      // policy), which lead; raw text leaves ours leading.
      const appError = toAppError(resolveClientAppError(reason));
      if (appError && mounted.current && !cancelRequested.current)
        setError(inlineFailureWithMainSentence(appError, ACTION_FAILED[kind]));
    } finally {
      operation.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  if (status && !status.supported) return null;
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
  const row = (
    <SettingsRow
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
              <span className={POSTHOG_REPLAY_BLOCK_CLASS}>
                {status.account.login}
              </span>
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
                void window.api.copilotConnection
                  ?.cancel()
                  .catch((reason: unknown) => {
                    const appError = toAppError(resolveClientAppError(reason));
                    if (appError && mounted.current)
                      setError(
                        inlineFailure(appError, "Couldn't stop Copilot setup."),
                      );
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
                void window.api.browser.openExternal({
                  url: status.verificationUri,
                });
            }}
          >
            Open GitHub
          </Button>
        </div>
      )}
      {connected && !progress && (
        <p className="text-xs fg-secondary">
          Disconnect signs out of Copilot on this device. Change account signs
          out first.
        </p>
      )}
      <DesktopErrorBanner
        errorSource="copilot-connection-error"
        className=""
        error={error?.error}
        testId="copilot-connection-error"
        {...(error?.details === undefined ? {} : { details: error.details })}
        onDismiss={(): void => setError(null)}
      />
    </SettingsRow>
  );
  if (placement === 'row') return row;
  return (
    // Untitled: the row itself names Copilot, so a heading would repeat it.
    <SettingsSection>
      <SettingsGroup>{row}</SettingsGroup>
    </SettingsSection>
  );
}
