import { BRAND } from '@canopy/brand/current';
import { isLocalOnlyBuild } from '../local-only/profile';

let cachedCanopyCloudBaseUrl: string | null = null;
const CLOUD_DISPLAY_NAME = `${BRAND.displayName} Cloud`;

export type CanopyCloudConfigErrorCode =
  | 'base-url-not-configured'
  | 'api-key-required'
  // The local-only build profile (docs/local-only-build.md) turns the cloud
  // off. Callers treat it like any other config error: the feature is off.
  | 'local-only-build';

export class CanopyCloudConfigError extends Error {
  constructor(
    readonly code: CanopyCloudConfigErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CanopyCloudConfigError';
  }
}

function getBuildTimeBaseUrl(): string {
  return typeof __CANOPY_CLOUD_BASE_URL__ === 'string'
    ? __CANOPY_CLOUD_BASE_URL__
    : '';
}

/**
 * E2E-only runtime override for the cloud base URL. The Playwright portal
 * suite boots a real web server on a per-run port, so the E2E build must be
 * able to re-point Canopy Cloud at launch time. Gated on the build-time
 * `__CANOPY_E2E__` constant so production builds dead-code-eliminate the
 * branch and never honor the env var (enforced by check:no-e2e-seams).
 */
function getE2eRuntimeBaseUrlOverride(): string {
  if (__CANOPY_E2E__) {
    return process.env.CANOPY_E2E_CLOUD_BASE_URL ?? '';
  }
  return '';
}

function isLocalhostHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]'
  );
}

export function normalizeCanopyCloudBaseUrl(input: string): string {
  const trimmed = String(input).trim();
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

export function assertCanopyCloudBaseUrlProtocol(baseUrl: string): void {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    throw new Error(`${CLOUD_DISPLAY_NAME} base URL must be a valid URL.`);
  }

  if (parsedUrl.protocol === 'https:') {
    return;
  }

  if (
    parsedUrl.protocol === 'http:' &&
    isLocalhostHostname(parsedUrl.hostname)
  ) {
    return;
  }

  throw new Error(
    `${CLOUD_DISPLAY_NAME} base URL must use https:// unless it points to localhost.`,
  );
}

export function resetCanopyCloudBaseUrlCacheForTest(): void {
  cachedCanopyCloudBaseUrl = null;
}

/**
 * Whether `error` is the cloud chokepoint's local-only refusal. Handlers that
 * the renderer calls on a timer or on mount use it to return their "off"
 * answer instead of reporting an unexpected error on every call.
 */
export function isCloudOffInLocalOnlyBuild(error: unknown): boolean {
  return (
    error instanceof CanopyCloudConfigError && error.code === 'local-only-build'
  );
}

export function getCanopyCloudBaseUrl(): string {
  // Local-only chokepoint, checked before the cache and the E2E override so
  // the in-repo golden's mock server is never used as a cloud.
  if (isLocalOnlyBuild()) {
    throw new CanopyCloudConfigError(
      'local-only-build',
      `${CLOUD_DISPLAY_NAME} is off in a local-only build.`,
    );
  }
  if (cachedCanopyCloudBaseUrl !== null) {
    return cachedCanopyCloudBaseUrl;
  }

  const normalized = normalizeCanopyCloudBaseUrl(
    getE2eRuntimeBaseUrlOverride() || getBuildTimeBaseUrl(),
  );
  if (!normalized) {
    throw new CanopyCloudConfigError(
      'base-url-not-configured',
      `${CLOUD_DISPLAY_NAME} base URL is not configured.`,
    );
  }

  assertCanopyCloudBaseUrlProtocol(normalized);
  cachedCanopyCloudBaseUrl = normalized;
  return cachedCanopyCloudBaseUrl;
}
