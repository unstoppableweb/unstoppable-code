import type { SecureStorageFailure } from '@canopy/execution-engine/types/secure-storage';
import { SecureStorageNotice } from './SecureStorageNotice';
import { unknownSecureStorageFailure } from '@/lib/secureStorageNotice';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type JSX,
  type ReactNode,
} from 'react';
import type {
  AgentProviderAuthStatus,
  AuthTerminalProvider,
  GitHubPermission,
  GitHubPermissionsStatus,
  PermissionState,
} from '@canopy/desktop-shared/types';
import {
  invalidateClaudeAuthStatusCache,
  useClaudeAuthStatus,
} from '@/hooks/useClaudeAuthStatus';
import {
  invalidateCodexAuthStatusCache,
  useCodexAuthStatus,
} from '@/hooks/useCodexAuthStatus';
import {
  invalidateGitHubCliStatusCache,
  useGitHubCliStatus,
} from '@/hooks/useGitHubCliStatus';
import {
  invalidateGitHubPermissionsCache,
  useGitHubPermissions,
} from '@/hooks/useGitHubPermissions';
import { notifyGitHubConnectionChanged } from '@/lib/integrationConnectionEvents';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { subscriptionLabelForPlanType } from '@canopy/protocol/telemetry';
import {
  Stack,
  Button,
  FormField,
  Notice,
  ProviderRowLabel,
  ProviderStatusDot,
  Dot,
  type DotTone,
  ErrorBanner,
  StatusLabel,
  TextInput,
  Heading,
} from '@canopy/ui-shared/components';
import { ClaudeLogo, CodexLogo } from '@canopy/ui-shared/icons';
import {
  EyeIcon,
  EyeOffIcon,
  GitHubIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { brandText } from '@/lib/brand';
import { AuthLoginModal } from '@/components/settings/AuthLoginModal';
import { ProviderCarryoverNote } from '@/components/settings/ProviderCarryoverNote';
import {
  SettingsRow,
  SettingsSegmentedControl,
  SettingsSubRow,
  SettingsTextField,
} from '@/components/settings/SettingsLayout';
import { useObservabilityStore } from '@/stores/observabilityStore';
import { PROVIDER_CONNECTION_STATE_LABELS } from '@/lib/onboarding/provider-connection-status';

const TOKEN_SAVE_DEBOUNCE_MS = 600;

// Shared by every GitHub panel: a reopened panel's read and saves wait behind
// the unmount flush or deferred clear of the panel it replaced, so that write
// cannot land after a newer edit or leave a stale token on screen.
let gitHubPatWriteQueue: Promise<void> = Promise.resolve();

type GitHubAuthMode = 'pat' | 'oauth';

export type AuthProviderId = 'github' | 'codex' | 'claude';

/**
 * `panel` is a standalone block with its own heading, for hosts such as the
 * onboarding wizard. `row` is one settings row for a `SettingsGroup` on
 * Settings → Accounts: mark, name, and status line on the leading side, the
 * sign-in action on the trailing side, and any provider detail under it.
 */
export type ProviderAuthPanelLayout = 'panel' | 'row';

/**
 * How a signed-out Claude or Codex row reads. `error` is the Settings look:
 * a red dot and the provider's error in red. `neutral` is for surfaces where
 * not having the provider is a normal choice, such as the first-run page: a
 * hollow grey ring, a grey status line, and "Connect".
 */
export type ProviderAuthUnauthenticatedTone = 'error' | 'neutral';

interface ProviderAuthPanelProps {
  provider: AuthProviderId;
  /**
   * Notified each time the underlying auth status flips. Onboarding uses
   * this to enable "Continue" once the user is authenticated.
   */
  onStatusChange?: (authenticated: boolean) => void;
  /** Optional dense layout for embedding in narrower modal bodies. */
  compact?: boolean;
  /** Defaults to `panel`; Settings → Accounts passes `row`. */
  layout?: ProviderAuthPanelLayout;
  /**
   * Claude and Codex `row` layout only; GitHub and the `panel` layout ignore
   * it. Defaults to `error`.
   */
  unauthenticatedTone?: ProviderAuthUnauthenticatedTone;
  /**
   * Replaces "Not connected" on a signed-out neutral row with what connecting
   * gets the user. Claude and Codex `row` layout only; GitHub and the `panel`
   * layout ignore it.
   */
  signedOutDescription?: string;
}

export function ProviderAuthPanel({
  provider,
  onStatusChange,
  compact = false,
  layout = 'panel',
  unauthenticatedTone = 'error',
  signedOutDescription,
}: ProviderAuthPanelProps): JSX.Element {
  if (provider === 'github') {
    return (
      <GitHubAuthPanel
        onStatusChange={onStatusChange}
        compact={compact}
        layout={layout}
      />
    );
  }
  if (provider === 'codex') {
    return (
      <TerminalProviderAuthPanel
        provider="codex"
        onStatusChange={onStatusChange}
        compact={compact}
        layout={layout}
        unauthenticatedTone={unauthenticatedTone}
        signedOutDescription={signedOutDescription}
      />
    );
  }
  return (
    <TerminalProviderAuthPanel
      provider="claude"
      onStatusChange={onStatusChange}
      compact={compact}
      layout={layout}
      unauthenticatedTone={unauthenticatedTone}
      signedOutDescription={signedOutDescription}
    />
  );
}

/**
 * Live connection state beside the provider name: green when signed in. The
 * neutral tone draws a signed-out provider as a hollow grey ring instead of
 * a red dot.
 */
function StatusDot({
  ok,
  tone = 'error',
}: {
  ok: boolean;
  tone?: ProviderAuthUnauthenticatedTone;
}): JSX.Element {
  return (
    <ProviderStatusDot
      tone={ok ? 'connected' : tone === 'neutral' ? 'signed-out' : 'failed'}
    />
  );
}

/** Show / hide control for a masked token field. */
function TokenVisibilityButton({
  visible,
  onToggle,
}: {
  visible: boolean;
  onToggle: () => void;
}): JSX.Element {
  return (
    <Button
      size="compact"
      variant="ghost"
      iconOnly
      aria-label={visible ? 'Hide token' : 'Show token'}
      onClick={onToggle}
    >
      {visible ? (
        <EyeOffIcon size={16} aria-hidden />
      ) : (
        <EyeIcon size={16} aria-hidden />
      )}
    </Button>
  );
}

interface TerminalProviderAuthPanelProps {
  provider: 'claude' | 'codex';
  onStatusChange?: (authenticated: boolean) => void;
  compact?: boolean;
  layout: ProviderAuthPanelLayout;
  unauthenticatedTone: ProviderAuthUnauthenticatedTone;
  signedOutDescription?: string;
}

function providerDisplayName(provider: AuthTerminalProvider): string {
  return provider === 'claude' ? 'Claude' : 'Codex';
}

function TerminalProviderAuthPanel({
  provider,
  onStatusChange,
  compact = false,
  layout,
  unauthenticatedTone,
  signedOutDescription,
}: TerminalProviderAuthPanelProps): JSX.Element {
  const [claudeRefreshKey, setClaudeRefreshKey] = useState(0);
  const [codexRefreshKey, setCodexRefreshKey] = useState(0);
  const [loginOpen, setLoginOpen] = useState(false);
  const refreshProviderUsageDetails = useObservabilityStore(
    (s) => s.refreshProviderUsageDetails,
  );

  const claudeStatus = useClaudeAuthStatus(claudeRefreshKey, {
    forceRefreshOnMount: provider === 'claude',
  });
  const codexStatus = useCodexAuthStatus(codexRefreshKey);

  const status: AgentProviderAuthStatus | null =
    provider === 'claude' ? claudeStatus : codexStatus;

  const name = providerDisplayName(provider);
  const loadingText = `Checking ${name} authentication status…`;
  const authenticatedText = `${name} is authenticated and ready.`;
  const unauthenticatedText = `${name} is not authenticated.`;
  const accountLabelPrefix = 'Signed in as';

  const authenticated = status?.authenticated === true;

  // Prefer the friendly full subscription label from the shared plan catalog
  // (e.g. `Claude Max 20x`, `ChatGPT Business`) over the raw provider `detail`
  // string (`claude.ai (max)`, `team`), matching the provider Usage cards. For
  // Claude, `status.planType` is already the tier-enriched plan type. Falls
  // back to `status.detail` for API-key/Bedrock logins with no subscription
  // plan.
  const subscriptionLabel =
    authenticated && status?.planType
      ? subscriptionLabelForPlanType(provider, status.planType)
      : null;
  const planText = subscriptionLabel ?? status?.detail ?? null;
  // Codex reports which ChatGPT workspace the account uses (Codex 0.165+).
  const workspaceName = authenticated ? status?.workspaceName : null;
  // Workspace names can name a person, so replay blocks that part only.
  const detailText: ReactNode =
    planText && workspaceName ? (
      <>
        {planText} ·{' '}
        <span className={POSTHOG_REPLAY_BLOCK_CLASS}>{workspaceName}</span>
      </>
    ) : (
      planText
    );

  useEffect(() => {
    onStatusChange?.(authenticated);
  }, [authenticated, onStatusChange]);

  const handleCloseLoginModal = useCallback((): void => {
    setLoginOpen(false);
    if (provider === 'claude') {
      invalidateClaudeAuthStatusCache();
      setClaudeRefreshKey((k) => k + 1);
    } else {
      invalidateCodexAuthStatusCache();
      setCodexRefreshKey((k) => k + 1);
    }
    void refreshProviderUsageDetails(provider);
  }, [provider, refreshProviderUsageDetails]);

  const loginLabel = status?.authenticated ? 'Change account' : 'Sign in';
  // A sign-in bumps the key, so what carried over is read again for the
  // account that just connected.
  const refreshKey = provider === 'claude' ? claudeRefreshKey : codexRefreshKey;
  const logo =
    provider === 'claude' ? (
      <ClaudeLogo className="h-4 w-4 shrink-0 fg-primary" aria-hidden />
    ) : (
      <CodexLogo className="h-4 w-4 shrink-0 fg-primary" aria-hidden />
    );
  const statusDot = status ? <StatusDot ok={status.authenticated} /> : null;
  const loginModal = loginOpen ? (
    <AuthLoginModal provider={provider} onClose={handleCloseLoginModal} />
  ) : null;

  if (layout === 'row') {
    const neutralTone = unauthenticatedTone === 'neutral';
    // Only a signed-out row changes tone; a signed-in row whose check failed
    // still reads as signed in.
    const neutral = neutralTone && status !== null && !status.authenticated;
    const rowStatusDot = status ? (
      <StatusDot
        ok={status.authenticated}
        tone={neutral ? 'neutral' : 'error'}
      />
    ) : null;
    // One status line: the account and plan when signed in, the provider's
    // own error otherwise.
    let statusLine: ReactNode;
    if (!status) {
      statusLine = 'Checking sign-in…';
    } else if (status.authenticated) {
      // Session replay blocks the account label, not the copy around it.
      const account: ReactNode = status.accountLabel ? (
        <span className={POSTHOG_REPLAY_BLOCK_CLASS}>
          {status.accountLabel}
        </span>
      ) : (
        'Signed in'
      );
      statusLine = detailText ? (
        <>
          {account} · {detailText}
        </>
      ) : (
        account
      );
    } else if (neutral) {
      // Main reports a plain sign-out with a generic "is not authenticated"
      // error, so only a failed check shows the provider's own message. A
      // failed check never shows the description: it is not evidence that
      // the user has no subscription.
      const probeFailed = status.probeFailed === true;
      statusLine = (
        <span className="fg-secondary">
          {probeFailed
            ? status.error || PROVIDER_CONNECTION_STATE_LABELS['not-connected']
            : (signedOutDescription ??
              PROVIDER_CONNECTION_STATE_LABELS['not-connected'])}
        </span>
      );
    } else {
      statusLine = (
        <StatusLabel>{status.error || unauthenticatedText}</StatusLabel>
      );
    }
    return (
      <SettingsRow
        dataTestId={`auth-panel-${provider}`}
        label={
          <ProviderRowLabel icon={logo} name={name} status={rowStatusDot} />
        }
        description={statusLine}
        control={
          <Button
            onClick={(): void => setLoginOpen(true)}
            disabled={status === null}
            data-testid={`auth-panel-${provider}-connect`}
            size="compact"
          >
            {/* A neutral row says Connect while the read runs too, like the
                account row beside it. */}
            {neutralTone && !status?.authenticated ? 'Connect' : loginLabel}
          </Button>
        }
      >
        {/* What carries over from the provider's own setup is detail under
            the row, so the row keeps one subtitle line. */}
        <ProviderCarryoverNote
          provider={provider}
          enabled={authenticated}
          refreshKey={refreshKey}
        />
        {loginModal}
      </SettingsRow>
    );
  }

  const containerSpacing = compact
    ? 'flex flex-col gap-3'
    : 'flex flex-col gap-4 mt-8 first:mt-0';

  return (
    <div className={containerSpacing} data-testid={`auth-panel-${provider}`}>
      <div className="flex items-center gap-2">
        {logo}
        <Heading level={2} variant="section">
          {name}
        </Heading>
        {statusDot}
        <Button
          onClick={(): void => setLoginOpen(true)}
          disabled={status === null}
          data-testid={`auth-panel-${provider}-connect`}
          size="compact"
          className="ml-auto"
        >
          {loginLabel}
        </Button>
      </div>

      {!status && <p className="text-s fg-secondary">{loadingText}</p>}

      {status?.authenticated && (
        <Stack gap="tight">
          <p className="text-s fg-secondary">{authenticatedText}</p>
          {status.accountLabel && (
            <p className="text-s fg-secondary">
              {accountLabelPrefix}{' '}
              <span
                className={`font-medium fg-primary ${POSTHOG_REPLAY_BLOCK_CLASS}`}
              >
                {status.accountLabel}
              </span>
            </p>
          )}
          {detailText && <p className="text-xs fg-secondary">{detailText}</p>}
          <ProviderCarryoverNote
            provider={provider}
            enabled={authenticated}
            refreshKey={refreshKey}
          />
        </Stack>
      )}

      {status && !status.authenticated && (
        <p className="text-s">
          <StatusLabel>{status.error || unauthenticatedText}</StatusLabel>
        </p>
      )}

      {loginModal}
    </div>
  );
}

interface GitHubAuthPanelProps {
  onStatusChange?: (authenticated: boolean) => void;
  compact?: boolean;
  layout: ProviderAuthPanelLayout;
}

function GitHubAuthPanel({
  onStatusChange,
  compact = false,
  layout,
}: GitHubAuthPanelProps): JSX.Element {
  const [ghRefreshKey, setGhRefreshKey] = useState(0);
  const [loginOpen, setLoginOpen] = useState(false);
  const patInputId = useId();

  const ghStatus = useGitHubCliStatus(ghRefreshKey);
  const loading = ghStatus === null;

  // GitHub PAT state
  const [patValue, setPatValue] = useState('');
  const [savedPatValue, setSavedPatValue] = useState('');
  const [patStorageFailure, setPatStorageFailure] =
    useState<SecureStorageFailure | null>(null);
  const [patError, setPatError] = useState<string | null>(null);
  const [patSaving, setPatSaving] = useState(false);
  const patReadFailedRef = useRef(false);
  const [patLoaded, setPatLoaded] = useState(false);
  const [patVisible, setPatVisible] = useState(false);
  const [permissionsKey, setPermissionsKey] = useState(0);
  const patSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestPatRef = useRef(patValue);
  const patEditRevisionRef = useRef(0);
  const patReadRequestRef = useRef(0);
  const patSaveRequestRef = useRef(0);
  // GitHub PAT <-> OAuth toggle state. `mode` is local UI state; the underlying
  // PAT file is the source of truth. Mode is initialised from PAT presence
  // after the initial load, then user-driven from there.
  const [ghMode, setGhMode] = useState<GitHubAuthMode | null>(null);
  // Tracks whether the user just toggled PAT -> OAuth in this session. Set on
  // toggle, cleared if they toggle back. Required so we only deferred-clear
  // the PAT after an *intentional* OAuth switch.
  const switchedFromPatToOauthRef = useRef(false);
  // When `true`, the stored PAT will be cleared on unmount of this panel.
  // Set once OAuth has been validated after the user toggled away from PAT mode.
  const [pendingClearPat, setPendingClearPat] = useState(false);

  // Permissions reflect the currently-selected mode only — the probe never
  // falls back to the other source.
  const permissions = useGitHubPermissions(ghMode, permissionsKey);

  const patAuthenticated =
    patLoaded &&
    !patError &&
    !patSaving &&
    savedPatValue.length > 0 &&
    savedPatValue === patValue;
  const oauthAuthenticated = ghStatus?.authenticated === true;
  const authenticated =
    ghMode === 'pat' ? patAuthenticated : oauthAuthenticated;

  useEffect(() => {
    onStatusChange?.(authenticated);
  }, [authenticated, onStatusChange]);

  const handleCloseLoginModal = useCallback((): void => {
    setLoginOpen(false);
    void window.api
      .refreshGitHubCredentials()
      .then(() => {
        // Notify other surfaces only after the main process has discarded
        // credentials and API results belonging to the previous account.
        notifyGitHubConnectionChanged();
      })
      .catch(() => {
        // Best-effort refresh. The local status probes below still reflect the
        // CLI's current state even if the cache-reset IPC unexpectedly fails.
      })
      .finally(() => {
        invalidateGitHubCliStatusCache();
        setGhRefreshKey((k) => k + 1);
        // Re-probe permissions: a fresh gh CLI login changes the effective
        // token used by `resolveGitHubToken`'s fallback.
        invalidateGitHubPermissionsCache();
        setPermissionsKey((k) => k + 1);
      });
  }, []);

  const loadPatCredential = useCallback(async (): Promise<void> => {
    const editRevision = patEditRevisionRef.current;
    const request = ++patReadRequestRef.current;
    try {
      const token = await gitHubPatWriteQueue.then(() =>
        window.api.loadGitHubPat(),
      );
      if (
        request !== patReadRequestRef.current ||
        editRevision !== patEditRevisionRef.current
      )
        return;
      if (typeof token !== 'string') {
        patReadFailedRef.current = true;
        setPatStorageFailure(
          token.secureStorageFailure ?? unknownSecureStorageFailure('read'),
        );
        setPatError(token.error);
        return;
      }
      const recoveredRead = patReadFailedRef.current;
      patReadFailedRef.current = false;
      setPatStorageFailure(null);
      setPatError(null);
      setPatValue(token);
      setSavedPatValue(token);
      if (recoveredRead) {
        invalidateGitHubPermissionsCache();
        setPermissionsKey((key) => key + 1);
        notifyGitHubConnectionChanged();
      }
    } catch {
      if (
        request !== patReadRequestRef.current ||
        editRevision !== patEditRevisionRef.current
      )
        return;
      patReadFailedRef.current = true;
      setPatStorageFailure(unknownSecureStorageFailure('read'));
      setPatError('Couldn’t read your saved GitHub token. Try again.');
    } finally {
      setPatLoaded(true);
    }
  }, []);

  useEffect(() => {
    void loadPatCredential();
  }, [loadPatCredential]);

  const commitPatCredential = useCallback(
    async (token: string): Promise<void> => {
      const editRevision = patEditRevisionRef.current;
      const request = ++patSaveRequestRef.current;
      const isCurrent = (): boolean =>
        request === patSaveRequestRef.current &&
        editRevision === patEditRevisionRef.current &&
        latestPatRef.current === token;
      setPatSaving(true);
      patReadFailedRef.current = false;
      try {
        const save = gitHubPatWriteQueue.then(() =>
          window.api.saveGitHubPat(token),
        );
        gitHubPatWriteQueue = save.then(
          () => undefined,
          () => undefined,
        );
        const result = await save;
        if (result.success) {
          invalidateGitHubPermissionsCache();
          setPermissionsKey((key) => key + 1);
          notifyGitHubConnectionChanged();
        }
        if (!isCurrent()) return;
        if (!result.success) {
          setPatStorageFailure(
            result.secureStorageFailure ?? unknownSecureStorageFailure('write'),
          );
          setPatError(result.error);
          return;
        }
        setPatStorageFailure(null);
        setPatError(null);
        setSavedPatValue(token);
      } catch {
        if (isCurrent()) {
          setPatStorageFailure(unknownSecureStorageFailure('write'));
          setPatError('Couldn’t save your GitHub token. Try again.');
        }
      } finally {
        if (isCurrent()) setPatSaving(false);
      }
    },
    [],
  );

  const schedulePatSave = useCallback(
    (token: string): void => {
      if (patSaveTimer.current) clearTimeout(patSaveTimer.current);
      patSaveTimer.current = setTimeout(() => {
        patSaveTimer.current = null;
        void commitPatCredential(token);
      }, TOKEN_SAVE_DEBOUNCE_MS);
    },
    [commitPatCredential],
  );

  useEffect(() => {
    latestPatRef.current = patValue;
  }, [patValue]);

  // Initialise the GitHub auth mode once the PAT has loaded. After that the
  // mode is user-driven via the toggle.
  useEffect(() => {
    if (patLoaded && ghMode === null) {
      setGhMode(patValue.length > 0 ? 'pat' : 'oauth');
    }
  }, [patLoaded, patValue, ghMode]);

  // Detect "CLI-managed auth validated" after a PAT -> OAuth toggle. The
  // gh status check already runs with Canopy's PAT injection stripped, so
  // an `authenticated: true` result here means some non-Canopy credential
  // is in effect — either gh's credential store, or an externally-set
  // GH_TOKEN/GITHUB_TOKEN (envOverride). Both qualify: in the env-var case
  // the user has chosen to manage auth themselves and the Login button is
  // hidden anyway, so clearing the stored PAT is the correct cleanup.
  useEffect(() => {
    if (
      ghMode === 'oauth' &&
      switchedFromPatToOauthRef.current &&
      ghStatus?.authenticated &&
      latestPatRef.current.length > 0
    ) {
      setPendingClearPat(true);
    }
  }, [ghMode, ghStatus]);

  const handleGhModeChange = useCallback(
    (next: GitHubAuthMode): void => {
      if (next === ghMode) return;
      if (next === 'oauth' && latestPatRef.current.length > 0) {
        switchedFromPatToOauthRef.current = true;
      } else if (next === 'pat') {
        switchedFromPatToOauthRef.current = false;
        setPendingClearPat(false);
      }
      setGhMode(next);
      // Force a fresh permissions probe against the newly-selected source.
      invalidateGitHubPermissionsCache();
      setPermissionsKey((k) => k + 1);
    },
    [ghMode],
  );

  // Mirror pendingClearPat into a ref so the unmount cleanup reads the
  // latest value (effect closure below captures refs only).
  const pendingClearPatRef = useRef(pendingClearPat);
  useEffect(() => {
    pendingClearPatRef.current = pendingClearPat;
  }, [pendingClearPat]);

  useEffect(() => {
    return (): void => {
      const tokenToFlush = patSaveTimer.current ? latestPatRef.current : null;
      if (patSaveTimer.current) {
        clearTimeout(patSaveTimer.current);
        patSaveTimer.current = null;
      }
      // Deferred PAT clear: only fires when the user toggled PAT -> OAuth in
      // this session AND OAuth was validated (gh CLI reports authed without
      // the Canopy-injected GH_TOKEN). Clearing here also invalidates the
      // env-injection cache via the save handler so subsequent spawns no
      // longer see GH_TOKEN.
      if (tokenToFlush !== null || pendingClearPatRef.current) {
        const queued = gitHubPatWriteQueue.then(async () => {
          const result = await window.api.saveGitHubPat(
            pendingClearPatRef.current ? '' : (tokenToFlush ?? ''),
          );
          if (result.success) notifyGitHubConnectionChanged();
        });
        gitHubPatWriteQueue = queued.catch(() => undefined);
      }
    };
  }, []);

  function handlePatChange(e: ChangeEvent<HTMLInputElement>): void {
    const next = e.target.value;
    patEditRevisionRef.current += 1;
    patReadFailedRef.current = false;
    latestPatRef.current = next;
    setPatSaving(true);
    setPatValue(next);
    schedulePatSave(next);
  }

  const row = layout === 'row';
  const githubIcon = (
    <GitHubIcon size="md" className="shrink-0 fg-primary" aria-hidden />
  );
  const statusDot =
    ghMode === 'pat' ? (
      <StatusDot ok={patAuthenticated} />
    ) : !loading && ghStatus && ghMode === 'oauth' ? (
      <StatusDot ok={ghStatus.authenticated} />
    ) : null;

  // The main action. CLI-managed (OAuth) mode only, and hidden when a
  // GH_TOKEN/GITHUB_TOKEN env var masks the credential store (gh auth login
  // refuses to run).
  const connectButton =
    !loading && ghMode === 'oauth' && !ghStatus?.envOverride ? (
      <Button
        onClick={(): void => setLoginOpen(true)}
        data-testid="auth-panel-github-connect"
        size="compact"
        className={row ? undefined : 'ml-auto'}
      >
        {ghStatus?.authenticated ? 'Change account' : 'Sign in'}
      </Button>
    ) : null;

  const modeControl = (
    <SettingsSegmentedControl
      label="GitHub sign-in method"
      value={ghMode}
      disabled={ghMode === null}
      onChange={handleGhModeChange}
      options={[
        { value: 'oauth', label: 'CLI managed' },
        { value: 'pat', label: 'Personal access token' },
      ]}
    />
  );

  const showEnvOverride =
    ghMode === 'oauth' && !loading && ghStatus?.envOverride === true;
  const envOverrideNotice = showEnvOverride ? (
    <Notice
      intent="attention"
      data-testid="provider-auth-env-override-warning"
      title={
        <>
          <code className="font-mono">
            {ghStatus?.envOverrideName ?? 'GITHUB_TOKEN'}
          </code>{' '}
          is providing the GitHub token.
        </>
      }
    >
      {brandText.appName} uses it for GitHub access, so CLI sign-in can&apos;t
      be changed here. Unset it in your shell to manage sign-in from{' '}
      {brandText.appName}.
    </Notice>
  ) : null;

  const pendingClearNote =
    ghMode === 'oauth' && pendingClearPat ? (
      <p className="text-xs fg-secondary">
        Stored PAT will be removed when you leave Settings.
      </p>
    ) : null;

  const loginModal = loginOpen ? (
    <AuthLoginModal provider="github" onClose={handleCloseLoginModal} />
  ) : null;

  if (row) {
    // Session replay blocks the username, not the copy around it.
    const signedInAsUsername: ReactNode = ghStatus?.username ? (
      <>
        Signed in as{' '}
        <span className={POSTHOG_REPLAY_BLOCK_CLASS}>{ghStatus.username}</span>
      </>
    ) : null;
    let statusLine: ReactNode;
    if (ghMode === 'pat') {
      statusLine = patAuthenticated
        ? 'Using your personal access token'
        : 'Paste a personal access token to connect';
    } else if (ghMode === null || loading) {
      statusLine = 'Checking GitHub CLI status…';
    } else if (ghStatus.envOverride) {
      statusLine =
        signedInAsUsername ??
        `Using ${ghStatus.envOverrideName ?? 'GITHUB_TOKEN'}`;
    } else if (ghStatus.authenticated) {
      statusLine = signedInAsUsername ?? 'Signed in with the GitHub CLI';
    } else {
      statusLine = (
        <StatusLabel>
          {ghStatus.error || 'GitHub CLI is not authenticated.'}
        </StatusLabel>
      );
    }
    return (
      <SettingsRow
        dataTestId="auth-panel-github"
        label={
          <ProviderRowLabel
            icon={githubIcon}
            name="GitHub"
            status={statusDot}
          />
        }
        description={statusLine}
        control={connectButton}
      >
        <SettingsSubRow label="Sign-in method" control={modeControl} />
        {envOverrideNotice}
        {pendingClearNote}
        <SecureStorageNotice
          failure={patStorageFailure}
          retrying={patSaving}
          onRetry={(): void => {
            if (patReadFailedRef.current) void loadPatCredential();
            else void commitPatCredential(latestPatRef.current);
          }}
        />
        {patError && !patStorageFailure && (
          <Notice intent="attention">{patError}</Notice>
        )}
        {ghMode === 'pat' && (
          <SettingsSubRow
            label="Personal access token"
            htmlFor={patInputId}
            control={
              <>
                <SettingsTextField
                  id={patInputId}
                  width="md"
                  type={patVisible ? 'text' : 'password'}
                  value={patValue}
                  onChange={handlePatChange}
                  disabled={!patLoaded}
                  placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                  data-testid="auth-panel-github-pat-input"
                />
                <TokenVisibilityButton
                  visible={patVisible}
                  onToggle={(): void => setPatVisible((prev) => !prev)}
                />
              </>
            }
          />
        )}
        {/* Permissions render in both modes and probe only the selected
            credential source, so scopes stay aligned with the active mode. */}
        {ghMode !== null && (
          <GitHubPermissionsSection permissions={permissions} layout="row" />
        )}
        {loginModal}
      </SettingsRow>
    );
  }

  const containerSpacing = compact
    ? 'flex flex-col gap-3'
    : 'flex flex-col gap-4 mt-8';

  return (
    <div className={containerSpacing} data-testid="auth-panel-github">
      <SecureStorageNotice
        failure={patStorageFailure}
        retrying={patSaving}
        onRetry={(): void => {
          if (patReadFailedRef.current) void loadPatCredential();
          else void commitPatCredential(latestPatRef.current);
        }}
      />
      {patError && !patStorageFailure && (
        <Notice intent="attention">{patError}</Notice>
      )}
      <div className="flex items-center gap-2">
        {githubIcon}
        <Heading level={2} variant="section">
          GitHub
        </Heading>
        {statusDot}
        {/* Primary CTA pinned top-right (matches the other account tiles). */}
        {connectButton}
      </div>

      {/* CLI Managed <-> PAT toggle */}
      {modeControl}

      {/* CLI Managed (OAuth) view */}
      {ghMode === 'oauth' && (
        <Stack gap="item">
          {loading && (
            <p className="text-s fg-secondary">
              Checking GitHub CLI status&hellip;
            </p>
          )}

          {showEnvOverride && ghStatus?.username && (
            <p className="text-s fg-secondary">
              Signed in as{' '}
              <span
                className={`font-medium fg-primary ${POSTHOG_REPLAY_BLOCK_CLASS}`}
              >
                {ghStatus.username}
              </span>
            </p>
          )}
          {envOverrideNotice}

          {!loading && ghStatus?.authenticated && !ghStatus.envOverride && (
            <Stack gap="tight">
              <p className="text-s fg-secondary">
                GitHub CLI is authenticated and ready.
              </p>
              {ghStatus.username && (
                <p className="text-s fg-secondary">
                  Signed in as{' '}
                  <span
                    className={`font-medium fg-primary ${POSTHOG_REPLAY_BLOCK_CLASS}`}
                  >
                    {ghStatus.username}
                  </span>
                </p>
              )}
            </Stack>
          )}

          {!loading &&
            ghStatus &&
            !ghStatus.authenticated &&
            !ghStatus.envOverride && (
              <p className="text-s">
                <StatusLabel>
                  {ghStatus.error || 'GitHub CLI is not authenticated.'}
                </StatusLabel>
              </p>
            )}

          {/* The Login/Change-account CTA lives in the card header (top-right).
              It is hidden there when an env var masks the credential store, since
              `gh auth login` refuses to run while GH_TOKEN/GITHUB_TOKEN is set. */}
          {pendingClearNote}
        </Stack>
      )}

      {/* PAT view */}
      {ghMode === 'pat' && (
        <FormField id={patInputId} label="Personal access token">
          {(control) => (
            <TextInput
              {...control}
              type={patVisible ? 'text' : 'password'}
              mono
              value={patValue}
              onChange={handlePatChange}
              disabled={!patLoaded}
              placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
              data-testid="auth-panel-github-pat-input"
              trailing={
                <Button
                  variant="ghost"
                  size="compact"
                  iconOnly
                  data-settings-control="field"
                  onClick={(): void => setPatVisible((prev) => !prev)}
                  aria-label={patVisible ? 'Hide token' : 'Show token'}
                >
                  {patVisible ? (
                    <EyeOffIcon size={16} aria-hidden />
                  ) : (
                    <EyeIcon size={16} aria-hidden />
                  )}
                </Button>
              }
            />
          )}
        </FormField>
      )}

      {/* Permissions render in both modes and probe only the selected
          credential source, so scopes stay aligned with the active mode. */}
      {ghMode !== null && (
        <GitHubPermissionsSection permissions={permissions} layout="panel" />
      )}

      {loginModal}
    </div>
  );
}

interface GitHubPermissionsSectionProps {
  permissions: GitHubPermissionsStatus | null;
  layout: ProviderAuthPanelLayout;
}

function GitHubPermissionsSection({
  permissions,
  layout,
}: GitHubPermissionsSectionProps): JSX.Element {
  let message: ReactNode = null;
  if (permissions === null) {
    message = 'Checking GitHub permissions…';
  } else if (!permissions.tokenAvailable) {
    message =
      permissions.error ??
      'Add a personal access token or sign in with the GitHub CLI to see permissions.';
  } else if (permissions.tokenType === 'fine-grained') {
    message = (
      <>
        Fine-grained token detected, so scopes can&apos;t be read remotely. Make
        sure it has <span className="font-medium">Contents</span>,{' '}
        <span className="font-medium">Pull requests</span>, and{' '}
        <span className="font-medium">Checks</span> read and write access for
        the repositories you use.
      </>
    );
  }

  const details =
    permissions && permissions.tokenAvailable ? (
      <>
        <ErrorBanner
          errorSource="git-hub-permissions-section"
          className=""
          error={githubPermissionsErrorCopy(permissions.error)}
        />
        <ul
          className="flex flex-col gap-2"
          data-testid="settings-github-permissions-list"
        >
          {permissions.permissions.map((permission) => (
            <PermissionRow key={permission.scope} permission={permission} />
          ))}
        </ul>
      </>
    ) : null;

  if (layout === 'row') {
    return (
      <SettingsSubRow label="Permissions" description={message}>
        {details}
      </SettingsSubRow>
    );
  }

  return (
    <div className="flex flex-col pt-2 gap-2">
      <div className="text-s fg-secondary">Permissions</div>
      {message && <p className="text-xs fg-secondary">{message}</p>}
      {details}
    </div>
  );
}

/**
 * The permissions check's failure in our words: a token rejection is already
 * copy of ours, while any other failure quotes the GitHub API's own text,
 * which settings never show.
 */
function githubPermissionsErrorCopy(error: string | null): string | null {
  if (!error) return null;
  if (error.startsWith('Unable to verify GitHub permissions')) {
    return "Couldn't check GitHub permissions. Try again later.";
  }
  return error;
}

function permissionDotTone(state: PermissionState, required: boolean): DotTone {
  if (state === 'granted') return 'success';
  if (state === 'unknown') return 'filter';
  return required ? 'danger' : 'attention';
}

function permissionStatusLabel(
  state: PermissionState,
  required: boolean,
): string {
  if (state === 'granted') return 'Granted';
  if (state === 'unknown') return 'Unknown';
  return required ? 'Missing' : 'Not granted';
}

interface PermissionRowProps {
  permission: GitHubPermission;
}

/** One scope: its state dot, name, and whether it is required, then why. */
function PermissionRow({ permission }: PermissionRowProps): JSX.Element {
  return (
    <li className="flex items-start gap-2.5">
      <span className="flex h-5 w-2 shrink-0 items-center" aria-hidden="true">
        <Dot
          size="large"
          tone={permissionDotTone(permission.state, permission.required)}
        />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <code className="font-mono text-xs font-medium fg-primary">
            {permission.label}
          </code>
          <span className="text-xs fg-tertiary">
            {permission.required ? 'Required' : 'Optional'}
          </span>
          <span className="ml-auto text-xs fg-secondary">
            {permissionStatusLabel(permission.state, permission.required)}
          </span>
        </div>
        <p className="text-xs fg-secondary">{permission.description}</p>
      </div>
    </li>
  );
}
