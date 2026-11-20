import { createHash } from 'node:crypto';
import {
  loadGhCliToken,
  loadStoredPat,
  resolveGitHubToken,
  resolveGitHubTokenWithSource,
  type GitHubTokenSource,
} from '../github-auth';
import { GitHubBrokerError, GitHubBrokerLeaseExpiredError } from './errors';

/**
 * The GitHub credential port: the only place in Electron main that turns a
 * credential into an `authorization` header for the broker.
 *
 * Callers never hold a token. They hold a lease, an opaque object only this
 * module mints. A lease records which source it was minted from and a
 * fingerprint of the token it saw; it never stores the token. Each request
 * attempt calls `authorize`, which reads the source again, checks the
 * fingerprint, and returns the header for that one attempt. A lease whose
 * source has since changed, emptied or been revoked is refused with a typed
 * error instead of being sent under another credential.
 */

type LeaseRecord =
  | { kind: 'default' }
  | {
      kind: 'pinned';
      source: GitHubBrokerCredentialSource;
      fingerprint: string;
      revoked: boolean;
      expiresAt: number;
    };

/**
 * The lease object. Its constructor is private and its record is a private
 * field, so no other module can build one or read it, and a string is never
 * assignable to it.
 */
class Lease {
  readonly #record: LeaseRecord;

  private constructor(record: LeaseRecord) {
    this.#record = record;
    Object.freeze(this);
  }

  static mint(record: LeaseRecord): Lease {
    return new Lease(record);
  }

  /** The record of a lease this module minted, or undefined for anything else. */
  static recordOf(lease: unknown): LeaseRecord | undefined {
    return typeof lease === 'object' && lease !== null && #record in lease
      ? lease.#record
      : undefined;
  }

  toJSON(): string {
    return '[GitHubBrokerCredentialLease]';
  }
}

/** An opaque GitHub credential lease. Only this module can mint one. */
export type GitHubBrokerCredentialLease = Lease;

/** Whether a value is a lease this module minted. */
export function isGitHubBrokerCredentialLease(
  value: unknown,
): value is GitHubBrokerCredentialLease {
  return Lease.recordOf(value) !== undefined;
}

/** The sources a caller can pin a lease to. */
export type GitHubBrokerCredentialSource = 'resolved' | 'pat' | 'gh-cli';

/** The token family, read from its prefix when the lease is minted. */
export type GitHubBrokerCredentialTokenFamily =
  | 'fine-grained'
  | 'classic'
  | 'other';

export interface GitHubBrokerCredentialGrant {
  lease: GitHubBrokerCredentialLease;
  /** Where the token came from (`resolved` reports the source it chose). */
  source: Exclude<GitHubTokenSource, 'none'>;
  tokenFamily: GitHubBrokerCredentialTokenFamily;
}

/** A purpose-bound identity derived from the credential, never the token. */
export type GitHubBrokerCredentialScopePurpose =
  | { kind: 'pr-tracking' }
  | { kind: 'reference-preview'; accountIdentity: string };

/**
 * How long a pinned lease can authorize requests after it is minted: longer
 * than the longest GitHub primary rate-limit reset (an hour), so a request
 * parked behind one still sends. Holders mint a lease per sweep or per probe,
 * so a lease that outlives this was dropped without being revoked. The
 * default lease has no lifetime.
 */
export const GITHUB_BROKER_LEASE_TTL_MS = 65 * 60_000;

const FINE_GRAINED_PAT_PREFIX = 'github_pat_';
const CLASSIC_PAT_PREFIXES = ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_'];

function recordOf(lease: GitHubBrokerCredentialLease): LeaseRecord {
  const record = Lease.recordOf(lease);
  if (!record) {
    throw new GitHubBrokerError(
      'not_authenticated',
      'The GitHub credential lease was not issued by the credential port.',
    );
  }
  return record;
}

function fingerprintOf(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function tokenFamilyOf(token: string): GitHubBrokerCredentialTokenFamily {
  if (token.startsWith(FINE_GRAINED_PAT_PREFIX)) return 'fine-grained';
  if (CLASSIC_PAT_PREFIXES.some((prefix) => token.startsWith(prefix))) {
    return 'classic';
  }
  return 'other';
}

/**
 * The header GitHub expects, built as `@octokit/auth-token` builds it: a
 * stored `token ` or `bearer ` prefix is dropped, and a JWT is sent as bearer.
 */
function authorizationHeaderFor(token: string): string {
  const bare = token.replace(/^(token|bearer) +/i, '');
  return bare.split('.').length === 3 ? `bearer ${bare}` : `token ${bare}`;
}

async function readSource(
  source: GitHubBrokerCredentialSource,
): Promise<{ token: string; source: GitHubTokenSource }> {
  if (source === 'pat') {
    return { token: (await loadStoredPat()).trim(), source: 'pat' };
  }
  if (source === 'gh-cli') {
    return { token: (await loadGhCliToken()).trim(), source: 'gh-cli' };
  }
  const resolved = await resolveGitHubTokenWithSource();
  return { token: resolved.token.trim(), source: resolved.source };
}

const DEFAULT_LEASE = Lease.mint({ kind: 'default' });

/** Refuse a revoked or expired pinned lease without reading its credential. */
function assertLive(record: LeaseRecord): void {
  if (record.kind === 'default') return;
  if (record.revoked) {
    throw new GitHubBrokerError(
      'not_authenticated',
      'The GitHub credential lease was revoked.',
    );
  }
  if (Date.now() >= record.expiresAt) throw new GitHubBrokerLeaseExpiredError();
}

/**
 * Read the pinned lease's source and hand its token to `use` for one
 * synchronous step. The token never outlives that step.
 */
async function withPinnedToken<T>(
  record: Extract<LeaseRecord, { kind: 'pinned' }>,
  use: (token: string) => T,
): Promise<T> {
  assertLive(record);
  const { token } = await readSource(record.source).catch(() => ({
    token: '',
  }));
  // The lease may have been revoked or expired while its source was read.
  assertLive(record);
  if (!token || fingerprintOf(token) !== record.fingerprint) {
    throw new GitHubBrokerError(
      'not_authenticated',
      'The GitHub credential this lease was issued for is no longer available.',
    );
  }
  return use(token);
}

export interface GitHubBrokerCredentialPort {
  /** The broker default: whichever credential resolves at each attempt. */
  readonly defaultLease: GitHubBrokerCredentialLease;
  /** Pin a lease to the credential `source` holds now; null when it has none. */
  lease(
    source: GitHubBrokerCredentialSource,
  ): Promise<GitHubBrokerCredentialGrant | null>;
  /**
   * The `authorization` header for one request attempt. Throws
   * `not_authenticated` when the default has no credential, and when a pinned
   * lease's credential changed, emptied or was revoked.
   */
  authorize(lease: GitHubBrokerCredentialLease): Promise<string>;
  /**
   * Check that `authorize` would succeed now, with the same errors, without
   * building a header.
   */
  verify(lease: GitHubBrokerCredentialLease): Promise<void>;
  /**
   * Throw unless a pinned lease is still unrevoked and unexpired, without
   * reading its credential: the auth hook's last check before a request is
   * sent. An expired lease throws `GitHubBrokerLeaseExpiredError`.
   */
  assertLive(lease: GitHubBrokerCredentialLease): void;
  /**
   * The cache and quota scope: `resolved` for the default, and one stable id
   * per pinned credential, so two credentials never share a scope and one
   * credential keeps its scope across restarts.
   */
  scopeId(lease: GitHubBrokerCredentialLease): string;
  /** True for the broker default lease. */
  isDefault(lease: GitHubBrokerCredentialLease): boolean;
  /** A purpose-bound identity of a pinned lease's credential. */
  derivedScope(
    lease: GitHubBrokerCredentialLease,
    purpose: GitHubBrokerCredentialScopePurpose,
  ): Promise<string>;
  /** Refuse every later attempt under this lease. */
  revoke(lease: GitHubBrokerCredentialLease): void;
}

function derive(
  token: string,
  purpose: GitHubBrokerCredentialScopePurpose,
): string {
  const material =
    purpose.kind === 'pr-tracking'
      ? `github-pr-tracking\0${token}`
      : `github-reference-preview\0${purpose.accountIdentity}\0${token}`;
  return createHash('sha256').update(material).digest('base64url').slice(0, 24);
}

const port: GitHubBrokerCredentialPort = {
  defaultLease: DEFAULT_LEASE,

  async lease(source) {
    const mintedAt = Date.now();
    const read = await readSource(source).catch(() => null);
    if (!read?.token || read.source === 'none') return null;
    return {
      lease: Lease.mint({
        kind: 'pinned',
        source,
        fingerprint: fingerprintOf(read.token),
        revoked: false,
        expiresAt: mintedAt + GITHUB_BROKER_LEASE_TTL_MS,
      }),
      source: read.source,
      tokenFamily: tokenFamilyOf(read.token),
    };
  },

  async authorize(lease) {
    const record = recordOf(lease);
    if (record.kind === 'default') {
      const token = (await resolveGitHubToken()).trim();
      if (!token) {
        throw new GitHubBrokerError(
          'not_authenticated',
          'No GitHub token is available. Configure a PAT or sign in with the GitHub CLI.',
        );
      }
      return authorizationHeaderFor(token);
    }
    return withPinnedToken(record, authorizationHeaderFor);
  },

  async verify(lease) {
    const record = recordOf(lease);
    if (record.kind === 'default') {
      if (!(await resolveGitHubToken()).trim()) {
        throw new GitHubBrokerError(
          'not_authenticated',
          'No GitHub token is available. Configure a PAT or sign in with the GitHub CLI.',
        );
      }
      return;
    }
    await withPinnedToken(record, () => undefined);
  },

  assertLive(lease) {
    assertLive(recordOf(lease));
  },

  scopeId(lease) {
    const record = recordOf(lease);
    return record.kind === 'default'
      ? 'resolved'
      : `custom:${record.fingerprint}`;
  },

  isDefault(lease) {
    return recordOf(lease).kind === 'default';
  },

  async derivedScope(lease, purpose) {
    const record = recordOf(lease);
    if (record.kind === 'default') {
      throw new GitHubBrokerError(
        'not_authenticated',
        'A derived GitHub credential scope needs a pinned lease.',
      );
    }
    return withPinnedToken(record, (token) => derive(token, purpose));
  },

  revoke(lease) {
    const record = recordOf(lease);
    if (record.kind === 'pinned') record.revoked = true;
  },
};

export function getGitHubBrokerCredentialPort(): GitHubBrokerCredentialPort {
  return port;
}
