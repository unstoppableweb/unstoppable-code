import type { VaultIoClass, VaultMutationStep } from '../../vault/contracts';

/** Core-internal port. Workers receive leases, never a vault or a writer. */
export type GitHubCredentialPurpose = 'git-push' | 'git-fetch';
export type GitHubCredentialReason =
  | 'absent'
  | 'stale'
  | 'locked'
  | 'denied'
  | 'unavailable'
  | 'key_missing'
  | 'unconfirmed';
/** Content-free fence diagnostic: a validated errno or a fixed failure code. */
export type GitHubCredentialFenceReadFailure =
  | `E${string}`
  | 'parse_failed'
  | 'privacy_check_failed'
  | 'read_failed';
export type GitHubCredentialAdmission =
  | { readonly kind: 'admitted' }
  | {
      readonly kind: 'refused';
      readonly reason: GitHubCredentialReason;
      readonly fenceReadFailure?: GitHubCredentialFenceReadFailure;
    };
export type GitHubCredentialUse<T> =
  | { readonly kind: 'admitted'; readonly value: T }
  | Exclude<GitHubCredentialAdmission, { readonly kind: 'admitted' }>;
export type GitHubCredentialResolution =
  | {
      readonly kind: 'available';
      /** Owned by the recipient, which must zero it. */
      readonly material: Uint8Array;
      /** Runs synchronously inside the authority's serialized admission. */
      admit<T>(use: () => T): Promise<GitHubCredentialUse<T>>;
    }
  | { readonly kind: 'absent'; readonly reason: 'absent' | 'stale' }
  | {
      readonly kind: 'blocked';
      readonly reason: Exclude<GitHubCredentialReason, 'absent' | 'stale'>;
      readonly fenceReadFailure?: GitHubCredentialFenceReadFailure;
      /** Closed vault diagnostic when a storage call threw; never a branch. */
      readonly storage?: {
        readonly step: VaultMutationStep;
        readonly io: VaultIoClass;
      };
    };
export interface GitHubCredentialSource {
  resolve(
    purpose: GitHubCredentialPurpose,
  ): Promise<GitHubCredentialResolution>;
}
export interface GitHubCredentialAudience {
  readonly operation:
    | 'worker.git.push'
    | 'worker.git.fetch'
    | 'worker.git.pull';
  /** One dispatch, matching ExecutionSecretAudience.key. */
  readonly key: string;
}
export interface GitHubCredentialLeaseRequest {
  readonly purpose: GitHubCredentialPurpose;
  readonly audience: GitHubCredentialAudience;
  /** Monotonic milliseconds in the mint's clock. */
  readonly expiresAt: number;
}
export type GitHubCredentialLeaseRefusal = {
  readonly kind: 'refused';
  readonly fenceReadFailure?: GitHubCredentialFenceReadFailure;
  readonly reason:
    | GitHubCredentialReason
    | 'expired'
    | 'audience'
    | 'purpose'
    | 'consumed'
    | 'revoked'
    /** The credential source threw: distinct from an absent credential. */
    | 'source_failed';
};
export type GitHubCredentialDelivery<T> =
  | { readonly kind: 'delivered'; readonly value: T }
  | GitHubCredentialLeaseRefusal;
export type GitHubCredentialMint =
  | { readonly kind: 'minted'; readonly lease: GitHubCredentialLease }
  | GitHubCredentialLeaseRefusal;
export interface GitHubCredentialLease {
  readonly purpose: GitHubCredentialPurpose;
  readonly audience: GitHubCredentialAudience;
  readonly expiresAt: number;
  /** Spawn synchronously in the callback. No material may be retained. */
  deliver<T>(
    request: Pick<GitHubCredentialLeaseRequest, 'purpose' | 'audience'>,
    spawn: (material: Uint8Array) => T,
  ): Promise<GitHubCredentialDelivery<T>>;
  revoke(): void;
}
export interface GitHubCredentialLeasePort {
  mint(request: GitHubCredentialLeaseRequest): Promise<GitHubCredentialMint>;
}

function validPurpose(request: GitHubCredentialLeaseRequest): boolean {
  return request.purpose === 'git-push'
    ? request.audience.operation === 'worker.git.push'
    : request.purpose === 'git-fetch' &&
        (request.audience.operation === 'worker.git.fetch' ||
          request.audience.operation === 'worker.git.pull');
}

export function createGitHubCredentialLeasePort(options: {
  readonly source: GitHubCredentialSource;
  /** Trusted owner's lifetime; disposal revokes even abandoned leases. */
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly maxTtlMs?: number;
}): GitHubCredentialLeasePort {
  const now = options.now ?? ((): number => performance.now());
  const maxTtl = options.maxTtlMs ?? 300_000;
  if (!Number.isFinite(maxTtl) || maxTtl <= 0 || maxTtl > 300_000)
    throw new TypeError('Invalid credential lease lifetime.');
  const revocations = new Set<() => void>();
  options.signal?.addEventListener(
    'abort',
    () => {
      for (const revoke of revocations) revoke();
    },
    { once: true },
  );
  return {
    async mint(input): Promise<GitHubCredentialMint> {
      if (options.signal?.aborted)
        return { kind: 'refused', reason: 'revoked' };
      const request = { ...input, audience: { ...input.audience } };
      if (!validPurpose(request)) return { kind: 'refused', reason: 'purpose' };
      if (!request.audience.key.trim())
        return { kind: 'refused', reason: 'audience' };
      const deadline = request.expiresAt;
      const started = now();
      if (
        !Number.isFinite(deadline) ||
        deadline <= started ||
        deadline - started > maxTtl
      )
        return { kind: 'refused', reason: 'expired' };
      let resolved: GitHubCredentialResolution;
      try {
        resolved = await options.source.resolve(request.purpose);
      } catch {
        return { kind: 'refused', reason: 'source_failed' };
      }
      // Copy known fields only: a source's extra properties must not leak.
      if (resolved.kind === 'absent')
        return { kind: 'refused', reason: resolved.reason };
      if (resolved.kind === 'blocked')
        return resolved.fenceReadFailure
          ? {
              kind: 'refused',
              reason: resolved.reason,
              fenceReadFailure: resolved.fenceReadFailure,
            }
          : { kind: 'refused', reason: resolved.reason };
      const { material } = resolved;
      let state: 'ready' | 'consumed' | 'revoked' | 'expired' = 'ready';
      let timer: ReturnType<typeof setTimeout> | undefined;
      function release(): void {
        clearTimeout(timer);
        revocations.delete(revoke);
        material.fill(0);
      }
      function revoke(): void {
        state = 'revoked';
        release();
      }
      function refusal(): GitHubCredentialLeaseRefusal | null {
        if (options.signal?.aborted || state === 'revoked')
          return { kind: 'refused', reason: 'revoked' };
        if (state === 'expired' || deadline <= now())
          return { kind: 'refused', reason: 'expired' };
        return null;
      }
      let retained = false;
      try {
        const refused = refusal();
        if (refused) return refused;
        revocations.add(revoke);
        // Protect bytes while mint admission itself is pending, not only after mint.
        timer = setTimeout(
          () => {
            state = 'expired';
            release();
          },
          Math.max(0, deadline - now()),
        );
        timer.unref?.();
        const admission = await resolved.admit(() => undefined);
        const stopped = refusal();
        if (stopped) return stopped;
        if (admission.kind !== 'admitted') return admission;
        const audience = Object.freeze({ ...request.audience });
        const lease: GitHubCredentialLease = Object.freeze({
          purpose: request.purpose,
          audience,
          expiresAt: deadline,
          revoke,
          async deliver<T>(
            recipient: Pick<
              GitHubCredentialLeaseRequest,
              'purpose' | 'audience'
            >,
            spawn: (bytes: Uint8Array) => T,
          ): Promise<GitHubCredentialDelivery<T>> {
            if (state !== 'ready') return { kind: 'refused', reason: state };
            // Consume before awaiting admission: simultaneous deliveries cannot share bytes.
            state = 'consumed';
            try {
              if (recipient.purpose !== request.purpose)
                return { kind: 'refused', reason: 'purpose' };
              if (
                recipient.audience.operation !== audience.operation ||
                recipient.audience.key !== audience.key
              )
                return { kind: 'refused', reason: 'audience' };
              if (deadline <= now())
                return { kind: 'refused', reason: 'expired' };
              const admitted = await resolved.admit(
                (): GitHubCredentialDelivery<T> => {
                  // This callback runs inside authority serialization, so a clear
                  // cannot slip between final admission and synchronous spawn.
                  const stopped = refusal();
                  if (stopped) return stopped;
                  try {
                    return { kind: 'delivered', value: spawn(material) };
                  } finally {
                    // Do not retain bytes until the asynchronous admission settles.
                    release();
                  }
                },
              );
              return admitted.kind === 'admitted' ? admitted.value : admitted;
            } catch {
              return { kind: 'refused', reason: 'unavailable' };
            } finally {
              release();
            }
          },
        });
        retained = true;
        return { kind: 'minted', lease };
      } catch {
        // The source's mint admission threw.
        return { kind: 'refused', reason: 'source_failed' };
      } finally {
        if (!retained) release();
      }
    },
  };
}
