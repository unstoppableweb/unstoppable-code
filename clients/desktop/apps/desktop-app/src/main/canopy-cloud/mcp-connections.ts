import { AccountMcpConnectionError } from '@canopy/execution-engine/types/mcp-servers';
import { forgetAccountMcpServerAccounts } from '../mcp/account-mcp-server-accounts';
import {
  ACCOUNT_MCP_CLIENT_CREDENTIALS_REQUIRED,
  ACCOUNT_MCP_SIGN_IN_UNAVAILABLE,
  ACCOUNT_MCP_CONNECTION_EDIT_CAPABILITY,
  ACCOUNT_MCP_TOOLS_REAUTH_REQUIRED,
  isAccountMcpSignInPath,
} from '@canopy/protocol/mcp-servers';
import { accountMcpConnectionUnusableReason } from './mcp-connection-usable';
import { createHash } from 'node:crypto';
import {
  assertCanopyCloudCapability,
  CanopyCloudClientError,
  requestCanopyCloudJson,
  resolveCanopyCloudCredentialContext,
  type CanopyCloudCredentialContext,
} from './client';

import type {
  AccountMcpConnection,
  AccountMcpUpstreamTool,
  StartAccountMcpConnectionRequest,
  StartAccountMcpConnectionResponse,
  UpdateAccountMcpConnectionRequest,
} from '@canopy/execution-engine/types/mcp-servers';
export type { AccountMcpConnection } from '@canopy/execution-engine/types/mcp-servers';
import { openExternalUrl } from '../mcp/oauth-client';
import {
  matchAccountMcpConnection,
  type AccountMcpConnectionMatchTarget,
} from '@canopy/desktop-shared/lib/effective-plugin-selections';

export type AccountMcpConnectionTarget = AccountMcpConnectionMatchTarget;

let generation = 0;
let cache:
  | { owner: string; expiresAt: number; rows: AccountMcpConnection[] }
  | undefined;
let pending:
  | { owner: string; promise: Promise<AccountMcpConnection[]> }
  | undefined;

export function invalidateAccountMcpConnections(): void {
  generation += 1;
  cache = undefined;
  pending = undefined;
}

/**
 * After an account is added, signed in, disconnected, renamed, made the
 * default or removed: drops the cached list, and the record of which account
 * each bound server name stands for, since that can change; its approvals
 * name none until the next bind records it again (CAN-6228). A plain list
 * refresh keeps the record.
 */
export function accountMcpConnectionsChanged(): void {
  invalidateAccountMcpConnections();
  forgetAccountMcpServerAccounts();
}

const CONNECTIONS_PATH = '/api/v1/mcp-connections';

async function connectionRequest(
  path: string,
  init: RequestInit = {},
  boundCredentials?: CanopyCloudCredentialContext,
  editing = false,
): Promise<unknown> {
  const credentials =
    boundCredentials ?? (await resolveCanopyCloudCredentialContext());
  if (!credentials.apiKey)
    throw new CanopyCloudClientError(
      'missing-api-key',
      'Sign in to use account MCP connections.',
    );
  await assertCanopyCloudCapability(
    'mcp-connections-v1',
    credentials,
    init.signal ?? undefined,
  );
  if (editing)
    await assertCanopyCloudCapability(
      ACCOUNT_MCP_CONNECTION_EDIT_CAPABILITY,
      credentials,
      init.signal ?? undefined,
    );
  const payload = await requestCanopyCloudJson<unknown>(
    `${CONNECTIONS_PATH}${path}`,
    {
      ...init,
      credentialContext: credentials,
    },
  );
  const current = await resolveCanopyCloudCredentialContext();
  if (
    current.apiKey !== credentials.apiKey ||
    current.baseUrl !== credentials.baseUrl
  )
    throw new AccountMcpConnectionError('account-changed');
  return payload;
}

function readConnection(payload: unknown): AccountMcpConnection {
  if (
    !payload ||
    typeof payload !== 'object' ||
    !('connection' in payload) ||
    !isConnection(payload.connection)
  )
    throw new CanopyCloudClientError(
      'invalid-response',
      'Invalid account MCP connection response.',
    );
  return projectConnection(payload.connection);
}

/** Only the public fields; never forward additional server payloads. */
function projectConnection(row: AccountMcpConnection): AccountMcpConnection {
  return {
    id: row.id,
    serverKey: row.serverKey,
    configId: row.configId,
    displayName: row.displayName,
    status: row.status,
    routeId: row.routeId,
    enabledTools: row.enabledTools,
    kind: row.kind,
    ...(row.authMode ? { authMode: row.authMode } : {}),
    ...(typeof row.upstreamHost === 'string' && row.upstreamHost
      ? { upstreamHost: row.upstreamHost }
      : {}),
    ...(typeof row.hasExtraHeaders === 'boolean'
      ? { hasExtraHeaders: row.hasExtraHeaders }
      : {}),
    ...(typeof row.enabled === 'boolean' ? { enabled: row.enabled } : {}),
    // Several accounts per connector (CAN-6226); absent from older clouds.
    ...(typeof row.label === 'string' && row.label ? { label: row.label } : {}),
    ...(typeof row.isDefault === 'boolean' ? { isDefault: row.isDefault } : {}),
  };
}

export async function startAccountMcpConnection(
  request: StartAccountMcpConnectionRequest,
): Promise<StartAccountMcpConnectionResponse> {
  // Bind the secret-bearing request to the account the caller captured it
  // under before anything leaves the process: resolve once, refuse a mismatch,
  // and send with exactly that credential context.
  const { expectedAccountId, browser, ...body } = request;
  const credentials = await resolveCanopyCloudCredentialContext();
  if (
    expectedAccountId !== undefined &&
    credentials.account?.id !== expectedAccountId
  )
    throw new AccountMcpConnectionError('account-changed');
  let payload: unknown;
  try {
    payload = await connectionRequest(
      '',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      credentials,
    );
  } catch (error) {
    // The server cannot register a client on its own; the caller collects the
    // user's own OAuth app. An older cloud sends `registration_unavailable`
    // without the setup the prompt shows.
    if (
      error instanceof CanopyCloudClientError &&
      (error.serverCode === ACCOUNT_MCP_CLIENT_CREDENTIALS_REQUIRED ||
        error.serverCode === 'registration_unavailable')
    )
      throw new AccountMcpConnectionError(
        'oauth-client-required',
        undefined,
        error.serverClientSetup ? { clientSetup: error.serverClientSetup } : {},
      );
    if (
      error instanceof CanopyCloudClientError &&
      error.serverCode === 'connection_limit_reached'
    )
      throw new AccountMcpConnectionError('connection-limit-reached');
    if (
      error instanceof CanopyCloudClientError &&
      error.serverCode === 'invalid_headers'
    )
      throw new AccountMcpConnectionError(
        'invalid-headers',
        error.serverHeader,
      );
    // Every other refusal the cloud names reaches the renderer by its code,
    // which it words in plain copy. `sign_in_unavailable` also says whether
    // the server signs in when added to this device instead.
    if (error instanceof CanopyCloudClientError && error.serverCode)
      throw new AccountMcpConnectionError('connect-refused', undefined, {
        serverCode: error.serverCode,
        ...(error.serverCode === ACCOUNT_MCP_SIGN_IN_UNAVAILABLE
          ? { desktopSignIn: error.serverDesktopSignIn === true }
          : {}),
      });
    throw error;
  }
  accountMcpConnectionsChanged();
  if (
    payload &&
    typeof payload === 'object' &&
    'authorizationUrl' in payload &&
    typeof payload.authorizationUrl === 'string'
  ) {
    const url = new URL(payload.authorizationUrl);
    if (url.protocol !== 'https:' || url.username || url.password)
      throw new CanopyCloudClientError(
        'invalid-response',
        'Invalid account authorization URL.',
      );
    // The callback needs the browser signed in as this account, so open the
    // cloud's sign-in page through an auth link minted for the account the
    // start ran under; it sends that account on to the provider. An older
    // cloud names no sign-in page, and a browser that could not be opened at
    // all still gets the provider's page directly.
    const signInPath =
      'signInPath' in payload && isAccountMcpSignInPath(payload.signInPath)
        ? payload.signInPath
        : null;
    if (browser === 'embedded') {
      let embeddedUrl: string | null = null;
      if (signInPath !== null) {
        const { mintAuthenticatedCloudPageUrl } =
          await import('./authenticated-cloud-page');
        embeddedUrl = await mintAuthenticatedCloudPageUrl(
          signInPath,
          credentials,
        );
        if (embeddedUrl === null) {
          // A signed-out fallback must satisfy the same origin and scheme
          // restrictions as a minted page, even with a malformed cloud base.
          try {
            const base = new URL(credentials.baseUrl);
            const page = new URL(signInPath, base);
            if (
              (page.protocol === 'https:' || page.protocol === 'http:') &&
              !page.username &&
              !page.password &&
              page.origin === base.origin
            )
              embeddedUrl = page.toString();
          } catch {
            // Invalid configuration cannot supply a trusted page; use the
            // already validated provider URL below.
          }
        }
      }
      // Minting is asynchronous: refuse to return an old account's consume
      // URL if the credential changed after the connection request completed.
      const current = await resolveCanopyCloudCredentialContext();
      if (
        current.apiKey !== credentials.apiKey ||
        current.baseUrl !== credentials.baseUrl ||
        current.account?.id !== credentials.account?.id
      )
        throw new AccountMcpConnectionError('account-changed');
      return {
        authorizationUrl: url.toString(),
        embeddedUrl: embeddedUrl ?? url.toString(),
      };
    }
    let opened = false;
    if (signInPath !== null) {
      const { openAuthenticatedCloudPage } =
        await import('./authenticated-cloud-page');
      opened = await openAuthenticatedCloudPage(signInPath, {
        credentialContext: credentials,
      });
    }
    if (!opened) await openExternalUrl(url.toString());
    return { authorizationUrl: url.toString() };
  }
  return { connection: readConnection(payload) };
}

export async function getAccountMcpConnection(
  id: string,
  signal?: AbortSignal,
  boundCredentials?: CanopyCloudCredentialContext,
): Promise<AccountMcpConnection> {
  return readConnection(
    await connectionRequest(
      `/${encodeURIComponent(id)}`,
      signal ? { signal } : {},
      boundCredentials,
    ),
  );
}

const SIGN_IN_ERROR_CODE = /^[a-z0-9_-]{1,64}$/i;

/**
 * The code a pending connection's last browser sign-in failed with. A
 * provider that answers the callback with `error` (the user denied consent,
 * a misconfigured client) leaves the connection PENDING and records the
 * mapped code (`access_denied`, `oauth_error`) in `lastError`; a start clears
 * it, so a code seen while awaiting belongs to this sign-in.
 */
function pendingSignInError(payload: unknown): string | null {
  if (
    !payload ||
    typeof payload !== 'object' ||
    !('connection' in payload) ||
    !payload.connection ||
    typeof payload.connection !== 'object' ||
    !('status' in payload.connection) ||
    payload.connection.status !== 'PENDING' ||
    !('lastError' in payload.connection)
  )
    return null;
  const code = payload.connection.lastError;
  return typeof code === 'string' && SIGN_IN_ERROR_CODE.test(code)
    ? code
    : null;
}

export async function disconnectAccountMcpConnection(
  id: string,
): Promise<void> {
  await connectionRequest(`/${encodeURIComponent(id)}`, { method: 'DELETE' });
  accountMcpConnectionsChanged();
}

export async function setAccountMcpConnectionTools(
  id: string,
  tools: string[] | null,
): Promise<AccountMcpConnection> {
  const connection = readConnection(
    await connectionRequest(`/${encodeURIComponent(id)}/tools`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabledTools: tools }),
    }),
  );
  invalidateAccountMcpConnections();
  return connection;
}

/** Whether the signed-in cloud edits and removes connections. */
export async function accountMcpConnectionsEditable(): Promise<boolean> {
  try {
    const credentials = await resolveCanopyCloudCredentialContext();
    if (!credentials.apiKey) return false;
    await assertCanopyCloudCapability(
      ACCOUNT_MCP_CONNECTION_EDIT_CAPABILITY,
      credentials,
    );
    return true;
  } catch {
    return false;
  }
}

function editError(error: unknown): unknown {
  if (error instanceof CanopyCloudClientError) {
    if (error.code === 'unsupported-capability')
      return new AccountMcpConnectionError('edit-unavailable');
    if (error.serverCode === 'invalid_headers')
      return new AccountMcpConnectionError(
        'invalid-headers',
        error.serverHeader,
      );
    if (error.serverCode === 'invalid_url')
      return new AccountMcpConnectionError('invalid-url');
    if (error.serverCode === 'connection_limit_reached')
      return new AccountMcpConnectionError('connection-limit-reached');
  }
  return error;
}

export async function updateAccountMcpConnection(
  id: string,
  request: UpdateAccountMcpConnectionRequest,
): Promise<AccountMcpConnection> {
  // A new token or header set is a secret: send it only under the account
  // the editor captured it for, exactly like a start.
  const { expectedAccountId, ...body } = request;
  const credentials = await resolveCanopyCloudCredentialContext();
  if (
    expectedAccountId !== undefined &&
    credentials.account?.id !== expectedAccountId
  )
    throw new AccountMcpConnectionError('account-changed');
  let payload: unknown;
  try {
    payload = await connectionRequest(
      `/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      credentials,
      true,
    );
  } catch (error) {
    throw editError(error);
  } finally {
    accountMcpConnectionsChanged();
  }
  return readConnection(payload);
}

/**
 * Deletes the connection outright. A cloud without removal only disconnects
 * it, which wipes its sign-in but keeps the row. A connection the cloud no
 * longer has counts as removed, so a retried removal finishes.
 * `unlessConnected` is a sign-in's own cleanup, sent to its own route
 * (`POST …/{id}/abandon`): the cloud keeps a connection that connected
 * meanwhile, and a server without the route answers 404 and changes nothing.
 * Both answer `removed: false`; no request an older server could read as a
 * removal or a disconnect is ever sent for it.
 */
export async function removeAccountMcpConnection(
  id: string,
  { unlessConnected = false }: { unlessConnected?: boolean } = {},
): Promise<{ removed: boolean }> {
  if (unlessConnected) return abandonAccountMcpConnection(id);
  const editable = await accountMcpConnectionsEditable();
  try {
    await connectionRequest(
      `/${encodeURIComponent(id)}${editable ? '?remove=1' : ''}`,
      { method: 'DELETE' },
    );
  } catch (error) {
    if (
      error instanceof CanopyCloudClientError &&
      error.status === 404 &&
      error.serverCode === 'not_found'
    )
      return { removed: true };
    throw error;
  } finally {
    accountMcpConnectionsChanged();
  }
  return { removed: editable };
}

async function abandonAccountMcpConnection(
  id: string,
): Promise<{ removed: boolean }> {
  try {
    await connectionRequest(`/${encodeURIComponent(id)}/abandon`, {
      method: 'POST',
    });
    return { removed: true };
  } catch (error) {
    if (error instanceof CanopyCloudClientError) {
      // The connection is already gone.
      if (error.status === 404 && error.serverCode === 'not_found')
        return { removed: true };
      // It connected meanwhile, or the server has no such route.
      if (error.serverCode === 'connection_connected' || error.status === 404)
        return { removed: false };
    }
    throw error;
  } finally {
    accountMcpConnectionsChanged();
  }
}

function readUpstreamTool(value: unknown): AccountMcpUpstreamTool | null {
  if (
    !value ||
    typeof value !== 'object' ||
    !('name' in value) ||
    typeof value.name !== 'string' ||
    !value.name
  )
    return null;
  return {
    name: value.name,
    ...('title' in value && typeof value.title === 'string'
      ? { title: value.title }
      : {}),
    ...('description' in value && typeof value.description === 'string'
      ? { description: value.description }
      : {}),
  };
}

export async function listAccountMcpUpstreamTools(
  id: string,
): Promise<AccountMcpUpstreamTool[]> {
  let payload: unknown;
  try {
    payload = await connectionRequest(`/${encodeURIComponent(id)}/tools`);
  } catch (error) {
    // IPC keeps only the message, so name the one outcome the UI acts on.
    if (
      error instanceof CanopyCloudClientError &&
      error.serverCode === ACCOUNT_MCP_TOOLS_REAUTH_REQUIRED
    )
      throw new Error(ACCOUNT_MCP_TOOLS_REAUTH_REQUIRED);
    throw error;
  }
  if (
    !payload ||
    typeof payload !== 'object' ||
    !('tools' in payload) ||
    !Array.isArray(payload.tools)
  )
    throw new CanopyCloudClientError(
      'invalid-response',
      'Invalid account MCP tools response.',
    );
  return payload.tools
    .map(readUpstreamTool)
    .filter((tool): tool is AccountMcpUpstreamTool => tool !== null);
}

export async function awaitAccountMcpConnection(
  id: string,
  { timeoutMs = 10 * 60_000 }: { timeoutMs?: number } = {},
): Promise<AccountMcpConnection> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error('Invalid connection timeout.');
  const controller = new AbortController();
  const timeout = setTimeout((): void => controller.abort(), timeoutMs);
  try {
    const owner = await resolveCanopyCloudCredentialContext();
    for (;;) {
      controller.signal.throwIfAborted();
      const current = await resolveCanopyCloudCredentialContext();
      if (current.apiKey !== owner.apiKey || current.baseUrl !== owner.baseUrl)
        throw new AccountMcpConnectionError('account-changed');
      // The request itself is bound to the owner captured above, so a switch
      // between the check and the send surfaces as account-changed rather
      // than a poll issued under the new account.
      const payload = await connectionRequest(
        `/${encodeURIComponent(id)}`,
        { signal: controller.signal },
        owner,
      );
      const connection = readConnection(payload);
      controller.signal.throwIfAborted();
      // A refused sign-in stays PENDING; its code ends the wait at once, so
      // the caller words it instead of waiting out the timeout (CAN-4451).
      const signInError = pendingSignInError(payload);
      if (signInError !== null)
        throw new AccountMcpConnectionError('connect-refused', undefined, {
          serverCode: signInError,
        });
      if (connection.status !== 'PENDING') {
        accountMcpConnectionsChanged();
        return connection;
      }
      await new Promise<void>((resolve): void => {
        const done = (): void => {
          clearTimeout(timer);
          controller.signal.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, 3_000);
        controller.signal.addEventListener('abort', done, { once: true });
      });
    }
  } catch (error) {
    if (controller.signal.aborted)
      throw new AccountMcpConnectionError('connection-timeout');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function isConnection(value: unknown): value is AccountMcpConnection {
  if (typeof value !== 'object' || value === null) return false;
  return (
    'id' in value &&
    typeof value.id === 'string' &&
    'serverKey' in value &&
    typeof value.serverKey === 'string' &&
    'configId' in value &&
    typeof value.configId === 'string' &&
    'displayName' in value &&
    typeof value.displayName === 'string' &&
    'routeId' in value &&
    typeof value.routeId === 'string' &&
    /^[a-zA-Z0-9_-]+$/.test(value.routeId) &&
    'status' in value &&
    ['PENDING', 'CONNECTED', 'REAUTH_REQUIRED', 'DISCONNECTED'].includes(
      String(value.status),
    ) &&
    'kind' in value &&
    (value.kind === 'CURATED' || value.kind === 'CUSTOM') &&
    (!('authMode' in value) ||
      value.authMode === undefined ||
      value.authMode === 'OAUTH' ||
      value.authMode === 'BEARER' ||
      value.authMode === 'NONE') &&
    (!('upstreamHost' in value) ||
      value.upstreamHost === undefined ||
      typeof value.upstreamHost === 'string') &&
    (!('hasExtraHeaders' in value) ||
      value.hasExtraHeaders === undefined ||
      typeof value.hasExtraHeaders === 'boolean') &&
    (!('enabled' in value) ||
      value.enabled === undefined ||
      typeof value.enabled === 'boolean') &&
    'enabledTools' in value &&
    (value.enabledTools === null ||
      (Array.isArray(value.enabledTools) &&
        value.enabledTools.every(
          (tool: unknown): boolean => typeof tool === 'string',
        )))
  );
}

/** Credentials are checked even on cache hits; a sign-out cannot reuse rows. */
export async function listAccountMcpConnections(): Promise<
  AccountMcpConnection[]
> {
  const credentials = await resolveCanopyCloudCredentialContext();
  if (!credentials.apiKey)
    throw new CanopyCloudClientError(
      'missing-api-key',
      'Sign in to use account MCP connections.',
    );
  const owner = createHash('sha256')
    .update(JSON.stringify([credentials.baseUrl, credentials.apiKey]))
    .digest('hex');
  if (cache && cache.owner === owner && cache.expiresAt > Date.now())
    return structuredClone(cache.rows);
  if (pending?.owner === owner) return structuredClone(await pending.promise);
  const startedGeneration = generation;
  const promise = (async (): Promise<AccountMcpConnection[]> => {
    await assertCanopyCloudCapability('mcp-connections-v1', credentials);
    const payload = await requestCanopyCloudJson<unknown>(
      '/api/v1/mcp-connections',
      { credentialContext: credentials },
    );
    if (
      !payload ||
      typeof payload !== 'object' ||
      !('connections' in payload) ||
      !Array.isArray(payload.connections) ||
      !payload.connections.every(isConnection)
    ) {
      throw new CanopyCloudClientError(
        'invalid-response',
        'Invalid account MCP connections response.',
      );
    }
    const current = await resolveCanopyCloudCredentialContext();
    if (
      current.apiKey !== credentials.apiKey ||
      current.baseUrl !== credentials.baseUrl
    )
      throw new AccountMcpConnectionError('account-changed');
    const rows = payload.connections.map(projectConnection);
    if (generation === startedGeneration)
      cache = { owner, rows, expiresAt: Date.now() + 60_000 };
    return rows;
  })();
  pending = { owner, promise };
  try {
    return structuredClone(await promise);
  } finally {
    if (pending?.promise === promise) pending = undefined;
  }
}

/** Explicit ids are authoritative. Curated keys never match names or URLs. */
function matchConnection(
  rows: AccountMcpConnection[],
  target: AccountMcpConnectionTarget,
): AccountMcpConnection | undefined {
  return matchAccountMcpConnection(rows, target);
}

export async function findAccountMcpConnection(
  target: AccountMcpConnectionTarget,
): Promise<AccountMcpConnection | undefined> {
  return matchConnection(await listAccountMcpConnections(), target);
}

/** Preflight reads only the current account's fresh cache; never starts a request. */
export async function getCachedAccountMcpConnection(
  target: AccountMcpConnectionTarget,
): Promise<AccountMcpConnection | undefined> {
  if (!cache || cache.expiresAt <= Date.now()) return undefined;
  try {
    const credentials = await resolveCanopyCloudCredentialContext();
    const owner = createHash('sha256')
      .update(JSON.stringify([credentials.baseUrl, credentials.apiKey]))
      .digest('hex');
    return cache?.owner === owner
      ? structuredClone(matchConnection(cache.rows, target))
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The cloud's MCP proxy base (`<cloud>`, without a trailing slash) once the
 * signed-in cloud offers the proxy, for a route the caller already knows,
 * such as a shared connection's (CAN-6246).
 */
export async function accountMcpProxyBaseUrl(): Promise<string> {
  const credentials = await resolveCanopyCloudCredentialContext();
  await assertCanopyCloudCapability('mcp-proxy-v1', credentials);
  return credentials.baseUrl.replace(/\/$/, '');
}

export async function resolveAccountMcpProxyTarget(
  target: AccountMcpConnectionTarget,
): Promise<{ connection: AccountMcpConnection; upstreamUrl: string }> {
  const connection = await findAccountMcpConnection(target);
  if (!connection)
    throw new Error('Account MCP connection missing or ambiguous.');
  const unusable = accountMcpConnectionUnusableReason(connection);
  if (unusable !== null) throw new Error(unusable);
  const credentials = await resolveCanopyCloudCredentialContext();
  await assertCanopyCloudCapability('mcp-proxy-v1', credentials);
  return {
    connection,
    upstreamUrl: `${credentials.baseUrl.replace(/\/$/, '')}/api/v1/mcp-proxy/${encodeURIComponent(connection.routeId)}`,
  };
}
