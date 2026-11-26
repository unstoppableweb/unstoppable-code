import type { DaemonCloudEndpoint } from '@canopy/core-runtime/node/cloud-account/daemon';

const NAMESPACE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * The build's Cloud endpoint (CAN-6997), or null when the build has none or
 * the inlined value is malformed: account services then make no request.
 * Same protocol rule as the app: https, or http only on localhost.
 */
export function readDaemonCloudEndpoint(
  value: unknown,
): DaemonCloudEndpoint | null {
  if (typeof value !== 'object' || value === null) return null;
  const baseUrl: unknown = Reflect.get(value, 'baseUrl');
  const wellKnownNamespace: unknown = Reflect.get(value, 'wellKnownNamespace');
  const apiNamespace: unknown = Reflect.get(value, 'apiNamespace');
  if (
    typeof baseUrl !== 'string' ||
    typeof wellKnownNamespace !== 'string' ||
    typeof apiNamespace !== 'string' ||
    !NAMESPACE.test(wellKnownNamespace) ||
    !NAMESPACE.test(apiNamespace)
  )
    return null;
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    return null;
  // A path prefix is allowed, as in the app; a query, fragment or userinfo
  // would corrupt every request URL built from it.
  if (url.search || url.hash || url.username || url.password) return null;
  return { baseUrl: trimmed, wellKnownNamespace, apiNamespace };
}
