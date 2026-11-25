import { lstat } from 'node:fs/promises';
import type { AntigravityRuntimeStatus } from '@canopy/desktop-shared/types/antigravity-runtime';
import {
  getAntigravityRuntimeArtifact,
  managedAntigravityExecutable,
} from '@canopy/desktop-shared/node/antigravity/runtime-artifacts';
import { ANTIGRAVITY_RUNTIME_VERSION } from '@canopy/desktop-shared/node/antigravity/runtime-metadata';
import { resolveAntigravityExecutable } from '@canopy/desktop-shared/node/antigravity/runtime-resolution';
import { verifyManagedExecutable } from '@canopy/desktop-shared/node/managed-runtime/verification';
import { getAntigravityRuntimeRootDir } from '@canopy/execution-engine/pipelines/config-paths';
import {
  assertAntigravityHarnessEnabled,
  isAntigravityHarnessEnabled,
} from './feature-flag';
import { getAntigravityRuntimeInstaller } from './runtime-installer';
import { readPreferencesFileDetailed } from '../lib/preferences-store';

/** App-local consent only. Google's credential store is never changed here. */
export async function isAntigravityConnectionEnabled(): Promise<boolean> {
  if (!isAntigravityHarnessEnabled()) return false;
  const { authority, preferences } = await readPreferencesFileDetailed();
  return (
    isAntigravityHarnessEnabled() &&
    authority !== 'unreadable' &&
    preferences.googleSubscriptionDisconnected !== true
  );
}

const INSTALL_TIMEOUT_MS = 30 * 60_000;
const VERIFY_TIMEOUT_MS = 60_000;

type Progress = (status: AntigravityRuntimeStatus) => void;

interface RunningInstall {
  controller: AbortController;
  /** The operation that started this install; its window owns it. */
  origin: string;
  operationIds: Set<string>;
  listeners: Set<Progress>;
  phase: AntigravityRuntimeStatus['phase'];
  done: Promise<AntigravityRuntimeStatus>;
}

let running: RunningInstall | undefined;
// The file identity last verified, so repeated status reads do not rehash an
// unchanged binary. Any write to the file changes its ctime.
let verifiedStamp: string | undefined;

function managedFailure(): string {
  return `The managed Antigravity CLI ${ANTIGRAVITY_RUNTIME_VERSION} did not match its pinned sha256, so it is not used. Install it again.`;
}

/** `true` when the managed copy verifies, a reason when it fails, undefined when absent. */
async function verifyManagedCopy(
  executable: string,
  executableSha256: string,
): Promise<true | string | undefined> {
  let stamp: string;
  try {
    const info = await lstat(executable);
    stamp = JSON.stringify([
      executable,
      executableSha256,
      info.ino,
      info.size,
      info.mtimeMs,
      info.ctimeMs,
    ]);
  } catch {
    return undefined;
  }
  if (stamp === verifiedStamp) return true;
  try {
    await verifyManagedExecutable(
      executable,
      executableSha256,
      AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      'Antigravity',
    );
  } catch {
    return managedFailure();
  }
  verifiedStamp = stamp;
  return true;
}

async function readStatus(): Promise<AntigravityRuntimeStatus> {
  const artifact = getAntigravityRuntimeArtifact();
  const base = { supported: !!artifact, version: ANTIGRAVITY_RUNTIME_VERSION };
  let error: string | undefined;
  if (artifact) {
    const executable = managedAntigravityExecutable(
      getAntigravityRuntimeRootDir(),
      artifact,
    );
    const verified = await verifyManagedCopy(
      executable,
      artifact.executableSha256,
    );
    if (verified === true)
      return {
        ...base,
        installed: true,
        managed: true,
        executable,
        phase: 'installed',
      };
    error = verified;
  }
  try {
    const executable = await resolveAntigravityExecutable();
    return {
      ...base,
      installed: true,
      managed: false,
      executable,
      phase: 'installed',
      ...(error ? { error } : {}),
    };
  } catch {
    return {
      ...base,
      installed: false,
      managed: false,
      phase: error ? 'failed' : 'idle',
      ...(error ? { error } : {}),
    };
  }
}

/**
 * Which Antigravity CLI a launch would find: the managed copy when it exists
 * and its sha256 verifies, else a user copy. A managed copy that fails
 * verification is reported with the reason and never counted as installed.
 */
export async function antigravityRuntimeStatus(): Promise<AntigravityRuntimeStatus> {
  const pending = running;
  const status = await readStatus();
  if (!pending || running !== pending) return status;
  // Mid-install, the copy being replaced says nothing about the result.
  return {
    supported: status.supported,
    installed: status.installed,
    managed: status.managed,
    version: status.version,
    ...(status.executable ? { executable: status.executable } : {}),
    phase: pending.phase,
  };
}

function emit(install: RunningInstall, status: AntigravityRuntimeStatus): void {
  for (const listener of install.listeners) {
    try {
      listener(status);
    } catch {
      // One window's listener cannot stop another's progress.
    }
  }
}

async function join(
  install: RunningInstall,
  operationId: string,
  progress: Progress,
): Promise<AntigravityRuntimeStatus> {
  install.operationIds.add(operationId);
  install.listeners.add(progress);
  try {
    return await install.done;
  } finally {
    install.listeners.delete(progress);
  }
}

/**
 * Downloads, verifies and installs the pinned Antigravity CLI. A second call
 * while one runs joins it: one download, one result. Resolves with the final
 * status: `installed`, `failed` with the reason, or the status before the
 * install when it was cancelled.
 */
export async function installAntigravityRuntime(
  operationId: string,
  progress: Progress,
): Promise<AntigravityRuntimeStatus> {
  if (running) return join(running, operationId, progress);
  assertAntigravityHarnessEnabled();
  const installer = getAntigravityRuntimeInstaller();
  if (!installer) {
    const status = await readStatus();
    return {
      ...status,
      phase: 'failed',
      error:
        'The managed Antigravity CLI is available on macOS and Linux (x64 and arm64).',
    };
  }
  if (running) return join(running, operationId, progress);
  const controller = new AbortController();
  const install: RunningInstall = {
    controller,
    origin: operationId,
    operationIds: new Set(),
    listeners: new Set(),
    phase: 'downloading',
    done: runInstall(installer, controller, () => install),
  };
  running = install;
  return join(install, operationId, progress);
}

async function runInstall(
  installer: NonNullable<ReturnType<typeof getAntigravityRuntimeInstaller>>,
  controller: AbortController,
  current: () => RunningInstall,
): Promise<AntigravityRuntimeStatus> {
  // Let the caller record and join this install before any progress.
  await Promise.resolve();
  const install = current();
  const update = (phase: AntigravityRuntimeStatus['phase']): void => {
    install.phase = phase;
    emit(install, {
      supported: true,
      installed: false,
      managed: false,
      version: ANTIGRAVITY_RUNTIME_VERSION,
      phase,
    });
  };
  let final: AntigravityRuntimeStatus;
  try {
    update('downloading');
    await installer.install(
      AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(INSTALL_TIMEOUT_MS),
      ]),
      (phase) => {
        const next = phase === 'downloading' ? 'downloading' : 'verifying';
        if (next !== install.phase) update(next);
      },
    );
    final = await readStatus();
  } catch (error) {
    const status = await readStatus();
    final = controller.signal.aborted
      ? status
      : {
          ...status,
          phase: 'failed',
          error:
            error instanceof Error && error.message
              ? error.message
              : 'Antigravity CLI install failed. Try again.',
        };
  } finally {
    if (running === install) running = undefined;
  }
  emit(install, final);
  return final;
}

/** Stops the install the given operation started or joined. */
export async function cancelAntigravityRuntimeInstall(
  operationId: string,
): Promise<void> {
  const install = running;
  if (!install?.operationIds.has(operationId)) return;
  install.controller.abort();
  await install.done.catch(() => undefined);
}

/**
 * A window that started or joined an install went away. Only the window that
 * started it stops the download; a window that merely joined detaches.
 */
export async function releaseAntigravityRuntimeInstall(
  operationId: string,
): Promise<void> {
  const install = running;
  if (!install?.operationIds.has(operationId)) return;
  if (install.origin !== operationId) {
    install.operationIds.delete(operationId);
    return;
  }
  install.controller.abort();
  await install.done.catch(() => undefined);
}

/** App quit: stop any download in flight. */
export async function shutdownAntigravityRuntimeInstall(): Promise<void> {
  const install = running;
  if (!install) return;
  install.controller.abort();
  await install.done.catch(() => undefined);
}
