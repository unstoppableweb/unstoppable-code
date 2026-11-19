import { z } from 'zod';

// Nested core modules use ../../ for common canopy-core contracts.

import {
  CanopyStreamCursorSchema,
  CanopyStreamEndSchema,
} from '../../definitions';
import { CanopyJsonValueSchema } from '../../errors';
import {
  CanopyEventNameSchema,
  CanopyOperationNameSchema,
  CanopyStreamNameSchema,
} from '../../names';
import { inherentOperationErrorSchema } from '../shared';

const id = z.string().min(1).max(512);
const json = CanopyJsonValueSchema;
const protocolVersions = z.array(z.number().int().min(1)).min(1);
const extensionMap = z.object({}).catchall(json);

export const CANOPY_RUNTIME_PROFILES = [
  'core',
  'worker',
  'core+worker',
] as const;

export const CoreRuntimeDescriptorSchema = z
  .object({
    runtimeId: id,
    hostId: id,
    authorityId: z.string().nullable(),
    profile: z.enum(CANOPY_RUNTIME_PROFILES),
    daemonEpoch: id,
    protocolVersions,
    state: z.enum(['starting', 'ready', 'degraded', 'stopping']),
  })
  .catchall(json);
export type CoreRuntimeDescriptor = z.output<
  typeof CoreRuntimeDescriptorSchema
>;

const CANOPY_ALLOWLIST_MAX_NAMES = 1024;

/**
 * The catalog freezes the name pattern; the runtime also rejects a doubled
 * plane prefix (normative rule 2), which JSON Schema cannot express.
 */
function effectiveAllowlist(
  nameSchema: z.ZodType<string>,
): z.ZodType<string[]> {
  return z
    .array(
      z
        .string()
        .max(256)
        .regex(/^(core|worker)(\.[a-z][A-Za-z0-9]*){2,}$/)
        .refine((name) => nameSchema.safeParse(name).success),
    )
    .max(CANOPY_ALLOWLIST_MAX_NAMES)
    .refine((names) => new Set(names).size === names.length, 'Duplicate name')
    .meta({ uniqueItems: true });
}

export const CoreRuntimeInitializeParamsSchema = z.strictObject({
  client: z
    .object({
      name: z.string(),
      version: z.string(),
      protocolVersions,
      capabilities: z.array(z.string()),
    })
    .catchall(json),
});

/**
 * The handshake result both lanes negotiate against. The allowlists are the
 * effective ones for this connection: installed modules intersected with the
 * principal's scopes and any delegation grant. Callers gate on them, never on
 * the runtime profile or executable name.
 */
export const CoreRuntimeInitializeResultSchema = z
  .object({
    runtime: CoreRuntimeDescriptorSchema.extend({
      buildVersion: z.string().min(1).max(512),
    }),
    selectedProtocolVersion: z.number().int().min(1),
    capabilities: z
      .object({
        operations: effectiveAllowlist(CanopyOperationNameSchema),
        events: effectiveAllowlist(CanopyEventNameSchema),
        streams: effectiveAllowlist(CanopyStreamNameSchema),
      })
      .catchall(json),
    limits: extensionMap,
    authentication: z
      .object({ required: z.boolean(), methods: z.array(extensionMap) })
      .catchall(json),
  })
  .catchall(json);
export type CoreRuntimeInitializeResult = z.output<
  typeof CoreRuntimeInitializeResultSchema
>;

export const CoreRuntimeHealthGetParamsSchema = z.strictObject({});
export const CoreRuntimeHealthGetResultSchema = z
  .object({
    runtime: CoreRuntimeDescriptorSchema,
    checks: z.array(
      z
        .object({
          name: z.string(),
          status: z.enum(['pass', 'warn', 'fail']),
          message: z.string().nullable(),
        })
        .catchall(json),
    ),
  })
  .catchall(json);

export const CoreRuntimeManifestGetParamsSchema = z.strictObject({
  includeUnavailable: z.boolean().optional(),
});
/** One installed operation the caller's principal may reach. */
export const CoreRuntimeManifestOperationSchema = z
  .object({
    name: z.string(),
    kind: z.enum(['query', 'instruction', 'stream']),
    version: z.number().int().min(1),
    placement: z.enum(['core-only', 'worker-only', 'target-selectable']),
    requiredGrants: z.array(z.string()),
    available: z.boolean(),
    /**
     * For an operation that takes a `detail` param, the values this host
     * serves (CAN-6941); for `core.chat.transcript.page`, the target kinds
     * it serves beyond a chat's own pages (CAN-7027). Absent declares none,
     * so a client turns on what needs a detail only when it is listed.
     */
    details: z.array(z.string()).optional(),
  })
  .catchall(json);
export type CoreRuntimeManifestOperation = z.output<
  typeof CoreRuntimeManifestOperationSchema
>;
export const CoreRuntimeManifestGetResultSchema = z
  .object({
    runtime: CoreRuntimeDescriptorSchema,
    operations: z.array(CoreRuntimeManifestOperationSchema),
    generatedAt: z.iso.datetime({ offset: true }),
  })
  .catchall(json);
export type CoreRuntimeManifestGetResult = z.output<
  typeof CoreRuntimeManifestGetResultSchema
>;

export const CoreRuntimeEventsParamsSchema = z.strictObject({
  cursor: CanopyStreamCursorSchema.nullable().optional(),
});
export const CoreRuntimeEventsOpenResultSchema = z
  .object({
    subscriptionId: id,
    acceptedCursor: CanopyStreamCursorSchema.nullable(),
  })
  .catchall(json);
export const CoreRuntimeEventsItemSchema = z
  .object({
    event: z.enum(['ready', 'degraded', 'worker_changed', 'stopping']),
    runtime: CoreRuntimeDescriptorSchema,
    details: extensionMap,
  })
  .catchall(json);

export const CoreRuntimeErrorSchema = inherentOperationErrorSchema([
  'core.runtime.invalidState',
  'core.runtime.revisionConflict',
  'core.runtime.notFound',
]);
export const CoreRuntimeHealthErrorSchema = inherentOperationErrorSchema([
  'core.runtime.health.invalidState',
  'core.runtime.health.revisionConflict',
  'core.runtime.health.notFound',
]);
export const CoreRuntimeManifestErrorSchema = inherentOperationErrorSchema([
  'core.runtime.manifest.invalidState',
  'core.runtime.manifest.revisionConflict',
  'core.runtime.manifest.notFound',
]);
export const CoreRuntimeEventsErrorSchema = inherentOperationErrorSchema([
  'core.runtime.invalidState',
  'core.runtime.revisionConflict',
  'core.runtime.notFound',
  'core.runtime.snapshotRequired',
]);
export const CoreRuntimeEventsEndSchema = CanopyStreamEndSchema.extend({
  error: CoreRuntimeEventsErrorSchema.nullable(),
});
