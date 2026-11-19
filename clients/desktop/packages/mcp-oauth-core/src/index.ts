import { getDomain } from 'tldts';
import { isIpLiteral, isNonPublicIpAddress } from './network-address';

const GOOGLE_AUTHORIZATION_ORIGIN = 'https://accounts.google.com';

// Pure policy lifted from the desktop OAuth client; desktop migration follows W2.
const TRUSTED_DELEGATED_OAUTH_ENDPOINT_TUPLES = [
  {
    resourceOrigin: 'https://calendarmcp.googleapis.com',
    authorizationOrigin: 'https://accounts.google.com',
    tokenOrigin: 'https://oauth2.googleapis.com',
  },
  // First-party stateless Google Calendar MCP endpoint (ECW-8473). It declares
  // Google as its authorization server, so the same accounts.google.com →
  // oauth2.googleapis.com delegation applies. The endpoint forwards the
  // caller's token to Google and stores nothing; token custody stays on the
  // user's machine. Entries are per-origin on purpose — adding a host here is
  // an explicit statement that Canopy trusts it with Google-minted tokens.
  {
    resourceOrigin: 'https://code.unstoppabledomains.com',
    authorizationOrigin: 'https://accounts.google.com',
    tokenOrigin: 'https://oauth2.googleapis.com',
  },
  {
    resourceOrigin: 'https://code.ud-staging.com',
    authorizationOrigin: 'https://accounts.google.com',
    tokenOrigin: 'https://oauth2.googleapis.com',
  },
  {
    resourceOrigin: 'https://app.unstoppable.ai',
    authorizationOrigin: 'https://accounts.google.com',
    tokenOrigin: 'https://oauth2.googleapis.com',
  },
] as const;

/**
 * Hosted identity providers a site may run its token endpoint on while its
 * authorization endpoint stays on the site itself (Harvey on Auth0, Descript
 * and Ketryx on Stytch). Matched by hostname suffix, and trusted only for a
 * resource on the authorization endpoint's site.
 */
const TRUSTED_TOKEN_IDENTITY_PROVIDER_SUFFIXES = [
  'auth0.com',
  'okta.com',
  'stytch.com',
] as const;

/** Sites one owner splits sign-in across, as (authorization, token) sites. */
const TRUSTED_OAUTH_SITE_PAIRS = [
  { authorizationSite: 'dropbox.com', tokenSite: 'dropboxapi.com' },
  { authorizationSite: 'fathom.video', tokenSite: 'fathom.ai' },
] as const;

export interface TokenExchangeResult {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  scope?: string;
  expiresAt?: string;
}

export interface TokenRequestConfig {
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
  tokenUrlRequiresPublicAddress?: boolean;
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorizationServers: string[];
  scopesSupported: string[];
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorizationResponseIssParameterSupported: boolean;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopesSupported: string[];
  /** `token_endpoint_auth_methods_supported`, when the server lists it. */
  tokenEndpointAuthMethodsSupported?: string[];
  /** `client_id_metadata_document_supported`. */
  clientIdMetadataDocumentSupported: boolean;
  /** `code_challenge_methods_supported`, when the server lists it. */
  codeChallengeMethodsSupported?: string[];
}

/** How a client authenticates at the token endpoint (RFC 7591 §2). */
export type TokenEndpointAuthMethod =
  | 'none'
  | 'client_secret_basic'
  | 'client_secret_post';

export function isTokenEndpointAuthMethod(
  value: unknown,
): value is TokenEndpointAuthMethod {
  return (
    value === 'none' ||
    value === 'client_secret_basic' ||
    value === 'client_secret_post'
  );
}

type TokenEndpointAuthMetadata = Pick<
  AuthorizationServerMetadata,
  'tokenEndpointAuthMethodsSupported'
>;

/**
 * The method a client uses at this server's token endpoint, or null when the
 * server takes none this client can use. A server that omits the list takes
 * `client_secret_basic` (RFC 8414 §2). A client with a secret prefers Basic,
 * which RFC 6749 §2.3.1 recommends over the form body; one without a secret
 * can only be a public client.
 */
export function selectTokenEndpointAuthMethod(
  metadata: TokenEndpointAuthMetadata,
  hasClientSecret: boolean,
): TokenEndpointAuthMethod | null {
  const supported = metadata.tokenEndpointAuthMethodsSupported ?? [
    'client_secret_basic',
  ];
  if (hasClientSecret && supported.includes('client_secret_basic'))
    return 'client_secret_basic';
  if (hasClientSecret && supported.includes('client_secret_post'))
    return 'client_secret_post';
  return supported.includes('none') ? 'none' : null;
}

/**
 * Whether an OAuth app for this server needs a client secret: the server takes
 * no public clients, but does take one of the secret methods.
 */
export function oauthClientSecretRequired(
  metadata: TokenEndpointAuthMetadata,
): boolean {
  return (
    selectTokenEndpointAuthMethod(metadata, false) === null &&
    selectTokenEndpointAuthMethod(metadata, true) !== null
  );
}

/**
 * The method a dynamically registered client uses: the one its registration
 * response named, else the server's choice for a client with (or without) the
 * secret it was issued.
 */
export function registeredTokenEndpointAuthMethod(
  client: ClientRegistration,
  metadata: TokenEndpointAuthMetadata,
): TokenEndpointAuthMethod {
  const hasClientSecret = Boolean(client.clientSecret);
  return (
    client.tokenEndpointAuthMethod ??
    selectTokenEndpointAuthMethod(metadata, hasClientSecret) ??
    (hasClientSecret ? 'client_secret_post' : 'none')
  );
}

function formUrlEncode(value: string): string {
  return new URLSearchParams({ value }).toString().slice('value='.length);
}

/**
 * The body fields and headers that authenticate a token request's client. A
 * Basic header carries the form-urlencoded ID and secret (RFC 6749 §2.3.1);
 * no method ever puts a secret anywhere else.
 */
export function tokenEndpointClientAuthentication(client: {
  clientId: string;
  clientSecret?: string;
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
}): { body: Record<string, string>; headers: Record<string, string> } {
  const method = client.tokenEndpointAuthMethod;
  if (method !== 'client_secret_basic' && method !== 'client_secret_post')
    return { body: { client_id: client.clientId }, headers: {} };
  if (!client.clientSecret) throw new OAuthError('invalid_client');
  if (method === 'client_secret_post')
    return {
      body: { client_id: client.clientId, client_secret: client.clientSecret },
      headers: {},
    };
  const credentials = `${formUrlEncode(client.clientId)}:${formUrlEncode(client.clientSecret)}`;
  return {
    body: {},
    headers: {
      Authorization: `Basic ${btoa(credentials)}`,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...Array.from(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
export function createCodeVerifier(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}
export async function createPkceChallenge(verifier: string): Promise<string> {
  return base64Url(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
    ),
  );
}
export function parseHttpUrl(value: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid HTTP or HTTPS URL.`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} must be a valid HTTP or HTTPS URL.`);
  }

  return parsed;
}

export function parseDiscoveredPublicHttpsUrl(
  value: string,
  label: string,
): URL {
  const parsed = parseHttpUrl(value, label);
  const normalizedHostname = parsed.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  const registrableDomain = getDomain(normalizedHostname, {
    allowPrivateDomains: true,
    extractHostname: false,
  });
  if (
    parsed.protocol !== 'https:' ||
    normalizedHostname === 'localhost' ||
    normalizedHostname.endsWith('.localhost') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    isNonPublicIpAddress(normalizedHostname) ||
    (!isIpLiteral(normalizedHostname) && !registrableDomain)
  ) {
    throw new Error(`${label} must be a public HTTPS URL.`);
  }
  return parsed;
}

/**
 * The origin of an MCP server URL on this machine (`localhost`, `127.0.0.1`
 * or `[::1]`), or undefined. A desktop passes it to the discovery parsers so a
 * local server can name its own authorization server.
 */
export function loopbackOriginOf(url: string): string | undefined {
  if (!URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  return (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
    (host === 'localhost' || host === '127.0.0.1' || host === '[::1]')
    ? parsed.origin
    : undefined;
}

/**
 * A discovered OAuth URL: public HTTPS, or any URL on `loopbackOrigin`. Only
 * the desktop passes that origin, and only for a local MCP server the person
 * entered, so the hosted web never fetches a loopback address.
 */
export function parseDiscoveredOAuthUrl(
  value: string,
  label: string,
  loopbackOrigin?: string,
): URL {
  if (loopbackOrigin !== undefined) {
    const parsed = parseHttpUrl(value, label);
    if (
      parsed.origin === loopbackOrigin &&
      parsed.username === '' &&
      parsed.password === ''
    ) {
      return parsed;
    }
  }
  return parseDiscoveredPublicHttpsUrl(value, label);
}

export function isSameOriginUrl(
  value: string,
  origin: string,
  label: string,
): boolean {
  try {
    return parseHttpUrl(value, label).origin === origin;
  } catch {
    return false;
  }
}

export function isSameRegistrableDomain(left: string, right: string): boolean {
  const normalizedLeft = left.toLowerCase();
  const normalizedRight = right.toLowerCase();
  if (normalizedLeft === normalizedRight) {
    return true;
  }

  const leftDomain = registrableDomain(normalizedLeft);
  return !!leftDomain && leftDomain === registrableDomain(normalizedRight);
}

function registrableDomain(hostname: string): string | null {
  // Security-sensitive OAuth origin check: callers pass hostnames parsed by
  // URL, and allowPrivateDomains must stay true so shared-hosting PSL entries
  // such as herokuapp.com do not collapse into one trusted parent domain.
  return getDomain(hostname.toLowerCase(), {
    allowPrivateDomains: true,
    extractHostname: false,
  });
}

function isHttpsPair(left: URL, right: URL): boolean {
  return left.protocol === 'https:' && right.protocol === 'https:';
}

function isTrustedTokenIdentityProvider(tokenEndpoint: URL): boolean {
  const host = tokenEndpoint.hostname.toLowerCase();
  return TRUSTED_TOKEN_IDENTITY_PROVIDER_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
}

function isTrustedOAuthSitePair(
  authorizationEndpoint: URL,
  tokenEndpoint: URL,
): boolean {
  const authorizationSite = registrableDomain(authorizationEndpoint.hostname);
  const tokenSite = registrableDomain(tokenEndpoint.hostname);
  return TRUSTED_OAUTH_SITE_PAIRS.some(
    (pair) =>
      pair.authorizationSite === authorizationSite &&
      pair.tokenSite === tokenSite,
  );
}

/**
 * One site may split its authorization and token endpoints across hosts
 * (`auth.example.com` and `api.example.com`). The pair stays on one
 * registrable domain, which the PSL-aware check keeps from spanning tenants of
 * a shared host such as herokuapp.com.
 */
function isSameSiteOAuthEndpointPair(
  authorizationEndpoint: URL,
  tokenEndpoint: URL,
): boolean {
  return (
    isHttpsPair(authorizationEndpoint, tokenEndpoint) &&
    isSameRegistrableDomain(
      authorizationEndpoint.hostname,
      tokenEndpoint.hostname,
    )
  );
}

/**
 * A pair across sites that some resource may use: a documented site pair, or
 * a token endpoint on a trusted identity provider.
 * {@link isTrustedOAuthEndpointPairForResource} decides which resources.
 */
function isCrossSiteOAuthEndpointPair(
  authorizationEndpoint: URL,
  tokenEndpoint: URL,
): boolean {
  return (
    isHttpsPair(authorizationEndpoint, tokenEndpoint) &&
    (isTrustedOAuthSitePair(authorizationEndpoint, tokenEndpoint) ||
      isTrustedTokenIdentityProvider(tokenEndpoint))
  );
}

export function isTrustedOAuthEndpointPair(
  authorizationEndpoint: URL,
  tokenEndpoint: URL,
): boolean {
  return (
    authorizationEndpoint.origin === tokenEndpoint.origin ||
    isSameSiteOAuthEndpointPair(authorizationEndpoint, tokenEndpoint) ||
    isCrossSiteOAuthEndpointPair(authorizationEndpoint, tokenEndpoint) ||
    TRUSTED_DELEGATED_OAUTH_ENDPOINT_TUPLES.some(
      (tuple) =>
        tuple.authorizationOrigin === authorizationEndpoint.origin &&
        tuple.tokenOrigin === tokenEndpoint.origin,
    )
  );
}

/**
 * The endpoint pair a requesting resource may use: one origin or one site as
 * for any resource, while delegation across registrable domains stays limited
 * to the resources its tuple names. A documented site pair serves resources
 * on either of its sites. A token endpoint on an identity provider serves
 * resources on the authorization endpoint's site, so the consent screen is
 * always the resource owner's own.
 */
export function isTrustedOAuthEndpointPairForResource(
  resource: URL,
  authorizationEndpoint: URL,
  tokenEndpoint: URL,
): boolean {
  if (
    authorizationEndpoint.origin === tokenEndpoint.origin ||
    isSameSiteOAuthEndpointPair(authorizationEndpoint, tokenEndpoint) ||
    isTrustedDelegatedOAuthEndpointTuple(
      resource,
      authorizationEndpoint,
      tokenEndpoint,
    )
  )
    return true;
  if (!isHttpsPair(authorizationEndpoint, tokenEndpoint)) return false;
  const onAuthorizationSite = isSameRegistrableDomain(
    resource.hostname,
    authorizationEndpoint.hostname,
  );
  if (isTrustedOAuthSitePair(authorizationEndpoint, tokenEndpoint))
    return (
      onAuthorizationSite ||
      isSameRegistrableDomain(resource.hostname, tokenEndpoint.hostname)
    );
  return onAuthorizationSite && isTrustedTokenIdentityProvider(tokenEndpoint);
}

export function isTrustedDelegatedOAuthEndpointTuple(
  resource: URL,
  authorizationEndpoint: URL,
  tokenEndpoint: URL,
): boolean {
  return TRUSTED_DELEGATED_OAUTH_ENDPOINT_TUPLES.some(
    (tuple) =>
      tuple.resourceOrigin === resource.origin &&
      tuple.authorizationOrigin === authorizationEndpoint.origin &&
      tuple.tokenOrigin === tokenEndpoint.origin,
  );
}

function readString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const entry = value[key];
  return typeof entry === 'string' && entry.trim().length > 0
    ? entry.trim()
    : undefined;
}

function readStringArray(
  value: Record<string, unknown>,
  key: string,
): string[] {
  const entry = value[key];
  return Array.isArray(entry)
    ? entry.filter((item): item is string => typeof item === 'string')
    : [];
}

export function parseExpiresAt(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return new Date(Date.now() + Math.round(value) * 1000).toISOString();
}

export function parseTokenResponse(value: unknown): TokenExchangeResult {
  if (!isRecord(value) || typeof value.access_token !== 'string') {
    throw new Error('OAuth token response did not include an access token.');
  }

  return {
    accessToken: value.access_token,
    refreshToken:
      typeof value.refresh_token === 'string' ? value.refresh_token : undefined,
    tokenType:
      typeof value.token_type === 'string' ? value.token_type : 'Bearer',
    scope: typeof value.scope === 'string' ? value.scope : undefined,
    expiresAt: parseExpiresAt(value.expires_in),
  };
}

export function buildCanonicalResourceUrl(mcpUrl: string): string {
  const parsed = parseHttpUrl(mcpUrl, 'MCP server URL');
  parsed.hash = '';
  return parsed.toString();
}

export function buildProtectedResourceMetadataUrls(mcpUrl: string): URL[] {
  const parsed = parseHttpUrl(mcpUrl, 'MCP server URL');
  const urls: URL[] = [];
  if (parsed.pathname !== '/') {
    urls.push(
      new URL(
        `/.well-known/oauth-protected-resource${parsed.pathname}`,
        parsed.origin,
      ),
    );
  }
  urls.push(new URL('/.well-known/oauth-protected-resource', parsed.origin));
  return urls;
}

export function parseProtectedResourceMetadata(
  payload: Record<string, unknown>,
  expectedResource: string,
  loopbackOrigin?: string,
): ProtectedResourceMetadata | null {
  const resource = payload.resource;
  if (typeof resource !== 'string' || resource !== expectedResource)
    return null;

  const authorizationServers = readStringArray(payload, 'authorization_servers')
    .map((value) => {
      try {
        return parseDiscoveredOAuthUrl(
          value,
          'Authorization server URL',
          loopbackOrigin,
        ).toString();
      } catch {
        return null;
      }
    })
    .filter((value): value is string => value !== null);
  if (authorizationServers.length === 0) {
    return null;
  }
  return {
    resource,
    authorizationServers,
    scopesSupported: readStringArray(payload, 'scopes_supported'),
  };
}

export function buildAuthorizationServerMetadataUrls(
  issuer: string,
  loopbackOrigin?: string,
): URL[] {
  const parsed = parseDiscoveredOAuthUrl(
    issuer,
    'Authorization server URL',
    loopbackOrigin,
  );
  const pathPart = parsed.pathname.replace(/^\/+|\/+$/g, '');
  if (pathPart.length === 0) {
    return [
      new URL('/.well-known/oauth-authorization-server', parsed.origin),
      new URL('/.well-known/openid-configuration', parsed.origin),
    ];
  }

  return [
    new URL(
      `/.well-known/oauth-authorization-server/${pathPart}`,
      parsed.origin,
    ),
    new URL(`/.well-known/openid-configuration/${pathPart}`, parsed.origin),
    new URL(
      `${parsed.pathname.replace(/\/+$/g, '')}/.well-known/openid-configuration`,
      parsed.origin,
    ),
  ];
}

/**
 * Whether two issuer identifiers name the same public HTTPS authorization
 * server: equal once parsed as URLs (so `https://a.example` and
 * `https://a.example/` agree), with no query or fragment. The broker matches
 * discovered metadata, and the issuer it was discovered for, this way.
 */
export function isSameOAuthIssuer(
  left: string,
  right: string,
  loopbackOrigin?: string,
): boolean {
  try {
    const leftUrl = parseDiscoveredOAuthUrl(
      left,
      'OAuth issuer',
      loopbackOrigin,
    );
    const rightUrl = parseDiscoveredOAuthUrl(
      right,
      'OAuth issuer',
      loopbackOrigin,
    );
    return (
      !leftUrl.search &&
      !leftUrl.hash &&
      leftUrl.toString() === rightUrl.toString()
    );
  } catch {
    return false;
  }
}

export function parseAuthorizationServerMetadata(
  payload: Record<string, unknown>,
  expectedIssuer: string,
  loopbackOrigin?: string,
): AuthorizationServerMetadata | null {
  const authorizationEndpoint = readString(payload, 'authorization_endpoint');
  const tokenEndpoint = readString(payload, 'token_endpoint');
  if (!authorizationEndpoint || !tokenEndpoint) {
    return null;
  }
  const issuer = readString(payload, 'issuer');
  if (!issuer || !isSameOAuthIssuer(issuer, expectedIssuer, loopbackOrigin)) {
    return null;
  }
  const issuerHost = new URL(expectedIssuer).hostname;

  let authorizationEndpointUrl: URL;
  let tokenEndpointUrl: URL;
  try {
    // RFC 8414 metadata may delegate endpoints to a different origin. Trust
    // the HTTPS metadata document rather than requiring its endpoint URLs to
    // reuse the metadata host, while retaining public-network and endpoint
    // origin binding checks.
    authorizationEndpointUrl = parseDiscoveredOAuthUrl(
      authorizationEndpoint,
      'OAuth authorization endpoint',
      loopbackOrigin,
    );
    tokenEndpointUrl = parseDiscoveredOAuthUrl(
      tokenEndpoint,
      'OAuth token endpoint',
      loopbackOrigin,
    );
  } catch {
    return null;
  }
  // RFC 8414 permits endpoint delegation, but sending the authorization code
  // and PKCE verifier to an arbitrary site would cross the consent screen's
  // trust boundary. Pairs on one registrable domain stay with one owner;
  // delegation beyond it stays in main-process-owned policy instead of
  // trusting forgeable definition metadata such as `curated`.
  if (!isTrustedOAuthEndpointPair(authorizationEndpointUrl, tokenEndpointUrl)) {
    return null;
  }
  const registrationEndpoint = readString(payload, 'registration_endpoint');
  let validatedRegistrationEndpoint: string | undefined;
  if (registrationEndpoint) {
    try {
      const registrationEndpointUrl = parseDiscoveredPublicHttpsUrl(
        registrationEndpoint,
        'OAuth registration endpoint',
      );
      // Registration only mints a client, so a host on the issuer's or the
      // authorization endpoint's site (`api.vercel.com` for `vercel.com`)
      // is enough.
      if (
        isSameRegistrableDomain(registrationEndpointUrl.hostname, issuerHost) ||
        isSameRegistrableDomain(
          registrationEndpointUrl.hostname,
          authorizationEndpointUrl.hostname,
        )
      ) {
        validatedRegistrationEndpoint = registrationEndpointUrl.toString();
      }
    } catch {
      // Dynamic registration is optional; ignore an unsafe endpoint while
      // preserving otherwise usable authorization-server metadata.
    }
  }

  return {
    // Preserve the advertised issuer spelling for exact RFC 9207 response binding.
    issuer,
    authorizationResponseIssParameterSupported:
      payload.authorization_response_iss_parameter_supported === true,
    authorizationEndpoint: authorizationEndpointUrl.toString(),
    tokenEndpoint: tokenEndpointUrl.toString(),
    registrationEndpoint: validatedRegistrationEndpoint,
    scopesSupported: readStringArray(payload, 'scopes_supported'),
    ...(Array.isArray(payload.token_endpoint_auth_methods_supported)
      ? {
          tokenEndpointAuthMethodsSupported: readStringArray(
            payload,
            'token_endpoint_auth_methods_supported',
          ),
        }
      : {}),
    clientIdMetadataDocumentSupported:
      payload.client_id_metadata_document_supported === true,
    ...(Array.isArray(payload.code_challenge_methods_supported)
      ? {
          codeChallengeMethodsSupported: readStringArray(
            payload,
            'code_challenge_methods_supported',
          ),
        }
      : {}),
  };
}

/**
 * Whether the server takes PKCE with S256, which every sign-in here sends.
 * The MCP authorization spec has clients verify this from metadata and refuse
 * to proceed when `code_challenge_methods_supported` is absent, since PKCE
 * support cannot be discovered any other way.
 */
export function supportsPkceS256(
  metadata: Pick<AuthorizationServerMetadata, 'codeChallengeMethodsSupported'>,
): boolean {
  return metadata.codeChallengeMethodsSupported?.includes('S256') ?? false;
}

export function isAccessTokenFresh(expiresAt: string | undefined): boolean {
  if (!expiresAt) {
    return true;
  }

  const timestamp = Date.parse(expiresAt);
  return Number.isFinite(timestamp) && timestamp > Date.now() + 60_000;
}

export type OAuthFetch = (url: string, init?: RequestInit) => Promise<Response>;
export type OAuthErrorCode =
  | 'transient'
  | 'invalid_grant'
  | 'invalid_client'
  | 'unauthorized_client'
  | 'unsupported_redirect'
  | 'registration_unavailable'
  /**
   * The registration endpoint refused by policy: it takes only clients its
   * operator approved (an allowlist, trusted partners, a host policy, a
   * disabled endpoint or a client quota), whatever this client sends.
   */
  | 'registration_refused'
  | 'invalid_metadata';

/**
 * Which approval a `registration_refused` endpoint wants, read from the same
 * status, `error` and description that made it a refusal:
 *
 * - `partner_only`: only pre-registered clients or trusted partners, or a
 *   redirect allowlist (`registration_not_supported`). It refuses this
 *   callback; a desktop's loopback registration can still pass (Dropbox).
 * - `initial_access_token`: a 401, or a 400 or 403 asking for an initial
 *   access token or authorization (`insufficient_scope`, `invalid_token`).
 * - `disabled`: registration is turned off.
 * - `vendor_not_approved`: only approved vendors, clients or apps, or an
 *   unapproved software statement (ZoomInfo).
 * - `rate_limited`: a client quota ("Too many clients").
 * - `policy`: any other refusal, such as a host policy (Okta "Trusted Hosts").
 *
 * Only `partner_only` is about where the client signs in from; every other
 * reason refuses a registration that sends no credential, from anywhere.
 */
export type RegistrationRefusalReason =
  | 'partner_only'
  | 'initial_access_token'
  | 'disabled'
  | 'vendor_not_approved'
  | 'rate_limited'
  | 'policy';

/** The step of a sign-in an upstream request belongs to. */
export type OAuthStage =
  | 'protected_resource_metadata'
  | 'authorization_server_metadata'
  | 'initialize'
  | 'registration'
  | 'token';

/** Why an upstream request gave nothing usable. */
export type OAuthAttemptOutcome =
  /** 404 or 405: nothing is published here. */
  | 'not_found'
  /** Any other 4xx but 429. */
  | 'rejected'
  /** A network error, timeout, 429 or 5xx: the only outcome worth a retry. */
  | 'unavailable'
  /** The URL, or a redirect it answered with, is not a public HTTPS URL. */
  | 'unsafe_url'
  /** A response that is not usable OAuth data. */
  | 'unusable';

/**
 * One upstream request that gave nothing usable, for diagnostics. It never
 * carries a query, credential, token or code: a URL built from the MCP
 * server's address shows only a redacted path shape, a provider's URL shows
 * only its origin, and `error` is a known OAuth code or `other`. A provider's
 * free-text description is never kept: it can echo an email, tenant or token.
 */
export interface OAuthAttempt {
  readonly stage: OAuthStage;
  /**
   * The origin, or for a URL built from the MCP server's address its redacted
   * path shape (see {@link resourceDiagnosticUrl}); never a query.
   */
  readonly url: string;
  readonly outcome: OAuthAttemptOutcome;
  readonly status?: number;
  /** The provider's OAuth `error` code when it is a known one, else `other`. */
  readonly error?: string;
  /** Our own reason a response was unusable. */
  readonly reason?: string;
  /** Closed class of a request that threw before any response. */
  readonly cause?: OAuthNetworkCause;
}

export type OAuthNetworkCause = 'timeout' | 'dns' | 'tls' | 'refused' | 'other';

const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);
const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN']);
const TLS_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
]);

function networkCauseOfCode(code: unknown): OAuthNetworkCause | undefined {
  if (typeof code !== 'string') return undefined;
  if (TIMEOUT_CODES.has(code)) return 'timeout';
  if (DNS_CODES.has(code)) return 'dns';
  if (code === 'ECONNREFUSED') return 'refused';
  if (
    TLS_CODES.has(code) ||
    /^(?:CERT_|ERR_TLS_|ERR_SSL_|UNABLE_TO_)/.test(code)
  )
    return 'tls';
  return undefined;
}

/**
 * Classifies a thrown fetch by its error codes along the `cause` chain (and
 * an AggregateError's first error); a message is never read or kept.
 */
function oauthNetworkCause(error: unknown): OAuthNetworkCause {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth++) {
    if (typeof current !== 'object' || current === null) break;
    if (Reflect.get(current, 'name') === 'TimeoutError') return 'timeout';
    const cause = networkCauseOfCode(Reflect.get(current, 'code'));
    if (cause) return cause;
    const errors: unknown = Reflect.get(current, 'errors');
    const first: unknown = Array.isArray(errors) ? errors[0] : undefined;
    const nested =
      typeof first === 'object' && first !== null
        ? networkCauseOfCode(Reflect.get(first, 'code'))
        : undefined;
    if (nested) return nested;
    current = Reflect.get(current, 'cause');
  }
  return 'other';
}

export type OAuthAttemptObserver = (attempt: OAuthAttempt) => void;

export class OAuthError extends Error {
  readonly requiresReauthorization: boolean;
  /** Set only on `registration_refused`: which approval the endpoint wants. */
  readonly refusalReason?: RegistrationRefusalReason;
  constructor(
    readonly code: OAuthErrorCode,
    /** The request that failed, when one did; safe to log. */
    readonly attempt?: OAuthAttempt,
    refusalReason?: RegistrationRefusalReason,
  ) {
    super(code);
    this.name = 'OAuthError';
    if (refusalReason) this.refusalReason = refusalReason;
    this.requiresReauthorization = [
      'invalid_grant',
      'invalid_client',
      'unauthorized_client',
    ].includes(code);
  }
}

/**
 * A URL as diagnostics may show it: the origin only. An authorization
 * server's paths can carry a tenant or account id, so the endpoint kind is
 * the attempt's `stage`, not its path.
 */
export function diagnosticUrl(value: string | URL): string {
  try {
    return new URL(value).origin;
  } catch {
    return 'invalid-url';
  }
}

/**
 * The only path segments a diagnostic may show for a URL built from the MCP
 * URL: well-known discovery names and MCP's own transport words (`/mcp`,
 * `/sse`, `/api/v1/mcp`, `/messages`). Any other word may be a per-user key,
 * however ordinary it looks, so it shows as `*`.
 */
const LOGGABLE_PATH_SEGMENTS = new Set([
  '.well-known',
  'oauth-protected-resource',
  'oauth-authorization-server',
  'openid-configuration',
  'mcp',
  'sse',
  'api',
  'http',
  'stream',
  'message',
  'messages',
]);

/** An API version segment (`v1`, `v20`). */
const VERSION_PATH_SEGMENT = /^v\d{1,3}$/;

/**
 * A URL built from the MCP server's own address, as diagnostics may show it.
 * Hosted MCP servers may put a per-user secret in the path
 * (`/api/mcp/s/<key>/mcp`), so every segment outside a fixed allowlist of
 * discovery and transport words or a version shows as `*`. Never the query.
 */
export function resourceDiagnosticUrl(value: string | URL): string {
  try {
    const url = new URL(value);
    const path = url.pathname
      .split('/')
      .map((segment): string =>
        segment === '' ||
        LOGGABLE_PATH_SEGMENTS.has(segment) ||
        VERSION_PATH_SEGMENT.test(segment)
          ? segment
          : '*',
      )
      .join('/');
    return `${url.origin}${path}`;
  } catch {
    return 'invalid-url';
  }
}

/**
 * The diagnostic URL for a stage: protected-resource metadata and initialize
 * URLs come from the user's MCP URL, so only their redacted shape is shown.
 */
function stageDiagnosticUrl(stage: OAuthStage, value: string | URL): string {
  return stage === 'protected_resource_metadata' || stage === 'initialize'
    ? resourceDiagnosticUrl(value)
    : diagnosticUrl(value);
}

export function oauthStatusOutcome(status: number): OAuthAttemptOutcome {
  if (status === 404 || status === 405) return 'not_found';
  if (status === 429 || status >= 500) return 'unavailable';
  return 'rejected';
}

/**
 * OAuth `error` codes a log may name (RFC 6749 §4.1.2.1 and §5.2, RFC 6750
 * §3.1, RFC 7591 §3.2.2, RFC 8707 §2, RFC 9449 §12.2). A provider can put
 * anything in `error`, including a code or token it echoes back, so every
 * other value is logged as `other`.
 */
const LOGGABLE_OAUTH_ERROR_CODES = new Set([
  'invalid_request',
  'invalid_client',
  'invalid_grant',
  'unauthorized_client',
  'unsupported_grant_type',
  'unsupported_response_type',
  'invalid_scope',
  'access_denied',
  'server_error',
  'temporarily_unavailable',
  'invalid_token',
  'insufficient_scope',
  'invalid_redirect_uri',
  'invalid_client_metadata',
  'invalid_software_statement',
  'unapproved_software_statement',
  'registration_not_supported',
  'invalid_target',
  'invalid_dpop_proof',
  'use_dpop_nonce',
]);

function diagnosticErrorCode(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return LOGGABLE_OAUTH_ERROR_CODES.has(value) ? value : 'other';
}

/** How many bytes of an error response are read; a longer one is ignored. */
const MAX_ERROR_BODY_BYTES = 16 * 1024;

/**
 * A non-success response's JSON body, or null when it is unreadable, not
 * JSON, or longer than {@link MAX_ERROR_BODY_BYTES}: only its short `error`
 * fields are ever used, so a larger body is never read or parsed.
 */
async function readErrorPayload(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ERROR_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

export function buildOAuthDiscoveryHeaders(
  definition: { headers?: Record<string, string> },
  config: { extraHeaders?: Record<string, string>; authToken?: string },
): Record<string, string> {
  return {
    ...definition.headers,
    ...config.extraHeaders,
    ...(config.authToken
      ? { Authorization: `Bearer ${config.authToken}` }
      : {}),
  };
}

const REDIRECT_URI_MENTION = /redirect[\s_-]*ur[il]/i;
const CLIENT_AUTHENTICATION_MENTION =
  /token[\s_-]*endpoint[\s_-]*auth|auth(?:entication)?[\s_-]*method/i;

/**
 * Registration `error` codes that refuse this client by policy: dynamic
 * registration is off, or only approved software may register.
 */
const REGISTRATION_REFUSAL_ERRORS = new Set([
  'registration_not_supported',
  'unapproved_software_statement',
  'access_denied',
]);

/**
 * Words a registration refusal uses when the endpoint takes only approved
 * clients, whatever this one sends: "registration is not supported", "Only
 * pre-registered MCP trusted partners", "not found in approved vendors",
 * "Policy 'Trusted Hosts' rejected", "registration is currently disabled",
 * "Too many clients". A bare "not allowed" is not enough: "Confidential
 * clients are not allowed" refuses one kind of client another method fixes.
 */
const REGISTRATION_REFUSAL_MENTION =
  /registration (?:is )?(?:currently )?(?:not (?:allowed|permitted|supported|enabled)|disabled)|pre-?registered|trusted partners?|approved (?:vendors?|clients?|apps?|applications?)|trusted hosts?|too many clients/i;

/** Words a partner-only refusal uses: only pre-registered clients pass. */
const PARTNER_ONLY_MENTION = /pre-?registered|trusted partners?/i;
/** A redirect allowlist: some callbacks register, this one does not. */
const REDIRECT_ALLOWLIST_MENTION =
  /(?:allow|white)[\s_-]*list|allowed[\s_-]*redirect/i;
const DISABLED_MENTION =
  /registration (?:is )?(?:currently )?(?:disabled|not enabled)/i;
const APPROVED_VENDOR_MENTION =
  /approved (?:vendors?|clients?|apps?|applications?)/i;
const CLIENT_QUOTA_MENTION = /too many clients/i;
const HOST_POLICY_MENTION = /trusted hosts?/i;
const INITIAL_ACCESS_TOKEN_MENTION =
  /initial[\s_-]*access[\s_-]*token|authori[sz]ation (?:is )?required|insufficient[\s_-]*scope/i;
const INITIAL_ACCESS_TOKEN_ERRORS = new Set([
  'insufficient_scope',
  'invalid_token',
]);

/**
 * Which approval a refused registration wants (see
 * {@link RegistrationRefusalReason}). The description's own words come first,
 * so a host policy answered as `insufficient_scope` (Okta) stays a policy and a
 * partner-only refusal names partners however it is coded. A refusal with no
 * telling words is `policy`, which no desktop sign-in is promised for.
 */
function registrationRefusalReason(
  status: number,
  error: unknown,
  description: string | undefined,
): RegistrationRefusalReason {
  const text = description ?? '';
  if (CLIENT_QUOTA_MENTION.test(text)) return 'rate_limited';
  if (APPROVED_VENDOR_MENTION.test(text)) return 'vendor_not_approved';
  if (DISABLED_MENTION.test(text)) return 'disabled';
  if (HOST_POLICY_MENTION.test(text)) return 'policy';
  if (
    PARTNER_ONLY_MENTION.test(text) ||
    (REDIRECT_URI_MENTION.test(text) && REDIRECT_ALLOWLIST_MENTION.test(text))
  )
    return 'partner_only';
  if (error === 'registration_not_supported') return 'partner_only';
  if (error === 'unapproved_software_statement') return 'vendor_not_approved';
  if (
    status === 401 ||
    INITIAL_ACCESS_TOKEN_MENTION.test(text) ||
    (typeof error === 'string' && INITIAL_ACCESS_TOKEN_ERRORS.has(error))
  )
    return 'initial_access_token';
  return 'policy';
}

/**
 * Whether a registration error refuses our callback. `invalid_client_metadata`
 * covers every client field, so its description must be about the redirect
 * URI and not about how the client authenticates.
 */
function isRedirectRejection(error: unknown, description: unknown): boolean {
  if (error === 'invalid_redirect_uri') return true;
  return (
    error === 'invalid_client_metadata' &&
    typeof description === 'string' &&
    REDIRECT_URI_MENTION.test(description) &&
    !CLIENT_AUTHENTICATION_MENTION.test(description)
  );
}

/**
 * Whether a registration error refuses this client by policy rather than for
 * something it sent. Checked after the redirect URI and client authentication
 * classifications, so an error about either keeps its own meaning: a 401 or
 * 403, a refusal code, or a description in {@link REGISTRATION_REFUSAL_MENTION}
 * that names neither.
 */
function isRegistrationRefusal(
  status: number,
  error: unknown,
  description: string | undefined,
): boolean {
  if (status === 401 || status === 403) return true;
  if (typeof error === 'string' && REGISTRATION_REFUSAL_ERRORS.has(error))
    return true;
  return (
    description !== undefined &&
    !REDIRECT_URI_MENTION.test(description) &&
    REGISTRATION_REFUSAL_MENTION.test(description)
  );
}

/**
 * A registration error's prose: the OAuth `error_description`, else the
 * `message` some frameworks answer with instead (`{"statusCode":400,
 * "error":"Bad Request","message":"..."}`).
 */
function registrationErrorText(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  if (typeof payload.error_description === 'string')
    return payload.error_description;
  return typeof payload.message === 'string' ? payload.message : undefined;
}

async function requestJson(
  fetch: OAuthFetch,
  url: string,
  init: RequestInit,
  stage: 'registration' | 'token',
): Promise<Record<string, unknown>> {
  const failure = (
    code: OAuthErrorCode,
    attempt: Omit<OAuthAttempt, 'stage' | 'url'>,
    refusalReason?: RegistrationRefusalReason,
  ): OAuthError =>
    new OAuthError(
      code,
      { stage, url: diagnosticUrl(url), ...attempt },
      refusalReason,
    );
  try {
    parseDiscoveredPublicHttpsUrl(url, 'OAuth endpoint');
  } catch {
    throw failure('transient', { outcome: 'unsafe_url' });
  }
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      redirect: 'error',
      signal: init.signal ?? AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw failure('transient', {
      outcome: 'unavailable',
      cause: oauthNetworkCause(error),
    });
  }
  if (response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    if (!isRecord(payload))
      throw failure('invalid_metadata', {
        outcome: 'unusable',
        status: response.status,
      });
    return payload;
  }
  const payload = await readErrorPayload(response);
  const error = isRecord(payload) ? payload.error : undefined;
  const description =
    stage === 'registration'
      ? registrationErrorText(payload)
      : isRecord(payload)
        ? payload.error_description
        : undefined;
  const errorCode = diagnosticErrorCode(error);
  const attempt = {
    outcome: oauthStatusOutcome(response.status),
    status: response.status,
    ...(errorCode ? { error: errorCode } : {}),
  };
  // A 429 is a rate limit whatever its body says, so it stays transient.
  const refused =
    response.status >= 400 && response.status < 500 && response.status !== 429;
  if (refused && stage === 'registration') {
    // Registration classifies its own refusals: a token-grant error code
    // means nothing here. A refused callback comes first, then
    // `invalid_client`, which stays itself so the caller can retry once, then
    // a refused client authentication method, which another method may fix.
    // A policy refusal (approved clients only) is `registration_refused`;
    // any other (other metadata wanted) is `registration_unavailable`.
    const text = typeof description === 'string' ? description : undefined;
    if (isRedirectRejection(error, text))
      throw failure('unsupported_redirect', attempt);
    if (error === 'invalid_client') throw failure('invalid_client', attempt);
    if (text !== undefined && CLIENT_AUTHENTICATION_MENTION.test(text))
      throw failure('registration_unavailable', attempt);
    if (isRegistrationRefusal(response.status, error, text))
      throw failure(
        'registration_refused',
        attempt,
        registrationRefusalReason(response.status, error, text),
      );
    throw failure('registration_unavailable', attempt);
  }
  if (
    refused &&
    (error === 'invalid_grant' ||
      error === 'invalid_client' ||
      error === 'unauthorized_client')
  )
    throw failure(error, attempt);
  throw failure('transient', attempt);
}

/**
 * One deadline and one request count shared by every request a sign-in sends,
 * however many fallbacks discovery walks, so a slow or redirecting host cannot
 * hold a start open for the sum of each request's own timeout. A request past
 * either limit fails like a network error; one in flight at the deadline is
 * aborted. Each request keeps its own timeout too. Call `dispose` when done.
 */
export function createOAuthRequestBudget(
  fetch: OAuthFetch,
  limits: { readonly timeoutMs: number; readonly maxRequests: number },
): { readonly fetch: OAuthFetch; dispose(): void } {
  const deadline = new AbortController();
  const timer = setTimeout((): void => {
    deadline.abort(new Error('OAuth request deadline passed'));
  }, limits.timeoutMs);
  let remaining = limits.maxRequests;
  return {
    fetch: async (url, init): Promise<Response> => {
      if (deadline.signal.aborted || remaining <= 0)
        throw new Error('OAuth request budget exhausted');
      remaining -= 1;
      const signal = init?.signal
        ? AbortSignal.any([init.signal, deadline.signal])
        : deadline.signal;
      return fetch(url, { ...init, signal });
    },
    dispose: (): void => {
      clearTimeout(timer);
    },
  };
}

const METADATA_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_METADATA_REDIRECTS = 5;

/** A redirect's `Location` against the URL that answered it, if valid. */
export function resolveLocation(location: string, base: URL): URL | null {
  try {
    return new URL(location, base);
  } catch {
    return null;
  }
}

/**
 * One metadata document, or null when this URL gives none. Every failure,
 * including an unsafe redirect, only moves discovery on to its next
 * candidate; the observer hears why.
 */
async function metadataJson(
  fetch: OAuthFetch,
  candidate: URL,
  stage: OAuthStage,
  observe?: OAuthAttemptObserver,
): Promise<Record<string, unknown> | null> {
  const skip = (
    outcome: OAuthAttemptOutcome,
    url: URL,
    status?: number,
    cause?: OAuthNetworkCause,
  ): null => {
    observe?.({
      stage,
      url: stageDiagnosticUrl(stage, url),
      outcome,
      ...(status === undefined ? {} : { status }),
      ...(cause === undefined ? {} : { cause }),
    });
    return null;
  };
  let url = candidate;
  // Metadata may redirect, but every hop must be validated by the host's fetch.
  for (let redirects = 0; ; redirects++) {
    try {
      parseDiscoveredPublicHttpsUrl(url.toString(), 'OAuth metadata');
    } catch {
      return skip('unsafe_url', url);
    }
    let response: Response;
    try {
      response = await fetch(url.toString(), {
        headers: { Accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      return skip('unavailable', url, undefined, oauthNetworkCause(error));
    }
    if (METADATA_REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      const next = location === null ? null : resolveLocation(location, url);
      if (!next || redirects === MAX_METADATA_REDIRECTS)
        return skip('unusable', url, response.status);
      url = next;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      return skip(oauthStatusOutcome(response.status), url, response.status);
    }
    const payload: unknown = await response.json().catch(() => null);
    return isRecord(payload) ? payload : skip('unusable', url, response.status);
  }
}

/**
 * The `resource_metadata` parameter of a `WWW-Authenticate` challenge (RFC
 * 9728 §5.1), whether quoted or, as some servers send it, a bare token.
 */
export function parseResourceMetadataChallenge(
  header: string | null | undefined,
): string | undefined {
  const match =
    /(?:^|[\s,])resource_metadata\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s",]+))/i.exec(
      header ?? '',
    );
  if (!match) return undefined;
  return match[1] === undefined ? match[2] : match[1].replace(/\\(.)/g, '$1');
}

/**
 * The metadata URL a challenge names, when it is on the MCP server's site. A
 * server may publish it on a sibling host (`app.example.com` for
 * `api.example.com`); the resource it describes must still be the MCP
 * server's own origin (see {@link normalizeResourceIdentifier}).
 */
function challengeMetadataUrl(value: string, mcpUrl: URL): URL | null {
  try {
    const url = parseDiscoveredPublicHttpsUrl(value, 'Resource metadata');
    return isSameRegistrableDomain(url.hostname, mcpUrl.hostname) ? url : null;
  } catch {
    return null;
  }
}

export async function discoverProtectedResourceMetadata(
  mcpUrl: string,
  fetch: OAuthFetch,
  options: {
    /** The URL a 401 challenge named; replaces the well-known candidates. */
    resourceMetadataUrl?: string;
    observe?: OAuthAttemptObserver;
  } = {},
): Promise<ProtectedResourceMetadata | null> {
  const mcp = parseDiscoveredPublicHttpsUrl(mcpUrl, 'MCP URL');
  let urls = buildProtectedResourceMetadataUrls(mcpUrl);
  if (options.resourceMetadataUrl !== undefined) {
    const challenged = challengeMetadataUrl(options.resourceMetadataUrl, mcp);
    if (!challenged)
      options.observe?.({
        stage: 'protected_resource_metadata',
        url: resourceDiagnosticUrl(options.resourceMetadataUrl),
        outcome: 'unsafe_url',
      });
    urls = challenged ? [challenged] : [];
  }
  for (const url of urls) {
    const payload = await metadataJson(
      fetch,
      url,
      'protected_resource_metadata',
      options.observe,
    );
    if (!payload) continue;
    const { normalized, expectedResource } = normalizeResourceIdentifier(
      payload,
      mcpUrl,
      mcp.origin,
    );
    const metadata = parseProtectedResourceMetadata(
      normalized,
      expectedResource,
    );
    if (metadata) return metadata;
    options.observe?.({
      stage: 'protected_resource_metadata',
      url: resourceDiagnosticUrl(url),
      outcome: 'unusable',
    });
  }
  return null;
}

/**
 * Servers on the 2025-03-26 MCP authorization spec publish no protected
 * resource metadata: the authorization server is the MCP server's own origin.
 * Answers what such a server would have published, once the origin serves
 * valid authorization-server metadata.
 */
export async function discoverOriginAuthorizationServer(
  mcpUrl: string,
  fetch: OAuthFetch,
  options: { observe?: OAuthAttemptObserver } = {},
): Promise<ProtectedResourceMetadata | null> {
  const origin = new URL(
    parseDiscoveredPublicHttpsUrl(mcpUrl, 'MCP URL').origin,
  ).toString();
  const metadata = await discoverAuthorizationServerMetadata(
    origin,
    fetch,
    options,
  );
  return metadata
    ? {
        resource: buildCanonicalResourceUrl(mcpUrl),
        authorizationServers: [origin],
        scopesSupported: [],
      }
    : null;
}

/**
 * Servers publish the resource identifier as the exact MCP URL, as its origin,
 * or not at all. A missing identifier binds to the canonical MCP URL, a
 * same-origin identifier is accepted as published, and anything else stays
 * bound to the canonical URL so the parser rejects it.
 */
export function normalizeResourceIdentifier(
  payload: Record<string, unknown>,
  mcpUrl: string,
  mcpOrigin: string,
): { normalized: Record<string, unknown>; expectedResource: string } {
  const canonical = buildCanonicalResourceUrl(mcpUrl);
  const resource = payload.resource;
  if (resource === undefined)
    return {
      normalized: { ...payload, resource: canonical },
      expectedResource: canonical,
    };
  if (typeof resource !== 'string')
    return { normalized: payload, expectedResource: canonical };
  return {
    normalized: payload,
    expectedResource: isSameOriginUrl(resource, mcpOrigin, 'Protected resource')
      ? resource
      : canonical,
  };
}

/**
 * Tries every RFC 8414 and OpenID discovery URL for the issuer (Cognito
 * refuses the first two with 400 and serves the third). Null when none is
 * usable; `transient` only when none could be reached at all.
 */
export async function discoverAuthorizationServerMetadata(
  issuer: string,
  fetch: OAuthFetch,
  options: { observe?: OAuthAttemptObserver } = {},
): Promise<AuthorizationServerMetadata | null> {
  const expectedIssuer = parseDiscoveredPublicHttpsUrl(
    issuer,
    'OAuth issuer',
  ).toString();
  let reached = false;
  const observe = (attempt: OAuthAttempt): void => {
    if (attempt.outcome !== 'unavailable') reached = true;
    options.observe?.(attempt);
  };
  for (const url of buildAuthorizationServerMetadataUrls(issuer)) {
    const payload = await metadataJson(
      fetch,
      url,
      'authorization_server_metadata',
      observe,
    );
    if (!payload) continue;
    const metadata = parseAuthorizationServerMetadata(payload, expectedIssuer);
    if (metadata) return metadata;
    observe({
      stage: 'authorization_server_metadata',
      url: diagnosticUrl(url),
      outcome: 'unusable',
    });
  }
  if (!reached) throw new OAuthError('transient');
  return null;
}

/**
 * The methods to register a client with, most preferred first. A public
 * client needs no stored secret, so `none` wins when offered. A server that
 * omits the list takes `client_secret_basic` (RFC 8414 §2), though some of
 * those take public clients too. Empty when no method a client here can use
 * is offered.
 */
export function registrationTokenEndpointAuthMethods(
  metadata: TokenEndpointAuthMetadata,
): TokenEndpointAuthMethod[] {
  if (metadata.tokenEndpointAuthMethodsSupported === undefined)
    return ['client_secret_basic', 'none'];
  const method =
    selectTokenEndpointAuthMethod(metadata, false) ??
    selectTokenEndpointAuthMethod(metadata, true);
  return method ? [method] : [];
}

export interface ClientRegistration {
  clientId: string;
  clientSecret?: string;
  clientSecretExpiresAt?: Date;
  /** The method a registration response named, when it named one. */
  tokenEndpointAuthMethod?: TokenEndpointAuthMethod;
}
export async function registerDynamicClient(input: {
  registrationEndpoint: string;
  redirectUri: string;
  clientName: string;
  fetch: OAuthFetch;
  /** The method to ask for; `none` registers a public client. */
  tokenEndpointAuthMethod?: TokenEndpointAuthMethod;
}): Promise<ClientRegistration> {
  const payload = await requestJson(
    input.fetch,
    input.registrationEndpoint,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_name: input.clientName,
        redirect_uris: [input.redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: input.tokenEndpointAuthMethod ?? 'none',
      }),
    },
    'registration',
  );
  const unusable = (code: OAuthErrorCode, reason: string): OAuthError =>
    new OAuthError(code, {
      stage: 'registration',
      url: diagnosticUrl(input.registrationEndpoint),
      outcome: 'unusable',
      reason,
    });
  const clientId = readString(payload, 'client_id');
  if (!clientId) throw unusable('invalid_metadata', 'missing_client_id');
  const clientSecret = readString(payload, 'client_secret');
  const method = readString(payload, 'token_endpoint_auth_method');
  // A client that must sign its token requests (`private_key_jwt`) or use
  // mutual TLS is one no client here can be.
  if (method !== undefined && !isTokenEndpointAuthMethod(method))
    throw unusable(
      'registration_unavailable',
      'unsupported_token_endpoint_auth_method',
    );
  if (method !== undefined && method !== 'none' && !clientSecret)
    throw unusable('invalid_metadata', 'missing_client_secret');
  // A response that names no method registered the one asked for (RFC 7591
  // §3.2.1 returns registered values; we keep what we requested). A secret
  // method still needs the secret: without one the server gave no client of
  // that kind, so the caller moves on to its next method.
  const requested = input.tokenEndpointAuthMethod ?? 'none';
  const registeredMethod =
    method ?? (requested === 'none' ? undefined : requested);
  if (method === undefined && requested !== 'none' && !clientSecret)
    throw unusable('registration_unavailable', 'missing_client_secret');
  const expiry = payload.client_secret_expires_at;
  let clientSecretExpiresAt: Date | undefined;
  if (expiry !== undefined) {
    if (
      typeof expiry !== 'number' ||
      !Number.isSafeInteger(expiry) ||
      expiry < 0
    )
      throw unusable('invalid_metadata', 'invalid_client_secret_expires_at');
    if (expiry !== 0) {
      clientSecretExpiresAt = new Date(expiry * 1000);
      if (!Number.isFinite(clientSecretExpiresAt.getTime()))
        throw unusable('invalid_metadata', 'invalid_client_secret_expires_at');
    }
  }
  return {
    clientId,
    clientSecret,
    clientSecretExpiresAt,
    ...(registeredMethod === undefined
      ? {}
      : { tokenEndpointAuthMethod: registeredMethod }),
  };
}

/**
 * A client's registration published as JSON at the HTTPS URL that is its
 * client ID (draft-ietf-oauth-client-id-metadata-document). A server that
 * takes such clients fetches it on the authorization request and allows only
 * the redirect URIs it lists. It never carries a secret.
 */
export interface ClientIdMetadataDocument {
  client_id: string;
  client_name: string;
  client_uri?: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: 'none';
}

export function buildClientIdMetadataDocument(input: {
  clientId: string;
  clientName: string;
  clientUri?: string;
  redirectUris: readonly string[];
}): ClientIdMetadataDocument {
  return {
    client_id: input.clientId,
    client_name: input.clientName,
    ...(input.clientUri ? { client_uri: input.clientUri } : {}),
    redirect_uris: [...input.redirectUris],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}

/**
 * Whether a URL can be a client ID naming its own metadata document: a
 * public HTTPS URL with a path, written in canonical form, without
 * credentials, query, fragment or dot segments. Servers compare client IDs as
 * plain strings, so the URL must be exactly the one the document names.
 */
export function isClientIdMetadataDocumentUrl(value: string): boolean {
  let url: URL;
  try {
    url = parseDiscoveredPublicHttpsUrl(value, 'Client ID metadata document');
  } catch {
    return false;
  }
  return (
    url.toString() === value &&
    url.pathname !== '/' &&
    !value.includes('?') &&
    !value.includes('#')
  );
}

/**
 * Whether to sign in to this server with a Client ID Metadata Document rather
 * than register a client: the MCP authorization spec prefers it to dynamic
 * registration wherever the server advertises it. The client is public, so a
 * server that lists its token endpoint methods must list `none`.
 *
 * Every such server sees the same client ID and callback, so nothing in the
 * redirect itself says which server answered: a malicious server could relay
 * the authorization request to an honest one and receive its code at its own
 * token endpoint (a mix-up, RFC 9700 §4.4). Only the server's RFC 9207 `iss`
 * tells them apart, so a server must advertise
 * `authorization_response_iss_parameter_supported`, and its response's `iss`
 * must equal its issuer before the code is sent anywhere.
 */
export function supportsClientIdMetadataDocument(
  metadata: Pick<
    AuthorizationServerMetadata,
    | 'clientIdMetadataDocumentSupported'
    | 'authorizationResponseIssParameterSupported'
    | 'tokenEndpointAuthMethodsSupported'
  >,
): boolean {
  return (
    metadata.clientIdMetadataDocumentSupported &&
    metadata.authorizationResponseIssParameterSupported &&
    (metadata.tokenEndpointAuthMethodsSupported?.includes('none') ?? true)
  );
}

/**
 * Google issues a refresh token only when `access_type=offline` is sent with a
 * fresh consent; re-authorizing an already-consented client otherwise returns
 * an access token alone. Scoped to Google's exact authorization origin so no
 * other provider's request changes.
 */
export function providerAuthorizationParameters(
  authorizationEndpoint: URL,
): Record<string, string> {
  return authorizationEndpoint.origin === GOOGLE_AUTHORIZATION_ORIGIN
    ? { access_type: 'offline', prompt: 'consent' }
    : {};
}

const ACCOUNT_CHOOSER_PROMPT = 'select_account';

export async function buildAuthorizationUrl(input: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  state: string;
  codeVerifier: string;
  scopes?: string[];
  /**
   * Ask the provider to let the person choose which account signs in
   * (`prompt=select_account`), for another account of a connector they
   * already hold (CAN-6226). Plain OAuth servers ignore the value; an OpenID
   * Connect server that answers the request with an error instead is asked
   * again without it (`withoutAccountChooser`, CAN-7198).
   */
  selectAccount?: boolean;
}): Promise<string> {
  const url = parseDiscoveredPublicHttpsUrl(
    input.authorizationEndpoint,
    'Authorization endpoint',
  );
  const providerParameters = providerAuthorizationParameters(url);
  const prompt = [
    ...(input.selectAccount ? [ACCOUNT_CHOOSER_PROMPT] : []),
    ...(providerParameters.prompt ? [providerParameters.prompt] : []),
  ].join(' ');
  for (const [key, value] of Object.entries({
    ...providerParameters,
    ...(prompt ? { prompt } : {}),
    response_type: 'code',
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    resource: buildCanonicalResourceUrl(input.resource),
    state: input.state,
    code_challenge_method: 'S256',
    code_challenge: await createPkceChallenge(input.codeVerifier),
  }))
    url.searchParams.set(key, value);
  if (input.scopes?.length)
    url.searchParams.set('scope', input.scopes.join(' '));
  return url.toString();
}

/**
 * The same authorization request without `prompt=select_account`, under a
 * new `state`, or null when the request never asked for the account chooser
 * (CAN-7198). Every other parameter, including another prompt value such as
 * Google's `consent`, is kept, so only the chooser is dropped.
 */
export function withoutAccountChooser(
  authorizationUrl: string,
  state: string,
): string | null {
  const url = new URL(authorizationUrl);
  const prompts = (url.searchParams.get('prompt') ?? '')
    .split(' ')
    .filter(Boolean);
  if (!prompts.includes(ACCOUNT_CHOOSER_PROMPT)) return null;
  const kept = prompts.filter((value) => value !== ACCOUNT_CHOOSER_PROMPT);
  if (kept.length) url.searchParams.set('prompt', kept.join(' '));
  else url.searchParams.delete('prompt');
  url.searchParams.set('state', state);
  return url.toString();
}

export interface TokenRequest extends ClientRegistration {
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
  tokenEndpoint: string;
  resource: string;
  fetch: OAuthFetch;
}
async function requestToken(
  input: TokenRequest,
  fields: Record<string, string>,
): Promise<TokenExchangeResult> {
  const client = tokenEndpointClientAuthentication(input);
  const body = new URLSearchParams({
    ...fields,
    ...client.body,
    resource: buildCanonicalResourceUrl(input.resource),
  });
  const payload = await requestJson(
    input.fetch,
    input.tokenEndpoint,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        ...client.headers,
      },
      body: body.toString(),
    },
    'token',
  );
  try {
    return parseTokenResponse(payload);
  } catch {
    throw new OAuthError('transient', {
      stage: 'token',
      url: diagnosticUrl(input.tokenEndpoint),
      outcome: 'unusable',
      reason: 'missing_access_token',
    });
  }
}
export function exchangeAuthorizationCode(
  input: TokenRequest & {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  },
): Promise<TokenExchangeResult> {
  return requestToken(input, {
    grant_type: 'authorization_code',
    code: input.code,
    code_verifier: input.codeVerifier,
    redirect_uri: input.redirectUri,
  });
}
export function refreshAccessToken(
  input: TokenRequest & { refreshToken: string },
): Promise<TokenExchangeResult> {
  return requestToken(input, {
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
  });
}

export {
  MCP_ACCEPT_HEADER,
  MCP_MAX_RESPONSE_BYTES,
  readMcpJsonRpcMessage,
  type McpJsonRpcMessage,
} from './json-rpc-response';
