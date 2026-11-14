import { z } from 'zod';

import {
  CanopyQueryRequestMetadataSchema,
  CanopyRequestMetadataSchema,
} from '../../common';
import { canopyJsonValueSchemaWithin } from '../../errors';
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

/**
 * Search reads the local catalog; load asks the chat's reload lifecycle
 * (CAN-4127) to enable items, so it carries the chat write grant.
 */
export const CORE_AGENT_DEFERRED_TOOLS_GRANTS = {
  search: 'core.catalog.read',
  load: 'core.chat.write',
} as const;

const ID = z.string().min(1).max(512);
/** At most twenty queries or fifty refs, with room to spare. */
export const DEFERRED_TOOLS_REQUEST_JSON_MAX_BYTES = 65_536;
/** A chat's plugin selections: refs, collections and MCP auth preferences. */
export const DEFERRED_TOOLS_SELECTIONS_JSON_MAX_BYTES = 1_048_576;

/** A deferred tool input as a JSON object. */
export const DeferredToolsJsonObjectSchema = z
  .record(
    z.string(),
    canopyJsonValueSchemaWithin(DEFERRED_TOOLS_REQUEST_JSON_MAX_BYTES),
  )
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).length <=
      DEFERRED_TOOLS_REQUEST_JSON_MAX_BYTES,
    'A deferred tools request is too large.',
  );
/** A chat's plugin selections as a JSON object. */
export const DeferredToolsSelectionsJsonSchema = z
  .record(
    z.string(),
    canopyJsonValueSchemaWithin(DEFERRED_TOOLS_SELECTIONS_JSON_MAX_BYTES),
  )
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).length <=
      DEFERRED_TOOLS_SELECTIONS_JSON_MAX_BYTES,
    'The chat selections are too large.',
  );

/**
 * The chat whose tools a call searches or loads: its project, worktree and
 * chat (a managed delegate's own `delegation-<id>` chat). The host supplies
 * it from the calling session, never from tool input.
 */
export const DeferredToolsRecipientSchema = z.strictObject({
  workspaceId: ID,
  worktreeId: ID,
  chatId: ID,
});
export type DeferredToolsRecipient = z.output<
  typeof DeferredToolsRecipientSchema
>;

/**
 * The calling session's provider and selections, which decide what the
 * catalog offers it; host-local, from the session, never from tool input.
 */
export const DeferredToolsSessionSchema = z.strictObject({
  providerType: z
    .enum([
      'claude',
      'codex',
      'ollama',
      'cursor',
      'opencode',
      'copilot',
      'antigravity',
    ])
    .optional(),
  interfaceMode: z.enum(['canopy', 'claude-code', 'auto']).optional(),
  assistantMode: z
    .enum(['default', 'app-advisor', 'pipeline-editor'])
    .optional(),
  pluginSelections: DeferredToolsSelectionsJsonSchema.optional(),
});
export type DeferredToolsSession = z.output<typeof DeferredToolsSessionSchema>;

export const DeferredToolsSearchParamsSchema = z.strictObject({
  recipient: DeferredToolsRecipientSchema,
  session: DeferredToolsSessionSchema,
  /** SearchDeferredTools input, re-validated with the tool's schema. */
  input: DeferredToolsJsonObjectSchema,
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});

export const DeferredToolsLoadParamsSchema = z.strictObject({
  recipient: DeferredToolsRecipientSchema,
  session: DeferredToolsSessionSchema,
  /** LoadDeferredTools input, re-validated with the tool's schema. */
  input: DeferredToolsJsonObjectSchema,
  /** The provider's id for this tool call; the reload waits for its result. */
  toolCallId: ID.optional(),
  _meta: CanopyRequestMetadataSchema.extend({ idempotencyKey: ID }),
});

/** What a deferred tools call reports back to the agent that made it. */
export const DeferredToolsReportSchema = z.strictObject({
  accepted: z.boolean(),
  /** The agent-facing report: the search results or the load result. */
  report: z.string().max(1_000_000),
});
export type DeferredToolsReport = z.output<typeof DeferredToolsReportSchema>;

const BASE = {
  plane: 'core',
  domain: 'agent',
  version: 1,
  placement: 'core-only',
} as const;

// Served by the desktop dispatcher over Electron main's catalog stores and
// the CAN-4127 reload lifecycle (CAN-5995). Not composed into the shared
// registries: the daemon and the web core do not serve them.
export const CORE_AGENT_DEFERRED_TOOLS_QUERY_DEFINITIONS =
  defineCanopyQueryRegistry('core', {
    'core.agent.deferredTools.search': defineCanopyQuery({
      ...BASE,
      idempotency: 'inherent',
      requiredGrants: [CORE_AGENT_DEFERRED_TOOLS_GRANTS.search],
      params: DeferredToolsSearchParamsSchema,
      result: DeferredToolsReportSchema,
      error: inherentOperationErrorSchema([
        'core.agent.deferredTools.unavailable',
      ]),
    }),
  });

export const CORE_AGENT_DEFERRED_TOOLS_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.agent.deferredTools.load': defineCanopyInstruction({
      ...BASE,
      idempotency: 'keyed',
      requiredGrants: [CORE_AGENT_DEFERRED_TOOLS_GRANTS.load],
      params: DeferredToolsLoadParamsSchema,
      result: DeferredToolsReportSchema,
      error: keyedOperationErrorSchema([
        'core.agent.deferredTools.unavailable',
      ]),
    }),
  });
