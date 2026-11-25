import { authorizeCopilotSetup } from '@canopy/desktop-shared/node/copilot/setup-flow';
import {
  observeProviderConnection,
  withProviderConnectionAttempt,
} from '../lib/provider-connection-events';
import type { CopilotAccountUsage } from '@canopy/desktop-shared/types/copilot-connection';
import { getFeatureFlagService } from '../feature-flags';
import { notifyCopilotUsageChanged } from './usage-events';
import { buildDelegationCursorEnvironment } from '@canopy/desktop-shared/node/delegation/environment';
import { withoutStepStartupInjection } from '@canopy/desktop-shared/node/provider-process/step-environment';
import type {
  CopilotAccount,
  CopilotConnectionStatus,
  CopilotModelEntry,
} from '@canopy/desktop-shared/types';
import { initCopilotModels } from '@canopy/desktop-shared/types';
import {
  isCopilotModel,
  copilotModelsFromSdk,
} from '@canopy/execution-engine/lib/copilot-models';
import {
  getCopilotRuntimeRootDir,
  getCopilotRuntimeReceiptsDir,
  getCopilotRuntimeStateDir,
} from '@canopy/execution-engine/pipelines/config-paths';
import {
  copilotExecutableName,
  getCopilotRuntimeArtifact,
  COPILOT_RUNTIME_VERSION,
} from '@canopy/desktop-shared/node/copilot/runtime-metadata';
import {
  startCopilotRuntime,
  type OwnedCopilotRuntime,
} from '@canopy/copilot-recipient/runtime';
import { copilotReceiptStorage } from '@canopy/desktop-shared/node/copilot/receipt-storage';
import { reapCopilotProcessReceipts } from '@canopy/copilot-recipient/process-receipts';
import { runCopilotTurn } from '@canopy/copilot-recipient/turn-driver';
import type { CopilotRecipientHandle } from '@canopy/desktop-shared/node/copilot/recipient-handle';
import type { ProviderProcessRequest } from '@canopy/desktop-shared/node/provider-process/spawn';
import { spawnProviderProcess } from '../agent-runs/provider-process-host';
import { probeCopilotRotationAttempt } from './rotation-attempt';
import type { GitHubTokenProvider } from '@github/copilot-sdk';
import {
  CopilotRecipient,
  type CopilotRecipientLease,
  type CopilotLeasePurpose,
} from './recipient';
import {
  pollDeviceFlow,
  refreshDeviceGrant,
  startDeviceFlow,
  type DeviceFlowOptions,
} from '@canopy/desktop-shared/node/copilot/device-flow';
import { sameCopilotAccount } from '@canopy/desktop-shared/node/copilot/auth';
import { BRAND } from '@canopy/brand/current';
import { getEnhancedEnv } from '../pipelines/config-paths';
import { isE2eBuild } from '../lib/e2e-gate';
import { loadOctokitConstructor } from '../lib/github-octokit-loader';
import { resolveOctokitClientOptions } from '../lib/github-octokit-options';
import {
  readPreferencesFile,
  updatePreferencesFile,
} from '../lib/preferences-store';
import {
  assertCopilotHarnessEnabled,
  isCopilotHarnessEnabled,
} from './feature-flag';
import { CopilotRuntimeInstaller } from './runtime-installer';
import {
  beginCopilotAvailabilityProbe,
  invalidateCopilotRuntimeAvailability,
} from './runtime-availability';
import {
  clearCopilotGrant,
  drainCopilotGrant,
  resetCopilotGrantFenceForTests,
  resumeCopilotGrant,
  commitCopilotGrant,
  copilotGrantAuthority,
  deleteCopilotGrant,
  isCopilotCredentialStorageAvailable,
  readCopilotCredential,
  type CopilotCredential,
  type CopilotGrant,
  type CopilotGrantHandle,
  type CopilotAccountEpoch,
} from './grant-authority';
import {
  CopilotSignInChangedError,
  CopilotSignInExpiredError,
  untilAborted,
} from './credential-broker';
import { describeCopilotServiceRefusal } from './service-errors';

const GITHUB_HOST = 'https://github.com';
/**
 * Setup covers the runtime download plus GitHub's device code, which lives
 * for 15 minutes; the cap must outlast the code so an expiry is reported as
 * such rather than as a cut-off.
 */
export const COPILOT_SETUP_TIMEOUT_MS = 30 * 60_000;
/** The runtime download has its own cap so it cannot eat into the code's lifetime. */
export const COPILOT_INSTALL_TIMEOUT_MS = 10 * 60_000;

let generation = 0;
/** Status reads also span sign-out inside setup, which keeps its runtime epoch. */
let observationGeneration = 0;
/** Quit is terminal: no runtime may start once teardown has chosen its live set. */
let shutDown = false;
function assertCopilotAdmissionOpen(): void {
  if (shutDown) throw new Error('Copilot is shutting down.');
}
let recovery: Promise<void> | undefined;
export function recoverCopilotAtStartup(): Promise<void> {
  recovery ??= (async (): Promise<void> => {
    // Presence is evidence of an uncertain exchange, never a reason to alter a grant.
    if ((await probeCopilotRotationAttempt()) === 'present')
      process.emitWarning(
        'A Copilot rotation was interrupted; the stored grant is unchanged.',
        { code: 'COPILOT_ROTATION_UNCERTAIN' },
      );
    await reapCopilotProcessReceipts(
      getCopilotRuntimeReceiptsDir(),
      copilotReceiptStorage,
    );
  })().catch((error: unknown): never => {
    // Retry on the next demand after an inspection/cleanup failure, but never
    // re-run a successful pass against receipts admitted during this boot.
    recovery = undefined;
    throw error;
  });
  return recovery;
}
let activeSetup:
  | { token: symbol; abort: AbortController; done: Promise<void> }
  | undefined;
let observingRollout = false;
function observeRollout(): void {
  if (observingRollout) return;
  observingRollout = true;
  getFeatureFlagService().onSnapshotChanged(() => {
    if (!isCopilotHarnessEnabled())
      void revokeCopilotRuntimes().catch(() => undefined);
  });
}
const live = new Set<{ abort: AbortController; done: Promise<void> }>();
let cachedModels:
  | {
      generation: number;
      accountEpoch: CopilotAccountEpoch;
      expires: number;
      models: CopilotModelEntry[];
    }
  | undefined;
let discovery:
  | {
      generation: number;
      accountEpoch: CopilotAccountEpoch;
      operation: Promise<CopilotModelEntry[]>;
    }
  | undefined;

function sameAccountEpoch(
  left: CopilotAccountEpoch,
  right: CopilotAccountEpoch,
): boolean {
  return (
    left.host === right.host &&
    left.id === right.id &&
    left.entryId === right.entryId
  );
}

async function modelAccountEpoch(
  source: CopilotGrantHandle,
  signal: AbortSignal,
  expectedGeneration: number,
): Promise<CopilotAccountEpoch> {
  try {
    return await untilAborted(source.binding(), signal);
  } catch (error) {
    signal.throwIfAborted();
    assertCopilotConnectionGeneration(expectedGeneration);
    if (error instanceof CopilotSignInChangedError)
      throw new Error('Copilot connection was revoked.');
    throw error;
  }
}

function runtimeArtifact(): ReturnType<typeof getCopilotRuntimeArtifact> {
  const artifact = getCopilotRuntimeArtifact();
  if (
    !artifact ||
    typeof __CANOPY_E2E__ === 'undefined' ||
    !__CANOPY_E2E__ ||
    !process.env.CANOPY_E2E_COPILOT_RUNTIME
  )
    return artifact;
  const value: unknown = JSON.parse(process.env.CANOPY_E2E_COPILOT_RUNTIME);
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !('url' in value) ||
    !('integrity' in value) ||
    !('executableSha256' in value) ||
    !('archiveBytes' in value) ||
    typeof value.url !== 'string' ||
    typeof value.integrity !== 'string' ||
    typeof value.executableSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.executableSha256) ||
    typeof value.archiveBytes !== 'number' ||
    !Number.isSafeInteger(value.archiveBytes) ||
    value.archiveBytes <= 0 ||
    value.archiveBytes > 1024 * 1024
  )
    throw new Error('Invalid Copilot runtime test fixture.');
  return {
    version: artifact.version,
    url: value.url,
    integrity: value.integrity,
    executableSha256: value.executableSha256,
    archiveBytes: value.archiveBytes,
  };
}

function installer(): CopilotRuntimeInstaller {
  const artifact = runtimeArtifact();
  if (!artifact)
    throw new Error('GitHub Copilot is not available on this device.');
  return new CopilotRuntimeInstaller({
    root: getCopilotRuntimeRootDir(),
    artifact,
    executableName: copilotExecutableName(),
    allowLoopback: typeof __CANOPY_E2E__ !== 'undefined' && __CANOPY_E2E__,
  });
}

/** The brand's GitHub App; its client id is public and never a secret. */
function deviceFlowOptions(): DeviceFlowOptions {
  const clientId = BRAND.copilot?.gitHubAppClientId;
  if (!clientId)
    throw new Error("GitHub Copilot sign-in isn't set up for this build.");
  const override = isE2eBuild()
    ? process.env.CANOPY_GITHUB_OAUTH_BASE_URL?.trim()
    : undefined;
  return { clientId, baseUrl: override || undefined };
}

/**
 * Every consumer in this process, in every runtime generation, shares the
 * account epoch's one grant authority, so a refresh is single-flight across
 * chats, discovery, usage reads and handles kept past a revoke.
 */
function grantAuthority(pin: CopilotAccount | undefined): CopilotGrantHandle {
  const options = deviceFlowOptions();
  return copilotGrantAuthority(pin, {
    refresh: (refreshToken, signal) =>
      refreshDeviceGrant(options, refreshToken, signal),
    onCleared: () => {
      // A rejected refresh signs the user out mid-session; the UI must learn
      // it now rather than at the next status probe.
      observationGeneration++;
      invalidateCopilotRuntimeAvailability();
      cachedModels = undefined;
    },
  });
}

function isTransportFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket|network|timed? ?out|closed|exited/i.test(
    message,
  );
}

async function resolveGitHubIdentity(
  token: string,
  signal: AbortSignal,
): Promise<{ login: string; id: string }> {
  const Octokit = loadOctokitConstructor();
  const octokit = new Octokit(resolveOctokitClientOptions(token));
  const { data } = await octokit.rest.users.getAuthenticated({
    request: { signal },
  });
  if (
    typeof data.login !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(data.login)
  )
    throw new Error('GitHub did not return a usable account.');
  return { login: data.login, id: String(data.id) };
}

/** The credential and the pin are both app-owned; only a matching pair counts. */
async function signedInAccount(preferences: {
  copilotAccount?: CopilotAccount;
}): Promise<CopilotAccount | null> {
  const pin = preferences.copilotAccount;
  if (!pin) return null;
  const read = await readCopilotCredential();
  if (read.status !== 'present') return null;
  // A refresh token that has lapsed cannot be renewed; the sign-in is over.
  if (Date.parse(read.credential.refreshTokenExpiresAt) <= Date.now())
    return null;
  return sameCopilotAccount(
    { host: read.credential.host, login: read.credential.login },
    pin,
  )
    ? pin
    : null;
}

/**
 * What a failed create left installed, such as an entry whose directory sync
 * failed after its rename. GitHub issues each refresh token once, so only that
 * create can have stored this one; an unreadable store could hold either.
 */
async function entryLeftByFailedCreate(
  grant: CopilotGrant,
): Promise<
  | { status: 'installed'; credential: CopilotCredential }
  | { status: 'none' }
  | { status: 'unknown' }
> {
  const read = await readCopilotCredential();
  if (read.status === 'unreadable') return { status: 'unknown' };
  return read.status === 'present' &&
    read.credential.refreshToken === grant.refreshToken
    ? { status: 'installed', credential: read.credential }
    : { status: 'none' };
}

/**
 * Copilot is still chosen in Settings but its sign-in is gone: a rejected
 * refresh cleared the credential (often during the startup quota probe), or
 * the refresh token lapsed. Status reads that as not connected; model
 * requests report the expiry, as the broker does whenever it finds no
 * credential, until the user reconnects or disconnects.
 */
async function signInExpired(): Promise<boolean> {
  if (activeSetup) return false;
  const preferences = await readPreferencesFile();
  if (preferences.copilotEnabled !== true || !preferences.copilotAccount)
    return false;
  const read = await readCopilotCredential();
  return (
    read.status === 'absent' ||
    (read.status === 'present' &&
      Date.parse(read.credential.refreshTokenExpiresAt) <= Date.now())
  );
}

export async function copilotConnectionStatus(): Promise<CopilotConnectionStatus> {
  const epoch = observationGeneration;
  const cache = beginCopilotAvailabilityProbe();
  try {
    const artifact = runtimeArtifact();
    const preferences = await readPreferencesFile();
    const installed = !!artifact && (await installer().isInstalled());
    const account = artifact ? await signedInAccount(preferences) : null;
    const enabled =
      epoch === observationGeneration &&
      !shutDown &&
      !activeSetup &&
      isCopilotHarnessEnabled() &&
      preferences.copilotEnabled === true &&
      account !== null;
    cache(!!artifact && installed && enabled);
    // A missing public account can also mean an unreadable credential. Only
    // positive reads establish a baseline; committed sign-out clears it below.
    if (!activeSetup && enabled && installed && account)
      observeProviderConnection({
        provider: 'copilot',
        connectionMethod: 'native_login',
        via: 'read',
        fingerprint: `${account.host}:${account.login}`,
      });
    return {
      supported: !!artifact,
      installed,
      enabled,
      version: COPILOT_RUNTIME_VERSION,
      phase: enabled && installed ? 'connected' : 'idle',
      archiveBytes: artifact?.archiveBytes,
      account: enabled ? account : null,
    };
  } catch (error) {
    cache(false);
    throw error;
  }
}

export interface ManagedCopilotRuntimeOptions {
  owner: ProviderProcessRequest['owner'];
  signal: AbortSignal;
  cwd?: string;
  workspaceId?: string;
  requireAccount?: boolean;
  purpose?: CopilotLeasePurpose;
  executionKind?: 'agent' | 'pipeline';
  restrictedEnvironment?: boolean;
  environment?: Record<string, string>;
}

/**
 * All managed consumers share revocation and carry the app-held identity.
 * They receive results only; the client and its leases stay in this module.
 */
export async function openManagedCopilotRuntime(
  options: ManagedCopilotRuntimeOptions,
): Promise<CopilotRecipientHandle> {
  return (await openCopilotRuntime(options)).handle;
}

interface OpenedCopilotRecipient {
  handle: CopilotRecipientHandle;
  /** Setup only: proves catalog access; discovery validates the catalog. */
  probeAccess(signal: AbortSignal): Promise<void>;
}

async function openCopilotRuntime(
  options: ManagedCopilotRuntimeOptions,
  setupToken?: symbol,
  setupGrant?: CopilotGrant,
): Promise<OpenedCopilotRecipient> {
  assertCopilotAdmissionOpen();
  assertCopilotHarnessEnabled();
  const verifiedInstaller = installer();
  if (activeSetup && activeSetup.token !== setupToken)
    throw new Error(
      'Copilot account setup is in progress. Try again when it finishes.',
    );
  observeRollout();
  const epoch = generation;
  const abort = new AbortController();
  const signal = AbortSignal.any([options.signal, abort.signal]);
  let finish!: () => void;
  const record = {
    abort,
    done: new Promise<void>((resolve) => {
      finish = resolve;
    }),
  };
  live.add(record);
  let runtime: OwnedCopilotRuntime | undefined;
  let closing: Promise<void> | undefined;
  let recipient: CopilotRecipient | undefined;
  const onAbort = (): void => {
    void close().catch(() => undefined);
  };
  const close = (): Promise<void> => {
    recipient?.revoke();
    closing ??= (async (): Promise<void> => {
      try {
        await runtime?.close();
      } finally {
        signal.removeEventListener('abort', onAbort);
        live.delete(record);
        finish();
      }
    })();
    return closing;
  };
  try {
    await recoverCopilotAtStartup();
    const preferences = await readPreferencesFile();
    const requireAccount = options.requireAccount !== false;
    if (requireAccount && !preferences.copilotEnabled)
      throw new Error('Connect GitHub Copilot in Settings.');
    // Capability admission precedes both lease minting and grant presentation.
    const executable = await verifiedInstaller.verify(signal);
    const source = requireAccount
      ? grantAuthority(preferences.copilotAccount)
      : undefined;
    const binding = setupGrant
      ? {
          host: setupGrant.host,
          id: setupGrant.id,
          entryId: `setup:${String(setupToken)}`,
        }
      : await source?.binding();
    if (!binding) throw new Error('Copilot runtime is unavailable.');
    assertCopilotAdmissionOpen();
    assertCopilotHarnessEnabled();
    if (epoch !== generation)
      throw new Error('Copilot connection changed. Try again.');
    const baseEnvironment = getEnhancedEnv({
      includeCanopySecrets: false,
      environment: options.workspaceId
        ? {
            runtime: options.executionKind ?? 'agent',
            workspaceId: options.workspaceId,
          }
        : false,
    });
    runtime = await startCopilotRuntime({
      spawnProcess: spawnProviderProcess,
      owner: options.owner,
      executable,
      expectedVersion: COPILOT_RUNTIME_VERSION,
      workingDirectory: options.cwd ?? getCopilotRuntimeStateDir(),
      stateDirectory: getCopilotRuntimeStateDir(),
      receiptDirectory: getCopilotRuntimeReceiptsDir(),
      receiptStorage: copilotReceiptStorage,
      env: {
        ...(options.restrictedEnvironment
          ? buildDelegationCursorEnvironment(baseEnvironment)
          : baseEnvironment),
        // A pipeline step's own loader or shell-startup variables would run
        // code in the runtime before any tool approval; never pass them on.
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
      },
      signal,
    });
    // Parent exit is only the beginning of cleanup: tools can outlive it.
    // Keep the ownership record until the runtime reaps those descendants.
    signal.addEventListener('abort', onAbort, { once: true });
    void runtime.exited.then(close, close).catch(() => undefined);
    signal.throwIfAborted();
    if (epoch !== generation)
      throw new Error('Copilot connection changed. Try again.');
    const owned = runtime;
    recipient = new CopilotRecipient({
      accountEpoch: binding,
      generation: epoch,
      recipient: owned.identity,
      signal,
      binding: source
        ? (): Promise<CopilotAccountEpoch> => source.binding()
        : (): Promise<CopilotAccountEpoch> => Promise.resolve(binding),
      access: source
        ? (
            requestSignal,
            admit,
          ): Promise<{ accessToken: string; expiresAt: number }> =>
            source.access(requestSignal, admit)
        : (): Promise<{ accessToken: string; expiresAt: number }> => {
            if (!setupGrant) throw new Error('Copilot runtime is unavailable.');
            return Promise.resolve({
              accessToken: setupGrant.accessToken,
              expiresAt: Date.parse(setupGrant.accessTokenExpiresAt),
            });
          },
      assertGeneration: assertCopilotConnectionGeneration,
      isClosed: (): boolean => closing !== undefined || owned.isClosed(),
    });
    const admittedRecipient = recipient;
    const purpose = options.purpose ?? 'session';
    const auth = admittedRecipient.issue(purpose);
    // Session preflight is inside the verified recipient, never before capability.
    if (purpose === 'session') await auth.token(signal);
    const notAdmitted = (): Error =>
      new Error('Copilot lease purpose is not admitted.');
    let sessionLease: CopilotRecipientLease | undefined;
    const tokenProviderForSession = (
      sessionId?: string,
    ): GitHubTokenProvider => {
      // Resume recovery gets a fresh lease, not a relaxed old audience.
      if (sessionLease) admittedRecipient.revokeLease(sessionLease);
      sessionLease = admittedRecipient.issue('session', sessionId);
      return sessionLease.tokenProvider;
    };
    /** One push RPC: deliver the lease's token, then admit the result. */
    const pushOperation = async <T>(
      lease: CopilotRecipientLease,
      requestSignal: AbortSignal,
      call: (gitHubToken: string) => Promise<T>,
    ): Promise<T> => {
      const result = await call(await lease.token(requestSignal));
      await admittedRecipient.admit(lease, lease.purpose);
      return result;
    };
    const readModels = (
      lease: CopilotRecipientLease,
      requestSignal: AbortSignal,
    ): ReturnType<OwnedCopilotRuntime['client']['rpc']['models']['list']> =>
      pushOperation(lease, requestSignal, (gitHubToken) =>
        owned.client.rpc.models.list({ gitHubToken }),
      );
    const handle: CopilotRecipientHandle = {
      account: requireAccount ? (preferences.copilotAccount ?? null) : null,
      generation: epoch,
      close,
      runTurn: async (request) => {
        if (purpose !== 'session') throw notAdmitted();
        return runCopilotTurn({
          ...request,
          gitHubTokenProvider: undefined,
          runtime: {
            exited: owned.exited,
            close,
            client: owned.client,
            tokenProviderForSession,
          },
        });
      },
      listModels: async (requestSignal) => {
        // A session reads thinking-levels metadata on its own one-shot lease.
        const lease =
          purpose === 'session'
            ? admittedRecipient.issue('thinking-levels')
            : purpose === 'models'
              ? auth
              : undefined;
        if (!lease) throw notAdmitted();
        const listed = await readModels(lease, requestSignal);
        return copilotModelsFromSdk(listed.models);
      },
      getQuota: async (requestSignal) => {
        if (purpose !== 'quota') throw notAdmitted();
        return pushOperation(auth, requestSignal, (gitHubToken) =>
          owned.client.rpc.account.getQuota({ gitHubToken }),
        );
      },
    };
    return {
      handle: Object.freeze(handle),
      probeAccess: async (requestSignal): Promise<void> => {
        if (purpose !== 'setup-probe') throw notAdmitted();
        await readModels(auth, requestSignal);
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export function assertCopilotConnectionGeneration(expected: number): void {
  assertCopilotHarnessEnabled();
  if (expected !== generation)
    throw new Error('Copilot connection was revoked.');
}

export async function revokeCopilotRuntimes(): Promise<void> {
  await revokeRuntimes();
}

async function revokeRuntimes(preserveSetup?: symbol): Promise<void> {
  const setup = activeSetup?.token === preserveSetup ? undefined : activeSetup;
  setup?.abort.abort();
  generation++;
  observationGeneration++;
  notifyCopilotUsageChanged(false);
  invalidateCopilotRuntimeAvailability();
  cachedModels = undefined;
  discovery = undefined;
  initCopilotModels([]);
  const pending = Array.from(live);
  for (const record of pending) record.abort.abort();
  await Promise.allSettled([
    ...pending.map((record) => record.done),
    ...(setup ? [setup.done] : []),
  ]);
}

export async function readCopilotAccount(): Promise<CopilotAccount | null> {
  return (await copilotConnectionStatus()).account ?? null;
}

async function writeDisconnectedPreferences(): Promise<void> {
  try {
    await updatePreferencesFile(() => ({
      copilotEnabled: false,
      copilotAccount: undefined,
    }));
  } catch (error) {
    resumeCopilotGrant();
    throw error;
  }
}

async function signOut(): Promise<void> {
  await drainCopilotGrant();
  await writeDisconnectedPreferences();
  // The pin is revoked even if removing its encrypted grant later fails.
  observationGeneration++;
  await clearCopilotGrant();
  observeProviderConnection({
    provider: 'copilot',
    connectionMethod: 'native_login',
    via: 'in_app',
    fingerprint: null,
  });
  invalidateCopilotRuntimeAvailability();
}

export async function connectCopilot(
  signal: AbortSignal,
  progress: (status: CopilotConnectionStatus) => void,
  changeAccount = false,
): Promise<CopilotConnectionStatus> {
  return withProviderConnectionAttempt(
    'copilot',
    'native_login',
    signal,
    async () => {
      await copilotConnectionStatus();
      const connected = await connectCopilotImpl(
        signal,
        progress,
        changeAccount,
      );
      if (connected.phase === 'connected' && connected.account)
        observeProviderConnection({
          provider: 'copilot',
          connectionMethod: 'native_login',
          via: 'in_app',
          fingerprint: `${connected.account.host}:${connected.account.login}`,
        });
      return connected;
    },
  );
}

async function connectCopilotImpl(
  signal: AbortSignal,
  progress: (status: CopilotConnectionStatus) => void,
  changeAccount = false,
): Promise<CopilotConnectionStatus> {
  assertCopilotHarnessEnabled();
  installer();
  if (activeSetup)
    throw new Error('Copilot account setup is already in progress.');
  let finishSetup: () => void = () => undefined;
  const setup = {
    token: Symbol('copilot-setup'),
    abort: new AbortController(),
    done: new Promise<void>((resolve) => {
      finishSetup = resolve;
    }),
  };
  activeSetup = setup;
  signal = AbortSignal.any([signal, setup.abort.signal]);
  try {
    const flow = deviceFlowOptions();
    if (!isCopilotCredentialStorageAvailable())
      throw new Error("Couldn't store the Copilot sign-in on this device.");
    await revokeRuntimes(setup.token);
    const epoch = generation;
    const base = await copilotConnectionStatus();
    await installer().install(
      AbortSignal.any([
        signal,
        AbortSignal.timeout(COPILOT_INSTALL_TIMEOUT_MS),
      ]),
      (phase, percent) => progress({ ...base, phase, percent }),
    );
    assertCopilotConnectionGeneration(epoch);
    if (changeAccount) await signOut();
    const preferences = await readPreferencesFile();
    let account = changeAccount ? null : await signedInAccount(preferences);
    let pending: CopilotGrant | undefined;
    let created: CopilotCredential | undefined;
    if (!account) {
      const start = await startDeviceFlow(flow, signal);
      progress({
        ...base,
        installed: true,
        phase: 'authorizing',
        userCode: start.userCode,
        verificationUri: start.verificationUri,
        expiresAt: start.expiresAt,
      });
      let outcome;
      try {
        outcome = await pollDeviceFlow(flow, start, signal);
      } catch (error) {
        // A cut-off after the code's lifetime is an expiry, not a cancellation.
        if (Date.now() >= Date.parse(start.expiresAt))
          throw new Error('The GitHub code expired. Connect again.');
        throw error;
      }
      if (outcome.status === 'declined')
        throw new Error('GitHub sign-in was declined.');
      if (outcome.status === 'expired')
        throw new Error('The GitHub code expired. Connect again.');
      progress({ ...base, installed: true, phase: 'checking' });
      const identity = await resolveGitHubIdentity(
        outcome.grant.accessToken,
        signal,
      );
      signal.throwIfAborted();
      // Prove Copilot access before anything is saved; the user may have a
      // GitHub account without a Copilot plan.
      const probe = await openCopilotRuntime(
        {
          signal,
          requireAccount: false,
          purpose: 'setup-probe',
          owner: { kind: 'discovery', id: 'copilot-setup-probe' },
        },
        setup.token,
        {
          clientId: flow.clientId,
          host: GITHUB_HOST,
          login: identity.login,
          id: identity.id,
          ...outcome.grant,
        },
      );
      try {
        await probe.probeAccess(signal);
      } catch (error) {
        signal.throwIfAborted();
        if (isTransportFailure(error))
          throw new Error(
            "Couldn't check Copilot access. Check your connection and try again.",
          );
        // A seat that exists but is policy-blocked must not read as no seat.
        throw (
          describeCopilotServiceRefusal(error) ??
          new Error("This GitHub account doesn't have Copilot access.")
        );
      } finally {
        await probe.handle.close();
      }
      signal.throwIfAborted();
      assertCopilotConnectionGeneration(epoch);
      pending = {
        clientId: flow.clientId,
        host: GITHUB_HOST,
        login: identity.login,
        id: identity.id,
        ...outcome.grant,
      };
      account = { host: GITHUB_HOST, login: identity.login };
    }
    try {
      if (pending) created = await commitCopilotGrant(pending);
      signal.throwIfAborted();
      assertCopilotConnectionGeneration(epoch);
      await updatePreferencesFile(() => ({
        copilotEnabled: true,
        copilotAccount: account ?? undefined,
      }));
      if (signal.aborted || generation !== epoch)
        throw new Error('Copilot setup was cancelled.');
    } catch (error) {
      // The grant and the pin are one setup. A grant this setup created must
      // not outlive a pin that never landed; a reused grant is left alone.
      if (pending && !created) {
        const left = await entryLeftByFailedCreate(pending);
        // Nothing this setup saved landed, so the earlier state stands.
        if (left.status === 'none') throw error;
        // An unreadable store may predate this setup: keep it, but disabled.
        if (left.status === 'installed') created = left.credential;
      }
      try {
        // Nothing else creates an entry during setup, so a grant it cannot
        // read back is still the one it created.
        if (created) {
          const rollback = await deleteCopilotGrant({
            entryId: created.entryId,
          });
          if (rollback.status === 'unreadable') await clearCopilotGrant();
        }
      } finally {
        // The removal can fail as the save did; the setup is undone regardless.
        await updatePreferencesFile(() => ({
          copilotEnabled: false,
          ...(created ? { copilotAccount: undefined } : {}),
        }));
      }
      throw error;
    }
    // Publish a fresh account generation before admitting any managed consumer.
    await revokeRuntimes(setup.token);
    signal.throwIfAborted();
    // A newly authorized grant is a real reconnection, including an expired
    // grant replaced by the same account. Failed reads alone never clear it.
    if (pending)
      observeProviderConnection({
        provider: 'copilot',
        connectionMethod: 'native_login',
        via: 'in_app',
        fingerprint: null,
      });
    const connected: CopilotConnectionStatus = {
      ...base,
      installed: true,
      enabled: true,
      phase: 'connected',
      account,
    };
    progress(connected);
    return connected;
  } finally {
    if (activeSetup === setup) activeSetup = undefined;
    finishSetup();
    invalidateCopilotRuntimeAvailability();
    notifyCopilotUsageChanged(true);
  }
}

export function resetCopilotShutdownForTests(): void {
  shutDown = false;
  resetCopilotGrantFenceForTests();
}

export async function shutdownCopilotRuntimes(): Promise<void> {
  // Latched before the live snapshot: a later open can never join teardown.
  shutDown = true;
  const teardown = revokeCopilotRuntimes();
  await Promise.allSettled([drainCopilotGrant(true), teardown]);
}

export async function disconnectCopilot(): Promise<void> {
  installer();
  const teardown = revokeCopilotRuntimes();
  try {
    // Disconnect deletes the native sign-in, just as Change account does.
    await signOut();
  } finally {
    await teardown;
  }
}

export async function listCopilotModels(
  signal: AbortSignal,
): Promise<CopilotModelEntry[]> {
  signal.throwIfAborted();
  assertCopilotHarnessEnabled();
  const deliveryGeneration = generation;
  const status = await copilotConnectionStatus();
  signal.throwIfAborted();
  assertCopilotConnectionGeneration(deliveryGeneration);
  if (!status.supported) return [];
  if (!status.enabled || !status.installed) {
    if (await signInExpired()) throw new CopilotSignInExpiredError();
    return [];
  }
  const source = grantAuthority(status.account ?? undefined);
  const accountEpoch = await modelAccountEpoch(
    source,
    signal,
    deliveryGeneration,
  );
  signal.throwIfAborted();
  assertCopilotConnectionGeneration(deliveryGeneration);
  if (
    cachedModels &&
    !sameAccountEpoch(cachedModels.accountEpoch, accountEpoch)
  )
    cachedModels = undefined;
  if (
    cachedModels?.generation === generation &&
    cachedModels.expires > Date.now()
  )
    return structuredClone(cachedModels.models);
  if (
    !discovery ||
    discovery.generation !== deliveryGeneration ||
    !sameAccountEpoch(discovery.accountEpoch, accountEpoch)
  ) {
    const epoch = generation;
    const operation = (async (): Promise<CopilotModelEntry[]> => {
      // Discovery is shared across callers. Its runtime is owned by the
      // account generation and timeout, never by one caller's cancellation.
      const timeout = AbortSignal.timeout(45_000);
      const runtime = await openManagedCopilotRuntime({
        signal: timeout,
        purpose: 'models',
        owner: { kind: 'discovery', id: 'copilot-models' },
      });
      try {
        let models;
        try {
          models = await runtime.listModels(timeout);
        } catch (error) {
          throw describeCopilotServiceRefusal(error) ?? error;
        }
        await modelAccountEpoch(source, timeout, epoch);
        assertCopilotConnectionGeneration(epoch);
        cachedModels = {
          generation: epoch,
          accountEpoch,
          expires: Date.now() + 60_000,
          models,
        };
        initCopilotModels(models);
        return models;
      } finally {
        await runtime.close();
      }
    })();
    discovery = { generation: epoch, accountEpoch, operation };
    void operation
      .finally(() => {
        if (discovery?.operation === operation) discovery = undefined;
      })
      .catch(() => undefined);
  }
  const models = await waitForModelDiscovery(discovery.operation, signal);
  await modelAccountEpoch(source, signal, deliveryGeneration);
  signal.throwIfAborted();
  assertCopilotConnectionGeneration(deliveryGeneration);
  return structuredClone(models);
}

function waitForModelDiscovery(
  operation: Promise<CopilotModelEntry[]>,
  signal: AbortSignal,
): Promise<CopilotModelEntry[]> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    const onAbort = (): void => {
      cleanup();
      const reason: unknown = signal.reason;
      reject(
        reason instanceof Error
          ? reason
          : new Error('Copilot model discovery cancelled.'),
      );
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void operation.then(
      (models) => {
        cleanup();
        resolve(models);
      },
      (error: unknown) => {
        cleanup();
        reject(
          error instanceof Error
            ? error
            : new Error(
                typeof error === 'string'
                  ? error
                  : 'Copilot model discovery failed.',
              ),
        );
      },
    );
  });
}

/** Validate against this account's policy-filtered catalog before a durable send. */
export async function assertCopilotModelAvailable(
  model: string | undefined,
  signal: AbortSignal = AbortSignal.timeout(45_000),
): Promise<CopilotModelEntry> {
  const epoch = generation;
  const unavailable = (): Error =>
    new Error(
      'This Copilot model is unavailable. Choose another Copilot model and try again.',
    );
  if (!isCopilotModel(model)) throw unavailable();
  const models = await listCopilotModels(signal);
  assertCopilotConnectionGeneration(epoch);
  const selected = models.find((entry) => entry.id === model);
  if (!selected) throw unavailable();
  return selected;
}

export function getCopilotAccountGeneration(): number {
  return generation;
}

export async function readCopilotAccountUsage(
  signal: AbortSignal,
): Promise<CopilotAccountUsage> {
  const runtime = await openManagedCopilotRuntime({
    signal,
    purpose: 'quota',
    owner: { kind: 'discovery', id: 'copilot-quota' },
  });
  try {
    if (!runtime.account)
      throw new Error('Connect Copilot to see account usage.');
    const response = await runtime.getQuota(signal);
    assertCopilotConnectionGeneration(runtime.generation);
    const limits = Object.entries(response.quotaSnapshots)
      .slice(0, 16)
      .flatMap(([id, quota]) => {
        if (!quota || !/^[a-z_]{1,64}$/.test(id)) return [];
        const remaining = quota.remainingPercentage;
        return [
          {
            id,
            label:
              id === 'premium_interactions'
                ? 'Premium requests'
                : id === 'chat'
                  ? 'Chat'
                  : id === 'completions'
                    ? 'Completions'
                    : id.replace(/_/g, ' '),
            unlimited: quota.isUnlimitedEntitlement === true,
            ...(Number.isFinite(remaining) && remaining >= 0 && remaining <= 100
              ? { usedPercent: 100 - remaining }
              : {}),
            ...(quota.resetDate && Number.isFinite(Date.parse(quota.resetDate))
              ? { resetsAt: new Date(quota.resetDate).toISOString() }
              : {}),
          },
        ];
      });
    return { account: runtime.account, limits };
  } finally {
    await runtime.close();
  }
}

/** Installer-only projection: selected vault callers must never inspect legacy custody. */
export async function copilotInstallationStatus(): Promise<CopilotConnectionStatus> {
  const artifact = runtimeArtifact();
  return {
    supported: !!artifact,
    installed: !!artifact && (await installer().isInstalled()),
    enabled: false,
    version: COPILOT_RUNTIME_VERSION,
    phase: 'idle',
    account: null,
    ...(artifact ? { archiveBytes: artifact.archiveBytes } : {}),
  };
}

/** Trusted device/identity ingress, not a consumer result or a grant-read bridge. */
export async function authorizeCopilotDevice(
  signal: AbortSignal,
  progress: (status: CopilotConnectionStatus) => void,
): Promise<CopilotGrant & { version: 1 }> {
  assertCopilotHarnessEnabled();
  return authorizeCopilotSetup({
    flow: deviceFlowOptions(),
    signal,
    progress,
    base: await copilotInstallationStatus(),
    install: (onProgress) =>
      installer().install(
        AbortSignal.any([
          signal,
          AbortSignal.timeout(COPILOT_INSTALL_TIMEOUT_MS),
        ]),
        onProgress,
      ),
    identity: resolveGitHubIdentity,
  });
}
