import { z } from 'zod';

import {
  CanopyQueryRequestMetadataSchema,
  CanopyRequestMetadataSchema,
} from '../../common';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
} from '../../definitions';
import {
  inherentOperationErrorSchema,
  keyedOperationErrorSchema,
} from '../shared';
import { MEMORY_GRANTS } from './operations';

const ID = z.string().min(1).max(512);
const TIMESTAMP = z.string().min(1).max(64);
/** An opaque tag: an equal tag means the same state. Compare for equality only. */
const TAG = z.string().min(1).max(128);

/** Whose memory: the user's own, or one named project's. */
export const MemoryTargetSchema = z.discriminatedUnion('scope', [
  z.strictObject({ scope: z.literal('user') }),
  z.strictObject({ scope: z.literal('workspace'), workspaceId: ID }),
]);
export type MemoryTarget = z.output<typeof MemoryTargetSchema>;

export const MemoryConsolidationStatusSchema = z.strictObject({
  pendingNotes: z.number().int().nonnegative(),
  running: z.boolean(),
  lastRunAt: TIMESTAMP.nullable(),
  lastResult: z.enum(['success', 'skipped', 'failed', 'cancelled']).nullable(),
  lastReason: z.string().nullable(),
  lastConsolidatedAt: TIMESTAMP.nullable(),
});

export const MemoryConsolidationRunParamsSchema = z.strictObject({
  target: MemoryTargetSchema,
  _meta: CanopyRequestMetadataSchema.extend({ idempotencyKey: ID }),
});

export const MemorySnapshotListParamsSchema = z.strictObject({
  target: MemoryTargetSchema,
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});

export const MemorySnapshotListResultSchema = z.strictObject({
  /** The scope's current memory, which a rebuild or restore must name. */
  revision: TAG,
  snapshots: z.array(
    z.strictObject({
      snapshotId: ID,
      createdAt: TIMESTAMP,
      reason: z.enum(['consolidation', 'rebuild', 'restore', 'sync']),
      topicCount: z.number().int().nonnegative(),
    }),
  ),
});
export type MemorySnapshotListResult = z.output<
  typeof MemorySnapshotListResultSchema
>;

export const MemoryConsolidationRebuildParamsSchema = z.strictObject({
  target: MemoryTargetSchema,
  expectedRevision: TAG,
  _meta: CanopyRequestMetadataSchema.extend({ idempotencyKey: ID }),
});

export const MemoryConsolidationRebuildResultSchema = z.strictObject({
  status: z.enum(['completed', 'stopped', 'failed', 'skipped']),
  reason: z.string().nullable(),
  snapshotId: ID.nullable(),
  restoredInboxNotes: z.number().int().nonnegative(),
  restoredImports: z.number().int().nonnegative(),
  runs: z.number().int().nonnegative(),
  consolidation: MemoryConsolidationStatusSchema,
});

export const MemorySnapshotRestoreParamsSchema = z.strictObject({
  target: MemoryTargetSchema,
  snapshotId: ID,
  expectedRevision: TAG,
  _meta: CanopyRequestMetadataSchema.extend({ idempotencyKey: ID }),
});

export const MemorySnapshotRestoreResultSchema = z.strictObject({
  status: z.enum(['restored', 'skipped']),
  reason: z.string().nullable(),
  previousSnapshotId: ID.nullable(),
});

const ImportScopeSchema = z.strictObject({
  /** The project whose repositories are read; without it, every project's user memory. */
  workspaceId: ID.optional(),
});

export const MemoryImportSourcesListParamsSchema = ImportScopeSchema.extend({
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});

export const MemoryImportSourcesListResultSchema = z.strictObject({
  /** The exact source files, which an import must name. */
  digest: TAG,
  sources: z.array(
    z.strictObject({
      tool: z.enum(['claude-code', 'codex']),
      /** The file as its tool's memory folder names it; never a host path. */
      label: z.string().min(1).max(1024),
    }),
  ),
});
export type MemoryImportSourcesListResult = z.output<
  typeof MemoryImportSourcesListResultSchema
>;

export const MemoryImportExternalParamsSchema = ImportScopeSchema.extend({
  expectedSourcesDigest: TAG,
  _meta: CanopyRequestMetadataSchema.extend({ idempotencyKey: ID }),
});

export const MemoryImportExternalResultSchema = z.strictObject({
  disabled: z.boolean(),
  staged: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  deferred: z.number().int().nonnegative(),
  errors: z.array(z.string()),
});

const BASE = {
  plane: 'core',
  domain: 'memory',
  version: 1,
  placement: 'core-only',
} as const;

const TARGET_CODES = ['core.memory.workspace.notFound'] as const;

// Served by the desktop dispatcher over Electron main's local memory store
// (CAN-6005), with the core.memory reads and saves; the daemon and the web
// core do not serve them.
export const CORE_MEMORY_MAINTENANCE_QUERY_DEFINITIONS =
  defineCanopyQueryRegistry('core', {
    'core.memory.snapshot.list': defineCanopyQuery({
      ...BASE,
      idempotency: 'inherent',
      requiredGrants: [MEMORY_GRANTS.read],
      params: MemorySnapshotListParamsSchema,
      result: MemorySnapshotListResultSchema,
      error: inherentOperationErrorSchema(TARGET_CODES),
    }),
    'core.memory.import.sources.list': defineCanopyQuery({
      ...BASE,
      idempotency: 'inherent',
      requiredGrants: [MEMORY_GRANTS.read],
      params: MemoryImportSourcesListParamsSchema,
      result: MemoryImportSourcesListResultSchema,
      error: inherentOperationErrorSchema(TARGET_CODES),
    }),
  });

export const CORE_MEMORY_MAINTENANCE_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.memory.consolidation.run': defineCanopyInstruction({
      ...BASE,
      idempotency: 'keyed',
      requiredGrants: [MEMORY_GRANTS.write],
      params: MemoryConsolidationRunParamsSchema,
      result: MemoryConsolidationStatusSchema,
      error: keyedOperationErrorSchema(TARGET_CODES),
    }),
    'core.memory.consolidation.rebuild': defineCanopyInstruction({
      ...BASE,
      idempotency: 'keyed',
      requiredGrants: [MEMORY_GRANTS.write],
      params: MemoryConsolidationRebuildParamsSchema,
      result: MemoryConsolidationRebuildResultSchema,
      error: keyedOperationErrorSchema([
        ...TARGET_CODES,
        'core.memory.revisionConflict',
      ]),
    }),
    'core.memory.snapshot.restore': defineCanopyInstruction({
      ...BASE,
      idempotency: 'keyed',
      requiredGrants: [MEMORY_GRANTS.write],
      params: MemorySnapshotRestoreParamsSchema,
      result: MemorySnapshotRestoreResultSchema,
      error: keyedOperationErrorSchema([
        ...TARGET_CODES,
        'core.memory.revisionConflict',
      ]),
    }),
    'core.memory.import.external': defineCanopyInstruction({
      ...BASE,
      idempotency: 'keyed',
      requiredGrants: [MEMORY_GRANTS.write],
      params: MemoryImportExternalParamsSchema,
      result: MemoryImportExternalResultSchema,
      error: keyedOperationErrorSchema([
        ...TARGET_CODES,
        'core.memory.import.sourcesChanged',
      ]),
    }),
  });
