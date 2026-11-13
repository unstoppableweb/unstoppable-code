import {
  CanopyCloudClientError,
  requestCanopyCloudJson,
  resolveCanopyCloudCredentialContext,
} from './client';

const MARKETPLACES_PATH = '/api/v1/plugin-marketplaces';

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

const invalid = (): CanopyCloudClientError =>
  new CanopyCloudClientError(
    'invalid-response',
    'Invalid plugin marketplace response.',
  );

async function marketplaceRequest(
  path: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const credentials = await resolveCanopyCloudCredentialContext();
  if (!credentials.apiKey)
    throw new CanopyCloudClientError(
      'missing-api-key',
      'Sign in to add plugins to the cloud.',
    );
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
): Promise<{ marketplaceId: string; sync: CloudMarketplaceSync }> {
  const payload = await marketplaceRequest('', { source });
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
): Promise<CloudMarketplaceSync> {
  const payload = await marketplaceRequest(
    `/${encodeURIComponent(marketplaceId)}/sync`,
    { confirm: true, expectedRevision },
  );
  const parsed = isRecord(payload) ? readSync(payload.sync) : null;
  if (parsed === null) throw invalid();
  return parsed;
}
