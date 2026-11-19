import { z } from 'zod';
import {
  McpRemovalCandidatesRequestSchema,
  McpRemovalCandidatesResultSchema,
  ForceMcpRemovalRequestSchema,
  ForceMcpRemovalResultSchema,
  InspectMcpRemovalRequestSchema,
  InspectMcpRemovalResultSchema,
} from '../../../mcp-removal';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
} from '../../definitions';
import { CanopyErrorPayloadSchema } from '../../errors';
import { CanopyQueryRequestMetadataSchema } from '../../common';
import { inherentOperationErrorSchema } from '../shared';
import { CATALOG_GRANTS } from './operations';

/** Deliberately stronger than catalog.write: ordinary deletion cannot escalate. */
export const MCP_REMOVAL_GRANT = 'core.catalog.mcpServer.forceRemove' as const;

/** Electron's single config/OAuth writer is required; the daemon/web do not serve these yet. */
export const CORE_CATALOG_MCP_REMOVAL_QUERY_DEFINITIONS =
  defineCanopyQueryRegistry('core', {
    'core.catalog.mcpServer.removal.candidates': defineCanopyQuery({
      plane: 'core',
      domain: 'catalog',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: [CATALOG_GRANTS.read],
      params: McpRemovalCandidatesRequestSchema.extend({
        _meta: CanopyQueryRequestMetadataSchema.optional(),
      }),
      result: McpRemovalCandidatesResultSchema,
      error: inherentOperationErrorSchema([
        'core.catalog.mcpServer.inspectionUnavailable',
      ]),
    }),
    'core.catalog.mcpServer.removal.inspect': defineCanopyQuery({
      plane: 'core',
      domain: 'catalog',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: [CATALOG_GRANTS.read],
      params: InspectMcpRemovalRequestSchema.extend({
        _meta: CanopyQueryRequestMetadataSchema.optional(),
      }),
      result: InspectMcpRemovalResultSchema,
      error: inherentOperationErrorSchema([
        'core.catalog.mcpServer.inspectionUnavailable',
      ]),
    }),
  });

export const CORE_CATALOG_MCP_REMOVAL_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.catalog.mcpServer.removal.force': defineCanopyInstruction({
      plane: 'core',
      domain: 'catalog',
      version: 1,
      placement: 'core-only',
      // An inspection token is single-use. Resume only with the durable recovery
      // id (or inspect again after a lost reply), never blind transport replay.
      idempotency: 'none',
      requiredGrants: [MCP_REMOVAL_GRANT],
      params: ForceMcpRemovalRequestSchema.safeExtend({
        _meta: CanopyQueryRequestMetadataSchema.optional(),
      }),
      result: ForceMcpRemovalResultSchema,
      error: CanopyErrorPayloadSchema.extend({
        code: z.literal('core.catalog.mcpServer.removalUnavailable').optional(),
        retry: z.strictObject({ kind: z.literal('never') }),
      }),
    }),
  });
