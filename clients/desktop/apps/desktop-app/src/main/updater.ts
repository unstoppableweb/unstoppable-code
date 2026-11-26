import { load } from 'js-yaml';
import { join } from 'node:path';
import { app } from 'electron';
import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import { reportMainAppError } from '@canopy/desktop-instrumentation/electron/main';
import { linuxUpdateCopy } from '@canopy/desktop-shared/lib/linux-update-copy';
import { restoreStartupEnvironmentForRelaunch } from '@canopy/execution-engine/pipelines/config-paths';
import {
  detectLinuxInstallSource,
  installedLinuxPackageArchitecture,
  PACMAN_UPDATE_COMMAND,
  type LinuxPackageArchitecture,
  type PackageManagedLinuxInstallSource,
} from './updater/linux-manual-update';
import {
  createDpkgBackend,
  watchInstalledPackage,
  type InstalledPackageWatch,
} from './updater/linux-installed-package';
import { systemUpdaterAvailable } from './updater/linux-system-updater';
import {
  verifiedLinuxRelease,
  verifiedLinuxMetadata,
  readLinuxReleaseJson,
  readLinuxReleaseText,
  type VerifiedLinuxRelease,
} from './updater/linux-release-discovery';
import electronUpdater from 'electron-updater';
import {
  cleanupWindowsUpdateTempFiles,
  createWindowsUpdateVerifier,
  windowsUpdateErrorCode,
  windowsUpdateErrorMessage,
} from './updater/windows-update';
import {
  logMainProcessError,
  logMainProcessWarn,
} from './lib/main-process-logging';
import type { CustomPublishOptions } from 'builder-util-runtime';
import {
  ACTIONABLE_PHASES,
  IPC_CHANNELS,
  type DownloadProgressData,
  type TargetUpdateInfo,
  type TargetUpdateRelation,
  type TargetUpdateRequest,
  type TargetUpdateVersionItem,
  type TargetUpdateVersionListRequest,
  type TargetUpdateVersionListResponse,
  type UpdateEvent,
  type UpdateInfoData,
  type UpdateReleaseFlavor,
  type UpdateState,
} from '@canopy/desktop-shared/types';
import { BRAND } from '@canopy/brand/current';
import { resolveGitHubToken } from './lib/github-auth';
import { readPreferencesFile } from './lib/preferences-store';
import {
  BrandedPrivateGitHubProvider,
  getBrandUpdateChannelFilename,
  getBrandUpdateChannelName,
} from './updater/brand-github-provider';
import { sendToWindow, type SendableBrowserWindow } from './lib/window-send';
import { getCanopyReleaseFlavor } from './lib/app-identity';
import { isLocalOnlyBuild } from './local-only/profile';
import {
  getInternalReleaseIndicatorForDisplay,
  toInternalReleaseIndicator,
} from './lib/internal-release-version';
import {
  hasActiveChatWork,
  subscribeChatSessionActivity,
} from './agents/session-manager';

// Accessing electron-updater.autoUpdater constructs a native installer. Linux
// must never access that getter, including at module load or shutdown.
function getAutoUpdater(): typeof electronUpdater.autoUpdater {
  ensureDistributionAllowsUpdates();
  if (hostPlatformOperatingSystem() === 'linux')
    throw new Error(linuxUpdateCopy(BRAND, RELEASE_FLAVOR).manual);
  return electronUpdater.autoUpdater;
}

const INITIAL_CHECK_DELAY_MS = 5_000;
const PERIODIC_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1_000;
const DEFERRED_INSTALL_IDLE_DEBOUNCE_MS = 5_000;
const PRIVATE_REPO_AUTH_ERROR = `${BRAND.displayName} updates require GitHub access. Authenticate with \`gh auth login\` or save a PAT in Settings.`;
const STABLE_UPDATE_ERROR = `${BRAND.displayName} updates are temporarily unavailable. Please try again later.`;
const STABLE_FEED_UNCONFIGURED_ERROR = `${BRAND.displayName} updates are not configured for this build.`;
const UNPACKAGED_BUILD_ERROR = `App updates are only available in packaged ${BRAND.displayName} builds.`;
const SOURCE_BUILD_UPDATE_ERROR = `App updates are disabled in source-built ${BRAND.displayName}. Rebuild from source to update.`;
// Local-only builds (docs/local-only-build.md) are source builds with every
// hosted service off, including the update feed.
const LOCAL_ONLY_BUILD_UPDATE_ERROR = `App updates are off in a local-only ${BRAND.displayName} build. Rebuild from source to update.`;
// The distribution identity is bundled at compile time. A runtime environment
// variable must never turn a source installation into an official updater client.
const IS_SOURCE_BUILD =
  typeof __CANOPY_SOURCE_BUILD__ === 'boolean' && __CANOPY_SOURCE_BUILD__;
const RELEASE_FLAVOR = getCanopyReleaseFlavor();
const UPDATE_BASE_URL = __CANOPY_UPDATE_BASE_URL__.replace(/\/+$/, '');
const CODE_SIGNATURE_VALIDATION_ERROR_PATTERN =
  /Code signature at URL .* did not pass validation: .*code failed to satisfy specified code requirement\(s\)/i;
const CODE_SIGNATURE_RECOVERY_ERROR = [
  `${BRAND.displayName} could not install the downloaded update because macOS rejected its code signature.`,
  'This usually means the currently installed app was signed with a different requirement than the release build.',
  `Download and install the latest ${BRAND.displayName} DMG manually once, then future automatic updates should work.`,
].join(' ');
const READ_ONLY_VOLUME_ERROR_PATTERN =
  /Cannot update while running on a read-only volume|application is on a read-only volume/i;
const READ_ONLY_VOLUME_RECOVERY_ERROR = [
  `${BRAND.displayName} cannot auto-update from its current location because macOS is running it from a read-only volume.`,
  `Quit ${BRAND.displayName}, drag it to the Applications folder, eject any mounted installer disk image, then reopen it and check for updates again.`,
].join(' ');
type UpdaterInfoLike = {
  version: string;
  releaseDate?: string;
  releaseNotes?: string | Array<{ note?: string | null }> | null;
};

type ProgressInfoLike = {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
};

type BeforeInstallUpdate = () => Promise<void>;
interface UpdaterOptions {
  isWorkflowDirty: () => boolean;
  linuxRoots?: { dpkgDir: string; execPath?: string };
  isPackageTransactionRunning?: () => boolean;
  /** Host supplies the routed terminal port without loading the PTY graph here. */
  startPackageTransactionTracking?: (
    processNames: readonly string[],
    onReadinessChange: () => void,
  ) => () => void;
}
type UpdaterBrowserWindow = SendableBrowserWindow & {
  webContents: SendableBrowserWindow['webContents'] & {
    isLoading(): boolean;
    once(event: 'did-finish-load', callback: () => void): void;
  };
};

let getWindowRef: (() => UpdaterBrowserWindow | null) | null = null;
let beforeInstallUpdate: BeforeInstallUpdate | null = null;
let updateState: UpdateState = { phase: 'idle' };
let listenersRegistered = false;
let startupTimer: ReturnType<typeof setTimeout> | null = null;
let periodicTimer: ReturnType<typeof setInterval> | null = null;
let deferredInstallIdleTimer: ReturnType<typeof setTimeout> | null = null;
let checkInFlight: Promise<void> | null = null;
let downloadInFlight: Promise<void> | null = null;
let installInFlight: Promise<void> | null = null;
let unsubscribeChatSessionActivity: (() => void) | null = null;
let activeTargetUpdate: TargetUpdateInfo | null = null;
let updaterGeneration = 0;
let isWorkflowDirty: () => boolean = () => false;
let isPackageTransactionRunning: () => boolean = () => false;
let linuxRoots: UpdaterOptions['linuxRoots'];
let linuxInstalledPackageWatch: InstalledPackageWatch | null = null;
let linuxInstalledPackageWatchStart: Promise<void> | null = null;
let stopPackageTransactionTracking: (() => void) | null = null;
/**
 * Cached GitHub token used to configure the electron-updater feed URL.
 * Resolving the token can shell out to `gh` and inspect the keychain, which
 * is slow enough to be visibly painful before each check/download. We keep
 * the resolved token across calls and only re-resolve after an explicit
 * invalidation (e.g. an auth error from the updater).
 */
let cachedGitHubToken: string | null = null;
let configuredGitHubFeedKey: string | null = null;
let stableFeedConfigured = false;
/**
 * Latest renderer-reported busy state. `true` means at least one agent has an
 * in-flight turn. Defaults to `true` at startup so we never trigger a deferred
 * install before the renderer has had a chance to report.
 */
let rendererBusy = true;
const stateListeners = new Set<() => void>();

function notifyStateListeners(): void {
  for (const listener of [...stateListeners]) {
    try {
      listener();
    } catch (error) {
      logMainProcessError('Update state listener failed', error);
    }
  }
}

type GitHubReleaseAssetInfo = {
  name?: string;
  url?: string;
};

type GitHubReleaseApiInfo = {
  name?: string | null;
  tag_name?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  published_at?: string | null;
  assets?: GitHubReleaseAssetInfo[];
  body?: string;
};

type ParsedRcVersion = {
  major: number;
  minor: number;
  patch: number;
  counter: number;
};

function normalizeReleaseNotes(
  releaseNotes: UpdaterInfoLike['releaseNotes'],
): string | null {
  if (typeof releaseNotes === 'string') {
    return releaseNotes;
  }
  if (!Array.isArray(releaseNotes)) {
    return null;
  }

  const notes = releaseNotes
    .map((entry) => entry.note?.trim())
    .filter((note): note is string => Boolean(note));

  return notes.length > 0 ? notes.join('\n\n') : null;
}

function normalizeUpdateInfo(info: UpdaterInfoLike): UpdateInfoData {
  const version =
    RELEASE_FLAVOR === 'internal'
      ? (toInternalReleaseIndicator(info.version) ?? info.version)
      : info.version;
  return {
    version,
    releaseDate: info.releaseDate,
    releaseNotes: normalizeReleaseNotes(info.releaseNotes),
  };
}

function isTargetedUpdateFlavor(
  flavor: UpdateReleaseFlavor = RELEASE_FLAVOR,
): flavor is 'internal' | 'rc' {
  return flavor === 'internal' || flavor === 'rc';
}

function ensureTargetedUpdatesSupported(): void {
  if (!isTargetedUpdateFlavor()) {
    throw new Error('Targeted updates are not available in stable builds.');
  }
}

/**
 * On Linux the installed package architecture, not the process, names the
 * feed (`latest-linux.yml` for x64, `latest-linux-arm64.yml` for arm64).
 */
function getExpectedGitHubMetadataAssetName(
  linuxArchitecture: LinuxPackageArchitecture | null = null,
): string {
  const platform =
    process.platform === 'darwin'
      ? 'darwin'
      : process.platform === 'win32'
        ? 'win32'
        : 'linux';
  return getBrandUpdateChannelFilename(
    getBrandUpdateChannelName(BRAND),
    platform,
    platform === 'linux' && linuxArchitecture !== null
      ? linuxArchitecture
      : undefined,
  );
}

function parseInternalTag(tag: string): number | null {
  const match = /^internal-([1-9]\d*)$/i.exec(tag.trim());
  return match ? Number(match[1]) : null;
}

function parseRcVersion(value: string): ParsedRcVersion | null {
  const match =
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-rc\.([1-9]\d*)$/i.exec(
      value.trim(),
    );
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    counter: Number(match[4]),
  };
}

function compareRcVersions(a: ParsedRcVersion, b: ParsedRcVersion): number {
  return (
    a.major - b.major ||
    a.minor - b.minor ||
    a.patch - b.patch ||
    a.counter - b.counter
  );
}

function compareTargetVersions(a: string, b: string): number | undefined {
  if (RELEASE_FLAVOR === 'internal') {
    const left = parseInternalTag(a);
    const right = parseInternalTag(b);
    return left === null || right === null ? undefined : left - right;
  }
  if (RELEASE_FLAVOR === 'rc') {
    const left = parseRcVersion(a);
    const right = parseRcVersion(b);
    return left && right ? compareRcVersions(left, right) : undefined;
  }
  return undefined;
}

function compareTargetToCurrent(tag: string): TargetUpdateRelation | undefined {
  const current =
    RELEASE_FLAVOR === 'internal'
      ? getInternalReleaseIndicatorForDisplay(app.getVersion())
      : app.getVersion();
  const comparison = compareTargetVersions(tag, current);
  return comparison === undefined
    ? undefined
    : comparison === 0
      ? 'current'
      : comparison < 0
        ? 'downgrade'
        : 'upgrade';
}

function isStrictTargetTagForCurrentFlavor(tag: string): boolean {
  return RELEASE_FLAVOR === 'internal'
    ? parseInternalTag(tag) !== null
    : RELEASE_FLAVOR === 'rc'
      ? /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-rc\.([1-9]\d*)$/i.test(
          tag.trim(),
        )
      : false;
}

function isReleaseForCurrentFlavor(release: GitHubReleaseApiInfo): boolean {
  if (release.draft === true || release.prerelease !== true) {
    return false;
  }
  const tag = release.tag_name?.trim() ?? '';
  return isStrictTargetTagForCurrentFlavor(tag);
}

function releaseHasExpectedMetadataAsset(
  release: GitHubReleaseApiInfo,
  linuxArchitecture: LinuxPackageArchitecture | null,
): boolean {
  if (hostPlatformOperatingSystem() === 'linux')
    return (
      linuxArchitecture !== null &&
      verifiedLinuxRelease(release, RELEASE_FLAVOR, linuxArchitecture) !== null
    );
  const assetName = getExpectedGitHubMetadataAssetName();
  return release.assets?.some((asset) => asset.name === assetName) === true;
}

function targetInfoFromRelease(
  release: GitHubReleaseApiInfo,
): TargetUpdateVersionItem {
  const tag = release.tag_name?.trim() ?? '';
  const version = RELEASE_FLAVOR === 'rc' ? tag.replace(/^v/i, '') : tag;
  return {
    tag,
    version,
    name: release.name?.trim() || undefined,
    releaseDate: release.published_at ?? undefined,
    relation: compareTargetToCurrent(tag),
  };
}

function normalizeProgress(progress: ProgressInfoLike): DownloadProgressData {
  return {
    percent: progress.percent,
    bytesPerSecond: progress.bytesPerSecond,
    transferred: progress.transferred,
    total: progress.total,
  };
}

function sendToRenderer(event: UpdateEvent): void {
  sendToWindow(getWindowRef?.() ?? null, IPC_CHANNELS.updateEvent, event);
}

function setState(nextState: UpdateState, event?: UpdateEvent): void {
  const wasPending = updateState.installPending ?? false;
  // Only a suspended Linux package relaunch retains intent outside downloaded.
  // Every other transition keeps the existing implicit cancellation behavior.
  const suspendedPackage =
    nextState.phase === 'idle' && hasLinuxInstalledUpdate(nextState);
  if (nextState.phase !== 'downloaded' && !suspendedPackage && wasPending) {
    nextState = { ...nextState, installPending: false };
  }
  updateState = nextState;
  notifyStateListeners();
  if (event) {
    sendToRenderer(event);
  }
  const nowPending = updateState.installPending ?? false;
  if (wasPending !== nowPending) {
    sendToRenderer({ type: 'install-pending', pending: nowPending });
  }
  if (!nowPending) {
    clearDeferredInstallIdleTimer();
  }
}

function setInstallPending(pending: boolean): void {
  if ((updateState.installPending ?? false) === pending) {
    return;
  }
  updateState = { ...updateState, installPending: pending };
  notifyStateListeners();
  sendToRenderer({ type: 'install-pending', pending });
  if (!pending) {
    clearDeferredInstallIdleTimer();
  }
}

function clearDeferredInstallIdleTimer(): void {
  if (deferredInstallIdleTimer === null) {
    return;
  }
  clearTimeout(deferredInstallIdleTimer);
  deferredInstallIdleTimer = null;
}

function isDeferredInstallReady(): boolean {
  return (
    updateState.installPending === true &&
    updateState.phase === 'downloaded' &&
    (!hasLinuxInstalledUpdate() ||
      linuxInstalledPackageWatch?.isRelaunchReady() === true) &&
    !rendererBusy &&
    // Main includes live non-ambient provider background work and delegations,
    // even after the renderer settles the foreground turn.
    !hasActiveChatWork() &&
    !isWorkflowDirty() &&
    !isPackageTransactionRunning()
  );
}

function maybeRunDeferredInstall(): void {
  if (!isDeferredInstallReady()) {
    clearDeferredInstallIdleTimer();
    return;
  }
  if (deferredInstallIdleTimer !== null || installInFlight) {
    return;
  }

  deferredInstallIdleTimer = setTimeout(() => {
    deferredInstallIdleTimer = null;
    if (!isDeferredInstallReady()) {
      return;
    }
    void runInstallUpdate('deferred').catch((error: unknown) => {
      // The updater state/event already captures the failure.
      reportUpdaterFailure('install_deferred', error);
    });
  }, DEFERRED_INSTALL_IDLE_DEBOUNCE_MS);
}

async function runInstallUpdate(
  source: 'immediate' | 'deferred',
): Promise<void> {
  ensureDistributionAllowsUpdates();
  refuseLinuxInstall(true);
  const linuxRelaunch = hasLinuxInstalledUpdate();
  const generation = updaterGeneration;
  if (linuxRelaunch) {
    // Re-check at the handoff, outside handleUpdaterError: safety refusals
    // must leave the relaunch prompt and any queued restart intact.
    const blocked = linuxRelaunchBlockReason();
    if (blocked) {
      if (source === 'deferred') return;
      throw new Error(blocked);
    }
  }
  if (installInFlight) {
    return installInFlight;
  }
  clearDeferredInstallIdleTimer();

  const installation = (async (): Promise<void> => {
    if (linuxRelaunch) {
      // Keep the captured route: a baseline/unsettled callback may withdraw
      // downloaded while this async read runs. Never fall into an installer.
      const result = await linuxInstalledPackageWatch?.readNow();
      const blocked =
        generation !== updaterGeneration
          ? linuxUpdateCopy(BRAND, RELEASE_FLAVOR).relaunchWaitForPackage
          : (linuxRelaunchBlockReason() ??
            (result !== 'installed-changed' || !hasLinuxInstalledUpdate()
              ? linuxUpdateCopy(BRAND, RELEASE_FLAVOR).relaunchWaitForPackage
              : null));
      // Safety refusals are not installer errors and must not discard intent.
      if (blocked) {
        if (source === 'deferred') return;
        if (generation === updaterGeneration) {
          // Core already returned its running receipt. A safety refusal is
          // not an installer failure: acknowledge it with the actual ready
          // or withdrawn snapshot, preserving any queued relaunch intent.
          const state: UpdateState = { ...updateState, message: blocked };
          setState(state, { type: 'install-refused', state });
        }
        throw new Error(blocked);
      }
      if (source === 'deferred' && !isDeferredInstallReady()) return;
    }
    try {
      if (linuxRelaunch) {
        restoreStartupEnvironmentForRelaunch();
        app.relaunch();
        if (beforeInstallUpdate) await beforeInstallUpdate();
        app.quit();
        // quit begins an asynchronous lifecycle. Consume this queued handoff
        // before a late package poll or activity event can schedule it again.
        setInstallPending(false);
        return;
      }
      if (beforeInstallUpdate) {
        await beforeInstallUpdate();
      }
      restoreStartupEnvironmentForRelaunch();
      getAutoUpdater().quitAndInstall();
    } catch (error) {
      throw handleUpdaterError(error);
    }
  })();
  installInFlight = installation;
  try {
    await installation;
  } finally {
    // A handoff can finish synchronously when no cleanup hook was supplied.
    // Clear only after assigning the flight, never inside its IIFE.
    if (installInFlight === installation) {
      installInFlight = null;
      if (linuxRelaunch && generation === updaterGeneration)
        maybeRunDeferredInstall();
    }
  }
}

function toErrorMessage(error: unknown): string {
  const windowsMessage = windowsUpdateErrorMessage(error);
  if (windowsMessage) return windowsMessage;
  if (error instanceof Error && error.message.trim().length > 0) {
    if (CODE_SIGNATURE_VALIDATION_ERROR_PATTERN.test(error.message)) {
      return CODE_SIGNATURE_RECOVERY_ERROR;
    }
    if (READ_ONLY_VOLUME_ERROR_PATTERN.test(error.message)) {
      return READ_ONLY_VOLUME_RECOVERY_ERROR;
    }
    return error.message;
  }
  return 'Failed to check for updates.';
}

function shouldMaskStableBackendError(resolvedMessage: string): boolean {
  return (
    resolvedMessage !== CODE_SIGNATURE_RECOVERY_ERROR &&
    resolvedMessage !== READ_ONLY_VOLUME_RECOVERY_ERROR
  );
}

type UpdaterFailureStage =
  | 'check_initial'
  | 'check_periodic'
  | 'install_deferred'
  | 'download_background'
  | 'event_error';

const reportedUpdaterFailures = new Set<string>();
/** electron-updater emits `error` and rejects with the same error object, so
 * one failure is reported under the first stage that sees it. */
const reportedUpdaterErrors = new WeakSet<object>();

/** Report a background updater failure once per session per stage and closed
 * Windows code. Only the fixed source and frames leave, never the message. */
function reportUpdaterFailure(
  stage: UpdaterFailureStage,
  error: unknown,
): void {
  if (typeof error === 'object' && error !== null) {
    if (reportedUpdaterErrors.has(error)) return;
    reportedUpdaterErrors.add(error);
  }
  const code = windowsUpdateErrorCode(error);
  const source = code === null ? `update.${stage}` : `update.${stage}.${code}`;
  if (reportedUpdaterFailures.has(source)) return;
  reportedUpdaterFailures.add(source);
  try {
    reportMainAppError(error, { source });
  } catch {
    // Reporting must never change updater behavior.
  }
}

function handleUpdaterError(
  error: unknown,
  options: { maskStableBackendError?: boolean } = {},
): Error {
  const resolvedMessage = toErrorMessage(error);
  const shouldMask =
    RELEASE_FLAVOR === 'stable' &&
    options.maskStableBackendError === true &&
    shouldMaskStableBackendError(resolvedMessage) &&
    windowsUpdateErrorMessage(error) === null;
  const message = shouldMask ? STABLE_UPDATE_ERROR : resolvedMessage;
  // Force a fresh token resolve on the next attempt so an expired or revoked
  // token doesn't keep returning cached failures.
  invalidateGitHubAuthCache();
  setState(
    {
      ...updateState,
      phase: 'error',
      message,
      checkedAt: new Date().toISOString(),
      target: activeTargetUpdate ?? undefined,
    },
    { type: 'error', message },
  );
  activeTargetUpdate = null;

  return error instanceof Error ? error : new Error(message);
}

function ensureDistributionAllowsUpdates(): void {
  if (isLocalOnlyBuild())
    throw handleUpdaterError(new Error(LOCAL_ONLY_BUILD_UPDATE_ERROR));
  if (IS_SOURCE_BUILD)
    throw handleUpdaterError(new Error(SOURCE_BUILD_UPDATE_ERROR));
}

function ensurePackaged(): void {
  if (!app.isPackaged) {
    throw new Error(UNPACKAGED_BUILD_ERROR);
  }
}

class UnsupportedLinuxUpdateError extends Error {}

function linuxFailureMessage(error: unknown): string {
  const copy = linuxUpdateCopy(BRAND, RELEASE_FLAVOR);
  if (error instanceof UnsupportedLinuxUpdateError) return error.message;
  if (
    error instanceof Error &&
    (error.message === PRIVATE_REPO_AUTH_ERROR ||
      error.message === copy.authentication)
  )
    return copy.authentication;
  return copy.unavailable;
}

interface LinuxPackageInstall {
  architecture: LinuxPackageArchitecture;
  source: PackageManagedLinuxInstallSource;
}

/**
 * Resolves the install source and package architecture once per operation;
 * callers thread them through every release decision so one check never
 * mixes architectures.
 */
async function ensureLinuxPackage(): Promise<LinuxPackageInstall> {
  const source = app.isPackaged
    ? await detectLinuxInstallSource(linuxInstallRoots())
    : { kind: 'unknown' as const };
  if (source.kind !== 'deb' && source.kind !== 'pacman') {
    throw new UnsupportedLinuxUpdateError(
      linuxUpdateCopy(BRAND, RELEASE_FLAVOR).unsupported,
    );
  }
  const architecture = await installedLinuxPackageArchitecture();
  if (architecture === null) {
    throw new UnsupportedLinuxUpdateError(
      linuxUpdateCopy(BRAND, RELEASE_FLAVOR).unsupported,
    );
  }
  return { architecture, source };
}

/** The package manager, not this app, chooses which version gets installed. */
function refusePackageManagerTarget(install: LinuxPackageInstall): void {
  if (install.source.kind === 'pacman')
    throw new UnsupportedLinuxUpdateError(
      linuxUpdateCopy(BRAND, RELEASE_FLAVOR).packageManagerVersion,
    );
}

async function linuxUpdateInfo(
  release: VerifiedLinuxRelease,
  source: PackageManagedLinuxInstallSource,
): Promise<UpdateInfoData> {
  if (source.kind === 'pacman')
    return {
      version: release.version,
      packageManagerUpdate: {
        guidance: linuxUpdateCopy(BRAND, RELEASE_FLAVOR).packageManager,
        command: PACMAN_UPDATE_COMMAND,
      },
    };
  return {
    version: release.version,
    ...((await systemUpdaterAvailable()) && {
      systemUpdater: 'update-manager' as const,
    }),
    manualDownload: {
      url: release.url,
      guidance: linuxUpdateCopy(BRAND, RELEASE_FLAVOR).verification,
      checksum: { algorithm: release.algorithm, value: release.checksum },
    },
  };
}

/** Includes suspended candidates so their local intent survives feed checks. */
function hasLinuxInstalledUpdate(state: UpdateState = updateState): boolean {
  return (
    hostPlatformOperatingSystem() === 'linux' &&
    state.info?.installedByPackageManager === true
  );
}

function linuxRelaunchBlockReason(): string | null {
  const copy = linuxUpdateCopy(BRAND, RELEASE_FLAVOR);
  if (isWorkflowDirty()) return copy.relaunchBlockedByEdits;
  if (isPackageTransactionRunning()) return copy.relaunchWaitForTerminal;
  if (
    updateState.phase !== 'downloaded' ||
    linuxInstalledPackageWatch?.isRelaunchReady() !== true
  )
    return copy.relaunchWaitForPackage;
  return null;
}

function linuxInstallRoots(): { dpkgInfoDir?: string; execPath?: string } {
  return linuxRoots
    ? {
        dpkgInfoDir: join(linuxRoots.dpkgDir, 'info'),
        execPath: linuxRoots.execPath,
      }
    : {};
}

async function startLinuxInstalledPackageWatch(
  options?: UpdaterOptions,
): Promise<void> {
  if (hostPlatformOperatingSystem() !== 'linux' || !app.isPackaged) return;
  const generation = updaterGeneration;
  const source = await detectLinuxInstallSource(linuxInstallRoots());
  if (generation !== updaterGeneration || source.kind !== 'deb') return;
  const backend = createDpkgBackend({
    packageName: source.packageName,
    dpkgDir: linuxRoots?.dpkgDir,
  });
  stopPackageTransactionTracking =
    options?.startPackageTransactionTracking?.(
      backend.transactionProcessNames,
      maybeRunDeferredInstall,
    ) ?? null;
  linuxInstalledPackageWatch = watchInstalledPackage({
    backend,
    runningVersion: app.getVersion(),
    onInstalledChange(rawVersion): void {
      if (generation !== updaterGeneration) return;
      const wasSuspended =
        hasLinuxInstalledUpdate() && updateState.phase === 'idle';
      const info: UpdateInfoData = {
        version: backend.toAppVersion(rawVersion),
        installedByPackageManager: true,
      };
      activeTargetUpdate = null;
      setState(
        {
          phase: 'downloaded',
          info,
          installPending: updateState.installPending,
        },
        { type: 'downloaded', info },
      );
      // The renderer's downloaded event cannot carry pending across a
      // suspended snapshot with info. Restore its queued badge explicitly.
      if (wasSuspended && updateState.installPending)
        sendToRenderer({ type: 'install-pending', pending: true });
    },
    onBaselineRestored(): void {
      if (generation !== updaterGeneration || !hasLinuxInstalledUpdate())
        return;
      setInstallPending(false);
      setState({ phase: 'idle' });
      // Existing cancellation event also invalidates the renderer's installed
      // prompt. Send after idle (even if never queued) so getState sees reset.
      sendToRenderer({ type: 'install-pending', pending: false });
      void runAutomaticCheck().catch((error: unknown) => {
        reportUpdaterFailure('check_periodic', error);
      });
    },
    onReadinessChange(result): void {
      if (generation !== updaterGeneration) return;
      if (
        result !== 'installed-changed' &&
        hasLinuxInstalledUpdate() &&
        updateState.phase === 'downloaded'
      ) {
        clearDeferredInstallIdleTimer();
        setState({
          ...updateState,
          phase: 'idle',
          message: linuxUpdateCopy(BRAND, RELEASE_FLAVOR)
            .relaunchWaitForPackage,
        });
        // As on baseline restoration, invalidate the old renderer prompt.
        // Main/core retain pending intent in the authoritative idle snapshot.
        sendToRenderer({ type: 'install-pending', pending: false });
      }
      maybeRunDeferredInstall();
    },
    onPoll(): void {
      if (generation === updaterGeneration) maybeRunDeferredInstall();
    },
  });
  await linuxInstalledPackageWatch.readNow();
}

async function readLinuxInstalledPackage(): Promise<void> {
  await linuxInstalledPackageWatchStart;
  await linuxInstalledPackageWatch?.readNow();
}

function refuseLinuxInstall(allowInstalledRelaunch = false): void {
  if (
    hostPlatformOperatingSystem() === 'linux' &&
    !(allowInstalledRelaunch && hasLinuxInstalledUpdate())
  )
    throw new Error(linuxUpdateCopy(BRAND, RELEASE_FLAVOR).manual);
}

async function checkLinuxUpdates(
  request?: TargetUpdateRequest,
  generation = updaterGeneration,
): Promise<void> {
  // Local package state must win before even a checking event is emitted.
  // Keep this outside the feed-error catch so a relaunch refusal stays ready.
  await readLinuxInstalledPackage();
  if (generation !== updaterGeneration || hasLinuxInstalledUpdate()) return;
  try {
    const install = await ensureLinuxPackage();
    if (request) refusePackageManagerTarget(install);
    const { architecture } = install;
    if (generation !== updaterGeneration || hasLinuxInstalledUpdate()) return;
    setState({ phase: 'checking' }, { type: 'checking' });
    const target = request
      ? await getTargetReleaseInfo(request.tag, architecture)
      : undefined;
    let release: VerifiedLinuxRelease | null;
    if (isTargetedUpdateFlavor()) {
      const selected =
        target ?? (await findLatestLinuxTargetRelease(architecture));
      if (!selected)
        throw new Error(linuxUpdateCopy(BRAND, RELEASE_FLAVOR).unavailable);
      const response = await fetchGitHubReleaseApi(
        `/repos/unstoppabledomains/canopy/releases/tags/${encodeURIComponent(selected.tag)}`,
      );
      release = verifiedLinuxRelease(
        response.body,
        RELEASE_FLAVOR,
        architecture,
      );
      if (release?.version !== selected.version) release = null;
    } else {
      if (!UPDATE_BASE_URL)
        throw new Error(linuxUpdateCopy(BRAND, RELEASE_FLAVOR).unavailable);
      const response = await fetch(
        `${UPDATE_BASE_URL}/desktop/${BRAND.release.artifactPrefix}/${getExpectedGitHubMetadataAssetName(architecture)}`,
        {
          signal: AbortSignal.timeout(15_000),
          redirect: 'error',
        },
      );
      release = verifiedLinuxMetadata(
        load(await readLinuxReleaseText(response)),
        UPDATE_BASE_URL,
        architecture,
      );
    }
    if (generation !== updaterGeneration || hasLinuxInstalledUpdate()) return;
    if (!release)
      throw new Error(linuxUpdateCopy(BRAND, RELEASE_FLAVOR).unavailable);
    if (
      RELEASE_FLAVOR === 'stable' &&
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(app.getVersion())
    )
      throw new Error(linuxUpdateCopy(BRAND, RELEASE_FLAVOR).unavailable);
    const relation =
      RELEASE_FLAVOR === 'stable'
        ? undefined
        : compareTargetToCurrent(release.version);
    const current = app.getVersion().split('.').map(Number);
    const next = release.version.split('.').map(Number);
    const difference = next.findIndex((part, index) => part !== current[index]);
    const available =
      RELEASE_FLAVOR === 'stable'
        ? /^\d+\.\d+\.\d+$/.test(app.getVersion()) &&
          difference !== -1 &&
          next[difference] > current[difference]
        : relation === 'upgrade' ||
          (target !== undefined && relation === 'downgrade');
    const info = await linuxUpdateInfo(release, install.source);
    if (generation !== updaterGeneration || hasLinuxInstalledUpdate()) return;
    setState(
      {
        phase: available ? 'available' : 'not-available',
        info,
        target,
        checkedAt: new Date().toISOString(),
      },
      available ? { type: 'available', info } : { type: 'not-available' },
    );
  } catch (error) {
    if (generation !== updaterGeneration || hasLinuxInstalledUpdate()) return;
    invalidateGitHubAuthCache();
    const message = linuxFailureMessage(error);
    setState(
      { phase: 'error', message, checkedAt: new Date().toISOString() },
      { type: 'error', message },
    );
    throw new Error(message);
  }
}

async function getGitHubTokenForTargetedUpdates(): Promise<string> {
  const token = cachedGitHubToken ?? (await resolveGitHubToken());
  if (!token) {
    throw new Error(PRIVATE_REPO_AUTH_ERROR);
  }
  cachedGitHubToken = token;
  return token;
}

async function fetchGitHubReleaseApi(
  path: string,
  payload: 'release' | 'release-list' = 'release',
): Promise<{ body: unknown; nextCursor: string | null }> {
  const token = await getGitHubTokenForTargetedUpdates();
  const response = await fetch(`https://api.github.com${path}`, {
    ...(hostPlatformOperatingSystem() === 'linux'
      ? { signal: AbortSignal.timeout(15_000), redirect: 'error' as const }
      : {}),
    headers: {
      accept: 'application/vnd.github.v3+json',
      authorization: `token ${token}`,
    },
  });
  if (!response.ok) {
    throw new Error(
      `GitHub release request failed with HTTP ${response.status}.`,
    );
  }
  const link = response.headers.get('link') ?? '';
  const nextMatch = /[?&]page=([0-9]+)[^>]*>;\s*rel="next"/.exec(link);
  return {
    body:
      hostPlatformOperatingSystem() === 'linux'
        ? await readLinuxReleaseJson(response, payload)
        : await response.json(),
    nextCursor: nextMatch?.[1] ?? null,
  };
}

function isGitHubReleaseApiInfo(value: unknown): value is GitHubReleaseApiInfo {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  return (
    'tag_name' in value &&
    typeof value.tag_name === 'string' &&
    'assets' in value &&
    Array.isArray(value.assets)
  );
}

function normalizeListRequest(
  request: TargetUpdateVersionListRequest | undefined,
): { query: string; page: number; limit: number } {
  const requestedPage = Number(request?.cursor ?? '1');
  const requestedLimit = Number(request?.limit ?? 20);
  return {
    query: request?.query?.trim().toLowerCase() ?? '',
    page:
      Number.isFinite(requestedPage) && requestedPage > 0
        ? Math.floor(requestedPage)
        : 1,
    limit:
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(Math.floor(requestedLimit), 50)
        : 20,
  };
}

function releaseMatchesQuery(
  item: TargetUpdateVersionItem,
  query: string,
): boolean {
  if (!query) {
    return true;
  }
  return [item.tag, item.version, item.name ?? ''].some((value) =>
    value.toLowerCase().includes(query),
  );
}

const MAX_LINUX_RELEASE_PAGES = 10;

/** GitHub's publication order is not version order. Scan before selecting. */
async function findLatestLinuxTargetRelease(
  architecture: LinuxPackageArchitecture,
): Promise<TargetUpdateVersionItem | null> {
  let page = '1';
  let latest: TargetUpdateVersionItem | null = null;
  for (let pagesRead = 0; pagesRead < MAX_LINUX_RELEASE_PAGES; pagesRead += 1) {
    const result = await fetchGitHubReleaseApi(
      `/repos/unstoppabledomains/canopy/releases?per_page=100&page=${page}`,
      'release-list',
    );
    const releases = Array.isArray(result.body)
      ? result.body.filter(isGitHubReleaseApiInfo)
      : [];
    for (const release of releases) {
      if (!verifiedLinuxRelease(release, RELEASE_FLAVOR, architecture))
        continue;
      const item = targetInfoFromRelease(release);
      if (!latest || (compareTargetVersions(item.tag, latest.tag) ?? 0) > 0) {
        latest = item;
      }
    }
    if (result.nextCursor === null) return latest;
    page = result.nextCursor;
  }
  // An incomplete scan cannot establish the highest compatible version.
  throw new Error(linuxUpdateCopy(BRAND, RELEASE_FLAVOR).unavailable);
}

export async function listTargetUpdateVersions(
  request?: TargetUpdateVersionListRequest,
): Promise<TargetUpdateVersionListResponse> {
  ensureDistributionAllowsUpdates();
  try {
    return await listTargetUpdateVersionsImpl(request);
  } catch (error) {
    if (hostPlatformOperatingSystem() !== 'linux') throw error;
    if (error instanceof UnsupportedLinuxUpdateError) throw error;
    throw new Error(linuxFailureMessage(error));
  }
}

async function listTargetUpdateVersionsImpl(
  request?: TargetUpdateVersionListRequest,
): Promise<TargetUpdateVersionListResponse> {
  ensureTargetedUpdatesSupported();
  ensurePackaged();
  let linuxArchitecture: LinuxPackageArchitecture | null = null;
  if (hostPlatformOperatingSystem() === 'linux') {
    const install = await ensureLinuxPackage();
    refusePackageManagerTarget(install);
    linuxArchitecture = install.architecture;
  }

  const { query, limit, page: initialPage } = normalizeListRequest(request);
  let page = initialPage;
  let nextCursor: string | null = String(page);
  const items: TargetUpdateVersionItem[] = [];
  let pagesRead = 0;

  while (
    items.length < limit &&
    nextCursor !== null &&
    (hostPlatformOperatingSystem() !== 'linux' ||
      pagesRead < MAX_LINUX_RELEASE_PAGES)
  ) {
    pagesRead += 1;
    const result = await fetchGitHubReleaseApi(
      `/repos/unstoppabledomains/canopy/releases?per_page=100&page=${page}`,
      'release-list',
    );
    const releases = Array.isArray(result.body)
      ? result.body.filter(isGitHubReleaseApiInfo)
      : [];
    for (const release of releases) {
      if (
        isReleaseForCurrentFlavor(release) &&
        releaseHasExpectedMetadataAsset(release, linuxArchitecture)
      ) {
        const item = targetInfoFromRelease(release);
        if (releaseMatchesQuery(item, query)) {
          items.push(item);
        }
      }
    }
    nextCursor = result.nextCursor;
    page = nextCursor ? Number(nextCursor) : page + 1;
  }

  return {
    items,
    nextCursor,
  };
}

async function getTargetReleaseInfo(
  tag: string,
  linuxArchitecture: LinuxPackageArchitecture | null = null,
): Promise<TargetUpdateInfo> {
  ensureTargetedUpdatesSupported();
  ensurePackaged();
  const normalizedTag = tag.trim();
  if (!isStrictTargetTagForCurrentFlavor(normalizedTag)) {
    throw new Error(`Invalid targeted update tag: ${tag}`);
  }

  const result = await fetchGitHubReleaseApi(
    `/repos/unstoppabledomains/canopy/releases/tags/${encodeURIComponent(
      normalizedTag,
    )}`,
  );
  if (!isGitHubReleaseApiInfo(result.body)) {
    throw new Error(`No GitHub release was found for ${normalizedTag}.`);
  }
  if (
    !isReleaseForCurrentFlavor(result.body) ||
    (hostPlatformOperatingSystem() === 'linux' &&
      result.body.tag_name !== normalizedTag) ||
    !releaseHasExpectedMetadataAsset(result.body, linuxArchitecture)
  ) {
    throw new Error(
      `GitHub release ${normalizedTag} is not a valid ${RELEASE_FLAVOR} update.`,
    );
  }

  return targetInfoFromRelease(result.body);
}

async function applyGitHubAuth(targetReleaseTag?: string): Promise<void> {
  const token = await getGitHubTokenForTargetedUpdates();
  const feedKey = `${RELEASE_FLAVOR}:${targetReleaseTag ?? 'latest'}`;
  if (configuredGitHubFeedKey === feedKey) {
    return;
  }

  const feedOptions: CustomPublishOptions & {
    releaseFlavor?: 'internal' | 'rc';
    targetReleaseTag?: string;
  } = {
    provider: 'custom',
    updateProvider:
      BrandedPrivateGitHubProvider as unknown as CustomPublishOptions['updateProvider'],
    owner: 'unstoppabledomains',
    repo: 'canopy',
    private: true,
    token,
    channel: getBrandUpdateChannelName(BRAND),
    releaseFlavor: RELEASE_FLAVOR === 'rc' ? 'rc' : 'internal',
    ...(targetReleaseTag ? { targetReleaseTag } : {}),
  };
  getAutoUpdater().setFeedURL(feedOptions);
  configuredGitHubFeedKey = feedKey;
}

function applyStableFeed(): void {
  if (stableFeedConfigured) {
    return;
  }
  if (!UPDATE_BASE_URL) {
    throw new Error(STABLE_FEED_UNCONFIGURED_ERROR);
  }

  getAutoUpdater().setFeedURL({
    provider: 'generic',
    channel: getBrandUpdateChannelName(BRAND),
    url: `${UPDATE_BASE_URL}/desktop/${BRAND.release.artifactPrefix}`,
  });
  stableFeedConfigured = true;
}

function applyTargetedUpdateMode(target: TargetUpdateInfo | null): void {
  getAutoUpdater().allowPrerelease =
    RELEASE_FLAVOR === 'internal' || RELEASE_FLAVOR === 'rc';
  getAutoUpdater().allowDowngrade = target !== null;
}

async function applyUpdateFeed(
  target: TargetUpdateInfo | null = null,
): Promise<void> {
  applyTargetedUpdateMode(target);

  if (RELEASE_FLAVOR === 'internal' || RELEASE_FLAVOR === 'rc') {
    await applyGitHubAuth(target?.tag);
    return;
  }
  applyStableFeed();
}

function invalidateGitHubAuthCache(): void {
  cachedGitHubToken = null;
  configuredGitHubFeedKey = null;
}

async function shouldAutoDownloadUpdates(): Promise<boolean> {
  try {
    const preferences = await readPreferencesFile();
    return preferences.autoDownloadUpdates;
  } catch {
    return true;
  }
}

/**
 * Automatic checks follow the "Check for updates automatically" preference,
 * read on every timer tick so a change applies without a restart. A read
 * failure keeps checking. Manual checks never consult it.
 */
async function shouldCheckAutomatically(): Promise<boolean> {
  try {
    const preferences = await readPreferencesFile();
    return preferences.automaticUpdateChecks;
  } catch {
    // Unlike usage data, an update check carries no usage data and keeps
    // security fixes arriving, so an unreadable choice falls back to the
    // default rather than closing.
    return true;
  }
}

async function runAutomaticCheck(): Promise<void> {
  if (!(await shouldCheckAutomatically())) return;
  await checkForUpdates();
}

async function maybeStartBackgroundDownload(): Promise<void> {
  if (updateState.phase !== 'available') {
    return;
  }
  if (downloadInFlight) {
    return;
  }
  if (!(await shouldAutoDownloadUpdates())) {
    return;
  }
  if (updateState.phase !== 'available') {
    return;
  }
  try {
    await downloadUpdate();
  } catch (error) {
    // Errors are surfaced through the updater state stream.
    reportUpdaterFailure('download_background', error);
  }
}

function ensureListenersRegistered(): void {
  if (hostPlatformOperatingSystem() === 'linux') return;
  if (listenersRegistered) {
    return;
  }

  const autoUpdater = getAutoUpdater();
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease =
    RELEASE_FLAVOR === 'internal' || RELEASE_FLAVOR === 'rc';
  if (hostPlatformOperatingSystem() === 'win32') {
    // The stable CDN returns a full EXE for multipart ranges. Avoid the
    // differential/fallback path sharing a temporary installer destination.
    autoUpdater.disableDifferentialDownload = true;
    if ('verifyUpdateCodeSignature' in autoUpdater) {
      autoUpdater.verifyUpdateCodeSignature = createWindowsUpdateVerifier();
    }
  }

  autoUpdater.on('checking-for-update', () => {
    if (hostPlatformOperatingSystem() === 'linux') return;
    const nextState = ACTIONABLE_PHASES.has(updateState.phase)
      ? { ...updateState }
      : { phase: 'checking' as const };
    setState(nextState, { type: 'checking' });
  });

  autoUpdater.on('update-available', (info: UpdaterInfoLike) => {
    if (hostPlatformOperatingSystem() === 'linux') return;
    const normalizedInfo = normalizeUpdateInfo(info);
    setState(
      {
        phase: 'available',
        info: normalizedInfo,
        target: activeTargetUpdate ?? undefined,
        checkedAt: new Date().toISOString(),
      },
      { type: 'available', info: normalizedInfo },
    );
    void maybeStartBackgroundDownload();
  });

  autoUpdater.on('update-not-available', () => {
    if (hostPlatformOperatingSystem() === 'linux') return;
    setState(
      {
        phase: 'not-available',
        checkedAt: new Date().toISOString(),
        message: `${BRAND.displayName} is up to date.`,
        target: activeTargetUpdate ?? undefined,
      },
      { type: 'not-available' },
    );
    activeTargetUpdate = null;
  });

  autoUpdater.on('download-progress', (progress: ProgressInfoLike) => {
    if (hostPlatformOperatingSystem() === 'linux') return;
    const normalizedProgress = normalizeProgress(progress);
    setState(
      {
        phase: 'downloading',
        info: updateState.info,
        target: updateState.target,
        progress: normalizedProgress,
        checkedAt: updateState.checkedAt,
      },
      { type: 'download-progress', progress: normalizedProgress },
    );
  });

  autoUpdater.on('update-downloaded', (info: UpdaterInfoLike) => {
    if (hostPlatformOperatingSystem() === 'linux') return;
    const normalizedInfo = normalizeUpdateInfo(info);
    setState(
      {
        phase: 'downloaded',
        info: normalizedInfo,
        target: activeTargetUpdate ?? updateState.target,
        checkedAt: new Date().toISOString(),
      },
      { type: 'downloaded', info: normalizedInfo },
    );
  });

  autoUpdater.on('error', (error: unknown) => {
    if (hostPlatformOperatingSystem() === 'linux') return;
    handleUpdaterError(error, { maskStableBackendError: true });
    reportUpdaterFailure('event_error', error);
  });

  listenersRegistered = true;
}

function scheduleInitialCheck(): void {
  if (!app.isPackaged || startupTimer) {
    return;
  }

  startupTimer = setTimeout(() => {
    startupTimer = null;
    void runAutomaticCheck().catch((error: unknown) => {
      // The service state/event already captures the failure.
      reportUpdaterFailure('check_initial', error);
    });
  }, INITIAL_CHECK_DELAY_MS);
}

function scheduleAutomaticChecks(): void {
  if (!app.isPackaged || periodicTimer) {
    return;
  }

  const window = getWindowRef?.();
  const isLoading = window?.webContents.isLoading?.() ?? false;

  if (window && !window.isDestroyed() && isLoading) {
    window.webContents.once('did-finish-load', () => {
      scheduleInitialCheck();
    });
  } else {
    scheduleInitialCheck();
  }

  periodicTimer = setInterval(() => {
    void runAutomaticCheck().catch((error: unknown) => {
      // The service state/event already captures the failure.
      reportUpdaterFailure('check_periodic', error);
    });
  }, PERIODIC_CHECK_INTERVAL_MS);
}

export function startUpdater(
  getWindow: () => UpdaterBrowserWindow | null,
  beforeInstall?: BeforeInstallUpdate,
  options?: UpdaterOptions,
): void {
  getWindowRef = getWindow;
  // Do not even construct electron-updater for source builds: doing so can
  // register its apply-on-quit hook independently of our manual install path.
  // Keep only the window reference so manual actions can explain the policy.
  // Local-only builds never schedule an update check either.
  if (IS_SOURCE_BUILD || isLocalOnlyBuild()) return;
  beforeInstallUpdate = beforeInstall ?? null;
  isWorkflowDirty = options?.isWorkflowDirty ?? ((): boolean => false);
  isPackageTransactionRunning =
    options?.isPackageTransactionRunning ?? ((): boolean => false);
  linuxRoots = options?.linuxRoots;
  if (linuxInstalledPackageWatchStart === null) {
    linuxInstalledPackageWatchStart = startLinuxInstalledPackageWatch(
      options,
    ).catch((error: unknown) => {
      logMainProcessWarn('Installed package watcher could not start', error);
    });
  }
  if (unsubscribeChatSessionActivity === null) {
    unsubscribeChatSessionActivity = subscribeChatSessionActivity(() => {
      maybeRunDeferredInstall();
    });
  }
  ensureListenersRegistered();
  scheduleAutomaticChecks();
}

export function stopUpdater(): void {
  updaterGeneration += 1;
  linuxInstalledPackageWatch?.dispose();
  linuxInstalledPackageWatch = null;
  linuxInstalledPackageWatchStart = null;
  stopPackageTransactionTracking?.();
  stopPackageTransactionTracking = null;
  isWorkflowDirty = (): boolean => false;
  isPackageTransactionRunning = (): boolean => false;
  linuxRoots = undefined;
  if (hostPlatformOperatingSystem() === 'linux')
    updateState = { phase: 'idle' };
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }

  if (periodicTimer) {
    clearInterval(periodicTimer);
    periodicTimer = null;
  }
  clearDeferredInstallIdleTimer();

  getWindowRef = null;
  beforeInstallUpdate = null;
  if (unsubscribeChatSessionActivity) {
    unsubscribeChatSessionActivity();
    unsubscribeChatSessionActivity = null;
  }
  checkInFlight = null;
  downloadInFlight = null;
  activeTargetUpdate = null;
  rendererBusy = true;
  invalidateGitHubAuthCache();
  stableFeedConfigured = false;
  if (updateState.installPending) {
    updateState = { ...updateState, installPending: false };
  }
}

export async function checkForUpdates(): Promise<void> {
  ensureDistributionAllowsUpdates();
  if (checkInFlight) {
    return checkInFlight;
  }

  const generation = updaterGeneration;
  activeTargetUpdate = null;
  checkInFlight = (async (): Promise<void> => {
    try {
      if (hostPlatformOperatingSystem() === 'linux') {
        await checkLinuxUpdates(undefined, generation);
        return;
      }
      try {
        ensurePackaged();
        await applyUpdateFeed(null);
      } catch (error) {
        throw handleUpdaterError(error);
      }

      try {
        await getAutoUpdater().checkForUpdates();
      } catch (error) {
        throw handleUpdaterError(error, { maskStableBackendError: true });
      }
    } finally {
      if (generation === updaterGeneration) checkInFlight = null;
    }
  })();

  return checkInFlight;
}

export async function checkForVersion(
  request: TargetUpdateRequest,
): Promise<void> {
  ensureDistributionAllowsUpdates();
  const generation = updaterGeneration;
  if (hostPlatformOperatingSystem() === 'linux') {
    await readLinuxInstalledPackage();
    if (generation !== updaterGeneration) return;
    if (hasLinuxInstalledUpdate()) {
      if (updateState.phase !== 'downloaded')
        throw new Error(
          linuxUpdateCopy(BRAND, RELEASE_FLAVOR).relaunchWaitForPackage,
        );
      throw new Error(linuxUpdateCopy(BRAND, RELEASE_FLAVOR).relaunchFirst);
    }
  }
  if (checkInFlight) {
    throw new Error('An update check is already in progress.');
  }

  checkInFlight = (async (): Promise<void> => {
    try {
      if (hostPlatformOperatingSystem() === 'linux') {
        await checkLinuxUpdates(request, generation);
        return;
      }
      let target: TargetUpdateInfo;
      try {
        target = await getTargetReleaseInfo(request.tag);
        activeTargetUpdate = target;
        await applyUpdateFeed(target);
      } catch (error) {
        throw handleUpdaterError(error);
      }

      try {
        await getAutoUpdater().checkForUpdates();
      } catch (error) {
        throw handleUpdaterError(error, { maskStableBackendError: true });
      }
    } finally {
      if (generation === updaterGeneration) checkInFlight = null;
    }
  })();

  return checkInFlight;
}

/**
 * Throws the refusal `downloadUpdate` would reject with, synchronously, so a
 * caller can refuse before it starts a download it does not wait for.
 */
export function assertDownloadAllowed(): void {
  ensureDistributionAllowsUpdates();
  refuseLinuxInstall();
  if (
    updateState.phase !== 'downloaded' &&
    updateState.phase !== 'available' &&
    updateState.phase !== 'downloading'
  ) {
    throw new Error('No update is available to download.');
  }
}

export async function downloadUpdate(): Promise<void> {
  assertDownloadAllowed();
  if (updateState.phase === 'downloaded') {
    return;
  }

  if (downloadInFlight) {
    return downloadInFlight;
  }

  downloadInFlight = (async (): Promise<void> => {
    try {
      try {
        ensurePackaged();
        await applyUpdateFeed(activeTargetUpdate ?? updateState.target ?? null);
      } catch (error) {
        throw handleUpdaterError(error);
      }

      try {
        if (hostPlatformOperatingSystem() === 'win32')
          await cleanupWindowsUpdateTempFiles(getAutoUpdater());
        await getAutoUpdater().downloadUpdate();
      } catch (error) {
        if (hostPlatformOperatingSystem() === 'win32') {
          try {
            await cleanupWindowsUpdateTempFiles(getAutoUpdater());
          } catch (cleanupError) {
            // Preserve the original failure while recording an unsuccessful
            // cleanup; the next download's preflight will refuse a locked file.
            logMainProcessError(
              'Windows update failure cleanup failed',
              cleanupError,
            );
          }
        }
        throw handleUpdaterError(error, { maskStableBackendError: true });
      }
    } finally {
      downloadInFlight = null;
    }
  })();

  return downloadInFlight;
}

/** Throws, with the message people see, when an install cannot start now. */
export function assertInstallAllowed(): void {
  ensureDistributionAllowsUpdates();
  refuseLinuxInstall(true);
  if (hasLinuxInstalledUpdate()) {
    const blocked = linuxRelaunchBlockReason();
    if (blocked) throw new Error(blocked);
  }
  if (updateState.phase !== 'downloaded') {
    throw new Error('No downloaded update is ready to install.');
  }
}

export async function installUpdate(): Promise<void> {
  assertInstallAllowed();
  await runInstallUpdate('immediate');
}

export function scheduleUpdate(): void {
  ensureDistributionAllowsUpdates();
  refuseLinuxInstall(true);
  if (updateState.phase !== 'downloaded') {
    throw new Error('No downloaded update is ready to install.');
  }

  setInstallPending(true);
  maybeRunDeferredInstall();
}

export function cancelScheduledUpdate(): void {
  setInstallPending(false);
}

/** Listens for every change to the update state, including install-pending. */
export function onUpdateStateChange(listener: () => void): () => void {
  stateListeners.add(listener);
  return (): void => {
    stateListeners.delete(listener);
  };
}

/** Whether the main window reported running work, as deferred installs see it. */
export function isRendererBusy(): boolean {
  return rendererBusy;
}

/** Whether this build installs its own updates, and why not when it can't. */
export function getUpdateInstallSupport():
  | { supported: true }
  | { supported: false; reason: string; message: string } {
  if (isLocalOnlyBuild())
    return {
      supported: false,
      reason: 'local_only_build',
      message: LOCAL_ONLY_BUILD_UPDATE_ERROR,
    };
  if (IS_SOURCE_BUILD)
    return {
      supported: false,
      reason: 'source_build',
      message: SOURCE_BUILD_UPDATE_ERROR,
    };
  if (!app.isPackaged)
    return {
      supported: false,
      reason: 'not_packaged',
      message: UNPACKAGED_BUILD_ERROR,
    };
  if (hostPlatformOperatingSystem() === 'linux')
    return {
      supported: false,
      reason: 'linux_package_manager',
      message: linuxUpdateCopy(BRAND, RELEASE_FLAVOR).manual,
    };
  return { supported: true };
}

export function reportRendererBusyState(busy: boolean): void {
  if (getWindowRef === null) {
    return;
  }
  if (rendererBusy === busy) {
    return;
  }
  rendererBusy = busy;
  notifyStateListeners();
  maybeRunDeferredInstall();
}

/** Wakes a queued relaunch when workflow edits are saved, discarded or lost. */
export function reportWorkflowDirtyState(): void {
  maybeRunDeferredInstall();
}

export function getUpdateState(): UpdateState {
  return updateState;
}
