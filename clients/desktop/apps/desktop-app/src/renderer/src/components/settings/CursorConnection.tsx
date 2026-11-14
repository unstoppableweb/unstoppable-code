import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { registerCursorSettingsAction } from '@/lib/cursor-settings-actions';
import { useObservabilityStore } from '@/stores/observabilityStore';
import { useEffect, useRef, useState, type JSX } from 'react';
import { useShallow } from 'zustand/shallow';
import { CursorIcon } from '@canopy/ui-shared/icons/AppIcons';
import type {
  CursorAccount,
  CursorAccountIntent,
  CursorConnectionStatus,
} from '@canopy/desktop-shared/types';
import { emitPreferencesUpdated } from '@/lib/preferences-events';
import {
  Button,
  ProviderStatusDot,
  Tooltip,
} from '@canopy/ui-shared/components';
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
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { GrokUnifyHint } from './GrokUnifyHint';
import { ProviderCarryoverNote } from './ProviderCarryoverNote';
import { SettingsGroup, SettingsRow, SettingsSection } from './SettingsLayout';

interface CursorConnectionProps {
  /**
   * `row`: one provider row inside the caller's group, as on Accounts beside
   * Claude and Codex. `section` (default): its own untitled section and box,
   * as on Experiments.
   */
  readonly placement?: 'row' | 'section';
}

export function CursorConnection({
  placement = 'section',
}: CursorConnectionProps = {}): JSX.Element | null {
  const [status, setStatus] = useState<CursorConnectionStatus | null>(null);
  // The subscription comes from the account-usage read the Usage page shares;
  // it is the same source the peer tiles' plan line draws on.
  const usageSummary = useObservabilityStore(
    useShallow((state) =>
      state.usage.providers.find((entry) => entry.provider === 'cursor'),
    ),
  );
  const initializeUsage = useObservabilityStore((state) => state.initialize);
  const refreshUsage = useObservabilityStore(
    (state) => state.refreshProviderUsageDetails,
  );
  const refreshingPlan = useObservabilityStore((state) =>
    state.refreshingProviders.has('cursor'),
  );
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [changingAccount, setChangingAccount] = useState(false);
  // `undefined` while the account has not been read for this connection.
  const [account, setAccount] = useState<CursorAccount | null | undefined>(
    undefined,
  );
  // A read that failed is not a sign-out: the button that state offers signs
  // the shared credential store out, so it must never appear on a guess.
  const [accountUnavailable, setAccountUnavailable] = useState(false);
  // Nothing else changes when the cause of a failed read clears, so the retry
  // affordance re-arms the probe effect itself.
  const [accountAttempt, setAccountAttempt] = useState(0);
  const [error, setError] = useState<InlineFailure | null>(null);
  const connected = Boolean(status?.enabled && status.installed);
  const inProgress = connecting || changingAccount;
  const active = useRef(false);
  const cancelRequested = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const api = window.api.cursorConnection;
    if (!api) return;
    void api
      .status()
      .then((next) => {
        if (mounted.current) setStatus(next);
      })
      .catch((cause: unknown) => {
        reportClientAppError(cause);
      });
    const off = api.onProgress((next) => {
      if (mounted.current && active.current) setStatus(next);
    });
    return (): void => {
      mounted.current = false;
      off();
      if (active.current)
        void api.cancel().catch((cause: unknown) => {
          reportClientAppError(cause);
        });
    };
  }, []);
  // The cheap status read never runs the runtime, so the signed-in account is
  // probed separately once the panel knows the runtime is connected; results
  // that did probe (Connect, Change account) carry the account themselves.
  useEffect(() => {
    const api = window.api.cursorConnection;
    // A setup or an account change owns the CLI while it runs, and its own
    // result carries the account, so probing under it would only fail.
    if (!api || !connected || inProgress || status?.account !== undefined)
      return;
    let current = true;
    void api
      .account()
      .then((next) => {
        if (!current || !mounted.current) return;
        setAccountUnavailable(false);
        setAccount(next);
      })
      .catch((cause: unknown) => {
        // The row shows the failed read with Check again.
        reportClientAppError(cause);
        if (current && mounted.current) setAccountUnavailable(true);
      });
    return (): void => {
      current = false;
    };
  }, [connected, inProgress, status?.account, accountAttempt]);
  useEffect(() => {
    if (status?.account !== undefined) {
      setAccountUnavailable(false);
      setAccount(status.account);
    } else if (!connected) {
      setAccountUnavailable(false);
      setAccount(undefined);
    }
  }, [connected, status?.account]);
  const supported = status?.supported ?? false;
  useEffect(() => {
    if (supported)
      void initializeUsage().catch((cause: unknown) => {
        reportClientAppError(cause);
      });
  }, [supported, initializeUsage]);
  const refreshPreferences = async (): Promise<void> => {
    emitPreferencesUpdated(await window.api.loadPreferences());
  };
  // A new sign-in changes the account and its plan; the usage read is the
  // only thing that knows the plan, and nothing else re-runs it.
  const refreshPlan = (): void => {
    void refreshUsage('cursor').catch((cause: unknown) => {
      reportClientAppError(cause);
    });
  };
  const connect = async (): Promise<void> => {
    const api = window.api.cursorConnection;
    if (!api || active.current) return;
    active.current = true;
    cancelRequested.current = false;
    setBusy(true);
    setConnecting(true);
    setError(null);
    try {
      const next = await api.connect();
      if (mounted.current) setStatus(next);
      await refreshPreferences();
      refreshPlan();
    } catch (cause) {
      if (mounted.current) {
        // An intentional Cancel rejects the connect call; that is not a failure.
        const appError = toAppError(resolveClientAppError(cause));
        if (appError && !cancelRequested.current)
          setError(
            inlineFailureWithMainSentence(appError, "Couldn't connect Cursor."),
          );
        const next = await api.status().catch((statusCause: unknown) => {
          reportClientAppError(statusCause);
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
  const changeAccount = async (intent: CursorAccountIntent): Promise<void> => {
    const api = window.api.cursorConnection;
    if (!api || active.current || !connected) return;
    active.current = true;
    cancelRequested.current = false;
    setBusy(true);
    setChangingAccount(true);
    setError(null);
    try {
      const next = await api.changeAccount(intent);
      if (mounted.current) setStatus(next);
      refreshPlan();
    } catch (cause) {
      if (mounted.current) {
        // Cancel is not a failure, but sign-out already happened: re-read the
        // account so the panel offers sign-in instead of claiming one.
        const appError = toAppError(resolveClientAppError(cause));
        if (appError && !cancelRequested.current)
          setError(
            inlineFailureWithMainSentence(
              appError,
              "Couldn't change the Cursor account.",
            ),
          );
        // A sign-out may already have happened, so stop naming the old
        // account immediately; clearing both re-arms the probe effect, which
        // owns the re-read. A second explicit read here would only race it.
        setAccount(undefined);
        const next = await api.status().catch((statusCause: unknown) => {
          reportClientAppError(statusCause);
          return null;
        });
        if (mounted.current)
          setStatus((prev) =>
            next
              ? { ...next, account: undefined }
              : // Without this the stale account survives on `status`, and the
                // probe effect bails on it forever — no account line, no
                // button, and no way back but leaving the section.
                prev && { ...prev, account: undefined },
          );
        // The sign-out may have run before the cancel, so the plan on record
        // may belong to a session that no longer exists.
        refreshPlan();
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
    const api = window.api.cursorConnection;
    if (!api || active.current) return;
    active.current = true;
    setBusy(true);
    setError(null);
    try {
      await api.disconnect();
      const next = await api.status();
      if (mounted.current) setStatus(next);
      await refreshPreferences();
    } catch (cause) {
      const appError = toAppError(resolveClientAppError(cause));
      if (appError && mounted.current)
        setError(inlineFailure(appError, "Couldn't disconnect Cursor."));
    } finally {
      active.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  // Only a plan read for the signed-in account is shown: the read must name
  // the same address the CLI reports (when both are known), and a refresh in
  // flight hides the line so a previous account's tier is never attributed to
  // a new sign-in, even briefly or after a failed refresh. An `unsupported`
  // read still describes this account (Cursor provided no usage details, not
  // no plan), so it keeps the tier.
  const plan =
    connected &&
    !inProgress &&
    !refreshingPlan &&
    account &&
    usageSummary?.authState === 'authenticated' &&
    (!usageSummary.errorInfo ||
      usageSummary.errorInfo.kind === 'unsupported') &&
    (!usageSummary.accountEmail ||
      !account.email ||
      usageSummary.accountEmail === account.email)
      ? usageSummary.subscriptionLabel
      : undefined;
  // The dot means "signed in", as on the peer tiles: a connected runtime with
  // no session, or one whose session could not be read, is not green. An
  // unanswered read keeps the connected colour rather than flashing red.
  const signedIn = connected && !accountUnavailable && account !== null;
  const cancel = (): void => {
    cancelRequested.current = true;
    void window.api.cursorConnection?.cancel().catch((cause: unknown) => {
      const appError = toAppError(resolveClientAppError(cause));
      if (appError && mounted.current)
        setError(inlineFailure(appError, "Couldn't stop Cursor setup."));
    });
  };
  useCurrentUiStateReporter('settings.cursor', {
    loaded: status !== null,
    supported: status?.supported ?? false,
    enabled: status?.enabled ?? false,
    installed: status?.installed ?? false,
    busy,
    phase: status?.phase ?? 'idle',
    // Only the account identity, never credentials; absent until probed.
    ...(connected && account !== undefined
      ? { signedIn: account !== null, account: account?.email ?? '' }
      : {}),
    errorVisible: error !== null,
  });
  const actionHandler = useRef<(operation: string) => boolean>(() => false);
  actionHandler.current = (operation): boolean => {
    if (!status?.supported) return false;
    if (operation === 'cancel') {
      if (!inProgress) return false;
      cancel();
      return true;
    }
    if (active.current) return false;
    if (operation === 'connect') {
      if (!connected) void connect();
      return true;
    }
    if (operation === 'disconnect') {
      if (status.enabled) void disconnect();
      return true;
    }
    if (operation === 'change-account' || operation === 'sign-in') {
      // Refuse rather than guess: the panel has not established whether there
      // is a session to sign out.
      if (!connected || accountUnavailable || account === undefined)
        return false;
      // The caller names which one it wants, and a mismatch is refused — a
      // dispatched `sign-in` must never sign the shared credential store out.
      const intent: CursorAccountIntent =
        operation === 'sign-in' ? 'sign-in' : 'change';
      if ((intent === 'sign-in') !== (account === null)) return false;
      void changeAccount(intent);
      return true;
    }
    return false;
  };
  // Register once the first status has loaded; progress ticks must not churn
  // the App Advisor registration.
  const loaded = status !== null;
  useEffect(() => {
    if (!loaded) return;
    return registerCursorSettingsAction('cursor.connection', (operation) =>
      actionHandler.current(operation),
    );
  }, [loaded]);
  if (!status?.supported) return null;
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
              ? 'Finish signing in in your browser'
              : changingAccount
                ? // The pre-flight read can take seconds and can refuse, so
                  // this must not claim a sign-out that has not run.
                  'Checking the Cursor sign-in…'
                : 'Preparing Cursor…';
  // The tile shares the Claude and Codex row: mark, name, and status dot as
  // the label, the status lines under it, and one account action on the
  // row's trailing edge. A failed account read offers its retry there
  // instead of a sign-out it cannot justify; an unanswered read offers
  // nothing yet, so the label never names an action the read may contradict.
  const action = settingUp ? (
    <Button
      size="compact"
      data-testid="cursor-connect"
      disabled={busy}
      onClick={(): void => {
        void connect();
      }}
    >
      Connect Cursor
    </Button>
  ) : accountUnavailable ? (
    <Button
      size="compact"
      data-testid="cursor-account-retry"
      disabled={busy}
      onClick={(): void => {
        setAccountUnavailable(false);
        setAccountAttempt((attempt) => attempt + 1);
      }}
    >
      Check again
    </Button>
  ) : account === undefined ? null : (
    // The visible line about this consequence was dropped for parity with
    // the peer rows; the hint keeps the side effect discoverable without a
    // paragraph, since the credential store is shared with the user's own
    // Cursor CLI.
    <Tooltip
      label={
        account === null
          ? "Opens Cursor's sign-in in your browser."
          : "Signs out the Cursor CLI on this computer, then opens Cursor's sign-in in your browser."
      }
      contentClassName="max-w-64 whitespace-normal"
    >
      <Button
        size="compact"
        data-testid="cursor-change-account"
        disabled={busy}
        onClick={(): void => {
          void changeAccount(account === null ? 'sign-in' : 'change');
        }}
      >
        {account === null ? 'Sign in' : 'Change account'}
      </Button>
    </Tooltip>
  );
  const row = (
    <SettingsRow
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
                      <span className={POSTHOG_REPLAY_BLOCK_CLASS}>
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
          {inProgress && (
            <Button
              size="compact"
              variant="secondary"
              data-testid="cursor-connect-cancel"
              onClick={cancel}
            >
              {changingAccount ? 'Cancel' : 'Cancel setup'}
            </Button>
          )}
          {action}
        </>
      }
    >
      {/* Only under a signed-in account: a connected runtime with no account
          is still asked to sign in, and the line must not read as if that
          account's chats were ready. Detail under the row, so the row keeps
          its subtitle short. */}
      {connected &&
        !inProgress &&
        account !== undefined &&
        account !== null && <ProviderCarryoverNote provider="cursor" enabled />}
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
      <DesktopErrorBanner
        errorSource="cursor-connection-error"
        className=""
        error={error?.error}
        {...(error?.details === undefined ? {} : { details: error.details })}
        onDismiss={(): void => setError(null)}
        testId="cursor-connection-error"
      />
      {/* Grok's plans reach this app through a Cursor sign-in, so its hint
          shows wherever, and only where, Cursor can be connected. */}
      <GrokUnifyHint />
    </SettingsRow>
  );
  if (placement === 'row') return row;
  return (
    // Untitled: the row itself names Cursor, so a heading would repeat it.
    <SettingsSection>
      <SettingsGroup>{row}</SettingsGroup>
    </SettingsSection>
  );
}
