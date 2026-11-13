import { normalizeModelGatewayBaseUrl } from '@canopy/protocol/canopy-server';
import type { SecureStorageFailure } from '@canopy/execution-engine/types/secure-storage';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeFileAtomically } from './atomic-file';
import { readCanopyCloudAccountWithStatus } from './canopy-cloud-account-store';
import {
  getInternalLegacySharedModelGatewayCredentialStorePath,
  getLegacyModelGatewayCredentialStorePath,
  getModelGatewayCredentialStorePath,
} from './paths';
import {
  getSecretStoragePolicy,
  getSecureStorageFailure,
  type SecretStoragePolicy,
} from './secure-storage-policy';
import { migrateSecureStorageFile } from './secure-storage-migration';
import { accountUsesDeviceModelGateway } from '@canopy/desktop-shared/lib/org-model-gateway';
import {
  clearLocalModelGatewayCredentials,
  isLocalModelGatewayOrganizationId,
  LOCAL_MODEL_GATEWAY_ACCOUNT_ID,
  loadLocalModelGatewayCredential,
  markLocalModelGatewayCredentialRejected,
  readLocalModelGatewayCredentialCiphertext,
  saveLocalModelGatewayCredential,
} from './local-model-gateway-store';

interface StoredGatewayCredentialRecord {
  accountId: string;
  organizationId: string;
  encryptedApiKeyBase64: string;
  baseUrlAtSave: string;
  updatedAt: string;
  lastValidatedAt?: string;
  /** A successful validation, independent of routing rejection state. */
  validated?: boolean;
  lastError?: string;
}

interface StoredGatewayCredentialFile {
  /** Read-only projection; preserve these bytes before an authorized replacement. */
  ownerlessLegacy?: Buffer;
  version: 2;
  records: Record<string, StoredGatewayCredentialRecord>;
}

export interface ModelGatewayCredentialRecord {
  organizationId: string;
  apiKey: string;
  baseUrlAtSave: string;
  updatedAt: string;
  lastValidatedAt?: string;
  /** A successful validation, independent of routing rejection state. */
  validated?: boolean;
  lastError?: string;
}

export class GatewayCredentialStorageUnavailableError extends Error {
  constructor(readonly secureStorageFailure?: SecureStorageFailure) {
    super('Secure storage unavailable');
    this.name = 'GatewayCredentialStorageUnavailableError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function availableStorage(): SecretStoragePolicy {
  const policy = getSecretStoragePolicy();
  const run = <T>(operation: () => T): T => {
    try {
      return operation();
    } catch (error) {
      const failure = getSecureStorageFailure(error);
      if (failure) throw new GatewayCredentialStorageUnavailableError(failure);
      throw error;
    }
  };
  return {
    ...policy,
    assertCanWrite: () => run(() => policy.assertCanWrite()),
    encrypt: (text) => run(() => policy.encrypt(text)),
    decrypt: (ciphertext) => run(() => policy.decrypt(ciphertext)),
  };
}

function isStoredRecord(
  value: unknown,
): value is StoredGatewayCredentialRecord {
  return (
    isRecord(value) &&
    typeof value.accountId === 'string' &&
    typeof value.organizationId === 'string' &&
    typeof value.encryptedApiKeyBase64 === 'string' &&
    typeof value.baseUrlAtSave === 'string' &&
    typeof value.updatedAt === 'string' &&
    (value.lastValidatedAt === undefined ||
      typeof value.lastValidatedAt === 'string') &&
    (value.validated === undefined || typeof value.validated === 'boolean') &&
    (value.lastError === undefined || typeof value.lastError === 'string')
  );
}

function parseFile(raw: Buffer): StoredGatewayCredentialFile {
  const parsed: unknown = JSON.parse(raw.toString('utf8'));
  // Ownerless data stays isolated. Retain the complete original bytes so an
  // explicit authorized mutation can back it up before starting a v2 store.
  if (isRecord(parsed) && parsed.version === 1) {
    return { version: 2, records: {}, ownerlessLegacy: raw };
  }
  if (!isRecord(parsed) || parsed.version !== 2 || !isRecord(parsed.records)) {
    throw new Error('Invalid model gateway credential store');
  }
  const records: Record<string, StoredGatewayCredentialRecord> = {};
  for (const [key, value] of Object.entries(parsed.records)) {
    if (!isStoredRecord(value)) {
      throw new Error('Invalid model gateway credential record');
    }
    records[key] = value;
  }
  return { version: 2, records };
}

function decrypt(
  storage: SecretStoragePolicy,
  record: StoredGatewayCredentialRecord,
): ModelGatewayCredentialRecord {
  return {
    organizationId: record.organizationId,
    apiKey: storage.decrypt(
      Buffer.from(record.encryptedApiKeyBase64, 'base64'),
    ),
    baseUrlAtSave: record.baseUrlAtSave,
    updatedAt: record.updatedAt,
    lastValidatedAt: record.lastValidatedAt,
    validated: record.validated,
    lastError: record.lastError,
  };
}

function validateFile(
  storage: SecretStoragePolicy,
  file: StoredGatewayCredentialFile,
): StoredGatewayCredentialFile {
  Object.values(file.records).forEach((record) => decrypt(storage, record));
  return file;
}

function reencryptFile(
  storage: SecretStoragePolicy,
  file: StoredGatewayCredentialFile,
): string {
  if (file.ownerlessLegacy)
    throw new Error('Ownerless model gateway credential store');
  const records = Object.fromEntries(
    Object.entries(file.records).map(([key, record]) => {
      const clear = decrypt(storage, record);
      return [
        key,
        {
          ...record,
          encryptedApiKeyBase64: storage
            .encrypt(clear.apiKey)
            .toString('base64'),
        },
      ];
    }),
  );
  return JSON.stringify({ version: 2, records }, null, 2);
}

async function readStore(): Promise<StoredGatewayCredentialFile> {
  const storage = availableStorage();
  const currentPath = getModelGatewayCredentialStorePath();
  const migration = await migrateSecureStorageFile<StoredGatewayCredentialFile>(
    {
      currentPath,
      legacyPath: getInternalLegacySharedModelGatewayCredentialStorePath(),
      decode: parseFile,
      decodeLegacy: (raw) => validateFile(storage, parseFile(raw)),
      encode: (file) => reencryptFile(storage, file),
      storeKind: 'model-gateway',
      beforeWrite: async () => {
        await mkdir(dirname(currentPath), { recursive: true });
        storage.assertCanWrite();
      },
      writeOptions: { encoding: 'utf8', mode: 0o600 },
    },
  );
  if (
    migration.status === 'current' ||
    migration.status === 'migrated' ||
    migration.status === 'legacy-decoded-write-deferred'
  ) {
    return migration.value;
  }
  if (migration.status === 'unavailable') storage.assertCanRead();
  if (
    migration.status === 'current-error' ||
    migration.status === 'storage-error'
  ) {
    throw migration.error;
  }
  if (
    migration.status === 'foreign-legacy-skipped' &&
    migration.secureStorageFailure
  )
    return { version: 2, records: {} };
  if (migration.status !== 'absent')
    throw new Error('Model gateway credential store unavailable');
  try {
    return parseFile(
      await readFile(getLegacyModelGatewayCredentialStorePath()),
    );
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT')
      return { version: 2, records: {} };
    throw error;
  }
}

async function writeStore(
  file: StoredGatewayCredentialFile,
  requiresWrite = false,
): Promise<void> {
  const path = getModelGatewayCredentialStorePath();
  await mkdir(dirname(path), { recursive: true });
  if (requiresWrite) availableStorage().assertCanWrite();
  await writeFileAtomically(path, JSON.stringify(file, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rm(getLegacyModelGatewayCredentialStorePath(), { force: true }).catch(
    () => undefined,
  );
}

let mutationQueue: Promise<void> = Promise.resolve();

function credentialKey(accountId: string, organizationId: string): string {
  return JSON.stringify([accountId, organizationId]);
}

async function resolveCredentialOwner(
  organizationId: string,
  baseUrl?: string,
): Promise<{ accountId: string; key: string } | null> {
  const read = await readCanopyCloudAccountWithStatus();
  if (read.status !== 'ok') {
    const failure =
      read.status === 'unavailable'
        ? read.secureStorageFailure
        : getSecureStorageFailure(read.error);
    if (failure) throw new GatewayCredentialStorageUnavailableError(failure);
    throw read.error;
  }
  const account = read.entry;
  const accountId = account?.account?.id.trim();
  const setupOrganization = account?.organizations?.find(
    (org) => org.id === organizationId,
  );
  const setupAuthorized =
    account?.personalOrganizationId === organizationId ||
    setupOrganization?.role === 'OWNER' ||
    setupOrganization?.role === 'ADMIN';
  const organizationIsCurrent =
    setupAuthorized ||
    account?.enforcedSettings?.some(
      (org) =>
        org.organizationId === organizationId &&
        org.policies.some(
          (policy) =>
            policy.kind === 'model-gateway' &&
            (baseUrl === undefined ||
              normalizeModelGatewayBaseUrl(policy.baseUrl) ===
                normalizeModelGatewayBaseUrl(baseUrl)),
        ),
    );
  return accountId && organizationIsCurrent
    ? { accountId, key: credentialKey(accountId, organizationId) }
    : null;
}

/**
 * Device gateway keys live in the device store. They are readable and
 * writable only while the account names no Personal organization, the same
 * rule that routes the device gateway; `refused` covers a signed-in account.
 */
async function deviceGatewayTarget(
  organizationId: string,
): Promise<'account' | 'device' | 'refused'> {
  let isDeviceGateway: boolean;
  try {
    isDeviceGateway = await isLocalModelGatewayOrganizationId(organizationId);
  } catch (error) {
    // An unreadable device store only matters while the device gateway is in
    // play; an account with a Personal organization keeps its hosted keys,
    // and the account owner check refuses an id it does not know.
    const read = await readCanopyCloudAccountWithStatus();
    if (read.status === 'ok' && !accountUsesDeviceModelGateway(read.entry))
      return 'account';
    throw new GatewayCredentialStorageUnavailableError(
      getSecureStorageFailure(error) ?? undefined,
    );
  }
  if (!isDeviceGateway) return 'account';
  const read = await readCanopyCloudAccountWithStatus();
  if (read.status !== 'ok') {
    const failure =
      read.status === 'unavailable'
        ? read.secureStorageFailure
        : getSecureStorageFailure(read.error);
    if (failure) throw new GatewayCredentialStorageUnavailableError(failure);
    return 'refused';
  }
  return accountUsesDeviceModelGateway(read.entry) ? 'device' : 'refused';
}

async function withDeviceStorage<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const failure = getSecureStorageFailure(error);
    if (failure) throw new GatewayCredentialStorageUnavailableError(failure);
    throw error;
  }
}

/**
 * Run `mutation` on the store and write it back. A mutation that returns
 * `'unchanged'` changed nothing, so the store is left as it is.
 */
function queueMutation(
  mutation: (
    file: StoredGatewayCredentialFile,
  ) => void | 'unchanged' | Promise<void | 'unchanged'>,
  options: { requiresWrite?: boolean; replaceOwnerlessLegacy?: boolean } = {},
): Promise<void> {
  const { requiresWrite = false, replaceOwnerlessLegacy = false } = options;
  const next = mutationQueue.then(async () => {
    let file = await readStore();
    let replacedLegacy = false;
    if (file.ownerlessLegacy) {
      // Runtime rejection metadata cannot authorize recovery of ownerless data.
      if (!replaceOwnerlessLegacy) return;
      const path = getModelGatewayCredentialStorePath();
      await mkdir(dirname(path), { recursive: true });
      if (requiresWrite) availableStorage().assertCanWrite();
      // Publish a complete, private recovery copy before replacing any source.
      // A unique, exclusive destination never overwrites an earlier backup;
      // durability failures propagate and all backups remain for recovery.
      await writeFileAtomically(
        `${path}.v1-backup-${randomUUID()}`,
        file.ownerlessLegacy,
        { mode: 0o600, overwrite: false, durable: true },
      );
      file = { version: 2, records: {} };
      replacedLegacy = true;
    }
    const outcome = await mutation(file);
    if (outcome === 'unchanged' && !replacedLegacy) return;
    await writeStore(file, requiresWrite);
  });
  mutationQueue = next.catch(() => undefined);
  return next;
}

export async function loadModelGatewayCredential(
  organizationId: string,
  expectedBaseUrl?: string,
): Promise<ModelGatewayCredentialRecord | null> {
  const target = await deviceGatewayTarget(organizationId);
  if (target === 'refused') return null;
  if (target === 'device')
    return withDeviceStorage(() =>
      loadLocalModelGatewayCredential(expectedBaseUrl),
    );
  const storage = availableStorage();
  const owner = await resolveCredentialOwner(organizationId, expectedBaseUrl);
  if (!owner) return null;
  const account = await readCanopyCloudAccountWithStatus();
  const entry = account.status === 'ok' ? account.entry : null;
  const configuredBaseUrl =
    entry?.personalOrganizationId === organizationId
      ? entry.personalModelGateway?.baseUrl
      : entry?.enforcedSettings
          ?.find((org) => org.organizationId === organizationId)
          ?.policies.find((policy) => policy.kind === 'model-gateway')?.baseUrl;
  const endpoint = normalizeModelGatewayBaseUrl(
    expectedBaseUrl ?? configuredBaseUrl,
  );
  const records = (await readStore()).records;
  const staged = endpoint
    ? records[JSON.stringify([owner.accountId, organizationId, endpoint])]
    : undefined;
  const active = records[owner.key];
  const activeMatches =
    endpoint !== null &&
    normalizeModelGatewayBaseUrl(active?.baseUrlAtSave) === endpoint;
  // A legacy client can repair the active slot after this client staged a key.
  // Prefer the newest matching record rather than permanently shadowing it.
  const stored =
    staged &&
    (!activeMatches ||
      Date.parse(staged.updatedAt) > Date.parse(active.updatedAt))
      ? staged
      : active;
  if (
    endpoint &&
    normalizeModelGatewayBaseUrl(stored?.baseUrlAtSave) !== endpoint
  )
    return null;
  if (!stored) return null;
  const currentOwner = await resolveCredentialOwner(
    organizationId,
    expectedBaseUrl,
  );
  if (currentOwner?.accountId !== owner.accountId) return null;
  return decrypt(storage, stored);
}

/**
 * Whether this account has a non-empty key for the organization, saved for any
 * endpoint. A key for an older endpoint still means the gateway is set up here
 * and only needs its key saved again.
 */
export async function hasModelGatewayCredential(
  organizationId: string,
): Promise<boolean> {
  const target = await deviceGatewayTarget(organizationId);
  if (target === 'refused') return false;
  if (target === 'device') {
    const credential = await withDeviceStorage(() =>
      loadLocalModelGatewayCredential(),
    );
    return credential !== null && credential.apiKey.trim() !== '';
  }
  const storage = availableStorage();
  const owner = await resolveCredentialOwner(organizationId);
  const stored = owner ? (await readStore()).records[owner.key] : undefined;
  return stored !== undefined && decrypt(storage, stored).apiKey.trim() !== '';
}

export async function saveModelGatewayCredential(input: {
  organizationId: string;
  apiKey: string;
  baseUrlAtSave: string;
  lastValidatedAt?: string;
  /** A successful validation, independent of routing rejection state. */
  validated?: boolean;
  lastError?: string;
  expectedAccountId?: string;
  signal?: AbortSignal;
}): Promise<void> {
  input.signal?.throwIfAborted();
  const target = await deviceGatewayTarget(input.organizationId);
  if (target !== 'account') {
    if (
      target === 'refused' ||
      (input.expectedAccountId !== undefined &&
        input.expectedAccountId !== LOCAL_MODEL_GATEWAY_ACCOUNT_ID)
    )
      throw new Error(
        'Cannot save a model gateway credential outside the current account policy.',
      );
    await withDeviceStorage(() => saveLocalModelGatewayCredential(input));
    return;
  }
  const storage = availableStorage();
  const apiKey = input.apiKey.trim();
  if (apiKey) storage.assertCanWrite();
  const owner = await resolveCredentialOwner(
    input.organizationId,
    input.baseUrlAtSave,
  );
  if (
    !owner ||
    (input.expectedAccountId !== undefined &&
      owner.accountId !== input.expectedAccountId)
  ) {
    throw new Error(
      'Cannot save a model gateway credential outside the current account policy.',
    );
  }
  await queueMutation(
    async (file) => {
      const current = await resolveCredentialOwner(
        input.organizationId,
        input.baseUrlAtSave,
      );
      if (!current || current.accountId !== owner.accountId)
        throw new Error('Gateway account or authorization changed');
      input.signal?.throwIfAborted();
      const baseUrl = normalizeModelGatewayBaseUrl(input.baseUrlAtSave);
      if (apiKey && !baseUrl) throw new Error('Invalid gateway endpoint');
      const endpointKey = JSON.stringify([
        owner.accountId,
        input.organizationId,
        baseUrl,
      ]);
      const existing = file.records[owner.key];
      // Keep the active endpoint intact until the matching hosted config saves.
      const key =
        existing &&
        normalizeModelGatewayBaseUrl(existing.baseUrlAtSave) !== baseUrl
          ? endpointKey
          : owner.key;
      if (!apiKey) {
        Object.entries(file.records).forEach(([key, record]) => {
          if (
            record.accountId === owner.accountId &&
            record.organizationId === input.organizationId
          )
            delete file.records[key];
        });
        return;
      }
      input.signal?.throwIfAborted();
      const previousTimes = Object.values(file.records)
        .filter(
          (record) =>
            record.accountId === owner.accountId &&
            record.organizationId === input.organizationId,
        )
        .map((record) => Date.parse(record.updatedAt))
        .filter(Number.isFinite);
      const updatedAt = new Date(
        Math.max(Date.now(), ...previousTimes.map((time) => time + 1)),
      ).toISOString();
      if (key === owner.key) delete file.records[endpointKey];
      file.records[key] = {
        accountId: owner.accountId,
        organizationId: input.organizationId,
        encryptedApiKeyBase64: storage.encrypt(apiKey).toString('base64'),
        baseUrlAtSave: baseUrl ?? input.baseUrlAtSave,
        updatedAt,
        lastValidatedAt: input.lastValidatedAt,
        validated: input.validated,
        lastError: input.lastError,
      };
    },
    { requiresWrite: Boolean(apiKey), replaceOwnerlessLegacy: true },
  );
}

/**
 * Delete every stored key (active and staged) for an organization after its
 * gateway was removed. The owner resolves without an endpoint, because the
 * removed gateway no longer has one. Returns `unauthorized`, deleting nothing,
 * when the current account is not `expectedAccountId` or is not authorized for
 * the org, and `nothing-to-clear` when this device stored no key for it.
 */
export async function clearModelGatewayCredential(
  organizationId: string,
  expectedAccountId?: string,
): Promise<'cleared' | 'nothing-to-clear' | 'unauthorized'> {
  const target = await deviceGatewayTarget(organizationId);
  if (target !== 'account') {
    if (
      target === 'refused' ||
      (expectedAccountId !== undefined &&
        expectedAccountId !== LOCAL_MODEL_GATEWAY_ACCOUNT_ID)
    )
      return 'unauthorized';
    return (await withDeviceStorage(clearLocalModelGatewayCredentials))
      ? 'cleared'
      : 'nothing-to-clear';
  }
  const owner = await resolveCredentialOwner(organizationId);
  if (
    !owner ||
    (expectedAccountId !== undefined && owner.accountId !== expectedAccountId)
  )
    return 'unauthorized';
  // An ownerless legacy store holds no record this account could own, so the
  // skipped mutation still leaves nothing of this owner's behind.
  let deleted = false;
  await queueMutation((file) => {
    Object.entries(file.records).forEach(([key, record]) => {
      if (
        record.accountId === owner.accountId &&
        record.organizationId === organizationId
      ) {
        delete file.records[key];
        deleted = true;
      }
    });
    return deleted ? undefined : 'unchanged';
  });
  return deleted ? 'cleared' : 'nothing-to-clear';
}

/** Persist a gateway-issued runtime rejection without exposing or replacing the key. */
export async function markModelGatewayCredentialRejected(
  organizationId: string,
  lastError: string,
  expectedUpdatedAt?: string,
  expectedAccountId?: string,
): Promise<boolean> {
  const target = await deviceGatewayTarget(organizationId);
  if (target !== 'account') {
    if (
      target === 'refused' ||
      (expectedAccountId !== undefined &&
        expectedAccountId !== LOCAL_MODEL_GATEWAY_ACCOUNT_ID)
    )
      return false;
    return withDeviceStorage(() =>
      markLocalModelGatewayCredentialRejected(lastError, expectedUpdatedAt),
    );
  }
  const owner = await resolveCredentialOwner(organizationId);
  if (
    !owner ||
    (expectedAccountId !== undefined && owner.accountId !== expectedAccountId)
  )
    return false;
  let updated = false;
  await queueMutation((file) => {
    const record = expectedUpdatedAt
      ? Object.values(file.records).find(
          (record) =>
            record.accountId === owner.accountId &&
            record.organizationId === organizationId &&
            record.updatedAt === expectedUpdatedAt,
        )
      : file.records[owner.key];
    if (!record) return;
    if (expectedUpdatedAt && record.updatedAt !== expectedUpdatedAt) return;
    record.lastError = lastError;
    record.validated = false;
    record.lastValidatedAt = new Date().toISOString();
    updated = true;
  });
  return updated;
}

export function isModelGatewayCredentialStorageAvailable(): boolean {
  return getSecretStoragePolicy().isWriteAvailable();
}

export function resetModelGatewayCredentialStoreForTests(): void {
  mutationQueue = Promise.resolve();
}

/** Checks cached authorization before any local discovery or secure mutation. */
export async function authorizeModelGatewayCredential(
  organizationId: string,
  baseUrl: string,
): Promise<{ accountId: string }> {
  const target = await deviceGatewayTarget(organizationId);
  if (target === 'device') return { accountId: LOCAL_MODEL_GATEWAY_ACCOUNT_ID };
  const owner =
    target === 'account'
      ? await resolveCredentialOwner(organizationId, baseUrl)
      : null;
  if (!owner) throw new Error('AI gateway authorization is unavailable');
  return { accountId: owner.accountId };
}

/**
 * Move the device gateway's key for `baseUrl` into the signed-in account's
 * slot for its Personal organization, re-keying the ciphertext without
 * decrypting it. Never replaces a key the account already holds for that
 * endpoint.
 */
export async function adoptLocalModelGatewayCredential(input: {
  accountId: string;
  organizationId: string;
  baseUrl: string;
}): Promise<'adopted' | 'exists' | 'no-key' | 'unauthorized'> {
  const baseUrl = normalizeModelGatewayBaseUrl(input.baseUrl);
  if (!baseUrl) return 'no-key';
  const local = await readLocalModelGatewayCredentialCiphertext(baseUrl);
  if (!local) return 'no-key';
  const owner = await resolveCredentialOwner(input.organizationId, baseUrl);
  if (!owner || owner.accountId !== input.accountId) return 'unauthorized';
  let outcome: 'adopted' | 'exists' = 'exists';
  await queueMutation(
    async (file) => {
      const current = await resolveCredentialOwner(
        input.organizationId,
        baseUrl,
      );
      if (current?.accountId !== owner.accountId)
        throw new Error('Gateway account or authorization changed');
      const held = Object.values(file.records).some(
        (record) =>
          record.accountId === owner.accountId &&
          record.organizationId === input.organizationId &&
          normalizeModelGatewayBaseUrl(record.baseUrlAtSave) === baseUrl,
      );
      if (held) return 'unchanged';
      const existing = file.records[owner.key];
      const key = existing
        ? JSON.stringify([owner.accountId, input.organizationId, baseUrl])
        : owner.key;
      file.records[key] = {
        accountId: owner.accountId,
        organizationId: input.organizationId,
        encryptedApiKeyBase64: local.encryptedApiKeyBase64,
        baseUrlAtSave: baseUrl,
        updatedAt: new Date().toISOString(),
        ...(local.lastValidatedAt
          ? { lastValidatedAt: local.lastValidatedAt }
          : {}),
        ...(local.validated === undefined
          ? {}
          : { validated: local.validated }),
        ...(local.lastError ? { lastError: local.lastError } : {}),
      };
      outcome = 'adopted';
    },
    { requiresWrite: true, replaceOwnerlessLegacy: true },
  );
  return outcome;
}
