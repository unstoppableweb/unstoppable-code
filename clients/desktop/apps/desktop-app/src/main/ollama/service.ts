import {
  observeProviderConnection,
  withProviderConnectionAttempt,
  recordProviderConnectionFailure,
  classifyConnectionFailure,
} from '../lib/provider-connection-events';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Ollama } from 'ollama';
import { BRAND } from '@canopy/brand/current';
import type {
  ListResponse,
  Message,
  ModelDetails,
  ProgressResponse,
  ShowResponse,
} from 'ollama';
import {
  registerCanopyProcess,
  reserveLoopbackPort,
} from '../lib/loopback-listeners';
import {
  DEFAULT_OLLAMA_SERVER_PORT,
  OLLAMA_SERVER_UNAVAILABLE_ERROR_CODE,
  OLLAMA_SERVER_UNAVAILABLE_ERROR_NAME,
  MINIMUM_OLLAMA_SERVER_VERSION,
  MINIMUM_OLLAMA_RESPONSES_VERSION,
  isOllamaServerVersionCompatible,
  isOllamaResponsesVersionCompatible,
  isSupportedOllamaModelEntry,
  initOllamaModels,
  toOllamaModelId,
  type OllamaModelDetails,
  type OllamaConfigurationUpdate,
  type OllamaConnectionTestResult,
  type OllamaConnectionTestOptions,
  type OllamaInstallationStatus,
  type OllamaModelEntry,
  type OllamaPullProgress,
  type OllamaState,
} from '@canopy/desktop-shared/types';
import { isOllamaSupportedOnPlatform } from '@canopy/desktop-shared/platform-capabilities';
import { getOllamaModelCacheFilePath } from '../lib/paths';
import { getEnhancedEnv } from '../pipelines/config-paths';
import {
  readOllamaPreferences,
  writeOllamaConfigurationPreference,
} from './preferences';
import {
  cleanupOllamaInstallationWork,
  createUnavailableOllamaInstallationStatus,
  detectOllamaInstallation,
  installOllama,
  validateOllamaExecutable,
} from './installation';

const OLLAMA_STARTUP_TIMEOUT_MS = 30_000;
const OLLAMA_PROBE_TIMEOUT_MS = 1_500;
const MANAGED_SHUTDOWN_TIMEOUT_MS = 5_000;
export const OLLAMA_UNSUPPORTED_PLATFORM_MESSAGE =
  "Ollama isn't available on this platform.";

export class OllamaServerUnavailableError extends Error {
  public readonly code = OLLAMA_SERVER_UNAVAILABLE_ERROR_CODE;
  // `declare`: only some programs' libs (via type-fest) give Error a `cause`.
  declare public readonly cause: unknown;

  public constructor(message: string, cause?: unknown) {
    super(message);
    this.name = OLLAMA_SERVER_UNAVAILABLE_ERROR_NAME;
    this.cause = cause;
  }
}

type OllamaOwnership = 'none' | 'managed' | 'external';

interface OllamaModelCachePortEntry {
  refreshedAt: string;
  models: OllamaModelEntry[];
}

interface OllamaModelCacheFile {
  version: 1;
  byPort: Record<string, OllamaModelCachePortEntry>;
}

interface OllamaBroadcastHandlers {
  status?: (state: OllamaState) => void;
  pullProgress?: (progress: OllamaPullProgress) => void;
  installProgress?: Parameters<typeof installOllama>[0];
  modelRegistryUpdated?: () => void;
}

export interface OllamaService {
  initialize(): Promise<void>;
  getState(): Promise<OllamaState>;
  getCachedModels(): OllamaModelEntry[];
  broadcastModelRegistryUpdated(): void;
  refreshModels(opts?: { allowStart?: boolean }): Promise<OllamaState>;
  pullModel(rawModelId: unknown): Promise<OllamaState>;
  deleteModel(rawModelId: unknown): Promise<OllamaState>;
  setPort(port: number): Promise<OllamaState>;
  setConfiguration(update: OllamaConfigurationUpdate): Promise<OllamaState>;
  redetectInstallation(options?: { force?: boolean }): Promise<OllamaState>;
  setExecutablePath(path: string): Promise<OllamaState>;
  install(
    onProgress?: Parameters<typeof installOllama>[0],
  ): Promise<OllamaState>;
  testConnection(
    port?: number,
    options?: OllamaConnectionTestOptions,
  ): Promise<OllamaConnectionTestResult>;
  handleUserEnvironmentChanged(): Promise<void>;
  ensureServerRunning(
    reason:
      | 'chat'
      | 'helper'
      | 'pipeline'
      | 'settings-refresh'
      | 'pull'
      | 'delete',
  ): Promise<void>;
  shutdown(reason: 'port-changed' | 'app-quit'): Promise<void>;
  assertInstalled(rawModelId: unknown): Promise<void>;
  assertAnthropicCompatibleApi(): Promise<void>;
  assertResponsesCompatibleApi(): Promise<void>;
}

function buildOllamaHost(port: number): string {
  return `http://127.0.0.1:${String(port)}`;
}

function normalizePort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Ollama port must be an integer between 1 and 65535.');
  }
  return port;
}

function normalizeMode(
  mode: OllamaConfigurationUpdate['mode'],
): OllamaState['mode'] {
  if (mode !== 'managed' && mode !== 'manual') {
    throw new Error('Invalid Ollama connection mode.');
  }
  return mode;
}

function cloneModelEntry(entry: OllamaModelEntry): OllamaModelEntry {
  return {
    ...entry,
    ...(entry.details
      ? {
          details: {
            ...entry.details,
            ...(entry.details.families
              ? { families: [...entry.details.families] }
              : {}),
          },
        }
      : {}),
    ...(entry.show
      ? {
          show: {
            ...entry.show,
            ...(entry.show.capabilities
              ? { capabilities: [...entry.show.capabilities] }
              : {}),
            ...(entry.show.messages
              ? {
                  messages: entry.show.messages.map((message) => ({
                    ...message,
                  })),
                }
              : {}),
          },
        }
      : {}),
  };
}

function cloneModels(models: OllamaModelEntry[]): OllamaModelEntry[] {
  return models.map(cloneModelEntry);
}

function cloneState(state: OllamaState): OllamaState {
  return {
    ...state,
    models: cloneModels(state.models),
    installation: { ...state.installation },
  };
}

/** Seeds a minimal status until the first installation detection pass. */
function createInitialOllamaInstallationStatus(): OllamaInstallationStatus {
  return {
    platform: process.platform,
    ready: false,
    path: null,
    version: null,
    source: 'not-found',
    checkedAt: new Date().toISOString(),
    automaticInstallSupported: false,
  };
}

function installationRuntimeChanged(
  current: OllamaInstallationStatus,
  next: OllamaInstallationStatus,
): boolean {
  return (
    current.ready !== next.ready ||
    current.path !== next.path ||
    current.version !== next.version
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeModelName(rawModelId: unknown): string {
  if (typeof rawModelId !== 'string') {
    throw new Error('Model name is required');
  }

  const model = rawModelId.trim();
  if (model.length === 0) {
    throw new Error('Model name is required');
  }

  return model;
}

function isOllamaModelEntry(value: unknown): value is OllamaModelEntry {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === 'string' &&
    typeof value.rawModelId === 'string' &&
    typeof value.label === 'string' &&
    (value.sizeBytes === undefined || typeof value.sizeBytes === 'number') &&
    (value.modifiedAt === undefined || typeof value.modifiedAt === 'string') &&
    (value.digest === undefined || typeof value.digest === 'string') &&
    (value.expiresAt === undefined || typeof value.expiresAt === 'string') &&
    (value.sizeVramBytes === undefined ||
      typeof value.sizeVramBytes === 'number') &&
    (value.details === undefined || isOllamaModelDetails(value.details)) &&
    (value.show === undefined || isOllamaShowInfo(value.show))
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}

function isOllamaModelDetails(value: unknown): value is OllamaModelDetails {
  return (
    isRecord(value) &&
    (value.parentModel === undefined ||
      typeof value.parentModel === 'string') &&
    (value.format === undefined || typeof value.format === 'string') &&
    (value.family === undefined || typeof value.family === 'string') &&
    (value.families === undefined || isStringArray(value.families)) &&
    (value.parameterSize === undefined ||
      typeof value.parameterSize === 'string') &&
    (value.quantizationLevel === undefined ||
      typeof value.quantizationLevel === 'string')
  );
}

function isOllamaShowMessageEntry(
  value: unknown,
): value is NonNullable<
  NonNullable<OllamaModelEntry['show']>['messages']
>[number] {
  return (
    isRecord(value) &&
    typeof value.role === 'string' &&
    typeof value.content === 'string' &&
    (value.thinking === undefined || typeof value.thinking === 'string') &&
    (value.toolName === undefined || typeof value.toolName === 'string')
  );
}

function isOllamaShowInfo(
  value: unknown,
): value is NonNullable<OllamaModelEntry['show']> {
  return (
    isRecord(value) &&
    (value.capabilities === undefined || isStringArray(value.capabilities)) &&
    (value.license === undefined || typeof value.license === 'string') &&
    (value.parameters === undefined || typeof value.parameters === 'string') &&
    (value.template === undefined || typeof value.template === 'string') &&
    (value.system === undefined || typeof value.system === 'string') &&
    (value.messages === undefined ||
      (Array.isArray(value.messages) &&
        value.messages.every((entry) => isOllamaShowMessageEntry(entry)))) &&
    (value.modelInfoJson === undefined ||
      typeof value.modelInfoJson === 'string') &&
    (value.projectorInfoJson === undefined ||
      typeof value.projectorInfoJson === 'string') &&
    (value.rawJson === undefined || typeof value.rawJson === 'string')
  );
}

function isOllamaModelCachePortEntry(
  value: unknown,
): value is OllamaModelCachePortEntry {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.refreshedAt === 'string' &&
    Array.isArray(value.models) &&
    value.models.every((entry) => isOllamaModelEntry(entry))
  );
}

function normalizeCacheFile(value: unknown): OllamaModelCacheFile {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.byPort)) {
    return {
      version: 1,
      byPort: {},
    };
  }

  const byPort: Record<string, OllamaModelCachePortEntry> = {};
  for (const [port, entry] of Object.entries(value.byPort)) {
    if (isOllamaModelCachePortEntry(entry)) {
      byPort[port] = {
        refreshedAt: entry.refreshedAt,
        models: cloneModels(entry.models),
      };
    }
  }

  return {
    version: 1,
    byPort,
  };
}

function serializeModifiedAt(
  value: string | Date | undefined,
): string | undefined {
  if (typeof value === 'string') {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return undefined;
}

function normalizeModelDetails(
  value: ModelDetails | undefined,
): OllamaModelDetails | undefined {
  if (!value) {
    return undefined;
  }

  return {
    ...(value.parent_model ? { parentModel: value.parent_model } : {}),
    ...(value.format ? { format: value.format } : {}),
    ...(value.family ? { family: value.family } : {}),
    ...(Array.isArray(value.families) && value.families.length > 0
      ? { families: [...value.families] }
      : {}),
    ...(value.parameter_size ? { parameterSize: value.parameter_size } : {}),
    ...(value.quantization_level
      ? { quantizationLevel: value.quantization_level }
      : {}),
  };
}

function serializeJson(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return undefined;
  }
}

function normalizeShowMessages(
  messages: Message[] | undefined,
): NonNullable<OllamaModelEntry['show']>['messages'] | undefined {
  if (!messages || messages.length === 0) {
    return undefined;
  }

  return messages.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.thinking ? { thinking: message.thinking } : {}),
    ...(message.tool_name ? { toolName: message.tool_name } : {}),
  }));
}

function buildBaseCacheEntry(
  list: ListResponse,
  refreshedAt: string,
): OllamaModelCachePortEntry {
  return {
    refreshedAt,
    models: list.models.map((model) => {
      const modifiedAt = serializeModifiedAt(model.modified_at);
      const expiresAt = serializeModifiedAt(model.expires_at);
      const details = normalizeModelDetails(model.details);
      return {
        id: toOllamaModelId(model.model),
        rawModelId: model.model,
        label: model.model,
        sizeBytes: model.size,
        digest: model.digest,
        sizeVramBytes: model.size_vram,
        ...(modifiedAt ? { modifiedAt } : {}),
        ...(expiresAt ? { expiresAt } : {}),
        ...(details ? { details } : {}),
      };
    }),
  };
}

function mergeShowMetadata(
  list: ListResponse,
  refreshedAt: string,
  showByModel: Map<
    string,
    {
      show: NonNullable<OllamaModelEntry['show']>;
      details?: OllamaModelDetails;
    }
  >,
): OllamaModelCachePortEntry {
  const base = buildBaseCacheEntry(list, refreshedAt);
  return {
    refreshedAt: base.refreshedAt,
    models: base.models.map((entry) => {
      const showData:
        | {
            show: NonNullable<OllamaModelEntry['show']>;
            details?: OllamaModelDetails;
          }
        | undefined = showByModel.get(entry.rawModelId);
      if (!showData) {
        return entry;
      }

      return {
        ...entry,
        ...(showData.details ? { details: showData.details } : {}),
        show: showData.show,
      };
    }),
  };
}

function normalizeShowData(show: ShowResponse): {
  show: NonNullable<OllamaModelEntry['show']>;
  details?: OllamaModelDetails;
} {
  const showDetails = normalizeModelDetails(show.details);
  const messages = normalizeShowMessages(show.messages);
  const modelInfoJson = serializeJson(show.model_info);
  const projectorInfoJson = serializeJson(show.projector_info);
  const rawJson = serializeJson(show);

  return {
    ...(showDetails ? { details: showDetails } : {}),
    show: {
      ...(Array.isArray(show.capabilities) && show.capabilities.length > 0
        ? { capabilities: [...show.capabilities] }
        : {}),
      ...(show.license ? { license: show.license } : {}),
      ...(show.parameters ? { parameters: show.parameters } : {}),
      ...(show.template ? { template: show.template } : {}),
      ...(show.system ? { system: show.system } : {}),
      ...(messages ? { messages } : {}),
      ...(modelInfoJson ? { modelInfoJson } : {}),
      ...(projectorInfoJson ? { projectorInfoJson } : {}),
      ...(rawJson ? { rawJson } : {}),
    },
  };
}

async function loadShowMetadata(
  client: Ollama,
  models: ListResponse['models'],
  previousShowByModel?: ReadonlyMap<
    string,
    {
      show: NonNullable<OllamaModelEntry['show']>;
      details?: OllamaModelDetails;
    }
  >,
): Promise<
  Map<
    string,
    {
      show: NonNullable<OllamaModelEntry['show']>;
      details?: OllamaModelDetails;
    }
  >
> {
  const entries = await Promise.all(
    models.map(async (model) => {
      try {
        const show = await client.show({ model: model.model });
        return [model.model, normalizeShowData(show)] as const;
      } catch {
        const previousShow = previousShowByModel?.get(model.model);
        return previousShow ? ([model.model, previousShow] as const) : null;
      }
    }),
  );

  return new Map(
    entries.filter(
      (
        entry,
      ): entry is readonly [
        string,
        {
          show: NonNullable<OllamaModelEntry['show']>;
          details?: OllamaModelDetails;
        },
      ] => entry !== null,
    ),
  );
}

function toPullProgress(
  model: string,
  progress: ProgressResponse,
  done: boolean,
  error?: string,
): OllamaPullProgress {
  const nextProgress: OllamaPullProgress = {
    model,
    status: progress.status,
    done,
  };

  if (progress.completed > 0) {
    nextProgress.completed = progress.completed;
  }
  if (progress.total > 0) {
    nextProgress.total = progress.total;
  }
  if (
    typeof progress.digest === 'string' &&
    progress.digest.trim().length > 0
  ) {
    nextProgress.digest = progress.digest;
  }
  if (error) {
    nextProgress.error = error;
  }

  return nextProgress;
}

function assertOllamaEnabled(): void {
  if (!isOllamaSupportedOnPlatform()) {
    throw new Error(OLLAMA_UNSUPPORTED_PLATFORM_MESSAGE);
  }
}

export function buildClaudeCompatibleOllamaEnv(
  port: number,
): Record<string, string> {
  return {
    ANTHROPIC_AUTH_TOKEN: 'ollama',
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_BASE_URL: buildOllamaHost(port),
  };
}

class OllamaServiceImpl implements OllamaService {
  private initialized = false;
  private initializationPromise: Promise<void> | null = null;
  private state: OllamaState = {
    port: DEFAULT_OLLAMA_SERVER_PORT,
    status: 'stopped',
    models: [],
    mode: 'managed',
    installation: createInitialOllamaInstallationStatus(),
  };
  private ownership: OllamaOwnership = 'none';
  private cacheByPort = new Map<number, OllamaModelCachePortEntry>();
  private client = new Ollama({
    host: buildOllamaHost(DEFAULT_OLLAMA_SERVER_PORT),
  });
  private childProcess: ChildProcess | null = null;
  private startPromise: Promise<void> | null = null;
  private startupController: AbortController | null = null;
  private broadcasts: OllamaBroadcastHandlers = {};
  private managedStderr = '';
  private serverVersion: string | undefined;
  private connectionBaselineEstablished = false;
  private connectionConfigurationGeneration = 0;
  private pendingInAppConnection = false;
  private pendingConfigurationChange: Promise<void> | null = null;
  private configurationMutationActive = false;

  private withConfigurationChange<T>(run: () => Promise<T>): Promise<T> {
    const previous = this.pendingConfigurationChange ?? Promise.resolve();
    const result = previous.then(async (): Promise<T> => {
      try {
        return await run();
      } finally {
        if (this.configurationMutationActive) {
          this.connectionConfigurationGeneration += 1;
          this.configurationMutationActive = false;
        }
      }
    });
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.pendingConfigurationChange = settled;
    void settled.then((): void => {
      if (this.pendingConfigurationChange === settled)
        this.pendingConfigurationChange = null;
    });
    return result;
  }

  private beginConfigurationMutation(): void {
    this.configurationMutationActive = true;
    this.connectionConfigurationGeneration += 1;
  }

  private async waitForConfigurationChange(): Promise<void> {
    while (this.pendingConfigurationChange)
      await this.pendingConfigurationChange;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (!this.initializationPromise) {
      const pending = this.initializeImpl();
      this.initializationPromise = pending;
      void pending.catch((): void => {
        if (this.initializationPromise === pending)
          this.initializationPromise = null;
      });
    }
    return this.initializationPromise;
  }

  private async initializeImpl(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (!isOllamaSupportedOnPlatform()) {
      this.state = {
        port: DEFAULT_OLLAMA_SERVER_PORT,
        status: 'stopped',
        models: [],
        mode: 'managed',
        installation: createUnavailableOllamaInstallationStatus(
          OLLAMA_UNSUPPORTED_PLATFORM_MESSAGE,
        ),
      };
      initOllamaModels([]);
      this.initialized = true;
      return;
    }

    const preferences = await readOllamaPreferences();
    const cacheFile = await this.readCacheFile();
    this.cacheByPort = new Map(
      Object.entries(cacheFile.byPort).map(([port, entry]) => [
        Number(port),
        {
          refreshedAt: entry.refreshedAt,
          models: cloneModels(entry.models),
        },
      ]),
    );

    const installation = await detectOllamaInstallation({
      force: true,
      persistedPath: preferences.executablePath,
      // Preference writes normalize every persisted model selection. Wait
      // until the cached Ollama models are registered below so saved local
      // model ids remain valid during startup detection.
      persistDetectedPath: false,
    });
    this.state = this.buildStateFromCache(preferences.port, {
      mode: preferences.mode,
      installation,
    });
    this.configureClient(preferences.port);
    initOllamaModels(this.state.models);
    if (
      installation.ready &&
      installation.path &&
      installation.path !== preferences.executablePath
    ) {
      await writeOllamaConfigurationPreference({
        executablePath: installation.path,
      });
    }
    this.initialized = true;
  }

  setBroadcastHandlers(handlers: OllamaBroadcastHandlers): void {
    this.broadcasts = handlers;
  }

  getState(): Promise<OllamaState> {
    return Promise.resolve(cloneState(this.state));
  }

  getCachedModels(): OllamaModelEntry[] {
    return cloneModels(this.state.models);
  }

  async refreshModels(opts?: { allowStart?: boolean }): Promise<OllamaState> {
    await this.waitForConfigurationChange();
    if (opts?.allowStart)
      return this.withConnectionAttempt(() => this.refreshModelsImpl(opts));
    return this.refreshModelsImpl(opts);
  }

  private async withConnectionAttempt<T>(run: () => Promise<T>): Promise<T> {
    const generation = this.connectionConfigurationGeneration;
    try {
      return await run();
    } catch (error) {
      if (
        generation === this.connectionConfigurationGeneration &&
        !this.configurationMutationActive
      ) {
        try {
          recordProviderConnectionFailure(
            'ollama',
            'local',
            classifyConnectionFailure(
              error instanceof OllamaServerUnavailableError && error.cause
                ? error.cause
                : error,
            ),
          );
        } catch {
          // Observation must preserve the original provider failure.
        }
      }
      throw error;
    }
  }

  private async refreshModelsImpl(opts?: {
    allowStart?: boolean;
  }): Promise<OllamaState> {
    const generation = this.connectionConfigurationGeneration;
    assertOllamaEnabled();
    await this.initialize();
    await this.waitForConfigurationChange();
    if (generation !== this.connectionConfigurationGeneration)
      return this.getState();
    const allowStart = opts?.allowStart === true;
    const port = this.state.port;
    const client = this.client;
    const reachable = await this.probeConfiguredServer();
    if (
      generation !== this.connectionConfigurationGeneration ||
      this.configurationMutationActive
    )
      return this.getState();

    if (!reachable && !allowStart) {
      if (
        this.state.status === 'running-managed' ||
        this.state.status === 'running-external'
      ) {
        this.ownership = 'none';
        this.updateState({
          status: 'stopped',
          error: undefined,
        });
      }
      return this.getState();
    }

    if (!reachable) {
      await this.ensureServerRunning('settings-refresh');
    } else {
      this.markReachableState();
    }
    if (
      generation !== this.connectionConfigurationGeneration ||
      this.configurationMutationActive
    )
      return this.getState();

    const refreshedAt = new Date().toISOString();
    const list = await client.list();
    if (
      generation !== this.connectionConfigurationGeneration ||
      this.configurationMutationActive
    )
      return this.getState();
    const previousShowByModel = new Map(
      (this.cacheByPort.get(port)?.models ?? [])
        .filter(
          (
            model,
          ): model is OllamaModelEntry & {
            show: NonNullable<OllamaModelEntry['show']>;
          } => model.show !== undefined,
        )
        .map(
          (model) =>
            [
              model.rawModelId,
              {
                show: model.show,
                ...(model.details ? { details: model.details } : {}),
              },
            ] as const,
        ),
    );
    const showByModel = await loadShowMetadata(
      client,
      list.models,
      previousShowByModel,
    );
    if (
      generation !== this.connectionConfigurationGeneration ||
      this.configurationMutationActive
    )
      return this.getState();
    const cacheEntry = mergeShowMetadata(list, refreshedAt, showByModel);
    this.cacheByPort.set(port, cacheEntry);
    await this.writeCacheFile();
    if (
      generation !== this.connectionConfigurationGeneration ||
      this.configurationMutationActive
    )
      return this.getState();
    this.updateState({
      status:
        this.ownership === 'managed' ? 'running-managed' : 'running-external',
      models: cacheEntry.models,
      refreshedAt: cacheEntry.refreshedAt,
      error: undefined,
    });
    this.observeConfirmedConnection(port, allowStart ? 'in_app' : 'read');
    initOllamaModels(cacheEntry.models);
    this.broadcastModelRegistryUpdated();
    return this.getState();
  }

  async pullModel(rawModelId: unknown): Promise<OllamaState> {
    assertOllamaEnabled();
    await this.initialize();
    const model = normalizeModelName(rawModelId);

    await this.waitForConfigurationChange();
    await this.withConnectionAttempt(() => this.ensureServerRunning('pull'));

    let lastProgress: ProgressResponse = {
      status: 'pulling',
      digest: '',
      total: 0,
      completed: 0,
    };

    try {
      const stream = await this.client.pull({
        model,
        stream: true,
      });
      for await (const progress of stream) {
        lastProgress = progress;
        this.broadcastPullProgress(toPullProgress(model, progress, false));
      }

      this.broadcastPullProgress(toPullProgress(model, lastProgress, true));
      return this.refreshModels();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.broadcastPullProgress(
        toPullProgress(model, lastProgress, true, message),
      );
      throw error;
    }
  }

  async deleteModel(rawModelId: unknown): Promise<OllamaState> {
    assertOllamaEnabled();
    await this.initialize();
    const model = normalizeModelName(rawModelId);

    await this.waitForConfigurationChange();
    await this.withConnectionAttempt(() => this.ensureServerRunning('delete'));
    await this.client.delete({ model });
    return this.refreshModels({ allowStart: false });
  }

  async setPort(port: number): Promise<OllamaState> {
    return this.withConfigurationChange(async (): Promise<OllamaState> => {
      await this.initialize();
      return this.setConfigurationImpl({ mode: this.state.mode, port });
    });
  }

  async setConfiguration(
    update: OllamaConfigurationUpdate,
  ): Promise<OllamaState> {
    return this.withConfigurationChange(() =>
      this.setConfigurationImpl(update),
    );
  }

  private async setConfigurationImpl(
    update: OllamaConfigurationUpdate,
  ): Promise<OllamaState> {
    assertOllamaEnabled();
    await this.initialize();
    const port = normalizePort(update.port);
    const mode = normalizeMode(update.mode);
    if (port === this.state.port && mode === this.state.mode) {
      return this.getState();
    }

    this.beginConfigurationMutation();
    await this.shutdown('port-changed');
    await writeOllamaConfigurationPreference({ mode, port });
    const installation =
      mode === 'managed'
        ? await detectOllamaInstallation({
            force: true,
            persistedPath: this.state.installation.path ?? undefined,
          })
        : this.state.installation;
    this.configureClient(port);
    this.state = this.buildStateFromCache(port, { mode, installation });
    this.markConnectionSetupChanged();
    this.ownership = 'none';
    initOllamaModels(this.state.models);
    this.broadcastStatus();
    this.broadcastModelRegistryUpdated();
    return this.getState();
  }

  async redetectInstallation(options?: {
    force?: boolean;
  }): Promise<OllamaState> {
    return this.withConfigurationChange(() =>
      this.redetectInstallationImpl(options),
    );
  }

  private async redetectInstallationImpl(options?: {
    force?: boolean;
  }): Promise<OllamaState> {
    assertOllamaEnabled();
    await this.initialize();
    const status = await detectOllamaInstallation({
      force: options?.force ?? true,
      persistedPath: this.state.installation.path ?? undefined,
    });
    const runtimeChanged = installationRuntimeChanged(
      this.state.installation,
      status,
    );
    if (runtimeChanged) {
      this.beginConfigurationMutation();
      await this.shutdown('port-changed');
      this.serverVersion = undefined;
    }
    this.updateState({
      installation: status,
      error: undefined,
      ...(runtimeChanged
        ? { status: 'stopped', serverVersion: undefined }
        : {}),
    });
    if (runtimeChanged) {
      if (status.ready) this.markConnectionSetupChanged(true);
      this.broadcastModelRegistryUpdated();
    }
    return this.getState();
  }

  async setExecutablePath(path: string): Promise<OllamaState> {
    return this.withConfigurationChange(() => this.setExecutablePathImpl(path));
  }

  private async setExecutablePathImpl(path: string): Promise<OllamaState> {
    assertOllamaEnabled();
    await this.initialize();
    const status = await validateOllamaExecutable(path, 'browse');
    if (status.ready && status.path) {
      this.beginConfigurationMutation();
      await this.shutdown('port-changed');
      await writeOllamaConfigurationPreference({ executablePath: status.path });
      if (installationRuntimeChanged(this.state.installation, status)) {
        this.markConnectionSetupChanged(true);
      }
      this.serverVersion = undefined;
      this.updateState({
        installation: status,
        status: 'stopped',
        error: undefined,
        serverVersion: undefined,
      });
      this.broadcastModelRegistryUpdated();
    } else {
      this.updateState({
        error: status.error,
      });
    }
    return this.getState();
  }

  async install(
    onProgress?: Parameters<typeof installOllama>[0],
  ): Promise<OllamaState> {
    return withProviderConnectionAttempt('ollama', 'local', undefined, () =>
      this.withConfigurationChange(() => this.installImpl(onProgress)),
    );
  }

  private async installImpl(
    onProgress?: Parameters<typeof installOllama>[0],
  ): Promise<OllamaState> {
    assertOllamaEnabled();
    await this.initialize();
    if (this.state.mode === 'manual') {
      throw new Error(
        'Ollama installation is disabled in manual mode. Switch to managed mode before installing Ollama.',
      );
    }
    if (this.state.installation.ready) {
      return this.getState();
    }
    this.beginConfigurationMutation();
    await this.shutdown('port-changed');
    const status = await installOllama(onProgress);
    if (!status.ready)
      recordProviderConnectionFailure('ollama', 'local', 'runtime_unavailable');
    if (status.ready && status.path) {
      await writeOllamaConfigurationPreference({ executablePath: status.path });
      this.markConnectionSetupChanged(true);
    }
    this.updateState({
      installation: status,
      status: 'stopped',
      error: status.ready ? undefined : status.error,
      serverVersion: undefined,
    });
    this.broadcastModelRegistryUpdated();
    return this.getState();
  }

  async testConnection(
    port?: number,
    options?: OllamaConnectionTestOptions,
  ): Promise<OllamaConnectionTestResult> {
    await this.waitForConfigurationChange();
    if (options?.background === true)
      return this.testConnectionImpl(port, true);
    return this.withConnectionAttempt(() => this.testConnectionImpl(port));
  }

  private async testConnectionImpl(
    port?: number,
    background = false,
  ): Promise<OllamaConnectionTestResult> {
    assertOllamaEnabled();
    const generation = this.connectionConfigurationGeneration;
    const targetPort = await this.resolveConnectionTestPort(port);
    const startedAt = Date.now();
    const result = await this.probeServerVersionForPort(targetPort);
    const latencyMs = Math.max(0, Date.now() - startedAt);
    const connected = result.reachable && result.version !== undefined;
    const matchesConfiguration =
      !background &&
      targetPort === (await this.resolveConnectionTestPort()) &&
      generation === this.connectionConfigurationGeneration &&
      !this.configurationMutationActive;
    if (matchesConfiguration) {
      this.establishConnectionBaseline(connected ? String(targetPort) : null);
    }
    if (connected) {
      if (matchesConfiguration)
        this.observeConfirmedConnection(targetPort, 'in_app');
    } else if (
      !background &&
      generation === this.connectionConfigurationGeneration &&
      !this.configurationMutationActive
    )
      recordProviderConnectionFailure(
        'ollama',
        'local',
        result.reachable ? 'other' : 'network',
      );
    return {
      ok: result.reachable && result.version !== undefined,
      host: '127.0.0.1',
      port: targetPort,
      checkedAt: new Date().toISOString(),
      latencyMs,
      ...(result.version ? { version: result.version } : {}),
      ...(!result.reachable
        ? {
            error:
              result.error ??
              `Couldn't connect to Ollama on 127.0.0.1:${String(targetPort)}.`,
          }
        : result.version
          ? {}
          : { error: 'The server did not report an Ollama version.' }),
    };
  }

  private async resolveConnectionTestPort(port?: number): Promise<number> {
    if (port !== undefined) {
      return normalizePort(Number(port));
    }
    if (this.initialized) {
      return this.state.port;
    }
    const preferences = await readOllamaPreferences();
    return normalizePort(preferences.port);
  }

  async handleUserEnvironmentChanged(): Promise<void> {
    return this.withConfigurationChange(() =>
      this.handleUserEnvironmentChangedImpl(),
    );
  }

  private async handleUserEnvironmentChangedImpl(): Promise<void> {
    if (!isOllamaSupportedOnPlatform()) {
      return;
    }
    await this.initialize();
    this.beginConfigurationMutation();

    if (this.startPromise) {
      this.startupController?.abort();
      await this.terminateManagedChild();
      await this.startPromise.catch(() => {});
      this.startPromise = null;
    }

    const status = await detectOllamaInstallation({
      force: true,
      persistedPath: this.state.installation.path ?? undefined,
    });
    this.updateState({ installation: status });

    if (this.ownership === 'managed' && this.childProcess) {
      await this.terminateManagedChild();
      this.updateState({
        status: 'stopped',
        error: undefined,
      });
    }
  }

  async ensureServerRunning(
    reason:
      | 'chat'
      | 'helper'
      | 'pipeline'
      | 'settings-refresh'
      | 'pull'
      | 'delete',
  ): Promise<void> {
    assertOllamaEnabled();
    await this.initialize();
    await this.waitForConfigurationChange();
    const generation = this.connectionConfigurationGeneration;
    const port = this.state.port;
    const via =
      reason === 'chat' || reason === 'helper' || reason === 'pipeline'
        ? 'read'
        : 'in_app';

    const reachable = await this.probeConfiguredServer();
    if (
      generation !== this.connectionConfigurationGeneration ||
      this.configurationMutationActive
    ) {
      throw new OllamaServerUnavailableError('Ollama startup canceled.');
    }
    if (reachable) {
      this.markReachableState();
      this.observeConfirmedConnection(port, via);
      return;
    }

    if (this.startPromise) {
      return this.startPromise;
    }

    if (this.state.mode === 'manual') {
      const message = `Couldn't connect to Ollama on 127.0.0.1:${String(this.state.port)}. Start the Ollama server externally, then test the connection in Ollama settings.`;
      this.updateState({ status: 'error', error: message });
      throw new OllamaServerUnavailableError(message);
    }

    if (!this.state.installation.ready || !this.state.installation.path) {
      const message =
        'Ollama is not installed or its executable could not be found. Open Ollama settings to install, detect, or browse for it.';
      this.updateState({ status: 'error', error: message });
      throw new OllamaServerUnavailableError(message);
    }

    const startupController = new AbortController();
    this.startupController = startupController;
    this.startPromise = this.startManagedServer(
      this.state.installation.path,
      startupController.signal,
      generation,
      port,
      via,
    ).catch((error: unknown) => {
      if (error instanceof OllamaServerUnavailableError) throw error;
      const message =
        error instanceof Error ? error.message : 'Ollama could not be started.';
      throw new OllamaServerUnavailableError(message, error);
    });
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
      if (this.startupController === startupController) {
        this.startupController = null;
      }
    }
  }

  async shutdown(reason: 'port-changed' | 'app-quit'): Promise<void> {
    if (!isOllamaSupportedOnPlatform()) {
      return;
    }
    await this.initialize();

    const pendingStart = this.startPromise;
    if (pendingStart) {
      this.startupController?.abort();
      await this.terminateManagedChild();
      await pendingStart.catch(() => {});
      if (this.startPromise === pendingStart) {
        this.startPromise = null;
      }
    }

    if (this.ownership !== 'managed' || !this.childProcess) {
      if (reason !== 'app-quit') {
        this.ownership = 'none';
        this.updateState({
          status: 'stopped',
          error: undefined,
        });
      }
      if (reason === 'app-quit') {
        await cleanupOllamaInstallationWork();
      }
      return;
    }

    await this.terminateManagedChild();
    if (reason === 'app-quit') {
      await cleanupOllamaInstallationWork();
    }

    if (reason !== 'app-quit') {
      this.updateState({
        status: 'stopped',
        error: undefined,
      });
    }
  }

  private async terminateManagedChild(): Promise<void> {
    if (!this.childProcess) {
      return;
    }

    const child = this.childProcess;
    this.childProcess = null;
    this.ownership = 'none';

    await new Promise<void>((resolve) => {
      let resolved = false;
      const finish = (): void => {
        if (resolved) {
          return;
        }
        resolved = true;
        resolve();
      };

      const timeout = setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
        finish();
      }, MANAGED_SHUTDOWN_TIMEOUT_MS);

      child.once('exit', () => {
        clearTimeout(timeout);
        finish();
      });

      child.once('error', () => {
        clearTimeout(timeout);
        finish();
      });

      child.kill('SIGTERM');
    });
  }

  async assertInstalled(rawModelId: unknown): Promise<void> {
    assertOllamaEnabled();
    await this.initialize();
    const model = normalizeModelName(rawModelId);

    const installedModel = this.state.models.find(
      (entry) => entry.rawModelId === model,
    );
    if (installedModel && isSupportedOllamaModelEntry(installedModel)) {
      return;
    }

    const refreshed = await this.refreshModels({ allowStart: false });
    const refreshedModel = refreshed.models.find(
      (entry) => entry.rawModelId === model,
    );
    if (refreshedModel && isSupportedOllamaModelEntry(refreshedModel)) {
      return;
    }

    const unsupportedModel = installedModel ?? refreshedModel;
    if (unsupportedModel) {
      const capabilities = unsupportedModel.show?.capabilities?.join(', ');
      throw new Error(
        `Ollama model "${model}" must advertise both "completion" and "tools" capabilities to be used in ${BRAND.displayName}${capabilities ? ` (reported capabilities: ${capabilities})` : ''}`,
      );
    }

    throw new Error(
      `Ollama model "${model}" is not installed on port ${String(this.state.port)}`,
    );
  }

  async assertAnthropicCompatibleApi(): Promise<void> {
    assertOllamaEnabled();
    await this.initialize();
    await this.waitForConfigurationChange();
    const generation = this.connectionConfigurationGeneration;

    const version =
      this.serverVersion ?? (await this.readConfiguredServerVersion());
    if (
      generation !== this.connectionConfigurationGeneration ||
      this.configurationMutationActive
    )
      throw new OllamaServerUnavailableError('Ollama startup canceled.');
    if (!version) {
      return;
    }

    if (isOllamaServerVersionCompatible(version)) {
      return;
    }

    const message = `Ollama ${version} on port ${String(this.state.port)} does not support the Anthropic-compatible /v1/messages API required for ${BRAND.displayName} chat sessions. Upgrade Ollama to ${MINIMUM_OLLAMA_SERVER_VERSION} or newer.`;
    this.updateState({ error: message, serverVersion: version });
    throw new Error(message);
  }

  async assertResponsesCompatibleApi(): Promise<void> {
    assertOllamaEnabled();
    await this.initialize();
    await this.waitForConfigurationChange();
    const generation = this.connectionConfigurationGeneration;
    const version =
      this.serverVersion ?? (await this.readConfiguredServerVersion());
    if (
      generation !== this.connectionConfigurationGeneration ||
      this.configurationMutationActive
    )
      throw new OllamaServerUnavailableError('Ollama startup canceled.');
    if (!version) {
      // The version endpoint is the reachability probe: an unreadable version
      // means no server answered, not that the server refused something.
      // Callers translate this into "start Ollama" guidance, so it must be
      // machine-identifiable rather than distinguished by message text — the
      // rejections below it come from a server that *is* running.
      const message = `Could not determine the Ollama version on port ${String(this.state.port)} before starting a Codex-harness session. Verify the configured Ollama server is running and exposes /api/version.`;
      this.updateState({ error: message });
      throw new OllamaServerUnavailableError(message);
    }
    if (isOllamaResponsesVersionCompatible(version)) {
      return;
    }
    const message = `Ollama ${version} on port ${String(this.state.port)} does not support the OpenAI Responses API required for Codex-harness sessions. Upgrade Ollama to ${MINIMUM_OLLAMA_RESPONSES_VERSION} or newer.`;
    this.updateState({ error: message, serverVersion: version });
    throw new Error(message);
  }

  private configureClient(port: number): void {
    this.client = new Ollama({ host: buildOllamaHost(port) });
    this.serverVersion = undefined;
  }

  private buildStateFromCache(
    port: number,
    config: {
      mode: OllamaState['mode'];
      installation: OllamaInstallationStatus;
    } = {
      mode: this.state.mode,
      installation: this.state.installation,
    },
  ): OllamaState {
    const cacheEntry = this.cacheByPort.get(port);
    return {
      port,
      status: 'stopped',
      models: cloneModels(cacheEntry?.models ?? []),
      mode: config.mode,
      installation: { ...config.installation },
      ...(cacheEntry ? { refreshedAt: cacheEntry.refreshedAt } : {}),
    };
  }

  private async probeConfiguredServer(signal?: AbortSignal): Promise<boolean> {
    if (this.configurationMutationActive) return false;
    const generation = this.connectionConfigurationGeneration;
    const port = this.state.port;
    const result = await this.probeServerVersionForPort(port, signal);
    if (
      generation !== this.connectionConfigurationGeneration ||
      this.configurationMutationActive ||
      signal?.aborted
    )
      return false;
    this.serverVersion = result.version;
    if (result.version) {
      this.updateState({ serverVersion: result.version });
    }
    const connected = result.reachable && result.version !== undefined;
    this.establishConnectionBaseline(connected ? String(port) : null);
    return connected;
  }

  private markConnectionSetupChanged(resetFingerprint = false): void {
    this.pendingInAppConnection = true;
    if (resetFingerprint || !this.connectionBaselineEstablished) {
      // A changed executable is setup even when the endpoint stays the same.
      this.connectionBaselineEstablished = true;
      observeProviderConnection({
        provider: 'ollama',
        connectionMethod: 'local',
        fingerprint: null,
        via: 'read',
      });
    }
  }

  private observeConfirmedConnection(
    port: number,
    via: 'read' | 'in_app',
    startupBaseline = false,
  ): void {
    if (this.configurationMutationActive) return;
    const pendingSetup = this.pendingInAppConnection;
    this.pendingInAppConnection = false;
    observeProviderConnection({
      provider: 'ollama',
      connectionMethod: 'local',
      fingerprint: String(port),
      via: pendingSetup ? 'in_app' : via,
      baselineOnly: startupBaseline && !pendingSetup,
    });
  }

  private establishConnectionBaseline(fingerprint: string | null): void {
    if (
      this.connectionBaselineEstablished ||
      this.configurationMutationActive
    ) {
      return;
    }
    // Reuse the first existing probe, not a new startup request. Committed
    // setup changes seed null first so their eventual connection stays in-app.
    this.connectionBaselineEstablished = true;
    observeProviderConnection({
      provider: 'ollama',
      connectionMethod: 'local',
      fingerprint,
      via: 'read',
    });
  }

  private async readConfiguredServerVersion(): Promise<string | undefined> {
    if (this.configurationMutationActive) return undefined;
    const generation = this.connectionConfigurationGeneration;
    const result = await this.probeServerVersionForPort(this.state.port);
    if (
      generation !== this.connectionConfigurationGeneration ||
      this.configurationMutationActive
    )
      return undefined;
    this.serverVersion = result.version;
    return result.version;
  }

  private async probeServerVersionForPort(
    port: number,
    signal?: AbortSignal,
  ): Promise<{
    reachable: boolean;
    version?: string;
    error?: string;
  }> {
    const controller = new AbortController();
    const abortProbe = (): void => controller.abort();
    if (signal?.aborted) {
      controller.abort();
    } else {
      signal?.addEventListener('abort', abortProbe, { once: true });
    }
    const timeout = setTimeout(
      () => controller.abort(),
      OLLAMA_PROBE_TIMEOUT_MS,
    );

    try {
      const response = await fetch(`${buildOllamaHost(port)}/api/version`, {
        signal: controller.signal,
      });
      if (!response.ok) {
        return { reachable: false, error: `HTTP ${String(response.status)}` };
      }

      let payload: unknown;
      if (typeof response.json === 'function') {
        try {
          payload = await response.json();
        } catch {
          payload = undefined;
        }
      }

      if (
        isRecord(payload) &&
        typeof payload.version === 'string' &&
        payload.version.trim().length > 0
      ) {
        return {
          reachable: true,
          version: payload.version.trim(),
        };
      }

      return { reachable: true };
    } catch (error) {
      return {
        reachable: false,
        error: error instanceof Error ? error.message : undefined,
      };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortProbe);
    }
  }

  private markReachableState(): void {
    const nextOwnership = this.childProcess ? 'managed' : 'external';
    this.ownership = nextOwnership;
    this.updateState({
      status:
        nextOwnership === 'managed' ? 'running-managed' : 'running-external',
      error: undefined,
      ...(this.serverVersion ? { serverVersion: this.serverVersion } : {}),
    });
  }

  private async startManagedServer(
    executablePath: string,
    signal: AbortSignal,
    generation: number,
    port: number,
    via: 'read' | 'in_app',
  ): Promise<void> {
    this.updateState({
      status: 'starting',
      error: undefined,
    });

    this.managedStderr = '';
    // Remote Control never tunnels to the managed server, from before it
    // binds the port until it exits (CAN-7679).
    const releasePort = reserveLoopbackPort(port);
    const child = spawn(executablePath, ['serve'], {
      env: {
        ...getEnhancedEnv({ environment: { runtime: 'canopy' } }),
        OLLAMA_HOST: `127.0.0.1:${String(port)}`,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: process.platform === 'win32',
    });
    const forgetProcess =
      child.pid === undefined ? null : registerCanopyProcess(child.pid);
    const released = (): void => {
      releasePort();
      forgetProcess?.();
    };
    child.once('exit', released);
    // A process that failed to start emits no exit.
    child.once('error', () => {
      if (child.pid === undefined) released();
    });

    this.childProcess = child;
    let startupFailure: Error | null = null;
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const next = `${this.managedStderr}${String(chunk)}`;
      this.managedStderr = next.slice(-4000);
    });
    child.once('exit', (_code, signal) => {
      if (this.childProcess !== child) {
        return;
      }
      this.childProcess = null;
      this.ownership = 'none';
      const signalText = signal ? ` (signal ${signal})` : '';
      const message = `Ollama server exited before startup completed${signalText}`;
      if (this.state.status === 'starting') {
        startupFailure = new Error(message);
      }
      this.updateState({
        status: 'stopped',
        error: this.state.status === 'starting' ? message : undefined,
      });
    });
    child.once('error', (error) => {
      if (this.childProcess !== child) {
        return;
      }
      this.childProcess = null;
      this.ownership = 'none';
      startupFailure = error;
      this.updateState({
        status: 'error',
        error: error.message,
      });
    });

    const deadline = Date.now() + OLLAMA_STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (
        signal.aborted ||
        generation !== this.connectionConfigurationGeneration ||
        this.configurationMutationActive ||
        port !== this.state.port
      ) {
        if (this.childProcess === child) await this.terminateManagedChild();
        throw new Error('Ollama startup canceled.');
      }
      if (await this.probeConfiguredServer(signal)) {
        if (
          signal.aborted ||
          generation !== this.connectionConfigurationGeneration ||
          this.configurationMutationActive ||
          port !== this.state.port
        ) {
          if (this.childProcess === child) await this.terminateManagedChild();
          throw new Error('Ollama startup canceled.');
        }
        this.ownership = 'managed';
        this.updateState({
          status: 'running-managed',
          error: undefined,
        });
        this.observeConfirmedConnection(port, via, via === 'read');
        return;
      }
      if (
        signal.aborted ||
        generation !== this.connectionConfigurationGeneration ||
        this.configurationMutationActive ||
        port !== this.state.port
      ) {
        if (this.childProcess === child) await this.terminateManagedChild();
        throw new Error('Ollama startup canceled.');
      }
      const failure = ((): Error | null => startupFailure)();
      if (failure) {
        throw failure;
      }
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          clearTimeout(timer);
          reject(new Error('Ollama startup canceled.'));
        };
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        }, 250);
        signal.addEventListener('abort', onAbort, { once: true });
      });
    }

    const startupError =
      this.managedStderr.trim().length > 0
        ? this.managedStderr.trim()
        : 'Timed out waiting for Ollama to become ready';
    if (this.childProcess === child) {
      this.ownership = 'managed';
      await this.terminateManagedChild();
    }
    this.updateState({
      status: 'error',
      error: startupError,
    });
    throw new Error(startupError);
  }

  private async readCacheFile(): Promise<OllamaModelCacheFile> {
    try {
      const raw = await readFile(getOllamaModelCacheFilePath(), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      return normalizeCacheFile(parsed);
    } catch {
      return {
        version: 1,
        byPort: {},
      };
    }
  }

  private async writeCacheFile(): Promise<void> {
    const payload: OllamaModelCacheFile = {
      version: 1,
      byPort: Object.fromEntries(
        Array.from(this.cacheByPort.entries()).map(([port, entry]) => [
          String(port),
          {
            refreshedAt: entry.refreshedAt,
            models: cloneModels(entry.models),
          },
        ]),
      ),
    };

    const filePath = getOllamaModelCacheFilePath();
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
  }

  private updateState(update: Partial<OllamaState>): void {
    this.state = {
      ...this.state,
      ...update,
      models: update.models
        ? cloneModels(update.models)
        : cloneModels(this.state.models),
      installation: update.installation
        ? { ...update.installation }
        : { ...this.state.installation },
    };
    this.broadcastStatus();
  }

  private broadcastStatus(): void {
    this.broadcasts.status?.(cloneState(this.state));
  }

  private broadcastPullProgress(progress: OllamaPullProgress): void {
    this.broadcasts.pullProgress?.(progress);
  }

  broadcastModelRegistryUpdated(): void {
    this.broadcasts.modelRegistryUpdated?.();
  }
}

const ollamaServiceSingleton = new OllamaServiceImpl();

export function getOllamaService(): OllamaServiceImpl {
  return ollamaServiceSingleton;
}
