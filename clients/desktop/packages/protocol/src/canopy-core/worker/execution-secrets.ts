import { z } from 'zod';
const id = z.string().min(1).max(512);

export const EXECUTION_SECRET_BINDINGS_MAX = 64;
export const STORED_SECRET_REF_PATTERN = /^ssr1_[A-Za-z0-9_-]{43}$/;
export const EXECUTION_SECRET_STORED_FAMILIES = [
  'environment',
  'shared_container.run_env',
  'mcp.server',
  // Secrets a person gave an agent through RequestSecrets; `record` names the
  // chat (an opaque digest), `ref` the secret.
  'agent.chat',
] as const;
export const EXECUTION_SECRET_INTEGRATIONS = ['linear', 'github-pat'] as const;
export const EXECUTION_SECRET_PROXY_HARNESSES = ['claude', 'codex'] as const;

export const ExecutionSecretSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('stored-secret'),
    family: z.enum(EXECUTION_SECRET_STORED_FAMILIES),
    /** `config` for `environment`; the container id for `shared_container.run_env`; the server id for `mcp.server`; the chat's record digest for `agent.chat`. */
    record: id,
    ref: z.string().regex(STORED_SECRET_REF_PATTERN),
  }),
  z.strictObject({
    kind: z.literal('integration-token'),
    provider: z.enum(EXECUTION_SECRET_INTEGRATIONS),
  }),
  z.strictObject({
    kind: z.literal('account-proxy-route'),
    harness: z.enum(EXECUTION_SECRET_PROXY_HARNESSES),
    connectionId: id,
  }),
]);
/** Named `...Ref` so it never clashes with core-runtime's `ExecutionSecretSource` port. */
export type ExecutionSecretSourceRef = z.output<
  typeof ExecutionSecretSourceSchema
>;

export const ExecutionSecretBindingSchema = z.strictObject({
  /** The environment variable the value is exported as. */
  name: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  source: ExecutionSecretSourceSchema,
});
export type ExecutionSecretBinding = z.output<
  typeof ExecutionSecretBindingSchema
>;

/** References a worker redeems through its core; they hold no secret. */
export const ExecutionSecretBindingsSchema = z
  .array(ExecutionSecretBindingSchema)
  .min(1)
  .max(EXECUTION_SECRET_BINDINGS_MAX)
  .superRefine((bindings, ctx) => {
    const names = new Set<string>();
    for (const binding of bindings) {
      if (names.has(binding.name))
        ctx.addIssue({
          code: 'custom',
          message: 'Each secret binding names a different variable.',
        });
      names.add(binding.name);
    }
  });

export const WORKER_EXECUTION_SECRET_ERROR_CODES = [
  'worker.executionSecret.notGranted',
  'worker.executionSecret.unavailable',
  'worker.executionSecret.revoked',
  'worker.executionSecret.unsupported',
] as const;
