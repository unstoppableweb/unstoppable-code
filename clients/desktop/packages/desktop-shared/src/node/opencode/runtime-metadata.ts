import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface OpenCodeRuntimeArtifact {
  version: string;
  url: string;
  integrity: string;
  archiveBytes: number;
  executableSha256: string;
}

interface OpenCodeRuntimeConfig {
  version: string;
  artifacts: Record<string, Omit<OpenCodeRuntimeArtifact, 'version'>>;
}

declare const __CANOPY_OPENCODE_CLI__: OpenCodeRuntimeConfig | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOpenCodeRuntimeConfig(
  value: unknown,
): value is OpenCodeRuntimeConfig {
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

function config(): OpenCodeRuntimeConfig {
  if (typeof __CANOPY_OPENCODE_CLI__ !== 'undefined')
    return __CANOPY_OPENCODE_CLI__;
  // Direct tsx/CLI development fallback; packaged builds inject only this entry.
  const manifest: unknown = JSON.parse(
    readFileSync(resolve(__dirname, '../../../../../package.json'), 'utf8'),
  );
  const entry = isRecord(manifest) ? manifest['opencode-cli'] : undefined;
  if (!isOpenCodeRuntimeConfig(entry))
    throw new Error('OpenCode runtime metadata is missing.');
  return entry;
}

const metadata = config();
export const OPENCODE_RUNTIME_VERSION = metadata.version;

/**
 * The pinned artifact for a host, or undefined when none is pinned. x64 pins
 * use OpenCode's baseline builds on every platform; Linux pins are its glibc
 * builds, not the `-musl` packages.
 */
export function getOpenCodeRuntimeArtifact(
  platform: string = process.platform,
  arch: string = process.arch,
): OpenCodeRuntimeArtifact | undefined {
  if (
    !['darwin', 'linux', 'win32'].includes(platform) ||
    !['arm64', 'x64'].includes(arch)
  )
    return undefined;
  const artifact = metadata.artifacts[`${platform}-${arch}`];
  return artifact ? { version: metadata.version, ...artifact } : undefined;
}

export function opencodeExecutableName(
  platform: string = process.platform,
): 'opencode' | 'opencode.exe' {
  return platform === 'win32' ? 'opencode.exe' : 'opencode';
}
