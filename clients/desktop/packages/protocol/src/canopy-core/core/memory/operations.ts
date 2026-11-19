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
  learn: 'core.memory.learn',
} as const;

const ID = z.string().min(1).max(512);

/** Whose memory: the user's own, or the calling chat's project. */
export const MemoryScopeKindSchema = z.enum(['user', 'workspace']);
export type MemoryScopeKind = z.output<typeof MemoryScopeKindSchema>;

/** The calling chat's place; the core resolves the project's memory policy from it. */
const CallerScopeSchema = CanopyWorkspaceScopeSchema;

/** A live memory file or an archived note/import key returned by search. */
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

// Revision 2 adds bounded cloud continuation; v1 desktop calls are unchanged.
export const MEMORY_READ_SCHEMA_REVISION = 2;
const MemoryPageSchema = z.strictObject({
  nextCursor: z.string().max(4096).nullable(),
  incomplete: z.boolean(),
  notice: z.string().max(1024),
});

export const MemorySearchParamsSchema = z.strictObject({
  scope: CallerScopeSchema,
  query: z.string().min(1).max(100_000),
  cursor: z.string().min(1).max(4096).optional(),
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});

export const MemorySearchResultSchema = z.strictObject({
  page: MemoryPageSchema.optional(),
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
  cursor: z.string().min(1).max(4096).optional(),
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});

export const MemoryEntryGetResultSchema = z.strictObject({
  page: MemoryPageSchema.optional(),
  memory: MemoryScopeKindSchema,
  fileKey: FileKeySchema,
  content: z.string(),
});

export type MemoryEntryGetResult = z.output<typeof MemoryEntryGetResultSchema>;

/** Agent history access always names the calling chat, never a search target. */
const ChatHistoryCallerScopeSchema = CanopyWorkspaceScopeSchema.extend({
  workspaceId: ID,
  worktreeId: ID,
  chatId: ID,
});

export const MemoryChatSearchParamsSchema = z.strictObject({
  scope: ChatHistoryCallerScopeSchema,
  query: z.string().trim().min(1).max(1000),
  limit: z.number().int().min(1).max(10).default(5),
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});

// Revision 2 adds cloud coverage and exact message provenance; desktop v1 is unchanged.
export const MEMORY_CHAT_READ_SCHEMA_REVISION = 2;
const MemoryChatSourceSchema = z.strictObject({
  kind: z.literal('cloud'),
  chatId: ID,
  messageId: ID,
  role: z.enum(['USER', 'ASSISTANT']),
});
export const MemoryChatSearchResultSchema = z.strictObject({
  coverage: z
    .strictObject({
      incomplete: z.boolean(),
      scannedChats: z.number().int().min(0).max(20),
      scannedPages: z.number().int().min(0).max(8),
      notice: z.string().max(1024),
    })
    .optional(),
  hits: z
    .array(
      z.strictObject({
        matchId: z.string().uuid(),
        title: z.string().max(512),
        date: z.iso.datetime(),
        snippet: z.string().max(1200),
        source: MemoryChatSourceSchema.optional(),
      }),
    )
    .max(10),
});

export const MemoryChatExcerptParamsSchema = z.strictObject({
  scope: ChatHistoryCallerScopeSchema,
  matchId: z.string().uuid(),
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});

export const MemoryChatExcerptResultSchema = z.strictObject({
  title: z.string().max(512),
  date: z.iso.datetime(),
  excerpt: z.string().max(6000),
  source: MemoryChatSourceSchema.optional(),
});

export type MemoryChatSearchParams = z.output<
  typeof MemoryChatSearchParamsSchema
>;
export type MemoryChatSearchResult = z.output<
  typeof MemoryChatSearchResultSchema
>;
export type MemoryChatExcerptResult = z.output<
  typeof MemoryChatExcerptResultSchema
>;

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

// Desktop serves these over its local memory store (CAN-5993). Web core
// additionally serves search and entry.get with revision-2 pagination (CAN-6464).
// They stay outside the shared registries; the daemon does not serve them.
export const CORE_MEMORY_QUERY_DEFINITIONS = defineCanopyQueryRegistry('core', {
  'core.memory.chats.search': defineCanopyQuery({
    ...BASE,
    idempotency: 'inherent',
    requiredGrants: [MEMORY_GRANTS.read],
    params: MemoryChatSearchParamsSchema,
    result: MemoryChatSearchResultSchema,
    error: inherentOperationErrorSchema(POLICY_CODES),
  }),
  'core.memory.chats.excerpt': defineCanopyQuery({
    ...BASE,
    idempotency: 'inherent',
    requiredGrants: [MEMORY_GRANTS.read],
    params: MemoryChatExcerptParamsSchema,
    result: MemoryChatExcerptResultSchema,
    error: inherentOperationErrorSchema([
      ...POLICY_CODES,
      'core.memory.chats.matchUnavailable',
    ]),
  }),
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
    'core.memory.chats.learn': defineCanopyInstruction({
      ...BASE,
      idempotency: 'inherent',
      requiredGrants: [MEMORY_GRANTS.learn],
      params: z.strictObject({
        memory: MemoryScopeKindSchema,
        workspaceId: ID.optional(),
        _meta: CanopyRequestMetadataSchema.optional(),
      }),
      result: z.strictObject({
        status: z.enum(['learned', 'skipped']),
        notes: z.number().int().nonnegative(),
      }),
      error: inherentOperationErrorSchema(['core.memory.disabled']),
    }),
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
