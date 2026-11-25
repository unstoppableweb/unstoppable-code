import {
  observeProviderConnection,
  withProviderConnectionAttempt,
  type ConnectionMethod,
} from '../lib/provider-connection-events';
import { withoutStepStartupInjection } from '@canopy/desktop-shared/node/provider-process/step-environment';
import {
  openCodeAccountMetadataSchema,
  type OpenCodeAccountSnapshot,
} from '@canopy/protocol/remote-control/shell';
import {
  peekOpenCodeAccounts,
  publishOpenCodeAccounts,
} from './account-information';
import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import { getFeatureFlagService } from '../feature-flags';
import { broadcastPreferencesChanged } from '../lib/preferences-broadcast';
import {
  assertOpenCodeHarnessEnabled,
  isOpenCodeHarnessEnabled,
} from './feature-flag';
import { buildDelegationCursorEnvironment } from '@canopy/desktop-shared/node/delegation/environment';
import {
  beginOpenCodeAvailabilityProbe,
  invalidateOpenCodeRuntimeAvailability,
} from './runtime-availability';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpenCodeConnectionStatus } from '@canopy/desktop-shared/types/opencode-connection';
import type { OpenCodeModelEntry } from '@canopy/execution-engine/types/opencode-models';
import {
  initOpenCodeModels,
  resolveRuntimeModel,
} from '@canopy/desktop-shared/types';
import {
  enrichOpenCodeModels,
  openCodeModelsFromConfig,
} from '@canopy/execution-engine/lib/opencode-models';
import {
  getOpenCodeRuntimeRootDir,
  getOpenCodeRuntimeStateDir,
} from '@canopy/execution-engine/pipelines/config-paths';
import {
  getOpenCodeRuntimeArtifact,
  opencodeExecutableName,
  OPENCODE_RUNTIME_VERSION,
} from '@canopy/desktop-shared/node/opencode/runtime-metadata';
import { readOpenCodeProviderConfig } from '@canopy/desktop-shared/node/opencode/provider-config';
import {
  readPreferencesFile,
  updatePreferencesFile,
  getOpenCodeEnabledRevision,
} from '../lib/preferences-store';
import { getEnhancedEnv } from '../pipelines/config-paths';
import { OpenCodeRuntimeInstaller } from './runtime-installer';
import type { ProviderProcessSpawner } from '@canopy/desktop-shared/node/provider-process/spawn';
import {
  openCodeProcessOwner,
  spawnOpenCodeProcessForWorkerRun,
  type OpenCodeProcessOwner,
} from '../agent-runs/opencode-worker-runtime';

let generation = 0;
let cached:
  | { generation: number; expires: number; models: OpenCodeModelEntry[] }
  | undefined;
interface DiscoveryResult {
  models: OpenCodeModelEntry[];
  accounts: OpenCodeAccountSnapshot;
}
interface Discovery {
  promise: Promise<OpenCodeModelEntry[]>;
  controller: AbortController;
  waiters: number;
}
let discovery: Discovery | undefined;
let connecting = false;
let setupAbort: AbortController | undefined;
let observingRollout = false;
function observeRollout(): void {
  if (observingRollout) return;
  observingRollout = true;
  getFeatureFlagService().onSnapshotChanged(() => {
    if (isOpenCodeHarnessEnabled()) return;
    setupAbort?.abort();
    void revokeOpenCodeRuntimes().catch(() => undefined);
  });
}
const live = new Set<{ abort: AbortController; done: Promise<void> }>();

function artifact(): ReturnType<typeof getOpenCodeRuntimeArtifact> {
  const pinned = getOpenCodeRuntimeArtifact();
  if (
    !pinned ||
    typeof __CANOPY_E2E__ === 'undefined' ||
    !__CANOPY_E2E__ ||
    !process.env.CANOPY_E2E_OPENCODE_RUNTIME
  )
    return pinned;
  const value: unknown = JSON.parse(process.env.CANOPY_E2E_OPENCODE_RUNTIME);
  if (
    !value ||
    typeof value !== 'object' ||
    !('url' in value) ||
    typeof value.url !== 'string' ||
    !('integrity' in value) ||
    typeof value.integrity !== 'string' ||
    !('executableSha256' in value) ||
    typeof value.executableSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.executableSha256) ||
    !('archiveBytes' in value) ||
    typeof value.archiveBytes !== 'number' ||
    !Number.isSafeInteger(value.archiveBytes) ||
    value.archiveBytes <= 0 ||
    value.archiveBytes > 1024 * 1024
  )
    throw new Error('Invalid OpenCode runtime fixture.');
  return {
    version: pinned.version,
    url: value.url,
    integrity: value.integrity,
    executableSha256: value.executableSha256,
    archiveBytes: value.archiveBytes,
  };
}

function installer(): OpenCodeRuntimeInstaller {
  const selected = artifact();
  if (!selected) throw new Error('OpenCode is not available on this device.');
  return new OpenCodeRuntimeInstaller({
    root: getOpenCodeRuntimeRootDir(),
    artifact: selected,
    executableName: opencodeExecutableName(),
    allowLoopback: typeof __CANOPY_E2E__ !== 'undefined' && __CANOPY_E2E__,
  });
}

export async function opencodeConnectionStatus(): Promise<OpenCodeConnectionStatus> {
  const publish = beginOpenCodeAvailabilityProbe();
  const epoch = generation;
  const enabledRevision = getOpenCodeEnabledRevision();
  const pendingSetup = setupAbort;
  const selected = artifact();
  const preferences = await readPreferencesFile();
  const installed = !!selected && (await installer().isInstalled());
  const enabled =
    !connecting &&
    isOpenCodeHarnessEnabled() &&
    preferences.opencodeEnabled === true;
  // Setup commits without revoking its model-discovery generation. Reads begun
  // during setup, or before a preference change, cannot replace its observations.
  const current =
    epoch === generation &&
    enabledRevision === getOpenCodeEnabledRevision() &&
    pendingSetup === setupAbort;
  if (current && installed && enabled && !peekOpenCodeAccounts())
    publishOpenCodeAccounts(unavailableAccounts());
  if (current) publish(!!selected && installed && enabled);
  if (current && !connecting && isOpenCodeHarnessEnabled()) {
    observeOpenCodeRuntime(installed && enabled, 'read');
    if (installed && enabled) observeOpenCodeConnection('read');
    else resetOpenCodeAccountConnection();
  }
  return {
    supported: !!selected,
    installed,
    enabled,
    version: OPENCODE_RUNTIME_VERSION,
    phase: enabled && installed ? 'connected' : 'idle',
    archiveBytes: selected?.archiveBytes,
  };
}

export function assertOpenCodeConnectionGeneration(expected: number): void {
  assertOpenCodeHarnessEnabled();
  if (generation !== expected)
    throw new Error('OpenCode connection changed. Try again.');
}

export interface ManagedOpenCodeRuntime {
  runtimeIdentity: {
    version: string;
    executableSha256?: string;
    platform: string;
  };
  executable: string;
  spawnProcess: ProviderProcessSpawner;
  processOwner: OpenCodeProcessOwner;
  env: NodeJS.ProcessEnv;
  providerConfig: Record<string, unknown>;
  generation: number;
  signal: AbortSignal;
  close(): Promise<void>;
}

export async function openManagedOpenCodeRuntime(options: {
  signal: AbortSignal;
  workspaceId?: string;
  requireEnabled?: boolean;
  restrictedEnvironment?: boolean;
  /** Host-managed routes must not load unrelated native provider settings. */
  providerConfiguration?: 'host-inference';
  executionKind?: 'agent' | 'pipeline';
  environment?: Record<string, string>;
}): Promise<ManagedOpenCodeRuntime> {
  assertOpenCodeHarnessEnabled();
  observeRollout();
  if (connecting && options.requireEnabled !== false)
    throw new Error('OpenCode setup is still in progress.');
  const epoch = generation;
  const processOwner = openCodeProcessOwner(options.executionKind);
  const abort = new AbortController();
  const signal = AbortSignal.any([options.signal, abort.signal]);
  let finish: () => void = () => undefined;
  const record = {
    abort,
    done: new Promise<void>((resolve) => {
      finish = resolve;
    }),
  };
  live.add(record);
  const close = (): Promise<void> => {
    live.delete(record);
    finish();
    return Promise.resolve();
  };
  try {
    const preferences = await readPreferencesFile();
    if (options.requireEnabled !== false && !preferences.opencodeEnabled)
      throw new Error('Connect OpenCode in Settings.');
    const executable = await installer().verify(signal);
    const env = {
      ...getEnhancedEnv({
        includeCanopySecrets: false,
        environment: options.workspaceId
          ? {
              runtime: options.executionKind ?? 'agent',
              workspaceId: options.workspaceId,
            }
          : false,
      }),
      ...Object.fromEntries(
        Object.entries(
          withoutStepStartupInjection(options.environment ?? {}),
        ).filter(
          ([key]) =>
            ![
              'HOME',
              'USERPROFILE',
              'HOMEDRIVE',
              'HOMEPATH',
              'HOMESHARE',
            ].includes(key.toUpperCase()),
        ),
      ),
    };
    const providerConfig =
      options.providerConfiguration === 'host-inference'
        ? {}
        : await readOpenCodeProviderConfig(env);
    signal.throwIfAborted();
    assertOpenCodeConnectionGeneration(epoch);
    return {
      runtimeIdentity: {
        version: OPENCODE_RUNTIME_VERSION,
        executableSha256: artifact()?.executableSha256,
        platform: `${hostPlatformOperatingSystem()}-${process.arch}`,
      },
      executable,
      spawnProcess: spawnOpenCodeProcessForWorkerRun,
      processOwner,
      env: options.restrictedEnvironment
        ? buildDelegationCursorEnvironment(env)
        : env,
      providerConfig,
      signal,
      generation: epoch,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function revokeOpenCodeRuntimes(): Promise<void> {
  generation++;
  if (!connecting) observedAccountIdentities = undefined;
  cached = undefined;
  publishOpenCodeAccounts(undefined);
  invalidateOpenCodeRuntimeAvailability();
  discovery?.controller.abort();
  discovery = undefined;
  initOpenCodeModels([]);
  const pending = Array.from(live);
  for (const record of pending) record.abort.abort();
  await Promise.allSettled(pending.map((record) => record.done));
}

async function discover(
  signal: AbortSignal,
  requireEnabled: boolean,
  context?: { runtime: ManagedOpenCodeRuntime; cwd: string },
): Promise<DiscoveryResult> {
  const managed =
    context?.runtime ??
    (await openManagedOpenCodeRuntime({ signal, requireEnabled }));
  let directory: string | undefined;
  try {
    managed.signal.throwIfAborted();
    assertOpenCodeConnectionGeneration(managed.generation);
    directory = await mkdtemp(join(tmpdir(), 'opencode-discovery-'));
    const cwd = context?.cwd ?? directory;
    const { startOpenCodeRuntime } =
      await import('@canopy/desktop-shared/node/opencode/runtime');
    // Once session/new starts, allow its bounded request and deletion to finish
    // even if discovery is cancelled. Killing that process first would strand
    // the temporary session in the user's credential/session database.
    const discoveryAbort = new AbortController();
    const abortStartup = (): void => discoveryAbort.abort();
    managed.signal.addEventListener('abort', abortStartup, { once: true });
    if (managed.signal.aborted) abortStartup();
    const runtime = await startOpenCodeRuntime({
      ...managed,
      cwd,
      profileDir: context
        ? join(directory, 'profile')
        : join(getOpenCodeRuntimeStateDir(), 'discovery'),
      authorize: () => Promise.resolve({ decision: 'deny' }),
      onUpdate: () => undefined,
      signal: discoveryAbort.signal,
    }).finally(() => managed.signal.removeEventListener('abort', abortStartup));
    let sessionId: string | undefined;
    let models: OpenCodeModelEntry[];
    let accounts: OpenCodeAccountSnapshot = unavailableAccounts();
    try {
      managed.signal.throwIfAborted();
      const session = await runtime.client.newSession({
        cwd,
        mcpServers: [],
      });
      sessionId = session.sessionId;
      managed.signal.throwIfAborted();
      runtime.assertApprovalReady();
      models = enrichOpenCodeModels(
        openCodeModelsFromConfig(session.configOptions ?? []),
        await runtime.readMetadata('/models'),
      );
      // Scoped pipeline/delegation discovery must never replace global accounts.
      if (!context) {
        const metadata = await runtime
          .readMetadata('/accounts')
          .catch(() => undefined);
        const parsed = openCodeAccountMetadataSchema.safeParse(metadata);
        accounts = parsed.success
          ? {
              status: 'ready',
              updatedAt: new Date().toISOString(),
              providers: parsed.data.providers,
            }
          : unavailableAccounts();
      }
    } finally {
      try {
        if (sessionId) await runtime.client.deleteSession(sessionId);
      } finally {
        await runtime.close();
      }
    }
    assertOpenCodeConnectionGeneration(managed.generation);
    managed.signal.throwIfAborted();
    // Publish only after native session deletion and runtime teardown succeed.
    if (requireEnabled && !context) {
      cached = {
        generation: managed.generation,
        expires: Date.now() + 60_000,
        models,
      };
      initOpenCodeModels(models);
      publishOpenCodeAccounts(accounts);
      observeOpenCodeConnection(
        pendingInAppAccountConnection ? 'in_app' : 'read',
      );
      pendingInAppAccountConnection = false;
    }
    return { models, accounts };
  } finally {
    if (!context) await managed.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

export async function listOpenCodeModels(
  signal: AbortSignal,
): Promise<OpenCodeModelEntry[]> {
  signal.throwIfAborted();
  const preferences = await readPreferencesFile();
  signal.throwIfAborted();
  if (!isOpenCodeHarnessEnabled() || !preferences.opencodeEnabled || connecting)
    return [];
  const clone = (models: readonly OpenCodeModelEntry[]): OpenCodeModelEntry[] =>
    models.map((entry) => ({
      ...entry,
      supportedThinkingLevels: [...entry.supportedThinkingLevels],
    }));
  if (cached?.generation === generation && cached.expires > Date.now())
    return clone(cached.models);
  if (!discovery) {
    const controller = new AbortController();
    const epoch = generation;
    const current: Discovery = {
      controller,
      waiters: 0,
      promise: discover(
        AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
        true,
      )
        .then((result) => result.models)
        .catch((error: unknown) => {
          if (
            epoch === generation &&
            isOpenCodeHarnessEnabled() &&
            !controller.signal.aborted
          )
            publishOpenCodeAccounts(unavailableAccounts());
          throw error;
        }),
    };
    discovery = current;
    void current.promise
      .finally(() => {
        if (discovery === current) discovery = undefined;
      })
      .catch(() => undefined);
  }
  const current = discovery;
  current.waiters++;
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (): boolean => {
      if (done) return false;
      done = true;
      signal.removeEventListener('abort', abort);
      current.waiters--;
      if (!current.waiters) {
        current.controller.abort();
        if (discovery === current) discovery = undefined;
      }
      return true;
    };
    const abort = (): void => {
      if (finish()) reject(new Error('OpenCode model discovery cancelled.'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    void current.promise.then(
      (models) => {
        if (finish()) resolve(clone(models));
      },
      (error: unknown) => {
        if (finish())
          reject(
            error instanceof Error
              ? error
              : new Error('OpenCode model discovery failed.'),
          );
      },
    );
  });
}

function openCodeConnectionMethod(): ConnectionMethod {
  const accounts = (peekOpenCodeAccounts()?.providers ?? [])
    .flatMap((provider) => provider.accounts)
    .filter((account) => !account.needsSignIn);
  if (
    accounts.some(
      (account) => account.method === 'key' || account.method === 'env',
    )
  )
    return 'api_key';
  return accounts.length > 0 ? 'native_login' : 'provider_runtime';
}

let pendingInAppAccountConnection = false;
let observedAccountIdentities: string[] | undefined;

function observeOpenCodeRuntime(
  connected: boolean,
  via: 'read' | 'in_app',
): void {
  observeProviderConnection({
    provider: 'opencode',
    connectionMethod: openCodeConnectionMethod(),
    via,
    scope: 'runtime',
    fingerprint: connected ? 'runtime' : null,
  });
}

function resetOpenCodeAccountConnection(): void {
  observedAccountIdentities = undefined;
  observeProviderConnection({
    provider: 'opencode',
    connectionMethod: 'native_login',
    via: 'read',
    scope: 'accounts',
    fingerprint: null,
  });
}

function observeOpenCodeConnection(
  via: 'read' | 'in_app',
  baselineOnly = false,
): void {
  const snapshot = peekOpenCodeAccounts();
  // Unavailable metadata is not account loss. Retain the last known baseline.
  if (snapshot?.status !== 'ready') return;
  const identities = snapshot.providers
    .flatMap((provider) =>
      provider.accounts
        .filter((account) => !account.needsSignIn)
        .map((account) =>
          JSON.stringify([provider.id, account.method, account.label]),
        ),
    )
    .sort();
  const lossOnly =
    observedAccountIdentities !== undefined &&
    identities.every((identity) =>
      observedAccountIdentities?.includes(identity),
    );
  observedAccountIdentities = identities;
  observeProviderConnection({
    provider: 'opencode',
    connectionMethod: openCodeConnectionMethod(),
    via,
    scope: 'accounts',
    fingerprint: identities.length > 0 ? JSON.stringify(identities) : null,
    baselineOnly: baselineOnly || lossOnly,
  });
}

export async function connectOpenCode(
  signal: AbortSignal,
  progress: (status: OpenCodeConnectionStatus) => void,
): Promise<OpenCodeConnectionStatus> {
  return withProviderConnectionAttempt(
    'opencode',
    openCodeConnectionMethod(),
    signal,
    async () => {
      const previous = await opencodeConnectionStatus();
      const newRuntimeConnection = !previous.installed || !previous.enabled;
      const connected = await connectOpenCodeImpl(signal, progress);
      if (connected.phase === 'connected') {
        observeOpenCodeRuntime(true, 'in_app');
        // A new runtime event already carries the discovered account method.
        observeOpenCodeConnection('in_app', newRuntimeConnection);
      }
      return connected;
    },
  );
}

async function connectOpenCodeImpl(
  signal: AbortSignal,
  progress: (status: OpenCodeConnectionStatus) => void,
): Promise<OpenCodeConnectionStatus> {
  assertOpenCodeHarnessEnabled();
  observeRollout();
  if (connecting) throw new Error('OpenCode setup is already running.');
  connecting = true;
  const controller = new AbortController();
  setupAbort = controller;
  signal = AbortSignal.any([signal, controller.signal]);
  let epoch = generation;
  let enabledRevision: number | undefined;
  try {
    await revokeOpenCodeRuntimes();
    epoch = generation;
    await updatePreferencesFile((preferences) => ({
      ...preferences,
      opencodeEnabled: false,
    }));
    broadcastPreferencesChanged();
    const base = await opencodeConnectionStatus();
    await installer().install(signal, (phase, percent) =>
      progress({ ...base, phase, percent }),
    );
    progress({ ...base, installed: true, phase: 'discovering' });
    const { models, accounts } = await discover(signal, false);
    signal.throwIfAborted();
    await updatePreferencesFile(
      (preferences) => {
        signal.throwIfAborted();
        assertOpenCodeConnectionGeneration(epoch);
        return { ...preferences, opencodeEnabled: true };
      },
      () => {
        enabledRevision = getOpenCodeEnabledRevision();
      },
    );
    signal.throwIfAborted();
    assertOpenCodeConnectionGeneration(epoch);
    // Keep the final asynchronous status read inside our rollback boundary.
    const status = await opencodeConnectionStatus();
    signal.throwIfAborted();
    assertOpenCodeConnectionGeneration(epoch);
    cached = { generation: epoch, expires: Date.now() + 60_000, models };
    initOpenCodeModels(models);
    publishOpenCodeAccounts(accounts);
    // Public status suppresses availability while setup is pending. This reply
    // describes the committed result after the final cancellation check.
    // Publish that same result for Portal snapshots without another status IPC.
    // `status.enabled` is false while `connecting` is set, so it is left out.
    // Keep no await between here and the `finally` that clears `connecting`:
    // a status read started in between would publish false again.
    beginOpenCodeAvailabilityProbe()(status.supported && status.installed);
    return {
      ...status,
      enabled: true,
      phase: status.installed ? 'connected' : 'idle',
    };
  } catch (error) {
    // Revocation can change the runtime generation during the durable write.
    // Roll back our own committed enablement, preserving later user changes.
    if (enabledRevision !== undefined) {
      await updatePreferencesFile((preferences) =>
        getOpenCodeEnabledRevision() === enabledRevision
          ? { ...preferences, opencodeEnabled: false }
          : null,
      );
    }
    throw error;
  } finally {
    if (setupAbort === controller) setupAbort = undefined;
    connecting = false;
    broadcastPreferencesChanged();
  }
}

export async function disconnectOpenCode(): Promise<void> {
  await updatePreferencesFile((preferences) => ({
    ...preferences,
    opencodeEnabled: false,
  }));
  observeOpenCodeRuntime(false, 'in_app');
  resetOpenCodeAccountConnection();
  try {
    await revokeOpenCodeRuntimes();
  } finally {
    broadcastPreferencesChanged();
  }
}

export async function assertOpenCodeModelAvailable(
  model: string | undefined,
  signal: AbortSignal = AbortSignal.timeout(60_000),
): Promise<OpenCodeModelEntry> {
  return findAvailableModel(model, await listOpenCodeModels(signal));
}

/** Scoped discovery owns only its temporary ACP runtime; the caller owns the lease. */
export async function assertOpenCodeRuntimeModelAvailable(
  model: string | undefined,
  runtime: ManagedOpenCodeRuntime,
  cwd: string,
): Promise<OpenCodeModelEntry> {
  return findAvailableModel(
    model,
    (await discover(runtime.signal, true, { runtime, cwd })).models,
  );
}

function findAvailableModel(
  model: string | undefined,
  models: readonly OpenCodeModelEntry[],
): OpenCodeModelEntry {
  // Pickers and preflight callers may hold a custom Agent identity. Match its
  // canonical provider model without changing the selected Agent or its policy.
  const runtimeModel =
    model === undefined ? undefined : resolveRuntimeModel(model);
  const entry = models.find((entry) => entry.id === runtimeModel);
  if (!entry)
    throw new Error(
      'This OpenCode model is unavailable. Choose another model.',
    );
  return entry;
}

export function getOpenCodeConnectionGeneration(): number {
  return generation;
}

function unavailableAccounts(): OpenCodeAccountSnapshot {
  return {
    status: 'unavailable',
    updatedAt: new Date().toISOString(),
    providers: [],
  };
}

/** Explicit refresh joins owned discovery. Snapshot reads never start a process. */
export async function refreshOpenCodeAccounts(
  signal: AbortSignal = AbortSignal.timeout(60_000),
  via: 'read' | 'in_app' = 'read',
): Promise<void> {
  const epoch = generation;
  if (via === 'in_app') pendingInAppAccountConnection = true;
  try {
    const preferences = await readPreferencesFile();
    if (epoch !== generation) return;
    if (
      !isOpenCodeHarnessEnabled() ||
      !preferences.opencodeEnabled ||
      connecting
    ) {
      publishOpenCodeAccounts(undefined);
      return;
    }
    // An in-flight model discovery already reads accounts; keep its waiters alive.
    if (!discovery) cached = undefined;
    await listOpenCodeModels(signal);
  } catch {
    if (epoch === generation && isOpenCodeHarnessEnabled())
      publishOpenCodeAccounts(unavailableAccounts());
  } finally {
    if (via === 'in_app') pendingInAppAccountConnection = false;
  }
}
