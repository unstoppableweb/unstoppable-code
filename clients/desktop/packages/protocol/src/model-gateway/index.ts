import { z } from 'zod';
import {
  MODEL_GATEWAY_MAX_BASE_URL_LENGTH,
  MODEL_GATEWAY_MAX_DISPLAY_NAME_LENGTH,
  MODEL_GATEWAY_MAX_ID_LENGTH,
  MODEL_GATEWAY_MAX_LABEL_LENGTH,
  MODEL_GATEWAY_MAX_MODELS,
  normalizeModelGatewayBaseUrl,
} from '../canopy-server';
import { AI_GATEWAY_THINKING_LEVELS } from '../ai-gateway-models';

export const gatewayDisplayNameSchema = z
  .string()
  .trim()
  .max(MODEL_GATEWAY_MAX_DISPLAY_NAME_LENGTH)
  .transform((value) => value || null)
  .nullable();
export const gatewayBaseUrlSchema = z
  .string()
  .max(MODEL_GATEWAY_MAX_BASE_URL_LENGTH)
  .transform((value, context) => {
    const normalized = normalizeModelGatewayBaseUrl(value);
    if (normalized === null) {
      context.addIssue({
        code: 'custom',
        message: 'Enter a valid HTTPS gateway URL.',
      });
      return z.NEVER;
    }
    return normalized;
  });
export const gatewayModelSchema = z.strictObject({
  id: z.string().min(1).max(MODEL_GATEWAY_MAX_ID_LENGTH),
  gatewayId: z.string().min(1).max(MODEL_GATEWAY_MAX_ID_LENGTH),
  label: z.string().min(1).max(MODEL_GATEWAY_MAX_LABEL_LENGTH),
  harness: z.enum(['claude', 'codex']),
  contextWindow: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  supportedThinkingLevels: z
    .array(z.enum(AI_GATEWAY_THINKING_LEVELS))
    .refine((levels) => new Set(levels).size === levels.length)
    .transform((levels) =>
      AI_GATEWAY_THINKING_LEVELS.filter((level) => levels.includes(level)),
    ),
  toolSchemaProfile: z.enum(['standard', 'flat']),
});
export const gatewayModelsSchema = z
  .array(gatewayModelSchema)
  .max(MODEL_GATEWAY_MAX_MODELS)
  .refine(
    (models) => new Set(models.map((model) => model.id)).size === models.length,
    'Gateway model IDs must be unique.',
  )
  .refine(
    (models) =>
      new Set(models.map((model) => model.label.toLowerCase())).size ===
      models.length,
    'Gateway model names must be unique.',
  );

export const personalAiGatewayConfigSchema = z.strictObject({
  organizationId: z.uuid(),
  displayName: gatewayDisplayNameSchema,
  baseUrl: gatewayBaseUrlSchema.nullable(),
  models: gatewayModelsSchema,
  enabled: z.boolean(),
  onlyThisGateway: z.boolean(),
  promptCachePassthrough: z.boolean(),
  /** Compare this revision when replacing the model list. */
  revision: z.string().max(128),
});
export type PersonalAiGatewayConfig = z.output<
  typeof personalAiGatewayConfigSchema
>;
/**
 * Whether cloud chats use the Personal gateway. Responses carry it beside
 * `gateway`, never inside it: shipped desktops parse `gateway` strictly. An
 * older server omits it, which means on.
 */
export const personalAiGatewayUseInCloudChatsSchema = z
  .boolean()
  .optional()
  .transform((value) => value ?? true);
export const personalAiGatewayUpdateSchema = z.strictObject({
  expectedOrganizationId: z.uuid(),
  expectedRevision: z.string().max(128),
  displayName: gatewayDisplayNameSchema.optional(),
  baseUrl: gatewayBaseUrlSchema.nullable().optional(),
  models: gatewayModelsSchema.optional(),
  enabled: z.boolean().optional(),
  onlyThisGateway: z.boolean().optional(),
  promptCachePassthrough: z.boolean().optional(),
  /** Whether cloud chats use this gateway. Only-mode keeps it on. */
  useInCloudChats: z.boolean().optional(),
});
export type PersonalAiGatewayUpdate = z.output<
  typeof personalAiGatewayUpdateSchema
>;
export const aiGatewayConnectSchema = z.strictObject({
  baseUrl: z.string().max(MODEL_GATEWAY_MAX_BASE_URL_LENGTH),
  apiKey: z.string().trim().min(1).max(16384).optional(),
});
export const gatewayScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('personal'),
    expectedOrganizationId: z.uuid(),
  }),
  z.strictObject({ kind: z.literal('organization'), organizationId: z.uuid() }),
]);
export type AiGatewayScope = z.output<typeof gatewayScopeSchema>;
export {
  parseGatewayModelList,
  suggestGatewayModel,
  gatewayHostname,
} from './discovery';

/** Backend route contracts are available before the frontend mounts these pages. */
export const aiGatewaySettingsRouteSchema = z.union([
  z.strictObject({
    scope: z.literal('account'),
    page: z.literal('ai-gateway'),
  }),
  z.strictObject({
    scope: z.literal('organization'),
    organizationId: z.uuid(),
    page: z.literal('settings'),
    subtab: z.literal('ai-gateway'),
  }),
]);
export const aiGatewaySettingsPageDataInputSchema = z.strictObject({
  route: aiGatewaySettingsRouteSchema,
});

export const gatewayAuthorizationSchema = z.strictObject({
  scope: gatewayScopeSchema,
  intent: z.enum(['read', 'connect', 'update']),
});
