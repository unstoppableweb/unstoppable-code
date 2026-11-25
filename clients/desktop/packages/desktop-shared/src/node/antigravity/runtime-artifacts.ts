import {
  hostPlatformArchitecture,
  hostPlatformOperatingSystem,
} from '@canopy/core-platform';
import { createRequire } from 'node:module';
import { join } from 'node:path';

export interface AntigravityRuntimeArtifact {
  version: string;
  url: string;
  integrity: string;
  archiveBytes: number;
  executableSha256: string;
}

interface AntigravityRuntimeConfig {
  version: string;
  artifacts: Record<string, Omit<AntigravityRuntimeArtifact, 'version'>>;
}

declare const __CANOPY_ANTIGRAVITY_CLI__: AntigravityRuntimeConfig | undefined;

export const ANTIGRAVITY_MANAGED_EXECUTABLE_NAME = 'antigravity';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAntigravityRuntimeConfig(
  value: unknown,
): value is AntigravityRuntimeConfig {
  if (
    !isRecord(value) ||
    typeof value.version !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(value.version) ||
    !isRecord(value.artifacts)
  )
    return false;
  return Object.values(value.artifacts).every(
    (artifact) =>
      isRecord(artifact) &&
      typeof artifact.url === 'string' &&
      typeof artifact.integrity === 'string' &&
      typeof artifact.archiveBytes === 'number' &&
      typeof artifact.executableSha256 === 'string',
  );
}

function config(): AntigravityRuntimeConfig {
  if (typeof __CANOPY_ANTIGRAVITY_CLI__ !== 'undefined')
    return __CANOPY_ANTIGRAVITY_CLI__;
  // Direct tsx/CLI development fallback; packaged builds inject only this entry.
  const manifest: unknown = createRequire(__filename)(
    '../../../../../package.json',
  );
  const entry = isRecord(manifest) ? manifest['antigravity-cli'] : undefined;
  if (!isAntigravityRuntimeConfig(entry))
    throw new Error('Antigravity runtime metadata is missing.');
  return entry;
}

const metadata = config();

/**
 * The pinned artifact for a host, or undefined where none is qualified. Linux
 * pins Google's glibc builds; the desktop app needs glibc, and the musl builds
 * are not pinned. Windows has no pinned artifact, which keeps it refused.
 */
export function getAntigravityRuntimeArtifact(
  platform: string = hostPlatformOperatingSystem(),
  arch: string = hostPlatformArchitecture(),
): AntigravityRuntimeArtifact | undefined {
  if (
    !['darwin', 'linux'].includes(platform) ||
    !['arm64', 'x64'].includes(arch)
  )
    return undefined;
  const artifact = metadata.artifacts[`${platform}-${arch}`];
  return artifact ? { version: metadata.version, ...artifact } : undefined;
}

/**
 * Whether Google subscription chats can run on this host: a pinned artifact
 * exists for it. Every launch also verifies the file it runs, by Google's
 * Developer ID signature on macOS and by the pinned executable digest on
 * Linux.
 */
export function isAntigravityPlatformSupported(
  platform: string = hostPlatformOperatingSystem(),
  arch: string = hostPlatformArchitecture(),
): boolean {
  return getAntigravityRuntimeArtifact(platform, arch) !== undefined;
}

export function managedAntigravityExecutable(
  rootDir: string,
  artifact: AntigravityRuntimeArtifact,
): string {
  return join(rootDir, artifact.version, ANTIGRAVITY_MANAGED_EXECUTABLE_NAME);
}
