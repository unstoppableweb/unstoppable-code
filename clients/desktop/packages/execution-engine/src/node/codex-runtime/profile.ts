import { createHash } from 'node:crypto';
import { codexProfileDigest } from './profile-digest-key';

export type CodexSpawnEnvironmentPolicy = 'inherit' | 'restricted';

export interface CodexSpawnProfileRequest {
  /** Restricted workers capture a fixed allowlist instead of the enhanced host environment. */
  environmentPolicy?: CodexSpawnEnvironmentPolicy;
  /** Thread-scoped command directories; never applied to the worker process. */
  commandDirectories?: readonly string[];
  binaryVersion?: string;
  environment?: Record<string, string>;
  logicalWorkspaceEnvironmentId?: string;
  secretVersionFingerprint?: string;
  mockProviderId?: string;
  experimentalSwitches?: Record<string, boolean | number | string>;
  configArgs?: string[];
  includeCanopySecrets?: boolean;
}

export interface CodexResolvedSpawnProfile {
  environmentPolicy: CodexSpawnEnvironmentPolicy;
  id: string;
  label: string;
  environment: Record<string, string>;
  configArgs: string[];
  includeCanopySecrets: boolean;
}

function stableRecord(
  value: Record<string, boolean | number | string> | undefined,
): Record<string, boolean | number | string> {
  return Object.fromEntries(
    Object.entries(value ?? {}).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

const FORBIDDEN_CODEX_SPAWN_ENVIRONMENT_KEYS = new Set([
  'HOME',
  'CODEX_HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'HOMESHARE',
]);

function isForbiddenCodexSpawnEnvironmentKey(key: string): boolean {
  return FORBIDDEN_CODEX_SPAWN_ENVIRONMENT_KEYS.has(key.toUpperCase());
}

export function sanitizeCodexSpawnEnvironment(
  environment: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) => !isForbiddenCodexSpawnEnvironmentKey(key),
    ),
  );
}

const RESTRICTED_RUNTIME_ENVIRONMENT_KEYS = new Set([
  ...Array.from(FORBIDDEN_CODEX_SPAWN_ENVIRONMENT_KEYS),
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SYSTEMROOT',
  'WINDIR',
]);

function restrictedEnvironment(
  overrides: Record<string, string>,
): Record<string, string> {
  for (const key of Object.keys(overrides)) {
    if (
      !RESTRICTED_RUNTIME_ENVIRONMENT_KEYS.has(key.toUpperCase()) ||
      key.toUpperCase() === 'SYSTEMROOT' ||
      key.toUpperCase() === 'WINDIR'
    ) {
      throw new Error(
        `${key} is not allowed in a restricted Codex runtime environment`,
      );
    }
  }
  // Home values come only from the host. The earlier validation prohibits
  // overriding them; canonical state verification still applies at initialize.
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined &&
          RESTRICTED_RUNTIME_ENVIRONMENT_KEYS.has(entry[0].toUpperCase()),
      ),
    ),
    ...overrides,
    PATH: '',
  };
}

export function resolveCodexSpawnProfile(
  request: CodexSpawnProfileRequest = {},
): CodexResolvedSpawnProfile {
  for (const key of Object.keys(request.environment ?? {})) {
    if (isForbiddenCodexSpawnEnvironmentKey(key)) {
      throw new Error(
        `${key} cannot be overridden by a Codex runtime spawn profile`,
      );
    }
  }
  const environmentPolicy = request.environmentPolicy ?? 'inherit';
  if (environmentPolicy !== 'inherit' && environmentPolicy !== 'restricted') {
    throw new Error('Unsupported Codex runtime environment policy');
  }
  if (
    environmentPolicy === 'restricted' &&
    request.includeCanopySecrets === true
  ) {
    throw new Error('Restricted Codex workers cannot inherit managed secrets');
  }
  const includeCanopySecrets =
    environmentPolicy !== 'restricted' &&
    request.includeCanopySecrets !== false;
  const environment = Object.fromEntries(
    Object.entries(
      environmentPolicy === 'restricted'
        ? restrictedEnvironment(request.environment ?? {})
        : (request.environment ?? {}),
    ).sort(([left], [right]) => left.localeCompare(right)),
  );
  const environmentDigest = codexProfileDigest(JSON.stringify(environment));
  const identity = {
    ...(environmentPolicy === 'restricted' ? { environmentPolicy } : {}),
    binaryVersion: request.binaryVersion ?? 'bundled',
    logicalWorkspaceEnvironmentId:
      request.logicalWorkspaceEnvironmentId ?? 'default',
    environmentDigest,
    secretVersionFingerprint: request.secretVersionFingerprint ?? 'none',
    mockProviderId: request.mockProviderId ?? 'none',
    experimentalSwitches: stableRecord(request.experimentalSwitches),
    configArgsDigest: createHash('sha256')
      // Command-line override ordering is semantic when the same config key
      // appears more than once; never collapse differently ordered profiles.
      .update(JSON.stringify(request.configArgs ?? []))
      .digest('hex'),
    includeCanopySecrets,
  };
  const id = createHash('sha256')
    .update(JSON.stringify(identity))
    .digest('hex');

  return {
    id,
    environmentPolicy,
    label: `Codex profile ${id.slice(0, 8)}`,
    environment,
    configArgs: [...(request.configArgs ?? [])],
    includeCanopySecrets,
  };
}
