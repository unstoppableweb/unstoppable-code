import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { normalizeModelGatewayBaseUrl } from '@canopy/protocol/canopy-server';
import {
  gatewayBaseUrlSchema,
  gatewayDisplayNameSchema,
  gatewayModelsSchema,
  personalAiGatewayUpdateSchema,
  type PersonalAiGatewayConfig,
} from '@canopy/protocol/model-gateway';
import { normalizeUuid } from '@canopy/execution-engine/lib/workspace-owner';
import { writeFileAtomically } from './atomic-file';
import { isMissingFileError } from './fs-utils';
import { getLocalModelGatewayStorePath } from './paths';
import { getSecretStoragePolicy } from './secure-storage-policy';
import type { ModelGatewayCredentialRecord } from './model-gateway-credential-store';

/**
 * The device AI gateway (signed out or guest). Its config and key are one
 * endpoint-bound record owned by Electron main: the key needs main
 * `safeStorage`, and a separate config writer could disagree with the key.
 * The `organizationId` is a random UUID made once per device. It is never a
 * real organization, so it reuses the gateway catalog, model-id suffixing and
 * owner checks unchanged.
 */

/** Owner recorded on a device credential: there is no account behind it. */
export const LOCAL_MODEL_GATEWAY_ACCOUNT_ID = 'device';

/** Keep a few staged endpoints, so an abandoned connect cannot grow the file. */
const MAX_STORED_CREDENTIALS = 4;

const storedCredentialSchema = z.object({
  encryptedApiKeyBase64: z.string().min(1),
  baseUrlAtSave: z.string(),
  updatedAt: z.string(),
  lastValidatedAt: z.string().optional(),
  validated: z.boolean().optional(),
  lastError: z.string().optional(),
});
type StoredCredential = z.output<typeof storedCredentialSchema>;

const storedConfigSchema = z.object({
  displayName: gatewayDisplayNameSchema,
  baseUrl: gatewayBaseUrlSchema.nullable(),
  models: gatewayModelsSchema,
  enabled: z.boolean(),
  onlyThisGateway: z.boolean(),
  promptCachePassthrough: z.boolean(),
});
type StoredConfig = z.output<typeof storedConfigSchema>;

const storedFileSchema = z.object({
  version: z.literal(1),
  organizationId: z.string(),
  config: z.unknown().optional(),
  credentials: z.record(z.string(), z.unknown()).optional(),
  conflictNotices: z.record(z.string(), z.string()).optional(),
});

interface LocalGatewayFile {
  version: 1;
  organizationId: string;
  config?: StoredConfig;
  /** Keyed by normalized endpoint. */
  credentials: Record<string, StoredCredential>;
  /** Device-config revision last reported per account (migration conflict). */
  conflictNotices: Record<string, string>;
}

export type LocalModelGatewayErrorCode =
  | 'invalid'
  | 'stale_scope'
  | 'stale_revision';

export class LocalModelGatewayError extends Error {
  constructor(readonly code: LocalModelGatewayErrorCode) {
    super(
      code === 'invalid'
        ? 'AI gateway configuration is invalid.'
        : 'AI gateway settings changed. Reload before saving.',
    );
    this.name = 'LocalModelGatewayError';
  }
}

let cache: LocalGatewayFile | null = null;
let loading: Promise<LocalGatewayFile> | null = null;
let mutationQueue: Promise<void> = Promise.resolve();
const listeners = new Set<(config: PersonalAiGatewayConfig | null) => void>();

function emptyFile(organizationId?: string): LocalGatewayFile {
  return {
    version: 1,
    organizationId: organizationId ?? randomUUID(),
    credentials: {},
    conflictNotices: {},
  };
}

function parseFile(raw: string): LocalGatewayFile | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const file = storedFileSchema.safeParse(value);
  if (!file.success) return null;
  const organizationId = normalizeUuid(file.data.organizationId);
  if (!organizationId) return null;
  const config = storedConfigSchema.safeParse(file.data.config);
  const credentials: Record<string, StoredCredential> = {};
  for (const [endpoint, record] of Object.entries(
    file.data.credentials ?? {},
  )) {
    const parsed = storedCredentialSchema.safeParse(record);
    const normalized = normalizeModelGatewayBaseUrl(endpoint);
    if (parsed.success && normalized) credentials[normalized] = parsed.data;
  }
  return {
    version: 1,
    organizationId,
    ...(config.success ? { config: config.data } : {}),
    credentials,
    conflictNotices: file.data.conflictNotices ?? {},
  };
}

/**
 * Only a missing file reads as empty. Any other read failure rejects without
 * caching, so no mutation can replace data it could not read; a later read
 * retries. A corrupt file is kept aside before the device starts empty.
 */
function salvageOrganizationId(raw: string): string | null {
  try {
    const value = z
      .object({ organizationId: z.string() })
      .safeParse(JSON.parse(raw));
    return value.success ? normalizeUuid(value.data.organizationId) : null;
  } catch {
    return null;
  }
}

async function loadStore(): Promise<LocalGatewayFile> {
  const path = getLocalModelGatewayStorePath();
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) return emptyFile();
    throw error;
  }
  const parsed = parseFile(raw);
  if (parsed) return parsed;
  const asidePath = `${path}.corrupt-${Date.now()}`;
  await rename(path, asidePath);
  // Keep the device gateway id when it survives, so its model ids still
  // resolve; the config and keys stay in the aside file for recovery.
  const organizationId = salvageOrganizationId(raw);
  // eslint-disable-next-line no-console
  console.warn(
    `[local-model-gateway] corrupt device AI gateway kept aside at ${asidePath}`,
  );
  return emptyFile(organizationId ?? undefined);
}

async function readStore(): Promise<LocalGatewayFile> {
  if (cache) return cache;
  loading ??= loadStore().then(
    (file) => {
      cache = file;
      loading = null;
      return file;
    },
    (error: unknown) => {
      loading = null;
      throw error;
    },
  );
  return loading;
}

function revisionOf(config: StoredConfig): string {
  const fields = Object.fromEntries(
    Object.entries(config).sort(([a], [b]) => a.localeCompare(b)),
  );
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

function projectConfig(file: LocalGatewayFile): PersonalAiGatewayConfig | null {
  if (!file.config) return null;
  return {
    organizationId: file.organizationId,
    ...file.config,
    revision: revisionOf(file.config),
  };
}

function notify(config: PersonalAiGatewayConfig | null): void {
  for (const listener of listeners) {
    try {
      listener(config);
    } catch {
      // A listener failure never affects the durable write.
    }
  }
}

/**
 * Serialize a mutation against the store. The cache is replaced only after a
 * durable write, so a failed write leaves readers on the last saved state.
 */
function queueMutation<T>(
  mutation: (file: LocalGatewayFile) => T | Promise<T>,
): Promise<T> {
  const next = mutationQueue.then(async () => {
    const current = await readStore();
    const draft: LocalGatewayFile = structuredClone(current);
    const result = await mutation(draft);
    const path = getLocalModelGatewayStorePath();
    await mkdir(dirname(path), { recursive: true });
    await writeFileAtomically(path, `${JSON.stringify(draft, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      durable: true,
    });
    const before = projectConfig(current);
    cache = draft;
    const after = projectConfig(draft);
    if (before?.revision !== after?.revision) notify(after);
    return result;
  });
  mutationQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export async function getLocalModelGatewayOrganizationId(): Promise<string> {
  return (await readStore()).organizationId;
}

export async function isLocalModelGatewayOrganizationId(
  organizationId: string | null | undefined,
): Promise<boolean> {
  const normalized = normalizeUuid(organizationId);
  return (
    normalized !== null && normalized === (await readStore()).organizationId
  );
}

/** The device gateway, or null when none was ever set up on this device. */
export async function readLocalModelGateway(): Promise<PersonalAiGatewayConfig | null> {
  return projectConfig(await readStore());
}

function nextConfig(
  current: StoredConfig | undefined,
  patch: z.output<typeof personalAiGatewayUpdateSchema>,
): StoredConfig {
  const next = storedConfigSchema.safeParse({
    displayName:
      patch.displayName === undefined
        ? (current?.displayName ?? null)
        : patch.displayName,
    baseUrl:
      patch.baseUrl === undefined ? (current?.baseUrl ?? null) : patch.baseUrl,
    models: patch.models ?? current?.models ?? [],
    enabled: patch.enabled ?? current?.enabled ?? false,
    onlyThisGateway: patch.onlyThisGateway ?? current?.onlyThisGateway ?? false,
    promptCachePassthrough:
      patch.promptCachePassthrough ?? current?.promptCachePassthrough ?? true,
  });
  if (!next.success) throw new LocalModelGatewayError('invalid');
  // Same rule as the hosted gateway: an enabled gateway needs a URL and models.
  if (
    next.data.enabled &&
    (next.data.baseUrl === null || next.data.models.length === 0)
  )
    throw new LocalModelGatewayError('invalid');
  return next.data;
}

/**
 * Apply a gateway-only patch with the same contract as
 * `account.settings.ai-gateway.update`: `expectedOrganizationId` must be this
 * device's gateway id and `expectedRevision` the current revision, or
 * `absent` before the first save. Clearing `baseUrl` removes the gateway and
 * deletes its keys.
 */
export async function updateLocalModelGateway(
  raw: unknown,
): Promise<PersonalAiGatewayConfig> {
  const input = personalAiGatewayUpdateSchema.safeParse(raw);
  if (!input.success) throw new LocalModelGatewayError('invalid');
  return queueMutation((file) => {
    if (
      normalizeUuid(input.data.expectedOrganizationId) !== file.organizationId
    )
      throw new LocalModelGatewayError('stale_scope');
    const currentRevision = file.config ? revisionOf(file.config) : 'absent';
    if (currentRevision !== input.data.expectedRevision)
      throw new LocalModelGatewayError('stale_revision');
    const previousEndpoint = normalizeModelGatewayBaseUrl(file.config?.baseUrl);
    const config = nextConfig(file.config, input.data);
    file.config = config;
    const endpoint = normalizeModelGatewayBaseUrl(config.baseUrl);
    if (endpoint === null) {
      file.credentials = {};
    } else if (endpoint !== previousEndpoint) {
      // Moving to an endpoint keeps only its key; a key staged for another
      // endpoint survives saves that leave the endpoint unchanged.
      const active = file.credentials[endpoint];
      file.credentials = active ? { [endpoint]: active } : {};
    }
    const projected = projectConfig(file);
    if (!projected) throw new LocalModelGatewayError('invalid');
    return projected;
  });
}

/**
 * Remove the device gateway and its keys after it moved to an account. False
 * when the device config changed from `expectedRevision` meanwhile: the newer
 * edit stays for the next migration pass to decide.
 */
export async function clearLocalModelGateway(
  expectedRevision: string,
): Promise<boolean> {
  return queueMutation((file) => {
    if (!file.config || revisionOf(file.config) !== expectedRevision)
      return false;
    delete file.config;
    file.credentials = {};
    file.conflictNotices = {};
    return true;
  });
}

/** Record that `accountId` was told about this revision; false when already told. */
export async function recordLocalModelGatewayConflictNotice(
  accountId: string,
  revision: string,
): Promise<boolean> {
  if ((await readStore()).conflictNotices[accountId] === revision) return false;
  // Compare and set inside the queue, so concurrent calls report it once.
  return queueMutation((draft) => {
    if (draft.conflictNotices[accountId] === revision) return false;
    draft.conflictNotices[accountId] = revision;
    return true;
  });
}

export function subscribeLocalModelGatewayChanges(
  listener: (config: PersonalAiGatewayConfig | null) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function credentialFor(
  file: LocalGatewayFile,
  expectedBaseUrl?: string,
): { endpoint: string; record: StoredCredential } | null {
  const endpoint = normalizeModelGatewayBaseUrl(
    expectedBaseUrl ?? file.config?.baseUrl,
  );
  if (endpoint === null) return null;
  const record = file.credentials[endpoint];
  return record ? { endpoint, record } : null;
}

export async function loadLocalModelGatewayCredential(
  expectedBaseUrl?: string,
): Promise<ModelGatewayCredentialRecord | null> {
  const file = await readStore();
  const found = credentialFor(file, expectedBaseUrl);
  if (!found) return null;
  const storage = getSecretStoragePolicy();
  return {
    organizationId: file.organizationId,
    apiKey: storage.decrypt(
      Buffer.from(found.record.encryptedApiKeyBase64, 'base64'),
    ),
    baseUrlAtSave: found.record.baseUrlAtSave,
    updatedAt: found.record.updatedAt,
    lastValidatedAt: found.record.lastValidatedAt,
    validated: found.record.validated,
    lastError: found.record.lastError,
  };
}

/** Encrypted form only, for moving the key to an account without decrypting. */
export async function readLocalModelGatewayCredentialCiphertext(
  baseUrl: string,
): Promise<{
  encryptedApiKeyBase64: string;
  baseUrlAtSave: string;
  updatedAt: string;
  lastValidatedAt?: string;
  validated?: boolean;
  lastError?: string;
} | null> {
  return credentialFor(await readStore(), baseUrl)?.record ?? null;
}

/**
 * Store a key for an endpoint. A different endpoint than the saved config is
 * staged beside the working key until the config moves to it. An empty key
 * deletes every device key.
 */
export async function saveLocalModelGatewayCredential(input: {
  apiKey: string;
  baseUrlAtSave: string;
  lastValidatedAt?: string;
  validated?: boolean;
  lastError?: string;
  signal?: AbortSignal;
}): Promise<void> {
  input.signal?.throwIfAborted();
  const apiKey = input.apiKey.trim();
  const storage = getSecretStoragePolicy();
  if (apiKey) storage.assertCanWrite();
  await queueMutation((file) => {
    input.signal?.throwIfAborted();
    if (!apiKey) {
      file.credentials = {};
      return;
    }
    const endpoint = normalizeModelGatewayBaseUrl(input.baseUrlAtSave);
    if (!endpoint) throw new Error('Invalid gateway endpoint');
    const previousTimes = Object.values(file.credentials)
      .map((record) => Date.parse(record.updatedAt))
      .filter(Number.isFinite);
    file.credentials[endpoint] = {
      encryptedApiKeyBase64: storage.encrypt(apiKey).toString('base64'),
      baseUrlAtSave: endpoint,
      updatedAt: new Date(
        Math.max(Date.now(), ...previousTimes.map((time) => time + 1)),
      ).toISOString(),
      ...(input.lastValidatedAt
        ? { lastValidatedAt: input.lastValidatedAt }
        : {}),
      ...(input.validated === undefined ? {} : { validated: input.validated }),
      ...(input.lastError ? { lastError: input.lastError } : {}),
    };
    const active = normalizeModelGatewayBaseUrl(file.config?.baseUrl);
    const staged = Object.entries(file.credentials)
      .filter(([key]) => key !== active)
      .sort(([, a], [, b]) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(MAX_STORED_CREDENTIALS - 1);
    staged.forEach(([key]) => {
      if (key !== endpoint) delete file.credentials[key];
    });
  });
}

/** Delete every device key; reports whether one existed. */
export async function clearLocalModelGatewayCredentials(): Promise<boolean> {
  if (Object.keys((await readStore()).credentials).length === 0) return false;
  await queueMutation((file) => {
    file.credentials = {};
  });
  return true;
}

/** Persist a gateway-issued rejection without exposing or replacing the key. */
export async function markLocalModelGatewayCredentialRejected(
  lastError: string,
  expectedUpdatedAt?: string,
): Promise<boolean> {
  const file = await readStore();
  const target = expectedUpdatedAt
    ? Object.entries(file.credentials).find(
        ([, record]) => record.updatedAt === expectedUpdatedAt,
      )?.[0]
    : credentialFor(file)?.endpoint;
  if (!target) return false;
  return queueMutation((draft) => {
    const record = draft.credentials[target];
    if (!record) return false;
    if (expectedUpdatedAt && record.updatedAt !== expectedUpdatedAt)
      return false;
    record.lastError = lastError;
    record.validated = false;
    record.lastValidatedAt = new Date().toISOString();
    return true;
  });
}

export function resetLocalModelGatewayStoreForTests(): void {
  cache = null;
  loading = null;
  mutationQueue = Promise.resolve();
  listeners.clear();
}
