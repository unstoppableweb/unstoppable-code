import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { z } from 'zod';
import type {
  CoreUpdateHost,
  DesktopFailedUpdateAttempt,
  DesktopUpdateAttempt,
  DesktopUpdateSnapshot,
  DesktopUpdateSupport,
} from '@canopy/core-runtime/update';
import { getDataDir } from '../lib/paths';
import {
  hasActiveChatWork,
  subscribeChatSessionActivity,
} from '../agents/session-manager';
import { getCanopyReleaseFlavor } from '../lib/app-identity';
import {
  getInternalReleaseIndicatorForDisplay,
  toInternalReleaseIndicator,
} from '../lib/internal-release-version';
import {
  assertDownloadAllowed,
  assertInstallAllowed,
  cancelScheduledUpdate,
  checkForUpdates,
  downloadUpdate,
  getUpdateInstallSupport,
  getUpdateState,
  installUpdate,
  isRendererBusy,
  onUpdateStateChange,
  scheduleUpdate,
} from '../updater';

const ATTEMPT_FILE = 'update-attempt.json';
const processStartedAt = Date.now();

const AttemptFileSchema = z.object({
  targetVersion: z.string().min(1).max(128),
  requestedBy: z.string().min(1).max(120).nullable(),
  at: z.iso.datetime({ offset: true }),
});

function attemptPath(): string {
  return join(getDataDir(), ATTEMPT_FILE);
}

function writeAttempt(attempt: DesktopUpdateAttempt | null): void {
  try {
    if (attempt === null) {
      rmSync(attemptPath(), { force: true });
      return;
    }
    writeFileSync(
      attemptPath(),
      JSON.stringify({ ...attempt, at: new Date().toISOString() }),
      { mode: 0o600 },
    );
  } catch {
    // The record only explains a failed restart; an install never waits on it.
  }
}

/**
 * An install recorded by an earlier run that restarted on another version.
 * One that reached its version is forgotten; one from this run is still
 * pending.
 */
function readFailedAttempt(
  currentVersion: string,
): DesktopFailedUpdateAttempt | null {
  let parsed: z.infer<typeof AttemptFileSchema>;
  try {
    const result = AttemptFileSchema.safeParse(
      JSON.parse(readFileSync(attemptPath(), 'utf8')),
    );
    if (!result.success) return null;
    parsed = result.data;
  } catch {
    return null;
  }
  if (Date.parse(parsed.at) >= processStartedAt) return null;
  if (parsed.targetVersion === currentVersion) {
    writeAttempt(null);
    return null;
  }
  return parsed;
}

/**
 * The desktop package installer behind `core.update.*`: this process's
 * electron-updater state machine, with its own feed, signature checks,
 * deferred install and cleanup. Core reads and drives it only through this
 * port.
 */
export function createDesktopCoreUpdateHost(): CoreUpdateHost {
  const releaseFlavor = getCanopyReleaseFlavor();
  // An earlier run's record cannot change while this one runs, so it is
  // read once; this run's own records are still pending.
  let earlierAttempt: DesktopFailedUpdateAttempt | null | undefined;
  const display = (version: string): string =>
    releaseFlavor === 'internal'
      ? (toInternalReleaseIndicator(version) ?? version)
      : version;

  return {
    releaseFlavor,
    support: (): DesktopUpdateSupport => {
      const support = getUpdateInstallSupport();
      if (support.supported || support.reason !== 'linux_package_manager')
        return support;
      // Linux updates through its package manager. A check that found a
      // pacman install names its own command; otherwise the steps follow
      // the brand and channel.
      const pacman = getUpdateState().info?.packageManagerUpdate;
      return {
        ...support,
        manualInstructions: pacman
          ? `${pacman.guidance} ${pacman.command}`
          : support.message,
      };
    },
    snapshot: (): DesktopUpdateSnapshot => {
      const state = getUpdateState();
      const currentVersion = app.getVersion();
      const availableVersion = state.info?.version ?? null;
      return {
        phase: state.phase,
        currentVersion,
        displayVersion:
          releaseFlavor === 'internal'
            ? getInternalReleaseIndicatorForDisplay(currentVersion)
            : currentVersion,
        availableVersion,
        availableDisplayVersion:
          availableVersion === null ? null : display(availableVersion),
        progressPercent: state.progress?.percent ?? null,
        message: state.message ?? null,
        restartPending: state.installPending === true,
        targeted: state.target !== undefined,
      };
    },
    blockers: () => ({
      activeChatWork: hasActiveChatWork(),
      windowBusy: isRendererBusy(),
    }),
    subscribe: (listener) => {
      const stopState = onUpdateStateChange(listener);
      const stopActivity = subscribeChatSessionActivity(() => listener());
      return (): void => {
        stopState();
        stopActivity();
      };
    },
    check: () => checkForUpdates(),
    startDownload: () => {
      assertDownloadAllowed();
      return downloadUpdate();
    },
    installNow: () => {
      assertInstallAllowed();
      return installUpdate();
    },
    scheduleRestart: () => scheduleUpdate(),
    cancelScheduledRestart: () => cancelScheduledUpdate(),
    recordAttempt: (attempt) => writeAttempt(attempt),
    lastFailedAttempt: () => {
      earlierAttempt ??= readFailedAttempt(app.getVersion());
      return earlierAttempt;
    },
  };
}
