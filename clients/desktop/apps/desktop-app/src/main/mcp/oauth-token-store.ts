import type { SecureStorageFailure } from '@canopy/execution-engine/types/secure-storage';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  McpServerConfigData,
  McpServerDefinitionData,
} from '@canopy/execution-engine/types/mcp-servers';
import type { McpServerAuthStatus } from '@canopy/execution-engine/types/mcp-servers';
import {
  isTokenEndpointAuthMethod,
  type TokenEndpointAuthMethod,
} from '@canopy/mcp-oauth-core';
import {
  getLegacyMcpOAuthTokenStorePath,
  getInternalLegacySharedMcpOAuthTokenStorePath,
  getMcpOAuthTokenStorePath,
} from '../lib/paths';
import {
  getSecretStoragePolicy,
  getSecureStorageFailure,
  type SecretStoragePolicy,
} from '../lib/secure-storage-policy';
import { writeFileAtomically } from '../lib/atomic-file';
import { migrateSecureStorageFile } from '../lib/secure-storage-migration';

interface StoredMcpOAuthTokenRecord {
  serverId: string;
  configId: string;
  encryptedAccessTokenBase64: string;
  encryptedRefreshTokenBase64?: string;
  upstreamUrl?: string;
  clientId?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  tokenUrlRequiresPublicAddress?: boolean;
  /** How the client authenticated at sign-in; absent on older records. */
  tokenEndpointAuthMethod?: TokenEndpointAuthMethod;
  resource?: string;
  tokenType: string;
  scope?: string;
  expiresAt?: string;
  updatedAt: string;
  lastError?: string;
}

interface StoredMcpOAuthTokenFile {
  version: 1;
  records: Record<string, StoredMcpOAuthTokenRecord>;
}

export interface McpOAuthTokenRecord {
  serverId: string;
  configId: string;
  accessToken: string;
  refreshToken?: string;
  upstreamUrl?: string;
  clientId?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  tokenUrlRequiresPublicAddress?: boolean;
  /** How the client authenticated at sign-in; absent on older records. */
  tokenEndpointAuthMethod?: TokenEndpointAuthMethod;
  resource?: string;
  tokenType: string;
  scope?: string;
  expiresAt?: string;
  updatedAt: string;
  lastError?: string;
}

interface McpOAuthErrorBinding {
  upstreamUrl?: string;
  accessToken?: string;
}

function buildCanonicalResourceUrl(mcpUrl: string): string {
  const parsed = new URL(mcpUrl);
  parsed.hash = '';
  return parsed.toString();
}

function getCanonicalUpstreamUrl(definition: McpServerDefinitionData): string {
  return buildCanonicalResourceUrl(definition.url ?? '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class McpOAuthSecureStorageUnavailableError extends Error {
  constructor(readonly secureStorageFailure: SecureStorageFailure) {
    super('Secure storage unavailable');
    this.name = 'McpOAuthSecureStorageUnavailableError';
  }
}

function getMcpSecretStoragePolicy(): SecretStoragePolicy {
  const policy = getSecretStoragePolicy();
  return {
    ...policy,
    encrypt: (text): Buffer => {
      try {
        return policy.encrypt(text);
      } catch (error) {
        const failure = getSecureStorageFailure(error);
        if (
          failure &&
          (failure.state === 'unavailable' || failure.state === 'locked')
        )
          throw new McpOAuthSecureStorageUnavailableError(failure);
        throw error;
      }
    },
  };
}

function tokenKey(serverId: string, configId: string): string {
  return `${serverId}:${configId}`;
}

let tokenStoreMutationQueue: Promise<void> = Promise.resolve();
let tokensChangedListener: ((serverIds: string[]) => void) | null = null;

export function setMcpOAuthTokensChangedListener(
  listener: ((serverIds: string[]) => void) | null,
): void {
  tokensChangedListener = listener;
}

export type McpOAuthRevocationReason =
  | 'cleared'
  | 'invalidated'
  | 'errored'
  | 'migrated';
export interface McpOAuthCredentialRevokedEvent {
  readonly serverId: string;
  readonly configId: string;
  readonly reason: McpOAuthRevocationReason;
}
const revocationListeners = new Set<
  (event: McpOAuthCredentialRevokedEvent) => void
>();

/**
 * CAN-4126: fires once per changed record after a committed write that
 * cleared, invalidated, errored or migrated it. Never fires for saves or for a
 * write rolled back by `isCurrent`. A throwing listener is skipped. Returns an
 * unsubscribe function.
 */
export function onMcpOAuthCredentialRevoked(
  listener: (event: McpOAuthCredentialRevokedEvent) => void,
): () => void {
  revocationListeners.add(listener);
  return (): void => {
    revocationListeners.delete(listener);
  };
}

function isStoredRecord(value: unknown): value is StoredMcpOAuthTokenRecord {
  return (
    isRecord(value) &&
    typeof value.serverId === 'string' &&
    typeof value.configId === 'string' &&
    typeof value.encryptedAccessTokenBase64 === 'string' &&
    (value.encryptedRefreshTokenBase64 === undefined ||
      typeof value.encryptedRefreshTokenBase64 === 'string') &&
    (value.upstreamUrl === undefined ||
      typeof value.upstreamUrl === 'string') &&
    (value.clientId === undefined || typeof value.clientId === 'string') &&
    (value.authorizationUrl === undefined ||
      typeof value.authorizationUrl === 'string') &&
    (value.tokenUrl === undefined || typeof value.tokenUrl === 'string') &&
    (value.tokenUrlRequiresPublicAddress === undefined ||
      typeof value.tokenUrlRequiresPublicAddress === 'boolean') &&
    (value.tokenEndpointAuthMethod === undefined ||
      isTokenEndpointAuthMethod(value.tokenEndpointAuthMethod)) &&
    (value.resource === undefined || typeof value.resource === 'string') &&
    typeof value.tokenType === 'string' &&
    (value.scope === undefined || typeof value.scope === 'string') &&
    (value.expiresAt === undefined || typeof value.expiresAt === 'string') &&
    typeof value.updatedAt === 'string' &&
    (value.lastError === undefined || typeof value.lastError === 'string')
  );
}

function parseStoredFileStrict(raw: string): StoredMcpOAuthTokenFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Parser diagnostics can contain fragments of the stored secret payload.
    throw new Error('Invalid MCP OAuth token store');
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.records)) {
    throw new Error('Invalid MCP OAuth token store');
  }
  const records: Record<string, StoredMcpOAuthTokenRecord> = {};
  for (const [key, value] of Object.entries(parsed.records)) {
    if (!isStoredRecord(value)) {
      throw new Error('Invalid MCP OAuth token record');
    }
    records[key] = value;
  }
  return { version: 1, records };
}

function validateEveryStoredToken(
  safeStorage: SecretStoragePolicy,
  file: StoredMcpOAuthTokenFile,
): StoredMcpOAuthTokenFile {
  Object.values(file.records).forEach((record) =>
    decryptRecord(safeStorage, record),
  );
  return file;
}

function reencryptStoredFile(
  safeStorage: SecretStoragePolicy,
  file: StoredMcpOAuthTokenFile,
): string {
  const records: Record<string, StoredMcpOAuthTokenRecord> = {};
  for (const [key, stored] of Object.entries(file.records)) {
    const record = decryptRecord(safeStorage, stored);
    records[key] = {
      ...stored,
      encryptedAccessTokenBase64: safeStorage
        .encrypt(record.accessToken)
        .toString('base64'),
      encryptedRefreshTokenBase64: encryptOptional(
        safeStorage,
        record.refreshToken,
      ),
    };
  }
  return JSON.stringify({ version: 1, records }, null, 2);
}

async function readStoredFile(): Promise<StoredMcpOAuthTokenFile> {
  const safeStorage = getMcpSecretStoragePolicy();
  const filePath = getMcpOAuthTokenStorePath();
  const migration = await migrateSecureStorageFile<StoredMcpOAuthTokenFile>({
    currentPath: filePath,
    legacyPath: getInternalLegacySharedMcpOAuthTokenStorePath(),
    decode: (raw) => parseStoredFileStrict(raw.toString('utf8')),
    decodeLegacy: (raw) =>
      validateEveryStoredToken(
        safeStorage,
        parseStoredFileStrict(raw.toString('utf8')),
      ),
    encode: (file) => reencryptStoredFile(safeStorage, file),
    storeKind: 'mcp-oauth',
    beforeWrite: async () => {
      await mkdir(dirname(filePath), { recursive: true });
      safeStorage.assertCanWrite();
    },
    writeOptions: { encoding: 'utf8', mode: 0o600 },
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
  if (migration.status === 'unavailable') safeStorage.assertCanRead();
  if (
    migration.status === 'foreign-legacy-skipped' &&
    migration.secureStorageFailure
  )
    return { version: 1, records: {} };
  if (migration.status !== 'absent')
    throw new Error('MCP OAuth token store unavailable');
  try {
    return parseStoredFileStrict(
      await readFile(getLegacyMcpOAuthTokenStorePath(), 'utf8'),
    );
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT')
      return { version: 1, records: {} };
    throw error;
  }
}

async function writeStoredFile(
  file: StoredMcpOAuthTokenFile,
  requiresWrite = false,
): Promise<void> {
  const filePath = getMcpOAuthTokenStorePath();
  await mkdir(dirname(filePath), { recursive: true });
  if (requiresWrite) getMcpSecretStoragePolicy().assertCanWrite();
  await writeFileAtomically(filePath, JSON.stringify(file, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rm(getLegacyMcpOAuthTokenStorePath(), { force: true }).catch(
    () => undefined,
  );
}

function queueTokenStoreMutation(
  mutation: (file: StoredMcpOAuthTokenFile) => Promise<void> | void,
  isCurrent?: () => boolean,
  requiresWrite: () => boolean = () => false,
  revocation?: McpOAuthRevocationReason,
): Promise<boolean> {
  const next = tokenStoreMutationQueue.then(async (): Promise<boolean> => {
    const file = await readStoredFile();
    if (isCurrent && !isCurrent()) return false;
    const original: StoredMcpOAuthTokenFile = {
      version: 1,
      records: Object.fromEntries(
        Object.entries(file.records).map(([key, record]) => [
          key,
          { ...record },
        ]),
      ),
    };
    const previous = new Map(
      Object.entries(file.records).map(([key, record]) => [
        key,
        {
          serverId: record.serverId,
          configId: record.configId,
          value: JSON.stringify(record),
        },
      ]),
    );
    await mutation(file);
    if (isCurrent && !isCurrent()) return false;
    const keys = new Set([
      ...Array.from(previous.keys()),
      ...Object.keys(file.records),
    ]);
    const changedRecords: { serverId: string; configId: string }[] = [];
    const changedServers = Array.from(keys).flatMap((key) => {
      const record = file.records[key];
      const before = previous.get(key);
      if (before?.value === (record ? JSON.stringify(record) : undefined))
        return [];
      const serverId = record?.serverId ?? before?.serverId;
      const configId = record?.configId ?? before?.configId;
      if (serverId && configId) changedRecords.push({ serverId, configId });
      return serverId ? [serverId] : [];
    });
    if (changedServers.length === 0) return true;
    await writeStoredFile(file, requiresWrite());
    if (isCurrent && !isCurrent()) {
      // Cancellation may arrive while the atomic write is awaiting filesystem
      // completion. Restore the prior snapshot inside the same queue, before
      // readers or newer mutations can observe the abandoned account/error.
      await writeStoredFile(original);
      return false;
    }
    try {
      tokensChangedListener?.(Array.from(new Set(changedServers)));
    } finally {
      // A failing inventory refresh cannot leave broker handles usable after
      // their credential was durably removed. Preserve the refresh rejection.
      if (revocation) {
        for (const changed of changedRecords) {
          for (const listener of Array.from(revocationListeners)) {
            try {
              listener({ ...changed, reason: revocation });
            } catch {
              /* skipped */
            }
          }
        }
      }
    }
    return true;
  });
  tokenStoreMutationQueue = next.then(
    (): void => undefined,
    (): void => undefined,
  );
  return next;
}

/** Wait through writes/rollbacks without serializing independent readers. */
async function readTokenStoreSnapshot(): Promise<StoredMcpOAuthTokenFile> {
  for (;;) {
    const pending = tokenStoreMutationQueue;
    await pending;
    const file = await readStoredFile();
    // A write that began during the read may have exposed provisional data.
    if (pending === tokenStoreMutationQueue) return file;
  }
}

function encryptOptional(
  safeStorage: SecretStoragePolicy,
  value: string | undefined,
): string | undefined {
  return value ? safeStorage.encrypt(value).toString('base64') : undefined;
}

function decryptOptional(
  safeStorage: SecretStoragePolicy,
  value: string | undefined,
): string | undefined {
  return value ? safeStorage.decrypt(Buffer.from(value, 'base64')) : undefined;
}

function decryptRecord(
  safeStorage: SecretStoragePolicy,
  record: StoredMcpOAuthTokenRecord,
): McpOAuthTokenRecord {
  return {
    serverId: record.serverId,
    configId: record.configId,
    accessToken: safeStorage.decrypt(
      Buffer.from(record.encryptedAccessTokenBase64, 'base64'),
    ),
    refreshToken: decryptOptional(
      safeStorage,
      record.encryptedRefreshTokenBase64,
    ),
    upstreamUrl: record.upstreamUrl,
    clientId: record.clientId,
    authorizationUrl: record.authorizationUrl,
    tokenUrl: record.tokenUrl,
    tokenUrlRequiresPublicAddress: record.tokenUrlRequiresPublicAddress,
    tokenEndpointAuthMethod: record.tokenEndpointAuthMethod,
    resource: record.resource,
    tokenType: record.tokenType,
    scope: record.scope,
    expiresAt: record.expiresAt,
    updatedAt: record.updatedAt,
    lastError: record.lastError,
  };
}

export async function getMcpOAuthToken(
  serverId: string,
  configId: string,
): Promise<McpOAuthTokenRecord | null> {
  const safeStorage = getMcpSecretStoragePolicy();
  safeStorage.assertCanRead();
  const file = await readTokenStoreSnapshot();
  const record = file.records[tokenKey(serverId, configId)];
  if (!record) {
    return null;
  }

  return decryptRecord(safeStorage, record);
}

/** Non-secret cache revision for the stored OAuth state of one config. */
export async function getMcpOAuthTokenRevision(
  serverId: string,
  configId: string,
): Promise<string> {
  const file = await readTokenStoreSnapshot();
  return file.records[tokenKey(serverId, configId)]?.updatedAt ?? 'missing';
}

/** Move legacy plugin credentials under the existing single-writer queue. */
export async function migratePluginMcpOAuthToken(
  definition: McpServerDefinitionData,
  config: McpServerConfigData,
  sources: Array<{
    serverId: string;
    configId: string;
    allowDiscoveredClient: boolean;
  }>,
): Promise<void> {
  try {
    const destination = tokenKey(definition.id, config.id);
    const snapshot = await readTokenStoreSnapshot();
    if (
      !sources.some(
        (source) =>
          tokenKey(source.serverId, source.configId) !== destination &&
          snapshot.records[tokenKey(source.serverId, source.configId)],
      )
    )
      return;
    const upstreamUrl = getCanonicalUpstreamUrl(definition);
    await queueTokenStoreMutation(
      (file): void => {
        const matches = sources.flatMap((source) => {
          const key = tokenKey(source.serverId, source.configId);
          const record = file.records[key];
          if (
            key === destination ||
            !record ||
            record.upstreamUrl !== upstreamUrl
          )
            return [];
          const oauth = definition.oauth;
          if (
            oauth?.clientId
              ? record.clientId !== oauth.clientId
              : !source.allowDiscoveredClient
          )
            return [];
          if (
            oauth?.authorizationUrl &&
            oauth.authorizationUrl !== record.authorizationUrl
          )
            return [];
          if (oauth?.tokenUrl && oauth.tokenUrl !== record.tokenUrl) return [];
          return [{ key, record }];
        });
        matches.sort((a, b) =>
          b.record.updatedAt.localeCompare(a.record.updatedAt),
        );
        const policy = getSecretStoragePolicy();
        for (const match of matches) decryptRecord(policy, match.record);
        const newest = matches[0]?.record;
        if (!newest) return;
        const existingDestination = file.records[destination];
        // A destination only supersedes readable aliases when its credentials
        // can actually be read. Storage failure must retain every source record.
        if (existingDestination) decryptRecord(policy, existingDestination);
        if (!existingDestination) {
          file.records[destination] = {
            ...newest,
            serverId: definition.id,
            configId: config.id,
          };
        }
        // Remove matching aliases in the same transaction. Disconnecting the new
        // identity must not resurrect an older account on the next inventory read.
        for (const match of matches) delete file.records[match.key];
      },
      undefined,
      undefined,
      'migrated',
    );
  } catch (error) {
    // Migration is optional for declarations that do not use app-managed OAuth.
    // Keep inventory/runtime usable when the OS credential store is unavailable.
    if (getSecureStorageFailure(error)) return;
    throw error;
  }
}

export async function saveMcpOAuthToken(
  record: McpOAuthTokenRecord,
): Promise<void> {
  await saveMcpOAuthTokenIfCurrent(record);
}

export async function saveMcpOAuthTokenIfCurrent(
  record: McpOAuthTokenRecord,
  expected?: McpOAuthTokenRecord,
  isCurrent?: () => boolean,
): Promise<boolean> {
  const safeStorage = getMcpSecretStoragePolicy();
  let saved = false;
  const committed = await queueTokenStoreMutation(
    (file): void => {
      if (expected) {
        const current =
          file.records[tokenKey(record.serverId, record.configId)];
        if (!current) return;
        const decrypted = decryptRecord(safeStorage, current);
        if (
          decrypted.accessToken !== expected.accessToken ||
          decrypted.refreshToken !== expected.refreshToken ||
          decrypted.upstreamUrl !== expected.upstreamUrl
        ) {
          return;
        }
      }
      saved = true;
      file.records[tokenKey(record.serverId, record.configId)] = {
        serverId: record.serverId,
        configId: record.configId,
        encryptedAccessTokenBase64: safeStorage
          .encrypt(record.accessToken)
          .toString('base64'),
        encryptedRefreshTokenBase64: encryptOptional(
          safeStorage,
          record.refreshToken,
        ),
        upstreamUrl: record.upstreamUrl,
        clientId: record.clientId,
        authorizationUrl: record.authorizationUrl,
        tokenUrl: record.tokenUrl,
        tokenUrlRequiresPublicAddress: record.tokenUrlRequiresPublicAddress,
        tokenEndpointAuthMethod: record.tokenEndpointAuthMethod,
        resource: record.resource,
        tokenType: record.tokenType,
        scope: record.scope,
        expiresAt: record.expiresAt,
        updatedAt: record.updatedAt,
        lastError: record.lastError,
      };
    },
    isCurrent,
    () => true,
  );
  return saved && committed;
}

export async function clearMcpOAuthToken(
  serverId: string,
  configId: string,
): Promise<void> {
  await queueTokenStoreMutation(
    (file): void => {
      delete file.records[tokenKey(serverId, configId)];
    },
    undefined,
    undefined,
    'cleared',
  );
}

/**
 * Device-only repair cleanup when a damaged definition cannot supply config
 * IDs. The OAuth owner validates stored identities inside its mutation queue;
 * callers never enumerate, decrypt or select token-store keys themselves.
 */
export async function clearMcpOAuthTokensForServer(
  serverId: string,
): Promise<{ cleared: number }> {
  if (!/^[a-f0-9-]{1,256}$/.test(serverId))
    throw new Error('Invalid device MCP server id.');
  let cleared = 0;
  await queueTokenStoreMutation(
    (file): void => {
      const entries = Object.entries(file.records);
      // Validate the whole store before changing it. A key/record disagreement
      // cannot be resolved by a prefix match or by guessing which side owns it.
      if (
        entries.some(
          ([key, record]) =>
            !record.serverId ||
            !record.configId ||
            key !== tokenKey(record.serverId, record.configId),
        )
      )
        throw new Error('Invalid MCP OAuth token identity');
      for (const [key, record] of entries) {
        if (record.serverId !== serverId) continue;
        delete file.records[key];
        cleared += 1;
      }
    },
    undefined,
    undefined,
    'cleared',
  );
  return { cleared };
}

export async function recordMcpOAuthTokenError(
  serverId: string,
  configId: string,
  lastError: string,
  binding?: McpOAuthErrorBinding,
  isCurrent?: () => boolean,
): Promise<void> {
  let encryptedNewRecord = false;
  await queueTokenStoreMutation(
    (file): void => {
      const record = file.records[tokenKey(serverId, configId)];
      const updatedAt = new Date().toISOString();
      if (
        binding?.accessToken !== undefined &&
        (!record ||
          decryptRecord(getMcpSecretStoragePolicy(), record).accessToken !==
            binding.accessToken)
      )
        return;
      if (
        record &&
        binding?.upstreamUrl &&
        record.upstreamUrl !== binding.upstreamUrl
      )
        return;
      if (!record) {
        encryptedNewRecord = true;
        const safeStorage = getMcpSecretStoragePolicy();
        file.records[tokenKey(serverId, configId)] = {
          serverId,
          configId,
          encryptedAccessTokenBase64: safeStorage
            .encrypt('')
            .toString('base64'),
          upstreamUrl: binding?.upstreamUrl,
          tokenType: 'Bearer',
          updatedAt,
          lastError,
        };
        return;
      }

      file.records[tokenKey(serverId, configId)] = {
        ...record,
        upstreamUrl: binding?.upstreamUrl ?? record.upstreamUrl,
        lastError,
        updatedAt,
      };
    },
    isCurrent,
    () => encryptedNewRecord,
    'errored',
  );
}

/** A rejected access token does not prove that the account's refresh grant is invalid. */
export async function invalidateMcpOAuthAccessToken(
  serverId: string,
  configId: string,
  accessToken: string,
  upstreamUrl: string,
): Promise<void> {
  await queueTokenStoreMutation(
    (file): void => {
      const record = file.records[tokenKey(serverId, configId)];
      if (
        !record ||
        record.upstreamUrl !== buildCanonicalResourceUrl(upstreamUrl)
      )
        return;
      const token = decryptRecord(getMcpSecretStoragePolicy(), record);
      if (token.accessToken !== accessToken) return;
      record.expiresAt = new Date(0).toISOString();
      record.updatedAt = new Date().toISOString();
    },
    undefined,
    undefined,
    'invalidated',
  );
}

/**
 * The cached OAuth state of one server config.
 *
 * {@link McpOAuthAuthStatusResult.canRefresh} exists because `status` alone is
 * NOT enough to decide whether a caller is looking at a dead end. `'expired'`
 * is derived from `expiresAt <= Date.now()` and nothing else, while the
 * resolver the proxy actually uses — `getValidMcpAccessToken` in
 * `oauth-client.ts` — treats that same record as recoverable: it falls through
 * to a `grant_type: 'refresh_token'` exchange whenever a refresh credential is
 * stored. A consumer that refuses work on `'expired'` without reading this flag
 * refuses work that would have succeeded (CAN-1814 review).
 *
 * It reports only that a refresh credential EXISTS, never that a refresh will
 * succeed — proving that needs the network, which the send preflight may not
 * touch. A terminal grant/client rejection records `lastError`; temporary
 * outages retain the grant and use a bounded retry delay.
 */
export interface McpOAuthAuthStatusResult {
  expiresAt?: string;
  secureStorageFailure?: SecureStorageFailure;
  status: McpServerAuthStatus;
  lastError?: string;
  /** Revision of `lastError`, derived from the credential record timestamp. */
  authErrorRevision?: string;
  /** The status was derived from a stored credential record. */
  hasStoredToken?: boolean;
  /** A refresh credential is stored, so an expired access token may recover. */
  canRefresh?: boolean;
}

/**
 * Whether an expired record still carries the credential a refresh needs.
 *
 * Deliberately checks ONLY `refreshToken`, not the `clientId`/`tokenUrl` that
 * `getValidMcpAccessToken` additionally requires. Those are resolved partly
 * from the server DEFINITION, which this module does not have, and the bias
 * here is fail-open: a false `true` costs a late mid-turn failure that the
 * recovery card already handles, while a false `false` refuses a working turn.
 */
function hasRefreshCredential(token: McpOAuthTokenRecord): boolean {
  return typeof token.refreshToken === 'string' && token.refreshToken !== '';
}

export async function getMcpOAuthAuthStatus(
  serverId: string,
  configId: string,
): Promise<McpOAuthAuthStatusResult> {
  try {
    const token = await getMcpOAuthToken(serverId, configId);
    if (!token) {
      return { status: 'not_connected' };
    }
    if (token.lastError) {
      return {
        status: 'error',
        lastError: token.lastError,
        authErrorRevision: token.updatedAt,
        hasStoredToken: true,
      };
    }
    if (token.expiresAt && Date.parse(token.expiresAt) <= Date.now()) {
      return {
        status: 'expired',
        hasStoredToken: true,
        ...(hasRefreshCredential(token) ? { canRefresh: true } : {}),
      };
    }
    return { status: 'connected', hasStoredToken: true };
  } catch (error: unknown) {
    const secureStorageFailure = getSecureStorageFailure(error);
    if (secureStorageFailure) {
      return {
        status: 'error',
        lastError: 'Secure storage unavailable',
        secureStorageFailure,
      };
    }
    return {
      status: 'error',
      lastError: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export async function getMcpOAuthAuthStatusForDefinition(
  definition: McpServerDefinitionData,
  config: McpServerConfigData,
): Promise<McpOAuthAuthStatusResult> {
  try {
    const token = await getMcpOAuthToken(definition.id, config.id);
    if (!token) {
      return { status: 'not_connected' };
    }
    if (token.upstreamUrl !== getCanonicalUpstreamUrl(definition)) {
      await clearMcpOAuthToken(definition.id, config.id);
      return { status: 'not_connected' };
    }
    if (token.lastError) {
      return {
        status: 'error',
        lastError: token.lastError,
        authErrorRevision: token.updatedAt,
        hasStoredToken: true,
      };
    }
    const canRefresh =
      hasRefreshCredential(token) &&
      Boolean(token.clientId?.trim() || definition.oauth?.clientId?.trim()) &&
      Boolean(token.tokenUrl?.trim() || definition.oauth?.tokenUrl?.trim());
    const expired =
      token.expiresAt &&
      (!Number.isFinite(Date.parse(token.expiresAt)) ||
        Date.parse(token.expiresAt) <= Date.now());
    return {
      status: expired ? 'expired' : 'connected',
      hasStoredToken: true,
      ...(canRefresh ? { canRefresh: true } : {}),
      ...(token.expiresAt ? { expiresAt: token.expiresAt } : {}),
    };
  } catch (error: unknown) {
    const secureStorageFailure = getSecureStorageFailure(error);
    if (secureStorageFailure) {
      return {
        status: 'error',
        lastError: 'Secure storage unavailable',
        secureStorageFailure,
      };
    }
    return {
      status: 'error',
      lastError: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
