import type { HarnessCompatibility } from '../plugins/harness-compatibility';
// ---------------------------------------------------------------------------
// Curated MCP server catalog — wire contracts (protocol layer).
//
// These are the canonical request/response shapes for the brand-scoped curated
// MCP server catalog served by Canopy Web and consumed by Canopy Desktop:
//   - Canopy Web serves `CuratedMcpServerListResponse` from
//     `GET /api/v1/[brandNamespace]/mcp-servers/curated`.
//   - The desktop main process fetches / normalizes that payload, caches the
//     resulting server definitions, and answers renderer IPC.
//   - The desktop renderer (via the `window.mcpServers` preload bridge) renders
//     the catalog, connection-status badges, and picker logos.
//
// Style mirrors `packages/protocol/src/skills/index.ts` (pure interfaces,
// `as const`, a `VERSION` const, no zod) and `packages/protocol/src/panels`
// for the guard shape. This module is intentionally DEPENDENCY-FREE: it has
// ZERO imports so the dependency direction stays desktop-shared → protocol.
//
// In particular, `CuratedMcpOAuthHints` is declared inline here and MUST NOT
// import `McpOAuthConfigData` from desktop-shared. `oauthHints` is a
// NON-SECRET subset of an OAuth configuration — it deliberately omits
// `clientSecret` and any other credential; the admin write path (backend)
// enforces this on the way in.
// ---------------------------------------------------------------------------

/**
 * Wire version of the curated MCP catalog API. Bump only on breaking shape
 * changes; additive optional fields do not require a bump.
 */
export const MCP_CATALOG_API_VERSION = 1;

/**
 * Frozen runtime list of every transport a curated entry can advertise on the
 * wire. HTTP-only for now; the field/enum is kept for forward compatibility
 * with future transports. Use this in validators and tests so the closed union
 * stays in lockstep with {@link CuratedMcpTransport} (same convention as
 * `PANEL_KINDS`).
 */
export const MCP_CATALOG_TRANSPORTS = ['http'] as const;

/**
 * Transport of a curated MCP server entry. Only `'http'` is valid on the wire
 * today; the union is derived from {@link MCP_CATALOG_TRANSPORTS} so new
 * transports are added in exactly one place.
 */
export type CuratedMcpTransport = (typeof MCP_CATALOG_TRANSPORTS)[number];

/**
 * Frozen runtime list of every availability value a curated entry can carry on
 * the wire. An entry without `availability` connects everywhere; `'desktop'`
 * marks a server only the desktop app can connect (for example, an OAuth app
 * that accepts loopback redirects only). Validators use this list so the
 * closed union stays in lockstep with {@link CuratedMcpAvailability}.
 */
export const MCP_CATALOG_AVAILABILITIES = ['desktop'] as const;

/** Where a curated entry can be connected; see {@link MCP_CATALOG_AVAILABILITIES}. */
export type CuratedMcpAvailability =
  (typeof MCP_CATALOG_AVAILABILITIES)[number];

/**
 * User-provided values that a curated server may require before it can be
 * connected. These describe inputs only; their values are never catalog data.
 */
export const MCP_CATALOG_REQUIRED_CONFIG_FIELD_KINDS = [
  'oauth-client-id',
  'oauth-client-secret',
] as const;

export type CuratedMcpRequiredConfigFieldKind =
  (typeof MCP_CATALOG_REQUIRED_CONFIG_FIELD_KINDS)[number];

/** One user-provided setup input required by a curated server. */
export interface CuratedMcpRequiredConfigField {
  kind: CuratedMcpRequiredConfigFieldKind;
  /** Optional vendor documentation explaining how to obtain the value. */
  sourceUrl?: string;
}

/** One selectable endpoint for servers with regional/data-residency URLs. */
export interface CuratedMcpUrlOption {
  url: string;
  label: string;
  description?: string;
}

/**
 * Non-secret subset of an OAuth configuration attached to a curated entry.
 *
 * Declared INLINE here (never imported from desktop-shared's
 * `McpOAuthConfigData`) to preserve the desktop-shared → protocol dependency
 * direction. This shape NEVER carries `clientSecret` or any other credential:
 * it exists only to pre-fill the non-secret portion of an OAuth setup dialog.
 */
export interface CuratedMcpOAuthHints {
  /** Optional manual authorization endpoint hint. */
  authorizationUrl?: string;
  /** Optional manual token endpoint hint. */
  tokenUrl?: string;
  /** Optional scope hints; discovery is used when omitted. */
  scopes?: string[];
  /** Optional audience hint. */
  audience?: string;
  /** Whether PKCE should be used. Missing is treated as `true` by consumers. */
  usePkce?: boolean;
  /** Optional pre-registered public client id. NEVER a secret. */
  clientId?: string;
  /**
   * Optional fixed loopback callback port registered for the public client.
   * This is non-secret; consumers still validate and bind loopback-only.
   */
  callbackPort?: number;
}

/**
 * One curated MCP server entry as served by Canopy Web. Represents the
 * catalog's public metadata for a single server; connection/auth state is a
 * separate desktop-only concern and is not part of this wire shape.
 */
export interface CuratedMcpServerEntry {
  harnessCompatibility?: HarnessCompatibility;
  /** Stable catalog key; the join key desktop uses to reconcile local copies. */
  key: string;
  /** Display name. */
  name: string;
  /** One-line description shown in list/card headers. */
  shortDescription: string;
  /** Optional long-form description / marketing copy. */
  longDescription?: string;
  /** Optional example prompt; listing metadata, not installation content. */
  tryNowPrompt?: string;
  /** Optional logo URL for the picker and table. */
  logoUrl?: string;
  /** MCP endpoint URL (HTTP transport). */
  url: string;
  /** Transport of the endpoint. HTTP-only for now. */
  transport: CuratedMcpTransport;
  /** Optional non-secret OAuth hints for pre-filling a setup dialog. */
  oauthHints?: CuratedMcpOAuthHints;
  /** An active platform OAuth client is bound to this catalog server key. */
  platformOAuth?: boolean;
  /** User-provided setup inputs required before connection. */
  requiredConfigFields?: CuratedMcpRequiredConfigField[];
  /** Optional selectable endpoint choices, typically for data residency. */
  urlOptions?: CuratedMcpUrlOption[];
  /** Optional user-facing setup guidance beyond the standard connect flow. */
  setupInstructions?: string;
  /** Optional author / vendor display name. */
  authorName?: string;
  /** Optional author / vendor URL. */
  authorUrl?: string;
  /** Optional documentation URL. */
  docsUrl?: string;
  /** Optional support URL. */
  supportUrl?: string;
  /** Optional privacy-policy URL. */
  privacyPolicyUrl?: string;
  /** Category slugs used for client-side sectioning/filtering. */
  categories: string[];
  /** Whether the entry belongs in the "Popular" section (client-side sections). */
  popular: boolean;
  /**
   * An editorial pick Customize marks as recommended. Independent of
   * `popular` and `platformOAuth`: it says nothing about sign-in or vendor
   * approval. Absent means not recommended.
   */
  recommended?: boolean;
  /** Ascending sort weight within a section (lower sorts first). */
  sortOrder: number;
  /**
   * Marks this entry as connectable through an agent provider's own account
   * rather than a Canopy-owned OAuth client.
   *
   * Set for connectors whose scopes Canopy does not want to carry — Gmail and
   * Drive are Google *restricted* scopes, so a first-party integration would
   * mean restricted-scope verification and annual CASA. When present, the
   * desktop offers "Connect with Claude / Codex" instead of Canopy's own OAuth
   * flow.
   */
  providerConnector?: CuratedMcpProviderConnector;
  /**
   * Where the server can be connected. Absent means everywhere. `'desktop'`
   * means only the desktop app can connect it: its sign-in refuses the web
   * app's return address, so the web shows it as desktop only, never offers
   * a sign-in for it, and cloud sessions never bundle it. The desktop
   * connects it as a server on the device. Additive: older clients ignore it.
   */
  availability?: CuratedMcpAvailability;
  /** ISO-8601 timestamp of the entry's last update. */
  updatedAt: string;
}

/** Which agent providers can supply a connector, and how each identifies it. */
export interface CuratedMcpProviderConnector {
  /**
   * Providers offering this connector. Catalogs genuinely differ — Codex
   * publishes thousands of ChatGPT apps while Claude has its own set, and
   * plenty exist on only one — so this cannot be derived and must be declared.
   */
  providers: CuratedMcpConnectorProvider[];
  /**
   * Name as it appears on a Claude account, when it differs from `name`.
   *
   * Claude reports connectors by display string and publishes no catalog to
   * look them up in, so an entry named "Unstoppable Domains" will not match an
   * account connector called "Unstoppable Domains (Staging)" without this.
   */
  claudeConnectorName?: string;
  /**
   * Codex connector id, pinning the exact app out of a directory with
   * thousands of entries rather than matching on a collidable name.
   */
  codexConnectorId?: string;
}

export type CuratedMcpConnectorProvider = 'claude' | 'codex';

/**
 * The full response payload of the curated MCP server list API. `version`
 * echoes {@link MCP_CATALOG_API_VERSION} at serve time so clients can gate on
 * a forward-incompatible bump.
 */
export interface CuratedMcpServerListResponse {
  version: number;
  servers: CuratedMcpServerEntry[];
}

// ---------------------------------------------------------------------------
// Pure type guards.
//
// Mirror `isPanelKind` (packages/protocol/src/panels/index.ts): closed unions
// validate against their frozen runtime list; object guards check every field
// structurally. Guards NEVER throw — malformed input returns `false` so a
// corrupt payload degrades to "empty catalog" rather than crashing a consumer.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function isOptionalStringArray(value: unknown): boolean {
  return value === undefined || isStringArray(value);
}

function isOptionalPort(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 1 &&
      value <= 65_535)
  );
}

/** Whether `value` is a transport name valid on the wire. */
export function isCuratedMcpTransport(
  value: unknown,
): value is CuratedMcpTransport {
  return (
    typeof value === 'string' &&
    MCP_CATALOG_TRANSPORTS.some((transport) => transport === value)
  );
}

/** Whether `value` is an availability value valid on the wire. */
export function isCuratedMcpAvailability(
  value: unknown,
): value is CuratedMcpAvailability {
  return (
    typeof value === 'string' &&
    MCP_CATALOG_AVAILABILITIES.some((availability) => availability === value)
  );
}

/** Whether `value` names a supported user-provided setup field. */
export function isCuratedMcpRequiredConfigFieldKind(
  value: unknown,
): value is CuratedMcpRequiredConfigFieldKind {
  return (
    typeof value === 'string' &&
    MCP_CATALOG_REQUIRED_CONFIG_FIELD_KINDS.some((kind) => kind === value)
  );
}

/** Validates one required setup-field descriptor. */
export function isCuratedMcpRequiredConfigField(
  value: unknown,
): value is CuratedMcpRequiredConfigField {
  return (
    isRecord(value) &&
    isCuratedMcpRequiredConfigFieldKind(value.kind) &&
    isOptionalString(value.sourceUrl)
  );
}

/** Validates one selectable MCP endpoint descriptor. */
export function isCuratedMcpUrlOption(
  value: unknown,
): value is CuratedMcpUrlOption {
  return (
    isRecord(value) &&
    isNonEmptyString(value.url) &&
    isNonEmptyString(value.label) &&
    isOptionalString(value.description)
  );
}

/**
 * Validates the non-secret OAuth hints subset. Every field is optional, so an
 * empty object is valid; a wrong field TYPE rejects. `clientSecret` is not part
 * of the type and is neither required nor validated here — the backend admin
 * schema is responsible for rejecting secrets on write.
 */
/**
 * Validate the connector config the hub sets.
 *
 * Load-bearing rather than defensive: this struct arrives over the network,
 * and `normalizeProviderConnector` spreads `connector.providers`. A malformed
 * one throws there, and that throw is caught where the *whole* catalog is
 * discarded — so a single mistyped connector would silently zero out every
 * curated MCP server for every user, not just its own row.
 */
export function isCuratedMcpProviderConnector(
  value: unknown,
): value is CuratedMcpProviderConnector {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.providers)) return false;
  if (
    !value.providers.every(
      (provider) => provider === 'claude' || provider === 'codex',
    )
  ) {
    return false;
  }
  return (
    isOptionalString(value.claudeConnectorName) &&
    isOptionalString(value.codexConnectorId)
  );
}

export function isCuratedMcpOAuthHints(
  value: unknown,
): value is CuratedMcpOAuthHints {
  if (!isRecord(value)) return false;
  return (
    isOptionalString(value.authorizationUrl) &&
    isOptionalString(value.tokenUrl) &&
    isOptionalStringArray(value.scopes) &&
    isOptionalString(value.audience) &&
    isOptionalBoolean(value.usePkce) &&
    isOptionalString(value.clientId) &&
    isOptionalPort(value.callbackPort)
  );
}

/** Validates a single curated server entry structurally. */
export function isCuratedMcpServerEntry(
  value: unknown,
): value is CuratedMcpServerEntry {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.key) &&
    isNonEmptyString(value.name) &&
    typeof value.shortDescription === 'string' &&
    isOptionalString(value.longDescription) &&
    isOptionalString(value.tryNowPrompt) &&
    isOptionalString(value.logoUrl) &&
    isNonEmptyString(value.url) &&
    isCuratedMcpTransport(value.transport) &&
    (value.oauthHints === undefined ||
      isCuratedMcpOAuthHints(value.oauthHints)) &&
    (value.platformOAuth === undefined ||
      typeof value.platformOAuth === 'boolean') &&
    (value.providerConnector === undefined ||
      isCuratedMcpProviderConnector(value.providerConnector)) &&
    (value.availability === undefined ||
      isCuratedMcpAvailability(value.availability)) &&
    (value.requiredConfigFields === undefined ||
      (Array.isArray(value.requiredConfigFields) &&
        value.requiredConfigFields.every(isCuratedMcpRequiredConfigField))) &&
    (value.urlOptions === undefined ||
      (Array.isArray(value.urlOptions) &&
        value.urlOptions.every(isCuratedMcpUrlOption))) &&
    isOptionalString(value.setupInstructions) &&
    isOptionalString(value.authorName) &&
    isOptionalString(value.authorUrl) &&
    isOptionalString(value.docsUrl) &&
    isOptionalString(value.supportUrl) &&
    isOptionalString(value.privacyPolicyUrl) &&
    isStringArray(value.categories) &&
    typeof value.popular === 'boolean' &&
    (value.recommended === undefined ||
      typeof value.recommended === 'boolean') &&
    isFiniteNumber(value.sortOrder) &&
    typeof value.updatedAt === 'string'
  );
}

/**
 * Validates a curated list response: a numeric `version` and a `servers` array
 * whose every element is a valid {@link CuratedMcpServerEntry}. Returns `false`
 * for non-objects or any malformed entry.
 */
export function isCuratedMcpServerListResponse(
  value: unknown,
): value is CuratedMcpServerListResponse {
  if (!isRecord(value)) return false;
  return (
    isFiniteNumber(value.version) &&
    Array.isArray(value.servers) &&
    value.servers.every(isCuratedMcpServerEntry)
  );
}

/** Connection-relevant curated fields; stored rows hold nullable JSON. */
export interface CuratedMcpConnectionFields {
  oauthHints?: unknown;
  requiredConfigFields?: unknown;
  providerConnector?: unknown;
  urlOptions?: unknown;
  /** The wire `availability`; only `'desktop'` changes the answer. */
  availability?: unknown;
}

function isNonEmptyRecord(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length > 0;
}

/**
 * Whether a curated MCP server needs a user-provided connection (OAuth,
 * manual config, or a choice between several endpoints) before a cloud
 * session can call it. Any of null/undefined/{}/[] reads as "no connection
 * needed".
 */
export function curatedMcpRequiresConnection(
  entry: CuratedMcpConnectionFields,
): boolean {
  const hasRequiredConfigFields =
    Array.isArray(entry.requiredConfigFields) &&
    entry.requiredConfigFields.length > 0;
  // A provider-routed entry is authenticated on the user's Claude or Codex
  // account, so it carries neither hints nor required fields — and would
  // otherwise read as "no connection needed" and be bundled into a cloud
  // session that can never authenticate it.
  return (
    isNonEmptyRecord(entry.oauthHints) ||
    hasRequiredConfigFields ||
    isNonEmptyRecord(entry.providerConnector) ||
    (Array.isArray(entry.urlOptions) && entry.urlOptions.length > 1)
  );
}

/**
 * A provider connector with no Canopy connection path: only a desktop agent
 * provider's own account (Claude or Codex) can connect it, so neither the web
 * nor the desktop's own sign-in can. Not set by `availability`: a server the
 * catalog marks desktop only still signs in on the desktop.
 */
export function curatedMcpProviderOnly(
  entry: CuratedMcpConnectionFields,
): boolean {
  return (
    Boolean(entry.providerConnector) &&
    !curatedMcpRequiresConnection({
      oauthHints: entry.oauthHints,
      requiredConfigFields: entry.requiredConfigFields,
    })
  );
}

/**
 * Whether only the desktop app can connect a curated server: a provider-only
 * connector ({@link curatedMcpProviderOnly}), or a server the catalog marks
 * `availability: 'desktop'`. The web shows these as desktop only and never
 * offers a sign-in, the account broker refuses them, cloud sessions never
 * bundle them, and the desktop adds them as device servers rather than
 * account connections. Whether the desktop can sign in to one itself is
 * {@link curatedMcpProviderOnly}'s question, not this one's.
 */
export function curatedMcpDesktopOnly(
  entry: CuratedMcpConnectionFields,
): boolean {
  return entry.availability === 'desktop' || curatedMcpProviderOnly(entry);
}

/**
 * The comparable form of an MCP endpoint: an `https:` URL without credentials,
 * its host lowercased and default port dropped by the URL parser, one trailing
 * slash removed from a non-root path, the query kept exactly and any fragment
 * dropped. Anything else (another scheme, credentials, an unparsable string)
 * has none, so it can never match a catalog endpoint.
 */
function canonicalMcpEndpoint(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
    return undefined;
  const path =
    parsed.pathname.length > 1 && parsed.pathname.endsWith('/')
      ? parsed.pathname.slice(0, -1)
      : parsed.pathname;
  return `https://${parsed.host}${path}${parsed.search}`;
}

/**
 * Whether `url` could ever match a catalog endpoint for account binding: an
 * `https:` URL without credentials. Anything else never reaches an account,
 * whatever the catalog holds.
 */
export function isAccountMcpCatalogEndpoint(url: string): boolean {
  return canonicalMcpEndpoint(url) !== undefined;
}

/**
 * The catalog connector whose account connections an MCP server at `url` may
 * use: the one entry whose endpoint, or one of its endpoint choices, is the
 * same URL ({@link canonicalMcpEndpoint}). A server a third-party plugin
 * declares is matched this way, since such a plugin names no catalog key. The
 * match is by the exact upstream, so a declaration can never send an account's
 * requests anywhere the catalog does not already send them. Entries only the
 * desktop can connect ({@link curatedMcpDesktopOnly}) have no account
 * connections and never match; neither does a URL that two entries share,
 * whether or not either is desktop-only.
 * An account connection reports its upstream hostname but not its port or
 * path, so an entry that lists more than one endpoint on the matched hostname
 * never matches either: which of them an account uses can't be told apart.
 */
export function accountMcpCatalogKeyForUrl(
  entries: readonly CuratedMcpServerEntry[],
  url: string,
): string | undefined {
  const target = canonicalMcpEndpoint(url);
  if (target === undefined) return undefined;
  // Uniqueness is checked across the whole catalog, desktop-only entries
  // included, before a desktop-only match is refused.
  const matched: CuratedMcpServerEntry[] = [];
  for (const entry of entries) {
    const endpoints = [
      entry.url,
      ...(entry.urlOptions ?? []).map((option) => option.url),
    ];
    const canonical = endpoints.map(canonicalMcpEndpoint);
    if (!canonical.includes(target)) continue;
    // By hostname, ports aside: an account reports only its hostname.
    const hostname = new URL(target).hostname;
    const onHost = new Set(
      canonical.filter(
        (endpoint): endpoint is string =>
          endpoint !== undefined && new URL(endpoint).hostname === hostname,
      ),
    );
    if (onHost.size !== 1) return undefined;
    matched.push(entry);
  }
  const [only] = matched;
  return matched.length === 1 &&
    only !== undefined &&
    !curatedMcpDesktopOnly(only)
    ? only.key
    : undefined;
}

// ---------------------------------------------------------------------------
// Identity kinds for shared connections (CAN-6250; spec FR-3.2). A connection
// an organization holds acts for everyone on its projects, so it uses the
// service's bot identity where one exists. Kept in code, not on
// `curated_mcp_servers`, which is published to Datastream.
// ---------------------------------------------------------------------------

/** Who a shared connection acts as: the service's bot, or whoever signed in. */
export type SharedConnectionIdentityKind = 'bot' | 'user';

/** Servers that offer a bot identity, and use only it when shared. */
const SHARED_BOT_SERVER_KEYS: ReadonlySet<string> = new Set(['slack']);

/**
 * The identity a shared connection to `serverKey` uses: the bot where the
 * service offers one (and then a personal sign-in is never offered for
 * shared use), else the sign-in of the person who connects it, with the
 * "acts as you" warning.
 */
export function sharedConnectionIdentityKind(
  serverKey: string,
): SharedConnectionIdentityKind {
  return SHARED_BOT_SERVER_KEYS.has(serverKey) ? 'bot' : 'user';
}
