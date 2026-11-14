import {
  type JSX,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import type {
  OllamaConnectionMode,
  OllamaConnectionTestResult,
  OllamaDeleteResult,
  OllamaInstallProgress,
  OllamaModelEntry,
  OllamaPullProgress,
  OllamaState,
} from '@canopy/desktop-shared/types';
import {
  DEFAULT_OLLAMA_SERVER_PORT,
  MINIMUM_OLLAMA_SERVER_VERSION,
  REQUIRED_OLLAMA_CAPABILITIES,
  getModelDisplayName,
  isSupportedOllamaModelEntry,
  isOllamaServerVersionCompatible,
} from '@canopy/desktop-shared/types';
import {
  Stack,
  Button,
  Disclosure,
  Notice,
  NoticeButton,
  NoticeList,
  NoticeListItem,
  StatusBadge,
  type StatusBadgeVariant,
  FieldError,
  Surface,
  TextLinkButton,
} from '@canopy/ui-shared/components';
import { formatByteSize, formatDateTime } from '@canopy/ui-shared/lib';
import { brandText } from '@/lib/brand';
import { OllamaIcon } from '@canopy/ui-shared/icons/AppIcons';
import { ProgressBar } from '@canopy/ui-shared/components';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { resolveClientAppError } from '@canopy/desktop-instrumentation/client';
import { toAppError } from '@canopy/protocol/app-errors';
import { DesktopErrorBanner } from '@/components/shared/DesktopErrorBanner';
import { inlineFailure, type InlineFailure } from '@/lib/inline-app-error';
import {
  SettingsGroup,
  SettingsPage,
  SettingsLoading,
  SettingsRadioGroup,
  SettingsRow,
  SettingsSection,
  SettingsTextField,
} from './SettingsLayout';

/** Exact official Ollama download URL opened through the safe external browser. */
const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download';
/** Official manual installation instructions for Linux. */
const OLLAMA_LINUX_DOWNLOAD_URL = 'https://ollama.com/download/linux';
/** The install failure's own sentence; the reason stays behind Copy details. */
const INSTALL_FAILED_MESSAGE = "Couldn't install Ollama.";
/** Official Ollama model list, opened through the safe external browser. */
const OLLAMA_MODEL_LIST_URL = 'https://ollama.com/search';
/** Loopback host used for every localhost-only Ollama connection. */
const OLLAMA_LOOPBACK_HOST = '127.0.0.1';
/** Inline validation message shown when the port input is out of range. */
const INVALID_PORT_MESSAGE = 'Port must be a whole number between 1 and 65535.';

/**
 * Parse a port input string, returning the numeric port when it is a whole
 * number in the inclusive `1..65535` range, or `null` otherwise. Mirrors the
 * backend validation so the inline error and the server agree.
 */
function parsePort(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const port = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }
  return port;
}

type OllamaServerStatus = OllamaState['status'];

function statusLabel(status: OllamaServerStatus): string {
  switch (status) {
    case 'stopped':
      return 'Stopped';
    case 'starting':
      return 'Starting';
    case 'running-managed':
      return 'Running';
    case 'running-external':
      return 'External';
    case 'error':
      return 'Error';
  }
}

function statusBadgeVariant(status: OllamaServerStatus): StatusBadgeVariant {
  switch (status) {
    case 'stopped':
      return 'muted';
    case 'starting':
      return 'warning';
    case 'running-managed':
      return 'success';
    case 'running-external':
      return 'active';
    case 'error':
      return 'destructive';
  }
}

function truncateMiddle(value?: string, keep: number = 10): string | null {
  if (!value) {
    return null;
  }
  if (value.length <= keep * 2 + 3) {
    return value;
  }
  return `${value.slice(0, keep)}...${value.slice(-keep)}`;
}

function getMissingCapabilities(model: OllamaModelEntry): string[] {
  const capabilities = new Set(model.show?.capabilities ?? []);
  return REQUIRED_OLLAMA_CAPABILITIES.filter(
    (capability) => !capabilities.has(capability),
  ).map((capability) => capability);
}

interface PullState {
  model: string;
  status: string;
  completed?: number;
  total?: number;
  done: boolean;
  error?: string;
}

interface OllamaModelCardProps {
  model: OllamaModelEntry;
  deleting: boolean;
  /** Disable the delete action when model management is gated on connectivity. */
  disabled?: boolean;
  onDelete: (modelName: string) => void;
}

/** A labelled block of raw model metadata inside the details disclosure. */
function ModelMetadataBlock({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <div className="font-medium fg-primary">{title}</div>
      {children}
    </div>
  );
}

const MODEL_METADATA_PRE_CLASS_NAME =
  'overflow-x-auto whitespace-pre-wrap font-mono fg-secondary';

/** A metadata text block: a code-sample well inside the model's group. */
function ModelMetadataPre({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <Surface variant="inset" padding="tight">
      <pre
        className={
          className
            ? `${className} ${MODEL_METADATA_PRE_CLASS_NAME}`
            : MODEL_METADATA_PRE_CLASS_NAME
        }
      >
        {children}
      </pre>
    </Surface>
  );
}

/**
 * One installed model as a row of the Installed models group: its name and
 * id with the Delete action on the trailing side, the unsupported-capability
 * notice when it applies, and every other fact behind a details disclosure.
 */
export function OllamaModelCard({
  model,
  deleting,
  disabled = false,
  onDelete,
}: OllamaModelCardProps): JSX.Element {
  const supported = isSupportedOllamaModelEntry(model);
  const missingCapabilities = getMissingCapabilities(model);
  const capabilities = model.show?.capabilities ?? [];
  const displayName = getModelDisplayName(model.id);

  return (
    <SettingsRow
      label={
        <span className="flex min-w-0 items-center gap-2.5">
          <OllamaIcon size="sm" className="shrink-0 fg-secondary" aria-hidden />
          <span className="truncate">{displayName}</span>
        </span>
      }
      description={
        <span className="block truncate pl-6">{model.rawModelId}</span>
      }
      control={
        <Button
          size="compact"
          variant="secondary"
          className="shrink-0"
          onClick={() => onDelete(model.rawModelId)}
          disabled={deleting || disabled}
          aria-label={deleting ? undefined : `Delete ${displayName}`}
          data-testid="ollama-model-delete"
        >
          {deleting ? 'Deleting…' : 'Delete'}
        </Button>
      }
    >
      {!supported && (
        <Notice
          intent="attention"
          role="none"
          title="Hidden from model pickers"
        >
          It does not advertise the required capabilities:{' '}
          {missingCapabilities.join(', ')}.
        </Notice>
      )}

      <Disclosure
        label="Details"
        dataTestId={`ollama-model-details-${model.rawModelId}`}
      >
        <div className="flex flex-col text-xs gap-3">
          <div className="grid gap-x-4 gap-y-1 wrap-anywhere fg-secondary md:grid-cols-2">
            {capabilities.length > 0 && (
              <div className="md:col-span-2">
                Capabilities: {capabilities.join(', ')}
              </div>
            )}
            {model.details?.family && <div>Family: {model.details.family}</div>}
            {model.details?.parameterSize && (
              <div>Parameters: {model.details.parameterSize}</div>
            )}
            {model.details?.quantizationLevel && (
              <div>Quantization: {model.details.quantizationLevel}</div>
            )}
            {model.details?.format && <div>Format: {model.details.format}</div>}
            {model.sizeBytes !== undefined && model.sizeBytes > 0 && (
              <div>
                Size:{' '}
                {formatByteSize(model.sizeBytes, { precision: 'adaptive' })}
              </div>
            )}
            {model.sizeVramBytes !== undefined && model.sizeVramBytes > 0 && (
              <div>
                VRAM:{' '}
                {formatByteSize(model.sizeVramBytes, { precision: 'adaptive' })}
              </div>
            )}
            {model.modifiedAt && (
              <div>Modified: {formatDateTime(model.modifiedAt)}</div>
            )}
            {model.expiresAt && (
              <div>Expires: {formatDateTime(model.expiresAt)}</div>
            )}
            {truncateMiddle(model.digest) && (
              <div>Digest: {truncateMiddle(model.digest)}</div>
            )}
            {model.details?.parentModel && (
              <div>Parent: {model.details.parentModel}</div>
            )}
            {model.details?.families && model.details.families.length > 0 && (
              <div className="md:col-span-2">
                Families: {model.details.families.join(', ')}
              </div>
            )}
          </div>
          {model.show?.system && (
            <ModelMetadataBlock title="System">
              <ModelMetadataPre>{model.show.system}</ModelMetadataPre>
            </ModelMetadataBlock>
          )}
          {model.show?.template && (
            <ModelMetadataBlock title="Template">
              <ModelMetadataPre>{model.show.template}</ModelMetadataPre>
            </ModelMetadataBlock>
          )}
          {model.show?.parameters && (
            <ModelMetadataBlock title="Parameters">
              <ModelMetadataPre>{model.show.parameters}</ModelMetadataPre>
            </ModelMetadataBlock>
          )}
          {model.show?.license && (
            <ModelMetadataBlock title="License">
              <ModelMetadataPre>{model.show.license}</ModelMetadataPre>
            </ModelMetadataBlock>
          )}
          {model.show?.messages && model.show.messages.length > 0 && (
            <ModelMetadataBlock title="Seed messages">
              <Stack gap="inline">
                {model.show.messages.map((message, index) => (
                  <Surface
                    variant="group"
                    size="small"
                    padding="tight"
                    key={`${message.role}-${String(index)}`}
                  >
                    <div className="flex flex-col fg-secondary gap-2">
                      <Stack gap="tight">
                        <div className="font-medium fg-primary">
                          {message.role}
                          {message.toolName ? ` (${message.toolName})` : ''}
                        </div>
                        <div className="whitespace-pre-wrap">
                          {message.content}
                        </div>
                      </Stack>
                      {message.thinking && (
                        <div className="whitespace-pre-wrap fg-tertiary">
                          Thinking: {message.thinking}
                        </div>
                      )}
                    </div>
                  </Surface>
                ))}
              </Stack>
            </ModelMetadataBlock>
          )}
          {model.show?.rawJson && (
            <ModelMetadataBlock title="Raw show() response">
              <ModelMetadataPre className="max-h-80 overflow-auto">
                {model.show.rawJson}
              </ModelMetadataPre>
            </ModelMetadataBlock>
          )}
        </div>
      </Disclosure>
    </SettingsRow>
  );
}

export function OllamaTab(): JSX.Element {
  const [ollamaState, setOllamaState] = useState<OllamaState | null>(null);
  const [portInput, setPortInput] = useState('');
  const [pullInput, setPullInput] = useState('');
  const [pullStates, setPullStates] = useState<Record<string, PullState>>({});
  const [error, setError] = useState<InlineFailure | null>(null);
  const [portError, setPortError] = useState<string | null>(null);
  const [deleteWarning, setDeleteWarning] = useState<{
    model: string;
    blockedByPreferences: string[];
  } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [deletingModel, setDeletingModel] = useState<string | null>(null);
  // Setup / installation UX state.
  const [installProgress, setInstallProgress] =
    useState<OllamaInstallProgress | null>(null);
  const [installing, setInstalling] = useState(false);
  // A failure of the install call itself (the main process reports its own
  // install failures through progress).
  const [installError, setInstallError] = useState<InlineFailure | null>(null);
  // Which one-shot setup action is currently running (for per-button spinners).
  const [busyAction, setBusyAction] = useState<
    'mode' | 'save' | 'browse' | 'redetect' | null
  >(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] =
    useState<OllamaConnectionTestResult | null>(null);

  useCurrentUiStateReporter('settings.ollama', {
    loaded: ollamaState !== null,
    installationReady: ollamaState?.installation.ready ?? false,
    automaticInstallSupported:
      ollamaState?.installation.automaticInstallSupported ?? false,
    installing,
    errorVisible: error !== null || Boolean(ollamaState?.error),
    ...(ollamaState
      ? {
          mode: ollamaState.mode,
          status: ollamaState.status,
          installationSource: ollamaState.installation.source,
          ...(ollamaState.installation.version
            ? { installationVersion: ollamaState.installation.version }
            : {}),
        }
      : {}),
    ...(installProgress ? { installPhase: installProgress.phase } : {}),
  });

  const unsubStatusRef = useRef<(() => void) | null>(null);
  const unsubPullRef = useRef<(() => void) | null>(null);
  const unsubInstallRef = useRef<(() => void) | null>(null);

  // Load initial state
  useEffect(() => {
    void window.api
      .getOllamaState()
      .then((state) => {
        setOllamaState(state);
        setPortInput(String(state.port));
      })
      .catch((err: unknown) => {
        const appError = toAppError(resolveClientAppError(err));
        if (appError)
          setError(inlineFailure(appError, "Couldn't load Ollama settings."));
        setOllamaState({
          port: DEFAULT_OLLAMA_SERVER_PORT,
          status: 'error',
          models: [],
          mode: 'managed',
          installation: {
            platform: window.platform ?? 'darwin',
            ready: false,
            path: null,
            version: null,
            source: 'not-found',
            checkedAt: new Date().toISOString(),
            automaticInstallSupported: false,
          },
        });
        setPortInput(String(DEFAULT_OLLAMA_SERVER_PORT));
      });

    // Subscribe to status updates
    unsubStatusRef.current = window.api.onOllamaStatus((state: OllamaState) => {
      setOllamaState(state);
      setTestResult(null);
    });

    // Subscribe to pull progress
    unsubPullRef.current = window.api.onOllamaPullProgress(
      (progress: OllamaPullProgress) => {
        setPullStates((prev) => ({
          ...prev,
          [progress.model]: {
            model: progress.model,
            status: progress.status,
            completed: progress.completed,
            total: progress.total,
            done: progress.done,
            error: progress.error,
          },
        }));

        // If done, refresh models
        if (progress.done && !progress.error) {
          void window.api
            .refreshOllamaModels()
            .then((state) => {
              setOllamaState(state);
            })
            .catch((err: unknown) => {
              const appError = toAppError(resolveClientAppError(err));
              if (appError)
                setError(
                  inlineFailure(appError, "Couldn't refresh Ollama models."),
                );
            });
        }
      },
    );

    // Subscribe to transient install progress
    unsubInstallRef.current = window.api.onOllamaInstallProgress(
      (progress: OllamaInstallProgress) => {
        setInstallProgress(progress);
        setInstalling(
          progress.phase !== 'success' && progress.phase !== 'failure',
        );
      },
    );

    return (): void => {
      unsubStatusRef.current?.();
      unsubPullRef.current?.();
      unsubInstallRef.current?.();
    };
  }, []);

  // Switch operating mode. Persists immediately with the already-saved port so
  // an unsaved port edit is never committed as a side effect of toggling mode.
  const handleModeChange = useCallback(
    async (nextMode: OllamaConnectionMode): Promise<void> => {
      if (!ollamaState || nextMode === ollamaState.mode) {
        return;
      }
      setError(null);
      setPortError(null);
      setTestResult(null);
      setBusyAction('mode');
      try {
        const state = await window.api.setOllamaConfiguration({
          mode: nextMode,
          port: ollamaState.port,
        });
        setOllamaState(state);
      } catch (err) {
        const appError = toAppError(resolveClientAppError(err));
        if (appError)
          setError(inlineFailure(appError, "Couldn't change the Ollama mode."));
      } finally {
        setBusyAction((current) => (current === 'mode' ? null : current));
      }
    },
    [ollamaState],
  );

  // Persist the current mode and the port input value.
  const handleSave = useCallback(async (): Promise<void> => {
    setError(null);
    setDeleteWarning(null);
    setTestResult(null);
    const port = parsePort(portInput);
    if (port === null) {
      setPortError(INVALID_PORT_MESSAGE);
      return;
    }
    setPortError(null);
    setBusyAction('save');
    try {
      const state = await window.api.setOllamaConfiguration({
        mode: ollamaState?.mode ?? 'managed',
        port,
      });
      setOllamaState(state);
    } catch (err) {
      const appError = toAppError(resolveClientAppError(err));
      if (appError)
        setError(inlineFailure(appError, "Couldn't save Ollama settings."));
    } finally {
      setBusyAction((current) => (current === 'save' ? null : current));
    }
  }, [portInput, ollamaState?.mode]);

  // Read-only probe of the current port input value. Never persists.
  const handleTestConnection = useCallback(async (): Promise<void> => {
    setError(null);
    const port = parsePort(portInput);
    if (port === null) {
      setPortError(INVALID_PORT_MESSAGE);
      return;
    }
    setPortError(null);
    setTesting(true);
    setTestResult(null);
    try {
      const result = await window.api.testOllamaConnection(port);
      setTestResult(result);
    } catch (err) {
      const appError = toAppError(resolveClientAppError(err));
      if (appError)
        setError(
          inlineFailure(appError, "Couldn't test the Ollama connection."),
        );
    } finally {
      setTesting(false);
    }
  }, [portInput]);

  const handleInstall = useCallback(async (): Promise<void> => {
    // Linux installation is intentionally manual; never invoke the installer.
    if (ollamaState?.installation.platform === 'linux') {
      return;
    }
    setError(null);
    setInstallError(null);
    setInstalling(true);
    setInstallProgress({
      phase: 'starting',
      message: 'Preparing to install Ollama…',
    });
    try {
      const state = await window.api.installOllama();
      setOllamaState(state);
      if (state.installation.ready) {
        setInstallProgress(null);
      }
    } catch (err) {
      const appError = toAppError(resolveClientAppError(err));
      if (!appError) {
        setInstallProgress(null);
        return;
      }
      // The install failure banner below shows it.
      setInstallError(inlineFailure(appError, INSTALL_FAILED_MESSAGE));
      setInstallProgress({ phase: 'failure', message: INSTALL_FAILED_MESSAGE });
    } finally {
      setInstalling(false);
    }
  }, [ollamaState?.installation.platform]);

  const handleBrowse = useCallback(async (): Promise<void> => {
    setError(null);
    setBusyAction('browse');
    try {
      const state = await window.api.browseOllamaInstallation();
      setOllamaState(state);
      if (state.installation.ready) {
        setInstallProgress(null);
      }
    } catch (err) {
      const appError = toAppError(resolveClientAppError(err));
      if (appError)
        setError(
          inlineFailure(appError, "Couldn't use the selected Ollama app."),
        );
    } finally {
      setBusyAction((current) => (current === 'browse' ? null : current));
    }
  }, []);

  const handleRedetect = useCallback(async (): Promise<void> => {
    setError(null);
    setBusyAction('redetect');
    try {
      const state = await window.api.redetectOllamaInstallation();
      setOllamaState(state);
      if (state.installation.ready) {
        setInstallProgress(null);
      }
    } catch (err) {
      const appError = toAppError(resolveClientAppError(err));
      if (appError)
        setError(inlineFailure(appError, "Couldn't detect Ollama."));
    } finally {
      setBusyAction((current) => (current === 'redetect' ? null : current));
    }
  }, []);

  const handleDownload = useCallback((): void => {
    void window.api.browser.openExternal({
      url:
        ollamaState?.installation.platform === 'linux'
          ? OLLAMA_LINUX_DOWNLOAD_URL
          : OLLAMA_DOWNLOAD_URL,
    });
  }, [ollamaState?.installation.platform]);

  const handleRefresh = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    setError(null);
    setDeleteWarning(null);
    try {
      const state = await window.api.refreshOllamaModels();
      setOllamaState(state);
    } catch (err) {
      const appError = toAppError(resolveClientAppError(err));
      if (appError)
        setError(inlineFailure(appError, "Couldn't refresh Ollama models."));
    } finally {
      setRefreshing(false);
    }
  }, []);

  const handlePull = useCallback(async (): Promise<void> => {
    const modelName = pullInput.trim();
    if (!modelName) return;
    setError(null);
    setDeleteWarning(null);
    setPullStates((prev) => ({
      ...prev,
      [modelName]: {
        model: modelName,
        status: 'starting',
        done: false,
      },
    }));
    setPullInput('');
    try {
      await window.api.pullOllamaModel({ model: modelName });
    } catch (err) {
      const appError = toAppError(resolveClientAppError(err));
      // The model's own row shows the failure; a cancelled pull just ends.
      const reason = appError
        ? (inlineFailure(appError, `Couldn't pull ${modelName}.`).details ??
          appError.copy.title)
        : undefined;
      setPullStates((prev) => ({
        ...prev,
        [modelName]: {
          ...prev[modelName],
          model: modelName,
          status: appError ? 'error' : 'cancelled',
          done: true,
          ...(reason === undefined ? {} : { error: reason }),
        },
      }));
    }
  }, [pullInput]);

  const handleDelete = useCallback(async (modelName: string): Promise<void> => {
    setError(null);
    setDeleteWarning(null);
    setDeletingModel(modelName);
    try {
      const result: OllamaDeleteResult = await window.api.deleteOllamaModel({
        model: modelName,
      });
      if (!result.ok) {
        setDeleteWarning({
          model: modelName,
          blockedByPreferences: result.blockedByPreferences,
        });
        return;
      }

      setOllamaState(result.state);
    } catch (err) {
      const appError = toAppError(resolveClientAppError(err));
      if (appError)
        setError(inlineFailure(appError, `Couldn't delete ${modelName}.`));
    } finally {
      setDeletingModel((current) => (current === modelName ? null : current));
    }
  }, []);

  if (!ollamaState) {
    return (
      <SettingsPage title="Ollama" dataTestId="ollama-loading">
        <SettingsLoading variant="spinner" />
      </SettingsPage>
    );
  }

  const activePulls = Object.values(pullStates).filter((p) => !p.done);
  const failedPulls = Object.values(pullStates).filter(
    (p) => p.done && p.error,
  );

  const mode = ollamaState.mode;
  const installation = ollamaState.installation;
  const isLinux = installation.platform === 'linux';
  // Effective port used in copy/commands: the current input when valid, else
  // the last-saved port.
  const effectivePort = parsePort(portInput) ?? ollamaState.port;
  const hasUnsavedPort = effectivePort !== ollamaState.port;
  const configuredTestResult =
    !hasUnsavedPort && testResult?.port === ollamaState.port
      ? testResult
      : null;
  const observedServerVersion =
    testResult?.ok === true && testResult.port === effectivePort
      ? testResult.version
      : (ollamaState.serverVersion ??
        (mode === 'managed' ? (installation.version ?? undefined) : undefined));

  // A reachable server: the managed child is up, an external server answered,
  // or the most recent connection test succeeded.
  const serverReachable =
    !hasUnsavedPort &&
    (configuredTestResult
      ? configuredTestResult.ok
      : ollamaState.status === 'running-managed' ||
        ollamaState.status === 'running-external');
  const incompatibleServerVersion =
    typeof observedServerVersion === 'string' &&
    !isOllamaServerVersionCompatible(observedServerVersion);

  // Managed setup is complete once a validated executable is ready; manual
  // setup is "complete" once the external server is reachable.
  const setupComplete =
    (mode === 'managed' ? installation.ready : serverReachable) &&
    !incompatibleServerVersion;
  const modelActionsDisabled = !setupComplete;

  // Managed installation sub-view. Failure is only shown while the installation
  // is not otherwise ready so a stale failure can never mask a later recovery.
  const managedView:
    | 'installing'
    | 'failure'
    | 'incompatible'
    | 'ready'
    | 'not-found' = installing
    ? 'installing'
    : installProgress?.phase === 'failure' && !installation.ready
      ? 'failure'
      : installation.ready
        ? incompatibleServerVersion
          ? 'incompatible'
          : 'ready'
        : installation.version
          ? 'incompatible'
          : 'not-found';
  const installProgressTotalBytes = installProgress?.totalBytes ?? 0;
  const installProgressDeterminate = installProgressTotalBytes > 0;
  const installProgressPercentage = installProgressDeterminate
    ? Math.min(
        100,
        ((installProgress?.downloadedBytes ?? 0) / installProgressTotalBytes) *
          100,
      )
    : 0;

  const manualCommand =
    window.platform === 'win32'
      ? `$env:OLLAMA_HOST="${OLLAMA_LOOPBACK_HOST}:${String(effectivePort)}"; ollama serve`
      : `OLLAMA_HOST=${OLLAMA_LOOPBACK_HOST}:${String(effectivePort)} ollama serve`;

  let emptyStateMessage: string;
  if (mode === 'managed' && !installation.ready) {
    emptyStateMessage = 'Set up Ollama above to view and manage local models.';
  } else if (mode === 'manual' && !serverReachable) {
    emptyStateMessage =
      'Start your external Ollama server and test the connection to view models.';
  } else {
    emptyStateMessage =
      'No models installed. Pull a model below to get started.';
  }

  const installedModelCount = ollamaState.models.length;
  const installedModelsHint =
    installedModelCount === 0
      ? 'Models your Ollama server has downloaded.'
      : `${String(installedModelCount)} ${installedModelCount === 1 ? 'model' : 'models'}`;

  const setupControlsDisabled = installing;
  const pageError: InlineFailure | null =
    error ?? (ollamaState.error ? { error: ollamaState.error } : null);
  const installFailureReason = installProgress?.error ?? installation.error;
  const installFailure: InlineFailure = installError ?? {
    error: INSTALL_FAILED_MESSAGE,
    ...(installFailureReason ? { details: installFailureReason } : {}),
  };

  const installationActions = (
    <>
      <Button
        size="compact"
        variant="secondary"
        onClick={() => {
          void handleBrowse();
        }}
        disabled={busyAction === 'browse'}
        data-testid="ollama-browse"
      >
        Browse…
      </Button>
      <Button
        size="compact"
        variant="secondary"
        onClick={() => {
          void handleRedetect();
        }}
        disabled={busyAction === 'redetect'}
        data-testid="ollama-redetect"
      >
        {isLinux ? 'Refresh detection' : 'Detect again'}
      </Button>
    </>
  );

  return (
    <SettingsPage title="Ollama" dataTestId="settings-tab-ollama">
      <SettingsSection title="Setup" headingId="ollama-setup-heading">
        <DesktopErrorBanner
          errorSource="ollama-page-error"
          className=""
          error={pageError?.error}
          {...(pageError?.details === undefined
            ? {}
            : { details: pageError.details })}
          // The server's own status text can quote paths and output.
          blockMessageFromReplay={error === null}
          testId="ollama-page-error"
        />

        {mode === 'managed' && managedView === 'incompatible' && (
          <Notice
            intent="attention"
            title="Ollama server not supported"
            data-testid="ollama-incompatible"
            actions={
              <>
                <NoticeButton
                  variant="secondary"
                  onClick={() => {
                    void handleRedetect();
                  }}
                  disabled={busyAction === 'redetect'}
                  data-testid="ollama-redetect"
                >
                  Detect again
                </NoticeButton>
                <NoticeButton
                  variant="primary"
                  onClick={handleDownload}
                  data-testid="ollama-download"
                >
                  Download Ollama
                </NoticeButton>
              </>
            }
          >
            Update Ollama {observedServerVersion} to
            {` ${MINIMUM_OLLAMA_SERVER_VERSION}`} or newer to use local models.
          </Notice>
        )}

        {mode === 'managed' && managedView === 'failure' && (
          <DesktopErrorBanner
            errorSource="ollama-install-failure"
            className=""
            error={installFailure.error}
            {...(installFailure.details === undefined
              ? {}
              : { details: installFailure.details })}
            {...(isLinux
              ? {}
              : {
                  onRetry: (): void => {
                    void handleInstall();
                  },
                })}
            testId="ollama-install-failure"
            secondaryAction={
              <>
                <NoticeButton
                  variant="secondary"
                  onClick={() => {
                    void handleBrowse();
                  }}
                  disabled={busyAction === 'browse'}
                  data-testid="ollama-browse"
                >
                  Browse…
                </NoticeButton>
                <NoticeButton
                  variant="secondary"
                  onClick={() => {
                    void handleRedetect();
                  }}
                  disabled={busyAction === 'redetect'}
                  data-testid="ollama-redetect"
                >
                  Detect again
                </NoticeButton>
                {isLinux ? (
                  <NoticeButton
                    variant="primary"
                    onClick={handleDownload}
                    data-testid="ollama-linux-instructions"
                  >
                    Linux installation instructions
                  </NoticeButton>
                ) : null}
              </>
            }
          />
        )}

        {mode === 'manual' && incompatibleServerVersion && (
          <Notice
            intent="attention"
            title="Ollama server not supported"
            data-testid="ollama-incompatible"
            actions={
              <NoticeButton
                variant="primary"
                onClick={handleDownload}
                data-testid="ollama-download"
              >
                Download Ollama
              </NoticeButton>
            }
          >
            Update Ollama {observedServerVersion} to
            {` ${MINIMUM_OLLAMA_SERVER_VERSION}`} or newer to use local models.
          </Notice>
        )}

        <SettingsGroup>
          <SettingsRow label="Mode">
            <SettingsRadioGroup
              name="ollama-mode"
              label="Ollama mode"
              value={mode}
              disabled={setupControlsDisabled}
              dataTestId="ollama-setup"
              onChange={(next) => {
                void handleModeChange(next);
              }}
              options={[
                {
                  value: 'managed',
                  label: `Managed by ${brandText.appName}`,
                  description: `${brandText.appName} starts Ollama when a local model is needed and stops only the server process it started.`,
                  dataTestId: 'ollama-mode-managed',
                },
                {
                  value: 'manual',
                  label: 'Manual server',
                  description: `Run Ollama yourself. ${brandText.appName} connects to your local server and never starts or stops it.`,
                  dataTestId: 'ollama-mode-manual',
                },
              ]}
            />
          </SettingsRow>

          {/* Managed-mode installation states */}
          {mode === 'managed' && managedView === 'installing' && (
            <SettingsRow
              label="Installing Ollama"
              dataTestId="ollama-managed-setup"
            >
              <Stack
                gap="inline"
                data-testid="ollama-install-progress"
                aria-live="polite"
              >
                <ProgressBar
                  value={installProgressPercentage}
                  indeterminate={!installProgressDeterminate}
                  label={installProgress?.message ?? 'Installing Ollama…'}
                />
              </Stack>
            </SettingsRow>
          )}

          {mode === 'managed' && managedView === 'not-found' && (
            <SettingsRow
              label="Ollama isn't installed"
              description={
                isLinux
                  ? 'Install Ollama using the official Linux instructions, then refresh detection.'
                  : 'Install it automatically, or use an existing installation.'
              }
              dataTestId="ollama-managed-setup"
              control={
                <Button
                  size="compact"
                  variant="primary"
                  onClick={
                    isLinux
                      ? handleDownload
                      : () => {
                          void handleInstall();
                        }
                  }
                  data-testid={
                    isLinux ? 'ollama-linux-instructions' : 'ollama-install'
                  }
                >
                  {isLinux
                    ? 'Linux installation instructions'
                    : 'Install Ollama'}
                </Button>
              }
            />
          )}

          {mode === 'managed' && managedView === 'not-found' && (
            <SettingsRow
              label="Existing installation"
              description={
                isLinux
                  ? 'Refresh detection or select the Ollama executable.'
                  : 'Detect Ollama again or select its executable.'
              }
              control={installationActions}
            />
          )}

          {mode === 'managed' && managedView === 'ready' && (
            <SettingsRow
              label={
                <span data-testid="ollama-version">
                  Ollama {installation.version}
                </span>
              }
              description={
                installation.path ? (
                  <code
                    className="block select-all truncate font-mono"
                    title={installation.path}
                    data-testid="ollama-executable-path"
                  >
                    {installation.path}
                  </code>
                ) : undefined
              }
              dataTestId="ollama-managed-setup"
              control={installationActions}
            />
          )}

          {/* Manual-mode instructions */}
          {mode === 'manual' && (
            <SettingsRow
              label="Start the server"
              description="Install Ollama from ollama.com, then launch the Ollama app or run this command."
              dataTestId="ollama-manual-instructions"
              control={
                <Button
                  size="compact"
                  variant="secondary"
                  onClick={handleDownload}
                  data-testid="ollama-download"
                >
                  Download Ollama
                </Button>
              }
            >
              <Surface variant="inset">
                <pre
                  className="overflow-x-auto px-2.5 py-1.5 font-mono text-xs fg-primary"
                  data-testid="ollama-manual-command"
                >
                  {manualCommand}
                </pre>
              </Surface>
              <p className="text-xs text-pretty fg-secondary">
                Ollama normally uses port{' '}
                <code className="font-mono fg-primary">11434</code>. On another
                port, start the server with a matching{' '}
                <code className="font-mono fg-primary">OLLAMA_HOST</code>. Keep
                it running while you use local models.
              </p>
            </SettingsRow>
          )}

          <SettingsRow
            label="Status"
            description={
              ollamaState.refreshedAt
                ? `Last refreshed: ${new Date(ollamaState.refreshedAt).toLocaleTimeString()}`
                : undefined
            }
            control={
              <StatusBadge
                variant={statusBadgeVariant(ollamaState.status)}
                label={statusLabel(ollamaState.status)}
                dataTestId="ollama-status"
              />
            }
          />
        </SettingsGroup>
      </SettingsSection>

      {/* Server port + Save / Test connection */}
      <SettingsSection title="Server" headingId="ollama-server-port-heading">
        <SettingsGroup>
          <SettingsRow
            label="Port"
            htmlFor="ollama-port-input"
            description={
              <>
                {brandText.appName} connects only to{' '}
                <code className="font-mono fg-primary">
                  http://{OLLAMA_LOOPBACK_HOST}:{effectivePort}
                </code>
                . Test connection checks it without saving.
              </>
            }
            control={
              <>
                <SettingsTextField
                  id="ollama-port-input"
                  type="number"
                  width="xs"
                  min={1}
                  max={65535}
                  value={portInput}
                  onChange={(e) => {
                    setPortInput(e.target.value);
                    setPortError(null);
                    setTestResult(null);
                  }}
                  data-testid="ollama-port-input"
                  aria-invalid={portError ? true : undefined}
                  aria-describedby={portError ? 'ollama-port-error' : undefined}
                />
                <Button
                  size="compact"
                  variant="secondary"
                  onClick={() => {
                    void handleSave();
                  }}
                  disabled={busyAction === 'save' || setupControlsDisabled}
                  data-testid="ollama-save"
                >
                  {busyAction === 'save' ? 'Saving…' : 'Save'}
                </Button>
                <Button
                  size="compact"
                  variant="secondary"
                  onClick={() => {
                    void handleTestConnection();
                  }}
                  disabled={testing || setupControlsDisabled}
                  data-testid="ollama-test-connection"
                >
                  {testing ? 'Testing…' : 'Test connection'}
                </Button>
              </>
            }
          >
            {portError && (
              <FieldError
                id="ollama-port-error"
                announce
                data-testid="ollama-port-error"
              >
                {portError}
              </FieldError>
            )}
            <div aria-live="polite" className="contents">
              {testResult &&
                (testResult.ok ? (
                  <p
                    data-testid="ollama-connection-result"
                    role="status"
                    className="text-xs fg-success"
                  >
                    Connected to Ollama
                    {testResult.version ? ` ${testResult.version}` : ''} on port{' '}
                    {testResult.port}.
                  </p>
                ) : (
                  <FieldError
                    id="ollama-connection-result"
                    data-testid="ollama-connection-result"
                  >
                    Couldn&apos;t connect to Ollama on port {testResult.port}.
                    Make sure the Ollama app or <code>ollama serve</code> is
                    running on that port.
                  </FieldError>
                ))}
            </div>
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Models">
        {deleteWarning && (
          <Notice
            intent="attention"
            title={<>Can&apos;t delete {deleteWarning.model} yet.</>}
          >
            Remove it from these settings first:
            <NoticeList>
              {deleteWarning.blockedByPreferences.map((location) => (
                <NoticeListItem key={location}>{location}</NoticeListItem>
              ))}
            </NoticeList>
          </Notice>
        )}
        <SettingsGroup dataTestId="ollama-model-list">
          <SettingsRow
            label="Installed models"
            description={installedModelsHint}
            control={
              <Button
                size="compact"
                variant="secondary"
                onClick={() => {
                  void handleRefresh();
                }}
                disabled={refreshing || modelActionsDisabled}
                data-testid="ollama-refresh-models"
              >
                {refreshing ? 'Refreshing…' : 'Refresh'}
              </Button>
            }
          />
          {ollamaState.models.length === 0 ? (
            <p
              className="flex min-h-10 items-center text-s fg-secondary"
              data-testid="ollama-model-empty"
            >
              {emptyStateMessage}
            </p>
          ) : (
            ollamaState.models.map((model) => (
              <OllamaModelCard
                key={model.id}
                model={model}
                deleting={deletingModel === model.rawModelId}
                disabled={modelActionsDisabled}
                onDelete={(modelName) => {
                  void handleDelete(modelName);
                }}
              />
            ))
          )}
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Pull model">
        <SettingsGroup>
          <SettingsRow
            label="Model name"
            htmlFor="ollama-pull-input"
            description={
              <>
                Find a model in the{' '}
                <TextLinkButton
                  data-testid="ollama-model-list-link"
                  onClick={(): void => {
                    void window.api.browser.openExternal({
                      url: OLLAMA_MODEL_LIST_URL,
                    });
                  }}
                >
                  Ollama model list
                </TextLinkButton>
                , then enter its exact name.
              </>
            }
            control={
              <>
                <SettingsTextField
                  id="ollama-pull-input"
                  type="text"
                  width="md"
                  value={pullInput}
                  onChange={(e) => setPullInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !modelActionsDisabled) {
                      void handlePull();
                    }
                  }}
                  placeholder="model:id"
                  disabled={modelActionsDisabled}
                  data-testid="ollama-pull-input"
                />
                <Button
                  size="compact"
                  variant="secondary"
                  onClick={() => {
                    void handlePull();
                  }}
                  disabled={!pullInput.trim() || modelActionsDisabled}
                  data-testid="ollama-pull-submit"
                >
                  Pull
                </Button>
              </>
            }
          >
            {/* Pull progress */}
            {activePulls.map((pull) => (
              <Stack key={pull.model} gap="inline">
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="truncate font-medium fg-primary">
                    {pull.model}
                  </span>
                  <span className="shrink-0 fg-secondary">{pull.status}</span>
                </div>
                {pull.total != null && pull.total > 0 && (
                  <ProgressBar
                    value={((pull.completed ?? 0) / pull.total) * 100}
                    label={`Pulling ${pull.model}`}
                    hideLabel
                  />
                )}
              </Stack>
            ))}

            {/* Completed pulls with errors */}
            {failedPulls.map((pull) => (
              <DesktopErrorBanner
                errorSource="ollama-tab"
                key={pull.model}
                className=""
                error={`Couldn't pull ${pull.model}.`}
                {...(pull.error ? { details: pull.error } : {})}
              />
            ))}
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>
    </SettingsPage>
  );
}
