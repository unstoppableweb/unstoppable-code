import {
  ExecutionSecretBindingsSchema,
  type ExecutionSecretBinding,
} from '@canopy/protocol/canopy-core';
import { executionSecretFingerprints } from './fingerprint';
import {
  ExecutionSecretStageError,
  executionSecretNotGrantedError,
  executionSecretRevokedError,
  executionSecretUnavailableError,
  executionSecretUnsupportedError,
} from './errors';
import {
  NO_EXECUTION_SECRETS,
  type ExecutionSecretRead,
  type ExecutionSecretAudience,
  type ExecutionSecretGrantHandle,
  type ExecutionSecretReader,
  type ExecutionSecretRedeemRequest,
  type ExecutionSecretSource,
  type RedeemedExecutionSecrets,
} from './types';

interface Grant {
  bindings: readonly ExecutionSecretBinding[];
  fingerprints: readonly string[];
  deadline: number;
  state: 'staged' | 'redeemed' | 'revoked';
}
function key(audience: ExecutionSecretAudience): string {
  return `${audience.operation}\0${audience.key}`;
}
function fingerprints(bindings: readonly ExecutionSecretBinding[]): string[] {
  return executionSecretFingerprints(bindings)
    .map((binding) => binding.fingerprint)
    .sort();
}
export class ExecutionSecretGrants implements ExecutionSecretSource {
  private readonly grants = new Map<string, Grant>();
  private revocationEpoch = 0;
  private readonly ttlMs: number;
  private readonly maxGrants: number;
  private readonly now: () => number;
  constructor(
    private readonly options: {
      reader: ExecutionSecretReader;
      ttlMs?: number;
      maxGrants?: number;
      now?: () => number;
    },
  ) {
    this.ttlMs = options.ttlMs ?? 300_000;
    this.maxGrants = options.maxGrants ?? 1024;
    this.now = options.now ?? ((): number => performance.now());
  }
  stage(
    audience: ExecutionSecretAudience,
    bindings: readonly ExecutionSecretBinding[],
  ): ExecutionSecretGrantHandle {
    if (!bindings.length) return { revoke: (): void => undefined };
    const now = this.now();
    for (const [id, grant] of this.grants) {
      if (grant.deadline <= now || grant.state !== 'staged')
        this.grants.delete(id);
    }
    const parsed = ExecutionSecretBindingsSchema.safeParse(bindings);
    if (!parsed.success)
      throw new ExecutionSecretStageError(
        'invalid_bindings',
        'This work would receive more than 64 secrets, or two with the same name. Mark fewer variables as secret.',
      );
    const id = key(audience);
    if (this.grants.has(id))
      throw new ExecutionSecretStageError(
        'already_staged',
        'Secrets are already staged for this work.',
      );
    if (this.grants.size >= this.maxGrants)
      throw new ExecutionSecretStageError(
        'capacity',
        'Too many launches have secrets staged. Try starting this work later.',
      );
    const grant: Grant = {
      bindings: parsed.data,
      fingerprints: fingerprints(parsed.data),
      deadline: now + this.ttlMs,
      state: 'staged',
    };
    this.grants.set(id, grant);
    return {
      revoke: (): void => {
        grant.state = 'revoked';
        if (this.grants.get(id) === grant) this.grants.delete(id);
      },
    };
  }
  async redeem(
    request: ExecutionSecretRedeemRequest,
    signal: AbortSignal,
  ): Promise<RedeemedExecutionSecrets> {
    const id = key(request.audience);
    const grant = this.grants.get(id);
    if (!grant || grant.deadline <= this.now() || grant.state !== 'staged') {
      if (grant && grant.deadline <= this.now()) this.grants.delete(id);
      throw executionSecretNotGrantedError();
    }
    const requested = fingerprints(request.bindings);
    if (
      requested.length !== grant.fingerprints.length ||
      requested.some((fp, i) => fp !== grant.fingerprints[i])
    ) {
      grant.state = 'revoked';
      this.grants.delete(id);
      throw executionSecretNotGrantedError();
    }
    const revocationEpoch = this.revocationEpoch;
    grant.state = 'redeemed';
    try {
      if (signal.aborted) throw executionSecretRevokedError();
      if (
        grant.bindings.some(
          (binding) => binding.source.kind === 'account-proxy-route',
        )
      )
        throw executionSecretUnsupportedError();
      let reads: readonly ExecutionSecretRead[];
      try {
        reads = await this.options.reader.read(grant.bindings, signal);
      } catch {
        throw executionSecretUnavailableError('source_failed');
      }
      if (reads.some((read) => read.status === 'unsupported'))
        throw executionSecretUnsupportedError();
      if (
        reads.length !== grant.bindings.length ||
        reads.some((read) => read.status === 'missing')
      )
        throw executionSecretUnavailableError();
      if (
        this.revoked(grant) ||
        this.revocationEpoch !== revocationEpoch ||
        signal.aborted
      )
        throw executionSecretRevokedError();
      const entries: [string, string][] = [];
      for (const [i, binding] of grant.bindings.entries()) {
        const read = reads[i];
        if (!read || read.status !== 'ok')
          throw executionSecretUnavailableError();
        entries.push([binding.name, read.value]);
      }
      return Object.freeze({ env: Object.freeze(Object.fromEntries(entries)) });
    } finally {
      if (this.grants.get(id) === grant) this.grants.delete(id);
    }
  }
  revokeAll(): void {
    this.revocationEpoch += 1;
    for (const grant of this.grants.values()) grant.state = 'revoked';
    this.grants.clear();
  }
  private revoked(grant: Grant): boolean {
    return grant.state === 'revoked';
  }
}
export const refusingExecutionSecretSource: ExecutionSecretSource = {
  redeem: (request): Promise<RedeemedExecutionSecrets> =>
    request.bindings.length
      ? Promise.reject(executionSecretUnavailableError())
      : Promise.resolve(NO_EXECUTION_SECRETS),
};
export async function redeemExecutionSecrets(
  source: ExecutionSecretSource,
  audience: ExecutionSecretAudience,
  bindings: readonly ExecutionSecretBinding[] | undefined,
  signal: AbortSignal,
): Promise<RedeemedExecutionSecrets> {
  return bindings?.length
    ? source.redeem({ audience, bindings }, signal)
    : NO_EXECUTION_SECRETS;
}
