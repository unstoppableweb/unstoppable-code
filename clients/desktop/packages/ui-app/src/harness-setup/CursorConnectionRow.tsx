'use client';

import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import type { HarnessSetupClient } from '@canopy/app-core';
import type {
  HarnessCursorAccount,
  HarnessCursorAccountIntent,
  HarnessCursorStatus,
} from '@canopy/protocol/remote-control/harness-setup';
import {
  Button,
  ProviderStatusDot,
  SettingsRowsRow,
  Tooltip,
} from '@canopy/ui-shared/components';
import { CursorIcon } from '@canopy/ui-shared/icons/AppIcons';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { useHarnessSetupHost, type HarnessSetupFailure } from './host';

type CursorClient = HarnessSetupClient['cursor'];

/** The Cursor row's state and actions, shared by every host. */
export interface CursorConnectionState {
  readonly status: HarnessCursorStatus | null;
  /** `undefined` while the account has not been read for this connection. */
  readonly account: HarnessCursorAccount | null | undefined;
  /** A read that failed: never treated as a sign-out. */
  readonly accountUnavailable: boolean;
  readonly busy: boolean;
  readonly connecting: boolean;
  readonly changingAccount: boolean;
  readonly connected: boolean;
  readonly inProgress: boolean;
  readonly failure: HarnessSetupFailure | null;
  readonly connect: () => Promise<void>;
  readonly changeAccount: (intent: HarnessCursorAccountIntent) => Promise<void>;
  readonly disconnect: () => Promise<void>;
  readonly cancel: () => void;
  readonly retryAccount: () => void;
  readonly dismissFailure: () => void;
  /** Whether an operation is running; read synchronously by action routers. */
  readonly isActive: () => boolean;
}

/**
 * Cursor's connection on the computer: the cheap status read, the account
 * probe once connected, Connect, account changes, Disconnect and Cancel.
 * `onAccountChanged` runs after anything that may change the signed-in
 * account, so a host can refresh what it shows about that account's plan.
 */
export function useCursorConnection(
  client: CursorClient,
  options: { readonly onAccountChanged?: () => void } = {},
): CursorConnectionState {
  const host = useHarnessSetupHost();
  const [status, setStatus] = useState<HarnessCursorStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [changingAccount, setChangingAccount] = useState(false);
  const [account, setAccount] = useState<
    HarnessCursorAccount | null | undefined
  >(undefined);
  // A read that failed is not a sign-out: the button that state offers signs
  // the shared credential store out, so it must never appear on a guess.
  const [accountUnavailable, setAccountUnavailable] = useState(false);
  // Nothing else changes when the cause of a failed read clears, so the retry
  // affordance re-arms the probe effect itself.
  const [accountAttempt, setAccountAttempt] = useState(0);
  const [failure, setFailure] = useState<HarnessSetupFailure | null>(null);
  const connected = Boolean(status?.enabled && status.installed);
  const inProgress = connecting || changingAccount;
  const active = useRef(false);
  const cancelRequested = useRef(false);
  const mounted = useRef(true);
  const hostRef = useRef(host);
  hostRef.current = host;
  const accountChanged = useRef(options.onAccountChanged);
  accountChanged.current = options.onAccountChanged;
  useEffect(() => {
    mounted.current = true;
    void client
      .status()
      .then((next) => {
        if (mounted.current) setStatus(next);
      })
      .catch((cause: unknown) => {
        hostRef.current.reportError(cause);
      });
    const off = client.onProgress((next) => {
      if (mounted.current && active.current) setStatus(next);
    });
    return (): void => {
      mounted.current = false;
      off();
      if (active.current)
        void client.cancel().catch((cause: unknown) => {
          hostRef.current.reportError(cause);
        });
    };
  }, [client]);
  // The cheap status read never runs the runtime, so the signed-in account is
  // probed separately once the row knows the runtime is connected; results
  // that did probe (Connect, Change account) carry the account themselves.
  useEffect(() => {
    // A setup or an account change owns the CLI while it runs, and its own
    // result carries the account, so probing under it would only fail.
    if (!connected || inProgress || status?.account !== undefined) return;
    let current = true;
    void client
      .account()
      .then((next) => {
        if (!current || !mounted.current) return;
        setAccountUnavailable(false);
        setAccount(next);
      })
      .catch((cause: unknown) => {
        // The row shows the failed read with Check again.
        hostRef.current.reportError(cause);
        if (current && mounted.current) setAccountUnavailable(true);
      });
    return (): void => {
      current = false;
    };
  }, [client, connected, inProgress, status?.account, accountAttempt]);
  useEffect(() => {
    if (status?.account !== undefined) {
      setAccountUnavailable(false);
      setAccount(status.account);
    } else if (!connected) {
      setAccountUnavailable(false);
      setAccount(undefined);
    }
  }, [connected, status?.account]);
  const afterChange = async (): Promise<void> => {
    await hostRef.current.afterConnectionChange?.();
  };
  const connect = async (): Promise<void> => {
    if (active.current) return;
    active.current = true;
    cancelRequested.current = false;
    setBusy(true);
    setConnecting(true);
    setFailure(null);
    try {
      const next = await client.connect();
      if (mounted.current) setStatus(next);
      await afterChange();
      accountChanged.current?.();
    } catch (cause) {
      if (mounted.current) {
        // An intentional Cancel rejects the connect call; that is not a failure.
        const shown = hostRef.current.failure(
          cause,
          "Couldn't connect Cursor.",
          'host-leads',
        );
        if (shown && !cancelRequested.current) setFailure(shown);
        const next = await client.status().catch((statusCause: unknown) => {
          hostRef.current.reportError(statusCause);
          return null;
        });
        if (mounted.current && next) setStatus(next);
      }
    } finally {
      active.current = false;
      if (mounted.current) {
        setBusy(false);
        setConnecting(false);
      }
    }
  };
  const changeAccount = async (
    intent: HarnessCursorAccountIntent,
  ): Promise<void> => {
    if (active.current || !connected) return;
    active.current = true;
    cancelRequested.current = false;
    setBusy(true);
    setChangingAccount(true);
    setFailure(null);
    try {
      const next = await client.changeAccount(intent);
      if (mounted.current) setStatus(next);
      accountChanged.current?.();
    } catch (cause) {
      if (mounted.current) {
        // Cancel is not a failure, but sign-out already happened: re-read the
        // account so the row offers sign-in instead of claiming one.
        const shown = hostRef.current.failure(
          cause,
          "Couldn't change the Cursor account.",
          'host-leads',
        );
        if (shown && !cancelRequested.current) setFailure(shown);
        // A sign-out may already have happened, so stop naming the old
        // account immediately; clearing both re-arms the probe effect, which
        // owns the re-read. A second explicit read here would only race it.
        setAccount(undefined);
        const next = await client.status().catch((statusCause: unknown) => {
          hostRef.current.reportError(statusCause);
          return null;
        });
        if (mounted.current)
          setStatus((prev) =>
            next
              ? { ...next, account: undefined }
              : // Without this the stale account survives on `status`, and the
                // probe effect bails on it forever: no account line, no
                // button, and no way back but leaving the page.
                prev && { ...prev, account: undefined },
          );
        // The sign-out may have run before the cancel, so the plan on record
        // may belong to a session that no longer exists.
        accountChanged.current?.();
      }
    } finally {
      active.current = false;
      if (mounted.current) {
        setBusy(false);
        setChangingAccount(false);
      }
    }
  };
  const disconnect = async (): Promise<void> => {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setFailure(null);
    try {
      await client.disconnect();
      const next = await client.status();
      if (mounted.current) setStatus(next);
      await afterChange();
    } catch (cause) {
      const shown = hostRef.current.failure(
        cause,
        "Couldn't disconnect Cursor.",
        'fallback',
      );
      if (shown && mounted.current) setFailure(shown);
    } finally {
      active.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const cancel = (): void => {
    cancelRequested.current = true;
    void client.cancel().catch((cause: unknown) => {
      const shown = hostRef.current.failure(
        cause,
        "Couldn't stop Cursor setup.",
        'fallback',
      );
      if (shown && mounted.current) setFailure(shown);
    });
  };
  return {
    status,
    account,
    accountUnavailable,
    busy,
    connecting,
    changingAccount,
    connected,
    inProgress,
    failure,
    connect,
    changeAccount,
    disconnect,
    cancel,
    retryAccount: (): void => {
      setAccountUnavailable(false);
      setAccountAttempt((attempt) => attempt + 1);
    },
    dismissFailure: (): void => setFailure(null),
    isActive: (): boolean => active.current,
  };
}

export interface CursorConnectionRowProps {
  readonly state: CursorConnectionState;
  /**
   * The signed-in account's plan, when the host knows it for this account
   * (the desktop's usage read). The row shows it after the account.
   */
  readonly plan?: string;
  /** Detail under a signed-in account, such as what carries over. */
  readonly signedInDetail?: ReactNode;
  /** Host notes shown wherever Cursor can be connected. */
  readonly footer?: ReactNode;
}

/**
 * The Cursor provider row: mark, name and status dot as the label, the
 * status lines under it, and one account action on the trailing edge. A
 * failed account read offers its retry there instead of a sign-out it cannot
 * justify; an unanswered read offers nothing yet. Nothing renders while
 * Cursor is unsupported on the computer.
 */
export function CursorConnectionRow({
  state,
  plan,
  signedInDetail,
  footer,
}: CursorConnectionRowProps): JSX.Element | null {
  const host = useHarnessSetupHost();
  const {
    status,
    account,
    accountUnavailable,
    busy,
    connecting,
    changingAccount,
    connected,
    inProgress,
  } = state;
  if (!status?.supported) return null;
  const { computer } = host.wording;
  // The dot means "signed in", as on the peer rows: a connected runtime with
  // no session, or one whose session could not be read, is not green.
  const signedIn = connected && !accountUnavailable && account !== null;
  // The size is only news before the archive exists.
  const settingUp = !connected || connecting;
  const downloadSize =
    !status.installed && status.archiveBytes
      ? `${Math.round(status.archiveBytes / 1_000_000)}MB download · `
      : '';
  // A settled connection has no line of its own, as on the Claude and Codex
  // rows: the status dot and the signed-in line already say it.
  const description = !inProgress
    ? busy
      ? 'Disconnecting…'
      : connected
        ? undefined
        : status.installed
          ? 'Ready to connect'
          : 'Connect to download Cursor'
    : status.phase === 'downloading'
      ? `Downloading Cursor${status.percent === undefined ? '…' : `… ${status.percent}%`}`
      : status.phase === 'verifying'
        ? 'Verifying download…'
        : status.phase === 'installing'
          ? 'Installing Cursor…'
          : status.phase === 'signing-out'
            ? 'Signing out of Cursor…'
            : status.phase === 'signing-in'
              ? status.signInUrl
                ? `Open the Cursor sign-in on ${host.wording.cursorSignInDevice} to finish`
                : 'Finish signing in in your browser'
              : changingAccount
                ? // The pre-flight read can take seconds and can refuse, so
                  // this must not claim a sign-out that has not run.
                  'Checking the Cursor sign-in…'
                : 'Preparing Cursor…';
  const action = settingUp ? (
    <Button
      size="compact"
      data-testid="cursor-connect"
      disabled={busy}
      onClick={(): void => {
        void state.connect();
      }}
    >
      Connect Cursor
    </Button>
  ) : accountUnavailable ? (
    <Button
      size="compact"
      data-testid="cursor-account-retry"
      disabled={busy}
      onClick={state.retryAccount}
    >
      Check again
    </Button>
  ) : account === undefined ? null : (
    // The hint keeps the side effect discoverable without a paragraph. Only
    // macOS shares the credential store (the Keychain) with the person's own
    // Cursor CLI; on Linux and Windows the sign-in lives in the app's private
    // profile, so only that sign-in is signed out. A computer whose system
    // isn't known gets the macOS warning, the wider of the two.
    <Tooltip
      label={
        account === null
          ? "Opens Cursor's sign-in in your browser."
          : host.computerPlatform === undefined ||
              host.computerPlatform === 'darwin'
            ? `Signs out the Cursor CLI on ${computer}, then opens Cursor's sign-in in your browser.`
            : `Signs out Cursor in ${host.wording.cursorAppSignIn}, then opens Cursor's sign-in in your browser. A Cursor CLI you installed yourself stays signed in.`
      }
      contentClassName="max-w-64 whitespace-normal"
    >
      <Button
        size="compact"
        data-testid="cursor-change-account"
        disabled={busy}
        onClick={(): void => {
          void state.changeAccount(account === null ? 'sign-in' : 'change');
        }}
      >
        {account === null ? 'Sign in' : 'Change account'}
      </Button>
    </Tooltip>
  );
  return (
    <SettingsRowsRow
      dataTestId="cursor-connection"
      label={
        <span className="inline-flex items-center gap-2">
          <CursorIcon
            size="md"
            data-testid="cursor-connection-logo"
            className="shrink-0 fg-primary"
            aria-hidden
          />
          Cursor
          <ProviderStatusDot
            data-testid="cursor-connection-status-dot"
            tone={signedIn ? 'connected' : 'failed'}
          />
        </span>
      }
      description={
        <>
          {description && (
            <span
              role="status"
              data-testid="cursor-connection-status"
              className="block"
            >
              {description}
            </span>
          )}
          {connected && !inProgress && (
            <span
              role="status"
              data-testid="cursor-connection-account"
              className="block"
            >
              {accountUnavailable ? (
                'Could not check the Cursor sign-in'
              ) : account === undefined ? (
                'Checking sign-in…'
              ) : account === null ? (
                'Sign in to use your Cursor account'
              ) : (
                // One line, as on the Claude / Codex rows: the account,
                // then the plan after a middle dot when it is known.
                // Session replay blocks only the email.
                <>
                  {account.email ? (
                    <>
                      Signed in as{' '}
                      <span className={REPLAY_BLOCK_CLASS}>
                        {account.email}
                      </span>
                    </>
                  ) : (
                    'Signed in'
                  )}
                  {plan ? ` · ${plan}` : null}
                </>
              )}
            </span>
          )}
        </>
      }
      control={
        <>
          {/* A sign-in started from a controller sends its link here instead
              of opening the computer's browser. */}
          {inProgress && status.phase === 'signing-in' && status.signInUrl && (
            <Button
              size="compact"
              variant="secondary"
              data-testid="cursor-open-sign-in"
              onClick={(): void => {
                // The other computer checked the link before sending it;
                // the host checks again before opening it.
                if (status.signInUrl)
                  host.openSignInLink(status.signInUrl, 'cursor');
              }}
            >
              Open sign-in
            </Button>
          )}
          {inProgress && (
            <Button
              size="compact"
              variant="secondary"
              data-testid="cursor-connect-cancel"
              onClick={state.cancel}
            >
              {changingAccount ? 'Cancel' : 'Cancel setup'}
            </Button>
          )}
          {action}
        </>
      }
    >
      {/* Only under a signed-in account: a connected runtime with no account
          is still asked to sign in. */}
      {connected &&
        !inProgress &&
        account !== undefined &&
        account !== null &&
        signedInDetail}
      {/* The install pitch answers what Connect does. It is spent once the
          runtime is connected, and stays through setup so the download it
          names is the one in progress. */}
      {settingUp && (
        <div className="flex flex-col text-xs text-pretty fg-secondary gap-1">
          <p>
            Connect a separate, tested copy of Cursor for this app. Your
            existing Cursor installation keeps its own updates.
          </p>
          <p>{downloadSize}Your Cursor plan and usage limits apply</p>
        </div>
      )}
      {host.renderFailure({
        source: 'cursor-connection-error',
        testId: 'cursor-connection-error',
        failure: state.failure,
        onDismiss: state.dismissFailure,
        flush: true,
      })}
      {footer}
    </SettingsRowsRow>
  );
}
