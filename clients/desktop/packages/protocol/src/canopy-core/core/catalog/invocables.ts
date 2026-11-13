import { z } from 'zod';

import {
  defineCanopyQuery,
  defineCanopyQueryRegistry,
} from '../../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../../errors';
import { CoreWorkspacePluginSelectionsSchema } from '../workspace/guarded-commands';
import { CoreCloudRecordSchema } from '../workspace/reads';
import { CATALOG_GRANTS } from './operations';

const id = z.string().min(1).max(512);

/** The model a chat would run; a hint the caller's model library locks is dropped. */
const modelDefinitionId = id.optional();

export const CatalogInvocablesListParamsSchema = z.union([
  z.strictObject({ chatId: id, modelDefinitionId }),
  // Before a chat exists: the selections its composer holds, else the
  // workspace's defaults.
  z.strictObject({
    workspaceId: id,
    modelDefinitionId,
    pluginSelections: CoreWorkspacePluginSelectionsSchema.optional(),
  }),
]);

/** The catalog member an available row enables before it is inserted. */
const CatalogInvocableEnableRefSchema = z.union([
  z.strictObject({ sourceId: id, skillName: id }),
  z.strictObject({ marketplaceId: id, pluginName: id }),
]);

/**
 * One slash-invocable row (CAN-6111), as the cloud invocables routes send it:
 * without `enableRef` it is in the chat's bundle; with one it is a catalog
 * member to enable first.
 */
export const CatalogInvocableRowSchema = z.object({
  name: z.string().min(1),
  pluginName: z.string().optional(),
  memberName: z.string().optional(),
  description: z.string(),
  /** Harness-projected insertion text, with its trailing space. */
  insertText: z.string(),
  /** Present when the row is shown but cannot be invoked. */
  unavailableReason: z.string().optional(),
  enableRef: CatalogInvocableEnableRefSchema.optional(),
});

export const CatalogInvocablesListResultSchema = z.object({
  rows: z.array(CatalogInvocableRowSchema),
  /**
   * A workspace's default selections as it stores them, null when it has
   * none; absent for a chat.
   */
  defaultPluginSelections: CoreCloudRecordSchema.nullable().optional(),
});

export const CatalogInvocablesListErrorSchema = CanopyErrorPayloadSchema.extend(
  {
    /** These refusals carry no operation code. */
    code: z.never().optional(),
    retry: CanopyQueryRetryDirectiveSchema,
  },
);

/**
 * The cloud slash-invocable inventory (CAN-6111). Served by the web core
 * only, so kept out of the catalog registry the desktop dispatcher serves.
 */
export const CORE_CATALOG_INVOCABLE_QUERY_DEFINITIONS =
  defineCanopyQueryRegistry('core', {
    'core.catalog.invocables.list': defineCanopyQuery({
      plane: 'core',
      domain: 'catalog',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: [CATALOG_GRANTS.read],
      params: CatalogInvocablesListParamsSchema,
      result: CatalogInvocablesListResultSchema,
      error: CatalogInvocablesListErrorSchema,
    }),
  });
