import { isLabsExperimentAvailability } from '@canopy/protocol/experiments';
import {
  labsContextIdentity,
  type LabsAvailabilityState,
} from './labs-availability';
import {
  CLIENT_FEATURE_FLAG_LAUNCHDARKLY_ENABLED_UNAVAILABLE_DEFAULTS,
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
  isLabsExperimentFlagKey,
  type ClientFeatureFlagKey,
  type ClientFeatureFlagValues,
  type FeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { loadRequiredNodeModule } from '@canopy/desktop-shared/node/lib/packaged-module-loader';
import { app as electronApp } from 'electron';
import type * as LaunchDarklyClientModule from 'launchdarkly-node-client-sdk';
import type { LDClient, LDContext } from 'launchdarkly-node-client-sdk';
import { buildDesktopFeatureFlagContext } from './context';

type SnapshotListener = (snapshot: FeatureFlagSnapshot) => void;

const LAUNCHDARKLY_INIT_TIMEOUT_SECONDS = 5;

/**
 * Delays between LaunchDarkly start attempts after a failed or timed-out start
 * (CAN-3511). The last entry repeats until a start succeeds, so a long outage
 * costs one attempt every ten minutes. Each delay is jittered by up to 20
 * percent so installs that failed together do not retry together.
 */
export const LAUNCHDARKLY_RETRY_DELAYS_MS: readonly number[] = [
  15_000, 30_000, 60_000, 120_000, 300_000, 600_000,
];
const LAUNCHDARKLY_RETRY_JITTER_RATIO = 0.2;

/**
 * Window focus and power resume retry early, but never within this long of the
 * previous attempt starting, so a burst of focus events cannot become a loop.
 */
export const LAUNCHDARKLY_RETRY_TRIGGER_MIN_INTERVAL_MS = 10_000;

/** Early-retry signals installed by `recovery-triggers.ts`. */
export type FeatureFlagRetryTrigger = 'window_focus' | 'power_resume';

/** What started the attempt that ended a LaunchDarkly outage. */
export type FeatureFlagRecoveryTrigger =
  | FeatureFlagRetryTrigger
  | 'backoff'
  | 'context_refresh';

/**
 * App-events diagnostics for a LaunchDarkly outage. Structurally a subset of
 * the observability `AppDiagnosticRecord`; the recorder is injected so this
 * module does not import the observability service (which imports it).
 */
export type FeatureFlagAppDiagnostic =
  | {
      version: 1;
      timestamp: string;
      kind: 'feature_flags_unavailable';
      error: string;
      retryAfterMs: number;
      featureFlagFailedAttempts: number;
      /**
       * `unavailable_fallback`: every flag is on its in-code
       * LaunchDarkly-enabled-unavailable fallback. `last_live`: this process
       * already had live values and keeps them.
       */
      featureFlagValuesSource: 'unavailable_fallback' | 'last_live';
    }
  | {
      version: 1;
      timestamp: string;
      kind: 'feature_flags_recovered';
      featureFlagFailedAttempts: number;
      featureFlagOutageMs: number;
      featureFlagRecoveryTrigger: FeatureFlagRecoveryTrigger;
    };

export interface FeatureFlagServiceOptions {
  /** Source of retry jitter in [0, 1). Defaults to `Math.random`. */
  random?: () => number;
}

interface LaunchDarklyOutage {
  startedAt: number;
  failedAttempts: number;
}

const MAX_DIAGNOSTIC_ERROR_LENGTH = 300;
const E2E_FEATURE_FLAGS_ENV = 'CANOPY_E2E_CLIENT_FEATURE_FLAGS';
/**
 * E2E builds only: points the LaunchDarkly polling, streaming and event
 * endpoints at a local fixture so a spec can fail a start and then recover it.
 * Production bundles compile this branch out with `__CANOPY_E2E__`.
 */
const E2E_LAUNCHDARKLY_BASE_URL_ENV = 'CANOPY_E2E_LAUNCHDARKLY_BASE_URL';
const REGISTERED_CLIENT_FEATURE_FLAG_KEYS = new Set<string>(
  Object.values(CLIENT_FEATURE_FLAGS).map(({ key }) => key),
);

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSamePrimitiveType<T>(value: unknown, defaultValue: T): value is T {
  switch (typeof defaultValue) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'string':
      return typeof value === 'string';
    default:
      return value === defaultValue;
  }
}

function isClientFeatureFlagKey(key: string): key is ClientFeatureFlagKey {
  return REGISTERED_CLIENT_FEATURE_FLAG_KEYS.has(key);
}

function readBundledLaunchDarklyDesktopClientSideId(): string {
  return typeof __CANOPY_LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID__ !== 'undefined'
    ? (__CANOPY_LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID__?.trim() ?? '')
    : '';
}

/** Env sentinel that disables LaunchDarkly in unpackaged dev. */
const LAUNCHDARKLY_DEV_OFF = 'off';

function readLaunchDarklyDesktopClientSideId(isPackaged: boolean): string {
  const bundledValue = readBundledLaunchDarklyDesktopClientSideId();
  if (isPackaged || bundledValue) {
    return bundledValue;
  }

  // Runtime environment fallback is only for unpackaged local development.
  // Packaged apps must use the value baked into the Electron main bundle.
  const envValue = process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID?.trim();
  if (envValue === LAUNCHDARKLY_DEV_OFF) {
    return '';
  }
  if (envValue) {
    return envValue;
  }
  return '';
}

function buildReadySnapshot(client: LDClient): FeatureFlagSnapshot {
  const values = {
    ...CLIENT_FEATURE_FLAG_LAUNCHDARKLY_ENABLED_UNAVAILABLE_DEFAULTS,
  };
  for (const { key } of Object.values(CLIENT_FEATURE_FLAGS)) {
    const fallback =
      CLIENT_FEATURE_FLAG_LAUNCHDARKLY_ENABLED_UNAVAILABLE_DEFAULTS[key];
    const value: unknown = client.variation(key, fallback);
    Object.assign(values, {
      [key]: (
        isLabsExperimentFlagKey(key)
          ? isLabsExperimentAvailability(value)
          : isSamePrimitiveType(value, fallback)
      )
        ? value
        : fallback,
    });
  }
  return {
    values,
    status: 'ready',
    initialized: true,
    updatedAt: nowIso(),
    error: null,
  };
}

function buildE2eOverrideSnapshot(): FeatureFlagSnapshot | null {
  if (!__CANOPY_E2E__) {
    return null;
  }

  const rawOverride = process.env[E2E_FEATURE_FLAGS_ENV]?.trim();
  if (!rawOverride) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawOverride);
  } catch (error) {
    process.stderr.write(
      `[feature-flags] Ignoring invalid ${E2E_FEATURE_FLAGS_ENV}: ${sanitizeError(error)}\n`,
    );
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    process.stderr.write(
      `[feature-flags] Ignoring invalid ${E2E_FEATURE_FLAGS_ENV}: expected a JSON object\n`,
    );
    return null;
  }

  const values: ClientFeatureFlagValues = {
    ...CLIENT_FEATURE_FLAG_LAUNCHDARKLY_ENABLED_UNAVAILABLE_DEFAULTS,
  };
  for (const [key, value] of Object.entries(parsed)) {
    if (!isClientFeatureFlagKey(key)) {
      process.stderr.write(
        `[feature-flags] Ignoring unknown E2E feature flag override "${key}"\n`,
      );
      continue;
    }

    const fallback =
      CLIENT_FEATURE_FLAG_LAUNCHDARKLY_ENABLED_UNAVAILABLE_DEFAULTS[key];
    if (
      !(isLabsExperimentFlagKey(key)
        ? isLabsExperimentAvailability(value)
        : isSamePrimitiveType(value, fallback))
    ) {
      process.stderr.write(
        `[feature-flags] Ignoring E2E feature flag override "${key}": expected ${typeof fallback}\n`,
      );
      continue;
    }
    const validatedValue: unknown = value;
    Object.assign(values, { [key]: validatedValue });
  }

  return {
    values,
    status: 'ready',
    initialized: true,
    updatedAt: nowIso(),
    error: null,
  };
}

function readE2eLaunchDarklyEndpoints(): {
  baseUrl?: string;
  streamUrl?: string;
  eventsUrl?: string;
} {
  if (!__CANOPY_E2E__) {
    return {};
  }
  const baseUrl = process.env[E2E_LAUNCHDARKLY_BASE_URL_ENV]?.trim();
  return baseUrl ? { baseUrl, streamUrl: baseUrl, eventsUrl: baseUrl } : {};
}

function buildErrorSnapshot(
  error: unknown,
  previousSnapshot: FeatureFlagSnapshot,
  preservePreviousValues: boolean,
): FeatureFlagSnapshot {
  const sanitizedError = sanitizeError(error);
  if (preservePreviousValues) {
    return {
      ...previousSnapshot,
      values: { ...previousSnapshot.values },
      status: 'error',
      error: sanitizedError,
      updatedAt: nowIso(),
    };
  }

  return {
    ...getDefaultFeatureFlagSnapshot(
      'error',
      sanitizedError,
      'launchdarkly_enabled_unavailable',
    ),
    updatedAt: nowIso(),
  };
}

function createLogger(): NonNullable<
  Parameters<typeof LaunchDarklyClientModule.initialize>[2]
>['logger'] {
  return {
    debug: (): void => {},
    info: (): void => {},
    warn: (...args: unknown[]): void => {
      process.stderr.write(
        `[feature-flags] LaunchDarkly warning: ${args.map(String).join(' ')}\n`,
      );
    },
    error: (...args: unknown[]): void => {
      process.stderr.write(
        `[feature-flags] LaunchDarkly error: ${args.map(String).join(' ')}\n`,
      );
    },
  };
}

function isLaunchDarklyClientModule(
  value: unknown,
): value is typeof LaunchDarklyClientModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'initialize' in value &&
    typeof value.initialize === 'function'
  );
}

function loadLaunchDarklyClientModule(): typeof LaunchDarklyClientModule {
  return loadRequiredNodeModule<typeof LaunchDarklyClientModule>({
    moduleId: 'launchdarkly-node-client-sdk',
    requireFrom: __filename,
    validate: isLaunchDarklyClientModule,
  });
}

export class FeatureFlagService {
  private snapshot: FeatureFlagSnapshot = getDefaultFeatureFlagSnapshot();
  private client: LDClient | null = null;
  private clientInitialized = false;
  private disposed = false;
  private listeners = new Set<SnapshotListener>();
  private refreshPromise: Promise<FeatureFlagSnapshot> | null = null;
  private changeListener: (() => void) | null = null;
  private hasLiveLaunchDarklyValues = false;
  private contextIdentity: string | null = null;
  private liveValues: Record<string, unknown> = {};
  private contextGeneration = 0;

  getLabsAvailabilityState(): LabsAvailabilityState {
    return {
      snapshot: this.getSnapshot(),
      contextIdentity: this.contextIdentity,
      liveValues: { ...this.liveValues },
    };
  }

  invalidateContext(): void {
    this.contextGeneration++;
    this.hasLiveLaunchDarklyValues = false;
    this.liveValues = {};
    this.contextIdentity = null;
    // Static E2E flags and unconfigured defaults have no targeting context.
    // Account activation must not transiently turn them into outage fallbacks.
    if (!readLaunchDarklyDesktopClientSideId(electronApp.isPackaged === true)) {
      const override = buildE2eOverrideSnapshot();
      this.liveValues = override ? { ...override.values } : {};
      this.setSnapshot(
        override ?? getDefaultFeatureFlagSnapshot('not_configured'),
      );
      return;
    }
    this.setSnapshot(
      getDefaultFeatureFlagSnapshot(
        'initializing',
        null,
        'launchdarkly_enabled_unavailable',
      ),
    );
  }

  private readonly random: () => number;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryPromise: Promise<FeatureFlagSnapshot> | null = null;
  private lastAttemptStartedAt = 0;
  private outage: LaunchDarklyOutage | null = null;
  private recordDiagnostic:
    | ((record: FeatureFlagAppDiagnostic) => void)
    | null = null;

  constructor(options: FeatureFlagServiceOptions = {}) {
    this.random = options.random ?? Math.random;
  }

  /**
   * Routes outage diagnostics to app-events. Main installs this before the
   * first start; without it the service still retries, it just stays silent.
   */
  setDiagnosticRecorder(
    recorder: ((record: FeatureFlagAppDiagnostic) => void) | null,
  ): void {
    this.recordDiagnostic = recorder;
  }

  async initialize(): Promise<FeatureFlagSnapshot> {
    // Never run two starts at once: both would replace the same client.
    if (this.retryPromise) {
      await this.retryPromise;
    }
    return this.startLaunchDarkly('context_refresh', false);
  }

  /**
   * Retries a failed LaunchDarkly start early (window focus, power resume).
   * Does nothing unless a backoff retry is already pending, and nothing within
   * {@link LAUNCHDARKLY_RETRY_TRIGGER_MIN_INTERVAL_MS} of the last attempt.
   */
  requestRetry(trigger: FeatureFlagRetryTrigger): void {
    if (this.disposed || !this.retryTimer || this.retryPromise) {
      return;
    }
    if (
      Date.now() - this.lastAttemptStartedAt <
      LAUNCHDARKLY_RETRY_TRIGGER_MIN_INTERVAL_MS
    ) {
      return;
    }
    this.runBackgroundRetry(trigger);
  }

  private runBackgroundRetry(trigger: FeatureFlagRecoveryTrigger): void {
    this.clearRetryTimer();
    const retry = this.startLaunchDarkly(trigger, true).finally(() => {
      this.retryPromise = null;
    });
    this.retryPromise = retry;
    void retry;
  }

  private async startLaunchDarkly(
    trigger: FeatureFlagRecoveryTrigger,
    background: boolean,
  ): Promise<FeatureFlagSnapshot> {
    if (this.disposed) {
      if (background) {
        return this.getSnapshot();
      }
      this.disposed = false;
    }
    this.clearRetryTimer();

    // A configured LaunchDarkly client-side ID always takes precedence over the
    // E2E override snapshot. This lets E2E specs that deliberately inject a
    // (bogus) client-side ID exercise the real initialize() path — and the
    // documented enabled-but-unavailable fallback — instead of being
    // short-circuited into the static override snapshot. In production the
    // override is always null (it is gated on __CANOPY_E2E__), so this ordering
    // only affects E2E builds.
    const clientSideId = readLaunchDarklyDesktopClientSideId(
      electronApp.isPackaged === true,
    );
    if (!clientSideId) {
      this.outage = null;
      await this.closeClient();
      const e2eOverrideSnapshot = buildE2eOverrideSnapshot();
      if (e2eOverrideSnapshot) {
        this.hasLiveLaunchDarklyValues = false;
        this.liveValues = { ...e2eOverrideSnapshot.values };
        this.setSnapshot(e2eOverrideSnapshot);
        return this.snapshot;
      }
      this.hasLiveLaunchDarklyValues = false;
      this.setSnapshot({
        ...getDefaultFeatureFlagSnapshot('not_configured'),
        updatedAt: nowIso(),
      });
      return this.snapshot;
    }

    const generation = this.contextGeneration;
    const previousSnapshot = this.getSnapshot();
    this.lastAttemptStartedAt = Date.now();
    await this.closeClient();
    if (generation !== this.contextGeneration || this.disposed)
      return this.getSnapshot();
    // Background retries stay quiet until they change something: consumers
    // react to every broadcast, and an outage can last for hours.
    if (!background) {
      this.setSnapshot({
        ...(this.hasLiveLaunchDarklyValues
          ? {
              ...previousSnapshot,
              status: 'initializing' as const,
              error: null,
            }
          : getDefaultFeatureFlagSnapshot(
              'initializing',
              null,
              'launchdarkly_enabled_unavailable',
            )),
        updatedAt: nowIso(),
      });
    }

    let startedClient: LDClient | null = null;
    try {
      const context = await buildDesktopFeatureFlagContext();
      if (generation !== this.contextGeneration || this.disposed)
        return this.getSnapshot();
      const identity = labsContextIdentity(context);
      const contextChanged = this.contextIdentity !== identity;
      // A targeting change drops the previous context's Labs values but keeps
      // publishing the last flag values, as a refresh does: a timed-out
      // provider probe changes the identity without changing the account, and
      // unavailable defaults here flip rollout flags off until the start
      // answers. Account switches already reset them through
      // invalidateContext().
      if (contextChanged) this.liveValues = {};
      this.contextIdentity = identity;
      // Publish the new context identity so its validated offline cache can
      // be used even when SDK initialization fails. The flag values are
      // unchanged; Labs re-reads availability for the new identity from this
      // broadcast.
      if (contextChanged) this.setSnapshot(this.getSnapshot());
      const ld = loadLaunchDarklyClientModule();
      if (generation !== this.contextGeneration || this.disposed)
        return this.getSnapshot();
      this.contextIdentity = labsContextIdentity(context);
      const client = ld.initialize(clientSideId, context, {
        logger: createLogger(),
        localStoragePath: electronApp.getPath('userData'),
        ...readE2eLaunchDarklyEndpoints(),
      });
      startedClient = client;
      this.client = client;
      this.changeListener = (): void => {
        if (
          !this.disposed &&
          this.client === client &&
          generation === this.contextGeneration
        )
          this.setLiveSnapshot(client);
      };
      client.on('change', this.changeListener);
      await client.waitForInitialization(LAUNCHDARKLY_INIT_TIMEOUT_SECONDS);
      if (
        this.disposed ||
        generation !== this.contextGeneration ||
        this.client !== client
      ) {
        if (this.client === client) await this.closeClient();
        else await client.close().catch(() => undefined);
        return this.getSnapshot();
      }
      this.setLiveSnapshot(client);
      this.recordRecovery(trigger);
    } catch (error) {
      if (this.client === startedClient) await this.closeClient();
      else await startedClient?.close().catch(() => undefined);
      if (this.disposed || generation !== this.contextGeneration) {
        return this.getSnapshot();
      }
      const errorSnapshot = buildErrorSnapshot(
        error,
        previousSnapshot,
        this.hasLiveLaunchDarklyValues,
      );
      if (
        !background ||
        this.snapshot.status !== 'error' ||
        this.snapshot.error !== errorSnapshot.error
      ) {
        this.setSnapshot(errorSnapshot);
      }
      this.recordFailureAndScheduleRetry(errorSnapshot.error ?? 'unknown');
    }

    return this.getSnapshot();
  }

  private recordFailureAndScheduleRetry(error: string): void {
    const outage: LaunchDarklyOutage = this.outage ?? {
      startedAt: Date.now(),
      failedAttempts: 0,
    };
    outage.failedAttempts += 1;
    this.outage = outage;
    const scheduleIndex = Math.min(
      outage.failedAttempts - 1,
      LAUNCHDARKLY_RETRY_DELAYS_MS.length - 1,
    );
    const baseDelay = LAUNCHDARKLY_RETRY_DELAYS_MS[scheduleIndex] ?? 600_000;
    const jitter =
      (this.random() * 2 - 1) * LAUNCHDARKLY_RETRY_JITTER_RATIO * baseDelay;
    const delay = Math.round(baseDelay + jitter);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.runBackgroundRetry('backoff');
    }, delay);
    this.retryTimer.unref?.();
    this.recordDiagnostic?.({
      version: 1,
      timestamp: nowIso(),
      kind: 'feature_flags_unavailable',
      error: error.slice(0, MAX_DIAGNOSTIC_ERROR_LENGTH),
      retryAfterMs: delay,
      featureFlagFailedAttempts: outage.failedAttempts,
      featureFlagValuesSource: this.hasLiveLaunchDarklyValues
        ? 'last_live'
        : 'unavailable_fallback',
    });
  }

  private recordRecovery(trigger: FeatureFlagRecoveryTrigger): void {
    const outage = this.outage;
    this.outage = null;
    if (!outage) {
      return;
    }
    this.recordDiagnostic?.({
      version: 1,
      timestamp: nowIso(),
      kind: 'feature_flags_recovered',
      featureFlagFailedAttempts: outage.failedAttempts,
      featureFlagOutageMs: Date.now() - outage.startedAt,
      featureFlagRecoveryTrigger: trigger,
    });
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  getSnapshot(): FeatureFlagSnapshot {
    return {
      ...this.snapshot,
      values: { ...this.snapshot.values },
    };
  }

  isEnabled(key: ClientFeatureFlagKey): boolean {
    return this.snapshot.values[key] === true;
  }

  /** A missing or invalid evaluation is distinct from a live boolean false. */
  getLiveBooleanValue(key: ClientFeatureFlagKey): boolean | undefined {
    const value = this.liveValues[key];
    return typeof value === 'boolean' ? value : undefined;
  }

  refreshContext(): Promise<FeatureFlagSnapshot> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = (async (): Promise<FeatureFlagSnapshot> => {
      for (;;) {
        const result = await this.refreshContextImpl();
        if (result) return result;
      }
    })().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  onSnapshotChanged(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.listeners.clear();
    this.clearRetryTimer();
    this.outage = null;
    await this.closeClient();
    this.hasLiveLaunchDarklyValues = false;
  }

  private async refreshContextImpl(): Promise<FeatureFlagSnapshot | null> {
    let generation = this.contextGeneration;
    if (!this.client || !this.clientInitialized) {
      const snapshot = await this.initialize();
      return generation === this.contextGeneration ? snapshot : null;
    }

    const client = this.client;
    this.clearRetryTimer();
    try {
      const context: LDContext = await buildDesktopFeatureFlagContext();
      if (generation !== this.contextGeneration) return null;
      const identity = labsContextIdentity(context);
      if (identity !== this.contextIdentity) {
        // A targeting change fences callbacks from the previous context and
        // drops its Labs values, but keeps publishing the last flag values
        // until identify answers: unavailable defaults here flip rollout
        // flags off mid-refresh (org projects flickers to Personal). Account
        // switches already reset them through invalidateContext().
        this.contextGeneration++;
        generation = this.contextGeneration;
        this.liveValues = {};
        this.contextIdentity = identity;
        this.setSnapshot(this.getSnapshot());
      }
      await client.identify(context);
      if (generation !== this.contextGeneration) return null;
      // The old callback belongs to the old targeting context.
      if (this.changeListener) client.off('change', this.changeListener);
      this.changeListener = (): void => {
        if (
          !this.disposed &&
          generation === this.contextGeneration &&
          this.client === client
        )
          this.setLiveSnapshot(client);
      };
      client.on('change', this.changeListener);
      this.setLiveSnapshot(client);
      this.recordRecovery('context_refresh');
    } catch (error) {
      if (generation !== this.contextGeneration) return null;
      const snapshot = buildErrorSnapshot(
        error,
        this.snapshot,
        this.hasLiveLaunchDarklyValues,
      );
      this.setSnapshot(snapshot);
      this.recordFailureAndScheduleRetry(snapshot.error ?? 'unknown');
    }
    return this.getSnapshot();
  }

  private setLiveSnapshot(client: LDClient): void {
    this.clientInitialized = true;
    this.hasLiveLaunchDarklyValues = true;
    this.liveValues = Object.fromEntries(
      Object.values(CLIENT_FEATURE_FLAGS).map(({ key }) => [
        key,
        client.variation(key, null),
      ]),
    );
    this.setSnapshot(buildReadySnapshot(client));
  }

  private async closeClient(): Promise<void> {
    const client = this.client;
    const changeListener = this.changeListener;
    this.client = null;
    this.clientInitialized = false;
    this.changeListener = null;
    if (!client) {
      return;
    }
    if (changeListener) {
      client.off('change', changeListener);
    }
    await client.close().catch(() => undefined);
  }

  private setSnapshot(snapshot: FeatureFlagSnapshot): void {
    this.snapshot = {
      ...snapshot,
      values: { ...snapshot.values },
    };
    for (const listener of Array.from(this.listeners)) {
      listener(this.getSnapshot());
    }
  }
}

let singleton: FeatureFlagService | null = null;

export function getFeatureFlagService(): FeatureFlagService {
  if (!singleton) {
    singleton = new FeatureFlagService();
  }
  return singleton;
}

export async function initializeFeatureFlagService(): Promise<FeatureFlagSnapshot> {
  return getFeatureFlagService().initialize();
}

export async function disposeFeatureFlagService(): Promise<void> {
  if (!singleton) {
    return;
  }
  const service = singleton;
  singleton = null;
  await service.dispose();
}
