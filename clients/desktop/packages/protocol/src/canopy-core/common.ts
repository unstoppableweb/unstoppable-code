import { z } from 'zod';

import { CanopyGrantNameSchema } from './names';

/** Matches the cloud chat limit, measured in JavaScript UTF-16 code units. */
export const CHAT_CUSTOM_TITLE_MAX_LENGTH = 256;

const BOUNDED_IDENTIFIER_SCHEMA = z.string().min(1).max(512);

export const CanopyWorkspaceScopeSchema = z.strictObject({
  organizationId: BOUNDED_IDENTIFIER_SCHEMA.optional(),
  workspaceId: BOUNDED_IDENTIFIER_SCHEMA.optional(),
  worktreeId: BOUNDED_IDENTIFIER_SCHEMA.optional(),
  chatId: BOUNDED_IDENTIFIER_SCHEMA.optional(),
  operationId: BOUNDED_IDENTIFIER_SCHEMA.optional(),
  executionId: BOUNDED_IDENTIFIER_SCHEMA.optional(),
  repoId: BOUNDED_IDENTIFIER_SCHEMA.optional(),
  authorityId: BOUNDED_IDENTIFIER_SCHEMA.optional(),
  targetId: BOUNDED_IDENTIFIER_SCHEMA.optional(),
});

export type CanopyWorkspaceScope = z.output<typeof CanopyWorkspaceScopeSchema>;

/** The builtin bundled worker's execution-target id (`execution-targets.yaml`). */
export const CANOPY_IN_PROCESS_WORKER_TARGET_ID = 'in_process_worker';

export const CanopyRequestMetadataSchema = z.strictObject({
  idempotencyKey: z.string().min(1).max(512).optional(),
  deadlineAt: z.iso.datetime({ offset: true }).optional(),
  traceparent: z.string().min(1).max(512).optional(),
  tracestate: z.string().min(1).max(2048).optional(),
  /**
   * An instruction's report-only dispatch tag (CAN-4733): the worker keeps
   * the dispatch's settlement under it for `worker.operation.receipt.get`
   * and never replays it. Host-reserved, so catalog pages do not list it
   * (`CANOPY_HOST_RESERVED_METADATA`); `_meta` is never fingerprinted.
   */
  dispatchId: z.string().min(1).max(512).optional(),
});

/** `_meta` members every instruction admits that catalog pages leave out (CAN-4733). */
export const CANOPY_HOST_RESERVED_METADATA = ['dispatchId'] as const;

// Read queries do not negotiate keyed replay or carry a dispatch tag; the
// operation catalog omits both.
export const CanopyQueryRequestMetadataSchema =
  CanopyRequestMetadataSchema.omit({
    idempotencyKey: true,
    dispatchId: true,
  });

/** An unkeyed instruction's metadata: no idempotency key, but a dispatch tag. */
export const CanopyUnkeyedInstructionRequestMetadataSchema =
  CanopyRequestMetadataSchema.omit({
    idempotencyKey: true,
  });

export type CanopyQueryRequestMetadata = z.output<
  typeof CanopyQueryRequestMetadataSchema
>;

export type CanopyRequestMetadata = z.output<
  typeof CanopyRequestMetadataSchema
>;

export const CANOPY_INTERFACE_KINDS = [
  'desktop',
  'portal',
  'cli',
  'http',
  'mcp',
  'daemon',
  'worker',
  'test',
] as const;

export const CanopyCallerDescriptorSchema = z.strictObject({
  principalId: BOUNDED_IDENTIFIER_SCHEMA,
  clientInstanceId: BOUNDED_IDENTIFIER_SCHEMA,
  authorityId: BOUNDED_IDENTIFIER_SCHEMA,
  interfaceKind: z.enum(CANOPY_INTERFACE_KINDS),
  grants: z.array(CanopyGrantNameSchema).max(256),
});

export type CanopyCallerDescriptor = z.output<
  typeof CanopyCallerDescriptorSchema
>;

export * from './shared-multi-repo-validation';
