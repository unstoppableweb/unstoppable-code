import { DesktopMcpSettingsSection } from './hosted/DesktopMcpSettingsSection';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useEarlyAccessTitle } from '@/lib/earlyAccessTitles';
import { type JSX, useEffect, useRef, useState } from 'react';
import { toAppError } from '@canopy/protocol/app-errors';
import {
  reportClientAppError,
  resolveClientAppError,
} from '@canopy/desktop-instrumentation/client';
import { DesktopErrorBanner } from '@/components/shared/DesktopErrorBanner';
import { inlineFailure, type InlineFailure } from '@/lib/inline-app-error';
import {
  DEFAULT_MCP_HTTP_AUTH_HANDLER,
  DEFAULT_MCP_PROXY_PORT,
  type McpHttpAuthHandler,
  type PreferencesData,
} from '@canopy/desktop-shared/types';
import type {
  McpProxyState,
  McpProxyStatus,
} from '@canopy/execution-engine/types/mcp-servers';
import {
  MCP_HTTP_AUTH_CANOPY_DESCRIPTION,
  MCP_HTTP_AUTH_CANOPY_LABEL,
  MCP_HTTP_AUTH_HEADING,
  mcpHttpAuthHelper,
  MCP_HTTP_AUTH_PROVIDER_DESCRIPTION,
  MCP_HTTP_AUTH_PROVIDER_LABEL,
  MCP_PORT_VALIDATION_ERROR,
  mcpProxyErrorBanner,
  MCP_SAVE_ERROR_FALLBACK,
  MCP_SAVED_TEXT,
  parseMcpProxyPort,
} from './mcp-tab-helpers';
import { Tooltip } from '@canopy/ui-shared';
import {
  Button,
  LoadingButton,
  Skeleton,
  SlowLoadNote,
  StatusBadge,
  type StatusBadgeVariant,
  FieldError,
} from '@canopy/ui-shared/components';
import { useLoadingPhase } from '@canopy/ui-shared/lib';
import {
  SettingsGroup,
  SettingsPage,
  SettingsRadioGroup,
  SettingsRow,
  SettingsSection,
  SettingsTextField,
  type SettingsRadioOption,
} from './SettingsLayout';

function statusLabel(status: McpProxyStatus): string {
  switch (status) {
    case 'stopped':
      return 'Stopped';
    case 'running':
      return 'Running';
    case 'error':
      return 'Error';
  }
}

function statusBadgeVariant(status: McpProxyStatus): StatusBadgeVariant {
  switch (status) {
    case 'stopped':
      return 'muted';
    case 'running':
      return 'success';
    case 'error':
      return 'destructive';
  }
}

type LoadStatus = 'loading' | 'ready' | 'error';

/**
 * A value that has not loaded, in its own slot: hidden for the shared delay
 * so a fast load never flashes, then pulsing. The slot is laid out from the
 * start, so nothing moves when the skeleton or the value arrives. Its child
 * is the value's own control in `Skeleton` with a sample value, so skullet
 * measures it into bars.
 */
function McpLoadingValue({
  shown,
  children,
}: {
  readonly shown: boolean;
  readonly children: JSX.Element;
}): JSX.Element {
  return (
    <span
      aria-hidden="true"
      data-testid="settings-mcp-loading-value"
      className={`flex items-center ${shown ? '' : 'invisible'}`}
    >
      {children}
    </span>
  );
}

type McpAuthOption = SettingsRadioOption<McpHttpAuthHandler>;

const MCP_AUTH_OPTIONS: readonly McpAuthOption[] = [
  {
    value: 'canopy',
    label: MCP_HTTP_AUTH_CANOPY_LABEL,
    dataTestId: 'settings-mcp-auth-canopy',
  },
  {
    value: 'provider',
    label: MCP_HTTP_AUTH_PROVIDER_LABEL,
    dataTestId: 'settings-mcp-auth-provider',
  },
];

/** Offered only while account connections are enabled. */
const MCP_ACCOUNT_AUTH_OPTION: McpAuthOption = {
  value: 'account',
  label: 'Account (via cloud)',
  dataTestId: 'settings-mcp-auth-account',
};

const noop = (): void => undefined;

/**
 * The sample a loading value is measured from: the defaults the page shows
 * when the saved preferences say nothing.
 */
const SAMPLE_MCP_SETTINGS = {
  authHandler: DEFAULT_MCP_HTTP_AUTH_HANDLER,
  authDescription: MCP_HTTP_AUTH_CANOPY_DESCRIPTION,
  port: String(DEFAULT_MCP_PROXY_PORT),
  proxyStatus: 'stopped',
} as const satisfies {
  readonly authHandler: McpHttpAuthHandler;
  readonly authDescription: string;
  readonly port: string;
  readonly proxyStatus: McpProxyStatus;
};

function isValidHandler(value: unknown): value is McpHttpAuthHandler {
  return value === 'canopy' || value === 'provider' || value === 'account';
}

export function McpTab(): JSX.Element {
  const mcpSectionTitle = useEarlyAccessTitle('MCP Servers');
  const accountConnectionsEnabled = useFeatureFlagsStore((state): boolean =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopySharedMcpAccountConnections.key),
  );
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [portInput, setPortInput] = useState<string>(
    String(DEFAULT_MCP_PROXY_PORT),
  );
  const [appliedPort, setAppliedPort] = useState<number>(
    DEFAULT_MCP_PROXY_PORT,
  );
  const [authHandler, setAuthHandler] = useState<McpHttpAuthHandler>(
    DEFAULT_MCP_HTTP_AUTH_HANDLER,
  );
  const [saving, setSaving] = useState<boolean>(false);
  // A failed Apply: our sentence, with the failure's own text behind Copy
  // details (never shown).
  const [applyError, setApplyError] = useState<InlineFailure | null>(null);
  // The port field's own validation, shown under the field.
  const [portError, setPortError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<InlineFailure | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [proxyState, setProxyState] = useState<McpProxyState | null>(null);
  const unsubscribeProxyStatusRef = useRef<(() => void) | null>(null);
  const portLocked = proxyState?.portLocked === true;

  function applyProxyState(state: McpProxyState): void {
    setProxyState(state);
    if (
      state.portLocked &&
      typeof state.port === 'number' &&
      Number.isFinite(state.port)
    ) {
      setPortInput(String(state.port));
    }
  }

  useEffect((): (() => void) => {
    let cancelled = false;
    setStatus('loading');
    void window.api
      .loadPreferences()
      .then((prefs: PreferencesData): void => {
        if (cancelled) return;
        const port =
          typeof prefs.mcpProxyPort === 'number' &&
          Number.isFinite(prefs.mcpProxyPort)
            ? prefs.mcpProxyPort
            : DEFAULT_MCP_PROXY_PORT;
        setPortInput(String(port));
        setAppliedPort(port);
        const handler = isValidHandler(prefs.mcpHttpAuthDefaultHandler)
          ? prefs.mcpHttpAuthDefaultHandler
          : DEFAULT_MCP_HTTP_AUTH_HANDLER;
        setAuthHandler(handler);
        setStatus('ready');
      })
      .catch((error: unknown): void => {
        if (cancelled) return;
        setPortInput(String(DEFAULT_MCP_PROXY_PORT));
        setAppliedPort(DEFAULT_MCP_PROXY_PORT);
        setAuthHandler(DEFAULT_MCP_HTTP_AUTH_HANDLER);
        setStatus('error');
        const appError = toAppError(resolveClientAppError(error));
        if (appError)
          setLoadError(
            inlineFailure(
              appError,
              "Couldn't load MCP proxy settings. Defaults are shown.",
            ),
          );
      });

    void window.mcpServers
      .getProxyState()
      .then((state: McpProxyState): void => {
        if (cancelled) return;
        applyProxyState(state);
      })
      .catch((error: unknown): void => {
        // Non-fatal — UI falls back to "no state" placeholder.
        reportClientAppError(error);
      });

    unsubscribeProxyStatusRef.current = window.mcpServers.onProxyStatus(
      (state: McpProxyState): void => {
        applyProxyState(state);
      },
    );

    return (): void => {
      cancelled = true;
      unsubscribeProxyStatusRef.current?.();
      unsubscribeProxyStatusRef.current = null;
    };
  }, []);

  async function applySettings(port: number): Promise<void> {
    setSuccessMessage(null);
    setApplyError(null);
    setPortError(null);
    setSaving(true);
    try {
      const state = await window.mcpServers.applyProxyPort(port);
      await window.api.savePreferences({
        mcpHttpAuthDefaultHandler: authHandler,
      });
      applyProxyState(state);
      setAppliedPort(port);
      setSuccessMessage(MCP_SAVED_TEXT);
    } catch (err: unknown) {
      const appError = toAppError(resolveClientAppError(err));
      if (appError)
        setApplyError(inlineFailure(appError, MCP_SAVE_ERROR_FALLBACK));
    } finally {
      setSaving(false);
    }
  }

  async function handleApply(): Promise<void> {
    const parsed = parseMcpProxyPort(portInput);
    if (parsed === null) {
      setSuccessMessage(null);
      setApplyError(null);
      setPortError(MCP_PORT_VALIDATION_ERROR);
      return;
    }
    await applySettings(parsed);
  }

  async function handleReset(): Promise<void> {
    setPortInput(String(DEFAULT_MCP_PROXY_PORT));
    await applySettings(DEFAULT_MCP_PROXY_PORT);
  }

  function handleAuthHandlerChange(next: McpHttpAuthHandler): void {
    setAuthHandler(next);
    setSuccessMessage(null);
    setApplyError(null);
  }

  // While the saved values load, the page keeps its headings and labels and
  // only the values pulse (after the shared delay); the values replace them
  // in place.
  const loading = status === 'loading';
  const loadingPhase = useLoadingPhase(loading);
  const skeletonShown = loadingPhase === 'skeleton' || loadingPhase === 'slow';

  const authOptions = accountConnectionsEnabled
    ? [...MCP_AUTH_OPTIONS, MCP_ACCOUNT_AUTH_OPTION]
    : MCP_AUTH_OPTIONS;
  const inputPort = parseMcpProxyPort(portInput);
  const showReset =
    !portLocked &&
    (appliedPort !== DEFAULT_MCP_PROXY_PORT ||
      inputPort !== DEFAULT_MCP_PROXY_PORT);
  const { error: proxyError, details: proxyErrorDetails } = mcpProxyErrorBanner(
    applyError,
    proxyState,
  );

  return (
    <SettingsPage title="MCP servers" dataTestId="settings-tab-mcp">
      {loading && (
        <span className="sr-only" role="status">
          Loading
        </span>
      )}
      <DesktopErrorBanner
        errorSource="settings-mcp-load-error"
        className=""
        error={loadError?.error}
        {...(loadError?.details === undefined
          ? {}
          : { details: loadError.details })}
        testId="settings-mcp-load-error"
      />
      <DesktopMcpSettingsSection />

      <SettingsSection
        title={MCP_HTTP_AUTH_HEADING}
        description={mcpHttpAuthHelper(mcpSectionTitle)}
      >
        <SettingsGroup>
          <SettingsRow
            label="Default auth path"
            description={
              loading ? (
                <McpLoadingValue shown={skeletonShown}>
                  <Skeleton
                    loading
                    label="Loading auth path"
                    className="w-full"
                  >
                    <span>{SAMPLE_MCP_SETTINGS.authDescription}</span>
                  </Skeleton>
                </McpLoadingValue>
              ) : (
                <span data-testid="settings-mcp-auth-description">
                  {authHandler === 'account'
                    ? 'Uses your connected cloud account through the local proxy.'
                    : authHandler === 'canopy'
                      ? MCP_HTTP_AUTH_CANOPY_DESCRIPTION
                      : MCP_HTTP_AUTH_PROVIDER_DESCRIPTION}
                </span>
              )
            }
          >
            {loading ? (
              <McpLoadingValue shown={skeletonShown}>
                <Skeleton loading label="Loading auth path" className="w-full">
                  <SettingsRadioGroup
                    name="settings-mcp-auth-handler-sample"
                    label="Default auth path"
                    value={SAMPLE_MCP_SETTINGS.authHandler}
                    options={authOptions}
                    onChange={noop}
                  />
                </Skeleton>
              </McpLoadingValue>
            ) : (
              <SettingsRadioGroup
                name="settings-mcp-auth-handler"
                label="Default auth path"
                value={authHandler}
                options={authOptions}
                onChange={handleAuthHandlerChange}
                dataTestId="settings-mcp-auth-pill"
              />
            )}
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="Local HTTP proxy"
        description={`Used for HTTP MCP servers when the auth path is ${MCP_HTTP_AUTH_CANOPY_LABEL}. It only listens on 127.0.0.1.`}
      >
        <SettingsGroup>
          <SettingsRow
            label="Proxy port"
            htmlFor="settings-mcp-port-input"
            description={
              portLocked ? (
                <span data-testid="settings-mcp-port-locked">
                  The proxy port has been locked by app setup.
                </span>
              ) : undefined
            }
            control={
              loading ? (
                <McpLoadingValue shown={skeletonShown}>
                  <Skeleton loading label="Loading proxy port">
                    <span className="flex items-center gap-2">
                      <SettingsTextField
                        type="number"
                        width="xs"
                        value={SAMPLE_MCP_SETTINGS.port}
                        readOnly
                      />
                      <Button size="compact" variant="secondary">
                        Apply
                      </Button>
                    </span>
                  </Skeleton>
                </McpLoadingValue>
              ) : (
                <>
                  <SettingsTextField
                    id="settings-mcp-port-input"
                    type="number"
                    width="xs"
                    min={1}
                    max={65535}
                    value={portInput}
                    disabled={portLocked}
                    onChange={(
                      e: React.ChangeEvent<HTMLInputElement>,
                    ): void => {
                      setPortInput(e.target.value);
                      setSuccessMessage(null);
                      setApplyError(null);
                      setPortError(null);
                    }}
                    aria-invalid={portError !== null ? true : undefined}
                    aria-describedby={
                      portError !== null ? 'settings-mcp-port-error' : undefined
                    }
                    data-testid="settings-mcp-port-input"
                  />
                  {showReset && (
                    <Tooltip label="Reset proxy port to default">
                      <Button
                        size="compact"
                        variant="secondary"
                        onClick={(): void => {
                          void handleReset();
                        }}
                        disabled={saving}
                        data-testid="settings-mcp-reset"
                      >
                        Reset
                      </Button>
                    </Tooltip>
                  )}
                  <LoadingButton
                    size="compact"
                    variant="secondary"
                    onClick={(): void => {
                      void handleApply();
                    }}
                    loading={saving}
                    loadingLabel="Applying…"
                    data-testid="settings-mcp-save"
                  >
                    Apply
                  </LoadingButton>
                </>
              )
            }
          >
            {/* Inline under the port, like the Display tab's save error, so
                an Apply result never moves the Apply button. */}
            {successMessage !== null && (
              <p
                className="text-xs fg-success"
                data-testid="settings-mcp-saved"
              >
                {successMessage}
              </p>
            )}
            {portError !== null && (
              <FieldError
                id="settings-mcp-port-error"
                announce
                data-testid="settings-mcp-port-error"
              >
                {portError}
              </FieldError>
            )}
            <DesktopErrorBanner
              errorSource="settings-mcp-error"
              className=""
              error={proxyError}
              testId="settings-mcp-error"
              {...(proxyErrorDetails ? { details: proxyErrorDetails } : {})}
            />
          </SettingsRow>

          {loading && proxyState === null && (
            <SettingsRow
              label="Status"
              dataTestId="settings-mcp-proxy-status-loading"
              control={
                <McpLoadingValue shown={skeletonShown}>
                  <Skeleton loading label="Loading proxy status">
                    <StatusBadge
                      variant={statusBadgeVariant(
                        SAMPLE_MCP_SETTINGS.proxyStatus,
                      )}
                      label={statusLabel(SAMPLE_MCP_SETTINGS.proxyStatus)}
                    />
                  </Skeleton>
                </McpLoadingValue>
              }
            />
          )}
          {proxyState && (
            <SettingsRow
              label="Status"
              dataTestId="settings-mcp-proxy-status"
              description={
                proxyState.refreshedAt
                  ? `Last refreshed ${new Date(
                      proxyState.refreshedAt,
                    ).toLocaleTimeString()}`
                  : undefined
              }
              control={
                <StatusBadge
                  variant={statusBadgeVariant(proxyState.status)}
                  label={statusLabel(proxyState.status)}
                />
              }
            />
          )}
        </SettingsGroup>
      </SettingsSection>
      {loading && (
        <SlowLoadNote show={loadingPhase === 'slow'}>
          Still loading MCP settings…
        </SlowLoadNote>
      )}
    </SettingsPage>
  );
}
