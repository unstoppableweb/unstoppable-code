import { chmod, mkdir, readFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  EnvironmentConfigData,
  EnvironmentConfigView,
  LoadEnvironmentConfigSuccessResponse,
  PersistedEnvironmentConfigFile,
  PersistedEnvironmentDefinition,
  SaveEnvironmentConfigSuccessResponse,
  UserEnvironmentData,
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
  DEFAULT_USER_ENVIRONMENT,
  createDefaultEnvironmentConfig,
  normalizeEnvironmentConfig,
  normalizeUserEnvironmentEntries,
  validateEnvironmentConfigUpdate,
} from '@canopy/desktop-shared/lib/user-environment';
import type { SecureStorageFailure } from '@canopy/execution-engine/types/secure-storage';
import {
  getSecretStoragePolicy,
  getEnvironmentValueWritePolicy,
  getSecureStorageFailure,
  type EnvironmentValueWritePolicy,
} from './secure-storage-policy';
import { writeFileAtomically } from './atomic-file';
import { migrateSecureStorageFile } from './secure-storage-migration';
import {
  projectEnvironmentConfig,
  resolveEnvironmentConfigInput,
} from './environment-secret-view';

const USER_ENVIRONMENT_FILE_VERSION = 1;
const USER_ENVIRONMENT_DIR_MODE = 0o700;
const USER_ENVIRONMENT_FILE_MODE = 0o600;

interface LegacyEnvironmentRead {
  data: UserEnvironmentData;
  canPersistMigration: boolean;
  encryptedVariablesUnavailable: boolean;
}

let writeQueue: Promise<void> = Promise.resolve();

/** The submitted config breaks a rule the user can fix; not a defect. */
export class EnvironmentConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvironmentConfigValidationError';
  }
}

class EnvironmentStorageUnavailableError extends Error {
  readonly secureStorageFailure: SecureStorageFailure | undefined;

  constructor(error: unknown) {
    super(
      'OS encryption unavailable; cannot safely read encrypted environment variables.',
    );
    this.name = 'EnvironmentStorageUnavailableError';
    this.secureStorageFailure = getSecureStorageFailure(error) ?? undefined;
  }
}

async function chmodIfSupported(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch {
    // chmod may be unsupported or partially mapped on some packaged targets.
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUiMode(value: unknown): value is UserEnvironmentUiMode {
  return value === 'key-value' || value === 'bulk';
}

function getEncryptionAvailable(): boolean {
  return getEnvironmentValueWritePolicy().encryptionAvailable;
}

function tryDecryptEntries(encryptedBase64: string): {
  entries: UserEnvironmentEntry[];
  ok: boolean;
} {
  let json: string;
  try {
    json = getSecretStoragePolicy().decrypt(
      Buffer.from(encryptedBase64, 'base64'),
    );
  } catch (error) {
    throw new EnvironmentStorageUnavailableError(error);
  }
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return { entries: [], ok: false };
    return {
      entries: normalizeUserEnvironmentEntries(
        parsed.filter(isRecord).map((entry) => ({
          key: entry.key,
          value: entry.value,
          secret: entry.secret,
        })),
      ),
      ok: true,
    };
  } catch {
    return { entries: [], ok: false };
  }
}

function extractLegacyEntries(data: {
  encrypted?: unknown;
  plaintextVariables?: unknown;
  variables?: unknown;
}): {
  variables: UserEnvironmentEntry[];
  canPersistMigration: boolean;
  encryptedVariablesUnavailable: boolean;
} {
  if (typeof data.encrypted === 'string' && data.encrypted.length > 0) {
    const decrypted = tryDecryptEntries(data.encrypted);
    return {
      variables: decrypted.entries,
      canPersistMigration: decrypted.ok,
      encryptedVariablesUnavailable: !decrypted.ok,
    };
  }
  const fallback = Array.isArray(data.plaintextVariables)
    ? data.plaintextVariables
    : Array.isArray(data.variables)
      ? data.variables
      : [];
  return {
    variables: normalizeUserEnvironmentEntries(
      fallback.filter(isRecord).map((entry) => ({
        key: entry.key,
        value: entry.value,
        secret: entry.secret,
      })),
    ),
    canPersistMigration: true,
    encryptedVariablesUnavailable: false,
  };
}

function parseLegacyEnvironmentFile(value: unknown): LegacyEnvironmentRead {
  if (
    !isRecord(value) ||
    value.version !== USER_ENVIRONMENT_FILE_VERSION ||
    !isRecord(value.data)
  ) {
    return {
      data: { ...DEFAULT_USER_ENVIRONMENT, variables: [] },
      canPersistMigration: false,
      encryptedVariablesUnavailable: false,
    };
  }

  const legacyEntries = extractLegacyEntries(value.data);
  return {
    data: {
      uiMode: isUiMode(value.data.uiMode) ? value.data.uiMode : 'key-value',
      variables: legacyEntries.variables,
    },
    canPersistMigration: legacyEntries.canPersistMigration,
    encryptedVariablesUnavailable: legacyEntries.encryptedVariablesUnavailable,
  };
}

async function readLegacyUserEnvironmentFile(): Promise<LegacyEnvironmentRead | null> {
  let raw: string;
  try {
    raw = await readFile(getUserEnvironmentFilePath(), 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      data: { ...DEFAULT_USER_ENVIRONMENT, variables: [] },
      canPersistMigration: false,
      encryptedVariablesUnavailable: false,
    };
  }
  return parseLegacyEnvironmentFile(parsed);
}

async function readLegacyEnvironmentConfigFile(): Promise<EnvironmentConfigData | null> {
  let raw: string;
  try {
    raw = await readFile(getLegacyEnvironmentConfigFilePath(), 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPersistedEnvironmentConfigFile(parsed)) {
    return null;
  }
  return normalizePersistedFile(parsed, new Date().toISOString());
}

async function removeLegacyEnvironmentConfigFile(): Promise<void> {
  await unlink(getLegacyEnvironmentConfigFilePath()).catch(() => undefined);
}

function assertLegacyVariablesAvailable(
  legacy: LegacyEnvironmentRead | null,
): void {
  if (!legacy?.encryptedVariablesUnavailable) {
    return;
  }
  throw new Error(
    'OS encryption unavailable — cannot safely read encrypted legacy environment variables.',
  );
}

function configFromLegacy(
  legacy: LegacyEnvironmentRead | null,
  now: string,
): EnvironmentConfigData {
  const config = createDefaultEnvironmentConfig(now);
  if (!legacy) {
    return config;
  }

  return {
    ...config,
    environments: config.environments.map((environment) =>
      environment.id === DEFAULT_ENVIRONMENT_IDS.overall
        ? {
            ...environment,
            uiMode: legacy.data.uiMode,
            variables: legacy.data.variables,
            updatedAt: now,
          }
        : environment,
    ),
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

function normalizePersistedEnvironment(
  environment: PersistedEnvironmentDefinition,
): Record<string, unknown> {
  let variables: UserEnvironmentEntry[] = [];
  if (
    typeof environment.encryptedVariables === 'string' &&
    environment.encryptedVariables.length > 0
  ) {
    const decrypted = tryDecryptEntries(environment.encryptedVariables);
    if (!decrypted.ok) {
      throw new EnvironmentStorageUnavailableError(undefined);
    }
    variables = decrypted.entries;
  } else if (Array.isArray(environment.plaintextVariables)) {
    variables = normalizeUserEnvironmentEntries(
      environment.plaintextVariables.filter(isRecord).map((entry) => ({
        key: entry.key,
        value: entry.value,
        secret: entry.secret,
      })),
    );
  }

  return {
    ...environment,
    variables,
  };
}

function normalizePersistedFile(
  file: PersistedEnvironmentConfigFile,
  now: string,
): EnvironmentConfigData {
  return normalizeEnvironmentConfig(
    {
      ...file.data,
      environments: file.data.environments.map(normalizePersistedEnvironment),
    },
    now,
  );
}

function serializeEnvironment(
  environment: EnvironmentConfigData['environments'][number],
  writePolicy: EnvironmentValueWritePolicy,
): PersistedEnvironmentDefinition {
  const persisted: PersistedEnvironmentDefinition = {
    id: environment.id,
    name: environment.name,
    parentId: environment.parentId,
    isDefault: environment.isDefault,
    defaultKind: environment.defaultKind,
    uiMode: environment.uiMode,
    createdAt: environment.createdAt,
    updatedAt: environment.updatedAt,
  };
  const encoded = writePolicy.encode(JSON.stringify(environment.variables));
  if (encoded.kind === 'encrypted') {
    persisted.encryptedVariables = encoded.value.toString('base64');
  } else {
    persisted.plaintextVariables = environment.variables;
  }
  return persisted;
}

async function readEnvironmentConfigData(
  options: { persistLegacyMigration?: boolean } = {},
): Promise<EnvironmentConfigData> {
  const persistLegacyMigration = options.persistLegacyMigration ?? true;
  const now = new Date().toISOString();
  const filePath = getEnvironmentConfigFilePath();
  const migration = await migrateSecureStorageFile({
    currentPath: filePath,
    legacyPath: getInternalLegacySharedEnvironmentConfigFilePath(),
    decode: (raw) => {
      const parsed: unknown = JSON.parse(raw.toString('utf8'));
      if (!isPersistedEnvironmentConfigFile(parsed)) {
        throw new Error('Invalid persisted environment config');
      }
      return normalizePersistedFile(parsed, now);
    },
    encode: (data) =>
      JSON.stringify(buildPersistedEnvironmentFile(data), null, 2),
    storeKind: 'environments',
    isUnavailableError: (error) => getSecureStorageFailure(error) !== null,
    beforeWrite: async () => {
      const dirPath = dirname(filePath);
      await mkdir(dirPath, {
        recursive: true,
        mode: USER_ENVIRONMENT_DIR_MODE,
      });
      await chmodIfSupported(dirPath, USER_ENVIRONMENT_DIR_MODE);
    },
    writeOptions: { encoding: 'utf8', mode: USER_ENVIRONMENT_FILE_MODE },
  });
  if (
    migration.status === 'current' ||
    migration.status === 'migrated' ||
    migration.status === 'legacy-decoded-write-deferred'
  ) {
    return migration.value;
  }
  if (
    migration.status === 'current-error' ||
    migration.status === 'storage-error'
  ) {
    throw migration.error;
  }
  if (migration.status === 'unavailable') {
    throw new EnvironmentStorageUnavailableError(undefined);
  }
  if (migration.status === 'foreign-legacy-skipped') {
    return createDefaultEnvironmentConfig(now);
  }
  if (migration.status === 'absent') {
    const legacyConfig = await readLegacyEnvironmentConfigFile();
    if (legacyConfig) {
      if (persistLegacyMigration) {
        try {
          await persistEnvironmentConfig(legacyConfig);
          await removeLegacyEnvironmentConfigFile();
        } catch {
          // Leave environments.json absent so the next launch retries migration.
        }
      }
      return legacyConfig;
    }
    const legacy = await readLegacyUserEnvironmentFile();
    assertLegacyVariablesAvailable(legacy);
    const migrated = configFromLegacy(legacy, now);
    if (legacy?.canPersistMigration && persistLegacyMigration) {
      try {
        await persistEnvironmentConfig(migrated);
      } catch {
        // Leave environments.json absent so the next launch retries migration.
      }
    }
    return migrated;
  }
  return createDefaultEnvironmentConfig(now);
}

/** Plaintext for main's own consumers; never reply with it over IPC. */
export async function readEnvironmentConfig(): Promise<{
  data: EnvironmentConfigData;
  encryptionAvailable: boolean;
}> {
  return {
    data: await readEnvironmentConfigData(),
    encryptionAvailable: getEncryptionAvailable(),
  };
}

/** The reply form: values marked secret are stored-secret values. */
export async function readEnvironmentConfigView(): Promise<LoadEnvironmentConfigSuccessResponse> {
  const { data, encryptionAvailable } = await readEnvironmentConfig();
  return { data: projectEnvironmentConfig(data), encryptionAvailable };
}

/**
 * Saves a config whose kept stored secrets resolve against the config on
 * disk, inside the write queue, and replies with the saved view.
 */
export async function writeEnvironmentConfig(
  next: EnvironmentConfigView,
): Promise<SaveEnvironmentConfigSuccessResponse> {
  const writeOperation = writeQueue.then(
    async (): Promise<SaveEnvironmentConfigSuccessResponse> => {
      const current = await readEnvironmentConfigData({
        persistLegacyMigration: false,
      });
      const resolved = resolveEnvironmentConfigInput(next, current);
      const updateValidation = validateEnvironmentConfigUpdate(
        current,
        resolved,
      );
      if (!updateValidation.ok) {
        throw new EnvironmentConfigValidationError(updateValidation.message);
      }

      const normalized = normalizeEnvironmentConfig(
        resolved,
        new Date().toISOString(),
      );
      const saved = await persistEnvironmentConfigUnlocked(normalized);
      return {
        ok: true,
        data: projectEnvironmentConfig(saved.data),
        encryptionAvailable: saved.encryptionAvailable,
      };
    },
  );
  writeQueue = writeOperation.then(
    () => undefined,
    () => undefined,
  );
  return writeOperation;
}

interface PersistedEnvironmentConfig {
  data: EnvironmentConfigData;
  encryptionAvailable: boolean;
}

async function persistEnvironmentConfigUnlocked(
  normalized: EnvironmentConfigData,
): Promise<PersistedEnvironmentConfig> {
  const writePolicy = getEnvironmentValueWritePolicy();
  const encryptionAvailable = writePolicy.encryptionAvailable;
  const payload = buildPersistedEnvironmentFile(normalized, writePolicy);

  const filePath = getEnvironmentConfigFilePath();
  const dirPath = dirname(filePath);
  await mkdir(dirPath, { recursive: true, mode: USER_ENVIRONMENT_DIR_MODE });
  await chmodIfSupported(dirPath, USER_ENVIRONMENT_DIR_MODE);
  await writeFileAtomically(filePath, JSON.stringify(payload, null, 2), {
    encoding: 'utf8',
    mode: USER_ENVIRONMENT_FILE_MODE,
  });
  await chmodIfSupported(filePath, USER_ENVIRONMENT_FILE_MODE);

  return { data: normalized, encryptionAvailable };
}

function buildPersistedEnvironmentFile(
  normalized: EnvironmentConfigData,
  writePolicy: EnvironmentValueWritePolicy = getEnvironmentValueWritePolicy(),
): PersistedEnvironmentConfigFile {
  return {
    version: 2,
    data: {
      environments: normalized.environments.map((environment) =>
        serializeEnvironment(environment, writePolicy),
      ),
      globalRuntimes: normalized.globalRuntimes,
      workspaceAssignments: normalized.workspaceAssignments,
    },
  };
}

async function persistEnvironmentConfig(
  normalized: EnvironmentConfigData,
): Promise<PersistedEnvironmentConfig> {
  const writeOperation = writeQueue.then(() =>
    persistEnvironmentConfigUnlocked(normalized),
  );
  writeQueue = writeOperation.then(
    () => undefined,
    () => undefined,
  );
  return writeOperation;
}
