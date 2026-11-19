import {
  ANTIGRAVITY_MANAGED_EXECUTABLE_NAME,
  getAntigravityRuntimeArtifact,
  type AntigravityRuntimeArtifact,
} from '@canopy/desktop-shared/node/antigravity/runtime-artifacts';
import { getAntigravityRuntimeRootDir } from '@canopy/execution-engine/pipelines/config-paths';
import { ManagedRuntimeInstaller } from '../lib/managed-runtime-installer';

/** The Antigravity CLI release tarball holds one file, `antigravity`, at its root. */
export class AntigravityRuntimeInstaller extends ManagedRuntimeInstaller {
  constructor(options: {
    root: string;
    artifact: AntigravityRuntimeArtifact;
    fetchArchive?: typeof fetch;
    allowLoopback?: boolean;
  }) {
    super({
      ...options,
      label: 'Antigravity',
      executableName: ANTIGRAVITY_MANAGED_EXECUTABLE_NAME,
      archivePath: ANTIGRAVITY_MANAGED_EXECUTABLE_NAME,
      source: 'github-release',
      archiveFormat: 'tgz',
    });
  }
}

let cached: { key: string; installer: AntigravityRuntimeInstaller } | undefined;

/**
 * The installer for this device's pinned artifact, or undefined where the
 * manifest has none. One instance per root and artifact, so concurrent
 * installs share the installer's single download.
 */
export function getAntigravityRuntimeInstaller(
  fetchArchive?: typeof fetch,
): AntigravityRuntimeInstaller | undefined {
  const artifact = getAntigravityRuntimeArtifact();
  if (!artifact) return undefined;
  const root = getAntigravityRuntimeRootDir();
  const key = JSON.stringify([root, artifact]);
  if (cached?.key === key && !fetchArchive) return cached.installer;
  const installer = new AntigravityRuntimeInstaller({
    root,
    artifact,
    fetchArchive,
    allowLoopback: typeof __CANOPY_E2E__ !== 'undefined' && __CANOPY_E2E__,
  });
  if (!fetchArchive) cached = { key, installer };
  return installer;
}
