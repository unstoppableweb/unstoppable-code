import { z } from 'zod';

import {
  CanopyQueryRequestMetadataSchema,
  CanopyRequestMetadataSchema,
  CanopyWorkspaceScopeSchema,
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

export const MEMORY_GRANTS = {
  read: 'core.memory.read',
  write: 'core.memory.write',
} as const;

const ID = z.string().min(1).max(512);

/** Whose memory: the user's own, or the calling chat's project. */
export const MemoryScopeKindSchema = z.enum(['user', 'workspace']);
export type MemoryScopeKind = z.output<typeof MemoryScopeKindSchema>;

/** The calling chat's place; the core resolves the project's memory policy from it. */
const CallerScopeSchema = CanopyWorkspaceScopeSchema;

/** A memory file within its scope: `MEMORY.md`, `topics/<name>.md` or `inbox/<name>.md`. */
const FileKeySchema = z.string().min(1).max(512);

export const MemoryEntryAppendParamsSchema = z.strictObject({
  scope: CallerScopeSchema,
  memory: MemoryScopeKindSchema,
  /** The agent note limit: SaveMemory's 2,000 characters. */
  content: z.string().min(1).max(2000),
  source: z.strictObject({
    provider: z.string().min(1).max(128),
    chatId: ID,
    sessionId: ID.optional(),
  }),
  _meta: CanopyRequestMetadataSchema.extend({ idempotencyKey: ID }),
});
export type MemoryEntryAppendParams = z.output<
  typeof MemoryEntryAppendParamsSchema
>;

export const MemoryEntryAppendResultSchema = z.strictObject({
  memory: MemoryScopeKindSchema,
  fileKey: FileKeySchema,
});

export const MemorySearchParamsSchema = z.strictObject({
  scope: CallerScopeSchema,
  query: z.string().min(1).max(100_000),
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});

export const MemorySearchResultSchema = z.strictObject({
  hits: z.array(
    z.strictObject({
      memory: MemoryScopeKindSchema,
      fileKey: FileKeySchema,
      heading: z.string().nullable(),
      snippet: z.string().max(8192),
    }),
  ),
});
export type MemorySearchResult = z.output<typeof MemorySearchResultSchema>;

export const MemoryEntryGetParamsSchema = z.strictObject({
  scope: CallerScopeSchema,
  memory: MemoryScopeKindSchema,
  fileKey: FileKeySchema,
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});

export const MemoryEntryGetResultSchema = z.strictObject({
  memory: MemoryScopeKindSchema,
  fileKey: FileKeySchema,
  content: z.string(),
});

/** Refusals every memory operation shares; their messages are the tools' text. */
const POLICY_CODES = [
  'core.memory.disabled',
  'core.memory.policyUnavailable',
  'core.memory.scopeUnavailable',
] as const;

const BASE = {
  plane: 'core',
  domain: 'memory',
  version: 1,
  placement: 'core-only',
} as const;

// Served by the desktop dispatcher over Electron main's local memory store
// (CAN-5993). Not composed into the shared registries: the daemon and the
// web core do not serve them.
export const CORE_MEMORY_QUERY_DEFINITIONS = defineCanopyQueryRegistry('core', {
  'core.memory.search': defineCanopyQuery({
    ...BASE,
    idempotency: 'inherent',
    requiredGrants: [MEMORY_GRANTS.read],
    params: MemorySearchParamsSchema,
    result: MemorySearchResultSchema,
    error: inherentOperationErrorSchema(POLICY_CODES),
  }),
  'core.memory.entry.get': defineCanopyQuery({
    ...BASE,
    idempotency: 'inherent',
    requiredGrants: [MEMORY_GRANTS.read],
    params: MemoryEntryGetParamsSchema,
    result: MemoryEntryGetResultSchema,
    error: inherentOperationErrorSchema([
      ...POLICY_CODES,
      'core.memory.entry.notFound',
    ]),
  }),
});

export const CORE_MEMORY_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.memory.entry.append': defineCanopyInstruction({
      ...BASE,
      idempotency: 'keyed',
      requiredGrants: [MEMORY_GRANTS.write],
      params: MemoryEntryAppendParamsSchema,
      result: MemoryEntryAppendResultSchema,
      error: keyedOperationErrorSchema([
        ...POLICY_CODES,
        'core.memory.scopeReadOnly',
      ]),
    }),
  });
