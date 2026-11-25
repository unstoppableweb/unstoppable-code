import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface CopilotRuntimeArtifact {
  version: string;
  url: string;
  integrity: string;
  archiveBytes: number;
  executableSha256: string;
}

interface CopilotRuntimeConfig {
  version: string;
  artifacts: Record<string, Omit<CopilotRuntimeArtifact, 'version'>>;
}

declare const __CANOPY_COPILOT_CLI__: CopilotRuntimeConfig | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCopilotRuntimeConfig(value: unknown): value is CopilotRuntimeConfig {
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

function config(): CopilotRuntimeConfig {
  if (typeof __CANOPY_COPILOT_CLI__ !== 'undefined')
    return __CANOPY_COPILOT_CLI__;
  // Direct tsx/CLI development fallback; packaged builds inject only this entry.
  const manifest: unknown = JSON.parse(
    readFileSync(resolve(__dirname, '../../../../../package.json'), 'utf8'),
  );
  const entry = isRecord(manifest) ? manifest['copilot-cli'] : undefined;
  if (!isCopilotRuntimeConfig(entry))
    throw new Error('Copilot runtime metadata is missing.');
  return entry;
}

const metadata = config();
export const COPILOT_RUNTIME_VERSION = metadata.version;

/**
 * The pinned artifact for a host, or undefined when none is pinned. Linux pins
 * are GitHub's glibc builds; like every platform, the launch check is the
 * pinned executable digest.
 */
export function getCopilotRuntimeArtifact(
  platform: string = process.platform,
  arch: string = process.arch,
): CopilotRuntimeArtifact | undefined {
  if (
    !['darwin', 'linux', 'win32'].includes(platform) ||
    !['arm64', 'x64'].includes(arch)
  )
    return undefined;
  const artifact = metadata.artifacts[`${platform}-${arch}`];
  return artifact ? { version: metadata.version, ...artifact } : undefined;
}

export function copilotExecutableName(
  platform: string = process.platform,
): 'copilot' | 'copilot.exe' {
  return platform === 'win32' ? 'copilot.exe' : 'copilot';
}
