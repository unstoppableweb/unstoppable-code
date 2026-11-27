import { type JSX, type ReactNode, useId, useRef, useState } from 'react';
import {
  ActionMenuRowStyle,
  Button,
  MenuItem,
  MenuItemIcon,
  MENU_GAP,
  Menu,
  ModelProviderIcon,
  ProgressBar,
  ToggleSwitch,
  ProviderStatusDot,
  type ProviderStatusDotTone,
} from '@canopy/ui-shared';
import { DeviceBackendIcon } from '@canopy/ui-shared/icons';
import type {
  AccountProxyError,
  AccountProxyLocalRuntime,
  AccountProxySignIn,
  AccountProxySignInProvider,
  AccountProxyStatus,
} from '@canopy/desktop-shared/types/account-proxy';
import { extractIpcErrorMessage } from '@/lib/errors';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { useAccountProxyStore } from '@/stores/accountProxyStore';
import {
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsSegmentedControl,
} from '../SettingsLayout';
import { AccountProxyErrorMessage } from './AccountProxyErrorMessage';
import { accountProxyProviderLabel } from './accountProxyCopy';
import { StatusLabel } from '@canopy/ui-shared/components';

export type AccountProxyMode = 'server' | 'local';

const MODE_OPTIONS = [
  {
    value: 'server',
    label: 'A server',
    dataTestId: 'account-proxy-mode-server',
  },
  {
    value: 'local',
    label: 'This device',
    dataTestId: 'account-proxy-mode-local',
  },
] as const;

/** "Where the proxy runs", offered where a release exists for this device. */
export function AccountProxyModeRow({
  mode,
  onChange,
}: {
  readonly mode: AccountProxyMode;
  readonly onChange: (next: AccountProxyMode) => void;
}): JSX.Element {
  return (
    <SettingsRow
      label="Where the proxy runs"
      description="Connect to a server someone already runs, or run one on this device."
      control={
        <SettingsSegmentedControl
          label="Where the proxy runs"
          value={mode}
          options={MODE_OPTIONS}
          onChange={onChange}
          dataTestId="account-proxy-mode"
        />
      }
    />
  );
}

function ErrorText({
  children,
  testId,
}: {
  readonly children: ReactNode;
  readonly testId: string;
}): JSX.Element {
  return <StatusLabel data-testid={testId}>{children}</StatusLabel>;
}

/** The download in progress, as the row's status line and progress bar. */
function installLine(local: AccountProxyLocalRuntime): string {
  const version = local.version ?? '';
  if (!local.install || local.install.step === 'downloading') {
    const percent = local.install?.percent;
    return percent === null || percent === undefined
      ? `Downloading CLIProxyAPI ${version}…`
      : `Downloading CLIProxyAPI ${version}… ${String(percent)}%`;
  }
  return local.install.step === 'verifying'
    ? 'Checking the download…'
    : 'Installing…';
}

function errorMessage(error: AccountProxyError): ReactNode {
  // The app writes these itself, in plain words: the download or the start.
  // Their text can carry the proxy's own output, kept out of replays.
  return error.code === 'local-failed' ? (
    <span className={POSTHOG_REPLAY_BLOCK_CLASS}>{error.message}</span>
  ) : (
    <AccountProxyErrorMessage code={error.code} />
  );
}

/** Setup for "This device": download and start the proxy. */
export function AccountProxyLocalSetup({
  local,
}: {
  readonly local: AccountProxyLocalRuntime;
}): JSX.Element {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<AccountProxyError | null>(null);
  const version = local.version ?? '';

  if (local.phase === 'installing') {
    return (
      <SettingsRow
        label="Download and start"
        description={installLine(local)}
        dataTestId="account-proxy-local-installing"
      >
        <ProgressBar
          value={local.install?.percent ?? 0}
          indeterminate={local.install?.step !== 'downloading'}
          label="Download progress"
          hideLabel
        />
      </SettingsRow>
    );
  }

  const start = async (): Promise<void> => {
    const accountProxy = window.api.accountProxy;
    if (!accountProxy) return;
    setStarting(true);
    setError(null);
    try {
      const result = await accountProxy.setUpLocal();
      if (result.ok) useAccountProxyStore.getState().setStatus(result.status);
      else setError(result.error);
    } catch {
      setError({ code: 'local-failed', message: 'The proxy did not start.' });
    } finally {
      setStarting(false);
    }
  };

  return (
    <SettingsRow
      label="Download and start"
      dataTestId="account-proxy-local-setup"
      description={
        error ? (
          <ErrorText testId="account-proxy-local-error">
            {errorMessage(error)}
          </ErrorText>
        ) : local.phase === 'not-installed' ? (
          `Downloads CLIProxyAPI ${version} and runs it on this device. Your other devices can't use it.`
        ) : (
          `Runs CLIProxyAPI ${version} on this device. Your other devices can't use it.`
        )
      }
      control={
        <Button
          size="compact"
          variant="primary"
          disabled={starting}
          data-testid="account-proxy-local-start"
          onClick={(): void => {
            void start();
          }}
        >
          {starting
            ? 'Starting…'
            : local.phase === 'not-installed'
              ? 'Download and start'
              : 'Start'}
        </Button>
      }
    />
  );
}

const DOT_TONE: Readonly<
  Record<AccountProxyLocalRuntime['phase'], ProviderStatusDotTone>
> = {
  running: 'connected',
  starting: 'idle',
  installing: 'idle',
  stopped: 'idle',
  'not-installed': 'idle',
  unsupported: 'idle',
  error: 'failed',
};

function localStatusLine(local: AccountProxyLocalRuntime): ReactNode {
  switch (local.phase) {
    case 'running':
      return (
        <>
          {`Running · version ${local.version ?? ''} · `}
          <span className="font-mono">{`127.0.0.1:${String(local.port ?? '')}`}</span>
        </>
      );
    case 'starting':
      return 'Starting…';
    case 'installing':
      return installLine(local);
    case 'error':
      return (
        <ErrorText testId="account-proxy-local-error">
          {local.message ? (
            // The proxy's own output, which can name paths on this device.
            <span className={POSTHOG_REPLAY_BLOCK_CLASS}>{local.message}</span>
          ) : (
            "The proxy on this device didn't start."
          )}
        </ErrorText>
      );
    default:
      return 'Stopped. Agents on this device use their usual billing until it starts.';
  }
}

/** Connection for "This device": state, Start/Stop/Restart, and settings. */
export function AccountProxyLocalConnection({
  status,
}: {
  readonly status: AccountProxyStatus;
}): JSX.Element {
  const startWithAppId = useId();
  const [busy, setBusy] = useState(false);
  const [savingStart, setSavingStart] = useState(false);
  const local = status.local;
  const running = local.phase === 'running';
  const transitioning =
    busy || local.phase === 'starting' || local.phase === 'installing';

  const control = (action: 'start' | 'stop' | 'restart'): void => {
    setBusy(true);
    void window.api.accountProxy
      ?.controlLocal({ action })
      .then((next) => useAccountProxyStore.getState().setStatus(next))
      .finally(() => setBusy(false));
  };

  return (
    <SettingsSection title="Connection">
      <SettingsGroup>
        <SettingsRow
          dataTestId="account-proxy-local-connection"
          label={
            <span className="inline-flex items-center gap-2">
              <DeviceBackendIcon size="sm" aria-hidden />
              On this device
              <ProviderStatusDot tone={DOT_TONE[local.phase]} />
            </span>
          }
          description={
            status.error ? (
              <>
                {localStatusLine(local)}{' '}
                <ErrorText testId="account-proxy-local-connection-error">
                  {errorMessage(status.error)}
                </ErrorText>
              </>
            ) : (
              localStatusLine(local)
            )
          }
          control={
            running ? (
              <>
                <Button
                  size="compact"
                  disabled={transitioning}
                  data-testid="account-proxy-local-restart"
                  onClick={(): void => control('restart')}
                >
                  Restart
                </Button>
                <Button
                  size="compact"
                  disabled={transitioning}
                  data-testid="account-proxy-local-stop"
                  onClick={(): void => control('stop')}
                >
                  Stop
                </Button>
              </>
            ) : (
              <Button
                size="compact"
                variant="primary"
                disabled={transitioning}
                data-testid="account-proxy-local-start"
                onClick={(): void => control('start')}
              >
                {local.phase === 'error' ? 'Try again' : 'Start'}
              </Button>
            )
          }
        >
          {local.phase === 'installing' ? (
            <ProgressBar
              value={local.install?.percent ?? 0}
              indeterminate={local.install?.step !== 'downloading'}
              label="Download progress"
              hideLabel
            />
          ) : null}
        </SettingsRow>
        <SettingsRow
          label="Start with the app"
          htmlFor={startWithAppId}
          description="Starts the proxy when this app opens and stops it when the app quits."
          control={
            <ToggleSwitch
              id={startWithAppId}
              checked={local.startWithApp}
              disabled={savingStart}
              label="Start with the app"
              dataTestId="account-proxy-local-start-with-app"
              onChange={(next): void => {
                setSavingStart(true);
                void window.api
                  .savePreferences({ accountProxyLocalStartWithApp: next })
                  // The switch shows the status, so read it back once saved.
                  .then(() => window.api.accountProxy?.status())
                  .then((status) => {
                    if (status)
                      useAccountProxyStore.getState().setStatus(status);
                  })
                  .catch(() => undefined)
                  .finally(() => setSavingStart(false));
              }}
            />
          }
        />
        <SettingsRow
          label="Disconnect"
          description="Stops the proxy and forgets its keys. Signed-in accounts stay on this device for next time."
          control={
            <Button
              size="compact"
              disabled={busy}
              data-testid="account-proxy-disconnect"
              onClick={(): void => {
                setBusy(true);
                void window.api.accountProxy
                  ?.disconnect()
                  .then((next) =>
                    useAccountProxyStore.getState().setStatus(next),
                  )
                  .finally(() => setBusy(false));
              }}
            >
              Disconnect
            </Button>
          }
        />
      </SettingsGroup>
    </SettingsSection>
  );
}

const SIGN_IN_PROVIDERS: readonly AccountProxySignInProvider[] = [
  'claude',
  'codex',
];

function signIn(
  request: Parameters<NonNullable<typeof window.api.accountProxy>['signIn']>[0],
): Promise<void> {
  const accountProxy = window.api.accountProxy;
  if (!accountProxy) return Promise.resolve();
  return accountProxy
    .signIn(request)
    .then((next) => useAccountProxyStore.getState().setStatus(next))
    .catch(async (caught: unknown) => {
      // A start that failed may have ended the row shown; read it back.
      const next = await accountProxy.status().catch(() => null);
      if (next) useAccountProxyStore.getState().setStatus(next);
      throw caught;
    });
}

/** The account a sign-in is waiting on, or why it failed. */
function PendingSignInRow({
  pending,
  onError,
}: {
  readonly pending: AccountProxySignIn;
  readonly onError: (message: string | null) => void;
}): JSX.Element {
  const label = accountProxyProviderLabel(pending.provider);
  return (
    <SettingsRow
      dataTestId="account-proxy-sign-in"
      label={
        <span className="inline-flex items-center gap-2">
          <ModelProviderIcon provider={pending.provider} size="md" />
          {label}
        </span>
      }
      description={
        pending.phase === 'failed' ? (
          <ErrorText testId="account-proxy-sign-in-error">
            {pending.message ? (
              <span className={POSTHOG_REPLAY_BLOCK_CLASS}>
                {pending.message}
              </span>
            ) : (
              'Sign-in failed.'
            )}
          </ErrorText>
        ) : (
          'Finish signing in in your browser. This row updates when you do.'
        )
      }
      control={
        pending.phase === 'failed' ? (
          <>
            <Button
              size="compact"
              data-testid="account-proxy-sign-in-retry"
              onClick={(): void => {
                onError(null);
                signIn({
                  action: 'start',
                  provider: pending.provider,
                  authIndex: pending.authIndex,
                }).catch((caught: unknown) =>
                  onError(
                    extractIpcErrorMessage(caught) ||
                      'Sign-in did not start. Try again.',
                  ),
                );
              }}
            >
              Try again
            </Button>
            <Button
              size="compact"
              variant="secondary"
              onClick={(): void => {
                void signIn({ action: 'cancel' });
              }}
            >
              Dismiss
            </Button>
          </>
        ) : (
          <>
            <Button
              size="compact"
              data-testid="account-proxy-sign-in-reopen"
              onClick={(): void => {
                void signIn({ action: 'reopen' });
              }}
            >
              Open browser again
            </Button>
            <Button
              size="compact"
              variant="secondary"
              data-testid="account-proxy-sign-in-cancel"
              onClick={(): void => {
                void signIn({ action: 'cancel' });
              }}
            >
              Cancel
            </Button>
          </>
        )
      }
    />
  );
}

const ADD_ACCOUNT_MENU_LABEL = 'Sign in with';

/**
 * "Add an account" for the proxy on this device: signs in through the
 * proxy, so every agent on this device can then use the account.
 */
export function AccountProxyAddAccount({
  status,
}: {
  readonly status: AccountProxyStatus;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const running = status.local.phase === 'running';
  return (
    <>
      {status.signIn ? (
        <PendingSignInRow pending={status.signIn} onError={setError} />
      ) : null}
      <SettingsRow
        label="Add an account"
        description={
          error ? (
            <ErrorText testId="account-proxy-add-account-error">
              {error}
            </ErrorText>
          ) : running ? (
            'Sign in through the proxy. Agents on this device can then use the account.'
          ) : (
            'Start the proxy to add an account.'
          )
        }
        control={
          <>
            <Button
              ref={buttonRef}
              size="compact"
              disabled={!running}
              aria-haspopup="menu"
              aria-expanded={open}
              data-testid="account-proxy-add-account"
              onClick={(): void => setOpen((value) => !value)}
            >
              Add account
            </Button>
            <Menu
              open={open}
              onOpenChange={setOpen}
              anchorRef={buttonRef}
              placement="bottom-right"
              gap={MENU_GAP}
              aria-label={ADD_ACCOUNT_MENU_LABEL}
              data-testid="account-proxy-add-account-menu"
              className="w-56"
            >
              <ActionMenuRowStyle>
                {SIGN_IN_PROVIDERS.map((provider) => (
                  <MenuItem
                    key={provider}
                    data-testid={`account-proxy-add-account-${provider}`}
                    onClick={(): void => {
                      setOpen(false);
                      setError(null);
                      signIn({ action: 'start', provider }).catch(
                        (caught: unknown) =>
                          setError(
                            extractIpcErrorMessage(caught) ||
                              'Sign-in did not start. Try again.',
                          ),
                      );
                    }}
                  >
                    <MenuItemIcon>
                      <ModelProviderIcon provider={provider} size="md" />
                    </MenuItemIcon>
                    {accountProxyProviderLabel(provider)}
                  </MenuItem>
                ))}
              </ActionMenuRowStyle>
            </Menu>
          </>
        }
      />
    </>
  );
}
