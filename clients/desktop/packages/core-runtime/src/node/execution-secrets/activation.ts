import type { ExecutionSecretBinding } from '@canopy/protocol/canopy-core';
import type { CloudRunnerSecretGrant } from '@canopy/protocol/pipeline-relay';
import { CloudRunnerSecretGrantSchema } from '@canopy/protocol/pipeline-relay';
import { fingerprintExecutionSecretBinding } from './fingerprint';
import { ExecutionSecretGrants, refusingExecutionSecretSource } from './grants';
import type {
  ExecutionSecretRead,
  ExecutionSecretRedeemRequest,
  ExecutionSecretSource,
  RedeemedExecutionSecrets,
} from './types';

/**
 * A cloud runner's secret source (CAN-6215, plan CP-27): the one grant its
 * bootstrap activation carries, staged in memory when the runner reads the
 * activation and redeemed locally, because a runner never calls the web
 * core. The CAN-5067 admission applies unchanged: the audience must be the
 * activation's, the requested bindings exactly its set, within its deadline,
 * once. Whatever the outcome, the first redemption for the audience, the
 * deadline or `dispose` drops every value.
 */
export interface ActivationExecutionSecretSource extends ExecutionSecretSource {
  /** Drops the grant and its values; the runner calls it as it exits. */
  dispose(): void;
}

const NO_GRANT: ActivationExecutionSecretSource = {
  redeem: (request, signal) =>
    refusingExecutionSecretSource.redeem(request, signal),
  dispose: () => undefined,
};

export function createActivationExecutionSecretSource(
  grant: CloudRunnerSecretGrant | null,
  options: { readonly now?: () => number } = {},
): ActivationExecutionSecretSource {
  if (grant === null) return NO_GRANT;
  // Nothing below keeps the parsed grant: the values live only in `values`,
  // which every cleanup path empties. The caller drops the activation itself.
  const { audience, bindings, redeemWithinMs, values } = splitGrant(grant);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = (): void => {
    values.clear();
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  timer = setTimeout(clear, redeemWithinMs);
  timer.unref?.();
  const grants = new ExecutionSecretGrants({
    reader: {
      read: (requested): Promise<readonly ExecutionSecretRead[]> => {
        const reads = requested.map((binding): ExecutionSecretRead => {
          const value = values.get(fingerprintExecutionSecretBinding(binding));
          return value === undefined
            ? { status: 'missing' }
            : { status: 'ok', value };
        });
        clear();
        return Promise.resolve(reads);
      },
    },
    ttlMs: redeemWithinMs,
    maxGrants: 1,
    ...(options.now && { now: options.now }),
  });
  const handle = grants.stage(audience, bindings);
  const audienceOf = (request: ExecutionSecretRedeemRequest): boolean =>
    request.audience.operation === audience.operation &&
    request.audience.key === audience.key;
  return {
    redeem: async (request, signal): Promise<RedeemedExecutionSecrets> => {
      try {
        return await grants.redeem(request, signal);
      } finally {
        // The grant is used up, burnt or expired: its values go with it.
        if (audienceOf(request)) {
          handle.revoke();
          clear();
        }
      }
    },
    dispose: (): void => {
      handle.revoke();
      grants.revokeAll();
      clear();
    },
  };
}

/** The grant's value-free parts, and its values by binding fingerprint. */
function splitGrant(grant: CloudRunnerSecretGrant): {
  readonly audience: CloudRunnerSecretGrant['audience'];
  readonly bindings: readonly ExecutionSecretBinding[];
  readonly redeemWithinMs: number;
  readonly values: Map<string, string>;
} {
  const parsed = CloudRunnerSecretGrantSchema.parse(grant);
  return {
    audience: { ...parsed.audience },
    bindings: parsed.entries.map(({ binding }) => binding),
    redeemWithinMs: parsed.redeemWithinMs,
    values: new Map(
      parsed.entries.map(({ binding, value }) => [
        fingerprintExecutionSecretBinding(binding),
        value,
      ]),
    ),
  };
}
