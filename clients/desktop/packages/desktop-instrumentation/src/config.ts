import type { BrandReleaseFlavor } from '@canopy/protocol/brand';
import type {
  DesktopInstrumentationProvider,
  PostHogRuntimeFlags,
} from './types';

declare const __CANOPY_E2E__: boolean;
declare const __CANOPY_BRAND_ID__: string;

export interface PostHogInstrumentationConfig {
  enabled: boolean;
  projectKey?: string;
  host: string;
  sessionReplaySampleRate: number;
}

export interface DesktopInstrumentationConfig {
  providers: readonly DesktopInstrumentationProvider[];
  /** Bundled release version of the app, independent of any provider. */
  appVersion?: string;
  appBrand?: string;
  /** Bundled release flavor; omitted when the build sets no known flavor. */
  releaseChannel?: BrandReleaseFlavor;
  posthog: PostHogInstrumentationConfig;
}

export type EnabledPostHogInstrumentationConfig =
  PostHogInstrumentationConfig & {
    enabled: true;
    projectKey: string;
  };

export type PostHogInstrumentationReadiness =
  | { enabled: true; config: EnabledPostHogInstrumentationConfig }
  | { enabled: false; reason: string };

/** Stable minified-path key for renderer assets in error stacks and uploaded
 * source maps, independent of where the packaged app is installed. */
export const RENDERER_SOURCEMAP_MINIFIED_PATH_PREFIX =
  'https://canopy.local/renderer/assets';

const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';
const POSTHOG_E2E_PROJECT_KEY_PREFIX = 'phc_e2e_';
const LOOPBACK_POSTHOG_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function readBuildBoolean(
  value: boolean | undefined,
  fallback: boolean,
): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readBuildString(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readReleaseChannel(
  value: string | undefined,
): BrandReleaseFlavor | undefined {
  return value === 'internal' || value === 'rc' || value === 'stable'
    ? value
    : undefined;
}

function readBuildNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(100, Math.max(0, value))
    : fallback;
}

function readLoopbackPostHogStubUrl(
  value: string | undefined,
): string | undefined {
  const candidate = readBuildString(value);
  if (!candidate) {
    return undefined;
  }

  try {
    const url = new URL(candidate);
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      LOOPBACK_POSTHOG_HOSTS.has(url.hostname) &&
      url.username.length === 0 &&
      url.password.length === 0
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
}

export function getDesktopInstrumentationConfig(): DesktopInstrumentationConfig {
  const posthogRequestedEnabled =
    typeof __CANOPY_POSTHOG_ENABLED__ !== 'undefined'
      ? readBuildBoolean(__CANOPY_POSTHOG_ENABLED__, false)
      : false;
  const posthogProjectKey =
    typeof __CANOPY_POSTHOG_PROJECT_KEY__ !== 'undefined'
      ? readBuildString(__CANOPY_POSTHOG_PROJECT_KEY__)
      : undefined;
  const isE2e =
    typeof __CANOPY_E2E__ !== 'undefined' &&
    readBuildBoolean(__CANOPY_E2E__, false);
  const posthogStubUrl = isE2e
    ? readLoopbackPostHogStubUrl(
        typeof __CANOPY_POSTHOG_STUB_URL__ !== 'undefined'
          ? __CANOPY_POSTHOG_STUB_URL__
          : undefined,
      )
    : undefined;
  const posthogEnabled =
    posthogRequestedEnabled &&
    (!isE2e ||
      Boolean(
        posthogStubUrl &&
        posthogProjectKey?.startsWith(POSTHOG_E2E_PROJECT_KEY_PREFIX),
      ));

  return {
    providers: ['posthog'],
    appVersion:
      typeof __CANOPY_APP_VERSION__ !== 'undefined'
        ? readBuildString(__CANOPY_APP_VERSION__)
        : undefined,
    appBrand:
      typeof __CANOPY_BRAND_ID__ !== 'undefined'
        ? readBuildString(__CANOPY_BRAND_ID__)
        : undefined,
    releaseChannel:
      typeof __CANOPY_RELEASE_FLAVOR__ !== 'undefined'
        ? readReleaseChannel(__CANOPY_RELEASE_FLAVOR__)
        : undefined,
    posthog: {
      enabled: posthogEnabled,
      projectKey: posthogProjectKey,
      host:
        posthogStubUrl ??
        (typeof __CANOPY_POSTHOG_HOST__ !== 'undefined'
          ? readBuildString(__CANOPY_POSTHOG_HOST__)
          : undefined) ??
        DEFAULT_POSTHOG_HOST,
      sessionReplaySampleRate:
        typeof __CANOPY_POSTHOG_SESSION_REPLAY_SAMPLE_RATE__ !== 'undefined'
          ? readBuildNumber(__CANOPY_POSTHOG_SESSION_REPLAY_SAMPLE_RATE__, 0)
          : 0,
    },
  };
}

export function getPostHogDisabledReason(
  config: PostHogInstrumentationConfig,
): string | undefined {
  if (!config.enabled) {
    return 'disabled';
  }
  if (!config.projectKey) {
    return 'missing_project_key';
  }
  return undefined;
}

export function getPostHogInstrumentationReadiness(
  config: PostHogInstrumentationConfig,
): PostHogInstrumentationReadiness {
  if (!config.enabled) {
    return { enabled: false, reason: 'disabled' };
  }

  const { projectKey } = config;
  if (!projectKey) {
    return { enabled: false, reason: 'missing_project_key' };
  }

  return {
    enabled: true,
    config: { ...config, enabled: true, projectKey },
  };
}

export interface PostHogRuntimePolicy {
  /** Product events: operations, screens, `$set`/`$identify`, flag calls. */
  captureEnabled: boolean;
  /** `$exception` and the app-error events. Independent of `captureEnabled`. */
  errorCaptureEnabled: boolean;
  sessionReplaySampleRate: number;
  /** Click autocapture, rage clicks, and dead clicks. */
  autocaptureEnabled: boolean;
}

/**
 * Runtime flags can only narrow the immutable build-time configuration. The
 * LaunchDarkly capture flag gates both categories; the member's effective
 * usage-data choices then gate product events and errors separately. Every
 * flag other than `true` fails closed.
 */
export function resolvePostHogRuntimePolicy(
  config: PostHogInstrumentationConfig,
  flags?: PostHogRuntimeFlags,
): PostHogRuntimePolicy {
  const capturePermitted =
    getPostHogInstrumentationReadiness(config).enabled &&
    flags?.captureEnabled === true;
  const captureEnabled = capturePermitted && flags?.productAnalytics === true;
  const errorCaptureEnabled = capturePermitted && flags?.errorReports === true;
  const rate = flags?.sessionReplaySampleRate;
  const validRate =
    typeof rate === 'number' &&
    Number.isFinite(rate) &&
    rate >= 0 &&
    rate <= 100;
  return {
    captureEnabled,
    errorCaptureEnabled,
    sessionReplaySampleRate:
      captureEnabled && flags?.sessionReplay === true && validRate
        ? Math.min(config.sessionReplaySampleRate, rate)
        : 0,
    autocaptureEnabled: captureEnabled && flags?.autocaptureEnabled === true,
  };
}
