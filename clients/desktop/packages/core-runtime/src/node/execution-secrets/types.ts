import type { ExecutionSecretBinding } from '@canopy/protocol/canopy-core';

export const EXECUTION_SECRET_OPERATIONS = [
  'worker.pipeline.execution.start',
  'worker.pipeline.execution.resume',
  'worker.pipeline.execution.retry',
  'worker.pipeline.matrixJob.retry',
  'worker.script.execute',
  'worker.catalog.materialize',
  // RunWithSecrets and WriteSecretsFile in the host that owns the grants:
  // an internal audience, not a protocol operation. The key is a fresh id
  // per call (agent secret requests, CONTRACTS.md §8).
  'agent.secret.use',
  // Full-access ambient env for a chat's own shell commands, in the host
  // that owns the grants: an internal audience, not a protocol operation.
  // The key is a fresh id per read (agent secret requests, unit U3).
  'agent.secret.ambient',
] as const;
export type ExecutionSecretOperation =
  (typeof EXECUTION_SECRET_OPERATIONS)[number];

/** What may redeem a grant: one dispatch of one instruction. */
export interface ExecutionSecretAudience {
  readonly operation: ExecutionSecretOperation;
  /** The execution id for a start or script run; the control's `requestId` for a control; the materialization id for `worker.catalog.materialize`; a per-call id for `agent.secret.use`. */
  readonly key: string;
}

export interface ExecutionSecretRedeemRequest {
  readonly audience: ExecutionSecretAudience;
  readonly bindings: readonly ExecutionSecretBinding[];
}

/** Values in memory only; never logged, recorded or returned to a client. */
export interface RedeemedExecutionSecrets {
  readonly env: Readonly<Record<string, string>>;
}
export const NO_EXECUTION_SECRETS: RedeemedExecutionSecrets = Object.freeze({
  env: Object.freeze({}),
});

/** The worker side's port; the owner implements it in process, a forwarder in the daemon. */
export interface ExecutionSecretSource {
  redeem(
    request: ExecutionSecretRedeemRequest,
    signal: AbortSignal,
  ): Promise<RedeemedExecutionSecrets>;
}

export type ExecutionSecretRead =
  | { readonly status: 'ok'; readonly value: string }
  | { readonly status: 'missing' }
  | { readonly status: 'unsupported' };

/** The owner's store access; the vault cutover replaces only this. Results are in binding order. */
export interface ExecutionSecretReader {
  read(
    bindings: readonly ExecutionSecretBinding[],
    signal: AbortSignal,
  ): Promise<readonly ExecutionSecretRead[]>;
}

export interface ExecutionSecretGrantHandle {
  revoke(): void;
}

/** The owner side's staging port; ExecutionSecretGrants implements it. */
export interface ExecutionSecretStager {
  stage(
    audience: ExecutionSecretAudience,
    bindings: readonly ExecutionSecretBinding[],
  ): ExecutionSecretGrantHandle;
}
