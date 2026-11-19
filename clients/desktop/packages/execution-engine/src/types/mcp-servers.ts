import type {
  McpRemovalCandidatesResult,
  InspectMcpRemovalRequest,
  InspectMcpRemovalResult,
  ForceMcpRemovalRequest,
  ForceMcpRemovalResult,
} from '@canopy/protocol/mcp-removal';
import type {
  AccountMcpClientSetup,
  AccountMcpOAuthClientCredentials,
} from '@canopy/protocol/mcp-servers';
// ---------------------------------------------------------------------------
// MCP Server types.
//
// The neutral MCP server catalog shapes (definitions, config variants,
// index/summary rows, refs, health results, auth status, and the
// detected-server descriptor) live in `@canopy/protocol/mcp-servers` so the
// web app and the desktop app agree on the same data model. They are
// re-exported below so existing imports of
// `@canopy/execution-engine/types/mcp-servers` keep working unchanged.
//
// Do NOT redefine those shapes locally — the protocol package is the single
// source of truth. What remains declared here is desktop-local by design:
// on-disk file envelopes and their trust-boundary validators/normalizers, the
// tools cache, proxy state, OAuth login request/response types, the
// selections-coupled `ListDetectedMcpServers*` payloads, and the preload
// `McpServersAPI` surface.
// ---------------------------------------------------------------------------

import type {
  AccountMcpConnection,
  AccountMcpUpstreamTool,
  DetectedMcpServerInfo,
  InstallMcpServerForHarnessesRequest,
  McpHttpAuthHandler,
  McpServerHarnessInstalls,
  RetryMcpServerHarnessInstallRequest,
  McpOAuthConfigData,
  McpServerConfigData,
  McpServerConfigSummary,
  McpServerData,
  McpServerDefinitionData,
  McpServerHealthCheckResult,
  McpServerIndexEntry,
  McpServerRef,
  McpServerStatusEntry,
  McpServerTestConnectionResult,
  ProviderConnectorListResult,
  ProviderConnectorProvider,
  UpdateAccountMcpConnectionRequest as ProtocolUpdateAccountMcpConnectionRequest,
} from '@canopy/protocol/mcp-servers';
import type { CuratedMcpServerListResponse } from '@canopy/protocol/mcp-catalog';
import type { SecretValueInput } from './stored-secrets';
import type { ChatTabPluginSelections } from '../execution-types';

export type {
  AccountMcpConnection,
  AccountMcpUpstreamTool,
  DetectedMcpServerInfo,
  McpHttpAuthHandler,
  McpHttpAuthPreference,
  McpHttpAuthTarget,
  McpOAuthConfigData,
  McpPluginHttpAuthTarget,
  McpServerAuthStatus,
  McpServerConfigData,
  McpServerConfigSummary,
  McpServerConnectionStatus,
  McpServerCuratedMetadata,
  McpServerData,
  McpServerDefinitionData,
  McpServerHealthCheckResult,
  McpServerIndexEntry,
  McpServerStatusEntry,
  McpServerRef,
  McpServerTestConnectionResult,
  McpServerType,
  McpStandaloneHttpAuthTarget,
  ProviderAlternateRoute,
  ProviderConnectorEntry,
  ProviderConnectorListResult,
  ProviderConnectorProvider,
  ProviderConnectorRow,
  ProviderConnectorUnavailableReason,
} from '@canopy/protocol/mcp-servers';

/** File envelope for mcp-servers/index.json */
export interface McpServersIndexFile {
  version: 1;
  servers: McpServerIndexEntry[];
  accountConnectionsAvailable?: boolean;
  accountConnectionsUnavailableReason?: 'sign-in-required' | 'unavailable';
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isUnknownRecord(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

function isMcpServerConfigSummary(
  value: unknown,
): value is McpServerConfigSummary {
  return (
    isUnknownRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.enabled === 'boolean'
  );
}

function isMcpServerIndexEntry(value: unknown): value is McpServerIndexEntry {
  return (
    isUnknownRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.description === 'string' &&
    (value.type === 'command' || value.type === 'http') &&
    Array.isArray(value.configs) &&
    value.configs.every(isMcpServerConfigSummary) &&
    (value.logoUrl === undefined || typeof value.logoUrl === 'string') &&
    (value.curatedKey === undefined || typeof value.curatedKey === 'string') &&
    typeof value.updatedAt === 'string'
  );
}

export function isMcpServersIndexFile(
  value: unknown,
): value is McpServersIndexFile {
  return (
    isUnknownRecord(value) &&
    value.version === 1 &&
    Array.isArray(value.servers) &&
    value.servers.every(isMcpServerIndexEntry)
  );
}

/** File envelope for mcp-servers/server-<id>.json */
export interface McpServerFile {
  version: 1;
  server: McpServerData;
}

/**
 * MCP server shapes as they cross IPC to the renderer (CAN-4411). Header, env
 * var and extra-header values, `authToken` and `oauth.clientSecret` are
 * stored-secret values when non-empty; saves accept text or those values.
 */
export type McpServerDataView = McpServerData<SecretValueInput>;
export type McpServerDefinitionView = McpServerDefinitionData<SecretValueInput>;
export type McpServerConfigView = McpServerConfigData<SecretValueInput>;
export type McpOAuthConfigView = McpOAuthConfigData<SecretValueInput>;
export interface McpServerFileView {
  version: 1;
  server: McpServerDataView;
}

export function normalizeHttpAuthHandler(
  value: unknown,
): McpHttpAuthHandler | undefined {
  if (value === undefined) return undefined;
  if (value === 'canopy' || value === 'provider' || value === 'account')
    return value;
  throw new Error(
    'HTTP auth handler must be "canopy", "provider", or "account".',
  );
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean';
}

function isOptionalStringArray(value: unknown): value is string[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every((entry) => typeof entry === 'string'))
  );
}

function isMcpOAuthConfigData(value: unknown): value is McpOAuthConfigData {
  return (
    isUnknownRecord(value) &&
    isOptionalString(value.clientId) &&
    isOptionalString(value.clientSecret) &&
    (value.callbackPort === undefined ||
      (typeof value.callbackPort === 'number' &&
        Number.isInteger(value.callbackPort))) &&
    (value.vendorRegisteredRedirect === undefined ||
      typeof value.vendorRegisteredRedirect === 'boolean') &&
    isOptionalString(value.authorizationUrl) &&
    isOptionalString(value.tokenUrl) &&
    isOptionalStringArray(value.scopes) &&
    isOptionalString(value.audience) &&
    isOptionalBoolean(value.usePkce)
  );
}

type PersistedMcpServerDefinitionData = Omit<
  McpServerDefinitionData,
  'curated' | 'httpAuthHandler'
> & {
  curated?: unknown;
  httpAuthHandler?: unknown;
};

type PersistedMcpServerFile = Omit<McpServerFile, 'server'> & {
  server: Omit<McpServerData, 'definition'> & {
    definition: PersistedMcpServerDefinitionData;
  };
};

function isPersistedMcpServerDefinitionData(
  value: unknown,
): value is PersistedMcpServerDefinitionData {
  return (
    isUnknownRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.description === 'string' &&
    (value.type === 'command' || value.type === 'http') &&
    isOptionalString(value.command) &&
    isOptionalStringArray(value.args) &&
    isOptionalString(value.url) &&
    (value.headers === undefined || isStringRecord(value.headers)) &&
    (value.oauth === undefined || isMcpOAuthConfigData(value.oauth)) &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string'
  );
}

function isMcpServerConfigData(value: unknown): value is McpServerConfigData {
  return (
    isUnknownRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.description === 'string' &&
    typeof value.enabled === 'boolean' &&
    isStringRecord(value.envVars) &&
    Array.isArray(value.extraArgs) &&
    value.extraArgs.every((entry) => typeof entry === 'string') &&
    isStringRecord(value.extraHeaders) &&
    isOptionalString(value.authToken) &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string'
  );
}

function isPersistedMcpServerFile(
  value: unknown,
): value is PersistedMcpServerFile {
  return (
    isUnknownRecord(value) &&
    value.version === 1 &&
    isUnknownRecord(value.server) &&
    isPersistedMcpServerDefinitionData(value.server.definition) &&
    Array.isArray(value.server.configs) &&
    value.server.configs.every(isMcpServerConfigData)
  );
}

export function normalizeCuratedMetadata(
  definition: Pick<McpServerDefinitionData, 'type'> & { curated?: unknown },
): McpServerDefinitionData['curated'] {
  if (definition.curated === undefined) return undefined;
  if (definition.type !== 'http') {
    throw new Error('Curated metadata is only supported for HTTP MCP servers.');
  }
  const raw: unknown = definition.curated;
  if (!isUnknownRecord(raw)) {
    throw new Error('Curated MCP server metadata must be an object.');
  }
  if (typeof raw.key !== 'string' || raw.key.trim().length === 0) {
    throw new Error('Curated MCP server key is required.');
  }
  const optional = (key: string): string | undefined => {
    const value = raw[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string') {
      throw new Error(`Curated MCP server ${key} must be a string.`);
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };
  const logoUrl = optional('logoUrl');
  const docsUrl = optional('docsUrl');
  const supportUrl = optional('supportUrl');
  const privacyPolicyUrl = optional('privacyPolicyUrl');
  const authorName = optional('authorName');
  const authorUrl = optional('authorUrl');
  if (
    raw.requiresProviderAuth !== undefined &&
    typeof raw.requiresProviderAuth !== 'boolean'
  ) {
    throw new Error(
      'Curated MCP server requiresProviderAuth must be a boolean.',
    );
  }
  return {
    key: raw.key.trim(),
    ...(logoUrl ? { logoUrl } : {}),
    ...(docsUrl ? { docsUrl } : {}),
    ...(supportUrl ? { supportUrl } : {}),
    ...(privacyPolicyUrl ? { privacyPolicyUrl } : {}),
    ...(authorName ? { authorName } : {}),
    ...(authorUrl ? { authorUrl } : {}),
    ...(typeof raw.requiresProviderAuth === 'boolean'
      ? { requiresProviderAuth: raw.requiresProviderAuth }
      : {}),
  };
}

/** Normalize version-1 optional fields at the persisted JSON trust boundary. */
export function normalizeMcpServerFile(
  value: unknown,
  id = 'unknown',
): McpServerFile {
  if (!isPersistedMcpServerFile(value)) {
    throw new Error(`Invalid MCP server file for ${id}`);
  }
  const definition = value.server.definition;
  const curated = normalizeCuratedMetadata(definition);
  const httpAuthHandler = normalizeHttpAuthHandler(definition.httpAuthHandler);
  if (definition.type !== 'http' && httpAuthHandler !== undefined) {
    throw new Error('HTTP auth handler is only supported for HTTP servers.');
  }
  const normalizedDefinition: McpServerDefinitionData = {
    ...definition,
    curated,
    httpAuthHandler,
  };
  return {
    version: 1,
    server: { ...value.server, definition: normalizedDefinition },
  };
}

/**
 * A single cached `tools/list` result for one (serverId, configId) pair.
 * `tools` are the advertised tool names; `discoveredAt` is the ISO-8601 time
 * the list was fetched.
 */
export interface McpServerToolsCacheEntry {
  tools: string[];
  discoveredAt: string;
  /** Hash of the server/config inputs that produced this inventory. */
  sourceFingerprint?: string;
}

/**
 * Persisted cache of discovered MCP tools.
 *
 * Keyed per **(serverId, configId)** — not per server — because all configs of
 * an HTTP server share one endpoint URL, but the visible `tools/list` is
 * fetched with that config's merged headers/token and can legitimately differ
 * per config (tokens are stored per `(serverId, configId)`). The composite key
 * format is `` `${serverId}:${configId}` ``.
 *
 * File version stays `1`; all consumers normalize on read.
 */
export interface McpServerToolsCacheFile {
  version: 1;
  /** Keyed by `` `${serverId}:${configId}` ``. */
  entries: Record<string, McpServerToolsCacheEntry>;
}

/** Request payload for `mcp-servers:list-detected`. */
export interface ListDetectedMcpServersRequest {
  selections: ChatTabPluginSelections;
}

/** Response payload for `mcp-servers:list-detected`. */
export interface ListDetectedMcpServersResponse {
  servers: DetectedMcpServerInfo[];
  /** Non-fatal warnings encountered while resolving selections. */
  warnings: string[];
}

/** Plugin-declared MCP server target for `mcp-servers:start-oauth-login`. */
export interface StartMcpOAuthPluginTarget {
  marketplaceId: string;
  pluginName: string;
  serverName: string;
  provider?: 'claude' | 'codex';
}

/** Request payload for `mcp-servers:start-oauth-login`. */
export interface StartMcpOAuthLoginRequest {
  serverId?: string;
  configId?: string;
  plugin?: StartMcpOAuthPluginTarget;
  /** When true, discard any existing token and force a fresh browser login. */
  force?: boolean;
  /** Return the validated sign-in URL for the marketplace's browser panel. */
  browser?: 'external' | 'embedded';
}

/**
 * Response payload for `mcp-servers:start-oauth-login`.
 *
 * - `started`: the main process opened (or asked the renderer to open) the
 *   `authorizationUrl`; the renderer should reflect a pending state.
 * - `completed`: a valid token already existed, the flow finished
 *   synchronously, or discovery found the server needs no sign-in; no browser
 *   interaction is required. Without a `flowId` it never claims connection
 *   health, so read the refreshed status.
 */
export interface StartMcpOAuthLoginResponse {
  status: 'started' | 'completed';
  authorizationUrl?: string;
  /** Opaque identifier used to cancel a pending sign-in. */
  flowId?: string;
}

/** Request payload for `mcp-servers:clear-oauth-token`. */
export interface ClearMcpOAuthTokenRequest {
  serverId: string;
  configId: string;
}

/**
 * Runtime status of the local HTTP MCP proxy.
 *
 * - `stopped`: proxy is not currently listening
 * - `running`: proxy is listening on `port`
 * - `error`: last start/port-update attempt failed; `error` carries the message
 */
export type McpProxyStatus = 'stopped' | 'running' | 'error';

/** Renderer-facing snapshot of the local MCP HTTP proxy state. */
export interface McpProxyState {
  port: number;
  status: McpProxyStatus;
  /** True when app setup has locked the proxy to a dev-runtime port. */
  portLocked?: boolean;
  /** ISO timestamp of the most recent state change. */
  refreshedAt?: string;
  /** Last error message when `status === 'error'`. */
  error?: string;
}

/** Non-secret account connection metadata exposed to settings. */
export type AccountMcpConnectionSummary = Omit<
  AccountMcpConnection,
  'routeId' | 'enabledTools'
>;

/** Account binding belongs to the index, separate from the server definition. */
export interface SaveMcpServerRequest extends McpServerDataView {
  accountConnectionId?: string;
  /** Explicit editor choice; omitted saves preserve index-owned routing. */
  accountRouting?: 'clear';
}

/** Preload API surface for MCP servers */
export type StartAccountMcpConnectionRequest = (
  | {
      serverKey: string;
      endpointUrl?: string;
      customUrl?: never;
      displayName?: never;
      headers?: never;
    }
  | {
      customUrl: string;
      /** Name for a new custom connection; the cloud falls back to its host. */
      displayName?: string;
      /** Extra upstream headers the cloud stores with the new connection. */
      headers?: Record<string, SecretValueInput>;
      serverKey?: never;
      endpointUrl?: never;
    }
) & {
  configId: string;
  /** The name of an account the person adds beside another (CAN-6226). */
  label?: string;
  bearerToken?: SecretValueInput;
  /**
   * The device server whose stored secrets `headers` and `bearerToken` keep
   * by reference. Main sends them only to that server's own URL origin.
   */
  secretSource?: AccountMcpSecretSource;
  oauthClient?: AccountMcpOAuthClientCredentials;
  /**
   * The cloud account id the caller was signed in as when it captured any
   * credential in this request. Main refuses to send the request under a
   * different account, so a sign-in change between the UI and the send never
   * stores a secret under the wrong owner. Never forwarded to the cloud.
   */
  expectedAccountId?: string;
  /** Local desktop route only; omit entirely for external and tunneled starts. */
  browser?: 'embedded';
};
export type StartAccountMcpConnectionResponse =
  | { connection: AccountMcpConnection }
  | {
      authorizationUrl: string;
      /** Transient one-shot page; never persist or log this URL. */
      embeddedUrl?: string;
    };

/** Names the device server a cloud request keeps stored secrets from. */
export interface AccountMcpSecretSource {
  serverId: string;
}

/** `mcp-servers:update-account`; edits a cloud connection in place. */
export type UpdateAccountMcpConnectionRequest = Omit<
  ProtocolUpdateAccountMcpConnectionRequest,
  'headers' | 'bearerToken'
> & {
  headers?: Record<string, SecretValueInput>;
  bearerToken?: SecretValueInput | null;
  /** See {@link StartAccountMcpConnectionRequest.expectedAccountId}. */
  expectedAccountId?: string;
  /**
   * The device server whose stored secrets the request keeps by reference;
   * main sends them only to the connection that server is bound to.
   */
  secretSource?: AccountMcpSecretSource;
};

/** `mcp-servers:remove-account` answer. */
export interface RemoveAccountMcpConnectionResponse {
  /** False when the cloud predates removal and only disconnected it. */
  removed: boolean;
}

/**
 * `mcp-servers:rewrite-refs`: points every desktop reference to one MCP
 * server at another. A `from` ref without `configId` matches every config of
 * that server.
 */
export interface RewriteMcpServerRefsRequest {
  from: Array<{ serverId: string; configId?: string }>;
  to: McpServerRef;
  /**
   * Removes this device server once its references move, but only while its
   * file still serializes (`stableStringify`) to `fingerprint`. The check, the
   * rewrite and the removal run as one step, serialized with saves and deletes
   * of that server.
   */
  retire?: { serverId: string; fingerprint: string };
}

export interface RewriteMcpServerRefsResponse {
  globalDefaults: boolean;
  workspaces: number;
  chats: number;
  /** Set when `retire` was requested; `changed` means the server was kept. */
  retired?: 'removed' | 'changed';
}

export type AccountMcpConnectionErrorCode =
  | 'connection-timeout'
  | 'account-changed'
  | 'oauth-client-required'
  | 'connection-limit-reached'
  | 'invalid-headers'
  | 'invalid-url'
  | 'edit-unavailable'
  /** The cloud refused a start with a code; see `serverCode`. */
  | 'connect-refused';

/** What a failure carries beyond its code, forwarded over IPC. */
export interface AccountMcpConnectionErrorDetails {
  /**
   * For `oauth-client-required`: what the user's own OAuth app needs, when
   * the cloud said (older clouds send only the code).
   */
  clientSetup?: AccountMcpClientSetup;
  /** For `connect-refused`: the cloud's code, named in plain copy by the renderer. */
  serverCode?: string;
  /**
   * For a `sign_in_unavailable` refusal: whether the server signs in when
   * added to this device instead.
   */
  desktopSignIn?: boolean;
}

const ACCOUNT_MCP_CONNECTION_ERROR_MESSAGES: Record<
  AccountMcpConnectionErrorCode,
  string
> = {
  'connection-timeout': 'Connection timed out. Connect again.',
  'account-changed': 'Account changed. Connect again.',
  'oauth-client-required':
    'This server needs its OAuth client ID. Connect again.',
  'connection-limit-reached':
    'Your cloud account has reached its server limit. Disconnect one to add another.',
  'invalid-headers':
    "Your cloud account couldn't store this server's headers. Check them and try again.",
  'invalid-url':
    "Your cloud account can't reach this URL. Use a public HTTPS address.",
  'edit-unavailable':
    "Your cloud account can't edit servers yet. Try again after it updates.",
  'connect-refused': 'Could not connect. Try again.',
};

export class AccountMcpConnectionError extends Error {
  constructor(
    readonly code: AccountMcpConnectionErrorCode,
    /** The header the cloud refused, for `invalid-headers`. */
    readonly header?: string,
    readonly details: AccountMcpConnectionErrorDetails = {},
  ) {
    super(
      code === 'invalid-headers' && header
        ? `Your cloud account couldn't store the ${header} header. Check it and try again.`
        : ACCOUNT_MCP_CONNECTION_ERROR_MESSAGES[code],
    );
    this.name = 'AccountMcpConnectionError';
  }
}

export interface AccountMcpConnectionFailure {
  error: {
    code: AccountMcpConnectionErrorCode;
    header?: string;
  } & AccountMcpConnectionErrorDetails;
}

export interface McpServersAPI {
  removalCandidates(): Promise<McpRemovalCandidatesResult>;
  inspectRemoval(
    request: InspectMcpRemovalRequest,
  ): Promise<InspectMcpRemovalResult>;
  forceRemoval(request: ForceMcpRemovalRequest): Promise<ForceMcpRemovalResult>;
  startAccountConnection(
    request: StartAccountMcpConnectionRequest,
  ): Promise<StartAccountMcpConnectionResponse | AccountMcpConnectionFailure>;
  getAccountConnection(id: string): Promise<AccountMcpConnection>;
  /** Edits a cloud connection in place; needs `mcp-connections-v2`. */
  updateAccountConnection(
    id: string,
    request: UpdateAccountMcpConnectionRequest,
  ): Promise<AccountMcpConnection | AccountMcpConnectionFailure>;
  /**
   * Removes a cloud connection; an older cloud only disconnects it. With
   * `unlessConnected` (a sign-in's own cleanup), a connection that connected
   * meanwhile is kept and an older cloud is left alone; both answer
   * `removed: false`.
   */
  removeAccountConnection(
    id: string,
    options?: { unlessConnected?: boolean },
  ): Promise<RemoveAccountMcpConnectionResponse>;
  /** Points desktop defaults and saved chats at another server. */
  rewriteServerRefs(
    request: RewriteMcpServerRefsRequest,
  ): Promise<RewriteMcpServerRefsResponse>;
  disconnectAccountConnection(id: string): Promise<void>;
  setAccountConnectionTools(
    id: string,
    tools: string[] | null,
  ): Promise<AccountMcpConnection>;
  /** Every tool the connection's server offers, before its tool policy applies. */
  listAccountConnectionUpstreamTools(
    id: string,
  ): Promise<AccountMcpUpstreamTool[]>;
  awaitAccountConnection(
    id: string,
    options?: { timeoutMs?: number },
  ): Promise<AccountMcpConnection | AccountMcpConnectionFailure>;
  loadIndex(): Promise<McpServersIndexFile>;
  loadServer(id: string): Promise<McpServerFileView>;
  saveServer(server: SaveMcpServerRequest): Promise<McpServerFileView>;
  listAccountConnections(): Promise<AccountMcpConnectionSummary[]>;
  deleteServer(id: string): Promise<void>;
  checkHealth(
    serverId: string,
    configId?: string,
  ): Promise<McpServerHealthCheckResult>;
  testConnection(
    serverId: string,
    configId?: string,
  ): Promise<McpServerTestConnectionResult>;
  /**
   * Resolve a chat's plugin selections into a flat list of MCP servers with
   * their current auth/connection status.
   */
  listDetected(
    request: ListDetectedMcpServersRequest,
  ): Promise<ListDetectedMcpServersResponse>;
  /**
   * Begin (or complete) an OAuth Authorization Code flow for a standalone
   * HTTP MCP server config that has an `oauth` block.
   */
  cancelOAuthLogin(flowId: string): Promise<void>;
  startOAuthLogin(
    request: StartMcpOAuthLoginRequest,
  ): Promise<StartMcpOAuthLoginResponse>;
  /**
   * Remove any stored OAuth tokens for a standalone HTTP MCP server config.
   * Resolves once the tokens have been cleared from the keychain/disk.
   */
  clearOAuthToken(request: ClearMcpOAuthTokenRequest): Promise<void>;
  /** Read the current MCP proxy state. */
  getProxyState(): Promise<McpProxyState>;
  /**
   * Persist the proxy port preference and apply it to the running proxy.
   * Returns the resulting state.
   */
  applyProxyPort(port: number): Promise<McpProxyState>;
  /** Subscribe to proxy state broadcasts. Returns an unsubscribe function. */
  onAuthChanged?(callback: () => void): () => void;
  onProxyStatus(callback: (state: McpProxyState) => void): () => void;
  /**
   * List the provider's own MCP connectors (Gmail, Drive, Calendar and the
   * rest). These authenticate against the provider's OAuth client, so Canopy
   * reports their state but never holds their credentials.
   */
  listProviderConnectors(): Promise<ProviderConnectorListResult[]>;
  /**
   * Open the provider's connector management page in the user's browser. The
   * provider CLI can read connectors but cannot create them, so linking one is
   * always a hosted flow.
   */
  openProviderConnectorSettings(request: {
    provider: ProviderConnectorProvider;
    installUrl?: string;
  }): Promise<void>;
  /**
   * Read the curated MCP server catalog for the active brand, served from the
   * desktop main process's cache (fetched from Canopy Web on demand).
   */
  listCurated(): Promise<CuratedMcpServerListResponse>;
  /**
   * Force a re-fetch of the curated MCP server catalog from Canopy Web,
   * bypassing any cached copy, and return the refreshed payload.
   */
  refreshCurated(): Promise<CuratedMcpServerListResponse>;
  /** Fetch an untrusted image through the main-process public-network cache. */
  resolveRemoteImage?(
    url: string,
    /** New Customize's resolution; main also requires the experiment on. */
    options?: { readonly enhanced?: boolean },
  ): Promise<string | null>;
  /**
   * Read the current connection status for every configured MCP server — one
   * entry per server, with the per-config auth axis nested.
   */
  listStatus(): Promise<McpServerStatusEntry[]>;
  /**
   * Read the cached `tools/list` result for a server (optionally scoped to a
   * specific config). Resolves `null` when nothing has been discovered yet.
   */
  getTools(
    serverId: string,
    configId?: string,
  ): Promise<McpServerToolsCacheEntry | null>;
  /**
   * One Add for every harness (CAN-6815): stage a saved server for the
   * set-up harnesses that can load it and record each result. Resolves
   * `null` when none can. Absent on hosts that cannot install per harness.
   */
  installForHarnesses?(
    request: InstallMcpServerForHarnessesRequest,
  ): Promise<McpServerHarnessInstalls | null>;
  /** Stage one harness of an earlier install again (CAN-6815). */
  retryHarnessInstall?(
    request: RetryMcpServerHarnessInstallRequest,
  ): Promise<McpServerHarnessInstalls>;
}
