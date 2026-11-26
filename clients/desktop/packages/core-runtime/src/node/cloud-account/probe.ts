/**
 * The daemon's account probe (CAN-6997): the desktop probe's request
 * sequence, used to verify a key before `connectWithKey` saves it.
 */

/** Whether a request can carry this key as its bearer credential. */
export function isCloudAccountBearerKey(key: string): boolean {
  return /^[\x20-\x7e]+$/.test(key.trimEnd());
}

// Private so the authorization port can own the exported header helper.
function applyBearerHeader(headers: Headers, key: string): void {
  headers.delete('authorization');
  // Validate before Headers.set: its TypeError can quote the credential.
  if (!isCloudAccountBearerKey(key))
    throw new Error('Cloud account authorization is unavailable.');
  headers.set('authorization', `Bearer ${key.trimEnd()}`);
}

export type CloudAccountProbe =
  | {
      readonly kind: 'authenticated';
      readonly capabilities: readonly string[];
      /** The account response body; never logged. */
      readonly payload: unknown;
    }
  /** 401: the credential was deleted, expired or never valid. */
  | { readonly kind: 'rejected' }
  /** 403: inactive user or out-of-scope key; the snapshot is kept. */
  | { readonly kind: 'forbidden' }
  /** Network failure, timeout or non-auth server error: inconclusive. */
  | { readonly kind: 'offline' };

export interface CloudAccountProbeOptions {
  readonly fetch: typeof fetch;
  /** Throws when no Cloud is configured (local-only builds). */
  readonly baseUrl: () => string;
  readonly wellKnownPath: string;
  readonly accountPath: string;
  readonly timeoutMs?: number;
}

export const CLOUD_ACCOUNT_PROBE_TIMEOUT_MS = 15_000;

async function boundedFetch(
  options: CloudAccountProbeOptions,
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const deadline = AbortSignal.timeout(
    options.timeoutMs ?? CLOUD_ACCOUNT_PROBE_TIMEOUT_MS,
  );
  const response = await options.fetch(url, {
    ...init,
    redirect: 'error',
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  });
  // Auth rejection is conclusive even when its body fails or never finishes.
  if (response.status < 200 || response.status > 299) {
    void response.body?.cancel().catch(() => undefined);
    return { status: response.status, body: null };
  }
  // Keep the deadline active through the body, as the desktop probe does.
  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  return { status: response.status, body };
}

/** The desktop probe's request sequence: well-known capabilities, then account. */
export async function probeCloudAccount(
  options: CloudAccountProbeOptions,
  apiKey: string,
  signal?: AbortSignal,
): Promise<CloudAccountProbe> {
  let baseUrl: string;
  try {
    baseUrl = options.baseUrl();
  } catch {
    return { kind: 'offline' };
  }
  try {
    const wellKnown = await boundedFetch(
      options,
      `${baseUrl}${options.wellKnownPath}`,
      { headers: { Accept: 'application/json' } },
      signal,
    );
    if (wellKnown.status < 200 || wellKnown.status > 299)
      return { kind: 'offline' };
    const advertised: unknown =
      typeof wellKnown.body === 'object' && wellKnown.body !== null
        ? Reflect.get(wellKnown.body, 'capabilities')
        : undefined;
    let capabilities = Array.isArray(advertised)
      ? advertised.filter((item): item is string => typeof item === 'string')
      : [];
    const headers = new Headers({ Accept: 'application/json' });
    applyBearerHeader(headers, apiKey);
    const account = await boundedFetch(
      options,
      `${baseUrl}${options.accountPath}`,
      { headers },
      signal,
    );
    if (account.status === 401) return { kind: 'rejected' };
    if (account.status === 403) return { kind: 'forbidden' };
    if (account.status < 200 || account.status > 299)
      return { kind: 'offline' };
    const effective: unknown =
      typeof account.body === 'object' && account.body !== null
        ? Reflect.get(account.body, 'capabilities')
        : undefined;
    if (Array.isArray(effective))
      capabilities = effective.filter(
        (item): item is string => typeof item === 'string',
      );
    return { kind: 'authenticated', capabilities, payload: account.body };
  } catch {
    return { kind: 'offline' };
  }
}
