import {
  CanopyCloudClientError,
  type CanopyCloudCredentialContext,
  requestCanopyCloudJson,
  resolveCanopyCloudCredentialContext,
} from './client';

const MARKETPLACES_PATH = '/api/v1/plugin-marketplaces';
/** Up to 64 MiB of plugin in base64; the default request budget is for small bodies. */
const DESKTOP_PLUGIN_UPLOAD_TIMEOUT_MS = 5 * 60_000;

/** A cloud marketplace sync, as the hosted routes answer it (CAN-6176). */
export interface CloudMarketplaceSync {
  status: 'preview' | 'applied' | 'revision-mismatch';
  revision: string;
  pluginKeys: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function readSync(value: unknown): CloudMarketplaceSync | null {
  if (!isRecord(value)) return null;
  const { status, revision, plugins } = value;
  if (
    (status !== 'preview' &&
      status !== 'applied' &&
      status !== 'revision-mismatch') ||
    typeof revision !== 'string' ||
    !Array.isArray(plugins)
  )
    return null;
  const pluginKeys: string[] = [];
  for (const plugin of plugins) {
    if (isRecord(plugin) && typeof plugin.pluginKey === 'string')
      pluginKeys.push(plugin.pluginKey);
  }
  return { status, revision, pluginKeys };
}

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const invalid = (): CanopyCloudClientError =>
  new CanopyCloudClientError(
    'invalid-response',
    'Invalid plugin marketplace response.',
  );

/**
 * The signed-in account's cloud credentials, resolved once so a publish's
 * requests all land in the account it checked; throws when signed out.
 */
export async function resolveCloudMarketplaceCredentials(): Promise<CanopyCloudCredentialContext> {
  const credentials = await resolveCanopyCloudCredentialContext();
  if (!credentials.apiKey)
    throw new CanopyCloudClientError(
      'missing-api-key',
      'Sign in to add plugins to the cloud.',
    );
  return credentials;
}

async function marketplaceRequest(
  path: string,
  body: Record<string, unknown>,
  credentialContext?: CanopyCloudCredentialContext,
): Promise<unknown> {
  const credentials =
    credentialContext ?? (await resolveCloudMarketplaceCredentials());
  return requestCanopyCloudJson<unknown>(`${MARKETPLACES_PATH}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    credentialContext: credentials,
  });
}

/** Adds (or adopts) the source in the account's own cloud marketplaces. */
export async function addCloudPluginMarketplace(
  source: string,
  credentialContext?: CanopyCloudCredentialContext,
): Promise<{ marketplaceId: string; sync: CloudMarketplaceSync }> {
  const payload = await marketplaceRequest('', { source }, credentialContext);
  if (!isRecord(payload)) throw invalid();
  const marketplaceId = isRecord(payload.marketplace)
    ? payload.marketplace.externalId
    : undefined;
  const parsed = readSync(payload.sync);
  if (typeof marketplaceId !== 'string' || parsed === null) throw invalid();
  return { marketplaceId, sync: parsed };
}

/** Applies a previewed revision; the hosted route answers 409 when it moved. */
export async function confirmCloudPluginMarketplace(
  marketplaceId: string,
  expectedRevision: string,
  credentialContext?: CanopyCloudCredentialContext,
): Promise<CloudMarketplaceSync> {
  const payload = await marketplaceRequest(
    `/${encodeURIComponent(marketplaceId)}/sync`,
    { confirm: true, expectedRevision },
    credentialContext,
  );
  const parsed = isRecord(payload) ? readSync(payload.sync) : null;
  if (parsed === null) throw invalid();
  return parsed;
}

/** One file of a desktop plugin upload; content only for what the cloud lacks. */
export interface DesktopPluginUploadFile {
  /** Relative to the plugin root. */
  path: string;
  sha256: string;
  /** Base64. */
  content?: string;
}

export interface DesktopPluginUpload {
  pluginKey: string;
  /** Its local marketplace; a same-named plugin from another is refused. */
  source: { id: string; label: string };
  files: readonly DesktopPluginUploadFile[];
}

/**
 * Of these hashes, the ones this desktop must send content for: any its own
 * cloud marketplace does not already reference (CAN-6176 PR 9a).
 */
export async function missingDesktopPluginBlobs(
  hashes: readonly string[],
  credentialContext: CanopyCloudCredentialContext,
): Promise<string[]> {
  const payload = await requestCanopyCloudJson<unknown>(
    `${MARKETPLACES_PATH}/desktop/blobs/missing`,
    {
      method: 'POST',
      body: JSON.stringify({ hashes }),
      credentialContext,
    },
  );
  const missing = isRecord(payload) ? payload.missing : undefined;
  if (!isStringList(missing)) throw invalid();
  return missing;
}

/**
 * Adds or replaces one plugin in this desktop's private cloud marketplace.
 * The cloud builds it the way it builds a synced plugin, so hooks, MCP and
 * LSP configs are dropped there too. 409 when sent-by-hash content is not
 * held or another change landed first; 413 over the limits.
 */
export async function uploadDesktopPlugin(
  upload: DesktopPluginUpload,
  credentialContext: CanopyCloudCredentialContext,
): Promise<{
  marketplaceId: string;
  pluginKey: string;
  contentHash: string | null;
}> {
  const payload = await requestCanopyCloudJson<unknown>(
    `${MARKETPLACES_PATH}/desktop/plugins`,
    {
      method: 'POST',
      body: JSON.stringify(upload),
      credentialContext,
      timeoutMs: DESKTOP_PLUGIN_UPLOAD_TIMEOUT_MS,
    },
  );
  if (!isRecord(payload)) throw invalid();
  const { marketplaceId, pluginKey, contentHash } = payload;
  if (
    typeof marketplaceId !== 'string' ||
    typeof pluginKey !== 'string' ||
    (contentHash !== null && typeof contentHash !== 'string')
  )
    throw invalid();
  return { marketplaceId, pluginKey, contentHash };
}
