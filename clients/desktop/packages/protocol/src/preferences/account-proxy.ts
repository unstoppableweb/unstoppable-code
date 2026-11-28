import {
  ACCOUNT_PROXY_ROUTING_STRATEGIES,
  type AccountProxyRoutingStrategy,
} from './types';

export type AccountProxyErrorCode =
  | 'invalid-url'
  | 'insecure-url'
  | 'unreachable'
  | 'not-proxy'
  | 'too-old'
  | 'unauthorized'
  | 'blocked'
  | 'management-disabled'
  | 'remote-management-disabled'
  | 'storage-unavailable'
  /** No proxy release is published for this platform. */
  | 'local-unsupported'
  /** The proxy on this device could not be downloaded or started. */
  | 'local-failed'
  | 'unexpected';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Paths users paste that are not the server's base URL. */
const TRAILING_API_PATHS = [
  /\/v8\/management$/i,
  /\/v0\/management$/i,
  /\/v1$/i,
];

export type AccountProxyUrlResult =
  | { readonly ok: true; readonly url: string }
  | {
      readonly ok: false;
      readonly code: Extract<
        AccountProxyErrorCode,
        'invalid-url' | 'insecure-url'
      >;
    };

/**
 * Normalizes a server URL the user typed. HTTPS is required except for
 * loopback addresses, because the management key travels in every request.
 */
export function normalizeAccountProxyUrl(raw: string): AccountProxyUrlResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, code: 'invalid-url' };
  let parsed: URL;
  try {
    parsed = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`,
    );
  } catch {
    return { ok: false, code: 'invalid-url' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, code: 'invalid-url' };
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return { ok: false, code: 'invalid-url' };
  }
  if (parsed.protocol === 'http:' && !LOOPBACK_HOSTS.has(parsed.hostname)) {
    return { ok: false, code: 'insecure-url' };
  }
  let path = parsed.pathname.replace(/\/+$/, '');
  for (const pattern of TRAILING_API_PATHS) path = path.replace(pattern, '');
  return { ok: true, url: `${parsed.protocol}//${parsed.host}${path}` };
}

export function isAccountProxyRoutingStrategy(
  value: unknown,
): value is AccountProxyRoutingStrategy {
  return ACCOUNT_PROXY_ROUTING_STRATEGIES.some(
    (strategy) => strategy === value,
  );
}
