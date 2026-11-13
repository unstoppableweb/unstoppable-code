import { codexProfileDigest } from '@canopy/execution-engine/node/codex-runtime/profile-digest-key';
import { readFileSync, statSync } from 'node:fs';
import type {
  EnvironmentConfigData,
  PersistedEnvironmentConfigFile,
  PersistedEnvironmentDefinition,
  ResolveEnvironmentRequest,
  UserEnvironmentEntry,
  UserEnvironmentUiMode,
} from '@canopy/desktop-shared/types';
import {
  getEnvironmentConfigFilePath,
  getInternalLegacySharedEnvironmentConfigFilePath,
  getLegacyEnvironmentConfigFilePath,
  getUserEnvironmentFilePath,
} from '@canopy/execution-engine/canopy-paths';
import {
  DEFAULT_ENVIRONMENT_IDS,
  createDefaultEnvironmentConfig,
  normalizeEnvironmentConfig,
  normalizeUserEnvironmentEntries,
  resolveEnvironmentForRuntime,
} from '@canopy/desktop-shared/lib/user-environment';
import { registerUserEnvironmentInjector } from '../pipelines/config-paths';
import { isMissingFileError } from './fs-utils';
import { getSecretStoragePolicy } from './secure-storage-policy';
import { readEnvironmentConfig } from './user-environment-store';

let cachedConfig: EnvironmentConfigData | null = null;
let cachedFileMtimeMs: number | null = null;
let cachedBackend: string | null = null;
let cachedRequiresDecryption = false;

interface ConfigRead {
  config: EnvironmentConfigData;
  requiresDecryption: boolean;
}
interface ReadContext {
  requiresDecryption: boolean;
}
let nextFileMtimeCheckAt = 0;
// Settings writes invalidate explicitly. Throttle the fallback stat for
// out-of-band edits so a burst of process launches does not perform sync I/O
// on Electron main for every child.
const FILE_MTIME_RECHECK_INTERVAL_MS = 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUiMode(value: unknown): value is UserEnvironmentUiMode {
  return value === 'key-value' || value === 'bulk';
}

function decryptEntries(encryptedBase64: string): UserEnvironmentEntry[] {
  const decrypted = getSecretStoragePolicy({ forSpawn: true }).decrypt(
    Buffer.from(encryptedBase64, 'base64'),
  );
  const parsed: unknown = JSON.parse(decrypted);
  if (!Array.isArray(parsed))
    throw new Error('Invalid encrypted environment variables');
  return normalizeUserEnvironmentEntries(
    parsed.filter(isRecord).map((entry) => ({
      key: entry.key,
      value: entry.value,
      secret: entry.secret,
    })),
  );
}

function extractEntries(
  data: {
    encrypted?: unknown;
    encryptedVariables?: unknown;
    plaintextVariables?: unknown;
    variables?: unknown;
  },
  context: ReadContext,
): UserEnvironmentEntry[] {
  if (typeof data.encrypted === 'string' && data.encrypted.length > 0) {
    context.requiresDecryption = true;
    return decryptEntries(data.encrypted);
  }
  if (
    typeof data.encryptedVariables === 'string' &&
    data.encryptedVariables.length > 0
  ) {
    context.requiresDecryption = true;
    return decryptEntries(data.encryptedVariables);
  }
  const fallback = Array.isArray(data.plaintextVariables)
    ? data.plaintextVariables
    : Array.isArray(data.variables)
      ? data.variables
      : [];
  return normalizeUserEnvironmentEntries(
    fallback.filter(isRecord).map((entry) => ({
      key: entry.key,
      value: entry.value,
      secret: entry.secret,
    })),
  );
}

function normalizePersistedEnvironment(
  environment: PersistedEnvironmentDefinition,
  context: ReadContext,
): PersistedEnvironmentDefinition & { variables: UserEnvironmentEntry[] } {
  return {
    ...environment,
    variables: extractEntries(environment, context),
  };
}

function isPersistedEnvironmentConfigFile(
  value: unknown,
): value is PersistedEnvironmentConfigFile {
  return (
    isRecord(value) &&
    value.version === 2 &&
    isRecord(value.data) &&
    Array.isArray(value.data.environments)
  );
}

function readLegacyConfigSync(
  now: string,
  context: ReadContext,
): EnvironmentConfigData {
  const config = createDefaultEnvironmentConfig(now);
  let raw: string;
  try {
    raw = readFileSync(getUserEnvironmentFilePath(), 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) return config;
    throw error;
  }

  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.data)) {
    return config;
  }
  const data = parsed.data;
  const uiMode = isUiMode(data.uiMode) ? data.uiMode : 'key-value';
  const variables = extractEntries(data, context);
  return {
    ...config,
    environments: config.environments.map((environment) =>
      environment.id === DEFAULT_ENVIRONMENT_IDS.overall
        ? { ...environment, uiMode, variables, updatedAt: now }
        : environment,
    ),
  };
}

function configFilePaths(): string[] {
  const internalLegacyPath = getInternalLegacySharedEnvironmentConfigFilePath();
  return [
    getEnvironmentConfigFilePath(),
    ...(internalLegacyPath ? [internalLegacyPath] : []),
    getLegacyEnvironmentConfigFilePath(),
  ];
}

function readConfigSync(): ConfigRead {
  const context: ReadContext = { requiresDecryption: false };
  const now = new Date().toISOString();
  let raw: string | null = null;
  // Mirror async migration's source ordering, including a readable source
  // whose optional re-encryption was deferred by the write policy.
  for (const path of configFilePaths()) {
    try {
      raw = readFileSync(path, 'utf8');
      break;
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
  }
  if (raw === null) {
    const config = readLegacyConfigSync(now, context);
    return { config, requiresDecryption: context.requiresDecryption };
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isPersistedEnvironmentConfigFile(parsed)) {
    throw new Error('Invalid persisted environment config');
  }
  const config = normalizeEnvironmentConfig(
    {
      ...parsed.data,
      environments: parsed.data.environments.map((environment) =>
        normalizePersistedEnvironment(environment, context),
      ),
    },
    now,
  );
  return { config, requiresDecryption: context.requiresDecryption };
}

function currentMtime(): number | null {
  for (const path of [...configFilePaths(), getUserEnvironmentFilePath()]) {
    try {
      return statSync(path).mtimeMs;
    } catch (error) {
      if (!isMissingFileError(error)) return null;
    }
  }
  return null;
}

function getEnvironmentConfigForInjection(): EnvironmentConfigData {
  try {
    const policy = getSecretStoragePolicy({ forSpawn: true });
    if (cachedConfig !== null && cachedRequiresDecryption) {
      policy.assertCanRead();
      if (policy.getStatus().backend !== cachedBackend) {
        invalidateUserEnvironmentInjectionCache();
      }
    }
    const now = Date.now();
    if (cachedConfig === null || now >= nextFileMtimeCheckAt) {
      const mtime = currentMtime();
      if (cachedConfig === null || mtime !== cachedFileMtimeMs) {
        const result = readConfigSync();
        cachedConfig = result.config;
        cachedRequiresDecryption = result.requiresDecryption;
        cachedBackend = result.requiresDecryption
          ? policy.getStatus().backend
          : null;
        cachedFileMtimeMs = mtime;
      }
      nextFileMtimeCheckAt = now + FILE_MTIME_RECHECK_INTERVAL_MS;
    }
    return (
      cachedConfig ?? createDefaultEnvironmentConfig(new Date().toISOString())
    );
  } catch {
    // Never install a failure as authoritative empty data or mtime.
    invalidateUserEnvironmentInjectionCache();
    return createDefaultEnvironmentConfig(new Date().toISOString());
  }
}

function getUserEnvironmentForInjection(
  context?: ResolveEnvironmentRequest,
): Record<string, string> {
  const config = getEnvironmentConfigForInjection();
  const request = context ?? { runtime: 'canopy' };
  const resolved = resolveEnvironmentForRuntime(config, request);
  return request.values === 'public'
    ? resolved.publicApplied
    : resolved.applied;
}

export interface CodexRuntimeEnvironmentProfile {
  environment: Record<string, string>;
  logicalWorkspaceEnvironmentId: string;
  secretVersionFingerprint?: string;
}

/**
 * Resolve the user-selected environment that must be fixed for the lifetime of
 * a Codex app-server worker. Capabilities remain thread-scoped, but shell
 * environment values are inherited by the app-server process and therefore
 * form part of its immutable spawn profile.
 */
export function resolveCodexRuntimeEnvironmentProfile(
  request: ResolveEnvironmentRequest,
): CodexRuntimeEnvironmentProfile {
  const resolved = resolveEnvironmentForRuntime(
    getEnvironmentConfigForInjection(),
    request,
  );
  const secretEntries = Object.entries(resolved.secretApplied).sort(
    ([left], [right]) => left.localeCompare(right),
  );

  return {
    environment: resolved.applied,
    logicalWorkspaceEnvironmentId: `${request.runtime}:${resolved.environmentId ?? 'default'}`,
    ...(secretEntries.length > 0
      ? {
          secretVersionFingerprint: codexProfileDigest(
            JSON.stringify(secretEntries),
          ),
        }
      : {}),
  };
}

export function invalidateUserEnvironmentInjectionCache(): void {
  cachedConfig = null;
  cachedFileMtimeMs = null;
  cachedBackend = null;
  cachedRequiresDecryption = false;
  nextFileMtimeCheckAt = 0;
}

let initialized = false;

export function initializeUserEnvironmentRuntime(): void {
  if (initialized) return;
  initialized = true;
  registerUserEnvironmentInjector(getUserEnvironmentForInjection);
  void readEnvironmentConfig()
    .then(() => {
      invalidateUserEnvironmentInjectionCache();
      getEnvironmentConfigForInjection();
    })
    .catch(() => {
      invalidateUserEnvironmentInjectionCache();
    });
}
