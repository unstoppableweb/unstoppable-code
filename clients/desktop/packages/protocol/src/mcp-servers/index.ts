// ---------------------------------------------------------------------------
// Neutral MCP server catalog shapes.
//
// Browser-safe descriptions of locally configured standalone MCP servers:
// definitions, config variants, index/summary rows, refs, health/connection
// results, and the detected-server descriptor used by activity/workspace
// surfaces. Shared by the desktop renderer and the web app (portal surfaces).
//
// Deliberately NOT here (they stay in
// `packages/execution-engine/src/types/mcp-servers.ts`):
//   - on-disk file envelopes (`McpServersIndexFile`, `McpServerFile`) and
//     their trust-boundary validators/normalizers
//   - the tools cache, proxy state, and OAuth login request/response types
//   - `ListDetectedMcpServersRequest/Response` (coupled to
//     `ChatTabPluginSelections`)
//   - the preload `McpServersAPI` surface
//
// This module must remain pure: no Node, Electron, React, Prisma, Next.js, or
// app imports. It runs in the renderer, the main process, and the web app.
// ---------------------------------------------------------------------------

import type { SelectionRefOwner } from '../plugins/selection-ref-owner';
import type { HarnessCompatibility } from '../plugins/harness-compatibility';
import type { McpServerHarnessInstalls } from './harness-installs';

export * from './harness-installs';

/** Server transport type */
export type McpServerType = 'command' | 'http';

/**
 * Identifies how authentication for an HTTP MCP server is handled.
 *
 * - `canopy`: Canopy routes HTTP MCP traffic through the local 127.0.0.1
 *   proxy and owns OAuth/token injection for the configured server.
 * - `provider`: The agent provider (Claude or Codex) receives the original
 *   HTTP MCP server definition and is responsible for auth itself.
 *
 * - `account`: Reserved for account-scoped vault/proxy authentication.
 *   Local routing is not supported yet.
 *
 * Command/stdIO MCP servers are unaffected by this preference.
 */
export type McpHttpAuthHandler = 'canopy' | 'provider' | 'account';

/** Ownership scope of an MCP server connection. */
export type McpServerScope = 'device' | 'account';

/**
 * Stable identity for a standalone HTTP MCP server target referenced by a
 * preference override.
 */
export interface McpStandaloneHttpAuthTarget {
  kind: 'standalone';
  serverId: string;
  configId: string;
}

/**
 * Stable identity for a plugin-declared HTTP MCP server target referenced by
 * a preference override.
 */
export interface McpPluginHttpAuthTarget {
  kind: 'plugin';
  marketplaceId: string;
  pluginName: string;
  serverName: string;
}

/**
 * Discriminated union covering every HTTP MCP server target that can carry a
 * per-chat handler override. Command/stdIO MCP servers are intentionally
 * absent — they cannot be HTTP-auth-handled.
 */
export type McpHttpAuthTarget =
  | McpStandaloneHttpAuthTarget
  | McpPluginHttpAuthTarget;

/**
 * A persisted per-chat preference: for a given target, which side (canopy vs.
 * provider) should handle HTTP MCP auth?
 */
export interface McpHttpAuthPreference {
  target: McpHttpAuthTarget;
  handler: McpHttpAuthHandler;
}

/**
 * OAuth configuration attached to a standalone HTTP MCP server definition.
 *
 * When present, the canopy main process can run an OAuth Authorization Code
 * flow to obtain access tokens for the server and proxy authenticated MCP
 * traffic through the local HTTP proxy on `mcpProxyPort`.
 */
/**
 * MCP server shapes take the type of their secret-valued fields as `S`. Hosts
 * hold plaintext (`string`); the desktop renderer receives stored-secret
 * references in their place (CAN-4411).
 */
export interface McpOAuthConfigData<S = string> {
  /**
   * Optional pre-registered client id. When omitted, Canopy attempts MCP OAuth
   * discovery and dynamic client registration before asking the user for
   * manual client information.
   */
  clientId?: string;
  clientSecret?: S;
  /** Optional fixed loopback port pre-registered for this public client. */
  callbackPort?: number;
  /**
   * The redirect URI is registered by the vendor, not by Canopy.
   *
   * Set only when a definition is instantiated from a curated catalog entry
   * that pins a callback port, meaning the OAuth client belongs to the vendor
   * and its redirect allowlist is fixed — Canopy has to send the shape already
   * on file rather than its own.
   *
   * Absent for anything a user configured themselves, which is the point: a
   * hand-authored server with a custom `callbackPort` registered Canopy's
   * historic `http://127.0.0.1:<port>/oauth/callback` with its provider, and
   * inferring "vendor" from the mere presence of a port would silently switch
   * that flow to a URI the provider has never seen.
   */
  vendorRegisteredRedirect?: boolean;
  /** Optional manual authorization endpoint override. */
  authorizationUrl?: string;
  /** Optional manual token endpoint override. */
  tokenUrl?: string;
  /** Optional manual scope override. Discovery is used when omitted. */
  scopes?: string[];
  audience?: string;
  /**
   * Preserved for older saved configs. Canopy treats missing values as true
   * and always enables PKCE for newly saved desktop OAuth configs.
   */
  usePkce?: boolean;
}

/**
 * Non-secret catalog metadata copied onto a standalone server definition when
 * it originates from (or is linked to) a curated catalog entry. The `key`
 * mirrors {@link import('../mcp-catalog').CuratedMcpServerEntry.key}
 * and is the join key used to reconcile a local copy against the served
 * catalog. All display links are optional and carry no credentials.
 */
export interface McpServerCuratedMetadata {
  /** Catalog key of the originating curated entry. */
  key: string;
  /** Logo URL for the picker / table. */
  logoUrl?: string;
  /** Documentation URL. */
  docsUrl?: string;
  /** Support URL. */
  supportUrl?: string;
  /** Privacy-policy URL. */
  privacyPolicyUrl?: string;
  /** Author / vendor display name. */
  authorName?: string;
  /** Author / vendor URL. */
  authorUrl?: string;
  /** True when the catalog requires provider-managed confidential OAuth. */
  requiresProviderAuth?: boolean;
}

/** Base definition of an MCP server (the "what") */
export interface McpServerDefinitionData<S = string> {
  id: string;
  name: string;
  description: string;
  type: McpServerType;
  /** Command to execute (for type='command') */
  command?: string;
  /** Base arguments (for type='command') */
  args?: string[];
  /** Server URL (for type='http') */
  url?: string;
  /** Base HTTP headers */
  headers?: Record<string, S>;
  /**
   * Optional OAuth configuration. Only meaningful when `type === 'http'`; if
   * set, the standalone HTTP MCP server is proxied through the local OAuth
   * proxy and authenticated against the configured authorization server.
   */
  oauth?: McpOAuthConfigData<S>;
  /**
   * Optional curated-catalog metadata. Present when this definition was
   * created from (or linked to) a curated catalog entry; carries the join
   * `key` plus non-secret display links. Absent for hand-entered servers.
   */
  curated?: McpServerCuratedMetadata;
  /**
   * Optional server-level HTTP auth handler preference. Only meaningful when
   * `type === 'http'`. When set, it establishes the `'server'`-sourced default
   * for how this server's HTTP MCP traffic is authenticated (Canopy proxy vs.
   * provider), overridable per chat. Command/stdIO servers ignore this field.
   */
  httpAuthHandler?: McpHttpAuthHandler;
  createdAt: string;
  updatedAt: string;
}

/** A configuration variant for a server definition (the "how") */
export interface McpServerConfigData<S = string> {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  /** Environment variables to set when spawning */
  envVars: Record<string, S>;
  /** Additional CLI args appended to definition args */
  extraArgs: string[];
  /** Additional HTTP headers merged with definition headers */
  extraHeaders: Record<string, S>;
  /** Bearer token (stored separately from headers for UX) */
  authToken?: S;
  createdAt: string;
  updatedAt: string;
}

/** Full server with its configurations */
export interface McpServerData<S = string> {
  definition: McpServerDefinitionData<S>;
  configs: McpServerConfigData<S>[];
}

/** Config summary included in the index for table display */
export interface McpServerConfigSummary {
  id: string;
  name: string;
  enabled: boolean;
}

/** Index entry for mcp-servers/index.json */
export interface McpServerIndexEntry {
  harnessCompatibility?: HarnessCompatibility;
  /**
   * The harnesses one Add installed this server for (CAN-6815). Ephemeral:
   * desktop main reads it from its own record file and adds it to the rows it
   * serves; it is never written to the index.
   */
  harnessInstalls?: McpServerHarnessInstalls;
  /** Ephemeral account catalog data, never persisted on the device. */
  accountConnection?: AccountMcpConnection;
  deviceCopies?: McpServerIndexEntry[];
  /** Absent on legacy device-local entries. */
  scope?: McpServerScope;
  authHandler?: McpHttpAuthHandler;
  /** Non-secret account connection identifier. */
  accountConnectionId?: string;
  id: string;
  name: string;
  description: string;
  type: McpServerType;
  configs: McpServerConfigSummary[];
  /**
   * Optional logo URL (mirrored from the curated catalog metadata) so the
   * table and picker can render a logo without loading the full server file.
   */
  logoUrl?: string;
  /**
   * Optional curated catalog key (mirrored from
   * {@link McpServerCuratedMetadata.key}) so list surfaces can flag curated
   * servers without loading the full server file.
   */
  curatedKey?: string;
  /** Hostname of an HTTP server's URL; never a path, query, or credentials. */
  urlHost?: string;
  /** Scheme of that URL without the colon (`https`); cloud needs `https`. */
  urlScheme?: string;
  /**
   * When this device copy was first saved, in UTC (CAN-5239). Edits keep it;
   * absent on older entries and whenever the stored value is not a valid date.
   */
  createdAt?: string;
  updatedAt: string;
}

/** Reference to an MCP server configuration within a bundle or chat selection */
export interface McpServerRef {
  serverId: string;
  configId: string;
  /**
   * An organization's connection (CAN-6235). Absent is the person's own,
   * which is what every ref saved before the field existed means.
   */
  owner?: SelectionRefOwner;
}

/** Health check result for an MCP server */
export interface McpServerHealthCheckResult {
  serverId: string;
  configId?: string;
  status: 'healthy' | 'unhealthy' | 'needs_auth';
  statusCode?: number;
  message: string;
  responseTime?: number;
  checkedAt: string;
}

/** Full connection test result for an MCP server */
export interface McpServerTestConnectionResult {
  serverId: string;
  configId?: string;
  success: boolean;
  message: string;
  error?: string;
  /** Initialize succeeded, so a later tools/list failure is not an outage. */
  endpointReachable?: boolean;
  tools?: string[];
  responseTime?: number;
}

/**
 * Coarse OAuth/auth state for an MCP server resolved from the user's chat
 * plugin selections. The renderer surfaces these states in the MCP servers
 * activity/workspace card.
 *
 * - `unsupported`: server transport does not support OAuth (e.g. `command`).
 * - `not_configured`: no OAuth config attached to the definition.
 * - `not_connected`: OAuth configured but no token has been acquired yet.
 * - `connected`: a valid (non-expired) token is on file.
 * - `expired`: the access token has expired; `canRefresh` reports renewal availability.
 * - `error`: authorization requires attention; see `lastError`.
 */
export type McpServerAuthStatus =
  | 'unsupported'
  | 'not_configured'
  | 'not_connected'
  | 'connected'
  | 'expired'
  | 'error';

/**
 * Connection status shown in the MCP Servers tab's **Status** column.
 *
 * This is a DISTINCT axis from {@link McpServerAuthStatus}, which reflects only
 * OAuth token state and never reachability. Connection status combines
 * reachability (per-endpoint) with auth (per-config):
 *
 * - `connected`     — endpoint reachable and every relevant config authenticated.
 * - `auth_required` — endpoint reachable but at least one config needs auth.
 * - `unreachable`   — endpoint could not be reached.
 * - `unknown`       — not yet checked (or the check is inconclusive).
 */
export type McpServerConnectionStatus =
  | 'connected'
  | 'auth_required'
  | 'unreachable'
  | 'unknown';

/**
 * Per-server connection-status entry for the MCP Servers tab's Status column.
 *
 * There is exactly **one entry per server**, with the per-config auth axis
 * nested (each config authenticates independently). Reachability is
 * per-endpoint — all HTTP configs of a server share the same URL — while auth
 * is per-config.
 *
 * `handler` / `handlerSource` are **HTTP-only** and omitted for
 * `command`/stdIO servers (no proxy handler applies); those configs carry
 * `authStatus: 'unsupported'` and never reach `auth_required`.
 * **Provider-managed HTTP servers** (`handler === 'provider'`) are
 * reachability-only and never `auth_required`.
 *
 * Within the tab there are no chat selections, so at runtime `handlerSource`
 * is `'server'` or `'default'` here, never `'override'` — the type still
 * permits `'override'` so the shape can be reused elsewhere.
 */
export interface McpServerStatusEntry {
  serverId: string;
  transport: 'http' | 'command';
  connectionStatus: McpServerConnectionStatus;
  reachability: 'reachable' | 'unreachable' | 'unknown';
  /** HTTP-only: effective proxy handler; omitted for command servers. */
  handler?: McpHttpAuthHandler;
  /** HTTP-only: where {@link handler} came from; omitted for command servers. */
  handlerSource?: 'default' | 'server' | 'override';
  /** Per-config auth axis; each config authenticates independently. */
  configs: Array<{
    configId: string;
    authStatus: McpServerAuthStatus;
    /** An expired access token has a stored renewal credential. */
    canRefresh?: boolean;
    expiresAt?: string;
    /** Revision of the saved authorization error; safe to compare across retries. */
    authErrorRevision?: string;
    lastError?: string;
  }>;
  /** ISO-8601 timestamp of the most recent status check. */
  lastCheckedAt?: string;
}

/**
 * A provider-managed MCP connector — authenticated against the provider's own
 * OAuth client, not Canopy's. Canopy can list these and point the user at the
 * place to link them, but owns none of their credentials.
 */
export interface ProviderConnectorEntry {
  /** Fully-qualified name as the provider knows it, e.g. `claude.ai Gmail`. */
  name: string;
  /** The provider prefix stripped, for display. */
  displayName: string;
  connected: boolean;
  /** Raw provider-reported status, shown verbatim when not connected. */
  status: string;
  /**
   * Per-connector link page, when the provider exposes one. Codex publishes an
   * install URL per app; Claude only has a single account-wide page, so its
   * entries omit this and the section falls back to that.
   */
  installUrl?: string;
}

/** Which agent provider owns a connector's OAuth. */
export type ProviderConnectorProvider = 'claude' | 'codex';

/**
 * Where each provider manages its connectors. Neither CLI can create a
 * connector, so linking always ends on the provider's site. Codex publishes a
 * page per app and normally supplies its own `installUrl`; this is the
 * fallback for an app the directory does not describe. Keyed by provider
 * because a single fallback sent every Codex connect to Claude's page.
 */
const PROVIDER_CONNECTOR_MANAGE_URLS: Readonly<
  Record<ProviderConnectorProvider, string>
> = {
  claude: 'https://claude.ai/customize/connectors',
  codex: 'https://chatgpt.com/apps',
};

/**
 * The page a connector is linked or managed on: its own link page, or the
 * provider's connector directory. Null for an unknown provider or anything
 * but an https page, since neither input is trusted: `installUrl` comes from
 * a provider cache Canopy neither writes nor validates, and both cross a
 * process or network boundary before they get here.
 */
export function providerConnectorSettingsUrl(request: {
  readonly provider: unknown;
  readonly installUrl?: unknown;
}): string | null {
  const { provider, installUrl } = request;
  if (provider !== 'claude' && provider !== 'codex') return null;
  const target = installUrl ?? PROVIDER_CONNECTOR_MANAGE_URLS[provider];
  if (typeof target !== 'string' || !URL.canParse(target)) return null;
  const parsed = new URL(target);
  return parsed.protocol === 'https:' ? parsed.toString() : null;
}

/** One connector, with each provider's view of it. */
export interface ProviderConnectorRow {
  displayName: string;
  /** Catalog key, carried so the row can resolve a bundled brand mark. */
  curatedKey?: string;
  providers: Array<{
    provider: ProviderConnectorProvider;
    connected: boolean;
    /**
     * The read for this provider has not answered yet.
     *
     * Distinct from `connected: false`, which is an answer. Without it a row
     * rendered before the read lands asserts "not linked" about a connector
     * that may well be linked — the claim that made an already-connected
     * capability flash as unset.
     */
    pending?: boolean;
    /** Set when the provider already serves this outside its connector system. */
    alternateRoute?: string;
    /** Set when `connected` comes from a snapshot Canopy cannot refresh. */
    staleSince?: string;
    /** Present when the provider could not be read at all. */
    unavailable?: string;
    /** Per-app link page when the provider publishes one. */
    installUrl?: string;
  }>;
}

/** Why a provider's connector list could not be read, when it could not. */
export type ProviderConnectorUnavailableReason =
  /** An API key outranks the account login, so the provider disables connectors. */
  | 'api-key-precedence'
  /** The provider CLI failed or timed out. */
  | 'cli-failed'
  /** The provider has not cached its app directory yet — sign in and retry. */
  | 'no-directory-cache';

/** A capability the provider serves outside its account-connector system. */
export interface ProviderAlternateRoute {
  /** Normalized capability name, matched against the advertised catalog. */
  normalizedName: string;
  /** The server as the provider names it, shown so the user can find it. */
  serverName: string;
}

export interface ProviderConnectorListResult {
  provider: ProviderConnectorProvider;
  connectors: ProviderConnectorEntry[];
  /**
   * When the provider's own snapshot of connector state was taken, if it
   * reports from a cache Canopy cannot refresh.
   *
   * Codex reads an on-disk app directory that only Codex writes: neither
   * `apps/list` (unimplemented by the bundled app-server) nor `thread/start`
   * refreshes it. So a not-linked answer may simply predate the user linking,
   * and the UI must say so rather than assert a state it cannot verify.
   */
  snapshotAt?: string;
  /**
   * Capabilities the provider already serves by some route other than an
   * account connector — a plugin-provided MCP server, say.
   *
   * Without these a user whose Slack works through a Claude plugin is told to
   * connect Slack, which is accurate about the connector and wrong about
   * whether they have Slack.
   */
  alternateRoutes?: ProviderAlternateRoute[];
  unavailableReason?: ProviderConnectorUnavailableReason;
  detail?: string;
}

/**
 * Descriptor for an MCP server detected from a chat's plugin selections,
 * including its origin (standalone server, plugin, or bundle) and current
 * auth status. Used by the MCP servers activity/workspace card to render
 * an actionable list of servers without exposing raw selection refs.
 */
export interface DetectedMcpServerInfo {
  scope?: McpServerScope;
  authHandler?: McpHttpAuthHandler;
  accountConnectionId?: string;
  /** Stable composite key the renderer can use as a list key. */
  key: string;
  source: 'standalone' | 'collection' | 'bundle' | 'plugin';
  /** Underlying MCP server name (the prefixed proxy name when applicable). */
  serverName: string;
  /** User-facing name. Strips known proxy prefixes for display. */
  displayName: string;
  description?: string;
  type: McpServerType;
  /** HTTP URL when the server is HTTP-typed; absent for command servers. */
  url?: string;
  /** Standalone server id when `source === 'standalone'`. */
  serverId?: string;
  /** Standalone server config id when `source === 'standalone'`. */
  configId?: string;
  /** Standalone config display name when `source === 'standalone'`. */
  configName?: string;
  /** Collection id when `source === 'collection'`. */
  collectionId?: string;
  /** @deprecated Legacy Collection id when `source === 'bundle'`. */
  bundleId?: string;
  /** Plugin marketplace id when `source === 'plugin'`. */
  marketplaceId?: string;
  /** Plugin name when `source === 'plugin'`. */
  pluginName?: string;
  /** Server name as declared inside the plugin manifest. */
  pluginServerName?: string;
  /** Native facet that owns this declaration; omitted for legacy selections. */
  pluginProvider?: 'claude' | 'codex';
  /**
   * Curated catalog key when the underlying standalone definition is linked
   * to a curated catalog entry. Absent for plugin-sourced and uncurated
   * servers.
   */
  curatedKey?: string;
  enabled: boolean;
  authStatus: McpServerAuthStatus;
  /** Renewal is available without starting another sign-in. */
  canRefresh?: boolean;
  /** Access-token expiration, used to keep an open display current. */
  expiresAt?: string;
  /** Localized label for `authStatus` (rendered in the badge). */
  authStatusLabel: string;
  /** Whether a "Connect" / "Reconnect" action should be enabled. */
  canConnect: boolean;
  /** Optional override label for the connect action button. */
  connectLabel?: string;
  /** Most recent error string, when `authStatus === 'error'`. */
  lastError?: string;
  /** Revision of the stored OAuth error, used to distinguish login attempts. */
  authErrorRevision?: string;
  /**
   * Effective HTTP MCP auth handler for this server. Computed by the backend
   * inventory by combining the global default with any per-server override
   * stored on the chat's plugin selections. Only meaningful for HTTP servers.
   */
  httpAuthHandler?: McpHttpAuthHandler;
  /**
   * Indicates where the effective `httpAuthHandler` came from:
   * - `'default'`  — the global default preference.
   * - `'server'`   — a server-level handler set on the server definition.
   * - `'override'` — a per-chat, per-server override on the chat's selections.
   *
   * Lets the UI render an "overridden" / "server setting" affordance without
   * re-deriving the source.
   */
  httpAuthHandlerSource?: 'default' | 'server' | 'override';
  /**
   * Whether the activity card may render a control for toggling Canopy proxy
   * routing on this server. False for transports/servers that cannot be
   * meaningfully proxied (e.g. command MCP servers).
   */
  canToggleCanopyProxy?: boolean;
  /**
   * Whether Canopy proxy routing is currently active for this server, taking
   * into account the effective handler and any other backend-side gating.
   */
  canopyProxyEnabled?: boolean;
}

export interface AccountMcpConnection {
  id: string;
  serverKey: string;
  configId: string;
  displayName: string;
  status: 'PENDING' | 'CONNECTED' | 'REAUTH_REQUIRED' | 'DISCONNECTED';
  routeId: string;
  enabledTools: string[] | null;
  kind: 'CURATED' | 'CUSTOM';
  /**
   * How the cloud authenticates upstream. A bearer connection loses its token
   * on disconnect, so reconnecting it needs a fresh token from the user.
   * Absent from older cloud releases.
   */
  authMode?: 'OAUTH' | 'BEARER' | 'NONE';
  /** The broker's last sign-in error code, or null when there is none. */
  lastError?: string | null;
  /**
   * Hostname of the upstream server; never its path, query or credentials.
   * Absent from older cloud releases.
   */
  upstreamHost?: string;
  /**
   * Whether the connection stores extra upstream headers; their names and
   * values are never returned. Absent from older cloud releases.
   */
  hasExtraHeaders?: boolean;
  /**
   * Whether chats and agents may use the connection. Turning it off keeps the
   * sign-in and tool policy. Absent from older cloud releases, which means on.
   */
  enabled?: boolean;
  /**
   * The name the person gave this account, such as its workspace. Null or
   * absent when they gave none; clients then name it from its config id.
   * Absent from older cloud releases.
   */
  label?: string | null;
  /**
   * Whether this is the person's default account for its server key: the one
   * a ref with no exact config match, or a plugin that brings the server,
   * reaches in an attended chat. Absent from older cloud releases, whose
   * clients fall back to {@link accountMcpDefaultConnection}'s rule.
   */
  isDefault?: boolean;
}

/** A broker row can remain PENDING after its authorization has ended. */
export function isAccountMcpAuthorizationPending(
  connection: Pick<AccountMcpConnection, 'status' | 'lastError'>,
): boolean {
  return (
    connection.status === 'PENDING' &&
    ![
      'access_denied',
      'oauth_error',
      'browser_account_refused',
      'account_mismatch',
      'invalid_state',
    ].includes(connection.lastError ?? '')
  );
}

/** Longest account label, in characters after trimming. */
export const ACCOUNT_MCP_LABEL_MAX_LENGTH = 80;

/**
 * Prefix of the config id minted for an account a person adds beside their
 * first one ("Add another account"). A ref with such a config id names one
 * account and resolves only to it, never to another account of the server.
 */
export const ACCOUNT_MCP_INSTANCE_CONFIG_PREFIX = 'acct-';

/** Whether `configId` names one added account (see the prefix above). */
export function isAccountMcpInstanceConfigId(configId: string): boolean {
  return (
    configId.startsWith(ACCOUNT_MCP_INSTANCE_CONFIG_PREFIX) &&
    configId.length > ACCOUNT_MCP_INSTANCE_CONFIG_PREFIX.length
  );
}

/** A fresh config id for another account of a server. */
export function newAccountMcpInstanceConfigId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(12));
  let suffix = '';
  // 256 % 36 leaves a slight bias, harmless for an id that only has to be
  // unique among one person's accounts of one server.
  for (const byte of bytes) suffix += alphabet[byte % alphabet.length];
  return `${ACCOUNT_MCP_INSTANCE_CONFIG_PREFIX}${suffix}`;
}

type AccountMcpInstanceRow = Pick<
  AccountMcpConnection,
  'serverKey' | 'configId' | 'isDefault'
>;

/**
 * The person's default account for `serverKey` among `rows`: the one the
 * cloud flags, else the `default` config, else the only one. Undefined when
 * several remain and none is flagged (an older cloud): callers then treat the
 * server as having no default rather than guess.
 */
export function accountMcpDefaultConnection<T extends AccountMcpInstanceRow>(
  rows: readonly T[],
  serverKey: string,
): T | undefined {
  const candidates = rows.filter((row) => row.serverKey === serverKey);
  return (
    candidates.find((row) => row.isDefault === true) ??
    candidates.find((row) => row.configId === 'default') ??
    (candidates.length === 1 ? candidates[0] : undefined)
  );
}

/**
 * How a ref with no exact config match is resolved. `attended` (a chat with
 * someone watching) reaches the default account. `unattended` (a scheduled or
 * background run) never picks between accounts: it reaches the only account
 * of the server, or nothing.
 */
export type AccountMcpRefResolution = 'attended' | 'unattended';

/**
 * The account a `{ serverId, configId }` ref reaches among `rows` (already
 * narrowed to the kind the caller resolves). An exact config match wins. A
 * ref to an added account (`acct-*`) reaches only that account. Otherwise
 * `attended` resolution reaches the default account and `unattended`
 * resolution the server's only account.
 */
export function resolveAccountMcpRef<T extends AccountMcpInstanceRow>(
  rows: readonly T[],
  ref: { serverId: string; configId: string },
  resolution: AccountMcpRefResolution = 'attended',
): T | undefined {
  const candidates = rows.filter((row) => row.serverKey === ref.serverId);
  const exact = candidates.find((row) => row.configId === ref.configId);
  if (exact) return exact;
  if (isAccountMcpInstanceConfigId(ref.configId)) return undefined;
  if (resolution === 'unattended')
    return candidates.length === 1 ? candidates[0] : undefined;
  return accountMcpDefaultConnection(candidates, ref.serverId);
}

/**
 * The account config a server a plugin brings asks for (CAN-6232): the one
 * account of that connector the same selection picks directly, so a project
 * or chat that chose an account reaches it through its plugins too. With no
 * direct pick, or picks of several accounts, none: the plugin's server then
 * follows {@link resolvePluginAccountMcpServer}'s fallback. Given the
 * connector's `rows`, refs that name one of them count first (CAN-6233): a
 * ref beside them that names no current account reaches nothing, so it does
 * not make the pick ambiguous.
 */
export function pluginAccountMcpConfigId(
  directRefs: readonly { serverId: string; configId: string }[],
  serverKey: string,
  rows?: readonly { serverKey: string; configId: string }[],
): string | undefined {
  const refs = directRefs.filter((ref) => ref.serverId === serverKey);
  const named = rows
    ? refs.filter((ref) =>
        rows.some(
          (row) => row.serverKey === serverKey && row.configId === ref.configId,
        ),
      )
    : [];
  const picked = new Set(
    (named.length > 0 ? named : refs).map((ref) => ref.configId),
  );
  return picked.size === 1 ? picked.values().next().value : undefined;
}

/**
 * The account a server a plugin brings reaches among `rows` (curated rows):
 * the account the selection picks for the connector directly
 * ({@link pluginAccountMcpConfigId}), resolved as that ref; otherwise the
 * default account, or in an unattended run the connector's only account.
 * A pick of an added account that is gone reaches nothing, never another.
 */
export function resolvePluginAccountMcpServer<T extends AccountMcpInstanceRow>(
  rows: readonly T[],
  serverKey: string,
  directRefs: readonly { serverId: string; configId: string }[],
  resolution: AccountMcpRefResolution = 'attended',
): T | undefined {
  const configId = pluginAccountMcpConfigId(directRefs, serverKey, rows);
  if (configId !== undefined)
    return resolveAccountMcpRef(
      rows,
      { serverId: serverKey, configId },
      resolution,
    );
  if (resolution === 'attended')
    return accountMcpDefaultConnection(rows, serverKey);
  const candidates = rows.filter((row) => row.serverKey === serverKey);
  return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * The configuration name an account connection shows. The cloud keys
 * configurations by id only (`default`, `work`), so the name is derived from
 * the id: every connection used to read "Default", which is how a Personal
 * and a Work connection to one provider became indistinguishable (REG-3033).
 */
export function accountMcpConfigName(configId: string): string {
  if (configId === 'default') return 'Default';
  const words = configId.split(/[-_\s]+/).filter((word) => word.length > 0);
  if (words.length === 0) return configId;
  return words
    .map((word, index) =>
      index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word,
    )
    .join(' ');
}

/**
 * The name one account of a connector shows (CAN-6226): the label the person
 * gave it, else its configuration's name. An added account (`acct-*`) the
 * person never named reads "Another account" rather than its minted id.
 */
export function accountMcpAccountName(
  connection: Pick<AccountMcpConnection, 'configId' | 'label'>,
): string {
  const label = connection.label?.trim();
  if (label) return label;
  return isAccountMcpInstanceConfigId(connection.configId)
    ? 'Another account'
    : accountMcpConfigName(connection.configId);
}

/**
 * Whether this is the person's default account for its connector: the
 * cloud's flag, or the `default` configuration on a cloud that sends none.
 */
export function isDefaultAccountMcpConnection(
  connection: Pick<AccountMcpConnection, 'configId' | 'isDefault'>,
): boolean {
  return connection.isDefault ?? connection.configId === 'default';
}

/** False only for a connection the user turned off. */
export function isAccountMcpConnectionEnabled(
  connection: Pick<AccountMcpConnection, 'enabled'>,
): boolean {
  return connection.enabled !== false;
}

/**
 * Advertised by clouds that accept `PATCH /mcp-connections/{id}` and remove a
 * connection outright with `DELETE /mcp-connections/{id}?remove=1`.
 */
export const ACCOUNT_MCP_CONNECTION_EDIT_CAPABILITY = 'mcp-connections-v2';

/**
 * `PATCH /mcp-connections/{id}`. Omitted fields keep their stored value.
 * `displayName`, `customUrl` and `headers` apply to custom connections only.
 * `headers` replaces every stored header, and `{}` removes them. A
 * `bearerToken` replaces the stored sign-in with that token; `null` removes
 * the token and leaves the connection needing sign-in. A `customUrl` that
 * changes the server's address removes the stored sign-in and token unless
 * the same request supplies a new `bearerToken`. The stored headers stay for
 * an address on the same origin; a new origin removes them unless the same
 * request supplies `headers`. `enabled` turns the connection on or off for
 * chats and agents and changes nothing else. `label` renames the account
 * (`null` clears the name) and `isDefault: true` makes it the person's
 * default account for its server; neither touches the sign-in.
 */
export interface UpdateAccountMcpConnectionRequest {
  displayName?: string;
  customUrl?: string;
  headers?: Record<string, string>;
  bearerToken?: string | null;
  enabled?: boolean;
  label?: string | null;
  isDefault?: true;
}

/** `PATCH /mcp-connections/{id}` answer. */
export interface UpdateAccountMcpConnectionResponse {
  connection: AccountMcpConnection;
}

/**
 * One tool an account connection's upstream advertises, listed before the
 * connection's tool policy applies so a disabled tool can be turned back on.
 */
export interface AccountMcpUpstreamTool {
  name: string;
  title?: string;
  description?: string;
  /**
   * The server's `readOnlyHint` annotation: true when it says the tool
   * changes nothing. A hint, not a guarantee; absent when not given.
   */
  readOnly?: boolean;
}

/** `GET /mcp-connections/{id}/tools`. */
export interface AccountMcpUpstreamToolsResponse {
  tools: AccountMcpUpstreamTool[];
}

/**
 * Error message a host's tool loader throws when the connection needs
 * reconnecting before its tools can be listed.
 */
export const ACCOUNT_MCP_TOOLS_REAUTH_REQUIRED = 'mcp_reauth_required';

/** User-supplied OAuth application credentials for an account connection. */
export interface AccountMcpOAuthClientCredentials {
  clientId: string;
  clientSecret?: string;
  /**
   * The token endpoint the person was shown as the client secret's
   * recipient. The cloud refuses the start when its catalog pins another.
   */
  tokenEndpoint?: string;
}

/**
 * Start refusal for a server that registers no OAuth clients itself while the
 * request supplied none. The body carries {@link AccountMcpClientSetup} as
 * `clientSetup`; a retry with `oauthClient` connects.
 */
export const ACCOUNT_MCP_CLIENT_CREDENTIALS_REQUIRED =
  'client_credentials_required';

/**
 * Start refusal for a catalog server whose authorization server lets only
 * approved apps sign in (it refused or offers no dynamic registration) when
 * no client the platform holds or the user brought before can sign in. The
 * body carries `desktopSignIn`: whether the server signs in when added to a
 * desktop device instead. Unlike {@link ACCOUNT_MCP_CLIENT_CREDENTIALS_REQUIRED}
 * it asks for no OAuth app; a client that does not know the code shows its
 * generic connect failure.
 */
export const ACCOUNT_MCP_SIGN_IN_UNAVAILABLE = 'sign_in_unavailable';

/**
 * Start refusal for a curated server with several endpoints when the request
 * named none and no stored connection keeps one; a retry with `endpointUrl`
 * connects.
 */
export const ACCOUNT_MCP_ENDPOINT_REQUIRED = 'endpoint_required';

/**
 * The cloud page that sends a signed-in browser on to a pending account
 * sign-in, refusing it for any account but the one that started it. A start
 * that needs a browser sign-in answers with `signInPath` (this path with the
 * flow's `state`) beside `authorizationUrl`, so a client that can sign the
 * browser in first (the desktop's auth link) opens it instead of the
 * provider's page. Older clouds omit `signInPath`.
 */
export const ACCOUNT_MCP_SIGN_IN_PATH = '/api/mcp-connections/authorize';

export function accountMcpSignInPath(state: string): string {
  return `${ACCOUNT_MCP_SIGN_IN_PATH}?${new URLSearchParams({ state }).toString()}`;
}

/** Whether `value` is a {@link accountMcpSignInPath} the cloud sent. */
export function isAccountMcpSignInPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 1024) return false;
  let parsed: URL;
  try {
    parsed = new URL(value, 'https://sign-in.invalid');
  } catch {
    return false;
  }
  return (
    parsed.origin === 'https://sign-in.invalid' &&
    value.startsWith(`${ACCOUNT_MCP_SIGN_IN_PATH}?`) &&
    parsed.pathname === ACCOUNT_MCP_SIGN_IN_PATH &&
    /^\?state=[^&]+$/.test(parsed.search) &&
    !parsed.hash
  );
}

/** What a connect form needs to collect the user's own OAuth app. */
export interface AccountMcpClientSetup {
  /** The redirect URI to register with the app, exactly as sign-in sends it. */
  redirectUri: string;
  /** The authorization server the app is created with. */
  issuer: string;
  /** The server takes only confidential clients, so the app needs a secret. */
  clientSecretRequired: boolean;
  /**
   * Whether the account stores a client secret for this server. A secret is
   * only sent to an authorization server the catalog pins for the entry.
   */
  clientSecretAccepted: boolean;
  /** Vendor instructions for creating the app, from the catalog. */
  docsUrl?: string;
  /**
   * The authorization server refused dynamic registration by policy: it
   * takes only apps registered with the provider. Older clouds omit it.
   */
  registrationRefused?: boolean;
}

/**
 * Where the cloud publishes the Client ID Metadata Document its broker signs
 * in with for a brand, as a path under the API base (after `/api`, or after a
 * split deployment's backend prefix). The brand is in the path, so an
 * authorization server's fetch, which carries no `Origin` or cookie, gets the
 * brand's document on any host that serves it. Authorization servers may
 * allowlist client IDs, so the path never changes.
 */
export function mcpClientMetadataDocumentPath(brandId: string): string {
  return `/mcp-connections/client-metadata/${encodeURIComponent(brandId)}`;
}

/**
 * Where the cloud publishes a brand's desktop Client ID Metadata Document,
 * which lists {@link MCP_DESKTOP_OAUTH_REDIRECT_URIS}, as a path under the API
 * base. The desktop has no public URL of its own, so its client ID is this
 * path under `/api` on its cloud host.
 */
export function mcpDesktopClientMetadataDocumentPath(brandId: string): string {
  return `${mcpClientMetadataDocumentPath(brandId)}/desktop`;
}

/**
 * The desktop OAuth callbacks its client metadata document lists: the local
 * MCP proxy's callback on its default port. A desktop whose proxy listens on
 * another port registers a client instead.
 */
export const MCP_DESKTOP_OAUTH_REDIRECT_URIS: readonly string[] = [
  'http://127.0.0.1:37645/oauth/callback',
];

const MAX_CLIENT_SETUP_URL_LENGTH = 4096;

function clientSetupUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_CLIENT_SETUP_URL_LENGTH)
    return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? value : null;
  } catch {
    return null;
  }
}

/** Reads `clientSetup` from a start refusal; null when it is malformed. */
export function parseAccountMcpClientSetup(
  value: unknown,
): AccountMcpClientSetup | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  const record: Record<string, unknown> = { ...value };
  const redirectUri = clientSetupUrl(record.redirectUri);
  const issuer = clientSetupUrl(record.issuer);
  const docsUrl =
    record.docsUrl === undefined ? undefined : clientSetupUrl(record.docsUrl);
  if (
    redirectUri === null ||
    issuer === null ||
    docsUrl === null ||
    typeof record.clientSecretRequired !== 'boolean' ||
    typeof record.clientSecretAccepted !== 'boolean'
  )
    return null;
  return {
    redirectUri,
    issuer,
    clientSecretRequired: record.clientSecretRequired,
    clientSecretAccepted: record.clientSecretAccepted,
    ...(docsUrl === undefined ? {} : { docsUrl }),
    ...(typeof record.registrationRefused === 'boolean'
      ? { registrationRefused: record.registrationRefused }
      : {}),
  };
}

export {
  MAX_MCP_EXTRA_HEADERS,
  MAX_MCP_EXTRA_HEADER_NAME_LENGTH,
  MAX_MCP_EXTRA_HEADER_VALUE_LENGTH,
  MCP_EXTRA_HEADER_STORED_ALLOWED_STRIPPED,
  isBlockedMcpExtraHeaderName,
  mcpExtraHeadersProblem,
  parseMcpExtraHeaders,
  type McpExtraHeadersProblem,
} from './extra-headers';
export * from './availability';
export * from './command-policy';
