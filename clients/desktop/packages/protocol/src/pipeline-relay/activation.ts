/**
 * The cloud runner's bootstrap activation (CAN-6215, cloud pipelines CP-27).
 *
 * The runner never calls the web core (ADR 31), so everything one runner
 * incarnation needs to start comes in one body the web core builds at
 * provisioning and the sandbox's process supervisor (agentic-core, CP-12)
 * carries to it as a signed control body: delivery `bootstrap-injection` in
 * the delegation record. The supervisor passes it only in that body and
 * never persists or logs it.
 *
 * Its members:
 *
 * - who the incarnation is: the delegation, its lease epoch and the runner
 *   credential issued for that epoch (CAN-6170);
 * - how it reaches the web core: the relay URL and token, and the end-to-end
 *   session key (CP-19 fills these from `issueRunnerCredential`);
 * - its hosted secrets, as one one-shot grant (CAN-5067) for the one
 *   instruction the web core will send it: the bindings that instruction's
 *   `secrets` param carries, each with its value. The runner stages the
 *   grant in memory as it starts and redeems it locally when that
 *   instruction arrives; no value ever crosses the relay.
 *
 * The delegation record keeps a digest of the value-free projection
 * (`cloudRunnerActivationRecordOf`) and the bindings' fingerprints, never the
 * body.
 *
 * Design: docs/planning/2026-11-10-can-6215-hosted-pipeline-environments/
 */
import { z } from 'zod';
import {
  EXECUTION_SECRET_BINDINGS_MAX,
  ExecutionSecretBindingSchema,
} from '../canopy-core/worker/execution-secrets';

export const CLOUD_RUNNER_ACTIVATION_KIND = 'canopy.cloud-runner.activation';

/**
 * The longest a staged grant waits for its instruction, from when the runner
 * reads the activation: provisioning, the relay attach and the session.
 */
export const CLOUD_RUNNER_SECRET_GRANT_MAX_MS = 15 * 60_000;

/** The longest secret value an activation carries, as cloud Environments allow. */
export const CLOUD_RUNNER_SECRET_VALUE_MAX_LENGTH = 16_384;

/**
 * The instructions a grant may be staged for, with the key its audience
 * takes: the execution id for a start, the control's request id otherwise.
 */
export const CLOUD_RUNNER_SECRET_OPERATIONS = [
  'worker.pipeline.execution.start',
  'worker.pipeline.execution.resume',
  'worker.pipeline.execution.retry',
  'worker.pipeline.matrixJob.retry',
] as const;

export const CloudRunnerSecretAudienceSchema = z.strictObject({
  operation: z.enum(CLOUD_RUNNER_SECRET_OPERATIONS),
  key: z.string().min(1).max(512),
});

export const CloudRunnerSecretEntrySchema = z.strictObject({
  binding: ExecutionSecretBindingSchema,
  value: z
    .string()
    .max(CLOUD_RUNNER_SECRET_VALUE_MAX_LENGTH)
    .meta({ writeOnly: true }),
});

/** One one-shot grant: the exact binding set one instruction redeems once. */
export const CloudRunnerSecretGrantSchema = z.strictObject({
  grantId: z.uuid(),
  audience: CloudRunnerSecretAudienceSchema,
  redeemWithinMs: z.number().int().min(1).max(CLOUD_RUNNER_SECRET_GRANT_MAX_MS),
  entries: z
    .array(CloudRunnerSecretEntrySchema)
    .min(1)
    .max(EXECUTION_SECRET_BINDINGS_MAX)
    .superRefine((entries, ctx) => {
      const names = new Set<string>();
      for (const { binding } of entries) {
        if (names.has(binding.name))
          ctx.addIssue({
            code: 'custom',
            message: 'Each secret binding names a different variable.',
          });
        names.add(binding.name);
      }
    }),
});
export type CloudRunnerSecretGrant = z.output<
  typeof CloudRunnerSecretGrantSchema
>;

export const CloudRunnerActivationSchema = z.strictObject({
  kind: z.literal(CLOUD_RUNNER_ACTIVATION_KIND),
  version: z.literal(1),
  delegationId: z.uuid(),
  leaseEpoch: z.number().int().min(1),
  credentialId: z.uuid(),
  /** When the incarnation's credential ends; nothing in the body outlives it. */
  expiresAt: z.iso.datetime({ offset: true }),
  /** CP-19: the relay leg the runner dials. */
  relay: z.strictObject({
    url: z.url(),
    token: z.string().min(1).max(4096).meta({ writeOnly: true }),
  }),
  /** CP-19: the incarnation's end-to-end session key, base64url. */
  sessionKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .meta({ writeOnly: true }),
  /** Hosted secrets for the incarnation's one instruction, or none. */
  secrets: CloudRunnerSecretGrantSchema.nullable(),
});
export type CloudRunnerActivation = z.output<
  typeof CloudRunnerActivationSchema
>;

/**
 * What a record may keep of an activation: everything but the relay token,
 * the session key and the secret values. Its digest is the delegation's
 * `activation.digest`; it reveals nothing about any value.
 */
export interface CloudRunnerActivationRecord {
  readonly kind: typeof CLOUD_RUNNER_ACTIVATION_KIND;
  readonly version: 1;
  readonly delegationId: string;
  readonly leaseEpoch: number;
  readonly credentialId: string;
  readonly expiresAt: string;
  readonly relayUrl: string;
  readonly secrets: {
    readonly grantId: string;
    readonly audience: z.output<typeof CloudRunnerSecretAudienceSchema>;
    readonly redeemWithinMs: number;
    readonly bindings: readonly z.output<typeof ExecutionSecretBindingSchema>[];
  } | null;
}

export function cloudRunnerActivationRecordOf(
  activation: CloudRunnerActivation,
): CloudRunnerActivationRecord {
  return {
    kind: activation.kind,
    version: activation.version,
    delegationId: activation.delegationId,
    leaseEpoch: activation.leaseEpoch,
    credentialId: activation.credentialId,
    expiresAt: activation.expiresAt,
    relayUrl: activation.relay.url,
    secrets:
      activation.secrets === null
        ? null
        : {
            grantId: activation.secrets.grantId,
            audience: activation.secrets.audience,
            redeemWithinMs: activation.secrets.redeemWithinMs,
            bindings: activation.secrets.entries.map(({ binding }) => binding),
          },
  };
}
