import type { CloudAccountAuthority } from './authority';
import { hasCloudAccountCredential } from './record';
import {
  projectCloudAccountAccess,
  type CloudAccountAccessRead,
} from './access';

export type CloudAccountAuthorizationRefusal =
  | 'closed'
  | 'inactive'
  | 'unavailable'
  | 'signed-out'
  | 'session-expired'
  | 'stale-lease';

export class CloudAccountAuthorizationError extends Error {
  constructor(readonly reason: CloudAccountAuthorizationRefusal) {
    super('Cloud account authorization is unavailable.');
    this.name = 'CloudAccountAuthorizationError';
  }
}

export function applyCloudAccountHeader(headers: Headers, key: string): void {
  headers.delete('authorization');
  const value = key.trimEnd();
  // Validate before Headers.set: its TypeError can quote the credential.
  if (!value || !/^[\x20-\x7e]+$/.test(value))
    throw new CloudAccountAuthorizationError('unavailable');
  headers.set('authorization', `Bearer ${value}`);
}

export interface CloudAccountHeaderAuthorization {
  readonly credentialVersion?: string;
  apply(headers: Headers): void;
  release(): void;
}

/** Compatibility input from Electron and third-party gateway hosts. */
export type CloudAccountGatewayCredential =
  | string
  | { readonly token: string; readonly credentialVersion?: string }
  | CloudAccountHeaderAuthorization
  | null;

export interface CloudAccountGatewayAuthorization {
  readonly authorization: CloudAccountHeaderAuthorization;
  /** Custody leases must be reacquired after body collection and retry waits. */
  readonly revalidateBeforeAttempt: boolean;
}

/** Normalize legacy credentials here so the shared proxy never holds a key. */
export async function resolveCloudAccountGatewayAuthorization(
  resolveToken: () => Promise<CloudAccountGatewayCredential>,
): Promise<CloudAccountGatewayAuthorization | null> {
  const credential = await resolveToken();
  if (!credential) return null;
  if (typeof credential !== 'string' && 'apply' in credential)
    return { authorization: credential, revalidateBeforeAttempt: true };
  let key: string | null =
    typeof credential === 'string' ? credential : credential.token;
  const credentialVersion =
    typeof credential === 'string' ? undefined : credential.credentialVersion;
  let applied: Headers | undefined;
  return {
    revalidateBeforeAttempt: false,
    authorization: {
      credentialVersion,
      apply: (headers: Headers): void => {
        if (key === null) {
          applied?.delete('authorization');
          headers.delete('authorization');
          throw new CloudAccountAuthorizationError('stale-lease');
        }
        const credential = key;
        key = null;
        applyCloudAccountHeader(headers, credential);
        applied = headers;
      },
      release: (): void => {
        applied?.delete('authorization');
        applied = undefined;
        key = null;
      },
    },
  };
}

/** One request's credential presentation; callers receive a handle, not a token. */
export interface CloudAccountAuthorizationLease extends CloudAccountHeaderAuthorization {
  readonly accountId: string | null;
  readonly credentialVersion: string;
  /** Once only. Throws CloudAccountAuthorizationError if retired before delivery. */
  apply(headers: Headers): void;
  /** Strips the applied header and retires this lease. Idempotent. */
  release(): void;
}

export interface CloudAccountAuthorizationPort {
  /** Credential-free identity and policy from a fenced current read. */
  current(): Promise<CloudAccountAccessRead>;
  /** Fires on account changes and custody invalidation, after retiring headers. */
  onAccountChanged(listener: () => void): () => void;
  /** Transport authorization only; execution policy and paid consent remain the caller's gates. */
  lease(
    credentialGeneration: number,
    accepts?: (read: CloudAccountAccessRead) => boolean,
  ): Promise<CloudAccountAuthorizationLease>;
  /** Retires every lease and strips its headers. */
  dispose(): void;
}

export function createCloudAccountAuthorizationPort(
  authority: CloudAccountAuthority,
): CloudAccountAuthorizationPort {
  let closed = false;
  let epoch = 0;
  const releases = new Set<() => void>();
  const listeners = new Set<() => void>();
  const invalidate = (): void => {
    epoch++;
    for (const release of [...releases]) release();
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      try {
        listener();
      } catch {
        // A subscriber must not prevent other consumers retiring cached state.
      }
    }
  };
  const unsubscribe = authority.onAccountChanged(invalidate);
  const unsubscribeCustody = authority.onCustodyInvalidated?.(invalidate);

  return {
    current: async (): Promise<CloudAccountAccessRead> => {
      if (closed) throw new CloudAccountAuthorizationError('closed');
      const startingEpoch = epoch;
      const read = await authority.read();
      if (closed) throw new CloudAccountAuthorizationError('closed');
      if (startingEpoch !== epoch)
        throw new CloudAccountAuthorizationError('stale-lease');
      const access = projectCloudAccountAccess(read);
      if (access.kind !== 'ok') return access;
      // Key-derived identities stay internal to broker route binding.
      return Object.freeze({
        ...access,
        routeIdentity:
          read.kind === 'ok'
            ? (read.record?.accountId ?? read.record?.serverApiKeyId ?? null)
            : null,
      });
    },
    onAccountChanged: (listener): (() => void) => {
      if (closed) throw new CloudAccountAuthorizationError('closed');
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    lease: async (
      credentialGeneration,
      accepts,
    ): Promise<CloudAccountAuthorizationLease> => {
      if (closed) throw new CloudAccountAuthorizationError('closed');
      const startingEpoch = epoch;
      const read = await authority.read();
      if (closed) throw new CloudAccountAuthorizationError('closed');
      if (startingEpoch !== epoch)
        throw new CloudAccountAuthorizationError('stale-lease');
      if (read.kind !== 'ok')
        throw new CloudAccountAuthorizationError(read.kind);
      if (read.credentialGeneration !== credentialGeneration)
        throw new CloudAccountAuthorizationError('stale-lease');
      if (!hasCloudAccountCredential(read.record))
        throw new CloudAccountAuthorizationError('signed-out');
      if (read.sessionExpired)
        throw new CloudAccountAuthorizationError('session-expired');
      if (accepts && !accepts(projectCloudAccountAccess(read)))
        throw new CloudAccountAuthorizationError('unavailable');
      let key: string | null = read.record.apiKey;
      let applied: Headers | undefined;
      const release = (): void => {
        applied?.delete('authorization');
        applied = undefined;
        key = null;
        releases.delete(release);
      };
      releases.add(release);
      return Object.freeze({
        accountId: read.record.accountId,
        credentialVersion: String(read.credentialGeneration),
        apply: (headers: Headers): void => {
          if (closed || startingEpoch !== epoch || key === null || applied) {
            release();
            headers.delete('authorization');
            throw new CloudAccountAuthorizationError('stale-lease');
          }
          const credential = key;
          key = null;
          applyCloudAccountHeader(headers, credential);
          applied = headers;
        },
        release,
      });
    },
    dispose: (): void => {
      closed = true;
      unsubscribe();
      unsubscribeCustody?.();
      listeners.clear();
      invalidate();
    },
  };
}
